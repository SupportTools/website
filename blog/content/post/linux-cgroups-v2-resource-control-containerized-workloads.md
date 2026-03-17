---
title: "Linux cgroups v2: Resource Control for Containerized Workloads"
date: 2030-05-16T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "Kubernetes", "Containers", "Resource Management", "PSI", "Performance"]
categories:
- Linux
- Kubernetes
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into cgroups v2 hierarchy, memory and CPU controllers, pressure stall information (PSI), and how Kubernetes uses cgroups for pod resource isolation and enforcement."
more_link: "yes"
url: "/linux-cgroups-v2-resource-control-containerized-workloads/"
---

Control groups version 2 (cgroups v2) represents a fundamental redesign of the Linux resource control subsystem. Unlike the fragmented hierarchy of cgroups v1, where each controller maintained its own independent tree, cgroups v2 presents a unified hierarchy where all controllers share a single mount point. This architectural shift simplifies reasoning about resource isolation, eliminates inconsistencies between controllers, and introduces new capabilities including Pressure Stall Information (PSI) that enable more sophisticated scheduling and throttling decisions in container runtimes like containerd and CRI-O.

<!--more-->

## cgroups v2 Architecture Fundamentals

### Unified Hierarchy vs. cgroups v1

In cgroups v1, controllers such as `memory`, `cpu`, and `blkio` each maintained independent hierarchies. A process could belong to different groups in different controller hierarchies, creating complex and sometimes contradictory resource accounting.

```
cgroups v1 (fragmented):
/sys/fs/cgroup/memory/web/app/
/sys/fs/cgroup/cpu/batch/app/      ← same process, different hierarchies
/sys/fs/cgroup/blkio/default/app/

cgroups v2 (unified):
/sys/fs/cgroup/
├── web/
│   └── app/                       ← all controllers under one path
├── batch/
└── system.slice/
```

### Verifying cgroups v2 Is Active

```bash
# Check the cgroup filesystem type
stat -fc %T /sys/fs/cgroup
# cgroup2fs  ← v2 is active
# tmpfs      ← v1 is active

# Kubernetes nodes: verify via kubelet
kubectl get node worker-01 -o json \
  | jq '.status.conditions[] | select(.type=="Ready") | .message'

# On a node directly
cat /proc/mounts | grep cgroup
# cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime 0 0
```

### The cgroup Interface Files

Every cgroup directory contains a standard set of interface files:

```bash
ls /sys/fs/cgroup/
# cgroup.controllers     - available controllers at this level
# cgroup.subtree_control - controllers enabled for children
# cgroup.procs           - PIDs of processes in this cgroup
# cgroup.threads         - TIDs of threads in this cgroup
# cgroup.stat            - hierarchy statistics
# cgroup.max.depth       - maximum hierarchy depth
# cgroup.max.descendants - maximum number of descendants

# When controllers are enabled, additional files appear:
# cpu.max                - CPU bandwidth limit
# cpu.weight             - relative CPU scheduling weight
# memory.max             - hard memory limit
# memory.high            - memory soft limit (triggers throttling)
# memory.swap.max        - swap limit
# io.max                 - per-device I/O rate limits
# io.weight              - relative I/O scheduling weight
```

### Enabling Controllers

Controllers must be explicitly enabled at each level of the hierarchy before they can be used in child cgroups.

```bash
# Check what controllers are available
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# Enable CPU and memory controllers for children
echo "+cpu +memory +io +pids" > /sys/fs/cgroup/cgroup.subtree_control

# Verify children can now use these controllers
cat /sys/fs/cgroup/web/cgroup.controllers
# cpu memory io pids
```

## Memory Controller Deep Dive

### Memory Limit Configuration

The memory controller provides several limit knobs with distinct behaviors:

```
memory.max      - Hard limit: triggers OOM kill when exceeded
memory.high     - Soft limit: throttles processes when exceeded
memory.min      - Minimum guarantee: kernel will not reclaim below this
memory.low      - Soft minimum: reclamation is attempted here last
memory.swap.max - Limits swap usage (0 = no swap allowed)
memory.oom.group - OOM kills entire cgroup rather than individual processes
```

```bash
# Create a cgroup for a web service
mkdir -p /sys/fs/cgroup/web/app

# Set a hard memory limit of 512 MiB
echo $((512 * 1024 * 1024)) > /sys/fs/cgroup/web/app/memory.max

# Set a soft memory limit of 400 MiB
# Processes exceeding this will be throttled but not killed
echo $((400 * 1024 * 1024)) > /sys/fs/cgroup/web/app/memory.high

# Guarantee at least 128 MiB for this cgroup
echo $((128 * 1024 * 1024)) > /sys/fs/cgroup/web/app/memory.min

# Disable swap for container isolation
echo 0 > /sys/fs/cgroup/web/app/memory.swap.max

# Enable group OOM kill (kill all processes when OOM, not just the offending one)
echo 1 > /sys/fs/cgroup/web/app/memory.oom.group
```

