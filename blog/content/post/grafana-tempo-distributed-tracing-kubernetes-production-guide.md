---
title: "Grafana Tempo: Distributed Tracing at Scale on Kubernetes"
date: 2026-12-29T00:00:00-05:00
draft: false
tags: ["Grafana Tempo", "Distributed Tracing", "Kubernetes", "Observability", "OpenTelemetry"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production deployment guide for Grafana Tempo on Kubernetes covering microservices-based mode, S3 object storage, OpenTelemetry integration, and TraceQL query patterns."
more_link: "yes"
url: "/grafana-tempo-distributed-tracing-kubernetes-production-guide/"
---

Distributed tracing has moved from a debugging nicety to an operational necessity in microservices environments. When a request traverses twelve services before returning a 500 error, logs from individual services provide fragments of information but no coherent story. **Distributed tracing** reconstructs that story by propagating a shared context identifier — a trace ID — across all service boundaries, assembling spans into a tree that reveals exactly where latency and errors originate.

**Grafana Tempo** differentiates itself from Jaeger and Zipkin by decoupling trace ingestion from trace indexing. Tempo stores traces in inexpensive object storage — S3, GCS, or Azure Blob — and relies on trace ID lookups rather than full-text indexing. The result is dramatically lower operational cost at high trace volumes: Tempo does not need to maintain an Elasticsearch cluster to search traces. Integration with **TraceQL**, a purpose-built trace query language, and native exemplar support that links Prometheus metrics to specific traces makes Tempo the natural observability complement to a Grafana stack.

This guide covers Tempo's production deployment on Kubernetes in microservices mode, OpenTelemetry Collector integration, TraceQL query patterns, multi-tenancy configuration, tail-based sampling, and Grafana datasource wiring.

<!--more-->

## Tempo vs Jaeger and Zipkin

Understanding why Tempo exists requires context on the shortcomings of its predecessors in high-volume environments.

**Jaeger** uses Elasticsearch or Cassandra as its storage backend. Elasticsearch indexes every span field, which enables rich full-text search but at significant storage and compute cost. At 10,000 spans per second — common in production microservices environments — Elasticsearch clusters require substantial dedicated resources and operator expertise.

**Zipkin** suffers similar storage constraints and lacks a modern query interface beyond basic service graph navigation.

Tempo's design philosophy:
- Object storage for all trace data (no local state beyond WAL and cache)
- No span-level indexing; traces are retrieved by trace ID only
- TraceQL provides structured querying with tag filtering
- The metrics generator produces service graph metrics from trace data, pushing them to Prometheus

The tradeoff is that Tempo cannot search by arbitrary span fields without pre-configured tag search indices. For most production use cases, this is acceptable: traces are discovered via Grafana Explore by selecting time ranges and filtering on service name, span duration, or status — all indexed fields.

## Architecture: Monolithic vs Microservices Mode

### Monolithic Mode

Monolithic mode runs all Tempo components in a single process. This is appropriate for development environments or organizations ingesting fewer than 10,000 spans per second:

```
Single Pod
├── Distributor
├── Ingester
├── Querier
├── Query Frontend
├── Compactor
└── Metrics Generator
```

### Microservices Mode

Microservices mode runs each component as an independently scalable deployment:

```
Distributor (stateless, 2+ replicas)
    |
    v
Ingester (stateful, 3+ replicas, WAL)
    |
    v
Object Storage (S3/GCS/Azure)
    ^
    |
Store Gateway (stateless, reads from object storage)
    ^
    |
Querier (stateless, 2+ replicas)
    ^
    |
Query Frontend (stateless, 1+ replicas)
```

The **distributor** receives traces from OpenTelemetry Collector instances and hashes the trace ID to determine which **ingester** receives each span. This consistent hashing ensures all spans for a trace land on the same ingester. The ingester writes spans to a write-ahead log (WAL) and flushes complete trace blocks to object storage.

The **compactor** runs background jobs to merge and compact small blocks into larger ones, reducing the number of object storage files that queries must scan. The **query frontend** shards large queries across multiple **querier** instances.

## Helm Deployment with S3 Backend

### MinIO as S3-Compatible Local Storage

For on-premises deployments or development clusters, MinIO provides S3-compatible object storage:

```bash
helm repo add minio https://charts.min.io/
helm repo update

helm upgrade --install minio minio/minio \
  --namespace minio \
  --create-namespace \
  --set rootUser=admin \
  --set rootPassword=minio-admin-password \
  --set persistence.size=100Gi \
  --set replicas=4 \
  --set mode=distributed

kubectl -n minio exec -it minio-0 -- \
  mc alias set local http://localhost:9000 admin minio-admin-password

kubectl -n minio exec -it minio-0 -- mc mb local/tempo-traces
```

### Tempo Helm Values for Microservices Mode

```yaml
# values-tempo-distributed.yaml
tempo-distributed:
  storage:
    trace:
      backend: s3
      s3:
        bucket: tempo-traces
        endpoint: minio.minio.svc.cluster.local:9000
        access_key: tempouser
        secret_key: tempopassword
        insecure: true
      wal:
        path: /var/tempo/wal
      local:
        path: /var/tempo/blocks

  distributor:
    replicas: 2
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
    config:
      log_received_spans:
        enabled: false

  ingester:
    replicas: 3
    persistence:
      enabled: true
      storageClassName: fast-ssd
      size: 10Gi
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: 1000m
        memory: 2Gi
    config:
      trace_idle_period: 10s
      max_block_bytes: 100000000
      max_block_duration: 5m

  compactor:
    replicas: 1
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
    config:
      compaction:
        block_retention: 720h

  querier:
    replicas: 2
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi

  queryFrontend:
    replicas: 1
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
    config:
      search:
        max_duration: 168h

  metricsGenerator:
    enabled: true
    replicas: 1
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
    config:
      storage:
        path: /var/tempo/generator/wal
        remote_write:
        - url: http://mimir-nginx.monitoring.svc.cluster.local/api/v1/push
          send_exemplars: true
      processor:
        service_graphs:
          enable_messaging_system_latency_histogram: true
        span_metrics:
          enable_target_info: true

  serviceMonitor:
    enabled: true
    namespace: monitoring
    interval: 30s
```

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm upgrade --install tempo grafana/tempo-distributed \
  --namespace observability \
  --create-namespace \
  --values values-tempo-distributed.yaml \
  --version 1.9.10
```

### Verifying the Deployment

```bash
kubectl -n observability get pods -l app.kubernetes.io/name=tempo

kubectl -n observability logs -l app.kubernetes.io/component=ingester \
  --tail=50 --follow

kubectl -n observability port-forward svc/tempo-query-frontend 3100:3100 &

curl -s http://localhost:3100/ready
curl -s http://localhost:3100/metrics | grep tempo_ingester
```

## OpenTelemetry Collector Integration

### Collector Deployment

The OpenTelemetry Collector acts as a telemetry pipeline between instrumented applications and Tempo. Deploy it as a DaemonSet to collect traces from all nodes:

```yaml
# otel-collector-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-collector
  namespace: observability
spec:
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
    spec:
      serviceAccountName: otel-collector
      containers:
      - name: otel-collector
        image: otel/opentelemetry-collector-contrib:0.104.0
        args:
        - --config=/conf/config.yaml
        ports:
        - name: otlp-grpc
          containerPort: 4317
          protocol: TCP
        - name: otlp-http
          containerPort: 4318
          protocol: TCP
        - name: jaeger-http
          containerPort: 14268
          protocol: TCP
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        volumeMounts:
        - name: config
          mountPath: /conf
      volumes:
      - name: config
        configMap:
          name: otel-collector-config
```

### Collector Configuration

```yaml
# otel-collector-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
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
          thrift_http:
            endpoint: 0.0.0.0:14268
          grpc:
            endpoint: 0.0.0.0:14250

    processors:
      batch:
        timeout: 5s
        send_batch_size: 512
      memory_limiter:
        check_interval: 5s
        limit_percentage: 80
        spike_limit_percentage: 25
      resource:
        attributes:
        - key: cluster
          value: production-us-east-1
          action: insert

    exporters:
      otlp:
        endpoint: tempo-distributor.observability.svc.cluster.local:4317
        tls:
          insecure: true
      prometheusremotewrite:
        endpoint: http://mimir-nginx.monitoring.svc.cluster.local/api/v1/push

    service:
      pipelines:
        traces:
          receivers: [otlp, jaeger]
          processors: [memory_limiter, resource, batch]
          exporters: [otlp]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [prometheusremotewrite]
```

### Application Instrumentation with Go

The following demonstrates OpenTelemetry SDK integration in a Go service targeting the collector:

```go
package tracing

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func InitTracer(ctx context.Context, serviceName, collectorAddr string) (*sdktrace.TracerProvider, error) {
	conn, err := grpc.NewClient(
		collectorAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create gRPC connection: %w", err)
	}

	exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, fmt.Errorf("failed to create OTLP exporter: %w", err)
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
			semconv.ServiceVersion("v1.0.0"),
			semconv.DeploymentEnvironment("production"),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1))),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return tp, nil
}
```

## TraceQL Query Language

**TraceQL** is Tempo's structured query language for selecting spans and traces based on span attributes, duration, and status. It enables searching that was previously impossible in Tempo's index-free architecture by leveraging the tag search index.

### Basic Span Selection

```
# Select all error spans from the payment-service
{ .service.name = "payment-service" && status = error }

