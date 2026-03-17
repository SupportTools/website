---
title: "Grafana Tempo: Distributed Tracing at Scale Without Sampling"
date: 2027-12-22T00:00:00-05:00
draft: false
tags: ["Grafana Tempo", "Distributed Tracing", "Kubernetes", "OpenTelemetry", "Observability", "Prometheus", "Loki", "TraceQL"]
categories:
- Kubernetes
- Observability
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Grafana Tempo on Kubernetes covering deployment with object storage backends, TraceQL queries, span metrics pipeline, exemplars linking to Prometheus, Loki log correlation, and cardinality management for large-scale distributed tracing."
more_link: "yes"
url: "/grafana-tempo-distributed-tracing-guide/"
---

Distributed tracing provides the causal chain of events across microservices that logs and metrics cannot reconstruct alone. Grafana Tempo stores traces in object storage (S3, GCS, Azure Blob) rather than a dedicated database, enabling head-based sampling rates of 100% at costs competitive with sampled alternatives. This guide covers Tempo deployment on Kubernetes with microservices mode, TraceQL query patterns, span metrics for RED dashboards, exemplar correlation with Prometheus metrics, and Loki log-trace linking.

<!--more-->

# Grafana Tempo: Distributed Tracing at Scale Without Sampling

## Why Tempo Over Jaeger or Zipkin

Traditional distributed tracing systems (Jaeger, Zipkin) store traces in Cassandra or Elasticsearch, which require careful capacity planning, index management, and become expensive at high trace volumes. As a result, production deployments typically sample at 1-10%, discarding the majority of traces.

Tempo's object storage model changes this tradeoff:

- **Cost**: S3 storage at ~$0.023/GB-month vs Elasticsearch at $5-10/GB-month (with replicas and index overhead)
- **Scale**: Object storage scales infinitely without operational burden
- **Sampling**: 100% trace capture becomes economically feasible
- **Integration**: Native Grafana integration with exemplar correlation to Prometheus metrics and Loki logs

The primary limitation: object storage has latency for writes, meaning Tempo introduces a 15-60 second delay before traces are queryable. This is acceptable for post-incident analysis but not for real-time trace streaming.

## Architecture Modes

Tempo operates in two modes:

**Monolithic** (single binary): For clusters with < 10,000 spans/second. All components run in one process.

**Microservices** (recommended for production):
- **Distributor**: Receives spans from collectors, routes to ingesters
- **Ingester**: Buffers spans in memory, flushes to object storage
- **Querier**: Serves TraceID lookups from object storage
- **Query Frontend**: Handles TraceQL queries, caches results
- **Compactor**: Merges and compacts object storage blocks
- **Metrics Generator**: Converts spans to Prometheus metrics

## Installation with Helm

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm upgrade --install tempo grafana/tempo-distributed \
  --namespace monitoring \
  --values tempo-values.yaml \
  --version 1.26.0 \
  --wait
```

```yaml
# tempo-values.yaml
global:
  clusterDomain: cluster.local

traces:
  otlp:
    grpc:
      enabled: true
    http:
      enabled: true
  jaeger:
    grpcThriftBinary:
      enabled: false
    thriftHttp:
      enabled: false
  zipkin:
    enabled: false

storage:
  trace:
    backend: s3
    s3:
      bucket: my-tempo-traces
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      # Use IRSA/workload identity - do not embed credentials
      access_key: ""
      secret_key: ""

ingester:
  replicas: 3
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilizationPercentage: 60
  resources:
    requests:
      cpu: "1"
      memory: "2Gi"
    limits:
      cpu: "4"
      memory: "8Gi"
  config:
    replication_factor: 3
    max_block_duration: 30m
    complete_block_timeout: 3m

distributor:
  replicas: 2
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 8
    targetCPUUtilizationPercentage: 70
  resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "2"
      memory: "2Gi"

querier:
  replicas: 2
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "4Gi"
  config:
    max_concurrent_queries: 20

queryFrontend:
  replicas: 1
  resources:
    requests:
      cpu: "200m"
      memory: "256Mi"
    limits:
      cpu: "1"
      memory: "1Gi"
  config:
    max_retries: 2
    search:
      duration_slo: 5s
      throughput_bytes_slo: 0
    trace_by_id:
      duration_slo: 5s

compactor:
  replicas: 1
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "4Gi"
  config:
    compaction:
      block_retention: 720h   # 30 days
      compacted_block_retention: 1h

