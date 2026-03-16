---
title: "Loki Distributed Mode: Enterprise Log Aggregation on Kubernetes"
date: 2027-03-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Loki", "Logging", "Observability", "Grafana"]
categories: ["Kubernetes", "Observability", "Logging"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Loki in distributed microservices mode on Kubernetes, covering component architecture (ingester, distributor, querier, compactor), S3 object storage configuration, Promtail/Alloy log collection, LogQL query optimization, retention policies, and high-availability deployment."
more_link: "yes"
url: "/loki-distributed-log-aggregation-kubernetes-guide/"
---

Grafana Loki's distributed microservices mode separates each functional concern — log ingestion, indexing, querying, and compaction — into independently scalable components. This architecture enables petabyte-scale log retention on object storage at a fraction of the cost of Elasticsearch or Splunk, while maintaining sub-second query latency for recent logs and acceptable latency for historical queries.

This guide covers the full distributed deployment: component roles, Helm configuration, S3 storage backend, Promtail and Alloy log collection, LogQL query optimization, multi-tenancy, retention policies, and Prometheus health monitoring.

<!--more-->

## Loki Deployment Modes

Loki supports three deployment modes with different operational complexity and scalability profiles.

### Monolithic mode

All Loki components run in a single binary and a single Deployment. Suitable for development and small deployments (under ~50 GB/day ingest). Not recommended for production at scale.

### Simple scalable mode

Two StatefulSets: `read` (querier, query-frontend, query-scheduler) and `write` (distributor, ingester). The `backend` StatefulSet handles compactor, ruler, and index-gateway. This mode is the recommended starting point for medium-scale production deployments (50 GB to 500 GB/day).

### Distributed microservices mode

Each component runs as a separate Deployment or StatefulSet with independent replica counts, resource limits, and horizontal pod autoscalers. This is the correct choice for large-scale production (500 GB/day and above) where individual component bottlenecks need independent remediation.

## Component Architecture

### Distributor

The distributor receives log streams from Promtail, Alloy, or other agents and validates them (label count, line size, rate limits). It hashes the stream's label set to determine which ingester(s) to route to, using a consistent hash ring for even distribution.

Horizontal scaling: scale based on CPU and network bandwidth. Distributors are stateless.

### Ingester (with WAL)

Ingesters accumulate log chunks in memory before flushing to object storage. Each ingester maintains a Write-Ahead Log (WAL) on local disk to prevent data loss during crashes.

Horizontal scaling: controlled by the ring replication factor. With `replication_factor: 3`, at least 3 ingesters must be running. Scale in multiples of the replication factor to maintain ring balance.

### Querier

Queriers execute LogQL queries by fetching chunks from both ingesters (recent data) and object storage (historical data). They are stateless and can be scaled freely based on query load.

### Query Frontend

The query-frontend splits large queries into smaller sub-queries, shuffles them for parallelism, and caches results. It is the entry point for all queries from Grafana and LogCLI.

### Query Scheduler

The query-scheduler distributes query sub-queries from the query-frontend to available queriers via a work queue. It decouples the query-frontend from querier discovery.

### Compactor

The compactor merges many small index files produced by ingesters into larger, more efficient files. It also enforces retention policies by deleting expired chunks from object storage.

### Ruler

The ruler evaluates LogQL recording rules and alerting rules on a schedule, analogous to Prometheus recording rules.

### Index Gateway

In distributed mode with TSDB or boltdb-shipper index backends, the index-gateway serves index queries from an in-memory cache, reducing object storage read amplification.

## Installing Loki in Distributed Mode

```bash
# Add the Grafana Helm repository
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# Create namespace
kubectl create namespace logging

# Install Loki distributed mode
helm upgrade --install loki grafana/loki \
  --namespace logging \
  --version 6.10.0 \
  --values loki-distributed-values.yaml \
  --wait --timeout=15m
```

### Production Helm values (distributed mode)

```yaml
# loki-distributed-values.yaml

loki:
  # Use distributed microservices mode
  deploymentMode: Distributed

  # Authentication — multi-tenant mode
  auth_enabled: true

  # Limits configuration — applied globally and per tenant
  limits_config:
    # Global ingestion rate
    ingestion_rate_mb: 64
    ingestion_burst_size_mb: 128
    # Per-stream limits
    max_streams_per_user: 50000
    max_global_streams_per_user: 100000
    # Query limits
    max_query_series: 100000
    max_query_length: 721h        # 30 days
    max_query_range: 8760h        # 365 days
    # Retention (global default — override per tenant in ruler_config)
    retention_period: 2160h       # 90 days

  # Storage backend — S3
  storage:
    type: s3
    s3:
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      bucketnames: loki-chunks-prod
      access_key_id: ${AWS_ACCESS_KEY_ID}
      secret_access_key: ${AWS_SECRET_ACCESS_KEY}
      s3forcepathstyle: false
      insecure: false

  # Schema config — TSDB index with S3 storage
  schemaConfig:
    configs:
      - from: 2024-01-01
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_index_
          period: 24h

  # Ingester ring configuration
  ingester:
    ring:
      kvstore:
        store: memberlist
      replication_factor: 3

  # Compactor settings
  compactor:
    working_directory: /data/compactor
    shared_store: s3
    compaction_interval: 10m
    retention_enabled: true
    retention_delete_delay: 2h
    retention_delete_worker_count: 150

  # Cache configuration — results and chunks cache
  queryRange:
    resultsCache:
      cache:
        embeddedCache:
          enabled: true
          maxSizeMB: 500
          ttl: 24h
    cacheResults: true

  # Ruler for recording rules and alerting
  rulerConfig:
    storage:
      type: s3
      s3:
        bucketnames: loki-ruler-prod
        region: us-east-1
        access_key_id: ${AWS_ACCESS_KEY_ID}
        secret_access_key: ${AWS_SECRET_ACCESS_KEY}
    rule_path: /rules
    ring:
      kvstore:
        store: memberlist
    enable_api: true
    enable_alertmanager_v2: true
    alertmanager_url: http://kube-prometheus-stack-alertmanager.monitoring.svc.cluster.local:9093

  # Memberlist for ring coordination (no Consul or etcd needed)
  memberlist:
    join_members:
      - loki-memberlist

# Per-component replica counts and resources
distributor:
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 1Gi
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilizationPercentage: 70

ingester:
  replicas: 6                     # must be >= replication_factor
  persistence:
    enabled: true
    storageClass: gp3
    size: 50Gi                    # WAL storage
  resources:
    requests:
      cpu: 1000m
      memory: 4Gi
    limits:
      cpu: 4000m
      memory: 8Gi
  # Ingester ring configuration
  zoneAwareReplication:
    enabled: true                 # spread replicas across availability zones

querier:
  replicas: 4
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi
  autoscaling:
    enabled: true
    minReplicas: 4
    maxReplicas: 20
    targetCPUUtilizationPercentage: 75

queryFrontend:
  replicas: 2
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 512Mi

queryScheduler:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

compactor:
  replicas: 1
  persistence:
    enabled: true
    storageClass: gp3
    size: 100Gi
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi

ruler:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

indexGateway:
  enabled: true
  replicas: 2
  persistence:
    enabled: true
    storageClass: gp3
    size: 20Gi
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi

# Memberlist headless service for ring coordination
memberlist:
  service:
    publishNotReadyAddresses: true

# Prometheus metrics
monitoring:
  serviceMonitor:
    enabled: true
    namespace: monitoring
    labels:
      release: kube-prometheus-stack
  selfMonitoring:
    enabled: true
    grafanaAgent:
      installOperator: false      # use existing Grafana Agent/Alloy
```

## S3 Object Storage Configuration

### Bucket structure

Loki uses separate buckets (or prefixes) for chunks, ruler data, and optionally the index when not using TSDB.

```bash
# Create S3 buckets with versioning disabled (Loki manages its own GC)
aws s3api create-bucket \
  --bucket loki-chunks-prod \
  --region us-east-1

aws s3api create-bucket \
  --bucket loki-ruler-prod \
  --region us-east-1

# Apply lifecycle rules to expire objects matching Loki's retention period + buffer
aws s3api put-bucket-lifecycle-configuration \
  --bucket loki-chunks-prod \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "expire-old-chunks",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "Expiration": {"Days": 100}
      }
    ]
  }'
```

### IAM policy for Loki S3 access

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LokiChunksBucketAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging"
      ],
      "Resource": [
        "arn:aws:s3:::loki-chunks-prod",
        "arn:aws:s3:::loki-chunks-prod/*",
        "arn:aws:s3:::loki-ruler-prod",
        "arn:aws:s3:::loki-ruler-prod/*"
      ]
    }
  ]
}
```

### Kubernetes Secret for S3 credentials

```bash
# For environments not using IRSA (IAM Roles for Service Accounts)
kubectl create secret generic loki-s3-credentials \
  --namespace logging \
  --from-literal=AWS_ACCESS_KEY_ID=EXAMPLE_TOKEN_REPLACE_ME \
  --from-literal=AWS_SECRET_ACCESS_KEY=EXAMPLE_TOKEN_REPLACE_ME