# Find slow spans over 500ms
{ .service.name = "api-gateway" && duration > 500ms }

# Select spans with a specific HTTP route
{ .http.route = "/api/v1/orders" && status = error }
```

### Structural Operators

TraceQL supports span-set structural operators to query relationships between spans within a trace:

```
# Find traces where payment-service calls database and returns an error
{ .service.name = "payment-service" } >> { .db.system = "postgresql" && status = error }

# Find traces with a child span that is slow
{ .service.name = "api-gateway" } >> { duration > 1s }

# Traces where any descendant has an error
{ .service.name = "order-service" } ~> { status = error }
```

### Aggregate Functions

```
# Count error spans per service
count_over_time({ status = error }[5m]) by (.service.name)

# Average duration by HTTP route
avg_over_time({ .http.method = "POST" } | duration[5m]) by (.http.route)

# Rate of spans per second
rate({ .service.name = "checkout-service" }[1m])
```

### Using TraceQL in Grafana Explore

In Grafana's Explore view with Tempo as the datasource, switch to the TraceQL tab and enter queries directly. The results panel shows matching trace IDs with duration and status. Clicking a trace ID opens the full waterfall view.

For span-level filtering that narrows results before displaying the waterfall:

```
{ .service.name = "payment-service" && .http.status_code = 500 && duration > 200ms }
```

## Exemplars: Linking Traces to Metrics

**Exemplars** are sample data points attached to Prometheus metrics that carry a trace ID. When the metrics generator emits span metrics with exemplars, Grafana can display a trace ID inline on a Prometheus chart and navigate directly to the trace from a dashboard panel.

### Enabling Exemplar Generation

Configure the metrics generator to attach exemplars to span metrics:

```yaml
metricsGenerator:
  config:
    processor:
      span_metrics:
        enable_target_info: true
        dimensions:
        - http.method
        - http.route
        - http.status_code
      service_graphs:
        enable_messaging_system_latency_histogram: true
        dimensions:
        - http.method
