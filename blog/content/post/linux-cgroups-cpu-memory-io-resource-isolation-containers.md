---
title: "Linux Control Groups: CPU Scheduling, Memory Limits, and I/O Throttling"
date: 2030-05-26T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "Containers", "Performance", "Kubernetes", "Resource Management", "Kernel"]
categories:
- Linux
- Kubernetes
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux cgroup controllers: CPU shares vs CFS quotas, memory soft/hard limits, blkio throttling, cgroup hierarchies, and practical resource isolation for containerized workloads."
more_link: "yes"
url: "/linux-cgroups-cpu-memory-io-resource-isolation-containers/"
---

Linux Control Groups (cgroups) form the kernel-level foundation of every container runtime, Kubernetes pod resource limit, and systemd service constraint in production infrastructure. Understanding cgroup mechanics moves operators from treating containers as black boxes to precisely diagnosing resource contention, tuning scheduler behavior, and preventing the cascading failures that result from incorrect limit configurations.

This guide covers both cgroup v1 (still present in many production distributions) and cgroup v2 (unified hierarchy, default in kernel 5.4+ and required by Kubernetes 1.25+), with practical examples for containerized workloads.

<!--more-->

## cgroup Architecture

### v1 vs v2 Hierarchy

cgroup v1 uses a separate hierarchy per controller, mounted at individual paths under `/sys/fs/cgroup/`:

```
/sys/fs/cgroup/
├── cpu/
│   └── kubepods/
│       └── pod-abc123/
│           └── container-def456/
├── memory/
│   └── kubepods/
│       └── pod-abc123/
│           └── container-def456/
├── blkio/
│   └── kubepods/
└── devices/
    └── kubepods/
```

cgroup v2 unifies all controllers under a single hierarchy:

```
/sys/fs/cgroup/
└── kubepods.slice/
    └── kubepods-pod-abc123.slice/
        └── container-def456.scope/
            ├── cpu.max
            ├── memory.max
            ├── io.max
            └── cgroup.controllers
```

### Verify cgroup Version

```bash
# Check which cgroup version is in use
stat -fc %T /sys/fs/cgroup/
# cgroup2fs = v2
# tmpfs     = v1

# Hybrid mode (v1 + v2)
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)

# Check Kubernetes node cgroup driver
cat /var/lib/kubelet/config.yaml | grep cgroupDriver
# cgroupDriver: systemd

# Inspect a running container's cgroup path
cat /proc/$(pgrep nginx | head -1)/cgroup
# 0::/kubepods.slice/kubepods-besteffort.slice/pod-abc123.slice/container-def456.scope
```

## CPU Controller

### CPU Shares (cgroup v1)

CPU shares implement proportional CPU allocation. Shares are relative—a container with 1024 shares receives twice the CPU time of one with 512 shares *when the system is under contention*.

```bash
# View current CPU shares for a running container
CONTAINER_ID="def456abc789"
PID=$(docker inspect --format '{{.State.Pid}}' $CONTAINER_ID)
cat /proc/$PID/cgroup | grep cpu

# Read current shares
cat /sys/fs/cgroup/cpu/kubepods/pod-abc123/$CONTAINER_ID/cpu.shares
# 102  (10% of 1024 base = ~100m CPU in Kubernetes)

# Set CPU shares directly (for testing)
echo 512 > /sys/fs/cgroup/cpu/my-test-cgroup/cpu.shares
```

The mapping from Kubernetes CPU requests to cgroup shares:
- Kubernetes: `100m` (100 millicores) = 102 shares
- Kubernetes: `500m` = 512 shares
- Kubernetes: `1000m` (1 CPU) = 1024 shares
- Formula: `shares = max(2, floor(milliCPU * 1024 / 1000))`

### CFS Bandwidth Control (CPU Limits)

CFS (Completely Fair Scheduler) bandwidth control implements hard CPU limits via a quota/period mechanism. During each period, a cgroup may only run for `cpu.cfs_quota_us` microseconds.

```bash
# Default period: 100ms = 100000 microseconds
cat /sys/fs/cgroup/cpu/kubepods/pod-abc123/container-def456/cpu.cfs_period_us
# 100000

# Quota: -1 means unlimited; positive value = CPU limit
cat /sys/fs/cgroup/cpu/kubepods/pod-abc123/container-def456/cpu.cfs_quota_us
# 50000   # 50ms quota in 100ms period = 0.5 CPU = 500m

# For multi-core limits:
# 2 CPUs = 200000 quota in 100000 period
echo 200000 > /sys/fs/cgroup/cpu/my-cgroup/cpu.cfs_quota_us
```

