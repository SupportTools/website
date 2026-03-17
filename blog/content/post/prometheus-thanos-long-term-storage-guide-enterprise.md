---
title: "Thanos: Long-Term Metrics Storage and High Availability for Prometheus"
date: 2028-10-13T00:00:00-05:00
draft: false
tags: ["Thanos", "Prometheus", "Monitoring", "Kubernetes", "Observability"]
categories:
- Thanos
- Prometheus
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete production guide to Thanos for long-term Prometheus metrics storage, covering all components, object storage configuration, global query federation, downsampling, and multi-tenant isolation."
more_link: "yes"
url: "/prometheus-thanos-long-term-storage-guide-enterprise/"
---

Prometheus is purpose-built for short-term, high-cardinality metrics storage. Its local TSDB is fast and efficient, but it cannot scale horizontally, has limited retention (practical limit around 15 days on most clusters), and provides no high availability — if the Prometheus pod restarts, you lose in-flight data. Thanos solves all three problems by layering on top of standard Prometheus instances without requiring changes to how your applications instrument themselves.

This guide builds a complete production Thanos deployment: Sidecar for offloading blocks to object storage, Store Gateway for historical queries, Querier for unified reads across all sources, Compactor for downsampling and retention, and Ruler for global alerting rules.

<!--more-->

# Thanos: Long-Term Metrics Storage and High Availability for Prometheus

## Architecture Overview

Thanos adds six optional components to a standard Prometheus deployment. You can adopt them incrementally:

```
┌─────────────────────────────────────────────────────────────────┐
│  Prometheus Pods                                                 │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐           │
│  │ Prometheus  │   │ Prometheus  │   │ Prometheus  │           │
│  │  + Sidecar  │   │  + Sidecar  │   │  + Sidecar  │           │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘           │
│         │                 │                  │                   │
└─────────┼─────────────────┼──────────────────┼───────────────────┘
          │  upload blocks  │                  │
          ▼                 ▼                  ▼
     ┌────────────────────────────────────────┐
     │           Object Storage (S3/GCS)      │
     └───────────────────┬────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Store Gateway     │ (reads from object store)
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │      Querier        │ (fans out to Sidecars + Store GW)
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │     Query Frontend  │ (caching, query splitting)
              └─────────────────────┘

   ┌──────────────────┐    ┌──────────────────┐
   │    Compactor     │    │      Ruler       │
   │  (compaction +   │    │  (global rules   │
   │   downsampling)  │    │   + alerting)    │
   └──────────────────┘    └──────────────────┘
```

## Object Storage Configuration

Thanos uses a single `objstore.yaml` file for all components. Store it as a Kubernetes Secret.

```yaml
# objstore-config.yaml — S3 configuration
type: S3
config:
  bucket: thanos-metrics-prod
  endpoint: s3.us-east-1.amazonaws.com
  region: us-east-1
  # Use IRSA instead of access keys in production
  # access_key: ""
  # secret_key: ""
  sse_config:
    type: SSE-KMS
    kms_key_id: arn:aws:kms:us-east-1:123456789012:key/mrk-xxxxxxxx
  http_config:
    idle_conn_timeout: 90s
    response_header_timeout: 2m
    tls_handshake_timeout: 10s
```

```bash
kubectl create secret generic thanos-objstore-config \
  --from-file=objstore.yaml=objstore-config.yaml \
  -n monitoring
```

For GCS:

```yaml
type: GCS
config:
  bucket: thanos-metrics-prod
  service_account: |
    {
      "type": "service_account",
      "project_id": "your-project",
      ...
    }
```

## Thanos Sidecar

The Sidecar runs as a container alongside each Prometheus pod. It:
1. Serves Prometheus's gRPC StoreAPI (for real-time data)
2. Uploads completed TSDB blocks to object storage (every 2 hours by default)

