---
title: "Grafana Tempo: Distributed Tracing at Scale on Kubernetes"
date: 2027-03-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Tempo", "Distributed Tracing", "Observability", "OpenTelemetry"]
categories: ["Kubernetes", "Observability", "Tracing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise deployment guide for Grafana Tempo distributed tracing on Kubernetes, covering distributed mode components, S3 backend, TraceQL query language, exemplars linking metrics to traces, span metrics pipeline, service graph generation, and OpenTelemetry Collector integration."
more_link: "yes"
url: "/tempo-distributed-tracing-kubernetes-guide/"
---

Grafana Tempo stores distributed traces on object storage — S3, GCS, or Azure Blob — at a fraction of the cost of Jaeger with Cassandra or Elasticsearch backends. Its tight integration with Prometheus exemplars, Loki logs, and the Grafana data source ecosystem enables the full observability loop: from a dashboard alert to the trace, from a trace to the correlated logs, and from logs back to the originating service's metrics.

This guide covers the full production deployment path: distributed component architecture, Helm configuration, OpenTelemetry Collector integration, TraceQL queries, exemplars, span metrics, service graph generation, and health monitoring.

<!--more-->

## Tempo Architecture

### Ingest path

1. **Distributor**: receives spans from OpenTelemetry Collector, Jaeger agents, Zipkin collectors, or OpenCensus. Routes to ingesters based on trace ID hash.
2. **Ingester**: buffers spans in memory, writes complete traces to object storage (WAL for durability). Flushes after `max_block_duration` or `max_block_bytes` is reached.

### Query path

1. **Query Frontend**: accepts TraceQL and trace ID queries from Grafana, splits them for parallelism, caches results.
2. **Querier**: fetches trace blocks from object storage and in-memory ingester data. Merges results from multiple ingesters (during in-flight period).

### Background operations

3. **Compactor**: merges small blocks into larger blocks, applies retention policy, generates bloom filters for TraceQL search acceleration.

### Pipeline components

4. **Metrics Generator**: processes spans in real-time to generate:
   - **Span metrics**: RED metrics (Rate, Errors, Duration) derived from span data
   - **Service graph**: node and edge metrics representing service-to-service dependencies

## Supported Protocols

Tempo's distributor supports all major tracing wire formats:

| Protocol | Port | Description |
|---|---|---|
| OTLP gRPC | 4317 | OpenTelemetry Protocol (preferred) |
| OTLP HTTP | 4318 | OpenTelemetry Protocol over HTTP |
| Jaeger Thrift Compact | 6831 (UDP) | Legacy Jaeger agent protocol |
| Jaeger Thrift HTTP | 14268 | Jaeger HTTP collector |
| Jaeger gRPC | 14250 | Jaeger gRPC collector |
| Zipkin HTTP | 9411 | Zipkin v1/v2 JSON or Thrift |

## Installing Tempo in Distributed Mode

```bash
# Add Grafana Helm repository
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# Create namespace
kubectl create namespace tracing

# Install Tempo distributed mode
helm upgrade --install tempo grafana/tempo-distributed \
  --namespace tracing \
  --version 1.28.0 \
  --values tempo-distributed-values.yaml \
  --wait --timeout=15m
```

### Production Helm values

```yaml
# tempo-distributed-values.yaml

# Global multi-tenancy
multitenancyEnabled: true

# Storage backend — S3
storage:
  trace:
    backend: s3
    s3:
      bucket: tempo-traces-prod
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      # Use IRSA or explicit credentials
      access_key: ${AWS_ACCESS_KEY_ID}
      secret_key: ${AWS_SECRET_ACCESS_KEY}
      insecure: false
      # Force path style for MinIO compatibility; set false for AWS S3
      forcepathstyle: false

# Tempo configuration block
tempo:
  reportingEnabled: false

  # Ingester configuration
  ingester:
    max_block_duration: 30m      # flush blocks after 30 minutes
    max_block_bytes: 524288000   # flush at 500 MiB
    trace_idle_period: 10s       # consider a trace complete after 10s of silence
    complete_block_timeout: 15m

  # Compactor configuration
  compactor:
    compaction:
      block_retention: 336h      # 14 days retention
      compacted_block_retention: 1h
      compaction_window: 1h
      max_compaction_objects: 6000000
      max_block_bytes: 107374182400   # 100 GiB max compacted block
      retention_concurrency: 10
    ring:
      kvstore:
        store: memberlist

  # Query configuration
  query_frontend:
    search:
      # Duration of the search window for TraceQL queries
      default_result_limit: 20
      max_result_limit: 500
    trace_by_id:
      query_shards: 50           # parallelize trace ID lookups across 50 shards

  # Distributor receiver configuration
  distributor:
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
      jaeger:
        protocols:
          thrift_http:
            endpoint: 0.0.0.0:14268
          grpc:
            endpoint: 0.0.0.0:14250
          thrift_compact:
            endpoint: 0.0.0.0:6831
      zipkin:
        endpoint: 0.0.0.0:9411

  # Metrics generator — span metrics and service graph
  metricsGenerator:
    registry:
      external_labels:
        source: tempo
        cluster: prod-us-east-1
    storage:
      path: /var/tempo/generator/wal
      remote_write:
        - url: http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090/api/v1/write
          send_exemplars: true
    traces_storage:
      path: /var/tempo/generator/traces
    processor:
      span_metrics:
        enable_target_info: true
        histogram_buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
        dimensions:
          - name: http.method
          - name: http.status_code
          - name: http.route
          - name: service.version
      service_graph:
        dimensions:
          - http.method
          - http.status_code
        enable_messaging_system_latency_histogram: true
        max_items: 10000

  # Global limits
  overrides:
    defaults:
      ingestion:
        rate_limit_bytes: 15000000    # 15 MiB/s per tenant
        burst_size_bytes: 20000000    # 20 MiB burst
        max_traces_per_user: 100000
      read:
        max_search_duration: 168h     # 7 days for TraceQL search
        max_bytesperspan: 5000        # 5 KB per span

# Per-component replica counts and resources

distributor:
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 1Gi
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 12
    targetCPUUtilizationPercentage: 70

ingester:
  replicas: 5
  persistence:
    enabled: true
    storageClass: gp3
    size: 50Gi                    # WAL storage per ingester
  resources:
    requests:
      cpu: 1000m
      memory: 2Gi
    limits:
      cpu: 4000m
      memory: 8Gi
  # Spread across availability zones
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app.kubernetes.io/component: ingester

querier:
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 15
    targetCPUUtilizationPercentage: 75

queryFrontend:
  replicas: 2
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 512Mi

compactor:
  replicas: 1
  persistence:
    enabled: true
    storageClass: gp3
    size: 100Gi
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 2000m
      memory: 4Gi

metricsGenerator:
  enabled: true
  replicas: 2
  persistence:
    enabled: true
    storageClass: gp3
    size: 20Gi
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi

# Gateway — routes OTLP/gRPC to distributor
gateway:
  enabled: true
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

# Prometheus monitoring
metaMonitoring:
  serviceMonitor:
    enabled: true
    namespace: monitoring
    labels:
      release: kube-prometheus-stack
  grafanaAgent:
    enabled: false     # use existing Grafana Alloy

# Memberlist for ring coordination
memberlist:
  service:
    publishNotReadyAddresses: true
```

## S3 Object Storage Configuration

### Bucket creation and lifecycle

```bash
# Create the traces bucket
aws s3api create-bucket \
  --bucket tempo-traces-prod \
  --region us-east-1

# Apply lifecycle rule to expire objects beyond retention + buffer
# Tempo compactor handles logical deletion; S3 lifecycle handles physical deletion
aws s3api put-bucket-lifecycle-configuration \
  --bucket tempo-traces-prod \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "expire-old-trace-blocks",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "Expiration": {"Days": 20}
      }
    ]
  }'

# Enable versioning off (Tempo manages its own block lifecycle)
aws s3api put-bucket-versioning \
  --bucket tempo-traces-prod \
  --versioning-configuration Status=Suspended
```

### IAM policy for Tempo

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TempoTracesBucketAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging",
        "s3:HeadBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::tempo-traces-prod",
        "arn:aws:s3:::tempo-traces-prod/*"
      ]
    }
  ]
}
```

## OpenTelemetry Collector Integration

The OpenTelemetry Collector acts as the central trace pipeline: receiving spans from instrumented services, processing them (batching, attribute enrichment, sampling), and forwarding to Tempo.

### Collector Helm deployment

```bash
helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --namespace tracing \
  --version 0.82.0 \
  --values otel-collector-values.yaml \
  --wait
