---
title: "Linux Control Groups v2: Unified Hierarchy and Resource Management"
date: 2029-04-04T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "cgroup v2", "Kubernetes", "Containers", "Resource Management", "systemd"]
categories: ["Linux", "Containers", "Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux cgroup v2: unified hierarchy architecture, cpu/memory/io controllers, pressure stall information (PSI), systemd integration, and container resource accounting for Kubernetes nodes."
more_link: "yes"
url: "/linux-control-groups-v2-unified-hierarchy-resource-management/"
---

Control Groups (cgroups) are the kernel mechanism underlying every container runtime's resource management. Kubernetes uses them to enforce CPU limits, memory limits, and I/O constraints on every Pod. The v2 cgroup hierarchy (cgroup2) represents a fundamental redesign that fixes architectural problems in v1: a single unified hierarchy, thread-granular control, better memory accounting, and Pressure Stall Information (PSI) for resource pressure detection. As of kernel 5.2+, cgroup v2 is the recommended option and the default on modern Linux distributions.

<!--more-->

# Linux Control Groups v2: Unified Hierarchy and Resource Management

## Section 1: cgroup v1 vs v2 Architecture

### cgroup v1 Problems

cgroup v1 allowed multiple hierarchies, one per controller subsystem. This created complex interactions:

```
/sys/fs/cgroup/memory/    <- Memory controller hierarchy
/sys/fs/cgroup/cpu/       <- CPU controller hierarchy
/sys/fs/cgroup/cpuset/    <- CPU pinning hierarchy
/sys/fs/cgroup/blkio/     <- Block I/O hierarchy

# A process could be in different groups in each hierarchy
# No coordination between controllers
# Thread-granular process placement caused inconsistencies
```

### cgroup v2 Solution

```
/sys/fs/cgroup/           <- Single unified hierarchy
├── system.slice/
│   ├── docker.service/
│   │   ├── container-abc123/
│   │   └── container-def456/
│   └── kubelet.service/
├── user.slice/
└── machine.slice/

# All controllers managed in one tree
# Processes must be in leaf nodes (no internal process constraint)
# Thread-granular control explicit per-thread (not default)
# Better memory accounting (charges to correct cgroup)
```

### Checking cgroup Version

```bash
# Check which version is in use
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)

# Check kernel support
cat /proc/filesystems | grep cgroup
# nodev   cgroup
# nodev   cgroup2

# Verify cgroup v2 is mounted
ls /sys/fs/cgroup/
# cgroup.controllers  cgroup.events  cgroup.freeze  cgroup.max.depth
# cgroup.max.descendants  cgroup.pressure  cgroup.procs
# cgroup.stat  cgroup.subtree_control  cgroup.threads  cgroup.type
# ...

# Check if hybrid mode is active (v1+v2 coexist)
mount | grep cgroup
```

### Enabling cgroup v2 on Systems Still Using v1

```bash
# For systemd-based systems, set the kernel parameter
# Add to GRUB_CMDLINE_LINUX in /etc/default/grub:
GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"

# Or for hybrid mode:
GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=0 systemd.legacy_systemd_cgroup_controller=0"

# Update GRUB
update-grub  # Debian/Ubuntu
grub2-mkconfig -o /boot/grub2/grub.cfg  # RHEL/CentOS

# Reboot to apply
reboot
```

## Section 2: cgroup v2 Filesystem Interface

Every cgroup is a directory in the unified hierarchy. Files in each directory control and report the cgroup's state.

### Key Files

```bash
# Available controllers in the system
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# Controllers enabled for children of this cgroup
cat /sys/fs/cgroup/cgroup.subtree_control
# cpu io memory pids

# Processes directly in this cgroup
cat /sys/fs/cgroup/cgroup.procs

# All thread IDs in this cgroup
cat /sys/fs/cgroup/cgroup.threads
```

### Creating a cgroup

```bash
# Create a cgroup by making a directory
mkdir /sys/fs/cgroup/my-application

# Enable specific controllers for children
echo "+cpu +memory +io" > /sys/fs/cgroup/my-application/cgroup.subtree_control

# Create child cgroup
mkdir /sys/fs/cgroup/my-application/worker-1

# Move a process to the cgroup
echo $$ > /sys/fs/cgroup/my-application/worker-1/cgroup.procs

# Verify
cat /proc/$$/cgroup
# 0::/my-application/worker-1
```

## Section 3: CPU Controller

### CPU Weight-Based Scheduling

```bash
# Set CPU weight (nice-like, range 1-10000, default 100)
# Higher weight = more CPU share relative to siblings
echo 200 > /sys/fs/cgroup/my-app/cpu.weight

# This gives my-app 2x CPU share compared to a cgroup with weight 100
# When both are busy, my-app gets 2/3 of CPU, the other gets 1/3

# Read current weight
cat /sys/fs/cgroup/my-app/cpu.weight

# CPU weight in "nice" values (alternative interface)
echo 10 > /sys/fs/cgroup/my-app/cpu.weight.nice  # -20 to 19, same semantics as nice
```

### CPU Bandwidth Limiting (Hard Limits)

```bash
# Limit CPU bandwidth: allow 50ms of CPU per 100ms period
# = 50% of one CPU core
echo "50000 100000" > /sys/fs/cgroup/my-app/cpu.max
# Format: <quota> <period>  (both in microseconds)
# "max" means unlimited (default)

# Allow usage of 1.5 CPU cores (150% of one core)
echo "150000 100000" > /sys/fs/cgroup/my-app/cpu.max

# Disable bandwidth limit
echo "max 100000" > /sys/fs/cgroup/my-app/cpu.max

# Read statistics
cat /sys/fs/cgroup/my-app/cpu.stat
# usage_usec 12345678    <- Total CPU time used (microseconds)
# user_usec 9876543      <- User-space CPU time
# system_usec 2469135    <- Kernel CPU time
# nr_periods 12345       <- Number of accounting periods
# nr_throttled 234       <- How many times this group was throttled
# throttled_usec 5678901 <- Total time spent throttled
# nr_bursts 0
# burst_usec 0
```

### CPU Pinning with cpuset Controller

```bash
# Pin cgroup to specific CPUs and memory nodes
echo "0-3" > /sys/fs/cgroup/my-app/cpuset.cpus
echo "0" > /sys/fs/cgroup/my-app/cpuset.mems

# Partition mode for exclusive CPU access (RT workloads)
echo "root" > /sys/fs/cgroup/my-app/cpuset.cpus.partition
# Now CPUs 0-3 are exclusively available to this cgroup

# Read effective cpuset (after inheritance)
cat /sys/fs/cgroup/my-app/cpuset.cpus.effective
```

## Section 4: Memory Controller

The memory controller in cgroup v2 provides significantly better accounting than v1, correctly attributing shared memory pages to the appropriate cgroup.

### Memory Limits

```bash
# Set hard memory limit
# Process receives SIGKILL (via OOM killer) if exceeded
echo "512M" > /sys/fs/cgroup/my-app/memory.max

# Set soft memory limit (high watermark, triggers memory reclaim)
echo "256M" > /sys/fs/cgroup/my-app/memory.high

# Lower-priority limit used to discourage swapping
echo "200M" > /sys/fs/cgroup/my-app/memory.low

# Set swap limit (memory + swap combined)
echo "1G" > /sys/fs/cgroup/my-app/memory.swap.max

# Read current memory usage
cat /sys/fs/cgroup/my-app/memory.current
# 134217728  <- 128MB in bytes

# Read full memory statistics
cat /sys/fs/cgroup/my-app/memory.stat
```

### Reading Memory Statistics

```bash
cat /sys/fs/cgroup/my-app/memory.stat
# anon 67108864            <- Anonymous memory (not backed by files)
# file 33554432            <- File-backed memory (page cache)
# kernel 4194304           <- Kernel allocations
# kernel_stack 1048576     <- Kernel stack
# pagetables 524288        <- Page table memory
# sec_pagetables 0
# percpu 32768
# sock 0
# vmalloc 0
# shmem 8192               <- Shared memory
# zswap 0
# zswapped 0
# file_mapped 12288        <- Memory-mapped files
# file_dirty 4096          <- Dirty file pages
# file_writeback 0
# swapcached 0
# anon_thp 0               <- Anonymous transparent huge pages
# file_thp 0
# shmem_thp 0
# inactive_anon 16777216   <- LRU inactive anonymous
# active_anon 50331648     <- LRU active anonymous
# inactive_file 8388608    <- LRU inactive file
# active_file 25165824     <- LRU active file
# unevictable 0
# slab_reclaimable 1048576
# slab_unreclaimable 524288
# pgfault 12345            <- Page faults (minor)
# pgmajfault 12           <- Major page faults (required disk I/O)
# workingset_refault_anon 0
# workingset_refault_file 234
```

### OOM Killer Behavior

```bash
# OOM score: higher = more likely to be killed
# Range: -1000 to 1000
echo 500 > /sys/fs/cgroup/my-app/memory.oom.group

# Check OOM events
cat /sys/fs/cgroup/my-app/memory.events
# low 0           <- memory.low was breached
# high 5          <- memory.high was exceeded (soft limit breached)
# max 2           <- memory.max was hit (process throttled/killed)
# oom 1           <- OOM killer was invoked
# oom_kill 1      <- OOM killer killed a process

# Watch for OOM events
inotifywait -e modify /sys/fs/cgroup/my-app/memory.events
```

## Section 5: I/O Controller

### I/O Weight and Limits

```bash
# Find device major:minor numbers
ls -la /dev/sda
# brw-rw---- 1 root disk 8, 0 ...
# Major=8, Minor=0

# Set I/O weight for block device 8:0
echo "8:0 200" > /sys/fs/cgroup/my-app/io.weight

# Set bandwidth limits
# Format: MAJ:MIN rbps=<bytes/s> wbps=<bytes/s> riops=<iops> wiops=<iops>
echo "8:0 rbps=52428800 wbps=26214400" > /sys/fs/cgroup/my-app/io.max
# 50MB/s read, 25MB/s write

echo "8:0 riops=1000 wiops=500" > /sys/fs/cgroup/my-app/io.max
# 1000 read IOPS, 500 write IOPS

# Combined
echo "8:0 rbps=52428800 wbps=26214400 riops=1000 wiops=500" > \
  /sys/fs/cgroup/my-app/io.max

# Read I/O statistics
cat /sys/fs/cgroup/my-app/io.stat
# 8:0 rbytes=123456 wbytes=789012 rios=100 wios=200 dbytes=0 dios=0
```

### I/O Pressure

```bash
# Current I/O pressure for this cgroup
cat /sys/fs/cgroup/my-app/io.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

## Section 6: Pressure Stall Information (PSI)

PSI is one of the most valuable additions in cgroup v2. It measures resource pressure: what fraction of time tasks were stalled waiting for a resource.

### PSI Metrics

```bash
# System-wide PSI
cat /proc/pressure/cpu
# some avg10=5.00 avg60=3.00 avg300=2.00 total=12345678

cat /proc/pressure/memory
# some avg10=0.00 avg60=0.12 avg300=0.08 total=234567
# full avg10=0.00 avg60=0.03 avg300=0.02 total=45678

cat /proc/pressure/io
# some avg10=12.50 avg60=8.30 avg300=5.20 total=987654
# full avg10=3.20 avg60=2.10 avg300=1.40 total=234567
```

- **some**: Fraction of time at least one task was stalled waiting for the resource
- **full**: Fraction of time ALL runnable tasks were stalled (complete resource starvation)
- **avg10/60/300**: Exponentially weighted moving averages over 10s, 60s, 300s
- **total**: Cumulative stall time in microseconds

### Interpreting PSI

```
cpu.some > 30% for avg60: CPU is overloaded
memory.some > 5% for avg60: Memory pressure, consider adding RAM or reducing working set
memory.full > 0%: Severe - entire system stalled for memory
io.some > 20% for avg60: I/O bottleneck
io.full > 1%: Severe I/O starvation
```

### PSI Monitoring with inotify

```bash
# Set up PSI notifications for a cgroup
# Trigger when io.some avg10 exceeds 30% for 500ms
echo "some 300000 500000" > /sys/fs/cgroup/my-app/io.pressure
# Format: <stall-type> <threshold-usec> <window-usec>

# Use inotifywait to receive notifications
inotifywait -m /sys/fs/cgroup/my-app/io.pressure
```

### PSI Prometheus Integration

```go
// psi_collector.go - Custom Prometheus collector for PSI metrics
package collector

import (
    "bufio"
    "fmt"
    "os"
    "path/filepath"
    "strconv"
    "strings"

    "github.com/prometheus/client_golang/prometheus"
)

type PSICollector struct {
    cgroupRoot string
    someGauge  *prometheus.GaugeVec
    fullGauge  *prometheus.GaugeVec
}

func NewPSICollector(cgroupRoot string) *PSICollector {
    return &PSICollector{
        cgroupRoot: cgroupRoot,
        someGauge: prometheus.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "cgroup_psi_some_ratio",
                Help: "PSI some pressure ratio (0-1)",
            },
            []string{"resource", "window", "cgroup"},
        ),
        fullGauge: prometheus.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "cgroup_psi_full_ratio",
                Help: "PSI full pressure ratio (0-1)",
            },
            []string{"resource", "window", "cgroup"},
        ),
    }
}

