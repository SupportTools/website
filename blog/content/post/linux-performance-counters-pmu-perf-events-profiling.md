---
title: "Linux Performance Counters: PMU, perf Events, and Hardware-Level Profiling"
date: 2030-03-08T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "perf", "PMU", "Profiling", "Intel PT", "Hardware"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to CPU performance monitoring units, perf hardware event analysis, cache miss profiling, branch misprediction analysis, Intel PT execution tracing, and AMD IBS for production workload optimization."
more_link: "yes"
url: "/linux-performance-counters-pmu-perf-events-profiling/"
---

Hardware performance counters provide the most accurate picture of what a CPU is actually doing — measuring events like cache misses, branch mispredictions, and TLB faults at the cycle level, without the instrumentation overhead of software profilers. The Linux `perf` subsystem provides a unified interface to these counters across Intel, AMD, and ARM architectures. Understanding how to use this toolchain effectively separates engineers who guess at performance problems from those who measure them precisely.

<!--more-->

## Hardware Performance Monitoring Unit (PMU) Architecture

Modern CPUs contain a Performance Monitoring Unit — a set of special-purpose registers that count hardware events. Each CPU core has a fixed number of programmable counter registers (typically 4-8) and a smaller number of fixed-function counters.

### Counter Types

**Programmable (general-purpose) counters** can be configured to count any supported event. On Intel Skylake+, there are typically 4 general-purpose counters per core.

**Fixed-function counters** always count specific events with lower overhead:
- Fixed counter 0: Instructions retired
- Fixed counter 1: Unhalted core cycles
- Fixed counter 2: Unhalted reference cycles (at TSC frequency)

**Uncore PMU** counters measure off-core events: memory controller bandwidth, LLC (Last Level Cache) statistics, QPI/UPI interconnect traffic, and PCIe bandwidth.

```bash
# Discover available PMU types on your system
ls /sys/devices/ | grep -E "(cpu|uncore|intel|amd|power)"
# cpu
# intel_pt
# intel_bts
# uncore_imc_0
# uncore_imc_1
# uncore_cha_0  (Coherence engine / LLC slice)
# power

# Get detailed PMU capabilities
cat /sys/devices/cpu/caps/pmu_name
# skylake

# Check the number of hardware counters
cat /sys/devices/cpu/caps/max_precise_ip
# 2

# On recent kernels, check perf_event_paranoid
cat /proc/sys/kernel/perf_event_paranoid
# 2  (restrictive - users cannot profile kernel)
# 1  (allows kernel profiling)
# -1 (allows all profiling, including raw PMU access)

# For production profiling by non-root users
sysctl -w kernel.perf_event_paranoid=1
# Make persistent:
echo "kernel.perf_event_paranoid = 1" >> /etc/sysctl.d/99-perf.conf
```

### The perf_event_open System Call

The `perf_event_open(2)` system call is the kernel interface that all perf tools use. Understanding its structure helps when writing custom profilers.