```

## Promtail DaemonSet Configuration

Promtail is the traditional log agent for Loki. It runs as a DaemonSet and tails container log files from `/var/log/pods/`.

```yaml
# promtail-values.yaml — Helm values for Promtail
config:
  # Loki push API endpoint
  clients:
    - url: http://loki-gateway.logging.svc.cluster.local/loki/api/v1/push
      # Tenant ID for multi-tenant mode
      tenant_id: production
      # Backoff configuration for push failures
      backoff_config:
        min_period: 500ms
        max_period: 5m
        max_retries: 10
      # Batch settings
      batchwait: 1s
      batchsize: 1048576    # 1 MiB

  # Pipeline stages for log processing
  snippets:
    pipelineStages:
      # Parse Docker/CRI-O log format
      - cri: {}

      # Extract Kubernetes metadata
      - match:
          selector: '{app=~".+"}'
          stages:
            - docker: {}
            - json:
                expressions:
                  level: level
                  msg: msg
                  time: time
            - labels:
                level:

      # Parse JSON structured logs from Go services
      - match:
          selector: '{app="api-server"}'
          stages:
            - json:
                expressions:
                  level: level
                  request_id: requestId
                  method: method
                  path: path
                  status: status
                  duration_ms: durationMs
            - labels:
                level:
                method:
            - metrics:
                http_requests_total:
                  type: Counter
                  description: Total HTTP requests from logs
                  source: status
                  config:
                    action: inc

      # Drop debug and trace logs in production to reduce volume
      - match:
          selector: '{namespace="production"}'
          stages:
            - drop:
                expression: '.*(debug|trace|DEBUG|TRACE).*'
                drop_counter_reason: debug_log_dropped

      # Multiline log handling for Java stack traces
      - match:
          selector: '{app="payments-service"}'
          stages:
            - multiline:
                firstline: '^\d{4}-\d{2}-\d{2}'    # lines starting with date
                max_wait_time: 3s
                max_lines: 128

  # Positions file to track read position
  positionsConfig:
    filename: /run/promtail/positions.yaml

resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    cpu: 200m
    memory: 256Mi

tolerations:
  - effect: NoSchedule
    operator: Exists
  - effect: NoExecute
    operator: Exists

# Mount host log directories
extraVolumes:
  - name: varlog
    hostPath:
      path: /var/log
  - name: varlibdockercontainers
    hostPath:
      path: /var/lib/docker/containers

extraVolumeMounts:
  - name: varlog
    mountPath: /var/log
    readOnly: true
  - name: varlibdockercontainers
    mountPath: /var/lib/docker/containers
    readOnly: true
```

## Grafana Alloy as Alternative Collector

Grafana Alloy (successor to Grafana Agent) provides a more flexible pipeline model using River configuration language.

```hcl
// alloy-loki-config.alloy
// Alloy configuration for Kubernetes log collection

// Kubernetes pod log discovery
discovery.kubernetes "pods" {
  role = "pod"
}

// Relabel pod metadata into log labels
discovery.relabel "pod_logs" {
  targets = discovery.kubernetes.pods.targets

  // Keep only running pods
  rule {
    source_labels = ["__meta_kubernetes_pod_phase"]
    regex         = "Running"
    action        = "keep"
  }

  // Extract namespace
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }

  // Extract pod name
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }

  // Extract container name
  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }

  // Extract app label
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }

  // Set log path
  rule {
    source_labels = [
      "__meta_kubernetes_pod_uid",
      "__meta_kubernetes_pod_container_name",
    ]
    target_label = "__path__"
    separator    = "/"
    replacement  = "/var/log/pods/*$1*/*$2*/*.log"
  }
}

