---
title: "Kubernetes SRE: Error Budgets, SLOs, and Reliability Engineering at Scale"
date: 2027-07-30T00:00:00-05:00
draft: false
tags: ["SRE", "Kubernetes", "SLO", "Error Budget", "Reliability"]
categories:
- SRE
- Kubernetes
- Reliability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing Site Reliability Engineering practices in Kubernetes environments, covering SLO definition, error budget calculation, SLI instrumentation, burn rate alerting, toil reduction, and SLO management with Sloth and Pyrra."
more_link: "yes"
url: "/kubernetes-sre-error-budgets-slo-guide/"
---

Site Reliability Engineering transforms abstract availability requirements into measurable, actionable contracts between engineering teams and their stakeholders. In Kubernetes environments, where distributed systems introduce compounding failure modes, disciplined SLO management separates reactive firefighting from proactive reliability investment. This guide provides a production-grade playbook for defining SLIs, calculating error budgets, instrumenting burn-rate alerts, eliminating toil, and building the organizational feedback loops that continuously improve reliability.

<!--more-->

# [Kubernetes SRE: Error Budgets, SLOs, and Reliability Engineering at Scale](#kubernetes-sre-error-budgets-slo-guide)

## Section 1: SLO Foundations — Definitions and Measurement Strategy

### Service Level Indicators

An SLI is a quantitative measure of some aspect of the service. Kubernetes workloads expose three primary SLI categories:

- **Availability SLI**: The fraction of requests that were served successfully.
- **Latency SLI**: The fraction of requests that completed within a defined threshold.
- **Saturation SLI**: The fraction of capacity currently consumed.

Each SLI requires a precise measurement window, a valid/invalid request definition, and a data source. Prometheus is the canonical data source for Kubernetes SLIs.

### Availability SLI — Prometheus Recording Rule

```yaml
# prometheus-rules/sli-availability.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: sli-availability-api
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: sli.availability
    interval: 30s
    rules:
    # 5-minute error ratio (good events / total events)
    - record: sli:api_requests:error_ratio5m
      expr: |
        sum(rate(http_requests_total{job="api-server", code=~"5.."}[5m]))
        /
        sum(rate(http_requests_total{job="api-server"}[5m]))

    # 30-day availability
    - record: sli:api_requests:availability30d
      expr: |
        1 - (
          sum(increase(http_requests_total{job="api-server", code=~"5.."}[30d]))
          /
          sum(increase(http_requests_total{job="api-server"}[30d]))
        )
```

### Latency SLI — Histogram-Based Measurement

```yaml
# prometheus-rules/sli-latency.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: sli-latency-api
  namespace: monitoring
spec:
  groups:
  - name: sli.latency
    interval: 30s
    rules:
    # Good requests: latency <= 300ms
    - record: sli:api_latency:good_ratio5m
      expr: |
        sum(rate(http_request_duration_seconds_bucket{
          job="api-server",
          le="0.3"
        }[5m]))
        /
        sum(rate(http_request_duration_seconds_count{job="api-server"}[5m]))

    # p99 latency over 5 minutes
    - record: sli:api_latency:p99_5m
      expr: |
        histogram_quantile(0.99,
          sum by (le) (
            rate(http_request_duration_seconds_bucket{job="api-server"}[5m])
          )
        )
```

### Saturation SLI

```yaml
# prometheus-rules/sli-saturation.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: sli-saturation-api
  namespace: monitoring
spec:
  groups:
  - name: sli.saturation
    interval: 30s
    rules:
    # CPU saturation: fraction of request limit consumed
    - record: sli:api_cpu:saturation5m
      expr: |
        sum(
          rate(container_cpu_usage_seconds_total{
            namespace="production",
            container="api-server"
          }[5m])
        )
        /
        sum(
          kube_pod_container_resource_limits{
            namespace="production",
            container="api-server",
            resource="cpu"
          }
        )

    # Memory saturation
    - record: sli:api_memory:saturation
      expr: |
        sum(
          container_memory_working_set_bytes{
            namespace="production",
            container="api-server"
          }
        )
        /
        sum(
          kube_pod_container_resource_limits{
            namespace="production",
            container="api-server",
            resource="memory"
          }
        )
```