### Reading Memory Statistics

```bash
# Current memory usage
cat /sys/fs/cgroup/web/app/memory.current
# 167772160  (160 MiB)

# Detailed memory statistics
cat /sys/fs/cgroup/web/app/memory.stat
# anon 134217728          # anonymous memory (heap, stack)
# file 33554432           # page cache
# kernel_stack 1048576    # kernel stacks for tasks
# slab 8388608            # kernel slab allocator
# sock 0                  # socket buffers
# shmem 0                 # shared memory
# zswap 0                 # compressed swap cache
# file_mapped 16777216    # memory-mapped files
# file_dirty 0            # dirty page cache
# file_writeback 0        # pages being written back
# inactive_anon 67108864  # recently unused anonymous pages
# active_anon 67108864    # recently used anonymous pages
# inactive_file 16777216  # recently unused file cache
# active_file 16777216    # recently used file cache
# pgfault 40960           # total page faults
# pgmajfault 128          # major page faults (disk I/O required)
# workingset_refault_anon 0
# workingset_refault_file 0

# OOM kill events (non-zero indicates container has been OOM killed)
cat /sys/fs/cgroup/web/app/memory.events
# low 0
# high 142         # number of times high limit was exceeded
# max 3            # number of times max limit was exceeded (near-OOM)
# oom 1            # number of OOM kill events
# oom_kill 1       # number of processes killed by OOM
# oom_group_kill 0 # number of group OOM kills
```

### Memory Pressure Response

```bash
# Monitoring memory.events for OOM events
watch -n 1 'cat /sys/fs/cgroup/web/app/memory.events'

# inotify-based monitoring (more efficient for production)
# Use inotifywait or fanotify to trigger alerts
inotifywait -m /sys/fs/cgroup/web/app/memory.events 2>/dev/null \
  | while read -r dir event file; do
      oom_kills=$(grep oom_kill /sys/fs/cgroup/web/app/memory.events | awk '{print $2}')
      if [ "${oom_kills}" -gt 0 ]; then
        echo "ALERT: OOM kill detected in web/app cgroup"
      fi
    done
```

## CPU Controller

### CPU Bandwidth Control (Quota/Period)

```bash
# cpu.max format: "quota period"
# quota   = CPU microseconds allowed per period (or "max" for unlimited)
# period  = period length in microseconds (default 100000 = 100ms)

# Limit to 50% of one CPU: 50ms per 100ms period
echo "50000 100000" > /sys/fs/cgroup/web/app/cpu.max

# Limit to 200% CPU (2 full cores): 200ms per 100ms period
echo "200000 100000" > /sys/fs/cgroup/web/app/cpu.max

# Unlimited CPU (default)
echo "max 100000" > /sys/fs/cgroup/web/app/cpu.max
```

### CPU Weight (Shares)

```bash
# cpu.weight range: 1-10000 (default 100)
# Higher weight = more CPU time relative to siblings

# Assign 4x more CPU time than default
echo 400 > /sys/fs/cgroup/web/app/cpu.weight

# Background batch job gets minimal CPU
echo 10 > /sys/fs/cgroup/batch/job/cpu.weight
```

### CPU Statistics

```bash
cat /sys/fs/cgroup/web/app/cpu.stat
# usage_usec 458291234       # total CPU time consumed (microseconds)
# user_usec 312456789        # user-space CPU time
# system_usec 145834445      # kernel-space CPU time
# nr_periods 45829           # number of enforcement periods
# nr_throttled 1823          # periods where quota was exhausted
# throttled_usec 91150000    # total time spent throttled (microseconds)
# nr_bursts 0                # number of burst periods
# burst_usec 0               # microseconds of burst usage

# High nr_throttled/nr_periods ratio indicates CPU starvation
# throttled_usec/usage_usec > 0.1 = significant CPU throttling
```

### Detecting CPU Throttling in Kubernetes

