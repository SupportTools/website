---
title: "Kubernetes Monitoring with Prometheus: Production Deployment and Alerting Patterns"
date: 2027-09-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Monitoring", "Observability"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Prometheus on Kubernetes covering kube-prometheus-stack deployment, ServiceMonitor and PodMonitor patterns, recording rules for cluster health, alerting on SLO burn rates, federation for multi-cluster, and managing cardinality."
more_link: "yes"
url: "/kubernetes-monitoring-prometheus-production-guide/"
---

Running Prometheus reliably on Kubernetes at scale requires more than installing kube-prometheus-stack. Production deployments must address high-availability scrape coordination, persistent storage sizing, recording rule optimization to reduce query latency, cardinality management to prevent TSDB bloat, and multi-cluster federation that maintains signal fidelity without centralizing all metrics in a single store. This guide provides production-ready configurations and alerting patterns derived from operating large-scale Prometheus deployments.

<!--more-->

## Section 1: kube-prometheus-stack Production Deployment

### Helm Values for Production

```yaml
# kube-prometheus-stack-values.yaml
prometheus:
  prometheusSpec:
    # Retention and storage
    retention: 15d
    retentionSize: "80GB"
    walCompression: true

    # Storage
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 100Gi

    # Resources
    resources:
      requests:
        cpu: 500m
        memory: 2Gi
      limits:
        cpu: 2
        memory: 8Gi

    # Scrape configuration
    scrapeInterval: "15s"
    evaluationInterval: "15s"
    scrapeTimeout: "10s"

    # Remote write for long-term storage (Thanos/Cortex/VictoriaMetrics)
    remoteWrite:
    - url: http://thanos-receive.monitoring.svc.cluster.local:19291/api/v1/receive
      queueConfig:
        capacity: 10000
        maxShards: 30
        minShards: 1
        maxSamplesPerSend: 5000
        batchSendDeadline: 5s
        minBackoff: 30ms
        maxBackoff: 100ms
      writeRelabelConfigs:
      - sourceLabels: [__name__]
        regex: "go_.*|process_.*"
        action: drop    # Drop high-cardinality runtime metrics from remote write

    # Pod scheduling
    podAntiAffinity: "hard"
    topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: prometheus

    # Global ServiceMonitor selector (monitor all namespaces)
    serviceMonitorSelector: {}
    serviceMonitorNamespaceSelector: {}
    podMonitorSelector: {}
    podMonitorNamespaceSelector: {}
    ruleSelector: {}
    ruleNamespaceSelector: {}

    # Exclude system namespaces from default scraping
    excludedFromEnforcement:
    - namespace: monitoring
    - namespace: logging

alertmanager:
  alertmanagerSpec:
    retention: 120h
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 10Gi
    replicas: 3
    resources:
      requests:
        cpu: 50m
        memory: 50Mi
      limits:
        cpu: 200m
        memory: 256Mi

grafana:
  persistence:
    enabled: true
    storageClassName: gp3
    size: 20Gi
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  adminPassword: ""   # Set via external secret
  envFromSecret: grafana-admin-secret

kube-state-metrics:
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi

node-exporter:
  tolerations:
  - operator: Exists
  resources:
    requests:
      cpu: 100m
      memory: 30Mi
    limits:
      cpu: 250m
      memory: 64Mi
```

### Installing kube-prometheus-stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm upgrade --install kube-prometheus-stack \
  prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --values kube-prometheus-stack-values.yaml \
  --version 65.0.0 \
  --wait \
  --timeout 10m
```

## Section 2: ServiceMonitor and PodMonitor Patterns

### ServiceMonitor for Application Services

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api-service
  namespace: production
  labels:
    release: kube-prometheus-stack   # Must match Prometheus serviceMonitorSelector
spec:
  selector:
    matchLabels:
      app: api-service
  namespaceSelector:
    matchNames:
    - production
    - staging
  endpoints:
  - port: metrics           # Named port in the Service
    interval: "15s"
    scrapeTimeout: "10s"
    path: /metrics
    scheme: http
    honorLabels: false
    relabelings:
    # Add cluster label
    - targetLabel: cluster
      replacement: production-us-east-1
    # Normalize environment label
    - sourceLabels: [__meta_kubernetes_namespace]
      targetLabel: namespace
    metricRelabelings:
    # Drop high-cardinality histograms with too many le buckets
    - sourceLabels: [__name__]
      regex: "api_request_size_bytes.*"
      action: drop
    # Keep only p50/p90/p99 quantiles from summaries
    - sourceLabels: [__name__, quantile]
      regex: "go_gc_duration_seconds;(0|0\\.25|0\\.5|0\\.75|1)"
      action: keep
```

