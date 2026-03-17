---
title: "Linux Control Groups v2: Resource Isolation for Containers and Microservices"
date: 2030-11-29T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "Containers", "Resource Management", "Kubernetes", "systemd", "Performance"]
categories: ["Linux", "Containers"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux cgroup v2: unified hierarchy, memory/CPU/IO controllers, Pressure Stall Information (PSI), cgroup delegation for rootless containers, systemd integration, and Kubernetes cgroup driver configuration."
more_link: "yes"
url: "/linux-control-groups-v2-resource-isolation-containers-microservices/"
---

Control Groups (cgroups) are the Linux kernel mechanism that every container runtime, Kubernetes, and systemd depends on for resource isolation and accounting. The cgroup v2 interface, which became the default in major distributions starting with Ubuntu 22.04 and RHEL 9, introduces a unified hierarchy, new controllers, and Pressure Stall Information — a qualitative measure of resource contention that v1 could never provide. This guide covers the cgroup v2 architecture, how to configure memory, CPU, and IO controllers directly, how PSI works, cgroup delegation for rootless containers, systemd integration patterns, and the Kubernetes configuration changes required when moving to cgroupv2.

<!--more-->

# Linux Control Groups v2: Resource Isolation for Containers and Microservices

## cgroup v1 vs cgroup v2: What Changed

In cgroup v1 (the original design from Linux 2.6.24), each resource controller — cpu, memory, blkio, net_cls, etc. — maintained its own independent hierarchy. A single process could appear in different locations within each controller's tree simultaneously. This created fundamental accounting problems:

- A process's combined resource usage required joining data across multiple independent trees
- Memory and CPU limits for the same container were in separate kernel data structures with no shared lifecycle
- Internal inconsistencies when processes moved between cgroups in one controller but not others

cgroup v2 introduces a single unified hierarchy. Every cgroup has exactly one parent, and all controllers are attached to the same tree. A process can only belong to one leaf cgroup — you cannot put a process in `cpu:/A` and `memory:/B` simultaneously.

```
cgroup v1 (fragmented):         cgroup v2 (unified):
cpu/                             cgroup.controllers
  ├── system.slice               ├── system.slice
  └── user.slice                 │   ├── nginx.service
memory/                          │   └── postgres.service
  ├── system.slice               └── user.slice
  └── user.slice                     └── user-1000.slice

Separate mount per controller     Single mount at /sys/fs/cgroup
```

### Checking Your cgroup Version

```bash
# Check which cgroup version is active
stat -fc %T /sys/fs/cgroup
# cgroup2fs  → cgroup v2
# tmpfs      → cgroup v1

# Check if cgroup v2 is mounted
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# Verify cgroup v2 hierarchy
ls /sys/fs/cgroup/
# cgroup.controllers  cgroup.events  cgroup.max.depth  cgroup.max.descendants
# cgroup.procs        cgroup.stat    cgroup.subtree_control  cgroup.threads
# cpu.pressure        io.pressure    memory.pressure
# system.slice        user.slice

# For hybrid setups (both v1 and v2)
mount | grep cgroup
# cpuset on /sys/fs/cgroup/cpuset type cgroup (rw,...,cpuset)
# cgroup2 on /sys/fs/cgroup/unified type cgroup2 (rw,...)
```

## The Unified Hierarchy

```
/sys/fs/cgroup/               ← Root cgroup (owned by kernel)
├── cgroup.controllers        ← Available controllers: cpu memory io pids
├── cgroup.subtree_control    ← Which controllers are delegated to children
├── memory.current            ← Root's total memory usage
│
├── system.slice/             ← systemd's slice for system services
│   ├── nginx.service/
│   │   ├── cgroup.procs      ← PIDs in this cgroup
│   │   ├── memory.max        ← Memory limit
│   │   ├── cpu.max           ← CPU quota
│   │   └── io.max            ← IO bandwidth limit
│   └── postgres.service/
│
├── kubepods.slice/           ← Kubernetes pod cgroups
│   ├── burstable/
│   │   └── pod<uid>/
│   │       ├── <container-id>/
│   │       │   ├── cgroup.procs
│   │       │   ├── memory.max
│   │       │   └── cpu.max
│   └── guaranteed/
│
└── user.slice/               ← User session cgroups
    └── user-1000.slice/
```

## Core cgroup v2 Files

Every cgroup directory contains a standard set of interface files:

| File | Purpose |
|------|---------|
| `cgroup.procs` | List of PIDs in this cgroup (write to move a process) |
| `cgroup.threads` | Like cgroup.procs but for individual threads |
| `cgroup.controllers` | Controllers available in this cgroup |
| `cgroup.subtree_control` | Controllers enabled for child cgroups |
| `cgroup.events` | Populated/empty notifications |
| `cgroup.stat` | Number of descendant cgroups and processes |
| `cgroup.max.depth` | Maximum nesting depth allowed |
| `cgroup.max.descendants` | Maximum number of descendant cgroups |

## Memory Controller

The memory controller enforces memory limits and provides detailed accounting.

### Memory Interface Files

| File | Purpose |
|------|---------|
| `memory.current` | Current memory usage in bytes |
| `memory.max` | Hard memory limit (OOM kill threshold) |
| `memory.high` | Soft memory limit (throttle before OOM) |
| `memory.min` | Guaranteed memory — kernel won't reclaim below this |
| `memory.low` | Protected memory — kernel tries not to reclaim |
| `memory.swap.max` | Swap usage limit |
| `memory.stat` | Detailed breakdown: anon, file, slab, etc. |
| `memory.events` | Count of oom_kill, max_usage_hit events |
| `memory.oom.group` | If 1, OOM kill terminates entire cgroup instead of individual process |

### Configuring Memory Limits

```bash
# Create a cgroup for a controlled process
sudo mkdir -p /sys/fs/cgroup/demo

# Enable memory controller in subtree
echo "+memory" | sudo tee /sys/fs/cgroup/cgroup.subtree_control

# Set a 256MB hard limit
echo "268435456" | sudo tee /sys/fs/cgroup/demo/memory.max

# Set a 200MB soft limit (will trigger memory reclaim before hitting max)
echo "209715200" | sudo tee /sys/fs/cgroup/demo/memory.high

# Guarantee at least 64MB will not be reclaimed under pressure
echo "67108864" | sudo tee /sys/fs/cgroup/demo/memory.min

# Disable OOM kill — let process receive SIGKILL only, not OOM killer
echo "1" | sudo tee /sys/fs/cgroup/demo/memory.oom.group

# Move current shell into the cgroup
echo $$ | sudo tee /sys/fs/cgroup/demo/cgroup.procs

# Monitor memory usage
watch -n 1 cat /sys/fs/cgroup/demo/memory.current
```

### Memory Accounting Breakdown

```bash
cat /sys/fs/cgroup/demo/memory.stat
# anon 52428800          # Anonymous memory (heap, stack, mmap MAP_ANONYMOUS)
# file 104857600         # File-backed memory (mmap, page cache)
# kernel 8388608         # Kernel memory (slab, kernel stacks)
# kernel_stack 1048576   # Process kernel stacks
# pagetables 131072      # Page table entries
# percpu 0               # Per-CPU data
# sock 0                 # Socket buffers
# shmem 0                # tmpfs / shared memory
# file_mapped 52428800   # Mapped file memory
# file_dirty 4096        # Dirty pages pending write
# file_writeback 0       # Pages being written back to disk
# anon_thp 0             # Anonymous Transparent Huge Pages
# inactive_anon 0
# active_anon 52428800
# inactive_file 52428800
# active_file 52428800
# unevictable 0
# slab_reclaimable 4194304
# slab_unreclaimable 2097152
```

### OOM Event Monitoring

```bash
# Watch for OOM kill events
inotifywait -m /sys/fs/cgroup/demo/memory.events &

# Or use a polling loop
while true; do
  events=$(cat /sys/fs/cgroup/demo/memory.events)
  oom_kills=$(echo "$events" | grep oom_kill | awk '{print $2}')
  echo "$(date): OOM kills: ${oom_kills}"
  sleep 5
done
```

## CPU Controller

The CPU controller in cgroup v2 replaces both the `cpu` and `cpuacct` controllers from v1.

### CPU Interface Files

| File | Purpose |
|------|---------|
| `cpu.max` | CFS bandwidth quota: `$quota $period` (max CPU time per period) |
| `cpu.weight` | Relative CPU share (range: 1–10000, default: 100) |
| `cpu.weight.nice` | Nice value mapped to cpu.weight (-20 to 19) |
| `cpu.stat` | Usage statistics: usage_usec, user_usec, system_usec, throttled_usec |
| `cpu.pressure` | PSI CPU pressure indicators |

### CPU Quota Configuration

```bash
# Allow the cgroup to use at most 2 CPUs (200ms out of every 100ms period)
# Format: <quota_us> <period_us>
# 200000 100000 = 2 CPUs worth of CPU time per 100ms period
echo "200000 100000" | sudo tee /sys/fs/cgroup/demo/cpu.max

# Set relative CPU weight (higher = more CPU when contention exists)
echo "500" | sudo tee /sys/fs/cgroup/demo/cpu.weight

# Verify CPU statistics
cat /sys/fs/cgroup/demo/cpu.stat
# usage_usec 12345678      # Total CPU microseconds used
# user_usec 8000000        # In userspace
# system_usec 4345678      # In kernel
# nr_periods 1234          # CFS scheduling periods elapsed
# nr_throttled 56          # Times the cgroup was throttled
# throttled_usec 2345678   # Total time throttled (microseconds)
# nr_bursts 0              # Burst periods used (if burst is configured)
# burst_usec 0

# Check if your workload is being throttled
python3 -c "
import time
data = open('/sys/fs/cgroup/demo/cpu.stat').read()
fields = dict(line.split() for line in data.strip().split('\n'))
throttled = int(fields['throttled_usec'])
total = int(fields['usage_usec'])
if total > 0:
    pct = throttled / total * 100
    print(f'Throttle ratio: {pct:.2f}%')
    if pct > 5:
        print('WARNING: High CPU throttling detected')
"
```

### CPU Burst Mode

Linux 5.14+ added burst mode for cgroup v2 CPU, allowing brief bursts above the quota using accumulated unused quota:

```bash
# Set burst budget — allow up to 50ms of burst above quota
echo "50000" | sudo tee /sys/fs/cgroup/demo/cpu.max.burst

# Verify burst configuration
cat /sys/fs/cgroup/demo/cpu.max
# 200000 100000    (quota=200ms, period=100ms)
cat /sys/fs/cgroup/demo/cpu.max.burst
# 50000            (burst=50ms)
```

## IO Controller

The IO controller (block I/O) replaces blkio from cgroup v1.

### IO Interface Files

| File | Purpose |
|------|---------|
| `io.max` | Per-device rate limits: rbps, wbps, riops, wiops |
| `io.weight` | Relative IO weight (1–10000) |
| `io.stat` | Per-device usage counters |
| `io.pressure` | PSI IO pressure indicators |
| `io.latency` | IO latency targets |

### IO Rate Limiting

```bash
# Find the device major:minor numbers
ls -la /dev/sda
# brw-rw---- 1 root disk 8, 0 ...
# Major=8, Minor=0

# Limit to 100MB/s read, 50MB/s write, 1000 RIOPS, 500 WIOPS
# Format: <major>:<minor> rbps=<bytes/s> wbps=<bytes/s> riops=<iops> wiops=<iops>
echo "8:0 rbps=104857600 wbps=52428800 riops=1000 wiops=500" \
  | sudo tee /sys/fs/cgroup/demo/io.max

# Check IO statistics
cat /sys/fs/cgroup/demo/io.stat
# 8:0 rbytes=10485760 wbytes=5242880 rios=100 wios=50 dbytes=0 dios=0

# Set IO latency target (best-effort, not a hard limit)
# Target 1ms p99 latency for this device
echo "8:0 target=1000" | sudo tee /sys/fs/cgroup/demo/io.latency
```

## Pressure Stall Information (PSI)

PSI is a cgroup v2 feature that measures the percentage of time tasks are stalled waiting for a resource. Unlike utilization metrics (which only show how busy a resource is), PSI shows how much the resource is actually constraining progress.

### PSI Format

Each resource has three PSI files: `memory.pressure`, `cpu.pressure`, `io.pressure`.

```bash
cat /sys/fs/cgroup/demo/memory.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

| Field | Meaning |
|-------|---------|
| `some` | At least one task is stalled on this resource |
| `full` | ALL runnable tasks are stalled (total stall — no progress possible) |
| `avg10` | 10-second exponential moving average (%) |
| `avg60` | 60-second exponential moving average (%) |
| `avg300` | 300-second exponential moving average (%) |
| `total` | Total microseconds spent stalled |

### PSI Monitoring with Go

```go
// psi_monitor.go
package psi

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

type PSIMetrics struct {
	SomeAvg10  float64
	SomeAvg60  float64
	SomeAvg300 float64
	SomeTotal  int64

	FullAvg10  float64
	FullAvg60  float64
	FullAvg300 float64
	FullTotal  int64
}

type PSICollector struct {
	cgroupPath string

	memSomeAvg10 *prometheus.GaugeVec
	memFullAvg10 *prometheus.GaugeVec
	cpuSomeAvg10 *prometheus.GaugeVec
	ioSomeAvg10  *prometheus.GaugeVec
	ioFullAvg10  *prometheus.GaugeVec
}

func NewPSICollector(cgroupPath string) *PSICollector {
	labels := []string{"cgroup"}
	return &PSICollector{
		cgroupPath: cgroupPath,
		memSomeAvg10: promauto.NewGaugeVec(prometheus.GaugeOpts{
			Name: "cgroup_memory_pressure_some_avg10",
			Help: "Memory PSI some avg10 percentage",
		}, labels),
		memFullAvg10: promauto.NewGaugeVec(prometheus.GaugeOpts{
			Name: "cgroup_memory_pressure_full_avg10",
			Help: "Memory PSI full avg10 percentage",
		}, labels),
		cpuSomeAvg10: promauto.NewGaugeVec(prometheus.GaugeOpts{
			Name: "cgroup_cpu_pressure_some_avg10",
			Help: "CPU PSI some avg10 percentage",
		}, labels),
		ioSomeAvg10: promauto.NewGaugeVec(prometheus.GaugeOpts{
			Name: "cgroup_io_pressure_some_avg10",
			Help: "IO PSI some avg10 percentage",
		}, labels),
		ioFullAvg10: promauto.NewGaugeVec(prometheus.GaugeOpts{
			Name: "cgroup_io_pressure_full_avg10",
			Help: "IO PSI full avg10 percentage",
		}, labels),
	}
}

func (c *PSICollector) Collect() error {
	cgroupName := strings.TrimPrefix(c.cgroupPath, "/sys/fs/cgroup/")

	resources := map[string]string{
		"memory": c.cgroupPath + "/memory.pressure",
		"cpu":    c.cgroupPath + "/cpu.pressure",
		"io":     c.cgroupPath + "/io.pressure",
	}

	for resource, path := range resources {
		metrics, err := readPSI(path)
		if err != nil {
			continue // Controller may not be enabled for this cgroup
		}

		switch resource {
		case "memory":
			c.memSomeAvg10.WithLabelValues(cgroupName).Set(metrics.SomeAvg10)
			c.memFullAvg10.WithLabelValues(cgroupName).Set(metrics.FullAvg10)
		case "cpu":
			c.cpuSomeAvg10.WithLabelValues(cgroupName).Set(metrics.SomeAvg10)
		case "io":
			c.ioSomeAvg10.WithLabelValues(cgroupName).Set(metrics.SomeAvg10)
			c.ioFullAvg10.WithLabelValues(cgroupName).Set(metrics.FullAvg10)
		}
	}

	return nil
}

func readPSI(path string) (*PSIMetrics, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	metrics := &PSIMetrics{}
	scanner := bufio.NewScanner(f)

	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}

		kind := fields[0] // "some" or "full"

		parsed := make(map[string]float64)
		for _, field := range fields[1:] {
			parts := strings.SplitN(field, "=", 2)
			if len(parts) != 2 {
				continue
			}
			val, err := strconv.ParseFloat(parts[1], 64)
			if err != nil {
				continue
			}
			parsed[parts[0]] = val
		}

		switch kind {
		case "some":
			metrics.SomeAvg10 = parsed["avg10"]
			metrics.SomeAvg60 = parsed["avg60"]
			metrics.SomeAvg300 = parsed["avg300"]
			metrics.SomeTotal = int64(parsed["total"])
		case "full":
			metrics.FullAvg10 = parsed["avg10"]
			metrics.FullAvg60 = parsed["avg60"]
			metrics.FullAvg300 = parsed["avg300"]
			metrics.FullTotal = int64(parsed["total"])
		}
	}

	return metrics, scanner.Err()
}

