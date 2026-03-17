---
title: "Kubernetes Cost Attribution with OpenCost: Namespace and Label-Based Chargeback"
date: 2031-03-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenCost", "FinOps", "Cost Management", "Chargeback", "Grafana", "Prometheus"]
categories:
- Kubernetes
- FinOps
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying OpenCost for Kubernetes cost attribution, covering the allocation model, custom cost labels, idle cost distribution, external cloud cost integration, and Grafana dashboards for executive-level chargeback reporting."
more_link: "yes"
url: "/kubernetes-cost-attribution-opencost-namespace-label-chargeback/"
---

Kubernetes cost visibility is a FinOps prerequisite that most organizations defer until cloud bills become impossible to explain. By the time finance asks "which team is spending $80,000 on GPU nodes this month?", the answer requires weeks of log analysis. OpenCost solves this by providing real-time, Kubernetes-native cost attribution that maps resource consumption to business units, teams, and applications using the label taxonomy already on your workloads.

This guide covers the complete OpenCost deployment: integration with Prometheus, the allocation model for CPU/RAM/GPU/storage costs, configuring custom labels for multi-dimensional chargeback, handling idle resource costs, integrating cloud provider pricing, and building the Grafana dashboards that translate bytes and millicores into dollars for engineering managers and finance teams.

<!--more-->

# Kubernetes Cost Attribution with OpenCost: Namespace and Label-Based Chargeback

## Section 1: OpenCost Architecture and Concepts

### How OpenCost Calculates Costs

OpenCost allocates costs through three steps:

1. **Resource Measurement**: Queries Prometheus for actual CPU/RAM/GPU/PV usage metrics
2. **Price Application**: Applies node pricing (from cloud provider APIs or custom pricing) to compute per-resource costs
3. **Allocation**: Distributes costs to the organizational unit (namespace, label, deployment) that requested or used the resources

The allocation model handles the fundamental challenge of shared resources: when a pod requests 500m CPU on a node with 10% idle capacity, who pays for that idle capacity?

```
Node cost: $200/day
├── Pod-A requests: 2 CPU, 4GB RAM  → allocated $40/day
├── Pod-B requests: 1 CPU, 2GB RAM  → allocated $20/day
├── Pod-C requests: 1 CPU, 2GB RAM  → allocated $20/day
└── Idle (6 CPU, 24GB available but unused) → $120/day
                                              (distributed or shown separately)
```

### Cost Dimensions

OpenCost tracks costs across:
- **CPU cost**: Based on requested vs. used, weighted by node price
- **RAM cost**: Memory requested vs. used
- **GPU cost**: GPU cards allocated to pods
- **PV cost**: Persistent volume storage provisioned
- **Network cost**: Egress/ingress (requires cloud provider integration)
- **LoadBalancer cost**: Service LoadBalancer charges

## Section 2: Deployment and Prerequisites

### Prerequisites

```bash
# Verify Prometheus is available (required for metrics)
kubectl get services -n monitoring | grep prometheus

# Check metrics are being scraped
curl -s "http://prometheus:9090/api/v1/query" \
  --data-urlencode 'query=kube_pod_container_resource_requests{resource="cpu"}' | \
  jq '.data.result | length'

# Required Prometheus metrics for OpenCost:
# - kube_pod_container_resource_requests
# - kube_pod_container_resource_limits
# - kube_node_status_capacity
# - kube_node_status_allocatable
# - container_cpu_usage_seconds_total
# - container_memory_working_set_bytes
# - kube_persistentvolumeclaim_info
# - kube_persistentvolume_capacity_bytes
```

### Installing OpenCost with Helm

```bash
# Add OpenCost Helm repository
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update

# Create namespace
kubectl create namespace opencost

# Install OpenCost with Prometheus integration
helm install opencost opencost/opencost \
  --namespace opencost \
  --version 1.30.0 \
  -f opencost-values.yaml
```

### OpenCost Helm Values

