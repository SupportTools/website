---
title: "Thanos Long-Term Metrics: Object Storage, Compaction, Downsampling, and Multi-Cluster Federation"
date: 2031-07-28T00:00:00-05:00
draft: false
tags: ["Thanos", "Prometheus", "Kubernetes", "Observability", "Object Storage", "Metrics", "Federation"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying Thanos for long-term Prometheus metrics storage, covering object storage backends, compaction strategies, downsampling, and federated multi-cluster monitoring."
more_link: "yes"
url: "/thanos-long-term-metrics-object-storage-compaction-multi-cluster-federation/"
---

Running Prometheus in production solves the immediate observability problem, but the default 15-day retention window creates a hard boundary on historical analysis. When you need to answer questions about seasonal traffic patterns, year-over-year capacity trends, or post-incident timelines that span weeks, you need a long-term storage solution that integrates cleanly with your existing Prometheus infrastructure. Thanos fills that gap by extending Prometheus with cheap, durable object storage while preserving the PromQL query interface your team already knows.

This guide covers the full operational picture: deploying the Thanos sidecar and store gateway, configuring S3-compatible object storage, understanding the compactor's block lifecycle, implementing downsampling for efficient long-range queries, and federating metrics across multiple Kubernetes clusters into a single query surface.

<!--more-->

# Thanos Long-Term Metrics: Object Storage, Compaction, Downsampling, and Multi-Cluster Federation

## Architecture Overview

Thanos extends Prometheus through a set of loosely coupled components. Understanding how data flows through the system is essential before deploying anything in production.

The core data path works as follows. Each Prometheus instance gets a Thanos sidecar deployed alongside it. The sidecar uploads completed TSDB blocks (2-hour chunks by default) to object storage as they are created. The sidecar also exposes a gRPC Store API endpoint that allows Thanos Query to reach through and pull recent data that has not yet been uploaded. A Store Gateway component reads blocks directly from object storage and exposes the same Store API for historical data. The Query component fans out requests across all Store API endpoints and deduplicates the results using Prometheus replica labels.

The Compactor runs as a singleton (never as multiple replicas) and is responsible for merging small blocks into larger ones, applying retention policies, and computing downsampled versions of blocks for efficient long-range queries.

```
┌─────────────────────────────────────────────────────┐
│  Cluster A                 │  Cluster B              │
│                            │                         │
│  Prometheus ──► Sidecar    │  Prometheus ──► Sidecar │
│       │              │     │       │              │  │
│       │        gRPC Store  │       │        gRPC Store
└───────┼──────────────┼─────┴───────┼──────────────┼──┘
        │              │             │              │
        │         Object Storage (S3/GCS/Azure)     │
        │              │             │              │
        └──────────────┤  Store GW   ├──────────────┘
                       │             │
                  ┌────▼─────────────▼────┐
                  │    Thanos Query        │
                  │  (global query layer)  │
                  └────────────────────────┘
```

## Component Deployment

### Prometheus with Thanos Sidecar

The most common deployment pattern uses the Prometheus Operator. The sidecar is configured directly in the Prometheus custom resource.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: k8s
  namespace: monitoring
spec:
  replicas: 2
  retention: 6h
  retentionSize: "10GB"

  # Replica label used for deduplication across HA pairs
  replicaExternalLabelName: prometheus_replica

  # Cluster label written into every time series
  externalLabels:
    cluster: production-us-east-1
    region: us-east-1

  thanos:
    image: quay.io/thanos/thanos:v0.35.1
    objectStorageConfig:
      secret:
        name: thanos-objstore-config
        key: objstore.yml
    # Expose the gRPC Store API for Thanos Query
    grpcListenLocal: false
    httpListenLocal: false
    # Minimum time before a block is uploaded
    # Prevents uploading incomplete blocks
    minTime: "-6h"

  serviceMonitor:
    selfMonitor: true

  # Resources for Prometheus itself
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 2000m
      memory: 8Gi
```

The `retention: 6h` setting means Prometheus only keeps recent data locally. The sidecar uploads blocks to object storage as they complete, giving you long-term history without burning local disk.

### Object Storage Configuration

Thanos supports S3, GCS, Azure Blob Storage, and several S3-compatible alternatives. The configuration is stored in a Kubernetes Secret.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: thanos-objstore-config
  namespace: monitoring
stringData:
  objstore.yml: |
    type: S3
    config:
      bucket: your-thanos-metrics-bucket
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      # Use IAM roles (IRSA on EKS) instead of static credentials
      # when possible. Static credentials shown for completeness.
      access_key: <aws-access-key-id>
      secret_key: <aws-secret-access-key>
      # SSE configuration for encryption at rest
      sse_config:
        type: SSE-S3
      # Disable signature v2 for modern endpoints
      signature_version2: false
      # HTTP config for timeouts
      http_config:
        idle_conn_timeout: 90s
        response_header_timeout: 2m
        insecure_skip_verify: false
```

For production AWS deployments, use IRSA (IAM Roles for Service Accounts) to avoid static credentials entirely.

```yaml
# IRSA annotation on the ServiceAccount
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
  namespace: monitoring
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<account-id>:role/thanos-metrics-role
```

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::your-thanos-metrics-bucket",
        "arn:aws:s3:::your-thanos-metrics-bucket/*"
      ]
    }
  ]
}
```

With IRSA configured, remove the `access_key` and `secret_key` fields from the object store config entirely.

### Store Gateway Deployment

The Store Gateway reads block metadata from object storage and serves historical data over the gRPC Store API. It caches index headers locally to avoid repeated object storage reads on startup.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-store-gateway
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-store-gateway
  serviceName: thanos-store-gateway
  template:
    metadata:
      labels:
        app: thanos-store-gateway
    spec:
      serviceAccountName: thanos
      containers:
        - name: thanos-store-gateway
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - store
            - --log.level=info
            - --log.format=logfmt
            - --data-dir=/var/thanos/store
            - --objstore.config-file=/etc/thanos/objstore.yml
            # Time-based sharding: this instance handles blocks older than 2 weeks
            # Pair with a second instance that handles recent blocks
            - --min-time=-90d
            - --max-time=-14d
            # Index cache prevents repeated metadata reads from object storage
            - --index-cache-size=1GB
            # Chunk pool reduces allocations during query execution
            - --chunk-pool-size=2GB
            # Sync interval for new blocks
            - --sync-interval=3m
            # Concurrent block downloads per query
            - --store.grpc.series-max-concurrency=20
          ports:
            - name: grpc
              containerPort: 10901
            - name: http
              containerPort: 10902
          volumeMounts:
            - name: data
              mountPath: /var/thanos/store
            - name: objstore-config
              mountPath: /etc/thanos
          resources:
            requests:
              cpu: 500m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 8Gi
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: http
            initialDelaySeconds: 30
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /-/ready
              port: http
            initialDelaySeconds: 10
            periodSeconds: 5
      volumes:
        - name: objstore-config
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 100Gi
        storageClassName: gp3
---
apiVersion: v1
kind: Service
metadata:
  name: thanos-store-gateway
  namespace: monitoring
spec:
  selector:
    app: thanos-store-gateway
  ports:
    - name: grpc
      port: 10901
      targetPort: grpc
    - name: http
      port: 10902
      targetPort: http
  clusterIP: None
```

