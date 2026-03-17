---
title: "SLO Implementation: Error Budgets, Burn Rates, and Automated Responses"
date: 2028-02-05T00:00:00-05:00
draft: false
tags: ["SLO", "SLI", "Error Budgets", "Prometheus", "Grafana", "Sloth", "Observability", "SRE"]
categories:
- Observability
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to implementing SLOs with error budgets, multi-window burn rate alerting, Sloth-generated recording rules, and automated freeze policies using OpenSLO and Grafana."
more_link: "yes"
url: "/slo-implementation-error-budgets-burn-rates-automated-responses/"
---

Service Level Objectives are the contract between platform teams and the services they operate. Correctly implemented, they provide an objective signal for when to declare an incident, when to halt feature deployments, and when reliability work must be prioritized over new features. This guide covers the complete SLO lifecycle — from SLI definition through multi-window burn rate alerting, Sloth-generated recording rules, and automated error budget freeze policies.

<!--more-->

# SLO Implementation: Error Budgets, Burn Rates, and Automated Responses

## SLI, SLO, and SLA Definitions

These three acronyms are frequently conflated. Clear definitions prevent policy confusion:

**Service Level Indicator (SLI)**: A quantitative measure of service behavior. An SLI is a ratio of good events to total events over a measurement window. Examples: request success rate, latency below a threshold, data pipeline freshness.

**Service Level Objective (SLO)**: A target value or range for an SLI. An SLO states that the SLI must be at or above a given threshold for a defined compliance window. Example: 99.9% of HTTP requests return non-5xx responses over a 30-day rolling window.

**Service Level Agreement (SLA)**: A contractual commitment, typically between a service provider and customer, with financial penalties for violations. SLAs are typically less strict than internal SLOs — if the SLO is met, the SLA is almost always met.

The relationship: `SLA target < SLO target < actual performance`. A service with an SLO of 99.9% and SLA of 99.5% has a 0.4% buffer before contractual penalties.

## Error Budget Mechanics

An error budget is the inverse of the SLO: the allowed fraction of bad events over the compliance window.

```
error_budget = 1 - SLO_target

For 99.9% SLO over 30 days (43,200 minutes):
  error_budget_ratio = 0.001
  error_budget_minutes = 43,200 * 0.001 = 43.2 minutes of downtime allowed
  error_budget_requests = total_requests * 0.001
```

When the error budget is exhausted, the service is violating its SLO. At this point:

1. Feature development stops (no new risk added)
2. All engineering effort shifts to reliability improvement
3. Change freeze applies until budget recovers or is formally waived

## Defining SLIs in Prometheus

SLIs are expressed as Prometheus recording rules. The raw metric must be available before the SLI can be computed.

### Availability SLI (HTTP Success Rate)

```yaml
# recording-rules-sli-availability.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: sli-availability-order-service
  namespace: monitoring
  labels:
    # prometheus-operator uses this label to load rules
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: sli_availability_order_service
    interval: 30s
    rules:
    # Total request count — all outcomes
    - record: sli:http_requests:total5m
      expr: |
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce"
        }[5m]))

    # Good requests — non-5xx responses
    - record: sli:http_requests:good5m
      expr: |
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce",
          status!~"5.."
        }[5m]))

    # SLI ratio: good / total (windowed over 5m)
    - record: sli:http_availability:ratio5m
      expr: |
        sli:http_requests:good5m
        /
        sli:http_requests:total5m

    # Multi-window ratios required for burn rate alerting
    - record: sli:http_availability:ratio30m
      expr: |
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce",
          status!~"5.."
        }[30m]))
        /
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce"
        }[30m]))

    - record: sli:http_availability:ratio1h
      expr: |
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce",
          status!~"5.."
        }[1h]))
        /
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce"
        }[1h]))

    - record: sli:http_availability:ratio6h
      expr: |
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce",
          status!~"5.."
        }[6h]))
        /
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce"
        }[6h]))

    - record: sli:http_availability:ratio1d
      expr: |
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce",
          status!~"5.."
        }[1d]))
        /
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce"
        }[1d]))

    - record: sli:http_availability:ratio3d
      expr: |
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce",
          status!~"5.."
        }[3d]))
        /
        sum(rate(http_requests_total{
          job="order-service",
          namespace="commerce"
        }[3d]))
```

