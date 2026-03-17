---
title: "Kubernetes Cost Attribution with Kubecost: Namespace Chargebacks, Idle Resource Detection, and Rightsizing Recommendations"
date: 2031-10-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kubecost", "FinOps", "Cost Optimization", "Cloud Cost", "Chargeback", "Resource Management"]
categories:
- Kubernetes
- FinOps
- Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Kubernetes cost attribution using Kubecost: configuring namespace-level chargebacks, detecting idle resources, generating rightsizing recommendations, and integrating with cloud billing for accurate showback reporting."
more_link: "yes"
url: "/kubernetes-cost-attribution-kubecost-namespace-chargebacks-rightsizing/"
---

Kubernetes clusters commonly waste 40-70% of provisioned resources due to oversized requests, idle deployments, and lack of visibility into per-team consumption. Kubecost provides the tooling to attribute costs accurately to namespaces, teams, and applications, enabling genuine chargeback models that drive responsible resource usage. This guide covers production Kubecost deployment, custom cost allocation, and automated rightsizing workflows.

<!--more-->

# Kubernetes Cost Attribution with Kubecost: Production Deployment Guide

## The Cost Attribution Problem

Without proper tooling, Kubernetes cost attribution suffers from several challenges:

- **Shared infrastructure**: Control plane, system namespaces, and networking overlap cost attribution
- **Idle resources**: Pods with requests much larger than actual usage inflate team costs
- **Ephemeral workloads**: Jobs, preview environments, and batch workloads inflate namespace costs inconsistently
- **Multi-tenancy**: Multiple teams sharing a cluster need isolated cost views
- **Cloud billing complexity**: Node costs vary by instance type, region, spot pricing, and commitment discounts

## Kubecost Architecture

Kubecost consists of several components:

- **kubecost-cost-analyzer**: Core service that aggregates cost data
- **kubecost-prometheus**: Dedicated Prometheus instance for cost metrics
- **kubecost-grafana**: Pre-built dashboards for cost visibility
- **node-exporter**: Per-node cost attribution data
- **kube-state-metrics**: Kubernetes object metadata for cost allocation

## Installing Kubecost

### Using Helm

```bash
# Add Kubecost repository
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm repo update

# Create namespace
kubectl create namespace kubecost

# Install Kubecost with production settings
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --version 2.3.0 \
  --values kubecost-values.yaml \
  --wait
```

### Production Values File

```yaml
# kubecost-values.yaml
global:
  # Use existing Prometheus if available
  prometheus:
    fqdn: http://prometheus-operated.monitoring.svc.cluster.local:9090
    enabled: false
  grafana:
    enabled: false
    proxy: false

kubecostProductConfigs:
  # Cloud provider configuration for accurate pricing
  cloudIntegrationSecret: cloud-integration
  # Cluster name for multi-cluster environments
  clusterName: production-us-east-1
  # Currency
  currencyCode: USD
  # Discount settings
  azureSubscriptionID: ""
  awsSpotDataBucket: ""
  awsSpotDataRegion: us-east-1
  awsSpotDataPrefix: spot-

# Cost allocation settings
costModel:
  enabled: true
  # Include GPU costs
  gpuCost: 1.0
  # Network egress costs (per GB)
  networkCost: 0.01
  # Storage cost per GB/month
  defaultStorageCost: 0.10

# Resource settings for large clusters
kubecostFrontend:
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

kubecostModel:
  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi
  # Retention for cost data (days)
  etlDailyStoreDurationDays: 90
  etlHourlyStoreDurationHours: 72

# Enable savings insights
savings:
  enabled: true

# Pod annotations for cost allocation
serviceMonitor:
  enabled: true
  additionalLabels:
    release: prometheus-stack

# Persistence for cost database
persistentVolume:
  enabled: true
  size: 32Gi
  storageClass: gp3
```

### AWS Cloud Integration

