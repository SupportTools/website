---
title: "Prometheus Operator Deep Dive: ServiceMonitors, PodMonitors, and Alert Management"
date: 2028-04-10T00:00:00-05:00
draft: false
tags: ["Prometheus", "Kubernetes", "Monitoring", "ServiceMonitor", "Alertmanager"]
categories: ["Monitoring", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to the Prometheus Operator covering ServiceMonitors, PodMonitors, PrometheusRules, Alertmanager configuration, RBAC, scrape authorization, and multi-tenant monitoring architectures."
more_link: "yes"
url: "/prometheus-operator-deep-dive-guide/"
---

The Prometheus Operator transforms Prometheus configuration from static file management into a fully Kubernetes-native workflow. Instead of editing scrape_configs YAML and reloading Prometheus, teams define ServiceMonitors and PodMonitors as Kubernetes objects, and the operator reconciles them automatically. This guide covers the complete Prometheus Operator stack from installation through production multi-tenant monitoring architectures.

<!--more-->

# Prometheus Operator Deep Dive: ServiceMonitors, PodMonitors, and Alert Management

## Prometheus Operator Architecture

The Prometheus Operator manages several Custom Resource Definitions:

- **Prometheus**: Defines a Prometheus deployment with configuration, storage, and retention settings
- **Alertmanager**: Manages an Alertmanager cluster deployment
- **ServiceMonitor**: Tells Prometheus how to scrape a Service's endpoints
- **PodMonitor**: Tells Prometheus how to scrape pods directly (without a Service)
- **PrometheusRule**: Defines alerting and recording rules
- **ScrapeConfig**: Low-level scrape configuration (kube-prometheus-stack v0.65+)
- **AlertmanagerConfig**: Namespace-scoped Alertmanager routing and receivers

The operator watches these CRDs and generates the corresponding Prometheus and Alertmanager configuration files, then triggers a configuration reload.

## Installation with kube-prometheus-stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Production installation with custom values
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --create-namespace \
    --version 61.0.0 \
    -f prometheus-values.yaml
```

```yaml
# prometheus-values.yaml
prometheus:
  prometheusSpec:
    # How long to retain metrics (increase based on storage)
    retention: 30d
    retentionSize: "50GB"

    # Storage configuration
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 100Gi

    # Resource limits for the Prometheus pod
    resources:
      requests:
        cpu: 500m
        memory: 2Gi
      limits:
        cpu: 2000m
        memory: 8Gi

    # Discovery: which namespaces to watch for ServiceMonitors
    # Empty means all namespaces
    serviceMonitorNamespaceSelector: {}
    serviceMonitorSelector: {}
    podMonitorNamespaceSelector: {}
    podMonitorSelector: {}
    ruleNamespaceSelector: {}
    ruleSelector: {}

    # External labels for multi-cluster federation
    externalLabels:
      cluster: production-us-east-1
      environment: production

    # Remote write for long-term storage (Thanos/Cortex/VictoriaMetrics)
    remoteWrite:
    - url: https://thanos-receive.monitoring.svc.cluster.local:19291/api/v1/receive
      tlsConfig:
        ca:
          secret:
            name: thanos-tls
            key: ca.crt
        cert:
          secret:
            name: thanos-tls
            key: tls.crt
        keySecret:
          name: thanos-tls
          key: tls.key

    # Scrape interval configuration
    scrapeInterval: 30s
    scrapeTimeout: 10s
    evaluationInterval: 30s

    # Sharding for large clusters
    shards: 1  # Increase for horizontal scaling

alertmanager:
  alertmanagerSpec:
    replicas: 3
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          resources:
            requests:
              storage: 10Gi
```

## ServiceMonitor: Scraping Services

A ServiceMonitor selects Services to scrape and configures how to scrape them. The operator matches ServiceMonitors to Services using label selectors.

```yaml
# Basic ServiceMonitor for a web application
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: payment-service-monitor
  namespace: team-payments
  labels:
    # This label must match the Prometheus serviceMonitorSelector
    team: payments
    monitoring: "true"
spec:
  # Select Services in the team-payments namespace (or any namespace if empty)
  namespaceSelector:
    matchNames:
    - team-payments
  # Select Services with these labels
  selector:
    matchLabels:
      app: payment-service
      metrics-enabled: "true"
  endpoints:
  - port: metrics          # Named port in the Service
    path: /metrics         # Default, optional
    interval: 30s          # Override global interval
    scrapeTimeout: 10s
    # TLS configuration for HTTPS metrics endpoints
    scheme: https
    tlsConfig:
      caFile: /etc/prometheus/secrets/service-ca/service-ca.crt
      insecureSkipVerify: false
    # Authentication using a bearer token
    authorization:
      credentials:
        name: payment-service-metrics-token
        key: token
```

### ServiceMonitor with Multiple Endpoints

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: grpc-service-monitor
  namespace: team-api
spec:
  selector:
    matchLabels:
      app: grpc-api
  endpoints:
  # HTTP metrics endpoint
  - port: http-metrics
    path: /metrics
    interval: 15s
  # gRPC metrics via Prometheus exposition (port 9090)
  - port: grpc-metrics
    path: /metrics
    interval: 15s
    relabelings:
    # Add source label to distinguish endpoints
    - sourceLabels: [__address__]
      targetLabel: instance
    - targetLabel: endpoint_type
      replacement: grpc
  # Slow-changing business metrics — scrape less frequently
  - port: business-metrics
    path: /business-metrics
    interval: 5m
```

### MetricRelabelings for Cardinality Control

High-cardinality metrics are the leading cause of Prometheus OOM issues. Use `metricRelabelings` to drop unnecessary labels:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: high-cardinality-service-monitor
  namespace: team-ecommerce
spec:
  selector:
    matchLabels:
      app: order-service
  endpoints:
  - port: metrics
    metricRelabelings:
    # Drop high-cardinality user_id label from all metrics
    - action: labeldrop
      regex: user_id

    # Drop entire high-cardinality metrics that aren't needed
    - sourceLabels: [__name__]
      regex: "go_gc_.*|go_goroutines_.*|process_.*"
      action: drop

    # Replace long pod names with just the deployment base
    - sourceLabels: [pod]
      regex: "(.*)-[a-z0-9]+-[a-z0-9]+"
      replacement: "${1}"
      targetLabel: pod_base

    # Keep only specific metrics for storage savings
    - sourceLabels: [__name__]
      regex: "(http_requests_total|http_request_duration_seconds.*|db_query_duration_seconds.*)"
      action: keep
```

## PodMonitor: Scraping Pods Directly

PodMonitors scrape pods that expose metrics but don't have a corresponding Service. This is common for batch jobs and DaemonSets.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: background-worker-monitor
  namespace: processing
spec:
  namespaceSelector:
    matchNames:
    - processing
  selector:
    matchLabels:
      app: background-worker
  podMetricsEndpoints:
  - port: metrics
    path: /metrics
    interval: 60s
    relabelings:
    # Add job name from pod label
    - sourceLabels: [__meta_kubernetes_pod_label_job_name]
      targetLabel: job_name
    # Add pod IP
    - sourceLabels: [__meta_kubernetes_pod_ip]
      targetLabel: pod_ip
    # Add node name
    - sourceLabels: [__meta_kubernetes_pod_node_name]
      targetLabel: node
```

## PrometheusRule: Alerting and Recording Rules

PrometheusRules define both alerting rules and recording rules. Recording rules pre-compute expensive queries to improve dashboard performance.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payment-service-rules
  namespace: team-payments
  labels:
    team: payments
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  # Recording rules: pre-compute expensive aggregations
  - name: payment-recording-rules
    interval: 1m
    rules:
    # Pre-compute per-path error rate for dashboard use
    - record: payment:http_request_error_rate:1m
      expr: |
        sum(rate(http_requests_total{
          job="payment-service",
          status_code=~"5.."
        }[1m])) by (path)
        /
        sum(rate(http_requests_total{
          job="payment-service"
        }[1m])) by (path)

    # Pre-compute p99 latency
    - record: payment:http_request_duration_p99:5m
      expr: |
        histogram_quantile(0.99,
          sum(rate(http_request_duration_seconds_bucket{
            job="payment-service"
          }[5m])) by (le, path)
        )

  # Alerting rules
  - name: payment-service-alerts
    rules:
    # SLO: 99.9% availability (error rate < 0.1%)
    - alert: PaymentServiceHighErrorRate
      expr: |
        (
          sum(rate(http_requests_total{job="payment-service", status_code=~"5.."}[5m]))
          /
          sum(rate(http_requests_total{job="payment-service"}[5m]))
        ) > 0.001
      for: 5m
      labels:
        severity: critical
        team: payments
        slo: availability
      annotations:
        summary: "Payment service error rate above SLO"
        description: "Error rate is {{ $value | humanizePercentage }} (SLO: 0.1%)"
        runbook_url: "https://wiki.example.com/runbooks/payment-high-error-rate"
        dashboard_url: "https://grafana.example.com/d/payments"

    # SLO: p99 latency < 500ms
    - alert: PaymentServiceHighLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(http_request_duration_seconds_bucket{
            job="payment-service"
          }[5m])) by (le)
        ) > 0.5
      for: 5m
      labels:
        severity: warning
        team: payments
        slo: latency
      annotations:
        summary: "Payment service p99 latency above SLO"
        description: "p99 latency is {{ $value | humanizeDuration }} (SLO: 500ms)"

    # Saturation: Deployment unavailable
    - alert: PaymentServiceUnavailable
      expr: |
        kube_deployment_status_replicas_available{
          namespace="team-payments",
          deployment="payment-service"
        } == 0
      for: 1m
      labels:
        severity: critical
        team: payments
        page: "true"  # This alert should page
      annotations:
        summary: "Payment service has zero available replicas"
        description: "All replicas are unavailable. Immediate action required."

    # Capacity: approaching resource limits
    - alert: PaymentServiceCPUThrottling
      expr: |
        (
          sum(rate(container_cpu_cfs_throttled_seconds_total{
            namespace="team-payments",
            container="payment-service"
          }[5m]))
          /
          sum(rate(container_cpu_cfs_periods_total{
            namespace="team-payments",
            container="payment-service"
          }[5m]))
        ) > 0.25
      for: 15m
      labels:
        severity: warning
        team: payments
      annotations:
        summary: "Payment service pods are CPU throttled"
        description: "{{ $value | humanizePercentage }} of CPU scheduling periods are throttled"
