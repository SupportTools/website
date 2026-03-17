---
title: "Linux perf Tool: CPU Profiling and Performance Analysis"
date: 2029-04-01T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "perf", "Profiling", "Flame Graphs", "Observability"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux perf for CPU profiling and performance analysis: perf stat, perf record, perf report, flame graphs with Brendan Gregg's tools, hardware PMU counters, and cache miss analysis."
more_link: "yes"
url: "/linux-perf-tool-cpu-profiling-performance-analysis/"
---

The Linux `perf` tool is the Swiss army knife of CPU performance analysis. Built directly into the kernel, it provides access to hardware performance monitoring unit (PMU) counters, software events, kernel tracepoints, and user-space probes through a single unified interface. For production performance investigations, `perf` reveals bottlenecks that application-level profilers cannot see: CPU pipeline stalls, cache miss cascades, branch mispredictions, and kernel time spent on behalf of your process.

<!--more-->

# Linux perf Tool: CPU Profiling and Performance Analysis

## Section 1: Installation and Setup

`perf` is part of the `linux-tools` package and must match your running kernel version:

```bash
# Ubuntu/Debian
apt-get install linux-tools-common linux-tools-generic linux-tools-$(uname -r)

# RHEL/CentOS/Amazon Linux
yum install perf
# or
dnf install perf

# Verify installation
perf --version
# perf version 6.x.x-...

# Check what your kernel was built with
perf list | head -30

# Check perf capability on the system
cat /proc/sys/kernel/perf_event_paranoid
# -1: all users can use perf
#  0: allow all users to use perf, disallow raw tracepoint access
#  1: allow moderately privileged users
#  2: only root (default on many distributions)

# For development/testing, lower the paranoia level
sysctl -w kernel.perf_event_paranoid=1

# For containers: add perf capability
# docker run --cap-add SYS_ADMIN --cap-add SYS_PTRACE ...
```

### perf in Kubernetes

```yaml
# Debug pod with perf access
apiVersion: v1
kind: Pod
metadata:
  name: perf-debug
  namespace: default
spec:
  hostPID: true
  containers:
    - name: perf
      image: ubuntu:22.04
      command: ["sleep", "infinity"]
      securityContext:
        privileged: true
        capabilities:
          add:
            - SYS_ADMIN
            - SYS_PTRACE
            - PERFMON
      volumeMounts:
        - name: host-proc
          mountPath: /host/proc
        - name: host-sys
          mountPath: /host/sys
  volumes:
    - name: host-proc
      hostPath:
        path: /proc
    - name: host-sys
      hostPath:
        path: /sys
```

## Section 2: perf stat - Counting Hardware Events

`perf stat` attaches to a process or command and counts hardware events during its execution. This is the fastest way to get a high-level performance characterization.

### Basic Usage

```bash
# Profile a command
perf stat ls /usr/bin

# Profile with more hardware events
perf stat -e cycles,instructions,cache-misses,cache-references,\
branch-misses,branch-instructions ./my-binary

# Attach to a running process
perf stat -p <PID> sleep 10

# Profile with per-CPU breakdown
perf stat -a -e cycles,instructions sleep 5

# Repeat the measurement N times and show variance
perf stat -r 5 ./my-binary
```

### Sample Output Interpretation

```
Performance counter stats for './my-binary':

     14,234,567,890      cycles                   #    3.20 GHz
     18,567,234,123      instructions             #    1.30  insn per cycle
        234,567,890      cache-misses             #    2.30 % of all cache refs
     10,234,567,890      cache-references
          1,234,567      branch-misses            #    0.50 % of all branches
        234,567,890      branch-instructions

       4.450123456 seconds time elapsed

       4.392345678 seconds user
       0.057890123 seconds sys
```

Key metrics to understand:

- **Instructions per cycle (IPC)**: Modern CPUs can execute 3-5 instructions/cycle. Low IPC (below 1.0) indicates pipeline stalls from memory latency or branch mispredictions.
- **Cache miss rate**: Above 5% indicates a working set that doesn't fit in L3. Above 1% is worth investigating for hot loops.
- **Branch miss rate**: Modern predictors achieve 99%+ accuracy. Above 1% on branches suggests unpredictable control flow (hash tables, data-dependent branches).

### Comprehensive Event Set

```bash
# Full hardware counter profile
perf stat -e \
    cycles,\
    instructions,\
    cache-misses,\
    cache-references,\
    L1-dcache-loads,\
    L1-dcache-load-misses,\
    LLC-loads,\
    LLC-load-misses,\
    branch-instructions,\
    branch-misses,\
    dTLB-loads,\
    dTLB-load-misses,\
    mem-loads,\
    mem-stores \
    -p <PID> sleep 30
```

### CPU-Specific PMU Events

```bash
# List all available events including CPU-specific ones
perf list

# Intel Skylake/Cascade Lake specific events
perf stat -e \
    cpu/event=0xd1,umask=0x01,name=MEM_LOAD_RETIRED.L1_HIT/,\
    cpu/event=0xd1,umask=0x02,name=MEM_LOAD_RETIRED.L2_HIT/,\
    cpu/event=0xd1,umask=0x04,name=MEM_LOAD_RETIRED.L3_HIT/,\
    cpu/event=0xd1,umask=0x20,name=MEM_LOAD_RETIRED.L3_MISS/,\
    cpu/event=0xa8,umask=0x01,name=LSD.UOPS/ \
    ./my-binary

# AMD Zen3 specific
perf stat -e \
    cpu/event=0x044,umask=0xff,name=RETIRED_BRANCH_INSTRUCTIONS/,\
    cpu/event=0x0c2,umask=0x00,name=RETIRED_BRANCH_INSTRUCTIONS_MISPREDICTED/ \
    ./my-binary
```

## Section 3: perf record - Sampling Profiles

`perf record` uses sampling: it interrupts the CPU at a configured frequency (default 1000Hz or one event per N occurrences) and records the instruction pointer and call stack.

### Basic Recording

```bash
# Record CPU cycles at default frequency
perf record ./my-binary

# Record at higher frequency (more overhead, better resolution)
perf record -F 9999 ./my-binary

# Record with call graph (required for flame graphs)
# dwarf: use DWARF debug info (accurate but high overhead)
# fp: use frame pointers (fast, requires -fno-omit-frame-pointer)
# lbr: use last branch record (Intel hardware, limited depth)
perf record -g --call-graph dwarf ./my-binary
perf record -g --call-graph fp ./my-binary
perf record -g --call-graph lbr ./my-binary

# Record all CPUs for system-wide profile
perf record -a -g --call-graph dwarf sleep 30

# Record a specific process
perf record -p <PID> -g --call-graph fp sleep 30

# Record specific events
perf record -e cache-misses:u -g ./my-binary

# Record with limited buffer size (reduce disk I/O)
perf record -m 256 -g ./my-binary
```

### Recording in Containers

```bash
# On the container host, profile the container's PID
# First find the host PID of the container process
docker inspect <container-id> | jq '.[0].State.Pid'
# or
cat /sys/fs/cgroup/system.slice/docker-<container-id>.scope/cgroup.procs

# Record that PID with full call graph
perf record -p <HOST_PID> -g --call-graph dwarf -o /tmp/perf.data sleep 30
```

## Section 4: perf report - Analyzing Profiles

```bash
# Interactive TUI report
perf report

# Non-interactive text report
perf report --stdio

# Show callers/callees for a specific symbol
perf report --symbol-filter=malloc

# Include kernel symbols
perf report --kallsyms=/proc/kallsyms

# Show inline functions
perf report --inline

# Output to file
perf report --stdio > perf_report.txt

# Show with percentage threshold
perf report --min-percent=1.0 --stdio
```

