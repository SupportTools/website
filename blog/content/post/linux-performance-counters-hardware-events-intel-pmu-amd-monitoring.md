---
title: "Linux Performance Counters and Hardware Events: Intel PMU and AMD Performance Monitoring"
date: 2030-08-20T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Intel PMU", "AMD", "perf", "CPU", "Profiling", "Observability"]
categories:
- Linux
- Performance
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Hardware performance monitoring guide covering Intel PMU architecture, hardware event groups, cache miss analysis, branch misprediction, memory bandwidth measurement, perf stat interpretation, and using hardware events to diagnose CPU bottlenecks."
more_link: "yes"
url: "/linux-performance-counters-hardware-events-intel-pmu-amd-monitoring/"
---

Hardware performance counters are the most accurate tool available for diagnosing CPU-level bottlenecks. Unlike profiling based on sampling or software instrumentation, hardware counters are collected by dedicated on-chip circuitry at near-zero overhead, providing cycle-accurate measurements of cache misses, branch mispredictions, memory bandwidth utilization, and instruction throughput. Understanding how to access and interpret these counters transforms vague performance complaints — "the service is slow" — into specific architectural issues with well-understood remediation paths.

<!--more-->

## Hardware Performance Monitoring Unit Architecture

### Intel PMU Structure

Intel processors expose performance monitoring through the Performance Monitoring Unit (PMU). Each CPU core has a set of programmable Performance Monitoring Counters (PMCs) and fixed-function counters.

**Fixed-Function Counters** (always available, low overhead):
- `INST_RETIRED.ANY` — instructions retired
- `CPU_CLK_UNHALTED.THREAD` — clock cycles (excluding halt)
- `CPU_CLK_UNHALTED.REF_TSC` — reference cycles at TSC frequency

**Programmable Counters** (4–8 per core depending on microarchitecture):
- Select any event from the event list using EVENTSEL MSR
- Support counter overflow interrupts for sampling

**Offcore Response Counters**:
- Track memory traffic to LLC (last-level cache), remote NUMA nodes, and DRAM
- Require specific event encoding with offcore response masks

### AMD PMU Structure

AMD processors use a similar structure with different event encodings. Zen 4 and later provide four general-purpose counters per core plus six L3 cache performance counters shared across a CCX (Core Complex).

```bash
# Identify the PMU version
dmesg | grep -i "PMU"
# [    0.123456] Performance Events: Sapphire Rapids events, 16 free counters, Intel PMU driver

# Check available PMUs
ls /sys/bus/event_source/devices/
# cpu          power        uncore_imc_0  uncore_imc_1  uncore_cha_0  ...
```

---

## perf: The Primary Interface

### Installation

```bash
# Ubuntu/Debian
apt-get install linux-tools-common linux-tools-$(uname -r)

# RHEL/Rocky
dnf install perf

# Verify perf is working
perf stat echo "hello"
```

### Basic perf stat

```bash
# Measure a command with hardware counters
perf stat -e cycles,instructions,cache-misses,cache-references,branch-misses,branches \
    ./myprogram --arg1 val1

# Sample output:
# Performance counter stats for './myprogram --arg1 val1':
#
#      12,847,203,941      cycles                    #    3.812 GHz
#       8,932,441,205      instructions              #    0.70  insn per cycle
#         423,891,221      cache-misses              #    4.88% of all cache refs
#       8,678,445,102      cache-references
#          87,332,001      branch-misses             #    1.23% of all branches
#       7,104,891,442      branches
#
#        3.367879043 seconds time elapsed
```

### Interpreting Key Ratios

| Metric | Formula | Good | Investigate When |
|---|---|---|---|
| IPC (Instructions Per Cycle) | instructions / cycles | > 2.0 | < 1.0 |
| Cache miss rate | cache-misses / cache-references | < 1% | > 5% |
| Branch misprediction rate | branch-misses / branches | < 1% | > 3% |
| L1D miss rate | L1-dcache-misses / L1-dcache-loads | < 0.5% | > 2% |

---

