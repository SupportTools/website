---
title: "Linux Memory Pressure: OOM Killer Internals and Prevention"
date: 2029-06-09T00:00:00-05:00
draft: false
tags: ["Linux", "Memory Management", "OOM Killer", "Kernel", "cgroups", "Production"]
categories: ["Linux", "System Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux OOM killer internals: OOM score calculation, oom_score_adj tuning, the selection algorithm, cgroup OOM events, and practical strategies for preventing out-of-memory kills in production."
more_link: "yes"
url: "/linux-memory-pressure-oom-killer-internals-prevention/"
---

When a Linux system runs out of memory, the kernel's OOM (Out-Of-Memory) killer selects a process and terminates it. In a container environment this is a daily occurrence, but most engineers only interact with OOM kills through their symptoms — a pod that disappeared, an application that was killed — rather than understanding the mechanism. This guide covers the OOM killer from first principles: how scores are calculated, how the victim is selected, and what you can actually do to protect the processes you care about.

<!--more-->

# Linux Memory Pressure: OOM Killer Internals and Prevention

## How Memory Pressure Builds

Linux uses an optimistic memory allocation strategy called overcommit. When a process calls `malloc`, the kernel allocates virtual address space but defers the actual physical page allocation until the page is first accessed (copy-on-write after fork is the canonical example). This means the sum of all virtual memory allocations can — and typically does — exceed physical RAM plus swap.

The kernel tracks how close the system is to actual out-of-memory through several mechanisms:

```bash
# See current memory state
cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree|CommitLimit|Committed_AS"

# MemAvailable is the most useful field — it estimates how much memory
# can be reclaimed without swapping user-space pages
# CommitLimit is the total virtual memory the kernel is willing to commit
# Committed_AS is the current committed virtual memory

# Overcommit policy
cat /proc/sys/vm/overcommit_memory
# 0 = heuristic (default)
# 1 = always allow (dangerous, but used in HPC)
# 2 = never exceed CommitLimit
```

The kernel enters OOM territory when:
1. A page fault cannot be satisfied (no physical pages, no swap)
2. Allocation fails in interrupt context (cannot sleep to reclaim)
3. A cgroup memory limit is hit (cgroup OOM — different from global OOM)

## OOM Score Calculation

Every process has an OOM score between 0 and 1000. The kernel selects the process with the highest score. Understanding how scores are calculated lets you predict and influence which process gets killed.

### The Score Formula

The core badness score in `mm/oom_kill.c` is calculated as:

```
oom_score = (process_rss_pages / total_ram_pages) * 1000 + oom_score_adj
```

Where:
- `process_rss_pages` = Resident Set Size in pages (actual physical memory used)
- `total_ram_pages` = total physical memory pages
- `oom_score_adj` = adjustment in [-1000, +1000]

The RSS includes:
- Anonymous pages (heap, stack)
- File-backed pages that are dirty
- Shared memory pages (counted in full for each process that maps them — this is intentional)

### Reading OOM Scores

```bash
# Check the OOM score for a process
cat /proc/<pid>/oom_score

# Check the adjustment for a process
cat /proc/<pid>/oom_score_adj

# Script: show top 20 processes by OOM score
for pid in /proc/[0-9]*/; do
    pid_num=${pid%/}
    pid_num=${pid_num##*/proc/}
    score_file="/proc/$pid_num/oom_score"
    adj_file="/proc/$pid_num/oom_score_adj"
    comm_file="/proc/$pid_num/comm"

    [ -f "$score_file" ] || continue
    score=$(cat "$score_file" 2>/dev/null)
    adj=$(cat "$adj_file" 2>/dev/null)
    comm=$(cat "$comm_file" 2>/dev/null)
    rss=$(awk '/VmRSS/{print $2}' "/proc/$pid_num/status" 2>/dev/null)

    echo "$score $pid_num $comm rss=${rss}kB adj=$adj"
done | sort -rn | head -20
```

### Special Score Values

```bash
# oom_score of 0 for kernel threads (never killed)
cat /proc/2/oom_score   # kthreadd: always 0

# Processes with oom_score_adj = -1000 are immune to OOM killing
# This is used for init, systemd, and critical daemons
cat /proc/1/oom_score_adj  # -1000 (init is immune)
```

## oom_score_adj: Your Primary Tuning Knob

`oom_score_adj` is the practical interface for influencing OOM killer behavior. It ranges from -1000 to +1000:

| Value | Meaning |
|---|---|
| -1000 | Immune: never kill this process |
| -500 | Strongly protected |
| 0 | Default (no adjustment) |
| +500 | More likely to be killed |
| +1000 | Kill this process first |

### Setting oom_score_adj

```bash
# For a running process (requires root or same UID)
echo -500 > /proc/<pid>/oom_score_adj

# For a new process using systemd service unit
[Service]
OOMScoreAdjust=-500

# For a shell script or daemon startup
# Using util-linux's choom command
choom -n -500 -- /usr/bin/my-critical-daemon

# Verify
choom -p <pid>
```

### Kubernetes and oom_score_adj

Kubernetes sets `oom_score_adj` based on the container's QoS class:

```bash
# QoS classes and their oom_score_adj values:
# Guaranteed (requests == limits): -997
# Burstable (requests < limits):   min(max(2, 1000 - 10 * (requests.memory/node.allocatable.memory * 1000)), 999)
# BestEffort (no requests/limits): 1000

# Check what Kubernetes set for a container
PID=$(docker inspect --format '{{.State.Pid}}' <container_id>)
cat /proc/$PID/oom_score_adj
```

This means a BestEffort pod (score_adj=1000) is almost always killed before a Guaranteed pod (score_adj=-997). This is intentional — it incentivizes setting resource requests and limits.

## The OOM Killer Selection Algorithm

The kernel's OOM killer (`oom_kill_process` in `mm/oom_kill.c`) follows this decision tree:

```
1. Can memory be reclaimed? (page cache, slab)
   → Yes: reclaim memory, do not invoke OOM killer

2. Is there a process with oom_score_adj == -1000?
   → Skip it (immune)

3. Is there a process that already has a pending signal?
   → Try killing it first (it may free memory soon)

4. Score all processes:
   score = oom_score_badness(p, totalpages)

5. Select the process with the highest score
   → If a process has child processes, also consider killing them

6. Send SIGKILL to the selected process
   → The kernel then tries again to satisfy the allocation
```

### Viewing OOM Killer Activity

```bash
# Real-time OOM events
dmesg -w | grep -i "out of memory\|oom_kill\|oom-kill"

# Example kernel message on OOM kill:
# [123456.789] Out of memory: Kill process 12345 (myapp) score 847 or sacrifice child
# [123456.790] Killed process 12345 (myapp) total-vm:1234567kB, anon-rss:987654kB, file-rss:12345kB, shmem-rss:0kB

# Parse OOM events from systemd journal
journalctl -k | grep -E "oom|Out of memory" | tail -50

# Count OOM kills in the last 24 hours
journalctl -k --since "24 hours ago" | grep -c "Killed process"
```

### Why the OOM Killer Sometimes Kills the Wrong Process

The score formula uses RSS, which means:
- A process that allocates and actually uses 1 GiB gets a high score
- A process that allocates 4 GiB but only touches 100 MiB gets a low score (low RSS)
- The "wrong" process may be killed because it had a large RSS but was not the cause of memory pressure

This is why adjusting `oom_score_adj` is essential for protecting critical processes.

## Cgroup OOM Events

Container environments use cgroup memory controllers, which impose per-cgroup memory limits. When a cgroup hits its limit, a cgroup-level OOM event occurs — this is separate from the global OOM killer and has different behavior.

### Cgroup v2 OOM Events

```bash
# Check cgroup memory limit for a pod
CGROUP_PATH=$(cat /proc/<pid>/cgroup | grep memory | cut -d: -f3)
cat /sys/fs/cgroup${CGROUP_PATH}/memory.max

# Monitor OOM events for a specific cgroup
cat /sys/fs/cgroup${CGROUP_PATH}/memory.events
# output:
# low 0
# high 0
# max 1234   ← number of times allocation was throttled at memory.max
# oom 5      ← number of OOM events
# oom_kill 3 ← number of processes killed by cgroup OOM

# Watch for OOM events (inotify on cgroup events file)
inotifywait -m /sys/fs/cgroup${CGROUP_PATH}/memory.events 2>/dev/null | while read; do
    echo "$(date) OOM event in $CGROUP_PATH:"
    cat /sys/fs/cgroup${CGROUP_PATH}/memory.events
done
```

### Cgroup OOM vs. Global OOM

| Aspect | Cgroup OOM | Global OOM |
|---|---|---|
| Trigger | Hits `memory.limit_in_bytes` / `memory.max` | System-wide free pages exhausted |
| Scope | Kills within the cgroup | Can kill any process |
| Visibility | `memory.events` file, kernel log | Only kernel log |
| Container behavior | Container exits (pod restart) | Unpredictable |

### Disabling Cgroup OOM Killer

In some scenarios, you want the cgroup to stall (block allocations) rather than kill processes. This is done with `memory.oom.group`:

```bash
# Cgroup v2: kill all processes in the group (atomic OOM kill)
echo 1 > /sys/fs/cgroup/mygroup/memory.oom.group

# This prevents partial kills where only some processes in a group die
# Kubernetes uses this for pods — either the pod lives or all containers are killed
```

## Monitoring Memory Pressure with PSI

Pressure Stall Information (PSI) provides the most accurate signal for memory pressure before OOM occurs:

```bash
# System-wide PSI for memory
cat /proc/pressure/memory
# some avg10=12.34 avg60=8.56 avg300=4.23 total=123456789
# full avg10=2.34  avg60=1.56 avg300=0.89 total=23456789

# "some" = at least one task is stalled waiting for memory
# "full" = all non-idle tasks are stalled (severe)
# avg10/60/300 = average percentage of time stalled over 10s/60s/5m

# Per-cgroup PSI (cgroup v2)
cat /sys/fs/cgroup/mypod/memory.pressure
```

### PSI-Based Early Warning

```bash
#!/bin/bash
# psi-monitor.sh — alert when memory pressure exceeds threshold

THRESHOLD=15.0
CHECK_INTERVAL=10

while true; do
    PRESSURE=$(awk '/some/{print $2}' /proc/pressure/memory | cut -d= -f2)

    if awk "BEGIN{exit !($PRESSURE > $THRESHOLD)}"; then
        echo "ALERT: Memory pressure some.avg10=${PRESSURE}% exceeds ${THRESHOLD}%"
        echo "Top RSS consumers:"
        ps aux --sort=-%mem | head -10
        echo "Memory events:"
        cat /proc/meminfo | grep -E "MemAvailable|SwapFree|Dirty|Writeback"
    fi

    sleep $CHECK_INTERVAL
done
```

## Early Warning Systems

### Prometheus and node_exporter

```yaml
# Alerting rules for memory pressure
groups:
- name: memory_pressure
  rules:
  - alert: HighMemoryPressure
    expr: |
      rate(node_pressure_memory_stalled_seconds_total{type="some"}[5m]) * 100 > 10
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "High memory pressure on {{ $labels.instance }}"
      description: "Memory PSI some.avg5m is {{ $value }}%"

  - alert: CriticalMemoryPressure
    expr: |
      rate(node_pressure_memory_stalled_seconds_total{type="full"}[5m]) * 100 > 5
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Critical memory pressure — OOM imminent"

  - alert: LowMemoryAvailable
    expr: |
      (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100 < 10
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Less than 10% memory available on {{ $labels.instance }}"

  - alert: ContainerOOMKilled
    expr: |
      kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
    for: 0m
    labels:
      severity: warning
    annotations:
      summary: "Container {{ $labels.container }} in pod {{ $labels.pod }} was OOM killed"
```

### Kernel OOM Notification via eBPF

```c
// oom_watch.bpf.c — trace OOM kills using eBPF
#include <vmlinux.h>
#include <bpf/bpf_helpers.h>

SEC("kprobe/oom_kill_process")
int trace_oom_kill(struct pt_regs *ctx) {
    struct task_struct *task = (struct task_struct *)PT_REGS_PARM2(ctx);
    u32 pid;
    char comm[16];

    bpf_probe_read_kernel(&pid, sizeof(pid), &task->pid);
    bpf_probe_read_kernel_str(comm, sizeof(comm), task->comm);

    bpf_printk("OOM kill: pid=%u comm=%s\n", pid, comm);
    return 0;
}
```

## Preventing OOM: Practical Strategies

### Strategy 1: Set Accurate Memory Limits

The most effective prevention is accurate resource limits that prevent individual processes from consuming all available memory:

```yaml
# Kubernetes: set both requests and limits to achieve Guaranteed QoS
resources:
  requests:
    memory: "512Mi"
  limits:
    memory: "512Mi"  # Same as requests = Guaranteed QoS = oom_score_adj=-997

# Never use BestEffort pods for anything important
# (no requests/limits = oom_score_adj=1000)
```

### Strategy 2: Tune oom_score_adj via Systemd

```ini
# /etc/systemd/system/critical-app.service
[Unit]
Description=Critical Application

[Service]
ExecStart=/usr/bin/critical-app
OOMScoreAdjust=-900
# Also consider:
MemoryMax=2G          # Cgroup limit — killed if exceeded
MemoryHigh=1.5G       # Soft limit — throttled before hitting max
MemorySwapMax=0       # Disable swap for this service
```

### Strategy 3: Enable Memory Swap Accounting

```bash
# Enable cgroup memory+swap accounting (required for MemorySwapMax to work)
# Add to kernel boot parameters:
# cgroup_enable=memory swapaccount=1

# Verify
cat /proc/cgroups | grep memory
# memory 8 293 1   ← the "1" means enabled
```

### Strategy 4: Use Memory Limits with Overcommit Disabled

For batch workloads where accuracy is more important than performance:

```bash
# Disable overcommit — allocations fail immediately if memory is unavailable
sysctl -w vm.overcommit_memory=2
sysctl -w vm.overcommit_ratio=80  # Use up to 80% of physical RAM + swap
```

### Strategy 5: Configure vm.swappiness

```bash
# Reduce kernel tendency to swap anonymous pages
# Lower values keep application data in RAM longer
sysctl -w vm.swappiness=10       # Range: 0-200 (default: 60)
sysctl -w vm.vfs_cache_pressure=50  # Reduce reclaim of VFS cache (default: 100)

# For containers that should never swap
# Set per-cgroup (cgroup v2):
echo 0 > /sys/fs/cgroup/mypod/memory.swap.max
```

### Strategy 6: NUMA-Aware Memory Allocation

On multi-socket systems, memory pressure can be localized to one NUMA node while the other has free memory:

```bash
# Check NUMA memory distribution
numastat
numastat -p <pid>

# Bind a process to a NUMA node
numactl --membind=0 --cpunodebind=0 /usr/bin/myapp

# Check if OOM is NUMA-local (look for "oom-zone" in dmesg)
dmesg | grep "zone"
```

## Application-Level OOM Prevention

### Memory Budgets in Go

```go
package main

import (
    "runtime"
    "runtime/debug"
    "time"
)

func init() {
    // Set a soft memory limit — GC will run more aggressively when approaching this
    // This is not a hard limit; it guides GC scheduling
    debug.SetMemoryLimit(512 * 1024 * 1024) // 512 MiB

    // Start a goroutine to monitor memory usage
    go monitorMemory()
}

func monitorMemory() {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    for range ticker.C {
        var ms runtime.MemStats
        runtime.ReadMemStats(&ms)

        heapMiB := ms.HeapInuse / 1024 / 1024
        sysMiB := ms.Sys / 1024 / 1024
        limitMiB := uint64(512)

        if heapMiB > limitMiB*80/100 {
            // Approaching limit — trigger GC to reclaim
            runtime.GC()
        }

        if sysMiB > limitMiB*90/100 {
            // Critical — alert and potentially shed load
            alertHighMemory(heapMiB, sysMiB)
        }
    }
}
```

### Node.js Memory Limits

```bash
# Set --max-old-space-size explicitly for Node.js containers
node --max-old-space-size=460 app.js
# Rule of thumb: set ~90% of container memory limit
# Container limit: 512Mi → max-old-space-size=460
```

### JVM Heap Configuration

```bash
# For containers, use UseContainerSupport (enabled by default in JDK 10+)
# This causes the JVM to respect cgroup memory limits
java \
    -XX:+UseContainerSupport \
    -XX:MaxRAMPercentage=75.0 \
    -XX:InitialRAMPercentage=50.0 \
    -jar app.jar
```

## Diagnosing OOM Kills Post-Mortem

```bash
# 1. Check kernel ring buffer
dmesg | grep -A 50 "Out of memory"

# 2. Decode the OOM dump
# Example output interpretation:
# [  723.456789] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),
#                cpuset=myapp,mems_allowed=0,global_oom,task_memcg=/kubepods/pod123/container456,
#                task=myapp,pid=12345,uid=1000

# constraint=CONSTRAINT_MEMCG means the cgroup limit was hit (not global OOM)

# 3. Check per-container memory events in Kubernetes
kubectl describe pod <pod-name> | grep -A 5 "Last State"
# Last State: Terminated
#   Reason: OOMKilled
#   Exit Code: 137

# 4. Reconstruct memory usage at time of kill
# (requires enable_oom_score tracking in your monitoring)
kubectl top pod <pod-name> --containers

# 5. Check if limits are actually appropriate
kubectl get pod <pod-name> -o jsonpath='{.spec.containers[*].resources}'
```

## Kernel Parameters Reference

```bash
# /etc/sysctl.d/99-memory.conf

# Overcommit strategy (0=heuristic, 1=always, 2=strict)
vm.overcommit_memory = 0

# Ratio of RAM usable for overcommit when vm.overcommit_memory=2
vm.overcommit_ratio = 50

# Tendency to swap anonymous pages (0=never swap, 200=aggressive swap)
vm.swappiness = 10

# Tendency to reclaim VFS cache (100=default, lower=keep more VFS cache)
vm.vfs_cache_pressure = 50

# Minimum free memory to keep in kB (triggers kswapd)
vm.min_free_kbytes = 65536

# Panic on OOM instead of killing (use for debugging only)
# vm.panic_on_oom = 1

# Number of pages kernel tries to keep free per zone
# vm.watermark_scale_factor = 10  (default, range 1-1000)
```

## Summary

The OOM killer is a last resort. By the time it activates, your system is already in a degraded state. The preventive measures — accurate cgroup limits, appropriate `oom_score_adj` values for critical processes, PSI-based early alerting, and application-level memory budgets — are far more effective than trying to tune the killer's behavior.

For production systems:
1. Always set memory requests and limits on containers
2. Use Guaranteed QoS for critical workloads
3. Monitor PSI `some.avg10` as your early warning metric
4. Set `oom_score_adj` via systemd for non-container daemons
5. Configure application-level memory limits (Go `GOMEMLIMIT`, JVM `MaxRAMPercentage`, Node `max-old-space-size`) as a final backstop

The OOM killer is fair in that it follows a deterministic algorithm, but its selections can surprise you if you have not configured `oom_score_adj` to reflect your actual priority ordering.
