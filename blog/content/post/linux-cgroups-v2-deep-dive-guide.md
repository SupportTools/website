---
title: "Linux cgroups v2 Deep Dive: Resource Control for Kubernetes and Container Runtimes"
date: 2028-05-10T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "Containers", "Kubernetes", "Resource Management"]
categories: ["Linux", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into Linux cgroups v2, covering the unified hierarchy, resource controllers, memory pressure handling, CPU weight scheduling, and how Kubernetes and container runtimes use cgroups for workload isolation."
more_link: "yes"
url: "/linux-cgroups-v2-deep-dive-guide/"
---

Control groups (cgroups) are the Linux kernel mechanism that makes containers possible. Every Docker container, every Kubernetes pod, and every systemd service is isolated using cgroups. The v2 unified hierarchy, fully supported since kernel 5.2 and the default in modern distributions, brings a cleaner resource model, improved CPU pressure monitoring, and better memory management compared to cgroups v1. Understanding cgroups at the kernel level is essential for diagnosing resource contention, tuning workload isolation, and understanding why your container OOM-killed unexpectedly.

<!--more-->

# Linux cgroups v2 Deep Dive: Resource Control for Kubernetes and Container Runtimes

## cgroups v2 Architecture

cgroups v2 uses a single unified hierarchy mounted at `/sys/fs/cgroup`. Every process belongs to exactly one cgroup (its position in the hierarchy). Resources are controlled by enabling controllers at each level of the hierarchy.

The key differences from cgroups v1:

- **Single hierarchy**: v1 had separate mount points per resource type (`/sys/fs/cgroup/memory`, `/sys/fs/cgroup/cpu`), v2 uses one unified hierarchy
- **No internal processes**: Leaf cgroups contain processes; internal cgroups only contain sub-cgroups (the "no internal process" rule)
- **Pressure Stall Information (PSI)**: CPU, memory, and I/O pressure metrics for each cgroup
- **Resource delegation**: Parent cgroups explicitly delegate controllers to children

### Checking cgroups v2

```bash
# Verify cgroups v2 is in use
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)

# Or check for the unified hierarchy
ls /sys/fs/cgroup/
# cgroup.controllers  cgroup.procs  cgroup.stat  cgroup.subtree_control
# cpu.pressure        io.pressure   memory.pressure
# init.scope  system.slice  user.slice

# Check kernel version (5.2+ recommended for full v2 support)
uname -r

# Check which controllers are available
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc
```

### Hierarchy Navigation

```bash
# View the cgroup hierarchy
systemd-cgls

# Find a process's cgroup
cat /proc/$$/cgroup
# 0::/user.slice/user-1000.slice/user@1000.service/app.slice/bash.service

# View all processes in a cgroup
cat /sys/fs/cgroup/system.slice/docker.service/cgroup.procs

# View cgroup statistics
cat /sys/fs/cgroup/system.slice/cgroup.stat
# nr_descendants 47
# nr_dying_descendants 0
```

## Memory Controller

The memory controller limits and tracks memory usage. It's the most commonly misconfigured resource control in container environments.

### Memory Limits

```bash
# Create a test cgroup
mkdir /sys/fs/cgroup/test-cgroup

# Enable the memory controller (parent must have it in subtree_control)
echo "+memory" > /sys/fs/cgroup/cgroup.subtree_control

# Set memory limit (bytes)
echo "512M" > /sys/fs/cgroup/test-cgroup/memory.max
# Or in bytes:
echo $((512 * 1024 * 1024)) > /sys/fs/cgroup/test-cgroup/memory.max

# Set memory+swap limit (memory.swap.max controls swap usage ABOVE memory.max)
echo "256M" > /sys/fs/cgroup/test-cgroup/memory.swap.max

# Set soft limit (memory.high triggers reclaim but doesn't kill)
echo "400M" > /sys/fs/cgroup/test-cgroup/memory.high

# Move a process into the cgroup
echo $$ > /sys/fs/cgroup/test-cgroup/cgroup.procs

# View current memory usage
cat /sys/fs/cgroup/test-cgroup/memory.current
# 102400

# View memory statistics
cat /sys/fs/cgroup/test-cgroup/memory.stat
# anon 94208            # Anonymous memory (heap, stack)
# file 8192             # Page cache
# kernel_stack 8192     # Kernel stacks
# slab 49152            # Kernel slab allocator
# sock 0                # Socket buffers
# shmem 0               # Shared memory
# file_mapped 0         # Memory-mapped files
# file_dirty 0          # Dirty page cache
# file_writeback 0      # Pages being written back
# inactive_anon 0
# active_anon 94208
# inactive_file 8192
# active_file 0
# pgfault 145           # Minor page faults
# pgmajfault 0          # Major page faults (disk I/O)
# oom_kill 0            # OOM kill count
```

### Memory Pressure Stall Information (PSI)

PSI is one of the most valuable additions in cgroups v2 — it measures the time processes spend waiting for resources:

```bash
# Read memory pressure for a cgroup
cat /sys/fs/cgroup/test-cgroup/memory.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# "some" = at least one task is stalled on memory
# "full" = ALL runnable tasks are stalled on memory (severe)
# avg10/avg60/avg300 = percentage of time stalled (10s, 60s, 5min rolling averages)
# total = cumulative microseconds of stall time

# Monitor PSI in real-time
watch -n 1 'cat /sys/fs/cgroup/test-cgroup/memory.pressure'

# PSI-based OOM avoidance: when memory.high is exceeded,
# the kernel throttles tasks in the cgroup before hard OOM killing
echo "450M" > /sys/fs/cgroup/test-cgroup/memory.high
# When memory exceeds 450M, tasks are slowed down (throttled)
# Memory OOM kill only when memory.max is reached
```

### Kernel OOM Score Configuration

```bash
# Check oom_score_adj for containers (Kubernetes sets this based on QoS class)
# Guaranteed: -997 (almost never OOM killed)
# Burstable: proportional to resource usage (0 to -999)
# BestEffort: 1000 (first to be OOM killed)
cat /proc/$$/oom_score_adj

# View OOM events
cat /sys/fs/cgroup/test-cgroup/memory.events
# low 0          # hit memory.low (guaranteed minimum) and was reclaimed
# high 5         # exceeded memory.high — tasks throttled
# max 0          # hit memory.max
# oom 0          # OOM condition was detected
# oom_kill 0     # OOM killer was invoked
```

## CPU Controller

The CPU controller manages CPU time allocation between cgroups.

### CPU Weight (Fair Scheduling)

```bash
# CPU weight determines proportional share of CPU time
# Default: 100, Range: 1-10000

# Give a cgroup twice the CPU share of default
echo 200 > /sys/fs/cgroup/test-cgroup/cpu.weight

# Restrict to a maximum CPU fraction (cpu.max = quota period)
# 50000 100000 = 50% CPU utilization (50ms quota per 100ms period)
echo "50000 100000" > /sys/fs/cgroup/test-cgroup/cpu.max

# Disable CPU limit (unlimited)
echo "max 100000" > /sys/fs/cgroup/test-cgroup/cpu.max

# View CPU statistics
cat /sys/fs/cgroup/test-cgroup/cpu.stat
# usage_usec 1234567     # Total CPU time used (microseconds)
# user_usec 900000       # User space CPU time
# system_usec 334567     # Kernel CPU time
# nr_periods 50          # Number of periods that have elapsed
# nr_throttled 10        # Number of periods throttled
# throttled_usec 500000  # Total time throttled (microseconds)
# nr_bursts 0            # Burst periods (if cpu.max burst is configured)
# burst_usec 0

# CPU pressure
cat /sys/fs/cgroup/test-cgroup/cpu.pressure
# some avg10=2.50 avg60=1.20 avg300=0.80 total=15000000
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

### CPU Burst

CPU burst allows temporary allocation beyond the quota:

```bash
# Enable bursting: allow up to 20ms burst in addition to 50ms quota
# Format: quota period burst
echo "50000 100000" > /sys/fs/cgroup/test-cgroup/cpu.max
echo "20000" > /sys/fs/cgroup/test-cgroup/cpu.max.burst

# This allows the cgroup to use 70ms of CPU in a single period
# if it had accumulated burst from previous underutilized periods
```

### cpuset Controller

Pin processes to specific CPU cores:

```bash
# Enable cpuset controller
echo "+cpuset" > /sys/fs/cgroup/cgroup.subtree_control

# Assign CPUs 0-3 to a cgroup
echo "0-3" > /sys/fs/cgroup/test-cgroup/cpuset.cpus

# Assign NUMA memory nodes
echo "0" > /sys/fs/cgroup/test-cgroup/cpuset.mems

# Check effective CPU assignment (may differ from requested if parent restricts)
cat /sys/fs/cgroup/test-cgroup/cpuset.cpus.effective
# 0-3

# cpuset.cpus.partition: isolate CPUs from the scheduler entirely
# "root" | "isolated" | "member"
echo "root" > /sys/fs/cgroup/test-cgroup/cpuset.cpus.partition
```

## I/O Controller

```bash
# Enable IO controller
echo "+io" > /sys/fs/cgroup/cgroup.subtree_control

# Get device major:minor numbers
ls -la /dev/sda
# brw-rw---- 1 root disk 8, 0 May 10 09:00 /dev/sda
# Major: 8, Minor: 0

# Set I/O weight for proportional sharing
# Format: MAJOR:MINOR WEIGHT
echo "8:0 100" > /sys/fs/cgroup/test-cgroup/io.weight

# Set I/O maximum rates (throttling)
# Read bandwidth: 50 MB/s
echo "8:0 rbps=52428800" > /sys/fs/cgroup/test-cgroup/io.max
# Write bandwidth: 20 MB/s
echo "8:0 wbps=20971520" > /sys/fs/cgroup/test-cgroup/io.max
# Read IOPS: 1000
echo "8:0 riops=1000" > /sys/fs/cgroup/test-cgroup/io.max
# Write IOPS: 500
echo "8:0 wiops=500" > /sys/fs/cgroup/test-cgroup/io.max

# Combine limits
echo "8:0 rbps=52428800 wbps=20971520 riops=1000 wiops=500" > \
  /sys/fs/cgroup/test-cgroup/io.max

# View I/O statistics
cat /sys/fs/cgroup/test-cgroup/io.stat
# 8:0 rbytes=12345678 wbytes=4567890 rios=1234 wios=567 dbytes=0 dios=0

# I/O pressure
cat /sys/fs/cgroup/test-cgroup/io.pressure
# some avg10=5.00 avg60=3.00 avg300=1.00 total=50000000
# full avg10=0.10 avg60=0.05 avg300=0.02 total=1000000
```

## PID Controller

Limit the number of processes in a cgroup:

```bash
# Set maximum PID count
echo 100 > /sys/fs/cgroup/test-cgroup/pids.max

# View current count
cat /sys/fs/cgroup/test-cgroup/pids.current
# 45

# View events (fork failures)
cat /sys/fs/cgroup/test-cgroup/pids.events
# max 0  # Times the limit was hit
```

## How Kubernetes Uses cgroups v2

Kubernetes uses cgroups to implement resource requests and limits for pods. Understanding the mapping is essential for debugging resource issues.

### Cgroup Hierarchy in Kubernetes

```
/sys/fs/cgroup/
├── kubepods.slice/                          # All Kubernetes workloads
│   ├── kubepods-guaranteed.slice/           # Guaranteed QoS pods
│   │   └── pod{pod-uid}/                   # Individual pod cgroup
│   │       └── {container-id}/             # Container cgroup
│   ├── kubepods-burstable.slice/            # Burstable QoS pods
│   │   └── pod{pod-uid}/
│   │       └── {container-id}/
│   └── kubepods-besteffort.slice/           # BestEffort QoS pods
│       └── pod{pod-uid}/
│           └── {container-id}/
├── system.slice/                            # System services
└── user.slice/                              # User sessions
```

### Finding a Container's cgroup

```bash
# Find the container ID from kubectl
kubectl get pod payments-deployment-abc123 -o jsonpath='{.status.containerStatuses[0].containerID}'
# containerd://abc123def456...

# Find the cgroup path
CONTAINER_ID="abc123def456"
POD_UID="pod-uid-here"

# The cgroup path format
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod${POD_UID}/${CONTAINER_ID}"

# View the container's memory limit
cat "${CGROUP_PATH}/memory.max"

# View the container's CPU quota
cat "${CGROUP_PATH}/cpu.max"

# Check if the container is being throttled
cat "${CGROUP_PATH}/cpu.stat" | grep throttled
```

### Kubernetes Resource Requests and Limits Mapping

```
Kubernetes resources → cgroup v2 parameters:

requests.cpu → cpu.weight (proportional, calculated from milli-CPUs)
limits.cpu   → cpu.max (quota/period)
requests.memory → memory.min (guaranteed minimum, not OOM-killed below this)
limits.memory   → memory.max (hard limit — OOM kill if exceeded)
```

The CPU weight formula Kubernetes uses:

```
weight = max(2, min(262144, milliCPU * 1024 / 1000))
```

For example:
- 100m CPU request → weight = 102
- 500m CPU request → weight = 512
- 1000m CPU request → weight = 1024
- 2000m CPU request → weight = 2048

```bash
# Verify the CPU weight for a running container
CONTAINER_CGROUP="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod${POD_UID}/${CONTAINER_ID}"

cat "${CONTAINER_CGROUP}/cpu.weight"
# 102  (for 100m CPU request)

cat "${CONTAINER_CGROUP}/cpu.max"
# 200000 100000  (for 200m CPU limit = 200ms/100ms period = 20%)
```

### Diagnosing CPU Throttling

CPU throttling is one of the most common but invisible performance issues in Kubernetes:

```bash
#!/bin/bash
# check-cpu-throttling.sh
# Check CPU throttling for all containers in a namespace

NAMESPACE=${1:-default}

for pod in $(kubectl get pods -n "$NAMESPACE" -o name); do
  POD_NAME="${pod#pod/}"
  POD_UID=$(kubectl get pod -n "$NAMESPACE" "$POD_NAME" -o jsonpath='{.metadata.uid}')

  for container_status in $(kubectl get pod -n "$NAMESPACE" "$POD_NAME" \
    -o jsonpath='{.status.containerStatuses[*].containerID}'); do
    CONTAINER_ID="${container_status#containerd://}"
    SHORT_ID="${CONTAINER_ID:0:12}"

    # Find the cgroup path
    CGROUP=$(find /sys/fs/cgroup/kubepods.slice -name "$CONTAINER_ID" -type d 2>/dev/null | head -1)

    if [ -z "$CGROUP" ]; then
      continue
    fi

    CPU_STAT=$(cat "$CGROUP/cpu.stat" 2>/dev/null)
    NR_PERIODS=$(echo "$CPU_STAT" | grep "^nr_periods " | awk '{print $2}')
    NR_THROTTLED=$(echo "$CPU_STAT" | grep "^nr_throttled " | awk '{print $2}')
    THROTTLED_USEC=$(echo "$CPU_STAT" | grep "^throttled_usec " | awk '{print $2}')

    if [ -n "$NR_PERIODS" ] && [ "$NR_PERIODS" -gt 0 ]; then
      THROTTLE_PCT=$((NR_THROTTLED * 100 / NR_PERIODS))
      if [ "$THROTTLE_PCT" -gt 5 ]; then
        echo "WARNING: $POD_NAME/$SHORT_ID: ${THROTTLE_PCT}% throttled"
        echo "  Periods: $NR_PERIODS, Throttled: $NR_THROTTLED"
        echo "  Throttled time: $((THROTTLED_USEC / 1000000))s total"
      fi
    fi
  done
done
```

### Memory OOM Debugging

```bash
# Check OOM events for a container
CONTAINER_CGROUP="/sys/fs/cgroup/kubepods.slice/..."

# Check OOM event count
cat "${CONTAINER_CGROUP}/memory.events"
# low 0
# high 12    # Container has been hitting memory.high (soft limit)
# max 0
# oom 1      # OOM condition occurred
# oom_kill 1 # Container was OOM-killed

# View current memory breakdown
cat "${CONTAINER_CGROUP}/memory.stat" | head -20

# Check what the container's effective limits are
cat "${CONTAINER_CGROUP}/memory.max"        # Hard limit
cat "${CONTAINER_CGROUP}/memory.high"       # Soft limit (throttle threshold)
cat "${CONTAINER_CGROUP}/memory.min"        # Guaranteed minimum

# View kernel OOM log
dmesg | grep -i "oom_kill\|out of memory\|killed process" | tail -20
```

## cgroups v2 with containerd

containerd uses cgroups v2 directly through its CRI implementation:

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri"]
  # Enable cgroups v2 systemd driver (recommended for Kubernetes)
  [plugins."io.containerd.grpc.v1.cri".containerd]
    default_runtime_name = "runc"

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
      runtime_type = "io.containerd.runc.v2"

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
        SystemdCgroup = true  # Use systemd cgroup driver
        # This must match kubelet's cgroupDriver setting
```

```yaml
# kubelet configuration (kubeadm-based)
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd  # Must match containerd's SystemdCgroup setting
cgroupsPerQOS: true    # Enable QoS-based cgroup hierarchy
```

## Monitoring cgroups v2 with eBPF

For advanced monitoring, eBPF programs can attach to cgroup events:

```c
// ebpf/cgroup_memory.c
// Trace OOM kills in cgroups
#include <linux/bpf.h>
#include <linux/types.h>

SEC("kprobe/oom_kill_process")
int trace_oom_kill(struct pt_regs *ctx) {
    u64 pid = bpf_get_current_pid_tgid() >> 32;
    char comm[TASK_COMM_LEN];
    bpf_get_current_comm(&comm, sizeof(comm));

    bpf_trace_printk("OOM kill: pid=%d comm=%s\n",
                     pid, comm);
    return 0;
}
```

Or use existing tools:

```bash
# BCC tools for cgroup monitoring
# (requires bcc-tools package)
cat /usr/share/bcc/tools/oomkill | head -20

# Run the OOM kill tracer
/usr/share/bcc/tools/oomkill

# Trace process lifecycle in cgroups
/usr/share/bcc/tools/execsnoop | grep -v grep

# Monitor CPU scheduling events
/usr/share/bcc/tools/runqlat 10 1  # CPU run queue latency
```

## Node Allocatable Resources and System Reserved

Kubernetes reserves resources from the node to protect system services:

```yaml
# kubelet configuration for resource reservations
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# System reserved (OS-level processes not in a cgroup hierarchy)
systemReserved:
  cpu: "500m"
  memory: "1Gi"
  ephemeral-storage: "10Gi"

# Kubelet reserved (the kubelet process itself)
kubeSystemReserved:
  cpu: "250m"
  memory: "256Mi"

# Hard eviction thresholds
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"

# Soft eviction (waits for evictionSoftGracePeriod before evicting)
evictionSoft:
  memory.available: "1Gi"
  nodefs.available: "15%"

evictionSoftGracePeriod:
  memory.available: "2m"
  nodefs.available: "5m"
```

```bash
# Verify node allocatable resources
kubectl describe node my-node | grep -A 10 "Allocatable:"
# Allocatable:
#   cpu:               7500m     # 8 CPU - 500m system - 0m kube reserved
#   ephemeral-storage: 89080Mi
#   memory:            14Gi      # 16Gi - 1Gi system - 256Mi kube
#   pods:              110

# Current usage vs allocatable
kubectl describe node my-node | grep -A 20 "Allocated resources:"
```

## Performance Tuning with cgroups v2

### Identifying Noisy Neighbors

```bash
#!/bin/bash
# identify-noisy-neighbors.sh
# Find containers with high CPU steal / high memory pressure

echo "=== High CPU Throttle Containers ==="
find /sys/fs/cgroup/kubepods.slice -name "cpu.stat" | while read f; do
  NR_THROTTLED=$(grep "^nr_throttled " "$f" | awk '{print $2}')
  NR_PERIODS=$(grep "^nr_periods " "$f" | awk '{print $2}')
  if [ "${NR_PERIODS:-0}" -gt 100 ] && [ "${NR_THROTTLED:-0}" -gt 0 ]; then
    PCT=$((NR_THROTTLED * 100 / NR_PERIODS))
    if [ "$PCT" -gt 10 ]; then
      CGROUP_DIR=$(dirname "$f")
      echo "$PCT% throttled: $CGROUP_DIR"
    fi
  fi
done | sort -rn | head -20

echo ""
echo "=== High Memory Pressure Containers ==="
find /sys/fs/cgroup/kubepods.slice -name "memory.pressure" | while read f; do
  SOME_AVG10=$(grep "^some " "$f" | grep -oP "avg10=\K[0-9.]+")
  if [ "$(echo "${SOME_AVG10:-0} > 5" | bc)" -eq 1 ]; then
    CGROUP_DIR=$(dirname "$f")
    echo "Memory pressure ${SOME_AVG10}% avg10: $CGROUP_DIR"
  fi
done | sort -rn | head -20
```

## Conclusion

cgroups v2 provides a more coherent, powerful resource management model than its predecessor. The unified hierarchy simplifies reasoning about resource inheritance, PSI provides actionable signals for resource pressure (not just binary throttled/not-throttled), and the memory controller's `high`/`max` two-tier model allows graceful degradation before hard OOM killing.

For Kubernetes operators, the key takeaways are: always use the systemd cgroup driver for consistency with systemd, monitor CPU throttling proactively because it causes latency spikes without obvious container failures, and understand that OOM kills are the last resort — memory pressure and `memory.high` violations are the early warning signs. Tools like `cgroups-exporter` or Prometheus node exporter with cgroups metrics can surface these signals in your existing dashboards before they become incidents.
