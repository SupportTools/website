---
title: "Prometheus Operator Deep Dive: ServiceMonitor, PodMonitor, and PrometheusRule"
date: 2029-01-24T00:00:00-05:00
draft: false
tags: ["Prometheus", "Kubernetes", "Monitoring", "Observability", "ServiceMonitor", "PrometheusRule", "Alerting"]
categories:
- Monitoring
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to the Prometheus Operator covering ServiceMonitor and PodMonitor configuration, PrometheusRule alerting, RBAC isolation, and multi-cluster monitoring architecture."
more_link: "yes"
url: "/prometheus-operator-servicemonitor-podmonitor-prometheusrule-enterprise/"
---

The Prometheus Operator transforms Prometheus from a manually-configured monitoring system into a Kubernetes-native, declaratively-managed observability platform. By extending the Kubernetes API with custom resources—`Prometheus`, `Alertmanager`, `ServiceMonitor`, `PodMonitor`, `PrometheusRule`, and `ScrapeConfig`—the operator enables teams to manage monitoring configuration with the same GitOps workflows used for application deployments.

This post provides an enterprise-grade examination of the operator's core primitives: how `ServiceMonitor` and `PodMonitor` differ and when to use each, `PrometheusRule` configuration for production alerting, RBAC patterns for multi-team clusters, sharding for large-scale environments, and the complete operational playbook for maintaining a production Prometheus installation.

<!--more-->

## Operator Architecture

The Prometheus Operator runs as a Deployment in the monitoring namespace and watches for changes to its custom resources. When it detects a change to a `ServiceMonitor` or `PrometheusRule`, it reconciles the Prometheus configuration by generating a new `prometheus.yaml`, writing it to a Kubernetes Secret, and signaling Prometheus to reload.

```
Kubernetes API
    │
    ├── ServiceMonitor/PodMonitor changes
    ├── PrometheusRule changes
    └── Prometheus/Alertmanager spec changes
         │
         ▼
  Prometheus Operator (watches CRDs)
         │
         ├── Generates prometheus.yaml
         ├── Writes to Secret: prometheus-<name>
         ├── Calls /-/reload HTTP endpoint
         └── Manages StatefulSet replicas
         │
         ▼
  Prometheus StatefulSet
  (reads config from secret volume)
```

The operator does NOT restart Prometheus on configuration changes—it uses the `/-/reload` endpoint (enabled by `--web.enable-lifecycle`) to trigger a hot reload.

## Installing the Prometheus Operator

```bash
# Install via kube-prometheus-stack Helm chart (recommended for production)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Create values file for production
cat > kube-prometheus-values.yaml <<'EOF'
# Global settings
global:
  rbac:
    create: true
    pspEnabled: false

# Prometheus configuration
prometheus:
  prometheusSpec:
    # Retention and storage
    retention: 30d
    retentionSize: "100GB"
    walCompression: true

    # Resource allocation for a cluster with ~2000 active series per pod
    resources:
      requests:
        cpu: 1000m
        memory: 4Gi
      limits:
        cpu: 4000m
        memory: 8Gi

    # Persistent storage
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: fast-ssd
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 200Gi

    # Watch ServiceMonitors/PodMonitors across all namespaces
    # Set to specific namespaces for multi-tenant isolation
    serviceMonitorNamespaceSelector: {}
    serviceMonitorSelector: {}
    podMonitorNamespaceSelector: {}
    podMonitorSelector: {}
    ruleNamespaceSelector: {}
    ruleSelector: {}

    # Alertmanager integration
    alerting:
      alertmanagers:
      - namespace: monitoring
        name: alertmanager-main
        port: web

    # External labels for federation and Thanos
    externalLabels:
      cluster: prod-us-east-1
      region: us-east-1
      environment: production

    # Remote write to Thanos or VictoriaMetrics for long-term storage
    remoteWrite:
    - url: http://thanos-receive.monitoring.svc.cluster.local:19291/api/v1/receive
      queueConfig:
        maxSamplesPerSend: 10000
        maxShards: 30
        capacity: 100000

    # Scrape configuration
    scrapeInterval: 30s
    scrapeTimeout: 10s
    evaluationInterval: 30s

    # Additional scrape configs for targets not managed by CRDs
    additionalScrapeConfigs:
      name: additional-scrape-configs
      key: prometheus-additional.yaml

    # Thanos sidecar for object storage backup
    thanos:
      image: quay.io/thanos/thanos:v0.36.1
      objectStorageConfig:
        secret:
          type: S3
          config:
            bucket: prometheus-metrics-prod
            endpoint: s3.us-east-1.amazonaws.com
            region: us-east-1

# Alertmanager configuration
alertmanager:
  alertmanagerSpec:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 256Mi
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: standard
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 10Gi
    replicas: 3

# Grafana
grafana:
  enabled: true
  adminPassword: ""  # Use external secret
  persistence:
    enabled: true
    size: 20Gi

# Node exporter
nodeExporter:
  enabled: true

# kube-state-metrics
kubeStateMetrics:
  enabled: true
EOF

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --version 65.2.0 \
  --values kube-prometheus-values.yaml \
  --timeout 10m \
  --atomic
```

