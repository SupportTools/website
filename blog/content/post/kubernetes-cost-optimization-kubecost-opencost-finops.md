---
title: "Kubernetes Cost Optimization: Kubecost, OpenCost, and FinOps Implementation"
date: 2030-12-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "FinOps", "Cost Optimization", "Kubecost", "OpenCost", "Karpenter", "Cloud Cost"]
categories:
- Kubernetes
- FinOps
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes cost optimization covering OpenCost and Kubecost deployment, cost allocation by namespace and team, idle resource identification, Karpenter spot instance integration, cloud reservation recommendations, and automated chargeback reporting for enterprise FinOps programs."
more_link: "yes"
url: "/kubernetes-cost-optimization-kubecost-opencost-finops/"
---

Kubernetes provides excellent resource isolation but poor cost visibility by default. A typical enterprise Kubernetes platform runs hundreds of workloads from dozens of teams with no built-in mechanism to understand which teams consume the most resources or which workloads are oversized. OpenCost and Kubecost solve the visibility problem, while tools like Karpenter optimize actual spending. This guide covers the full FinOps lifecycle for Kubernetes from measurement through optimization.

<!--more-->

# Kubernetes Cost Optimization: Kubecost, OpenCost, and FinOps Implementation

## The Kubernetes Cost Challenge

Before diving into tooling, understand why Kubernetes cost management is uniquely difficult:

1. **Shared nodes**: Multiple workloads share physical infrastructure
2. **Variable bin-packing**: Utilization changes dynamically with scheduling
3. **Request vs limit gap**: Resources reserved (requested) versus resources consumed differ significantly
4. **Shared services**: Ingress controllers, monitoring, and logging serve all tenants
5. **Idle capacity**: Buffer capacity held for burst workloads appears as waste

The goal is not to eliminate idle capacity (some is necessary) but to right-size it and attribute costs accurately to the teams consuming resources.

## OpenCost vs Kubecost

### OpenCost

OpenCost is the CNCF-graduated open source project that provides real-time cost allocation data. It is the foundation that Kubecost and other tools build upon.

**Strengths**:
- 100% open source, Apache 2.0 license
- CNCF project with strong community
- Lightweight (single container)
- Supports all major cloud providers and on-premises
- Prometheus metrics integration
- REST API for custom reporting

**Limitations**:
- Limited historical retention (7 days default without persistent storage)
- No built-in UI beyond basic metrics
- No savings recommendations
- No multi-cluster support (each cluster runs separately)

### Kubecost

Kubecost extends OpenCost with an enterprise feature set.

**Strengths**:
- Rich UI with drill-down cost analysis
- Multi-cluster aggregation (Kubecost Enterprise)
- Savings recommendations (rightsizing, spot, reservations)
- Budget alerts and cost policies
- SAML/SSO integration
- Longer history retention

**Limitations**:
- Free tier limited to 15-day retention
- Enterprise features require paid license
- More resource-intensive than OpenCost alone

**Recommendation**: Start with OpenCost for cost visibility. Add Kubecost if you need savings recommendations, multi-cluster reporting, or budget enforcement automation.

## Installing OpenCost

### Deploying OpenCost with Prometheus

```bash
# Add the OpenCost Helm repository
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update

# Create namespace
kubectl create namespace opencost

# Install with Prometheus integration
helm install opencost opencost/opencost \
  --namespace opencost \
  --set opencost.exporter.cloudProviderApiKey="" \
  --set opencost.prometheus.external.enabled=true \
  --set opencost.prometheus.external.url="http://prometheus-operated.monitoring:9090" \
  --set opencost.ui.enabled=true \
  --set opencost.ui.image.tag="latest" \
  --set serviceAccount.annotations."eks.amazonaws.com/role-arn"="arn:aws:iam::123456789012:role/OpenCostRole"
```

### OpenCost Helm Values for Production