---

## Section 2: SLO Definition and Error Budget Calculation

### SLO Configuration in Code

SLOs should live in version-controlled YAML, not in dashboard UI click-throughs. The following pattern treats SLOs as Kubernetes custom resources.

```yaml
# slo/api-server-slo.yaml
# Compatible with Sloth and Pyrra CRDs
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: api-server-availability
  namespace: monitoring
  labels:
    team: platform
    service: api-server
spec:
  service: api-server
  labels:
    team: platform
    env: production
  slos:
  - name: requests-availability
    objective: 99.9
    description: "99.9% of API requests must succeed (non-5xx)"
    sli:
      events:
        errorQuery: |
          sum(rate(http_requests_total{job="api-server", code=~"5.."}[{{.window}}]))
        totalQuery: |
          sum(rate(http_requests_total{job="api-server"}[{{.window}}]))
    alerting:
      name: ApiServerHighErrorRate
      labels:
        category: availability
        severity: critical
      annotations:
        summary: "API server availability SLO burn rate is too high"
        runbook: "https://runbooks.support.tools/api-server-availability"
      pageAlert:
        labels:
          severity: critical
      ticketAlert:
        labels:
          severity: warning

  - name: requests-latency
    objective: 99.5
    description: "99.5% of API requests must complete within 300ms"
    sli:
      events:
        errorQuery: |
          sum(rate(http_request_duration_seconds_bucket{
            job="api-server", le="0.3"
          }[{{.window}}]))
        totalQuery: |
          sum(rate(http_request_duration_seconds_count{job="api-server"}[{{.window}}]))
    alerting:
      name: ApiServerHighLatency
      labels:
        category: latency
      pageAlert:
        labels:
          severity: critical
      ticketAlert:
        labels:
          severity: warning
```

### Error Budget Mathematics

Given an SLO target `T` and a window `W` (typically 30 days):

```
Total requests in window = R
Allowed failures = R × (1 - T)
Error budget (minutes) = W_minutes × (1 - T)
```

For a 99.9% availability SLO over 30 days:

```
Error budget = 30 × 24 × 60 × (1 - 0.999)
             = 43,200 × 0.001
             = 43.2 minutes per month
```

Prometheus recording rules for real-time budget tracking:

```yaml
# prometheus-rules/error-budget.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: error-budget-api
  namespace: monitoring
spec:
  groups:
  - name: error.budget
    interval: 5m
    rules:
    # Budget consumed fraction (0=none consumed, 1=fully consumed)
    - record: slo:api_availability:error_budget_consumed
      expr: |
        1 - (
          (1 - sli:api_requests:availability30d)
          /
          (1 - 0.999)
        )

    # Budget remaining in minutes
    - record: slo:api_availability:error_budget_remaining_minutes
      expr: |
        (1 - slo:api_availability:error_budget_consumed)
        * 43.2

    # Rate of budget consumption (budget burn rate)
    - record: slo:api_availability:burn_rate1h
      expr: |
        sum(rate(http_requests_total{job="api-server", code=~"5.."}[1h]))
        /
        (sum(rate(http_requests_total{job="api-server"}[1h])) * (1 - 0.999))
```

---

## Section 3: Burn Rate Alerts

Burn rate alerts are the practical operationalization of error budgets. A burn rate of 1 means the budget is consumed at exactly the rate that would exhaust it over the window. A burn rate of 14.4 means the budget would be exhausted in 2 hours.

### Multi-Window Multi-Burn-Rate Alert Pattern

The Google SRE Workbook recommends alerting on two independent time windows to balance precision and recall.

