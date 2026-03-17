---
title: "SLO-Based Alerting: Error Budgets, Burn Rates, and Multi-Window Alerting"
date: 2028-10-09T00:00:00-05:00
draft: false
tags: ["SRE", "SLO", "Observability", "Prometheus", "Alerting"]
categories:
- SRE
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete SLO implementation guide covering SLI/SLO/SLA definitions, error budget calculation, multi-burn-rate alerting, Sloth for SLO generation, Pyrra alternative, recording rules, Grafana dashboards, and error budget policy enforcement."
more_link: "yes"
url: "/observability-slo-error-budget-alerting-guide/"
---

Traditional threshold-based alerting generates enormous alert fatigue: static thresholds fire during expected traffic fluctuations, and percentage-based alerts miss the cumulative impact of sustained low-severity degradation. Service Level Objective-based alerting solves both problems by connecting alerts directly to user impact. When an alert fires, it means you are burning error budget at a rate that threatens your SLO, not just crossing an arbitrary threshold. This guide covers SLO design, error budget mechanics, multi-window burn rate alerting, and automation with Sloth and Pyrra.

<!--more-->

# SLO-Based Alerting: Error Budgets, Burn Rates, and Multi-Window Alerting

## SLI, SLO, and SLA Definitions

**SLI (Service Level Indicator)**: A quantitative measurement of service behavior. Examples: request success rate, P99 latency, availability percentage.

**SLO (Service Level Objective)**: A target for an SLI over a rolling time window. Example: "99.9% of requests succeed over a 30-day window."

**SLA (Service Level Agreement)**: A contractual commitment, often to external customers, backed by SLOs. Typically less strict than the internal SLO to provide buffer.

**Error Budget**: The allowed failure rate derived from the SLO. For a 99.9% SLO over 30 days: `(1 - 0.999) * 30 * 24 * 60 = 43.2 minutes` of allowed downtime, or 0.1% of requests may fail.

The key insight: the error budget converts an abstract percentage into a concrete resource that teams can spend intentionally (deploying risky changes) or that gets consumed by incidents.

## SLI Design Principles

Good SLIs are:

1. **Meaningful**: Directly correlated with user experience
2. **Measurable**: Available from instrumentation without expensive queries
3. **Specific**: Unambiguous—everyone agrees on what "success" means
4. **Few**: 3-5 SLIs cover most services adequately

### Common SLI Patterns

**Availability SLI**:
```promql
# Ratio of successful requests to total requests
sum(rate(http_requests_total{job="myapp", code!~"5.."}[5m]))
/
sum(rate(http_requests_total{job="myapp"}[5m]))
```

**Latency SLI** (proportion of requests under threshold):
```promql
# Proportion of requests completing within 300ms
sum(rate(http_request_duration_seconds_bucket{job="myapp", le="0.3"}[5m]))
/
sum(rate(http_request_duration_seconds_count{job="myapp"}[5m]))
```

**Freshness SLI** (for data pipelines):
```promql
# Proportion of data less than 5 minutes old
(time() - max(data_pipeline_last_processed_timestamp)) < 300
```

**Throughput SLI**:
```promql
# Proportion of time the queue depth is below threshold
avg_over_time((kafka_consumer_lag < 1000)[5m:1m])
```

## Error Budget Calculation

For a 30-day SLO window:

```
Total requests in window = request_rate * 30 * 24 * 3600
Error budget requests = total_requests * (1 - SLO_target)
Error budget minutes = (1 - SLO_target) * 30 * 24 * 60
```

For SLO = 99.9%:

```
Error budget = 0.1% = 43.2 minutes of downtime per 30 days
             = 0.001 * total_requests failures allowed
```

## Multi-Window Burn Rate Alerting

The Google SRE Workbook defines multi-window, multi-burn-rate alerting as the gold standard. The key formula:

```
burn_rate = (error_rate_in_window / error_budget_rate)
```

A burn rate of 1x means you're consuming error budget at exactly the steady-state rate. A burn rate of 14.4x means you'll consume the entire monthly error budget in 2 hours.

### The Two-Alert Strategy

