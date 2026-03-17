---
title: "Prometheus Recording Rules and Alerting Rules: Production Optimization Strategies"
date: 2030-06-13T00:00:00-05:00
draft: false
tags: ["Prometheus", "Alerting", "Monitoring", "Observability", "SRE", "Kubernetes"]
categories:
- Monitoring
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Prometheus recording rules for query performance, alerting rule design, inhibition and silencing patterns, multi-tier alert routing, and managing rule files at scale."
more_link: "yes"
url: "/prometheus-recording-rules-alerting-production-optimization/"
---

Prometheus recording rules and alerting rules are foundational tools for building reliable, scalable observability platforms in enterprise environments. When implemented correctly, recording rules dramatically reduce query latency and CPU load on the Prometheus server, while well-designed alerting rules minimize noise and maximize signal quality. This guide covers production-grade patterns for both, including rule file organization, multi-tier routing with Alertmanager, and operational strategies for managing hundreds of rules across large deployments.

<!--more-->

## Why Recording Rules Matter in Production

Raw PromQL queries against high-cardinality time series are expensive. A dashboard panel that aggregates CPU usage across thousands of pods can take seconds to evaluate and consume significant CPU resources on the Prometheus server. At query time, this latency is noticeable. When the same expensive expression appears in alerting rules evaluated every 15 seconds, the compounding cost is substantial.

Recording rules pre-compute these expensive expressions and store the results as new time series. Subsequent queries against the recorded series are fast, cheap, and consistent.

### Performance Characteristics

Consider a rule that aggregates request rates across an entire cluster:

```yaml
- record: job:http_requests_total:rate5m
  expr: sum(rate(http_requests_total[5m])) by (job)
```

Without the recording rule, every dashboard panel, alert, and ad-hoc query must evaluate `rate(http_requests_total[5m])` across every time series matching the selector. With the recording rule evaluated on a 1-minute interval, downstream queries read a small, pre-aggregated series with minimal overhead.

## Recording Rule Design Principles

### Naming Convention

The Prometheus community convention for recording rules uses a hierarchical naming scheme: `level:metric:operations`. This convention is not enforced by Prometheus but is widely adopted because it makes the source and aggregation level immediately apparent.

```
level:metric:operations
```

- **level**: The aggregation level, such as `job`, `instance`, `cluster`, `namespace`, or a combination
- **metric**: The base metric name being recorded
- **operations**: The operations applied, such as `rate5m`, `sum`, `avg`

Examples:

```
job:http_requests_total:rate5m
namespace:container_cpu_usage_seconds_total:rate5m
cluster:node_memory_MemAvailable_bytes:sum
```

### Layered Aggregation

Complex aggregations should be built in layers. Each layer records an intermediate result that the next layer consumes. This approach reduces redundancy and makes the aggregation pipeline auditable.

```yaml
groups:
  - name: http_request_rates
    interval: 1m
    rules:
      # Layer 1: Per-instance rate
      - record: instance:http_requests_total:rate5m
        expr: |
          rate(http_requests_total[5m])

      # Layer 2: Aggregate to job level
      - record: job:http_requests_total:rate5m
        expr: |
          sum without(instance, pod) (instance:http_requests_total:rate5m)

      # Layer 3: Cluster-wide total
      - record: cluster:http_requests_total:rate5m
        expr: |
          sum without(job, namespace) (job:http_requests_total:rate5m)
```

### Recording Rules for SLI/SLO Tracking

Service Level Indicators (SLIs) are the most important metrics to pre-compute. SLO calculations typically involve ratio queries over long windows, which are especially expensive.

```yaml
groups:
  - name: sli_recording_rules
    interval: 30s
    rules:
      # HTTP availability SLI - successful requests
      - record: job:http_requests_success:rate5m
        expr: |
          sum(rate(http_requests_total{code!~"5.."}[5m])) by (job, service)

      # HTTP availability SLI - total requests
      - record: job:http_requests_total:rate5m
        expr: |
          sum(rate(http_requests_total[5m])) by (job, service)

      # Availability ratio
      - record: job:http_availability:ratio_rate5m
        expr: |
          job:http_requests_success:rate5m
          /
          job:http_requests_total:rate5m

      # Latency SLI - requests completing within 500ms
      - record: job:http_request_duration_under_500ms:rate5m
        expr: |
          sum(rate(http_request_duration_seconds_bucket{le="0.5"}[5m])) by (job, service)

      # Latency ratio
      - record: job:http_latency_sli:ratio_rate5m
        expr: |
          job:http_request_duration_under_500ms:rate5m
          /
          job:http_requests_total:rate5m
```

