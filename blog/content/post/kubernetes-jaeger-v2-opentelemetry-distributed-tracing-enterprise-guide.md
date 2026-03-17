---
title: "Kubernetes Jaeger v2 with OpenTelemetry: OTLP Ingestion, Adaptive Sampling, ES and Kafka Storage Backends"
date: 2031-11-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Jaeger", "OpenTelemetry", "Distributed Tracing", "Observability", "Elasticsearch", "Kafka"]
categories:
- Kubernetes
- Observability
- Distributed Tracing
author: "Matthew Mattox - mmattox@support.tools"
description: "Production deployment guide for Jaeger v2 on Kubernetes with the OpenTelemetry Collector as the ingestion pipeline, adaptive tail-based sampling, and durable storage backends using Elasticsearch or Kafka."
more_link: "yes"
url: "/kubernetes-jaeger-v2-opentelemetry-distributed-tracing-enterprise-guide/"
---

Jaeger v2 represents a significant architectural shift from the standalone binary model of v1 toward a first-class OpenTelemetry Collector plugin. The old Jaeger Agent/Collector/Query separation has been unified into a single binary that embeds an OTel Collector pipeline, giving platform teams the full power of OTel processors and exporters while retaining Jaeger's battle-tested storage backends and UI. This guide walks through the complete deployment: OTLP ingestion architecture, adaptive sampling configuration, Elasticsearch and Kafka backends, and production hardening on Kubernetes.

<!--more-->

# Kubernetes Jaeger v2 with OpenTelemetry: Production Deployment Guide

## What Changed in Jaeger v2

Jaeger v2 (released with the jaeger-v2.x series) replaced the internal pipeline with an embedded OpenTelemetry Collector:

| Component | v1 | v2 |
|-----------|----|----|
| Agent | Separate DaemonSet (UDP) | OTel SDK directly to Collector |
| Collector | Separate Deployment | `jaeger` binary with OTel pipeline |
| Query | Separate Deployment | Built into `jaeger` binary |
| Ingestion protocol | Thrift/HTTP/UDP, gRPC | OTLP/gRPC, OTLP/HTTP (plus legacy) |
| Processor chain | Fixed internal pipeline | OTel Collector processors (configurable) |
| Sampling | Remote sampling API | Adaptive tail-based via `jaeger_storage_adaptive_sampling` |

## Section 1: Architecture Design

### Recommended Production Topology

```
Application Pods (OTel SDK)
        |
        | OTLP/gRPC (4317)
        v
OTel Collector DaemonSet (per-node, handles batching)
        |
        | OTLP/gRPC
        v
Jaeger All-in-One or Collector Deployment
        |
        |---> Elasticsearch (storage)
        |---> Kafka (optional: for large-scale fan-out)
        |
        v
Jaeger Query Service (read path)
        |
Jaeger UI / Grafana Jaeger datasource
```

For large-scale deployments (>10k spans/second), insert Kafka between the OTel Collector and Jaeger Collector:

```
OTel Collector → Kafka (jaeger-spans topic) → Jaeger Ingester → Elasticsearch
```

## Section 2: Kubernetes Deployment

### Namespace and RBAC

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: tracing
  labels:
    app.kubernetes.io/managed-by: helm

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: jaeger
  namespace: tracing

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: jaeger-sampling-reader
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: jaeger-sampling-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: jaeger-sampling-reader
subjects:
  - kind: ServiceAccount
    name: jaeger
    namespace: tracing
