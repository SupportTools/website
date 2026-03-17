---
title: "Kubernetes Cost Optimization: OpenCost, Kubecost, and FinOps Tooling"
date: 2029-07-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "FinOps", "Cost Optimization", "OpenCost", "Kubecost", "Cloud Cost", "Rightsizing"]
categories: ["Kubernetes", "FinOps", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to Kubernetes cost allocation, optimization, and FinOps tooling: OpenCost and Kubecost deployment, cost allocation by namespace and team, idle resource detection, rightsizing recommendations, spot instance savings, and implementing showback vs chargeback."
more_link: "yes"
url: "/kubernetes-cost-optimization-opencost-kubecost-finops-2029/"
---

Kubernetes clusters running in production commonly have 40-60% of provisioned resources idle. Without proper cost visibility, engineering teams continue requesting more resources while paying for unused capacity. FinOps tooling — specifically OpenCost and Kubecost — provides the visibility needed to make data-driven decisions about resource allocation. This post covers deploying these tools, building cost allocation models, and driving actual cost reduction through rightsizing and scheduling optimization.

<!--more-->

# Kubernetes Cost Optimization: OpenCost, Kubecost, and FinOps Tooling

## The Cloud Waste Problem

A typical production Kubernetes cluster wastes resources in four ways:

1. **Overprovisioned requests**: Teams set CPU/memory requests conservatively high to avoid OOMKills and throttling. In practice, the actual P99 usage is 20-40% of the request.

2. **Idle deployments**: Development, staging, and test environments run 24/7 when they are only used 8 hours per day.

3. **Wrong node types**: CPU-optimized workloads on memory-optimized instances (or vice versa).

4. **Underutilized cluster autoscaling**: Autoscaler scale-down is blocked by pod disruption budgets, sticky PVCs, or misconfigured eviction policies.

The economic impact: a 500-node cluster on AWS EKS at average instance cost of $0.20/core-hour with 50% CPU idle wastes roughly $440,000 per year.

## Section 1: OpenCost Architecture and Deployment

OpenCost is the CNCF-incubating project for Kubernetes cost monitoring. It is vendor-neutral and provides a Prometheus-compatible metrics endpoint and a REST API.

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  OpenCost                        │
│                                                  │
│  ┌────────────────┐    ┌──────────────────────┐  │
│  │  Cost Model    │    │  Kubernetes Watcher  │  │
│  │  (cloud prices)│    │  (pods, nodes, PVs)  │  │
│  └───────┬────────┘    └──────────┬───────────┘  │
│          │                        │               │
│  ┌───────▼────────────────────────▼───────────┐  │
│  │              Allocation Engine              │  │
│  │   (CPU, Memory, GPU, Network, Storage)      │  │
│  └──────────────────┬──────────────────────────┘  │
│                     │                             │
│  ┌──────────────────▼──────────────────────────┐  │
│  │         Prometheus Metrics Endpoint          │  │
│  │         REST API (allocation queries)        │  │
│  └─────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### Deploying OpenCost

```bash
# Add the Helm repository
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update

# Create namespace
kubectl create namespace opencost

# Install with AWS pricing (adjust for GCP/Azure)
helm install opencost opencost/opencost \
  --namespace opencost \
  --set opencost.exporter.cloudProviderApiKey="" \
  --set opencost.ui.enabled=true \
  --set opencost.prometheus.external.enabled=true \
  --set opencost.prometheus.external.url=http://prometheus-operated.monitoring.svc.cluster.local:9090

# Verify deployment
kubectl -n opencost get pods
kubectl -n opencost port-forward svc/opencost 9090:9090 9003:9003 &
```

### Configuring Cloud Provider Pricing

```yaml
# opencost-values.yaml
opencost:
  exporter:
    # AWS: us-east-1 pricing
    cloudProviderApiKey: ""
    aws:
      region: us-east-1
      serviceAccountAnnotations:
        eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/OpenCostRole

  # Custom pricing for on-premise or negotiated rates
  customPricing:
    enabled: false
    configPath: /var/configs/pricing.json
```

For on-premise clusters with custom pricing:

```json
{
  "provider": "custom",
  "description": "Internal cluster pricing",
  "CPU": "0.031611",
  "spotCPU": "0.006655",
  "RAM": "0.004237",
  "spotRAM": "0.000892",
  "GPU": "0.95",
  "storage": "0.00005479",
  "zoneNetworkEgress": "0.01",
  "regionNetworkEgress": "0.01",
  "internetNetworkEgress": "0.12"
}
```

### Querying OpenCost API

```bash
# Get allocation by namespace for last 7 days
curl "http://localhost:9003/allocation?window=7d&aggregate=namespace" | jq .

# Get allocation by deployment
curl "http://localhost:9003/allocation?window=1d&aggregate=deployment" | jq .

# Get allocation by label (team)
curl "http://localhost:9003/allocation?window=30d&aggregate=label:team" | jq .

# Example response structure
{
  "code": 200,
  "data": [{
    "frontend": {
      "name": "frontend",
      "window": {
        "start": "2029-07-01T00:00:00Z",
        "end": "2029-07-08T00:00:00Z"
      },
      "cpuCores": 2.4,
      "cpuCoreRequestAverage": 4.0,
      "cpuCoreUsageAverage": 2.1,
      "cpuCost": 12.45,
      "ramBytes": 3221225472,
      "ramByteRequestAverage": 8589934592,
      "ramByteUsageAverage": 2684354560,
      "ramCost": 8.92,
      "totalCost": 21.37,
      "efficiency": 0.54
    }
  }]
}
```

## Section 2: Kubecost Enterprise Features

Kubecost builds on OpenCost (it originally created OpenCost before open-sourcing it) and adds enterprise features:

- Multi-cluster cost aggregation
- Saved reports and scheduled exports
- Cost alerts and anomaly detection
- Jira/Slack integration for cost notifications
- Governance policies for budget enforcement

### Kubecost Installation

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm repo update

helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set kubecostToken="<YOUR_FREE_TOKEN>" \
  --set global.prometheus.enabled=false \
  --set global.prometheus.fqdn=http://prometheus-operated.monitoring.svc.cluster.local:9090 \
  --set persistentVolume.enabled=true \
  --set persistentVolume.size=100Gi
```

### Multi-Cluster Aggregation

```yaml
# kubecost-federation-values.yaml
# Primary cluster (aggregator)
federatedETL:
  enabled: true
  primaryCluster: true

global:
  grafana:
    enabled: false

# Add remote clusters
remoteReadEnabled: true
prometheus:
  remoteRead:
  - url: "http://kubecost-agent.cluster-b.svc.cluster.local:9003/metrics"
    readRecent: true
```

## Section 3: Cost Allocation by Namespace, Team, and Application

Effective cost allocation requires a consistent labeling strategy across all Kubernetes resources.

### Required Label Standard

```yaml
# Enforce these labels on all workloads via OPA/Gatekeeper
apiVersion: v1
kind: Pod
metadata:
  labels:
    # Cost allocation labels
    team: "platform"               # Owning team
    product: "api-gateway"         # Product/service
    environment: "production"      # prod/staging/dev
    cost-center: "engineering-001" # Finance cost center
    app.kubernetes.io/name: "envoy"
    app.kubernetes.io/component: "proxy"
```

```yaml
# OPA Gatekeeper: require cost allocation labels
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-cost-labels
spec:
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
    - production
    - staging
  parameters:
    labels:
    - key: team
    - key: cost-center
    - key: product
```

### Querying Costs by Team

```bash
# OpenCost: aggregate by team label
curl "http://localhost:9003/allocation" \
  --data-urlencode "window=30d" \
  --data-urlencode "aggregate=label:team" \
  --data-urlencode "accumulate=true" \
  | jq '.data[0] | to_entries | sort_by(.value.totalCost) | reverse | .[:10]'
```

```python
#!/usr/bin/env python3
# Monthly cost report generator
import requests
import json
from datetime import datetime

OPENCOST_URL = "http://opencost.opencost.svc.cluster.local:9003"

def get_monthly_costs_by_team():
    resp = requests.get(
        f"{OPENCOST_URL}/allocation",
        params={
            "window": "30d",
            "aggregate": "label:team",
            "accumulate": "true",
        }
    )
    resp.raise_for_status()
    data = resp.json()["data"][0]

    rows = []
    for team, alloc in data.items():
        rows.append({
            "team": team,
            "cpu_cost": round(alloc.get("cpuCost", 0), 2),
            "ram_cost": round(alloc.get("ramCost", 0), 2),
            "storage_cost": round(alloc.get("pvCost", 0), 2),
            "total_cost": round(alloc.get("totalCost", 0), 2),
            "efficiency": round(alloc.get("efficiency", 0) * 100, 1),
        })

    return sorted(rows, key=lambda x: x["total_cost"], reverse=True)

if __name__ == "__main__":
    costs = get_monthly_costs_by_team()
    print(f"{'Team':<25} {'CPU':>10} {'RAM':>10} {'Storage':>10} {'Total':>12} {'Efficiency':>12}")
    print("-" * 80)
    for row in costs:
        print(
            f"{row['team']:<25} "
            f"${row['cpu_cost']:>9.2f} "
            f"${row['ram_cost']:>9.2f} "
            f"${row['storage_cost']:>9.2f} "
            f"${row['total_cost']:>11.2f} "
            f"{row['efficiency']:>10.1f}%"
        )
```

## Section 4: Idle Resource Detection

Idle resources are the largest source of waste. OpenCost tracks the difference between requested and used resources.

### Identifying Idle Namespaces

```bash
# Get efficiency per namespace (low efficiency = high waste)
curl "http://localhost:9003/allocation?window=7d&aggregate=namespace&accumulate=true" \
  | jq '.data[0] | to_entries
        | map(select(.value.efficiency < 0.3))
        | sort_by(.value.totalCost)
        | reverse
        | .[:20]
        | map({
            namespace: .key,
            total_cost: (.value.totalCost | round),
            efficiency: (.value.efficiency * 100 | round),
            idle_cost: ((.value.totalCost * (1 - .value.efficiency)) | round)
          })'
```

### Identifying Idle Dev/Test Environments

```bash
# Find namespaces with near-zero CPU usage in non-business hours
# This Prometheus query identifies idle dev environments
kubectl exec -n monitoring prometheus-0 -- \
  promtool query range \
  --start="2029-07-01T00:00:00Z" \
  --end="2029-07-08T00:00:00Z" \
  --step=3600s \
  'avg_over_time(
    (
      sum by (namespace) (
        rate(container_cpu_usage_seconds_total{namespace=~"dev-.*"}[5m])
      )
    )[7d:1h]
  ) < 0.01' \
  http://localhost:9090
