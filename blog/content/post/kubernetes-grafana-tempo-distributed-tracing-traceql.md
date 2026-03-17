---
title: "Kubernetes Grafana Tempo: Distributed Tracing Storage and TraceQL Queries"
date: 2031-04-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Grafana", "Tempo", "Distributed Tracing", "OpenTelemetry", "TraceQL"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Grafana Tempo on Kubernetes: architecture components, object storage backends, TraceQL query language for trace analysis, service graph metrics, Grafana datasource integration, and migrating from Jaeger to Tempo."
more_link: "yes"
url: "/kubernetes-grafana-tempo-distributed-tracing-traceql/"
---

Distributed tracing is the observability pillar most teams implement last and regret not implementing first. When a request traverses fifteen microservices and something goes wrong, logs tell you what happened on each individual service, metrics tell you aggregate behavior changed, but only traces tell you which service in the chain caused the latency spike and exactly what path the failing request took. Grafana Tempo has become the dominant open-source tracing backend in Kubernetes environments — primarily because it decouples trace storage from query cost by storing traces in object storage (S3, GCS, Azure Blob) rather than keeping them in a purpose-built database.

This guide covers Tempo's architecture in production depth, the configuration of all major components (distributor, ingester, compactor, querier), object storage backend setup, the TraceQL query language for surgical trace analysis, service graph generation for RED metrics, Grafana datasource integration, and a complete migration path from Jaeger.

<!--more-->

# Kubernetes Grafana Tempo: Distributed Tracing Storage and TraceQL Queries

## Section 1: Tempo Architecture

### Component Overview

Tempo follows the same read/write path separation pattern as Thanos and Cortex. Writes go through ingesters to object storage; reads are served directly from object storage by queriers with a cache layer.

**Distributor** — the write path entry point. Receives spans via OTLP, Jaeger, Zipkin, or Kafka. Hashes the trace ID and routes spans to the correct ingester(s) using consistent hashing. Distributes load across multiple ingesters.

**Ingester** — buffers spans in memory and periodically flushes them to object storage as blocks. Each trace is associated with a tenant ID (for multi-tenancy) and a time window. The ingester maintains an in-memory index mapping trace IDs to block locations.

**Compactor** — runs as a separate process that merges small blocks into larger ones, runs retention policies, and updates the backend index. Reduces object storage API costs and improves query performance by reducing the number of objects that must be scanned.

**Querier** — handles search and trace-by-ID requests. Queries both the ingesters (for recent data not yet flushed to object storage) and the object storage backend. Uses the block index to locate which blocks contain a given trace ID.

**Query Frontend** — optional component that shards long-range queries across multiple queriers for parallelism.

**Metrics Generator** — generates Prometheus metrics from span data. Produces RED (Rate, Error, Duration) metrics and service graph metrics showing inter-service dependencies.

### Data Flow

```
Application → OTLP/Jaeger/Zipkin
               ↓
         Distributor
         (consistent hash on trace ID)
               ↓
         Ingester(s)
         (buffer in memory, periodic flush)
               ↓
        Object Storage (S3/GCS)
         (blocks of trace data)
               ↑
          Querier
     (query blocks + ingesters)
               ↑
       Query Frontend
     (optional shard queries)
               ↑
           Grafana
         (TraceQL)
```

### Block Format

Tempo stores traces in "blocks" on object storage. Each block contains:

- **traces/** — Parquet files containing the actual span data (Tempo 2.0+ uses Parquet; older versions use a custom columnar format).
- **index.json** — bloom filter index of trace IDs in this block.
- **meta.json** — block metadata (time range, tenant, bloom filter size).
- **bloom/** — bloom filter files used to quickly determine if a trace ID might be in a block without reading the trace data.

## Section 2: Deploying Tempo on Kubernetes

### Using the Tempo Helm Chart

```bash
# Add the Grafana Helm repository
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# Create namespace
kubectl create namespace monitoring
```

### Production values.yaml for Tempo (Distributed Mode)

```yaml
# tempo-distributed-values.yaml
tempo-distributed:
  # Global configuration
  global:
    clusterDomain: cluster.local

  # Object storage backend — S3
  storage:
    trace:
      backend: s3
      s3:
        bucket: my-tempo-traces
        endpoint: s3.us-east-1.amazonaws.com
        region: us-east-1
        # Use IRSA (IAM Roles for Service Accounts) — no static credentials
        # The service account is annotated with the IAM role ARN
        insecure: false
      # Alternatively, for local development, use MinIO:
      # backend: s3
      # s3:
      #   bucket: tempo
      #   endpoint: minio.minio.svc.cluster.local:9000
      #   access_key: tempo
      #   secret_key: <minio-secret-key>
      #   insecure: true

  # Distributor configuration
  distributor:
    replicas: 3
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi
    config:
      log_received_spans:
        enabled: false  # Enable for debugging only — high cardinality
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
        zipkin:
          endpoint: 0.0.0.0:9411

  # Ingester configuration
  ingester:
    replicas: 3
    # Use StatefulSet for stable pod identity
    kind: StatefulSet
    persistence:
      # Local storage for WAL (Write-Ahead Log) — improves durability
      enabled: true
      storageClass: fast-local
      size: 50Gi
    resources:
      requests:
        cpu: 1000m
        memory: 4Gi
      limits:
        cpu: 4000m
        memory: 8Gi
    config:
      max_block_duration: 30m
      max_block_bytes: 524288000  # 500MB
      replication_factor: 3
      lifecycler:
        ring:
          kvstore:
            store: memberlist
          replication_factor: 3
        join_after: 0s
        min_readiness_duration: 10s
        final_sleep: 30s

  # Compactor configuration
  compactor:
    replicas: 1
    resources:
      requests:
        cpu: 500m
        memory: 2Gi
      limits:
        cpu: 2000m
        memory: 4Gi
    config:
      compaction:
        block_retention: 336h  # 14 days
        compacted_block_retention: 1h
        max_compaction_objects: 6000000
        max_block_bytes: 107374182400  # 100GB
        retention_concurrency: 10

  # Querier configuration
  querier:
    replicas: 3
    resources:
      requests:
        cpu: 1000m
        memory: 2Gi
      limits:
        cpu: 4000m
        memory: 4Gi
    config:
      frontend_worker:
        grpc_client_config:
          max_recv_msg_size: 104857600  # 100MB
      search:
        prefer_self: 10

  # Query Frontend
  queryFrontend:
    replicas: 2
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi

  # Metrics Generator — generates Prometheus metrics from spans
  metricsGenerator:
    enabled: true
    replicas: 1
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: 2000m
        memory: 2Gi
    config:
      registry:
        stale_duration: 15m
        collection_interval: 15s
      storage:
        path: /var/tempo/wal
        wal: {}
        remote_write:
        - url: http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/write
          send_exemplars: true
          headers:
            X-Scope-OrgID: "1"
      processors:
        service_graphs:
          histogram_buckets: [0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8]
          dimensions:
          - http.method
          - http.status_code
          - http.url
          enable_virtual_node_label: true
        span_metrics:
          histogram_buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
          dimensions:
          - service.name
          - service.version
          - http.method
          - http.status_code
          - db.system
          - rpc.method
          intrinsic_dimensions:
            service: true
            span_name: true
            span_kind: true
            status_code: true
            status_message: false

  # Global overrides
  global_overrides:
    defaults:
      metrics_generator:
        processors:
        - service-graphs
        - span-metrics
      ingestion:
        rate_strategy: local
        rate_limit_bytes: 15000000  # 15MB/s per distributor
        burst_size_bytes: 20000000  # 20MB burst

  # Memberlist for ring membership
  memberlist:
    service:
      publishNotReadyAddresses: true

  # Cache configuration using Memcached
  memcached:
    enabled: true
    replicaCount: 3
    resources:
      requests:
        cpu: 500m
        memory: 2Gi
      limits:
        cpu: 1000m
        memory: 4Gi

  # ServiceAccount with IRSA annotation for S3 access
  serviceAccount:
    create: true
    name: tempo
    annotations:
      eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/tempo-s3-role"
```

```bash
# Deploy Tempo
helm install tempo grafana/tempo-distributed \
  --namespace monitoring \
  --values tempo-distributed-values.yaml \
  --version 1.7.0

# Verify all components are running
kubectl -n monitoring get pods -l app.kubernetes.io/name=tempo-distributed
```

### IAM Policy for S3 Access (IRSA)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketVersioning"
      ],
      "Resource": [
        "arn:aws:s3:::my-tempo-traces",
        "arn:aws:s3:::my-tempo-traces/*"
      ]
    }
  ]
}
```

## Section 3: Configuring OpenTelemetry Collection

### OpenTelemetry Collector as Trace Aggregator

A central OTel Collector receives spans from applications and forwards them to Tempo. This provides buffering, sampling, and attribute enrichment:

```yaml
# otelcollector-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: monitoring
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
      jaeger:
        protocols:
          grpc:
            endpoint: 0.0.0.0:14250
          thrift_http:
            endpoint: 0.0.0.0:14268
          thrift_compact:
            endpoint: 0.0.0.0:6831
      zipkin:
        endpoint: 0.0.0.0:9411

    processors:
      # Batch spans for efficiency
      batch:
        send_batch_size: 8192
        send_batch_max_size: 16384
        timeout: 5s

      # Memory limit to prevent OOM
      memory_limiter:
        check_interval: 1s
        limit_mib: 1500
        spike_limit_mib: 300

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
          labels:
          - tag_name: app.label.team
            key: team
            from: pod
          - tag_name: app.label.version
            key: version
            from: pod
          annotations:
          - tag_name: app.annotation.owner
            key: owner
            from: pod

      # Probabilistic sampling — keep 10% of traces
      # Use tail-based sampling for production
      probabilistic_sampler:
        sampling_percentage: 10

      # Resource detection — add cloud and host attributes
      resourcedetection:
        detectors: [eks, ec2, env]
        timeout: 5s
        override: false

      # Add custom attributes
      attributes:
        actions:
        - key: deployment.environment
          value: production
          action: upsert
        - key: service.cluster
          value: eks-production-us-east-1
          action: upsert

    exporters:
      # Export to Tempo
      otlp/tempo:
        endpoint: tempo-distributor.monitoring.svc.cluster.local:4317
        tls:
          insecure: true
        headers:
          X-Scope-OrgID: "1"

      # Debug logging (disable in production)
      # logging:
      #   verbosity: detailed

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
          processors: [memory_limiter, k8sattributes, resourcedetection, attributes, batch]
          exporters: [otlp/tempo]
      telemetry:
        logs:
          level: info
        metrics:
          level: detailed
          address: 0.0.0.0:8888
```

### Tail-Based Sampling for Production

Probabilistic sampling misses rare but important traces (like errors). Tail-based sampling makes the decision after the full trace is assembled:

```yaml
processors:
  tail_sampling:
    decision_wait: 30s
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

    # Keep 10% of healthy traces
    - name: probabilistic-policy
      type: probabilistic
      probabilistic:
        sampling_percentage: 10

    # Always keep traces from specific services
    - name: payment-service-policy
      type: string_attribute
      string_attribute:
        key: service.name
        values: [payment-service, fraud-detection]
        enabled_regex_matching: false
        invert_match: false
```

## Section 4: TraceQL Query Language

TraceQL is Tempo's purpose-built query language for trace data. It uses a pipeline syntax similar to LogQL and PromQL.

### Basic TraceQL Syntax

```traceql
# Find all traces from a specific service
{ .service.name = "frontend" }

# Find spans with a specific operation
{ .http.url =~ "/api/v1/orders.*" }

# Find error spans
{ status = error }

# Find spans slower than 500ms
{ duration > 500ms }

# Combine conditions with &&
{ .service.name = "payment-service" && status = error }

# Find traces containing any span from payment-service that errored
{ .service.name = "payment-service" && .http.status_code = 500 }
```

### Span Selectors and Attributes

Attributes in TraceQL are referenced with a `.` prefix:

```traceql
# Standard OpenTelemetry attributes
{ .http.method = "POST" }
{ .http.status_code >= 400 }
{ .db.system = "postgresql" }
{ .rpc.method = "GetUser" }
{ .messaging.system = "kafka" }

# Custom attributes (from your instrumentation)
{ .user.id = "user-123" }
{ .order.id = "ord-456" }
{ .tenant.id = "acme-corp" }

# Resource attributes (about the service/pod, not the span)
{ resource.k8s.pod.name =~ "frontend-.*" }
{ resource.k8s.namespace.name = "production" }
{ resource.service.version = "v2.1.0" }
```

### Pipeline Operations

TraceQL supports pipeline operators to aggregate and filter results:

```traceql
# Count spans per service
{ } | count() by(.service.name)

# Average duration per endpoint
{ .http.url != "" } | avg(duration) by(.http.url, .service.name)

# Find the 99th percentile duration for each service
{ } | quantile_over_time(duration, 0.99) by(.service.name)

# Count error rate per service
{ status = error } | count() by(.service.name)

# Find spans with the highest duration
{ .service.name = "api-gateway" } | max(duration)

# Rate of operations per second
{ .service.name = "order-service" } | rate()
```

### Trace-Level vs Span-Level Queries

TraceQL can query at both the span level and the trace level using structural operators:

```traceql
# Find traces where a specific span is an ancestor of another
# (trace contains a frontend span that has a descendant database span with errors)
{ .service.name = "frontend" } >> { .db.system = "postgresql" && status = error }

# Find traces where spans are in a parent-child relationship
{ .service.name = "frontend" } > { .service.name = "backend" }

# Find traces containing a span from payment AND a span from fraud-detection
{ .service.name = "payment-service" } && { .service.name = "fraud-detection" }

# Find all traces that pass through a specific service
{ .service.name = "api-gateway" }

# Find traces containing error spans in the payment service
# followed by retry attempts
{ .service.name = "payment-service" && status = error }
  >> { .service.name = "payment-service" && .http.url =~ ".*/retry.*" }