```

### OpenTelemetry Collector configuration

```yaml
# otel-collector-values.yaml

mode: deployment    # use DaemonSet for host-level collection; Deployment for centralized

replicaCount: 2

resources:
  requests:
    cpu: 200m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 512Mi

config:
  receivers:
    # Receive OTLP from instrumented services
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
          cors:
            allowed_origins:
              - https://*.example.com

    # Receive Jaeger traces (for legacy services during migration)
    jaeger:
      protocols:
        thrift_http:
          endpoint: 0.0.0.0:14268
        grpc:
          endpoint: 0.0.0.0:14250

    # Receive Zipkin traces (for Spring Boot Sleuth services)
    zipkin:
      endpoint: 0.0.0.0:9411

    # Prometheus scrape receiver for exemplar collection
    prometheus:
      config:
        scrape_configs:
          - job_name: otel-collector-self
            static_configs:
              - targets: [localhost:8888]

  processors:
    # Batch spans for efficiency
    batch:
      timeout: 5s
      send_batch_size: 1000
      send_batch_max_size: 2000

    # Memory limiter to prevent OOM crashes
    memory_limiter:
      check_interval: 1s
      limit_mib: 400
      spike_limit_mib: 100

    # Enrich spans with Kubernetes metadata
    k8sattributes:
      auth_type: serviceAccount
      passthrough: false
      filter:
        node_from_env_var: KUBE_NODE_NAME
      extract:
        metadata:
          - k8s.pod.name
          - k8s.pod.uid
          - k8s.namespace.name
          - k8s.deployment.name
          - k8s.statefulset.name
          - k8s.daemonset.name
          - k8s.cronjob.name
          - k8s.job.name
          - k8s.node.name
          - k8s.container.name
        labels:
          - tag_name: app
            key: app
            from: pod
          - tag_name: version
            key: version
            from: pod
      pod_association:
        - sources:
            - from: resource_attribute
              name: k8s.pod.ip
        - sources:
            - from: connection

    # Tail-based sampling — keep 100% of errors, 10% of successful traces
    tail_sampling:
      decision_wait: 10s
      num_traces: 100000
      expected_new_traces_per_sec: 1000
      policies:
        # Always keep errors
        - name: keep-errors
          type: status_code
          status_code:
            status_codes: [ERROR, UNSET]

        # Keep slow requests (>500ms)
        - name: keep-slow-requests
          type: latency
          latency:
            threshold_ms: 500

        # Sample 10% of everything else
        - name: probabilistic-sample
          type: probabilistic
          probabilistic:
            sampling_percentage: 10

    # Add resource attributes for Tempo tenant routing
    resource:
      attributes:
        - key: deployment.environment
          value: production
          action: upsert

  exporters:
    # Export to Tempo via OTLP gRPC
    otlp/tempo:
      endpoint: tempo-distributor.tracing.svc.cluster.local:4317
      tls:
        insecure: true
      headers:
        # Multi-tenant: route to production tenant
        X-Scope-OrgID: production

    # Export metrics to Prometheus
    prometheus:
      endpoint: 0.0.0.0:8889
      resource_to_telemetry_conversion:
        enabled: true

    # Send collector telemetry to Loki
    loki:
      endpoint: http://loki-gateway.logging.svc.cluster.local/loki/api/v1/push
      default_labels_enabled:
        exporter: true
        job: true

  extensions:
    health_check:
      endpoint: 0.0.0.0:13133
    pprof:
      endpoint: 0.0.0.0:1777
    zpages:
      endpoint: 0.0.0.0:55679

  service:
    extensions: [health_check, pprof, zpages]
    pipelines:
      traces:
        receivers: [otlp, jaeger, zipkin]
        processors: [memory_limiter, k8sattributes, tail_sampling, batch]
        exporters: [otlp/tempo]
      metrics:
        receivers: [prometheus]
        processors: [memory_limiter, batch]
        exporters: [prometheus]