```

### Automated Dev Environment Shutdown

```yaml
# Use kube-downscaler to automatically scale down dev namespaces
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-downscaler
  namespace: kube-system
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: downscaler
        image: hjacobs/kube-downscaler:latest
        args:
        - --interval=60
        - --default-uptime=Mon-Fri 07:00-19:00 Europe/Berlin
        - --default-downtime=never
        - --namespace-label=downscaler/enabled=true
        - --deployment-time-annotation=deploy-time
```

```bash
# Label dev namespaces for automatic downscaling
kubectl annotate namespace dev-team-alpha \
  downscaler/uptime="Mon-Fri 08:00-18:00 America/New_York"

kubectl annotate namespace dev-team-beta \
  downscaler/uptime="Mon-Fri 08:00-18:00 America/New_York"
```

## Section 5: Rightsizing Recommendations

Rightsizing reduces waste by aligning resource requests with actual usage.

### Using VPA for Rightsizing Recommendations

```yaml
# VPA in recommendation mode (no automatic changes)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Off"  # Recommendation only, no automatic changes
  resourcePolicy:
    containerPolicies:
    - containerName: api-server
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4
        memory: 8Gi
```

```bash
# View VPA recommendations
kubectl get vpa -n production api-server-vpa -o json \
  | jq '.status.recommendation.containerRecommendations[]
        | {
            container: .containerName,
            lower_bound: .lowerBound,
            target: .target,
            upper_bound: .upperBound
          }'

