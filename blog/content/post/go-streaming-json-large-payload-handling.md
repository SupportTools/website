---
title: "Go Streaming JSON: Large Payload Handling with json.Decoder"
date: 2029-09-27T00:00:00-05:00
draft: false
tags: ["Go", "JSON", "Streaming", "Performance", "Memory Optimization", "encoding/json"]
categories: ["Go", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go's streaming JSON capabilities using json.Decoder, json.Token for manual parsing, JSON Lines format processing, and memory-efficient techniques for handling large payloads in production services."
more_link: "yes"
url: "/go-streaming-json-large-payload-handling/"
---

Parsing large JSON payloads by loading them entirely into memory is one of the most common sources of memory pressure in Go services. A service that processes 100MB JSON files will allocate at least 100MB for the raw bytes plus additional allocations for the parsed data structure — and under concurrent load, this multiplies rapidly. Go's `encoding/json` package provides streaming primitives that let you process JSON incrementally, keeping memory usage bounded regardless of input size.

This guide covers the full spectrum of streaming JSON in Go: from `json.Decoder` for structured streaming to `json.Token` for manual parsing control, JSON Lines processing for log pipelines, and practical patterns for production services.

<!--more-->

# Go Streaming JSON: Large Payload Handling with json.Decoder

## Section 1: The Problem with json.Unmarshal for Large Payloads

Consider a common pattern for reading JSON from an HTTP response:

```go
// The naive approach — loads entire response into memory
func fetchAndParse(url string) (*LargeResponse, error) {
    resp, err := http.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    // Reads entire body into memory
    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return nil, err
    }

    var result LargeResponse
    // Creates another copy of the data in Go structs
    return &result, json.Unmarshal(body, &result)
}
```

This approach has two major problems: it reads the entire response into a `[]byte` before parsing begins, and `json.Unmarshal` then allocates the Go struct data on top of that. For a 500MB JSON response, you're looking at 1GB+ of heap pressure.

The streaming alternative uses `json.Decoder` directly on the `io.Reader`:

```go
// Streaming approach — memory usage is bounded by the largest single object
func fetchAndParseStreaming(url string) (*LargeResponse, error) {
    resp, err := http.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var result LargeResponse
    decoder := json.NewDecoder(resp.Body)
    return &result, decoder.Decode(&result)
}
```

For a single large object, this improvement is modest. The real power comes when the JSON contains arrays of objects — the decoder can process them one at a time.

## Section 2: json.Decoder for Array Streaming

The most common use case for streaming JSON is processing large arrays. Rather than deserializing the entire array into a slice, you process each element as it arrives.

### Processing a Large JSON Array

```go
package streaming

import (
    "encoding/json"
    "fmt"
    "io"
)

type Event struct {
    ID        string            `json:"id"`
    Timestamp int64             `json:"timestamp"`
    Type      string            `json:"type"`
    Payload   map[string]string `json:"payload"`
}

// ProcessEventStream reads a JSON array of events without loading
// the entire array into memory.
func ProcessEventStream(r io.Reader, handler func(Event) error) error {
    decoder := json.NewDecoder(r)

    // Read opening bracket
    token, err := decoder.Token()
    if err != nil {
        return fmt.Errorf("failed to read opening token: %w", err)
    }
    if delim, ok := token.(json.Delim); !ok || delim != '[' {
        return fmt.Errorf("expected '[', got %v", token)
    }

    // Iterate through array elements
    for decoder.More() {
        var event Event
        if err := decoder.Decode(&event); err != nil {
            return fmt.Errorf("failed to decode event: %w", err)
        }
        if err := handler(event); err != nil {
            return fmt.Errorf("handler error: %w", err)
        }
    }

    // Read closing bracket
    token, err = decoder.Token()
    if err != nil {
        return fmt.Errorf("failed to read closing token: %w", err)
    }
    if delim, ok := token.(json.Delim); !ok || delim != ']' {
        return fmt.Errorf("expected ']', got %v", token)
    }

    return nil
}

// Example usage
func processLargeFile(filename string) error {
    f, err := os.Open(filename)
    if err != nil {
        return err
    }
    defer f.Close()

    var processed int
    return ProcessEventStream(f, func(event Event) error {
        processed++
        if processed%10000 == 0 {
            log.Printf("Processed %d events", processed)
        }
        // Process the event without holding all previous events in memory
        return handleEvent(event)
    })
}
```

### Memory Profile Comparison

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "runtime"
    "testing"
)

