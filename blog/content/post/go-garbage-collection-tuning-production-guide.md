---
title: "Go Garbage Collection Tuning: Production Performance Optimization Guide"
date: 2026-07-19T00:00:00-05:00
draft: false
tags: ["Golang", "Garbage Collection", "Performance", "Memory Management", "Kubernetes", "Optimization"]
categories: ["Performance Optimization", "Go", "Production Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go garbage collection tuning for production environments, including GC algorithms, memory management, GOGC optimization, and performance profiling for enterprise Go applications."
more_link: "yes"
url: "/go-garbage-collection-tuning-production-guide/"
---

Master Go garbage collection tuning for production applications. Learn GC algorithms, memory management strategies, GOGC parameter optimization, memory profiling techniques, and enterprise-grade performance tuning for high-throughput Go services.

<!--more-->

# Go Garbage Collection Tuning: Production Performance Optimization Guide

## Executive Summary

Go's garbage collector has evolved significantly, offering excellent performance for most applications out of the box. However, understanding GC internals and tuning parameters can dramatically improve performance for memory-intensive workloads, reduce latency spikes, and optimize resource utilization in containerized environments. This comprehensive guide covers Go GC algorithms, memory management, production tuning techniques, and monitoring strategies for enterprise applications running in Kubernetes.

## Understanding Go's Garbage Collector

### GC Evolution and Current State

#### Go GC Timeline
```go
/*
Go GC Evolution:

Go 1.0-1.4: Stop-the-world mark-and-sweep
- Pause times: 100ms - 1000ms+
- Predictable but slow

Go 1.5: Concurrent mark-and-sweep
- Pause times: <10ms
- Major improvement

Go 1.6-1.7: Optimized concurrent GC
- Pause times: <5ms
- Better scheduling

Go 1.8-1.12: Incremental improvements
- Pause times: <1ms
- Better heap growth

Go 1.13-1.14: Scavenger improvements
- Better memory return to OS
- Reduced RSS growth

Go 1.15-1.16: MADV_DONTNEED optimization
- Faster memory return
- Better container behavior

Go 1.17-1.18: Runtime improvements
- Further pause time reduction
- Better stack scanning

Go 1.19-1.21: Soft memory limit (GOMEMLIMIT)
- Fine-grained memory control
- Better OOMKill prevention
*/
```

### The Tri-Color Mark-and-Sweep Algorithm

#### Understanding the GC Phases
```go
// gc_phases.go
package main

import (
    "fmt"
    "runtime"
    "runtime/debug"
    "time"
)

// GCPhaseMonitor monitors GC phases and performance
type GCPhaseMonitor struct {
    lastGCTime    time.Time
    lastNumGC     uint32
    lastPauseNs   uint64
    lastHeapAlloc uint64
}

// NewGCPhaseMonitor creates a new GC phase monitor
func NewGCPhaseMonitor() *GCPhaseMonitor {
    return &GCPhaseMonitor{
        lastGCTime: time.Now(),
    }
}

// Monitor continuously monitors GC behavior
func (m *GCPhaseMonitor) Monitor(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for range ticker.C {
        m.reportGCStats()
    }
}

// reportGCStats reports current GC statistics
func (m *GCPhaseMonitor) reportGCStats() {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)

    // Calculate GC frequency
    gcFrequency := float64(ms.NumGC-m.lastNumGC) / time.Since(m.lastGCTime).Seconds()

    // Calculate pause time
    pauseTime := time.Duration(ms.PauseTotalNs - m.lastPauseNs)
    avgPause := time.Duration(0)
    if ms.NumGC > m.lastNumGC {
        avgPause = pauseTime / time.Duration(ms.NumGC-m.lastNumGC)
    }

    // Calculate heap growth
    heapGrowth := int64(ms.HeapAlloc) - int64(m.lastHeapAlloc)

    fmt.Printf("=== GC Statistics ===\n")
    fmt.Printf("GC Cycles: %d (%.2f GC/sec)\n", ms.NumGC, gcFrequency)
    fmt.Printf("Heap Alloc: %d MB\n", ms.HeapAlloc/1024/1024)
    fmt.Printf("Heap Sys: %d MB\n", ms.HeapSys/1024/1024)
    fmt.Printf("Heap Idle: %d MB\n", ms.HeapIdle/1024/1024)
    fmt.Printf("Heap In Use: %d MB\n", ms.HeapInuse/1024/1024)
    fmt.Printf("Heap Released: %d MB\n", ms.HeapReleased/1024/1024)
    fmt.Printf("Heap Objects: %d\n", ms.HeapObjects)
    fmt.Printf("Total Alloc: %d MB\n", ms.TotalAlloc/1024/1024)
    fmt.Printf("Sys: %d MB\n", ms.Sys/1024/1024)
    fmt.Printf("GC CPU Fraction: %.4f%%\n", ms.GCCPUFraction*100)
    fmt.Printf("Avg Pause: %v\n", avgPause)
    fmt.Printf("Heap Growth: %+d MB\n", heapGrowth/1024/1024)
    fmt.Printf("Next GC: %d MB\n", ms.NextGC/1024/1024)
    fmt.Printf("GOGC: %d%%\n", debug.SetGCPercent(-1))
    fmt.Println()

    // Update last values
    m.lastNumGC = ms.NumGC
    m.lastPauseNs = ms.PauseTotalNs
    m.lastHeapAlloc = ms.HeapAlloc
    m.lastGCTime = time.Now()
}

// GetDetailedMemStats returns detailed memory statistics
func GetDetailedMemStats() map[string]interface{} {
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)

    return map[string]interface{}{
        "alloc_mb":             ms.Alloc / 1024 / 1024,
        "total_alloc_mb":       ms.TotalAlloc / 1024 / 1024,
        "sys_mb":               ms.Sys / 1024 / 1024,
        "num_gc":               ms.NumGC,
        "gc_cpu_fraction":      ms.GCCPUFraction,
        "heap_alloc_mb":        ms.HeapAlloc / 1024 / 1024,
        "heap_sys_mb":          ms.HeapSys / 1024 / 1024,
        "heap_idle_mb":         ms.HeapIdle / 1024 / 1024,
        "heap_inuse_mb":        ms.HeapInuse / 1024 / 1024,
        "heap_released_mb":     ms.HeapReleased / 1024 / 1024,
        "heap_objects":         ms.HeapObjects,
        "stack_inuse_mb":       ms.StackInuse / 1024 / 1024,
        "stack_sys_mb":         ms.StackSys / 1024 / 1024,
        "mspan_inuse_mb":       ms.MSpanInuse / 1024 / 1024,
        "mspan_sys_mb":         ms.MSpanSys / 1024 / 1024,
        "mcache_inuse_mb":      ms.MCacheInuse / 1024 / 1024,
        "mcache_sys_mb":        ms.MCacheSys / 1024 / 1024,
        "buck_hash_sys_mb":     ms.BuckHashSys / 1024 / 1024,
        "gc_sys_mb":            ms.GCSys / 1024 / 1024,
        "other_sys_mb":         ms.OtherSys / 1024 / 1024,
        "next_gc_mb":           ms.NextGC / 1024 / 1024,
        "last_gc_time":         time.Unix(0, int64(ms.LastGC)),
        "num_forced_gc":        ms.NumForcedGC,
        "pause_total_ns":       ms.PauseTotalNs,
        "pause_end":            ms.PauseEnd,
        "pause_ns":             ms.PauseNs,
    }
}

func main() {
    monitor := NewGCPhaseMonitor()

    // Start monitoring
    go monitor.Monitor(10 * time.Second)

    // Simulate workload
    for {
        // Allocate memory to trigger GC
        _ = make([]byte, 10*1024*1024) // 10MB
        time.Sleep(100 * time.Millisecond)
    }
}
```

## GOGC Parameter Tuning

### Understanding GOGC

#### GOGC Behavior Examples
```go
// gogc_tuning.go
package main

import (
    "fmt"
    "runtime"
    "runtime/debug"
)

/*
GOGC controls the trade-off between CPU and memory:

GOGC = 100 (default):
- GC triggers when heap grows 100% (doubles)
- Balanced CPU/memory usage
- Example: 10MB heap -> GC at 20MB

GOGC = 50:
- GC triggers when heap grows 50%
- More frequent GC, lower memory usage
- Higher CPU usage for GC
- Example: 10MB heap -> GC at 15MB

GOGC = 200:
- GC triggers when heap grows 200%
- Less frequent GC, higher memory usage
- Lower CPU usage for GC
- Example: 10MB heap -> GC at 30MB

GOGC = off (using GOMEMLIMIT):
- GC uses soft memory limit instead
- Better for containerized workloads
*/

// GCTuner provides GC tuning utilities
type GCTuner struct {
    defaultGOGC int
}

// NewGCTuner creates a new GC tuner
func NewGCTuner() *GCTuner {
    return &GCTuner{
        defaultGOGC: debug.SetGCPercent(-1), // Get current
    }
}

// SetGOGC sets the GOGC parameter
func (t *GCTuner) SetGOGC(percent int) int {
    old := debug.SetGCPercent(percent)
    fmt.Printf("GOGC changed from %d%% to %d%%\n", old, percent)
    return old
}

// SetMemoryLimit sets the soft memory limit (Go 1.19+)
func (t *GCTuner) SetMemoryLimit(limitMB int64) {
    limitBytes := limitMB * 1024 * 1024
    oldLimit := debug.SetMemoryLimit(limitBytes)

    fmt.Printf("Memory limit changed from %d MB to %d MB\n",
        oldLimit/1024/1024, limitBytes/1024/1024)
}

// DisableGC disables garbage collection
func (t *GCTuner) DisableGC() {
    debug.SetGCPercent(-1)
    fmt.Println("GC disabled")
}

// EnableGC enables garbage collection with specified GOGC
func (t *GCTuner) EnableGC(percent int) {
    debug.SetGCPercent(percent)
    fmt.Printf("GC enabled with GOGC=%d%%\n", percent)
}

// OptimizeForThroughput configures GC for maximum throughput
func (t *GCTuner) OptimizeForThroughput() {
    // Higher GOGC = less frequent GC = better throughput
    t.SetGOGC(200)
    fmt.Println("Optimized for throughput (GOGC=200%)")
}

// OptimizeForLatency configures GC for minimum latency
func (t *GCTuner) OptimizeForLatency() {
    // Lower GOGC = more frequent GC = lower latency spikes
    t.SetGOGC(50)
    fmt.Println("Optimized for latency (GOGC=50%)")
}

// OptimizeForMemory configures GC for minimum memory usage
func (t *GCTuner) OptimizeForMemory() {
    // Very low GOGC = very frequent GC = minimal memory
    t.SetGOGC(25)
    fmt.Println("Optimized for memory (GOGC=25%)")
}

// AutoTune automatically tunes GC based on memory pressure
func (t *GCTuner) AutoTune(targetMemoryMB int64, currentMemoryMB int64) {
    usagePercent := float64(currentMemoryMB) / float64(targetMemoryMB) * 100

    switch {
    case usagePercent > 90:
        // High memory pressure - aggressive GC
        t.SetGOGC(25)
        fmt.Println("High memory pressure - setting GOGC=25%")

    case usagePercent > 75:
        // Moderate memory pressure
        t.SetGOGC(50)
        fmt.Println("Moderate memory pressure - setting GOGC=50%")

    case usagePercent > 50:
        // Normal operation
        t.SetGOGC(100)
        fmt.Println("Normal memory usage - setting GOGC=100%")

    default:
        // Low memory pressure - optimize for throughput
        t.SetGOGC(200)
        fmt.Println("Low memory pressure - setting GOGC=200%")
    }
}

// BenchmarkGOGC benchmarks different GOGC values
func BenchmarkGOGC(gogcValues []int, allocSizeMB int, iterations int) {
    for _, gogc := range gogcValues {
        debug.SetGCPercent(gogc)
        runtime.GC() // Start clean

        var before, after runtime.MemStats
        runtime.ReadMemStats(&before)

        startTime := time.Now()

        // Allocate and discard memory
        for i := 0; i < iterations; i++ {
            _ = make([]byte, allocSizeMB*1024*1024)
        }

        duration := time.Since(startTime)
        runtime.ReadMemStats(&after)

        fmt.Printf("GOGC=%d%%: Duration=%v, GC Cycles=%d, Avg Pause=%v\n",
            gogc,
            duration,
            after.NumGC-before.NumGC,
            time.Duration((after.PauseTotalNs-before.PauseTotalNs)/uint64(after.NumGC-before.NumGC)),
        )
    }
}

func main() {
    tuner := NewGCTuner()

    // Example: Optimize for different scenarios
    fmt.Println("=== GC Tuning Examples ===\n")

    // Throughput-optimized
    tuner.OptimizeForThroughput()
    runtime.GC()

    // Latency-optimized
    tuner.OptimizeForLatency()
    runtime.GC()

    // Memory-optimized
    tuner.OptimizeForMemory()
    runtime.GC()

    // Benchmark different GOGC values
    fmt.Println("\n=== GOGC Benchmarks ===\n")
    BenchmarkGOGC([]int{25, 50, 100, 200, 400}, 10, 1000)
}
```

### GOMEMLIMIT Configuration

#### Memory Limit Setup (Go 1.19+)
```go
// gomemlimit_config.go
package main

import (
    "fmt"
    "os"
    "runtime/debug"
    "strconv"
)

// MemoryLimitConfig configures memory limits
type MemoryLimitConfig struct {
    containerMemoryMB int64
    limitPercent      float64
}

// NewMemoryLimitConfig creates a new memory limit configuration
func NewMemoryLimitConfig(containerMemoryMB int64, limitPercent float64) *MemoryLimitConfig {
    return &MemoryLimitConfig{
        containerMemoryMB: containerMemoryMB,
        limitPercent:      limitPercent,
    }
}

// Apply applies the memory limit configuration
func (c *MemoryLimitConfig) Apply() {
    // Calculate limit (typically 80-90% of container memory)
    limitMB := int64(float64(c.containerMemoryMB) * c.limitPercent)
    limitBytes := limitMB * 1024 * 1024

    // Set memory limit
    debug.SetMemoryLimit(limitBytes)

    fmt.Printf("Memory limit set to %d MB (%.0f%% of %d MB container)\n",
        limitMB, c.limitPercent*100, c.containerMemoryMB)

    // Disable GOGC when using GOMEMLIMIT
    debug.SetGCPercent(-1)
    fmt.Println("GOGC disabled (using GOMEMLIMIT)")
}

// DetectContainerMemory detects container memory limit
func DetectContainerMemory() int64 {
    // Try cgroup v2
    if data, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
        if limit, err := strconv.ParseInt(string(data[:len(data)-1]), 10, 64); err == nil && limit > 0 {
            return limit / 1024 / 1024 // Convert to MB
        }
    }

    // Try cgroup v1
    if data, err := os.ReadFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"); err == nil {
        if limit, err := strconv.ParseInt(string(data[:len(data)-1]), 10, 64); err == nil {
            return limit / 1024 / 1024 // Convert to MB
        }
    }

    // Default if not detected
    return 0
}

// ConfigureForKubernetes configures GC for Kubernetes environment
func ConfigureForKubernetes() {
    // Detect container memory limit
    containerMemory := DetectContainerMemory()

    if containerMemory > 0 {
        fmt.Printf("Detected container memory: %d MB\n", containerMemory)

        // Use 85% of container memory as soft limit
        config := NewMemoryLimitConfig(containerMemory, 0.85)
        config.Apply()
    } else {
        fmt.Println("Could not detect container memory, using GOGC=100")
        debug.SetGCPercent(100)
    }
}

func main() {
    ConfigureForKubernetes()
}
```

## Memory Profiling and Analysis

### Production Memory Profiling

#### Comprehensive Memory Profiler
```go
// memory_profiler.go
package main

import (
    "fmt"
    "net/http"
    _ "net/http/pprof"
    "os"
    "runtime"
    "runtime/pprof"
    "time"
)

// MemoryProfiler provides memory profiling capabilities
type MemoryProfiler struct {
    profileDir      string
    profileInterval time.Duration
    running         bool
}

// NewMemoryProfiler creates a new memory profiler
func NewMemoryProfiler(profileDir string, interval time.Duration) *MemoryProfiler {
    return &MemoryProfiler{
        profileDir:      profileDir,
        profileInterval: interval,
    }
}

// Start starts the memory profiler
func (p *MemoryProfiler) Start() {
    p.running = true

    // Ensure profile directory exists
    os.MkdirAll(p.profileDir, 0755)

    // Start periodic heap profiling
    go p.periodicHeapProfile()

    // Start pprof HTTP server
    go func() {
        fmt.Println("[Profiler] pprof server started on :6060")
        fmt.Println("[Profiler] Heap profile: http://localhost:6060/debug/pprof/heap")
        fmt.Println("[Profiler] Goroutine profile: http://localhost:6060/debug/pprof/goroutine")
        fmt.Println("[Profiler] Allocs profile: http://localhost:6060/debug/pprof/allocs")
        http.ListenAndServe(":6060", nil)
    }()
}

// Stop stops the memory profiler
func (p *MemoryProfiler) Stop() {
    p.running = false
}

// periodicHeapProfile captures heap profiles periodically
func (p *MemoryProfiler) periodicHeapProfile() {
    ticker := time.NewTicker(p.profileInterval)
    defer ticker.Stop()

    for p.running {
        <-ticker.C
        p.captureHeapProfile()
    }
}

// captureHeapProfile captures a heap profile
func (p *MemoryProfiler) captureHeapProfile() {
    filename := fmt.Sprintf("%s/heap_%s.prof",
        p.profileDir,
        time.Now().Format("2006-01-02_15-04-05"))

    f, err := os.Create(filename)
    if err != nil {
        fmt.Printf("[Profiler] Error creating heap profile: %v\n", err)
        return
    }
    defer f.Close()

    runtime.GC() // Get up-to-date statistics

    if err := pprof.WriteHeapProfile(f); err != nil {
        fmt.Printf("[Profiler] Error writing heap profile: %v\n", err)
        return
    }

    fmt.Printf("[Profiler] Heap profile saved: %s\n", filename)
}

// CaptureGoroutineProfile captures a goroutine profile
func (p *MemoryProfiler) CaptureGoroutineProfile() {
    filename := fmt.Sprintf("%s/goroutine_%s.prof",
        p.profileDir,
        time.Now().Format("2006-01-02_15-04-05"))

    f, err := os.Create(filename)
    if err != nil {
        fmt.Printf("[Profiler] Error creating goroutine profile: %v\n", err)
        return
    }
    defer f.Close()

    if prof := pprof.Lookup("goroutine"); prof != nil {
        prof.WriteTo(f, 2)
        fmt.Printf("[Profiler] Goroutine profile saved: %s\n", filename)
    }
}

// CaptureAllocsProfile captures an allocations profile
func (p *MemoryProfiler) CaptureAllocsProfile() {
    filename := fmt.Sprintf("%s/allocs_%s.prof",
        p.profileDir,
        time.Now().Format("2006-01-02_15-04-05"))

    f, err := os.Create(filename)
    if err != nil {
        fmt.Printf("[Profiler] Error creating allocs profile: %v\n", err)
        return
    }
    defer f.Close()

    if prof := pprof.Lookup("allocs"); prof != nil {
        prof.WriteTo(f, 0)
        fmt.Printf("[Profiler] Allocs profile saved: %s\n", filename)
    }
}

// AnalyzeMemoryLeaks analyzes potential memory leaks
func (p *MemoryProfiler) AnalyzeMemoryLeaks(thresholdMB int64, duration time.Duration) {
    var before, after runtime.MemStats

    runtime.ReadMemStats(&before)
    beforeHeap := before.HeapAlloc / 1024 / 1024

    fmt.Printf("[Profiler] Starting memory leak analysis...\n")
    fmt.Printf("[Profiler] Initial heap: %d MB\n", beforeHeap)

    // Wait for specified duration
    time.Sleep(duration)

    runtime.GC() // Force GC to clean up temporary allocations
    runtime.ReadMemStats(&after)
    afterHeap := after.HeapAlloc / 1024 / 1024

    growth := int64(afterHeap) - int64(beforeHeap)

    fmt.Printf("[Profiler] Final heap: %d MB\n", afterHeap)
    fmt.Printf("[Profiler] Heap growth: %+d MB\n", growth)

    if growth > thresholdMB {
        fmt.Printf("[Profiler] WARNING: Potential memory leak detected! Growth exceeds threshold of %d MB\n", thresholdMB)
        p.captureHeapProfile()
        p.CaptureGoroutineProfile()
    } else {
        fmt.Printf("[Profiler] Memory usage is normal\n")
    }
}

func main() {
    profiler := NewMemoryProfiler("/var/log/profiles", 5*time.Minute)
    profiler.Start()

    // Analyze for memory leaks every 10 minutes
    go func() {
        for {
            time.Sleep(10 * time.Minute)
            profiler.AnalyzeMemoryLeaks(100, 1*time.Minute)
        }
    }()

    // Keep running
    select {}
}
```

## Production Kubernetes Configuration

### Complete Go Application Deployment

```yaml
# go-app-deployment.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: go-app-config
  namespace: production
data:
  # GOMEMLIMIT: Use 85% of container memory (3.4GB of 4GB)
  GOMEMLIMIT: "3640655872"  # 3.4GB in bytes

  # Disable GOGC when using GOMEMLIMIT
  GOGC: "off"

  # Enable detailed GC tracing
  GODEBUG: "gctrace=1"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-application
  namespace: production
  labels:
    app: go-application
    version: v1.0.0
spec:
  replicas: 3
  selector:
    matchLabels:
      app: go-application
  template:
    metadata:
      labels:
        app: go-application
        version: v1.0.0
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: application
        image: company/go-application:1.0.0
        envFrom:
        - configMapRef:
            name: go-app-config
        ports:
        - containerPort: 8080
          name: http
          protocol: TCP
        - containerPort: 9090
          name: metrics
          protocol: TCP
        - containerPort: 6060
          name: pprof
          protocol: TCP
        resources:
          requests:
            memory: "4Gi"
            cpu: "1000m"
          limits:
            memory: "4Gi"
            cpu: "4000m"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        volumeMounts:
        - name: profiles
          mountPath: /var/log/profiles
      volumes:
      - name: profiles
        emptyDir: {}
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - go-application
              topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: go-application
  namespace: production
spec:
  selector:
    app: go-application
  ports:
  - name: http
    port: 80
    targetPort: 8080
  - name: metrics
    port: 9090
    targetPort: 9090
  - name: pprof
    port: 6060
    targetPort: 6060
  type: ClusterIP
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: go-application-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: go-application
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Pods
        value: 4
        periodSeconds: 30
```

## Conclusion

Go garbage collection tuning is essential for optimizing memory-intensive applications in production. Key takeaways:

1. **Use GOMEMLIMIT**: For Go 1.19+, set memory limit to 85-90% of container memory and disable GOGC
2. **Tune GOGC Appropriately**: Lower values (25-50) for latency-sensitive apps, higher (200-400) for throughput
3. **Monitor Continuously**: Track GC frequency, pause times, and memory usage
4. **Profile Regularly**: Use pprof to identify memory hotspots and leaks
5. **Test Under Load**: Benchmark different configurations with realistic workloads

Proper GC tuning can reduce memory usage by 30-40% and improve application performance significantly, while preventing OOMKills in containerized environments.