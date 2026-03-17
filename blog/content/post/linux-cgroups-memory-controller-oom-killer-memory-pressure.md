---
title: "Linux Cgroups Memory Controller: OOM Killer Behavior and Memory Pressure Handling"
date: 2030-12-26T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "OOM Killer", "Memory Management", "Kubernetes", "PSI", "Performance"]
categories:
- Linux
- Kubernetes
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux cgroups memory controller covering memory.limit_in_bytes vs memory.high soft limits, OOM kill score adjustment, memory.oom_control disable patterns, PSI memory pressure monitoring, and Kubernetes memory management internals including QoS classes."
more_link: "yes"
url: "/linux-cgroups-memory-controller-oom-killer-memory-pressure/"
---

The Linux OOM (Out Of Memory) killer is one of the most misunderstood kernel mechanisms in production systems. When a container is unexpectedly killed, when a pod's OOMKilled status appears in Kubernetes, or when a system becomes unresponsive under memory pressure, understanding cgroups memory controller mechanics is essential for root cause analysis and prevention. This guide covers the full spectrum of Linux memory management as it applies to containerized workloads.

<!--more-->

# Linux Cgroups Memory Controller: OOM Killer Behavior and Memory Pressure Handling

## Cgroups v1 vs v2 Memory Controller

Modern Linux systems use either cgroups v1 or v2. Most current distributions default to cgroups v2, but enterprise systems running older kernels or RHEL 7/CentOS 7 may still use v1. Kubernetes supports both, but the behavior differs significantly.

### Checking Which Version Is Active

```bash
# Check if unified hierarchy (cgroups v2) is mounted
mount | grep cgroup
stat -fc %T /sys/fs/cgroup/

# cgroups v2 output:
# tmpfs on /sys/fs/cgroup type tmpfs
# cgroup2 on /sys/fs/cgroup type cgroup2

# cgroups v1 output:
# tmpfs on /sys/fs/cgroup type tmpfs
# cgroup on /sys/fs/cgroup/memory type cgroup (memory)

# Kubernetes version detection
kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.operatingSystem}'
cat /proc/1/cgroup  # pid 1 cgroup membership shows hierarchy
```

### Key Differences Between v1 and v2

| Feature | cgroups v1 | cgroups v2 |
|---------|-----------|-----------|
| Memory limit | `memory.limit_in_bytes` | `memory.max` |
| Soft limit | `memory.soft_limit_in_bytes` | `memory.high` |
| OOM control | `memory.oom_control` | `memory.oom.group` |
| PSI | Limited | Full PSI support |
| Swap | `memory.memsw.limit_in_bytes` | `memory.swap.max` |

## Memory Limits Deep Dive

### Hard Limits vs Soft Limits

**Hard limit** (memory.max / memory.limit_in_bytes): When a process exceeds this, the OOM killer is invoked immediately. This is what Kubernetes sets via `resources.limits.memory`.

**Soft limit** (memory.high / memory.soft_limit_in_bytes): A threshold above which memory reclaim is aggressively triggered, but processes are not killed. This is what Kubernetes sets via `resources.requests.memory` in cgroups v2 via `memory.high`.

```bash
# cgroups v2 - inspect a container's memory settings
# Find the container's cgroup path
CONTAINER_ID=$(docker inspect my-container -f '{{.Id}}')
CGROUP_PATH="/sys/fs/cgroup/system.slice/docker-${CONTAINER_ID}.scope"

# Read current settings
cat ${CGROUP_PATH}/memory.max          # Hard limit
cat ${CGROUP_PATH}/memory.high         # Soft limit
cat ${CGROUP_PATH}/memory.current      # Current usage
cat ${CGROUP_PATH}/memory.stat         # Detailed statistics
cat ${CGROUP_PATH}/memory.events       # OOM and high-watermark events

# cgroups v1 equivalent
cat /sys/fs/cgroup/memory/docker/${CONTAINER_ID}/memory.limit_in_bytes
cat /sys/fs/cgroup/memory/docker/${CONTAINER_ID}/memory.soft_limit_in_bytes
cat /sys/fs/cgroup/memory/docker/${CONTAINER_ID}/memory.usage_in_bytes
```

