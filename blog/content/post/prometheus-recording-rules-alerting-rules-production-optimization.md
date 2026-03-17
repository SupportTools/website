---
title: "Prometheus Recording Rules and Alerting Rules: Production Optimization"
date: 2029-03-30T00:00:00-05:00
draft: false
tags: ["Prometheus", "Alertmanager", "Monitoring", "Observability", "Kubernetes", "SRE"]
categories: ["Monitoring", "Observability", "SRE"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Prometheus recording rules for pre-computing expensive queries, alerting rule design, inhibition, silences, and Alertmanager routing trees for production environments."
more_link: "yes"
url: "/prometheus-recording-rules-alerting-rules-production-optimization/"
---

Prometheus is the de-facto standard for metrics collection in cloud-native environments, but running it at scale without careful query optimization leads to painful query timeouts, OOM kills, and alert storms during incidents. Recording rules transform expensive PromQL queries into pre-computed time series, while well-structured alerting rules with properly configured Alertmanager routing trees keep on-call engineers sane. This guide covers the full spectrum from recording rule design to production-hardened Alertmanager configuration.

<!--more-->

# Prometheus Recording Rules and Alerting Rules: Production Optimization

## Section 1: Why Recording Rules Are Non-Negotiable at Scale

When you start with Prometheus, ad-hoc PromQL queries work fine. Query latency is negligible at a few hundred metrics. The first sign of trouble appears around 50,000 active time series: dashboard panels begin timing out, and your `rate()` calculations across large label cardinalities start consuming meaningful CPU.

Recording rules solve this by executing PromQL at scrape intervals and storing the result as a new time series. Dashboards query the pre-computed series instead of re-aggregating millions of raw samples on every panel load.

The operational benefits extend beyond dashboard performance:

- **Reduced storage**: Pre-aggregated metrics compress better and have lower cardinality
- **Alert consistency**: Alerts evaluate against stable, pre-computed values rather than live queries subject to scrape timing
- **Federation-friendly**: Lower-cardinality recording rule outputs are far more efficient to federate to a central Prometheus

### When to Create a Recording Rule

Apply the following heuristics:

1. Any `rate()` or `irate()` expression used in more than one dashboard panel
2. Any aggregation that groups away high-cardinality labels (`pod`, `instance`, `container`)
3. Any query used in alerting rules that takes more than 200ms to evaluate
4. Any ratio or percentage expression used for SLO tracking

```promql
# Bad: Re-computed on every dashboard load, every 15 seconds per user
sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
/
sum(rate(http_requests_total[5m])) by (service)

# Good: Evaluated once per interval, stored as a recording rule
job:http_error_ratio:rate5m
```

## Section 2: Recording Rule Naming Conventions

Prometheus documentation recommends a three-part naming convention:

```
level:metric:operations
```

- **level**: The aggregation level (job, instance, cluster, namespace, service)
- **metric**: The base metric name without `_total` or `_seconds` suffixes
- **operations**: The PromQL functions applied, joined with `_`

### Practical Examples

```yaml
groups:
  - name: http_recording_rules
    interval: 30s
    rules:
      # Request rate per job, 5-minute window
      - record: job:http_requests:rate5m
        expr: sum(rate(http_requests_total[5m])) by (job)

      # Error rate per job, 5-minute window
      - record: job:http_errors:rate5m
        expr: sum(rate(http_requests_total{status=~"5.."}[5m])) by (job)

      # Error ratio derived from the two recording rules above
      - record: job:http_error_ratio:rate5m
        expr: |
          job:http_errors:rate5m
          /
          job:http_requests:rate5m

      # Latency percentiles pre-computed for dashboards
      - record: job:http_request_duration_seconds:p99_rate5m
        expr: |
          histogram_quantile(
            0.99,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (job, le)
          )

      - record: job:http_request_duration_seconds:p95_rate5m
        expr: |
          histogram_quantile(
            0.95,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (job, le)
          )
```

### Multi-Level Recording Rules

For large clusters, create recording rules at multiple aggregation levels to enable efficient drill-down:

```yaml
groups:
  - name: node_recording_rules
    interval: 60s
    rules:
      # Instance level: keep pod and node labels
      - record: instance:node_cpu_utilization:rate5m
        expr: |
          1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) by (instance)

      # Cluster level: aggregate away instance
      - record: cluster:node_cpu_utilization:avg_rate5m
        expr: avg(instance:node_cpu_utilization:rate5m)

      # Namespace level: memory usage
      - record: namespace:container_memory_rss:sum
        expr: |
          sum(container_memory_rss{container!=""}) by (namespace)

      # Cluster level: total memory usage
      - record: cluster:container_memory_rss:sum
        expr: sum(namespace:container_memory_rss:sum)
```

## Section 3: Recording Rule Groups and Evaluation Intervals

Each rule group has an independent evaluation interval. Mis-configuring this is a common source of subtle bugs.

```yaml
groups:
  # Fast-moving operational metrics - evaluate frequently
  - name: slo_fast
    interval: 15s
    rules:
      - record: job:http_availability:rate1m
        expr: |
          sum(rate(http_requests_total{status!~"5.."}[1m])) by (job)
          /
          sum(rate(http_requests_total[1m])) by (job)

  # Slower capacity metrics - less frequent evaluation is fine
  - name: capacity_planning
    interval: 5m
    rules:
      - record: namespace:pod_count:count
        expr: count(kube_pod_info) by (namespace)

      - record: cluster:node_capacity_cpu:sum
        expr: sum(kube_node_status_capacity{resource="cpu"})
```

### Important: Staleness and Lookback Windows

When a recording rule feeds into an alerting rule, ensure the alerting rule's `for` duration and the recording rule's evaluation interval are compatible:

```yaml
groups:
  - name: slo_alerts
    rules:
      - alert: HighErrorRate
        # This queries a recording rule updated every 15s
        # Using 5m for stability - won't false-fire on transient spikes
        expr: job:http_error_ratio:rate5m > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate for {{ $labels.job }}"
          description: "Error ratio is {{ $value | humanizePercentage }}"
```

## Section 4: Alerting Rule Design Principles

### Symptom-Based Alerting

Alert on user-visible symptoms, not internal causes. The canonical SRE guidance is to page on symptoms and investigate causes with dashboards.

```yaml
groups:
  - name: symptom_alerts
    rules:
      # GOOD: Alerts on user-facing error rate
      - alert: ServiceHighErrorRate
        expr: job:http_error_ratio:rate5m > 0.05
        for: 5m
        labels:
          severity: page
          team: platform
        annotations:
          runbook_url: "https://wiki.example.com/runbooks/high-error-rate"
          summary: "Service {{ $labels.job }} error rate above 5%"
          description: |
            Service {{ $labels.job }} has a {{ $value | humanizePercentage }} error rate
            over the last 5 minutes. Threshold is 5%.

      # BAD: Alerts on an internal implementation detail
      # - alert: DatabaseConnectionPoolExhausted
      #   expr: db_pool_connections_active / db_pool_connections_max > 0.9

      # BETTER: Alert on the downstream impact
      - alert: DatabaseLatencyHigh
        expr: |
          histogram_quantile(0.95,
            sum(rate(db_query_duration_seconds_bucket[5m])) by (job, le)
          ) > 1.0
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Database p95 latency above 1s for {{ $labels.job }}"
```

### Multi-Window Multi-Burn-Rate Alerts for SLOs

This is the gold standard for SLO-based alerting from the Google SRE Workbook:

```yaml
groups:
  - name: slo_burn_rate_alerts
    rules:
      # Fast burn: 2% of monthly error budget in 1 hour
      # 14.4x burn rate for 30-day window
      - alert: SLOHighBurnRateFast
        expr: |
          (
            job:http_error_ratio:rate1h{job="api-service"} > (14.4 * 0.001)
          )
          and
          (
            job:http_error_ratio:rate5m{job="api-service"} > (14.4 * 0.001)
          )
        for: 1m
        labels:
          severity: page
          slo: availability
          window: fast
        annotations:
          summary: "SLO fast burn rate for {{ $labels.job }}"
          description: |
            The service is consuming error budget at 14.4x the sustainable rate.
            Current 1h error ratio: {{ $value | humanizePercentage }}

      # Slow burn: 5% of monthly error budget in 6 hours
      # 6x burn rate
      - alert: SLOHighBurnRateSlow
        expr: |
          (
            job:http_error_ratio:rate6h{job="api-service"} > (6 * 0.001)
          )
          and
          (
            job:http_error_ratio:rate30m{job="api-service"} > (6 * 0.001)
          )
        for: 1m
        labels:
          severity: warning
          slo: availability
          window: slow
        annotations:
          summary: "SLO slow burn rate for {{ $labels.job }}"
```

The corresponding recording rules for the multi-window approach:

```yaml
groups:
  - name: slo_recording_rules
    rules:
      - record: job:http_error_ratio:rate5m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) by (job)
          /
          sum(rate(http_requests_total[5m])) by (job)

      - record: job:http_error_ratio:rate30m
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[30m])) by (job)
          /
          sum(rate(http_requests_total[30m])) by (job)

      - record: job:http_error_ratio:rate1h
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[1h])) by (job)
          /
          sum(rate(http_requests_total[1h])) by (job)

      - record: job:http_error_ratio:rate6h
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[6h])) by (job)
          /
          sum(rate(http_requests_total[6h])) by (job)
```

## Section 5: Alert Labels and Routing

Labels on alerts are the primary mechanism for Alertmanager routing. Design your label taxonomy before writing alerting rules.

### Recommended Label Schema

```yaml
# Standard labels all alerts should carry
labels:
  severity: page | warning | info
  team: platform | backend | frontend | data | security
  component: api | database | cache | queue | ingress
  environment: production | staging | development

# Optional labels for fine-grained routing
labels:
  oncall_escalation: primary | secondary | manager
  customer_impact: high | medium | low
  slo_impacting: "true" | "false"
```

### Alert Annotations Best Practices

```yaml
annotations:
  # Short one-line summary for notification title
  summary: "{{ $labels.job }} error rate above threshold"

  # Full description with context and current values
  description: |
    Service {{ $labels.job }} in namespace {{ $labels.namespace }} has:
    - Error rate: {{ $value | humanizePercentage }}
    - Threshold: 1%
    - Duration: firing for {{ $for }}

  # Direct links - these become clickable in notification systems
  runbook_url: "https://wiki.example.com/runbooks/{{ $labels.alertname | toLower }}"
  dashboard_url: "https://grafana.example.com/d/abc123?var-job={{ $labels.job }}"

  # Triage hints reduce mean time to resolve
  triage: |
    1. Check recent deployments: kubectl rollout history deployment/{{ $labels.job }}
    2. View error logs: https://grafana.example.com/explore?...
    3. Check downstream dependencies
```

## Section 6: Alertmanager Configuration Deep Dive

### Routing Tree Architecture

The Alertmanager routing tree is evaluated top-to-bottom. Each alert follows the first matching route unless `continue: true` is set.

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m
  # SMTP configuration
  smtp_smarthost: "smtp.example.com:587"
  smtp_from: "alerts@example.com"
  smtp_auth_username: "alerts@example.com"
  smtp_auth_password_file: /etc/alertmanager/smtp-password

route:
  # Default receiver for unmatched alerts
  receiver: default-receiver
  group_by: [alertname, cluster, namespace]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

  routes:
    # Critical production alerts go to PagerDuty immediately
    - match:
        severity: page
        environment: production
      receiver: pagerduty-critical
      group_wait: 10s
      group_interval: 1m
      repeat_interval: 1h
      continue: false

    # SLO burn rate alerts get special routing
    - match_re:
        alertname: "SLOHighBurnRate.*"
      receiver: slo-pagerduty
      group_by: [alertname, job, slo]
      group_wait: 0s
      repeat_interval: 30m
      routes:
        # Fast burn always pages
        - match:
            window: fast
          receiver: pagerduty-critical
        # Slow burn goes to Slack
        - match:
            window: slow
          receiver: slack-warnings

    # Team-specific routing
    - match:
        team: data
      receiver: data-team-slack
      routes:
        - match:
            severity: page
          receiver: data-team-pagerduty

    - match:
        team: platform
      receiver: platform-team-slack
      routes:
        - match:
            severity: page
          receiver: platform-team-pagerduty

    # Security alerts always get email + Slack regardless of severity
    - match:
        team: security
      receiver: security-multi-channel
      continue: true

    # Warnings go to Slack only
    - match:
        severity: warning
      receiver: slack-warnings
      group_wait: 1m
      group_interval: 10m
      repeat_interval: 12h

    # Info alerts go to a logging receiver, not paging
    - match:
        severity: info
      receiver: slack-info
      group_wait: 5m
      group_interval: 30m
      repeat_interval: 24h

receivers:
  - name: default-receiver
    slack_configs:
      - api_url: "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<TOKEN>"
        channel: "#alerts-default"
        title: "{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}"
        text: "{{ range .Alerts }}{{ .Annotations.description }}\n{{ end }}"

  - name: pagerduty-critical
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/pagerduty-key
        severity: critical
        description: "{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}"
        details:
          firing: "{{ .Alerts.Firing | len }}"
          runbook: "{{ (index .Alerts 0).Annotations.runbook_url }}"

  - name: slack-warnings
    slack_configs:
      - api_url_file: /etc/alertmanager/slack-webhook-warnings
        channel: "#alerts-warnings"
        send_resolved: true
        title: |-
          [{{ .Status | toUpper }}{{ if eq .Status "firing" }}:{{ .Alerts.Firing | len }}{{ end }}] {{ .CommonLabels.alertname }}
        text: >-
          {{ range .Alerts }}
          *Alert:* {{ .Annotations.summary }}
          *Description:* {{ .Annotations.description }}
          *Severity:* {{ .Labels.severity }}
          *Runbook:* {{ .Annotations.runbook_url }}
          {{ end }}

  - name: slack-info
    slack_configs:
      - api_url_file: /etc/alertmanager/slack-webhook-info
        channel: "#alerts-info"
        send_resolved: false

  - name: security-multi-channel
    slack_configs:
      - api_url_file: /etc/alertmanager/slack-webhook-security
        channel: "#security-alerts"
    email_configs:
      - to: "security-team@example.com"
        send_resolved: true
```

## Section 7: Inhibition Rules

Inhibition prevents alert noise during cascading failures. When a high-severity alert is firing, inhibit related lower-severity alerts that are downstream effects.

```yaml
inhibit_rules:
  # If a node is down, inhibit pod-level alerts on that node
  - source_match:
      alertname: NodeDown
    target_match_re:
      alertname: "Pod.*"
    equal:
      - node

  # If the entire cluster is unavailable, inhibit service-level alerts
  - source_match:
      alertname: KubernetesAPIServerUnreachable
    target_match:
      severity: warning

  # If a severity:page alert is firing for a service,
  # inhibit severity:warning alerts for the same service
  - source_match:
      severity: page
    target_match:
      severity: warning
    equal:
      - job
      - namespace

  # If database is down, inhibit application-level DB errors
  - source_match:
      alertname: PostgreSQLDown
    target_match_re:
      alertname: ".*DatabaseConnection.*"
    equal:
      - namespace

  # Maintenance window inhibition - set a label on a "maintenance" alert
  # to suppress all others in a namespace
  - source_match:
      alertname: MaintenanceWindow
    target_match_re:
      alertname: ".*"
    equal:
      - namespace
```

### Dynamic Inhibition with Labels

```yaml
# Firing this alert will inhibit all others in the same cluster
groups:
  - name: maintenance
    rules:
      - alert: MaintenanceWindow
        expr: kube_configmap_info{configmap="maintenance-mode", namespace="kube-system"} == 1
        labels:
          severity: info
          inhibit_all: "true"
        annotations:
          summary: "Maintenance window active for cluster {{ $labels.cluster }}"
```

## Section 8: Silences via API

Alertmanager silences are the right tool for planned maintenance. Avoid using them to hide legitimate production problems.

```bash
# Create a silence via Alertmanager API
# Silence all alerts for a specific job during deployment
curl -X POST http://alertmanager:9093/api/v2/silences \
  -H "Content-Type: application/json" \
  -d '{
    "matchers": [
      {
        "name": "job",
        "value": "api-service",
        "isRegex": false,
        "isEqual": true
      },
      {
        "name": "severity",
        "value": "warning",
        "isRegex": false,
        "isEqual": true
      }
    ],
    "startsAt": "2029-03-30T10:00:00Z",
    "endsAt": "2029-03-30T11:00:00Z",
    "createdBy": "deployment-bot",
    "comment": "Planned deployment of api-service v2.5.0"
  }'