```bash
# Create cloud integration secret for AWS
cat > /tmp/cloud-integration.json << 'EOF'
{
  "aws": [
    {
      "projectID": "123456789012",
      "billingDataPath": "s3://company-cur-bucket/cost-and-usage-report/report/",
      "serviceKeyName": "kubecost-cur-access",
      "serviceKeySecret": "AWS_PLACEHOLDER_SECRET_REPLACE_ME",
      "spotDataBucket": "company-spot-data-bucket",
      "spotDataRegion": "us-east-1",
      "spotDataPrefix": "ec2-spot-pricing",
      "projectID": "123456789012",
      "awsAthenaRegion": "us-east-1",
      "awsAthenaBucketName": "s3://company-athena-results",
      "awsAthenaDatabase": "athenacurcfn",
      "awsAthenaTable": "cost_and_usage_report"
    }
  ]
}
EOF

kubectl create secret generic cloud-integration \
  --namespace kubecost \
  --from-file=cloud-integration.json=/tmp/cloud-integration.json

rm /tmp/cloud-integration.json
```

### IAM Policy for CUR Access

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::company-cur-bucket",
        "arn:aws:s3:::company-cur-bucket/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "athena:StartQueryExecution",
        "athena:GetQueryExecution",
        "athena:GetQueryResults",
        "athena:GetWorkGroup"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "glue:GetDatabase",
        "glue:GetTable",
        "glue:GetPartitions"
      ],
      "Resource": "*"
    }
  ]
}
```

## Namespace Cost Attribution

### Label-Based Cost Allocation

Kubecost uses Kubernetes labels to attribute costs to teams, departments, and applications.

```yaml
# Add cost allocation labels to namespaces
apiVersion: v1
kind: Namespace
metadata:
  name: team-platform
  labels:
    kubecost.io/team: platform
    kubecost.io/department: engineering
    kubecost.io/product: infrastructure
    kubecost.io/environment: production
    app.kubernetes.io/managed-by: helm
```

Apply to all workloads:

```yaml
# deployment-with-cost-labels.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: team-platform
  labels:
    app: api-service
    kubecost.io/team: platform
    kubecost.io/component: api
spec:
  replicas: 3
  template:
    metadata:
      labels:
        app: api-service
        kubecost.io/team: platform
        kubecost.io/component: api
```

### Kubecost Allocation API

Query cost data programmatically:

```bash
# Get namespace costs for the last 7 days
kubectl port-forward -n kubecost svc/kubecost-cost-analyzer 9090:9090 &

curl -s "http://localhost:9090/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "accumulate=false" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('code') == 200:
    allocations = data['data'][0]
    # Sort by total cost
    sorted_ns = sorted(
        [(k, v) for k, v in allocations.items()],
        key=lambda x: x[1].get('totalCost', 0),
        reverse=True
    )
    print(f'{'Namespace':<40} {'CPU Cost':>12} {'Memory Cost':>14} {'Storage Cost':>14} {'Total':>12}')
    print('-' * 96)
    for ns, costs in sorted_ns[:20]:
        cpu = costs.get('cpuCost', 0)
        mem = costs.get('ramCost', 0)
        storage = costs.get('pvCost', 0)
        total = costs.get('totalCost', 0)
        print(f'{ns:<40} \${cpu:>11.2f} \${mem:>13.2f} \${storage:>13.2f} \${total:>11.2f}')
"
```

### Team Chargeback Report Script

```bash
#!/bin/bash
# generate-chargeback-report.sh

KUBECOST_URL="http://localhost:9090"
WINDOW="${1:-30d}"
OUTPUT_FILE="/tmp/chargeback-$(date +%Y%m).csv"

echo "Generating chargeback report for window: ${WINDOW}"

# Fetch data aggregated by team label
RESPONSE=$(curl -s "${KUBECOST_URL}/model/allocation" \
  --data-urlencode "window=${WINDOW}" \
  --data-urlencode "aggregate=label:kubecost.io/team" \
  --data-urlencode "accumulate=true")

# Parse and format as CSV
python3 << PYEOF
import json, csv, sys

data = json.loads('''${RESPONSE}''')

if data.get('code') != 200:
    print(f"API error: {data.get('message', 'unknown')}", file=sys.stderr)
    sys.exit(1)

allocations = data['data'][0]

