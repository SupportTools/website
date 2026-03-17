---
title: "Kubernetes Loki Distributed: Index Gateway, Bloom Filters, and Query Acceleration"
date: 2031-04-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Loki", "Logging", "Observability", "Grafana", "Performance"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced guide to Loki distributed mode on Kubernetes. Covers TSDB index, bloom filter compaction for log search acceleration, query frontend cache, object storage tiering, and LogQL query optimization."
more_link: "yes"
url: "/kubernetes-loki-distributed-bloom-filters-query-acceleration/"
---

Loki's distributed mode scales log ingestion and querying beyond what a single-binary deployment can handle. When combined with TSDB indexing, bloom filter compaction, and multi-level caching, Loki can query petabyte-scale log stores in seconds. This guide configures a production-grade distributed Loki deployment on Kubernetes with performance optimization throughout.

<!--more-->

# Kubernetes Loki Distributed: Index Gateway, Bloom Filters, and Query Acceleration

## Loki Distributed Mode Architecture

Distributed Loki separates concerns into independently scalable microservices:

- **Distributor**: Validates and routes incoming log streams to ingesters
- **Ingester**: Writes logs to WAL and flushes chunks to object storage
- **Query Frontend**: Splits and caches query requests
- **Querier**: Executes LogQL queries against chunks
- **Compactor**: Merges index files and runs retention
- **Index Gateway**: Serves index queries from object storage (reduces querier memory)
- **Bloom Compactor** (experimental/GA in 3.x): Builds bloom filters for label value search acceleration
- **Bloom Gateway**: Serves bloom filter queries

## Section 1: Helm-Based Distributed Deployment

### Values Configuration

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# Generate base values
helm show values grafana/loki > loki-base-values.yaml
```

```yaml
# loki-distributed-values.yaml
loki:
  auth_enabled: true

  commonConfig:
    replication_factor: 3

  storage:
    type: s3
    bucketNames:
      chunks: loki-chunks
      ruler: loki-ruler
      admin: loki-admin
    s3:
      endpoint: https://minio.storage.svc.cluster.local:9000
      region: us-east-1
      secretAccessKey: <minio-secret-access-key>
      accessKeyId: <minio-access-key-id>
      s3ForcePathStyle: true
      insecure: false

  schemaConfig:
    configs:
      # TSDBv3 provides better cardinality handling and bloom support
      - from: "2024-01-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_
          period: 24h

  ingesterClient:
    grpc_client_config:
      grpc_compression: snappy

  ingester:
    chunk_idle_period: 1h
    chunk_block_size: 262144
    chunk_retain_period: 5m
    max_chunk_age: 2h
    wal:
      enabled: true
      dir: /var/loki/wal

  querier:
    max_concurrent: 20
    query_ingester_within: 3h

  queryRange:
    align_queries_with_step: true
    max_retries: 5
    cache_results: true
    results_cache:
      cache:
        memcached_client:
          host: loki-memcached.logging.svc.cluster.local
          service: memcache
          timeout: 500ms
          max_idle_conns: 16

  frontend:
    log_queries_longer_than: 10s
    downstream_url: http://loki-loki-distributed-querier:3100
    tail_proxy_url: http://loki-loki-distributed-querier:3100
    compress_responses: true

  frontendWorker:
    grpc_client_config:
      grpc_compression: snappy

  limits_config:
    ingestion_rate_mb: 20
    ingestion_burst_size_mb: 40
    max_label_names_per_series: 15
    max_label_value_length: 2048
    max_streams_per_user: 100000
    reject_old_samples: true
    reject_old_samples_max_age: 168h
    max_query_length: 721h
    max_query_parallelism: 32
    max_entries_limit_per_query: 10000
    split_queries_by_interval: 24h
    max_cache_freshness_per_query: 10m
    bloom_gateway_enable_filtering: true

  compactor:
    working_directory: /var/loki/compactor
    compaction_interval: 10m
    retention_enabled: true
    retention_delete_delay: 2h
    delete_request_store: s3

  bloomCompactor:
    enabled: true
    working_directory: /var/loki/bloom-compactor
    ring:
      kvstore:
        store: memberlist

  bloomGateway:
    enabled: true
    ring:
      kvstore:
        store: memberlist

  rulerConfig:
    storage:
      type: s3
    rule_path: /tmp/loki/rules-temp
    alertmanager_url: http://alertmanager.monitoring.svc.cluster.local:9093
    enable_api: true

