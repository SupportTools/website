---
title: "Kubernetes Tracing: Jaeger Deployment, OpenTelemetry Collector, Tempo, and Sampling Strategies"
date: 2028-08-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Tracing", "Jaeger", "OpenTelemetry", "Tempo", "Observability"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to distributed tracing on Kubernetes. Covers Jaeger deployment, OpenTelemetry Collector configuration, Grafana Tempo integration, sampling strategies, and trace instrumentation in Go."
more_link: "yes"
url: "/kubernetes-tracing-jaeger-otel-tempo-guide/"
---

Distributed tracing is the observability signal that gives you end-to-end visibility across service boundaries. When a user request touches 15 services and one of them is slow, logs and metrics can tell you something is wrong. Only traces tell you exactly which service, which database query, and which code path is the bottleneck. This guide covers the full tracing stack on Kubernetes: OpenTelemetry instrumentation, the OTel Collector, Jaeger and Tempo as backends, and production sampling strategies that capture useful data without overwhelming your storage.

<!--more-->

# [Kubernetes Distributed Tracing](#kubernetes-distributed-tracing)

## Section 1: The OpenTelemetry Standard

OpenTelemetry (OTel) is the CNCF standard for instrumenting applications. It defines:
- **API**: Language-specific interfaces for creating spans, attributes, and baggage
- **SDK**: Implementation of the API with sampling, batching, and exporting
- **OTLP**: The protocol for sending telemetry to collectors and backends
- **Collector**: A pipeline component for receiving, processing, and exporting traces

In 2028, all major tracing backends (Jaeger, Tempo, Zipkin, Datadog) accept OTLP. Instrument once with OTel and you can switch backends without changing application code.

### The Trace Data Model

```
TraceID: 4bf92f3577b34da6a3ce929d0e0e4736
│
└── RootSpan: HTTP POST /orders [service: api-gateway, duration: 245ms]
    │
    ├── Span: AuthService.ValidateToken [service: auth, duration: 12ms]
    │
    └── Span: OrderService.CreateOrder [service: orders, duration: 220ms]
        │
        ├── Span: DB query: INSERT INTO orders [db: postgres, duration: 8ms]
        │   └── Attributes: db.statement, db.rows_affected
        │
        ├── Span: InventoryService.Reserve [service: inventory, duration: 45ms]
        │
        └── Span: OutboxService.WriteEvent [duration: 3ms]
```

## Section 2: OpenTelemetry Collector Deployment

The OTel Collector is the heart of your tracing pipeline. It receives spans from your services, processes them (sampling, attribute enrichment, redaction), and forwards to your backend.

### Collector as DaemonSet (Agent Mode)

