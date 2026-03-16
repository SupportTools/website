---
title: "Prometheus + Thanos: Long-Term Metrics Storage and Global Query at Scale"
date: 2027-07-05T00:00:00-05:00
draft: false
tags: ["Prometheus", "Thanos", "Kubernetes", "Observability", "Monitoring"]
categories:
- Prometheus
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to deploying Thanos alongside Prometheus for long-term metrics retention, global query federation, deduplication, downsampling, and multi-cluster observability on Kubernetes."
more_link: "yes"
url: "/prometheus-thanos-long-term-storage-guide/"
---

Prometheus is purpose-built for short-term metrics retention and fast local queries. When retention requirements exceed two weeks, when multiple Prometheus instances need to be queried as a unified view, or when metrics must survive cluster failures, Thanos fills the gap. Thanos extends Prometheus with object storage-backed long-term retention, global query federation, transparent deduplication, and downsampling — all without modifying Prometheus itself. This guide covers every Thanos component in production detail, from sidecar to compactor, with real configuration artifacts and sizing guidance.

<!--more-->

## Thanos Architecture Overview

### Component Roles

Thanos splits its functionality into independently deployable components:

| Component | Function | Deployment Mode |
|-----------|----------|-----------------|
| Sidecar | Ships blocks from Prometheus to object storage; exposes StoreAPI | Pod sidecar |
| Query | Fan-out queries across StoreAPI endpoints; deduplicates | Deployment |
| Query Frontend | Caches and shards range queries; retry logic | Deployment |
| Store Gateway | Serves historical blocks from object storage via StoreAPI | StatefulSet |
| Compactor | Downsamples and compacts blocks in object storage | StatefulSet (singleton) |
| Ruler | Evaluates recording and alerting rules against StoreAPI | StatefulSet |
| Receiver | Accepts remote_write; stores blocks without Prometheus | StatefulSet |

### Data Flow

```
Prometheus ──(sidecar)──► object storage (S3/GCS/MinIO)
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              Store Gateway  Compactor    Ruler
                    │
                    ▼
              Thanos Query ◄── Sidecar (real-time last 2h)
                    │
              Query Frontend
                    │
              Grafana / API clients
```

The sidecar exposes a StoreAPI endpoint that serves the most recent two hours of data (still in Prometheus TSDB head). The Store Gateway serves older blocks from object storage. Thanos Query fans out to both, merges results, and deduplicates series from multiple replicas.

---

## Object Storage Configuration

### S3 Backend

Create a secret containing the object store configuration:

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
      bucket: my-thanos-metrics-prod
      endpoint: s3.amazonaws.com
      region: us-east-1
      # Use IRSA/pod identity — avoid embedding credentials
      # access_key and secret_key left empty when using IAM roles
      sse_config:
        type: SSE-S3
      http_config:
        idle_conn_timeout: 90s
        response_header_timeout: 2m
        tls_handshake_timeout: 10s
```

For explicit credentials in non-AWS environments:

```yaml
stringData:
  objstore.yml: |
    type: S3
    config:
      bucket: my-thanos-metrics-prod
      endpoint: minio.minio.svc:9000
      region: us-east-1
      access_key: "REPLACE_WITH_ACCESS_KEY"
      secret_key: "REPLACE_WITH_SECRET_KEY"
      insecure: false
      signature_version2: false
```

### GCS Backend

```yaml
stringData:
  objstore.yml: |
    type: GCS
    config:
      bucket: my-thanos-metrics-prod
      service_account: |
        {
          "type": "service_account",
          "project_id": "my-project",
          "client_email": "thanos@my-project.iam.gserviceaccount.com",
          "private_key_id": "REPLACE_WITH_KEY_ID"
        }
```

### MinIO Backend (On-Premises)

```yaml
stringData:
  objstore.yml: |
    type: S3
    config:
      bucket: thanos
      endpoint: minio.minio.svc:9000
      access_key: "REPLACE_WITH_MINIO_ACCESS_KEY"
      secret_key: "REPLACE_WITH_MINIO_SECRET_KEY"
      insecure: false
      signature_version2: false
      put_user_metadata: {}
      http_config:
        idle_conn_timeout: 90s
      trace:
        enable: false
      part_size: 134217728