# Component sizing
distributor:
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 2Gi
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilizationPercentage: 75

ingester:
  replicas: 3
  persistence:
    enabled: true
    size: 20Gi
    storageClass: fast-ssd
  resources:
    requests:
      cpu: 1000m
      memory: 2Gi
    limits:
      cpu: 4000m
      memory: 8Gi
  tolerations:
    - key: dedicated
      operator: Equal
      value: loki-ingester
      effect: NoSchedule
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: ingester
          topologyKey: kubernetes.io/hostname

querier:
  replicas: 3
  resources:
    requests:
      cpu: 1000m
      memory: 2Gi
    limits:
      cpu: 4000m
      memory: 8Gi
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetCPUUtilizationPercentage: 75

queryFrontend:
  replicas: 2
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 2Gi

queryScheduler:
  enabled: true
  replicas: 2
  resources:
    requests:
      cpu: 200m
      memory: 256Mi

compactor:
  replicas: 1
  persistence:
    enabled: true
    size: 10Gi
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi

bloomCompactor:
  enabled: true
  replicas: 1
  persistence:
    enabled: true
    size: 50Gi
    storageClass: fast-ssd
  resources:
    requests:
      cpu: 1000m
      memory: 4Gi
    limits:
      cpu: 4000m
      memory: 16Gi

bloomGateway:
  enabled: true
  replicas: 2
  persistence:
    enabled: true
    size: 20Gi
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 2000m
      memory: 8Gi

indexGateway:
  enabled: true
  replicas: 2
  persistence:
    enabled: true
    size: 10Gi
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi

memcached:
  enabled: true
  replicaCount: 3
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 1000m
      memory: 2Gi

memcachedExporter:
  enabled: true

serviceMonitor:
  enabled: true
  interval: 30s
```

```bash
kubectl create namespace logging

helm install loki grafana/loki-distributed \
  --namespace logging \
  --values loki-distributed-values.yaml \
  --wait --timeout 15m

kubectl get pods -n logging
```

## Section 2: TSDB Index vs BoltDB

### Why TSDB Replaced BoltDB

BoltDB shipped Loki's first stable index implementation. It stores index data in a separate bucket per day, with one file per ingester. Under high cardinality (many unique label combinations), BoltDB performance degrades significantly because:
- Compaction requires reading all index files and rewriting them
- Query time scales with the number of distinct label values
- File count grows with ingesters and retention period

TSDB (Time Series Database index, same format as Prometheus) addresses these issues:
- Single index per period (no per-ingester files)
- Efficient cardinality handling through inverted index + bloom-filtered postings
- Better compression
- Support for label index queries (needed for bloom filter metadata)

### Migrating from BoltDB to TSDB

```yaml
# Add new TSDB schema alongside existing BoltDB schema
# loki-schema-migration.yaml
loki:
  schemaConfig:
    configs:
      # Existing BoltDB schema (do not modify)
      - from: "2023-01-01"
        store: boltdb-shipper
        object_store: s3
        schema: v11
        index:
          prefix: loki_index_
          period: 24h
      # New TSDB schema for data written after migration date
      - from: "2024-06-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_tsdb_
          period: 24h
```

```bash
# Apply the schema change
helm upgrade loki grafana/loki-distributed \
  --namespace logging \
  --values loki-distributed-values.yaml \
  --values loki-schema-migration.yaml

# New data (after 2024-06-01) uses TSDB
# Old data queries fall back to BoltDB paths automatically
# No data migration required
```

## Section 3: Bloom Filters for Log Search Acceleration

### How Bloom Filters Work in Loki

Bloom filters are probabilistic data structures that answer "does this chunk possibly contain this value?" without reading the chunk itself. For Loki, they are built over the values within log lines for each series (stream).

When a query includes `|= "error" |= "payment"`, Loki can use the bloom filter to skip chunks that definitely do not contain those strings, dramatically reducing I/O for needle-in-haystack queries.

**False positive rate**: Bloom filters can return false positives (a chunk might be indicated as containing a value when it doesn't), but never false negatives (if the filter says no, the chunk definitely doesn't contain the value).

### Bloom Filter Configuration

```yaml
# Additional loki config for bloom filters
loki:
  bloomBuild:
    enabled: true
    # Build bloom filters for chunks containing more than this many bytes
    # Avoid building for tiny chunks
    minChunkSizeBytes: 1024

  bloomGateway:
    enabled: true
    workerConcurrency: 4
    blockQueryConcurrency: 2
    maxOutstandingPerTenant: 1024
    numBulkChunksFetchConcurrent: 2

  bloomCompactor:
    enabled: true
    workerParallelism: 4
    bloomPageSize: 256KB
    bloomFalsePositiveRate: 0.01

  limits_config:
    bloom_creation_enabled: true
    bloom_split_series_keyspace_by: 128
    bloom_build_max_builtAt_duration: 168h
    bloom_gateway_enable_filtering: true
    bloom_gateway_shard_size: 1
