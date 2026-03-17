---
title: "Linux Resource Groups and Unified Cgroup Hierarchy: Production Resource Governance"
date: 2030-11-19T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "systemd", "Resource Management", "Kubernetes", "Performance", "Kernel", "System Administration"]
categories:
- Linux
- System Administration
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Unified cgroup v2 guide covering systemd slice hierarchy, resource delegation, cgroup pressure propagation, memory.high vs memory.max semantics, CPU bandwidth control groups, I/O cost model, and using systemd-run for temporary resource-limited processes."
more_link: "yes"
url: "/linux-unified-cgroup-v2-systemd-resource-governance-guide/"
---

The unified cgroup v2 hierarchy (cgroupv2) introduced in Linux 4.5 and enabled by default in RHEL 9, Ubuntu 22.04, and Fedora 31+ replaces the fragmented cgroup v1 controller model with a single unified tree rooted at `/sys/fs/cgroup`. This simplification enables pressure-aware resource management, composite I/O and memory policies, and correct containment of multi-controller workloads. Production systems running Kubernetes, container workloads, or multiple co-located services benefit significantly from understanding how to structure and govern resources through the systemd slice hierarchy and direct cgroup manipulation.

<!--more-->

## The Unified Hierarchy Model

In cgroup v1, each resource controller (memory, cpu, blkio, devices) had its own hierarchy rooted at `/sys/fs/cgroup/<controller>/`. A process could be in different positions in different hierarchies, making cross-controller resource accounting impossible.

Cgroup v2 uses a single hierarchy under `/sys/fs/cgroup/` with all controllers enabled at each node. This enables:

- **Pressure-aware scheduling**: PSI (Pressure Stall Information) provides per-cgroup memory, CPU, and I/O pressure metrics that were impossible with v1.
- **Correct memory+swap accounting**: The unified memory controller accounts for both memory and swap in a single limit.
- **I/O cost model**: The blkio v2 controller uses a cost-based model that correctly handles queue depths and multiple devices.
- **Delegation model**: A cgroup can be delegated to an unprivileged manager (like Kubernetes kubelet or Podman) without kernel support for each manager type.

Verify cgroupv2 is active:

```bash
stat -f -c %T /sys/fs/cgroup
# cgroup2fs  (cgroupv2 is active)

# Or check mount
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)
```

## systemd Slice Hierarchy

systemd manages cgroups through a three-level hierarchy:

```
/ (root cgroup)
├── system.slice      # System services managed by systemd
│   ├── nginx.service
│   ├── postgresql.service
│   └── ...
├── user.slice        # User sessions
├── machine.slice     # VMs and containers (systemd-nspawn, libvirt)
└── custom.slice      # User-defined slices
    ├── databases.slice
    │   ├── mysql.service
    │   └── redis.service
    └── webapp.slice
        ├── api.service
        └── worker.service
```

Inspect the current hierarchy:

```bash
# Show the systemd unit hierarchy with resource usage
systemd-cgls --all

# Show resource usage per slice
systemd-cgtop -d 2 -n 5

# Inspect a specific service's cgroup
systemctl status nginx.service
# CGroup: /system.slice/nginx.service
#   ├─ 12345 nginx: master process
#   └─ 12346 nginx: worker process
```

## Defining Custom Slices

Custom slices isolate groups of services and define aggregate resource limits. A slice unit file goes in `/etc/systemd/system/`:

```ini
# /etc/systemd/system/databases.slice
[Unit]
Description=Database Services Slice
Before=slices.target

[Slice]
# CPU: allow up to 50% of total CPU time across all database services
CPUQuota=200%          # 200% = 2 full CPUs (on an 8-CPU system = 25%)
CPUWeight=100          # Relative weight when competing with other slices

# Memory: soft limit 8GB (SIGKILL starts at 10GB)
MemoryHigh=8G
MemoryMax=10G
MemorySwapMax=0        # No swap for databases

# I/O: limit total reads/writes to 500 MiB/s
IOReadBandwidthMax=/dev/nvme0n1 524288000
IOWriteBandwidthMax=/dev/nvme0n1 524288000
IOWeight=200           # Higher I/O priority than default (100)

# Task limit
TasksMax=4096
```