```yaml
# otel-collector/configmap.yaml
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

      # Receive from Jaeger agents (legacy)
      jaeger:
        protocols:
          thrift_compact:
            endpoint: 0.0.0.0:6831
          grpc:
            endpoint: 0.0.0.0:14250

      # K8s attributes from kubelet
      kubeletstats:
        auth_type: serviceAccount
        collection_interval: 20s

    processors:
      # Batch spans for efficiency
      batch:
        send_batch_size: 1000
        timeout: 5s
        send_batch_max_size: 2000

      # Memory-based backpressure
      memory_limiter:
        check_interval: 1s
        limit_percentage: 75
        spike_limit_percentage: 25

      # Add K8s metadata to all spans
      k8sattributes:
        auth_type: serviceAccount
        extract:
          metadata:
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.deployment.name
            - k8s.namespace.name
            - k8s.node.name
            - k8s.pod.start_time
          labels:
            - tag_name: app.label.version
              key: version
              from: pod
            - tag_name: app.label.env
              key: environment
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

      # Remove sensitive data
      attributes/redact:
        actions:
          - key: http.request.header.authorization
            action: delete
          - key: db.statement
            action: update
            # Scrub literals from SQL statements
            pattern: '(?i)(password|token|secret)\s*=\s*\S+'
            replacement: '$1=[REDACTED]'

      # Tail-based sampling — evaluate complete traces
      # (use probabilistic sampling for high-volume services)
      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
          # Always sample errors
          - name: errors
            type: status_code
            status_code: { status_codes: [ERROR] }
          # Always sample slow requests (>1s)
          - name: slow
            type: latency
            latency: { threshold_ms: 1000 }
          # Always sample for specific tenants/users
          - name: debug-users
            type: string_attribute
            string_attribute:
              key: user.debug_enabled
              values: ["true"]
          # Sample 10% of everything else
          - name: base-rate
            type: probabilistic
            probabilistic: { sampling_percentage: 10 }

      # Resource detection
      resourcedetection:
        detectors: [k8snode, env, system]
        timeout: 5s
        override: false

    exporters:
      # Primary: Tempo
      otlp/tempo:
        endpoint: tempo-distributor.monitoring:4317
        tls:
          insecure: true

      # Secondary: Jaeger (for teams still using Jaeger UI)
      otlp/jaeger:
        endpoint: jaeger-collector.monitoring:4317
        tls:
          insecure: true

      # Debug exporter (for troubleshooting)
      debug:
        verbosity: basic
        sampling_initial: 5
        sampling_thereafter: 100

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
          receivers: [otlp, jaeger]
          processors: [memory_limiter, k8sattributes, attributes/redact, tail_sampling, batch]
          exporters: [otlp/tempo]
        metrics:
          receivers: [kubeletstats]
          processors: [memory_limiter, resourcedetection, batch]
          exporters: [otlp/tempo]
```

```yaml
# otel-collector/daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-collector
  namespace: monitoring
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
      tolerations:
        - operator: Exists
          effect: NoSchedule
      containers:
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.104.0
          args:
            - --config=/conf/config.yaml
          ports:
            - name: otlp-grpc
              containerPort: 4317
              hostPort: 4317
            - name: otlp-http
              containerPort: 4318
              hostPort: 4318
            - name: jaeger-compact
              containerPort: 6831
              protocol: UDP
              hostPort: 6831
            - name: health
              containerPort: 13133
          volumeMounts:
            - name: config
              mountPath: /conf
          env:
            - name: MY_POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: MY_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          resources:
            requests:
              cpu: 200m
              memory: 400Mi
            limits:
              cpu: 1000m
              memory: 1Gi
          livenessProbe:
            httpGet:
              path: /
              port: 13133
          readinessProbe:
            httpGet:
              path: /
              port: 13133
      volumes:
        - name: config
          configMap:
            name: otel-collector-config
```

## Section 3: Grafana Tempo Deployment

Tempo is Grafana's horizontally scalable, cost-efficient distributed tracing backend. It stores traces in object storage (S3, GCS, Azure Blob) and can be queried directly from Grafana.

### Tempo Helm Deployment

```yaml
# tempo-values.yaml
tempo:
  replicationFactor: 3
  global_overrides:
    defaults:
      ingestion:
        rate_limit_bytes: 15000000   # 15MB/s per tenant
        burst_size_bytes: 20000000
        max_traces_per_user: 0       # 0 = unlimited
      query:
        max_bytes_per_tag_values_query: 5000000
  storage:
    trace:
      backend: s3
      s3:
        bucket: my-tempo-traces
        endpoint: s3.us-east-1.amazonaws.com
        region: us-east-1
        # Use IRSA or instance profile for credentials
        insecure: false
      wal:
        path: /var/tempo/wal
      pool:
        queue_depth: 10000
        max_workers: 100

distributor:
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilizationPercentage: 60

ingester:
  replicas: 3
  resources:
    requests:
      cpu: 1000m
      memory: 2Gi
    limits:
      cpu: 4000m
      memory: 4Gi
  persistence:
    enabled: true
    size: 10Gi
    storageClass: fast-ssd

compactor:
  replicas: 1
  resources:
    requests:
      cpu: 500m
      memory: 1Gi

querier:
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi

queryFrontend:
  replicas: 2
  resources:
    requests:
      cpu: 200m
      memory: 512Mi

traces:
  otlp:
    grpc:
      enabled: true
    http:
      enabled: true
  jaeger:
    grpc:
      enabled: true

metricsGenerator:
  enabled: true  # Generate RED metrics from traces
  replicas: 1
  config:
    storage:
      path: /var/tempo/generator/wal
      remote_write:
        - url: http://prometheus.monitoring:9090/api/v1/write
          send_exemplars: true
```

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
helm upgrade --install tempo grafana/tempo-distributed \
  --namespace monitoring \
  --values tempo-values.yaml \
  --version 1.9.0