```yaml
# values.yaml
opencost:
  exporter:
    # Cloud provider pricing key (AWS: service account with billing API access)
    cloudProviderApiKey: ""
    # Pricing update frequency
    defaultClusterDynamicPricingEnabled: false

    # Resource allocation
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 1Gi

    # Persistence for longer history
    persistence:
      enabled: true
      size: 32Gi
      storageClass: "gp3"

  prometheus:
    internal:
      enabled: false  # Use existing Prometheus
    external:
      enabled: true
      url: "http://prometheus-operated.monitoring:9090"

  # Cost model configuration
  costModel:
    # Node pricing for on-premises (AWS/GCP/Azure prices are fetched automatically)
    defaultIdleCPURate: 0.031611  # $/CPU/hour
    defaultIdleRAMRate: 0.004237  # $/GB/hour
    defaultStorageRate: 0.000138  # $/GB/hour

  ui:
    enabled: true
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 256Mi

serviceMonitor:
  enabled: true
  namespace: monitoring
  additionalLabels:
    prometheus: kube-prometheus
```

### AWS Cost Integration

For accurate AWS pricing, OpenCost needs access to the AWS Pricing API and optionally the CUR (Cost and Usage Report):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "pricing:GetProducts",
        "ce:GetCostAndUsage",
        "ec2:DescribeInstances",
        "ec2:DescribeSpotPriceHistory",
        "ec2:DescribeReservedInstances",
        "savingsplans:DescribeSavingsPlans"
      ],
      "Resource": "*"
    }
  ]
}
```

## Installing Kubecost

### Kubecost Free Tier Installation

```bash
# Add Kubecost Helm repository
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm repo update

# Install Kubecost
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set kubecostToken="" \
  --set prometheus.server.persistentVolume.enabled=true \
  --set prometheus.server.persistentVolume.size=32Gi \
  --set persistentVolume.enabled=true \
  --set persistentVolume.size=32Gi \
  --set global.prometheus.fqdn="http://prometheus-operated.monitoring:9090" \
  --set global.prometheus.enabled=false \
  --wait
```

### Kubecost Production Configuration

```yaml
# kubecost-values.yaml
kubecostToken: ""

# Use external Prometheus instead of bundled
global:
  prometheus:
    enabled: false
    fqdn: "http://prometheus-operated.monitoring:9090"
  grafana:
    enabled: false
    fqdn: "http://grafana.monitoring:3000"

# Kubecost product configuration
kubecostProductConfigs:
  clusterName: "production-us-east-1"
  currencyCode: "USD"
  azureBillingRegion: ""

  # AWS Spot instance pricing
  spotLabel: "eks.amazonaws.com/capacityType"
  spotLabelValue: "SPOT"

  # Shared namespace costs distribution
  sharedNamespaces: "kube-system,monitoring,ingress-nginx,cert-manager"
  sharedOverheadPercentage: "20"

# Cost allocation labels
customPricesEnabled: false

# SAML SSO (enterprise)
# saml:
#   enabled: true
#   secretName: kubecost-saml
#   idpMetadataURL: "https://login.example.com/metadata"

# Budget alerts
notifications:
  alertConfigs:
    # Alert when namespace exceeds $500/day
    alerts:
    - type: budget
      threshold: 500
      window: daily
      aggregation: namespace
      filter: "namespace:production"
      ownerContact:
        - "platform-team@example.com"
    # Alert when cluster daily cost increases > 20% week-over-week
    - type: weeklyDelta
      threshold: 20
      aggregation: cluster

# Persistence
persistentVolume:
  enabled: true
  size: 64Gi
  storageClass: "gp3"

resources:
  requests:
    cpu: 200m
    memory: 512Mi
  limits:
    cpu: 2000m
    memory: 2Gi
```

## Cost Allocation by Namespace, Label, and Team

### Label-Based Cost Allocation

The most powerful cost allocation method is labeling workloads with team/project metadata:

```yaml
# Apply cost labels to all workloads
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
  labels:
    app: api-server
    # FinOps labels for cost allocation
    cost-center: "engineering"
    team: "platform"
    project: "core-api"
    environment: "production"
    owner: "alice@example.com"
spec:
  template:
    metadata:
      labels:
        app: api-server
        cost-center: "engineering"
        team: "platform"
        project: "core-api"
        environment: "production"
```

### Enforcing Cost Labels with OPA Gatekeeper

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requiredcostlabels
spec:
  crd:
    spec:
      names:
        kind: RequiredCostLabels
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package requiredcostlabels

      required_labels := {"cost-center", "team", "project"}

      violation[{"msg": msg}] {
        provided := {label | input.review.object.metadata.labels[label]}
        missing := required_labels - provided
        count(missing) > 0
        msg := sprintf("Missing required cost labels: %v", [missing])
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequiredCostLabels
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
  parameters: {}
```

