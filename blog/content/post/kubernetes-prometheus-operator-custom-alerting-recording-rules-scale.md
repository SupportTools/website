---
title: "Kubernetes Prometheus Operator: Custom Alerting Rules and Recording Rules at Scale"
date: 2030-12-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Alerting", "Monitoring", "Observability", "PrometheusRule", "Alertmanager", "SRE"]
categories:
- Kubernetes
- Monitoring
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Prometheus Operator alerting at scale: PrometheusRule CRD design patterns, Alertmanager routing trees, recording rules for query optimization, namespace-scoped vs cluster-wide rules, runbook URL integration, and managing thousands of alert rules across multi-tenant clusters."
more_link: "yes"
url: "/kubernetes-prometheus-operator-custom-alerting-recording-rules-scale/"
---

The Prometheus Operator transforms alert rule management from manual YAML file editing into Kubernetes-native declarative configuration. At scale, poorly structured PrometheusRules create alert storms, false positives, and query performance problems. This guide covers production-grade patterns for designing, organizing, and operating alerting rules across multi-tenant Kubernetes clusters.

<!--more-->

# Kubernetes Prometheus Operator: Custom Alerting Rules and Recording Rules at Scale

## Section 1: PrometheusRule CRD Architecture

The `PrometheusRule` CRD defines Prometheus alerting and recording rules as Kubernetes resources. The Prometheus Operator watches these resources and automatically reloads Prometheus configuration when they change — no manual `curl -X POST /-/reload` required.

### Understanding Rule Selection

Prometheus instances select PrometheusRules via label selectors. This is how multi-tenancy works:

```yaml
# The Prometheus instance defines which rules it picks up
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: cluster-prometheus
  namespace: monitoring
spec:
  # Select rules from all namespaces with this label
  ruleSelector:
    matchLabels:
      prometheus: kube-prometheus
      role: alert-rules
  # Select rules from specific namespaces
  ruleNamespaceSelector:
    matchLabels:
      monitoring: enabled
  # Or select from all namespaces
  # ruleNamespaceSelector: {}
```

### PrometheusRule Structure

```yaml
# anatomy of a PrometheusRule
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: application-alerts
  namespace: production
  labels:
    # These labels must match the Prometheus ruleSelector
    prometheus: kube-prometheus
    role: alert-rules
    # Team ownership label for routing and filtering
    team: platform
    severity-tier: critical
spec:
  groups:
    - name: application.rules        # Group name — must be unique per PrometheusRule
      interval: 1m                   # Optional: evaluation interval (default: global)
      rules:
        - alert: HighErrorRate       # Alert name
          # PromQL expression — must evaluate to a non-empty vector to fire
          expr: |
            (
              rate(http_requests_total{status=~"5.."}[5m])
              /
              rate(http_requests_total[5m])
            ) > 0.05
          for: 2m                    # Must be true for this duration before firing
          labels:
            severity: critical       # Used by Alertmanager for routing
            team: platform
            category: availability
          annotations:
            summary: "High error rate on {{ $labels.service }}"
            description: |
              Service {{ $labels.service }} in namespace {{ $labels.namespace }}
              has error rate {{ $value | humanizePercentage }} over the last 5 minutes.
              Threshold: 5%
            runbook_url: "https://runbooks.support.tools/high-error-rate"
            dashboard_url: "https://grafana.support.tools/d/abc123/service-overview?var-service={{ $labels.service }}"
```

## Section 2: Recording Rules for Query Performance

Recording rules pre-compute expensive PromQL expressions and store the results as new time series. This is critical for dashboards and alerts that run complex aggregations over millions of time series.

### When to Use Recording Rules

Recording rules are necessary when:
- A query takes more than 1 second to evaluate
- A query is used in multiple alerts or dashboards
- You need a multi-level aggregation (aggregate → aggregate the aggregation)
- Alert rules reference a query that spans multiple metric sources

### Naming Convention

Follow the official Prometheus naming convention: `level:metric:operations`

```
level     = aggregation level (cluster, namespace, pod, service)
metric    = the base metric name being aggregated
operations = operations applied (rate, sum, avg, max, ratio)
```

### Recording Rules for HTTP Service SLIs

