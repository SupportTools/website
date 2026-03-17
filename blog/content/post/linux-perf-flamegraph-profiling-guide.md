---
title: "Linux perf and Flame Graphs: CPU Profiling for Production Systems"
date: 2028-10-24T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "perf", "Flame Graphs", "Profiling"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux perf for hardware counters, CPU sampling, live profiling, generating flame graphs, off-CPU analysis with bpftrace, memory allocation profiling, and container profiling in Kubernetes."
more_link: "yes"
url: "/linux-perf-flamegraph-profiling-guide/"
---

When a production system is slow, guessing at the cause wastes time. `perf` is the Linux performance analysis tool that tells you exactly where CPU time is spent — down to the individual instruction. Combined with Brendan Gregg's flame graph visualization, you can identify hotspots in seconds. This guide covers the complete workflow from hardware counters to off-CPU analysis, with specific guidance for profiling inside containers on Kubernetes.

<!--more-->

# Linux perf and Flame Graphs: Production Profiling Guide

## Installing perf

```bash
# Ubuntu/Debian
apt-get install linux-tools-common linux-tools-$(uname -r) linux-tools-generic

# RHEL/CentOS/Fedora
dnf install perf

# Alpine (for containers)
apk add perf

# Verify installation
perf --version
# perf version 6.8.12

# Check kernel version matches perf version
uname -r
```

If `perf` reports "WARNING: No kallsyms or vmlinux found" you need kernel symbols:

```bash
# Enable kernel symbols for perf
echo 0 | sudo tee /proc/sys/kernel/kptr_restrict
echo -1 | sudo tee /proc/sys/kernel/perf_event_paranoid

# For containers/Kubernetes, set on the host node:
sysctl -w kernel.perf_event_paranoid=-1
sysctl -w kernel.kptr_restrict=0
```

## perf stat: Hardware Counters

`perf stat` runs a command and reports hardware performance counters: cycles, instructions, cache misses, branch mispredictions.

```bash
# Profile a command
perf stat ls -la /usr/bin

# Example output:
#  Performance counter stats for 'ls -la /usr/bin':
#
#         1.52 msec task-clock                #    0.828 CPUs utilized
#            0      context-switches          #    0.000 /sec
#            0      cpu-migrations            #    0.000 /sec
#          194      page-faults               #  127.632 K/sec
#    4,897,158      cycles                    #    3.222 GHz
#    5,431,052      instructions              #    1.11  insn per cycle
#    1,073,684      branches                  #  706.370 M/sec
#       20,147      branch-misses             #    1.88% of all branches
#
#    0.001838 seconds time elapsed

# Profile a running process by PID
perf stat -p <PID> sleep 10

# Detailed CPU event statistics (requires root or perf_event_paranoid=-1)
perf stat -e cycles,instructions,cache-references,cache-misses,\
branch-instructions,branch-misses,stalled-cycles-frontend,\
stalled-cycles-backend -a sleep 5

# Instructions per cycle (IPC) — IPC < 1.0 often indicates memory-bound code
perf stat -e cycles,instructions -- ./my-program

# Show all available events
perf list

# Cache performance analysis
perf stat -e L1-dcache-loads,L1-dcache-load-misses,\
LLC-loads,LLC-load-misses ./my-program
```

Interpreting `perf stat` output:

- **IPC < 1.0**: Memory-bound workload — reduce allocations or improve cache locality
- **Branch misses > 5%**: Unpredictable branching — consider branchless algorithms
- **LLC miss rate > 10%**: Working set exceeds L3 cache — data structure layout needs work
- **Stalled cycles > 30%**: CPU is waiting for memory or other resources

## perf record and report: CPU Sampling

`perf record` samples the call stack at a configurable frequency and writes to a `perf.data` file.

