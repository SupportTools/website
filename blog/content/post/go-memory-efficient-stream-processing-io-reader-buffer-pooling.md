---
title: "Go Memory-Efficient Stream Processing: io.Reader Chaining, Buffer Pooling, and Zero-Copy Techniques for Large Datasets"
date: 2031-10-07T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Performance", "Memory", "Streaming", "io.Reader", "Optimization"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go's streaming I/O primitives for processing large datasets with minimal memory allocation: io.Reader composition, sync.Pool buffer pooling, sendfile zero-copy, and practical benchmarks showing 10x memory reduction."
more_link: "yes"
url: "/go-memory-efficient-stream-processing-io-reader-buffer-pooling/"
---

Processing multi-gigabyte files or high-throughput network streams in Go requires understanding the full I/O stack: how the `io.Reader` and `io.Writer` interfaces compose, where allocations hide, how `sync.Pool` eliminates GC pressure, and when the kernel's zero-copy mechanisms remove userspace from the data path entirely. This guide builds from first principles to production-ready streaming pipelines that handle terabytes of data without proportional memory growth.

<!--more-->

# Go Memory-Efficient Stream Processing

## Section 1: The Cost of Naive I/O

Most Go programs that handle large files start with something like this:

```go
data, err := os.ReadFile("/var/data/events-2031-10-07.jsonl")
if err != nil {
    return fmt.Errorf("read file: %w", err)
}
lines := bytes.Split(data, []byte("\n"))
for _, line := range lines {
    processLine(line)
}
```

For a 4 GB log file this allocates:
1. 4 GB for `data`
2. Another ~4 GB for the slice of `lines` (each element is a sub-slice with its own header)
3. Whatever `processLine` allocates per record

Peak RSS is easily 10–12 GB for a 4 GB file. On a container with a 4 GB memory limit, this OOMKills. The fix is streaming: never hold more than one record in memory at a time.

### Benchmark: Bulk vs. Streaming

```go
package stream_test

import (
    "bufio"
    "bytes"
    "os"
    "testing"
)

var sink int

func BenchmarkBulkRead(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        data, _ := os.ReadFile("testdata/100mb.jsonl")
        lines := bytes.Split(data, []byte("\n"))
        for _, l := range lines {
            sink += len(l)
        }
    }
}

func BenchmarkStreamRead(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        f, _ := os.Open("testdata/100mb.jsonl")
        sc := bufio.NewScanner(f)
        for sc.Scan() {
            sink += len(sc.Bytes())
        }
        f.Close()
    }
}
```

Typical results on a 100 MB file:

```
BenchmarkBulkRead-16      3    412,345,678 ns/op   210,456,789 B/op   4 allocs/op
BenchmarkStreamRead-16   18     62,334,512 ns/op       131,072 B/op   3 allocs/op
```

`BenchmarkStreamRead` uses 1600x fewer bytes per operation.

## Section 2: The io.Reader Interface and Composition

The power of Go's I/O model is that `io.Reader` is a single-method interface:

```go
type Reader interface {
    Read(p []byte) (n int, err error)
}
```

Anything that implements `Read` can be composed with any other reader. The standard library provides dozens of composable types.

### Reader Composition Chain

```go
package main

import (
    "bufio"
    "compress/gzip"
    "crypto/aes"
    "crypto/cipher"
    "encoding/csv"
    "io"
    "os"
    "strings"
)

// buildPipeline composes readers: file -> decrypt -> decompress -> buffer -> csv
func buildPipeline(path string, key []byte, iv []byte) (*csv.Reader, io.Closer, error) {
    // Layer 1: raw file
    f, err := os.Open(path)
    if err != nil {
        return nil, nil, err
    }

    // Layer 2: AES-CTR decryption
    block, err := aes.NewCipher(key)
    if err != nil {
        f.Close()
        return nil, nil, err
    }
    stream := cipher.NewCTR(block, iv)
    decryptReader := &cipher.StreamReader{S: stream, R: f}

    // Layer 3: gzip decompression
    gzReader, err := gzip.NewReader(decryptReader)
    if err != nil {
        f.Close()
        return nil, nil, err
    }

    // Layer 4: buffered reader (reduces syscall count)
    bufReader := bufio.NewReaderSize(gzReader, 256*1024)

    // Layer 5: CSV parser
    csvReader := csv.NewReader(bufReader)
    csvReader.ReuseRecord = true // key optimization: reuses the slice header

    closer := closerFunc(func() error {
        gzReader.Close()
        return f.Close()
    })

    return csvReader, closer, nil
}

type closerFunc func() error

func (f closerFunc) Close() error { return f() }
```