```yaml
# recording-rules-http-sli.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: http-sli-recording-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
    type: recording-rules
spec:
  groups:
    - name: http_sli.recording_rules
      interval: 30s
      rules:
        # Request rate per service
        - record: namespace_service:http_requests:rate5m
          expr: |
            sum by (namespace, service, method, status) (
              rate(http_requests_total[5m])
            )

        # Error rate per service (5xx responses)
        - record: namespace_service:http_errors:rate5m
          expr: |
            sum by (namespace, service) (
              rate(http_requests_total{status=~"5.."}[5m])
            )

        # Error ratio per service
        - record: namespace_service:http_error_ratio:rate5m
          expr: |
            (
              namespace_service:http_errors:rate5m
              /
              sum by (namespace, service) (
                namespace_service:http_requests:rate5m
              )
            )

        # Request latency p50
        - record: namespace_service:http_request_duration_seconds:p50
          expr: |
            histogram_quantile(0.50,
              sum by (namespace, service, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # Request latency p95
        - record: namespace_service:http_request_duration_seconds:p95
          expr: |
            histogram_quantile(0.95,
              sum by (namespace, service, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # Request latency p99
        - record: namespace_service:http_request_duration_seconds:p99
          expr: |
            histogram_quantile(0.99,
              sum by (namespace, service, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # Apdex score (requests completing within threshold / total)
        # Satisfying: < 0.3s, Tolerating: < 1.2s
        - record: namespace_service:http_apdex_score:rate5m
          expr: |
            (
              sum by (namespace, service) (
                rate(http_request_duration_seconds_bucket{le="0.3"}[5m])
              )
              +
              sum by (namespace, service) (
                rate(http_request_duration_seconds_bucket{le="1.2"}[5m])
              )
              / 2
            )
            /
            sum by (namespace, service) (
              rate(http_request_duration_seconds_count[5m])
            )
```

### Recording Rules for Resource Utilization

```yaml
# recording-rules-resources.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: resource-utilization-recording-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: resource_utilization.recording_rules
      interval: 1m
      rules:
        # CPU utilization ratio per pod (against request)
        - record: namespace_pod:cpu_utilization_ratio:rate5m
          expr: |
            sum by (namespace, pod, container) (
              rate(container_cpu_usage_seconds_total{container!=""}[5m])
            )
            /
            sum by (namespace, pod, container) (
              kube_pod_container_resource_requests{resource="cpu", container!=""}
            )

        # Memory utilization ratio per pod (against request)
        - record: namespace_pod:memory_utilization_ratio
          expr: |
            sum by (namespace, pod, container) (
              container_memory_working_set_bytes{container!=""}
            )
            /
            sum by (namespace, pod, container) (
              kube_pod_container_resource_requests{resource="memory", container!=""}
            )

        # Namespace CPU utilization (percentage of allocatable)
        - record: namespace:cpu_usage_ratio
          expr: |
            sum by (namespace) (
              rate(container_cpu_usage_seconds_total{container!=""}[5m])
            )
            /
            scalar(
              sum(kube_node_status_allocatable{resource="cpu"})
            )

        # Node CPU utilization including all pods
        - record: node:cpu_utilization_ratio:rate5m
          expr: |
            1 - avg by (node) (
              rate(node_cpu_seconds_total{mode="idle"}[5m])
            )

        # Persistent volume utilization
        - record: namespace_persistentvolumeclaim:disk_utilization_ratio
          expr: |
            (
              kubelet_volume_stats_used_bytes
              /
              kubelet_volume_stats_capacity_bytes
            )
```

### Recording Rules for SLO Burn Rate

```yaml
# recording-rules-slo.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-recording-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: slo.recording_rules
      interval: 30s
      rules:
        # 99.9% SLO for HTTP availability
        # Error budget: 0.1% = 43.8 minutes/month

        # Short window burn rate (1h) — 14.4x burn rate threshold
        - record: slo:http_availability:burn_rate1h
          expr: |
            (
              sum by (service) (rate(http_requests_total{status=~"5.."}[1h]))
              /
              sum by (service) (rate(http_requests_total[1h]))
            )
            / (1 - 0.999)

        # Medium window burn rate (6h) — 6x burn rate threshold
        - record: slo:http_availability:burn_rate6h
          expr: |
            (
              sum by (service) (rate(http_requests_total{status=~"5.."}[6h]))
              /
              sum by (service) (rate(http_requests_total[6h]))
            )
            / (1 - 0.999)

        # Long window burn rate (24h) — 3x burn rate threshold
        - record: slo:http_availability:burn_rate24h
          expr: |
            (
              sum by (service) (rate(http_requests_total{status=~"5.."}[24h]))
              /
              sum by (service) (rate(http_requests_total[24h]))
            )
            / (1 - 0.999)

        # Error budget remaining (percentage)
        - record: slo:http_availability:error_budget_remaining_30d
          expr: |
            1 - (
              sum by (service) (increase(http_requests_total{status=~"5.."}[30d]))
              /
              sum by (service) (increase(http_requests_total[30d]))
            )
            / (1 - 0.999)
```

