---
title: "Go Batch Processing: Efficient Large Dataset Handling with Pipelines and Worker Pools"
date: 2030-10-06T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Batch Processing", "Concurrency", "Pipelines", "Performance", "Worker Pools"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise batch processing in Go: chunked data loading, pipeline stage parallelism, memory-efficient streaming with io.Reader, progress tracking, error accumulation strategies, checkpoint/resume patterns, and benchmarking throughput."
more_link: "yes"
url: "/go-batch-processing-large-datasets-pipelines-worker-pools/"
---

Processing multi-gigabyte datasets in Go requires a disciplined approach to memory management, concurrency control, and error handling that differs substantially from handling individual requests. A poorly structured batch processor will OOM on large inputs, drop errors silently, or serialize work that should run in parallel. The patterns in this guide have been extracted from production systems processing hundreds of gigabytes per run.

<!--more-->

## Foundational Principles

Before writing a single goroutine, three decisions determine the architecture:

1. **Streaming vs. loading**: Can the dataset fit comfortably in memory? If not, process records without materializing the full dataset.
2. **Ordered vs. unordered**: Does output order matter? Unordered processing enables much higher throughput.
3. **Checkpoint granularity**: What is the cost of reprocessing on failure? This determines how often to checkpoint progress.

---

## Memory-Efficient Streaming with io.Reader

The most important tool for large dataset processing is the streaming abstraction. Instead of loading data into a `[]byte` or `[]string`, process records one chunk at a time.

### CSV Streaming

```go
package batch

import (
    "bufio"
    "encoding/csv"
    "fmt"
    "io"
    "os"
)

// Record represents a single row of business data
type Record struct {
    ID         string
    CustomerID string
    Amount     float64
    Timestamp  int64
}

// StreamCSV reads a CSV file record by record without loading it into memory.
// The callback receives each record; returning an error stops iteration.
func StreamCSV(path string, batchSize int, callback func([]Record) error) error {
    f, err := os.Open(path)
    if err != nil {
        return fmt.Errorf("open %s: %w", path, err)
    }
    defer f.Close()

    // bufio.NewReaderSize controls the read buffer, not the application buffer
    br := bufio.NewReaderSize(f, 64*1024)
    r := csv.NewReader(br)
    r.ReuseRecord = true  // Critical: reuse the backing array to reduce GC pressure

    // Skip header
    if _, err := r.Read(); err != nil {
        return fmt.Errorf("read header: %w", err)
    }

    batch := make([]Record, 0, batchSize)

    for {
        row, err := r.Read()
        if err == io.EOF {
            break
        }
        if err != nil {
            return fmt.Errorf("read row: %w", err)
        }

        rec, err := parseRecord(row)
        if err != nil {
            return fmt.Errorf("parse record: %w", err)
        }
        batch = append(batch, rec)

        if len(batch) >= batchSize {
            if err := callback(batch); err != nil {
                return err
            }
            // Reset without reallocating
            batch = batch[:0]
        }
    }

    // Flush final partial batch
    if len(batch) > 0 {
        return callback(batch)
    }
    return nil
}

func parseRecord(row []string) (Record, error) {
    if len(row) < 4 {
        return Record{}, fmt.Errorf("expected 4 fields, got %d", len(row))
    }
    var amount float64
    if _, err := fmt.Sscanf(row[2], "%f", &amount); err != nil {
        return Record{}, fmt.Errorf("parse amount %q: %w", row[2], err)
    }
    var ts int64
    if _, err := fmt.Sscanf(row[3], "%d", &ts); err != nil {
        return Record{}, fmt.Errorf("parse timestamp %q: %w", row[3], err)
    }
    return Record{
        ID:         row[0],
        CustomerID: row[1],
        Amount:     amount,
        Timestamp:  ts,
    }, nil
}
```

---

## Pipeline Architecture

A pipeline processes data through discrete stages. Each stage runs in its own goroutine pool, connected by buffered channels. This maximizes CPU utilization across heterogeneous workloads (I/O-bound reads, CPU-bound transforms, I/O-bound writes).

### Generic Pipeline Stage

