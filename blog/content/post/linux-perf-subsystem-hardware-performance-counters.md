---
title: "Linux Perf Subsystem: Hardware Performance Counters"
date: 2029-06-23T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "perf", "PMU", "Profiling", "Flame Graphs", "CPU"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux perf hardware performance counters covering PMU events, cache-references, branch-misses, IPC analysis, perf stat scripting, and generating flame graphs with hardware event-driven sampling."
more_link: "yes"
url: "/linux-perf-subsystem-hardware-performance-counters/"
---

The Linux `perf` subsystem exposes the CPU's Performance Monitoring Unit (PMU) — hardware registers that count architectural events like cache misses, branch mispredictions, and retired instructions. Unlike software profilers that sample at fixed time intervals, PMU-based profiling samples at event boundaries (every N cache misses, for example), revealing the actual microarchitectural bottlenecks in your code. This guide covers the full perf workflow for production performance analysis.

<!--more-->

# Linux Perf Subsystem: Hardware Performance Counters

## Section 1: PMU Architecture and perf Event Types

Modern CPUs contain Performance Monitoring Units with typically 4-8 programmable counters (Intel: 4 general + 3 fixed; AMD: 6+ general). Each counter can be programmed to count one of hundreds of hardware events.

### Event Categories

```
Hardware Events (PMU)
├── cpu-cycles                  Core clock cycles
├── instructions                Retired instructions
├── cache-references            L3 cache references
├── cache-misses                L3 cache misses
├── branch-instructions         Conditional branches
├── branch-misses               Mispredicted branches
├── bus-cycles                  Bus cycles
└── stalled-cycles-frontend     Frontend stall cycles

Hardware Cache Events
├── L1-dcache-loads             L1 data cache read accesses
├── L1-dcache-load-misses       L1 data cache read misses
├── L1-dcache-stores            L1 data cache write accesses
├── L1-icache-load-misses       L1 instruction cache misses
├── LLC-loads                   Last-level cache loads
├── LLC-load-misses             Last-level cache load misses
├── dTLB-loads                  Data TLB loads
├── dTLB-load-misses            Data TLB load misses
├── iTLB-load-misses            Instruction TLB misses
└── branch-loads / branch-load-misses

Software Events
├── cpu-clock                   CPU clock timer
├── task-clock                  Task clock timer
├── page-faults                 Page fault count
├── context-switches            Context switches
├── cpu-migrations              CPU migrations
├── minor-faults                Minor page faults
└── major-faults                Major page faults (disk I/O required)

Tracepoint Events
└── (thousands of kernel tracepoints via trace_event framework)
```

### Check Available Events

```bash
# List all hardware events
perf list hardware

# List all cache events
perf list cache

# List all software events
perf list sw

# List Intel-specific raw events (PEBS, LBR, etc.)
perf list --long-desc | head -100

# List all events including vendor-specific
perf list | wc -l   # May show 2000+ events

# Check which PMU hardware is available
ls /sys/bus/event_source/devices/
# cpu  cstate_core  cstate_pkg  msr  power  uncore_*

# Show raw PMU capabilities
cat /sys/bus/event_source/devices/cpu/caps/pmu_name
cat /sys/bus/event_source/devices/cpu/caps/branches
```

---

## Section 2: perf stat — Counting Mode

`perf stat` runs a command and reports aggregate counts for specified events. It uses the PMU in counting mode (no sampling, minimal overhead ~0.1%).

### Basic IPC Analysis

```bash
# Measure IPC (Instructions Per Cycle)
perf stat -e cycles,instructions,cache-misses,branch-misses \
  ./my-application --benchmark

# Example output:
# Performance counter stats for './my-application --benchmark':
#
#     12,348,765,432      cycles
#     18,456,234,789      instructions              #    1.49  insn per cycle
#        234,567,890      cache-misses
#         45,678,901      branch-misses
#
#        4.2345678901 seconds time elapsed

# IPC > 1.0: Good utilization
# IPC < 0.5: Memory/branch bound, investigate further
```

### Comprehensive Stat for CPU Analysis