```yaml
# opencost-values.yaml
opencost:
  exporter:
    # Default cloud provider pricing
    defaultCloudBackend:
      projectID: ""
      # Use "aws" for AWS, "gcp" for GCP, "azure" for Azure
      # or "custom" for on-premises/custom pricing
      type: aws

    # AWS pricing configuration
    aws:
      region: us-east-1
      # Spot pricing integration
      spotLabel: "eks.amazonaws.com/capacityType"
      spotLabelValue: "SPOT"

    # Prometheus configuration
    prometheus:
      # Internal Prometheus URL
      internal:
        enabled: true
        namespaceName: monitoring
        port: 9090
        serviceName: prometheus-operated

    # Cost allocation settings
    allocation:
      # Default idle cost allocation: none, share, hide
      defaultIdleAllocation: share
      # Aggregate idle costs proportionally to actual usage

    # Custom pricing overrides (for on-prem or reserved instances)
    pricingConfigs:
      enabled: true
      configPath: /var/configs/pricing

    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: "1"
        memory: 1Gi

  ui:
    enabled: true
    resources:
      requests:
        cpu: 10m
        memory: 55Mi

  # Prometheus metrics scraping for cost metrics
  metrics:
    serviceMonitor:
      enabled: true
      namespace: monitoring
      additionalLabels:
        release: prometheus-stack

  # Persistent storage for historical data
  persistentVolume:
    enabled: true
    size: 32Gi
    storageClass: fast-ssd

# RBAC for accessing Kubernetes resources
serviceAccount:
  create: true
  annotations: {}
  name: opencost
```

```bash
# Apply the installation
helm upgrade --install opencost opencost/opencost \
  --namespace opencost \
  -f opencost-values.yaml \
  --wait

# Verify deployment
kubectl get pods -n opencost
kubectl logs -n opencost deployment/opencost --tail=50

# Port-forward to access OpenCost UI
kubectl port-forward -n opencost service/opencost 9090:9090 9003:9003
# UI: http://localhost:9090
# API: http://localhost:9003
```

## Section 3: Allocation Model Configuration

### Request vs. Usage Allocation

OpenCost defaults to request-based allocation (charges based on what the pod requested, not what it actually used). This incentivizes accurate resource requests and prevents gaming the system.

```yaml
# opencost-allocation-config.yaml
# Configure allocation behavior via ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: opencost-conf
  namespace: opencost
data:
  # Allocation model: request or usage
  # request: allocate based on resource requests (default)
  # usage: allocate based on actual consumption
  allocationModel: request

  # Weight for request vs usage blend (0=request, 1=usage, 0.5=50/50)
  # Useful for teams that have accurate requests but want usage accountability
  allocationBlendWeight: "0.0"

  # How to handle CPU limits (when limits are set)
  # max: use max(request, limit) for allocation
  # request: use request only
  cpuAllocationModel: request

  # Memory allocation
  ramAllocationModel: request
```

### Custom Pricing for On-Premises Clusters

For on-premises clusters or when you need to model fully-loaded costs:

```json
// custom-pricing.json
{
  "provider": "custom",
  "description": "On-premises k8s cluster pricing",
  "CPU": "0.031611",
  "RAM": "0.004237",
  "GPU": "1.950000",
  "storage": "0.000138",
  "customPricesEnabled": "true",
  "defaultIdle": "true",
  "spotLabel": "",
  "spotLabelValue": "",
  "projectID": "on-prem-cluster",

  "nodeConfigs": [
    {
      "instanceType": "bare-metal-high-cpu",
      "cpu": "0.05",
      "ram": "0.007",
      "spotInstanceType": false,
      "region": "datacenter-1"
    },
    {
      "instanceType": "gpu-node",
      "cpu": "0.04",
      "ram": "0.006",
      "gpu": "2.50",
      "spotInstanceType": false,
      "region": "datacenter-1"
    }
  ]
}
```

```bash
# Create ConfigMap from pricing file
kubectl create configmap opencost-custom-pricing \
  --from-file=pricing.json=custom-pricing.json \
  -n opencost

# Reference in deployment
kubectl set env deployment/opencost \
  CONFIG_PATH=/var/configs/pricing/pricing.json \
  -n opencost
```

### AWS Spot and Reserved Instance Pricing

```yaml
# opencost-values.yaml additions for AWS pricing
opencost:
  exporter:
    aws:
      region: us-east-1
      # Tag used to identify spot instances
      spotLabel: "eks.amazonaws.com/capacityType"
      spotLabelValue: "SPOT"
      # Reserved instance discount (applied to on-demand price)
      reserved:
        enabled: true
        # Use AWS Cost Explorer for actual reserved instance pricing
        costExplorerAPIEnabled: true

    # Service account with Cost Explorer permissions
    serviceAccount:
      annotations:
        eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/opencost-cost-explorer
```