```bash
systemctl daemon-reload
systemctl start databases.slice
systemctl status databases.slice
```

## Service Unit Resource Configuration

Individual services can specify resource limits that are enforced within the slice:

```ini
# /etc/systemd/system/postgresql.service.d/resources.conf
[Service]
# CPU
CPUWeight=150         # Higher weight than other services in databases.slice
CPUQuota=150%         # Cap at 1.5 CPUs absolute

# Memory
MemoryHigh=4G         # Trigger throttling at 4GB
MemoryMax=6G          # Hard kill at 6GB
MemorySwapMax=0

# I/O weight within databases.slice
IOWeight=300

# Prevent resource limit inheritance from parent slice exceeding these values
Slice=databases.slice

# OOM killer adjustment
OOMScoreAdjust=-900   # Protect PostgreSQL from OOM killer
OOMPolicy=kill        # Kill this service if OOM (don't try to continue)
```

Apply the drop-in:

```bash
mkdir -p /etc/systemd/system/postgresql.service.d/
# (write the file above)
systemctl daemon-reload
systemctl restart postgresql.service

# Verify the cgroup limits
cat /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/memory.max
# 6442450944  (6GB in bytes)
```

## Memory Controller: memory.high vs memory.max

The difference between these two limits is critical for production deployments:

| Parameter | Behavior | Use Case |
|-----------|----------|----------|
| `memory.high` | Soft limit — triggers reclaim and throttling | Set below memory.max as a "soft ceiling" |
| `memory.max` | Hard limit — triggers OOM kill within cgroup | Ultimate safety ceiling |
| `memory.swap.max` | Maximum swap usage | Set to 0 to disable swap for latency-sensitive processes |
| `memory.min` | Guaranteed minimum — not reclaimed even under global pressure | Reserve memory for critical services |
| `memory.low` | Soft minimum — reclaimed last under global pressure | Hint for memory-intensive services |

The recommended pattern for production services:

```bash
# Set memory.high to 80% of desired limit, memory.max to 100%
# This gives the kernel room to throttle before triggering OOM

# Via systemd unit
MemoryHigh=6400M   # 80% of 8G
MemoryMax=8G
MemoryMin=1G       # Guarantee at least 1GB won't be reclaimed

# Direct cgroup manipulation
echo "6871834624"   > /sys/fs/cgroup/databases.slice/postgresql.service/memory.high
echo "8589934592"   > /sys/fs/cgroup/databases.slice/postgresql.service/memory.max
echo "1073741824"   > /sys/fs/cgroup/databases.slice/postgresql.service/memory.min
echo "0"            > /sys/fs/cgroup/databases.slice/postgresql.service/memory.swap.max
```

### Monitoring Memory Pressure

PSI (Pressure Stall Information) exposes how much time tasks are waiting for memory:

```bash
# Check memory pressure for PostgreSQL cgroup
cat /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/memory.pressure
# some avg10=0.00 avg60=0.12 avg300=0.05 total=847261
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# "some" = fraction of time at least one task was stalled waiting for memory
# "full" = fraction of time ALL tasks were stalled (indicates severe pressure)
# avg10/avg60/avg300 = exponential moving averages over 10s, 60s, 300s windows
```

Setting a PSI threshold notification with `inotify`:

```bash
# Register a pressure threshold notification
# This triggers when 10% of time is spent waiting for memory over 100ms window
# The notification file descriptor becomes readable when the threshold is crossed

python3 << 'EOF'
import os

THRESHOLD_PERCENT = 10   # 10% of time stalled
WINDOW_US = 100000       # 100ms window

pressure_file = "/sys/fs/cgroup/system.slice/databases.slice/postgresql.service/memory.pressure"

# Open and write the threshold
fd = os.open(pressure_file, os.O_RDWR | os.O_NONBLOCK)
trigger = f"some {THRESHOLD_PERCENT * 1000} {WINDOW_US}\n"
os.write(fd, trigger.encode())

# Poll for notifications
import select
print(f"Monitoring memory pressure (threshold: {THRESHOLD_PERCENT}%)")
while True:
    r, _, _ = select.select([fd], [], [], 30)
    if r:
        print("ALERT: Memory pressure threshold exceeded!")
        # Reset the trigger
        os.lseek(fd, 0, os.SEEK_SET)
        buf = os.read(fd, 128)
        print(f"Current pressure: {buf.decode().strip()}")
EOF
```