```bash
# Check CPU throttling across all containers in a namespace
kubectl top pods -n production --containers

# More detailed: check cgroup stats for a specific pod
CONTAINER_ID=$(kubectl get pod api-server-6b8d94f5c-xk7p2 -n production \
  -o jsonpath='{.status.containerStatuses[0].containerID}' \
  | sed 's|containerd://||')

# Find the cgroup path
CGROUP_PATH=$(find /sys/fs/cgroup/kubepods.slice -name "*.scope" \
  | xargs grep -l "${CONTAINER_ID:0:12}" 2>/dev/null | head -1 | xargs dirname)

cat "${CGROUP_PATH}/cpu.stat" \
  | awk '/nr_periods|nr_throttled|throttled_usec/ {print}'
```

## Pressure Stall Information (PSI)

PSI is one of the most valuable additions in cgroups v2. It measures the fraction of time tasks are stalled waiting for a resource, providing a direct signal for resource pressure.

### PSI Metrics Structure

Each resource (cpu, memory, io) exposes a PSI file with three stall metrics:

- **some**: At least one task is stalled
- **full**: All runnable tasks are stalled (only memory and io)
- **avg10/avg60/avg300**: Exponentially weighted moving average over 10s, 60s, 300s
- **total**: Cumulative stall time in microseconds

```bash
# Read CPU pressure
cat /sys/fs/cgroup/web/app/cpu.pressure
# some avg10=12.45 avg60=8.23 avg300=4.11 total=2341567

# Read memory pressure
cat /sys/fs/cgroup/web/app/memory.pressure
# some avg10=3.21 avg60=1.08 avg300=0.52 total=871234
# full avg10=0.82 avg60=0.31 avg300=0.14 total=213456

# Read I/O pressure
cat /sys/fs/cgroup/web/app/io.pressure
# some avg10=5.67 avg60=2.34 avg300=1.12 total=1234567
# full avg10=1.23 avg60=0.67 avg300=0.31 total=345678
```

### Interpreting PSI Values

| PSI `some` avg10 | Interpretation |
|-----------------|----------------|
| 0-5% | Normal operation |
| 5-15% | Moderate pressure, monitor closely |
| 15-30% | Significant pressure, consider scaling |
| 30%+ | Severe resource starvation |

### PSI-Based Alerting with Prometheus

```yaml
# prometheus-psi-rules.yaml
groups:
  - name: psi_alerts
    interval: 30s
    rules:
      - alert: HighCPUPressure
        expr: |
          node_pressure_cpu_waiting_seconds_total > 0
          and
          rate(node_pressure_cpu_waiting_seconds_total[5m]) * 100 > 15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU pressure on {{ $labels.instance }}"
          description: "CPU pressure (some) is {{ $value | humanizePercentage }} over the last 5 minutes"

      - alert: HighMemoryPressure
        expr: |
          rate(node_pressure_memory_stalled_seconds_total[5m]) * 100 > 5
        for: 3m
        labels:
          severity: critical
        annotations:
          summary: "Memory full stall on {{ $labels.instance }}"
          description: "All tasks are stalled on memory for {{ $value | humanizePercentage }} of time"
```

### Reading PSI from Go

```go
// internal/psi/monitor.go
package psi

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Metrics holds parsed PSI values for a resource.
type Metrics struct {
	SomeAvg10  float64
	SomeAvg60  float64
	SomeAvg300 float64
	SomeTotal  int64
	FullAvg10  float64
	FullAvg60  float64
	FullAvg300 float64
	FullTotal  int64
}

// Read parses a PSI file at the given path.
func Read(path string) (Metrics, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Metrics{}, fmt.Errorf("reading PSI file %s: %w", path, err)
	}

	var m Metrics
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		isFullLine := fields[0] == "full"
		isSomeLine := fields[0] == "some"

		for _, field := range fields[1:] {
			kv := strings.SplitN(field, "=", 2)
			if len(kv) != 2 {
				continue
			}
			val, _ := strconv.ParseFloat(kv[1], 64)
			switch {
			case isSomeLine && kv[0] == "avg10":
				m.SomeAvg10 = val
			case isSomeLine && kv[0] == "avg60":
				m.SomeAvg60 = val
			case isSomeLine && kv[0] == "avg300":
				m.SomeAvg300 = val
			case isSomeLine && kv[0] == "total":
				m.SomeTotal = int64(val)
			case isFullLine && kv[0] == "avg10":
				m.FullAvg10 = val
			case isFullLine && kv[0] == "avg60":
				m.FullAvg60 = val
			case isFullLine && kv[0] == "avg300":
				m.FullAvg300 = val
			case isFullLine && kv[0] == "total":
				m.FullTotal = int64(val)
			}
		}
	}
	return m, nil
}

// PodCgroupPath returns the cgroup path for a container given its ID.
func PodCgroupPath(containerID string) (string, error) {
	// In cgroups v2, kubelet places pod cgroups under kubepods.slice
	// Path: /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/
	//       kubepods-burstable-pod<podUID>.slice/cri-containerd-<containerID>.scope/
	base := "/sys/fs/cgroup/kubepods.slice"
	// Walk and match the container ID prefix
	var found string
	err := filepath.Walk(base, func(path string, info fs.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() && strings.Contains(path, containerID[:12]) {
			found = path
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if found == "" {
		return "", fmt.Errorf("cgroup not found for container %s", containerID[:12])
	}
	return found, nil
}
```

