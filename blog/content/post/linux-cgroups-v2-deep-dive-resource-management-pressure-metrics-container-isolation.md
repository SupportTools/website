---
title: "Linux cgroups v2 Deep Dive: Resource Management, Pressure Metrics, and Container Isolation"
date: 2031-06-16T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "Containers", "Resource Management", "PSI", "Kernel", "Performance"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into Linux cgroups v2 covering the unified hierarchy, CPU and memory controllers, Pressure Stall Information metrics, OOM behavior, container isolation, and production tuning."
more_link: "yes"
url: "/linux-cgroups-v2-deep-dive-resource-management-pressure-metrics-container-isolation/"
---

Control groups version 2 (cgroups v2) is the resource management foundation for every modern container runtime, from Docker to containerd to Kubernetes. Understanding cgroups v2 at the kernel level — not just as an abstraction managed by container tools — gives you the ability to diagnose resource contention, tune allocation policies, interpret Pressure Stall Information metrics for early warning of resource exhaustion, and reason about container isolation guarantees. This guide covers the cgroups v2 unified hierarchy, all major controllers (CPU, memory, I/O, PID), PSI metrics, and how Kubernetes translates pod resource requests and limits into cgroup configuration.

<!--more-->

# Linux cgroups v2: Resource Management Deep Dive

## cgroups v2 vs. v1: The Key Differences

cgroups v1 had a fragmented architecture: each resource controller (cpu, memory, blkio, etc.) had its own independent hierarchy. A process could be in different positions in each hierarchy, making it possible (and common) to have inconsistent resource assignments. cgroups v2 introduces a **unified hierarchy**: a single tree where a process can only exist at one node, and all controllers apply to the same node.

Additional v2 improvements:
- **Thread-mode granularity**: Threads can be assigned to separate cgroups within the same process's cgroup subtree.
- **Pressure Stall Information (PSI)**: Per-cgroup resource pressure metrics.
- **Freezer as a property**: The `cgroup.freeze` interface replaces the v1 `freezer` controller.
- **Delegated hierarchy**: Rootless containers can manage their own cgroup subtree without root.
- **Better OOM handling**: OOM kills now target the cgroup that triggered the OOM, not necessarily the process that allocated memory.

## Verifying cgroups v2

```bash
# Check if the unified hierarchy is mounted
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# If you see both cgroup and cgroup2, you're in hybrid mode (v1 + v2)
# Modern kernels (5.8+) default to cgroup v2 only

# Verify with systemd
systemd-cgls
# Shows the full cgroup tree under /sys/fs/cgroup

# Check which controllers are available
cat /sys/fs/cgroup/cgroup.controllers
# cpu io memory hugetlb pids rdma misc
```

## The Unified Hierarchy Structure

```bash
# The cgroup filesystem root
ls /sys/fs/cgroup/
# Standard files present at every cgroup node:
# cgroup.controllers     - available controllers at this node
# cgroup.subtree_control - controllers enabled for child cgroups
# cgroup.events          - events (populated, frozen)
# cgroup.freeze          - freeze this cgroup and descendants
# cgroup.kill            - write 1 to kill all processes in cgroup
# cgroup.max.depth       - max depth of descendant hierarchy
# cgroup.max.descendants - max number of descendants
# cgroup.procs           - PIDs in this cgroup
# cgroup.stat            - cgroup statistics
# cgroup.threads         - thread IDs in this cgroup
# cgroup.type            - "domain" (normal) or "threaded"

# System service cgroups (managed by systemd)
ls /sys/fs/cgroup/system.slice/
ls /sys/fs/cgroup/user.slice/

# Container cgroups (managed by containerd or Docker)
ls /sys/fs/cgroup/system.slice/docker.service/
# or
ls /sys/fs/cgroup/kubepods/
```

## Enabling Controllers

To use a controller in a subtree, it must be enabled via `cgroup.subtree_control`. A controller can only be enabled if it is listed in the parent's `cgroup.controllers`:

```bash
# Enable the CPU and memory controllers for all child cgroups
echo "+cpu +memory" > /sys/fs/cgroup/cgroup.subtree_control

# Read current subtree_control
cat /sys/fs/cgroup/cgroup.subtree_control
# cpu memory pids

# Create a new cgroup
mkdir /sys/fs/cgroup/my-service

# Enable controllers in the new cgroup
echo "+cpu +memory +io" > /sys/fs/cgroup/my-service/cgroup.subtree_control

# Add a process to the cgroup
echo $$ > /sys/fs/cgroup/my-service/cgroup.procs

# Verify
cat /proc/$$/cgroup
# 0::/my-service  (unified hierarchy, controller 0)
```

## CPU Controller

The v2 CPU controller provides two mechanisms:

### CPU Weight (cpu.weight)

Proportional CPU allocation. The default weight is 100. A cgroup with weight 200 gets twice as much CPU as one with weight 100 when there is contention.

```bash
# Read current weight
cat /sys/fs/cgroup/my-service/cpu.weight
# 100

# Set weight to 200 (double priority)
echo 200 > /sys/fs/cgroup/my-service/cpu.weight

# Set weight to 50 (half priority)
echo 50 > /sys/fs/cgroup/my-service/cpu.weight

# Weight range: 1 to 10000
# Kubernetes maps CPU requests to cpu.weight:
# cpu.weight = max(1, min(10000, (cpu_request_millicores * 1024) / 1000))
# For 500m: weight = 512
```

### CPU Max (cpu.max)

Hard CPU bandwidth limit using CFS (Completely Fair Scheduler) bandwidth control.

```bash
# Format: quota period
# Both in microseconds
# Default: "max 100000" (no limit, 100ms period)

cat /sys/fs/cgroup/my-service/cpu.max
# max 100000

# Limit to 50% CPU (50000us quota per 100000us period)
echo "50000 100000" > /sys/fs/cgroup/my-service/cpu.max

# Limit to 150% CPU (1.5 CPU cores)
echo "150000 100000" > /sys/fs/cgroup/my-service/cpu.max

# Remove limit
echo "max 100000" > /sys/fs/cgroup/my-service/cpu.max
```

### CPU Statistics

```bash
cat /sys/fs/cgroup/my-service/cpu.stat
# usage_usec 1234567        # Total CPU time in microseconds
# user_usec  890123         # User-space CPU time
# system_usec 344444        # Kernel CPU time
# core_sched.force_idle_usec 0
# nr_periods 12345          # Number of CFS periods
# nr_throttled 234          # Periods where cgroup was throttled
# throttled_usec 45678      # Time spent throttled
# nr_bursts 0
# burst_usec 0
```

High `nr_throttled / nr_periods` ratio indicates CPU throttling. This is the cgroups-level signal that your container is hitting its CPU limit. In Kubernetes, CPU throttling is a common source of latency even when the pod appears to be using less than its limit on average.

### CPU Burst (cpu.max.burst)

Allows a cgroup to accumulate unused quota and burst above the limit:

```bash
# Allow bursting up to 200ms of accumulated quota
echo 200000 > /sys/fs/cgroup/my-service/cpu.max.burst
```

## Memory Controller

### Memory Limits

```bash
# Hard limit: OOM kill if exceeded
cat /sys/fs/cgroup/my-service/memory.max
# max (no limit)

# Set 1GiB hard limit
echo $((1024*1024*1024)) > /sys/fs/cgroup/my-service/memory.max

# Soft limit (memory.high): triggers reclaim but doesn't OOM kill
# When usage exceeds high, the kernel aggressively reclaims pages
echo $((800*1024*1024)) > /sys/fs/cgroup/my-service/memory.high

# Minimum guarantee: prevent pages below this from being reclaimed
# Useful for performance-sensitive applications
echo $((256*1024*1024)) > /sys/fs/cgroup/my-service/memory.min

# Low watermark: reclamation pressure hint
echo $((512*1024*1024)) > /sys/fs/cgroup/my-service/memory.low
```

The memory limit hierarchy:
```
memory.min <= memory.low <= memory.high <= memory.max
```

### Memory Statistics