### Using ReuseRecord to Eliminate Allocations

`csv.Reader.ReuseRecord = true` reuses the `[]string` slice on every call to `Read`. Without it, each CSV row allocates a new slice. With it:

```go
r.ReuseRecord = true
for {
    record, err := r.Read()
    if err == io.EOF {
        break
    }
    if err != nil {
        return err
    }
    // IMPORTANT: do not store record or any element of record beyond this iteration.
    // If you need to keep a value, copy it:
    id := strings.Clone(record[0])
    _ = id
}
```

## Section 3: bufio.Scanner with Custom Split Functions

`bufio.Scanner` is the idiomatic way to iterate over a stream line-by-line, but its default buffer (64 KB) is too small for some formats and its default split function may not match your protocol.

### Scanner Buffer Sizing

```go
package scanner

import (
    "bufio"
    "io"
)

const (
    initialBuf = 256 * 1024       // 256 KB starting buffer
    maxBuf     = 32 * 1024 * 1024 // 32 MB maximum line size
)

func NewLargeLineScanner(r io.Reader) *bufio.Scanner {
    sc := bufio.NewScanner(r)
    buf := make([]byte, initialBuf)
    sc.Buffer(buf, maxBuf)
    return sc
}
```

### Custom Split: Length-Prefixed Binary Frames

Many protocols use a 4-byte big-endian length prefix followed by a payload. Implement a `SplitFunc` for these:

```go
package framing

import (
    "bufio"
    "encoding/binary"
    "fmt"
    "io"
)

// SplitLengthPrefixed splits a stream of 4-byte-length-prefixed frames.
// Each frame: [uint32 big-endian length][payload bytes]
func SplitLengthPrefixed(data []byte, atEOF bool) (advance int, token []byte, err error) {
    if atEOF && len(data) == 0 {
        return 0, nil, nil
    }

    // Need at least 4 bytes for the length header
    if len(data) < 4 {
        if atEOF {
            return 0, nil, fmt.Errorf("truncated frame header: only %d bytes", len(data))
        }
        return 0, nil, nil // request more data
    }

    frameLen := int(binary.BigEndian.Uint32(data[:4]))
    if frameLen > 32*1024*1024 {
        return 0, nil, fmt.Errorf("frame too large: %d bytes", frameLen)
    }

    total := 4 + frameLen
    if len(data) < total {
        if atEOF {
            return 0, nil, io.ErrUnexpectedEOF
        }
        return 0, nil, nil // request more data
    }

    return total, data[4:total], nil
}

// Example usage
func ProcessFrameStream(r io.Reader, handler func([]byte) error) error {
    sc := bufio.NewScanner(r)
    sc.Split(SplitLengthPrefixed)
    buf := make([]byte, 64*1024)
    sc.Buffer(buf, 64*1024*1024)

    for sc.Scan() {
        if err := handler(sc.Bytes()); err != nil {
            return fmt.Errorf("handler: %w", err)
        }
    }
    return sc.Err()
}
```

## Section 4: sync.Pool for Buffer Reuse

Every `Read` call needs a destination buffer. Allocating a fresh one each time generates constant GC pressure. `sync.Pool` lets goroutines return buffers to a pool between uses.

### Pool Implementation

```go
package pool

import (
    "sync"
)

const defaultBufSize = 32 * 1024 // 32 KB

// BufferPool manages fixed-size byte slice reuse.
type BufferPool struct {
    pool sync.Pool
    size int
}

// NewBufferPool creates a pool of buffers of the given size.
func NewBufferPool(size int) *BufferPool {
    bp := &BufferPool{size: size}
    bp.pool = sync.Pool{
        New: func() interface{} {
            buf := make([]byte, size)
            return &buf
        },
    }
    return bp
}

// Get returns a buffer from the pool. The caller must call Put when done.
func (p *BufferPool) Get() []byte {
    return *p.pool.Get().(*[]byte)
}

// Put returns a buffer to the pool. The buffer must not be used after calling Put.
func (p *BufferPool) Put(buf []byte) {
    if cap(buf) != p.size {
        return // wrong size; let GC handle it
    }
    buf = buf[:p.size]
    p.pool.Put(&buf)
}

// Global default pool
var Default = NewBufferPool(defaultBufSize)
```

