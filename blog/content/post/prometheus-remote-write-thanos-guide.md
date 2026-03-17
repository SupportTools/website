---
title: "Prometheus Remote Write and Thanos: Long-Term Metrics Storage Architecture"
date: 2027-11-12T00:00:00-05:00
draft: false
tags: ["Prometheus", "Thanos", "Remote Write", "Monitoring", "Storage"]
categories:
- Monitoring
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Prometheus remote write configuration, Thanos deployment in sidecar and receiver modes, object store backends, querier federation, compactor, store gateway, and production retention policies."
more_link: "yes"
url: "/prometheus-remote-write-thanos-guide/"
---

Prometheus local storage is efficient and performant, but limited to a few weeks of data by default. For long-term metrics retention, cross-cluster federation, and high availability, Thanos extends Prometheus with object store-backed storage, global querying, and downsampling for multi-year retention. The choice between Thanos sidecar and Thanos Receiver modes fundamentally shapes the architecture, and remote write configuration determines the reliability of data transmission.

This guide covers remote write tuning for both Thanos Receiver and direct object store targets, Thanos component architecture, object store configuration, query federation, compactor operation, and production retention strategies.

<!--more-->

# Prometheus Remote Write and Thanos: Long-Term Metrics Storage Architecture

## Architecture Patterns

### Sidecar Mode

Thanos Sidecar runs alongside Prometheus and uploads completed TSDB blocks to object storage. Prometheus continues to handle its own ingestion and short-term storage.

```
Prometheus ──► local TSDB ──► Thanos Sidecar ──► Object Store (S3/GCS)
                                     │
                              Thanos Querier ◄── StoreAPI (gRPC)
```

Advantages:
- No changes to existing Prometheus deployments
- Prometheus handles ingestion reliability
- Sidecar only uploads completed 2-hour blocks

Disadvantages:
- 2-hour lag before data appears in object store
- High availability requires Prometheus replication + deduplication

### Receiver Mode

Thanos Receiver accepts remote_write from Prometheus instances and writes directly to object storage.

```
Prometheus ──► remote_write ──► Thanos Receiver ──► Object Store
                                       │
                               Thanos Querier ◄── StoreAPI
```

Advantages:
- Data available in object store within minutes
- Enables multi-tenant remote write
- Decouples Prometheus from object store credentials

Disadvantages:
- More complex architecture
- Remote write reliability depends on Receiver availability

## Prometheus Remote Write Configuration

### Basic Remote Write Configuration

```yaml
# prometheus-config.yaml
global:
  scrape_interval: 30s
  evaluation_interval: 30s

remote_write:
- url: http://thanos-receive.monitoring.svc.cluster.local:19291/api/v1/receive
  name: thanos-primary
  remote_timeout: 30s
  queue_config:
    capacity: 10000
    max_shards: 200
    min_shards: 1
    max_samples_per_send: 2000
    batch_send_deadline: 5s
    min_backoff: 30ms
    max_backoff: 5s
    retry_on_rate_limit: true
  metadata_config:
    send: true
    send_interval: 1m
    max_samples_per_send: 2000
  write_relabel_configs:
  - source_labels: [__name__]
    regex: "up|ALERTS|scrape_duration_seconds"
    action: keep
  tls_config:
    insecure_skip_verify: false
    ca_file: /etc/prometheus/tls/ca.crt
```

### Production Remote Write with Tuning

