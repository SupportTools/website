---
title: "FinOps on Kubernetes: Cloud Cost Optimization, Chargeback, and Rightsizing"
date: 2028-09-12T00:00:00-05:00
draft: false
tags: ["FinOps", "Kubernetes", "Cloud Cost", "Kubecost", "AWS"]
categories:
- FinOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "FinOps framework on Kubernetes — Kubecost deployment, namespace cost allocation, spot instance strategies, rightsizing with VPA recommendations, reserved instance planning, chargeback reports, and cost anomaly alerting."
more_link: "yes"
url: "/finops-cloud-cost-optimization-kubernetes-guide-enterprise/"
---

Cloud bills surprise engineering leaders for a consistent reason: the infrastructure that enables Kubernetes' flexibility — autoscaling, namespace isolation, shared clusters — also makes cost attribution genuinely difficult. A single EKS cluster serving twenty teams, each with dozens of workloads, produces a single AWS line item that nobody owns. FinOps on Kubernetes is the discipline of breaking that bill apart, attributing costs accurately, incentivizing efficiency, and building the automated guardrails that prevent runaway spend. This guide covers the full stack: Kubecost for visibility, VPA for rightsizing, spot instance automation, chargeback reporting pipelines, and anomaly detection that pages before the month-end bill arrives.

<!--more-->

# FinOps on Kubernetes: Cloud Cost Optimization, Chargeback, and Rightsizing

## The FinOps Maturity Model for Kubernetes

The Cloud Financial Management Institute defines three maturity stages: Crawl, Walk, and Run. Most Kubernetes teams are firmly in Crawl — they have tags on some resources and a vague awareness that compute costs are high. The goal of this guide is to move you to Run: real-time cost visibility per namespace and team, automated rightsizing recommendations, proactive anomaly alerts, and a monthly chargeback report that finance actually trusts.

## Section 1: Kubecost Deployment on EKS

Kubecost is the most widely adopted Kubernetes cost monitoring tool. It integrates directly with the Kubernetes API to allocate costs at the pod, namespace, deployment, and label level, and it reconciles against cloud provider billing APIs for accurate pricing.

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer
helm repo update

kubectl create namespace kubecost

# Create AWS billing integration secret
kubectl create secret generic kubecost-aws-billing \
  --namespace kubecost \
  --from-literal=awsAccessKeyId=AKIAIOSFODNN7EXAMPLE \
  --from-literal=awsSecretAccessKey=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

```yaml
# kubecost-values.yaml
kubecostToken: ""  # Get from app.kubecost.com for business features
prometheus:
  enabled: true
  server:
    persistentVolume:
      enabled: true
      size: 50Gi
      storageClass: gp3

grafana:
  enabled: false  # Use your existing Grafana instance

networkCosts:
  enabled: true  # Track cross-AZ and egress costs

kubecostProductConfigs:
  clusterName: production-us-east-1
  currencyCode: USD
  awsSpotDataBucket: acme-spot-data
  awsSpotDataRegion: us-east-1
  awsSpotDataPrefix: spot-data
  projectID: "123456789012"
  labelMappingConfigs:
    enabled: true
    owner_label: team
    product_label: product
    environment_label: environment
    namespace_external_label: kubernetes_namespace
    controller_external_label: kubernetes_controller
    pod_external_label: kubernetes_pod_name

  # AWS Cost and Usage Report integration
  athenaProjectID: "123456789012"
  athenaBucketName: s3://acme-cur-reports
  athenaRegion: us-east-1
  athenaDatabase: athenacurcfn
  athenaTable: acme_cur

resources:
  requests:
    cpu: 200m
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 2Gi

persistentVolume:
  enabled: true
  size: 32Gi
  storageClass: gp3

serviceMonitor:
  enabled: true
  additionalLabels:
    release: prometheus

ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: kubecost-basic-auth
  hosts:
    - host: kubecost.acme.internal
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: kubecost-tls
      hosts:
        - kubecost.acme.internal
```

