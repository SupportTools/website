---
title: "Linux Performance Analysis with perf: CPU Profiling, Cache Misses, Branch Prediction, and Flame Graphs"
date: 2031-10-14T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "perf", "Profiling", "Flame Graphs", "CPU", "Optimization"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux perf for production performance analysis: hardware PMU counters, CPU profiling, last-level cache miss analysis, branch misprediction identification, and generating flame graphs from production workloads without source code access."
more_link: "yes"
url: "/linux-perf-cpu-profiling-flame-graphs-cache-analysis/"
---

`perf` is the Linux kernel's built-in performance analysis tool, backed by CPU hardware performance monitoring units (PMUs) that track events at CPU cycle granularity without the overhead of software instrumentation. When a production system is running slower than expected and application-level profilers show nothing unusual, `perf` reveals the hardware-level truth: which functions generate last-level cache misses, which branches are systematically mispredicted, and whether the bottleneck is compute-bound, memory-bound, or instruction-fetch-limited. This guide covers practical `perf` usage from basic CPU profiling to generating flame graphs from live production containers.

<!--more-->

# Linux Performance Analysis with perf

## Section 1: perf Architecture and Prerequisites

`perf` accesses hardware PMUs through kernel support. Each CPU architecture exposes a set of event counters: retired instructions, CPU cycles, cache references, cache misses, branch instructions, branch misses, and more. Intel CPUs additionally expose precise event-based sampling (PEBS) which eliminates the skid problem in instruction-level attribution.

### Installation and Kernel Version Requirements

```bash
# Install perf matching the running kernel
apt-get install linux-tools-$(uname -r) linux-tools-common linux-tools-generic

# Or from source (matches any kernel)
apt-get install libpython3-dev libelf-dev libunwind-dev
cd /usr/src/linux-$(uname -r)/tools/perf
make -j$(nproc)
sudo make install

# Verify perf is working
perf --version
# perf version 6.14.0

# Check available events
perf list | head -40

# For container environments, ensure perf_event_paranoid is set
cat /proc/sys/kernel/perf_event_paranoid
# 2 = deny unprivileged perf_event_open
# 1 = deny kernel profiling without CAP_SYS_PTRACE
# 0 = allow all (production environments)
# -1 = allow raw tracepoints

# Loosen for profiling (restore after)
sudo sysctl -w kernel.perf_event_paranoid=1
sudo sysctl -w kernel.kptr_restrict=0
```

### Capabilities Required

```bash
# For CPU profiling of other processes (in containers)
# Need CAP_PERFMON (Linux 5.8+) or CAP_SYS_ADMIN (older kernels)
sudo setcap 'cap_perfmon,cap_sys_ptrace=ep' $(which perf)

# In Kubernetes, run with:
securityContext:
  capabilities:
    add: ["PERFMON", "SYS_PTRACE"]
```

## Section 2: Basic CPU Profiling

### System-Wide CPU Profile

```bash
# Profile all CPUs for 30 seconds (requires root or perf_event_paranoid <= 0)
sudo perf record -g -F 99 -a sleep 30

# Profile a specific process by PID
sudo perf record -g -F 99 -p $(pgrep payment-service) sleep 30

# Profile a specific command from start
perf record -g -F 99 -- ./payment-service --config=prod.yaml

# Quick statistics (no recording, just counts)
perf stat -e cycles,instructions,cache-misses,branch-misses ./app

# Detailed stats with multiplexing metrics
perf stat -e cycles:u,cycles:k,instructions:u,instructions:k,\
  cache-references,cache-misses,branch-instructions,branch-misses,\
  cpu-clock,task-clock \
  -p $(pgrep payment-service) sleep 10
```

### Reading perf.data Reports

```bash
# Text report after profiling
perf report --stdio

# Interactive TUI (navigate with arrow keys, 'a' to annotate)
perf report

# Flat profile with percentages
perf report --stdio --sort=comm,dso,symbol | head -80

# Sample output:
# Overhead  Command          Shared Object         Symbol
# 12.34%    payment-service  payment-service       processOrder
#  8.91%    payment-service  libc-2.35.so          malloc
#  6.12%    payment-service  payment-service       validateCard
#  4.33%    payment-service  [kernel]              __GFP_WAIT

# Show call chains
perf report --call-graph fractal --stdio | head -100
```