### OpenCost REST API for Custom Reporting

```bash
# OpenCost exposes a REST API for programmatic cost querying

# Cost allocation for the last 30 days by namespace
curl -s "http://opencost.opencost:9003/allocation/compute?\
aggregate=namespace&\
window=30d&\
accumulate=true" | jq '.data[] | {name: .name, cost: .totalCost}'

# Cost by label (team)
curl -s "http://opencost.opencost:9003/allocation/compute?\
aggregate=label:team&\
window=7d&\
accumulate=false" | jq .

# Idle costs
curl -s "http://opencost.opencost:9003/allocation/compute?\
aggregate=cluster&\
window=24h&\
includeIdle=true" | jq '.data[] | {name: .name, totalCost: .totalCost, idleCost: .idleLocalCost}'

# Export data to CSV for chargeback
curl -s "http://opencost.opencost:9003/allocation/compute?\
aggregate=label:cost-center,label:team,label:project&\
window=month&\
accumulate=true" | \
jq -r '.data[] | [.name, .cpuCost, .ramCost, .pvCost, .networkCost, .totalCost] | @csv' \
> cost-report-$(date +%Y-%m).csv
```

## Identifying and Eliminating Idle Resources

### Kubecost Savings Recommendations API

```bash
# Get rightsizing recommendations from Kubecost
curl -s "http://kubecost.kubecost:9090/savings/requestSizing?\
filterNamespaces=production&\
targetCPUUtilization=0.75&\
targetRAMUtilization=0.75" | \
jq '.recommendations[] | {
  namespace: .namespace,
  deployment: .controllerName,
  currentCPURequest: .currentCPUReq,
  recommendedCPU: .recommendedCPU,
  currentMemRequest: .currentRAMReq,
  recommendedMem: .recommendedRAM,
  monthlySavings: .monthlySavings
}' | head -50

# Get oversized pods (where actual usage is < 50% of request)
curl -s "http://opencost.opencost:9003/allocation/compute?\
aggregate=pod&\
window=7d&\
accumulate=true" | \
jq -r '.data[] |
  select(.cpuEfficiency < 0.5 or .ramEfficiency < 0.5) |
  [.name, .cpuEfficiency, .ramEfficiency, .totalCost] | @tsv'
```

### Automated Rightsizing Script

```bash
#!/bin/bash
# rightsize-recommendations.sh
# Generate actionable rightsizing recommendations

NAMESPACE="${1:-default}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus-operated.monitoring:9090}"
OUTPUT_FILE="rightsizing-$(date +%Y%m%d).csv"

echo "namespace,deployment,container,cpu_request,cpu_p95_usage,cpu_recommendation,mem_request,mem_p95_usage,mem_recommendation,monthly_savings_usd" > "$OUTPUT_FILE"

# Get all deployments in namespace
DEPLOYMENTS=$(kubectl get deployments -n "$NAMESPACE" \
  -o jsonpath='{.items[*].metadata.name}')

# CPU price: $0.048/CPU/hour = $0.048 * 24 * 30 = $34.56/CPU/month
CPU_MONTHLY=34.56
# RAM price: $0.006/GB/hour = $0.006 * 24 * 30 = $4.32/GB/month
RAM_MONTHLY=4.32

for deployment in $DEPLOYMENTS; do
    # Get containers
    CONTAINERS=$(kubectl get deployment "$deployment" -n "$NAMESPACE" \
        -o jsonpath='{.spec.template.spec.containers[*].name}')

    for container in $CONTAINERS; do
        # Get current resource requests
        CPU_REQUEST=$(kubectl get deployment "$deployment" -n "$NAMESPACE" \
            -o jsonpath="{.spec.template.spec.containers[?(@.name=='$container')].resources.requests.cpu}")
        MEM_REQUEST=$(kubectl get deployment "$deployment" -n "$NAMESPACE" \
            -o jsonpath="{.spec.template.spec.containers[?(@.name=='$container')].resources.requests.memory}")

        if [ -z "$CPU_REQUEST" ] || [ -z "$MEM_REQUEST" ]; then
            continue
        fi

        # Query Prometheus for P95 CPU usage over last 7 days
        CPU_P95=$(curl -s "${PROMETHEUS_URL}/api/v1/query" \
            --data-urlencode "query=quantile_over_time(0.95,
                rate(container_cpu_usage_seconds_total{
                    namespace=\"$NAMESPACE\",
                    pod=~\"${deployment}-.*\",
                    container=\"$container\"
                }[5m])[7d:5m])" | \
            jq -r '.data.result[0].value[1] // "0"')

        # Query Prometheus for P95 memory usage over last 7 days
        MEM_P95=$(curl -s "${PROMETHEUS_URL}/api/v1/query" \
            --data-urlencode "query=quantile_over_time(0.95,
                container_memory_working_set_bytes{
                    namespace=\"$NAMESPACE\",
                    pod=~\"${deployment}-.*\",
                    container=\"$container\"
                }[7d:5m])" | \
            jq -r '.data.result[0].value[1] // "0"')

        # Calculate recommendations (P95 usage + 25% headroom)
        CPU_REC=$(echo "$CPU_P95 * 1.25" | bc -l | xargs printf "%.3f")
        MEM_REC=$(echo "$MEM_P95 * 1.25" | bc | numfmt --to=iec)

        # Calculate potential savings
        # Convert CPU request to cores
        CPU_REQ_CORES=$(echo "$CPU_REQUEST" | sed 's/m$/\/1000/' | bc -l)
        CPU_SAVINGS=$(echo "($CPU_REQ_CORES - $CPU_P95) * 1.25 * $CPU_MONTHLY" | bc -l | xargs printf "%.2f")

        echo "$NAMESPACE,$deployment,$container,$CPU_REQUEST,$CPU_P95,$CPU_REC,$MEM_REQUEST,$MEM_P95,$MEM_REC,$CPU_SAVINGS" >> "$OUTPUT_FILE"
    done
done

echo "Report generated: $OUTPUT_FILE"
echo "Top savings opportunities:"
sort -t',' -k10 -rn "$OUTPUT_FILE" | head -10
```

