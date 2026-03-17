---
title: "Kubernetes Jaeger v2 Operator: Distributed Tracing Deployment and Sampling Configuration"
date: 2031-08-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Jaeger", "Distributed Tracing", "OpenTelemetry", "Observability", "Sampling"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy and configure Jaeger v2 using the Jaeger Operator on Kubernetes with production-grade storage backends, adaptive sampling, and OpenTelemetry collector integration."
more_link: "yes"
url: "/kubernetes-jaeger-v2-operator-distributed-tracing-sampling-configuration/"
---

Distributed tracing answers the question that logs and metrics cannot: why did this specific request take 2.3 seconds? Jaeger v2, built on the OpenTelemetry Collector pipeline, represents a significant architectural shift from v1 — this post covers the operator-based deployment, production storage configuration, and the sampling strategies that make the difference between a useful trace system and an expensive noise generator.

<!--more-->

# Kubernetes Jaeger v2 Operator: Distributed Tracing Deployment and Sampling Configuration

## What Changed in Jaeger v2

Jaeger v2 (released 2024) replaces the custom agent/collector/query architecture with an OpenTelemetry Collector pipeline:

| Component | Jaeger v1 | Jaeger v2 |
|-----------|-----------|-----------|
| Agent | jaeger-agent (UDP) | OTel Collector (sidecar/DaemonSet) |
| Collector | jaeger-collector | OTel Collector + jaeger exporter |
| Query UI | jaeger-query | jaeger-query (unchanged, reads storage) |
| Protocol | Thrift, Protobuf | OTLP gRPC, OTLP HTTP, Thrift (compat) |
| Config format | CLI flags | YAML (OTel Collector config) |

The primary benefit: you instrument once with OpenTelemetry SDKs and can route traces to Jaeger, Tempo, Zipkin, or any OTLP-compatible backend by changing the collector configuration — no application changes.

## Prerequisites

```bash
# Kubernetes 1.25+
kubectl version --short
# Client Version: v1.30.0
# Server Version: v1.30.2

# cert-manager (required by the operator)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.5/cert-manager.yaml
kubectl wait --for=condition=Available deployment --all -n cert-manager --timeout=120s
```

## Installing the Jaeger Operator

```bash
# Install CRDs and the operator
kubectl create namespace observability

helm repo add jaegertracing https://jaegertracing.github.io/helm-charts
helm repo update

helm install jaeger-operator jaegertracing/jaeger-operator \
  --namespace observability \
  --set rbac.clusterRole=true \       # Required for cross-namespace Jaegers
  --set image.tag=2.1.0 \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=128Mi

# Verify operator is running
kubectl get pods -n observability
# NAME                               READY   STATUS    RESTARTS   AGE
# jaeger-operator-7d9f6b8c4d-xp2nq   1/1     Running   0          45s
```

## Jaeger Custom Resource

The `Jaeger` CRD defines the entire tracing stack. The operator translates it into Deployments, Services, ConfigMaps, and ServiceAccounts.

### Minimal Development Instance (AllInOne)

```yaml
# jaeger-dev.yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-dev
  namespace: observability
spec:
  strategy: allInOne    # Single pod: collector + query + in-memory storage
  allInOne:
    image: jaegertracing/all-in-one:2.1.0
    options:
      log-level: debug
  ingress:
    enabled: true
    ingressClassName: nginx
    hosts:
      - jaeger-dev.internal.example.com
```

```bash
kubectl apply -f jaeger-dev.yaml
kubectl get jaeger -n observability
# NAME         AGE   STATUS
# jaeger-dev   30s   Running
```

### Production Instance: Elasticsearch Backend