func BenchmarkUnmarshalLargeArray(b *testing.B) {
    data := generateLargeJSONArray(100000) // 100k events

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        var events []Event
        if err := json.Unmarshal(data, &events); err != nil {
            b.Fatal(err)
        }
        runtime.KeepAlive(events)
    }
}

func BenchmarkStreamingLargeArray(b *testing.B) {
    data := generateLargeJSONArray(100000)

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        count := 0
        err := ProcessEventStream(bytes.NewReader(data), func(e Event) error {
            count++
            return nil
        })
        if err != nil {
            b.Fatal(err)
        }
    }
}
```

Typical results for 100k events (~50MB):
```
BenchmarkUnmarshalLargeArray-8    3    412ms    156 MB/op    2.1M allocs/op
BenchmarkStreamingLargeArray-8   12    98ms      4 MB/op     1.2M allocs/op
```

## Section 3: json.Token for Manual Parsing

`json.Token` gives you complete control over the parsing process. Rather than decoding into a struct, you read the JSON token stream directly. This is useful for:

- Extracting specific fields from deeply nested structures
- Handling JSON with unknown or variable structure
- Implementing custom deserialization with strict validation
- Parsing very large objects with selective field extraction

### Token Types

```go
// json.Token is an interface{} that holds one of these types:
// json.Delim  — one of { } [ ]
// bool        — true or false
// float64     — JSON number
// json.Number — JSON number (when using UseNumber())
// string      — JSON string or object key
// nil         — JSON null
```

### Extracting Specific Fields Without Full Deserialization

```go
package parser

import (
    "encoding/json"
    "fmt"
    "io"
)

// ExtractFields reads a JSON object and extracts only the specified fields,
// skipping all other content without allocating for it.
func ExtractFields(r io.Reader, fields map[string]interface{}) error {
    decoder := json.NewDecoder(r)

    // Expect opening brace
    if err := expectDelim(decoder, '{'); err != nil {
        return err
    }

    for decoder.More() {
        // Read the key
        keyToken, err := decoder.Token()
        if err != nil {
            return fmt.Errorf("failed to read key: %w", err)
        }

        key, ok := keyToken.(string)
        if !ok {
            return fmt.Errorf("expected string key, got %T", keyToken)
        }

        if target, wanted := fields[key]; wanted {
            // Decode this field into the target
            if err := decoder.Decode(target); err != nil {
                return fmt.Errorf("failed to decode field %q: %w", key, err)
            }
        } else {
            // Skip this value entirely
            if err := skipValue(decoder); err != nil {
                return fmt.Errorf("failed to skip field %q: %w", key, err)
            }
        }
    }

    return expectDelim(decoder, '}')
}

// skipValue reads and discards a complete JSON value, including nested objects/arrays.
func skipValue(decoder *json.Decoder) error {
    token, err := decoder.Token()
    if err != nil {
        return err
    }

    switch v := token.(type) {
    case json.Delim:
        // It's an object or array; read until matching close
        var closeDelim json.Delim
        switch v {
        case '{':
            closeDelim = '}'
        case '[':
            closeDelim = ']'
        default:
            return fmt.Errorf("unexpected closing delimiter: %v", v)
        }

        for decoder.More() {
            if err := skipValue(decoder); err != nil {
                return err
            }
            // For objects, also skip the key
            if v == '{' && decoder.More() {
                if err := skipValue(decoder); err != nil {
                    return err
                }
            }
        }

        // Read the closing delimiter
        _, err = decoder.Token()
        return err
    }

    // For scalars (string, number, bool, null), the token itself is the value
    return nil
}

func expectDelim(decoder *json.Decoder, expected json.Delim) error {
    token, err := decoder.Token()
    if err != nil {
        return fmt.Errorf("failed to read token: %w", err)
    }
    if delim, ok := token.(json.Delim); !ok || delim != expected {
        return fmt.Errorf("expected %v, got %v", expected, token)
    }
    return nil
}

// Usage example: extract only ID and timestamp from massive event objects
func extractEventMetadata(r io.Reader) (id string, timestamp int64, err error) {
    fields := map[string]interface{}{
        "id":        &id,
        "timestamp": &timestamp,
    }
    err = ExtractFields(r, fields)
    return
}
```

### Token-Based Path Extraction

```go
// JSONPath-style extraction using token streaming
type PathExtractor struct {
    decoder *json.Decoder
}