## Spot Instance Integration with Karpenter

Karpenter is AWS's open-source cluster autoscaler that can significantly reduce costs by mixing spot and on-demand instances intelligently:

### Karpenter Installation

```bash
# Install Karpenter
export CLUSTER_NAME="production"
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export KARPENTER_VERSION="v0.37.0"

# Create Karpenter IAM role using IRSA
eksctl create iamserviceaccount \
  --cluster $CLUSTER_NAME \
  --namespace karpenter \
  --name karpenter \
  --role-name KarpenterControllerRole-$CLUSTER_NAME \
  --attach-policy-arn arn:aws:iam::$AWS_ACCOUNT_ID:policy/KarpenterControllerPolicy-$CLUSTER_NAME \
  --approve

# Install via Helm
helm install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version $KARPENTER_VERSION \
  --namespace karpenter \
  --create-namespace \
  --set settings.aws.clusterName=$CLUSTER_NAME \
  --set settings.aws.defaultInstanceProfile=KarpenterNodeInstanceProfile-$CLUSTER_NAME \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --wait
```

### NodePool Configuration for Cost Optimization

```yaml
# karpenter-nodepool.yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: default
spec:
  template:
    metadata:
      labels:
        managed-by: karpenter
    spec:
      # Instance requirements - allow a wide range for better spot availability
      requirements:
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]
      - key: kubernetes.io/os
        operator: In
        values: ["linux"]
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]  # Prefer spot, fallback to on-demand
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]  # Compute, memory, and general purpose
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["2"]  # Gen 3+ only (newer, more efficient)
      - key: karpenter.k8s.aws/instance-size
        operator: NotIn
        values: ["nano", "micro", "small"]  # Minimum viable size

      # Node configuration
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: default

      # Expiry for spot recycling
      expireAfter: 720h  # 30 days - force node recycling

  # Disruption budget
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    expireAfter: 720h

  # Limits prevent runaway scaling
  limits:
    cpu: "1000"
    memory: "4000Gi"
---
apiVersion: karpenter.k8s.aws/v1beta1
kind: EC2NodeClass
metadata:
  name: default
spec:
  amiFamily: AL2   # Amazon Linux 2
  role: KarpenterNodeRole-production
  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: production
  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: production
  tags:
    managed-by: karpenter
    cluster: production
  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 100Gi
      volumeType: gp3
      iops: 3000
      throughput: 125
      encrypted: true
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1
    httpTokens: required  # IMDSv2 required
```

