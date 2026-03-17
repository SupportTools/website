---
title: "Kubernetes Capacity Planning: Resource Modeling for Production Clusters"
date: 2028-01-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Capacity Planning", "VPA", "Cluster Autoscaler", "Resource Management", "k6"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes capacity planning covering request/limit ratio analysis, node pool sizing, bin-packing efficiency, overcommit strategies, VPA recommendations, cluster autoscaler tuning, load testing with k6, and headroom calculations."
more_link: "yes"
url: "/kubernetes-capacity-planning-guide/"
---

Kubernetes capacity planning is an analytical discipline that bridges application performance requirements and infrastructure cost. Under-provisioned clusters suffer from resource contention, evictions, and unreliable scheduling. Over-provisioned clusters waste budget. The goal is a cluster with sufficient headroom for burst, high bin-packing efficiency for cost, and automated scaling that responds before user-facing impact occurs.

This guide covers the quantitative approach to capacity planning: auditing existing request/limit ratios, sizing node pools using bin-packing models, implementing safe overcommit strategies, using VPA recommendations as capacity signals, tuning cluster autoscaler targets, conducting load testing with k6, and calculating headroom that accounts for node failures and maintenance windows.

<!--more-->

# Kubernetes Capacity Planning: Resource Modeling for Production Clusters

## Section 1: Auditing Current Resource Utilization

Before planning capacity, establish a baseline of current usage and request accuracy.

### Request vs. Actual Usage Analysis

```bash
#!/usr/bin/env bash
# resource-audit.sh — audit request/limit ratios and actual usage

echo "=== Namespace Resource Summary ==="
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.status.phase == "Running") |
  .metadata.namespace as $ns |
  .spec.containers[] |
  {
    namespace: $ns,
    pod: .name,
    cpu_request: (.resources.requests.cpu // "0"),
    mem_request: (.resources.requests.memory // "0"),
    cpu_limit: (.resources.limits.cpu // "none"),
    mem_limit: (.resources.limits.memory // "none")
  }
' | jq -s 'group_by(.namespace)[] | {
  namespace: .[0].namespace,
  pod_count: length
}'

# Identify pods with no resource requests (scheduling risk)
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.status.phase == "Running") |
  select(
    .spec.containers[].resources.requests == null or
    .spec.containers[].resources.requests.cpu == null
  ) |
  [.metadata.namespace, .metadata.name] | @tsv
' | sort

# Check nodes for actual vs requested allocation
kubectl describe nodes | grep -A 8 "Allocated resources:"

# More precise: use kubectl top
kubectl top nodes --sort-by cpu
kubectl top pods -A --sort-by cpu | head -30
kubectl top pods -A --sort-by memory | head -30
```

### Request Accuracy Ratio

The request accuracy ratio measures how well requests reflect actual usage:

```bash
#!/usr/bin/env bash
# request-accuracy.sh — compare requests vs actual for all deployments

# Requires metrics-server
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
  for deploy in $(kubectl get deployments -n $ns -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    # Get pod for this deployment
    POD=$(kubectl get pods -n $ns -l "app=${deploy}" \
      --field-selector status.phase=Running \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    [ -z "$POD" ] && continue

    # Get requested CPU and memory
    CPU_REQUEST=$(kubectl get pod $POD -n $ns \
      -o jsonpath='{.spec.containers[0].resources.requests.cpu}' 2>/dev/null)
    MEM_REQUEST=$(kubectl get pod $POD -n $ns \
      -o jsonpath='{.spec.containers[0].resources.requests.memory}' 2>/dev/null)

    # Get actual usage
    ACTUAL=$(kubectl top pod $POD -n $ns --no-headers 2>/dev/null)
    CPU_ACTUAL=$(echo $ACTUAL | awk '{print $2}')
    MEM_ACTUAL=$(echo $ACTUAL | awk '{print $3}')

    echo "$ns/$deploy: requested CPU=${CPU_REQUEST} actual=${CPU_ACTUAL}, requested MEM=${MEM_REQUEST} actual=${MEM_ACTUAL}"
  done
done
```

### Prometheus-Based Utilization Queries

