---
title: "Go Profiling in Production: pprof, Continuous Profiling, and Pyroscope"
date: 2028-12-11T00:00:00-05:00
draft: false
tags: ["Go", "Profiling", "pprof", "Pyroscope", "Performance", "Observability"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive enterprise guide to Go profiling using pprof and Pyroscope for continuous profiling in production, covering CPU, memory, goroutine, and mutex profiles with real-world performance optimization workflows."
more_link: "yes"
url: "/go-profiling-production-pprof-pyroscope-enterprise-guide/"
---

Performance regression investigations in Go services frequently stall because teams lack the tooling to observe CPU and memory behavior under production load. Synthetic benchmarks miss the access patterns, cardinality, and concurrency of real workloads. The Go runtime's built-in profiling infrastructure — the `pprof` package — provides the foundation for deep performance analysis, but using it effectively in production requires architectural decisions about exposure, overhead, and integration with continuous profiling backends like Pyroscope.

This guide covers the complete Go profiling toolkit: enabling `pprof` endpoints safely, capturing and analyzing CPU, memory, goroutine, and mutex profiles, automating continuous profiling with Pyroscope, and building workflows that turn profile data into actionable optimizations.

<!--more-->

## The Go Profiling Architecture

The Go runtime collects profiling data through sampling and instrumentation hooks. Understanding the data model prevents misinterpretation of profile output:

**CPU profiling**: The runtime uses OS signals (`SIGPROF`) to interrupt goroutines at configurable intervals (default: 100Hz). At each interrupt, the current stack trace is recorded. Cumulative stack trace counts produce a statistical approximation of where CPU time is being spent. The overhead is roughly 5-7% at 100Hz.

**Memory (heap) profiling**: A sampling allocator records allocation sites for a configurable fraction of allocated bytes (default: 1 in every 512KB, controlled by `runtime.MemProfileRate`). The profile captures both live objects (in-use allocations) and cumulative allocations (alloc_objects, alloc_space).

**Goroutine profiling**: A full snapshot of all goroutine stacks at the moment of collection. This is not sampled — it captures everything. In services with thousands of goroutines this can be expensive.

**Mutex profiling**: Records goroutines waiting on mutex contention. Disabled by default; must be enabled via `runtime.SetMutexProfileFraction`.

**Block profiling**: Records goroutines blocked on synchronization primitives. Also disabled by default; enabled via `runtime.SetBlockProfileRate`.

## Enabling pprof in Production Services

### HTTP Endpoint Registration

The `net/http/pprof` package registers handlers on the default `http.ServeMux`. Production services should register these on a separate port from the main service port:

```go
package main

import (
	"context"
	"log"
	"net/http"
	_ "net/http/pprof" // Side-effect import registers handlers
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"
)

func main() {
	// Enable mutex profiling: sample 1 in every 5 mutex contention events
	runtime.SetMutexProfileFraction(5)

	// Enable block profiling: record events blocked > 1ms
	runtime.SetBlockProfileRate(int(time.Millisecond))

	// Start the pprof server on a non-public port
	// In Kubernetes, this port is never exposed via Service/Ingress
	pprofServer := &http.Server{
		Addr:         ":6060",
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second, // Profiles can take time to generate
	}

	go func() {
		log.Printf("pprof server starting on :6060")
		if err := pprofServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("pprof server error: %v", err)
		}
	}()

	// Main application server
	mainServer := &http.Server{
		Addr:         ":8080",
		Handler:      buildHandler(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	// Graceful shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		if err := mainServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("main server error: %v", err)
		}
	}()

	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	mainServer.Shutdown(ctx)
	pprofServer.Shutdown(ctx)
}
```

The available `pprof` endpoints registered by this import:

| Endpoint | Profile Type | Notes |
|----------|-------------|-------|
| `/debug/pprof/profile?seconds=30` | CPU | Blocks for `seconds` duration |
| `/debug/pprof/heap` | Memory heap | Instantaneous snapshot |
| `/debug/pprof/goroutine` | All goroutines | Can be expensive at high count |
| `/debug/pprof/mutex` | Mutex contention | Requires `SetMutexProfileFraction` |
| `/debug/pprof/block` | Channel/sync blocks | Requires `SetBlockProfileRate` |
| `/debug/pprof/trace?seconds=5` | Execution trace | Most detailed, highest overhead |
| `/debug/pprof/allocs` | Allocation profile | Shows allocation call sites |
| `/debug/pprof/threadcreate` | OS thread creation | Rarely needed |

### Securing the pprof Endpoint

The pprof endpoint exposes internal service state. In Kubernetes, protect it through network policies rather than application-level authentication:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-pprof-from-monitoring
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payments-api
  ingress:
  - ports:
    - port: 6060
      protocol: TCP
    from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
    - podSelector:
        matchLabels:
          app: pyroscope
```

## Capturing Profiles with the go tool pprof CLI

### CPU Profile Analysis

```bash
# Capture a 30-second CPU profile from a running pod
kubectl exec -n payments deploy/payments-api -- \
  curl -s http://localhost:6060/debug/pprof/profile?seconds=30 \
  -o /tmp/cpu.pprof

# Copy to local machine
kubectl cp payments/payments-api-7f9d8b5c4-xk9j2:/tmp/cpu.pprof ./cpu.pprof

# Open the interactive pprof UI
go tool pprof -http=:8090 ./cpu.pprof
```

Alternatively, capture directly to the local machine using port-forwarding:

```bash
# Port-forward the pprof port
kubectl port-forward -n payments deploy/payments-api 6060:6060 &

# Capture and open directly (blocks during capture)
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
```

### Reading CPU Profile Output

Within the `go tool pprof` interactive shell:

```
# Show the top 20 functions by flat time
(pprof) top20

# Show functions with more than 5% of CPU time
(pprof) top -cum

# Generate a flame graph (requires -http mode)
(pprof) web

# Show the annotated source for a specific function
(pprof) list encoding/json.Marshal

# Show the call tree for a function
(pprof) peek runtime.mallocgc
```

Key terminology:
- **flat**: Time spent in the function itself, excluding called functions
- **flat%**: Flat time as a percentage of total sampling time
- **sum%**: Cumulative percentage of flat time up to this row
- **cum**: Cumulative time including all called functions
- **cum%**: Cumulative time as a percentage

A function with high `cum%` but low `flat%` is a call site — it is not expensive itself, but it calls expensive things. Focus on functions with high `flat%` for direct optimization targets.

### Memory Profile Analysis

```go
// In the application: tune heap profiling rate for production
// Lower value = more samples = higher overhead
// Default is 512*1024 (one sample per 512KB allocated)
// For production profiling, increase to reduce overhead:
runtime.MemProfileRate = 1 * 1024 * 1024 // Sample 1 per 1MB allocated
```

```bash
# Capture heap profile
curl -s http://localhost:6060/debug/pprof/heap > heap.pprof

# View in-use allocations (objects currently on the heap)
go tool pprof -alloc_objects heap.pprof
(pprof) top20

# View total allocations (cumulative, including GC'd objects)
go tool pprof -alloc_space heap.pprof
(pprof) top20

# Compare two heap profiles to find allocations added between captures
go tool pprof -base heap_before.pprof heap_after.pprof
```

The `-alloc_space` view is most useful for finding allocation hotspots that contribute to GC pressure, even if the objects are not long-lived.

### Goroutine Leak Detection

```bash
# Capture goroutine profile
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=2" > goroutines.txt

# Count total goroutines
grep -c "^goroutine" goroutines.txt

# Find the most common goroutine states
grep "^goroutine" goroutines.txt | awk '{print $4}' | sort | uniq -c | sort -rn
```

A common goroutine leak pattern involves HTTP clients without timeouts:

```go
// BAD: No timeout on HTTP client — goroutines block indefinitely
client := &http.Client{}
resp, err := client.Get("http://slow-service/api")

// GOOD: Always set timeouts
client := &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
	},
}
```

## Continuous Profiling with Pyroscope

Point-in-time profiling misses transient performance issues. Continuous profiling collects profiles continuously and stores them in a time-series database, enabling correlation between performance degradation and deployment events.

### Deploying Pyroscope on Kubernetes

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: pyroscope
---
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: pyroscope
  namespace: pyroscope
spec:
  repo: https://grafana.github.io/helm-charts
  chart: pyroscope
  version: 1.7.0
  targetNamespace: pyroscope
  valuesContent: |-
    pyroscope:
      replicationFactor: 1
      components:
        querier:
          replicas: 2
        ingester:
          replicas: 3
        distributor:
          replicas: 2
      storage:
        backend: s3
        s3:
          bucket_name: pyroscope-profiles-prod
          region: us-east-1
          access_key_id: ""       # Use IAM role via IRSA
          secret_access_key: ""
    persistence:
      enabled: true
      size: 50Gi
      storageClassName: gp3
```

