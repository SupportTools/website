---
title: "Kubernetes SLO-Based Alerting: Pyrra, Sloth, and Error Budget Policies"
date: 2029-08-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "SLO", "Prometheus", "Alerting", "Pyrra", "Sloth", "SRE", "Monitoring"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to SLO-based alerting on Kubernetes using Pyrra and Sloth: SLO CRDs, multi-window multi-burn-rate alerts, error budget tracking, alert routing by severity, and Grafana dashboards."
more_link: "yes"
url: "/kubernetes-slo-based-alerting-pyrra-sloth-error-budget/"
---

Alert fatigue kills on-call engineers. When every Prometheus alert is a flat threshold with no context, engineers spend half their time triaging noise. SLO-based alerting solves this by anchoring alerts to error budgets — the amount of downtime or errors you are allowed to have while still meeting your reliability commitments. This post covers the full stack: defining SLOs as Kubernetes CRDs, generating multi-window multi-burn-rate alerts with Pyrra and Sloth, tracking budget consumption, and routing alerts by severity.

<!--more-->

# Kubernetes SLO-Based Alerting: Pyrra, Sloth, and Error Budget Policies

## Section 1: SLO Fundamentals for Platform Engineers

An SLO (Service Level Objective) defines a target reliability level for a given SLI (Service Level Indicator). An error budget is what you get to spend before you violate the SLO.

### Key Definitions

```
SLI = (good events / total events) expressed as a ratio or percentile
SLO = target ratio over a rolling time window (e.g., 99.9% over 30 days)
Error Budget = (1 - SLO) * window = time/events you can afford to lose
              = (1 - 0.999) * 30d * 24h * 60m = 43.2 minutes

Burn Rate = how fast the error budget is being consumed relative to normal
            burn_rate = 1.0 means consuming budget at exactly the SLO rate
            burn_rate = 10.0 means consuming 10x faster than the SLO rate
```

### Why Multi-Window Multi-Burn-Rate Alerts

Simple threshold alerts on error rate miss two scenarios:

1. **Slow burns** — A 1% error rate on a 99.9% SLO will consume the entire error budget in 43 hours without ever triggering a "high error rate" alert
2. **Spikes** — A 50% error rate for 5 minutes barely dents the budget but would page you immediately with a threshold alert

Multi-window multi-burn-rate (MWMBR) alerts solve both by looking at burn rate across two windows simultaneously. The Google SRE Workbook recommends this alert configuration:

| Burn Rate | Short Window | Long Window | Response Time | Ticket/Page |
|---|---|---|---|---|
| 14x | 1h | 5m | ~5 minutes | Page |
| 6x | 6h | 30m | ~30 minutes | Page |
| 3x | 24h | 2h | ~2 hours | Ticket |
| 1x | 3d | 6h | Next business day | Ticket |

## Section 2: Installing Pyrra

Pyrra is a Kubernetes-native SLO management tool that reads `ServiceLevelObjective` CRDs and generates PrometheusRule objects with MWMBR alerts.

```bash
# Add the Pyrra Helm repository
helm repo add pyrra https://pyrra-dev.github.io/pyrra/helm-charts
helm repo update

# Install Pyrra (operator + API server)
helm upgrade --install pyrra pyrra/pyrra \
    --namespace monitoring \
    --create-namespace \
    --set image.tag=v0.7.0 \
    --set apiImage.tag=v0.7.0 \
    --values - << 'EOF'
# Pyrra reads SLO CRDs and creates PrometheusRules
operator:
  clusterRoles: true

api:
  enabled: true
  replicas: 1

genericRules:
  enabled: true
EOF

# Verify Pyrra is running
kubectl get pods -n monitoring -l app.kubernetes.io/name=pyrra
kubectl get crd servicelevelobjectives.pyrra.dev
```

