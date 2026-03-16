---
title: "Grafana Loki on Kubernetes: Log Aggregation, Query Optimization, and Production Scaling"
date: 2027-06-08T00:00:00-05:00
draft: false
tags: ["Loki", "Grafana", "Logging", "Kubernetes", "Observability", "LogQL"]
categories: ["Monitoring", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Grafana Loki on Kubernetes covering architecture modes, Promtail/Vector log collection, LogQL query optimization, object storage backends, chunk and index cache tuning, multi-tenancy, and log-based alerting with the Ruler."
more_link: "yes"
url: "/loki-log-aggregation-kubernetes-guide/"
---

Grafana Loki brings a fundamentally different approach to log aggregation: index the metadata (labels), not the log content. This design decision makes Loki dramatically cheaper to operate at scale compared to Elasticsearch or Splunk while still providing powerful log querying capabilities through LogQL. However, Loki's design also introduces constraints that must be understood to deploy it effectively in production: label cardinality matters enormously, query patterns must work with Loki's index structure, and retention and cache configuration directly impact query performance and cost.

This guide covers the complete production deployment of Grafana Loki on Kubernetes, from architecture selection through log collection pipeline design, LogQL optimization, object storage configuration, and multi-tenant operations.

<!--more-->

## Loki Architecture

Loki is composed of multiple components that can be deployed as a monolith, in Simple Scalable mode, or as fully independent microservices.

### Core Components

**Distributor**

Receives log streams from Promtail, Fluentbit, Vector, and other agents. Validates incoming log data, applies rate limiting, and distributes to ingesters via consistent hashing. Stateless - scales horizontally.

**Ingester**

Stores log streams in memory (in-memory chunks) before flushing to object storage. Each ingester owns a range of the hash ring. Write ahead log (WAL) provides durability. Stateful - requires careful scaling and draining.

**Querier**

Executes LogQL queries against both the ingester (for recent data) and the object storage backend (for historical data). Stateless - scales horizontally based on query load.

**Query Frontend**

Splits large queries into smaller sub-queries and dispatches them to queriers in parallel. Caches query results. Stateless.

**Query Scheduler**

Manages the queue of query sub-requests between the query frontend and queriers. Enables fair scheduling across tenants.

**Compactor**

Merges small index files from ingesters into larger, more efficient tables. Applies retention policies by deleting old chunks. Runs as a singleton.

**Ruler**

Evaluates LogQL alert and recording rules, generating Prometheus-compatible alerts and metrics from log data.

### Deployment Modes

#### Monolithic Mode

All components run in a single process. Suitable for development and small deployments (< 20GB/day ingestion).

```yaml
# values-monolithic.yaml for Loki Helm chart
loki:
  auth_enabled: false
  commonConfig:
    replication_factor: 1
  storage:
    type: filesystem  # or s3 for production

deploymentMode: SingleBinary

singleBinary:
  replicas: 1
```

#### Simple Scalable Mode (Recommended for Most Production)

Read and write paths are separated into two deployable sets. Write path: Distributor + Ingester. Read path: Querier + Query Frontend + Query Scheduler + Ruler + Compactor.

```
                    ┌─────────────────────┐
Log Agents ────────►│ Distributor (3-5)   │
                    └─────────┬───────────┘
                              │ hash ring
                    ┌─────────▼───────────┐
                    │ Ingester (3-5)      │──► S3/GCS/Azure
                    └─────────────────────┘

Client Queries ────►┌─────────────────────┐
                    │ Query Frontend (2)  │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │ Querier (3-10)      │◄── S3/GCS/Azure
                    └─────────────────────┘
```

```bash
# Install Loki in Simple Scalable mode
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm install loki grafana/loki \
  --namespace monitoring \
  --values loki-values.yaml \
  --version 6.6.0
```

#### Microservices Mode

Each component is deployed and scaled independently. Required for very large deployments (> 1TB/day) or when components need independent scaling.

## Helm Chart Configuration for Production

```yaml
# loki-values.yaml
loki:
  auth_enabled: true  # Enable multi-tenancy

  # Limits configuration
  limits_config:
    # Global ingestion rate per tenant
    ingestion_rate_mb: 16
    ingestion_burst_size_mb: 32
    # Maximum number of active streams per tenant
    max_streams_per_user: 10000
    # Maximum query time range (prevent runaway queries)
    max_query_length: 721h
    # Maximum query range for metric queries
    max_query_range: 30d
    # Retention
    retention_period: 744h  # 31 days default
    # Cardinality limit - prevents label explosion
    max_label_names_per_series: 15
    max_label_value_length: 2048
    # Parallelism per tenant
    max_query_parallelism: 32
    # Split queries at this interval (for performance)
    split_queries_by_interval: 30m

  # Storage configuration
  storage:
    type: s3
    s3:
      endpoint: s3.amazonaws.com
      region: us-east-1
      bucketnames: company-loki-chunks
      access_key_id: ${AWS_ACCESS_KEY_ID}
      secret_access_key: ${AWS_SECRET_ACCESS_KEY}
      s3forcepathstyle: false
      insecure: false

  # Schema configuration
  schemaConfig:
    configs:
      - from: "2024-01-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_index_
          period: 24h

  # Storage configuration
  storage_config:
    tsdb_shipper:
      active_index_directory: /loki/index
      cache_location: /loki/index_cache
      cache_ttl: 24h
    aws:
      region: us-east-1

  # Ingester WAL configuration
  ingester:
    wal:
      enabled: true
      dir: /loki/wal
      replay_memory_ceiling: 4GB
    lifecycler:
      ring:
        kvstore:
          store: memberlist
        replication_factor: 3
    chunk_idle_period: 1h
    chunk_retain_period: 30s
    max_chunk_age: 2h
    chunk_target_size: 1572864  # 1.5MB

  # Querier configuration
  querier:
    max_concurrent: 20
    query_timeout: 5m

  # Query frontend configuration
  frontend:
    max_outstanding_per_tenant: 512
    compress_responses: true
    log_queries_longer_than: 10s

  # Compactor
  compactor:
    working_directory: /loki/compactor
    retention_enabled: true
    delete_request_store: s3

  # Ring configuration (consistent hashing for ingesters)
  memberlist:
    join_members:
      - loki-memberlist.monitoring.svc.cluster.local:7946
    dead_node_reclaim_time: 30s

# Component scaling
deploymentMode: SimpleScalable

backend:
  replicas: 3
  persistence:
    size: 20Gi

read:
  replicas: 3

write:
  replicas: 3
  persistence:
    size: 20Gi

# Caching
resultsCache:
  enabled: true
  backend: memcached

chunksCache:
  enabled: true
  backend: memcached
  memcached:
    max_item_size: 5m
    batchSize: 256
    parallelism: 50

indexCache:
  enabled: true
  backend: memcached

# Memcached deployment
memcached:
  enabled: true
  replicaCount: 3
  resources:
    requests:
      cpu: 500m
      memory: 4Gi
    limits:
      cpu: 2000m
      memory: 8Gi

# Loki Gateway (nginx)
gateway:
  enabled: true
  replicas: 2
  ingress:
    enabled: true
    ingressClassName: nginx
    hosts:
      - host: loki.company.com
        paths:
          - path: /
    tls:
      - hosts:
          - loki.company.com
        secretName: loki-tls
```

## Promtail DaemonSet Configuration

Promtail is the purpose-built log collector for Loki. It runs as a DaemonSet and collects logs from the Kubernetes node filesystem.

```yaml
# promtail-values.yaml
config:
  clients:
    - url: http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push
      tenant_id: default
      # Batching configuration
      batchwait: 1s
      batchsize: 1048576  # 1MB
      # Retry configuration
      backoff_config:
        min_period: 500ms
        max_period: 5m
        max_retries: 10

  snippets:
    # Common pipeline for all Kubernetes pods
    pipelineStages:
      # Parse JSON if the log line is JSON
      - cri: {}

      # Match and parse JSON structured logs
      - match:
          selector: '{app=~".+"}'
          stages:
            - json:
                expressions:
                  level: level
                  ts: ts
                  msg: msg
                  caller: caller
                  trace_id: traceId
                  span_id: spanId
                  error: error
            - labels:
                level:
                  source: level
            # Store trace ID as label for correlation (careful - high cardinality!)
            # Better: store as structured metadata, not label
            - structured_metadata:
                trace_id:
                  source: trace_id
                span_id:
                  source: span_id

      # Drop health check and readiness probe logs
      - match:
          selector: '{app=~".+"}'
          stages:
            - drop:
                expression: ".*(GET /health|GET /ready|GET /metrics).*"

      # Multiline support for Java stack traces
      - match:
          selector: '{app=~"java.*"}'
          stages:
            - multiline:
                firstline: '^\d{4}-\d{2}-\d{2}'
                max_wait_time: 3s
                max_lines: 500

  # Scrape config for Kubernetes pods
  scrapeConfigs: |
    - job_name: kubernetes-pods
      kubernetes_sd_configs:
        - role: pod
      pipeline_stages:
        - cri: {}
      relabel_configs:
        # Only collect from pods with log annotation enabled
        - source_labels: [__meta_kubernetes_pod_annotation_promtail_io_enabled]
          action: keep
          regex: "true"

        # Set namespace label
        - source_labels: [__meta_kubernetes_namespace]
          target_label: namespace

        # Set pod name label
        - source_labels: [__meta_kubernetes_pod_name]
          target_label: pod

        # Set container name
        - source_labels: [__meta_kubernetes_pod_container_name]
          target_label: container

        # Set app label from pod labels
        - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
          target_label: app

        # Set node name
        - source_labels: [__meta_kubernetes_pod_node_name]
          target_label: node

        # Build the log file path on the node
        - source_labels: [__meta_kubernetes_pod_uid, __meta_kubernetes_pod_container_name]
          target_label: __path__
          separator: /
          replacement: /var/log/pods/*$1/*.log

    # Collect from all pods (less filtered approach)
    - job_name: kubernetes-pods-all
      kubernetes_sd_configs:
        - role: pod
      pipeline_stages:
        - cri: {}
      relabel_configs:
        - source_labels: [__meta_kubernetes_namespace]
          target_label: namespace
        - source_labels: [__meta_kubernetes_pod_name]
          target_label: pod
        - source_labels: [__meta_kubernetes_pod_container_name]
          target_label: container
        - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
          target_label: app
        - source_labels: [__meta_kubernetes_pod_uid, __meta_kubernetes_pod_container_name]
          target_label: __path__
          separator: /
          replacement: /var/log/pods/*$1/*.log

        # Drop test namespace logs from production Loki
        - source_labels: [namespace]
          action: drop
          regex: "test|e2e|load-test"

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

tolerations:
  - effect: NoSchedule
    operator: Exists
  - effect: NoExecute
    operator: Exists
```

## Vector as a Fluentbit/Promtail Alternative

Vector is a high-performance observability data pipeline that can replace Promtail for log collection. It is particularly valuable for complex transformation pipelines.

```yaml
# vector-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vector-config
  namespace: monitoring
data:
  vector.yaml: |
    data_dir: /vector-data-dir

    api:
      enabled: true
      address: 0.0.0.0:8686

    sources:
      kubernetes_logs:
        type: kubernetes_logs
        pod_annotation_fields:
          container_image: container_image
          pod_labels: pod_labels
        namespace_annotation_fields:
          namespace_labels: namespace_labels

    transforms:
      # Parse JSON structured logs
      parse_json:
        type: remap
        inputs: [kubernetes_logs]
        source: |
          if is_string(.message) {
            parsed, err = parse_json(.message)
            if err == null {
              . = merge(., parsed)
            }
          }

      # Add Kubernetes metadata as structured metadata (not labels)
      add_metadata:
        type: remap
        inputs: [parse_json]
        source: |
          # Add structured metadata for trace correlation
          if exists(.traceId) {
            .metadata.trace_id = .traceId
            del(.traceId)
          }
          if exists(.spanId) {
            .metadata.span_id = .spanId
            del(.spanId)
          }

      # Route by namespace
      route_by_namespace:
        type: route
        inputs: [add_metadata]
        route:
          platform: .kubernetes.pod_namespace == "kube-system" || .kubernetes.pod_namespace == "monitoring"
          production: starts_with(string!(.kubernetes.pod_namespace), "prod")
          development: starts_with(string!(.kubernetes.pod_namespace), "dev")
          default: "true"

    sinks:
      loki_production:
        type: loki
        inputs: [route_by_namespace.production]
        endpoint: http://loki-gateway.monitoring.svc.cluster.local
        tenant_id: production
        encoding:
          codec: json
        labels:
          namespace: "{{kubernetes.pod_namespace}}"
          pod: "{{kubernetes.pod_name}}"
          container: "{{kubernetes.container_name}}"
          app: "{{kubernetes.pod_labels.\"app.kubernetes.io/name\"}}"
          level: "{{level}}"
        batch:
          timeout_secs: 5
          max_bytes: 1048576

      loki_platform:
        type: loki
        inputs: [route_by_namespace.platform]
        endpoint: http://loki-gateway.monitoring.svc.cluster.local
        tenant_id: platform
        encoding:
          codec: json
        labels:
          namespace: "{{kubernetes.pod_namespace}}"
          pod: "{{kubernetes.pod_name}}"
          container: "{{kubernetes.container_name}}"
```

## Log Label Design: The Cardinality Problem

Label design is the most critical Loki configuration decision. Unlike Elasticsearch where every field is indexed, Loki only indexes labels. Too few labels make logs hard to find; too many labels create high cardinality that degrades performance and increases storage cost.

### The Cardinal Rule

**Do not use high-cardinality values as labels.** The following are classic mistakes:

```
# BAD: one stream per unique request ID = millions of streams
{trace_id="abc123def456"}

# BAD: one stream per pod instance = scales with replicas
{pod="payment-service-7d9f45b6c-xk8js"}

# BAD: user-level labels = unbounded cardinality
{user_id="12345"}

# BAD: IP addresses = high cardinality
{client_ip="10.0.1.45"}
```

### Good Label Design

Labels should have bounded, small cardinalities:

```
# GOOD: ~10-50 namespaces
{namespace="production"}

# GOOD: ~100-1000 distinct service names
{app="payment-service"}

# GOOD: ~5-10 environments
{environment="production"}

# GOOD: ~5 log levels
{level="error"}

# GOOD: ~10-20 clusters
{cluster="us-east-1-prod"}
```

A practical guideline: if a label value could have more than 10,000 distinct values across all log streams, it should be a structured log field, not a Loki label.

### Structured Metadata (Loki 3.0+)

Loki 3.0 introduced structured metadata, which allows attaching high-cardinality values to log lines without creating new streams:

```yaml
# Promtail pipeline stage - add trace ID as structured metadata
- structured_metadata:
    trace_id:
      source: trace_id
    span_id:
      source: span_id
    request_id:
      source: request_id
    user_id:
      source: user_id
```

Structured metadata is searchable via LogQL but does not create separate log streams, avoiding the cardinality problem.

```logql
# Query using structured metadata
{namespace="production", app="payment-service"}
| trace_id = "abc123def456"
```

## LogQL Syntax Guide

LogQL is Loki's query language. It has two types of queries: log queries (return log lines) and metric queries (return numeric time series).

### Log Query Syntax

```logql
# Basic stream selector
{namespace="production", app="payment-service"}

# Multiple selectors with regex
{namespace=~"prod.*", app=~"(payment|checkout)-service"}

# Negative selector
{namespace="production", app!="test-service"}

# Filter expression - text match
{namespace="production"} |= "ERROR"

# Case insensitive match
{namespace="production"} |~ "(?i)error"

# Multiple filters (AND)
{namespace="production"} |= "ERROR" |= "database"

# Negative filter (NOT)
{namespace="production"} |= "ERROR" != "NullPointerException"

# JSON parser
{namespace="production"} | json

# JSON with specific field extraction
{namespace="production"} | json msg="message", level="severity"

# Label filter after parsing
{namespace="production"} | json | level="error"

# Pattern parser (for unstructured logs)
{namespace="production"} | pattern "<_> <ip> - - [<_>] \"<method> <path> HTTP/<_>\" <status> <_>"

# Regex parser
{namespace="production"} | regexp `(?P<method>\w+) (?P<path>/[^\s]+) HTTP`

# Line format (reshape the log line output)
{namespace="production"} | json | line_format "{{.level}} {{.msg}} trace={{.trace_id}}"

# Label format (rename or derive labels)
{namespace="production"} | json | label_format error_type=`{{regexReplaceAll ".*Exception: (\\w+).*" .message "${1}"}}`
```

### Metric Query Syntax

```logql
# Count log lines over time
count_over_time({namespace="production", app="payment-service"}[5m])

# Rate of log lines per second
rate({namespace="production"}[5m])

# Rate of error logs
rate({namespace="production"} |= "ERROR" [5m])

# Count of a specific field value
sum by (level) (
  count_over_time({namespace="production"} | json [5m])
)

# Error rate percentage
sum by (app) (rate({namespace="production"} | json | level="error" [5m]))
/
sum by (app) (rate({namespace="production"} | json [5m]))
* 100

# 95th percentile response time from logs
# (requires response_time field in structured logs)
quantile_over_time(0.95,
  {namespace="production"} | json | unwrap response_time_ms [5m]
) by (app)

# Number of unique users (approximate - uses hyperloglog)
approx_topk(10,
  sum by (user_id) (
    count_over_time({namespace="production"} | json [1h])
  )
)

# Bytes ingested per namespace
sum by (namespace) (
  bytes_over_time({namespace=~".+"}[5m])
)
```

### Advanced LogQL Patterns

```logql
# Error ratio alert expression
(
  sum by (app) (rate({namespace="production"} | json | level="error" [5m]))
  /
  sum by (app) (rate({namespace="production"} | json [5m]))
) > 0.05

# Detect high error rates with label matching
sum without (pod) (
  rate({namespace=~"prod.*"} |= "level=error" [5m])
) > 5

# Detect specific exception patterns
count_over_time(
  {namespace="production"}
  |~ ".*OutOfMemoryError.*"
  [15m]
) > 0

# 5xx error count from nginx access logs
sum by (namespace) (
  count_over_time(
    {app="nginx"}
    | regexp `^(?P<ip>[\w.]+) .+ "(?P<method>\w+) (?P<path>\S+) HTTP/[\d.]+" (?P<status>\d+) (?P<bytes>\d+)`
    | status >= 500
    [5m]
  )
)

# Slow request detection
count_over_time(
  {app="api-gateway"}
  | json
  | response_time_ms > 1000
  [5m]
) by (endpoint)
```

## Retention Configuration

### Global and Per-Tenant Retention

```yaml
# loki configuration
compactor:
  retention_enabled: true
  delete_request_store: s3

# Global default retention
limits_config:
  retention_period: 744h  # 31 days

# Per-tenant retention (overrides global)
# Configured via the runtime config
```

Runtime configuration for per-tenant overrides:

```yaml
# runtime-config.yaml
overrides:
  # High-value production tenant - longer retention
  production:
    retention_period: 2160h  # 90 days
    ingestion_rate_mb: 32
    max_streams_per_user: 50000

  # Development tenant - shorter retention
  development:
    retention_period: 168h  # 7 days
    ingestion_rate_mb: 8

  # Audit logs tenant - very long retention
  audit:
    retention_period: 8760h  # 1 year
    max_query_length: 8760h
```

```yaml
# loki configuration reference to runtime config
runtime_config:
  file: /etc/loki/runtime-config.yaml
  period: 30s  # Check for updates every 30 seconds
```

## S3/GCS Object Storage Backend

### AWS S3 Configuration

```yaml
# loki configuration
storage_config:
  aws:
    s3: s3://company-loki-chunks
    region: us-east-1
    # Use IAM role if running on EC2/EKS (preferred over access keys)
    # iam_role: arn:aws:iam::123456789:role/loki-s3-role
    access_key_id: ${AWS_ACCESS_KEY_ID}
    secret_access_key: ${AWS_SECRET_ACCESS_KEY}
    insecure: false
    sse_encryption: true
    http_config:
      insecure_skip_verify: false
      response_header_timeout: 0
      idle_conn_timeout: 90s

  boltdb_shipper:
    active_index_directory: /loki/index
    cache_location: /loki/cache
    resync_interval: 5m
    shared_store: s3

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_index_
        period: 24h
```

### S3 Bucket Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/loki-role"
      },
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging"
      ],
      "Resource": [
        "arn:aws:s3:::company-loki-chunks",
        "arn:aws:s3:::company-loki-chunks/*"
      ]
    }
  ]
}
```

### GCS Configuration

```yaml
storage_config:
  gcs:
    bucket_name: company-loki-chunks
    service_account: |
      {
        "type": "service_account",
        "project_id": "company-project",
        ...
      }
    # Or use workload identity (preferred on GKE)
    # chunk_buffer_size: 10485760

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: gcs
      schema: v13
      index:
        prefix: loki_index_
        period: 24h
