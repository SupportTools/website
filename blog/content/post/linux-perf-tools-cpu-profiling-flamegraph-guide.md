---
title: "Linux Perf Tools Deep Dive: CPU Profiling, Flame Graphs, and Performance Analysis"
date: 2029-11-27T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Profiling", "Flame Graphs", "perf", "CPU", "Cache", "Branch Prediction"]
categories:
- Linux
- Performance
- Debugging
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux perf, FlameGraph generation, hotspot identification, cache misses, branch mispredictions, and safe production CPU profiling techniques."
more_link: "yes"
url: "/linux-perf-tools-cpu-profiling-flamegraph-guide/"
---

The Linux `perf` tool is the most powerful CPU profiling instrument available on Linux systems, yet most engineers only use it for basic sampling. Understanding the full capability of `perf` — hardware performance counters, software events, probe points, and flame graph generation — separates engineers who guess at performance problems from those who measure them precisely.

<!--more-->

## Section 1: Understanding perf's Architecture

`perf` is built around the `perf_event_open` syscall, which programs CPU hardware performance monitoring units (PMUs) to generate interrupts at configurable intervals. The kernel collects the program counter (PC) and call stack at each interrupt, building a statistical profile of where the CPU spends its time.

The critical insight: `perf` is a statistical sampler, not a tracer. It does not record every function call. It samples the CPU at a rate (default 1000 Hz) and builds a histogram of where the CPU was at each sample. Functions that appear frequently in the histogram are hot — they consume the most CPU time.

### Hardware PMU Events

Modern Intel and AMD CPUs expose hundreds of PMU events beyond simple cycle counting:

```
Category              Examples
──────────────────────────────────────────────────────
CPU Cycles            cpu-cycles, ref-cycles
Instructions          instructions, retired-branches
Cache                 L1-dcache-loads, L1-dcache-load-misses
                      LLC-loads, LLC-load-misses
Branch Prediction     branch-instructions, branch-misses
TLB                   dTLB-loads, dTLB-load-misses
Memory                mem-loads, mem-stores
Frontend Stalls       frontend-stalls, backend-stalls (uarch-specific)
```

### Installing perf

```bash
# Ubuntu/Debian
apt-get install linux-perf linux-tools-$(uname -r)

# RHEL/CentOS/Rocky
dnf install perf

# Verify installation
perf --version

# Check available events
perf list hardware
perf list software
perf list cache
```

### Kernel Configuration for Full Symbol Resolution

```bash
# Allow perf to access kernel symbols without root
echo -1 > /proc/sys/kernel/perf_event_paranoid

# Or persistently in sysctl
cat >> /etc/sysctl.d/99-perf.conf << 'EOF'
kernel.perf_event_paranoid = -1
kernel.kptr_restrict = 0
EOF
sysctl --system

# Verify kallsyms is readable
cat /proc/kallsyms | head -5
```

## Section 2: CPU Profiling Fundamentals

### Basic CPU Sampling

```bash
# Profile a command for 30 seconds
perf record -F 999 -g -- sleep 30

# Profile a running process by PID
perf record -F 999 -g -p $(pgrep -f my-go-service) -- sleep 30

# Profile system-wide (all CPUs, all processes)
perf record -F 999 -g -a -- sleep 30

# View the raw report (interactive TUI)
perf report --stdio

# View with call graph, sorted by overhead
perf report --stdio --call-graph=graph --percent-limit=0.5
```

The `-g` flag enables call graph (stack trace) recording. Without it, you only see leaf functions. The `-F 999` sets the sampling frequency to 999 Hz (just under 1000 to avoid kernel timer aliasing).

### Annotating Hot Functions

```bash
# After perf record, annotate the hottest function with source/assembly
perf annotate --stdio --symbol=hotFunction

# Annotate with source code if debug symbols are available
perf annotate --stdio -s --symbol=processPackets
```

Example output:

```
Percent│    Instructions:  processPackets
       │    push   %rbp
       │    mov    %rsp,%rbp
  4.12 │    movq   $0x0,-0x10(%rbp)
 38.71 │  ↑ movzbl (%rdi,%rax,1),%ecx    ← HOT: cache miss on buffer access
  2.06 │    add    $0x1,%rax
 41.94 │  ↑ cmp    %rsi,%rax
  6.19 │  ↑ jl     hotLoop
```

### Counting Events Without Sampling

```bash
# Count specific events for a command (no overhead)
perf stat -e cycles,instructions,cache-misses,branch-misses \
  ./my-workload

# Extended stats showing IPC and memory bandwidth
perf stat -d ./my-workload

# Multiple runs for statistical confidence
perf stat --repeat 5 -e cycles,instructions ./my-workload
```

Sample output:

```
Performance counter stats for './my-workload' (5 runs):

    12,847,293,104      cycles                    ( +-  0.42% )
     8,124,581,702      instructions              #    0.63  insn per cycle
       892,341,521      cache-misses              #   12.34% of all cache refs
        47,832,109      branch-misses             #    2.81% of all branches

           3.2145 +- 0.0231 seconds time elapsed  ( +-  0.72% )
```

An IPC (instructions per cycle) of 0.63 indicates significant memory stalls — the CPU is waiting for data from RAM most of the time.

## Section 3: Flame Graph Generation

Flame graphs are the definitive visualization for CPU profiling data. The x-axis represents stack frame population (wider = more samples), the y-axis is call depth, and color is arbitrary (used to distinguish libraries).

### Brendan Gregg's FlameGraph Tools

```bash
# Clone the FlameGraph repository
git clone https://github.com/brendangregg/FlameGraph
export FLAMEGRAPH_DIR="$(pwd)/FlameGraph"

# Record a profile
perf record -F 999 -g -p $(pgrep my-service) -- sleep 60

# Convert perf.data to folded stacks
perf script | \
  "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" > out.folded

# Generate SVG flame graph
"${FLAMEGRAPH_DIR}/flamegraph.pl" \
  --title "My Service CPU Profile" \
  --colors hot \
  --width 1600 \
  out.folded > flamegraph.svg

# Open in browser
xdg-open flamegraph.svg
```

### Differential Flame Graphs

Differential flame graphs show the change in CPU profile between two measurements — invaluable for before/after optimization comparisons:

```bash
# Before optimization profile
perf record -F 999 -g -p $(pgrep my-service) -o before.data -- sleep 60
perf script -i before.data | \
  "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" > before.folded

# After optimization profile
perf record -F 999 -g -p $(pgrep my-service) -o after.data -- sleep 60
perf script -i after.data | \
  "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" > after.folded

# Generate differential flame graph (red = regression, blue = improvement)
"${FLAMEGRAPH_DIR}/difffolded.pl" before.folded after.folded | \
  "${FLAMEGRAPH_DIR}/flamegraph.pl" \
    --title "Differential: After vs Before" \
    --colors hot \
    --negcolor cold \
    > diff-flamegraph.svg
```

### Off-CPU Flame Graphs

On-CPU profiles miss latency from blocking I/O, lock contention, and sleep. Off-CPU flame graphs capture the time spent waiting:

```bash
# Requires kernel >= 4.8 and BCC tools
# Install BCC
apt-get install bpfcc-tools

# Record off-CPU time for a process
/usr/share/bcc/tools/offcputime -df -p $(pgrep my-service) 60 > offcpu.folded

# Generate off-CPU flame graph
"${FLAMEGRAPH_DIR}/flamegraph.pl" \
  --title "Off-CPU Time" \
  --colors io \
  --countname us \
  offcpu.folded > offcpu-flamegraph.svg
```

## Section 4: Cache Miss Analysis

Cache misses are the leading cause of low IPC in memory-intensive workloads. `perf` can identify exactly which code is generating L1/L2/LLC misses.

