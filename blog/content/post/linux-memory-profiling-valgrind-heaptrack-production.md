---
title: "Linux Memory Profiling: Valgrind, Heaptrack, and Memory Leak Detection in Production"
date: 2030-01-19T00:00:00-05:00
draft: false
tags: ["Linux", "Memory", "Profiling", "Valgrind", "Heaptrack", "Performance", "Go", "C++"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to memory profiling tools for C/C++ and containerized Go/Rust workloads, covering Valgrind Memcheck, heaptrack for live profiling, Massif heap analysis, and AddressSanitizer in production builds."
more_link: "yes"
url: "/linux-memory-profiling-valgrind-heaptrack-production/"
---

Memory bugs are among the most elusive production problems. A Go service that grows from 200MB to 4GB over three days, a C++ daemon leaking 50KB per request, a Rust binary with unexpected heap fragmentation — all of these require different tools and methodologies. This guide covers the full spectrum: Valgrind Memcheck for finding leaks in native code, heaptrack for low-overhead live profiling of containerized workloads, Massif for visualizing heap growth, and AddressSanitizer integration for catching bugs earlier in the development cycle.

<!--more-->

# Linux Memory Profiling: Valgrind, Heaptrack, and Memory Leak Detection in Production

## Understanding Linux Memory Metrics

Before profiling, you need to correctly read memory usage. The metrics most commonly misinterpreted:

```bash
# Get comprehensive memory breakdown for a process
cat /proc/$PID/status | grep -i 'vm\|mem'

# Key fields:
# VmRSS  - Resident Set Size: physical RAM actually used
# VmPSS  - Proportional Set Size: RSS + (shared_pages / num_sharers)
# VmSwap - Memory in swap
# VmPeak - Peak RSS ever
# VmSize - Virtual address space (unreliable indicator)
# VmRSS  - What top/ps show - includes shared libraries

# More accurate: smaps
cat /proc/$PID/smaps | awk '
  /^Private_Dirty:/ { private_dirty += $2 }
  /^Pss:/           { pss += $2 }
  /^Rss:/           { rss += $2 }
  END {
    print "RSS:           " rss " kB"
    print "PSS:           " pss " kB"
    print "Private Dirty: " private_dirty " kB"
  }'
```

### Memory Metrics Reference

| Metric | What It Means | When to Use |
|--------|---------------|-------------|
| VmRSS | Pages in RAM (includes shared) | Quick sanity check |
| VmPSS | Proportional share of RSS | Fair comparison between processes |
| Private_Dirty | Exclusively held, modified pages | True memory cost of a process |
| VmSwap | Pages swapped out | Detect swap pressure |
| Anon (from smaps) | Anonymous mappings (heap, stack) | Track heap growth |

## Valgrind Memcheck

Valgrind is the gold standard for finding memory errors in native code. It instruments the binary at runtime to track every allocation and access.

### Basic Usage

```bash
# Install
apt-get install -y valgrind

# Run with full leak checking
valgrind \
  --tool=memcheck \
  --leak-check=full \
  --show-leak-kinds=all \
  --track-origins=yes \
  --num-callers=20 \
  --log-file=valgrind-report.txt \
  ./myapp --config /etc/app.conf

# Parse the summary
grep -A 20 "LEAK SUMMARY" valgrind-report.txt
```

### Understanding Leak Categories

```
LEAK SUMMARY:
   definitely lost: 1,024 bytes in 4 blocks    <- Your code forgot to free()
   indirectly lost: 512 bytes in 2 blocks      <- Lost because parent was lost
     possibly lost: 256 bytes in 1 blocks      <- Pointer arithmetic (may be intentional)
   still reachable: 8,192 bytes in 128 blocks  <- Global/static, freed at exit (usually OK)
        suppressed: 0 bytes in 0 blocks
```

### Suppression Files

```xml
<!-- valgrind-suppressions.supp -->
<!-- Suppress known false positives from OpenSSL -->
{
   openssl-init-leak
   Memcheck:Leak
   match-leak-kinds:reachable
   fun:malloc
   ...
   fun:CRYPTO_THREAD_run_once
}

<!-- Suppress glibc internal resolver allocation -->
{
   glibc-res-init
   Memcheck:Leak
   match-leak-kinds:reachable
   fun:malloc
   fun:__res_vinit
}
```

```bash
# Apply suppressions
valgrind \
  --tool=memcheck \
  --leak-check=full \
  --suppressions=valgrind-suppressions.supp \
  ./myapp
```

### Example: Finding a Real Leak

```c
/* leaky.c - Demonstration of different leak types */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

typedef struct Node {
    int value;
    struct Node *next;
} Node;

/* DEFINITELY LOST: pointer goes out of scope */
void definitely_lost() {
    char *buf = malloc(1024);
    memset(buf, 0, 1024);
    /* buf is never freed, and goes out of scope */
}

/* INDIRECTLY LOST: parent lost, children inaccessible */
void indirectly_lost() {
    Node *head = malloc(sizeof(Node));
    head->next = malloc(sizeof(Node));
    head->next->next = NULL;
    /* head freed but not head->next: indirectly lost */
    /* Actually: head itself is also lost here */
}

/* STILL REACHABLE: global never freed but accessible */
static char *global_buf = NULL;
void still_reachable() {
    global_buf = malloc(256);  /* Freed at program exit? No, it's not. */
}

/* CORRECT: properly freed */
void correct_usage() {
    char *buf = malloc(512);
    memset(buf, 0, 512);
    free(buf);
}

int main() {
    definitely_lost();
    indirectly_lost();
    still_reachable();
    correct_usage();
    return 0;
}
```

```bash
# Compile with debug symbols
gcc -g -O0 -o leaky leaky.c

# Run under Valgrind
valgrind --leak-check=full --show-leak-kinds=all ./leaky

# Output (truncated):
# ==12345== 1,024 bytes in 1 blocks are definitely lost in loss record 1 of 3
# ==12345==    at 0x4C2FB0F: malloc (in /usr/lib/valgrind/vgpreload_memcheck-amd64-linux.so)
# ==12345==    by 0x109178: definitely_lost (leaky.c:12)
# ==12345==    by 0x1091D2: main (leaky.c:33)
```

### Valgrind with Docker

```dockerfile
# Dockerfile.valgrind - Debug image for Valgrind analysis
FROM ubuntu:22.04 AS builder
RUN apt-get update && apt-get install -y \
    build-essential cmake valgrind gdb \
    libssl-dev zlib1g-dev

WORKDIR /src
COPY . .
RUN cmake -DCMAKE_BUILD_TYPE=Debug \
          -DCMAKE_CXX_FLAGS="-g -O0 -fno-omit-frame-pointer" \
          -B build && \
    cmake --build build

FROM ubuntu:22.04
RUN apt-get update && apt-get install -y valgrind
COPY --from=builder /src/build/myapp /usr/local/bin/myapp

# Run with Valgrind as entrypoint
ENTRYPOINT ["valgrind", \
    "--tool=memcheck", \
    "--leak-check=full", \
    "--show-leak-kinds=all", \
    "--track-origins=yes", \
    "--log-file=/tmp/valgrind.log", \
    "/usr/local/bin/myapp"]
```

## Heaptrack: Low-Overhead Live Profiling

Heaptrack is substantially faster than Valgrind (5-10x overhead vs 20-50x) and designed for profiling real workloads rather than just finding bugs. It records every heap allocation with a backtrace, then lets you analyze the data offline.

### Installation

```bash
# Ubuntu/Debian
apt-get install -y heaptrack heaptrack-gui

# Build from source for latest version
git clone https://github.com/KDE/heaptrack.git
cd heaptrack
cmake -DCMAKE_BUILD_TYPE=Release -B build
cmake --build build -j$(nproc)
sudo cmake --install build
```

### Profiling a Running Service

```bash
# Method 1: Start new process under heaptrack
heaptrack ./myservice --config /etc/config.yaml

# Method 2: Attach to running process (non-invasive)
heaptrack --pid $(pgrep myservice)

# Both methods create: heaptrack.myservice.TIMESTAMP.zst

# Analyze the captured data
heaptrack_print heaptrack.myservice.1234567890.zst

# GUI analysis (if X11 available)
heaptrack_gui heaptrack.myservice.1234567890.zst
```

### Interpreting heaptrack Output

```
# heaptrack summary output:
total runtime: 300.51s.
calls to allocation functions: 47,284,192 (157,337/s)
temporary allocations: 45,912,038 (97.1%, 152,779/s)
peak heap memory consumption: 512.00 MB
peak RSS (including heaptrack overhead): 527.45 MB

top 5 allocations by peak consumption:
#1 262,144,000 (250 MB) peak
  in void* operator new[](unsigned long)
  in std::vector<char, std::allocator<char>>::resize(unsigned long)
  in MessageProcessor::processRequest(Request const&)
  in HttpServer::handleConnection(int)

#2 104,857,600 (100 MB) peak
  in malloc
  in cache_init
  in ApplicationCache::ApplicationCache()
  in main
```

### Profiling Go Services with Heaptrack

Go's garbage collector manages its own heap, but native allocations (via CGo or the Go runtime's OS allocations) are visible to heaptrack:

```bash
# Profile a Go binary - captures OS-level allocations
heaptrack ./mygoservice

# For pure Go heap analysis, use pprof instead
# But heaptrack catches CGo memory leaks that pprof misses
```

### Go pprof for Go-Specific Profiling

```go
// internal/profiling/pprof_server.go
package profiling

import (
    "fmt"
    "net/http"
    _ "net/http/pprof" // registers /debug/pprof handlers
    "runtime"
    "time"
)

// StartProfilingServer starts the pprof HTTP server on a non-public port
func StartProfilingServer(port int) {
    runtime.SetMutexProfileFraction(5)
    runtime.SetBlockProfileRate(5)

    go func() {
        addr := fmt.Sprintf("127.0.0.1:%d", port)
        if err := http.ListenAndServe(addr, nil); err != nil {
            fmt.Printf("pprof server error: %v\n", err)
        }
    }()
}

// CaptureHeapProfile saves a heap profile to a file
func CaptureHeapProfile(path string) error {
    // Force GC before capturing to get accurate live object counts
    runtime.GC()

    f, err := os.Create(path)
    if err != nil {
        return fmt.Errorf("create profile file: %w", err)
    }
    defer f.Close()

    return pprof.WriteHeapProfile(f)
}

// HeapStats returns structured heap statistics
type HeapStats struct {
    AllocBytes      uint64
    TotalAllocBytes uint64
    SysBytes        uint64
    NumGC           uint32
    PauseTotalNs    uint64
    HeapObjects     uint64
    HeapInUse       uint64
    HeapIdle        uint64
    HeapReleased    uint64
    StackInUse      uint64
    GCCPUFraction   float64
}

func GetHeapStats() HeapStats {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    return HeapStats{
        AllocBytes:      m.Alloc,
        TotalAllocBytes: m.TotalAlloc,
        SysBytes:        m.Sys,
        NumGC:           m.NumGC,
        PauseTotalNs:    m.PauseTotalNs,
        HeapObjects:     m.HeapObjects,
        HeapInUse:       m.HeapInuse,
        HeapIdle:        m.HeapIdle,
        HeapReleased:    m.HeapReleased,
        StackInUse:      m.StackInuse,
        GCCPUFraction:   m.GCCPUFraction,
    }
}
```