```

## Chunk and Index Cache Tuning

Loki's caching layers are critical for query performance. Without caching, every query reads from object storage, which is slow and expensive.

### Cache Architecture

```
Query Request
     │
     ▼
Query Results Cache (Memcached)
     │ cache miss
     ▼
Index Cache (Memcached)
     │ cache miss
     ▼
Chunk Cache (Memcached)
     │ cache miss
     ▼
Object Storage (S3/GCS)
```

### Memcached Configuration

```yaml
# loki configuration
chunk_store_config:
  chunk_cache_config:
    memcached:
      batch_size: 256
      parallelism: 100
    memcached_client:
      addresses: dns+memcached.monitoring.svc.cluster.local:11211
      max_item_size: 1048576  # 1MB max chunk size in cache
      timeout: 500ms
      max_idle_conns: 24

storage_config:
  index_cache_validity: 5m
  tsdb_shipper:
    cache_location: /loki/index_cache
    cache_ttl: 24h
    index_gateway_client:
      server_address: loki-index-gateway.monitoring.svc.cluster.local:9095

query_range:
  align_queries_with_step: true
  max_retries: 5
  cache_results: true
  results_cache:
    cache:
      memcached:
        expiration: 1h
      memcached_client:
        addresses: dns+memcached.monitoring.svc.cluster.local:11211
