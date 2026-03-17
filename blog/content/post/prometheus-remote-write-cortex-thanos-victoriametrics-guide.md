---
title: "Prometheus Remote Write: Cortex, Thanos Receive, and VictoriaMetrics"
date: 2029-02-13T00:00:00-05:00
draft: false
tags: ["Prometheus", "Observability", "Cortex", "Thanos", "VictoriaMetrics", "Monitoring"]
categories:
- Monitoring
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive comparison and configuration guide for Prometheus remote_write backends including Cortex, Thanos Receive, and VictoriaMetrics, covering tuning, sharding, tenant isolation, and production operational patterns."
more_link: "yes"
url: "/prometheus-remote-write-cortex-thanos-victoriametrics-guide/"
---

Prometheus was designed as a single-node metrics system. Its local TSDB handles high-frequency scraping and powerful PromQL queries with low latency, but it does not provide long-term storage, multi-tenancy, or global query federation by default. The `remote_write` feature solves this by streaming samples from Prometheus to an external storage backend in near real-time. Three backends dominate production deployments: Cortex (now Mimir), Thanos Receive, and VictoriaMetrics. Each has a distinct architecture, operational model, and trade-off profile.

This guide covers remote_write configuration tuning, the write path internals of each backend, capacity planning, tenant isolation, and the alert rules needed to detect write pipeline failures.

<!--more-->

## Remote Write Protocol

Prometheus encodes samples as a Protocol Buffers message (`prometheus.WriteRequest`) and sends them via HTTP POST to the remote_write endpoint. Requests are compressed with Snappy by default. The client uses a queue-per-shard model to control parallelism and backpressure.

```
Prometheus Scrape Loop
       │
       ▼
  WAL (Write-Ahead Log)
       │
  ┌────┴──────────────────────────────────────┐
  │  remote_write Queue (per shard)           │
  │  ┌────────┐  ┌────────┐  ┌────────┐      │
  │  │ Shard 0│  │ Shard 1│  │ Shard N│      │
  │  └────┬───┘  └────┬───┘  └────┬───┘      │
  └───────┼───────────┼───────────┼───────────┘
          │           │           │
          ▼           ▼           ▼
    Remote Write Endpoint (Cortex / Thanos / VM)
```

## Prometheus remote_write Configuration

```yaml
# prometheus.yml — complete remote_write configuration reference

global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: prod-us-east-1
    region: us-east-1
    env: production

remote_write:
  - url: https://cortex.monitoring.svc.cluster.local/api/v1/push
    name: cortex-primary

    # Authentication
    bearer_token_file: /var/run/secrets/prometheus/token

    # TLS configuration
    tls_config:
      ca_file: /etc/ssl/certs/ca-bundle.crt
      cert_file: /etc/prometheus/tls/client.crt
      key_file: /etc/prometheus/tls/client.key

    # Queue tuning — most critical for production
    queue_config:
      # Number of parallel shards sending to the remote endpoint
      # Each shard maintains its own in-memory queue
      # Start at max_shards=4, increase if remote_write is the bottleneck
      min_shards: 1
      max_shards: 30

      # Maximum number of samples per send batch
      # Larger batches are more efficient but increase latency on failure
      max_samples_per_send: 2000

      # Batch wait time — send before this even if batch isn't full
      batch_send_deadline: 5s

      # In-memory buffer (samples × shards × this = total memory buffer)
      capacity: 10000

      # Retry configuration
      min_backoff: 30ms
      max_backoff: 5s

      # Retry on non-recoverable HTTP status codes (default: false)
      retry_on_http_429: true

    # Write relabeling — filter before sending (reduces bandwidth)
    write_relabel_configs:
      # Drop high-cardinality debug metrics
      - source_labels: [__name__]
        regex: "go_gc_.*|go_memstats_.*"
        action: drop
      # Drop metrics with no job label
      - source_labels: [job]
        regex: ""
        action: drop
      # Add tenant label for multi-tenant backends
      - target_label: __tenant_id__
        replacement: "team-platform"

    # Metadata sending (requires Prometheus 2.23+)
    metadata_config:
      send: true
      send_interval: 1m
      max_samples_per_send: 500
```