```

## Section 4: Jaeger All-in-One for Development

For development clusters, Jaeger all-in-one is easier than Tempo.

```yaml
# jaeger/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger
  template:
    metadata:
      labels:
        app: jaeger
    spec:
      containers:
        - name: jaeger
          image: jaegertracing/all-in-one:1.58
          env:
            - name: COLLECTOR_OTLP_ENABLED
              value: "true"
            - name: SPAN_STORAGE_TYPE
              value: memory
            - name: MEMORY_MAX_TRACES
              value: "50000"
          ports:
            - containerPort: 16686  # UI
            - containerPort: 4317   # OTLP gRPC
            - containerPort: 4318   # OTLP HTTP
            - containerPort: 14250  # Jaeger gRPC
          resources:
            requests:
              cpu: 200m
              memory: 512Mi
            limits:
              cpu: 1000m
              memory: 2Gi
---
apiVersion: v1
kind: Service
metadata:
  name: jaeger
  namespace: monitoring
spec:
  selector:
    app: jaeger
  ports:
    - name: ui
      port: 16686
    - name: otlp-grpc
      port: 4317
    - name: otlp-http
      port: 4318
```

### Production Jaeger with Elasticsearch

```yaml
# jaeger-production/jaeger.yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-production
  namespace: monitoring
spec:
  strategy: production
  storage:
    type: elasticsearch
    options:
      es:
        server-urls: https://elasticsearch.monitoring:9200
        index-prefix: jaeger
        num-shards: 5
        num-replicas: 1
    secretName: jaeger-es-secret
  collector:
    replicas: 3
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 1Gi
    autoscale: true
    minReplicas: 3
    maxReplicas: 10
  query:
    replicas: 2
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
  ingester:
    replicas: 2
    kafka:
      brokers: kafka.monitoring:9092
      topic: jaeger-spans
  sampling:
    options:
      default_strategy:
        type: probabilistic
        param: 0.1
      per_service_strategies:
        - service: payment-service
          type: probabilistic
          param: 1.0  # 100% for payment traces
        - service: api-gateway
          type: rate_limiting
          param: 100  # Max 100 traces/second
```

## Section 5: Instrumenting Go Services with OpenTelemetry

### Dependency Setup

```bash
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/sdk/trace
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc
go get go.opentelemetry.io/otel/propagation
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc
go get go.opentelemetry.io/contrib/instrumentation/database/sql/otelsql
```

### Tracer Initialization

```go
// internal/telemetry/tracer.go
package telemetry

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string
    SampleRate     float64
}

func InitTracer(ctx context.Context, cfg Config) (func(context.Context) error, error) {
    // gRPC connection to OTel Collector
    conn, err := grpc.DialContext(ctx, cfg.OTLPEndpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
        grpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("creating gRPC connection: %w", err)
    }

    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithGRPCConn(conn),
    )
    if err != nil {
        return nil, fmt.Errorf("creating OTLP exporter: %w", err)
    }

    // Service resource attributes
    res, err := resource.Merge(
        resource.Default(),
        resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            attribute.String("deployment.environment", cfg.Environment),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    // Sampler: parent-based so sampling decision propagates
    var sampler sdktrace.Sampler
    if cfg.SampleRate >= 1.0 {
        sampler = sdktrace.AlwaysSample()
    } else if cfg.SampleRate <= 0 {
        sampler = sdktrace.NeverSample()
    } else {
        sampler = sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(cfg.SampleRate),
        )
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sampler),
    )

    // Set global tracer and propagator
    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},   // W3C TraceContext header
        propagation.Baggage{},        // W3C Baggage header
    ))

    return tp.Shutdown, nil
}
```

### HTTP Server Instrumentation

```go
// cmd/server/main.go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"

    "github.com/myorg/myapp/internal/telemetry"
)