# Example output:
# {
#   "container": "api-server",
#   "lower_bound": {"cpu": "200m", "memory": "256Mi"},
#   "target": {"cpu": "450m", "memory": "512Mi"},
#   "upper_bound": {"cpu": "1200m", "memory": "1536Mi"}
# }
```

### Bulk Rightsizing Analysis

```bash
#!/bin/bash
# Script to identify top 20 most over-provisioned deployments

# Requires metrics-server and jq
kubectl get deployments --all-namespaces -o json \
  | jq -r '.items[] | "\(.metadata.namespace) \(.metadata.name)"' \
  | while read namespace name; do
    # Get current requests
    requests=$(kubectl get deployment -n "$namespace" "$name" \
      -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}')

    # Get actual usage (last hour average)
    usage=$(kubectl top pod -n "$namespace" \
      -l "app=$name" --no-headers 2>/dev/null \
      | awk '{sum+=$2} END {print sum}')

    echo "$namespace/$name: requested=$requests used=${usage}m"
  done
```

### Kubecost Savings Recommendations API

```bash
# Get Kubecost rightsizing recommendations
curl "http://kubecost.kubecost.svc.cluster.local:9090/savings/requestSizing" \
  --data-urlencode "window=7d" \
  --data-urlencode "targetCPUUtilization=0.65" \
  --data-urlencode "targetRAMUtilization=0.65" \
  | jq '.recommendations | sort_by(.monthlySavings) | reverse | .[:10]
        | map({
            deployment: .controllerName,
            namespace: .namespace,
            monthly_savings: (.monthlySavings | round),
            current_cpu: .currentCPURequest,
            recommended_cpu: .recommendedCPURequest,
            current_memory: .currentRAMRequest,
            recommended_memory: .recommendedRAMRequest
          })'