## Cortex / Grafana Mimir

Cortex (and its successor Mimir) implements a microservices architecture modeled on Google Monarch. The write path traverses: Distributor → Ingester → Object Storage.

### Cortex Distributor Configuration

```yaml
# cortex-distributor values (Helm)
distributor:
  replicaCount: 3

  config:
    distributor:
      # Replication factor for in-memory ingester data
      ring:
        kvstore:
          store: consul
          prefix: collectors/
          consul:
            host: consul.platform.svc.cluster.local:8500

  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 2Gi

  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetCPUUtilizationPercentage: 60
```

### Cortex Ingester Configuration

```yaml
# cortex-ingester Helm values
ingester:
  replicaCount: 6
  # Ingesters are stateful — use StatefulSet
  statefulSet:
    enabled: true

  persistentVolume:
    enabled: true
    size: 50Gi
    storageClass: fast-ssd

  config:
    ingester:
      walconfig:
        wal_enabled: true
        dir: /data/ingester/wal
        checkpoint_duration: 5m
      lifecycler:
        # Replication factor (must match distributor setting)
        ring:
          replication_factor: 3
          kvstore:
            store: consul
            prefix: collectors/
        # Time to wait before becoming active (ensures WAL replay)
        join_after: 0s
        # Time for other ingesters to detect failure
        heartbeat_period: 5s
        heartbeat_timeout: 1m

  resources:
    requests:
      cpu: 1000m
      memory: 4Gi
    limits:
      cpu: 4000m
      memory: 16Gi
```

### Cortex Ruler and Query Frontend

```yaml
# cortex-values.yaml — query path
queryFrontend:
  replicaCount: 2
  config:
    query_range:
      # Cache query results in Memcached
      results_cache:
        cache:
          memcached_client:
            addresses: dns+memcached.monitoring.svc.cluster.local:11211
            max_idle_connections: 16
            timeout: 500ms
      split_queries_by_interval: 24h
      align_queries_with_step: true
      cache_results: true

querier:
  replicaCount: 4
  config:
    querier:
      # Query ingesters + object store in parallel
      query_ingesters_within: 13h
      query_store_after: 12h
```

## Thanos Receive

Thanos Receive implements the Prometheus remote_write endpoint natively. It accepts samples, writes them to a local TSDB, and optionally replicates them across a receiver hashring for high availability.

### Thanos Receive Hashring Configuration

```yaml
# thanos-receive-hashring-config ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-receive-hashring-config
  namespace: monitoring
data:
  hashring.json: |
    [
      {
        "hashring": "default",
        "tenants": [],
        "endpoints": [
          "thanos-receive-0.thanos-receive.monitoring.svc.cluster.local:10901",
          "thanos-receive-1.thanos-receive.monitoring.svc.cluster.local:10901",
          "thanos-receive-2.thanos-receive.monitoring.svc.cluster.local:10901"
        ]
      },
      {
        "hashring": "team-a",
        "tenants": ["team-a"],
        "endpoints": [
          "thanos-receive-team-a-0.thanos-receive-team-a.monitoring.svc.cluster.local:10901",
          "thanos-receive-team-a-1.thanos-receive-team-a.monitoring.svc.cluster.local:10901"
        ]
      }
    ]
```

### Thanos Receive StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-receive
  namespace: monitoring
