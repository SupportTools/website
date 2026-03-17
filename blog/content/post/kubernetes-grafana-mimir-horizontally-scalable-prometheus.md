---
title: "Kubernetes Grafana Mimir: Horizontally Scalable Prometheus-Compatible TSDB"
date: 2031-03-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Grafana Mimir", "Prometheus", "Monitoring", "Observability", "Time Series", "Thanos"]
categories:
- Kubernetes
- Monitoring
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Grafana Mimir as a horizontally scalable Prometheus-compatible TSDB, covering architecture components, multi-tenancy, object storage backends, Thanos migration, and cardinality management at scale."
more_link: "yes"
url: "/kubernetes-grafana-mimir-horizontally-scalable-prometheus/"
---

At Prometheus scale, the single-server model becomes a bottleneck. Series cardinality explodes with dynamic label sets, ingestion rate saturates single-node CPU, and long-term retention demands more storage than a single machine can economically provide. Grafana Mimir solves this through a fully horizontally scalable, multi-tenant TSDB that is wire-compatible with the Prometheus remote write API and query API — your existing Grafana dashboards and alerting rules work unchanged.

This guide covers Mimir's architecture at operational depth: deploying each component, configuring multi-tenancy, connecting object storage backends, migrating from Thanos, managing ruler and alertmanager, and controlling cardinality explosions before they degrade query performance.

<!--more-->

# Kubernetes Grafana Mimir: Horizontally Scalable Prometheus-Compatible TSDB

## Section 1: Mimir Architecture Deep Dive

### Component Overview

Mimir separates concerns into specialized components that scale independently:

**Write Path:**
- **Distributor**: Receives remote write requests, validates, deduplicates, and fans out to ingesters based on consistent hash ring. Stateless, horizontally scalable.
- **Ingester**: Holds recently written samples in memory (WAL-backed). Periodically flushes chunks to object storage. Stateful — uses ring-based replication (default RF=3).

**Read Path:**
- **Query Frontend**: Receives PromQL queries, splits time range into sub-queries, and dispatches to querier pool. Handles result caching.
- **Query Scheduler**: Optional component that manages the queue of sub-queries between frontend and queriers.
- **Querier**: Executes sub-queries against both ingesters (recent data) and store-gateways (historical data).
- **Store Gateway**: Loads block metadata and indexes from object storage. Serves historical chunks to queriers. Stateful — uses sharding ring.

**Compaction and Retention:**
- **Compactor**: Merges small blocks into larger ones (reduces query overhead), applies retention, and manages tenant data lifecycle.

**Long-Term Storage:**
- **Object Storage**: All blocks are ultimately stored in S3/GCS/Azure Blob. Mimir is a thin compute layer on top.

```
Prometheus → Remote Write → Distributor → Ingesters → Object Storage
                                                   ↓
Grafana → Query → Query Frontend → Querier ← Store Gateway ← Object Storage
```

## Section 2: Helm Deployment

### Prerequisites

```bash
# Add Grafana Helm chart repository
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# Check available Mimir versions
helm search repo grafana/mimir-distributed --versions | head -10

# Create namespace
kubectl create namespace monitoring

# Create object storage secret (S3 example)
kubectl create secret generic mimir-s3-credentials \
  --from-literal=access_key_id=<aws-access-key-id> \
  --from-literal=secret_access_key=<aws-secret-access-key> \
  -n monitoring
```

### Minimal Production Values