```

### Practical TraceQL Examples

```traceql
# 1. Find all slow database queries
{ .db.system != "" && duration > 1s }

# 2. Find traces with HTTP 503 responses in production
{ .http.status_code = 503 && resource.deployment.environment = "production" }

# 3. Find N+1 query patterns (trace with many DB calls)
{ .db.system = "postgresql" } | count() > 10

# 4. Find traces with checkout failures for a specific user
{ .service.name = "checkout" && .user.id = "user-789" && status = error }

# 5. Analyze Kafka consumer lag by finding slow message processing
{ .messaging.system = "kafka" && .messaging.operation = "receive" && duration > 500ms }

# 6. Find cross-datacenter calls (high latency due to geography)
{ resource.cloud.region != "" }
  && { resource.cloud.region != "" }
  | avg(duration) by(resource.cloud.region)

# 7. Find traces where the root span errored
{ rootName = "GET /api/checkout" && rootStatus = error }

# 8. Find authentication failures
{ .service.name = "auth-service" && .http.status_code = 401 }

# 9. Find slow traces from a specific Kubernetes namespace
{ resource.k8s.namespace.name = "payment" && duration > 2s }

# 10. Service graph: calls between frontend and specific backends
{ .service.name = "frontend" } >> { .service.name =~ "payment|inventory|shipping" }
```

### TraceQL for SLO Monitoring

```traceql
# Count of traces where p99 latency exceeded SLO (500ms for checkout)
{ rootName = "POST /api/checkout" && duration > 500ms } | count()