```yaml
# prometheus-capacity-queries.yaml
# These queries provide accurate cluster-wide capacity metrics

# CPU Request/Actual Ratio (cluster-wide)
# Query: sum(kube_pod_container_resource_requests{resource="cpu"}) /
#        sum(rate(container_cpu_usage_seconds_total[5m]))
# If > 3.0, requests are significantly over-stated → reduce requests

# Memory Request/Actual Ratio
# sum(kube_pod_container_resource_requests{resource="memory"}) /
# sum(container_memory_working_set_bytes{container!=""})
# If > 2.0, memory is over-requested

# Node CPU Utilization (actual vs allocatable)
# sum by (node) (rate(container_cpu_usage_seconds_total[5m])) /
# sum by (node) (kube_node_status_allocatable{resource="cpu"})

# Node Memory Utilization
# sum by (node) (container_memory_working_set_bytes{container!=""}) /
# sum by (node) (kube_node_status_allocatable{resource="memory"})

# Per-namespace CPU request pressure (requests vs allocatable)
# sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"}) /
# sum(kube_node_status_allocatable{resource="cpu"})
```

## Section 2: Node Pool Sizing Models

### Bin-Packing Efficiency Calculation

Bin-packing efficiency measures how well pods fill node capacity. Poor bin-packing wastes 20-40% of cluster capacity.

```python
#!/usr/bin/env python3
# bin_packing_analysis.py — model bin-packing efficiency for different node sizes

from typing import List, Tuple
import math

# Workload profile (from kubectl resource audit)
WORKLOAD_PODS = [
    # (cpu_request_cores, memory_request_gib, count)
    (0.1,  0.25, 50),   # Microservices (small)
    (0.5,  1.0,  30),   # Microservices (medium)
    (1.0,  2.0,  20),   # API servers
    (2.0,  4.0,  10),   # Database sidecars
    (4.0,  8.0,   5),   # Background workers
    (8.0, 16.0,   3),   # Data processors
]

# Node types to evaluate
NODE_TYPES = [
    # (name, cpu_cores, memory_gib, cost_per_hour)
    ("m6i.2xlarge",  8,   32,  0.384),
    ("m6i.4xlarge",  16,  64,  0.768),
    ("m6i.8xlarge",  32,  128, 1.536),
    ("m6i.16xlarge", 64,  256, 3.072),
    ("m6i.32xlarge", 128, 512, 6.144),
]

# System overhead (reserved for kubelet, OS, monitoring)
SYSTEM_CPU_RESERVATION = 0.1    # 10% of node CPU
SYSTEM_MEM_RESERVATION = 0.1    # 10% of node memory
DAEMONSET_CPU_PER_NODE = 0.3    # CPU for DaemonSet pods
DAEMONSET_MEM_PER_NODE_GIB = 1.0  # Memory for DaemonSet pods

def calculate_allocatable(node_cpu: float, node_mem: float) -> Tuple[float, float]:
    """Calculate allocatable CPU and memory after reservations."""
    alloc_cpu = node_cpu * (1 - SYSTEM_CPU_RESERVATION) - DAEMONSET_CPU_PER_NODE
    alloc_mem = node_mem * (1 - SYSTEM_MEM_RESERVATION) - DAEMONSET_MEM_PER_NODE_GIB
    return alloc_cpu, alloc_mem

def simulate_packing(node_cpu: float, node_mem: float) -> Tuple[int, float, float]:
    """Simulate greedy bin-packing of workload pods onto nodes."""
    alloc_cpu, alloc_mem = calculate_allocatable(node_cpu, node_mem)

    # Sort pods descending by resource intensity
    all_pods = []
    for cpu, mem, count in WORKLOAD_PODS:
        for _ in range(count):
            all_pods.append((cpu, mem))
    all_pods.sort(key=lambda x: max(x[0]/alloc_cpu, x[1]/alloc_mem), reverse=True)

    nodes = []
    for pod_cpu, pod_mem in all_pods:
        placed = False
        for node in nodes:
            if node['cpu'] + pod_cpu <= alloc_cpu and node['mem'] + pod_mem <= alloc_mem:
                node['cpu'] += pod_cpu
                node['mem'] += pod_mem
                placed = True
                break
        if not placed:
            nodes.append({'cpu': pod_cpu, 'mem': pod_mem})

    # Calculate efficiency
    total_pods = len(all_pods)
    total_nodes = len(nodes)
    total_cpu_used = sum(n['cpu'] for n in nodes)
    total_mem_used = sum(n['mem'] for n in nodes)
    total_cpu_capacity = total_nodes * alloc_cpu
    total_mem_capacity = total_nodes * alloc_mem
    cpu_efficiency = total_cpu_used / total_cpu_capacity if total_cpu_capacity > 0 else 0
    mem_efficiency = total_mem_used / total_mem_capacity if total_mem_capacity > 0 else 0

    return total_nodes, cpu_efficiency, mem_efficiency

print(f"{'Node Type':<20} {'Nodes':>6} {'CPU Eff%':>10} {'Mem Eff%':>10} {'$/hr Total':>12} {'$/pod/hr':>10}")
print("-" * 75)
for name, cpu, mem, cost in NODE_TYPES:
    nodes, cpu_eff, mem_eff = simulate_packing(cpu, mem)
    total_cost = nodes * cost
    total_pods = sum(c for _, _, c in WORKLOAD_PODS)
    cost_per_pod = total_cost / total_pods
    print(f"{name:<20} {nodes:>6} {cpu_eff*100:>9.1f}% {mem_eff*100:>9.1f}% {total_cost:>11.2f} {cost_per_pod:>9.4f}")
```

