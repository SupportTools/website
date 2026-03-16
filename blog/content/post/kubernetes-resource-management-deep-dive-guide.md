---
title: "Kubernetes Resource Management: Requests, Limits, and QoS Deep Dive"
date: 2027-05-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resources", "CPU", "Memory", "QoS", "LimitRange", "ResourceQuota"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes resource management covering CPU/memory requests and limits, QoS classes, OOMKiller behavior, CPU throttling, LimitRange defaults, ResourceQuota enforcement, and VPA recommendations."
more_link: "yes"
url: "/kubernetes-resource-management-deep-dive-guide/"
---

Resource management is the single topic that most frequently separates Kubernetes clusters that run smoothly from those that produce mysterious performance degradation, unexpected OOM kills, and scheduler failures. The concepts appear simple on the surface—set requests and limits, stay within quota—but the underlying mechanics of CFS CPU scheduling, the Linux OOM killer, and the Kubernetes Quality of Service (QoS) hierarchy create a web of interactions that produce surprising behaviour in production.

A container that sets no memory limit will run fine on a quiet cluster and be killed without warning on a busy one. A container that sets CPU limits too low will appear to function correctly—all its requests will complete—but with latency 3–10x higher than expected because the kernel is throttling it. A StatefulSet with `Guaranteed` QoS will outlive every BestEffort pod during a memory pressure event, but it must pay the price of predictable (and sometimes oversized) resource reservations.

<!--more-->

## Executive Summary

This guide provides a complete mental model for Kubernetes resource management: how requests differ from limits at the scheduler and runtime levels, the mechanics of CPU CFS throttling, the OOM killer's interaction with container cgroups, QoS class assignment and its consequences during node pressure, LimitRange for namespace defaults, ResourceQuota for namespace caps, extended resources for GPUs and custom hardware, VPA for automated right-sizing, and a practical workflow for diagnosing and resolving resource-related production issues.

## Requests vs Limits: Scheduling vs Enforcement

### The Fundamental Distinction

```
Request                                 Limit
────────────────────────────────────    ────────────────────────────────────
Used by: kube-scheduler                 Used by: kubelet / container runtime
Purpose: reserve capacity on node       Purpose: enforce maximum usage
Effect:  node.allocatable -= request    Effect:  kernel enforces via cgroups
                                        CPU: throttling (CFS)
                                        Memory: OOM kill
When:    at pod scheduling time         When:    at runtime, continuously
```

### How the Scheduler Uses Requests

The scheduler views each node through the lens of `Allocatable` resources:

```bash
# View a node's allocatable resources
kubectl describe node worker-1 | grep -A10 "Allocatable:"

# Example output:
# Allocatable:
#   cpu:               7580m        ← 8 CPU minus system/kubelet reservation
#   ephemeral-storage: 117Gi
#   hugepages-1Gi:     0
#   hugepages-2Mi:     0
#   memory:            14432Mi      ← 16Gi minus system reservation
#   pods:              110
```

```bash
# View what's already scheduled on the node
kubectl describe node worker-1 | grep -A20 "Allocated resources:"

# Example output:
# Allocated resources:
#   (Total limits may be over 100 percent, i.e., overcommitted.)
#   Resource           Requests     Limits
#   --------           --------     ------
#   cpu                4250m (56%)  8200m (108%)   ← limits can exceed 100%
#   memory             7Gi (49%)    12Gi (85%)
```

The scheduler only looks at `Requests` when determining fit. A pod with `requests.cpu=100m, limits.cpu=2000m` occupies 100m of schedulable CPU capacity regardless of how much it actually uses.

### Resource Overcommit and Its Risks

```yaml
# A node with 4 vCPU can schedule pods with total requests of 4000m
# But it can schedule pods with total limits of, say, 32000m (8x overcommit)
# This is intentional: pods rarely hit their limits simultaneously

# Risk: if all pods hit limits simultaneously, CPU throttling increases dramatically
# and memory OOM kills can cascade

# Healthy overcommit ratios (general guidance):
# CPU limits / CPU allocatable:   2-4x is safe; >8x risks latency spikes
# Memory limits / memory allocatable: 1.2-1.5x; >2x risks OOM cascades
```

