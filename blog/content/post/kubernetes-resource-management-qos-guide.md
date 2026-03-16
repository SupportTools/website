---
title: "Kubernetes Resource Management: Requests, Limits, QoS Classes, and OOM Debugging"
date: 2027-05-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Management", "QoS", "OOM", "Performance", "CPU Throttling"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Kubernetes resource management covering CPU and memory requests vs limits, QoS classes, CFS bandwidth throttling, OOM killer behavior, VPA right-sizing, ephemeral storage, extended resources, and Prometheus alerting."
more_link: "yes"
url: "/kubernetes-resource-management-qos-guide/"
---

Resource management is foundational to running reliable workloads on Kubernetes. Setting CPU and memory requests and limits correctly is one of the highest-leverage configuration decisions a platform team makes, yet it is also one of the most frequently misunderstood. Pods with misconfigured resources either starve for CPU, get throttled excessively, consume too much memory and trigger OOM kills, or fail to schedule because the cluster appears full when it is not.

This guide covers the mechanics of how Kubernetes and the Linux kernel handle CPU and memory resources, what QoS classes actually mean for scheduling and eviction decisions, how to diagnose and eliminate excessive CPU throttling, how to debug OOM kills, and how to use the Vertical Pod Autoscaler to right-size workloads systematically.

<!--more-->

## Resource Units

Before examining behavior, the unit conventions require clarity.

### CPU Units

CPU resources are measured in millicores. One millicore is 1/1000th of a CPU core (which corresponds to one hardware thread on most systems). The following are equivalent:

```yaml
resources:
  requests:
    cpu: "1"        # 1 full core
  limits:
    cpu: "500m"     # 500 millicores = 0.5 cores
```

Fractional values without the `m` suffix are also valid: `cpu: "0.5"` is identical to `cpu: "500m"`. The kernel's CFS scheduler works in units of microseconds, and Kubernetes translates millicore values to CFS quota values when configuring cgroups.

### Memory Units

Memory is measured in bytes, with standard SI suffixes (K, M, G, T) or binary suffixes (Ki, Mi, Gi, Ti):

```yaml
resources:
  requests:
    memory: "256Mi"   # 268,435,456 bytes (binary mebibytes)
  limits:
    memory: "512Mi"
```

Note the distinction: `256M` is 256,000,000 bytes (decimal megabytes), while `256Mi` is 268,435,456 bytes (binary mebibytes). Container workload memory is almost always specified in binary units (Mi, Gi) to match how the kernel and operating system report memory usage.

## CPU Requests vs CPU Limits: Different Mechanisms

CPU requests and limits are enforced by entirely different kernel mechanisms, with different behavioral implications.

### CPU Requests: Scheduler Hints and CFS Shares

CPU requests serve two purposes:
1. **Scheduling**: The scheduler uses CPU requests to determine which nodes have sufficient capacity to place the pod. A node is considered schedulable for a pod if the sum of CPU requests of existing pods plus the new pod's request does not exceed the node's allocatable CPU.
2. **CFS shares**: On the running node, the kernel's Completely Fair Scheduler uses CPU requests to set relative `cpu.shares` values in the pod's cgroup. A pod with `cpu: "500m"` receives twice the CPU time as a pod with `cpu: "250m"` when both are contending for CPU. When CPU is not contended, any pod can use all available CPU regardless of its request.

CPU requests represent a **guaranteed minimum** of CPU time when the system is under load. A pod with a higher CPU request gets proportionally more CPU time during contention.

### CPU Limits: CFS Bandwidth Control and Throttling

CPU limits are enforced through CFS bandwidth control: `cpu.cfs_quota_us` and `cpu.cfs_period_us` cgroup settings. Every 100ms (the default CFS period), a container is allocated a CPU quota proportional to its limit. If the container exhausts its quota within the period, the kernel throttles it — the process is paused — until the next period begins.

For example, a container with `cpu: "500m"` limit gets a quota of 50ms every 100ms. If the container's processes run for more than 50ms of CPU time in any 100ms window, the container is throttled for the remainder of that window. This throttling is invisible at the application level — the process appears to run normally but is silently paused by the kernel.

The throttling calculation:

```
quota_us = limit_millicores * period_us / 1000
         = 500 * 100,000 / 1000
         = 50,000 us (50ms per 100ms period)
```