```bash
# Sample at 99 Hz for 30 seconds, all CPUs
perf record -F 99 -a -g -- sleep 30

# Sample a specific PID
perf record -F 99 -p <PID> -g -- sleep 30

# Sample a command
perf record -F 99 -g -- ./my-go-binary

# Higher frequency for short programs (but more overhead)
perf record -F 1000 -g -- ./benchmark

# Record with DWARF debug info (better stack unwinding, more data)
perf record -F 99 --call-graph dwarf -p <PID> -- sleep 30

# Frame pointer-based unwinding (faster but requires -fno-omit-frame-pointer)
perf record -F 99 --call-graph fp -p <PID> -- sleep 30

# Show report interactively
perf report

# Non-interactive report sorted by self cost
perf report --stdio --no-children

# Annotate assembly for the hottest function
perf annotate --stdio <function_name>
```

### Enabling frame pointers in Go

Go by default omits frame pointers on amd64. Compile with frame pointers for better perf output:

```bash
# Go 1.12+ enables frame pointers by default on amd64
# For older versions or cross-compiles:
GOFLAGS="-gcflags=all=-l" go build ./...

# Or use -trimpath + framepointer
go build -ldflags="-w" -gcflags="all=-N -l" -o myserver ./cmd/server
```

## perf top: Live CPU Profiling

`perf top` works like `top` but shows functions consuming CPU instead of processes.

```bash
# Show all processes, sorted by CPU usage
sudo perf top

# Filter to a specific process
sudo perf top -p <PID>

# Show kernel and userspace symbols
sudo perf top --sort comm,dso,symbol

# Show call graph in real time
sudo perf top -g

# Useful key bindings inside perf top:
# 'a' — annotate the selected function
# 's' — filter by symbol
# 'z' — toggle zeroing of counts
# 'E' — show event info
# 'q' — quit
```

## Generating Flame Graphs

Flame graphs visualize the call stack frequency data from `perf record`. The x-axis is not time — it is the number of samples in which each stack frame appeared. Wide boxes are hot code paths.

### Setup

```bash
# Clone Brendan Gregg's FlameGraph scripts
git clone https://github.com/brendangregg/FlameGraph.git
export PATH="$PATH:$PWD/FlameGraph"

# Or install via package manager (Fedora/RHEL)
dnf install flamegraph
```

### CPU flame graph

```bash
# Step 1: Record
perf record -F 99 -a -g -- sleep 60

# Step 2: Convert to perf script output
perf script > out.perf

# Step 3: Fold stacks
stackcollapse-perf.pl out.perf > out.folded

# Step 4: Render SVG
flamegraph.pl out.folded > flamegraph.svg

# Open in browser
firefox flamegraph.svg

# Or all in one pipeline
perf record -F 99 -a -g -- sleep 60 && \
  perf script | stackcollapse-perf.pl | flamegraph.pl > flamegraph.svg
```

### Differential flame graphs

Differential flame graphs compare two profiles to show what changed between before and after a code change.

```bash
# Profile version A
perf record -F 99 -g -- ./server-v1
perf script | stackcollapse-perf.pl > v1.folded

# Profile version B
perf record -F 99 -g -- ./server-v2
perf script | stackcollapse-perf.pl > v2.folded

# Generate differential flame graph
# Blue = less time in v2, Red = more time in v2
difffolded.pl v1.folded v2.folded | flamegraph.pl --negate > diff.svg
```

## Off-CPU Flame Graphs with bpftrace

On-CPU flame graphs only show where CPU time is spent. Off-CPU flame graphs show where threads are blocking — waiting for I/O, locks, or sleep.

```bash
# Install bpftrace
apt-get install bpftrace  # Ubuntu 20.04+

# Off-CPU profiling: record when a thread is descheduled
# and capture the stack trace at that moment
bpftrace -e '
tracepoint:sched:sched_switch
/comm == "myserver"/
{
  @off[kstack, ustack, comm] = count();
}

interval:s:30
{
  exit();
}' > offcpu.data

# Built-in offcputime.bt script
bpftrace /usr/share/bpftrace/tools/offcputime.bt -c ./myserver > offcpu.folded
flamegraph.pl --color=io --title="Off-CPU Time" offcpu.folded > offcpu.svg
```

### Using the dedicated offcpu script

```bash
# Record off-CPU time for a PID
sudo offcputime-bpfcc -p <PID> -f 30 > offcpu.txt

# Generate flame graph
flamegraph.pl --color=io --title="Off-CPU Flame Graph" \
  --countname=us < offcpu.txt > offcpu.svg
```