// PSI alert thresholds for production use
type PSIAlert struct {
	Resource   string
	Kind       string
	Threshold  float64
	Window     string
}

var ProductionPSIAlerts = []PSIAlert{
	{Resource: "memory", Kind: "some", Threshold: 10.0, Window: "avg60"},
	{Resource: "memory", Kind: "full", Threshold: 1.0,  Window: "avg60"},
	{Resource: "cpu",    Kind: "some", Threshold: 25.0, Window: "avg60"},
	{Resource: "io",     Kind: "some", Threshold: 15.0, Window: "avg60"},
	{Resource: "io",     Kind: "full", Threshold: 5.0,  Window: "avg60"},
}

// RunPSIMonitor continuously polls PSI and prints alerts
func RunPSIMonitor(cgroupPath string, interval time.Duration) {
	for {
		for _, alert := range ProductionPSIAlerts {
			path := fmt.Sprintf("%s/%s.pressure", cgroupPath, alert.Resource)
			metrics, err := readPSI(path)
			if err != nil {
				continue
			}

			var current float64
			switch alert.Kind + "." + alert.Window {
			case "some.avg60":
				current = metrics.SomeAvg60
			case "full.avg60":
				current = metrics.FullAvg60
			}

			if current > alert.Threshold {
				fmt.Printf("PSI ALERT: %s %s %s = %.2f%% (threshold: %.2f%%)\n",
					cgroupPath, alert.Resource, alert.Kind, current, alert.Threshold)
			}
		}
		time.Sleep(interval)
	}
}
```

### PSI Trigger Files for Threshold Notifications

cgroup v2 PSI supports kernel-level polling — instead of polling from userspace, your process registers a threshold and gets notified via a file descriptor:

```go
// psi_trigger.go — register a PSI threshold and receive inotify-style notifications
package psi

