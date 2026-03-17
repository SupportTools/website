---
title: "Linux Performance Analysis: flamegraph, speedscope, and Continuous Profiling"
date: 2029-08-05T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Profiling", "flamegraph", "Pyroscope", "eBPF", "pprof", "Go", "JVM"]
categories: ["Linux", "Performance", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux performance profiling: the perf-to-flamegraph pipeline, async-profiler for JVM, pprof integration for Go, Pyroscope continuous profiling, and eBPF-based profiling with bpftrace."
more_link: "yes"
url: "/linux-performance-analysis-flamegraph-speedscope-continuous-profiling/"
---

A flamegraph is the single most information-dense visualization available for understanding where CPU time goes. Brendan Gregg's original flamegraph format, now supported by virtually every profiling tool, lets you immediately identify hot code paths through a visual stack trace aggregation. But getting to a useful flamegraph requires understanding the full profiling pipeline: sampling, symbolization, aggregation, and rendering. This guide covers the complete toolkit: from `perf record` to flamegraph for native code, async-profiler for JVM, pprof for Go, Pyroscope for continuous profiling, and eBPF-based approaches that work without application modifications.

<!--more-->

# Linux Performance Analysis: flamegraph, speedscope, and Continuous Profiling

## The Flamegraph Concept

A flamegraph shows the population of stack traces collected during a profiling session:
- Each box represents a stack frame
- Width represents how often that frame appeared in samples (proportional to CPU time)
- Frames are stacked top-to-bottom from root (bottom) to leaf (top)
- Color is typically random or semantic (red = hot, blue = cold in some tools)
- The widest boxes at the leaf level are your optimization targets

Brendan Gregg's original scripts: https://github.com/brendangregg/FlameGraph

## perf: The Standard Linux Profiler

`perf` is the standard Linux performance profiling tool, built into the kernel. It can profile CPU cycles, cache misses, context switches, and custom hardware events.

### Basic perf Workflow

```bash
# Install perf (matches your kernel version)
apt-get install linux-tools-$(uname -r) linux-tools-generic

# Record CPU samples for all CPUs for 30 seconds
perf record -F 99 -a -g -- sleep 30
# -F 99: 99 Hz sampling frequency (avoids 100 Hz lock-step)
# -a: all CPUs
# -g: capture call graph (stack traces)

# Record a specific process
perf record -F 99 -p $(pgrep my-app) -g -- sleep 30

# Record with a specific event (instead of CPU cycles)
perf record -e cache-misses -g -p $(pgrep my-app) -- sleep 10

# View perf report (interactive TUI)
perf report

# Generate flamegraph from perf data
perf script > perf.out
cat perf.out | stackcollapse-perf.pl | flamegraph.pl > flamegraph.svg

# Open flamegraph in browser
python3 -m http.server 8080 &
# Navigate to http://localhost:8080/flamegraph.svg
```

### Installing FlameGraph Scripts

```bash
git clone https://github.com/brendangregg/FlameGraph.git
cd FlameGraph

# Key scripts:
# stackcollapse-perf.pl - Collapse perf script output
# stackcollapse-jvm.pl  - Collapse JVM stacks
# flamegraph.pl         - Generate SVG flamegraph
# difffolded.pl         - Generate differential flamegraph

# Add to PATH
export PATH=$PATH:$(pwd)
```

### Advanced perf Options

```bash
# Profile with DWARF debug info (more accurate stack traces)
perf record -F 99 -a --call-graph dwarf -- sleep 30

# Profile with LBR (Last Branch Record) for precise branch tracing
perf record -F 99 -a --call-graph lbr -- sleep 30

# Profile kernel and userspace
perf record -F 99 -a -g -k clockmonotonic -- sleep 30

# Sample multiple events simultaneously
perf record -e cycles,cache-misses,instructions -g -p <pid> -- sleep 30

# Annotate hot functions with source code
perf annotate -l my_function

# Look at scheduler latency (off-CPU analysis)
perf sched record -a -- sleep 30
perf sched latency

# Memory access pattern analysis
perf mem record -p <pid> -- sleep 30
perf mem report
```

### Differential Flamegraphs

Differential flamegraphs compare two profiling sessions — invaluable for before/after performance optimization:

```bash
# Capture baseline
perf record -F 99 -p $(pgrep app) -g -- sleep 30
perf script > before.perf

# Make change, capture after
perf record -F 99 -p $(pgrep app) -g -- sleep 30
perf script > after.perf

# Generate differential flamegraph
stackcollapse-perf.pl before.perf > before.folded
stackcollapse-perf.pl after.perf > after.folded

# Diff: red = increase in after, blue = decrease
difffolded.pl before.folded after.folded | flamegraph.pl > diff.svg

# Reverse diff: focus on what improved
difffolded.pl -n before.folded after.folded | flamegraph.pl > diff-reversed.svg
```

## async-profiler: JVM Profiling

async-profiler is the gold standard for JVM profiling. Unlike JVM-native profilers, it uses Linux `perf_events` and `AsyncGetCallTrace` to accurately capture CPU time in both Java and native code.

### Setting Up async-profiler

```bash
# Download async-profiler
wget https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz
tar xzf async-profiler-3.0-linux-x64.tar.gz

# Profile a running JVM process
PID=$(pgrep -f "my-java-app")
./profiler.sh -e cpu -d 30 -f output.jfr $PID

# Generate flamegraph from JFR output
./profiler.sh -d 30 -f flamegraph.html $PID
# Opens as an interactive HTML flamegraph

# Profile CPU time specifically
./profiler.sh -e cpu -d 30 -o flamegraph -f cpu.html $PID

# Profile allocations (heap profiling)
./profiler.sh -e alloc -d 30 -f alloc.html $PID

# Profile locks and contention
./profiler.sh -e lock -d 30 -f lock.html $PID

# Profile wall clock (includes time waiting for I/O)
./profiler.sh -e wall -d 30 -f wall.html $PID
```

### Programmatic async-profiler with JFR

```java
// Add to application startup for continuous profiling
import one.profiler.AsyncProfiler;

public class ProfilerSetup {
    public static void startProfiling() throws Exception {
        AsyncProfiler profiler = AsyncProfiler.getInstance();

        // Start CPU profiling, writing JFR files every 60 seconds
        profiler.execute("start,event=cpu,interval=10ms,file=/tmp/profile-%t.jfr,jfrsync=profile");

        // Schedule periodic snapshots
        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleAtFixedRate(() -> {
            try {
                profiler.execute("dump,file=/tmp/profile-" + System.currentTimeMillis() + ".jfr");
            } catch (Exception e) {
                logger.error("Profile dump failed", e);
            }
        }, 60, 60, TimeUnit.SECONDS);
    }
}
```

### Kubernetes Sidecar for JVM Profiling

```yaml
# jvm-profiler-sidecar.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: java-app
spec:
  template:
    spec:
      volumes:
        - name: async-profiler
          emptyDir: {}
        - name: profiles
          emptyDir: {}

      initContainers:
        - name: install-profiler
          image: alpine:3.19
          command:
            - sh
            - -c
            - |
              wget -qO- https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz | tar xz
              cp async-profiler-3.0-linux-x64/profiler.sh /profiler/
              cp async-profiler-3.0-linux-x64/lib/libasyncProfiler.so /profiler/
          volumeMounts:
            - name: async-profiler
              mountPath: /profiler

      containers:
        - name: app
          image: my-java-app:latest
          env:
            - name: JAVA_TOOL_OPTIONS
              value: "-agentpath:/profiler/libasyncProfiler.so=start,event=cpu,interval=10ms,file=/profiles/cpu-%t.jfr,jfrsync=profile"
          volumeMounts:
            - name: async-profiler
              mountPath: /profiler
            - name: profiles
              mountPath: /profiles
```

## pprof: Go Profiling

Go has excellent built-in profiling support via the `pprof` package.

### Enabling pprof in Your Application

```go
package main

import (
    "log"
    "net/http"
    _ "net/http/pprof"  // Import for side effects (registers handlers)
    "time"
)

func main() {
    // Start pprof server on a separate port
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()

    // Your application logic
    runServer()
}
```

### Collecting and Analyzing Profiles

```bash
# CPU profile: capture 30 seconds of CPU usage
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Heap profile: current memory allocations
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutine profile
go tool pprof http://localhost:6060/debug/pprof/goroutine

# Mutex contention profile
go tool pprof http://localhost:6060/debug/pprof/mutex

# Block profile (goroutine blocking events)
go tool pprof http://localhost:6060/debug/pprof/block

# Download profiles for offline analysis
curl -o cpu.prof http://localhost:6060/debug/pprof/profile?seconds=30
curl -o heap.prof http://localhost:6060/debug/pprof/heap
curl -o goroutine.prof http://localhost:6060/debug/pprof/goroutine

# Interactive analysis
go tool pprof cpu.prof
# Commands in pprof:
# top          - Top functions by sample count
# top -cum     - Top functions including callers (cumulative)
# web          - Generate SVG flamegraph (requires graphviz)
# weblist func - Show annotated source for function
# list func    - Show source for function
# traces       - Show individual stack traces

# Generate flamegraph directly
go tool pprof -http=:8080 cpu.prof
# Opens interactive web UI with flamegraph view
```

### Programmatic Profiling in Tests

```go
package mypackage_test

import (
    "os"
    "runtime/pprof"
    "testing"
)

func BenchmarkHotPath(b *testing.B) {
    // Profile the benchmark itself
    f, _ := os.Create("cpu.prof")
    defer f.Close()
    pprof.StartCPUProfile(f)
    defer pprof.StopCPUProfile()

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        HotFunction()
    }
}

func TestWithHeapProfile(t *testing.T) {
    HeavyFunction()

    // Capture heap profile after heavy operation
    f, _ := os.Create("heap.prof")
    defer f.Close()
    pprof.WriteHeapProfile(f)
}
```

### Continuous pprof Collection

```go
package profiling

import (
    "context"
    "fmt"
    "os"
    "runtime/pprof"
    "time"
)

// ContinuousProfiler captures CPU profiles at regular intervals
type ContinuousProfiler struct {
    outputDir string
    interval  time.Duration
    duration  time.Duration
}

func NewContinuousProfiler(outputDir string, interval, duration time.Duration) *ContinuousProfiler {
    return &ContinuousProfiler{
        outputDir: outputDir,
        interval:  interval,
        duration:  duration,
    }
}

func (p *ContinuousProfiler) Start(ctx context.Context) {
    ticker := time.NewTicker(p.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            p.captureProfile()
        }
    }
}

func (p *ContinuousProfiler) captureProfile() {
    filename := fmt.Sprintf("%s/cpu-%d.prof", p.outputDir, time.Now().Unix())
    f, err := os.Create(filename)
    if err != nil {
        return
    }
    defer f.Close()

    pprof.StartCPUProfile(f)
    time.Sleep(p.duration)
    pprof.StopCPUProfile()
}
```

## speedscope: Web-Based Profile Viewer

speedscope is a web-based interactive flamegraph viewer that supports multiple profile formats:

```bash
# Install speedscope
npm install -g speedscope

# Open a pprof profile
speedscope cpu.prof

# Open a perf profile
perf script > perf.txt
speedscope perf.txt

# Open a V8/Node.js profile
node --prof my-app.js
node --prof-process isolate-*.log > node.prof
speedscope node.prof
```

speedscope's key advantage over static SVG flamegraphs is its "Left Heavy" view which sorts frames by total time, making it much easier to identify optimization targets in deep call stacks.

## Pyroscope: Continuous Profiling

Pyroscope is an open-source continuous profiling platform. Unlike point-in-time profiles, continuous profiling provides a time series of profiling data, allowing you to correlate performance events with deployments, traffic spikes, and incidents.

### Deploying Pyroscope on Kubernetes

```yaml
# pyroscope-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pyroscope
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pyroscope
  template:
    metadata:
      labels:
        app: pyroscope
    spec:
      containers:
        - name: pyroscope
          image: grafana/pyroscope:1.5.0
          args:
            - -config.file=/etc/pyroscope/config.yaml
          ports:
            - name: http
              containerPort: 4040
          volumeMounts:
            - name: config
              mountPath: /etc/pyroscope
            - name: data
              mountPath: /data
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
      volumes:
        - name: config
          configMap:
            name: pyroscope-config
        - name: data
          persistentVolumeClaim:
            claimName: pyroscope-data
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: pyroscope-config
  namespace: monitoring
data:
  config.yaml: |
    storage:
      path: /data/pyroscope

    scrape_configs:
      - job_name: go-applications
        enabled_profiles:
          - profile_type: process_cpu
          - profile_type: memory
          - profile_type: goroutines
        static_configs:
          - targets: ['app-service.production:6060']
            labels:
              app: order-service
              env: production
```

### Instrumenting Go Applications for Pyroscope

```go
package main

import (
    "context"
    "log"

    "github.com/grafana/pyroscope-go"
)

func main() {
    // Configure Pyroscope client
    profiler, err := pyroscope.Start(pyroscope.Config{
        ApplicationName: "order-service",

        // Pyroscope server URL
        ServerAddress: "http://pyroscope.monitoring.svc.cluster.local:4040",

        // Tags for filtering in the UI
        Tags: map[string]string{
            "version":     "1.2.3",
            "environment": "production",
            "region":      "us-east-1",
        },

        // Profile types to collect
        ProfileTypes: []pyroscope.ProfileType{
            pyroscope.ProfileCPU,
            pyroscope.ProfileAllocObjects,
            pyroscope.ProfileAllocSpace,
            pyroscope.ProfileInuseObjects,
            pyroscope.ProfileInuseSpace,
            pyroscope.ProfileGoroutines,
            pyroscope.ProfileMutexCount,
            pyroscope.ProfileMutexDuration,
            pyroscope.ProfileBlockCount,
            pyroscope.ProfileBlockDuration,
        },
    })
    if err != nil {
        log.Fatal(err)
    }
    defer profiler.Stop()

    // The profiler runs in the background
    // Your application runs normally
    runApplication(context.Background())
}
```

### Pyroscope with Request Context Labels

One of Pyroscope's most powerful features is per-request tagging, allowing you to filter profiles by endpoint, user segment, or tenant:

```go
package middleware

import (
    "net/http"

    "github.com/grafana/pyroscope-go"
)

// ProfilingMiddleware adds per-request profiling labels
func ProfilingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Tag this goroutine's profile with request context
        pyroscope.TagWrapper(r.Context(), pyroscope.Labels(
            "endpoint", r.URL.Path,
            "method", r.Method,
            "tenant", r.Header.Get("X-Tenant-ID"),
        ), func(ctx context.Context) {
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    })
}
```

## eBPF-Based Profiling

eBPF profiling works without any application changes and can profile the entire system stack including kernel code.

### bpftrace for Profiling

```bash
# Install bpftrace
apt-get install bpftrace

# CPU profiling using hardware performance counters
bpftrace -e '
profile:hz:99 /pid == 12345/ {
    @cpu[ustack()] = count();
}
interval:s:30 {
    exit();
}' | stackcollapse-bpftrace.pl | flamegraph.pl > ebpf-cpu.svg

# Profile ALL processes including kernel
bpftrace -e '
profile:hz:99 {
    @[ustack(), kstack(), comm] = count();
}
interval:s:30 {
    exit();
}'

# Off-CPU profiling: where are processes spending time NOT on CPU?
bpftrace -e '
tracepoint:sched:sched_switch {
    if (prev->state != TASK_RUNNING) {
        @offcpu_start[prev->pid] = nsecs;
        @offcpu_stack[prev->pid] = ustack(prev);
    }
}
tracepoint:sched:sched_switch {
    if (@offcpu_start[args->next_pid]) {
        @offcpu[comm, @offcpu_stack[args->next_pid]] +=
            nsecs - @offcpu_start[args->next_pid];
        delete(@offcpu_start[args->next_pid]);
        delete(@offcpu_stack[args->next_pid]);
    }
}' 2>/dev/null
```

### parca: eBPF-Based Continuous Profiling

```yaml
# parca-deployment.yaml
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
      tolerations:
        - operator: Exists
      containers:
        - name: parca-agent
          image: ghcr.io/parca-dev/parca-agent:v0.31.0
          args:
            - --http-address=:7071
            - --node=$(NODE_NAME)
            - --remote-store-address=parca.monitoring.svc.cluster.local:7070
            - --remote-store-insecure
            - --profiling-duration=10s
            - --profiling-cpu-sampling-frequency=19
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          securityContext:
            privileged: true
          volumeMounts:
            - name: root
              mountPath: /host/root
              readOnly: true
            - name: proc
              mountPath: /host/proc
              readOnly: true
            - name: run
              mountPath: /run
            - name: modules
              mountPath: /lib/modules
            - name: debugfs
              mountPath: /sys/kernel/debug
      volumes:
        - name: root
          hostPath:
            path: /
        - name: proc
          hostPath:
            path: /proc
        - name: run
          hostPath:
            path: /run
        - name: modules
          hostPath:
            path: /lib/modules
        - name: debugfs
          hostPath:
            path: /sys/kernel/debug
```

## Full Production Pipeline: perf to Flamegraph

```bash
#!/bin/bash
# profile-and-graph.sh - Complete profiling pipeline

set -euo pipefail

TARGET_PID="${1:?Usage: $0 <pid> [duration_seconds]}"
DURATION="${2:-30}"
OUTPUT_DIR="${3:-/tmp/profiles/$(date +%Y%m%d-%H%M%S)}"

mkdir -p "$OUTPUT_DIR"

echo "Profiling PID $TARGET_PID for ${DURATION}s..."

# Step 1: Capture with perf
perf record \
  -F 99 \
  -p "$TARGET_PID" \
  -g \
  --call-graph dwarf \
  -o "${OUTPUT_DIR}/perf.data" \
  -- sleep "$DURATION"

echo "Generating flamegraph..."

# Step 2: Extract stack traces
perf script -i "${OUTPUT_DIR}/perf.data" > "${OUTPUT_DIR}/perf.out"

# Step 3: Collapse stacks
stackcollapse-perf.pl "${OUTPUT_DIR}/perf.out" > "${OUTPUT_DIR}/folded.txt"

# Step 4: Generate flamegraph
flamegraph.pl \
  --title "CPU Profile - PID ${TARGET_PID}" \
  --subtitle "$(ps -p $TARGET_PID -o comm=) $(date)" \
  --width 1400 \
  --colors hot \
  "${OUTPUT_DIR}/folded.txt" > "${OUTPUT_DIR}/flamegraph.svg"

# Step 5: Generate speedscope format too
cp "${OUTPUT_DIR}/perf.out" "${OUTPUT_DIR}/profile.txt"

echo "Profiles saved to: $OUTPUT_DIR"
echo "  Flamegraph: ${OUTPUT_DIR}/flamegraph.svg"
echo "  View with:  python3 -m http.server 8080 --directory ${OUTPUT_DIR}"

# Open if running interactively
if [ -t 1 ]; then
    xdg-open "${OUTPUT_DIR}/flamegraph.svg" 2>/dev/null || true
fi
```

## Summary

A complete Linux performance analysis toolkit in 2029:

1. **perf + FlameGraph**: The foundation. Works for any language, requires kernel support. Best for CPU-bound issues in native code.
2. **async-profiler**: The JVM standard. Accurate, low overhead, handles both Java and native frames.
3. **Go pprof**: Built into Go, zero-configuration. The web UI with flamegraph view is excellent for development.
4. **speedscope**: The best web-based viewer. Import any profile format, best interface for exploring deep call stacks.
5. **Pyroscope**: Continuous profiling with time-series history. Essential for correlating performance issues with production events.
6. **eBPF/parca**: System-wide profiling without code changes. Profile container workloads from outside the container.
7. **Differential flamegraphs**: Compare before/after profiles to quantify optimization impact.

The shift toward continuous profiling represents the future of performance engineering: instead of manually capturing profiles during incidents, always-on profiling means you have historical data to understand exactly what changed and when.
