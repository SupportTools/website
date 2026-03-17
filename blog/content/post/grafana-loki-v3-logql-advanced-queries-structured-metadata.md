---
title: "Grafana Loki v3: LogQL Advanced Queries, Structured Metadata, and Efficient Log Storage"
date: 2031-08-07T00:00:00-05:00
draft: false
tags: ["Grafana", "Loki", "LogQL", "Kubernetes", "Observability", "Logging"]
categories:
- Observability
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Grafana Loki v3 features including LogQL advanced query patterns, structured metadata for log enrichment, and storage optimization strategies for enterprise-scale deployments."
more_link: "yes"
url: "/grafana-loki-v3-logql-advanced-queries-structured-metadata/"
---

Grafana Loki v3 represents a significant leap forward in log aggregation for cloud-native environments. With the introduction of structured metadata, enhanced LogQL capabilities, and substantially improved storage backends, Loki v3 closes the gap between log aggregation and full observability platforms. This post walks through everything an enterprise team needs to know to operate Loki v3 at scale on Kubernetes.

<!--more-->

# Grafana Loki v3: LogQL Advanced Queries, Structured Metadata, and Efficient Log Storage

## Overview

Loki v3 ships several breaking and non-breaking changes that collectively transform how you can query, store, and correlate log data. The headline features include:

- **Structured metadata** — attach arbitrary key-value pairs to log streams without altering the log line itself
- **LogQL v2 improvements** — new aggregate functions, range vector selectors, and multi-line pattern matching
- **TSDB index** — a time-series database-backed index that dramatically improves query performance over the older BoltDB/Cassandra index backends
- **Bloom filters** — pre-computed probabilistic structures that accelerate label filtering at query time
- **Object storage first** — simplified single-binary and microservices modes that treat S3/GCS as the primary durable store

This guide is structured for teams already operating Loki at scale who want to migrate to v3 and take full advantage of the new capabilities.

---

## Section 1: Architecture Review for Loki v3

### 1.1 Component Model

Loki v3 retains the familiar write path (Distributor -> Ingester -> Compactor) and read path (Query Frontend -> Querier -> Store) but introduces two new components:

- **Bloom Builder** — generates bloom filter indexes for chunk metadata
- **Bloom Gateway** — serves bloom filter queries from the read path

```
┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│  Promtail /  │────▶│ Distributor │────▶│   Ingester   │
│  Alloy       │     └─────────────┘     └──────┬───────┘
└──────────────┘                                │
                                                ▼
                                    ┌───────────────────────┐
                                    │  Object Storage       │
                                    │  (S3 / GCS / Azure)   │
                                    └───────────┬───────────┘
                                                │
          ┌─────────────┐     ┌──────────┐     │     ┌───────────────┐
          │   Grafana   │────▶│  Query   │─────┴────▶│   Querier     │
          └─────────────┘     │ Frontend │           └───────────────┘
                              └──────────┘
```

### 1.2 Deployment Modes

Loki v3 supports three deployment modes. Choose based on your scale requirements:

| Mode | Use Case | Components |
|------|----------|-----------|
| Single binary | Development, small teams | All in one process |
| Simple scalable | Medium production | Read + Write + Backend targets |
| Microservices | Large enterprise | Individual component scaling |

For most Kubernetes production deployments, the **simple scalable** mode provides the best balance between operational complexity and scalability.

### 1.3 Helm Deployment