```bash
# Comprehensive microarchitecture analysis
perf stat \
  -e cycles \
  -e instructions \
  -e cache-references \
  -e cache-misses \
  -e branch-instructions \
  -e branch-misses \
  -e L1-dcache-loads \
  -e L1-dcache-load-misses \
  -e LLC-loads \
  -e LLC-load-misses \
  -e stalled-cycles-frontend \
  -e stalled-cycles-backend \
  ./my-application

# Interpret results:
# cache-misses / cache-references > 10%: Cache thrashing
# branch-misses / branch-instructions > 5%: Bad branch prediction
# stalled-cycles-backend / cycles > 30%: Memory bound
# stalled-cycles-frontend / cycles > 20%: Fetch/decode bound
```

### Attach to Running Process

```bash
# Attach to existing process (PID)
perf stat -p <PID> sleep 10

# Attach to container process
PID=$(docker inspect --format '{{.State.Pid}}' my-container)
perf stat -p $PID sleep 30

# Kubernetes pod process
POD="my-pod"
NS="production"
CONTAINER_PID=$(kubectl exec -n $NS $POD -- cat /proc/1/status | grep Pid | awk '{print $2}')
# Note: this requires privileged access or node-level execution
```

### perf stat Script for Systematic Benchmarking

```bash
#!/bin/bash
# benchmark.sh — Systematic performance counter collection
set -euo pipefail

COMMAND="${1:?Usage: $0 <command> [args...]}"
ITERATIONS="${BENCH_ITERATIONS:-5}"
OUTPUT_DIR="perf_results_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTPUT_DIR"

echo "Running $COMMAND for $ITERATIONS iterations..."

for i in $(seq 1 $ITERATIONS); do
    echo "Iteration $i/$ITERATIONS"
    perf stat \
      --repeat 1 \
      --output "$OUTPUT_DIR/iteration_${i}.txt" \
      --append \
      -e cycles \
      -e instructions \
      -e cache-misses \
      -e LLC-load-misses \
      -e branch-misses \
      -e dTLB-load-misses \
      -e iTLB-load-misses \
      -x, \
      -- $COMMAND 2>&1
done

# Aggregate results
echo ""
echo "=== Aggregated Results ==="
cat "$OUTPUT_DIR"/iteration_*.txt | \
  awk -F, '
    /^[0-9]/ {
        counts[$4] += $1
        n[$4]++
    }
    END {
        print "Event,Total,Average,StdDev"
        for (e in counts) {
            avg = counts[e] / n[e]
            printf "%s,%d,%.0f\n", e, counts[e], avg
        }
    }
  ' | sort -t, -k3 -rn

echo "Results saved to: $OUTPUT_DIR"
```

---

## Section 3: perf record and report — Sampling Mode

`perf record` samples at a specified frequency or event count, recording stack traces. This identifies which functions are "hot" for a given event.

### CPU Cycle Profiling

```bash
# Sample at 99Hz (avoids resonance with 100Hz kernel timers)
perf record -F 99 -g --call-graph dwarf ./my-application

# Generate report
perf report --stdio | head -50

# Or interactive TUI
perf report
```

### Cache Miss Profiling

```bash
# Sample on LLC cache misses (every 1000 misses take a sample)
perf record -e LLC-load-misses:p -c 1000 -g ./my-application

# The :p modifier = precise event (uses PEBS/IBS hardware assist)
# Other modifiers:
#   :u  = user-space only
#   :k  = kernel only
#   :pp = very precise (requires hardware support)
```

### Branch Misprediction Profiling

```bash
# Find code with high branch misprediction rate
perf record -e branch-misses:pp -c 100 -g ./my-application
perf report --sort=symbol --stdio
```

### Memory Access Profiling (Intel PEBS)

```bash
# Intel PEBS-based memory access profiling (requires Intel CPU)
perf record -e cpu/mem-loads,ldlat=30/P -g ./my-application
perf mem report --stdio

# Memory bandwidth analysis
perf record \
  -e cpu/event=0xD0,umask=0x81,name=MEM_UOPS_RETIRED.ALL_LOADS/P \
  -g ./my-application
```

---

## Section 4: Flame Graphs with Hardware Events

Flame graphs for hardware events show which code paths are responsible for cache misses, not just CPU time.

### Generating Flame Graphs