with open('${OUTPUT_FILE}', 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow([
        'Team', 'CPU Cores (avg)', 'CPU Cost (\$)',
        'RAM GB (avg)', 'RAM Cost (\$)',
        'Storage GB', 'Storage Cost (\$)',
        'Network Cost (\$)', 'GPU Cost (\$)',
        'Total Cost (\$)', 'Efficiency (%)'
    ])

    for team, costs in sorted(allocations.items(), key=lambda x: x[1].get('totalCost', 0), reverse=True):
        if team == '__idle__':
            continue
        cpu_cores = costs.get('cpuCoreRequestAverage', 0)
        cpu_cost = costs.get('cpuCost', 0)
        ram_gb = costs.get('ramByteRequestAverage', 0) / (1024**3)
        ram_cost = costs.get('ramCost', 0)
        storage_gb = costs.get('pvByteUsageAverage', 0) / (1024**3)
        storage_cost = costs.get('pvCost', 0)
        network_cost = costs.get('networkCost', 0)
        gpu_cost = costs.get('gpuCost', 0)
        total = costs.get('totalCost', 0)
        efficiency = costs.get('totalEfficiency', 0) * 100

        writer.writerow([
            team, f'{cpu_cores:.2f}', f'{cpu_cost:.2f}',
            f'{ram_gb:.2f}', f'{ram_cost:.2f}',
            f'{storage_gb:.2f}', f'{storage_cost:.2f}',
            f'{network_cost:.2f}', f'{gpu_cost:.2f}',
            f'{total:.2f}', f'{efficiency:.1f}'
        ])

print(f"Report written to ${OUTPUT_FILE}")
PYEOF
```

## Idle Resource Detection

### Understanding Idle Costs

Kubecost classifies idle as the difference between requested resources and used resources:

- **Idle CPU**: Requested CPU - Actual CPU usage (averaged over window)
- **Idle Memory**: Requested memory - Actual memory usage
- **Idle Storage**: Provisioned PV capacity - Used PV capacity

```bash
# Check idle allocation
curl -s "http://localhost:9090/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "includeIdle=true" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
allocations = data['data'][0]

print('Namespace Idle Analysis (7-day window)')
print('=' * 80)
for ns, costs in sorted(allocations.items(), key=lambda x: x[1].get('cpuCost', 0) + x[1].get('ramCost', 0), reverse=True):
    if ns == '__idle__' or ns == '__unallocated__':
        continue
    cpu_eff = costs.get('cpuEfficiency', 0) * 100
    mem_eff = costs.get('ramEfficiency', 0) * 100
    total_eff = costs.get('totalEfficiency', 0) * 100

    if total_eff < 70:  # Flag inefficient namespaces
        flag = '** LOW EFFICIENCY **'
    else:
        flag = ''

    print(f'{ns:<35} CPU:{cpu_eff:>5.1f}% RAM:{mem_eff:>5.1f}% Total:{total_eff:>5.1f}% {flag}')
"
```

### Idle Namespace Report

```python
#!/usr/bin/env python3
# idle-namespace-report.py

import requests
import json
from datetime import datetime, timedelta

KUBECOST_URL = "http://localhost:9090"
WINDOW = "30d"
IDLE_THRESHOLD = 0.50  # Flag namespaces below 50% efficiency

def get_namespace_costs():
    resp = requests.get(
        f"{KUBECOST_URL}/model/allocation",
        params={
            "window": WINDOW,
            "aggregate": "namespace",
            "accumulate": "true",
            "includeIdle": "true",
        },
        timeout=30
    )
    resp.raise_for_status()
    data = resp.json()
    return data["data"][0]

def calculate_waste(allocation):
    """Calculate wasted spend for a namespace allocation."""
    cpu_efficiency = allocation.get("cpuEfficiency", 1.0)
    ram_efficiency = allocation.get("ramEfficiency", 1.0)
    cpu_cost = allocation.get("cpuCost", 0)
    ram_cost = allocation.get("ramCost", 0)

    cpu_waste = cpu_cost * (1 - cpu_efficiency)
    ram_waste = ram_cost * (1 - ram_efficiency)
    total_waste = cpu_waste + ram_waste

    return cpu_waste, ram_waste, total_waste

def main():
    allocations = get_namespace_costs()

    total_cluster_waste = 0
    namespace_report = []

    for ns, costs in allocations.items():
        if ns.startswith("__"):
            continue

        cpu_waste, ram_waste, total_waste = calculate_waste(costs)
        total_cost = costs.get("totalCost", 0)
        efficiency = costs.get("totalEfficiency", 0)

        if total_cost > 0:
            waste_pct = total_waste / total_cost * 100
        else:
            waste_pct = 0

        total_cluster_waste += total_waste

        namespace_report.append({
            "namespace": ns,
            "total_cost": total_cost,
            "cpu_waste": cpu_waste,
            "ram_waste": ram_waste,
            "total_waste": total_waste,
            "waste_percent": waste_pct,
            "efficiency": efficiency,
        })

    # Sort by total waste descending
    namespace_report.sort(key=lambda x: x["total_waste"], reverse=True)

    print(f"Idle Resource Report - {WINDOW} Window")
    print(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 100)
    print(f"{'Namespace':<40} {'Total Cost':>12} {'CPU Waste':>12} {'RAM Waste':>12} {'Total Waste':>12} {'Waste%':>8}")
    print("-" * 100)

    for r in namespace_report:
        marker = " <<" if r["efficiency"] < IDLE_THRESHOLD else ""
        print(f"{r['namespace']:<40} ${r['total_cost']:>11.2f} ${r['cpu_waste']:>11.2f} ${r['ram_waste']:>11.2f} ${r['total_waste']:>11.2f} {r['waste_percent']:>7.1f}%{marker}")

    print("-" * 100)
    print(f"{'TOTAL CLUSTER WASTE':<40} ${total_cluster_waste:>11.2f}")
    print()
    print("Namespaces with efficiency below 50% are marked with <<")

if __name__ == "__main__":
    main()
```

## Rightsizing Recommendations

### Kubecost Container Recommendations API

```bash
# Get container recommendations for a namespace
curl -s "http://localhost:9090/model/savings/requestSizing" \
  --data-urlencode "window=7d" \
  --data-urlencode "namespace=team-api" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)