```yaml
remote_write:
- url: https://thanos-receive.monitoring.svc.cluster.local:10908/api/v1/receive
  name: thanos-primary
  remote_timeout: 30s

  # Queue configuration - critical for reliability
  queue_config:
    # In-memory buffer capacity (samples)
    capacity: 500000
    # Maximum number of parallel goroutines sending data
    max_shards: 200
    # Minimum shards - scales up under load
    min_shards: 5
    # Samples per HTTP request
    max_samples_per_send: 500
    # Maximum time to wait before sending a partial batch
    batch_send_deadline: 5s
    # Backoff parameters for failed requests
    min_backoff: 30ms
    max_backoff: 5s
    # Retry on HTTP 429 (rate limit)
    retry_on_rate_limit: true

  tls_config:
    ca_file: /etc/prometheus/tls/thanos-ca.crt
    cert_file: /etc/prometheus/tls/prometheus.crt
    key_file: /etc/prometheus/tls/prometheus.key

  # Write relabel: drop high cardinality or irrelevant metrics
  write_relabel_configs:
  # Drop kube-apiserver audit metrics (very high cardinality)
  - source_labels: [__name__]
    regex: "apiserver_audit_.*"
    action: drop
  # Drop per-bucket histogram data for remote (keep only sum/count)
  - source_labels: [__name__]
    regex: ".*_bucket"
    target_label: __tmp_bucket
  - source_labels: [__tmp_bucket, le]
    regex: ".+;(0.005|0.01|0.025|0.05|0.1|0.25|0.5|1|2.5|5|10|\\+Inf)"
    action: keep
  - target_label: __tmp_bucket
    replacement: ""
  # Add cluster identifier
  - target_label: cluster
    replacement: prod-us-east-1
  - target_label: replica
    replacement: prometheus-0

# Secondary remote write for long-term analytics
- url: https://mimir.analytics.company.internal/api/v1/push
  name: mimir-analytics
  remote_timeout: 60s
  queue_config:
    capacity: 100000
    max_shards: 50
    max_samples_per_send: 5000
    batch_send_deadline: 30s
  write_relabel_configs:
  # Only send SLI metrics to analytics backend
  - source_labels: [__name__]
    regex: "(http_requests_total|http_request_duration_.*|grpc_server_.*)"
    action: keep
```

### Remote Write Queue Sizing

```bash
# Calculate optimal queue capacity
# Rule: capacity = max_shards * max_samples_per_send * buffer_multiplier
# For 100k samples/sec throughput:
# - max_shards: 200
# - max_samples_per_send: 500
# - buffer: 200 * 500 * 5 = 500k samples

# Monitor queue health
kubectl exec -n monitoring prometheus-server-0 -- \
  curl -s localhost:9090/metrics | grep "prometheus_remote_storage"

# Key metrics to watch:
# prometheus_remote_storage_queue_highest_sent_timestamp_seconds
# prometheus_remote_storage_queue_pending_samples
# prometheus_remote_storage_samples_failed_total
# prometheus_remote_storage_bytes_total
```

## Thanos Installation with kube-prometheus-stack

### Thanos Sidecar via kube-prometheus-stack

```yaml
# kube-prometheus-stack-values.yaml (relevant sections)
prometheus:
  prometheusSpec:
    replicas: 2
    replicaExternalLabelName: prometheus_replica
    externalLabels:
      cluster: prod-us-east-1
      region: us-east-1

    # Enable Thanos sidecar
    thanos:
      image: quay.io/thanos/thanos:v0.36.0
      objectStorageConfig:
        key: objstore.yml
        name: thanos-objstore-secret
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 512Mi

    # Retention for local storage (2 weeks - sidecar uploads to S3)
    retention: 2w
    retentionSize: 50GB

    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes:
          - ReadWriteOnce
          resources:
            requests:
              storage: 100Gi
```

### Object Store Configuration

```yaml
# Create object store secret
apiVersion: v1
kind: Secret
metadata:
  name: thanos-objstore-secret
  namespace: monitoring
type: Opaque
stringData:
  objstore.yml: |
    type: S3
    config:
      bucket: company-thanos-metrics
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      aws_sdk_auth: true
      signature_version2: false
      encrypt_sse: true
      sse_type: SSE-KMS
      sse_kms_key_id: alias/thanos-metrics-key
      http_config:
        idle_conn_timeout: 90s
        response_header_timeout: 2m
        insecure_skip_verify: false
      trace:
        enable: false
      list_objects_version: ""
      bucket_lookup_type: auto
      send_content_md5: true
```

### GCS Object Store

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: thanos-objstore-gcs
  namespace: monitoring
type: Opaque
stringData:
  objstore.yml: |
    type: GCS
    config:
      bucket: company-thanos-metrics
      service_account: |
        {
          "type": "service_account",
          "project_id": "company-prod",
          "private_key_id": "key-id",
          "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n",
          "client_email": "thanos@company-prod.iam.gserviceaccount.com",
          "client_id": "123456",
          "auth_uri": "https://accounts.google.com/o/oauth2/auth",
          "token_uri": "https://oauth2.googleapis.com/token"
        }