```bash
helm upgrade --install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --values kubecost-values.yaml \
  --wait \
  --timeout 15m
```

## Section 2: Namespace Cost Allocation and Labels

Accurate cost allocation requires consistent labeling. Enforce label policies with OPA Gatekeeper.

```yaml
# Gatekeeper ConstraintTemplate for required cost labels
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requirecostlabels
spec:
  crd:
    spec:
      names:
        kind: RequireCostLabels
      validation:
        openAPIV3Schema:
          properties:
            labels:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requirecostlabels

        violation[{"msg": msg}] {
          required := input.parameters.labels[_]
          not input.review.object.metadata.labels[required]
          msg := sprintf("Missing required cost label: %v", [required])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireCostLabels
metadata:
  name: require-cost-labels
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Namespace"]
  parameters:
    labels:
      - team
      - product
      - environment
      - cost-center
```

Apply standard labels to all namespaces:

```bash
# Label existing namespaces
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  echo "Labeling namespace: ${ns}"
  kubectl label namespace "${ns}" \
    team=unknown \
    product=unknown \
    environment=unknown \
    cost-center=unknown \
    --overwrite
done

# Example: properly labeled namespace
kubectl label namespace payments \
  team=payments-team \
  product=payment-platform \
  environment=production \
  cost-center=CC-4421 \
  --overwrite
```

## Section 3: Spot Instance Strategy

Running non-critical workloads on spot saves 60-80% versus on-demand. The key is correct workload classification.

### Node Group Configuration (EKS)

```yaml
# eks-spot-nodegroup.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: production
  region: us-east-1

managedNodeGroups:
  # On-demand for system and stateful workloads
  - name: system-ondemand
    instanceTypes: ["m5.2xlarge", "m5a.2xlarge", "m6i.2xlarge"]
    minSize: 3
    maxSize: 10
    desiredCapacity: 3
    labels:
      workload-type: system
      node-lifecycle: on-demand
    taints:
      - key: node-lifecycle
        value: on-demand
        effect: NoSchedule
    tags:
      k8s.io/cluster-autoscaler/enabled: "true"

  # Spot for stateless application workloads
  - name: app-spot-large
    instanceTypes:
      - m5.2xlarge
      - m5a.2xlarge
      - m6i.2xlarge
      - m5n.2xlarge
      - m5d.2xlarge
      - m4.2xlarge
    spot: true
    minSize: 0
    maxSize: 50
    desiredCapacity: 5
    labels:
      workload-type: application
      node-lifecycle: spot
    tags:
      k8s.io/cluster-autoscaler/enabled: "true"
      k8s.io/cluster-autoscaler/node-template/label/workload-type: application

  # Spot for batch and ML workloads
  - name: batch-spot-xlarge
    instanceTypes:
      - c5.4xlarge
      - c5a.4xlarge
      - c6i.4xlarge
      - c5n.4xlarge
    spot: true
    minSize: 0
    maxSize: 20
    desiredCapacity: 0
    labels:
      workload-type: batch
      node-lifecycle: spot
    taints:
      - key: workload-type
        value: batch
        effect: NoSchedule
```

### Pod Scheduling for Spot

```yaml
# Deployment configured for spot with fallback to on-demand
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments
spec:
  replicas: 6
  selector:
    matchLabels:
      app: payments-api
  template:
    metadata:
      labels:
        app: payments-api
        team: payments-team
        cost-center: CC-4421
    spec:
      # Prefer spot, tolerate interruptions
      tolerations:
        - key: node-lifecycle
          operator: Equal
          value: spot
          effect: NoSchedule
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: node-lifecycle
                    operator: In
                    values: ["spot"]
            - weight: 1
              preference:
                matchExpressions:
                  - key: node-lifecycle
                    operator: In
                    values: ["on-demand"]
        podAntiAffinity:
          # Spread across nodes to reduce spot interruption blast radius
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: payments-api
                topologyKey: kubernetes.io/hostname
      # Handle spot interruption gracefully
      terminationGracePeriodSeconds: 60
      containers:
        - name: payments-api
          image: ghcr.io/acme-corp/payments-api:1.4.2
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 1Gi
```

