---
title: "Kubernetes Multi-Cluster Observability: Federated Metrics with Thanos and Unified Dashboards"
date: 2031-09-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Thanos", "Prometheus", "Observability", "Multi-Cluster", "Grafana", "Federation"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Build a production multi-cluster observability platform using Thanos for long-term metrics storage and global query, with unified Grafana dashboards, cross-cluster alerting, and object storage backends."
more_link: "yes"
url: "/kubernetes-multi-cluster-observability-thanos-federated-metrics-dashboards/"
---

Operating five Kubernetes clusters across three cloud regions means five separate Prometheus instances, five separate Grafana instances, and no way to answer "what was the cluster-wide p99 latency last Tuesday?" without manually switching dashboards. Thanos solves this by adding a global query layer, long-term storage in object storage, and unlimited retention — without replacing your existing Prometheus deployments.

<!--more-->

# Kubernetes Multi-Cluster Observability: Federated Metrics with Thanos and Unified Dashboards

## Thanos Architecture Overview

Thanos augments Prometheus with a set of components that bolt on to existing deployments:

```
  Cluster: us-east-1          Cluster: eu-west-1          Cluster: ap-south-1
  ┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
  │ Prometheus           │     │ Prometheus           │     │ Prometheus           │
  │ + Thanos Sidecar    │     │ + Thanos Sidecar    │     │ + Thanos Sidecar    │
  └──────────┬──────────┘     └──────────┬──────────┘     └──────────┬──────────┘
             │                           │                           │
             │ TSDB blocks               │ TSDB blocks               │
             ▼                           ▼                           ▼
       ┌─────────┐                 ┌─────────┐                 ┌─────────┐
       │  S3     │                 │  S3     │                 │  GCS    │
       │  us-east│                 │  eu-west│                 │ ap-south│
       └────┬────┘                 └────┬────┘                 └────┬────┘
            │                          │                           │
            └──────────────────────────┼───────────────────────────┘
                                       │
                              ┌────────┴────────┐
                              │  Observability   │
                              │  Cluster         │
                              │                  │
                              │  Thanos Store    │  (reads S3/GCS)
                              │  Thanos Query    │  (global PromQL)
                              │  Thanos Ruler    │  (global alerting)
                              │  Thanos Compactor│  (downsampling)
                              │  Grafana         │  (unified dashboards)
                              └─────────────────┘
```

**Thanos Sidecar**: Runs next to Prometheus. Uploads completed 2-hour TSDB blocks to object storage and exposes Prometheus's data via gRPC for recent data.

**Thanos Store**: Reads historical blocks from object storage. Provides the same gRPC API as the sidecar, making old data queryable.

**Thanos Query**: The global PromQL engine. Fans queries out to all sidecars and store gateways, deduplicates replica data, and merges results.

**Thanos Compactor**: Runs out-of-band to compact small blocks, apply retention, and create downsampled blocks (5-minute and 1-hour resolution) for long-range queries.

**Thanos Ruler**: Evaluates recording rules and alerting rules against the global query layer — enables cross-cluster alerts.

## Per-Cluster Setup: Prometheus with Thanos Sidecar

### Prerequisites: Object Storage Bucket

```bash
# Create S3 bucket for us-east-1 cluster
aws s3 mb s3://thanos-metrics-us-east-1 --region us-east-1
aws s3api put-bucket-versioning \
  --bucket thanos-metrics-us-east-1 \
  --versioning-configuration Status=Suspended

# Configure lifecycle: delete raw blocks after 90 days
# (Compactor will create downsampled blocks for longer retention)
aws s3api put-bucket-lifecycle-configuration \
  --bucket thanos-metrics-us-east-1 \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "delete-raw-blocks",
      "Status": "Enabled",
      "Prefix": "",
      "Expiration": {"Days": 90}
    }]
  }'
```

### Object Storage Secret

```yaml
# In each cluster: create the object storage configuration secret
apiVersion: v1
kind: Secret
metadata:
  name: thanos-objstore-config
  namespace: monitoring
type: Opaque
stringData:
  objstore.yml: |
    type: S3
    config:
      bucket: thanos-metrics-us-east-1
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      # Use IAM role (IRSA/Workload Identity) — avoid static credentials
      # access_key: <aws-access-key-id>
      # secret_key: <aws-secret-access-key>
      sse_config:
        type: SSE-S3
```

