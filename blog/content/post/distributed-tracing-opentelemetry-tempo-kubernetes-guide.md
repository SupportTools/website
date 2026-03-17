---
title: "Distributed Tracing with OpenTelemetry and Tempo on Kubernetes"
date: 2028-12-15T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Tempo", "Distributed Tracing", "Kubernetes", "Observability", "Grafana"]
categories:
- Observability
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production enterprise guide to implementing distributed tracing with OpenTelemetry and Grafana Tempo on Kubernetes, covering instrumentation, sampling strategies, Tempo deployment, trace correlation with metrics and logs, and performance impact analysis."
more_link: "yes"
url: "/distributed-tracing-opentelemetry-tempo-kubernetes-guide/"
---

Distributed tracing answers the question that metrics and logs cannot: "What happened to this specific request as it traversed multiple services?" When a p99 API latency alert fires at 2 AM, metrics tell you the percentile crossed a threshold and logs tell you error messages appeared — but neither reconstructs the causal chain through 15 microservices that explains why the specific slow requests are slow.

OpenTelemetry provides the vendor-neutral instrumentation API and SDK. Grafana Tempo provides scalable, cost-efficient trace storage and query. Together they form a production-ready distributed tracing stack that integrates with Prometheus and Loki for correlated observability.

This guide covers deploying and operating this stack at enterprise scale: instrumenting Go, Java, and Python services, configuring the OpenTelemetry Collector, deploying Tempo with object storage backends, designing sampling strategies, and building Grafana dashboards that correlate traces with metrics and logs.

<!--more-->

## Distributed Tracing Concepts

### Trace Structure

A **trace** represents a single logical operation (an API request) as it flows through a distributed system. It consists of:

- **Span**: A named, timed operation representing work within a single service. Each span has a `trace_id` (shared across the entire trace), a `span_id` (unique within the trace), and an optional `parent_span_id` (forming a tree structure)
- **Root span**: The first span in the trace, created by the entry point service
- **Child span**: A span created by a service call initiated within another span
- **Span attributes**: Key-value metadata (e.g., `http.method`, `db.statement`, `rpc.service`)
- **Span events**: Time-stamped logs within a span (e.g., cache miss, validation error)
- **Span status**: OK, Error, or Unset

### Propagation

Trace context propagates between services via HTTP headers. The W3C Trace Context standard (`traceparent` and `tracestate` headers) is the recommended propagation format.

A `traceparent` header looks like:
```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
                ^^                                ^^^^^^^^^^^^^^^^ ^
                version  trace-id (128-bit)       span-id (64-bit) flags
```

## OpenTelemetry Architecture

The OpenTelemetry project defines:

- **API**: Language-specific interfaces for instrumentation (no implementation)
- **SDK**: Language-specific implementations of the API with configurable exporters
- **Collector**: A vendor-agnostic agent/gateway for receiving, processing, and exporting telemetry

### OpenTelemetry Collector in Kubernetes

The Collector runs as a DaemonSet (agent mode) or Deployment (gateway mode):

```
Application → OTLP (gRPC/HTTP) → OTel Collector Agent (DaemonSet)
                                          ↓
                                 OTel Collector Gateway (Deployment)
                                          ↓
                                   Grafana Tempo
```

The agent-gateway pattern reduces the number of external connections from the application layer and allows centralized processing (sampling, attribute enrichment, batching).

## Deploying Grafana Tempo

