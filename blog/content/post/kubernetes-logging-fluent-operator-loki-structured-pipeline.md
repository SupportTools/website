---
title: "Kubernetes Logging Architecture: Fluent Operator, Loki, and Structured Log Pipeline"
date: 2030-04-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Logging", "Fluent Operator", "Loki", "Grafana", "Observability", "Fluentd", "FluentBit"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Kubernetes log pipeline with Fluent Operator (successor to Fluentd operator): multiline log handling, log routing by namespace and label, Loki label strategy, log-based alerting with Grafana, and structured logging patterns."
more_link: "yes"
url: "/kubernetes-logging-fluent-operator-loki-structured-pipeline/"
---

Kubernetes logging is deceptively complex. Applications write to stdout, the container runtime writes to files on the node, and someone needs to collect those files, parse them, route them, and make them searchable. The naive approach — deploy Fluentd as a DaemonSet, point it at Elasticsearch — works until you have 500 nodes and 10,000 pods generating 100 GB of logs per day. Then you discover that your parsing rules handle only 70% of log formats, multiline Java stack traces are split across records, and your Elasticsearch cluster is perpetually under-resourced. Fluent Operator (successor to the Fluentd Operator) combined with Loki provides a Kubernetes-native, operationally manageable log pipeline. This guide covers the complete production setup.

<!--more-->

## Architecture Overview

The Fluent Operator architecture separates log collection from log aggregation:

```
Pod stdout/stderr
        |
        v
Container runtime writes to: /var/log/pods/<pod>/<container>/*.log
        |
        v
Fluent Bit DaemonSet (one per node)
  - CRDs: FluentBit, FluentBitConfig, ClusterInput, ClusterFilter, ClusterOutput
  - Tail plugin: reads node log files
  - Kubernetes filter: enriches with pod/namespace metadata
  - Multiline filter: reassembles split log records
  - Routes to: FluentD (for complex processing) or Loki directly
        |
        v
FluentD Deployment (optional aggregation layer)
  - CRDs: Fluentd, FluentdConfig, ClusterFilter, ClusterOutput
  - Record transformer: field manipulation
  - Router: route by namespace/label to different outputs
  - Buffer: disk-backed queue for durability
        |
        +-----> Loki (primary: all namespaces)
        +-----> Elasticsearch (secondary: specific namespaces)
        +-----> S3 (archive: all namespaces)
        |
        v
Grafana
  - Loki data source
  - Log dashboards
  - Log-based alerting rules
```

## Installing Fluent Operator

```bash
# Add the Kubesphere Helm repository (Fluent Operator maintainer)
helm repo add fluent https://fluent.github.io/helm-charts
helm repo update

# Install Fluent Operator with both FluentBit and Fluentd
helm upgrade --install fluent-operator fluent/fluent-operator \
    --namespace logging \
    --create-namespace \
    --version 3.0.0 \
    --set fluentbit.enable=true \
    --set fluentd.enable=true \
    --set fluentd.replicaCount=2 \
    --wait

# Verify installation
kubectl get pods -n logging
# NAME                                 READY   STATUS    RESTARTS   AGE
# fluent-bit-xxxx                      1/1     Running   0          2m
# fluent-operator-xxxxxxx              1/1     Running   0          2m
# fluentd-0                            1/1     Running   0          2m

# Check CRDs
kubectl get crd | grep fluent
# clusterfilters.fluentbit.fluent.io
# clusterinputs.fluentbit.fluent.io
# clusteroutputs.fluentbit.fluent.io
# fluentbitconfigs.fluentbit.fluent.io
# fluentbits.fluentbit.fluent.io
# ...
```

## FluentBit Configuration

### ClusterInput: Tailing Pod Logs

