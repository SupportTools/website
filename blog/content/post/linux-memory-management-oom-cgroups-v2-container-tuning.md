---
title: "Linux Memory Management: OOM Killer, cgroups v2, and Container Memory Tuning"
date: 2028-12-12T00:00:00-05:00
draft: false
tags: ["Linux", "Memory Management", "OOM Killer", "cgroups", "Kubernetes", "Performance"]
categories:
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise deep-dive into Linux memory management covering the OOM killer algorithm, cgroups v2 memory controllers, container memory accounting, and production tuning strategies for Kubernetes workloads."
more_link: "yes"
url: "/linux-memory-management-oom-cgroups-v2-container-tuning/"
---

Memory pressure events in Kubernetes clusters frequently manifest as mysterious pod evictions, `OOMKilled` container exits, and degraded node performance that resist conventional debugging. Understanding the Linux memory management subsystem — the mechanisms that govern page allocation, reclamation, and process termination under pressure — is essential for diagnosing and preventing these failure modes in production.

This guide covers the complete Linux memory management stack from the kernel's perspective: virtual memory addressing, the page allocator, the page cache and reclaim mechanisms, the OOM killer decision algorithm, cgroups v2 memory accounting, and the practical tuning parameters that control behavior under pressure in containerized environments.

<!--more-->

## Virtual Memory Architecture

The Linux kernel provides each process with a private virtual address space. On x86-64, this space spans 128 terabytes (47-bit addressing) for userspace, with the kernel occupying a separate 128TB range. The hardware Memory Management Unit (MMU) translates virtual addresses to physical addresses using page tables.

**Page granularity**: The fundamental unit is the 4KB page. Large pages (2MB "hugepages" or 1GB) reduce TLB pressure for memory-intensive workloads.

**Virtual memory areas (VMAs)**: The kernel tracks memory regions as `vm_area_struct` entries per process. Each VMA represents a contiguous range of virtual addresses with uniform permissions and backing (anonymous, file-backed, or special).

```bash
# Inspect VMAs for a running process (container PID)
cat /proc/$(pgrep payments-api | head -1)/maps | head -30

# Human-readable memory statistics
cat /proc/$(pgrep payments-api | head -1)/status | grep -E "VmRSS|VmSize|VmPeak|VmSwap|RssAnon|RssFile|RssShmem"
```

The `VmRSS` (Resident Set Size) value shows physical memory currently mapped. `VmSize` shows the total virtual address space, which is typically much larger due to memory-mapped files and reserved-but-not-faulted regions.

## Memory Zones and the Page Allocator

The Linux kernel divides physical memory into zones based on hardware constraints:

- `ZONE_DMA`: First 16MB, required by legacy ISA DMA devices
- `ZONE_DMA32`: First 4GB, for devices that can only address 32-bit physical addresses
- `ZONE_NORMAL`: Remaining RAM, directly mappable by the kernel
- `ZONE_HIGHMEM`: RAM above 896MB on 32-bit systems (obsolete on 64-bit)

```bash
# View zone statistics
cat /proc/zoneinfo | grep -E "^Node|zone |nr_free|nr_inactive|nr_active"

# View overall memory usage
cat /proc/meminfo
```

Key `/proc/meminfo` fields:

| Field | Description |
|-------|-------------|
| `MemTotal` | Total usable physical RAM |
| `MemFree` | Completely unused pages |
| `MemAvailable` | Estimated available for applications (includes reclaimable) |
| `Buffers` | Raw disk read cache |
| `Cached` | Page cache (file-backed pages) |
| `SwapCached` | Pages swapped in but swap space not yet freed |
| `Active(anon)` | Recently used anonymous pages (heap, stack) |
| `Inactive(anon)` | Less-recently used anonymous pages |
| `Active(file)` | Recently used file-backed pages |
| `Inactive(file)` | Less-recently used file-backed pages |
| `Slab` | Kernel slab allocator usage |
| `SReclaimable` | Reclaimable slab memory (dentries, inodes) |

The `MemAvailable` figure is the most useful for capacity planning. It accounts for the page cache and reclaimable kernel memory, providing a realistic estimate of how much memory applications can allocate before triggering reclaim or OOM conditions.