```bash
# Clone FlameGraph tools
git clone https://github.com/brendangregg/FlameGraph /opt/FlameGraph

# Method 1: CPU cycles flame graph
perf record -F 99 -g --call-graph dwarf -o perf.data ./my-application
perf script -i perf.data | \
  /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl \
    --title "CPU Cycles Flame Graph" \
    --color hot \
    > cpu-cycles.svg

# Method 2: LLC cache miss flame graph
perf record -e LLC-load-misses:p -c 1000 -g -o perf-cache.data ./my-application
perf script -i perf-cache.data | \
  /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl \
    --title "LLC Cache Miss Flame Graph" \
    --color mem \
    --countname "cache-misses" \
    > cache-misses.svg

# Method 3: Branch miss flame graph
perf record -e branch-misses:pp -c 100 -g -o perf-branch.data ./my-application
perf script -i perf-branch.data | \
  /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl \
    --title "Branch Miss Flame Graph" \
    --color chain \
    > branch-misses.svg

# Method 4: Off-CPU flame graph (I/O wait, lock contention)
perf record -e sched:sched_stat_sleep -e sched:sched_switch \
  -e sched:sched_process_exit -g -o perf-offcpu.data ./my-application
perf script -f comm,pid,tid,cpu,time,period,event,ip,sym,dso,trace -i perf-offcpu.data | \
  /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl \
    --title "Off-CPU Flame Graph" \
    --color io \
    > off-cpu.svg
```

### Differential Flame Graphs

Differential flame graphs highlight performance regressions between two versions:

```bash
# Profile version 1 (before optimization)
perf record -F 99 -g --call-graph dwarf -o before.data ./app-v1
perf script -i before.data | /opt/FlameGraph/stackcollapse-perf.pl > before.folded

# Profile version 2 (after optimization)
perf record -F 99 -g --call-graph dwarf -o after.data ./app-v2
perf script -i after.data | /opt/FlameGraph/stackcollapse-perf.pl > after.folded

# Generate differential flame graph
# Red = regression, blue = improvement
/opt/FlameGraph/difffolded.pl before.folded after.folded | \
  /opt/FlameGraph/flamegraph.pl \
    --title "Differential: v2 vs v1" \
    --negate \
    > diff.svg
```

---

## Section 5: perf annotate — Source-Level Analysis

```bash
# After perf record, annotate hot functions with PMU event attribution
perf annotate --stdio -l --symbol=my_hot_function

# Annotate with source code (requires -g debug info)
perf annotate --stdio --source --symbol=compute_hash

# Example output shows assembly with event attribution:
# Percent |      Source code & Disassembly
# --------|-------------------------------
#    0.12 :   mov    (%rdi),%rax        ; load from memory
#   45.67 :   cmp    %rax,%rsi          ; comparison (high miss here!)
#    0.08 :   jne    <loop>             ; branch
```

### Finding Cache-Hostile Code

```bash
# Sample with data address capture (requires Intel PEBS)
perf record -e cpu/mem-loads,ldlat=50/P --weight -g ./my-application
perf report --sort=symbol,dso --stdio | \
  awk '/^ *[0-9]/{if($1+0>1.0) print}' | head -20

# Memory address-level analysis
perf mem report --sort=mem,sym --stdio | head -50
```

---

## Section 6: perf top — Real-Time Profiling

```bash
# Real-time CPU profiling (like top, but for PMU events)
perf top -F 99

# Real-time cache miss profiling
perf top -e LLC-load-misses:p

# Per-CPU breakdown
perf top -F 99 --per-cpu

# Sort by different metrics
perf top --sort=cpu,comm,dso,symbol
```

---

## Section 7: Advanced PMU Events with raw encoding

Not all hardware events are exposed by name. Intel and AMD document their full PMU event tables, and `perf` accepts raw event codes.

### Intel Raw Event Examples

```bash
# Intel: cycles not in halt (excludes C-state time)
# Event 0x3C, Umask 0x00, CMask 0, Edge=0
perf stat -e cpu/event=0x3c,umask=0x00/ ./my-application

# Intel: Memory bandwidth (uncore IMC events)
# Check available uncore PMUs
ls /sys/bus/event_source/devices/ | grep uncore_imc

# Sample uncore IMC read bandwidth
perf stat \
  -e uncore_imc_0/event=0x04,umask=0x03/ \
  -e uncore_imc_1/event=0x04,umask=0x03/ \
  ./my-application

# Intel: Frontend stalls (from Topdown Methodology)
perf stat \
  -e cpu/topdown-fetch-bubbles/ \
  -e cpu/topdown-slots/ \
  -e cpu/topdown-bad-spec/ \
  ./my-application
```

