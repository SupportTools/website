---
title: "Grafana Loki Production Deployment: Scalable Log Aggregation on Kubernetes"
date: 2027-07-06T00:00:00-05:00
draft: false
tags: ["Grafana", "Loki", "Kubernetes", "Logging", "Observability"]
categories:
- Grafana
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production deployment guide for Grafana Loki on Kubernetes covering microservices architecture, object storage backends, Promtail and Grafana Agent log shipping, LogQL query optimization, chunk storage tuning, and log-based alerting with the Ruler."
more_link: "yes"
url: "/grafana-loki-production-deployment-guide/"
---

Grafana Loki is a horizontally scalable log aggregation system designed around the principle of indexing only metadata labels rather than the full log content. This approach dramatically reduces storage cost and indexing overhead compared to Elasticsearch-based solutions, at the cost of requiring label-based filtering as the primary query optimization strategy. Deploying Loki in production on Kubernetes requires understanding its component architecture, choosing an appropriate deployment mode, tuning chunk storage for the target ingestion rate, and designing a label schema that avoids high-cardinality pitfalls. This guide covers all of these concerns with production-ready configurations.

<!--more-->

## Loki Architecture

### Core Components

Loki separates its read, write, and storage responsibilities into distinct components:

| Component | Role | Stateful |
|-----------|------|---------|
| Distributor | Receives log streams from agents; validates and hashes streams to ingesters | No |
| Ingester | Buffers incoming chunks in memory; flushes to object storage | Yes |
| Querier | Executes LogQL queries against object storage and in-memory ingester data | No |
| Query Frontend | Caches and splits large queries; retries | No |
| Query Scheduler | Distributes query work between frontends and queriers | No |
| Compactor | Compacts index files in object storage; applies retention | Singleton |
| Ruler | Evaluates LogQL recording and alerting rules | Yes |
| Index Gateway | Serves store-GRPC index queries; offloads queriers | Yes |

### Deployment Modes

Loki supports three deployment modes:

**Monolithic** (`-target=all`): All components in a single binary. Suitable for development or low-volume environments (< 100 GB/day).

**Simple Scalable** (`-target=read` and `-target=write`): Two deployments — one for the read path and one for the write path. The default Helm chart deploys this mode. Suitable for medium volumes (100 GB – 1 TB/day).

**Microservices**: Each component deployed independently. Required for very high volumes (> 1 TB/day) or when components need independent scaling.

---

## Object Storage Configuration

### S3 Backend Configuration

```yaml
# loki-config.yaml (ConfigMap data)
storage_config:
  boltdb_shipper:
    active_index_directory: /data/loki/index
    cache_location: /data/loki/boltdb-cache
    cache_ttl: 24h
    shared_store: s3
  aws:
    s3: s3://us-east-1/my-loki-chunks-prod
    region: us-east-1
    # Use IRSA — no explicit credentials
    sse:
      type: SSE-S3

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_index_
        period: 24h

# Use TSDB index for improved query performance
```

### GCS Backend

```yaml
storage_config:
  gcs:
    bucket_name: my-loki-chunks-prod
    chunk_buffer_size: 0
    request_timeout: 0s

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: gcs
      schema: v13
      index:
        prefix: loki_index_
        period: 24h
```

### MinIO Backend (On-Premises)

```yaml
storage_config:
  aws:
    s3: http://REPLACE_WITH_MINIO_ACCESS_KEY:REPLACE_WITH_MINIO_SECRET_KEY@minio.minio.svc:9000/loki
    s3forcepathstyle: true
    region: us-east-1
    insecure: false

common:
  storage:
    s3:
      endpoint: minio.minio.svc:9000
      insecure: false
      bucketnames: loki-chunks
      access_key_id: REPLACE_WITH_MINIO_ACCESS_KEY
      secret_access_key: REPLACE_WITH_MINIO_SECRET_KEY
      s3forcepathstyle: true
```

---

## Microservices Deployment on Kubernetes

### Loki ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-config
  namespace: logging