## Cache Hierarchy Analysis

### L1, L2, L3 Cache Miss Analysis

```bash
# Full cache hierarchy miss analysis
perf stat -e \
  L1-dcache-loads,L1-dcache-load-misses,\
  L1-dcache-stores,L1-dcache-store-misses,\
  L2_RQSTS.ALL_DEMAND_DATA_RD,L2_RQSTS.DEMAND_DATA_RD_MISS,\
  LLC-loads,LLC-load-misses \
  -I 1000 \   # Print every 1000ms
  ./myprogram

# For an already-running process
perf stat -e LLC-loads,LLC-load-misses -p $(pgrep myprogram) sleep 10
```

### TLB Miss Analysis

TLB misses cause significant latency when applications access large datasets with poor locality. Each TLB miss triggers a page table walk costing 10–100+ cycles:

```bash
# TLB miss analysis
perf stat -e \
  dTLB-loads,dTLB-load-misses,\
  dTLB-stores,dTLB-store-misses,\
  iTLB-loads,iTLB-load-misses \
  ./myprogram

# Example output indicating TLB pressure:
# 8,234,112,441  dTLB-loads
#    54,231,001  dTLB-load-misses     # 0.66% miss rate — acceptable
# 3,987,441,002  iTLB-loads
#     2,341,221  iTLB-load-misses     # 0.06% — good
```

### Huge Pages for TLB Optimization

When dTLB-load-misses exceed 2% on a workload accessing large arrays or hash tables, Transparent Huge Pages (THP) or explicit huge pages reduce TLB pressure:

```bash
# Enable THP for a running application
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Application-level huge page hint (Linux 5.14+)
# madvise(addr, length, MADV_HUGEPAGE);

# Measure THP adoption
grep -i huge /proc/meminfo
# AnonHugePages:   8388608 kB    ← 8GB of anonymous huge pages in use
# HugePages_Total: 0
```

---

## Branch Prediction Analysis

### Branch Misprediction Deep Dive

Modern out-of-order CPUs predict branch outcomes to keep execution pipelines filled. A mispredicted branch flushes the pipeline — typically 15–20 cycles on Intel Ice Lake, 12–14 cycles on AMD Zen 4.

```bash
# Detailed branch analysis on Intel
perf stat -e \
  branches,branch-misses,\
  BR_MISP_RETIRED.ALL_BRANCHES,\
  BR_INST_RETIRED.ALL_BRANCHES,\
  BR_INST_RETIRED.NEAR_CALL,\
  BR_INST_RETIRED.NEAR_RETURN \
  ./myprogram
```

### Finding Branches with High Misprediction Rates

```bash
# Sample branch mispredictions to find hot locations
perf record -e branch-misses:pp -g --call-graph=dwarf ./myprogram

# Generate annotated report
perf report --sort=sym --stdio | head -50

# Annotate a specific function
perf annotate --stdio search_function
```

### Optimizing Branches in Go

```go
// Before: unpredictable branch on lookup table
func processType(t int) string {
    if t == 0 {
        return "type_a"
    } else if t == 1 {
        return "type_b"
    } else if t == 2 {
        return "type_c"
    }
    return "unknown"
}

// After: table lookup — one predictable bounds check, then a memory load
var typeNames = [...]string{"type_a", "type_b", "type_c"}

func processType(t int) string {
    if uint(t) < uint(len(typeNames)) {
        return typeNames[t]
    }
    return "unknown"
}
```

---

## Memory Bandwidth Measurement

### Intel Uncore Memory Controller Events

Memory bandwidth is measured through the uncore IMC (Integrated Memory Controller) events, which are not per-core but per-socket:

```bash
# List available uncore IMC events
perf list | grep uncore_imc

# Measure DRAM read and write bandwidth (Intel Skylake and later)
perf stat -e uncore_imc/cas_count_read/,uncore_imc/cas_count_write/ \
    -I 1000 sleep 30

# Each CAS (Column Address Strobe) = 64 bytes
# Bandwidth = (cas_count_read + cas_count_write) * 64 bytes / interval

# Alternative using Intel PCM (Platform Control Monitor)
pcm-memory 1   # Sample every 1 second, reports bandwidth per channel
```

