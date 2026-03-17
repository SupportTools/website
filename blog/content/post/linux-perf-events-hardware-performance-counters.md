---
title: "Linux Perf Events: Hardware Performance Counters for Application Profiling"
date: 2031-03-16T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Profiling", "perf", "CPU", "FlameGraph"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux perf events for application profiling: PMU hardware counters, cache misses, branch mispredictions, IPC measurement, perf stat and record, DWARF unwinding, FlameGraph generation, TopDown analysis, and Go perf integration."
more_link: "yes"
url: "/linux-perf-events-hardware-performance-counters/"
---

Modern CPUs contain dozens of hardware performance counters tracking everything from cache misses to branch mispredictions to memory bandwidth. The Linux perf subsystem exposes these counters through a unified interface, enabling precise, low-overhead profiling that reveals performance bottlenecks invisible to traditional profilers. This guide covers the full perf toolchain from basic counter measurement through FlameGraph generation and TopDown microarchitecture analysis, with specific attention to profiling Go applications.

<!--more-->

# Linux Perf Events: Hardware Performance Counters for Application Profiling

## Section 1: PMU Architecture and Counter Types

### The Performance Monitoring Unit

Every modern CPU core contains a Performance Monitoring Unit (PMU) with two categories of counters:

**Fixed-function counters**: Always counting specific events, cannot be reprogrammed:
- `INST_RETIRED.ANY`: Instructions retired (completed execution)
- `CPU_CLK_UNHALTED.THREAD`: CPU clock cycles while not halted
- `CPU_CLK_UNHALTED.REF_TSC`: Reference cycles (proportional to wall time)

**Programmable (General Purpose) counters**: Can be configured to count any supported PMU event. Typical Intel CPUs have 4 programmable counters per core; AMD has 6. The number is constrained by silicon budget.

### Event Categories

```
Hardware events (implemented in PMU silicon):
  cache-references          - Last-level cache references
  cache-misses              - Last-level cache misses
  branch-instructions       - All branch instructions
  branch-misses             - Branch mispredictions
  bus-cycles                - Bus cycles
  stalled-cycles-frontend   - Front-end stalls
  stalled-cycles-backend    - Back-end stalls
  instructions              - Instructions retired
  cycles                    - CPU cycles

Software events (implemented in kernel):
  cpu-clock                 - CPU clock (milliseconds)
  task-clock                - Task clock
  page-faults               - Page fault count
  context-switches          - Context switches
  cpu-migrations            - CPU migrations
  minor-faults              - Minor page faults
  major-faults              - Major page faults (I/O needed)

Tracepoint events (kernel tracepoints):
  syscalls:sys_enter_*      - System call entry
  sched:sched_switch        - Scheduler context switch
  block:block_rq_complete   - Block I/O completion
  net:netif_rx              - Network receive

Raw PMU events:
  r<hex>                    - Raw event code from CPU manual
```

### Checking Available Events

```bash
# List all available hardware events
perf list

# List events matching a pattern
perf list | grep -i "cache"

# List kernel tracepoints
perf list tracepoint

# Check if specific events are supported on your CPU
perf stat -e cache-references,cache-misses true 2>&1
# If "Performance counter stats" appears without errors, events are supported

# List raw PMU events with descriptions (Intel)
perf list --long-desc | grep "L2_RQSTS"

# Show all available PMU units
ls /sys/bus/event_source/devices/
# cpu  uncore_imc_0  uncore_imc_1  ...
```

## Section 2: perf stat for Application Profiling

`perf stat` runs a command and prints hardware counter statistics at the end. It's the fastest way to get a high-level performance characterization.

### Basic Usage

```bash
# Basic hardware counters
perf stat ls -la /proc
# Performance counter stats for 'ls -la /proc':
#
#              0.88 msec task-clock                #    0.614 CPUs utilized
#                 1      context-switches           #    1.138 K/sec
#                 0      cpu-migrations             #    0.000 /sec
#                67      page-faults                #   76.085 K/sec
#         2,156,484      cycles                     #    2.450 GHz
#         2,518,374      instructions               #    1.17  insn per cycle
#           507,562      branches                   #  576.775 M/sec
#             8,429      branch-misses              #    1.66% of all branches
#
#       0.001434027 seconds time elapsed
#       0.000919000 seconds user
#       0.000519000 seconds sys
```