```bash
cat /sys/fs/cgroup/my-service/memory.stat
# anon 104857600             # Anonymous memory (heap, stack)
# file 52428800              # File-backed memory (page cache)
# kernel_stack 2097152       # Kernel stack memory
# pagetables 1048576         # Page tables
# percpu 131072              # Per-CPU memory
# sock 0                     # Socket buffers
# vmalloc 0                  # vmalloc memory
# shmem 0                    # Shared memory
# zswap 0
# zswapped 0
# file_mapped 26214400       # Mapped file memory (mmap'd files)
# file_dirty 0               # Dirty pages waiting to be written
# file_writeback 0
# anon_thp 0                 # Transparent huge pages (anonymous)
# file_thp 0
# shmem_thp 0
# inactive_anon 0
# active_anon 104857600
# inactive_file 26214400
# active_file 26214400
# unevictable 0
# slab_reclaimable 8388608   # Reclaimable slab memory (dentries, inodes)
# slab_unreclaimable 4194304 # Unreclaimable slab memory
# slab 12582912
# pgfault 12345              # Total page faults
# pgmajfault 0               # Major page faults (I/O required)
# pgrefill 0
# pgscan 0
# pgsteal 0
# pgactivate 0
# pgdeactivate 0
# pglazyfree 0
# pglazyfreed 0
# thp_fault_alloc 0
# thp_collapse_alloc 0
# workingset_refault_anon 0
# workingset_refault_file 0
# workingset_activate_anon 0
# workingset_activate_file 0
# workingset_restore_anon 0
# workingset_restore_file 0
# workingset_nodereclaim 0
```

```bash
# Current memory usage (RSS + cache)
cat /sys/fs/cgroup/my-service/memory.current
# 157286400 (150 MiB)

# Peak memory usage since cgroup creation
cat /sys/fs/cgroup/my-service/memory.peak
# 209715200 (200 MiB)

# Swap usage
cat /sys/fs/cgroup/my-service/memory.swap.current
cat /sys/fs/cgroup/my-service/memory.swap.max
```

### OOM Behavior

```bash
# Check OOM kill events
cat /sys/fs/cgroup/my-service/memory.events
# low 0         # times usage crossed below memory.low
# high 5        # times usage crossed above memory.high (soft throttle)
# max 0         # times usage hit memory.max (direct reclaim)
# oom 1         # times OOM killer was invoked
# oom_kill 1    # processes killed by OOM
# oom_group_kill 0  # times the OOM group was killed

# Disable OOM kill and return ENOMEM instead (useful for batch jobs)
echo 1 > /sys/fs/cgroup/my-service/memory.oom.group

# When OOM group is enabled, all processes in the cgroup are killed together
# This is safer for multi-process containers
```

## Pressure Stall Information (PSI)

PSI is the most operationally valuable feature of cgroups v2. It measures the fraction of time processes were stalled waiting for a resource (CPU, memory, or I/O). PSI provides early warning before resources become fully exhausted.

### Understanding PSI Metrics

```bash
# CPU pressure
cat /sys/fs/cgroup/my-service/cpu.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# Memory pressure
cat /sys/fs/cgroup/my-service/memory.pressure
# some avg10=2.45 avg60=1.23 avg300=0.67 total=12345678
# full avg10=0.12 avg60=0.05 avg300=0.02 total=234567

# IO pressure
cat /sys/fs/cgroup/my-service/io.pressure
# some avg10=5.23 avg60=3.12 avg300=1.45 total=45678901
# full avg10=1.23 avg60=0.67 avg300=0.34 total=5678901
```

**some**: At least one task in the cgroup was stalled (other tasks may still be running).
**full**: All runnable tasks were stalled simultaneously (100% stall means nothing is making progress).
**avg10/avg60/avg300**: Exponential moving averages over 10, 60, and 300 seconds (percentages).
**total**: Cumulative stall time in microseconds since cgroup creation.

### Interpreting PSI Values

| PSI Value | Interpretation |
|---|---|
| memory.pressure some avg10 < 5 | Normal operation, occasional page reclaim |
| memory.pressure some avg10 5-20 | Light memory pressure, monitor |
| memory.pressure some avg10 > 20 | Significant memory pressure, consider scaling |
| memory.pressure full avg10 > 0 | Critical: all processes stalled on memory I/O |
| cpu.pressure some avg10 > 50 | Significant CPU throttling |
| io.pressure full avg10 > 20 | Severe I/O bottleneck |

