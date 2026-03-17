---
title: "Linux cgroups v2: Resource Management, Kubernetes Integration, and Performance Isolation"
date: 2028-06-26T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "Kubernetes", "Resource Management", "Performance"]
categories:
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux cgroups v2, its unified hierarchy, Kubernetes integration for CPU/memory/IO resource management, and practical techniques for performance isolation in production container workloads."
more_link: "yes"
url: "/linux-cgroups-v2-kubernetes-guide/"
---

cgroups v2 is not just an incremental update over v1 - it's a fundamentally different architecture that resolves the delegation and accounting problems that made cgroups v1 difficult to use correctly. If you are running Kubernetes 1.25+ on a modern Linux kernel, you are almost certainly using cgroups v2 whether you know it or not. Understanding what it does and how Kubernetes uses it is the difference between debugging container OOM kills in ten minutes versus three hours.

This guide covers the cgroups v2 unified hierarchy, the key resource controllers that matter for Kubernetes workloads, how kubelet translates pod resource requests into cgroup parameters, and how to use cgroup information directly for performance analysis.

<!--more-->

# Linux cgroups v2: Resource Management, Kubernetes Integration, and Performance Isolation

## Section 1: cgroups v2 Architecture

### Unified Hierarchy vs. cgroups v1

cgroups v1 had a fundamental design problem: each resource controller (cpu, memory, blkio, etc.) had its own independent hierarchy. A process could be in `/cpu/production/app1` for CPU accounting while being in `/memory/batch/app1` for memory accounting. These hierarchies were completely independent, making cross-subsystem coordination impossible.

cgroups v2 uses a **unified hierarchy**: there is a single tree, and all resource controllers are attached to this one tree. A process is in exactly one cgroup, and all controllers see the same hierarchy.

```bash
# Check if cgroups v2 is active
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)

# v1 would show multiple mounts like:
# tmpfs on /sys/fs/cgroup type tmpfs
# cgroup on /sys/fs/cgroup/memory type cgroup (rw,nosuid,nodev,noexec,relatime,memory)
# cgroup on /sys/fs/cgroup/cpu,cpuacct type cgroup (rw,nosuid,nodev,noexec,relatime,cpu,cpuacct)

# Verify kernel supports cgroups v2
cat /proc/filesystems | grep cgroup2
# nodev   cgroup2

# Check current cgroup for current process
cat /proc/self/cgroup
# 0::/user.slice/user-1000.slice/session-3.scope
```

### The Unified Hierarchy Structure

```
/sys/fs/cgroup/          (root cgroup)
├── cgroup.controllers   (available controllers)
├── cgroup.procs         (PIDs in root cgroup)
├── cgroup.subtree_control  (delegated controllers)
├── memory.current       (memory usage)
├── memory.max           (memory hard limit)
├── cpu.weight           (relative CPU weight)
├── kubepods.slice/      (Kubernetes pods)
│   ├── burstable.slice/
│   │   └── pod-abc123.slice/
│   │       ├── container-xyz.scope/
│   │       └── ...
│   ├── besteffort.slice/
│   └── guaranteed.slice/
├── system.slice/
└── user.slice/
```

```bash
# List available controllers
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# List controllers delegated to children
cat /sys/fs/cgroup/cgroup.subtree_control
# cpu io memory pids

# Walk the kubepods hierarchy
find /sys/fs/cgroup/kubepods.slice -name "*.scope" -maxdepth 4 | head -20

# Find a specific container's cgroup
CONTAINER_ID=$(docker ps -q --filter name=my-app | head -1)
# or for containerd
CONTAINER_ID=$(crictl ps --name my-app -q | head -1)
find /sys/fs/cgroup -name "*${CONTAINER_ID}*" 2>/dev/null
```

## Section 2: Key Resource Controllers

### Memory Controller

The memory controller in cgroups v2 tracks and limits memory usage including anonymous memory, file cache, and kernel memory.