IAM policy for AWS Cost Explorer integration:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ce:GetProducts",
        "ce:GetCostAndUsage",
        "ce:GetUsageForecast",
        "pricing:GetProducts",
        "pricing:DescribeServices"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeReservedInstances",
        "ec2:DescribeSpotInstanceRequests"
      ],
      "Resource": "*"
    }
  ]
}
```

## Section 4: Custom Cost Labels for Chargeback

### Label Taxonomy Design

Before configuring OpenCost, establish a label taxonomy that maps to your organizational structure:

```yaml
# Recommended label schema for enterprise chargeback
metadata:
  labels:
    # Business unit allocation
    cost-center: "engineering-platform"   # Finance chargeback code
    team: "platform-engineering"          # Team for showback
    product: "api-gateway"                # Product for product-level costs
    environment: "production"             # env for cost comparison
    component: "frontend"                 # Component type
    app: "api-gateway-frontend"           # Application name
    # Project tracking
    project: "q1-2031-migration"          # Project attribution
```

```bash
# Apply label taxonomy to existing deployments
kubectl label deployment api-gateway \
  cost-center=engineering-platform \
  team=platform-engineering \
  product=api-gateway \
  environment=production

# Bulk label all deployments in a namespace
kubectl get deployments -n production -o name | \
  xargs -I{} kubectl label {} \
    cost-center=engineering-platform \
    environment=production \
    -n production
```

### Configuring OpenCost Label Aggregation

```yaml
# opencost-values.yaml - label aggregation
opencost:
  exporter:
    # Labels to use for cost allocation aggregation
    allocationLabels:
      # These labels become dimensions in cost reports
      - team
      - cost-center
      - product
      - environment
      - project
```

### OpenCost API for Label-Based Queries

```bash
# Query costs by label (REST API)
# Cost by team over the last 7 days
curl -s "http://opencost.opencost.svc.cluster.local:9003/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=label:team" \
  --data-urlencode "accumulate=true" | \
  jq -r '.data[] | to_entries[] | "\(.key): $\(.value.totalCost | floor)"' | \
  sort -t: -k2 -rn | head -20

# Cost by cost-center for the current month
MONTH_START=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%dT%H:%M:%SZ)
curl -s "http://opencost.opencost.svc.cluster.local:9003/model/allocation" \
  --data-urlencode "window=${MONTH_START},now" \
  --data-urlencode "aggregate=label:cost-center" \
  --data-urlencode "accumulate=true" | \
  jq -r '.data[] | to_entries[] | {center: .key, cost: .value.totalCost}'

# Multi-dimension: cost by team AND environment
curl -s "http://opencost.opencost.svc.cluster.local:9003/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=label:team,label:environment" \
  --data-urlencode "accumulate=true" | \
  jq -r '.data[] | to_entries[] | "\(.key): $\(.value.totalCost | floor)"'
```

## Section 5: Idle Cost Allocation

### Understanding Idle Costs

Idle costs are resources provisioned on nodes that no pod has requested. In a typical Kubernetes cluster, 20-40% of provisioned capacity sits idle due to:
- Node overprovisioning for burst capacity
- System DaemonSet overhead
- Resource fragmentation across nodes

OpenCost offers three approaches to idle cost handling:

```yaml
# Option 1: Hide idle costs (show only allocated costs)
opencost:
  exporter:
    allocation:
      defaultIdleAllocation: none

# Option 2: Show idle costs as a separate line item
opencost:
  exporter:
    allocation:
      defaultIdleAllocation: hide

# Option 3: Distribute idle costs proportionally to usage
opencost:
  exporter:
    allocation:
      defaultIdleAllocation: share
      # Share idle costs proportionally to requests
      shareIdleByNode: false  # share across cluster, not per-node
```

### Custom Idle Allocation by Namespace

```bash
# Set idle allocation policy per query (overrides default)
# Show idle as separate line item for engineering review
curl -s "http://opencost.opencost.svc.cluster.local:9003/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "idle=separate" \
  --data-urlencode "accumulate=true" | \
  jq '.data[] | to_entries[] | {ns: .key, cost: .value.totalCost, idle: .value.idleCost}'

# Distribute idle to namespaces for full chargeback
curl -s "http://opencost.opencost.svc.cluster.local:9003/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "idle=share" \
  --data-urlencode "shareIdle=weighted" \
  --data-urlencode "accumulate=true" | \
  jq '.data[] | to_entries[] | {ns: .key, cost: .value.totalCost}'
