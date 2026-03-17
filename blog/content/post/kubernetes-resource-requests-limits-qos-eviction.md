---
title: "Kubernetes Resource Management: Requests, Limits, QoS Classes, and Eviction"
date: 2029-03-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Management", "QoS", "Eviction", "Production", "Performance"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Kubernetes resource requests, limits, Quality of Service classes, and the eviction subsystem — covering how the scheduler, kubelet, and cgroups interact to protect node stability in production clusters."
more_link: "yes"
url: "/kubernetes-resource-requests-limits-qos-eviction/"
---

Resource management is the foundation of reliable Kubernetes cluster operations. When misconfigured, pods evict unexpectedly, nodes enter pressure states, and latency spikes cascade across tenants. Understanding how requests, limits, QoS classes, and the eviction subsystem interact — from the scheduler through to cgroup enforcement — allows platform teams to build clusters that stay stable under load and recover predictably when they don't.

This guide covers the complete lifecycle: how requests influence scheduling, how limits enforce cgroup boundaries, how the kubelet computes QoS classes, and how the eviction manager selects workloads to terminate when nodes become resource-constrained.

<!--more-->

## Resource Fundamentals

### Requests vs. Limits

Every container spec accepts two resource dimensions: `requests` and `limits`. These serve distinct purposes in the Kubernetes control plane.

**Requests** are the scheduler's currency. When a pod is created, the scheduler sums the requests of all containers in the pod and compares that sum against each node's allocatable capacity. The pod binds to the first node with sufficient headroom. Requests do not cap runtime usage — they are a reservation.

**Limits** are enforced by the Linux kernel through cgroups. The kubelet translates container limits into cgroup parameters: CPU limits become `cpu.cfs_quota_us`, and memory limits become `memory.limit_in_bytes`. A container that exceeds its memory limit receives SIGKILL from the kernel OOM killer. A container that exceeds its CPU limit is throttled by the CFS scheduler, not killed.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-api
  namespace: production
spec:
  containers:
  - name: api
    image: registry.example.com/web-api:v2.4.1
    resources:
      requests:
        cpu: "500m"
        memory: "256Mi"
      limits:
        cpu: "2000m"
        memory: "512Mi"
    ports:
    - containerPort: 8080
```

In the example above, the scheduler reserves 500m CPU and 256Mi memory on the chosen node. The kernel enforces a hard ceiling of 512Mi memory and allows CPU consumption up to 2000m (subject to CFS throttling when quota is exhausted).

### Allocatable Capacity

The schedulable capacity of a node is not equal to its raw hardware. The kubelet reserves capacity for itself and system daemons through two mechanisms:

- `--kube-reserved`: resources reserved for Kubernetes system components (kubelet, container runtime)
- `--system-reserved`: resources reserved for OS-level system daemons (sshd, journald, etc.)

Additionally, the eviction threshold reduces available memory. The formula is:

```
Allocatable = Node Capacity - kube-reserved - system-reserved - eviction-threshold
```

Inspect a node's actual allocatable capacity:

```bash
kubectl get node k8s-worker-01 -o json | \
  jq '{capacity: .status.capacity, allocatable: .status.allocatable}'
```

Example output:
```json
{
  "capacity": {
    "cpu": "16",
    "memory": "64Gi",
    "pods": "110"
  },
  "allocatable": {
    "cpu": "15800m",
    "memory": "61Gi",
    "pods": "110"
  }
}
```

The delta between capacity and allocatable represents the combined reserved buffers.

### Extended Resources and Device Plugins

Beyond CPU and memory, Kubernetes supports extended resources for discrete hardware like GPUs, SR-IOV VFs, and FPGAs. Extended resources follow integer semantics — they cannot be fractionally requested.

```yaml
resources:
  requests:
    nvidia.com/gpu: "1"
    cpu: "4000m"
    memory: "16Gi"
  limits:
    nvidia.com/gpu: "1"
    cpu: "4000m"
    memory: "16Gi"