```

### Prometheus Remote Write with Exemplar Support

Configure the remote write endpoint to accept exemplars:

```yaml
# prometheus-values.yaml
prometheus:
  prometheusSpec:
    enableFeatures:
    - exemplar-storage
    remoteWrite:
    - url: http://mimir-nginx.monitoring.svc.cluster.local/api/v1/push
      writeRelabelConfigs: []
      queueConfig:
        capacity: 10000
        maxSamplesPerSend: 5000
```

### Grafana Panel with Exemplar Display

In a Grafana panel querying `tempo_spanmetrics_latency_bucket`, enable exemplars in the panel settings under "Exemplars". When Grafana renders the histogram, dots appear on the time series indicating exemplar data points. Clicking a dot opens the linked trace in Tempo.

## Multi-Tenancy with X-Scope-OrgID

Tempo's multi-tenancy model partitions traces by a tenant identifier carried in the `X-Scope-OrgID` HTTP header. Each tenant's traces are stored in separate object storage paths, preventing cross-tenant data leakage.

### Enabling Multi-Tenancy

```yaml
# tempo-multitenancy-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tempo-config
  namespace: observability
data:
  tempo.yaml: |
    multitenancy_enabled: true
    server:
      http_listen_port: 3100
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
      max_block_bytes: 100000000
      max_block_duration: 5m
    compactor:
      compaction:
        block_retention: 720h
    storage:
      trace:
        backend: s3
        s3:
          bucket: tempo-traces
          endpoint: s3.us-east-1.amazonaws.com
          region: us-east-1
        wal:
          path: /var/tempo/wal
        local:
          path: /var/tempo/blocks
    query_frontend:
      search:
        max_duration: 168h
