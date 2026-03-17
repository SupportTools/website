---
title: "VictoriaMetrics Cluster Mode: High-Availability Metrics Storage at Petabyte Scale"
date: 2030-08-12T00:00:00-05:00
draft: false
tags: ["VictoriaMetrics", "Prometheus", "Monitoring", "Kubernetes", "Observability", "Time Series", "High Availability"]
categories:
- Monitoring
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise VictoriaMetrics cluster deployment guide covering vminsert/vmselect/vmstorage architecture, replication factors, retention policies, vmbackup/vmrestore workflows, multi-tenancy, and migration strategies from Thanos or Cortex."
more_link: "yes"
url: "/victoriametrics-cluster-mode-high-availability-petabyte-scale/"
---

VictoriaMetrics cluster mode delivers horizontally scalable, high-availability metrics storage capable of ingesting millions of data points per second while retaining petabytes of time series data. Unlike single-node VictoriaMetrics, the cluster topology separates ingestion, query, and storage into independent components that scale independently, making it the right choice when single-node capacity or availability requirements have been exhausted.

<!--more-->

## Architecture Overview

VictoriaMetrics cluster consists of three stateless or stateful components that communicate over internal HTTP APIs.

### vminsert

`vminsert` accepts incoming metrics over Prometheus remote_write, InfluxDB line protocol, OpenTSDB, Graphite, and Datadog agent protocols. It is stateless and can be scaled horizontally without coordination. vminsert shards incoming data across all available vmstorage nodes using a consistent hash of the metric name plus labels.

### vmselect

`vmselect` processes PromQL and MetricsQL queries by fanning out sub-queries to all vmstorage nodes, merging results, and returning them to the caller. It is also stateless and scales horizontally. vmselect exposes a Prometheus-compatible HTTP API and a native VictoriaMetrics query API.

### vmstorage

`vmstorage` is the only stateful component. It persists raw samples on disk using VictoriaMetrics' compressed columnar storage format. Each vmstorage node owns a shard of the dataset determined by the consistent hash applied at vminsert. vmstorage nodes do not communicate with each other, which simplifies horizontal scaling but requires careful replication configuration to achieve HA.

### Component Interaction Diagram

```
Prometheus / Agent
       |
       v
  vminsert (stateless, N replicas)
       |  consistent hash sharding
  +----+----+
  |         |
vmstorage-0  vmstorage-1  vmstorage-2 ...
       |
  vmselect (stateless, N replicas)
       |
  Grafana / API consumers
```

---

## Kubernetes Deployment

### Namespace and RBAC

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    app.kubernetes.io/managed-by: helm
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: victoriametrics
  namespace: monitoring
```

### vmstorage StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: vmstorage
  namespace: monitoring
  labels:
    app: vmstorage
spec:
  serviceName: vmstorage-headless
  replicas: 3
  selector:
    matchLabels:
      app: vmstorage
  template:
    metadata:
      labels:
        app: vmstorage
    spec:
      serviceAccountName: victoriametrics
      terminationGracePeriodSeconds: 120
      containers:
        - name: vmstorage
          image: victoriametrics/vmstorage:v1.101.0-cluster
          args:
            - -storageDataPath=/vm-data
            - -retentionPeriod=12
            - -dedup.minScrapeInterval=15s
            - -storage.minFreeDiskSpaceBytes=1073741824
            - -loggerLevel=INFO
          ports:
            - name: http
              containerPort: 8482
            - name: vminsert
              containerPort: 8400
            - name: vmselect
              containerPort: 8401
          volumeMounts:
            - name: vm-data
              mountPath: /vm-data
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "8"
              memory: 16Gi
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 30
            periodSeconds: 30
  volumeClaimTemplates:
    - metadata:
        name: vm-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 500Gi
```

### vmstorage Headless Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: vmstorage-headless
  namespace: monitoring
spec:
  clusterIP: None
  selector:
    app: vmstorage
  ports:
    - name: http
      port: 8482
    - name: vminsert
      port: 8400
    - name: vmselect
      port: 8401
```

### vminsert Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vminsert
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app: vminsert
  template:
    metadata:
      labels:
        app: vminsert
    spec:
      containers:
        - name: vminsert
          image: victoriametrics/vminsert:v1.101.0-cluster
          args:
            - -storageNode=vmstorage-0.vmstorage-headless.monitoring.svc.cluster.local:8400
            - -storageNode=vmstorage-1.vmstorage-headless.monitoring.svc.cluster.local:8400
            - -storageNode=vmstorage-2.vmstorage-headless.monitoring.svc.cluster.local:8400
            - -replicationFactor=2
            - -maxLabelsPerTimeseries=40
            - -maxLabelValueLen=1024
            - -loggerLevel=INFO
          ports:
            - name: http
              containerPort: 8480
          resources:
            requests:
              cpu: "1"
              memory: 1Gi
            limits:
              cpu: "4"
              memory: 4Gi
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: vminsert
  namespace: monitoring
spec:
  selector:
    app: vminsert
  ports:
    - name: http
      port: 8480
      targetPort: 8480
```