### Using the Pool in a Concurrent Pipeline

```go
package pipeline

import (
    "context"
    "fmt"
    "io"
    "sync"

    "example.com/myapp/pool"
)

type Record struct {
    Data []byte
    // Data is borrowed from pool; call Release when done
    Release func()
}

// StreamConcurrent reads from r and fans out to nWorkers goroutines.
func StreamConcurrent(ctx context.Context, r io.Reader, nWorkers int,
    process func(context.Context, []byte) error) error {

    ch := make(chan Record, nWorkers*2)
    var wg sync.WaitGroup
    errs := make(chan error, nWorkers+1)

    // Workers
    for i := 0; i < nWorkers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for rec := range ch {
                if err := process(ctx, rec.Data); err != nil {
                    errs <- fmt.Errorf("worker: %w", err)
                }
                rec.Release()
            }
        }()
    }

    // Reader goroutine
    go func() {
        defer close(ch)
        for {
            buf := pool.Default.Get()
            n, err := r.Read(buf)
            if n > 0 {
                payload := make([]byte, n) // only copy the actual data
                copy(payload, buf[:n])
                pool.Default.Put(buf) // return read buffer immediately

                poolBuf := pool.Default.Get()
                copy(poolBuf, payload)
                select {
                case ch <- Record{
                    Data: poolBuf[:n],
                    Release: func() { pool.Default.Put(poolBuf) },
                }:
                case <-ctx.Done():
                    pool.Default.Put(poolBuf)
                    errs <- ctx.Err()
                    return
                }
            } else {
                pool.Default.Put(buf)
            }
            if err == io.EOF {
                return
            }
            if err != nil {
                errs <- fmt.Errorf("read: %w", err)
                return
            }
        }
    }()

    wg.Wait()
    close(errs)

    for err := range errs {
        if err != nil {
            return err
        }
    }
    return nil
}
```

## Section 5: Zero-Copy Techniques

### io.Copy and the WriterTo / ReaderFrom Interfaces

`io.Copy` is not always a simple read-then-write loop. When the source implements `io.WriterTo` or the destination implements `io.ReaderFrom`, the standard library delegates to the optimized method.

For `*os.File` to `*os.File` on Linux, the runtime uses the `sendfile(2)` syscall, which transfers data entirely in kernel space:

```go
// This path calls sendfile internally on Linux
src, _ := os.Open("/data/large-file.bin")
dst, _ := os.Create("/backup/large-file.bin")
defer src.Close()
defer dst.Close()

n, err := io.Copy(dst, src)
// No data ever touches userspace — kernel copies directly between file descriptors
```

### net.Conn to File: splice

When copying from a network connection to a file, use `io.Copy` with an `*os.File` destination to trigger `splice(2)` on Linux kernels 4.5+:

```go
func receiveFile(conn net.Conn, dst *os.File) (int64, error) {
    // On Linux, io.Copy detects *net.TCPConn -> *os.File and uses splice
    return io.Copy(dst, conn)
}
```

### Manual sendfile with syscall Package

For HTTP serving, use `net/http`'s `ServeFile` or `ServeContent` which internally calls `sendfile`. For custom protocols:

```go
package zerocopy

import (
    "fmt"
    "os"
    "syscall"
)

// SendFile transfers n bytes from src starting at offset to the dst file descriptor.
// Returns bytes transferred or an error.
func SendFile(dstFD uintptr, src *os.File, offset int64, count int64) (int64, error) {
    srcFD := src.Fd()
    off := offset
    var total int64

    for total < count {
        remaining := count - total
        if remaining > 1<<30 { // sendfile max per call on Linux
            remaining = 1 << 30
        }
        n, _, errno := syscall.Syscall6(
            syscall.SYS_SENDFILE,
            dstFD,
            srcFD,
            uintptr(unsafe.Pointer(&off)),
            uintptr(remaining),
            0, 0,
        )
        if n == 0 && errno == 0 {
            break
        }
        if errno != 0 {
            return total, fmt.Errorf("sendfile: %w", errno)
        }
        total += int64(n)
    }
    return total, nil
}
```