```

### Injecting Tenant ID via OpenTelemetry Collector

Configure the collector to inject the tenant header based on the Kubernetes namespace of the source pod:

```yaml
processors:
  resource:
    attributes:
    - key: tenant.id
      from_attribute: k8s.namespace.name
      action: insert
exporters:
  otlp:
    endpoint: tempo-distributor.observability.svc.cluster.local:4317
    tls:
      insecure: true
    headers:
      X-Scope-OrgID: "${env:KUBE_NAMESPACE}"
```

For the DaemonSet, pass the namespace as an environment variable using the downward API:

```yaml
env:
- name: KUBE_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
```

### Per-Tenant Retention

Tempo supports per-tenant overrides for block retention, max trace size, and ingestion rate limits:

```yaml
# tempo-overrides-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tempo-overrides
  namespace: observability
data:
  overrides.yaml: |
    overrides:
      team-payments:
        ingestion_rate_limit_bytes: 20000000
        ingestion_burst_size_bytes: 40000000
        max_bytes_per_trace: 5000000
        block_retention: 2160h
      team-frontend:
        ingestion_rate_limit_bytes: 5000000
        ingestion_burst_size_bytes: 10000000
        block_retention: 360h
```

## Grafana Datasource Configuration

### Provisioning the Tempo Datasource

```yaml
# grafana-tempo-datasource.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasource-tempo
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  tempo-datasource.yaml: |
    apiVersion: 1
    datasources:
    - name: Tempo
      type: tempo
      url: http://tempo-query-frontend.observability.svc.cluster.local:3100
      uid: tempo
      jsonData:
        httpMethod: GET
        serviceMap:
          datasourceUid: prometheus
        nodeGraph:
          enabled: true
        traceQuery:
          timeShiftEnabled: true
          spanStartTimeShift: "-5m"
          spanEndTimeShift: "5m"
        tracesToLogsV2:
          datasourceUid: loki
          filterByTraceID: true
          filterBySpanID: false
          tags:
          - key: service.name
            value: app
        tracesToMetrics:
          datasourceUid: prometheus
          spanStartTimeShift: "-5m"
          spanEndTimeShift: "5m"
          tags:
          - key: service.name
            value: job