## Section 3: Alerting Rule Design Patterns

### Multi-Window Multi-Burn-Rate SLO Alerts

The Google SRE multiwindow alerting approach is the gold standard for SLO-based alerting. It reduces alert fatigue by requiring both a fast burn rate (to catch sudden outages) and a slow burn rate (to catch gradual degradation):

```yaml
# slo-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-availability-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: slo.availability.alerts
      rules:
        # Page immediately: burning error budget 14.4x faster than normal
        # Uses both 1h and 5m windows to avoid false positives
        - alert: SLOErrorBudgetBurnRateCritical
          expr: |
            slo:http_availability:burn_rate1h > 14.4
            and
            (
              sum by (service) (rate(http_requests_total{status=~"5.."}[5m]))
              /
              sum by (service) (rate(http_requests_total[5m]))
            ) / (1 - 0.999) > 14.4
          for: 2m
          labels:
            severity: critical
            slo: availability
            alert_type: burn_rate
          annotations:
            summary: "SLO burn rate critical for {{ $labels.service }}"
            description: |
              Service {{ $labels.service }} is burning error budget at {{ $value | humanize }}x
              the normal rate. At this rate, the monthly error budget will be exhausted
              in approximately {{ printf "%.1f" (div 1.0 $value | mul 30 24) }} hours.
            runbook_url: "https://runbooks.support.tools/slo-burn-rate-critical"

        # Page: burning error budget 6x faster (will exhaust in ~5 days)
        - alert: SLOErrorBudgetBurnRateHigh
          expr: |
            slo:http_availability:burn_rate6h > 6
            and
            slo:http_availability:burn_rate1h > 6
          for: 15m
          labels:
            severity: critical
            slo: availability
            alert_type: burn_rate
          annotations:
            summary: "SLO burn rate high for {{ $labels.service }}"
            description: |
              Service {{ $labels.service }} is burning error budget at {{ $value | humanize }}x
              the normal rate (measured over 6h window).
            runbook_url: "https://runbooks.support.tools/slo-burn-rate-high"

        # Ticket: burning error budget 3x faster (will exhaust in ~10 days)
        - alert: SLOErrorBudgetBurnRateElevated
          expr: |
            slo:http_availability:burn_rate24h > 3
            and
            slo:http_availability:burn_rate6h > 3
          for: 1h
          labels:
            severity: warning
            slo: availability
            alert_type: burn_rate
          annotations:
            summary: "SLO burn rate elevated for {{ $labels.service }}"
            description: |
              Service {{ $labels.service }} is burning error budget at {{ $value | humanize }}x
              the normal rate (measured over 24h window).
            runbook_url: "https://runbooks.support.tools/slo-burn-rate-elevated"

        # Alert when error budget is nearly exhausted
        - alert: SLOErrorBudgetLow
          expr: slo:http_availability:error_budget_remaining_30d < 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "SLO error budget below 10% for {{ $labels.service }}"
            description: |
              Service {{ $labels.service }} has only {{ $value | humanizePercentage }}
              of its monthly error budget remaining.
```

### Kubernetes Cluster Health Alerts

