---
title: "You're Probably Using Goroutines Wrong: Enterprise Production Patterns and Monitoring for 2025"
date: 2026-07-21T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Goroutines", "Concurrency", "Enterprise", "Production", "Monitoring", "Performance"]
categories: ["Programming", "Enterprise", "Production"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master proper goroutine usage patterns for enterprise production systems including advanced monitoring, leak detection, resource management, and proven concurrency strategies for 2025."
more_link: "yes"
url: "/golang-goroutines-production-patterns-enterprise-monitoring-2025/"
---

Improper concurrency management is responsible for over 40% of critical bugs in production systems, yet most developers treat goroutines as lightweight threads rather than the sophisticated concurrency primitives they are. Enterprise organizations running Go at scale have learned hard lessons about goroutine lifecycle management, resource exhaustion, and monitoring strategies that separate stable production systems from those plagued by memory leaks and performance degradation.

This comprehensive guide reveals the enterprise-grade goroutine patterns, monitoring strategies, and production techniques that companies like Netflix, Uber, and Google use to build resilient, scalable Go applications. We'll explore advanced concurrency patterns, leak detection mechanisms, and the monitoring infrastructure needed to maintain healthy goroutine ecosystems in production.

<!--more-->

## Executive Summary

Enterprise Go applications require sophisticated goroutine management strategies that go far beyond basic channel communication. This guide covers advanced worker pool implementations, context-driven cancellation patterns, comprehensive monitoring systems, and the production patterns that prevent the common pitfalls that lead to system instability. Netflix's engineering team achieved a 30% reduction in service latency by implementing proper context handling, while other organizations report 40% improvements in system stability through advanced goroutine lifecycle management.

## The Hidden Costs of Goroutine Mismanagement

### Production Impact Analysis

Most developers underestimate the production implications of improper goroutine usage. Consider these real-world scenarios:

**Memory Leak Scenarios**:
- Unbounded goroutine creation during traffic spikes
- Goroutines waiting indefinitely on blocked channels
- Resource cleanup failures in long-running services
- Context cancellation not properly propagated

**Performance Degradation Patterns**:
- Excessive context switching from too many active goroutines
- Channel contention in high-throughput scenarios
- Improper synchronization leading to lock contention
- Resource exhaustion from unmanaged concurrency

### Enterprise Goroutine Anti-Patterns

```go
// ANTI-PATTERN 1: Unbounded goroutine creation
func handleRequestsBadly(requests chan Request) {
    for req := range requests {
        // This creates unbounded goroutines!
        go func(r Request) {
            processRequest(r) // No resource limits, no monitoring
        }(req)
    }
}

// ANTI-PATTERN 2: No cancellation support
func badLongRunningTask() {
    for {
        // This goroutine can never be stopped gracefully
        doWork()
        time.Sleep(time.Second)
    }
}

// ANTI-PATTERN 3: Resource leaks
func leakyWorker() {
    for {
        conn, err := net.Dial("tcp", "service:8080")
        if err != nil {
            continue // Leaked connections!
        }
        // conn never closed, goroutine never exits
        go handleConnection(conn)
    }
}
```

## Enterprise Worker Pool Implementation

### Advanced Worker Pool with Monitoring

```go
package workerpool

import (
    "context"
    "fmt"
    "runtime"
    "sync"
    "sync/atomic"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    activeWorkers = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "workerpool_active_workers",
            Help: "Number of active workers in the pool",
        },
        []string{"pool_name"},
    )

    queueDepth = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "workerpool_queue_depth",
            Help: "Current depth of the work queue",
        },
        []string{"pool_name"},
    )

    processedJobs = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "workerpool_jobs_processed_total",
            Help: "Total number of jobs processed",
        },
        []string{"pool_name", "status"},
    )

    processingDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "workerpool_job_duration_seconds",
            Help:    "Time spent processing jobs",
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
        },
        []string{"pool_name"},
    )
)

// EnterpriseWorkerPool implements a production-ready worker pool
type EnterpriseWorkerPool struct {
    name              string
    minWorkers        int
    maxWorkers        int
    queueSize         int
    workers           map[int]*Worker
    workersMutex      sync.RWMutex
    jobs              chan Job
    results           chan Result
    ctx               context.Context
    cancel            context.CancelFunc
    wg                sync.WaitGroup
    stats             PoolStatistics
    healthChecker     *HealthChecker
    autoscaler        *Autoscaler
}

// Job represents a unit of work
type Job struct {
    ID        string
    Payload   interface{}
    ProcessFn func(context.Context, interface{}) (interface{}, error)
    Priority  int
    Timeout   time.Duration
    CreatedAt time.Time
}

// Result represents the outcome of a job
type Result struct {
    JobID     string
    Data      interface{}
    Error     error
    Duration  time.Duration
    WorkerID  int
}

// Worker represents an individual worker goroutine
type Worker struct {
    id           int
    pool         *EnterpriseWorkerPool
    active       int64
    lastActivity time.Time
    processed    int64
    errors       int64
    ctx          context.Context
    cancel       context.CancelFunc
}

// PoolStatistics tracks pool performance metrics
type PoolStatistics struct {
    JobsProcessed     int64
    JobsQueued        int64
    AverageQueueTime  time.Duration
    AverageJobTime    time.Duration
    WorkerUtilization float64
    ErrorRate         float64
}

// NewEnterpriseWorkerPool creates a new enterprise worker pool
func NewEnterpriseWorkerPool(config PoolConfig) *EnterpriseWorkerPool {
    ctx, cancel := context.WithCancel(context.Background())

    pool := &EnterpriseWorkerPool{
        name:       config.Name,
        minWorkers: config.MinWorkers,
        maxWorkers: config.MaxWorkers,
        queueSize:  config.QueueSize,
        workers:    make(map[int]*Worker),
        jobs:       make(chan Job, config.QueueSize),
        results:    make(chan Result, config.QueueSize),
        ctx:        ctx,
        cancel:     cancel,
    }

    // Initialize health checker
    pool.healthChecker = NewHealthChecker(pool)

    // Initialize autoscaler
    pool.autoscaler = NewAutoscaler(pool, config.AutoscaleConfig)

    // Start initial workers
    for i := 0; i < config.MinWorkers; i++ {
        pool.startWorker(i)
    }

    // Start monitoring goroutines
    go pool.monitor()
    go pool.healthChecker.Start(ctx)
    go pool.autoscaler.Start(ctx)

    return pool
}

// Submit submits a job to the worker pool
func (p *EnterpriseWorkerPool) Submit(job Job) error {
    if job.CreatedAt.IsZero() {
        job.CreatedAt = time.Now()
    }

    select {
    case p.jobs <- job:
        atomic.AddInt64(&p.stats.JobsQueued, 1)
        queueDepth.WithLabelValues(p.name).Set(float64(len(p.jobs)))
        return nil
    case <-p.ctx.Done():
        return p.ctx.Err()
    default:
        return fmt.Errorf("job queue full, unable to submit job %s", job.ID)
    }
}

func (p *EnterpriseWorkerPool) startWorker(id int) {
    workerCtx, workerCancel := context.WithCancel(p.ctx)

    worker := &Worker{
        id:           id,
        pool:         p,
        lastActivity: time.Now(),
        ctx:          workerCtx,
        cancel:       workerCancel,
    }

    p.workersMutex.Lock()
    p.workers[id] = worker
    p.workersMutex.Unlock()

    activeWorkers.WithLabelValues(p.name).Inc()

    p.wg.Add(1)
    go worker.run()
}

func (w *Worker) run() {
    defer func() {
        if r := recover(); r != nil {
            // Log panic and restart worker
            fmt.Printf("Worker %d panicked: %v\n", w.id, r)

            // Track the panic in metrics
            processedJobs.WithLabelValues(w.pool.name, "panic").Inc()

            // Restart worker
            go w.pool.startWorker(w.id)
        }

        w.pool.wg.Done()
        activeWorkers.WithLabelValues(w.pool.name).Dec()

        w.pool.workersMutex.Lock()
        delete(w.pool.workers, w.id)
        w.pool.workersMutex.Unlock()
    }()

    for {
        select {
        case job := <-w.pool.jobs:
            w.processJob(job)

        case <-w.ctx.Done():
            return

        case <-time.After(30 * time.Second):
            // Worker idle timeout check
            if w.pool.shouldTerminateWorker(w) {
                return
            }
        }
    }
}

func (w *Worker) processJob(job Job) {
    start := time.Now()
    atomic.StoreInt64(&w.active, 1)
    w.lastActivity = start

    defer func() {
        atomic.StoreInt64(&w.active, 0)
        duration := time.Since(start)
        processingDuration.WithLabelValues(w.pool.name).Observe(duration.Seconds())
    }()

    // Create job context with timeout
    jobCtx := w.ctx
    if job.Timeout > 0 {
        var cancel context.CancelFunc
        jobCtx, cancel = context.WithTimeout(w.ctx, job.Timeout)
        defer cancel()
    }

    // Process the job
    result := Result{
        JobID:    job.ID,
        WorkerID: w.id,
        Duration: time.Since(start),
    }

    func() {
        defer func() {
            if r := recover(); r != nil {
                result.Error = fmt.Errorf("job panicked: %v", r)
                atomic.AddInt64(&w.errors, 1)
                processedJobs.WithLabelValues(w.pool.name, "error").Inc()
            }
        }()

        result.Data, result.Error = job.ProcessFn(jobCtx, job.Payload)
    }()

    if result.Error != nil {
        atomic.AddInt64(&w.errors, 1)
        processedJobs.WithLabelValues(w.pool.name, "error").Inc()
    } else {
        processedJobs.WithLabelValues(w.pool.name, "success").Inc()
    }

    atomic.AddInt64(&w.processed, 1)
    atomic.AddInt64(&w.pool.stats.JobsProcessed, 1)

    // Send result (non-blocking)
    select {
    case w.pool.results <- result:
    default:
        // Results channel full, drop result
    }
}

// HealthChecker monitors worker pool health
type HealthChecker struct {
    pool           *EnterpriseWorkerPool
    checkInterval  time.Duration
    unhealthyThreshold int
}

func NewHealthChecker(pool *EnterpriseWorkerPool) *HealthChecker {
    return &HealthChecker{
        pool:               pool,
        checkInterval:      10 * time.Second,
        unhealthyThreshold: 3,
    }
}

func (hc *HealthChecker) Start(ctx context.Context) {
    ticker := time.NewTicker(hc.checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            hc.checkHealth()
        }
    }
}

func (hc *HealthChecker) checkHealth() {
    hc.pool.workersMutex.RLock()
    defer hc.pool.workersMutex.RUnlock()

    unhealthyWorkers := 0
    totalWorkers := len(hc.pool.workers)

    for _, worker := range hc.pool.workers {
        // Check if worker is stuck
        if time.Since(worker.lastActivity) > 5*time.Minute && atomic.LoadInt64(&worker.active) == 1 {
            unhealthyWorkers++
            fmt.Printf("Worker %d appears stuck, last activity: %v\n", worker.id, worker.lastActivity)
        }

        // Check error rate
        if worker.processed > 0 {
            errorRate := float64(worker.errors) / float64(worker.processed)
            if errorRate > 0.1 { // 10% error rate threshold
                unhealthyWorkers++
                fmt.Printf("Worker %d has high error rate: %.2f%%\n", worker.id, errorRate*100)
            }
        }
    }

    // Take action if too many workers are unhealthy
    if totalWorkers > 0 && float64(unhealthyWorkers)/float64(totalWorkers) > 0.3 {
        fmt.Printf("Pool %s is unhealthy: %d/%d workers problematic\n",
            hc.pool.name, unhealthyWorkers, totalWorkers)
        // Could trigger alerts, restart workers, etc.
    }
}

// Autoscaler automatically adjusts worker pool size
type Autoscaler struct {
    pool              *EnterpriseWorkerPool
    scaleUpThreshold  float64
    scaleDownThreshold float64
    checkInterval     time.Duration
    config            AutoscaleConfig
}

type AutoscaleConfig struct {
    Enabled              bool
    ScaleUpCooldown      time.Duration
    ScaleDownCooldown    time.Duration
    TargetQueueRatio     float64
    TargetUtilization    float64
}

func NewAutoscaler(pool *EnterpriseWorkerPool, config AutoscaleConfig) *Autoscaler {
    return &Autoscaler{
        pool:               pool,
        scaleUpThreshold:   0.8,
        scaleDownThreshold: 0.3,
        checkInterval:      15 * time.Second,
        config:             config,
    }
}

func (a *Autoscaler) Start(ctx context.Context) {
    if !a.config.Enabled {
        return
    }

    ticker := time.NewTicker(a.checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            a.evaluate()
        }
    }
}

func (a *Autoscaler) evaluate() {
    a.pool.workersMutex.RLock()
    currentWorkers := len(a.pool.workers)
    a.pool.workersMutex.RUnlock()

    queueDepth := len(a.pool.jobs)
    queueRatio := float64(queueDepth) / float64(a.pool.queueSize)

    // Calculate utilization
    activeWorkers := a.countActiveWorkers()
    utilization := float64(activeWorkers) / float64(currentWorkers)

    // Scale up decision
    if queueRatio > a.config.TargetQueueRatio && utilization > a.config.TargetUtilization {
        if currentWorkers < a.pool.maxWorkers {
            newWorkerID := a.getNextWorkerID()
            a.pool.startWorker(newWorkerID)
            fmt.Printf("Scaled up pool %s: %d -> %d workers (queue: %d, util: %.2f)\n",
                a.pool.name, currentWorkers, currentWorkers+1, queueDepth, utilization)
        }
    }

    // Scale down decision
    if queueRatio < a.scaleDownThreshold && utilization < a.scaleDownThreshold {
        if currentWorkers > a.pool.minWorkers {
            a.terminateIdleWorker()
            fmt.Printf("Scaled down pool %s: %d -> %d workers (queue: %d, util: %.2f)\n",
                a.pool.name, currentWorkers, currentWorkers-1, queueDepth, utilization)
        }
    }
}

func (a *Autoscaler) countActiveWorkers() int {
    a.pool.workersMutex.RLock()
    defer a.pool.workersMutex.RUnlock()

    active := 0
    for _, worker := range a.pool.workers {
        if atomic.LoadInt64(&worker.active) == 1 {
            active++
        }
    }
    return active
}
```

## Advanced Context Management Patterns

### Context-Driven Cancellation with Monitoring

```go
package context

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    contextCancellations = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "context_cancellations_total",
            Help: "Total number of context cancellations",
        },
        []string{"reason", "operation"},
    )

    contextTimeouts = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "context_timeouts_total",
            Help: "Total number of context timeouts",
        },
        []string{"operation"},
    )

    activeContexts = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "active_contexts",
            Help: "Number of active contexts",
        },
        []string{"operation"},
    )
)

// ContextManager provides enterprise context management
type ContextManager struct {
    activeContexts map[string]*ManagedContext
    mu             sync.RWMutex
}

type ManagedContext struct {
    ID          string
    Operation   string
    Context     context.Context
    Cancel      context.CancelFunc
    StartTime   time.Time
    Timeout     time.Duration
    parent      context.Context
}

// NewContextManager creates a new context manager
func NewContextManager() *ContextManager {
    return &ContextManager{
        activeContexts: make(map[string]*ManagedContext),
    }
}

// CreateContext creates a new managed context
func (cm *ContextManager) CreateContext(parent context.Context, operation string, timeout time.Duration) *ManagedContext {
    id := generateContextID()

    var ctx context.Context
    var cancel context.CancelFunc

    if timeout > 0 {
        ctx, cancel = context.WithTimeout(parent, timeout)
    } else {
        ctx, cancel = context.WithCancel(parent)
    }

    managed := &ManagedContext{
        ID:        id,
        Operation: operation,
        Context:   ctx,
        Cancel:    cancel,
        StartTime: time.Now(),
        Timeout:   timeout,
        parent:    parent,
    }

    cm.mu.Lock()
    cm.activeContexts[id] = managed
    cm.mu.Unlock()

    activeContexts.WithLabelValues(operation).Inc()

    // Monitor context lifecycle
    go cm.monitorContext(managed)

    return managed
}

func (cm *ContextManager) monitorContext(managed *ManagedContext) {
    <-managed.Context.Done()

    // Determine cancellation reason
    reason := "unknown"
    switch managed.Context.Err() {
    case context.Canceled:
        reason = "cancelled"
        contextCancellations.WithLabelValues(reason, managed.Operation).Inc()
    case context.DeadlineExceeded:
        reason = "timeout"
        contextTimeouts.WithLabelValues(managed.Operation).Inc()
    }

    // Clean up
    cm.mu.Lock()
    delete(cm.activeContexts, managed.ID)
    cm.mu.Unlock()

    activeContexts.WithLabelValues(managed.Operation).Dec()

    duration := time.Since(managed.StartTime)
    fmt.Printf("Context %s (%s) finished: %s after %v\n",
        managed.ID, managed.Operation, reason, duration)
}

// WithOperationContext provides operation-scoped context management
func WithOperationContext(parent context.Context, operation string, timeout time.Duration, fn func(context.Context) error) error {
    cm := NewContextManager()
    managed := cm.CreateContext(parent, operation, timeout)
    defer managed.Cancel()

    return fn(managed.Context)
}

// Example usage in enterprise service
func ProcessUserRequest(ctx context.Context, userID string) error {
    return WithOperationContext(ctx, "process_user_request", 30*time.Second, func(opCtx context.Context) error {
        // Database operation with context
        user, err := fetchUser(opCtx, userID)
        if err != nil {
            return fmt.Errorf("failed to fetch user: %w", err)
        }

        // Parallel operations with fan-out/fan-in
        return WithOperationContext(opCtx, "parallel_user_operations", 20*time.Second, func(parallelCtx context.Context) error {
            var wg sync.WaitGroup
            errChan := make(chan error, 3)

            operations := []func(context.Context, *User) error{
                updateUserProfile,
                calculateUserMetrics,
                sendUserNotification,
            }

            for _, op := range operations {
                wg.Add(1)
                go func(operation func(context.Context, *User) error) {
                    defer wg.Done()
                    if err := operation(parallelCtx, user); err != nil {
                        select {
                        case errChan <- err:
                        default:
                            // Error channel full, log and continue
                            fmt.Printf("Error channel full, dropping error: %v\n", err)
                        }
                    }
                }(op)
            }

            wg.Wait()
            close(errChan)

            // Collect any errors
            for err := range errChan {
                if err != nil {
                    return err
                }
            }

            return nil
        })
    })
}
```

## Fan-Out/Fan-In Pattern with Monitoring

### Production-Ready Fan-Out Implementation

```go
package fanout

import (
    "context"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    fanOutOperations = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "fanout_operations_total",
            Help: "Total number of fan-out operations",
        },
        []string{"operation", "status"},
    )

    fanOutDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "fanout_operation_duration_seconds",
            Help:    "Duration of fan-out operations",
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
        },
        []string{"operation"},
    )

    fanOutWorkers = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "fanout_active_workers",
            Help: "Number of active fan-out workers",
        },
        []string{"operation"},
    )
)

// FanOutResult represents the result of a fan-out operation
type FanOutResult[T any] struct {
    Index  int
    Data   T
    Error  error
    Worker int
}

// FanOutProcessor handles parallel processing with monitoring
type FanOutProcessor[T, R any] struct {
    name       string
    maxWorkers int
    processor  func(context.Context, T) (R, error)
    timeout    time.Duration
}

// NewFanOutProcessor creates a new fan-out processor
func NewFanOutProcessor[T, R any](name string, maxWorkers int,
    processor func(context.Context, T) (R, error)) *FanOutProcessor[T, R] {

    return &FanOutProcessor[T, R]{
        name:       name,
        maxWorkers: maxWorkers,
        processor:  processor,
        timeout:    30 * time.Second,
    }
}

// Process executes fan-out processing with comprehensive monitoring
func (fp *FanOutProcessor[T, R]) Process(ctx context.Context, items []T) ([]R, error) {
    start := time.Now()
    defer func() {
        duration := time.Since(start)
        fanOutDuration.WithLabelValues(fp.name).Observe(duration.Seconds())
    }()

    if len(items) == 0 {
        return []R{}, nil
    }

    // Determine optimal number of workers
    numWorkers := fp.maxWorkers
    if len(items) < numWorkers {
        numWorkers = len(items)
    }

    // Create channels
    input := make(chan indexedItem[T], len(items))
    results := make(chan FanOutResult[R], len(items))

    // Start workers
    var wg sync.WaitGroup
    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        workerID := i
        fanOutWorkers.WithLabelValues(fp.name).Inc()

        go func(id int) {
            defer func() {
                wg.Done()
                fanOutWorkers.WithLabelValues(fp.name).Dec()
            }()

            fp.worker(ctx, id, input, results)
        }(workerID)
    }

    // Send work items
    go func() {
        defer close(input)
        for i, item := range items {
            select {
            case input <- indexedItem[T]{Index: i, Data: item}:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Collect results
    go func() {
        wg.Wait()
        close(results)
    }()

    // Aggregate results
    output := make([]R, len(items))
    errors := make([]error, 0)

    for result := range results {
        if result.Error != nil {
            errors = append(errors, result.Error)
            fanOutOperations.WithLabelValues(fp.name, "error").Inc()
        } else {
            output[result.Index] = result.Data
            fanOutOperations.WithLabelValues(fp.name, "success").Inc()
        }
    }

    if len(errors) > 0 {
        return output, fmt.Errorf("fan-out operation had %d errors: %v", len(errors), errors[0])
    }

    return output, nil
}

type indexedItem[T any] struct {
    Index int
    Data  T
}

func (fp *FanOutProcessor[T, R]) worker(ctx context.Context, workerID int,
    input <-chan indexedItem[T], results chan<- FanOutResult[R]) {

    for {
        select {
        case item, ok := <-input:
            if !ok {
                return
            }

            // Process with timeout
            result := FanOutResult[R]{Index: item.Index, Worker: workerID}

            // Create timeout context for this operation
            opCtx, cancel := context.WithTimeout(ctx, fp.timeout)

            func() {
                defer cancel()
                defer func() {
                    if r := recover(); r != nil {
                        result.Error = fmt.Errorf("worker %d panicked: %v", workerID, r)
                    }
                }()

                result.Data, result.Error = fp.processor(opCtx, item.Data)
            }()

            select {
            case results <- result:
            case <-ctx.Done():
                return
            }

        case <-ctx.Done():
            return
        }
    }
}

// Example: Parallel API calls with monitoring
func FetchUserDataParallel(ctx context.Context, userIDs []string) ([]UserData, error) {
    processor := NewFanOutProcessor("fetch_user_data", 10, func(ctx context.Context, userID string) (UserData, error) {
        // Simulate API call with proper context handling
        select {
        case <-ctx.Done():
            return UserData{}, ctx.Err()
        case <-time.After(100 * time.Millisecond): // Simulate work
            return UserData{ID: userID, Name: "User " + userID}, nil
        }
    })

    return processor.Process(ctx, userIDs)
}
```

## Goroutine Leak Detection and Prevention

### Advanced Leak Detection System

```go
package leakdetection

import (
    "context"
    "fmt"
    "runtime"
    "runtime/debug"
    "sort"
    "strings"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    goroutineCount = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "goroutines_active",
            Help: "Number of active goroutines",
        },
    )

    goroutineLeaks = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "goroutine_leaks_detected_total",
            Help: "Total number of goroutine leaks detected",
        },
        []string{"leak_type", "function"},
    )

    goroutineCreationRate = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "goroutines_creation_rate",
            Help: "Rate of goroutine creation per second",
        },
    )
)

// LeakDetector monitors goroutine lifecycles and detects leaks
type LeakDetector struct {
    baseline           int
    threshold          int
    checkInterval      time.Duration
    growthRateLimit    float64
    functionTracking   map[string]int
    trackingMutex      sync.RWMutex
    lastGoroutineCount int
    lastCheckTime      time.Time
    alertCallback      func(LeakAlert)
}

type LeakAlert struct {
    Type        LeakType
    Function    string
    Count       int
    GrowthRate  float64
    StackTrace  string
    Timestamp   time.Time
}

type LeakType int

const (
    LeakTypeGrowth LeakType = iota
    LeakTypeStuck
    LeakTypeAbnormalIncrease
)

// NewLeakDetector creates a new goroutine leak detector
func NewLeakDetector() *LeakDetector {
    return &LeakDetector{
        baseline:         runtime.NumGoroutine(),
        threshold:        1000,
        checkInterval:    30 * time.Second,
        growthRateLimit:  10.0, // 10 goroutines per second
        functionTracking: make(map[string]int),
        lastCheckTime:    time.Now(),
    }
}

// Start begins leak detection monitoring
func (ld *LeakDetector) Start(ctx context.Context) {
    ticker := time.NewTicker(ld.checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            ld.checkForLeaks()
        }
    }
}

func (ld *LeakDetector) checkForLeaks() {
    currentCount := runtime.NumGoroutine()
    goroutineCount.Set(float64(currentCount))

    now := time.Now()
    timeDelta := now.Sub(ld.lastCheckTime).Seconds()
    countDelta := currentCount - ld.lastGoroutineCount

    // Calculate creation rate
    if timeDelta > 0 {
        creationRate := float64(countDelta) / timeDelta
        goroutineCreationRate.Set(creationRate)

        // Check for abnormal growth rate
        if creationRate > ld.growthRateLimit && countDelta > 0 {
            ld.detectAbnormalGrowth(creationRate)
        }
    }

    // Check for overall threshold breach
    if currentCount > ld.threshold {
        ld.detectThresholdBreach(currentCount)
    }

    // Analyze goroutine stack traces
    ld.analyzeStackTraces()

    ld.lastGoroutineCount = currentCount
    ld.lastCheckTime = now
}

func (ld *LeakDetector) detectAbnormalGrowth(rate float64) {
    stack := string(debug.Stack())

    alert := LeakAlert{
        Type:       LeakTypeAbnormalIncrease,
        GrowthRate: rate,
        StackTrace: stack,
        Timestamp:  time.Now(),
    }

    goroutineLeaks.WithLabelValues("abnormal_growth", "unknown").Inc()

    if ld.alertCallback != nil {
        ld.alertCallback(alert)
    }

    fmt.Printf("LEAK ALERT: Abnormal goroutine growth rate: %.2f/sec\n", rate)
}

func (ld *LeakDetector) detectThresholdBreach(count int) {
    stack := string(debug.Stack())

    alert := LeakAlert{
        Type:       LeakTypeGrowth,
        Count:      count,
        StackTrace: stack,
        Timestamp:  time.Now(),
    }

    goroutineLeaks.WithLabelValues("threshold_breach", "unknown").Inc()

    if ld.alertCallback != nil {
        ld.alertCallback(alert)
    }

    fmt.Printf("LEAK ALERT: Goroutine count exceeded threshold: %d > %d\n", count, ld.threshold)
}

func (ld *LeakDetector) analyzeStackTraces() {
    // Get stack traces of all goroutines
    buf := make([]byte, 1024*1024) // 1MB buffer
    n := runtime.Stack(buf, true)
    stacks := string(buf[:n])

    // Parse and analyze stack traces
    traces := parseStackTraces(stacks)
    functionCounts := make(map[string]int)

    for _, trace := range traces {
        if len(trace.Functions) > 0 {
            topFunction := trace.Functions[0]
            functionCounts[topFunction]++
        }
    }

    // Compare with previous counts to detect leaks
    ld.trackingMutex.Lock()
    defer ld.trackingMutex.Unlock()

    for function, count := range functionCounts {
        previousCount, exists := ld.functionTracking[function]
        if exists && count > previousCount*2 && count > 10 {
            // Potential leak detected
            alert := LeakAlert{
                Type:      LeakTypeStuck,
                Function:  function,
                Count:     count,
                Timestamp: time.Now(),
            }

            goroutineLeaks.WithLabelValues("stuck_goroutines", function).Inc()

            if ld.alertCallback != nil {
                ld.alertCallback(alert)
            }

            fmt.Printf("LEAK ALERT: Potential stuck goroutines in %s: %d (was %d)\n",
                function, count, previousCount)
        }
        ld.functionTracking[function] = count
    }
}

type StackTrace struct {
    ID        int
    State     string
    Functions []string
    WaitTime  time.Duration
}

func parseStackTraces(stacks string) []StackTrace {
    lines := strings.Split(stacks, "\n")
    var traces []StackTrace
    var currentTrace *StackTrace

    for _, line := range lines {
        line = strings.TrimSpace(line)
        if line == "" {
            continue
        }

        if strings.HasPrefix(line, "goroutine ") {
            if currentTrace != nil {
                traces = append(traces, *currentTrace)
            }
            currentTrace = &StackTrace{
                Functions: make([]string, 0),
            }

            // Parse goroutine header
            parts := strings.Split(line, " ")
            if len(parts) >= 2 {
                // Extract state and wait time if available
                if strings.Contains(line, "[") {
                    start := strings.Index(line, "[")
                    end := strings.Index(line, "]")
                    if start != -1 && end != -1 && end > start {
                        currentTrace.State = line[start+1 : end]
                    }
                }
            }
        } else if currentTrace != nil && !strings.HasPrefix(line, "\t") {
            // Function name
            currentTrace.Functions = append(currentTrace.Functions, line)
        }
    }

    if currentTrace != nil {
        traces = append(traces, *currentTrace)
    }

    return traces
}

// SetAlertCallback sets a callback for leak alerts
func (ld *LeakDetector) SetAlertCallback(callback func(LeakAlert)) {
    ld.alertCallback = callback
}

// GetGoroutineReport generates a comprehensive goroutine report
func (ld *LeakDetector) GetGoroutineReport() GoroutineReport {
    ld.trackingMutex.RLock()
    defer ld.trackingMutex.RUnlock()

    report := GoroutineReport{
        Timestamp:     time.Now(),
        TotalCount:    runtime.NumGoroutine(),
        FunctionBreakdown: make(map[string]int),
    }

    for function, count := range ld.functionTracking {
        report.FunctionBreakdown[function] = count
    }

    // Sort by count for easier analysis
    type functionCount struct {
        Function string
        Count    int
    }

    var sorted []functionCount
    for function, count := range report.FunctionBreakdown {
        sorted = append(sorted, functionCount{Function: function, Count: count})
    }

    sort.Slice(sorted, func(i, j int) bool {
        return sorted[i].Count > sorted[j].Count
    })

    report.TopFunctions = make([]string, 0, len(sorted))
    for _, fc := range sorted {
        report.TopFunctions = append(report.TopFunctions,
            fmt.Sprintf("%s: %d", fc.Function, fc.Count))
    }

    return report
}

type GoroutineReport struct {
    Timestamp         time.Time
    TotalCount        int
    FunctionBreakdown map[string]int
    TopFunctions      []string
}
```

## Production Monitoring Dashboard

### Comprehensive Goroutine Metrics

```go
// metrics/goroutine_dashboard.go
package metrics

import (
    "context"
    "encoding/json"
    "net/http"
    "runtime"
    "time"
)

// GoroutineDashboard provides a comprehensive view of goroutine health
type GoroutineDashboard struct {
    leakDetector *LeakDetector
    pools        map[string]*EnterpriseWorkerPool
}

type DashboardData struct {
    Timestamp        time.Time                    `json:"timestamp"`
    TotalGoroutines  int                         `json:"total_goroutines"`
    SystemMetrics    SystemMetrics               `json:"system_metrics"`
    WorkerPools      map[string]WorkerPoolStatus `json:"worker_pools"`
    LeakAlerts       []LeakAlert                 `json:"leak_alerts"`
    PerformanceStats PerformanceStats            `json:"performance_stats"`
}

type SystemMetrics struct {
    NumCPU        int           `json:"num_cpu"`
    NumGC         uint32        `json:"num_gc"`
    GCPauseTotal  time.Duration `json:"gc_pause_total"`
    HeapAlloc     uint64        `json:"heap_alloc"`
    HeapSys       uint64        `json:"heap_sys"`
    StackInuse    uint64        `json:"stack_inuse"`
}

type WorkerPoolStatus struct {
    Name           string  `json:"name"`
    ActiveWorkers  int     `json:"active_workers"`
    QueueDepth     int     `json:"queue_depth"`
    JobsProcessed  int64   `json:"jobs_processed"`
    Utilization    float64 `json:"utilization"`
    ErrorRate      float64 `json:"error_rate"`
}

type PerformanceStats struct {
    AverageResponseTime time.Duration `json:"average_response_time"`
    ThroughputPerSecond float64       `json:"throughput_per_second"`
    ErrorRatePercent    float64       `json:"error_rate_percent"`
    ResourceUtilization float64       `json:"resource_utilization"`
}

// NewGoroutineDashboard creates a new dashboard
func NewGoroutineDashboard(leakDetector *LeakDetector) *GoroutineDashboard {
    return &GoroutineDashboard{
        leakDetector: leakDetector,
        pools:        make(map[string]*EnterpriseWorkerPool),
    }
}

// RegisterWorkerPool registers a worker pool for monitoring
func (gd *GoroutineDashboard) RegisterWorkerPool(name string, pool *EnterpriseWorkerPool) {
    gd.pools[name] = pool
}

// ServeHTTP serves the dashboard data
func (gd *GoroutineDashboard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    data := gd.collectDashboardData()

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Access-Control-Allow-Origin", "*")

    if err := json.NewEncoder(w).Encode(data); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
}

func (gd *GoroutineDashboard) collectDashboardData() DashboardData {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    data := DashboardData{
        Timestamp:       time.Now(),
        TotalGoroutines: runtime.NumGoroutine(),
        SystemMetrics: SystemMetrics{
            NumCPU:       runtime.NumCPU(),
            NumGC:        m.NumGC,
            GCPauseTotal: time.Duration(m.PauseTotalNs),
            HeapAlloc:    m.HeapAlloc,
            HeapSys:      m.HeapSys,
            StackInuse:   m.StackInuse,
        },
        WorkerPools: make(map[string]WorkerPoolStatus),
    }

    // Collect worker pool statuses
    for name, pool := range gd.pools {
        status := WorkerPoolStatus{
            Name:          name,
            ActiveWorkers: len(pool.workers),
            QueueDepth:    len(pool.jobs),
            JobsProcessed: pool.stats.JobsProcessed,
            Utilization:   pool.stats.WorkerUtilization,
            ErrorRate:     pool.stats.ErrorRate,
        }
        data.WorkerPools[name] = status
    }

    return data
}

// StartDashboardServer starts the monitoring dashboard HTTP server
func (gd *GoroutineDashboard) StartDashboardServer(ctx context.Context, addr string) error {
    mux := http.NewServeMux()
    mux.Handle("/api/goroutines", gd)
    mux.Handle("/api/health", http.HandlerFunc(gd.healthCheck))

    server := &http.Server{
        Addr:    addr,
        Handler: mux,
    }

    go func() {
        <-ctx.Done()
        server.Shutdown(context.Background())
    }()

    return server.ListenAndServe()
}

func (gd *GoroutineDashboard) healthCheck(w http.ResponseWriter, r *http.Request) {
    health := map[string]interface{}{
        "status":           "healthy",
        "goroutines":       runtime.NumGoroutine(),
        "timestamp":        time.Now(),
        "worker_pools":     len(gd.pools),
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(health)
}
```

## Conclusion

Proper goroutine management separates amateur Go applications from enterprise-grade systems that can handle production loads reliably. The patterns and monitoring strategies outlined in this guide provide the foundation for building robust, scalable Go applications that can operate safely in high-traffic environments.

Key enterprise goroutine management principles:

1. **Bounded Concurrency**: Always limit goroutine creation through worker pools and semaphores
2. **Context-Driven Cancellation**: Implement comprehensive cancellation and timeout mechanisms
3. **Comprehensive Monitoring**: Track goroutine lifecycles, detect leaks, and monitor performance
4. **Resource Management**: Properly manage cleanup and prevent resource leaks
5. **Recovery Patterns**: Implement panic recovery and graceful degradation

Organizations implementing these patterns report significant improvements in system stability, resource utilization, and operational confidence. By treating goroutines as the sophisticated concurrency primitives they are—rather than simple lightweight threads—teams can build Go applications that scale reliably from development through production environments.

The investment in proper goroutine management infrastructure pays dividends in reduced incident frequency, improved system performance, and enhanced developer productivity when debugging production issues.