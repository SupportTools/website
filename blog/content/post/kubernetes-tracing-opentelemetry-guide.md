---
title: "Distributed Tracing on Kubernetes: OpenTelemetry Collector and Jaeger Production Setup"
date: 2027-09-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenTelemetry", "Tracing", "Observability", "Jaeger"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "End-to-end distributed tracing on Kubernetes covering auto-instrumentation with the OpenTelemetry operator, Collector pipeline configuration, sampling strategies, trace storage with Jaeger and Tempo, and trace-metric correlation."
more_link: "yes"
url: "/kubernetes-tracing-opentelemetry-guide/"
---

Distributed tracing provides the request-level view of system behavior that metrics and logs cannot: the exact sequence of service calls, database queries, and external API invocations that compose a single user request, with accurate timing for each span. On Kubernetes, the OpenTelemetry operator enables zero-code-change auto-instrumentation by injecting language-specific agents at pod startup, while the OpenTelemetry Collector provides a production-grade pipeline for sampling, batching, and routing traces to storage backends. This guide covers the complete setup from instrumentation to querying.

<!--more-->

## Section 1: OpenTelemetry Architecture Overview

```
Application Pods
  (auto-instrumented via OTel operator sidecar/init-container)
           │ OTLP gRPC/HTTP
           ▼
OpenTelemetry Collector DaemonSet
  (receive → process → sample → batch → export)
           │ OTLP
           ▼
OpenTelemetry Collector Deployment (gateway tier)
  (tail-based sampling, final routing)
           │
    ┌──────┴──────┐
    ▼             ▼
  Jaeger        Grafana Tempo
  (dev/test)    (production)
```

## Section 2: OpenTelemetry Operator Installation

```bash
# Install cert-manager (required by OTel operator webhooks)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.0/cert-manager.yaml
kubectl wait --for=condition=Available deployment/cert-manager -n cert-manager --timeout=120s

# Install OpenTelemetry Operator
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system \
  --create-namespace \
  --set manager.collectorImage.repository=otel/opentelemetry-collector-contrib \
  --set manager.collectorImage.tag=0.98.0 \
  --wait

# Verify operator is running
kubectl get pods -n opentelemetry-operator-system
# NAME                                                     READY   STATUS    RESTARTS   AGE
# opentelemetry-operator-controller-manager-xxxx           2/2     Running   0          60s
```

## Section 3: Auto-Instrumentation Configuration

The `Instrumentation` CRD configures automatic agent injection for each language runtime.

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: otel-instrumentation
  namespace: production
spec:
  # Exporter: send to local Collector DaemonSet
  exporter:
    endpoint: http://otel-collector.opentelemetry.svc.cluster.local:4317

  propagators:
  - tracecontext
  - baggage
  - b3multi     # For services still using Zipkin B3 propagation

  sampler:
    type: parentbased_traceidratio
    argument: "0.1"    # 10% head-based sampling at instrumentation level

  # Java auto-instrumentation
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
    env:
    - name: OTEL_INSTRUMENTATION_JDBC_STATEMENT_SANITIZATION_ENABLED
      value: "true"
    - name: OTEL_LOGS_EXPORTER
      value: "none"    # Only export traces, not logs

  # Python auto-instrumentation
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.44b0
    env:
    - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
      value: "false"

  # Node.js auto-instrumentation
  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.50.0
    env:
    - name: OTEL_NODE_RESOURCE_DETECTORS
      value: "env,host,os,process,container,alibaba-cloud,aws,gcp"

  # Go auto-instrumentation (eBPF-based, no agent injection needed in Go 1.22+)
  go:
    image: ghcr.io/open-telemetry/opentelemetry-go-instrumentation/autoinstrumentation-go:v0.11.0-alpha
    env:
    - name: OTEL_GO_AUTO_TARGET_EXE
      value: /app/server
    resourceRequirements:
      limits:
        cpu: 500m
        memory: 64Mi
```

### Enabling Auto-Instrumentation on Pods

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Enable auto-instrumentation
        instrumentation.opentelemetry.io/inject-java: "production/otel-instrumentation"
        # Or for container-specific injection:
        instrumentation.opentelemetry.io/container-names: "api"
    spec:
      containers:
      - name: api
        image: api-service:v2.1
        env:
        # Override service name for this deployment
        - name: OTEL_SERVICE_NAME
          value: "api-service"
        - name: OTEL_RESOURCE_ATTRIBUTES
          value: "service.version=2.1,deployment.environment=production"
```