## Section 3: Call Graph Collection Methods

### Frame Pointer vs. DWARF vs. LBR

```bash
# Method 1: Frame pointer unwinding (default, requires frame pointers in binary)
# Go binaries: frame pointers enabled by default since Go 1.12
perf record -g fp -F 99 -p $(pgrep app) sleep 30

# Method 2: DWARF unwinding (works without frame pointers, higher overhead)
perf record -g dwarf -F 99 -p $(pgrep app) sleep 30

# Method 3: LBR (Last Branch Record) — Intel-only, zero-overhead, shallow (32 frames max)
perf record --call-graph lbr -F 99 -p $(pgrep app) sleep 30

# For Go applications (frame pointers always available)
GOGC=off go build -o app ./cmd/app  # disable GC for cleaner profiles
perf record -g fp -F 99 -- ./app
```

### Annotating Source Lines

```bash
# Annotate a specific function with cycle attribution
perf annotate --symbol=processOrder --stdio

# Sample output:
#  Percent |  Source code & Disassembly
# ---------|-------------------------------------------
#    0.00  : func processOrder(ctx context.Context, ...
#    2.14  :   if err := validate(req); err != nil {
#   34.21  :   db.Query(ctx, "SELECT * FROM orders WHERE...")
#    1.03  :   return result, nil
```

## Section 4: Hardware Counter Analysis

### Cache Miss Profiling

LLC (Last-Level Cache) misses cause 100-300 cycle stalls, making them the dominant latency source in memory-intensive applications.

```bash
# Measure cache events
perf stat -e \
  L1-dcache-loads,L1-dcache-load-misses,\
  L1-dcache-stores,L1-dcache-store-misses,\
  L2-dcache-loads,L2-dcache-load-misses,\
  LLC-loads,LLC-load-misses,LLC-stores,LLC-store-misses \
  -p $(pgrep app) sleep 10

# Sample output:
#     2,345,678,901   L1-dcache-loads
#        45,678,901   L1-dcache-load-misses    #   1.95% of L1 loads
#       123,456,789   LLC-loads
#        23,456,789   LLC-load-misses          #  19.00% of LLC loads  ← problem

# LLC miss rate > 5% typically indicates cache pressure
# Identify which functions cause LLC misses
perf record -e LLC-load-misses:p -g -F 99 -p $(pgrep app) sleep 30
perf report --stdio --sort=symbol

# Precise sampling (PEBS) for instruction-level attribution
perf record -e mem-loads:P -g -p $(pgrep app) sleep 30
```

### Memory Bandwidth Analysis

```bash
# Intel: use RAPL events for memory bandwidth
perf stat -e \
  uncore_imc/data_reads/,uncore_imc/data_writes/ \
  sleep 10

# If uncore events unavailable, use perf mem
perf mem record -p $(pgrep app) sleep 10
perf mem report --stdio

# Identify data structures causing cache misses
# Look for accesses to: stride > 64 bytes, random access patterns, large arrays
```

### Branch Misprediction Analysis

A mispredicted branch costs 15-20 cycles on modern CPUs. High branch-miss rates indicate:
- Unpredictable conditional branches (data-dependent comparisons)
- Virtual function calls (polymorphic dispatch)
- Function pointers

```bash
# Count branch mispredictions
perf stat -e branches,branch-misses -p $(pgrep app) sleep 10

# Sample output:
#     8,923,456,789   branches
#        45,678,901   branch-misses    #  0.51% of all branches
# <= 0.5% is typically fine; > 2% warrants investigation

# Identify which branches mispredict
perf record -e branch-misses:P -g -F 99 -p $(pgrep app) sleep 30
perf report --stdio

# Annotate to find the specific instruction
perf annotate --symbol=hotFunction --stdio | grep -E "mispredict|br"
```

## Section 5: Generating Flame Graphs

Flame graphs are the most effective visualization for CPU profiling data. Each horizontal bar represents a function; width represents the percentage of samples.

### Brendan Gregg's Flame Graph Tools

```bash
git clone https://github.com/brendangregg/FlameGraph
cd FlameGraph

# Record with stack traces
sudo perf record -g -F 99 -p $(pgrep payment-service) sleep 30

# Generate flame graph
sudo perf script | \
  ./stackcollapse-perf.pl | \
  ./flamegraph.pl \
    --title "payment-service CPU Profile" \
    --colors java \
    --width 1800 \
    > payment-service-flamegraph.svg

# Open in browser
xdg-open payment-service-flamegraph.svg
```