### Automated pprof Analysis Script

```bash
#!/bin/bash
# analyze-go-heap.sh - Automated Go heap analysis

SERVICE_URL="${1:?Service pprof URL required (e.g. http://localhost:6060)}"
OUTPUT_DIR="${2:-/tmp/heap-profiles}"
DURATION="${3:-300}"  # 5 minutes

mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "Capturing baseline heap profile..."
curl -s "$SERVICE_URL/debug/pprof/heap" -o "$OUTPUT_DIR/heap_baseline_$TIMESTAMP.pb.gz"

echo "Waiting $DURATION seconds..."
sleep "$DURATION"

echo "Capturing comparison heap profile..."
curl -s "$SERVICE_URL/debug/pprof/heap" -o "$OUTPUT_DIR/heap_after_$TIMESTAMP.pb.gz"

echo ""
echo "=== Top allocations (after profile) ==="
go tool pprof -text "$OUTPUT_DIR/heap_after_$TIMESTAMP.pb.gz" | head -30

echo ""
echo "=== Heap growth analysis ==="
go tool pprof \
  -base "$OUTPUT_DIR/heap_baseline_$TIMESTAMP.pb.gz" \
  -text "$OUTPUT_DIR/heap_after_$TIMESTAMP.pb.gz" | \
  head -20

echo ""
echo "=== Goroutine count ==="
curl -s "$SERVICE_URL/debug/pprof/goroutine?debug=1" | head -5

echo ""
echo "Generating flamegraph..."
go tool pprof \
  -svg \
  -output "$OUTPUT_DIR/heap_flamegraph_$TIMESTAMP.svg" \
  "$OUTPUT_DIR/heap_after_$TIMESTAMP.pb.gz"

echo "Report saved to: $OUTPUT_DIR"
```