Note: Calling `src.Fd()` puts the file into blocking mode. For high-performance code, use `os.File`'s internal fd via reflection or avoid mixing with non-blocking I/O.

## Section 6: io.Pipe for In-Memory Pipeline Stages

`io.Pipe` creates a synchronous in-memory pipe. It is useful when you need to connect a producer that writes to an `io.Writer` with a consumer that reads from an `io.Reader` without buffering intermediate data to disk.

```go
package pipeline

import (
    "compress/gzip"
    "encoding/json"
    "io"
)

type Event struct {
    ID        string  `json:"id"`
    Timestamp int64   `json:"ts"`
    Value     float64 `json:"value"`
}

// EncodeAndCompress writes JSON-encoded events to a gzip-compressed stream.
// The caller reads from the returned io.Reader.
func EncodeAndCompress(events <-chan Event) io.Reader {
    pr, pw := io.Pipe()

    go func() {
        gz, err := gzip.NewWriterLevel(pw, gzip.BestSpeed)
        if err != nil {
            pw.CloseWithError(err)
            return
        }
        enc := json.NewEncoder(gz)

        for ev := range events {
            if err := enc.Encode(ev); err != nil {
                gz.Close()
                pw.CloseWithError(fmt.Errorf("encode: %w", err))
                return
            }
        }

        if err := gz.Close(); err != nil {
            pw.CloseWithError(err)
            return
        }
        pw.Close()
    }()

    return pr
}

// Usage: write compressed stream directly to S3 without temp file
func UploadEvents(ctx context.Context, s3Client S3Client, events <-chan Event,
    bucket, key string) error {

    r := EncodeAndCompress(events)
    return s3Client.PutObject(ctx, bucket, key, r, -1)
}
```

## Section 7: LimitedReader and TeeReader for Safe Composition

### Bounding Input with io.LimitedReader

Never trust external input sizes. Wrap any externally-sourced reader:

```go
const maxRequestBody = 10 * 1024 * 1024 // 10 MB

func handleUpload(w http.ResponseWriter, r *http.Request) {
    limited := io.LimitReader(r.Body, maxRequestBody+1)
    var buf bytes.Buffer
    n, err := io.Copy(&buf, limited)
    if err != nil {
        http.Error(w, "read error", http.StatusBadRequest)
        return
    }
    if n > maxRequestBody {
        http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
        return
    }
    processBody(buf.Bytes())
}
```

### Inspecting Data in Flight with io.TeeReader

```go
func parseAndHash(r io.Reader) (parsed []Record, hash []byte, err error) {
    h := sha256.New()
    tee := io.TeeReader(r, h)  // every byte read from tee is also written to h

    sc := bufio.NewScanner(tee)
    for sc.Scan() {
        var rec Record
        if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
            return nil, nil, fmt.Errorf("parse line: %w", err)
        }
        parsed = append(parsed, rec)
    }
    if err := sc.Err(); err != nil {
        return nil, nil, err
    }

    return parsed, h.Sum(nil), nil
}
```

## Section 8: Multi-Reader and Multi-Writer Patterns

### io.MultiReader for Concatenating Streams

Useful for prepending headers or appending footers without copying:

```go
func wrapWithEnvelope(header, body, footer []byte) io.Reader {
    return io.MultiReader(
        bytes.NewReader(header),
        bytes.NewReader(body),
        bytes.NewReader(footer),
    )
}

// Stream a multipart upload without assembling in memory
func uploadMultipart(parts []io.Reader, totalSize int64) io.Reader {
    return io.MultiReader(parts...)
}
```

### io.MultiWriter for Fan-Out

```go
func backupWithVerification(src io.Reader, dst io.Writer) ([]byte, error) {
    h := sha256.New()
    mw := io.MultiWriter(dst, h)  // write to destination AND hasher simultaneously

    if _, err := io.Copy(mw, src); err != nil {
        return nil, fmt.Errorf("copy: %w", err)
    }
    return h.Sum(nil), nil
}
```