## CPU Resource Management

### CFS (Completely Fair Scheduler) and CPU Throttling

Kubernetes CPU limits are enforced by the Linux Completely Fair Scheduler (CFS) through cgroup CPU quotas. Understanding CFS is essential to understanding why CPU-limited containers experience unexpected latency.

```
CFS CPU quota mechanism:
  - Each container gets a quota: cpu_quota = limit_millicores × period / 1000
  - Default CFS period: 100ms
  - Container with limits.cpu=500m gets:
      cpu_quota = 500 × 100ms / 1000 = 50ms per 100ms period

  Reality:
    Container requests 50ms of CPU in burst at start of period
    → uses full 50ms quota in 20ms of wall time (on 2.5 GHz core)
    → throttled for remaining 80ms of period
    → appears to "freeze" for 80ms even though CPU is idle elsewhere
```

```bash
# Check CPU throttling for a pod
# Throttled periods = periods where container was throttled
# Total periods = total CFS periods evaluated

kubectl exec -it <pod> -n <namespace> -- cat \
  /sys/fs/cgroup/cpu/cpu.stat

# Output:
# nr_periods 1000
# nr_throttled 350      ← 35% of periods had throttling
# throttled_time 28000000000   ← 28 seconds of total throttle time

# High throttling ratio (>25%) indicates limits are set too low
# or there are bursty workloads that need higher limits
```

### Prometheus Metrics for CPU Throttling

```promql
# CPU throttling ratio per container
sum(rate(container_cpu_cfs_throttled_periods_total{
  container!="",
  namespace!=""
}[5m])) by (namespace, pod, container)
/
sum(rate(container_cpu_cfs_periods_total{
  container!="",
  namespace!=""
}[5m])) by (namespace, pod, container)
```

### CPU Requests for Scheduler Affinity

```yaml
# CPU requests also influence scheduling density
# Low requests = more pods per node (higher density, more noisy-neighbour risk)
# High requests = fewer pods per node (lower density, more predictable)

# For latency-sensitive services: set requests = limits (Guaranteed QoS)
# This prevents scheduler from placing too many pods on the same node
apiVersion: v1
kind: Pod
metadata:
  name: latency-sensitive-api
spec:
  containers:
  - name: api
    image: example.com/api:v1.0
    resources:
      requests:
        cpu: "2"       # request 2 full CPUs
        memory: 2Gi
      limits:
        cpu: "2"       # limit = request → Guaranteed QoS
        memory: 2Gi
```

### Disabling CPU Limits (Controversial but Sometimes Correct)

```yaml
# Some teams remove CPU limits entirely, relying only on requests
# Pro: eliminates CFS throttling; CPU is shared fairly based on requests
# Con: a runaway container can starve neighbours up to its node's CPU

apiVersion: v1
kind: Pod
metadata:
  name: no-cpu-limit-pod
spec:
  containers:
  - name: app
    resources:
      requests:
        cpu: "500m"    # still set request for scheduling
        memory: 512Mi
      limits:
        # cpu: intentionally omitted
        memory: 1Gi    # always set memory limit
```

The performance engineering team at Zalando published research showing CPU throttling from CFS quotas causing significant latency increases even when average CPU usage was well below the limit. Many high-performance teams now run without CPU limits, accepting the risk of noisy neighbours in exchange for consistent latency.

## Memory Resource Management

### OOM Killer Behaviour

Unlike CPU (which throttles), memory limits are enforced by the OOM killer. When a container exceeds its memory limit, the kernel kills it immediately.

```
Memory limit enforcement:
  1. Container uses memory up to its cgroup limit
  2. If it tries to allocate beyond the limit:
     → kernel OOM killer activates for that cgroup
     → the container's main process is killed with SIGKILL
     → kubelet detects the container exit
     → if restartPolicy=Always: container restarts (CrashLoopBackOff risk)
     → Pod shows: OOMKilled reason in container status
```