```go
package pipeline

import (
    "context"
    "sync"
)

// Stage represents a single processing step
type Stage[In, Out any] struct {
    Name        string
    Concurrency int
    Process     func(ctx context.Context, in In) (Out, error)
}

// Run connects an input channel to an output channel, processing items
// with the configured concurrency.
func (s *Stage[In, Out]) Run(
    ctx context.Context,
    in <-chan In,
) (<-chan Out, <-chan error) {
    out := make(chan Out, s.Concurrency*2)
    errs := make(chan error, s.Concurrency)

    var wg sync.WaitGroup
    wg.Add(s.Concurrency)

    for i := 0; i < s.Concurrency; i++ {
        go func() {
            defer wg.Done()
            for item := range in {
                result, err := s.Process(ctx, item)
                if err != nil {
                    select {
                    case errs <- err:
                    case <-ctx.Done():
                        return
                    }
                    continue
                }
                select {
                case out <- result:
                case <-ctx.Done():
                    return
                }
            }
        }()
    }

    go func() {
        wg.Wait()
        close(out)
        close(errs)
    }()

    return out, errs
}
```

### Composing a Multi-Stage Pipeline

```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"
)

type RawRecord struct {
    Line string
}

type ParsedRecord struct {
    ID     string
    Value  float64
}

type EnrichedRecord struct {
    ParsedRecord
    Category string
}

type ProcessedRecord struct {
    EnrichedRecord
    Score float64
}

func runPipeline(ctx context.Context, inputPath string) error {
    // Stage 1: Parse raw lines
    parseStage := &Stage[RawRecord, ParsedRecord]{
        Name:        "parse",
        Concurrency: 4,
        Process: func(ctx context.Context, raw RawRecord) (ParsedRecord, error) {
            return parseLine(raw.Line)
        },
    }

    // Stage 2: Enrich with external data (I/O bound — higher concurrency)
    enrichStage := &Stage[ParsedRecord, EnrichedRecord]{
        Name:        "enrich",
        Concurrency: 16,
        Process: func(ctx context.Context, rec ParsedRecord) (EnrichedRecord, error) {
            return enrichRecord(ctx, rec)
        },
    }

    // Stage 3: Score (CPU bound — match to core count)
    scoreStage := &Stage[EnrichedRecord, ProcessedRecord]{
        Name:        "score",
        Concurrency: 8,
        Process: func(ctx context.Context, rec EnrichedRecord) (ProcessedRecord, error) {
            return scoreRecord(rec)
        },
    }

    // Wire up stages
    rawCh := readInput(ctx, inputPath)

    parsedCh, parseErrs := parseStage.Run(ctx, rawCh)
    enrichedCh, enrichErrs := enrichStage.Run(ctx, parsedCh)
    scoredCh, scoreErrs := scoreStage.Run(ctx, enrichedCh)

    // Collect errors from all stages
    errCh := mergeErrors(parseErrs, enrichErrs, scoreErrs)

    return sink(ctx, scoredCh, errCh)
}

func readInput(ctx context.Context, path string) <-chan RawRecord {
    ch := make(chan RawRecord, 1000)
    go func() {
        defer close(ch)
        // StreamCSV implementation from previous section
        err := StreamCSV(path, 1, func(batch []Record) error {
            select {
            case ch <- RawRecord{Line: batch[0].ID}:
            case <-ctx.Done():
                return ctx.Err()
            }
            return nil
        })
        if err != nil {
            log.Printf("input read error: %v", err)
        }
    }()
    return ch
}

func mergeErrors(channels ...<-chan error) <-chan error {
    merged := make(chan error, len(channels)*10)
    var wg sync.WaitGroup
    for _, ch := range channels {
        wg.Add(1)
        go func(c <-chan error) {
            defer wg.Done()
            for err := range c {
                merged <- err
            }
        }(ch)
    }
    go func() {
        wg.Wait()
        close(merged)
    }()
    return merged
}
```

---

## Worker Pool Pattern

For workloads that don't fit a linear pipeline — such as processing many independent files — the worker pool pattern provides better control:

```go
package workerpool

import (
    "context"
    "sync"
    "sync/atomic"
    "time"
)

// WorkItem represents a unit of work
type WorkItem struct {
    Path     string
    Checksum string
    Size     int64
}

// Result represents the outcome of processing a WorkItem
type Result struct {
    Item     WorkItem
    Err      error
    Duration time.Duration
    Count    int64
}

// Pool manages a fixed set of worker goroutines
type Pool struct {
    workers   int
    workCh    chan WorkItem
    resultCh  chan Result
    processed atomic.Int64
    failed    atomic.Int64
    wg        sync.WaitGroup
}

// NewPool creates a worker pool. Caller must call Start() before submitting work.
func NewPool(workers, queueDepth int) *Pool {
    return &Pool{
        workers:  workers,
        workCh:   make(chan WorkItem, queueDepth),
        resultCh: make(chan Result, queueDepth),
    }
}

// Start launches worker goroutines. The pool runs until the work channel is closed.
func (p *Pool) Start(ctx context.Context, processFn func(context.Context, WorkItem) Result) {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go func() {
            defer p.wg.Done()
            for {
                select {
                case item, ok := <-p.workCh:
                    if !ok {
                        return
                    }
                    start := time.Now()
                    result := processFn(ctx, item)
                    result.Duration = time.Since(start)
                    if result.Err != nil {
                        p.failed.Add(1)
                    } else {
                        p.processed.Add(result.Count)
                    }
                    select {
                    case p.resultCh <- result:
                    case <-ctx.Done():
                        return
                    }
                case <-ctx.Done():
                    return
                }
            }
        }()
    }
}

// Submit adds work to the pool queue. Blocks if the queue is full.
func (p *Pool) Submit(ctx context.Context, item WorkItem) error {
    select {
    case p.workCh <- item:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Close signals workers to stop after draining the queue.
func (p *Pool) Close() <-chan Result {
    close(p.workCh)
    go func() {
        p.wg.Wait()
        close(p.resultCh)
    }()
    return p.resultCh
}

// Stats returns current processing statistics.
func (p *Pool) Stats() (processed, failed int64) {
    return p.processed.Load(), p.failed.Load()
}
```

---

## Error Accumulation Strategies

Batch processing must decide: stop on first error, or collect all errors and report at the end?

```go
package errors

import (
    "fmt"
    "strings"
    "sync"
)

// BatchError collects multiple errors from parallel processing.
// It is safe for concurrent use.
type BatchError struct {
    mu      sync.Mutex
    errors  []error
    maxSize int
}

// NewBatchError creates a collector that holds at most maxSize errors.
// If maxSize <= 0, all errors are collected.
func NewBatchError(maxSize int) *BatchError {
    return &BatchError{maxSize: maxSize}
}

// Add appends an error. Returns false if the error was dropped (max reached).
func (b *BatchError) Add(err error) bool {
    if err == nil {
        return true
    }
    b.mu.Lock()
    defer b.mu.Unlock()
    if b.maxSize > 0 && len(b.errors) >= b.maxSize {
        return false
    }
    b.errors = append(b.errors, err)
    return true
}

// Err returns nil if no errors were collected, or a combined error.
func (b *BatchError) Err() error {
    b.mu.Lock()
    defer b.mu.Unlock()
    if len(b.errors) == 0 {
        return nil
    }
    return b
}

func (b *BatchError) Error() string {
    b.mu.Lock()
    defer b.mu.Unlock()
    msgs := make([]string, len(b.errors))
    for i, err := range b.errors {
        msgs[i] = fmt.Sprintf("[%d] %s", i+1, err.Error())
    }
    return fmt.Sprintf("%d batch errors:\n%s", len(b.errors), strings.Join(msgs, "\n"))
}

func (b *BatchError) Unwrap() []error {
    b.mu.Lock()
    defer b.mu.Unlock()
    cp := make([]error, len(b.errors))
    copy(cp, b.errors)
    return cp
}

// Count returns the number of collected errors.
func (b *BatchError) Count() int {
    b.mu.Lock()
    defer b.mu.Unlock()
    return len(b.errors)
}
```

---

## Progress Tracking

Long-running batch jobs need progress visibility without adding significant overhead:

```go
package progress

import (
    "fmt"
    "io"
    "sync/atomic"
    "time"
)

// Tracker tracks processing progress and estimated completion.
type Tracker struct {
    total     int64
    processed atomic.Int64
    failed    atomic.Int64
    startTime time.Time
    out       io.Writer
}

// NewTracker creates a progress tracker for a job with known total count.
func NewTracker(total int64, out io.Writer) *Tracker {
    return &Tracker{
        total:     total,
        startTime: time.Now(),
        out:       out,
    }
}

// RecordSuccess increments the success counter.
func (t *Tracker) RecordSuccess(n int64) { t.processed.Add(n) }

// RecordFailure increments the failure counter.
func (t *Tracker) RecordFailure(n int64) { t.failed.Add(n) }

// Print writes a progress line to the output writer.
func (t *Tracker) Print() {
    proc := t.processed.Load()
    fail := t.failed.Load()
    done := proc + fail
    elapsed := time.Since(t.startTime)

    var pct float64
    var eta time.Duration
    var rps float64

    if t.total > 0 {
        pct = float64(done) / float64(t.total) * 100
    }
    if elapsed > 0 {
        rps = float64(done) / elapsed.Seconds()
    }
    if rps > 0 && t.total > done {
        remaining := float64(t.total-done) / rps
        eta = time.Duration(remaining) * time.Second
    }

    fmt.Fprintf(t.out,
        "\r[%s] %d/%d (%.1f%%) ok=%d fail=%d rps=%.0f eta=%s   ",
        formatElapsed(elapsed),
        done, t.total, pct,
        proc, fail,
        rps,
        formatDuration(eta),
    )
}

// RunDisplay starts a goroutine that prints progress every interval until done is closed.
func (t *Tracker) RunDisplay(interval time.Duration, done <-chan struct{}) {
    ticker := time.NewTicker(interval)
    go func() {
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                t.Print()
            case <-done:
                t.Print()
                fmt.Fprintln(t.out)
                return
            }
        }
    }()
}

func formatElapsed(d time.Duration) string {
    h := int(d.Hours())
    m := int(d.Minutes()) % 60
    s := int(d.Seconds()) % 60
    return fmt.Sprintf("%02d:%02d:%02d", h, m, s)
}

func formatDuration(d time.Duration) string {
    if d == 0 {
        return "unknown"
    }
    return d.Round(time.Second).String()
}
```