### Measuring IPC (Instructions Per Cycle)

IPC is a fundamental CPU efficiency metric. Values below 1.0 indicate the CPU is stalling waiting for memory or branch resolution:

```bash
# Measure IPC for a Go application
perf stat -e instructions,cycles,cache-misses,cache-references \
  ./myapp --benchmark-mode 2>&1

# IPC = instructions / cycles
# < 0.5  : Memory-bound (lots of cache misses)
# 0.5-1.5: Mixed workload
# 1.5-3.0: Compute-bound (efficient, few stalls)
# > 3.0  : Very efficient (common in SIMD workloads)
```

### Cache Miss Analysis

```bash
# Detailed cache hierarchy analysis
perf stat -e \
  L1-dcache-loads,L1-dcache-load-misses,\
  L1-dcache-stores,L1-dcache-store-misses,\
  L2-loads,L2-load-misses,\
  LLC-loads,LLC-load-misses \
  ./myapp 2>&1

# L1 miss rate should be < 5% for well-cached workloads
# LLC miss rate > 10% indicates memory-bound behavior
```

### Branch Misprediction Analysis

```bash
# Branch prediction efficiency
perf stat -e \
  branch-instructions,\
  branch-misses,\
  branches,\
  r00c5  # MISPREDICTED_BRANCH_RETIRED raw event (Intel)
  ./myapp 2>&1

# Branch miss rate > 2% warrants investigation
# Sorting data before processing often reduces branch mispredictions
```

### Measuring Multiple Workloads

```bash
# Compare two implementations
echo "=== Original ==="
perf stat -e instructions,cycles,cache-misses ./original_impl < data.txt

echo "=== Optimized ==="
perf stat -e instructions,cycles,cache-misses ./optimized_impl < data.txt

# Per-second statistics (good for long-running daemons)
perf stat -I 1000 -e cache-misses,instructions,cycles \
  ./long_running_service &
# Prints per-second statistics every 1000ms
```

### perf stat with PID (Attach to Running Process)

```bash
# Attach to a running process (requires CAP_SYS_PTRACE or perf_event_paranoid <= 0)
perf stat -p <pid> sleep 30

# Measure all threads in a process group
perf stat -a -p <pid> sleep 10
```

## Section 3: perf record for Sampling Profiling

`perf record` samples the CPU at a configurable rate, recording stack traces. This provides much more detail than `perf stat`.

### Basic CPU Profiling

```bash
# Sample at 99 Hz for 30 seconds (99 Hz avoids aliasing with 100 Hz timer)
perf record -F 99 -g ./myapp -- --benchmark

# The -g flag collects call graph (stack traces)
# Produces perf.data file

# View the recorded data
perf report

# Text-only output (useful in scripts)
perf report --stdio | head -100
```

### DWARF-Based Stack Unwinding

For Go and other compiled languages with complex stack layouts, the default frame-pointer unwinding may produce incomplete stack traces. DWARF unwinding is more accurate but heavier:

```bash
# Use DWARF unwinding (recommended for accurate Go stacks)
perf record -F 99 --call-graph dwarf -g ./myapp

# DWARF unwinding captures more data per sample
# Default mmap size may need to be increased
perf record -F 99 --call-graph dwarf,8192 -g ./myapp
# 8192 = 8KB per sample (increase if stacks are deep)

# View with DWARF information
perf report --call-graph --stdio 2>&1 | head -200
```

### Frame Pointer Approach (Faster, Less Accurate)

```bash
# Frame pointer unwinding is faster but requires binaries built with frame pointers
# Go 1.12+ builds with frame pointers by default on amd64/arm64

# Check if binary has frame pointers
objdump -d ./myapp | head -20 | grep "push.*rbp"
# If you see "push   %rbp" at function entry, frame pointers are enabled

# Use frame pointer unwinding (faster)
perf record -F 99 --call-graph fp ./myapp

# Go's frame pointer support (explicitly set)
GOFLAGS="-gcflags=-l" go build -o myapp ./cmd/myapp  # Disable inlining for cleaner stacks
# Or
GOFLAGS="" go build -o myapp ./cmd/myapp  # Default, includes frame pointers on amd64
```

