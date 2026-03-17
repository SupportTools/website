---
title: "Go: Building Reactive Systems with RxGo for Event-Driven Stream Processing Pipelines"
date: 2031-07-12T00:00:00-05:00
draft: false
tags: ["Go", "RxGo", "Reactive Programming", "Stream Processing", "Event-Driven", "Golang", "Concurrency"]
categories: ["Go", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to building reactive, event-driven stream processing pipelines in Go using RxGo, covering Observable patterns, operators, backpressure handling, error recovery, and production deployment patterns."
more_link: "yes"
url: "/go-rxgo-reactive-event-driven-stream-processing-pipelines/"
---

ReactiveX (Rx) is a programming model for composing asynchronous and event-driven programs using observable sequences. RxGo brings the ReactiveX model to Go, providing an operator-based pipeline API that sits on top of Go channels and goroutines. While Go's built-in concurrency primitives are powerful, they require significant boilerplate for complex data flow compositions. RxGo provides higher-level abstractions for filtering, transforming, merging, and error-handling in event streams that would otherwise require dozens of select statements and channel management code.

<!--more-->

# Go: Reactive Systems with RxGo for Event-Driven Stream Processing

## Section 1: Understanding the Reactive Model in Go

### The Core Abstraction: Observable

An `Observable` in RxGo is a lazy, potentially infinite sequence of items. Unlike Go channels which are push-based only, Observables support both hot (already emitting) and cold (emit on subscription) modes. The three fundamental types are:

- **Observable**: Single subscriber, lazy evaluation.
- **Connectable**: Multiple subscribers receive the same items (multicast).
- **Subject**: Both an Observer and an Observable (bridge between imperative and reactive code).

An Observable emits three types of signals:
- **Next(item)**: A new item in the stream.
- **Error(err)**: An error that terminates the stream.
- **Complete()**: Normal stream termination.

### When to Use RxGo vs Raw Channels

Use RxGo when you need:
- Declarative pipeline composition with multiple transformation steps.
- Built-in retry and error recovery operators.
- Rate limiting, debouncing, throttling, or windowing semantics.
- Fan-out (merging multiple streams) or fan-in (splitting a stream) with backpressure.

Use raw channels + goroutines when:
- You have a simple producer-consumer pattern.
- The pipeline has only one or two stages.
- You need maximum performance without operator overhead.

## Section 2: Setting Up RxGo

```bash
go get github.com/reactivex/rxgo/v2@latest
```

```go
// Basic Observable construction patterns
package main

import (
    "context"
    "fmt"
    "time"

    rxgo "github.com/reactivex/rxgo/v2"
)

func main() {
    // From a slice
    observable := rxgo.Just(1, 2, 3, 4, 5)()

    // From a channel
    ch := make(chan rxgo.Item, 10)
    go func() {
        for i := 0; i < 10; i++ {
            ch <- rxgo.Of(i)
        }
        close(ch)
    }()
    observable = rxgo.FromChannel(ch)

    // From an interval (tick every 100ms)
    observable = rxgo.Interval(rxgo.WithDuration(100*time.Millisecond))

    // From a custom iterating function
    observable = rxgo.Create([]rxgo.Producer{func(ctx context.Context, next chan<- rxgo.Item) {
        for i := 0; i < 5; i++ {
            next <- rxgo.Of(i * i)
        }
    }})

    // Subscribe and consume
    for item := range observable.Observe() {
        if item.Error() {
            fmt.Printf("Error: %v\n", item.E)
            continue
        }
        fmt.Printf("Item: %v\n", item.V)
    }
}
```

## Section 3: Building a Real-Time Log Processing Pipeline

This example builds a log processing pipeline that ingests log lines from Kafka, parses them, filters for errors, enriches with context, aggregates counts, and sends alerts.

### Data Types

```go
// pipeline/types.go
package pipeline

import "time"

type LogLevel string

const (
    LogLevelDebug LogLevel = "DEBUG"
    LogLevelInfo  LogLevel = "INFO"
    LogLevelWarn  LogLevel = "WARN"
    LogLevelError LogLevel = "ERROR"
    LogLevelFatal LogLevel = "FATAL"
)

type RawLogEntry struct {
    Timestamp  time.Time
    RawMessage string
    Source     string
    PartitionID int
    Offset     int64
}

type ParsedLogEntry struct {
    Timestamp   time.Time
    Level       LogLevel
    Service     string
    Message     string
    TraceID     string
    SpanID      string
    UserID      string
    StatusCode  int
    DurationMs  float64
    Error       string
    Labels      map[string]string
}

type AggregatedError struct {
    Service    string
    ErrorType  string
    Count      int
    FirstSeen  time.Time
    LastSeen   time.Time
    SampleMsg  string
}

type Alert struct {
    Severity   string
    Service    string
    Message    string
    Count      int
    Timestamp  time.Time
}
```

### Pipeline Implementation

```go
// pipeline/log_pipeline.go
package pipeline

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "regexp"
    "strings"
    "time"

    rxgo "github.com/reactivex/rxgo/v2"
)

// LogProcessingPipeline demonstrates a multi-stage reactive pipeline.
type LogProcessingPipeline struct {
    logger    *slog.Logger
    alertChan chan<- Alert
    metricsCh chan<- AggregatedError
}

func NewLogProcessingPipeline(
    logger *slog.Logger,
    alertChan chan<- Alert,
    metricsCh chan<- AggregatedError,
) *LogProcessingPipeline {
    return &LogProcessingPipeline{
        logger:    logger,
        alertChan: alertChan,
        metricsCh: metricsCh,
    }
}

// Run starts the pipeline and returns when the source observable completes.
func (p *LogProcessingPipeline) Run(ctx context.Context, source rxgo.Observable) error {
    pipeline := source.
        // Stage 1: Parse raw log entries
        Map(p.parseLogEntry,
            rxgo.WithCPUPool(),
            rxgo.WithErrorStrategy(rxgo.ContinueOnError),
        ).
        // Stage 2: Filter out DEBUG and INFO unless they contain certain keywords
        Filter(p.isRelevantEntry).
        // Stage 3: Enrich with additional context (service metadata, etc.)
        Map(p.enrichEntry,
            rxgo.WithPool(4),
        ).
        // Stage 4: Skip duplicate errors within a 1-second window
        Distinct(func(ctx context.Context, i interface{}) (interface{}, error) {
            entry, ok := i.(ParsedLogEntry)
            if !ok {
                return nil, fmt.Errorf("unexpected type: %T", i)
            }
            // Dedup key: service + error message (truncated to first 100 chars)
            msg := entry.Error
            if len(msg) > 100 {
                msg = msg[:100]
            }
            return entry.Service + ":" + msg, nil
        }).
        // Stage 5: Window into 10-second tumbling windows for aggregation
        WindowWithTime(rxgo.WithDuration(10*time.Second)).
        // Stage 6: Aggregate errors within each window
        FlatMap(func(i rxgo.Item) rxgo.Observable {
            if i.Error() {
                return rxgo.Thrown(i.E)
            }
            window, ok := i.V.(rxgo.Observable)
            if !ok {
                return rxgo.Empty()
            }
            return p.aggregateWindow(window)
        }, rxgo.WithPool(2)).
        // Stage 7: Filter for alert-worthy aggregations
        Filter(func(i interface{}) bool {
            agg, ok := i.(AggregatedError)
            return ok && agg.Count >= 5 // Alert if 5+ same errors in a window
        })

    // Subscribe and handle output
    for item := range pipeline.Observe(rxgo.WithContext(ctx)) {
        if item.Error() {
            p.logger.Error("pipeline error", "error", item.E)
            continue
        }

        agg, ok := item.V.(AggregatedError)
        if !ok {
            continue
        }

        // Send to metrics
        select {
        case p.metricsCh <- agg:
        default:
            p.logger.Warn("metrics channel full, dropping aggregation")
        }

        // Send alert if threshold exceeded
        if agg.Count >= 10 {
            p.alertChan <- Alert{
                Severity:  "critical",
                Service:   agg.Service,
                Message:   fmt.Sprintf("%d errors of type %s in 10s window", agg.Count, agg.ErrorType),
                Count:     agg.Count,
                Timestamp: time.Now(),
            }
        }
    }

    return ctx.Err()
}

var logPattern = regexp.MustCompile(
    `^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[Z\+\-\d:]*)\s+` +
        `(DEBUG|INFO|WARN|ERROR|FATAL)\s+` +
        `\[([^\]]+)\]\s+(.+)$`,
)

func (p *LogProcessingPipeline) parseLogEntry(_ context.Context, i interface{}) (interface{}, error) {
    raw, ok := i.(RawLogEntry)
    if !ok {
        return nil, fmt.Errorf("expected RawLogEntry, got %T", i)
    }

    entry := ParsedLogEntry{
        Timestamp: raw.Timestamp,
        Labels:    make(map[string]string),
    }

    // Try structured JSON first
    if strings.HasPrefix(raw.RawMessage, "{") {
        var structured map[string]interface{}
        if err := json.Unmarshal([]byte(raw.RawMessage), &structured); err == nil {
            entry.Service = raw.Source
            if lvl, ok := structured["level"].(string); ok {
                entry.Level = LogLevel(strings.ToUpper(lvl))
            }
            if msg, ok := structured["message"].(string); ok {
                entry.Message = msg
            }
            if traceID, ok := structured["trace_id"].(string); ok {
                entry.TraceID = traceID
            }
            if errMsg, ok := structured["error"].(string); ok {
                entry.Error = errMsg
            }
            if status, ok := structured["status_code"].(float64); ok {
                entry.StatusCode = int(status)
            }
            return entry, nil
        }
    }

    // Fall back to regex parsing
    matches := logPattern.FindStringSubmatch(raw.RawMessage)
    if matches == nil {
        // Non-standard format: preserve as INFO
        entry.Level = LogLevelInfo
        entry.Service = raw.Source
        entry.Message = raw.RawMessage
        return entry, nil
    }

    ts, err := time.Parse(time.RFC3339, matches[1])
    if err != nil {
        ts = raw.Timestamp
    }

    entry.Timestamp = ts
    entry.Level = LogLevel(matches[2])
    entry.Service = matches[3]
    entry.Message = matches[4]

    return entry, nil
}

func (p *LogProcessingPipeline) isRelevantEntry(i interface{}) bool {
    entry, ok := i.(ParsedLogEntry)
    if !ok {
        return false
    }

    switch entry.Level {
    case LogLevelError, LogLevelFatal:
        return true
    case LogLevelWarn:
        // Only include warnings that indicate potential errors
        return strings.Contains(entry.Message, "timeout") ||
            strings.Contains(entry.Message, "retry") ||
            strings.Contains(entry.Message, "circuit")
    default:
        return false
    }
}

func (p *LogProcessingPipeline) enrichEntry(_ context.Context, i interface{}) (interface{}, error) {
    entry, ok := i.(ParsedLogEntry)
    if !ok {
        return nil, fmt.Errorf("expected ParsedLogEntry, got %T", i)
    }

    // Add environment labels
    entry.Labels["environment"] = "production"
    entry.Labels["cluster"] = "us-east-1"

    // Classify error type from message
    entry.Labels["error_type"] = classifyError(entry.Error + " " + entry.Message)

    return entry, nil
}

func classifyError(msg string) string {
    msg = strings.ToLower(msg)
    switch {
    case strings.Contains(msg, "connection refused") || strings.Contains(msg, "dial tcp"):
        return "connection_error"
    case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded"):
        return "timeout"
    case strings.Contains(msg, "out of memory") || strings.Contains(msg, "oom"):
        return "oom"
    case strings.Contains(msg, "permission denied") || strings.Contains(msg, "forbidden"):
        return "permission_denied"
    case strings.Contains(msg, "not found") || strings.Contains(msg, "404"):
        return "not_found"
    default:
        return "unknown"
    }
}

func (p *LogProcessingPipeline) aggregateWindow(window rxgo.Observable) rxgo.Observable {
    return rxgo.Create([]rxgo.Producer{func(ctx context.Context, next chan<- rxgo.Item) {
        counts := make(map[string]*AggregatedError)

        for item := range window.Observe(rxgo.WithContext(ctx)) {
            if item.Error() {
                continue
            }
            entry, ok := item.V.(ParsedLogEntry)
            if !ok {
                continue
            }

            key := entry.Service + ":" + entry.Labels["error_type"]
            if agg, exists := counts[key]; exists {
                agg.Count++
                agg.LastSeen = entry.Timestamp
            } else {
                counts[key] = &AggregatedError{
                    Service:   entry.Service,
                    ErrorType: entry.Labels["error_type"],
                    Count:     1,
                    FirstSeen: entry.Timestamp,
                    LastSeen:  entry.Timestamp,
                    SampleMsg: entry.Message,
                }
            }
        }

        for _, agg := range counts {
            next <- rxgo.Of(*agg)
        }
    }})
}
```

