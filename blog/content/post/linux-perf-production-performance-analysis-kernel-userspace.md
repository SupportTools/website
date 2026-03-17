---
title: "Linux perf: Production Performance Analysis for Kernel and Userspace"
date: 2030-05-22T00:00:00-05:00
draft: false
tags: ["Linux", "perf", "Performance", "Profiling", "Kernel", "Flame Graphs", "CPU Counters", "Production"]
categories:
- Linux
- Performance
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux perf tool: CPU sampling, hardware performance counters, call graph recording, flame graph generation, and using perf for production bottleneck analysis."
more_link: "yes"
url: "/linux-perf-production-performance-analysis-kernel-userspace/"
---

Linux `perf` is the Swiss Army knife of performance analysis on Linux systems. Unlike application-level profilers that only see userspace code, `perf` can sample across the entire system stack: kernel interrupt handlers, system call paths, hardware event counters, and userspace application code, all with a single tool. This cross-layer visibility is invaluable when investigating performance problems that span the application-OS boundary—cache misses in memory allocators, scheduling latency spikes, or TLB shootdowns caused by large memory mappings.

<!--more-->

## Installation and Prerequisites

```bash
# Install perf (kernel version must match running kernel)
apt-get install -y linux-tools-$(uname -r) linux-tools-generic

# Verify installation
perf --version
# perf version 6.1.76

# Allow unprivileged perf sampling (for development environments)
# Production systems should use privileged access
echo -1 > /proc/sys/kernel/perf_event_paranoid

# Enable kernel symbols (required for kernel call graphs)
echo 0 > /proc/sys/kernel/kptr_restrict

# Disable NMI watchdog to free up hardware counters
echo 0 > /proc/sys/kernel/nmi_watchdog
```

### Preserving Debug Symbols

perf requires debug symbols to translate program counter addresses into function names. On production systems, install debuginfo packages or use symbol servers.

```bash
# Ubuntu: install debug symbols
apt-get install -y ubuntu-dbgsym-keyring
echo "deb http://ddebs.ubuntu.com $(lsb_release -cs) main restricted universe multiverse" \
  >> /etc/apt/sources.list.d/ddebs.list
apt-get update && apt-get install -y golang-go-dbgsym nginx-dbgsym

# For Go binaries: build with frame pointers enabled
# (default in Go 1.12+, but verify)
go build -ldflags="-compressdwarf=false" ./cmd/api-server/

# For C/C++ binaries: build with debug info
gcc -g -fno-omit-frame-pointer -O2 -o myapp myapp.c

# Check if a binary has symbols
nm /usr/bin/nginx | head -5
# or
file /usr/bin/nginx
# ELF 64-bit LSB shared object, ... not stripped
```

## CPU Sampling with `perf record`

### Basic CPU Profile

```bash
# Record a CPU profile for 30 seconds of a specific PID
perf record -g -p $(pgrep -f api-server) -- sleep 30

# Record all processes on the system (requires root)
perf record -g -a -- sleep 30

# Record with call graph using DWARF unwinding (better for JIT-heavy code)
perf record -g --call-graph dwarf -p $(pgrep -f api-server) -- sleep 30

# Record with call graph using frame pointers (faster, requires -fno-omit-frame-pointer)
perf record -g --call-graph fp -p $(pgrep -f api-server) -- sleep 30

# Higher sampling rate for short-lived hotspots (default: 1000 Hz)
perf record -F 4000 -g -p $(pgrep -f api-server) -- sleep 10
```

### Analyzing perf.data

```bash
# Display top functions by CPU time (flat profile)
perf report --stdio --no-children | head -50

# Full interactive TUI (shows call trees)
perf report

# Sample output:
# Samples: 12K of event 'cpu-clock', Event count (approx.): 3000000000
# Overhead  Command     Shared Object        Symbol
#   32.45%  api-server  api-server           [.] runtime.mallocgc
#   18.22%  api-server  [kernel.kallsyms]    [k] copy_user_enhanced_fast_string
#   12.08%  api-server  api-server           [.] encoding/json.Marshal
#    8.41%  api-server  [kernel.kallsyms]    [k] futex_wait_queue_me
#    5.33%  api-server  libc.so.6            [.] __memcpy_avx_unaligned

# Show annotated source for a specific function
perf annotate --stdio runtime.mallocgc

# Export to script format for further processing
perf script > /tmp/perf.script
```

