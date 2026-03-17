---
title: "Kubernetes Grafana Mimir: Write Path Sharding, Query Federation, Per-Tenant Overrides, and Alertmanager Integration"
date: 2032-03-07T00:00:00-05:00
draft: false
tags: ["Mimir", "Grafana", "Kubernetes", "Prometheus", "Observability", "Monitoring", "Multi-tenant"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Grafana Mimir on Kubernetes: write path sharding with ingesters and distributors, query federation across tenants, per-tenant configuration overrides, and Alertmanager HA integration."
more_link: "yes"
url: "/kubernetes-grafana-mimir-write-path-sharding-query-federation-enterprise-guide/"
---

Grafana Mimir scales Prometheus metrics storage to billions of active series with horizontal write path sharding, long-term storage in object storage, and multi-tenant isolation. Operating it in production requires understanding how each component contributes to data durability and query consistency. This guide covers the write path in detail, query federation patterns, per-tenant override strategies, and reliable Alertmanager clustering.

<!--more-->

# Kubernetes Grafana Mimir: Write Path Sharding, Query Federation, Per-Tenant Overrides, and Alertmanager Integration

## Mimir Architecture Overview

Mimir separates write and read paths into independently scalable component groups:

```
Write Path:
  Prometheus → Distributor → Ingester (ring, WAL) → Compactor → Object Store

Read Path:
  Grafana → Query Frontend → Query Scheduler → Querier → Store Gateway → Object Store
                                                              ↓
                                                          Ingester (recent data)

Control Plane:
  Ruler (recording rules + alerts) → Alertmanager → Notification channels
  Compactor (TSDB block compaction + retention)
  Ruler Storage / Alertmanager Storage → Object Store
```

Each component is stateless (with the exception of ingesters and store-gateways, which maintain local caches) and can be scaled independently.

## Write Path Deep Dive

### Distributor: Hashing and Replication

The distributor receives remote_write requests and fans them out to ingesters. It uses a consistent hash ring to determine which ingesters own each series.

```
Incoming time series fingerprint
    │
    ▼
Hash ring lookup → [Ingester-1, Ingester-3, Ingester-5]  (replication_factor=3)
    │                     │             │             │
    └──────────────────── ▼             ▼             ▼
                      Write to all RF replicas in parallel
                      Wait for (RF/2 + 1) = 2 acknowledgments
```

The fingerprint is computed over the metric's sorted label set. This ensures that all time series for the same metric (same labels) always land on the same set of ingesters, enabling efficient in-memory aggregation.

```yaml
# mimir-config.yaml - distributor section
distributor:
  ring:
    instance_addr: ""    # Auto-detected
    kvstore:
      store: memberlist  # Gossip-based ring (no external KV dependency)
    heartbeat_period: 5s
    heartbeat_timeout: 1m

  # Limits applied at the distributor before forwarding
  instance_limits:
    max_ingestion_rate: 0           # 0 = unlimited per instance
    max_inflight_push_requests: 1000
    max_inflight_push_requests_bytes: 524288000  # 500 MiB

ingester:
  ring:
    replication_factor: 3
    kvstore:
      store: memberlist
    zone_awareness_enabled: true    # Spread replicas across AZs
    tokens_file_path: /data/tokens
```

### Zone-Aware Replication

Zone awareness ensures that the three replicas of each series land in three different availability zones, preventing a single AZ outage from causing data loss:

```yaml
ingester:
  ring:
    zone_awareness_enabled: true
    instance_availability_zone: "${AVAILABILITY_ZONE}"  # Set via Downward API

# Kubernetes Deployment with zone topology spread
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mimir-ingester
spec:
  replicas: 9    # 3 per AZ, 3 AZs
  template:
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app.kubernetes.io/component: ingester
      containers:
      - name: mimir
        image: grafana/mimir:2.14.0
        env:
        - name: AVAILABILITY_ZONE
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['topology.kubernetes.io/zone']
        args:
        - -target=ingester
        - -config.file=/etc/mimir/config.yaml
        - -ingester.ring.instance-availability-zone=$(AVAILABILITY_ZONE)
```

### Ingester WAL and Chunk Encoding

Ingesters maintain an in-memory series store and a write-ahead log (WAL) for durability. On flush, data is written to TSDB blocks in object storage.

```yaml
ingester:
  active_series_metrics_enabled: true
  active_series_metrics_idle_timeout: 10m

  wal:
    dir: /data/mimir/ingester
    checkpoint_duration: 30m

  instance_limits:
    max_series: 0
    max_tenants: 0

blocks_storage:
  backend: s3
  s3:
    endpoint: s3.<aws-region>.amazonaws.com
    region: <aws-region>
    bucket_name: <mimir-blocks-bucket>
    access_key_id: <aws-access-key-id>
    secret_access_key: <aws-secret-access-key>
  tsdb:
    dir: /data/mimir/tsdb
    block_ranges_period: [2h]
    retention_period: 13h     # Keep blocks locally until compactor confirms upload
    ship_interval: 1m         # How often to upload completed blocks to object storage
    head_chunks_write_buffer_size_bytes: 4194304  # 4 MiB
    head_compaction_interval: 1m
    stripe_size: 16384        # Stripe count for per-series stripe locking
    wal_compression_enabled: true
```

### Distributor Write Sharding with Ingestion Sharding

For very high ingestion rates (>5M active series), Mimir can shard series at the distributor level across multiple ingester groups:

```yaml
distributor:
  shard_by_all_labels: false   # When true, different label combinations can hit different ingesters
  write_path_shard_count: 1    # Number of write shards (default 1 = no extra sharding)

# Per-tenant ingestion sharding override (see Per-Tenant Overrides section)
# max_global_series_per_user: 10000000
# ingestion_tenant_shard_size: 100  # Number of ingesters to spread this tenant across
```

## Query Path and Federation

### Query Frontend Splitting

The query frontend splits long time ranges into parallel sub-queries and caches results:

```yaml
query_range:
  # Split queries longer than this interval into parallel pieces
  split_queries_by_interval: 24h

  # Results cache configuration
  results_cache:
    backend: memcached
    memcached:
      addresses: "dns+mimir-memcached.monitoring:11211"
      max_async_concurrency: 50
      max_async_buffer_size: 10000
      max_get_multi_concurrency: 100
      max_item_size: 1048576    # 1 MiB per cache item
      timeout: 500ms
      min_idle_connections: 10

  cache_results: true
  max_retries: 3
  parallelise_shardable_queries: true
  shard_active_series_queries: true

frontend:
  max_outstanding_per_tenant: 2048
  query_sharding_total_shards: 16    # Number of parallel shards per query
  query_sharding_max_sharded_queries: 128
  log_queries_longer_than: 10s
  compress_encodings: true
  downstream_url: "http://mimir-query-scheduler.monitoring:9095"
```

### Query Scheduler

The query scheduler decouples the frontend from queriers and provides fair queuing:

```yaml
query_scheduler:
  max_outstanding_requests_per_tenant: 1024
  querier_forget_delay: 1m
  grpc_client_config:
    grpc_compression: gzip
    rate_limit: 0
    rate_limit_burst: 0
    backoff_on_ratelimits: false
```

### Store Gateway: Block Sharding

Store gateways hold an index cache for TSDB blocks in object storage. They use a consistent hash ring to distribute ownership of blocks:

```yaml
store_gateway:
  sharding_enabled: true
  sharding_ring:
    replication_factor: 3
    kvstore:
      store: memberlist
    zone_awareness_enabled: true
    instance_availability_zone: "${AVAILABILITY_ZONE}"
    tokens_file_path: /data/mimir/store-gateway/tokens

blocks_storage:
  bucket_store:
    sync_dir: /data/mimir/store-gateway
    sync_interval: 5m
    max_chunk_pool_bytes: 4294967296    # 4 GiB chunk pool
    index_cache:
      backend: memcached
      memcached:
        addresses: "dns+mimir-memcached.monitoring:11211"
        max_item_size: 10485760         # 10 MiB for large postings lists
    chunks_cache:
      backend: memcached
      memcached:
        addresses: "dns+mimir-memcached.monitoring:11211"
    metadata_cache:
      backend: memcached
      memcached:
        addresses: "dns+mimir-memcached.monitoring:11211"
```

Store gateway StatefulSet with persistent cache:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mimir-store-gateway
  namespace: monitoring
spec:
  replicas: 6    # 2 per AZ
  serviceName: mimir-store-gateway-headless
  selector:
    matchLabels:
      app.kubernetes.io/component: store-gateway
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: gp3
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 100Gi    # Index cache + block sync staging area
  template:
    spec:
      containers:
      - name: mimir
        image: grafana/mimir:2.14.0
        args:
        - -target=store-gateway
        - -config.file=/etc/mimir/config.yaml
        resources:
          requests:
            cpu: "4"
            memory: 16Gi
          limits:
            cpu: "8"
            memory: 32Gi
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 60
          periodSeconds: 10
```

### Cross-Tenant Query Federation

Mimir supports querying across multiple tenants using the `X-Scope-OrgID` header with a pipe-separated list:

```bash
# Query across multiple tenants
curl -H "X-Scope-OrgID: tenant-a|tenant-b|tenant-c" \
  "http://mimir-query-frontend:8080/prometheus/api/v1/query" \
  --data-urlencode 'query=sum(rate(http_requests_total[5m])) by (tenant)'

# Grafana datasource configuration for cross-tenant queries
# Add to datasource HTTP headers:
# X-Scope-OrgID: tenant-a|tenant-b
```

For permanent cross-tenant visibility, create a federated tenant using the `tenant-federation` feature:

```yaml
# Enable tenant federation in Mimir config
tenant_federation:
  enabled: true

# Query all tenants simultaneously (requires auth that maps to wildcard)
# X-Scope-OrgID: * (requires specific authorization configuration)
```

## Per-Tenant Overrides

### Override Architecture

Mimir applies limits at multiple levels: global defaults in the main config, per-tenant overrides loaded from a separate file, and runtime overrides applied without restart.

```yaml
# Main config: set defaults
limits:
  # Ingestion limits
  ingestion_rate: 50000           # Samples per second per tenant
  ingestion_burst_size: 1000000   # Burst allowance
  max_global_series_per_user: 1000000
  max_global_series_per_metric: 50000
  max_global_exemplars_per_user: 100000

  # Query limits
  max_fetched_chunks_per_query: 2000000
  max_fetched_series_per_query: 100000
  max_fetched_chunk_bytes_per_query: 1073741824    # 1 GiB
  max_query_parallelism: 64
  max_query_lookback: 8760h    # 1 year
  ruler_max_rules_per_rule_group: 100
  ruler_max_rule_groups_per_tenant: 100

  # Retention
  compactor_blocks_retention_period: 0    # 0 = use global retention
  s3_sse_type: ""

# Override configuration source
runtime_config:
  file: /etc/mimir/overrides.yaml
  period: 10s    # How often to reload the overrides file
```

### Override File Structure

```yaml
# /etc/mimir/overrides.yaml
# This file is hot-reloaded every `runtime_config.period` seconds

overrides:
  # High-volume production tenant
  "tenant-production":
    ingestion_rate: 500000
    ingestion_burst_size: 10000000
    max_global_series_per_user: 10000000
    max_global_exemplars_per_user: 1000000
    max_fetched_chunks_per_query: 10000000
    max_fetched_series_per_query: 1000000
    compactor_blocks_retention_period: 8760h    # 1 year
    query_shards: 64                            # More shards for large tenant

  # Audit/compliance tenant with long retention
  "tenant-audit":
    ingestion_rate: 10000
    max_global_series_per_user: 500000
    compactor_blocks_retention_period: 26280h   # 3 years
    max_query_lookback: 26280h

  # Dev/test tenant with short retention and strict limits
  "tenant-dev":
    ingestion_rate: 5000
    ingestion_burst_size: 50000
    max_global_series_per_user: 100000
    compactor_blocks_retention_period: 168h     # 7 days
    max_query_lookback: 168h
    ruler_max_rules_per_rule_group: 20

  # Tenant with custom S3 storage location
  "tenant-external-storage":
    s3_sse_type: SSE-KMS
    s3_sse_kms_key_id: <kms-key-id>
```

### Monitoring Per-Tenant Resource Usage

```yaml
# Recording rules for per-tenant resource tracking
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: mimir-tenant-usage
  namespace: monitoring
spec:
  groups:
  - name: mimir.tenant.usage
    interval: 1m
    rules:
    - record: mimir:tenant:ingestion_rate:rate5m
      expr: |
        sum by (user) (
          rate(cortex_distributor_received_samples_total[5m])
        )

    - record: mimir:tenant:active_series:max
      expr: |
        max by (user) (
          cortex_ingester_memory_series
        )

    - record: mimir:tenant:query_duration_p99:5m
      expr: |
        histogram_quantile(0.99,
          sum by (user, le) (
            rate(cortex_query_frontend_queue_duration_seconds_bucket[5m])
          )
        )

    - alert: MimirTenantIngestionRateLimitApproaching
      expr: |
        (
          mimir:tenant:ingestion_rate:rate5m
          /
          on(user) group_left()
          max by (user) (cortex_limits_ingestion_rate{limit_name="ingestion_rate"})
        ) > 0.8
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Tenant {{ $labels.user }} at {{ $value | humanizePercentage }} of ingestion rate limit"

    - alert: MimirTenantSeriesLimitApproaching
      expr: |
        (
          max by (user) (cortex_ingester_memory_series)
          /
          on(user) group_left()
          max by (user) (cortex_limits_max_global_series_per_user{limit_name="max_global_series_per_user"})
        ) > 0.8
      for: 30m
      labels:
        severity: warning
```

## Compactor Configuration

### Block Compaction Strategy

The compactor merges small TSDB blocks into larger ones to improve query efficiency:

```yaml
compactor:
  sharding_enabled: true
  sharding_ring:
    kvstore:
      store: memberlist
    wait_stability_min_duration: 1m
    wait_stability_max_duration: 5m

  data_dir: /data/mimir/compactor
  cleanup_interval: 15m
  block_sync_concurrency: 20
  meta_sync_concurrency: 20
  consistency_delay: 0
  deletion_delay: 12h

  block_ranges:
  - 2h
  - 12h
  - 24h
  - 72h      # 3-day blocks for long-term storage
  - 720h     # 30-day blocks for archival

  split_and_merge_stage_size: 4
  split_groups: 1
  max_closing_blocks_per_plan: 100
  max_opening_blocks_per_plan: 100

  # Per-tenant block limits
  # Applied via runtime overrides:
  # compactor_blocks_retention_period: Xh
  # compactor_split_and_merge_stage_size: N
```

Compactor Kubernetes deployment:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mimir-compactor
  namespace: monitoring
spec:
  replicas: 3    # Multiple compactors share work via ring
  serviceName: mimir-compactor
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: gp3
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 300Gi    # Staging area for block compaction
  template:
    spec:
      containers:
      - name: mimir
        image: grafana/mimir:2.14.0
        args:
        - -target=compactor
        - -config.file=/etc/mimir/config.yaml
        resources:
          requests:
            cpu: "4"
            memory: 8Gi
          limits:
            cpu: "8"
            memory: 16Gi
```

## Alertmanager Integration

### Mimir-Native Alertmanager

Mimir includes a multi-tenant Alertmanager that stores configuration per tenant in object storage:

```yaml
alertmanager:
  data_dir: /data/mimir/alertmanager
  enable_api: true
  external_url: "https://alertmanager.monitoring.example.com"
  sharding_enabled: true
  sharding_ring:
    replication_factor: 3
    kvstore:
      store: memberlist

alertmanager_storage:
  backend: s3
  s3:
    endpoint: s3.<aws-region>.amazonaws.com
    region: <aws-region>
    bucket_name: <mimir-ruler-bucket>
    access_key_id: <aws-access-key-id>
    secret_access_key: <aws-secret-access-key>
```

### Uploading Tenant Alertmanager Configurations

```bash
# Create alertmanager config for a tenant
cat <<'EOF' > /tmp/alertmanager.yaml
global:
  smtp_smarthost: 'smtp.example.com:587'
  smtp_from: 'alerts@example.com'
  smtp_auth_username: 'alerts@example.com'
  smtp_auth_password: '<smtp-password>'
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: default
  routes:
  - match:
      severity: critical
    receiver: pagerduty-critical
    continue: true
  - match:
      severity: warning
    receiver: slack-warnings

receivers:
- name: default
  email_configs:
  - to: 'on-call@example.com'

- name: pagerduty-critical
  pagerduty_configs:
  - routing_key: '<pagerduty-integration-key>'

- name: slack-warnings
  slack_configs:
  - api_url: '<slack-webhook-url>'
    channel: '#alerts-warnings'

inhibit_rules:
- source_match:
    severity: critical
  target_match:
    severity: warning
  equal: ['alertname', 'namespace']
EOF

# Upload via Mimir Alertmanager API
curl -X POST \
  -H "X-Scope-OrgID: tenant-production" \
  -H "Content-Type: application/yaml" \
  --data-binary @/tmp/alertmanager.yaml \
  "http://mimir-alertmanager:8080/api/v1/alerts"

# Verify upload
curl -H "X-Scope-OrgID: tenant-production" \
  "http://mimir-alertmanager:8080/api/v1/alerts" | python3 -m json.tool
```

### Ruler Configuration for Recording Rules and Alerts

```yaml
ruler:
  enable_api: true
  rule_path: /data/mimir/ruler
  alertmanager_url: "http://mimir-alertmanager.monitoring:8080/alertmanager"
  ring:
    kvstore:
      store: memberlist
  evaluation_interval: 1m
  poll_interval: 2m
  concurrent_evaluations: 16
  evaluation_delay_duration: 1m

ruler_storage:
  backend: s3
  s3:
    endpoint: s3.<aws-region>.amazonaws.com
    region: <aws-region>
    bucket_name: <mimir-ruler-bucket>
    access_key_id: <aws-access-key-id>
    secret_access_key: <aws-secret-access-key>
```

Uploading recording rules for a tenant:

```bash
# Create a rule group
cat <<'EOF' > /tmp/rules.yaml
name: "sre-recording-rules"
interval: 1m
rules:
- record: job:http_requests:rate5m
  expr: sum(rate(http_requests_total[5m])) by (job)

- record: job:http_request_errors:ratio_rate5m
  expr: |
    sum(rate(http_requests_total{status=~"5.."}[5m])) by (job)
    /
    sum(rate(http_requests_total[5m])) by (job)

- alert: HighErrorRate
  expr: job:http_request_errors:ratio_rate5m > 0.01
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High error rate for {{ $labels.job }}"
    description: "{{ $value | humanizePercentage }} error rate over 5m"

- alert: HighErrorRateCritical
  expr: job:http_request_errors:ratio_rate5m > 0.05
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Critical error rate for {{ $labels.job }}"
EOF

# Upload via Mimir Ruler API
curl -X POST \
  -H "X-Scope-OrgID: tenant-production" \
  -H "Content-Type: application/yaml" \
  --data-binary @/tmp/rules.yaml \
  "http://mimir-ruler:8080/prometheus/config/v1/rules/sre-recording-rules"

# List rules for a tenant
curl -H "X-Scope-OrgID: tenant-production" \
  "http://mimir-ruler:8080/prometheus/config/v1/rules" | jq .
```

## Full Helm Values for Production

```yaml
# mimir-distributed/values-production.yaml
global:
  extraEnvFrom:
  - secretRef:
      name: mimir-s3-credentials

mimir:
  structuredConfig:
    common:
      storage:
        backend: s3
        s3:
          endpoint: s3.<aws-region>.amazonaws.com
          region: <aws-region>
          access_key_id: "${S3_ACCESS_KEY_ID}"
          secret_access_key: "${S3_SECRET_ACCESS_KEY}"

    blocks_storage:
      s3:
        bucket_name: <mimir-blocks-bucket>
      tsdb:
        head_compaction_interval: 1m
        wal_compression_enabled: true

    alertmanager_storage:
      s3:
        bucket_name: <mimir-alertmanager-bucket>

    ruler_storage:
      s3:
        bucket_name: <mimir-ruler-bucket>

    ingester:
      ring:
        replication_factor: 3
        zone_awareness_enabled: true

    limits:
      ingestion_rate: 100000
      max_global_series_per_user: 2000000
      compactor_blocks_retention_period: 8760h

    tenant_federation:
      enabled: true

    query_range:
      results_cache:
        backend: memcached
        memcached:
          addresses: "dns+mimir-memcached.monitoring:11211"

distributor:
  replicas: 3
  resources:
    requests:
      cpu: "2"
      memory: 2Gi
    limits:
      cpu: "4"
      memory: 4Gi

ingester:
  replicas: 9
  zoneAwareReplication:
    enabled: true
  resources:
    requests:
      cpu: "4"
      memory: 16Gi
    limits:
      cpu: "8"
      memory: 32Gi
  persistentVolume:
    enabled: true
    size: 100Gi
    storageClass: gp3

storeGateway:
  replicas: 6
  zoneAwareReplication:
    enabled: true
  resources:
    requests:
      cpu: "4"
      memory: 16Gi
    limits:
      cpu: "8"
      memory: 32Gi
  persistentVolume:
    enabled: true
    size: 100Gi
    storageClass: gp3

compactor:
  replicas: 3
  resources:
    requests:
      cpu: "4"
      memory: 8Gi
    limits:
      cpu: "8"
      memory: 16Gi
  persistentVolume:
    enabled: true
    size: 300Gi
    storageClass: gp3

queryFrontend:
  replicas: 2
  resources:
    requests:
      cpu: "2"
      memory: 4Gi

queryScheduler:
  enabled: true
  replicas: 2

querier:
  replicas: 6
  resources:
    requests:
      cpu: "4"
      memory: 8Gi

ruler:
  enabled: true
  replicas: 2

alertmanager:
  enabled: true
  replicas: 3
  zoneAwareReplication:
    enabled: true

memcached:
  enabled: true
  replicaCount: 3
  resources:
    requests:
      cpu: "2"
      memory: 4Gi
    limits:
      cpu: "4"
      memory: 8Gi
  extraArgs:
  - -m 4096       # 4 GiB memory
  - -I 10m        # Max item size 10 MiB
  - -c 1024       # Max simultaneous connections

nginx:
  enabled: true
  replicas: 2
```

## Operational Runbook

### Checking Write Path Health

```bash
# Distributor push success rate
kubectl exec -n monitoring deploy/mimir-distributor -- \
  curl -s localhost:8080/metrics | \
  grep "cortex_distributor_received_samples_total"

# Ingester ring status
curl -s http://mimir-ingester:8080/ring | jq '.shards[] | {id, state, zone}'

# Check ingester WAL lag
kubectl exec -n monitoring mimir-ingester-0 -- \
  curl -s localhost:8080/metrics | grep "cortex_ingester_wal"

# Check series count per tenant
curl -H "X-Scope-OrgID: tenant-production" \
  "http://mimir-query-frontend:8080/prometheus/api/v1/query" \
  --data-urlencode 'query=sum(cortex_ingester_memory_series{user="tenant-production"})'
```

### Recovering from Ingester Crash

```bash
# Check WAL state
kubectl exec -n monitoring mimir-ingester-0 -- ls -la /data/mimir/ingester/wal/

# Force WAL checkpoint before restart
kubectl exec -n monitoring mimir-ingester-0 -- \
  curl -X POST localhost:8080/ingester/flush

# If WAL is corrupted, delete and allow reconstruction from replicas
kubectl exec -n monitoring mimir-ingester-0 -- rm -rf /data/mimir/ingester/wal/
kubectl delete pod -n monitoring mimir-ingester-0
```

### Scaling Ingesters Safely

```bash
# Scale up (add zone before scaling for zone-aware deployments)
kubectl scale statefulset -n monitoring mimir-ingester --replicas=12

# Wait for new ingesters to join the ring
watch kubectl exec -n monitoring mimir-ingester-0 -- \
  curl -s localhost:8080/ring | jq '.shards | length'

# Scale down (must let ingesters leave ring gracefully)
kubectl exec -n monitoring mimir-ingester-8 -- \
  curl -X POST localhost:8080/ingester/shutdown

# Wait until ingester transitions to LEAVING then REMOVED in ring
# Then scale the StatefulSet
kubectl scale statefulset -n monitoring mimir-ingester --replicas=9
```

## Summary

Grafana Mimir's strength lies in its opinionated separation of concerns: the distributor handles write fan-out without state, ingesters maintain the hot write path with WAL durability, compactors handle the cold path, and store gateways serve queries from object storage. Key production practices include:

- Enable zone awareness with exactly RF replicas per zone to survive AZ outages without query degradation
- Use the runtime config file for per-tenant overrides and reload it without restart using the 10-second polling interval
- Size the store-gateway memory based on 1% of total series count times average posting list size
- Use the Mimir-native Alertmanager for multi-tenant alert management rather than a shared external instance
- Monitor `cortex_distributor_received_samples_total` and per-tenant series counts for capacity planning
- Use `split_and_merge` compaction for tenants with over 100M series to prevent single-compactor bottlenecks