```

### Shared Namespace Cost Distribution

```bash
# Distribute shared infrastructure costs (monitoring, ingress, etc.)
# proportionally to consuming namespaces
curl -s "http://opencost.opencost.svc.cluster.local:9003/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "shareNamespaces=monitoring,kube-system,ingress-nginx" \
  --data-urlencode "shareSplit=weighted" \
  --data-urlencode "accumulate=true" | \
  jq -r '.data[] | to_entries[] | "\(.key): $\(.value.totalCost | . * 100 | round / 100)"'
```

## Section 6: External Cloud Cost Integration

### AWS Cloud Cost Integration

OpenCost supports pulling actual AWS billing data to reconcile with Kubernetes-allocated costs:

```yaml
# opencost-values.yaml - AWS billing integration
opencost:
  exporter:
    cloudCost:
      enabled: true
      # AWS Cost and Usage Reports (CUR) integration
      aws:
        region: us-east-1
        # S3 bucket where CUR reports are stored
        curBucket: my-aws-cur-reports
        curPrefix: cur/
        # Athena query configuration for CUR
        athenaDatabase: cur_database
        athenaTable: cost_and_usage_report
        athenaWorkgroup: primary
        athenaRegion: us-east-1
        athenaS3BucketName: my-athena-results
```

```bash
# Query combined cloud + Kubernetes cost
curl -s "http://opencost.opencost.svc.cluster.local:9003/cloudCost/view/query" \
  --data-urlencode "window=30d" \
  --data-urlencode "aggregate=service" | \
  jq -r '.data.sets[].cloudCosts | to_entries[] |
    "\(.key): \(.value.cost.cost | . * 100 | round / 100)"'
```

### GCP Billing Integration

```yaml
opencost:
  exporter:
    cloudCost:
      enabled: true
      gcp:
        projectID: my-gcp-project
        billingDataDataset: billing_export
        billingDataTable: gcp_billing_export_v1_ABCDEF_123456_789012
```

## Section 7: Prometheus Metrics and Recording Rules

### OpenCost Prometheus Metrics

```bash
# Key OpenCost metrics exposed to Prometheus
# (after ServiceMonitor is configured)

# Cost per namespace
container_memory_allocation_bytes
container_cpu_allocation
container_gpu_allocation

# OpenCost custom metrics
opencost_allocation_cpu_cost
opencost_allocation_ram_cost
opencost_allocation_gpu_cost
opencost_allocation_pv_cost
opencost_allocation_total_cost
```

### Prometheus Recording Rules for Cost Reporting

```yaml
# prometheus-opencost-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: opencost-recording-rules
  namespace: monitoring
spec:
  groups:
    - name: opencost.cost
      interval: 5m
      rules:
        # Daily CPU cost per team label
        - record: team:daily_cpu_cost:sum
          expr: |
            sum by (label_team) (
              rate(container_cpu_usage_seconds_total[1h]) * 0.048
              * on(pod, namespace) group_left(label_team)
              kube_pod_labels
            ) * 24 * 3600

        # Daily memory cost per team
        - record: team:daily_memory_cost:sum
          expr: |
            sum by (label_team) (
              container_memory_working_set_bytes * 0.006 / (1024^3)
              * on(pod, namespace) group_left(label_team)
              kube_pod_labels
            )

        # Total daily cost per namespace
        - record: namespace:daily_total_cost:sum
          expr: |
            sum by (namespace) (
              opencost_allocation_total_cost
            ) * 24

        # Cost efficiency: actual usage vs requested
        - record: namespace:cost_efficiency:ratio
          expr: |
            sum by (namespace) (
              rate(container_cpu_usage_seconds_total[1h])
            )
            /
            sum by (namespace) (
              kube_pod_container_resource_requests{resource="cpu"}
            )

    - name: opencost.alerts
      rules:
        - alert: NamespaceCostSpike
          expr: |
            sum by (namespace) (opencost_allocation_total_cost)
            > on(namespace) (
              sum by (namespace) (opencost_allocation_total_cost offset 7d) * 1.5
            )
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Cost spike in namespace {{ $labels.namespace }}"
            description: |
              Cost in {{ $labels.namespace }} is 50% above last week's value.
              Current: ${{ $value | humanize }}/hr

        - alert: IdleCostExcessive
          expr: |
            sum(opencost_node_total_cost) - sum(opencost_allocation_total_cost)
            >
            sum(opencost_node_total_cost) * 0.4
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Cluster idle cost exceeds 40%"
            description: |
              More than 40% of cluster cost is idle (unallocated).
              Consider right-sizing nodes or enabling cluster autoscaler.