```

### Memcached Sizing

For a Loki deployment ingesting 50GB/day with 30-day retention:

```
Total data: 50GB/day * 30 days = 1.5TB
Chunks typically compress 10:1 in storage

Chunk cache: 5-10% of hot data = 7.5-15GB
Index cache: ~500MB per 100GB stored
Results cache: 2-4GB for typical query patterns

Recommended Memcached: 3 replicas * 8GB = 24GB total
```

```yaml
memcached:
  replicaCount: 3
  resources:
    requests:
      cpu: 500m
      memory: 8Gi
    limits:
      cpu: 2000m
      memory: 10Gi
  extraArgs:
    - -I 1m        # Max item size 1MB
    - -m 7168      # Memory limit 7GB (leaving headroom)
    - -c 1024      # Max simultaneous connections
    - -t 8         # Worker threads
```

## Ruler for Log-Based Alerts

The Loki Ruler evaluates LogQL expressions and generates Prometheus-compatible alerts, extending Loki from a log query tool to an alerting engine.

### Ruler Configuration

```yaml
# loki configuration
ruler:
  enable_api: true
  enable_alertmanager_v2: true
  alertmanager_url: http://alertmanager.monitoring.svc.cluster.local:9093
  storage:
    type: s3
    s3:
      s3: s3://company-loki-rules
      region: us-east-1
  rule_path: /loki/rules
  evaluation_interval: 1m
  poll_interval: 1m
  remote_write:
    enabled: true
    clients:
      prometheus:
        url: http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/write
