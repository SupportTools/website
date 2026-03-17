---
title: "Kubernetes Prometheus Thanos: Global Query View and Long-Term Metric Retention"
date: 2031-01-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Thanos", "Monitoring", "Observability", "S3", "Multi-Cluster", "Grafana"]
categories:
- Kubernetes
- Monitoring
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Thanos for multi-cluster Prometheus deployments: sidecar vs agent mode, S3/GCS object store configuration, Thanos Query federation, compaction and retention policies, global alerting with Thanos Ruler, and multi-cluster Grafana dashboard architecture."
more_link: "yes"
url: "/kubernetes-prometheus-thanos-global-query-long-term-metric-retention/"
---

Prometheus's single-node architecture provides excellent local observability but creates challenges at scale: no built-in long-term storage, no cross-cluster query capability, and data loss risk during node failure. Thanos addresses all three by adding a thin sidecar to each Prometheus instance that uploads blocks to object storage, then providing a global query layer that federates across all Prometheus instances. This guide covers every Thanos component in production depth: sidecar vs agent deployment modes, S3/GCS object store configuration, query federation and deduplication, compaction policies, global alerting with Ruler, and building multi-cluster Grafana dashboards.

<!--more-->

# Kubernetes Prometheus Thanos: Global Query View and Long-Term Metric Retention

## Thanos Architecture Overview

Thanos is a set of components that extend Prometheus with:

```
┌─────────────────── Cluster A ──────────────────┐
│                                                  │
│  Prometheus ──► Thanos Sidecar ──► Object Store  │
│  (2h local)        (uploads                │    │
│                    2h blocks)              │    │
└────────────────────────────────────────────┼────┘
                                             │
┌─────────────────── Cluster B ──────────────┼────┐
│                                            │    │
│  Prometheus ──► Thanos Sidecar ──► Object Store  │
│                                            │    │
└────────────────────────────────────────────┼────┘
                                             │
                              ┌──────────────▼───────────────┐
                              │         Object Store          │
                              │   (S3 / GCS / Azure Blob)    │
                              │                               │
                              │  /cluster-a/blocks/           │
                              │  /cluster-b/blocks/           │
                              └──────────────┬───────────────┘
                                             │
                              ┌──────────────▼───────────────┐
                              │       Thanos Store            │
                              │  (serves old data from        │
                              │   object store)               │
                              └──────────────┬───────────────┘
                                             │
                              ┌──────────────▼───────────────┐
                              │       Thanos Query            │
                              │  (global query interface,     │
                              │   deduplication, merging)     │
                              └──────────────┬───────────────┘
                                             │
                              ┌──────────────▼───────────────┐
                              │     Thanos Query Frontend     │
                              │  (caching, query splitting)   │
                              └──────────────┬───────────────┘
                                             │
                                         Grafana
```

Additional components:
- **Thanos Compactor**: Downsamples and compacts historical data
- **Thanos Ruler**: Evaluates alerting/recording rules against global view
- **Thanos Receive**: Alternative to sidecar for push-based ingestion

## Installation via kube-prometheus-stack

```bash
# Add Prometheus community helm repo
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Install kube-prometheus-stack with Thanos sidecar enabled
helm install kube-prometheus-stack \
  prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --version 55.0.0 \
  --values prometheus-thanos-values.yaml \
  --wait
```

```yaml
# prometheus-thanos-values.yaml
prometheus:
  prometheusSpec:
    # Prometheus retention (short - Thanos handles long-term)
    retention: 2h
    retentionSize: 10GB

    # Thanos sidecar configuration
    thanos:
      image: quay.io/thanos/thanos:v0.34.0
      version: v0.34.0
      objectStorageConfig:
        existingSecret:
          name: thanos-objstore-config
          key: objstore.yml
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 512Mi

    # External labels identify this Prometheus in the global view
    externalLabels:
      cluster: production-us-east-1
      region: us-east-1
      environment: production

    # Required: enable WAL compression for Thanos
    walCompression: true

    # Storage configuration
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 50Gi

    # Enable Thanos service for Store API
    thanosService:
      enabled: true

    # Service monitor for Thanos sidecar itself
    thanosServiceMonitor:
      enabled: true
```

