---
title: "Go CGO: Calling C Libraries and Avoiding the Performance Pitfalls"
date: 2028-11-21T00:00:00-05:00
draft: false
tags: ["Go", "CGO", "C", "Performance", "Systems Programming"]
categories:
- Go
- Systems Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to CGO: calling C libraries from Go, managing memory correctly, understanding the performance costs of goroutine-to-OS-thread pinning, and deciding when to use CGO versus pure Go alternatives."
more_link: "yes"
url: "/go-cgo-interop-c-libraries-guide/"
---

CGO enables Go programs to call C functions and use C libraries. It is the bridge that makes Go usable for systems programming when a mature C library exists and rewriting it is impractical. CGO is also one of the most misunderstood parts of the Go ecosystem, leading to memory leaks, performance cliffs, and build complexity that surprises teams at the worst moments.

This guide covers CGO from first principles through production deployment, including memory management, type conversions, performance characteristics, cross-compilation in Docker, and the strategic question of when CGO is the right choice.

<!--more-->

# Go CGO: Calling C Libraries Without Shooting Yourself in the Foot

## What CGO Is and Is Not

CGO is a tool that generates Go and C glue code allowing Go programs to call C functions. It is **not** a way to run Go at C speed. Every CGO call crosses a boundary that has real overhead: the Go scheduler must pin the goroutine to an OS thread, manage stack switches, and invoke the C ABI. For individual calls, this overhead is around 40-200ns depending on the platform.

CGO is appropriate when:
- A well-maintained C library exists (OpenSSL, SQLite, librdkafka, BLAS/LAPACK)
- The library is called infrequently enough that overhead is acceptable
- The C calls are batch operations where crossing the boundary amortizes the cost
- No pure-Go alternative exists with acceptable quality

CGO is not appropriate when:
- You need to call C from a tight inner loop millions of times per second
- You want to cross-compile easily (CGO complicates this significantly)
- You need to deploy to environments without a C compiler/libc
- The C library has unstable memory semantics

## Basic CGO Structure

### Hello World with a C Function

```go
// main.go
package main

/*
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

int add(int a, int b) {
    return a + b;
}

char* repeat_string(const char* s, int n) {
    int len = strlen(s);
    char* result = (char*)malloc(len * n + 1);
    if (result == NULL) return NULL;
    result[0] = '\0';
    for (int i = 0; i < n; i++) {
        strcat(result, s);
    }
    return result;
}
*/
import "C"

import (
    "fmt"
    "unsafe"
)

func main() {
    result := C.add(C.int(3), C.int(4))
    fmt.Printf("3 + 4 = %d\n", int(result))

    cstr := C.CString("hello ")
    defer C.free(unsafe.Pointer(cstr))

    repeated := C.repeat_string(cstr, C.int(3))
    if repeated != nil {
        goStr := C.GoString(repeated)
        C.free(unsafe.Pointer(repeated))
        fmt.Println(goStr)
    }
}
```

The `import "C"` must immediately follow the comment block containing C code or includes. No blank line between the comment and `import "C"`.

### Type Conversion Reference

```go
package main

/*
#include <stdint.h>
*/
import "C"
import "unsafe"

func numericConversions() {
    var goInt int = 42
    var cInt C.int = C.int(goInt)
    _ = int(cInt)

    var goInt64 int64 = 9999999999
    var cLong C.longlong = C.longlong(goInt64)
    _ = int64(cLong)

    var goFloat64 float64 = 3.14
    var cDouble C.double = C.double(goFloat64)
    _ = float64(cDouble)

    var goSize int = 1024
    var cSize C.size_t = C.size_t(goSize)
    _ = int(cSize)
}

func stringConversions() {
    goStr := "hello, world"
    cStr := C.CString(goStr)
    defer C.free(unsafe.Pointer(cStr))

    goStrBack := C.GoString(cStr)
    _ = goStrBack

    goBytes := []byte("raw data")
    cBytes := C.CBytes(goBytes)
    defer C.free(cBytes)

    cBuf := C.CString("buffer data")
    defer C.free(unsafe.Pointer(cBuf))
    goFromBuf := C.GoBytes(unsafe.Pointer(cBuf), C.int(11))
    _ = goFromBuf
}
```