## Section 4: Kafka Source Observable

```go
// pipeline/kafka_source.go
package pipeline

import (
    "context"
    "time"

    "github.com/IBM/sarama"
    rxgo "github.com/reactivex/rxgo/v2"
)

// KafkaObservable creates an Observable from a Kafka consumer group.
func KafkaObservable(
    ctx context.Context,
    brokers []string,
    topic string,
    groupID string,
    bufferSize int,
) (rxgo.Observable, error) {
    config := sarama.NewConfig()
    config.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
        sarama.NewBalanceStrategyRoundRobin(),
    }
    config.Consumer.Offsets.Initial = sarama.OffsetNewest
    config.Consumer.Return.Errors = true
    config.Version = sarama.V2_8_0_0

    consumer, err := sarama.NewConsumerGroup(brokers, groupID, config)
    if err != nil {
        return nil, err
    }

    ch := make(chan rxgo.Item, bufferSize)

    handler := &consumerGroupHandler{output: ch}

    go func() {
        defer close(ch)
        defer consumer.Close()

        for {
            select {
            case <-ctx.Done():
                return
            default:
            }

            if err := consumer.Consume(ctx, []string{topic}, handler); err != nil {
                ch <- rxgo.Error(err)
                return
            }
        }
    }()

    // Monitor consumer errors
    go func() {
        for err := range consumer.Errors() {
            ch <- rxgo.Error(err)
        }
    }()

    return rxgo.FromChannel(ch,
        rxgo.WithBackPressureStrategy(rxgo.Block),
    ), nil
}

type consumerGroupHandler struct {
    output chan<- rxgo.Item
}

func (h *consumerGroupHandler) Setup(_ sarama.ConsumerGroupSession) error   { return nil }
func (h *consumerGroupHandler) Cleanup(_ sarama.ConsumerGroupSession) error { return nil }

func (h *consumerGroupHandler) ConsumeClaim(
    session sarama.ConsumerGroupSession,
    claim sarama.ConsumerGroupClaim,
) error {
    for msg := range claim.Messages() {
        entry := RawLogEntry{
            Timestamp:   msg.Timestamp,
            RawMessage:  string(msg.Value),
            Source:      string(msg.Key),
            PartitionID: int(msg.Partition),
            Offset:      msg.Offset,
        }

        h.output <- rxgo.Of(entry)
        session.MarkMessage(msg, "")
    }
    return nil
}
```