```bash
# Check if a pod has been OOM killed
kubectl describe pod <pod-name> -n <namespace> | grep -A5 "Last State:"

# Example output:
# Last State:     Terminated
#   Reason:       OOMKilled     ← memory limit exceeded
#   Exit Code:    137           ← 128 + SIGKILL(9) = 137
#   Started:      Mon, 01 Jan 2027 10:00:00 +0000
#   Finished:     Mon, 01 Jan 2027 10:05:00 +0000

# Check OOM kill events in the kernel log (on the node)
dmesg | grep -i "oom\|killed process"
```

### Working Set vs RSS vs Cache

Kubernetes measures memory usage as `container_memory_working_set_bytes`, not RSS or total virtual memory:

```bash
# Working set = RSS + anonymous memory + cache that cannot be reclaimed
# This is what kubelet uses for OOM eviction decisions

# Prometheus query: working set per container
container_memory_working_set_bytes{
  container!="",
  namespace="production"
} / 1024 / 1024

# RSS (resident set size) — excludes reclaimable page cache
container_memory_rss{container!="", namespace="production"} / 1024 / 1024

# Total cache (page cache — mostly reclaimable)
container_memory_cache{container!="", namespace="production"} / 1024 / 1024
```

### Setting Memory Limits Correctly

```yaml
# Step 1: Run without limits for 72 hours in staging
# Step 2: Observe peak working set memory
# Step 3: Set limit to peak + 20-30% buffer
# Step 4: Set request to typical usage (not peak)

# Example: Java service observed peak at 1.2 GiB working set
apiVersion: v1
kind: Pod
metadata:
  name: java-service
spec:
  containers:
  - name: app
    image: example.com/java-service:v2.0
    resources:
      requests:
        memory: 768Mi   # typical usage
        cpu: 500m
      limits:
        memory: 1536Mi  # peak × 1.25 = 1.2Gi × 1.25
        cpu: 2000m
    env:
    # Set JVM heap relative to container memory limit
    - name: JAVA_OPTS
      value: "-Xmx1024m -Xms512m -XX:MaxMetaspaceSize=256m"
    # JVM 17+ can auto-detect container limits:
    - name: JDK_JAVA_OPTIONS
      value: "-XX:+UseContainerSupport -XX:MaxRAMPercentage=70.0"
```

### JVM and Memory Limits

```yaml
# JVM-specific memory configuration for Kubernetes
# Without proper JVM configuration, Java may use host memory, not container limits

containers:
- name: spring-boot-app
  image: example.com/spring-app:v1.0
  resources:
    requests:
      memory: 1Gi
      cpu: 500m
    limits:
      memory: 2Gi
      cpu: 2000m
  env:
  # UseContainerSupport (default in JDK 10+): reads cgroup limits
  # MaxRAMPercentage: use 75% of container memory for heap
  # -Xss: reduce thread stack size (default 512k, often too large)
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:+UseContainerSupport
      -XX:MaxRAMPercentage=75.0
      -XX:InitialRAMPercentage=50.0
      -XX:+ExitOnOutOfMemoryError
      -Xss256k
      -XX:+HeapDumpOnOutOfMemoryError
      -XX:HeapDumpPath=/tmp/heapdump.hprof
```

## Quality of Service Classes

### QoS Class Assignment Rules

Kubernetes assigns one of three QoS classes to every Pod. The class determines eviction priority during node memory pressure.

```
QoS Class   Assignment Rule                          Eviction Priority
─────────────────────────────────────────────────────────────────────────
Guaranteed  ALL containers must have:                Lowest (evicted last)
            - requests.cpu == limits.cpu
            - requests.memory == limits.memory
            - Both cpu AND memory must be set

Burstable   At least one container has:              Middle
            - requests < limits (or limit not set)
            - OR some containers have no requests
            - Does NOT qualify as Guaranteed

BestEffort  NO containers have any                   Highest (evicted first)
            resource requests or limits
```

```bash
# Check QoS class of a pod
kubectl get pod <pod-name> -o jsonpath='{.status.qosClass}'

# Check QoS across all pods in namespace
kubectl get pods -n production \
  -o custom-columns='NAME:.metadata.name,QOS:.status.qosClass'
```

