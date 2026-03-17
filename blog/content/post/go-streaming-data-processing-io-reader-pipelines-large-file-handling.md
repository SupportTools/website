---
title: "Go Streaming Data Processing: io.Reader Pipelines, Chunked Transfer, and Large File Handling"
date: 2030-10-29T00:00:00-05:00
draft: false
tags: ["Go", "Streaming", "io.Reader", "S3", "Chunked Transfer", "Memory Management", "Backpressure"]
categories:
- Go
- Backend Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Production streaming in Go covering io.Reader and io.Writer composition patterns, chunked HTTP upload and download, S3 multipart upload, streaming JSON parsing with json.Decoder, bounded memory streaming, and backpressure in streaming pipelines."
more_link: "yes"
url: "/go-streaming-data-processing-io-reader-pipelines-large-file-handling/"
---

The `io.Reader` and `io.Writer` interfaces are the backbone of Go's I/O model. Any data source that can produce bytes implements `io.Reader`. Any data sink that can consume bytes implements `io.Writer`. Composing these interfaces into pipelines allows processing arbitrarily large data with bounded memory—a capability that becomes critical when handling gigabyte-scale uploads, database exports, or event log streaming.

<!--more-->

## Section 1: io.Reader and io.Writer Composition

### The Interface Contracts

```go
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Writer interface {
    Write(p []byte) (n int, err error)
}
```

`Read` returns the number of bytes read and any error. It may return `io.EOF` when no more data is available. Critically, `Read` may return fewer bytes than `len(p)` even when more data remains—callers must handle partial reads.

`io.Copy` is the standard way to connect a reader to a writer without partial-read bugs:

```go
// io.Copy handles partial reads and EOF internally
// It copies until EOF or error, using a 32KB internal buffer
written, err := io.Copy(dst, src)
```

### Reader Pipeline Construction

Readers can be layered to add functionality without modifying the data source:

```go
package pipeline

import (
    "bufio"
    "compress/gzip"
    "crypto/sha256"
    "encoding/hex"
    "hash"
    "io"
    "os"
)

// Pipeline chains multiple transformations on a reader
type Pipeline struct {
    reader io.Reader
    closer []io.Closer
}

func NewPipeline(r io.Reader) *Pipeline {
    return &Pipeline{reader: r}
}

// WithGzipDecompression adds transparent gzip decompression
func (p *Pipeline) WithGzipDecompression() (*Pipeline, error) {
    gz, err := gzip.NewReader(p.reader)
    if err != nil {
        return p, err
    }
    p.reader = gz
    p.closer = append(p.closer, gz)
    return p, nil
}

// WithBuffering adds a read buffer (reduces syscall count)
func (p *Pipeline) WithBuffering(size int) *Pipeline {
    p.reader = bufio.NewReaderSize(p.reader, size)
    return p
}

// WithHasher computes a hash over the data stream as it passes through
type HashingReader struct {
    r    io.Reader
    hash hash.Hash
}

func (p *Pipeline) WithSHA256() (*Pipeline, *sha256.Hash) {
    h := sha256.New()
    p.reader = io.TeeReader(p.reader, h)
    return p, h.(*sha256.Hash)
}

func (p *Pipeline) Reader() io.Reader {
    return p.reader
}

func (p *Pipeline) Close() error {
    var errs []error
    for _, c := range p.closer {
        if err := c.Close(); err != nil {
            errs = append(errs, err)
        }
    }
    if len(errs) > 0 {
        return errs[0]
    }
    return nil
}

// Example: read a gzipped file, hash it, and pipe to an HTTP response
func ServeGzippedFileDecompressed(w io.Writer, filePath string) (string, error) {
    f, err := os.Open(filePath)
    if err != nil {
        return "", err
    }
    defer f.Close()

    pipe := NewPipeline(f)
    pipe, err = pipe.WithGzipDecompression()
    if err != nil {
        return "", err
    }
    defer pipe.Close()
    pipe = pipe.WithBuffering(64 * 1024)

    hasher := sha256.New()
    reader := io.TeeReader(pipe.Reader(), hasher)

    if _, err := io.Copy(w, reader); err != nil {
        return "", err
    }

    return hex.EncodeToString(hasher.Sum(nil)), nil
}
```

### Rate-Limited Reader

For scenarios where upstream data must be consumed at a controlled pace:

```go
package pipeline

import (
    "context"
    "io"
    "time"
)

// RateLimitedReader limits read throughput to maxBytesPerSecond.
type RateLimitedReader struct {
    r               io.Reader
    maxBytesPerSec  int64
    bytesThisSec    int64
    windowStart     time.Time
}

func NewRateLimitedReader(r io.Reader, bytesPerSecond int64) *RateLimitedReader {
    return &RateLimitedReader{
        r:              r,
        maxBytesPerSec: bytesPerSecond,
        windowStart:    time.Now(),
    }
}

func (r *RateLimitedReader) Read(p []byte) (int, error) {
    now := time.Now()
    if now.Sub(r.windowStart) >= time.Second {
        r.bytesThisSec = 0
        r.windowStart = now
    }

    available := r.maxBytesPerSec - r.bytesThisSec
    if available <= 0 {
        sleepDuration := time.Second - now.Sub(r.windowStart)
        time.Sleep(sleepDuration)
        r.bytesThisSec = 0
        r.windowStart = time.Now()
        available = r.maxBytesPerSec
    }

    if int64(len(p)) > available {
        p = p[:available]
    }

    n, err := r.r.Read(p)
    r.bytesThisSec += int64(n)
    return n, err
}
```

## Section 2: Chunked HTTP Upload and Download

### Chunked HTTP Upload Server

The standard `net/http` package handles chunked transfer encoding transparently. The request body is an `io.Reader` regardless of whether the client used `Transfer-Encoding: chunked` or `Content-Length`:

```go
package handlers

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "net/http"
    "path/filepath"
    "strconv"
)

const (
    maxUploadSize  = 5 * 1024 * 1024 * 1024 // 5 GB
    uploadChunkBuf = 256 * 1024              // 256 KB read buffer
)

type UploadHandler struct {
    storage StorageBackend
    maxSize int64
}

func (h *UploadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPut {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    // Validate Content-Length if provided (chunked uploads may not provide it)
    if r.ContentLength > 0 && r.ContentLength > h.maxSize {
        http.Error(w,
            fmt.Sprintf("file too large: max %d bytes", h.maxSize),
            http.StatusRequestEntityTooLarge)
        return
    }

    // Limit the request body regardless
    limitedBody := io.LimitReader(r.Body, h.maxSize+1)

    objectKey := filepath.Clean(r.URL.Path)
    hasher := sha256.New()

    // TeeReader writes to hasher as data flows to storage
    tee := io.TeeReader(limitedBody, hasher)

    bytesWritten, err := h.storage.Write(r.Context(), objectKey, tee,
        storageWriteOptions{
            ContentType: r.Header.Get("Content-Type"),
        },
    )
    if err != nil {
        http.Error(w, "storage error", http.StatusInternalServerError)
        return
    }

    // Verify we did not exceed the limit
    if bytesWritten > h.maxSize {
        // Clean up the partial upload
        h.storage.Delete(r.Context(), objectKey)
        http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
        return
    }

    checksum := hex.EncodeToString(hasher.Sum(nil))
    w.Header().Set("X-Checksum-SHA256", checksum)
    w.Header().Set("X-Bytes-Written", strconv.FormatInt(bytesWritten, 10))
    w.WriteHeader(http.StatusCreated)
}
```

### Chunked HTTP Download with Content-Range

