---
title: "VictoriaMetrics: High-Performance Time Series Monitoring for Kubernetes"
date: 2027-04-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VictoriaMetrics", "Monitoring", "Prometheus", "Observability"]
categories: ["Kubernetes", "Monitoring"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying VictoriaMetrics as a Prometheus-compatible high-performance monitoring solution on Kubernetes, covering single-node, cluster mode, VMOperator, long-term storage, and migration from Prometheus."
more_link: "yes"
url: "/victoria-metrics-kubernetes-monitoring-guide/"
---

VictoriaMetrics offers a Prometheus-compatible time series database that delivers significantly better compression ratios, lower memory consumption, and higher ingestion throughput than Prometheus itself. Whether replacing a struggling Prometheus instance or building a long-term metrics store for a multi-cluster fleet, VictoriaMetrics integrates into existing Grafana and Alertmanager stacks with minimal disruption. This guide covers single-node and cluster deployments, the Victoria Metrics Operator (VMOperator), VMAgent as a drop-in Prometheus replacement, alerting with VMAlert, long-term retention strategies, and cardinality management.

<!--more-->

## VictoriaMetrics vs Prometheus

Understanding the key differences informs deployment decisions.

```
┌─────────────────────────────────────────────────────────────────────┐
│            VictoriaMetrics vs Prometheus Comparison                 │
├──────────────────────────┬──────────────────────┬───────────────────┤
│ Feature                  │ Prometheus           │ VictoriaMetrics   │
├──────────────────────────┼──────────────────────┼───────────────────┤
│ Storage compression      │ ~3.5 bytes/sample    │ ~0.4 bytes/sample │
│ Memory per million series│ ~1 GB                │ ~50 MB            │
│ Ingestion rate           │ ~2-3M samples/sec    │ ~10-50M samples/s │
│ MetricsQL vs PromQL      │ PromQL only          │ Both (superset)   │
│ Horizontal scalability   │ Limited (federation) │ Native (cluster)  │
│ Long-term storage        │ Requires Thanos/Cortex│ Built-in         │
│ Multi-tenancy            │ None                 │ VM Cluster        │
│ Downsampling             │ Recording rules only │ Built-in          │
│ Data deduplication       │ None                 │ Built-in          │
│ Prometheus compatibility │ N/A                  │ Full (RemoteWrite)│
└──────────────────────────┴──────────────────────┴───────────────────┘
```

## Single-Node Deployment

Single-node VictoriaMetrics suits most use cases up to ~10M active time series and replaces a Prometheus server directly.

```bash
# Add VictoriaMetrics Helm repository
helm repo add vm https://victoriametrics.github.io/helm-charts/
helm repo update

# Deploy single-node VictoriaMetrics
helm upgrade --install victoria-metrics vm/victoria-metrics-single \
  --namespace monitoring \
  --create-namespace \
  --version 0.9.0 \
  -f vm-single-values.yaml \
  --wait
```

```yaml
# vm-single-values.yaml
server:
  enabled: true
  image:
    repository: victoriametrics/victoria-metrics
    tag: v1.101.0
  retentionPeriod: "12"   # months
  extraArgs:
    maxLabelsPerTimeseries: "30"
    search.maxStalenessInterval: "5m"
    search.maxQueryDuration: "30s"
    search.maxPointsPerTimeseries: "30000"
    dedup.minScrapeInterval: "30s"
    logNewSeries: "false"
    memory.allowedPercent: "60"
    storage.minFreeDiskSpaceBytes: "10737418240"  # 10 GB
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 4000m
      memory: 8Gi
  persistentVolume:
    enabled: true
    storageClass: gp3
    size: 200Gi
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            topologyKey: kubernetes.io/hostname
            labelSelector:
              matchLabels:
                app: victoria-metrics-single-server
  tolerations:
    - key: monitoring
      operator: Equal
      value: "true"
      effect: NoSchedule
  nodeSelector:
    workload-type: monitoring
  service:
    servicePort: 8428
    type: ClusterIP
  scrape:
    enabled: true
    config:
      global:
        scrape_interval: 30s
        scrape_timeout: 10s
        evaluation_interval: 30s
      scrape_configs:
        - job_name: kubernetes-nodes
          kubernetes_sd_configs:
            - role: node
          scheme: https
          tls_config:
            ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
            insecure_skip_verify: true
          bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
          relabel_configs:
            - action: labelmap
              regex: __meta_kubernetes_node_label_(.+)
        - job_name: kubernetes-pods
          kubernetes_sd_configs:
            - role: pod
          relabel_configs:
            - source_labels:
                - __meta_kubernetes_pod_annotation_prometheus_io_scrape
              action: keep
              regex: "true"
            - source_labels:
                - __meta_kubernetes_pod_annotation_prometheus_io_path
              action: replace
              target_label: __metrics_path__
              regex: (.+)
            - source_labels:
                - __address__
                - __meta_kubernetes_pod_annotation_prometheus_io_port
              action: replace
              regex: (.+):(?:\d+);(\d+)
              replacement: $1:$2
              target_label: __address__
```

## VictoriaMetrics Cluster Mode

The cluster mode splits responsibilities across vmstorage, vminsert, and vmselect components, enabling horizontal scaling of each layer independently.

```
┌──────────────────────────────────────────────────────────────────────┐
│              VictoriaMetrics Cluster Architecture                    │
│                                                                      │
│  Data Sources                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                          │
│  │  VMAgent │  │Prometheus│  │  Pushes  │                          │
│  │(scraping)│  │(remoteWr)│  │ (SDK)    │                          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                          │
│       │              │              │                                │
│       ▼              ▼              ▼                                │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                vminsert (stateless, N replicas)             │    │
│  │  Receives data via HTTP /insert, routes to vmstorage shards │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                              │ Consistent hash sharding             │
│  ┌─────────────┐  ┌──────────┴────┐  ┌─────────────┐              │
│  │ vmstorage-0 │  │ vmstorage-1   │  │ vmstorage-2 │              │
│  │  (StatefulS)│  │  (StatefulS)  │  │ (StatefulS) │              │
│  └─────────────┘  └───────────────┘  └─────────────┘              │
│                              │                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                vmselect (stateless, N replicas)             │    │
│  │  Handles queries, aggregates results from vmstorage shards  │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                              │                                      │
│  ┌──────────────────────────▼──────────────────────────────────┐    │
│  │              Grafana / VMAlert / API Clients                │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

```bash
# Deploy VictoriaMetrics Cluster
helm upgrade --install victoria-metrics-cluster vm/victoria-metrics-cluster \
  --namespace monitoring \
  --version 0.12.0 \
  -f vm-cluster-values.yaml \
  --wait
```

```yaml
# vm-cluster-values.yaml
vmstorage:
  replicaCount: 3
  image:
    tag: v1.101.0-cluster
  extraArgs:
    retentionPeriod: "12"
    storageDataPath: /storage
    dedup.minScrapeInterval: "30s"
  resources:
    requests:
      cpu: 1000m
      memory: 4Gi
    limits:
      cpu: 4000m
      memory: 16Gi
  persistentVolume:
    enabled: true
    storageClass: gp3
    size: 500Gi
  podDisruptionBudget:
    enabled: true
    maxUnavailable: 1
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values:
                  - vmstorage
          topologyKey: kubernetes.io/hostname
  nodeSelector:
    workload-type: monitoring-storage
  tolerations:
    - key: monitoring-storage
      operator: Equal
      value: "true"
      effect: NoSchedule

vminsert:
  replicaCount: 2
  image:
    tag: v1.101.0-cluster
  extraArgs:
    maxLabelsPerTimeseries: "30"
    replicationFactor: "2"
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 2Gi
  podDisruptionBudget:
    enabled: true
    minAvailable: 1

vmselect:
  replicaCount: 2
  image:
    tag: v1.101.0-cluster
  cacheMountPath: /cache
  extraArgs:
    search.maxUniqueTimeseries: "3000000"
    search.maxQueryDuration: "30s"
    search.maxQueueDuration: "10s"
    search.maxConcurrentRequests: "32"
    search.cacheTimestampOffset: "5m"
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 4000m
      memory: 8Gi
  podDisruptionBudget:
    enabled: true
    minAvailable: 1
  persistentVolume:
    enabled: true
    storageClass: gp3
    size: 10Gi    # For query cache
```

## Victoria Metrics Operator (VMOperator)

The VMOperator provides a Kubernetes-native way to manage VictoriaMetrics components using CRDs, with full compatibility with Prometheus Operator CRDs.

### Installing VMOperator

```bash
helm upgrade --install victoria-metrics-operator vm/victoria-metrics-operator \
  --namespace monitoring \
  --version 0.35.0 \
  --set operator.disable_prometheus_converter=false \
  --set operator.prometheus_converter_add_argocd_ignore_annotations=true \
  --wait

# Verify CRDs are installed
kubectl get crd | grep victoriametrics
```

### VMCluster CRD

```yaml
# vmcluster.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMCluster
metadata:
  name: main-cluster
  namespace: monitoring
spec:
  retentionPeriod: "12"   # months
  replicationFactor: 2
  vmstorage:
    replicaCount: 3
    image:
      tag: v1.101.0-cluster
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          resources:
            requests:
              storage: 500Gi
    resources:
      requests:
        cpu: 1
        memory: 4Gi
      limits:
        cpu: 4
        memory: 16Gi
    extraArgs:
      dedup.minScrapeInterval: 30s
    topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: vmstorage
    podDisruptionBudget:
      maxUnavailable: 1
  vminsert:
    replicaCount: 2
    image:
      tag: v1.101.0-cluster
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        cpu: 2
        memory: 2Gi
    extraArgs:
      replicationFactor: "2"
  vmselect:
    replicaCount: 2
    image:
      tag: v1.101.0-cluster
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: 4
        memory: 8Gi
    cacheMountPath: /cache
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          resources:
            requests:
              storage: 10Gi
    extraArgs:
      search.maxUniqueTimeseries: "3000000"
      search.maxQueryDuration: 30s
```

### VMAgent: Prometheus-Compatible Scraper

VMAgent is a lightweight, resource-efficient scraping agent that replaces the full Prometheus server for data collection. It supports horizontal sharding for large scrape configurations.

```yaml
# vmagent.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMAgent
metadata:
  name: main-agent
  namespace: monitoring
spec:
  image:
    tag: v1.101.0
  scrapeInterval: 30s
  externalLabels:
    cluster: production-us-east-1
    environment: production
  remoteWrite:
    - url: http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write
      basicAuth:
        username:
          name: vmauth-secret
          key: username
        password:
          name: vmauth-secret
          key: password
      queueOptions:
        capacity: 100000
        maxSamplesPerSend: 10000
        maxBlockSize: 8388608
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 1Gi
  # Horizontal sharding for large scrape configs
  shardCount: 2
  serviceAccountName: vmagent
  selectAllByDefault: false
  # Select which ServiceMonitors and PodMonitors to scrape
  serviceMonitorSelector:
    matchLabels:
      monitoring: "true"
  serviceMonitorNamespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: NotIn
        values:
          - kube-node-lease
  podMonitorSelector:
    matchLabels:
      monitoring: "true"
  nodeSelector:
    kubernetes.io/os: linux
  tolerations:
    - effect: NoSchedule
      operator: Exists
  extraArgs:
    promscrape.streamParse: "true"
    promscrape.maxScrapeSize: "33554432"  # 32MB
    remoteWrite.maxDiskUsagePerURL: "1073741824"  # 1GB
    remoteWrite.tmpDataPath: /tmp/vmagent-remotewrite-data
```

### VMServiceScrape for Service Discovery

```yaml
# vm-service-scrape.yaml
---
# Scrape kube-state-metrics
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMServiceScrape
metadata:
  name: kube-state-metrics
  namespace: monitoring
  labels:
    monitoring: "true"
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
  endpoints:
    - port: http
      interval: 30s
      scrapeTimeout: 10s
      honorLabels: true
      metricRelabelConfigs:
        - action: drop
          sourceLabels:
            - __name__
          regex: "kube_pod_container_resource_(requests|limits)"
---
# Scrape node-exporter
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMServiceScrape
metadata:
  name: node-exporter
  namespace: monitoring
  labels:
    monitoring: "true"
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: prometheus-node-exporter
  endpoints:
    - port: metrics
      interval: 30s
      scrapeTimeout: 10s
      relabelings:
        - action: replace
          regex: (.*)
          replacement: $1
          sourceLabels:
            - __meta_kubernetes_pod_node_name
          targetLabel: node
---
# Scrape application pods with annotation-based discovery
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMPodScrape
metadata:
  name: annotated-pods
  namespace: production
  labels:
    monitoring: "true"
spec:
  namespaceSelector:
    matchNames:
      - production
      - staging
  selector:
    matchLabels: {}
  podMetricsEndpoints:
    - port: metrics
      path: /metrics
      interval: 30s
      relabelings:
        - action: keep
          sourceLabels:
            - __meta_kubernetes_pod_annotation_prometheus_io_scrape
          regex: "true"
        - action: replace
          sourceLabels:
            - __meta_kubernetes_pod_annotation_prometheus_io_path
          targetLabel: __metrics_path__
          regex: (.+)
```

## VMAlert: Alerting Engine

VMAlert is a Prometheus-compatible alerting component that evaluates alerting rules against VictoriaMetrics and sends alerts to Alertmanager.

```yaml
# vmalert.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMAlert
metadata:
  name: main-alerts
  namespace: monitoring
spec:
  image:
    tag: v1.101.0
  replicaCount: 2
  datasource:
    url: http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus
  remoteWrite:
    url: http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write
  remoteRead:
    url: http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus
  notifiers:
    - url: http://alertmanager.monitoring.svc.cluster.local:9093
  evaluationInterval: 30s
  externalLabels:
    cluster: production-us-east-1
    environment: production
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  ruleSelector:
    matchLabels:
      monitoring: "true"
  ruleNamespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: NotIn
        values:
          - kube-node-lease
  extraArgs:
    rule.maxResolveDuration: 5m
    http.pathPrefix: /vmalert
```

### VMRule: Alert Rule Definitions

```yaml
# vmrule-kubernetes.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata:
  name: kubernetes-rules
  namespace: monitoring
  labels:
    monitoring: "true"
spec:
  groups:
    - name: kubernetes.node
      interval: 30s
      rules:
        - alert: NodeNotReady
          expr: kube_node_status_condition{condition="Ready",status="true"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Kubernetes node {{ $labels.node }} is not ready"
            description: "Node {{ $labels.node }} has been not ready for more than 5 minutes."
        - alert: NodeHighCPUUsage
          expr: |
            (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) by (instance)) * 100 > 85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High CPU usage on node {{ $labels.instance }}"
            description: "CPU usage on {{ $labels.instance }} has exceeded 85% for 10 minutes."
        - alert: NodeDiskPressure
          expr: |
            (node_filesystem_size_bytes{fstype!~"tmpfs|overlay"} -
             node_filesystem_free_bytes{fstype!~"tmpfs|overlay"})
            / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"} * 100 > 85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Disk usage above 85% on {{ $labels.instance }}"
            description: "Filesystem {{ $labels.mountpoint }} on {{ $labels.instance }} is {{ $value | humanizePercentage }} full."
    - name: kubernetes.pod
      interval: 30s
      rules:
        - alert: PodCrashLooping
          expr: |
            rate(kube_pod_container_status_restarts_total[15m]) * 60 * 15 > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping"
            description: "Container {{ $labels.container }} in pod {{ $labels.namespace }}/{{ $labels.pod }} has restarted {{ $value }} times in the last 15 minutes."
        - alert: PodOOMKilled
          expr: |
            kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Container OOM killed in {{ $labels.namespace }}/{{ $labels.pod }}"
            description: "Container {{ $labels.container }} was killed due to out-of-memory."
    - name: victoriametrics.health
      interval: 30s
      rules:
        - alert: VMStorageDiskRunningOut
          expr: |
            (vm_free_disk_space_bytes / vm_data_size_bytes) * (1 / rate(vm_data_size_bytes[1h])) < 86400
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "VictoriaMetrics storage disk space will run out in less than 24h"
            description: "vmstorage {{ $labels.pod }} will run out of disk space in {{ $value | humanizeDuration }}."
        - alert: VMInsertOverflow
          expr: |
            rate(vm_rpc_rows_dropped_total[5m]) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "VictoriaMetrics is dropping data samples"
            description: "vminsert {{ $labels.pod }} is dropping {{ $value }} rows/s due to full queue."
        - alert: VMSelectQueryCacheHitRate
          expr: |
            rate(vm_cache_hits_total{type="promql"}[5m])
            / (rate(vm_cache_hits_total{type="promql"}[5m]) + rate(vm_cache_misses_total{type="promql"}[5m]))
            < 0.5
          for: 30m
          labels:
            severity: info
          annotations:
            summary: "Low query cache hit rate on vmselect"
            description: "vmselect {{ $labels.pod }} has a query cache hit rate of {{ $value | humanizePercentage }}. Consider increasing cache size."
```

## Grafana Integration

```yaml
# grafana-datasource-vm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vm-datasource
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  datasource.yaml: |
    apiVersion: 1
    datasources:
      - name: VictoriaMetrics
        type: prometheus
        access: proxy
        url: http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus
        isDefault: true
        editable: false
        jsonData:
          prometheusType: victoriametrics
          prometheusVersion: 1.101.0
          timeInterval: "30s"
          queryTimeout: "30s"
          httpMethod: POST
          exemplarTraceIdDestinations:
            - name: traceID
              datasourceUid: tempo-uid
      - name: VictoriaMetrics-Cluster
        type: prometheus
        access: proxy
        url: http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus
        editable: false
        jsonData:
          prometheusType: victoriametrics
          prometheusVersion: 1.101.0-cluster
          customQueryParameters: "extra_labels=cluster=production-us-east-1"
```

## Long-Term Retention and Downsampling

VictoriaMetrics supports downsampling raw data for long-term retention to dramatically reduce storage costs.

```yaml
# vmcluster-with-downsampling.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMCluster
metadata:
  name: long-term-cluster
  namespace: monitoring
spec:
  retentionPeriod: "60"   # 5 years raw retention
  replicationFactor: 2
  vmstorage:
    replicaCount: 3
    extraArgs:
      # Downsample data for long-term storage
      # Data older than 30d will be downsampled to 5m resolution
      # Data older than 365d will be downsampled to 1h resolution
      downsampling.period: "30d:5m,365d:1h"
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          resources:
            requests:
              storage: 2Ti
  vminsert:
    replicaCount: 2
  vmselect:
    replicaCount: 2
    extraArgs:
      # Use deduplication for replicated data
      dedup.minScrapeInterval: "30s"
```

### vmbackup and vmrestore for Backups

```bash
# Create a snapshot of VictoriaMetrics data
kubectl -n monitoring exec -it vmstorage-0 -- \
  /usr/local/bin/vmbackup \
  -storageDataPath=/storage \
  -snapshot.createURL=http://localhost:8482/snapshot/create \
  -dst=s3://my-backup-bucket/vm-backups/$(date +%Y/%m/%d/%H%M)

# Script for automated daily backups
cat <<'EOF' > /usr/local/bin/vm-backup.sh
#!/usr/bin/env bash
set -euo pipefail

STORAGE_PATH="${1:-/storage}"
BUCKET="${2:-s3://my-backup-bucket}"
DATE_PATH="$(date +%Y/%m/%d)"

# Create snapshot
SNAPSHOT_URL=$(curl -sf http://localhost:8482/snapshot/create | jq -r '.snapshotName')
echo "Created snapshot: ${SNAPSHOT_URL}"

# Upload to S3
/usr/local/bin/vmbackup \
  -storageDataPath="${STORAGE_PATH}" \
  -snapshot.name="${SNAPSHOT_URL}" \
  -dst="${BUCKET}/vm-backups/${DATE_PATH}" \
  -concurrency=4

# Clean up snapshots older than 7 days
curl -sf "http://localhost:8482/snapshot/delete_all"

echo "Backup complete: ${BUCKET}/vm-backups/${DATE_PATH}"
EOF
```

## Cardinality Management

High cardinality is the most common cause of memory pressure in time series databases. VictoriaMetrics provides tools to identify and control cardinality.

```bash
# Check top cardinality metrics via API
curl -s "http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus/api/v1/status/tsdb" | \
  jq '.data.topN.seriesCountByMetricName[:20]'

# Find highest-cardinality label values
curl -s "http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus/api/v1/status/tsdb?topN=20&match[]=__name__=~'.+'" | \
  jq '.data.topN.seriesCountByLabelValuePair[:20]'

# VM-specific cardinality explorer API
curl -s "http://victoria-metrics:8428/api/v1/status/top_queries" | \
  jq '.data.topByAvgDuration[:10]'
```

### Relabeling to Reduce Cardinality

```yaml
# vmagent-relabel-config.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMAgent
metadata:
  name: main-agent
  namespace: monitoring
spec:
  # ... other config ...
  inlineScrapeConfig: |
    scrape_configs:
      - job_name: high-cardinality-app
        static_configs:
          - targets:
              - app-service:8080
        metric_relabel_configs:
          # Drop metrics with too-unique label values
          - source_labels:
              - __name__
              - request_id
            regex: "http_request_duration_seconds_bucket;.+"
            action: drop
          # Remove high-cardinality labels
          - regex: "(pod_ip|pod_uid|node_uid)"
            action: labeldrop
          # Replace unbounded user IDs with buckets
          - source_labels:
              - user_id
            regex: ".+"
            target_label: user_id
            replacement: "hashed"
            action: replace
```

### VMScrapeConfig for Drop Rules

```yaml
# drop-high-cardinality-rules.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMScrapeConfig
metadata:
  name: drop-noisy-metrics
  namespace: monitoring
  labels:
    monitoring: "true"
spec:
  staticConfigs:
    - targets:
        - noisy-app:9090
  metricRelabelings:
    # Drop all metrics matching these patterns
    - sourceLabels:
        - __name__
      regex: "(go_memstats_.+|process_.+|promhttp_metric_handler_.+)"
      action: drop
    # Keep only specific metrics
    - sourceLabels:
        - __name__
      regex: "(http_requests_total|http_request_duration_seconds_.+|app_.+)"
      action: keep
    # Truncate long path labels to /api/v1/*, /api/v2/* etc.
    - sourceLabels:
        - path
      regex: "(/api/v[0-9]+)/.*"
      targetLabel: path
      replacement: "${1}/..."
```

## Migration from Prometheus

### Remote Write from Existing Prometheus

```yaml
# prometheus-remote-write-to-vm.yaml
# Add to existing Prometheus configuration
remoteWrite:
  - url: http://victoria-metrics.monitoring.svc.cluster.local:8428/api/v1/write
    queueConfig:
      capacity: 100000
      maxSamplesPerSend: 10000
      batchSendDeadline: 5s
      maxRetries: 10
      minBackoff: 30ms
      maxBackoff: 5s
    writeRelabelConfigs:
      - sourceLabels:
          - __name__
        regex: "(unneeded_metric_.+)"
        action: drop
```

### Historical Data Migration with vmctl

```bash
# Install vmctl
curl -L https://github.com/VictoriaMetrics/VictoriaMetrics/releases/download/v1.101.0/vmutils-linux-amd64-v1.101.0.tar.gz | \
  tar -xzf - -C /usr/local/bin vmctl

# Migrate data from Prometheus to VictoriaMetrics
vmctl prometheus \
  --prom-snapshot=/path/to/prometheus-snapshot \
  --vm-addr=http://victoria-metrics.monitoring.svc.cluster.local:8428 \
  --vm-concurrency=4 \
  --vm-batch-size=50000 \
  --verbose

# Migrate between VictoriaMetrics instances
vmctl vm \
  --vm-addr=http://old-vm:8428 \
  --vm-native-dst-addr=http://new-vm:8428 \
  --vm-native-filter-time-start=2024-01-01T00:00:00Z \
  --vm-native-filter-time-end=2025-01-01T00:00:00Z \
  --vm-concurrency=4
```

## VMAuth: Authentication and Multi-Tenancy Proxy

VMAuth provides a lightweight HTTP proxy for authentication and routing to multiple VictoriaMetrics tenants.

```yaml
# vmauth.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMAuth
metadata:
  name: main-auth
  namespace: monitoring
spec:
  image:
    tag: v1.101.0
  ingress:
    class_name: contour
    host: metrics.company.com
    tlsSecretName: metrics-tls
  unauthorizedAccessConfig:
    - src_paths:
        - /health
      url_prefix: http://vmselect.monitoring.svc.cluster.local:8481/health
  userNamespaceSelector:
    matchLabels:
      monitoring-auth: "true"
  userSelector:
    matchLabels:
      role: metrics-reader
```

```yaml
# vmuser-readonly.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMUser
metadata:
  name: grafana-reader
  namespace: monitoring
  labels:
    role: metrics-reader
spec:
  username: grafana
  password: EXAMPLE_TOKEN_REPLACE_ME
  targetRefs:
    - paths:
        - /api/v1/query
        - /api/v1/query_range
        - /api/v1/label.*
        - /api/v1/series
        - /api/v1/status.*
        - /federate
      crd:
        kind: VMCluster
        name: main-cluster
        namespace: monitoring
        ## Only allow access to specific tenant
        url_suffix: /select/0/prometheus
```

## Troubleshooting VictoriaMetrics

```bash
# Check vmstorage health
kubectl -n monitoring exec -it vmstorage-0 -- \
  curl -s localhost:8482/health

# Check vmselect query execution time
kubectl -n monitoring logs deploy/vmselect --tail=100 | \
  grep -E "slow query|duration"

# Check vminsert ingestion rate
kubectl -n monitoring exec -it deploy/vminsert -- \
  curl -s localhost:8480/metrics | grep vm_rows_inserted_total

# Query active time series count
curl -s "http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus/api/v1/status/tsdb" | \
  jq '.data.totalSeriesCount'

# Find stale series
curl -s "http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus/api/v1/query?query=count({__name__=~'.+'})" | \
  jq '.data.result[0].value[1]'

# Check replication factor compliance
kubectl -n monitoring exec -it vmstorage-0 -- \
  curl -s localhost:8482/metrics | grep vm_missing_tsids_for_metric_id

# Diagnose slow selects
kubectl -n monitoring logs deploy/vmselect --tail=200 | \
  grep -E "slow|timeout|cancelled"
```

## Summary

VictoriaMetrics delivers compelling advantages over standard Prometheus for production Kubernetes environments: 5-10x compression improvement, dramatically lower memory usage at high cardinality, native horizontal scaling in cluster mode, and built-in downsampling for cost-effective long-term retention. The VMOperator ecosystem — VMAgent, VMAlert, VMRule, VMScrapeConfig, and VMAuth — provides a Prometheus Operator-compatible abstraction that simplifies migration without requiring teams to rewrite existing monitoring configurations. Start with single-node mode for clusters under 5M active series, adopt cluster mode when scaling horizontally, and deploy VMAgent shards when scrape target counts exceed what a single agent can handle efficiently.