```

### Log-Based Alerting Rules

```yaml
# loki-rules.yaml
groups:
  - name: application_errors
    interval: 1m
    rules:
      # Alert on high error rate in application logs
      - alert: ApplicationHighErrorRate
        expr: |
          (
            sum by (namespace, app) (
              rate({namespace=~"prod.*"} | json | level="error" [5m])
            )
            /
            sum by (namespace, app) (
              rate({namespace=~"prod.*"} | json [5m])
            )
          ) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Application {{ $labels.app }} in {{ $labels.namespace }} has >5% error rate in logs"
          runbook_url: "https://runbooks.company.com/application-high-error-rate"

      # Alert on OutOfMemoryError in Java applications
      - alert: JavaOutOfMemoryError
        expr: |
          count_over_time(
            {namespace=~"prod.*", app=~".*"}
            |~ "java.lang.OutOfMemoryError"
            [5m]
          ) > 0
        labels:
          severity: critical
        annotations:
          summary: "Java OOM error detected in {{ $labels.app }}"

      # Alert on database connection failures
      - alert: DatabaseConnectionFailures
        expr: |
          sum by (namespace, app) (
            count_over_time(
              {namespace=~"prod.*"}
              |= "connection refused"
              |~ "(?i)(mysql|postgres|redis|mongodb)"
              [5m]
            )
          ) > 10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Database connection failures detected"

  - name: infrastructure_errors
    interval: 2m
    rules:
      # Alert on certificate expiry warnings in logs
      - alert: CertificateExpiryWarningInLogs
        expr: |
          count_over_time(
            {namespace=~".+"}
            |~ "(?i)(certificate.*expir|tls.*expir|ssl.*expir)"
            [10m]
          ) > 0
        labels:
          severity: warning
        annotations:
          summary: "Certificate expiry warning detected in logs"

      # Alert on kernel OOM killer activity (from node logs)
      - alert: KernelOOMKillerActive
        expr: |
          count_over_time(
            {job="syslog"}
            |~ "Out of memory: Kill process"
            [5m]
          ) > 0
        labels:
          severity: critical
        annotations:
          summary: "Kernel OOM killer invoked on {{ $labels.node }}"

  - name: recording_rules
    interval: 1m
    rules:
      # Pre-compute error rates for dashboard performance
      - record: namespace_app:log_error_rate:rate5m
        expr: |
          sum by (namespace, app) (
            rate({namespace=~".+"} | json | level="error" [5m])
          )

      # HTTP 5xx count from nginx logs
      - record: namespace:nginx_5xx_rate:rate5m
        expr: |
          sum by (namespace) (
            rate(
              {app="nginx"}
              | regexp `status=(?P<status>\d+)`
              | status >= 500
              [5m]
            )
          )