### AWS Node Termination Handler

```bash
helm repo add eks https://aws.github.io/eks-charts
helm upgrade --install aws-node-termination-handler eks/aws-node-termination-handler \
  --namespace kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableRebalanceMonitoring=true \
  --set enableRebalanceDraining=true \
  --set enableScheduledEventDraining=true \
  --set nodeTerminationGracePeriod=120 \
  --set podTerminationGracePeriod=60
```

## Section 4: Vertical Pod Autoscaler for Rightsizing

VPA analyzes actual resource usage and provides recommendations to close the gap between resource requests and actual consumption. This is the most impactful single action for cost reduction.

```bash
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler
./hack/vpa-up.sh
```

### VPA in Recommendation Mode

Start in recommendation-only mode to build confidence before enabling automatic updates:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payments-api-vpa
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payments-api
  updatePolicy:
    updateMode: "Off"  # Recommendation only — change to Auto when ready
  resourcePolicy:
    containerPolicies:
      - containerName: payments-api
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 4000m
          memory: 4Gi
        controlledResources: ["cpu", "memory"]
```

Read current recommendations:

```bash
kubectl describe vpa payments-api-vpa -n payments

# Output includes:
# Recommendation:
#   Container Recommendations:
#     Container Name: payments-api
#     Lower Bound:
#       Cpu: 200m
#       Memory: 256Mi
#     Target:
#       Cpu: 380m
#       Memory: 482Mi
#     Uncapped Target:
#       Cpu: 380m
#       Memory: 482Mi
#     Upper Bound:
#       Cpu: 1200m
#       Memory: 1Gi
```

### Bulk Rightsizing Script

```bash
#!/bin/bash
# rightsizing-report.sh — generate VPA recommendations for all deployments
set -euo pipefail

NAMESPACE="${1:-}"
OUTPUT_FILE="rightsizing-report-$(date +%Y%m%d).csv"

echo "namespace,deployment,container,current_cpu_request,recommended_cpu,current_memory_request,recommended_memory,potential_cpu_savings_pct" > "${OUTPUT_FILE}"

ns_selector=""
if [[ -n "${NAMESPACE}" ]]; then
  ns_selector="-n ${NAMESPACE}"
fi

# Create VPA objects for all deployments that don't have them
for deploy in $(kubectl get deployments ${ns_selector} --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {end}'); do
  ns=$(echo "${deploy}" | cut -d/ -f1)
  name=$(echo "${deploy}" | cut -d/ -f2)

  # Check if VPA already exists
  if ! kubectl get vpa "${name}-vpa" -n "${ns}" &>/dev/null; then
    kubectl apply -f - <<EOF
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: ${name}-vpa
  namespace: ${ns}
  labels:
    managed-by: rightsizing-script
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}
  updatePolicy:
    updateMode: "Off"
EOF
  fi
done

echo "Waiting 60s for VPA to collect data..."
sleep 60

