---
title: "Kubernetes Capacity Planning: Resource Forecasting and Autoscaling Economics"
date: 2027-08-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Capacity Planning", "Resource Management", "Autoscaling", "FinOps"]
categories:
- Kubernetes
- FinOps
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes capacity planning covering resource utilization baselining, VPA recommendation analysis, cluster autoscaler node group sizing, bin packing efficiency, predictive scaling with KEDA, cost trade-off analysis, and resource forecast dashboards."
more_link: "yes"
url: "/kubernetes-capacity-planning-resource-forecasting-guide/"
---

Kubernetes capacity planning is the discipline of ensuring the right amount of compute, memory, and storage is available at the right time at the lowest acceptable cost. Under-provisioned clusters produce OOMKills and CPU throttling that destroy latency SLOs. Over-provisioned clusters consume budget that could fund product investment. This guide provides the analytical framework and technical tooling to continuously right-size Kubernetes workloads across the full lifecycle from resource request calibration to predictive scaling and FinOps reporting.

<!--more-->

# [Kubernetes Capacity Planning: Resource Forecasting and Autoscaling Economics](#kubernetes-capacity-planning-resource-forecasting-guide)

## Section 1: Resource Utilization Baselining

### Collecting Utilization Percentiles

Effective capacity planning begins with understanding the actual distribution of resource consumption, not just peaks or averages. Prometheus percentile recording rules over a 30-day window provide the statistical baseline needed for right-sizing decisions.

```yaml
# prometheus-rules/utilization-baseline.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: resource-utilization-baseline
  namespace: monitoring
spec:
  groups:
  - name: capacity.baseline
    interval: 5m
    rules:
    # Per-container CPU utilization percentiles
    - record: capacity:container_cpu_usage:p50
      expr: |
        histogram_quantile(0.50,
          sum by (namespace, pod, container, le) (
            rate(container_cpu_usage_seconds_total{
              container!="",
              container!="POD"
            }[5m])
          )
        )

    - record: capacity:container_cpu_usage:p95
      expr: |
        histogram_quantile(0.95,
          sum by (namespace, pod, container, le) (
            rate(container_cpu_usage_seconds_total{
              container!="",
              container!="POD"
            }[5m])
          )
        )

    - record: capacity:container_cpu_usage:p99
      expr: |
        histogram_quantile(0.99,
          sum by (namespace, pod, container, le) (
            rate(container_cpu_usage_seconds_total{
              container!="",
              container!="POD"
            }[5m])
          )
        )

    # CPU request utilization ratio
    - record: capacity:container_cpu_request_utilization:ratio
      expr: |
        sum by (namespace, container) (
          rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])
        )
        /
        sum by (namespace, container) (
          kube_pod_container_resource_requests{
            resource="cpu",
            container!="",
            container!="POD"
          }
        )

    # Memory working set vs request
    - record: capacity:container_memory_request_utilization:ratio
      expr: |
        sum by (namespace, container) (
          container_memory_working_set_bytes{container!="",container!="POD"}
        )
        /
        sum by (namespace, container) (
          kube_pod_container_resource_requests{
            resource="memory",
            container!="",
            container!="POD"
          }
        )

    # Memory utilization percentiles
    - record: capacity:container_memory_usage:p95
      expr: |
        quantile by (namespace, container) (0.95,
          container_memory_working_set_bytes{container!="",container!="POD"}
        )

    - record: capacity:container_memory_usage:p99
      expr: |
        quantile by (namespace, container) (0.99,
          container_memory_working_set_bytes{container!="",container!="POD"}
        )
```

### Identifying Over-Provisioned Workloads