## Hardware Performance Counters

### Available Hardware Events

```bash
# List all available events
perf list

# Key hardware events:
# cpu-cycles             - CPU clock cycles consumed
# instructions           - instructions retired (executed)
# cache-references       - Last level cache accesses
# cache-misses           - Last level cache misses
# branch-instructions    - Branches executed
# branch-misses          - Mispredicted branches
# L1-dcache-loads        - L1 data cache loads
# L1-dcache-load-misses  - L1 data cache load misses
# LLC-loads              - Last Level Cache loads
# LLC-load-misses        - LLC load misses (expensive: goes to DRAM)

# Software events:
# task-clock             - CPU time (ms)
# page-faults            - Page fault count
# context-switches       - OS context switches
# cpu-migrations         - Process migrations between CPUs
# minor-faults           - Minor page faults (no disk I/O)
# major-faults           - Major page faults (requires disk I/O)
```

### Performance Counter Measurement

```bash
# Quick stat for a command
perf stat ./benchmark-binary

# Output:
# Performance counter stats for './benchmark-binary':
#
#         12,345.67 msec task-clock               # 3.987 CPUs utilized
#             1,234      context-switches          # 99.962 /sec
#                42      cpu-migrations            # 3.403 /sec
#            28,394      page-faults              # 2.300 K/sec
#    45,678,901,234      cycles                   # 3.700 GHz
#    23,456,789,012      instructions             # 0.51  insn per cycle
#     4,567,890,123      branches                 # 369.950 M/sec
#        89,012,345      branch-misses            # 1.95% of all branches
#
#       3.094917352 seconds time elapsed

# Measure specific hardware events
perf stat -e \
  cycles,instructions,\
  L1-dcache-loads,L1-dcache-load-misses,\
  LLC-loads,LLC-load-misses,\
  branch-instructions,branch-misses \
  -p $(pgrep api-server) -- sleep 10

# Compute derived metrics
perf stat -e cycles,instructions \
  ./benchmark 2>&1 | awk '
  /instructions/ { instr = $1 }
  /cycles/ { cycles = $1 }
  END { printf "IPC: %.2f\n", instr/cycles }'
```

### Cache Miss Analysis

```bash
# Identify code paths with high LLC miss rates
perf record -e LLC-load-misses -g -p $(pgrep api-server) -- sleep 30
perf report --stdio | head -30

# Sample output indicates where cache misses occur:
# Samples: 3K of event 'LLC-load-misses', Event count (approx.): 45123456
# Overhead  Command     Shared Object  Symbol
#   28.45%  api-server  api-server     [.] runtime.scanobject
#   18.22%  api-server  api-server     [.] runtime.greyobject

# Detailed LLC miss analysis per memory access instruction
perf mem record -p $(pgrep api-server) -- sleep 10
perf mem report --stdio | head -30
```

## Call Graph Flame Graphs

### Generating Flame Graphs

```bash
# Install FlameGraph tools
git clone https://github.com/brendangregg/FlameGraph /opt/FlameGraph

# Collect CPU profile with call graphs
perf record -F 99 -g -a -- sleep 60

# Convert to flame graph
perf script \
  | /opt/FlameGraph/stackcollapse-perf.pl \
  | /opt/FlameGraph/flamegraph.pl \
    --title "CPU Flame Graph - $(hostname) - $(date)" \
    --width 1600 \
    --height 16 \
  > /tmp/cpu-flame.svg

# View in browser
firefox /tmp/cpu-flame.svg
```

### Off-CPU Flame Graphs (Scheduling Latency)

Off-CPU analysis identifies where processes are waiting (blocked on I/O, locks, sleep) rather than where they are executing.

```bash
# Trace scheduler switch events to find blocking
perf record -e sched:sched_switch -ag -- sleep 30
perf script | /opt/FlameGraph/stackcollapse-perf.pl \
  | /opt/FlameGraph/flamegraph.pl --color=io \
    --title "Off-CPU Flame Graph" \
  > /tmp/offcpu-flame.svg
```

### Differential Flame Graphs

