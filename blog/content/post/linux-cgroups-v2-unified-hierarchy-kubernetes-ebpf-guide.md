---
title: "Linux cgroups v2: Resource Management, Unified Hierarchy, and Kubernetes Integration"
date: 2029-12-03T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "cgroups v2", "Kubernetes", "eBPF", "Resource Management", "CPU", "Memory", "I/O"]
categories:
- Linux
- Kubernetes
- Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into cgroups v2 architecture, cpu/memory/io controllers, Kubernetes QoS class mapping to cgroup hierarchies, and eBPF cgroup programs for advanced resource control."
more_link: "yes"
url: "/linux-cgroups-v2-unified-hierarchy-kubernetes-ebpf-guide/"
---

Control groups (cgroups) are the kernel mechanism that makes containers possible. Every container runtime — Docker, containerd, CRI-O — uses cgroups to enforce CPU, memory, I/O, and process limits. The v2 cgroup hierarchy, which became the default in kernel 5.10+ and is the default for most modern Linux distributions, unified the split v1 hierarchy into a single coherent tree and added new capabilities that v1 lacked.

<!--more-->

## Section 1: cgroups v1 vs cgroups v2

In cgroups v1, each resource controller had its own independent hierarchy. A process could appear in different places in the CPU hierarchy and the memory hierarchy. This created inconsistency problems: you could configure CPU pinning for a process but the memory controller would apply different limits based on its own hierarchy position.

```
cgroups v1 (fragmented):
/sys/fs/cgroup/
  ├── cpu/                 ← independent hierarchy
  │   └── my-container/
  ├── memory/              ← independent hierarchy
  │   └── my-container/
  ├── blkio/               ← independent hierarchy
  │   └── my-container/
  └── pids/                ← independent hierarchy
      └── my-container/
```

cgroups v2 unifies all controllers under a single hierarchy:

```
cgroups v2 (unified):
/sys/fs/cgroup/
  └── my-container/        ← single directory
      ├── cgroup.controllers    (available controllers)
      ├── cgroup.subtree_control (enabled controllers for children)
      ├── cpu.weight            (CPU fair scheduling weight)
      ├── cpu.max               (CPU quota/period)
      ├── memory.max            (memory hard limit)
      ├── memory.high           (memory soft limit)
      ├── io.max                (I/O bandwidth limits)
      └── pids.max              (process limit)
```

### Checking Your System's cgroup Version

```bash
# Check if cgroups v2 is active
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)
# If you see cgroup2, v2 is active
# If you see cgroup (without "2"), it's v1

# Alternatively
ls /sys/fs/cgroup/cgroup.controllers 2>/dev/null && echo "cgroups v2" || echo "cgroups v1"

# Available controllers
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc
```

### Enabling cgroups v2 (if not already enabled)

```bash
# For systems still on v1 (GRUB-based)
# Edit /etc/default/grub:
# GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"
grub-mkconfig -o /boot/grub/grub.cfg
reboot
```

## Section 2: CPU Controller

The cgroups v2 CPU controller has two mechanisms: weight-based fair scheduling and quota-based hard limits.

### CPU Weight (Fair Scheduling)

```bash
# Create a cgroup
mkdir /sys/fs/cgroup/my-app

# Set CPU weight (1-10000, default 100)
# A cgroup with weight 200 gets twice the CPU of one with weight 100
echo 200 > /sys/fs/cgroup/my-app/cpu.weight

# Check current weight
cat /sys/fs/cgroup/my-app/cpu.weight
```

Weight-based scheduling ensures proportional CPU access when the system is under load. It does not limit CPU when the system has idle capacity.

### CPU Quota (Hard Limits)

```bash
# cpu.max format: <quota> <period> in microseconds
# Allows 200ms of CPU time every 1000ms (= 0.2 CPUs)
echo "200000 1000000" > /sys/fs/cgroup/my-app/cpu.max

# Allow 2.5 CPUs (2500ms per 1000ms period)
echo "2500000 1000000" > /sys/fs/cgroup/my-app/cpu.max

# Remove the quota (unlimited)
echo "max 1000000" > /sys/fs/cgroup/my-app/cpu.max

# Check current quota
cat /sys/fs/cgroup/my-app/cpu.max
# 500000 1000000   (0.5 CPUs)
```