# List active silences
curl http://alertmanager:9093/api/v2/silences | jq '.[] | select(.status.state == "active")'

# Delete a silence by ID
curl -X DELETE http://alertmanager:9093/api/v2/silences/{silence-id}
```

### Automating Silences in CI/CD

```python
#!/usr/bin/env python3
"""
deployment_silence.py - Create Alertmanager silence during deployments
"""
import requests
import json
from datetime import datetime, timedelta, timezone
import sys

ALERTMANAGER_URL = "http://alertmanager.monitoring.svc.cluster.local:9093"

def create_deployment_silence(job_name: str, duration_minutes: int = 15,
                               deployer: str = "ci-bot") -> str:
    now = datetime.now(timezone.utc)
    end = now + timedelta(minutes=duration_minutes)

    silence = {
        "matchers": [
            {
                "name": "job",
                "value": job_name,
                "isRegex": False,
                "isEqual": True
            }
        ],
        "startsAt": now.isoformat(),
        "endsAt": end.isoformat(),
        "createdBy": deployer,
        "comment": f"Deployment silence for {job_name} - {duration_minutes}min"
    }

    resp = requests.post(
        f"{ALERTMANAGER_URL}/api/v2/silences",
        headers={"Content-Type": "application/json"},
        data=json.dumps(silence)
    )
    resp.raise_for_status()
    silence_id = resp.json()["silenceID"]
    print(f"Created silence {silence_id} for {job_name} until {end.isoformat()}")
    return silence_id


