---
title: "FinOps for Kubernetes: Cost Visibility and Optimization at Scale"
date: 2027-12-19T00:00:00-05:00
draft: false
tags: ["FinOps", "Kubernetes", "Kubecost", "OpenCost", "Cost Optimization", "VPA", "Spot Instances", "Cloud Cost"]
categories:
- Kubernetes
- FinOps
- Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive FinOps guide for Kubernetes covering Kubecost vs OpenCost cost allocation, namespace and team chargeback, spot instance strategies, VPA-based right-sizing, resource request optimization, savings plans, and cost anomaly detection."
more_link: "yes"
url: "/finops-kubernetes-cost-optimization-guide/"
---

Kubernetes clusters regularly overspend by 40-60% due to over-provisioned resource requests, underutilized nodes, and lack of allocation visibility. FinOps practices applied to Kubernetes close this gap through continuous cost measurement, team chargeback, right-sizing recommendations, and workload placement optimization. This guide covers the full FinOps cycle for Kubernetes: tooling selection, cost allocation architecture, spot instance strategies, VPA-driven right-sizing, and automated anomaly detection.

<!--more-->

# FinOps for Kubernetes: Cost Visibility and Optimization at Scale

## The Kubernetes Cost Problem

Cloud cost management for Kubernetes differs fundamentally from traditional IaaS billing because costs are shared: a single EC2 instance or GKE node runs dozens of pods from multiple teams. Standard cloud billing shows node costs, not workload costs. Without explicit allocation, a finance team sees a $50,000/month Kubernetes line item with no visibility into which application, team, or product generated it.

The FinOps for Kubernetes cycle operates in three phases:

1. **Inform**: Instrument cost allocation by namespace, label, and team
2. **Optimize**: Identify waste through right-sizing, idle resource detection, and spot migration
3. **Operate**: Implement governance through budgets, anomaly alerts, and chargeback

## Kubecost vs OpenCost

| Feature | Kubecost (Free Tier) | Kubecost (Enterprise) | OpenCost |
|---------|---------------------|----------------------|---------|
| Cost allocation | Namespace, label | Namespace, label, team, product | Namespace, label |
| Multi-cluster | No | Yes | Limited |
| Savings recommendations | Basic | Advanced (rightsizing, Spot) | Basic |
| Cost anomaly detection | No | Yes | No |
| Chargeback/showback | No | Yes | Limited |
| Network cost | No | Yes | No |
| External costs | No | Yes (AWS, Azure, GCP) | No |
| License | Apache 2.0 | Commercial | Apache 2.0 |

For single-cluster visibility, OpenCost suffices. For multi-cluster chargeback and anomaly detection, Kubecost Enterprise or a custom aggregation layer on top of OpenCost is necessary.

## Installing OpenCost

OpenCost is the CNCF standard for Kubernetes cost allocation. It integrates with cloud billing APIs to provide accurate on-demand pricing:

```bash
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update

helm upgrade --install opencost opencost/opencost \
  --namespace opencost \
  --create-namespace \
  --set opencost.exporter.cloudProviderApiKey="" \
  --set opencost.ui.enabled=true \
  --set opencost.prometheus.internal.enabled=false \
  --set opencost.prometheus.external.url="http://prometheus-operated.monitoring.svc.cluster.local:9090" \
  --values opencost-values.yaml \
  --version 1.43.0
```

```yaml
# opencost-values.yaml
opencost:
  exporter:
    aws:
      access_key_id: ""
      secret_access_key: ""
      spot_data_bucket: ""
    cloudProviderApiKey: ""
    defaultClusterId: "production-us-east-1"
  metrics:
    serviceMonitor:
      enabled: true
      additionalLabels:
        prometheus: kube-prometheus
  prometheus:
    external:
      enabled: true
      url: http://prometheus-operated.monitoring.svc.cluster.local:9090
```

## Installing Kubecost

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm repo update