```yaml
# loki-values.yaml
loki:
  schemaConfig:
    configs:
      - from: "2024-01-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_index_
          period: 24h

  storageConfig:
    tsdb_shipper:
      active_index_directory: /var/loki/tsdb-index
      cache_location: /var/loki/tsdb-cache
      cache_ttl: 24h
    aws:
      bucketnames: <your-loki-bucket>
      region: us-east-1
      access_key_id: <aws-access-key-id>
      secret_access_key: <aws-secret-access-key>

  auth_enabled: true

  limits_config:
    ingestion_rate_mb: 16
    ingestion_burst_size_mb: 32
    max_global_streams_per_user: 10000
    max_chunks_per_query: 2000000
    max_query_series: 500
    max_query_parallelism: 32
    retention_period: 744h   # 31 days
    allow_structured_metadata: true
    max_structured_metadata_entries_count: 128
    max_structured_metadata_size: 64kb

deploymentMode: SimpleScalable

write:
  replicas: 3
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "4Gi"

read:
  replicas: 3
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "4Gi"

backend:
  replicas: 3

minio:
  enabled: false  # Use external S3
```

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
helm upgrade --install loki grafana/loki \
  --namespace monitoring \
  --create-namespace \
  --values loki-values.yaml \
  --version 6.x.x
```

---

## Section 2: Structured Metadata

Structured metadata is the most significant new feature in Loki v3. It allows log shippers to attach key-value metadata to individual log entries without those keys becoming index labels. This solves the high-cardinality label problem that caused many teams to over-index their log streams.

### 2.1 How Structured Metadata Differs from Labels

| Feature | Labels | Structured Metadata |
|---------|--------|---------------------|
| Indexed | Yes (creates streams) | No (stored in chunks) |
| Queryable | Yes | Yes (via LogQL) |
| Cardinality impact | High | Minimal |
| Use case | Stream identification | Per-entry enrichment |
| Example | `{app="nginx"}` | `trace_id`, `user_id`, `span_id` |

### 2.2 Sending Structured Metadata via Promtail

```yaml
# promtail-config.yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push

scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    pipeline_stages:
      - docker: {}
      - json:
          expressions:
            trace_id: trace_id
            span_id: span_id
            user_id: user_id
            severity: level
      - structured_metadata:
          trace_id:
          span_id:
          user_id:
      - labels:
          severity:
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: app
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
```

### 2.3 Sending Structured Metadata via Grafana Alloy

Alloy (the successor to Promtail and the Grafana Agent) has native support for structured metadata:

```hcl
// alloy-config.alloy
discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pod_logs" {
  targets = discovery.kubernetes.pods.targets

  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
}

loki.source.kubernetes "pod_logs" {
  targets    = discovery.relabel.pod_logs.output
  forward_to = [loki.process.enrich.receiver]
}

loki.process "enrich" {
  stage.json {
    expressions = {
      trace_id  = "trace_id",
      span_id   = "span_id",
      user_id   = "user_id",
      error_code = "error.code",
    }
  }

  stage.structured_metadata {
    values = {
      trace_id   = "trace_id",
      span_id    = "span_id",
      user_id    = "user_id",
      error_code = "error_code",
    }
  }

  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url = "http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push"
  }
}
```

### 2.4 Querying Structured Metadata in LogQL

Structured metadata fields are accessible in LogQL using the `|` pipeline with the metadata key:

```logql
# Filter by structured metadata value
{app="api-server"} | trace_id="abc123xyz"

# Use structured metadata in metric queries
sum by (user_id) (
  count_over_time(
    {namespace="production", app="api-server"} | user_id != "" [5m]
  )
)

# Correlate traces with logs
{namespace="production"} | trace_id=`<paste-trace-id>` | json

# Find all errors for a specific user across all services
{namespace="production"} | user_id="12345" | level="error"

# Rate of errors grouped by error code
sum by (error_code) (
  rate(
    {namespace="production", app=~".*"} | error_code != "" | level="error" [1m]
  )
)
```

---

## Section 3: Advanced LogQL Patterns

### 3.1 Pattern Expressions

LogQL v2 introduced `pattern` expressions that provide a more readable alternative to regular expressions for common log formats:

```logql
# Nginx access log parsing with pattern
{app="nginx"} | pattern `<ip> - <user> [<_>] "<method> <path> <_>" <status> <bytes>`
  | method="POST"
  | status >= 400
  | line_format "{{.ip}} {{.path}} {{.status}}"