## Alerting Rule Design

### The Four Golden Signals

Production alerting rules should map to the four golden signals: latency, traffic, errors, and saturation. Alerts at this level are high-signal and low-noise compared to infrastructure-level alerts.

```yaml
groups:
  - name: golden_signals
    rules:
      # Error rate alert
      - alert: HighErrorRate
        expr: |
          (
            sum(rate(http_requests_total{code=~"5.."}[5m])) by (job, service)
            /
            sum(rate(http_requests_total[5m])) by (job, service)
          ) > 0.05
        for: 5m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "High error rate on {{ $labels.service }}"
          description: |
            Service {{ $labels.service }} in job {{ $labels.job }} is returning
            {{ $value | humanizePercentage }} errors over the last 5 minutes.
          runbook_url: "https://runbooks.example.com/high-error-rate"
          dashboard_url: "https://grafana.example.com/d/abc123/service-overview?var-service={{ $labels.service }}"

      # Latency P99 alert
      - alert: HighLatencyP99
        expr: |
          histogram_quantile(
            0.99,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (job, service, le)
          ) > 2.0
        for: 10m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "High P99 latency on {{ $labels.service }}"
          description: |
            Service {{ $labels.service }} P99 latency is {{ $value | humanizeDuration }}
            which exceeds the 2 second threshold.
          runbook_url: "https://runbooks.example.com/high-latency"

      # Saturation alert
      - alert: HighMemorySaturation
        expr: |
          (
            sum(container_memory_working_set_bytes{container!=""}) by (namespace, pod)
            /
            sum(container_spec_memory_limit_bytes{container!=""}) by (namespace, pod)
          ) > 0.85
        for: 15m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Pod {{ $labels.pod }} memory saturation at {{ $value | humanizePercentage }}"
          description: |
            Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} has been using
            more than 85% of its memory limit for 15 minutes.
```

### Multi-Window Multi-Burn-Rate Alerting

Single-window burn-rate alerts are fragile. The recommended pattern from the SRE workbook uses multiple time windows to detect both fast burns (imminent SLO breach) and slow burns (gradual degradation).

```yaml
groups:
  - name: slo_alerts
    rules:
      # Fast burn: 2% budget consumed in 1 hour (14.4x burn rate)
      - alert: SLOBudgetFastBurn
        expr: |
          (
            job:http_availability:ratio_rate5m{job="api-service"} < (1 - 14.4 * (1 - 0.999))
          )
          and
          (
            job:http_availability:ratio_rate1h{job="api-service"} < (1 - 14.4 * (1 - 0.999))
          )
        for: 2m
        labels:
          severity: critical
          slo: availability
          team: platform
        annotations:
          summary: "Fast SLO budget burn on api-service"
          description: |
            API service is burning error budget at {{ $value | humanizePercentage }} availability.
            At this rate, the monthly budget will be exhausted in approximately 1 hour.

      # Slow burn: 5% budget consumed in 6 hours (1x burn rate over longer window)
      - alert: SLOBudgetSlowBurn
        expr: |
          (
            job:http_availability:ratio_rate6h{job="api-service"} < (1 - 1 * (1 - 0.999))
          )
          and
          (
            job:http_availability:ratio_rate24h{job="api-service"} < (1 - 1 * (1 - 0.999))
          )
        for: 15m
        labels:
          severity: warning
          slo: availability
          team: platform
        annotations:
          summary: "Slow SLO budget burn on api-service"
          description: |
            API service availability over 6h/24h windows indicates gradual SLO degradation.
```

To support multi-window alerting, the corresponding recording rules must cover all required windows:

```yaml
groups:
  - name: slo_recording_rules
    interval: 30s
    rules:
      - record: job:http_availability:ratio_rate5m
        expr: |
          sum(rate(http_requests_total{code!~"5.."}[5m])) by (job)
          /
          sum(rate(http_requests_total[5m])) by (job)

      - record: job:http_availability:ratio_rate1h
        expr: |
          sum(rate(http_requests_total{code!~"5.."}[1h])) by (job)
          /
          sum(rate(http_requests_total[1h])) by (job)

      - record: job:http_availability:ratio_rate6h
        expr: |
          sum(rate(http_requests_total{code!~"5.."}[6h])) by (job)
          /
          sum(rate(http_requests_total[6h])) by (job)

      - record: job:http_availability:ratio_rate24h
        expr: |
          sum(rate(http_requests_total{code!~"5.."}[24h])) by (job)
          /
          sum(rate(http_requests_total[24h])) by (job)
```

## Alert Annotations and Labels

### Label Design for Routing

Alert labels drive routing decisions in Alertmanager. They must be consistent, predictable, and populated from the time series being evaluated.

Required labels for every alert:

```yaml
labels:
  severity: critical | warning | info
  team: platform | backend | frontend | data | security
  environment: production | staging | development
  tier: application | infrastructure | data
```

Annotations carry human-readable context:

```yaml
annotations:
  summary: "Single-line summary with {{ $labels.service }}"
  description: |
    Multi-line description with current value {{ $value | humanize }},
    threshold context, and impact assessment.
  runbook_url: "https://runbooks.example.com/alert-name"
  dashboard_url: "https://grafana.example.com/d/..."
```

### Template Functions

Prometheus supports Go template functions in annotations. Effective use of these functions produces more informative alerts:

```yaml
annotations:
  summary: "{{ $labels.job }} error rate {{ $value | humanizePercentage }}"
  description: |
    Current value: {{ $value | humanize }}
    Threshold: 0.05 (5%)
    Duration over threshold: exceeded for-duration
    Affected instances: {{ range query "up{job='$labels.job'}" }}{{ .Labels.instance }} {{ end }}
```

## Alertmanager Configuration

### Multi-Tier Routing

Enterprise Alertmanager configurations typically route alerts through multiple tiers based on severity, team, and time of day.

```yaml
global:
  resolve_timeout: 5m
  smtp_from: "alertmanager@example.com"
  smtp_smarthost: "smtp.example.com:587"
  smtp_require_tls: true

route:
  group_by: ["alertname", "team", "environment"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: default-receiver

  routes:
    # Critical alerts page on-call immediately
    - match:
        severity: critical
      receiver: pagerduty-critical
      continue: false
      routes:
        # Security team gets security alerts first
        - match:
            team: security
          receiver: security-pagerduty
          continue: false

    # Warning alerts go to Slack with longer repeat
    - match:
        severity: warning
      receiver: slack-warnings
      repeat_interval: 8h
      routes:
        - match:
            team: platform
          receiver: slack-platform-warnings
        - match:
            team: backend
          receiver: slack-backend-warnings

    # Info alerts only go to monitoring channel
    - match:
        severity: info
      receiver: slack-info
      repeat_interval: 24h

    # Infrastructure alerts during business hours go to email
    - match_re:
        tier: infrastructure
      active_time_intervals:
        - business-hours
      receiver: email-infra
      continue: true

receivers:
  - name: default-receiver
    slack_configs:
      - api_url: "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"
        channel: "#alerts-default"
        title: "{{ .GroupLabels.alertname }}"
        text: "{{ range .Alerts }}{{ .Annotations.description }}{{ end }}"

  - name: pagerduty-critical
    pagerduty_configs:
      - routing_key: "<pagerduty-routing-key>"
        description: "{{ .GroupLabels.alertname }}: {{ .CommonAnnotations.summary }}"
        severity: "critical"
        details:
          team: "{{ .GroupLabels.team }}"
          environment: "{{ .GroupLabels.environment }}"
          runbook: "{{ .CommonAnnotations.runbook_url }}"

  - name: slack-platform-warnings
    slack_configs:
      - api_url: "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"
        channel: "#platform-alerts"
        color: "warning"
        title: "[WARNING] {{ .GroupLabels.alertname }}"
        text: |
          *Summary:* {{ .CommonAnnotations.summary }}
          *Runbook:* {{ .CommonAnnotations.runbook_url }}
          {{ range .Alerts }}
          *Alert:* {{ .Labels.alertname }} on {{ .Labels.service }}
          {{ end }}
        actions:
          - type: button
            text: "View Runbook"
            url: "{{ (index .Alerts 0).Annotations.runbook_url }}"
          - type: button
            text: "View Dashboard"
            url: "{{ (index .Alerts 0).Annotations.dashboard_url }}"

  - name: email-infra
    email_configs:
      - to: "infrastructure@example.com"
        headers:
          Subject: "[{{ .GroupLabels.environment | toUpper }}] {{ .GroupLabels.alertname }}"
        html: |
          <h2>{{ .GroupLabels.alertname }}</h2>
          {{ range .Alerts }}
          <p><strong>Summary:</strong> {{ .Annotations.summary }}</p>
          <p><strong>Description:</strong> {{ .Annotations.description }}</p>
          <p><a href="{{ .Annotations.runbook_url }}">View Runbook</a></p>
          {{ end }}

time_intervals:
  - name: business-hours
    time_intervals:
      - weekdays: ["monday:friday"]
        times:
          - start_time: "08:00"
            end_time: "18:00"
        location: "America/New_York"
```