```

### Jaeger v2 Configuration via ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: jaeger-config
  namespace: tracing
data:
  config.yaml: |
    service:
      extensions: [jaeger_storage, jaeger_query, adaptive_sampling]
      pipelines:
        traces:
          receivers: [otlp, jaeger]
          processors: [batch, memory_limiter, tail_sampling]
          exporters: [jaeger_storage_exporter]

    extensions:
      jaeger_storage:
        backends:
          elasticsearch_main:
            elasticsearch:
              server_urls: ["https://elasticsearch-master.elastic:9200"]
              index_prefix: jaeger
              tls:
                ca_file: /etc/tls/ca.crt
                cert_file: /etc/tls/tls.crt
                key_file: /etc/tls/tls.key
              tags_as_fields:
                all: false
                include: ["http.status_code", "error", "service.version", "k8s.pod.name"]
              bulk:
                workers: 4
                size: 5000000
                flush_interval: 200ms
              logs:
                level: error

          # Sampling storage (can use same or separate ES index)
          sampling_storage:
            elasticsearch:
              server_urls: ["https://elasticsearch-master.elastic:9200"]
              index_prefix: jaeger-sampling
              tls:
                ca_file: /etc/tls/ca.crt
                cert_file: /etc/tls/tls.crt
                key_file: /etc/tls/tls.key

      jaeger_query:
        storage:
          traces: elasticsearch_main
          sampling: sampling_storage
        base_path: /
        ui:
          config_file: /etc/jaeger/ui-config.json
          assets_path: /usr/share/jaeger/ui

      adaptive_sampling:
        sampling_store: sampling_storage
        initial_sampling_probability: 0.1
        calculation_interval: 1m
        aggregation_buckets: 10
        delay: 2m
        target_samples_per_second: 1.0     # Target 1 sampled span per second per operation
        busyness_detector:
          factor: 0.5
          decay: 0.9

    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: "0.0.0.0:4317"
            max_recv_msg_size_mib: 16
          http:
            endpoint: "0.0.0.0:4318"
            cors:
              allowed_origins: ["https://*.example.com"]
              max_age: 7200

      # Legacy Jaeger protocol support (migration period)
      jaeger:
        protocols:
          thrift_http:
            endpoint: "0.0.0.0:14268"
          grpc:
            endpoint: "0.0.0.0:14250"

    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 1024
        spike_limit_mib: 256

      batch:
        timeout: 200ms
        send_batch_size: 1000
        send_batch_max_size: 5000

      tail_sampling:
        decision_wait: 10s
        num_traces: 50000
        expected_new_traces_per_sec: 5000
        policies:
          - name: errors-always-sample
            type: status_code
            status_code:
              status_codes: [ERROR]

          - name: slow-traces
            type: latency
            latency:
              threshold_ms: 2000

          - name: high-value-services
            type: string_attribute
            string_attribute:
              key: service.name
              values: ["payment-service", "order-service", "checkout-service"]
              enabled_regex_matching: false
              invert_match: false

          - name: probabilistic-catch-all
            type: probabilistic
            probabilistic:
              sampling_percentage: 1

    exporters:
      jaeger_storage_exporter:
        trace_storage: elasticsearch_main
```

### Jaeger Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: tracing
  labels:
    app: jaeger
spec:
  replicas: 2
  selector:
    matchLabels:
      app: jaeger
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    metadata:
      labels:
        app: jaeger
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8888"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: jaeger
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        fsGroup: 10001
      containers:
        - name: jaeger
          image: jaegertracing/jaeger:2.1.0
          args:
            - "--config=/etc/jaeger/config.yaml"
          ports:
            - name: otlp-grpc
              containerPort: 4317
              protocol: TCP
            - name: otlp-http
              containerPort: 4318
              protocol: TCP
            - name: jaeger-grpc
              containerPort: 14250
              protocol: TCP
            - name: jaeger-http
              containerPort: 14268
              protocol: TCP
            - name: query
              containerPort: 16686
              protocol: TCP
            - name: metrics
              containerPort: 8888
              protocol: TCP
            - name: health
              containerPort: 13133
              protocol: TCP
          env:
            - name: SPAN_STORAGE_TYPE
              value: elasticsearch
            - name: ES_USERNAME
              valueFrom:
                secretKeyRef:
                  name: jaeger-es-secret
                  key: username
            - name: ES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: jaeger-es-secret
                  key: password
          volumeMounts:
            - name: config
              mountPath: /etc/jaeger
            - name: ui-config
              mountPath: /etc/jaeger/ui-config.json
              subPath: ui-config.json
            - name: tls
              mountPath: /etc/tls
              readOnly: true
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
          livenessProbe:
            httpGet:
              path: /
              port: health
            initialDelaySeconds: 30
            periodSeconds: 15
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /
              port: health
            initialDelaySeconds: 10
            periodSeconds: 10
      volumes:
        - name: config
          configMap:
            name: jaeger-config
        - name: ui-config
          configMap:
            name: jaeger-ui-config
        - name: tls
          secret:
            secretName: jaeger-tls