```go
package handlers

import (
    "fmt"
    "io"
    "net/http"
    "os"
    "strconv"
    "strings"
)

// ChunkedDownloadHandler serves files with Range request support
type ChunkedDownloadHandler struct {
    basePath string
}

func (h *ChunkedDownloadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    filePath := filepath.Join(h.basePath, filepath.Clean(r.URL.Path))
    f, err := os.Open(filePath)
    if err != nil {
        http.NotFound(w, r)
        return
    }
    defer f.Close()

    fi, err := f.Stat()
    if err != nil {
        http.Error(w, "stat error", http.StatusInternalServerError)
        return
    }

    // http.ServeContent handles Range requests, ETags, and Last-Modified automatically
    // It reads the file in a streaming fashion
    http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

// For streaming from non-seekable sources (S3, GCS), implement Range manually:
func streamWithRange(w http.ResponseWriter, r *http.Request,
    contentLength int64, contentType string,
    openFn func(offset, length int64) (io.ReadCloser, error),
) {
    rangeHeader := r.Header.Get("Range")

    if rangeHeader == "" {
        // Full response
        reader, err := openFn(0, contentLength)
        if err != nil {
            http.Error(w, "open error", http.StatusInternalServerError)
            return
        }
        defer reader.Close()

        w.Header().Set("Content-Type", contentType)
        w.Header().Set("Content-Length", strconv.FormatInt(contentLength, 10))
        w.Header().Set("Accept-Ranges", "bytes")
        io.Copy(w, reader)
        return
    }

    // Parse range: bytes=start-end
    rangeHeader = strings.TrimPrefix(rangeHeader, "bytes=")
    parts := strings.SplitN(rangeHeader, "-", 2)
    if len(parts) != 2 {
        http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
        return
    }

    start, _ := strconv.ParseInt(parts[0], 10, 64)
    end := contentLength - 1
    if parts[1] != "" {
        end, _ = strconv.ParseInt(parts[1], 10, 64)
    }

    if start < 0 || end >= contentLength || start > end {
        w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", contentLength))
        http.Error(w, "range not satisfiable", http.StatusRequestedRangeNotSatisfiable)
        return
    }

    length := end - start + 1
    reader, err := openFn(start, length)
    if err != nil {
        http.Error(w, "open error", http.StatusInternalServerError)
        return
    }
    defer reader.Close()

    w.Header().Set("Content-Type", contentType)
    w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, contentLength))
    w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
    w.WriteHeader(http.StatusPartialContent)
    io.Copy(w, reader)
}
```

## Section 3: S3 Multipart Upload

For files larger than 5 GB or for upload reliability, use S3 multipart upload. Each part is 5 MB to 5 GB; the recommended size is 16-100 MB per part for optimal throughput.

```go
package storage

import (
    "bytes"
    "context"
    "fmt"
    "io"
    "sync"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const (
    minPartSize     = 5 * 1024 * 1024   // 5 MB minimum per S3 spec
    defaultPartSize = 16 * 1024 * 1024  // 16 MB recommended
    maxConcurrency  = 5                  // Parallel upload parts
)

type S3MultipartUploader struct {
    client   *s3.Client
    bucket   string
    partSize int64
}

type UploadResult struct {
    ETag  string
    Key   string
    Bytes int64
}

func (u *S3MultipartUploader) Upload(ctx context.Context, key string, r io.Reader) (*UploadResult, error) {
    // Initialize multipart upload
    createResp, err := u.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
        Bucket:               aws.String(u.bucket),
        Key:                  aws.String(key),
        ServerSideEncryption: types.ServerSideEncryptionAes256,
    })
    if err != nil {
        return nil, fmt.Errorf("create multipart upload: %w", err)
    }

    uploadID := createResp.UploadId
    var (
        completedParts []types.CompletedPart
        mu             sync.Mutex
        uploadErr      error
        wg             sync.WaitGroup
        sem            = make(chan struct{}, maxConcurrency)
        partNum        int32 = 1
        totalBytes     int64
    )

    // Upload parts concurrently
    buf := make([]byte, u.partSize)
    for {
        n, err := io.ReadFull(r, buf)
        if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
            // Abort the multipart upload on read error
            u.abort(ctx, key, uploadID)
            return nil, fmt.Errorf("read part %d: %w", partNum, err)
        }
        if n == 0 {
            break
        }

        partData := make([]byte, n)
        copy(partData, buf[:n])
        currentPart := partNum
        totalBytes += int64(n)

        wg.Add(1)
        sem <- struct{}{}
        go func() {
            defer func() {
                <-sem
                wg.Done()
            }()

            resp, uploadPartErr := u.client.UploadPart(ctx, &s3.UploadPartInput{
                Bucket:     aws.String(u.bucket),
                Key:        aws.String(key),
                UploadId:   uploadID,
                PartNumber: aws.Int32(currentPart),
                Body:       bytes.NewReader(partData),
            })
            if uploadPartErr != nil {
                mu.Lock()
                uploadErr = fmt.Errorf("upload part %d: %w", currentPart, uploadPartErr)
                mu.Unlock()
                return
            }

            mu.Lock()
            completedParts = append(completedParts, types.CompletedPart{
                ETag:       resp.ETag,
                PartNumber: aws.Int32(currentPart),
            })
            mu.Unlock()
        }()

        partNum++

        if err == io.ErrUnexpectedEOF || err == io.EOF {
            break
        }
    }

    wg.Wait()

    if uploadErr != nil {
        u.abort(ctx, key, uploadID)
        return nil, uploadErr
    }

    // Sort parts by part number (goroutines may complete out of order)
    sortCompletedParts(completedParts)

    // Complete the multipart upload
    completeResp, err := u.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
        Bucket:   aws.String(u.bucket),
        Key:      aws.String(key),
        UploadId: uploadID,
        MultipartUpload: &types.CompletedMultipartUpload{
            Parts: completedParts,
        },
    })
    if err != nil {
        u.abort(ctx, key, uploadID)
        return nil, fmt.Errorf("complete multipart upload: %w", err)
    }

    return &UploadResult{
        ETag:  aws.ToString(completeResp.ETag),
        Key:   key,
        Bytes: totalBytes,
    }, nil
}

func (u *S3MultipartUploader) abort(ctx context.Context, key string, uploadID *string) {
    u.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
        Bucket:   aws.String(u.bucket),
        Key:      aws.String(key),
        UploadId: uploadID,
    })
}

func sortCompletedParts(parts []types.CompletedPart) {
    for i := 0; i < len(parts)-1; i++ {
        for j := i + 1; j < len(parts); j++ {
            if aws.ToInt32(parts[i].PartNumber) > aws.ToInt32(parts[j].PartNumber) {
                parts[i], parts[j] = parts[j], parts[i]
            }
        }
    }
}
```

