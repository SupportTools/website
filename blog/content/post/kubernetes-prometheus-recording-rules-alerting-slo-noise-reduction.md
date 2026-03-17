---
title: "Kubernetes Prometheus Recording Rules and Alerting: SLO-Based Alerting and Noise Reduction"
date: 2031-08-06T00:00:00-05:00
draft: false
tags: ["Prometheus", "Kubernetes", "Alerting", "SLO", "Recording Rules", "Observability", "Monitoring", "AlertManager"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Prometheus recording rules, SLO-based multi-window alerting, alert noise reduction strategies, and AlertManager routing for Kubernetes environments managing hundreds of services."
more_link: "yes"
url: "/kubernetes-prometheus-recording-rules-slo-alerting-noise-reduction/"
---

Alert fatigue kills on-call effectiveness. When every page requires investigation to determine whether it is real or a transient artifact, engineers stop trusting alerts and start ignoring them — exactly when they cannot afford to. The solution is not fewer alerts per se, but alerts with higher signal-to-noise ratios. SLO-based multi-window alerting, combined with well-structured recording rules and thoughtful AlertManager routing, produces alert volumes that on-call engineers can actually work with.

This guide covers the mechanics of Prometheus recording rules (how to write them and why they matter for performance), the multi-window multi-burn-rate SLO alerting model, practical noise reduction techniques for Kubernetes environments, and AlertManager configuration that routes alerts to the right teams without creating notification storms.

<!--more-->

# Kubernetes Prometheus Recording Rules and Alerting: SLO-Based Alerting and Noise Reduction

## Recording Rules: The Foundation

Recording rules pre-compute expensive PromQL expressions and store the results as new time series. They serve two purposes: performance (complex aggregations run once rather than on every query and dashboard load) and semantic naming (giving meaningful names to intermediate computations).

### Why Recording Rules Matter

A dashboard query like the following runs on every panel refresh for every user viewing the dashboard:

```promql
sum(rate(http_requests_total{job="api-service", status=~"5.."}[5m]))
/
sum(rate(http_requests_total{job="api-service"}[5m]))
```

If 20 engineers are watching the dashboard during an incident and it refreshes every 30 seconds, Prometheus runs this query 40 times per minute, each time scanning all http_requests_total samples for the time range. With recording rules, this computation runs once per evaluation interval (typically 1 minute) and is stored as a single time series. All dashboard queries read that stored series instead.

### Recording Rule Naming Convention

The official convention is `level:metric:operations`:
- **level**: aggregation level (job, cluster, namespace)
- **metric**: base metric name
- **operations**: list of operations applied (rate, sum, ratio)

```yaml
# rules/http-request-rules.yaml
groups:
  - name: http.request.rates
    # Evaluation interval: all rules in this group run together
    interval: 1m
    rules:
      # Job-level request rate (5m window)
      - record: job:http_requests:rate5m
        expr: |
          sum by (job, namespace) (
            rate(http_requests_total[5m])
          )

      # Job-level error rate (5m window)
      - record: job:http_request_errors:rate5m
        expr: |
          sum by (job, namespace) (
            rate(http_requests_total{status=~"5.."}[5m])
          )

      # Job-level error ratio
      - record: job:http_request_error_ratio:rate5m
        expr: |
          job:http_request_errors:rate5m
          /
          job:http_requests:rate5m

      # P99 latency by job
      - record: job:http_request_duration_seconds:p99_5m
        expr: |
          histogram_quantile(0.99,
            sum by (job, namespace, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )

      # P50 latency by job
      - record: job:http_request_duration_seconds:p50_5m
        expr: |
          histogram_quantile(0.50,
            sum by (job, namespace, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )

  - name: http.request.rates.1h
    interval: 5m
    rules:
      # 1-hour rate for SLO burn rate calculations
      - record: job:http_requests:rate1h
        expr: |
          sum by (job, namespace) (
            rate(http_requests_total[1h])
          )

      - record: job:http_request_errors:rate1h
        expr: |
          sum by (job, namespace) (
            rate(http_requests_total{status=~"5.."}[1h])
          )

      - record: job:http_request_error_ratio:rate1h
        expr: |
          job:http_request_errors:rate1h
          /
          job:http_requests:rate1h

  - name: http.request.rates.6h
    interval: 15m
    rules:
      - record: job:http_requests:rate6h
        expr: |
          sum by (job, namespace) (
            rate(http_requests_total[6h])
          )

      - record: job:http_request_error_ratio:rate6h
        expr: |
          sum by (job, namespace) (
            rate(http_requests_total{status=~"5.."}[6h])
          )
          /
          sum by (job, namespace) (
            rate(http_requests_total[6h])
          )
```

### Kubernetes Infrastructure Recording Rules

```yaml
groups:
  - name: kubernetes.workload
    interval: 1m
    rules:
      # Pod CPU utilization vs request
      - record: namespace_pod:container_cpu_usage:rate5m
        expr: |
          sum by (namespace, pod, container) (
            rate(container_cpu_usage_seconds_total{container!=""}[5m])
          )

      - record: namespace_pod:container_cpu_request_ratio:rate5m
        expr: |
          namespace_pod:container_cpu_usage:rate5m
          /
          sum by (namespace, pod, container) (
            kube_pod_container_resource_requests{resource="cpu", container!=""}
          )

      # Pod memory utilization
      - record: namespace_pod:container_memory_working_set:bytes
        expr: |
          sum by (namespace, pod, container) (
            container_memory_working_set_bytes{container!=""}
          )

      # Node-level resource availability
      - record: node:allocatable_cpu:total
        expr: |
          sum by (node) (
            kube_node_status_allocatable{resource="cpu"}
          )

      - record: node:requested_cpu:ratio
        expr: |
          sum by (node) (
            kube_pod_container_resource_requests{resource="cpu", container!=""}
          )
          /
          node:allocatable_cpu:total

  - name: kubernetes.networking
    interval: 1m
    rules:
      # Pod network throughput
      - record: namespace_pod:network_receive_bytes:rate5m
        expr: |
          sum by (namespace, pod) (
            rate(container_network_receive_bytes_total[5m])
          )

      - record: namespace_pod:network_transmit_bytes:rate5m
        expr: |
          sum by (namespace, pod) (
            rate(container_network_transmit_bytes_total[5m])
          )
```

## SLO-Based Multi-Window Alerting

The Google Site Reliability Engineering book defines SLOs as the target for a service's reliability over a time period (typically a 30-day rolling window). SLO-based alerting fires when the error budget is being consumed too quickly, rather than when a simple threshold is crossed.

### Error Budget Concept

For a 99.9% availability SLO over 30 days:
- Total request budget = 30 * 24 * 60 / 100 = 432 minutes of downtime allowed
- At 99.9% uptime, you can have 0.1% of requests fail
- Error budget = 1 - 0.999 = 0.001 (0.1% of all requests can fail)

Burn rate measures how quickly the error budget is being consumed relative to the normal rate. A burn rate of 1x means the budget is being consumed at exactly the rate that allows you to exhaust it at the end of the 30-day window. A burn rate of 14.4x means the budget will be exhausted in 2 hours (30 days / 14.4 = 2.08 days... actually 30*24/14.4 = 50 hours — see the multi-window model below).

### Multi-Window Multi-Burn-Rate Alert Model

The Alerting on SLOs chapter of the SRE Workbook recommends the following burn rates and windows:

| Burn Rate | Short Window | Long Window | Alert | Severity |
|-----------|-------------|-------------|-------|----------|
| 14.4x     | 1h          | 5m          | Page  | Critical |
| 6x        | 6h          | 30m         | Page  | Critical |
| 3x        | 24h         | 2h          | Ticket | Warning  |
| 1x        | 72h         | 6h          | Ticket | Warning  |

Both windows must be firing for an alert to trigger. This eliminates both false positives (short-lived spikes that resolve quickly) and false negatives (slow burns that a single window misses).

```yaml
# rules/slo-alerts.yaml
groups:
  - name: slo.api-service
    rules:
      # =====================================================================
      # SLO: 99.9% availability for api-service
      # Error budget: 0.1% of requests can fail
      # =====================================================================

      # 1. Critical: 14.4x burn rate (exhausts budget in ~2h)
      # Both windows must exceed 14.4 * (1 - SLO) error rate
      # For 99.9% SLO: threshold = 14.4 * 0.001 = 0.0144 (1.44% errors)
      - alert: APIServiceHighErrorBudgetBurnCritical
        expr: |
          (
            # Short window: 5-minute error rate
            job:http_request_error_ratio:rate5m{job="api-service"}
            > 14.4 * 0.001
          )
          and
          (
            # Long window: 1-hour error rate
            job:http_request_error_ratio:rate1h{job="api-service"}
            > 14.4 * 0.001
          )
        for: 2m
        labels:
          severity: critical
          slo: "99.9"
          service: api-service
          burn_rate: "14.4"
        annotations:
          summary: "api-service is burning error budget at 14.4x rate"
          description: |
            api-service is experiencing {{ $value | humanizePercentage }} error rate.
            At 14.4x burn rate, the monthly error budget will be exhausted in approximately 2 hours.
            Current error rate: {{ $value | humanizePercentage }}
            Threshold: 1.44%
          runbook: "https://runbooks.internal.example.com/api-service-high-error-rate"
          dashboard: "https://grafana.internal.example.com/d/api-service-slo"

      # 2. Critical: 6x burn rate (exhausts budget in ~5 days)
      # Threshold = 6 * 0.001 = 0.006 (0.6% errors)
      - alert: APIServiceElevatedErrorBudgetBurnCritical
        expr: |
          (
            job:http_request_error_ratio:rate30m{job="api-service"}
            > 6 * 0.001
          )
          and
          (
            job:http_request_error_ratio:rate6h{job="api-service"}
            > 6 * 0.001
          )
        for: 15m
        labels:
          severity: critical
          slo: "99.9"
          service: api-service
          burn_rate: "6"
        annotations:
          summary: "api-service error budget burn rate elevated (6x)"
          description: |
            api-service error rate has been {{ $value | humanizePercentage }} for 15+ minutes.
            At 6x burn rate, the monthly error budget will exhaust in ~5 days.
          runbook: "https://runbooks.internal.example.com/api-service-high-error-rate"

      # 3. Warning: 3x burn rate (ticket, not page)
      - alert: APIServiceErrorBudgetBurnWarning
        expr: |
          (
            job:http_request_error_ratio:rate2h{job="api-service"}
            > 3 * 0.001
          )
          and
          (
            job:http_request_error_ratio:rate24h{job="api-service"}
            > 3 * 0.001
          )
        for: 30m
        labels:
          severity: warning
          slo: "99.9"
          service: api-service
          burn_rate: "3"
        annotations:
          summary: "api-service error budget trending negative"
          description: |
            api-service has sustained {{ $value | humanizePercentage }} error rate.
            Create a ticket to investigate before budget exhaustion.

      # 4. Latency SLO: 99% of requests complete within 200ms
      # Burn rate alert on latency
      - alert: APIServiceLatencyBudgetBurnCritical
        expr: |
          (
            1 - (
              sum(rate(http_request_duration_seconds_bucket{job="api-service", le="0.2"}[5m]))
              /
              sum(rate(http_request_duration_seconds_count{job="api-service"}[5m]))
            )
          ) > 14.4 * 0.01
        for: 2m
        labels:
          severity: critical
          slo: "99"
          slo_type: latency
          service: api-service
        annotations:
          summary: "api-service latency SLO budget burning at 14.4x"
          description: |
            {{ $value | humanizePercentage }} of requests are exceeding the 200ms latency target.
            SLO target: 99% of requests under 200ms.
```

### Recording Rules for SLO Windows

The 30-minute and 2-hour error ratios referenced above need their own recording rules:

```yaml
groups:
  - name: slo.window.rates
    interval: 1m
    rules:
      - record: job:http_request_error_ratio:rate30m
        expr: |
          sum by (job, namespace) (
            rate(http_requests_total{status=~"5.."}[30m])
          )
          /
          sum by (job, namespace) (
            rate(http_requests_total[30m])
          )

      - record: job:http_request_error_ratio:rate2h
        expr: |
          sum by (job, namespace) (
            rate(http_requests_total{status=~"5.."}[2h])
          )
          /
          sum by (job, namespace) (
            rate(http_requests_total[2h])
          )

      - record: job:http_request_error_ratio:rate24h
        expr: |
          sum by (job, namespace) (
            rate(http_requests_total{status=~"5.."}[24h])
          )
          /
          sum by (job, namespace) (
            rate(http_requests_total[24h])
          )

      # Error budget remaining (percentage of 30-day budget left)
      - record: job:slo_error_budget_remaining:ratio30d
        expr: |
          1 - (
            (
              1 - sum by (job) (
                increase(http_requests_total{status=~"5.."}[30d])
              )
              /
              sum by (job) (
                increase(http_requests_total[30d])
              )
            )
            / 0.001  # 1 - SLO target (0.999)
          )
```

## Alert Noise Reduction

### Inhibition Rules

Inhibit downstream alerts when an upstream cause is known.

```yaml
# alertmanager/config.yaml
inhibit_rules:
  # Inhibit all non-critical alerts for a namespace when the namespace
  # has an active critical incident
  - source_match:
      severity: critical
    target_match_re:
      severity: ^(warning|info)$
    equal: [namespace, cluster]

  # Inhibit pod-level alerts when the node itself is down
  - source_match:
      alertname: KubernetesNodeNotReady
    target_match_re:
      alertname: ^KubernetesPod.*
    equal: [node]

  # Inhibit replica alerts when the deployment alert is firing
  - source_match:
      alertname: KubernetesDeploymentReplicasMismatch
    target_match_re:
      alertname: ^KubernetesPodCrash.*|^KubernetesPodNotReady.*
    equal: [namespace, deployment]

  # During maintenance windows: suppress everything
  - source_match:
      alertname: InMaintenance
    target_match_re:
      alertname: .*
    equal: [cluster]
```

### Dead Man's Switch Pattern

A "dead man's switch" alert fires when a specific recording rule stops producing data, indicating that Prometheus scraping has failed.

```yaml
# Alert if Prometheus has not scraped a target in 5 minutes
- alert: PrometheusTargetMissing
  expr: up == 0
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Prometheus target {{ $labels.instance }} is down"

# Alert if the watchdog expression stops firing (Prometheus itself is broken)
# This alert should always be firing; silence it in AlertManager
# Your on-call tooling monitors whether it is silenced
- alert: Watchdog
  expr: vector(1)
  labels:
    severity: none
  annotations:
    summary: "Alertmanager watchdog - this should always be firing"
```

### Grouping to Prevent Notification Storms

```yaml
# alertmanager/config.yaml
route:
  group_by: [cluster, namespace, alertname]
  # Wait this long before sending the first notification in a group
  group_wait: 30s
  # Wait this long before sending notifications for new alerts added to an existing group
  group_interval: 5m
  # How long before re-sending a notification for an ongoing alert
  repeat_interval: 4h
  receiver: default-pagerduty
  routes:
    # Critical alerts: page immediately
    - match:
        severity: critical
      receiver: pagerduty-critical
      group_wait: 10s
      repeat_interval: 1h
      continue: false

    # Warning alerts for specific teams: send to Slack
    - match_re:
        severity: ^warning$
        team: ^platform$
      receiver: slack-platform
      group_wait: 5m
      group_interval: 10m
      repeat_interval: 8h

    # Warning alerts: create tickets, do not page
    - match:
        severity: warning
      receiver: jira-ticket
      repeat_interval: 24h

receivers:
  - name: default-pagerduty
    pagerduty_configs:
      - routing_key: <pagerduty-integration-key>
        send_resolved: true
        description: '{{ template "pagerduty.description" . }}'
        client: "Prometheus AlertManager"
        client_url: "https://alertmanager.internal.example.com"
        details:
          firing: '{{ template "pagerduty.firing" . }}'
          num_firing: '{{ .Alerts.Firing | len }}'
          num_resolved: '{{ .Alerts.Resolved | len }}'

  - name: pagerduty-critical
    pagerduty_configs:
      - routing_key: <pagerduty-integration-key-critical>
        severity: critical
        send_resolved: true

  - name: slack-platform
    slack_configs:
      - api_url: <slack-webhook-url>
        channel: '#platform-alerts'
        send_resolved: true
        title: '{{ template "slack.title" . }}'
        text: '{{ template "slack.text" . }}'
        actions:
          - type: button
            text: View Dashboard
            url: '{{ (index .Alerts 0).Annotations.dashboard }}'
          - type: button
            text: View Runbook
            url: '{{ (index .Alerts 0).Annotations.runbook }}'

  - name: jira-ticket
    webhook_configs:
      - url: 'https://jira-webhook.internal.example.com/alert'
        send_resolved: true
```

### Alert Templates

```yaml
# alertmanager/templates/notification.tmpl
{{ define "pagerduty.description" }}
[{{ .CommonLabels.severity | toUpper }}] {{ .CommonLabels.alertname }}
Cluster: {{ .CommonLabels.cluster }}
Namespace: {{ .CommonLabels.namespace }}
{{ end }}

{{ define "slack.title" }}
[{{ if gt (len .Alerts.Firing) 0 }}FIRING: {{ len .Alerts.Firing }}{{ end }}
{{- if gt (len .Alerts.Resolved) 0 }} RESOLVED: {{ len .Alerts.Resolved }}{{ end }}]
{{ .CommonLabels.alertname }}
{{ end }}

{{ define "slack.text" }}
{{ range .Alerts.Firing }}
*Alert:* {{ .Annotations.summary }}
*Description:* {{ .Annotations.description }}
*Severity:* {{ .Labels.severity }}
*Cluster:* {{ .Labels.cluster }}
*Since:* {{ .StartsAt | since }}
{{ end }}
{{ range .Alerts.Resolved }}
*Resolved:* {{ .Annotations.summary }}
*Duration:* {{ .StartsAt | since }}
{{ end }}
{{ end }}
```

## Alert Lifecycle Management

### Silence During Maintenance

```bash
# Create a silence for a planned maintenance window
amtool silence add \
  --author "matthew@support.tools" \
  --comment "Planned maintenance: node replacement" \
  --duration 2h \
  'cluster="production-us-east-1"' \
  'namespace="kube-system"'

# List active silences
amtool silence query

# Expire a silence early
amtool silence expire <silence-id>
```

### Alert Status Monitoring

```bash
# Query all currently firing alerts
curl -s http://alertmanager:9093/api/v2/alerts | \
    python3 -m json.tool | \
    jq '.[] | select(.status.state == "active") | {name: .labels.alertname, severity: .labels.severity, since: .startsAt}'

# Count firing alerts by severity
curl -s http://alertmanager:9093/api/v2/alerts | \
    jq 'group_by(.labels.severity) | map({severity: .[0].labels.severity, count: length})'

# Prometheus alert summary
curl -s http://prometheus:9090/api/v1/alerts | \
    jq '.data.alerts | group_by(.labels.severity) | map({severity: .[0].labels.severity, count: length})'
```

## Kubernetes-Specific Alert Patterns

### Node and Control Plane Alerts

```yaml
groups:
  - name: kubernetes.nodes
    rules:
      - alert: KubernetesNodeMemoryPressure
        expr: |
          kube_node_status_condition{condition="MemoryPressure", status="true"} == 1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.node }} is experiencing memory pressure"

      - alert: KubernetesNodeDiskPressure
        expr: |
          kube_node_status_condition{condition="DiskPressure", status="true"} == 1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.node }} has disk pressure"

      - alert: KubernetesNodeNotReady
        expr: |
          kube_node_status_condition{condition="Ready", status="true"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.node }} is not ready"

  - name: kubernetes.workloads
    rules:
      # Deployment rollout stuck
      - alert: KubernetesDeploymentRolloutStuck
        expr: |
          kube_deployment_status_condition{condition="Progressing", status="false"}
          * on (namespace, deployment) group_left
          kube_deployment_status_observed_generation
          !=
          kube_deployment_metadata_generation
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} rollout is stuck"
          description: "Deployment has been progressing for more than 15 minutes without completing"

      # Pod crash loop
      - alert: KubernetesPodCrashLooping
        expr: |
          rate(kube_pod_container_status_restarts_total[15m]) * 60 * 15 > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping"
          description: "Container {{ $labels.container }} has restarted {{ $value | humanize }} times in 15 minutes"

      # PersistentVolumeClaim capacity warning
      - alert: KubernetesPVCNearlyFull
        expr: |
          (
            kubelet_volume_stats_available_bytes
            /
            kubelet_volume_stats_capacity_bytes
          ) < 0.15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is nearly full"
          description: "Only {{ $value | humanizePercentage }} capacity remaining"
```

### etcd Alerts

```yaml
groups:
  - name: etcd
    rules:
      - alert: EtcdHighCommitDuration
        expr: |
          histogram_quantile(0.99, rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])) > 0.25
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "etcd commit p99 latency is high"
          description: "p99 commit duration is {{ $value }}s (threshold: 0.25s)"

      - alert: EtcdNoLeader
        expr: |
          etcd_server_has_leader == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "etcd cluster has no leader"
```

## Prometheus Rule File Management with PrometheusRule CRD

When using the Prometheus Operator, rules are managed as Kubernetes resources:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-service-slo
  namespace: monitoring
  labels:
    # These labels must match the Prometheus ruleSelector
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: api-service.slo
      rules:
        - record: job:http_requests:rate5m
          expr: |
            sum by (job, namespace) (
              rate(http_requests_total[5m])
            )
        - alert: APIServiceHighErrorBudgetBurnCritical
          expr: |
            job:http_request_error_ratio:rate5m{job="api-service"} > 0.0144
            and
            job:http_request_error_ratio:rate1h{job="api-service"} > 0.0144
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "api-service burning error budget at 14.4x"
```

```bash
# Apply the rule
kubectl apply -f api-service-slo.yaml

# Verify Prometheus loaded the rule
kubectl exec -n monitoring prometheus-kube-prometheus-prometheus-0 -- \
    promtool rules list /etc/prometheus/rules/

# Test rule expressions (dry run)
kubectl exec -n monitoring prometheus-kube-prometheus-prometheus-0 -- \
    promtool check rules /etc/prometheus/rules/*.yaml

# Query the recording rule result
curl "http://prometheus:9090/api/v1/query?query=job:http_requests:rate5m" | \
    python3 -m json.tool
```

## Validating Alert Quality

```bash
# Unit test recording rules and alerts with promtool
cat > /tmp/test-rules.yaml << 'EOF'
rule_files:
  - /path/to/rules/http-request-rules.yaml
  - /path/to/rules/slo-alerts.yaml

evaluation_interval: 1m

tests:
  - interval: 1m
    input_series:
      - series: 'http_requests_total{job="api-service", status="200"}'
        values: '1000 1000 1000 1000 1000'
      - series: 'http_requests_total{job="api-service", status="500"}'
        values: '15 15 15 15 15'

    promql_expr_test:
      - expr: job:http_request_error_ratio:rate5m{job="api-service"}
        eval_time: 5m
        exp_samples:
          - labels: '{job="api-service"}'
            value: 0.014778  # approximately 15/1015

    alert_rule_test:
      - eval_time: 5m
        alertname: APIServiceHighErrorBudgetBurnCritical
        exp_alerts:
          - exp_labels:
              severity: critical
              job: api-service
            exp_annotations:
              summary: "api-service is burning error budget at 14.4x rate"
EOF

promtool test rules /tmp/test-rules.yaml
```

## Summary

Building a high signal-to-noise alerting system requires investing in three areas: recording rules that make queries fast and naming consistent, SLO-based multi-window alerting that fires on business impact rather than technical thresholds, and AlertManager routing that puts the right alerts in front of the right people without paging for warnings.

The most impactful practices from this guide:

- Write recording rules for any PromQL expression used in dashboards and alerts; pre-computed rules are 10-100x faster to query
- Use the multi-window multi-burn-rate model for all user-facing services; single-threshold alerts fire for transient spikes that resolve on their own
- Set `for:` durations that match the short window — `for: 2m` for the 5m/1h burn rate, `for: 15m` for the 30m/6h burn rate
- Use AlertManager inhibition rules to suppress downstream alerts when an upstream cause is known
- Route warnings to ticket systems, not PagerDuty; only critical alerts should wake people up
- Test your alert rules with `promtool test rules` before deploying to ensure they fire under the conditions you expect