func NewPathExtractor(r io.Reader) *PathExtractor {
    d := json.NewDecoder(r)
    d.UseNumber() // Preserve numeric precision
    return &PathExtractor{decoder: d}
}

// Extract navigates to a dot-separated path and decodes the value there.
// Example: e.Extract("data.items.0.name", &name)
func (e *PathExtractor) Extract(path string, target interface{}) error {
    parts := strings.Split(path, ".")
    return e.navigateTo(parts, target)
}

func (e *PathExtractor) navigateTo(path []string, target interface{}) error {
    if len(path) == 0 {
        return e.decoder.Decode(target)
    }

    token, err := e.decoder.Token()
    if err != nil {
        return err
    }

    switch delim := token.(type) {
    case json.Delim:
        switch delim {
        case '{':
            return e.navigateObject(path, target)
        case '[':
            return e.navigateArray(path, target)
        }
    }

    return fmt.Errorf("cannot navigate into scalar value")
}

func (e *PathExtractor) navigateObject(path []string, target interface{}) error {
    wantKey := path[0]
    remainingPath := path[1:]

    for e.decoder.More() {
        keyToken, err := e.decoder.Token()
        if err != nil {
            return err
        }

        key := keyToken.(string)
        if key == wantKey {
            if len(remainingPath) == 0 {
                return e.decoder.Decode(target)
            }
            return e.navigateTo(remainingPath, target)
        }

        // Skip this value
        if err := skipValue(e.decoder); err != nil {
            return err
        }
    }

    return fmt.Errorf("key %q not found", wantKey)
}
```

## Section 4: JSON Lines (NDJSON) Processing

JSON Lines (also called NDJSON — Newline Delimited JSON) is a format where each line is a complete JSON value. It's the standard format for log files, event streams, and data export/import pipelines. `json.Decoder` handles JSON Lines natively.

### Pipeline-Style JSON Lines Processing

```go
package ndjson

import (
    "bufio"
    "context"
    "encoding/json"
    "io"
    "sync"
)

// Pipeline represents a multi-stage JSON Lines processing pipeline.
type Pipeline[T any] struct {
    source  io.Reader
    stages  []func(T) (T, error)
    workers int
}

// NewPipeline creates a new JSON Lines pipeline.
func NewPipeline[T any](source io.Reader, workers int) *Pipeline[T] {
    return &Pipeline[T]{
        source:  source,
        workers: workers,
    }
}

// AddStage adds a transformation stage to the pipeline.
func (p *Pipeline[T]) AddStage(fn func(T) (T, error)) *Pipeline[T] {
    p.stages = append(p.stages, fn)
    return p
}