```

## Section 6: Spot Instance Savings

Spot/preemptible instances can reduce compute costs by 60-90%. The key is making your workloads resilient to node termination.

### Node Groups for Spot Instances (EKS Karpenter)

```yaml
# Karpenter NodePool for spot instances
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: spot-general
spec:
  template:
    spec:
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]
      - key: node.kubernetes.io/instance-type
        operator: In
        values:
        - "m7i.2xlarge"
        - "m7i.4xlarge"
        - "m6i.2xlarge"
        - "m6i.4xlarge"
        - "m6a.2xlarge"
        - "m6a.4xlarge"
        - "c7i.4xlarge"
        - "c6i.4xlarge"
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 1m
  limits:
    cpu: 1000
    memory: 4000Gi
---
apiVersion: karpenter.k8s.aws/v1beta1
kind: EC2NodeClass
metadata:
  name: spot-general
spec:
  amiFamily: AL2
  role: "KarpenterNodeRole"
  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: "my-cluster"
  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: "my-cluster"
```

### Making Workloads Spot-Tolerant

```yaml
# Deployment designed for spot instances
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  replicas: 6  # Enough replicas that losing 1-2 is tolerable
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 2
  template:
    spec:
      terminationGracePeriodSeconds: 60

      # Prefer spot, tolerate if unavailable
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 80
            preference:
              matchExpressions:
              - key: karpenter.sh/capacity-type
                operator: In
                values: ["spot"]

      tolerations:
      - key: karpenter.sh/capacity-type
        operator: Equal
        value: spot
        effect: NoSchedule

      containers:
      - name: api-server
        image: api-server:latest
        lifecycle:
          preStop:
            exec:
              # Drain in-flight requests before spot termination
              command: ["/bin/sh", "-c", "sleep 30"]
```

### Spot Savings Tracking in OpenCost

```promql
# Calculate spot vs on-demand cost ratio
sum(
  container_cpu_allocation
  * on(node) group_left(label_karpenter_sh_capacity_type)
  kube_node_labels{label_karpenter_sh_capacity_type="spot"}
) / sum(container_cpu_allocation)
```

## Section 7: Showback vs Chargeback

Showback and chargeback are organizational mechanisms for cost accountability:

- **Showback**: Teams see their costs but are not financially charged. Uses information to drive behavior change.
- **Chargeback**: Teams are billed for their Kubernetes costs. Their budget is debited monthly.

Most organizations start with showback and mature to chargeback.

### Implementing Showback with Monthly Reports

```python
#!/usr/bin/env python3
# Automated monthly showback report to Slack/email

import requests
import json
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta

OPENCOST_URL = "http://opencost:9003"
SLACK_WEBHOOK = "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"

def generate_showback_report(year: int, month: int) -> dict:
    start = datetime(year, month, 1)
    end = start + relativedelta(months=1)

    resp = requests.get(
        f"{OPENCOST_URL}/allocation",
        params={
            "window": f"{start.isoformat()}Z,{end.isoformat()}Z",
            "aggregate": "label:team,label:environment",
            "accumulate": "true",
        }
    )
    resp.raise_for_status()
    return resp.json()["data"][0]

def post_to_slack(report: dict, month_str: str):
    # Build summary
    total = sum(v["totalCost"] for v in report.values())

    # Top 5 teams by cost
    teams = {}
    for key, alloc in report.items():
        parts = key.split("/")
        team = parts[0] if parts else key
        teams[team] = teams.get(team, 0) + alloc["totalCost"]

    top_teams = sorted(teams.items(), key=lambda x: x[1], reverse=True)[:5]

    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": f"Kubernetes Cost Report — {month_str}"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*Total Cluster Cost:* ${total:,.2f}"}},
        {"type": "divider"},
        {"type": "section", "text": {"type": "mrkdwn",
            "text": "*Top Teams by Cost:*\n" + "\n".join(
                f"• {team}: ${cost:,.2f}" for team, cost in top_teams
            )}},
    ]

    requests.post(SLACK_WEBHOOK, json={"blocks": blocks})

if __name__ == "__main__":
    last_month = datetime.now() - relativedelta(months=1)
    report = generate_showback_report(last_month.year, last_month.month)
    month_str = last_month.strftime("%B %Y")
    post_to_slack(report, month_str)
    print(f"Showback report for {month_str} posted.")