## CPU Bandwidth Control Groups

CPU control in cgroup v2 uses two orthogonal mechanisms:

- **cpu.weight** (1-10000, default 100): Proportional share of CPU time when competing with siblings.
- **cpu.max** (quota period): Hard bandwidth limit — `500000 1000000` means the cgroup gets 0.5 CPU seconds per 1 second (50% of one CPU).

```bash
# Inspect current CPU settings
cat /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/cpu.max
# max 100000  (max = no hard limit)

# Limit PostgreSQL to 2 CPUs maximum
echo "200000 100000" > \
  /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/cpu.max

# Set a higher weight than default (100)
echo "150" > \
  /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/cpu.weight

# Verify CPU time statistics
cat /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/cpu.stat
# usage_usec 4523847293
# user_usec  3218492011
# system_usec 1305355282
# core_sched.force_idle_usec 0
# nr_periods 4523847
# nr_throttled 127
# throttled_usec 63891
# nr_bursts 0
# burst_usec 0
```

### CPU Pressure Monitoring

```bash
# Check CPU pressure for all database services
cat /sys/fs/cgroup/system.slice/databases.slice/cpu.pressure
# some avg10=2.41 avg60=1.12 avg300=0.67 total=2847261
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# CPU "some" pressure means tasks are runnable but waiting for CPU time
# Values above 5% suggest CPU contention — consider increasing cpu.weight
# or relaxing cpu.max
```

## I/O Cost Model (blkio v2)

The blkio v2 controller in cgroupv2 uses a cost-based model that accounts for I/O size, read vs. write, and device queue depth. This replaces the simplistic weight-based model in v1.

```bash
# View I/O statistics for a service
cat /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/io.stat
# 259:0 rbytes=107374182400 wbytes=53687091200 rios=26214400 wios=13107200 dbytes=0 dios=0

# Set I/O weight
echo "259:0 200" > \
  /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/io.weight

# Hard bandwidth limits (bytes/second)
NVME_MAJOR_MINOR=$(ls -l /dev/nvme0n1 | awk '{print $5, $6}' | tr ',' ':')
echo "${NVME_MAJOR_MINOR} 524288000" > \
  /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/io.max

# Check I/O pressure
cat /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/io.pressure
# some avg10=0.52 avg60=0.23 avg300=0.11 total=523847
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

## Kubernetes and cgroupv2

Kubernetes 1.25+ fully supports cgroupv2 when the container runtime (containerd 1.6+, CRI-O 1.24+) is configured to use it.

### Kubernetes Node Configuration for cgroupv2

```bash
# Verify cgroupv2 is active on the node
stat -fc %T /sys/fs/cgroup

# In /etc/containerd/config.toml, ensure cgroupns mode is set
# (containerd defaults to cgroupv2 when the system uses it)
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true    # Required for cgroupv2

# kubelet configuration
# /var/lib/kubelet/config.yaml
cgroupDriver: systemd    # Must match containerd's SystemdCgroup setting
cgroupsPerQOS: true
```

### Pod QoS Classes and cgroup Placement

Kubernetes maps Pod QoS classes to cgroup hierarchy levels:

```
/sys/fs/cgroup/
└── kubepods.slice/
    ├── kubepods-guaranteed.slice/      # Guaranteed QoS Pods
    │   └── kubepods-pod<uid>.slice/
    │       └── <container-id>.scope/
    ├── kubepods-burstable.slice/       # Burstable QoS Pods
    │   └── kubepods-pod<uid>.slice/
    └── kubepods-besteffort.slice/      # BestEffort QoS Pods