```

### Instrumenting a Go service with OTLP

```go
// tracer.go — initialize OpenTelemetry tracing for a Go service

package observability

import (
    "context"
    "fmt"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

// InitTracer configures the OpenTelemetry SDK with the OTLP gRPC exporter.
// It returns a shutdown function that must be called before process exit.
func InitTracer(ctx context.Context, serviceName, serviceVersion, otelEndpoint string) (func(context.Context) error, error) {
    // Create the OTLP gRPC exporter pointing to the OpenTelemetry Collector
    conn, err := grpc.DialContext(ctx, otelEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create gRPC connection to OTEL collector: %w", err)
    }

    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("failed to create OTLP trace exporter: %w", err)
    }

    // Resource describes this service instance
    res := resource.NewWithAttributes(
        semconv.SchemaURL,
        semconv.ServiceName(serviceName),
        semconv.ServiceVersion(serviceVersion),
        attribute.String("deployment.environment", "production"),
    )

    // BatchSpanProcessor sends spans in batches for efficiency
    bsp := sdktrace.NewBatchSpanProcessor(exporter,
        sdktrace.WithMaxQueueSize(4096),
        sdktrace.WithMaxExportBatchSize(512),
        sdktrace.WithBatchTimeout(5000),  // 5 seconds
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1))),
        sdktrace.WithResource(res),
        sdktrace.WithSpanProcessor(bsp),
    )

    // Register as the global tracer provider
    otel.SetTracerProvider(tp)

    // Register W3C trace context and baggage propagators
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp.Shutdown, nil
}
```

## TraceQL Query Language

TraceQL is Tempo's trace query language. It evaluates structural and attribute conditions against trace spans.

### Basic span filters

```
# Find all traces with an HTTP 500 response
{ span.http.status_code = 500 }