```

### Verifying Bloom Filter Usage

```bash
# Check bloom compactor activity
kubectl logs -n logging -l app.kubernetes.io/component=bloom-compactor -f | \
  grep -E "bloom|block|error"

# Query metrics for bloom filter effectiveness
# In Grafana:
# loki_bloom_gateway_blocks_queried_total
# loki_bloom_gateway_series_filtered_total
# loki_bloom_gateway_requests_total
# Filter ratio = series_filtered / (series_queried)
```

### LogQL Query Patterns Benefiting from Bloom Filters

```logql
# These queries benefit from bloom filter pre-filtering:

# String match across all streams - without bloom, reads all chunks
{namespace="production"} |= "payment gateway timeout"

# Multiple filters (AND) - bloom can skip chunks missing any value
{app="checkout"} |= "OrderID:" |= "PaymentError"

# Line filter with regex - bloom accelerates the substring portion
{namespace="production"} |~ "error.*database"

# These do NOT benefit from bloom filters (structural queries):
# Label matchers are handled by the index, not bloom
{namespace="production", level="error"}
```

## Section 4: Query Frontend and Cache Configuration

### Query Frontend Internals

The query frontend provides:
1. **Request splitting**: Breaks large time-range queries into smaller chunks (split_queries_by_interval)
2. **Result caching**: Caches query results in memcached
3. **Retry logic**: Retries failed sub-queries
4. **Priority queuing**: Separates interactive and batch queries

### Memcached Cache Tiers

```yaml
# Multiple memcached instances for different cache purposes
loki:
  queryRange:
    cache_results: true
    results_cache:
      cache:
        memcached_client:
          host: loki-chunks-cache.logging.svc.cluster.local
          timeout: 500ms
          max_idle_conns: 16
          update_interval: 1m
          consistent_hash: true

  storageConfig:
    tsdb_shipper:
      index_gateway_client:
        server_address: dns+loki-index-gateway.logging.svc.cluster.local:9095

    index_cache_validity: 5m
    index_queries_cache_config:
      memcached_client:
        host: loki-index-cache.logging.svc.cluster.local
        timeout: 500ms

  chunkStoreConfig:
    chunk_cache_config:
      memcached_client:
        host: loki-chunks-cache.logging.svc.cluster.local
        timeout: 500ms
        max_idle_conns: 24
```

### Separate Memcached Deployments

```yaml
# memcached-chunks.yaml - for chunk data (larger, more memory)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki-chunks-cache
  namespace: logging
spec:
  replicas: 3
  selector:
    matchLabels:
      app: loki-chunks-cache
  template:
    metadata:
      labels:
        app: loki-chunks-cache
    spec:
      containers:
        - name: memcached
          image: memcached:1.6-alpine
          args:
            - -m 4096        # 4GB memory
            - -c 16384       # max connections
            - -v
          ports:
            - containerPort: 11211
          resources:
            requests:
              cpu: 500m
              memory: 4.5Gi
            limits:
              cpu: 2000m
              memory: 5Gi
---
apiVersion: v1
kind: Service
metadata:
  name: loki-chunks-cache
  namespace: logging
spec:
  selector:
    app: loki-chunks-cache
  ports:
    - port: 11211
      name: memcache