# Apache combined log format
{app="apache"}
  | pattern `<ip> <_> <_> [<timestamp>] "<verb> <uri> <_>" <status> <size> "<referrer>" "<agent>"`
  | status >= 500

# Custom application log
{app="payments"}
  | pattern `level=<level> ts=<ts> caller=<caller> msg="<msg>" amount=<amount> currency=<currency>`
  | level="error"
  | amount > 10000
```

### 3.2 Multi-Line Log Handling

Applications that emit multi-line logs (Java stack traces, Go panic output) require special handling:

```logql
# Match multi-line Java stack traces
{app="java-service"}
  | multiline firstline=`^\d{4}-\d{2}-\d{2}`
  | line_format "{{.line}}"
  | re `(?s)Exception.*`
```

Promtail pipeline configuration for multi-line parsing:

```yaml
pipeline_stages:
  - multiline:
      firstline: '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
      max_wait_time: 3s
      max_lines: 128
  - regex:
      expression: '^(?P<timestamp>\S+)\s+(?P<level>\w+)\s+(?P<message>.*)'
  - labels:
      level:
  - timestamp:
      source: timestamp
      format: RFC3339Nano
```

### 3.3 Metric Queries and Aggregations

```logql
# Request rate by status code family
sum by (status_family) (
  rate(
    {app="api"}
    | json
    | label_format status_family=`{{div .status 100}}xx`
    [1m]
  )
)

# 99th percentile latency from logs
quantile_over_time(0.99,
  {app="api"}
  | json
  | unwrap duration_ms
  [5m]
) by (endpoint)

# Error rate per service compared to total
(
  sum by (service) (rate({namespace="prod"} | level="error" [5m]))
/
  sum by (service) (rate({namespace="prod"} [5m]))
) * 100

# Bytes per second by source IP
sum by (ip) (
  rate(
    {app="nginx"}
    | pattern `<ip> - - [<_>] "<_>" <_> <bytes>`
    | unwrap bytes
    [1m]
  )
)

# Top 10 slowest API endpoints
topk(10,
  avg by (path) (
    avg_over_time(
      {app="api"}
      | json
      | unwrap response_time_ms
      [5m]
    )
  )
)
```

### 3.4 Log Range Vector Selectors

Loki v3 adds additional range vector selectors for richer metric extraction:

```logql
# first_over_time - get the first value in the range
first_over_time(
  {app="batch-job"} | json | unwrap job_id [1h]
) by (job_name)

# last_over_time - get the most recent value
last_over_time(
  {app="worker"} | json | unwrap queue_depth [5m]
) by (worker_id)

# stdvar_over_time and stddev_over_time for variance
stddev_over_time(
  {app="api"} | json | unwrap latency_ms [10m]
) by (endpoint)
```

### 3.5 Join and Correlation Queries

One of the most powerful features in Loki v3 is the ability to correlate log streams:

```logql
# Find requests that generated errors in the database
{app="api"} | json | trace_id != ""
  and
{app="postgres-proxy"} | json | level="error" | trace_id != ""
```

### 3.6 Label Manipulation

```logql
# Rename labels inline
{app="legacy-app"}
  | json
  | label_format
      request_id=req_id,
      response_code=http_status,
      latency_ms=duration

# Drop labels to reduce cardinality in metric queries
sum by (endpoint) (
  rate(
    {app="api"}
    | json
    | drop pod, node, container
    [5m]
  )
)

# Keep only specific labels
{namespace="production"}
  | logfmt
  | keep level, service, trace_id
```

---

## Section 4: TSDB Index and Bloom Filters

### 4.1 Migrating to TSDB

Loki v3 makes TSDB the default and recommended index backend. The migration from older indexes requires a schema change:

```yaml
# In your Loki configuration
schema_config:
  configs:
    # Old schema - keep for historical data
    - from: "2022-01-01"
      store: boltdb-shipper
      object_store: s3
      schema: v11
      index:
        prefix: loki_index_
        period: 24h
    # New TSDB schema
    - from: "2024-06-01"
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_tsdb_index_
        period: 24h