```

### Services

```yaml
apiVersion: v1
kind: Service
metadata:
  name: jaeger-collector
  namespace: tracing
  labels:
    app: jaeger
    component: collector
spec:
  selector:
    app: jaeger
  ports:
    - name: otlp-grpc
      port: 4317
      targetPort: 4317
      protocol: TCP
    - name: otlp-http
      port: 4318
      targetPort: 4318
      protocol: TCP
    - name: jaeger-grpc
      port: 14250
      targetPort: 14250
      protocol: TCP
    - name: jaeger-http
      port: 14268
      targetPort: 14268
      protocol: TCP
  type: ClusterIP

---
apiVersion: v1
kind: Service
metadata:
  name: jaeger-query
  namespace: tracing
  labels:
    app: jaeger
    component: query
spec:
  selector:
    app: jaeger
  ports:
    - name: http
      port: 16686
      targetPort: 16686
  type: ClusterIP

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: jaeger-query
  namespace: tracing
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: jaeger-basic-auth
    nginx.ingress.kubernetes.io/auth-realm: "Jaeger Tracing"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - traces.example.com
      secretName: jaeger-tls-ingress
  rules:
    - host: traces.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: jaeger-query
                port:
                  number: 16686
```

## Section 3: OTel Collector as Forwarder

Deploy OTel Collector as a DaemonSet to handle per-node batching and reduce TCP connections to Jaeger:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: tracing
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: "0.0.0.0:4317"
          http:
            endpoint: "0.0.0.0:4318"

    processors:
      batch:
        timeout: 100ms
        send_batch_size: 512

      resource:
        attributes:
          - key: k8s.node.name
            from_attribute: k8s.node.name
            action: upsert
          - key: deployment.environment
            value: "production"
            action: insert

      # Filter internal/health-check traces
      filter:
        traces:
          span:
            - 'attributes["http.target"] == "/healthz"'
            - 'attributes["http.target"] == "/readyz"'
            - 'attributes["http.target"] == "/metrics"'

      memory_limiter:
        check_interval: 1s
        limit_mib: 256
        spike_limit_mib: 64

    exporters:
      otlp:
        endpoint: "jaeger-collector.tracing.svc.cluster.local:4317"
        tls:
          insecure: true   # TLS terminated at Jaeger; internal cluster traffic
        sending_queue:
          num_consumers: 4
          queue_size: 1000
        retry_on_failure:
          enabled: true
          initial_interval: 1s
          max_interval: 30s
          max_elapsed_time: 120s

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch, resource, filter]
          exporters: [otlp]
      telemetry:
        metrics:
          level: detailed
          address: "0.0.0.0:8888"

---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-collector
  namespace: tracing
spec:
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
    spec:
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.102.0
          args: ["--config=/etc/otel/config.yaml"]
          ports:
            - containerPort: 4317
              hostPort: 4317
              name: otlp-grpc
              protocol: TCP
            - containerPort: 4318
              hostPort: 4318
              name: otlp-http
              protocol: TCP
            - containerPort: 8888
              name: metrics
          env:
            - name: K8S_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          volumeMounts:
            - name: config
              mountPath: /etc/otel
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
      tolerations:
        - operator: Exists
          effect: NoSchedule
```