# Find slow database queries (over 200ms)
{ .db.system = "postgresql" && duration > 200ms }

# Find all error spans in a specific service
{ resource.service.name = "api-server" && status = error }

# Find traces that hit the payments endpoint
{ span.http.route = "/api/v1/payments" }

# Find spans from a specific Kubernetes pod
{ resource.k8s.pod.name =~ "api-server-.*" && status = error }
```

### Structural operators

```
# Find traces where the root span failed but child spans succeeded
{ rootSpan.status = error }

# Find a trace containing a specific span followed by a database call
# (structural: span A is an ancestor of span B)
{ .http.method = "POST" } >> { .db.system = "postgresql" }

# Find traces where the API call makes a downstream gRPC call
{ resource.service.name = "api-server" } > { resource.service.name = "user-service" }

# Find traces with any span exceeding 1 second
{ duration > 1s }

# Find traces where the root span is slow but a child database span is fast
# (the bottleneck is in application code, not DB)
{ rootSpan.duration > 2s } && not { .db.system != "" && duration > 1s }
```

### Aggregate functions

```
# Count traces per HTTP status code
count_over_time({ span.http.status_code != 200 }[1h]) by (span.http.status_code)

# Find the 10 slowest traces in the last hour
select(rootSpan.duration)
| { rootSpan.duration > 500ms }
| sort(desc)
| limit(10)

# Rate of error traces per service
rate({ status = error }[5m]) by (resource.service.name)