helm upgrade --install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set global.prometheus.fqdn="http://prometheus-operated.monitoring.svc.cluster.local:9090" \
  --set global.prometheus.enabled=false \
  --set prometheus.server.enabled=false \
  --set global.grafana.enabled=false \
  --set kubecostToken="" \
  --values kubecost-values.yaml \
  --version 2.3.0
```

```yaml
# kubecost-values.yaml
kubecostProductConfigs:
  clusterName: "production-us-east-1"
  currencyCode: "USD"
  defaultIdle: true

  # AWS pricing integration
  cloudProviderApiKey: ""
  awsServiceKeyName: ""
  awsServiceKeyPassword: ""
  awsSpotDataBucket: "my-spot-data-bucket"
  awsSpotDataRegion: "us-east-1"
  awsSpotDataPrefix: "spot-data"

  # Label mapping for cost allocation
  labelMappingVars:
    owner_label: "team"
    product_label: "product"
    environment_label: "environment"
    department_label: "department"
    costcenter_label: "cost-center"

  # Shared costs allocation
  sharedNamespaces: "kube-system,monitoring,cert-manager,ingress-nginx"
  sharedOverhead: "0"

networkCosts:
  enabled: true
  config:
    services:
      amazon-web-services: true
```

## Cost Allocation Label Strategy

Cost allocation depends on consistent labels. Enforce label requirements with Kyverno:

```yaml
# kyverno-require-cost-labels.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-cost-allocation-labels
  annotations:
    policies.kyverno.io/title: Require Cost Allocation Labels
    policies.kyverno.io/category: FinOps
    policies.kyverno.io/description: |
      All Deployments and StatefulSets must have cost allocation labels
      for team, product, and cost-center.
spec:
  validationFailureAction: enforce
  background: true
  rules:
    - name: check-cost-labels
      match:
        any:
          - resources:
              kinds:
                - Deployment
                - StatefulSet
              namespaces:
                - "!kube-system"
                - "!monitoring"
                - "!cert-manager"
      validate:
        message: |
          Required cost allocation labels missing.
          Labels required: team, product, cost-center, environment
        pattern:
          metadata:
            labels:
              team: "?*"
              product: "?*"
              cost-center: "?*"
              environment: "?*"
```

## Namespace-Level Cost Reports

Query OpenCost API for namespace cost breakdown:

```bash
# 30-day cost by namespace
curl -G http://opencost.opencost.svc.cluster.local:9003/allocation \
  --data-urlencode "window=30d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "accumulate=true" | \
  jq '.data[0] | to_entries |
    sort_by(-.value.totalCost) |
    .[:20] |
    map({namespace: .key, cost: (.value.totalCost | . * 100 | round / 100)}) |
    .[]'
```

```bash
# Cost by team label
curl -G http://opencost.opencost.svc.cluster.local:9003/allocation \
  --data-urlencode "window=30d" \
  --data-urlencode "aggregate=label:team" \
  --data-urlencode "accumulate=true" | \
  jq '[.data[0] | to_entries[] |
    {team: .key, cost: (.value.totalCost | . * 100 | round / 100),
     cpu_cost: (.value.cpuCost | . * 100 | round / 100),
     memory_cost: (.value.ramCost | . * 100 | round / 100)}] |
    sort_by(-.cost)'
```

## Chargeback Reporting with Python

Automated monthly chargeback reports pushed to Slack or email:

```python
#!/usr/bin/env python3
"""Monthly Kubernetes chargeback report generator."""

import json
import os
import requests
from datetime import datetime
from collections import defaultdict


OPENCOST_URL = os.getenv("OPENCOST_URL", "http://opencost.opencost.svc.cluster.local:9003")
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url")