```c
#include <linux/perf_event.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>

static long perf_event_open(struct perf_event_attr *hw_event,
                             pid_t pid, int cpu,
                             int group_fd, unsigned long flags)
{
    return syscall(__NR_perf_event_open, hw_event, pid, cpu, group_fd, flags);
}

// Count hardware cache misses for a specific process
int count_cache_misses(pid_t pid, uint64_t duration_ms) {
    struct perf_event_attr pe;
    int fd;
    uint64_t count;

    memset(&pe, 0, sizeof(pe));
    pe.type           = PERF_TYPE_HARDWARE;
    pe.size           = sizeof(pe);
    pe.config         = PERF_COUNT_HW_CACHE_MISSES;
    pe.disabled       = 1;    // Start disabled
    pe.exclude_kernel = 0;    // Count kernel events too
    pe.exclude_hv     = 1;    // Exclude hypervisor events

    // pid=target process, cpu=-1=all CPUs, group_fd=-1=new group
    fd = perf_event_open(&pe, pid, -1, -1, 0);
    if (fd == -1) {
        fprintf(stderr, "perf_event_open failed: %s\n", strerror(errno));
        return -1;
    }

    // Enable counting
    ioctl(fd, PERF_EVENT_IOC_RESET, 0);
    ioctl(fd, PERF_EVENT_IOC_ENABLE, 0);

    // Wait for the measurement period
    usleep(duration_ms * 1000);

    // Disable and read
    ioctl(fd, PERF_EVENT_IOC_DISABLE, 0);
    read(fd, &count, sizeof(count));

    printf("Cache misses: %lu\n", count);
    close(fd);
    return 0;
}

// Count multiple events simultaneously using an event group
int count_event_group(pid_t pid) {
    struct perf_event_attr pe;
    int fd_instructions, fd_cycles, fd_cache_misses;
    uint64_t values[3];

    // Instructions (group leader)
    memset(&pe, 0, sizeof(pe));
    pe.type    = PERF_TYPE_HARDWARE;
    pe.size    = sizeof(pe);
    pe.config  = PERF_COUNT_HW_INSTRUCTIONS;
    pe.disabled = 1;
    pe.read_format = PERF_FORMAT_GROUP | PERF_FORMAT_ID;

    fd_instructions = perf_event_open(&pe, pid, -1, -1, 0);

    // CPU cycles (member of group)
    pe.config   = PERF_COUNT_HW_CPU_CYCLES;
    pe.disabled = 0;
    fd_cycles = perf_event_open(&pe, pid, -1, fd_instructions, 0);

    // Cache misses (member of group)
    pe.config = PERF_COUNT_HW_CACHE_MISSES;
    fd_cache_misses = perf_event_open(&pe, pid, -1, fd_instructions, 0);

    // Enable the whole group atomically
    ioctl(fd_instructions, PERF_EVENT_IOC_RESET,  PERF_IOC_FLAG_GROUP);
    ioctl(fd_instructions, PERF_EVENT_IOC_ENABLE, PERF_IOC_FLAG_GROUP);

    usleep(100000); // 100ms

    ioctl(fd_instructions, PERF_EVENT_IOC_DISABLE, PERF_IOC_FLAG_GROUP);

    // Read all group counters
    struct {
        uint64_t nr;
        uint64_t values[3];
    } result;
    read(fd_instructions, &result, sizeof(result));

    printf("Instructions: %lu\n", result.values[0]);
    printf("Cycles:       %lu\n", result.values[1]);
    printf("IPC:          %.2f\n", (double)result.values[0] / result.values[1]);
    printf("Cache misses: %lu\n", result.values[2]);

    close(fd_instructions);
    close(fd_cycles);
    close(fd_cache_misses);
    return 0;
}
```

## perf: The Linux Profiling Tool

The `perf` tool provides a comprehensive interface to the PMU and the broader perf_events subsystem.

### Hardware Event Enumeration

```bash
# List all available hardware events
perf list hardware

# Sample output:
# cpu-cycles OR cycles                     [Hardware event]
# instructions                             [Hardware event]
# cache-references                         [Hardware event]
# cache-misses                             [Hardware event]
# branch-instructions OR branches          [Hardware event]
# branch-misses                            [Hardware event]
# bus-cycles                               [Hardware event]
# stalled-cycles-frontend                  [Hardware event]
# stalled-cycles-backend                   [Hardware event]

# List software events (kernel counters)
perf list software

# List hardware cache events (generic across architectures)
perf list cache

# List tracepoints
perf list tracepoint | head -30

# List PMU-specific events (processor-specific)
perf list pmu | head -50

# For Intel, list all available events from the event database
# (requires perf with event database support)
perf list | grep -i "L1\|L2\|L3\|LLC" | head -20
```

### Counting Events with perf stat

`perf stat` is the workhorse for quick performance characterization:

```bash
# Basic statistics for a command
perf stat ls -la /usr

# Output includes:
# Performance counter stats for 'ls -la /usr':
#       1.23 msec task-clock        # 0.989 CPUs utilized
#          0      context-switches  # 0.000 K/sec
#          0      cpu-migrations    # 0.000 K/sec
#         97      page-faults       # 78.844 K/sec
#  3,456,789      cycles            # 2.808 GHz
#  4,567,890      instructions      # 1.32 insn per cycle
#    234,567      branches          # 190.545 M/sec
#      1,234      branch-misses     # 0.53% of all branches

# Comprehensive CPU utilization breakdown
perf stat -e \
    cycles,instructions,\
    cache-references,cache-misses,\
    branch-instructions,branch-misses,\
    stalled-cycles-frontend,stalled-cycles-backend,\
    L1-dcache-loads,L1-dcache-load-misses,\
    LLC-loads,LLC-load-misses \
    -- your-program

# Count for all CPUs system-wide for 10 seconds
sudo perf stat -a sleep 10

# Count for a running process
sudo perf stat -p $(pgrep nginx) sleep 10

# Per-CPU breakdown
sudo perf stat -a --per-cpu sleep 5

# Per-NUMA node breakdown
sudo perf stat -a --per-node sleep 5

# Repeat for statistical significance
perf stat -r 5 your-benchmark

# Output in machine-readable format for parsing
perf stat -o /tmp/stats.txt --field-separator=, your-program
```

### CPU Cycle and IPC Analysis

Instructions Per Cycle (IPC) is the most important high-level metric. Low IPC means the CPU is spending most time waiting — for memory, for branch resolution, or stalled on dependencies.

```bash
# Detailed IPC and stall analysis
perf stat -e \
    cycles:u,\
    instructions:u,\
    stalled-cycles-frontend:u,\
    stalled-cycles-backend:u \
    -- your-program

# Interpret results:
# IPC = instructions / cycles
# Frontend stall % = stalled-cycles-frontend / cycles * 100
# Backend stall %  = stalled-cycles-backend  / cycles * 100

# High frontend stalls = instruction cache misses, branch mispredictions
# High backend stalls  = data cache misses, memory latency, execution unit contention

# Use Intel's Top-Down analysis (requires perf + Intel PT or PEBS)
# Level 1 breakdown
sudo perf stat -M TopdownL1 -- your-program

# Sample output:
# Frontend_Bound:  15.2%  (decode queue underruns)
# Backend_Bound:   42.1%  (memory/execution stalls)
#   Memory_Bound:  35.6%  (memory hierarchy stalls)
#   Core_Bound:     6.5%  (execution unit stalls)
# Bad_Speculation: 8.3%  (branch mispredictions + machine clears)
# Retiring:        34.4%  (useful work)
```

## Cache Miss Analysis

Cache misses are the most common cause of poor performance in data-intensive workloads. The CPU cache hierarchy has L1 (4 cycles), L2 (12 cycles), L3 (40-60 cycles), and DRAM (200-300 cycles) latencies.

```bash
# L1 cache analysis
perf stat -e \
    L1-dcache-loads,\
    L1-dcache-load-misses,\
    L1-dcache-stores,\
    L1-dcache-store-misses,\
    L1-icache-loads,\
    L1-icache-load-misses \
    -- your-program

# L2 and LLC analysis
perf stat -e \
    l2_rqsts.all_demand_data_rd,\
    l2_rqsts.demand_data_rd_hit,\
    l2_rqsts.demand_data_rd_miss,\
    LLC-loads,\
    LLC-load-misses,\
    LLC-stores,\
    LLC-store-misses \
    -- your-program

# DRAM bandwidth measurement (uncore)
# Must be run as root to access uncore PMUs
sudo perf stat -e \
    uncore_imc_0/cas_count_read/,\
    uncore_imc_0/cas_count_write/,\
    uncore_imc_1/cas_count_read/,\
    uncore_imc_1/cas_count_write/ \
    -a sleep 1

# Calculate bandwidth: (cas_count_read + cas_count_write) * 64 bytes / time

# TLB miss analysis
perf stat -e \
    dTLB-loads,dTLB-load-misses,\
    dTLB-stores,dTLB-store-misses,\
    iTLB-loads,iTLB-load-misses \
    -- your-program
```

### Sampling for Cache Miss Hotspots

`perf record` uses sampling to find which code lines cause the most cache misses:

```bash
# Record LLC miss samples (every 1000 LLC misses, sample the instruction pointer)
sudo perf record -e LLC-load-misses:u \
    -c 1000 \
    --call-graph dwarf \
    -- your-program

# View the report
perf report

# Annotate specific functions with cache miss attribution
perf report --stdio --no-children | head -50

# Drill into a specific function
perf annotate --stdio memcpy

# Memory access latency profiling with MEM_TRANS_RETIRED (Intel, requires PEBS)
# pebs = Processor Event-Based Sampling, avoids skid
sudo perf record -e cpu/mem-loads,ldlat=50/P \
    --call-graph dwarf \
    -- your-program

# View memory access latency distribution
perf mem report
```