```

## Section 5: Object Storage Tiering

### S3 Lifecycle Policy for Cost Optimization

```json
{
  "Rules": [
    {
      "ID": "LokiChunkTiering",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "loki-chunks/"
      },
      "Transitions": [
        {
          "Days": 30,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 90,
          "StorageClass": "GLACIER_IR"
        }
      ],
      "Expiration": {
        "Days": 365
      }
    },
    {
      "ID": "LokiIndexTiering",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "loki-index/"
      },
      "Transitions": [
        {
          "Days": 7,
          "StorageClass": "STANDARD_IA"
        }
      ],
      "Expiration": {
        "Days": 90
      }
    }
  ]
}
```

### Loki Retention Configuration

```yaml
loki:
  limits_config:
    # Global retention
    retention_period: 720h  # 30 days

  perTenantRetention:
    # Per-tenant overrides
    production:
      retention_period: 2160h  # 90 days
    development:
      retention_period: 168h   # 7 days
    audit:
      retention_period: 8760h  # 365 days

  compactor:
    retention_enabled: true
    retention_delete_delay: 2h
    retention_delete_worker_count: 150
    delete_request_store: s3
    delete_max_interval: 24h
```

### Multi-Cluster Log Aggregation

```yaml
# Loki with multi-tenancy for different clusters
# Each cluster's agents use a different X-Scope-OrgID header

# Alloy/Promtail configuration for cluster-1
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: alloy-config
  namespace: logging
data:
  config.alloy: |
    local.file_match "k8s_logs" {
      path_targets = discovery.kubernetes.pods.targets
    }

    discovery.kubernetes "pods" {
      role = "pod"
    }

    loki.source.kubernetes "pods" {
      targets    = discovery.kubernetes.pods.targets
      forward_to = [loki.write.default.receiver]
    }

    loki.write "default" {
      endpoint {
        url = "http://loki-loki-distributed-distributor.logging.svc.cluster.local:3100/loki/api/v1/push"
        tenant_id = "cluster-1"
      }
      external_labels = {
        cluster = "cluster-1",
        env     = "production",
      }
    }
```

## Section 6: LogQL Query Optimization

### Stream Selector Specificity

The most important optimization: make label matchers as specific as possible. Loki queries all streams matching the selector before applying log filters.

```logql
# Bad: Too broad - queries all logs in production
{namespace="production"} |= "ERROR"

# Better: Add application label
{namespace="production", app="checkout"} |= "ERROR"

# Best: Add specific labels to minimize matched streams
{namespace="production", app="checkout", container="api"} |= "ERROR"

# Avoid regex in stream selectors when possible (exact matches are faster):
# Bad:
{namespace=~"production|staging"} |= "ERROR"

# Good: Use two separate queries or union in recording rules:
{namespace="production"} |= "ERROR"
```

### Structured Metadata and Label Extraction

```logql
# Extract structured data to filter/aggregate efficiently

# Parse JSON logs and filter on extracted fields
{app="payment-service"}
  | json
  | amount > 1000
  | status_code = "500"
  | line_format "{{.timestamp}} {{.transaction_id}} amount={{.amount}}"

# Extract fields from unstructured logs with logfmt
{app="nginx"}
  | logfmt
  | method = "POST"
  | path =~ "/api/v[0-9]+/checkout"
  | status >= 400

# Use pattern to extract fields from custom log formats
{app="legacy-app"}
  | pattern "<timestamp> [<level>] <message>"
  | level = "ERROR"

# Avoid extracting fields you don't need to filter on
# Each extracted label increases memory usage per stream
```

### Metric Queries

```logql
# Rate of errors per application in the last 5 minutes
sum(rate({namespace="production"} |= "level=error" [5m])) by (app)

# P95 latency from structured logs
quantile_over_time(0.95,
  {app="api-gateway"}
  | json
  | unwrap response_time_ms [5m]
) by (endpoint)

# Error rate as a percentage
sum(rate({namespace="production"} | json | level = "error" [5m])) by (app)
/
sum(rate({namespace="production"} [5m])) by (app)
* 100

# Top 10 slowest requests
topk(10,
  last_over_time(
    {app="api"} | json | unwrap duration_ms [1m]
  ) by (request_id, path)
)
```

### Recording Rules for Common Aggregations

```yaml
# loki-recording-rules.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-rules
  namespace: logging
data:
  error-rates.yaml: |
    groups:
      - name: error_rates
        interval: 1m
        rules:
          - record: job:loki_log_errors:rate5m
            expr: |
              sum(rate({namespace="production"} | json | level = "error" [5m])) by (namespace, app)

          - record: job:loki_http_requests:rate5m
            expr: |
              sum(rate({app=~".+"} | json | http_method =~ ".+" [5m])) by (app, http_method, http_status)

      - name: slo_rules
        interval: 5m
        rules:
          - alert: HighErrorRate
            expr: |
              (
                sum(rate({namespace="production"} | json | level = "error" [5m])) by (app)
                /
                sum(rate({namespace="production"} [5m])) by (app)
              ) > 0.05
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "High error rate for {{ $labels.app }}"
              description: "Error rate is {{ $value | humanizePercentage }}"