### Latency SLI (Histogram-Based)

```yaml
# recording-rules-sli-latency.yaml
spec:
  groups:
  - name: sli_latency_order_service
    rules:
    # Latency SLI: fraction of requests completing within 300ms
    # Uses histogram_quantile or ratio of bucket counts
    - record: sli:http_latency_300ms:ratio5m
      expr: |
        sum(rate(http_request_duration_seconds_bucket{
          job="order-service",
          le="0.3"
        }[5m]))
        /
        sum(rate(http_request_duration_seconds_count{
          job="order-service"
        }[5m]))

    - record: sli:http_latency_300ms:ratio1h
      expr: |
        sum(rate(http_request_duration_seconds_bucket{
          job="order-service",
          le="0.3"
        }[1h]))
        /
        sum(rate(http_request_duration_seconds_count{
          job="order-service"
        }[1h]))

    - record: sli:http_latency_300ms:ratio6h
      expr: |
        sum(rate(http_request_duration_seconds_bucket{
          job="order-service",
          le="0.3"
        }[6h]))
        /
        sum(rate(http_request_duration_seconds_count{
          job="order-service"
        }[6h]))

    - record: sli:http_latency_300ms:ratio1d
      expr: |
        sum(rate(http_request_duration_seconds_bucket{
          job="order-service",
          le="0.3"
        }[1d]))
        /
        sum(rate(http_request_duration_seconds_count{
          job="order-service"
        }[1d]))
```

## Error Budget Consumption Recording Rules

The error budget is computed relative to the SLO target. The burn rate measures how quickly the budget is being consumed relative to the sustainable rate.

```yaml
# recording-rules-error-budget.yaml
spec:
  groups:
  - name: error_budget_order_service
    rules:
    # SLO target (constant expression for use in arithmetic)
    # 99.9% availability = 0.999
    - record: slo:http_availability:target
      expr: "0.999"

    # Error budget ratio remaining over 30-day window
    # 1 = full budget, 0 = exhausted, negative = violated
    - record: slo:http_availability:error_budget_remaining
      expr: |
        1 - (
          (1 - sli:http_availability:ratio3d) / (1 - 0.999)
        )
        # Note: 3d is a proxy for 30d in this example.
        # For true 30d, Prometheus requires recording rules with
        # longer retention or external storage (Thanos/Cortex).

    # Burn rate: ratio of current error rate to sustainable error rate.
    # Burn rate 1.0 = consuming budget at exactly the sustainable rate.
    # Burn rate 14.4 = will exhaust 30d budget in 2 days (72h * 14.4 / 1440 = 0.72 days... )
    # Correct formula: burn_rate = error_rate / (1 - SLO_target)
    - record: slo:http_availability:burn_rate1h
      expr: |
        (1 - sli:http_availability:ratio1h) / (1 - 0.999)

    - record: slo:http_availability:burn_rate6h
      expr: |
        (1 - sli:http_availability:ratio6h) / (1 - 0.999)

    - record: slo:http_availability:burn_rate1d
      expr: |
        (1 - sli:http_availability:ratio1d) / (1 - 0.999)

    - record: slo:http_availability:burn_rate3d
      expr: |
        (1 - sli:http_availability:ratio3d) / (1 - 0.999)
```

## Multi-Window Burn Rate Alerting

Google's SRE workbook defines the multi-window burn rate alerting strategy. Single-window alerts either trigger too late (slow burn) or produce too much noise (fast burn). The multi-window approach uses two simultaneous windows to filter noise while maintaining sensitivity.

### The Four Alert Tiers

