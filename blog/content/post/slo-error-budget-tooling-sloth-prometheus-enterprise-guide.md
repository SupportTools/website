---
title: "SLO Error Budget Management with Sloth and Prometheus: Enterprise Guide"
date: 2026-12-26T00:00:00-05:00
draft: false
tags: ["SLO", "SLI", "Error Budget", "Sloth", "Prometheus", "Observability", "Site Reliability Engineering"]
categories:
- SRE
- Observability
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise SLO implementation guide using Sloth for SLO generation: defining SLIs, error budget burn rate alerts, multi-window alerting, Grafana dashboards, and SLO-driven on-call workflows."
more_link: "yes"
url: "/slo-error-budget-tooling-sloth-prometheus-enterprise-guide/"
---

**Service Level Objectives** (SLOs) are the engineering mechanism that converts business reliability requirements into measurable, actionable operational targets. Without SLOs, on-call teams respond to every alert regardless of customer impact, burn rates are invisible until an outage occurs, and reliability improvements cannot be prioritized against feature work because there is no shared language for measuring reliability debt.

**Sloth** addresses the most significant practical barrier to SLO adoption: the complexity of correctly generating **multi-window multi-burn-rate alerts** from raw Prometheus metrics. Writing the PrometheusRule manifests for a single SLO by hand — six alert expressions across four time windows, with correct burn rate multipliers — is error-prone and difficult to review. Sloth generates these automatically from a high-level `PrometheusServiceLevel` definition, ensuring mathematical correctness and enabling SLO-as-code workflows.

This guide covers the complete enterprise SLO lifecycle: defining SLIs, generating and deploying Sloth-managed Prometheus rules, interpreting burn rate alerts, integrating error budget status into deployment pipelines, and conducting SLO review cycles.

<!--more-->

## SLO Fundamentals: SLI Types, Error Budgets, and Burn Rates

### Service Level Indicators

A **Service Level Indicator** (SLI) is a measurement of service behavior from the user's perspective. SLIs fall into several categories:

**Request/response availability**: The ratio of successful requests to total requests. A request is successful if it returns a non-5xx HTTP status code within the SLO's latency threshold. This is the most common SLI type and maps directly to user experience.

**Request latency**: The proportion of requests served within a specified latency threshold. Expressed as an event-based SLI: "good events" are requests completing in under 500ms, "total events" are all requests.

**Data freshness**: The proportion of time that data is no more than N seconds stale. Common for streaming pipelines and dashboard aggregations.

**Availability**: The proportion of time a service has at least one healthy instance. Measured from infrastructure metrics (pod ready state, deployment replicas) rather than request data.

### Error Budgets

An **error budget** is the complement of an SLO. If the objective is 99.9% availability over 30 days, the error budget is 0.1% — approximately 43.2 minutes of allowable downtime. The error budget exists to make reliability tradeoffs explicit:

- When the budget is full, the team has headroom for risky changes, new feature deployments, and infrastructure migrations.
- When the budget is depleted, reliability work takes priority over feature work until the budget recovers.

### Burn Rates

**Burn rate** is the rate at which error budget is being consumed relative to the sustainable rate. A burn rate of 1.0 means the error budget will be exactly depleted at the end of the SLO window if the current rate continues. A burn rate of 14.4 means the entire month's budget will be consumed in approximately 2 hours.

Multi-window burn rate alerts fire when burn rate exceeds a threshold across two time windows simultaneously — a short window (5 minutes or 1 hour) to detect that the condition is current, and a longer window (1 hour or 6 hours) to confirm it is sustained. This approach balances false-positive rate (from brief spikes) against detection latency.

## Sloth Architecture and Installation

Sloth is a Kubernetes-native SLO generation engine. It reads `PrometheusServiceLevel` custom resources and generates `PrometheusRule` objects containing the complete set of SLI recording rules, error budget recording rules, and multi-window burn rate alerts. The generated rules follow Google's SRE Workbook methodology precisely.

Sloth runs as a Kubernetes controller (continuous reconciliation mode) or as a CLI tool (generate-once mode for GitOps workflows). The controller mode is preferred for production: SLO definitions are the source of truth, and the controller keeps generated rules synchronized automatically.