if 'recommendations' not in data:
    print('No recommendations available')
    sys.exit(0)

total_monthly_savings = 0
print(f'{'Namespace/Workload/Container':<50} {'Current CPU':>12} {'Rec CPU':>10} {'Current Mem':>12} {'Rec Mem':>10} {'Monthly Savings':>16}')
print('-' * 115)

for rec in sorted(data['recommendations'], key=lambda x: x.get('monthlySavings', 0), reverse=True)[:30]:
    name = f\"{rec['namespace']}/{rec['workloadName']}/{rec['containerName']}\"
    curr_cpu = rec.get('currentCPURequest', 'N/A')
    rec_cpu = rec.get('recommendedCPURequest', 'N/A')
    curr_mem = rec.get('currentMemoryRequest', 'N/A')
    rec_mem = rec.get('recommendedMemoryRequest', 'N/A')
    savings = rec.get('monthlySavings', 0)
    total_monthly_savings += savings
    print(f'{name:<50} {curr_cpu:>12} {rec_cpu:>10} {curr_mem:>12} {rec_mem:>10} \${savings:>15.2f}')

print()
print(f'Total monthly savings potential: \${total_monthly_savings:.2f}')
"
```

### Automated Rightsizing via Patch

```bash
#!/bin/bash
# apply-rightsizing.sh
# Apply Kubecost rightsizing recommendations to a namespace

NAMESPACE="${1:-team-api}"
DRY_RUN="${2:-true}"
SAVINGS_THRESHOLD="${3:-10}"  # Only apply recommendations with >= $10/month savings

echo "Fetching rightsizing recommendations for namespace: ${NAMESPACE}"

RECOMMENDATIONS=$(curl -s "http://localhost:9090/model/savings/requestSizing" \
  --data-urlencode "window=7d" \
  --data-urlencode "namespace=${NAMESPACE}")

python3 << PYEOF
import json, subprocess, sys

data = json.loads('''${RECOMMENDATIONS}''')
dry_run = '${DRY_RUN}' == 'true'
threshold = float('${SAVINGS_THRESHOLD}')