Kubernetes CPU limit to CFS quota mapping:
- `500m` limit: quota=50000, period=100000
- `2000m` (2 CPU) limit: quota=200000, period=100000
- `0` (no limit): quota=-1

### cgroup v2 CPU Controller

In cgroup v2, `cpu.max` replaces `cpu.cfs_quota_us` and `cpu.cfs_period_us`:

```bash
# Format: "quota period"
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/cpu.max
# 50000 100000   # 500m limit

# "max" means unlimited
cat /sys/fs/cgroup/kubepods.slice/pod-qos-guaranteed.slice/cpu.max
# max 100000

# CPU weight (replaces shares, range 1-10000, default 100)
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/cpu.weight
# 10    # ~100m request
```

### CPU Throttling Diagnosis

CPU throttling is the primary performance issue caused by CPU limits in Kubernetes. When a container exhausts its CFS quota, it is throttled for the remainder of the period.

```bash
# Check CPU throttling statistics (v1)
cat /sys/fs/cgroup/cpu/kubepods/pod-abc123/container-def456/cpu.stat
# nr_periods 45823          -- number of CFS periods elapsed
# nr_throttled 12541        -- periods where the cgroup was throttled
# throttled_time 25832941   -- total nanoseconds throttled

# Calculate throttling percentage
awk '
/nr_periods/ { periods=$2 }
/nr_throttled/ { throttled=$2 }
END { printf "Throttle rate: %.1f%%\n", (throttled/periods)*100 }
' /sys/fs/cgroup/cpu/kubepods/pod-abc123/container-def456/cpu.stat
# Throttle rate: 27.4%

# cgroup v2 equivalent
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/cpu.stat
# usage_usec 82341234
# user_usec 71234123
# system_usec 11107111
# nr_periods 45823
# nr_throttled 12541
# throttled_usec 25832941
# nr_burst 0
# burst_usec 0
```

Prometheus query to detect throttled pods (using container_cpu_cfs_throttled_periods_total):

```yaml
# Alert: container CPU throttled more than 25% of periods
- alert: ContainerCPUThrottling
  expr: |
    rate(container_cpu_cfs_throttled_periods_total{container!=""}[5m])
    /
    rate(container_cpu_cfs_periods_total{container!=""}[5m])
    > 0.25
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "Container {{ $labels.container }} in pod {{ $labels.pod }} is CPU throttled"
    description: "CPU throttle rate is {{ printf \"%.0f\" (mul $value 100) }}%"
```

### CPU Pinning with cpuset

For latency-sensitive workloads, `cpuset` prevents scheduler migrations between CPUs:

```bash
# Create a cpuset cgroup pinned to CPUs 0-3 on NUMA node 0
mkdir /sys/fs/cgroup/cpuset/latency-sensitive
echo "0-3" > /sys/fs/cgroup/cpuset/latency-sensitive/cpuset.cpus
echo "0"   > /sys/fs/cgroup/cpuset/latency-sensitive/cpuset.mems
echo $$ > /sys/fs/cgroup/cpuset/latency-sensitive/tasks

# Kubernetes equivalent: CPU Manager static policy
# requires Guaranteed QoS (requests == limits) and integer CPU count
# kubelet --cpu-manager-policy=static
```

## Memory Controller

### Memory Limits and OOM Behavior

The memory controller enforces both soft limits (advisory) and hard limits (enforced with OOM kill).

```bash
# Hard memory limit (OOM kill when exceeded)
cat /sys/fs/cgroup/memory/kubepods/pod-abc123/container-def456/memory.limit_in_bytes
# 536870912   # 512Mi in bytes

# Soft memory limit (does not trigger OOM, but influences reclaim priority)
cat /sys/fs/cgroup/memory/kubepods/pod-abc123/container-def456/memory.soft_limit_in_bytes
# 268435456   # 256Mi

# Current memory usage
cat /sys/fs/cgroup/memory/kubepods/pod-abc123/container-def456/memory.usage_in_bytes
# 423624704   # ~404Mi

# Memory + swap limit (-1 means disabled, memory-only limit)
cat /sys/fs/cgroup/memory/kubepods/pod-abc123/container-def456/memory.memsw.limit_in_bytes
# 536870912   # Same as memory.limit — swap disabled
```

### Memory Statistics