# Collect recommendations
for vpa in $(kubectl get vpa ${ns_selector} --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {end}'); do
  ns=$(echo "${vpa}" | cut -d/ -f1)
  name=$(echo "${vpa}" | cut -d/ -f2)
  deploy_name="${name%-vpa}"

  current_cpu=$(kubectl get deployment "${deploy_name}" -n "${ns}" \
    -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}' 2>/dev/null || echo "unknown")
  current_mem=$(kubectl get deployment "${deploy_name}" -n "${ns}" \
    -o jsonpath='{.spec.template.spec.containers[0].resources.requests.memory}' 2>/dev/null || echo "unknown")
  recommended_cpu=$(kubectl get vpa "${name}" -n "${ns}" \
    -o jsonpath='{.status.recommendation.containerRecommendations[0].target.cpu}' 2>/dev/null || echo "n/a")
  recommended_mem=$(kubectl get vpa "${name}" -n "${ns}" \
    -o jsonpath='{.status.recommendation.containerRecommendations[0].target.memory}' 2>/dev/null || echo "n/a")

  echo "${ns},${deploy_name},app,${current_cpu},${recommended_cpu},${current_mem},${recommended_mem},TBD" >> "${OUTPUT_FILE}"
done

echo "Report written to ${OUTPUT_FILE}"
```

## Section 5: Chargeback Reporting Pipeline

Build a monthly chargeback report that allocates costs to cost centers and teams.

```python
#!/usr/bin/env python3
# generate_chargeback.py
"""
Pulls Kubecost allocation data via its API and generates chargeback reports
suitable for sending to finance.
"""
import requests
import json
import csv
from datetime import datetime, timedelta
from dataclasses import dataclass, fields
from typing import List, Dict

KUBECOST_URL = "http://kubecost.kubecost.svc.cluster.local:9090"
REPORT_DATE = datetime.now()
REPORT_START = (REPORT_DATE.replace(day=1) - timedelta(days=1)).replace(day=1)
REPORT_END = REPORT_DATE.replace(day=1) - timedelta(days=1)


@dataclass
class CostAllocation:
    cost_center: str
    team: str
    namespace: str
    cpu_cost: float
    memory_cost: float
    gpu_cost: float
    storage_cost: float
    network_cost: float
    total_cost: float
    efficiency_pct: float


def fetch_allocations(start: datetime, end: datetime) -> List[Dict]:
    """Fetch cost allocations from Kubecost API."""
    params = {
        "window": f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')},{end.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "aggregate": "namespace",
        "accumulate": "true",
        "shareIdle": "true",
        "shareTenancyCosts": "true",
        "shareNamespaces": "kube-system,monitoring,ingress-nginx",
    }
    resp = requests.get(f"{KUBECOST_URL}/model/allocation", params=params)
    resp.raise_for_status()
    return resp.json().get("data", [{}])[0]


def fetch_namespace_labels() -> Dict[str, Dict[str, str]]:
    """Fetch namespace labels from Kubernetes API for cost center mapping."""
    import subprocess
    result = subprocess.run(
        ["kubectl", "get", "namespaces", "-o", "json"],
        capture_output=True, text=True
    )
    namespaces = json.loads(result.stdout)
    return {
        ns["metadata"]["name"]: ns["metadata"].get("labels", {})
        for ns in namespaces["items"]
    }


def build_report(allocations: Dict, ns_labels: Dict[str, Dict]) -> List[CostAllocation]:
    rows = []
    for namespace, data in allocations.items():
        if namespace in ("__idle__", "__unallocated__"):
            continue

        labels = ns_labels.get(namespace, {})
        cpu_req = data.get("cpuCoreRequestAverage", 0)
        cpu_used = data.get("cpuCoreUsageAverage", 0)
        mem_req = data.get("ramByteRequestAverage", 0)
        mem_used = data.get("ramByteUsageAverage", 0)

        # Efficiency: actual usage vs requested
        if cpu_req > 0 and mem_req > 0:
            efficiency = ((cpu_used / cpu_req) * 0.5 + (mem_used / mem_req) * 0.5) * 100
        else:
            efficiency = 0.0

        rows.append(CostAllocation(
            cost_center=labels.get("cost-center", "UNKNOWN"),
            team=labels.get("team", "UNKNOWN"),
            namespace=namespace,
            cpu_cost=round(data.get("cpuCost", 0), 4),
            memory_cost=round(data.get("ramCost", 0), 4),
            gpu_cost=round(data.get("gpuCost", 0), 4),
            storage_cost=round(data.get("pvCost", 0), 4),
            network_cost=round(data.get("networkCost", 0), 4),
            total_cost=round(data.get("totalCost", 0), 4),
            efficiency_pct=round(efficiency, 1),
        ))

    return sorted(rows, key=lambda r: r.total_cost, reverse=True)


def write_csv_report(rows: List[CostAllocation], filename: str):
    with open(filename, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[field.name for field in fields(CostAllocation)])
        writer.writeheader()
        for row in rows:
            writer.writerow({field.name: getattr(row, field.name) for field in fields(CostAllocation)})
    print(f"CSV report written: {filename}")


def write_team_summary(rows: List[CostAllocation], filename: str):
    team_totals: Dict[str, Dict] = {}
    for row in rows:
        key = (row.cost_center, row.team)
        if key not in team_totals:
            team_totals[key] = {
                "cost_center": row.cost_center,
                "team": row.team,
                "total_cost": 0.0,
                "namespaces": [],
            }
        team_totals[key]["total_cost"] += row.total_cost
        team_totals[key]["namespaces"].append(row.namespace)

    with open(filename, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["cost_center", "team", "total_cost", "namespaces"])
        writer.writeheader()
        for data in sorted(team_totals.values(), key=lambda x: x["total_cost"], reverse=True):
            writer.writerow({
                "cost_center": data["cost_center"],
                "team": data["team"],
                "total_cost": round(data["total_cost"], 2),
                "namespaces": "|".join(data["namespaces"]),
            })
    print(f"Team summary written: {filename}")


if __name__ == "__main__":
    period = f"{REPORT_START.strftime('%Y-%m')}"
    print(f"Generating chargeback report for {period}")

    allocations = fetch_allocations(REPORT_START, REPORT_END)
    ns_labels = fetch_namespace_labels()
    rows = build_report(allocations, ns_labels)

    write_csv_report(rows, f"chargeback-detail-{period}.csv")
    write_team_summary(rows, f"chargeback-summary-{period}.csv")

    total = sum(r.total_cost for r in rows)
    print(f"Total allocated cost: ${total:,.2f}")
    print(f"Namespaces processed: {len(rows)}")
```

## Section 6: Cost Anomaly Detection

Automated alerting prevents bill shock.

```yaml
# PrometheusRule for cost anomaly detection
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubecost-cost-anomalies
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: cost.anomalies
      interval: 1h
      rules:
        # Alert when a namespace cost spikes >50% week-over-week
        - alert: NamespaceCostSpike
          expr: |
            (
              sum by (namespace) (
                container_cpu_usage_seconds_total * on(node) group_left()
                node_cpu_hourly_cost
              )
            ) /
            (
              sum by (namespace) (
                container_cpu_usage_seconds_total offset 7d * on(node) group_left()
                node_cpu_hourly_cost offset 7d
              )
            ) > 1.5
          for: 2h
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} cost spike detected"
            description: "Namespace {{ $labels.namespace }} costs have increased by more than 50% compared to last week."
            runbook_url: "https://wiki.acme.internal/runbooks/cost-spike"

        # Alert on total cluster daily cost exceeding budget
        - alert: ClusterDailyBudgetExceeded
          expr: |
            sum(
              kube_node_labels * on(node) group_left()
              node_total_hourly_cost
            ) * 24 > 5000
          for: 1h
          labels:
            severity: critical
          annotations:
            summary: "Cluster daily cost exceeds $5000 budget"
            description: "Projected daily cluster cost is ${{ $value | humanize }}. Budget is $5000."

        # Alert on idle resource waste
        - alert: HighIdleResourceWaste
          expr: |
            (
              1 - (
                sum(kube_pod_container_resource_requests{resource="cpu"}) /
                sum(kube_node_status_allocatable{resource="cpu"})
              )
            ) > 0.4
          for: 4h
          labels:
            severity: warning
          annotations:
            summary: "Cluster CPU idle rate above 40%"
            description: "More than 40% of cluster CPU is idle. Consider scaling down or migrating to smaller instance types."