## ServiceMonitor: Monitoring Service Endpoints

`ServiceMonitor` selects Services and defines how to scrape their pods via the Service's endpoints. This is the standard mechanism for monitoring workloads that expose metrics through a Service.

### Basic ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api-server-metrics
  namespace: production
  labels:
    # These labels must match the Prometheus CR's serviceMonitorSelector
    app: api-server
    release: kube-prometheus-stack
spec:
  # Which namespaces to look for Services in
  namespaceSelector:
    matchNames:
    - production
    - staging

  # Selects Services with these labels
  selector:
    matchLabels:
      app: api-server
      metrics: enabled

  # Scrape configuration for each matching Service endpoint
  endpoints:
  - port: metrics          # Must match a named port in the Service spec
    interval: 30s
    scrapeTimeout: 10s
    path: /metrics
    honorLabels: false      # Do not use labels from the scraped target
    honorTimestamps: true
    scheme: http

    # Metric relabeling to drop high-cardinality or noisy metrics
    metricRelabelings:
    - sourceLabels: [__name__]
      regex: 'go_gc_.*|go_memstats_.*'
      action: drop
    - sourceLabels: [__name__, le]
      regex: 'http_request_duration_seconds_bucket;.*'
      action: keep

    # Target relabeling — add cluster metadata
    relabelings:
    - targetLabel: cluster
      replacement: prod-us-east-1
    - sourceLabels: [__meta_kubernetes_pod_node_name]
      targetLabel: node
    - sourceLabels: [__meta_kubernetes_namespace]
      targetLabel: namespace
    - sourceLabels: [__meta_kubernetes_service_name]
      targetLabel: service
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
```

### ServiceMonitor with TLS

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: secure-api-metrics
  namespace: production
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    matchNames:
    - production
  selector:
    matchLabels:
      app: secure-api
  endpoints:
  - port: metrics-https
    interval: 30s
    scheme: https
    tlsConfig:
      # CA cert for verifying the target's TLS certificate
      caFile: /etc/prometheus/secrets/metrics-tls/ca.crt
      certFile: /etc/prometheus/secrets/metrics-tls/tls.crt
      keyFile: /etc/prometheus/secrets/metrics-tls/tls.key
      insecureSkipVerify: false
      serverName: secure-api.production.svc.cluster.local
    # Mount the TLS secret in Prometheus
    # Reference it in Prometheus CR: spec.secrets: ["metrics-tls"]
```

### ServiceMonitor with Basic Auth

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: legacy-app-metrics
  namespace: monitoring
spec:
  namespaceSelector:
    any: true
  selector:
    matchLabels:
      metrics-auth: basic
  endpoints:
  - port: metrics
    interval: 60s
    basicAuth:
      username:
        name: legacy-app-metrics-auth
        key: username
      password:
        name: legacy-app-metrics-auth
        key: password