### Inhibition Rules

Inhibition rules prevent redundant alert noise when a root cause fires. If the entire cluster is unhealthy, per-service alerts should be suppressed.

```yaml
inhibit_rules:
  # Suppress pod-level alerts when a node is down
  - source_match:
      alertname: NodeNotReady
    target_match_re:
      alertname: "PodCrashLooping|ContainerOOMKilled|PodNotReady"
    equal:
      - node

  # Suppress service alerts when deployment is being updated
  - source_match:
      alertname: DeploymentProgressing
    target_match_re:
      alertname: "HighErrorRate|PodRestartingTooOften"
    equal:
      - namespace
      - deployment

  # Suppress warning when critical is firing for same alert
  - source_match:
      severity: critical
    target_match:
      severity: warning
    equal:
      - alertname
      - team
      - environment

  # Suppress infrastructure alerts when cluster-level alert is firing
  - source_match:
      alertname: ClusterNotHealthy
    target_match_re:
      tier: infrastructure
    equal:
      - cluster
```

## Rule File Organization at Scale

### Directory Structure

Large deployments with dozens of teams and hundreds of services require a structured approach to rule file organization.

```
rules/
├── global/
│   ├── recording_rules.yaml        # Cluster-wide recording rules
│   ├── slo_recording_rules.yaml    # SLO tracking recording rules
│   └── node_recording_rules.yaml   # Node-level aggregations
├── infrastructure/
│   ├── kubernetes_alerts.yaml      # Kubernetes system alerts
│   ├── etcd_alerts.yaml            # etcd health alerts
│   └── node_alerts.yaml            # Node health alerts
├── platform/
│   ├── ingress_alerts.yaml         # Ingress controller alerts
│   ├── cert_manager_alerts.yaml    # Certificate expiry alerts
│   └── platform_recording.yaml    # Platform recording rules
├── applications/
│   ├── api_service_alerts.yaml     # API service alerts
│   ├── worker_alerts.yaml          # Background worker alerts
│   └── database_alerts.yaml        # Database alerts
└── slos/
    ├── api_service_slo.yaml        # API service SLO alerts
    └── payment_service_slo.yaml    # Payment service SLO alerts
```

### Prometheus Configuration for Multiple Rule Files

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: production-us-east-1
    environment: production

rule_files:
  - "/etc/prometheus/rules/global/*.yaml"
  - "/etc/prometheus/rules/infrastructure/*.yaml"
  - "/etc/prometheus/rules/platform/*.yaml"
  - "/etc/prometheus/rules/applications/*.yaml"
  - "/etc/prometheus/rules/slos/*.yaml"
```

### Rule Validation Pipeline

Rule files should pass through automated validation in CI/CD before deployment.

```bash
#!/bin/bash
# validate-rules.sh

set -euo pipefail

RULES_DIR="${1:-rules/}"
PROMTOOL_BIN="${PROMTOOL_BIN:-promtool}"