var tracer = otel.Tracer("myapp/server")

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    shutdown, err := telemetry.InitTracer(ctx, telemetry.Config{
        ServiceName:    "order-service",
        ServiceVersion: "1.2.3",
        Environment:    os.Getenv("APP_ENV"),
        OTLPEndpoint:   os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        SampleRate:     0.1, // 10% head-based, collector adds tail sampling
    })
    if err != nil {
        log.Fatalf("initializing tracer: %v", err)
    }
    defer shutdown(context.Background())

    mux := http.NewServeMux()

    // Wrap all handlers with OTel HTTP instrumentation
    mux.HandleFunc("/orders", handleCreateOrder)
    mux.HandleFunc("/orders/", handleGetOrder)
    mux.HandleFunc("/health", handleHealth)

    // otelhttp wraps the entire mux — creates spans for every request
    handler := otelhttp.NewHandler(mux, "order-service",
        otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
            // Use route pattern, not full URL (avoids high cardinality)
            return op + " " + r.Method + " " + r.URL.Path
        }),
        otelhttp.WithFilter(func(r *http.Request) bool {
            // Don't trace health checks
            return r.URL.Path != "/health"
        }),
    )

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      handler,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
    }

    go func() {
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("server error: %v", err)
        }
    }()

    <-ctx.Done()
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    srv.Shutdown(shutdownCtx)
}

func handleCreateOrder(w http.ResponseWriter, r *http.Request) {
    ctx, span := tracer.Start(r.Context(), "CreateOrder",
        trace.WithAttributes(
            attribute.String("order.source", r.Header.Get("X-Order-Source")),
        ),
    )
    defer span.End()

    // Business logic...
    order, err := createOrder(ctx)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    // Add result attributes to span
    span.SetAttributes(
        attribute.String("order.id", order.ID),
        attribute.Int64("order.total_cents", order.TotalCents),
    )

    w.WriteHeader(http.StatusCreated)
}

type Order struct {
    ID         string
    TotalCents int64
}

func createOrder(ctx context.Context) (*Order, error) {
    // Simulate work with a child span
    _, span := tracer.Start(ctx, "db.InsertOrder",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.operation", "INSERT"),
            attribute.String("db.table", "orders"),
        ),
    )
    defer span.End()

    return &Order{ID: "order-123", TotalCents: 9900}, nil
}

func handleGetOrder(w http.ResponseWriter, r *http.Request) {}
func handleHealth(w http.ResponseWriter, r *http.Request)   { w.WriteHeader(200) }
```

### Database Tracing with otelsql

```go
// internal/database/db.go
package database

import (
    "context"
    "database/sql"
    "fmt"

    "go.opentelemetry.io/contrib/instrumentation/database/sql/otelsql"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    _ "github.com/lib/pq"
)