### Monolithic Mode (Development/Small Clusters)

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: tempo
---
# values.yaml for Tempo Helm chart
# helm install tempo grafana/tempo-distributed -n tempo -f values.yaml
tempo:
  reportingEnabled: false

  storage:
    trace:
      backend: s3
      s3:
        bucket: tempo-traces-prod
        endpoint: s3.us-east-1.amazonaws.com
        region: us-east-1
        # Use IRSA for authentication — no static credentials
        forcepathstyle: false

  ingester:
    replicas: 3
    config:
      max_block_duration: 10m

  distributor:
    replicas: 2

  querier:
    replicas: 2

  compactor:
    replicas: 1

  queryFrontend:
    replicas: 2

  metricsGenerator:
    enabled: true
    replicas: 1
    config:
      storage:
        path: /tmp/tempo/generator/wal
        remote_write:
        - url: http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/write
          send_exemplars: true

  global_overrides:
    defaults:
      metrics_generator:
        processors:
        - service-graphs
        - span-metrics
      ingestion_rate_limit_bytes: 15000000  # 15MB/s per tenant
      ingestion_burst_size_bytes: 20000000
      max_traces_per_user: 10000
      block_retention: 720h  # 30 days

  server:
    grpc_listen_port: 9095

  storage:
    trace:
      wal:
        path: /var/tempo/wal
      cache: memcached
      memcached:
        consistent_hash: true
        host: tempo-memcached
        service: memcached-client
        timeout: 500ms

memcached:
  enabled: true
  replicaCount: 3
```

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm install tempo grafana/tempo-distributed \
  --namespace tempo \
  --create-namespace \
  --version 1.9.0 \
  -f tempo-values.yaml

# Verify all components are running
kubectl get pods -n tempo
```

## Deploying the OpenTelemetry Collector

### Using the OpenTelemetry Operator

The OTel Operator manages Collector deployments as Kubernetes resources:

```bash
helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system \
  --create-namespace \
  --version 0.63.0 \
  --set admissionWebhooks.certManager.enabled=true
```

### Collector DaemonSet Configuration

```yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: otel-agent
  namespace: opentelemetry
spec:
  mode: daemonset
  serviceAccount: otel-collector
  config:
    receivers:
      # OTLP receiver: accepts traces from applications
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

      # Kubernetes events receiver
      k8s_events:
        auth_type: serviceAccount

      # Kubernetes metrics receiver
      kubeletstats:
        auth_type: serviceAccount
        collection_interval: 30s
        endpoint: "${env:K8S_NODE_NAME}:10250"
        extra_metadata_labels:
        - container.id
        - k8s.volume.type
        metric_groups:
        - node
        - pod
        - container

    processors:
      # Enrich traces with Kubernetes metadata
      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        extract:
          metadata:
          - k8s.namespace.name
          - k8s.deployment.name
          - k8s.statefulset.name
          - k8s.daemonset.name
          - k8s.pod.name
          - k8s.pod.uid
          - k8s.node.name
          - k8s.container.name
          - container.image.name
          - container.image.tag
          labels:
          - tag_name: app.kubernetes.io/name
            key: app.kubernetes.io/name
            from: pod
          - tag_name: app.kubernetes.io/version
            key: app.kubernetes.io/version
            from: pod
        pod_association:
        - sources:
          - from: resource_attribute
            name: k8s.pod.ip
        - sources:
          - from: resource_attribute
            name: k8s.pod.uid
        - sources:
          - from: connection

      # Tail-based sampling: decide what to keep after seeing the full trace
      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 10000
        policies:
        # Always keep error traces
        - name: errors-policy
          type: status_code
          status_code:
            status_codes: [ERROR]
        # Keep slow traces (>1 second)
        - name: slow-traces
          type: latency
          latency:
            threshold_ms: 1000
        # Sample 1% of successful fast traces
        - name: probabilistic-sample
          type: probabilistic
          probabilistic:
            sampling_percentage: 1
        # Always keep traces from specific services
        - name: critical-services
          type: string_attribute
          string_attribute:
            key: service.name
            values:
            - payments-api
            - order-processor
            enabled_regex_matching: false

      # Batch processor for efficiency
      batch:
        timeout: 1s
        send_batch_size: 1000
        send_batch_max_size: 2000

      # Memory limiter prevents OOM
      memory_limiter:
        check_interval: 1s
        limit_mib: 512
        spike_limit_mib: 128

      # Resource detection
      resourcedetection:
        detectors:
        - eks
        - ec2
        - env
        timeout: 5s
        override: false

    exporters:
      otlp/tempo:
        endpoint: tempo-distributor.tempo.svc.cluster.local:4317
        tls:
          insecure: true
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
          max_elapsed_time: 120s

      # Export service graph metrics to Prometheus
      prometheusremotewrite:
        endpoint: http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/write
        tls:
          insecure_skip_verify: false

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, tail_sampling, batch]
          exporters: [otlp/tempo]
        metrics:
          receivers: [kubeletstats]
          processors: [memory_limiter, resourcedetection, batch]
          exporters: [prometheusremotewrite]
```