| Alert | Short Window | Long Window | Burn Rate | Budget Consumed | Time to Exhaustion |
|---|---|---|---|---|---|
| Page (critical) | 1h | 5m | 14.4x | 2% in 1h | 2 days |
| Page (critical) | 6h | 30m | 6x | 5% in 6h | 5 days |
| Ticket (warning) | 1d (24h) | 2h | 3x | 10% in 24h | 10 days |
| Ticket (warning) | 3d (72h) | 6h | 1x | 10% in 3d | 30 days |

```yaml
# alerting-rules-burn-rate.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-burn-rate-order-service
  namespace: monitoring
spec:
  groups:
  - name: slo_burn_rate_order_service
    rules:
    # Tier 1: Critical page — fast burn (14.4x), dual-window 1h + 5m
    - alert: SLOBurnRateCriticalFast
      expr: |
        (
          slo:http_availability:burn_rate1h > 14.4
          and
          # 5m burn rate requires a separate recording rule
          (1 - sli:http_availability:ratio5m) / (1 - 0.999) > 14.4
        )
      for: 1m
      labels:
        severity: critical
        slo: http_availability
        service: order-service
        team: commerce-platform
      annotations:
        summary: "Critical SLO burn rate on order-service"
        description: |
          order-service is burning error budget at {{ $value | humanize }}x the
          sustainable rate. At this pace, the 30-day error budget will be exhausted
          in {{ printf "%.1f" (div 720 $value) }} hours.
        runbook_url: "https://runbooks.example.com/slo/order-service-burn-rate"
        dashboard_url: "https://grafana.example.com/d/slo-order-service"

    # Tier 2: Critical page — moderate burn (6x), dual-window 6h + 30m
    - alert: SLOBurnRateCriticalModerate
      expr: |
        (
          slo:http_availability:burn_rate6h > 6
          and
          (1 - sli:http_availability:ratio30m) / (1 - 0.999) > 6
        )
      for: 1m
      labels:
        severity: critical
        slo: http_availability
        service: order-service
        team: commerce-platform
      annotations:
        summary: "Elevated SLO burn rate on order-service"
        description: |
          order-service has sustained {{ $value | humanize }}x burn rate over 6h.
          30-day budget exhaustion in approximately {{ printf "%.1f" (div 120 $value) }} hours.
        runbook_url: "https://runbooks.example.com/slo/order-service-burn-rate"

    # Tier 3: Warning ticket — slow burn (3x), dual-window 1d + 2h
    - alert: SLOBurnRateWarningDaily
      expr: |
        (
          slo:http_availability:burn_rate1d > 3
          and
          (1 - sli:http_availability:ratio2h) / (1 - 0.999) > 3
        )
      for: 1m
      labels:
        severity: warning
        slo: http_availability
        service: order-service
        team: commerce-platform
      annotations:
        summary: "Slow SLO burn rate on order-service — ticket required"
        description: |
          order-service burn rate {{ $value | humanize }}x over 24h.
          Budget exhaustion in approximately {{ printf "%.1f" (div 240 $value) }} hours if sustained.

    # Tier 4: Warning ticket — slow 30d burn (1x), dual-window 3d + 6h
    - alert: SLOBurnRateWarning30Day
      expr: |
        (
          slo:http_availability:burn_rate3d > 1
          and
          slo:http_availability:burn_rate6h > 1
        )
      for: 1m
      labels:
        severity: warning
        slo: http_availability
        service: order-service
        team: commerce-platform
      annotations:
        summary: "SLO burn rate exceeds sustainable rate on order-service"
        description: |
          order-service is burning error budget faster than it regenerates.
          Error budget remaining: {{ with query "slo:http_availability:error_budget_remaining" }}{{ . | first | value | humanizePercentage }}{{ end }}
```

## Sloth: Automated SLO Rule Generation

Sloth abstracts the complexity of generating multi-window recording rules and alerts from a simple SLO spec. It follows the OpenSLO specification and reduces manual rule management significantly.

### Installing Sloth