## Section 5: Advanced Operators

### Retry with Exponential Backoff

```go
// Retry failed HTTP calls with exponential backoff
func buildHTTPEnrichmentPipeline(observable rxgo.Observable) rxgo.Observable {
    return observable.
        Map(func(ctx context.Context, i interface{}) (interface{}, error) {
            entry, ok := i.(ParsedLogEntry)
            if !ok {
                return nil, fmt.Errorf("unexpected type")
            }
            return enrichWithHTTP(ctx, entry)
        },
            // Retry up to 3 times with backoff
            rxgo.WithErrorStrategy(rxgo.ContinueOnError),
        ).
        Retry(3, func(err error) bool {
            // Only retry on transient errors
            return isTransientError(err)
        })
}

func isTransientError(err error) bool {
    errMsg := err.Error()
    return strings.Contains(errMsg, "timeout") ||
        strings.Contains(errMsg, "connection refused") ||
        strings.Contains(errMsg, "503")
}
```

### Debounce for Noisy Streams

```go
// Debounce: only emit an item if no new item arrived within 500ms
// Useful for configuration change events
func buildConfigChangeObservable(rawChanges rxgo.Observable) rxgo.Observable {
    return rawChanges.
        Debounce(rxgo.WithDuration(500*time.Millisecond)).
        Map(func(_ context.Context, i interface{}) (interface{}, error) {
            change, ok := i.(ConfigChange)
            if !ok {
                return nil, fmt.Errorf("unexpected type")
            }
            return applyConfigChange(change)
        })
}
```