```yaml
# prometheus-rules/burn-rate-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-burn-rate-api
  namespace: monitoring
spec:
  groups:
  - name: slo.burn_rate
    rules:
    # Page immediately: 2% budget consumed in 1 hour (burn rate 14.4x)
    - alert: ApiAvailabilityBurnRateCritical
      expr: |
        (
          slo:api_availability:burn_rate1h > 14.4
          and
          slo:api_availability:burn_rate5m > 14.4
        )
      for: 2m
      labels:
        severity: critical
        slo: api-availability
        burn_rate_window: "1h"
      annotations:
        summary: "Critical burn rate: exhausting error budget in < 2h"
        description: |
          Current burn rate is {{ $value | humanizePercentage }} of budget per hour.
          At this rate the 30-day budget will be exhausted in
          {{ printf "%.1f" (div 43.2 $value) }} minutes.
        runbook: "https://runbooks.support.tools/api-server-availability"

    # Page: 5% budget consumed in 6 hours (burn rate 6x)
    - alert: ApiAvailabilityBurnRateHigh
      expr: |
        (
          slo:api_availability:burn_rate6h > 6
          and
          slo:api_availability:burn_rate30m > 6
        )
      for: 15m
      labels:
        severity: critical
        slo: api-availability
        burn_rate_window: "6h"
      annotations:
        summary: "High burn rate: exhausting error budget in < 6h"
        description: |
          Current burn rate is {{ $value | humanizePercentage }} of budget per hour.
        runbook: "https://runbooks.support.tools/api-server-availability"

    # Ticket: 10% budget consumed in 3 days (burn rate 1x)
    - alert: ApiAvailabilityBurnRateLow
      expr: |
        slo:api_availability:burn_rate3d > 1
      for: 1h
      labels:
        severity: warning
        slo: api-availability
        burn_rate_window: "3d"
      annotations:
        summary: "Budget burning at baseline: track closely"

    # Exhaustion warning
    - alert: ApiAvailabilityBudgetExhausted
      expr: slo:api_availability:error_budget_consumed > 0.95
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Error budget >95% consumed — feature freeze recommended"
```

### Burn Rate Recording Rules for Extended Windows

```yaml
# prometheus-rules/burn-rate-windows.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-burn-rate-windows
  namespace: monitoring
spec:
  groups:
  - name: slo.burn_rate.windows
    interval: 30s
    rules:
    - record: slo:api_availability:burn_rate5m
      expr: |
        sum(rate(http_requests_total{job="api-server", code=~"5.."}[5m]))
        / (sum(rate(http_requests_total{job="api-server"}[5m])) * 0.001)

    - record: slo:api_availability:burn_rate30m
      expr: |
        sum(rate(http_requests_total{job="api-server", code=~"5.."}[30m]))
        / (sum(rate(http_requests_total{job="api-server"}[30m])) * 0.001)

    - record: slo:api_availability:burn_rate1h
      expr: |
        sum(rate(http_requests_total{job="api-server", code=~"5.."}[1h]))
        / (sum(rate(http_requests_total{job="api-server"}[1h])) * 0.001)

    - record: slo:api_availability:burn_rate6h
      expr: |
        sum(rate(http_requests_total{job="api-server", code=~"5.."}[6h]))
        / (sum(rate(http_requests_total{job="api-server"}[6h])) * 0.001)

    - record: slo:api_availability:burn_rate3d
      expr: |
        sum(rate(http_requests_total{job="api-server", code=~"5.."}[3d]))
        / (sum(rate(http_requests_total{job="api-server"}[3d])) * 0.001)
```

---

## Section 4: SLO Management with Sloth and Pyrra

### Sloth Installation

```bash
# Install Sloth CLI
curl -Lo /usr/local/bin/sloth \
  https://github.com/slok/sloth/releases/latest/download/sloth-linux-amd64
chmod +x /usr/local/bin/sloth

# Install Sloth operator
helm repo add sloth https://slok.github.io/sloth
helm repo update
helm upgrade --install sloth sloth/sloth \
  --namespace monitoring \
  --set commonFlags.featureFlags.disableRecordingsOptimization=false \
  --set commonFlags.labelSelector="app.kubernetes.io/managed-by=sloth"
```

### Sloth SLO Generation