### Intel Top-Down Methodology

The Intel Top-Down Methodology categorizes where CPU cycles are wasted:

```
CPU Cycles
├── Retiring (good: useful work done)
├── Bad Speculation (branch mispredicts, machine clears)
├── Frontend Bound (decode/fetch stalls)
│   ├── Fetch Latency (cache miss in icache/iTLB)
│   └── Fetch Bandwidth
└── Backend Bound (execution/memory stalls)
    ├── Memory Bound (cache misses, bandwidth)
    └── Core Bound (execution unit pressure)
```

```bash
# Topdown Level 1 analysis with perf stat
perf stat -M TopdownL1 ./my-application

# If TopdownL1 is not available, use raw events (Skylake example)
perf stat \
  -e '{cpu/event=0xc2,umask=0x02/,cpu/event=0x0e,umask=0x01/,
       cpu/event=0xd5,umask=0x01/,cpu/event=0xb7,umask=0x01/}' \
  ./my-application
```

---

## Section 8: perf in Kubernetes and Containers

### Required Permissions

perf requires `CAP_PERFMON` (Linux 5.8+) or `CAP_SYS_ADMIN`:

```yaml
# perf-profiler-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: perf-profiler
  namespace: profiling
spec:
  hostPID: true    # Required to profile host processes
  nodeName: node-to-profile
  containers:
  - name: profiler
    image: ubuntu:22.04
    command: ["sleep", "3600"]
    securityContext:
      capabilities:
        add:
        - PERFMON
        - SYS_PTRACE
    volumeMounts:
    - name: sys
      mountPath: /sys
    - name: proc
      mountPath: /proc-host
  volumes:
  - name: sys
    hostPath:
      path: /sys
  - name: proc
    hostPath:
      path: /proc
```

### Node-Level perf with Privileged DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: perf-collector
  namespace: profiling
spec:
  selector:
    matchLabels:
      app: perf-collector
  template:
    metadata:
      labels:
        app: perf-collector
    spec:
      hostPID: true
      hostNetwork: true
      hostIPC: true
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
      containers:
      - name: perf
        image: ubuntu:22.04
        command: ["sleep", "infinity"]
        securityContext:
          privileged: true
        volumeMounts:
        - name: sys
          mountPath: /sys
        - name: debugfs
          mountPath: /sys/kernel/debug
        - name: modules
          mountPath: /lib/modules
          readOnly: true
        resources:
          limits:
            cpu: "2"
            memory: 2Gi
      volumes:
      - name: sys
        hostPath:
          path: /sys
      - name: debugfs
        hostPath:
          path: /sys/kernel/debug
      - name: modules
        hostPath:
          path: /lib/modules
```

### Profiling a Container Process

```bash
# Get container PID from the DaemonSet pod
kubectl exec -n profiling ds/perf-collector -- \
  bash -c "
    # Find the target container process
    TARGET_PID=\$(pgrep -f 'my-application')
    echo 'Target PID: '\$TARGET_PID

    # Profile for 30 seconds
    perf record -F 99 -g --call-graph dwarf -p \$TARGET_PID -o /tmp/perf.data sleep 30

    # Generate text report
    perf report -i /tmp/perf.data --stdio | head -60
  "

# Copy flame graph data off the node
kubectl cp profiling/perf-collector-xxxxx:/tmp/perf.data ./perf.data
perf script -i perf.data | \
  /opt/FlameGraph/stackcollapse-perf.pl | \
  /opt/FlameGraph/flamegraph.pl > container-profile.svg
```

---

## Section 9: Interpreting perf Results

### IPC (Instructions Per Cycle) Interpretation

| IPC | Interpretation |
|-----|---------------|
| < 0.5 | Severely memory-bound or high stall |
| 0.5 - 1.0 | Memory-bound or poor branch prediction |
| 1.0 - 2.0 | Reasonable, some room for improvement |
| 2.0 - 3.0 | Good CPU utilization |
| > 3.0 | Excellent, SIMD/vectorized code |

### Cache Miss Rate Thresholds

```bash
# Calculate cache miss rate in perf stat output
# Example interpretation:
# 234,567,890  cache-misses  #   3.45%  of all cache refs
#
# < 1%: Excellent cache behavior
# 1-5%: Good cache behavior
# 5-15%: Moderate — investigate memory access patterns
# > 15%: High — likely cache thrashing, poor locality