Differential flame graphs highlight performance changes between two versions or configurations.

```bash
# Profile before optimization
perf record -F 99 -g -p $(pgrep api-server-v1) -- sleep 30
perf script | /opt/FlameGraph/stackcollapse-perf.pl > /tmp/before.folded

# Profile after optimization
perf record -F 99 -g -p $(pgrep api-server-v2) -- sleep 30
perf script | /opt/FlameGraph/stackcollapse-perf.pl > /tmp/after.folded

# Generate differential flame graph
# Positive values (red): more time in v2 than v1
# Negative values (blue): less time in v2 than v1
/opt/FlameGraph/difffolded.pl /tmp/before.folded /tmp/after.folded \
  | /opt/FlameGraph/flamegraph.pl --negate --title "CPU Diff (After vs Before)" \
  > /tmp/diff-flame.svg
```

## Tracing Specific Events

### System Call Tracing

```bash
# Count system calls made by a process
perf stat -e 'syscalls:sys_enter_*' -p $(pgrep api-server) -- sleep 10 2>&1 \
  | sort -rn | head -20

# Trace individual system calls with timing
perf trace -p $(pgrep api-server) -e read,write,epoll_wait --duration 5000

# Output example:
#    0.000 ( 0.045 ms): api-server/1234 epoll_wait(epfd: 5, events: 0x7f..., maxevents: 1024, timeout: 10) = 1
#    0.045 ( 0.012 ms): api-server/1234 read(fd: 8, buf: 0x7f..., count: 65536) = 1024
#    0.057 ( 0.031 ms): api-server/1234 write(fd: 8, buf: 0x7f..., count: 512) = 512

# Find system calls contributing most to elapsed time
perf trace --summary -p $(pgrep api-server) -- sleep 10 2>&1 \
  | sort -k2 -rn | head -20
```

### Scheduler Analysis

```bash
# Measure CPU scheduling latency (time from runnable to running)
perf sched record -- sleep 30
perf sched latency

# Output shows per-thread scheduling statistics:
# ---------------------------------------------------------------------------------------------------------------
# Task                  |   Runtime ms  | Switches | Average delay ms | Maximum delay ms | Maximum delay at     |
# ---------------------------------------------------------------------------------------------------------------
# api-server:1234       |   8765.432 ms |    12345 | avg:   0.012 ms  | max:   2.345 ms  | max at: 18.234 s    |

# Show scheduling timeline
perf sched timehist | head -50

# Identify tasks with longest wait times
perf sched latency --sort=max 2>&1 | head -20
```

### Lock Contention Analysis

```bash
# Record lock contention (requires kernel compiled with perf lock support)
perf lock record -p $(pgrep api-server) -- sleep 30
perf lock report --verbose

# Output:
# Name   : pthread_mutex_lock
# Address: 0x7f8d4c2a1b20
# Contended: 1234 times
# Total wait: 456.789 ms
# Max wait:   12.345 ms
```

## Probing Kernel and Userspace Functions

### Dynamic Tracepoints with kprobes

```bash
# Probe a kernel function and record call stacks
perf probe --add 'tcp_sendmsg'
perf record -e probe:tcp_sendmsg -ag -- sleep 30
perf report --stdio

# Probe with argument capture (print first argument of tcp_sendmsg: socket pointer)
perf probe --add 'tcp_sendmsg sk'
perf record -e probe:tcp_sendmsg -ag -- sleep 10
perf script | head -20

# Remove the probe when done
perf probe --del 'probe:tcp_sendmsg'

# List available probe points in a kernel function
perf probe -L tcp_sendmsg
```

### Userspace Probes with uprobes

```bash
# Probe a userspace function by address or symbol
# First, find the symbol offset
perf probe -x /usr/local/bin/api-server -F \
  | grep -i "handleRequest"

# Add a uprobe on the function
perf probe -x /usr/local/bin/api-server \
  --add 'handleRequest'

# Record calls with backtraces
perf record -e probe_api_server:handleRequest -ag -- sleep 30
perf report --stdio | head -30

# Clean up
perf probe --del probe_api_server:handleRequest
```

## Memory and I/O Analysis

### Memory Access Profiling

