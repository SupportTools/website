---
title: "Linux Memory Overcommit: Virtual Memory, OOM Scores, and Container Memory Limits"
date: 2029-03-22T00:00:00-05:00
draft: false
tags: ["Linux", "Memory Management", "Kubernetes", "OOM Killer", "Containers", "Performance"]
categories:
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux memory overcommit policies, the OOM killer selection algorithm, and how container memory limits interact with cgroups, anonymous memory, and swap—critical knowledge for tuning Kubernetes node behavior."
more_link: "yes"
url: "/linux-memory-overcommit-virtual-memory-oom-scores-container-limits/"
---

When a Kubernetes node runs out of memory, the Linux OOM (Out-of-Memory) killer terminates processes. Which process it kills, why it kills it, and how cgroup memory limits interact with that decision is misunderstood by most platform engineers—until a critical production process is killed unexpectedly. This guide traces the complete path from application `malloc()` call through virtual memory, overcommit accounting, cgroup limits, and OOM score calculation.

Understanding this path is prerequisite to tuning Kubernetes QoS classes, configuring node memory eviction thresholds, and diagnosing intermittent OOM events on nodes that appear to have free memory.

<!--more-->

## Virtual Memory and Overcommit

### How malloc Works in Linux

When a Go, Java, or C application calls `malloc(100MB)`, the kernel does not immediately allocate 100 MB of physical RAM. It allocates 100 MB of **virtual address space** and marks the pages as demand-zero. Physical pages are only faulted in when the application actually writes to each page—a technique called **demand paging**.

```bash
# Observe virtual vs. resident memory for a running process
cat /proc/$(pgrep -n java)/status | grep -E "VmRSS|VmSize|VmSwap"
# VmSize:  4782152 kB  <- virtual address space
# VmRSS:   512408  kB  <- resident set size (physical pages)
# VmSwap:  204800  kB  <- pages moved to swap
```

The gap between VmSize and VmRSS is the memory that has been allocated but not yet touched. This is the foundation of overcommit: the kernel allows processes to reserve more virtual memory than there is physical memory.

### Overcommit Policies

The kernel behavior is controlled by `/proc/sys/vm/overcommit_memory`:

```bash
cat /proc/sys/vm/overcommit_memory
# 0  = heuristic overcommit (default)
# 1  = always overcommit (disable OOM on allocation)
# 2  = strict: never overcommit beyond overcommit_ratio
```

With policy `0`, the kernel applies a heuristic: allocations succeed unless the request is obviously larger than available physical + swap memory. With policy `1`, every allocation succeeds; the OOM killer only fires when pages are actually faulted in. With policy `2`, the kernel tracks committed memory and refuses allocations that would exceed `(RAM * overcommit_ratio / 100) + swap`.

```bash
# Check current committed memory vs. commit limit
cat /proc/meminfo | grep -E "Committed|CommitLimit"
# CommitLimit:  16777216 kB  <- max committable memory
# Committed_AS: 11534336 kB  <- currently committed
```

For container workloads, the default heuristic policy (`0`) is almost universally used because containers rely on the overcommit behavior to allow memory-mapped JVM metaspace, Go runtime bookkeeping, and shared libraries to use virtual space without consuming physical pages.

### Transparent Huge Pages and Memory Pressure

Transparent Huge Pages (THP) can cause unexpected memory usage spikes when the kernel promotes 4K pages to 2MB pages during compaction. On Kubernetes nodes, THP `always` mode is notorious for causing latency spikes and inflating apparent RSS.

```bash
# Check THP settings
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# Recommended for latency-sensitive workloads:
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Persist via sysctl (add to /etc/sysctl.d/99-kubernetes.conf):
# kernel.mm.transparent_hugepage.enabled = madvise
```

---

## The OOM Killer Algorithm

When the kernel cannot satisfy a page allocation request (during a page fault), it invokes the OOM killer. The algorithm selects a victim process by computing an `oom_score` for each process.

### oom_score Calculation

```bash
# View OOM scores for all processes
for pid in /proc/[0-9]*; do
  comm=$(cat "$pid/comm" 2>/dev/null)
  score=$(cat "$pid/oom_score" 2>/dev/null)
  adj=$(cat "$pid/oom_score_adj" 2>/dev/null)
  echo "$score $adj $comm"
done | sort -rn | head -20
```

The base score is `10 * (process_RSS_in_pages / total_memory_pages) * 1000`. The adjusted score adds `oom_score_adj`:

```
final_oom_score = base_score + oom_score_adj
```

`oom_score_adj` ranges from -1000 (never kill) to +1000 (always kill first). Setting it to -1000 exempts a process from OOM killing entirely.

### Adjusting OOM Priority for Critical Processes