### LBR (Last Branch Record) Profiling

Intel CPUs have hardware support for recording the last 16-32 branch events with no sampling overhead:

```bash
# Use LBR for very low overhead CPU profiling (Intel only)
perf record -F 99 --call-graph lbr ./myapp

# LBR provides accurate call chains for the last 16-32 calls
# Works without DWARF or frame pointers
# Not available on AMD CPUs (they have BTB, different mechanism)

# Check LBR support
perf record --call-graph lbr true 2>&1
# If no error, LBR is available
```

### Recording Specific Events

```bash
# Record cache miss events (triggers on each LLC miss)
perf record -e LLC-load-misses -g ./myapp

# Record branch mispredictions
perf record -e branch-misses:p -g ./myapp
# :p = precise mode (requires perf_precise_ip support in CPU)

# Record on a specific CPU
perf record -C 0,1 -F 99 -g ./myapp

# Record including kernel symbols
perf record -F 99 -g -k kmem ./myapp
```

## Section 4: FlameGraph Generation

FlameGraphs are the most effective visualization of perf sampling data. They show the relative CPU time spent in each code path as proportional-width horizontal bars.

### Installing FlameGraph Tools

```bash
# Clone Brendan Gregg's FlameGraph repository
git clone https://github.com/brendangregg/FlameGraph.git
export PATH=$PATH:$(pwd)/FlameGraph
```

### Generating a FlameGraph

```bash
# Record samples
perf record -F 99 -g --call-graph dwarf ./myapp -- --workload

# Convert to folded stack format
perf script | stackcollapse-perf.pl > out.folded

# Generate FlameGraph SVG
flamegraph.pl out.folded > flamegraph.svg

# Open in browser
firefox flamegraph.svg &

# Combined one-liner
perf record -F 99 -g ./myapp && \
perf script | stackcollapse-perf.pl | flamegraph.pl > flamegraph.svg
```

### Differential FlameGraph (Before/After Comparison)

```bash
# Record baseline
perf record -F 99 -g -o baseline.data ./myapp-v1 -- --workload
perf script -i baseline.data | stackcollapse-perf.pl > baseline.folded

# Record new version
perf record -F 99 -g -o new.data ./myapp-v2 -- --workload
perf script -i new.data | stackcollapse-perf.pl > new.folded

# Generate differential FlameGraph
difffolded.pl baseline.folded new.folded | flamegraph.pl \
  --negate \
  --title "Differential Flame Graph (blue=regression, red=improvement)" \
  > diff.svg
```

### Off-CPU FlameGraph

On-CPU FlameGraphs only show where the CPU is active. Off-CPU FlameGraphs show where processes are blocked (I/O, locks, sleep):

```bash
# Record scheduler events for off-CPU profiling
# Requires root or CAP_SYS_ADMIN
perf record -e sched:sched_switch \
  -a \
  --call-graph dwarf \
  -p $(pgrep myapp) \
  sleep 30

# Generate off-CPU FlameGraph
perf script | stackcollapse-perf.pl | flamegraph.pl \
  --color=io \
  --title "Off-CPU FlameGraph" \
  > offcpu.svg
```

### Heap Allocation FlameGraph

```bash
# Record memory allocation events
# Requires malloc tracing (perf probe or LD_PRELOAD)
perf record -e 'probe_libc:malloc' \
  -g \
  ./myapp

perf script | stackcollapse-perf.pl | flamegraph.pl \
  --color=mem \
  --title "Heap Allocation FlameGraph" \
  > heapalloc.svg
```

## Section 5: TopDown Microarchitecture Analysis

Intel's TopDown Analysis Method is a hierarchical approach to identifying the root cause of CPU performance bottlenecks. The Linux Perf tool supports TopDown analysis through the `topdown` event group.

### TopDown Level 1 Analysis

Level 1 categorizes cycles into four buckets:

```
Total CPU Cycles
├── Frontend Bound    - CPU stalled fetching instructions
│                       (instruction cache misses, branch mispredictions)
├── Backend Bound     - CPU stalled waiting for data or resources
│   ├── Memory Bound  - Stalled waiting for memory
│   └── Core Bound    - Stalled on execution units (dividers, etc.)
├── Bad Speculation   - Work done speculatively that was discarded
└── Retiring          - Useful work (goal: maximize this)
```

