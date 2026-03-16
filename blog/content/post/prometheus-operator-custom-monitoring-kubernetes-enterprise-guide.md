---
title: "Prometheus Operator: Custom Monitoring Stacks for Kubernetes"
date: 2027-02-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Prometheus Operator", "Monitoring", "Observability"]
categories: ["Monitoring", "Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying the Prometheus Operator for custom Kubernetes monitoring stacks: Prometheus CRD with sharding and HA, ServiceMonitor/PodMonitor selectors, PrometheusRule management, Alertmanager HA, ThanosRuler, remote write, and PrometheusAgent."
more_link: "yes"
url: "/prometheus-operator-custom-monitoring-kubernetes-enterprise-guide/"
---

The **kube-prometheus-stack** Helm chart is convenient, but it is a monolith: one Prometheus instance watching everything, one Alertmanager cluster, one set of scrape configs, and one set of rules. Enterprise environments typically require multiple isolated monitoring stacks: a platform team stack, a security team stack, per-tenant stacks in multi-tenant clusters, or a dedicated stack for a compliance-sensitive workload. The **Prometheus Operator** alone—without the opinionated kube-prometheus-stack defaults—gives full control over these stacks through Kubernetes CRDs.

<!--more-->

## Prometheus Operator vs kube-prometheus-stack

Understanding what the Prometheus Operator is and is not prevents configuration confusion:

| Component | Prometheus Operator | kube-prometheus-stack |
|---|---|---|
| Operator binary | Included | Included |
| Default Prometheus instance | Not included | Included (cluster-wide) |
| Default Alertmanager | Not included | Included |
| Node Exporter DaemonSet | Not included | Included |
| kube-state-metrics | Not included | Included |
| Default rules/dashboards | Not included | 200+ included |
| Flexibility | Full; define your own stacks | Opinionated; override required |

**When to use the standalone Operator:**
- Multiple isolated Prometheus instances are required
- Per-team or per-tenant monitoring isolation
- Compliance requirements mandate separate monitoring planes
- Building a platform monitoring product on top of Kubernetes
- The default kube-prometheus-stack bundle is too large for edge or resource-constrained clusters

**When to use kube-prometheus-stack:**
- Single-cluster, single-tenant environment
- Getting started quickly with a complete monitoring stack
- The default dashboards and rules are sufficient

## Deploying the Standalone Prometheus Operator

### Helm Installation

```bash
# Install only the Prometheus Operator (no Prometheus, Alertmanager, or exporters)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-operator prometheus-community/kube-prometheus-stack \
  --namespace monitoring-system \
  --create-namespace \
  --version 65.0.0 \
  --set prometheus.enabled=false \
  --set alertmanager.enabled=false \
  --set grafana.enabled=false \
  --set nodeExporter.enabled=false \
  --set kubeStateMetrics.enabled=false \
  --set prometheusOperator.enabled=true \
  --set prometheusOperator.namespaces.releaseNamespace=true \
  --set prometheusOperator.namespaces.additional="{monitoring,platform-monitoring,security-monitoring,production}"
```

The `namespaces` configuration tells the operator which namespaces to watch for CRD objects. Omitting namespaces (or using an empty list) defaults to cluster-wide watching with appropriate RBAC.

### RBAC for Multi-Namespace Operation

The operator needs permissions to watch ServiceMonitor, PodMonitor, and PrometheusRule objects across target namespaces:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-operator
rules:
- apiGroups: ["monitoring.coreos.com"]
  resources:
  - alertmanagers
  - alertmanagerconfigs
  - prometheuses
  - prometheusagents
  - prometheusrules
  - servicemonitors
  - podmonitors
  - probes
  - thanosrulers
  verbs: ["*"]
- apiGroups: ["apps"]
  resources: ["statefulsets"]
  verbs: ["*"]
- apiGroups: [""]
  resources:
  - configmaps
  - secrets
  - services
  - endpoints
  - pods
  - namespaces
  - nodes
  verbs: ["get", "list", "watch"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["storage.k8s.io"]
  resources: ["storageclasses"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-operator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus-operator
subjects:
- kind: ServiceAccount
  name: prometheus-operator
  namespace: monitoring-system
```

## Prometheus CRD: High Availability and Sharding

### Basic HA Prometheus

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: platform
  namespace: monitoring
spec:
  # Two replicas for HA; both scrape all targets independently
  replicas: 2

  # ServiceAccount for the Prometheus pods
  serviceAccountName: prometheus-platform

  # Resource requests/limits
  resources:
    requests:
      cpu: "1"
      memory: "4Gi"
    limits:
      cpu: "4"
      memory: "8Gi"

  # Persistent storage
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: gp3
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 500Gi

  # Retention configuration
  retention: 15d
  retentionSize: "450GiB"

  # Select ServiceMonitors in specific namespaces
  serviceMonitorSelector:
    matchLabels:
      monitoring: platform
  serviceMonitorNamespaceSelector:
    matchLabels:
      monitoring.io/team: platform

  # Select PodMonitors
  podMonitorSelector:
    matchLabels:
      monitoring: platform
  podMonitorNamespaceSelector:
    matchLabels:
      monitoring.io/team: platform

  # Select PrometheusRules
  ruleSelector:
    matchLabels:
      monitoring: platform
  ruleNamespaceSelector:
    matchLabels:
      monitoring.io/team: platform

  # Alertmanager integration
  alerting:
    alertmanagers:
    - namespace: monitoring
      name: alertmanager-platform
      port: web

  # External labels for identification in Thanos/remote write
  externalLabels:
    cluster: production-us-east-1
    team: platform
    environment: production

  # Scrape configuration
  scrapeInterval: 30s
  scrapeTimeout: 10s
  evaluationInterval: 30s

  # Security context
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    fsGroup: 65534

  # Pod anti-affinity for HA
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app.kubernetes.io/name: prometheus
            prometheus: platform
        topologyKey: kubernetes.io/hostname

  # Topology spread for multi-AZ
  topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        prometheus: platform
```

### Prometheus with Sharding

For very large clusters (10,000+ targets), sharding distributes scrape load across multiple Prometheus instances. Each shard is responsible for a subset of targets:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: platform-sharded
  namespace: monitoring
spec:
  # Number of shards: 3 shards × 2 replicas = 6 pods total
  shards: 3
  replicas: 2

  resources:
    requests:
      cpu: "2"
      memory: "8Gi"
    limits:
      cpu: "8"
      memory: "16Gi"

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: gp3
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 200Gi

  retention: 7d

  serviceMonitorSelector:
    matchLabels:
      monitoring: platform
  serviceMonitorNamespaceSelector: {}

  externalLabels:
    cluster: production-us-east-1
    shard: "$(PROMETHEUS_SHARD)"

  # Shards are 0-indexed; each shard scrapes 1/shards of all targets
  # based on consistent hashing of the target's __address__ label
```

When sharding is enabled, the operator creates a StatefulSet per shard named `prometheus-<name>-shard-<n>`. Use Thanos Query or Cortex to aggregate metrics across shards.

## ServiceMonitor and PodMonitor Selectors

### ServiceMonitor Configuration

The `ServiceMonitor` tells Prometheus which Services to scrape and how:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: payment-api
  namespace: production
  labels:
    # This label must match the Prometheus CRD's serviceMonitorSelector
    monitoring: platform
spec:
  # Select Services in these namespaces
  namespaceSelector:
    matchNames:
    - production
    - staging
  # Select Services with these labels
  selector:
    matchLabels:
      app: payment-api
      metrics: enabled
  endpoints:
  - port: metrics
    path: /metrics
    interval: 15s
    scrapeTimeout: 10s
    scheme: http
    # Honor labels from the target (don't drop existing labels)
    honorLabels: true
    # Relabeling to add useful labels
    relabelings:
    - sourceLabels: [__meta_kubernetes_namespace]
      targetLabel: kubernetes_namespace
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: kubernetes_pod_name
    - sourceLabels: [__meta_kubernetes_service_name]
      targetLabel: kubernetes_service_name
    # Drop metrics with high cardinality
    metricRelabelings:
    - sourceLabels: [__name__]
      regex: go_gc_duration_seconds.*
      action: drop
```

### PodMonitor for Pods Without Services

Some workloads expose metrics on pods that are not backed by a Service. `PodMonitor` targets pod labels directly:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: batch-jobs
  namespace: production
  labels:
    monitoring: platform
spec:
  namespaceSelector:
    matchNames:
    - production
  selector:
    matchLabels:
      job-type: batch
      metrics: enabled
  podMetricsEndpoints:
  - port: metrics
    path: /metrics
    interval: 60s
    scrapeTimeout: 30s
```

### Debugging Selector Mismatches

The most common operational issue with Prometheus Operator is a selector mismatch: a ServiceMonitor exists but Prometheus is not scraping its targets.

```bash
# Step 1: Verify the ServiceMonitor's labels match the Prometheus selector
kubectl get servicemonitor payment-api -n production -o yaml | \
  grep -A5 "labels:"

kubectl get prometheus platform -n monitoring -o yaml | \
  grep -A10 "serviceMonitorSelector:"

# Step 2: Verify namespace labels match the Prometheus namespaceSelector
kubectl get namespace production --show-labels

# Step 3: Check the Prometheus targets endpoint
# Port-forward the Prometheus web UI
kubectl port-forward svc/prometheus-operated 9090:9090 -n monitoring &

# Visit http://localhost:9090/targets and check for the service

# Step 4: Check Prometheus operator logs for reconciliation errors
kubectl logs -l app.kubernetes.io/name=prometheus-operator \
  -n monitoring-system --tail=100 | grep -i "error\|warn\|servicemonitor"

# Step 5: Verify the Service has the matching port name
kubectl get svc payment-api -n production -o yaml | grep -A10 "ports:"
# The port 'name' field must match the ServiceMonitor 'port' field
```

### Common Selector Patterns

```yaml
# Pattern 1: Team-based isolation - each team owns their ServiceMonitors
# Team A's Prometheus
spec:
  serviceMonitorSelector:
    matchLabels:
      team: platform
  serviceMonitorNamespaceSelector:
    matchLabels:
      team: platform

# Pattern 2: Environment-based isolation
spec:
  serviceMonitorSelector:
    matchExpressions:
    - key: environment
      operator: In
      values: ["production", "staging"]
  serviceMonitorNamespaceSelector:
    matchExpressions:
    - key: environment
      operator: In
      values: ["production", "staging"]

# Pattern 3: Select all ServiceMonitors in all namespaces (cluster-wide)
spec:
  serviceMonitorSelector: {}
  serviceMonitorNamespaceSelector: {}
```

## PrometheusRule Management

### Creating Recording and Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payment-service-rules
  namespace: production
  labels:
    # Must match the Prometheus CRD's ruleSelector
    monitoring: platform
spec:
  groups:
  - name: payment.slos
    interval: 30s
    rules:
    # Recording rule: pre-compute error rate for faster queries
    - record: payment_api:http_error_rate:rate5m
      expr: |
        sum(rate(http_requests_total{job="payment-api",status=~"5.."}[5m]))
        /
        sum(rate(http_requests_total{job="payment-api"}[5m]))

    # Recording rule: P99 latency
    - record: payment_api:http_latency_p99:rate5m
      expr: |
        histogram_quantile(0.99,
          sum(rate(http_request_duration_seconds_bucket{job="payment-api"}[5m]))
          by (le)
        )

    # Alert: high error rate
    - alert: PaymentAPIHighErrorRate
      expr: payment_api:http_error_rate:rate5m > 0.05
      for: 5m
      labels:
        severity: critical
        team: payments
        slo: availability
      annotations:
        summary: "Payment API error rate above 5%"
        description: "Current error rate: {{ $value | humanizePercentage }}"
        runbook: "https://runbooks.example.com/payment-api/high-error-rate"

    # Alert: SLO burn rate (multi-window, multi-burn-rate alerting)
    - alert: PaymentAPISLOBurnRateFast
      expr: |
        (
          payment_api:http_error_rate:rate5m > (14.4 * 0.001)
          and
          payment_api:http_error_rate:rate1h > (14.4 * 0.001)
        )
      for: 2m
      labels:
        severity: critical
        slo: availability
        window: fast
      annotations:
        summary: "Payment API SLO burn rate: fast burn detected"
        description: "Burn rate {{ $value | humanize }} exceeds 14.4x threshold"
```

### Validating PrometheusRule Syntax

```bash
# Check if the PrometheusRule was picked up by the operator
kubectl get prometheusrule payment-service-rules -n production -o yaml | \
  grep -A3 "status:"

# Validate PromQL syntax before applying
# promtool is included in the Prometheus container
kubectl run promtool --image=prom/prometheus:v2.52.0 \
  --restart=Never \
  --rm -i \
  --command -- promtool check rules /dev/stdin <<'EOF'
groups:
- name: test
  rules:
  - alert: TestAlert
    expr: up == 0
    for: 5m
EOF

# Check the Prometheus /rules endpoint for loaded rules
curl -s http://localhost:9090/api/v1/rules | \
  jq '.data.groups[] | select(.name == "payment.slos") | .rules[].name'
```

## Alertmanager CRD with High Availability

### HA Alertmanager Deployment

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: platform
  namespace: monitoring
spec:
  # Three replicas form a Gossip cluster for deduplication
  replicas: 3

  resources:
    requests:
      cpu: "100m"
      memory: "256Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: gp3
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi

  # Use AlertmanagerConfig CRDs for route configuration
  alertmanagerConfigSelector:
    matchLabels:
      alertmanager: platform
  alertmanagerConfigNamespaceSelector:
    matchLabels:
      monitoring.io/team: platform

  # Security context
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    fsGroup: 65534

  # Pod anti-affinity across nodes
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            alertmanager: platform
        topologyKey: kubernetes.io/hostname
```

### AlertmanagerConfig for Team-Specific Routing

```yaml
# Team-specific alert routing using AlertmanagerConfig
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: payments-team-routing
  namespace: production
  labels:
    alertmanager: platform
spec:
  route:
    # Match alerts labeled for the payments team
    matchers:
    - name: team
      value: payments
      matchType: "="
    receiver: payments-slack
    groupBy: ["alertname", "cluster"]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    routes:
    - matchers:
      - name: severity
        value: critical
        matchType: "="
      receiver: payments-pagerduty
      repeatInterval: 4h

  receivers:
  - name: payments-slack
    slackConfigs:
    - apiURL:
        name: slack-webhook-payments
        key: url
      channel: "#payments-alerts"
      username: "Alertmanager"
      iconEmoji: ":bell:"
      sendResolved: true
      title: |
        [{{ .Status | toUpper }}] {{ .GroupLabels.alertname }}
      text: |
        {{ range .Alerts }}
        *Alert:* {{ .Annotations.summary }}
        *Description:* {{ .Annotations.description }}
        *Severity:* {{ .Labels.severity }}
        *Cluster:* {{ .Labels.cluster }}
        {{ end }}

  - name: payments-pagerduty
    pagerdutyConfigs:
    - serviceKey:
        name: pagerduty-key-payments
        key: serviceKey
      description: "{{ .GroupLabels.alertname }}: {{ .CommonAnnotations.summary }}"
      sendResolved: true
```

## ThanosRuler Integration

For multi-cluster environments, `ThanosRuler` runs alerting rules against Thanos Query, enabling cross-cluster alerting that individual Prometheus instances cannot provide:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ThanosRuler
metadata:
  name: global-rules
  namespace: monitoring
spec:
  # Connect to Thanos Query for global metrics access
  queryEndpoints:
  - thanos-query.thanos.svc.cluster.local:10901

  resources:
    requests:
      cpu: "200m"
      memory: "512Mi"
    limits:
      cpu: "1"
      memory: "1Gi"

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: gp3
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 50Gi

  # Select PrometheusRule objects for global rules
  ruleSelector:
    matchLabels:
      scope: global
  ruleNamespaceSelector:
    matchLabels:
      monitoring.io/scope: global

  alertmanagersUrl:
  - "dnssrv+http://_web._tcp.alertmanager-operated.monitoring.svc.cluster.local"

  # Object storage for rule evaluation state
  objectStorageConfig:
    key: thanos.yaml
    name: thanos-objstore-config
```

## Remote Write Configuration

### Sending Metrics to a Remote Backend

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: platform
  namespace: monitoring
spec:
  # ... (other fields)

  remoteWrite:
  # Write to Thanos Receive for long-term storage
  - url: "http://thanos-receive.thanos.svc.cluster.local:19291/api/v1/receive"
    name: thanos-receive
    remoteTimeout: 30s
    queueConfig:
      capacity: 10000
      maxSamplesPerSend: 2000
      batchSendDeadline: 5s
      minShards: 2
      maxShards: 20
    # Write-ahead log for durability
    writeRelabelConfigs:
    # Drop internal Prometheus metrics from remote write
    - sourceLabels: [__name__]
      regex: prometheus_.*
      action: drop

  # Write to Grafana Cloud (example secondary destination)
  - url: "https://prometheus-blocks-prod-us-central1.grafana.net/api/prom/push"
    name: grafana-cloud
    basicAuth:
      username:
        name: grafana-cloud-credentials
        key: username
      password:
        name: grafana-cloud-credentials
        key: password
    queueConfig:
      capacity: 5000
      maxSamplesPerSend: 1000
    # Only forward critical SLO metrics to reduce cost
    writeRelabelConfigs:
    - sourceLabels: [__name__]
      regex: "payment_api:.*|slo:.*"
      action: keep
```

## Retention and Storage Sizing

### Sizing Guidelines

| Workload | Metrics/sec | 30-day Storage |
|---|---|---|
| 100 pods, 50 metrics each | ~5,000 | ~15 GB |
| 500 pods, 100 metrics each | ~50,000 | ~150 GB |
| 2000 pods, 200 metrics each | ~400,000 | ~1.2 TB |
| 10,000 pods, 300 metrics each | ~3,000,000 | ~9 TB |

These estimates assume 1 byte per sample on-disk after compression. Actual storage depends on label cardinality and metric churn rate.

```yaml
# Prometheus storage configuration for a mid-size cluster
spec:
  retention: 30d
  retentionSize: "450GiB"  # Hard cap; triggers early deletion when reached

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: gp3
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 500Gi  # Buffer above retentionSize
```

### Configuring Scrape Intervals

Reduce storage footprint by using longer scrape intervals for low-priority metrics:

```yaml
# Fast scraping for SLO-critical metrics (15s)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: payment-api-slo
  namespace: production
spec:
  endpoints:
  - port: metrics
    interval: 15s
    scrapeTimeout: 10s

---
# Slower scraping for capacity planning metrics (5m)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: infrastructure-capacity
  namespace: monitoring
spec:
  endpoints:
  - port: metrics
    interval: 5m
    scrapeTimeout: 30s
```

## Managing Multiple Prometheus Instances by Team

### Namespace-Based Team Isolation

Label namespaces to control which Prometheus instances discover which ServiceMonitors:

```bash
# Label team namespaces for monitoring routing
kubectl label namespace payments-production monitoring.io/team=payments
kubectl label namespace payments-staging monitoring.io/team=payments
kubectl label namespace platform-tools monitoring.io/team=platform
kubectl label namespace security-tools monitoring.io/team=security
```

Each team's Prometheus uses a `serviceMonitorNamespaceSelector` targeting their label:

```yaml
# Payments team Prometheus
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: payments-prometheus
  namespace: payments-monitoring
spec:
  serviceMonitorSelector:
    matchLabels:
      monitoring: payments
  serviceMonitorNamespaceSelector:
    matchLabels:
      monitoring.io/team: payments
  externalLabels:
    team: payments
    cluster: production

---
# Security team Prometheus
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: security-prometheus
  namespace: security-monitoring
spec:
  serviceMonitorSelector:
    matchLabels:
      monitoring: security
  serviceMonitorNamespaceSelector:
    matchLabels:
      monitoring.io/team: security
  externalLabels:
    team: security
    cluster: production
```

### RBAC for ServiceMonitor Namespace Selection

Team members should be able to create ServiceMonitors in their namespaces without cluster-admin access:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: servicemonitor-editor
  namespace: payments-production
rules:
- apiGroups: ["monitoring.coreos.com"]
  resources: ["servicemonitors", "podmonitors", "prometheusrules"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-team-monitoring
  namespace: payments-production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: servicemonitor-editor
subjects:
- kind: Group
  name: payments-engineers
  apiGroup: rbac.authorization.k8s.io
```

The Prometheus instance in the `payments-monitoring` namespace needs a ClusterRole to read Services and Endpoints across namespaces for scraping:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-payments
rules:
- apiGroups: [""]
  resources:
  - nodes
  - nodes/metrics
  - services
  - endpoints
  - pods
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get"]
- nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus-payments
subjects:
- kind: ServiceAccount
  name: prometheus-payments
  namespace: payments-monitoring
```

## PrometheusAgent: Metric Forwarding Without Storage

`PrometheusAgent` is a CRD available in Prometheus Operator 0.65+. It runs the Prometheus scrape engine without local storage, forwarding all metrics via remote write. This is ideal for edge nodes, IoT aggregators, or clusters where storage cost needs to be minimized.

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: PrometheusAgent
metadata:
  name: edge-collector
  namespace: monitoring
spec:
  # No storage configuration; agent mode only
  serviceAccountName: prometheus-edge

  resources:
    requests:
      cpu: "100m"
      memory: "256Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"

  serviceMonitorSelector:
    matchLabels:
      monitoring: edge
  serviceMonitorNamespaceSelector: {}

  # All metrics are forwarded; no local retention
  remoteWrite:
  - url: "http://thanos-receive.central-monitoring.svc.cluster.local:19291/api/v1/receive"
    name: central-thanos
    queueConfig:
      capacity: 5000
      maxSamplesPerSend: 1000
      maxShards: 5
    externalLabels:
      cluster: edge-site-dallas
      region: us-south

  externalLabels:
    cluster: edge-site-dallas
```

PrometheusAgent does not have a `/graph` or `/alerts` endpoint—it is purely a scrape-and-forward component. Monitor it via the Prometheus Operator metrics.

## Upgrading the Prometheus Operator

### Upgrade Strategy

The Prometheus Operator CRDs must be upgraded before the operator binary:

```bash
# Step 1: Review the release notes for breaking changes
# https://github.com/prometheus-operator/prometheus-operator/releases

# Step 2: Upgrade CRDs first
# For Helm-managed installations:
helm show values prometheus-community/kube-prometheus-stack --version 66.0.0 | grep crd

# CRDs are not automatically upgraded by Helm;
# apply them manually before the Helm upgrade:
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.78.0/example/prometheus-operator-crd/monitoring.coreos.com_prometheuses.yaml

kubectl apply --server-side -f \
  https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.78.0/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml

# Apply all CRDs from the release bundle:
for crd_url in \
  monitoring.coreos.com_alertmanagerconfigs.yaml \
  monitoring.coreos.com_alertmanagers.yaml \
  monitoring.coreos.com_podmonitors.yaml \
  monitoring.coreos.com_probes.yaml \
  monitoring.coreos.com_prometheusagents.yaml \
  monitoring.coreos.com_prometheuses.yaml \
  monitoring.coreos.com_prometheusrules.yaml \
  monitoring.coreos.com_scrapeconfigs.yaml \
  monitoring.coreos.com_servicemonitors.yaml \
  monitoring.coreos.com_thanosrulers.yaml; do
  kubectl apply --server-side -f \
    "https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.78.0/example/prometheus-operator-crd/${crd_url}"
done

# Step 3: Upgrade the operator
helm upgrade prometheus-operator prometheus-community/kube-prometheus-stack \
  --namespace monitoring-system \
  --version 66.0.0 \
  --reuse-values

# Step 4: Verify the operator restarted cleanly
kubectl rollout status deployment prometheus-operator -n monitoring-system

# Step 5: Verify Prometheus StatefulSets are healthy
kubectl get statefulset -n monitoring
kubectl get pods -n monitoring
```

### Handling Deprecated CRD Fields

Between major versions, some CRD fields are deprecated or renamed:

```bash
# Check for deprecated fields in existing Prometheus objects
kubectl get prometheus --all-namespaces -o yaml | \
  grep -E "serviceMonitorNamespaceSelector|podMonitorNamespaceSelector" | \
  head -20

# The operator logs will warn about deprecated configurations
kubectl logs -l app.kubernetes.io/name=prometheus-operator \
  -n monitoring-system | grep -i deprecated
```

## Common Troubleshooting

### Prometheus Not Scraping a Target

```bash
# 1. Check if the target appears in the Prometheus targets page
kubectl port-forward svc/prometheus-operated 9090:9090 -n monitoring
# Visit http://localhost:9090/targets

# 2. Check ServiceMonitor selector matching
kubectl get prometheus platform -n monitoring \
  -o jsonpath='{.spec.serviceMonitorSelector}' | jq .

kubectl get servicemonitor -n production --show-labels

# 3. Verify namespace selector labels
kubectl get namespace production --show-labels | \
  grep monitoring

# 4. Check that the Service has a named port matching the ServiceMonitor endpoint port
kubectl get svc payment-api -n production \
  -o jsonpath='{.spec.ports[*].name}'

# 5. Check the Prometheus operator logs
kubectl logs -l app.kubernetes.io/name=prometheus-operator \
  -n monitoring-system --since=1h | grep -E "error|warn"
```

### PrometheusRule Not Loaded

```bash
# Check if rule was picked up (status.observedGeneration)
kubectl get prometheusrule payment-service-rules -n production \
  -o jsonpath='{.status}'

# Check Prometheus /rules endpoint
curl -s http://localhost:9090/api/v1/rules | \
  jq '.data.groups[].name' | sort

# Verify ruleSelector matches
kubectl get prometheus platform -n monitoring \
  -o jsonpath='{.spec.ruleSelector}'

kubectl get prometheusrule -n production --show-labels
```

### Alertmanager Not Receiving Alerts

```bash
# Check Alertmanager configuration
kubectl get secret alertmanager-platform -n monitoring \
  -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d

# Check AlertmanagerConfig status
kubectl get alertmanagerconfig -n production \
  -o wide

# Verify alerts are firing in Prometheus
curl -s http://localhost:9090/api/v1/alerts | \
  jq '.data.alerts[] | select(.state=="firing")'

# Check Alertmanager logs
kubectl logs -l alertmanager=platform -n monitoring --tail=50
```