# Error rate for the last hour (combine with Prometheus for alerting)
{ .service.name = "order-service" && status = error } | rate()

# Successful vs failed checkout ratio
{ rootName = "POST /api/checkout" } | count() by(status)
```

## Section 5: Service Graph Metrics

The Metrics Generator component produces Prometheus metrics from span data. These metrics power service topology maps in Grafana.

### Generated Metrics

When the `service_graphs` processor is enabled, Tempo generates:

```promql
# Request rate between services (calls per second)
traces_service_graph_request_total{
  client="frontend",
  server="payment-service",
  connection_type="virtual_node"
}

# Error rate between services
traces_service_graph_request_failed_total{
  client="frontend",
  server="payment-service"
}

# Latency histogram between services
traces_service_graph_request_server_seconds_bucket{
  client="frontend",
  server="payment-service",
  le="0.1"
}
```

### Grafana Service Graph Panel

Configure the Grafana Tempo datasource to enable the service graph panel:

```yaml
# grafana-datasource-tempo.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  tempo.yaml: |
    apiVersion: 1
    datasources:
    - name: Tempo
      type: tempo
      uid: tempo
      access: proxy
      url: http://tempo-query-frontend.monitoring.svc.cluster.local:3100
      version: 1
      editable: false
      jsonData:
        tracesToLogsV2:
          datasourceUid: loki
          spanStartTimeShift: '-1h'
          spanEndTimeShift: '1h'
          tags:
          - key: service.name
            value: service
          - key: k8s.pod.name
            value: pod
          filterByTraceID: true
          filterBySpanID: false
        tracesToMetrics:
          datasourceUid: prometheus
          spanStartTimeShift: '-1h'
          spanEndTimeShift: '1h'
          tags:
          - key: service.name
            value: service
          queries:
          - name: Request rate
            query: 'rate(traces_spanmetrics_calls_total{$$__tags}[5m])'
          - name: Error rate
            query: 'rate(traces_spanmetrics_calls_total{$$__tags, status_code="STATUS_CODE_ERROR"}[5m])'
          - name: P99 latency
            query: 'histogram_quantile(0.99, sum(rate(traces_spanmetrics_duration_seconds_bucket{$$__tags}[5m])) by (le))'
        serviceMap:
          datasourceUid: prometheus
          httpNamespace: traces_service_graph
        search:
          hide: false
        nodeGraph:
          enabled: true
        spanBar:
          type: Tag
          tag: http.url
        lokiSearch:
          datasourceUid: loki