```bash
#!/bin/bash
# right-sizing-report.sh
# Generates a report of over-provisioned containers using Prometheus API

PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus.monitoring.svc.cluster.local:9090}"
THRESHOLD="${1:-0.30}"  # Flag containers using <30% of request

echo "=== CPU Over-Provisioning Report ==="
echo "Containers using less than ${THRESHOLD} of their CPU request:"
curl -sG "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=
    avg by (namespace, container) (
      capacity:container_cpu_request_utilization:ratio
    ) < '"${THRESHOLD}"'
  ' | \
  jq -r '.data.result[] |
    .metric.namespace + "/" + .metric.container +
    " utilization=" + (.value[1] | tonumber | . * 100 | round | tostring) + "%"' | \
  sort

echo ""
echo "=== Memory Over-Provisioning Report ==="
curl -sG "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=
    avg by (namespace, container) (
      capacity:container_memory_request_utilization:ratio
    ) < '"${THRESHOLD}"'
  ' | \
  jq -r '.data.result[] |
    .metric.namespace + "/" + .metric.container +
    " utilization=" + (.value[1] | tonumber | . * 100 | round | tostring) + "%"' | \
  sort

echo ""
echo "=== Estimated Monthly Waste ==="
# Assumes $0.048/vCPU-hour and $0.006/GiB-hour on a representative instance type
curl -sG "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=
    sum(
      kube_pod_container_resource_requests{resource="cpu"}
      -
      avg_over_time(container_cpu_usage_seconds_total[30d:5m])
    ) * 0.048 * 730
  ' | jq '.data.result[0].value[1] + " USD/month CPU waste"'
```

---

## Section 2: VPA Recommendation History Analysis

The Vertical Pod Autoscaler (VPA) provides evidence-based resource recommendations derived from historical utilization. Analysis of VPA recommendations over time reveals right-sizing opportunities without the risk of live VPA updates in production.

### VPA in Recommendation-Only Mode

```yaml
# vpa/api-server-vpa.yaml
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
    updateMode: "Off"   # Recommendation only; do not auto-update pods
  resourcePolicy:
    containerPolicies:
    - containerName: api-server
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4000m
        memory: 8Gi
      controlledResources:
      - cpu
      - memory
      controlledValues: RequestsAndLimits
```

### Reading VPA Recommendations

```bash
#!/bin/bash
# vpa-recommendations.sh — Extract and compare VPA recommendations vs current requests

NS="${1:-production}"

echo "=== VPA Recommendations vs Current Requests ==="
kubectl get vpa -n "${NS}" -o json | \
  jq -r '.items[] |
    .metadata.name as $name |
    .status.recommendation.containerRecommendations[]? |
    {
      vpa: $name,
      container: .containerName,
      target_cpu: .target.cpu,
      target_mem: .target.memory,
      lower_bound_cpu: .lowerBound.cpu,
      lower_bound_mem: .lowerBound.memory,
      upper_bound_cpu: .upperBound.cpu,
      upper_bound_mem: .upperBound.memory
    }
  ' | python3 -c "
import json, sys
data = [json.loads(line) for line in sys.stdin if line.strip()]
print(f'{'VPA/Container':<40} {'Target CPU':<12} {'Target Mem':<12} {'Lower CPU':<12} {'Upper CPU':<12}')
print('-' * 90)
for r in data:
    print(f\"{r['vpa']}/{r['container']:<38} {r['target_cpu']:<12} {r['target_mem']:<12} {r['lower_bound_cpu']:<12} {r['upper_bound_cpu']:<12}\")
"
```

### Tracking VPA Recommendation Drift