```

### Applying Rules via ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-rules
  namespace: monitoring
  labels:
    # Loki Ruler watches for ConfigMaps with this label
    loki_rule: "true"
data:
  application-errors.yaml: |
    groups:
      - name: application_errors
        interval: 1m
        rules:
          - alert: ApplicationHighErrorRate
            expr: |
              ...
```

## Multi-Tenancy with X-Scope-OrgID

Loki's multi-tenancy model uses the `X-Scope-OrgID` HTTP header to separate data between tenants. With `auth_enabled: true`, every request must include this header.

### Promtail Multi-Tenant Configuration

```yaml
# promtail-values.yaml
config:
  clients:
    # Tenant for production namespace logs
    - url: http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push
      tenant_id: production

    # Tenant for platform namespace logs
    - url: http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push
      tenant_id: platform

  snippets:
    scrapeConfigs: |
      - job_name: production-pods
        pipeline_stages:
          - cri: {}
          - tenant:
              value: production
        kubernetes_sd_configs:
          - role: pod
        relabel_configs:
          - source_labels: [__meta_kubernetes_namespace]
            action: keep
            regex: "production|prod-.*"
          # ... rest of relabeling

      - job_name: platform-pods
        pipeline_stages:
          - cri: {}
          - tenant:
              value: platform
        kubernetes_sd_configs:
          - role: pod
        relabel_configs:
          - source_labels: [__meta_kubernetes_namespace]
            action: keep
            regex: "monitoring|kube-system|cert-manager|ingress-nginx"
          # ...
```