spec:
  serviceName: thanos-receive
  replicas: 3
  selector:
    matchLabels:
      app: thanos-receive
  template:
    metadata:
      labels:
        app: thanos-receive
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
      containers:
        - name: thanos-receive
          image: quay.io/thanos/thanos:v0.37.2
          args:
            - receive
            - --log.level=info
            - --log.format=json
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --remote-write.address=0.0.0.0:19291
            - --tsdb.path=/data
            - --tsdb.retention=2h
            - --label=receive_replica="$(POD_NAME)"
            - --receive.replication-factor=2
            - --receive.hashrings-file=/etc/thanos/hashring.json
            - --objstore.config-file=/etc/thanos/objstore.yaml
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          ports:
            - name: grpc
              containerPort: 10901
            - name: http
              containerPort: 10902
            - name: remote-write
              containerPort: 19291
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
            - name: hashring-config
              mountPath: /etc/thanos
              readOnly: true
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 10902
            initialDelaySeconds: 30
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 10902
            initialDelaySeconds: 10
            periodSeconds: 10
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
```

### Thanos Object Store Configuration

```yaml
# /etc/thanos/objstore.yaml — S3 backend
type: S3
config:
  bucket: thanos-metrics-prod
  endpoint: s3.us-east-1.amazonaws.com
  region: us-east-1
  # Use IRSA (IAM Roles for Service Accounts) in EKS
  # Leave access_key and secret_key empty to use instance profile
  sse_config:
    type: SSE-S3
  part_size: 134217728  # 128MiB
  max_retries: 3
  put_user_metadata:
    cluster: prod-us-east-1
```

## VictoriaMetrics

VictoriaMetrics offers significantly lower memory and CPU consumption than Cortex or Thanos while maintaining high write throughput. The single-node variant is a drop-in replacement for the Prometheus HTTP API.

### VictoriaMetrics Cluster Deployment

```yaml
# victoria-metrics-cluster Helm values
# vminsert handles the remote_write endpoint
vminsert:
  replicaCount: 3
  extraArgs:
    - -replicationFactor=2
    - -maxInsertRequestSize=64MB
    - -insert.maxQueueDuration=1m
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 4000m
      memory: 4Gi
  ingress:
    enabled: true
    hosts:
      - host: vminsert.monitoring.example.com
        paths: ["/insert"]

# vmstorage is the persistent layer
vmstorage:
  replicaCount: 3
  persistentVolume:
    size: 200Gi
    storageClass: fast-ssd
  extraArgs:
    - -retentionPeriod=90d
    - -storageDataPath=/data
    - -dedup.minScrapeInterval=15s
  resources:
    requests:
      cpu: 2000m
      memory: 8Gi
    limits:
      cpu: 8000m
      memory: 32Gi

# vmselect handles the query layer
vmselect:
  replicaCount: 2
  extraArgs:
    - -cacheDataPath=/cache
    - -search.maxQueryLen=16384
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 4000m
      memory: 8Gi
```

### Prometheus remote_write to VictoriaMetrics

```yaml
# prometheus.yml — writing to VictoriaMetrics cluster
remote_write:
  - url: http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write
    name: victoriametrics-primary
    # The /insert/0/ path means tenant 0 (default)
    # For multi-tenancy: /insert/<tenantID>/prometheus/api/v1/write

    queue_config:
      min_shards: 2
      max_shards: 50
      max_samples_per_send: 5000
      capacity: 20000
      batch_send_deadline: 3s

    # VictoriaMetrics supports native histogram downsampling
    # Use metadata to enable optimal storage
    metadata_config:
      send: true
      send_interval: 1m
```

## Capacity Planning

| Metric | Formula | Example |
|--------|---------|---------|
| Remote write throughput | `active_series × scrape_interval⁻¹` | 500K series × (15s)⁻¹ = 33K samples/sec |
| Network bandwidth | `samples/sec × avg_sample_size_bytes` | 33K × 18 bytes ≈ 600 KB/s per Prometheus |
| WAL disk usage | `throughput × wal_retention` | 33K × 18B × 2h = ~4 GB |
| Backend write IOPS | Varies by backend; VM needs ~100 IOPS/GB/s throughput | — |

### Prometheus Queue Metrics for Sizing

```bash
# Check queue health — key metrics
kubectl exec -n monitoring prometheus-0 -- \
  curl -s http://localhost:9090/metrics | grep prometheus_remote_storage