```yaml
# prometheus-rules/vpa-drift.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vpa-recommendation-drift
  namespace: monitoring
spec:
  groups:
  - name: capacity.vpa
    interval: 30m
    rules:
    # Alert when current CPU request is >2x VPA recommendation (over-provisioned)
    - alert: ContainerCPUOverProvisioned
      expr: |
        kube_pod_container_resource_requests{resource="cpu"}
        /
        on (namespace, pod, container) group_left()
        label_replace(
          kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{
            resource="cpu"
          },
          "pod", "$1", "target_pod", "(.*)"
        )
        > 2
      for: 24h
      labels:
        severity: info
        action: right-size
      annotations:
        summary: "{{ $labels.namespace }}/{{ $labels.container }} CPU request is 2x VPA target"
        description: "Current request vs VPA target ratio: {{ $value | humanize }}"

    # Alert when memory request is <80% of VPA recommendation (under-provisioned)
    - alert: ContainerMemoryUnderProvisioned
      expr: |
        kube_pod_container_resource_requests{resource="memory"}
        /
        on (namespace, pod, container) group_left()
        label_replace(
          kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{
            resource="memory"
          },
          "pod", "$1", "target_pod", "(.*)"
        )
        < 0.8
      for: 1h
      labels:
        severity: warning
        action: right-size
      annotations:
        summary: "{{ $labels.namespace }}/{{ $labels.container }} memory is under VPA recommendation"
```

---

## Section 3: Cluster Autoscaler Node Group Sizing

### Cluster Autoscaler Configuration

```yaml
# cluster-autoscaler/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    spec:
      serviceAccountName: cluster-autoscaler
      containers:
      - name: cluster-autoscaler
        image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.30.0
        command:
        - ./cluster-autoscaler
        - --cloud-provider=aws
        - --namespace=kube-system
        - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/production-us-east-1
        # Scale-down settings
        - --scale-down-enabled=true
        - --scale-down-delay-after-add=10m
        - --scale-down-delay-after-delete=10m
        - --scale-down-delay-after-failure=3m
        - --scale-down-unneeded-time=10m
        - --scale-down-utilization-threshold=0.5
        # Scale-up settings
        - --max-node-provision-time=15m
        - --max-graceful-termination-sec=600
        # Bin packing
        - --expander=least-waste
        - --balance-similar-node-groups=true
        - --skip-nodes-with-local-storage=false
        # Safety
        - --max-total-unready-percentage=33
        - --max-bulk-soft-taint-count=0
        resources:
          requests:
            cpu: 100m
            memory: 300Mi
          limits:
            cpu: 100m
            memory: 300Mi
```

### Node Group Configuration for Mixed Instance Types

```yaml
# node-group/mixed-instance-nodegroup.yaml
# AWS EKS Node Group with mixed instance types for cost efficiency
# Terraform resource definition (representative)
nodeGroups:
- name: general-purpose
  desiredCapacity: 3
  minSize: 1
  maxSize: 20
  instanceTypes:
  - m6i.2xlarge    # 8 vCPU, 32 GiB — baseline
  - m6a.2xlarge    # 8 vCPU, 32 GiB — AMD (15% cheaper)
  - m5.2xlarge     # 8 vCPU, 32 GiB — previous gen fallback
  - m5a.2xlarge    # 8 vCPU, 32 GiB — AMD previous gen
  capacityType: SPOT   # 70% cost reduction vs On-Demand
  spotAllocationStrategy: capacity-optimized
  labels:
    node-group: general-purpose
    workload-type: stateless
  taints: []
  tags:
    k8s.io/cluster-autoscaler/enabled: "true"
    k8s.io/cluster-autoscaler/production-us-east-1: "owned"

- name: memory-optimized
  desiredCapacity: 0
  minSize: 0
  maxSize: 10
  instanceTypes:
  - r6i.2xlarge   # 8 vCPU, 64 GiB
  - r6a.2xlarge   # 8 vCPU, 64 GiB AMD
  - r5.2xlarge    # 8 vCPU, 64 GiB fallback
  capacityType: SPOT
  labels:
    node-group: memory-optimized
    workload-type: memory-intensive
  taints:
  - key: workload-type
    value: memory-intensive
    effect: NoSchedule

- name: compute-optimized-ondemand
  desiredCapacity: 2
  minSize: 2
  maxSize: 2
  instanceTypes:
  - c6i.2xlarge   # 8 vCPU, 16 GiB — for guaranteed capacity
  capacityType: ON_DEMAND
  labels:
    node-group: compute-ondemand
    on-demand: "true"
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
```