import (
	"fmt"
	"os"
	"syscall"
)

// RegisterPSIThreshold registers a kernel-level PSI threshold notification.
// When memory 'some' stall exceeds 5% over a 2-second window, the fd becomes readable.
func RegisterPSIThreshold(cgroupPath, resource string, thresholdPercent int, windowMs int) (*os.File, error) {
	path := fmt.Sprintf("%s/%s.pressure", cgroupPath, resource)
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, fmt.Errorf("opening pressure file: %w", err)
	}

	// Trigger format: "some <threshold_us> <window_us>"
	// threshold_us: microseconds of stall per window before triggering
	// window_us: measurement window in microseconds (500000 to 10000000)
	thresholdUs := int64(windowMs) * int64(thresholdPercent) * 10 // Convert % to us
	windowUs := int64(windowMs) * 1000

	trigger := fmt.Sprintf("some %d %d", thresholdUs, windowUs)
	if _, err := f.WriteString(trigger); err != nil {
		f.Close()
		return nil, fmt.Errorf("writing trigger: %w", err)
	}

	return f, nil
}

// WaitForPSIThreshold blocks until the PSI threshold is crossed using epoll.
func WaitForPSIThreshold(f *os.File) error {
	epfd, err := syscall.EpollCreate1(0)
	if err != nil {
		return fmt.Errorf("epoll_create1: %w", err)
	}
	defer syscall.Close(epfd)

	event := syscall.EpollEvent{
		Events: syscall.EPOLLPRI,
		Fd:     int32(f.Fd()),
	}
	if err := syscall.EpollCtl(epfd, syscall.EPOLL_CTL_ADD, int(f.Fd()), &event); err != nil {
		return fmt.Errorf("epoll_ctl: %w", err)
	}

	events := make([]syscall.EpollEvent, 1)
	_, err = syscall.EpollWait(epfd, events, -1) // Block indefinitely
	return err
}
```

## PID Controller

The PID controller limits the number of processes a cgroup can create — critical for preventing fork bombs:

```bash
# Limit a cgroup to 100 processes
echo "100" | sudo tee /sys/fs/cgroup/demo/pids.max