```

## Alertmanager Configuration

```yaml
# AlertmanagerConfig for namespace-scoped routing
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: payment-team-alerting
  namespace: team-payments
spec:
  route:
    # Match alerts from the payments team
    matchers:
    - name: team
      value: payments
      matchType: "="
    # Grouping: send one notification per alert name per 5m
    groupBy: ["alertname", "severity"]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 4h
    # Route critical to PagerDuty, warning to Slack
    routes:
    - matchers:
      - name: severity
        value: critical
        matchType: "="
      receiver: pagerduty-payments
      repeatInterval: 30m
    - matchers:
      - name: severity
        value: warning
        matchType: "="
      receiver: slack-payments-warnings

  receivers:
  - name: pagerduty-payments
    pagerdutyConfigs:
    - serviceKey:
        name: pagerduty-payments-secret
        key: service-key
      severity: "{{ .CommonLabels.severity }}"
      description: "{{ .CommonAnnotations.description }}"
      details:
        team: "{{ .CommonLabels.team }}"
        runbook: "{{ .CommonAnnotations.runbook_url }}"

  - name: slack-payments-warnings
    slackConfigs:
    - apiURL:
        name: slack-webhook-secret
        key: webhook-url
      channel: "#payments-alerts"
      title: "{{ .CommonAnnotations.summary }}"
      text: |
        *Alert:* {{ .CommonAnnotations.summary }}
        *Severity:* {{ .CommonLabels.severity }}
        *Description:* {{ .CommonAnnotations.description }}
        *Runbook:* {{ .CommonAnnotations.runbook_url }}
      sendResolved: true