## How Kubernetes Uses cgroups v2

### Kubernetes QoS Classes and cgroup Hierarchy

Kubernetes assigns every pod to one of three QoS classes based on its resource requests and limits. This class determines the cgroup hierarchy placement.

```
/sys/fs/cgroup/kubepods.slice/
├── kubepods-guaranteed.slice/           # Guaranteed QoS: requests == limits
│   └── kubepods-guaranteed-pod<uid>.slice/
│       └── cri-containerd-<id>.scope/
├── kubepods-burstable.slice/            # Burstable QoS: requests < limits
│   └── kubepods-burstable-pod<uid>.slice/
│       └── cri-containerd-<id>.scope/
└── kubepods-besteffort.slice/           # BestEffort QoS: no requests or limits
    └── kubepods-besteffort-pod<uid>.slice/
        └── cri-containerd-<id>.scope/
```

### QoS Class and OOM Behavior

```bash
# Show QoS class for all pods in a namespace
kubectl get pods -n production \
  -o custom-columns=\
'NAME:.metadata.name,QOS:.status.qosClass,CPU_REQ:.spec.containers[0].resources.requests.cpu,MEM_REQ:.spec.containers[0].resources.requests.memory'
```

| QoS Class | OOM Score Adjustment | Eviction Priority |
|-----------|---------------------|-------------------|
| Guaranteed | -997 (last to be killed) | Last |
| Burstable | Proportional to limit usage | Middle |
| BestEffort | 1000 (first to be killed) | First |

### Node Allocatable and cgroup Configuration

Kubernetes reserves resources for system daemons and kubelet itself. The `--system-reserved` and `--kube-reserved` kubelet flags configure cgroups to enforce these reservations.

```bash
# View node allocatable resources
kubectl get node worker-01 -o json | jq '
{
  capacity: .status.capacity,
  allocatable: .status.allocatable,
  reserved: {
    cpu: (.status.capacity.cpu | tonumber) - (.status.allocatable.cpu | tonumber),
    memory: (.status.capacity.memory | gsub("[^0-9]"; "") | tonumber) -
            (.status.allocatable.memory | gsub("[^0-9]"; "") | tonumber)
  }
}'

# Kubelet cgroup driver configuration
cat /var/lib/kubelet/config.yaml | grep cgroupDriver
# cgroupDriver: systemd   ← recommended for systems with systemd
```

### kubelet cgroup Configuration

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
cgroupsPerQOS: true
enforceNodeAllocatable:
  - pods
  - system-reserved
  - kube-reserved
systemReserved:
  cpu: "500m"
  memory: "1Gi"
kubeReserved:
  cpu: "500m"
  memory: "1Gi"
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
evictionPressureTransitionPeriod: 300s
```

### Container Resource Mapping to cgroup Files

When Kubernetes creates a container with `resources.limits`, it translates these into cgroup parameters:

```bash
# For a container with:
#   resources:
#     requests: {cpu: "250m", memory: "256Mi"}
#     limits:   {cpu: "500m", memory: "512Mi"}

# CPU:
# cpu.max = "50000 100000"     (500m = 50ms per 100ms)
# cpu.weight = 25               (250 * 1024 / (requests_scale))

# Memory:
# memory.max = 536870912        (512Mi in bytes)
# memory.high = "max"           (kubelet sets this based on QoS class)

# Verify actual cgroup settings for a container
CONTAINER_ID="abc123def456..."
CGROUP_SCOPE=$(systemctl show containerd --value -p SubState 2>/dev/null \
  && find /sys/fs/cgroup -name "*${CONTAINER_ID:0:12}*" -type d | head -1)

echo "CPU limit:"
cat "${CGROUP_SCOPE}/cpu.max"

echo "Memory limit:"
cat "${CGROUP_SCOPE}/memory.max"

echo "OOM events:"
cat "${CGROUP_SCOPE}/memory.events"
```

## I/O Controller

### Configuring I/O Bandwidth Limits

```bash
# Find the major:minor device numbers
ls -la /dev/sda
# brw-rw---- 1 root disk 8, 0 Jan 1 00:00 /dev/sda