```

For a Guaranteed QoS pod (requests == limits for all resources):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres-guaranteed
spec:
  containers:
    - name: postgres
      image: postgres:16.3
      resources:
        requests:
          memory: "4Gi"
          cpu: "2"
        limits:
          memory: "4Gi"     # Must equal requests for Guaranteed class
          cpu: "2"
```

Inspect the resulting cgroup:

```bash
# Find the container cgroup
POD_UID=$(kubectl get pod postgres-guaranteed -o jsonpath='{.metadata.uid}')
CONTAINER_ID=$(kubectl get pod postgres-guaranteed \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's|containerd://||')

CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/kubepods-guaranteed.slice/kubepods-pod${POD_UID//-/_}.slice/${CONTAINER_ID:0:64}.scope"

cat "${CGROUP_PATH}/memory.max"
# 4294967296  (4GiB)

cat "${CGROUP_PATH}/cpu.max"
# 200000 100000  (2 CPUs)
```

## systemd-run for Temporary Resource-Limited Processes

`systemd-run` creates a transient scope or service unit that is resource-governed by systemd without requiring a unit file:

```bash
# Run a database backup with CPU and memory limits
systemd-run \
  --unit="db-backup-$(date +%Y%m%d%H%M%S)" \
  --slice=databases.slice \
  --scope \
  --property="CPUWeight=50" \
  --property="MemoryMax=2G" \
  --property="IOWeight=50" \
  --property="Nice=15" \
  --collect \
  -- pg_dump -Fc -d production -f /backup/prod_$(date +%Y%m%d).dump

# Monitor the transient scope
systemd-cgls /system.slice/databases.slice/

# Run a compilation job with CPU limits to avoid impacting production
systemd-run \
  --unit="make-build" \
  --scope \
  --property="CPUQuota=200%" \
  --property="Nice=10" \
  --collect \
  -- make -j$(nproc) all

# Check resource usage of the transient scope
systemctl status make-build.scope
```

### Running Containers with Explicit cgroup Placement

For containers not managed by Kubernetes:

```bash
# Run a container in a specific cgroup slice with resource limits
# (Docker with systemd cgroupdriver)
docker run \
  --cgroup-parent /databases.slice \
  --cpus=2 \
  --memory=4g \
  --memory-swap=4g \
  --blkio-weight=200 \
  postgres:16.3

# Or with podman (supports cgroupv2 natively)
podman run \
  --cgroups=enabled \
  --memory=4g \
  --memory-swap=4g \
  --cpu-shares=150 \
  --cpus=2 \
  --blkio-weight=200 \
  postgres:16.3
```

## Pressure-Aware Allocation with Memory Low

`memory.low` enables soft memory protection — the kernel reclaims memory from cgroups without a `memory.low` setting first, protecting services that have set a low watermark:

```bash
# Protect PostgreSQL's shared_buffers from reclaim
# Set memory.low to match shared_buffers
SHARED_BUFFERS_BYTES=$((512 * 1024 * 1024))  # 512MB

echo "${SHARED_BUFFERS_BYTES}" > \
  /sys/fs/cgroup/system.slice/databases.slice/postgresql.service/memory.low

# This tells the kernel: prefer reclaiming memory from other cgroups
# before taking it from PostgreSQL below this watermark
```

## Delegating Cgroup Management

For unprivileged managers like a container runtime or a custom scheduler, the parent cgroup must be delegated. Delegation allows the manager to create and manage sub-cgroups without root privileges:

```ini
# /etc/systemd/system/myruntime.service
[Service]
User=containerruntime
Group=containerruntime
# Delegate cgroup management for subtrees of this service's cgroup
Delegate=yes
# Enable specific controllers in delegated subtree
DelegateControllers=cpu memory io pids
```

```bash
# Verify delegation
cat /sys/fs/cgroup/system.slice/myruntime.service/cgroup.subtree_control
# cpu memory io pids

# After delegation, the myruntime user can create sub-cgroups
# without root privileges
```

## Resource Pressure Monitoring Dashboard