```

## RBAC for Multi-Tenant Monitoring

In multi-tenant clusters, you want teams to manage their own ServiceMonitors and PrometheusRules without accessing other teams' resources:

```yaml
# ClusterRole allowing teams to manage their own monitoring resources
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-manager
rules:
- apiGroups: ["monitoring.coreos.com"]
  resources:
  - servicemonitors
  - podmonitors
  - prometheusrules
  - alertmanagerconfigs
  verbs: ["*"]
---
# Bind within the team's namespace only
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-monitoring-manager
  namespace: team-payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: monitoring-manager
subjects:
- kind: Group
  name: team-payments-admins
  apiGroup: rbac.authorization.k8s.io
```

## Scrape Authentication Patterns

### Bearer Token from Secret

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: secure-service-monitor
spec:
  endpoints:
  - port: metrics
    authorization:
      type: Bearer
      credentials:
        name: metrics-auth-secret
        key: token
---
apiVersion: v1
kind: Secret
metadata:
  name: metrics-auth-secret
type: Opaque
stringData:
  token: "metrics-scrape-token-value"
```

### mTLS Authentication

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: mtls-service-monitor
spec:
  endpoints:
  - port: metrics
    scheme: https
    tlsConfig:
      ca:
        secret:
          name: prometheus-client-tls
          key: ca.crt
      cert:
        secret:
          name: prometheus-client-tls
          key: tls.crt
      keySecret:
        name: prometheus-client-tls
        key: tls.key
      serverName: myservice.team-payments.svc.cluster.local