# P99 trace duration per service
quantile_over_time(0.99, { rootSpan.duration }[5m]) by (resource.service.name)

# Histogram of span durations for a specific operation
histogram_over_time({ .db.operation = "SELECT" && duration }[1h])
```

### LogCLI-style TraceQL queries via Tempo API

```bash
# Search for traces using the Tempo HTTP API
curl -G \
  -H "X-Scope-OrgID: production" \
  "http://tempo-query-frontend.tracing.svc.cluster.local:3200/api/search" \
  --data-urlencode 'q={ resource.service.name = "api-server" && status = error }' \
  --data-urlencode 'start=1710000000' \
  --data-urlencode 'end=1710086400' \
  --data-urlencode 'limit=50' | jq '.traces[] | {traceID, rootTraceName, durationMs: .durationMs}'

# Fetch a specific trace by ID
curl \
  -H "X-Scope-OrgID: production" \
  "http://tempo-query-frontend.tracing.svc.cluster.local:3200/api/traces/abcdef1234567890abcdef1234567890" | \
  jq '.batches[].scopeSpans[].spans[] | {name: .name, duration: .endTimeUnixNano}'
```

## Exemplars Linking Metrics to Traces

Exemplars embed trace IDs into Prometheus metrics histograms, enabling the Grafana workflow of clicking a point on a latency histogram and jumping directly to the matching trace.

### Enabling exemplars in application code (Go)

```go
// exemplar-histogram.go — emit Prometheus histogram with trace exemplar

package metrics

import (
    "context"
    "net/http"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.opentelemetry.io/otel/trace"
)

var httpDuration = prometheus.NewHistogramVec(
    prometheus.HistogramOpts{
        Name:    "http_request_duration_seconds",
        Help:    "HTTP request duration in seconds",
        Buckets: prometheus.DefBuckets,
    },
    []string{"method", "path", "status_code"},
)

// RecordRequest records an HTTP request with an exemplar linking to the active trace.
func RecordRequest(ctx context.Context, method, path, statusCode string, duration float64) {
    // Extract trace context from span
    span := trace.SpanFromContext(ctx)
    traceID := span.SpanContext().TraceID().String()

    // Emit histogram observation with trace exemplar
    httpDuration.WithLabelValues(method, path, statusCode).(prometheus.ExemplarObserver).
        ObserveWithExemplar(duration, prometheus.Labels{
            "traceID": traceID,    // Grafana uses this to link to Tempo
        })
}

// Handler wraps the default Prometheus handler with exemplar support
func MetricsHandler() http.Handler {
    return promhttp.HandlerFor(
        prometheus.DefaultGatherer,
        promhttp.HandlerOpts{
            EnableOpenMetrics: true,   // required for exemplar serialization
        },
    )
}
```

### Grafana data source configuration for exemplars

```yaml
# grafana-datasources.yaml — Grafana data source with Tempo exemplar link
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  datasources.yaml: |
    apiVersion: 1
    datasources:
      - name: Prometheus
        type: prometheus
        url: http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090
        isDefault: true
        jsonData:
          exemplarTraceIdDestinations:
            - name: traceID
              datasourceUid: tempo-prod
              urlDisplayLabel: "View trace in Tempo"

      - name: Tempo
        type: tempo
        uid: tempo-prod
        url: http://tempo-query-frontend.tracing.svc.cluster.local:3200
        jsonData:
          httpMethod: GET
          serviceMap:
            datasourceUid: prometheus-prod
          nodeGraph:
            enabled: true
          lokiSearch:
            datasourceUid: loki-prod
          traceQuery:
            timeShiftEnabled: true
            spanStartTimeShift: "-1h"
            spanEndTimeShift: "1h"
          spanBar:
            type: Tag
            tag: http.path
          tracesToLogs:
            datasourceUid: loki-prod
            mapTagNamesEnabled: true
            mappedTags:
              - key: k8s.pod.name
                value: pod
              - key: k8s.namespace.name
                value: namespace
            filterByTraceID: true
            filterBySpanID: false
          tracesToMetrics:
            datasourceUid: prometheus-prod
            queries:
              - name: "Request rate"
                query: "rate(traces_spanmetrics_calls_total{$$__tags}[5m])"
              - name: "Error rate"
                query: "rate(traces_spanmetrics_calls_total{$$__tags, status_code=\"STATUS_CODE_ERROR\"}[5m])"
              - name: "P95 latency"
                query: "histogram_quantile(0.95, sum(rate(traces_spanmetrics_duration_seconds_bucket{$$__tags}[5m])) by (le))"

      - name: Loki
        type: loki
        uid: loki-prod
        url: http://loki-gateway.logging.svc.cluster.local
        jsonData:
          maxLines: 1000
          derivedFields:
            - name: traceID
              matcherRegex: '"traceID":"(\w+)"'
              url: "$${__value.raw}"
              datasourceUid: tempo-prod
              urlDisplayLabel: "View trace in Tempo"