# Set I/O limits for device 8:0 (sda)
# Format: "MAJ:MIN rbps=VALUE wbps=VALUE riops=VALUE wiops=VALUE"
echo "8:0 rbps=104857600 wbps=52428800 riops=1000 wiops=500" \
  > /sys/fs/cgroup/web/app/io.max

# Read current I/O statistics
cat /sys/fs/cgroup/web/app/io.stat
# 8:0 rbytes=1073741824 wbytes=536870912 rios=26214 wios=13107
#     dbytes=0 dios=0
```

## PID Controller

```bash
# Limit a cgroup to at most 100 processes/threads
echo 100 > /sys/fs/cgroup/web/app/pids.max

# Check current PID count
cat /sys/fs/cgroup/web/app/pids.current
# 24

# View the limit
cat /sys/fs/cgroup/web/app/pids.max
# 100
```

Kubernetes sets `pids.max` based on the `--pod-max-pids` kubelet flag (default 0 = unlimited), though operators can configure limits via LimitRange objects.

## cgroups v2 Monitoring Script

```bash
#!/bin/bash
# scripts/cgroup-monitor.sh
# Monitor resource usage and pressure for all Kubernetes pod cgroups.

KUBEPODS_CGROUP="/sys/fs/cgroup/kubepods.slice"
INTERVAL="${1:-5}"

print_header() {
  printf "%-50s %8s %8s %8s %8s %8s\n" \
    "CGROUP" "MEM_MB" "MEM_MAX" "CPU_THRTL" "PSI_CPU" "PSI_MEM"
  printf '%.0s-' {1..100}
  echo
}

monitor_cgroup() {
  local cgroup_path="$1"
  local name
  name=$(basename "${cgroup_path}")

  local mem_current mem_max cpu_throttled psi_cpu psi_mem
  mem_current=$(cat "${cgroup_path}/memory.current" 2>/dev/null || echo 0)
  mem_max=$(cat "${cgroup_path}/memory.max" 2>/dev/null || echo "max")
  cpu_throttled=$(awk '/nr_throttled/{print $2}' "${cgroup_path}/cpu.stat" 2>/dev/null || echo 0)
  psi_cpu=$(awk '/some/{gsub(/avg10=/,""); print $2}' "${cgroup_path}/cpu.pressure" 2>/dev/null || echo 0)
  psi_mem=$(awk '/some/{gsub(/avg10=/,""); print $2}' "${cgroup_path}/memory.pressure" 2>/dev/null || echo 0)

  local mem_mb
  mem_mb=$(( mem_current / 1024 / 1024 ))

  printf "%-50s %8d %8s %8s %8s %8s\n" \
    "${name:0:50}" "${mem_mb}" "${mem_max}" "${cpu_throttled}" \
    "${psi_cpu}" "${psi_mem}"
}

while true; do
  clear
  echo "cgroups v2 Resource Monitor — $(date)"
  echo ""
  print_header

  # Find all pod cgroups
  find "${KUBEPODS_CGROUP}" -maxdepth 3 -name "cri-containerd-*.scope" \
    | while read -r scope; do
        monitor_cgroup "${scope}"
      done

  sleep "${INTERVAL}"
done
```

## Migrating from cgroups v1 to v2

```bash
# Check current cgroup version on a node
cat /proc/filesystems | grep cgroup
# nodev   cgroup
# nodev   cgroup2

# Check if cgroups v2 is mounted
mount | grep cgroup2

# Enable cgroups v2 on a node (requires reboot on most distributions)
# For systemd-based systems:
echo 'GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"' \
  >> /etc/default/grub
grub2-mkconfig -o /boot/grub2/grub.cfg

# For Ubuntu with cgroup2 support in kernel:
sed -i 's/GRUB_CMDLINE_LINUX=""/GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"/' \
  /etc/default/grub
update-grub

# Update containerd to use systemd cgroup driver
cat /etc/containerd/config.toml \
  | grep SystemdCgroup
# SystemdCgroup = true   ← required for cgroups v2

# Verify kubelet configuration
grep cgroupDriver /var/lib/kubelet/config.yaml
# cgroupDriver: systemd
```

The unified hierarchy of cgroups v2, combined with PSI and the improved memory controller, provides the foundation for sophisticated resource management in modern container orchestration. Teams running Kubernetes on cgroups v2 gain more accurate resource accounting, earlier signals of resource pressure, and more predictable OOM behavior—all critical properties for maintaining SLA compliance in production environments.