### Grafana Multi-Tenant Data Source

```yaml
# In Grafana data source configuration
jsonData:
  httpHeaderName1: "X-Scope-OrgID"
  timeout: 60
secureJsonData:
  httpHeaderValue1: "production"
```

Or use the `__org.id__` variable for dynamic tenant selection based on the Grafana organization:

```json
{
  "name": "Loki",
  "type": "loki",
  "jsonData": {
    "httpHeaders": [
      { "name": "X-Scope-OrgID", "value": "${__org.id__}" }
    ]
  }
}
```

### Cross-Tenant Querying (Admin Only)

```bash
# Query across all tenants (requires admin token)
curl -sf \
  -H "X-Scope-OrgID: production|development|platform" \
  "http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/query?query={app='payment-service'}"
```

## Grafana Loki Dashboard Examples

### Log Volume Dashboard Panel

```json
{
  "type": "timeseries",
  "title": "Log Ingestion Rate by Namespace",
  "targets": [
    {
      "expr": "sum by (namespace) (bytes_over_time({namespace=~\"$namespace\"}[$__interval]))",
      "legendFormat": "{{namespace}}",
      "refId": "A"
    }
  ],
  "fieldConfig": {
    "defaults": { "unit": "binBps" }
  }
}
```

### Error Rate Panel