data:
  config.yaml: |
    auth_enabled: true

    server:
      http_listen_port: 3100
      grpc_listen_port: 9095
      log_level: info
      grpc_server_max_recv_msg_size: 104857600  # 100 MiB
      grpc_server_max_send_msg_size: 104857600

    common:
      path_prefix: /data/loki
      replication_factor: 3
      ring:
        kvstore:
          store: memberlist

    memberlist:
      join_members:
        - loki-memberlist.logging.svc:7946

    ingester:
      wal:
        enabled: true
        dir: /data/loki/wal
      lifecycler:
        ring:
          kvstore:
            store: memberlist
          replication_factor: 3
      chunk_idle_period: 30m
      chunk_block_size: 262144
      chunk_retain_period: 1m
      max_transfer_retries: 60
      flush_check_period: 30s

    schema_config:
      configs:
        - from: 2024-01-01
          store: tsdb
          object_store: s3
          schema: v13
          index:
            prefix: loki_index_
            period: 24h

    storage_config:
      aws:
        s3: s3://us-east-1/my-loki-chunks-prod
        region: us-east-1
      tsdb_shipper:
        active_index_directory: /data/loki/tsdb-index
        cache_location: /data/loki/tsdb-cache
        cache_ttl: 24h

    compactor:
      working_directory: /data/loki/compactor
      shared_store: s3
      compaction_interval: 10m
      retention_enabled: true
      retention_delete_delay: 2h
      retention_delete_worker_count: 150

    limits_config:
      enforce_metric_name: false
      max_streams_per_user: 0
      max_global_streams_per_user: 50000
      ingestion_rate_mb: 100
      ingestion_burst_size_mb: 150
      per_stream_rate_limit: 10MB
      per_stream_rate_limit_burst: 20MB
      max_query_series: 500
      max_query_parallelism: 32
      max_entries_limit_per_query: 50000
      max_cache_freshness_for_out_of_order_writes: 10m
      split_queries_by_interval: 15m
      query_timeout: 300s
      max_chunks_per_query: 2000000

    query_range:
      results_cache:
        cache:
          embedded_cache:
            enabled: true
            max_size_mb: 500
      cache_results: true
      parallelise_shardable_queries: true

    frontend:
      compress_responses: true
      max_outstanding_per_tenant: 2048
      scheduler_address: loki-query-scheduler.logging.svc:9095

    frontend_worker:
      scheduler_address: loki-query-scheduler.logging.svc:9095
      grpc_client_config:
        max_recv_msg_size: 104857600

    ruler:
      storage:
        type: s3
        s3:
          bucket_name: my-loki-rules-prod
          region: us-east-1
      rule_path: /data/loki/rules
      alertmanager_url: http://alertmanager.monitoring.svc:9093
      ring:
        kvstore:
          store: memberlist
      enable_alertmanager_v2: true
      enable_api: true
      evaluation_interval: 1m
```

### Distributor Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki-distributor
  namespace: logging
spec:
  replicas: 3
  selector:
    matchLabels:
      app: loki-distributor
  template:
    metadata:
      labels:
        app: loki-distributor
    spec:
      containers:
        - name: loki
          image: grafana/loki:3.1.0
          args:
            - -config.file=/etc/loki/config.yaml
            - -target=distributor
          ports:
            - containerPort: 3100
              name: http-metrics
            - containerPort: 9095
              name: grpc
            - containerPort: 7946
              name: memberlist
          livenessProbe:
            httpGet:
              path: /ready
              port: http-metrics
            initialDelaySeconds: 45
          readinessProbe:
            httpGet:
              path: /ready
              port: http-metrics
            initialDelaySeconds: 15
          resources:
            requests:
              memory: 512Mi
              cpu: 500m
            limits:
              memory: 1Gi
              cpu: "2"
          volumeMounts:
            - name: config
              mountPath: /etc/loki
      volumes:
        - name: config
          configMap:
            name: loki-config
```