```bash
# Protect the kubelet from OOM killing
echo -950 > /proc/$(pgrep kubelet)/oom_score_adj

# Verify
cat /proc/$(pgrep kubelet)/oom_score_adj
# -950
```

To make this persistent for systemd services:

```ini
# /etc/systemd/system/kubelet.service.d/oom.conf
[Service]
OOMScoreAdjust=-950
```

### Kernel OOM Decision Logging

```bash
# Watch OOM events in real time
journalctl -k -f | grep -E "oom|OOM|killed"

# Parse historical OOM kills from dmesg
dmesg --since "2029-03-22 00:00:00" | grep -A 20 "oom-kill"
```

Example OOM kill log entry:

```
[1234567.890] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),
  cpuset=crio-abc123,mems_allowed=0,
  oom_memcg=/kubepods/burstable/pod8f3a2c/abc123,
  task_memcg=/kubepods/burstable/pod8f3a2c/abc123,
  task=java,pid=18432,uid=1000
[1234567.891] Memory cgroup out of memory: Killed process 18432 (java)
  total-vm:4782152kB, anon-rss:1843200kB, file-rss:204800kB,
  shmem-rss:0kB, UID:1000 pgtables:8192kB oom_score_adj:0
```

The line `constraint=CONSTRAINT_MEMCG` indicates the OOM killer was invoked by a **cgroup memory limit breach**, not a global node memory shortage. This is the most common OOM cause in Kubernetes.

---

## cgroup Memory Limits and Kubernetes

### cgroup v2 Memory Controls

Modern Linux kernels (5.4+) use cgroup v2 as the default hierarchy. Kubernetes 1.25+ uses cgroup v2 on supported nodes.

```bash
# Check if cgroup v2 is active
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# Inspect memory limits for a pod
PODUID=8f3a2c1d-4b2e-4a1c-9d3f-1a2b3c4d5e6f
cat /sys/fs/cgroup/kubepods/burstable/pod${PODUID}/memory.max
# 536870912   <- 512 MiB limit

cat /sys/fs/cgroup/kubepods/burstable/pod${PODUID}/memory.current
# 489014272   <- current usage ~466 MiB

cat /sys/fs/cgroup/kubepods/burstable/pod${PODUID}/memory.stat
```

### Memory Accounting: What Counts Against the Limit