### Workload Configuration for Spot Compatibility

```yaml
# Configure workloads to work well with spot instances
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  # Use multiple replicas - never run stateless workloads as single replicas on spot
  replicas: 3
  template:
    spec:
      # Allow scheduling on spot instances
      tolerations:
      - key: "karpenter.sh/capacity-type"
        operator: "Equal"
        value: "spot"
        effect: "NoSchedule"

      # Prefer spot but allow on-demand fallback
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: karpenter.sh/capacity-type
                operator: In
                values: ["spot"]

      # Spread across availability zones for resilience
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-server

      # Graceful shutdown for spot interruptions
      terminationGracePeriodSeconds: 60  # Max 2-minute warning before spot termination
      containers:
      - name: app
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 15"]  # Allow load balancer to drain
```

### Spot Interruption Handler

```bash
# Install the AWS Node Termination Handler for spot interruption notifications
helm repo add eks https://aws.github.io/eks-charts
helm install aws-node-termination-handler eks/aws-node-termination-handler \
  --namespace kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableScheduledEventDraining=true \
  --set enableRebalanceMonitoring=true \
  --set deleteLocalData=true \
  --set ignoreDaemonsSets=true \
  --set taintNode=true \
  --set podTerminationGracePeriod=60
```

## Cloud Reservation Recommendations

### Analyzing On-Demand vs Reserved vs Spot Distribution

```bash
# Query EC2 instance type distribution for reservation analysis
aws ec2 describe-instances \
  --filters "Name=tag:kubernetes.io/cluster/production,Values=owned" \
  --query 'Reservations[*].Instances[*].[InstanceType,InstanceLifecycle,LaunchTime]' \
  --output table

# Get Savings Plans recommendations from AWS
aws savingsplans describe-savings-plans-offering-rates \
  --service-code "AmazonEC2" \
  --product-type "EC2" \
  --plan-type "ComputeSavingsPlans" \
  --output json | \
  jq '.SearchResults[] | {instanceType: .Properties.instanceType, rate: .Rate}'

# Query cost explorer for optimization recommendations
aws ce get-rightsizing-recommendation \
  --service EC2 \
  --configuration '{
    "RecommendationTarget": "SAME_INSTANCE_FAMILY",
    "BenefitsConsidered": true
  }' \
  --output json | \
  jq '.RightsizingRecommendations[] | {
    resource: .CurrentInstance.ResourceId,
    type: .RightsizingType,
    savings: .EstimatedMonthlySavings
  }'
```

### Commitment Recommendations Based on OpenCost Data

```python
#!/usr/bin/env python3
"""
analyze-commitments.py
Analyzes OpenCost data to recommend Reserved Instance or Savings Plan purchases
"""

import json
import subprocess
import datetime

def get_opencost_data(window="30d"):
    """Fetch cost allocation data from OpenCost API"""
    result = subprocess.run([
        "curl", "-s",
        f"http://opencost.opencost:9003/allocation/compute?aggregate=cluster&window={window}&accumulate=true"
    ], capture_output=True, text=True)
    return json.loads(result.stdout)

def calculate_commitment_recommendations(data):
    """Calculate RI/SP commitment recommendations"""
    recommendations = []

    for allocation in data.get("data", {}).values():
        cluster_name = allocation.get("name", "unknown")
        cpu_hours = allocation.get("cpuCoreHours", 0)
        ram_gb_hours = allocation.get("ramByteHours", 0) / (1024**3)
        total_cost = allocation.get("totalCost", 0)

        # Calculate daily averages
        days = 30
        daily_cpu = cpu_hours / days
        daily_ram = ram_gb_hours / days
        daily_cost = total_cost / days

        # Savings Plan pricing assumptions
        on_demand_hourly = daily_cost / 24

        # 1-year No Upfront Compute Savings Plan: ~20-30% discount
        sp_1yr_savings_pct = 0.25
        sp_1yr_monthly_savings = total_cost * sp_1yr_savings_pct

        # 3-year No Upfront: ~40-50% discount
        sp_3yr_savings_pct = 0.45
        sp_3yr_monthly_savings = total_cost * sp_3yr_savings_pct

        recommendations.append({
            "cluster": cluster_name,
            "monthly_cost": round(total_cost, 2),
            "1yr_sp_commitment_hourly": round(on_demand_hourly * (1 - sp_1yr_savings_pct), 2),
            "1yr_monthly_savings": round(sp_1yr_monthly_savings, 2),
            "3yr_sp_commitment_hourly": round(on_demand_hourly * (1 - sp_3yr_savings_pct), 2),
            "3yr_monthly_savings": round(sp_3yr_monthly_savings, 2),
        })

    return recommendations

data = get_opencost_data()
recommendations = calculate_commitment_recommendations(data)

print("Savings Plan Recommendations:")
print("-" * 80)
for rec in recommendations:
    print(f"Cluster: {rec['cluster']}")
    print(f"  Monthly Cost: ${rec['monthly_cost']:,.2f}")
    print(f"  1-Year SP: ${rec['1yr_sp_commitment_hourly']:.2f}/hr commitment, saves ${rec['1yr_monthly_savings']:,.2f}/month")
    print(f"  3-Year SP: ${rec['3yr_sp_commitment_hourly']:.2f}/hr commitment, saves ${rec['3yr_monthly_savings']:,.2f}/month")
    print()
```