## Compactor: Block Lifecycle Management

The Compactor is the most operationally critical component. It must run as a singleton because it writes compacted blocks back to object storage and manages deletion marks. Running multiple compactors simultaneously causes data corruption.

### Compactor Deployment

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-compactor
  namespace: monitoring
spec:
  # CRITICAL: always 1 replica
  replicas: 1
  selector:
    matchLabels:
      app: thanos-compactor
  serviceName: thanos-compactor
  template:
    metadata:
      labels:
        app: thanos-compactor
    spec:
      serviceAccountName: thanos
      containers:
        - name: thanos-compactor
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - compact
            - --log.level=info
            - --log.format=logfmt
            - --data-dir=/var/thanos/compact
            - --objstore.config-file=/etc/thanos/objstore.yml
            # Wait mode: compact runs once, waits, then runs again
            - --wait
            - --wait-interval=5m
            # Retention configuration
            - --retention.resolution-raw=30d
            - --retention.resolution-5m=90d
            - --retention.resolution-1h=365d
            # Downsampling produces 5m and 1h resolution blocks
            - --downsampling.disable=false
            # Consistency delay: wait for blocks to be stable before compacting
            - --consistency-delay=30m
            # Compact blocks with up to this many series per block
            # Larger values = fewer blocks but more memory during compaction
            - --block-sync-concurrency=20
            # Deduplication label for HA pairs
            - --deduplication.replica-label=prometheus_replica
            - --deduplication.func=penalty
          ports:
            - name: http
              containerPort: 10902
          volumeMounts:
            - name: data
              mountPath: /var/thanos/compact
            - name: objstore-config
              mountPath: /etc/thanos
          resources:
            requests:
              cpu: 1000m
              memory: 4Gi
            limits:
              cpu: 4000m
              memory: 16Gi
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            # Compactor needs significant scratch space
            storage: 500Gi
        storageClassName: gp3