### Merge Multiple Streams

```go
// Merge log streams from multiple Kafka topics
func mergeLogStreams(ctx context.Context, topics []string, brokers []string) rxgo.Observable {
    streams := make([]rxgo.Observable, 0, len(topics))

    for _, topic := range topics {
        stream, err := KafkaObservable(ctx, brokers, topic, "log-processor-"+topic, 1000)
        if err != nil {
            // Return an observable that immediately emits the error
            streams = append(streams, rxgo.Thrown(err))
            continue
        }
        streams = append(streams, stream)
    }

    return rxgo.Merge(streams)
}
```

### FlatMap for Concurrent Processing

```go
// FlatMap allows concurrent processing: each item spawns a new Observable
// The results are merged as they complete (not necessarily in order)
func buildConcurrentEnrichmentPipeline(observable rxgo.Observable) rxgo.Observable {
    return observable.FlatMap(
        func(item rxgo.Item) rxgo.Observable {
            if item.Error() {
                return rxgo.Thrown(item.E)
            }

            entry, ok := item.V.(ParsedLogEntry)
            if !ok {
                return rxgo.Thrown(fmt.Errorf("unexpected type: %T", item.V))
            }

            // Each entry spawns its own Observable for async enrichment
            return rxgo.Defer([]rxgo.Producer{
                func(ctx context.Context, next chan<- rxgo.Item) {
                    enriched, err := enrichWithHTTP(ctx, entry)
                    if err != nil {
                        next <- rxgo.Error(err)
                        return
                    }
                    next <- rxgo.Of(enriched)
                },
            })
        },
        // Control concurrency: at most 10 concurrent enrichment calls
        rxgo.WithPool(10),
    )
}
```