echo "Validating Prometheus rule files in ${RULES_DIR}"

# Find all YAML files
find "${RULES_DIR}" -name "*.yaml" -o -name "*.yml" | while read -r rule_file; do
  echo "Checking: ${rule_file}"

  # Validate rule file syntax
  if ! "${PROMTOOL_BIN}" check rules "${rule_file}"; then
    echo "ERROR: Validation failed for ${rule_file}"
    exit 1
  fi
done

echo "All rule files validated successfully"

# Test rules if unit test files exist
find "${RULES_DIR}" -name "*_test.yaml" | while read -r test_file; do
  echo "Running tests in: ${test_file}"
  "${PROMTOOL_BIN}" test rules "${test_file}"
done
```

## Unit Testing Recording and Alerting Rules

Prometheus includes a built-in unit testing framework via `promtool test rules`. Tests allow validation of rule expressions against synthetic time series data.

```yaml
# rules/slo_recording_rules_test.yaml
rule_files:
  - recording_rules.yaml
  - slo_recording_rules.yaml

evaluation_interval: 1m

tests:
  - interval: 1m
    input_series:
      # Simulate 95% availability (5% error rate)
      - series: 'http_requests_total{job="api-service", code="200"}'
        values: "0 100 200 300 400 500"
      - series: 'http_requests_total{job="api-service", code="500"}'
        values: "0 5 10 15 20 25"

    alert_rule_test:
      - eval_time: 10m
        alertname: HighErrorRate
        exp_alerts:
          - exp_labels:
              severity: critical
              job: api-service
            exp_annotations:
              summary: "High error rate on api-service"

    promql_expr_test:
      - eval_time: 5m
        expr: job:http_availability:ratio_rate5m{job="api-service"}
        exp_samples:
          - labels: '{job="api-service"}'
            value: 0.952380952  # 100/(100+5) = 0.952...
```

## Performance Tuning Recording Rules

### Evaluation Interval Selection

Recording rules have their own evaluation interval that can differ from the global setting. Choose intervals based on the downstream consumers:

```yaml
groups:
  # High-frequency rules for real-time dashboards
  - name: realtime_recording
    interval: 15s
    rules:
      - record: job:http_requests_total:rate1m
        expr: sum(rate(http_requests_total[1m])) by (job)

  # Medium-frequency rules for alerting
  - name: alerting_recording
    interval: 1m
    rules:
      - record: job:http_availability:ratio_rate5m
        expr: |
          sum(rate(http_requests_total{code!~"5.."}[5m])) by (job)
          /
          sum(rate(http_requests_total[5m])) by (job)

  # Low-frequency rules for capacity planning
  - name: capacity_recording
    interval: 5m
    rules:
      - record: cluster:node_cpu:utilization_avg24h
        expr: |
          avg_over_time(
            (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) by (instance))[24h:5m]
          ) by (instance)
```

### Avoiding Staleness Issues

Recording rules that reference long windows can produce stale data if the source metric is missing. Add `or` clauses with fallback values for critical metrics:

```yaml
- record: job:http_availability:ratio_rate5m
  expr: |
    (
      sum(rate(http_requests_total{code!~"5.."}[5m])) by (job)
      /
      sum(rate(http_requests_total[5m])) by (job)
    )
    or
    (
      # If metric is missing entirely, assume 0 availability
      absent(http_requests_total) * 0
    )
```

## Kubernetes Deployment of Rule Files

### ConfigMap-Based Rule Distribution

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-rules-global
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
data:
  recording-rules.yaml: |
    groups:
      - name: global_recording_rules
        interval: 1m
        rules:
          - record: job:http_requests_total:rate5m
            expr: |
              sum(rate(http_requests_total[5m])) by (job, service)

          - record: job:http_availability:ratio_rate5m
            expr: |
              sum(rate(http_requests_total{code!~"5.."}[5m])) by (job, service)
              /
              sum(rate(http_requests_total[5m])) by (job, service)
```

### PrometheusRule CRD (Prometheus Operator)

When using the Prometheus Operator, rules are defined as PrometheusRule custom resources and automatically loaded without configuration reloads:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-service-slo-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
    app: api-service