### Understanding the Perf Report Output

```bash
# Sample perf report output:
# Samples: 50K of event 'LLC-load-misses', Event count (approx.): 1,000,000
# Children      Self  Command  Shared Object     Symbol
# +   35.12%    35.12%  myapp   myapp            [.] process_batch
# +   28.45%    28.45%  myapp   myapp            [.] lookup_value
# +   15.23%    15.23%  myapp   libc.so.6        [.] malloc
#
# Press Enter on process_batch to annotate:
# Percent | Source code
# --------+----------------------------------
#  35.12% | for (int i = 0; i < n; i++) {
#         |     result += data[indices[i]];  <-- indirect access = cache miss
#         | }

# Use --percent-limit to show only significant functions
perf report --percent-limit 1.0
```

## Branch Misprediction Analysis

Modern CPUs speculatively execute instructions based on branch prediction. A mispredicted branch costs 15-20 cycles (the pipeline must be flushed and re-filled).

```bash
# Count branch mispredictions
perf stat -e \
    branch-instructions:u,\
    branch-misses:u,\
    branches,\
    branch-loads,\
    branch-load-misses \
    -- your-program

# Misprediction rate = branch-misses / branches * 100
# > 1% is worth investigating
# > 5% is significant

# Find which branches are mispredicted most
sudo perf record -e branch-misses:u \
    -c 100 \
    --call-graph dwarf \
    --branch-filter any,u \
    -- your-program

perf report

# Branch trace analysis (using BTS or LBR)
# LBR = Last Branch Record, 16-32 most recent branches, zero-overhead
sudo perf record -b -e cycles:u -- your-program
perf report --branch-history

# Show branch statistics per function
perf report --sort=dso,sym --branch-stack
```

### Analyzing Specific Code Patterns

```bash
# Finding branch-heavy loops
# First, identify the hot function with branches
perf report --stdio | grep -A 5 "branch-misses"

# Then annotate it
perf annotate your_function --stdio

# Common patterns causing mispredictions:
# 1. Unpredictable if/else in hot loops
#    -> Solution: Sort data, use branchless alternatives
# 2. Virtual function calls (indirect branches)
#    -> Solution: Devirtualize hot paths
# 3. Switch statements on random values
#    -> Solution: Hash maps, computed gotos

# Profile a specific function for branch mispredictions
sudo perf record -e branch-misses:u \
    --call-graph fp \
    -g \
    -- your-program

perf report --call-graph callee --stdio | head -40
```

## Intel Processor Trace (Intel PT)

Intel PT provides hardware-assisted execution tracing — a complete record of every instruction executed, including branches taken and not taken, at near-zero overhead.

```bash
# Check if Intel PT is available
cat /sys/devices/intel_pt/type
# 8  (if PT is available)

# Check PT capabilities
cat /sys/devices/intel_pt/caps/topa_multiple_entries
cat /sys/devices/intel_pt/caps/single_range_output
cat /sys/devices/intel_pt/caps/ptwrite

# Basic Intel PT trace collection
# WARNING: PT generates enormous amounts of data quickly
# Use time limits and filtering

# Trace a single process for 1 second
sudo perf record \
    -e intel_pt// \
    --call-graph no \
    -p $(pgrep myapp) \
    sleep 1

# View the trace
perf script --itrace=i1000ns --ns > trace.txt
# i1000ns = synthesize instruction events every 1000ns

# Trace with call graph reconstruction
perf script --itrace=cre --ns | head -100

# Branch-level trace (every taken branch)
perf script --itrace=b --ns | head -50

# Decode PT data to assembly instruction stream
# (huge output - pipe to head or grep)
perf script --itrace=i100ns | grep "your_function" | head -20
```

### PT for Latency Analysis