## Section 4: OpenTelemetry Collector DaemonSet (Agent Tier)

The agent tier runs as a DaemonSet, receiving spans from applications on the same node and forwarding to the gateway tier.

```yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: otel-agent
  namespace: opentelemetry
spec:
  mode: daemonset
  hostNetwork: false
  serviceAccount: otel-agent
  tolerations:
  - operator: Exists
  resources:
    requests:
      cpu: 50m
      memory: 100Mi
    limits:
      cpu: 200m
      memory: 256Mi
  config:
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
            max_recv_msg_size_mib: 16
          http:
            endpoint: 0.0.0.0:4318

      # Collect Kubernetes resource attributes
      k8s_cluster:
        collection_interval: 10s
        node_conditions_to_report: [Ready, MemoryPressure]

    processors:
      # Add Kubernetes metadata to spans
      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        filter:
          node_from_env_var: KUBE_NODE_NAME
        extract:
          metadata:
          - k8s.pod.name
          - k8s.pod.uid
          - k8s.deployment.name
          - k8s.namespace.name
          - k8s.node.name
          - k8s.pod.start_time
          annotations:
          - tag_name: app.version
            key: app.kubernetes.io/version
            from: pod
          labels:
          - tag_name: app
            key: app
            from: pod

      # Add resource attributes
      resource:
        attributes:
        - key: cluster.name
          value: production-us-east-1
          action: upsert
        - key: k8s.cluster.name
          value: production-us-east-1
          action: upsert

      # Batch spans before sending
      batch:
        timeout: 1s
        send_batch_size: 1024
        send_batch_max_size: 2048

      memory_limiter:
        check_interval: 1s
        limit_mib: 200
        spike_limit_mib: 50

    exporters:
      otlp/gateway:
        endpoint: otel-gateway-collector.opentelemetry.svc.cluster.local:4317
        tls:
          insecure: false
          ca_file: /etc/ssl/certs/ca-bundle.crt
        sending_queue:
          enabled: true
          num_consumers: 10
          queue_size: 2000
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
          max_elapsed_time: 300s

    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
      pprof:
        endpoint: 0.0.0.0:1777

    service:
      extensions: [health_check, pprof]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp/gateway]
      telemetry:
        logs:
          level: warn
        metrics:
          address: 0.0.0.0:8888
```

## Section 5: OpenTelemetry Collector Gateway with Tail-Based Sampling

The gateway tier performs tail-based sampling, making sampling decisions only after receiving all spans for a trace (ensuring complete traces are kept or dropped).

```yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: opentelemetry
spec:
  mode: deployment
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2
      memory: 4Gi
  autoscaler:
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilization: 70
  config:
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

    processors:
      # Tail-based sampling: evaluate sampling policy after trace is complete
      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
        # Always keep error traces
        - name: errors-policy
          type: status_code
          status_code:
            status_codes: [ERROR]

        # Always keep slow traces (>2s)
        - name: slow-traces-policy
          type: latency
          latency:
            threshold_ms: 2000

        # Always keep traces with specific attributes (canary users, paid customers)
        - name: important-users-policy
          type: string_attribute
          string_attribute:
            key: user.tier
            values: ["enterprise", "premium"]

        # Probabilistic sampling for everything else: 1%
        - name: base-sample-policy
          type: probabilistic
          probabilistic:
            sampling_percentage: 1

        # Composite policy: keep 10% of health checks
        - name: health-check-policy
          type: and
          and:
            and_sub_policy:
            - name: url-filter
              type: string_attribute
              string_attribute:
                key: http.url
                values: ["/healthz", "/readyz", "/livez"]
                enabled_regex_matching: true
            - name: probabilistic-sub
              type: probabilistic
              probabilistic:
                sampling_percentage: 10

      batch:
        timeout: 5s
        send_batch_size: 8192
        send_batch_max_size: 16384

      memory_limiter:
        check_interval: 1s
        limit_mib: 3500
        spike_limit_mib: 500

    exporters:
      # Primary: Grafana Tempo
      otlp/tempo:
        endpoint: tempo.monitoring.svc.cluster.local:4317
        tls:
          insecure: true

      # Secondary: Jaeger (for development teams)
      jaeger:
        endpoint: jaeger-collector.monitoring.svc.cluster.local:14250
        tls:
          insecure: true

      # Prometheus exporter for trace-derived metrics (RED metrics)
      spanmetrics:
        metrics_exporter: prometheus
        latency_histogram_buckets: [5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s, 5s]
        dimensions:
        - name: http.method
        - name: http.status_code
        - name: http.route

      prometheus:
        endpoint: 0.0.0.0:8889
        namespace: otel

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, tail_sampling, batch]
          exporters: [otlp/tempo, jaeger]
        metrics/spanmetrics:
          receivers: [spanmetrics]
          exporters: [prometheus]
```