```bash
# Key memory controller files for a container cgroup
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/burstable.slice/pod-abc123.slice/container-xyz.scope"

# Current memory usage in bytes
cat ${CGROUP_PATH}/memory.current

# Memory limit (memory.max = hard limit, OOM kill triggered here)
cat ${CGROUP_PATH}/memory.max

# High watermark (memory.high = soft limit, throttling begins here)
cat ${CGROUP_PATH}/memory.high

# Memory swap maximum
cat ${CGROUP_PATH}/memory.swap.max

# Detailed memory statistics
cat ${CGROUP_PATH}/memory.stat
# anon 104857600         # Anonymous memory (heap, stack)
# file 52428800          # File-backed memory (page cache)
# kernel 8388608         # Kernel memory
# sock 65536             # Network socket buffers
# shmem 0               # Shared memory
# file_mapped 20971520   # Memory-mapped files
# ...

# Memory events (OOM kills, throttles)
cat ${CGROUP_PATH}/memory.events
# low 0
# high 142              # Times soft limit was exceeded
# max 0                 # Times hard limit was hit
# oom 0                 # OOM events
# oom_kill 0            # OOM kills
# oom_group_kill 0

# Check for memory pressure
cat ${CGROUP_PATH}/memory.pressure
# some avg10=2.34 avg60=0.45 avg300=0.12 total=524288
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

### CPU Controller

```bash
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/burstable.slice/pod-abc123.slice/container-xyz.scope"

# CPU weight (replaces cpu.shares in v1)
# Range: 1-10000, default 100
cat ${CGROUP_PATH}/cpu.weight

# CPU bandwidth (absolute quota)
cat ${CGROUP_PATH}/cpu.max
# 200000 100000  = 200ms quota per 100ms period = 2 CPUs max

# CPU statistics
cat ${CGROUP_PATH}/cpu.stat
# usage_usec 8234567890    # Total CPU time consumed (microseconds)
# user_usec 7234567890     # User space CPU time
# system_usec 1000000000   # Kernel space CPU time
# nr_periods 82345         # Number of scheduling periods
# nr_throttled 1234        # Periods where task was throttled
# throttled_usec 234567    # Total throttled time (microseconds)
# nr_bursts 0
# burst_usec 0

# CPU pressure
cat ${CGROUP_PATH}/cpu.pressure
# some avg10=25.5 avg60=10.2 avg300=5.1 total=12345678
```

### Block I/O Controller

```bash
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/burstable.slice/pod-abc123.slice/container-xyz.scope"

# IO statistics
cat ${CGROUP_PATH}/io.stat
# 8:0 rbytes=104857600 wbytes=52428800 rios=1024 wios=512 dbytes=0 dios=0

# IO limits (throttling by device)
cat ${CGROUP_PATH}/io.max
# 8:0 rbps=104857600 wbps=52428800 riops=1000 wiops=500

# IO weight (for relative scheduling)
cat ${CGROUP_PATH}/io.weight
# default 100
# 8:0 200

# IO pressure
cat ${CGROUP_PATH}/io.pressure
# some avg10=0.50 avg60=0.20 avg300=0.10 total=5678900
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

### PIDs Controller

The PIDs controller limits the number of processes/threads that can be created, preventing fork bombs:

```bash
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/burstable.slice/pod-abc123.slice/container-xyz.scope"

# Current PID count
cat ${CGROUP_PATH}/pids.current
# 47

# PID limit
cat ${CGROUP_PATH}/pids.max
# 1024

# PID events (limit hits)
cat ${CGROUP_PATH}/pids.events
# max 0
```

## Section 3: Kubernetes Integration

### How kubelet Sets cgroup Parameters

Kubernetes translates pod resource requests and limits into cgroup parameters according to QoS class:

```
Pod QoS Classes:
- Guaranteed: requests == limits for all containers
- Burstable:  at least one container has requests/limits, but not all equal
- BestEffort: no resources defined
```

For a Guaranteed pod with `cpu: "2"` and `memory: "4Gi"`:

```bash
# CPU: cpu.max is set to quota/period
# 2 CPUs = 200000 / 100000 (2 full periods per 100ms period)
echo "200000 100000" > /sys/fs/cgroup/kubepods.slice/guaranteed.slice/pod-xyz.slice/cpu.max

# Memory: memory.max set to hard limit
echo "4294967296" > /sys/fs/cgroup/kubepods.slice/guaranteed.slice/pod-xyz.slice/memory.max
# memory.high NOT set for Guaranteed pods (no soft limit)
```

For a Burstable pod with `cpu requests: "0.5", limits: "2"` and `memory requests: "512Mi", limits: "2Gi"`:

```bash
# CPU weight derived from requests (0.5 CPU = 50 shares)
# cpu.weight = max(2, floor(requests * 1024 / 1000))
echo "51" > .../cpu.weight

# CPU hard limit from limits
echo "200000 100000" > .../cpu.max

# Memory high from requests (soft limit)
echo "536870912" > .../memory.high  # 512Mi

# Memory max from limits (hard limit)
echo "2147483648" > .../memory.max  # 2Gi
```

### Enabling cgroups v2 on Kubernetes Nodes

For nodes still running cgroups v1 (older distros), enable v2:

```bash
# On the host (requires reboot)
# GRUB configuration
cat >> /etc/default/grub <<'EOF'
GRUB_CMDLINE_LINUX_DEFAULT="systemd.unified_cgroup_hierarchy=1"
EOF
update-grub
reboot

# Verify after reboot
mount | grep cgroup2
stat -fc %T /sys/fs/cgroup/
# Returns: cgroup2fs (v2) or tmpfs (v1)
```

For Kubernetes nodes using systemd:

```bash
# /etc/systemd/system/containerd.service.d/override.conf
[Service]
Delegate=yes

# kubelet configuration
# /var/lib/kubelet/config.yaml
cgroupDriver: systemd  # Must match container runtime
```

### kubelet cgroup Configuration

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Must match container runtime (containerd/cri-o use systemd)
cgroupDriver: systemd

# Cgroup version (v1 or v2)
# kubelet auto-detects; set explicitly if needed
cgroupVersion: v2

# Reserve resources for system processes
systemReserved:
  cpu: "200m"
  memory: "500Mi"
  ephemeral-storage: "10Gi"

# Reserve resources for kubernetes components
kubeReserved:
  cpu: "500m"
  memory: "1Gi"
  ephemeral-storage: "10Gi"

# What happens when node runs out of resources
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
  imagefs.available: "15%"

# Soft eviction with grace period
evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"

evictionSoftGracePeriod:
  memory.available: "1m"
  nodefs.available: "2m"

# PID limit per pod
podPidsLimit: 4096

# Memory manager policy
memoryManagerPolicy: Static  # For guaranteed memory allocation
```

## Section 4: Performance Isolation Techniques

### CPU Pinning with cpuset

For latency-sensitive workloads, CPU pinning prevents CPU cache thrashing:

```bash
# Check cpuset controller availability
cat /sys/fs/cgroup/cgroup.controllers | grep cpuset

# For a specific container cgroup, set exclusive CPU affinity
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/guaranteed.slice/pod-xyz.slice/container-abc.scope"

# Assign CPUs 2 and 3 exclusively to this container
echo "2-3" > ${CGROUP_PATH}/cpuset.cpus
echo "exclusive" > ${CGROUP_PATH}/cpuset.cpus.partition
```

In Kubernetes, CPU pinning is managed by the CPU Manager:

```yaml
# /var/lib/kubelet/config.yaml
cpuManagerPolicy: static
cpuManagerPolicyOptions:
  full-pcpus-only: "true"
  distribute-cpus-across-numa: "true"
reservedSystemCPUs: "0,1"  # CPUs reserved for OS and kube components
```

For static CPU manager policy, pods must be Guaranteed QoS with integer CPU requests:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: latency-critical-app
spec:
  containers:
  - name: app
    image: my-app:latest
    resources:
      requests:
        cpu: "4"          # Integer - enables exclusive CPU pinning
        memory: "8Gi"
      limits:
        cpu: "4"          # Must equal requests for Guaranteed QoS
        memory: "8Gi"
```

Verify CPU pinning:

```bash
# Check which CPUs are assigned to the pod
POD_UID=$(kubectl get pod latency-critical-app -o jsonpath='{.metadata.uid}')
find /sys/fs/cgroup/kubepods.slice -name "*${POD_UID}*" -exec cat {}/cpuset.cpus \; 2>/dev/null
```

### NUMA-Aware Memory Allocation

```yaml
# /var/lib/kubelet/config.yaml
topologyManagerPolicy: best-effort  # or "restricted", "single-numa-node"
topologyManagerScope: container  # or "pod"
memoryManagerPolicy: Static
reservedMemory:
- numaNode: 0
  limits:
    memory: "2Gi"
- numaNode: 1
  limits:
    memory: "2Gi"
```