## Calling External C Libraries

### Linking a Shared Library

```go
// sqlite.go - wrapping SQLite
package db

/*
#cgo LDFLAGS: -lsqlite3
#cgo CFLAGS: -I/usr/include
#include <sqlite3.h>
#include <stdlib.h>
*/
import "C"

import (
    "errors"
    "fmt"
    "unsafe"
)

type DB struct {
    db *C.sqlite3
}

func Open(path string) (*DB, error) {
    cPath := C.CString(path)
    defer C.free(unsafe.Pointer(cPath))

    var db *C.sqlite3
    rc := C.sqlite3_open(cPath, &db)
    if rc != C.SQLITE_OK {
        errMsg := C.GoString(C.sqlite3_errmsg(db))
        C.sqlite3_close(db)
        return nil, fmt.Errorf("sqlite3_open: %s", errMsg)
    }

    return &DB{db: db}, nil
}

func (d *DB) Close() error {
    if d.db == nil {
        return nil
    }
    rc := C.sqlite3_close(d.db)
    d.db = nil
    if rc != C.SQLITE_OK {
        return fmt.Errorf("sqlite3_close: error code %d", int(rc))
    }
    return nil
}

func (d *DB) Exec(sql string) error {
    cSQL := C.CString(sql)
    defer C.free(unsafe.Pointer(cSQL))

    var errMsg *C.char
    rc := C.sqlite3_exec(d.db, cSQL, nil, nil, &errMsg)
    if rc != C.SQLITE_OK {
        goErr := C.GoString(errMsg)
        C.sqlite3_free(unsafe.Pointer(errMsg))
        return errors.New(goErr)
    }
    return nil
}
```

### pkg-config Integration

```go
// libcurl.go
package curl

/*
#cgo pkg-config: libcurl
#include <curl/curl.h>
#include <stdlib.h>
*/
import "C"
import "fmt"

type Handle struct {
    curl *C.CURL
}

func NewHandle() (*Handle, error) {
    handle := C.curl_easy_init()
    if handle == nil {
        return nil, fmt.Errorf("curl_easy_init failed")
    }
    return &Handle{curl: handle}, nil
}

func (h *Handle) Cleanup() {
    C.curl_easy_cleanup(h.curl)
}
```

### Linking a Static Library with SRCDIR

```go
// libcompute.go
package compute

/*
#cgo LDFLAGS: -L${SRCDIR}/lib -lcompute -lm
#cgo CFLAGS: -I${SRCDIR}/include
#include "compute.h"
*/
import "C"
```

The `${SRCDIR}` variable resolves to the directory containing the Go source file, which is useful for bundling C libraries with your module.

## Memory Management: The Critical Rules

Memory bugs with CGO are the most common production issue. The rules are strict.

### Rule 1: C.CString Must Always Be Freed

```go
// WRONG - memory leak
func wrong() {
    cstr := C.CString("leaked string")
    someFunc(cstr) // cstr allocated in C heap, never freed
}

// CORRECT - always defer free immediately after allocation
func correct() {
    cstr := C.CString("properly freed string")
    defer C.free(unsafe.Pointer(cstr))
    someFunc(cstr)
}

// CORRECT for early return paths - defer runs even on early return
func withEarlyReturn(shouldReturn bool) error {
    cstr := C.CString("string")
    defer C.free(unsafe.Pointer(cstr))

    if shouldReturn {
        return fmt.Errorf("returning early")
    }
    return nil
}
```

### Rule 2: Do Not Keep Go Pointers in C Memory

The Go garbage collector can move Go memory. C code holding a Go pointer is undefined behavior.

```go
// WRONG - passing Go pointer to C to hold long-term
// C.register_callback(unsafe.Pointer(&goSlice[0])) // GC may move this

// CORRECT - use C memory for data that C needs to hold
type GoodCallback struct {
    cData unsafe.Pointer
    size  int
}

func NewGoodCallback(data []byte) *GoodCallback {
    cData := C.malloc(C.size_t(len(data)))
    if cData == nil {
        panic("C.malloc failed")
    }
    C.memcpy(cData, unsafe.Pointer(&data[0]), C.size_t(len(data)))
    return &GoodCallback{cData: cData, size: len(data)}
}

func (g *GoodCallback) Free() {
    if g.cData != nil {
        C.free(g.cData)
        g.cData = nil
    }
}
```

