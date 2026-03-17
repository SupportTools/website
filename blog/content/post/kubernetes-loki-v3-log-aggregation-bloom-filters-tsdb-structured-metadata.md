---
title: "Kubernetes Loki v3.x Log Aggregation: Chunk Format, Bloom Filters, Query Acceleration, Structured Metadata, and TSDB Index"
date: 2032-03-04T00:00:00-05:00
draft: false
tags: ["Loki", "Kubernetes", "Observability", "Log Aggregation", "TSDB", "Bloom Filters", "Grafana"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Loki v3.x architecture: TSDB index format, bloom filter acceleration, structured metadata, chunk encoding, and production tuning for enterprise Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-loki-v3-log-aggregation-bloom-filters-tsdb-structured-metadata/"
---

Loki v3.x represents a fundamental rearchitecting of how log data is indexed and queried at scale. The introduction of TSDB as the primary index, native bloom filters for chunk skipping, and first-class structured metadata changes the operational calculus for teams running large Kubernetes log pipelines. This post dissects each subsystem, explains the on-disk formats, and provides production-ready configuration for enterprise deployments.

<!--more-->

# Kubernetes Loki v3.x Log Aggregation: Chunk Format, Bloom Filters, Query Acceleration, Structured Metadata, and TSDB Index

## Why Loki v3.x Is a Different Beast

Loki's original design intentionally avoided full-text indexing. Labels were the only indexed dimension, and every query that needed to filter on log content required scanning every chunk that matched the label set. This worked well at small scale but created a performance cliff as ingest rates grew beyond a few hundred GB per day per cluster.

Loki v3.x addresses this with three interlocking improvements:

1. **TSDB index** replaces BoltDB-shipper and bespoke store-gateway indexes with a Prometheus-compatible TSDB block format that supports faster label lookups, better compaction, and native chunk reference storage.
2. **Bloom filters** allow Loki to skip individual chunks during content searches, reducing I/O by orders of magnitude for selective queries.
3. **Structured metadata** provides a lightweight mechanism to attach key-value pairs to log lines without bloating label cardinality, enabling high-cardinality fields like `trace_id` or `request_id` to participate in queries without index explosion.

Understanding each layer is prerequisite to operating Loki v3.x correctly in production.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Write Path                            │
│                                                          │
│  Promtail/Alloy  ──►  Distributor  ──►  Ingester        │
│                           │                │             │
│                     (ring hash)      (WAL + head chunk)  │
│                                           │              │
│                                     Object Store         │
│                                    (chunks + TSDB)       │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                    Read Path                             │
│                                                          │
│  Grafana/LogCLI  ──►  Query Frontend  ──►  Querier      │
│                           │                 │            │
│                     (sharding/cache)  (TSDB lookup)     │
│                                       (bloom filter)    │
│                                       (chunk fetch)     │
└──────────────────────────────────────────────────────────┘
```

## TSDB Index Format

### Why TSDB Over BoltDB-Shipper

BoltDB-shipper was a stopgap that required each ingester to maintain local BoltDB files synchronized to object storage. This created operational problems: slow startup times, large memory footprints during compaction, and eventual consistency windows during which queries could return incomplete results.

TSDB solves these problems by treating the index as an immutable series of blocks. Each TSDB block covers a time range and contains:

- A series file mapping fingerprints to label sets
- A postings index mapping label name/value pairs to series lists
- A chunks index mapping series to chunk references in object storage

```
tsdb-block/
├── chunks/
│   └── 000001          # series data (label sets only, not log content)
├── index
│   ├── postings        # inverted index: label=value → [series_id, ...]
│   └── series          # series_id → {labels, chunk_refs}
└── meta.json
```

The `meta.json` for a production block:

```json
{
  "ulid": "01HXYZ1234ABCDEFGHIJKLMNOP",
  "minTime": 1710000000000,
  "maxTime": 1710086400000,
  "stats": {
    "numSamples": 0,
    "numSeries": 142857,
    "numChunks": 2857140,
    "numBytes": 8589934592
  },
  "compaction": {
    "level": 2,
    "sources": ["01HXYZ...", "01HABC..."],
    "parents": []
  },
  "version": 1
}
```

### Label Fingerprinting and Cardinality

Loki v3.x uses xxHash64 for label set fingerprinting. A stream's fingerprint is computed over the sorted label set:

```
fingerprint = xxhash64(sorted_labels_as_bytes)
```

High-cardinality labels (pod name, container ID) are expected and handled efficiently by TSDB because the index only stores label-to-series mappings, not label-to-chunk mappings. Chunk references are stored per series, keeping the index compact.

Monitoring cardinality:

```logql
# Count unique series per namespace
sum by (namespace) (count_over_time({job="loki"} |= "series" [1h]))

# Check index stats via API
curl -s http://loki-query-frontend:3100/loki/api/v1/index/stats \
  -G --data-urlencode 'query={namespace="production"}' \
  --data-urlencode 'start=1710000000' \
  --data-urlencode 'end=1710086400' | jq .
```

### TSDB Compaction Configuration

```yaml
# loki-config.yaml
compactor:
  working_directory: /data/loki/compactor
  shared_store: s3
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  retention_delete_worker_count: 150
  delete_request_store: s3

ingester:
  chunk_idle_period: 30m
  chunk_block_size: 262144        # 256 KiB uncompressed block size
  chunk_target_size: 1572864      # 1.5 MiB target chunk size
  chunk_retain_period: 1m
  max_transfer_retries: 0
  wal:
    enabled: true
    dir: /data/loki/wal
    checkpoint_duration: 5m
    flush_on_shutdown: true
    replay_memory_ceiling: 4GB
```

## Chunk Format Deep Dive

### Chunk Encoding Options

Loki v3.x supports three chunk encodings:

| Encoding | Value | Best For |
|----------|-------|----------|
| GZIP | 0 | Maximum compression, CPU intensive |
| LZ4_64k | 1 | Fast decompression, moderate ratio |
| Snappy | 2 | Balanced, default pre-v3 |
| LZ4_256k | 3 | Better ratio than LZ4_64k |
| LZ4_1M | 4 | High-throughput ingestion |
| LZ4_4M | 5 | Large batch ingestion |
| Zstd | 6 | Best ratio/speed tradeoff for v3 |
| None | 7 | Testing only |

The default for v3.x is `zstd`, which typically achieves 10-15x compression on structured JSON logs while maintaining fast decompression.

```yaml
ingester:
  chunk_encoding: zstd
```

### On-Disk Chunk Layout

Each chunk file in object storage follows this binary layout:

```
[4 bytes]  Magic number: 0x012EE56A
[1 byte]   Encoding type
[4 bytes]  Data length (big-endian uint32)
[N bytes]  Compressed block data
[4 bytes]  CRC32 checksum

Within each uncompressed block:
[8 bytes]  Timestamp (nanoseconds, varint delta-encoded)
[2 bytes]  Line length (uint16)
[N bytes]  Log line UTF-8 bytes
[M bytes]  Structured metadata (see below)
```

Delta-encoding timestamps means that for high-frequency logs (hundreds per second), timestamps compress to 2-4 bytes per entry instead of 8.

### Chunk Head and Tail

Ingesters maintain an in-memory "head chunk" that is uncompressed and mutable. When the head chunk reaches `chunk_target_size` or `chunk_idle_period` expires, it is sealed, compressed, and flushed to object storage.

The WAL records every log entry before the head chunk is flushed, providing durability during ingester restarts:

```yaml
ingester:
  wal:
    enabled: true
    dir: /data/loki/wal
    # WAL segment size - larger reduces fsync overhead but increases recovery time
    flush_on_shutdown: true
    replay_memory_ceiling: 4GB
```

## Bloom Filters for Query Acceleration

### The Problem Bloom Filters Solve

Without bloom filters, a query like:

```logql
{namespace="production"} |= "error_code=ERR_5042"
```

requires Loki to fetch and decompress every chunk in the matching label set and scan each line. If the error is rare (appearing in 0.1% of chunks), 99.9% of the I/O is wasted.

A bloom filter answers the question: "Does this chunk *possibly* contain the string `error_code=ERR_5042`?" If the filter says no, the chunk is skipped entirely. False positives are possible (leading to unnecessary fetches), but false negatives are impossible (no matching chunk is ever skipped).

### Bloom Filter Architecture in Loki v3.x

Loki implements a two-level bloom filter hierarchy:

1. **Series-level bloom**: One filter per log stream (label set). Stores tokens extracted from all lines in the series.
2. **Block-level bloom**: Aggregates series filters for a TSDB block. Enables fast series pruning before chunk-level decisions.

```
TSDB Block
├── index
├── chunks/
└── bloom/
    ├── meta.json        # bloom block metadata
    ├── series           # per-series bloom filters (8-bit Golomb-coded)
    └── blocks           # block-level aggregated filters
```

### Enabling and Configuring Bloom Filters

```yaml
# loki-config.yaml
bloom_build:
  enabled: true
  builder:
    planning_table_range: 24h
  planner:
    bloom_split_series_key_space_at: 256
    min_table_freshness: 1h
    max_bloom_age: 7d
    bloom_max_global_series_per_tenant: 0    # 0 = unlimited
    bloom_max_chunk_age: 168h                # 7 days

bloom_gateway:
  enabled: true
  client:
    addresses: "dns+loki-bloom-gateway-headless.logging:9095"
    cache_results: true
    results_cache:
      cache:
        embedded_cache:
          enabled: true
          max_size_mb: 512
          ttl: 1h
```

Bloom builder Kubernetes deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki-bloom-builder
  namespace: logging
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/component: bloom-builder
  template:
    metadata:
      labels:
        app.kubernetes.io/component: bloom-builder
    spec:
      containers:
      - name: loki
        image: grafana/loki:3.4.1
        args:
        - -config.file=/etc/loki/config.yaml
        - -target=bloom-builder
        resources:
          requests:
            cpu: "2"
            memory: 4Gi
          limits:
            cpu: "4"
            memory: 8Gi
        volumeMounts:
        - name: config
          mountPath: /etc/loki
        - name: data
          mountPath: /data/loki
      volumes:
      - name: config
        configMap:
          name: loki-config
      - name: data
        emptyDir: {}
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: loki-bloom-gateway
  namespace: logging
spec:
  replicas: 3
  serviceName: loki-bloom-gateway-headless
  selector:
    matchLabels:
      app.kubernetes.io/component: bloom-gateway
  template:
    spec:
      containers:
      - name: loki
        image: grafana/loki:3.4.1
        args:
        - -config.file=/etc/loki/config.yaml
        - -target=bloom-gateway
        resources:
          requests:
            cpu: "4"
            memory: 8Gi
          limits:
            cpu: "8"
            memory: 16Gi
```

### Tokenization Strategy

Bloom filters index tokens extracted from log lines. Loki's default tokenizer uses n-gram splitting with a configurable n-gram length:

```yaml
bloom_build:
  builder:
    n_gram_length: 4       # Index 4-character substrings
    n_gram_skip: 0         # No skip between n-grams (densest coverage)
```

For a log line `"request_id=abc123def"`, the tokens with `n_gram_length=4` would be:
`requ`, `eque`, `ques`, `uest`, `est_`, `st_i`, `t_id`, `_id=`, `id=a`, `d=ab`, `=abc`, `abc1`, `bc12`, `c123`, `123d`, `23de`, `3def`

The false positive rate is a function of filter size and token count. Loki targets a 1% FPR by default, meaning 1 in 100 chunks without the token will still be fetched.

### Measuring Bloom Filter Effectiveness

```bash
# Check bloom filter cache hit rate
curl -s http://loki-query-frontend:3100/metrics | grep bloom_gateway

# Relevant metrics:
# loki_bloom_gateway_requests_total
# loki_bloom_gateway_chunks_filtered_total
# loki_bloom_gateway_chunks_requested_total

# Calculate filter effectiveness:
# effectiveness = chunks_filtered / (chunks_filtered + chunks_requested)
```

A well-tuned deployment should filter 80-95% of chunks for selective queries.

## Structured Metadata

### The Cardinality Problem It Solves

Before structured metadata, teams faced a dilemma: high-cardinality fields like `trace_id`, `request_id`, and `user_id` were useful for filtering but catastrophic as labels. Adding them to the label set created millions of unique streams, destroying ingester performance.

Structured metadata provides a middle path: key-value pairs attached to individual log lines (not the stream), stored alongside the log content but separate from the stream labels.

### Metadata Storage and Encoding

Structured metadata is encoded in the chunk block after the log line:

```
[line_length: uint16]
[line_bytes: N]
[metadata_count: varint]
for each metadata pair:
  [key_length: varint]
  [key_bytes: N]
  [value_length: varint]
  [value_bytes: N]
```

The metadata is indexed in bloom filters (when configured) and accessible in LogQL pipelines.

### Sending Structured Metadata via Promtail

```yaml
# promtail-config.yaml
scrape_configs:
- job_name: kubernetes-pods
  kubernetes_sd_configs:
  - role: pod
  pipeline_stages:
  - json:
      expressions:
        trace_id: traceID
        span_id: spanID
        request_id: requestID
        user_id: userID
        error_code: errorCode
  - structured_metadata:
      trace_id:
      span_id:
      request_id:
      user_id:
      error_code:
  - labels:
      # Only low-cardinality fields as stream labels
      level:
      service:
```

### Querying Structured Metadata

```logql
# Filter on structured metadata field
{namespace="production"} | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"

# Multiple metadata filters
{service="checkout"} | request_id =~ "req-[0-9]+" | error_code != ""

# Extract metadata into a label for aggregation
{namespace="production"}
  | json
  | line_format "{{.message}}"
  | label_format error_code="{{.error_code}}"
  | error_code != ""
  | count_over_time([5m]) by (error_code)

# Correlate logs across services via trace_id
{namespace="production"} | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
| line_format "[{{.service}}] {{.message}}"
```

### Alloy Configuration for Structured Metadata

```river
// Grafana Alloy (successor to Promtail) config
loki.source.kubernetes "pods" {
  targets    = discovery.kubernetes.pods.targets
  forward_to = [loki.process.extract_metadata.receiver]
}

loki.process "extract_metadata" {
  forward_to = [loki.write.default.receiver]

  stage.json {
    expressions = {
      trace_id   = "traceId",
      span_id    = "spanId",
      request_id = "requestId",
      level      = "level",
      message    = "message",
    }
  }

  stage.structured_metadata {
    values = {
      trace_id   = "trace_id",
      span_id    = "span_id",
      request_id = "request_id",
    }
  }

  stage.labels {
    values = {
      level = "level",
    }
  }
}

loki.write "default" {
  endpoint {
    url = "http://loki-distributor.logging:3100/loki/api/v1/push"
  }
}
```

## Query Acceleration: Sharding and Caching

### Query Frontend Sharding

The query frontend shards time-range queries by splitting them into parallel sub-queries. With TSDB, sharding is more precise because the index can quickly identify which TSDB blocks overlap a time range.

```yaml
query_range:
  parallelise_shardable_queries: true
  shard_streams:
    enabled: true
    logging_enabled: false
    desired_rate: 3MB      # Target shard size
  results_cache:
    cache:
      embedded_cache:
        enabled: true
        max_size_mb: 1024
        ttl: 10m
  cache_results: true

frontend:
  max_outstanding_per_tenant: 2048
  compress_encodings: true
  log_queries_longer_than: 10s
```

### Index Query Cache

The TSDB index query cache prevents repeated label lookups from hitting object storage:

```yaml
chunk_store_config:
  chunk_cache_config:
    embedded_cache:
      enabled: true
      max_size_mb: 2048
      ttl: 1h
  write_dedupe_cache_config:
    embedded_cache:
      enabled: true
      max_size_mb: 256
      ttl: 1h

storage_config:
  tsdb_shipper:
    active_index_directory: /data/loki/index
    cache_location: /data/loki/index-cache
    cache_ttl: 24h
    shared_store: s3
  aws:
    s3: s3://<aws-region>/<loki-chunks-bucket>
    s3forcepathstyle: false
    bucketnames: <loki-chunks-bucket>
    region: <aws-region>
    access_key_id: <aws-access-key-id>
    secret_access_key: <aws-secret-access-key>
```

### Query Scheduler for Large Deployments

For clusters with high query concurrency, the query scheduler decouples the query frontend from queriers:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki-query-scheduler
  namespace: logging
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: loki
        image: grafana/loki:3.4.1
        args:
        - -target=query-scheduler
        - -config.file=/etc/loki/config.yaml
        resources:
          requests:
            cpu: "1"
            memory: 512Mi
          limits:
            cpu: "2"
            memory: 1Gi
```

```yaml
# In loki config
query_scheduler:
  max_outstanding_requests_per_tenant: 1024
  use_scheduler_ring: true

frontend:
  scheduler_address: "loki-query-scheduler.logging:9095"

querier:
  scheduler_address: "loki-query-scheduler.logging:9095"
```

## Production Helm Values

```yaml
# values-production.yaml
loki:
  auth_enabled: true
  commonConfig:
    replication_factor: 3
  storage:
    type: s3
    s3:
      region: <aws-region>
      bucketnames: <loki-chunks-bucket>
      endpoint: s3.<aws-region>.amazonaws.com

  schemaConfig:
    configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_index_
        period: 24h

  ingester:
    chunk_encoding: zstd
    chunk_target_size: 1572864
    chunk_idle_period: 30m
    wal:
      enabled: true
      replay_memory_ceiling: 4GB

  limits_config:
    ingestion_rate_mb: 50
    ingestion_burst_size_mb: 100
    max_label_names_per_series: 30
    max_label_value_length: 2048
    max_streams_per_user: 100000
    max_global_streams_per_user: 500000
    max_chunks_per_query: 2000000
    max_query_series: 100000
    max_query_parallelism: 64
    max_entries_limit_per_query: 50000
    retention_period: 744h    # 31 days default
    per_stream_rate_limit: 5MB
    per_stream_rate_limit_burst: 20MB

  bloom_build:
    enabled: true

  bloom_gateway:
    enabled: true

ingester:
  replicas: 6
  resources:
    requests:
      cpu: "4"
      memory: 8Gi
    limits:
      cpu: "8"
      memory: 16Gi
  persistence:
    enabled: true
    size: 50Gi
    storageClass: gp3

distributor:
  replicas: 3
  resources:
    requests:
      cpu: "2"
      memory: 2Gi

queryFrontend:
  replicas: 2
  resources:
    requests:
      cpu: "2"
      memory: 4Gi

querier:
  replicas: 6
  resources:
    requests:
      cpu: "4"
      memory: 8Gi

bloomBuilder:
  enabled: true
  replicas: 3

bloomGateway:
  enabled: true
  replicas: 3
```

## Per-Tenant Retention and Limits

```yaml
# Override limits per tenant
overrides_config:
  path: /etc/loki/overrides.yaml

# overrides.yaml
overrides:
  "tenant-audit":
    retention_period: 2160h    # 90 days for audit logs
    ingestion_rate_mb: 10
    max_global_streams_per_user: 50000

  "tenant-debug":
    retention_period: 48h      # 2 days for debug logs
    ingestion_rate_mb: 100
    per_stream_rate_limit: 50MB

  "tenant-prod":
    retention_period: 744h
    ingestion_rate_mb: 200
    max_global_streams_per_user: 1000000
    bloom_build_enabled: true
```

## Alerting on Loki Health

```yaml
# PrometheusRule for Loki v3.x
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: loki-alerts
  namespace: logging
spec:
  groups:
  - name: loki.ingester
    rules:
    - alert: LokiIngesterUnhealthy
      expr: |
        (
          loki_ring_members{name="ingester",state="ACTIVE"}
          /
          loki_ring_members{name="ingester",state=~"ACTIVE|JOINING|LEAVING"}
        ) < 0.5
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Less than 50% of Loki ingesters are active"

    - alert: LokiIngesterHighWALSize
      expr: |
        loki_ingester_wal_disk_full_failures_total > 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Loki ingester WAL disk full"

    - alert: LokiHighChunkUtilization
      expr: |
        (
          loki_ingester_chunks_encoded_bytes_total
          /
          loki_ingester_chunk_stored_bytes_total
        ) > 2.0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Loki chunk compression ratio degraded"

  - name: loki.query
    rules:
    - alert: LokiQueryLatencyHigh
      expr: |
        histogram_quantile(0.99,
          sum(rate(loki_request_duration_seconds_bucket{route="/loki/api/v1/query_range"}[5m]))
          by (le)
        ) > 30
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Loki p99 query latency above 30 seconds"

    - alert: LokiBloomGatewayLowFilterRate
      expr: |
        (
          rate(loki_bloom_gateway_chunks_filtered_total[10m])
          /
          (
            rate(loki_bloom_gateway_chunks_filtered_total[10m])
            + rate(loki_bloom_gateway_chunks_requested_total[10m])
          )
        ) < 0.5
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Bloom filter effectiveness below 50%"
```

## Troubleshooting Common Issues

### High Cardinality Streams

```bash
# Find highest cardinality label combinations
curl -s "http://loki-query-frontend:3100/loki/api/v1/label" | jq '.data[]' | \
  while read label; do
    count=$(curl -s "http://loki-query-frontend:3100/loki/api/v1/label/${label}/values" | jq '.data | length')
    echo "$count $label"
  done | sort -rn | head -20

# Query to find streams with most chunks
{__name__=~".+"} | rate()[5m] | topk(20)
```

### Bloom Filter Build Failures

```bash
# Check bloom builder logs
kubectl logs -n logging -l app.kubernetes.io/component=bloom-builder --tail=100 | \
  grep -E "(error|ERROR|failed|FAILED)"

# Check bloom gateway metrics
kubectl exec -n logging loki-bloom-gateway-0 -- \
  curl -s localhost:3100/metrics | grep bloom_gateway_store

# Force rebuild for a specific tenant
curl -X POST "http://loki-bloom-builder:3100/bloom/build/tables/<tenant-id>"
```

### TSDB Compaction Backlog

```bash
# Check compactor status
curl -s http://loki-compactor:3100/metrics | grep -E "loki_compactor_(runs|blocks|bytes)"

# Check for stuck compaction
curl -s http://loki-compactor:3100/loki/api/v1/delete | jq .

# Compactor ring status
curl -s http://loki-compactor:3100/ring | jq .
```

### WAL Replay Slowness

If ingester startup is slow due to large WAL files:

```yaml
ingester:
  wal:
    replay_memory_ceiling: 8GB    # Increase for faster replay
    checkpoint_duration: 5m       # More frequent checkpoints reduce replay size
    flush_on_shutdown: true        # Flush WAL to chunks on graceful shutdown
```

## Migration from BoltDB-Shipper to TSDB

```yaml
# Schema migration: add v13 with TSDB while keeping v12 for historical data
schema_config:
  configs:
  # Historical data: keep boltdb-shipper
  - from: "2023-01-01"
    store: boltdb-shipper
    object_store: s3
    schema: v12
    index:
      prefix: index_
      period: 24h

  # New data: TSDB
  - from: "2024-06-01"
    store: tsdb
    object_store: s3
    schema: v13
    index:
      prefix: loki_index_
      period: 24h
```

The dual-schema configuration allows Loki to serve historical queries against the old index while writing new data in TSDB format. After the retention period for old data expires, the old schema entry can be removed.

## Summary

Loki v3.x with TSDB, bloom filters, and structured metadata represents a mature log aggregation platform capable of handling petabyte-scale workloads. The key operational takeaways are:

- Use TSDB schema v13 for all new deployments; migrate historical data by adding a parallel schema config entry
- Enable bloom filters for query-heavy workloads where selective content searches are common; expect 80-95% chunk skip rates for selective queries
- Route high-cardinality identifiers (trace IDs, request IDs) through structured metadata rather than stream labels
- Size the bloom gateway with at least 8 GiB memory per replica for large deployments
- Monitor `loki_bloom_gateway_chunks_filtered_total` to verify bloom filters are providing value
- Use per-tenant overrides aggressively to prevent noisy tenants from impacting cluster stability