The cgroup limit applies to **anonymous memory** (heap, stack, mmap without a backing file) plus **page cache used by the cgroup**. File-backed pages (executable code, mmap'd libraries) are typically shared across cgroups but may be charged to the cgroup that first faults them in.

```bash
# Detailed breakdown for a container
CGPATH=/sys/fs/cgroup/kubepods/burstable/pod${PODUID}/container_id
awk '
  /^anon / {anon=$2}
  /^file / {file=$2}
  /^shmem / {shmem=$2}
  /^kernel_stack / {kstack=$2}
  END {
    printf "Anon:   %.1f MiB\n", anon/1048576
    printf "File:   %.1f MiB\n", file/1048576
    printf "Shmem:  %.1f MiB\n", shmem/1048576
    printf "KStack: %.1f MiB\n", kstack/1048576
  }
' "$CGPATH/memory.stat"
```

### Container Limits in Kubernetes and Their cgroup Mapping

```yaml
# Pod spec with explicit memory limits
resources:
  requests:
    memory: "256Mi"
  limits:
    memory: "512Mi"
```

Kubernetes writes `512 * 1024 * 1024 = 536870912` to `memory.max` in the container's cgroup. When usage hits this value, any further allocation triggers the cgroup OOM killer—not the global OOM killer. The cgroup OOM killer kills only processes within that cgroup (the container), leaving other containers and system daemons unaffected.

### Memory Requests and QoS Classes

| QoS Class | requests == limits | No requests/limits |
|-----------|-------------------|--------------------|
| Guaranteed | Both CPU and memory requests equal limits | No |
| Burstable | Memory request < limit | No |
| BestEffort | Neither set | Yes |

The QoS class directly controls the `oom_score_adj` set by the kubelet:

```bash
# Verify QoS OOM score adjustments
for pid in $(pgrep -a java | awk '{print $1}'); do
  echo "PID=$pid oom_score_adj=$(cat /proc/$pid/oom_score_adj)"
done
# Guaranteed pods: oom_score_adj = -997
# Burstable pods:  oom_score_adj = 2 to 999 (proportional to usage vs. request)
# BestEffort pods: oom_score_adj = 1000
```

This means BestEffort pods are always killed first, then Burstable pods ordered by how much they exceed their memory request, and Guaranteed pods are protected to the same degree as system daemons.

---

## Practical Tuning: Node Memory Configuration

### Kubelet Memory Eviction Thresholds

The kubelet proactively evicts pods before the node runs out of memory. Configure eviction thresholds to leave a safety margin:

```yaml
# /var/lib/kubelet/config.yaml
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
evictionSoft:
  memory.available: "500Mi"
evictionSoftGracePeriod:
  memory.available: "90s"
evictionMinimumReclaim:
  memory.available: "100Mi"
kubeReserved:
  cpu: "500m"
  memory: "1Gi"
systemReserved:
  cpu: "500m"
  memory: "500Mi"
```

With these settings:
- 1.5 GiB of node memory is reserved for kubelet and system daemons (never allocable to pods).
- Soft eviction starts when available memory drops below 500 MiB, giving pods 90 seconds to terminate gracefully.
- Hard eviction kills pods immediately when available memory drops below 200 MiB.

### Memory Pressure Testing

```bash
#!/usr/bin/env bash
# Stress test node memory eviction behavior using stress-ng.
# Run from a BestEffort pod to observe eviction ordering.
set -euo pipefail

NODE_MEMORY_GB=${1:-32}
STRESS_GB=$(( NODE_MEMORY_GB * 80 / 100 ))

kubectl run memory-stressor \
  --image=polinux/stress \
  --restart=Never \
  --rm \
  --attach \
  -- stress --vm 1 --vm-bytes "${STRESS_GB}g" --vm-keep --timeout 120s

# Monitor eviction events while the stressor runs:
kubectl get events --field-selector reason=Evicted -w
```

### Swap Configuration for Kubernetes Nodes (1.28+)

Kubernetes 1.28 graduated swap support to beta. To enable swap on a node:

```bash
# 1. Create a swap file
fallocate -l 8G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 2. Configure kubelet to use swap
cat >> /var/lib/kubelet/config.yaml <<EOF
memorySwap:
  swapBehavior: LimitedSwap
EOF

# 3. Restart kubelet
systemctl restart kubelet
```

With `LimitedSwap`, the container's swap limit is proportional to its memory limit: `swap_limit = (memory_limit / node_memory) * node_swap`. This prevents any single container from consuming all swap.

---

## Diagnosing OOM Events

### Automated OOM Detection Script

```bash
#!/usr/bin/env bash
# oom-report.sh — Parse kernel OOM events and correlate with pod names.
set -euo pipefail

echo "=== OOM Events (last 24 hours) ==="
journalctl -k --since "24 hours ago" \
  | grep -E "(oom-kill|Out of memory|Killed process)" \
  | while read -r line; do
    pid=$(echo "$line" | grep -oP 'pid=\K[0-9]+' || true)
    task=$(echo "$line" | grep -oP 'task=\K\S+' || true)
    cg=$(echo "$line" | grep -oP 'oom_memcg=\K\S+' || true)
    echo "Time: $(echo "$line" | awk '{print $1,$2,$3}')"
    echo "  Process: $task (PID: $pid)"
    echo "  cgroup: $cg"
    # Extract pod UID from cgroup path
    poduid=$(echo "$cg" | grep -oP 'pod[a-f0-9-]+' | head -1 || true)
    if [[ -n "$poduid" ]]; then
      podname=$(kubectl get pod --all-namespaces \
        -o jsonpath="{range .items[?(@.metadata.uid==\"${poduid#pod}\")]}{.metadata.namespace}/{.metadata.name}{end}" 2>/dev/null || true)
      echo "  Pod: ${podname:-unknown (pod may have been deleted)}"
    fi
    echo ""
  done
```

### Prometheus OOM Metrics

```yaml
# Alert on container OOM kills
groups:
  - name: memory
    rules:
      - alert: ContainerOOMKilled
        expr: |
          kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.container }} in pod {{ $labels.pod }} was OOM killed"
          description: "Namespace: {{ $labels.namespace }}. Increase memory limit or reduce memory usage."

      - alert: NodeMemoryPressure
        expr: kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.node }} is under memory pressure"
```

---

## Summary

Linux memory management for containerized workloads involves three interacting layers:

1. **Kernel overcommit**: Virtual memory allocations succeed even without physical backing; pages are only assigned on first write. This is fundamental to container efficiency.

2. **cgroup limits**: Container memory limits are enforced by the cgroup subsystem. When a container hits its limit, the cgroup OOM killer fires, isolating the impact to that container.

3. **OOM scoring**: When the entire node runs low on memory, the global OOM killer uses `oom_score_adj` to select victims. Kubernetes sets this based on QoS class, ensuring BestEffort pods die first and Guaranteed pods are protected.

Proper node configuration—reserved memory for system components, sensible eviction thresholds, and QoS-aligned resource requests—prevents the OOM killer from making decisions under pressure. When OOM events do occur, the `memory.stat` cgroup file and kernel journal provide the data needed for root cause analysis.