```

## Section 7: Operations and Monitoring

### Key Loki Metrics to Monitor

```yaml
# Grafana dashboard queries for Loki health

# Ingestion rate (lines/second)
sum(rate(loki_distributor_lines_received_total[1m])) by (tenant)

# Ingestion errors
sum(rate(loki_distributor_ingester_appends_failures_total[1m]))

# Query latency p99
histogram_quantile(0.99,
  sum(rate(loki_query_frontend_queue_duration_seconds_bucket[5m])) by (le)
)

# Cache hit rate (should be >70% for frequently accessed time ranges)
sum(rate(loki_cache_fetched_keys_total[5m]))
/
sum(rate(loki_cache_requested_keys_total[5m]))

# Compactor lag (how far behind retention processing is)
loki_compactor_oldest_unconsumed_retention_age_hours

# Ingester WAL replay duration at startup
loki_ingester_wal_replay_duration_seconds

# Bloom filter filtering ratio
sum(rate(loki_bloom_gateway_series_filtered_total[5m]))
/
sum(rate(loki_bloom_gateway_series_queried_total[5m]))
```

### Chunk Cache Warming

After a restart, cache is cold and queries are slow. Warm the cache by running common queries:

```bash
#!/bin/bash
# warm-cache.sh - run common queries to warm Loki cache

LOKI_URL="http://loki-query-frontend.logging.svc.cluster.local:3100"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HOUR_AGO=$(date -u -d "1 hour ago" +"%Y-%m-%dT%H:%M:%SZ")

# Common namespaces to warm
NAMESPACES=("production" "staging" "monitoring")

for ns in "${NAMESPACES[@]}"; do
  echo "Warming cache for namespace: ${ns}"
  curl -s "${LOKI_URL}/loki/api/v1/query_range" \
    -H "X-Scope-OrgID: cluster-1" \
    --data-urlencode "query=rate({namespace=\"${ns}\"} [5m])" \
    --data-urlencode "start=${HOUR_AGO}" \
    --data-urlencode "end=${NOW}" \
    --data-urlencode "step=60s" > /dev/null
done
echo "Cache warming complete"
```

### Troubleshooting Common Issues

```bash
# Issue: Slow queries
# Check query scheduler queue depth
kubectl exec -n logging \
  $(kubectl get pods -n logging -l app.kubernetes.io/component=query-frontend -o jsonpath='{.items[0].metadata.name}') \
  -- wget -qO- http://localhost:3100/metrics | grep queue_length

# Issue: Ingestion lag (ingesters falling behind)
kubectl top pods -n logging -l app.kubernetes.io/component=ingester
# Check for high memory usage indicating flush is needed

# Force flush ingester WAL
kubectl exec -n logging \
  $(kubectl get pods -n logging -l app.kubernetes.io/component=ingester -o jsonpath='{.items[0].metadata.name}') \
  -- wget -qO- -X POST http://localhost:3100/ingester/flush

# Issue: Compactor not compacting
kubectl logs -n logging -l app.kubernetes.io/component=compactor | grep -E "compac|error"

# Issue: Index gateway consuming too much memory
# Reduce the index cache size
kubectl patch configmap loki-config -n logging \
  --patch '{"data": {"config.yaml": "..."}}'
# Or reduce gateway replicas temporarily
kubectl scale deployment loki-loki-distributed-index-gateway -n logging --replicas=1
```

## Conclusion

Loki's distributed mode with TSDB indexing, bloom filter acceleration, and multi-tier caching delivers production-grade log querying at scale. The key performance levers are: using specific stream selectors to reduce the number of chunks queried, enabling bloom filter pre-filtering for substring searches, configuring memcached for results caching, and writing LogQL recording rules for frequently-accessed aggregations. Object storage lifecycle policies manage long-term costs by automatically tiering older chunks to cheaper storage classes. With proper sizing of each component based on your ingestion rate and query patterns, Loki distributed can handle hundreds of gigabytes of log ingestion per day while maintaining sub-second query response times for recent data.