```yaml
# prometheus-with-thanos-sidecar.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: prometheus
  namespace: monitoring
spec:
  serviceName: prometheus
  replicas: 2
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
        thanos-store-api: "true"
    spec:
      serviceAccountName: prometheus
      containers:
        - name: prometheus
          image: prom/prometheus:v2.55.0
          args:
            - --config.file=/etc/prometheus/prometheus.yml
            - --storage.tsdb.path=/prometheus
            # Thanos requires blocks NOT to be compacted locally
            # Sidecar uploads 2h blocks; keep 4h locally as buffer
            - --storage.tsdb.retention.time=4h
            - --storage.tsdb.min-block-duration=2h
            - --storage.tsdb.max-block-duration=2h
            - --web.enable-lifecycle
            - --web.enable-admin-api
            # External labels are critical — they identify this Prometheus replica
            - --web.external-url=https://prometheus-0.monitoring.svc.cluster.local
          ports:
            - containerPort: 9090
              name: http
          volumeMounts:
            - name: prometheus-data
              mountPath: /prometheus
            - name: prometheus-config
              mountPath: /etc/prometheus

        - name: thanos-sidecar
          image: quay.io/thanos/thanos:v0.37.0
          args:
            - sidecar
            - --log.level=info
            - --tsdb.path=/prometheus
            - --prometheus.url=http://localhost:9090
            - --objstore.config-file=/etc/thanos/objstore.yaml
            # External labels MUST match what Prometheus is configured with
            - --reloader.config-file=/etc/prometheus/prometheus.yml
            - --reloader.config-envsubst-file=/etc/prometheus/prometheus.yml.tmpl
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          ports:
            - containerPort: 10902
              name: http
            - containerPort: 10901
              name: grpc
          volumeMounts:
            - name: prometheus-data
              mountPath: /prometheus
            - name: prometheus-config
              mountPath: /etc/prometheus
            - name: objstore-config
              mountPath: /etc/thanos
      volumes:
        - name: prometheus-config
          configMap:
            name: prometheus-config
        - name: objstore-config
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: prometheus-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3
        resources:
          requests:
            storage: 50Gi
```

Prometheus `prometheus.yml` **must** have `external_labels` — these label every time series with the replica identity:

```yaml
# prometheus-config.yaml
global:
  scrape_interval: 30s
  evaluation_interval: 30s
  external_labels:
    cluster: production-us-east-1
    replica: $(POD_NAME)   # injected by sidecar reloader

rule_files:
  - /etc/prometheus/rules/*.yaml

scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"
```

## Thanos Querier

The Querier fans out PromQL queries to all configured StoreAPI endpoints (Sidecars, Store Gateways, other Queriers) and deduplicates results based on the `replica` external label.

```yaml
# thanos-querier.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-querier
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-querier
  template:
    metadata:
      labels:
        app: thanos-querier
    spec:
      containers:
        - name: thanos-querier
          image: quay.io/thanos/thanos:v0.37.0
          args:
            - query
            - --log.level=info
            - --http-address=0.0.0.0:9090
            - --grpc-address=0.0.0.0:10901
            # Deduplicate HA Prometheus pairs on the "replica" label
            - --query.replica-label=replica
            # Auto-discover Sidecars via Service endpoints
            - --endpoint=dnssrv+_grpc._tcp.thanos-sidecar.monitoring.svc.cluster.local
            # Store Gateway endpoint
            - --endpoint=dnssrv+_grpc._tcp.thanos-store-gateway.monitoring.svc.cluster.local
            # Thanos Ruler endpoint (if deployed)
            - --endpoint=dnssrv+_grpc._tcp.thanos-ruler.monitoring.svc.cluster.local
            - --query.partial-response
            - --query.auto-downsampling
          ports:
            - containerPort: 9090
              name: http
            - containerPort: 10901
              name: grpc
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi
---
# Service for Sidecar discovery
apiVersion: v1
kind: Service
metadata:
  name: thanos-sidecar
  namespace: monitoring
spec:
  clusterIP: None  # headless — DNS returns all pod IPs
  selector:
    thanos-store-api: "true"
  ports:
    - name: grpc
      port: 10901
      targetPort: 10901
---
apiVersion: v1
kind: Service
metadata:
  name: thanos-querier
  namespace: monitoring
spec:
  selector:
    app: thanos-querier
  ports:
    - name: http
      port: 9090
      targetPort: 9090
```