### CPU Statistics

```bash
# View CPU usage statistics
cat /sys/fs/cgroup/my-app/cpu.stat
# usage_usec 12847293104    ← total CPU time used (microseconds)
# user_usec 9823741029
# system_usec 3023552075
# nr_periods 12847293        ← number of scheduling periods
# nr_throttled 284729        ← periods where cgroup was throttled
# throttled_usec 2847930     ← total throttled time (microseconds)
# nr_bursts 0
# burst_usec 0

# Calculate throttle ratio
PERIODS=$(awk '/^nr_periods/ {print $2}' /sys/fs/cgroup/my-app/cpu.stat)
THROTTLED=$(awk '/^nr_throttled/ {print $2}' /sys/fs/cgroup/my-app/cpu.stat)
echo "Throttle rate: $(( THROTTLED * 100 / PERIODS ))%"
```

High CPU throttling (>10%) indicates the CPU limit is too low and causing latency. This is one of the most common causes of unexplained latency in Kubernetes workloads.

## Section 3: Memory Controller

```bash
# Set hard memory limit (OOM kill at this level)
echo "512M" > /sys/fs/cgroup/my-app/memory.max

# Set soft memory limit (kernel tries to reclaim at this level but doesn't kill)
echo "384M" > /sys/fs/cgroup/my-app/memory.high

# Set swap limit (total memory + swap)
echo "768M" > /sys/fs/cgroup/my-app/memory.swap.max

# Check memory usage
cat /sys/fs/cgroup/my-app/memory.current    # current usage in bytes
cat /sys/fs/cgroup/my-app/memory.peak       # peak usage

# Detailed memory statistics
cat /sys/fs/cgroup/my-app/memory.stat
# anon 41943040              ← anonymous memory (heap, stack)
# file 104857600             ← file-backed memory (page cache)
# kernel 8388608             ← kernel memory (slab, stacks)
# slab 3145728
# sock 0
# shmem 0
# file_mapped 20971520       ← memory-mapped files
# file_dirty 0               ← dirty pages pending writeback
# file_writeback 0
# pgfault 842930             ← total page faults
# pgmajfault 1024            ← major page faults (disk I/O required)
```

### Memory Events

```bash
# Watch memory pressure events
cat /sys/fs/cgroup/my-app/memory.events
# low 0           ← crossed memory.low threshold
# high 42         ← crossed memory.high threshold (reclaim triggered)
# max 0           ← allocations blocked at memory.max
# oom 0           ← OOM kill events
# oom_kill 0      ← successful OOM kills
# oom_group_kill 0
```

## Section 4: I/O Controller

The cgroups v2 I/O controller uses a single unified interface for block device throttling, replacing v1's `blkio` controller.

```bash
# Find device major:minor numbers
ls -la /dev/sda
# brw-rw---- 1 root disk 8, 0 Dec  3 00:00 /dev/sda
# Major: 8, Minor: 0

# Set I/O bandwidth limits
# Format: <major:minor> rbps=<read-bps> wbps=<write-bps> riops=<read-iops> wiops=<write-iops>
echo "8:0 rbps=104857600 wbps=104857600 riops=1000 wiops=1000" > \
  /sys/fs/cgroup/my-app/io.max
# This sets 100MB/s read, 100MB/s write, 1000 IOPS read, 1000 IOPS write

# View current I/O statistics
cat /sys/fs/cgroup/my-app/io.stat
# 8:0 rbytes=1073741824 wbytes=536870912 rios=10240 wios=5120 dbytes=0 dios=0

# I/O pressure
cat /sys/fs/cgroup/my-app/io.pressure
# some avg10=0.00 avg60=0.12 avg300=0.05 total=18472349
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

### I/O Weight (BFQ Scheduler)

```bash
# I/O weight is proportional, like CPU weight (1-10000, default 100)
# Requires BFQ I/O scheduler on the device
echo "default 200" > /sys/fs/cgroup/my-app/io.weight