```yaml
# mimir-values.yaml
mimir:
  structuredConfig:
    # Multi-tenancy
    multitenancy_enabled: true

    # Ingester configuration
    ingester:
      ring:
        replication_factor: 3

    # Limits (global defaults, override per-tenant)
    limits:
      # Maximum number of active series per tenant
      max_global_series_per_user: 5000000
      # Maximum ingestion rate per tenant (samples/sec)
      ingestion_rate: 100000
      # Maximum ingestion burst
      ingestion_burst_size: 200000
      # Query time range limit
      max_query_lookback: 8760h  # 1 year
      # Maximum samples per query
      max_fetched_samples_per_query: 50000000

    # Common object storage configuration
    common:
      storage:
        backend: s3
        s3:
          bucket_name: my-mimir-blocks
          region: us-east-1

    # Block storage
    blocks_storage:
      backend: s3
      s3:
        bucket_name: my-mimir-blocks
        region: us-east-1
      tsdb:
        # Retention in object storage
        retention_period: 8760h  # 1 year
        # Block range period
        block_ranges_period: [2h0m0s, 12h0m0s, 24h0m0s]

    # Ruler storage
    ruler_storage:
      backend: s3
      s3:
        bucket_name: my-mimir-ruler
        region: us-east-1

    # Alertmanager storage
    alertmanager_storage:
      backend: s3
      s3:
        bucket_name: my-mimir-alertmanager
        region: us-east-1

# Component scaling
distributor:
  replicas: 3
  resources:
    requests:
      cpu: "1"
      memory: 2Gi
    limits:
      cpu: "2"
      memory: 4Gi

ingester:
  replicas: 6
  persistentVolume:
    enabled: true
    size: 50Gi
    storageClass: fast-ssd
  resources:
    requests:
      cpu: "4"
      memory: 16Gi
    limits:
      cpu: "8"
      memory: 32Gi
  # Zone-aware replication
  zoneAwareReplication:
    enabled: true
    topologyKey: topology.kubernetes.io/zone

querier:
  replicas: 4
  resources:
    requests:
      cpu: "2"
      memory: 8Gi
    limits:
      cpu: "4"
      memory: 16Gi

queryFrontend:
  replicas: 2
  resources:
    requests:
      cpu: "1"
      memory: 2Gi
    limits:
      cpu: "2"
      memory: 4Gi

storeGateway:
  replicas: 3
  persistentVolume:
    enabled: true
    size: 100Gi
    storageClass: standard
  zoneAwareReplication:
    enabled: true
    topologyKey: topology.kubernetes.io/zone
  resources:
    requests:
      cpu: "2"
      memory: 8Gi
    limits:
      cpu: "4"
      memory: 16Gi

compactor:
  replicas: 1
  persistentVolume:
    enabled: true
    size: 100Gi
    storageClass: standard
  resources:
    requests:
      cpu: "2"
      memory: 4Gi
    limits:
      cpu: "4"
      memory: 8Gi

ruler:
  enabled: true
  replicas: 2

alertmanager:
  enabled: true
  replicas: 3
  persistentVolume:
    enabled: true
    size: 1Gi

# Nginx gateway for multi-tenancy routing
nginx:
  enabled: true
  ingress:
    enabled: true
    ingressClassName: nginx
    hosts:
      - host: mimir.monitoring.internal.company.com
        paths:
          - path: /
            pathType: Prefix
    tls:
      - secretName: mimir-tls
        hosts:
          - mimir.monitoring.internal.company.com

# Minio for local testing (disable in production, use cloud object storage)
minio:
  enabled: false
```

```bash
# Deploy Mimir
helm upgrade --install mimir-distributed grafana/mimir-distributed \
  --namespace monitoring \
  --version 5.3.0 \
  -f mimir-values.yaml \
  --wait \
  --timeout 10m

# Verify deployment
kubectl get pods -n monitoring -l app.kubernetes.io/name=mimir-distributed

# Check distributor health
kubectl exec -n monitoring deployment/mimir-distributed-distributor -- \
  wget -qO- http://localhost:8080/ready
```

## Section 3: Multi-Tenancy Configuration

### Tenant Isolation Model

In Mimir, each Prometheus instance writes to a specific tenant using the `X-Scope-OrgID` HTTP header. The NGINX gateway or your ingress layer controls which header is set.