func (c *PSICollector) Describe(ch chan<- *prometheus.Desc) {
    c.someGauge.Describe(ch)
    c.fullGauge.Describe(ch)
}

func (c *PSICollector) Collect(ch chan<- prometheus.Metric) {
    resources := []string{"cpu", "memory", "io"}

    filepath.Walk(c.cgroupRoot, func(path string, info os.FileInfo, err error) error {
        if err != nil || !info.IsDir() {
            return nil
        }

        relPath, _ := filepath.Rel(c.cgroupRoot, path)
        cgroupName := "/" + relPath

        for _, resource := range resources {
            pressureFile := filepath.Join(path, resource+".pressure")
            c.parsePSI(pressureFile, resource, cgroupName)
        }
        return nil
    })

    c.someGauge.Collect(ch)
    c.fullGauge.Collect(ch)
}

func (c *PSICollector) parsePSI(filename, resource, cgroup string) {
    f, err := os.Open(filename)
    if err != nil {
        return
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := scanner.Text()
        parts := strings.Fields(line)
        if len(parts) < 4 {
            continue
        }

        stallType := parts[0] // "some" or "full"
        for _, field := range parts[1:] {
            kv := strings.SplitN(field, "=", 2)
            if len(kv) != 2 || !strings.HasPrefix(kv[0], "avg") {
                continue
            }

            window := kv[0]  // avg10, avg60, avg300
            val, err := strconv.ParseFloat(kv[1], 64)
            if err != nil {
                continue
            }

            ratio := val / 100.0 // Convert percentage to ratio

            if stallType == "some" {
                c.someGauge.WithLabelValues(resource, window, cgroup).Set(ratio)
            } else if stallType == "full" {
                c.fullGauge.WithLabelValues(resource, window, cgroup).Set(ratio)
            }
        }
    }
}
```

## Section 7: systemd Integration

systemd manages the cgroup hierarchy directly. Every service, slice, and scope corresponds to a cgroup.

### systemd Slice and Service Hierarchy

```
/sys/fs/cgroup/
├── init.scope/              <- PID 1 (systemd itself)
├── system.slice/            <- System services
│   ├── docker.service/
│   ├── kubelet.service/
│   └── containerd.service/
├── user.slice/              <- User sessions
│   └── user-1000.slice/
└── machine.slice/           <- VMs and containers (libvirt, nspawn)
```

### Setting Resource Limits on systemd Services

```bash
# Set CPU and memory limits on a service
systemctl set-property docker.service CPUQuota=50% MemoryMax=4G