### Node Pool Sizing Rules

```bash
# Rule of thumb calculations for node pool sizing

# Total pod resource requirements
TOTAL_CPU_CORES=85.0   # Sum of all pod CPU requests
TOTAL_MEM_GIB=170.0    # Sum of all pod memory requests

# Target utilization (leave headroom for spikes and maintenance)
TARGET_CPU_UTIL=0.60   # 60% target CPU utilization
TARGET_MEM_UTIL=0.70   # 70% target memory utilization

# Headroom for node failures (N+2 for 3 control planes, N+1 for workers)
NODE_FAILURE_HEADROOM=1

# Node size (m6i.4xlarge: 16 CPU, 64 GiB)
NODE_CPU_ALLOC=14.5    # After system reservation
NODE_MEM_ALLOC=57.0    # After system reservation

# Required nodes based on CPU
CPU_NODES=$(echo "scale=0; $TOTAL_CPU_CORES / ($NODE_CPU_ALLOC * $TARGET_CPU_UTIL) + 1" | bc)
# Required nodes based on memory
MEM_NODES=$(echo "scale=0; $TOTAL_MEM_GIB / ($NODE_MEM_ALLOC * $TARGET_MEM_UTIL) + 1" | bc)

echo "CPU-constrained: $CPU_NODES nodes"
echo "Memory-constrained: $MEM_NODES nodes"
echo "Recommended min (larger + headroom): $((${MEM_NODES} > ${CPU_NODES} ? ${MEM_NODES} : ${CPU_NODES}) + ${NODE_FAILURE_HEADROOM}) nodes"
```

## Section 3: Overcommit Strategies

### CPU Overcommit

CPU is compressible — pods can temporarily use less than requested without being killed, and can burst beyond requests up to their limit. Safe CPU overcommit ratios:

```yaml
# LimitRange for CPU overcommit enforcement
apiVersion: v1
kind: LimitRange
metadata:
  name: cpu-overcommit-policy
  namespace: production
spec:
  limits:
    - type: Container
      # Default request/limit if not specified
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      # Maximum ratio: limit can be 4x the request (overcommit factor)
      # Comment out if you want to allow unlimited limits
      max:
        cpu: "4000m"
        memory: "8Gi"
      # Minimum values
      min:
        cpu: "10m"
        memory: "32Mi"
```