```yaml
# prometheus-remote-write-tenant1.yaml
# Configure Prometheus to write to Mimir with tenant ID
global:
  scrape_interval: 15s
  external_labels:
    cluster: prod-us-east-1
    environment: production

remote_write:
  - url: http://mimir-distributed-nginx.monitoring.svc.cluster.local/api/v1/push
    headers:
      X-Scope-OrgID: tenant1
    queue_config:
      max_samples_per_send: 10000
      max_shards: 50
      min_shards: 5
    write_relabel_configs:
      # Add tenant label to all metrics
      - target_label: tenant
        replacement: tenant1
```

### Per-Tenant Limits Override

```yaml
# mimir-tenant-overrides.yaml
# Applied via the runtime configuration
overrides:
  tenant1:
    # Higher limits for high-volume tenant
    max_global_series_per_user: 10000000
    ingestion_rate: 500000
    ingestion_burst_size: 1000000
    max_query_lookback: 8760h

  tenant2:
    # Lower limits for smaller tenant
    max_global_series_per_user: 1000000
    ingestion_rate: 10000
    ingestion_burst_size: 20000
    max_query_lookback: 2160h  # 90 days

  tenant-low-priority:
    # Deprioritize background tenants
    max_global_series_per_user: 500000
    ingestion_rate: 5000
    query_priority:
      enabled: true
      default_priority: 0
```

```bash
# Create ConfigMap with runtime overrides
kubectl create configmap mimir-runtime-config \
  --from-file=runtime-config.yaml=mimir-tenant-overrides.yaml \
  -n monitoring

# Update Mimir values to reference runtime config
cat >> mimir-values.yaml << 'EOF'
mimir:
  structuredConfig:
    runtime_config:
      file: /var/mimir/runtime-config.yaml
      period: 10s
EOF

helm upgrade mimir-distributed grafana/mimir-distributed \
  --namespace monitoring \
  -f mimir-values.yaml
```

### Grafana Data Source per Tenant

```yaml
# grafana-datasources-mimir.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  mimir-datasources.yaml: |
    apiVersion: 1
    datasources:
      - name: Mimir-Tenant1
        type: prometheus
        url: http://mimir-distributed-nginx.monitoring.svc.cluster.local/prometheus
        httpHeaderName1: X-Scope-OrgID
        httpHeaderValue1: tenant1
        isDefault: false
        editable: false

      - name: Mimir-Tenant2
        type: prometheus
        url: http://mimir-distributed-nginx.monitoring.svc.cluster.local/prometheus
        httpHeaderName1: X-Scope-OrgID
        httpHeaderValue1: tenant2
        isDefault: false
        editable: false

      - name: Mimir-Global-View
        type: prometheus
        url: http://mimir-distributed-nginx.monitoring.svc.cluster.local/prometheus
        # "anonymous" tenant gets data from all tenants (admin use only)
        isDefault: true
        editable: false
```

## Section 4: Object Storage Backend Configuration

### AWS S3 with IAM Roles for Service Accounts (IRSA)

```yaml
# mimir-s3-irsa-values.yaml (additions to main values)
serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/mimir-s3-role

mimir:
  structuredConfig:
    blocks_storage:
      backend: s3
      s3:
        bucket_name: my-mimir-blocks
        region: us-east-1
        # No explicit credentials needed with IRSA
        access_key_id: ""
        secret_access_key: ""
    ruler_storage:
      backend: s3
      s3:
        bucket_name: my-mimir-ruler
        region: us-east-1
    alertmanager_storage:
      backend: s3
      s3:
        bucket_name: my-mimir-alertmanager
        region: us-east-1
```

