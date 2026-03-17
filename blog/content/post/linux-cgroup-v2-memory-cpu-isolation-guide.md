---
title: "Linux cgroup v2: Memory and CPU Isolation for Container Workloads"
date: 2028-11-02T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "Containers", "Kubernetes", "Performance"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux cgroup v2 for container workloads: memory.max vs memory.high throttling, swap control, cpu.weight vs cpu.max scheduling, I/O isolation, pressure stall information (PSI), systemd delegation, and Kubernetes QoS class mapping."
more_link: "yes"
url: "/linux-cgroup-v2-memory-cpu-isolation-guide/"
---

Control groups v2 (cgroup v2) shipped in Linux 4.5 and became the default in major distributions by kernel 5.15. Every container you run on a modern Linux system uses cgroup v2 unless you have explicitly disabled it. Yet most engineers working with containers understand cgroups primarily through their Kubernetes resource limits and requests, without understanding the underlying kernel mechanics. When a pod is OOM-killed, when containers throttle unexpectedly, or when a noisy neighbor consumes all I/O bandwidth, knowledge of the actual cgroup interface is what lets you diagnose and fix the problem.

This guide covers the cgroup v2 unified hierarchy, memory control (the most common source of container incidents), CPU scheduling, I/O isolation, and how Kubernetes maps its resource model onto cgroup v2 structures.

<!--more-->

# Linux cgroup v2: Memory and CPU Isolation for Container Workloads

## The Unified Hierarchy

cgroup v1 had separate hierarchies for each controller: one for memory, one for CPU, one for I/O. This created a fundamental problem: a process could be in different cgroup subtrees for different controllers, making consistent policy difficult.

cgroup v2 uses a single unified hierarchy. Every process lives in exactly one cgroup, and that cgroup has all controllers enabled on it:

```bash
# Verify your system is running cgroup v2
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)

# cgroup v1 would show multiple entries:
# cgroup on /sys/fs/cgroup/memory type cgroup (...)
# cgroup on /sys/fs/cgroup/cpu,cpuacct type cgroup (...)

# Check kernel boot parameter
cat /proc/cmdline | grep -o 'systemd.unified_cgroup_hierarchy=[01]'
# Empty output means v2 is default (Linux 5.15+, Ubuntu 22.04+, Fedora 31+)
```

The cgroup v2 filesystem is mounted at `/sys/fs/cgroup`. Explore the hierarchy:

```bash
# View the cgroup hierarchy (requires systemd-cgls or tree)
systemd-cgls --no-pager | head -50

# Or manually
ls /sys/fs/cgroup/
# cgroup.controllers  cgroup.max.depth  cgroup.procs  cgroup.stat
# cgroup.events       cgroup.max.descendants  cgroup.subtree_control
# cpu.stat            init.scope  memory.numa_stat  memory.stat
# io.stat             system.slice  user.slice

# View active controllers at the root
cat /sys/fs/cgroup/cgroup.subtree_control
# cpuset cpu io memory hugetlb pids rdma misc
```

## Creating and Managing cgroups

The cgroup v2 interface is entirely file-based. Create a cgroup by making a directory:

```bash
# Create a test cgroup (requires root)
mkdir /sys/fs/cgroup/demo

# The kernel auto-creates the interface files
ls /sys/fs/cgroup/demo/
# cgroup.controllers  cgroup.events  cgroup.freeze  cgroup.kill
# cgroup.max.depth    cgroup.max.descendants  cgroup.pressure
# cgroup.procs        cgroup.stat  cgroup.subtree_control
# cgroup.threads      cgroup.type  cpu.pressure  cpu.stat
# cpuset.cpus.effective  io.pressure  memory.current  memory.events
# memory.high  memory.low  memory.max  memory.min  memory.numa_stat
# memory.oom.group  memory.pressure  memory.stat  memory.swap.current
# memory.swap.events  memory.swap.max  pids.current  pids.events  pids.max

# Enable controllers in the child cgroup
echo "+memory +cpu +io" > /sys/fs/cgroup/demo/cgroup.subtree_control

# Add a process to the cgroup
echo $$ > /sys/fs/cgroup/demo/cgroup.procs

# Verify
cat /proc/$$/cgroup
# 0::/demo
```