// Read log files
loki.source.file "pod_logs" {
  targets    = discovery.relabel.pod_logs.output
  forward_to = [loki.process.pipeline.receiver]
}

// Processing pipeline
loki.process "pipeline" {
  forward_to = [loki.write.loki_endpoint.receiver]

  // Parse CRI-O/containerd log format
  stage.cri {}

  // Parse JSON logs
  stage.json {
    expressions = {
      level      = "level",
      msg        = "msg",
      request_id = "requestId",
    }
  }

  // Promote JSON fields to labels
  stage.labels {
    values = {
      level = null,
    }
  }

  // Drop debug logs in production namespaces
  stage.match {
    selector = "{namespace=~\"production|staging\"}"

    stage.drop {
      expression = "(?i)(debug|trace)"
      drop_counter_reason = "debug_filtered"
    }
  }
}

// Loki write endpoint
loki.write "loki_endpoint" {
  endpoint {
    url = "http://loki-gateway.logging.svc.cluster.local/loki/api/v1/push"
    tenant_id = "production"

    // Batch and backoff configuration
    batch_wait = "1s"
    batch_size = "1MiB"

    // Retry on failure
    min_backoff_period = "500ms"
    max_backoff_period = "5m"
    max_backoff_retries = 10
  }
}
```

## LogQL Syntax and Query Optimization

### Line filter queries

```logql
# Find error logs in production API
{namespace="production", app="api-server"} |= "error"

# Exclude health check noise
{namespace="production", app="api-server"}
  |= "error"
  != "/healthz"
  != "/readyz"

# Case-insensitive match
{namespace="production"} |~ "(?i)exception|panic|fatal"
```

### Label filter queries

```logql
# Filter by JSON field value after parsing
{namespace="production", app="api-server"}
  | json
  | level = "error"
  | status >= 500

# Filter with regex on a parsed field
{namespace="production"}
  | json
  | method =~ "POST|PUT|DELETE"
  | duration_ms > 1000

# Find slow requests by service
{namespace="production"}
  | json
  | duration_ms > 500
  | line_format "{{.app}} {{.method}} {{.path}} took {{.duration_ms}}ms"
```

### Metric queries

```logql
# Request rate per service (5-minute rate)
sum by (app) (
  rate(
    {namespace="production"} | json | unwrap status [5m]
  )
)

# Error rate percentage
sum(rate({namespace="production"} | json | level="error" [5m])) by (app)
/
sum(rate({namespace="production"} | json [5m])) by (app)

# P95 request duration from logs
quantile_over_time(0.95,
  {namespace="production", app="api-server"}
  | json
  | unwrap duration_ms [5m]
) by (app)

# Log volume per namespace
sum by (namespace) (
  bytes_over_time({namespace=~".+"} [1h])
)
```

### LogQL recording rules

```yaml
# loki-recording-rules.yaml
apiVersion: 1
groups:
  - name: loki-request-metrics
    interval: 1m
    rules:
      # Record request rate per app for dashboards
      - record: loki:app_request_rate:5m
        expr: |
          sum by (namespace, app) (
            rate({namespace=~"production|staging"} | json | status =~ "2.." [5m])
          )

      # Record error rate per app
      - record: loki:app_error_rate:5m
        expr: |
          sum by (namespace, app) (
            rate({namespace=~"production|staging"} | json | status =~ "5.." [5m])
          )

      # Record P99 latency
      - record: loki:app_latency_p99:5m
        expr: |
          quantile_over_time(0.99,
            {namespace="production"}
            | json
            | unwrap duration_ms [5m]
          ) by (app)
