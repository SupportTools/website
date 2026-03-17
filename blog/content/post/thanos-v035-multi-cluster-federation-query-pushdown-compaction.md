---
title: "Thanos v0.35+ Multi-Cluster Federation: Query Pushdown, Compaction Strategies, and Retention Policies"
date: 2032-02-23T00:00:00-05:00
draft: false
tags: ["Thanos", "Prometheus", "Kubernetes", "Observability", "Multi-Cluster", "Monitoring"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to deploying Thanos v0.35+ for multi-cluster Prometheus federation, covering query pushdown optimization, block compaction strategies, and long-term retention policies."
more_link: "yes"
url: "/thanos-v035-multi-cluster-federation-query-pushdown-compaction/"
---

Thanos has become the standard solution for scaling Prometheus beyond a single cluster. Version 0.35 introduced significant improvements to query pushdown, making cross-cluster queries dramatically faster by reducing the volume of data transferred between components. This guide covers the full operational picture: federating metrics from dozens of clusters, tuning the compaction pipeline for cost-efficient long-term storage, and enforcing retention policies that satisfy both engineering and compliance requirements.

<!--more-->

# Thanos v0.35+ Multi-Cluster Federation

## Architecture Overview

A production Thanos deployment spans multiple layers. Each Kubernetes cluster runs a Thanos Sidecar alongside Prometheus, uploading blocks to object storage. A central Thanos Querier fetches from all sidecars and Stores, while a Compactor handles deduplication and downsampling. Understanding the data flow is essential before tuning any component.

```
┌──────────────────────────────────────────────────────┐
│  Cluster A                  Cluster B                │
│  Prometheus ──► Sidecar     Prometheus ──► Sidecar   │
│                    │                          │       │
└────────────────────┼──────────────────────────┼───────┘
                     │                          │
                     ▼                          ▼
              ┌─────────────────────────────────────┐
              │       Object Store (S3/GCS/Azure)   │
              └────────────────┬────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │   Thanos Store GW   │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │   Thanos Querier    │◄── Grafana / Recording Rules
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │  Thanos Compactor   │
                    └─────────────────────┘
```

## Section 1: Deploying Thanos Sidecar with Prometheus

### Prometheus StatefulSet with Sidecar

The sidecar must share a volume with Prometheus to read TSDB blocks directly. The following StatefulSet is production-hardened for Kubernetes 1.29+.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: prometheus
  namespace: monitoring
  labels:
    app.kubernetes.io/name: prometheus
    app.kubernetes.io/component: server
spec:
  serviceName: prometheus-headless
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: prometheus
  podManagementPolicy: Parallel
  updateStrategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
        app.kubernetes.io/name: prometheus
        app.kubernetes.io/component: server
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      serviceAccountName: prometheus
      securityContext:
        fsGroup: 65534
        runAsNonRoot: true
        runAsUser: 65534
      terminationGracePeriodSeconds: 600
      containers:
        - name: prometheus
          image: quay.io/prometheus/prometheus:v2.51.0
          args:
            - --config.file=/etc/prometheus/prometheus.yaml
            - --storage.tsdb.path=/prometheus/data
            - --storage.tsdb.retention.time=6h
            - --storage.tsdb.min-block-duration=2h
            - --storage.tsdb.max-block-duration=2h
            - --web.enable-lifecycle
            - --web.enable-remote-write-receiver
            - --log.level=info
          ports:
            - name: web
              containerPort: 9090
          resources:
            requests:
              cpu: 500m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 8Gi
          volumeMounts:
            - name: prometheus-config
              mountPath: /etc/prometheus
            - name: prometheus-data
              mountPath: /prometheus/data
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: web
            initialDelaySeconds: 30
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /-/ready
              port: web
            initialDelaySeconds: 5
            periodSeconds: 5

        - name: thanos-sidecar
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - sidecar
            - --log.level=info
            - --tsdb.path=/prometheus/data
            - --prometheus.url=http://localhost:9090
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --objstore.config-file=/etc/thanos/objstore.yaml
            - --shipper.upload-compacted
            - --reloader.config-file=/etc/prometheus/prometheus.yaml
            - --reloader.config-envsubst-file=/etc/prometheus/prometheus.yaml
          ports:
            - name: grpc
              containerPort: 10901
            - name: http
              containerPort: 10902
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 1Gi
          volumeMounts:
            - name: prometheus-data
              mountPath: /prometheus/data
            - name: thanos-objstore-secret
              mountPath: /etc/thanos
              readOnly: true
            - name: prometheus-config
              mountPath: /etc/prometheus
          readinessProbe:
            httpGet:
              path: /-/ready
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5

      volumes:
        - name: prometheus-config
          configMap:
            name: prometheus-config
        - name: thanos-objstore-secret
          secret:
            secretName: thanos-objstore

  volumeClaimTemplates:
    - metadata:
        name: prometheus-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
```

### Object Store Configuration

Thanos supports S3, GCS, Azure Blob, and OpenStack Swift. The following covers S3-compatible stores with SSE-KMS encryption.

```yaml
# objstore.yaml - mounted as a Secret
type: S3
config:
  bucket: thanos-metrics-prod
  endpoint: s3.us-east-1.amazonaws.com
  region: us-east-1
  aws_sdk_auth: true          # use IRSA / instance profile
  insecure: false
  signature_version2: false
  encrypt_sse: true
  sse_config:
    type: SSEKMS
    kms_key_id: arn:aws:kms:us-east-1:<account-id>:key/<key-id>
    kms_encryption_context:
      Environment: production
      Service: thanos
  http_config:
    idle_conn_timeout: 90s
    response_header_timeout: 2m
    insecure_skip_verify: false
  trace:
    enable: false
  part_size: 134217728          # 128 MiB multipart threshold
  put_user_metadata:
    X-Thanos-Cluster: prod-us-east-1
```

For GCS with Workload Identity:

```yaml
type: GCS
config:
  bucket: thanos-metrics-prod
  service_account: ""    # empty = use Workload Identity
  use_grpc: true         # faster for large uploads
  grpc_conn_pool_size: 2
  http_config:
    idle_conn_timeout: 90s
```

## Section 2: Query Pushdown in Thanos v0.35+

Query pushdown is the most impactful performance feature introduced in recent Thanos versions. Without pushdown, Thanos Querier downloads raw samples from every Store and evaluates the PromQL expression locally. With pushdown enabled, filtering predicates are pushed to the Store nodes, which evaluate partial aggregations before returning results.

### Enabling Pushdown on the Querier

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-querier
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: thanos-querier
  template:
    metadata:
      labels:
        app.kubernetes.io/name: thanos-querier
    spec:
      containers:
        - name: thanos-querier
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - query
            - --log.level=info
            - --log.format=json
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            # Query pushdown flags (v0.35+)
            - --query.promql-engine=thanos
            - --enable-feature=query-pushdown
            - --query.partial-response
            - --query.replica-label=prometheus_replica
            - --query.replica-label=rule_replica
            # Auto-discover sidecars via DNS
            - --endpoint=dnssrv+_grpc._tcp.thanos-sidecar-headless.monitoring.svc.cluster.local
            # Auto-discover store gateways
            - --endpoint=dnssrv+_grpc._tcp.thanos-store-gateway.monitoring.svc.cluster.local
            # Query timeout and concurrency
            - --query.timeout=10m
            - --query.max-concurrent=30
            - --query.max-concurrent-select=20
            # Telemetry
            - --web.prefix-header=X-Forwarded-Prefix
          ports:
            - name: grpc
              containerPort: 10901
            - name: http
              containerPort: 10902
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 4000m
              memory: 16Gi
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: http
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /-/ready
              port: http
            initialDelaySeconds: 10
            periodSeconds: 5
```

### Pushdown-Compatible PromQL Patterns

Not all PromQL expressions benefit equally from pushdown. The following patterns are most effective:

```promql
# Pattern 1: Label matchers pushed to Store nodes
# Without pushdown: fetches all series, filters locally
# With pushdown: Store nodes filter by label before returning data
sum by (namespace, pod) (
  rate(container_cpu_usage_seconds_total{
    cluster="prod-us-east-1",
    namespace=~"app-.*"
  }[5m])
)

# Pattern 2: Aggregation pushdown for sum/count/min/max
# The Store Gateway evaluates partial sums per shard
sum(
  rate(http_requests_total{job="api-server", code=~"5.."}[5m])
) by (cluster, namespace)

# Pattern 3: Range query optimization
# Downsampling at the Store level reduces transferred samples
avg_over_time(node_memory_MemAvailable_bytes{
  cluster="prod-eu-west-1"
}[1h:5m])
```

### Measuring Pushdown Effectiveness

Query spans are exposed via the built-in query UI and OpenTelemetry traces. Key metrics to monitor:

```promql
# Ratio of series fetched vs series needed (lower = better pushdown)
sum(thanos_query_range_requested_series_total) /
sum(thanos_query_range_fetched_series_total)

# Time spent in store node evaluation vs querier evaluation
histogram_quantile(0.99,
  sum by (le, component) (
    rate(thanos_store_series_query_duration_seconds_bucket[5m])
  )
)

# Data transferred from store gateways
rate(thanos_store_series_data_fetched_bytes_total[5m])
```

## Section 3: Thanos Store Gateway Tuning

The Store Gateway is the critical path for historical queries. Proper sharding and caching configuration dramatically reduces query latency.

### Store Gateway with Index Cache

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-store-gateway
  namespace: monitoring
spec:
  serviceName: thanos-store-gateway
  replicas: 4
  selector:
    matchLabels:
      app.kubernetes.io/name: thanos-store-gateway
  template:
    metadata:
      labels:
        app.kubernetes.io/name: thanos-store-gateway
    spec:
      containers:
        - name: thanos-store-gateway
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - store
            - --log.level=info
            - --log.format=json
            - --data-dir=/var/thanos/store
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --objstore.config-file=/etc/thanos/objstore.yaml
            # Index cache with in-memory backend
            - --index-cache.config-file=/etc/thanos/index-cache.yaml
            # Chunk pool size (tune based on available memory)
            - --store.grpc.series-max-concurrency=30
            - --store.grpc.series-sample-limit=50000000
            - --store.grpc.touched-series-limit=200000
            # Sharding for horizontal scaling
            - --selector.relabel-config-file=/etc/thanos/relabel.yaml
            # Sync interval for new blocks
            - --sync-block-duration=3m
            # Post-filtering for faster scans
            - --block-meta-fetch-concurrency=32
          ports:
            - name: grpc
              containerPort: 10901
            - name: http
              containerPort: 10902
          resources:
            requests:
              cpu: 1000m
              memory: 8Gi
            limits:
              cpu: 4000m
              memory: 32Gi
          volumeMounts:
            - name: store-data
              mountPath: /var/thanos/store
            - name: thanos-config
              mountPath: /etc/thanos
              readOnly: true

  volumeClaimTemplates:
    - metadata:
        name: store-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 200Gi
```

### Index Cache Configuration

```yaml
# index-cache.yaml
type: IN-MEMORY
config:
  max_size: 4GB
  max_item_size: 128MiB
```

For production with Redis:

```yaml
type: REDIS
config:
  addr: redis-cluster.monitoring.svc.cluster.local:6379
  username: thanos-store
  password: ""               # use Kubernetes secret injection
  db: 0
  dial_timeout: 5s
  read_timeout: 3s
  write_timeout: 3s
  pool_size: 100
  min_idle_conns: 10
  idle_timeout: 5m
  max_get_multi_concurrency: 100
  get_multi_batch_size: 1000
  max_set_multi_concurrency: 100
  set_multi_batch_size: 1000
  tls_enabled: true
  tls_config:
    insecure_skip_verify: false
    server_name: redis-cluster.monitoring.svc.cluster.local
```

### Store Sharding via Relabeling

When you have many blocks across clusters, shard the Store Gateway horizontally by cluster label:

```yaml
# relabel.yaml for store gateway shard 0 of 4
- source_labels: [__block_id]
  target_label: __tmp_hash
  regex: (.*)
  replacement: "${1}"
  action: hashmod
  modulus: 4
- source_labels: [__tmp_hash]
  regex: "0"
  action: keep
```

Repeat for each shard with modulus values 1, 2, 3.

## Section 4: Compaction Strategies

Thanos Compactor is a singleton (do not run multiple instances against the same bucket). It performs three functions: deduplication across Prometheus replicas, downsampling for long-range queries, and retention enforcement.

### Compactor Deployment

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-compactor
  namespace: monitoring
spec:
  serviceName: thanos-compactor
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: thanos-compactor
  template:
    metadata:
      labels:
        app.kubernetes.io/name: thanos-compactor
    spec:
      containers:
        - name: thanos-compactor
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - compact
            - --log.level=info
            - --log.format=json
            - --data-dir=/var/thanos/compact
            - --http-address=0.0.0.0:10902
            - --objstore.config-file=/etc/thanos/objstore.yaml
            # Wait for all components before compacting
            - --wait
            - --wait-interval=5m
            # Deduplication
            - --deduplication.replica-label=prometheus_replica
            - --deduplication.func=penalty
            # Downsampling
            - --downsampling.disable=false
            # Retention (raw, 5m downsampled, 1h downsampled)
            - --retention.resolution-raw=30d
            - --retention.resolution-5m=90d
            - --retention.resolution-1h=365d
            # Compaction concurrency
            - --compact.concurrency=4
            - --compact.block-fetch-concurrency=4
            # Block cleanup delay (safety buffer before deletion)
            - --delete-delay=48h
            # Enable vertical compaction for overlapping blocks
            - --enable-vertical-compaction
            # Limits
            - --selector.relabel-config-file=/etc/thanos/compactor-relabel.yaml
          ports:
            - name: http
              containerPort: 10902
          resources:
            requests:
              cpu: 1000m
              memory: 4Gi
            limits:
              cpu: 8000m
              memory: 32Gi
          volumeMounts:
            - name: compactor-data
              mountPath: /var/thanos/compact
            - name: thanos-config
              mountPath: /etc/thanos
              readOnly: true

  volumeClaimTemplates:
    - metadata:
        name: compactor-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: standard    # compactor data is ephemeral
        resources:
          requests:
            storage: 500Gi
```

### Understanding Compaction Levels

Thanos uses level-based compaction similar to LevelDB. Understanding block progression helps diagnose issues.

```
Level 1: Raw 2h blocks uploaded by sidecar
Level 2: 8h compacted blocks (4 x 2h)
Level 3: 2d compacted blocks (6 x 8h)
Level 4: 2w compacted blocks (7 x 2d)
Level 5+: Continues halving the number of blocks
```

Monitor compaction health:

```promql
# Blocks awaiting compaction
thanos_compact_group_compactions_total

# Failed compactions (alert if > 0)
rate(thanos_compact_group_compaction_failures_total[1h])

# Time to compact a group
histogram_quantile(0.99,
  rate(thanos_compact_group_compaction_duration_seconds_bucket[1h])
)

# Block download/upload bandwidth
rate(thanos_objstore_bucket_operations_bytes_total{operation="upload"}[5m])
rate(thanos_objstore_bucket_operations_bytes_total{operation="get"}[5m])

# Blocks in bucket per resolution
thanos_blocks_meta_synced{state="loaded"}
```

### Deduplication Strategy

When running Prometheus in HA pairs, both replicas upload identical blocks differentiated only by the `prometheus_replica` label. The Compactor merges these using the penalty-based deduplication function introduced in v0.30.

The `penalty` function is preferred over the older `chain` function because it handles staleness markers correctly and produces more accurate results when replicas have network partitions.

```bash
# Verify deduplication is working
thanos tools bucket inspect \
  --objstore.config-file=/etc/thanos/objstore.yaml \
  | grep -E "(dedup|replica)"

# Check for duplicate series in a time range
thanos tools bucket verify \
  --objstore.config-file=/etc/thanos/objstore.yaml \
  --repair=false \
  --issues=overlappedBlocks
```

## Section 5: Retention Policies

### Multi-Tier Retention

Production environments typically need different retention for different data categories. Thanos supports per-tenant retention via external labels filtering.

```yaml
# Compactor relabeling to isolate by cluster for separate retention
# compactor-relabel.yaml
- source_labels: [cluster]
  regex: "prod-.*"
  action: keep
```

Deploy separate Compactor instances for different retention tiers:

```bash
# Production clusters: 90d raw, 1y downsampled
--retention.resolution-raw=90d
--retention.resolution-5m=365d
--retention.resolution-1h=730d

# Development clusters: 7d raw, 30d downsampled
--retention.resolution-raw=7d
--retention.resolution-5m=30d
--retention.resolution-1h=90d
```

### Compliance Retention with Block Locking

For regulatory environments, use block metadata to lock blocks from deletion:

```bash
# Add "do not delete" metadata to a block
thanos tools bucket rewrite \
  --id=<ULID> \
  --objstore.config-file=/etc/thanos/objstore.yaml \
  --mark-for-no-compact

# List all locked blocks
thanos tools bucket ls \
  --objstore.config-file=/etc/thanos/objstore.yaml \
  --output=json \
  | jq '.[] | select(.Thanos.Downsample.Resolution == 0 and .Thanos.Extensions != null)'
```

### Lifecycle Policy Alignment with Object Store

Align Thanos retention with S3 lifecycle policies to avoid orphaned objects:

```json
{
  "Rules": [
    {
      "ID": "thanos-raw-retention",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "thanos/"
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
        "Days": 395
      }
    }
  ]
}
```

Set lifecycle policy:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket thanos-metrics-prod \
  --lifecycle-configuration file://lifecycle.json
```

## Section 6: Multi-Cluster Query Federation

### Hierarchical Querier Setup

For very large deployments (50+ clusters), use a hierarchical query topology with regional Queriers feeding into a global Querier.

```yaml
# Regional Querier (us-east-1) - queries local cluster sidecars
- --endpoint=dnssrv+_grpc._tcp.thanos-sidecar.monitoring-us-east-1.svc.cluster.local

# Global Querier - queries regional queriers and central store
- --endpoint=dnssrv+_grpc._tcp.regional-querier-us-east-1.thanos.svc.cluster.local
- --endpoint=dnssrv+_grpc._tcp.regional-querier-eu-west-1.thanos.svc.cluster.local
- --endpoint=dnssrv+_grpc._tcp.thanos-store-gateway.monitoring.svc.cluster.local
```

### Ruler for Cross-Cluster Recording Rules

Thanos Ruler evaluates recording rules and alert rules against the global query layer, enabling cross-cluster aggregation rules:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  serviceName: thanos-ruler
  replicas: 2
  template:
    spec:
      containers:
        - name: thanos-ruler
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - rule
            - --log.level=info
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --objstore.config-file=/etc/thanos/objstore.yaml
            - --data-dir=/var/thanos/ruler
            - --label=rule_replica="$(POD_NAME)"
            - --label=environment="production"
            - --query=dnssrv+_grpc._tcp.thanos-querier.monitoring.svc.cluster.local
            - --alertmanagers.url=http://alertmanager.monitoring.svc.cluster.local:9093
            - --rule-file=/etc/thanos/rules/*.yaml
            - --resend-delay=1m
            - --eval-interval=1m
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
```

### Cross-Cluster Recording Rules

```yaml
# rules/global-aggregations.yaml
groups:
  - name: global-cluster-metrics
    interval: 1m
    rules:
      - record: global:container_cpu_usage_seconds_total:rate5m
        expr: |
          sum by (cluster, namespace, pod, container) (
            rate(container_cpu_usage_seconds_total{
              container!="",
              image!=""
            }[5m])
          )

      - record: global:node_memory_used_bytes
        expr: |
          sum by (cluster, node) (
            node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes
          )

      - record: global:http_request_rate5m
        expr: |
          sum by (cluster, namespace, service, code) (
            rate(http_requests_total[5m])
          )

  - name: global-alerts
    rules:
      - alert: CrossClusterHighErrorRate
        expr: |
          sum by (cluster, namespace) (
            rate(http_requests_total{code=~"5.."}[5m])
          )
          /
          sum by (cluster, namespace) (
            rate(http_requests_total[5m])
          ) > 0.05
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "High error rate in {{ $labels.cluster }}/{{ $labels.namespace }}"
          description: "Error rate is {{ $value | humanizePercentage }}"
```

## Section 7: Operational Runbook

### Health Check Script

```bash
#!/bin/bash
# thanos-health-check.sh

set -euo pipefail

QUERIER_URL="${THANOS_QUERIER_URL:-http://thanos-querier.monitoring.svc.cluster.local:10902}"
STORE_URL="${THANOS_STORE_URL:-http://thanos-store-gateway.monitoring.svc.cluster.local:10902}"
COMPACTOR_URL="${THANOS_COMPACTOR_URL:-http://thanos-compactor.monitoring.svc.cluster.local:10902}"

check_component() {
  local name="$1"
  local url="$2"
  local response

  response=$(curl -sf --max-time 5 "${url}/-/ready" 2>&1) || {
    echo "CRITICAL: ${name} not ready - ${response}"
    return 1
  }
  echo "OK: ${name} is healthy"
}

check_query() {
  local query="$1"
  local description="$2"
  local result

  result=$(curl -sf --max-time 30 \
    "${QUERIER_URL}/api/v1/query?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${query}'))")" \
    | jq -r '.status')

  if [[ "${result}" == "success" ]]; then
    echo "OK: Query '${description}' succeeded"
  else
    echo "WARNING: Query '${description}' returned status '${result}'"
  fi
}

echo "=== Thanos Health Check ==="
check_component "Querier" "${QUERIER_URL}"
check_component "Store Gateway" "${STORE_URL}"
check_component "Compactor" "${COMPACTOR_URL}"

echo ""
echo "=== Query Health ==="
check_query "up" "basic scrape health"
check_query 'count(thanos_blocks_meta_synced{state="loaded"})' "block sync"
check_query 'time() - max(thanos_objstore_last_successful_upload_time)' "upload freshness"

echo ""
echo "=== Block Statistics ==="
curl -sf "${COMPACTOR_URL}/api/v1/blocks?includeChunks=false" \
  | jq '
    .data |
    group_by(.thanos.resolution) |
    map({
      resolution: .[0].thanos.resolution,
      count: length,
      total_size_gb: ([.[].compaction.level] | add) / 1
    })
  '
```

### Bucket Inspection and Repair

```bash
# List all blocks with metadata
thanos tools bucket inspect \
  --objstore.config-file=objstore.yaml \
  --output=table \
  | sort -k3 -r

# Find blocks that failed to compact
thanos tools bucket inspect \
  --objstore.config-file=objstore.yaml \
  --output=json \
  | jq '.[] | select(.Thanos.Downsample.Resolution == 0) | select(.Compaction.Level < 2) | select((.MinTime | tonumber) < ((now - 86400 * 3) * 1000)) | {ULID, MinTime, MaxTime, Compaction}'

# Rewrite a problematic block (removes out-of-order samples)
thanos tools bucket rewrite \
  --objstore.config-file=objstore.yaml \
  --id=<ULID> \
  --prom-blocks \
  --tmp-dir=/tmp/thanos-rewrite

# Verify block integrity
thanos tools bucket verify \
  --objstore.config-file=objstore.yaml \
  --repair=true \
  --issues=overlappedBlocks,outOfOrderChunks
```

### Alerting Rules for Thanos Operations

```yaml
groups:
  - name: thanos-operations
    rules:
      - alert: ThanosCompactorNotRunning
        expr: absent(thanos_compact_iterations_total)
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Thanos Compactor is not running"

      - alert: ThanosCompactorHalted
        expr: thanos_compact_halted == 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Thanos Compactor has halted due to an error"

      - alert: ThanosStoreGatewayNoBlocksLoaded
        expr: thanos_blocks_meta_synced{state="loaded"} == 0
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Thanos Store Gateway has no blocks loaded in {{ $labels.cluster }}"

      - alert: ThanosQueryHighLatency
        expr: |
          histogram_quantile(0.99,
            sum by (le) (
              rate(http_request_duration_seconds_bucket{
                handler="query_range"
              }[5m])
            )
          ) > 30
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Thanos Query p99 latency exceeds 30s"

      - alert: ThanosObjectStorageOperationFailures
        expr: |
          rate(thanos_objstore_bucket_operation_failures_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Object store operations are failing"

      - alert: ThanosBlockUploadDelay
        expr: |
          time() - max by (cluster) (thanos_objstore_last_successful_upload_time) > 7200
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Block upload delayed >2h for cluster {{ $labels.cluster }}"
```

## Section 8: Performance Benchmarking

### Load Testing Query Performance

```bash
#!/bin/bash
# benchmark-queries.sh

QUERIER="${THANOS_QUERIER_URL:-http://localhost:10902}"
START="$(date -d '24 hours ago' -u +%Y-%m-%dT%H:%M:%SZ)"
END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STEP="60"

run_query() {
  local name="$1"
  local query="$2"
  local start_time end_time duration

  start_time=$(date +%s%N)
  curl -sf \
    --max-time 120 \
    "${QUERIER}/api/v1/query_range" \
    --data-urlencode "query=${query}" \
    --data-urlencode "start=${START}" \
    --data-urlencode "end=${END}" \
    --data-urlencode "step=${STEP}" \
    -o /dev/null
  end_time=$(date +%s%N)
  duration=$(( (end_time - start_time) / 1000000 ))
  echo "${name}: ${duration}ms"
}

echo "Query Benchmark Results:"
echo "========================"
run_query "CPU rate (single cluster)" \
  'rate(container_cpu_usage_seconds_total{cluster="prod-us-east-1"}[5m])'

run_query "CPU rate (all clusters)" \
  'sum by (cluster) (rate(container_cpu_usage_seconds_total[5m]))'

run_query "Memory usage (cross-cluster)" \
  'sum by (cluster, namespace) (container_memory_working_set_bytes{container!=""})'

run_query "HTTP error rate (aggregated)" \
  'sum by (cluster) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (cluster) (rate(http_requests_total[5m]))'
```

## Conclusion

Thanos v0.35+ provides a mature, scalable foundation for multi-cluster Prometheus federation. The key operational points are: configure query pushdown on the Querier for large-scale queries, shard Store Gateways horizontally once block counts exceed 10,000, run a single Compactor per object store bucket with vertical compaction enabled, and align retention policies between Thanos flags and object store lifecycle rules. Monitoring the Compactor's health and block upload freshness prevents data gaps that are difficult to retroactively fill.