### Push-Based Profiling with the Pyroscope Go SDK

The Pyroscope SDK runs in the same process as the application and continuously pushes profiles to the Pyroscope server:

```go
package main

import (
	"log"
	"os"

	"github.com/grafana/pyroscope-go"
)

func initPyroscope() (*pyroscope.Profiler, error) {
	hostname, _ := os.Hostname()
	podName := os.Getenv("POD_NAME")
	namespace := os.Getenv("POD_NAMESPACE")
	version := os.Getenv("APP_VERSION")

	return pyroscope.Start(pyroscope.Config{
		ApplicationName: "payments-api",

		// Pyroscope server URL — use internal cluster DNS
		ServerAddress: "http://pyroscope.pyroscope.svc.cluster.local:4040",

		// Tags become dimensions for filtering and aggregation
		Tags: map[string]string{
			"hostname":  hostname,
			"pod":       podName,
			"namespace": namespace,
			"version":   version,
			"env":       os.Getenv("ENVIRONMENT"),
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

		// How often to collect and upload profiles (default: 10s)
		UploadRate: 15 * time.Second,

		// Logger for debugging SDK issues
		Logger: pyroscope.StandardLogger,
	})
}

func main() {
	profiler, err := initPyroscope()
	if err != nil {
		log.Fatalf("failed to initialize Pyroscope: %v", err)
	}
	defer profiler.Stop()

	// ... rest of application startup
}
```