---

## Section 4: Resource Request Calibration Methodology

### Calibration Decision Framework

```
For each container:

1. Collect 30-day utilization data (Prometheus percentiles)
2. Identify workload type:
   - Batch/job: set request = p95, limit = p99 + 20%
   - Stateless API: set request = p50, limit = p99 + 50%
   - Stateful/DB: set request = p75, limit = hard_max
   - Background worker: set request = p50, limit = p99

3. Apply safety margin based on criticality:
   - SLO-critical: p99 + 25%
   - Non-critical: p75 + 10%

4. Memory: NEVER set limit < VPA upper bound (OOMKill risk)
5. CPU: limit/request ratio should not exceed 4x (throttling risk)
```

### Calibration Script

```python
#!/usr/bin/env python3
# calibrate-resources.py
# Queries Prometheus and generates right-sized resource recommendations

import requests
import json
import argparse
from datetime import datetime, timedelta

PROMETHEUS_URL = "http://prometheus.monitoring.svc.cluster.local:9090"

def query_prometheus(query: str) -> list:
    """Execute a Prometheus instant query."""
    response = requests.get(
        f"{PROMETHEUS_URL}/api/v1/query",
        params={"query": query},
        timeout=30
    )
    response.raise_for_status()
    return response.json()["data"]["result"]

def get_cpu_percentiles(namespace: str, container: str) -> dict:
    """Get CPU utilization percentiles over 30 days."""
    base_query = f'''
        quantile_over_time({{quantile}},
            rate(container_cpu_usage_seconds_total{{
                namespace="{namespace}",
                container="{container}"
            }}[5m])[30d:5m]
        )
    '''
    percentiles = {}
    for p in [0.5, 0.75, 0.95, 0.99]:
        results = query_prometheus(base_query.format(quantile=p))
        if results:
            percentiles[f"p{int(p*100)}"] = float(results[0]["value"][1])
    return percentiles

def get_memory_percentiles(namespace: str, container: str) -> dict:
    """Get memory working set percentiles over 30 days."""
    base_query = f'''
        quantile_over_time({{quantile}},
            container_memory_working_set_bytes{{
                namespace="{namespace}",
                container="{container}"
            }}[30d:5m]
        )
    '''
    percentiles = {}
    for p in [0.5, 0.75, 0.95, 0.99]:
        results = query_prometheus(base_query.format(quantile=p))
        if results:
            percentiles[f"p{int(p*100)}"] = float(results[0]["value"][1])
    return percentiles

def calculate_recommendation(workload_type: str, cpu: dict, mem: dict) -> dict:
    """Calculate resource recommendations based on workload type."""
    safety_margin = 1.25  # 25% safety buffer

    if workload_type == "stateless-api":
        cpu_request = cpu.get("p50", 0)
        cpu_limit = cpu.get("p99", 0) * 1.5
        mem_request = mem.get("p75", 0)
        mem_limit = mem.get("p99", 0) * safety_margin
    elif workload_type == "batch":
        cpu_request = cpu.get("p95", 0)
        cpu_limit = cpu.get("p99", 0) * 1.2
        mem_request = mem.get("p95", 0)
        mem_limit = mem.get("p99", 0) * 1.2
    elif workload_type == "background":
        cpu_request = cpu.get("p50", 0)
        cpu_limit = cpu.get("p99", 0)
        mem_request = mem.get("p50", 0)
        mem_limit = mem.get("p99", 0) * safety_margin
    else:
        # Conservative default
        cpu_request = cpu.get("p75", 0)
        cpu_limit = cpu.get("p99", 0) * 1.5
        mem_request = mem.get("p75", 0)
        mem_limit = mem.get("p99", 0) * safety_margin

    def fmt_cpu(cores: float) -> str:
        millis = int(cores * 1000)
        return f"{millis}m" if millis < 1000 else f"{cores:.1f}"

    def fmt_mem(bytes_val: float) -> str:
        mib = int(bytes_val / (1024 * 1024))
        return f"{mib}Mi" if mib < 1024 else f"{int(mib/1024)}Gi"

    return {
        "requests": {
            "cpu": fmt_cpu(cpu_request),
            "memory": fmt_mem(mem_request)
        },
        "limits": {
            "cpu": fmt_cpu(cpu_limit),
            "memory": fmt_mem(mem_limit)
        }
    }

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--workload-type", default="stateless-api",
                        choices=["stateless-api", "batch", "background"])
    args = parser.parse_args()

    print(f"Analyzing {args.namespace}/{args.container}...")
    cpu = get_cpu_percentiles(args.namespace, args.container)
    mem = get_memory_percentiles(args.namespace, args.container)

    print(f"\nCPU utilization (30d): {json.dumps(cpu, indent=2)}")
    print(f"Memory utilization (30d): {json.dumps(mem, indent=2)}")

    rec = calculate_recommendation(args.workload_type, cpu, mem)
    print(f"\nRecommended resources:")
    print(f"  resources:")
    print(f"    requests:")
    print(f"      cpu: {rec['requests']['cpu']}")
    print(f"      memory: {rec['requests']['memory']}")
    print(f"    limits:")
    print(f"      cpu: {rec['limits']['cpu']}")
    print(f"      memory: {rec['limits']['memory']}")

if __name__ == "__main__":
    main()
```