```

## Thanos Receiver Deployment

### Receiver StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-receive
  namespace: monitoring
spec:
  replicas: 3
  serviceName: thanos-receive
  selector:
    matchLabels:
      app: thanos-receive
  template:
    metadata:
      labels:
        app: thanos-receive
        thanos-store-api: "true"
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: thanos-receive
            topologyKey: kubernetes.io/hostname
      containers:
      - name: thanos-receive
        image: quay.io/thanos/thanos:v0.36.0
        args:
        - receive
        - --grpc-address=0.0.0.0:10901
        - --http-address=0.0.0.0:10902
        - --remote-write.address=0.0.0.0:19291
        - --objstore.config-file=/etc/thanos/objstore.yml
        - --tsdb.path=/var/thanos/receive
        - --tsdb.retention=12h
        - --tsdb.wal-compression
        - --label=replica="$(NAME)"
        - --label=receive="true"
        - --receive.replication-factor=2
        - --receive.hashrings-file=/etc/thanos/hashrings.json
        - --receive.local-endpoint=$(NAME).thanos-receive.monitoring.svc.cluster.local:10901
        - --log.level=info
        - --log.format=logfmt
        env:
        - name: NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        ports:
        - containerPort: 10901
          name: grpc
        - containerPort: 10902
          name: http
        - containerPort: 19291
          name: remote-write
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        readinessProbe:
          httpGet:
            path: /-/ready
            port: http
          initialDelaySeconds: 15
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /-/healthy
            port: http
          initialDelaySeconds: 30
          periodSeconds: 30
        volumeMounts:
        - name: data
          mountPath: /var/thanos/receive
        - name: objstore-config
          mountPath: /etc/thanos
      volumes:
      - name: objstore-config
        secret:
          secretName: thanos-objstore-secret
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes:
      - ReadWriteOnce
      storageClassName: gp3
      resources:
        requests:
          storage: 50Gi
```

### Hashring Configuration for Receiver Sharding

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-receive-hashrings
  namespace: monitoring
data:
  hashrings.json: |
    [
      {
        "hashring": "default",
        "tenants": [],
        "endpoints": [
          "thanos-receive-0.thanos-receive.monitoring.svc.cluster.local:10901",
          "thanos-receive-1.thanos-receive.monitoring.svc.cluster.local:10901",
          "thanos-receive-2.thanos-receive.monitoring.svc.cluster.local:10901"
        ],
        "algorithm": "ketama"
      }
    ]
```

## Thanos Querier

### Querier Deployment

```yaml
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
        image: quay.io/thanos/thanos:v0.36.0
        args:
        - query
        - --grpc-address=0.0.0.0:10901
        - --http-address=0.0.0.0:10902
        - --query.replica-label=prometheus_replica
        - --query.replica-label=replica
        - --query.auto-downsampling
        - --query.partial-response
        - --store=dnssrv+_grpc._tcp.thanos-receive.monitoring.svc.cluster.local
        - --store=dnssrv+_grpc._tcp.thanos-store.monitoring.svc.cluster.local
        - --store=dnssrv+_grpc._tcp.thanos-ruler.monitoring.svc.cluster.local
        - --log.level=info
        - --query.timeout=5m
        - --query.lookback-delta=5m
        ports:
        - containerPort: 10901
          name: grpc
        - containerPort: 10902
          name: http
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 2000m
            memory: 2Gi
        readinessProbe:
          httpGet:
            path: /-/ready
            port: http
          initialDelaySeconds: 5
          periodSeconds: 5
```

### Multi-Cluster Federation

```yaml
# Query federating multiple clusters
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query-global
  namespace: monitoring
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: thanos-query
        image: quay.io/thanos/thanos:v0.36.0
        args:
        - query
        - --http-address=0.0.0.0:10902
        - --grpc-address=0.0.0.0:10901
        # Cluster-specific store endpoints
        - --store=thanos-store.monitoring.us-east-1.company.internal:10901
        - --store=thanos-store.monitoring.eu-west-1.company.internal:10901
        - --store=thanos-store.monitoring.ap-southeast-1.company.internal:10901
        # Deduplication labels
        - --query.replica-label=prometheus_replica
        - --query.replica-label=cluster
        - --query.auto-downsampling
        - --query.partial-response
        env:
        - name: TLS_CA_CERT
          value: /etc/thanos/tls/ca.crt