```

## Retention Configuration

Loki retention is enforced by the compactor using a per-tenant override mechanism.

### Global and per-tenant retention

```yaml
# In loki values — global retention
loki:
  limits_config:
    # Global default: 90 days
    retention_period: 2160h

# Per-tenant overrides via ConfigMap
overrides_file:
  enabled: true

# Additional values for per-tenant configuration
runtimeConfig:
  overrides:
    # Production tenant: 1 year retention
    production:
      retention_period: 8760h
      ingestion_rate_mb: 128
      ingestion_burst_size_mb: 256
      max_global_streams_per_user: 200000

    # Development tenant: 14 days retention
    development:
      retention_period: 336h
      ingestion_rate_mb: 32
      ingestion_burst_size_mb: 64
      max_global_streams_per_user: 25000

    # Security/audit tenant: 2 year retention
    audit:
      retention_period: 17520h
      ingestion_rate_mb: 64
      ingestion_burst_size_mb: 128
      max_global_streams_per_user: 50000
```

## Multi-Tenant Configuration

```yaml
# Multi-tenant Loki auth_enabled=true requires X-Scope-OrgID header

# Promtail multi-tenant configuration — different tenant per namespace
scrape_configs:
  - job_name: kubernetes-pods-production
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [production]
    pipeline_stages:
      - cri: {}
    relabel_configs:
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - source_labels: [__meta_kubernetes_pod_container_name]
        target_label: container
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: app
      - replacement: production
        target_label: __tenant_id__    # sets X-Scope-OrgID to "production"

  - job_name: kubernetes-pods-development
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [development, dev-team-alpha, dev-team-beta]
    pipeline_stages:
      - cri: {}
    relabel_configs:
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - replacement: development
        target_label: __tenant_id__    # routes to development tenant