### AMD Memory Bandwidth via L3 Events

```bash
# AMD Zen 4: L3 cache bandwidth events
perf stat -e \
  amd_l3/mem_read_requests/,\
  amd_l3/mem_write_requests/ \
  sleep 10
```

### Bandwidth Measurement with Perf and awk

```bash
# Continuous bandwidth monitoring
perf stat -e uncore_imc/cas_count_read/,uncore_imc/cas_count_write/ \
    -I 1000 \
    sleep 60 2>&1 | awk '
/cas_count_read/  { reads  += $1 }
/cas_count_write/ { writes += $1 }
/seconds/         {
    bw_gb = (reads + writes) * 64 / 1e9
    printf "%.2f GB/s total bandwidth\n", bw_gb
    reads = 0; writes = 0
}'
```

---

## CPU Frontend and Backend Bound Analysis

Intel's Top-Down Microarchitecture Analysis Method (TMAM) categorizes pipeline slots into four buckets that identify where cycles are being wasted:

```
All Pipeline Slots
├── Retiring           ← Useful work (want this high)
├── Bad Speculation    ← Wasted due to mispredictions
├── Frontend Bound     ← Instruction fetch/decode bottleneck
│   ├── Fetch Latency  ← I-cache misses, iTLB misses
│   └── Fetch Bandwidth ← Decoder throughput limit
└── Backend Bound      ← Execution or memory bottleneck
    ├── Memory Bound   ← Cache/DRAM latency
    └── Core Bound     ← Execution unit contention
```

### Collecting TMAM Metrics

```bash
# Level 1 TMAM analysis (Intel Sandy Bridge and later)
perf stat -M TopdownL1 ./myprogram

# Example output:
# retiring          = 35.2%   ← Only 35% of slots doing useful work
# bad_speculation   =  2.1%
# frontend_bound    = 12.3%
# backend_bound     = 50.4%   ← Backend bottleneck — investigate memory

# Level 2 TMAM analysis
perf stat -M TopdownL2 ./myprogram
# memory_bound      = 38.7%   ← Dominant bottleneck is memory latency
# l1_bound          =  4.2%
# l2_bound          =  8.9%
# l3_bound          = 18.1%
# dram_bound        = 12.6%   ← 12.6% of cycles stalling on DRAM
```

---

## perf record and Flame Graph Generation

### CPU Profiling

```bash
# Record with hardware events at 99 Hz (relatively prime to most clock frequencies)
perf record -F 99 -g --call-graph=dwarf ./myprogram

# For a running process
perf record -F 99 -g --call-graph=dwarf -p $(pgrep myprogram) sleep 30

# Convert to flame graph
perf script | stackcollapse-perf.pl | flamegraph.pl > flamegraph.svg
```

### Off-CPU Analysis (Blocked Time)

Off-CPU analysis shows where processes are blocked waiting for I/O, locks, or scheduling:

```bash
# Record context switches and wakeups for off-CPU profiling
perf record -e sched:sched_switch,sched:sched_wakeup \
    -g --call-graph=dwarf \
    -p $(pgrep myprogram) sleep 10

perf script | grep -A 5 "sched_switch" | head -100
```

---

## Intel VTune and AMD uProf Integration

For production systems with CI/CD integration, command-line performance tools provide reproducible measurements:

### Intel VTune Command Line

```bash
# VTune hotspot analysis
vtune -collect hotspots \
    -result-dir /tmp/vtune-result \
    -app-working-dir /app \
    -- ./myprogram

# VTune memory access analysis
vtune -collect memory-access \
    -result-dir /tmp/vtune-memory \
    -- ./myprogram

# Generate summary report
vtune -report summary -result-dir /tmp/vtune-result
```

### AMD uProf