```bash
# Install Sloth CLI
curl -sSL https://github.com/slok/sloth/releases/download/v0.11.0/sloth-linux-amd64 \
  -o /usr/local/bin/sloth
chmod +x /usr/local/bin/sloth

# Or deploy as a Kubernetes controller
helm repo add sloth https://slok.github.io/sloth
helm upgrade --install sloth sloth/sloth \
  --namespace monitoring \
  --set commonLabels.team=platform
```

### Sloth SLO Spec

```yaml
# sloth-slo-order-service.yaml
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: order-service-availability
  namespace: monitoring
  labels:
    team: commerce-platform
    environment: production
spec:
  service: "order-service"
  labels:
    owner: commerce-platform
    tier: backend
  slos:
  # Availability SLO: 99.9% of requests succeed
  - name: "requests-availability"
    objective: 99.9
    description: "99.9% of order-service HTTP requests return non-5xx responses"
    sli:
      events:
        errorQuery: |
          sum(rate(http_requests_total{
            job="order-service",
            status=~"5.."
          }[{{.window}}]))
        totalQuery: |
          sum(rate(http_requests_total{
            job="order-service"
          }[{{.window}}]))
    alerting:
      name: "OrderServiceAvailability"
      labels:
        category: availability
      annotations:
        runbook: "https://runbooks.example.com/slo/order-service"
      pageAlert:
        labels:
          severity: critical
          pagerduty_service: commerce-critical
      ticketAlert:
        labels:
          severity: warning
          jira_project: RELENG

  # Latency SLO: 95% of requests complete within 300ms
  - name: "requests-latency-p95"
    objective: 95.0
    description: "95% of order-service requests complete within 300ms"
    sli:
      events:
        errorQuery: |
          sum(rate(http_request_duration_seconds_bucket{
            job="order-service",
            le="0.3"
          }[{{.window}}]))
          /
          sum(rate(http_request_duration_seconds_count{
            job="order-service"
          }[{{.window}}]))
          # Invert: errorQuery measures "bad" events (above threshold)
          # Sloth expects errorQuery to return error rate, not success rate
          # Use: 1 - (fast_requests / total_requests)
        totalQuery: |
          vector(1)
    alerting:
      name: "OrderServiceLatency"
      pageAlert:
        labels:
          severity: critical
      ticketAlert:
        labels:
          severity: warning
```

### Generating Rules from Sloth Spec

```bash
# Generate Prometheus recording rules and alerts from the SLO spec
sloth generate \
  --input sloth-slo-order-service.yaml \
  --output generated-slo-rules.yaml

# Apply to cluster (Sloth controller handles this automatically if deployed)
kubectl apply -f generated-slo-rules.yaml -n monitoring

# Validate generated rules
sloth validate --input sloth-slo-order-service.yaml

# Generate for multiple services from a directory
sloth generate \
  --input slo-specs/ \
  --output generated/ \
  --default-slo-period 30d
```

## OpenSLO Specification

OpenSLO is a vendor-neutral specification for defining SLOs. It enables tooling portability across Sloth, Dynatrace, Datadog, and other platforms.

```yaml
# openslo-spec.yaml
apiVersion: openslo/v1
kind: SLO
metadata:
  name: order-service-availability
  displayName: "Order Service Availability"
spec:
  service: order-service
  description: "Order service must successfully handle 99.9% of requests"
  budgetingMethod: Occurrences
  objectives:
  - displayName: "Good Responses"
    # ratioMetrics: good / total
    ratioMetrics:
      good:
        metricSource:
          type: Prometheus
          spec:
            query: |
              sum(rate(http_requests_total{
                job="order-service",
                status!~"5.."
              }[{{.window}}]))
      total:
        metricSource:
          type: Prometheus
          spec:
            query: |
              sum(rate(http_requests_total{
                job="order-service"
              }[{{.window}}]))
    target: 0.999
    timeSliceTarget: 0.999
    timeSliceWindow: 1m
  timeWindow:
  - count: 30
    unit: Day
    isRolling: true
  alertPolicies:
  - order-service-slo-alerts
```