## Section 6: Jaeger Production Deployment

```yaml
# jaeger-values.yaml for jaeger-operator Helm chart
provisionDataStore:
  cassandra: false
  elasticsearch: false

storage:
  type: elasticsearch
  elasticsearch:
    host: elasticsearch-master.logging.svc.cluster.local
    port: 9200
    user: jaeger
    usePassword: true
    existingSecret: jaeger-es-secret
    existingSecretKey: password
    indexPrefix: jaeger
    useILM: true
    ilmPolicy: "jaeger-ilm-policy"

collector:
  replicaCount: 3
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilizationPercentage: 70
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 1
      memory: 1Gi

query:
  replicaCount: 2
  serviceType: ClusterIP
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

ingester:
  enabled: true
  replicaCount: 3
```

## Section 7: Grafana Tempo Production Deployment

Tempo is more cost-efficient than Jaeger for high-throughput deployments because it stores traces in object storage (S3/GCS) with no index.

```yaml
# tempo-values.yaml
tempo:
  storage:
    trace:
      backend: s3
      s3:
        bucket: example-tempo-traces
        endpoint: s3.amazonaws.com
        region: us-east-1
        # Use IAM role; no hardcoded credentials
        insecure: false
      wal:
        path: /var/tempo/wal
        v2_encoding: snappy
      block:
        v2_encoding: zstd
        bloom_filter_false_positive: 0.05
        v2_index_downsample_bytes: 1000
  retention: 336h    # 14 days

  # Global rate limits
  global_override:
    max_bytes_per_trace: 5000000    # 5MB max trace size
    max_search_bytes_per_trace: 0
    ingestion_rate_limit_bytes: 15000000    # 15MB/s per tenant
    ingestion_burst_size_bytes: 20000000

  querier:
    max_concurrent_queries: 20
    query_timeout: 30s

distributor:
  replicas: 3
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 1
      memory: 1Gi

ingester:
  replicas: 3
  persistence:
    enabled: true
    storageClassName: gp3
    size: 50Gi

compactor:
  replicas: 1

querier:
  replicas: 2
```

## Section 8: Trace-Metric Correlation

The SpanMetrics connector generates RED (Rate, Error, Duration) metrics from trace spans, enabling correlation between dashboards.

```yaml
# Grafana data source configuration for trace-metric correlation
datasources:
- name: Tempo
  type: tempo
  url: http://tempo.monitoring.svc.cluster.local:3200
  jsonData:
    tracesToMetrics:
      datasourceUid: prometheus
      tags:
      - key: service.name
        value: service
      - key: job
      queries:
      - name: Request Rate
        query: "rate(calls_total{service=\"$${__span.tags.service}\"}[5m])"
      - name: Error Rate
        query: "rate(calls_total{service=\"$${__span.tags.service}\",status_code=\"STATUS_CODE_ERROR\"}[5m])"
      - name: P99 Latency
        query: "histogram_quantile(0.99, rate(duration_milliseconds_bucket{service=\"$${__span.tags.service}\"}[5m]))"
    tracesToLogs:
      datasourceUid: loki
      tags: [job, namespace, pod]
      mapTagNamesEnabled: true
      mappedTags:
      - key: service.name
        value: app
    serviceMap:
      datasourceUid: prometheus
    nodeGraph:
      enabled: true
    search:
      hide: false
    lokiSearch:
      datasourceUid: loki
```