```yaml
# fluent-bit-input.yaml
apiVersion: fluentbit.fluent.io/v1alpha2
kind: ClusterInput
metadata:
  name: tail-pod-logs
  labels:
    fluentbit.fluent.io/enabled: "true"
spec:
  tail:
    # Path pattern for Kubernetes pod logs
    path: /var/log/containers/*.log
    # Exclude the logging namespace itself to prevent feedback loops
    excludePath: /var/log/containers/*logging*.log
    # Tag format: kube.<namespace>.<pod>.<container>
    tag: kube.*
    # Use CRI parser for containerd log format
    parser: cri
    # Memory-efficient configuration
    memBufLimit: 50MB
    skipLongLines: "On"
    # Refresh interval for new log files
    refreshInterval: 10
    # Store position to resume after restart
    db: /fluent-bit/tail/pos.db
    dbSync: Normal
```

### Kubernetes Metadata Enrichment Filter

```yaml
# fluent-bit-kubernetes-filter.yaml
apiVersion: fluentbit.fluent.io/v1alpha2
kind: ClusterFilter
metadata:
  name: kubernetes-metadata
  labels:
    fluentbit.fluent.io/enabled: "true"
spec:
  match: "kube.*"
  filters:
  - kubernetes:
      # Extract pod metadata from the API server
      kubeURL: https://kubernetes.default.svc:443
      kubeCAFile: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      kubeTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
      # Add these fields from pod labels/annotations to the log record
      labels: "On"
      annotations: "Off"
      # Merge JSON logs with the fluentbit record
      mergeLog: "On"
      mergeLogKey: log_processed
      # Keep original log field after merge
      keepLog: "Off"
      # Use pod name as the buffer key for ordering
      kubeTagPrefix: kube.var.log.containers.
```

### Multiline Log Handling

```yaml
# fluent-bit-multiline-filter.yaml
# Handle Java stack traces, Python tracebacks, Go panics
apiVersion: fluentbit.fluent.io/v1alpha2
kind: ClusterFilter
metadata:
  name: multiline-stack-traces
  labels:
    fluentbit.fluent.io/enabled: "true"
spec:
  match: "kube.*"
  filters:
  - multilineParser:
      # Use built-in Java multiline parser
      # Other builtins: go, python, ruby, docker
      parser: java
      # Flush incomplete multiline records after 5 seconds
      flushTimeout: 5000

---
# Custom multiline parser for application-specific formats
apiVersion: fluentbit.fluent.io/v1alpha2
kind: ClusterMultilineParser
metadata:
  name: my-app-multiline
spec:
  type: regex
  flushTimeout: 5000
  rules:
  # Start of a new log entry: begins with ISO8601 timestamp
  - stateName: start_state
    regex: '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/'
    nextState: cont
  # Continuation: any line not starting with a timestamp
  - stateName: cont
    regex: '/^(?!\d{4}-\d{2}-\d{2}T)/'
    nextState: cont
```

### Log Routing by Namespace

```yaml
# fluent-bit-output-to-fluentd.yaml
# Send all logs to FluentD for further routing
apiVersion: fluentbit.fluent.io/v1alpha2
kind: ClusterOutput
metadata:
  name: to-fluentd
  labels:
    fluentbit.fluent.io/enabled: "true"
spec:
  match: "kube.*"
  forward:
    host: fluentd.logging.svc.cluster.local
    port: 24224
    # Enable shared key authentication
    sharedKey: <fluentd-shared-key>
    # TLS for secure transport
    tls:
      verify: "On"
    # Compression
    compress: gzip
```

## FluentD Aggregation Layer

### FluentD DaemonSet Configuration

```yaml
# fluentd-config.yaml
apiVersion: fluentd.fluent.io/v1alpha1
kind: FluentdConfig
metadata:
  name: main-pipeline
  namespace: logging
spec:
  clusterFilterSelector:
    matchLabels:
      fluentd.fluent.io/enabled: "true"
  clusterOutputSelector:
    matchLabels:
      fluentd.fluent.io/enabled: "true"
```

### Namespace-Based Log Routing