### Recording Cache Miss Events

```bash
# Sample on LLC (last level cache) load misses
perf record -e LLC-load-misses:pp -g -p $(pgrep my-service) -- sleep 30

# The :pp suffix requests precise IP (pinpoints the exact instruction)
perf report --stdio --sort=symbol,dso

# Check L1 data cache miss rate per function
perf record -e L1-dcache-load-misses:pp,L1-dcache-loads:pp \
  -g ./my-workload

perf report --stdio --sort=symbol
```

### Memory Access Pattern Analysis with perf mem

```bash
# Record memory load/store events
perf mem record -p $(pgrep my-service) -- sleep 30

# Report memory access latencies
perf mem report --sort=mem,symbol --stdio
```

Output identifies data structures causing cache thrashing:

```
Overhead  Memory access        Symbol
   34.2%  L2 hit               processMessageBatch
   28.7%  LLC miss             deserializeJSON
   18.3%  Local DRAM           buildIndex
    9.1%  L1 hit               lookupHashMap
```

### Cache-Friendly Code Patterns

```c
// Cache-unfriendly: column-major iteration on row-major array
// Each access jumps by COLS * sizeof(double) bytes
for (int j = 0; j < COLS; j++) {
    for (int i = 0; i < ROWS; i++) {
        sum += matrix[i][j];  // cache miss every iteration
    }
}

// Cache-friendly: row-major iteration
// Accesses sequential memory addresses
for (int i = 0; i < ROWS; i++) {
    for (int j = 0; j < COLS; j++) {
        sum += matrix[i][j];  // cache hit most iterations
    }
}
```

## Section 5: Branch Misprediction Analysis

Modern CPUs speculatively execute the predicted branch. A misprediction costs 15-20 pipeline cycles. For tight loops with unpredictable conditionals, this becomes significant.

```bash
# Profile branch mispredictions
perf record -e branch-misses:pp -g ./my-workload
perf report --stdio --sort=symbol

# Get branch misprediction rate per function
perf stat -e branch-instructions,branch-misses \
  --per-thread \
  -p $(pgrep my-service) -- sleep 10
```

### Identifying Misprediction Hotspots

```bash
# Annotate with branch miss events
perf record -e branch-misses:pp -g -p $(pgrep my-service) -- sleep 30
perf annotate --stdio --symbol=classifyPacket
```

```asm
  42.3% │    cmp    %eax, threshold_val
         │  ↓ jle    0x14c2              ← 42% branch miss rate: data-dependent
   0.1% │    movl   $0x1, -0x4(%rbp)
```

The fix is to eliminate the branch or make it predictable. For a sort-then-process pattern, sorting makes branch outcomes predictable. For lookup tables, replacing conditionals with array indexing eliminates branches entirely.

## Section 6: Production Profiling Best Practices

### Low-Overhead Continuous Profiling

For production systems, `perf record` at 999 Hz adds roughly 1-5% CPU overhead. For sensitive workloads, use lower frequencies:

```bash
# 99 Hz: ~0.1% overhead, suitable for production
perf record -F 99 -g -p $(pgrep my-service) -- sleep 30

# Use CPU frequency scaling events for better accuracy at low rates
perf record -F 99 -e cpu-cycles:pp -g -p $(pgrep my-service) -- sleep 30
```

### Profiling Go Binaries

Go generates frame pointer information, which `perf` needs for call graph reconstruction:

```bash
# Build Go binary with frame pointers (required for perf -g)
# Go 1.12+ enables frame pointers by default on amd64/arm64

# Verify
objdump -d my-service | grep -A5 "^<main.processRequest>"

# For Go programs, use pprof labels to annotate samples
import "runtime/pprof"

func handleRequest(ctx context.Context, req *Request) {
    labels := pprof.Labels(
        "request_type", req.Type,
        "customer_tier", req.CustomerTier,
    )
    pprof.Do(ctx, labels, func(ctx context.Context) {
        processRequest(ctx, req)
    })
}
```