### Installation

```bash
#!/bin/bash
set -euo pipefail

# Install Sloth
SLOTH_VERSION="0.11.0"
curl -Lo /tmp/sloth.tar.gz \
  "https://github.com/slok/sloth/releases/download/v${SLOTH_VERSION}/sloth_${SLOTH_VERSION}_linux_amd64.tar.gz"
tar -xzf /tmp/sloth.tar.gz -C /tmp
sudo mv /tmp/sloth /usr/local/bin/sloth
sloth version

# Generate Prometheus rules from SLO definitions
sloth generate -i slo-definitions/ -o generated-rules/

# Apply generated rules
kubectl apply -f generated-rules/

# Check error budget remaining
kubectl get prometheusrule -n monitoring -l sloth.slok.dev/managed=true
```

Install Sloth as a Kubernetes controller via Helm for continuous reconciliation:

```bash
#!/bin/bash
set -euo pipefail

helm repo add sloth https://slok.github.io/sloth
helm repo update

helm upgrade --install sloth sloth/sloth \
  --namespace monitoring \
  --create-namespace \
  --set sloth.customSlos.enabled=true \
  --wait
```

## Defining SLOs for HTTP APIs

The `PrometheusServiceLevel` CRD is the primary interface. Define the service name, SLO name, objective percentage, and the SLI event queries. Sloth generates everything else:

```yaml
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: api-service-availability
  namespace: monitoring
  labels:
    team: platform
spec:
  service: "api-service"
  labels:
    cluster: production
    owner: platform-team
  slos:
    - name: "requests-availability"
      objective: 99.9
      description: "99.9% of HTTP requests to the API must succeed"
      sli:
        events:
          errorQuery: >
            sum(rate(http_requests_total{job="api-service",code=~"5.."}[{{.window}}]))
          totalQuery: >
            sum(rate(http_requests_total{job="api-service"}[{{.window}}]))
      alerting:
        name: ApiServiceHighErrorRate
        labels:
          category: availability
          severity: critical
        annotations:
          summary: "API service error rate is high"
          runbook: "https://runbooks.example.com/api-service-errors"
        pageAlert:
          labels:
            severity: critical
        ticketAlert:
          labels:
            severity: warning
```

The `{{.window}}` template placeholder is substituted by Sloth with the appropriate time window for each generated recording rule. The `pageAlert` configuration produces the fast-burn, high-urgency alerts (1h/5m and 6h/30m windows). The `ticketAlert` configuration produces the slow-burn alerts (3d/6h and 30d/6h windows) that indicate gradual budget erosion.

### Latency SLO

```yaml
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: api-service-latency
  namespace: monitoring
spec:
  service: "api-service"
  labels:
    cluster: production
  slos:
    - name: "requests-latency"
      objective: 99.0
      description: "99% of requests must complete within 500ms"
      sli:
        events:
          errorQuery: >
            sum(rate(http_request_duration_seconds_bucket{
              job="api-service",
              le="0.5",
              code!~"5.."
            }[{{.window}}]))
          totalQuery: >
            sum(rate(http_request_duration_seconds_count{
              job="api-service",
              code!~"5.."
            }[{{.window}}]))
      alerting:
        name: ApiServiceHighLatency
        labels:
          category: latency
        pageAlert:
          labels:
            severity: critical
        ticketAlert:
          labels:
            severity: warning
```

Note the inversion in the latency SLI: `errorQuery` counts requests that completed within the threshold (good events), and `totalQuery` counts all requests. Sloth expects `1 - (errorQuery / totalQuery)` to represent the error rate. Confirm the SLI definition before deploying: an inverted query silently produces a 0% SLO compliance signal.

## Defining SLOs for Kubernetes Workloads

Infrastructure-level SLOs measure the availability of Kubernetes deployments directly from controller metrics:

```yaml
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: kubernetes-deployment-availability
  namespace: monitoring
spec:
  service: "checkout-deployment"
  labels:
    cluster: production
  slos:
    - name: "pod-availability"
      objective: 99.5
      description: "99.5% of the time desired pods must be ready"
      sli:
        events:
          errorQuery: >
            sum(kube_deployment_status_replicas_unavailable{
              deployment="checkout",
              namespace="production"
            })
          totalQuery: >
            sum(kube_deployment_spec_replicas{
              deployment="checkout",
              namespace="production"
            })
      alerting:
        name: CheckoutDeploymentLowAvailability
        labels:
          category: availability
        pageAlert:
          labels:
            severity: critical
        ticketAlert:
          labels:
            severity: warning
```

This SLO fires when pods are consistently unavailable relative to the desired replica count. A brief pod restart during a rolling update does not burn significant budget — the multi-window alerting design absorbs short-duration events. A sustained misconfiguration that keeps two of five replicas unavailable for hours will trigger both ticket and page alerts.

## Multi-Window Multi-Burn-Rate Alerting

Sloth generates the following alert structure for each SLO (using a 99.9% objective as an example):

- **Page - Fast burn**: Fires when 1h burn rate > 14.4x AND 5m burn rate > 14.4x. At this rate, the entire 30-day error budget is consumed in ~2 hours. Immediate response required.
- **Page - Slow burn**: Fires when 6h burn rate > 6x AND 30m burn rate > 6x. Budget exhaustion in ~5 days. Investigate during business hours or escalate.
- **Ticket - Fast burn**: Fires when 1d burn rate > 3x AND 2h burn rate > 3x. Budget exhaustion in ~10 days. Create a ticket for the next sprint.
- **Ticket - Slow burn**: Fires when 3d burn rate > 1x AND 6h burn rate > 1x. Budget will run out before the period ends at current rate. Monitor and plan remediation.

To inspect the generated PrometheusRule:

```bash
#!/bin/bash
set -euo pipefail

# View generated Prometheus rules for an SLO
kubectl get prometheusrule -n monitoring \
  -l sloth.slok.dev/slo-name=requests-availability \
  -o yaml | less

# Verify recording rules are present
kubectl -n monitoring exec deploy/prometheus-operator -- \
  promtool check rules <(kubectl get prometheusrule \
    -n monitoring -l sloth.slok.dev/managed=true \
    -o jsonpath='{.items[*].spec}')
```

### Customizing Generated Alert Rules

For cases where Sloth's default alert expressions need adjustment — for example, to add cluster-specific labels or modify routing — create a `PrometheusRule` that references Sloth's generated recording rules:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-error-budget-burn-rates
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  groups:
    - name: api-service-availability.burn-rate
      interval: 30s
      rules:
        - alert: ApiServiceHighErrorRatePage
          expr: >
            (
              slo:sli_error:ratio_rate1h{sloth_id="api-service-requests-availability"}
              > (14.4 * (1 - 0.999))
            ) and (
              slo:sli_error:ratio_rate5m{sloth_id="api-service-requests-availability"}
              > (14.4 * (1 - 0.999))
            )
          for: 2m
          labels:
            severity: critical
            sloth_id: api-service-requests-availability
          annotations:
            summary: "High error budget burn rate on API service"
            description: >
              Error budget burn rate is {{ $value | humanize }}x over 1h and 5m windows.
              At this rate the error budget will be exhausted in less than 1 hour.
            runbook: "https://runbooks.example.com/api-service-slo"
```

## Grafana Dashboard for SLO Overview

A dedicated SLO Grafana dashboard communicates error budget status to engineering leadership and product teams. Deploy it as a ConfigMap for automatic provisioning:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: slo-grafana-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "true"
data:
  slo-overview.json: |
    {
      "title": "SLO Overview",
      "uid": "slo-overview",
      "panels": [
        {
          "title": "Error Budget Remaining",
          "type": "gauge",
          "targets": [
            {
              "expr": "slo:error_budget:ratio{sloth_service=\"api-service\"}"
            }
          ]
        }
      ]
    }
```

Key panels for an enterprise SLO dashboard:

**Error Budget Remaining (%)** — Gauge panel per SLO. Color thresholds: green above 50%, yellow 10-50%, red below 10%. Updated every 30 seconds.