```bash
#!/bin/bash
# psi_monitor.sh — Display PSI pressure metrics for all services in a slice

SLICE="${1:-databases.slice}"
CGROUP_ROOT="/sys/fs/cgroup/system.slice/${SLICE}"

printf "%-50s %8s %8s %8s %8s %8s %8s\n" \
  "UNIT" "CPU%" "CPU_10s" "MEM%" "MEM_10s" "IO%" "IO_10s"

find "${CGROUP_ROOT}" -name "cpu.pressure" | while read cpu_file; do
  unit_path=$(dirname "${cpu_file}")
  unit_name=$(basename "${unit_path}")

  cpu_avg10=$(awk '/^some/{print $2}' "${cpu_file}" | cut -d= -f2)
  cpu_avg60=$(awk '/^some/{print $3}' "${cpu_file}" | cut -d= -f2)

  mem_file="${unit_path}/memory.pressure"
  mem_avg10=0
  mem_avg60=0
  if [ -f "${mem_file}" ]; then
    mem_avg10=$(awk '/^some/{print $2}' "${mem_file}" | cut -d= -f2)
    mem_avg60=$(awk '/^some/{print $3}' "${mem_file}" | cut -d= -f2)
  fi

  io_file="${unit_path}/io.pressure"
  io_avg10=0
  io_avg60=0
  if [ -f "${io_file}" ]; then
    io_avg10=$(awk '/^some/{print $2}' "${io_file}" | cut -d= -f2)
    io_avg60=$(awk '/^some/{print $3}' "${io_file}" | cut -d= -f2)
  fi

  printf "%-50s %8s %8s %8s %8s %8s %8s\n" \
    "${unit_name}" "${cpu_avg60}" "${cpu_avg10}" \
    "${mem_avg60}" "${mem_avg10}" \
    "${io_avg60}" "${io_avg10}"
done
```

## Prometheus Integration

The `node_exporter` exposes cgroupv2 metrics when the `--collector.cgroups` flag is enabled. For more granular per-service metrics, use `systemd-exporter`:

```bash
# Enable cgroup metrics in node_exporter
node_exporter \
  --collector.cgroups \
  --collector.systemd \
  --collector.pressure

# Key metrics exposed:
# node_cgroup_cpu_usage_ns_total
# node_cgroup_memory_usage_bytes
# node_cgroup_memory_limits_bytes
# node_pressure_cpu_waiting_seconds_total
# node_pressure_memory_waiting_seconds_total
# node_pressure_io_waiting_seconds_total
```

Prometheus alerting rules for PSI:

```yaml
groups:
  - name: psi.alerts
    rules:
      - alert: HighMemoryPressure
        expr: |
          rate(node_pressure_memory_waiting_seconds_total[5m]) > 0.10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory pressure on {{ $labels.instance }}"
          description: |
            Memory pressure is {{ $value | humanizePercentage }} of time stalled.
            This indicates memory contention. Check cgroup memory.high settings
            and consider increasing MemoryMax or adding more RAM.

      - alert: HighIOPressure
        expr: |
          rate(node_pressure_io_waiting_seconds_total[5m]) > 0.20
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High I/O pressure on {{ $labels.instance }}"
          description: "I/O pressure at {{ $value | humanizePercentage }}. Check IOWeight and disk utilization."
```

## cgroup v2 Namespace Isolation for Containers

Cgroup namespaces (introduced in Linux 4.6) allow containers to have their own view of the cgroup hierarchy, preventing containers from seeing the host's cgroup paths and enabling unprivileged cgroup management within a container:

```bash
# Verify cgroup namespace support
ls -la /proc/self/ns/cgroup
# lrwxrwxrwx ... /proc/self/ns/cgroup -> 'cgroup:[4026531835]'

# Check if a container is in its own cgroup namespace
docker run --rm alpine cat /proc/self/cgroup
# 0::/   <-- relative path within the container's cgroup namespace

# Without cgroup namespace (--cgroupns=host):
# 0::/docker/<container-id>
```

### Rootless Container Cgroup Delegation