## Store Gateway

The Store Gateway serves historical blocks from object storage over the StoreAPI. It translates PromQL label matchers into object storage queries, downloading only the necessary index files and chunks.

```yaml
# thanos-store-gateway.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-store-gateway
  namespace: monitoring
spec:
  serviceName: thanos-store-gateway
  replicas: 2
  selector:
    matchLabels:
      app: thanos-store-gateway
  template:
    metadata:
      labels:
        app: thanos-store-gateway
    spec:
      containers:
        - name: thanos-store-gateway
          image: quay.io/thanos/thanos:v0.37.0
          args:
            - store
            - --log.level=info
            - --data-dir=/var/thanos/store
            - --objstore.config-file=/etc/thanos/objstore.yaml
            - --http-address=0.0.0.0:10902
            - --grpc-address=0.0.0.0:10901
            # Cache index headers in memory for faster query startup
            - --store.index-header-lazy-reader-enabled
            # Sharding for horizontal scaling — each replica handles a subset of blocks
            - --selector.relabel-config-file=/etc/thanos/store-sharding.yaml
          ports:
            - containerPort: 10902
              name: http
            - containerPort: 10901
              name: grpc
          volumeMounts:
            - name: store-data
              mountPath: /var/thanos/store
            - name: objstore-config
              mountPath: /etc/thanos
          resources:
            requests:
              cpu: 200m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 8Gi
      volumes:
        - name: objstore-config
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: store-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3
        resources:
          requests:
            storage: 20Gi  # Index cache only — blocks stay in S3
---
apiVersion: v1
kind: Service
metadata:
  name: thanos-store-gateway
  namespace: monitoring
spec:
  clusterIP: None
  selector:
    app: thanos-store-gateway
  ports:
    - name: grpc
      port: 10901
```

Store Gateway sharding configuration (for splitting large object stores across replicas):

```yaml
# store-sharding.yaml — stored as ConfigMap
# Replica 0 handles blocks where (hash(external_label) mod 2) == 0
- action: hashmod
  source_labels: [__block_id]
  target_label: shard
  modulus: 2
- action: keep
  source_labels: [shard]
  regex: "0"  # Change to "1" for replica 1
```

## Compactor

The Compactor runs as a singleton (never scale to 2+ replicas). It merges 2-hour blocks into larger ones (downsampling) and enforces retention policies.

```yaml
# thanos-compactor.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-compactor
  namespace: monitoring
spec:
  serviceName: thanos-compactor
  replicas: 1  # CRITICAL: never run more than one compactor per object store
  selector:
    matchLabels:
      app: thanos-compactor
  template:
    metadata:
      labels:
        app: thanos-compactor
    spec:
      containers:
        - name: thanos-compactor
          image: quay.io/thanos/thanos:v0.37.0
          args:
            - compact
            - --log.level=info
            - --data-dir=/var/thanos/compact
            - --objstore.config-file=/etc/thanos/objstore.yaml
            - --http-address=0.0.0.0:10902
            - --wait           # Run continuously, not as a one-shot job
            - --wait-interval=5m
            # Retention: raw data 90 days, 5m downsampling 1 year, 1h downsampling 2 years
            - --retention.resolution-raw=90d
            - --retention.resolution-5m=365d
            - --retention.resolution-1h=730d
            # Enable downsampling
            - --downsampling.disable=false
            # Compact blocks that overlap in time (handles deduplication)
            - --deduplication.replica-label=replica
            # Progress through compaction deterministically
            - --compact.concurrency=1
          ports:
            - containerPort: 10902
              name: http
          volumeMounts:
            - name: compactor-data
              mountPath: /var/thanos/compact
            - name: objstore-config
              mountPath: /etc/thanos
          resources:
            requests:
              cpu: 200m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 8Gi
      volumes:
        - name: objstore-config
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: compactor-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3
        resources:
          requests:
            storage: 100Gi  # Temporary working space during compaction
```