```bash
# Calculate cluster CPU overcommit ratio
TOTAL_CPU_REQUESTS=$(kubectl get pods -A -o json | \
  jq '[.items[].spec.containers[].resources.requests.cpu // "0"] |
  map(if endswith("m") then (.[:-1] | tonumber / 1000) else tonumber end) |
  add')

TOTAL_CPU_LIMITS=$(kubectl get pods -A -o json | \
  jq '[.items[].spec.containers[].resources.limits.cpu // "0"] |
  map(if endswith("m") then (.[:-1] | tonumber / 1000) else tonumber end) |
  add')

TOTAL_ALLOCATABLE=$(kubectl get nodes -o json | \
  jq '[.items[].status.allocatable.cpu] |
  map(if endswith("m") then (.[:-1] | tonumber / 1000) else tonumber end) |
  add')

echo "Total CPU Requests: ${TOTAL_CPU_REQUESTS} cores"
echo "Total CPU Limits:   ${TOTAL_CPU_LIMITS} cores"
echo "Total Allocatable:  ${TOTAL_ALLOCATABLE} cores"
echo "Request Overcommit: $(echo "scale=2; $TOTAL_CPU_REQUESTS / $TOTAL_ALLOCATABLE" | bc)x"
echo "Limit Overcommit:   $(echo "scale=2; $TOTAL_CPU_LIMITS / $TOTAL_ALLOCATABLE" | bc)x"
```

### Memory Overcommit — Why It Differs from CPU

Memory is incompressible. A pod attempting to use more memory than available on its node will trigger the OOM killer. Memory overcommit must be approached with extreme caution:

```bash
# Check QoS class distribution (affects eviction order)
kubectl get pods -A -o json | \
  jq -r '.items[] |
  [.metadata.namespace, .metadata.name,
   (.status.qosClass // "Unknown")] |
  @tsv' | \
  sort -k3 | \
  awk '{count[$3]++} END {for (qos in count) print count[qos], qos}' | \
  sort -rn

# QoS Classes (eviction priority from lowest to highest):
# BestEffort: no requests or limits set — evicted first
# Burstable:  requests != limits, or only some containers have requests
# Guaranteed: requests == limits for all containers — evicted last

# Find BestEffort pods (at risk of eviction during memory pressure)
kubectl get pods -A -o json | \
  jq -r '.items[] |
  select(.status.qosClass == "BestEffort") |
  [.metadata.namespace, .metadata.name] |
  @tsv'
```

## Section 4: VPA Recommendations as Capacity Signals

The Vertical Pod Autoscaler (VPA) analyzes historical resource usage and recommends optimal request values. Even in recommendation-only mode (no automatic resizing), VPA provides actionable capacity intelligence.

### Deploy VPA in Recommendation Mode

```yaml
# vpa-recommendation-only.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  updatePolicy:
    updateMode: "Off"  # Recommendation only — no automatic changes
  resourcePolicy:
    containerPolicies:
      - containerName: payment-service
        minAllowed:
          cpu: 50m
          memory: 64Mi
        maxAllowed:
          cpu: 4000m
          memory: 8Gi
        controlledResources:
          - cpu
          - memory
```

### Reading VPA Recommendations

```bash
#!/usr/bin/env bash
# read-vpa-recommendations.sh — extract recommendations for capacity review

echo "=== VPA Recommendations ==="
echo ""
kubectl get vpa -A -o json | jq -r '
  .items[] |
  {
    namespace: .metadata.namespace,
    name: .metadata.name,
    target: .spec.targetRef.name,
    recommendations: (
      .status.recommendation.containerRecommendations[]? |
      {
        container: .containerName,
        lower: {
          cpu: .lowerBound.cpu,
          memory: .lowerBound.memory
        },
        target: {
          cpu: .target.cpu,
          memory: .target.memory
        },
        upper: {
          cpu: .upperBound.cpu,
          memory: .upperBound.memory
        },
        uncapped_target: {
          cpu: .uncappedTarget.cpu,
          memory: .uncappedTarget.memory
        }
      }
    )
  }
' | jq .

# Summary: compare current requests vs VPA target
echo ""
echo "=== Requests vs VPA Target Comparison ==="
for ns in $(kubectl get vpa -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}' | sort -u); do
  for vpa_name in $(kubectl get vpa -n $ns -o jsonpath='{.items[*].metadata.name}'); do
    TARGET_NAME=$(kubectl get vpa $vpa_name -n $ns -o jsonpath='{.spec.targetRef.name}')

    CURRENT_CPU=$(kubectl get deployment $TARGET_NAME -n $ns \
      -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}' 2>/dev/null || echo "N/A")
    CURRENT_MEM=$(kubectl get deployment $TARGET_NAME -n $ns \
      -o jsonpath='{.spec.template.spec.containers[0].resources.requests.memory}' 2>/dev/null || echo "N/A")

    VPA_CPU=$(kubectl get vpa $vpa_name -n $ns \
      -o jsonpath='{.status.recommendation.containerRecommendations[0].target.cpu}' 2>/dev/null || echo "N/A")
    VPA_MEM=$(kubectl get vpa $vpa_name -n $ns \
      -o jsonpath='{.status.recommendation.containerRecommendations[0].target.memory}' 2>/dev/null || echo "N/A")

    echo "$ns/$TARGET_NAME: CPU current=$CURRENT_CPU recommended=$VPA_CPU | MEM current=$CURRENT_MEM recommended=$VPA_MEM"
  done
done
```