```

## Span Metrics Pipeline

The metrics generator processes spans in real-time and emits Prometheus metrics for RED (Rate, Errors, Duration) signal generation without requiring PromQL recording rules.

### Span metrics emitted by Tempo

```promql
# Total request rate per service (from span metrics)
sum(rate(traces_spanmetrics_calls_total{service_name="api-server"}[5m]))

# Error rate per service
sum(rate(traces_spanmetrics_calls_total{
  service_name="api-server",
  status_code="STATUS_CODE_ERROR"
}[5m]))
/
sum(rate(traces_spanmetrics_calls_total{service_name="api-server"}[5m]))

# P99 latency from span histogram
histogram_quantile(0.99,
  sum(rate(traces_spanmetrics_duration_seconds_bucket{service_name="api-server"}[5m]))
  by (le, span_name)
)

# Service graph edge latency (server-side)
histogram_quantile(0.95,
  sum(rate(traces_service_graph_request_server_seconds_bucket{
    server="user-service"
  }[5m])) by (le)
)
```

### Alerting rules using span metrics

```yaml
# tempo-span-metrics-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tempo-span-metrics-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: service-red-metrics
      interval: 30s
      rules:
        # Alert when service error rate exceeds 5%
        - alert: ServiceHighErrorRate
          expr: |
            (
              sum by (service_name) (
                rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m])
              )
              /
              sum by (service_name) (
                rate(traces_spanmetrics_calls_total{}[5m])
              )
            ) > 0.05
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High error rate for service {{ $labels.service_name }}"
            description: "Error rate is {{ $value | humanizePercentage }} for {{ $labels.service_name }}"

        # Alert on P99 latency regression
        - alert: ServiceHighLatency
          expr: |
            histogram_quantile(0.99,
              sum by (service_name, le) (
                rate(traces_spanmetrics_duration_seconds_bucket{}[5m])
              )
            ) > 1.0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "P99 latency for {{ $labels.service_name }} exceeds 1 second"
            description: "P99 latency is {{ $value | humanizeDuration }} for {{ $labels.service_name }}"
```

## Service Graph Generation

The service graph processor produces Prometheus metrics representing the call graph topology.

```promql
# Visualize service graph in Grafana (node graph panel)
# Nodes: services with their request/error rates
# Edges: service-to-service call rates

# Service node metric — total request rate per service
sum by (client, server) (
  rate(traces_service_graph_request_total[5m])
)

# Failed edges — failed service-to-service calls
sum by (client, server) (
  rate(traces_service_graph_request_failed_total[5m])
)

# P95 latency per service edge
histogram_quantile(0.95,
  sum by (client, server, le) (
    rate(traces_service_graph_request_server_seconds_bucket[5m])
  )
)
```

## Trace-Log Correlation with Loki

When logs include the trace ID (a common pattern with OpenTelemetry SDK log instrumentation), Grafana can navigate from a trace span directly to the correlated logs in Loki.

### Structuring logs with trace context (Go)

```go
// log-with-trace.go — add trace ID to structured log entries