### Rule 3: Use runtime/cgo.Handle for Callbacks

When C code needs to call back into Go, use the standard library handle:

```go
// callbacks.go
package cgohandle

import "C"
import (
    "fmt"
    "runtime/cgo"
)

func RegisterCallback(fn func(int)) cgo.Handle {
    return cgo.NewHandle(fn)
}

//export callbackBridge
func callbackBridge(handle C.uintptr_t, result C.int) {
    h := cgo.Handle(handle)
    fn := h.Value().(func(int))
    fn(int(result))
}

// Caller is responsible for h.Delete() when done
func Example() {
    h := RegisterCallback(func(result int) {
        fmt.Printf("C called back with: %d\n", result)
    })
    defer h.Delete()

    // Pass uintptr(h) to C as the userdata pointer
}
```

## Performance Characteristics

### Measuring CGO Call Overhead

```go
// bench_test.go
package cgo_bench

/*
#include <stdint.h>

int64_t noop(int64_t x) {
    return x;
}
*/
import "C"

import "testing"

func BenchmarkCGOCall(b *testing.B) {
    x := C.int64_t(42)
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        C.noop(x)
    }
}

func goNoop(x int64) int64 { return x }

func BenchmarkGoCall(b *testing.B) {
    x := int64(42)
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = goNoop(x)
    }
}
```

Typical results on a modern server:

```
BenchmarkCGOCall-8    20000000    ~80 ns/op
BenchmarkGoCall-8    1000000000    ~0.3 ns/op
```

CGO calls are approximately 200x slower than Go function calls. Design your API to minimize crossing frequency.

### Batch Operations to Amortize Overhead

```go
// BAD: Many small CGO calls - N crossings for N elements
func processSliceBad(data []float64) []float64 {
    result := make([]float64, len(data))
    for i, v := range data {
        result[i] = float64(C.expensive_transform(C.double(v)))
    }
    return result
}

// GOOD: One CGO call over the whole slice - 1 crossing for N elements
//
// C side:
// void transform_slice(double* input, double* output, int n) {
//     for (int i = 0; i < n; i++) {
//         output[i] = expensive_transform(input[i]);
//     }
// }

func processSliceGood(data []float64) []float64 {
    if len(data) == 0 {
        return nil
    }
    result := make([]float64, len(data))
    C.transform_slice(
        (*C.double)(&data[0]),
        (*C.double)(&result[0]),
        C.int(len(data)),
    )
    return result
}
```

### Worker Pool to Bound OS Thread Consumption

CGO calls lock the goroutine to an OS thread. With GOMAXPROCS=8 and 100 simultaneous slow CGO calls, you have 100 OS threads blocked. Use a pool:

```go
// cgocallpool.go
package cgocallpool

/*
#include <unistd.h>

void slow_c_operation(int ms) {
    usleep(ms * 1000);
}
*/
import "C"

import (
    "context"
    "sync"
)

type Pool struct {
    queue chan workItem
    wg    sync.WaitGroup
}

type workItem struct {
    durationMs int
    done       chan struct{}
}

func NewPool(workers int) *Pool {
    p := &Pool{
        queue: make(chan workItem, workers*4),
    }
    for i := 0; i < workers; i++ {
        p.wg.Add(1)
        go p.worker()
    }
    return p
}

func (p *Pool) worker() {
    defer p.wg.Done()
    for item := range p.queue {
        C.slow_c_operation(C.int(item.durationMs))
        close(item.done)
    }
}

func (p *Pool) Submit(ctx context.Context, durationMs int) error {
    item := workItem{
        durationMs: durationMs,
        done:       make(chan struct{}),
    }
    select {
    case p.queue <- item:
    case <-ctx.Done():
        return ctx.Err()
    }
    select {
    case <-item.done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func (p *Pool) Shutdown() {
    close(p.queue)
    p.wg.Wait()
}
```

## Cross-Compilation with CGO

### Docker Multi-Stage Cross-Compilation