## Memory Allocation Profiling with perf mem

`perf mem` records memory access events, useful for identifying cache thrashing and NUMA imbalances.

```bash
# Record memory access events
perf mem record -a -- sleep 30

# Report with load and store analysis
perf mem report

# Record on NUMA system — show remote memory accesses
perf mem record -e cpu/mem-loads-aux/ -a -- sleep 30
perf mem report --sort=mem,sym,dso

# Combined perf stat for memory bandwidth
perf stat -e \
  cpu/event=0xd1,umask=0x01,name=mem_load_retired_l1_hit/,\
  cpu/event=0xd1,umask=0x02,name=mem_load_retired_l2_hit/,\
  cpu/event=0xd1,umask=0x04,name=mem_load_retired_l3_hit/,\
  cpu/event=0xd1,umask=0x20,name=mem_load_retired_l3_miss/ \
  -a sleep 10
```

## Kernel vs Userspace Profiling

By default `perf record -g` captures both kernel and user stacks. Separate them for analysis:

```bash
# Record only userspace
perf record -F 99 --call-graph dwarf -p <PID> \
  --exclude-perf --no-inherit -- sleep 30

# Show kernel flame graph only
perf script | stackcollapse-perf.pl | grep -v " \[k\] " | flamegraph.pl > user.svg

# Kernel-only flame graph
perf record -F 99 -a -k monotonic -- sleep 30
perf script | grep " \[k\] " | stackcollapse-perf.pl | flamegraph.pl > kernel.svg
```

## Container Profiling in Kubernetes

Profiling containers is challenging because:
1. Container processes run in namespaces that hide them from the host
2. Symbols may not be available on the host
3. Security restrictions often block perf

### Privileged debug container approach

```bash
# Find the container's PID on the host
CONTAINER_ID=$(kubectl get pod myapp-pod -n production \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's|.*//||')

# Get host PID
HOST_PID=$(docker inspect --format '{{.State.Pid}}' $CONTAINER_ID)
# Or with containerd:
HOST_PID=$(crictl inspect $CONTAINER_ID | jq '.info.pid')

echo "Container PID on host: $HOST_PID"

# Profile from the host
sudo perf record -F 99 --call-graph dwarf -p $HOST_PID -- sleep 30
sudo perf script | stackcollapse-perf.pl | flamegraph.pl > container.svg
```

### kubectl debug with perf

```bash
# Create a privileged debug container
kubectl debug -it myapp-pod \
  --image=ubuntu:22.04 \
  --target=myapp \
  --profile=sysadmin \
  -- bash

# Inside the debug container
apt-get update && apt-get install -y linux-tools-$(uname -r)
# Profile using the shared PID namespace
perf record -F 99 -g --pid=$(cat /proc/*/status | grep -m1 Pid | awk '{print $2}') -- sleep 30
perf script > out.perf
```

### Privileged DaemonSet profiler

For continuous profiling across a cluster, deploy a profiler as a privileged DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: perf-profiler
  namespace: profiling
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
      tolerations:
      - effect: NoSchedule
        operator: Exists
      containers:
      - name: profiler
        image: registry.example.com/perf-profiler:latest
        securityContext:
          privileged: true
        command:
        - /bin/sh
        - -c
        - |
          while true; do
            perf record -F 99 -a -g -- sleep 60
            perf script | /flamegraph/stackcollapse-perf.pl \
              | /flamegraph/flamegraph.pl > /profiles/$(date +%Y%m%d-%H%M%S).svg
          done
        volumeMounts:
        - name: profiles
          mountPath: /profiles
        - name: flamegraph
          mountPath: /flamegraph
        resources:
          requests:
            cpu: 500m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
      volumes:
      - name: profiles
        hostPath:
          path: /var/log/perf-profiles
      - name: flamegraph
        configMap:
          name: flamegraph-scripts
          defaultMode: 0755
```

## Continuous Profiling with pprof (Go)

For Go applications, the built-in `pprof` profiler integrates directly with `perf`-style flame graphs through Brendan Gregg's tool or via Grafana Phlare.

```go
package main