# L1 miss rate (much more expensive per miss than LLC miss rate % suggests)
# L1: ~4 cycle penalty
# L2: ~12 cycle penalty
# L3: ~40 cycle penalty
# DRAM: ~200 cycle penalty
```

### Branch Misprediction Analysis

```bash
# Calculate misprediction rate:
# branch-misses / branch-instructions
# 45,678,901 branch-misses   #  3.67%  of all branches
#
# < 1%: Excellent prediction
# 1-3%: Normal for typical code
# > 5%: High — consider branchless alternatives

# Find mispredicted branches
perf record -e branch-misses:pp -c 100 -g ./my-application
perf report --sort=symbol --stdio | head -30
```

---

## Section 10: Automated Performance Regression Detection

```bash
#!/bin/bash
# perf-regression-check.sh — CI integration
set -euo pipefail

THRESHOLD_IPC=1.0
THRESHOLD_CACHE_MISS_RATE=5.0
THRESHOLD_BRANCH_MISS_RATE=3.0

COMMAND="${1:?Usage: $0 <command>}"

# Run with perf stat
OUTPUT=$(perf stat \
  -e cycles,instructions,cache-references,cache-misses,branch-instructions,branch-misses \
  -x, \
  -- $COMMAND 2>&1)

# Parse metrics
CYCLES=$(echo "$OUTPUT" | awk -F, '/cycles/{print $1}' | tr -d ',')
INSTRUCTIONS=$(echo "$OUTPUT" | awk -F, '/instructions/{print $1}' | tr -d ',')
CACHE_REFS=$(echo "$OUTPUT" | awk -F, '/cache-references/{print $1}' | tr -d ',')
CACHE_MISSES=$(echo "$OUTPUT" | awk -F, '/cache-misses/{print $1}' | tr -d ',')
BRANCH_INSNS=$(echo "$OUTPUT" | awk -F, '/branch-instructions/{print $1}' | tr -d ',')
BRANCH_MISSES=$(echo "$OUTPUT" | awk -F, '/branch-misses/{print $1}' | tr -d ',')

# Calculate rates
IPC=$(awk "BEGIN {printf \"%.2f\", $INSTRUCTIONS / $CYCLES}")
CACHE_MISS_RATE=$(awk "BEGIN {printf \"%.2f\", ($CACHE_MISSES / $CACHE_REFS) * 100}")
BRANCH_MISS_RATE=$(awk "BEGIN {printf \"%.2f\", ($BRANCH_MISSES / $BRANCH_INSNS) * 100}")

echo "Performance Counter Results:"
echo "  IPC:               $IPC (threshold: >= $THRESHOLD_IPC)"
echo "  Cache miss rate:   ${CACHE_MISS_RATE}% (threshold: <= ${THRESHOLD_CACHE_MISS_RATE}%)"
echo "  Branch miss rate:  ${BRANCH_MISS_RATE}% (threshold: <= ${THRESHOLD_BRANCH_MISS_RATE}%)"

FAIL=0

if awk "BEGIN {exit !($IPC < $THRESHOLD_IPC)}"; then
    echo "FAIL: IPC $IPC is below threshold $THRESHOLD_IPC"
    FAIL=1
fi

if awk "BEGIN {exit !($CACHE_MISS_RATE > $THRESHOLD_CACHE_MISS_RATE)}"; then
    echo "FAIL: Cache miss rate ${CACHE_MISS_RATE}% exceeds threshold ${THRESHOLD_CACHE_MISS_RATE}%"
    FAIL=1
fi

if awk "BEGIN {exit !($BRANCH_MISS_RATE > $THRESHOLD_BRANCH_MISS_RATE)}"; then
    echo "FAIL: Branch miss rate ${BRANCH_MISS_RATE}% exceeds threshold ${THRESHOLD_BRANCH_MISS_RATE}%"
    FAIL=1
fi

if [ $FAIL -eq 0 ]; then
    echo "PASS: All performance thresholds met"
fi

exit $FAIL
```

The Linux perf subsystem provides visibility into CPU microarchitectural behavior that no other tool can match. By combining `perf stat` for quick regression checks, `perf record` with hardware event sampling for deep profiling, and flame graphs for visualization, you can diagnose performance issues that appear as "inexplicably slow" code without any obvious algorithmic reason.