`memory.stat` provides a detailed breakdown of memory usage categories:

```bash
cat /sys/fs/cgroup/memory/kubepods/pod-abc123/container-def456/memory.stat
# cache 125829120         -- page cache (reclaimable)
# rss 297795584           -- anonymous memory (resident set size)
# rss_huge 0              -- huge pages in RSS
# shmem 0                 -- shared memory
# mapped_file 41943040    -- memory-mapped files
# dirty 4096
# writeback 0
# swap 0
# pgpgin 4521308          -- pages paged in from disk
# pgpgout 4432150         -- pages paged out to disk
# pgfault 2341234
# pgmajfault 823          -- major page faults (disk reads)
# inactive_anon 0
# active_anon 297795584
# inactive_file 83886080
# active_file 41943040
# unevictable 0
# hierarchical_memory_limit 536870912
# total_cache 125829120
# total_rss 297795584
```

### cgroup v2 Memory Interface

```bash
# Hard limit
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.max
# 536870912

# Soft limit (replaced by memory.high in v2)
# memory.high triggers reclaim before OOM
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.high
# 483183820   # ~90% of limit — triggers throttling before hard OOM

# Low watermark (kernel tries to keep available below this)
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.low
# 268435456   # memory request value

# Current usage
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.current
# 423624704

# OOM kill events
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.events
# low 0
# high 23        -- throttling events (hit memory.high)
# max 0          -- hit memory.max but reclaim prevented OOM
# oom 0
# oom_kill 0
# oom_group_kill 0
```

### Memory Pressure and PSI

Pressure Stall Information (PSI) measures the fraction of time tasks are stalled waiting for memory:

```bash
# Available in cgroup v2 and kernel 4.20+
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.pressure
# some avg10=0.12 avg60=0.08 avg300=0.03 total=823410
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# "some" = at least one task stalled
# "full" = all tasks stalled (more severe)
# avg10/60/300 = 10s/60s/5min averages as percentages
```

### Setting cgroup Memory Parameters Programmatically

```bash
#!/bin/bash
# memory-cgroup-setup.sh
# Set up a cgroup with specific memory limits for a workload

CGROUP_NAME="webapp-prod"
MEMORY_LIMIT_MB=512
MEMORY_REQUEST_MB=256

if [ -d "/sys/fs/cgroup/cgroup2" ]; then
    # cgroup v2
    CGROUP_PATH="/sys/fs/cgroup/${CGROUP_NAME}"
    mkdir -p "${CGROUP_PATH}"

    echo "+memory" > /sys/fs/cgroup/cgroup.subtree_control
    echo "$((MEMORY_LIMIT_MB * 1024 * 1024))"   > "${CGROUP_PATH}/memory.max"
    echo "$((MEMORY_REQUEST_MB * 1024 * 1024))"  > "${CGROUP_PATH}/memory.low"
    # memory.high = 90% of limit to trigger reclaim before OOM
    echo "$(( MEMORY_LIMIT_MB * 1024 * 1024 * 9 / 10 ))" > "${CGROUP_PATH}/memory.high"
else
    # cgroup v1
    CGROUP_PATH="/sys/fs/cgroup/memory/${CGROUP_NAME}"
    mkdir -p "${CGROUP_PATH}"

    echo "$((MEMORY_LIMIT_MB * 1024 * 1024))"  > "${CGROUP_PATH}/memory.limit_in_bytes"
    echo "$((MEMORY_REQUEST_MB * 1024 * 1024))" > "${CGROUP_PATH}/memory.soft_limit_in_bytes"
    # Disable swap
    echo "$((MEMORY_LIMIT_MB * 1024 * 1024))"  > "${CGROUP_PATH}/memory.memsw.limit_in_bytes"
fi
```

## I/O Throttling with blkio and io Controllers

### cgroup v1 blkio Controller

blkio throttling limits read/write throughput or IOPS per block device:

```bash
# Get device major:minor numbers
ls -la /dev/sda
# brw-rw---- 1 root disk 8, 0 ...   -> major=8, minor=0

# Read throughput limit: 100 MB/s on /dev/sda
echo "8:0 104857600" > /sys/fs/cgroup/blkio/my-cgroup/blkio.throttle.read_bps_device

# Write throughput limit: 50 MB/s
echo "8:0 52428800" > /sys/fs/cgroup/blkio/my-cgroup/blkio.throttle.write_bps_device

# Read IOPS limit: 1000 IOPS
echo "8:0 1000" > /sys/fs/cgroup/blkio/my-cgroup/blkio.throttle.read_iops_device

# Write IOPS limit: 500 IOPS
echo "8:0 500" > /sys/fs/cgroup/blkio/my-cgroup/blkio.throttle.write_iops_device

# View blkio statistics
cat /sys/fs/cgroup/blkio/my-cgroup/blkio.throttle.io_service_bytes
# 8:0 Read 524288000
# 8:0 Write 209715200
# Total 733954048 -- 0

cat /sys/fs/cgroup/blkio/my-cgroup/blkio.io_wait_time
# 8:0 Read 2341234000   -- nanoseconds waiting for I/O
# 8:0 Write 512341000
```

### cgroup v2 io Controller

The v2 `io` controller unifies throttling and weight-based scheduling:

```bash
# Set I/O max (throttling) on /dev/nvme0n1 (major:minor = 259:0)
# Format: "MAJ:MIN rbps=BYTES wbps=BYTES riops=IOPS wiops=IOPS"
echo "259:0 rbps=104857600 wbps=52428800 riops=1000 wiops=500" \
    > /sys/fs/cgroup/my-cgroup/io.max

# View current I/O stats
cat /sys/fs/cgroup/my-cgroup/io.stat
# 259:0 rbytes=524288000 wbytes=209715200 rios=12341 wios=5234 dbytes=0 dios=0

# I/O weight for BFQ scheduler (1-10000, default 100)
echo "259:0 100" > /sys/fs/cgroup/my-cgroup/io.weight

# Pressure information
cat /sys/fs/cgroup/my-cgroup/io.pressure
# some avg10=2.34 avg60=1.23 avg300=0.45 total=12341234
# full avg10=0.12 avg60=0.08 avg300=0.02 total=823410
```

### Container I/O Limits in Docker

```bash
# Docker passes blkio parameters directly
docker run \
    --device-read-bps /dev/sda:100mb \
    --device-write-bps /dev/sda:50mb \
    --device-read-iops /dev/sda:1000 \
    --device-write-iops /dev/sda:500 \
    --name io-limited \
    nginx:latest

# Verify blkio settings were applied
docker inspect io-limited | \
    python3 -c "import sys, json; d=json.load(sys.stdin)[0]; print(json.dumps(d['HostConfig']['BlkioDeviceReadBps'], indent=2))"
```

### Kubernetes StorageClass and I/O QoS

Kubernetes does not expose blkio limits directly in Pod specs, but some container runtimes and plugins support annotations:

```yaml
# containerd + some storage drivers support I/O limit annotations
apiVersion: v1
kind: Pod
metadata:
  name: io-limited-pod
  annotations:
    # containerd shim may read these
    io.kubernetes.cri.blkio-weight: "100"
spec:
  containers:
    - name: app
      image: registry.internal.example.com/app:latest
      resources:
        requests:
          storage: "10Gi"
        limits:
          storage: "10Gi"
      # ephemeral-storage limits do trigger eviction but not blkio throttling
```

For robust I/O limits in Kubernetes, use a CSI driver that supports StorageClass parameters:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: high-iops-ssd
provisioner: ebs.csi.aws.com
parameters:
  type: io2
  iops: "10000"
  throughput: "1000"
  fsType: ext4
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

## cgroup Hierarchies and Kubernetes QoS

### Kubernetes QoS Class Mapping

Kubernetes maps pods to cgroup hierarchies based on their QoS class:

```
/sys/fs/cgroup/                          (root)
└── kubepods.slice/                      (all pods)
    ├── kubepods-guaranteed.slice/       (Guaranteed QoS)
    │   └── pod<uid>.slice/
    ├── kubepods-burstable.slice/        (Burstable QoS)
    │   └── pod<uid>.slice/
    └── kubepods-besteffort.slice/       (BestEffort QoS)
        └── pod<uid>.slice/
```

```bash
# View the cgroup hierarchy for all pods on a node
systemd-cgls /sys/fs/cgroup/kubepods.slice

# Find which QoS class a pod is in
kubectl get pod my-pod -o jsonpath='{.status.qosClass}'
# Burstable

# Verify the pod's cgroup path on the node
POD_UID=$(kubectl get pod my-pod -o jsonpath='{.metadata.uid}')
systemd-cgls "/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod${POD_UID}.slice"
```

### Node-Level Resource Reservation

Kubernetes reserves resources for system processes and kubelet via cgroup limits:

```bash
# View kubelet reserved resources
cat /var/lib/kubelet/config.yaml | grep -A5 "systemReserved\|kubeReserved"
# kubeReserved:
#   cpu: "100m"
#   memory: "128Mi"
# systemReserved:
#   cpu: "100m"
#   memory: "256Mi"

# These translate to cgroup limits on system.slice and kubelet.service
systemctl show kubelet.service -p MemoryLimit
# MemoryLimit=134217728  # 128Mi

# View the kubepods cgroup limit (allocatable = capacity - reserved)
cat /sys/fs/cgroup/kubepods.slice/memory.max
# 8053063680   # ~7.5Gi (total 8Gi - reserved 512Mi)
```

## Practical Debugging Scenarios

### Scenario 1: Application OOM Killed

```bash
# Check kernel logs for OOM events
dmesg -T | grep -E "oom|killed" | tail -20

# More detailed OOM report
journalctl -k --since "1 hour ago" | grep -i "oom\|killed process"

# Check container OOM kill counter (v2)
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.events
# oom_kill 3

# Find what process was killed
journalctl -k | grep "Killed process"
# Killed process 12345 (java) total-vm:4194304kB, anon-rss:524288kB

# In Kubernetes
kubectl describe pod my-pod | grep -A3 "OOMKilled\|Last State"
# Last State: Terminated
#   Reason:   OOMKilled
#   Exit Code: 137
```

### Scenario 2: Unexpected CPU Throttling

```bash
#!/bin/bash
# find-throttled-containers.sh
# Scan all container cgroups for significant CPU throttling

for cgroup in /sys/fs/cgroup/cpu/kubepods/**/cpu.stat; do
    [[ -f "$cgroup" ]] || continue

    periods=$(grep nr_periods "$cgroup" | awk '{print $2}')
    throttled=$(grep nr_throttled "$cgroup" | awk '{print $2}')

    [[ "$periods" -gt 0 ]] || continue

    rate=$(awk "BEGIN {printf \"%.1f\", ($throttled/$periods)*100}")

    if (( $(echo "$rate > 10.0" | bc -l) )); then
        container=$(dirname "$cgroup" | xargs -I{} basename {})
        echo "THROTTLED: $container throttle_rate=${rate}% periods=$periods throttled=$throttled"
    fi
done
```

### Scenario 3: Memory Pressure Without OOM

When a container is experiencing memory pressure (high-watermark reclaim) but not yet OOM-killed:

```bash
# Check major page faults (indicates swapping or demand paging)
cat /sys/fs/cgroup/memory/kubepods/pod-abc123/container-def456/memory.stat | grep pgmajfault
# pgmajfault 1847   -- high value indicates memory pressure

# PSI memory pressure (v2)
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.pressure
# some avg10=15.23 avg60=12.34 avg300=8.45 total=45234567
# -- 15% of wall clock time some task is stalled on memory

# Check if the container is hitting memory.high (soft throttling)
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.events
# high 4523   -- container has been throttled by memory.high 4523 times
```

## cgroup v2 Migration for Kubernetes

Kubernetes 1.25+ requires cgroup v2 when using systemd cgroup driver. Migration steps for production nodes:

```bash
# 1. Verify kernel supports cgroup v2 (5.4+)
uname -r
# 5.15.0-91-generic

# 2. Add kernel parameter to boot configuration
# For GRUB:
cat /etc/default/grub | grep CMDLINE
# GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"
update-grub

# 3. Verify kubelet configuration
cat /var/lib/kubelet/config.yaml
# cgroupDriver: systemd  # must be systemd, not cgroupfs

# 4. After reboot, verify cgroup v2 is active
stat -fc %T /sys/fs/cgroup/
# cgroup2fs

# 5. Verify controllers are available
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc
```

## Summary

Linux cgroups provide the resource isolation infrastructure that makes containers and Kubernetes multi-tenancy possible. CPU shares control proportional access to CPU time under contention, while CFS quotas impose hard limits that can cause throttling when misconfigured. Memory limits prevent workloads from consuming unbounded memory at the cost of OOM kill events when limits are set too low. I/O throttling prevents a single disk-heavy workload from starving others.

Production operations require regular inspection of cgroup statistics—CPU throttling rates, memory high-watermark events, and I/O wait times—to detect and resolve resource allocation issues before they manifest as application failures. The migration from cgroup v1 to v2 brings a unified interface and PSI metrics that make pressure detection significantly more actionable.