```bash
# Record memory load events (requires Intel Processor Trace or equivalent)
perf record -e '{cpu/mem-loads,ldlat=30/P,cpu/mem-stores/P}' \
  -p $(pgrep api-server) -- sleep 10

perf mem report --stdio | head -30

# Output shows:
# Overhead  Samples  Local Weight  Mem access
#   45.23%     1234      avg:  42  L1 hit
#   18.11%      489      avg: 128  LFB hit (Line Fill Buffer)
#    8.45%      228      avg: 242  L2 hit
#    5.34%      144      avg: 430  L3 hit
#    2.18%       59      avg: 201  Local RAM hit    ← expensive
#    0.45%       12      avg: 450  Remote RAM hit   ← very expensive
```

### Disk I/O Analysis

```bash
# Trace block I/O events
perf record -e block:block_rq_complete -ag -- sleep 30

# Analyze block I/O patterns
perf script | awk '
  /block:block_rq_complete/ {
    # Extract device, sectors, and operation type
    if (match($0, /dev=([0-9:]+).*sectors=([0-9]+).*op=([A-Z]+)/, arr)) {
      ops[arr[3]]++
      bytes[arr[3]] += arr[2] * 512
    }
  }
  END {
    for (op in ops)
      printf "%s: %d ops, %.2f MiB\n", op, ops[op], bytes[op]/1048576
  }'
```

## Production Profiling Scripts

### Non-Invasive Production Profile

```bash
#!/bin/bash
# scripts/perf-production-snapshot.sh
# Capture a CPU profile from production without significant overhead.
# Uses 99 Hz sampling rate (avoids lock-step with 100Hz timer interrupts).

set -euo pipefail

SERVICE="${1:?usage: $0 <service-name> [duration-seconds]}"
DURATION="${2:-30}"
PID=$(pgrep -f "${SERVICE}" | head -1)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_DIR="/var/lib/perf-captures/${TIMESTAMP}-${SERVICE}"

if [ -z "${PID}" ]; then
  echo "Error: process '${SERVICE}' not found" >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

echo "Capturing CPU profile for PID ${PID} (${SERVICE}) for ${DURATION}s..."

# Capture with frame pointer-based call graphs
# Requires binary built with -fno-omit-frame-pointer (Go: default since 1.12)
perf record \
  -F 99 \
  -g --call-graph fp \
  -p "${PID}" \
  -o "${OUTPUT_DIR}/perf.data" \
  -- sleep "${DURATION}"

echo "Profile captured. Generating reports..."

# Text report
perf report --stdio \
  -i "${OUTPUT_DIR}/perf.data" \
  --no-children \
  > "${OUTPUT_DIR}/report.txt" 2>&1

# Flame graph
perf script -i "${OUTPUT_DIR}/perf.data" \
  | /opt/FlameGraph/stackcollapse-perf.pl \
  | /opt/FlameGraph/flamegraph.pl \
    --title "${SERVICE} CPU Profile - $(date)" \
    --width 1600 \
  > "${OUTPUT_DIR}/flamegraph.svg"

echo "Results saved to ${OUTPUT_DIR}/"
echo ""
echo "Top 10 CPU consumers:"
head -20 "${OUTPUT_DIR}/report.txt"
```

### Automated Performance Regression Detection

```bash
#!/bin/bash
# scripts/perf-regression-check.sh
# Run a benchmark under perf and compare against a baseline.
# Fails if any counter exceeds threshold compared to baseline.

BINARY="${1:?}"
BASELINE_FILE="${2:-/var/lib/perf-baselines/$(basename ${BINARY}).baseline}"

run_perf_stat() {
  perf stat \
    -e cycles,instructions,cache-misses,LLC-load-misses,branch-misses \
    -o /tmp/perf-stat.txt \
    --field-separator , \
    -- "${BINARY}" 2>&1
  cat /tmp/perf-stat.txt
}

if [ ! -f "${BASELINE_FILE}" ]; then
  echo "No baseline found. Creating baseline..."
  run_perf_stat | tee "${BASELINE_FILE}"
  echo "Baseline saved to ${BASELINE_FILE}"
  exit 0
fi

echo "Running performance regression check..."
CURRENT=$(run_perf_stat)

# Compare key metrics
while IFS=, read -r count unit event rest; do
  baseline_count=$(grep ",${event}," "${BASELINE_FILE}" | cut -d, -f1 | tr -d ' ')
  if [ -n "${baseline_count}" ] && [ "${baseline_count}" -gt 0 ]; then
    pct_change=$(echo "scale=1; (${count} - ${baseline_count}) * 100 / ${baseline_count}" | bc)
    echo "${event}: ${baseline_count} → ${count} (${pct_change}%)"
    if awk "BEGIN{exit !(${pct_change} > 15)}"; then
      echo "REGRESSION DETECTED: ${event} increased by ${pct_change}%"
      exit 1
    fi
  fi
done < <(echo "${CURRENT}" | grep -E '^\s*[0-9]')

echo "No performance regressions detected."
```

