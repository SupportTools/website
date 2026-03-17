---
title: "Linux Performance Profiling with perf: CPU Flamegraphs and Kernel Analysis"
date: 2028-03-19T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Profiling", "perf", "Flamegraphs", "Kernel", "Observability"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux performance profiling with perf, covering CPU flamegraph generation, off-CPU analysis, hardware counters, kernel probe points, container-aware profiling, and continuous profiling with Parca and Pyroscope."
more_link: "yes"
url: "/linux-performance-profiling-perf-guide/"
---

`perf` is the Swiss army knife of Linux performance analysis. Built directly into the kernel, it can profile CPU usage, track hardware performance counters, trace kernel and user-space function calls, and measure off-CPU blocking time—all with minimal overhead and without modifying application code. Combined with Brendan Gregg's flamegraph tooling, perf output becomes navigable visual representations of where CPU time is actually spent.

This guide covers perf basics, flamegraph generation workflow, off-CPU analysis, hardware counter profiling, dynamic kernel probes, container-aware profiling techniques, and continuous profiling integration with Parca and Pyroscope.

<!--more-->

## Installation and Kernel Requirements

```bash
# Debian/Ubuntu
apt-get install linux-perf linux-tools-$(uname -r) linux-tools-common

# RHEL/CentOS/Fedora
dnf install perf

# Verify version matches running kernel
perf version
# perf version 6.6.30

# Check available events
perf list

# Required kernel config (most production kernels have these enabled)
# CONFIG_PERF_EVENTS=y
# CONFIG_PERF_EVENTS_INTEL_UNCORE=y  (Intel)
# CONFIG_PERF_EVENTS_AMD_POWER=y     (AMD)
# CONFIG_FRAME_POINTER=y             (for user-space unwinding)
# CONFIG_KALLSYMS=y                  (kernel symbol resolution)
```

## Kernel Permissions for Production Systems

```bash
# Check current paranoia level (4 = max restriction, -1 = no restriction)
cat /proc/sys/kernel/perf_event_paranoid

# For comprehensive profiling (including kernel symbols)
# WARNING: reduces security boundary — review before applying in production
sysctl -w kernel.perf_event_paranoid=1

# For container profiling without root
sysctl -w kernel.perf_event_paranoid=-1

# Alternatively, grant specific capabilities to perf binary
setcap cap_perfmon,cap_sys_ptrace+ep /usr/bin/perf
```

## Basic CPU Profiling

```bash
# Profile a specific PID for 30 seconds
perf record -g -p <PID> -- sleep 30

# Profile all processes system-wide (-a) with call graph unwinding (--call-graph)
# dwarf unwinding is more accurate than frame-pointer for binaries without -fno-omit-frame-pointer
perf record -a -g --call-graph dwarf -F 99 -- sleep 30

# Profile a specific command
perf record -g --call-graph fp -- ./myapp --flag value

# Options reference:
# -g              include call graph (stack traces)
# -F 99           sample at 99 Hz (avoids lockstep with 100 Hz timers)
# --call-graph dwarf   use DWARF debug info for unwind tables
# --call-graph fp      use frame pointer (faster, requires -fno-omit-frame-pointer)
# -a              system-wide, all CPUs
# -e cpu-cycles   specify event (default is cpu-cycles)
```

### Reading Reports

```bash
# Interactive TUI report
perf report

# Flat report to stdout
perf report --stdio --no-children | head -50

# Report with symbol annotation
perf annotate --stdio --symbol=hot_function

# Show top functions sorted by overhead
perf report --stdio --sort=dso,symbol | head -30
```

## CPU Flamegraph Generation

Brendan Gregg's flamegraph scripts convert perf's folded stack output into interactive SVG visualizations.

```bash
# Clone flamegraph tools
git clone https://github.com/brendangregg/FlameGraph.git
export FLAMEGRAPH_DIR="$HOME/FlameGraph"

# Step 1: Record
perf record -F 99 -a -g --call-graph dwarf -- sleep 60

# Step 2: Convert perf.data to text
perf script > out.perf

# Step 3: Fold stacks
"${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" out.perf > out.folded

# Step 4: Generate SVG
"${FLAMEGRAPH_DIR}/flamegraph.pl" out.folded > flamegraph.svg

# Open in browser
xdg-open flamegraph.svg   # Linux desktop
# Or serve via HTTP for remote viewing
python3 -m http.server 8080
```

### Combined One-Liner

```bash
# Profile for 60 seconds and generate flamegraph
perf record -F 99 -a -g --call-graph dwarf -- sleep 60 && \
  perf script | "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" | \
  "${FLAMEGRAPH_DIR}/flamegraph.pl" > flamegraph-$(date +%Y%m%d-%H%M%S).svg
```