```yaml
# fluentd-routing.yaml
# Route logs to different backends based on namespace
apiVersion: fluentd.fluent.io/v1alpha1
kind: ClusterFilter
metadata:
  name: route-by-namespace
  labels:
    fluentd.fluent.io/enabled: "true"
spec:
  filters:
  - recordTransformer:
      records:
      # Add routing tag based on namespace
      - key: routing_tag
        value: >
          ${record["kubernetes"]["namespace_name"] == "production" ?
            "prod" :
            record["kubernetes"]["namespace_name"].start_with?("staging") ?
              "staging" :
              "dev"}
---
# Route production logs to Loki + S3
apiVersion: fluentd.fluent.io/v1alpha1
kind: ClusterOutput
metadata:
  name: loki-all
  labels:
    fluentd.fluent.io/enabled: "true"
spec:
  outputs:
  - loki:
      # Loki endpoint
      url: http://loki.monitoring.svc.cluster.local:3100
      # Labels that become Loki stream labels
      # CRITICAL: keep this set small - each unique combination creates a new stream
      labels:
        namespace: $.kubernetes.namespace_name
        app: $.kubernetes.labels.app
        # Don't use pod name as a label - creates too many streams
      # Extra fields become log metadata (indexed but not stream-creating)
      extraLabels:
        job: kubernetes
        cluster: production
        node: $.kubernetes.host
      # Line format: JSON for structured logs
      lineFormat: json
      # Remove kubernetes metadata fields that are already in labels
      removeKeys:
      - kubernetes
      - docker
      - stream
      # Buffering for reliability
      buffer:
        type: file
        path: /fluentd/log/loki-buffer
        flushInterval: 10s
        retryMaxInterval: 300s
        chunkLimitSize: 5m
        queueLimitLength: 512
        overflowAction: block
```

### High-Performance Fluentd Buffer Configuration

```yaml
# Production buffer configuration for high-volume environments
apiVersion: fluentd.fluent.io/v1alpha1
kind: ClusterOutput
metadata:
  name: loki-production-tuned
  labels:
    fluentd.fluent.io/enabled: "true"
spec:
  outputs:
  - loki:
      url: http://loki.monitoring.svc.cluster.local:3100
      labels:
        namespace: $.kubernetes.namespace_name
        app: $.kubernetes.labels.app
      lineFormat: json
      buffer:
        type: file
        path: /fluentd/log/buffer/loki
        # Number of threads flushing the buffer
        flushThreadCount: 4
        # Flush every 5 seconds
        flushInterval: 5s
        # Flush immediately when chunk reaches this size
        chunkLimitSize: 10m
        # Total buffered size limit
        totalLimitSize: 8g
        # Retry behavior
        retryType: exponential_backoff
        retryWait: 1s
        retryMaxInterval: 60s
        retryTimeout: 72h
        # When buffer is full: block input (back-pressure)
        overflowAction: block
```

## Loki Configuration

### Production Loki Helm Values

```yaml
# loki-values.yaml
loki:
  # Single binary for small clusters, distributed for large ones
  deploymentMode: SimpleScalable

  auth_enabled: false  # enable for multi-tenant production

  # Schema configuration - CRITICAL for performance
  schemaConfig:
    configs:
    - from: "2025-01-01"
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_index_
        period: 24h

  # Storage configuration
  storage:
    type: s3
    bucketNames:
      chunks: loki-chunks-prod
      ruler: loki-ruler-prod
      admin: loki-admin-prod
    s3:
      region: us-east-1
      # Use IRSA in EKS - no credentials needed here

  # Ingester configuration
  ingester:
    chunk_idle_period: 30m
    chunk_block_size: 262144  # 256KB
    chunk_target_size: 1572864  # 1.5MB
    chunk_retain_period: 1m
    max_transfer_retries: 0

  # Query performance
  query_range:
    results_cache:
      cache:
        enable_fifocache: true
        fifocache:
          max_size_bytes: 500MB
          validity: 24h

  # Retention
  compactor:
    retention_enabled: true
    retention_delete_delay: 2h
    retention_delete_worker_count: 150

  # Ruler for log-based alerting
  ruler:
    storage:
      type: local
      local:
        directory: /var/loki/ruler
    rule_path: /tmp/loki/rules
    alertmanager_url: http://alertmanager.monitoring.svc.cluster.local:9093
    enable_api: true
    enable_alertmanager_v2: true

# Common retention
commonConfig:
  replication_factor: 1

# Limits for multi-tenant or high-volume environments
limits_config:
  # Per-tenant ingestion rate limit
  ingestion_rate_mb: 50
  ingestion_burst_size_mb: 100
  # Max label name length
  max_label_name_length: 1024
  # Max labels per series
  max_label_names_per_series: 30
  # Query time range limit
  max_query_length: 721h  # 30 days
  # Max entries per query
  max_entries_limit_per_query: 50000
  # Reject logs older than this
  reject_old_samples: true
  reject_old_samples_max_age: 168h  # 7 days
```