### PodMonitor for Sidecar Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: envoy-sidecar
  namespace: istio-system
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      security.istio.io/tlsMode: istio
  namespaceSelector:
    any: true
  podMetricsEndpoints:
  - port: http-envoy-prom
    path: /stats/prometheus
    interval: "30s"
    relabelings:
    - action: keep
      sourceLabels: [__meta_kubernetes_pod_container_name]
      regex: istio-proxy
    - sourceLabels: [__meta_kubernetes_pod_label_app]
      targetLabel: app
    metricRelabelings:
    # Keep only essential Envoy metrics
    - sourceLabels: [__name__]
      regex: "envoy_cluster_upstream_rq.*|envoy_cluster_upstream_cx.*|envoy_http_downstream_rq.*"
      action: keep
```

### ProbeMonitor for Blackbox Exporter

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Probe
metadata:
  name: external-endpoints
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  jobName: blackbox
  prober:
    url: blackbox-exporter.monitoring.svc.cluster.local:9115
    path: /probe
  module: http_2xx
  targets:
    staticConfig:
      static:
      - https://api.example.com/healthz
      - https://app.example.com/health
      labels:
        environment: production
```

## Section 3: Recording Rules for Cluster Health

Recording rules pre-compute expensive queries so dashboards load instantly.

### Node Resource Recording Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-resources
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
  - name: kubernetes.node.resources
    interval: 30s
    rules:
    # CPU utilization per node (1m average)
    - record: node:node_cpu_utilization:avg1m
      expr: |
        1 - avg by (node) (
          rate(node_cpu_seconds_total{mode="idle"}[1m])
        )

    # Memory utilization per node
    - record: node:node_memory_utilization:ratio
      expr: |
        1 - (
          node_memory_MemAvailable_bytes
          /
          node_memory_MemTotal_bytes
        )

    # Pod count per node
    - record: node:pod_count:sum
      expr: |
        count by (node) (
          kube_pod_info{phase="Running"}
        )

    # Allocatable CPU remaining
    - record: node:allocatable_cpu_remaining:ratio
      expr: |
        (
          kube_node_status_allocatable{resource="cpu"}
          - sum by (node) (
            kube_pod_container_resource_requests{resource="cpu"}
          )
        ) / kube_node_status_allocatable{resource="cpu"}

  - name: kubernetes.workload.resources
    interval: 60s
    rules:
    # Container CPU throttling ratio
    - record: container:cpu_throttled_ratio:rate5m
      expr: |
        rate(container_cpu_cfs_throttled_seconds_total[5m])
        /
        rate(container_cpu_cfs_periods_total[5m])

    # Container memory usage ratio against limit
    - record: container:memory_usage_ratio:current
      expr: |
        container_memory_working_set_bytes{container!=""}
        /
        kube_pod_container_resource_limits{resource="memory", container!=""}

    # Deployment availability ratio
    - record: deployment:available_ratio:current
      expr: |
        kube_deployment_status_replicas_available
        /
        kube_deployment_spec_replicas
```

### SLO Recording Rules

```yaml
  - name: slo.api.availability
    interval: 30s
    rules:
    # 5-minute error rate
    - record: slo:api_error_rate:rate5m
      expr: |
        sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
        /
        sum(rate(http_requests_total[5m])) by (service)

    # 1-hour error rate
    - record: slo:api_error_rate:rate1h
      expr: |
        sum(rate(http_requests_total{status=~"5.."}[1h])) by (service)
        /
        sum(rate(http_requests_total[1h])) by (service)

    # 30-day error budget consumption
    - record: slo:api_error_budget_remaining:30d
      expr: |
        1 - (
          sum_over_time(slo:api_error_rate:rate5m[30d])
          /
          (30 * 24 * 60 / 5)    # Number of 5m windows in 30d
        )
        /
        0.001   # 99.9% SLO = 0.1% error budget
