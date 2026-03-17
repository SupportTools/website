---
title: "Linux Performance Analysis with perf: Flame Graphs, Hardware Counters, and Production Profiling"
date: 2031-06-26T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "perf", "Flame Graphs", "Profiling", "Observability", "System Administration"]
categories:
- Linux
- Performance
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux perf for production performance analysis: CPU profiling with flame graphs, hardware performance counters, memory access analysis, cache miss investigation, and safe profiling on live systems."
more_link: "yes"
url: "/linux-performance-analysis-perf-flame-graphs-hardware-counters-production-profiling/"
---

`perf` is the Linux kernel's built-in performance analysis tool, leveraging hardware performance counters (PMUs), tracepoints, and kprobes/uprobes to provide low-overhead profiling of production systems. Unlike application-level profilers that require code modification, `perf` can profile any process — including the kernel itself — with statistical sampling overhead typically below 1% CPU.

This guide covers the complete perf workflow for production environments: CPU profiling and flame graph generation, hardware counter analysis for cache and branch misprediction investigation, memory access profiling, tracepoint-based I/O analysis, and the kernel configuration prerequisites that are often missing in cloud instances.

<!--more-->

# Linux Performance Analysis with perf: Flame Graphs, Hardware Counters, and Production Profiling

## Installation and Prerequisites

```bash
# Install perf (matches running kernel version)
apt-get install -y linux-tools-$(uname -r) linux-tools-common  # Debian/Ubuntu
dnf install -y perf                                             # RHEL/Rocky

# Verify version matches kernel
perf --version
uname -r

# Install additional debugging symbols (optional but improves symbol resolution)
apt-get install -y linux-image-$(uname -r)-dbg  # Debian
debuginfo-install kernel-$(uname -r)             # RHEL
```

### Kernel Configuration for Production Profiling

```bash
# Check required kernel parameters
cat /proc/sys/kernel/perf_event_paranoid
# -1: allow all (too permissive for production)
#  0: allow all user-space profiling
#  1: allow CPU events for non-root (default on most distros)
#  2: disallow raw tracepoints for non-root (Debian default)
#  3: disallow all for non-root (some hardened configs)

# For production profiling as root, paranoid level doesn't matter
# For non-root profiling:
echo 0 > /proc/sys/kernel/perf_event_paranoid  # Temporary
# OR persistent:
echo 'kernel.perf_event_paranoid = 1' >> /etc/sysctl.conf
sysctl -p

# Enable hardware performance counters check
cat /proc/sys/kernel/kptr_restrict
# 0: exposed kernel pointers (needed for symbol resolution)
# 1: hidden from non-privileged (default)
# 2: always hidden
echo 0 > /proc/sys/kernel/kptr_restrict   # For profiling session

# Check if PMU is accessible in virtualized environments
ls /sys/devices/cpu/type  2>/dev/null && echo "PMU available" || echo "PMU not available"

# Cloud instances (AWS, GCP) may need:
# AWS: Enable "Detailed Monitoring" and check if instance type supports PMU
# GCP: Use e2-standard or n2 instances (n1 lacks PMU)
```

### Frame Pointer vs DWARF Unwinding

Frame pointer unwinding is significantly faster but requires binaries compiled with `-fno-omit-frame-pointer`. Modern distros often compile without frame pointers:

```bash
# Check if Go binary has frame pointers (Go always includes them)
file /usr/bin/myapp
objdump -d /usr/bin/myapp | grep -E "push.*rbp" | head -3

# Check if a C binary has frame pointers
objdump -d /usr/bin/nginx | grep "push   %rbp" | head -3

# For binaries without frame pointers, use DWARF unwinding (slower but accurate)
perf record --call-graph dwarf ...

# Or use LBR (Last Branch Record) on Intel — fast but shallow (32 frames)
perf record --call-graph lbr ...
```

## Basic CPU Profiling

### System-Wide Profiling