### QoS Class Configuration Examples

```yaml
# GUARANTEED QoS — requests == limits for all containers
apiVersion: v1
kind: Pod
metadata:
  name: guaranteed-pod
spec:
  containers:
  - name: app
    image: nginx:1.27
    resources:
      requests:
        cpu: "1"
        memory: 1Gi
      limits:
        cpu: "1"      # must equal request
        memory: 1Gi   # must equal request
---
# BURSTABLE QoS — at least one container has requests != limits
apiVersion: v1
kind: Pod
metadata:
  name: burstable-pod
spec:
  containers:
  - name: app
    image: nginx:1.27
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: "2"        # limit > request → Burstable
        memory: 512Mi
---
# BESTEFFORT QoS — no resources set at all (not recommended for production)
apiVersion: v1
kind: Pod
metadata:
  name: besteffort-pod
spec:
  containers:
  - name: app
    image: nginx:1.27
    # No resources block → BestEffort
    # Will be evicted first during memory pressure
```

### QoS and the OOM Score

The kernel OOM score for a container's main process is derived from its QoS class and current memory usage:

```bash
# Check OOM score for a container's PID
# (run on the node hosting the pod)

# Get container PID
POD_UID="..."  # get from kubectl get pod -o jsonpath='{.metadata.uid}'
cat /sys/fs/cgroup/memory/kubepods/burstable/pod${POD_UID}/*/cgroup.procs

# Check OOM score adjustment
PID=12345
cat /proc/$PID/oom_score_adj

# OOM score adjustments by QoS class:
# Guaranteed: -997 (kernel will kill other things first)
# Burstable:  proportional to memory usage relative to request/limit
# BestEffort: +1000 (killed first under pressure)
```

### Eviction Hierarchy During Node Pressure

```
Node memory pressure event:
  1. kubelet eviction manager activates
  2. Eviction threshold reached (e.g., memory.available < 100Mi)

  Eviction order:
  ┌─────────────────────────────────────────────────────┐
  │ First evicted: BestEffort pods                      │
  │   → pods with no resource requests/limits           │
  │                                                     │
  │ Second evicted: Burstable pods                      │
  │   → pods using more than their requests             │
  │   → priority: highest (usage - request) first       │
  │                                                     │
  │ Last evicted: Guaranteed pods                       │
  │   → only evicted if no BestEffort/Burstable remain  │
  │   → priority: highest usage first                   │
  └─────────────────────────────────────────────────────┘
```

## LimitRange: Namespace Defaults and Constraints

LimitRange applies default values and enforces constraints on resources at the namespace level. It affects pods that do not specify their own resource values.

### Complete LimitRange Configuration

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limits
  namespace: production
spec:
  limits:
  # Container-level limits
  - type: Container
    # Applied to containers without explicit settings
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    # Hard maximum per container
    max:
      cpu: "8"
      memory: "16Gi"
    # Hard minimum per container
    min:
      cpu: "10m"
      memory: "32Mi"
    # Limit must be <= N × request (prevents extreme overcommit per container)
    maxLimitRequestRatio:
      cpu: "10"       # limit.cpu <= 10 × request.cpu
      memory: "4"     # limit.memory <= 4 × request.memory

  # Pod-level limits (sum of all containers)
  - type: Pod
    max:
      cpu: "16"
      memory: "32Gi"
    min:
      cpu: "20m"
      memory: "64Mi"

  # PVC-level storage constraints
  - type: PersistentVolumeClaim
    max:
      storage: "100Gi"
    min:
      storage: "1Gi"
```

### How LimitRange Defaults Are Applied

```bash
# Create a pod without resource specifications in a namespace with LimitRange
kubectl run test-pod --image=nginx:1.27 -n production

# Check what resources were applied
kubectl get pod test-pod -n production \
  -o jsonpath='{.spec.containers[0].resources}'

# Output shows LimitRange defaults were injected:
# {
#   "limits": {"cpu": "500m", "memory": "512Mi"},
#   "requests": {"cpu": "100m", "memory": "128Mi"}
# }
```

### LimitRange Validation

```bash
# Test that LimitRange enforces limits
# This should FAIL because it exceeds max:
kubectl run too-large --image=nginx \
  --limits="cpu=16,memory=64Gi" \
  -n production