spec:
  groups:
    - name: api_service_recording_rules
      interval: 30s
      rules:
        - record: job:http_availability:ratio_rate5m
          expr: |
            sum(rate(http_requests_total{code!~"5.."}[5m])) by (job)
            /
            sum(rate(http_requests_total[5m])) by (job)
          labels:
            service: api-service

    - name: api_service_slo_alerts
      rules:
        - alert: APIServiceAvailabilitySLOBreach
          expr: |
            job:http_availability:ratio_rate5m{job="api-service"} < 0.999
          for: 5m
          labels:
            severity: critical
            team: platform
            slo: api-service-availability
          annotations:
            summary: "API service availability SLO breach"
            description: |
              API service availability is {{ $value | humanizePercentage }},
              below the 99.9% SLO target.
            runbook_url: "https://runbooks.example.com/api-service-slo"
```

## Silences and Maintenance Windows

### Planned Maintenance Silences

During maintenance windows, Alertmanager silences prevent alert fatigue. Automate silence creation and removal using the Alertmanager API:

```bash
#!/bin/bash
# create-maintenance-silence.sh

ALERTMANAGER_URL="${1:-http://alertmanager:9093}"
DURATION="${2:-2h}"
COMMENT="${3:-Planned maintenance window}"
CREATED_BY="${4:-automation}"

# Create silence for all alerts in the production namespace during maintenance
curl -s -X POST \
  "${ALERTMANAGER_URL}/api/v2/silences" \
  -H "Content-Type: application/json" \
  -d "{
    \"matchers\": [
      {
        \"name\": \"environment\",
        \"value\": \"production\",
        \"isRegex\": false
      },
      {
        \"name\": \"alertname\",
        \"value\": \"NodeNotReady|NodeMemoryPressure|DiskSpaceLow\",
        \"isRegex\": true
      }
    ],
    \"startsAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"endsAt\": \"$(date -u -d \"+${DURATION}\" +%Y-%m-%dT%H:%M:%SZ)\",
    \"comment\": \"${COMMENT}\",
    \"createdBy\": \"${CREATED_BY}\"
  }" | jq .
```

## Monitoring the Monitoring System

Meta-monitoring ensures Prometheus itself is healthy. These rules monitor the rule evaluation pipeline:

```yaml
groups:
  - name: prometheus_self_monitoring
    rules:
      - alert: PrometheusRuleEvaluationSlow
        expr: |
          prometheus_rule_group_last_duration_seconds
          >
          prometheus_rule_group_interval_seconds * 0.9
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Prometheus rule group {{ $labels.rule_group }} evaluation is slow"
          description: |
            Rule group {{ $labels.rule_group }} evaluation takes
            {{ $value | humanizeDuration }}, which is close to the group interval.
            Consider splitting the group or optimizing queries.

      - alert: PrometheusRuleEvaluationFailures
        expr: |
          increase(prometheus_rule_evaluation_failures_total[5m]) > 0
        for: 1m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Prometheus rule evaluation failures detected"
          description: |
            {{ $value }} rule evaluation failures in the last 5 minutes.
            Check Prometheus logs for expression errors.

      - alert: AlertmanagerNotificationsFailing
        expr: |
          rate(alertmanager_notifications_failed_total[5m]) > 0
        for: 5m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Alertmanager notifications failing to {{ $labels.integration }}"
          description: |
            Alertmanager is failing to send notifications to {{ $labels.integration }}.
            Check Alertmanager configuration and integration credentials.
```

## Summary

Production Prometheus deployments require careful attention to recording rule design, alert quality, and Alertmanager configuration. The key principles are:

- Use layered recording rules following the `level:metric:operations` naming convention
- Build multi-window burn-rate alerts for SLO-based alerting that catches both fast and slow burns
- Design Alertmanager routing hierarchies that balance noise reduction with coverage
- Use inhibition rules to prevent alert storms during cascading failures
- Organize rule files by team and service for maintainability at scale
- Validate and test all rules in CI/CD before deployment
- Monitor the monitoring system itself to detect evaluation pipeline failures

These patterns, implemented consistently across all services and teams, produce an observability platform that scales from dozens to thousands of services without sacrificing signal quality or creating alert fatigue.