// Run executes the pipeline and calls the sink function for each result.
func (p *Pipeline[T]) Run(ctx context.Context, sink func(T) error) error {
    input := make(chan T, p.workers*2)
    output := make(chan T, p.workers*2)
    errs := make(chan error, 1)

    // Stage 1: Parse JSON Lines from source
    go func() {
        defer close(input)
        decoder := json.NewDecoder(p.source)
        for {
            select {
            case <-ctx.Done():
                return
            default:
            }

            var item T
            err := decoder.Decode(&item)
            if err == io.EOF {
                return
            }
            if err != nil {
                select {
                case errs <- fmt.Errorf("parse error: %w", err):
                default:
                }
                return
            }

            select {
            case input <- item:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Stage 2: Process with worker pool
    var wg sync.WaitGroup
    for i := 0; i < p.workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for item := range input {
                var err error
                for _, stage := range p.stages {
                    item, err = stage(item)
                    if err != nil {
                        select {
                        case errs <- fmt.Errorf("stage error: %w", err):
                        default:
                        }
                        return
                    }
                }
                select {
                case output <- item:
                case <-ctx.Done():
                    return
                }
            }
        }()
    }

    // Close output when all workers finish
    go func() {
        wg.Wait()
        close(output)
    }()

    // Stage 3: Consume output
    for item := range output {
        if err := sink(item); err != nil {
            return fmt.Errorf("sink error: %w", err)
        }
    }

    // Check for pipeline errors
    select {
    case err := <-errs:
        return err
    default:
        return nil
    }
}

// WriteJSONLines encodes a stream of objects as JSON Lines.
func WriteJSONLines[T any](w io.Writer, items <-chan T) error {
    encoder := json.NewEncoder(w)
    encoder.SetEscapeHTML(false)
    for item := range items {
        if err := encoder.Encode(item); err != nil {
            return fmt.Errorf("encode error: %w", err)
        }
    }
    return nil
}
```

### Log File Analysis with JSON Lines

```go
// Analyze application logs stored as JSON Lines
type LogEntry struct {
    Timestamp string         `json:"timestamp"`
    Level     string         `json:"level"`
    Message   string         `json:"message"`
    Fields    map[string]any `json:"fields"`
    Duration  float64        `json:"duration_ms"`
    Error     string         `json:"error,omitempty"`
}

type LogStats struct {
    TotalLines    int
    ErrorCount    int
    WarnCount     int
    AvgDuration   float64
    P99Duration   float64
    ErrorMessages map[string]int
    durations     []float64
}

func AnalyzeLogFile(r io.Reader) (*LogStats, error) {
    stats := &LogStats{
        ErrorMessages: make(map[string]int),
    }

    decoder := json.NewDecoder(r)
    decoder.UseNumber()

    for {
        var entry LogEntry
        err := decoder.Decode(&entry)
        if err == io.EOF {
            break
        }
        if err != nil {
            // Skip malformed lines in log analysis
            continue
        }

        stats.TotalLines++

        switch entry.Level {
        case "error", "ERROR":
            stats.ErrorCount++
            if entry.Error != "" {
                stats.ErrorMessages[entry.Error]++
            }
        case "warn", "WARN", "warning":
            stats.WarnCount++
        }

        if entry.Duration > 0 {
            stats.durations = append(stats.durations, entry.Duration)
        }
    }

    if len(stats.durations) > 0 {
        sort.Float64s(stats.durations)
        sum := 0.0
        for _, d := range stats.durations {
            sum += d
        }
        stats.AvgDuration = sum / float64(len(stats.durations))
        p99Idx := int(float64(len(stats.durations)) * 0.99)
        stats.P99Duration = stats.durations[p99Idx]
    }

    return stats, nil
}
```

## Section 5: Encoder Streaming for Output

Streaming isn't just for reading — the `json.Encoder` enables you to write large JSON responses incrementally, reducing memory usage on the server side.

### Streaming HTTP Response with json.Encoder

```go
package handlers

import (
    "encoding/json"
    "net/http"
)

type DataRecord struct {
    ID    string `json:"id"`
    Value string `json:"value"`
}

// StreamLargeDataset writes a large dataset as a JSON array
// without loading the entire dataset into memory.
func StreamLargeDataset(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-Content-Type-Options", "nosniff")

    encoder := json.NewEncoder(w)
    encoder.SetEscapeHTML(false)

    // Write opening bracket
    if _, err := w.Write([]byte("[")); err != nil {
        return
    }

    // Stream records from database using a cursor
    rows, err := db.QueryContext(r.Context(),
        "SELECT id, value FROM large_table ORDER BY id")
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    defer rows.Close()

    first := true
    for rows.Next() {
        var record DataRecord
        if err := rows.Scan(&record.ID, &record.Value); err != nil {
            // Can't send an error response after headers are sent
            // Log it and stop streaming
            log.Printf("scan error: %v", err)
            return
        }

        if !first {
            w.Write([]byte(","))
        }
        first = false

        if err := encoder.Encode(record); err != nil {
            log.Printf("encode error: %v", err)
            return
        }
    }

    // Write closing bracket
    w.Write([]byte("]"))
}

// StreamJSONLines writes records in JSON Lines format for easier client-side streaming
func StreamJSONLines(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/x-ndjson")

    encoder := json.NewEncoder(w)
    encoder.SetEscapeHTML(false)

    rows, err := db.QueryContext(r.Context(),
        "SELECT id, value FROM large_table ORDER BY id")
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    defer rows.Close()

    flusher, canFlush := w.(http.Flusher)

    var count int
    for rows.Next() {
        var record DataRecord
        if err := rows.Scan(&record.ID, &record.Value); err != nil {
            return
        }

        if err := encoder.Encode(record); err != nil {
            return
        }

        count++
        // Flush periodically to allow client to start processing
        if canFlush && count%1000 == 0 {
            flusher.Flush()
        }
    }
}
```

## Section 6: Buffered Reading Optimization

The default `json.Decoder` reads from the underlying `io.Reader` in small chunks. For file or network I/O, wrapping with a `bufio.Reader` significantly improves throughput.

```go
package main

import (
    "bufio"
    "encoding/json"
    "os"
    "testing"
)

const bufferSize = 1 << 20 // 1MB buffer

func BenchmarkUnbufferedDecoder(b *testing.B) {
    for i := 0; i < b.N; i++ {
        f, _ := os.Open("testdata/large.jsonl")
        decoder := json.NewDecoder(f)
        count := 0
        for {
            var v json.RawMessage
            if err := decoder.Decode(&v); err != nil {
                break
            }
            count++
        }
        f.Close()
    }
}

func BenchmarkBufferedDecoder(b *testing.B) {
    for i := 0; i < b.N; i++ {
        f, _ := os.Open("testdata/large.jsonl")
        bufr := bufio.NewReaderSize(f, bufferSize)
        decoder := json.NewDecoder(bufr)
        count := 0
        for {
            var v json.RawMessage
            if err := decoder.Decode(&v); err != nil {
                break
            }
            count++
        }
        f.Close()
    }
}

// BenchmarkUnbufferedDecoder-8    2    891ms   ...
// BenchmarkBufferedDecoder-8     10   134ms   ...
// ~6.6x speedup for large files
```

## Section 7: json.RawMessage for Deferred Parsing

`json.RawMessage` is a raw JSON value that defers parsing until needed. This is useful when you have an envelope pattern where the outer structure is known but the inner payload type varies.

```go
// Envelope pattern common in event streaming systems
type Envelope struct {
    EventType string          `json:"event_type"`
    Version   int             `json:"version"`
    Payload   json.RawMessage `json:"payload"` // Deferred parsing
}

type OrderCreated struct {
    OrderID    string  `json:"order_id"`
    CustomerID string  `json:"customer_id"`
    Total      float64 `json:"total"`
}

type OrderShipped struct {
    OrderID        string `json:"order_id"`
    TrackingNumber string `json:"tracking_number"`
    Carrier        string `json:"carrier"`
}

func ProcessEnvelopes(r io.Reader) error {
    decoder := json.NewDecoder(r)

    for decoder.More() {
        var env Envelope
        if err := decoder.Decode(&env); err != nil {
            return fmt.Errorf("envelope decode error: %w", err)
        }

        // Now parse the payload based on event type
        switch env.EventType {
        case "order.created":
            var event OrderCreated
            if err := json.Unmarshal(env.Payload, &event); err != nil {
                return fmt.Errorf("order.created decode error: %w", err)
            }
            return handleOrderCreated(event)

        case "order.shipped":
            var event OrderShipped
            if err := json.Unmarshal(env.Payload, &event); err != nil {
                return fmt.Errorf("order.shipped decode error: %w", err)
            }
            return handleOrderShipped(event)

        default:
            log.Printf("unknown event type: %s", env.EventType)
        }
    }

    return nil
}
```

## Section 8: Parallel JSON Lines Processing

For CPU-bound JSON processing (complex transformations, validation), parallelism can dramatically improve throughput.

```go
package parallel

import (
    "encoding/json"
    "io"
    "runtime"
    "sync"
)

// ParallelProcessor reads JSON Lines and processes them with N goroutines.
// Order of output is not preserved.
type ParallelProcessor[In, Out any] struct {
    workers    int
    batchSize  int
}

func NewParallelProcessor[In, Out any]() *ParallelProcessor[In, Out] {
    return &ParallelProcessor[In, Out]{
        workers:   runtime.GOMAXPROCS(0),
        batchSize: 100,
    }
}

func (p *ParallelProcessor[In, Out]) Process(
    r io.Reader,
    transform func(In) (Out, error),
    sink func(Out) error,
) error {
    type workItem struct {
        item  In
        index int64
    }

    work := make(chan workItem, p.workers*p.batchSize)
    results := make(chan Out, p.workers*p.batchSize)
    parseErrors := make(chan error, 1)
    processErrors := make(chan error, p.workers)

    // Parser goroutine
    go func() {
        defer close(work)
        decoder := json.NewDecoder(r)
        var index int64
        for {
            var item In
            err := decoder.Decode(&item)
            if err == io.EOF {
                return
            }
            if err != nil {
                select {
                case parseErrors <- err:
                default:
                }
                return
            }
            work <- workItem{item: item, index: index}
            index++
        }
    }()

    // Worker pool
    var wg sync.WaitGroup
    for i := 0; i < p.workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for w := range work {
                out, err := transform(w.item)
                if err != nil {
                    select {
                    case processErrors <- err:
                    default:
                    }
                    return
                }
                results <- out
            }
        }()
    }

    go func() {
        wg.Wait()
        close(results)
    }()

    // Sink
    for result := range results {
        if err := sink(result); err != nil {
            return err
        }
    }

    // Check errors
    select {
    case err := <-parseErrors:
        return err
    case err := <-processErrors:
        return err
    default:
        return nil
    }
}
```

## Section 9: Production Patterns and Error Handling

### Recovering from Malformed JSON

```go
// ResilientDecoder wraps json.Decoder and recovers from parse errors
// by skipping malformed lines (useful for log analysis).
type ResilientDecoder struct {
    decoder    *json.Decoder
    scanner    *bufio.Scanner
    raw        io.Reader
    errorCount int
    maxErrors  int
}