# Or in unit file override
mkdir -p /etc/systemd/system/docker.service.d/
cat > /etc/systemd/system/docker.service.d/limits.conf << 'EOF'
[Service]
CPUQuota=200%
CPUWeight=100
MemoryMax=8G
MemoryHigh=6G
MemorySwapMax=0
IOWeight=100
TasksMax=infinity
EOF

systemctl daemon-reload
systemctl restart docker

# Verify
systemctl show docker.service | grep -E "CPU|Memory|IO"
```

### Creating Custom Slices

```bash
# Create a custom slice for application services
cat > /etc/systemd/system/myapp.slice << 'EOF'
[Unit]
Description=My Application Slice
Documentation=man:systemd.special(7)
Before=slices.target

[Slice]
# Limit the entire slice to 4 CPUs and 8GB RAM
CPUQuota=400%
CPUWeight=200
MemoryMax=8G
MemoryHigh=6G
IOWeight=200
EOF

# Service that goes in the slice
cat > /etc/systemd/system/myapp-api.service << 'EOF'
[Unit]
Description=My Application API
After=network.target

[Service]
Type=exec
ExecStart=/usr/bin/myapp
Slice=myapp.slice
# Per-service limits within the slice
CPUWeight=150
MemoryMax=4G
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now myapp-api.service
```

### Inspecting cgroup State via systemd

```bash
# Show cgroup tree
systemd-cgls