```yaml
# k8s-cluster-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-cluster-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
    team: platform
spec:
  groups:
    - name: kubernetes.cluster.alerts
      rules:
        - alert: KubernetesNodeNotReady
          expr: |
            kube_node_status_condition{condition="Ready",status="true"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Kubernetes node {{ $labels.node }} is not ready"
            description: "Node {{ $labels.node }} has been NotReady for more than 5 minutes."
            runbook_url: "https://runbooks.support.tools/node-not-ready"

        - alert: KubernetesPodCrashLooping
          expr: |
            rate(kube_pod_container_status_restarts_total[15m]) * 60 * 15 > 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash-looping"
            description: |
              Container {{ $labels.container }} in pod {{ $labels.namespace }}/{{ $labels.pod }}
              has restarted {{ $value | humanize }} times in the last 15 minutes.
            runbook_url: "https://runbooks.support.tools/pod-crashloop"

        - alert: KubernetesPersistentVolumeUsageCritical
          expr: |
            (
              kubelet_volume_stats_used_bytes
              / kubelet_volume_stats_capacity_bytes
            ) > 0.90
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is 90% full"
            description: |
              PersistentVolumeClaim {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }}
              is {{ $value | humanizePercentage }} full.
            runbook_url: "https://runbooks.support.tools/pvc-full"

        - alert: KubernetesDeploymentReplicasMismatch
          expr: |
            kube_deployment_spec_replicas
              !=
            kube_deployment_status_replicas_available
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} replica mismatch"
            description: |
              Deployment {{ $labels.deployment }} in namespace {{ $labels.namespace }}
              wants {{ $value }} replicas but has fewer available for more than 10 minutes.

        - alert: KubernetesHPAAtMaxReplicas
          expr: |
            kube_horizontalpodautoscaler_status_current_replicas
              ==
            kube_horizontalpodautoscaler_spec_max_replicas
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} at max replicas"
            description: |
              HPA {{ $labels.horizontalpodautoscaler }} in {{ $labels.namespace }} has been
              at maximum replicas ({{ $value }}) for 15 minutes. Consider increasing maxReplicas
              or right-sizing the workload.

        - alert: KubernetesCertificateExpiringSoon
          expr: |
            (certmanager_certificate_expiration_timestamp_seconds - time()) < (7 * 24 * 3600)
          for: 1h
          labels:
            severity: critical
          annotations:
            summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} expires in less than 7 days"
            description: |
              Certificate {{ $labels.namespace }}/{{ $labels.name }} expires at
              {{ $value | humanizeDuration }} from now.
            runbook_url: "https://runbooks.support.tools/certificate-expiring"
```

## Section 4: Alertmanager Configuration

### Alertmanager Routing for Multi-Team Clusters

```yaml
# alertmanager-config.yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: cluster-alertmanager-config
  namespace: monitoring
  labels:
    alertmanagerConfig: cluster
spec:
  route:
    receiver: 'default-receiver'
    groupBy: ['alertname', 'cluster', 'namespace']
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    routes:
      # Critical infrastructure alerts — page on-call immediately
      - matchers:
          - name: severity
            value: critical
          - name: team
            value: platform
        receiver: platform-pagerduty
        groupWait: 10s
        groupInterval: 1m
        repeatInterval: 4h
        continue: false

      # Application team alerts — route to their Slack
      - matchers:
          - name: team
            value: backend
        receiver: backend-slack
        routes:
          # Critical backend alerts also go to PagerDuty
          - matchers:
              - name: severity
                value: critical
            receiver: backend-pagerduty
            continue: true

      # Warnings — Slack only
      - matchers:
          - name: severity
            value: warning
        receiver: warnings-slack
        groupInterval: 10m
        repeatInterval: 24h

      # SLO burn rate alerts
      - matchers:
          - name: alert_type
            value: burn_rate
          - name: severity
            value: critical
        receiver: slo-critical-pagerduty
        groupWait: 0s
        repeatInterval: 1h

  receivers:
    - name: 'default-receiver'
      slackConfigs:
        - apiURL:
            name: alertmanager-slack-secret
            key: webhook-url
          channel: '#alerts-default'
          title: '{{ template "slack.default.title" . }}'
          text: '{{ template "slack.default.text" . }}'

    - name: 'platform-pagerduty'
      pagerdutyConfigs:
        - routingKey:
            name: alertmanager-pagerduty-secret
            key: platform-routing-key
          description: '{{ template "pagerduty.default.description" . }}'
          details:
            runbook: '{{ (index .Alerts 0).Annotations.runbook_url }}'
            dashboard: '{{ (index .Alerts 0).Annotations.dashboard_url }}'

    - name: 'backend-slack'
      slackConfigs:
        - apiURL:
            name: alertmanager-slack-secret
            key: webhook-url
          channel: '#backend-alerts'
          title: '[{{ .Status | toUpper }}{{ if eq .Status "firing" }}:{{ .Alerts.Firing | len }}{{ end }}] {{ .CommonLabels.alertname }}'
          text: |
            {{ range .Alerts }}
            *Alert:* {{ .Annotations.summary }}
            *Severity:* {{ .Labels.severity }}
            *Namespace:* {{ .Labels.namespace }}
            *Description:* {{ .Annotations.description }}
            *Runbook:* {{ .Annotations.runbook_url }}
            {{ end }}

    - name: 'warnings-slack'
      slackConfigs:
        - apiURL:
            name: alertmanager-slack-secret
            key: webhook-url
          channel: '#alerts-warnings'

    - name: 'backend-pagerduty'
      pagerdutyConfigs:
        - routingKey:
            name: alertmanager-pagerduty-secret
            key: backend-routing-key

    - name: 'slo-critical-pagerduty'
      pagerdutyConfigs:
        - routingKey:
            name: alertmanager-pagerduty-secret
            key: slo-routing-key

  inhibitRules:
    # Don't alert on pods if the node is down
    - sourceMatchers:
        - name: alertname
          value: KubernetesNodeNotReady
      targetMatchers:
        - name: alertname
          value: KubernetesPodCrashLooping
      equal: ['node']

    # Suppress warning if critical already firing for same service
    - sourceMatchers:
        - name: severity
          value: critical
      targetMatchers:
        - name: severity
          value: warning
      equal: ['service', 'namespace']
```