For GKE with Workload Identity or EKS with IRSA:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: thanos-sidecar
  namespace: monitoring
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<account-id>:role/thanos-s3-access
```

### Prometheus with Sidecar (kube-prometheus-stack)

```yaml
# values-monitoring.yaml (per-cluster Helm values)
prometheus:
  prometheusSpec:
    # Retain 2 hours in memory — Thanos uploads to S3 every 2 hours
    retention: 2h
    retentionSize: ""

    # External labels uniquely identify this cluster's data
    externalLabels:
      cluster: us-east-1-production
      region: us-east-1
      environment: production

    # Disable default federation (Thanos handles it)
    remoteWrite: []

    # Thanos sidecar
    thanos:
      baseImage: quay.io/thanos/thanos
      version: v0.35.1
      objectStorageConfig:
        existingSecret:
          name: thanos-objstore-config
          key: objstore.yml

    # Enable Thanos gRPC endpoint
    serviceMonitor:
      enabled: true

  thanosServiceExternal:
    enabled: true
    type: ClusterIP
    grpc:
      port: 10901

  # Storage for Prometheus WAL (must be large enough for 2h retention + compaction)
  storageSpec:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
```

## Observability Cluster: Thanos Components

Deploy all Thanos query-side components in a dedicated cluster or namespace.

### Thanos Store Gateway

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-store
  namespace: thanos
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-store
  serviceName: thanos-store
  template:
    metadata:
      labels:
        app: thanos-store
    spec:
      serviceAccountName: thanos-store   # Must have S3/GCS read access
      containers:
        - name: thanos-store
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - store
            - --log.level=info
            - --data-dir=/data
            - --objstore.config-file=/etc/thanos/objstore.yml
            - --index-cache-size=2GB
            - --chunk-pool-size=4GB
            - --store.grpc-series-max-concurrency=20
            - --block-sync-concurrency=20
          ports:
            - containerPort: 10901
              name: grpc
            - containerPort: 10902
              name: http
          resources:
            requests:
              cpu: 500m
              memory: 4Gi
            limits:
              cpu: 4000m
              memory: 16Gi
          volumeMounts:
            - name: data
              mountPath: /data
            - name: objstore-config
              mountPath: /etc/thanos
              readOnly: true
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 10902
            initialDelaySeconds: 30
      volumes:
        - name: objstore-config
          secret:
            secretName: thanos-objstore-config-global  # Multi-region config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        storageClassName: standard
        resources:
          requests:
            storage: 100Gi
```

### Multi-Bucket Store Configuration

For multiple clusters with separate buckets, use a multi-configuration:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: thanos-objstore-config-global
  namespace: thanos
stringData:
  objstore.yml: |
    type: S3
    config:
      # Primary bucket — use bucket prefix per cluster
      bucket: thanos-metrics-global
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
```

Or run separate Store instances per bucket:

```bash
# Store for us-east-1
kubectl apply -f thanos-store-us-east-1.yaml

# Store for eu-west-1
kubectl apply -f thanos-store-eu-west-1.yaml

# Store for ap-south-1
kubectl apply -f thanos-store-ap-south-1.yaml
```

### Thanos Query (Global PromQL)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
  namespace: thanos
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
      containers:
        - name: thanos-query
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - query
            - --log.level=info
            - --query.replica-label=prometheus_replica   # Deduplicate HA Prometheus pairs
            - --query.replica-label=replica
            - --query.auto-downsampling                  # Use lower resolution for long ranges
            - --query.partial-response                   # Return partial results if some stores fail
            # Sidecar endpoints (recent data from each cluster)
            - --store=dnssrv+_grpc._tcp.thanos-sidecar-us-east-1.monitoring.svc.cluster.local
            - --store=dnssrv+_grpc._tcp.thanos-sidecar-eu-west-1.monitoring.svc.cluster.local
            - --store=dnssrv+_grpc._tcp.thanos-sidecar-ap-south-1.monitoring.svc.cluster.local
            # Store gateway endpoints (historical data)
            - --store=dnssrv+_grpc._tcp.thanos-store.thanos.svc.cluster.local
            # Ruler endpoint (recording rules as metrics)
            - --store=dnssrv+_grpc._tcp.thanos-ruler.thanos.svc.cluster.local
          ports:
            - containerPort: 10904
              name: grpc
            - containerPort: 10902
              name: http
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 10902
            initialDelaySeconds: 15
```