import (
	"log"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof endpoints
	"runtime"
)

func main() {
	// Enable mutex profiling
	runtime.SetMutexProfileFraction(5)
	// Enable block profiling
	runtime.SetBlockProfileRate(1)

	// Start pprof server on separate port
	go func() {
		log.Println(http.ListenAndServe(":6060", nil))
	}()

	// ... rest of application
}
```

```bash
# Capture CPU profile
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=30

# Capture flame graph via pprof
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
# Inside pprof interactive:
(pprof) web        # Opens flame graph in browser
(pprof) top 20     # Shows top 20 functions by CPU
(pprof) list main  # Annotate main function

# One-liner for flame graph
go tool pprof -raw -output=cpu.txt http://localhost:6060/debug/pprof/profile?seconds=30
stackcollapse-go.pl cpu.txt | flamegraph.pl > go-flamegraph.svg
```

## Interpreting Flame Graphs

Reading a flame graph:
- **X-axis**: Sample count (not time) — width = proportion of total samples
- **Y-axis**: Call stack depth — bottom is the entry point, top is the leaf function
- **Color**: Random for visual differentiation (not meaningful by default)
- **Hover**: Shows function name and sample count

Red flags in flame graphs:
- **Wide flat plateaus at the top**: CPU time concentrated in one function — likely hotspot
- **Tall thin towers**: Deep recursion or call chains without much CPU at each level
- **Missing symbols** (hex addresses): Missing debug symbols — recompile with `-g` or install debuginfo
- **[unknown]** frames: Stack unwinding failure — switch from `--call-graph fp` to `--call-graph dwarf`

```bash
# Fix missing symbols for system libraries
# Install debuginfo packages
debuginfo-install glibc  # RHEL
apt-get install libc6-dbg  # Debian

# For Go programs with stripped binaries
go build -gcflags="-N -l" -o myserver ./cmd/server

# Check if symbols are present in perf.data
perf report --stdio | head -50
# Look for [.] userspace symbols vs [k] kernel symbols
```

## Automating Profiles on High CPU

```bash
#!/bin/bash
# auto-profile.sh — Capture a flame graph when CPU exceeds threshold

THRESHOLD=80
PID="${1:?PID required}"
OUTPUT_DIR="${2:-/tmp/profiles}"
mkdir -p "${OUTPUT_DIR}"

while true; do
  CPU=$(ps -p "$PID" -o %cpu --no-headers 2>/dev/null | tr -d ' ')
  if (( $(echo "$CPU > $THRESHOLD" | bc -l) )); then
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    echo "CPU is ${CPU}% — capturing profile at ${TIMESTAMP}"
    perf record -F 99 -p "$PID" -g -- sleep 30 \
      -o "${OUTPUT_DIR}/perf-${TIMESTAMP}.data"
    perf script -i "${OUTPUT_DIR}/perf-${TIMESTAMP}.data" \
      | stackcollapse-perf.pl \
      | flamegraph.pl > "${OUTPUT_DIR}/flamegraph-${TIMESTAMP}.svg"
    echo "Saved to ${OUTPUT_DIR}/flamegraph-${TIMESTAMP}.svg"
    sleep 60  # Don't profile again for 1 minute
  fi
  sleep 5
done
```

## Summary

Effective performance profiling in production follows this workflow:

1. Use `perf stat` to identify whether the workload is CPU-bound, memory-bound, or branch-heavy.
2. Use `perf record -F 99 -g` to capture call stacks at a low-overhead 99 Hz sampling rate.
3. Generate CPU flame graphs with `stackcollapse-perf.pl | flamegraph.pl` to find the widest code paths.
4. Use `bpftrace offcputime` for blocking analysis — I/O wait, lock contention, and sleep-heavy code.
5. For containers in Kubernetes, use `kubectl debug --profile=sysadmin` or a privileged DaemonSet.
6. For Go applications, enable the `net/http/pprof` endpoint and use `go tool pprof` for language-level profiling.

The combination of on-CPU and off-CPU flame graphs tells you the complete performance story of any Linux process.