### Alertmanager Slack Templates

```yaml
# alertmanager-templates-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: alertmanager-templates
  namespace: monitoring
data:
  slack.tmpl: |
    {{ define "slack.support.tools.title" }}
    [{{ .Status | toUpper }}{{ if eq .Status "firing" }}:{{ .Alerts.Firing | len }}{{ end }}]
    {{ .CommonLabels.alertname }} — {{ .CommonLabels.namespace | default "cluster" }}
    {{ end }}

    {{ define "slack.support.tools.text" }}
    {{ range .Alerts }}
    *Summary:* {{ .Annotations.summary }}
    *Severity:* {{ .Labels.severity | toUpper }}
    {{ if .Labels.namespace }}*Namespace:* `{{ .Labels.namespace }}`{{ end }}
    {{ if .Labels.pod }}*Pod:* `{{ .Labels.pod }}`{{ end }}
    *Description:*
    {{ .Annotations.description }}
    {{ if .Annotations.runbook_url }}:book: <{{ .Annotations.runbook_url }}|Runbook>{{ end }}
    {{ if .Annotations.dashboard_url }}:grafana: <{{ .Annotations.dashboard_url }}|Dashboard>{{ end }}
    {{ end }}
    {{ end }}
```

## Section 5: Namespace-Scoped vs Cluster-Wide Rules

### Namespace-Scoped Rules (Team Ownership)

Application teams own their own alerting rules:

```yaml
# In namespace: team-backend (team-owned namespace)
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: backend-api-alerts
  namespace: team-backend
  labels:
    prometheus: kube-prometheus
    role: alert-rules
    team: backend
spec:
  groups:
    - name: backend.api.alerts
      rules:
        - alert: BackendAPIHighLatency
          expr: |
            namespace_service:http_request_duration_seconds:p99{namespace="team-backend"} > 2.0
          for: 5m
          labels:
            severity: warning
            team: backend
          annotations:
            summary: "Backend API p99 latency above 2s"
            description: "{{ $labels.service }} p99 latency is {{ $value | humanizeDuration }}"
            runbook_url: "https://runbooks.support.tools/backend-high-latency"
```

### Cluster-Wide Rules (Platform Team)

```yaml
# In namespace: monitoring (platform-owned)
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cluster-wide-infrastructure-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
    team: platform
    scope: cluster
spec:
  groups:
    - name: cluster.infrastructure.alerts
      rules:
        # Alerts that apply to all namespaces
        - alert: NamespaceCPUQuotaExceeded
          expr: |
            sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=""}[5m]))
            /
            sum by (namespace) (kube_resourcequota{resource="limits.cpu", type="hard"})
            > 0.9
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Namespace {{ $labels.namespace }} near CPU quota limit"
```

## Section 6: Rule Validation and Testing

### Promtool for Offline Rule Validation

```bash
# Install promtool
go install github.com/prometheus/prometheus/cmd/promtool@latest

# Validate PrometheusRule YAML (extract rules section)
# Create a rules file from the PrometheusRule spec
cat > /tmp/test-rules.yaml << 'EOF'
groups:
  - name: test.rules
    rules:
      - alert: TestAlert
        expr: up == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Instance {{ $labels.instance }} is down"
EOF

promtool check rules /tmp/test-rules.yaml

# Test rules with sample data
cat > /tmp/test-data.yaml << 'EOF'
rule_files:
  - /tmp/test-rules.yaml

evaluation_interval: 1m

tests:
  - interval: 1m
    input_series:
      - series: 'up{job="test", instance="localhost:9090"}'
        values: '1 1 1 1 1 0 0 0 0 0 0 0'

    alert_rule_test:
      - eval_time: 5m
        alertname: TestAlert
        exp_alerts: []    # No alert expected — not been down 5m yet

      - eval_time: 10m
        alertname: TestAlert
        exp_alerts:
          - exp_labels:
              job: test
              instance: localhost:9090
              severity: critical
            exp_annotations:
              summary: "Instance localhost:9090 is down"
EOF

promtool test rules /tmp/test-data.yaml
```