This has a crucial implication: **CPU throttling occurs even when the node has unused CPU capacity**. A container will be throttled whenever it exceeds its quota within a period, regardless of what other containers are doing. A single burst of computation (GC pause, connection spike, cache warm-up) that exhausts the period's quota causes throttling even if the node is at 20% overall utilization.

### CPU Throttling vs CPU Saturation

The distinction between throttling and saturation is important for diagnosis:

- **CPU saturation**: The node's total CPU is fully utilized. All pods compete for CPU and those with lower requests receive less. Solution: more nodes or fewer pods.
- **CPU throttling**: A container has exceeded its per-period quota but the node has available CPU. Only the throttled container is affected. Solution: raise the CPU limit or remove it.

Measuring throttling:

```bash
# Check throttled time for a specific container
kubectl exec <pod-name> -c <container-name> -- \
  cat /sys/fs/cgroup/cpu/cpu.stat

# Output:
# nr_periods 1247
# nr_throttled 89
# throttled_time 3820000000   # nanoseconds of throttle time
```

The `throttled_time` field accumulates nanoseconds of throttle time since pod start. A significant `nr_throttled / nr_periods` ratio (more than 5-10%) indicates excessive throttling.

### When to Set CPU Limits

CPU limits are controversial. Many experienced platform engineers argue for setting CPU requests without CPU limits for most workloads, for these reasons:

1. CPU is compressible — an over-consuming container does not cause other containers to fail, only to receive less CPU time.
2. CPU limits cause throttling even on underutilized nodes, increasing latency unnecessarily.
3. Setting `cpu: null` for limits creates a BestEffort or Burstable QoS class (depending on memory settings), but the CPU behavior is more flexible.

The counterargument is that without CPU limits, a single runaway process (infinite loop, recursive call stack, hot-loop bug) can consume all CPU on a node and starve other workloads.

A practical approach for most production workloads:
- Set CPU requests appropriately (use VPA recommendations as a starting point).
- For well-understood, stable workloads: omit CPU limits or set them to 3-4x the request.
- For user-facing services with latency SLOs: monitor throttling rates and remove or raise limits if throttling exceeds 5%.
- For batch workloads that are allowed to burst: set a higher limit (or none) with a lower request.

## Memory Requests vs Memory Limits: OOM Kill Territory

Memory is non-compressible. When a container exceeds its memory limit, the kernel OOM killer terminates the container's process immediately. There is no graceful warning, no signal handling — the process is killed.

### Memory Requests: Scheduling and Eviction

Memory requests serve three purposes:
1. **Scheduling**: Same as CPU — the scheduler uses requests to determine node fit.
2. **Eviction baseline**: The kubelet considers memory requests when deciding which pods to evict during node memory pressure.
3. **QoS class assignment**: Memory requests relative to limits determine whether a pod is Guaranteed, Burstable, or BestEffort (covered in the next section).

A container can use more memory than its request as long as the node has available memory. Memory requests do not cap memory usage.

### Memory Limits: OOM Kill Trigger

When a container's memory usage reaches its limit, the kernel OOM killer terminates the container. The kubelet then restarts the container according to the pod's `restartPolicy`.

The threshold is enforced via `memory.limit_in_bytes` in the container's cgroup. The kernel monitors the cgroup's memory usage continuously. When the usage exceeds the limit, the OOM killer selects a process in the cgroup and sends `SIGKILL`.

Setting memory limits too low is the most common cause of mysterious application restarts. The restart shows up in `kubectl get pods`:

```bash
kubectl get pods -n payments
# NAME                        READY   STATUS      RESTARTS   AGE
# payments-5b7f9d4c6-xkrp2   1/1     Running     7          2d
```

Seven restarts indicate repeated OOM kills. Investigate:

```bash
# Check the last termination reason
kubectl describe pod payments-5b7f9d4c6-xkrp2 -n payments | \
  grep -A5 "Last State"

# Output:
# Last State:     Terminated
#   Reason:       OOMKilled
#   Exit Code:    137
#   Started:      Mon, 06 May 2027 08:12:43 -0500
#   Finished:     Mon, 06 May 2027 08:14:17 -0500
```