### Annotate - Source-Level Analysis

```bash
# Annotate a specific function with instruction-level data
perf annotate --symbol=my_hot_function --stdio

# Full annotation with source code (requires debug symbols)
perf annotate --symbol=my_hot_function --source --stdio

# Annotate with percentage and source
perf annotate -l --stdio
```

Sample annotation output:

```
Percent |      Source code & Disassembly of mybinary for cycles
----------------------------------------------------------------------
        :      void process_data(uint8_t *data, size_t len) {
        :        size_t i;
        :
  0.12% :          push   %rbp
  0.08% :          mov    %rsp,%rbp
  0.03% :          sub    $0x20,%rsp
        :        for (i = 0; i < len; i++) {
  0.45% :          test   %rsi,%rsi
        :          je     <+0x3e>
 42.87% :          movzbl (%rdi,%rax,1),%ecx    <- Cache miss hot spot
  1.23% :          add    $0x1,%rax
  8.34% :          movzbl 0x1000(%rdi,%rax,1),%edx  <- Stride access
```

## Section 5: Flame Graphs with Brendan Gregg's Tools

Flame graphs are the most effective visualization for sampled CPU profiles. They show the full call stack hierarchy with width proportional to CPU time.

### Setup

```bash
# Clone FlameGraph tools
git clone https://github.com/brendangregg/FlameGraph.git
export PATH=$PATH:$PWD/FlameGraph

# Install required Perl modules
apt-get install -y perl

# Verify tools are available
stackcollapse-perf.pl --version
flamegraph.pl --version
```

### Generating On-CPU Flame Graphs

```bash
# Step 1: Record with frame pointer call graphs
# Build your application with: -fno-omit-frame-pointer
perf record -F 99 -g --call-graph fp -p <PID> sleep 30

# Step 2: Convert perf output to collapsed stacks
perf script | stackcollapse-perf.pl > out.perf-folded

# Step 3: Generate SVG flame graph
flamegraph.pl out.perf-folded > flamegraph.svg

# View in browser
firefox flamegraph.svg

# One-liner: record, convert, render
perf record -F 99 -g -p <PID> sleep 30 && \
perf script | stackcollapse-perf.pl | \
flamegraph.pl --color=java --title="My Service CPU" > cpu-flamegraph.svg
```

### Off-CPU Flame Graphs (Blocking Time)

Off-CPU flame graphs show where threads spend time blocked (waiting for I/O, locks, sleep):

```bash
# Method 1: Using perf sched
# Record scheduler events
perf sched record -a sleep 30

# Generate off-CPU flame graph
perf sched timehist -p <PID> | \
  awk '{print $1, $2}' | \
  flamegraph.pl > offcpu-flamegraph.svg

# Method 2: Using eBPF (more accurate, requires kernel 4.9+)
# Install bcc-tools
apt-get install -y bpfcc-tools

# Record off-CPU time
/usr/share/bcc/tools/offcputime -p <PID> 30 > /tmp/offcpu.txt
flamegraph.pl --color=io --title="Off-CPU" /tmp/offcpu.txt > offcpu-flamegraph.svg
```

### Memory Allocation Flame Graphs

```bash
# Record memory allocations
perf record -e kmem:kmalloc,kmem:mm_page_alloc \
    -g --call-graph dwarf \
    -p <PID> sleep 30

perf script | stackcollapse-perf.pl | \
flamegraph.pl --title="Memory Alloc" --color=mem > mem-flamegraph.svg
```

### Differential Flame Graphs

Compare two profiles to identify regressions:

```bash
# Record baseline
perf record -F 99 -g --call-graph fp ./service_v1
perf script | stackcollapse-perf.pl > baseline.folded

# Record current version
perf record -F 99 -g --call-graph fp ./service_v2
perf script | stackcollapse-perf.pl > current.folded

# Generate differential flame graph
# Red = more time in current, blue = less time in current
difffolded.pl baseline.folded current.folded | \
flamegraph.pl --title="Regression Analysis" > diff-flamegraph.svg
```