## Section 5: Cluster Autoscaler Tuning

### Autoscaler Configuration for Utilization Targets

```yaml
# cluster-autoscaler-config.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.3
          command:
            - ./cluster-autoscaler
            - --v=4
            - --stderrthreshold=info
            - --cloud-provider=aws
            - --skip-nodes-with-local-storage=false
            - --expander=least-waste   # Chooses node group that wastes least CPU/memory
            # Scale up when pending pods can't be scheduled
            - --scale-down-enabled=true
            # Target utilization — don't scale down if node is above this threshold
            - --scale-down-utilization-threshold=0.50
            # GPU nodes should have higher threshold (GPU idle != waste if scheduling)
            - --scale-down-gpu-utilization-threshold=0.30
            # Wait after scale-up before considering scale-down
            - --scale-down-delay-after-add=10m
            # Wait after last scale-down before next scale-down
            - --scale-down-delay-after-delete=0s
            - --scale-down-delay-after-failure=3m
            # How long a node must be underutilized before scale-down
            - --scale-down-unneeded-time=5m
            # Maximum time to wait for pods to be rescheduled
            - --max-graceful-termination-sec=600
            # Skip nodes with system pods (prevents removing kube-system pods)
            - --skip-nodes-with-system-pods=false
            # Expander: balance, random, most-pods, least-waste, priority
            - --expander=least-waste
            # Scan interval
            - --scan-interval=10s
            # Maximum cluster size (hard limit)
            - --max-nodes-total=200
            # Max empty bulk delete
            - --max-empty-bulk-delete=10
            # Headroom: balance, random, most-pods, least-waste, priority
            - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/production-cluster
```

### Autoscaler Priority Expander Configuration

```yaml
# autoscaler-priority-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |-
    10:
      # Prefer on-demand nodes for production workloads
      - .*-on-demand.*
    20:
      # Use reserved instances if available
      - .*-reserved.*
    30:
      # Fall back to spot instances for burst capacity
      - .*-spot.*
```

## Section 6: Load Testing with k6

### k6 Load Test for Capacity Validation