metricsGenerator:
  enabled: true
  replicas: 1
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "4Gi"
  config:
    storage:
      path: /var/tempo/generator/wal
      remote_write:
        - url: http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/write
          send_exemplars: true
    processor:
      service_graphs:
        enabled: true
        dimensions:
          - service.namespace
          - db.system
        max_items: 10000
        wait: 10s
        max_age: 30s
      span_metrics:
        enabled: true
        dimensions:
          - service.namespace
          - http.method
          - http.status_code
          - db.system
        enable_target_info: true

tempo:
  config: |
    multitenancy_enabled: false
    usage_report:
      reporting_enabled: false
    compactor:
      compaction:
        block_retention: 720h
    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: 0.0.0.0:4317
            http:
              endpoint: 0.0.0.0:4318
    ingester:
      trace_idle_period: 10s
      flush_check_period: 10s
      max_block_bytes: 104857600
    querier:
      frontend_worker:
        frontend_address: tempo-query-frontend.monitoring.svc.cluster.local:9095
    query_frontend:
      search:
        duration_slo: 5s
        throughput_bytes_slo: 0
      trace_by_id:
        duration_slo: 5s
    server:
      http_listen_port: 3100
      grpc_listen_port: 9095
    storage:
      trace:
        backend: s3
        wal:
          path: /var/tempo/wal
        local:
          path: /var/tempo/blocks
        s3:
          bucket: my-tempo-traces
          endpoint: s3.us-east-1.amazonaws.com
          region: us-east-1
    overrides:
      defaults:
        metrics_generator:
          processors:
            - service-graphs
            - span-metrics
          max_active_series: 100000
```

## AWS IRSA Configuration for S3 Access

```yaml
# tempo-serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tempo
  namespace: monitoring
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/tempo-s3-access
```

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

## OpenTelemetry Collector Configuration

Route spans from application services to Tempo:

```yaml
# otel-collector-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: monitoring
data:
  otel-collector-config.yaml: |
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

    processors:
      memory_limiter:
        check_interval: 5s
        limit_percentage: 80
        spike_limit_percentage: 25

      batch:
        timeout: 5s
        send_batch_size: 1024
        send_batch_max_size: 2048

      resource:
        attributes:
          - action: insert
            key: k8s.cluster.name
            value: production-us-east-1

      resourcedetection:
        detectors: [env, k8snode]
        timeout: 5s
        override: false

      # Tail-based sampling for high-volume services
      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
          - name: error-traces
            type: status_code
            status_code: {status_codes: [ERROR]}
          - name: slow-traces
            type: latency
            latency: {threshold_ms: 1000}
          - name: probabilistic-sampling
            type: probabilistic
            probabilistic: {sampling_percentage: 10}

    exporters:
      otlp:
        endpoint: tempo-distributor.monitoring.svc.cluster.local:4317
        tls:
          insecure: true

      prometheus:
        endpoint: 0.0.0.0:8889
        namespace: otel_collector
        resource_to_telemetry_conversion:
          enabled: true

    service:
      pipelines:
        traces:
          receivers: [otlp, jaeger]
          processors: [memory_limiter, resourcedetection, resource, batch]
          exporters: [otlp]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [prometheus]
```

## TraceQL Queries

TraceQL is Tempo's query language for searching traces by span attributes:

```traceql
# Find all traces with errors in the payment service
{ resource.service.name = "payment-service" && status = error }

# Find traces slower than 1 second
{ duration > 1s }

# Find traces hitting a specific database
{ span.db.system = "postgresql" && span.db.name = "payments" && duration > 500ms }

# Find traces with a specific HTTP path and error status
{ span.http.target =~ "/api/v1/payments.*" && span.http.status_code >= 500 }

# Find traces with span count exceeding threshold (fan-out detection)
{ rootName = "POST /api/v1/checkout" } | count() > 50

# Aggregate span durations for histogram analysis
{ resource.service.name = "api-gateway" } | avg(duration)

# Find traces where a specific span is slow (deep service span)
{ resource.service.name = "inventory-service" && span.db.operation = "SELECT" && duration > 200ms }
```

## Grafana Data Source Configuration

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
        access: proxy
        url: http://tempo-query-frontend.monitoring.svc.cluster.local:3100
        uid: tempo
        jsonData:
          tracesToLogsV2:
            datasourceUid: loki
            spanStartTimeShift: "-1m"
            spanEndTimeShift: "1m"
            filterByTraceID: true
            filterBySpanID: false
            customQuery: true
            query: |
              {namespace="${__span.tags.k8s.namespace.name}",
               container="${__span.tags.k8s.container.name}"}
               |= "${__trace.traceId}"
          tracesToMetrics:
            datasourceUid: prometheus
            tags:
              - key: service.name
                value: service
              - key: k8s.namespace.name
                value: namespace
            queries:
              - name: RED Metrics
                query: |
                  rate(traces_spanmetrics_calls_total{
                    service="$__tags.service",
                    namespace="$__tags.namespace"
                  }[5m])
          serviceMap:
            datasourceUid: prometheus
          search:
            hide: false
          lokiSearch:
            datasourceUid: loki
          traceQuery:
            timeShiftEnabled: true
            spanStartTimeShift: 1h
            spanEndTimeShift: -1h
          spanBar:
            type: Tag
            tag: http.status_code
```