```

### RED Metrics from Span Metrics

The `span_metrics` processor generates per-operation metrics:

```promql
# Rate of HTTP requests per service and method
sum(rate(traces_spanmetrics_calls_total{
  service="api-gateway",
  span_name=~"HTTP.*"
}[5m])) by (service, span_name, status_code)

# P99 latency by service
histogram_quantile(0.99,
  sum(rate(traces_spanmetrics_duration_seconds_bucket{
    service=~".*"
  }[5m])) by (service, span_name, le)
)

# Error rate by service
sum(rate(traces_spanmetrics_calls_total{
  status_code="STATUS_CODE_ERROR"
}[5m])) by (service)
/
sum(rate(traces_spanmetrics_calls_total{}[5m])) by (service)
```

## Section 6: Grafana Integration

### Exploring Traces in Grafana

In Grafana Explore with the Tempo datasource:

1. **Search by Service/Operation** — Use the Search tab to filter traces by service name, span name, status, and duration range.

2. **TraceQL Editor** — Write TraceQL queries directly in the Query Editor tab.

3. **Trace by ID** — Enter a specific trace ID to retrieve and visualize the complete trace.

4. **Logs to Traces Correlation** — When viewing Loki logs, click the trace ID to jump to the corresponding trace in Tempo.

### Creating Trace-Aware Dashboards

```json
{
  "type": "timeseries",
  "title": "Service Error Rate with Trace Links",
  "targets": [
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "expr": "sum(rate(traces_spanmetrics_calls_total{status_code=\"STATUS_CODE_ERROR\"}[5m])) by (service)",
      "legendFormat": "{{service}}"
    }
  ],
  "links": [
    {
      "title": "View error traces in Tempo",
      "url": "/explore?left={\"datasource\":\"tempo\",\"queries\":[{\"queryType\":\"traceql\",\"query\":\"{.service.name=\\\"${__field.labels.service}\\\" && status=error}\"}]}"
    }
  ]
}
```

### Alert on Trace-Derived Metrics

```yaml
# prometheusrule-tracing-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tempo-derived-alerts
  namespace: monitoring
spec:
  groups:
  - name: tracing.slo
    rules:
    - alert: ServiceHighErrorRate
      expr: |
        (
          sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m]))
          by (service)
        ) /
        (
          sum(rate(traces_spanmetrics_calls_total{}[5m]))
          by (service)
        ) > 0.01
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High error rate for service {{ $labels.service }}"
        description: "Service {{ $labels.service }} has error rate {{ $value | humanizePercentage }} (>1%)"
        runbook: "https://runbooks.support.tools/service-error-rate"
        trace_query: '{ .service.name="{{ $labels.service }}" && status=error }'

    - alert: ServiceHighLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(traces_spanmetrics_duration_seconds_bucket{}[5m]))
          by (service, le)
        ) > 2
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High P99 latency for service {{ $labels.service }}"
        description: "P99 latency for {{ $labels.service }} is {{ $value | humanizeDuration }}"
        trace_query: '{ .service.name="{{ $labels.service }}" && duration > 2s }'
```

## Section 7: Migrating from Jaeger to Tempo

### Why Migrate?

Jaeger uses Cassandra or Elasticsearch as its backend — databases that require significant operational overhead and struggle with retention at scale. Tempo's object storage backend eliminates this: S3 storage costs roughly $0.023/GB/month, making 90-day retention of millions of traces economically viable.

### Migration Strategy: Dual-Write Phase

Run Jaeger and Tempo in parallel during the transition:

```yaml
# otel-collector-dual-write.yaml
# Add to the existing collector config
exporters:
  # Existing Jaeger export
  jaeger:
    endpoint: jaeger-collector.monitoring.svc.cluster.local:14250
    tls:
      insecure: true

  # New Tempo export
  otlp/tempo:
    endpoint: tempo-distributor.monitoring.svc.cluster.local:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp, jaeger, zipkin]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [jaeger, otlp/tempo]  # Both during migration