```

Extended resources require the requests to equal the limits. Any mismatch causes the pod to be rejected by the admission webhook installed by the device plugin.

## Quality of Service Classes

The kubelet assigns each pod one of three QoS classes at admission time. The class determines eviction priority when the node enters resource pressure.

### Guaranteed

A pod receives the Guaranteed class when every container (including init containers and sidecar containers in Kubernetes 1.29+) specifies equal requests and limits for both CPU and memory. Guaranteed pods are the last to be evicted.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: payment-processor
  namespace: production
spec:
  containers:
  - name: processor
    image: registry.example.com/payment:v1.8.0
    resources:
      requests:
        cpu: "1000m"
        memory: "1Gi"
      limits:
        cpu: "1000m"
        memory: "1Gi"
  - name: envoy-proxy
    image: envoyproxy/envoy:v1.29.0
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      limits:
        cpu: "100m"
        memory: "128Mi"
```

Both containers must satisfy the guarantee condition. A single container missing a limit breaks the Guaranteed classification for the entire pod.

### Burstable

A pod receives the Burstable class when at least one container specifies a request or limit for CPU or memory, but the pod does not qualify for Guaranteed. This is the most common class in practice.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: analytics-worker
  namespace: batch
spec:
  containers:
  - name: worker
    image: registry.example.com/analytics:v3.1.0
    resources:
      requests:
        cpu: "200m"
        memory: "512Mi"
      limits:
        cpu: "4000m"
        memory: "2Gi"
```

Burstable pods can consume resources above their requests up to their limits when capacity is available, but they are evicted before Guaranteed pods under memory pressure.

### BestEffort

A pod receives the BestEffort class when no container specifies any requests or limits. These pods consume whatever is available on the node and are the first candidates for eviction.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: low-priority-scanner
  namespace: tools
spec:
  containers:
  - name: scanner
    image: registry.example.com/scanner:latest
    # No resources block — BestEffort QoS
```

BestEffort pods are appropriate for workloads that can tolerate preemption, such as batch jobs with retry logic or development tooling.

### Inspecting QoS Class

```bash
kubectl get pod payment-processor -n production \
  -o jsonpath='{.status.qosClass}'
```

```
Guaranteed
```

## cgroup Enforcement Deep Dive

### CPU Throttling and CFS Quota

The Linux Completely Fair Scheduler (CFS) uses two cgroup parameters to enforce CPU limits:

- `cpu.cfs_period_us`: the scheduling period (default 100,000 microseconds = 100ms)
- `cpu.cfs_quota_us`: the total CPU time allowed per period

For a container with a 500m CPU limit:

```
cpu.cfs_quota_us = 500m * 100,000 = 50,000 microseconds per 100ms period
```

A container with 4000m CPU limit on a 4-core node gets:

```
cpu.cfs_quota_us = 4000m * 100,000 = 400,000 microseconds per 100ms period
```

CPU throttling is invisible in basic metrics. Use container-level metrics from cAdvisor to detect it:

```bash
kubectl exec -it -n monitoring prometheus-0 -- \
  curl -sg 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=rate(container_cpu_cfs_throttled_seconds_total{namespace="production"}[5m]) > 0' | \
  jq '.data.result[] | {pod: .metric.pod, container: .metric.container, throttle_rate: .value[1]}'
```

High throttle rates indicate that limits are too low relative to actual CPU burst requirements. The remedy is either increasing limits or fixing inefficient code paths that cause burst spikes.

### Memory OOM Behavior

When a container's memory consumption approaches its limit, the kernel's OOM killer activates. The OOM killer scores processes within the cgroup using `oom_score_adj`. Kubernetes sets these scores based on QoS class:

- Guaranteed: `oom_score_adj = -997` (lowest score, last to be killed)
- Burstable: score proportional to `(requests / limits)` — between 2 and 999
- BestEffort: `oom_score_adj = 1000` (highest score, first to be killed)

