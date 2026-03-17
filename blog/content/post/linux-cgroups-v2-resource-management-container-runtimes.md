---
title: "Linux Cgroups v2: Resource Management for Container Runtimes"
date: 2028-12-22T00:00:00-05:00
draft: false
tags: ["Linux", "Cgroups", "Containers", "Kubernetes", "Resource Management", "eBPF"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth technical guide to Linux cgroups v2 covering the unified hierarchy, resource controllers, containerd integration, Kubernetes QoS mapping, and production tuning for container workloads."
more_link: "yes"
url: "/linux-cgroups-v2-resource-management-container-runtimes/"
---

Linux control groups version 2 (cgroups v2) represents a fundamental redesign of how the kernel enforces resource limits on process groups. While cgroups v1 provided multiple independent hierarchies — one per resource controller — cgroups v2 introduces a unified hierarchy where all controllers share a single tree. This architectural change resolves long-standing inconsistencies in v1, simplifies container runtime implementation, and enables new coordination mechanisms like pressure stall information (PSI) and the eBPF device controller. Production Kubernetes clusters running kernel 5.8+ should be operating on cgroups v2 exclusively.

<!--more-->

## Architecture Differences: v1 vs v2

In cgroups v1, each controller maintained its own independent hierarchy mounted at `/sys/fs/cgroup/<controller>/`. A container runtime had to manage membership across multiple hierarchies simultaneously, creating synchronization challenges when a process needed different limits from different controllers.

```bash
# cgroups v1 layout
ls /sys/fs/cgroup/
# blkio  cpu  cpuacct  cpuset  devices  freezer  hugetlb
# memory  net_cls  net_prio  perf_event  pids  rdma  unified

# cgroups v2 unified hierarchy
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)

ls /sys/fs/cgroup/
# cgroup.controllers  cgroup.events  cgroup.freeze  cgroup.kill
# cgroup.max.depth  cgroup.max.descendants  cgroup.pressure
# cgroup.procs  cgroup.stat  cgroup.subtree_control  cgroup.threads
# cgroup.type  cpu.pressure  cpuset.cpus.effective  cpuset.mems.effective
# dev-hugepages.mount  dev-mqueue.mount  io.pressure  memory.numa_stat
# memory.pressure  ...
```

### Key v2 Improvements

The `no internal process` rule in v2 means a cgroup can either contain processes OR have child cgroups, but not both. This eliminates the ambiguous behavior of v1 where a cgroup could simultaneously contain processes and children with different limit sets.

```bash
# Check if system is using cgroups v2
stat -fc %T /sys/fs/cgroup/
# cgroup2fs  <-- v2
# tmpfs      <-- v1

# Check kernel version (v2 fully supported 5.4+, production-ready 5.8+)
uname -r

# Verify unified hierarchy enabled
cat /proc/cmdline | grep -o 'systemd.unified_cgroup_hierarchy=[01]'
# For Ubuntu 22.04+ and RHEL 9+, v2 is default
```

## Controllers and Interfaces

### CPU Controller

```bash
# CPU controller files in a cgroup
ls /sys/fs/cgroup/system.slice/containerd.service/

# cpu.weight        -- proportional weight (1-10000, default 100)
# cpu.max           -- bandwidth limit: "quota period" in microseconds
# cpu.stat          -- accounting data
# cpu.pressure      -- CPU pressure stall information

# Set CPU limit: 200ms quota per 1000ms period = 20% of one CPU
echo "200000 1000000" > /sys/fs/cgroup/mycontainer/cpu.max

# Set CPU weight (relative priority among siblings)
echo "200" > /sys/fs/cgroup/mycontainer/cpu.weight

# Read CPU stats
cat /sys/fs/cgroup/mycontainer/cpu.stat
# usage_usec 45231847
# user_usec 38291234
# system_usec 6940613
# nr_periods 4523
# nr_throttled 127
# throttled_usec 12847392
# nr_bursts 0
# burst_usec 0
```

### Memory Controller

```bash
# Memory controller files
# memory.max          -- hard limit, triggers OOM if exceeded
# memory.high         -- soft limit, triggers reclaim and throttling
# memory.low          -- guaranteed minimum, protected from reclaim
# memory.min          -- hard guarantee, never reclaimed
# memory.swap.max     -- swap limit
# memory.current      -- current usage
# memory.stat         -- detailed breakdown
# memory.events       -- event counters (OOM, etc.)
# memory.pressure     -- memory pressure stall information

# Set memory limits
echo "536870912" > /sys/fs/cgroup/mycontainer/memory.max    # 512MB hard
echo "402653184" > /sys/fs/cgroup/mycontainer/memory.high   # 384MB soft
echo "268435456" > /sys/fs/cgroup/mycontainer/memory.low    # 256MB guaranteed

# Disable swap for container
echo "0" > /sys/fs/cgroup/mycontainer/memory.swap.max

# Read memory stats
cat /sys/fs/cgroup/mycontainer/memory.stat
# anon 234881024
# file 127926272
# kernel 18874368
# kernel_stack 2097152
# pagetables 1048576
# sock 65536
# vmalloc 0
# shmem 8388608
# zswap 0
# zswapped 0
# file_mapped 41943040
# file_dirty 4096
# file_writeback 0
# ...

# Check OOM events
cat /sys/fs/cgroup/mycontainer/memory.events
# low 0
# high 847
# max 0
# oom 0
# oom_kill 0
# oom_group_kill 0
```

### I/O Controller

The v2 I/O controller uses a proportional weight model and supports explicit byte/IOPS limits per device:

```bash
# io.weight           -- proportional weight (1-10000)
# io.max              -- IOPS and BPS limits per device
# io.stat             -- per-device I/O statistics
# io.pressure         -- I/O pressure stall information

# Identify device major:minor numbers
ls -la /dev/nvme0n1
# brw-rw---- 1 root disk 259, 0 ...

# Set I/O limits for device 259:0 (NVMe)
# rbps=max, wbps=100MB/s, riops=max, wiops=1000
echo "259:0 rbps=max wbps=104857600 riops=max wiops=1000" \
  > /sys/fs/cgroup/mycontainer/io.max

# Set proportional weight
echo "default 200" > /sys/fs/cgroup/mycontainer/io.weight

# Read I/O stats
cat /sys/fs/cgroup/mycontainer/io.stat
# 259:0 rbytes=1073741824 wbytes=2147483648 rios=262144 wios=524288 dbytes=0 dios=0
```

## Pressure Stall Information (PSI)

PSI is one of cgroups v2's most operationally valuable additions. It reports the fraction of time tasks were stalled waiting for CPU, memory, or I/O:

```bash
# PSI files exist for cpu, memory, and io
cat /sys/fs/cgroup/mycontainer/memory.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# "some" = at least one task was stalled
# "full" = all tasks were stalled (true resource starvation)
# avg10/60/300 = exponential moving average over 10s, 60s, 300s windows

cat /sys/fs/cgroup/mycontainer/io.pressure
# some avg10=2.45 avg60=1.83 avg300=0.94 total=18473621
# full avg10=0.12 avg60=0.08 avg300=0.04 total=982341

# A PSI "some" > 20% on memory typically indicates the cgroup needs more memory
# A PSI "full" > 0% on I/O indicates severe I/O bottlenecking
```

### PSI Monitoring with Go

```go
// pkg/psi/monitor.go
package psi

import (
    "bufio"
    "fmt"
    "os"
    "path/filepath"
    "strconv"
    "strings"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// PressureStats holds PSI data for one resource
type PressureStats struct {
    SomeAvg10  float64
    SomeAvg60  float64
    SomeAvg300 float64
    SomeTotal  uint64
    FullAvg10  float64
    FullAvg60  float64
    FullAvg300 float64
    FullTotal  uint64
}

// ReadPressure reads PSI stats from a cgroup v2 pressure file
func ReadPressure(cgroupPath, resource string) (*PressureStats, error) {
    path := filepath.Join(cgroupPath, resource+".pressure")
    f, err := os.Open(path)
    if err != nil {
        return nil, fmt.Errorf("opening %s: %w", path, err)
    }
    defer f.Close()

    stats := &PressureStats{}
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := scanner.Text()
        fields := strings.Fields(line)
        if len(fields) < 5 {
            continue
        }

        lineType := fields[0] // "some" or "full"
        values := make(map[string]float64)

        for _, kv := range fields[1:] {
            parts := strings.SplitN(kv, "=", 2)
            if len(parts) != 2 {
                continue
            }
            key := parts[0]
            val, err := strconv.ParseFloat(parts[1], 64)
            if err != nil {
                continue
            }
            values[key] = val
        }

        switch lineType {
        case "some":
            stats.SomeAvg10 = values["avg10"]
            stats.SomeAvg60 = values["avg60"]
            stats.SomeAvg300 = values["avg300"]
            stats.SomeTotal = uint64(values["total"])
        case "full":
            stats.FullAvg10 = values["avg10"]
            stats.FullAvg60 = values["avg60"]
            stats.FullAvg300 = values["avg300"]
            stats.FullTotal = uint64(values["total"])
        }
    }

    return stats, scanner.Err()
}

// PSICollector is a Prometheus collector for cgroup PSI metrics
type PSICollector struct {
    cgroupPath string
    podID      string

    cpuSomePressure    *prometheus.GaugeVec
    memorySomePressure *prometheus.GaugeVec
    ioSomePressure     *prometheus.GaugeVec
    memoryFullPressure *prometheus.GaugeVec
    ioFullPressure     *prometheus.GaugeVec
}

func NewPSICollector(cgroupPath, podID string) *PSICollector {
    labels := []string{"pod_id", "window"}
    return &PSICollector{
        cgroupPath: cgroupPath,
        podID:      podID,
        cpuSomePressure: prometheus.NewGaugeVec(prometheus.GaugeOpts{
            Name: "cgroup_cpu_pressure_some_ratio",
            Help: "CPU pressure stall ratio (some tasks stalled)",
        }, labels),
        memorySomePressure: prometheus.NewGaugeVec(prometheus.GaugeOpts{
            Name: "cgroup_memory_pressure_some_ratio",
            Help: "Memory pressure stall ratio (some tasks stalled)",
        }, labels),
        ioSomePressure: prometheus.NewGaugeVec(prometheus.GaugeOpts{
            Name: "cgroup_io_pressure_some_ratio",
            Help: "I/O pressure stall ratio (some tasks stalled)",
        }, labels),
    }
}

func (c *PSICollector) Collect(ch chan<- prometheus.Metric) {
    for _, resource := range []string{"cpu", "memory", "io"} {
        stats, err := ReadPressure(c.cgroupPath, resource)
        if err != nil {
            continue
        }

        for window, val := range map[string]float64{
            "10s":  stats.SomeAvg10,
            "60s":  stats.SomeAvg60,
            "300s": stats.SomeAvg300,
        } {
            var gauge *prometheus.GaugeVec
            switch resource {
            case "cpu":
                gauge = c.cpuSomePressure
            case "memory":
                gauge = c.memorySomePressure
            case "io":
                gauge = c.ioSomePressure
            }
            gauge.WithLabelValues(c.podID, window).Set(val / 100.0)
        }
    }
}
```

## Kubernetes and Cgroups v2

Kubernetes maps Pod QoS classes to cgroup settings. On cgroups v2, this mapping changed significantly from v1.

### QoS to cgroup v2 Mapping

```bash
# Kubernetes cgroup hierarchy with cgroups v2
ls /sys/fs/cgroup/kubepods.slice/

# Guaranteed QoS pods
ls /sys/fs/cgroup/kubepods.slice/kubepods-pod<uid>.slice/

# Burstable QoS pods
ls /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice/

# BestEffort QoS pods
ls /sys/fs/cgroup/kubepods.slice/kubepods-besteffort.slice/kubepods-besteffort-pod<uid>.slice/

# Inspect a Guaranteed pod's cgroup settings
cat /sys/fs/cgroup/kubepods.slice/kubepods-pod<uid>.slice/cpu.max
# 100000 100000   <-- 100ms quota / 100ms period = 1 full CPU

cat /sys/fs/cgroup/kubepods.slice/kubepods-pod<uid>.slice/memory.max
# 536870912       <-- 512MB hard limit

cat /sys/fs/cgroup/kubepods.slice/kubepods-pod<uid>.slice/memory.high
# max             <-- No soft limit for Guaranteed pods
```

### containerd Configuration for cgroups v2

```toml
# /etc/containerd/config.toml
version = 3

[plugins."io.containerd.grpc.v1.cri"]
  # Use systemd cgroup driver (required for cgroups v2 + Kubernetes)
  [plugins."io.containerd.grpc.v1.cri".containerd]
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
        runtime_type = "io.containerd.runc.v2"
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
          SystemdCgroup = true    # Critical for cgroups v2

[plugins."io.containerd.runtime.v1.linux"]
  shim_debug = false

[metrics]
  address = "127.0.0.1:1338"
  grpc_histogram = false
```

### Kubelet Configuration

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Use systemd cgroup driver — must match containerd
cgroupDriver: systemd

# cgroup v2 enables memory QoS
memoryManagerPolicy: Static

# Resource reservation for system and kubelet processes
systemReserved:
  cpu: "200m"
  memory: "500Mi"
  ephemeral-storage: "2Gi"

kubeReserved:
  cpu: "200m"
  memory: "500Mi"
  ephemeral-storage: "2Gi"

# Eviction thresholds
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"

evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"

evictionSoftGracePeriod:
  memory.available: "1m30s"
  nodefs.available: "2m"

# Enable memory QoS with cgroups v2
# Sets memory.high for Burstable pods based on requests
featureGates:
  MemoryQoS: true
  NodeSwap: false
```

## Memory QoS with Cgroups v2

The `MemoryQoS` feature gate (stable in 1.28) uses `memory.high` to throttle Burstable pods before triggering OOM:

```bash
# With MemoryQoS enabled, Burstable pod with request=256Mi, limit=512Mi:
# memory.min = 256Mi * 0 (no minimum guaranteed)
# memory.low = 256Mi    (protected from reclaim up to request)
# memory.high = 512Mi * 0.8 = 409.6Mi (throttled before hitting limit)
# memory.max = 512Mi    (hard OOM threshold)

# Check the actual values for a running pod
POD_UID="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
CGPATH="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${POD_UID}.slice"

cat "${CGPATH}/memory.min"   # 0
cat "${CGPATH}/memory.low"   # 268435456  (256Mi)
cat "${CGPATH}/memory.high"  # 429496730  (~409Mi)
cat "${CGPATH}/memory.max"   # 536870912  (512Mi)
```

## Namespace and Device Controller

Cgroups v2 replaces the v1 `devices` controller with an eBPF-based approach. Container runtimes attach eBPF programs to `BPF_CGROUP_DEVICE` hooks:

```c
// device_filter.c — eBPF program for device access control
// Loaded by container runtime (runc, containerd) per container

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

// Allowed device list: {type, major, minor, access_mask}
// type: 'c' = char (2), 'b' = block (1)
struct device_rule {
    __u32 type;
    __u32 major;
    __u32 minor;
    __u32 access;   // bitfield: READ=1, WRITE=2, MKNOD=4
};

// BPF map storing allowed devices
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 64);
    __type(key, __u32);
    __type(value, struct device_rule);
} allowed_devices SEC(".maps");