```

---

## Prometheus with Thanos Sidecar

### Prometheus StatefulSet with Sidecar

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: prometheus
  namespace: monitoring
spec:
  serviceName: prometheus
  replicas: 2   # HA pair — Thanos will deduplicate
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
      securityContext:
        fsGroup: 2000
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: prometheus
          image: prom/prometheus:v2.53.0
          args:
            - --config.file=/etc/prometheus/prometheus.yml
            - --storage.tsdb.path=/prometheus
            - --storage.tsdb.retention.time=2h
            - --storage.tsdb.min-block-duration=2h
            - --storage.tsdb.max-block-duration=2h
            - --web.enable-lifecycle
            - --web.enable-admin-api
            - --log.level=info
          ports:
            - containerPort: 9090
              name: http
          volumeMounts:
            - name: prometheus-data
              mountPath: /prometheus
            - name: prometheus-config
              mountPath: /etc/prometheus
          resources:
            requests:
              memory: 4Gi
              cpu: "1"
            limits:
              memory: 8Gi
              cpu: "4"

        - name: thanos-sidecar
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - sidecar
            - --log.level=info
            - --tsdb.path=/prometheus
            - --prometheus.url=http://localhost:9090
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --objstore.config-file=/etc/thanos/objstore.yml
          ports:
            - containerPort: 10901
              name: grpc
            - containerPort: 10902
              name: http
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          volumeMounts:
            - name: prometheus-data
              mountPath: /prometheus
            - name: thanos-objstore-config
              mountPath: /etc/thanos
          resources:
            requests:
              memory: 128Mi
              cpu: 100m
            limits:
              memory: 512Mi
              cpu: 500m
      volumes:
        - name: prometheus-config
          configMap:
            name: prometheus-config
        - name: thanos-objstore-config
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: prometheus-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 50Gi
```

The `--storage.tsdb.min-block-duration=2h` and `--storage.tsdb.max-block-duration=2h` settings are critical: they prevent Prometheus from compacting blocks, leaving that responsibility to Thanos Compactor.

### Sidecar Service for StoreAPI Discovery

```yaml
apiVersion: v1
kind: Service
metadata:
  name: prometheus-thanos-sidecar
  namespace: monitoring
  labels:
    thanos-store-api: "true"
spec:
  selector:
    app: prometheus
  ports:
    - name: grpc
      port: 10901
      targetPort: grpc
    - name: http
      port: 10902
      targetPort: http
  clusterIP: None   # Headless for per-pod DNS
```

---

## Thanos Querier

### Querier Deployment

The Querier discovers StoreAPI endpoints via static configuration, DNS service discovery, or the `--store.sd-files` flag:

```yaml
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
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - query
            - --log.level=info
            - --http-address=0.0.0.0:9090
            - --grpc-address=0.0.0.0:10901
            # Deduplicate by replica label
            - --query.replica-label=prometheus_replica
            - --query.replica-label=rule_replica
            # Sidecar discovery via DNS
            - --store=dnssrv+_grpc._tcp.prometheus-thanos-sidecar.monitoring.svc.cluster.local
            # Store Gateway
            - --store=dnssrv+_grpc._tcp.thanos-store-gateway.monitoring.svc.cluster.local
            # Ruler StoreAPI
            - --store=dnssrv+_grpc._tcp.thanos-ruler.monitoring.svc.cluster.local
            - --query.timeout=5m
            - --query.lookback-delta=5m
            - --web.prefix-header=X-Forwarded-Prefix
          ports:
            - containerPort: 9090
              name: http
            - containerPort: 10901
              name: grpc
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: http
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /-/ready
              port: http
            initialDelaySeconds: 10
            periodSeconds: 5
          resources:
            requests:
              memory: 1Gi
              cpu: 500m
            limits:
              memory: 4Gi
              cpu: "2"
```