```bash
# Check NUMA topology
numactl --hardware

# Verify pod is allocated on correct NUMA node
kubectl get pod latency-critical-app -o yaml | grep -A 10 "topology\|numa"
```

### Memory Quality of Service

cgroups v2 introduces memory QoS through the `memory.high` (soft limit) mechanism:

```bash
# memory.high causes reclamation before hard limit is hit
# This prevents OOM kills by throttling workloads that exceed their soft limit

# For burstable pods, memory.high = requests * memoryQoSMemoryLimitRequestRatio
# Default ratio is 1.0 (soft limit = requests)

# Memory QoS classes in cgroup v2:
# Guaranteed: memory.high = unlimited, memory.max = limits
# Burstable:  memory.high = requests, memory.max = limits
# BestEffort: memory.high = unlimited, memory.max = unlimited
```

Enable Memory QoS in kubelet (alpha in 1.22, beta in 1.27):

```yaml
# /var/lib/kubelet/config.yaml
featureGates:
  MemoryQoS: true

# This causes kubelet to set memory.high = requests for burstable pods
# Providing early warning before OOM, via throttling
```

## Section 5: Monitoring cgroups v2

### Reading PSI (Pressure Stall Information)

PSI is a cgroups v2 feature that measures resource pressure:

```bash
# Read CPU pressure for a cgroup
cat /sys/fs/cgroup/kubepods.slice/burstable.slice/pod-xyz.slice/cpu.pressure
# some avg10=25.50 avg60=10.20 avg300=5.10 total=12345678
# ↑ 25.5% of time in last 10s, at least one task was stalled waiting for CPU

# Memory pressure
cat /sys/fs/cgroup/kubepods.slice/burstable.slice/pod-xyz.slice/memory.pressure
# some avg10=0.50 avg60=0.20 avg300=0.10 total=5678900
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
# "full" = ALL tasks were stalled (typically indicates OOM pressure)

# IO pressure
cat /sys/fs/cgroup/kubepods.slice/burstable.slice/pod-xyz.slice/io.pressure
```

### cgroup-aware Node Exporter Metrics

The Prometheus node exporter exposes cgroups v2 metrics:

```yaml
# prometheus-node-exporter DaemonSet
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  template:
    spec:
      hostPID: true
      hostIPC: true
      hostNetwork: true
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.7.0
        args:
        - --path.rootfs=/host
        - --collector.cgroups         # Enable cgroup metrics
        - --collector.pressure        # Enable PSI metrics
        - --collector.systemd
        - --no-collector.netclass     # Disable expensive collectors
        volumeMounts:
        - name: sys
          mountPath: /host/sys
          readOnly: true
        - name: root
          mountPath: /host
          readOnly: true
      volumes:
      - name: sys
        hostPath:
          path: /sys
      - name: root
        hostPath:
          path: /
```

### cgroup Memory Analysis Script