## Span Metrics for RED Dashboards

The Metrics Generator converts spans into Prometheus metrics, enabling RED (Rate, Errors, Duration) dashboards without instrumentation changes:

```promql
# Request Rate (spans/second by service)
sum by (service) (
  rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER"}[5m])
)

# Error Rate
sum by (service) (
  rate(traces_spanmetrics_calls_total{
    span_kind="SPAN_KIND_SERVER",
    status_code="STATUS_CODE_ERROR"
  }[5m])
)
/
sum by (service) (
  rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER"}[5m])
)

# Duration P99
histogram_quantile(0.99,
  sum by (service, le) (
    rate(traces_spanmetrics_duration_milliseconds_bucket{
      span_kind="SPAN_KIND_SERVER"
    }[5m])
  )
)

# Service dependency graph: request rate between services
sum by (client, server) (
  rate(traces_service_graph_request_total[5m])
)

# Service dependency graph: error rate
sum by (client, server) (
  rate(traces_service_graph_request_failed_total[5m])
)
/
sum by (client, server) (
  rate(traces_service_graph_request_total[5m])
)
```

## Exemplars: Linking Metrics to Traces

Exemplars attach a trace ID to a Prometheus metric sample, enabling direct navigation from a high-latency metric data point to the exact trace:

```go
// Go instrumentation with exemplars (using prometheus/client_golang)
package main

import (
    "net/http"
    "strconv"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "go.opentelemetry.io/otel/trace"
)

var (
    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration with trace exemplars",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path", "status"},
    )
)

func instrumentedHandler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        rw := &statusRecorder{ResponseWriter: w}
        timer := prometheus.NewTimer(nil)

        next.ServeHTTP(rw, r)

        duration := timer.ObserveDuration()

        // Extract trace ID from context
        span := trace.SpanFromContext(r.Context())
        traceID := span.SpanContext().TraceID().String()

        // Record metric with exemplar pointing to this trace
        httpRequestDuration.With(prometheus.Labels{
            "method": r.Method,
            "path":   r.URL.Path,
            "status": strconv.Itoa(rw.statusCode),
        }).(prometheus.ExemplarObserver).ObserveWithExemplar(
            duration.Seconds(),
            prometheus.Labels{
                "traceID": traceID,
            },
        )
    })
}
```

Grafana automatically detects exemplars in Prometheus metrics and renders them as clickable dots on time series panels, linking directly to the trace in Tempo.

## Loki Log Correlation

Configure Loki to include trace IDs in log records for bidirectional correlation:

```yaml
# loki-pipeline-stages (in Promtail or Alloy config)
pipeline_stages:
  - json:
      expressions:
        trace_id: trace_id
        span_id: span_id
        level: level
        message: message
  - labels:
      level:
      trace_id:
  - labeldrop:
      - trace_id  # Move from label to structured metadata to avoid cardinality
  - structured_metadata:
      trace_id: trace_id
      span_id: span_id
```

Application logging configuration (Go with Zap):

```go
// zapcore encoder with trace ID injection
func newZapEncoder(ctx context.Context) *zap.Logger {
    span := trace.SpanFromContext(ctx)
    traceID := span.SpanContext().TraceID().String()
    spanID := span.SpanContext().SpanID().String()

    logger, _ := zap.NewProduction()
    return logger.With(
        zap.String("trace_id", traceID),
        zap.String("span_id", spanID),
    )
}
```

## Cardinality Management

High-cardinality span attributes (user IDs, order IDs, IP addresses) can explode metrics generated by the span metrics pipeline. Control this with dimension allowlists:

```yaml
# In tempo-values.yaml metricsGenerator config
config:
  processor:
    span_metrics:
      enabled: true
      dimensions:
        # ALLOWED: low-cardinality dimensions
        - service.namespace
        - http.method
        - http.status_code
        - db.system
        - rpc.service
        # NOT included: http.url (contains query params), user.id, etc.
      intrinsic_dimensions:
        service: true
        span_name: true
        span_kind: true
        status_code: true
        status_message: false  # Can be high cardinality
      filter_policies:
        - include:
            match_type: strict
            attributes:
              - key: span.kind
                value: server
              - key: span.kind
                value: consumer
```