```

## Thanos Compactor

The compactor applies downsampling and implements retention policies:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-compact
  namespace: monitoring
spec:
  replicas: 1
  serviceName: thanos-compact
  selector:
    matchLabels:
      app: thanos-compact
  template:
    spec:
      containers:
      - name: thanos-compact
        image: quay.io/thanos/thanos:v0.36.0
        args:
        - compact
        - --wait
        - --wait-interval=5m
        - --objstore.config-file=/etc/thanos/objstore.yml
        - --data-dir=/var/thanos/compact
        - --http-address=0.0.0.0:10902
        # Retention policies
        - --retention.resolution-raw=30d
        - --retention.resolution-5m=90d
        - --retention.resolution-1h=1y
        # Compaction concurrency
        - --compact.concurrency=1
        # Block cleanup
        - --block-sync-concurrency=20
        - --log.level=info
        - --log.format=logfmt
        resources:
          requests:
            cpu: 100m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 8Gi
        volumeMounts:
        - name: data
          mountPath: /var/thanos/compact
        - name: objstore-config
          mountPath: /etc/thanos
      volumes:
      - name: objstore-config
        secret:
          secretName: thanos-objstore-secret
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: gp3
      accessModes:
      - ReadWriteOnce
      resources:
        requests:
          storage: 100Gi
```

### Retention Policy Design

```bash
# Raw data (30s resolution): 30 days
# 5-minute downsamples: 90 days
# 1-hour downsamples: 1 year (or longer for compliance)

# Verify compactor is creating downsample blocks
kubectl logs -n monitoring statefulset/thanos-compact | \
  grep -E "downsampl|retention|compaction" | tail -20

# Check object store block count
aws s3 ls s3://company-thanos-metrics/ --recursive | \
  grep "meta.json" | wc -l

# List blocks per resolution
aws s3 ls s3://company-thanos-metrics/ --recursive | \
  grep "meta.json" | xargs -I{} aws s3 cp s3://company-thanos-metrics/{} - | \
  python3 -c "
import json, sys
for line in sys.stdin:
    try:
        meta = json.loads(line)
        res = meta.get('thanos', {}).get('downsample', {}).get('resolution', 0)
        res_str = {0: 'raw', 300000: '5m', 3600000: '1h'}.get(res, str(res))
        print(res_str)
    except: pass
" | sort | uniq -c
```

## Store Gateway

The store gateway serves old block data from object store:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-store
  namespace: monitoring
spec:
  replicas: 2
  serviceName: thanos-store
  selector:
    matchLabels:
      app: thanos-store
  template:
    metadata:
      labels:
        app: thanos-store
        thanos-store-api: "true"
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: thanos-store
            topologyKey: kubernetes.io/hostname
      containers:
      - name: thanos-store
        image: quay.io/thanos/thanos:v0.36.0
        args:
        - store
        - --grpc-address=0.0.0.0:10901
        - --http-address=0.0.0.0:10902
        - --objstore.config-file=/etc/thanos/objstore.yml
        - --data-dir=/var/thanos/store
        # Cache index headers in memory
        - --store.grpc.series-sample-limit=50000000
        - --store.grpc.series-max-concurrency=20
        # Time-based shard (split old data across replicas)
        - --min-time=-8760h
        - --max-time=-720h
        - --log.level=info
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        volumeMounts:
        - name: data
          mountPath: /var/thanos/store
        - name: objstore-config
          mountPath: /etc/thanos
      volumes:
      - name: objstore-config
        secret:
          secretName: thanos-objstore-secret
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: gp3
      accessModes:
      - ReadWriteOnce
      resources:
        requests:
          storage: 50Gi
```

### Store Sharding for Large Object Stores

```yaml
# Shard by time range across multiple store replicas
# Store gateway 1: recent history (30 days to 6 months)
args:
- store
- --min-time=-4380h
- --max-time=-720h

# Store gateway 2: older data (6 months to 1 year)
args:
- store
- --min-time=-8760h
- --max-time=-4380h