```bash
#!/bin/bash
# analyze-pod-cgroups.sh
# Analyze cgroup resource usage for a pod

POD_NAME="${1:?Usage: $0 <pod-name> <namespace>}"
NAMESPACE="${2:-default}"

echo "=== cgroup Analysis: ${POD_NAME} in ${NAMESPACE} ==="

# Get pod UID
POD_UID=$(kubectl get pod ${POD_NAME} -n ${NAMESPACE} \
  -o jsonpath='{.metadata.uid}')
echo "Pod UID: ${POD_UID}"

# Find cgroup path
CGROUP_PATH=$(find /sys/fs/cgroup/kubepods.slice -name "*${POD_UID}*" \
  -maxdepth 3 -type d | head -1)

if [ -z "${CGROUP_PATH}" ]; then
    echo "ERROR: Could not find cgroup path for pod ${POD_NAME}"
    exit 1
fi
echo "Cgroup path: ${CGROUP_PATH}"

echo ""
echo "--- Memory Usage ---"
MEMORY_CURRENT=$(cat ${CGROUP_PATH}/memory.current 2>/dev/null || echo "N/A")
MEMORY_MAX=$(cat ${CGROUP_PATH}/memory.max 2>/dev/null || echo "N/A")
MEMORY_HIGH=$(cat ${CGROUP_PATH}/memory.high 2>/dev/null || echo "N/A")

echo "Current: $(numfmt --to=iec ${MEMORY_CURRENT} 2>/dev/null || echo ${MEMORY_CURRENT})"
echo "Max (hard limit): $(numfmt --to=iec ${MEMORY_MAX} 2>/dev/null || echo ${MEMORY_MAX})"
echo "High (soft limit): $(numfmt --to=iec ${MEMORY_HIGH} 2>/dev/null || echo ${MEMORY_HIGH})"

echo ""
echo "--- Memory Events ---"
cat ${CGROUP_PATH}/memory.events 2>/dev/null || echo "N/A"

echo ""
echo "--- CPU Statistics ---"
cat ${CGROUP_PATH}/cpu.stat 2>/dev/null || echo "N/A"

echo ""
echo "--- CPU Throttling ---"
if [ -f "${CGROUP_PATH}/cpu.stat" ]; then
    NR_PERIODS=$(grep "^nr_periods" ${CGROUP_PATH}/cpu.stat | awk '{print $2}')
    NR_THROTTLED=$(grep "^nr_throttled" ${CGROUP_PATH}/cpu.stat | awk '{print $2}')
    if [ "${NR_PERIODS}" -gt 0 ]; then
        THROTTLE_PCT=$(echo "scale=2; ${NR_THROTTLED} * 100 / ${NR_PERIODS}" | bc)
        echo "Throttled: ${THROTTLE_PCT}% (${NR_THROTTLED}/${NR_PERIODS} periods)"
    fi
fi

echo ""
echo "--- PSI Pressure ---"
echo "CPU:"
cat ${CGROUP_PATH}/cpu.pressure 2>/dev/null || echo "N/A"
echo "Memory:"
cat ${CGROUP_PATH}/memory.pressure 2>/dev/null || echo "N/A"
echo "IO:"
cat ${CGROUP_PATH}/io.pressure 2>/dev/null || echo "N/A"

# Per-container breakdown
echo ""
echo "--- Per-Container Breakdown ---"
for container_cgroup in ${CGROUP_PATH}/*.scope; do
    if [ -d "${container_cgroup}" ]; then
        CONTAINER_NAME=$(basename ${container_cgroup})
        MEM=$(cat ${container_cgroup}/memory.current 2>/dev/null || echo "0")
        echo "  ${CONTAINER_NAME}: $(numfmt --to=iec ${MEM} 2>/dev/null || echo ${MEM})"
    fi
done
```

### Prometheus Alerting Rules for cgroups

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cgroups-alerts
  namespace: monitoring
spec:
  groups:
  - name: cgroup-resource-pressure
    interval: 30s
    rules:
    - alert: ContainerCPUThrottlingHigh
      expr: |
        rate(container_cpu_cfs_throttled_seconds_total[5m]) /
        rate(container_cpu_cfs_periods_total[5m]) > 0.25
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Container {{ $labels.container }} CPU throttling > 25%"
        description: "Container is throttled {{ $value | humanizePercentage }} of CPU periods. Consider increasing CPU limits."

    - alert: ContainerMemoryNearLimit
      expr: |
        container_memory_working_set_bytes /
        container_spec_memory_limit_bytes > 0.90
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Container {{ $labels.container }} memory usage > 90% of limit"

    - alert: ContainerOOMKilled
      expr: kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
      for: 0m
      labels:
        severity: critical
      annotations:
        summary: "Container {{ $labels.container }} was OOMKilled"

    - alert: NodeMemoryPressureHigh
      expr: node_pressure_memory_stalled_seconds_total > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.instance }} memory pressure stall > 10%"
```

## Section 6: Debugging Resource Issues

### Identifying CPU Throttling

CPU throttling is one of the most common performance issues in containerized workloads and is often misattributed to slow code:

```bash
#!/bin/bash
# find-throttled-containers.sh
# Identify containers with significant CPU throttling

echo "=== CPU Throttling Analysis ==="

# Find all container cgroups
find /sys/fs/cgroup/kubepods.slice -name "cpu.stat" | while read stat_file; do
    CGROUP_DIR=$(dirname ${stat_file})

    NR_PERIODS=$(grep "^nr_periods" ${stat_file} | awk '{print $2}')
    NR_THROTTLED=$(grep "^nr_throttled" ${stat_file} | awk '{print $2}')

    if [ -n "${NR_PERIODS}" ] && [ "${NR_PERIODS}" -gt 0 ]; then
        THROTTLE_PCT=$(echo "scale=1; ${NR_THROTTLED} * 100 / ${NR_PERIODS}" | bc)

        # Only show containers with >5% throttling
        if (( $(echo "${THROTTLE_PCT} > 5" | bc -l) )); then
            echo "THROTTLED: ${THROTTLE_PCT}%  ${CGROUP_DIR}"
        fi
    fi