Resource limits to protect against cardinality explosions:

```yaml
overrides:
  defaults:
    metrics_generator:
      processors:
        - service-graphs
        - span-metrics
      max_active_series: 100000       # Hard limit on concurrent series
      collection_interval: 60s
      disable_collection: false
    max_traces_per_user: 0
    max_search_bytes_per_trace: 0
    max_bytes_per_tag_values_query: 5000000
    ingestion_rate_limit_bytes: 20000000    # 20 MB/s per tenant
    ingestion_burst_size_bytes: 40000000    # 40 MB burst
    read_rate_limit_bytes: 100000000        # 100 MB/s read
```

## PrometheusRule Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tempo-alerts
  namespace: monitoring
spec:
  groups:
    - name: tempo.rules
      rules:
        - alert: TempoIngesterUnhealthy
          expr: |
            kube_statefulset_status_replicas_ready{
              statefulset="tempo-ingester",
              namespace="monitoring"
            } < kube_statefulset_replicas{
              statefulset="tempo-ingester",
              namespace="monitoring"
            }
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Tempo ingester has unhealthy replicas"

        - alert: TempoHighWriteLatency
          expr: |
            histogram_quantile(0.99,
              rate(tempo_distributor_push_duration_seconds_bucket[5m])
            ) > 0.5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Tempo distributor write P99 latency above 500ms"

        - alert: TempoS3WriteFailures
          expr: |
            rate(tempo_ingester_block_flushed_total{err!=""}[5m]) > 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Tempo ingester failing to flush blocks to S3"

        - alert: TempoQuerierSearchErrors
          expr: |
            rate(tempo_query_frontend_queries_total{result="error"}[5m]) /
            rate(tempo_query_frontend_queries_total[5m]) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Tempo query error rate above 5%"
```

## Multi-Tenancy Configuration

For clusters serving multiple teams, enable multi-tenancy with tenant-based retention policies:

```yaml
tempo:
  config: |
    multitenancy_enabled: true

overrides:
  per_tenant_override_config: /runtime-config/overrides.yaml
  per_tenant_override_period: 60s
```

```yaml
# runtime-config/overrides.yaml
overrides:
  payments-team:
    max_traces_per_user: 0
    block_retention: 2160h    # 90 days for compliance
    ingestion_rate_limit_bytes: 30000000
    ingestion_burst_size_bytes: 60000000
    metrics_generator_max_active_series: 50000

  ml-platform:
    block_retention: 168h     # 7 days for cost control
    ingestion_rate_limit_bytes: 10000000
    metrics_generator_processors:
      - span-metrics           # No service graphs for internal ML traffic
```

## Troubleshooting

### Traces Not Appearing in Grafana

```bash
# Check distributor is receiving spans
kubectl logs -n monitoring deployment/tempo-distributor | grep -i "pushed\|error" | tail -20

# Verify ingester is flushing to S3
kubectl logs -n monitoring statefulset/tempo-ingester | grep -i "flush\|block\|error" | tail -20

# Check S3 connectivity
kubectl exec -n monitoring tempo-ingester-0 -- \
  curl -I "https://my-tempo-traces.s3.amazonaws.com/"

# Verify trace is in object storage (wait 60+ seconds after ingestion)
curl "http://tempo-query-frontend.monitoring.svc.cluster.local:3100/api/traces/TRACE_ID_HERE"
```

### TraceQL Returns No Results

```bash
# Verify span attributes are indexed
curl "http://tempo-query-frontend.monitoring.svc.cluster.local:3100/api/v2/search/tags?scope=span" | jq .

# Check tag values exist
curl "http://tempo-query-frontend.monitoring.svc.cluster.local:3100/api/v2/search/tag/service.name/values" | jq .

# Confirm time range covers data
curl "http://tempo-query-frontend.monitoring.svc.cluster.local:3100/api/v2/search?q={}&start=NOW-1h&end=NOW&limit=5" | jq .
```

## Summary

Grafana Tempo provides cost-effective, scalable distributed tracing by using object storage as the trace backend. The critical production elements are:

1. Microservices mode with independent scaling of ingesters, queriers, and distributors
2. S3 backend with IRSA/workload identity for credential-free access
3. OpenTelemetry Collector as the span pipeline router with tail-based sampling for volume control
4. Metrics Generator for automatic RED metrics from span data without code changes
5. Exemplar instrumentation linking Prometheus metric spikes to specific traces
6. Loki correlation via trace_id structured metadata for unified investigation
7. Dimension allowlists in span metrics to prevent cardinality explosions
8. Per-tenant retention overrides for compliance and cost management
