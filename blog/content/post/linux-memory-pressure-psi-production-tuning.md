---
title: "Linux Memory Pressure and PSI: Pressure Stall Information for Production Tuning"
date: 2029-02-16T00:00:00-05:00
draft: false
tags: ["Linux", "Memory", "PSI", "Performance", "cgroups", "Kernel"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux Pressure Stall Information (PSI) for detecting and resolving memory, CPU, and I/O contention in production systems, covering /proc/pressure, cgroup2 PSI, alerting integration, and kernel memory reclaim tuning."
more_link: "yes"
url: "/linux-memory-pressure-psi-production-tuning/"
---

Traditional Linux memory metrics—`free`, `MemAvailable`, `SwapUsed`—describe how much memory is allocated but not how much work is *stalled* waiting for memory. A system can show 2GB free while hundreds of processes wait in the kernel's direct reclaim path, causing severe application latency. Pressure Stall Information (PSI), introduced in Linux 4.20 and backported to many 4.14 LTS kernels, quantifies this stall time directly. PSI answers the question: what fraction of wall-clock time were tasks unable to make progress because of resource contention?

This guide covers PSI metric interpretation, reading PSI from `/proc/pressure` and cgroup2, integrating PSI into Prometheus alerting, tuning kernel memory reclaim parameters to reduce stalls, and using PSI for admission control in Kubernetes.

<!--more-->

## PSI Architecture and Metric Semantics

PSI tracks three resource dimensions: **cpu**, **memory**, and **io**. For each dimension, two metrics are reported:

- **some**: At least one task was stalled (partial contention)
- **full**: All runnable tasks were stalled (complete contention — the most serious condition)

Each metric is expressed as the fraction of time spent stalled over three windows: 10 seconds, 60 seconds, and 300 seconds (avg10, avg60, avg300).

```
/proc/pressure/memory:
some avg10=0.00 avg60=0.25 avg300=0.08 total=1234567
full avg10=0.00 avg60=0.12 avg300=0.03 total=456789
```

- `some=0.25` over 60s means: during the last 60 seconds, 0.25% of time had at least one task waiting on memory
- `full=0.12` over 60s means: during the last 60 seconds, 0.12% of time had *all* tasks stalled on memory
- `total` is cumulative microseconds spent stalled since boot

### When to Worry

| PSI Value | Severity | Meaning |
|-----------|----------|---------|
| some < 0.5% | Normal | Occasional minor reclaim |
| some 0.5–5% | Monitor | Active page reclaim under load |
| some > 5% | Warning | Significant memory pressure |
| full > 0.5% | Critical | Application latency degraded |
| full > 5% | Emergency | Severe memory exhaustion |

## Reading PSI from /proc/pressure

```bash
# Check all three pressure dimensions
cat /proc/pressure/cpu
cat /proc/pressure/memory
cat /proc/pressure/io

# Sample output showing moderate memory pressure:
# /proc/pressure/memory
# some avg10=2.43 avg60=1.87 avg300=0.92 total=15234891
# full avg10=0.12 avg60=0.08 avg300=0.04 total=892341

# Monitor PSI in real-time (1-second updates)
watch -n 1 'echo "=== CPU ==="; cat /proc/pressure/cpu; \
            echo "=== Memory ==="; cat /proc/pressure/memory; \
            echo "=== IO ==="; cat /proc/pressure/io'

# Check if PSI is available (kernel 4.20+)
test -f /proc/pressure/memory && echo "PSI available" || echo "PSI not available"

# Enable PSI if disabled (some distros disable it by default)
# Add to kernel command line: psi=1
# Or at runtime (if compiled as module):
echo 1 > /proc/sys/kernel/psi_enabled
```

## PSI via cgroup2 (Per-Workload Pressure)

With cgroup2, each cgroup exposes its own PSI data. This is critical for Kubernetes nodes, where you need per-pod pressure rather than system-wide metrics.

```bash
# Check PSI for a specific cgroup
# In Kubernetes, pods are under /sys/fs/cgroup/kubepods.slice/
cat /sys/fs/cgroup/kubepods.slice/memory.pressure
# some avg10=0.00 avg60=1.23 avg300=0.45 total=2345678

# Find which pod is under the most memory pressure
for d in /sys/fs/cgroup/kubepods.slice/kubepods-besteffort.slice/*/; do
    pod_uid=$(basename "${d}")
    pressure=$(awk '/^full/{print $2}' "${d}/memory.pressure" 2>/dev/null | cut -d= -f2)
    echo "${pressure} ${pod_uid}"
done | sort -rn | head -10

# Watch system-wide cgroup2 memory pressure
watch -n 2 'find /sys/fs/cgroup -name "memory.pressure" \
    -exec sh -c "echo \"--- {} ---\"; cat \"{}\"" \; 2>/dev/null | head -60'
```

## PSI Trigger Interface

The kernel supports a file descriptor-based trigger that generates an epoll event when PSI exceeds a threshold. This is how systemd's oomd and Facebook's oomd2 work.

```c
/* C example: PSI trigger via epoll (shown for reference, normally used from Go/Python) */
/* Trigger: notify when memory "some" exceeds 1% within a 1-second window */

int psi_fd = open("/proc/pressure/memory", O_RDWR | O_NONBLOCK | O_CLOEXEC);
const char *trigger = "some 10000 1000000";  /* threshold_us window_us */
write(psi_fd, trigger, strlen(trigger));

/* Now psi_fd becomes readable via epoll when the threshold is exceeded */
```

### Go Implementation of PSI Monitor

```go
package psimon

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Metrics holds the PSI metrics for one resource dimension.
type Metrics struct {
	Resource string

	SomeAvg10  float64
	SomeAvg60  float64
	SomeAvg300 float64
	SomeTotal  uint64

	FullAvg10  float64
	FullAvg60  float64
	FullAvg300 float64
	FullTotal  uint64

	Timestamp time.Time
}

// Read parses PSI metrics for the given resource (cpu, memory, io).
// path can be /proc/pressure/<resource> or a cgroup pressure file.
func Read(resource string) (*Metrics, error) {
	path := fmt.Sprintf("/proc/pressure/%s", resource)
	return ReadPath(resource, path)
}

// ReadPath reads PSI from an arbitrary path (for cgroup support).
func ReadPath(resource, path string) (*Metrics, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("psi open %q: %w", path, err)
	}
	defer f.Close()

	m := &Metrics{
		Resource:  resource,
		Timestamp: time.Now(),
	}

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Fields(line)
		if len(parts) < 5 {
			continue
		}

		kind := parts[0] // "some" or "full"
		var avg10, avg60, avg300 float64
		var total uint64

		for _, field := range parts[1:] {
			kv := strings.SplitN(field, "=", 2)
			if len(kv) != 2 {
				continue
			}
			switch kv[0] {
			case "avg10":
				avg10, _ = strconv.ParseFloat(kv[1], 64)
			case "avg60":
				avg60, _ = strconv.ParseFloat(kv[1], 64)
			case "avg300":
				avg300, _ = strconv.ParseFloat(kv[1], 64)
			case "total":
				total, _ = strconv.ParseUint(kv[1], 10, 64)
			}
		}

		switch kind {
		case "some":
			m.SomeAvg10, m.SomeAvg60, m.SomeAvg300, m.SomeTotal = avg10, avg60, avg300, total
		case "full":
			m.FullAvg10, m.FullAvg60, m.FullAvg300, m.FullTotal = avg10, avg60, avg300, total
		}
	}

	return m, scanner.Err()
}

// IsCritical returns true if PSI exceeds production-critical thresholds.
func (m *Metrics) IsCritical() bool {
	return m.FullAvg10 > 5.0 || m.SomeAvg10 > 20.0
}

// IsWarning returns true if PSI exceeds warning thresholds.
func (m *Metrics) IsWarning() bool {
	return m.FullAvg10 > 0.5 || m.SomeAvg10 > 5.0
}
```

## Prometheus Metrics Exporter for PSI

```go
// cmd/psi-exporter/main.go
package main

import (
	"log"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/supporttools/psimon"
)

var (
	psiSomeAvg10 = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "node_pressure_some_avg10_ratio",
		Help: "PSI some stall avg10 (fraction)",
	}, []string{"resource"})

	psiSomeAvg60 = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "node_pressure_some_avg60_ratio",
		Help: "PSI some stall avg60 (fraction)",
	}, []string{"resource"})

	psiFullAvg10 = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "node_pressure_full_avg10_ratio",
		Help: "PSI full stall avg10 (fraction)",
	}, []string{"resource"})

	psiFullAvg60 = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "node_pressure_full_avg60_ratio",
		Help: "PSI full stall avg60 (fraction)",
	}, []string{"resource"})

	psiSomeTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "node_pressure_some_total_seconds",
		Help: "PSI some stall total (seconds)",
	}, []string{"resource"})

	psiFullTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "node_pressure_full_total_seconds",
		Help: "PSI full stall total (seconds)",
	}, []string{"resource"})
)

func collectPSI() {
	for _, resource := range []string{"cpu", "memory", "io"} {
		m, err := psimon.Read(resource)
		if err != nil {
			log.Printf("PSI read error for %s: %v", resource, err)
			continue
		}
		psiSomeAvg10.WithLabelValues(resource).Set(m.SomeAvg10)
		psiSomeAvg60.WithLabelValues(resource).Set(m.SomeAvg60)
		psiFullAvg10.WithLabelValues(resource).Set(m.FullAvg10)
		psiFullAvg60.WithLabelValues(resource).Set(m.FullAvg60)
		// Convert microseconds to seconds for Prometheus convention
		psiSomeTotal.WithLabelValues(resource).(prometheus.Counter).Add(float64(m.SomeTotal) / 1e6)
		psiFullTotal.WithLabelValues(resource).(prometheus.Counter).Add(float64(m.FullTotal) / 1e6)
	}
}

func main() {
	go func() {
		for range time.Tick(5 * time.Second) {
			collectPSI()
		}
	}()
	collectPSI() // Initial collection

	http.Handle("/metrics", promhttp.Handler())
	log.Fatal(http.ListenAndServe(":9101", nil))
}
```

## PrometheusRule Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: psi-alerts
  namespace: monitoring
spec:
  groups:
    - name: psi
      rules:
        - alert: NodeMemoryPressureHigh
          expr: |
            node_pressure_some_avg60_ratio{resource="memory"} > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High memory pressure on {{ $labels.instance }}"
            description: |
              Memory PSI some avg60={{ $value | humanize }}% on {{ $labels.instance }}.
              Tasks are spending >5% of time waiting for memory.

        - alert: NodeMemoryPressureCritical
          expr: |
            node_pressure_full_avg10_ratio{resource="memory"} > 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Critical memory pressure: all tasks stalled on {{ $labels.instance }}"
            description: |
              Memory PSI full avg10={{ $value | humanize }}% on {{ $labels.instance }}.
              All tasks are stalling. OOM kill risk is high.

        - alert: NodeIOPressureHigh
          expr: |
            node_pressure_full_avg60_ratio{resource="io"} > 2
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High I/O pressure on {{ $labels.instance }}"
            description: |
              I/O PSI full avg60={{ $value | humanize }}% on {{ $labels.instance }}.

        - alert: NodeCPUPressureHigh
          expr: |
            node_pressure_some_avg10_ratio{resource="cpu"} > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High CPU pressure: {{ $value | humanize }}% stall rate"
```

## Kernel Memory Reclaim Tuning

When PSI shows high memory pressure, the kernel's reclaim parameters control how aggressively memory is reclaimed and how that reclaim is prioritized.

```bash
# /etc/sysctl.d/60-memory-pressure.conf

# vm.swappiness: tendency to swap anonymous memory vs. reclaim file-backed pages
# 0  = avoid swap aggressively (good for databases, avoid for general workloads)
# 10 = prefer to reclaim file cache before swap (recommended for most servers)
# 60 = default (too swap-happy for production)
vm.swappiness = 10

# vm.dirty_ratio: % of RAM that can be dirty before throttling writes
# Lowering this reduces write spikes that cause I/O PSI spikes
vm.dirty_ratio = 10

# vm.dirty_background_ratio: % of RAM dirty before background flush starts
vm.dirty_background_ratio = 3

# vm.vfs_cache_pressure: aggressiveness of inode/dentry cache reclaim
# 50 = reclaim page cache twice as aggressively as inode cache
# 100 = default, balanced
# 200 = very aggressive inode reclaim (useful when inode count is huge)
vm.vfs_cache_pressure = 50

# vm.min_free_kbytes: minimum free memory the kernel maintains
# Increasing this reduces the chance of hitting synchronous direct reclaim
# Set to ~1% of total RAM on systems with >64GB
vm.min_free_kbytes = 524288  # 512 MB

# vm.watermark_boost_factor: multiplier for min_free_kbytes watermarks
# Higher values give the kswapd daemon more headroom before direct reclaim
vm.watermark_boost_factor = 150

# transparent huge pages: often increases memory pressure due to defragmentation
# Disable for latency-sensitive workloads
# (set via /sys/kernel/mm/transparent_hugepage/enabled)
```

```bash
# Apply immediately
sysctl -p /etc/sysctl.d/60-memory-pressure.conf

# Verify THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
# To persist: add to /etc/rc.local or a systemd service
```

## cgroup2 Memory Limits and PSI Interaction

When a cgroup hits its memory limit, PSI in that cgroup spikes as tasks reclaim memory within the cgroup boundary.

```bash
# Set memory limits on a systemd service (uses cgroup2)
systemctl edit myapp.service
# Add:
# [Service]
# MemoryMax=4G
# MemorySwapMax=0  # Disable swap for this service
# MemoryHigh=3G   # Soft limit: triggers throttling and PSI before hard OOM

# Check memory usage and PSI for the service
systemctl status myapp.service
cat /sys/fs/cgroup/system.slice/myapp.service/memory.pressure
cat /sys/fs/cgroup/system.slice/myapp.service/memory.current
cat /sys/fs/cgroup/system.slice/myapp.service/memory.stat
```

## PSI-Based Admission Control

Facebook's production systems use PSI to implement admission control—new requests are rejected when PSI exceeds a threshold, preventing cascading memory failures.

```go
package admission

import (
	"fmt"
	"sync/atomic"
	"time"

	"github.com/supporttools/psimon"
)

// Controller makes admission decisions based on PSI metrics.
type Controller struct {
	somePressureThreshold float64 // e.g., 10.0 (10%)
	fullPressureThreshold float64 // e.g., 1.0 (1%)
	lastMetrics           atomic.Pointer[psimon.Metrics]
}

// NewController creates an admission controller with the given thresholds.
func NewController(someThreshold, fullThreshold float64) *Controller {
	c := &Controller{
		somePressureThreshold: someThreshold,
		fullPressureThreshold: fullThreshold,
	}
	go c.refresh()
	return c
}

func (c *Controller) refresh() {
	for range time.Tick(2 * time.Second) {
		m, err := psimon.Read("memory")
		if err == nil {
			c.lastMetrics.Store(m)
		}
	}
}

// Admit returns nil if the request should be processed, or an error with details if rejected.
func (c *Controller) Admit() error {
	m := c.lastMetrics.Load()
	if m == nil {
		return nil // No data yet, admit
	}

	if m.FullAvg10 > c.fullPressureThreshold {
		return fmt.Errorf("memory pressure critical (full avg10=%.2f%%): request rejected",
			m.FullAvg10)
	}
	if m.SomeAvg10 > c.somePressureThreshold {
		return fmt.Errorf("memory pressure high (some avg10=%.2f%%): request rejected",
			m.SomeAvg10)
	}
	return nil
}
```

## Diagnosing Memory Pressure Events

When PSI spikes, use these tools to identify the cause:

```bash
# Check kernel memory reclaim activity
vmstat -s | grep -E "pages|swapped|reclaimed"

# Check if OOM kill is happening alongside pressure spikes
dmesg | grep -E "oom_kill|Out of memory" | tail -20

# Identify processes driving memory allocation
ps aux --sort=-%mem | head -20

# Check page reclaim stats in real-time
watch -n 1 'cat /proc/vmstat | grep -E "pgreclaim|pgsteal|pgscan|pgmajfault|allocstall"'

# Check for kernel memory pressure in system journal
journalctl -k --since "1 hour ago" | grep -iE "memory|oom|pressure" | tail -30

# Find which cgroup is under the most memory pressure
for f in $(find /sys/fs/cgroup -name 'memory.pressure' 2>/dev/null); do
    full10=$(awk '/^full/{for(i=1;i<=NF;i++) if($i~/^avg10=/) print substr($i,7)}' "$f")
    if [ -n "$full10" ] && [ "$(echo "$full10 > 0.5" | bc -l)" = "1" ]; then
        echo "$full10 $f"
    fi
done | sort -rn | head -10

# Trace memory allocation paths under pressure (requires BPF/eBPF tools)
# sudo bpftrace -e 'kprobe:direct_reclaim_begin { @[kstack] = count(); } interval:s:5 { print(@); clear(@); }'
```

## Integrating PSI with node-exporter

The Prometheus `node_exporter` v1.5+ includes built-in PSI metrics under the `pressure` collector.

```bash
# Enable PSI collector in node_exporter
node_exporter --collector.pressure \
              --web.listen-address=:9100

# Resulting metrics:
# node_pressure_cpu_waiting_seconds_total
# node_pressure_cpu_stalled_seconds_total
# node_pressure_memory_waiting_seconds_total
# node_pressure_memory_stalled_seconds_total
# node_pressure_io_waiting_seconds_total
# node_pressure_io_stalled_seconds_total
```

## Summary

PSI provides the first direct, quantitative measurement of resource stall time in the Linux kernel. Where traditional metrics tell you how much memory is allocated, PSI tells you how much application performance has been degraded. The five-step approach to PSI in production is: enable the pressure collector in node_exporter, establish baseline PSI values for healthy operation, configure PrometheusRule alerts on `full` pressure, tune `vm.swappiness` and `vm.min_free_kbytes` to reduce stall frequency, and use per-cgroup PSI to identify which workloads are under pressure. For high-density Kubernetes nodes, PSI-based admission control prevents the runaway memory pressure spirals that traditional OOM kill policies cannot stop.