**Page (fast burn)**: High burn rate over a short window. Fires when you're burning budget so fast that immediate action is needed.

**Ticket (slow burn)**: Moderate burn rate over a longer window. Fires when sustained degradation is slowly consuming budget without being dramatic enough to page.

The two-window check (fast + slow) prevents false positives from brief spikes:

```
Alert if: burn_rate_fast_window > threshold AND burn_rate_slow_window > threshold/2
```

### Burn Rate Thresholds

For a 30-day SLO window:

| Alert Severity | Fast Window | Slow Window | Burn Rate | Budget Consumed If Sustained |
|---|---|---|---|---|
| Critical (page) | 1h | 5m | 14.4x | 100% in 2h |
| Critical (page) | 6h | 30m | 6x | 100% in 5h |
| Warning (ticket) | 1d | 2h | 3x | 100% in 10d |
| Warning (info) | 3d | 6h | 1x | 100% in 30d |

## Recording Rules for SLO Metrics

Pre-compute error budget consumption with recording rules:

```yaml
# slo-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-recording-rules
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    # Availability SLO recording rules for myapp
    - name: myapp.availability.slo
      interval: 30s
      rules:
        # Raw SLI: error ratio over various windows
        - record: slo:sli_error:ratio_rate5m
          expr: |
            sum(rate(http_requests_total{job="myapp", code=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{job="myapp"}[5m]))
          labels:
            slo: myapp-availability
            slo_version: "1.0"

        - record: slo:sli_error:ratio_rate30m
          expr: |
            sum(rate(http_requests_total{job="myapp", code=~"5.."}[30m]))
            /
            sum(rate(http_requests_total{job="myapp"}[30m]))
          labels:
            slo: myapp-availability

        - record: slo:sli_error:ratio_rate1h
          expr: |
            sum(rate(http_requests_total{job="myapp", code=~"5.."}[1h]))
            /
            sum(rate(http_requests_total{job="myapp"}[1h]))
          labels:
            slo: myapp-availability

        - record: slo:sli_error:ratio_rate2h
          expr: |
            sum(rate(http_requests_total{job="myapp", code=~"5.."}[2h]))
            /
            sum(rate(http_requests_total{job="myapp"}[2h]))
          labels:
            slo: myapp-availability

        - record: slo:sli_error:ratio_rate6h
          expr: |
            sum(rate(http_requests_total{job="myapp", code=~"5.."}[6h]))
            /
            sum(rate(http_requests_total{job="myapp"}[6h]))
          labels:
            slo: myapp-availability

        - record: slo:sli_error:ratio_rate1d
          expr: |
            sum(rate(http_requests_total{job="myapp", code=~"5.."}[1d]))
            /
            sum(rate(http_requests_total{job="myapp"}[1d]))
          labels:
            slo: myapp-availability

        - record: slo:sli_error:ratio_rate3d
          expr: |
            sum(rate(http_requests_total{job="myapp", code=~"5.."}[3d]))
            /
            sum(rate(http_requests_total{job="myapp"}[3d]))
          labels:
            slo: myapp-availability

        # Error budget remaining (1 = full budget, 0 = budget exhausted)
        # SLO target: 99.9% = error rate budget of 0.001
        - record: slo:error_budget_remaining:ratio
          expr: |
            1 - (
              (sum(increase(http_requests_total{job="myapp", code=~"5.."}[30d])) or vector(0))
              /
              (sum(increase(http_requests_total{job="myapp"}[30d])) * 0.001)
            )
          labels:
            slo: myapp-availability
```

## Multi-Burn-Rate Alert Rules