```

### Chargeback via Kubernetes Labels and Finance Integration

```yaml
# Namespace with billing metadata
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments
  labels:
    team: "payments"
    cost-center: "FIN-001"
    business-unit: "ecommerce"
  annotations:
    billing/gl-code: "7200-CLOUD-INFRA"
    billing/manager-email: "payments-lead@company.com"
    billing/monthly-budget: "5000"
```

```python
# Export cost data to finance system
def export_chargeback_to_finance(report: dict, gl_mappings: dict):
    entries = []
    for namespace, cost in report.items():
        gl_code = gl_mappings.get(namespace, "7200-CLOUD-UNALLOCATED")
        entries.append({
            "gl_code": gl_code,
            "amount": round(cost["totalCost"], 2),
            "description": f"Kubernetes compute - {namespace} - {cost.get('window', {}).get('start', '')[:10]}",
            "currency": "USD",
        })

    # POST to finance API
    requests.post(
        "https://finance.internal/api/journal-entries",
        json={"entries": entries},
        headers={"Authorization": "Bearer <token>"},
    )
```

## Section 8: Cost Anomaly Detection and Alerting

### Prometheus Alerting for Cost Spikes

```yaml
# Prometheus alert rules for cost anomalies
groups:
- name: kubernetes-cost-alerts
  interval: 1h
  rules:
  # Alert if a namespace's hourly cost increases by more than 50%
  - alert: KubernetesCostSpike
    expr: |
      (
        sum by (namespace) (
          opencost_namespace_hourly_cost_total
        ) - sum by (namespace) (
          opencost_namespace_hourly_cost_total offset 24h
        )
      )
      / sum by (namespace) (
        opencost_namespace_hourly_cost_total offset 24h
      ) > 0.5
    for: 2h
    labels:
      severity: warning
    annotations:
      summary: "Cost spike in namespace {{ $labels.namespace }}"
      description: "Hourly cost increased by {{ $value | humanizePercentage }} vs 24h ago"

  # Alert if total cluster cost exceeds budget
  - alert: ClusterCostBudgetExceeded
    expr: |
      sum(opencost_namespace_hourly_cost_total) * 720 > 50000
    for: 1h
    labels:
      severity: critical
    annotations:
      summary: "Cluster monthly cost forecast exceeds $50,000 budget"
      description: "Current hourly rate projects to ${{ $value | printf \"%.0f\" }} per month"
```

## Section 9: Cluster Consolidation

The most impactful optimization is often reducing the number of clusters or right-sizing the cluster node groups.

### Bin Packing Analysis

```bash
# Calculate actual cluster bin packing efficiency
kubectl get nodes -o json \
  | jq '
    .items[]
    | {
        node: .metadata.name,
        allocatable_cpu: .status.allocatable.cpu,
        allocatable_mem: .status.allocatable.memory,
        capacity_cpu: .status.capacity.cpu,
        capacity_mem: .status.capacity.memory
      }'

# Get per-node utilization
kubectl top nodes --no-headers \
  | awk '{
    printf "%-30s CPU: %s (%s)  MEM: %s (%s)\n",
    $1, $2, $3, $4, $5
  }'
```

### Karpenter Consolidation

```yaml
# Aggressive consolidation policy for non-critical clusters
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: default
spec:
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 5m  # consolidate after 5 min of underutilization
    budgets:
    - nodes: "20%"           # allow consolidating up to 20% of nodes at once
    - schedule: "0 2 * * *"  # nightly full consolidation window
      duration: 2h
      nodes: "100%"          # allow full consolidation during maintenance window
```

## Conclusion

Kubernetes cost optimization is a continuous process, not a one-time project. The toolchain outlined here provides:

1. **OpenCost**: Real-time cost allocation at any granularity with no vendor lock-in
2. **Kubecost**: Enterprise reporting, multi-cluster aggregation, and anomaly detection
3. **VPA in recommendation mode**: Rightsizing insights without automatic disruption
4. **Karpenter**: Dynamic node provisioning with spot integration and automatic consolidation
5. **kube-downscaler**: Automatic scale-down for dev/test environments during off-hours

Organizations that implement this full stack typically achieve 30-50% cloud cost reduction within the first quarter. The key is measuring first (deploy OpenCost), identifying the top waste categories (idle namespaces, overprovisioned pods), and addressing them systematically with automation.

Start with showback to drive cultural awareness, then move to chargeback as teams mature in their ability to estimate and manage their Kubernetes resource consumption.