## Chargeback Reporting

### Automated Monthly Chargeback Report

```bash
#!/bin/bash
# monthly-chargeback-report.sh
# Generates monthly cost allocation report for chargeback

YEAR_MONTH=$(date +%Y-%m)
REPORT_DIR="/var/reports/chargeback"
mkdir -p "$REPORT_DIR"

REPORT_FILE="${REPORT_DIR}/chargeback-${YEAR_MONTH}.csv"
SUMMARY_FILE="${REPORT_DIR}/chargeback-summary-${YEAR_MONTH}.csv"

echo "Generating chargeback report for $YEAR_MONTH"

# Query OpenCost for monthly allocation by team label
curl -s "http://opencost.opencost:9003/allocation/compute?\
aggregate=label:team,label:cost-center,label:project&\
window=month&\
accumulate=true" | \
jq -r '.data[] |
  .name as $labels |
  [
    ($labels | split(",")[0] | split(":")[1] // "untagged"),  # team
    ($labels | split(",")[1] | split(":")[1] // "unknown"),  # cost-center
    ($labels | split(",")[2] | split(":")[1] // "unknown"),  # project
    (.cpuCost | . * 100 | round / 100),
    (.ramCost | . * 100 | round / 100),
    (.pvCost | . * 100 | round / 100),
    (.networkCost | . * 100 | round / 100),
    (.totalCost | . * 100 | round / 100)
  ] | @csv' | \
sort > /tmp/team-costs.csv

# Add CSV header
echo "team,cost_center,project,cpu_cost_usd,memory_cost_usd,storage_cost_usd,network_cost_usd,total_cost_usd" > "$REPORT_FILE"
cat /tmp/team-costs.csv >> "$REPORT_FILE"

echo "Detailed report: $REPORT_FILE"

# Generate summary by cost center
echo "cost_center,total_monthly_cost_usd,vs_last_month_pct" > "$SUMMARY_FILE"

# Get last month for comparison
LAST_MONTH_REPORT="${REPORT_DIR}/chargeback-$(date -d 'last month' +%Y-%m).csv"

awk -F',' 'NR>1 {
    total[$2] += $8
} END {
    for (cc in total) {
        printf "%s,%.2f\n", cc, total[cc]
    }
}' "$REPORT_FILE" | sort -t',' -k2 -rn >> "$SUMMARY_FILE"

echo "Summary report: $SUMMARY_FILE"

# Email reports to finance team
if command -v mail &>/dev/null; then
    {
        echo "Monthly Kubernetes chargeback report for $YEAR_MONTH"
        echo ""
        echo "Top 10 teams by cost:"
        sort -t',' -k8 -rn "$REPORT_FILE" | head -11
        echo ""
        echo "Full report attached."
    } | mail -s "Kubernetes Chargeback Report - $YEAR_MONTH" \
        -A "$REPORT_FILE" \
        finance@example.com platform-team@example.com
fi
```

### Prometheus-Based Cost Dashboards