```bash
# AMD uProf CPU profiling
AMDuProfCLI collect \
    --config tbp \
    --output-dir /tmp/uprof-result \
    --duration 30 \
    -- ./myprogram

# Generate report
AMDuProfCLI report \
    --input /tmp/uprof-result/*.prd \
    --report cpu-summary
```

---

## perf_event in Go Applications

Go's `golang.org/x/sys/unix` package provides access to `perf_event_open` for application-level hardware counter measurement:

```go
// pkg/perfcounters/counters.go
package perfcounters

import (
    "fmt"
    "syscall"
    "unsafe"

    "golang.org/x/sys/unix"
)

// PerfType matches Linux perf_event_attr.type
const (
    PERF_TYPE_HARDWARE   = 0
    PERF_TYPE_SOFTWARE   = 1
    PERF_TYPE_TRACEPOINT = 2
    PERF_TYPE_HW_CACHE   = 3
)

// PerfHWID matches perf_hw_id
const (
    PERF_COUNT_HW_CPU_CYCLES             = 0
    PERF_COUNT_HW_INSTRUCTIONS           = 1
    PERF_COUNT_HW_CACHE_REFERENCES       = 2
    PERF_COUNT_HW_CACHE_MISSES           = 3
    PERF_COUNT_HW_BRANCH_INSTRUCTIONS    = 4
    PERF_COUNT_HW_BRANCH_MISSES          = 5
    PERF_COUNT_HW_BUS_CYCLES             = 6
    PERF_COUNT_HW_STALLED_CYCLES_FRONTEND = 7
    PERF_COUNT_HW_STALLED_CYCLES_BACKEND  = 8
)

type PerfAttr struct {
    Type        uint32
    Size        uint32
    Config      uint64
    SampleFreq  uint64
    SampleType  uint64
    ReadFormat  uint64
    Flags       uint64
    WakeupEvents uint32
    BpType      uint32
    _           [48]byte // remaining fields
}

// Counter wraps a single hardware performance counter.
type Counter struct {
    fd    int
    event uint64
}

func OpenCounter(perfType uint32, config uint64) (*Counter, error) {
    attr := PerfAttr{
        Type:   perfType,
        Size:   uint32(unsafe.Sizeof(PerfAttr{})),
        Config: config,
        Flags:  (1 << 3), // disabled initially
    }

    fd, _, errno := syscall.Syscall6(
        syscall.SYS_PERF_EVENT_OPEN,
        uintptr(unsafe.Pointer(&attr)),
        uintptr(0),  // pid = 0 = current process
        ^uintptr(0), // cpu = -1 = all CPUs
        ^uintptr(0), // group_fd = -1 = no group
        0,           // flags
        0,
    )
    if errno != 0 {
        return nil, fmt.Errorf("perf_event_open: %w", errno)
    }

    return &Counter{fd: int(fd), event: config}, nil
}

func (c *Counter) Enable() error {
    return unix.IoctlRetInt(c.fd, unix.PERF_EVENT_IOC_ENABLE, 0)
}

func (c *Counter) Disable() error {
    return unix.IoctlRetInt(c.fd, unix.PERF_EVENT_IOC_DISABLE, 0)
}

func (c *Counter) Reset() error {
    return unix.IoctlRetInt(c.fd, unix.PERF_EVENT_IOC_RESET, 0)
}

func (c *Counter) Read() (uint64, error) {
    var value uint64
    n, err := syscall.Read(c.fd, (*[8]byte)(unsafe.Pointer(&value))[:])
    if err != nil || n != 8 {
        return 0, fmt.Errorf("reading counter: %w", err)
    }
    return value, nil
}

func (c *Counter) Close() error {
    return syscall.Close(c.fd)
}
```

### Benchmark-Integrated PMU Measurement