```bash
# Profile all CPUs for 30 seconds at 999Hz
# (999Hz avoids aliasing with 1000Hz timer interrupts)
perf record \
  -F 999 \
  -a \
  --call-graph fp \
  -o /tmp/perf.data \
  -- sleep 30

# Show text summary
perf report --stdio -n --percent-limit 1 | head -100

# Interactive TUI (navigate with arrow keys)
perf report -i /tmp/perf.data
```

### Per-Process Profiling

```bash
# Profile a specific PID
PID=$(pgrep nginx | head -1)
perf record \
  -F 999 \
  -p ${PID} \
  --call-graph fp \
  -g \
  -o /tmp/nginx-perf.data \
  -- sleep 30

# Profile a Go application (Go binaries always have frame pointers)
perf record \
  -F 999 \
  -p $(pgrep myapp) \
  --call-graph fp \
  -- sleep 60
```

### Profiling a Command from Start

```bash
# Profile the entire execution of a command
perf record \
  -F 999 \
  --call-graph dwarf \
  -- /usr/bin/myapp --some-flag

# Profile with child processes
perf record \
  -F 999 \
  --call-graph fp \
  --inherit \
  -- make -j8 all
```

## Flame Graph Generation

Flame graphs were invented by Brendan Gregg and are the most effective visualization for CPU profiling data. Each horizontal block represents a stack frame; width represents time spent.

### With FlameGraph Scripts

```bash
# Install FlameGraph
git clone https://github.com/brendangregg/FlameGraph /opt/FlameGraph

# Collect profile
perf record \
  -F 999 \
  -a \
  --call-graph fp \
  -- sleep 60

# Generate flame graph
perf script | \
  /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl \
    --color=hot \
    --title="CPU Profile - $(hostname) - $(date)" \
    --width=1600 \
    > /tmp/flamegraph.svg

# Open in browser
scp /tmp/flamegraph.svg your-workstation:/tmp/
```

### Differential Flame Graph (Before vs After)

```bash
# Profile before optimization
perf record -F 999 -a --call-graph fp -o before.data -- sleep 60
perf script -i before.data | /opt/FlameGraph/stackcollapse-perf.pl > before.folded

# Apply fix and profile after
perf record -F 999 -a --call-graph fp -o after.data -- sleep 60
perf script -i after.data | /opt/FlameGraph/stackcollapse-perf.pl > after.folded

# Generate differential flame graph (blue = faster, red = slower)
/opt/FlameGraph/difffolded.pl before.folded after.folded | \
  /opt/FlameGraph/flamegraph.pl \
    --title="Differential: After vs Before" \
    --negate \
    > diff.svg
```

### Flame Graph for Go Applications

Go requires special handling because goroutines use segmented stacks:

```bash
# Method 1: perf with fp (Go always includes frame pointers)
perf record -F 99 -p $(pgrep my-go-app) --call-graph fp -- sleep 30
perf script | /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl > go-flamegraph.svg

# Method 2: pprof with perf (better goroutine awareness)
# In your Go application, expose pprof
import _ "net/http/pprof"
go http.ListenAndServe(":6060", nil)

# Collect pprof CPU profile
go tool pprof -seconds=30 http://localhost:6060/debug/pprof/profile

# Generate flame graph from pprof
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile
# Navigate to "Flame Graph" view in browser
```

## Hardware Performance Counters

Hardware counters provide cycle-accurate measurement of processor events: cache misses, branch mispredictions, instruction counts, and more.

### Listing Available Events

```bash
# List all hardware events
perf list hardware

# List software events (kernel-level)
perf list software

# List hardware cache events
perf list cache

# List tracepoints (kernel events)
perf list tracepoint | head -50

# List PMU events for your specific CPU
perf list pmu | head -30

# Check available CPU-specific events
perf list | grep -E "cache|branch|tlb|mem" | head -20
```

### Counting Events with perf stat

```bash
# Basic stats for a command
perf stat \
  --event cycles,instructions,cache-misses,cache-references,branch-misses,branches \
  -- /usr/bin/myapp --benchmark

# System-wide stats for 10 seconds
perf stat \
  -a \
  --event cycles,instructions,cache-misses,cache-references \
  -- sleep 10

# Per-CPU stats
perf stat \
  -a --per-core \
  --event cycles,instructions,ipc \
  -- sleep 5

# Repeat measurement 5 times for statistical stability
perf stat \
  --repeat 5 \
  --event cycles,instructions \
  -- /usr/bin/myapp
```