```

### OAuth2 / OIDC Scrape Authentication

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: oauth2-service-monitor
spec:
  endpoints:
  - port: metrics
    oauth2:
      clientId:
        secret:
          name: oauth2-credentials
          key: client-id
      clientSecret:
        name: oauth2-credentials
        key: client-secret
      tokenUrl: https://auth.example.com/oauth/token
      scopes:
      - "metrics:read"
```

## Sharding for Large Clusters

For clusters with thousands of targets, a single Prometheus instance may not be sufficient. Use sharding:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-sharded
  namespace: monitoring
spec:
  # Number of Prometheus shards
  shards: 3
  # Each shard scrapes 1/N of targets based on consistent hashing
  replicas: 2  # HA within each shard

  # Thanos sidecar for cross-shard querying
  thanos:
    baseImage: quay.io/thanos/thanos
    version: v0.35.0
    objectStorageConfig:
      name: thanos-objstore-config
      key: objstore.yml
```

## Custom Service Discovery with ScrapeConfig

For scraping targets outside Kubernetes (external databases, networking equipment):

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: external-postgres-scrape
  namespace: monitoring
spec:
  staticConfigs:
  - targets:
    - "postgres-primary.db.internal:9187"
    - "postgres-replica-1.db.internal:9187"
    - "postgres-replica-2.db.internal:9187"
    labels:
      job: postgresql
      env: production

  relabelings:
  - sourceLabels: [__address__]
    regex: "(.*)-(primary|replica-\\d+).*"
    replacement: "${2}"
    targetLabel: role
```

## Testing PrometheusRules

```bash
# Install promtool
go install github.com/prometheus/prometheus/cmd/promtool@latest

# Write unit tests for alerting rules
# tests/payment_rules_test.yaml
```