```yaml
# slo-alerting-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-alerting-rules
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: myapp.availability.alerts
      rules:
        # CRITICAL: Fast burn (2h budget burn in 1h window / 5m window)
        # 14.4x burn rate = consume 100% budget in 2h
        - alert: SLOBudgetBurnHighFast
          expr: |
            (
              slo:sli_error:ratio_rate1h{slo="myapp-availability"} > (14.4 * 0.001)
              and
              slo:sli_error:ratio_rate5m{slo="myapp-availability"} > (14.4 * 0.001)
            )
          for: 2m
          labels:
            severity: critical
            slo: myapp-availability
            page: "true"
          annotations:
            summary: "High error rate: myapp availability SLO at risk"
            description: |
              Error rate {{ $value | humanizePercentage }} (threshold: 1.44%)
              At this rate, the 30-day error budget will be exhausted in 2 hours.
            runbook_url: "https://wiki.example.com/runbooks/myapp-high-error-rate"
            dashboard_url: "https://grafana.example.com/d/slo-dashboard/myapp"

        # CRITICAL: Slower burn (5h budget burn over 6h window / 30m window)
        # 6x burn rate = consume 100% budget in 5h
        - alert: SLOBudgetBurnHighSlow
          expr: |
            (
              slo:sli_error:ratio_rate6h{slo="myapp-availability"} > (6 * 0.001)
              and
              slo:sli_error:ratio_rate30m{slo="myapp-availability"} > (6 * 0.001)
            )
          for: 15m
          labels:
            severity: critical
            slo: myapp-availability
            page: "true"
          annotations:
            summary: "Sustained error rate: myapp availability SLO at risk"
            description: |
              Error rate {{ $value | humanizePercentage }} sustained for 6h.
              At this rate, the 30-day error budget will be exhausted in ~5 hours.

        # WARNING: Medium burn (10-day burn over 1d window / 2h window)
        # 3x burn rate = consume 100% budget in 10 days
        - alert: SLOBudgetBurnMedium
          expr: |
            (
              slo:sli_error:ratio_rate1d{slo="myapp-availability"} > (3 * 0.001)
              and
              slo:sli_error:ratio_rate2h{slo="myapp-availability"} > (3 * 0.001)
            )
          for: 1h
          labels:
            severity: warning
            slo: myapp-availability
          annotations:
            summary: "Elevated error rate: myapp consuming error budget"
            description: |
              Error rate {{ $value | humanizePercentage }} sustained over 1 day.
              At this rate, the monthly error budget will be exhausted in 10 days.

        # WARNING: Low burn (30-day burn in 3d window / 6h window)
        # 1x burn rate = consume 100% budget in exactly 30 days (on-track to miss SLO)
        - alert: SLOBudgetBurnLow
          expr: |
            (
              slo:sli_error:ratio_rate3d{slo="myapp-availability"} > (1 * 0.001)
              and
              slo:sli_error:ratio_rate6h{slo="myapp-availability"} > (1 * 0.001)
            )
          for: 3h
          labels:
            severity: warning
            slo: myapp-availability
          annotations:
            summary: "Error budget tracking at or above expected consumption"
            description: "At current rate, the monthly budget will be exhausted by end of period."

        # CRITICAL: Error budget nearly exhausted (under 5% remaining)
        - alert: SLOErrorBudgetCritical
          expr: slo:error_budget_remaining:ratio{slo="myapp-availability"} < 0.05
          for: 5m
          labels:
            severity: critical
            slo: myapp-availability
          annotations:
            summary: "myapp error budget < 5% remaining"
            description: |
              Only {{ $value | humanizePercentage }} of the monthly error budget remains.
              New deployments should be blocked until budget recovers.
```

## Latency SLO Recording Rules and Alerts

```yaml
# latency-slo-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: latency-slo-rules
  namespace: monitoring
spec:
  groups:
    - name: myapp.latency.slo
      rules:
        # SLO: 99% of requests complete within 300ms
        # SLI: proportion of requests NOT meeting the latency target (error rate)
        - record: slo:sli_error:ratio_rate5m
          expr: |
            1 - (
              sum(rate(http_request_duration_seconds_bucket{job="myapp", le="0.3"}[5m]))
              /
              sum(rate(http_request_duration_seconds_count{job="myapp"}[5m]))
            )
          labels:
            slo: myapp-latency
            slo_window: 5m

        - record: slo:sli_error:ratio_rate30m
          expr: |
            1 - (
              sum(rate(http_request_duration_seconds_bucket{job="myapp", le="0.3"}[30m]))
              /
              sum(rate(http_request_duration_seconds_count{job="myapp"}[30m]))
            )
          labels:
            slo: myapp-latency

        - record: slo:sli_error:ratio_rate1h
          expr: |
            1 - (
              sum(rate(http_request_duration_seconds_bucket{job="myapp", le="0.3"}[1h]))
              /
              sum(rate(http_request_duration_seconds_count{job="myapp"}[1h]))
            )
          labels:
            slo: myapp-latency

        # Latency error budget (SLO target: 99% = error rate budget 0.01)
        - record: slo:error_budget_remaining:ratio
          expr: |
            1 - (
              (1 - sum(increase(http_request_duration_seconds_bucket{job="myapp", le="0.3"}[30d])) / sum(increase(http_request_duration_seconds_count{job="myapp"}[30d])))
              /
              0.01
            )
          labels:
            slo: myapp-latency
```