```

## PodMonitor: Monitoring Pods Directly

`PodMonitor` selects Pods directly, bypassing the Service layer. Use it when:
- The pod does not have a corresponding Service (batch jobs, DaemonSets that do not need Service discovery)
- Different pods in the same Deployment expose metrics on different ports
- The pod label differs from the Service selector label

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: cronjob-metrics
  namespace: batch
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    matchNames:
    - batch
    - processing

  # Select pods directly by label
  selector:
    matchLabels:
      metrics-enabled: "true"
    matchExpressions:
    - key: job-name
      operator: Exists

  # Scrape the matching pods
  podMetricsEndpoints:
  - port: metrics
    interval: 60s
    path: /metrics
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_label_job_name]
      targetLabel: job_name
    - sourceLabels: [__meta_kubernetes_pod_annotation_batch_kubernetes_io_job_completion_index]
      targetLabel: job_completion_index
    metricRelabelings:
    - sourceLabels: [__name__]
      regex: 'batch_job_(duration|records|errors).*'
      action: keep

---
# DaemonSet monitoring without requiring a Service
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: node-agent-metrics
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    matchNames:
    - kube-system
  selector:
    matchLabels:
      app: node-agent
  podMetricsEndpoints:
  - port: metrics
    interval: 30s
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_node_name]
      targetLabel: node
      replacement: '$1'
    - sourceLabels: [__meta_kubernetes_pod_host_ip]
      targetLabel: host_ip
```

## PrometheusRule: Alerting and Recording Rules

`PrometheusRule` defines both alerting rules and recording rules. Recording rules pre-compute expensive PromQL expressions and store the results as new time series, which improves dashboard query performance.

### Recording Rules for Dashboard Performance

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-server-recording-rules
  namespace: production
  labels:
    release: kube-prometheus-stack
    role: recording-rules
spec:
  groups:
  - name: api_server.recordings
    interval: 60s
    rules:
    # Pre-compute request rate for all API endpoints
    - record: job:http_requests:rate5m
      expr: sum(rate(http_requests_total[5m])) by (job, namespace, method, status_code)

    # Pre-compute error rate
    - record: job:http_errors:rate5m
      expr: |
        sum(rate(http_requests_total{status_code=~"5.."}[5m])) by (job, namespace)
        / sum(rate(http_requests_total[5m])) by (job, namespace)

    # P99 latency by service
    - record: job:http_request_duration_seconds_p99:rate5m
      expr: |
        histogram_quantile(0.99,
          sum(rate(http_request_duration_seconds_bucket[5m])) by (le, job, namespace)
        )

    # Pre-compute CPU usage by namespace for capacity planning dashboards
    - record: namespace:container_cpu_usage_seconds:rate5m
      expr: |
        sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) by (namespace)
```

### Production Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-server-alerts
  namespace: production
  labels:
    release: kube-prometheus-stack
    role: alert-rules
    severity: critical
spec:
  groups:
  - name: api_server.alerts
    rules:

    # SLO-based error rate alert (burn rate alerting)
    - alert: APIHighErrorBurnRate
      expr: |
        (
          job:http_errors:rate5m{job="api-server"} > (14.4 * 0.001)
        )
        and
        (
          sum(rate(http_requests_total{job="api-server",status_code=~"5.."}[1h]))
          by (job, namespace)
          / sum(rate(http_requests_total{job="api-server"}[1h])) by (job, namespace)
          > (14.4 * 0.001)
        )
      for: 2m
      labels:
        severity: critical
        team: platform
        slo: api-availability
      annotations:
        summary: "API {{ $labels.job }} in {{ $labels.namespace }} is burning error budget too fast"
        description: |
          The error rate for {{ $labels.job }} is {{ $value | humanizePercentage }}.
          At this rate, the monthly error budget will be exhausted in less than 1 hour.
        runbook_url: "https://runbooks.example.com/api-high-error-burn-rate"
        dashboard_url: "https://grafana.example.com/d/api-slo/api-slo?var-job={{ $labels.job }}"

    - alert: APIHighLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(http_request_duration_seconds_bucket{job="api-server"}[5m]))
          by (le, job, namespace, path)
        ) > 2
      for: 10m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "API {{ $labels.job }} endpoint {{ $labels.path }} p99 latency exceeds 2s"
        description: "P99 latency is {{ $value | humanizeDuration }}"

    - alert: APIPodRestartLoop
      expr: |
        increase(kube_pod_container_status_restarts_total{
          namespace="production",
          container=~"api-server.*"
        }[15m]) > 3
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Pod {{ $labels.pod }} container {{ $labels.container }} is restarting frequently"
        description: "{{ $value }} restarts in the last 15 minutes"

    - alert: APIDeploymentScaledToZero
      expr: |
        kube_deployment_status_replicas_available{
          namespace="production",
          deployment=~"api-server.*"
        } == 0
      for: 1m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Deployment {{ $labels.deployment }} has 0 available replicas"

  - name: capacity.alerts
    rules:
    - alert: NamespaceCPUQuotaExceeded
      expr: |
        sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) by (namespace)
        / sum(kube_resourcequota{resource="requests.cpu",type="hard"}) by (namespace)
        > 0.9
      for: 15m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Namespace {{ $labels.namespace }} is using >90% of CPU quota"

    - alert: PersistentVolumeAlmostFull
      expr: |
        (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.85
        and kubelet_volume_stats_capacity_bytes > 0
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "PVC {{ $labels.persistentvolumeclaim }} in {{ $labels.namespace }} is {{ $value | humanizePercentage }} full"
        description: "PVC will be full in approximately {{ with query \"predict_linear(kubelet_volume_stats_available_bytes{persistentvolumeclaim=\\\"\" }}{{ $labels.persistentvolumeclaim }}{{ with query \"\\\"}[6h], 86400)\" }}{{ . | first | value | humanizeDuration }}{{ end }}"
```