```

### Understanding Compaction Levels

Thanos uses a leveled compaction scheme. Understanding this prevents confusion when examining blocks in object storage.

Raw blocks are 2-hour TSDB blocks uploaded by the sidecar. Level-1 compaction merges 5 raw blocks into a 10-hour block. Level-2 merges 5 level-1 blocks into a 50-hour block. Level-3 merges 5 level-2 blocks into approximately 10 days of data.

```bash
# Inspect blocks in object storage using thanos tools
thanos tools bucket ls \
  --objstore.config-file=/etc/thanos/objstore.yml \
  --output=table

# Output shows block metadata including compaction level
# ULID                    | MinTime             | MaxTime             | NumSeries | Level
# 01HXXX...               | 2031-01-01 00:00:00 | 2031-01-01 02:00:00 | 150000    | 1
# 01HYYY...               | 2031-01-01 00:00:00 | 2031-01-01 10:00:00 | 145000    | 2
# 01HZZZ...               | 2031-01-01 00:00:00 | 2031-01-11 02:00:00 | 140000    | 3
```

### Block Verification and Repair

Object storage corruption and partial uploads can leave blocks in inconsistent states. Thanos provides tools to detect and repair these issues.

```bash
# Verify all blocks in the bucket
thanos tools bucket verify \
  --objstore.config-file=/etc/thanos/objstore.yml \
  --repair=false  # dry-run first

# Check for overlapping blocks (common after compactor restarts)
thanos tools bucket verify \
  --objstore.config-file=/etc/thanos/objstore.yml \
  --issues=overlappedBlocks

# Repair: remove overlapping blocks
thanos tools bucket verify \
  --objstore.config-file=/etc/thanos/objstore.yml \
  --repair=true \
  --issues=overlappedBlocks
```

## Downsampling

Downsampling reduces query latency for long time ranges by pre-computing aggregated representations of data. Without downsampling, a query spanning 90 days must process millions of raw data points. With downsampling, the same query can use 5-minute or 1-hour resolution blocks that are orders of magnitude smaller.

Thanos produces two downsampled resolutions automatically when the compactor runs:

- 5-minute resolution: computed from raw blocks after the raw retention window expires
- 1-hour resolution: computed from 5-minute blocks after the 5-minute retention window expires

The Query component automatically selects the appropriate resolution based on the time range requested and the `--query.max-concurrent` setting.

### Querying with Resolution

Thanos Query exposes a `resolution` parameter that lets you explicitly select the downsampling level.

```promql
# Raw resolution (default for short ranges)
rate(http_requests_total{cluster="production"}[5m])