# Critical metrics:
# prometheus_remote_storage_samples_pending            — current queue depth
# prometheus_remote_storage_samples_failed_total       — samples dropped
# prometheus_remote_storage_queue_highest_sent_timestamp — lag behind current time
# prometheus_remote_storage_shards_desired             — desired vs current shards
```

## PrometheusRule: Remote Write Health Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: remote-write-health
  namespace: monitoring
spec:
  groups:
    - name: remote_write
      rules:
        - alert: PrometheusRemoteWriteBehind
          expr: |
            (time() - prometheus_remote_storage_queue_highest_sent_timestamp_seconds) > 120
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Prometheus remote write is lagging"
            description: "Remote write for {{ $labels.url }} is {{ $value | humanizeDuration }} behind"

        - alert: PrometheusRemoteWriteDroppedSamples
          expr: |
            rate(prometheus_remote_storage_samples_failed_total[5m]) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Prometheus remote write dropping samples"
            description: "{{ $value | humanize }} samples/sec being dropped to {{ $labels.url }}"

        - alert: PrometheusRemoteWriteQueueFull
          expr: |
            prometheus_remote_storage_samples_pending / prometheus_remote_storage_queue_capacity > 0.8
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Prometheus remote write queue nearly full"
            description: "Queue to {{ $labels.url }} is {{ $value | humanizePercentage }} full"
```

## Backend Comparison Summary

| Criterion | Cortex/Mimir | Thanos Receive | VictoriaMetrics |
|-----------|-------------|---------------|-----------------|
| Architecture | Microservices | Receive + Sidecar | Monolithic cluster |
| Multi-tenancy | First-class | Via hashring tenants | Via tenant URLs |
| Write performance | High with tuning | Moderate | Highest |
| Memory per series | 200-400 bytes | 200-400 bytes | 50-100 bytes |
| Object storage | Required | Optional | Optional |
| PromQL compatibility | Full (Mimir) | Full (via Querier) | High (MetricsQL superset) |
| Operational complexity | High | Medium | Low |
| License | AGPL (Mimir) | Apache 2 | Apache 2 |

## Summary

Prometheus `remote_write` is the integration layer between ephemeral scrape-based monitoring and durable long-term storage. Cortex/Mimir suits organizations that need full multi-tenancy and horizontal scalability at the cost of operational complexity. Thanos Receive integrates naturally with an existing Thanos deployment and reuses the well-understood object storage compaction pipeline. VictoriaMetrics delivers the best resource efficiency and simplest operations for most production workloads. Regardless of backend, the queue tuning parameters—`max_shards`, `capacity`, `max_samples_per_send`—must be sized to the actual sample ingestion rate, and the health alert rules must be in place before the system enters production.

## Tuning remote_write for High-Cardinality Metrics

High-cardinality metrics (many unique label combinations) can saturate the remote_write queue. Use write_relabel_configs to reduce cardinality before transmission.

```yaml
remote_write:
  - url: http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write
    write_relabel_configs:
      # Drop metrics with more than 10 label values for "le" (histogram explosion)
      - source_labels: [__name__]
        regex: "http_request_duration_seconds_bucket"
        target_label: __tmp_drop_check
        replacement: "keep"
      # Reduce cardinality: drop per-pod metrics, keep namespace+service aggregations
      - source_labels: [__name__, pod]
        regex: "container_.*;.+"
        action: drop
      # Drop per-instance metrics that are only useful locally
      - source_labels: [__name__]
        regex: "go_goroutines|go_threads|process_open_fds"
        action: drop
      # Hash long URL labels to prevent label explosion
      - source_labels: [url]
        regex: ".{100,}"
        target_label: url
        replacement: "TRUNCATED"
```

## VictoriaMetrics vmagent: A Lighter Alternative to Prometheus