func Open(dsn string) (*sql.DB, error) {
    // Register the wrapped driver
    driverName, err := otelsql.Register("postgres",
        otelsql.WithAttributes(
            semconv.DBSystemPostgreSQL,
        ),
        otelsql.WithTracerProvider(nil), // uses global provider
        otelsql.WithSQLCommenter(true),   // adds trace context to SQL comments
        otelsql.WithSpanOptions(otelsql.SpanOptions{
            // Include SELECT statements in traces
            DisableErrSkip: true,
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("registering otelsql driver: %w", err)
    }

    db, err := sql.Open(driverName, dsn)
    if err != nil {
        return nil, fmt.Errorf("opening database: %w", err)
    }

    // Record connection pool stats as metrics
    if err := otelsql.RecordStats(db); err != nil {
        return nil, fmt.Errorf("recording db stats: %w", err)
    }

    return db, nil
}

// ExecWithTrace wraps a query with explicit span attributes
func ExecWithTrace(ctx context.Context, db *sql.DB, query string, args ...interface{}) (sql.Result, error) {
    return db.ExecContext(ctx, query, args...)
    // otelsql automatically creates a span for this
}
```

### gRPC Tracing

```go
// internal/grpc/client.go
package grpcutil

import (
    "context"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

func NewClient(ctx context.Context, target string) (*grpc.ClientConn, error) {
    return grpc.DialContext(ctx, target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithStatsHandler(otelgrpc.NewClientHandler(
            otelgrpc.WithTracerProvider(nil), // uses global
            otelgrpc.WithPropagators(nil),    // uses global
        )),
    )
}

// internal/grpc/server.go
func NewServer() *grpc.Server {
    return grpc.NewServer(
        grpc.StatsHandler(otelgrpc.NewServerHandler()),
    )
}
```

### HTTP Client Tracing

```go
// internal/httpclient/client.go
package httpclient

import (
    "net/http"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func New() *http.Client {
    return &http.Client{
        Transport: otelhttp.NewTransport(http.DefaultTransport,
            otelhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
                return r.Method + " " + r.URL.Host + r.URL.Path
            }),
        ),
        Timeout: 30 * time.Second,
    }
}
```

## Section 6: Sampling Strategies

Getting sampling right is the hardest operational challenge in tracing. Too little sampling and you miss rare errors. Too much and you overwhelm your backend and spend a fortune on storage.

### Head-Based Sampling

Sampling decision made at the first span — before the trace is complete.

```go
// Pros: Simple, low overhead
// Cons: Cannot selectively sample based on errors or latency

// Always sample errors — set trace flag before propagating
func SamplingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        span := trace.SpanFromContext(r.Context())

        // Force sampling for debug requests
        if r.Header.Get("X-Debug-Trace") == "true" {
            span.SetAttributes(attribute.Bool("sampling.force", true))
        }

        rw := &responseWriter{ResponseWriter: w}
        next.ServeHTTP(rw, r)

        // Record error status
        if rw.statusCode >= 500 {
            span.SetStatus(codes.Error, fmt.Sprintf("HTTP %d", rw.statusCode))
        }
    })
}
```

### Tail-Based Sampling in the Collector

The OTel Collector's `tail_sampling` processor buffers complete traces and then makes sampling decisions:

```yaml
# Advanced tail sampling policy
tail_sampling:
  decision_wait: 10s   # Buffer traces for 10s before deciding
  num_traces: 100000   # Max traces in memory
  expected_new_traces_per_sec: 1000
  policies:
    # Policy 1: Always sample errors
    - name: error-policy
      type: status_code
      status_code:
        status_codes: [ERROR]

    # Policy 2: Always sample traces involving payment service
    - name: payment-traces
      type: string_attribute
      string_attribute:
        key: service.name
        values: ["payment-service"]
        enabled_for_root_spans_only: false

    # Policy 3: Sample traces slower than 500ms
    - name: slow-traces
      type: latency
      latency:
        threshold_ms: 500

    # Policy 4: Composite — error OR slow
    - name: error-or-slow
      type: composite
      composite:
        max_total_spans_per_second: 1000
        policy_order: [errors-inner, slow-inner]
        composite_sub_policy:
          - name: errors-inner
            type: status_code
            status_code:
              status_codes: [ERROR]
          - name: slow-inner
            type: latency
            latency:
              threshold_ms: 200
        rate_allocation:
          - policy: errors-inner
            percent: 50
          - policy: slow-inner
            percent: 50

    # Policy 5: Base rate for everything else (1%)
    - name: base-rate
      type: probabilistic
      probabilistic:
        sampling_percentage: 1
```

### Adaptive Sampling

For high-volume services, use rate-limiting to cap trace volume:

```go
// internal/telemetry/sampler.go
package telemetry

import (
    "sync"
    "time"

    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/sdk/trace"
)

// RateLimitingSampler limits traces to N per second
type RateLimitingSampler struct {
    mu       sync.Mutex
    limit    int     // per second
    tokens   float64
    lastTime time.Time
}