# Force 5-minute downsampled data for a 30-day range
# Thanos automatically selects this when the range is long enough
# You can also use the Thanos Query UI max_source_resolution parameter
```

```bash
# Query with explicit resolution via the HTTP API
curl "http://thanos-query:9090/api/v1/query_range" \
  --data-urlencode 'query=sum(rate(http_requests_total[5m])) by (cluster)' \
  --data-urlencode 'start=2031-01-01T00:00:00Z' \
  --data-urlencode 'end=2031-03-31T23:59:59Z' \
  --data-urlencode 'step=1h' \
  --data-urlencode 'max_source_resolution=5m'
```

### Retention Policy Design

Retention policies must account for downsampling delays. The compactor will not produce downsampled blocks until the raw blocks they are derived from exist. Do not set raw retention shorter than the time needed for the compactor to run and produce 5-minute downsampled blocks.

```yaml
# Recommended production retention settings:
# Raw data:     30 days  (detailed recent history)
# 5m downsampled: 1 year (medium-term trend analysis)
# 1h downsampled: 3 years (long-term capacity planning)

compactor args:
  - --retention.resolution-raw=30d
  - --retention.resolution-5m=1y
  - --retention.resolution-1h=3y
```

## Thanos Query Deployment

The Query component is stateless and can be horizontally scaled. It receives PromQL queries, fans them out to Store API endpoints, merges results, and deduplicates HA replica data.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app: thanos-query
  template:
    metadata:
      labels:
        app: thanos-query
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: thanos-query
                topologyKey: kubernetes.io/hostname
      containers:
        - name: thanos-query
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - query
            - --log.level=info
            - --log.format=logfmt
            # Deduplication label matching what Prometheus sets
            - --query.replica-label=prometheus_replica
            - --query.replica-label=thanos_ruler_replica
            # Auto-discovery via DNS service discovery
            - --store=dnssrv+_grpc._tcp.thanos-store-gateway.monitoring.svc.cluster.local
            # Sidecar endpoints (populated via endpoint slice discovery or static)
            - --store=dnssrv+_grpc._tcp.prometheus-operated.monitoring.svc.cluster.local
            # Enable query timeout
            - --query.timeout=5m
            # Partial response strategy
            - --query.partial-response
            # Maximum concurrent queries
            - --query.max-concurrent=20
            # Web UI
            - --web.prefix-header=X-Forwarded-Prefix
          ports:
            - name: grpc
              containerPort: 10901
            - name: http
              containerPort: 10902
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: http
            initialDelaySeconds: 30
          readinessProbe:
            httpGet:
              path: /-/ready
              port: http
            initialDelaySeconds: 10
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi
---
apiVersion: v1
kind: Service
metadata:
  name: thanos-query
  namespace: monitoring
spec:
  selector:
    app: thanos-query
  ports:
    - name: grpc
      port: 10901
    - name: http
      port: 10902
```

## Multi-Cluster Federation

Federating metrics across multiple Kubernetes clusters requires careful label management and routing configuration.

### Architecture for Multi-Cluster

Each cluster runs its own Prometheus with a Thanos sidecar. All sidecars write to a shared object storage bucket. A central Query Frontend in a management cluster or shared observability namespace reaches out to all sidecars and the shared Store Gateway.

```
Cluster US-East (Prometheus + Sidecar) ─────┐
Cluster EU-West (Prometheus + Sidecar) ─────┤──► S3 Bucket (shared)
Cluster AP-SE   (Prometheus + Sidecar) ─────┘         │
                                                        │
                                              Store Gateway (mgmt)
                                                        │
                                              Thanos Query (mgmt)
                                                        │
                                              Grafana (global dashboards)
```

### External Store Endpoints

Register remote cluster sidecars and store gateways using static endpoints or DNS service discovery. Cross-cluster communication typically goes through internal load balancers or VPN-connected endpoints.