```

## Section 8: Grafana Dashboard for Executive Reporting

### Cost Attribution Dashboard Configuration

```json
// opencost-exec-dashboard.json (structure for Grafana import)
{
  "title": "Kubernetes Cost Attribution - Executive View",
  "tags": ["kubernetes", "costs", "finops"],
  "panels": [
    {
      "title": "Total Monthly Spend by Team",
      "type": "piechart",
      "datasource": "Prometheus",
      "targets": [
        {
          "expr": "sum by (label_team) (opencost_allocation_total_cost) * 24 * 30",
          "legendFormat": "{{label_team}}"
        }
      ]
    },
    {
      "title": "Cost Trend - Last 30 Days",
      "type": "graph",
      "targets": [
        {
          "expr": "sum by (namespace) (opencost_allocation_total_cost * 24)",
          "legendFormat": "{{namespace}}"
        }
      ]
    },
    {
      "title": "CPU vs Memory Cost Breakdown",
      "type": "barchart",
      "targets": [
        {
          "expr": "sum by (namespace) (opencost_allocation_cpu_cost * 24)",
          "legendFormat": "CPU - {{namespace}}"
        },
        {
          "expr": "sum by (namespace) (opencost_allocation_ram_cost * 24)",
          "legendFormat": "Memory - {{namespace}}"
        }
      ]
    },
    {
      "title": "Resource Efficiency Score",
      "type": "table",
      "targets": [
        {
          "expr": "namespace:cost_efficiency:ratio",
          "legendFormat": "{{namespace}}"
        }
      ]
    }
  ]
}
```

### Deploying OpenCost Grafana Dashboards

```bash
# Import OpenCost official dashboards
# Available at https://grafana.com/grafana/dashboards/

# OpenCost Overview Dashboard: ID 20673
# OpenCost Efficiency: ID 20674
# OpenCost Cluster Dashboard: ID 20675

# Via kubectl
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: opencost-grafana-dashboards
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
    grafana_folder: "FinOps"
data:
  opencost-overview.json: |
    {
      "__inputs": [{"name": "DS_PROMETHEUS", "type": "datasource"}],
      "title": "OpenCost Overview",
      "uid": "opencost-overview"
    }
EOF
```

### Automated Monthly Cost Report

```python
#!/usr/bin/env python3
# monthly-cost-report.py
# Generates monthly cost chargeback report from OpenCost API

import requests
import json
from datetime import datetime, timedelta
from typing import Dict, Any

OPENCOST_URL = "http://opencost.opencost.svc.cluster.local:9003"
MONTH_START = datetime.now().replace(day=1, hour=0, minute=0, second=0)
MONTH_END = datetime.now()

def get_allocation_costs(
    aggregate: str,
    window_start: datetime,
    window_end: datetime,
    idle: str = "share"
) -> Dict[str, Any]:
    """Query OpenCost allocation API."""
    window = f"{window_start.strftime('%Y-%m-%dT%H:%M:%SZ')},{window_end.strftime('%Y-%m-%dT%H:%M:%SZ')}"

    response = requests.get(
        f"{OPENCOST_URL}/model/allocation",
        params={
            "window": window,
            "aggregate": aggregate,
            "accumulate": "true",
            "idle": idle,
            "shareIdle": "weighted",
            "shareNamespaces": "monitoring,kube-system,ingress-nginx"
        }
    )
    response.raise_for_status()
    return response.json()

def format_cost(cost: float) -> str:
    return f"${cost:,.2f}"

