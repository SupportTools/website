---
title: "Go io.Reader and io.Writer: Composable I/O Patterns for High-Throughput Pipelines"
date: 2029-03-07T00:00:00-05:00
draft: false
tags: ["Go", "I/O", "Performance", "Streaming", "Pipelines", "Concurrency"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to composable I/O patterns in Go using io.Reader and io.Writer, covering streaming pipelines, buffering strategies, fan-out/fan-in patterns, and zero-copy techniques for high-throughput data processing."
more_link: "yes"
url: "/go-io-reader-writer-composable-patterns-high-throughput/"
---

Go's `io.Reader` and `io.Writer` interfaces are among the most powerful abstractions in the standard library. With two methods between them — `Read(p []byte) (n int, err error)` and `Write(p []byte) (n int, err error)` — they underpin the entire I/O ecosystem: HTTP bodies, file descriptors, network connections, compression streams, encryption layers, and metrics instrumentation. Their power comes from composability: any `Reader` can be wrapped by another `Reader`, any `Writer` can be wrapped by another `Writer`, and `io.Pipe` connects them bidirectionally. This post covers the patterns that unlock high-throughput, low-allocation I/O pipelines.

<!--more-->

## The Reader/Writer Contract

### io.Reader

```go
type Reader interface {
    Read(p []byte) (n int, err error)
}
```

The contract:
- Returns `(0, io.EOF)` when no more data is available
- May return `n > 0` **and** `err = io.EOF` in the same call
- Returns `(0, nil)` to indicate a temporary empty read (rare)
- Never retains the slice `p` after return

The most common mistake is assuming `Read` fills the buffer. It returns whatever is available, which may be 1 byte. Always use `io.ReadFull` or `io.ReadAtLeast` when an exact amount is required.

```go
// Wrong: assumes buf is fully populated
n, err := r.Read(buf)
process(buf[:n])  // n may be much less than len(buf)

// Correct: ensure full buffer population
n, err := io.ReadFull(r, buf)
if err != nil && err != io.ErrUnexpectedEOF {
    return err
}
process(buf[:n])
```

### io.Writer

```go
type Writer interface {
    Write(p []byte) (n int, err error)
}
```

The contract:
- Must return a non-nil error if `n < len(p)`
- Must not modify the slice `p`
- Must not retain `p` after return

## Composable Reader Chains

### The io.TeeReader Pattern

`io.TeeReader` reads from a source and simultaneously writes every byte to a secondary writer. This is the correct pattern for content inspection during streaming:

```go
package pipeline

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
)

// HashingReader reads from src and computes a SHA-256 hash as bytes flow through.
type HashingReader struct {
	src    io.Reader
	hasher io.Writer
}

// NewHashingReader wraps src in a reader that hashes all bytes read.
// Call Sum() after reading is complete to get the digest.
func NewHashingReader(src io.Reader) (*HashingReader, *[32]byte) {
	h := sha256.New()
	var digest [32]byte
	return &HashingReader{
		src:    io.TeeReader(src, h),
		hasher: h,
	}, &digest
}

// Read implements io.Reader.
func (r *HashingReader) Read(p []byte) (int, error) {
	return r.src.Read(p)
}

// Sum returns the final SHA-256 digest after all data has been read.
// Must only be called after Read returns io.EOF.
func (r *HashingReader) Sum() string {
	type sumProvider interface {
		Sum(b []byte) []byte
	}
	if sp, ok := r.hasher.(sumProvider); ok {
		return hex.EncodeToString(sp.Sum(nil))
	}
	return ""
}
```

### LimitReader for Safety

Always wrap untrusted input readers with `io.LimitReader` to prevent memory exhaustion:

```go
package pipeline

import (
	"fmt"
	"io"
	"net/http"
)

const maxRequestBodyBytes = 10 * 1024 * 1024 // 10 MB

// ReadRequestBody reads an HTTP request body with a hard size limit.
// Returns ErrBodyTooLarge if the body exceeds maxBytes.
func ReadRequestBody(r *http.Request, maxBytes int64) ([]byte, error) {
	limited := io.LimitReader(r.Body, maxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("reading request body: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("request body exceeds %d bytes: %w", maxBytes, ErrBodyTooLarge)
	}
	return data, nil
}

// ErrBodyTooLarge is returned when a request body exceeds the size limit.
var ErrBodyTooLarge = fmt.Errorf("body too large")
```

### MultiReader for Request Reconstruction

`io.MultiReader` concatenates multiple readers into one, essential for re-reading bodies after inspection:

```go
package pipeline

import (
	"bytes"
	"io"
	"net/http"
)

// PeekAndRestoreBody reads the first n bytes of a request body for inspection,
// then reconstructs the full body for downstream handlers.
func PeekAndRestoreBody(r *http.Request, peekBytes int) (peeked []byte, err error) {
	if r.Body == nil || r.Body == http.NoBody {
		return nil, nil
	}

	peeked = make([]byte, peekBytes)
	n, err := io.ReadFull(r.Body, peeked)
	peeked = peeked[:n]

	if err != nil && err != io.ErrUnexpectedEOF {
		return nil, fmt.Errorf("peeking request body: %w", err)
	}

	// Reconstruct: concatenate peeked bytes + remaining body
	r.Body = io.NopCloser(io.MultiReader(
		bytes.NewReader(peeked),
		r.Body,
	))

	return peeked, nil
}
```

## Buffered I/O for Throughput

### When to Use bufio

Raw `Read`/`Write` calls on network connections and files are system calls. Buffering batches small writes and provides line-at-a-time or delimiter-based reading:

```go
package pipeline

import (
	"bufio"
	"io"
	"strings"
)

// LineCounter counts newlines in a Reader using buffered I/O.
// For a 1GB file, this is ~10x faster than reading byte-by-byte.
func LineCounter(r io.Reader) (int, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB line buffer

	count := 0
	for scanner.Scan() {
		count++
	}
	return count, scanner.Err()
}

// WriteLines writes strings as lines, batching writes through a bufio.Writer.
func WriteLines(w io.Writer, lines []string) error {
	bw := bufio.NewWriterSize(w, 64*1024) // 64KB write buffer
	for _, line := range lines {
		if _, err := bw.WriteString(line); err != nil {
			return err
		}
		if err := bw.WriteByte('\n'); err != nil {
			return err
		}
	}
	return bw.Flush() // Critical: must flush or last buffer is lost
}
```

### The bufio.Writer Flush Trap

A common production bug: `bufio.Writer` silently discards unflushed data when the program exits. Always use `defer` with error checking:

```go
// Wrong: flush error is ignored
defer bw.Flush()

// Correct: flush error bubbles up
defer func() {
	if ferr := bw.Flush(); ferr != nil && err == nil {
		err = ferr
	}
}()
```

## io.Pipe for Goroutine-to-Goroutine Streaming

`io.Pipe` creates a synchronous in-memory pipe. The writer blocks until the reader consumes data, eliminating buffering overhead for goroutine-coupled pipelines:

```go
package pipeline

import (
	"compress/gzip"
	"fmt"
	"io"
)

// CompressStream compresses data from src, writing compressed bytes to dst.
// Uses io.Pipe to connect the goroutine that reads from src to the compressor.
func CompressStream(dst io.Writer, src io.Reader) error {
	pr, pw := io.Pipe()

	// Producer goroutine: read from src, write raw bytes to pipe writer
	errCh := make(chan error, 1)
	go func() {
		_, err := io.Copy(pw, src)
		// CloseWithError propagates the error to the reader
		pw.CloseWithError(err)
		errCh <- err
	}()

	// Consumer: read from pipe, compress to dst
	gz := gzip.NewWriter(dst)
	if _, err := io.Copy(gz, pr); err != nil {
		return fmt.Errorf("compressing: %w", err)
	}
	if err := gz.Close(); err != nil {
		return fmt.Errorf("finalizing gzip stream: %w", err)
	}

	// Wait for producer to finish and check for errors
	if err := <-errCh; err != nil {
		return fmt.Errorf("reading source: %w", err)
	}
	return nil
}
```

## Fan-Out: Broadcasting to Multiple Writers

`io.MultiWriter` writes to all writers simultaneously. Combined with `io.Pipe`, this enables fan-out streaming:

```go
package pipeline

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
)

// BackupWithVerification writes src to an output file while simultaneously
// computing a SHA-256 hash and gzip-compressing the data. All three operations
// happen in a single streaming pass — no data is buffered in memory.
func BackupWithVerification(src io.Reader, outputPath string) (checksum string, bytesWritten int64, err error) {
	f, err := os.Create(outputPath)
	if err != nil {
		return "", 0, fmt.Errorf("creating output file: %w", err)
	}
	defer func() {
		if cerr := f.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}()

	// Hash writer for checksum computation
	hasher := sha256.New()

	// Counting writer to track bytes written
	counter := &countingWriter{}

	// Compressed file writer
	gz := gzip.NewWriter(f)
	defer func() {
		if cerr := gz.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}()

	// Fan-out: every byte from src goes to hasher, counter, and gz simultaneously
	mw := io.MultiWriter(hasher, counter, gz)

	if _, err = io.Copy(mw, src); err != nil {
		return "", 0, fmt.Errorf("streaming data: %w", err)
	}

	return hex.EncodeToString(hasher.Sum(nil)), counter.n, nil
}

type countingWriter struct {
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	c.n += int64(len(p))
	return len(p), nil
}
```

## Zero-Copy with io.WriterTo and io.ReaderFrom

When both source and destination implement `io.WriterTo` / `io.ReaderFrom`, `io.Copy` uses their optimized paths, which may invoke `sendfile(2)` or `splice(2)` for true zero-copy:

```go
package pipeline

import (
	"io"
	"net"
	"os"
)

// StreamFileToConnection sends a file to a TCP connection using sendfile(2).
// On Linux, this avoids copying data through userspace.
func StreamFileToConnection(conn net.Conn, path string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	// io.Copy detects that f implements io.WriterTo (*os.File does),
	// and conn implements io.ReaderFrom (*net.TCPConn does).
	// The runtime calls sendfile(2) under the hood.
	return io.Copy(conn, f)
}
```

## Instrumented Reader/Writer for Metrics

```go
package pipeline

import (
	"io"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	ioReadBytes = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "pipeline_io_read_bytes_total",
			Help: "Total bytes read through instrumented readers",
		},
		[]string{"source"},
	)
	ioWriteBytes = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "pipeline_io_write_bytes_total",
			Help: "Total bytes written through instrumented writers",
		},
		[]string{"destination"},
	)
	ioReadDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "pipeline_io_read_duration_seconds",
			Help:    "Duration of Read calls",
			Buckets: prometheus.ExponentialBuckets(0.0001, 2, 16),
		},
		[]string{"source"},
	)
)

// InstrumentedReader wraps an io.Reader with Prometheus metrics.
type InstrumentedReader struct {
	inner  io.Reader
	source string
}

// NewInstrumentedReader creates a metrics-wrapped reader.
func NewInstrumentedReader(r io.Reader, source string) *InstrumentedReader {
	return &InstrumentedReader{inner: r, source: source}
}

// Read implements io.Reader and records byte count and call duration.
func (r *InstrumentedReader) Read(p []byte) (int, error) {
	start := time.Now()
	n, err := r.inner.Read(p)
	ioReadDuration.WithLabelValues(r.source).Observe(time.Since(start).Seconds())
	if n > 0 {
		ioReadBytes.WithLabelValues(r.source).Add(float64(n))
	}
	return n, err
}

// InstrumentedWriter wraps an io.Writer with Prometheus metrics.
type InstrumentedWriter struct {
	inner       io.Writer
	destination string
}

// NewInstrumentedWriter creates a metrics-wrapped writer.
func NewInstrumentedWriter(w io.Writer, destination string) *InstrumentedWriter {
	return &InstrumentedWriter{inner: w, destination: destination}
}

// Write implements io.Writer and records byte count.
func (w *InstrumentedWriter) Write(p []byte) (int, error) {
	n, err := w.inner.Write(p)
	if n > 0 {
		ioWriteBytes.WithLabelValues(w.destination).Add(float64(n))
	}
	return n, err
}
```

## Concurrent Pipeline with Back-Pressure

For high-throughput pipelines, a channel-based stage model with back-pressure prevents unbounded memory growth:

```go
package pipeline

import (
	"context"
	"io"
)

const defaultChunkSize = 256 * 1024 // 256KB chunks

// Chunk represents a piece of data flowing through the pipeline.
type Chunk struct {
	Data []byte
	Err  error
}

// NewReaderStage reads from r in chunks and sends them to the output channel.
// Closes the channel and includes any error as the last Chunk when done.
func NewReaderStage(ctx context.Context, r io.Reader, chunkSize int) <-chan Chunk {
	out := make(chan Chunk, 4) // 4-chunk buffer provides limited lookahead

	go func() {
		defer close(out)
		for {
			buf := make([]byte, chunkSize)
			n, err := io.ReadFull(r, buf)
			if n > 0 {
				select {
				case out <- Chunk{Data: buf[:n]}:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				if err != io.ErrUnexpectedEOF {
					select {
					case out <- Chunk{Err: err}:
					case <-ctx.Done():
					}
				}
				return
			}
		}
	}()

	return out
}

// NewWriterStage reads chunks from in and writes them to w.
// Returns after the channel is closed or context is cancelled.
func NewWriterStage(ctx context.Context, w io.Writer, in <-chan Chunk) error {
	for {
		select {
		case chunk, ok := <-in:
			if !ok {
				return nil
			}
			if chunk.Err != nil {
				if chunk.Err == io.EOF {
					return nil
				}
				return chunk.Err
			}
			if _, err := w.Write(chunk.Data); err != nil {
				return err
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
```

## Common Pitfalls Reference

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Not calling `bufio.Writer.Flush()` | Silent data loss on exit | Always `defer bw.Flush()` with error check |
| Ignoring `(n, io.EOF)` case | Drops last read bytes | Check `n > 0` before checking `err` |
| Re-reading HTTP body | Empty body on second read | Use `io.TeeReader` or `PeekAndRestoreBody` |
| Using `bytes.Buffer` for large data | High GC pressure | Use `io.Pipe` with streaming |
| `io.Copy` without size limit | OOM on malicious input | Wrap source with `io.LimitReader` |
| `io.ReadAll` on network stream | Blocks until connection close | Use bounded readers + timeouts |
| Not closing pipe writer on error | Reader goroutine leaks forever | `pw.CloseWithError(err)` always |

## Summary

The `io.Reader`/`io.Writer` interface pair enables true pipeline composition in Go: any transformation (compression, encryption, hashing, rate-limiting, metrics) can be layered without buffering the entire stream in memory. The key patterns are `io.TeeReader` for side-channel processing, `io.LimitReader` for safety, `io.MultiWriter` for fan-out, `io.Pipe` for goroutine decoupling, and the `sendfile`-path `io.Copy` for zero-copy file serving. Correctly applying these patterns eliminates entire categories of allocation pressure and enables throughput that scales to the available network or disk bandwidth.
