---
title: "Understanding Kubernetes Memory Limits and the OOM Killer"
date: 2026-11-19T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Memory", "cgroups", "Container", "OOM", "Resource Limits"]
categories:
- Kubernetes
- Performance
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into how Kubernetes manages memory limits through cgroups and how the OOM killer operates to maintain system stability when pod memory limits are exceeded"
more_link: "yes"
url: "/kubernetes-memory-limits-oom-killer/"
---

One of the most common issues in Kubernetes deployments is pods being terminated unexpectedly due to memory constraints. Understanding how Kubernetes enforces memory limits and how the OOM (Out of Memory) killer works can help you better configure your workloads and troubleshoot these issues when they occur.

<!--more-->

# [Introduction to Container Memory Limits](#introduction)

When deploying applications in Kubernetes, setting appropriate resource limits is crucial for ensuring stable and predictable performance. Memory limits in particular play a vital role in preventing individual containers from consuming excessive resources and potentially destabilizing the entire node.

However, when containers exceed their memory limits, they may be terminated abruptly, leading to application downtime and potential data loss. These terminations are often caused by the Linux OOM killer, a mechanism designed to protect the system when memory resources are exhausted.

In this post, we'll explore:

1. How Kubernetes implements memory limits using Linux cgroups
2. How the OOM killer decides which processes to terminate
3. How to diagnose OOM killer events
4. Best practices for setting memory limits in Kubernetes

# [How Kubernetes Implements Memory Limits](#kubernetes-memory-limits)

## [From Pod Specification to cgroups](#pod-spec-to-cgroups)

When you define a memory limit in a Kubernetes pod specification, Kubernetes translates this configuration into Linux control groups (cgroups) settings on the node where the pod is scheduled:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: memory-demo
spec:
  containers:
  - name: memory-demo-container
    image: nginx
    resources:
      limits:
        memory: "200Mi"
      requests:
        memory: "100Mi"
```

In this example, we're setting a memory limit of 200MiB for our container. When this pod is scheduled on a node, Kubernetes creates a cgroup for the pod and configures its memory limit to exactly 200MiB (209715200 bytes).

## [Verifying cgroup Settings](#verifying-cgroup-settings)

To see how Kubernetes configures cgroups for memory limits, we can run a simple experiment. Let's create a pod with a specific memory limit:

```bash
kubectl run memory-test --image=ubuntu --rm -it --limits='memory=123Mi' -- /bin/bash
```

This command creates a pod with a memory limit of 123MiB. On the node where this pod is running, we can examine the cgroup configuration to verify the memory limit:

```bash
# First, find the pod's UID
POD_UID=$(kubectl get pod memory-test -o jsonpath='{.metadata.uid}')

# Then, inspect the cgroup memory limit
cat /sys/fs/cgroup/memory/kubepods/burstable/pod${POD_UID}/memory.limit_in_bytes
```

The output should be `128974848`, which is exactly 123MiB (123 × 1024 × 1024 bytes). This confirms that Kubernetes directly translates the memory limit from the pod specification to the cgroup configuration.

# [The OOM Killer in Action](#oom-killer-in-action)

## [How the OOM Killer Works](#how-oom-killer-works)

The OOM killer is a mechanism in the Linux kernel that terminates processes when the system or a cgroup is running out of memory. It selects which processes to kill based on a scoring system, with the goal of freeing up memory while minimizing impact on system stability.

When a container exceeds its memory limit:

1. The cgroup controller detects the violation
2. The kernel invokes the OOM killer
3. The OOM killer calculates scores for processes within the cgroup
4. The process with the highest score is terminated

## [Understanding OOM Scores](#oom-scores)

The OOM killer assigns a score to each process based on several factors:

1. **Memory consumption**: Processes using more memory get higher scores
2. **Process age**: Newer processes get higher scores
3. **OOM score adjustment**: A value that can be set to influence the OOM killer's decision

In Kubernetes, the OOM score adjustment (`oom_score_adj`) is particularly important. Kubernetes sets this value for container processes based on the following formula:

```
min(max(2, 1000 - (1000 * memoryRequestBytes) / machineMemoryCapacityBytes), 999)
```

This formula ensures that:
- Containers with higher memory requests relative to node capacity are less likely to be killed
- System processes critical to node functionality are protected
- Containers are more likely to be killed than the kubelet or other system processes

## [Demonstrating the OOM Killer](#demonstrating-oom-killer)

Let's demonstrate how the OOM killer works with a practical example. We'll create a pod with a memory limit of 123MiB and run a stress test that exceeds this limit:

```bash
# Create a pod with 123Mi memory limit
kubectl run memory-test --image=ubuntu --rm -it --limits='memory=123Mi' -- /bin/bash