## Object Store Configuration

### AWS S3

```yaml
# thanos-objstore-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: thanos-objstore-config
  namespace: monitoring
stringData:
  objstore.yml: |
    type: S3
    config:
      bucket: my-thanos-metrics
      region: us-east-1
      # Use IRSA (no access keys needed) on EKS
      # The pod's service account must have IAM permissions
      # If not using IRSA, specify:
      # access_key: <aws-access-key-id>
      # secret_key: <aws-secret-access-key>
      sse_config:
        type: SSE-S3  # Server-side encryption
      # Prefix separates clusters sharing a bucket
      prefix: prometheus-blocks
      # Enable chunking for large uploads
      put_user_metadata:
        "x-amz-storage-class": "STANDARD_IA"  # Cost optimization
```

IAM policy for the Thanos service account:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning"
      ],
      "Resource": "arn:aws:s3:::my-thanos-metrics"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListMultipartUploadParts",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::my-thanos-metrics/*"
    }
  ]
}
```

### GCS Configuration

```yaml
stringData:
  objstore.yml: |
    type: GCS
    config:
      bucket: my-thanos-metrics
      service_account: |
        {
          "type": "service_account",
          "project_id": "my-project",
          "private_key_id": "key-id",
          "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n",
          "client_email": "thanos@my-project.iam.gserviceaccount.com"
        }
      # Or use Workload Identity (no key file needed):
      # service_account: ""  # Empty = use Workload Identity
```

### Azure Blob Storage

```yaml
stringData:
  objstore.yml: |
    type: AZURE
    config:
      storage_account: mythanosmetrics
      storage_account_key: <base64-encoded-storage-key>
      container: prometheus-blocks
      endpoint: blob.core.windows.net
      # Use managed identity instead of key:
      # msi_resource: https://storage.azure.com/
      # user_assigned_id: <msi-client-id>
```

## Thanos Sidecar vs Thanos Agent Mode

### Sidecar Mode (Classic)

The sidecar runs alongside Prometheus and:
- Exposes Prometheus's local data via the Store API
- Uploads completed TSDB blocks to object storage
- Does NOT proxy live queries (< 2h) through itself for upload

```yaml
# Prometheus deployment with sidecar - via kube-prometheus-stack values
# Sidecar is injected automatically when .thanos is configured
# Manual deployment:

apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: prometheus-thanos
spec:
  template:
    spec:
      containers:
      - name: prometheus
        image: prom/prometheus:v2.48.0
        args:
        - --config.file=/etc/prometheus/prometheus.yml
        - --storage.tsdb.path=/prometheus
        - --storage.tsdb.min-block-duration=2h  # Required for Thanos
        - --storage.tsdb.max-block-duration=2h  # Required for Thanos
        - --storage.tsdb.retention.time=2h      # Local retention only
        - --web.enable-lifecycle
        - --web.enable-admin-api

      - name: thanos-sidecar
        image: quay.io/thanos/thanos:v0.34.0
        args:
        - sidecar
        - --log.level=info
        - --prometheus.url=http://localhost:9090
        - --tsdb.path=/prometheus
        - --objstore.config-file=/config/objstore.yml
        - --reloader.config-file=/etc/prometheus/prometheus.yml
        - --reloader.config-envsubst-file=/etc/prometheus/prometheus.yml.expanded
        ports:
        - name: grpc
          containerPort: 10901
        - name: http
          containerPort: 10902
```

### Agent Mode (Kubernetes 1.25+)

Prometheus Agent mode is designed specifically for remote write. Thanos can receive from agents:

```yaml
# prometheus-agent.yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: PrometheusAgent
metadata:
  name: edge-agent
  namespace: monitoring