### Loki Label Strategy

The most important Loki performance decision is your label set. Labels create streams; each stream is an independent B-tree. Too many labels = too many streams = poor write performance and high memory usage.

```yaml
# Good Loki labels (low cardinality, useful for filtering):
# - namespace: production, staging, dev
# - app: frontend, api, worker
# - cluster: us-east, us-west, eu-west

# BAD Loki labels (high cardinality):
# - pod_name: frontend-7d4c9b-xxxxx (changes every deployment)
# - request_id: uuid per request (unbounded cardinality)
# - user_id: per-user (unbounded)

# Instead, put high-cardinality fields in the log LINE, not the label:
# These are searchable via regex and JSON queries:
# {namespace="production", app="api"} | json | request_id="abc123"
# {namespace="production"} | json | user_id="12345"
```

## Grafana Log Queries and Dashboards

### LogQL Reference for Kubernetes

```logql
# Basic log query
{namespace="production", app="api"}

# Filter by log content (fast: uses indexed labels + log stream)
{namespace="production", app="api"} |= "error"

# Regex filter
{namespace="production"} |~ "ERROR|FATAL|PANIC"

# JSON parsing (structured logs)
{namespace="production", app="api"} | json

# Extract specific JSON fields
{namespace="production", app="api"} 
  | json 
  | level="error"
  | line_format "{{.timestamp}} {{.message}} latency={{.latency_ms}}ms"

# Metric query: error rate per minute
sum(rate({namespace="production"} |= "error" [1m])) by (app)

# Top 10 slowest requests
{namespace="production", app="api"}
  | json
  | latency_ms > 1000
  | sort desc by latency_ms
  | limit 100

# Log volume by namespace
sum by (namespace) (
  count_over_time({namespace=~".+"}[5m])
)

# Error spike detection: rate > 10x baseline
(
  sum(rate({namespace="production"} |= "error" [5m])) by (app)
  /
  sum(rate({namespace="production"} |= "error" [30m])) by (app)
) > 10

# Kubernetes audit log query
{namespace="kube-system"} 
  | json 
  | objectRef_resource="secrets"
  | verb="delete"
```

## Log-Based Alerting with Loki Ruler