### vmselect Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmselect
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app: vmselect
  template:
    metadata:
      labels:
        app: vmselect
    spec:
      containers:
        - name: vmselect
          image: victoriametrics/vmselect:v1.101.0-cluster
          args:
            - -storageNode=vmstorage-0.vmstorage-headless.monitoring.svc.cluster.local:8401
            - -storageNode=vmstorage-1.vmstorage-headless.monitoring.svc.cluster.local:8401
            - -storageNode=vmstorage-2.vmstorage-headless.monitoring.svc.cluster.local:8401
            - -dedup.minScrapeInterval=15s
            - -replicationFactor=2
            - -search.maxQueryLen=16384
            - -search.maxConcurrentRequests=16
            - -loggerLevel=INFO
          ports:
            - name: http
              containerPort: 8481
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "4"
              memory: 8Gi
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: vmselect
  namespace: monitoring
spec:
  selector:
    app: vmselect
  ports:
    - name: http
      port: 8481
      targetPort: 8481
```

---

## Replication Factor Configuration

The `-replicationFactor` flag on both vminsert and vmselect controls how many vmstorage nodes receive a copy of each ingested data point.

### Replication Factor Trade-offs

| Replication Factor | Storage Overhead | Fault Tolerance | Write Amplification |
|---|---|---|---|
| 1 | 1x | 0 node failures | Low |
| 2 | 2x | 1 node failure | Medium |
| 3 | 3x | 2 node failures (quorum reads) | High |

For most enterprise deployments a replication factor of 2 provides the right balance. With three vmstorage nodes and replication factor 2, any single node can be taken offline for maintenance or fail without data loss. vmselect uses the replication factor to perform deduplication — when the same data point exists on multiple storage nodes, it returns only one copy.

### Setting Deduplication Interval

The `-dedup.minScrapeInterval` flag controls the deduplication window. Set it to match or slightly exceed the scrape interval of the Prometheus agents feeding into vminsert:

```bash
# For 15s scrape intervals
-dedup.minScrapeInterval=15s

# For 30s scrape intervals
-dedup.minScrapeInterval=30s
```

Both vminsert and vmselect must use the same value for correct deduplication behavior.

---

## Retention Policies

VictoriaMetrics supports per-tenant and global retention policies.

### Global Retention

The `-retentionPeriod` flag on vmstorage accepts values in months (integer) or duration strings:

```bash
# 12 months (1 year) retention
-retentionPeriod=12

# 18 months
-retentionPeriod=18

# 3 months (short-term metrics)
-retentionPeriod=3
```

### Per-Tenant Retention in Multi-Tenant Mode

VictoriaMetrics cluster supports multi-tenancy through URL path prefixes. Each tenant ID maps to an isolated namespace in vmstorage. Per-tenant retention requires the enterprise version and is configured via a separate retention configuration file:

```yaml
# vm-retention-config.yaml
perTenantConfig:
  - tenantID: "1"
    retentionPeriod: "24"   # 24 months for compliance tenant
  - tenantID: "2"
    retentionPeriod: "3"    # 3 months for short-lived metrics
  - tenantID: "0"
    retentionPeriod: "12"   # default 12 months
```

Pass the path to vmstorage:

```bash
-retentionPeriodByTenant=/etc/vm/retention-config.yaml
```

### Downsampling for Long-Term Storage

For metrics retained beyond 6 months, downsampling reduces storage footprint without sacrificing trend visibility:

```bash
# Enable downsampling on vmstorage
-downsampling.period=30d:5m,180d:1h
```

This configuration downsamples data older than 30 days to 5-minute resolution and data older than 180 days to 1-hour resolution.

---

## Multi-Tenancy Architecture

VictoriaMetrics cluster separates tenant data by embedding the tenant ID in the HTTP path.

### Tenant URL Format

```
# Ingest (vminsert)
http://vminsert:8480/insert/<tenantID>/prometheus/api/v1/write

# Query (vmselect)
http://vmselect:8481/select/<tenantID>/prometheus/api/v1/query_range
```

### Prometheus Remote Write Configuration per Tenant

```yaml
# prometheus-team-a.yaml
remote_write:
  - url: http://vminsert.monitoring.svc.cluster.local:8480/insert/1/prometheus/api/v1/write
    queue_config:
      capacity: 10000
      max_shards: 10
      max_samples_per_send: 5000
      batch_send_deadline: 5s