def generate_report():
    print(f"Kubernetes Cost Chargeback Report")
    print(f"Period: {MONTH_START.strftime('%Y-%m-%d')} to {MONTH_END.strftime('%Y-%m-%d')}")
    print("=" * 80)

    # Cost by team label
    team_costs = get_allocation_costs(
        "label:team",
        MONTH_START,
        MONTH_END
    )

    print("\n## Cost by Team")
    print(f"{'Team':<40} {'Total Cost':>15} {'CPU Cost':>12} {'Memory Cost':>14}")
    print("-" * 80)

    total = 0
    if team_costs.get("data"):
        for window_data in team_costs["data"]:
            for team, allocation in sorted(
                window_data.items(),
                key=lambda x: x[1].get("totalCost", 0),
                reverse=True
            ):
                total_cost = allocation.get("totalCost", 0)
                cpu_cost = allocation.get("cpuCost", 0)
                ram_cost = allocation.get("ramCost", 0)
                total += total_cost

                print(f"{team:<40} {format_cost(total_cost):>15} "
                      f"{format_cost(cpu_cost):>12} {format_cost(ram_cost):>14}")

    print("-" * 80)
    print(f"{'TOTAL':<40} {format_cost(total):>15}")

    # Cost by environment
    env_costs = get_allocation_costs(
        "label:environment",
        MONTH_START,
        MONTH_END
    )

    print("\n## Cost by Environment")
    if env_costs.get("data"):
        for window_data in env_costs["data"]:
            for env, allocation in sorted(
                window_data.items(),
                key=lambda x: x[1].get("totalCost", 0),
                reverse=True
            ):
                print(f"{env}: {format_cost(allocation.get('totalCost', 0))}")

    # Efficiency metrics
    print("\n## Resource Efficiency")
    ns_costs = get_allocation_costs("namespace", MONTH_START, MONTH_END)

    if ns_costs.get("data"):
        for window_data in ns_costs["data"]:
            for ns, allocation in sorted(
                window_data.items(),
                key=lambda x: x[1].get("totalCost", 0),
                reverse=True
            )[:10]:  # Top 10 namespaces
                cpu_eff = allocation.get("cpuEfficiency", 0) * 100
                ram_eff = allocation.get("ramEfficiency", 0) * 100
                print(f"{ns:<40} CPU: {cpu_eff:>5.1f}%  RAM: {ram_eff:>5.1f}%")

if __name__ == "__main__":
    generate_report()
```

## Section 9: Budget Alerts and Governance

### Kubernetes Budget Objects with OpenCost

```yaml
# namespace-budget-configmap.yaml
# Custom budget enforcement via OpenCost API + alerting
apiVersion: v1
kind: ConfigMap
metadata:
  name: namespace-budgets
  namespace: opencost
data:
  budgets.json: |
    {
      "budgets": [
        {
          "namespace": "team-alpha",
          "monthly_limit_usd": 5000,
          "alert_threshold_pct": 80,
          "alert_webhook": "https://api.pagerduty.com/webhooks/...",
          "cost_center": "ENGR-001"
        },
        {
          "namespace": "team-beta",
          "monthly_limit_usd": 3000,
          "alert_threshold_pct": 85,
          "cost_center": "ENGR-002"
        },
        {
          "namespace": "production",
          "monthly_limit_usd": 50000,
          "alert_threshold_pct": 90,
          "cost_center": "PROD-001"
        }
      ]
    }
```

```bash
#!/bin/bash
# budget-alert-checker.sh
# Check namespace costs against budgets and alert on overages

OPENCOST_URL="http://opencost.opencost.svc.cluster.local:9003"
BUDGETS_FILE="/etc/opencost/budgets.json"
MONTH_START=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%dT%H:%M:%SZ)

# Get costs for the current month
COSTS=$(curl -s "${OPENCOST_URL}/model/allocation" \
  --data-urlencode "window=${MONTH_START},now" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "accumulate=true")

# Parse budgets and check each namespace
jq -r '.budgets[] | "\(.namespace) \(.monthly_limit_usd) \(.alert_threshold_pct)"' \
  "${BUDGETS_FILE}" | \
while read -r NAMESPACE LIMIT THRESHOLD; do
  # Get current cost for namespace
  CURRENT_COST=$(echo "${COSTS}" | jq -r \
    ".data[] | .[\"${NAMESPACE}\"].totalCost // 0")

  # Calculate percentage of budget used
  if [[ -n "${CURRENT_COST}" ]] && [[ "${CURRENT_COST}" != "null" ]]; then
    PCT=$(echo "scale=1; ${CURRENT_COST} * 100 / ${LIMIT}" | bc)

    echo "Namespace ${NAMESPACE}: ${CURRENT_COST}/${LIMIT} (${PCT}%)"

    # Alert if over threshold
    if (( $(echo "${PCT} > ${THRESHOLD}" | bc -l) )); then
      echo "ALERT: ${NAMESPACE} has used ${PCT}% of monthly budget!"

      # Send alert (customize with your notification system)
      curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "{\"text\": \"Budget Alert: ${NAMESPACE} has used ${PCT}% of \$${LIMIT} monthly budget\"}" \
        "${SLACK_WEBHOOK_URL}" || true
    fi
  fi