done | sort -rn
```

### Investigating OOM Events

```bash
#!/bin/bash
# Investigate OOM kills

# Check recent OOM events in kernel logs
dmesg | grep -i "oom\|out of memory" | tail -50

# Check for OOM kills by cgroup
find /sys/fs/cgroup/kubepods.slice -name "memory.events" | while read events_file; do
    OOM_KILL=$(grep "^oom_kill " ${events_file} | awk '{print $2}')
    if [ "${OOM_KILL}" -gt 0 ]; then
        echo "OOM kills: ${OOM_KILL}  ${events_file}"
    fi
done

# Get Kubernetes perspective
kubectl get events -A --field-selector=reason=OOMKilling
kubectl get events -A | grep -i "oom\|killed"

# Check container terminated reasons
kubectl get pods -A -o json | jq -r '
  .items[] |
  {
    namespace: .metadata.namespace,
    pod: .metadata.name,
    containers: [.status.containerStatuses[]? |
      select(.lastState.terminated.reason == "OOMKilled") |
      {container: .name, oom: .lastState.terminated.reason}
    ]
  } |
  select(.containers | length > 0)
'
```

### cgroups v2 vs v1 Compatibility Issues

Some tools have issues with cgroups v2. Common problems:

```bash
# Check if your container runtime supports cgroups v2
ctr version
containerd config dump | grep -i cgroup

# Some older versions of Java have issues with cgroups v2 container limits
# They read limits from /proc/self/cgroup which looks different in v2
# Fix: Use Java 11+ which properly detects cgroups v2

# Docker default configuration may use cgroups v1
# Check docker cgroup driver
docker info | grep -i cgroup

# Older systemd versions (< 244) have limited cgroups v2 support
systemctl --version
```

## Section 7: cgroups v2 and Systemd Integration

Kubernetes uses systemd as the cgroup driver, which means systemd manages the cgroup hierarchy and kubelet creates cgroups within it.

### Understanding Systemd Slice Hierarchy

```
systemd hierarchy:
-.slice (root)
├── system.slice (system services)
│   ├── containerd.service
│   └── kubelet.service
├── kubepods.slice (Kubernetes pods)
│   ├── kubepods-burstable.slice
│   │   └── kubepods-burstable-pod<uid>.slice
│   │       └── cri-containerd-<containerid>.scope
│   ├── kubepods-besteffort.slice
│   └── kubepods-guaranteed.slice
└── user.slice (user sessions)
```

```bash
# List systemd slices
systemctl list-units --type=slice

# Show kubepods hierarchy
systemctl list-units --type=slice | grep kubepods

# Check cgroup config for a slice
systemctl show kubepods-burstable.slice | grep -E "Memory|CPU|IO"

# Set CPU/memory limits on a slice via systemd
# (kubelet does this automatically for pods)
systemctl set-property kubepods-burstable.slice CPUQuota=400%
systemctl set-property kubepods-burstable.slice MemoryLimit=10G
```

### Systemd Drop-in for Node Resource Reservation

```bash
# Create systemd drop-in to reserve resources for system services
mkdir -p /etc/systemd/system/system.slice.d/

cat > /etc/systemd/system/system.slice.d/resource-limits.conf <<'EOF'
[Slice]
# Reserve CPU for system services
CPUWeight=1000
# Memory high watermark for system services (soft limit)
MemoryHigh=2G
EOF

systemctl daemon-reload
```

## Section 8: Production Best Practices

### cgroups v2 Production Checklist

```bash
#!/bin/bash
# cgroups-v2-readiness-check.sh

echo "=== cgroups v2 Production Readiness Check ==="

# 1. Verify cgroups v2 is active
if stat -fc %T /sys/fs/cgroup/ | grep -q cgroup2fs; then
    echo "[PASS] cgroups v2 is active"
else
    echo "[FAIL] cgroups v2 is NOT active (still using v1)"
    echo "  Fix: Add 'systemd.unified_cgroup_hierarchy=1' to GRUB_CMDLINE_LINUX_DEFAULT"