## Instrumenting Applications

### Go Instrumentation

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
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"
)

func initTracer(ctx context.Context) (*sdktrace.TracerProvider, error) {
	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("creating OTLP trace exporter: %w", err)
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(os.Getenv("SERVICE_NAME")),
			semconv.ServiceVersion(os.Getenv("APP_VERSION")),
			semconv.DeploymentEnvironment(os.Getenv("ENVIRONMENT")),
			attribute.String("k8s.namespace", os.Getenv("POD_NAMESPACE")),
			attribute.String("k8s.pod.name", os.Getenv("POD_NAME")),
		),
		resource.WithFromEnv(),
		resource.WithProcessPID(),
	)
	if err != nil {
		return nil, fmt.Errorf("creating resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter,
			sdktrace.WithBatchTimeout(1*time.Second),
			sdktrace.WithMaxExportBatchSize(512),
		),
		sdktrace.WithResource(res),
		// Head-based sampling at 10% (tail-based sampling in Collector handles the rest)
		sdktrace.WithSampler(sdktrace.ParentBased(
			sdktrace.TraceIDRatioBased(0.10),
		)),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return tp, nil
}

// Example handler with tracing
type PaymentsHandler struct {
	tracer trace.Tracer
	db     *Database
}

func (h *PaymentsHandler) ProcessPayment(w http.ResponseWriter, r *http.Request) {
	ctx, span := h.tracer.Start(r.Context(), "ProcessPayment",
		trace.WithAttributes(
			attribute.String("payment.method", r.Header.Get("X-Payment-Method")),
			attribute.String("payment.currency", r.Header.Get("X-Currency")),
			semconv.HTTPMethod(r.Method),
			semconv.HTTPURL(r.URL.String()),
		),
	)
	defer span.End()

	paymentID := r.PathValue("id")
	span.SetAttributes(attribute.String("payment.id", paymentID))

	// Add a span event for significant milestones
	span.AddEvent("validation_started")
	if err := validatePaymentRequest(ctx, r); err != nil {
		span.SetStatus(codes.Error, err.Error())
		span.RecordError(err)
		http.Error(w, "validation failed", http.StatusBadRequest)
		return
	}
	span.AddEvent("validation_succeeded")

	// Child span for database operation
	result, err := h.db.InsertPayment(ctx, paymentID)
	if err != nil {
		span.SetStatus(codes.Error, "database error")
		span.RecordError(err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	span.SetAttributes(attribute.String("payment.status", result.Status))
	span.SetStatus(codes.Ok, "")
	writeJSON(w, http.StatusCreated, result)
}
```

### Database Span Creation

```go
package database

import (
	"context"
	"database/sql"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"
)

type Database struct {
	db     *sql.DB
	tracer trace.Tracer
}

func NewDatabase(db *sql.DB) *Database {
	return &Database{
		db:     db,
		tracer: otel.Tracer("database"),
	}
}

func (d *Database) InsertPayment(ctx context.Context, paymentID string) (*Payment, error) {
	ctx, span := d.tracer.Start(ctx, "db.InsertPayment",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.DBSystemPostgreSQL,
			semconv.DBName("payments"),
			semconv.DBOperation("INSERT"),
			semconv.DBSQLTable("payments"),
			// Include sanitized query (no values for PII/security)
			attribute.String("db.statement", "INSERT INTO payments (id, status) VALUES ($1, $2)"),
		),
	)
	defer span.End()

	var p Payment
	err := d.db.QueryRowContext(ctx,
		"INSERT INTO payments (id, status, created_at) VALUES ($1, $2, NOW()) RETURNING id, status, created_at",
		paymentID, "pending",
	).Scan(&p.ID, &p.Status, &p.CreatedAt)

	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		span.RecordError(err)
		return nil, fmt.Errorf("inserting payment: %w", err)
	}

	span.SetStatus(codes.Ok, "")
	return &p, nil
}
```

### Java Auto-Instrumentation

The OpenTelemetry Java agent provides zero-code instrumentation for common frameworks:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: java-service
  namespace: orders
spec:
  template:
    spec:
      initContainers:
      # Download the OTel Java agent
      - name: otel-agent-init
        image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
        command: ["cp", "/javaagent.jar", "/otel-auto-instrumentation/javaagent.jar"]
        volumeMounts:
        - name: otel-agent
          mountPath: /otel-auto-instrumentation
      containers:
      - name: java-service
        image: registry.example.com/orders-service:v5.2.0
        env:
        - name: JAVA_TOOL_OPTIONS
          value: "-javaagent:/otel-auto-instrumentation/javaagent.jar"
        - name: OTEL_SERVICE_NAME
          value: "orders-service"
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "http://otel-agent-collector.opentelemetry.svc.cluster.local:4318"
        - name: OTEL_EXPORTER_OTLP_PROTOCOL
          value: "http/protobuf"
        - name: OTEL_LOGS_EXPORTER
          value: "otlp"
        - name: OTEL_METRICS_EXPORTER
          value: "otlp"
        - name: OTEL_TRACES_SAMPLER
          value: "parentbased_traceidratio"
        - name: OTEL_TRACES_SAMPLER_ARG
          value: "0.1"
        volumeMounts:
        - name: otel-agent
          mountPath: /otel-auto-instrumentation
      volumes:
      - name: otel-agent
        emptyDir: {}
```