---

## Checkpoint and Resume Pattern

For jobs that may take hours, checkpointing allows resuming from the last stable point after a failure:

```go
package checkpoint

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "sync"
    "time"
)

// Checkpoint stores the state of a batch job that can be resumed.
type Checkpoint struct {
    mu         sync.Mutex
    path       string
    State      CheckpointState
    flushEvery int
    count      int
}

// CheckpointState is the persisted state
type CheckpointState struct {
    JobID         string            `json:"job_id"`
    LastOffset    int64             `json:"last_offset"`
    ProcessedKeys map[string]bool   `json:"processed_keys"`
    Counters      map[string]int64  `json:"counters"`
    StartedAt     time.Time         `json:"started_at"`
    UpdatedAt     time.Time         `json:"updated_at"`
}

// NewCheckpoint loads an existing checkpoint or creates a new one.
func NewCheckpoint(path, jobID string, flushEvery int) (*Checkpoint, error) {
    cp := &Checkpoint{
        path:       path,
        flushEvery: flushEvery,
    }

    if data, err := os.ReadFile(path); err == nil {
        if err := json.Unmarshal(data, &cp.State); err != nil {
            return nil, fmt.Errorf("parse checkpoint: %w", err)
        }
        if cp.State.JobID != jobID {
            return nil, fmt.Errorf("checkpoint job ID mismatch: %s != %s",
                cp.State.JobID, jobID)
        }
        return cp, nil
    }

    cp.State = CheckpointState{
        JobID:         jobID,
        ProcessedKeys: make(map[string]bool),
        Counters:      make(map[string]int64),
        StartedAt:     time.Now(),
    }
    return cp, nil
}

// MarkProcessed records that a key has been processed and
// flushes to disk every N calls.
func (cp *Checkpoint) MarkProcessed(key string, offset int64) error {
    cp.mu.Lock()
    defer cp.mu.Unlock()

    cp.State.ProcessedKeys[key] = true
    cp.State.LastOffset = offset
    cp.State.UpdatedAt = time.Now()
    cp.count++

    if cp.count%cp.flushEvery == 0 {
        return cp.flush()
    }
    return nil
}

// IsProcessed returns true if the key was already handled.
func (cp *Checkpoint) IsProcessed(key string) bool {
    cp.mu.Lock()
    defer cp.mu.Unlock()
    return cp.State.ProcessedKeys[key]
}

// Increment adds delta to a named counter.
func (cp *Checkpoint) Increment(name string, delta int64) {
    cp.mu.Lock()
    defer cp.mu.Unlock()
    cp.State.Counters[name] += delta
}

// Flush writes the checkpoint to disk atomically.
func (cp *Checkpoint) Flush() error {
    cp.mu.Lock()
    defer cp.mu.Unlock()
    return cp.flush()
}

func (cp *Checkpoint) flush() error {
    data, err := json.MarshalIndent(&cp.State, "", "  ")
    if err != nil {
        return fmt.Errorf("marshal checkpoint: %w", err)
    }

    // Write to temp file, then rename for atomicity
    tmp := cp.path + ".tmp"
    if err := os.WriteFile(tmp, data, 0600); err != nil {
        return fmt.Errorf("write checkpoint: %w", err)
    }
    if err := os.Rename(tmp, cp.path); err != nil {
        return fmt.Errorf("rename checkpoint: %w", err)
    }
    return nil
}

// Remove deletes the checkpoint file on successful completion.
func (cp *Checkpoint) Remove() error {
    return os.Remove(cp.path)
}

// Usage example showing checkpoint integration with a batch job
func ProcessWithCheckpoint(items []WorkItem, cpPath string) error {
    cp, err := NewCheckpoint(cpPath, "export-job-v2", 1000)
    if err != nil {
        return fmt.Errorf("load checkpoint: %w", err)
    }

    for i, item := range items {
        if cp.IsProcessed(item.Path) {
            continue  // Resume: skip already-done items
        }

        if err := processItem(item); err != nil {
            cp.Increment("errors", 1)
            // Log but continue — error is accumulating
            continue
        }

        if err := cp.MarkProcessed(item.Path, int64(i)); err != nil {
            return fmt.Errorf("checkpoint write: %w", err)
        }
        cp.Increment("success", 1)
    }

    if err := cp.Flush(); err != nil {
        return err
    }
    return cp.Remove()
}
```