```

## Section 7: Reserved Instance and Savings Plan Planning

```bash
#!/bin/bash
# ri-planning-report.sh
# Generates a savings opportunity report using AWS Cost Explorer

set -euo pipefail

START_DATE=$(date -d "30 days ago" +%Y-%m-%d)
END_DATE=$(date +%Y-%m-%d)

echo "=== On-Demand Spend Analysis (last 30 days) ==="
aws ce get-cost-and-usage \
  --time-period "Start=${START_DATE},End=${END_DATE}" \
  --granularity MONTHLY \
  --filter '{"Dimensions":{"Key":"PURCHASE_TYPE","Values":["On Demand"]}}' \
  --metrics "BlendedCost" \
  --group-by "Type=DIMENSION,Key=INSTANCE_TYPE" \
  --query 'ResultsByTime[0].Groups[?Metrics.BlendedCost.Amount > `100`].{Instance: Keys[0], Cost: Metrics.BlendedCost.Amount}' \
  --output table

echo ""
echo "=== Savings Plan Recommendations ==="
aws ce get-savings-plans-purchase-recommendation \
  --savings-plans-type COMPUTE_SP \
  --term-in-years ONE_YEAR \
  --payment-option NO_UPFRONT \
  --lookback-period-in-days THIRTY_DAYS \
  --query 'SavingsPlansPurchaseRecommendation.SavingsPlansPurchaseRecommendationDetails[0:5].{
    EstimatedMonthlySavings: EstimatedMonthlySavings,
    EstimatedSavingsPercentage: EstimatedSavingsPercentage,
    HourlyCommitment: HourlyCommitmentToPurchase
  }' \
  --output table