```yaml
# Prometheus recording rules for cost metrics
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cost-allocation-rules
  namespace: monitoring
spec:
  groups:
  - name: cost-allocation
    interval: 1h
    rules:
    # Daily cost per namespace
    - record: namespace:cost:daily
      expr: |
        sum by (namespace) (
          opencost_allocation_totalcost * on(namespace) group_left(team,cost_center)
          kube_namespace_labels{label_team!=""}
        )

    # CPU cost efficiency (actual usage vs requested)
    - record: deployment:cpu_efficiency:avg
      expr: |
        sum by (namespace, deployment) (
          rate(container_cpu_usage_seconds_total[1h])
        ) /
        sum by (namespace, deployment) (
          kube_pod_container_resource_requests{resource="cpu"}
        )

    # Memory cost efficiency
    - record: deployment:memory_efficiency:avg
      expr: |
        sum by (namespace, deployment) (
          container_memory_working_set_bytes
        ) /
        sum by (namespace, deployment) (
          kube_pod_container_resource_requests{resource="memory"}
        )
```

```yaml
# Alerting on cost anomalies
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cost-alerts
  namespace: monitoring
spec:
  groups:
  - name: cost-anomalies
    rules:
    - alert: NamespaceCostSpike
      expr: |
        (namespace:cost:daily > 1000)
        AND
        (namespace:cost:daily > 2 * avg_over_time(namespace:cost:daily[7d]))
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Cost spike in namespace {{ $labels.namespace }}"
        description: "Daily cost is ${{ $value | humanize }} which is more than 2x the 7-day average"

    - alert: LowCPUEfficiency
      expr: |
        avg by (namespace, deployment) (deployment:cpu_efficiency:avg) < 0.1
      for: 24h
      labels:
        severity: info
      annotations:
        summary: "Low CPU efficiency: {{ $labels.deployment }} in {{ $labels.namespace }}"
        description: "CPU efficiency is {{ $value | humanizePercentage }}, consider reducing CPU requests"
```

## Cost Reduction Best Practices Summary

### Quick Wins (< 1 week)

```bash
# 1. Find pods with no resource requests (BestEffort class - invisible to cost tools)
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.spec.containers[].resources.requests == null) |
  "\(.metadata.namespace)/\(.metadata.name)"
'

# 2. Find namespaces with consistently low utilization
kubectl top pods -A --sort-by=cpu | head -30

# 3. Find PVCs that are not mounted by any pod (orphaned storage)
kubectl get pvc -A -o json | jq -r '
  .items[] |
  select(.status.phase == "Bound") |
  select(.metadata.ownerReferences == null) |
  "\(.metadata.namespace)/\(.metadata.name): \(.spec.resources.requests.storage)"
'

# 4. Find jobs and pods in Failed state consuming resources
kubectl get pods -A --field-selector=status.phase=Failed

# 5. Delete completed jobs older than 24 hours
kubectl delete job -A \
  $(kubectl get jobs -A -o jsonpath='{range .items[?(@.status.completionTime)]}{.metadata.namespace}/{.metadata.name} {end}' \
  | tr ' ' '\n' | head -20)
```

### Medium-Term Optimizations (1-4 weeks)

1. Implement VPA (Vertical Pod Autoscaler) in recommendation mode for all deployments
2. Enable Karpenter with spot instances for all non-critical workloads
3. Right-size all deployments based on 30-day P95 utilization data
4. Consolidate low-utilization namespaces onto shared node pools
5. Move development and staging to smaller, spot-only node groups with automated shutdowns

### Long-Term Strategy (1-3 months)

1. Purchase 1-year Compute Savings Plans for baseline on-demand capacity
2. Implement namespace-level cost budgets with automated alerts
3. Create cost dashboards visible to all engineering teams
4. Add cost labels as required fields via Gatekeeper policies
5. Schedule non-production workloads to run only during business hours

## Summary

Kubernetes cost optimization requires both visibility and action. OpenCost provides the measurement foundation, while Karpenter enables intelligent instance selection and spot usage. The operational workflow is:

- Deploy OpenCost for cost allocation visibility across namespaces and labels
- Add Kubecost if you need multi-cluster reporting or automated savings recommendations
- Enforce cost labels via Gatekeeper so every workload is attributable to a team
- Generate monthly chargeback reports to create incentives for efficient resource usage
- Right-size workloads using VPA recommendations before committing to reserved capacity
- Migrate stateless workloads to Karpenter with spot instances for 40-70% compute savings
- Purchase Compute Savings Plans for the remaining on-demand baseline after spot migration
- Monitor cost efficiency metrics (CPU efficiency, memory efficiency) and alert on regressions