### Understanding memory.stat Output

```bash
# cgroups v2 memory.stat breakdown
cat /sys/fs/cgroup/memory.stat

# Key fields:
# anon: Anonymous memory (heap, stack) - NOT swappable without swap configured
# file: Page cache (file-backed memory) - Most reclaim happens here
# kernel: Kernel data structures for this cgroup
# slab: Kernel slab allocator pages
# sock: Socket buffer memory
# shmem: Shared memory (tmpfs, IPC)
# file_mapped: mmap'd file content
# file_dirty: Pages modified but not yet written to disk
# file_writeback: Pages being written to disk
# anon_thp: Anonymous Transparent Huge Pages
# inactive_anon: Anon pages eligible for swap
# active_anon: Recently-used anon pages
# inactive_file: File pages eligible for reclaim
# active_file: Recently-used file pages
# unevictable: Locked pages (mlocked, etc.)
# workingset_refault_anon: Anon pages that were refaulted from swap
# workingset_refault_file: File pages that were refaulted from disk
```

### Configuring Memory Limits via Systemd/Cgroup Direct Manipulation

```bash
# Set memory limits for a systemd service
systemctl set-property myapp.service MemoryMax=512M
systemctl set-property myapp.service MemoryHigh=400M

# Using cgset (cgroup-tools)
cgset -r memory.max=536870912 myapp_cgroup

# Verify
cgget -r memory.max myapp_cgroup
cgget -r memory.current myapp_cgroup
```

## OOM Killer Mechanics

### How the OOM Killer Selects Victims

The OOM killer uses `oom_score_adj` to select which process to kill. The algorithm:

1. Calculates base score: proportional to RSS (resident set size) relative to system total RAM
2. Adjusts for `oom_score_adj` range: -1000 (never kill) to +1000 (always kill first)
3. Adjusts for memory pressure and process priority

```bash
# Check current OOM scores for running processes
# oom_score: 0-1000, higher = more likely to be killed
# oom_score_adj: adjustment applied by user/container runtime

ps aux | awk '{print $2}' | while read pid; do
    score=$(cat /proc/$pid/oom_score 2>/dev/null)
    adj=$(cat /proc/$pid/oom_score_adj 2>/dev/null)
    comm=$(cat /proc/$pid/comm 2>/dev/null)
    if [ -n "$score" ]; then
        printf "PID: %-6s Score: %-5s Adj: %-6s Name: %s\n" \
            "$pid" "$score" "$adj" "$comm"
    fi
done | sort -k4 -n -r | head -20

# Sort by OOM score (most killable first)
for pid in /proc/[0-9]*/; do
    pid=${pid%/}; pid=${pid##*/}
    [ -f "$pid/oom_score" ] && printf "%d %s\n" \
        "$(cat $pid/oom_score 2>/dev/null)" \
        "$(cat $pid/comm 2>/dev/null)"
done | sort -rn | head -20
```

### OOM Kill Score Adjustment

```bash
# Protect critical system processes from OOM killing
# Setting -1000 prevents the process from ever being OOM killed
echo -1000 > /proc/$(pidof systemd)/oom_score_adj
echo -1000 > /proc/$(pidof sshd)/oom_score_adj

# Make non-critical processes more likely to be killed first
echo 500 > /proc/$(pidof my-worker)/oom_score_adj

# For containers, set via ulimit or runtime configuration:
# Docker:
docker run --oom-score-adj=-500 my-container

# Docker with OOM kill disabled (dangerous - only for critical processes):
docker run --oom-kill-disable my-container
```

### Kubernetes Pod OOM Behavior

Kubernetes assigns OOM scores based on QoS class:

```
Guaranteed (requests == limits):   oom_score_adj = -998
Burstable (limits > requests):     oom_score_adj = min(max(2, 1000 - 1000*limit/capacity), 999)
BestEffort (no requests/limits):   oom_score_adj = 1000
```