---

## Backpressure and Rate Limiting

Producer-consumer imbalance leads to memory exhaustion. Explicit backpressure keeps the pipeline healthy:

```go
package ratelimit

import (
    "context"
    "golang.org/x/time/rate"
    "time"
)

// ThrottledProducer wraps a producer to limit output rate
type ThrottledProducer struct {
    limiter *rate.Limiter
    out     chan<- WorkItem
}

func NewThrottledProducer(rps float64, burst int, out chan<- WorkItem) *ThrottledProducer {
    return &ThrottledProducer{
        limiter: rate.NewLimiter(rate.Limit(rps), burst),
        out:     out,
    }
}

func (p *ThrottledProducer) Send(ctx context.Context, item WorkItem) error {
    if err := p.limiter.Wait(ctx); err != nil {
        return err
    }
    select {
    case p.out <- item:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// AdaptiveConcurrency adjusts worker count based on queue depth
func monitorAndAdjust(pool *Pool, target int, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for range ticker.C {
        queueDepth := len(pool.workCh)
        capacity := cap(pool.workCh)
        utilization := float64(queueDepth) / float64(capacity)

        switch {
        case utilization < 0.2:
            // Queue nearly empty — workers keeping up, can reduce
        case utilization > 0.8:
            // Queue nearly full — add workers or slow producer
        }
    }
}
```

---

## Benchmarking Throughput

```go
package bench_test

import (
    "context"
    "testing"
)

func BenchmarkPipeline(b *testing.B) {
    items := generateTestItems(b.N)

    b.ResetTimer()
    b.ReportAllocs()
    b.SetBytes(int64(b.N * avgItemSize))

    ctx := context.Background()
    pool := NewPool(8, 1000)
    pool.Start(ctx, processItem)

    go func() {
        for _, item := range items {
            pool.Submit(ctx, item)
        }
        pool.Close()
    }()

    results := pool.Close()
    var count int
    for range results {
        count++
    }

    b.ReportMetric(float64(count)/b.Elapsed().Seconds(), "records/s")
}

// Run with:
// go test -bench=BenchmarkPipeline -benchmem -benchtime=30s ./...
```

---

## Practical Tuning Guidelines

Channel buffer sizing affects throughput significantly:

```go
// Rule of thumb: buffer = workers × 2 for the output channel of each stage
// This allows workers to continue while the downstream consumer drains

// Too small (1): workers block frequently, CPU idles waiting for channel drain
parsedCh := make(chan ParsedRecord, 1)

// Too large (100000): high memory usage, long drain time on cancellation
parsedCh := make(chan ParsedRecord, 100000)

// Good: 2× worker count
parsedCh := make(chan ParsedRecord, parseWorkers*2)

// For I/O-bound stages: slightly larger to absorb latency spikes
enrichedCh := make(chan EnrichedRecord, enrichWorkers*4)
```

Optimal worker counts by workload type:

| Workload Type | Starting Concurrency | Notes |
|---|---|---|
| CPU-bound | `runtime.NumCPU()` | Match to physical cores |
| In-process I/O (memory) | `runtime.NumCPU() * 2` | Light coordination overhead |
| Network I/O | 50–200 | Depends on target service limits |
| Disk I/O (SSD) | 4–16 | Depends on IOPS |
| Database queries | Connection pool size | Avoid exceeding pool |

The combination of streaming reads, explicitly sized worker pools, structured error accumulation, and checkpointing provides a production-grade batch processing foundation that handles arbitrarily large datasets without sacrificing observability or reliability.