```yaml
# tests/payment_rules_test.yaml
rule_files:
  - ../rules/payment-service-rules.yaml

evaluation_interval: 1m

tests:
- interval: 1m
  input_series:
  # Simulate high error rate
  - series: 'http_requests_total{job="payment-service",status_code="500"}'
    values: "0 10 20 30 40 50 60 70 80 90 100"
  - series: 'http_requests_total{job="payment-service",status_code="200"}'
    values: "0 990 1980 2970 3960 4950 5940 6930 7920 8910 9900"

  alert_rule_test:
  - eval_time: 5m
    alertname: PaymentServiceHighErrorRate
    exp_alerts:
    - exp_labels:
        severity: critical
        team: payments
      exp_annotations:
        summary: "Payment service error rate above SLO"

- interval: 1m
  input_series:
  # Simulate normal operation
  - series: 'http_requests_total{job="payment-service",status_code="200"}'
    values: "0 1000 2000 3000"
  - series: 'http_requests_total{job="payment-service",status_code="500"}'
    values: "0 0 0 0"

  alert_rule_test:
  - eval_time: 5m
    alertname: PaymentServiceHighErrorRate
    exp_alerts: []  # No alerts expected
```

```bash
# Run the tests
promtool test rules tests/payment_rules_test.yaml

# Validate rule syntax
promtool check rules rules/payment-service-rules.yaml

# Lint rule files
promtool check rules --lint=all rules/*.yaml
```

## Grafana Dashboard Automation

```yaml
# GrafanaDashboard CRD (Grafana Operator)
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDashboard
metadata:
  name: payment-service-dashboard
  namespace: team-payments
spec:
  instanceSelector:
    matchLabels:
      dashboards: grafana
  folder: "Payment Team"
  json: |
    {
      "title": "Payment Service Overview",
      "panels": [
        {
          "title": "Request Rate",
          "type": "timeseries",
          "targets": [
            {
              "expr": "sum(rate(http_requests_total{job=\"payment-service\"}[5m])) by (status_code)",
              "legendFormat": "{{ status_code }}"
            }
          ]
        },
        {
          "title": "Error Rate vs SLO",
          "type": "gauge",
          "targets": [
            {
              "expr": "1 - (sum(rate(http_requests_total{job=\"payment-service\",status_code=~\"5..\"}[5m])) / sum(rate(http_requests_total{job=\"payment-service\"}[5m])))",
              "legendFormat": "Availability"
            }
          ],
          "fieldConfig": {
            "defaults": {
              "thresholds": {
                "steps": [
                  {"value": 0, "color": "red"},
                  {"value": 0.999, "color": "green"}
                ]
              }
            }
          }
        }
      ]
    }
```

## Upgrade and Maintenance

```bash
# Check Prometheus Operator version
kubectl get deployment kube-prometheus-stack-operator \
    -n monitoring \
    -o jsonpath='{.spec.template.spec.containers[0].image}'

# Upgrade kube-prometheus-stack
helm upgrade kube-prometheus-stack prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --version 62.0.0 \
    -f prometheus-values.yaml \
    --atomic \
    --timeout 10m

# After upgrade, verify all CRDs are at latest version
kubectl get crd | grep monitoring.coreos.com

# Check for deprecation warnings in operator logs
kubectl logs -n monitoring \
    -l app.kubernetes.io/name=prometheus-operator \
    --since=1h | grep -i "deprecated\|warning"
```

## Conclusion

The Prometheus Operator provides a powerful, Kubernetes-native approach to monitoring configuration management. ServiceMonitors and PodMonitors eliminate the need to manually maintain scrape_configs. PrometheusRules enable version-controlled, testable alerting logic. AlertmanagerConfig enables teams to own their routing without cluster-admin access. Combined with recording rules for performance and metricRelabelings for cardinality control, the Prometheus Operator stack provides a complete observability foundation for production Kubernetes clusters at any scale.