This means BestEffort pods are killed first, then Burstable pods (those using the most memory relative to their request), and Guaranteed pods are killed last.

```yaml
# Guaranteed QoS - requests must equal limits
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    resources:
      requests:
        memory: "256Mi"
        cpu: "250m"
      limits:
        memory: "256Mi"   # Must equal requests for Guaranteed
        cpu: "250m"

---
# Burstable QoS - limits greater than requests
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    resources:
      requests:
        memory: "128Mi"   # Base allocation
      limits:
        memory: "512Mi"   # Can burst to this

---
# BestEffort QoS - no resources specified (killed first!)
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    image: my-app:latest
    # No resources - this pod will be killed first under pressure
```

### Investigating OOM Kill Events

```bash
# Check dmesg for OOM kill events
dmesg | grep -E "(Out of memory|OOM|oom_kill)"

# More detailed OOM kill information
dmesg | grep -A 10 "Out of memory"

# System-wide OOM statistics
cat /proc/vmstat | grep oom

# Check if specific pod was OOM killed
kubectl describe pod my-pod | grep -E "(OOMKilled|LastState|Reason)"

# Kubernetes events
kubectl get events --field-selector reason=OOMKilling

# Check kubelet logs for OOM events
journalctl -u kubelet | grep -i oom | tail -50

# Node-level OOM statistics
kubectl get node my-node -o jsonpath='{.status.conditions}'
```

### Reading an OOM Kill Message

```
[1234567.890] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=myapp,mems_allowed=0,oom_memcg=/kubepods/burstable/pod-abc123/container-xyz789,task_memcg=/kubepods/burstable/pod-abc123/container-xyz789,task=java,pid=12345,uid=1000
[1234567.891] Memory cgroup out of memory: Killed process 12345 (java) total-vm:2097152kB, anon-rss:524288kB, file-rss:131072kB, shmem-rss:0kB, UID:1000 pgtables:1024kB oom_score_adj:856
```

Breaking down the key fields:
- `constraint=CONSTRAINT_MEMCG`: OOM was triggered by cgroup memory limit (not system-wide)
- `oom_memcg`: The cgroup that hit its memory limit
- `total-vm`: Virtual memory size at kill time (often much larger than physical)
- `anon-rss`: Anonymous resident memory (heap, stack) - the "real" memory usage
- `file-rss`: File-backed pages loaded in memory
- `oom_score_adj`: The process's OOM score adjustment (higher = more likely to be killed)

## memory.oom_control and OOM Disable Patterns

### Disabling OOM Kill in cgroups v1

```bash
# Disable OOM killing for a cgroup (processes will wait instead of being killed)
# WARNING: This can cause the entire system to hang if memory is truly exhausted
echo 1 > /sys/fs/cgroup/memory/myapp/memory.oom_control

# Check if OOM kill is disabled and current under_oom status
cat /sys/fs/cgroup/memory/myapp/memory.oom_control
# under_oom 0    -> currently not in OOM
# oom_kill_disable 1 -> OOM killing disabled
# oom_kill 0     -> no OOM kills occurred
```

### cgroups v2 OOM Group Behavior

In cgroups v2, `memory.oom.group` changes whether individual processes or the entire cgroup group is killed:

```bash
# When set to 1, all tasks in the cgroup are killed when OOM occurs
# This prevents partial kills that leave the application in an inconsistent state
echo 1 > /sys/fs/cgroup/myapp/memory.oom.group

# Kubernetes uses this for pod-level OOM killing when cgroups v2 is enabled
# The entire pod is killed as a unit rather than individual containers
```

### When to Disable vs Enable OOM Kill

**Enable OOM kill (default)**: For most stateless applications where restart is acceptable. Allows the kernel to recover memory without hanging.

**Disable OOM kill** (rare cases):
- Critical single-node databases where data integrity requires graceful shutdown
- Applications that implement their own memory pressure handling
- Interactive workloads where hanging is preferable to data loss