```dockerfile
# Dockerfile.cross - build ARM64 binary on AMD64 host
FROM --platform=linux/amd64 golang:1.23 AS builder

RUN apt-get update && apt-get install -y \
    gcc-aarch64-linux-gnu \
    g++-aarch64-linux-gnu \
    libsqlite3-dev:arm64 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .

ENV GOOS=linux
ENV GOARCH=arm64
ENV CGO_ENABLED=1
ENV CC=aarch64-linux-gnu-gcc
ENV CXX=aarch64-linux-gnu-g++
ENV PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig

RUN go build -o /app/server-arm64 ./cmd/server

FROM --platform=linux/arm64 debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y libsqlite3-0 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/server-arm64 /app/server
ENTRYPOINT ["/app/server"]
```

### Truly Static Binaries with Alpine/musl

```dockerfile
FROM golang:1.23-alpine AS builder
RUN apk add --no-cache gcc musl-dev sqlite-static

ENV CGO_ENABLED=1
ENV CGO_LDFLAGS="-static"

RUN go build \
    -ldflags="-extldflags=-static" \
    -tags "sqlite_omit_load_extension" \
    -o /app/server \
    ./cmd/server
```

Verify the binary is truly static:

```bash
file /app/server
# server: ELF 64-bit LSB executable, x86-64, statically linked

ldd /app/server
# not a dynamic executable
```

## Profiling CGO-Heavy Code

```go
// Expose pprof endpoint in your server
import (
    _ "net/http/pprof"
    "net/http"
    "log"
)

func startPprof() {
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()
}
```

```bash
# CPU profile - 30 second capture
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# In pprof interactive shell
(pprof) top20
(pprof) list MyGoFunction
(pprof) web

# Count goroutines stuck in CGO calls
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 | grep -c "cgocall"
```

## When to Use Pure Go Instead

Several C libraries have mature pure-Go alternatives:

| C Library | Pure Go Alternative | Notes |
|-----------|---------------------|-------|
| openssl | `crypto/tls` + `golang.org/x/crypto` | Standard library covers most cases |
| libpq | `jackc/pgx` | Superior Go-native PostgreSQL driver |
| sqlite3 | `modernc.org/sqlite` | C code transpiled to Go, no CGO |
| librdkafka | `segmentio/kafka-go` | Good performance, CGO-free |
| zlib | `compress/zlib` | Standard library |
| libcrypto | `crypto/sha256`, etc. | Standard library, often faster |

The `modernc.org/sqlite` deserves special attention: it is the SQLite C source code transpiled to Go using a C-to-Go transpiler, providing identical behavior without CGO:

```go
// Pure Go SQLite - no CGO, no cross-compilation issues
import (
    "database/sql"
    _ "modernc.org/sqlite"
)

func openDB(path string) (*sql.DB, error) {
    return sql.Open("sqlite", path)
}
```

## Data Race Detection

CGO code is outside the Go race detector's view. To catch races in the Go side of CGO interactions:

```bash
# Build and test with race detector
go test -race ./...

# Run binary with race detector
go build -race -o server ./cmd/server
./server
```

For detecting races in the C code itself, use AddressSanitizer during development:

```go
// asan_test.go - build tag for ASAN testing
//go:build asan

package main

/*
#cgo CFLAGS: -fsanitize=address
#cgo LDFLAGS: -fsanitize=address
*/
import "C"
```

```bash
go test -tags asan -sanitize=address ./...
```

## Summary

CGO is a sharp tool that enables Go to leverage the C ecosystem at the cost of complexity in build, memory management, and concurrency model. The key rules for production use:

1. Always `defer C.free()` immediately after `C.CString()` or `C.CBytes()`
2. Never store Go pointers in C memory; use `runtime/cgo.Handle` for callbacks
3. Batch operations to minimize the number of CGO boundary crossings
4. Use worker pools to bound OS thread consumption from blocking CGO calls
5. Use `${SRCDIR}` for bundled libraries and pkg-config for system libraries
6. Consider `modernc.org/sqlite` and similar transpiled libraries to avoid CGO entirely
7. Profile with both pprof and perf to see the full picture
8. Test cross-compilation in CI with Docker multi-stage builds

The decision matrix: if a pure-Go alternative exists with comparable quality, use it. If you need a specific C library and calls are infrequent or batch-oriented, CGO is the right choice. If calls are high-frequency in a hot path, redesign the interface to batch them.