# Error:
# Error from server (Forbidden): pods "too-large" is forbidden:
# maximum cpu usage per Container is 8, but limit is 16.
```

## ResourceQuota: Namespace Capacity Caps

ResourceQuota enforces aggregate resource consumption limits across all pods in a namespace.

### Complete ResourceQuota Configuration

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    # Compute resources
    requests.cpu: "50"              # total CPU requests in namespace
    limits.cpu: "100"               # total CPU limits in namespace
    requests.memory: "100Gi"        # total memory requests
    limits.memory: "200Gi"          # total memory limits

    # Object counts
    pods: "200"                     # total pods (running + terminated)
    replicationcontrollers: "20"
    services: "50"
    services.loadbalancers: "10"
    services.nodeports: "5"
    secrets: "200"
    configmaps: "200"
    persistentvolumeclaims: "100"

    # Storage
    requests.storage: "1Ti"
    requests.ephemeral-storage: "50Gi"
    limits.ephemeral-storage: "100Gi"

    # Per-StorageClass quotas
    fast-ssd.storageclass.storage.k8s.io/requests.storage: "100Gi"
    fast-ssd.storageclass.storage.k8s.io/persistentvolumeclaims: "20"

    # Per-priority class quotas
    count/pods.scheduling.k8s.io/high-priority: "10"
```

### Scoped ResourceQuota (Priority Classes)

```yaml
# Separate quota for different priority classes
# High-priority pods get a protected allocation
apiVersion: v1
kind: ResourceQuota
metadata:
  name: critical-quota
  namespace: production
spec:
  hard:
    requests.cpu: "10"
    requests.memory: "20Gi"
    pods: "20"
  scopeSelector:
    matchExpressions:
    - scopeName: PriorityClass
      operator: In
      values:
      - critical
      - system-cluster-critical
---
# Separate quota for low-priority batch jobs
apiVersion: v1
kind: ResourceQuota
metadata:
  name: batch-quota
  namespace: production
spec:
  hard:
    requests.cpu: "40"
    requests.memory: "80Gi"
    pods: "180"
  scopeSelector:
    matchExpressions:
    - scopeName: PriorityClass
      operator: In
      values:
      - batch-low-priority
      - ""    # default priority class
```

### Monitoring ResourceQuota Usage

```bash
# Check ResourceQuota usage in real time
kubectl describe resourcequota -n production

# Example output:
# Name:                   production-quota
# Namespace:              production
# Resource                Used    Hard
# --------                ----    ----
# limits.cpu              42      100
# limits.memory           68Gi    200Gi
# pods                    127     200
# requests.cpu            21500m  50
# requests.memory         37Gi    100Gi
# services                28      50

# Get ResourceQuota utilisation as JSON (for scripting)
kubectl get resourcequota production-quota -n production \
  -o jsonpath='{.status}' | jq '.'
```

### ResourceQuota Admission Failure Troubleshooting

```bash
# When a pod fails to create due to quota:
kubectl describe pod <failed-pod> -n production
# Events:
#   Warning  FailedCreate  0s  replicaset-controller
#   Error creating: pods "app-abc123" is forbidden:
#   exceeded quota: production-quota,
#   requested: limits.memory=1Gi,
#   used: limits.memory=199Gi, limited: limits.memory=200Gi

# Solution: check which workloads are consuming the most quota
kubectl get pods -n production \
  -o custom-columns='NAME:.metadata.name,CPU_REQUEST:.spec.containers[0].resources.requests.cpu,MEM_REQUEST:.spec.containers[0].resources.requests.memory,MEM_LIMIT:.spec.containers[0].resources.limits.memory' \
  | sort -k4 -rh \
  | head -20
```

## Extended Resources (GPUs and Custom Hardware)