```yaml
# Thanos Query with multi-cluster store endpoints
args:
  - query
  - --store=thanos-sidecar-us-east.internal:10901
  - --store=thanos-sidecar-eu-west.internal:10901
  - --store=thanos-sidecar-ap-se.internal:10901
  - --store=thanos-store-gateway.monitoring.svc.cluster.local:10901
  # Labels that identify each cluster (set in Prometheus externalLabels)
  - --query.replica-label=prometheus_replica
```

### Query Frontend for Caching

For large teams making many simultaneous queries, the Query Frontend adds query splitting, result caching, and rate limiting on top of the Query layer.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query-frontend
  namespace: monitoring
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: thanos-query-frontend
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - query-frontend
            - --log.level=info
            - --query-frontend.downstream-url=http://thanos-query.monitoring.svc.cluster.local:10902
            # Split queries longer than 24h into multiple sub-queries
            - --query-range.split-interval=24h
            # In-memory cache
            - --query-frontend.compress-responses
            - --query-range.response-cache-config=|
                type: IN-MEMORY
                config:
                  max_size: 512MB
                  max_size_items: 2048
                  validity: 6h
            # Align query times to step to improve cache hit rate
            - --query-range.align-range-with-step
            # Rate limiting
            - --query-frontend.downstream-tripper-config=|
                max_idle_connections_per_host: 100
          ports:
            - name: http
              containerPort: 10902
```

## Ruler for Alert Evaluation

Thanos Ruler evaluates alerting and recording rules against global (multi-cluster) query results, enabling alerts that span cluster boundaries.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ThanosRuler
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  image: quay.io/thanos/thanos:v0.35.1
  ruleSelector:
    matchLabels:
      role: thanos-ruler
  queryEndpoints:
    - http://thanos-query.monitoring.svc.cluster.local:10902
  objectStorageConfig:
    key: objstore.yml
    name: thanos-objstore-config
  alertmanagersConfig:
    key: alertmanager.yml
    name: thanos-ruler-alertmanager
```

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: global-cluster-alerts
  namespace: monitoring
  labels:
    role: thanos-ruler
spec:
  groups:
    - name: global.cluster.capacity
      interval: 5m
      rules:
        - alert: GlobalCPUPressure
          expr: |
            sum by (cluster) (
              rate(container_cpu_usage_seconds_total{container!=""}[5m])
            )
            /
            sum by (cluster) (
              kube_node_status_allocatable{resource="cpu"}
            ) > 0.85
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Cluster {{ $labels.cluster }} CPU utilization above 85%"
            description: "Global CPU pressure detected across {{ $labels.cluster }}"
```

## Operational Runbook

### Checking Block Upload Status

```bash
# List recent blocks uploaded by a specific Prometheus instance
thanos tools bucket ls \
  --objstore.config-file=/etc/thanos/objstore.yml \
  --output=json | jq '
    select(.labels.cluster == "production-us-east-1") |
    {ulid, minTime, maxTime, compactionLevel: .compaction.level}
  '

# Check sidecar upload metrics
kubectl exec -n monitoring prometheus-k8s-0 -c thanos-sidecar -- \
  wget -qO- http://localhost:10902/metrics | grep thanos_objstore_
```

### Diagnosing Compaction Lag

```bash
# Check compactor metrics for lag
kubectl exec -n monitoring thanos-compactor-0 -- \
  wget -qO- http://localhost:10902/metrics | grep -E 'thanos_compact|thanos_block'

# Watch compactor logs for errors
kubectl logs -n monitoring thanos-compactor-0 --since=1h | grep -i error

# Common issue: compactor cannot acquire the lock
# This usually means a previous compactor instance crashed mid-run
# Resolve by deleting the lock file in object storage:
# s3://your-bucket/thanos/compact.lock
```

### Store Gateway Sync Issues

```bash
# Check how many blocks the store gateway has synced
kubectl exec -n monitoring thanos-store-gateway-0 -- \
  wget -qO- http://localhost:10902/metrics | grep thanos_blocks_meta_synced