### Differential Flamegraph

Compare CPU usage before and after a change:

```bash
# Before change
perf record -F 99 -a -g -- sleep 60
perf script | "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" > before.folded

# After change (deploy new version)
perf record -F 99 -a -g -- sleep 60
perf script | "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" > after.folded

# Generate differential flamegraph
# Red = regression (more time), blue = improvement (less time)
"${FLAMEGRAPH_DIR}/difffolded.pl" before.folded after.folded | \
  "${FLAMEGRAPH_DIR}/flamegraph.pl" --colors=red --bgcolor=cream > diff.svg
```

## Off-CPU Analysis

Off-CPU time is when a thread is blocked waiting—on I/O, locks, sleep, or scheduling. CPU flamegraphs show only on-CPU work; off-CPU flamegraphs reveal blocking bottlenecks.

```bash
# Method 1: perf sched with context switch tracing
perf sched record -- sleep 30
perf sched latency | head -30  # Show per-task scheduling latency

# Method 2: Off-CPU flamegraph using scheduler trace points
# Requires kernel.perf_event_paranoid <= 0
perf record -e sched:sched_switch -a -g -- sleep 30
perf script | awk '
  /sched:sched_switch/ {
    if (prev_pid != 0) {
      print prev_stack " " $0
    }
    prev_pid = $NF
  }
' | "${FLAMEGRAPH_DIR}/flamegraph.pl" --title="Off-CPU" --colors=blue > offcpu.svg

# Method 3: BPF-based off-CPU with bcc (more accurate)
# pip install bcc
offcputime-bpfcc -f -p <PID> 30 > offcpu.folded
"${FLAMEGRAPH_DIR}/flamegraph.pl" --title="Off-CPU Flame Graph" \
  --colors=blue offcpu.folded > offcpu.svg
```

## Hardware Performance Counters

perf stat provides hardware-level metrics that expose microarchitectural behavior:

```bash
# Comprehensive hardware counter profile
perf stat -e \
  cycles,instructions,\
  cache-references,cache-misses,\
  branch-instructions,branch-misses,\
  L1-dcache-loads,L1-dcache-load-misses,\
  LLC-loads,LLC-load-misses \
  -p <PID> -- sleep 10

# Sample output interpretation:
# Performance counter stats for process id '1234':
#
#    10,523,891,234    cycles
#     8,234,567,890    instructions        #    0.78  insn per cycle
#       823,456,789    cache-references
#        82,345,678    cache-misses        #   10.00% of all cache refs
#     2,345,678,901    branch-instructions
#        23,456,789    branch-misses       #    1.00% of all branches
#
# IPC < 1.0 suggests memory/cache bound
# Cache miss > 5% suggests data access pattern issues
# Branch miss > 2% suggests unpredictable control flow
```

### Cache Profiling

```bash
# Identify which functions cause L3 cache misses
perf record -e LLC-load-misses -g -p <PID> -- sleep 30
perf report --stdio --sort=symbol | head -20

# Memory bandwidth analysis
perf stat -e \
  offcore_requests.all_data_rd,\
  offcore_requests_outstanding.all_data_rd \
  -p <PID> -- sleep 10

# CPU migration analysis (causes cache invalidation)
perf stat -e migrations -a -- sleep 10
```

### Branch Misprediction Analysis

```bash
# Find hottest mispredicting branches
perf record -e branch-misses -g -p <PID> -- sleep 30
perf report --stdio

# Annotate source to find mispredicting conditional
perf annotate --stdio --symbol=sort_function
```

## Kernel Probe Points with perf probe

Dynamic probes instrument kernel functions without recompiling:

```bash
# List available kernel probe points
perf probe -l

# Add a probe at kernel function entry
perf probe --add 'do_sys_openat2'
# Probe do_sys_openat2@fs/open.c:214

# Add a probe with argument capture
# Capture the filename argument from sys_openat
perf probe --add 'do_sys_openat2 filename:string'

# Record with the new probe
perf record -e probe:do_sys_openat2 -a -- sleep 10

# Show results
perf script | head -30

# Add a return probe to measure function duration
perf probe --add 'do_sys_openat2%return'

# Measure open() syscall latency
perf record -e probe:do_sys_openat2,probe:do_sys_openat2__return -a -- sleep 10
perf script | awk '
BEGIN { OFS="\t" }
/probe:do_sys_openat2 / { start[$5] = $4 }
/probe:do_sys_openat2__return/ {
  if ($5 in start) {
    latency = $4 - start[$5]
    printf "PID: %s  Latency: %.3f ms\n", $5, latency * 1000
    delete start[$5]
  }
}'

# Remove probe when done
perf probe --del 'probe:do_sys_openat2'
```