```yaml
# Request NVIDIA GPU for ML workload
apiVersion: v1
kind: Pod
metadata:
  name: gpu-training-job
  namespace: ml-platform
spec:
  containers:
  - name: trainer
    image: nvcr.io/nvidia/tensorflow:24.03-tf2-py3
    resources:
      requests:
        nvidia.com/gpu: 2    # request 2 GPUs
        cpu: "4"
        memory: 32Gi
      limits:
        nvidia.com/gpu: 2    # GPU limits == requests always
        cpu: "8"
        memory: 64Gi
    env:
    - name: NVIDIA_VISIBLE_DEVICES
      value: all
    - name: NVIDIA_DRIVER_CAPABILITIES
      value: compute,utility
---
# ResourceQuota including GPU limits
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ml-team-quota
  namespace: ml-platform
spec:
  hard:
    requests.cpu: "32"
    requests.memory: "256Gi"
    nvidia.com/gpu: "8"        # cap total GPU allocation for namespace
    pods: "20"
```

## Vertical Pod Autoscaler (VPA)

VPA monitors actual resource usage and recommends (or automatically applies) resource adjustments.

### VPA Installation

```bash
# Install VPA
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install VPA CRDs and components
./hack/vpa-up.sh

# Verify VPA components
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-xxx   Running
# vpa-recommender-xxx            Running
# vpa-updater-xxx                Running
```

### VPA Modes

```yaml
# VPA in "Off" mode — recommendations only, no automatic updates
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  updatePolicy:
    updateMode: "Off"    # recommendations visible but not applied
  resourcePolicy:
    containerPolicies:
    - containerName: api
      minAllowed:
        cpu: 50m
        memory: 64Mi
      maxAllowed:
        cpu: "4"
        memory: 4Gi
      controlledResources:
      - cpu
      - memory
---
# VPA in "Auto" mode — automatically updates pod resources
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: worker-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: background-worker
  updatePolicy:
    updateMode: "Auto"    # evicts and recreates pods with new resources
    minReplicas: 2        # don't update if only 1 replica would remain
  resourcePolicy:
    containerPolicies:
    - containerName: worker
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: "2"
        memory: 2Gi
---
# VPA in "Initial" mode — sets resources only at pod creation time
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: batch-job-vpa
  namespace: batch
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: batch-processor
  updatePolicy:
    updateMode: "Initial"   # applies only to new pods, not existing ones
```

### Reading VPA Recommendations

```bash
# Check VPA recommendations
kubectl describe vpa api-service-vpa -n production

# Look for:
# Status:
#   Conditions:
#     Message: 3 Vpa Recommendations available
#   Recommendation:
#     Container Recommendations:
#       Container Name:  api
#       Lower Bound:
#         Cpu:     50m
#         Memory:  300Mi
#       Target:
#         Cpu:     200m        ← recommended request
#         Memory:  512Mi       ← recommended request
#       Uncapped Target:
#         Cpu:     250m
#         Memory:  600Mi
#       Upper Bound:
#         Cpu:     500m
#         Memory:  1Gi        ← recommended limit

# Get raw VPA recommendation in JSON
kubectl get vpa api-service-vpa -n production \
  -o jsonpath='{.status.recommendation.containerRecommendations[0]}' \
  | jq '.'
```

### VPA + HPA Compatibility

VPA and HPA cannot manage the same metric simultaneously. The safe pattern is:

```yaml
# Use VPA for vertical (memory) scaling + HPA for horizontal (CPU) scaling
# Configure VPA to only manage memory
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-vpa-memory-only
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: api
      controlledResources:
      - memory    # VPA manages memory
      # Do NOT include cpu — HPA manages that via scaling replicas
      minAllowed:
        memory: 256Mi
      maxAllowed:
        memory: 4Gi
---
# HPA manages replica count based on CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## Right-Sizing Workflow

### Step 1: Observe Without Limits

```bash
# Deploy to staging without resource limits for 72 hours
# Collect metrics with this PromQL

# Peak CPU usage (99th percentile over 72h) per container
max_over_time(
  rate(container_cpu_usage_seconds_total{
    namespace="staging",
    container="api"
  }[5m])
[72h:5m]) * 1000  # convert to millicores