Example output and interpretation:

```
Performance counter stats for './database-query':

      8,532,651,234      cycles                    # 3.412 GHz
     12,847,332,567      instructions              # 1.51  insn per cycle
      1,234,567,890      cache-references
        987,654,321      cache-misses              # 79.99% of all cache refs  ← PROBLEM
        456,789,012      branches
         98,765,432      branch-misses             # 21.62% of all branches    ← PROBLEM

       2.500542348 seconds time elapsed

# Healthy IPC: 2.0-4.0 (modern superscalar CPU)
# Cache miss rate > 10%: investigate data access patterns
# Branch miss rate > 5%: investigate conditional logic
```

### Investigating Cache Performance

```bash
# Detailed cache hierarchy analysis
perf stat \
  --event L1-dcache-loads,L1-dcache-load-misses,\
L1-dcache-stores,L1-dcache-store-misses,\
L2-dcache-load-misses,LLC-loads,LLC-load-misses \
  -- /usr/bin/myapp

# Cache miss flame graph (requires perf record with cache events)
perf record \
  -e LLC-load-misses \
  --call-graph fp \
  -c 1000 \
  -- /usr/bin/myapp

perf script | /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl \
    --color=mem \
    --title="LLC Cache Miss Flame Graph" \
    > cache-miss-flamegraph.svg
```

### Branch Misprediction Analysis

```bash
# Profile branch mispredictions
perf record \
  -e branch-misses \
  --call-graph fp \
  -c 100 \
  -- /usr/bin/myapp

perf report --stdio | head -50

# Annotate hot functions with branch miss counts
perf annotate --stdio -i perf.data | head -100
```

## Memory Access Profiling

### PEBS (Precise Event-Based Sampling)

Intel's PEBS provides precise attribution of cache misses to specific load/store instructions:

```bash
# Record memory load samples (requires Intel CPU with PEBS)
perf record \
  -e cpu/mem-loads,ldlat=30/P \
  --call-graph fp \
  -a \
  -- sleep 30

# Report with memory-specific columns
perf mem report --type=load --stdio -n | head -50
```

### Memory Bandwidth

```bash
# Measure memory bandwidth using perf stat
perf stat \
  --event uncore_imc/cas_count_read/,uncore_imc/cas_count_write/ \
  -- sleep 5
# Output shows bytes transferred through memory controller

# Alternative: use Intel PCM or AMD equivalent
# Or bandwidth estimation from LLC misses:
# bandwidth ≈ LLC_misses × 64 bytes (cache line size) / time
```

### TLB Miss Analysis

```bash
perf stat \
  --event dTLB-loads,dTLB-load-misses,dTLB-store-misses,iTLB-loads,iTLB-load-misses \
  -- /usr/bin/myapp

# High TLB miss rates suggest:
# 1. Large working sets (use huge pages)
# 2. Scattered memory access patterns (improve data locality)
# 3. Insufficient TLB entries for workload

# Enable huge pages to reduce TLB pressure
# For anonymous memory:
echo always > /sys/kernel/mm/transparent_hugepage/enabled

# For specific allocations in Go:
# Use GOGC tuning to reduce GC pressure on TLB
```

## Tracepoint-Based Analysis

Tracepoints are kernel-defined instrumentation points for tracking I/O, scheduling, and system calls.

### System Call Analysis

```bash
# Count system calls by type
perf stat \
  --event 'syscalls:sys_enter_*' \
  -a \
  -- sleep 5

# Profile read/write syscalls specifically
perf record \
  -e syscalls:sys_enter_read,syscalls:sys_enter_write \
  --call-graph fp \
  -a \
  -- sleep 10

perf script | sort | uniq -c | sort -rn | head -20
```

### Block I/O Tracing

