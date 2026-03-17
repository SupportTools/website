---
title: "systemd Resource Management: cgroups v2, CPU/Memory/IO Quotas, and Kubernetes Node Integration"
date: 2028-05-27T00:00:00-05:00
draft: false
tags: ["systemd", "Linux", "cgroups", "Resource Management", "Kubernetes", "Performance"]
categories: ["Linux", "System Administration", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to systemd resource management with cgroups v2 covering CPUQuota, MemoryMax, IOWeight, slice hierarchy, resource accounting, and integrating with Kubernetes node configuration."
more_link: "yes"
url: "/linux-systemd-resource-management-guide/"
---

systemd's integration with the Linux cgroups v2 subsystem provides precise resource management for services, users, and the entire system hierarchy. Understanding this integration is essential for Kubernetes node operators, where kubelet, container runtime, and system services all compete for the same hardware resources. This guide covers the cgroups v2 model, systemd's resource control directives, and how to configure nodes for optimal Kubernetes workload isolation.

<!--more-->

## cgroups v2 Fundamentals

The Control Groups v2 (cgroups v2) kernel subsystem provides a unified hierarchy for resource limiting, accounting, and isolation. Unlike cgroups v1, which had parallel hierarchies per controller, cgroups v2 uses a single unified tree.

### Verifying cgroups v2 is Active

```bash
# Check which cgroups version is mounted
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# Verify unified hierarchy
stat -fc %T /sys/fs/cgroup
# cgroup2fs

# On hybrid systems, check kernel command line
cat /proc/cmdline | grep -o 'systemd.unified_cgroup_hierarchy=[01]'

# Force cgroups v2 on systems defaulting to v1
# Add to /etc/default/grub:
# GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"
```

### cgroups v2 Controllers

```bash
# List available controllers on the root cgroup
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# List controllers available to a specific cgroup
cat /sys/fs/cgroup/system.slice/cgroup.controllers
# cpuset cpu io memory pids

# View cgroup subtree structure
systemd-cgls
# Control group /:
# -.slice
# ├─system.slice
# │ ├─docker.service
# │ ├─kubelet.service
# │ └─...
# └─user.slice
#   └─user-1000.slice
```

## systemd Slice Hierarchy

systemd organizes units into a hierarchy of slices:

```
-.slice (root)
├── system.slice  — system services
├── user.slice    — user sessions
├── machine.slice — virtual machines and containers
└── custom.slice  — user-defined slices
```

### Viewing the Hierarchy

```bash
# Show all slices
systemctl list-units --type=slice

# Show resource usage per slice
systemd-cgtop -d 1 --depth=2

# Inspect a specific slice
systemctl show system.slice | grep -E "CPU|Memory|IO|Tasks"
```

## CPU Resource Management

### CPUWeight and CPUQuota

```ini
# /etc/systemd/system/my-service.service
[Service]
# CPUWeight: relative weight (1-10000, default 100)
# Higher weight gets more CPU relative to other services
CPUWeight=200

# CPUQuota: hard cap as percentage of one CPU
# 100% = 1 full CPU core
# 200% = 2 full CPU cores
CPUQuota=150%

# CPUQuotaPeriodSec: the period for the quota (default 100ms)
# Shorter periods reduce latency variance but increase scheduler overhead
CPUQuotaPeriodSec=10ms

# Bind service to specific CPU cores (cpuset controller)
AllowedCPUs=0-3

# Bind memory to specific NUMA nodes
AllowedMemoryNodes=0
```

### Verifying CPU Limits

```bash
# Verify CPUQuota is applied
systemctl show my-service.service | grep CPU
# CPUWeight=200
# CPUQuota=150%
# CPUQuotaPeriodSec=10ms

# Check cgroup files directly
SERVICE_CGROUP=$(systemctl show -p ControlGroup my-service.service | cut -d= -f2)
echo "Cgroup: $SERVICE_CGROUP"
cat /sys/fs/cgroup${SERVICE_CGROUP}/cpu.max
# 150000 100000
# (quota_us period_us)

# Monitor CPU throttling
cat /sys/fs/cgroup${SERVICE_CGROUP}/cpu.stat
# usage_usec 8745321
# user_usec 5234123
# system_usec 3511198
# nr_periods 87453
# nr_throttled 1234     <- throttling events
# throttled_usec 12340000
```

### CPU Burst (Temporal Bursting)

```ini
# Allow CPU burst beyond the quota for short periods
[Service]
CPUQuota=50%
CPUQuotaPeriodSec=100ms
# Set burst accumulation via cgroup directly (systemd doesn't expose this yet)
ExecStartPre=/bin/sh -c "echo '50000 100000' > /sys/fs/cgroup/system.slice/my-service.service/cpu.max; \
  echo '100000' > /sys/fs/cgroup/system.slice/my-service.service/cpu.max.burst"
```

## Memory Resource Management

### Memory Directives

```ini
# /etc/systemd/system/my-service.service
[Service]
# Hard memory limit — OOM killer invoked above this
MemoryMax=2G

# Soft memory limit — kernel throttles memory allocation above this
# without OOM killing, encouraging the service to reclaim memory
MemoryHigh=1800M

# Minimum memory guarantee — kernel will not reclaim below this
MemoryMin=512M

# Low memory hint — kernel prefers reclaiming memory above this
MemoryLow=256M

# Swap usage limit
MemorySwapMax=0  # Disable swap for this service
```

### OOM Score Adjustment

```ini
[Service]
# OOMScoreAdjust controls OOM killer priority
# Range: -1000 (never kill) to 1000 (kill first)
# Default: 0
# For critical services:
OOMScoreAdjust=-500
# For disposable batch jobs:
# OOMScoreAdjust=500

# OOM killer behavior when MemoryMax is hit
OOMPolicy=kill   # default: kill the service
# OOMPolicy=stop  # stop the service without kernel OOM
# OOMPolicy=continue  # let the process handle SIGKILL itself
```

### Verifying Memory Limits

```bash
SERVICE_CGROUP=$(systemctl show -p ControlGroup my-service.service | cut -d= -f2)

# Check memory limits
cat /sys/fs/cgroup${SERVICE_CGROUP}/memory.max
# 2147483648  (2GB)

cat /sys/fs/cgroup${SERVICE_CGROUP}/memory.high
# 1887436800  (1800MB)

# Current memory usage
cat /sys/fs/cgroup${SERVICE_CGROUP}/memory.current
# 456523776

# Memory events (includes OOM events)
cat /sys/fs/cgroup${SERVICE_CGROUP}/memory.events
# low 0
# high 45
# max 0
# oom 0
# oom_kill 0
# oom_group_kill 0

# Detailed memory statistics
cat /sys/fs/cgroup${SERVICE_CGROUP}/memory.stat | head -20
```

## I/O Resource Management

### IO Directives

```ini
# /etc/systemd/system/my-service.service
[Service]
# IOWeight: relative I/O weight (1-10000, default 100)
IOWeight=50

# Per-device limits
# Format: "<major>:<minor> <value>" or device path
IOReadBandwidthMax=/dev/nvme0n1 100M
IOWriteBandwidthMax=/dev/nvme0n1 50M

# IOPS limits
IOReadIOPSMax=/dev/nvme0n1 5000
IOWriteIOPSMax=/dev/nvme0n1 2000

# IODeviceWeight: per-device relative weight
IODeviceWeight=/dev/nvme0n1 200

# IOAccounting: enable I/O accounting for this unit
IOAccounting=yes
```

### Finding Block Device Major/Minor Numbers

```bash
# Get device numbers for I/O policies
ls -la /dev/nvme0n1
# brw-rw---- 1 root disk 259, 0 Mar 15 10:00 /dev/nvme0n1

# 259:0 format for cgroup IO controller
cat /sys/fs/cgroup/system.slice/my-service.service/io.max
# 259:0 rbps=104857600 wbps=52428800 riops=5000 wiops=2000

# Monitor I/O stats
cat /sys/fs/cgroup/system.slice/my-service.service/io.stat
# 259:0 rbytes=45678901 wbytes=12345678 rios=12345 wios=6789 dbytes=0 dios=0

# Real-time I/O monitoring
systemd-cgtop --depth=2 -d 1
```

## Task (PID) Limits

```ini
[Service]
# Maximum number of tasks (processes + threads)
TasksMax=512

# As a percentage of the system maximum (/proc/sys/kernel/pid_max)
# TasksMax=10%
```

```bash
# Check current task count
cat /sys/fs/cgroup/system.slice/my-service.service/pids.current

# Check limit
cat /sys/fs/cgroup/system.slice/my-service.service/pids.max
```

## Custom Slice Configuration

Create custom slices to group related services with shared resource pools:

```ini
# /etc/systemd/system/workloads.slice
[Unit]
Description=Production Workloads Slice
Before=slices.target

[Slice]
# This slice gets higher CPU priority than default services
CPUWeight=500
# Memory limit for all services in this slice combined
MemoryMax=8G
MemoryHigh=7G
# I/O priority for workloads
IOWeight=300
TasksMax=10000
```

```ini
# /etc/systemd/system/my-api.service
[Unit]
Description=My API Service
After=network.target

[Service]
Slice=workloads.slice  # Place in custom slice
CPUWeight=200
MemoryMax=2G
ExecStart=/usr/local/bin/my-api
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
# Apply the configuration
systemctl daemon-reload
systemctl start workloads.slice
systemctl enable workloads.slice
systemctl start my-api.service

# Verify placement
systemctl status my-api.service | grep CGroup
# CGroup: /workloads.slice/my-api.service
```

## Resource Accounting

Enable accounting to get resource usage data:

```ini
# /etc/systemd/system/my-service.service
[Service]
# Enable all accounting
CPUAccounting=yes
MemoryAccounting=yes
IOAccounting=yes
TasksAccounting=yes
```

```bash
# View accounting data
systemctl show my-service.service \
  --property=CPUUsageNSec \
  --property=MemoryCurrent \
  --property=IOReadBytes \
  --property=IOWriteBytes \
  --property=TasksCurrent

# Historical resource usage with journald
journalctl -u my-service.service -o json | \
  jq 'select(._SYSTEMD_UNIT=="my-service.service") | {msg: .MESSAGE, cpu: .CPU_USAGE_NSEC}'
```

### System-Wide Accounting

```bash
# /etc/systemd/system.conf — enable accounting globally
[Manager]
DefaultCPUAccounting=yes
DefaultMemoryAccounting=yes
DefaultIOAccounting=yes
DefaultTasksAccounting=yes
DefaultIPAccounting=yes

# Apply
systemctl daemon-reexec
```

## Kubernetes Node Integration

Kubernetes workloads run inside cgroups managed by the container runtime. The kubelet creates a cgroup hierarchy for pods and containers within the system hierarchy.

### Kubelet cgroup Configuration

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Use cgroups v2 systemd driver (recommended)
cgroupDriver: systemd

# Root cgroup for pods (systemd slice format)
cgroupsPerQOS: true

# Enforce node-level resource limits
enforceNodeAllocatable:
  - pods
  - system-reserved
  - kube-reserved

# Reserve resources for system services
systemReserved:
  cpu: "500m"
  memory: "512Mi"
  ephemeral-storage: "10Gi"
  pid: "1000"

# Reserve resources for Kubernetes components
kubeReserved:
  cpu: "500m"
  memory: "256Mi"
  ephemeral-storage: "5Gi"
  pid: "1000"

# Hard eviction thresholds
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"

# Soft eviction thresholds (grace period before hard eviction)
evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"
evictionSoftGracePeriod:
  memory.available: "1m30s"
  nodefs.available: "2m"
```

### Cgroup Hierarchy for Kubernetes

```bash
# With systemd cgroup driver, kubelet creates:
# /kubepods.slice/                        <- all Kubernetes pods
#   kubepods-burstable.slice/             <- Burstable QoS pods
#   kubepods-besteffort.slice/            <- BestEffort QoS pods
#   kubepods-pod<UID>.slice/              <- Guaranteed QoS pods (direct)

# View the Kubernetes pod cgroup hierarchy
systemd-cgls /kubepods.slice | head -50

# Find the cgroup for a specific pod
POD_UID=$(kubectl get pod my-pod -n production -o jsonpath='{.metadata.uid}')
ls /sys/fs/cgroup/kubepods.slice/ | grep "$POD_UID"

# View container cgroup within the pod
CONTAINER_ID=$(kubectl get pod my-pod -n production \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's/containerd:\/\///')
find /sys/fs/cgroup/kubepods.slice -name "*${CONTAINER_ID:0:12}*" -type d
```

### Reserving Resources for System Services

```ini
# /etc/systemd/system/system.slice.d/resource-limits.conf
[Slice]
# Ensure system services get adequate CPU
CPUWeight=100

# Hard limit on total system slice memory
# Prevents runaway system service from impacting pods
MemoryMax=4G
```

```ini
# /etc/systemd/system/kubelet.service.d/resource-limits.conf
[Service]
# Kubelet should not be constrained — it manages the node
CPUWeight=500
MemoryMax=infinity

# Protect kubelet from OOM
OOMScoreAdjust=-999
```

### Applying Node System Reserved Slice

```ini
# /etc/systemd/system/system-reserved.slice
[Unit]
Description=System Reserved Resources Slice
Before=slices.target

[Slice]
CPUWeight=300
MemoryMax=1G
TasksMax=5000
```

```yaml
# kubelet config to use the reserved slice
# /var/lib/kubelet/config.yaml (addition)
systemReservedCgroup: /system-reserved.slice
kubeReservedCgroup: /kube-reserved.slice
```

## cgroup v2 Memory Pressure Response

```bash
# Enable pressure stall information (PSI) — requires kernel 4.20+
cat /sys/fs/cgroup/system.slice/pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# Configure PSI thresholds for proactive response
# This is used by systemd-oomd and other tools
cat /proc/pressure/memory
# some avg10=2.15 avg60=1.89 avg300=0.78 total=14567890

# systemd-oomd monitors memory pressure and kills services
# /etc/systemd/oomd.conf
# [OOM]
# SwapUsedLimit=90%
# DefaultMemoryPressureLimit=60%
# DefaultMemoryPressureDurationSec=30s
```

## Systemd Drop-in Files

Use drop-in files to override resource settings without modifying the original unit file:

```bash
# Create a drop-in for an existing service
mkdir -p /etc/systemd/system/docker.service.d/

cat > /etc/systemd/system/docker.service.d/resources.conf <<'EOF'
[Service]
CPUWeight=300
MemoryMax=8G
MemoryHigh=7G
IOWeight=200
TasksMax=unlimited
OOMScoreAdjust=-500
EOF

# For containerd
mkdir -p /etc/systemd/system/containerd.service.d/

cat > /etc/systemd/system/containerd.service.d/resources.conf <<'EOF'
[Service]
CPUWeight=400
MemoryMax=4G
MemoryHigh=3500M
OOMScoreAdjust=-600
# Ensure containerd can create many files for image layers
LimitNOFILE=1048576
EOF

systemctl daemon-reload
systemctl restart containerd
```

## Troubleshooting Resource Issues

### Diagnosing CPU Throttling

```bash
# Check if a service is being CPU throttled
SERVICE="my-api.service"
CGROUP_PATH=$(systemctl show -p ControlGroup $SERVICE | cut -d= -f2)

# Read throttle stats
cat /sys/fs/cgroup${CGROUP_PATH}/cpu.stat
# nr_periods 100000
# nr_throttled 15234  <- HIGH: service is frequently throttled
# throttled_usec 45678901234

# Calculate throttle percentage
awk '/nr_periods/{p=$2} /nr_throttled/{t=$2} END{printf "Throttle rate: %.1f%%\n", (t/p)*100}' \
  /sys/fs/cgroup${CGROUP_PATH}/cpu.stat
# Throttle rate: 15.2%

# Solution: increase CPUQuota or CPUWeight
systemctl set-property my-api.service CPUQuota=200%
```

### Diagnosing Memory Issues

```bash
# Check memory high events (soft limit exceeded)
SERVICE="my-api.service"
CGROUP_PATH=$(systemctl show -p ControlGroup $SERVICE | cut -d= -f2)

cat /sys/fs/cgroup${CGROUP_PATH}/memory.events
# low 0
# high 4521    <- service is repeatedly hitting soft limit
# max 0
# oom 0
# oom_kill 0

# Check what's consuming memory
cat /sys/fs/cgroup${CGROUP_PATH}/memory.stat | grep -E "^(file|anon|slab)"
# anon 1567890123     <- anonymous memory (heap, stack)
# file 234567890      <- page cache
# slab 12345678       <- kernel slab allocator
```

### Diagnosing I/O Issues

```bash
# Real-time I/O monitoring per cgroup
watch -n 1 "cat /sys/fs/cgroup/system.slice/my-api.service/io.stat"

# Check if I/O is limited
cat /sys/fs/cgroup/system.slice/my-api.service/io.max
# 8:0 rbps=52428800 wbps=26214400 riops=max wiops=max

# Inspect I/O pressure
cat /sys/fs/cgroup/system.slice/my-api.service/io.pressure
# some avg10=5.34 avg60=3.21 avg300=1.45 total=456789
# full avg10=1.23 avg60=0.89 avg300=0.34 total=123456
```

## Resource Control for Multiple Environments

```bash
#!/bin/bash
# configure-node-resources.sh — Apply environment-specific resource settings

ENVIRONMENT="${1:-production}"

configure_kubelet() {
    local cpu_reserved memory_reserved
    case "$ENVIRONMENT" in
        production)
            cpu_reserved="1000m"
            memory_reserved="2Gi"
            ;;
        staging)
            cpu_reserved="500m"
            memory_reserved="1Gi"
            ;;
        development)
            cpu_reserved="250m"
            memory_reserved="512Mi"
            ;;
    esac

    cat > /var/lib/kubelet/config.yaml <<EOF
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
enforceNodeAllocatable:
  - pods
  - system-reserved
  - kube-reserved