## Section 9: Context-Aware Streaming with Cancellation

Standard `io.Reader` does not accept a `context.Context`. For long-running streams, wrap reads to respect cancellation:

```go
package ctxio

import (
    "context"
    "io"
)

type ctxReader struct {
    ctx context.Context
    r   io.Reader
}

// NewReader returns a reader that returns ctx.Err() once the context is cancelled.
// Reads are not interrupted mid-call; cancellation is checked between reads.
func NewReader(ctx context.Context, r io.Reader) io.Reader {
    return &ctxReader{ctx: ctx, r: r}
}

func (cr *ctxReader) Read(p []byte) (int, error) {
    select {
    case <-cr.ctx.Done():
        return 0, cr.ctx.Err()
    default:
    }
    return cr.r.Read(p)
}

// For true mid-read cancellation on network connections, set deadlines:
func readWithDeadline(ctx context.Context, conn net.Conn, p []byte) (int, error) {
    if deadline, ok := ctx.Deadline(); ok {
        conn.SetReadDeadline(deadline)
    }
    n, err := conn.Read(p)
    conn.SetReadDeadline(time.Time{}) // clear deadline
    return n, err
}
```

## Section 10: Chunked Processing with Ring Buffers

For sustained high-throughput ingestion where you want to decouple reading from processing with bounded memory:

```go
package ringbuf

import (
    "fmt"
    "io"
    "sync"
)

// Chunk represents a reusable, fixed-size buffer segment.
type Chunk struct {
    Data   []byte
    Len    int
    pool   *ChunkPool
}

func (c *Chunk) Release() {
    c.Len = 0
    c.pool.put(c)
}

// ChunkPool manages a fixed number of chunks to bound memory usage.
type ChunkPool struct {
    ch   chan *Chunk
    size int
}

func NewChunkPool(count, chunkSize int) *ChunkPool {
    p := &ChunkPool{
        ch:   make(chan *Chunk, count),
        size: chunkSize,
    }
    for i := 0; i < count; i++ {
        p.ch <- &Chunk{Data: make([]byte, chunkSize), pool: p}
    }
    return p
}

// Get blocks until a chunk is available. Returns nil only if pool is closed.
func (p *ChunkPool) Get() *Chunk {
    return <-p.ch
}

func (p *ChunkPool) put(c *Chunk) {
    p.ch <- c
}

// ReadAll reads src into chunks and passes them to process.
// Memory usage is bounded to count*chunkSize bytes.
func ReadAll(r io.Reader, pool *ChunkPool, process func(*Chunk) error) error {
    for {
        chunk := pool.Get()
        n, err := r.Read(chunk.Data)
        if n > 0 {
            chunk.Len = n
            if procErr := process(chunk); procErr != nil {
                chunk.Release()
                return fmt.Errorf("process: %w", procErr)
            }
        } else {
            chunk.Release()
        }
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return fmt.Errorf("read: %w", err)
        }
    }
}
```

## Section 11: Benchmarking and Profiling Stream Code

Use `testing.B` with `b.SetBytes` to report throughput:

```go
func BenchmarkPipelineThoughput(b *testing.B) {
    const fileSize = 512 * 1024 * 1024 // 512 MB synthetic
    b.SetBytes(fileSize)
    b.ReportAllocs()

    src := io.LimitReader(rand.Reader, fileSize)

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        r := io.LimitReader(src, fileSize)
        if err := ProcessStream(r); err != nil {
            b.Fatal(err)
        }
    }
}
```

Profile allocations with pprof:

```bash
go test -bench=BenchmarkPipelineThoughput -benchmem \
  -memprofile=mem.prof -cpuprofile=cpu.prof ./...

go tool pprof -alloc_objects mem.prof
# (pprof) top20
# (pprof) list processChunk
```

Look for `runtime.mallocgc` calls in hot paths. Each call is an allocation. Common sources in stream code:

- `append` growing beyond pre-allocated capacity
- `string()` conversion of `[]byte` (always copies)
- Closure captures creating heap escapes
- Interface boxing of concrete types in tight loops

### Eliminating string() Conversion