## Massif: Heap Profiler with Visualization

Massif is Valgrind's heap profiler — it takes snapshots of heap usage over time, enabling you to see exactly when and where memory grew.

### Running Massif

```bash
# Basic massif run
valgrind --tool=massif \
  --time-unit=ms \
  --detailed-freq=1 \
  --max-snapshots=200 \
  --pages-as-heap=yes \
  ./myapp

# This creates: massif.out.PID

# View the results
ms_print massif.out.12345 | head -100

# Interactive analysis with massif-visualizer (if GUI available)
massif-visualizer massif.out.12345
```

### Example Massif Output

```
    MB
512.0^                                              ######
     |                                          ####
     |                                      ####
     |                              #########
     |              ################
     |  #############
 0.0 +------------------------------------------------------> ms
                 0                 1000              2000

Detailed snapshots: [14, 15 (peak), 16]
```

### Analyzing Massif Results Programmatically

```python
#!/usr/bin/env python3
# parse_massif.py - Parse and analyze Massif output

import re
import sys
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Snapshot:
    snapshot_id: int
    time_ms: float
    mem_heap_bytes: int
    mem_heap_extra_bytes: int
    mem_stacks_bytes: int
    heap_tree: Optional[str] = None


def parse_massif_output(filepath: str) -> List[Snapshot]:
    snapshots = []
    current_snapshot = None

    with open(filepath) as f:
        content = f.read()

    # Split on snapshot boundaries
    snapshot_blocks = re.split(r'(?=^#-----------$)', content, flags=re.MULTILINE)

    for block in snapshot_blocks:
        lines = block.strip().split('\n')
        snapshot_data = {}

        for line in lines:
            if '=' in line:
                key, _, value = line.partition('=')
                snapshot_data[key.strip()] = value.strip()

        if 'snapshot' in snapshot_data:
            s = Snapshot(
                snapshot_id=int(snapshot_data.get('snapshot', 0)),
                time_ms=float(snapshot_data.get('time', 0)),
                mem_heap_bytes=int(snapshot_data.get('mem_heap_B', 0)),
                mem_heap_extra_bytes=int(snapshot_data.get('mem_heap_extra_B', 0)),
                mem_stacks_bytes=int(snapshot_data.get('mem_stacks_B', 0)),
            )
            snapshots.append(s)

    return snapshots


def find_memory_growth_points(snapshots: List[Snapshot]) -> List[dict]:
    growth_events = []
    for i in range(1, len(snapshots)):
        prev = snapshots[i-1]
        curr = snapshots[i]
        delta = curr.mem_heap_bytes - prev.mem_heap_bytes
        delta_mb = delta / (1024 * 1024)
        if abs(delta_mb) > 10:  # 10MB threshold
            growth_events.append({
                'snapshot': curr.snapshot_id,
                'time_ms': curr.time_ms,
                'delta_mb': delta_mb,
                'total_mb': curr.mem_heap_bytes / (1024 * 1024),
            })
    return growth_events


if __name__ == '__main__':
    filepath = sys.argv[1] if len(sys.argv) > 1 else 'massif.out'
    snapshots = parse_massif_output(filepath)

    peak = max(snapshots, key=lambda s: s.mem_heap_bytes)
    print(f"Peak heap: {peak.mem_heap_bytes / (1024*1024):.1f} MB at {peak.time_ms:.0f}ms")
    print(f"Total snapshots: {len(snapshots)}")

    print("\nSignificant memory changes:")
    for event in find_memory_growth_points(snapshots):
        direction = "grew" if event['delta_mb'] > 0 else "shrank"
        print(f"  Snapshot {event['snapshot']} (t={event['time_ms']:.0f}ms): "
              f"heap {direction} by {abs(event['delta_mb']):.1f} MB "
              f"(total: {event['total_mb']:.1f} MB)")
```