```bash
# Generate Prometheus rules from SLO spec
sloth generate \
  --input slo/api-server-slo.yaml \
  --output manifests/prometheus-rules/

# Validate generated rules
promtool check rules manifests/prometheus-rules/sloth-slo-api-server-availability.yaml
```

### Pyrra for SLO Dashboards

```bash
# Install Pyrra
helm repo add pyrra https://pyrra-dev.github.io/pyrra
helm upgrade --install pyrra pyrra/pyrra \
  --namespace monitoring \
  --set apiserver.image.tag=v0.7.0 \
  --set filesystem.image.tag=v0.7.0 \
  --set prometheusUrl=http://prometheus-operated.monitoring.svc.cluster.local:9090
```

```yaml
# pyrra/servicelevelobjective.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: api-server-availability
  namespace: monitoring
  labels:
    pyrra.dev/team: platform
spec:
  target: "99.9"
  window: 30d
  description: "API server availability"
  indicator:
    ratio:
      errors:
        metric: http_requests_total{job="api-server",code=~"5.."}
      total:
        metric: http_requests_total{job="api-server"}
      grouping:
      - namespace
```

---

## Section 5: Toil Measurement and Elimination

### Defining Toil

Toil is manual, repetitive, automatable work that scales with service growth and provides no lasting value. Common Kubernetes toil categories include:

| Toil Category | Example | Elimination Strategy |
|---|---|---|
| Manual restarts | `kubectl rollout restart` due to memory leaks | VPA, memory leak fix |
| Certificate rotation | Manual cert renewals | cert-manager auto-rotation |
| Scaling events | Manual `kubectl scale` during traffic spikes | HPA/KEDA |
| Log triage | Manual grep across pods | Structured logging + Loki queries |
| Secret rotation | Manual `kubectl create secret` updates | External Secrets Operator |

### Toil Tracking with Prometheus

Instrument toil events as Prometheus metrics via a sidecar or custom exporter.

```go
// toil-exporter/main.go
package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	toilEventsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "sre_toil_events_total",
			Help: "Total number of toil events by category",
		},
		[]string{"category", "team", "automated"},
	)

	toilDurationSeconds = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "sre_toil_duration_seconds",
			Help:    "Time spent on toil events",
			Buckets: prometheus.ExponentialBuckets(60, 2, 10),
		},
		[]string{"category", "team"},
	)
)

func main() {
	http.Handle("/metrics", promhttp.Handler())
	http.ListenAndServe(":9091", nil)
}
```

### Toil Ratio Alert

```yaml
# prometheus-rules/toil.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: toil-ratio
  namespace: monitoring
spec:
  groups:
  - name: sre.toil
    rules:
    # Alert when toil exceeds 50% of engineering time
    - alert: ToilRatioHigh
      expr: |
        sum(increase(sre_toil_duration_seconds[7d])) by (team)
        /
        (7 * 24 * 3600 * on(team) group_left() kube_team_engineer_count)
        > 0.50
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Team {{ $labels.team }} toil ratio exceeds 50%"
        description: |
          Toil is consuming {{ $value | humanizePercentage }} of engineering
          capacity for team {{ $labels.team }} over the past 7 days.
```

---

## Section 6: SLO Dashboards with Grafana

### Error Budget Dashboard JSON (Partial)

```json
{
  "title": "SLO Error Budget Dashboard",
  "uid": "slo-error-budget",
  "panels": [
    {
      "title": "Error Budget Remaining",
      "type": "gauge",
      "gridPos": {"h": 8, "w": 6, "x": 0, "y": 0},
      "targets": [
        {
          "expr": "(1 - slo:api_availability:error_budget_consumed) * 100",
          "legendFormat": "Budget Remaining %"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "min": 0,
          "max": 100,
          "thresholds": {
            "steps": [
              {"value": 0,  "color": "red"},
              {"value": 25, "color": "orange"},
              {"value": 50, "color": "yellow"},
              {"value": 75, "color": "green"}
            ]
          }
        }
      }
    },
    {
      "title": "Burn Rate (1h)",
      "type": "stat",
      "gridPos": {"h": 4, "w": 6, "x": 6, "y": 0},
      "targets": [
        {
          "expr": "slo:api_availability:burn_rate1h",
          "legendFormat": "1h Burn Rate"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "steps": [
              {"value": 0,    "color": "green"},
              {"value": 6,    "color": "orange"},
              {"value": 14.4, "color": "red"}
            ]
          }
        }
      }
    }
  ]
}
```