echo ""
echo "=== EC2 Reserved Instance Recommendations ==="
aws ce get-reservation-purchase-recommendation \
  --service "Amazon Elastic Compute Cloud - Compute" \
  --lookback-period-in-days THIRTY_DAYS \
  --term-in-years ONE_YEAR \
  --payment-option NO_UPFRONT \
  --query 'Recommendations[0].RecommendationDetails[0:5].{
    InstanceType: InstanceDetails.EC2InstanceDetails.InstanceType,
    Region: InstanceDetails.EC2InstanceDetails.Region,
    EstimatedMonthlySavings: EstimatedMonthlySavings,
    RecommendedNumberOfInstances: RecommendedNumberOfInstancesToPurchase
  }' \
  --output table
```

## Section 8: Resource Request Optimization with Goldilocks

Goldilocks by FairwindsOps provides a Kubernetes-native UI for VPA recommendations, making it easier to act on rightsizing data.

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm upgrade --install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --set controller.flags.on-by-default=false

# Enable for specific namespaces
kubectl label namespace payments goldilocks.fairwinds.com/enabled=true
kubectl label namespace orders goldilocks.fairwinds.com/enabled=true
kubectl label namespace inventory goldilocks.fairwinds.com/enabled=true
```

```yaml
# Goldilocks ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: goldilocks
  namespace: goldilocks
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: goldilocks-auth
spec:
  ingressClassName: nginx
  rules:
    - host: goldilocks.acme.internal
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: goldilocks-dashboard
                port:
                  number: 80
```

## Conclusion

FinOps on Kubernetes is a journey, not a one-time project. Start with Kubecost for visibility, enforce labeling standards with OPA Gatekeeper, move appropriate workloads to spot, and let VPA recommendations guide your resource request tuning. The chargeback pipeline closes the loop by giving teams real cost data tied to their decisions. Organizations that complete this cycle consistently find 30-50% of their Kubernetes cloud spend is recoverable through rightsizing and spot adoption alone — savings that compound every month the bill arrives.