for rec in data.get('recommendations', []):
    savings = rec.get('monthlySavings', 0)
    if savings < threshold:
        continue

    ns = rec['namespace']
    workload = rec['workloadName']
    workload_type = rec.get('workloadType', 'Deployment')
    container = rec['containerName']
    rec_cpu = rec.get('recommendedCPURequest', '')
    rec_mem = rec.get('recommendedMemoryRequest', '')

    if not rec_cpu and not rec_mem:
        continue

    print(f"Applying recommendation: {ns}/{workload}/{container}")
    print(f"  CPU: {rec.get('currentCPURequest', 'N/A')} -> {rec_cpu}")
    print(f"  Memory: {rec.get('currentMemoryRequest', 'N/A')} -> {rec_mem}")
    print(f"  Monthly savings: \${savings:.2f}")

    # Build patch
    patch_containers = [{"name": container, "resources": {"requests": {}}}]
    if rec_cpu:
        patch_containers[0]["resources"]["requests"]["cpu"] = rec_cpu
    if rec_mem:
        patch_containers[0]["resources"]["requests"]["memory"] = rec_mem

    patch = json.dumps({"spec": {"template": {"spec": {"containers": patch_containers}}}})

    cmd = [
        "kubectl", "patch", workload_type.lower(), workload,
        "-n", ns,
        "--type=strategic",
        "--patch", patch
    ]

    if dry_run:
        cmd.append("--dry-run=client")
        print(f"  [DRY RUN] Command: {' '.join(cmd)}")
    else:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  ERROR: {result.stderr}", file=sys.stderr)
        else:
            print(f"  SUCCESS: {result.stdout.strip()}")

PYEOF
```

### Kubernetes VPA Integration with Kubecost

Kubecost can work alongside Vertical Pod Autoscaler for automated rightsizing:

```yaml
# vpa-kubecost-integration.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-service-vpa
  namespace: team-api
  annotations:
    kubecost.io/vpa-managed: "true"
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  updatePolicy:
    updateMode: "Off"  # Recommendation only, don't auto-apply
  resourcePolicy:
    containerPolicies:
      - containerName: api-service
        minAllowed:
          cpu: 50m
          memory: 64Mi
        maxAllowed:
          cpu: 2
          memory: 2Gi
        controlledResources:
          - cpu
          - memory
        controlledValues: RequestsAndLimits
```

### Rightsizing Report with VPA Comparison

```python
#!/usr/bin/env python3
# rightsizing-comparison.py

import subprocess
import json
import requests