### CI Pipeline for PrometheusRules

```yaml
# .github/workflows/validate-prometheus-rules.yaml
name: Validate Prometheus Rules

on:
  pull_request:
    paths:
      - 'monitoring/**/*.yaml'

jobs:
  validate-rules:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install promtool
        run: |
          PROM_VERSION=2.48.0
          wget -q "https://github.com/prometheus/prometheus/releases/download/v${PROM_VERSION}/prometheus-${PROM_VERSION}.linux-amd64.tar.gz"
          tar xzf "prometheus-${PROM_VERSION}.linux-amd64.tar.gz"
          mv "prometheus-${PROM_VERSION}.linux-amd64/promtool" /usr/local/bin/

      - name: Extract and validate rules
        run: |
          find monitoring/ -name "*.yaml" -exec sh -c '
            if yq e ".kind" "$1" 2>/dev/null | grep -q "PrometheusRule"; then
              echo "Validating: $1"
              yq e ".spec" "$1" > /tmp/rule-spec.yaml
              promtool check rules /tmp/rule-spec.yaml
            fi
          ' _ {} \;

      - name: Run rule tests
        run: |
          find monitoring/ -name "*_test.yaml" -exec promtool test rules {} \;
```

## Section 7: Performance Optimization for Large Rule Sets

### Measuring Rule Evaluation Time

```bash
# Check rule evaluation duration in Prometheus metrics
curl -s http://prometheus:9090/metrics | grep prometheus_rule_evaluation_duration

# Query to find slowest rules
# In Prometheus query UI:
# topk(10, prometheus_rule_evaluation_duration_seconds{quantile="0.99"})

# Check how many rules are being evaluated
curl -s http://prometheus:9090/api/v1/rules | python3 -m json.tool | \
    python3 -c "
import json, sys
data = json.load(sys.stdin)
total = sum(len(g['rules']) for g in data['data']['groups'])
print(f'Total rules: {total}')
"
```

### Partitioning Rules Across Multiple Prometheus Instances

For clusters with 10,000+ rules, partition by namespace or team:

```yaml
# prometheus-platform.yaml — evaluates cluster-wide rules
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-platform
  namespace: monitoring
spec:
  ruleSelector:
    matchLabels:
      scope: cluster
  ruleNamespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: monitoring

---
# prometheus-tenants.yaml — evaluates namespace-scoped rules
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-tenants
  namespace: monitoring
spec:
  ruleSelector:
    matchLabels:
      scope: namespace
  ruleNamespaceSelector: {}  # All namespaces
```

### Runbook URL Integration Best Practices

```yaml
# Use a consistent URL template so teams can find runbooks programmatically
annotations:
  # Pattern: https://runbooks.domain.com/{team}/{alertname-kebab-case}
  runbook_url: "https://runbooks.support.tools/{{ $labels.team }}/{{ $labels.alertname | lower | replace \" \" \"-\" }}"
```

Store runbooks in a version-controlled repository with automatic deployment:

```bash
# runbooks/high-error-rate.md
# High Error Rate Runbook

## Alert: HighErrorRate

### Symptoms
- HTTP 5xx response rate exceeds 5% over 5 minutes
- Users report service unavailability

### Diagnosis
1. Check recent deployments:
   kubectl rollout history deployment/api-server -n production

2. Check pod logs:
   kubectl logs -n production -l app=api-server --tail=100 --since=10m

3. Check dependent services:
   kubectl get pods -n production

### Remediation
1. If caused by bad deployment: rollback
   kubectl rollout undo deployment/api-server -n production

2. If caused by dependency failure: check downstream services

### Escalation
- After 15 minutes unresolved: page backend team lead
```

The Prometheus Operator's PrometheusRule CRD makes alerting a first-class Kubernetes citizen. Combined with carefully designed recording rules, multi-window burn rate alerts, and a structured Alertmanager routing tree, you can achieve low-noise, high-signal alerting even on clusters with hundreds of applications and thousands of time series.