### Annotating Code with Pyroscope Labels

Pyroscope labels allow attributing CPU and memory usage to specific request types, customers, or operations within a single process:

```go
package handlers

import (
	"net/http"

	"github.com/grafana/pyroscope-go"
)

func (h *PaymentsHandler) ProcessPayment(w http.ResponseWriter, r *http.Request) {
	// Annotate this execution path with labels that appear in Pyroscope
	pyroscope.TagWrapper(r.Context(), pyroscope.Labels(
		"handler", "process_payment",
		"payment_method", r.Header.Get("X-Payment-Method"),
		"currency", r.Header.Get("X-Currency"),
	), func(ctx context.Context) {
		h.processPaymentInternal(ctx, w, r)
	})
}

func (h *PaymentsHandler) processPaymentInternal(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	// This function's CPU usage will be attributed to the labels set above
	// In Pyroscope, you can filter flame graphs by handler=process_payment
	// to isolate cost from this specific code path

	result, err := h.paymentProcessor.Process(ctx, extractPaymentRequest(r))
	if err != nil {
		h.handleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
```

### Kubernetes Deployment with Downward API

Pass Kubernetes metadata to the Pyroscope tags without hardcoding:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments
spec:
  template:
    spec:
      containers:
      - name: payments-api
        image: registry.example.com/payments-api:v2.14.0
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: APP_VERSION
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['app.kubernetes.io/version']
        - name: ENVIRONMENT
          value: "production"
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 6060
          name: pprof
        - containerPort: 9090
          name: metrics
```

## Analyzing Profile Data: A Practical Workflow

### Identifying a Memory Leak

```bash
# Step 1: Establish baseline heap profile
curl -s http://localhost:6060/debug/pprof/heap > heap_baseline.pprof

# Step 2: Wait for suspected leak window (e.g., 1 hour of production traffic)
sleep 3600

# Step 3: Capture comparison profile
curl -s http://localhost:6060/debug/pprof/heap > heap_after.pprof