```bash
# Run TopDown Level 1 analysis
perf stat --topdown -a ./myapp 2>&1

# Or use perf stat with explicit TopDown events (Intel)
perf stat -e \
  '{slots,topdown-retiring,topdown-bad-spec,topdown-fe-bound,topdown-be-bound}' \
  ./myapp 2>&1

# Output example:
# Performance counter stats for './myapp':
#
#   65,123,456      slots
#           41.2%   topdown-retiring              # 41.2% Retiring (good)
#            8.1%   topdown-bad-spec              # 8.1% Bad Speculation
#           24.7%   topdown-fe-bound              # 24.7% Frontend Bound (high!)
#           26.0%   topdown-be-bound              # 26.0% Backend Bound
```

### Interpreting TopDown Results

```
High Frontend Bound (> 20%):
  → Likely causes:
    - Instruction cache misses (large/fragmented code)
    - Branch mispredictions (hard-to-predict branches)
    - iTLB misses (many hot code pages)
  → Actions:
    - Profile with 'frontend' events: iTLB-load-misses, icache-load-misses
    - Optimize for code size (fewer unique code pages)
    - Consider PGO (Profile-Guided Optimization)

High Backend Bound (> 30%):
  Memory Bound sub-bucket high:
    - L3 cache misses, memory bandwidth saturation
    → Actions:
      - Optimize data layout (struct-of-arrays vs array-of-structs)
      - Reduce working set size
      - Use software prefetching

  Core Bound sub-bucket high:
    - Execution unit contention (float operations, integer multiply)
    → Actions:
      - Vectorize hot loops (SIMD)
      - Reduce operation count
      - Reorder operations to avoid execution unit stalls

High Bad Speculation (> 10%):
  → Branch mispredictions
  → Actions:
    - Profile with branch-misses event
    - Sort data to make branches more predictable
    - Use branchless code patterns where possible
```

### Level 2 Analysis

```bash
# Level 2 requires more counter multiplexing
perf stat -e \
  '{instructions,cycles}',\
  '{frontend-bound,backend-bound}',\
  '{memory-bound,core-bound}',\
  '{branch-misses,branches}',\
  '{L1-dcache-load-misses,L1-dcache-loads}',\
  '{LLC-load-misses,LLC-loads}' \
  ./myapp 2>&1

# Use pmu-tools for automated TopDown analysis (Intel)
pip install pmu-tools
toplev --all -l2 -v ./myapp
```

## Section 6: Go Application Profiling with perf

Go applications require some special consideration for perf profiling because of the goroutine scheduler and stack growth mechanisms.

### Building Go Binaries for Profiling

```bash
# Build with frame pointers (default on amd64/arm64 in modern Go)
go build -o myapp ./cmd/myapp

# Verify frame pointers are present
readelf -S myapp | grep -i "debug_frame\|eh_frame"

# Disable function inlining for cleaner stack traces
go build -gcflags="-l" -o myapp-noinline ./cmd/myapp

# Add debug symbols (larger binary, better profiling)
go build -gcflags="all=-N -l" -o myapp-debug ./cmd/myapp
# -N: disable optimizations
# -l: disable inlining
```

### Profiling a Go HTTP Server

```bash
# Start the server
./myapp &
SERVER_PID=$!

# Warm up
for i in $(seq 100); do curl -s http://localhost:8080/api/resource > /dev/null; done

# Profile for 30 seconds under load
perf record -F 99 \
  --call-graph dwarf \
  -p $SERVER_PID \
  sleep 30 &

# Apply load while profiling
ab -n 10000 -c 50 http://localhost:8080/api/resource

wait  # Wait for perf to finish

# Generate FlameGraph
perf script | stackcollapse-perf.pl | flamegraph.pl \
  --title "Go HTTP Server CPU Profile" \
  > go-server-flamegraph.svg
```

### Go's Built-in pprof vs perf

Go's built-in pprof profiler is easier to use but is a software sampler (limited to goroutines scheduled on the CPU). perf provides hardware counter access that pprof cannot:

```go
// Enable Go's pprof HTTP endpoint
import _ "net/http/pprof"
import "net/http"

func main() {
    go func() {
        http.ListenAndServe("localhost:6060", nil)
    }()
    // ... rest of application
}
```

```bash
# Collect Go CPU profile
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# What pprof gives you:
# - Goroutine-level CPU usage
# - Memory allocations
# - Mutex contention
# - Goroutine traces
# - Block profiling

# What perf gives you (that pprof cannot):
# - Hardware cache miss events
# - Branch misprediction rates
# - Memory bandwidth measurements
# - CPU cycle-accurate timing
# - Kernel function profiling
# - System-wide context (not just the Go runtime)
```

### Combining pprof and perf

```bash
# Use Go's pprof for application-level profiling
# Use perf for hardware-level investigation

# Step 1: Identify hot functions with pprof
go tool pprof http://localhost:6060/debug/pprof/cpu
# (pprof) top 10
# (pprof) web  # Opens in browser

# Step 2: Investigate hardware behavior of the hot function using perf
perf stat -e L1-dcache-load-misses,LLC-load-misses,branch-misses \
  -p $(pidof myapp) sleep 30
```

### Profiling Go Goroutines

Go's goroutine scheduler complicates CPU profiling because many goroutines may share a single OS thread:

```bash
# Set GOMAXPROCS to 1 for cleaner stack traces (eliminates scheduling noise)
GOMAXPROCS=1 ./myapp &
perf record -F 99 --call-graph fp -p $(pidof myapp) sleep 30

# Profile with goroutine information using custom BPF (more advanced)
# perf + BPF can track goroutine-level information
bpftrace -e '
uprobe:./myapp:"runtime.goexit" {
    printf("goroutine exited: tid=%d\n", tid);
}'
```

## Section 7: Advanced perf Usage

### System-Wide Profiling

```bash
# Profile all CPUs system-wide (requires root)
perf record -F 99 -a --call-graph dwarf sleep 30

# Profile with CPU grouping
perf record -F 99 -a -C 0-7 --call-graph fp sleep 30

# System-wide cache miss analysis
perf stat -a -e L1-dcache-misses,LLC-misses,cache-references sleep 10
```

### perf trace (strace Alternative)

```bash
# Trace system calls with timing (perf trace is faster than strace)
perf trace -p $(pidof myapp) 2>&1 | head -50

# Output:
# 0.000 ( 0.001 ms): read(3, ..., 4096)                      = 0
# 0.001 ( 0.002 ms): epoll_wait(5, ..., 128, 100)            = 3
# 0.003 ( 0.001 ms): write(6, ...)                           = 1

# Trace specific syscalls
perf trace -e openat,close -p $(pidof myapp) 2>&1 | head -50
```

### perf mem for Memory Access Analysis

```bash
# Record memory access patterns (requires kernel perf_mem support)
perf mem record -p $(pidof myapp) sleep 30

# View memory access profile
perf mem report 2>&1 | head -50

# Identify cache-unfriendly data structures
perf mem report -s symbol | head -20
```

### perf c2c (Cache-to-Cache Analysis)

For NUMA and multi-socket systems, false sharing between CPU caches is a common bottleneck:

```bash
# Record cache line sharing events
perf c2c record -a -- sleep 30

# Report cache line hot spots
perf c2c report --stdio 2>&1 | head -100

# Look for "HITM" (Hit In Modified state) = cache line bouncing between cores
# High HITM rates indicate false sharing
```

## Section 8: Production Profiling Workflow

### Low-Overhead Continuous Profiling

```bash
# Continuous profiling script for production
#!/bin/bash
set -e

APP_PID=$1
OUTPUT_DIR=/var/log/perf-profiles/$(date +%Y/%m/%d)
mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date +%H%M%S)
OUTPUT="$OUTPUT_DIR/profile-$TIMESTAMP.data"

echo "Starting perf record for PID $APP_PID..."
# Very low sampling rate for production: 11 Hz
perf record -F 11 \
  --call-graph fp \
  -p "$APP_PID" \
  -o "$OUTPUT" \
  sleep 60

echo "Converting to FlameGraph..."
perf script -i "$OUTPUT" | \
  stackcollapse-perf.pl | \
  flamegraph.pl > "${OUTPUT%.data}.svg"

echo "Profile written to ${OUTPUT%.data}.svg"
gzip "$OUTPUT"  # Compress the raw data

# Keep only last 24 hours of profiles
find "$OUTPUT_DIR" -mtime +1 -delete
```