# Force a resync
kubectl rollout restart statefulset/thanos-store-gateway -n monitoring

# Check index cache hit rate
kubectl exec -n monitoring thanos-store-gateway-0 -- \
  wget -qO- http://localhost:10902/metrics | grep thanos_store_index_cache
```

### Query Performance Diagnostics

```bash
# Identify slow queries via Query UI (port-forward)
kubectl port-forward -n monitoring svc/thanos-query 9090:10902

# The /api/v1/query_range endpoint supports a queryStats parameter
curl "http://localhost:9090/api/v1/query_range?queryStats=true" \
  --data-urlencode 'query=sum(rate(http_requests_total[5m]))' \
  --data-urlencode 'start=2031-07-01T00:00:00Z' \
  --data-urlencode 'end=2031-07-28T00:00:00Z' \
  --data-urlencode 'step=1h' | jq .stats
```

## Cost Optimization

Object storage costs accumulate as data ages. A well-designed retention policy keeps costs predictable.

### Storage Cost Estimation

```python
# Rough cost estimation for AWS S3 (us-east-1)
# Assumptions: 100 Prometheus instances, 500k active series each

raw_blocks_per_day_gb = 100 * 500000 * 0.000002  # ~2 bytes/sample at 15s interval
# = ~100 GB/day for raw data

monthly_raw_gb = raw_blocks_per_day_gb * 30  # 3 TB/month raw
monthly_5m_gb = raw_blocks_per_day_gb * 12 * 3  # ~3.6 TB/month 5m (12x compression, 3x duration)
monthly_1h_gb = raw_blocks_per_day_gb * 1 * 36  # ~3.6 TB/month 1h (36x duration, 72x compression)

# Total at $0.023/GB/month (S3 Standard):
total_monthly_gb = monthly_raw_gb + monthly_5m_gb + monthly_1h_gb
monthly_cost = total_monthly_gb * 0.023
# Approximately $230/month for this scale
```

### S3 Lifecycle Policies

Move older blocks to cheaper storage tiers automatically.

```json
{
  "Rules": [
    {
      "Id": "ThanosMoveToIA",
      "Status": "Enabled",
      "Filter": {"Prefix": "thanos/"},
      "Transitions": [
        {
          "Days": 30,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 90,
          "StorageClass": "GLACIER_IR"
        }
      ]
    }
  ]
}
```

## Grafana Integration

Configure Grafana to use Thanos Query Frontend as its data source for a seamless query experience.

```yaml
# Grafana datasource configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  thanos.yaml: |
    apiVersion: 1
    datasources:
      - name: Thanos
        type: prometheus
        access: proxy
        url: http://thanos-query-frontend.monitoring.svc.cluster.local:10902
        jsonData:
          timeInterval: "15s"
          queryTimeout: "300s"
          httpMethod: "POST"
          # Enable exemplars if using Prometheus 2.26+
          exemplarTraceIdDestinations:
            - name: trace_id
              datasourceUid: tempo
        isDefault: true
```

## Summary

Thanos transforms Prometheus from a 15-day local store into a durable, queryable, multi-year metrics archive. The key operational points are:

- Run exactly one compactor instance and protect it from parallel execution
- Set raw retention short (6h to 2d) to keep Prometheus light; historical data belongs in object storage
- Configure downsampling retention to grow as data ages (30d raw, 1y at 5m, 3y at 1h)
- Use the Query Frontend for caching and query splitting when serving large teams
- Label each Prometheus instance with cluster and region labels from the start; changing these later requires rewriting block metadata
- Monitor compactor lag and store gateway sync counts as primary SLIs for your metrics infrastructure

With this architecture in place, your team can answer capacity planning questions spanning years of data using the same PromQL queries they write for real-time dashboards.