def get_vpa_recommendations(namespace):
    result = subprocess.run(
        ["kubectl", "get", "vpa", "-n", namespace, "-o", "json"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return {}

    vpa_data = json.loads(result.stdout)
    recommendations = {}

    for vpa in vpa_data.get("items", []):
        name = vpa["metadata"]["name"]
        target = vpa["spec"]["targetRef"]["name"]
        rec = vpa.get("status", {}).get("recommendation", {})

        for container_rec in rec.get("containerRecommendations", []):
            key = f"{target}/{container_rec['containerName']}"
            recommendations[key] = {
                "target_cpu": container_rec.get("target", {}).get("cpu", "N/A"),
                "target_mem": container_rec.get("target", {}).get("memory", "N/A"),
                "lower_cpu": container_rec.get("lowerBound", {}).get("cpu", "N/A"),
                "upper_cpu": container_rec.get("upperBound", {}).get("cpu", "N/A"),
            }

    return recommendations

def get_kubecost_recommendations(namespace):
    resp = requests.get(
        "http://localhost:9090/model/savings/requestSizing",
        params={"window": "7d", "namespace": namespace},
        timeout=30
    )
    resp.raise_for_status()
    data = resp.json()

    recommendations = {}
    for rec in data.get("recommendations", []):
        key = f"{rec['workloadName']}/{rec['containerName']}"
        recommendations[key] = {
            "current_cpu": rec.get("currentCPURequest", "N/A"),
            "kubecost_cpu": rec.get("recommendedCPURequest", "N/A"),
            "current_mem": rec.get("currentMemoryRequest", "N/A"),
            "kubecost_mem": rec.get("recommendedMemoryRequest", "N/A"),
            "monthly_savings": rec.get("monthlySavings", 0),
        }

    return recommendations

def main():
    namespace = "team-api"

    print(f"Rightsizing Comparison Report - Namespace: {namespace}")
    print("=" * 120)
    print(f"{'Workload/Container':<45} {'Curr CPU':>10} {'VPA CPU':>10} {'KC CPU':>10} {'Curr Mem':>12} {'VPA Mem':>12} {'KC Mem':>12} {'KC Savings':>12}")
    print("-" * 120)

    kubecost_recs = get_kubecost_recommendations(namespace)
    vpa_recs = get_vpa_recommendations(namespace)

    all_keys = set(list(kubecost_recs.keys()) + list(vpa_recs.keys()))

    for key in sorted(all_keys):
        kc = kubecost_recs.get(key, {})
        vpa = vpa_recs.get(key, {})

        curr_cpu = kc.get("current_cpu", "N/A")
        curr_mem = kc.get("current_mem", "N/A")
        vpa_cpu = vpa.get("target_cpu", "N/A")
        vpa_mem = vpa.get("target_mem", "N/A")
        kc_cpu = kc.get("kubecost_cpu", "N/A")
        kc_mem = kc.get("kubecost_mem", "N/A")
        savings = kc.get("monthly_savings", 0)

        print(f"{key:<45} {curr_cpu:>10} {vpa_cpu:>10} {kc_cpu:>10} {curr_mem:>12} {vpa_mem:>12} {kc_mem:>12} ${savings:>11.2f}")

if __name__ == "__main__":
    main()
```

## Custom Cost Allocation with External Assets

### External Node Pricing

For bare metal or custom pricing models:

```yaml
# custom-pricing.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: custom-pricing-model
  namespace: kubecost
data:
  pricing.yaml: |
    description: "Custom bare metal pricing model"
    CPU: 0.048      # Cost per CPU core per hour
    spotCPU: 0.012  # Spot CPU cost
    RAM: 0.006      # Cost per GB RAM per hour
    spotRAM: 0.0015 # Spot RAM cost
    GPU: 2.50       # Cost per GPU per hour
    storage: 0.10   # Cost per GB storage per month
    zoneNetworkEgress: 0.01
    regionNetworkEgress: 0.02
    internetNetworkEgress: 0.09
```

### Multi-Cluster Cost Aggregation

```yaml
# kubecost-federation-values.yaml
# For primary cluster (aggregator)
kubecostAggregator:
  enabled: true
  replicas: 2
  resources:
    requests:
      cpu: 1000m
      memory: 4Gi
  env:
    KUBECOST_AGGREGATOR_CLOUD_COST_REFRESH_RATE: "6h"

# Remote cluster configuration
kubecostDeployment:
  federatedStorageConfigSecretName: federated-store-config
```

```bash
# Configure remote cluster to push data to aggregator
cat > /tmp/federated-store.yaml << 'EOF'
type: s3
config:
  bucket: kubecost-federation-bucket
  endpoint: s3.amazonaws.com
  region: us-east-1
  # Use IRSA or instance profile for authentication
  insecure: false
EOF

kubectl create secret generic federated-store-config \
  --namespace kubecost \
  --from-file=federated-store.yaml=/tmp/federated-store.yaml
```

## Alerts and Budget Enforcement

### Kubecost Budget Alerts

```yaml
# budget-alert.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubecost-budget-alerts
  namespace: kubecost
data:
  alerts.yaml: |
    alerts:
      - type: budget
        threshold: 5000.00       # $5000 monthly budget
        window: month
        aggregation: namespace
        filter:
          - "namespace:team-api"
        slackWebhookUrl: "https://hooks.slack.com/services/<team-id>/<channel-id>/<token>"

      - type: budget
        threshold: 2000.00
        window: month
        aggregation: namespace
        filter:
          - "namespace:team-frontend"
        slackWebhookUrl: "https://hooks.slack.com/services/<team-id>/<channel-id>/<token>"

      - type: efficiency
        threshold: 0.40           # Alert if efficiency drops below 40%
        window: 7d
        aggregation: cluster
        slackWebhookUrl: "https://hooks.slack.com/services/<team-id>/<channel-id>/<token>"

      - type: spendChange
        relativeThreshold: 0.20  # Alert on 20% spend increase
        window: week
        aggregation: namespace
        filter:
          - "label[kubecost.io/team]:platform"
        slackWebhookUrl: "https://hooks.slack.com/services/<team-id>/<channel-id>/<token>"
```

### Prometheus Alerting Rules for Cost

```yaml
# cost-alerting-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubecost-alerts
  namespace: monitoring
spec:
  groups:
    - name: kubecost.cost
      interval: 1h
      rules:
        - alert: NamespaceCostSurge
          expr: |
            (
              sum(container_cpu_allocation{namespace!=""}) by (namespace)
              * on() group_left() avg(node_cpu_hourly_cost)
            ) > 50
          for: 2h
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} exceeds $50/hour CPU cost"
            description: "Current hourly CPU cost: ${{ $value | printf \"%.2f\" }}"

        - alert: LowEfficiencyNamespace
          expr: |
            (
              sum(container_cpu_usage_seconds_total) by (namespace)
              /
              sum(container_cpu_allocation) by (namespace)
            ) < 0.30
          for: 24h
          labels:
            severity: info
          annotations:
            summary: "Namespace {{ $labels.namespace }} efficiency below 30%"

        - alert: IdleCostExceedsThreshold
          expr: |
            kubecost_cluster_idle_total_dollars > 1000
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Cluster idle cost exceeds $1000/month"
```

## Monthly Chargeback Report Automation

```yaml
# chargeback-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: monthly-chargeback-report
  namespace: kubecost
spec:
  schedule: "0 8 1 * *"  # 8am on the 1st of each month
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: kubecost-report-sa
          restartPolicy: OnFailure
          containers:
            - name: reporter
              image: python:3.12-slim
              command:
                - /bin/sh
                - -c
                - |
                  pip install requests boto3 openpyxl --quiet

                  python3 << 'PYEOF'
                  import requests, json, boto3, io
                  from openpyxl import Workbook
                  from openpyxl.styles import Font, PatternFill, Alignment
                  from datetime import datetime, timedelta

                  KUBECOST_URL = "http://kubecost-cost-analyzer.kubecost.svc.cluster.local:9090"
                  S3_BUCKET = "company-finops-reports"
                  WINDOW = "lastmonth"

                  # Fetch data
                  resp = requests.get(f"{KUBECOST_URL}/model/allocation",
                    params={"window": WINDOW, "aggregate": "label:kubecost.io/team",
                            "accumulate": "true"}, timeout=60)
                  data = resp.json()

                  # Build Excel workbook
                  wb = Workbook()
                  ws = wb.active
                  ws.title = "Team Chargeback"

                  headers = ["Team", "CPU Cost", "Memory Cost", "Storage Cost",
                            "Network Cost", "GPU Cost", "Total Cost", "Efficiency"]
                  ws.append(headers)

                  for team, costs in data["data"][0].items():
                      if team.startswith("__"):
                          continue
                      ws.append([
                          team,
                          round(costs.get("cpuCost", 0), 2),
                          round(costs.get("ramCost", 0), 2),
                          round(costs.get("pvCost", 0), 2),
                          round(costs.get("networkCost", 0), 2),
                          round(costs.get("gpuCost", 0), 2),
                          round(costs.get("totalCost", 0), 2),
                          f"{costs.get('totalEfficiency', 0)*100:.1f}%",
                      ])

                  # Save to S3
                  buffer = io.BytesIO()
                  wb.save(buffer)
                  buffer.seek(0)

                  month_str = (datetime.now() - timedelta(days=1)).strftime("%Y-%m")
                  s3 = boto3.client("s3")
                  s3.put_object(
                      Bucket=S3_BUCKET,
                      Key=f"chargeback/{month_str}/team-chargeback-{month_str}.xlsx",
                      Body=buffer.getvalue(),
                      ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  )
                  print(f"Report uploaded to s3://{S3_BUCKET}/chargeback/{month_str}/")
                  PYEOF
              env:
                - name: AWS_DEFAULT_REGION
                  value: us-east-1
```

## Conclusion

Effective Kubernetes cost attribution requires combining infrastructure visibility (Kubecost), organizational structure (labels and namespaces), and process discipline (regular chargeback reporting and rightsizing reviews). The patterns covered here — accurate cloud billing integration, label-based allocation, idle detection, and automated rightsizing — form a complete FinOps practice for enterprise Kubernetes environments. Start with visibility, establish baselines, then drive optimization through team accountability and automated recommendations.