## Memory Control: memory.max vs memory.high

This is where most engineers get confused. cgroup v2 has four memory limit knobs:

```
memory.min   — Minimum memory guaranteed. Never reclaimed, even under pressure.
memory.low   — Soft protection. Kernel prefers to reclaim from other cgroups first.
memory.high  — Soft limit. Exceeded → process is slowed (throttled), not killed.
memory.max   — Hard limit. Exceeded → OOM killer fires within this cgroup.
```

The distinction between `memory.high` and `memory.max` is critical for container stability:

```bash
# Set memory.high to throttle the workload when it exceeds 400MB
# The process is slowed down but NOT killed — gives it time to page out
echo "419430400" > /sys/fs/cgroup/demo/memory.high  # 400MB

# Set memory.max to kill the OOM at 512MB
# This is the hard ceiling — exceed this and the OOM killer fires
echo "536870912" > /sys/fs/cgroup/demo/memory.max   # 512MB

# Check current memory usage
cat /sys/fs/cgroup/demo/memory.current
# 234881024  (224MB currently used)

# Detailed memory breakdown
cat /sys/fs/cgroup/demo/memory.stat
# anon 134217728           <- anonymous memory (heap, stack)
# file 100663296           <- page cache
# kernel 10485760          <- kernel memory
# kernel_stack 1048576
# pagetables 2097152
# percpu 0
# sock 0
# shmem 0
# file_mapped 52428800     <- file-backed memory mapped into address space
# file_dirty 1048576
# file_writeback 0
# anon_thp 0
# inactive_anon 33554432
# active_anon 100663296
# inactive_file 67108864
# active_file 33554432
# unevictable 0
# slab_reclaimable 5242880
# slab_unreclaimable 5242880
# pgfault 102400
# pgmajfault 512           <- major page faults (disk reads) — high value is bad
# workingset_refault_anon 0
# workingset_refault_file 1024
# pgrefill 5120
# pgscan 10240
# pgsteal 8192
# pgactivate 4096
# pgdeactivate 2048
# pglazyfree 0
# pglazyfreed 0
# thp_fault_alloc 0
# thp_collapse_alloc 0

# Monitor OOM kill events
cat /sys/fs/cgroup/demo/memory.events
# low 0
# high 42         <- number of times memory.high was exceeded (throttle events)
# max 0
# oom 0
# oom_kill 0
# oom_group_kill 0
```

### OOM Grouping

In cgroup v2, `memory.oom.group` controls whether an OOM event kills only the offending process or the entire cgroup:

```bash
# Enable group OOM kill — when any process in this cgroup exceeds memory.max,
# all processes in the cgroup are killed together.
# This is the Kubernetes behavior: the entire pod is OOM-killed, not just one container.
echo 1 > /sys/fs/cgroup/demo/memory.oom.group

# Container runtimes typically set memory.oom.group=1 for each container's cgroup,
# and 1 for the pod-level cgroup. Kubernetes observes the oom_kill event and
# marks the container as OOMKilled.
```

## Swap Control

By default, memory.max controls physical memory. For swap behavior, use `memory.swap.max`:

```bash
# Total memory limit including swap = memory.max + memory.swap.max
# Setting memory.swap.max to 0 disables swap for this cgroup entirely.
echo 0 > /sys/fs/cgroup/demo/memory.swap.max

# Allow up to 200MB of swap in addition to memory.max
echo "209715200" > /sys/fs/cgroup/demo/memory.swap.max

# Current swap usage
cat /sys/fs/cgroup/demo/memory.swap.current
# 52428800  (50MB swapped out)
```