For environments where running full Prometheus is too resource-intensive, `vmagent` implements the scrape loop and remote_write without the local TSDB.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: vmagent
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: vmagent
  template:
    metadata:
      labels:
        app: vmagent
    spec:
      serviceAccountName: vmagent
      hostNetwork: false
      containers:
        - name: vmagent
          image: victoriametrics/vmagent:v1.106.0
          args:
            - -promscrape.config=/etc/prometheus/prometheus.yml
            - -remoteWrite.url=http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write
            - -remoteWrite.tmpDataPath=/tmp/vmagent-remotewrite-data
            - -remoteWrite.maxDiskUsagePerURL=2GB
            - -promscrape.streamParse
            - -promscrape.suppressDuplicateScrapeTargetErrors
            - -http.listenAddr=:8429
          ports:
            - name: http
              containerPort: 8429
          volumeMounts:
            - name: prometheus-config
              mountPath: /etc/prometheus
              readOnly: true
            - name: vmagent-data
              mountPath: /tmp/vmagent-remotewrite-data
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 2Gi
      volumes:
        - name: prometheus-config
          configMap:
            name: prometheus-config
        - name: vmagent-data
          emptyDir:
            sizeLimit: 4Gi
```

## Thanos Receive Router: Multi-Tenant Routing

The Thanos Receive Router (introduced in Thanos 0.26) is a stateless component that routes incoming remote_write requests to the correct tenant's receive group.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-receive-router
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app: thanos-receive-router
  template:
    spec:
      containers:
        - name: router
          image: quay.io/thanos/thanos:v0.37.2
          args:
            - receive
            - --log.level=info
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --remote-write.address=0.0.0.0:19291
            - --receive.hashrings-file=/etc/thanos/hashring.json
            - --receive.local-endpoint=127.0.0.1:10901
            # Router mode: doesn't store data, only routes
            - --receive.replication-factor=1
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 2000m
              memory: 1Gi
          volumeMounts:
            - name: hashring-config
              mountPath: /etc/thanos
              readOnly: true
```

## Debugging Remote Write Failures

```bash
# Check Prometheus remote write queue status
kubectl exec -n monitoring prometheus-server-0 -- \
  curl -s http://localhost:9090/api/v1/query?query=prometheus_remote_storage_samples_pending \
  | jq '.data.result[] | {url: .metric.url, pending: .value[1]}'

# Check if samples are being dropped
kubectl exec -n monitoring prometheus-server-0 -- \
  curl -s http://localhost:9090/api/v1/query?query=rate\(prometheus_remote_storage_samples_failed_total[5m]\) \
  | jq '.data.result[] | select(.value[1] != "0")'

# Check VictoriaMetrics ingestion rate
curl -s http://vminsert.monitoring.svc.cluster.local:8480/metrics \
  | grep -E "vm_rows_inserted_total|vm_slow_row_inserts_total"

# Check Thanos Receive errors
kubectl -n monitoring logs -l app=thanos-receive --since=5m \
  | grep -iE "error|failed|rejected"

# Test remote_write endpoint directly
curl -v -X POST \
  --data-binary @/tmp/test-metrics.pb \
  -H "Content-Type: application/x-protobuf" \
  -H "Content-Encoding: snappy" \
  -H "X-Prometheus-Remote-Write-Version: 0.1.0" \
  http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write
```

## Multi-Cluster Federation with remote_write

For multi-cluster monitoring, each cluster runs its own Prometheus and ships metrics to a central cluster.

```yaml
# prometheus-config for cluster A shipping to central monitoring
remote_write:
  - url: https://central-metrics.monitoring.example.com/api/v1/push
    name: central-monitoring
    bearer_token_file: /var/run/secrets/central-metrics-token
    tls_config:
      ca_file: /etc/prometheus/ca.crt
    queue_config:
      min_shards: 2
      max_shards: 10
      max_samples_per_send: 1000
    write_relabel_configs:
      # Add cluster identifier to all metrics
      - target_label: source_cluster
        replacement: "prod-us-east-1"
      # Only forward recording rule outputs and critical metrics
      # to avoid shipping raw high-cardinality data to central
      - source_labels: [__name__]
        regex: "cluster:.*|slo:.*|recording:.*|up|node_.*|container_memory_working_set_bytes"
        action: keep
```