def expire_silence(silence_id: str) -> None:
    resp = requests.delete(f"{ALERTMANAGER_URL}/api/v2/silences/{silence_id}")
    resp.raise_for_status()
    print(f"Expired silence {silence_id}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: deployment_silence.py <job-name> [duration-minutes]")
        sys.exit(1)

    job = sys.argv[1]
    duration = int(sys.argv[2]) if len(sys.argv) > 2 else 15
    silence_id = create_deployment_silence(job, duration)
    print(f"SILENCE_ID={silence_id}")
```

## Section 9: Recording Rules for Kubernetes Workloads

A production-ready set of recording rules for Kubernetes cluster monitoring:

```yaml
groups:
  - name: kubernetes_workload_recording
    interval: 30s
    rules:
      # CPU usage rate per namespace
      - record: namespace:container_cpu_usage_seconds:rate5m
        expr: |
          sum(
            rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m])
          ) by (namespace)

      # Memory usage per namespace
      - record: namespace:container_memory_working_set:sum
        expr: |
          sum(
            container_memory_working_set_bytes{container!="", container!="POD"}
          ) by (namespace)

      # CPU request utilization per namespace (usage / request)
      - record: namespace:container_cpu_request_utilization:ratio
        expr: |
          namespace:container_cpu_usage_seconds:rate5m
          /
          sum(
            kube_pod_container_resource_requests{resource="cpu", container!=""}
          ) by (namespace)

      # Memory request utilization per namespace
      - record: namespace:container_memory_request_utilization:ratio
        expr: |
          namespace:container_memory_working_set:sum
          /
          sum(
            kube_pod_container_resource_requests{resource="memory", container!=""}
          ) by (namespace)

      # Pod restart rate
      - record: namespace:kube_pod_container_status_restarts:rate1h
        expr: |
          sum(
            rate(kube_pod_container_status_restarts_total[1h])
          ) by (namespace, pod, container)

  - name: kubernetes_node_recording
    interval: 60s
    rules:
      # Node CPU utilization
      - record: node:node_cpu_utilization:avg_rate5m
        expr: |
          1 - avg(
            rate(node_cpu_seconds_total{mode="idle"}[5m])
          ) by (node)

      # Node memory utilization
      - record: node:node_memory_utilization:ratio
        expr: |
          1 - (
            node_memory_MemAvailable_bytes
            /
            node_memory_MemTotal_bytes
          )

      # Node disk utilization
      - record: node:node_filesystem_utilization:ratio
        expr: |
          1 - (
            node_filesystem_avail_bytes{fstype!~"tmpfs|fuse.lxcfs|squashfs"}
            /
            node_filesystem_size_bytes{fstype!~"tmpfs|fuse.lxcfs|squashfs"}
          )