### Backpressure Strategies

```go
// RxGo supports two backpressure strategies:
// 1. rxgo.Block: slow down the producer if the consumer can't keep up
// 2. rxgo.Drop: drop items if the buffer is full (lossy)

// For log processing where we cannot block Kafka consumption:
observable = rxgo.FromChannel(ch,
    rxgo.WithBackPressureStrategy(rxgo.Drop),
    rxgo.WithBufferedChannel(10000),
)

// For financial data where we must not lose items:
observable = rxgo.FromChannel(ch,
    rxgo.WithBackPressureStrategy(rxgo.Block),
    rxgo.WithBufferedChannel(1000),
)
```

## Section 6: Testing Reactive Pipelines

Testing reactive pipelines requires careful control over time and item emission.

```go
// pipeline/pipeline_test.go
package pipeline_test

import (
    "context"
    "testing"
    "time"

    rxgo "github.com/reactivex/rxgo/v2"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestLogPipelineFiltersDebugEntries(t *testing.T) {
    input := []interface{}{
        RawLogEntry{
            Timestamp:  time.Now(),
            RawMessage: `{"level":"debug","message":"connection pool initialized","service":"api"}`,
            Source:     "api",
        },
        RawLogEntry{
            Timestamp:  time.Now(),
            RawMessage: `{"level":"error","message":"database connection failed","error":"dial tcp: connection refused","service":"api"}`,
            Source:     "api",
        },
        RawLogEntry{
            Timestamp:  time.Now(),
            RawMessage: `{"level":"info","message":"request processed","service":"api"}`,
            Source:     "api",
        },
        RawLogEntry{
            Timestamp:  time.Now(),
            RawMessage: `{"level":"error","message":"timeout calling payment service","service":"checkout"}`,
            Source:     "checkout",
        },
    }

    source := rxgo.Just(input[0], input[1], input[2], input[3])()

    alertCh := make(chan Alert, 10)
    metricsCh := make(chan AggregatedError, 10)

    pipeline := NewLogProcessingPipeline(nil, alertCh, metricsCh)

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // Collect all items from the pipeline
    var results []AggregatedError
    errCh := make(chan error, 1)

    go func() {
        errCh <- pipeline.Run(ctx, source)
    }()

    // Wait for pipeline to complete or timeout
    select {
    case <-errCh:
    case <-ctx.Done():
        t.Fatal("pipeline timed out")
    }

    // Drain metrics channel
    close(metricsCh)
    for agg := range metricsCh {
        results = append(results, agg)
    }

    // Only error entries should produce aggregations
    assert.True(t, len(results) > 0, "expected at least one aggregated error")

    // Verify error classification
    for _, r := range results {
        assert.NotEmpty(t, r.Service)
        assert.NotEmpty(t, r.ErrorType)
        t.Logf("Service: %s, ErrorType: %s, Count: %d", r.Service, r.ErrorType, r.Count)
    }
}

func TestParseStructuredJSON(t *testing.T) {
    p := &LogProcessingPipeline{}

    raw := RawLogEntry{
        Timestamp:  time.Now(),
        RawMessage: `{"level":"error","message":"disk full","error":"no space left on device","service":"storage","trace_id":"abc123","status_code":500}`,
        Source:     "storage",
    }

    result, err := p.parseLogEntry(context.Background(), raw)
    require.NoError(t, err)

    entry, ok := result.(ParsedLogEntry)
    require.True(t, ok)

    assert.Equal(t, LogLevelError, entry.Level)
    assert.Equal(t, "storage", entry.Service)
    assert.Equal(t, "abc123", entry.TraceID)
    assert.Equal(t, 500, entry.StatusCode)
    assert.Equal(t, "no space left on device", entry.Error)
}

// TestObservableOperators tests the behavior of individual operators
func TestWindowAggregation(t *testing.T) {
    entries := []interface{}{
        ParsedLogEntry{Service: "api", Level: LogLevelError, Error: "timeout", Labels: map[string]string{"error_type": "timeout"}},
        ParsedLogEntry{Service: "api", Level: LogLevelError, Error: "timeout", Labels: map[string]string{"error_type": "timeout"}},
        ParsedLogEntry{Service: "api", Level: LogLevelError, Error: "timeout", Labels: map[string]string{"error_type": "timeout"}},
        ParsedLogEntry{Service: "db", Level: LogLevelError, Error: "connection refused", Labels: map[string]string{"error_type": "connection_error"}},
    }

    source := rxgo.Just(entries[0], entries[1], entries[2], entries[3])()

    p := &LogProcessingPipeline{}
    agg := p.aggregateWindow(source)

    var results []AggregatedError
    for item := range agg.Observe() {
        if item.Error() {
            t.Fatalf("unexpected error: %v", item.E)
        }
        results = append(results, item.V.(AggregatedError))
    }

    // Should have 2 aggregations: api:timeout (count=3) and db:connection_error (count=1)
    require.Len(t, results, 2)

    counts := make(map[string]int)
    for _, r := range results {
        counts[r.Service+":"+r.ErrorType] = r.Count
    }

    assert.Equal(t, 3, counts["api:timeout"])
    assert.Equal(t, 1, counts["db:connection_error"])
}
```