Alternatively, use the OTel Operator's `Instrumentation` CRD for automatic injection:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-instrumentation
  namespace: orders
spec:
  exporter:
    endpoint: http://otel-agent-collector.opentelemetry.svc.cluster.local:4318
  propagators:
  - tracecontext
  - baggage
  - b3
  sampler:
    type: parentbased_traceidratio
    argument: "0.1"
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
```

Then annotate pods:
```yaml
metadata:
  annotations:
    instrumentation.opentelemetry.io/inject-java: "orders/java-instrumentation"
```

## Sampling Strategies

### Head-Based vs Tail-Based Sampling

**Head-based sampling** makes the keep/drop decision at the start of a trace, before knowing the outcome. Simple to implement, low overhead, but cannot guarantee that error or slow traces are always sampled.

**Tail-based sampling** buffers spans until the full trace completes, then makes the sampling decision based on the actual trace outcome. Can guarantee errors and slow traces are kept. Requires more memory and introduces latency in the export pipeline.

The recommended production approach combines both:

1. **Head sampling in the SDK**: Sample 1-10% of traces to reduce data volume entering the Collector
2. **Tail sampling in the Collector**: Of the sampled traces, keep all errors and slow traces; probabilistically drop the rest

```yaml
# Collector tail sampling policy (as shown in collector config above)
# This layer guarantees important traces are retained regardless of head sampling
policies:
- name: errors-policy
  type: status_code
  status_code:
    status_codes: [ERROR]
- name: slow-traces
  type: latency
  latency:
    threshold_ms: 500
- name: sample-otherwise
  type: probabilistic
  probabilistic:
    sampling_percentage: 10  # Keep 10% of remaining traces
```

### Dynamic Sampling with OpenTelemetry

For services where traffic volume varies dramatically, use a rate-limiting sampler:

```go
// Rate-limiting sampler: keep up to N traces per second
import "go.opentelemetry.io/contrib/samplers/ratelimiting"