spec:
  version: v2.48.0
  # Agent mode: no local storage, only remote write
  remoteWrite:
  - url: https://thanos-receive.central-monitoring.svc.cluster.local:19291/api/v1/receive
    headers:
      X-Scope-OrgID: edge-cluster-1
    tlsConfig:
      insecureSkipVerify: false
      caFile: /etc/ssl/certs/ca-certificates.crt
  # External labels for identification
  externalLabels:
    cluster: edge-us-west-2
    env: production
  # Lightweight: no retention needed
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi
```

**When to use Agent mode**:
- Edge clusters with limited resources (Agent uses 50-90% less memory than full Prometheus)
- Air-gapped environments that need to push to central monitoring
- Kubernetes clusters where Thanos sidecar's block upload doesn't make sense
- IoT or small-node deployments

**When to use Sidecar mode**:
- Full-featured Prometheus with local querying needed
- Block-level deduplication required
- Horizontal scalability with separate Prometheus instances per tenant

## Deploying Thanos Query

```yaml
# thanos-query.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-query
  template:
    metadata:
      labels:
        app: thanos-query
    spec:
      containers:
      - name: thanos-query
        image: quay.io/thanos/thanos:v0.34.0
        args:
        - query
        - --log.level=info
        - --log.format=logfmt
        # Deduplication: deduplicate based on these labels
        # Prometheus HA pairs have same metrics, deduplicate by replica label
        - --query.replica-label=prometheus_replica
        - --query.replica-label=replica
        # Query timeout
        - --query.timeout=5m
        # Auto-discover Store API endpoints using DNS
        - --store=dnssrv+_grpc._tcp.kube-prometheus-stack-thanos-discovery.monitoring.svc.cluster.local
        # Store for historical data (Thanos Store gateway)
        - --store=dnssrv+_grpc._tcp.thanos-store.monitoring.svc.cluster.local
        # Also connect to Thanos Ruler if deployed
        - --store=dnssrv+_grpc._tcp.thanos-ruler.monitoring.svc.cluster.local
        # Web UI
        - --web.external-prefix=/thanos
        ports:
        - name: http
          containerPort: 10902
        - name: grpc
          containerPort: 10901
        livenessProbe:
          httpGet:
            path: /-/healthy
            port: http
          initialDelaySeconds: 30
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /-/ready
            port: http
          initialDelaySeconds: 10
          periodSeconds: 15
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 2000m
            memory: 2Gi
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
  - name: http
    port: 10902
    targetPort: http
  - name: grpc
    port: 10901
    targetPort: grpc
```

## Thanos Store: Historical Data Gateway

```yaml
# thanos-store.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-store
  namespace: monitoring
spec:
  replicas: 2  # 2 replicas for HA
  selector:
    matchLabels:
      app: thanos-store
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: gp3
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 100Gi  # Local cache for frequently accessed blocks
  template:
    metadata:
      labels:
        app: thanos-store
    spec:
      containers:
      - name: thanos-store
        image: quay.io/thanos/thanos:v0.34.0
        args:
        - store
        - --log.level=info
        - --data-dir=/data
        - --objstore.config-file=/config/objstore.yml
        # Index cache - cache block indexes in memory for faster queries
        - --index-cache-size=1GB
        # Chunk pool - cache chunks for frequently accessed time ranges
        - --chunk-pool-size=2GB
        # Sync interval - how often to check object store for new blocks
        - --sync-block-duration=3m
        # Filter to reduce memory for large deployments
        # - --min-time=-6w  # Only serve blocks newer than 6 weeks
        ports:
        - name: http
          containerPort: 10902
        - name: grpc
          containerPort: 10901
        volumeMounts:
        - name: data
          mountPath: /data
        - name: objstore-config
          mountPath: /config
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
---
apiVersion: v1
kind: Service
metadata:
  name: thanos-store
  namespace: monitoring
spec:
  selector:
    app: thanos-store
  ports:
  - name: grpc
    port: 10901
    targetPort: grpc
  - name: http
    port: 10902
    targetPort: http
  clusterIP: None  # Headless for DNS discovery
```

## Thanos Compactor: Downsampling and Retention

```yaml
# thanos-compactor.yaml - Single instance (not HA-safe)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-compactor
  namespace: monitoring