## The Page Cache and Reclaim

Linux aggressively uses free memory as a page cache for file I/O. When a process reads from disk, the kernel stores the data in the page cache. Subsequent reads serve from memory. This is why a server may show near-zero `MemFree` with high `Cached` — the memory is productively used, not wasted.

Under memory pressure, the kernel runs the **kswapd** daemon and the per-CPU **kcompactd** to reclaim pages. The reclaim mechanism uses a two-list LRU (Least Recently Used):

1. **Active list**: Recently accessed pages
2. **Inactive list**: Less recently accessed, candidates for reclaim

Pages move from active to inactive under pressure. File-backed pages can be reclaimed by simply dropping them from memory (they can be reread from disk). Anonymous pages (heap, stack) must be written to swap before reclaim.

### The `vm.swappiness` Parameter

`vm.swappiness` (0-200, default 60) controls the kernel's preference for reclaiming anonymous pages via swap versus reclaiming page cache:

- **0**: Strongly prefer reclaiming page cache; swap only when necessary
- **60**: Balance between swap and page cache reclaim
- **100**: Treat anonymous and file pages equally
- **200**: Aggressively swap anonymous pages to preserve page cache

For containerized workloads, the recommended setting depends on workload type:

```bash
# For memory-constrained nodes where swap is undesirable (most Kubernetes nodes)
sysctl -w vm.swappiness=10

# Make permanent
echo "vm.swappiness = 10" >> /etc/sysctl.d/99-kubernetes-memory.conf
sysctl -p /etc/sysctl.d/99-kubernetes-memory.conf
```

Note: Kubernetes nodes with swap disabled (`/proc/swaps` empty) effectively ignore `vm.swappiness`. Kubernetes v1.28+ supports swap via the `NodeSwap` feature gate, but requires careful configuration.

## The OOM Killer

When the kernel cannot reclaim enough memory to satisfy an allocation request, it invokes the **Out-of-Memory Killer**. The OOM killer selects a process to terminate based on an `oom_score` calculated for each process.

### OOM Score Calculation

The `oom_score` (0-1000) is proportional to the process's memory usage relative to total system memory:

```
oom_score ≈ (process RSS / total memory) * 1000
```

This base score is then adjusted by `oom_score_adj` (-1000 to +1000), which is readable and writable at `/proc/<pid>/oom_score_adj`:

- **-1000**: Process is OOM-exempt (never killed)
- **-500 to -1**: Reduce likelihood of being killed
- **0**: Default — no adjustment
- **+1 to +1000**: Increase likelihood of being killed

```bash
# View OOM scores for processes
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  [ -f "/proc/$pid/oom_score" ] || continue
  score=$(cat /proc/$pid/oom_score 2>/dev/null)
  adj=$(cat /proc/$pid/oom_score_adj 2>/dev/null)
  comm=$(cat /proc/$pid/comm 2>/dev/null)
  echo "$score $adj $comm"
done | sort -rn | head -20
```

### Kubernetes OOM Score Assignment

The kubelet automatically sets `oom_score_adj` for containers based on QoS class:

| QoS Class | oom_score_adj | Trigger |
|-----------|---------------|---------|
| Guaranteed | -997 | Requests == Limits for all containers |
| Burstable | 2 to 999 | Requests < Limits or only Requests set |
| BestEffort | 1000 | No Requests or Limits set |

Burstable pods get `oom_score_adj` = `min(max(2, 1000 - (1000 × requests.memory / machine.memory)), 999)`.

The kubelet itself runs with `oom_score_adj = -999`, and critical system processes (Docker, containerd) run at -999 to prevent them from being killed before user workloads.

### OOM Kill Events

```bash
# View recent OOM kill events from the kernel log
dmesg | grep -i "oom\|killed process" | tail -50

# Or with systemd journal (persists across reboots)
journalctl -k | grep -i "out of memory\|oom_kill" | tail -50

# In Kubernetes, check pod events for OOMKilled exits
kubectl get events --all-namespaces \
  --field-selector reason=OOMKilled \
  --sort-by='.metadata.creationTimestamp'

# Check container exit reason
kubectl get pod payments-api-7f9d8b5c4-xk9j2 -n payments \
  -o jsonpath='{.status.containerStatuses[].lastState.terminated}'
```

