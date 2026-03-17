---
title: "Linux perf for Kubernetes Workloads: CPU Profiling, Flamegraphs, and Hardware Counters Inside Containers"
date: 2028-06-21T00:00:00-05:00
draft: false
tags: ["Linux", "perf", "Profiling", "Kubernetes", "Performance", "Flamegraph", "Hardware Counters"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Linux perf for Kubernetes workloads: perf stat and record/report workflows, flamegraph generation, hardware performance counter analysis, profiling inside containers, and interpreting CPU stall and branch prediction data."
more_link: "yes"
url: "/linux-perf-profiling-kubernetes-guide/"
---

Linux `perf` is the most powerful performance analysis tool available on Linux systems, providing access to hardware performance counters, software events, and kernel tracepoints that no other tool can match. While Go's pprof and Java's async-profiler work within language runtimes, perf operates at the OS level — it sees everything: kernel code, library calls, JIT-compiled code, and hardware microarchitecture behavior like cache misses and branch mispredictions.

For Kubernetes workloads, `perf` answers questions that application-level profilers cannot: why is this container consuming CPU even when it appears idle? What percentage of CPU time is spent waiting for memory? Which kernel functions are causing scheduling latency? This guide covers perf in the context of Kubernetes — both profiling containers from the host and using privileged debug containers for investigation.

<!--more-->

## Understanding Linux perf

### Event Types

`perf` can sample four categories of events:

**Hardware events** (CPU performance counters):
- `cpu-cycles`: CPU clock cycles consumed
- `instructions`: Instructions executed
- `cache-references`: L1/L2/L3 cache lookups
- `cache-misses`: Cache lookups that went to main memory
- `branch-instructions`: Total branch instructions
- `branch-misses`: Branch predictions that were wrong
- `bus-cycles`: Memory bus cycles
- `stalled-cycles-frontend`: Cycles stalled waiting for instruction fetch
- `stalled-cycles-backend`: Cycles stalled waiting for execution units

**Software events** (kernel counters):
- `context-switches`: Process context switch count
- `cpu-migrations`: Process migrated between CPUs
- `page-faults`: Memory page fault count
- `major-faults`: Page faults requiring disk I/O

**Tracepoint events**: Kernel static instrumentation points (thousands available)

**Dynamic probes**: uprobes/kprobes — instrumentation inserted at runtime

### perf Tool Prerequisites

```bash
# Install perf on Debian/Ubuntu
apt-get install linux-perf linux-tools-$(uname -r)

# Install on RHEL/CentOS
yum install perf

# Check perf is working
perf stat ls

# List available events
perf list | head -50

# Check access permissions
# perf requires either root or specific kernel capabilities
# /proc/sys/kernel/perf_event_paranoid controls access:
# -1: All events available to unprivileged users
#  0: Disallow raw/system-wide access to kernel counters
#  1: Kernel events disabled for unprivileged users (default on many distros)
#  2: Disable user-space perf (most restrictive)

cat /proc/sys/kernel/perf_event_paranoid
# If > 0 and not root, many perf commands require --no-inherit or will fail

# Set for profiling session (reverts on reboot)
sysctl -w kernel.perf_event_paranoid=1
```

## Basic perf Workflows

### perf stat — Counting Events

`perf stat` provides a summary of hardware counter values for a command or PID:

```bash
# Profile a command for its entire duration
perf stat ./my-binary --args

# Attach to a running process
perf stat -p 12345 sleep 30

# Extended statistics with specific events
perf stat -e cycles,instructions,cache-misses,cache-references,branch-misses \
  -p $(pgrep my-service) \
  sleep 60

# System-wide statistics (all CPUs, all processes)
perf stat -a sleep 10

# Per-CPU statistics
perf stat -a --per-cpu sleep 10 | grep "CPU"
```

Sample output interpretation:

```
 Performance counter stats for 'process 12345':

        48,234,123,456  cycles                    #    3.2 GHz
        32,156,789,012  instructions              #    0.67  insn per cycle
         4,231,456,789  cache-references          # 281.4 M/sec
           812,345,678  cache-misses              #   19.2% of all cache refs
           289,456,123  branch-misses             #    2.1% of all branches
         3,421,567,890  stalled-cycles-frontend   #   12.3% frontend cycles idle
        12,345,678,901  stalled-cycles-backend    #   44.2% backend cycles idle

Key metrics:
- instructions per cycle (IPC) = 0.67 → LOW (modern CPUs expect 2-4)
  This indicates heavy memory latency stalls or serial dependency chains

- cache-miss rate = 19.2% → HIGH (< 5% is generally good)
  The workload is frequently going to main memory — likely pointer chasing

- stalled-cycles-backend = 44.2% → CRITICAL
  Nearly half of all CPU time is stalled waiting for memory or execution units
  This is a memory bandwidth or cache efficiency problem
```

### perf record — Sampling for Flamegraphs

`perf record` samples the call stack at intervals and writes data to `perf.data`:

```bash
# Record CPU profiling for 30 seconds
# -g: enable call graph (stack traces)
# -F 99: sample at 99 Hz (avoids harmonic with 100Hz system timers)
perf record -g -F 99 -p $(pgrep my-service) -- sleep 30

# System-wide recording (all CPUs, all processes)
perf record -g -F 99 -a -- sleep 30

# Record specific events with call graphs
perf record -e cpu-cycles,cache-misses -g -F 99 -p 12345 -- sleep 30

# Record with dwarf call graph (better for Go/Rust/C++, but larger files)
perf record --call-graph dwarf -F 99 -p 12345 -- sleep 30

# Record with frame pointer call graph (requires binary compiled with -fno-omit-frame-pointer)
perf record --call-graph fp -F 99 -p 12345 -- sleep 30
```

### perf report — Analyzing Data

```bash
# Interactive TUI report
perf report

# Text report (top functions by self time)
perf report --stdio --no-header -n -g none | head -40

# Show call graph in text mode
perf report --stdio --call-graph fractal,0.5 | head -100

# Sort by different metrics
perf report --sort=comm,dso,symbol

# Filter to specific process/thread
perf report --comm=my-service

# Show annotated source (requires debug symbols)
perf annotate functionName
```

## Flamegraph Generation

### Using Brendan Gregg's Flamegraph Scripts

```bash
# Install flamegraph scripts
git clone https://github.com/brendangregg/FlameGraph.git /opt/flamegraph

# Record CPU profile
perf record -g -F 99 -p $(pgrep payment-api) -- sleep 60

# Generate flamegraph
perf script | \
  /opt/flamegraph/stackcollapse-perf.pl | \
  /opt/flamegraph/flamegraph.pl \
    --title "payment-api CPU Profile" \
    --width 1600 \
    > /tmp/payment-api-flamegraph.svg

# View in browser
# The SVG is interactive — click to zoom, search for function names
```

### Differential Flamegraphs

Compare performance before and after a change:

```bash
# Capture baseline (before deployment)
perf record -g -F 99 -p $(pgrep payment-api) -- sleep 60
mv perf.data perf-before.data

# Deploy change...

# Capture after deployment
perf record -g -F 99 -p $(pgrep payment-api) -- sleep 60
mv perf.data perf-after.data

# Generate collapsed stacks for both
perf script -i perf-before.data | \
  /opt/flamegraph/stackcollapse-perf.pl > before.folded

perf script -i perf-after.data | \
  /opt/flamegraph/stackcollapse-perf.pl > after.folded

# Generate differential flamegraph
# Blue = reduced time, Red = increased time
/opt/flamegraph/difffolded.pl before.folded after.folded | \
  /opt/flamegraph/flamegraph.pl \
    --title "Differential: After vs Before" \
    --negate \
    > diff-flamegraph.svg
```

### Off-CPU Flamegraphs

CPU flamegraphs show time on-CPU. Off-CPU flamegraphs show time waiting (blocking on I/O, locks, sleep):

```bash
# Record scheduling events for off-CPU analysis
# This requires root or CAP_SYS_ADMIN
perf record -e sched:sched_stat_sleep,sched:sched_switch \
  -p $(pgrep payment-api) \
  -- sleep 60

# Generate off-CPU flamegraph using BPF (more reliable)
# Requires bcc-tools
/usr/share/bcc/tools/offcputime -p $(pgrep payment-api) 60 | \
  /opt/flamegraph/flamegraph.pl \
    --title "Off-CPU Time" \
    --color io \
    --countname us \
    > offcpu-flamegraph.svg
```

## Profiling Kubernetes Workloads

### Method 1: Profile from the Node (Most Capabilities)

```bash
# SSH to the node running the target container
kubectl get pod payment-api-7d4f9b6c8-xkj2p -n production \
  -o jsonpath='{.spec.nodeName}'
# node-worker-03

ssh node-worker-03

# Find the container's main process PID
CONTAINER_ID=$(crictl ps --name payment-api -q | head -1)
PID=$(crictl inspect ${CONTAINER_ID} | jq '.info.pid')
echo "Container PID: ${PID}"

# Profile the container process
perf record -g -F 99 -p ${PID} -- sleep 60

# Generate flamegraph
perf script | \
  /opt/flamegraph/stackcollapse-perf.pl | \
  /opt/flamegraph/flamegraph.pl > /tmp/flamegraph.svg

# Copy to local machine
kubectl cp kube-system/$(kubectl get pod -n kube-system -l app=debug -o name | head -1):/tmp/flamegraph.svg ./flamegraph.svg
```

### Method 2: Privileged Debug Container

Use ephemeral containers for non-intrusive profiling:

```bash
# Add a privileged debug container to a running Pod
kubectl debug -it payment-api-7d4f9b6c8-xkj2p \
  -n production \
  --image=ubuntu:22.04 \
  --target=payment-api \
  -- bash

# Inside the debug container:
# Install perf
apt-get update && apt-get install -y linux-perf linux-tools-$(uname -r) 2>/dev/null || \
  apt-get install -y linux-perf

# The --target flag shares the process namespace
# Find the main process
ls /proc/*/exe 2>/dev/null | head -20

# Profile using the shared PID namespace
PID=$(pgrep -f payment-api | head -1)
perf record -g -F 99 -p ${PID} -- sleep 30

# Generate and send flamegraph
apt-get install -y git
git clone --depth=1 https://github.com/brendangregg/FlameGraph.git /opt/flamegraph

perf script | \
  perl /opt/flamegraph/stackcollapse-perf.pl | \
  perl /opt/flamegraph/flamegraph.pl > /tmp/flamegraph.svg

# Exit and copy from pod
exit
kubectl cp production/payment-api-7d4f9b6c8-xkj2p:/tmp/flamegraph.svg ./flamegraph.svg \
  -c debugger
```

### Method 3: DaemonSet Profiler

For systematic profiling across all nodes, deploy a privileged profiler DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: perf-profiler
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: perf-profiler
  template:
    metadata:
      labels:
        app: perf-profiler
    spec:
      hostPID: true        # See host process IDs
      hostNetwork: true    # Access host network for data export
      tolerations:
      - operator: Exists
      containers:
      - name: profiler
        image: ubuntu:22.04
        command: ["/bin/bash", "-c", "sleep infinity"]
        securityContext:
          privileged: true  # Required for perf
        volumeMounts:
        - name: host-sys
          mountPath: /sys
        - name: host-proc
          mountPath: /proc
        - name: output
          mountPath: /output
        resources:
          requests:
            cpu: "100m"
            memory: "256Mi"
          limits:
            cpu: "2"
            memory: "512Mi"
      volumes:
      - name: host-sys
        hostPath:
          path: /sys
      - name: host-proc
        hostPath:
          path: /proc
      - name: output
        hostPath:
          path: /tmp/perf-output
          type: DirectoryOrCreate
```

### Enabling Frame Pointers for Better Stack Traces

Go binaries include frame pointers by default since Go 1.7. Other languages may need special compilation:

```bash
# Go: frame pointers enabled by default
# Verify with:
go build -gcflags="-S" ./cmd/myservice | grep "fp"

# C/C++: compile with -fno-omit-frame-pointer
gcc -O2 -fno-omit-frame-pointer myapp.c -o myapp

# Rust: enable frame pointers in Cargo.toml
[profile.release]
debug = true
# Or environment variable:
# RUSTFLAGS="-C force-frame-pointers=yes" cargo build --release

# Java/JVM: add JVM flag
# -XX:+PreserveFramePointer
```

## Hardware Performance Counter Analysis

### CPU Stall Analysis

```bash
# Comprehensive stall analysis
perf stat -e \
  cycles,\
  instructions,\
  stalled-cycles-frontend,\
  stalled-cycles-backend,\
  cache-misses,\
  cache-references,\
  LLC-load-misses,\
  LLC-loads \
  -p $(pgrep payment-api) \
  sleep 60

# Calculate derived metrics from output:
# IPC = instructions / cycles (want > 1.0, ideally 2-4)
# Frontend stall % = stalled-cycles-frontend / cycles * 100
# Backend stall % = stalled-cycles-backend / cycles * 100
# LLC miss rate = LLC-load-misses / LLC-loads * 100

# Frontend stalls indicate:
# - Instruction cache misses
# - Branch prediction misses
# - Fetch bandwidth limitations

# Backend stalls indicate:
# - Data cache misses (memory latency)
# - Memory bandwidth saturation
# - Execution unit conflicts (FP, integer divides)
```

### Memory Hierarchy Analysis

```bash
# Analyze memory access patterns across cache hierarchy
perf stat -e \
  L1-dcache-loads,\
  L1-dcache-load-misses,\
  L2-loads,\
  L2-load-misses,\
  LLC-loads,\
  LLC-load-misses \
  -p $(pgrep payment-api) \
  sleep 30

# Typical healthy cache hierarchy:
# L1 miss rate:  < 5%
# L2 miss rate:  < 20%
# LLC miss rate: < 10%
#
# High LLC miss rate with many LLC-loads indicates:
# - Working set > LLC size (need more cache)
# - Poor cache locality (data structure traversal patterns)
# - NUMA imbalance (accessing remote memory)
```

### Branch Prediction Analysis

```bash
perf stat -e \
  branch-instructions,\
  branch-misses,\
  branch-load-misses,\
  branch-loads \
  -p $(pgrep payment-api) \
  sleep 30

# Branch miss rate > 5% indicates:
# - Unpredictable conditional branches (common in validation code)
# - Switch statements with many cases
# - Virtual function dispatch patterns
# - Potential for Profile-Guided Optimization (PGO)
```

### TLB Miss Analysis

```bash
perf stat -e \
  iTLB-loads,\
  iTLB-load-misses,\
  dTLB-loads,\
  dTLB-load-misses \
  -p $(pgrep payment-api) \
  sleep 30

# High dTLB-load-misses indicates:
# - Large memory footprint with scattered access patterns
# - Consider: HugePage usage to reduce TLB pressure
#   echo "vm.nr_hugepages = 128" >> /etc/sysctl.d/99-hugepages.conf
#   sysctl -p
```

## Advanced perf Techniques

### Tracepoint Recording

```bash
# Record all system calls made by a process
perf record -e syscalls:sys_enter_* -p $(pgrep payment-api) -- sleep 10
perf report --stdio | head -30

# Track memory allocation patterns via tracepoints
perf record -e \
  kmem:kmalloc,\
  kmem:kfree,\
  kmem:mm_page_alloc,\
  kmem:mm_page_free \
  -p $(pgrep payment-api) -- sleep 5

perf report --stdio | grep "kmalloc" | head -20

# Track network events
perf record -e \
  net:netif_rx,\
  net:net_dev_xmit,\
  skb:kfree_skb \
  -- sleep 10

perf report --stdio | head -20
```

### Scheduler Latency Analysis

```bash
# Record scheduling events to measure scheduling latency
perf sched record -p $(pgrep payment-api) -- sleep 30

# Analyze scheduling latency statistics
perf sched latency | head -30

# Output includes per-thread scheduling statistics:
# Task                    |   Runtime ms  | Switches | Average delay ms | Maximum delay ms
# payment-api:(8)         |   15234.456   |   12456  |          0.123  |          45.234

# High "Maximum delay ms" indicates scheduling latency spikes
# that could cause request latency tails

# Generate schedule timeline
perf sched timehist | head -50
```

### Dynamic Probes (uprobes/kprobes)

```bash
# Add a probe on a Go function at runtime
# Find the function address
readelf -Ws /path/to/payment-api | grep "ProcessPayment"
# 00000000014abc23  ... ProcessPayment

# Add uprobe
perf probe -x /path/to/payment-api 'ProcessPayment'

# Record uprobe hits with arguments
perf record -e probe_payment-api:ProcessPayment -p $(pgrep payment-api) -- sleep 30

# View results
perf report

# Clean up probes
perf probe --del 'probe_payment-api:ProcessPayment'
```

## Interpreting Results in Context

### Correlating perf Data with Application Metrics

```bash
# Capture system-wide perf data alongside application metrics
# Start recording
perf record -a -g -F 99 &
PERF_PID=$!

# Run load test
ab -n 100000 -c 100 http://localhost:8080/api/payment

# Stop recording
kill -INT ${PERF_PID}
wait ${PERF_PID}

# Generate flamegraph filtered to payment-api process
perf script | grep "payment-api" | \
  /opt/flamegraph/stackcollapse-perf.pl | \
  /opt/flamegraph/flamegraph.pl > flamegraph-load-test.svg
```

### Reading Go Flamegraphs from perf

Go symbols in perf require the binary to be built with debug information:

```bash
# Build Go binary with debug info and frame pointers
go build -gcflags="-N -l" -o payment-api ./cmd/payment-api

# Or for profiling without debugging:
go build -o payment-api ./cmd/payment-api
# Go 1.7+ includes frame pointers by default
# Stack traces work without -N -l

# Symbols are embedded in the binary
# perf automatically reads them via /proc/PID/maps
nm ./payment-api | grep "ProcessPayment"
```

### Common Performance Anti-Patterns

**Pattern: High `stalled-cycles-backend` with high `cache-misses`**

Diagnosis: Memory-bound workload. The CPU is frequently waiting for data from RAM.

Investigation:
```bash
# Identify hot memory access patterns
perf c2c record -g -p $(pgrep my-service) -- sleep 30
perf c2c report --stdio | head -50
```

**Pattern: High `stalled-cycles-frontend` with low `cache-misses`**

Diagnosis: Code execution is prediction-limited. Could be branch mispredictions or instruction fetch bottleneck.

Investigation:
```bash
perf stat -e branch-misses,branch-instructions \
  -p $(pgrep my-service) sleep 30
```

**Pattern: High `context-switches` rate**

Diagnosis: Process switches CPUs frequently, causing cache invalidation.

```bash
# Count context switches
perf stat -e context-switches -p $(pgrep my-service) sleep 10

# Find what's causing the switches
perf record -e context-switches -g -p $(pgrep my-service) -- sleep 10
perf report --stdio | head -30
```

## Security Considerations

Running `perf` in a Kubernetes cluster requires care:

```bash
# Minimum required capabilities for perf in a container:
# CAP_PERFMON (Linux 5.8+): replaces CAP_SYS_ADMIN for perf events
# CAP_SYS_PTRACE: required for process attachment

# Verify kernel supports CAP_PERFMON
uname -r  # Requires 5.8+

# Use capabilities-based approach instead of privileged containers
securityContext:
  capabilities:
    add:
    - PERFMON
    - SYS_PTRACE
```

```yaml
# Restrict perf profiler DaemonSet to specific nodes
apiVersion: apps/v1
kind: DaemonSet
spec:
  template:
    spec:
      nodeSelector:
        "profiling-enabled": "true"  # Only deploy on labeled nodes
```

The combination of `perf stat` for quick hardware counter checks, `perf record` + flamegraphs for CPU time distribution, and `perf sched` for scheduling analysis provides comprehensive performance visibility from the kernel level through to application code — information that complements application-level profiling tools like Go's pprof for complete performance diagnosis.