### Provisioning the Dashboard via ConfigMap

```yaml
# grafana-dashboards/slo-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboard-slo
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  slo-error-budget.json: |
    {
      "title": "SLO Error Budget Dashboard",
      "uid": "slo-error-budget",
      "refresh": "1m",
      "panels": []
    }
```

---

## Section 7: Customer Reliability Engineering (CRE)

CRE extends SRE practices outward to encompass the customer's perspective. The core principle: customers set their own SLOs for their own systems, and the platform must provide sufficient observability for customers to measure those SLOs.

### CRE Tenant SLO Pattern

```yaml
# Multi-tenant SLO: each customer namespace has independent SLOs
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: tenant-api-availability
  namespace: monitoring
  labels:
    tenant: acme-corp
spec:
  service: tenant-api
  labels:
    tenant: acme-corp
  slos:
  - name: tenant-requests-availability
    objective: 99.95
    description: "Tenant ACME Corp availability SLO"
    sli:
      events:
        errorQuery: |
          sum(rate(http_requests_total{
            job="tenant-api",
            tenant="acme-corp",
            code=~"5.."
          }[{{.window}}]))
        totalQuery: |
          sum(rate(http_requests_total{
            job="tenant-api",
            tenant="acme-corp"
          }[{{.window}}]))
    alerting:
      name: TenantAcmeCorpHighErrorRate
      labels:
        tenant: acme-corp
        severity: critical
```

---

## Section 8: Error Budget Policy Enforcement

### Policy Document Template

```markdown
# Error Budget Policy — API Server

## Budget Allocation
- Monthly window: 43.2 minutes downtime
- Critical path services: 90% of budget is protected

## Policy Actions by Consumption Level

| Budget Consumed | Policy Action |
|---|---|
| 0–25% | Normal operations; feature releases allowed |
| 25–50% | Increase deployment risk review; slow rollouts |
| 50–75% | No new features; focus on reliability improvements |
| 75–95% | Feature freeze; SRE prioritizes reliability work |
| >95% | Full incident response posture; exec visibility |

## Automation Triggers
```

### Budget Policy as OPA Admission Webhook

```rego
# opa/slo-budget-policy.rego
package kubernetes.admission

import future.keywords.if

# Block deployments when error budget is critically low
deny[msg] if {
  input.request.kind.kind == "Deployment"
  input.request.namespace == "production"
  input.request.operation == "CREATE"

  # Check budget status via external data
  budget_consumed := data.slo["api-availability"]["budget_consumed"]
  budget_consumed > 0.95

  msg := sprintf(
    "Deployment blocked: error budget is %.1f%% consumed. Budget policy requires recovery before new deployments.",
    [budget_consumed * 100]
  )
}
```

```yaml
# opa/slo-budget-webhook.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: slo-budget-policy
webhooks:
- name: slo-budget.support.tools
  admissionReviewVersions: ["v1"]
  clientConfig:
    service:
      name: opa
      namespace: opa
      path: /v1/data/kubernetes/admission
  rules:
  - apiGroups: ["apps"]
    apiVersions: ["v1"]
    operations: ["CREATE", "UPDATE"]
    resources: ["deployments"]
    scope: Namespaced
  namespaceSelector:
    matchLabels:
      slo-policy: enforced
  sideEffects: None
  failurePolicy: Ignore
```

---

## Section 9: Post-Mortem Driven Reliability Improvements

### Post-Mortem Reliability Feedback Loop

Every incident that consumes more than 10% of the monthly error budget must produce an action item with an SLO improvement forecast.