---

## Section 5: Bin Packing Efficiency Calculation

### Node Bin Packing Metrics

```yaml
# prometheus-rules/bin-packing.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: bin-packing-efficiency
  namespace: monitoring
spec:
  groups:
  - name: capacity.bin_packing
    interval: 5m
    rules:
    # CPU allocatable vs requested (packing efficiency)
    - record: capacity:node_cpu_packing_ratio
      expr: |
        sum by (node) (kube_pod_container_resource_requests{resource="cpu", node!=""})
        /
        sum by (node) (kube_node_status_allocatable{resource="cpu"})

    # Memory packing efficiency
    - record: capacity:node_memory_packing_ratio
      expr: |
        sum by (node) (kube_pod_container_resource_requests{resource="memory", node!=""})
        /
        sum by (node) (kube_node_status_allocatable{resource="memory"})

    # Cluster-level CPU packing efficiency
    - record: capacity:cluster_cpu_packing_ratio
      expr: |
        sum(kube_pod_container_resource_requests{resource="cpu"})
        /
        sum(kube_node_status_allocatable{resource="cpu"})

    # Waste metric: allocatable - requested (idle capacity cost)
    - record: capacity:cluster_cpu_waste_cores
      expr: |
        sum(kube_node_status_allocatable{resource="cpu"})
        -
        sum(kube_pod_container_resource_requests{resource="cpu"})

    # Alert: low packing efficiency (nodes mostly empty — wasted money)
    - alert: LowBinPackingEfficiency
      expr: capacity:cluster_cpu_packing_ratio < 0.40
      for: 30m
      labels:
        severity: warning
        action: scale-down-or-consolidate
      annotations:
        summary: "Cluster CPU bin packing below 40% — excess node capacity"
        description: |
          Current cluster CPU packing ratio: {{ $value | humanizePercentage }}.
          Consider reducing node group minimum sizes or consolidating workloads.
```

### Bin Packing Analysis Script