# Current PID count
cat /sys/fs/cgroup/demo/pids.current

# Maximum PID limit events
cat /sys/fs/cgroup/demo/pids.events
# max 0   (number of times limit was hit)
```

## cgroup Delegation for Rootless Containers

Delegation allows an unprivileged user to manage a sub-hierarchy without root privileges. This is the foundation of rootless containers (Podman, rootless Docker, user namespaces).

### Enabling Delegation

```bash
# systemd manages delegation via the Delegate= option in unit files
# For user slices, edit the resource slice:
mkdir -p /etc/systemd/system/user@.service.d/
cat > /etc/systemd/system/user@.service.d/delegate.conf << 'EOF'
[Service]
Delegate=cpu cpuset io memory pids
EOF

systemctl daemon-reload

# Verify delegation is enabled for your user's slice
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/cgroup.subtree_control
# cpu io memory pids
```

### Delegation in Practice: Rootless Podman

When rootless Podman creates a container, it:
1. Creates a cgroup under the user's delegated hierarchy
2. Configures memory and CPU limits in that cgroup
3. Moves the container's init process into the cgroup

```bash
# Run a container with resource limits (rootless)
podman run --rm -d \
  --memory="512m" \
  --cpus="1.5" \
  --pids-limit=200 \
  --name=test-container \
  nginx:latest