```yaml
# post-mortem template (YAML structured)
# incident-postmortems/2027-07-15-api-outage.yaml
incident:
  id: INC-2027-071501
  title: "API server 5xx storm due to misconfigured HPA"
  date: 2027-07-15
  duration_minutes: 22
  budget_consumed_percent: 51
  severity: SEV1
  services_affected:
  - api-server
  - checkout-service

timeline:
- time: "14:02"
  event: "First PagerDuty alert fired (burn rate 14.4x)"
- time: "14:05"
  event: "On-call acknowledged, began triage"
- time: "14:18"
  event: "Root cause identified: HPA scaling delay"
- time: "14:24"
  event: "Mitigation applied: manual scale-out"
- time: "14:35"
  event: "Error rate returned to baseline"

root_cause: >
  HPA scale-up was delayed 8 minutes because stabilizationWindowSeconds
  was set to 600 on the api-server deployment. During a traffic spike,
  the existing pods became CPU-saturated before new pods were provisioned.

contributing_factors:
- "HPA stabilizationWindowSeconds=600 was inappropriately high for stateless API"
- "No pre-scaling based on time-of-day traffic pattern"
- "Load test had not been run post HPA config change"

action_items:
- id: AI-001
  title: "Reduce HPA stabilizationWindowSeconds to 60 for api-server"
  owner: platform-team
  due: 2027-07-22
  slo_improvement_forecast: "Reduces budget consumption by ~40% for this failure mode"
  status: completed

- id: AI-002
  title: "Add KEDA ScaledObject with scheduled pre-scaling for business hours"
  owner: platform-team
  due: 2027-07-29
  slo_improvement_forecast: "Eliminates traffic-spike scaling delay entirely"
  status: in-progress

slo_impact:
  budget_before_percent: 15
  budget_consumed_this_incident_percent: 51
  budget_remaining_percent: 34
  forecast_with_action_items: "AI-001+AI-002 expected to reduce recurrence to <5min"
```

### Action Item Tracking Dashboard Query

```promql
# Track open reliability action items (requires custom exporter)
sum by (team, priority) (
  sre_action_items_total{status="open"}
)
/
sum by (team) (
  sre_action_items_total
)
```

---

## Section 10: Complete SRE Metrics Reference

### Key SRE Metrics to Track

```yaml
# Full SRE metrics recording rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: sre-metrics-complete
  namespace: monitoring
spec:
  groups:
  - name: sre.reliability
    interval: 5m
    rules:
    # MTTR (Mean Time to Recovery) — requires incident duration metric
    - record: sre:mttr:avg30d_minutes
      expr: |
        avg_over_time(sre_incident_duration_minutes[30d])

    # MTTA (Mean Time to Acknowledge)
    - record: sre:mtta:avg30d_minutes
      expr: |
        avg_over_time(sre_incident_ack_duration_minutes[30d])

    # Change failure rate
    - record: sre:change_failure_rate:ratio30d
      expr: |
        sum(increase(deployment_failures_total[30d]))
        /
        sum(increase(deployments_total[30d]))

    # Deployment frequency
    - record: sre:deployment_frequency:daily
      expr: |
        sum(increase(deployments_total[1d]))

    # Toil percentage of engineering time
    - record: sre:toil_percentage:team
      expr: |
        sum by (team) (increase(sre_toil_duration_seconds[7d]))
        /
        (7 * 24 * 3600)
```

---

## Summary

Implementing SRE practices in Kubernetes environments requires disciplined instrumentation, automated alerting, and organizational feedback loops that translate measurements into reliability improvements. The foundational elements are precise SLI definitions backed by Prometheus recording rules, SLO targets encoded as version-controlled custom resources, burn rate alerts that give on-call engineers actionable lead time, and error budget policies that create alignment between feature velocity and reliability investment. Tools like Sloth and Pyrra eliminate the mechanical work of SLO rule generation, while structured post-mortems ensure every error budget expenditure produces lasting reliability improvements. The combination of technical rigor and organizational process creates the foundation for sustainable, scalable reliability engineering.