```bash
# Trace block I/O events
perf record \
  -e block:block_rq_issue,block:block_rq_complete \
  -a \
  -- sleep 10

# Generate I/O latency analysis
perf script | awk '
/block_rq_issue/ { split($0, a, " "); start[a[5]] = $NF }
/block_rq_complete/ { split($0, a, " "); if (a[5] in start) {
    latency = $NF - start[a[5]];
    printf "LATENCY %s %.6f\n", a[5], latency;
    delete start[a[5]]
}}' | sort -k2 -n | tail -20

# BCC/bpftrace alternative for I/O analysis (more powerful)
# biolatency - I/O latency histogram
/usr/share/bcc/tools/biolatency -D 10
```

### Scheduler Analysis

```bash
# Profile context switches and wakeup latency
perf record \
  -e sched:sched_switch,sched:sched_wakeup \
  -a \
  --call-graph fp \
  -- sleep 10

# sched stats report
perf sched record -- sleep 10
perf sched latency | head -30

# Example output:
# Task                  |   Runtime ms  | Switches | Average delay ms | Maximum delay ms
# go-app:1234           |      892.000  |     1234 |           0.012  |           1.234
# nginx:5678            |      456.000  |      567 |           0.008  |           0.456
```

## perf diff and Annotation

### Comparing Two Profiles

```bash
# Profile version 1
perf record -F 999 -a --call-graph fp -o v1.data -- sleep 60

# Deploy version 2, profile again
perf record -F 999 -a --call-graph fp -o v2.data -- sleep 60

# Compare
perf diff v1.data v2.data

# Output shows functions that got faster or slower
# +15.23%  /usr/bin/myapp  [myapp]  process_request    ← Slower (regression)
# -8.45%   /usr/bin/myapp  [myapp]  parse_json         ← Faster (improvement)
```

### Source Code Annotation

```bash
# Annotate source if debugging symbols are available
# For Go: build with -gcflags="-N -l" to disable inlining
perf record -F 999 -p $(pgrep myapp) --call-graph fp -- sleep 30

# Annotate in TUI
perf annotate -i perf.data

# Annotate specific symbol
perf annotate -s processOrder --stdio -i perf.data | head -80

# Example output:
# Percent |      Source code & Disassembly of myapp for processOrder
# --------+--------------------------------------------------------------
#   23.4  :  /app/order.go:145    validateItems()
#    8.1  :  /app/order.go:156    calculateTotal()
#   45.2  :  /app/order.go:162    applyDiscounts()    ← Hot path
```

## Production Profiling Safety

### Low-Overhead Production Setup

```bash
# For production, use lower sampling frequency
# 99Hz = ~0.1% overhead per CPU
perf record \
  -F 99 \
  -a \
  --call-graph fp \
  --overwrite \
  --switch-output=signal \
  -o /tmp/perf.data \
  -- sleep 300 &

PERF_PID=$!

# You can trigger dump on demand: send SIGUSR2 to perf process
# kill -USR2 ${PERF_PID}

# Or use continuous profiling mode
```

### Continuous Profiling with perf

```bash
# Rotate profile every 60 seconds, keep last 5
while true; do
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  perf record \
    -F 99 \
    -a \
    --call-graph fp \
    -o /var/perf/${TIMESTAMP}.data \
    -- sleep 60

  # Convert immediately for analysis
  perf script -i /var/perf/${TIMESTAMP}.data | \
    /opt/FlameGraph/stackcollapse-perf.pl | \
    /opt/FlameGraph/flamegraph.pl \
      > /var/perf/${TIMESTAMP}.svg

  # Clean up old files (keep last 5)
  ls -t /var/perf/*.data | tail -n +6 | xargs rm -f
  ls -t /var/perf/*.svg | tail -n +6 | xargs rm -f
done
```

### Profiling in Containers and Kubernetes