IAM policy for Mimir:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::my-mimir-blocks",
        "arn:aws:s3:::my-mimir-ruler",
        "arn:aws:s3:::my-mimir-alertmanager"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::my-mimir-blocks/*",
        "arn:aws:s3:::my-mimir-ruler/*",
        "arn:aws:s3:::my-mimir-alertmanager/*"
      ]
    }
  ]
}
```

### GCS Configuration

```yaml
mimir:
  structuredConfig:
    common:
      storage:
        backend: gcs
        gcs:
          bucket_name: my-mimir-blocks
    blocks_storage:
      backend: gcs
      gcs:
        bucket_name: my-mimir-blocks
    ruler_storage:
      backend: gcs
      gcs:
        bucket_name: my-mimir-ruler
    alertmanager_storage:
      backend: gcs
      gcs:
        bucket_name: my-mimir-alertmanager
```

### Azure Blob Storage Configuration

```yaml
mimir:
  structuredConfig:
    common:
      storage:
        backend: azure
        azure:
          account_name: mystorageaccount
          account_key: ""  # Use managed identity instead
          container_name: mimir-blocks
          endpoint_suffix: blob.core.windows.net
    blocks_storage:
      backend: azure
      azure:
        account_name: mystorageaccount
        container_name: mimir-blocks
```

## Section 5: Migration from Thanos

### Assessment and Planning

```bash
# Inventory your current Thanos setup
kubectl get pods -n monitoring | grep -E "thanos|prometheus"
kubectl get pvc -n monitoring

# Check current Thanos block storage
# List existing blocks in S3
aws s3 ls s3://my-thanos-blocks/ --recursive | grep meta.json | head -20

# Estimate migration complexity
# Check series count per Prometheus
curl -s http://prometheus:9090/api/v1/query?query=prometheus_tsdb_head_series | \
  jq '.data.result[].value[1]'
```

### Migration Strategy: Sidecar to Remote Write

The recommended migration path is to keep Thanos running while gradually migrating write traffic to Mimir:

```yaml
# Phase 1: Add Mimir remote write alongside Thanos
# prometheus.yaml - add Mimir remote write without removing Thanos sidecar
remote_write:
  - url: http://mimir-distributed-nginx.monitoring.svc.cluster.local/api/v1/push
    headers:
      X-Scope-OrgID: migrated-tenant
    queue_config:
      max_samples_per_send: 10000
      max_shards: 30
    # Start with a subset of metrics for validation
    write_relabel_configs:
      - source_labels: [__name__]
        regex: "node_.*|container_.*|kube_.*"
        action: keep
```

```bash
# Phase 2: Migrate historical Thanos blocks to Mimir
# Use Mimir's block importer for existing Thanos blocks
kubectl run mimir-importer \
  --image=grafana/mimirtool:latest \
  --restart=Never \
  --namespace=monitoring \
  -- \
  mimirtool backfill \
  --address=http://mimir-distributed-nginx.monitoring.svc.cluster.local \
  --id=migrated-tenant \
  --backend=s3 \
  --bucket=my-thanos-blocks \
  --region=us-east-1

# Monitor import progress
kubectl logs -n monitoring mimir-importer -f
```

### Ruler Migration from Thanos

```bash
# Export Thanos recording rules and alerting rules
kubectl get prometheusrule -A -o yaml > /tmp/thanos-rules.yaml

# Convert to Mimir ruler format
mimirtool rules load \
  --address=http://mimir-distributed-nginx.monitoring.svc.cluster.local \
  --id=migrated-tenant \
  /tmp/thanos-rules.yaml

# Verify rules were loaded
mimirtool rules list \
  --address=http://mimir-distributed-nginx.monitoring.svc.cluster.local \
  --id=migrated-tenant
```

## Section 6: Rule Evaluation Configuration

### AlertingRule and RecordingRule in Mimir

```yaml
# mimir-rules-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mimir-recording-rules
  namespace: monitoring
data:
  node-recording-rules.yaml: |
    groups:
      - name: node.recording
        interval: 1m
        rules:
          - record: job:node_cpu_utilization:mean5m
            expr: |
              1 - avg without(cpu) (
                rate(node_cpu_seconds_total{mode="idle"}[5m])
              )

          - record: job:node_memory_utilization:ratio
            expr: |
              1 - (
                node_memory_MemAvailable_bytes /
                node_memory_MemTotal_bytes
              )

  kubernetes-alerting-rules.yaml: |
    groups:
      - name: kubernetes.pods
        rules:
          - alert: PodCrashLooping
            expr: |
              rate(kube_pod_container_status_restarts_total[15m]) * 60 * 5 > 0
            for: 15m
            labels:
              severity: critical
            annotations:
              summary: "Pod {{ $labels.pod }} is crash looping"
              description: "Pod {{ $labels.namespace }}/{{ $labels.pod }} has restarted {{ $value }} times in the last 5 minutes"
```

```bash
# Load rules into Mimir via mimirtool
mimirtool rules load \
  --address=http://mimir-distributed-nginx.monitoring.svc.cluster.local \
  --id=tenant1 \
  /path/to/recording-rules.yaml \
  /path/to/alerting-rules.yaml

# Verify rule evaluation
mimirtool rules verify \
  --address=http://mimir-distributed-nginx.monitoring.svc.cluster.local \
  --id=tenant1

# Check ruler component is evaluating rules
kubectl logs -n monitoring deployment/mimir-distributed-ruler | grep -E "eval|error"
```

### Alertmanager Configuration

```yaml
# mimir-alertmanager-config.yaml
global:
  resolve_timeout: 5m
  smtp_from: "alerting@company.com"
  smtp_smarthost: "smtp.company.com:587"

route:
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: 'pagerduty-critical'
  routes:
    - match:
        severity: critical
      receiver: pagerduty-critical
      continue: true
    - match:
        severity: warning
      receiver: slack-warnings

receivers:
  - name: pagerduty-critical
    pagerduty_configs:
      - routing_key: <pagerduty-routing-key>
        description: '{{ .GroupLabels.alertname }} - {{ .GroupLabels.cluster }}'

  - name: slack-warnings
    slack_configs:
      - api_url: '<slack-webhook-url>'
        channel: '#alerts-warning'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'

inhibit_rules:
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname', 'cluster']
```

```bash
# Load Alertmanager config for a tenant
mimirtool alertmanager load \
  --address=http://mimir-distributed-nginx.monitoring.svc.cluster.local \
  --id=tenant1 \
  alertmanager-config.yaml

# Verify config was loaded
mimirtool alertmanager get \
  --address=http://mimir-distributed-nginx.monitoring.svc.cluster.local \
  --id=tenant1
```

## Section 7: Cardinality Management at Scale

### Understanding Cardinality

Cardinality is the number of unique time series. It's determined by the cross-product of all label values. High cardinality is the most common cause of Mimir performance degradation.

```
series_count = |label1_values| × |label2_values| × |label3_values| × ...
```

A metric with `env` (3 values) × `cluster` (50 values) × `pod` (1000 values) = 150,000 series from that one metric.

### Identifying High-Cardinality Metrics

```bash
# Query Mimir for highest cardinality metrics (via mimirtool)
mimirtool analyze prometheus \
  --address=http://mimir-distributed-nginx.monitoring.svc.cluster.local \
  --id=tenant1 \
  --grafana-org-id=1

# Direct query for active series count per metric
curl -s \
  -H "X-Scope-OrgID: tenant1" \
  "http://mimir-distributed-nginx.monitoring.svc.cluster.local/prometheus/api/v1/query" \
  --data-urlencode 'query=topk(20, count by (__name__)({__name__=~".+"}))' | \
  jq -r '.data.result[] | "\(.metric.__name__): \(.value[1])"' | \
  sort -t: -k2 -rn | head -20

# Check ingester in-memory series per tenant
curl -s http://mimir-distributed-ingester-0.mimir-distributed-ingester.monitoring.svc:8080/api/v1/user_stats
```

### Cardinality Reduction Strategies

**1. Drop high-cardinality labels at scrape time:**

```yaml
# prometheus scrape config - drop noisy labels
scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    metric_relabel_configs:
      # Remove pod hash from deployment labels
      - source_labels: [pod_template_hash]
        action: labeldrop
      # Normalize pod names for ReplicaSets
      - source_labels: [pod]
        regex: "(.+)-[a-z0-9]+-[a-z0-9]+"
        target_label: pod
        replacement: "${1}-<hash>"
      # Drop high-cardinality request URL labels
      - source_labels: [__name__, url]
        regex: "http_requests_total;.+"
        action: drop
```

**2. Aggregate at ingest with recording rules:**

```yaml
# Replace high-cardinality metric with pre-aggregated version
groups:
  - name: cardinality.reduction
    rules:
      # Aggregate per-pod http metrics to per-deployment level
      - record: deployment:http_requests_total:rate5m
        expr: |
          sum without(pod, pod_template_hash) (
            rate(http_requests_total[5m])
          )
```

**3. Configure per-metric cardinality limits:**

```yaml
# mimir-values.yaml additions
mimir:
  structuredConfig:
    limits:
      # Limit labels per metric
      max_label_names_per_series: 30
      # Limit label value length
      max_label_value_length: 2048
      # Reject ingestion if over limit (instead of silently dropping)
      reject_old_samples: true
      reject_old_samples_max_age: 1h
```

### Cardinality Monitoring Dashboard

```bash
# Query for cardinality metrics built into Mimir
# Active series per tenant
curl -s \
  -H "X-Scope-OrgID: tenant1" \
  "http://mimir.monitoring.svc/prometheus/api/v1/query" \
  --data-urlencode 'query=sum(cortex_ingester_memory_series)' | \
  jq '.data.result[].value[1]'

# Ingestion rate
curl -s \
  -H "X-Scope-OrgID: tenant1" \
  "http://mimir.monitoring.svc/prometheus/api/v1/query" \
  --data-urlencode 'query=sum(rate(cortex_distributor_received_samples_total[5m]))' | \
  jq '.data.result[].value[1]'
```

## Section 8: Query Performance Optimization

### Query Frontend Caching

```yaml
# Enable query result caching in Mimir
mimir:
  structuredConfig:
    frontend:
      cache_results: true
      results_cache:
        backend: memcached
        memcached:
          addresses: "dns+memcached.monitoring.svc.cluster.local:11211"
          max_async_concurrency: 50
          max_get_multi_batch_size: 100
      # Split queries by time interval for better cache utilization
      split_queries_by_interval: 24h
      # Align query start/end to step for higher cache hit rate
      align_queries_with_step: true

# Deploy Memcached alongside Mimir
memcached:
  enabled: true
  replicaCount: 3
  resources:
    requests:
      cpu: "1"
      memory: 4Gi
    limits:
      cpu: "2"
      memory: 8Gi
```

### Query Sharding

```yaml
mimir:
  structuredConfig:
    frontend:
      # Number of shards per query
      query_sharding_total_shards: 16
      query_sharding_max_regrouping_shards: 64
    # Enable parallel query execution
    querier:
      max_concurrent: 20
```

## Section 9: Monitoring Mimir Itself

### Key Mimir Metrics to Watch

```yaml
# prometheus-alertrules-mimir.yaml
groups:
  - name: mimir.operational
    rules:
      - alert: MimirIngestionRateTooHigh
        expr: |
          sum(rate(cortex_distributor_received_samples_total[5m]))
          /
          sum(cortex_limits_overrides{limit_name="ingestion_rate"}) > 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Mimir ingestion approaching rate limit"

      - alert: MimirIngesterUnhealthy
        expr: |
          cortex_ring_members{name="ingester", state="Unhealthy"} > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Mimir ingester is unhealthy"
          description: "{{ $value }} ingester(s) in Unhealthy state"

      - alert: MimirCompactorNotRunning
        expr: |
          absent(rate(cortex_compactor_runs_completed_total[2h])) == 1
          or
          rate(cortex_compactor_runs_completed_total[2h]) == 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Mimir compactor has not run in 2 hours"

      - alert: MimirQueryFrontendSlowQuery
        expr: |
          histogram_quantile(0.99,
            sum by (le) (
              rate(cortex_query_frontend_query_range_duration_seconds_bucket[5m])
            )
          ) > 30
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Mimir query P99 latency is above 30 seconds"
          description: "P99 query latency: {{ $value }}s"

      - alert: MimirStoreGatewayHighErrorRate
        expr: |
          rate(cortex_storegateway_blocks_fetch_failure_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Mimir store-gateway has high block fetch error rate"
```

### Grafana Dashboard for Mimir Operational Health

```bash
# Import official Mimir dashboards from Grafana's dashboard repository
# Dashboard IDs available at grafana.com/grafana/dashboards

# Mimir Overview: 14058
# Mimir Reads: 14059
# Mimir Writes: 14060
# Mimir Compactor: 14061
# Mimir Object Store: 14062

kubectl apply -f - << 'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: mimir-dashboards
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  mimir-import.json: |
    {"id": null, "title": "Mimir Operational Dashboards", "import_ids": [14058, 14059, 14060]}
EOF
```

## Section 10: Operational Runbook

### Scaling Ingesters

```bash
# Scale ingesters up (add capacity without data loss)
kubectl scale statefulset mimir-distributed-ingester \
  --replicas=9 \
  -n monitoring

# Monitor ring membership
kubectl exec -n monitoring \
  deployment/mimir-distributed-distributor -- \
  wget -qO- http://localhost:8080/distributor/ring

# Verify ingesters are registered and ACTIVE
# New ingesters join as JOINING, transition to ACTIVE, then become eligible
watch -n 5 'kubectl exec -n monitoring deployment/mimir-distributed-distributor -- wget -qO- http://localhost:8080/distributor/ring | grep -E "ACTIVE|JOINING|LEAVING"'
```

### Flushing Ingesters Before Maintenance

```bash
# Before decommissioning an ingester, flush its in-memory data to object storage
INGESTER_POD="mimir-distributed-ingester-0"

# Trigger flush
kubectl exec -n monitoring ${INGESTER_POD} -- \
  wget -qO- --post-data="" http://localhost:8080/ingester/flush

# Wait for flush to complete (monitor disk activity)
kubectl exec -n monitoring ${INGESTER_POD} -- \
  wget -qO- http://localhost:8080/metrics | grep cortex_ingester_memory_series

# Shutdown the ingester gracefully
kubectl exec -n monitoring ${INGESTER_POD} -- \
  wget -qO- --post-data="" http://localhost:8080/ingester/shutdown
```

### Troubleshooting Query Failures

```bash
# Check query frontend logs for rejected queries
kubectl logs -n monitoring deployment/mimir-distributed-query-frontend | \
  grep -E "ERR|WARN|limit" | tail -50

# Check if queries are being rate limited
curl -s -H "X-Scope-OrgID: tenant1" \
  "http://mimir.monitoring.svc/prometheus/api/v1/query_range" \
  --data-urlencode 'query=up' \
  --data-urlencode 'start=2031-03-01T00:00:00Z' \
  --data-urlencode 'end=2031-03-24T00:00:00Z' \
  --data-urlencode 'step=300' | jq '.status, .error'

# Check store-gateway has blocks loaded
kubectl logs -n monitoring statefulset/mimir-distributed-store-gateway | \
  grep -E "loaded|synced|error" | tail -30

# Verify blocks are accessible in object storage
aws s3 ls s3://my-mimir-blocks/tenant1/ | wc -l
```

## Conclusion

Grafana Mimir provides the horizontal scalability that production multi-cluster monitoring demands. The key architectural insight is the separation of ingest (distributors/ingesters), query (frontend/querier/store-gateway), and compaction (compactor) into independently scalable components backed by cheap object storage.

The most common operational challenges are cardinality management (set limits before they become emergencies), ingester ring stability during scaling operations (use zone-aware replication to prevent correlated failures), and query frontend cache configuration (proper caching dramatically reduces store-gateway load for dashboard queries). Migrating from Thanos is straightforward using the remote write path — run both systems in parallel, validate results match, then decommission Thanos.