### Ingester StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: loki-ingester
  namespace: logging
spec:
  serviceName: loki-ingester
  replicas: 3
  selector:
    matchLabels:
      app: loki-ingester
  template:
    metadata:
      labels:
        app: loki-ingester
    spec:
      containers:
        - name: loki
          image: grafana/loki:3.1.0
          args:
            - -config.file=/etc/loki/config.yaml
            - -target=ingester
          ports:
            - containerPort: 3100
              name: http-metrics
            - containerPort: 9095
              name: grpc
            - containerPort: 7946
              name: memberlist
          readinessProbe:
            httpGet:
              path: /ready
              port: http-metrics
            initialDelaySeconds: 30
          resources:
            requests:
              memory: 4Gi
              cpu: "1"
            limits:
              memory: 8Gi
              cpu: "4"
          volumeMounts:
            - name: config
              mountPath: /etc/loki
            - name: data
              mountPath: /data/loki
      volumes:
        - name: config
          configMap:
            name: loki-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 50Gi
```

### Querier Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki-querier
  namespace: logging
spec:
  replicas: 4
  selector:
    matchLabels:
      app: loki-querier
  template:
    metadata:
      labels:
        app: loki-querier
    spec:
      containers:
        - name: loki
          image: grafana/loki:3.1.0
          args:
            - -config.file=/etc/loki/config.yaml
            - -target=querier
          ports:
            - containerPort: 3100
              name: http-metrics
            - containerPort: 9095
              name: grpc
            - containerPort: 7946
              name: memberlist
          resources:
            requests:
              memory: 2Gi
              cpu: "1"
            limits:
              memory: 6Gi
              cpu: "4"
          volumeMounts:
            - name: config
              mountPath: /etc/loki
            - name: data
              mountPath: /data/loki
              emptyDir: {}
      volumes:
        - name: config
          configMap:
            name: loki-config
        - name: data
          emptyDir: {}
```

---

## Log Shipping: Promtail DaemonSet

### Promtail DaemonSet Configuration

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: promtail
  namespace: logging
spec:
  selector:
    matchLabels:
      app: promtail
  template:
    metadata:
      labels:
        app: promtail
    spec:
      serviceAccountName: promtail
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: promtail
          image: grafana/promtail:3.1.0
          args:
            - -config.file=/etc/promtail/config.yaml
          ports:
            - containerPort: 3101
              name: http-metrics
          securityContext:
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          livenessProbe:
            httpGet:
              path: /ready
              port: http-metrics
            initialDelaySeconds: 10
          resources:
            requests:
              memory: 128Mi
              cpu: 100m
            limits:
              memory: 256Mi
              cpu: 200m
          volumeMounts:
            - name: config
              mountPath: /etc/promtail
            - name: varlog
              mountPath: /var/log
              readOnly: true
            - name: varlibdockercontainers
              mountPath: /var/lib/docker/containers
              readOnly: true
            - name: run
              mountPath: /run/promtail
      volumes:
        - name: config
          configMap:
            name: promtail-config
        - name: varlog
          hostPath:
            path: /var/log
        - name: varlibdockercontainers
          hostPath:
            path: /var/lib/docker/containers
        - name: run
          hostPath:
            path: /run/promtail