## Section 6: Hardware PMU Counter Deep Dive

### Cache Analysis

```bash
# L1, L2, L3 cache miss analysis
perf stat -e \
    L1-dcache-loads,\
    L1-dcache-load-misses,\
    L2-dcache-loads,\
    L2-dcache-load-misses,\
    LLC-loads,\
    LLC-load-misses \
    ./my-binary

# Interpret results:
# L1 miss rate = L1-dcache-load-misses / L1-dcache-loads
# L3 miss rate = LLC-load-misses / LLC-loads
# L3 misses go to DRAM: ~100ns latency vs 4ns for L1
```

### TLB Miss Analysis

Translation Lookaside Buffer misses cause page table walks - expensive on workloads with large, sparse memory access:

```bash
perf stat -e \
    dTLB-loads,\
    dTLB-load-misses,\
    iTLB-loads,\
    iTLB-load-misses \
    ./my-binary

# High dTLB miss rate solutions:
# 1. Use huge pages (madvise MADV_HUGEPAGE)
# 2. Improve memory locality (data-oriented design)
# 3. Reduce working set size
```

### Branch Prediction Analysis

```bash
perf stat -e \
    branch-instructions,\
    branch-misses,\
    branches \
    -p <PID> sleep 10

# For Intel: track specific branch types
perf stat -e \
    cpu/event=0xc4,umask=0x00,name=BR_INST_RETIRED.ALL_BRANCHES/,\
    cpu/event=0xc5,umask=0x00,name=BR_MISP_RETIRED.ALL_BRANCHES/,\
    cpu/event=0xc4,umask=0x08,name=BR_INST_RETIRED.NEAR_CALL/ \
    ./my-binary
```

### Instruction Throughput Analysis

```bash
# Measure IPC and spot execution unit bottlenecks
perf stat -e \
    cycles,\
    instructions,\
    uops_issued.any,\
    uops_executed.thread,\
    uops_retired.retire_slots,\
    int_misc.recovery_cycles \
    ./my-binary

# Low instructions/uop ratio means many micro-ops per instruction
# (complex instructions, SIMD operations are normal)
# High recovery_cycles indicates frequent misprediction recovery
```

## Section 7: perf top - Live CPU Profiling

```bash
# Live interactive top-like profiler
perf top

# Top for specific PID
perf top -p <PID>

# Top with call graph
perf top -g -p <PID>

# Top for specific event
perf top -e cache-misses

# Non-interactive, useful for CI
perf top --stdio --delay 1 --count 10
```

## Section 8: perf trace - System Call Analysis

`perf trace` is a faster alternative to `strace`:

```bash
# Trace system calls for a process
perf trace -p <PID>

# Trace with time stamps
perf trace --time -p <PID>

# Trace only specific syscalls
perf trace -e write,read,open,close -p <PID>

# Summary mode: count syscalls
perf trace --summary -p <PID> sleep 30

# Trace with call stack for slow syscalls
perf trace --call-graph dwarf --max-stack 10 -p <PID>
```

Sample output:

```
     0.000 ( 0.003 ms): write(fd: 5, buf: 0x7f..., count: 4096) = 4096
     0.004 ( 0.012 ms): futex(uaddr: 0x7f..., op: FUTEX_WAKE, val: 1) = 1
     0.017 ( 0.089 ms): read(fd: 6, buf: 0x7f..., count: 65536) = 65536
     0.107 (45.234 ms): read(fd: 7<socket:[12345]>, buf: 0x7f..., count: 4096) = 4096
```

The 45ms read on a socket indicates network latency or a slow remote service.

## Section 9: perf probe - Dynamic Probes

Add probe points to kernel functions or user-space functions without recompilation:

```bash
# List available probe points in a binary
perf probe -x ./my-binary --funcs | head -20

# Add a probe at a function entry
perf probe -x ./my-binary 'process_request'

# Add a probe with argument capture
perf probe -x ./my-binary 'process_request size=size latency=latency'

# Record events at the probe
perf record -e 'probe_mybinary:process_request' \
    -a sleep 30

# Report probe events with arguments
perf script

# Kernel function probe
perf probe --add 'tcp_retransmit_skb'
perf record -e probe:tcp_retransmit_skb -a sleep 30
perf report

# Remove probes
perf probe --del 'process_request'
```

## Section 10: Cache Miss Profiling Workflow

A real-world cache miss investigation:

```bash
# Step 1: Identify that cache misses are significant
perf stat -e cache-misses,cache-references,instructions,cycles ./my-service

# If LLC miss rate > 5%, proceed to Step 2

# Step 2: Find which functions cause cache misses
perf record -e LLC-load-misses -g --call-graph fp ./my-service
perf report --stdio --sort=overhead_us

# Step 3: Generate cache miss flame graph
perf script | stackcollapse-perf.pl | \
flamegraph.pl --title="LLC Miss" --color=mem > llc-miss-flamegraph.svg

# Step 4: Annotate the hot function
perf annotate --symbol=hot_function --source --stdio

# Step 5: Use hardware-prefetch-aware profiling
perf stat -e \
    cpu/event=0xd1,umask=0x04,name=MEM_LOAD_RETIRED.L3_HIT/,\
    cpu/event=0xd1,umask=0x20,name=MEM_LOAD_RETIRED.L3_MISS/,\
    cpu/event=0xd2,umask=0x01,name=MEM_LOAD_L3_HIT_RETIRED.XSNP_MISS/ \
    ./my-service
```

### Memory Access Pattern Analysis

```bash
# Use Intel VTune-style memory access analysis with perf
perf mem record -p <PID> sleep 30
perf mem report --stdio | head -50

# Shows:
# - Which memory addresses are hot
# - Hit/miss ratio per access
# - Estimated cycles lost to cache misses
```

## Section 11: Profiling Go Applications with perf

Go applications require special handling because the Go runtime manages its own stack:

```bash
# Build Go binary with frame pointers (Go 1.12+ does this by default on amd64)
GOFLAGS="-gcflags=all=-e" go build -o myapp ./cmd/myapp

# For older Go versions, disable stack splitting optimization
go build -gcflags="-framepointer=1" -o myapp ./cmd/myapp

# Record CPU profile
perf record -F 99 -g --call-graph fp -p <GO_PID> sleep 30

# Convert - Go uses different mangling for symbols
perf script | stackcollapse-perf.pl --no-inline | \
flamegraph.pl --title="Go Service" --color=java > go-flamegraph.svg

# Resolve Go symbols properly
go tool nm myapp | awk '{print $1, $3}' > /tmp/go-symbols.txt
# Some versions of perf need explicit symbol file
perf report --symfs=/tmp/go-symbols.txt
```

### pprof vs perf for Go

| Feature | pprof | perf |
|---------|-------|------|
| Go runtime overhead | Visible | Visible |
| Kernel time | No | Yes |
| Off-CPU time | No (by default) | Yes |
| Hardware counters | No | Yes |
| Production safety | High | Medium |
| Setup complexity | Low | Medium |

## Section 12: Continuous Profiling in Production

For production systems, continuous profiling with minimal overhead:

```bash
# Low-overhead continuous profiling script
#!/bin/bash
PID=$1
DURATION=${2:-60}
OUTPUT_DIR=${3:-/var/log/perf-profiles}
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "$OUTPUT_DIR"

# Record at 99Hz (not 100Hz to avoid aliasing with timer interrupts)
perf record \
    -F 99 \
    -g \
    --call-graph fp \
    -p "$PID" \
    --output "$OUTPUT_DIR/perf-${DATE}.data" \
    sleep "$DURATION"

# Convert to flame graph
perf script \
    -i "$OUTPUT_DIR/perf-${DATE}.data" | \
    stackcollapse-perf.pl > \
    "$OUTPUT_DIR/perf-${DATE}.folded"

flamegraph.pl \
    "$OUTPUT_DIR/perf-${DATE}.folded" > \
    "$OUTPUT_DIR/perf-${DATE}.svg"

# Cleanup raw perf data (large)
rm "$OUTPUT_DIR/perf-${DATE}.data"

echo "Profile saved to $OUTPUT_DIR/perf-${DATE}.svg"
```