```go
// pkg/perfcounters/benchmark.go
package perfcounters

import (
    "fmt"
    "testing"
)

// MeasureBenchmark wraps a benchmark function with hardware counter measurement.
func MeasureBenchmark(b *testing.B, name string, fn func()) {
    cycles, err := OpenCounter(PERF_TYPE_HARDWARE, PERF_COUNT_HW_CPU_CYCLES)
    if err != nil {
        b.Logf("warn: cannot open cycles counter: %v", err)
        // Fall back to running without hardware counters
        b.ResetTimer()
        for i := 0; i < b.N; i++ {
            fn()
        }
        return
    }
    defer cycles.Close()

    instructions, _ := OpenCounter(PERF_TYPE_HARDWARE, PERF_COUNT_HW_INSTRUCTIONS)
    if instructions != nil {
        defer instructions.Close()
    }

    cacheMisses, _ := OpenCounter(PERF_TYPE_HARDWARE, PERF_COUNT_HW_CACHE_MISSES)
    if cacheMisses != nil {
        defer cacheMisses.Close()
    }

    b.ResetTimer()
    _ = cycles.Reset()
    _ = cycles.Enable()
    if instructions != nil {
        _ = instructions.Enable()
    }
    if cacheMisses != nil {
        _ = cacheMisses.Enable()
    }

    for i := 0; i < b.N; i++ {
        fn()
    }

    _ = cycles.Disable()

    c, _ := cycles.Read()
    instr, _ := instructions.Read()
    cm, _ := cacheMisses.Read()

    b.ReportMetric(float64(c)/float64(b.N), "cycles/op")
    if instr > 0 {
        b.ReportMetric(float64(instr)/float64(b.N), "instrs/op")
        b.ReportMetric(float64(instr)/float64(c), "ipc")
    }
    if cm > 0 {
        b.ReportMetric(float64(cm)/float64(b.N), "cache-misses/op")
    }
}
```

---

## Workload-Specific Analysis Recipes

### Database Query Cache Analysis

```bash
# For PostgreSQL backend — measure cache effectiveness during query load
perf stat -e \
    LLC-loads,LLC-load-misses,\
    L1-dcache-loads,L1-dcache-load-misses \
    -p $(pgrep -f postgres:\ backend) \
    sleep 30

# High LLC-load-misses indicates working set exceeds shared_buffers + OS page cache
# Solution: increase shared_buffers or use huge pages for PostgreSQL
```

### Golang Runtime PMU Analysis

```bash
# Profile Go runtime overhead (GC, scheduler)
perf stat -e cycles,instructions,cache-misses,stalled-cycles-backend \
    -p $(pgrep mygoservice) sleep 10

# Identify GC-related cache thrashing:
# If cache-miss rate spikes during GC periods, consider GOGC tuning or
# ballast allocation to reduce GC frequency
```

### JVM/GraalVM PMU Analysis

```bash
# Measure compiled Java code efficiency
perf stat -e \
    cycles:u,instructions:u,\
    cache-misses:u,branch-misses:u \
    java -jar myapp.jar &

# The :u suffix restricts to user-space events, excluding kernel overhead
```

---

## Continuous Performance Monitoring

### perf stat in Prometheus Exporter

The `node_exporter` can collect hardware performance counters via the `perf_event` text file collector:

```bash
# Enable perf_event collector in node_exporter
node_exporter \
    --collector.perf \
    --collector.perf.cpus=0-7 \
    --collector.perf.tracepoint="sched:sched_switch"
```

### Kernel PMU Metrics via Grafana

```yaml
# Grafana dashboard query for IPC over time
rate(node_cpu_instructions_total[1m]) / rate(node_cpu_cycles_total[1m])

# Cache miss rate
rate(node_cpu_cache_misses_total[1m]) / rate(node_cpu_cache_references_total[1m])
```

---

## Conclusion

Hardware performance counters transform CPU performance analysis from guess-work into measurement. The TMAM hierarchy guides investigation: when backend-bound metrics dominate, cache miss analysis identifies the memory subsystem bottleneck; when frontend-bound, iTLB and instruction cache misses are the target; when bad speculation is high, branch predictor analysis reveals hot mispredicted branches. Combining `perf stat` for aggregate measurement, `perf record` with flame graphs for source-level attribution, and application-level `perf_event_open` for benchmark regression detection creates a comprehensive performance instrumentation strategy that surfaces bottlenecks before they reach production users.