## Sloth: SLO Definition as Code

Sloth generates Prometheus recording rules and alert rules from a higher-level SLO YAML definition, eliminating the boilerplate:

```bash
# Install Sloth
brew install sloth  # or: go install github.com/slok/sloth/cmd/sloth@latest

# Or use the Docker image
docker pull ghcr.io/slok/sloth:latest
```

```yaml
# myapp-slo.yaml (Sloth SLO definition)
version: "prometheus/v1"
service: myapp
labels:
  team: platform
  tier: "1"

slos:
  - name: requests-availability
    objective: 99.9
    description: "99.9% of HTTP requests succeed"
    sli:
      events:
        error_query: sum(rate(http_requests_total{job="myapp", code=~"5.."}[{{.window}}]))
        total_query: sum(rate(http_requests_total{job="myapp"}[{{.window}}]))
    alerting:
      name: MyappHighErrorRate
      labels:
        category: availability
        page: "true"
      annotations:
        runbook: "https://wiki.example.com/runbooks/myapp-high-error-rate"
      page_alert:
        labels:
          severity: critical
      ticket_alert:
        labels:
          severity: warning

  - name: requests-latency
    objective: 99
    description: "99% of requests complete within 300ms"
    sli:
      events:
        error_query: |
          sum(rate(http_request_duration_seconds_bucket{job="myapp", le="0.3"}[{{.window}}]))
        total_query: sum(rate(http_request_duration_seconds_count{job="myapp"}[{{.window}}]))
    alerting:
      name: MyappHighLatency
      labels:
        category: latency
      page_alert:
        labels:
          severity: critical
      ticket_alert:
        labels:
          severity: warning
```

Generate Prometheus rules from the Sloth definition:

```bash
# Generate rules to stdout
sloth generate -i myapp-slo.yaml

# Generate and output as Kubernetes PrometheusRule
sloth generate -i myapp-slo.yaml --out kubernetes > myapp-prometheusrule.yaml

# Apply to cluster
kubectl apply -f myapp-prometheusrule.yaml
```

## Pyrra: SLO Management with UI

Pyrra is an alternative to Sloth that provides a Kubernetes operator and web UI for SLO management:

```bash
# Install Pyrra via Helm
helm repo add pyrra https://pyrra-dev.github.io/pyrra/helm-charts
helm repo update

helm upgrade --install pyrra pyrra/pyrra \
  --namespace monitoring \
  --set prometheusUrl=http://prometheus-operated.monitoring.svc:9090 \
  --set port=9099
```

```yaml
# pyrra-slo.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: myapp-availability
  namespace: monitoring
  labels:
    team: platform
    service: myapp
spec:
  target: "99.9"
  window: 4w  # 4-week rolling window
  description: "99.9% of requests to myapp succeed"
  indicator:
    ratio:
      errors:
        metric: http_requests_total{job="myapp", code=~"5.."}
      total:
        metric: http_requests_total{job="myapp"}
      grouping:
        - job
```

Pyrra generates the recording rules and alert rules automatically and provides a dashboard showing current SLO status, error budget burn rate, and budget remaining.

## Grafana Dashboard Queries

Key panels for an SLO error budget dashboard:

```promql
# Current SLO compliance (gauge: should be >= 0.999)
1 - slo:sli_error:ratio_rate30d{slo="myapp-availability"}

# Error budget remaining percentage
slo:error_budget_remaining:ratio{slo="myapp-availability"} * 100

# Error budget burn rate (1h)
slo:sli_error:ratio_rate1h{slo="myapp-availability"} / 0.001

# Current error rate vs budget
slo:sli_error:ratio_rate5m{slo="myapp-availability"}

# Error budget consumption over time (30d window)
1 - (
  sum(increase(http_requests_total{job="myapp", code!~"5.."}[30d]))
  /
  sum(increase(http_requests_total{job="myapp"}[30d]))
) / 0.001

# Time until budget exhausted at current burn rate
(slo:error_budget_remaining:ratio / (slo:sli_error:ratio_rate1h / 0.001)) * (30 * 24)
```

### Dashboard JSON Panel Examples

```json
{
  "panels": [
    {
      "title": "Error Budget Remaining",
      "type": "gauge",
      "options": {
        "thresholds": {
          "steps": [
            {"value": 0, "color": "red"},
            {"value": 5, "color": "yellow"},
            {"value": 25, "color": "green"}
          ]
        }
      },
      "targets": [{
        "expr": "slo:error_budget_remaining:ratio{slo=\"myapp-availability\"} * 100",
        "legendFormat": "Budget Remaining %"
      }]
    },
    {
      "title": "Burn Rate (1h)",
      "type": "stat",
      "targets": [{
        "expr": "slo:sli_error:ratio_rate1h{slo=\"myapp-availability\"} / 0.001",
        "legendFormat": "Burn Rate"
      }],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "steps": [
              {"value": 0, "color": "green"},
              {"value": 3, "color": "yellow"},
              {"value": 6, "color": "orange"},
              {"value": 14.4, "color": "red"}
            ]
          }
        }
      }
    }
  ]
}
```

## Error Budget Policy Enforcement

Error budget policies define what teams must do at different budget consumption levels:

```yaml
# error-budget-policy.yaml
# This document defines the error budget policy for myapp.
# It should be enforced via CI/CD gates and team agreements.

apiVersion: v1
kind: ConfigMap
metadata:
  name: error-budget-policy
  namespace: myapp
data:
  policy.yaml: |
    service: myapp
    slo_target: 99.9%
    window: 30d

    gates:
      # Budget > 50%: Normal operations
      - budget_remaining_above: 50%
        allowed_actions:
          - deployments: true
          - experiments: true
          - planned_maintenance: true
          - risky_changes: true

      # Budget 25-50%: Increased caution
      - budget_remaining_between: [25%, 50%]
        allowed_actions:
          - deployments: true
          - experiments: false  # No experiments
          - planned_maintenance: true
          - risky_changes: false  # Require SRE review

      # Budget 5-25%: Restricted operations
      - budget_remaining_between: [5%, 25%]
        allowed_actions:
          - deployments: "critical-fixes-only"
          - experiments: false
          - planned_maintenance: false
          - risky_changes: false
        required_approvals:
          - sre-team

      # Budget < 5%: Emergency freeze
      - budget_remaining_below: 5%
        allowed_actions:
          - deployments: "severity-critical-only"
          - experiments: false
          - planned_maintenance: false
          - risky_changes: false
        required_approvals:
          - vp-engineering
          - sre-on-call
```

### CI/CD Gate Integration

```bash
#!/bin/bash
# ci-error-budget-gate.sh
# Block deployments when error budget is critically low

PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus.monitoring.svc:9090}"
SERVICE="${1:-myapp}"
THRESHOLD="${2:-5}"  # Minimum percentage remaining

query="slo:error_budget_remaining:ratio{slo=\"${SERVICE}-availability\"} * 100"
budget=$(curl -sf "${PROMETHEUS_URL}/api/v1/query?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${query}'))")" \
  | jq -r '.data.result[0].value[1]' 2>/dev/null)

if [ -z "$budget" ] || [ "$budget" = "null" ]; then
  echo "WARNING: Could not fetch error budget. Allowing deployment."
  exit 0
fi

budget_int=$(echo "$budget" | awk '{printf "%d", $1}')
echo "Current error budget remaining: ${budget_int}%"

if [ "$budget_int" -lt "$THRESHOLD" ]; then
  echo "BLOCKED: Error budget below ${THRESHOLD}% threshold (current: ${budget_int}%)"
  echo "To override: get approval from SRE and set OVERRIDE_ERROR_BUDGET=true"

  if [ "${OVERRIDE_ERROR_BUDGET}" = "true" ]; then
    echo "Override active. Proceeding with deployment."
    exit 0
  fi

  exit 1
fi

echo "Error budget check passed: ${budget_int}% remaining (threshold: ${THRESHOLD}%)"
exit 0
```