```

## Section 10: Testing Recording and Alerting Rules

Use `promtool` to validate rules and test them with unit tests:

```yaml
# tests/recording_rules_test.yml
rule_files:
  - ../rules/http_recording_rules.yml
  - ../rules/http_alerting_rules.yml

evaluation_interval: 1m

tests:
  - interval: 1m
    input_series:
      # Simulate 100 req/s with 5% error rate
      - series: 'http_requests_total{job="api", status="200"}'
        values: "0+95x10"
      - series: 'http_requests_total{job="api", status="500"}'
        values: "0+5x10"

    alert_rule_test:
      - eval_time: 10m
        alertname: ServiceHighErrorRate
        exp_alerts:
          - exp_labels:
              severity: warning
              job: api
            exp_annotations:
              summary: "Service api error rate above 5%"

    promql_expr_test:
      - expr: job:http_error_ratio:rate5m{job="api"}
        eval_time: 5m
        exp_samples:
          - labels: '{job="api"}'
            value: 0.05
```

```bash
# Run rule tests
promtool test rules tests/recording_rules_test.yml

# Validate rule syntax
promtool check rules rules/*.yml

# Check Alertmanager configuration
amtool check-config alertmanager.yml

# Test routing for a specific alert
amtool config routes test \
  --config.file alertmanager.yml \
  severity=page team=platform

# Show the current routing tree
amtool config routes show --config.file alertmanager.yml
```

## Section 11: Production Deployment on Kubernetes

### PrometheusRule CRD with kube-prometheus-stack

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-service-rules
  namespace: monitoring
  labels:
    # These labels must match the Prometheus ruleSelector
    prometheus: kube-prometheus
    role: alert-rules
    app.kubernetes.io/name: api-service
spec:
  groups:
    - name: api_service_recording
      interval: 30s
      rules:
        - record: job:http_error_ratio:rate5m
          expr: |
            sum(rate(http_requests_total{status=~"5.."}[5m])) by (job)
            /
            sum(rate(http_requests_total[5m])) by (job)

    - name: api_service_alerts
      rules:
        - alert: APIServiceHighErrorRate
          expr: job:http_error_ratio:rate5m{job="api-service"} > 0.01
          for: 5m
          labels:
            severity: page
            team: backend
          annotations:
            summary: "API service error rate above 1%"
            runbook_url: "https://wiki.example.com/runbooks/api-error-rate"
```

### AlertmanagerConfig for Namespace-Scoped Routing

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: team-routing
  namespace: my-team-namespace
spec:
  route:
    receiver: team-slack
    matchers:
      - name: namespace
        value: my-team-namespace
    routes:
      - receiver: team-pagerduty
        matchers:
          - name: severity
            value: page

  receivers:
    - name: team-slack
      slackConfigs:
        - apiURL:
            name: slack-webhook-secret
            key: url
          channel: "#my-team-alerts"
          sendResolved: true

    - name: team-pagerduty
      pagerdutyConfigs:
        - routingKey:
            name: pagerduty-secret
            key: routing-key
          severity: critical
```

## Section 12: Performance Tuning Recording Rule Evaluation

Large numbers of recording rules can create their own performance problems. Monitor rule evaluation time:

```promql
# Which rule groups take the longest to evaluate?
topk(10, prometheus_rule_group_last_duration_seconds)

# Which individual rules are most expensive?
topk(10,
  sort_desc(prometheus_rule_evaluation_duration_seconds{quantile="0.99"})
)

# Alert on slow rule evaluation
# If a rule group takes longer than its interval, results become stale
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
        annotations:
          summary: "Rule group {{ $labels.rule_group }} evaluation taking {{ $value | humanizeDuration }}"
          description: |
            Rule group evaluation is consuming {{ $value | humanizeDuration }},
            which is > 90% of the configured interval.
            Consider splitting the group or increasing the interval.
```

### Partitioning Heavy Recording Rule Groups

```yaml
groups:
  # Split expensive histogram calculations across groups
  # so they don't block simpler rules
  - name: latency_p50_p75
    interval: 60s
    rules:
      - record: job:http_request_duration_seconds:p50_rate5m
        expr: |
          histogram_quantile(0.50,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (job, le))

      - record: job:http_request_duration_seconds:p75_rate5m
        expr: |
          histogram_quantile(0.75,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (job, le))

  - name: latency_p90_p99
    interval: 60s
    rules:
      - record: job:http_request_duration_seconds:p90_rate5m
        expr: |
          histogram_quantile(0.90,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (job, le))

      - record: job:http_request_duration_seconds:p99_rate5m
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (job, le))
```

## Section 13: Common Mistakes and How to Avoid Them

### Mistake 1: Aggregating Away Labels You Need Later

```promql
# BAD: Aggregated away 'job' - can't filter by job in alerting rule
- record: http_error_ratio:rate5m
  expr: |
    sum(rate(http_requests_total{status=~"5.."}[5m]))
    /
    sum(rate(http_requests_total[5m]))

# GOOD: Keep job label for per-service alerting
- record: job:http_error_ratio:rate5m
  expr: |
    sum(rate(http_requests_total{status=~"5.."}[5m])) by (job)
    /
    sum(rate(http_requests_total[5m])) by (job)
```

### Mistake 2: Recording Rules with High Cardinality Output

```promql
# BAD: pod label kept - defeats the purpose of the recording rule
- record: job:http_requests:rate5m
  expr: sum(rate(http_requests_total[5m])) by (job, pod, instance)

# GOOD: Aggregate pod and instance away
- record: job:http_requests:rate5m
  expr: sum(rate(http_requests_total[5m])) by (job)
```

### Mistake 3: Missing `for` Clause on Alerting Rules

```yaml
# BAD: Alerts on the first evaluation where condition is true
# Creates false positives from scrape delays and transient spikes
- alert: HighErrorRate
  expr: job:http_error_ratio:rate5m > 0.01

# GOOD: Requires sustained condition before alerting
- alert: HighErrorRate
  expr: job:http_error_ratio:rate5m > 0.01
  for: 5m
```

### Mistake 4: Alert Flooding from Missing Group Configuration

```yaml
# BAD: Every pod restart creates a separate notification
route:
  receiver: slack
  group_by: [alertname]  # Too narrow, floods on multi-pod issues

# GOOD: Group by namespace to batch related alerts
route:
  receiver: slack
  group_by: [alertname, namespace, cluster]
  group_wait: 30s
  group_interval: 5m
```

## Summary

Production-grade Prometheus monitoring requires investment in three areas:

1. **Recording rules** pre-compute expensive PromQL so dashboards load fast and alerting evaluations are consistent. Follow the `level:metric:operations` naming convention and create rules at multiple aggregation levels.

2. **Alerting rules** should target user-visible symptoms, use multi-window burn rate calculations for SLO alerting, and always include actionable annotations with runbook links.

3. **Alertmanager configuration** needs a well-designed routing tree with team-based routing, inhibition rules for cascading failures, and automated silence management for planned maintenance.

The investment in properly structured recording and alerting rules pays dividends in reduced alert fatigue, faster incident resolution, and maintainable observability infrastructure that scales with your organization.