Verify OOM score for a running container:

```bash
# Find the PID of the container process
kubectl exec -n production payment-processor -c processor -- cat /proc/1/oom_score_adj
```

Expected output for a Guaranteed container: `-997`

### Inspecting cgroup Hierarchy

On a node running cgroup v2 (default on modern Linux kernels), inspect container resource constraints:

```bash
# SSH to the node, find the container cgroup
CONTAINER_ID=$(crictl ps --name api --quiet | head -1)
CGROUP_PATH=$(crictl inspect $CONTAINER_ID | \
  jq -r '.info.runtimeSpec.linux.cgroupsPath')

# Read memory limit
cat /sys/fs/cgroup/${CGROUP_PATH}/memory.max

# Read CPU quota
cat /sys/fs/cgroup/${CGROUP_PATH}/cpu.max
```

## LimitRange: Cluster-Level Defaults

LimitRange objects set default requests and limits for namespaces, ensuring BestEffort pods cannot be accidentally deployed to production namespaces.

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: production-defaults
  namespace: production
spec:
  limits:
  - type: Container
    default:
      cpu: "500m"
      memory: "256Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "8000m"
      memory: "16Gi"
    min:
      cpu: "50m"
      memory: "64Mi"
  - type: Pod
    max:
      cpu: "16000m"
      memory: "32Gi"
  - type: PersistentVolumeClaim
    max:
      storage: "50Gi"
    min:
      storage: "1Gi"
```

Key behaviors:
- Containers without explicit requests/limits receive the `defaultRequest` and `default` values
- Containers outside `min`/`max` bounds are rejected by the admission controller
- Pod-level limits bound the aggregate of all containers

## ResourceQuota: Namespace Budget Enforcement

ResourceQuota enforces aggregate resource budgets across all pods in a namespace. This prevents a single team from monopolizing cluster capacity.

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    requests.cpu: "50"
    requests.memory: "100Gi"
    limits.cpu: "100"
    limits.memory: "200Gi"
    pods: "100"
    services: "20"
    services.loadbalancers: "5"
    persistentvolumeclaims: "30"
    requests.storage: "500Gi"
    count/deployments.apps: "30"
    count/statefulsets.apps: "10"
```

When a namespace has a ResourceQuota, every pod must specify requests and limits — otherwise the API server rejects the pod. This makes LimitRange defaults critical for seamless developer experience.

Check quota consumption:

```bash
kubectl describe resourcequota production-quota -n production
```

```
Name:                    production-quota
Namespace:               production
Resource                 Used    Hard
--------                 ----    ----
count/deployments.apps   12      30
limits.cpu               28      100
limits.memory            42Gi    200Gi
pods                     38      100
requests.cpu             14      50
requests.memory          21Gi    100Gi
```

## The Eviction Subsystem

### Eviction Signals and Thresholds

The kubelet monitors several eviction signals and compares them against configurable thresholds:

| Signal | Description |
|--------|-------------|
| `memory.available` | Available memory on the node |
| `nodefs.available` | Available filesystem space for pod volumes |
| `nodefs.inodesFree` | Available inodes on the node filesystem |
| `imagefs.available` | Available space on container image filesystem |
| `pid.available` | Available PIDs (process IDs) |

Configure eviction thresholds in the kubelet configuration:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
  pid.available: "10%"
evictionSoft:
  memory.available: "1Gi"
  nodefs.available: "15%"
evictionSoftGracePeriod:
  memory.available: "2m"
  nodefs.available: "5m"
evictionMinimumReclaim:
  memory.available: "200Mi"
  nodefs.available: "500Mi"
