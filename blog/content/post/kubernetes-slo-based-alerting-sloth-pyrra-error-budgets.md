---
title: "Kubernetes SLO-Based Alerting with Sloth and Pyrra"
date: 2030-09-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "SLO", "Prometheus", "Alerting", "SRE", "Sloth", "Pyrra", "Observability"]
categories:
- Kubernetes
- Observability
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise SLO alerting guide: burn rate alerts vs threshold alerts, multiwindow multi-burn-rate alerting, Sloth SLO YAML specification, Pyrra SLO management, error budget dashboards in Grafana, and integrating SLOs into incident response."
more_link: "yes"
url: "/kubernetes-slo-based-alerting-sloth-pyrra-error-budgets/"
---

Traditional threshold-based alerting — "alert when error rate exceeds 5%" — generates two failure modes: false positives that desensitize responders when brief spikes trigger alerts for non-impacting events, and false negatives when sustained low-grade degradation consumes the error budget silently. SLO-based alerting with burn rate detection solves both problems: it alerts on significant, sustained degradation that will exhaust the error budget within a predictable timeframe, and it ignores brief spikes that don't meaningfully threaten reliability targets. This guide covers the mathematics of burn rate alerting, Sloth and Pyrra as Kubernetes-native SLO management tools, and production Grafana dashboards for error budget tracking.

<!--more-->

## SLO Fundamentals

### Error Budget Calculation

An SLO defines a target availability over a rolling time window. The error budget is the amount of downtime or error rate the service is allowed to incur while still meeting the SLO:

```
Error Budget = 1 - SLO Target

For 99.9% SLO over 30 days:
Error Budget = 1 - 0.999 = 0.001
Allowed Error Minutes = 0.001 × 30 × 24 × 60 = 43.2 minutes per 30 days

For 99.95% SLO over 30 days:
Error Budget = 0.0005
Allowed Error Minutes = 0.0005 × 30 × 24 × 60 = 21.6 minutes per 30 days
```

### Burn Rate

The burn rate measures how quickly the error budget is being consumed relative to the allowed rate:

```
Burn Rate = actual error rate / target error rate

If SLO = 99.9%, target error rate = 0.1%
If current error rate = 1%, burn rate = 1% / 0.1% = 10x

At burn rate 10x: error budget exhausted in 30d/10 = 3 days
At burn rate 1x: error budget consumed at exactly the SLO limit
At burn rate 0.5x: service is consuming error budget slower than allowed
```

## Threshold vs Burn Rate Alerting

### The Problem with Threshold Alerting

```yaml
# Traditional threshold alert — has both false positive and false negative problems
groups:
  - name: traditional-threshold
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) /
              rate(http_requests_total[5m]) > 0.05  # Alert when >5% errors
        for: 5m
```

**False positive**: A 5-minute spike to 10% errors at 3 AM on a Sunday doesn't warrant waking someone. The error budget impact is negligible.

**False negative**: A steady 0.15% error rate (slightly above 0.1% SLO target) never triggers the alert but will exhaust a 99.9% error budget in 20 days.

### Multiwindow Multi-Burn-Rate Alerting

The Google SRE Book's approach uses two complementary time windows and burn rate thresholds:

```
Fast window (short, high burn rate): Detect acute incidents quickly
Slow window (long, lower burn rate): Detect sustained degradation

Standard configurations:
  Critical: 1h window + 5m window, burn rate ≥ 14.4x (exhausts budget in 2 hours)
  Warning:  6h window + 30m window, burn rate ≥ 6x   (exhausts budget in 5 hours)
  Warning2: 1d window + 2h window, burn rate ≥ 3x    (exhausts budget in 10 days)
  Info:     3d window + 6h window, burn rate ≥ 1x    (slow consumption)
```

The dual-window approach requires the error rate to be elevated in BOTH windows before firing. This eliminates false positives from brief spikes while ensuring immediate detection of sustained high burn rates.