# Per-device weight
echo "8:0 500" > /sys/fs/cgroup/my-app/io.weight
```

## Section 5: Kubernetes cgroups v2 Integration

Kubernetes maps its QoS classes to cgroup hierarchies. Understanding this mapping is essential for diagnosing resource-related issues.

### cgroup Hierarchy in Kubernetes

```
/sys/fs/cgroup/
  ├── kubepods.slice/                       ← all kubernetes pods
  │   ├── kubepods-guaranteed.slice/        ← Guaranteed QoS pods
  │   │   └── kubepods-pod<uid>.slice/
  │   │       └── cri-containerd-<id>.scope/
  │   ├── kubepods-burstable.slice/         ← Burstable QoS pods
  │   │   └── kubepods-pod<uid>.slice/
  │   │       └── cri-containerd-<id>.scope/
  │   └── kubepods-besteffort.slice/        ← BestEffort QoS pods
  │       └── kubepods-pod<uid>.slice/
  │           └── cri-containerd-<id>.scope/
  └── system.slice/                         ← system services
```

### Finding a Pod's cgroup

```bash
# Get pod UID
kubectl get pod my-app-xxx -n production -o jsonpath='{.metadata.uid}'
# Output: abc12345-def6-7890-ghij-klmnopqrstuv

# Find the cgroup path
find /sys/fs/cgroup/kubepods.slice \
  -name "kubepods-pod*.slice" \
  -path "*abc12345*" \
  -maxdepth 3

# Check CPU usage for a pod
POD_UID="abc12345-def6-7890-ghij-klmnopqrstuv"
CGROUP="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-pod${POD_UID}.slice"
cat "${CGROUP}/cpu.stat"

# Check memory for a pod
cat "${CGROUP}/memory.current"
cat "${CGROUP}/memory.max"
```

### Kubernetes CPU Limit Implementation

Kubernetes CPU limits are implemented as cgroup v2 `cpu.max` values:

```
Kubernetes CPU Limit → cgroup cpu.max
100m (0.1 CPU)       → 10000 100000 (10ms per 100ms period)
500m (0.5 CPU)       → 50000 100000
1    (1 CPU)         → 100000 100000
2    (2 CPUs)        → 200000 100000
```

```bash
# Check the actual cgroup values for a pod
kubectl get pod my-app -n production -o jsonpath='{.spec.containers[0].resources}'
# {"limits":{"cpu":"500m","memory":"512Mi"},"requests":{"cpu":"100m","memory":"128Mi"}}

# Find the container's cgroup
CONTAINER_ID=$(kubectl get pod my-app -n production \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's|containerd://||')

# Check cpu.max
find /sys/fs/cgroup/kubepods.slice -name "${CONTAINER_ID:0:12}*" -type d | \
  xargs -I{} cat {}/cpu.max
# 50000 100000  ← confirms 500m CPU limit
```

### Detecting CPU Throttling on Kubernetes Pods

```bash
# Check throttle statistics for all pods
for cgroup in $(find /sys/fs/cgroup/kubepods.slice -name "cpu.stat" -maxdepth 5); do
  THROTTLED=$(awk '/^nr_throttled/ {print $2}' "${cgroup}")
  PERIODS=$(awk '/^nr_periods/ {print $2}' "${cgroup}")
  if [[ "${PERIODS}" -gt 0 && "${THROTTLED}" -gt 0 ]]; then
    RATE=$(( THROTTLED * 100 / PERIODS ))
    if [[ "${RATE}" -gt 5 ]]; then
      echo "HIGH THROTTLE: ${cgroup} - ${RATE}% (${THROTTLED}/${PERIODS})"
    fi
  fi