```python
# Python example: Register a memory pressure handler before disabling OOM kill
import signal
import sys
import resource

def memory_pressure_handler(signum, frame):
    """Called when memory pressure is detected"""
    print("Memory pressure detected, initiating graceful shutdown")
    # Flush data, close connections, etc.
    sys.exit(0)

# Register SIGTERM handler for graceful shutdown
signal.signal(signal.SIGTERM, memory_pressure_handler)

# Application should monitor its own memory and take action
import psutil
import os

def check_memory_pressure(threshold_mb=200):
    """Check if available memory is below threshold"""
    mem = psutil.virtual_memory()
    available_mb = mem.available / (1024 * 1024)

    if available_mb < threshold_mb:
        print(f"Memory pressure: only {available_mb:.0f}MB available")
        return True
    return False
```

## PSI: Pressure Stall Information

PSI (Pressure Stall Information) was introduced in Linux 4.20 and provides a standardized way to measure resource contention. For memory, PSI reports how much time processes spent stalled waiting for memory.

### Reading PSI Memory Metrics

```bash
# System-wide PSI
cat /proc/pressure/memory

# Output:
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# 'some': at least one task was stalled
# 'full': all tasks were stalled (complete stall)
# avg10, avg60, avg300: 10s, 60s, 5min rolling averages (percentage)
# total: cumulative microseconds of stall time

# Per-cgroup PSI (cgroups v2 only)
cat /sys/fs/cgroup/myapp/memory.pressure

# Trigger action when PSI exceeds threshold (kernel 5.13+)
# Register a threshold watcher on the PSI file
python3 << 'EOF'
import select
import os

# Open the PSI memory pressure file
fd = os.open("/sys/fs/cgroup/myapp/memory.pressure", os.O_RDWR)

# Write threshold: trigger when avg10 > 10% over a 1 second window
os.write(fd, b"some 100000 1000000")  # 100ms stall in 1s window

# Monitor for threshold breach using epoll
epoll = select.epoll()
epoll.register(fd, select.EPOLLPRI)

print("Watching for memory pressure events...")
while True:
    events = epoll.poll(timeout=60)
    if events:
        print("Memory pressure threshold exceeded!")
        os.lseek(fd, 0, 0)
        data = os.read(fd, 256)
        print(f"Current PSI: {data.decode()}")
EOF
```

### Prometheus Integration for PSI Metrics

```bash
# Node exporter automatically collects PSI if enabled
# /etc/prometheus/node_exporter.conf
--collector.pressure

# Key Prometheus metrics from PSI:
# node_pressure_memory_stalled_seconds_total
# node_pressure_memory_waiting_seconds_total
```

```yaml
# Prometheus alerting rules for PSI
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: memory-pressure-alerts
  namespace: monitoring
spec:
  groups:
  - name: memory-pressure
    rules:
    - alert: HighMemoryPressure
      expr: |
        rate(node_pressure_memory_stalled_seconds_total[5m]) * 100 > 10
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.instance }} has high memory pressure"
        description: "Memory stall time is {{ $value | humanizePercentage }} of the last 5 minutes"

    - alert: CriticalMemoryPressure
      expr: |
        rate(node_pressure_memory_stalled_seconds_total[1m]) * 100 > 50
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Node {{ $labels.instance }} has critical memory pressure"
```

## Kubernetes Memory Management Internals

### How Kubelet Manages Memory

The kubelet enforces memory resources through several mechanisms:

1. **cgroup limits**: Direct memory.max/limit_in_bytes configuration
2. **Node allocatable**: `allocatable = capacity - system reserved - kubelet reserved - eviction threshold`
3. **Eviction**: Graceful pod eviction when node memory pressure is detected