```

### Promtail Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: promtail-config
  namespace: logging
data:
  config.yaml: |
    server:
      http_listen_port: 3101
      grpc_listen_port: 0
      log_level: info

    positions:
      filename: /run/promtail/positions.yaml

    clients:
      - url: http://loki-distributor.logging.svc:3100/loki/api/v1/push
        tenant_id: default
        batchwait: 1s
        batchsize: 1048576
        timeout: 10s

    scrape_configs:
      - job_name: kubernetes-pods
        kubernetes_sd_configs:
          - role: pod
        pipeline_stages:
          - cri: {}
          - drop:
              expression: '.*health.*'
              drop_counter_reason: health_check_dropped
          - labeldrop:
              - filename
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_node_name]
            target_label: node
          - source_labels: [__meta_kubernetes_namespace]
            target_label: namespace
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod
          - source_labels: [__meta_kubernetes_pod_container_name]
            target_label: container
          - source_labels: [__meta_kubernetes_pod_label_app]
            target_label: app
          - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
            target_label: app
          - source_labels: [__meta_kubernetes_pod_controller_kind]
            target_label: controller_kind
          # Drop high-cardinality labels
          - action: labeldrop
            regex: __meta_kubernetes_pod_label_pod_template_hash

      - job_name: kubernetes-pods-structured
        kubernetes_sd_configs:
          - role: pod
        pipeline_stages:
          - cri: {}
          - json:
              expressions:
                level: level
                msg: message
                trace_id: trace_id
          - labels:
              level:
              trace_id:
          - output:
              source: msg
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_annotation_log_format]
            regex: json
            action: keep
          - source_labels: [__meta_kubernetes_namespace]
            target_label: namespace
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod

      - job_name: kubernetes-audit
        static_configs:
          - targets:
              - localhost
            labels:
              job: kubernetes-audit
              __path__: /var/log/audit/audit.log
        pipeline_stages:
          - json:
              expressions:
                verb: verb
                resource: objectRef.resource
                namespace: objectRef.namespace
                user: user.username
          - labels:
              verb:
              resource:
```

---

## Label Strategy for Low Cardinality

### High-Cardinality Antipatterns

The most common Loki performance problem is high-cardinality label sets. Each unique label combination creates a separate log stream, and Loki must maintain an in-memory index entry for every active stream.

**Avoid** labels with unbounded values:
- `pod_id` (unique per pod instance)
- `request_id` or `trace_id` (unique per request)
- `user_id` (unbounded user base)
- `ip_address` (unbounded)

**Use** labels with bounded cardinality:
- `namespace` (tens of values)
- `app` or `service` (tens to hundreds)
- `container` (bounded by deployment)
- `node` (bounded by cluster size)
- `level` (debug, info, warn, error)
- `environment` (dev, staging, prod)

### Stream Cardinality Audit

```bash
# Query active streams count per tenant
curl -s "http://loki-querier.logging.svc:3100/loki/api/v1/series?match[]={namespace=~\".+\"}&start=$(date -d '1 hour ago' +%s)000000000&end=$(date +%s)000000000" | \
  jq '.data | length'

# Identify high-cardinality labels
logcli series '{namespace="production"}' --analyze-labels
```

---

## Chunk Storage Tuning

### Ingester Chunk Parameters

```yaml
ingester:
  # Idle time before flushing a partially filled chunk
  chunk_idle_period: 30m
  # Maximum time to keep a chunk open before forcing a flush
  chunk_target_size: 1572864   # 1.5 MiB
  # Compression algorithm: none, gzip, lz4, snappy, zstd
  chunk_encoding: snappy
  # How long to retain flushed chunks in ingester memory
  chunk_retain_period: 1m
  # Maximum number of chunks per stream
  max_chunk_age: 2h
  flush_check_period: 30s
```

### Compression Trade-offs

| Algorithm | Compression ratio | CPU cost | Best for |
|-----------|-----------------|---------|---------|
| `none` | 1x | Minimal | High-throughput testing |
| `lz4` | ~2-3x | Low | Default, general purpose |
| `snappy` | ~2-3x | Low | Similar to lz4, slightly faster decompression |
| `gzip` | ~5-8x | High | Storage cost optimization |
| `zstd` | ~6-10x | Medium | Best ratio/cost balance for production |

For most production workloads with cost sensitivity, `zstd` is recommended.

---

## Grafana Agent for Log Collection

### Grafana Agent as Promtail Alternative

Grafana Agent can replace Promtail while also collecting metrics and traces in a single binary, reducing the number of DaemonSet processes per node:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-agent-config
  namespace: logging