```

TSDB provides significant improvements:
- Query planning that prunes irrelevant chunks before fetching from object storage
- Efficient label value enumeration for autocomplete
- Faster label cardinality queries

### 4.2 Bloom Filter Configuration

Bloom filters are optional but dramatically improve query performance for high-volume deployments:

```yaml
# Enable bloom filters in Loki config
bloom_build:
  enabled: true
  builder:
    planning_sleep: 1m
    planning_sleep_jitter: 30s

bloom_gateway:
  enabled: true
  client:
    addresses: dnssrvnoa+_bloom-gateway-grpc._tcp.loki-bloom-gateway.monitoring.svc.cluster.local

limits_config:
  bloom_gateway_enable_filtering: true
  bloom_compactor_max_table_age: 168h  # 7 days
```

Bloom filter Helm values:

```yaml
bloomGateway:
  enabled: true
  replicas: 3
  resources:
    requests:
      cpu: "500m"
      memory: "2Gi"
    limits:
      cpu: "2"
      memory: "8Gi"
  persistence:
    enabled: true
    size: 50Gi
    storageClass: fast-ssd

bloomCompactor:
  enabled: true
  replicas: 1
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
```

---

## Section 5: Log Storage Optimization

### 5.1 Retention Policies

Loki v3 supports per-tenant and per-stream retention policies:

```yaml
limits_config:
  retention_period: 744h  # Global default: 31 days

  per_tenant_override_config: /etc/loki/per-tenant-config.yaml

# per-tenant-config.yaml
overrides:
  "team-platform":
    retention_period: 2160h    # 90 days
    ingestion_rate_mb: 32
    max_global_streams_per_user: 20000

  "team-security":
    retention_period: 8760h    # 1 year for compliance
    ingestion_rate_mb: 16

  "team-development":
    retention_period: 168h     # 7 days
    ingestion_rate_mb: 8
```

### 5.2 Compaction Configuration

The compactor merges small chunks and enforces retention. Proper configuration is critical for storage efficiency:

```yaml
compactor:
  working_directory: /var/loki/compactor
  compaction_interval: 10m
  apply_retention_interval: 1h
  retention_enabled: true
  retention_delete_delay: 2h
  retention_delete_worker_count: 150
  delete_request_store: s3

  # Limits for compaction load
  max_compaction_parallelism: 1
```

### 5.3 Chunk Encoding Optimization

```yaml
ingester:
  chunk_idle_period: 30m
  chunk_block_size: 262144      # 256KB
  chunk_target_size: 1572864    # 1.5MB target
  chunk_encoding: snappy        # Options: none, gzip, lz4-64k, snappy, zstd, lz4-256k
  max_chunk_age: 2h
  chunk_retain_period: 0s
```

Encoding comparison:

| Encoding | Compression Ratio | CPU Cost | Best For |
|----------|------------------|----------|----------|
| snappy | Moderate | Low | General purpose |
| gzip | High | Medium | Cold storage |
| zstd | High | Medium | Best compression/speed balance |
| lz4 | Low | Very Low | High throughput ingestion |

For most production environments, `zstd` provides the best balance between compression ratio and query performance.

### 5.4 Cache Configuration

Loki v3 supports multiple cache backends. Proper caching dramatically improves query performance:

```yaml
query_range:
  cache_results: true
  results_cache:
    cache:
      memcached_client:
        addresses: dns+memcached.monitoring.svc.cluster.local:11211
        timeout: 500ms

chunk_store_config:
  chunk_cache_config:
    memcached_client:
      addresses: dns+memcached.monitoring.svc.cluster.local:11211
      timeout: 500ms
      max_idle_conns: 16

  write_dedupe_cache_config:
    memcached_client:
      addresses: dns+memcached.monitoring.svc.cluster.local:11211

index_queries_cache_config:
  memcached_client:
    addresses: dns+memcached.monitoring.svc.cluster.local:11211