systemReserved:
  cpu: "${cpu_reserved}"
  memory: "${memory_reserved}"
kubeReserved:
  cpu: "500m"
  memory: "256Mi"
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
EOF

    systemctl restart kubelet
}

configure_system_slice() {
    mkdir -p /etc/systemd/system/system.slice.d/
    cat > /etc/systemd/system/system.slice.d/limits.conf <<EOF
[Slice]
CPUWeight=100
MemoryMax=4G
EOF
    systemctl daemon-reload
}

configure_kubelet
configure_system_slice
echo "Node resource configuration applied for $ENVIRONMENT environment"
```

## Summary

systemd's cgroups v2 integration provides granular, hierarchical resource control for Linux services. The key operational practices:

- Use `CPUWeight` for relative priority and `CPUQuota` for hard limits — combine both for predictable performance
- Set `MemoryHigh` below `MemoryMax` to trigger gradual memory reclaim before OOM events occur
- Enable `IOAccounting=yes` and use `IOWeight` to prevent I/O-intensive services from starving others
- Use custom slices to create resource pools for groups of related services
- Configure kubelet with `cgroupDriver: systemd` and define explicit system/kube reserved resources
- Monitor `cpu.stat`, `memory.events`, and `io.pressure` files directly in cgroups for low-overhead resource diagnostics
- Use drop-in files to override unit resource settings without modifying distribution-owned unit files