## Grafana Error Budget Dashboards

```json
{
  "title": "SLO Error Budget Dashboard — Order Service",
  "uid": "slo-order-service-budget",
  "panels": [
    {
      "type": "gauge",
      "title": "Error Budget Remaining (30d)",
      "description": "Percentage of error budget remaining for the current 30-day window",
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "min": 0,
          "max": 1,
          "thresholds": {
            "steps": [
              { "value": 0, "color": "red" },
              { "value": 0.1, "color": "orange" },
              { "value": 0.25, "color": "yellow" },
              { "value": 0.5, "color": "green" }
            ]
          }
        }
      },
      "targets": [
        {
          "expr": "slo:http_availability:error_budget_remaining",
          "legendFormat": "Error Budget Remaining"
        }
      ]
    },
    {
      "type": "timeseries",
      "title": "Burn Rate (Multi-Window)",
      "description": "Current burn rate across 1h, 6h, 1d, 3d windows. Horizontal lines show alert thresholds.",
      "targets": [
        {
          "expr": "slo:http_availability:burn_rate1h",
          "legendFormat": "1h burn rate"
        },
        {
          "expr": "slo:http_availability:burn_rate6h",
          "legendFormat": "6h burn rate"
        },
        {
          "expr": "slo:http_availability:burn_rate1d",
          "legendFormat": "1d burn rate"
        },
        {
          "expr": "slo:http_availability:burn_rate3d",
          "legendFormat": "3d burn rate"
        }
      ]
    }
  ]
}
```

## Automated Error Budget Freeze Policy

When the error budget drops below a threshold, automated controls can halt risky changes. This example uses a Kubernetes operator pattern with a custom `DeploymentFreeze` CRD.

### Budget Monitor Script