## AddressSanitizer in Production Builds

AddressSanitizer (ASan) is a fast memory error detector compiled into the binary. It catches use-after-free, heap/stack buffer overflows, and other memory errors with ~2x overhead — feasible for canary deployments.

### C/C++ with AddressSanitizer

```bash
# Compile with ASan
gcc -g -fsanitize=address -fno-omit-frame-pointer \
    -O1 \  # Keep some optimization but preserve frame pointers
    -o myapp_asan myapp.c

# Set runtime options
export ASAN_OPTIONS="detect_leaks=1:halt_on_error=0:log_path=/tmp/asan:quarantine_size_mb=32"
export LSAN_OPTIONS="verbosity=1:log_threads=1:max_leaks=50"

./myapp_asan

# ASan report example:
# ==12345==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000030
# READ of size 4 at 0x602000000030 thread T0
#     #0 0x40109b in main /src/myapp.c:42:5
# 0x602000000030 is located 0 bytes inside of 16-byte region
# previously freed by thread T0:
#     #0 0x4010d3 in main /src/myapp.c:38:3
```

### Go Race Detector (Go's ASan Equivalent)

```bash
# Build with race detector
go build -race -o myservice ./cmd/server

# Run with race detection
./myservice

# Output example:
# ==================
# WARNING: DATA RACE
# Write at 0x00c0000b4010 by goroutine 7:
#   main.incrementCounter()
#       /src/main.go:25 +0x58
# Previous read at 0x00c0000b4010 by goroutine 6:
#   main.readCounter()
#       /src/main.go:19 +0x44
# ==================
```

### Kubernetes Canary with ASan

```yaml
# asan-canary-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-asan-canary
  namespace: production
  labels:
    app: myapp
    variant: asan-canary
spec:
  replicas: 1
  selector:
    matchLabels:
      app: myapp
      variant: asan-canary
  template:
    metadata:
      labels:
        app: myapp
        variant: asan-canary
      annotations:
        prometheus.io/scrape: "true"
    spec:
      containers:
        - name: myapp
          image: registry.company.com/myapp:v2.0.0-asan
          env:
            - name: ASAN_OPTIONS
              value: "detect_leaks=1:halt_on_error=0:log_path=/tmp/asan:max_leaks=50"
            - name: ASAN_LOG_DIR
              value: "/tmp/asan"
          volumeMounts:
            - name: asan-logs
              mountPath: /tmp/asan
          resources:
            requests:
              cpu: "400m"    # 2x normal (ASan overhead)
              memory: "512Mi"  # 2x normal (shadow memory)
            limits:
              cpu: "2"
              memory: "2Gi"
          # Sidecar to ship ASan logs
        - name: log-shipper
          image: fluent/fluent-bit:3.0
          volumeMounts:
            - name: asan-logs
              mountPath: /tmp/asan
      volumes:
        - name: asan-logs
          emptyDir:
            medium: Memory
```