### User-Space Probes

```bash
# Probe a Go application function (requires debug symbols)
perf probe -x /usr/bin/myapp --add 'main.processRequest'

# Probe a C library function
perf probe -x /lib/x86_64-linux-gnu/libc.so.6 --add 'malloc size'

# Trace all malloc calls with size > 1MB
perf record -e probe_libc:malloc --filter 'size > 1048576' -a -- sleep 30
perf script | awk '$NF > 1048576 {print}' | head -20
```

## Container-Aware Profiling

### Profiling a Container by PID

```bash
# Find container PID on the host
CONTAINER_ID=$(docker ps --filter name=myapp --format '{{.ID}}')
HOST_PID=$(docker inspect ${CONTAINER_ID} --format '{{.State.Pid}}')

# Profile the container process (resolves host-namespace symbols)
perf record -F 99 -g --call-graph dwarf -p ${HOST_PID} -- sleep 30
perf report
```

### Using --cgroup Flag

```bash
# Profile all processes in a specific cgroup (Docker container)
CGROUP_PATH="/sys/fs/cgroup/system.slice/docker-$(docker inspect myapp --format '{{.Id}}').scope"

perf record -F 99 -g --cgroup=${CGROUP_PATH} -- sleep 30
perf script | "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" | \
  "${FLAMEGRAPH_DIR}/flamegraph.pl" > container-flamegraph.svg
```

### Profiling in Kubernetes Pods

Running perf inside a pod requires elevated privileges. The recommended approach is to profile from the node:

```bash
# Debug pod with perf — runs on the same node as target pod
kubectl debug -it --image=ubuntu:22.04 node/worker-node-01 -- bash

# Inside debug pod
apt-get install -y linux-tools-$(uname -r) linux-tools-common
sysctl kernel.perf_event_paranoid=1

# Find target pod's PID
TARGET_POD="order-service-7d9fc8c66-xkvwp"
TARGET_NS="production"
TARGET_PID=$(kubectl exec ${TARGET_POD} -n ${TARGET_NS} -- cat /proc/1/status | \
  grep NSpid | awk '{print $NF}')
# NSpid gives the host PID for the container's PID 1

# Profile from host perspective
perf record -F 99 -g --call-graph dwarf -p ${TARGET_PID} -- sleep 30
```

### Privileged Profiling DaemonSet

For environments requiring continuous profiling capability:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: perf-profiler
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: perf-profiler
  template:
    metadata:
      labels:
        app: perf-profiler
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists
      containers:
        - name: profiler
          image: registry.support.tools/perf-profiler:latest
          securityContext:
            privileged: true
          volumeMounts:
            - name: sys
              mountPath: /sys
            - name: proc
              mountPath: /proc
            - name: output
              mountPath: /var/profiler
      volumes:
        - name: sys
          hostPath:
            path: /sys
        - name: proc
          hostPath:
            path: /proc
        - name: output
          hostPath:
            path: /var/profiler
```

## Continuous Profiling with Parca

Parca is a Prometheus-inspired continuous profiling system that collects pprof profiles from applications and stores them in a time-series database for historical analysis.

```yaml
# parca-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: parca
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: parca
  template:
    metadata:
      labels:
        app: parca
    spec:
      containers:
        - name: parca
          image: ghcr.io/parca-dev/parca:v0.20.0
          args:
            - /parca
            - --config-path=/etc/parca/parca.yaml
          ports:
            - containerPort: 7070
          volumeMounts:
            - name: config
              mountPath: /etc/parca
      volumes:
        - name: config
          configMap:
            name: parca-config
```

```yaml
# parca-config ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: parca-config
  namespace: monitoring
data:
  parca.yaml: |
    object_storage:
      bucket:
        type: FILESYSTEM
        config:
          directory: /data

    scrape_configs:
      - job_name: order-service
        scrape_interval: 15s
        static_configs:
          - targets: [order-service.production.svc.cluster.local:6060]
        profiling_config:
          pprof_config:
            memory:
              enabled: true
              path: /debug/pprof/heap
            cpu:
              enabled: true
              path: /debug/pprof/profile
              delta: true
            goroutine:
              enabled: true
              path: /debug/pprof/goroutine
```

### Exposing pprof Endpoints in Go

```go
// main.go — add pprof HTTP endpoint
import (
	"net/http"
	_ "net/http/pprof"  // Side-effect import registers handlers
)