```

### Migrating Historical Traces

Tempo does not support direct import from Jaeger. For historical data migration:

1. **Accept data loss for old traces** — Typically acceptable since traces older than 7-14 days rarely need investigation.
2. **Keep Jaeger read-only** — Redirect writes to Tempo but keep Jaeger for querying historical data during a transition window.
3. **Gradual cutover** — After the transition window, decommission Jaeger.

### Updating Application SDKs

Replace Jaeger exporters with OTLP exporters in application code:

```go
// Before: Jaeger exporter
// import "go.opentelemetry.io/otel/exporters/jaeger"
// exp, err := jaeger.New(jaeger.WithCollectorEndpoint(
//     jaeger.WithEndpoint("http://jaeger:14268/api/traces"),
// ))

// After: OTLP gRPC exporter → Tempo
import (
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "google.golang.org/grpc"
)

func newTracerProvider(ctx context.Context) (*trace.TracerProvider, error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint("otel-collector.monitoring.svc.cluster.local:4317"),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating OTLP exporter: %w", err)
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName("my-service"),
            semconv.ServiceVersion("v1.0.0"),
            semconv.DeploymentEnvironment("production"),
        ),
        resource.WithFromEnv(),
        resource.WithProcess(),
        resource.WithOS(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    tp := trace.NewTracerProvider(
        trace.WithBatcher(exporter,
            trace.WithBatchTimeout(5*time.Second),
            trace.WithMaxExportBatchSize(512),
        ),
        trace.WithResource(res),
        trace.WithSampler(trace.ParentBased(
            trace.TraceIDRatioBased(0.1), // 10% sampling for new traces
        )),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
        b3.New(),           // For compatibility with Zipkin clients
        jaegerprop.Jaeger{}, // For compatibility with Jaeger clients
    ))

    return tp, nil
}
```

## Section 8: Production Operational Runbook

### Checking Tempo Component Health

```bash
# All Tempo components should be Running
kubectl -n monitoring get pods -l app.kubernetes.io/name=tempo-distributed

# Check the ring members (all ingesters should be ACTIVE)
kubectl -n monitoring port-forward svc/tempo-distributor 3100:3100 &
curl -s http://localhost:3100/ring | python3 -m json.tool | \
  grep -E '"state"|"addr"'

# Check ingestion rate
curl -s http://localhost:3100/metrics | \
  grep 'tempo_distributor_spans_received_total'

# Check query frontend
curl -s http://localhost:3100/api/echo
```

### Verifying Object Storage Connectivity

```bash
# Check the compactor can access S3
kubectl -n monitoring logs -l app.kubernetes.io/component=compactor --tail=50 | \
  grep -E "error|failed|S3"

# Count blocks in S3
aws s3 ls s3://my-tempo-traces/single-tenant/ --recursive | \
  grep "meta.json" | wc -l

# Check block age (should have blocks from the last hour)
aws s3 ls s3://my-tempo-traces/single-tenant/ | \
  sort -k1,2 | tail -5
```

### Troubleshooting Missing Traces

```bash
# 1. Verify the span is being received by the distributor
kubectl -n monitoring logs -l app.kubernetes.io/component=distributor --tail=100 | \
  grep -E "error|dropped|trace_id"

# 2. Check ingester ring health
curl -s http://localhost:3100/ring

# 3. Verify the trace was flushed to object storage
# Traces appear in Tempo after the block flush interval (default: 30m for new data)
# Use the ingester query endpoint for recent traces
curl "http://localhost:3100/api/traces/<trace-id>"

# 4. Check if the trace is in S3 (after flush)
aws s3 ls s3://my-tempo-traces/single-tenant/ --recursive | \
  grep "$(date -d '1 hour ago' +%Y/%m/%d)"

# 5. Verify sampling — check if the application is actually sending spans
kubectl -n monitoring logs -l app=otel-collector | \
  grep -E "spans.*dropped\|sampling"
```

Grafana Tempo represents the current state of the art in cost-effective distributed tracing for Kubernetes. Object storage backends eliminate the operational burden of maintaining Cassandra or Elasticsearch clusters, TraceQL provides surgical trace analysis capabilities that Jaeger's query model cannot match, and the service graph metrics generation creates a feedback loop between trace data and Prometheus alerting without requiring separate instrumentation.