### Thanos Compactor

The Compactor MUST run as a single instance (not replicated) to avoid concurrent compaction conflicts:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-compactor
  namespace: thanos
spec:
  replicas: 1    # NEVER scale above 1
  selector:
    matchLabels:
      app: thanos-compactor
  serviceName: thanos-compactor
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
            - --objstore.config-file=/etc/thanos/objstore.yml
            - --wait                               # Run continuously
            - --wait-interval=5m
            - --consistency-delay=30m             # Wait for all sidecars to upload
            - --retention.resolution-raw=90d      # Keep raw data 90 days
            - --retention.resolution-5m=180d      # Keep 5-min downsampled 180 days
            - --retention.resolution-1h=365d      # Keep 1-hour downsampled 1 year
            - --compact.concurrency=4
            - --downsample.concurrency=4
          resources:
            requests:
              cpu: 500m
              memory: 2Gi
            limits:
              cpu: 4000m
              memory: 16Gi
          volumeMounts:
            - name: data
              mountPath: /data
            - name: objstore-config
              mountPath: /etc/thanos
      volumes:
        - name: objstore-config
          secret:
            secretName: thanos-objstore-config-global
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        storageClassName: standard
        resources:
          requests:
            storage: 200Gi  # Needs space for decompression during compaction
```

### Thanos Ruler (Global Alerting)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-ruler
  namespace: thanos
spec:
  replicas: 2   # HA pair
  selector:
    matchLabels:
      app: thanos-ruler
  serviceName: thanos-ruler
  template:
    metadata:
      labels:
        app: thanos-ruler
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
            - --objstore.config-file=/etc/thanos/objstore.yml
            - --query=dnssrv+_http._tcp.thanos-query.thanos.svc.cluster.local
            - --label=ruler_cluster="observability"
            - --label=replica="$(POD_NAME)"
            - --alertmanagers.url=http://alertmanager-operated.monitoring.svc.cluster.local:9093
            - --alertmanager.send-timeout=30s
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          volumeMounts:
            - name: rules
              mountPath: /etc/thanos/rules
            - name: objstore-config
              mountPath: /etc/thanos
            - name: data
              mountPath: /data
      volumes:
        - name: rules
          configMap:
            name: thanos-ruler-rules
        - name: objstore-config
          secret:
            secretName: thanos-objstore-config-global
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        resources:
          requests:
            storage: 10Gi
```

### Global Alerting Rules

```yaml
# ConfigMap: cross-cluster alerting rules
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-ruler-rules
  namespace: thanos
data:
  cluster-alerts.yaml: |
    groups:
      - name: cross-cluster
        interval: 1m
        rules:
          # Alert if any cluster's API server has > 1% error rate
          - alert: ClusterAPIServerHighErrorRate
            expr: |
              sum by (cluster, region) (
                rate(apiserver_request_total{code=~"5.."}[5m])
              ) / sum by (cluster, region) (
                rate(apiserver_request_total[5m])
              ) > 0.01
            for: 5m
            labels:
              severity: critical
              team: platform
            annotations:
              summary: "API server error rate > 1% in {{ $labels.cluster }}"
              description: "{{ $labels.cluster }} API server: {{ $value | humanizePercentage }} errors/sec"

          # Alert if any cluster is out of schedulable capacity
          - alert: ClusterLowSchedulableMemory
            expr: |
              sum by (cluster) (
                kube_node_status_allocatable{resource="memory"}
              ) - sum by (cluster) (
                kube_pod_container_resource_requests{resource="memory"}
              ) < 5e9    # Less than 5 GB free
            for: 15m
            labels:
              severity: warning
            annotations:
              summary: "{{ $labels.cluster }}: schedulable memory < 5 GB"

          # Cross-cluster: alert if p99 latency diverges between regions
          - alert: CrossRegionLatencyDivergence
            expr: |
              max by (service) (
                histogram_quantile(0.99,
                  sum by (cluster, le, service) (
                    rate(http_request_duration_seconds_bucket[5m])
                  )
                )
              ) / min by (service) (
                histogram_quantile(0.99,
                  sum by (cluster, le, service) (
                    rate(http_request_duration_seconds_bucket[5m])
                  )
                )
              ) > 3   # Max region is 3x slower than fastest
            for: 10m
            labels:
              severity: warning
            annotations:
              summary: "{{ $labels.service }}: p99 latency diverges > 3x across regions"

  recording-rules.yaml: |
    groups:
      - name: global-recording-rules
        interval: 5m
        rules:
          # Pre-compute cross-cluster request rate for dashboard performance
          - record: cluster:http_request_rate:sum_rate5m
            expr: |
              sum by (cluster, region, service) (
                rate(http_requests_total[5m])
              )

          # Global p99 latency per service (across all clusters)
          - record: global:http_request_duration_p99:rate5m
            expr: |
              histogram_quantile(0.99,
                sum by (le, service) (
                  rate(http_request_duration_seconds_bucket[5m])
                )
              )
```