fi

# 2. Verify systemd cgroup driver
CGROUP_DRIVER=$(kubectl get node $(hostname) -o jsonpath='{.status.nodeInfo.containerRuntimeVersion}' 2>/dev/null || echo "unknown")
echo "[INFO] Container runtime: ${CGROUP_DRIVER}"

KUBELET_CGROUP_DRIVER=$(ps aux | grep kubelet | grep -oP '(?<=--cgroup-driver=)\S+' || echo "unknown")
echo "[INFO] kubelet cgroup driver: ${KUBELET_CGROUP_DRIVER}"

# 3. Verify PSI is available
if [ -f /sys/fs/cgroup/cpu.pressure ]; then
    echo "[PASS] PSI (Pressure Stall Information) is available"
else
    echo "[WARN] PSI not available - add 'psi=1' to kernel parameters"
fi

# 4. Verify controllers
CONTROLLERS=$(cat /sys/fs/cgroup/cgroup.controllers)
for controller in cpu memory io pids; do
    if echo "${CONTROLLERS}" | grep -q "${controller}"; then
        echo "[PASS] Controller '${controller}' is available"
    else
        echo "[FAIL] Controller '${controller}' is NOT available"
    fi
done

# 5. Check kernel version (4.15+ for v2, 5.8+ for full feature set)
KERNEL_VERSION=$(uname -r | cut -d. -f1-2)
MAJOR=$(echo ${KERNEL_VERSION} | cut -d. -f1)
MINOR=$(echo ${KERNEL_VERSION} | cut -d. -f2)
if [ "${MAJOR}" -gt 5 ] || ([ "${MAJOR}" -eq 5 ] && [ "${MINOR}" -ge 8 ]); then
    echo "[PASS] Kernel ${KERNEL_VERSION} has full cgroups v2 support"
elif [ "${MAJOR}" -ge 4 ]; then
    echo "[WARN] Kernel ${KERNEL_VERSION} has partial cgroups v2 support (upgrade to 5.8+ recommended)"
else
    echo "[FAIL] Kernel ${KERNEL_VERSION} has very limited cgroups v2 support"
fi

echo ""
echo "=== Resource Usage Summary ==="
echo "kubepods CPU usage:"
cat /sys/fs/cgroup/kubepods.slice/cpu.stat 2>/dev/null | grep "^usage_usec" | awk '{printf "  %s μs\n", $2}'
echo "kubepods Memory:"
cat /sys/fs/cgroup/kubepods.slice/memory.current 2>/dev/null | numfmt --to=iec | xargs -I{} echo "  Current: {}"
```

### Resource Quota Best Practices

```yaml
# Set namespace-level resource quotas to complement pod-level limits
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    requests.cpu: "100"
    requests.memory: 200Gi
    limits.cpu: "200"
    limits.memory: 400Gi
    pods: "200"
    count/persistentvolumeclaims: "50"

---
# LimitRange ensures all pods have resource definitions
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limits
  namespace: production
spec:
  limits:
  - type: Container
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "8"
      memory: "16Gi"
    min:
      cpu: "50m"
      memory: "64Mi"
  - type: Pod
    max:
      cpu: "32"
      memory: "64Gi"
  - type: PersistentVolumeClaim
    max:
      storage: 100Gi
    min:
      storage: 1Gi
```

### Key Takeaways

- cgroups v2 uses a unified hierarchy - one cgroup tree for all resource controllers
- Kubernetes 1.25+ defaults to cgroups v2 on compatible nodes; verify with `stat -fc %T /sys/fs/cgroup/`
- Always use `cgroupDriver: systemd` in kubelet config when running on systemd nodes
- CPU throttling is measured via `cpu.stat` - monitor `nr_throttled / nr_periods` ratio
- PSI (Pressure Stall Information) in `cpu.pressure`, `memory.pressure`, `io.pressure` provides early warning of resource contention
- For latency-critical workloads, use `cpuManagerPolicy: static` with Guaranteed QoS and integer CPU requests for exclusive CPU pinning
- OOM kills are logged in `memory.events` per cgroup and in kernel dmesg
- The `memory.high` soft limit (set for Burstable pods) causes memory reclamation before OOM, preventing unnecessary kills