### Profiling in Kubernetes Pods

```bash
# Run perf in a privileged debug pod alongside the target
kubectl debug -it --image=ubuntu \
  --profile=sysadmin \
  $(kubectl get pod -l app=my-service -o name | head -1) \
  -- bash

# Inside the debug pod
apt-get install -y linux-perf linux-tools-generic

# Find the target process PID in the container (host PID namespace)
ps aux | grep my-service

# Profile it
perf record -F 99 -g -p TARGET_PID -- sleep 60
perf script | ./stackcollapse-perf.pl | ./flamegraph.pl > /tmp/flame.svg

# Copy the SVG out
kubectl cp debug-pod:/tmp/flame.svg ./flame.svg
```

### perf record Safety Controls

```bash
# Limit perf.data size to prevent disk exhaustion
perf record -F 99 -g \
  --output /tmp/perf-$(date +%Y%m%d-%H%M%S).data \
  -p $(pgrep my-service) \
  -- sleep 60

# Compress perf.data (requires perf >= 5.8)
perf record -z -F 99 -g -p $(pgrep my-service) -- sleep 60

# Rotate perf.data files
perf record --switch-output=signal -F 99 -g -p $(pgrep my-service) &
# Send SIGUSR2 to rotate files
```

## Section 7: Frontend and Backend Stall Analysis

For Intel CPUs with Top-Down Microarchitecture Analysis (TMA) support, `perf` can decompose CPU cycles into four categories: retiring (useful work), bad speculation, frontend bound, and backend bound.

```bash
# Install pmu-tools for TMA analysis
pip3 install pmu-tools
git clone https://github.com/andikleen/pmu-tools

# Run TMA Level 1 analysis
./pmu-tools/toplev.py --core S0-C0 -l1 -- ./my-workload

# Level 2 for frontend/backend breakdown
./pmu-tools/toplev.py --core S0-C0 -l2 -- ./my-workload
```

Sample TMA output:

```
FE             Frontend_Bound:                   12.3 %
    FE         Fetch_Latency:                     8.1 %
    FE         Fetch_Bandwidth:                   4.2 %
BAD            Bad_Speculation:                   5.7 %
    BAD        Branch_Mispredicts:                3.9 %
BE             Backend_Bound:                    61.4 %   ← primary bottleneck
    MEM        Memory_Bound:                     48.2 %   ← memory stalls
    CORE       Core_Bound:                       13.2 %
RET            Retiring:                         20.6 %   ← useful work
```

61% backend bound with 48% memory bound confirms the cache miss analysis above: the primary optimization target is memory access patterns, not branch prediction or instruction throughput.

## Section 8: Automated Profiling Pipelines

### Continuous Profiling with Parca

```yaml
# parca-agent-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: parca-agent
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: parca-agent
  template:
    metadata:
      labels:
        app: parca-agent
    spec:
      hostPID: true
      hostNetwork: true
      containers:
        - name: parca-agent
          image: ghcr.io/parca-dev/parca-agent:v0.31.0
          args:
            - /bin/parca-agent
            - --node=$(NODE_NAME)
            - --remote-store-address=parca.monitoring:7070
            - --remote-store-insecure
            - --profiling-cpu-sampling-frequency=19
          securityContext:
            privileged: true
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          volumeMounts:
            - name: host-root
              mountPath: /host
              readOnly: true
      volumes:
        - name: host-root
          hostPath:
            path: /
```

Parca continuously profiles every process on every node at ~1% overhead, stores profiles in a time-series database, and enables diff analysis between any two time windows — without requiring any application changes.

Mastering `perf` transforms performance investigations from educated guessing into precise measurement. The combination of hardware counters, call graph sampling, and flame graph visualization gives you a complete picture of CPU behavior that no other tool can match.