## Section 7: Complete Main Application

```go
// cmd/log-processor/main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/your-org/log-processor/pipeline"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Handle shutdown signals
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    go func() {
        <-sigCh
        logger.Info("shutdown signal received")
        cancel()
    }()

    // Create output channels
    alertCh := make(chan pipeline.Alert, 100)
    metricsCh := make(chan pipeline.AggregatedError, 1000)

    // Start alert handler
    go handleAlerts(ctx, alertCh, logger)

    // Start metrics handler
    go handleMetrics(ctx, metricsCh, logger)

    // Create Kafka source
    brokers := []string{"kafka-1:9092", "kafka-2:9092", "kafka-3:9092"}
    topics := []string{"app-logs", "service-logs", "infra-logs"}

    source := pipeline.MergeLogStreams(ctx, topics, brokers)

    // Run pipeline
    p := pipeline.NewLogProcessingPipeline(logger, alertCh, metricsCh)

    logger.Info("log processing pipeline starting")
    if err := p.Run(ctx, source); err != nil && err != context.Canceled {
        logger.Error("pipeline failed", "error", err)
        os.Exit(1)
    }

    logger.Info("log processing pipeline stopped")
}

func handleAlerts(ctx context.Context, alerts <-chan pipeline.Alert, logger *slog.Logger) {
    for {
        select {
        case <-ctx.Done():
            return
        case alert, ok := <-alerts:
            if !ok {
                return
            }
            logger.Warn("alert generated",
                "severity", alert.Severity,
                "service", alert.Service,
                "message", alert.Message,
                "count", alert.Count,
            )
            // Send to PagerDuty, Slack, etc.
        }
    }
}

func handleMetrics(ctx context.Context, metrics <-chan pipeline.AggregatedError, logger *slog.Logger) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    window := make(map[string]int)

    for {
        select {
        case <-ctx.Done():
            return
        case agg, ok := <-metrics:
            if !ok {
                return
            }
            key := agg.Service + ":" + agg.ErrorType
            window[key] += agg.Count
        case <-ticker.C:
            // Emit window metrics to Prometheus/StatsD
            for key, count := range window {
                logger.Info("error window metric", "key", key, "count", count)
            }
            window = make(map[string]int)
        }
    }
}
```