## Section 4: Streaming JSON Parsing

Loading an entire JSON file into memory to unmarshal it fails catastrophically for multi-gigabyte exports. `json.Decoder` processes tokens incrementally:

```go
package parser

import (
    "encoding/json"
    "fmt"
    "io"
)

// Event represents one record in a JSON array
type Event struct {
    ID        string          `json:"id"`
    Timestamp int64           `json:"timestamp"`
    UserID    string          `json:"user_id"`
    Type      string          `json:"type"`
    Data      json.RawMessage `json:"data"`
}

// StreamEvents reads a JSON array from r and calls fn for each event.
// Memory usage is O(1) with respect to array size.
func StreamEvents(r io.Reader, fn func(*Event) error) error {
    dec := json.NewDecoder(r)

    // Read opening bracket
    tok, err := dec.Token()
    if err != nil {
        return fmt.Errorf("expected '[': %w", err)
    }
    if delim, ok := tok.(json.Delim); !ok || delim != '[' {
        return fmt.Errorf("expected '[', got %v", tok)
    }

    for dec.More() {
        var evt Event
        if err := dec.Decode(&evt); err != nil {
            return fmt.Errorf("decode event: %w", err)
        }
        if err := fn(&evt); err != nil {
            return err
        }
    }

    // Read closing bracket
    if _, err := dec.Token(); err != nil && err != io.EOF {
        return fmt.Errorf("expected ']': %w", err)
    }

    return nil
}

// StreamObjects handles a JSON Lines (NDJSON) format — one JSON object per line
func StreamJSONLines(r io.Reader, fn func(*Event) error) error {
    dec := json.NewDecoder(r)
    for {
        var evt Event
        if err := dec.Decode(&evt); err == io.EOF {
            return nil
        } else if err != nil {
            return fmt.Errorf("decode: %w", err)
        }
        if err := fn(&evt); err != nil {
            return err
        }
    }
}

// Usage: process a 10 GB JSON array from S3
func ProcessLargeExport(ctx context.Context, bucket, key string, s3client *s3.Client) error {
    resp, err := s3client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: aws.String(bucket),
        Key:    aws.String(key),
    })
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    // Buffer the S3 response body for efficiency
    buffered := bufio.NewReaderSize(resp.Body, 256*1024)

    var processed int64
    return StreamEvents(buffered, func(evt *Event) error {
        processed++
        if processed%10000 == 0 {
            fmt.Printf("Processed %d events\n", processed)
        }
        return processEvent(evt)
    })
}
```

## Section 5: Bounded Memory Streaming with io.Pipe

`io.Pipe` creates a synchronous in-memory pipe where writes block until the reader consumes the data. This provides built-in backpressure without buffering the entire stream in memory:

```go
package pipeline

import (
    "compress/gzip"
    "context"
    "encoding/csv"
    "io"
)

// DatabaseToGzippedCSV streams query results from a database
// directly to a gzip-compressed CSV without buffering the full result set.
func DatabaseToGzippedCSV(ctx context.Context, db *sql.DB, query string, w io.Writer) error {
    pr, pw := io.Pipe()

    // Writer side: query the database and write CSV
    go func() {
        rows, err := db.QueryContext(ctx, query)
        if err != nil {
            pw.CloseWithError(err)
            return
        }
        defer rows.Close()

        cols, err := rows.Columns()
        if err != nil {
            pw.CloseWithError(err)
            return
        }

        csvWriter := csv.NewWriter(pw)
        if err := csvWriter.Write(cols); err != nil {
            pw.CloseWithError(err)
            return
        }

        scanArgs := make([]interface{}, len(cols))
        values := make([]interface{}, len(cols))
        for i := range values {
            scanArgs[i] = &values[i]
        }

        for rows.Next() {
            if err := rows.Scan(scanArgs...); err != nil {
                pw.CloseWithError(err)
                return
            }
            record := make([]string, len(cols))
            for i, v := range values {
                record[i] = fmt.Sprintf("%v", v)
            }
            if err := csvWriter.Write(record); err != nil {
                pw.CloseWithError(err)
                return
            }
        }

        csvWriter.Flush()
        if err := csvWriter.Error(); err != nil {
            pw.CloseWithError(err)
            return
        }
        pw.Close()
    }()

    // Reader side: compress and write to the destination
    gz, err := gzip.NewWriterLevel(w, gzip.BestSpeed)
    if err != nil {
        pr.CloseWithError(err)
        return err
    }
    defer gz.Close()

    if _, err := io.Copy(gz, pr); err != nil {
        return err
    }

    return gz.Close()
}
```

The pipe's backpressure mechanism ensures the goroutine running the database query only produces as many rows as the compressor can consume. When the HTTP response writer (downstream of the compressor) is slow—due to client-side TCP congestion—the entire pipeline applies back-pressure all the way to the database cursor.

## Section 6: Backpressure in Fan-Out Pipelines

When multiple consumers process a stream, use a channel-based fanout with bounded channel sizes to propagate backpressure:

```go
package pipeline

import (
    "context"
    "sync"
)

// Processor is a stream processing function
type Processor[T any] func(ctx context.Context, item T) error

// FanOut distributes items from a channel to N worker processors.
// When all worker buffers are full, the producer blocks (backpressure).
func FanOut[T any](ctx context.Context,
    source <-chan T,
    concurrency int,
    bufferPerWorker int,
    processor Processor[T],
) error {
    workerChans := make([]chan T, concurrency)
    for i := range workerChans {
        workerChans[i] = make(chan T, bufferPerWorker)
    }

    var wg sync.WaitGroup
    errChan := make(chan error, concurrency)

    // Start workers
    for i, ch := range workerChans {
        wg.Add(1)
        workerCh := ch
        go func() {
            defer wg.Done()
            for item := range workerCh {
                if err := processor(ctx, item); err != nil {
                    errChan <- err
                    return
                }
            }
        }()
        _ = i
    }

    // Distribute items round-robin
    go func() {
        defer func() {
            for _, ch := range workerChans {
                close(ch)
            }
        }()

        idx := 0
        for item := range source {
            select {
            case <-ctx.Done():
                return
            case workerChans[idx] <- item:
                idx = (idx + 1) % concurrency
            }
        }
    }()

    wg.Wait()
    close(errChan)

    return <-errChan
}

// BoundedTransform reads from source, applies transform, and writes to a bounded channel.
// Back-pressure: when the output channel is full, reading from source stops.
func BoundedTransform[In, Out any](
    ctx context.Context,
    source <-chan In,
    bufferSize int,
    transform func(In) (Out, error),
) (<-chan Out, <-chan error) {
    out := make(chan Out, bufferSize)
    errc := make(chan error, 1)

    go func() {
        defer close(out)
        defer close(errc)

        for item := range source {
            select {
            case <-ctx.Done():
                errc <- ctx.Err()
                return
            default:
            }

            result, err := transform(item)
            if err != nil {
                errc <- err
                return
            }

            select {
            case <-ctx.Done():
                errc <- ctx.Err()
                return
            case out <- result:
            }
        }
    }()

    return out, errc
}
```

## Section 7: Progress Tracking for Long-Running Transfers