```bash
# Measure exact latency of a function using PT
# 1. Record with PT
sudo perf record -e intel_pt// -p $(pgrep myapp) -- sleep 5

# 2. Use perf-script with timing to find function entry/exit
perf script --itrace=b --ns | \
    awk '/CALL.*target_function/ { start=$2 }
         /RET.*target_function/  { if (start) printf "latency: %f ms\n", ($2-start)/1000000 }'

# 3. Use Perf's built-in function-return latency analysis
perf script --itrace=cr -- | head -30

# Find longest-running function calls
perf script --itrace=cr --ns | sort -k6 -rn | head -20
```

## AMD Instruction-Based Sampling (IBS)

AMD's IBS is the equivalent of Intel PEBS — it provides precise event attribution by capturing CPU state at the exact instruction that caused an event.

```bash
# Check IBS availability
cat /sys/devices/ibs_op/type
cat /sys/devices/ibs_fetch/type

# IBS Fetch profiling (instruction cache misses, branch mispredictions)
sudo perf record -e ibs_fetch/cnt_ctl=1/ \
    --call-graph dwarf \
    -- your-program

# IBS Op profiling (cache misses, memory latency)
sudo perf record -e ibs_op/cnt_ctl=0/ \
    --call-graph dwarf \
    -- your-program

# View results
perf report

# IBS provides precise data:
# - Exact instruction address (no skid)
# - Data virtual address for loads/stores
# - Cache hit/miss information
# - Memory latency in cycles

# For NUMA analysis with IBS
sudo perf mem record -e ibs_op// -- your-program
perf mem report
```

## Memory Access Pattern Analysis

```bash
# Full memory profiling workflow

# Step 1: Identify memory bandwidth bottlenecks
sudo perf stat -e \
    uncore_imc_0/cas_count_read/,\
    uncore_imc_0/cas_count_write/ \
    -a -I 1000

# Step 2: Find LLC miss locations
sudo perf record -e LLC-load-misses:u \
    -c 1000 \
    --call-graph dwarf \
    -- your-program

# Step 3: Use perf mem for detailed memory analysis (Intel PEBS/AMD IBS)
sudo perf mem record -- your-program
perf mem report --sort=mem,sym,dso | head -40

# Output shows:
# Overhead  Memory access  Symbol
# 40.12%    L3 miss        process_records [myapp]
# 28.45%    L3 hit         lookup_table [myapp]
# 15.23%    L2 miss        hash_lookup [myapp]

# Step 4: C2C analysis for false sharing in NUMA/multi-socket
sudo perf c2c record -- your-program
perf c2c report

# Identifies cache lines shared across CPUs that cause coherency traffic
# Critical for multi-threaded workload optimization
```

### Practical: Profiling a Go Application

```bash
# Go applications require specific setup for perf
# 1. Build with frame pointers (needed for call graph)
GOFLAGS="-gcflags=all=-l" go build -o myapp main.go

# Better: use CGO_ENABLED=0 with frame pointers
go build -buildmode=exe \
    -gcflags="all=-e -B" \
    -ldflags="-w" \
    -o myapp main.go

# 2. Profile with frame pointer call graph
sudo perf record \
    -e cycles:u,cache-misses:u \
    -g --call-graph fp \
    -F 999 \
    -- ./myapp --some-arg

# 3. Generate flamegraph
perf script | \
    /usr/share/flamegraph/stackcollapse-perf.pl | \
    /usr/share/flamegraph/flamegraph.pl \
    > flamegraph.svg

# 4. For Go's goroutine stack issue, use DWARF unwinding
sudo perf record \
    -e cycles:u \
    --call-graph dwarf,65528 \
    -F 99 \
    -- ./myapp
```

## Production Performance Monitoring Scripts