```bash
# Profile a process inside a container
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' my-container)
perf record \
  -F 99 \
  -p ${CONTAINER_PID} \
  --call-graph fp \
  -- sleep 30

# For Kubernetes pods
NODE=$(kubectl get pod my-pod -o jsonpath='{.spec.nodeName}')
CONTAINER_ID=$(kubectl get pod my-pod -o jsonpath='{.status.containerStatuses[0].containerID}')

# SSH to node and profile
ssh ${NODE}
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' ${CONTAINER_ID##docker://})
perf record -F 99 -p ${CONTAINER_PID} --call-graph fp -- sleep 30
```

### Privileged Profiling DaemonSet

```yaml
# For cluster-wide profiling on Kubernetes
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
    spec:
      tolerations:
        - operator: Exists
      hostPID: true
      hostNetwork: true
      containers:
        - name: profiler
          image: your-registry/perf-tools:latest
          securityContext:
            privileged: true
          volumeMounts:
            - name: host-sys
              mountPath: /sys
            - name: profiles
              mountPath: /var/perf
          command:
            - /bin/sh
            - -c
            - |
              while true; do
                TIMESTAMP=$(date +%Y%m%d-%H%M%S)
                perf record -F 99 -a --call-graph fp \
                  -o /var/perf/${TIMESTAMP}.data -- sleep 60
                perf script -i /var/perf/${TIMESTAMP}.data | \
                  stackcollapse-perf.pl | flamegraph.pl \
                  > /var/perf/${TIMESTAMP}.svg
                find /var/perf -name "*.data" -mmin +60 -delete
                find /var/perf -name "*.svg" -mmin +360 -delete
              done
      volumes:
        - name: host-sys
          hostPath:
            path: /sys
        - name: profiles
          hostPath:
            path: /var/perf
```

## Interpreting Results

### Common Flame Graph Patterns

**Wide plateau at the top**: Single function consuming significant CPU. Optimize this function first.

**Tall narrow spike**: Deep call chain, but most time is at the leaf. The leaf function is the actual bottleneck.

**Multiple equal-height towers**: Parallel execution across threads — this is usually healthy.

**Flat top with many small towers**: Many small functions consuming equal time — may indicate excessive function call overhead or lock contention.

**Kernel functions dominant (k_ prefix)**: I/O bound or system call heavy. Reduce I/O or batch syscalls.

### Cache Analysis Interpretation

```bash
# Quick analysis script
perf stat -e cycles,instructions,cache-misses,cache-references -- /usr/bin/myapp 2>&1 | \
  awk '
  /instructions/ { instr = $1 }
  /cycles/       { cycles = $1 }
  /cache-misses/ && /of all/ { miss_pct = $4+0 }
  END {
    ipc = instr / cycles
    printf "IPC: %.2f (healthy: 2.0-4.0)\n", ipc
    printf "Cache miss rate: %.1f%% (healthy: <5%%)\n", miss_pct
    if (ipc < 1.0) print "WARNING: Low IPC — check for memory stalls or branch mispredictions"
    if (miss_pct > 10) print "WARNING: High cache miss rate — check data locality and working set size"
  }'
```

## Useful perf Idioms

```bash
# Find the single hottest function across all processes
perf top --sort=dso,symbol

# Profile network stack
perf record -e net:net_dev_xmit,net:netif_receive_skb -a -- sleep 10
perf script | sort | uniq -c | sort -rn | head

# Profile lock contention (needs lockdep in kernel)
perf lock record -- /usr/bin/myapp
perf lock report --key=wait --sort=wait_total

# Profile kernel functions (requires kernel debug symbols)
perf record -F 999 -a --call-graph fp -e cycles:k -- sleep 30
perf report --dsos='[kernel.kallsyms]'

# Off-CPU analysis (find time threads are blocked, not scheduled)
# Requires perf + offcputime script from BCC
perf record -e sched:sched_switch -a --call-graph fp -- sleep 30
```

`perf` is the most powerful performance investigation tool available on Linux. The workflow of: collect a CPU profile, generate a flame graph, identify the hot path, apply a fix, verify with a differential flame graph — can compress a multi-day performance investigation into a few hours. Combined with hardware counter analysis to identify the root cause of slowdowns (cache misses, branch mispredictions, memory bandwidth), it provides actionable data that cannot be obtained from any higher-level profiling tool.