data:
  agent.yaml: |
    logs:
      positions_directory: /run/agent/positions
      configs:
        - name: kubernetes
          clients:
            - url: http://loki-distributor.logging.svc:3100/loki/api/v1/push
              tenant_id: default
              external_labels:
                cluster: production
                environment: prod
          scrape_configs:
            - job_name: kubernetes-pods
              kubernetes_sd_configs:
                - role: pod
              pipeline_stages:
                - cri: {}
                - drop:
                    expression: '(^$)'
              relabel_configs:
                - source_labels: [__meta_kubernetes_namespace]
                  target_label: namespace
                - source_labels: [__meta_kubernetes_pod_name]
                  target_label: pod
                - source_labels: [__meta_kubernetes_pod_container_name]
                  target_label: container
                - source_labels: [__meta_kubernetes_pod_label_app]
                  target_label: app
```

---

## LogQL Query Language

### Filtering and Parsing

```logql
# Basic label filter
{namespace="production", app="api-server"}

# Text filter with regex
{namespace="production"} |~ "ERROR|WARN"

# JSON parsing
{namespace="production"} | json | level="error"

# Logfmt parsing
{app="nginx"} | logfmt | status >= 500

# Pattern extraction
{app="nginx"} | pattern `<ip> - - [<_>] "<method> <path> <_>" <status> <_>`
  | status >= 500

# Rate queries (LogQL metrics)
sum by (namespace) (
  rate({namespace=~"production|staging"} |~ "error"[5m])
)

# Count over time
count_over_time(
  {app="api-server"} | json | level="error" [1h]
)
```

### High-Performance Query Patterns

**Good: filter by labels first, then parse**
```logql
{namespace="production", app="api-server"} | json | level="error"
```

**Bad: parse everything first, then filter**
```logql
{namespace="production"} | json | app="api-server" | level="error"
```

The label filter `{app="api-server"}` reduces the number of streams that must be queried before any log parsing occurs, dramatically reducing query latency and cost.

---

## Ruler for Log-Based Alerts

### Ruler Alerting Rules

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-ruler-rules
  namespace: logging
data:
  production-alerts.yaml: |
    groups:
      - name: application-errors
        interval: 1m
        rules:
          - alert: HighApplicationErrorRate
            expr: |
              sum by (namespace, app) (
                rate({namespace=~"production|staging"} | json | level="error" [5m])
              ) > 1
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "High error log rate for {{ $labels.app }} in {{ $labels.namespace }}"
              description: "Error rate is {{ $value }} errors/sec"

          - alert: OOMKillDetected
            expr: |
              count_over_time(
                {namespace="production"} |~ "OOMKilled|out of memory" [5m]
              ) > 0
            labels:
              severity: critical
            annotations:
              summary: "OOM kill detected in production namespace"

          - alert: CertificateExpirationWarning
            expr: |
              count_over_time(
                {app="cert-manager"} |~ "certificate.*expir" [1h]
              ) > 0
            labels:
              severity: warning
            annotations:
              summary: "Certificate expiration warning detected in cert-manager logs"
```

---

## Grafana Datasource Integration

### Loki Datasource Configuration

```yaml
# grafana-datasource.yaml (as Grafana sidecar ConfigMap)
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-loki-datasource
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  loki-datasource.yaml: |
    apiVersion: 1
    datasources:
      - name: Loki
        type: loki
        access: proxy
        url: http://loki-query-frontend.logging.svc:3100
        jsonData:
          maxLines: 1000
          derivedFields:
            - datasourceUid: jaeger
              matcherRegex: 'traceID=(\w+)'
              name: TraceID
              url: '$${__value.raw}'
              urlDisplayLabel: "View Trace"
          alertmanagerUid: alertmanager
        version: 1
        editable: false
```

### Correlating Logs with Traces

Loki's derived fields allow clickable trace links from log lines:

```yaml
jsonData:
  derivedFields:
    - datasourceUid: tempo
      matcherRegex: '"trace_id":"(\w+)"'
      name: TraceID
      url: '$${__value.raw}'
```