## perf + BPF for Advanced Analysis

### Using perf with BPF Programs

```bash
# perf supports attaching BPF programs to tracepoints
# This enables filtering and aggregation in kernel space

cat > /tmp/trace_latency.c << 'EOF'
#include <uapi/linux/ptrace.h>

BPF_HASH(start_times, u32, u64);
BPF_HISTOGRAM(latency_hist, u64);

void trace_syscall_enter(struct pt_regs *ctx) {
    u32 tid = bpf_get_current_pid_tgid();
    u64 ts = bpf_ktime_get_ns();
    start_times.update(&tid, &ts);
}

void trace_syscall_exit(struct pt_regs *ctx) {
    u32 tid = bpf_get_current_pid_tgid();
    u64 *start = start_times.lookup(&tid);
    if (start) {
        u64 latency = bpf_ktime_get_ns() - *start;
        latency_hist.increment(bpf_log2l(latency));
        start_times.delete(&tid);
    }
}
EOF

# For modern BPF-based tracing, bpftrace is often more ergonomic:
bpftrace -e '
kprobe:do_sys_open {
    @start[tid] = nsecs;
}
kretprobe:do_sys_open /@start[tid]/ {
    @us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'
```

## Interpreting perf Results

### Key Metrics and Their Meaning

| Metric | Good Value | Concern | Action |
|--------|-----------|---------|--------|
| IPC (insn/cycle) | > 1.0 | < 0.5 | Memory latency or branch mispredictions |
| Branch miss rate | < 1% | > 5% | Improve branch prediction; avoid unpredictable branches |
| LLC miss rate | < 1% | > 5% | Review data structures for cache friendliness |
| Context switches | Low for CPU-bound | High for I/O-bound | Expected; correlate with latency |
| CPU migrations | < 1% of context switches | > 5% | Set CPU affinity or tune scheduler |

### Reading Annotated Output

```bash
perf annotate --stdio -f runtime.mallocgc | head -50

# Output shows hot assembly instructions:
#
# Percent |      Source code & Disassembly of api-server for cycles
# ------------------------------------------------
#         :
#    8.45 :   48 8d 4c 24 08      lea    0x8(%rsp),%rcx
#   24.32 :   48 89 ca           mov    %rcx,%rdx
#    0.12 :   e8 xx xx xx xx     callq  runtime.memclrNoHeapPointers
#   12.01 :   48 83 c4 40        add    $0x40,%rsp
#
# High percentages on specific instructions identify the exact hot path
```

### Common Performance Patterns

```bash
# High runtime.mallocgc → excessive heap allocations
# Fix: reduce allocations, use sync.Pool, pre-allocate slices

# High futex_wait_queue_me → goroutine contention on mutex
# Fix: reduce lock granularity, use lock-free structures, shard locks

# High copy_user_enhanced_fast_string → large data copies between user/kernel
# Fix: use io_uring, reduce syscall data sizes, increase buffer sizes

# High schedule → frequent goroutine context switches
# Fix: reduce goroutine count, use worker pools, avoid tight loops

# High kswapd → memory pressure causing frequent page reclaim
# Fix: reduce memory usage, increase memory limits, tune vm.swappiness
```

The Linux `perf` tool, combined with flame graph visualization and hardware counter analysis, provides a complete picture of application performance that no single-layer profiler can match. The ability to correlate application-level CPU time with kernel scheduler latency, cache miss rates, and system call patterns enables precise identification of bottlenecks that would be invisible to tools operating at only one layer of the stack.