## Grafana: Unified Multi-Cluster Dashboards

### Grafana Configuration with Thanos as Datasource

```yaml
# Grafana Helm values
grafana:
  datasources:
    datasources.yaml:
      apiVersion: 1
      datasources:
        # Primary: Thanos Query (all clusters, full history)
        - name: Thanos Global
          type: prometheus
          url: http://thanos-query.thanos.svc.cluster.local:10902
          access: proxy
          isDefault: true
          jsonData:
            timeInterval: "60s"
            incrementalQuerying: true
            incrementalQueryOverlapWindow: "10m"

        # Per-cluster Prometheus (for recent data with full cardinality)
        - name: Prometheus US-East-1
          type: prometheus
          url: http://prometheus-operated.monitoring-us-east.svc.cluster.local:9090
          access: proxy
          jsonData:
            timeInterval: "15s"

        - name: Prometheus EU-West-1
          type: prometheus
          url: http://prometheus-operated.monitoring-eu-west.svc.cluster.local:9090
          access: proxy
```

### Variable-Based Multi-Cluster Dashboard

```json
{
  "title": "Global Cluster Overview",
  "templating": {
    "list": [
      {
        "name": "cluster",
        "type": "query",
        "datasource": "Thanos Global",
        "query": "label_values(up, cluster)",
        "multi": true,
        "includeAll": true,
        "allValue": ".*"
      },
      {
        "name": "namespace",
        "type": "query",
        "datasource": "Thanos Global",
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
          "expr": "sum by (cluster) (rate(http_requests_total{cluster=~\"$cluster\"}[5m]))",
          "legendFormat": "{{cluster}}"
        }
      ]
    },
    {
      "title": "Error Rate by Cluster",
      "type": "stat",
      "targets": [
        {
          "expr": "sum by (cluster) (rate(http_requests_total{cluster=~\"$cluster\",status=~\"5..\"}[5m])) / sum by (cluster) (rate(http_requests_total{cluster=~\"$cluster\"}[5m]))",
          "legendFormat": "{{cluster}}"
        }
      ]
    }
  ]
}
```

### Grafana Annotations for Cross-Cluster Deployments

```python
# Add deployment annotations via Grafana API
import requests
import json
from datetime import datetime

GRAFANA_URL = "http://grafana.monitoring.svc.cluster.local:3000"
GRAFANA_API_KEY = "<grafana-api-key>"

def annotate_deployment(cluster: str, service: str, version: str, success: bool):
    payload = {
        "dashboardId": None,  # Global annotation
        "time": int(datetime.utcnow().timestamp() * 1000),
        "isRegion": False,
        "tags": [
            "deployment",
            f"cluster:{cluster}",
            f"service:{service}",
            "success" if success else "failure"
        ],
        "text": f"Deploy {service}:{version} to {cluster} {'SUCCESS' if success else 'FAILED'}"
    }

    resp = requests.post(
        f"{GRAFANA_URL}/api/annotations",
        headers={"Authorization": f"Bearer {GRAFANA_API_KEY}"},
        json=payload,
    )
    resp.raise_for_status()
    return resp.json()
```

## QueryFrontend for Caching

Thanos Query Frontend caches query results to reduce load on stores and speed up dashboard loads:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query-frontend
  namespace: thanos
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
        - name: query-frontend
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - query-frontend
            - --log.level=info
            - --http-address=0.0.0.0:10902
            - --query-frontend.downstream-url=http://thanos-query.thanos.svc.cluster.local:10902
            - --query-range.split-interval=24h     # Split queries at day boundaries
            - --query-range.max-retries-per-request=5
            - --query-range.response-cache-config-file=/etc/thanos/cache.yaml
            - --labels.split-interval=24h
            - --labels.max-retries-per-request=5
            - --cache-compression-type=snappy
          volumeMounts:
            - name: cache-config
              mountPath: /etc/thanos
      volumes:
        - name: cache-config
          configMap:
            name: thanos-query-frontend-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-query-frontend-config
  namespace: thanos