## Section 9: Instrumentation for Go Services

When auto-instrumentation is insufficient, add manual instrumentation for critical code paths.

```go
package main

import (
    "context"
    "fmt"
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("api-service")

func initTracing(ctx context.Context) (*sdktrace.TracerProvider, error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint("otel-collector:4317"),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating OTLP exporter: %w", err)
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName("api-service"),
            semconv.ServiceVersion("2.1.0"),
            semconv.DeploymentEnvironment("production"),
        ),
        resource.WithFromEnv(),
        resource.WithProcess(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(
            sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1)),
        ),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp, nil
}

func processOrder(ctx context.Context, orderID string) error {
    ctx, span := tracer.Start(ctx, "processOrder",
        trace.WithAttributes(
            attribute.String("order.id", orderID),
            attribute.String("order.source", "api"),
        ),
        trace.WithSpanKind(trace.SpanKindServer),
    )
    defer span.End()

    // Database call
    ctx, dbSpan := tracer.Start(ctx, "db.getOrder",
        trace.WithAttributes(
            semconv.DBSystemPostgreSQL,
            semconv.DBStatement("SELECT * FROM orders WHERE id = $1"),
        ),
        trace.WithSpanKind(trace.SpanKindClient),
    )
    // ... db query ...
    dbSpan.End()

    // External service call
    ctx, httpSpan := tracer.Start(ctx, "payment.charge",
        trace.WithSpanKind(trace.SpanKindClient),
    )
    resp, err := doPaymentRequest(ctx, orderID)
    if err != nil {
        httpSpan.RecordError(err)
        httpSpan.SetStatus(codes.Error, err.Error())
        httpSpan.End()
        span.RecordError(err)
        span.SetStatus(codes.Error, "payment failed")
        return err
    }
    httpSpan.SetAttributes(
        semconv.HTTPStatusCode(resp.StatusCode),
    )
    httpSpan.End()

    span.SetStatus(codes.Ok, "")
    return nil
}

func doPaymentRequest(ctx context.Context, orderID string) (*http.Response, error) {
    // Propagate trace context in outbound HTTP headers
    req, _ := http.NewRequestWithContext(ctx, "POST",
        "http://payment-service/charge", nil)
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
    return http.DefaultClient.Do(req)
}
```

## Section 10: Sampling Strategy Selection

| Strategy | Type | When to Use | Overhead |
|----------|------|-------------|---------|
| Always-on | Head | Development, low-traffic services | High storage |
| Rate-based | Head | Uniform sampling across all requests | Medium |
| ParentBased | Head | Respect upstream sampling decision | Low |
| Tail-based (error) | Tail | Always capture error traces | Medium (gateway) |
| Tail-based (latency) | Tail | Capture slow outliers | Medium (gateway) |
| Adaptive | Tail | Dynamic rate based on traffic | High (gateway) |

### Tail Sampling Resource Requirements

```
At 10,000 traces/second with 10-second decision window:
  - In-flight traces: 10,000 × 10s = 100,000 traces
  - Avg spans per trace: 20
  - Avg span size: 1KB
  - Memory: 100,000 × 20 × 1KB = ~2GB per gateway instance

Scale horizontally: 3 gateway replicas with consistent hashing
to route all spans for a given trace to the same collector instance.
```

```yaml
# Consistent hash load balancing for tail-sampling collectors
# Requires OTLP load balancer exporter in the agent tier
exporters:
  loadbalancing:
    protocol:
      otlp:
        tls:
          insecure: true
    resolver:
      k8s:
        service: otel-gateway-collector-headless
        ports: [4317]
    routing_key: "traceID"    # All spans for a trace → same gateway instance
```

## Summary

OpenTelemetry provides the canonical instrumentation standard for distributed tracing on Kubernetes. The operator's auto-instrumentation eliminates manual SDK integration for Java, Python, and Node.js workloads, while the Collector's tail-based sampling ensures that error and latency outlier traces are always captured regardless of the head-based sampling rate. Grafana Tempo provides the most cost-efficient storage for high-throughput environments by storing traces directly in S3, while the SpanMetrics connector bridges tracing and metrics to enable one-click navigation from a Prometheus alert to the offending trace in Grafana.