## Section 8: Performance Tuning

### Observable Pool Sizing

The `WithPool(n)` option controls how many goroutines process items concurrently in a Map or FlatMap operator. The optimal pool size depends on the workload type:

- **CPU-bound work** (parsing, compression): `runtime.GOMAXPROCS(0)` goroutines.
- **I/O-bound work** (HTTP calls, database queries): 10-100x CPU count.
- **Use `WithCPUPool()`** for CPU-bound work to automatically use `GOMAXPROCS`.

```go
// CPU-bound parsing: use CPU pool
observable.Map(parseFn, rxgo.WithCPUPool())

// I/O-bound HTTP enrichment: use fixed pool
observable.FlatMap(enrichFn, rxgo.WithPool(50))
```

### Buffer Sizes

```go
// Input buffer: large enough to absorb Kafka consumer burst
source := rxgo.FromChannel(ch, rxgo.WithBufferedChannel(10000))

// Inter-stage buffer: 1000 is typically sufficient
processed := source.Map(parseFn, rxgo.WithBufferedChannel(1000))
```

### Avoiding Allocations in Hot Paths

```go
// Pool ParsedLogEntry structs to reduce GC pressure in high-throughput pipelines
var entryPool = sync.Pool{
    New: func() interface{} {
        return &ParsedLogEntry{
            Labels: make(map[string]string, 8),
        }
    },
}

func (p *LogProcessingPipeline) parseLogEntry(_ context.Context, i interface{}) (interface{}, error) {
    entry := entryPool.Get().(*ParsedLogEntry)
    // Reset all fields
    *entry = ParsedLogEntry{Labels: entry.Labels}
    for k := range entry.Labels {
        delete(entry.Labels, k)
    }
    // ... populate fields ...
    return *entry, nil
    // Note: return by value so pool can reclaim the pointer
}
```

## Conclusion

RxGo brings the expressive power of ReactiveX to Go, enabling complex event processing pipelines that would require significantly more boilerplate with raw channels and goroutines. The operator model — Map, Filter, FlatMap, Window, Merge, Retry, Debounce — composes naturally and produces readable, testable pipeline code. The key to effective use of RxGo in production is understanding the backpressure model, sizing pools correctly for CPU vs I/O workloads, using the error continuation strategy for fault-tolerant pipelines, and testing each pipeline stage in isolation. Combined with a Kafka source and Prometheus metrics, the patterns in this guide provide a complete foundation for building high-throughput, reactive event processing systems in Go.