Rootless containers (run by non-root users) require systemd user-instance cgroup delegation to set resource limits. This is enabled per-user:

```bash
# Enable lingering for the container user so their systemd instance persists
loginctl enable-linger containeruser

# Configure systemd user instance to delegate cgroups
mkdir -p /etc/systemd/user/user@.service.d/
cat > /etc/systemd/user/user@.service.d/delegate.conf << 'EOF'
[Service]
Delegate=yes
EOF

systemctl daemon-reload

# Verify as the container user
sudo -u containeruser systemctl --user show | grep Delegate
# Delegate=yes

# Now rootless podman containers can set resource limits
sudo -u containeruser podman run \
  --memory=2g \
  --cpus=1 \
  redis:7
```

## Freezing and Thawing Cgroups

The `cgroup.freeze` interface allows pausing all processes in a cgroup without sending signals — useful for checkpoint/restore and for pausing test workloads during benchmarks:

```bash
# Freeze all processes in a service's cgroup
echo 1 > /sys/fs/cgroup/system.slice/myapp.service/cgroup.freeze

# Verify all processes are frozen
cat /sys/fs/cgroup/system.slice/myapp.service/cgroup.events
# populated 1
# frozen 1

# Thaw the cgroup
echo 0 > /sys/fs/cgroup/system.slice/myapp.service/cgroup.freeze

# Alternatively, use systemctl to suspend/resume a service
systemctl freeze myapp.service
systemctl thaw myapp.service
```

This capability is used by CRIU (Checkpoint/Restore in Userspace) for container live migration: freeze the cgroup, snapshot process memory, migrate the snapshot, restore on the target node, and thaw.

## Task Count and PID Limits

The `pids` controller limits the number of processes and threads in a cgroup, preventing fork bombs:

```bash
# Set a task limit via systemd unit
# /etc/systemd/system/api-server.service.d/limits.conf
[Service]
TasksMax=512

# Direct cgroup manipulation
echo 512 > /sys/fs/cgroup/system.slice/api-server.service/pids.max

# Check current task count
cat /sys/fs/cgroup/system.slice/api-server.service/pids.current
# 48

# View task limit
cat /sys/fs/cgroup/system.slice/api-server.service/pids.max
# 512

# A process that exceeds the limit receives EAGAIN on fork()/clone()
# The kernel logs: kernel: cgroup: fork rejected by pids controller
```

The Kubernetes default `TasksMax` for system pods is typically 4096, set via the kubelet's `--system-reserved` configuration. Applications that spin up many goroutines or threads should monitor `pids.current` against `pids.max`.

## CPU Burst Feature

Linux 5.14+ supports CPU burst for cgroups — allowing a cgroup to temporarily exceed its quota by consuming tokens accumulated during idle periods:

```bash
# Enable CPU burst (linux 5.14+)
# Set burst to allow up to 200ms of extra CPU time
echo "200000" > /sys/fs/cgroup/system.slice/api-server.service/cpu.burst_us

# View burst configuration
cat /sys/fs/cgroup/system.slice/api-server.service/cpu.max
# 100000 100000  (1 CPU quota)
cat /sys/fs/cgroup/system.slice/api-server.service/cpu.burst_us
# 200000

# Via systemd unit (requires systemd 253+)
# CPUBurstMS=200
```

CPU burst is valuable for bursty API services that have tight cpu.max quotas for steady state but occasionally need to handle traffic spikes without increasing the sustained quota.

## Summary

The unified cgroup v2 hierarchy with systemd's slice management model provides precise, composable resource governance for production Linux systems. The key operational patterns are: use `memory.high` as a soft throttle point below `memory.max` to prevent OOM kills, set `memory.low` and `memory.min` for latency-sensitive services to protect their working sets from global memory pressure, monitor PSI metrics for early detection of resource contention before it manifests as latency spikes, and use `systemd-run` with explicit resource properties for operational tasks like backups and batch jobs that should not compete with production workloads. For Kubernetes deployments, ensuring the `cgroupDriver: systemd` setting matches the container runtime's cgroupv2 mode is essential for correct QoS class enforcement.