Exit code 137 means the process received `SIGKILL` (128 + 9). An OOM kill always produces exit code 137.

### Memory Limit Setting Guidelines

Set memory limits based on actual usage observed over time. A common starting point:

1. Deploy without memory limits initially (or with very high limits).
2. Observe actual memory usage over 7-14 days using `container_memory_working_set_bytes`.
3. Set the memory limit to 2x the observed p95 peak memory usage.
4. Monitor for OOM kills and adjust upward if they occur.

The `container_memory_working_set_bytes` metric (not `container_memory_usage_bytes`) reflects the memory that cannot be reclaimed by the kernel — it is the most accurate indicator of how close a container is to its limit.

## QoS Classes

Kubernetes assigns one of three QoS classes to each pod based on how resources are specified. QoS classes affect eviction priority during node memory pressure and CPU scheduling priority.

### Guaranteed

A pod has the Guaranteed QoS class if and only if every container in the pod has:
- CPU requests and limits set, and equal to each other
- Memory requests and limits set, and equal to each other

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      resources:
        requests:
          cpu: "500m"
          memory: "256Mi"
        limits:
          cpu: "500m"     # Must equal request
          memory: "256Mi" # Must equal request
```

**Scheduling behavior**: The pod is scheduled on a node where the requested resources (= limited resources) are available.

**Eviction behavior**: Guaranteed pods are the last to be evicted during node memory pressure. The kubelet will evict BestEffort and Burstable pods first.

**CPU scheduling**: Because requests equal limits, the container has a fixed CPU quota. It cannot burst above its request and will not be throttled unless it exceeds its (equal) limit.

**Memory OOM**: A Guaranteed pod's memory limit equals its request. It will be OOM killed if memory usage exceeds the request/limit value, but it will not be evicted before other pods during pressure.

Guaranteed QoS is appropriate for:
- Latency-sensitive services with predictable resource usage.
- Databases and stateful workloads where memory usage is well-characterized.
- Critical infrastructure pods (DNS, monitoring agents).

### Burstable

A pod has the Burstable QoS class if it does not meet the Guaranteed criteria but has at least one container with a CPU or memory request or limit set:

```yaml
spec:
  containers:
    - name: app
      resources:
        requests:
          cpu: "200m"
          memory: "128Mi"
        limits:
          cpu: "1000m"    # Limit > request: burstable CPU
          memory: "512Mi" # Limit > request: burstable memory
```

**Scheduling behavior**: Scheduled based on requests. The pod may use more resources than it requests (up to limits) if the node has available capacity.

**Eviction behavior**: Evicted before Guaranteed pods during node memory pressure. The eviction order among Burstable pods prioritizes those that have exceeded their memory requests the most (as a percentage of the request).

**CPU scheduling**: The container receives guaranteed CPU proportional to its request and can burst up to its limit, subject to CFS bandwidth control.

Burstable QoS is appropriate for:
- Most production workloads with variable resource usage.
- Services that occasionally spike (on-demand processing, web servers with variable traffic).

### BestEffort

A pod has the BestEffort QoS class if no containers in the pod have any resource requests or limits set:

```yaml
spec:
  containers:
    - name: app
      # No resources field at all
      image: my-app:v1.0