# Find the container's cgroup
systemctl status --user | grep -A5 "podman"
podman inspect test-container --format '{{.HostConfig.CgroupParent}}'

# View the cgroup hierarchy
find /sys/fs/cgroup/user.slice/user-$(id -u).slice -name "memory.max" 2>/dev/null \
  | xargs -I{} sh -c 'echo "{}:"; cat {}'
```

### Delegation Ownership Rules

For delegation to be safe, the kernel enforces strict rules:
1. Only the owning user (or root) can write to delegated cgroup files
2. The delegate cannot exceed its parent's limits
3. Moving processes into delegated cgroups requires ownership of both the source and destination cgroups

```go
// cgroupdelegation.go — check if delegation is properly configured
package cgroup

import (
	"fmt"
	"os"
	"strings"
)

// CheckDelegation verifies that a cgroup path is properly delegated to the current user.
func CheckDelegation(cgroupPath string) error {
	info, err := os.Stat(cgroupPath)
	if err != nil {
		return fmt.Errorf("stat %s: %w", cgroupPath, err)
	}

	// Check ownership
	uid := os.Getuid()
	if int(info.Sys().(*syscall.Stat_t).Uid) != uid {
		return fmt.Errorf("cgroup %s is not owned by current user (uid=%d)", cgroupPath, uid)
	}

	// Check subtree_control
	controlPath := cgroupPath + "/cgroup.subtree_control"
	data, err := os.ReadFile(controlPath)
	if err != nil {
		return fmt.Errorf("reading subtree_control: %w", err)
	}

	required := []string{"memory", "cpu", "pids"}
	enabled := strings.Fields(string(data))
	enabledSet := make(map[string]bool)
	for _, c := range enabled {
		enabledSet[c] = true
	}

	var missing []string
	for _, req := range required {
		if !enabledSet[req] {
			missing = append(missing, req)
		}
	}

	if len(missing) > 0 {
		return fmt.Errorf("required controllers not enabled: %v", missing)
	}

	return nil
}
```

Add the missing import:

```go
import "syscall"
```

## systemd Integration

systemd v246+ fully supports cgroup v2. Unit files use resource control directives that map directly to cgroup v2 interface files.

### Service Resource Configuration

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My Application
After=network.target

[Service]
Type=exec
ExecStart=/usr/local/bin/myapp
User=myapp
Group=myapp

# Memory controls → memory.max and memory.high
MemoryMax=2G
MemoryHigh=1.5G
MemoryMin=256M     # Guaranteed memory — will not be reclaimed

# CPU controls → cpu.max and cpu.weight
CPUQuota=150%      # 1.5 CPU cores (150% of a single core)
CPUWeight=500      # Relative weight (default=100, higher=more CPU on contention)

# IO controls → io.weight and io.max
IOWeight=200       # Higher IO priority
IOReadBandwidthMax=/dev/sda 100M
IOWriteBandwidthMax=/dev/sda 50M

# PID limit → pids.max
TasksMax=500

# Enable cgroup delegation for this service
Delegate=yes

[Install]
WantedBy=multi-user.target
```