This produces clickable trace ID links directly in the Explore view, enabling navigation from a log entry to the corresponding distributed trace in Tempo or Jaeger.

---

## Retention Configuration

### Per-Tenant Retention

```yaml
limits_config:
  # Global default retention
  retention_period: 744h   # 31 days

  # Per-tenant overrides via API or ruler rules
  # Applied via per-tenant limits override file

per_tenant_override_config: /etc/loki/per-tenant-overrides.yaml
```

```yaml
# per-tenant-overrides.yaml
overrides:
  production:
    retention_period: 2160h   # 90 days
  audit:
    retention_period: 8760h   # 365 days
  development:
    retention_period: 168h    # 7 days
```

---

## Monitoring Loki Itself

### Key Loki Metrics

```yaml
groups:
  - name: loki-health
    rules:
      - alert: LokiIngesterNotReady
        expr: loki_ingester_memory_chunks == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Loki ingester has no chunks in memory"

      - alert: LokiChunkFlushFailures
        expr: rate(loki_ingester_chunks_flushed_total{status="failed"}[5m]) > 0
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Loki chunk flush failures detected"

      - alert: LokiRequestErrors
        expr: |
          100 * sum by (job, route) (
            rate(loki_request_duration_seconds_count{status_code=~"5.."}[5m])
          ) / sum by (job, route) (
            rate(loki_request_duration_seconds_count[5m])
          ) > 10
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Loki 5xx error rate above 10%"

      - alert: LokiQueryTimeout
        expr: |
          histogram_quantile(0.99,
            sum by (le, job) (
              rate(loki_request_duration_seconds_bucket{route="/loki/api/v1/query_range"}[5m])
            )
          ) > 30
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Loki query p99 latency above 30 seconds"
```

---

## Operational Runbook

### Ingester Ring Health

```bash
# Check ingester ring health
curl -s http://loki-ingester.logging.svc:3100/ring | jq .

# Flush a specific ingester
curl -X POST http://loki-ingester-0.loki-ingester.logging.svc:3100/flush

# Check for unhealthy ring members and forget them
curl -X POST \
  "http://loki-distributor.logging.svc:3100/ring?action=forget&id=INGESTER_ID"
```

### Query Performance Debugging

```bash
# Enable query trace logging
curl -s "http://loki-querier.logging.svc:3100/loki/api/v1/query_range?query={namespace=\"production\"}&start=1700000000000000000&end=1700003600000000000&limit=10" \
  -H "X-Scope-OrgID: default" \
  -H "X-Query-Tags: source=debug"

# Check compactor retention status
curl -s http://loki-compactor.logging.svc:3100/compactor/ring | jq .

# List series for cardinality audit
curl -s "http://loki-querier.logging.svc:3100/loki/api/v1/series?match[]={namespace=\"production\"}&start=$(date -d '5 minutes ago' +%s)000000000&end=$(date +%s)000000000" \
  -H "X-Scope-OrgID: default" | jq '.data | length'
```

---

## Production Sizing Reference

### Write Path Sizing

| Daily Log Volume | Distributors | Ingesters | Disk per Ingester |
|----------------|-------------|-----------|------------------|
| 10 GB/day | 1 | 3 | 10 GB |
| 100 GB/day | 2 | 3 | 50 GB |
| 1 TB/day | 4 | 6 | 100 GB |
| 10 TB/day | 8 | 12 | 200 GB |

### Read Path Sizing

Query concurrency drives querier count more than data volume. A rule of thumb is one querier per 4 concurrent heavy queries, with Query Frontend handling fan-out and retries.

---

## Summary

Grafana Loki provides a cost-effective log aggregation solution that scales horizontally on Kubernetes through component separation. The key to successful production deployment is understanding label cardinality constraints, properly sizing ingester chunk parameters for the target ingestion rate, and designing the label schema before rolling out log collection at scale. The Ruler component extends Loki beyond passive log storage into an active alerting system based on log patterns, making it a complete observability component alongside Prometheus and Grafana Tempo in the LGTM stack.