# Inside the pod, install the stress tool
apt-get update && apt-get install -y stress

# Run a stress test with 100MB of memory usage
stress --vm 1 --vm-bytes 100M &

# Run another stress test that will push us over the limit
stress --vm 1 --vm-bytes 50M
```

When we run the second stress test, the combined memory usage exceeds our 123MiB limit, and the OOM killer terminates one of the processes.

## [Analyzing OOM Killer Logs](#analyzing-logs)

When the OOM killer terminates a process, it logs the event to the system logs. On the node where the pod was running, we can examine these logs:

```bash
dmesg | grep -i "Out of memory"
```

The logs will contain valuable information about why the OOM killer was invoked and which process was terminated:

```
[78632.192520] stress invoked oom-killer: gfp_mask=0x14000c0(GFP_KERNEL), nodemask=(null), order=0, oom_score_adj=939
[78632.192740] Memory cgroup out of memory: Kill process 12345 (stress) score 1718 or sacrifice child
[78632.192850] Killed process 12345 (stress) total-vm:110644kB, anon-rss:99620kB, file-rss:192kB, shmem-rss:0kB
```

Let's break down this output:

1. `stress invoked oom-killer`: The process that triggered the OOM condition
2. `oom_score_adj=939`: The Kubernetes-assigned OOM score adjustment
3. `Memory cgroup out of memory`: Indicates this is a cgroup OOM, not a system-wide OOM
4. `Kill process 12345 (stress) score 1718`: The process that was selected for termination and its OOM score
5. Memory statistics for the terminated process

This information is crucial for diagnosing why specific containers are being terminated when memory limits are exceeded.

# [Understanding OOM Score Adjustments in Kubernetes](#oom-score-adjustments)

Kubernetes assigns different `oom_score_adj` values to different types of processes:

| Process Type | oom_score_adj | Description |
|--------------|---------------|-------------|
| Critical system pods | -999 | Critical system pods like DNS |
| Kubelet, Docker | -999 to -1000 | Node-level components |
| Guaranteed pods | -998 | Pods with equal requests and limits |
| Burstable pods | 2 to 999 | Formula-based, depends on request |
| BestEffort pods | 1000 | Pods with no requests or limits |

This hierarchy ensures that when memory pressure occurs:
1. BestEffort pods are killed first
2. Burstable pods with low requests relative to node capacity are killed next
3. Burstable pods with high requests are killed after that
4. Guaranteed pods are killed only if necessary
5. System components are protected

## [OOM Score Adjustment Calculation](#oom-score-calculation)

Let's verify the formula for a burstable pod. Using our previous example with a 123MiB memory request:

```
min(max(2, 1000 - (1000 * 123MiB) / nodeMemoryCapacity), 999)
```

If our node has 4GiB of memory:
```
min(max(2, 1000 - (1000 * 123 * 1024 * 1024) / (4 * 1024 * 1024 * 1024)), 999)
= min(max(2, 1000 - (1000 * 123) / (4 * 1024)), 999)
= min(max(2, 1000 - 30.0), 999)
= min(max(2, 970), 999)
= min(970, 999)
= 970
```

The `oom_score_adj` would be approximately 970 for this pod. This value will be used by the OOM killer when determining which processes to terminate under memory pressure.

# [Best Practices for Managing Memory in Kubernetes](#best-practices)

## [Setting Appropriate Memory Limits and Requests](#setting-memory-limits)

1. **Measure actual usage**: Use tools like metrics-server, Prometheus, or resource usage tracking to understand your application's memory requirements.

2. **Set requests based on average usage**: Your memory request should be set to cover the average memory usage of your application.

3. **Set limits based on peak usage**: Memory limits should accommodate peak usage plus a buffer, but not be unnecessarily high.

4. **Consider memory growth patterns**: Some applications may experience memory growth over time due to caches or memory leaks. Set limits accordingly.

5. **Use the same value for requests and limits for critical applications**: This ensures Kubernetes treats these pods as Guaranteed quality of service, reducing the risk of OOM kills.

## [Handling Memory-Intensive Applications](#memory-intensive-apps)

For applications that are memory-intensive or have unpredictable memory usage:

1. **Implement graceful degradation**: Design applications to handle low-memory conditions by clearing caches or reducing workload.

2. **Set up proper health and readiness probes**: These help Kubernetes detect and restart unhealthy containers before they cause problems.

3. **Consider using HorizontalPodAutoscaler**: Scale out instead of up for memory-intensive workloads.

4. **Implement proper resource monitoring**: Set up alerts for when pods approach their memory limits.

## [Diagnosing OOM Issues](#diagnosing-oom)

When troubleshooting OOM kills:

1. **Check container logs**: Look for any indications of memory issues before the container was terminated.

2. **Examine node logs**: Use `journalctl -k` or `dmesg` to view kernel logs related to OOM kills.

3. **Review memory metrics**: Use monitoring tools to understand memory usage patterns over time.

4. **Check for memory leaks**: Use profiling tools to identify potential memory leaks in your application.

5. **Implement proper JVM settings**: For Java applications, consider setting `-XX:+ExitOnOutOfMemoryError` to fail fast and `-XX:+HeapDumpOnOutOfMemoryError` to generate heap dumps for analysis.

# [Advanced Memory Management in Kubernetes](#advanced-memory-management)

## [Understanding Container Memory Types](#container-memory-types)

When working with container memory, it's important to understand different types of memory:

1. **Resident Set Size (RSS)**: The portion of memory occupied by a process that is held in RAM.

2. **Cache**: File-backed pages that can be reclaimed if memory pressure increases.

3. **Swap**: If configured, allows the kernel to move less-used memory pages to disk.

In Kubernetes, by default, the memory limit applies to the sum of RSS and cache. If a container's memory usage (RSS + cache) exceeds its limit, the OOM killer will be invoked.

## [Memory Quality of Service in Kubernetes](#memory-qos)

Kubernetes defines three Quality of Service (QoS) classes that affect how the OOM killer treats pods:

1. **Guaranteed**: Memory requests equal memory limits. These pods have an `oom_score_adj` of -998 and are unlikely to be killed.

2. **Burstable**: Memory requests are set but less than limits. These pods have an `oom_score_adj` between 2 and 999, calculated based on their memory request relative to node capacity.

3. **BestEffort**: No memory requests or limits specified. These pods have an `oom_score_adj` of 1000 and are the first to be killed under memory pressure.

## [Working with cgroup v2](#cgroup-v2)

Newer Linux distributions use cgroup v2, which has a slightly different interface for memory management. In cgroup v2:

- The memory controller is unified with other controllers
- The memory limit is set using `memory.max` instead of `memory.limit_in_bytes`
- Memory usage tracking is more detailed

Kubernetes supports cgroup v2, and the principles of memory limits and OOM killing remain the same, but the implementation details differ slightly.

# [Conclusion](#conclusion)

Understanding how Kubernetes implements memory limits and how the OOM killer works is essential for building reliable and stable containerized applications. By setting appropriate memory limits, monitoring memory usage, and designing applications to handle memory constraints gracefully, you can minimize unexpected terminations and improve the overall reliability of your Kubernetes workloads.

Key takeaways:

1. Kubernetes uses Linux cgroups to enforce memory limits for containers.
2. When a container exceeds its memory limit, the Linux OOM killer terminates processes based on their OOM scores.
3. Kubernetes adjusts OOM scores based on pod QoS class and resource requests relative to node capacity.
4. Setting appropriate memory requests and limits based on actual usage patterns is crucial for stability.
5. Monitoring memory usage and implementing proper error handling can help prevent and troubleshoot OOM issues.

By applying these principles, you can more effectively manage memory in your Kubernetes environments and reduce the frequency of unexpected OOM terminations.