evictionPressureTransitionPeriod: "5m"
```

**Hard eviction** triggers immediate pod termination without a grace period. **Soft eviction** gives pods the configured grace period before killing them, allowing for graceful shutdown.

### Eviction Ordering

When hard eviction triggers, the kubelet selects pods for eviction in this order:

1. BestEffort pods exceeding their requests (they have none, so all BestEffort pods qualify)
2. Burstable pods that have exceeded their memory requests
3. Guaranteed pods (only under extreme pressure)

Within each tier, pods are ranked by the amount they exceed their request. The pod consuming the most memory above its request is evicted first.

### Node Conditions

The kubelet sets node conditions when eviction thresholds are breached:

```bash
kubectl describe node k8s-worker-01 | grep -A 20 "Conditions:"
```

```
Conditions:
  Type                 Status  Reason                       Message
  ----                 ------  ------                       -------
  MemoryPressure       True    KubeletHasInsufficientMemory  kubelet has insufficient memory available
  DiskPressure         False   KubeletHasNoDiskPressure      kubelet has no disk pressure
  PIDPressure          False   KubeletHasSufficientPID       kubelet has sufficient PID available
  Ready                True    KubeletReady                  kubelet is posting ready status
```

When `MemoryPressure` is `True`, the scheduler stops placing new pods on the node.

### Active Eviction Monitoring

Track eviction events using:

```bash
# Watch for eviction events in real-time
kubectl get events --all-namespaces \
  --field-selector reason=Evicted \
  --watch

# Count evictions per namespace over the last hour
kubectl get events --all-namespaces \
  --field-selector reason=Evicted \
  -o json | \
  jq '[.items[] | select(.lastTimestamp > (now - 3600 | todate))] |
      group_by(.involvedObject.namespace) |
      map({namespace: .[0].involvedObject.namespace, count: length})'
```

Prometheus alert for elevated eviction rate:

```yaml
groups:
- name: kubernetes.resource
  rules:
  - alert: PodEvictionRateHigh
    expr: |
      sum(increase(kube_pod_status_reason{reason="Evicted"}[10m])) by (namespace) > 5
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High pod eviction rate in namespace {{ $labels.namespace }}"
      description: "{{ $value }} pods evicted in the last 10 minutes in namespace {{ $labels.namespace }}. Check node memory pressure and pod resource configurations."
  - alert: NodeMemoryPressure
    expr: kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Node {{ $labels.node }} is under memory pressure"
      description: "Node {{ $labels.node }} has MemoryPressure condition True. Active evictions may be occurring."
```

## Priority Classes and Preemption

PriorityClasses allow the scheduler to preempt lower-priority pods when higher-priority pods cannot be scheduled.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: critical-production
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Used for critical production workloads. Preempts lower priority pods."
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: standard-production
value: 100000
globalDefault: true
preemptionPolicy: PreemptLowerPriority
description: "Default priority for production workloads."
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-background
value: 1000
globalDefault: false
preemptionPolicy: Never
description: "Background batch jobs. Never preempts other pods."
```

Assign priority to workloads:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
    spec:
      priorityClassName: critical-production
      containers:
      - name: api
        image: registry.example.com/payment-api:v2.1.0
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2000m"
            memory: "1Gi"
```

Note: Preemption is a last resort. The scheduler only preempts when a high-priority pod cannot fit anywhere and evicting lower-priority pods would create enough space. Pod Disruption Budgets (PDBs) limit how many pods from a deployment can be preempted simultaneously.

## Vertical Pod Autoscaler

The Vertical Pod Autoscaler (VPA) automates request tuning by observing actual resource usage and recommending or automatically applying adjustments.

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: analytics-worker-vpa
  namespace: batch
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: analytics-worker
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: worker
      minAllowed:
        cpu: "100m"
        memory: "128Mi"
      maxAllowed:
        cpu: "8000m"
        memory: "8Gi"
      controlledResources: ["cpu", "memory"]
      controlledValues: RequestsAndLimits
```

Check VPA recommendations without applying them:

```bash
kubectl get vpa analytics-worker-vpa -n batch -o json | \
  jq '.status.recommendation.containerRecommendations[] |
      {container: .containerName,
       lowerBound: .lowerBound,
       target: .target,
       upperBound: .upperBound}'
```