Kubernetes sets `memory.swap.max=0` by default for all containers, preventing swap. This is intentional: swap causes unpredictable latency. The `NodeSwap` feature gate (stable in Kubernetes 1.30) allows opting into swap per pod with careful configuration.

## CPU Control: cpu.weight vs cpu.max

cgroup v2 has two distinct CPU control mechanisms:

```
cpu.weight   — Proportional share (replaces cpu.shares from v1)
               Range: 1-10000, default: 100
               Controls relative scheduling priority when CPU is contested.

cpu.max      — Absolute quota (replaces cpu.cfs_quota_us and cpu.cfs_period_us)
               Format: "quota period" in microseconds
               $quota microseconds of CPU time per $period microseconds.
               "max 100000" means unlimited.
```

```bash
# Give this cgroup twice the CPU weight of a default cgroup
echo 200 > /sys/fs/cgroup/demo/cpu.weight

# Hard limit: 50% of one CPU (50000 microseconds per 100000 microsecond period)
echo "50000 100000" > /sys/fs/cgroup/demo/cpu.max

# Hard limit: 2 full CPUs
echo "200000 100000" > /sys/fs/cgroup/demo/cpu.max

# Remove the hard limit (unlimited, only constrained by weight)
echo "max 100000" > /sys/fs/cgroup/demo/cpu.max

# Check current CPU usage statistics
cat /sys/fs/cgroup/demo/cpu.stat
# usage_usec 45231987      <- total CPU time consumed in microseconds
# user_usec 38291234       <- user-space time
# system_usec 6940753      <- kernel time
# nr_periods 45232         <- number of CFS quota periods
# nr_throttled 1203        <- number of periods where quota was exhausted
# throttled_usec 2847391   <- total microseconds of throttling
# nr_bursts 0
# burst_usec 0
```

High `nr_throttled` relative to `nr_periods` is the telltale sign that your CPU limit is too low. A 20%+ throttle ratio typically means the container needs more CPU or the limit needs to be raised.

### CPU Burst

cgroup v2 supports CPU burst (`cpu.max.burst`), which allows a cgroup to temporarily exceed its quota by borrowing from accumulated slack. Useful for bursty workloads that have low average usage but high peak demand:

```bash
# Allow bursting up to 20ms of extra CPU time
echo "20000" > /sys/fs/cgroup/demo/cpu.max.burst
```

## I/O Isolation: io.weight and io.max

cgroup v2 I/O control unifies block device I/O scheduling:

```bash
# Find the device major:minor numbers
ls -la /dev/nvme0n1
# brw-rw---- 1 root disk 259, 0 Nov  1 09:00 /dev/nvme0n1
# Major=259, Minor=0

# Set I/O weight (proportional scheduling, default 100)
# This cgroup gets 2x the I/O bandwidth compared to weight=100 cgroups
echo "259:0 200" > /sys/fs/cgroup/demo/io.weight

# Set absolute I/O limits
# Format: "major:minor rbps=N wbps=N riops=N wiops=N"
# Hard limit: 100MB/s read, 50MB/s write, 5000 read IOPS, 2000 write IOPS
echo "259:0 rbps=104857600 wbps=52428800 riops=5000 wiops=2000" > /sys/fs/cgroup/demo/io.max

# Check current I/O statistics
cat /sys/fs/cgroup/demo/io.stat
# 259:0 rbytes=2147483648 wbytes=1073741824 rios=512000 wios=256000 dbytes=0 dios=0

# io.pressure provides PSI data for I/O (see PSI section below)
cat /sys/fs/cgroup/demo/io.pressure
# some avg10=0.00 avg60=0.12 avg300=0.08 total=8324561
# full avg10=0.00 avg60=0.04 avg300=0.02 total=2947832
```

## Pressure Stall Information (PSI)