### Deduplication Behavior

When two Prometheus replicas scrape the same targets, their series will be identical except for a `prometheus_replica` label. Thanos Querier strips this label during query evaluation and returns deduplicated results. The `--query.replica-label` flag instructs Querier which labels to treat as replica differentiators.

---

## Query Frontend

The Query Frontend caches query results using memcached or in-memory cache, and splits large range queries into sub-queries to avoid hitting single Querier instances too hard:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query-frontend
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-query-frontend
  template:
    metadata:
      labels:
        app: thanos-query-frontend
    spec:
      containers:
        - name: thanos-query-frontend
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - query-frontend
            - --http-address=0.0.0.0:9090
            - --query-frontend.downstream-url=http://thanos-querier.monitoring.svc:9090
            - --query-range.split-interval=24h
            - --query-range.max-retries-per-request=5
            - --query-frontend.log-queries-longer-than=10s
            # In-memory cache (use memcached for multi-replica)
            - --query-range.response-cache-config=|
                type: IN-MEMORY
                config:
                  max_size: 512MB
                  validity: 6h
            - --labels.response-cache-config=|
                type: IN-MEMORY
                config:
                  max_size: 256MB
                  validity: 10m
          ports:
            - containerPort: 9090
              name: http
          resources:
            requests:
              memory: 512Mi
              cpu: 200m
            limits:
              memory: 2Gi
              cpu: "1"
```

Configure Grafana to point to the Query Frontend service rather than directly to the Querier to benefit from caching.

---

## Store Gateway

### StatefulSet Configuration

The Store Gateway downloads block metadata from object storage and serves time-range queries. It downloads only index headers into memory; actual chunk data is streamed on demand:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-store-gateway
  namespace: monitoring
spec:
  serviceName: thanos-store-gateway
  replicas: 3
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
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - store
            - --log.level=info
            - --data-dir=/data
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --objstore.config-file=/etc/thanos/objstore.yml
            # Shard blocks across gateway replicas
            - --store.enable-index-header-lazy-reader
            - --index-cache.config=|
                type: IN-MEMORY
                config:
                  max_size: 4GB
            # Time-partition sharding (shard 0 of 3)
            - --min-time=-1y
            - --max-time=-30d
          volumeMounts:
            - name: data
              mountPath: /data
            - name: thanos-objstore-config
              mountPath: /etc/thanos
          ports:
            - containerPort: 10901
              name: grpc
            - containerPort: 10902
              name: http
          resources:
            requests:
              memory: 4Gi
              cpu: "1"
            limits:
              memory: 8Gi
              cpu: "4"
      volumes:
        - name: thanos-objstore-config
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 100Gi
```

### Time-Shard Partitioning

For very large metric stores, deploy multiple Store Gateway groups partitioned by time:

```yaml
# Recent historical — last 30 days
args:
  - --min-time=-30d
  - --max-time=0d

# Older historical — 30 days to 1 year
args:
  - --min-time=-1y
  - --max-time=-30d

# Archive — older than 1 year
args:
  - --min-time=-10y
  - --max-time=-1y
```

---

## Compactor

### Singleton Compactor with Downsampling