```bash
# Check node memory allocatable vs capacity
kubectl describe node my-node | grep -A 10 "Capacity:"
kubectl describe node my-node | grep -A 10 "Allocatable:"

# Node allocatable formula:
# allocatable = capacity - kube-reserved - system-reserved - eviction-threshold
# Example: 8GiB total
# - 500MiB kube-reserved
# - 500MiB system-reserved
# - 100MiB eviction threshold
# = 6.9GiB allocatable

# Check kubelet configuration for reserved resources
cat /var/lib/kubelet/config.yaml | grep -E "(KubeReserved|SystemReserved|EvictionHard)"
```

### Kubelet Eviction Configuration

```yaml
# kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
evictionHard:
  memory.available: "100Mi"    # Evict pods when < 100MiB available
  nodefs.available: "10%"      # Evict when disk < 10%
  imagefs.available: "15%"     # Evict when image disk < 15%

evictionSoft:
  memory.available: "200Mi"    # Soft eviction threshold
  nodefs.available: "15%"

evictionSoftGracePeriod:
  memory.available: "1m30s"    # Give pods 90s to terminate gracefully
  nodefs.available: "2m"

evictionMaxPodGracePeriod: 90  # Maximum grace period for pod termination

evictionPressureTransitionPeriod: "5m"  # How long to wait before considering pressure resolved

# Reserved resources
kubeReserved:
  cpu: "100m"
  memory: "400Mi"
  ephemeral-storage: "1Gi"

systemReserved:
  cpu: "100m"
  memory: "400Mi"
  ephemeral-storage: "1Gi"
```

### Monitoring Container Memory in Kubernetes

```bash
# Check container memory usage
kubectl top pods -n production --containers

# Detailed memory metrics from metrics-server
kubectl top pod my-pod -n production --containers

# Check if containers are near their limits
kubectl get pods -n production -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.name}{": limit="}{.resources.limits.memory}{" "}{end}{"\n"}{end}'

# Use kubectl-resource-capacity plugin for node-level view
kubectl resource-capacity --pods --sort mem.util

# Check OOMKilled status across all pods
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.status.containerStatuses != null) |
  .status.containerStatuses[] |
  select(.state.terminated.reason == "OOMKilled") |
  "\(.name) OOMKilled: exitCode=\(.state.terminated.exitCode)"
'
```

### Vertical Pod Autoscaler for Memory Right-Sizing

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  updatePolicy:
    updateMode: "Auto"  # Or "Off" for recommendation-only mode
  resourcePolicy:
    containerPolicies:
    - containerName: app
      minAllowed:
        memory: "64Mi"
      maxAllowed:
        memory: "4Gi"
      controlledResources: ["memory"]
      controlledValues: RequestsAndLimits
```

## Advanced Memory Tuning

### Transparent Huge Pages (THP) and Memory

```bash
# Check THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# Output: [always] madvise never

# For databases (PostgreSQL, Redis) - disable THP to avoid latency spikes
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Persist in sysctl
echo 'vm.nr_hugepages = 0' >> /etc/sysctl.d/99-thp.conf

# Per-cgroup THP control (cgroups v2)
echo never > /sys/fs/cgroup/myapp/memory.thp_disable
```

### Swap and Memory Pressure

```bash
# Check swap usage
swapon --show
free -h

# Configure swappiness (0-100, lower = less swapping)
# Default is 60; for containers, typically set to 0
echo 0 > /proc/sys/vm/swappiness
sysctl vm.swappiness=0

# Kubernetes nodes typically configure:
sysctl -w vm.swappiness=0

# cgroups v2 swap limit
cat /sys/fs/cgroup/myapp/memory.swap.max
echo 0 > /sys/fs/cgroup/myapp/memory.swap.max  # Disable swap for cgroup
```

### NUMA Memory Management

```bash
# Check NUMA topology
numactl --hardware
numastat

# Check per-NUMA-node allocation
cat /proc/buddyinfo

# numactl for process placement
numactl --membind=0 --cpunodebind=0 ./myapp

# For containers with NUMA-aware scheduling
docker run --cpuset-mems=0 --cpuset-cpus=0-3 my-container
```

### Memory Profiling Tools

```bash
# Valgrind for memory leaks (development)
valgrind --leak-check=full --track-origins=yes ./myapp