```yaml
# jaeger-production.yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-production
  namespace: observability
spec:
  strategy: production

  # -------------------------------------------------------
  # Collector (OTel Collector pipeline receiving spans)
  # -------------------------------------------------------
  collector:
    replicas: 3
    image: jaegertracing/jaeger-collector:2.1.0
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi
    # OTel Collector configuration (Jaeger v2 uses this format)
    config:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: "0.0.0.0:4317"
            http:
              endpoint: "0.0.0.0:4318"
        jaeger:           # Backward compat with v1 clients
          protocols:
            grpc:
              endpoint: "0.0.0.0:14250"
            thrift_http:
              endpoint: "0.0.0.0:14268"

      processors:
        batch:
          timeout: 1s
          send_batch_size: 1024
          send_batch_max_size: 2048
        memory_limiter:
          check_interval: 1s
          limit_mib: 1500
          spike_limit_mib: 512
        tail_sampling:
          decision_wait: 10s
          num_traces: 50000
          expected_new_traces_per_sec: 1000
          policies:
            - name: error-policy
              type: status_code
              status_code: {status_codes: [ERROR]}
            - name: slow-traces-policy
              type: latency
              latency: {threshold_ms: 500}
            - name: probabilistic-policy
              type: probabilistic
              probabilistic: {sampling_percentage: 1}

      exporters:
        jaeger_storage_exporter:
          trace_storage: es-storage

      service:
        pipelines:
          traces:
            receivers: [otlp, jaeger]
            processors: [memory_limiter, tail_sampling, batch]
            exporters: [jaeger_storage_exporter]

  # -------------------------------------------------------
  # Query UI
  # -------------------------------------------------------
  query:
    replicas: 2
    image: jaegertracing/jaeger-query:2.1.0
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
    options:
      query.base-path: /jaeger
      query.ui.config: /etc/jaeger/ui-config.json

  # -------------------------------------------------------
  # Storage
  # -------------------------------------------------------
  storage:
    type: elasticsearch
    elasticsearch:
      serverUrls: https://elasticsearch.elastic.svc.cluster.local:9200
      secretName: jaeger-es-secret     # Contains ES_PASSWORD
      tls:
        enabled: true
        caPath: /es-tls/ca.crt
      indexPrefix: jaeger
      indexDateLayoutSpanLogs: "2006-01-02"
      indexDateLayoutServices: "2006-01-02"
      indexDateLayoutDependencies: "2006-01-02"
      bulkSize: 5000000        # 5 MB
      bulkWorkers: 3
      bulkActions: 1000
      bulkFlushInterval: 200ms
      numShards: 5
      numReplicas: 1
      maxDocCount: 10000
      useReadWriteAliases: true   # Zero-downtime index rollover
      rolloverFrequency: day

  # -------------------------------------------------------
  # Ingress for UI
  # -------------------------------------------------------
  ingress:
    enabled: true
    ingressClassName: nginx
    annotations:
      nginx.ingress.kubernetes.io/auth-type: basic
      nginx.ingress.kubernetes.io/auth-secret: jaeger-basic-auth
    hosts:
      - jaeger.internal.example.com
    tls:
      - secretName: jaeger-tls
        hosts:
          - jaeger.internal.example.com
```

### Elasticsearch Secret

```bash
kubectl create secret generic jaeger-es-secret \
  --from-literal=ES_PASSWORD='<elasticsearch-password>' \
  -n observability
```

## Sampling Strategies

Sampling is where most Jaeger deployments go wrong. Collecting 100% of traces in high-throughput production systems is prohibitively expensive and makes finding interesting traces harder, not easier.

### Head-Based Sampling (at instrumentation time)

Head-based sampling decides whether to sample before the trace is complete. It is cheap but cannot make decisions based on trace outcome (errors, latency).

#### Probabilistic Sampling

```yaml
# OpenTelemetry SDK configuration (Go)
# In your application code:
```

```go
// main.go
package main

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
)

func initTracer(ctx context.Context) (*trace.TracerProvider, error) {
	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint("jaeger-collector.observability.svc.cluster.local:4317"),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, err
	}

	tp := trace.NewTracerProvider(
		trace.WithBatcher(exporter),
		// Sample 1% of traces
		trace.WithSampler(trace.TraceIDRatioBased(0.01)),
		trace.WithResource(resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName("my-service"),
			semconv.ServiceVersion("1.0.0"),
		)),
	)

	otel.SetTracerProvider(tp)
	return tp, nil
}
```

#### Parent-Based Sampling (propagation-aware)

```go
// Respect upstream sampling decisions
tp := trace.NewTracerProvider(
	trace.WithBatcher(exporter),
	trace.WithSampler(
		trace.ParentBased(
			trace.TraceIDRatioBased(0.01), // Root: sample 1%
			// If parent is sampled: sample (default behavior)
			// If parent is not sampled: don't sample
		),
	),
)
```

### Tail-Based Sampling (at collector)

Tail-based sampling collects all spans but only stores the trace if it meets criteria — it can see the full outcome (error, latency, specific attributes).

The Jaeger v2 collector configuration shown above includes a tail sampling processor. Here is a more comprehensive policy set:

```yaml
# OTel Collector tail_sampling processor — production policies
processors:
  tail_sampling:
    decision_wait: 30s          # Wait for all spans before deciding
    num_traces: 100000          # In-memory trace buffer size
    expected_new_traces_per_sec: 5000

    policies:
      # --- Always sample these ---

      # All errors
      - name: errors-always
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Slow requests (> 1 second end-to-end)
      - name: slow-requests
        type: latency
        latency:
          threshold_ms: 1000

      # Specific operations we always want to see
      - name: critical-operations
        type: string_attribute
        string_attribute:
          key: rpc.method
          values:
            - PaymentProcess
            - UserAuthenticate
            - OrderSubmit

      # Any trace touching a specific service
      - name: payment-service
        type: string_attribute
        string_attribute:
          key: service.name
          values: [payment-service]

      # --- Probabilistic baseline for everything else ---
      - name: baseline-1pct
        type: probabilistic
        probabilistic:
          sampling_percentage: 1

      # --- Rate limiting: cap storage even for "always sample" policies ---
      - name: rate-limit
        type: rate_limiting
        rate_limiting:
          spans_per_second: 10000

    # Composite: AND of policies (all must pass)
    # Use "or" for OR logic (any policy passes)
    composite:
      max_total_spans_per_second: 10000
      policy_order:
        - errors-always
        - slow-requests
        - critical-operations
        - payment-service
        - baseline-1pct
      rate_allocation:
        - policy: errors-always
          percent: 30
        - policy: slow-requests
          percent: 30
        - policy: critical-operations
          percent: 20
        - policy: payment-service
          percent: 10
        - policy: baseline-1pct
          percent: 10
```