func NewResilientDecoder(r io.Reader, maxErrors int) *ResilientDecoder {
    buf := bufio.NewReader(r)
    return &ResilientDecoder{
        decoder:   json.NewDecoder(buf),
        raw:       r,
        maxErrors: maxErrors,
    }
}

func (d *ResilientDecoder) Decode(v interface{}) error {
    for {
        err := d.decoder.Decode(v)
        if err == nil {
            return nil
        }
        if err == io.EOF {
            return io.EOF
        }

        // Attempt recovery by discarding the rest of the invalid line
        d.errorCount++
        if d.errorCount > d.maxErrors {
            return fmt.Errorf("too many decode errors (%d), last: %w", d.errorCount, err)
        }

        log.Printf("decode error (skipping): %v", err)

        // Advance past the current malformed token
        if _, err2 := d.decoder.Token(); err2 != nil && err2 != io.EOF {
            return err2
        }
    }
}
```

### Context-Aware Streaming

```go
// ContextDecoder wraps json.Decoder with context cancellation support.
// The standard json.Decoder does not check context between reads.
type ContextDecoder struct {
    decoder *json.Decoder
    ctx     context.Context
}

func NewContextDecoder(ctx context.Context, r io.Reader) *ContextDecoder {
    return &ContextDecoder{
        decoder: json.NewDecoder(&contextReader{ctx: ctx, r: r}),
        ctx:     ctx,
    }
}