## Section 4: Adaptive Sampling Deep Dive

### How Adaptive Sampling Works

Jaeger's adaptive sampler uses a feedback loop:

1. All Jaeger collectors report throughput data to shared storage (sampling_storage)
2. The adaptive sampler periodically reads aggregate throughput
3. It computes per-operation sampling probabilities to hit the target rate
4. Probabilities are published to a remote sampling endpoint
5. SDKs poll `/api/sampling?service=<name>` and update local sampler rates

### Sampling Configuration

```yaml
extensions:
  adaptive_sampling:
    # How often to recalculate probabilities
    calculation_interval: 1m

    # Number of time buckets to aggregate over
    aggregation_buckets: 10

    # Delay before using new data (allow aggregation to complete)
    delay: 2m

    # Target sampled spans per second per unique operation
    target_samples_per_second: 1.0

    # Minimum sampling probability (never go below this)
    min_sampling_probability: 0.001   # 0.1%

    # Maximum sampling probability (never go above this)
    max_sampling_probability: 1.0     # 100%

    # Initial probability before data is available
    initial_sampling_probability: 0.1  # 10%

    # Sampling store backend
    sampling_store: sampling_storage

    # Leader election (when running multiple Jaeger instances)
    leader_lease_refresh_interval: 5s
    leader_lease_duration: 15s
```

### Tail-Based vs Head-Based Sampling

```
Head-based sampling (at SDK level):
  - Decision made on first span of trace
  - Simple, low overhead
  - Cannot base decision on trace outcome (error, latency)
  - Used for cost control in high-throughput services

Tail-based sampling (in OTel Collector processor):
  - Waits for complete trace, then decides
  - Can sample ALL errors, ALL slow traces
  - Higher memory usage (holds traces in memory for decision_wait period)
  - Required for SLO-aware sampling
```

Configure tail sampling in the OTel Collector pipeline for maximum control:

```yaml
processors:
  tail_sampling:
    decision_wait: 10s          # Wait up to 10s for all spans in a trace
    num_traces: 100000          # Max traces held in memory simultaneously
    expected_new_traces_per_sec: 10000

    policies:
      # Policy 1: Always sample traces with errors
      - name: sample-errors
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Policy 2: Always sample slow traces (>2s)
      - name: sample-slow
        type: latency
        latency:
          threshold_ms: 2000

      # Policy 3: Always sample traces with specific attributes
      - name: sample-synthetic-tests
        type: boolean_attribute
        boolean_attribute:
          key: synthetics.test
          value: true

      # Policy 4: Sample 5% of payment service traces
      - name: payment-service-probabilistic
        type: composite
        composite:
          max_total_spans_per_second: 500
          policy_order: [payment-check, payment-probabilistic]
          composite_sub_policy:
            - name: payment-check
              type: string_attribute
              string_attribute:
                key: service.name
                values: ["payment-service"]
            - name: payment-probabilistic
              type: probabilistic
              probabilistic:
                sampling_percentage: 5

      # Policy 5: 0.1% of everything else
      - name: catch-all
        type: probabilistic
        probabilistic:
          sampling_percentage: 0.1
```

## Section 5: Elasticsearch Storage Backend

### Index Template Configuration

Jaeger creates ES indices named `jaeger-span-YYYY-MM-DD` and `jaeger-service-YYYY-MM-DD`. Configure a proper index template before first use:

```bash
# Apply index template
curl -X PUT "https://elasticsearch-master.elastic:9200/_index_template/jaeger-spans" \
  -H 'Content-Type: application/json' \
  -d '{
    "index_patterns": ["jaeger-span-*"],
    "template": {
      "settings": {
        "number_of_shards": 3,
        "number_of_replicas": 1,
        "index.refresh_interval": "5s",
        "index.translog.durability": "async",
        "index.translog.sync_interval": "30s",
        "index.codec": "best_compression"
      },
      "mappings": {
        "dynamic_templates": [
          {
            "span_tags_map": {
              "mapping": {"type": "keyword", "ignore_above": 256},
              "path_match": "tag.*"
            }
          }
        ],
        "properties": {
          "traceID": {"type": "keyword"},
          "spanID": {"type": "keyword"},
          "operationName": {"type": "keyword"},
          "startTime": {"type": "long"},
          "duration": {"type": "long"},
          "flags": {"type": "integer"},
          "process": {
            "properties": {
              "serviceName": {"type": "keyword"},
              "tags": {
                "type": "nested",
                "properties": {
                  "key": {"type": "keyword"},
                  "value": {"type": "keyword"}
                }
              }
            }
          }
        }
      }
    }
  }'
```

### Index Lifecycle Management (ILM)

```bash
# Create ILM policy for span retention
curl -X PUT "https://elasticsearch-master.elastic:9200/_ilm/policy/jaeger-spans-policy" \
  -H 'Content-Type: application/json' \
  -d '{
    "policy": {
      "phases": {
        "hot": {
          "min_age": "0ms",
          "actions": {
            "rollover": {
              "max_primary_shard_size": "50gb",
              "max_age": "1d"
            }
          }
        },
        "warm": {
          "min_age": "2d",
          "actions": {
            "shrink": {"number_of_shards": 1},
            "forcemerge": {"max_num_segments": 1},
            "allocate": {
              "require": {"data": "warm"}
            }
          }
        },
        "cold": {
          "min_age": "7d",
          "actions": {
            "allocate": {
              "require": {"data": "cold"}
            },
            "freeze": {}
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
  }'
```

### Jaeger Rollover and ES Index Cleanup

Jaeger includes a built-in rollover and cleanup mechanism:

```bash
# Run Jaeger rollover job (creates new day's index and updates write alias)
kubectl run jaeger-rollover --rm -it --restart=Never \
  --image=jaegertracing/jaeger:2.1.0 \
  --env="ES_SERVER_URLS=https://elasticsearch-master.elastic:9200" \
  --env="ES_USERNAME=jaeger" \
  --env="ES_PASSWORD=<es-password-placeholder>" \
  -- /go/bin/jaeger-es-rollover init

# Run as CronJob
apiVersion: batch/v1
kind: CronJob
metadata:
  name: jaeger-es-rollover
  namespace: tracing
spec:
  schedule: "0 0 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: rollover
              image: jaegertracing/jaeger:2.1.0
              args: ["/go/bin/jaeger-es-rollover", "rollover"]
              env:
                - name: ES_SERVER_URLS
                  value: "https://elasticsearch-master.elastic:9200"
                - name: ES_USERNAME
                  valueFrom:
                    secretKeyRef:
                      name: jaeger-es-secret
                      key: username
                - name: ES_PASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: jaeger-es-secret
                      key: password
                - name: INDEX_PREFIX
                  value: "jaeger"
```

## Section 6: Kafka Storage Backend (High Throughput)

### Architecture with Kafka

For clusters ingesting >100k spans/second, Kafka decouples ingestion from storage:

```
Jaeger Collector (writes to Kafka)
        |
        v
Kafka Topic: jaeger-spans (32 partitions)
        |
        v
Jaeger Ingester Deployment (reads from Kafka, writes to ES)
        |
        v
Elasticsearch
```

### Kafka Backend Configuration

```yaml
# In Jaeger config.yaml, replace elasticsearch exporter with kafka exporter:
extensions:
  jaeger_storage:
    backends:
      kafka_writer:
        kafka:
          brokers:
            - kafka-0.kafka.messaging:9092
            - kafka-1.kafka.messaging:9092
            - kafka-2.kafka.messaging:9092
          topic: jaeger-spans
          protocol_version: "2.4.0"
          encoding: protobuf   # More efficient than json
          producer:
            requiredAcks: local  # local=leader ack, all=ISR ack
            compression: snappy
            flush_frequency: 100ms
            batch_size: 131072

exporters:
  jaeger_storage_exporter:
    trace_storage: kafka_writer
```