```bash
# Apply changes
sudo systemctl daemon-reload
sudo systemctl restart myapp

# Inspect effective cgroup settings
systemctl show myapp | grep -E "(Memory|CPU|IO|Tasks)"

# Find the service's cgroup path
systemctl show myapp --property=ControlGroup
# ControlGroup=/system.slice/myapp.service

# Check actual kernel values
cat /sys/fs/cgroup/system.slice/myapp.service/memory.max
cat /sys/fs/cgroup/system.slice/myapp.service/cpu.max
cat /sys/fs/cgroup/system.slice/myapp.service/cpu.weight
```

### Transient cgroups with systemd-run

```bash
# Create a transient cgroup for a one-off command with resource limits
systemd-run \
  --scope \
  --slice=workloads.slice \
  --property=MemoryMax=512M \
  --property=CPUQuota=50% \
  --property=IOWeight=50 \
  -- /usr/bin/python3 heavy_script.py

# For background services
systemd-run \
  --unit=backup-job \
  --slice=maintenance.slice \
  --property=MemoryMax=1G \
  --property=CPUQuota=20% \
  --property=Nice=10 \
  /usr/local/bin/backup.sh
```

### Slice Hierarchy for Workload Isolation

```bash
# Create a slice hierarchy for production vs. batch workloads
cat > /etc/systemd/system/production.slice << 'EOF'
[Slice]
CPUWeight=800      # Production gets most CPU when contention exists
MemoryMin=4G       # Reserve 4GB for production workloads
IOWeight=800
EOF

cat > /etc/systemd/system/batch.slice << 'EOF'
[Slice]
CPUWeight=100      # Batch gets leftover CPU
MemoryHigh=2G      # Batch is soft-limited to 2GB
IOWeight=100
EOF

# Assign services to slices
cat > /etc/systemd/system/webapp.service << 'EOF'
[Unit]
Description=Web Application

[Service]
Slice=production.slice
ExecStart=/usr/local/bin/webapp
MemoryMax=2G
CPUQuota=200%
EOF

cat > /etc/systemd/system/nightly-report.service << 'EOF'
[Unit]
Description=Nightly Report Generator

[Service]
Slice=batch.slice
ExecStart=/usr/local/bin/generate-report
MemoryMax=1G
CPUQuota=50%
EOF
```

## Kubernetes cgroup v2 Configuration

Kubernetes uses cgroups for container resource isolation. The transition from v1 to v2 requires configuring both the container runtime and the kubelet.

### Kubelet Configuration

```yaml
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Use cgroupv2
cgroupDriver: systemd    # Must match containerd's cgroup driver
# cgroupsPerQOS: true is the default — creates QoS-class sub-cgroups

# Enable memory-based eviction using PSI
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"

# PSI-based eviction thresholds (Kubernetes 1.29+)
# These map to cgroup PSI values
evictionPressureTransitionPeriod: "5m"

# cgroup v2 enables more accurate memory accounting
featureGates:
  MemoryQoS: true           # Maps memory.min/low to QoS classes (beta in 1.22)
```

### containerd Configuration

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
        runtime_type = "io.containerd.runc.v2"
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
          SystemdCgroup = true    # Use systemd cgroup driver for cgroup v2