```

**Scheduling behavior**: BestEffort pods are scheduled without resource reservation. They can be placed on any node regardless of its current resource usage.

**Eviction behavior**: Evicted first during node memory pressure, before Burstable and Guaranteed pods.

**CPU scheduling**: BestEffort pods receive CPU only when there is unused capacity. They have the lowest CFS share priority.

BestEffort QoS is appropriate only for:
- Development workloads where availability is not important.
- Batch jobs with no latency requirements that can tolerate eviction.

**Never use BestEffort QoS for production services.** Always set at least memory requests on production pods to avoid being the first eviction candidate during pressure events.

## CFS Bandwidth Throttling: Deep Dive

CPU throttling is one of the most common and hardest-to-diagnose performance issues in Kubernetes. Understanding the CFS bandwidth control mechanism enables accurate diagnosis.

### How CFS Bandwidth Control Works

The Linux kernel's CFS scheduler divides time into periods of `cpu.cfs_period_us` microseconds (default: 100,000 us = 100ms). Within each period, a cgroup is allowed to consume `cpu.cfs_quota_us` microseconds of CPU time across all its processes.

When a cgroup exhausts its quota, all processes in that cgroup are throttled (suspended) until the next period begins. The kernel tracks this via the `cpu.stat` file:

```
nr_periods:    total CFS periods observed
nr_throttled:  periods where throttling occurred
throttled_time: total nanoseconds of throttle time
```

### Throttling with Multi-Core Bursts

The per-period quota is global across all cores. A container with `cpu: "500m"` limit gets 50ms of quota per 100ms period. On a node with 8 cores, if the container spawns 8 threads that each run for 7ms simultaneously, the container consumes 56ms of CPU time in approximately 7ms of wall time — exceeding the 50ms quota — and the container is throttled for the remaining ~93ms of the period.

This burst throttling is why CPU throttling occurs even at low average CPU utilization. A Java application with a G1GC garbage collection pause, a Node.js cluster that spawns worker threads, or any application with bursty parallelism can trigger throttling frequently even with an average CPU usage well below the limit.

### Measuring Throttling with Prometheus

```promql
# CPU throttle ratio per container
rate(container_cpu_cfs_throttled_periods_total[5m])
/
rate(container_cpu_cfs_periods_total[5m])

# Containers with >20% throttle ratio
(
  rate(container_cpu_cfs_throttled_periods_total[5m])
  /
  rate(container_cpu_cfs_periods_total[5m])
) > 0.20

# Total throttled time per container (minutes)
rate(container_cpu_cfs_throttled_seconds_total[5m]) * 60
```

### Prometheus Alert for CPU Throttling

```yaml
groups:
  - name: cpu-throttling
    rules:
      - alert: ContainerCPUThrottling
        expr: |
          (
            rate(container_cpu_cfs_throttled_periods_total[5m])
            /
            rate(container_cpu_cfs_periods_total[5m])
          ) > 0.25
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} is CPU throttled"
          description: |
            Container {{ $labels.container }} is CPU throttled at
            {{ $value | humanizePercentage }} throttle ratio.
            Current CPU limit may be too low. Consider raising the limit
            or removing it for non-latency-sensitive workloads.
          runbook_url: "https://runbooks.support.tools/cpu-throttling"
```

### Resolving CPU Throttling

When throttling is excessive (>10-20% for latency-sensitive services):

1. **Raise the CPU limit**: The most direct fix. If the node has capacity, increasing the limit reduces throttling.

2. **Remove the CPU limit**: For trusted workloads in a controlled namespace, omitting the CPU limit allows unrestricted bursting. The pod becomes Burstable instead of Guaranteed (if memory limits remain).

3. **Set a higher CFS period** (node-level tuning): Reducing the period frequency reduces the burst sensitivity, but this is a node-level tuning that affects all containers on the node and is not recommended for most environments.

4. **Profile the application**: Some throttling is caused by application-level CPU spikes that could be reduced by optimization (better GC tuning, connection pool sizing, parallelism control).

## OOM Killer: Behavior and Debugging

### Linux OOM Killer Mechanics

When the kernel OOM killer fires for a cgroup, it selects a process within the cgroup to kill using an OOM score. The OOM score is calculated from:

- RSS (Resident Set Size) of the process
- Whether the process has set `oom_score_adj` (the `OOMScoreAdj` pod spec field)
- Whether the process is running as root

Higher OOM scores make a process more likely to be killed. The process with the highest OOM score in the cgroup is killed.

Kubernetes sets `oom_score_adj` based on QoS class:

- **Guaranteed pods**: `oom_score_adj = -997` (very low — last to be killed)
- **Burstable pods**: `oom_score_adj` proportional to request/limit ratio (from -999 to 999)
- **BestEffort pods**: `oom_score_adj = 1000` (maximum — first to be killed)

The formula for Burstable pods:

```
oom_score_adj = 1000 - (1000 * memory_request / node_allocatable_memory)
```

A container with a 256Mi memory request on a node with 64Gi allocatable memory gets:
```
oom_score_adj = 1000 - (1000 * 256 / 65536) = 1000 - 3.9 ≈ 996
```

A Burstable pod with a small memory request relative to node capacity has a high OOM score and will be killed early.

### Interpreting OOM Events

When an OOM kill occurs, the kernel logs it. To see OOM events:

```bash
# On the affected node
sudo dmesg | grep -i oom | tail -30