```

## Section 4: SLO Burn Rate Alerting

Burn rate alerting detects when the error budget is being consumed faster than sustainable.

### Multi-Window Burn Rate Alert

```yaml
  - name: slo.alerting
    rules:
    # Fast burn: >14x burn rate on 1h window + 5m window (consumes 2% of 30d budget in 1h)
    - alert: APIHighBurnRate
      expr: |
        (
          slo:api_error_rate:rate1h > (14 * 0.001)
          and
          slo:api_error_rate:rate5m > (14 * 0.001)
        )
      for: 2m
      labels:
        severity: critical
        slo: api-availability
      annotations:
        summary: "High error budget burn rate for {{ $labels.service }}"
        description: |
          Service {{ $labels.service }} is burning error budget at
          {{ $value | humanizePercentage }} error rate (14x budget burn rate).
          At this rate, the 30-day error budget will be exhausted in ~2 hours.
        runbook_url: "https://runbooks.example.com/slo/high-burn-rate"

    # Slow burn: >3x burn rate on 6h window + 30m window (consumes 5% of 30d budget in 6h)
    - alert: APIMediumBurnRate
      expr: |
        (
          sum(rate(http_requests_total{status=~"5.."}[6h])) by (service)
          /
          sum(rate(http_requests_total[6h])) by (service)
        ) > (3 * 0.001)
        and
        slo:api_error_rate:rate5m > (3 * 0.001)
      for: 15m
      labels:
        severity: warning
        slo: api-availability
      annotations:
        summary: "Medium error budget burn rate for {{ $labels.service }}"
        description: |
          Service {{ $labels.service }} is burning error budget at 3x rate.
          Investigate within the next 24 hours.

    # Latency SLO: 99th percentile > 500ms for 5 minutes
    - alert: APILatencySLOViolation
      expr: |
        histogram_quantile(
          0.99,
          sum(rate(http_request_duration_seconds_bucket[5m])) by (service, le)
        ) > 0.5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "P99 latency SLO violation for {{ $labels.service }}"
        description: "P99 latency is {{ $value | humanizeDuration }}, exceeding 500ms SLO"
```

## Section 5: Alertmanager Configuration

### Production Alertmanager with Routing Trees

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: production-routing
  namespace: monitoring
spec:
  route:
    receiver: "null"
    groupBy: ["cluster", "namespace", "alertname"]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    routes:
    # Critical alerts: page immediately
    - matchers:
      - name: severity
        value: critical
      receiver: pagerduty-critical
      groupWait: 0s
      repeatInterval: 1h

    # SLO burn rate alerts
    - matchers:
      - name: slo
        matchType: "=~"
        value: ".+"
      receiver: slack-slo-channel
      groupWait: 1m
      repeatInterval: 4h

    # Warning alerts: slack only
    - matchers:
      - name: severity
        value: warning
      receiver: slack-warnings

    # Silence watchdog
    - matchers:
      - name: alertname
        value: Watchdog
      receiver: "null"

  receivers:
  - name: "null"
  - name: pagerduty-critical
    pagerDutyConfigs:
    - routingKey:
        name: pagerduty-secret
        key: routing-key
      description: "{{ range .Alerts }}{{ .Annotations.description }}{{ end }}"
      severity: "{{ .CommonLabels.severity }}"
      links:
      - href: "{{ .CommonAnnotations.runbook_url }}"
        text: Runbook
  - name: slack-slo-channel
    slackConfigs:
    - apiURL:
        name: slack-webhook-secret
        key: url
      channel: "#slo-violations"
      title: "{{ .CommonAnnotations.summary }}"
      text: "{{ range .Alerts }}{{ .Annotations.description }}\n{{ end }}"
      iconEmoji: ":fire:"
  - name: slack-warnings
    slackConfigs:
    - apiURL:
        name: slack-webhook-secret
        key: url
      channel: "#kubernetes-alerts"
      sendResolved: true
```

## Section 6: Cardinality Management

Uncontrolled label cardinality is the leading cause of Prometheus OOM crashes and query timeouts.

### Detecting High-Cardinality Metrics

```bash
# Top 20 metrics by series count
curl -s "http://prometheus:9090/api/v1/label/__name__/values" \
  | jq -r '.data[]' \
  | while read metric; do
      count=$(curl -s "http://prometheus:9090/api/v1/query?query=count({__name__=\"$metric\"})" \
        | jq -r '.data.result[0].value[1] // 0')
      echo "$count $metric"
    done | sort -rn | head -20

# Use the TSDB admin API for detailed analysis
curl -s http://prometheus:9090/api/v1/status/tsdb | \
  jq '.data.seriesCountByMetricName | to_entries | sort_by(.value) | reverse | .[0:20]'

# Find label values that are creating explosion
curl -s "http://prometheus:9090/api/v1/query?query=count(http_request_duration_seconds_bucket) by (pod)" \
  | jq '.data.result | length'
```

### Drop Rules and Relabeling

```yaml
# PrometheusRule to drop problematic metrics
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cardinality-control
  namespace: monitoring
spec:
  groups:
  - name: cardinality
    rules: []  # Recording rules only

# ServiceMonitor metricRelabelings to drop at scrape time
metricRelabelings:
# Drop per-pod metrics that are already aggregated
- sourceLabels: [__name__, pod]
  regex: "http_requests_total;.+"
  action: drop

# Normalize high-cardinality URL paths
- sourceLabels: [__name__, path]
  regex: "(http_request_duration_seconds_bucket);/api/v[0-9]+/users/[0-9]+"
  targetLabel: path
  replacement: "/api/v*/users/:id"
  action: replace

# Drop unused histogram buckets
- sourceLabels: [__name__, le]
  regex: "http_request_duration_seconds_bucket;(0\\.001|0\\.002|0\\.005)"
  action: drop
```