```yaml
# Proper multiwindow multi-burn-rate SLO alert
groups:
  - name: payment-api-slo
    rules:
      # Page immediately: budget will be exhausted in ~2 hours
      - alert: PaymentAPIHighBurnRate
        expr: |
          (
            sum(rate(http_requests_total{job="payment-api",status=~"5.."}[1h]))
            /
            sum(rate(http_requests_total{job="payment-api"}[1h]))
          ) > (14.4 * 0.001)
          and
          (
            sum(rate(http_requests_total{job="payment-api",status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{job="payment-api"}[5m]))
          ) > (14.4 * 0.001)
        labels:
          severity: critical
          slo: payment-api-availability
        annotations:
          summary: "Payment API burning error budget at 14.4x rate"
          description: |
            Current error rate will exhaust the monthly error budget in ~2 hours.
            Error budget remaining: {{ $value | humanizePercentage }}

      # Ticket during business hours: budget exhausted in ~5 hours
      - alert: PaymentAPISlowBurnRate
        expr: |
          (
            sum(rate(http_requests_total{job="payment-api",status=~"5.."}[6h]))
            /
            sum(rate(http_requests_total{job="payment-api"}[6h]))
          ) > (6 * 0.001)
          and
          (
            sum(rate(http_requests_total{job="payment-api",status=~"5.."}[30m]))
            /
            sum(rate(http_requests_total{job="payment-api"}[30m]))
          ) > (6 * 0.001)
        labels:
          severity: warning
          slo: payment-api-availability
        annotations:
          summary: "Payment API burning error budget at 6x rate"
```

## Sloth: Kubernetes-Native SLO Generator

Sloth generates multiwindow multi-burn-rate alerting rules from a simple YAML SLO specification. It eliminates manual calculation errors and standardizes the alerting approach across services.

### Installing Sloth

```bash
# Install Sloth as a Kubernetes controller
helm repo add sloth https://slok.github.io/sloth
helm repo update

helm install sloth sloth/sloth \
  --namespace monitoring \
  --set rbac.create=true \
  --set service.type=ClusterIP
```

### Sloth SLO Specification

```yaml
# payment-api-slo.yaml
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: payment-api
  namespace: monitoring
  labels:
    app: payment-api
    team: platform
spec:
  service: "payment-api"
  labels:
    owner: "payments-team"
    tier: "1"
    env: "production"

  slos:
    # Availability SLO: 99.9% of requests should succeed
    - name: requests-availability
      objective: 99.9
      description: "99.9% of payment API requests should succeed (non-5xx response)"

      sli:
        events:
          errorQuery: |
            sum(rate(http_requests_total{
              job="payment-api",
              status=~"5..",
              endpoint!="/healthz",
              endpoint!="/readyz"
            }[{{.window}}]))
          totalQuery: |
            sum(rate(http_requests_total{
              job="payment-api",
              endpoint!="/healthz",
              endpoint!="/readyz"
            }[{{.window}}]))

      alerting:
        name: PaymentAPIAvailability
        labels:
          category: "availability"
          routing_key: "payments-oncall"
        annotations:
          runbook: "https://runbooks.example.com/payment-api/availability"
        pageAlert:
          labels:
            severity: critical
        ticketAlert:
          labels:
            severity: warning

    # Latency SLO: 99% of requests should complete within 500ms
    - name: requests-latency
      objective: 99.0
      description: "99% of payment API requests should complete within 500ms"

      sli:
        events:
          errorQuery: |
            sum(rate(http_request_duration_seconds_bucket{
              job="payment-api",
              le="0.5",
              endpoint!="/healthz"
            }[{{.window}}]))
          totalQuery: |
            sum(rate(http_request_duration_seconds_count{
              job="payment-api",
              endpoint!="/healthz"
            }[{{.window}}]))

      alerting:
        name: PaymentAPILatency
        labels:
          category: "latency"
          routing_key: "payments-oncall"
        annotations:
          runbook: "https://runbooks.example.com/payment-api/latency"
        pageAlert:
          labels:
            severity: critical
        ticketAlert:
          labels:
            severity: warning
```

Sloth transforms this specification into complete multiwindow multi-burn-rate alerting rules:

```bash
# Generate and preview rules (dry run)
sloth generate \
  --input payment-api-slo.yaml \
  --output /tmp/generated-rules.yaml

cat /tmp/generated-rules.yaml

# Apply to Kubernetes (Sloth controller handles this automatically)
kubectl apply -f payment-api-slo.yaml

# Verify generated PrometheusRule
kubectl get prometheusrule -n monitoring payment-api-payment-api-slo
kubectl describe prometheusrule -n monitoring payment-api-payment-api-slo
```

### Sloth Recording Rules

Sloth generates two categories of recording rules:

```yaml
# Generated by Sloth — do not edit manually
groups:
  # SLI recording rules: standardized metric names for SLO calculation
  - name: sloth-slo-sli-recordings-payment-api-requests-availability
    interval: 30s
    rules:
      # Error ratio over various time windows
      - record: slo:sli_error:ratio_rate5m
        expr: |
          (sum(rate(http_requests_total{job="payment-api",status=~"5.."}[5m])))
          /
          (sum(rate(http_requests_total{job="payment-api"}[5m])))
        labels:
          slo: "payment-api"
          slo_version: "1"

      - record: slo:sli_error:ratio_rate30m
        expr: |
          (sum(rate(http_requests_total{job="payment-api",status=~"5.."}[30m])))
          /
          (sum(rate(http_requests_total{job="payment-api"}[30m])))
        labels:
          slo: "payment-api"

      # ... similar rules for 1h, 2h, 6h, 1d, 3d windows

  # SLO metadata recording rules: for dashboard use
  - name: sloth-slo-meta-recordings-payment-api-requests-availability
    interval: 5m
    rules:
      - record: slo:objective:ratio
        expr: "vector(0.99900)"
        labels:
          slo: "payment-api"

      - record: slo:error_budget:ratio
        expr: "vector(1-0.99900)"
        labels:
          slo: "payment-api"
```

## Pyrra: SLO Management with a Built-In UI

Pyrra provides both the recording/alerting rule generation that Sloth offers, plus a web UI for visualizing error budgets and SLO status.

### Installing Pyrra

```bash
helm repo add pyrra https://pyrra-dev.github.io/pyrra
helm repo update

helm install pyrra pyrra/pyrra \
  --namespace monitoring \
  --set image.tag=v0.7.0 \
  --set apiServer=http://prometheus:9090 \
  --set prometheusURL=http://prometheus:9090
```

### Pyrra SLO Specification

```yaml
# pyrra-payment-api-slo.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: payment-api-availability
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  target: "99.9"
  window: 4w  # 28 days rolling window

  serviceLevel:
    metrics:
      - type: http
        http:
          selector: 'job="payment-api"'
          # Requests matching this selector count as errors
          errors:
            selector: 'status=~"5.."'
```

```yaml
# pyrra-payment-api-latency.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: payment-api-latency
  namespace: monitoring
spec:
  target: "99"
  window: 4w

  serviceLevel:
    metrics:
      - type: http
        http:
          selector: 'job="payment-api"'
          # Use histogram latency SLI
          # Requests slower than 500ms count as errors
          latency:
            target: 500ms
```

### Accessing the Pyrra UI

```bash
# Port-forward the Pyrra UI
kubectl port-forward -n monitoring svc/pyrra 9099:9099

# Access at http://localhost:9099
# The UI shows:
# - Current error budget remaining (percentage and absolute time)
# - Burn rate over different time windows
# - SLO compliance history
# - Alert status (page/ticket/none)
```

## Error Budget Dashboards in Grafana

### Error Budget Panel

```json
{
  "type": "gauge",
  "title": "Error Budget Remaining",
  "datasource": "Prometheus",
  "targets": [
    {
      "expr": "1 - (sum_over_time(slo:sli_error:ratio_rate5m{slo=\"payment-api\"}[30d]) / count_over_time(slo:sli_error:ratio_rate5m{slo=\"payment-api\"}[30d])) / slo:error_budget:ratio{slo=\"payment-api\"}",
      "legendFormat": "Error Budget %"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "percentunit",
      "min": 0,
      "max": 1,
      "thresholds": {
        "steps": [
          {"color": "red", "value": 0},
          {"color": "yellow", "value": 0.25},
          {"color": "green", "value": 0.5}
        ]
      }
    }
  }
}
```

### Burn Rate Over Time Panel

```promql
# Current burn rate compared to target
# Value = 1 means consuming budget at exactly the right pace
# Value > 1 means burning budget faster than allowed
(
  sum(rate(http_requests_total{job="payment-api",status=~"5.."}[1h]))
  /
  sum(rate(http_requests_total{job="payment-api"}[1h]))
) / 0.001  # Divide by target error rate (0.1% = 0.001)
```

### Complete Grafana Dashboard JSON