## RBAC for Multi-Team Clusters

In multi-team clusters, each team should own their own monitoring configuration without access to other teams' metrics:

```yaml
# monitoring-rbac.yaml — Allow teams to manage their own monitoring CRDs
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-editor
rules:
- apiGroups: ["monitoring.coreos.com"]
  resources:
  - servicemonitors
  - podmonitors
  - prometheusrules
  - scrapeconfigs
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

---
# Bind to team-specific namespaces only
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-payments-monitoring-editor
  namespace: payments
subjects:
- kind: Group
  name: team-payments
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: monitoring-editor
  apiGroup: rbac.authorization.k8s.io

---
# Prometheus instance per team (for complete isolation)
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-payments
  namespace: payments-monitoring
spec:
  replicas: 2
  version: v2.54.1

  # Only watch ServiceMonitors in the payments namespace
  serviceMonitorNamespaceSelector:
    matchLabels:
      team: payments
  serviceMonitorSelector: {}

  # Only evaluate rules in the payments namespace
  ruleNamespaceSelector:
    matchLabels:
      team: payments
  ruleSelector: {}

  serviceAccountName: prometheus-payments

  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 2000m
      memory: 4Gi

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-ssd
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 50Gi

  retention: 15d
  retentionSize: "40GB"

  externalLabels:
    cluster: prod-us-east-1
    team: payments
```

## Prometheus Sharding for Large Clusters

For clusters with more than 1 million active time series, a single Prometheus instance becomes a bottleneck. The operator supports sharding:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-main
  namespace: monitoring
spec:
  # Split scraping across 4 Prometheus instances
  # Each shard handles ~25% of targets
  shards: 4
  replicas: 2  # HA replicas per shard

  version: v2.54.1

  # Prometheus uses consistent hashing on target labels
  # to distribute targets across shards deterministically

  resources:
    requests:
      cpu: 2000m
      memory: 8Gi
    limits:
      cpu: 8000m
      memory: 16Gi

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-ssd
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 500Gi

  retention: 30d

  # Thanos sidecar aggregates results from all shards
  thanos:
    image: quay.io/thanos/thanos:v0.36.1
    objectStorageConfig:
      secret:
        type: S3
        config:
          bucket: prometheus-metrics-prod
          endpoint: s3.us-east-1.amazonaws.com
          region: us-east-1
```

## Alertmanager Configuration

```yaml
# Alertmanager configuration secret
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-main
  namespace: monitoring