# Store gateway 3: archive (1+ years)
args:
- store
- --min-time=-87600h
- --max-time=-8760h
```

## Thanos Ruler

For recording and alerting rules that span the full retention period:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  replicas: 1
  serviceName: thanos-ruler
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
        image: quay.io/thanos/thanos:v0.36.0
        args:
        - rule
        - --grpc-address=0.0.0.0:10901
        - --http-address=0.0.0.0:10902
        - --objstore.config-file=/etc/thanos/objstore.yml
        - --data-dir=/var/thanos/ruler
        - --label=ruler_cluster="prod-us-east-1"
        - --label=replica="$(NAME)"
        - --rule-file=/etc/thanos/rules/*.yaml
        - --query=thanos-query.monitoring.svc.cluster.local:10901
        - --alertmanagers.url=http://alertmanager.monitoring.svc:9093
        - --eval-interval=1m
        - --tsdb.retention=1d
        env:
        - name: NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        volumeMounts:
        - name: data
          mountPath: /var/thanos/ruler
        - name: objstore-config
          mountPath: /etc/thanos
        - name: rules
          mountPath: /etc/thanos/rules
      volumes:
      - name: objstore-config
        secret:
          secretName: thanos-objstore-secret
      - name: rules
        configMap:
          name: thanos-recording-rules
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: gp3
      accessModes:
      - ReadWriteOnce
      resources:
        requests:
          storage: 10Gi
```

### Recording Rules for Long-Term Queries

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-recording-rules
  namespace: monitoring
data:
  sli-recording.yaml: |
    groups:
    - name: sli_recording
      interval: 5m
      rules:
      - record: job:http_requests:rate5m
        expr: sum(rate(http_requests_total[5m])) by (job, namespace, status_code)

      - record: job:http_request_duration_p99:rate5m
        expr: histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (job, namespace, le))

      - record: namespace:cpu_usage:rate5m
        expr: sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) by (namespace)

      - record: namespace:memory_usage:bytes
        expr: sum(container_memory_working_set_bytes{container!=""}) by (namespace)

    - name: daily_aggregates
      interval: 1h
      rules:
      - record: namespace:cost:daily
        expr: |
          sum by (namespace) (
            sum_over_time(namespace:cpu_usage:rate5m[24h]) * 0.0317 +
            sum_over_time(namespace:memory_usage:bytes[24h]) / 1073741824 * 0.00423
          )
```

## Grafana Configuration for Thanos

### Thanos Query as Data Source

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasource-thanos
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  thanos-datasource.yaml: |
    apiVersion: 1
    datasources:
    - name: Thanos
      type: prometheus
      url: http://thanos-query.monitoring.svc.cluster.local:10902
      access: proxy
      isDefault: true
      jsonData:
        timeInterval: 30s
        queryTimeout: 5m
        httpMethod: POST
        manageAlerts: false
        prometheusType: Thanos
        prometheusVersion: "0.36.0"
        cacheLevel: "None"
        disableRecordingRules: false
        incrementalQueryOverlapWindow: 10m
      editable: false
```

## Production Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: thanos-alerts
  namespace: monitoring
spec:
  groups:
  - name: thanos.component
    rules:
    - alert: ThanosReceiveIsDown
      expr: |
        absent(up{job="thanos-receive"} == 1)
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Thanos Receive is down - remote write data loss risk"

    - alert: ThanosQueryDown
      expr: |
        absent(up{job="thanos-query"} == 1)
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Thanos Query is down - metrics unavailable"

    - alert: ThanosCompactorHalted
      expr: |
        thanos_compact_halted == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Thanos Compactor halted - downsampling not running"

    - alert: ThanosStoreGatewayNotInSync
      expr: |
        (thanos_blocks_meta_synced{state="loaded"} / thanos_blocks_meta_synced) < 0.90
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Thanos Store Gateway has unsynced blocks"

    - alert: PrometheusRemoteWritePending
      expr: |
        prometheus_remote_storage_pending_samples > 500000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Prometheus remote write queue is backing up"
        description: "{{ $value | humanize }} samples pending for target {{ $labels.remote_name }}"

    - alert: PrometheusRemoteWriteDropping
      expr: |
        rate(prometheus_remote_storage_samples_failed_total[5m]) > 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Prometheus is dropping remote write samples"