### Pyrra RBAC Requirements

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pyrra-operator
rules:
  - apiGroups: ["pyrra.dev"]
    resources: ["servicelevelobjectives", "servicelevelobjectives/status"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: ["monitoring.coreos.com"]
    resources: ["prometheusrules"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
```

## Section 3: Defining SLOs with Pyrra CRDs

### HTTP Availability SLO

```yaml
# slo-api-availability.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: api-gateway-availability
  namespace: production
  labels:
    team: platform
    service: api-gateway
spec:
  target: "99.9"     # 99.9% availability
  window: 2w         # 2-week rolling window
  serviceLevel:
    name: api-gateway-requests
    namespace: production
  indicator:
    ratio:
      errors:
        metric: http_requests_total{job="api-gateway", code=~"5.."}
      total:
        metric: http_requests_total{job="api-gateway"}
  alerting:
    name: APIGatewayAvailability
    labels:
      team: platform
      severity: page
    annotations:
      runbook: "https://wiki.internal/runbooks/api-gateway-slo"
      dashboard: "https://grafana.internal/d/api-gateway"
```

### Latency SLO

```yaml
# slo-api-latency.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: api-gateway-latency-p99
  namespace: production
spec:
  target: "99"       # 99% of requests under threshold
  window: 2w
  serviceLevel:
    name: api-gateway-latency
    namespace: production
  indicator:
    latency:
      success:
        metric: http_request_duration_seconds_bucket{job="api-gateway", le="0.25"}
      total:
        metric: http_request_duration_seconds_count{job="api-gateway"}
  alerting:
    name: APIGatewayLatencyP99
    labels:
      team: platform
      severity: page
    annotations:
      runbook: "https://wiki.internal/runbooks/api-latency-slo"
```

### gRPC SLO

```yaml
# slo-grpc-service.yaml
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: order-service-grpc-availability
  namespace: production
spec:
  target: "99.95"
  window: 4w
  indicator:
    ratio:
      errors:
        metric: grpc_server_handled_total{job="order-service", grpc_code=~"Unavailable|Internal|Unknown"}
      total:
        metric: grpc_server_handled_total{job="order-service"}
  alerting:
    name: OrderServiceGRPCAvailability
    labels:
      team: orders
      severity: page
```

### Applying and Inspecting Generated Rules

```bash
kubectl apply -f slo-api-availability.yaml

# Pyrra generates a PrometheusRule with MWMBR alerts
kubectl get prometheusrule api-gateway-availability -n production -o yaml

# The generated rules include recording rules and alerts
# Recording rules (computed once per interval, cheap to query):
# - slo:api_gateway_requests:ratio_rate5m
# - slo:api_gateway_requests:ratio_rate30m
# - slo:api_gateway_requests:ratio_rate1h
# - slo:api_gateway_requests:ratio_rate6h
# - slo:api_gateway_requests:ratio_rate1d
# - slo:api_gateway_requests:ratio_rate3d
# - slo:api_gateway_requests:error_budget_remaining

# Alert: APIGatewayAvailabilityBurnRateHigh (14x burn, 5m+1h windows)
# Alert: APIGatewayAvailabilityBurnRateLow (3x burn, 2h+24h windows)
```

## Section 4: Sloth — SLO as Code

Sloth takes a different approach: you write SLO YAML and it generates the PrometheusRule manifests as part of your CI/CD pipeline. No operator required in the cluster.

### Installing Sloth

```bash
# Install Sloth CLI
VERSION=v0.11.0
curl -LO https://github.com/slok/sloth/releases/download/${VERSION}/sloth-linux-amd64
chmod +x sloth-linux-amd64
mv sloth-linux-amd64 /usr/local/bin/sloth

# Or as a Kubernetes job in CI/CD
docker pull ghcr.io/slok/sloth:${VERSION}
```

### Sloth SLO Definition

```yaml
# sloth-slos.yaml
version: "prometheus/v1"
service: "api-gateway"
labels:
  team: "platform"
  tier: "critical"

slos:
  - name: "requests-availability"
    objective: 99.9
    description: "99.9% of API gateway requests succeed"
    sli:
      events:
        error_query: |
          sum(rate(http_requests_total{job="api-gateway", code=~"5.."}[{{.window}}]))
        total_query: |
          sum(rate(http_requests_total{job="api-gateway"}[{{.window}}]))
    alerting:
      name: APIGatewayAvailability
      labels:
        category: "availability"
      annotations:
        runbook: "https://wiki.internal/runbooks/api-gateway"
      page_alert:
        labels:
          severity: "critical"
          pagerduty_service: "api-gateway-prod"
      ticket_alert:
        labels:
          severity: "warning"
          jira_project: "PLATFORM"

  - name: "request-latency-p95"
    objective: 99.5
    description: "99.5% of requests complete within 200ms (p95)"
    sli:
      events:
        error_query: |
          sum(rate(http_request_duration_seconds_bucket{job="api-gateway", le="0.2"}[{{.window}}]))
        total_query: |
          sum(rate(http_request_duration_seconds_count{job="api-gateway"}[{{.window}}]))
    alerting:
      name: APIGatewayLatency
      page_alert:
        labels:
          severity: "critical"
      ticket_alert:
        labels:
          severity: "warning"
```

### Generating PrometheusRules with Sloth

```bash
# Generate PrometheusRule manifests
sloth generate -i sloth-slos.yaml -o generated-prometheusrules.yaml

# Apply to cluster
kubectl apply -f generated-prometheusrules.yaml

# Validate output
sloth validate -i sloth-slos.yaml

# Generate for multiple services (CI/CD pattern)
for slo_file in slos/*.yaml; do
    service=$(basename "$slo_file" .yaml)
    sloth generate -i "$slo_file" -o "generated/${service}-rules.yaml"
done

kubectl apply -f generated/
```

### Examining Generated Alert Rules

```yaml
# Example of what Sloth generates (PrometheusRule excerpt)
groups:
  - name: sloth-slo-api-gateway-requests-availability
    rules:
      # Recording rules for multi-window burn rates
      - record: slo:sli_error:ratio_rate5m
        expr: |
          (sum(rate(http_requests_total{job="api-gateway", code=~"5.."}[5m])))
          /
          (sum(rate(http_requests_total{job="api-gateway"}[5m])))
        labels:
          sloth_service: api-gateway
          sloth_slo: requests-availability
          sloth_window: 5m

      # Fast burn alert (>14x) — pages immediately
      - alert: APIGatewayAvailabilityBurnRatePage
        expr: |
          (
            (slo:sli_error:ratio_rate5m{sloth_slo="requests-availability"} > (14 * 0.001))
            and
            (slo:sli_error:ratio_rate1h{sloth_slo="requests-availability"} > (14 * 0.001))
          )
          or
          (
            (slo:sli_error:ratio_rate30m{sloth_slo="requests-availability"} > (6 * 0.001))
            and
            (slo:sli_error:ratio_rate6h{sloth_slo="requests-availability"} > (6 * 0.001))
          )
        for: 2m
        labels:
          severity: critical
          sloth_severity: page
        annotations:
          summary: "High error budget burn rate for api-gateway availability SLO"
          description: "Error budget is being consumed {{ $value | humanizePercentage }} times faster than target"
```

## Section 5: Error Budget Tracking

### Recording Rules for Budget Tracking

```yaml
# error-budget-rules.yaml — add to your PrometheusRule
groups:
  - name: error-budget-tracking
    interval: 1m
    rules:
      # Error budget remaining (as a percentage)
      - record: slo:error_budget:remaining_percentage
        expr: |
          1 - (
            sum_over_time(slo:sli_error:ratio_rate5m[2w]) /
            count_over_time(slo:sli_error:ratio_rate5m[2w])
          ) / (1 - 0.999)
        labels:
          sloth_slo: requests-availability

      # Error budget consumed in the last hour
      - record: slo:error_budget:consumed_last_1h
        expr: |
          (
            sum(rate(http_requests_total{job="api-gateway", code=~"5.."}[1h]))
            /
            sum(rate(http_requests_total{job="api-gateway"}[1h]))
          ) / (1 - 0.999) * (1 / (2*7*24))

      # Minutes of error budget remaining
      - record: slo:error_budget:remaining_minutes
        expr: |
          slo:error_budget:remaining_percentage * (2 * 7 * 24 * 60) * (1 - 0.999)
```

### Querying Budget Remaining

```promql
# How much error budget is remaining? (0-100%)
slo:error_budget:remaining_percentage{sloth_slo="requests-availability"} * 100

# At the current burn rate, when does budget run out?
slo:error_budget:remaining_minutes{sloth_slo="requests-availability"}
/ on() slo:sli_error:ratio_rate1h * 60

# Error budget consumed this week
1 - (
  sum_over_time(slo:sli_error:ratio_rate5m[7d]) /
  count_over_time(slo:sli_error:ratio_rate5m[7d])
) / (1 - 0.999)
```

### Alert on Budget Exhaustion

```yaml
# Alert when error budget is running low
- alert: ErrorBudgetLow
  expr: |
    slo:error_budget:remaining_percentage{sloth_slo="requests-availability"} < 0.25
  for: 15m
  labels:
    severity: warning
  annotations:
    summary: "Error budget below 25% for {{ $labels.sloth_slo }}"
    description: "Only {{ $value | humanizePercentage }} of error budget remaining. Budget resets in {{ remaining_days }} days."

- alert: ErrorBudgetExhausted
  expr: |
    slo:error_budget:remaining_percentage{sloth_slo="requests-availability"} < 0.05
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Error budget nearly exhausted for {{ $labels.sloth_slo }}"
```

## Section 6: Alert Routing by Severity

### Alertmanager Configuration

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m

route:
  receiver: "default-receiver"
  group_by: ["alertname", "sloth_slo", "team"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    # Critical/page severity — PagerDuty immediately
    - matchers:
        - severity="critical"
        - sloth_severity="page"
      receiver: "pagerduty-critical"
      group_wait: 10s
      repeat_interval: 1h
      continue: false

    # Warning severity — Slack
    - matchers:
        - severity="warning"
      receiver: "slack-warnings"
      group_wait: 2m
      repeat_interval: 8h

    # Error budget low — create Jira ticket
    - matchers:
        - alertname="ErrorBudgetLow"
      receiver: "jira-tickets"
      group_wait: 5m
      repeat_interval: 24h

receivers:
  - name: "pagerduty-critical"
    pagerduty_configs:
      - routing_key: "${PAGERDUTY_INTEGRATION_KEY}"
        description: "{{ .CommonAnnotations.summary }}"
        details:
          slo: "{{ .CommonLabels.sloth_slo }}"
          runbook: "{{ .CommonAnnotations.runbook }}"
          team: "{{ .CommonLabels.team }}"

  - name: "slack-warnings"
    slack_configs:
      - api_url: "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"
        channel: "#slo-alerts"
        title: "SLO Warning: {{ .CommonAnnotations.summary }}"
        text: |
          *SLO:* {{ .CommonLabels.sloth_slo }}
          *Team:* {{ .CommonLabels.team }}
          *Error Budget Remaining:* See dashboard
          *Runbook:* {{ .CommonAnnotations.runbook }}
        color: "warning"

  - name: "jira-tickets"
    webhook_configs:
      - url: "https://jira-webhook.internal/create-ticket"
        send_resolved: true

  - name: "default-receiver"
    slack_configs:
      - api_url: "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"
        channel: "#alerts-noise"
```

### Alert Inhibition Rules

```yaml
# Prevent ticket alerts firing while page is already firing for the same SLO
inhibit_rules:
  - source_matchers:
      - severity="critical"
      - sloth_severity="page"
    target_matchers:
      - severity="warning"
    equal: ["sloth_slo", "sloth_service"]
```

## Section 7: Grafana Dashboards for SLO Visibility

### Dashboard JSON Panels

```json
{
  "title": "SLO Error Budget Overview",
  "panels": [
    {
      "title": "Error Budget Remaining (%)",
      "type": "gauge",
      "fieldConfig": {
        "defaults": {
          "min": 0,
          "max": 100,
          "thresholds": {
            "steps": [
              {"color": "red", "value": 0},
              {"color": "yellow", "value": 25},
              {"color": "green", "value": 50}
            ]
          },
          "unit": "percent"
        }
      },
      "targets": [
        {
          "expr": "slo:error_budget:remaining_percentage{sloth_slo=\"requests-availability\"} * 100",
          "legendFormat": "{{sloth_slo}}"
        }
      ]
    }
  ]
}
```

### Pyrra's Built-in UI

```bash
# Pyrra ships with a built-in web UI for SLO visibility
kubectl port-forward svc/pyrra-api -n monitoring 9444:9444

# Access at http://localhost:9444
# Shows:
# - Current SLO status (green/yellow/red)
# - Error budget remaining
# - Burn rate graph
# - Alert firing status
```

### Grafana Dashboard as Code

```yaml
# grafana-slo-dashboard-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: slo-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  slo-overview.json: |
    {
      "title": "SLO Overview",
      "uid": "slo-overview",
      "tags": ["slo", "error-budget"],
      "panels": [
        {
          "title": "Error Budget Burn Rate (1h)",
          "type": "timeseries",
          "targets": [
            {
              "expr": "slo:sli_error:ratio_rate1h / (1 - 0.999)",
              "legendFormat": "Burn Rate"
            },
            {
              "expr": "14",
              "legendFormat": "Page Threshold (14x)"
            },
            {
              "expr": "6",
              "legendFormat": "Ticket Threshold (6x)"
            }
          ]
        },
        {
          "title": "Error Budget Remaining Over Time",
          "type": "timeseries",
          "targets": [
            {
              "expr": "slo:error_budget:remaining_percentage * 100",
              "legendFormat": "Budget Remaining %"
            }
          ],
          "fieldConfig": {
            "defaults": {
              "custom": {
                "fillOpacity": 20,
                "gradientMode": "opacity"
              },
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

## Section 8: SLO Policies and Governance

### Error Budget Policy Document

```markdown
# Error Budget Policy — API Gateway
Owner: Platform Team
Last Updated: 2029-08-09
SLO: 99.9% availability over 30 days
Error Budget: 43.2 minutes / 30 days

## Thresholds and Actions

| Budget Remaining | Action Required |
|---|---|
| > 50% | Normal operations. New features, risky deployments allowed. |
| 25-50% | Caution. New features require platform team approval. |
| 10-25% | Freeze non-critical deployments. Begin reliability work. |
| < 10% | Emergency. All non-essential work paused. War room activated. |
| 0% | SLO violated. Post-mortem required. 30-day feature freeze. |

## Alert Response Procedures

### Fast Burn (14x) — Page
- Acknowledge within 5 minutes
- Triage cause within 15 minutes
- Roll back or mitigate within 30 minutes

### Slow Burn (6x) — Page
- Acknowledge within 30 minutes
- Root cause analysis within 2 hours
- Fix within 24 hours

### Slow Burn (3x) — Ticket
- Assign within 2 hours
- Fix within one sprint
```

### Automating Policy Enforcement

```go
// slo-policy-enforcer/main.go
// Reads error budget status and annotates deployments or blocks CI
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"
    "strconv"
    "time"
)

type BudgetStatus struct {
    SLO             string  `json:"slo"`
    BudgetRemaining float64 `json:"budget_remaining"`
    PolicyLevel     string  `json:"policy_level"`
    DeployAllowed   bool    `json:"deploy_allowed"`
}

func queryErrorBudget(prometheusURL, sloName string) (float64, error) {
    query := fmt.Sprintf(
        `slo:error_budget:remaining_percentage{sloth_slo="%s"}`,
        sloName,
    )
    resp, err := http.Get(fmt.Sprintf(
        "%s/api/v1/query?query=%s&time=%d",
        prometheusURL,
        query,
        time.Now().Unix(),
    ))
    if err != nil {
        return 0, err
    }
    defer resp.Body.Close()

    var result struct {
        Data struct {
            Result []struct {
                Value [2]interface{} `json:"value"`
            } `json:"result"`
        } `json:"data"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return 0, err
    }
    if len(result.Data.Result) == 0 {
        return 1.0, nil // No data = assume full budget
    }
    return strconv.ParseFloat(result.Data.Result[0].Value[1].(string), 64)
}

func getBudgetStatus(remaining float64, sloName string) BudgetStatus {
    status := BudgetStatus{
        SLO:             sloName,
        BudgetRemaining: remaining,
        DeployAllowed:   true,
    }
    switch {
    case remaining > 0.5:
        status.PolicyLevel = "green"
    case remaining > 0.25:
        status.PolicyLevel = "yellow"
    case remaining > 0.1:
        status.PolicyLevel = "orange"
        // Still allow deploys but require approval
    case remaining > 0:
        status.PolicyLevel = "red"
        status.DeployAllowed = false
    default:
        status.PolicyLevel = "violated"
        status.DeployAllowed = false
    }
    return status
}

func main() {
    prometheusURL := os.Getenv("PROMETHEUS_URL")
    sloName := os.Getenv("SLO_NAME")

    remaining, err := queryErrorBudget(prometheusURL, sloName)
    if err != nil {
        log.Fatalf("Failed to query error budget: %v", err)
    }

    status := getBudgetStatus(remaining, sloName)
    out, _ := json.MarshalIndent(status, "", "  ")
    fmt.Println(string(out))

    if !status.DeployAllowed {
        os.Exit(1) // Signal CI/CD to block deployment
    }
}
```

```bash
# Use in GitHub Actions
- name: Check SLO Error Budget
  run: |
    STATUS=$(go run ./slo-policy-enforcer/main.go)
    echo "$STATUS" | jq .
    DEPLOY_ALLOWED=$(echo "$STATUS" | jq -r .deploy_allowed)
    if [ "$DEPLOY_ALLOWED" != "true" ]; then
      echo "ERROR: Error budget exhausted. Deployment blocked."
      exit 1
    fi
  env:
    PROMETHEUS_URL: "https://prometheus.internal"
    SLO_NAME: "requests-availability"
```

## Section 9: Multi-Service SLO Management

### SLO Hierarchy for Composite Services

```yaml
# Upstream SLOs affect downstream SLOs
# Define dependency relationships

# Database SLO (foundation)
---
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: database-availability
  namespace: production
spec:
  target: "99.95"
  window: 2w
  indicator:
    ratio:
      errors:
        metric: pg_up{job="postgresql"} == 0
      total:
        metric: pg_up{job="postgresql"}

# API depends on database — SLO must account for DB budget
---
apiVersion: pyrra.dev/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: api-availability
  namespace: production
  annotations:
    slo.support.tools/depends-on: "database-availability"
spec:
  target: "99.9"    # Lower than DB SLO to account for dependency
  window: 2w
  indicator:
    ratio:
      errors:
        metric: http_requests_total{job="api-gateway", code=~"5.."}
      total:
        metric: http_requests_total{job="api-gateway"}
```

### Aggregate SLO for a Product

```promql
# Composite availability: geometric mean of component SLOs
(
  slo:sli_error:ratio_rate1h{sloth_slo="api-availability"} == 0
  and
  slo:sli_error:ratio_rate1h{sloth_slo="database-availability"} == 0
  and
  slo:sli_error:ratio_rate1h{sloth_slo="auth-availability"} == 0
) or vector(1)
```

## Section 10: Production Checklist

- [ ] Pyrra or Sloth installed and generating PrometheusRule objects
- [ ] SLO targets defined based on customer agreements (not arbitrary numbers)
- [ ] Recording rules created for all required burn rate windows (5m, 30m, 1h, 6h, 1d, 3d)
- [ ] MWMBR alerts configured: fast burn (14x, 6x) and slow burn (3x, 1x)
- [ ] Error budget remaining tracked as a Prometheus metric
- [ ] Alert routing configured: page for fast burn, ticket for slow burn
- [ ] Alert inhibition prevents duplicate notifications
- [ ] Grafana dashboard deployed showing budget remaining and burn rate
- [ ] Error Budget Policy document reviewed and approved by stakeholders
- [ ] SLO policy enforcer integrated into CI/CD deployment pipeline
- [ ] On-call runbooks link from alert annotations
- [ ] SLO review cadence established (weekly/monthly)

## Conclusion

SLO-based alerting transforms incident response from "is the error rate too high?" to "are we burning our reliability budget too fast?" This context makes alert priority immediately obvious: a 14x burn rate demands waking someone up at 3am, while a 1x burn rate can wait until morning.

Pyrra excels as an in-cluster operator where the SLO lifecycle is managed as Kubernetes resources. Sloth is better for GitOps workflows where PrometheusRules are generated in CI and applied declaratively. Both produce the same MWMBR alert structure; choose based on your operational model.

The error budget policy is what makes this system meaningful — without organizational agreement on what to do when budget runs low, the alerts are just noise. Define the policy before you deploy the tooling.