An `OOMKilled` exit with `exitCode: 137` (SIGKILL) indicates the container exceeded its memory limit and was killed by the cgroup OOM killer, not the system OOM killer.

## cgroups v2 Memory Controller

Control groups version 2 (cgroups v2, aka cgroupsv2 or the "unified hierarchy") is the default on kernels 5.2+ and all major Linux distributions since 2022. It provides a completely redesigned memory accounting and control API.

### Verifying cgroups v2 Mode

```bash
# Check if running cgroupsv2 (unified hierarchy)
stat /sys/fs/cgroup/cgroup.controllers
mount | grep cgroup

# On cgroupsv2, this file exists and contains available controllers
cat /sys/fs/cgroup/cgroup.controllers
# Output: cpuset cpu io memory hugetlb pids rdma misc
```

### cgroups v2 Memory Control Files

For each cgroup, the following files control memory behavior:

```bash
# Path for a Kubernetes pod: /sys/fs/cgroup/kubepods/burstable/<pod-uid>/<container-id>/
CGROUP_PATH="/sys/fs/cgroup/kubepods/burstable/pod$(kubectl get pod payments-api-7f9d8b5c4-xk9j2 -n payments -o jsonpath='{.metadata.uid}')"

# View memory limit
cat "$CGROUP_PATH/memory.max"         # Hard limit (cgroupsv2)
# In bytes, or "max" if unlimited

# View current memory usage
cat "$CGROUP_PATH/memory.current"     # Current usage in bytes

# View detailed memory statistics
cat "$CGROUP_PATH/memory.stat"
```

Key `memory.stat` fields:

| Field | Description |
|-------|-------------|
| `anon` | Anonymous memory usage (heap, stack, private mappings) |
| `file` | File-backed memory (page cache within this cgroup) |
| `kernel` | Kernel memory used by this cgroup (slab, sock, etc.) |
| `pgfault` | Minor page fault count |
| `pgmajfault` | Major page fault count (required disk I/O) |
| `oom_kill` | Number of OOM kills within this cgroup |
| `memory_throttled_usec` | Time throttled due to memory.high limit |

### Memory Limits in cgroupsv2

cgroups v2 introduces a two-threshold model:

- **`memory.high`** (Kubernetes: no direct mapping, set by kubelet heuristic): Soft limit. When exceeded, the kernel throttles the cgroup by aggressively reclaiming memory before allocations complete. Processes slow down but are not killed.
- **`memory.max`** (Kubernetes `limits.memory`): Hard limit. When exceeded, the cgroup OOM killer activates.

This two-threshold model allows Kubernetes to implement memory throttling before OOM killing, reducing the number of pod evictions.

```bash
# View memory limits for a container
CONTAINER_ID=$(kubectl get pod payments-api-7f9d8b5c4-xk9j2 -n payments \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | cut -d/ -f3)

CGROUP_PATH=$(find /sys/fs/cgroup -name "${CONTAINER_ID:0:12}*" -type d 2>/dev/null | head -1)

echo "Memory max (hard limit): $(cat $CGROUP_PATH/memory.max)"
echo "Memory high (soft limit): $(cat $CGROUP_PATH/memory.high)"
echo "Memory current: $(cat $CGROUP_PATH/memory.current)"
echo "OOM kill count: $(cat $CGROUP_PATH/memory.events | grep oom_kill)"
```

## Container Memory Accounting Nuances

### What Counts Against container memory limit

Kubernetes resource limits map to `memory.max` in the cgroup. The following memory types count against this limit:

- Anonymous memory (heap, stack, shared memory via `mmap` with `MAP_ANON`)
- Tmpfs mounts (including `/tmp` and `/dev/shm`)
- Kernel memory attributed to the cgroup (sockets, kernel stacks)
- Page cache used by files opened by processes in the cgroup

Note: **Shared libraries** loaded via `mmap` of shared files (`.so` files) count as `file` memory. When multiple containers load the same library, each container's cgroup may show separate file page cache usage, but the physical pages are shared. This means per-container memory accounting can appear higher than actual physical memory consumption.