### Adaptive Sampling (Jaeger Remote Sampling)

Adaptive sampling dynamically adjusts the sampling rate per operation to maintain a target throughput:

```yaml
# Remote sampling service deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger-sampling-server
  namespace: observability
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger-sampling-server
  template:
    metadata:
      labels:
        app: jaeger-sampling-server
    spec:
      containers:
        - name: sampling-server
          image: jaegertracing/jaeger-sampling-server:2.1.0
          args:
            - --sampling.strategies-file=/etc/jaeger/sampling.json
          volumeMounts:
            - name: sampling-config
              mountPath: /etc/jaeger
      volumes:
        - name: sampling-config
          configMap:
            name: jaeger-sampling-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: jaeger-sampling-config
  namespace: observability
data:
  sampling.json: |
    {
      "service_strategies": [
        {
          "service": "api-gateway",
          "type": "probabilistic",
          "param": 0.05,
          "operation_strategies": [
            {
              "operation": "GET /health",
              "type": "probabilistic",
              "param": 0.001
            },
            {
              "operation": "POST /api/payment",
              "type": "probabilistic",
              "param": 1.0
            }
          ]
        },
        {
          "service": "order-service",
          "type": "ratelimiting",
          "param": 100
        }
      ],
      "default_strategy": {
        "type": "probabilistic",
        "param": 0.01
      }
    }
```

Configure SDKs to fetch sampling strategy from the remote server:

```go
// Go SDK: remote sampling
import "go.opentelemetry.io/contrib/samplers/jaegerremote"

remoteSampler := jaegerremote.New(
	"my-service",
	jaegerremote.WithSamplingServerURL("http://jaeger-sampling-server.observability.svc.cluster.local:5778/sampling"),
	jaegerremote.WithInitialSampler(trace.TraceIDRatioBased(0.01)),
)

tp := trace.NewTracerProvider(
	trace.WithBatcher(exporter),
	trace.WithSampler(remoteSampler),
)
```

## Index Lifecycle Management for Elasticsearch

Jaeger generates significant index volume. Configure ILM to automatically roll over and delete old data:

```json
PUT _ilm/policy/jaeger-traces-policy
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_size": "50gb",
            "max_age": "1d"
          },
          "set_priority": {
            "priority": 100
          }
        }
      },
      "warm": {
        "min_age": "2d",
        "actions": {
          "forcemerge": {
            "max_num_segments": 1
          },
          "shrink": {
            "number_of_shards": 1
          },
          "set_priority": {
            "priority": 50
          }
        }
      },
      "cold": {
        "min_age": "7d",
        "actions": {
          "set_priority": {
            "priority": 0
          }
        }
      },
      "delete": {
        "min_age": "30d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

Apply via Jaeger's rollover job:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: jaeger-es-rollover
  namespace: observability
spec:
  schedule: "0 0 * * *"    # Daily at midnight
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: rollover
              image: jaegertracing/jaeger-es-rollover:2.1.0
              args:
                - rollover
                - https://elasticsearch.elastic.svc.cluster.local:9200
              env:
                - name: ES_PASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: jaeger-es-secret
                      key: ES_PASSWORD
                - name: ES_TLS_CA
                  value: /es-tls/ca.crt
              volumeMounts:
                - name: es-tls
                  mountPath: /es-tls
          volumes:
            - name: es-tls
              secret:
                secretName: elasticsearch-tls-ca
```

## OpenTelemetry Collector DaemonSet

Rather than instrumenting each pod with a sidecar, deploy a DaemonSet collector per node that receives OTLP from all pods on that node:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: node-collector
  namespace: observability