```

## Prometheus Metrics for Loki Health

### Key Loki metrics

| Metric | Type | Description |
|---|---|---|
| `loki_ingester_chunks_flushed_total` | Counter | Chunks successfully flushed to object store |
| `loki_ingester_chunk_utilization` | Histogram | Chunk fill ratio (low = waste, high = compression benefit) |
| `loki_distributor_lines_received_total` | Counter | Log lines received by distributors |
| `loki_distributor_ingester_append_failures_total` | Counter | Failed appends to ingesters |
| `loki_query_frontend_queries_total` | Counter | Queries processed by query-frontend |
| `loki_query_frontend_retries` | Histogram | Query retries due to querier failures |
| `loki_compactor_runs_completed_total` | Counter | Successful compaction runs |
| `loki_boltdb_shipper_compact_tables_operation_duration_seconds` | Histogram | Index compaction duration |
| `loki_ruler_evaluation_duration_seconds` | Histogram | Rule evaluation latency |

### Prometheus alerting rules

```yaml
# loki-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: loki-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: loki-ingestion
      interval: 30s
      rules:
        # Alert when ingester flush failures are occurring
        - alert: LokiIngesterFlushFailures
          expr: |
            rate(loki_ingester_flush_op_duration_seconds_count{status="failure"}[5m]) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Loki ingester is failing to flush chunks to object store"
            description: "Ingester {{ $labels.pod }} has been failing chunk flushes for 5 minutes. Check S3 connectivity."

        # Alert when distributor is dropping log lines
        - alert: LokiDistributorDroppingLogs
          expr: |
            rate(loki_distributor_lines_received_total{status="dropped"}[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Loki distributor is dropping log lines"
            description: "Rate limiting or stream limits are causing log drops in namespace {{ $labels.namespace }}"

        # Alert when WAL replay is taking too long on startup
        - alert: LokiIngesterWALReplayRunning
          expr: |
            loki_ingester_wal_replay_active == 1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Loki ingester WAL replay is taking over 10 minutes"
            description: "Ingester {{ $labels.pod }} WAL replay has been running for over 10 minutes. This may indicate a large backlog."

        # Alert on high query latency
        - alert: LokiQueryFrontendSlowQueries
          expr: |
            histogram_quantile(0.95,
              sum(rate(loki_query_frontend_retries_bucket[5m])) by (le)
            ) > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Loki P95 query latency exceeds 30 seconds"
            description: "Slow queries may indicate insufficient querier replicas or hot label sets."

        # Alert when compactor has not run recently
        - alert: LokiCompactorStalled
          expr: |
            time() - loki_compactor_last_successful_run_timestamp_seconds > 7200
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Loki compactor has not successfully run in 2 hours"
            description: "Compactor may be stuck. Check compactor pod logs in the logging namespace."
```

## Operational Runbook

### Checking ingest rate

```bash
# Real-time ingest rate via LogCLI
logcli query \
  --addr=http://loki-gateway.logging.svc.cluster.local \
  --org-id=production \
  --since=5m \
  'sum(rate({namespace=~".+"}[1m]))' \
  --limit=0

# Check distributor stats via API
kubectl exec -n logging -it \
  $(kubectl get pod -n logging -l app.kubernetes.io/component=distributor -o name | head -1) \
  -- wget -qO- http://localhost:3100/distributor/ring | grep -c "ACTIVE"
```

### Diagnosing missing logs

```bash
# Check Promtail for target discovery issues
kubectl logs -n logging -l app.kubernetes.io/name=promtail \
  --since=30m | grep -i "error\|warn\|dropped"

# Check if the target namespace is being scraped
kubectl exec -n logging \
  $(kubectl get pod -n logging -l app.kubernetes.io/name=promtail -o name | head -1) \
  -- wget -qO- http://localhost:3101/targets | python3 -m json.tool | \
  grep -A5 '"namespace": "production"'

# Check ingester ring health
kubectl exec -n logging -it \
  $(kubectl get pod -n logging -l app.kubernetes.io/component=ingester -o name | head -1) \
  -- wget -qO- http://localhost:3100/ring | python3 -m json.tool | \
  jq '.shards | map(select(.state != "ACTIVE"))'
```

### Querying logs from the command line

```bash
# Install LogCLI
curl -O -L "https://github.com/grafana/loki/releases/download/v3.3.0/logcli-linux-amd64.zip"
unzip logcli-linux-amd64.zip
chmod +x logcli-linux-amd64
mv logcli-linux-amd64 /usr/local/bin/logcli

# Set environment variables
export LOKI_ADDR=http://loki-gateway.logging.svc.cluster.local
export LOKI_ORG_ID=production

# Query recent errors
logcli query '{namespace="production", app="api-server"} |= "error"' \
  --since=1h \
  --limit=100

# Follow live logs
logcli query '{namespace="production", app="api-server"}' \
  --tail \
  --since=5m
```

## Summary

Loki in distributed mode provides enterprise-scale log aggregation at object storage costs, with the architectural flexibility to scale individual components independently based on actual bottlenecks. The key operational decisions for production deployment are:

1. Size ingesters with adequate WAL storage (at least 30 minutes of ingest at peak rate) to survive transient S3 outages without data loss
2. Enable zone-aware replication for ingesters to survive availability zone failures
3. Use per-tenant retention overrides to balance storage costs — security and audit logs require longer retention than application debug logs
4. Tune the compactor aggressively (`compaction_interval: 10m`) to reduce object storage costs through better chunk compression ratios
5. Monitor `loki_distributor_lines_received_total{status="dropped"}` as the primary SLO signal — any drops indicate rate limiting or stream limit violations requiring configuration changes
6. Use LogQL recording rules to pre-compute expensive metric queries for dashboards, reducing query-frontend load