### Kubernetes CronJob for Periodic Profiling

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cpu-profiler
  namespace: monitoring
spec:
  schedule: "0 * * * *"  # Every hour
  jobTemplate:
    spec:
      template:
        spec:
          hostPID: true
          containers:
            - name: profiler
              image: myregistry/perf-tools:latest
              securityContext:
                privileged: true
              command:
                - /bin/bash
                - -c
                - |
                  # Find the target process PID on the host
                  TARGET_PID=$(cat /proc/*/status 2>/dev/null | \
                    grep -A1 "Name:.*api-server" | \
                    grep Pid | awk '{print $2}' | head -1)

                  if [ -z "$TARGET_PID" ]; then
                    echo "Target process not found"
                    exit 1
                  fi

                  perf record -F 99 -g --call-graph fp \
                    -p "$TARGET_PID" sleep 30

                  perf script | stackcollapse-perf.pl | \
                  flamegraph.pl > /profiles/$(date +%Y%m%d-%H%M).svg

              volumeMounts:
                - name: profiles
                  mountPath: /profiles
          volumes:
            - name: profiles
              persistentVolumeClaim:
                claimName: profiles-pvc
          restartPolicy: Never
```

## Section 13: Interpreting Results - Common Performance Patterns

### Pattern 1: CPU-Bound with Poor IPC

Symptoms:
- High CPU usage
- IPC below 1.5
- Low cache miss rate

Causes: Poorly vectorized loops, excessive function call overhead, dependency chains

Investigation:
```bash
perf stat -e cycles,instructions,uops_issued.any ./my-binary
# If uops_issued >> instructions, there's complex instruction decode overhead
# Consider SIMD vectorization or algorithm restructuring
```

### Pattern 2: Memory Latency Bound

Symptoms:
- CPU usage high but IPC very low (0.3-0.5)
- High LLC miss rate (>10%)
- Flame graph shows flat profiles (hard to attribute time)

Investigation:
```bash
# Check if this is NUMA-related
numastat -p <PID>
perf stat -e node-loads,node-load-misses ./my-binary

# Profile with memory access events
perf record -e cpu/mem-loads,ldlat=100/P ./my-binary
perf report --sort=local_weight
```

### Pattern 3: Kernel Time Dominance

Symptoms:
- `perf top` shows significant time in kernel functions
- `vmstat 1` shows high system time

Investigation:
```bash
# Profile with both user and kernel symbols
perf record -a -g --call-graph dwarf sleep 10
perf report --sort=dso_to

# Check specific kernel subsystems
perf record -e syscalls:sys_enter_read,syscalls:sys_enter_write \
    -p <PID> sleep 10
perf report --sort=trace
```

## Summary

The `perf` tool provides an unmatched view into system performance that spans from hardware PMU events up through the application call stack. The practical workflow is:

1. **Characterize** with `perf stat` to identify whether the bottleneck is CPU, memory, or I/O bound
2. **Sample** with `perf record -g` to capture call stacks
3. **Visualize** with `flamegraph.pl` to identify the hot paths
4. **Drill down** with `perf annotate` to reach instruction-level analysis
5. **Compare** with differential flame graphs to validate optimizations

For production use, build binaries with `-fno-omit-frame-pointer` (or rely on Go's default) and maintain a procedure for safely running `perf` on production hosts with appropriate kernel.perf_event_paranoid settings.