```python
#!/usr/bin/env python3
"""
error_budget_monitor.py
Queries Prometheus for error budget status and creates/removes
DeploymentFreeze objects in Kubernetes when budget thresholds are crossed.
"""

import os
import time
import logging
from datetime import datetime, timezone
import requests
from kubernetes import client, config

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s'
)
log = logging.getLogger(__name__)

PROMETHEUS_URL = os.getenv("PROMETHEUS_URL", "http://prometheus:9090")
FREEZE_THRESHOLD = float(os.getenv("FREEZE_THRESHOLD", "0.05"))   # 5% budget remaining
RESUME_THRESHOLD = float(os.getenv("RESUME_THRESHOLD", "0.15"))   # 15% budget to resume
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "60"))              # seconds


def query_prometheus(query: str) -> float:
    """Execute an instant Prometheus query and return the scalar result."""
    resp = requests.get(
        f"{PROMETHEUS_URL}/api/v1/query",
        params={"query": query},
        timeout=10
    )
    resp.raise_for_status()
    data = resp.json()

    if data["status"] != "success":
        raise ValueError(f"Prometheus query failed: {data}")

    results = data["data"]["result"]
    if not results:
        # No data — assume budget is full (return 1.0) rather than triggering freeze
        log.warning("No data returned for query: %s", query)
        return 1.0

    return float(results[0]["value"][1])


def get_error_budget_remaining() -> float:
    """Return the fraction of error budget remaining (0.0 to 1.0+)."""
    return query_prometheus("slo:http_availability:error_budget_remaining")


def create_deployment_freeze(k8s_client: client.CustomObjectsApi, namespace: str, service: str):
    """Create a DeploymentFreeze custom resource to block deployments."""
    freeze_obj = {
        "apiVersion": "policy.example.com/v1alpha1",
        "kind": "DeploymentFreeze",
        "metadata": {
            "name": f"slo-budget-freeze-{service}",
            "namespace": namespace,
            "annotations": {
                "freeze.policy/reason": "error-budget-exhausted",
                "freeze.policy/triggered-at": datetime.now(timezone.utc).isoformat(),
                "freeze.policy/service": service,
            }
        },
        "spec": {
            "reason": "SLO error budget below 5% — deployments suspended",
            "affectedDeployments": [service],
            "autoExpiry": "72h",
            "severity": "critical"
        }
    }

    try:
        k8s_client.create_namespaced_custom_object(
            group="policy.example.com",
            version="v1alpha1",
            namespace=namespace,
            plural="deploymentfreezes",
            body=freeze_obj
        )
        log.info("Created DeploymentFreeze for service=%s", service)
    except client.ApiException as exc:
        if exc.status == 409:
            log.info("DeploymentFreeze already exists for service=%s", service)
        else:
            raise


def delete_deployment_freeze(k8s_client: client.CustomObjectsApi, namespace: str, service: str):
    """Remove the DeploymentFreeze to re-enable deployments."""
    try:
        k8s_client.delete_namespaced_custom_object(
            group="policy.example.com",
            version="v1alpha1",
            namespace=namespace,
            plural="deploymentfreezes",
            name=f"slo-budget-freeze-{service}"
        )
        log.info("Removed DeploymentFreeze for service=%s, deployments re-enabled", service)
    except client.ApiException as exc:
        if exc.status == 404:
            log.debug("No freeze to remove for service=%s", service)
        else:
            raise


def main():
    config.load_incluster_config()
    k8s = client.CustomObjectsApi()

    namespace = os.getenv("NAMESPACE", "commerce")
    service = os.getenv("SERVICE", "order-service")
    freeze_active = False

    log.info("Starting error budget monitor for service=%s, namespace=%s", service, namespace)
    log.info("Freeze threshold=%.1f%%, Resume threshold=%.1f%%",
             FREEZE_THRESHOLD * 100, RESUME_THRESHOLD * 100)

    while True:
        try:
            budget = get_error_budget_remaining()
            log.info("Error budget remaining: %.2f%%", budget * 100)

            if budget <= FREEZE_THRESHOLD and not freeze_active:
                log.warning(
                    "Budget %.2f%% <= threshold %.2f%% — activating freeze",
                    budget * 100, FREEZE_THRESHOLD * 100
                )
                create_deployment_freeze(k8s, namespace, service)
                freeze_active = True

            elif budget >= RESUME_THRESHOLD and freeze_active:
                log.info(
                    "Budget %.2f%% >= resume threshold %.2f%% — lifting freeze",
                    budget * 100, RESUME_THRESHOLD * 100
                )
                delete_deployment_freeze(k8s, namespace, service)
                freeze_active = False

        except Exception as exc:
            # Do not crash the monitor on transient errors
            log.error("Monitor iteration failed: %s", exc)

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
```

### Budget Monitor Deployment

```yaml
# error-budget-monitor-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: error-budget-monitor
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: error-budget-monitor
  template:
    metadata:
      labels:
        app: error-budget-monitor
    spec:
      serviceAccountName: error-budget-monitor
      containers:
      - name: monitor
        image: registry.example.com/error-budget-monitor:v1.2.0
        env:
        - name: PROMETHEUS_URL
          value: "http://prometheus-operated.monitoring.svc.cluster.local:9090"
        - name: NAMESPACE
          value: "commerce"
        - name: SERVICE
          value: "order-service"
        - name: FREEZE_THRESHOLD
          value: "0.05"
        - name: RESUME_THRESHOLD
          value: "0.15"
        - name: POLL_INTERVAL
          value: "60"
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 256Mi
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: error-budget-monitor
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: error-budget-monitor
rules:
- apiGroups: ["policy.example.com"]
  resources: ["deploymentfreezes"]
  verbs: ["get", "list", "create", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: error-budget-monitor
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: error-budget-monitor
subjects:
- kind: ServiceAccount
  name: error-budget-monitor
  namespace: monitoring
```

## SLO Review Process

Error budgets are only meaningful if the organization acts on them. A structured review cadence ensures SLOs remain accurate and that budget data drives engineering priorities.

### Weekly SLO Review Checklist