# Step 4: Compare using pprof diff
go tool pprof -http=:8090 -base heap_baseline.pprof heap_after.pprof
```

In the comparison view, functions shown with positive values in `inuse_space` have growing allocations — these are candidates for the leak source.

### Execution Trace for Latency Analysis

CPU profiles show where time is spent but not the sequence of events. The execution trace provides a timeline view useful for diagnosing latency spikes:

```bash
# Capture a 5-second execution trace
curl -s "http://localhost:6060/debug/pprof/trace?seconds=5" > trace.out

# Open the trace viewer
go tool trace trace.out
```

The trace viewer shows:
- Goroutine lifecycle (creation, blocking, unblocking)
- GC events and their duration
- Heap allocations over time
- System call durations
- Goroutine scheduling latency

### Mutex Contention Investigation

```go
// In a service with high goroutine counts, investigate mutex contention:
package cache

import (
	"sync"
)

// BAD: A single global mutex serializes all cache operations
type GlobalCache struct {
	mu   sync.Mutex
	data map[string][]byte
}

// GOOD: Sharded cache reduces lock contention
type ShardedCache struct {
	shards [256]struct {
		mu   sync.RWMutex
		data map[string][]byte
	}
}

func (c *ShardedCache) shard(key string) int {
	h := fnv32a(key)
	return int(h) % len(c.shards)
}

func (c *ShardedCache) Get(key string) ([]byte, bool) {
	s := &c.shards[c.shard(key)]
	s.mu.RLock()
	defer s.mu.RUnlock()
	val, ok := s.data[key]
	return val, ok
}

func (c *ShardedCache) Set(key string, val []byte) {
	s := &c.shards[c.shard(key)]
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data == nil {
		s.data = make(map[string][]byte)
	}
	s.data[key] = val
}
```

A mutex profile revealing high contention on a single lock is a strong signal for this pattern.

## Automating Profile Collection During Incidents

### Profile Collection Sidecar Script

```bash
#!/usr/bin/env bash
# collect-profiles.sh — Triggered during incident response
# Usage: ./collect-profiles.sh <namespace> <deployment> <duration_seconds>

set -euo pipefail

NAMESPACE="${1:?namespace required}"
DEPLOYMENT="${2:?deployment required}"
DURATION="${3:-30}"
OUTPUT_DIR="./profiles/$(date +%Y%m%d-%H%M%S)"

mkdir -p "$OUTPUT_DIR"

# Get a pod name
POD=$(kubectl get pods -n "$NAMESPACE" \
  -l "app=$DEPLOYMENT" \
  -o jsonpath='{.items[0].metadata.name}')

echo "Collecting profiles from pod: $POD"

# Port-forward to the pprof port
kubectl port-forward -n "$NAMESPACE" "$POD" 6060:6060 &
PF_PID=$!
trap "kill $PF_PID 2>/dev/null" EXIT

sleep 2  # Wait for port-forward to establish

# Collect all profile types concurrently
echo "Starting CPU profile ($DURATION seconds)..."
curl -s "http://localhost:6060/debug/pprof/profile?seconds=$DURATION" \
  -o "$OUTPUT_DIR/cpu.pprof" &

# Collect instantaneous profiles while CPU profile is running
curl -s "http://localhost:6060/debug/pprof/heap" \
  -o "$OUTPUT_DIR/heap_start.pprof"
curl -s "http://localhost:6060/debug/pprof/goroutine?debug=2" \
  -o "$OUTPUT_DIR/goroutines.txt"
curl -s "http://localhost:6060/debug/pprof/mutex" \
  -o "$OUTPUT_DIR/mutex.pprof"
curl -s "http://localhost:6060/debug/pprof/block" \
  -o "$OUTPUT_DIR/block.pprof"
curl -s "http://localhost:6060/debug/pprof/allocs" \
  -o "$OUTPUT_DIR/allocs.pprof"

# Also capture a short execution trace
curl -s "http://localhost:6060/debug/pprof/trace?seconds=5" \
  -o "$OUTPUT_DIR/trace.out" &

wait  # Wait for all background captures

# Capture heap again after CPU profile to detect short-lived allocations
curl -s "http://localhost:6060/debug/pprof/heap" \
  -o "$OUTPUT_DIR/heap_end.pprof"