spec:
  mode: daemonset
  image: otel/opentelemetry-collector-contrib:0.104.0
  resources:
    requests:
      cpu: 200m
      memory: 400Mi
    limits:
      cpu: 1000m
      memory: 2Gi
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: "0.0.0.0:4317"
          http:
            endpoint: "0.0.0.0:4318"

    processors:
      batch:
        timeout: 1s
        send_batch_size: 512
      memory_limiter:
        check_interval: 1s
        limit_mib: 1800
      # Add Kubernetes metadata to all spans
      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        filter:
          node_from_env_var: KUBE_NODE_NAME
        extract:
          metadata:
            - k8s.namespace.name
            - k8s.deployment.name
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.node.name
          labels:
            - tag_name: app
              key: app
              from: pod
            - tag_name: version
              key: version
              from: pod

    exporters:
      otlp:
        endpoint: "jaeger-production-collector.observability.svc.cluster.local:4317"
        tls:
          insecure: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, batch]
          exporters: [otlp]
  env:
    - name: KUBE_NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
```

## Querying Traces Programmatically

Jaeger provides a gRPC API for programmatic trace retrieval — useful for alerting on trace-level SLOs:

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	pb "github.com/jaegertracing/jaeger/proto-gen/api_v2"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	conn, err := grpc.NewClient(
		"jaeger.observability.svc.cluster.local:16685",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	client := pb.NewQueryServiceClient(conn)
	ctx := context.Background()

	// Find all traces for payment-service with errors in the last hour
	resp, err := client.FindTraces(ctx, &pb.FindTracesRequest{
		Query: &pb.TraceQueryParameters{
			ServiceName:   "payment-service",
			StartTimeMin:  time.Now().Add(-1 * time.Hour),
			StartTimeMax:  time.Now(),
			NumTraces:     50,
			Tags: map[string]string{
				"error": "true",
			},
		},
	})
	if err != nil {
		log.Fatal(err)
	}

	for _, trace := range resp.Traces {
		fmt.Printf("TraceID: %s, Spans: %d\n",
			trace.TraceID.String(),
			len(trace.Spans),
		)
	}
}
```

## Prometheus Metrics for Jaeger

```yaml
# ServiceMonitor for Prometheus Operator
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: jaeger-collector
  namespace: observability
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: jaeger
      app.kubernetes.io/component: collector
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

Key metrics to alert on:

```yaml
# PrometheusRule for Jaeger alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: jaeger-alerts
  namespace: observability
spec:
  groups:
    - name: jaeger
      rules:
        - alert: JaegerCollectorQueueFull
          expr: |
            jaeger_collector_queue_length / jaeger_collector_queue_capacity > 0.8
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Jaeger collector queue is {{ $value | humanizePercentage }} full"

        - alert: JaegerSpanDropRate
          expr: |
            rate(jaeger_collector_spans_dropped_total[5m]) > 100
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Jaeger dropping {{ $value | humanize }} spans/sec"

        - alert: JaegerESBulkWriteErrors
          expr: |
            rate(jaeger_exporter_sent_failed_spans[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Jaeger ES export failures: {{ $value | humanize }}/sec"
```

## Troubleshooting

### Traces Not Appearing in UI

```bash
# 1. Verify collector is receiving spans
kubectl logs -n observability deploy/jaeger-production-collector | grep "spans received"

# 2. Check ES write errors
kubectl logs -n observability deploy/jaeger-production-collector | grep -i error

# 3. Verify ES index creation
curl -s https://elasticsearch:9200/_cat/indices/jaeger* | sort

# 4. Test OTLP endpoint directly
grpcurl -plaintext \
  jaeger-production-collector.observability.svc.cluster.local:4317 \
  list

# 5. Check collector queue
kubectl exec -n observability deploy/jaeger-production-collector -- \
  wget -qO- http://localhost:8888/metrics | grep queue_length
```

### High Memory Usage in Tail Sampling

Tail sampling buffers traces in memory for `decision_wait` seconds. For 5000 traces/sec with 100 spans/trace and a 30-second wait:

```
memory = 5000 traces/sec × 30 sec × 100 spans × ~1KB/span = ~15 GB
```

Mitigate:

```yaml
processors:
  tail_sampling:
    decision_wait: 10s       # Reduce from 30s
    num_traces: 50000        # Hard cap on buffered traces
    expected_new_traces_per_sec: 1000
```

Or use a dedicated tail sampling gateway with separate memory from the ingestion path.

## Summary

Jaeger v2 on Kubernetes delivers:

1. **OpenTelemetry-native pipeline**: Single instrumentation works for Jaeger, Tempo, and any OTLP backend.
2. **Tail-based sampling**: Error and latency policies ensure the most valuable traces are never dropped, while a probabilistic baseline controls storage costs.
3. **Elasticsearch with ILM**: 30-day retention with automatic rollover and warm/cold tier management keeps storage costs predictable.
4. **DaemonSet collectors**: One collector per node with Kubernetes metadata enrichment adds namespace, pod, and deployment context to every span automatically.
5. **Operator lifecycle management**: CRD-driven configuration enables GitOps-style management of the entire tracing stack.

Invest in tail sampling policy design before production rollout — the default probabilistic-only sampling will hide exactly the traces you need during incidents.