### Off-CPU Flame Graphs (Blocking Analysis)

CPU flame graphs show where CPU time is spent. Off-CPU flame graphs show where processes are blocked (I/O, locks, sleep).

```bash
# Trace scheduler context switches
sudo perf record -e sched:sched_stat_sleep \
  -e sched:sched_switch \
  -e sched:sched_process_exit \
  -g -p $(pgrep payment-service) sleep 30

sudo perf script | \
  perl stackcollapse-perf.pl --pid | \
  ./flamegraph.pl \
    --title "Off-CPU (Blocking) Profile" \
    --color aqua \
    > offcpu-flamegraph.svg
```

### Differential Flame Graphs

Compare two profiles to visualize regressions:

```bash
# Profile before optimization
perf record -g -F 99 -p $(pgrep app) sleep 30 -o perf-before.data
perf script -i perf-before.data | ./stackcollapse-perf.pl > before.folded

# Profile after optimization
perf record -g -F 99 -p $(pgrep app) sleep 30 -o perf-after.data
perf script -i perf-after.data | ./stackcollapse-perf.pl > after.folded

# Generate differential flame graph
./difffolded.pl before.folded after.folded | \
  ./flamegraph.pl \
    --title "Differential: After - Before" \
    --negate \
    > diff-flamegraph.svg
# Red: functions that increased CPU usage (regressions)
# Blue: functions that decreased CPU usage (improvements)
```

## Section 6: Profiling Inside Kubernetes Containers

### Profiling a Running Container

```bash
# Find the container PID on the node
CONTAINER_ID=$(kubectl get pod payment-api-7b4f9-abc12 \
  -n production \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's/containerd:\/\///')

CONTAINER_PID=$(crictl inspect "${CONTAINER_ID}" | \
  jq -r '.info.pid')

echo "Container PID: ${CONTAINER_PID}"

# Profile the container process
sudo perf record -g -F 99 -p "${CONTAINER_PID}" sleep 30

# Generate flame graph
sudo perf script | \
  /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl > /tmp/container-flamegraph.svg

# Copy to local machine
kubectl cp production/debug-node-pod:/tmp/container-flamegraph.svg ./
```

### Privileged Debug Pod for Node-Level Profiling

```yaml
# debug-pod.yaml — privileged pod for perf profiling on a specific node
apiVersion: v1
kind: Pod
metadata:
  name: perf-debugger
  namespace: kube-system
spec:
  nodeName: prod-node-07   # target node
  hostPID: true
  hostNetwork: true
  tolerations:
    - operator: Exists
  containers:
    - name: debugger
      image: ubuntu:24.04
      command: ["/bin/bash", "-c", "apt-get update && apt-get install -y linux-tools-$(uname -r) git && sleep infinity"]
      securityContext:
        privileged: true
      volumeMounts:
        - name: host-sys
          mountPath: /sys
        - name: host-proc
          mountPath: /proc
  volumes:
    - name: host-sys
      hostPath:
        path: /sys
    - name: host-proc
      hostPath:
        path: /proc
  restartPolicy: Never
```

## Section 7: perf stat Metrics Interpretation

### CPI (Cycles Per Instruction) Analysis

CPI = cycles / instructions. An ideal CPI approaches 0.25 (4 IPC on superscalar CPUs). High CPI indicates stalls.

```bash
perf stat -e cycles,instructions -p $(pgrep app) sleep 10

# Interpret:
# CPI = 0.5: good, mostly compute-bound
# CPI = 1.0: moderate stalls (cache misses or branch mispredictions)
# CPI = 4.0: severe memory latency (LLC misses, DRAM accesses)

# Calculate IPC
perf stat -e cycles,instructions -p $(pgrep app) sleep 10 2>&1 | \
  awk '/instructions/{ins=$1} /cycles/{cyc=$1} END {printf "IPC: %.2f\n", ins/cyc}'
```

### Top-Down Methodology (Intel)

The Top-Down Microarchitecture Analysis Method categorizes cycles into:
- **Frontend Bound**: Instruction fetch/decode stalls
- **Backend Bound**: Execution stalls (memory, compute)
- **Bad Speculation**: Branch mispredictions
- **Retiring**: Useful work