echo "Profiles collected in $OUTPUT_DIR"
ls -la "$OUTPUT_DIR"

# Generate summary reports
go tool pprof -top -nodecount=20 "$OUTPUT_DIR/cpu.pprof" > "$OUTPUT_DIR/cpu_top.txt"
go tool pprof -top -inuse_space "$OUTPUT_DIR/heap_end.pprof" > "$OUTPUT_DIR/heap_top.txt"
go tool pprof -top -cum "$OUTPUT_DIR/allocs.pprof" > "$OUTPUT_DIR/allocs_top.txt"

echo "Summary reports generated"
```

## Performance Optimization Patterns from Profile Analysis

### Reducing JSON Marshaling Cost

A common CPU hotspot in Go services is `encoding/json`. Profile analysis frequently shows `json.Marshal` consuming 15-30% of CPU in API-heavy services:

```go
package response

import (
	"bytes"
	"sync"

	jsoniter "github.com/json-iterator/go"
)

// Use json-iterator as a drop-in replacement — 3-5x faster than encoding/json
var json = jsoniter.ConfigCompatibleWithStandardLibrary

// Pool of buffers to reduce allocations
var bufPool = sync.Pool{
	New: func() interface{} {
		return new(bytes.Buffer)
	},
}

func Marshal(v interface{}) ([]byte, error) {
	buf := bufPool.Get().(*bytes.Buffer)
	buf.Reset()
	defer bufPool.Put(buf)

	if err := json.NewEncoder(buf).Encode(v); err != nil {
		return nil, err
	}
	// Return a copy since the buffer goes back to the pool
	result := make([]byte, buf.Len())
	copy(result, buf.Bytes())
	return result, nil
}
```

### Reducing Allocation Pressure

Allocation analysis frequently reveals patterns like repeatedly creating small temporary objects. The `sync.Pool` pattern addresses this:

```go
package processor

import "sync"

type ProcessingContext struct {
	Buffer    []byte
	Headers   map[string]string
	RequestID string
}

var ctxPool = sync.Pool{
	New: func() interface{} {
		return &ProcessingContext{
			Buffer:  make([]byte, 0, 4096),
			Headers: make(map[string]string, 16),
		}
	},
}

func getContext() *ProcessingContext {
	ctx := ctxPool.Get().(*ProcessingContext)
	ctx.Buffer = ctx.Buffer[:0]
	// Clear headers map without reallocating
	for k := range ctx.Headers {
		delete(ctx.Headers, k)
	}
	return ctx
}

func putContext(ctx *ProcessingContext) {
	ctxPool.Put(ctx)
}
```

## Integrating Pyroscope with Grafana

Pyroscope integrates natively with Grafana as a data source, enabling correlation of profiles with metrics and logs:

```yaml
# Grafana data source configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-pyroscope-datasource
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  pyroscope-datasource.yaml: |
    apiVersion: 1
    datasources:
    - name: Pyroscope
      type: grafana-pyroscope-datasource
      url: http://pyroscope.pyroscope.svc.cluster.local:4040
      access: proxy
      isDefault: false
      jsonData:
        # Correlate profiles with traces using exemplars
        tracesToLogsV2:
          datasourceUid: tempo
          spanStartTimeShift: "-1h"
          spanEndTimeShift: "1h"
```

With this integration, Grafana panels can display flame graphs alongside metrics charts, allowing direct correlation between a latency spike in Prometheus and the function responsible for it in Pyroscope.

## Conclusion

Effective Go performance engineering in production requires both reactive (pprof on-demand) and proactive (continuous profiling with Pyroscope) tooling. The key practices:

1. **Always expose pprof** on a separate internal port with appropriate network policies
2. **Enable mutex and block profiling** in production with appropriate sampling rates
3. **Use continuous profiling** to catch regressions that only manifest under production load
4. **Annotate with labels** to attribute cost within a service to specific request paths
5. **Automate profile collection** as part of incident response runbooks
6. **Correlate profiles with traces** using Grafana's integrated flamegraph panels

The investment in this tooling pays back immediately during the first production performance incident where a 30-second pprof capture reveals the exact function responsible for a CPU spike that synthetic benchmarks completely missed.