```

The `serviceMap` field points to a Prometheus datasource that receives the service graph metrics emitted by Tempo's metrics generator, enabling the service map visualization in Grafana.

## Tail-Based Sampling with the OpenTelemetry Collector

**Head-based sampling** makes sampling decisions at trace initiation and is fast but cannot sample based on trace outcome. **Tail-based sampling** buffers spans until the full trace is assembled, enabling decisions based on error status or total duration.

### Tail Sampling Collector Configuration

Deploy a stateful set of collector instances dedicated to tail sampling. Head-sampling collectors fan out to these instances using consistent hashing on the trace ID:

```yaml
# tail-sampling-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tail-sampling-config
  namespace: observability
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317

    processors:
      tail_sampling:
        decision_wait: 30s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
        - name: errors-policy
          type: status_code
          status_code:
            status_codes: [ERROR]
        - name: slow-traces-policy
          type: latency
          latency:
            threshold_ms: 1000
        - name: probabilistic-policy
          type: probabilistic
          probabilistic:
            sampling_percentage: 5
      batch:
        timeout: 5s

    exporters:
      otlp:
        endpoint: tempo-distributor.observability.svc.cluster.local:4317
        tls:
          insecure: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [tail_sampling, batch]
          exporters: [otlp]
```

### Load Balancing Collector for Trace ID Affinity

The `loadbalancing` exporter in the OpenTelemetry Collector routes spans from the same trace to the same tail-sampling collector instance:

```yaml
exporters:
  loadbalancing:
    protocol:
      otlp:
        tls:
          insecure: true
    resolver:
      k8s:
        service: otel-tail-sampler-headless.observability
        ports:
        - 4317
```

## Operational Considerations

### Compactor Block Retention Tuning

The compactor runs retention checks every configured interval and deletes blocks older than `block_retention`. Monitor compactor performance:

```bash
kubectl -n observability logs -l app.kubernetes.io/component=compactor \
  --tail=100 | grep -E "compacted|retention|error"

kubectl -n observability port-forward svc/tempo-query-frontend 3100:3100 &
curl -s http://localhost:3100/metrics | grep tempo_compactor
```

### WAL Recovery

If an ingester pod crashes before flushing blocks to object storage, the WAL replays on restart. Monitor WAL replay duration:

```bash
kubectl -n observability logs tempo-ingester-0 | grep -i "wal replay"
```

WAL size should be bounded. If ingesters grow unbounded, reduce `max_block_duration` or increase flush frequency.

### Sizing Object Storage

Tempo compresses trace data aggressively. A rough estimate for AWS environments:

- 10,000 spans/second at 1KB average span size = ~10MB/s ingestion
- After compression (typically 10:1): ~1MB/s stored
- Daily storage: ~86GB uncompressed, ~8.6GB compressed
- With 30-day retention: ~258GB in S3

## Conclusion

Grafana Tempo provides a cost-effective, operationally simple distributed tracing backend that integrates natively into the Grafana observability stack. Key operational takeaways:

- **Object storage is the operational lever**: Tempo's decision to avoid Elasticsearch removes the most expensive operational dependency in competitive solutions. S3-compatible storage at compressed trace volumes makes long retention periods financially viable.
- **TraceQL structural operators unlock root cause analysis**: The `>>` and `~>` operators enable queries that express parent-child and ancestor-descendant span relationships, making it possible to find traces where a specific downstream service is the source of errors.
- **Tail-based sampling requires trace ID affinity routing**: The `loadbalancing` exporter with `k8s` resolver is the production pattern for distributing spans across a tail-sampling collector pool without fragmenting traces.
- **Exemplars close the metrics-to-traces gap**: The metrics generator's exemplar output transforms histogram panels in Grafana from aggregate visualizations into direct navigation points to representative traces.
- **Multi-tenancy uses header injection, not separate deployments**: A single Tempo cluster serves all tenants with `X-Scope-OrgID` partitioning. Per-tenant overrides control ingestion rates and retention without requiring separate infrastructure per team.