```json
{
  "type": "timeseries",
  "title": "Error Rate by Application",
  "targets": [
    {
      "expr": "sum by (app) (rate({namespace=~\"$namespace\", app=~\"$app\"} | json | level=\"error\" [$__rate_interval]))",
      "legendFormat": "{{app}}",
      "refId": "A"
    }
  ]
}
```

### Live Logs Panel

```json
{
  "type": "logs",
  "title": "Application Logs",
  "targets": [
    {
      "expr": "{namespace=\"$namespace\", app=\"$app\"} |= \"$search\" | logfmt | level=~\"$level\"",
      "refId": "A"
    }
  ],
  "options": {
    "dedupStrategy": "none",
    "enableLogDetails": true,
    "showLabels": false,
    "showTime": true,
    "sortOrder": "Descending",
    "wrapLogMessage": false
  }
}
```

## Monitoring Loki Itself

```promql
# Distributor write throughput
sum(rate(loki_distributor_bytes_received_total[5m])) by (tenant)

# Ingester chunk utilization
loki_ingester_memory_chunks / loki_ingester_memory_chunks_created_total * 100

# Query duration (detect slow queries)
histogram_quantile(0.99, sum by (le) (rate(loki_request_duration_seconds_bucket{route=~".*query.*"}[5m])))

# Compactor retention progress
loki_compactor_retention_sweep_duration_seconds

# S3 operation errors
rate(loki_azure_blob_request_duration_seconds_count{status!="200"}[5m])
rate(loki_gcs_request_duration_seconds_count{status!="200"}[5m])

# Cache hit rate
loki_cache_request_duration_seconds_count{status="hit"}
/ loki_cache_request_duration_seconds_count
```