# Example output:
# [1234567.890123] oom-kill:constraint=CONSTRAINT_MEMCG,
#   nodemask=(null),cpuset=default,
#   mems_allowed=0,global_oom,task_memcg=/kubepods/
#   burstable/pod8f3c2a1b-4d7e-11ed-8a2f-0a580a812c2f/
#   e3a7f2c091b4d5e6,task=java,pid=12345,
#   uid=1000,tgid=12345,total_vm=524288,rss=131072,
#   pgtables_bytes=1048576,oom_score_adj=950
# [1234567.890456] Memory cgroup out of memory:
#   Killed process 12345 (java) total-vm:2097152kB,
#   anon-rss:524288kB, file-rss:0kB, shmem-rss:0kB,
#   UID:1000 pgtables:1024kB oom_score_adj:950
```

Key fields in the OOM log:
- `task`: The process name that was killed
- `rss`: Resident set size at time of kill (in pages, typically 4KB each)
- `oom_score_adj`: The OOM score adjustment
- `anon-rss`: Anonymous (heap/stack) memory usage in KB

### Diagnosing Memory Limits

To investigate appropriate memory limits, monitor actual memory usage:

```bash
# Current memory working set for all containers in a namespace
kubectl top pods -n payments --containers

# Detailed memory metrics via metrics-server
kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/payments/pods | \
  jq -r '.items[] | [.metadata.name,
    (.containers[] | [.name, .usage.memory] | @csv)] | @csv'
```

With Prometheus and cAdvisor:

```promql
# Memory working set (not swappable - closest to limit enforcement)
container_memory_working_set_bytes{namespace="payments"}

# Memory usage relative to limit (% of limit used)
(
  container_memory_working_set_bytes
  /
  container_spec_memory_limit_bytes
) * 100

# Containers using >80% of memory limit
(
  container_memory_working_set_bytes
  /
  container_spec_memory_limit_bytes
) > 0.80
```

### Prometheus Alerts for OOM

```yaml
groups:
  - name: oom-alerts
    rules:
      - alert: ContainerOOMKilled
        expr: |
          kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} was OOM killed"
          description: |
            Container {{ $labels.container }} was killed due to out-of-memory.
            Increase the container's memory limit or investigate memory leaks.

      - alert: ContainerMemoryNearLimit
        expr: |
          (
            container_memory_working_set_bytes
            /
            container_spec_memory_limit_bytes
          ) > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.container }} in {{ $labels.namespace }} is near memory limit"
          description: |
            Container {{ $labels.container }} is using
            {{ $value | humanizePercentage }} of its memory limit.
            Review memory usage trends and consider increasing the limit.

      - alert: PodFrequentlyOOMKilling
        expr: |
          increase(kube_pod_container_status_restarts_total[1h]) > 3
          and
          kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is frequently OOM killed"
          description: |
            Pod {{ $labels.pod }} has restarted more than 3 times in the last hour
            due to OOM kills. This indicates a memory leak or severely
            misconfigured memory limits.
```

## Ephemeral Storage

Kubernetes tracks and limits ephemeral storage (local writable storage used by container logs, emptyDir volumes, and container write layers). Like CPU and memory, ephemeral storage has requests and limits.

```yaml
spec:
  containers:
    - name: app
      resources:
        requests:
          ephemeral-storage: "1Gi"
        limits:
          ephemeral-storage: "5Gi"
```

When a container exceeds its ephemeral storage limit, the pod is evicted (not killed in-place like memory OOM). The pod transitions to `Evicted` status:

```bash
kubectl get pods -n batch
# NAME                       READY   STATUS    RESTARTS   AGE
# batch-job-7d9c8f-xkrp2     0/1     Evicted   0          2d
```

Inspect the eviction reason:

```bash
kubectl describe pod batch-job-7d9c8f-xkrp2 -n batch | grep -A5 "Reason\|Message"
# Reason:         Evicted
# Message:        The node was low on resource: ephemeral-storage.
#                 Threshold quantity: 10%, available: 8%.
```

Sources of ephemeral storage consumption:
- Container log files written to `/var/log/containers/`
- `emptyDir` volumes (for non-memory-backed emptyDirs)
- Container overlay filesystem write layers (installed packages, generated files)

For applications that write significant amounts of data, use `emptyDir` with `medium: Memory` for in-memory temporary storage, or mount a PersistentVolume for durable storage. Both avoid consuming ephemeral storage quota.

## Extended Resources

Kubernetes supports user-defined extended resources for hardware like GPUs, FPGAs, and network devices. Extended resources are advertised by node devices via the Device Plugin API and requested in pod specs like any other resource:

```yaml
spec:
  containers:
    - name: ml-training
      resources:
        requests:
          nvidia.com/gpu: "2"
          cpu: "8"
          memory: "32Gi"
        limits:
          nvidia.com/gpu: "2"
          cpu: "8"
          memory: "32Gi"