### The Working Set Problem

A common operational mistake is setting container memory limits equal to the application's steady-state RSS. Production workloads have memory spikes:

- Bulk operations that allocate large intermediate buffers
- Garbage collection pauses that delay freeing memory
- Traffic spikes that increase in-flight request count
- Startup allocations for connection pools, caches, and JIT compilation

A safe practice is setting limits at 1.5x-2x the steady-state working set, observed over at least 7 days of production traffic:

```bash
# Query Prometheus for the 95th percentile memory usage over 7 days
# Run this against your Prometheus instance
curl -s 'http://prometheus:9090/api/v1/query' \
  --data-urlencode 'query=quantile_over_time(0.95, container_memory_working_set_bytes{namespace="payments",container="payments-api"}[7d])' | \
  jq '.data.result[].value[1]' | \
  awk '{printf "95th percentile memory: %.0f MB\n", $1/1024/1024}'
```

### Memory Working Set vs RSS

Kubernetes eviction and autoscaling use `container_memory_working_set_bytes`, not `container_memory_rss`. The working set is:

```
working_set = memory.usage_in_bytes - inactive_file_cache
```

The inactive file cache is page cache that has not been recently accessed and can be reclaimed without swap. Subtracting it gives a more conservative estimate of memory the container is actively using.

## Kernel Parameters for Memory Tuning

### Transparent Hugepages

THP (Transparent Hugepages) automatically promotes aligned 4KB page groups to 2MB pages, reducing TLB misses. The tradeoff is occasional `khugepaged` scanning overhead and allocation latency:

```bash
# Check current THP mode
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# For most Kubernetes workloads, madvise is preferred:
# Applications that want THP call madvise(MADV_HUGEPAGE), others get 4KB pages
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Make permanent via systemd
cat > /etc/systemd/system/thp-madvise.service << 'EOF'
[Unit]
Description=Set THP to madvise mode
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'echo madvise > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag'

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now thp-madvise
```

### Memory Overcommit

Linux allows processes to allocate more virtual memory than physical RAM, relying on the observation that allocations are rarely fully used. The `vm.overcommit_memory` parameter controls this:

- **0** (default): Heuristic overcommit — allow "reasonable" overcommit
- **1**: Always allow overcommit — useful for specific workloads but dangerous in production
- **2**: No overcommit — only allow allocations up to `vm.overcommit_ratio` % of RAM plus swap

```bash
# Check current setting
sysctl vm.overcommit_memory
sysctl vm.overcommit_ratio

# For Kubernetes nodes, the default (0) is appropriate
# Setting to 2 can cause unexpected allocation failures in burst scenarios
```

### Dirty Page Writeback

Dirty pages (modified file-backed pages not yet written to disk) accumulate during periods of high write I/O. The kernel flushes them based on thresholds:

```bash
# Current dirty page parameters
sysctl vm.dirty_ratio          # Hard limit: force writeback at this % of RAM
sysctl vm.dirty_background_ratio  # Soft limit: start background writeback

# For write-heavy workloads (e.g., nodes running etcd or databases):
# Reduce these to prevent large writeback bursts
sysctl -w vm.dirty_ratio=15
sysctl -w vm.dirty_background_ratio=5
sysctl -w vm.dirty_writeback_centisecs=500  # Flush every 5 seconds
```

## Kubernetes Memory Configuration Best Practices

### Setting Appropriate Requests and Limits

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments
spec:
  template:
    spec:
      containers:
      - name: payments-api
        image: registry.example.com/payments-api:v2.14.0
        resources:
          requests:
            # Request = steady-state working set (p50 over 7 days)
            # This determines scheduling placement
            memory: "256Mi"
            cpu: "250m"
          limits:
            # Limit = burst-capable maximum (p99.9 over 7 days, with headroom)
            # This triggers OOM kill if exceeded
            memory: "512Mi"
            cpu: "1000m"