## Automated Leak Detection in CI

### GitHub Actions Memory Test

```yaml
# .github/workflows/memory-tests.yml
name: Memory Leak Tests
on:
  push:
    branches: [main]
  pull_request:

jobs:
  valgrind:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Valgrind
        run: sudo apt-get install -y valgrind

      - name: Build with debug symbols
        run: |
          cmake -DCMAKE_BUILD_TYPE=Debug \
                -DCMAKE_CXX_FLAGS="-g -O0" \
                -B build
          cmake --build build

      - name: Run Valgrind Memcheck
        run: |
          valgrind \
            --tool=memcheck \
            --leak-check=full \
            --error-exitcode=1 \
            --suppressions=ci/valgrind.supp \
            --gen-suppressions=all \
            --log-file=valgrind-output.txt \
            ./build/tests/unit_tests
        continue-on-error: true

      - name: Check for leaks
        run: |
          if grep -q "definitely lost: [^0]" valgrind-output.txt; then
            echo "MEMORY LEAKS DETECTED:"
            grep -A 30 "LEAK SUMMARY" valgrind-output.txt
            exit 1
          fi
          echo "No definite memory leaks found"

      - name: Upload Valgrind report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: valgrind-report
          path: valgrind-output.txt

  asan-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build with AddressSanitizer
        run: |
          cmake -DCMAKE_BUILD_TYPE=RelWithDebInfo \
                -DCMAKE_CXX_FLAGS="-fsanitize=address,leak -fno-omit-frame-pointer" \
                -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=address,leak" \
                -B build-asan
          cmake --build build-asan

      - name: Run ASan tests
        env:
          ASAN_OPTIONS: "detect_leaks=1:halt_on_error=1"
          LSAN_OPTIONS: "max_leaks=0"
        run: ./build-asan/tests/unit_tests

  go-race:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      - name: Run Go tests with race detector
        run: go test -race -timeout 300s ./...

      - name: Run Go tests with memory profiling
        run: |
          go test -memprofile=/tmp/mem.prof -memprofilerate=1 ./...
          go tool pprof -text /tmp/mem.prof | head -20
```

## Production Memory Analysis Workflow

### Detecting Slow Leaks in Production