data:
  cache.yaml: |
    type: MEMCACHED
    config:
      addresses:
        - dnssrv+_memcache._tcp.memcached.thanos.svc.cluster.local
      timeout: 500ms
      max_idle_connections: 100
      max_async_concurrency: 20
      max_async_buffer_size: 10000
      max_get_multi_concurrency: 100
      max_get_multi_batch_size: 0
      dns_provider_update_interval: 10s
      expiration: 24h
```

## Operational Runbook

### Verify Thanos Sidecar is Uploading Blocks

```bash
# In each cluster, check sidecar logs
kubectl logs -n monitoring \
  $(kubectl get pods -n monitoring -l thanos-sidecar=true -o name | head -1) \
  -c thanos-sidecar | grep -E "uploaded|error"

# Check block count in S3
aws s3 ls s3://thanos-metrics-us-east-1/ --recursive | \
  grep "meta.json" | wc -l

# Check via Thanos UI: http://thanos-query:10902/blocks
```

### Validate Global Query Works

```bash
kubectl exec -n thanos deploy/thanos-query -- \
  wget -qO- 'http://localhost:10902/api/v1/query?query=up' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Results: {len(d[\"data\"][\"result\"])}')"
# Results: 847   (total number of scraped targets across all clusters)
```

### Compaction Health Check

```bash
# Check compactor halted (indicates corruption or configuration error)
kubectl logs -n thanos thanos-compactor-0 | grep -E "halt|error" | tail -20

# Check compaction metrics
kubectl exec -n thanos thanos-compactor-0 -- \
  wget -qO- http://localhost:10902/metrics | \
  grep -E "thanos_compact_iterations_total|thanos_compact_halted"
```

### Alertmanager Integration Check

```bash
# Verify rules are evaluating
kubectl exec -n thanos thanos-ruler-0 -- \
  wget -qO- http://localhost:10902/api/v1/rules | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps([r['name'] for g in d['data']['groups'] for r in g['rules']], indent=2))"
```

## Cost Optimization

Thanos with object storage dramatically reduces cost versus Prometheus federation:

```
Traditional (5 clusters × HA Prometheus, 1-year retention):
  5 clusters × 2 replicas × 2 TB storage = 20 TB EBS
  20 TB × $0.10/GB/month = $2,000/month for storage alone

Thanos (5 clusters, 1-year retention):
  Raw data: 5 × 200 GB/month × 90 days = 3 TB S3
  5-min downsampled: 5 × 40 GB/month × 180 days = 600 GB S3
  1-hour downsampled: 5 × 8 GB/month × 365 days = 240 GB S3
  Total S3: ~3.84 TB × $0.023/GB = $88/month
  EBS (2-hour buffer): 5 × 50 GB × $0.10 = $25/month
  Total: ~$113/month — 94% cost reduction
```

## Summary

The Thanos multi-cluster observability stack provides:

1. **Global PromQL** via Thanos Query, enabling cross-cluster queries like "show error rate for all 5 clusters on the same graph" without Prometheus federation's cardinality limits.
2. **Unlimited retention** in object storage: raw data for 90 days, 5-minute downsampled for 6 months, 1-hour downsampled for a year — at a fraction of EBS costs.
3. **Cross-cluster alerting** via Thanos Ruler evaluating alert rules against the global query layer, enabling alerts that depend on data from multiple clusters.
4. **Query caching** via Query Frontend with Memcached, reducing Thanos Store load by 60–80% for Grafana dashboard loads.
5. **Deduplication** of HA Prometheus replica data — when both Prometheus replicas in a pair scrape the same target, Thanos Query returns exactly one copy.

The key operational simplicity of this architecture is that each cluster's Prometheus deployment is completely unchanged: the sidecar is the only addition, and it requires only object storage write access. The entire query and storage infrastructure lives in a separate observability cluster, separating concerns and allowing the query tier to scale independently of the Prometheus scrapers.