```

### JVM Memory Tuning in Containers

Java applications have historically misread total system memory rather than cgroup limits when sizing heap. Modern JVMs (11+) are container-aware:

```yaml
containers:
- name: java-service
  image: registry.example.com/java-service:v3.2.0
  env:
  - name: JAVA_OPTS
    value: >-
      -XX:+UseContainerSupport
      -XX:MaxRAMPercentage=75.0
      -XX:InitialRAMPercentage=50.0
      -XX:+UseG1GC
      -XX:MaxGCPauseMillis=200
      -XX:+ExitOnOutOfMemoryError
      -XX:+HeapDumpOnOutOfMemoryError
      -XX:HeapDumpPath=/tmp/heapdump.hprof
  resources:
    requests:
      memory: "1Gi"
    limits:
      memory: "2Gi"
```

`-XX:MaxRAMPercentage=75.0` sets the JVM heap to 75% of the cgroup memory limit (75% of 2Gi = 1.5Gi). The remaining 25% accommodates the JVM's off-heap overhead (metaspace, direct buffers, native code, thread stacks).

### Memory Limit Recommendations by Language Runtime

| Runtime | Recommended Limit/Request Ratio | Notes |
|---------|----------------------------------|-------|
| Go | 1.5:1 to 2:1 | GC can cause temporary doubling of heap |
| Java (G1GC) | 1.5:1 | G1GC overhead is typically 10-15% |
| Node.js | 1.5:1 | V8 heap overhead + native modules |
| Python | 1.25:1 | Generally predictable memory usage |
| Rust | 1.2:1 | Minimal runtime overhead |

## Monitoring Memory Health

### Prometheus Alerts for Memory Pressure

```yaml
groups:
- name: memory-pressure
  rules:
  - alert: ContainerNearMemoryLimit
    expr: |
      (
        container_memory_working_set_bytes{container!=""}
        /
        container_spec_memory_limit_bytes{container!=""}
      ) > 0.85
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} is using >85% of memory limit"
      description: "Current usage: {{ $value | humanizePercentage }} of limit"

  - alert: ContainerOOMKilled
    expr: |
      increase(kube_pod_container_status_restarts_total[15m]) > 0
      and on(pod, namespace, container)
      kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
    labels:
      severity: critical
    annotations:
      summary: "Container {{ $labels.container }} was OOMKilled in {{ $labels.namespace }}/{{ $labels.pod }}"

  - alert: NodeMemoryPressure
    expr: |
      (
        node_memory_MemAvailable_bytes
        /
        node_memory_MemTotal_bytes
      ) < 0.10
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Node {{ $labels.instance }} has less than 10% memory available"
      description: "Available: {{ $value | humanizePercentage }}"
```

### Diagnosing Memory Issues with /proc

```bash
#!/usr/bin/env bash
# memory-diagnosis.sh — Quick node memory health check

echo "=== System Memory Overview ==="
free -h
echo ""

echo "=== Top Memory Consumers ==="
ps aux --sort=-%mem | head -15
echo ""

echo "=== Slab Memory Usage ==="
slabtop -o | head -20
echo ""

echo "=== Recent OOM Events ==="
dmesg | grep -i "out of memory\|oom_kill" | tail -10
echo ""

echo "=== Page Reclaim Statistics ==="
vmstat -s | grep -E "pages paged|pages swapped|pages free|pages inactive|pages active"
echo ""

echo "=== cgroup Memory Pressure Events ==="
find /sys/fs/cgroup -name "memory.events" | xargs grep -l "oom_kill [^0]" 2>/dev/null | head -10
```

## Conclusion

Effective memory management in containerized Linux environments requires understanding multiple layers of the stack: the kernel's virtual memory subsystem and page reclaim algorithms, the OOM killer's selection criteria, the cgroups v2 memory controller's two-threshold model, and the language runtime-specific behaviors that translate application memory allocation patterns into kernel memory usage.

The key operational practices:

1. **Monitor `container_memory_working_set_bytes`**, not RSS, for eviction risk assessment
2. **Set limits at 1.5-2x steady-state usage** to accommodate burst allocations
3. **Enable memory throttling metrics** (`memory_throttled_usec`) to detect soft limit pressure before hard OOM kills
4. **Tune `vm.swappiness=10`** on nodes where swap is available but undesirable
5. **Set `madvise` THP mode** to allow applications to opt in to hugepages explicitly
6. **Alert on `kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}`** with a 15-minute lookback window to catch containers that restart before the event is noticed