```

## Operational Runbooks

### Object Store Health Check

```bash
#!/bin/bash
# thanos-objstore-health.sh

BUCKET="company-thanos-metrics"
REGION="us-east-1"

echo "=== Thanos Object Store Health Check ==="
echo "Bucket: $BUCKET"
echo "Date: $(date)"
echo ""

# Check bucket accessibility
echo "--- Bucket Access ---"
aws s3 ls s3://$BUCKET/ --region $REGION > /dev/null 2>&1 && \
  echo "OK: Bucket accessible" || echo "ERROR: Cannot access bucket"

# Count blocks by state
echo ""
echo "--- Block Summary ---"
TOTAL=$(aws s3 ls s3://$BUCKET/ --recursive | grep "meta.json" | wc -l)
echo "Total blocks: $TOTAL"

# Check for deletion marks (blocks scheduled for deletion)
DELETABLE=$(aws s3 ls s3://$BUCKET/ --recursive | grep "deletion-mark.json" | wc -l)
echo "Blocks marked for deletion: $DELETABLE"

# Check for partial uploads (incomplete blocks)
NO_OF_CHUNKS=$(aws s3 ls s3://$BUCKET/ --recursive | grep "chunks" | wc -l)
echo "Chunk files: $NO_OF_CHUNKS"

# Size breakdown
echo ""
echo "--- Size Breakdown ---"
aws s3api list-objects-v2 --bucket $BUCKET --region $REGION \
  --query 'Contents[*].Size' --output text | \
  awk '{sum += $1} END {printf "Total size: %.2f GB\n", sum/1073741824}'

# Recent activity (last 24h)
echo ""
echo "--- Recent Activity (last 24h) ---"
YESTERDAY=$(date -d '24 hours ago' +%Y-%m-%d)
aws s3 ls s3://$BUCKET/ --recursive | \
  awk -v d=$YESTERDAY '$1 >= d' | wc -l | \
  xargs -I{} echo "Objects modified in last 24h: {}"
```

### Compactor Maintenance

```bash
# Check compactor logs for errors
kubectl logs -n monitoring statefulset/thanos-compact --tail=100 | \
  grep -E "ERROR|error|fail|halt"

# Verify downsampling is progressing
kubectl exec -n monitoring statefulset/thanos-compact -- \
  curl -s localhost:10902/metrics | \
  grep -E "thanos_compact_(block|downsample)"

# Manual compaction trigger (if halted)
kubectl rollout restart statefulset/thanos-compact -n monitoring

# Check block metadata
kubectl exec -n monitoring statefulset/thanos-compact -- \
  curl -s localhost:10902/api/v1/blocks | python3 -m json.tool | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
blocks = data.get('data', {}).get('blocks', [])
from collections import Counter
res_count = Counter()
for block in blocks:
    res = block.get('thanos', {}).get('downsample', {}).get('resolution', 0)
    res_str = {0: 'raw', 300000: '5m', 3600000: '1h'}.get(res, str(res))
    res_count[res_str] += 1
for res, count in sorted(res_count.items()):
    print(f'{res}: {count} blocks')
"
```

## Summary

The Thanos architecture provides enterprise-grade long-term metrics storage with these key design points:

**Deployment mode**: Use Sidecar mode when Prometheus deployments are already running and you want minimal disruption. Use Receiver mode for new deployments where you need immediate data availability in object storage or multi-tenant remote write.

**Remote write tuning**: Set `capacity` to buffer at least 30 seconds of data at peak throughput. Use `write_relabel_configs` to drop high-cardinality metrics before they reach the Receiver, reducing storage costs significantly.

**Retention strategy**: Keep 30 days of raw data (30s resolution), 90 days of 5-minute downsamples, and 1+ year of hourly downsamples. The compactor handles this automatically once configured.

**Query federation**: The global Querier combines data from multiple clusters and handles deduplication via `replica-label` configuration. Partial responses should be enabled for global dashboards that tolerate some missing data.

**Store gateway sharding**: Split the store gateway by time range for large object stores. Each shard serves a specific time window, reducing per-instance memory requirements and improving query performance.

**Alerting**: Monitor the remote write queue depth as the primary indicator of ingestion health. Compactor halts should be paged as they prevent retention policy enforcement.