The Compactor is a singleton (only one instance should run at a time to avoid conflicts):

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
      app: thanos-compactor
  template:
    metadata:
      labels:
        app: thanos-compactor
    spec:
      containers:
        - name: thanos-compactor
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - compact
            - --log.level=info
            - --data-dir=/data
            - --http-address=0.0.0.0:10902
            - --objstore.config-file=/etc/thanos/objstore.yml
            # Retention settings
            - --retention.resolution-raw=30d
            - --retention.resolution-5m=90d
            - --retention.resolution-1h=365d
            # Compaction concurrency
            - --compact.concurrency=1
            - --downsample.concurrency=1
            # Run continuously
            - --wait
            - --wait-interval=5m
          volumeMounts:
            - name: data
              mountPath: /data
            - name: thanos-objstore-config
              mountPath: /etc/thanos
          ports:
            - containerPort: 10902
              name: http
          resources:
            requests:
              memory: 2Gi
              cpu: "1"
            limits:
              memory: 8Gi
              cpu: "4"
      volumes:
        - name: thanos-objstore-config
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 500Gi
```

### Downsampling Resolution Levels

Thanos Compactor produces three resolution levels:

| Resolution | Sample interval | Best for |
|-----------|----------------|---------|
| Raw | Original scrape interval (15s/30s) | Last 30 days |
| 5m | 5-minute averages | Last 90 days |
| 1h | 1-hour averages | Last 365 days+ |

Queries against the Querier automatically select the appropriate resolution based on the time range requested.

---

## Thanos Ruler

### Recording and Alerting Rules at Global Scope

Thanos Ruler evaluates rules against the Querier (historical + real-time), enabling cross-cluster and long-term recording rules:

```yaml
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
        thanos-store-api: "true"
    spec:
      containers:
        - name: thanos-ruler
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - rule
            - --log.level=info
            - --data-dir=/data
            - --eval-interval=1m
            - --rule-file=/etc/thanos/rules/*.yaml
            - --alertmanagers.url=http://alertmanager.monitoring.svc:9093
            - --query=http://thanos-querier.monitoring.svc:9090
            - --objstore.config-file=/etc/thanos/objstore.yml
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --label=rule_replica="$(POD_NAME)"
            - --alert.label-drop=rule_replica
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          volumeMounts:
            - name: data
              mountPath: /data
            - name: thanos-objstore-config
              mountPath: /etc/thanos
            - name: rules
              mountPath: /etc/thanos/rules
          ports:
            - containerPort: 10901
              name: grpc
            - containerPort: 10902
              name: http
          resources:
            requests:
              memory: 512Mi
              cpu: 200m
            limits:
              memory: 2Gi
              cpu: "1"
      volumes:
        - name: thanos-objstore-config
          secret:
            secretName: thanos-objstore-config
        - name: rules
          configMap:
            name: thanos-ruler-rules
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 20Gi
```

### Global Recording Rule Example

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-ruler-rules
  namespace: monitoring
data:
  global-rules.yaml: |
    groups:
      - name: global-aggregations
        interval: 1m
        rules:
          - record: cluster:http_requests_total:rate5m
            expr: |
              sum by (cluster, namespace, service) (
                rate(http_requests_total[5m])
              )
          - record: cluster:container_cpu_usage:rate5m
            expr: |
              sum by (cluster, namespace, pod) (
                rate(container_cpu_usage_seconds_total{container!=""}[5m])
              )
      - name: global-alerts
        rules:
          - alert: GlobalHighErrorRate
            expr: |
              sum by (cluster, service) (
                rate(http_requests_total{status=~"5.."}[5m])
              ) /
              sum by (cluster, service) (
                rate(http_requests_total[5m])
              ) > 0.05
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "High error rate on {{ $labels.service }} in cluster {{ $labels.cluster }}"
```

---

## Multi-Cluster Federation with Thanos

### Prometheus Federation vs. Thanos Query Fan-Out

Traditional Prometheus federation pulls metrics from child Prometheus instances into a parent Prometheus. This approach has several limitations:
- Double storage cost
- Stale federation data (scrape interval delay)
- Single point of failure at the parent

With Thanos, each cluster runs its own Prometheus+Sidecar. A central Thanos Querier in a management cluster discovers all sidecars and store gateways across clusters using DNS or file service discovery.

### Cross-Cluster Querier with External Service Discovery

```yaml
args:
  - query
  # Cluster A sidecar (via ExternalName service or cross-cluster load balancer)
  - --store=cluster-a-sidecar.monitoring.svc:10901
  # Cluster B sidecar
  - --store=cluster-b-sidecar.monitoring.svc:10901
  # Shared store gateway
  - --store=thanos-store-gateway.monitoring.svc:10901
```

Each Prometheus must label its metrics with a `cluster` label:

```yaml
# prometheus.yml
global:
  external_labels:
    cluster: cluster-a
    prometheus_replica: $(POD_NAME)
    region: us-east-1
    environment: production
```

---

## Production Sizing Reference

### Component Memory Sizing

| Component | Small (< 1M series) | Medium (1-10M series) | Large (> 10M series) |
|-----------|--------------------|-----------------------|----------------------|
| Prometheus | 4 GB | 16 GB | 64 GB+ |
| Sidecar | 256 MB | 512 MB | 1 GB |
| Querier | 1 GB | 4 GB | 16 GB |
| Query Frontend | 512 MB | 2 GB | 8 GB |
| Store Gateway | 4 GB | 16 GB | 32 GB+ |
| Compactor | 2 GB | 8 GB | 16 GB |
| Ruler | 512 MB | 2 GB | 4 GB |

### Object Storage Sizing

Raw metrics at default 15s scrape interval consume approximately:

```
bytes_per_sample = 2 bytes (Gorilla compression)
samples_per_series_per_day = 86400 / 15 = 5760
daily_storage_GB = (num_series * 5760 * 2) / 1024^3

# Example: 1,000,000 series
daily_storage_GB = (1,000,000 * 5760 * 2) / 1,073,741,824 ≈ 10.7 GB/day
# With 5m downsampling (after 30 days): ~100x compression
# With 1h downsampling (after 90 days): ~1200x compression
```

---

## Alerting Rules for Thanos Health

```yaml
groups:
  - name: thanos-components
    rules:
      - alert: ThanosCompactorNotRunning
        expr: absent(up{job="thanos-compactor"} == 1)
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Thanos Compactor is not running"

      - alert: ThanosStoreGatewayNotReady
        expr: thanos_store_gateway_ready == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Thanos Store Gateway not ready"

      - alert: ThanosQuerierGrpcClientErrorRate
        expr: |
          (
            sum by (job) (rate(grpc_client_handled_total{grpc_code!="OK",job="thanos-querier"}[5m]))
          ) /
          (
            sum by (job) (rate(grpc_client_handled_total{job="thanos-querier"}[5m]))
          ) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Thanos Querier gRPC error rate exceeds 5%"

      - alert: ThanosObjectStorageOperationFailures
        expr: |
          rate(thanos_objstore_operation_failures_total[5m]) > 0
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Object storage operation failures detected"
```

---

## Operational Runbook

### Verify Block Uploads

```bash
# List blocks in object storage
thanos tools bucket ls \
  --objstore.config-file=/etc/thanos/objstore.yml \
  --output=json | jq '.[].meta.ulid'

# Inspect a specific block
thanos tools bucket inspect \
  --objstore.config-file=/etc/thanos/objstore.yml \
  --selector='{cluster="cluster-a"}'
```

### Force Compaction

```bash
# Mark a block for no-compact (e.g., corrupted block)
thanos tools bucket mark \
  --objstore.config-file=/etc/thanos/objstore.yml \
  --id=ULID_OF_BLOCK \
  --marker=no-compact \
  --details="manually marked to skip"

# Verify compaction status
curl -s http://thanos-compactor.monitoring.svc:10902/metrics | \
  grep thanos_compact_group_compactions_total
```

### Query Debugging

```bash
# Check store endpoints seen by Querier
curl -s http://thanos-querier.monitoring.svc:9090/api/v1/stores | jq .

# Test query against Querier with dedup enabled
curl -s "http://thanos-querier.monitoring.svc:9090/api/v1/query?query=up&dedup=true&replicaLabels=prometheus_replica" | \
  jq '.data.result | length'
```

---

## Summary

Thanos transforms Prometheus from a single-cluster, short-retention monitoring tool into a globally federated, object storage-backed metrics platform. The sidecar pattern requires no Prometheus modification, the Compactor handles downsampling and retention enforcement automatically, and the Querier provides a unified query plane across all clusters and time ranges. With the configurations and sizing guidance in this guide, production deployments can reliably handle tens of millions of series with multi-year retention at manageable object storage costs.