### Jaeger Ingester Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger-ingester
  namespace: tracing
spec:
  replicas: 3   # Scale based on Kafka partition count
  selector:
    matchLabels:
      app: jaeger-ingester
  template:
    spec:
      containers:
        - name: jaeger-ingester
          image: jaegertracing/jaeger-ingester:2.1.0
          args:
            - "--config=/etc/jaeger/ingester-config.yaml"
          env:
            - name: KAFKA_CONSUMER_BROKERS
              value: "kafka-0.kafka:9092,kafka-1.kafka:9092,kafka-2.kafka:9092"
            - name: KAFKA_CONSUMER_TOPIC
              value: "jaeger-spans"
            - name: KAFKA_CONSUMER_GROUP_ID
              value: "jaeger-ingester"
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
```

## Section 7: SDK Integration

### Go Application Instrumentation

```go
package main

import (
    "context"
    "fmt"
    "log"
    "net/http"
    "os"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

func initTracer(ctx context.Context) (*sdktrace.TracerProvider, error) {
    // OTel Collector address — use node-local DaemonSet via hostPort
    collectorAddr := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if collectorAddr == "" {
        collectorAddr = "localhost:4317"
    }

    conn, err := grpc.DialContext(ctx, collectorAddr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
        grpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("connecting to OTel collector: %w", err)
    }

    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("creating OTLP exporter: %w", err)
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(os.Getenv("SERVICE_NAME")),
            semconv.ServiceVersion(os.Getenv("SERVICE_VERSION")),
            semconv.DeploymentEnvironment(os.Getenv("DEPLOY_ENV")),
            attribute.String("k8s.namespace.name", os.Getenv("K8S_NAMESPACE")),
            attribute.String("k8s.pod.name", os.Getenv("K8S_POD_NAME")),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(200*time.Millisecond),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithResource(res),
        // Use remote sampler that polls Jaeger's adaptive sampling endpoint
        sdktrace.WithSampler(
            sdktrace.ParentBased(
                newRemoteSampler("http://jaeger-collector.tracing.svc:14268/api/sampling"),
            ),
        ),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp, nil
}

func newRemoteSampler(endpoint string) sdktrace.Sampler {
    // Use the Jaeger remote sampler which polls adaptive sampling probabilities
    return jaegerremote.New("myservice",
        jaegerremote.WithSamplingServerURL(endpoint),
        jaegerremote.WithSamplingRefreshInterval(30*time.Second),
        jaegerremote.WithInitialSampler(sdktrace.TraceIDRatioBased(0.1)),
    )
}

// Instrumented HTTP handler
func handleRequest(w http.ResponseWriter, r *http.Request) {
    tracer := otel.Tracer("my-service")
    ctx, span := tracer.Start(r.Context(), "handleRequest",
        trace.WithAttributes(
            semconv.HTTPMethod(r.Method),
            semconv.HTTPURL(r.URL.String()),
            semconv.HTTPTarget(r.URL.Path),
        ),
    )
    defer span.End()

    result, err := callDownstreamService(ctx)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }

    span.SetAttributes(attribute.String("result.type", result.Type))
    fmt.Fprintf(w, "OK: %v", result)
}
```

## Section 8: Observability of the Tracing Pipeline

### Metrics to Monitor

```promql
# Spans received per second
rate(otelcol_receiver_accepted_spans_total{receiver="otlp"}[1m])

# Spans dropped (queue overflow)
rate(otelcol_processor_dropped_spans_total[1m])

# Tail sampling decision latency
histogram_quantile(0.99, rate(otelcol_processor_tail_sampling_sampling_decision_timer_ms_bucket[5m]))

# Spans exported to Jaeger
rate(otelcol_exporter_sent_spans_total{exporter="otlp"}[1m])