package observability

import (
    "context"

    "go.opentelemetry.io/otel/trace"
    "go.uber.org/zap"
)

// LoggerFromContext returns a zap.Logger enriched with the active trace context.
// The traceID and spanID fields are used by Grafana's Loki data source to
// navigate from traces to the correlated log lines.
func LoggerFromContext(ctx context.Context, base *zap.Logger) *zap.Logger {
    span := trace.SpanFromContext(ctx)
    if !span.SpanContext().IsValid() {
        return base
    }

    return base.With(
        zap.String("traceID", span.SpanContext().TraceID().String()),
        zap.String("spanID", span.SpanContext().SpanID().String()),
        zap.Bool("traceSampled", span.SpanContext().IsSampled()),
    )
}
```

## Multi-Tenant Configuration

```yaml
# Per-tenant overrides — applied via Tempo runtime config
overrides:
  # Production tenant: higher limits, longer search window
  production:
    ingestion:
      rate_limit_bytes: 30000000       # 30 MiB/s
      burst_size_bytes: 50000000       # 50 MiB burst
      max_traces_per_user: 500000
    read:
      max_search_duration: 720h        # 30 days
      max_bytes_per_tag_values_query: 50000000
    compaction:
      block_retention: 2160h           # 90 days

  # Development tenant: lower limits, shorter retention
  development:
    ingestion:
      rate_limit_bytes: 5000000        # 5 MiB/s
      burst_size_bytes: 10000000
      max_traces_per_user: 50000
    read:
      max_search_duration: 168h        # 7 days
    compaction:
      block_retention: 336h            # 14 days

  # Security audit tenant: long retention, conservative limits
  audit:
    ingestion:
      rate_limit_bytes: 10000000       # 10 MiB/s
      burst_size_bytes: 15000000
      max_traces_per_user: 200000
    read:
      max_search_duration: 8760h       # 365 days
    compaction:
      block_retention: 8760h           # 365 days
