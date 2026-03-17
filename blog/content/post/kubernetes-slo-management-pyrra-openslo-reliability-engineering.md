---
title: "Kubernetes SLO Management with Pyrra and OpenSLO: Reliability Engineering Automation"
date: 2030-01-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "SLO", "SRE", "Pyrra", "OpenSLO", "Prometheus", "Reliability Engineering"]
categories: ["Kubernetes", "Observability", "SRE"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Implementing SLOs with the Pyrra operator, OpenSLO specification for multi-tool compatibility, alerting from SLOs, and automated error budget burn rate alerts for Kubernetes reliability engineering."
more_link: "yes"
url: "/kubernetes-slo-management-pyrra-openslo-reliability-engineering/"
---

Service Level Objectives (SLOs) are the contract between your engineering team and your users. They define the acceptable level of unreliability — not zero, because zero reliability is both impossible and prohibitively expensive. The error budget derived from an SLO is what gives your team permission to deploy new features without risking the relationship with users: as long as you stay within budget, you can move fast.

The challenge is implementing SLOs rigorously. Ad-hoc uptime dashboards and alert thresholds do not give you the structured error budget accounting that makes SLOs actionable. This guide covers building a complete SLO management system using Pyrra (a Kubernetes operator for SLO management) and the OpenSLO specification for cross-tool portability.

<!--more-->

# Kubernetes SLO Management with Pyrra and OpenSLO: Reliability Engineering Automation

## SLO Fundamentals

Before building the tooling, establishing clear definitions is essential for consistent implementation:

**Service Level Indicator (SLI)**: A quantitative measure of service behavior. Examples:
- Request latency at the 99th percentile
- Error rate (5xx responses / total requests)
- Availability (successful health checks / total checks)

**Service Level Objective (SLO)**: A target value for an SLI over a time window. Examples:
- 99.9% of requests served in under 200ms (30-day rolling window)
- Error rate below 0.1% (30-day rolling window)
- 99.95% availability (30-day rolling window)

**Error Budget**: The allowed amount of unreliability. For a 99.9% SLO over 30 days: `0.001 × 30 × 24 × 60 = 43.2 minutes` of allowed downtime.

**Burn Rate**: How fast you are consuming your error budget. Burn rate of 1 = consuming budget exactly as fast as it replenishes. Burn rate of 14.4 = would exhaust the entire 30-day budget in 50 hours.

## Part 1: Installing Pyrra

Pyrra is a Kubernetes operator that converts SLO definitions (expressed as custom resources) into Prometheus recording rules, alerting rules, and a dashboard API.

```bash
# Install Pyrra via Helm
helm repo add pyrra https://pyrra-dev.github.io/pyrra/
helm repo update

helm install pyrra pyrra/pyrra \
  --namespace monitoring \
  --set image.tag=v0.7.0 \
  --set apiServer.enabled=true \
  --set apiServer.prometheusEndpoint=http://prometheus-operated.monitoring.svc.cluster.local:9090 \
  --set prometheusOperator.enabled=true \
  --wait

# Verify Pyrra is running
kubectl get pods -n monitoring -l app.kubernetes.io/name=pyrra

# Check CRDs
kubectl get crd | grep pyrra
# Should show: servicelevelobjectives.pyrra.dev
```

## Part 2: Defining SLOs with Pyrra

### HTTP Availability SLO

```yaml
# slo-api-availability.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: api-availability
  namespace: production
  labels:
    team: platform
    service: api-gateway
spec:
  description: "API Gateway must serve 99.9% of requests successfully"
  target: "99.9"
  window: 30d
  serviceLevel:
    objectives:
      - value: "99.9"
  indicator:
    ratio:
      errors:
        metric: http_requests_total{job="api-gateway", status=~"5.."}
      total:
        metric: http_requests_total{job="api-gateway"}
  alerting:
    name: APIGatewayAvailability
    labels:
      severity: critical
      team: platform
    annotations:
      summary: "API Gateway availability SLO burning"
      runbook: "https://runbooks.internal/api-gateway-availability"
    burnRateAlerts:
      - short: 5m
        long: 1h
        burnRate: 14.4
        severity: critical
        for: 2m
      - short: 30m
        long: 6h
        burnRate: 6
        severity: critical
        for: 5m
      - short: 2h
        long: 24h
        burnRate: 3
        severity: warning
        for: 15m
      - short: 6h
        long: 3d
        burnRate: 1
        severity: info
        for: 1h
```

### Latency SLO

```yaml
# slo-api-latency.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: api-latency-p99
  namespace: production
  labels:
    team: platform
    service: api-gateway
spec:
  description: "99% of API requests must complete within 200ms"
  target: "99"
  window: 30d
  indicator:
    latency:
      success:
        metric: http_request_duration_seconds_bucket{job="api-gateway", le="0.2"}
      total:
        metric: http_request_duration_seconds_count{job="api-gateway"}
  alerting:
    name: APIGatewayLatency
    labels:
      severity: critical
      team: platform
    annotations:
      summary: "API Gateway P99 latency SLO burning"
      runbook: "https://runbooks.internal/api-latency"
    burnRateAlerts:
      - short: 5m
        long: 1h
        burnRate: 14.4
        severity: critical
        for: 2m
      - short: 30m
        long: 6h
        burnRate: 6
        severity: critical
        for: 5m
      - short: 2h
        long: 24h
        burnRate: 3
        severity: warning
        for: 15m
```

### Database SLO

```yaml
# slo-database.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: database-query-latency
  namespace: production
  labels:
    team: data
    service: postgresql
spec:
  description: "99.9% of database queries must complete within 50ms"
  target: "99.9"
  window: 7d  # Tighter window for database - faster feedback
  indicator:
    latency:
      success:
        metric: |
          pg_stat_statements_mean_time_ms{job="postgres-exporter"} <= 50
      total:
        metric: |
          pg_stat_statements_calls_total{job="postgres-exporter"}
  alerting:
    name: DatabaseQueryLatency
    labels:
      severity: warning
      team: data
    burnRateAlerts:
      - short: 5m
        long: 1h
        burnRate: 14.4
        severity: critical
        for: 2m
      - short: 30m
        long: 6h
        burnRate: 6
        severity: warning
        for: 10m
```

### Apply SLOs and Verify

```bash
kubectl apply -f slo-api-availability.yaml
kubectl apply -f slo-api-latency.yaml
kubectl apply -f slo-database.yaml

# Check SLO status
kubectl get slo -n production

# View generated Prometheus rules
kubectl get prometheusrule -n production

# Check the generated recording rules
kubectl get prometheusrule api-availability -n production -o yaml | \
    yq '.spec.groups[].rules[] | select(.record != null) | .record'
```

### Generated Rules Explained

Pyrra generates several categories of recording rules. Understanding them helps debug SLO calculations:

```yaml
# Generated recording rules for the api-availability SLO

# Multi-window error rate (for burn rate calculation)
# pyrra:api_availability:http_requests_total_5xx:rate5m
# - Error rate over 5 minute window

# pyrra:api_availability:http_requests_total_5xx:rate1h
# - Error rate over 1 hour window (for slow burn detection)

# pyrra:api_availability:http_requests_total_5xx:rate6h
# - Error rate over 6 hour window

# Error budget remaining
# pyrra:api_availability:errorbudget
# - Current error budget remaining as ratio

# SLO compliance
# pyrra:api_availability:slo
# - Boolean: 1 = SLO met, 0 = SLO violated
```

## Part 3: OpenSLO Specification

OpenSLO is a vendor-neutral specification for SLO definitions that allows you to write SLOs once and convert them for multiple backends (Pyrra, Sloth, Nobl9, etc.).

### OpenSLO SLO Definition

```yaml
# openslo-api-gateway.yaml
apiVersion: openslo/v1
kind: SLO
metadata:
  name: api-gateway-availability
  displayName: "API Gateway Availability"
  annotations:
    team: "platform"
    service: "api-gateway"
spec:
  description: "99.9% of API requests must succeed over a 30-day window"
  service: api-gateway
  indicator:
    metadata:
      name: api-gateway-errors
      displayName: "API Gateway Error Ratio"
    spec:
      ratioMetric:
        counter: true
        good:
          metricSource:
            type: Prometheus
            spec:
              query: >
                sum(rate(http_requests_total{
                  job="api-gateway",
                  status!~"5.."
                }[{{.Window}}]))
        total:
          metricSource:
            type: Prometheus
            spec:
              query: >
                sum(rate(http_requests_total{
                  job="api-gateway"
                }[{{.Window}}]))
  objectives:
    - displayName: "99.9% availability"
      target: 0.999
      timeWindow:
        - duration: 30d
          isRolling: true
  alertPolicies:
    - metadata:
        name: api-availability-burn-fast
      spec:
        description: "Fast burn: exhausts budget in 1 hour"
        alertWhenNoData: false
        alertWhenBreaching: true
        conditions:
          - kind: BurnRate
            spec:
              lookbackWindow: 5m
              op: gte
              threshold: 14.4
              alertAfter: 2m
---
apiVersion: openslo/v1
kind: Service
metadata:
  name: api-gateway
  displayName: "API Gateway"
spec:
  description: "Main API Gateway for all customer traffic"
```

### Converting OpenSLO to Pyrra with slogen

```bash
# Install slogen (OpenSLO to various backend converter)
go install github.com/OpenSLO/slogen/cmd/slogen@latest

# Convert OpenSLO to Pyrra format
slogen convert \
    --input openslo-api-gateway.yaml \
    --output-dir ./pyrra-slos/ \
    --generator pyrra

# View generated Pyrra SLO
cat ./pyrra-slos/api-gateway-availability.yaml

# Convert to Sloth format
slogen convert \
    --input openslo-api-gateway.yaml \
    --output-dir ./sloth-slos/ \
    --generator sloth

# Validate OpenSLO files
slogen validate openslo-api-gateway.yaml
```

### OpenSLO DataSource Configuration

```yaml
# openslo-data-sources.yaml
apiVersion: openslo/v1
kind: DataSource
metadata:
  name: production-prometheus
  displayName: "Production Prometheus"
spec:
  type: Prometheus
  connectionData:
    url: http://prometheus.monitoring.svc.cluster.local:9090
    timeout: 30s
---
apiVersion: openslo/v1
kind: DataSource
metadata:
  name: production-thanos
  displayName: "Production Thanos (Long-term)"
spec:
  type: Prometheus  # Thanos is compatible with Prometheus API
  connectionData:
    url: http://thanos-querier.monitoring.svc.cluster.local:9090
    timeout: 60s
```

## Part 4: Multi-Window Burn Rate Alerts

The Google SRE Workbook recommends multi-window burn rate alerts because:
- Short windows catch fast-burning incidents quickly but produce many false positives
- Long windows catch slow burns but alert too late for fast incidents
- Multi-window requires BOTH short and long window to fire before alerting

### Burn Rate Alert Levels

```
┌─────────────────────────────────────────────────────────────────┐
│  For a 30-day SLO, error budget is consumed over these windows  │
│                                                                   │
│  Burn Rate  │  Budget Consumed  │  Detection Window              │
│─────────────┼───────────────────┼────────────────────────────────│
│  14.4x      │  5% in 1 hour     │  5m short + 1h long (CRITICAL) │
│  6x         │  5% in 6 hours    │  30m short + 6h long (CRITICAL)│
│  3x         │  10% in 2 days    │  2h short + 24h long (WARNING) │
│  1x         │  Normal rate      │  6h short + 3d long (INFO)     │
└─────────────────────────────────────────────────────────────────┘
```

### Manual PrometheusRule for Advanced Scenarios

When Pyrra's built-in alert generation does not cover your use case, write recording and alerting rules directly:

```yaml
# prometheusrule-slo-manual.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payment-service-slo
  namespace: production
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    # Recording rules for error ratios at different windows
    - name: payment-service-slo-recording
      interval: 30s
      rules:
        # 5-minute error rate
        - record: slo:payment:errors:rate5m
          expr: |
            sum(rate(http_requests_total{
              job="payment-service",
              status=~"5.."
            }[5m]))
            /
            sum(rate(http_requests_total{
              job="payment-service"
            }[5m]))

        # 1-hour error rate
        - record: slo:payment:errors:rate1h
          expr: |
            sum(rate(http_requests_total{
              job="payment-service",
              status=~"5.."
            }[1h]))
            /
            sum(rate(http_requests_total{
              job="payment-service"
            }[1h]))

        # 6-hour error rate
        - record: slo:payment:errors:rate6h
          expr: |
            sum(rate(http_requests_total{
              job="payment-service",
              status=~"5.."
            }[6h]))
            /
            sum(rate(http_requests_total{
              job="payment-service"
            }[6h]))

        # 1-day error rate
        - record: slo:payment:errors:rate1d
          expr: |
            sum(rate(http_requests_total{
              job="payment-service",
              status=~"5.."
            }[1d]))
            /
            sum(rate(http_requests_total{
              job="payment-service"
            }[1d]))

        # 30-day error budget remaining
        - record: slo:payment:error_budget_remaining
          expr: |
            1 - (
              sum(increase(http_requests_total{
                job="payment-service",
                status=~"5.."
              }[30d]))
              /
              (sum(increase(http_requests_total{
                job="payment-service"
              }[30d])) * 0.001)
            )

    # Alerting rules using multi-window burn rates
    - name: payment-service-slo-alerts
      rules:
        # Fast burn - critical: exhausts budget in 1 hour
        - alert: PaymentServiceSLOFastBurn
          expr: |
            slo:payment:errors:rate5m > (14.4 * 0.001)
            and
            slo:payment:errors:rate1h > (14.4 * 0.001)
          for: 2m
          labels:
            severity: critical
            team: payments
            slo: payment-availability
          annotations:
            summary: "Payment service fast burn rate"
            description: >
              Payment service error rate is {{ $value | humanizePercentage }}.
              At current burn rate, error budget will be exhausted in approximately 1 hour.
              Error budget remaining: {{ query "slo:payment:error_budget_remaining" | first | value | humanizePercentage }}
            runbook: "https://runbooks.internal/payment-slo-fast-burn"
            dashboard: "https://grafana.internal/d/payment-slo"

        # Medium burn - critical: exhausts budget in 6 hours
        - alert: PaymentServiceSLOMediumBurn
          expr: |
            slo:payment:errors:rate30m > (6 * 0.001)
            and
            slo:payment:errors:rate6h > (6 * 0.001)
          for: 10m
          labels:
            severity: critical
            team: payments
            slo: payment-availability
          annotations:
            summary: "Payment service medium burn rate"
            description: >
              Payment service is burning error budget at 6x normal rate.
              Budget will be exhausted in approximately 6 hours.
            runbook: "https://runbooks.internal/payment-slo-medium-burn"

        # Slow burn - warning: will exhaust budget
        - alert: PaymentServiceSLOSlowBurn
          expr: |
            slo:payment:errors:rate2h > (3 * 0.001)
            and
            slo:payment:errors:rate1d > (3 * 0.001)
          for: 30m
          labels:
            severity: warning
            team: payments
            slo: payment-availability
          annotations:
            summary: "Payment service slow burn rate"
            description: >
              Payment service is consuming error budget faster than replenishment rate.
              Current burn rate: {{ $value | humanize }} errors/s

        # Error budget nearly exhausted
        - alert: PaymentServiceErrorBudgetExhausted
          expr: slo:payment:error_budget_remaining < 0.05
          for: 5m
          labels:
            severity: critical
            team: payments
            slo: payment-availability
          annotations:
            summary: "Payment service error budget nearly exhausted"
            description: >
              Only {{ $value | humanizePercentage }} of error budget remains.
              Consider freezing non-critical deployments.
```

## Part 5: SLO Dashboards with Grafana

### Pyrra Dashboard Configuration

```yaml
# grafana-pyrra-dashboard.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pyrra-dashboards
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  pyrra-slo-overview.json: |
    {
      "title": "SLO Overview",
      "uid": "slo-overview",
      "panels": [
        {
          "title": "Error Budget Remaining",
          "type": "gauge",
          "targets": [
            {
              "expr": "min(pyrra:availability:errorbudget) * 100",
              "legendFormat": "{{service}}"
            }
          ],
          "options": {
            "reduceOptions": {"calcs": ["lastNotNull"]},
            "orientation": "auto",
            "showThresholdLabels": false,
            "showThresholdMarkers": true
          },
          "fieldConfig": {
            "defaults": {
              "unit": "percent",
              "min": 0,
              "max": 100,
              "thresholds": {
                "steps": [
                  {"color": "red", "value": 0},
                  {"color": "yellow", "value": 25},
                  {"color": "green", "value": 50}
                ]
              }
            }
          }
        }
      ]
    }
```

### Custom SLO Status Dashboard

```json
{
  "title": "SLO Status - Production",
  "uid": "production-slos",
  "rows": [
    {
      "title": "Error Budget Summary",
      "panels": [
        {
          "title": "API Gateway - 30d Error Budget",
          "type": "stat",
          "targets": [
            {
              "expr": "1 - (sum(increase(http_requests_total{job=\"api-gateway\",status=~\"5..\"}[30d])) / (sum(increase(http_requests_total{job=\"api-gateway\"}[30d])) * (1 - 0.999)))",
              "legendFormat": "Remaining"
            }
          ],
          "options": {
            "textMode": "value",
            "colorMode": "background"
          },
          "fieldConfig": {
            "defaults": {
              "unit": "percentunit",
              "thresholds": {
                "steps": [
                  {"value": 0, "color": "red"},
                  {"value": 0.1, "color": "yellow"},
                  {"value": 0.5, "color": "green"}
                ]
              }
            }
          }
        }
      ]
    }
  ]
}
```

## Part 6: Error Budget Policy

An error budget policy defines what actions to take when the budget reaches different thresholds. Without a policy, SLOs become metrics without consequences.

```yaml
# error-budget-policy.yaml
# This is a documentation artifact, not a Kubernetes resource
# Store in your team's runbooks/policies directory

apiVersion: v1
kind: ConfigMap
metadata:
  name: error-budget-policy
  namespace: production
data:
  policy.yaml: |
    # Error Budget Policy - API Gateway
    # Version: 2025.1
    # Owner: Platform Team

    service: api-gateway
    slo_target: 99.9%
    window: 30d
    monthly_budget_minutes: 43.2

    thresholds:
      # Budget > 50%: Normal operations
      - budget_remaining: "> 50%"
        state: healthy
        actions:
          - Deploy features normally
          - Run experiments (A/B tests, gradual rollouts)
          - Perform planned maintenance in off-peak hours

      # Budget 25-50%: Caution
      - budget_remaining: "25-50%"
        state: caution
        actions:
          - Pause non-critical experiments
          - Increase deployment scrutiny (more extensive pre-deploy testing)
          - Hold risky infrastructure changes

      # Budget 10-25%: Warning
      - budget_remaining: "10-25%"
        state: warning
        actions:
          - Freeze all non-critical deployments
          - Escalate pending incidents
          - Activate incident response if degradation is ongoing
          - Daily SLO review meetings

      # Budget < 10%: Critical
      - budget_remaining: "< 10%"
        state: critical
        actions:
          - Freeze ALL deployments including hotfixes (unless fixing the SLO breach)
          - Page on-call SRE immediately
          - Executive escalation
          - Postmortem required before resuming deployments

      # Budget exhausted: Emergency
      - budget_remaining: "0%"
        state: emergency
        actions:
          - Rollback recent deployments
          - Activate incident response
          - Customer communication if user-facing
          - SLO breach report to stakeholders
```

### Automated Policy Enforcement

```go
// cmd/budget-enforcer/main.go
// Reads current error budget and updates deployment annotations to block/allow
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/prometheus/client_golang/api"
    v1 "github.com/prometheus/client_golang/api/prometheus/v1"
    "github.com/prometheus/common/model"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
)

type BudgetState string

const (
    StateHealthy   BudgetState = "healthy"
    StateCaution   BudgetState = "caution"
    StateWarning   BudgetState = "warning"
    StateCritical  BudgetState = "critical"
    StateEmergency BudgetState = "emergency"
)

type BudgetEnforcer struct {
    promAPI   v1.API
    k8sClient *kubernetes.Clientset
    namespace string
}

func (e *BudgetEnforcer) GetBudgetRemaining(ctx context.Context, sloName string) (float64, error) {
    query := fmt.Sprintf("pyrra:%s:errorbudget", sloName)
    result, _, err := e.promAPI.Query(ctx, query, time.Now())
    if err != nil {
        return 0, fmt.Errorf("querying Prometheus: %w", err)
    }

    vector, ok := result.(model.Vector)
    if !ok || len(vector) == 0 {
        return 0, fmt.Errorf("no data for SLO %s", sloName)
    }

    return float64(vector[0].Value), nil
}

func (e *BudgetEnforcer) GetBudgetState(budget float64) BudgetState {
    switch {
    case budget > 0.50:
        return StateHealthy
    case budget > 0.25:
        return StateCaution
    case budget > 0.10:
        return StateWarning
    case budget > 0:
        return StateCritical
    default:
        return StateEmergency
    }
}

func (e *BudgetEnforcer) UpdateDeploymentPolicy(ctx context.Context, state BudgetState) error {
    // Add annotation to all deployments indicating current error budget state
    // ArgoCD and Flux can check this annotation before deploying
    deployments, err := e.k8sClient.AppsV1().Deployments(e.namespace).List(ctx, metav1.ListOptions{
        LabelSelector: "slo-managed=true",
    })
    if err != nil {
        return fmt.Errorf("listing deployments: %w", err)
    }

    for _, deployment := range deployments.Items {
        if deployment.Annotations == nil {
            deployment.Annotations = make(map[string]string)
        }
        deployment.Annotations["slo.support.tools/error-budget-state"] = string(state)
        deployment.Annotations["slo.support.tools/updated"] = time.Now().Format(time.RFC3339)

        if state == StateCritical || state == StateEmergency {
            deployment.Annotations["slo.support.tools/deployments-frozen"] = "true"
        } else {
            delete(deployment.Annotations, "slo.support.tools/deployments-frozen")
        }

        _, err := e.k8sClient.AppsV1().Deployments(e.namespace).Update(
            ctx, &deployment, metav1.UpdateOptions{},
        )
        if err != nil {
            log.Printf("Warning: updating deployment %s: %v", deployment.Name, err)
        }
    }

    return nil
}

func main() {
    // Initialize Prometheus client
    promClient, err := api.NewClient(api.Config{
        Address: "http://prometheus.monitoring.svc.cluster.local:9090",
    })
    if err != nil {
        log.Fatalf("Creating Prometheus client: %v", err)
    }

    // Initialize Kubernetes client
    k8sConfig, err := rest.InClusterConfig()
    if err != nil {
        log.Fatalf("Loading Kubernetes config: %v", err)
    }
    k8sClient, err := kubernetes.NewForConfig(k8sConfig)
    if err != nil {
        log.Fatalf("Creating Kubernetes client: %v", err)
    }

    enforcer := &BudgetEnforcer{
        promAPI:   v1.NewAPI(promClient),
        k8sClient: k8sClient,
        namespace: "production",
    }

    // Run enforcement loop
    ticker := time.NewTicker(5 * time.Minute)
    for range ticker.C {
        ctx := context.Background()
        budget, err := enforcer.GetBudgetRemaining(ctx, "api-availability")
        if err != nil {
            log.Printf("Error getting budget: %v", err)
            continue
        }

        state := enforcer.GetBudgetState(budget)
        log.Printf("Error budget: %.2f%%, state: %s", budget*100, state)

        if err := enforcer.UpdateDeploymentPolicy(ctx, state); err != nil {
            log.Printf("Error updating policy: %v", err)
        }
    }
}
```

## Part 7: SLO Review Process

### Weekly SLO Review Script

```bash
#!/bin/bash
# slo-weekly-review.sh - Generate SLO report for weekly review

PROMETHEUS="http://prometheus.monitoring.svc.cluster.local:9090"
REPORT_DATE=$(date +%Y-%m-%d)

echo "=== SLO Weekly Review Report: $REPORT_DATE ===" > slo-report-$REPORT_DATE.txt

query_prometheus() {
    curl -s -G "$PROMETHEUS/api/v1/query" \
        --data-urlencode "query=$1" | \
        jq -r '.data.result[0].value[1] // "N/A"'
}

echo "" >> slo-report-$REPORT_DATE.txt
echo "=== API Gateway SLO ===" >> slo-report-$REPORT_DATE.txt

# Current error rate
ERROR_RATE=$(query_prometheus 'sum(rate(http_requests_total{job="api-gateway",status=~"5.."}[1h])) / sum(rate(http_requests_total{job="api-gateway"}[1h]))')
echo "Current 1h error rate: $ERROR_RATE" >> slo-report-$REPORT_DATE.txt

# 30-day error budget remaining
BUDGET=$(query_prometheus 'pyrra:api-availability:errorbudget')
echo "30-day error budget remaining: $BUDGET" >> slo-report-$REPORT_DATE.txt

# 7-day budget consumption
BUDGET_7D=$(query_prometheus 'sum(increase(http_requests_total{job="api-gateway",status=~"5.."}[7d])) / (sum(increase(http_requests_total{job="api-gateway"}[7d])) * 0.001)')
echo "7-day budget consumption: $BUDGET_7D (of 7d allocation)" >> slo-report-$REPORT_DATE.txt

# Current SLO status (1=met, 0=violated)
SLO_STATUS=$(query_prometheus 'pyrra:api-availability:slo')
echo "SLO compliance status: $([ "$SLO_STATUS" = "1" ] && echo "PASSING" || echo "FAILING")" >> slo-report-$REPORT_DATE.txt

cat slo-report-$REPORT_DATE.txt
```

## Part 8: Multi-Service SLO Composition

For composite services, you may need SLOs that depend on the reliability of their dependencies:

```yaml
# slo-checkout-composite.yaml
# Checkout service SLO is bounded by its dependencies
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: checkout-availability
  namespace: production
spec:
  description: |
    Checkout service availability.
    This SLO depends on: payment-service (99.95%), inventory-service (99.9%), auth-service (99.99%)
    Composite availability = 0.9995 × 0.999 × 0.9999 ≈ 99.84%
    We target 99.5% to allow for additional checkout-specific failures.
  target: "99.5"
  window: 30d
  indicator:
    ratio:
      errors:
        metric: |
          http_requests_total{
            job="checkout-service",
            status=~"5.."
          }
      total:
        metric: |
          http_requests_total{
            job="checkout-service"
          }
  alerting:
    name: CheckoutAvailability
    burnRateAlerts:
      - short: 5m
        long: 1h
        burnRate: 14.4
        severity: critical
        for: 2m
      - short: 30m
        long: 6h
        burnRate: 6
        severity: critical
        for: 5m
```

## Key Takeaways

SLOs with properly implemented error budget management represent a cultural shift as much as a technical one. The tooling is straightforward; the harder work is getting teams to use error budget state to make deployment decisions.

**Pyrra reduces the SLO implementation barrier significantly**: without a tool like Pyrra, implementing multi-window burn rate alerts requires understanding the mathematics of error budget calculation and writing dozens of recording rules manually. Pyrra handles this automatically from a simple SLO definition.

**OpenSLO provides vendor independence**: writing SLOs in the OpenSLO format means you can switch between Pyrra, Sloth, and commercial tools without rewriting your SLO definitions. This is valuable as the observability tooling landscape continues to evolve.

**Multi-window alerts reduce false positives by 70-80%** compared to single-window threshold alerts. The requirement for both a short and a long window to exceed the threshold before firing ensures that brief traffic spikes do not generate pages.

**Error budget policy is more important than the tooling**: the Prometheus rules and Kubernetes operators are easy to configure. The organizational discipline of actually freezing deployments when the budget is at 10% — even when there is a sprint deadline — is what makes the system work.

**Start with availability SLOs**, then add latency SLOs once the culture is established. Availability SLOs are simpler to understand and communicate to stakeholders, providing a foundation for expanding your SLO practice.