```

```bash
# Verify containerd is using systemd cgroup driver
containerd config dump | grep SystemdCgroup
# SystemdCgroup = true

# Restart containerd after config change
sudo systemctl restart containerd
```

### Kubernetes cgroup Hierarchy for Pods

With `cgroupDriver: systemd` and cgroup v2, Kubernetes creates the following hierarchy:

```
/sys/fs/cgroup/
└── kubepods.slice/                          ← Top-level Kubernetes slice
    ├── kubepods-besteffort.slice/           ← BestEffort QoS class
    │   └── kubepods-besteffort-pod<uid>.slice/
    │       ├── memory.max = max            ← No limit for BestEffort
    │       └── <container-id>/
    │           └── memory.max = max
    │
    ├── kubepods-burstable.slice/            ← Burstable QoS class
    │   └── kubepods-burstable-pod<uid>.slice/
    │       ├── memory.min = <sum of requests>  ← Reserved from reclaim
    │       └── <container-id>/
    │           ├── memory.max = <limit if set>
    │           └── cpu.max = <limit if set>
    │
    └── kubepods-guaranteed.slice/          ← Guaranteed QoS class
        └── kubepods-guaranteed-pod<uid>.slice/
            ├── memory.min = <request>     ← Fully protected
            ├── memory.max = <limit>       ← Hard cap = request
            └── cpu.max = <limit>          ← CPU quota = request
```

### Memory QoS Feature

The `MemoryQoS` feature gate maps Kubernetes memory requests to cgroup v2 `memory.min` and `memory.high`:

```yaml
# Pod spec with Memory QoS benefitting from cgroup v2
apiVersion: v1
kind: Pod
metadata:
  name: db-pod
  namespace: production
spec:
  containers:
    - name: postgres
      image: postgres:15
      resources:
        requests:
          memory: "2Gi"   # → memory.min = 2Gi (guaranteed, won't be reclaimed)
        limits:
          memory: "4Gi"   # → memory.max = 4Gi (hard limit)
      # With MemoryQoS enabled:
      # memory.min  = 2Gi  (kernel won't reclaim below this)
      # memory.high = 3.2Gi (throttle before OOM; calculated as 80% of limit)
      # memory.max  = 4Gi  (OOM kill threshold)
```

### Verifying cgroup v2 Pod Isolation

```bash
# Find pod's cgroup from inside a running pod
cat /proc/self/cgroup
# 0::/

# From the node, find the pod's cgroup path
POD_UID="abc12345-..."
CONTAINER_ID="sha256:..."

# Locate the cgroup
find /sys/fs/cgroup -name "cgroup.procs" | xargs grep -l "$(pgrep -n -f postgres)" 2>/dev/null

# Check container memory limit
cat /sys/fs/cgroup/kubepods.slice/kubepods-guaranteed.slice/kubepods-guaranteed-pod${POD_UID}.slice/memory.max

# Check if container is experiencing memory pressure
cat /sys/fs/cgroup/kubepods.slice/.../memory.pressure
# some avg10=0.00 avg60=2.34 avg300=1.12 total=1234567
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

## cpuset Controller

The cpuset controller pins a cgroup's processes to specific CPU cores and NUMA nodes:

```bash
# Pin the cgroup to CPUs 0-3 and NUMA node 0
echo "0-3" | sudo tee /sys/fs/cgroup/demo/cpuset.cpus
echo "0" | sudo tee /sys/fs/cgroup/demo/cpuset.mems

# Enable exclusive CPU access (no sharing with other cgroups)
echo "1" | sudo tee /sys/fs/cgroup/demo/cpuset.cpus.exclusive

# Verify CPU affinity is applied to processes in the cgroup
cat /sys/fs/cgroup/demo/cpuset.cpus.effective
# 0-3

# Check NUMA binding
cat /sys/fs/cgroup/demo/cpuset.mems.effective
# 0
```

For Kubernetes, CPU pinning for Guaranteed QoS pods with integer CPU requests is managed by the CPU Manager:

```yaml
# kubelet configuration for CPU Manager
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static      # Enable CPU pinning
reservedSystemCPUs: "0-1"    # Reserve CPUs 0-1 for system overhead
topologyManagerPolicy: single-numa-node  # Require NUMA-local allocation
```

## cgroup v2 Migration Checklist

When migrating a cluster from cgroup v1 to v2:

```bash
#!/bin/bash
# check-cgroupv2-readiness.sh

set -e
echo "=== cgroup v2 Readiness Check ==="

# 1. Check kernel version (cgroup v2 stable since 4.15, recommended 5.8+)
kernel=$(uname -r)
echo "Kernel: ${kernel}"
major=$(echo "$kernel" | cut -d. -f1)
minor=$(echo "$kernel" | cut -d. -f2)
if [ "$major" -lt 5 ] || ([ "$major" -eq 5 ] && [ "$minor" -lt 8 ]); then
  echo "WARNING: Kernel ${kernel} is below recommended 5.8 for full cgroup v2 support"
fi

# 2. Check if cgroup v2 is active
if stat -fc %T /sys/fs/cgroup | grep -q cgroup2fs; then
  echo "OK: cgroup v2 is active"
else
  echo "FAIL: cgroup v2 is not active"
  echo "  Add 'systemd.unified_cgroup_hierarchy=1' to kernel cmdline"
fi

# 3. Check containerd cgroup driver
if command -v containerd &>/dev/null; then
  driver=$(containerd config dump 2>/dev/null | grep SystemdCgroup | awk '{print $3}')
  if [ "$driver" = "true" ]; then
    echo "OK: containerd uses systemd cgroup driver"
  else
    echo "FAIL: containerd does not use systemd cgroup driver"
    echo "  Set SystemdCgroup = true in /etc/containerd/config.toml"
  fi
fi

# 4. Check kubelet cgroup driver
if command -v kubelet &>/dev/null; then
  if kubelet --version &>/dev/null; then
    cfg=$(find /etc/kubernetes -name "kubelet-config.yaml" 2>/dev/null | head -1)
    if [ -n "$cfg" ]; then
      driver=$(grep cgroupDriver "$cfg" | awk '{print $2}')
      echo "Kubelet cgroupDriver: ${driver}"
      if [ "$driver" = "systemd" ]; then
        echo "OK: kubelet uses systemd cgroup driver"
      else
        echo "FAIL: kubelet cgroupDriver should be 'systemd' for cgroup v2"
      fi
    fi
  fi
fi

# 5. Check PSI availability
if [ -f /sys/fs/cgroup/memory.pressure ]; then
  echo "OK: PSI is available"
else
  echo "WARNING: PSI not found. Check kernel config CONFIG_PSI=y"
fi

# 6. Check available controllers
controllers=$(cat /sys/fs/cgroup/cgroup.controllers)
echo "Available controllers: ${controllers}"
for required in cpu cpuset io memory pids; do
  if echo "$controllers" | grep -q "$required"; then
    echo "  OK: ${required} controller available"
  else
    echo "  FAIL: ${required} controller missing"
  fi
done

echo ""
echo "=== Check Complete ==="
```

## Prometheus Monitoring Rules

```yaml
# cgroup-v2-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cgroupv2-rules
  namespace: monitoring
spec:
  groups:
    - name: cgroupv2.psi
      rules:
        # Alert on high memory PSI (more than 10% stall time over 5 minutes)
        - alert: HighMemoryPressure
          expr: |
            container_memory_psi_some_avg60 > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High memory pressure on {{ $labels.container }} in {{ $labels.namespace }}"
            description: "Memory PSI 'some' avg60 = {{ $value }}% — tasks are waiting for memory"

        # Alert on full memory stall (all tasks blocked — severe)
        - alert: CriticalMemoryStall
          expr: |
            container_memory_psi_full_avg10 > 1
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Critical memory stall on {{ $labels.container }}"
            description: "Memory PSI 'full' avg10 = {{ $value }}% — all tasks completely stalled"

        # Alert on high CPU PSI (indicates CPU throttling impact)
        - alert: HighCPUThrottling
          expr: |
            rate(container_cpu_cfs_throttled_seconds_total[5m]) /
            rate(container_cpu_usage_seconds_total[5m]) > 0.25
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Container {{ $labels.container }} CPU throttled >25%"

        # Alert on IO PSI
        - alert: HighIOPressure
          expr: |
            container_io_psi_some_avg60 > 20
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High IO pressure on {{ $labels.container }}"
            description: "IO PSI 'some' avg60 = {{ $value }}%"
```

## Summary

cgroup v2 is not just an incremental improvement — it represents a fundamental redesign of how Linux manages resources. The unified hierarchy eliminates the accounting inconsistencies of v1, and PSI provides a qualitatively different view of resource contention that enables smarter scheduling and eviction decisions.

For production operations, the key actions are:

1. Verify cgroup v2 is active on all nodes (`stat -fc %T /sys/fs/cgroup`)
2. Configure containerd with `SystemdCgroup = true`
3. Set kubelet `cgroupDriver: systemd`
4. Enable the `MemoryQoS` feature gate for more accurate memory protection
5. Deploy PSI monitoring to detect resource pressure before it manifests as latency spikes or OOM kills
6. Use `memory.high` (via systemd `MemoryHigh=`) as a soft limit rather than relying solely on `memory.max` hard limits
7. Configure CPU Manager `static` policy for latency-sensitive Guaranteed QoS pods that need deterministic CPU pinning