done
```

### PrometheusRule for Budget Alerts

```yaml
# opencost-budget-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: opencost-budget-alerts
  namespace: monitoring
spec:
  groups:
    - name: opencost.budgets
      rules:
        - alert: NamespaceBudgetWarning
          expr: |
            sum by (namespace) (opencost_allocation_total_cost) * 24 * 30 >
            on(namespace) kube_namespace_labels{label_monthly_budget_usd!=""} * 0.80
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} approaching budget limit"

        - alert: NamespaceBudgetExceeded
          expr: |
            sum by (namespace) (opencost_allocation_total_cost) * 24 * 30 >
            on(namespace) kube_namespace_labels{label_monthly_budget_usd!=""}
          for: 30m
          labels:
            severity: critical
          annotations:
            summary: "Namespace {{ $labels.namespace }} has exceeded budget"
            description: |
              Monthly projected spend: ${{ $value | humanize }}.
              Action required: review and reduce resource requests.
```

## Section 10: Cost Optimization Recommendations

### Identifying Over-Provisioned Workloads

```bash
#!/bin/bash
# find-overprovisioned.sh
# Use OpenCost efficiency data to find right-sizing opportunities

OPENCOST_URL="http://opencost.opencost.svc.cluster.local:9003"

echo "=== Workloads with CPU Efficiency < 20% ==="
curl -s "${OPENCOST_URL}/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=pod" \
  --data-urlencode "accumulate=true" | \
  jq -r '.data[] | to_entries[] |
    select(.value.cpuEfficiency < 0.2 and .value.cpuCost > 1) |
    "\(.key): CPU efficiency \(.value.cpuEfficiency * 100 | . * 10 | round / 10)%, cost $\(.value.cpuCost | . * 100 | round / 100)"' | \
  sort -t: -k1 -r | head -20

echo ""
echo "=== Workloads with Memory Efficiency < 20% ==="
curl -s "${OPENCOST_URL}/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=pod" \
  --data-urlencode "accumulate=true" | \
  jq -r '.data[] | to_entries[] |
    select(.value.ramEfficiency < 0.2 and .value.ramCost > 1) |
    "\(.key): RAM efficiency \(.value.ramEfficiency * 100 | . * 10 | round / 10)%, cost $\(.value.ramCost | . * 100 | round / 100)"' | \
  sort -t: -k1 -r | head -20
```

### Kubernetes VPA Integration for Auto Right-Sizing

```yaml
# vpa-for-overprovisioned.yaml
# Combine OpenCost insights with VPA for automated right-sizing
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: overprovisioned-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: overprovisioned-service
  updatePolicy:
    updateMode: "Off"  # Recommendation only - don't auto-apply
  resourcePolicy:
    containerPolicies:
      - containerName: main
        minAllowed:
          cpu: 10m
          memory: 64Mi
        maxAllowed:
          cpu: "2"
          memory: 4Gi
        controlledResources: ["cpu", "memory"]
```

```bash
# Get VPA recommendations
kubectl get vpa -n production -o json | \
  jq -r '.items[] |
    "\(.metadata.name): CPU recommendation: \(.status.recommendation.containerRecommendations[].target.cpu), RAM: \(.status.recommendation.containerRecommendations[].target.memory)"'
```

## Conclusion

OpenCost provides the foundation for Kubernetes FinOps: accurate, real-time cost attribution that maps infrastructure spending to the teams, products, and projects consuming resources. The most impactful implementation choices are establishing a consistent label taxonomy before deployment (retrofitting labels is painful), configuring appropriate idle cost distribution for your organizational model, and integrating with cloud billing APIs for full-cost reconciliation.

For executive reporting, the combination of the monthly cost report script, Prometheus-based budget alerts, and the Grafana dashboards provides the visibility needed to drive meaningful conversations about infrastructure efficiency. The real value materializes when cost data drives behavior change — teams that see their spend on a dashboard tend to right-size workloads, remove zombie deployments, and make CPU/memory request accuracy a code review criterion.