```javascript
// k6-load-test.js — validate cluster under target load

import http from 'k6/http';
import { sleep, check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const errorRate = new Rate('errors');
const latencyP99 = new Trend('latency_p99');
const requestCount = new Counter('requests_total');

export const options = {
  stages: [
    // Ramp up to 20% of target load — verify baseline
    { duration: '2m', target: 100 },
    // Hold 20% — establish baseline metrics
    { duration: '5m', target: 100 },
    // Ramp to 50% — test at half capacity
    { duration: '3m', target: 250 },
    { duration: '10m', target: 250 },
    // Ramp to 100% — target production load
    { duration: '5m', target: 500 },
    { duration: '15m', target: 500 },
    // Spike test — 150% of target (capacity headroom test)
    { duration: '2m', target: 750 },
    { duration: '5m', target: 750 },
    // Scale down
    { duration: '5m', target: 0 },
  ],
  thresholds: {
    http_req_duration: [
      'p(95)<500',   // 95th percentile < 500ms
      'p(99)<1000',  // 99th percentile < 1000ms
    ],
    errors: ['rate<0.01'],  // Error rate < 1%
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://api.corp.example.com';

export default function() {
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__ENV.API_TOKEN}`,
    },
    timeout: '30s',
  };

  // Simulate realistic API traffic mix
  const rand = Math.random();

  if (rand < 0.60) {
    // 60%: GET requests (read-heavy workload)
    const res = http.get(`${BASE_URL}/api/v1/orders?limit=20`, params);
    check(res, {
      'status is 200': (r) => r.status === 200,
      'response time < 200ms': (r) => r.timings.duration < 200,
    });
    errorRate.add(res.status !== 200);
    latencyP99.add(res.timings.duration);

  } else if (rand < 0.85) {
    // 25%: POST requests (write workload)
    const payload = JSON.stringify({
      items: [{ productId: 'prod-123', quantity: 1 }],
      customerId: `customer-${Math.floor(Math.random() * 10000)}`,
    });
    const res = http.post(`${BASE_URL}/api/v1/orders`, payload, params);
    check(res, {
      'status is 201': (r) => r.status === 201,
      'response time < 500ms': (r) => r.timings.duration < 500,
    });
    errorRate.add(res.status !== 201);
    latencyP99.add(res.timings.duration);

  } else {
    // 15%: Complex queries (high CPU workload)
    const res = http.get(`${BASE_URL}/api/v1/analytics/summary?period=30d`, params);
    check(res, {
      'status is 200': (r) => r.status === 200,
      'response time < 2000ms': (r) => r.timings.duration < 2000,
    });
    errorRate.add(res.status !== 200);
    latencyP99.add(res.timings.duration);
  }

  requestCount.add(1);
  sleep(0.1);  // 10 RPS per VU
}
```

### Run Load Test and Monitor Cluster

```bash
# Run k6 load test and output results
k6 run \
  --env BASE_URL=https://api.corp.example.com \
  --env API_TOKEN=<token> \
  --out prometheus=http://prometheus-pushgateway.monitoring.svc.cluster.local:9091 \
  k6-load-test.js

# Simultaneously monitor cluster resources
watch -n 5 "kubectl top nodes && echo '---' && kubectl top pods -n production --sort-by=cpu | head -20"

# Watch HPA scaling
watch -n 5 "kubectl get hpa -n production"

# Watch cluster autoscaler events
kubectl get events -n kube-system --field-selector reason=TriggeredScaleUp -w

# Watch pod pending (signals insufficient capacity)
kubectl get pods -n production --field-selector status.phase=Pending -w
```

## Section 7: Headroom Calculations

### Headroom Model for Production Clusters

```bash
#!/usr/bin/env bash
# headroom-calculator.sh

# === Cluster Parameters ===
TOTAL_NODES=15
WORKER_NODES=12    # Excluding control plane
NODE_CPU_CORES=16  # m6i.4xlarge
NODE_MEM_GIB=64

# === Reservations ===
SYSTEM_CPU_PER_NODE=1.6       # 10% + daemonsets
SYSTEM_MEM_PER_NODE_GIB=6.4   # 10% + daemonsets

# === Allocatable per node ===
NODE_CPU_ALLOC=$(echo "$NODE_CPU_CORES - $SYSTEM_CPU_PER_NODE" | bc)
NODE_MEM_ALLOC=$(echo "$NODE_MEM_GIB - $SYSTEM_MEM_PER_NODE_GIB" | bc)

# === Total cluster allocatable ===
TOTAL_CPU=$(echo "$WORKER_NODES * $NODE_CPU_ALLOC" | bc)
TOTAL_MEM=$(echo "$WORKER_NODES * $NODE_MEM_ALLOC" | bc)

echo "=== Cluster Capacity ==="
echo "Allocatable CPU:    ${TOTAL_CPU} cores"
echo "Allocatable Memory: ${TOTAL_MEM} GiB"
echo ""

# === Headroom Requirements ===
# 1. Node failure headroom: 1 node worth of capacity
FAILURE_CPU=$(echo "$NODE_CPU_ALLOC" | bc)
FAILURE_MEM=$(echo "$NODE_MEM_ALLOC" | bc)

# 2. Maintenance headroom: 2 nodes being drained simultaneously
MAINTENANCE_CPU=$(echo "2 * $NODE_CPU_ALLOC" | bc)
MAINTENANCE_MEM=$(echo "2 * $NODE_MEM_ALLOC" | bc)