```go
// Bad: allocates a new string on every comparison
if string(line) == "DONE" { ... }

// Good: compare bytes directly
if bytes.Equal(line, []byte("DONE")) { ... }

// Or use unsafe for zero-allocation string view (read-only):
func bytesToString(b []byte) string {
    return *(*string)(unsafe.Pointer(&b))
}
// WARNING: the string must not outlive b
```

## Section 12: Production Streaming Pipeline Example

A complete, production-ready pipeline that reads gzip-compressed JSONL from S3, decodes records, validates them, and writes validated records to a downstream sink:

```go
package etl

import (
    "bufio"
    "compress/gzip"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "log/slog"
    "sync"
    "sync/atomic"

    "gocloud.dev/blob"
)

type RawEvent struct {
    ID      string          `json:"id"`
    Type    string          `json:"type"`
    Payload json.RawMessage `json:"payload"`
}

type Pipeline struct {
    workers    int
    bufPool    *sync.Pool
    processed  atomic.Int64
    errors     atomic.Int64
}

func NewPipeline(workers int) *Pipeline {
    return &Pipeline{
        workers: workers,
        bufPool: &sync.Pool{
            New: func() interface{} {
                buf := make([]byte, 0, 4096)
                return &buf
            },
        },
    }
}

func (p *Pipeline) ProcessObject(ctx context.Context,
    bucket *blob.Bucket, key string,
    sink func(context.Context, *RawEvent) error) error {

    r, err := bucket.NewReader(ctx, key, nil)
    if err != nil {
        return fmt.Errorf("open object %s: %w", key, err)
    }
    defer r.Close()

    gz, err := gzip.NewReader(r)
    if err != nil {
        return fmt.Errorf("gzip reader for %s: %w", key, err)
    }
    defer gz.Close()

    // Fan out to workers via channel
    type job struct {
        line []byte
        free func()
    }
    jobs := make(chan job, p.workers*4)
    var wg sync.WaitGroup
    errc := make(chan error, p.workers)

    for i := 0; i < p.workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := range jobs {
                var ev RawEvent
                if err := json.Unmarshal(j.line, &ev); err != nil {
                    slog.Warn("unmarshal failed", "err", err)
                    p.errors.Add(1)
                    j.free()
                    continue
                }
                j.free()

                if err := sink(ctx, &ev); err != nil {
                    errc <- fmt.Errorf("sink: %w", err)
                    return
                }
                p.processed.Add(1)
            }
        }()
    }

    // Reader goroutine
    sc := bufio.NewScanner(gz)
    sc.Buffer(make([]byte, 256*1024), 4*1024*1024)

    readErr := make(chan error, 1)
    go func() {
        defer close(jobs)
        for sc.Scan() {
            raw := sc.Bytes()
            bufPtr := p.bufPool.Get().(*[]byte)
            *bufPtr = append((*bufPtr)[:0], raw...)

            select {
            case jobs <- job{
                line: *bufPtr,
                free: func() {
                    *bufPtr = (*bufPtr)[:0]
                    p.bufPool.Put(bufPtr)
                },
            }:
            case <-ctx.Done():
                readErr <- ctx.Err()
                return
            }
        }
        if err := sc.Err(); err != nil {
            readErr <- fmt.Errorf("scan: %w", err)
        }
    }()

    wg.Wait()
    close(errc)

    if err := <-readErr; err != nil {
        return err
    }
    for err := range errc {
        if err != nil {
            return err
        }
    }

    slog.Info("pipeline complete",
        "key", key,
        "processed", p.processed.Load(),
        "errors", p.errors.Load(),
    )
    return nil
}
```

## Summary

Efficient stream processing in Go rests on four pillars: composing `io.Reader` chains to avoid holding entire datasets in memory, using `sync.Pool` to eliminate repetitive buffer allocations, leveraging kernel zero-copy paths (`sendfile`, `splice`) when transferring between file descriptors, and sizing `bufio` buffers to amortize syscall overhead. Apply `ReuseRecord` on CSV readers, pre-allocate slices to known capacities, and use `bytes.Equal` instead of `string()` conversion in hot paths. The result is pipelines that process terabytes on hardware with gigabytes of RAM, with allocation profiles dominated by a handful of pool-managed buffers rather than per-record heap growth.