def fetch_allocation(window: str, aggregate: str) -> dict:
    """Fetch cost allocation from OpenCost API."""
    response = requests.get(
        f"{OPENCOST_URL}/allocation",
        params={
            "window": window,
            "aggregate": aggregate,
            "accumulate": "true",
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def generate_team_report(window: str = "30d") -> str:
    """Generate team chargeback report."""
    data = fetch_allocation(window, "label:team")
    allocations = data["data"][0]

    teams = []
    total = 0.0

    for team_name, allocation in allocations.items():
        if team_name == "__unallocated__":
            continue
        cost = allocation.get("totalCost", 0)
        cpu_cost = allocation.get("cpuCost", 0)
        ram_cost = allocation.get("ramCost", 0)
        pv_cost = allocation.get("pvCost", 0)
        teams.append({
            "name": team_name,
            "total": round(cost, 2),
            "cpu": round(cpu_cost, 2),
            "memory": round(ram_cost, 2),
            "storage": round(pv_cost, 2),
        })
        total += cost

    teams.sort(key=lambda x: x["total"], reverse=True)

    report_lines = [
        f"*Kubernetes Cost Report — {window}*",
        f"Total Cluster Cost: *${total:,.2f}*",
        "",
        "| Team | Total | CPU | Memory | Storage |",
        "|------|-------|-----|--------|---------|",
    ]

    for team in teams:
        pct = (team["total"] / total * 100) if total > 0 else 0
        report_lines.append(
            f"| {team['name']} | ${team['total']:,.2f} ({pct:.1f}%) "
            f"| ${team['cpu']:,.2f} | ${team['memory']:,.2f} | ${team['storage']:,.2f} |"
        )

    unallocated = allocations.get("__unallocated__", {})
    if unallocated:
        unalloc_cost = unallocated.get("totalCost", 0)
        report_lines.append(
            f"| __unallocated__ | ${unalloc_cost:,.2f} "
            f"({unalloc_cost/total*100:.1f}%) | - | - | - |"
        )

    return "\n".join(report_lines)


def post_to_slack(message: str) -> None:
    """Post report to Slack channel."""
    payload = {
        "text": message,
        "mrkdwn": True,
    }
    response = requests.post(
        SLACK_WEBHOOK_URL,
        json=payload,
        timeout=10,
    )
    response.raise_for_status()


if __name__ == "__main__":
    report = generate_team_report("30d")
    print(report)
    if SLACK_WEBHOOK_URL and "placeholder" not in SLACK_WEBHOOK_URL:
        post_to_slack(report)
```

Deploy as a CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cost-report
  namespace: kubecost
spec:
  schedule: "0 9 1 * *"   # First of each month at 09:00
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: reporter
              image: python:3.11-slim
              command:
                - /bin/sh
                - -c
                - |
                  pip install -q requests
                  python3 /scripts/chargeback_report.py
              env:
                - name: OPENCOST_URL
                  value: http://opencost.opencost.svc.cluster.local:9003
                - name: SLACK_WEBHOOK_URL
                  valueFrom:
                    secretKeyRef:
                      name: slack-webhooks
                      key: finops-channel
              volumeMounts:
                - name: scripts
                  mountPath: /scripts
          volumes:
            - name: scripts
              configMap:
                name: chargeback-scripts
```

## Right-Sizing with VPA Recommendations

The Vertical Pod Autoscaler in recommendation mode provides data-driven resource request suggestions without automatically applying changes:

```yaml
# vpa-recommendation-mode.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-service-vpa
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  updatePolicy:
    updateMode: "Off"   # Recommendation only - do not auto-apply
  resourcePolicy:
    containerPolicies:
      - containerName: payment-service
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 4
          memory: 8Gi
        controlledResources:
          - cpu
          - memory
```

Extract VPA recommendations programmatically:

```bash
kubectl get vpa -A -o json | jq -r '
  .items[] |
  {
    namespace: .metadata.namespace,
    name: .metadata.name,
    container: (.status.recommendation.containerRecommendations[]?.containerName // "N/A"),
    current_cpu_request: (.spec.resourcePolicy.containerPolicies[]?.minAllowed.cpu // "unknown"),
    recommended_cpu: (.status.recommendation.containerRecommendations[]?.target.cpu // "N/A"),
    recommended_memory: (.status.recommendation.containerRecommendations[]?.target.memory // "N/A"),
    lower_bound_cpu: (.status.recommendation.containerRecommendations[]?.lowerBound.cpu // "N/A"),
    upper_bound_cpu: (.status.recommendation.containerRecommendations[]?.upperBound.cpu // "N/A")
  } |
  [.namespace, .name, .container, .recommended_cpu, .recommended_memory] |
  @tsv
' | column -t
```

### Automated Right-Sizing Workflow

```python
#!/usr/bin/env python3
"""Apply VPA recommendations to Deployment resource requests."""

import subprocess
import json
import re


def get_vpa_recommendations(namespace: str) -> list:
    """Fetch VPA recommendations for all workloads in a namespace."""
    result = subprocess.run(
        ["kubectl", "get", "vpa", "-n", namespace, "-o", "json"],
        capture_output=True,
        text=True,
        check=True,
    )
    vpas = json.loads(result.stdout)

    recommendations = []
    for vpa in vpas["items"]:
        target_name = vpa["spec"]["targetRef"]["name"]
        target_kind = vpa["spec"]["targetRef"]["kind"]
        recs = vpa.get("status", {}).get("recommendation", {}).get("containerRecommendations", [])

        for rec in recs:
            recommendations.append({
                "namespace": namespace,
                "target_kind": target_kind,
                "target_name": target_name,
                "container": rec["containerName"],
                "target_cpu": rec["target"].get("cpu", ""),
                "target_memory": rec["target"].get("memory", ""),
                "lower_cpu": rec["lowerBound"].get("cpu", ""),
                "upper_cpu": rec["upperBound"].get("cpu", ""),
            })

    return recommendations


def calculate_savings(current_cpu: str, recommended_cpu: str, cpu_unit_cost: float = 0.048) -> float:
    """Estimate monthly CPU cost savings."""
    def parse_millicores(cpu_str: str) -> float:
        if cpu_str.endswith("m"):
            return float(cpu_str[:-1])
        return float(cpu_str) * 1000

    current_mc = parse_millicores(current_cpu)
    recommended_mc = parse_millicores(recommended_cpu)
    diff_cores = (current_mc - recommended_mc) / 1000

    # Approximate: $0.048/vCPU-hour * 24h * 30d
    return max(0, diff_cores * cpu_unit_cost * 24 * 30)


if __name__ == "__main__":
    namespaces = ["payments", "identity", "data-pipeline", "api-gateway"]
    total_savings = 0.0

    for ns in namespaces:
        try:
            recs = get_vpa_recommendations(ns)
            for rec in recs:
                print(
                    f"{rec['namespace']}/{rec['target_name']} [{rec['container']}]: "
                    f"CPU target={rec['target_cpu']}, Memory target={rec['target_memory']}"
                )
        except subprocess.CalledProcessError:
            pass

    print(f"\nEstimated monthly savings from right-sizing: ${total_savings:,.2f}")
```

## Spot Instance Strategy

### Node Group Architecture

Structure node groups to separate critical (on-demand) from interruptible (spot) workloads:

```yaml
# karpenter-spot-nodepool.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-general
spec:
  template:
    metadata:
      labels:
        instance-type: spot
        workload-tier: interruptible
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      taints:
        - key: "spot-instance"
          value: "true"
          effect: PreferNoSchedule
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["3"]
        - key: node.kubernetes.io/instance-type
          operator: NotIn
          values: ["t2.micro", "t2.small", "t2.medium"]
  limits:
    cpu: 1000
    memory: 4000Gi
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    budgets:
      - nodes: "20%"
```

```yaml
# karpenter-ondemand-nodepool.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: on-demand-critical
spec:
  template:
    metadata:
      labels:
        instance-type: on-demand
        workload-tier: critical
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["5"]
  limits:
    cpu: 200
    memory: 800Gi
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 300s
```

### Spot-Safe Workload Configuration

Workloads must handle interruption gracefully to run on spot:

```yaml
# spot-tolerant-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
  namespace: data-pipeline
spec:
  replicas: 5
  selector:
    matchLabels:
      app: batch-processor
  template:
    metadata:
      labels:
        app: batch-processor
        workload-tier: interruptible
    spec:
      tolerations:
        - key: "spot-instance"
          operator: "Equal"
          value: "true"
          effect: "PreferNoSchedule"
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: instance-type
                    operator: In
                    values: ["spot"]
      terminationGracePeriodSeconds: 120
      containers:
        - name: batch-processor
          image: registry.internal.example.com/data/batch-processor:1.0.0
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - |
                    # Checkpoint current work before termination
                    curl -X POST http://localhost:8080/checkpoint
                    sleep 30
```

## Savings Plans and Reserved Instances

Track commitment coverage with a custom metric:

```bash
# Query Kubecost for on-demand vs reserved/spot split
curl -G http://kubecost.kubecost.svc.cluster.local:9090/savings/requestSizingV2 \
  --data-urlencode "window=30d" \
  --data-urlencode "targetUtilization=0.65" | \
  jq '{
    monthly_savings: .monthlySavings,
    total_namespaces: (.namespaces | length),
    recommendations: [.namespaces[] |
      select(.monthlySavings > 100) |
      {namespace: .namespace, savings: .monthlySavings}
    ]
  }'
```

## Cost Anomaly Detection

Define anomaly thresholds with Prometheus alerting:

```yaml
# cost-anomaly-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cost-anomaly-alerts
  namespace: kubecost
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: cost-anomaly.rules
      rules:
        - alert: NamespaceCostSpike
          expr: |
            (
              sum by (namespace) (
                rate(container_cpu_usage_seconds_total{
                  container!="",
                  container!="POD"
                }[1h])
              ) * on(namespace) group_left()
              kube_namespace_labels
            )
            /
            (
              avg_over_time(
                sum by (namespace) (
                  rate(container_cpu_usage_seconds_total{
                    container!="",
                    container!="POD"
                  }[1h])
                )[7d:1h]
              )
            ) > 3
          for: 30m
          labels:
            severity: warning
            team: finops
          annotations:
            summary: "Namespace {{ $labels.namespace }} CPU usage 3x above 7-day average"
            description: "Possible runaway process or misconfigured autoscaler"

        - alert: UnexpectedGPUUsage
          expr: |
            sum by (namespace) (
              kube_pod_container_resource_requests{
                resource="nvidia.com/gpu"
              }
            ) > 0
            unless on(namespace)
            kube_namespace_labels{label_gpu_workload="true"}
          for: 5m
          labels:
            severity: critical
            team: finops
          annotations:
            summary: "Namespace {{ $labels.namespace }} using GPUs without gpu_workload=true label"

        - alert: IdleNodeCost
          expr: |
            sum by (node) (
              kube_node_status_allocatable{resource="cpu"}
            ) - sum by (node) (
              kube_pod_container_resource_requests{resource="cpu"}
            ) > 30
          for: 2h
          labels:
            severity: warning
            team: finops
          annotations:
            summary: "Node {{ $labels.node }} has >30 idle CPU cores for 2 hours"
```

## Namespace Budget Enforcement

Prevent runaway costs with namespace resource quotas tied to team budgets:

```python
#!/usr/bin/env python3
"""Sync team cost budgets to Kubernetes ResourceQuotas."""

import subprocess
import json
from dataclasses import dataclass
from typing import Dict


TEAM_MONTHLY_BUDGETS_USD: Dict[str, float] = {
    "payments": 5000.0,
    "identity": 2000.0,
    "data-pipeline": 8000.0,
    "api-gateway": 3000.0,
    "ml-platform": 15000.0,
}

# Approximate: $0.048/vCPU-hour -> 730h/month = $35/vCPU-month
CPU_COST_PER_CORE_MONTH = 35.0
# Approximate: $0.006/GiB-hour -> 730h/month = $4.38/GiB-month
MEMORY_COST_PER_GIB_MONTH = 4.38


def budget_to_resource_quota(budget_usd: float) -> dict:
    """Convert monthly budget to approximate ResourceQuota limits."""
    # Allocate 60% to CPU, 40% to memory
    cpu_budget = budget_usd * 0.6
    mem_budget = budget_usd * 0.4

    max_cpu_cores = int(cpu_budget / CPU_COST_PER_CORE_MONTH)
    max_memory_gib = int(mem_budget / MEMORY_COST_PER_GIB_MONTH)

    return {
        "requests.cpu": f"{max_cpu_cores}",
        "requests.memory": f"{max_memory_gib}Gi",
        "limits.cpu": f"{max_cpu_cores * 2}",
        "limits.memory": f"{max_memory_gib * 2}Gi",
    }


def apply_quota(namespace: str, quota: dict) -> None:
    """Apply ResourceQuota to namespace."""
    quota_manifest = {
        "apiVersion": "v1",
        "kind": "ResourceQuota",
        "metadata": {
            "name": "team-budget-quota",
            "namespace": namespace,
            "labels": {
                "managed-by": "finops-controller",
            },
        },
        "spec": {
            "hard": quota,
        },
    }

    kubectl_input = json.dumps(quota_manifest)
    subprocess.run(
        ["kubectl", "apply", "-f", "-"],
        input=kubectl_input.encode(),
        check=True,
    )
    print(f"Applied quota to namespace {namespace}: {quota}")


if __name__ == "__main__":
    for namespace, budget in TEAM_MONTHLY_BUDGETS_USD.items():
        quota = budget_to_resource_quota(budget)
        apply_quota(namespace, quota)
```

## Grafana Dashboard Configuration

Key FinOps panels for a cost visibility dashboard:

```promql
# Monthly spend rate by namespace (approximated from CPU + memory usage)
sum by (namespace) (
  rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[1h])
  * 0.048  # $/vCPU-hour
  * 730    # hours/month
)
+
sum by (namespace) (
  container_memory_working_set_bytes{container!="", container!="POD"}
  / 1073741824  # to GiB
  * 0.006       # $/GiB-hour
  * 730         # hours/month
)

# CPU waste: requested but unused
sum by (namespace) (
  kube_pod_container_resource_requests{resource="cpu"}
) -
sum by (namespace) (
  rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[1h])
)

# Memory waste: requested but unused
sum by (namespace) (
  kube_pod_container_resource_requests{resource="memory"}
) -
sum by (namespace) (
  container_memory_working_set_bytes{container!="", container!="POD"}
)
```

## Optimization Checklist

### Immediate Wins (Week 1)

- [ ] Label all workloads with `team`, `product`, `cost-center`, `environment`
- [ ] Identify top 5 namespaces by cost with no resource limits set
- [ ] Set resource requests on all containers (Kyverno policy enforcement)
- [ ] Delete stopped/idle workloads with zero replica counts

### Short-Term (Month 1)

- [ ] Deploy VPA in recommendation mode on all production namespaces
- [ ] Migrate batch and CI/CD workloads to spot/preemptible node groups
- [ ] Apply LimitRange to all namespaces to set default requests/limits
- [ ] Set up monthly chargeback report to team leads

### Strategic (Quarter 1)

- [ ] Commit to savings plans after 30 days of usage baseline data
- [ ] Implement Karpenter for bin-packing and node consolidation
- [ ] Establish cost-per-request SLIs for critical services
- [ ] Implement anomaly alerts with PagerDuty routing to FinOps team

## Summary

Kubernetes cost optimization is an iterative process driven by measurement first and action second. The foundation is consistent labeling, which enables every subsequent analysis. OpenCost or Kubecost provides the allocation layer. VPA recommendations quantify the right-sizing opportunity. Spot instances deliver 60-80% compute savings for interruptible workloads. Anomaly detection closes the governance loop.

The operational sequence:
1. Enforce cost allocation labels with Kyverno admission policies
2. Deploy OpenCost against your existing Prometheus stack
3. Export monthly chargeback reports to team leads via CronJob
4. Apply VPA recommendations in Off mode, review, then graduate to Auto
5. Migrate batch workloads to Karpenter spot NodePools
6. Alert on cost anomalies and idle GPU resources
7. Commit to savings plans after 60 days of stable baseline data