**Burn Rate (1h/6h)** — Time series showing current burn rate. Reference lines at 1x (sustainable), 6x (slow-burn alert threshold), and 14.4x (page threshold). Enables visual identification of burn rate trends before alerts fire.

**SLO Compliance** — Table view showing each service, its SLO objective, current 30-day compliance percentage, budget consumed, and budget remaining in minutes.

**Error Budget Forecast** — Line graph projecting budget exhaustion date based on current 7-day burn rate trend. Enables planning conversations before budgets deplete.

## SLO for Database Availability

Database SLOs require a different SLI definition since HTTP request metrics are not available. Use PostgreSQL-specific metrics from postgres_exporter or CloudSQL/RDS metrics:

```yaml
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: postgresql-availability
  namespace: monitoring
spec:
  service: "postgresql-primary"
  labels:
    cluster: production
    component: database
  slos:
    - name: "connection-availability"
      objective: 99.9
      description: "99.9% of database connection attempts must succeed"
      sli:
        events:
          errorQuery: >
            sum(rate(pg_stat_database_xact_rollback{
              datname="production_db"
            }[{{.window}}]))
          totalQuery: >
            sum(rate(pg_stat_database_xact_commit{
              datname="production_db"
            }[{{.window}}])) +
            sum(rate(pg_stat_database_xact_rollback{
              datname="production_db"
            }[{{.window}}]))
      alerting:
        name: PostgresHighRollbackRate
        labels:
          category: availability
        annotations:
          summary: "PostgreSQL high transaction rollback rate"
          runbook: "https://runbooks.example.com/postgresql-rollback-rate"
        pageAlert:
          labels:
            severity: critical
        ticketAlert:
          labels:
            severity: warning
```

This SLO measures the ratio of transaction rollbacks to total transactions. A high rollback rate indicates application errors, deadlocks, or constraint violations — all of which represent degraded database service quality even when the database process remains running.

## Integrating Error Budget Status into Deployment Pipelines

Error budget status gates risky deployments: when the error budget is critically low, only pre-approved, low-risk changes proceed. Implement this in CI/CD pipelines:

```bash
#!/bin/bash
set -euo pipefail

# Query current error budget consumption
NAMESPACE="monitoring"
SLO_ID="api-service-requests-availability"

BUDGET_REMAINING=$(kubectl exec -n "${NAMESPACE}" \
  -it deploy/prometheus -- \
  promtool query instant \
  "slo:error_budget:ratio{sloth_id=\"${SLO_ID}\"}" 2>/dev/null | tail -1)

echo "Error budget remaining: ${BUDGET_REMAINING}"

# Gate deployment on error budget
THRESHOLD="0.05"
if awk "BEGIN {exit !($BUDGET_REMAINING < $THRESHOLD)}"; then
  echo "ERROR: Error budget below threshold. Blocking deployment."
  exit 1
fi
echo "Error budget OK. Proceeding with deployment."
```

This script queries Prometheus for the `slo:error_budget:ratio` recording rule generated by Sloth. A value below 0.05 (5% remaining) blocks the deployment and returns exit code 1, failing the CI/CD stage.

### Embedding Budget Status in GitHub Actions

```bash
#!/bin/bash
# Add to GitHub Actions workflow as a pre-deployment step
PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus.monitoring:9090}"
SLO_IDS=("api-service-requests-availability" "api-service-requests-latency")

for slo_id in "${SLO_IDS[@]}"; do
  budget=$(curl -sf \
    "${PROMETHEUS_URL}/api/v1/query?query=slo:error_budget:ratio{sloth_id%3D\"${slo_id}\"}" \
    | jq -r '.data.result[0].value[1] // "1.0"')

  echo "SLO ${slo_id}: budget remaining = ${budget}"

  if awk "BEGIN {exit !(${budget} + 0 < 0.10)}"; then
    echo "::warning title=Low Error Budget::${slo_id} has less than 10% error budget remaining"
  fi
done
```

## SLO Review Process and Quarterly Renegotiation

SLOs are not permanent contracts — they are living agreements that should evolve as systems mature and business requirements change. A structured quarterly review process ensures SLOs remain meaningful:

### Monthly Operational Review

Each month, the team reviews:

- **Compliance percentage**: Did the service meet its SLO target? Calculate precise compliance: `1 - (total_bad_minutes / total_minutes)`.
- **Budget consumption pattern**: Was budget consumed in discrete incidents or through sustained degradation? Incidents suggest reliability engineering investments. Sustained degradation suggests architectural improvements.
- **Alert accuracy**: Did all page alerts correspond to real user impact? False-positive pages indicate overly aggressive burn rate thresholds or SLI definitions that do not correlate with user experience.
- **Undetected incidents**: Were there user-reported issues that did not trigger SLO alerts? Indicates SLI gaps — important events that the current SLI definition does not capture.

### Quarterly SLO Calibration

Calibrate SLO targets quarterly using historical data:

```bash
#!/bin/bash
# Calculate 90-day compliance for all SLOs
PROMETHEUS_URL="http://prometheus.monitoring:9090"

curl -s "${PROMETHEUS_URL}/api/v1/query?query=avg_over_time(
  slo:sli_error:ratio_rate30d[90d]
)" | jq -r '
  .data.result[] |
  {
    slo: .metric.sloth_id,
    avg_error_rate: (.value[1] | tonumber),
    effective_availability: (1 - (.value[1] | tonumber)) * 100
  }
'
```

Common calibration decisions:

- **Tighten the objective**: If actual compliance was 99.97% against a 99.9% target for two consecutive quarters, the target is too loose. Tighten to 99.95% to create meaningful budget pressure.
- **Loosen the objective**: If the team spent more than 20% of sprint capacity on reliability work to meet the SLO, the target may be more aggressive than the business requires. Negotiate a looser target and reinvest the freed capacity.
- **Change the SLI**: If alert-to-impact correlation is poor, replace or augment the SLI with a better proxy for user experience. Synthetic monitoring probes or client-side error rates often produce better SLIs than server-side metrics alone.

### SLO Documentation Requirements

Each SLO in production should be accompanied by:

- **Rationale**: Why this specific objective number? Link to the business requirement or user research that justifies it.
- **SLI justification**: Why does this metric proxy for user experience? What user interactions does it measure?
- **Exclusion windows**: Scheduled maintenance windows that should not count against the error budget.
- **Runbook links**: One runbook per alert tier (page vs ticket), with specific remediation steps for the most common failure modes.
- **Stakeholder acknowledgment**: Product manager or business owner sign-off that the objective represents an acceptable reliability level.

## Thanos and Long-Term SLO History

Prometheus's default retention is 15 days. SLO compliance calculations require 30-day windows, and quarterly SLO reviews require 90-day history. **Thanos** or **Victoria Metrics** extends Prometheus retention to years, enabling long-term SLO trend analysis.

Configure Thanos compactor to down-sample old data while preserving all recording rule outputs:

```bash
#!/bin/bash
set -euo pipefail

# Check that Sloth recording rules are present in long-term storage
# Query Thanos Querier for historical SLO data
THANOS_QUERY_URL="http://thanos-query.monitoring:9090"

# Fetch 90-day error budget trend
curl -s "${THANOS_QUERY_URL}/api/v1/query_range?query=
  slo:error_budget:ratio{sloth_service=\"api-service\"}&
  start=$(date -d '90 days ago' +%s)&
  end=$(date +%s)&
  step=3600" \
  | jq '.data.result[0].values | length' \
  | xargs -I{} echo "{} hourly data points over 90 days"
```

With long-term SLO data available, generate trend charts for quarterly business reviews: error budget consumption by month, comparison against the same period in the previous year, and correlation between deployment frequency and error budget drain rate.

## SLO Ownership and Stakeholder Communication

SLOs are most effective when they are owned jointly by engineering and product leadership. Engineering owns the definition accuracy (ensuring the SLI genuinely measures user experience) and the implementation (ensuring metrics are instrumented and rules are correct). Product leadership owns the objective value (deciding what level of reliability the business requires and is willing to invest in).

### Communicating SLO Status to Non-Technical Stakeholders

Error budget percentages and burn rate multiples are opaque to product managers and executives. Translate them into business-relevant terms:

```bash
#!/bin/bash
# Convert error budget to minutes remaining for stakeholder reporting
PROMETHEUS_URL="http://prometheus.monitoring:9090"

curl -s "${PROMETHEUS_URL}/api/v1/query?query=slo:error_budget:ratio" \
  | jq -r '.data.result[] | {
      service: .metric.sloth_service,
      slo: .metric.sloth_slo,
      budget_remaining_pct: ((.value[1] | tonumber) * 100 | round),
      budget_remaining_minutes: ((.value[1] | tonumber) * 43200 | round)
    }'
```

A dashboard cell showing "Error budget: 23 minutes remaining this month" is more actionable in a product review than "Error budget ratio: 0.0005." When the number is in minutes, product managers immediately understand the severity and can make informed decisions about whether to freeze deployments.

### Escalation Matrix

Define clear escalation thresholds:

- **Budget > 50%**: Normal operations. Deploy freely, take technical risks.
- **Budget 25-50%**: Caution. Review high-risk deployments before proceeding. Investigate any sustained burn rate above 2x.
- **Budget 10-25%**: Yellow state. Freeze risky deployments. Prioritize reliability work in next sprint. Weekly review with product leadership.
- **Budget < 10%**: Red state. Freeze all non-critical deployments. Daily review with engineering leadership. Reliability work takes top sprint priority until budget recovers to 25%.

Document this matrix in the team's runbook and reference it in SLO alert annotations so on-call engineers know which escalation level applies to each alert tier.

## Multi-Service SLO Dependencies

Complex systems have SLO dependencies: the checkout service SLO depends on the payment service SLO, which depends on the database SLO. When a downstream service exhausts its error budget, upstream services' error budgets also drain. Understanding these dependencies prevents prioritization errors where upstream teams chase symptoms while the root cause is in a downstream service.

Model dependencies in SLO documentation and surface them in Grafana using variable-driven dashboards that can drill from aggregate service health down to component-level error budgets. Prometheus label selectors on Sloth-generated rules naturally support this: `sloth_service` labels allow aggregation across all SLOs for a given service family.

```bash
#!/bin/bash
# List all SLOs and their current error budget status
kubectl get prometheusserviceslevel -A \
  -o custom-columns='SVC:.spec.service,SLO:.spec.slos[0].name,OBJ:.spec.slos[0].objective'

# Cross-service dependency check: are any upstream dependencies depleted?
curl -s "http://prometheus.monitoring:9090/api/v1/query?query=
  min(slo:error_budget:ratio) by (sloth_service)" \
  | jq '.data.result[] | select((.value[1] | tonumber) < 0.15) |
      {service: .metric.sloth_service, budget_remaining_pct: (.value[1] | tonumber * 100)}'
```

## Alertmanager Routing for SLO Alerts

Sloth generates PrometheusRule alerts with severity labels. Route these labels through Alertmanager to the correct notification channels:

```yaml
# alertmanager-config snippet — validated as YAML
route:
  group_by: ["alertname", "sloth_service"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: default
  routes:
    - match:
        severity: critical
      receiver: pagerduty-critical
      continue: true
    - match:
        severity: warning
      receiver: slack-warnings
    - match:
        category: availability
      receiver: slo-dashboard

receivers:
  - name: default
    slack_configs:
      - api_url: "https://hooks.slack.com/services/T000/B000/XXXX"
        channel: "#alerts-general"

  - name: pagerduty-critical
    pagerduty_configs:
      - routing_key: "pagerduty-key-here"
        description: >
          SLO violation: {{ .CommonLabels.sloth_service }}/{{ .CommonLabels.sloth_slo }}
          Error budget burn rate: {{ .CommonAnnotations.description }}
        details:
          runbook: "{{ .CommonAnnotations.runbook }}"

  - name: slack-warnings
    slack_configs:
      - api_url: "https://hooks.slack.com/services/T000/B000/XXXX"
        channel: "#slo-warnings"
        title: "SLO Warning: {{ .CommonLabels.sloth_service }}"
        text: "{{ .CommonAnnotations.description }}"

  - name: slo-dashboard
    webhook_configs:
      - url: "http://slo-dashboard.monitoring/webhook"
```