PSI is one of cgroup v2's most valuable additions. It measures the fraction of time that processes are stalled waiting for a resource — a direct measure of resource saturation that neither CPU utilization nor memory usage captures:

```bash
# System-wide PSI
cat /proc/pressure/cpu
# some avg10=8.21 avg60=4.33 avg300=2.15 total=12847361

cat /proc/pressure/memory
# some avg10=0.00 avg60=0.12 avg300=0.04 total=234782
# full avg10=0.00 avg60=0.00 avg300=0.00 total=45231

cat /proc/pressure/io
# some avg10=1.24 avg60=3.87 avg300=2.91 total=8923471
# full avg10=0.12 avg60=0.89 avg300=0.67 total=1234567

# Per-cgroup PSI (cgroup v2 only)
cat /sys/fs/cgroup/demo/memory.pressure
# some avg10=12.45 avg60=8.33 avg300=4.21 total=4231987
# full avg10=3.12 avg60=1.98 avg300=0.87 total=987654
```

The two stall types:
- **some**: At least one task is stalled. The workload is partially degraded.
- **full**: All non-idle tasks are stalled simultaneously. The workload is completely blocked.

PSI values above 10% for `some` or any `full` saturation indicate a resource bottleneck. Kubernetes uses PSI to implement `MemoryPressure` node conditions.

### PSI Monitoring Script

```bash
#!/bin/bash
# monitor-psi.sh — Monitor PSI for a container's cgroup
# Usage: ./monitor-psi.sh <cgroup_path>
# Example: ./monitor-psi.sh /sys/fs/cgroup/kubepods/pod-uid/container-id

CGROUP_PATH="${1:-/sys/fs/cgroup}"
INTERVAL=5

echo "Monitoring PSI for: $CGROUP_PATH"
echo "Press Ctrl+C to stop"
echo ""
printf "%-12s %-8s %-8s %-8s %-8s %-8s %-8s\n" \
    "Time" "CPU-some" "CPU-full" "Mem-some" "Mem-full" "IO-some" "IO-full"

while true; do
    CPU_SOME=$(awk '/some/{print $2}' "${CGROUP_PATH}/cpu.pressure" 2>/dev/null | cut -d= -f2 | head -1)
    CPU_FULL=$(awk '/full/{print $2}' "${CGROUP_PATH}/cpu.pressure" 2>/dev/null | cut -d= -f2 | head -1)
    MEM_SOME=$(awk '/some/{print $2}' "${CGROUP_PATH}/memory.pressure" 2>/dev/null | cut -d= -f2 | head -1)
    MEM_FULL=$(awk '/full/{print $2}' "${CGROUP_PATH}/memory.pressure" 2>/dev/null | cut -d= -f2 | head -1)
    IO_SOME=$(awk '/some/{print $2}' "${CGROUP_PATH}/io.pressure" 2>/dev/null | cut -d= -f2 | head -1)
    IO_FULL=$(awk '/full/{print $2}' "${CGROUP_PATH}/io.pressure" 2>/dev/null | cut -d= -f2 | head -1)

    printf "%-12s %-8s %-8s %-8s %-8s %-8s %-8s\n" \
        "$(date +%H:%M:%S)" \
        "${CPU_SOME:-N/A}" "${CPU_FULL:-N/A}" \
        "${MEM_SOME:-N/A}" "${MEM_FULL:-N/A}" \
        "${IO_SOME:-N/A}" "${IO_FULL:-N/A}"

    sleep "$INTERVAL"
done
```

## systemd cgroup Delegation

When running containers through systemd (or in systemd-based distributions), systemd manages the cgroup hierarchy. To give container runtimes (containerd, cri-o) the ability to create sub-cgroups, configure delegation:

```bash
# Check if containerd has cgroup delegation
systemctl show containerd | grep Delegate
# Delegate=yes

# If not delegated, create a drop-in:
mkdir -p /etc/systemd/system/containerd.service.d/
cat > /etc/systemd/system/containerd.service.d/delegate.conf << 'EOF'
[Service]
Delegate=yes
EOF

systemctl daemon-reload
systemctl restart containerd
```

For custom workloads that need their own cgroup subtree, create a systemd scope with delegation:

```bash
# Start a process in a new cgroup scope with resource limits
systemd-run \
  --scope \
  --unit=my-workload \
  --slice=workloads.slice \
  --property=MemoryMax=512M \
  --property=CPUQuota=200% \
  --property=Delegate=yes \
  /usr/bin/my-workload-binary

# Inspect the resulting cgroup
systemctl status my-workload.scope
cat /sys/fs/cgroup/workloads.slice/my-workload.scope/memory.max
# 536870912
```

## Kubernetes cgroup v2 Support and Pod QoS Mapping

Kubernetes has supported cgroup v2 since 1.25 (GA). The kubelet maps its resource model onto the cgroup hierarchy as follows:

```
/sys/fs/cgroup/
├── kubepods.slice/                          ← All Kubernetes pods
│   ├── kubepods-besteffort.slice/           ← BestEffort pods (no requests/limits)
│   │   └── pod<uid>/
│   │       └── <container-id>/
│   │           ├── memory.max = max         ← Unlimited
│   │           └── cpu.weight = 2           ← Lowest priority
│   │
│   ├── kubepods-burstable.slice/            ← Burstable pods (requests < limits)
│   │   └── pod<uid>/
│   │       └── <container-id>/
│   │           ├── memory.max = <limit>     ← Hard limit from spec
│   │           ├── memory.request = <req>   ← Used for memory.low
│   │           └── cpu.weight = <derived>   ← cpu.shares * 10 / 1024
│   │
│   └── kubepods-guaranteed.slice/           ← Guaranteed pods (requests == limits)
│       └── pod<uid>/
│           └── <container-id>/
│               ├── memory.max = <limit>     ← Hard limit
│               └── cpu.max = <limit>        ← Hard CPU limit (no burst)
│
└── system.slice/                            ← System services
    └── kubelet.service/
```

### QoS Class Resource Mapping

```bash
# BestEffort container
cat /sys/fs/cgroup/kubepods.slice/kubepods-besteffort.slice/pod<uid>/<cid>/cpu.weight
# 2  (lowest weight, gets CPU last)
cat /sys/fs/cgroup/kubepods.slice/kubepods-besteffort.slice/pod<uid>/<cid>/memory.max
# max  (no limit)

# Burstable container with requests: {cpu: 100m, memory: 128Mi}, limits: {cpu: 500m, memory: 512Mi}
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<uid>/<cid>/cpu.weight
# 10  (100m * 10 / 100 = 10 weight units; 1000m = 100 weight units)
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<uid>/<cid>/cpu.max
# 50000 100000  (500m = 50% of one CPU)
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<uid>/<cid>/memory.max
# 536870912  (512MiB)
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<uid>/<cid>/memory.low
# 134217728  (128MiB request, protected from eviction pressure)

# Guaranteed container with requests == limits: {cpu: 500m, memory: 512Mi}
cat /sys/fs/cgroup/kubepods.slice/kubepods-guaranteed.slice/pod<uid>/<cid>/cpu.max
# 50000 100000  (500m hard limit)
cat /sys/fs/cgroup/kubepods.slice/kubepods-guaranteed.slice/pod<uid>/<cid>/memory.max
# 536870912  (512MiB hard limit)
# memory.high is NOT set — Guaranteed pods are not throttled, only OOM-killed
```

## Debugging Container Resource Issues

### Finding the cgroup for a Running Container

