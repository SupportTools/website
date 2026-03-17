---
title: "Prometheus Alerting Rules: SLO-Based Alerting and Alert Fatigue Reduction"
date: 2028-01-20T00:00:00-05:00
draft: false
tags: ["Prometheus", "Alerting", "SLO", "Alertmanager", "Observability", "SRE", "Kubernetes"]
categories: ["Monitoring", "SRE"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Prometheus alerting covering multi-window multi-burn-rate SLO alerting, recording rules optimization, absent metric alerting, inhibit_rules, Alertmanager routing trees, silence automation, and alert grouping strategies."
more_link: "yes"
url: "/prometheus-alerting-rules-enterprise-guide/"
---

Alert fatigue is the primary enemy of effective on-call operations. When monitoring systems generate alerts that are noisy, ambiguous, or not actionable, on-call engineers develop alert blindness and miss the signals that matter. Prometheus and Alertmanager together provide the primitives needed to build alert systems that fire when SLOs are truly at risk, route notifications to the right teams, and suppress known-bad states without human intervention. The multi-window multi-burn-rate approach to SLO alerting, described in the Google SRE Workbook, provides mathematically grounded thresholds that minimize both false positive and false negative rates.

<!--more-->

# Prometheus Alerting Rules: SLO-Based Alerting and Alert Fatigue Reduction

## Section 1: Recording Rules for Performance

Recording rules pre-compute expensive expressions and store the results as new time series. For alerting rules that evaluate at 30-second intervals, complex aggregations that would take hundreds of milliseconds to compute become instant lookups.

### Naming Conventions

The Prometheus recording rule naming convention is: `level:metric:operations`

- `level`: aggregation level (instance, job, cluster)
- `metric`: the base metric name
- `operations`: transformations applied (rate, sum, etc.)

```yaml
# recording-rules-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-recording-rules
  namespace: monitoring
  labels:
    # This label selector is matched by PrometheusRule objects
    prometheus: kube-prometheus
    role: alert-rules
data:
  recording-rules.yaml: |
    groups:
      # ── HTTP Request Rates ────────────────────────────────────────────────────
      - name: http_request_rates
        interval: 30s  # Pre-compute every 30 seconds
        rules:
          # Total request rate per service, per status class
          - record: job:http_requests_total:rate5m
            expr: |
              sum by (job, status_code) (
                rate(http_requests_total[5m])
              )

          # Error rate as a fraction (used in SLO burn rate calculations)
          - record: job:http_request_errors:rate5m
            expr: |
              sum by (job) (
                rate(http_requests_total{status_code=~"5.."}[5m])
              )
              /
              sum by (job) (
                rate(http_requests_total[5m])
              )

          # P99 latency per service
          - record: job:http_request_duration_seconds:p99_5m
            expr: |
              histogram_quantile(0.99,
                sum by (job, le) (
                  rate(http_request_duration_seconds_bucket[5m])
                )
              )

          # P50 latency per service
          - record: job:http_request_duration_seconds:p50_5m
            expr: |
              histogram_quantile(0.50,
                sum by (job, le) (
                  rate(http_request_duration_seconds_bucket[5m])
                )
              )

      # ── SLO Error Budget Burn Rates ──────────────────────────────────────────
      # Pre-compute burn rates at multiple time windows
      # These are used by multi-window multi-burn-rate alerting (Section 2)
      - name: slo_burn_rates
        interval: 60s
        rules:
          # 1-hour burn rate: fraction of error budget consumed per hour
          # For a 99.9% SLO (error budget = 0.1%):
          # burn_rate = actual_error_rate / (1 - SLO_target)
          # = actual_error_rate / 0.001
          - record: job:slo_error_budget_burn_rate:1h
            expr: |
              (
                sum by (job) (rate(http_requests_total{status_code=~"5.."}[1h]))
                /
                sum by (job) (rate(http_requests_total[1h]))
              )
              / 0.001

          # 6-hour burn rate
          - record: job:slo_error_budget_burn_rate:6h
            expr: |
              (
                sum by (job) (rate(http_requests_total{status_code=~"5.."}[6h]))
                /
                sum by (job) (rate(http_requests_total[6h]))
              )
              / 0.001

          # 24-hour burn rate (used for slow burn detection)
          - record: job:slo_error_budget_burn_rate:24h
            expr: |
              (
                sum by (job) (rate(http_requests_total{status_code=~"5.."}[24h]))
                /
                sum by (job) (rate(http_requests_total[24h]))
              )
              / 0.001

          # 72-hour burn rate (used for very slow burn detection)
          - record: job:slo_error_budget_burn_rate:72h
            expr: |
              (
                sum by (job) (rate(http_requests_total{status_code=~"5.."}[72h]))
                /
                sum by (job) (rate(http_requests_total[72h]))
              )
              / 0.001
```

## Section 2: Multi-Window Multi-Burn-Rate SLO Alerting

The Google SRE Workbook documents the multi-window multi-burn-rate approach as the gold standard for SLO-based alerting. The core insight is that:

- **High burn rate + short window** = page immediately (significant event)
- **Medium burn rate + medium window** = page within 6 hours (sustained degradation)
- **Low burn rate + long window** = ticket (slow leak draining error budget)

For a 99.9% SLO with a 30-day error budget:
- Total error budget: 30 days × 24 hours × 60 min × 0.1% = 43.2 minutes of errors
- Burn rate 14.4 = exhausts budget in 2 days (5% budget gone in 1 hour) → PAGE
- Burn rate 6 = exhausts budget in 5 days → PAGE within 6 hours
- Burn rate 3 = exhausts budget in 10 days → TICKET
- Burn rate 1 = exactly on SLO → normal

```yaml
# slo-alerting-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-based-alerting
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    # ── SLO Alerting: Availability (Error Rate) ───────────────────────────────
    - name: slo.availability
      rules:
        # Window pair 1: 1h/5m — catches sudden, severe degradation
        # Fires when: burn_rate_1h > 14.4 AND burn_rate_5m > 14.4
        # Meaning: at this rate, error budget exhausted in < 2 days
        # Response: Page immediately
        - alert: SLOAvailabilityFastBurn
          expr: |
            (
              job:slo_error_budget_burn_rate:1h > 14.4
              AND
              job:slo_error_budget_burn_rate:5m > 14.4
            )
          for: 2m  # Short window: needs to be sustained for 2 minutes only
          labels:
            severity: critical
            slo_type: availability
            burn_window: fast
          annotations:
            summary: "SLO fast burn: {{ $labels.job }} error budget burning at 14x+ rate"
            description: |
              Service {{ $labels.job }} is burning its error budget at {{ $value | humanize }}x
              the nominal rate (1h window). At this rate, the 30-day error budget will be
              exhausted in approximately {{ div 720 $value | humanizeDuration }}.
            runbook_url: "https://wiki.example.com/runbooks/slo-fast-burn"
            dashboard_url: "https://grafana.example.com/d/slo-dashboard"

        # Window pair 2: 6h/30m — catches sustained medium degradation
        # Fires when: burn_rate_6h > 6 AND burn_rate_30m > 6
        # Meaning: error budget exhausted in < 5 days
        # Response: Page within 6 hours
        - alert: SLOAvailabilityMediumBurn
          expr: |
            (
              job:slo_error_budget_burn_rate:6h > 6
              AND
              job:slo_error_budget_burn_rate:1h > 6
            )
          for: 15m
          labels:
            severity: warning
            slo_type: availability
            burn_window: medium
          annotations:
            summary: "SLO medium burn: {{ $labels.job }} error budget burning at 6x+ rate"
            description: |
              Service {{ $labels.job }} is burning its error budget at {{ $value | humanize }}x
              the nominal rate (6h window). The 30-day error budget will be exhausted in
              approximately {{ div 120 $value | humanizeDuration }}.
            runbook_url: "https://wiki.example.com/runbooks/slo-medium-burn"

        # Window pair 3: 24h/6h — catches slow leaks
        # Fires when: burn_rate_24h > 3 AND burn_rate_6h > 3
        # Meaning: error budget exhausted in < 10 days
        # Response: Create a ticket, investigate during business hours
        - alert: SLOAvailabilitySlowBurn
          expr: |
            (
              job:slo_error_budget_burn_rate:24h > 3
              AND
              job:slo_error_budget_burn_rate:6h > 3
            )
          for: 60m
          labels:
            severity: info
            slo_type: availability
            burn_window: slow
          annotations:
            summary: "SLO slow burn: {{ $labels.job }} error budget burning at 3x+ rate"
            description: |
              Service {{ $labels.job }} is slowly burning its error budget at
              {{ $value | humanize }}x the nominal rate (24h window).
            runbook_url: "https://wiki.example.com/runbooks/slo-slow-burn"

    # ── SLO Alerting: Latency ─────────────────────────────────────────────────
    # Latency SLOs are expressed as: P99 latency <= threshold for >= X% of requests
    # Example SLO: 99% of requests complete within 500ms
    - name: slo.latency
      rules:
        # Pre-compute latency compliance rate
        # compliance_rate = fraction of requests within threshold
        - record: job:slo_latency_compliance:5m
          expr: |
            (
              sum by (job) (
                rate(http_request_duration_seconds_bucket{le="0.5"}[5m])
              )
              /
              sum by (job) (
                rate(http_request_duration_seconds_count[5m])
              )
            )

        - record: job:slo_latency_compliance:1h
          expr: |
            (
              sum by (job) (
                rate(http_request_duration_seconds_bucket{le="0.5"}[1h])
              )
              /
              sum by (job) (
                rate(http_request_duration_seconds_count[1h])
              )
            )

        # Alert: Fast latency burn (sudden P99 spike)
        - alert: SLOLatencyFastBurn
          expr: |
            (
              1 - job:slo_latency_compliance:5m > 14.4 * 0.01
              AND
              1 - job:slo_latency_compliance:1h > 14.4 * 0.01
            )
          for: 2m
          labels:
            severity: critical
            slo_type: latency
          annotations:
            summary: "Latency SLO fast burn: {{ $labels.job }} P99 degraded"
            description: |
              {{ $labels.job }} latency SLO compliance has dropped to
              {{ $value | humanizePercentage }}. The SLO target is 99%.
```

## Section 3: Alerting on Absent Metrics

Absent metrics are a common source of missed incidents. When a service crashes and stops exporting metrics, `rate()` and other range vector functions return empty results rather than zero—causing alert conditions based on high values to never fire.

```yaml
# absent-metric-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: absent-metrics-alerts
  namespace: monitoring
spec:
  groups:
    - name: absent_metrics
      rules:
        # Alert when a specific job stops exporting metrics entirely
        # absent() returns 1 when the time series does not exist
        - alert: MetricsAbsentPaymentService
          expr: absent(up{job="payment-service"})
          for: 5m
          labels:
            severity: critical
            team: payments
          annotations:
            summary: "payment-service has stopped exporting metrics"
            description: "The payment-service Prometheus target has disappeared. The service may be down or the service discovery configuration has changed."

        # More nuanced: service is scraped but reports as down
        - alert: TargetDown
          expr: up == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Prometheus target {{ $labels.job }}/{{ $labels.instance }} is down"
            description: |
              Target {{ $labels.job }} instance {{ $labels.instance }} has been down for
              more than 5 minutes. Last successful scrape was at {{ $value | humanizeTimestamp }}.

        # Alert when a recording rule produces no data
        # This catches cases where upstream metrics disappear
        # but the recording rule still evaluates (returning empty)
        - alert: RecordingRuleAbsent
          expr: absent(job:slo_error_budget_burn_rate:1h)
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "SLO burn rate recording rule is not producing data"
            description: "The recording rule job:slo_error_budget_burn_rate:1h has stopped producing results. Check if the underlying http_requests_total metric is available."

        # Alert when a job is expected but not present in scrape results
        # Uses a reference metric known to always exist when the job is healthy
        - alert: JobMissingFromScrape
          expr: |
            absent(
              up{job=~"payment-service|order-service|user-service|notification-service"}
            )
          for: 3m
          labels:
            severity: critical
          annotations:
            summary: "Critical service missing from Prometheus scrape targets"
```

## Section 4: Alertmanager Configuration

### Routing Tree

The routing tree determines which alerts go to which receivers. The tree is evaluated top-to-bottom; the first matching route wins (unless `continue: true` is set).

```yaml
# alertmanager-config.yaml
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-config
  namespace: monitoring
type: Opaque
stringData:
  alertmanager.yaml: |
    global:
      # Default SMTP settings for email notifications
      smtp_from: 'alertmanager@example.com'
      smtp_smarthost: 'smtp.example.com:587'
      smtp_require_tls: true
      # Resolve timeout: time after which resolved alerts are sent
      resolve_timeout: 5m

    # ── Routing Tree ────────────────────────────────────────────────────────────
    route:
      # Root route: receives all alerts
      receiver: 'default-receiver'
      group_by: ['alertname', 'namespace', 'severity']
      group_wait: 30s      # Wait this long to buffer alerts into a single notification
      group_interval: 5m   # Minimum time between notification batches for same group
      repeat_interval: 4h  # Re-notify if alert is still firing after this interval

      routes:
        # ── Critical alerts: immediate paging via PagerDuty ──────────────────
        - matchers:
            - severity = critical
          receiver: pagerduty-critical
          group_wait: 10s      # Shorter wait for critical alerts
          group_interval: 5m
          repeat_interval: 1h  # Repeat critical alerts more frequently
          continue: false       # Stop routing after this match

        # ── SLO-specific routing ─────────────────────────────────────────────
        - matchers:
            - slo_type =~ "availability|latency"
            - severity = critical
          receiver: pagerduty-slo
          group_by: ['slo_type', 'job']
          group_wait: 10s
          repeat_interval: 30m
          continue: false

        # ── Team-based routing ───────────────────────────────────────────────
        - matchers:
            - team = payments
          receiver: slack-payments-team
          group_by: ['alertname', 'severity']
          group_wait: 30s
          repeat_interval: 2h
          routes:
            # Escalate unacknowledged critical payment alerts to pager
            - matchers:
                - severity = critical
              receiver: pagerduty-payments
              repeat_interval: 30m

        - matchers:
            - team = platform
          receiver: slack-platform-team

        # ── Infrastructure alerts ────────────────────────────────────────────
        - matchers:
            - alertname =~ "KubeNode.*|Node.*|Etcd.*"
          receiver: pagerduty-infra
          group_by: ['alertname', 'node']

        # ── Warning-level alerts: Slack notification only ────────────────────
        - matchers:
            - severity = warning
          receiver: slack-warnings
          group_wait: 2m       # Batch warnings for 2 minutes
          group_interval: 10m
          repeat_interval: 6h  # Warning reminders less frequent

        # ── Info-level alerts: ticket creation only ──────────────────────────
        - matchers:
            - severity = info
          receiver: jira-tickets
          group_wait: 5m
          group_interval: 30m
          repeat_interval: 24h

    # ── Inhibition Rules ────────────────────────────────────────────────────────
    # Inhibit rules suppress child alerts when parent alerts are firing.
    # This prevents alert storms where a single root cause generates dozens of
    # derived alerts.
    inhibit_rules:
      # When a node is down, suppress pod/container alerts on that node
      - source_matchers:
          - alertname = KubeNodeNotReady
        target_matchers:
          - alertname =~ "KubePodCrashLooping|KubePodNotReady|KubeDeploymentReplicasMismatch"
        equal: ['node']

      # When a namespace is terminating, suppress namespace-scoped alerts
      - source_matchers:
          - alertname = KubeNamespaceTerminating
        target_matchers:
          - namespace =~ ".+"
        equal: ['namespace']

      # When critical SLO burn is firing, suppress warning SLO burn for same job
      # (avoid duplicate notifications for the same underlying issue)
      - source_matchers:
          - alertname = SLOAvailabilityFastBurn
          - severity = critical
        target_matchers:
          - alertname =~ "SLOAvailabilityMediumBurn|SLOAvailabilitySlowBurn"
          - severity =~ "warning|info"
        equal: ['job']

      # When etcd is experiencing issues, suppress dependent alerts
      - source_matchers:
          - alertname =~ "EtcdInsufficientMembers|EtcdNoLeader"
        target_matchers:
          - alertname =~ "Kube.*"

      # Info-level inhibition: suppress info when warning exists for same alert
      - source_matchers:
          - severity = warning
        target_matchers:
          - severity = info
        equal: ['alertname', 'namespace']

    # ── Receivers ────────────────────────────────────────────────────────────────
    receivers:
      - name: 'default-receiver'
        slack_configs:
          - api_url: 'https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url'
            channel: '#alerts-general'
            title: '{{ template "slack.default.title" . }}'
            text: '{{ template "slack.default.text" . }}'

      - name: 'pagerduty-critical'
        pagerduty_configs:
          - service_key: 'PLACEHOLDER_PAGERDUTY_SERVICE_KEY'
            description: '{{ .CommonAnnotations.summary }}'
            severity: critical

      - name: 'pagerduty-slo'
        pagerduty_configs:
          - service_key: 'PLACEHOLDER_PAGERDUTY_SLO_KEY'
            description: '{{ .CommonAnnotations.summary }}'
            severity: critical
            client: 'Prometheus'
            client_url: '{{ .CommonAnnotations.dashboard_url }}'
            details:
              runbook: '{{ .CommonAnnotations.runbook_url }}'

      - name: 'pagerduty-infra'
        pagerduty_configs:
          - service_key: 'PLACEHOLDER_PAGERDUTY_INFRA_KEY'
            severity: warning

      - name: 'pagerduty-payments'
        pagerduty_configs:
          - service_key: 'PLACEHOLDER_PAGERDUTY_PAYMENTS_KEY'
            severity: critical

      - name: 'slack-payments-team'
        slack_configs:
          - api_url: 'https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url'
            channel: '#payments-alerts'

      - name: 'slack-platform-team'
        slack_configs:
          - api_url: 'https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url'
            channel: '#platform-alerts'

      - name: 'slack-warnings'
        slack_configs:
          - api_url: 'https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url'
            channel: '#alerts-warnings'

      - name: 'jira-tickets'
        webhook_configs:
          - url: 'https://jira-alertmanager-bridge.internal/create-ticket'
            http_config:
              bearer_token: 'PLACEHOLDER_JIRA_TOKEN'
```

## Section 5: Alert Grouping Strategies

### Effective group_by Labels

```yaml
# alert-grouping-examples.yaml
# group_by controls which labels define an alert group.
# Alerts with the same values for group_by labels are batched together.

# ── Anti-Pattern: Group by everything ──────────────────────────────────────
# route:
#   group_by: ['alertname', 'namespace', 'pod', 'container', 'severity']
# Problem: Each pod gets its own notification. A 100-pod deployment crash
# generates 100 separate pages instead of 1 grouped notification.

# ── Good Pattern: Service-level grouping ────────────────────────────────────
route:
  # Group by service-level identifiers, not instance-level
  group_by: ['alertname', 'namespace', 'job', 'severity']
  # Result: All pods in a crashing deployment become 1 notification

  routes:
    # Kubernetes node alerts: group by node
    - matchers:
        - alertname =~ "KubeNode.*|Node.*"
      group_by: ['alertname', 'node']

    # Database alerts: group by cluster name, not individual instance
    - matchers:
        - alertname =~ "Postgres.*|MySQL.*|MongoDB.*"
      group_by: ['alertname', 'cluster', 'namespace']

    # SLO alerts: group by SLO type and service
    - matchers:
        - slo_type =~ ".+"
      group_by: ['slo_type', 'job']
```

## Section 6: Silence Automation

### Maintenance Window Silences

```bash
#!/bin/bash
# create-maintenance-silence.sh
# Create Alertmanager silences for planned maintenance windows
# Requires: amtool or curl with access to Alertmanager API

set -euo pipefail

ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://alertmanager.monitoring.svc.cluster.local:9093}"
MAINTENANCE_REASON="${1:?Usage: $0 <reason> <duration_hours> [namespace]}"
DURATION_HOURS="${2:?Usage: $0 <reason> <duration_hours> [namespace]}"
NAMESPACE="${3:-}"  # Optional: scope silence to specific namespace

START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
END_TIME=$(date -u -d "+${DURATION_HOURS} hours" +"%Y-%m-%dT%H:%M:%S.000Z")
CREATED_BY="${USER:-automation}@example.com"

echo "=== Creating Maintenance Silence ==="
echo "Reason:   ${MAINTENANCE_REASON}"
echo "Duration: ${DURATION_HOURS} hours"
echo "Start:    ${START_TIME}"
echo "End:      ${END_TIME}"

# Build matchers: scope to namespace if provided
if [[ -n "${NAMESPACE}" ]]; then
  MATCHERS='[
    {"name": "namespace", "value": "'"${NAMESPACE}"'", "isRegex": false},
    {"name": "severity", "value": "critical|warning|info", "isRegex": true}
  ]'
else
  MATCHERS='[
    {"name": "alertname", "value": ".*", "isRegex": true}
  ]'
fi

# Create silence via Alertmanager API
SILENCE_ID=$(curl -s -X POST \
  "${ALERTMANAGER_URL}/api/v2/silences" \
  -H "Content-Type: application/json" \
  -d '{
    "matchers": '"${MATCHERS}"',
    "startsAt": "'"${START_TIME}"'",
    "endsAt": "'"${END_TIME}"'",
    "createdBy": "'"${CREATED_BY}"'",
    "comment": "'"${MAINTENANCE_REASON}"'"
  }' \
  | jq -r '.silenceID')

echo ""
echo "Silence created: ${SILENCE_ID}"
echo "To delete before maintenance ends:"
echo "  curl -X DELETE ${ALERTMANAGER_URL}/api/v2/silence/${SILENCE_ID}"
```

### Automated Silence Expiry Monitoring

```yaml
# silence-expiry-alert.yaml
# Alert when active silences are about to expire during maintenance windows
# Prevents missed alerts after silences expire
- alert: AlertmanagerSilenceExpiringSoon
  expr: |
    alertmanager_silences{state="active"}
    and
    # Silence expires within 30 minutes
    (alertmanager_silence_expiry_timestamp_seconds - time()) < 1800
  for: 0m
  labels:
    severity: info
    team: platform
  annotations:
    summary: "Alertmanager silence expiring in < 30 minutes"
    description: "{{ $value | humanizeDuration }} until active silence expires. Extend if maintenance window is ongoing."
```

## Section 7: Runbook Integration and Alert Quality

### Alert Quality Standards

```yaml
# alert-quality-checklist.yaml
# Every production alert should pass these criteria:

# 1. Actionability: The alert should have a clear, documented response procedure
# 2. Urgency: The severity reflects when human intervention is required
# 3. Precision: The for: duration filters transient spikes
# 4. Context: annotations.description provides enough information to begin diagnosis
# 5. Runbook: annotations.runbook_url links to step-by-step investigation guide

# Example: High-quality alert with full annotation set
- alert: PaymentServiceHighErrorRate
  expr: |
    (
      sum(rate(http_requests_total{job="payment-service",status_code=~"5.."}[5m]))
      /
      sum(rate(http_requests_total{job="payment-service"}[5m]))
    ) > 0.01
  for: 5m
  labels:
    severity: critical
    team: payments
    service: payment-service
    # SLO type label enables SLO-specific routing and inhibition
    slo_type: availability
  annotations:
    # Summary: one line, shown in notification title
    summary: "Payment service error rate {{ $value | humanizePercentage }} exceeds 1% threshold"
    # Description: multi-line diagnosis context
    description: |
      The payment-service is returning HTTP 5xx errors at {{ $value | humanizePercentage }}
      of all requests, sustained for 5+ minutes.

      Current metrics:
      - Error rate: {{ $value | humanizePercentage }}
      - Threshold: 1.0%
      - Affected service: {{ $labels.job }}
      - Namespace: {{ $labels.namespace }}

      Immediate checks:
      1. Review payment-service pod logs: kubectl logs -n production -l app=payment-service --since=10m
      2. Check upstream database connectivity
      3. Verify Stripe API status: https://status.stripe.com
    # Runbook: step-by-step investigation and remediation
    runbook_url: "https://wiki.example.com/runbooks/payment-service-high-error-rate"
    # Dashboard: link to relevant Grafana dashboard
    dashboard_url: "https://grafana.example.com/d/payment-service-overview"
    # SLO impact: helps on-call understand error budget consumption
    slo_impact: "Each minute at this error rate consumes 14.4x the normal error budget allocation"
```

## Section 8: Reducing Alert Fatigue

### Audit Existing Alert Rules

```bash
#!/bin/bash
# audit-alert-rules.sh
# Analyze Prometheus alert rules for common quality issues

PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus.monitoring.svc.cluster.local:9090}"

echo "=== Alert Rule Audit ==="

# List all active alert rules
echo ""
echo "--- All alert rules ---"
curl -s "${PROMETHEUS_URL}/api/v1/rules?type=alert" \
  | jq -r '.data.groups[].rules[] | select(.type == "alerting") | [.name, .labels.severity, .annotations.runbook_url] | @tsv' \
  | sort \
  | column -t -s $'\t' -N "ALERT_NAME,SEVERITY,RUNBOOK_URL"

# Find alerts missing runbook URLs
echo ""
echo "--- Alerts missing runbook_url annotation ---"
curl -s "${PROMETHEUS_URL}/api/v1/rules?type=alert" \
  | jq -r '.data.groups[].rules[] |
    select(.type == "alerting") |
    select(.annotations.runbook_url == null or .annotations.runbook_url == "") |
    .name'

# Find alerts that have been firing for > 1 hour (potential noise)
echo ""
echo "--- Alerts currently firing for > 1 hour ---"
curl -s "${PROMETHEUS_URL}/api/v1/alerts" \
  | jq -r '.data.alerts[] |
    select(.state == "firing") |
    select(
      (now - (.activeAt | fromdateiso8601)) > 3600
    ) |
    [.labels.alertname, .labels.severity, .activeAt] | @tsv' \
  | sort \
  | column -t -s $'\t' -N "ALERT_NAME,SEVERITY,ACTIVE_SINCE"

# Find duplicate or overlapping alert rules
echo ""
echo "--- Potential duplicate alerts (same expr fragment) ---"
curl -s "${PROMETHEUS_URL}/api/v1/rules?type=alert" \
  | jq -r '.data.groups[].rules[] |
    select(.type == "alerting") |
    [.name, .query] | @tsv' \
  | awk -F'\t' '{print $2}' \
  | sort \
  | uniq -d
```

### Flapping Alert Detection

```yaml
# flapping-alert-detection.yaml
# Detect alerts that fire and resolve repeatedly (flapping)
# Flapping indicates either an underlying instability or a poorly tuned 'for:' duration

- alert: AlertFlapping
  expr: |
    # Count state changes for each alert over the last hour
    # If an alert changes state more than 5 times, it is flapping
    changes(ALERTS{alertstate="firing"}[1h]) > 5
  for: 0m
  labels:
    severity: warning
    team: platform
  annotations:
    summary: "Alert {{ $labels.alertname }} is flapping (changed state {{ $value }} times in 1h)"
    description: |
      The alert {{ $labels.alertname }} has changed state {{ $value }} times in the past
      hour. Flapping alerts contribute to alert fatigue and may indicate a misconfigured
      'for:' duration or an unstable underlying metric.

      Recommended actions:
      1. Increase the 'for:' duration to require sustained condition before firing
      2. Add hysteresis: require a different (more lenient) threshold for recovery
      3. Investigate whether the underlying system is genuinely unstable
```

## Section 9: PrometheusRule Best Practices

### Namespace Isolation with PrometheusRules

```yaml
# namespace-prometheus-rule.yaml
# Application teams own their own alerting rules in their namespace
# Requires: Prometheus configured to discover PrometheusRules cluster-wide
# or within specific namespaces
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payment-service-alerts
  namespace: production  # Alert rules live with the application they monitor
  labels:
    # This label must match the Prometheus ruleSelector
    prometheus: kube-prometheus
    role: alert-rules
    team: payments
spec:
  groups:
    - name: payment-service.alerts
      # Use a longer interval for less critical checks to reduce Prometheus load
      interval: 60s
      rules:
        - alert: PaymentServiceDown
          expr: |
            absent(up{job="payment-service", namespace="production"})
            OR
            sum(up{job="payment-service", namespace="production"}) == 0
          for: 3m
          labels:
            severity: critical
            team: payments
          annotations:
            summary: "Payment service is completely down"
            runbook_url: "https://wiki.example.com/runbooks/payment-service-down"

        - alert: PaymentProcessingQueueDepth
          expr: |
            payment_queue_depth > 10000
          for: 5m
          labels:
            severity: warning
            team: payments
          annotations:
            summary: "Payment processing queue depth {{ $value }} exceeds threshold"
            description: "Queue depth {{ $value }} > 10000. Payments may be delayed."
            runbook_url: "https://wiki.example.com/runbooks/payment-queue-depth"
```

## Summary

Effective Prometheus alerting requires addressing three distinct problems:

**Signal quality**: Multi-window multi-burn-rate SLO alerting provides mathematically grounded thresholds that detect both rapid and slow error budget consumption while minimizing false positives. The three window pairs (fast, medium, slow burn) cover the full range from sudden catastrophic failure to gradual degradation.

**Noise reduction**: Inhibition rules prevent alert storms by suppressing derived alerts when root cause alerts are firing. Proper `for:` durations filter transient spikes. Grouping by service-level identifiers rather than instance-level details prevents n-pods-down scenarios from generating n separate notifications.

**Operational efficiency**: Recording rules move expensive computations to pre-computation, keeping alert evaluation fast. Runbook URLs and rich annotations reduce mean-time-to-resolution by providing context at the point of notification. Silence automation handles planned maintenance windows without manual intervention.

Together, these practices shift alert systems from reactive noise generators to proactive tools that surface actionable, correctly prioritized signals to the right people at the right time.