## Thanos Ruler

The Ruler evaluates recording rules and alerting rules against the Querier (global view), enabling cross-cluster alerts that local Prometheus instances cannot compute.

```yaml
# thanos-ruler.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  serviceName: thanos-ruler
  replicas: 2
  selector:
    matchLabels:
      app: thanos-ruler
  template:
    metadata:
      labels:
        app: thanos-ruler
        thanos-store-api: "true"  # expose StoreAPI to Querier
    spec:
      containers:
        - name: thanos-ruler
          image: quay.io/thanos/thanos:v0.37.0
          args:
            - rule
            - --log.level=info
            - --data-dir=/var/thanos/ruler
            - --eval-interval=1m
            - --rule-file=/etc/thanos/rules/*.yaml
            - --alertmanagers.url=http://alertmanager.monitoring.svc:9093
            - --query=http://thanos-querier.monitoring.svc:9090
            - --objstore.config-file=/etc/thanos/objstore.yaml
            - --http-address=0.0.0.0:10902
            - --grpc-address=0.0.0.0:10901
            # Labels that identify this Ruler replica
            - --label=ruler_cluster="production"
            - --label=ruler_replica="$(POD_NAME)"
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          volumeMounts:
            - name: ruler-data
              mountPath: /var/thanos/ruler
            - name: ruler-rules
              mountPath: /etc/thanos/rules
            - name: objstore-config
              mountPath: /etc/thanos
      volumes:
        - name: ruler-rules
          configMap:
            name: thanos-ruler-rules
        - name: objstore-config
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: ruler-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3
        resources:
          requests:
            storage: 10Gi
```

Global alerting rule example (queries across all clusters):

```yaml
# ConfigMap: thanos-ruler-rules
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-ruler-rules
  namespace: monitoring
data:
  global-alerts.yaml: |
    groups:
      - name: global.cluster_health
        interval: 2m
        rules:
          # Alert if any cluster loses more than 20% of its nodes
          - alert: ClusterNodeLoss
            expr: |
              (
                count by (cluster) (kube_node_status_condition{condition="Ready",status="true"})
                /
                count by (cluster) (kube_node_info)
              ) < 0.8
            for: 5m
            labels:
              severity: critical
            annotations:
              summary: "Cluster {{ $labels.cluster }} has lost nodes"
              description: "Only {{ $value | humanizePercentage }} of nodes are ready"

          # Cross-cluster SLO: p99 latency across the global fleet
          - alert: GlobalAPILatencyHigh
            expr: |
              histogram_quantile(0.99,
                sum by (le, cluster) (
                  rate(http_request_duration_seconds_bucket{job="api"}[5m])
                )
              ) > 2.0
            for: 10m
            labels:
              severity: warning
```

## Query Frontend (Caching Layer)

The Query Frontend splits long-range queries into shorter intervals and caches results, dramatically reducing load on the Querier for dashboard queries.

```yaml
# thanos-query-frontend.yaml
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
          image: quay.io/thanos/thanos:v0.37.0
          args:
            - query-frontend
            - --http-address=0.0.0.0:9090
            - --query-frontend.downstream-url=http://thanos-querier.monitoring.svc:9090
            # Split queries into 24h intervals for cache efficiency
            - --query-range.split-interval=24h
            - --query-range.max-retries-per-request=5
            # In-memory cache (use Memcached for multi-replica)
            - --query-range.response-cache-config=|
                type: IN-MEMORY
                config:
                  max_size: 1GB
                  max_size_items: 10000
                  validity: 6h
            - --labels.split-interval=24h
            - --labels.response-cache-config=|
                type: IN-MEMORY
                config:
                  max_size: 256MB
                  validity: 6h
          ports:
            - containerPort: 9090
              name: http
```