Alert on ingester WAL issues:

```yaml
- alert: LokiIngesterWALCorrupted
  expr: |
    increase(loki_ingester_wal_corruptions_total[5m]) > 0
  labels:
    severity: critical
  annotations:
    summary: "Loki ingester WAL corruption detected"

- alert: LokiIngesterFlushQueueFull
  expr: |
    loki_ingester_flush_queue_length > 1000
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Loki ingester flush queue is backed up"

- alert: LokiDistributorDroppedStreams
  expr: |
    rate(loki_distributor_ingester_appends_total{status="error"}[5m]) > 0
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Loki distributor is dropping log streams due to errors"
```

## Query Performance Best Practices

### Use Stream Selectors Efficiently

```logql
# BAD: requires scanning all streams, then filtering
{namespace=~".+"} |= "payment"

# GOOD: narrow the stream selector first
{namespace="production", app="payment-service"}
```

### Avoid Unbounded Time Ranges in Alerting

```logql
# BAD: scans all time for each alert evaluation
count_over_time({namespace="prod"} |= "ERROR" [24h]) > 0

# GOOD: use an appropriate window for alert evaluation
count_over_time({namespace="prod"} |= "ERROR" [5m]) > 0
```

### Use `bytes_over_time` for Volume Queries

When you need log volume (not line count), `bytes_over_time` is faster because it avoids line-by-line parsing:

```logql
# Faster: bytes ingested per app
sum by (app) (bytes_over_time({namespace="production"}[5m]))

# Slower when you only need volume:
sum by (app) (count_over_time({namespace="production"}[5m]))
```

### Index-Friendly Filter Ordering

Loki applies filters left-to-right after the stream selector. Place the most selective filter first:

```logql
# Efficient: rare term first (drastically reduces candidate lines)
{namespace="production"} |= "PaymentProcessingException" |= "ERROR"

# Less efficient: common term first (many lines pass the first filter)
{namespace="production"} |= "ERROR" |= "PaymentProcessingException"
```

## Production Operations Checklist

```bash
# Check Loki component health
kubectl get pods -n monitoring -l app.kubernetes.io/name=loki
kubectl get pods -n monitoring -l app.kubernetes.io/component=ingester

# Check ingester ring (all ingesters should be ACTIVE)
curl -sf http://loki.monitoring:3100/ring | jq '.shards[].state'

# Check write path health
curl -sf http://loki.monitoring:3100/distributor/ring

# View current limits
curl -sf http://loki.monitoring:3100/loki/api/v1/status/buildinfo

# Query active streams count per tenant
curl -sf -H "X-Scope-OrgID: production" \
  "http://loki.monitoring:3100/loki/api/v1/query?query=count(count by (stream) (rate({namespace=~\".+\"}[1m])))"

# Check compactor retention status
kubectl logs -n monitoring -l app.kubernetes.io/component=compactor | grep -i retention

# Force flush ingesters before maintenance
curl -sf -XPOST http://loki.monitoring:3100/flush
```

## Summary

Grafana Loki on Kubernetes provides a cost-effective, scalable log aggregation solution when deployed and configured correctly. The key production principles:

- Choose Simple Scalable deployment mode for most production workloads; it separates read and write paths for independent scaling
- Design labels with cardinality in mind: namespace, app, environment, and level are good labels; pod names, trace IDs, and user IDs are not
- Use structured metadata (Loki 3.0+) for high-cardinality correlation data like trace IDs
- Configure Memcached caching for chunk, index, and query results caches - this is the single highest-impact performance tuning action
- Use S3/GCS object storage with appropriate lifecycle policies for cost management
- Configure per-tenant limits and retention policies using the runtime config for multi-tenant deployments
- Deploy the Ruler to evaluate LogQL alerting rules and generate Prometheus-compatible alerts from log patterns
- Write narrow stream selectors in LogQL queries - label cardinality exists precisely to make queries fast
- Monitor Loki's own metrics for ingester WAL health, distributor throughput, and S3 operation errors

The combination of Loki + Promtail/Vector + Grafana + Alertmanager creates a complete, integrated observability platform that handles logging at enterprise scale without the operational complexity of Elasticsearch clusters.