func NewRateLimitingSampler(tracesPerSecond int) sdktrace.Sampler {
    return &RateLimitingSampler{
        limit:    tracesPerSecond,
        tokens:   float64(tracesPerSecond),
        lastTime: time.Now(),
    }
}

func (s *RateLimitingSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Always sample if parent is sampled
    if p.ParentContext.HasRemote() {
        if p.ParentContext.IsSampled() {
            return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
        }
        return sdktrace.SamplingResult{Decision: sdktrace.Drop}
    }

    s.mu.Lock()
    defer s.mu.Unlock()

    now := time.Now()
    elapsed := now.Sub(s.lastTime).Seconds()
    s.lastTime = now
    s.tokens += elapsed * float64(s.limit)
    if s.tokens > float64(s.limit) {
        s.tokens = float64(s.limit)
    }

    if s.tokens >= 1 {
        s.tokens--
        return sdktrace.SamplingResult{
            Decision: sdktrace.RecordAndSample,
            Attributes: []attribute.KeyValue{
                attribute.String("sampling.strategy", "rate_limited"),
            },
        }
    }

    return sdktrace.SamplingResult{Decision: sdktrace.Drop}
}

func (s *RateLimitingSampler) Description() string {
    return fmt.Sprintf("RateLimitingSampler{limit=%d/s}", s.limit)
}
```

## Section 7: Grafana Integration

### Tempo Data Source Configuration

```yaml
# grafana/datasources/tempo.yaml
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    url: http://tempo-query-frontend.monitoring:3100
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki-uid
        spanStartTimeShift: "-1m"
        spanEndTimeShift: "1m"
        filterByTraceID: true
        filterBySpanID: false
        customQuery: true
        query: '{namespace="${__span.tags.k8s.namespace.name}"} |= "${__span.traceId}"'
      tracesToMetrics:
        datasourceUid: prometheus-uid
        spanStartTimeShift: "-2m"
        spanEndTimeShift: "2m"
        tags:
          - key: service.name
            value: service
        queries:
          - name: Request Rate
            query: 'rate(traces_spanmetrics_calls_total{$$__tags}[5m])'
          - name: Error Rate
            query: 'rate(traces_spanmetrics_calls_total{$$__tags, status_code="STATUS_CODE_ERROR"}[5m])'
          - name: P99 Latency
            query: 'histogram_quantile(0.99, sum(rate(traces_spanmetrics_duration_milliseconds_bucket{$$__tags}[5m])) by (le))'
      serviceMap:
        datasourceUid: prometheus-uid
      search:
        hide: false
      nodeGraph:
        enabled: true
      lokiSearch:
        datasourceUid: loki-uid
```

### Trace-Based Alerting with Tempo

```yaml
# grafana/alerts/trace-error-rate.yaml
apiVersion: 1
groups:
  - name: trace-based
    rules:
      - uid: trace-error-rate
        title: High Trace Error Rate
        condition: C
        data:
          - refId: A
            datasourceUid: prometheus-uid
            model:
              expr: |
                sum(rate(traces_spanmetrics_calls_total{
                  span_kind="SPAN_KIND_SERVER",
                  status_code="STATUS_CODE_ERROR"
                }[5m])) by (service_name)
                / sum(rate(traces_spanmetrics_calls_total{
                  span_kind="SPAN_KIND_SERVER"
                }[5m])) by (service_name) * 100
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              conditions:
                - params: [1]  # Alert if >1% error rate
                  op: gt
        execErrState: Alerting
        for: 5m
        annotations:
          summary: "Service {{ $labels.service_name }} trace error rate >1%"
```

## Conclusion

A production tracing setup requires thinking about the full pipeline: instrumentation in the application, the OTel Collector for sampling and enrichment, and a backend sized for your trace volume. Start with a simple head-based sample rate of 10% and add tail-based sampling policies for errors and slow requests. This typically captures 95% of interesting traces at 10-20% of the storage cost of 100% sampling.

Use Tempo for cost-effective long-term storage with S3, and Jaeger when you need its rich UI during active incident investigation. Wire both together through the OTel Collector so you can route to either backend without changing application code.