# ES indexing rate
rate(jaeger_storage_attempts_total{storage="elasticsearch",result="ok"}[1m])

# ES indexing errors
rate(jaeger_storage_attempts_total{storage="elasticsearch",result="error"}[1m])

# Jaeger query latency
histogram_quantile(0.99, rate(jaeger_query_latency_seconds_bucket[5m]))
```

### Alerting Rules

```yaml
groups:
  - name: jaeger
    rules:
      - alert: JaegerSpanDropRate
        expr: |
          rate(otelcol_processor_dropped_spans_total[5m]) /
          rate(otelcol_receiver_accepted_spans_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "More than 1% of spans are being dropped"

      - alert: JaegerStorageErrors
        expr: |
          rate(jaeger_storage_attempts_total{result="error"}[5m]) > 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Jaeger storage errors exceeding 1/s"

      - alert: JaegerCollectorQueueFull
        expr: |
          otelcol_exporter_queue_size / otelcol_exporter_queue_capacity > 0.8
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Jaeger collector export queue is 80%+ full"
```

## Section 9: Multi-Tenant Tracing

### Tenant Isolation with Namespace-Scoped Collectors

```yaml
# Per-tenant OTel Collector that writes to tenant-specific ES index prefix
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-tenant-a
  namespace: tenant-a
data:
  config.yaml: |
    exporters:
      otlp:
        endpoint: "jaeger-collector.tracing.svc.cluster.local:4317"
        headers:
          X-Tenant-ID: "tenant-a"
          X-Index-Prefix: "jaeger-tenant-a"
```

Jaeger uses the `X-Tenant-ID` header (via the `grpc_metadata` processor) to route spans to tenant-specific index prefixes.

## Section 10: Upgrade and Migration

### Migrating from Jaeger v1 to v2

```bash
#!/bin/bash
# Migration script: Jaeger v1 to v2

# Step 1: Verify existing Elasticsearch data compatibility
kubectl exec -n tracing deploy/jaeger-query -- \
  jaeger-es-index-cleaner --es.server-urls=https://es:9200 dry-run

# Step 2: Deploy Jaeger v2 alongside v1 (parallel ingestion period)
kubectl apply -f jaeger-v2-deployment.yaml

# Step 3: Update OTel Collectors to point to v2 collector
kubectl patch configmap otel-collector-config -n tracing \
  --type merge \
  -p '{"data":{"config.yaml": "<new config with v2 endpoint>"}}'

# Step 4: Restart OTel Collectors to pick up new config
kubectl rollout restart daemonset/otel-collector -n tracing

# Step 5: Verify spans arriving in v2
kubectl logs -n tracing deploy/jaeger-v2 --since=5m | grep "spans received"

# Step 6: Scale down v1 collector
kubectl scale deploy/jaeger-collector-v1 --replicas=0 -n tracing

# Step 7: Remove v1 query (keep v2 as primary UI)
kubectl delete deploy/jaeger-query-v1 -n tracing
```

## Conclusion

Jaeger v2 with the embedded OpenTelemetry Collector pipeline provides enterprise-grade distributed tracing with these key capabilities:

1. **OTLP-native ingestion** via the OTel Collector DaemonSet eliminates the legacy UDP agent and provides batching, filtering, and enrichment before storage.
2. **Adaptive sampling** closes the feedback loop: high-volume operations get lower sampling rates automatically while errors and slow traces are always captured.
3. **Tail-based sampling** in the OTel Collector processor enables SLO-aware sampling decisions based on complete trace outcomes.
4. **Elasticsearch with ILM** provides durable, cost-tiered storage with automated index lifecycle management for configurable retention.
5. **Kafka backend** decouples ingestion from storage for deployments above 100k spans/second without data loss under ES maintenance events.

The shift to OTel-first architecture in Jaeger v2 means your investment in OTel SDK instrumentation and OTel Collector configuration is portable across backends—whether Jaeger, Tempo, or a commercial vendor.