# 3. Burst headroom: 30% above baseline for traffic spikes
CURRENT_CPU_REQUESTS=85  # From monitoring
BURST_CPU=$(echo "scale=1; $CURRENT_CPU_REQUESTS * 0.3" | bc)
BURST_MEM=50  # Current memory requests
BURST_MEM_CALC=$(echo "scale=1; $BURST_MEM * 0.3" | bc)

# 4. Autoscaler lag headroom: capacity for 5 minutes of growth before new nodes join
GROWTH_RATE_CPU_PER_MIN=2  # Expected growth
AUTOSCALER_LAG_MIN=5
LAG_CPU=$(echo "$GROWTH_RATE_CPU_PER_MIN * $AUTOSCALER_LAG_MIN" | bc)

echo "=== Required Headroom ==="
echo "Node failure (1 node):      CPU=${FAILURE_CPU} cores, MEM=${FAILURE_MEM} GiB"
echo "Maintenance (2 nodes):      CPU=${MAINTENANCE_CPU} cores, MEM=${MAINTENANCE_MEM} GiB"
echo "Burst (30% above baseline): CPU=${BURST_CPU} cores, MEM=${BURST_MEM_CALC} GiB"
echo "Autoscaler lag (5 min):     CPU=${LAG_CPU} cores"
echo ""

TOTAL_HEADROOM_CPU=$(echo "$MAINTENANCE_CPU + $BURST_CPU + $LAG_CPU" | bc)
TOTAL_HEADROOM_MEM=$(echo "$MAINTENANCE_MEM + $BURST_MEM_CALC" | bc)

echo "=== Total Required Headroom ==="
echo "CPU: ${TOTAL_HEADROOM_CPU} cores ($(echo "scale=1; $TOTAL_HEADROOM_CPU / $TOTAL_CPU * 100" | bc)% of cluster)"
echo "MEM: ${TOTAL_HEADROOM_MEM} GiB ($(echo "scale=1; $TOTAL_HEADROOM_MEM / $TOTAL_MEM * 100" | bc)% of cluster)"
echo ""

echo "=== Target Utilization (to maintain headroom) ==="
SAFE_CPU=$(echo "scale=1; ($TOTAL_CPU - $TOTAL_HEADROOM_CPU) / $TOTAL_CPU * 100" | bc)
SAFE_MEM=$(echo "scale=1; ($TOTAL_MEM - $TOTAL_HEADROOM_MEM) / $TOTAL_MEM * 100" | bc)
echo "Safe CPU utilization target:    ${SAFE_CPU}%"
echo "Safe Memory utilization target: ${SAFE_MEM}%"
```

## Section 8: Capacity Reporting and Alerting

### Prometheus Alerting Rules

```yaml
# capacity-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: capacity-alerts
  namespace: monitoring
spec:
  groups:
    - name: capacity.rules
      rules:
        - alert: ClusterCPURequestPressure
          expr: |
            sum(kube_pod_container_resource_requests{resource="cpu"}) /
            sum(kube_node_status_allocatable{resource="cpu"}) > 0.80
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "CPU requests at {{ $value | humanizePercentage }} of cluster capacity"
            runbook: https://runbooks.corp.example.com/kubernetes/capacity

        - alert: ClusterMemoryRequestPressure
          expr: |
            sum(kube_pod_container_resource_requests{resource="memory"}) /
            sum(kube_node_status_allocatable{resource="memory"}) > 0.80
          for: 15m
          labels:
            severity: warning

        - alert: NodeCPUActualPressure
          expr: |
            sum by (node) (rate(container_cpu_usage_seconds_total[5m])) /
            sum by (node) (kube_node_status_allocatable{resource="cpu"}) > 0.85
          for: 10m
          labels:
            severity: critical

        - alert: PodsPendingScheduling
          expr: |
            count(kube_pod_status_phase{phase="Pending"}) > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "{{ $value }} pods pending — possible capacity shortage"

        - alert: NodeNotReady
          expr: |
            count(kube_node_status_condition{condition="Ready",status="true"} == 0) > 0
          for: 5m
          labels:
            severity: critical
```

This guide provides the quantitative framework for Kubernetes capacity planning. The combination of utilization auditing, bin-packing analysis, VPA-guided right-sizing, conservative headroom calculations, and load-test validation enables platform teams to maintain reliable service while optimizing infrastructure cost.