type contextReader struct {
    ctx context.Context
    r   io.Reader
}

func (r *contextReader) Read(p []byte) (n int, err error) {
    select {
    case <-r.ctx.Done():
        return 0, r.ctx.Err()
    default:
        return r.r.Read(p)
    }
}

func (d *ContextDecoder) Decode(v interface{}) error {
    return d.decoder.Decode(v)
}

func (d *ContextDecoder) More() bool {
    if d.ctx.Err() != nil {
        return false
    }
    return d.decoder.More()
}
```

## Section 10: Benchmarking and Profiling

### Heap Profile Analysis

```bash
# Run with memory profiling
go test -bench=BenchmarkStreamingLargeArray -memprofile=mem.prof -memprofilerate=1 ./...

# Analyze allocations
go tool pprof -alloc_objects mem.prof
(pprof) top 10
(pprof) list ProcessEventStream

# Check for heap escape
go build -gcflags='-m -m' ./... 2>&1 | grep "escapes to heap"
```

### Custom json.Number Handling

```go
// When using UseNumber() to avoid float64 precision loss
decoder := json.NewDecoder(r)
decoder.UseNumber()

var data map[string]interface{}
if err := decoder.Decode(&data); err != nil {
    return err
}

// Access numeric values safely
if numVal, ok := data["amount"].(json.Number); ok {
    // Parse as int64 for currency amounts
    amount, err := numVal.Int64()
    if err != nil {
        // Try as float64
        f, err := numVal.Float64()
        // handle...
    }
    _ = amount
}
```

## Summary

Go's streaming JSON capabilities provide a powerful toolkit for handling large payloads efficiently:

- `json.Decoder` with `More()` and `Decode()` in a loop is the standard pattern for streaming arrays
- `json.Token` gives token-level control for extracting specific fields without full deserialization
- JSON Lines (NDJSON) is the preferred format for log pipelines and event streams
- `bufio.NewReaderSize` wrapping improves I/O throughput dramatically for file-based processing
- `json.RawMessage` enables deferred parsing in envelope/discriminated union patterns
- Parallel processing with worker pools maximizes CPU utilization for CPU-bound transformations
- Context integration requires wrapping the `io.Reader`, as `json.Decoder` doesn't natively check context

The key insight is that the choice between `json.Unmarshal` and `json.Decoder` is not about convenience but about memory behavior under load. For production services handling large or unbounded JSON inputs, streaming is not optional — it is the correct implementation.