```bash
#!/bin/bash
# detect-memory-leak.sh - Monitor a process for slow memory leaks

PID="${1:?PID required}"
SAMPLE_INTERVAL="${2:-60}"   # seconds between samples
SAMPLES="${3:-60}"            # number of samples
OUTPUT_FILE="${4:-memory-trend.csv}"

echo "timestamp,rss_kb,pss_kb,private_dirty_kb,heap_kb" > "$OUTPUT_FILE"

echo "Monitoring PID $PID for $((SAMPLES * SAMPLE_INTERVAL))s..."

for i in $(seq 1 "$SAMPLES"); do
  TIMESTAMP=$(date +%s)

  RSS=$(grep VmRSS /proc/$PID/status 2>/dev/null | awk '{print $2}')
  if [ -z "$RSS" ]; then
    echo "Process $PID no longer exists"
    break
  fi

  PSS=$(awk '/^Pss:/{sum+=$2} END{print sum}' /proc/$PID/smaps 2>/dev/null)
  PRIVATE=$(awk '/^Private_Dirty:/{sum+=$2} END{print sum}' /proc/$PID/smaps 2>/dev/null)
  HEAP=$(awk '/\[heap\]/{found=1} found && /^Rss:/{print $2; exit}' /proc/$PID/smaps 2>/dev/null)

  echo "$TIMESTAMP,$RSS,$PSS,$PRIVATE,$HEAP" >> "$OUTPUT_FILE"

  # Check for rapid growth (>10% in last 5 samples)
  if [ "$i" -gt 5 ]; then
    CURRENT_PSS="$PSS"
    PREV_PSS=$(tail -5 "$OUTPUT_FILE" | head -1 | cut -d',' -f3)
    if [ "$PREV_PSS" -gt 0 ]; then
      GROWTH=$(( (CURRENT_PSS - PREV_PSS) * 100 / PREV_PSS ))
      if [ "$GROWTH" -gt 10 ]; then
        echo "WARNING: Memory grew $GROWTH% in last 5 samples (${PREV_PSS}KB -> ${CURRENT_PSS}KB)"
      fi
    fi
  fi

  sleep "$SAMPLE_INTERVAL"
done

echo "Analysis complete. Results in: $OUTPUT_FILE"

# Simple trend analysis
python3 - "$OUTPUT_FILE" << 'PYEOF'
import sys
import csv

rows = []
with open(sys.argv[1]) as f:
    reader = csv.DictReader(f)
    rows = list(reader)

if len(rows) < 2:
    print("Insufficient data for trend analysis")
    sys.exit(0)

first_pss = int(rows[0]['pss_kb'])
last_pss = int(rows[-1]['pss_kb'])
duration_min = (int(rows[-1]['timestamp']) - int(rows[0]['timestamp'])) / 60

growth_kb_per_min = (last_pss - first_pss) / duration_min
growth_mb_per_hour = growth_kb_per_min * 60 / 1024

print(f"\n=== Memory Trend Analysis ===")
print(f"Start PSS: {first_pss/1024:.1f} MB")
print(f"End PSS:   {last_pss/1024:.1f} MB")
print(f"Duration:  {duration_min:.1f} minutes")
print(f"Growth rate: {growth_mb_per_hour:.2f} MB/hour")

if growth_mb_per_hour > 10:
    print("STATUS: LIKELY MEMORY LEAK - growth rate exceeds 10 MB/hour")
elif growth_mb_per_hour > 1:
    print("STATUS: POSSIBLE MEMORY LEAK - moderate growth rate")
else:
    print("STATUS: NORMAL - growth rate within acceptable bounds")
PYEOF
```

## Prometheus Alerts for Memory Issues

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: memory-leak-alerts
  namespace: monitoring
spec:
  groups:
    - name: memory.alerts
      rules:
        - alert: PodMemoryGrowthSuspicious
          expr: |
            (
              container_memory_working_set_bytes{container!=""}
              - container_memory_working_set_bytes{container!=""} offset 1h
            ) / container_memory_working_set_bytes{container!=""} offset 1h * 100 > 50
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Suspicious memory growth in {{ $labels.container }}"
            description: >-
              Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }}
              has grown by {{ $value | humanize }}% in the last hour.
              Current: {{ with printf `container_memory_working_set_bytes{container="%s",pod="%s"}` $labels.container $labels.pod | query }}{{ . | first | value | humanize1024 }}B{{ end }}

        - alert: PodMemoryNearLimit
          expr: |
            container_memory_working_set_bytes{container!=""}
            / container_spec_memory_limit_bytes{container!=""} > 0.85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Container {{ $labels.container }} near memory limit"

        - alert: NodeSwapUsageHigh
          expr: |
            (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes)
            / node_memory_SwapTotal_bytes * 100 > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Node {{ $labels.node }} swap usage high"
```

## Conclusion

Memory profiling requires matching the right tool to the problem:

- **Valgrind Memcheck** is the most thorough option for native code — use it in development and CI to find definite leaks before they reach production
- **Heaptrack** provides production-viable profiling (5-10x overhead) for scenarios where you need to understand allocation patterns under real load
- **Massif** visualizes heap growth over time, making it ideal for diagnosing gradual memory growth in long-running services
- **AddressSanitizer** catches buffer overflows and use-after-free at roughly 2x overhead — suitable for canary deployments when you suspect heap corruption
- **Go pprof** is the right tool for Go services, providing allocation profiles, goroutine counts, and heap statistics via the standard HTTP endpoint
- **Process metrics from /proc** are always available and sufficient for detecting slow leaks in production via Prometheus alerting

The most effective workflow combines all of these: ASan/Memcheck in CI, heaptrack for load-testing profiling, pprof for Go heap analysis, and Prometheus alerts for detecting slow leaks in production before they cause OOM kills.