```bash
#!/bin/bash
# bin-packing-report.sh

echo "=== Node Bin Packing Efficiency ==="
printf "%-30s %-15s %-15s %-15s %-15s\n" \
  "NODE" "CPU_REQ" "CPU_ALLOC" "MEM_REQ" "MEM_ALLOC"
printf "%-30s %-15s %-15s %-15s %-15s\n" \
  "----" "-------" "---------" "-------" "---------"

kubectl get nodes -o json | jq -r '.items[].metadata.name' | while read NODE; do
  CPU_ALLOC=$(kubectl get node "${NODE}" \
    -o jsonpath='{.status.allocatable.cpu}')
  MEM_ALLOC=$(kubectl get node "${NODE}" \
    -o jsonpath='{.status.allocatable.memory}')
  CPU_REQ=$(kubectl describe node "${NODE}" | \
    grep -A 4 "Allocated resources:" | \
    grep cpu | awk '{print $2}')
  MEM_REQ=$(kubectl describe node "${NODE}" | \
    grep -A 4 "Allocated resources:" | \
    grep memory | awk '{print $2}')
  printf "%-30s %-15s %-15s %-15s %-15s\n" \
    "${NODE}" "${CPU_REQ:-0}" "${CPU_ALLOC}" "${MEM_REQ:-0}" "${MEM_ALLOC}"
done

echo ""
echo "=== Underutilized Nodes (candidates for scale-down) ==="
kubectl describe nodes | grep -E "^Name:|cpu.*%" | \
  paste - - | \
  awk '{if ($NF+0 < 30) print $0}'
```

---

## Section 6: Predictive Scaling with KEDA and Prometheus

### KEDA Installation

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --set metricsServer.replicaCount=2 \
  --set operator.replicaCount=2 \
  --version 2.14.0
```

### KEDA ScaledObject with Prometheus Custom Metrics

```yaml
# keda/api-server-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 50
  cooldownPeriod: 60
  pollingInterval: 15

  # Multiple scaling triggers — scales on the highest demand signal
  triggers:
  # Scale on request rate (primary signal)
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      metricName: api_request_rate
      query: |
        sum(rate(http_requests_total{job="api-server"}[2m]))
      threshold: "100"    # 100 RPS per replica target
      activationThreshold: "10"

  # Scale on queue depth (prevents request piling)
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      metricName: api_request_queue_depth
      query: |
        sum(http_requests_queue_depth{job="api-server"})
      threshold: "50"

  # CPU-based fallback
  - type: cpu
    metricType: Utilization
    metadata:
      value: "70"
---
# KEDA scheduled scaling for predictable traffic patterns
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-scheduled-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 50
  triggers:
  # Pre-scale before business hours (UTC)
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 8 * * 1-5"    # 08:00 ET Mon-Fri
      end: "0 20 * * 1-5"     # 20:00 ET Mon-Fri
      desiredReplicas: "10"
  # Weekend minimum
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 0 * * 6-7"
      end: "59 23 * * 6-7"
      desiredReplicas: "3"
```

---

## Section 7: Cost-vs-Availability Trade-offs

### Spot Instance Strategy

```yaml
# topology/spot-with-ondemand-fallback.yaml
# Mix 80% Spot with 20% On-Demand for cost + reliability balance
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 10
  template:
    spec:
      # Spread across availability zones
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-server

      # Allow both spot and on-demand nodes
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          # Prefer spot nodes (cheaper)
          - weight: 80
            preference:
              matchExpressions:
              - key: eks.amazonaws.com/capacityType
                operator: In
                values: ["SPOT"]
          # Fall back to on-demand
          - weight: 20
            preference:
              matchExpressions:
              - key: eks.amazonaws.com/capacityType
                operator: In
                values: ["ON_DEMAND"]

      # Handle spot interruption gracefully
      terminationGracePeriodSeconds: 120
```

### PodDisruptionBudget for Spot Resilience

```yaml
# pdb/api-server-pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  # Always keep 70% of replicas available during disruptions
  minAvailable: "70%"
```

### Cost Calculation Prometheus Metrics

```yaml
# prometheus-rules/cost-metrics.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cost-allocation
  namespace: monitoring