```markdown
# Weekly SLO Review Template

## Service: [service-name]
## Period: [week start] – [week end]
## Reviewer: [platform team lead]

### Budget Status
- [ ] Current budget remaining: __%
- [ ] Budget consumed this week: __%
- [ ] Projected exhaustion date (if trend continues): __

### Incident Analysis
For each SLO violation or burn spike during the week:
- Incident ID / date / duration
- Root cause (service bug, dependency failure, deployment, infrastructure)
- Was alert actionable? (yes/no)
- Was alert threshold appropriate? (too sensitive / appropriate / too loose)

### Reliability Work
- [ ] Incidents from this period have linked postmortems
- [ ] Action items from previous week reviewed
- [ ] New action items created for persistent burn contributors

### SLO Accuracy Review
- [ ] Is the SLI capturing the right user-impacting behavior?
- [ ] Should the SLO target be adjusted? (requires stakeholder approval)
- [ ] Are there any false-positive alerts to tune?

### Feature Freeze Status
- [ ] If budget < 10%, has feature freeze been communicated to product?
- [ ] If budget < 5%, has deployment freeze been activated?
- [ ] If budget > 50%, can deferred reliability work be scheduled?
```

### Error Budget Policy Document

```yaml
# error-budget-policy.yaml
# This manifest documents the error budget policy for audit purposes.
# It is NOT executable but serves as the authoritative policy definition.
apiVersion: v1
kind: ConfigMap
metadata:
  name: error-budget-policy-order-service
  namespace: commerce
  labels:
    type: slo-policy
    service: order-service
data:
  policy.md: |
    # Error Budget Policy: order-service

    ## SLO Target
    - Availability: 99.9% over 30-day rolling window
    - Latency p95: 300ms over 30-day rolling window

    ## Budget Thresholds and Actions

    | Budget Remaining | Action Required |
    |---|---|
    | > 50% | Normal development velocity |
    | 25–50% | Review reliability backlog; schedule items for next sprint |
    | 10–25% | Reliability items promoted to P1; no new risky deployments |
    | 5–10% | Feature freeze; on-call team notified; incident review required |
    | < 5% | Automated deployment freeze; escalate to VP Engineering |
    | < 0% | SLO violated; post-mortem required; SLA review if customer-impacting |

    ## Waiver Process
    Budget freeze can be waived for:
    - Critical security patches (VP Engineering approval required)
    - Revenue-blocking production bugs (Director approval required)
    All waivers must be recorded in the incident management system.

    ## Recovery Criteria
    Freeze lifts automatically when budget recovers to 15%.
    Manual lift requires Director of Engineering sign-off with reliability work plan.
```

## End-to-End Validation

After deploying all components, validate the SLO pipeline:

```bash
# Verify recording rules are loaded
kubectl exec -n monitoring deploy/prometheus-operator -- \
  curl -s 'http://localhost:9090/api/v1/rules' | \
  jq '.data.groups[].rules[] | select(.name | startswith("slo:"))'

# Check current error budget value
kubectl exec -n monitoring deploy/prometheus-operator -- \
  curl -sG 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=slo:http_availability:error_budget_remaining' | \
  jq '.data.result'

# Verify burn rate alerts are defined
kubectl get prometheusrule slo-burn-rate-order-service -n monitoring -o yaml | \
  yq '.spec.groups[].rules[] | select(.alert != null) | .alert'

# Simulate high error rate to test alerting (use with caution in staging only)
# kubectl exec -n commerce deploy/order-service -- \
#   /bin/sh -c 'for i in $(seq 1 1000); do curl -s localhost:8080/error; done'

# Verify Sloth-generated rules follow naming convention
kubectl get prometheusrule -n monitoring -l "sloth_service=order-service" -o yaml
```

The complete SLO stack — Prometheus recording rules for multi-window SLIs, Sloth-generated burn rate alerts, a Grafana error budget dashboard, and an automated freeze controller — provides a closed-loop reliability system. Error budget consumption becomes a first-class engineering signal that objectively drives prioritization decisions, replacing subjective judgment about when reliability work is warranted.