```json
{
  "title": "SLO Dashboard: Payment API",
  "uid": "payment-api-slo",
  "panels": [
    {
      "gridPos": {"x": 0, "y": 0, "w": 6, "h": 4},
      "title": "Current SLO Compliance",
      "type": "stat",
      "targets": [{
        "expr": "1 - sum_over_time(slo:sli_error:ratio_rate5m{slo=\"payment-api\"}[30d]) / count_over_time(slo:sli_error:ratio_rate5m{slo=\"payment-api\"}[30d])",
        "legendFormat": "Availability"
      }],
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "decimals": 3,
          "thresholds": {
            "steps": [
              {"color": "red", "value": 0},
              {"color": "yellow", "value": 0.999},
              {"color": "green", "value": 0.9995}
            ]
          }
        }
      }
    },
    {
      "gridPos": {"x": 6, "y": 0, "w": 6, "h": 4},
      "title": "Error Budget Remaining (30d)",
      "type": "gauge",
      "targets": [{
        "expr": "1 - (sum(increase(http_requests_total{job=\"payment-api\",status=~\"5..\"}[30d])) / sum(increase(http_requests_total{job=\"payment-api\"}[30d]))) / (1 - 0.999)",
        "legendFormat": "Budget %"
      }]
    },
    {
      "gridPos": {"x": 0, "y": 4, "w": 24, "h": 8},
      "title": "Burn Rate (1h/6h/1d windows)",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum(rate(http_requests_total{job=\"payment-api\",status=~\"5..\"}[1h])) / sum(rate(http_requests_total{job=\"payment-api\"}[1h])) / 0.001",
          "legendFormat": "1h burn rate"
        },
        {
          "expr": "sum(rate(http_requests_total{job=\"payment-api\",status=~\"5..\"}[6h])) / sum(rate(http_requests_total{job=\"payment-api\"}[6h])) / 0.001",
          "legendFormat": "6h burn rate"
        },
        {
          "expr": "sum(rate(http_requests_total{job=\"payment-api\",status=~\"5..\"}[1d])) / sum(rate(http_requests_total{job=\"payment-api\"}[1d])) / 0.001",
          "legendFormat": "1d burn rate"
        }
      ],
      "fieldConfig": {
        "overrides": [
          {
            "matcher": {"id": "byName", "options": "1h burn rate"},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]
          }
        ],
        "defaults": {
          "custom": {
            "thresholdsStyle": {"mode": "area"}
          },
          "thresholds": {
            "steps": [
              {"color": "green", "value": 0},
              {"color": "yellow", "value": 6},
              {"color": "red", "value": 14.4}
            ]
          }
        }
      }
    }
  ]
}
```

## Integrating SLOs into Incident Response

### Alertmanager Routing for SLO Alerts

```yaml
# alertmanager-config.yaml
route:
  receiver: default
  routes:
    # Critical SLO alerts (page immediately)
    - match:
        severity: critical
        category: availability
      receiver: slo-critical-pagerduty
      repeat_interval: 1h
      continue: false

    # SLO warning alerts (create ticket)
    - match:
        severity: warning
        category: availability
      receiver: slo-warning-jira
      repeat_interval: 4h
      group_wait: 30m  # Wait 30 minutes to batch related alerts
      continue: false

receivers:
  - name: slo-critical-pagerduty
    pagerduty_configs:
      - routing_key: <pd-routing-key-placeholder>
        description: |
          SLO Alert: {{ .GroupLabels.alertname }}
          Service: {{ .GroupLabels.slo }}
          Burn Rate: {{ .CommonAnnotations.description }}
        details:
          runbook: "{{ .CommonAnnotations.runbook }}"
          error_budget: "{{ .CommonAnnotations.error_budget }}"

  - name: slo-warning-jira
    webhook_configs:
      - url: "http://alertmanager-jira-bridge/webhook"
        send_resolved: true
```

### SLO-Aware Incident Severity Classification