### Automating FlameGraph Collection in Kubernetes

```yaml
# DaemonSet for automated perf profiling
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
      containers:
      - name: profiler
        image: myregistry/perf-profiler:latest
        securityContext:
          privileged: true
        command:
        - /bin/sh
        - -c
        - |
          # Install FlameGraph tools
          apk add --no-cache linux-perf

          while true; do
            # Find the target process
            TARGET_PID=$(pgrep myapp)
            if [ -n "$TARGET_PID" ]; then
              echo "Profiling PID $TARGET_PID..."

              perf record -F 99 \
                --call-graph fp \
                -p "$TARGET_PID" \
                -o /output/profile.data \
                sleep 30

              perf script -i /output/profile.data | \
                stackcollapse-perf.pl | \
                flamegraph.pl > "/output/flamegraph-$(date +%s).svg"

              rm /output/profile.data
            fi
            sleep 300  # Profile every 5 minutes
          done
        volumeMounts:
        - name: output
          mountPath: /output
        - name: host-sys
          mountPath: /sys
        resources:
          requests:
            cpu: 100m
          limits:
            cpu: 500m
      volumes:
      - name: output
        hostPath:
          path: /var/log/perf-profiles
      - name: host-sys
        hostPath:
          path: /sys
```

## Section 9: perf Configuration and Permissions

### Kernel Configuration

```bash
# Check current paranoia setting
cat /proc/sys/kernel/perf_event_paranoid
# -1 = All users can collect system-wide perf events
#  0 = Allow collection of system-wide events for non-root users
#  1 = Allow collection per-process only (default on many distros)
#  2 = Disallow everything for non-root users
#  3 = Disallow access completely

# For development: allow per-process profiling
echo 1 | sudo tee /proc/sys/kernel/perf_event_paranoid

# Permanent configuration
cat >> /etc/sysctl.conf << 'EOF'
kernel.perf_event_paranoid = 1
kernel.kptr_restrict = 0  # Allow reading /proc/kallsyms for kernel symbol resolution
EOF
sysctl -p

# For production (more restrictive)
echo 2 | sudo tee /proc/sys/kernel/perf_event_paranoid
```

### Capabilities for Containerized Environments

```yaml
# Pod security context for perf profiling
securityContext:
  capabilities:
    add:
    - SYS_ADMIN        # Required for system-wide perf events
    - SYS_PTRACE       # Required for attaching to other processes
    - PERFMON          # Linux 5.8+ alternative to SYS_ADMIN for perf
    - BPF              # Linux 5.8+ for BPF programs
```

### Kernel Symbols

For profiling kernel code paths:

```bash
# Enable kernel symbol resolution
echo 0 | sudo tee /proc/sys/kernel/kptr_restrict

# Install debug symbols for better kernel profiles
apt-get install linux-image-$(uname -r)-dbg  # Debian/Ubuntu
dnf install kernel-debuginfo                  # RHEL/Fedora

# Verify kernel symbols are readable
head /proc/kallsyms
# Should show function addresses, not zeros
```

## Summary

Linux perf events provide unparalleled visibility into CPU microarchitectural behavior. The key workflows for production engineering teams:

- `perf stat` with IPC and cache miss metrics provides a quick health check for any workload's memory efficiency and CPU utilization quality
- `perf record` with DWARF unwinding and `flamegraph.pl` transforms raw sampling data into immediately actionable stack trace visualizations
- TopDown analysis provides a principled methodology for identifying whether performance bottlenecks are frontend-bound, backend-bound, or caused by branch mispredictions
- Go applications benefit from perf's hardware counter access which complements the built-in pprof profiler's software sampling
- Production profiling requires low sampling rates (11-49 Hz) and careful attention to permissions; the privileged DaemonSet approach provides fleet-wide profiling capability
- False sharing detection via `perf c2c` is essential for multi-socket and high-core-count systems where concurrent data structure access can cause cache line bouncing