```go
package pipeline

import (
    "io"
    "sync/atomic"
    "time"
)

// ProgressReader wraps an io.Reader and tracks bytes read atomically.
type ProgressReader struct {
    r         io.Reader
    total     int64
    read      atomic.Int64
    startTime time.Time
}

func NewProgressReader(r io.Reader, totalBytes int64) *ProgressReader {
    return &ProgressReader{
        r:         r,
        total:     totalBytes,
        startTime: time.Now(),
    }
}

func (pr *ProgressReader) Read(p []byte) (int, error) {
    n, err := pr.r.Read(p)
    pr.read.Add(int64(n))
    return n, err
}

func (pr *ProgressReader) BytesRead() int64 {
    return pr.read.Load()
}

func (pr *ProgressReader) Percent() float64 {
    if pr.total <= 0 {
        return 0
    }
    return float64(pr.read.Load()) / float64(pr.total) * 100
}

func (pr *ProgressReader) Speed() float64 {
    elapsed := time.Since(pr.startTime).Seconds()
    if elapsed == 0 {
        return 0
    }
    return float64(pr.read.Load()) / elapsed
}

func (pr *ProgressReader) ETA() time.Duration {
    bytesRead := pr.read.Load()
    if bytesRead == 0 {
        return 0
    }
    elapsed := time.Since(pr.startTime)
    totalTime := time.Duration(float64(elapsed) * float64(pr.total) / float64(bytesRead))
    return totalTime - elapsed
}

// Progress emits progress updates on an interval to a callback
func (pr *ProgressReader) Progress(interval time.Duration, fn func(read, total int64, pct float64)) func() {
    ticker := time.NewTicker(interval)
    done := make(chan struct{})

    go func() {
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                read := pr.read.Load()
                fn(read, pr.total, pr.Percent())
            case <-done:
                return
            }
        }
    }()

    return func() { close(done) }
}
```

### Usage in HTTP Handler

```go
func (h *UploadHandler) handleLargeUpload(w http.ResponseWriter, r *http.Request) {
    contentLength := r.ContentLength
    progressReader := NewProgressReader(r.Body, contentLength)

    // Log progress every 10 seconds
    stopProgress := progressReader.Progress(10*time.Second,
        func(read, total int64, pct float64) {
            slog.Info("upload progress",
                "bytes_read", read,
                "total", total,
                "percent", fmt.Sprintf("%.1f%%", pct),
                "speed_mbps", fmt.Sprintf("%.1f", progressReader.Speed()/1024/1024),
                "eta", progressReader.ETA().Round(time.Second),
            )
        },
    )
    defer stopProgress()

    result, err := h.uploader.Upload(r.Context(), "uploads/"+r.URL.Path, progressReader)
    if err != nil {
        http.Error(w, "upload failed", http.StatusInternalServerError)
        return
    }

    slog.Info("upload complete",
        "key", result.Key,
        "bytes", result.Bytes,
        "etag", result.ETag,
    )

    w.Header().Set("ETag", result.ETag)
    w.WriteHeader(http.StatusCreated)
}
```

## Section 8: Memory Profiling Streaming Pipelines

```go
package pipeline_test

import (
    "runtime"
    "testing"
)

func TestStreamingMemoryUsage(t *testing.T) {
    const fileSize = 100 * 1024 * 1024 // 100 MB

    // Force GC to get a clean baseline
    runtime.GC()
    var memBefore runtime.MemStats
    runtime.ReadMemStats(&memBefore)

    // Run the streaming pipeline
    pr, pw := io.Pipe()
    go func() {
        defer pw.Close()
        // Simulate writing 100 MB
        buf := make([]byte, 65536)
        written := 0
        for written < fileSize {
            n := copy(buf, generateTestData(len(buf)))
            pw.Write(buf[:n])
            written += n
        }
    }()

    // Consume via streaming processor (should use constant memory)
    var consumed int64
    err := StreamEvents(pr, func(evt *Event) error {
        consumed++
        return nil
    })

    runtime.GC()
    var memAfter runtime.MemStats
    runtime.ReadMemStats(&memAfter)

    heapGrowth := int64(memAfter.HeapInuse) - int64(memBefore.HeapInuse)
    t.Logf("Heap growth: %d bytes (%.2f MB) for %d MB input",
        heapGrowth, float64(heapGrowth)/1024/1024, fileSize/1024/1024)

    // Assert heap growth is well below file size
    maxAcceptableGrowth := int64(10 * 1024 * 1024) // 10 MB
    if heapGrowth > maxAcceptableGrowth {
        t.Errorf("heap grew by %d bytes, expected less than %d",
            heapGrowth, maxAcceptableGrowth)
    }
}
```

The io.Reader pipeline model is Go's most powerful tool for memory-efficient data processing. When every stage in the pipeline reads only what it needs and yields control back to the caller, the total memory footprint becomes a function of the pipeline's buffer sizes, not the size of the data being processed.