stringData:
  alertmanager.yaml: |
    global:
      smtp_smarthost: 'smtp.example.com:587'
      smtp_from: 'alertmanager@example.com'
      smtp_auth_username: 'alertmanager@example.com'
      smtp_auth_password: 'SECRET'
      slack_api_url: 'https://hooks.slack.com/services/T000/B000/XXXX'
      resolve_timeout: 5m

    templates:
    - '/etc/alertmanager/config/*.tmpl'

    route:
      receiver: 'default-receiver'
      group_by: ['alertname', 'cluster', 'namespace']
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
      - match:
          severity: critical
        receiver: pagerduty-critical
        continue: true
      - match:
          severity: critical
        receiver: slack-critical
      - match:
          severity: warning
        receiver: slack-warning
      - match_re:
          alertname: Watchdog
        receiver: 'null'

    inhibit_rules:
    - source_match:
        severity: critical
      target_match:
        severity: warning
      equal: ['alertname', 'cluster', 'namespace']

    receivers:
    - name: 'null'

    - name: 'default-receiver'
      slack_configs:
      - channel: '#alerts-default'
        send_resolved: true

    - name: 'pagerduty-critical'
      pagerduty_configs:
      - routing_key: 'SECRET_PAGERDUTY_KEY'
        severity: critical
        description: '{{ .CommonAnnotations.summary }}'
        details:
          runbook: '{{ .CommonAnnotations.runbook_url }}'
          dashboard: '{{ .CommonAnnotations.dashboard_url }}'

    - name: 'slack-critical'
      slack_configs:
      - channel: '#alerts-critical'
        send_resolved: true
        title: '[{{ .Status | toUpper }}{{ if eq .Status "firing" }}:{{ .Alerts.Firing | len }}{{ end }}] {{ .CommonLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ "\n" }}{{ end }}'

    - name: 'slack-warning'
      slack_configs:
      - channel: '#alerts-warning'
        send_resolved: true
```

## Operational Runbook

### Debugging ServiceMonitor Not Scraping

```bash
#!/bin/bash
# debug-servicemonitor.sh — Diagnose why a ServiceMonitor is not scraping

SM_NAMESPACE="${1:-production}"
SM_NAME="${2}"

echo "=== ServiceMonitor Status ==="
kubectl get servicemonitor "${SM_NAME}" -n "${SM_NAMESPACE}" -o yaml

echo ""
echo "=== Matching Services ==="
kubectl get svc -n "${SM_NAMESPACE}" -l "$(
    kubectl get servicemonitor "${SM_NAME}" -n "${SM_NAMESPACE}" \
        -o jsonpath='{.spec.selector.matchLabels}' | \
        python3 -c "import sys,json; d=json.load(sys.stdin); print(','.join(f'{k}={v}' for k,v in d.items()))"
)"

echo ""
echo "=== Prometheus Targets (check for this service) ==="
kubectl port-forward -n monitoring svc/prometheus-main 9090:9090 &
PF_PID=$!
sleep 2
curl -s "http://localhost:9090/api/v1/targets" | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
for target in data['data']['activeTargets']:
    labels = target.get('labels', {})
    ns = labels.get('namespace', '')
    if '${SM_NAMESPACE}' in ns:
        print(f'Target: {target[\"scrapeUrl\"]}')
        print(f'  State: {target[\"health\"]}')
        print(f'  Last error: {target.get(\"lastError\", \"none\")}')
        print()
"
kill ${PF_PID} 2>/dev/null

echo ""
echo "=== Prometheus Operator Logs (last 50 lines) ==="
kubectl logs -n monitoring deployment/prometheus-operator --tail=50 | \
    grep -E "ERROR|WARN|servicemonitor|${SM_NAME}" | tail -20
```

## Summary

The Prometheus Operator's CRD-based approach to monitoring configuration enables true GitOps for observability: `ServiceMonitor`, `PodMonitor`, and `PrometheusRule` resources live in the same repository as the applications they monitor, are reviewed through the same PR process, and roll back atomically with application changes.

The key operational principles:
- Use `ServiceMonitor` for workloads with a corresponding Service; use `PodMonitor` for headless pods, batch jobs, and DaemonSets.
- Define recording rules for any PromQL expression used in multiple dashboards or alerts—pre-computation dramatically reduces Prometheus CPU and query latency.
- Implement multi-burn-rate SLO alerting rather than simple threshold alerts to reduce false positives and alert fatigue.
- For clusters exceeding 1M active series, use sharding rather than scaling a single Prometheus instance vertically.
- Isolate team monitoring with separate Prometheus instances and namespace-scoped `serviceMonitorNamespaceSelector` to prevent cross-team metric access.