```bash
# For containerd (Kubernetes)
CONTAINER_ID="abc123def456"  # From kubectl describe pod
CGROUP_PATH=$(cat /proc/$(crictl inspect $CONTAINER_ID | jq -r '.info.pid')/cgroup | grep -m1 '' | cut -d: -f3)
echo "/sys/fs/cgroup${CGROUP_PATH}"

# Alternative: find it via the container ID
find /sys/fs/cgroup/kubepods.slice -name "*.scope" | xargs grep -l "$CONTAINER_ID" 2>/dev/null

# For Docker
CONTAINER_ID=$(docker ps -q --filter name=myapp)
docker inspect $CONTAINER_ID --format '{{.HostConfig.CgroupParent}}'
# /sys/fs/cgroup/docker/<full-container-id>
```

### Diagnosing CPU Throttling

```bash
# Check throttling ratio for a Kubernetes container
CGROUP="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<uid>/<container-id>"

awk '
/nr_periods/ { periods = $2 }
/nr_throttled/ { throttled = $2 }
END {
    if (periods > 0)
        printf "Throttle ratio: %.1f%%\n", (throttled/periods)*100
    else
        print "No data"
}' "$CGROUP/cpu.stat"

# Real-time throttling monitor
watch -n 2 'awk "/nr_throttled/{t=$2} /nr_periods/{p=$2} END{printf \"Throttled: %.1f%%\n\", p>0 ? t/p*100 : 0}" /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<uid>/<cid>/cpu.stat'
```

### Diagnosing Memory Pressure

```bash
CGROUP="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod<uid>/<container-id>"

# Check if memory.high is being hit (causing throttling)
cat "$CGROUP/memory.events"
# low 0
# high 1523     ← Non-zero means memory.high was exceeded — container is being throttled
# max 0
# oom 0
# oom_kill 0

# Check major page faults (disk I/O caused by memory pressure)
awk '/pgmajfault/{print "Major page faults: " $2}' "$CGROUP/memory.stat"

# Show working set size vs limit
CURRENT=$(cat "$CGROUP/memory.current")
HIGH=$(cat "$CGROUP/memory.high")
MAX=$(cat "$CGROUP/memory.max")
printf "Current: %dMB | High: %dMB | Max: %dMB | Used%%: %.1f%%\n" \
    $((CURRENT/1048576)) $((HIGH/1048576)) $((MAX/1048576)) \
    $(echo "scale=1; $CURRENT * 100 / $MAX" | bc)
```

## Enabling cgroup v2 on Older Systems

If you need to migrate a system from cgroup v1 to v2:

```bash
# Ubuntu 20.04 / Debian 10 (uses v1 by default)
# Add to kernel boot parameters
sudo grubby --update-kernel=ALL --args="systemd.unified_cgroup_hierarchy=1"
# Or edit /etc/default/grub:
# GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"
sudo update-grub
sudo reboot

# Verify after reboot
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 ...

# For Kubernetes: update kubelet configuration
# /etc/kubernetes/kubelet-config.yaml
cat >> /etc/kubernetes/kubelet-config.yaml << 'EOF'
cgroupDriver: systemd
featureGates:
  NodeOutOfServiceVolumeDetach: true
EOF
```

## Summary

Understanding cgroup v2 at the file interface level pays dividends when diagnosing container resource problems:

1. **`memory.high` throttles, `memory.max` kills** — set high ~80% of max to get warning signals before OOM
2. **`cpu.weight` is proportional** (contested CPU), **`cpu.max` is absolute** (enforced always) — most throttling issues come from cpu.max being too low
3. **PSI metrics** (`memory.pressure`, `cpu.pressure`, `io.pressure`) give direct saturation signals that utilization percentages miss
4. **Kubernetes maps QoS classes** onto cgroup structures — Guaranteed pods get hard limits, BestEffort pods get lowest weight
5. **`memory.events`** is the first place to look when a container behaves erratically — high `high` events mean memory throttling is occurring silently
6. **I/O isolation** requires `io.max` or `io.weight` configuration — containers with no I/O limits can saturate the disk for all other workloads on the node