done
```

This is the production equivalent of the Prometheus query:
```
rate(container_cpu_cfs_throttled_periods_total[5m]) /
rate(container_cpu_cfs_periods_total[5m]) > 0.05
```

## Section 6: eBPF cgroup Programs

eBPF programs can be attached to cgroup hooks, enabling system call filtering, network policy enforcement, and custom resource monitoring at the cgroup level.

### cgroup/sock_create: Socket Restriction

```c
// bpf/restrict_sockets.c
// Restricts cgroup to only create TCP sockets
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

SEC("cgroup/sock_create")
int restrict_sockets(struct bpf_sock *ctx) {
    // Allow only AF_INET/AF_INET6 TCP sockets
    if (ctx->family != AF_INET && ctx->family != AF_INET6) {
        return 0;  // deny
    }
    if (ctx->type != SOCK_STREAM && ctx->type != SOCK_DGRAM) {
        return 0;  // deny
    }
    return 1;  // allow
}

char _license[] SEC("license") = "GPL";
```

```bash
# Compile and load
clang -target bpf -O2 -c restrict_sockets.c -o restrict_sockets.o

# Attach to a specific cgroup
bpftool cgroup attach /sys/fs/cgroup/my-app sock_create pinned /sys/fs/bpf/restrict_sockets
```

### cgroup/egress: Network Bandwidth Monitoring

Cilium uses eBPF cgroup programs for its bandwidth management:

```bash
# Enable bandwidth manager in Cilium (uses eBPF tc+cgroup programs)
helm upgrade cilium cilium/cilium \
  --reuse-values \
  --set bandwidthManager.enabled=true \
  --set bandwidthManager.bbr=true  # Enable BBR congestion control

# Set bandwidth limits via Kubernetes annotations
kubectl annotate pod my-app \
  kubernetes.io/egress-bandwidth=100M \
  kubernetes.io/ingress-bandwidth=100M
```

## Section 7: Monitoring cgroup Resource Usage

### Prometheus Metrics via node_exporter

```yaml
# node_exporter with cgroup metrics enabled
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    spec:
      containers:
        - name: node-exporter
          image: prom/node-exporter:v1.8.1
          args:
            - --path.rootfs=/host
            - --collector.cgroups          # Enable cgroup collector
            - --collector.cpu.info
            - --collector.filesystem.mount-points-exclude=^/(dev|proc|sys|var/lib/docker)($|/)
          volumeMounts:
            - name: host
              mountPath: /host
              readOnly: true
```

### Useful Prometheus Queries

```promql
# CPU throttle rate per container (>5% is concerning)
rate(container_cpu_cfs_throttled_periods_total{namespace="production"}[5m])
  / rate(container_cpu_cfs_periods_total{namespace="production"}[5m])
  > 0.05

# Memory usage as percentage of limit
container_memory_working_set_bytes{namespace="production"}
  / container_spec_memory_limit_bytes{namespace="production"}
  * 100 > 80

# OOM kills in the last hour
increase(container_oom_events_total{namespace="production"}[1h]) > 0

# I/O wait pressure
rate(container_fs_reads_bytes_total{namespace="production"}[5m])
```

## Section 8: cgroup v2 Delegation for Rootless Containers

cgroups v2 enables rootless containers by delegating cgroup subtree management to unprivileged users. Podman and rootless containerd use this feature.

```bash
# Grant user 1000 delegation rights over a cgroup subtree
# This is done via systemd's user slice mechanism
systemctl edit --force user@1000.service
# [Service]
# Delegate=yes

# The user can now create sub-cgroups under their slice
# /sys/fs/cgroup/user.slice/user-1000.slice/

# Verify delegation
cat /sys/fs/cgroup/user.slice/user-1000.slice/cgroup.delegate
# domain threaded

# Rootless containerd configuration
cat /etc/containerd/config.toml | grep -A 5 "cgroup"
# [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
#   SystemdCgroup = true
```

cgroups v2 is not merely an incremental improvement over v1 — it is a fundamentally cleaner design that enables better resource accounting, more expressive limits, and new capabilities like eBPF integration. As Kubernetes moves deeper into multi-tenancy and resource isolation, understanding cgroups v2 at this level becomes essential for platform engineers.