```yaml
# loki-alerting-rules.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-rules
  namespace: monitoring
  labels:
    # Loki ruler discovers rules via this label
    app: loki
    component: ruler
data:
  production-alerts.yaml: |
    groups:
    - name: production-log-alerts
      interval: 1m
      rules:
      
      # Alert on high error rate
      - alert: HighErrorRate
        expr: |
          (
            sum(rate({namespace="production"} |= "error" [5m])) by (app)
            /
            sum(rate({namespace="production"} [5m])) by (app)
          ) > 0.05
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "High error rate in {{ $labels.app }}"
          description: "{{ $labels.app }} has error rate {{ $value | humanizePercentage }}"
          runbook: "https://wiki.example.com/runbooks/high-error-rate"
      
      # Alert on application panic/crash
      - alert: ApplicationPanic
        expr: |
          sum(count_over_time({namespace="production"} 
            |~ "panic|PANIC|fatal error|stack overflow" [5m])) by (app) > 0
        for: 0m  # immediate
        labels:
          severity: critical
          team: oncall
        annotations:
          summary: "Panic detected in {{ $labels.app }}"
          description: "Application panic in namespace production, app {{ $labels.app }}"
      
      # Alert on OOM kills in pod logs
      - alert: OOMKillDetected
        expr: |
          count_over_time({namespace="kube-system"} 
            |= "OOMKilling" [5m]) > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "OOM kill detected on a node"
      
      # Alert on slow database queries
      - alert: SlowDatabaseQueries
        expr: |
          sum(count_over_time({namespace="production", app="api"} 
            | json 
            | db_query_time_ms > 5000 [5m])) by (app) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Slow DB queries in {{ $labels.app }}"
      
      # Absence alert: no logs in 5 minutes (app crashed silently)
      - alert: ServiceSilent
        expr: |
          absent_over_time({namespace="production", app="api"}[5m])
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "No logs from api for 5 minutes"
          description: "The api service may have crashed - no logs received"
```

## Application-Side Structured Logging

The log pipeline is only as good as the logs that flow through it. Structured logging at the application level enables rich LogQL queries.

### Go Structured Logging with slog

```go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "time"
)

func setupLogger() *slog.Logger {
    // JSON output for production
    opts := &slog.HandlerOptions{
        Level:     slog.LevelInfo,
        AddSource: true, // include file:line in every log record
    }
    handler := slog.NewJSONHandler(os.Stdout, opts)
    return slog.New(handler)
}

// contextLogger retrieves the logger from context (request-scoped logging)
type contextKey struct{}

func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
    return context.WithValue(ctx, contextKey{}, logger)
}

func LoggerFrom(ctx context.Context) *slog.Logger {
    if l, ok := ctx.Value(contextKey{}).(*slog.Logger); ok {
        return l
    }
    return slog.Default()
}

// HTTP middleware: adds request-scoped logger with trace context
func LoggingMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Build request-scoped logger
        reqLogger := logger.With(
            slog.String("method",  r.Method),
            slog.String("path",    r.URL.Path),
            slog.String("remote",  r.RemoteAddr),
            slog.String("request_id", r.Header.Get("X-Request-ID")),
            slog.String("trace_id",   r.Header.Get("X-Trace-ID")),
        )

        // Inject into context
        ctx := WithLogger(r.Context(), reqLogger)

        // Capture response code
        rw := &responseWriter{ResponseWriter: w, status: 200}
        next.ServeHTTP(rw, r.WithContext(ctx))

        // Log request completion
        reqLogger.Info("request completed",
            slog.Int("status",       rw.status),
            slog.Int64("latency_ms", time.Since(start).Milliseconds()),
            slog.Int64("bytes",      rw.bytes),
        )
    })
}

type responseWriter struct {
    http.ResponseWriter
    status int
    bytes  int64
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.status = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytes += int64(n)
    return n, err
}

// Handler using context logger
func handleRequest(w http.ResponseWriter, r *http.Request) {
    logger := LoggerFrom(r.Context())

    // Log with business context
    logger.Info("processing order",
        slog.String("order_id",  "ORD-12345"),
        slog.String("user_id",   "USR-42"),
        slog.Float64("amount",   99.99),
    )

    // Log errors with context
    if err := processOrder(r.Context()); err != nil {
        logger.Error("order processing failed",
            slog.String("order_id", "ORD-12345"),
            slog.String("error",    err.Error()),
            slog.String("stage",    "payment"),
        )
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }

    w.WriteHeader(http.StatusOK)
}

func processOrder(ctx context.Context) error { return nil }

func main() {
    logger := setupLogger()
    slog.SetDefault(logger)

    mux := http.NewServeMux()
    mux.HandleFunc("/order", handleRequest)

    handler := LoggingMiddleware(logger, mux)

    logger.Info("server starting",
        slog.String("addr",    ":8080"),
        slog.String("version", "1.2.3"),
    )

    if err := http.ListenAndServe(":8080", handler); err != nil {
        logger.Error("server failed", slog.String("error", err.Error()))
        os.Exit(1)
    }
}
```