# Show resource usage per cgroup
systemd-cgtop

# Show cgroup properties for a unit
systemctl show --property=ControlGroup,CPUQuota,MemoryMax kubelet.service

# Show which cgroup a process is in
systemctl status <PID>

# Get cgroup path for a unit
cat /sys/fs/cgroup/system.slice/docker.service/cgroup.procs
```

## Section 8: Kubernetes and cgroup v2

Kubernetes 1.25+ supports cgroup v2 fully. The kubelet uses cgroup v2 to enforce Pod requests and limits.

### Enabling cgroup v2 for Kubernetes

```bash
# Verify cgroup v2 is enabled
stat -fc %T /sys/fs/cgroup/
# cgroup2fs = v2 enabled
# tmpfs = v1 (hybrid possible)

# Check containerd configuration
cat /etc/containerd/config.toml | grep cgroup
# [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
#   SystemdCgroup = true
```

```toml
# /etc/containerd/config.toml - Enable cgroup v2
version = 2

[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
        runtime_type = "io.containerd.runc.v2"
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
          SystemdCgroup = true  # Use systemd as cgroup driver
```

### How Kubernetes Maps Pods to cgroups

```bash
# Find the cgroup for a Kubernetes Pod
POD_UID=$(kubectl get pod my-pod -o jsonpath='{.metadata.uid}')

# The cgroup path follows this pattern:
# /sys/fs/cgroup/kubepods.slice/kubepods-<qos>.slice/kubepods-<qos>-pod<uid>.slice/

# For a Guaranteed QoS pod:
ls /sys/fs/cgroup/kubepods.slice/kubepods-guaranteed.slice/ | grep $POD_UID

# For a Burstable QoS pod:
ls /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/ | grep $POD_UID

# For a BestEffort QoS pod:
ls /sys/fs/cgroup/kubepods.slice/kubepods-besteffort.slice/ | grep $POD_UID
```

### Kubernetes CPU and Memory Mapping

```yaml
# Pod resource requests and limits
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      resources:
        requests:
          cpu: "500m"      # 50% of one CPU
          memory: "256Mi"
        limits:
          cpu: "1000m"     # 100% of one CPU (1 core)
          memory: "512Mi"
```

These map to cgroup v2 settings as follows:

```bash
# CPU request: contributes to cpu.weight
# 500m CPU request -> cpu.weight = 512 (proportional to requests)

# CPU limit: maps to cpu.max
# 1000m CPU limit, 100ms period -> cpu.max = "100000 100000"

cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice/<container-id>/cpu.max
# 100000 100000

# Memory limit: maps to memory.limit_in_bytes equivalent
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice/<container-id>/memory.max
# 536870912  (512Mi in bytes)
```

### Memory QoS with cgroup v2

Kubernetes 1.27+ supports Memory QoS using cgroup v2's memory.min and memory.high:

```yaml
# Enable MemoryQoS feature gate (enabled by default in 1.27+)
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubelet-config
  namespace: kube-system
data:
  kubelet: |
    featureGates:
      MemoryQoS: true
```

With this enabled:
- `memory.min` = memory request (protected from eviction)
- `memory.high` = memory limit * MemoryThrottlingFactor (default 0.9)
- `memory.max` = memory limit (hard kill threshold)

## Section 9: Monitoring cgroup v2 Resources

### Node-level Monitoring with node_exporter

```bash
# node_exporter exposes cgroup metrics
# Enable cgroups collector (enabled by default in recent versions)
node_exporter \
  --collector.cgroups \
  --collector.pressure  # PSI metrics

# Key metrics available:
# node_cgroup_cpu_stat_*
# node_cgroup_memory_*
# node_pressure_*
```

### Direct cgroup Metrics with Prometheus

```yaml
# Custom recording rules for Kubernetes cgroup v2 metrics
groups:
  - name: kubernetes_cgroup_v2
    rules:
      # CPU throttle ratio per pod
      - record: pod:cpu_throttle_ratio:rate5m
        expr: |
          sum(
            rate(container_cpu_cfs_throttled_periods_total{container!=""}[5m])
          ) by (pod, namespace)
          /
          sum(
            rate(container_cpu_cfs_periods_total{container!=""}[5m])
          ) by (pod, namespace)

      # Memory pressure per namespace
      - record: namespace:memory_psi_some:avg10
        expr: |
          sum(
            container_memory_psi_some_avg10{container!=""}
          ) by (namespace)
```

### cgroup v2 Debuging

```bash
# Check if a container is throttled
CONTAINER_ID=$(docker inspect my-container --format '{{.Id}}')
cat /sys/fs/cgroup/system.slice/docker-${CONTAINER_ID}.scope/cpu.stat | grep throttled

# Check memory pressure for a specific pod
POD_CGROUP=$(systemd-cgls | grep pod-uid)
cat /sys/fs/cgroup/kubepods.slice/${POD_CGROUP}/memory.pressure

# Show all cgroup events
watch -n1 'cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/memory.events'

# Check OOM kill events
dmesg | grep -i "oom\|killed\|out of memory"
journalctl -k | grep -i "oom\|killed"
```

## Section 10: Resource Management Patterns for Containers

### CPU Bandwidth Control for Latency-Sensitive Workloads

```bash
# Problem: CPU throttling under cgroup v1 caused latency spikes
# even when average utilization was low
# Solution in cgroup v2: use cpu.weight instead of hard limits for
# latency-sensitive services

# Instead of: cpu.max = "50000 100000" (50% hard limit)
# Use: cpu.weight = 400  (4x priority, gets 4x share when contended)
#      cpu.max = "max 100000" (no hard limit = no throttling)

# For batch jobs that should yield to latency-sensitive work:
# cpu.weight = 20  (1/5 of normal priority)
# cpu.max = "200000 100000"  (can use 2 cores maximum)
```

### Memory Overcommit with Soft Limits

```bash
# Kubernetes Guaranteed pods: memory.min = memory.max (no overcommit)
# Kubernetes Burstable pods: memory.min = request, memory.max = limit
# Kubernetes BestEffort pods: no memory protection

# Manual example: allow memory overcommit with graceful reclaim
echo "256M" > /sys/fs/cgroup/my-app/memory.low   # Protected from reclaim
echo "512M" > /sys/fs/cgroup/my-app/memory.high  # Throttle writes above this
echo "1G"   > /sys/fs/cgroup/my-app/memory.max   # OOM kill above this
```

## Section 11: CPU Isolation for Real-Time Workloads

```bash
# Isolate CPUs from the scheduler (kernel parameter)
# Only isolated CPUs will be used for processes explicitly pinned to them
# Add to kernel cmdline: isolcpus=4-7 nohz_full=4-7 rcu_nocbs=4-7

# Create cgroup for RT application on isolated CPUs
mkdir /sys/fs/cgroup/realtime-app

# Enable cpuset and cpu controllers
echo "+cpuset +cpu" > /sys/fs/cgroup/cgroup.subtree_control

# Assign isolated CPUs exclusively
echo "4-7" > /sys/fs/cgroup/realtime-app/cpuset.cpus
echo "root" > /sys/fs/cgroup/realtime-app/cpuset.cpus.partition

# Disable CPU bandwidth limit (no throttling for RT)
echo "max 100000" > /sys/fs/cgroup/realtime-app/cpu.max

# Maximum CPU weight
echo "10000" > /sys/fs/cgroup/realtime-app/cpu.weight

# Start the RT process in the isolated cgroup
echo $RT_PID > /sys/fs/cgroup/realtime-app/cgroup.procs
```

## Summary

cgroup v2's unified hierarchy and improved interfaces represent a significant improvement over cgroup v1 for modern container workloads:

1. **Unified hierarchy** eliminates cross-controller inconsistencies and simplifies the mental model
2. **CPU weight-based scheduling** reduces latency spikes caused by hard bandwidth throttling
3. **Improved memory accounting** correctly attributes shared memory costs
4. **PSI (Pressure Stall Information)** provides quantitative resource pressure metrics for proactive scaling decisions
5. **Better Kubernetes integration** enables Memory QoS features that protect pod memory requests from eviction pressure

For Kubernetes operators, ensuring cgroup v2 is enabled on worker nodes (kernel 5.4+ recommended) and that containerd is configured with `SystemdCgroup = true` is the foundation for reliable resource management at scale.