```

## Prometheus Metrics for Tempo Health

### Key metrics

| Metric | Type | Description |
|---|---|---|
| `tempo_distributor_spans_received_total` | Counter | Spans received per tenant |
| `tempo_ingester_traces_created_total` | Counter | New traces opened |
| `tempo_ingester_blocks_flushed_total` | Counter | Blocks written to object storage |
| `tempo_ingester_flush_duration_seconds` | Histogram | Block flush latency |
| `tempo_querier_search_duration_seconds` | Histogram | Query execution time |
| `tempo_compactor_compaction_duration_seconds` | Histogram | Compaction operation duration |
| `tempo_compactor_deleted_blocks_total` | Counter | Blocks deleted by retention |
| `tempodb_blocklist_length` | Gauge | Number of blocks in object store |
| `tempo_request_duration_seconds` | Histogram | API request latency |

### Prometheus alerting rules for Tempo

```yaml
# tempo-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tempo-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: tempo-health
      interval: 30s
      rules:
        # Alert when ingester flush failures are occurring
        - alert: TempoIngesterFlushFailures
          expr: |
            rate(tempo_ingester_flush_duration_seconds_count{status="error"}[5m]) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Tempo ingester failing to flush blocks to S3"
            description: "Ingester {{ $labels.pod }} has been failing block flushes for 5 minutes. Traces may be lost if ingesters are restarted."

        # Alert when distributor is rate-limiting traces
        - alert: TempoDistributorRateLimiting
          expr: |
            rate(tempo_distributor_spans_received_total{status="rate_limited"}[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Tempo distributor is rate-limiting spans for tenant {{ $labels.tenant }}"
            description: "Increase ingestion_rate_limit_bytes in the tenant overrides for {{ $labels.tenant }}"

        # Alert when query latency is high
        - alert: TempoQueryHighLatency
          expr: |
            histogram_quantile(0.95,
              sum(rate(tempo_querier_search_duration_seconds_bucket[5m])) by (le)
            ) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Tempo P95 query latency exceeds 10 seconds"
            description: "Consider adding querier replicas or reducing max_search_duration"

        # Alert when block list is very large (compactor may be stalled)
        - alert: TempoBlockListGrowth
          expr: |
            increase(tempodb_blocklist_length[1h]) > 1000
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Tempo block list grew by more than 1000 blocks in 1 hour"
            description: "Compactor may not be keeping up with ingester flush rate. Check compactor logs."

        # Alert when compactor has not run in 2 hours
        - alert: TempoCompactorStalled
          expr: |
            time() - tempo_compactor_last_successful_run_timestamp_seconds > 7200
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Tempo compactor has not completed a run in 2 hours"
            description: "Check compactor pod status in the tracing namespace."
```

## Operational Runbook

### Checking distributor ring health

```bash
# Check distributor ring status
kubectl exec -n tracing \
  $(kubectl get pod -n tracing -l app.kubernetes.io/component=distributor -o name | head -1) \
  -- wget -qO- http://localhost:3200/distributor/ring | \
  python3 -m json.tool | jq '.shards | map(select(.state != "ACTIVE")) | length'

# View span ingest rate
kubectl exec -n tracing \
  $(kubectl get pod -n tracing -l app.kubernetes.io/component=distributor -o name | head -1) \
  -- wget -qO- http://localhost:3200/metrics | \
  grep tempo_distributor_spans_received_total
```

### Diagnosing missing traces

```bash
# Verify OTEL Collector is forwarding to Tempo
kubectl logs -n tracing \
  -l app.kubernetes.io/name=opentelemetry-collector \
  --since=15m | grep -i "error\|warn\|failed\|refused"

# Check Tempo distributor for rejected spans
kubectl logs -n tracing \
  -l app.kubernetes.io/component=distributor \
  --since=15m | grep -i "error\|rate_limited\|rejected"

# Verify ingester ring has enough members
kubectl exec -n tracing \
  $(kubectl get pod -n tracing -l app.kubernetes.io/component=ingester -o name | head -1) \
  -- wget -qO- http://localhost:3200/ring | \
  jq '.shards | map({id: .id, state: .state, tokens: (.tokens | length)})'
```

### Querying Tempo from the command line

```bash
# Install tempo-cli
curl -L "https://github.com/grafana/tempo/releases/download/v2.6.0/tempo_2.6.0_linux_amd64.tar.gz" | \
  tar -xz -C /usr/local/bin tempo-query

# Search for recent error traces
curl -G \
  -H "X-Scope-OrgID: production" \
  "http://localhost:3200/api/search" \
  --data-urlencode 'q={ status = error }' \
  --data-urlencode 'start=1710000000' \
  --data-urlencode 'limit=20' | jq .

# Get a specific trace
curl \
  -H "X-Scope-OrgID: production" \
  "http://localhost:3200/api/traces/00000000000000000000000000000001" | jq .
```

## Summary

Grafana Tempo provides cost-effective distributed tracing at scale through object storage backends, with deep Grafana integration enabling the full observability loop across traces, metrics, and logs. The key production decisions are:

1. Deploy the metrics generator with both `span_metrics` and `service_graph` processors enabled — these eliminate the need for manual RED metric instrumentation in application code
2. Configure exemplars in Prometheus histograms to enable the one-click navigation from latency alert to trace
3. Use tail-based sampling in the OpenTelemetry Collector (not head-based in the application SDK) to ensure 100% of error traces and slow requests are retained regardless of the overall sampling rate
4. Size ingesters with adequate WAL storage: at least 60 minutes of ingestion at peak trace volume to survive S3 availability events
5. Monitor `tempodb_blocklist_length` growth rate — a stalled compactor leads to exponential query latency as the querier must open more and more small blocks per query
6. Set per-tenant `block_retention` overrides aligned with data classification requirements — default to 14 days for development tenants and 90 days for production, with audit tenants retaining 1 year