### Expected Log Output (JSON)

```json
{
  "time": "2030-04-21T10:30:00.123456789Z",
  "level": "INFO",
  "source": {"function": "main.handleRequest", "file": "main.go", "line": 65},
  "msg": "processing order",
  "method": "POST",
  "path": "/order",
  "remote": "10.0.0.1:54321",
  "request_id": "req-abc123",
  "trace_id": "trace-xyz789",
  "order_id": "ORD-12345",
  "user_id": "USR-42",
  "amount": 99.99
}
```

## Production Operations

### Log Volume Management

```bash
# Check current ingestion rate per namespace
kubectl exec -n monitoring loki-0 -- \
    wget -qO- "http://localhost:3100/loki/api/v1/query?query=sum(rate({namespace=~\".%2B\"}[5m]))by(namespace)&limit=20"

# Check Loki storage usage
kubectl exec -n monitoring loki-0 -- \
    du -sh /var/loki/chunks/

# Check FluentD buffer utilization
kubectl exec -n logging fluentd-0 -- \
    fluent-ctl count-output-queue

# Check FluentBit metrics
kubectl port-forward -n logging daemonset/fluent-bit 2020:2020
curl http://localhost:2020/api/v1/metrics/prometheus | \
    grep fluentbit_output
```

### Grafana Dashboard for Log Pipeline Health

```json
{
  "title": "Log Pipeline Health",
  "panels": [
    {
      "title": "Log Ingestion Rate",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum(rate({namespace=~\".+\"}[1m])) by (namespace)",
          "legendFormat": "{{namespace}}"
        }
      ]
    },
    {
      "title": "FluentBit Drop Rate",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(rate(fluentbit_output_dropped_records_total[5m]))"
        }
      ],
      "thresholds": {"steps": [{"color": "green", "value": 0}, {"color": "red", "value": 1}]}
    },
    {
      "title": "Loki Ingestion Errors",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum(rate(loki_discarded_samples_total[1m])) by (reason)"
        }
      ]
    }
  ]
}
```

## Key Takeaways

The Fluent Operator + Loki stack provides a cloud-native, Kubernetes-native log pipeline that is both operationally manageable and cost-effective at scale.

**Fluent Operator CRD-based configuration**: Unlike raw FluentBit/Fluentd configuration files managed via ConfigMaps, Fluent Operator CRDs enable per-namespace log configuration, GitOps workflows, and validation at admission time. Application teams can manage their own `Filter` and `Output` resources without access to the logging namespace.

**Multiline log handling**: Configure multiline parsers in FluentBit, not FluentD. FluentBit is closer to the source (running on the same node) and handles multiline before the logs cross a network. Use the built-in parsers for Java/Go/Python and create custom parsers for application-specific formats.

**Loki label cardinality**: The most common Loki performance problem is label explosion. Keep labels to: `namespace`, `app`, and optionally `cluster`. Everything else goes in the log line and is queried via `| json` or `| logfmt`. Pod names, request IDs, and user IDs must never be labels.

**Log-based alerting**: Loki's ruler enables alerts on log patterns without exporting metrics. Use this for: error rate spikes, panic detection, absence detection, and compliance-related pattern matching. Combine with metric-based alerts for comprehensive coverage.

**Structured logging**: The value of a log pipeline is directly proportional to the quality of the logs it processes. Invest in structured (JSON) logging at the application layer. Each log record should include: timestamp, level, message, request ID, trace ID, and relevant business context. This makes LogQL queries precise and dashboards meaningful.

**Buffer tuning**: FluentD's file-backed buffer is critical for durability. Size `total_limit_size` to accommodate at least 1 hour of log volume at peak rate. Use `overflow_action: block` rather than `drop_oldest_chunk` in production to prevent silent data loss.