```bash
#!/bin/bash
# pmu-baseline.sh - Collect PMU baseline metrics for a production server
# Usage: ./pmu-baseline.sh [duration_seconds]

DURATION=${1:-60}
OUTPUT_DIR="/var/log/perf-baselines/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

echo "Collecting PMU baseline for ${DURATION}s..."
echo "Output directory: ${OUTPUT_DIR}"

# System-wide hardware counters
perf stat -a \
    -e cycles,instructions,\
    cache-references,cache-misses,\
    branch-instructions,branch-misses,\
    stalled-cycles-frontend,stalled-cycles-backend,\
    LLC-loads,LLC-load-misses,\
    dTLB-loads,dTLB-load-misses \
    -I 5000 \
    -o "${OUTPUT_DIR}/hw-counters.txt" \
    sleep "$DURATION" &

# Per-CPU IPC monitoring
perf stat -a --per-cpu \
    -e cycles,instructions \
    -I 5000 \
    -o "${OUTPUT_DIR}/per-cpu-ipc.txt" \
    sleep "$DURATION" &

# Memory controller bandwidth (uncore)
if [ -d /sys/devices/uncore_imc_0 ]; then
    perf stat -a \
        -e uncore_imc_0/cas_count_read/,\
uncore_imc_0/cas_count_write/ \
        -I 1000 \
        -o "${OUTPUT_DIR}/memory-bw.txt" \
        sleep "$DURATION" &
fi

wait
echo "Baseline collection complete."

# Calculate summary statistics
echo "=== Summary ===" | tee "${OUTPUT_DIR}/summary.txt"
if [ -f "${OUTPUT_DIR}/hw-counters.txt" ]; then
    # Extract last line (totals) for key metrics
    grep "instructions" "${OUTPUT_DIR}/hw-counters.txt" | tail -1 | tee -a "${OUTPUT_DIR}/summary.txt"
    grep "cache-misses" "${OUTPUT_DIR}/hw-counters.txt" | tail -1 | tee -a "${OUTPUT_DIR}/summary.txt"
    grep "branch-misses" "${OUTPUT_DIR}/hw-counters.txt" | tail -1 | tee -a "${OUTPUT_DIR}/summary.txt"
fi
```

### Alerting on Performance Degradation

```bash
#!/bin/bash
# perf-alert.sh - Alert when IPC drops below threshold
THRESHOLD_IPC="1.5"
SAMPLE_DURATION="5"

while true; do
    # Sample IPC for 5 seconds
    RESULT=$(perf stat -a -e cycles,instructions sleep "$SAMPLE_DURATION" 2>&1)

    CYCLES=$(echo "$RESULT" | grep "cycles" | awk '{print $1}' | tr -d ',')
    INSTRUCTIONS=$(echo "$RESULT" | grep "instructions" | awk '{print $1}' | tr -d ',')

    if [ -n "$CYCLES" ] && [ "$CYCLES" -gt 0 ]; then
        IPC=$(echo "scale=2; $INSTRUCTIONS / $CYCLES" | bc)
        echo "IPC: $IPC (threshold: $THRESHOLD_IPC)"

        # Alert if IPC falls below threshold
        if (( $(echo "$IPC < $THRESHOLD_IPC" | bc -l) )); then
            echo "WARNING: Low IPC detected: $IPC" >&2
            # Send to monitoring system
            curl -s -X POST https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN> \
                -H 'Content-type: application/json' \
                --data "{\"text\":\"Low IPC on $(hostname): $IPC (threshold: $THRESHOLD_IPC)\"}" \
                > /dev/null
        fi
    fi

    sleep 55  # Total cycle: ~60s
done
```

## Key Takeaways

Hardware performance counters provide cycle-accurate insight into application behavior that no software profiler can match. The key principles for production performance analysis are:

1. Start with `perf stat` to get a high-level IPC and cache miss characterization before diving deeper — a single invocation reveals whether you have a memory-bound or compute-bound problem
2. IPC below 1.0 on modern out-of-order CPUs indicates significant memory stalls; IPC near 4.0 means the CPU is executing near its theoretical maximum
3. Cache miss rates above 1% for L1, 10% for L2, or 30% for LLC indicate memory access patterns that should be restructured for better spatial or temporal locality
4. Branch misprediction rates above 2-3% are worth investigating — sort input data, use lookup tables, or restructure conditionals to make branches more predictable
5. Intel PT provides the most detailed execution trace available but generates gigabytes of data per second — use time filters and function filters to avoid overwhelming storage
6. AMD IBS and Intel PEBS (precise event-based sampling) eliminate the instruction-pointer "skid" problem present in interrupt-based sampling, providing exact attribution to the causative instruction
7. Set `perf_event_paranoid=1` on production systems where developers need to profile — the default value of 2 prevents most useful profiling without root privileges
8. Always correlate PMU data with application-level metrics — a sudden increase in LLC misses that correlates with increased 99th-percentile latency confirms a cache thrashing problem that would otherwise be opaque