# Peak memory working set
max_over_time(
  container_memory_working_set_bytes{
    namespace="staging",
    container="api"
  }
[72h:5m]) / 1024 / 1024  # convert to MiB
```

### Step 2: Calculate Requests and Limits

```bash
#!/bin/bash
# right-size.sh — calculate recommended requests/limits from Prometheus data

NAMESPACE="staging"
CONTAINER="api"
PROM_URL="http://prometheus.monitoring.svc.cluster.local:9090"

# Fetch p50 CPU (request candidate)
CPU_P50=$(curl -s "${PROM_URL}/api/v1/query" \
  --data-urlencode "query=quantile_over_time(0.5, rate(container_cpu_usage_seconds_total{namespace=\"${NAMESPACE}\",container=\"${CONTAINER}\"}[5m])[72h:5m])" \
  | jq -r '.data.result[0].value[1]')

# Fetch p99 CPU (limit candidate)
CPU_P99=$(curl -s "${PROM_URL}/api/v1/query" \
  --data-urlencode "query=quantile_over_time(0.99, rate(container_cpu_usage_seconds_total{namespace=\"${NAMESPACE}\",container=\"${CONTAINER}\"}[5m])[72h:5m])" \
  | jq -r '.data.result[0].value[1]')

# Fetch p50 memory (request candidate)
MEM_P50=$(curl -s "${PROM_URL}/api/v1/query" \
  --data-urlencode "query=quantile_over_time(0.5, container_memory_working_set_bytes{namespace=\"${NAMESPACE}\",container=\"${CONTAINER}\"}[72h:5m])" \
  | jq -r '.data.result[0].value[1]')

# Fetch p99 memory (limit candidate)
MEM_P99=$(curl -s "${PROM_URL}/api/v1/query" \
  --data-urlencode "query=quantile_over_time(0.99, container_memory_working_set_bytes{namespace=\"${NAMESPACE}\",container=\"${CONTAINER}\"}[72h:5m])" \
  | jq -r '.data.result[0].value[1]')

# Apply 20% buffer
CPU_REQUEST=$(echo "$CPU_P50 * 1000 * 1.1" | bc | xargs printf "%.0f")  # millicores
CPU_LIMIT=$(echo "$CPU_P99 * 1000 * 1.2" | bc | xargs printf "%.0f")    # millicores
MEM_REQUEST=$(echo "$MEM_P50 / 1048576 * 1.1" | bc | xargs printf "%.0f")  # MiB
MEM_LIMIT=$(echo "$MEM_P99 / 1048576 * 1.25" | bc | xargs printf "%.0f")   # MiB

echo "Recommended resources for ${NAMESPACE}/${CONTAINER}:"
echo "  requests.cpu:    ${CPU_REQUEST}m"
echo "  limits.cpu:      ${CPU_LIMIT}m"
echo "  requests.memory: ${MEM_REQUEST}Mi"
echo "  limits.memory:   ${MEM_LIMIT}Mi"
```

### Step 3: Apply and Validate

```bash
# Apply new resource settings
kubectl set resources deployment api-service \
  -n production \
  --containers=api \
  --requests="cpu=200m,memory=512Mi" \
  --limits="cpu=1000m,memory=1Gi"

# Watch for OOM kills after change
kubectl get events -n production \
  --field-selector reason=OOMKilling \
  -w

# Watch for CPU throttling
kubectl exec -n production deploy/api-service -- \
  cat /sys/fs/cgroup/cpu/cpu.stat | grep nr_throttled