spec:
  groups:
  - name: cost.allocation
    interval: 15m
    rules:
    # CPU cost per namespace (assumes $0.048/vCPU-hour)
    - record: cost:namespace_cpu_hourly_usd
      expr: |
        sum by (namespace) (
          kube_pod_container_resource_requests{resource="cpu"}
        ) * 0.048

    # Memory cost per namespace (assumes $0.006/GiB-hour)
    - record: cost:namespace_memory_hourly_usd
      expr: |
        sum by (namespace) (
          kube_pod_container_resource_requests{resource="memory"}
        ) / (1024^3) * 0.006

    # Total hourly cost per namespace
    - record: cost:namespace_total_hourly_usd
      expr: |
        cost:namespace_cpu_hourly_usd
        +
        cost:namespace_memory_hourly_usd

    # Monthly cost forecast per namespace
    - record: cost:namespace_monthly_forecast_usd
      expr: |
        cost:namespace_total_hourly_usd * 730
```

---

## Section 8: Capacity Reservation Strategies

### Node Pool Reservation for Guaranteed Capacity

```yaml
# node-reservation/priority-class.yaml
# High-priority class for critical workloads with capacity reservation
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: cluster-critical
value: 2000000000
globalDefault: false
description: "Critical cluster infrastructure — always scheduled"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-critical
value: 1000000000
globalDefault: false
description: "Production SLO-critical workloads"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-standard
value: 100
globalDefault: true
description: "Standard production workloads"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-low
value: 10
preemptionPolicy: Never
globalDefault: false
description: "Low priority batch workloads — may be evicted for higher priority"
```

### Capacity Reservation Placeholder Pods

```yaml
# capacity-reservation/placeholder-deployment.yaml
# Placeholder pods hold capacity on on-demand nodes
# They are preempted when real workloads need the capacity
apiVersion: apps/v1
kind: Deployment
metadata:
  name: capacity-placeholder
  namespace: kube-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: capacity-placeholder
  template:
    metadata:
      labels:
        app: capacity-placeholder
    spec:
      priorityClassName: batch-low   # Easily preempted
      nodeSelector:
        eks.amazonaws.com/capacityType: ON_DEMAND
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
        resources:
          requests:
            cpu: 1500m
            memory: 3Gi
          limits:
            cpu: 1500m
            memory: 3Gi
      terminationGracePeriodSeconds: 0
```

---

## Section 9: Resource Forecast Dashboards

### Grafana Dashboard JSON (Key Panels)

```json
{
  "title": "Kubernetes Capacity Planning",
  "uid": "k8s-capacity",
  "refresh": "5m",
  "panels": [
    {
      "title": "Cluster CPU Packing Efficiency",
      "type": "gauge",
      "gridPos": {"h": 8, "w": 6, "x": 0, "y": 0},
      "targets": [
        {
          "expr": "capacity:cluster_cpu_packing_ratio * 100",
          "legendFormat": "CPU Packing %"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "min": 0,
          "max": 100,
          "thresholds": {
            "steps": [
              {"value": 0,  "color": "red"},
              {"value": 40, "color": "yellow"},
              {"value": 70, "color": "green"},
              {"value": 90, "color": "orange"}
            ]
          }
        }
      }
    },
    {
      "title": "Namespace Monthly Cost Forecast",
      "type": "bargauge",
      "gridPos": {"h": 8, "w": 12, "x": 6, "y": 0},
      "targets": [
        {
          "expr": "topk(10, cost:namespace_monthly_forecast_usd)",
          "legendFormat": "{{ namespace }}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "currencyUSD"
        }
      }
    },
    {
      "title": "Over-Provisioned Containers",
      "type": "table",
      "gridPos": {"h": 10, "w": 24, "x": 0, "y": 8},
      "targets": [
        {
          "expr": "topk(20, avg by (namespace, container) (capacity:container_cpu_request_utilization:ratio) < 0.3)",
          "legendFormat": "{{ namespace }}/{{ container }}"
        }
      ]
    },
    {
      "title": "7-Day CPU Utilization Trend",
      "type": "timeseries",
      "gridPos": {"h": 8, "w": 24, "x": 0, "y": 18},
      "targets": [
        {
          "expr": "sum(rate(container_cpu_usage_seconds_total{namespace=\"production\"}[5m]))",
          "legendFormat": "Actual CPU Usage"
        },
        {
          "expr": "sum(kube_pod_container_resource_requests{namespace=\"production\", resource=\"cpu\"})",
          "legendFormat": "CPU Requested"
        },
        {
          "expr": "sum(kube_node_status_allocatable{resource=\"cpu\"}) - sum(kube_pod_container_resource_requests{resource=\"cpu\"})",
          "legendFormat": "Available Headroom"
        }
      ]
    }
  ]
}
```

---

## Section 10: Workload Profiling and Capacity Reports

### Monthly Capacity Report Generator

```bash
#!/bin/bash
# monthly-capacity-report.sh
# Generates a Markdown capacity report for the last 30 days

PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus.monitoring.svc.cluster.local:9090}"
DATE=$(date +%Y-%m)
REPORT_FILE="capacity-report-${DATE}.md"

query() {
    curl -sG "${PROMETHEUS_URL}/api/v1/query" \
        --data-urlencode "query=${1}" | \
        jq -r '.data.result[0].value[1] // "N/A"'
}

cat > "${REPORT_FILE}" << REPORT
# Kubernetes Capacity Report: ${DATE}

## Cluster Overview

| Metric | Value |
|---|---|
| Total Nodes | $(kubectl get nodes --no-headers | wc -l) |
| Total Namespaces | $(kubectl get namespaces --no-headers | wc -l) |
| Total Pods | $(kubectl get pods --all-namespaces --no-headers | wc -l) |
| Cluster CPU Packing | $(query 'capacity:cluster_cpu_packing_ratio * 100 | round')% |
| CPU Waste (cores) | $(query 'capacity:cluster_cpu_waste_cores | round') cores |

## Cost Summary

| Namespace | Monthly Forecast (USD) |
|---|---|
$(curl -sG "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=topk(10, cost:namespace_monthly_forecast_usd)' | \
  jq -r '.data.result[] |
    "| " + .metric.namespace + " | $" + (.value[1] | tonumber | . * 100 | round / 100 | tostring) + " |"')

## Right-Sizing Recommendations

The following containers have CPU utilization below 30% of their request
(candidates for request reduction):

$(curl -sG "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=avg by (namespace,container)(capacity:container_cpu_request_utilization:ratio) < 0.3' | \
  jq -r '.data.result[] |
    "- " + .metric.namespace + "/" + .metric.container +
    ": " + (.value[1] | tonumber | . * 100 | round | tostring) + "% utilized"')

## Action Items for Next Month

- [ ] Apply VPA recommendations to flagged deployments
- [ ] Review spot instance interruption rates
- [ ] Validate cluster autoscaler scale-down events
- [ ] Update resource requests for calibrated containers
REPORT

echo "Report written to: ${REPORT_FILE}"
```

---

## Summary

Effective Kubernetes capacity planning requires continuous measurement, data-driven right-sizing, and automated scaling mechanisms that adapt to changing demand. The foundation is Prometheus-based utilization baselining that captures percentile distributions rather than point-in-time averages. VPA in recommendation-only mode provides evidence-based guidance for resource request calibration without the instability risk of live pod updates. Cluster autoscaler configuration with mixed instance type node groups and spot-on-demand blending achieves cost efficiency while maintaining availability. KEDA with custom Prometheus metrics and scheduled scaling triggers handles both reactive and predictive scaling scenarios. Monthly capacity reports close the loop by translating Prometheus data into actionable FinOps insights for engineering and finance stakeholders.