### PSI Thresholds for Automated Response

cgroups v2 allows setting PSI thresholds that trigger a notification via a file descriptor:

```bash
# Set a PSI threshold notification:
# Trigger when memory stall exceeds 100ms per 1000ms window (10%)
# The kernel writes to the fd when the threshold is crossed

# In shell (simplified example):
# Open the memory.pressure file and write the threshold
fd=$(exec 3>/sys/fs/cgroup/my-service/memory.pressure && echo 3)
echo "some 100000 1000000" >&3
# Poll fd for readability to detect threshold crossing
```

In Go:

```go
// PSI threshold monitoring
package psi

import (
	"fmt"
	"os"
	"syscall"
	"time"
)

// Threshold configures a PSI notification threshold.
type Threshold struct {
	// CgroupPath is the path to the cgroup (e.g., /sys/fs/cgroup/my-service)
	CgroupPath string
	// Resource is "cpu", "memory", or "io"
	Resource string
	// Type is "some" or "full"
	Type string
	// Threshold is the stall threshold in microseconds per window
	Threshold time.Duration
	// Window is the observation window
	Window time.Duration
	// OnExceeded is called when the threshold is exceeded
	OnExceeded func(resource, typ string)
}

// Monitor sets up a PSI threshold and calls OnExceeded when triggered.
func Monitor(t Threshold) error {
	pressurePath := fmt.Sprintf("%s/%s.pressure", t.CgroupPath, t.Resource)

	f, err := os.OpenFile(pressurePath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("opening %s: %w", pressurePath, err)
	}

	thresholdSpec := fmt.Sprintf("%s %d %d\n",
		t.Type,
		t.Threshold.Microseconds(),
		t.Window.Microseconds(),
	)

	if _, err := f.WriteString(thresholdSpec); err != nil {
		f.Close()
		return fmt.Errorf("setting PSI threshold: %w", err)
	}

	go func() {
		defer f.Close()
		fd := int(f.Fd())

		for {
			// Poll the file descriptor using epoll
			epfd, err := syscall.EpollCreate1(0)
			if err != nil {
				return
			}

			event := syscall.EpollEvent{
				Events: syscall.EPOLLIN | syscall.EPOLLPRI,
				Fd:     int32(fd),
			}
			syscall.EpollCtl(epfd, syscall.EPOLL_CTL_ADD, fd, &event)

			events := make([]syscall.EpollEvent, 1)
			n, err := syscall.EpollWait(epfd, events, -1)
			syscall.Close(epfd)

			if err != nil || n == 0 {
				return
			}

			if t.OnExceeded != nil {
				t.OnExceeded(t.Resource, t.Type)
			}
		}
	}()

	return nil
}
```

## I/O Controller

```bash
# List I/O device identifiers (major:minor)
ls -la /dev/sda /dev/nvme0n1 2>/dev/null || lsblk

# Read current I/O statistics per device
cat /sys/fs/cgroup/my-service/io.stat
# 8:0 rbytes=10485760 wbytes=5242880 rios=1024 wios=512 dbytes=0 dios=0

# Set I/O weight (proportional, like CPU weight)
# Range: 1-10000, default 100
echo "8:0 200" > /sys/fs/cgroup/my-service/io.weight

# Set hard I/O limits (bandwidth and IOPS)
# Format: MAJOR:MINOR limit
echo "8:0 rbps=104857600" > /sys/fs/cgroup/my-service/io.max  # 100MB/s read
echo "8:0 wbps=52428800"  >> /sys/fs/cgroup/my-service/io.max # 50MB/s write
echo "8:0 riops=1000"     >> /sys/fs/cgroup/my-service/io.max # 1000 read IOPS
echo "8:0 wiops=500"      >> /sys/fs/cgroup/my-service/io.max # 500 write IOPS

# Remove a specific limit
echo "8:0 rbps=max" >> /sys/fs/cgroup/my-service/io.max
```

## PID Controller

Limits the number of processes and threads in a cgroup:

```bash
# Current PID count
cat /sys/fs/cgroup/my-service/pids.current
# 24

# Maximum PIDs (prevents fork bombs)
cat /sys/fs/cgroup/my-service/pids.max
# max

# Set limit to 256 processes
echo 256 > /sys/fs/cgroup/my-service/pids.max

# Events (when limit is hit)
cat /sys/fs/cgroup/my-service/pids.events
# max 0  # times the limit was hit
```

## How Kubernetes Uses cgroups v2

Kubernetes translates pod resource specifications directly into cgroup settings.

### CPU Requests and Limits

```yaml
resources:
  requests:
    cpu: "500m"   # 0.5 CPU cores
  limits:
    cpu: "2"      # 2 CPU cores
```

Translates to:
- `cpu.weight = max(2, min(262144, 500 * 1024 / 1000)) = 512`
- `cpu.max = "200000 100000"` (200ms quota per 100ms period = 2 CPU cores)

### Memory Requests and Limits

```yaml
resources:
  requests:
    memory: "256Mi"
  limits:
    memory: "512Mi"
```

Translates to:
- `memory.min = 268435456` (256 MiB — kernel won't reclaim below this)
- `memory.max = 536870912` (512 MiB — OOM kill if exceeded)

Note: `memory.high` is not currently set by Kubernetes for normal pods. The container goes directly from `memory.min` to `memory.max` with no soft limit.

### Viewing Kubernetes Cgroup Structure

```bash
# Find the cgroup for a specific pod
POD_UID=$(kubectl get pod my-pod -o jsonpath='{.metadata.uid}')
CONTAINER_ID=$(kubectl get pod my-pod -o jsonpath='{.status.containerStatuses[0].containerID}' | cut -d/ -f3)

# On the node (requires node access)
find /sys/fs/cgroup -name "*${POD_UID}*" -type d 2>/dev/null

# Common paths (depends on kubelet cgroup driver):
# cgroup driver: cgroupfs
ls /sys/fs/cgroup/kubepods/

# cgroup driver: systemd
ls /sys/fs/cgroup/system.slice/

# Read the pod's memory limit
find /sys/fs/cgroup -path "*${POD_UID}*" -name "memory.max" -exec cat {} \;

# Read CPU throttling stats
find /sys/fs/cgroup -path "*${POD_UID}*" -name "cpu.stat" -exec cat {} \;
```

### Kubernetes Quality of Service and cgroups

Kubernetes QoS classes map directly to cgroup placement:

```
/sys/fs/cgroup/kubepods/                     # All pods
├── guaranteed/                              # Guaranteed QoS pods
│   └── pod<uid>/                           # Pod cgroup
│       └── <container-id>/                # Container cgroup
├── burstable/                               # Burstable QoS pods
│   └── pod<uid>/
└── besteffort/                              # BestEffort QoS pods
    └── pod<uid>/
```

- **Guaranteed**: `cpu.weight = 1024 * request`, `cpu.max = limit`, `memory.min = request`, `memory.max = limit`
- **Burstable**: Same as Guaranteed but lower cpu.weight base
- **BestEffort**: `cpu.weight = 2` (minimum), no memory limits

### Verifying cgroup Configuration for a Running Container

```bash
# Using crictl on the node
crictl inspect <container-id> | jq '.info.runtimeSpec.linux.resources'

# This shows the OCI spec that containerd translates to cgroup settings:
{
  "cpu": {
    "shares": 512,          # cpu.weight
    "quota": 200000,        # cpu.max quota
    "period": 100000        # cpu.max period
  },
  "memory": {
    "limit": 536870912,     # memory.max
    "reservation": 268435456  # memory.min
  },
  "pids": {
    "limit": 0              # pids.max (0 = unlimited for containers by default)
  }
}
```

## Diagnosing Resource Issues with cgroups v2

### Diagnosing CPU Throttling

```bash
#!/bin/bash
# check-cpu-throttling.sh: Find containers with high CPU throttling

echo "Container CPU Throttling Report"
echo "================================"

# Find all Kubernetes container cgroups
find /sys/fs/cgroup/kubepods -name "cpu.stat" | while read stat_file; do
  cgroup_path=$(dirname "$stat_file")

  nr_periods=$(grep "^nr_periods" "$stat_file" | awk '{print $2}')
  nr_throttled=$(grep "^nr_throttled" "$stat_file" | awk '{print $2}')
  throttled_usec=$(grep "^throttled_usec" "$stat_file" | awk '{print $2}')

  if [[ "$nr_periods" -gt 0 && "$nr_throttled" -gt 0 ]]; then
    throttle_pct=$(awk "BEGIN { printf \"%.1f\", $nr_throttled / $nr_periods * 100 }")

    if (( $(echo "$throttle_pct > 5.0" | bc -l) )); then
      echo "High throttling: ${throttle_pct}% | ${cgroup_path}"
      echo "  Throttled: ${nr_throttled}/${nr_periods} periods | ${throttled_usec}us stalled"

      # Try to correlate to a pod
      pod_uid=$(echo "$cgroup_path" | grep -oP 'pod[a-f0-9-]{36}' | head -1)
      if [[ -n "$pod_uid" ]]; then
        echo "  Pod UID: $pod_uid"
      fi
    fi
  fi
done
```

### Memory Pressure Monitoring Script

```bash
#!/bin/bash
# monitor-memory-pressure.sh: Report cgroup memory pressure

echo "Memory Pressure Report (avg10 > 5%)"
echo "====================================="

find /sys/fs/cgroup -name "memory.pressure" | while read pressure_file; do
  cgroup=$(dirname "$pressure_file")

  some_avg10=$(grep "^some" "$pressure_file" | grep -oP 'avg10=\K[\d.]+')
  full_avg10=$(grep "^full" "$pressure_file" | grep -oP 'avg10=\K[\d.]+')

  if (( $(echo "${some_avg10:-0} > 5.0" | bc -l) )); then
    echo "Pressure: some=${some_avg10}% full=${full_avg10}% | $cgroup"

    # Show memory usage and limits
    if [[ -f "$cgroup/memory.current" ]]; then
      current=$(cat "$cgroup/memory.current")
      max=$(cat "$cgroup/memory.max")
      echo "  Usage: $((current / 1024 / 1024))MiB / $([ "$max" = "max" ] && echo "unlimited" || echo "$((max / 1024 / 1024))MiB")"
    fi
  fi
done
```

## cgroup Delegation for Rootless Containers

cgroups v2 supports delegating subtree management to non-root users, enabling rootless containers:

```bash
# systemd-based delegation (recommended)
# In a user session, systemd creates a cgroup at:
# /sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/

# Verify delegation is enabled
cat /sys/fs/cgroup/user.slice/user-1000.slice/cgroup.controllers
# cpu memory pids  (if delegation is enabled)

# Enable delegation in the system configuration
cat > /etc/systemd/system/user@.service.d/delegate.conf << 'EOF'
[Service]
Delegate=yes
EOF
systemctl daemon-reload

# Now rootless containers (podman, etc.) can manage their own cgroup subtree
# without requiring any elevated privileges
```

## Configuring the Kubelet cgroup Driver

```yaml
# kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd        # or "cgroupfs"
cgroupVersion: v2
# For cgroups v2, systemd is strongly recommended:
# - Avoids dual-management conflicts
# - Proper lifecycle management
# - Delegation support for rootless
systemCgroups: /system.slice
kubeletCgroups: /system.slice/kubelet.service
```

Verify the kubelet is using cgroups v2:

```bash
kubectl get node <node-name> -o json | \
  jq '.status.conditions[] | select(.type=="MemoryPressure")'

# On the node
cat /proc/1/cgroup
# 0::/init.scope  (cgroups v2 - single hierarchy, controller 0)
# If you see multiple lines with controller numbers, it's v1 or hybrid
```

## Conclusion

cgroups v2's unified hierarchy, pressure metrics, and delegation model make it a substantially more capable resource management framework than v1. For Kubernetes platform teams, the most immediately actionable knowledge is understanding how CPU throttling appears in `cpu.stat`, how PSI metrics provide early warning of resource contention before applications begin failing, and how Kubernetes QoS classes translate into concrete cgroup configuration. Periodic inspection of CPU throttling across running pods (especially for latency-sensitive services) routinely reveals that pods are hitting their CPU limits even when average utilization appears low — a situation that produces tail latency spikes invisible to average-based metrics but clearly visible in `nr_throttled`.