SEC("cgroup/dev")
int device_filter(struct bpf_cgroup_dev_ctx *ctx) {
    __u32 i;
    // Check if the requested device access matches any allowed rule
    #pragma unroll
    for (i = 0; i < 64; i++) {
        struct device_rule *rule = bpf_map_lookup_elem(&allowed_devices, &i);
        if (!rule)
            break;
        if (rule->type == 0)
            break;  // End of rules
        if (rule->type == ctx->access_type >> 1 &&
            (rule->major == 0xFFFFFFFF || rule->major == ctx->major) &&
            (rule->minor == 0xFFFFFFFF || rule->minor == ctx->minor) &&
            (rule->access & ctx->access_type)) {
            return 1;  // Allow
        }
    }
    return 0;  // Deny
}

char LICENSE[] SEC("license") = "GPL";
```

## Migrating Nodes from cgroups v1 to v2

```bash
#!/bin/bash
# migrate-cgroups-v2.sh
# Migrates a Kubernetes node from cgroups v1 to v2

set -euo pipefail

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# 1. Verify kernel version
KERNEL=$(uname -r | cut -d. -f1,2)
MAJOR=$(echo "${KERNEL}" | cut -d. -f1)
MINOR=$(echo "${KERNEL}" | cut -d. -f2)
if [ "${MAJOR}" -lt 5 ] || ([ "${MAJOR}" -eq 5 ] && [ "${MINOR}" -lt 8 ]); then
  log "ERROR: Kernel ${KERNEL} too old. Minimum 5.8 required for production cgroups v2."
  exit 1