# prometheus-team-b.yaml
remote_write:
  - url: http://vminsert.monitoring.svc.cluster.local:8480/insert/2/prometheus/api/v1/write
    queue_config:
      capacity: 10000
      max_shards: 10
      max_samples_per_send: 5000
      batch_send_deadline: 5s
```

### Grafana Datasource per Tenant

```yaml
apiVersion: 1
datasources:
  - name: VictoriaMetrics-Team-A
    type: prometheus
    url: http://vmselect.monitoring.svc.cluster.local:8481/select/1/prometheus
    access: proxy
    isDefault: false

  - name: VictoriaMetrics-Team-B
    type: prometheus
    url: http://vmselect.monitoring.svc.cluster.local:8481/select/2/prometheus
    access: proxy
    isDefault: false
```

---

## vmbackup and vmrestore

### vmbackup Architecture

vmbackup creates consistent, incremental snapshots of vmstorage data. It integrates with S3-compatible object storage, GCS, and Azure Blob Storage. Snapshots are taken without stopping vmstorage — vmbackup calls the vmstorage snapshot API to create a consistent point-in-time copy before uploading.

### Snapshot Creation via API

```bash
# Create a snapshot on each vmstorage node
curl -X POST http://vmstorage-0:8482/snapshot/create
# Returns: {"snapshotName":"20240812T143022-0C3FD19A22498CF0"}

curl -X POST http://vmstorage-1:8482/snapshot/create
curl -X POST http://vmstorage-2:8482/snapshot/create
```

### vmbackup Kubernetes CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vmbackup
  namespace: monitoring
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: vmbackup
              image: victoriametrics/vmbackup:v1.101.0-cluster
              args:
                - -storageDataPath=/vm-data
                - -snapshot.createURL=http://vmstorage-0.vmstorage-headless.monitoring.svc.cluster.local:8482/snapshot/create
                - -dst=s3://my-metrics-backups/vmstorage-0/$(date +%Y-%m-%d)
                - -loggerLevel=INFO
              env:
                - name: AWS_REGION
                  value: us-east-1
              volumeMounts:
                - name: vm-data
                  mountPath: /vm-data
                  readOnly: true
          volumes:
            - name: vm-data
              persistentVolumeClaim:
                claimName: vm-data-vmstorage-0
```

### vmrestore Procedure

To restore a vmstorage node from backup:

```bash
# Stop vmstorage
kubectl scale statefulset vmstorage --replicas=0 -n monitoring

# Run vmrestore as a Job
cat <<'EOF' | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: vmrestore
  namespace: monitoring
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: vmrestore
          image: victoriametrics/vmrestore:v1.101.0-cluster
          args:
            - -src=s3://my-metrics-backups/vmstorage-0/2030-08-10
            - -storageDataPath=/vm-data
          env:
            - name: AWS_REGION
              value: us-east-1
          volumeMounts:
            - name: vm-data
              mountPath: /vm-data
      volumes:
        - name: vm-data
          persistentVolumeClaim:
            claimName: vm-data-vmstorage-0
EOF

# Wait for restore to complete
kubectl wait --for=condition=complete job/vmrestore -n monitoring --timeout=3600s

# Resume vmstorage
kubectl scale statefulset vmstorage --replicas=3 -n monitoring
```

---

## Migration from Thanos or Cortex

### Why Migrate

Thanos and Cortex solve the same problem — long-term, HA Prometheus storage — but VictoriaMetrics cluster offers:

- Significantly lower memory footprint (typically 5–10x less RAM per node)
- Higher ingest throughput on equivalent hardware
- Simpler operational model (no compactor, querier, store gateway separation as distinct binaries to manage)
- Native MetricsQL with improved query performance

### Migration Strategy: Dual-Write Period

The recommended migration approach is a dual-write period where Prometheus agents write to both the existing Thanos/Cortex cluster and the new VictoriaMetrics cluster simultaneously.

```yaml
# prometheus-during-migration.yaml
remote_write:
  # Existing Thanos receiver
  - url: http://thanos-receive.thanos.svc.cluster.local:19291/api/v1/receive
    queue_config:
      max_shards: 10

  # New VictoriaMetrics cluster
  - url: http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write
    queue_config:
      max_shards: 10
```

Run dual-write for at least 30 days to accumulate sufficient historical data in VictoriaMetrics before cutting over Grafana datasources.

### Migrating Historical Data with vmctl

vmctl can replay historical data from a Thanos S3 bucket into VictoriaMetrics:

```bash
vmctl thanos \
  --thanos-object-path=s3://thanos-bucket/tenant-a \
  --vm-addr=http://vminsert.monitoring.svc.cluster.local:8480/insert/1/prometheus \
  --vm-concurrency=4 \
  --vm-batch-size=10000 \
  --aws-region=us-east-1 \
  --log-level=INFO \
  2>&1 | tee /var/log/vmctl-migration.log
```

For Cortex, use the `vmctl cortex` subcommand pointing at the Cortex admin API.

### Cutover Checklist

```bash
# 1. Verify data parity between Thanos and VictoriaMetrics
vmctl verify \
  --source-addr=http://thanos-querier.thanos.svc.cluster.local:9090 \
  --dest-addr=http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus \
  --query='up' \
  --from=2030-07-01T00:00:00Z \
  --to=2030-08-01T00:00:00Z

# 2. Update Grafana datasources to point to vmselect
# 3. Remove Thanos/Cortex from Prometheus remote_write
# 4. Scale down Thanos/Cortex after validation period
```

---

## Scaling Guidelines

### vmstorage Sizing

Per-node sizing depends on active time series count and retention period. A conservative baseline:

| Active Time Series | Recommended RAM | Disk (12mo retention) | vCPUs |
|---|---|---|---|
| 1 million | 4 GB | 200 GB | 2 |
| 10 million | 20 GB | 2 TB | 8 |
| 100 million | 160 GB | 20 TB | 32 |

The on-disk size estimate uses VictoriaMetrics' typical compression ratio of approximately 0.4–0.8 bytes per data point for real-world workloads.

### Horizontal Scaling of vmstorage

To add a fourth vmstorage node to an existing three-node cluster:

```bash
# Scale the StatefulSet
kubectl scale statefulset vmstorage --replicas=4 -n monitoring

# Update vminsert and vmselect args to include new storage node
# This is best managed via Helm values or a ConfigMap mounted as args
kubectl set env deployment/vminsert \
  STORAGE_NODES="vmstorage-0.vmstorage-headless.monitoring.svc.cluster.local:8400,vmstorage-1.vmstorage-headless.monitoring.svc.cluster.local:8400,vmstorage-2.vmstorage-headless.monitoring.svc.cluster.local:8400,vmstorage-3.vmstorage-headless.monitoring.svc.cluster.local:8400"
```

Note: Adding vmstorage nodes does not automatically rebalance existing data. New data will be distributed across all nodes according to the consistent hash. Historical data remains on the original nodes until they are either queried (vmselect fans out to all nodes) or explicitly rebalanced using vmctl.

---

## Monitoring VictoriaMetrics Cluster

VictoriaMetrics components expose Prometheus-compatible metrics on their `/metrics` endpoints.

### Key Metrics to Alert On

```yaml
# vmstorage disk space
- alert: VMStorageDiskSpaceLow
  expr: vm_free_disk_space_bytes / vm_data_size_bytes < 0.15
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "vmstorage node {{ $labels.instance }} has less than 15% free disk"

# vminsert queue depth
- alert: VMInsertQueueDepthHigh
  expr: vm_rpc_rows_dropped_total > 0
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "vminsert is dropping rows on {{ $labels.instance }}"

# vmstorage availability
- alert: VMStorageNodeDown
  expr: up{job="vmstorage"} == 0
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "vmstorage node {{ $labels.instance }} is down"
```

### ServiceMonitor for Prometheus Operator

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: victoriametrics-cluster
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: victoriametrics
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

---

## Performance Tuning

### vmstorage I/O Tuning

VictoriaMetrics performs well on NVMe SSDs. For spinning disks or network-attached storage, adjust merge behavior:

```bash
# Reduce concurrent merges on slow storage
-smallMergeConcurrency=2
-bigMergeConcurrency=1
```

### vminsert Batch Size Tuning

For high-throughput ingest environments, increase the internal send buffer:

```bash
-rpc.disableCompression=false
-maxInsertRequestSize=33554432  # 32MB max request body
```

### vmselect Query Timeout

Set aggressive timeouts on vmselect to prevent runaway queries from consuming all resources:

```bash
-search.maxQueryDuration=60s
-search.maxConcurrentRequests=24
-search.maxSamplesPerQuery=1000000000
```

---

## Conclusion

VictoriaMetrics cluster mode provides a pragmatic path to petabyte-scale metrics storage without the operational complexity of Thanos or Cortex. The three-component architecture separates concerns cleanly, each component scales independently, and the operational surface — backup, restore, replication, multi-tenancy — is well-covered by the official tooling. Teams migrating from Prometheus single-node or from heavier distributed solutions consistently find VictoriaMetrics cluster to be the right trade-off between capability and operational overhead for enterprise observability platforms.