### Limits Configuration

```yaml
prometheusSpec:
  enforcedSampleLimit: 500000        # Reject scrapes exceeding 500k samples
  enforcedTargetLimit: 2000           # Max scrape targets per Prometheus
  enforcedBodySizeLimit: "64MB"       # Max scrape response size
  # Per-namespace limits
  enforcedNamespaceLabelNameLengthLimit: 63
  enforcedLabelNameLengthLimit: 1024
  enforcedLabelValueLengthLimit: 1024
```

## Section 7: Federation for Multi-Cluster Monitoring

### Federated Prometheus Architecture

```
Cluster A: Prometheus (local scrape)
Cluster B: Prometheus (local scrape)
Cluster C: Prometheus (local scrape)
         ↓  (remote_write)
Global Prometheus / Thanos Receive
         ↓
Grafana (cross-cluster dashboards)
```

### Thanos Sidecar Setup

```yaml
# Add Thanos sidecar to Prometheus via kube-prometheus-stack
prometheusSpec:
  thanos:
    image: quay.io/thanos/thanos:v0.36.0
    objectStorageConfig:
      secret:
        type: S3
        config:
          bucket: example-thanos-metrics
          endpoint: s3.us-east-1.amazonaws.com
          region: us-east-1
          # Use IAM role instead of hardcoded credentials
          aws_sdk_auth: true
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

### Thanos Query for Cross-Cluster Queries

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
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
        - --http-address=0.0.0.0:9090
        - --grpc-address=0.0.0.0:10901
        - --query.replica-label=prometheus_replica
        - --query.replica-label=cluster
        - --endpoint=dnssrv+_grpc._tcp.prometheus-operated.monitoring.svc.cluster.local
        - --endpoint=thanos-sidecar-cluster-a.example.com:10901
        - --endpoint=thanos-sidecar-cluster-b.example.com:10901
        - --store=thanos-store.monitoring.svc.cluster.local:10901
        - --query.auto-downsampling
```

## Section 8: Prometheus Operator RBAC

```yaml
# ServiceAccount with minimal permissions for scraping
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus
rules:
- apiGroups: [""]
  resources: ["nodes", "nodes/proxy", "nodes/metrics", "services", "endpoints", "pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["extensions", "networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "list", "watch"]
- nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus
subjects:
- kind: ServiceAccount
  name: prometheus
  namespace: monitoring
```

## Section 9: Essential Alerting Rules

```yaml
  - name: kubernetes.workload.alerts
    rules:
    # Pod crash looping
    - alert: PodCrashLooping
      expr: |
        increase(kube_pod_container_status_restarts_total[15m]) > 3
      for: 0m
      labels:
        severity: warning
      annotations:
        summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping"
        description: "Container {{ $labels.container }} has restarted {{ $value }} times in 15 minutes"

    # Deployment not meeting desired replica count
    - alert: DeploymentReplicasUnavailable
      expr: |
        kube_deployment_status_replicas_available
        /
        kube_deployment_spec_replicas < 0.5
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} is degraded"
        description: "Only {{ $value | humanizePercentage }} of replicas are available"

    # PVC approaching capacity
    - alert: PersistentVolumeFillingUp
      expr: |
        (
          kubelet_volume_stats_available_bytes
          /
          kubelet_volume_stats_capacity_bytes
        ) < 0.15
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is almost full"

    # Node memory pressure
    - alert: NodeMemoryPressure
      expr: kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Node {{ $labels.node }} is under memory pressure"

    # Container CPU throttling
    - alert: CPUThrottlingHigh
      expr: container:cpu_throttled_ratio:rate5m > 0.25
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "CPU throttling above 25% for {{ $labels.namespace }}/{{ $labels.pod }}"
        description: "Container {{ $labels.container }} CPU throttling at {{ $value | humanizePercentage }}"
```

## Summary

Production Prometheus on Kubernetes requires careful attention to storage sizing, recording rule optimization, and cardinality governance. The kube-prometheus-stack Helm chart provides the fastest path to a complete monitoring stack, but production readiness requires tuning scrape intervals, adding metric drop rules to control TSDB growth, and implementing multi-window burn rate alerting to detect SLO violations before they exhaust error budgets. For multi-cluster environments, Thanos or VictoriaMetrics federation provides global query capability while keeping hot storage local to each cluster for query performance.