# perf for memory events
perf stat -e cache-misses,cache-references,page-faults ./myapp

# /proc/pid/smaps_rollup for detailed memory breakdown
cat /proc/$(pidof myapp)/smaps_rollup

# Output fields:
# Rss: Resident Set Size (physically in RAM)
# Pss: Proportional Set Size (accounts for shared pages)
# Private_Clean: Clean private pages
# Private_Dirty: Dirty private pages
# Shared_Clean: Shared clean pages (file cache)
# Shared_Dirty: Shared dirty pages
# Referenced: Pages recently accessed
# Anonymous: Anonymous memory
# Swap: Pages in swap
# SwapPss: Proportional swap

# pmap for memory map overview
pmap -x $(pidof myapp) | sort -k3 -rn | head -20
```

## Detecting and Preventing Memory Leaks in Containers

```bash
#!/bin/bash
# memory-leak-detector.sh
# Monitors container memory growth over time and alerts on suspicious patterns

CONTAINER_NAME="${1:-my-app}"
CONTAINER_ID=$(docker inspect "$CONTAINER_NAME" -f '{{.Id}}' 2>/dev/null)
CGROUP_PATH="/sys/fs/cgroup/system.slice/docker-${CONTAINER_ID}.scope"

if [ ! -d "$CGROUP_PATH" ]; then
    echo "Container not found: $CONTAINER_NAME"
    exit 1
fi

SAMPLES=10
INTERVAL=60
THRESHOLD_PCT=20  # Alert if memory grows more than 20% in SAMPLES*INTERVAL seconds

echo "Monitoring memory for container: $CONTAINER_NAME"
echo "Checking every ${INTERVAL}s, ${SAMPLES} samples"

INITIAL_MEM=$(cat "${CGROUP_PATH}/memory.current")
PREV_MEM=$INITIAL_MEM

for i in $(seq 1 $SAMPLES); do
    sleep $INTERVAL

    CURRENT_MEM=$(cat "${CGROUP_PATH}/memory.current" 2>/dev/null || echo 0)
    CURRENT_MB=$((CURRENT_MEM / 1024 / 1024))
    INITIAL_MB=$((INITIAL_MEM / 1024 / 1024))

    GROWTH_PCT=$(( (CURRENT_MEM - INITIAL_MEM) * 100 / INITIAL_MEM ))

    echo "Sample $i: ${CURRENT_MB}MB (${GROWTH_PCT}% growth from ${INITIAL_MB}MB baseline)"

    if [ $GROWTH_PCT -gt $THRESHOLD_PCT ]; then
        echo "WARNING: Memory growth exceeds ${THRESHOLD_PCT}% threshold!"
        echo "Potential memory leak detected in container: $CONTAINER_NAME"

        # Collect diagnostic information
        echo "=== Top memory consumers ==="
        docker exec "$CONTAINER_NAME" cat /proc/meminfo 2>/dev/null | head -10
        docker stats "$CONTAINER_NAME" --no-stream
    fi

    PREV_MEM=$CURRENT_MEM
done
```

## Summary

Linux cgroups memory controller provides precise, hierarchical control over memory allocation with multiple enforcement mechanisms:

- Use `memory.high` / soft limits to trigger proactive reclaim before hitting hard limits - this prevents latency spikes from aggressive reclaim
- Set appropriate QoS classes in Kubernetes to ensure critical workloads survive OOM events: use Guaranteed QoS for databases and stateful services
- Monitor PSI (Pressure Stall Information) as an early warning system for memory pressure before OOM events occur
- Configure kubelet eviction thresholds to gracefully evict pods before the OOM killer is invoked
- Disable THP for latency-sensitive workloads like databases and caches
- Set `oom_score_adj` appropriately for critical system processes (-1000 to prevent killing)
- Use VPA (Vertical Pod Autoscaler) in recommendation mode initially to right-size memory requests and limits
- Always configure both `requests` and `limits` for production workloads - pods without limits are BestEffort class and will be killed first under any memory pressure