# Monitor p99 latency for regression
# (expect latency improvement if previously CPU-throttled)
```

## Comprehensive Alerting for Resource Management

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-resource-alerts
  namespace: monitoring
spec:
  groups:
  - name: resource-management.rules
    rules:

    # OOM Kill detection
    - alert: ContainerOOMKilled
      expr: |
        increase(kube_pod_container_status_restarts_total[15m]) > 0
        and
        kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
      for: 0m
      labels:
        severity: warning
      annotations:
        summary: "Container OOM killed"
        description: >
          {{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }}
          was OOM killed. Consider increasing memory limit.

    # CPU throttling alert
    - alert: ContainerHighCPUThrottling
      expr: |
        sum(rate(container_cpu_cfs_throttled_periods_total{container!=""}[5m]))
        by (namespace, pod, container)
        /
        sum(rate(container_cpu_cfs_periods_total{container!=""}[5m]))
        by (namespace, pod, container)
        > 0.25
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High CPU throttling"
        description: >
          {{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }}
          is CPU throttled {{ $value | humanizePercentage }} of the time.
          Consider increasing CPU limit.

    # Memory usage approaching limit
    - alert: ContainerMemoryApproachingLimit
      expr: |
        container_memory_working_set_bytes{container!=""}
        /
        on(namespace, pod, container)
        kube_pod_container_resource_limits{resource="memory", container!=""}
        > 0.85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Container memory near limit"
        description: >
          {{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }}
          is using {{ $value | humanizePercentage }} of its memory limit.

    # CPU request/limit ratio too high (over-committing risk)
    - alert: NamespaceCPUOvercommitHigh
      expr: |
        sum(kube_pod_container_resource_limits{resource="cpu", namespace!="kube-system"})
        by (namespace)
        /
        sum(kube_pod_container_resource_requests{resource="cpu", namespace!="kube-system"})
        by (namespace)
        > 8
      for: 30m
      labels:
        severity: info
      annotations:
        summary: "High CPU overcommit ratio in namespace"
        description: >
          {{ $labels.namespace }} has a CPU limit/request ratio of
          {{ $value | humanize }}x, which may cause throttling storms.

    # ResourceQuota near exhaustion
    - alert: NamespaceQuotaAlmostFull
      expr: |
        kube_resourcequota{type="used"}
        /
        kube_resourcequota{type="hard"}
        > 0.9
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "ResourceQuota almost exhausted"
        description: >
          {{ $labels.namespace }} quota for {{ $labels.resource }}
          is {{ $value | humanizePercentage }} used.

    # Node memory pressure
    - alert: NodeMemoryPressure
      expr: kube_node_status_condition{condition="MemoryPressure", status="true"} == 1
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Node under memory pressure"
        description: >
          Node {{ $labels.node }} is under memory pressure.
          BestEffort pods will be evicted.

    # Pods in BestEffort QoS on production nodes
    - alert: BestEffortPodInProduction
      expr: |
        kube_pod_status_qos_class{qos_class="BestEffort", namespace="production"} == 1
      for: 5m
      labels:
        severity: info
      annotations:
        summary: "BestEffort pod running in production"
        description: >
          Pod {{ $labels.namespace }}/{{ $labels.pod }} has BestEffort
          QoS class and will be evicted first under memory pressure.
```

## Summary Reference Table

```
Resource Concept          Set By          Effect
────────────────────────────────────────────────────────────────────
requests.cpu              Pod spec        Scheduler reservation; CFS share weight
limits.cpu                Pod spec        CFS quota enforcement (throttling)
requests.memory           Pod spec        Scheduler reservation; eviction threshold
limits.memory             Pod spec        cgroup OOM kill trigger
QoS: Guaranteed           Auto (req==lim) Last evicted under pressure; OOM adj -997
QoS: Burstable            Auto (req<lim)  Mid-priority eviction
QoS: BestEffort           Auto (no req)   First evicted; OOM adj +1000
LimitRange.default        Namespace       Applied to containers without limits
LimitRange.max            Namespace       Admission webhook: blocks over-limit pods
ResourceQuota.hard        Namespace       Admission webhook: blocks if aggregate exceeded
VPA (Off mode)            Namespace       Recommendations only
VPA (Auto mode)           Namespace       Pod restart with new resource values
```

Proper resource management requires revisiting configurations regularly as workloads evolve. A right-sized container in January may be under-resourced in June after a traffic increase, or over-resourced after a code optimisation. The combination of VPA recommendations in `Off` mode (for visibility without disruption), Prometheus alerting on throttling and OOM events, and a quarterly right-sizing review process gives platform teams the visibility and workflow to keep resource configurations accurate without imposing per-deployment overhead on development teams.