```

---

## Section 6: Grafana Dashboard Integration

### 6.1 Correlating Logs with Traces

Loki v3's structured metadata enables seamless log-to-trace correlation in Grafana:

```json
{
  "datasource": {
    "type": "loki",
    "uid": "loki-datasource"
  },
  "derivedFields": [
    {
      "datasourceUid": "tempo-datasource",
      "matcherRegex": "trace_id=(\\w+)",
      "name": "TraceID",
      "url": "${__value.raw}",
      "urlDisplayLabel": "View Trace"
    }
  ]
}
```

When structured metadata contains `trace_id`, Grafana can automatically link log lines to corresponding Tempo traces without requiring regex extraction from the log line itself.

### 6.2 LogQL-Powered Panels

```logql
# Error rate panel
sum(rate({namespace="production"} | level="error" [1m])) by (app)

# Log volume heatmap by severity
sum by (level) (
  count_over_time(
    {namespace="production"}
    | json
    | level != ""
    [5m]
  )
)

# Active users from logs (cardinality metric)
count(
  last_over_time(
    {app="api-server"}
    | json
    | user_id != ""
    | unwrap user_id
    [15m]
  )
)
```

---

## Section 7: Alerting with Loki

### 7.1 Ruler Configuration

```yaml
ruler:
  storage:
    type: s3
    s3:
      bucketnames: <your-loki-rules-bucket>
      region: us-east-1
      access_key_id: <aws-access-key-id>
      secret_access_key: <aws-secret-access-key>
  rule_path: /var/loki/rules
  alertmanager_url: http://alertmanager.monitoring.svc.cluster.local:9093
  enable_api: true
  ring:
    kvstore:
      store: memberlist
```

### 7.2 Alert Rules

```yaml
# loki-alert-rules.yaml
groups:
  - name: application-errors
    interval: 1m
    rules:
      - alert: HighErrorRate
        expr: |
          (
            sum by (app, namespace) (
              rate({namespace=~"production|staging"} | level="error" [5m])
            )
          /
            sum by (app, namespace) (
              rate({namespace=~"production|staging"} [5m])
            )
          ) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate in {{ $labels.app }}"
          description: "Error rate is {{ $value | humanizePercentage }} in {{ $labels.namespace }}/{{ $labels.app }}"

      - alert: ServiceDown
        expr: |
          absent(rate({app="critical-service", namespace="production"} [5m]))
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "No logs from critical-service"
          description: "No log lines received from critical-service for 2 minutes"

      - alert: DatabaseErrors
        expr: |
          sum by (app) (
            count_over_time(
              {namespace="production"}
              | json
              | error_code =~ "DB.*"
              [1m]
            )
          ) > 10
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database errors detected in {{ $labels.app }}"
```

Apply the rules:

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-alert-rules
  namespace: monitoring
  labels:
    app: loki
data:
  rules.yaml: |
$(cat loki-alert-rules.yaml | sed 's/^/    /')
EOF
```

---

## Section 8: Operational Best Practices

### 8.1 Label Design Guidelines

Poor label design is the most common cause of Loki performance problems. Follow these principles:

**High cardinality labels to avoid:**
- `user_id` as a label (use structured metadata instead)
- `trace_id` as a label
- `request_id` as a label
- Timestamps in label values
- IP addresses

**Good label candidates:**
- `namespace`
- `app` or `service`
- `environment` (prod/staging/dev)
- `cluster`
- `level` or `severity`
- `region`

### 8.2 Stream Sharding for High-Volume Applications

For applications generating more than 5MB/s of logs, enable stream sharding:

```yaml
# In limits_config
limits_config:
  shard_streams:
    enabled: true
    desired_rate: 3145728  # 3MB/s per stream shard
    logging_enabled: false
```

### 8.3 Monitoring Loki Itself

Key metrics to track:

```logql
# Ingestion rate
sum(rate(loki_distributor_bytes_received_total[1m])) by (tenant)

# Query duration p99
histogram_quantile(0.99,
  sum by (le, route) (
    rate(loki_request_duration_seconds_bucket[5m])
  )
)

# Chunk store hit rate
sum(rate(loki_chunk_store_index_entries_per_chunk_sum[5m]))
/
sum(rate(loki_chunk_store_index_entries_per_chunk_count[5m]))
```

Prometheus recording rules for Loki health:

```yaml
groups:
  - name: loki-recording-rules
    interval: 30s
    rules:
      - record: loki:ingestion_rate_mb:sum1m
        expr: |
          sum(rate(loki_distributor_bytes_received_total[1m])) / 1048576

      - record: loki:query_success_rate:sum5m
        expr: |
          sum(rate(loki_request_duration_seconds_count{status_code=~"2.."}[5m]))
          /
          sum(rate(loki_request_duration_seconds_count[5m]))
```

### 8.4 Troubleshooting Common Issues

**Issue: Query timeout on large time ranges**

```yaml
# Increase limits for large range queries
limits_config:
  query_timeout: 5m
  max_query_lookback: 720h
  max_query_range: 168h  # 7 day max range per query
  split_queries_by_interval: 24h  # Split into 24h chunks
```

**Issue: Too many streams / high cardinality**

```bash
# Identify high cardinality streams
logcli series '{namespace="production"}' --analyze-labels

# Query stream count per tenant
sum by (__name__) (loki_ingester_streams_created_total)
```

**Issue: Slow compaction / high storage costs**

```yaml
# Tune compactor aggressiveness
compactor:
  compaction_interval: 5m          # Run more frequently
  max_compaction_parallelism: 4    # More parallel workers
  split_and_merge_shards_per_tenant: 16
  split_stages_count: 2
```

---

## Section 9: Multi-Tenancy Setup

For organizations operating shared Loki clusters across multiple teams:

```yaml
auth_enabled: true

server:
  http_listen_port: 3100

limits_config:
  ingestion_rate_strategy: global
  ingestion_rate_mb: 4
  ingestion_burst_size_mb: 6
  max_global_streams_per_user: 5000
  max_query_parallelism: 16
  retention_period: 720h

# Per-tenant overrides
per_tenant_override_config: /etc/loki/tenant-overrides.yaml
```

Tenant-specific overrides:

```yaml
# tenant-overrides.yaml
overrides:
  platform-team:
    ingestion_rate_mb: 32
    max_global_streams_per_user: 50000
    retention_period: 2160h
    allow_structured_metadata: true
    max_structured_metadata_entries_count: 256

  security-team:
    retention_period: 8760h
    ingestion_rate_mb: 16
    query_timeout: 10m

  dev-team:
    retention_period: 168h
    ingestion_rate_mb: 4
    max_query_parallelism: 8
```

Authentication with the Loki multi-tenant proxy:

```yaml
# loki-multi-tenant-proxy-config.yaml
server:
  port: 3101
  cert_file: /etc/certs/tls.crt
  key_file: /etc/certs/tls.key

authn:
  - username: platform-team
    password: <bcrypt-hashed-password>
    orgid: platform-team
  - username: security-team
    password: <bcrypt-hashed-password>
    orgid: security-team
```

---

## Summary

Loki v3 delivers enterprise-grade log aggregation capabilities that rival dedicated logging platforms while maintaining the cost-effective object storage model that made Loki popular. The key takeaways for production deployments:

1. **Adopt structured metadata** for high-cardinality fields — stop putting trace IDs and user IDs in labels
2. **Migrate to TSDB** index — the performance gains over BoltDB are substantial and the migration is straightforward
3. **Enable bloom filters** for deployments processing more than 50GB/day
4. **Design labels carefully** — fewer, lower-cardinality labels leads to dramatically better query performance
5. **Use per-tenant retention** to balance compliance requirements against storage costs
6. **Configure proper caching** — a well-configured Memcached tier can reduce S3 costs by 60-70% for hot data

The structured metadata feature alone justifies upgrading to v3 for any team that has struggled with the label cardinality limitations of earlier Loki versions.