## Tenant-Based Isolation

For multi-tenant environments, use Thanos Receive instead of Sidecar. Receive accepts remote-write from Prometheus and partitions data by tenant via HTTP headers.

```yaml
# thanos-receive.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-receive
  namespace: monitoring
spec:
  serviceName: thanos-receive
  replicas: 3
  template:
    spec:
      containers:
        - name: thanos-receive
          image: quay.io/thanos/thanos:v0.37.0
          args:
            - receive
            - --http-address=0.0.0.0:10902
            - --grpc-address=0.0.0.0:10901
            - --remote-write.address=0.0.0.0:19291
            - --tsdb.path=/var/thanos/receive
            - --tsdb.retention=24h
            - --objstore.config-file=/etc/thanos/objstore.yaml
            # Tenant routing via X-Scope-OrgID header
            - --receive.hashrings-file=/etc/thanos/hashrings.json
            - --receive.replication-factor=2
            - --label=receive_replica="$(POD_NAME)"
```

Configure Prometheus to remote-write with tenant ID:

```yaml
# In prometheus.yml for tenant "team-payments"
remote_write:
  - url: http://thanos-receive.monitoring.svc:19291/api/v1/receive
    headers:
      X-Scope-OrgID: team-payments
    queue_config:
      max_samples_per_send: 10000
      capacity: 100000
      max_shards: 10
```

## Thanos vs Cortex vs VictoriaMetrics

| Feature | Thanos | Cortex | VictoriaMetrics |
|---------|--------|--------|-----------------|
| **Architecture** | Modular (pick what you need) | Monolithic/microservices | Monolithic with clustering option |
| **Storage backend** | Any S3-compatible + local | S3-compatible + Cassandra | Local disk (no object store needed) |
| **HA dedup** | Replica label based | Ruler-level | Built-in |
| **Downsampling** | Yes (Compactor) | No | Yes |
| **Query pushdown** | Limited | Good | Excellent |
| **Cardinality limits** | No built-in | Yes (per-tenant) | Yes |
| **Operational complexity** | Medium | High | Low |
| **Grafana integration** | Native Thanos datasource | Native Cortex datasource | Prometheus-compatible |

**Choose Thanos** if you already run Prometheus and want incremental adoption with proven long-term block storage semantics.

**Choose Cortex** if you need strict multi-tenancy with per-tenant limits, Cassandra integration, or already run large Grafana Cloud-style deployments.

**Choose VictoriaMetrics** if you want significantly lower resource usage, built-in clustering, and simpler operations at the cost of some advanced features.

## Monitoring Thanos Itself

```promql
# Sidecar: check blocks are being uploaded
rate(thanos_objstore_bucket_operations_total{operation="upload"}[5m]) == 0

# Querier: check query success rate
rate(http_requests_total{handler="query",code!~"5.."}[5m]) /
rate(http_requests_total{handler="query"}[5m]) < 0.95

# Compactor: check for no halted compaction
thanos_compact_halted == 1

# Store Gateway: check cache hit rate
rate(thanos_store_index_cache_hits_total[5m]) /
rate(thanos_store_index_cache_requests_total[5m])
```

## Grafana Datasource Configuration

```yaml
# grafana-datasource-thanos.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasource-thanos
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  thanos.yaml: |
    apiVersion: 1
    datasources:
      - name: Thanos
        type: prometheus
        url: http://thanos-query-frontend.monitoring.svc:9090
        access: proxy
        isDefault: true
        jsonData:
          timeInterval: "30s"
          queryTimeout: "120s"
          httpMethod: POST
```

Thanos provides the operational foundation for production-grade metrics: unlimited retention through object storage, HA deduplication across Prometheus pairs, and global query federation across clusters — all while remaining fully compatible with the Prometheus ecosystem.