```yaml
# Define incident severity based on error budget burn rate
# This prevents alert fatigue by surfacing only meaningful events

# Severity P1 (page now): Burn rate ≥ 14.4x (budget exhausted in 2 hours)
# Severity P2 (page soon): Burn rate ≥ 6x (budget exhausted in 5 hours)
# Severity P3 (ticket): Burn rate ≥ 3x (budget exhausted in 10 days)
# Severity P4 (monitor): Burn rate ≥ 1x (budget consuming at limit)

groups:
  - name: slo-severity-classification
    rules:
      # Error budget burn rate — pre-computed for dashboard use
      - record: slo:burn_rate:ratio_rate1h
        expr: |
          sum by (slo) (
            rate(http_requests_total{status=~"5.."}[1h])
          )
          /
          sum by (slo) (
            rate(http_requests_total[1h])
          )
          /
          on(slo) group_left slo:error_budget:ratio

      # Remaining error budget as a fraction
      - record: slo:error_budget_remaining:ratio
        expr: |
          1 - (
            sum_over_time(slo:sli_error:ratio_rate5m[30d]) /
            count_over_time(slo:sli_error:ratio_rate5m[30d])
          ) / on() group_left slo:error_budget:ratio
```

### Runbook Integration

SLO alerts should link directly to runbooks that include:

1. **Context**: Which SLO is affected, current burn rate, estimated time to exhaustion
2. **Immediate diagnosis**: Commands to run first
3. **Common causes**: Ordered by frequency for the specific service
4. **Mitigation procedures**: Ordered by impact (most impactful first)

```markdown
# Runbook: Payment API Availability SLO Alert

## Context
This alert fires when the Payment API is burning its error budget faster than
the allowed rate. A 14.4x burn rate means the monthly error budget (43.2 minutes)
will be exhausted in approximately 2 hours.

## Immediate Diagnosis

```bash
# Check current error rate and top error types
kubectl logs -n payments -l app=payment-api --since=15m | \
  grep -E '"status":"5[0-9]{2}"' | \
  jq -r '.status' | sort | uniq -c | sort -rn

# Check pod health
kubectl get pods -n payments -l app=payment-api
kubectl describe pods -n payments -l app=payment-api | grep -A5 "Events:"

# Check upstream dependencies
kubectl exec -n payments deployment/payment-api -- \
  curl -s http://postgres-primary:5432/health
```

## Common Causes

1. **Database connection pool exhaustion** (most common)
   - Symptom: Error logs contain "connection pool exhausted"
   - Fix: Increase `DB_MAX_CONNECTIONS` or investigate connection leaks

2. **Downstream service timeout**
   - Symptom: Errors cluster around specific payment methods
   - Fix: Check payment gateway health, apply circuit breaker

3. **Memory pressure causing GC pauses**
   - Symptom: High latency AND errors, pod memory near limit
   - Fix: Trigger rolling restart, review memory limits
```

## Recording Rules for Long-Range Analysis

```yaml
groups:
  - name: slo-analysis-recording-rules
    interval: 5m
    rules:
      # Daily error budget consumption rate
      - record: slo:daily_error_budget_consumed:ratio
        expr: |
          sum_over_time(slo:sli_error:ratio_rate5m{slo="payment-api"}[24h]) /
          count_over_time(slo:sli_error:ratio_rate5m{slo="payment-api"}[24h]) /
          scalar(slo:error_budget:ratio{slo="payment-api"})

      # Forecast: days until error budget exhaustion at current burn rate
      - record: slo:days_until_budget_exhausted:forecast
        expr: |
          (
            1 - (
              sum_over_time(slo:sli_error:ratio_rate5m{slo="payment-api"}[30d]) /
              count_over_time(slo:sli_error:ratio_rate5m{slo="payment-api"}[30d])
            ) / scalar(slo:error_budget:ratio{slo="payment-api"})
          ) * 30
          /
          scalar(slo:burn_rate:ratio_rate1h{slo="payment-api"})
```

## Summary

SLO-based alerting provides fundamentally better signal quality than threshold-based alerting:

1. **Multiwindow multi-burn-rate alerting** eliminates false positives (brief spikes) and false negatives (sustained slow degradation) simultaneously

2. **Sloth** generates production-quality alerting rules from simple SLO YAML specifications, eliminating manual calculation errors and standardizing the approach across teams

3. **Pyrra** extends Sloth's rule generation with a visual UI for error budget consumption, making SLO health accessible to non-Prometheus users

4. **Error budget dashboards** in Grafana visualize the three key metrics: current SLO compliance, error budget remaining, and burn rate over multiple windows

5. **Alertmanager routing** separates critical SLO alerts (page immediately) from warning alerts (create ticket), reducing on-call burden while ensuring meaningful incidents receive immediate attention

6. **Incident severity classification** based on time-to-budget-exhaustion provides a principled framework for prioritizing incident response across multiple simultaneous SLO alerts