```

Extended resources must always have requests equal to limits (they cannot be overcommitted). A pod requesting 2 GPUs will only be scheduled on a node advertising at least 2 available GPUs.

Common extended resources in production:

| Resource | Plugin | Usage |
|----------|--------|-------|
| `nvidia.com/gpu` | NVIDIA GPU Operator | ML training, inference |
| `amd.com/gpu` | AMD GPU Device Plugin | ML workloads |
| `intel.com/sriov_netdevice` | SR-IOV Network Device Plugin | High-performance networking |
| `smarter-devices/i2c-8` | smarter-device-manager | IoT, embedded |
| `rdma/hca` | RDMA Device Plugin | HPC, InfiniBand |

## Vertical Pod Autoscaler (VPA) for Right-Sizing

The Vertical Pod Autoscaler recommends and optionally applies resource adjustments based on observed usage. It is the most practical tool for right-sizing resources in large clusters.

### VPA Modes

VPA operates in three modes:

- **Off**: VPA calculates and records recommendations but does not apply them. Use for auditing current allocations.
- **Initial**: VPA applies recommendations only when pods are created (not for running pods). Restarts are not triggered.
- **Auto**: VPA applies recommendations and restarts pods when changes are needed. Use with caution in production.

### VPA Configuration

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: checkout-vpa
  namespace: checkout
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout
  updatePolicy:
    updateMode: "Off"  # Start in Off mode for recommendations only
  resourcePolicy:
    containerPolicies:
      - containerName: checkout
        minAllowed:
          cpu: "100m"
          memory: "128Mi"
        maxAllowed:
          cpu: "4"
          memory: "4Gi"
        controlledResources:
          - cpu
          - memory
        controlledValues: RequestsAndLimits
```

Retrieve recommendations:

```bash
kubectl get vpa checkout-vpa -n checkout -o yaml | \
  yq '.status.recommendation.containerRecommendations[]'

# Output:
# containerName: checkout
# lowerBound:
#   cpu: 150m
#   memory: 196Mi
# target:
#   cpu: 300m
#   memory: 348Mi
# uncappedTarget:
#   cpu: 300m
#   memory: 348Mi
# upperBound:
#   cpu: 1200m
#   memory: 1Gi
```

The VPA recommends:
- `target`: The recommended value (what VPA would set in Auto mode).
- `lowerBound`: The minimum to prevent OOM or starvation.
- `upperBound`: The maximum — beyond this, over-provisioning without gain.

### VPA and HPA Interaction

VPA and HPA cannot both control the same metric on the same workload. If HPA scales on CPU utilization and VPA also modifies CPU requests, the two controllers will fight each other.

Safe combinations:

| HPA metric | VPA controlled resources |
|-----------|--------------------------|
| CPU utilization | Memory only |
| Memory utilization | CPU only |
| Custom metric (RPS, queue depth) | CPU and Memory |
| No HPA | CPU and Memory |

Configure VPA to control only non-HPA-scaled resources:

```yaml
spec:
  resourcePolicy:
    containerPolicies:
      - containerName: checkout
        controlledResources:
          - memory  # Only manage memory; HPA manages CPU-based scaling
```

### Bulk VPA Audit

To audit all namespaces for potential savings using VPA recommendations in Off mode, create VPAs for all Deployments:

```bash
for ns in $(kubectl get ns -o name | cut -d/ -f2); do
  for deploy in $(kubectl get deploy -n "$ns" -o name | cut -d/ -f2); do
    cat <<EOF | kubectl apply -f -
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: ${deploy}-vpa
  namespace: ${ns}
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${deploy}
  updatePolicy:
    updateMode: "Off"
EOF
  done
done

# After 7+ days of data collection, review recommendations
kubectl get vpa --all-namespaces -o json | \
  jq -r '.items[] | [.metadata.namespace, .metadata.name,
    .status.recommendation.containerRecommendations[]?.containerName,
    .status.recommendation.containerRecommendations[]?.target.cpu,
    .status.recommendation.containerRecommendations[]?.target.memory] |
    @csv'
```

## ResourceQuota and LimitRange

For multi-tenant clusters, `ResourceQuota` and `LimitRange` provide namespace-level governance.

### ResourceQuota

`ResourceQuota` caps total resource consumption within a namespace:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: payments
spec:
  hard:
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "80Gi"
    pods: "50"
    services: "20"
    persistentvolumeclaims: "20"
    count/deployments.apps: "30"
    requests.storage: "500Gi"
```

When a namespace has a `ResourceQuota` with CPU or memory limits, all pods must specify resource requests and limits. Pods without resources fail admission.

### LimitRange

`LimitRange` sets default resource requests and limits for containers that do not specify them, and can enforce minimum/maximum bounds:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: payments
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
        cpu: "4"
        memory: "8Gi"
      min:
        cpu: "50m"
        memory: "64Mi"
    - type: Pod
      max:
        cpu: "8"
        memory: "16Gi"
    - type: PersistentVolumeClaim
      max:
        storage: "50Gi"
      min:
        storage: "1Gi"
```

With this `LimitRange`, containers in the `payments` namespace that omit resources receive `cpu: "100m", memory: "128Mi"` as requests and `cpu: "500m", memory: "256Mi"` as limits by default. Containers requesting more than `cpu: "4"` or `memory: "8Gi"` are rejected.

`LimitRange` combined with `ResourceQuota` creates a complete governance framework: defaults ensure all pods have resources, bounds enforce maximum sizes, and quotas cap total namespace consumption.

## Practical Resource Configuration Workflow

A systematic approach to resource configuration for a new service:

### Step 1: Deploy with conservative limits and watch

```yaml
resources:
  requests:
    cpu: "100m"
    memory: "256Mi"
  limits:
    cpu: "2"         # High limit, not expected to be reached
    memory: "1Gi"    # High limit, watch for actual usage
```

### Step 2: Monitor after 24-48 hours of production traffic

```promql
# P95 memory working set
histogram_quantile(0.95,
  rate(container_memory_working_set_bytes_bucket{
    namespace="payments",
    container="checkout"
  }[24h])
)

# Average and P95 CPU usage
avg_over_time(
  rate(container_cpu_usage_seconds_total{
    namespace="payments",
    container="checkout"
  }[5m])[24h:5m]
)
```

### Step 3: Set requests based on observations

```
memory_request = p95_memory_working_set * 1.2
cpu_request = avg_cpu_usage * 1.5  # headroom for bursts
```

### Step 4: Check throttling rate

If throttle ratio > 10%, raise or remove CPU limit.

### Step 5: Validate QoS class

Decide whether Guaranteed or Burstable is appropriate for the workload and set requests and limits accordingly.

### Step 6: Create Prometheus alerts

Set alerts for OOM kills, high throttle rates, and memory approaching limits.

## Summary Reference: Resource Configuration Decisions

| Decision | Guidance |
|----------|----------|
| CPU request | Set to average CPU usage + 50% headroom for bursts |
| CPU limit | Start at 3-4x request; remove if throttling >10% for latency-sensitive services |
| Memory request | Set to p95 working set observed over 7+ days |
| Memory limit | Set to 2x p95 working set; increase if OOM kills occur |
| QoS class for critical services | Guaranteed (requests = limits) |
| QoS class for most services | Burstable (limits > requests) |
| QoS class for dev/batch | BestEffort (no resources) only for non-critical |
| OOM kill diagnosis | Check `exit code 137`, `Last State: OOMKilled` |
| CPU throttle diagnosis | Check `container_cpu_cfs_throttled_periods_total` |
| Right-sizing tool | VPA in `Off` mode for recommendations |
| Namespace governance | `ResourceQuota` + `LimitRange` for multi-tenant clusters |