func main() {
	// Start pprof server on separate port
	go func() {
		log.Println(http.ListenAndServe("localhost:6060", nil))
	}()
	// ...
}

// Available endpoints:
// /debug/pprof/            — index
// /debug/pprof/profile     — 30s CPU profile
// /debug/pprof/heap        — heap allocation profile
// /debug/pprof/goroutine   — goroutine stack traces
// /debug/pprof/trace       — execution trace
```

## Continuous Profiling with Pyroscope

Pyroscope supports pull-based and push-based profiling for Go, Java, Python, Ruby, and eBPF-based system profiling:

```go
// Push-based profiling from a Go application
import "github.com/grafana/pyroscope-go"

func main() {
	profiler, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: "order-service",
		ServerAddress:   "http://pyroscope.monitoring.svc.cluster.local:4040",
		Tags: map[string]string{
			"region":      os.Getenv("REGION"),
			"environment": os.Getenv("ENVIRONMENT"),
			"version":     os.Getenv("APP_VERSION"),
		},
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileAllocSpace,
			pyroscope.ProfileInuseObjects,
			pyroscope.ProfileInuseSpace,
			pyroscope.ProfileGoroutines,
		},
	})
	if err != nil {
		log.Fatalf("pyroscope start: %v", err)
	}
	defer profiler.Stop()
	// ...
}
```

## perf in CI/CD for Regression Detection

```bash
#!/bin/bash
# perf-regression-check.sh
# Runs perf stat before/after a deployment and alerts on regression

set -euo pipefail

THRESHOLD=0.10  # 10% regression threshold

run_benchmark() {
  local label="$1"
  perf stat -x, -e cycles,instructions,cache-misses \
    -o "perf-${label}.stat" \
    ./benchmark --iterations 100000 2>&1
}

run_benchmark "before"
deploy_new_version
run_benchmark "after"

# Compare instruction counts
BEFORE=$(awk -F, '/instructions/{print $1}' perf-before.stat)
AFTER=$(awk -F, '/instructions/{print $1}' perf-after.stat)

DELTA=$(echo "scale=4; (${AFTER} - ${BEFORE}) / ${BEFORE}" | bc)
if (( $(echo "${DELTA} > ${THRESHOLD}" | bc -l) )); then
  echo "REGRESSION: instruction count increased by $(echo "${DELTA} * 100" | bc)%"
  exit 1
fi

echo "No regression detected (delta: $(echo "${DELTA} * 100" | bc)%)"
```

## Production Profiling Safety

```bash
# Estimate perf overhead before running on production
# Low-frequency sampling (99Hz) adds ~1-3% CPU overhead on busy systems
# Higher frequency (997Hz) can add 5-10% overhead

# Safe profiling workflow for production:
# 1. Start with low frequency and short duration
perf record -F 49 -g -p <PID> -- sleep 10

# 2. Increase if results are insufficient
perf record -F 99 -g -p <PID> -- sleep 30

# 3. Avoid --call-graph dwarf in production when possible
#    (dwarf unwinding copies significant stack memory per sample)
#    Prefer --call-graph fp for lower overhead

# 4. Use --no-buildid to skip buildid lookup (speeds up collection)
perf record -F 99 --no-buildid -g -p <PID> -- sleep 30
```

## Production Checklist

```
Setup
[ ] perf version matches running kernel (apt install linux-tools-$(uname -r))
[ ] kernel.perf_event_paranoid set appropriately for environment
[ ] FlameGraph scripts available and tested
[ ] Symbol files present for applications (debug packages or binaries with -g)

CPU Profiling
[ ] Applications compiled with -fno-omit-frame-pointer for efficient stack unwinding
  OR debug symbols available for DWARF unwinding
[ ] Go applications use GOTRACEBACK=all for goroutine visibility
[ ] Sample rate at 99Hz to avoid lockstep sampling artifacts

Continuous Profiling
[ ] pprof endpoints secured (bind to localhost or use AuthN middleware)
[ ] Parca or Pyroscope deployed and scraping production services
[ ] Grafana datasource configured for profiling correlation with traces
[ ] Profile retention policy set (typically 7-30 days)

Kubernetes
[ ] Privileged profiling DaemonSet available for on-demand node profiling
[ ] Container PID namespace mapping documented
[ ] cgroup hierarchy documented for targeted profiling
```

`perf` and flamegraphs transform performance investigation from guesswork to measurement. The ability to identify that 40% of CPU time is spent in a specific allocation path, then trace that path from a kernel probe to a user-space stack frame, fundamentally changes the quality of performance engineering decisions.