spec:
  replicas: 1  # MUST be 1 - compactor is not HA-safe
  selector:
    matchLabels:
      app: thanos-compactor
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: gp3
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 500Gi  # Needs space for compaction work
  template:
    metadata:
      labels:
        app: thanos-compactor
    spec:
      containers:
      - name: thanos-compactor
        image: quay.io/thanos/thanos:v0.34.0
        args:
        - compact
        - --log.level=info
        - --data-dir=/data
        - --objstore.config-file=/config/objstore.yml
        # Wait for this duration before considering blocks for compaction
        - --consistency-delay=30m
        # Retention for raw (5-min resolution) data
        - --retention.resolution-raw=30d
        # Retention for 5-minute downsampled data
        - --retention.resolution-5m=90d
        # Retention for 1-hour downsampled data
        - --retention.resolution-1h=2y
        # Enable downsampling
        - --downsampling.disable=false
        # Compact blocks from all clusters
        - --wait  # Run as daemon (keep checking for work)
        - --wait-interval=5m
        ports:
        - name: http
          containerPort: 10902
        volumeMounts:
        - name: data
          mountPath: /data
        - name: objstore-config
          mountPath: /config
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: 4000m
            memory: 16Gi  # Compaction is memory-intensive
      volumes:
      - name: objstore-config
        secret:
          secretName: thanos-objstore-config
```

### Compaction and Retention Strategy

```
Data flow after Thanos Compactor:

Raw data (5s scrape interval):
  0-30 days: Full resolution in object store
  30+ days: Deleted

5-minute downsampled data:
  0-90 days: Available for medium-range queries
  90+ days: Deleted

1-hour downsampled data:
  0-2 years: Available for long-range historical queries
  2+ years: Deleted

Query behavior:
  Last 24h: Queries served from Prometheus (sidecar) - full resolution
  24h - 30d: Queries served from Store gateway - full resolution
  30d - 90d: Queries served from Store - 5m downsampled
  90d - 2y:  Queries served from Store - 1h downsampled