sampler := ratelimiting.NewRateLimitingSampler(100) // 100 traces/second
```

## Grafana Tempo Data Source Configuration

```yaml
# Grafana datasource configuration for Tempo
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-tempo-datasource
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  tempo-datasource.yaml: |
    apiVersion: 1
    datasources:
    - name: Tempo
      type: tempo
      url: http://tempo-query-frontend.tempo.svc.cluster.local:3100
      access: proxy
      uid: tempo
      jsonData:
        httpMethod: GET
        tracesToLogsV2:
          # Link traces to Loki logs using trace ID
          datasourceUid: loki
          spanStartTimeShift: "-1m"
          spanEndTimeShift: "1m"
          filterByTraceID: true
          filterBySpanID: false
          customQuery: true
          query: '{namespace="${__span.tags.k8s.namespace.name}", pod="${__span.tags.k8s.pod.name}"} | json | traceID="${__trace.traceId}"'
        tracesToMetrics:
          # Link traces to Prometheus metrics
          datasourceUid: prometheus
          spanStartTimeShift: "-2m"
          spanEndTimeShift: "2m"
          queries:
          - name: Request Rate
            query: 'sum(rate(http_requests_total{job="${__span.tags.service.name}"}[5m]))'
          - name: Error Rate
            query: 'sum(rate(http_requests_total{job="${__span.tags.service.name}",status=~"5.."}[5m]))'
        serviceMap:
          datasourceUid: prometheus
        nodeGraph:
          enabled: true
        search:
          hide: false
        lokiSearch:
          datasourceUid: loki
```

## Tempo Query Language (TraceQL)

Tempo supports TraceQL for querying traces:

```bash
# Find all traces containing error spans from the payments service
{service.name="payments-api" && status=error}

# Find slow database operations
{span.db.system="postgresql" && duration > 500ms}

# Find traces that touched both payments and inventory services
{service.name="payments-api"} && {service.name="inventory-service"}

# Find traces where the checkout span was slow
{span.name="POST /api/checkout" && duration > 2s}

# Aggregate: count of error traces per service over time
{status=error} | count() by (service.name)
```

```bash
# Query from CLI using tempo-query
curl -G http://tempo-query-frontend.tempo.svc.cluster.local:3100/api/search \
  --data-urlencode 'q={service.name="payments-api" && status=error}' \
  --data-urlencode 'start=1733000000' \
  --data-urlencode 'end=1733003600' \
  --data-urlencode 'limit=20' | jq '.traces[] | {traceID, rootName, duration}'
```

## Production Considerations

### Storage Sizing

Tempo stores traces in object storage (S3, GCS, Azure Blob). Estimate storage requirements:

```
traces_per_second × avg_trace_size_bytes × retention_seconds × 1.3 (overhead factor)
```

For a service generating 1000 traces/second, average trace size 2KB, 30-day retention:
```
1000 × 2048 × (30 × 86400) × 1.3 ≈ 6.9 TB
```

Object storage costs for 6.9TB on S3 Standard are approximately $159/month — substantially cheaper than traditional tracing backends.

### Tempo Compactor Tuning

The compactor merges small blocks from the ingester into larger blocks for efficient querying:

```yaml
# In tempo configuration
compactor:
  compaction:
    block_retention: 720h           # 30 days
    compacted_block_retention: 1h   # Keep merged source blocks for 1 hour
    compaction_window: 1h
    v2_in_buffer_bytes: 5242880     # 5MB read buffer
    v2_out_buffer_bytes: 20971520   # 20MB write buffer
    max_compaction_objects: 6000000
    max_block_bytes: 107374182400   # 100GB max block size
  ring:
    kvstore:
      store: memberlist
```

## Conclusion

The OpenTelemetry + Grafana Tempo stack provides enterprise-grade distributed tracing without vendor lock-in. The key implementation decisions:

1. **Use the Collector as a buffer**: Applications send to the local DaemonSet agent; the gateway handles batching, sampling, and retry logic
2. **Combine head and tail sampling**: Head sampling at 1-10% in the SDK reduces data volume; tail sampling in the Collector guarantees errors and slow traces are retained
3. **Enrich spans with K8s metadata**: The `k8sattributes` processor automatically adds namespace, pod, and deployment information without application code changes
4. **Store in object storage**: S3 or GCS is 10-50x cheaper than block storage for trace retention at 30+ days
5. **Enable service graphs**: Tempo's metrics generator creates service topology graphs and RED metrics from trace data, giving you service-level metrics without additional instrumentation
6. **Correlate with Loki and Prometheus**: Configure Grafana datasource links to jump from a slow trace span to the matching log lines and service metrics