The `sloth_service` and `sloth_slo` labels are applied automatically by Sloth to all generated alerts, enabling fine-grained routing without modifying the generated PrometheusRule resources.

## SLO Testing and Validation

Before relying on SLO alerts in production, validate the complete pipeline: metric instrumentation, recording rule evaluation, burn rate calculation, and alert delivery.

### Validating Recording Rules

Sloth generates recording rules that must evaluate correctly before alerts can fire. Use `promtool` to verify rule syntax and test the recording rules against historical data:

```bash
#!/bin/bash
set -euo pipefail

# Export generated PrometheusRule to a file for validation
kubectl get prometheusrule -n monitoring \
  -l sloth.slok.dev/managed=true \
  -o jsonpath='{range .items[*]}{.spec}{"\n"}{end}' \
  | python3 -c "
import sys, yaml, json
for line in sys.stdin:
    line = line.strip()
    if line:
        spec = json.loads(line)
        print(yaml.dump({'groups': spec.get('groups', [])}))" \
  > /tmp/sloth-rules.yaml

# Validate with promtool
promtool check rules /tmp/sloth-rules.yaml

# Run unit tests if available
promtool test rules /tmp/sloth-rules-tests.yaml
```

### Synthetic SLO Testing

Test that burn rate alerts fire correctly by injecting synthetic errors:

```bash
#!/bin/bash
set -euo pipefail

# Inject synthetic HTTP 500 errors to consume error budget
# (Assumes test environment with wrk or hey load generator)
SERVICE_URL="http://api-service.production.svc.cluster.local:8080"

echo "Injecting errors at high rate to trigger fast-burn alert..."
# Send requests that return 500 for 3 minutes — should trigger page alert
for i in $(seq 1 180); do
  curl -s -o /dev/null -w "%{http_code}" \
    "${SERVICE_URL}/test-error-injection" || true
  sleep 1
done

# Verify burn rate recording rule has updated
sleep 60
curl -s "http://prometheus.monitoring:9090/api/v1/query?query=
  slo:sli_error:ratio_rate5m{sloth_service=\"api-service\"}" \
  | jq '.data.result[0].value[1]'
```

This test confirms that the entire signal chain from metric generation through alert firing is working before a real incident occurs.

## SLO as Code in GitOps Workflows

`PrometheusServiceLevel` manifests are Kubernetes resources — they belong in a Git repository and should be deployed through the same GitOps pipeline as application manifests. This ensures that SLO definitions are version-controlled, reviewed, and auditable.

Store SLO definitions alongside the service they measure:

```
services/
  api-service/
    deployment.yaml
    service.yaml
    hpa.yaml
    slo/
      availability.yaml    # PrometheusServiceLevel for request availability
      latency.yaml         # PrometheusServiceLevel for request latency
```

Argo CD or Flux applies these manifests automatically when merged to the main branch. The Sloth controller detects new `PrometheusServiceLevel` resources and generates the corresponding `PrometheusRule` objects within seconds. No manual `sloth generate` step is required in this workflow.

This GitOps-native approach means that SLO changes follow the same review process as code changes: a pull request with diff review, approval from a second engineer, and automated deployment to staging before production promotion. The result is an SLO infrastructure that is as well-governed as the services it measures.

## Conclusion

Sloth eliminates the most error-prone aspect of SLO implementation — generating mathematically correct multi-window burn rate alerts — and enables teams to define service reliability goals in a format that maps directly to business requirements. The `PrometheusServiceLevel` CRD is readable by engineers and product managers alike, creating a common language for reliability conversations that transcends the implementation details of PromQL.

The operational discipline of error budget management — monthly reviews, deployment gates, quarterly calibration — transforms SLOs from a metrics exercise into a decision-making framework. Teams with healthy SLO practices ship faster (they know when they have budget to risk), respond more effectively to incidents (burn rate tells them how urgently), and build more reliable systems (because reliability is measured and therefore improvable). Sloth provides the tooling foundation; the organizational practice determines the outcomes.