VPA in `Auto` mode evicts and restarts pods to apply new resource settings. Use `Recommendation` mode in production to collect data without disruption, then apply changes during maintenance windows.

## Namespace-Level Resource Governance with Kyverno

Policy engines like Kyverno enforce resource governance across the cluster without modifying application manifests:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-resource-limits
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: check-container-resources
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaces:
          - production
          - staging
    validate:
      message: "CPU and memory requests and limits are required for all containers in production."
      pattern:
        spec:
          containers:
          - name: "*"
            resources:
              requests:
                memory: "?*"
                cpu: "?*"
              limits:
                memory: "?*"
                cpu: "?*"
  - name: restrict-cpu-limits
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaces:
          - production
    validate:
      message: "CPU limits cannot exceed 8 cores per container in production."
      deny:
        conditions:
          any:
          - key: "{{ request.object.spec.containers[].resources.limits.cpu }}"
            operator: AnyGreaterThan
            value: "8000m"
```

## Troubleshooting Resource Issues

### OOMKilled Containers

```bash
# Find recently OOMKilled containers
kubectl get pods --all-namespaces -o json | \
  jq '.items[] |
      select(.status.containerStatuses[]?.lastState.terminated.reason == "OOMKilled") |
      {namespace: .metadata.namespace,
       pod: .metadata.name,
       containers: [.status.containerStatuses[] |
         select(.lastState.terminated.reason == "OOMKilled") |
         {name: .name,
          finishedAt: .lastState.terminated.finishedAt}]}'
```

### CPU Throttling Analysis

```bash
# Prometheus query: CPU throttle percentage per container
# (paste into Grafana or Prometheus UI)
#
# rate(container_cpu_cfs_throttled_seconds_total[5m]) /
# rate(container_cpu_usage_seconds_total[5m]) * 100
#
# This shows the percentage of time a container is throttled vs. running

kubectl top pods -n production --sort-by=cpu
```

### Node Resource Pressure Diagnosis

```bash
# Show node resource usage vs. allocatable
kubectl describe nodes | \
  grep -A 8 "Allocated resources:" | \
  grep -E "(cpu|memory|pods|Requests|Limits)"

# Show which pods are consuming the most memory on a specific node
kubectl get pods --all-namespaces \
  --field-selector spec.nodeName=k8s-worker-01 \
  -o json | \
  jq '[.items[] |
      {namespace: .metadata.namespace,
       pod: .metadata.name,
       memoryRequest: (.spec.containers[].resources.requests.memory // "none")}] |
      sort_by(.memoryRequest)'
```

## Best Practices Summary

**Set requests accurately.** Use VPA in recommendation mode for at least two weeks to gather baseline data before manually tuning requests. Undersized requests lead to poor scheduling; oversized requests waste capacity.

**Match limits to burst characteristics.** Memory limits should be set 20-50% above the P99 memory usage for the workload. CPU limits should be set to the maximum burst the application legitimately needs (or omitted for CPU-intensive batch jobs that do not share nodes).

**Use Guaranteed QoS for latency-sensitive workloads.** Paying the cost of setting equal requests and limits protects critical pods from being evicted under node pressure.

**Configure eviction thresholds conservatively.** The default `memory.available: 100Mi` hard eviction threshold is too low for nodes with large pod counts. A value of 500Mi to 1Gi provides more buffer for graceful eviction.

**Combine LimitRange, ResourceQuota, and PriorityClasses.** LimitRange prevents BestEffort deployment accidents. ResourceQuota enforces team budgets. PriorityClasses protect critical workloads during capacity crunches.

**Monitor CPU throttling, not just usage.** A container can show 50% CPU utilization while being throttled 80% of the time. Track `container_cpu_cfs_throttled_seconds_total` to surface invisible performance bottlenecks.
