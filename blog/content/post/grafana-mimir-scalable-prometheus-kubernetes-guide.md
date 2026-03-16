---
title: "Grafana Mimir: Horizontally Scalable Prometheus for Enterprise"
date: 2027-01-01T00:00:00-05:00
draft: false
tags: ["Grafana Mimir", "Prometheus", "Kubernetes", "Monitoring", "Observability"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production deployment guide for Grafana Mimir on Kubernetes covering microservices architecture, object storage backends, multi-tenancy, ruler, and AlertManager integration."
more_link: "yes"
url: "/grafana-mimir-scalable-prometheus-kubernetes-guide/"
---

Prometheus is the de facto standard for Kubernetes monitoring, but the single-node architecture that makes it operationally simple becomes a liability at scale. A production environment with 500 services, each exposing hundreds of metrics, generates millions of active time series. A single Prometheus instance serving this cardinality faces practical limits: scrape intervals drift under load, compaction pauses affect query latency, and there is no native path to horizontal scaling or long-term retention beyond remote write to external systems.

**Grafana Mimir** is the horizontally scalable, multi-tenant, long-term storage backend purpose-built to receive Prometheus remote write traffic. It is the evolution of Cortex — the original CNCF project that proved the distributed Prometheus architecture — rewritten with production lessons from operating the Grafana Cloud metrics platform at petabyte scale. Mimir stores metrics in object storage (S3, GCS, or Azure Blob), scales each component independently, and supports query federation across arbitrary time ranges.

This guide covers Mimir's complete deployment on Kubernetes in both monolithic and microservices mode, S3 object storage configuration, multi-tenancy with tenant overrides, remote write from Prometheus and Grafana Alloy, ruler configuration for recording rules and alerts, and AlertManager integration for notification delivery.

<!--more-->

## Mimir vs Thanos vs Cortex

Understanding Mimir's position requires comparing it to the two established alternatives for scaling Prometheus.

### Thanos

Thanos extends existing Prometheus instances rather than replacing them. A Thanos Sidecar attaches to each Prometheus pod, uploads TSDB blocks to object storage, and makes them queryable through the Thanos Query layer. This approach preserves existing Prometheus deployments but adds operational complexity: every Prometheus instance requires a sidecar, the query layer must be aware of all Prometheus instances, and global deduplification requires the `external_labels` configuration to be consistent across all instances.

Thanos shines when the operational model requires keeping local Prometheus instances for reliability reasons — for example, when object storage is not always accessible. The local Prometheus instance still works during a cloud connectivity interruption.

### Cortex

Cortex is the CNCF project that Mimir supersedes. Mimir is a hard fork of Cortex that discards backward compatibility for architectural simplicity: the WAL-per-ingester replaced the chunk-based storage model, the block-based storage became the only storage backend, and numerous configuration options were simplified or removed. If running an existing Cortex deployment, the migration path to Mimir is documented and supported.

### Mimir

Mimir accepts metrics exclusively through remote write, has no dependency on running Prometheus instances, and stores all data directly in object storage blocks. The architecture is simpler than Thanos for new deployments and more scalable than single-node Prometheus.

**Key differentiators:**
- No per-Prometheus sidecar required; any agent that supports Prometheus remote write works
- Horizontally scalable ingesters and queriers
- Multi-tenancy enforced at the HTTP layer with `X-Scope-OrgID`
- Native AlertManager and Ruler components eliminate the need for separate Prometheus alert evaluation
- Grafana Cloud uses Mimir as its metrics backend, providing battle-tested confidence in the architecture

## Architecture: Component Roles

Mimir's microservices architecture maps each function to independently scalable components:

```
Prometheus/Alloy (remote write)
        |
        v
Distributor (stateless, fan-out with hashing)
        |
        v
Ingester (stateful, WAL + in-memory series)
        |
        v
Object Storage (S3/GCS/Azure Blob)
        ^
        |
Store Gateway (stateless, reads blocks from object storage)
        ^
        |
Querier (stateless, queries ingesters + store gateways)
        ^
        |
Query Frontend (stateless, query sharding + caching)
        |
        v
Grafana (PromQL queries)
```

**Distributor**: Receives remote write requests, validates metrics, and uses consistent hashing to route series to the appropriate ingester replicas. Stateless and horizontally scalable.

**Ingester**: Holds the most recent time series in memory and a write-ahead log. Periodically flushes TSDB blocks to object storage. Stateful; requires persistent storage for the WAL. Zone-aware replication distributes replicas across availability zones.

**Store Gateway**: Reads TSDB blocks from object storage and serves them to queriers. Uses a local cache to avoid repeated object storage downloads. Stateless from a data perspective but benefits from persistent storage for the local block cache.

**Querier**: Evaluates PromQL queries by fetching data from ingesters (for recent data) and store gateways (for historical data). Stateless.

**Query Frontend**: Sits in front of queriers, splits long-range queries into shorter sub-queries, caches results, and routes queries to querier pools. Stateless.

**Compactor**: Runs background compaction of TSDB blocks in object storage, merging small blocks into larger ones and applying retention policies.

**Ruler**: Evaluates recording rules and alerting rules using the same storage backend as queriers. Sends alerts to the built-in AlertManager.

**AlertManager**: Receives alerts from the Ruler and routes them to notification channels (Slack, PagerDuty, email). Multi-tenant, with per-tenant alert routing configuration.

## Monolithic Mode for Small Deployments

Monolithic mode runs all components in a single process. This is appropriate for organizations monitoring fewer than 1 million active series:

```yaml
# mimir-monolithic-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mimir-monolithic-config
  namespace: monitoring
data:
  config.yaml: |
    target: all
    multitenancy_enabled: false
    server:
      http_listen_port: 8080
      grpc_listen_port: 9095
    common:
      storage:
        backend: s3
        s3:
          bucket_name: mimir-metrics
          endpoint: minio.minio.svc.cluster.local:9000
          access_key_id: mimiruser
          secret_access_key: mimirpassword
          insecure: true
    blocks_storage:
      s3:
        bucket_name: mimir-blocks
      tsdb:
        retention_period: 2h
    compactor:
      data_dir: /data/compactor
      sharding_ring:
        kvstore:
          store: memberlist
    ingester:
      ring:
        kvstore:
          store: memberlist
        replication_factor: 1
    store_gateway:
      sharding_ring:
        replication_factor: 1
    ruler_storage:
      s3:
        bucket_name: mimir-ruler
    alertmanager_storage:
      s3:
        bucket_name: mimir-alertmanager
    ruler:
      enable_api: true
    alertmanager:
      enable_api: true
      external_url: http://mimir-monolithic.monitoring.svc.cluster.local:8080/alertmanager
    memberlist:
      join_members:
      - mimir-monolithic-0.mimir-monolithic.monitoring.svc.cluster.local
```

```yaml
# mimir-monolithic-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mimir-monolithic
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mimir-monolithic
  serviceName: mimir-monolithic
  template:
    metadata:
      labels:
        app: mimir-monolithic
    spec:
      containers:
      - name: mimir
        image: grafana/mimir:2.13.0
        args:
        - -config.file=/etc/mimir/config.yaml
        - -target=all
        ports:
        - name: http
          containerPort: 8080
        - name: grpc
          containerPort: 9095
        - name: gossip
          containerPort: 7946
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        volumeMounts:
        - name: config
          mountPath: /etc/mimir
        - name: data
          mountPath: /data
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
      volumes:
      - name: config
        configMap:
          name: mimir-monolithic-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: standard
      resources:
        requests:
          storage: 50Gi
```

## Microservices Mode with Helm

The Grafana Mimir Helm chart deploys all components as separate workloads, enabling independent scaling:

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm upgrade --install mimir grafana/mimir-distributed \
  --namespace monitoring \
  --create-namespace \
  --values values-mimir.yaml \
  --version 5.4.0
```

### Production Helm Values

```yaml
# values-mimir.yaml
mimir:
  structuredConfig:
    common:
      storage:
        backend: s3
        s3:
          bucket_name: mimir-metrics
          endpoint: s3.us-east-1.amazonaws.com
          region: us-east-1
    blocks_storage:
      s3:
        bucket_name: mimir-blocks
      tsdb:
        retention_period: 2h
    ruler_storage:
      s3:
        bucket_name: mimir-ruler
    alertmanager_storage:
      s3:
        bucket_name: mimir-alertmanager
    limits:
      ingestion_rate: 150000
      ingestion_burst_size: 300000
      max_global_series_per_user: 5000000
      max_label_names_per_series: 30
      ruler_max_rules_per_rule_group: 100
      ruler_max_rule_groups_per_tenant: 100

ingester:
  replicas: 3
  persistentVolume:
    enabled: true
    size: 50Gi
    storageClass: fast-ssd
  resources:
    requests:
      cpu: 1000m
      memory: 4Gi
    limits:
      cpu: 2000m
      memory: 8Gi
  zoneAwareReplication:
    enabled: true

distributor:
  replicas: 2
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi

querier:
  replicas: 2
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi

queryFrontend:
  replicas: 1
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

storeGateway:
  replicas: 3
  persistentVolume:
    enabled: true
    size: 20Gi
    storageClass: fast-ssd
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 1000m
      memory: 2Gi
  zoneAwareReplication:
    enabled: true

compactor:
  replicas: 1
  persistentVolume:
    enabled: true
    size: 20Gi
    storageClass: standard
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi

ruler:
  enabled: true
  replicas: 2
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

alertmanager:
  enabled: true
  replicas: 1
  persistentVolume:
    enabled: true
    size: 1Gi
    storageClass: standard

nginx:
  enabled: true
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

serviceMonitor:
  enabled: true
  namespace: monitoring
  interval: 30s

minio:
  enabled: false
```

### S3 Authentication with IAM Role

For EKS clusters using IRSA (IAM Roles for Service Accounts):

```yaml
ingester:
  serviceAccount:
    annotations:
      eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/mimir-s3-role

compactor:
  serviceAccount:
    annotations:
      eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/mimir-s3-role

storeGateway:
  serviceAccount:
    annotations:
      eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/mimir-s3-role
```

The IAM policy should grant `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the three Mimir buckets.

## Multi-Tenancy with X-Scope-OrgID

Mimir enforces tenant isolation through the `X-Scope-OrgID` HTTP header. Each metric series is stored in a per-tenant namespace in object storage. Tenants cannot query each other's data.

### Enabling Multi-Tenancy

```yaml
mimir:
  structuredConfig:
    multitenancy_enabled: true
```

When multi-tenancy is enabled, all requests without an `X-Scope-OrgID` header return a 401 response.

### Per-Tenant Limits via Runtime Configuration

Runtime configuration allows adjusting tenant limits without restarting the Mimir cluster:

```yaml
# mimir-runtime-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mimir-runtime-config
  namespace: monitoring
data:
  runtime.yaml: |
    overrides:
      team-platform:
        ingestion_rate: 200000
        ingestion_burst_size: 400000
        max_global_series_per_user: 10000000
        compactor_blocks_retention_period: 8760h
      team-frontend:
        ingestion_rate: 20000
        ingestion_burst_size: 40000
        max_global_series_per_user: 500000
        compactor_blocks_retention_period: 2160h
      team-ml:
        ingestion_rate: 50000
        ingestion_burst_size: 100000
        max_global_series_per_user: 2000000
        compactor_blocks_retention_period: 17520h
        query_sharding_total_shards: 32
```

Configure Mimir to load the runtime config:

```yaml
mimir:
  structuredConfig:
    runtime_config:
      file: /var/mimir/runtime.yaml
      period: 60s
```

## Remote Write from Prometheus and Alloy

### Prometheus Remote Write Configuration

```yaml
# prometheus-remote-write-values.yaml
prometheus:
  prometheusSpec:
    externalLabels:
      cluster: production-us-east-1
      region: us-east-1
    remoteWrite:
    - url: http://mimir-nginx.monitoring.svc.cluster.local/api/v1/push
      headers:
        X-Scope-OrgID: team-platform
      queueConfig:
        capacity: 10000
        maxSamplesPerSend: 5000
        batchSendDeadline: 5s
        minShards: 2
        maxShards: 20
        minBackoff: 30ms
        maxBackoff: 5s
      remoteTimeout: 30s
      writeRelabelConfigs:
      - sourceLabels: [__name__]
        regex: "go_gc_.*"
        action: drop
```

### Grafana Alloy Configuration

**Grafana Alloy** (the successor to Grafana Agent) provides a more powerful remote write pipeline with support for metric transformation, cardinality reduction, and multi-destination forwarding:

```hcl
// alloy-config.alloy
prometheus.scrape "kubernetes" {
  targets    = discovery.kubernetes.pods.targets
  forward_to = [prometheus.relabel.drop_high_cardinality.receiver]
}

prometheus.relabel "drop_high_cardinality" {
  rule {
    source_labels = ["__name__"]
    regex         = "container_tasks_state|container_memory_failures_total"
    action        = "drop"
  }

  forward_to = [prometheus.remote_write.mimir.receiver]
}

prometheus.remote_write "mimir" {
  endpoint {
    url = "http://mimir-nginx.monitoring.svc.cluster.local/api/v1/push"

    headers = {
      "X-Scope-OrgID" = env("MIMIR_TENANT_ID"),
    }

    queue_config {
      capacity             = 10000
      max_samples_per_send = 5000
      batch_send_deadline  = "5s"
      min_shards           = 2
      max_shards           = 20
    }
  }

  external_labels = {
    cluster = env("CLUSTER_NAME"),
    region  = env("AWS_REGION"),
  }
}
```

Deploy Alloy as a DaemonSet for node-level metric collection:

```bash
helm upgrade --install alloy grafana/alloy \
  --namespace monitoring \
  --set controller.type=daemonset \
  --set alloy.configMap.name=alloy-config \
  --version 0.9.0
```

## Ruler Configuration for Recording Rules and Alerts

### Uploading Rules via the Mimir API

Mimir provides a ruler API for managing recording rules and alerting rules per tenant:

```bash
MIMIR_URL="http://mimir-nginx.monitoring.svc.cluster.local"
TENANT="team-platform"

kubectl -n monitoring port-forward svc/mimir-nginx 8080:80 &

mimirtool rules load \
  --address=http://localhost:8080 \
  --id="${TENANT}" \
  rules/api-server.yaml \
  rules/kubernetes.yaml

mimirtool rules list \
  --address=http://localhost:8080 \
  --id="${TENANT}"
```

Install `mimirtool`:

```bash
curl -Lo mimirtool \
  "https://github.com/grafana/mimir/releases/download/mimir-2.13.0/mimirtool-linux-amd64"
chmod +x mimirtool
sudo mv mimirtool /usr/local/bin/
```

### Recording Rules and Alert Rules

```yaml
# rules-api-server.yaml
groups:
- name: api-server.rules
  interval: 30s
  rules:
  - record: job:http_requests_total:rate5m
    expr: |
      sum by (job, status_code) (
        rate(http_requests_total[5m])
      )
  - record: job:http_request_duration_seconds:p99_5m
    expr: |
      histogram_quantile(0.99,
        sum by (job, le) (
          rate(http_request_duration_seconds_bucket[5m])
        )
      )
- name: api-server.alerts
  rules:
  - alert: APIServerHighErrorRate
    expr: |
      sum(rate(http_requests_total{status_code=~"5.."}[5m]))
      /
      sum(rate(http_requests_total[5m])) > 0.05
    for: 5m
    labels:
      severity: critical
      team: platform
    annotations:
      summary: "API server error rate exceeds 5%"
      description: "Error rate is {{ humanizePercentage $value }} for the last 5 minutes"
  - alert: APIServerHighLatency
    expr: |
      histogram_quantile(0.99,
        sum by (le) (rate(http_request_duration_seconds_bucket[5m]))
      ) > 1
    for: 10m
    labels:
      severity: warning
      team: platform
    annotations:
      summary: "API server P99 latency exceeds 1 second"
      description: "P99 latency is {{ humanizeDuration $value }} over the last 5 minutes"
```

### Managing Rules in GitOps Workflows

Integrate rule uploads into CI/CD pipelines:

```bash
#!/usr/bin/env bash
set -euo pipefail

MIMIR_URL="${MIMIR_URL:-http://mimir-nginx.monitoring.svc.cluster.local}"
TENANT="${MIMIR_TENANT_ID:-team-platform}"

for rule_file in rules/*.yaml; do
  echo "Validating ${rule_file}"
  mimirtool rules check "${rule_file}"

  echo "Uploading ${rule_file} for tenant ${TENANT}"
  mimirtool rules load \
    --address="${MIMIR_URL}" \
    --id="${TENANT}" \
    "${rule_file}"
done

echo "Verifying rules loaded"
mimirtool rules list \
  --address="${MIMIR_URL}" \
  --id="${TENANT}"
```

## AlertManager Integration

### Per-Tenant AlertManager Configuration

Mimir's built-in AlertManager supports per-tenant routing configuration. Upload the configuration through the AlertManager API:

```yaml
# alertmanager-config-platform.yaml
global:
  resolve_timeout: 5m
  slack_api_url: "https://hooks.slack.com/services/TWORKSPACE/BCHANNEL/EXAMPLE_TOKEN_REPLACE_ME"
route:
  group_by: ['alertname', 'cluster', 'namespace']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: 'default'
  routes:
  - match:
      severity: critical
    receiver: pagerduty-critical
    continue: true
  - match:
      severity: warning
    receiver: slack-warnings
receivers:
- name: 'default'
  slack_configs:
  - channel: '#alerts-default'
    send_resolved: true
- name: pagerduty-critical
  pagerduty_configs:
  - routing_key: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    severity: critical
- name: slack-warnings
  slack_configs:
  - channel: '#alerts-warnings'
    send_resolved: true
    color: warning
inhibit_rules:
- source_match:
    severity: critical
  target_match:
    severity: warning
  equal: ['alertname', 'namespace']
```

Upload using `mimirtool`:

```bash
mimirtool alertmanager load \
  --address=http://localhost:8080 \
  --id=team-platform \
  alertmanager-config-platform.yaml

mimirtool alertmanager get \
  --address=http://localhost:8080 \
  --id=team-platform
```

## Query Federation

Mimir supports cross-tenant query federation through the query frontend's federation feature, enabling a "meta-tenant" to query multiple tenant namespaces:

```yaml
mimir:
  structuredConfig:
    limits:
      max_fetched_chunks_per_query: 2000000
    frontend:
      parallelize_shardable_queries: true
      query_sharding_target_series_per_shard: 2500
```

Query across multiple tenants using the `tenant-federation` query path:

```bash
curl -H "X-Scope-OrgID: team-platform|team-frontend|team-ml" \
  "http://mimir-nginx.monitoring.svc.cluster.local/prometheus/api/v1/query?query=sum(rate(http_requests_total[5m]))"
```

## Grafana Datasource Configuration

```yaml
# grafana-mimir-datasource.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasource-mimir
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  mimir-datasource.yaml: |
    apiVersion: 1
    datasources:
    - name: Mimir (team-platform)
      type: prometheus
      url: http://mimir-nginx.monitoring.svc.cluster.local/prometheus
      uid: mimir-platform
      jsonData:
        httpMethod: POST
        httpHeaderName1: X-Scope-OrgID
        prometheusType: Mimir
        prometheusVersion: 2.13.0
        manageAlerts: true
        alertmanagerUid: mimir-alertmanager
      secureJsonData:
        httpHeaderValue1: team-platform
    - name: Mimir AlertManager
      type: alertmanager
      url: http://mimir-nginx.monitoring.svc.cluster.local/alertmanager
      uid: mimir-alertmanager
      jsonData:
        httpMethod: GET
        httpHeaderName1: X-Scope-OrgID
        implementation: mimir
      secureJsonData:
        httpHeaderValue1: team-platform
```

## Operational Health Monitoring

### Key Mimir Metrics

Monitor the following metrics to assess cluster health:

```bash
cortex_ingester_active_series
cortex_distributor_samples_in_total
cortex_querier_query_seconds_bucket
cortex_compactor_runs_completed_total
cortex_storegateway_blocks_loaded
cortex_request_duration_seconds_bucket{route="/api/v1/push"}
```

### Critical Alerts for the Mimir Cluster Itself

```yaml
# rules-mimir-selfmon.yaml
groups:
- name: mimir.alerts
  rules:
  - alert: MimirIngesterUnhealthy
    expr: min(cortex_ring_members{state="ACTIVE",name="ingester"}) by (cluster) < 2
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Mimir has fewer than 2 healthy ingesters"
  - alert: MimirQuerierHighQueryLatency
    expr: |
      histogram_quantile(0.99,
        sum by (le, cluster) (rate(cortex_querier_query_seconds_bucket[5m]))
      ) > 10
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Mimir query P99 latency exceeds 10 seconds"
  - alert: MimirIngestionRateLimitReached
    expr: |
      sum(rate(cortex_distributor_ingestion_rate_limit_exceeded_total[5m])) by (cluster) > 0
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "Mimir ingestion rate limit being hit; increase limits or reduce cardinality"
```

## Conclusion

Grafana Mimir provides a production-grade, cloud-native replacement for single-node Prometheus in large-scale Kubernetes environments. The key operational takeaways:

- **Zone-aware replication for ingesters and store gateways is non-negotiable for HA**: With zone awareness enabled, Mimir distributes replicas across availability zones, surviving the loss of an entire zone without data loss or query disruption.
- **Runtime configuration enables zero-restart tenant limit adjustments**: The `runtime_config` file is reloaded periodically and applies per-tenant overrides immediately, making it the correct mechanism for managing tenants in dynamic environments without cluster restarts.
- **The Nginx gateway simplifies multi-tenant routing**: The built-in Nginx component in the Helm chart routes traffic to the correct component based on URL path, handles tenant header injection for internal components, and provides a single endpoint for all remote write and query traffic.
- **`mimirtool` is the operational interface**: Rule management, AlertManager configuration, cardinality analysis (`mimirtool analyze`), and tenant management all flow through `mimirtool`. Integrating it into CI/CD pipelines ensures rules are validated and deployed consistently.
- **Recording rules reduce query latency for dashboards**: Pre-computing frequently queried aggregations as recording rules with the Ruler component reduces query time from seconds to milliseconds for high-cardinality PromQL expressions in production dashboards.