## Toil Reduction with Error Budget Policies

Error budgets quantify the cost of toil. If manual operations consume more error budget than incidents, that's evidence the toil is a systemic problem worth automating:

```promql
# Track deployment frequency vs error budget consumption
# More deployments = potentially higher error budget consumption
increase(deployment_events_total{env="production"}[30d])

# Track manual interventions that consume error budget
increase(incident_response_total{service="myapp"}[30d])

# Correlate: what fraction of error budget consumption is due to deployments?
increase(http_requests_total{job="myapp", code=~"5..", deploy_reason="deployment"}[30d])
/
increase(http_requests_total{job="myapp", code=~"5.."}[30d])
```

## Alertmanager Routing for SLO Alerts

Route SLO alerts to the right teams with appropriate urgency:

```yaml
# alertmanager-slo-routing.yaml
route:
  receiver: default
  group_by: ['alertname', 'slo']
  routes:
    # Critical SLO burn alerts → PagerDuty
    - match:
        severity: critical
        page: "true"
      receiver: pagerduty-critical
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 1h

    # Warning SLO alerts → Slack ticket channel
    - match:
        severity: warning
        category: availability
      receiver: slack-slo-tickets
      group_wait: 5m
      group_interval: 30m
      repeat_interval: 8h

    # Budget exhaustion → all channels
    - match:
        alertname: SLOErrorBudgetCritical
      receiver: all-channels
      group_wait: 0s
      repeat_interval: 30m

receivers:
  - name: pagerduty-critical
    pagerduty_configs:
      - service_key: "${PAGERDUTY_SERVICE_KEY}"
        description: "{{ range .Alerts }}{{ .Annotations.summary }}{{ end }}"
        severity: "{{ .CommonLabels.severity }}"
        details:
          slo: "{{ .CommonLabels.slo }}"
          runbook: "{{ .CommonAnnotations.runbook_url }}"
          dashboard: "{{ .CommonAnnotations.dashboard_url }}"

  - name: slack-slo-tickets
    slack_configs:
      - api_url: "${SLACK_WEBHOOK_URL}"
        channel: "#slo-tickets"
        title: "SLO Alert: {{ .CommonLabels.alertname }}"
        text: |
          *Service*: {{ .CommonLabels.slo }}
          *Description*: {{ .CommonAnnotations.description }}
          *Dashboard*: {{ .CommonAnnotations.dashboard_url }}
```

## Validating SLO Definitions

Before deploying SLO rules, validate the queries return sensible results:

```bash
# Check recording rules return non-null values
promtool query instant http://localhost:9090 \
  'slo:sli_error:ratio_rate5m{slo="myapp-availability"}'

# Verify alert expressions evaluate correctly (without firing)
promtool check rules slo-recording-rules.yaml
promtool check rules slo-alerting-rules.yaml

# Test alert thresholds by simulating error rates
# (inject errors via a chaos engineering tool or by checking historical incident data)
promtool query range \
  --start="$(date -d '30 days ago' +%s)" \
  --end="$(date +%s)" \
  --step=300 \
  http://localhost:9090 \
  'slo:error_budget_remaining:ratio{slo="myapp-availability"}'
```

## Summary

SLO-based alerting replaces arbitrary thresholds with user-impact-correlated signals. The multi-window, multi-burn-rate approach—originally from the Google SRE Workbook—eliminates both false positives (brief spikes that don't threaten the budget) and false negatives (sustained slow burns that cumulatively exceed the budget). Sloth and Pyrra automate the mechanical recording rule and alert rule generation from high-level SLO definitions, while error budget policies provide a clear framework for when to slow down deployments versus when to prioritize reliability work.