fi
log "Kernel ${KERNEL}: OK"

# 2. Drain node from Kubernetes perspective (run from a management host)
NODE_NAME=$(hostname -s)
log "Drain node: ${NODE_NAME}"
# kubectl drain "${NODE_NAME}" --ignore-daemonsets --delete-emptydir-data

# 3. Configure GRUB for cgroups v2
GRUB_CMDLINE_CURRENT=$(grep GRUB_CMDLINE_LINUX_DEFAULT /etc/default/grub | head -1)
log "Current GRUB cmdline: ${GRUB_CMDLINE_CURRENT}"

# Remove any v1 overrides and add v2 parameters
sed -i 's/systemd\.unified_cgroup_hierarchy=0//g' /etc/default/grub
sed -i 's/cgroup_no_v1=//g' /etc/default/grub

# Add unified hierarchy setting
sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="\(.*\)"/GRUB_CMDLINE_LINUX_DEFAULT="\1 systemd.unified_cgroup_hierarchy=1 cgroup_no_v1=all"/' \
  /etc/default/grub

# 4. Update containerd config
cat > /etc/containerd/config.toml << 'EOF'
version = 3

[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
        runtime_type = "io.containerd.runc.v2"
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
          SystemdCgroup = true
EOF

# 5. Update kubelet config
sed -i 's/cgroupDriver: cgroupfs/cgroupDriver: systemd/' \
  /var/lib/kubelet/config.yaml

# 6. Update GRUB and reboot
update-grub
log "GRUB updated. Rebooting in 10 seconds..."
sleep 10
reboot
```

## Validating cgroup v2 Configuration

```bash
#!/bin/bash
# validate-cgroupsv2.sh

set -euo pipefail

ERRORS=0

check() {
  local desc="$1"
  local cmd="$2"
  local expected="$3"
  local actual
  actual=$(eval "${cmd}" 2>/dev/null || echo "ERROR")
  if echo "${actual}" | grep -q "${expected}"; then
    echo "PASS: ${desc}"
  else
    echo "FAIL: ${desc} (expected '${expected}', got '${actual}')"
    ERRORS=$((ERRORS + 1))
  fi
}

check "cgroups v2 unified hierarchy" \
  "stat -fc %T /sys/fs/cgroup/" "cgroup2fs"

check "systemd cgroup driver (containerd)" \
  "grep -c 'SystemdCgroup = true' /etc/containerd/config.toml" "1"

check "systemd cgroup driver (kubelet)" \
  "grep 'cgroupDriver' /var/lib/kubelet/config.yaml" "systemd"

check "memory controller available" \
  "cat /sys/fs/cgroup/cgroup.controllers" "memory"

check "cpu controller available" \
  "cat /sys/fs/cgroup/cgroup.controllers" "cpu"

check "io controller available" \
  "cat /sys/fs/cgroup/cgroup.controllers" "io"

check "PSI support" \
  "cat /proc/cmdline" "psi=1\|PSI"

check "kubepods cgroup exists" \
  "ls /sys/fs/cgroup/kubepods.slice/" "kubepods"

if [ "${ERRORS}" -eq 0 ]; then
  echo ""
  echo "=== All cgroups v2 checks PASSED ==="
else
  echo ""
  echo "=== ${ERRORS} check(s) FAILED ==="
  exit 1
fi
```

## Prometheus Metrics for Cgroup Resource Usage

```yaml
# prometheus-cgroup-rules.yml
groups:
- name: cgroup-resource
  rules:
  - alert: ContainerMemoryHighPressure
    expr: |
      container_memory_pressure_some_ratio{window="60s"} > 0.3
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Container {{ $labels.pod_id }} experiencing high memory pressure"
      description: "30% of 60s window spent stalled on memory. Consider increasing memory limit."

  - alert: ContainerCPUThrottled
    expr: |
      rate(container_cpu_cfs_throttled_seconds_total[5m]) /
      rate(container_cpu_cfs_periods_total[5m]) > 0.25
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Container {{ $labels.pod }} CPU throttled >25%"
      description: "CPU throttling detected. Increase CPU limit or optimize workload."

  - alert: ContainerOOMKill
    expr: |
      increase(container_oom_events_total[5m]) > 0
    labels:
      severity: critical
    annotations:
      summary: "OOM kill in container {{ $labels.pod }}"
      description: "Container was OOM killed. Memory limit insufficient for workload."
```

Cgroups v2's unified hierarchy, PSI integration, and eBPF device controller provide container runtimes with more precise resource enforcement and better observability than the fragmented v1 controllers. The migration path is well-defined for Linux 5.8+ nodes, and the Kubernetes ecosystem — from containerd through kubelet to the scheduler — is fully adapted to the v2 API. Production clusters should complete v2 migration to take advantage of MemoryQoS, PSI-based eviction, and the simplified systemd-cgroup driver model.