```

## Thanos Query Frontend: Caching Layer

```yaml
# thanos-query-frontend.yaml
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
        image: quay.io/thanos/thanos:v0.34.0
        args:
        - query-frontend
        - --log.level=info
        - --query-frontend.downstream-url=http://thanos-query:10902
        # Split queries across time to improve cache hit rates
        - --query-range.split-interval=24h
        # Align query time ranges to improve cache hit rates
        - --query-range.align-range-with-step
        # In-memory cache
        - --query-frontend.compress-responses
        # Redis cache (optional, for shared cache across replicas)
        # - --query-range.response-cache-config-file=/config/cache.yml
        ports:
        - name: http
          containerPort: 10902
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 1Gi
```

## Thanos Ruler: Global Alerting

Thanos Ruler evaluates Prometheus rules against the global query view. This enables alerts based on aggregated data across all clusters:

```yaml
# thanos-ruler.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-ruler
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: gp3
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 10Gi
  template:
    metadata:
      labels:
        app: thanos-ruler
    spec:
      containers:
      - name: thanos-ruler
        image: quay.io/thanos/thanos:v0.34.0
        args:
        - rule
        - --log.level=info
        - --data-dir=/data
        - --eval-interval=1m
        # Query endpoint for rule evaluation
        - --query=http://thanos-query:10902
        # Write results to object store and expose via Store API
        - --objstore.config-file=/config/objstore.yml
        # Alert manager endpoints
        - --alertmanagers.url=http://alertmanager-operated:9093
        # External labels for this ruler
        - --label=ruler_cluster=global
        - --label=ruler_replica=$(POD_NAME)
        # Rule files from ConfigMap
        - --rule-file=/etc/thanos-ruler/rules/*.yaml
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        ports:
        - name: http
          containerPort: 10902
        - name: grpc
          containerPort: 10901
        volumeMounts:
        - name: data
          mountPath: /data
        - name: objstore-config
          mountPath: /config
        - name: rules
          mountPath: /etc/thanos-ruler/rules
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 1Gi
      volumes:
      - name: objstore-config
        secret:
          secretName: thanos-objstore-config
      - name: rules
        configMap:
          name: thanos-ruler-rules
```

### Global Alerting Rules

```yaml
# thanos-ruler-rules-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-ruler-rules
  namespace: monitoring
data:
  global-alerts.yaml: |
    groups:
    - name: global_cluster_health
      interval: 1m
      rules:
      # Alert when any cluster has high error rate (global aggregation)
      - alert: GlobalHighErrorRate
        expr: |
          (
            sum by (cluster) (
              rate(http_requests_total{status=~"5.."}[5m])
            )
            /
            sum by (cluster) (
              rate(http_requests_total[5m])
            )
          ) > 0.01
        for: 5m
        labels:
          severity: critical
          scope: global
        annotations:
          summary: "High error rate in cluster {{ $labels.cluster }}"
          description: "Error rate is {{ $value | humanizePercentage }} in {{ $labels.cluster }}"

      # Cross-cluster comparison: alert if one cluster is significantly slower
      - alert: ClusterLatencyAnomaly
        expr: |
          (
            histogram_quantile(0.99,
              sum by (cluster, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )
            /
            avg without (cluster) (
              histogram_quantile(0.99,
                sum by (cluster, le) (
                  rate(http_request_duration_seconds_bucket[5m])
                )
              )
            )
          ) > 3
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Cluster {{ $labels.cluster }} p99 latency is 3x baseline"

      # Fleet-wide disk usage alert
      - alert: FleetwideDiskPressure
        expr: |
          count(
            (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.1
          ) by (cluster) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} nodes in {{ $labels.cluster }} have < 10% disk free"

  global-recordings.yaml: |
    groups:
    - name: global_aggregations
      interval: 5m
      rules:
      # Pre-aggregate request rates across all clusters
      - record: global:http_requests_total:rate5m
        expr: |
          sum by (cluster, service, status) (
            rate(http_requests_total[5m])
          )

      # Pre-aggregate memory usage per cluster
      - record: global:node_memory_used:ratio
        expr: |
          1 - (
            sum by (cluster) (node_memory_MemAvailable_bytes)
            /
            sum by (cluster) (node_memory_MemTotal_bytes)
          )
```

## Multi-Cluster Grafana Dashboard Architecture

### Grafana Data Source Configuration

```yaml
# grafana-thanos-datasource.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  thanos.yaml: |
    apiVersion: 1
    datasources:
    # Global view via Thanos Query Frontend
    - name: Thanos
      type: prometheus
      url: http://thanos-query-frontend:10902
      access: proxy
      isDefault: true
      jsonData:
        timeInterval: "5m"
        queryTimeout: "300s"
        httpMethod: POST
        # Enable exemplars
        exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: jaeger
      uid: thanos

    # Per-cluster data sources (for cluster-specific dashboards)
    - name: Prometheus-US-East-1
      type: prometheus
      url: http://prometheus-operated.monitoring.svc:9090
      access: proxy
      jsonData:
        timeInterval: "15s"  # Match scrape interval
      uid: prometheus-us-east-1
```

### Dashboard with Multi-Cluster Variables

```json
{
  "title": "Multi-Cluster Overview",
  "uid": "multi-cluster-overview",
  "templating": {
    "list": [
      {
        "name": "cluster",
        "type": "query",
        "datasource": "Thanos",
        "query": "label_values(up, cluster)",
        "multi": true,
        "includeAll": true,
        "allValue": ".*",
        "current": {"text": "All", "value": "$__all"}
      },
      {
        "name": "namespace",
        "type": "query",
        "datasource": "Thanos",
        "query": "label_values(kube_namespace_labels{cluster=~\"$cluster\"}, namespace)",
        "multi": true,
        "includeAll": true
      }
    ]
  },
  "panels": [
    {
      "title": "Request Rate by Cluster",
      "type": "timeseries",
      "targets": [
        {
          "datasource": "Thanos",
          "expr": "sum by (cluster) (global:http_requests_total:rate5m{cluster=~\"$cluster\"})",
          "legendFormat": "{{cluster}}"
        }
      ]
    },
    {
      "title": "Error Rate Heatmap",
      "type": "heatmap",
      "targets": [
        {
          "datasource": "Thanos",
          "expr": "sum by (cluster, le) (rate(http_request_duration_seconds_bucket{cluster=~\"$cluster\"}[5m]))",
          "format": "heatmap"
        }
      ]
    }
  ]
}
```

## Performance Tuning

### Thanos Query Optimization

```yaml
# For large deployments, tune Thanos Query:
args:
- query
# Limit max concurrent queries to prevent memory exhaustion
- --query.max-concurrent=20
# Set maximum samples per query
- --query.max-samples=50000000
# Enable partial responses (return data from available stores even if some are down)
- --query.partial-response
# Look back threshold for instant queries
- --query.lookback-delta=5m
# Timeout per store request
- --store.timeout=5m
```

### Store Gateway Sharding

For very large object stores, shard the Store gateway by time:

```yaml
# Store gateway 1: Recent data (last 6 months)
args:
- store
- --min-time=-6m
- --max-time=-0d
- ...

# Store gateway 2: Historical data (6 months to 2 years)
args:
- store
- --min-time=-2y
- --max-time=-6m
- ...
```

## Monitoring Thanos Itself

```yaml
# PrometheusRule for Thanos health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: thanos-alerts
  namespace: monitoring
spec:
  groups:
  - name: thanos.query
    rules:
    - alert: ThanosQueryHighErrorRate
      expr: |
        (sum(rate(thanos_query_completed_requests_total{result="error"}[5m]))
        /
        sum(rate(thanos_query_completed_requests_total[5m])))
        > 0.01
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Thanos Query error rate above 1%"

    - alert: ThanosQueryStoreAPIHighErrorRate
      expr: |
        (sum by (grpc_server_method) (rate(grpc_server_handled_total{grpc_code!="OK",grpc_code!="Canceled",grpc_code!="DeadlineExceeded",job=~".*thanos.*"}[5m]))
        /
        sum by (grpc_server_method) (rate(grpc_server_started_total{job=~".*thanos.*"}[5m])))
        > 0.05
      for: 5m
      labels:
        severity: warning

  - name: thanos.store
    rules:
    - alert: ThanosStoreGatewayObjectStoreLag
      expr: |
        (time() - max(thanos_bucket_store_blocks_last_sync_time)) > 600
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Thanos Store not syncing from object store"

  - name: thanos.compact
    rules:
    - alert: ThanosCompactorHalted
      expr: |
        thanos_compact_halted == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Thanos Compactor has halted - compaction is not running"

    - alert: ThanosCompactorRetentionPolicyFailing
      expr: |
        rate(thanos_compact_group_vertical_compactions_total[5m]) == 0
        AND
        thanos_compact_halted == 0
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Thanos Compactor not performing compactions"
```

## Conclusion

Thanos transforms Prometheus from a single-node monitoring tool into a globally scalable observability platform:

1. **Sidecar vs Agent**: Use sidecar mode for full Prometheus deployments with local querying; agent mode for resource-constrained edge clusters that push to central collection via Thanos Receive
2. **Object store**: S3/GCS with IRSA/Workload Identity provides zero-credential-rotation storage; use STANDARD_IA storage class for cost optimization on historical data
3. **Compaction and downsampling**: Configure Compactor with `--retention.resolution-raw=30d`, `--retention.resolution-5m=90d`, `--retention.resolution-1h=2y` for a balanced cost/query-capability trade-off
4. **Query Frontend**: Place between Grafana and Thanos Query; enables query result caching and time-range splitting that dramatically reduces Query load for dashboard queries
5. **Thanos Ruler**: Essential for global alerting that aggregates across clusters; configure with HA (2 replicas) and deduplicate alerts in Alertmanager
6. **Store Gateway sharding**: For object stores with years of history, shard Store gateways by time range to distribute memory and query load

The total operational cost for a Thanos deployment serving 100+ Prometheus instances at 1M+ active series each is dominated by S3 storage (approximately $50-200/month) and Store gateway memory (4-8GB per instance). Query latency for recent data (< 24h) is sub-second; for 1-year-old data it's typically 5-30 seconds depending on the number of blocks involved.