```bash
# Requires perf with Intel PMU metrics
perf stat -M TopdownL1 -p $(pgrep app) sleep 10

# Or use pmu-tools
pip3 install pmu-tools
toplev.py -l1 -p $(pgrep app) sleep 10

# Sample output:
# Frontend_Bound:       12.3% => Investigate: icache misses, decode bottlenecks
# Backend_Bound:        41.2% => Dominant: memory latency likely
#   Memory_Bound:       35.1%
#   Core_Bound:          6.1%
# Retiring:             42.3% => Useful work
# Bad_Speculation:       4.2%
```

## Section 8: Tracing with perf trace (strace Replacement)

`perf trace` provides strace-like syscall tracing with significantly lower overhead:

```bash
# Trace all syscalls for a process (lower overhead than strace)
sudo perf trace -p $(pgrep app) --duration 10

# Summary mode: count syscalls
sudo perf trace -s -p $(pgrep app) sleep 10

# Trace specific syscall
sudo perf trace -e openat -p $(pgrep app) sleep 5

# Sample output:
# 0.000 payment-service/12345 openat(AT_FDCWD, "/etc/ssl/certs/ca-certificates.crt", O_RDONLY) = 5
# 0.001 payment-service/12345 openat(AT_FDCWD, "/etc/hosts", O_RDONLY) = 6

# Count file opens (look for excessive re-opens)
sudo perf trace -e openat -s -p $(pgrep app) sleep 10 2>&1 | \
  grep -E "openat|count" | sort -rn
```

## Section 9: Dynamic Tracing with perf probe

`perf probe` adds kprobes and uprobes dynamically without modifying source code or recompiling.

### Tracing Go Function Entry/Exit

```bash
# Add a probe at a Go function entry point
# First, find the function address
objdump -d ./app | grep "<main.processOrder>"

# Add uprobe at function
sudo perf probe -x ./app \
  'main.processOrder'

# Add probe with parameter capture
sudo perf probe -x ./app \
  --add='main.processOrder orderId=%ax'

# Record the probe
sudo perf record -e 'probe_app:main__processOrder' \
  -g -p $(pgrep app) sleep 10

# View results
sudo perf script

# Clean up probes
sudo perf probe --del 'probe_app:*'
```

### Tracing Kernel Functions

```bash
# Trace TCP connection establishment
sudo perf probe --add='tcp_connect'
sudo perf record -e probe:tcp_connect -ag sleep 10
sudo perf report --stdio

# Trace block I/O completion latency
sudo perf probe --add='blk_account_io_completion bytes=bytes:u32'
sudo perf record -e probe:blk_account_io_completion \
  -p $(pgrep app) sleep 10
sudo perf script | awk '{sum+=$NF; count++} END {print "avg bytes:", sum/count}'
```

## Section 10: perf for Go Runtime Analysis

### Identifying GC Pressure

```bash
# Monitor GC-related memory events
GOMAXPROCS=8 GOGC=100 perf stat -e \
  cycles,instructions,cache-misses,\
  minor-faults,major-faults,\
  page-faults \
  -- ./app --benchmark

# GC pauses appear in perf trace as:
sudo perf trace -e 'signal:signal_generate' -p $(pgrep app) sleep 10 | \
  grep SIGURG  # Go runtime uses SIGURG for goroutine preemption

# Profile with GC disabled to isolate application code
GOGC=off perf record -g -F 99 -p $(pgrep app) sleep 30
```

### Goroutine Scheduling Analysis

```bash
# Count goroutine context switches (via futex and sched events)
sudo perf stat -e sched:sched_switch \
  -p $(pgrep app) sleep 10

# High sched_switch rate with short intervals = contention
sudo perf record -e sched:sched_switch -ag sleep 10
sudo perf report --stdio --sort=comm,dso
```

## Section 11: Automated Continuous Profiling

For production systems, collect profiles automatically and store them for analysis:

```bash
#!/bin/bash
# continuous-profile.sh — run every hour via cron

set -euo pipefail

OUTPUT_DIR="/var/perf-profiles/$(date +%Y/%m/%d)"
mkdir -p "${OUTPUT_DIR}"
TIMESTAMP=$(date +%H%M%S)
TARGET_PID=$(pgrep -f payment-service | head -1)

if [[ -z "${TARGET_PID}" ]]; then
  echo "payment-service not running" >&2
  exit 0
fi

echo "Profiling PID ${TARGET_PID} for 30 seconds..."

# CPU profile
perf record -g -F 99 -p "${TARGET_PID}" \
  -o "${OUTPUT_DIR}/cpu-${TIMESTAMP}.data" sleep 30

# Generate flame graph
perf script -i "${OUTPUT_DIR}/cpu-${TIMESTAMP}.data" | \
  /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl \
    --title "payment-service $(date)" \
  > "${OUTPUT_DIR}/flamegraph-${TIMESTAMP}.svg"

# Hardware counters snapshot
perf stat -e cycles,instructions,cache-misses,branch-misses \
  -p "${TARGET_PID}" sleep 5 \
  2> "${OUTPUT_DIR}/hwstats-${TIMESTAMP}.txt"

# Compress raw data (keeps for 7 days)
gzip "${OUTPUT_DIR}/cpu-${TIMESTAMP}.data"

# Purge profiles older than 7 days
find /var/perf-profiles/ -name "*.data.gz" -mtime +7 -delete
find /var/perf-profiles/ -name "hwstats-*.txt" -mtime +7 -delete

echo "Profile saved: ${OUTPUT_DIR}/flamegraph-${TIMESTAMP}.svg"
```

## Section 12: Interpreting Common Performance Patterns

### Pattern: Memory-Bound Workload

Symptoms: High CPI (>2), high LLC-load-misses (>10%), low IPC

```bash
# Diagnosis
perf stat -e cycles,instructions,LLC-load-misses,LLC-store-misses \
  -p $(pgrep app) sleep 10

# Likely causes and fixes:
# 1. Large working set: reduce data structure sizes, use memory pools
# 2. Poor cache locality: restructure data (AOS -> SOA)
# 3. False sharing: pad structs to cache line (64 bytes) boundaries
# 4. TLB misses: use huge pages (see /proc/sys/vm/nr_hugepages)

# Check huge page usage
grep -E "HugePages|AnonHugePages" /proc/meminfo
cat /sys/kernel/mm/transparent_hugepage/enabled
```

### Pattern: Branch-Misprediction-Bound

Symptoms: High branch-misses (>2%), moderate IPC

```bash
# Diagnosis
perf stat -e branches,branch-misses -p $(pgrep app) sleep 10

# Common fixes:
# 1. Remove unpredictable conditionals from hot loops
# 2. Use branchless code patterns
# 3. Sort data before processing to improve locality and predictability
# 4. Use __builtin_expect() hints (in C); Go compiler does this automatically
```

### Pattern: Frontend-Bound (Instruction Cache)

Symptoms: High frontend stall events, large binary with many virtual calls

```bash
perf stat -e \
  frontend-stalls,ipc-stalls,\
  icache.miss,idq_uops_not_delivered.core \
  -p $(pgrep app) sleep 10

# Fixes:
# 1. Reduce binary size (-ldflags="-s -w")
# 2. Profile-Guided Optimization (Go 1.21+)
```

### Profile-Guided Optimization in Go

```bash
# Step 1: Build with CPU profiling enabled
go build -o app-pgo-base ./cmd/app

# Step 2: Collect a CPU profile from production traffic
curl http://app.example.com/debug/pprof/profile?seconds=30 -o cpu.pprof

# Step 3: Rebuild with PGO profile
go build -pgo=cpu.pprof -o app-pgo-optimized ./cmd/app

# Compare performance
hyperfine './app-pgo-base --benchmark' './app-pgo-optimized --benchmark'
# pgo-optimized: 3-15% faster (typically)
```

## Summary

`perf` exposes the hardware truth behind software performance problems. CPU profiles with frame pointers reveal which functions consume cycles. Hardware counter analysis distinguishes memory-bound workloads (high LLC-miss rate) from branch-prediction-limited code. Differential flame graphs make performance regressions visible as color changes between two profiles. Dynamic probes via `perf probe` add measurement points without recompilation or restart. For production Kubernetes workloads, a privileged DaemonSet pod enables all of this analysis on any container without modifying the workload itself. Profile-Guided Optimization closes the loop by feeding production profiling data back into the compiler for 3-15% throughput improvements.
