---
title: "Go CGO and Native Library Integration: When and How to Use C Bindings"
date: 2030-10-13T00:00:00-05:00
draft: false
tags: ["Go", "CGO", "C Bindings", "Performance", "Cross-Platform", "Native Libraries"]
categories:
- Go
- Systems Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise CGO guide covering cgo build tags, C header inclusion, Go-C type marshaling, memory ownership across the FFI boundary, performance overhead analysis, cross-platform binary builds, and CGO alternatives."
more_link: "yes"
url: "/go-cgo-native-library-integration-c-bindings-guide/"
---

CGO enables Go programs to call C code and vice versa, opening access to decades of battle-tested C libraries: cryptographic primitives, database drivers, compression codecs, signal processing libraries, and hardware accelerators. Understanding when CGO provides genuine value versus when it introduces avoidable complexity is one of the more consequential architectural decisions in a Go service's lifetime.

<!--more-->

## When CGO Is the Right Choice

Before examining the mechanics, evaluate whether CGO is justified for the use case at hand. The primary legitimate reasons to use CGO in production are:

1. **No pure-Go equivalent exists**: libsodium, OpenSSL's hardware acceleration, libjpeg-turbo, RocksDB, FFTW
2. **Performance-critical paths with proven C implementations**: AES-NI instruction access, SIMD-optimized routines
3. **System-level API requirements**: Linux io_uring via liburing, platform-specific security APIs
4. **Regulatory compliance**: FIPS 140-2 validated cryptographic modules that cannot be reimplemented

Cases where CGO should be avoided: wrapping libraries that have maintained pure-Go equivalents (net/http vs libcurl, encoding/json vs cJSON), prototyping, services with strict deployment simplicity requirements, and programs that must run in scratch containers without libc.

## CGO Build System Fundamentals

### Build Tags and Conditional Compilation

```go
// file: crypto_cgo.go
//go:build cgo && linux
// +build cgo linux

package crypto

// #cgo CFLAGS: -I/usr/local/include/sodium -O2 -fPIC
// #cgo LDFLAGS: -L/usr/local/lib -lsodium -Wl,-rpath,/usr/local/lib
// #cgo pkg-config: libsodium
//
// #include <sodium.h>
// #include <stdlib.h>
import "C"

import (
    "fmt"
    "unsafe"
)

func init() {
    if C.sodium_init() < 0 {
        panic("libsodium initialization failed")
    }
}

// SecretBoxSeal encrypts and authenticates a message using XSalsa20-Poly1305.
func SecretBoxSeal(message, key []byte) ([]byte, error) {
    if len(key) != int(C.crypto_secretbox_KEYBYTES) {
        return nil, fmt.Errorf("invalid key length: got %d, want %d",
            len(key), C.crypto_secretbox_KEYBYTES)
    }

    // Generate nonce
    nonce := make([]byte, C.crypto_secretbox_NONCEBYTES)
    C.randombytes_buf(
        unsafe.Pointer(&nonce[0]),
        C.size_t(len(nonce)),
    )

    ciphertext := make([]byte, C.crypto_secretbox_MACBYTES+C.ulong(len(message)))

    ret := C.crypto_secretbox_easy(
        (*C.uchar)(unsafe.Pointer(&ciphertext[0])),
        (*C.uchar)(unsafe.Pointer(&message[0])),
        C.ulonglong(len(message)),
        (*C.uchar)(unsafe.Pointer(&nonce[0])),
        (*C.uchar)(unsafe.Pointer(&key[0])),
    )
    if ret != 0 {
        return nil, fmt.Errorf("encryption failed")
    }

    return append(nonce, ciphertext...), nil
}
```

```go
// file: crypto_pure.go
//go:build !cgo || !linux
// +build !cgo !linux

package crypto

import (
    "golang.org/x/crypto/nacl/secretbox"
    "crypto/rand"
    "fmt"
    "io"
)

// SecretBoxSeal provides a pure-Go fallback for non-CGO builds.
func SecretBoxSeal(message, key []byte) ([]byte, error) {
    if len(key) != 32 {
        return nil, fmt.Errorf("invalid key length: got %d, want 32", len(key))
    }

    var nonce [24]byte
    if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
        return nil, fmt.Errorf("nonce generation failed: %w", err)
    }

    var k [32]byte
    copy(k[:], key)

    sealed := secretbox.Seal(nonce[:], message, &nonce, &k)
    return sealed, nil
}
```

### Makefile for CGO Builds

```makefile
# Makefile

CGO_ENABLED ?= 1
GOOS        ?= linux
GOARCH      ?= amd64

# Static build with CGO
.PHONY: build-static
build-static:
	CGO_ENABLED=$(CGO_ENABLED) \
	GOOS=$(GOOS) \
	GOARCH=$(GOARCH) \
	CC=musl-gcc \
	go build \
		-ldflags='-extldflags "-static" -s -w' \
		-tags netgo \
		-o bin/server \
		./cmd/server

# Dynamic build for development
.PHONY: build-dynamic
build-dynamic:
	CGO_ENABLED=1 \
	go build \
		-ldflags='-s -w' \
		-o bin/server-dev \
		./cmd/server

# Cross-compilation for ARM64
.PHONY: build-arm64
build-arm64:
	CGO_ENABLED=1 \
	GOOS=linux \
	GOARCH=arm64 \
	CC=aarch64-linux-gnu-gcc \
	CGO_CFLAGS="-I/usr/aarch64-linux-gnu/include" \
	CGO_LDFLAGS="-L/usr/aarch64-linux-gnu/lib" \
	go build \
		-o bin/server-arm64 \
		./cmd/server

# Run tests without CGO for CI
.PHONY: test-pure
test-pure:
	CGO_ENABLED=0 go test ./...

# Run tests with CGO for integration
.PHONY: test-cgo
test-cgo:
	CGO_ENABLED=1 go test -tags cgo ./...
```

## Type Marshaling Between Go and C

### Primitive Type Conversions

```go
package bridge

// #include <stdint.h>
// #include <string.h>
import "C"

import (
    "unsafe"
)

// GoIntToCInt converts a Go int to a C int safely.
// CGO does not automatically convert between Go int and C int
// due to platform-dependent sizing.
func GoIntToCInt(v int) C.int {
    return C.int(v)
}

// CStringToGoString converts a null-terminated C string to a Go string.
// The C memory is NOT freed by this function.
func CStringToGoString(cs *C.char) string {
    return C.GoString(cs)
}

// GoStringToCString converts a Go string to a heap-allocated C string.
// IMPORTANT: Caller must call C.free() on the returned pointer.
func GoStringToCString(s string) *C.char {
    return C.CString(s)
}

// GoBytesToCBytes copies Go bytes into a C buffer.
// The C buffer must have at least len(b) bytes allocated.
func GoBytesToCBuffer(b []byte, buf *C.uchar, bufLen C.size_t) {
    if len(b) == 0 {
        return
    }
    C.memcpy(
        unsafe.Pointer(buf),
        unsafe.Pointer(&b[0]),
        C.size_t(len(b)),
    )
}

// CBufferToGoBytes creates a Go byte slice backed by C memory.
// The slice becomes invalid when the C memory is freed.
// Use this only when you immediately copy the data.
func CBufferToGoBytes(buf unsafe.Pointer, size int) []byte {
    return (*[1 << 30]byte)(buf)[:size:size]
}
```

### Struct Marshaling

```go
package bridge

// #include <stdint.h>
//
// typedef struct {
//     uint64_t id;
//     char     name[256];
//     double   score;
//     uint8_t  tags[32];
//     uint32_t tag_count;
// } record_t;
//
// void process_records(record_t* records, size_t count);
import "C"

import (
    "fmt"
    "unsafe"
)

// GoRecord is the Go-side representation of record_t.
type GoRecord struct {
    ID       uint64
    Name     string
    Score    float64
    Tags     []byte
}

// toC converts a GoRecord into the CGO struct representation.
// The returned struct contains a name buffer that is valid for
// the lifetime of the returned value.
func (r *GoRecord) toC() (C.record_t, error) {
    var cr C.record_t

    cr.id = C.uint64_t(r.ID)
    cr.score = C.double(r.Score)

    // Copy name safely, ensuring null termination
    nameBytes := []byte(r.Name)
    if len(nameBytes) >= 256 {
        return cr, fmt.Errorf("name exceeds 255 bytes: %d", len(nameBytes))
    }
    for i, b := range nameBytes {
        cr.name[i] = C.char(b)
    }
    cr.name[len(nameBytes)] = 0 // explicit null terminator

    // Copy tags
    tagCount := len(r.Tags)
    if tagCount > 32 {
        tagCount = 32
    }
    for i := 0; i < tagCount; i++ {
        cr.tags[i] = C.uint8_t(r.Tags[i])
    }
    cr.tag_count = C.uint32_t(tagCount)

    return cr, nil
}

// ProcessRecordBatch sends a batch of Go records to a C processing function.
func ProcessRecordBatch(records []GoRecord) error {
    if len(records) == 0 {
        return nil
    }

    cRecords := make([]C.record_t, len(records))
    for i, r := range records {
        cr, err := r.toC()
        if err != nil {
            return fmt.Errorf("record %d conversion failed: %w", i, err)
        }
        cRecords[i] = cr
    }

    C.process_records(
        (*C.record_t)(unsafe.Pointer(&cRecords[0])),
        C.size_t(len(cRecords)),
    )

    return nil
}
```

## Memory Ownership Across the CGO Boundary

### The Fundamental Rule

Go's garbage collector does not track C memory. C's allocator does not track Go memory. Violating ownership boundaries causes memory leaks, use-after-free bugs, and heap corruption.

```go
package memory

// #include <stdlib.h>
// #include <string.h>
//
// char* allocate_buffer(size_t size) {
//     return (char*)malloc(size);
// }
//
// void fill_buffer(char* buf, size_t size, char val) {
//     memset(buf, val, size);
// }
import "C"

import (
    "runtime"
    "sync"
    "unsafe"
)

// ManagedCBuffer wraps a C-allocated buffer with automatic cleanup.
type ManagedCBuffer struct {
    ptr  unsafe.Pointer
    size int
    mu   sync.Mutex
}

// NewManagedCBuffer allocates a C buffer and registers a finalizer.
func NewManagedCBuffer(size int) *ManagedCBuffer {
    ptr := C.allocate_buffer(C.size_t(size))
    if ptr == nil {
        return nil
    }

    b := &ManagedCBuffer{
        ptr:  unsafe.Pointer(ptr),
        size: size,
    }

    // Register GC finalizer as safety net.
    // Prefer explicit Close() calls in production code.
    runtime.SetFinalizer(b, (*ManagedCBuffer).Close)

    return b
}

// Close frees the C buffer. Safe to call multiple times.
func (b *ManagedCBuffer) Close() {
    b.mu.Lock()
    defer b.mu.Unlock()

    if b.ptr != nil {
        C.free(b.ptr)
        b.ptr = nil
    }

    runtime.SetFinalizer(b, nil)
}

// Bytes returns a Go slice backed by the C buffer.
// The slice is valid only while the ManagedCBuffer is alive and not closed.
func (b *ManagedCBuffer) Bytes() []byte {
    b.mu.Lock()
    defer b.mu.Unlock()

    if b.ptr == nil {
        return nil
    }
    return (*[1 << 30]byte)(b.ptr)[:b.size:b.size]
}

// Fill fills the C buffer with the given byte value.
func (b *ManagedCBuffer) Fill(val byte) {
    b.mu.Lock()
    defer b.mu.Unlock()

    if b.ptr == nil {
        return
    }
    C.fill_buffer((*C.char)(b.ptr), C.size_t(b.size), C.char(val))
}
```

### Preventing Go Pointers From Escaping to C

The CGO pointer-passing rules prohibit passing a Go pointer to C if the Go memory contains other Go pointers. Use pinning or copy-based strategies:

```go
package pinning

// #include <stdlib.h>
//
// typedef void (*callback_fn)(void* ctx, const char* data, size_t len);
//
// void register_callback(callback_fn fn, void* ctx);
// void trigger_callback();
import "C"

import (
    "runtime/cgo"
    "unsafe"
)

// CallbackHandler receives callbacks from C code.
type CallbackHandler struct {
    handler func(data []byte)
}

//export goCallbackBridge
func goCallbackBridge(ctx unsafe.Pointer, data *C.char, length C.size_t) {
    // Retrieve the Go object from the cgo.Handle
    h := *(*cgo.Handle)(ctx)
    handler := h.Value().(*CallbackHandler)

    // Copy C data to Go before the callback can return
    goData := C.GoBytes(unsafe.Pointer(data), C.int(length))
    handler.handler(goData)
}

// RegisterCallback registers a Go callback with the C library.
// Returns a cleanup function that must be called when done.
func RegisterCallback(fn func(data []byte)) func() {
    handler := &CallbackHandler{handler: fn}

    // cgo.NewHandle stores the Go pointer safely
    h := cgo.NewHandle(handler)

    // Pass the handle value (an integer) to C, not a Go pointer
    C.register_callback(
        (*[0]byte)(C.goCallbackBridge),
        unsafe.Pointer(&h),
    )

    return func() {
        h.Delete()
    }
}
```

## CGO Performance Overhead

### Benchmarking CGO Call Cost

```go
// file: bench_test.go
package benchmark_test

import (
    "testing"
)

// #include <math.h>
import "C"

import "math"

// BenchmarkCGOCall measures the overhead of a CGO function call.
func BenchmarkCGOCall(b *testing.B) {
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            _ = C.sqrt(C.double(2.0))
        }
    })
}

// BenchmarkPureGoCall measures an equivalent pure-Go function call.
func BenchmarkPureGoCall(b *testing.B) {
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            _ = math.Sqrt(2.0)
        }
    })
}

// BenchmarkCGOBatchCall demonstrates amortizing CGO overhead over batch work.
func BenchmarkCGOBatchCall(b *testing.B) {
    const batchSize = 1000
    data := make([]float64, batchSize)
    for i := range data {
        data[i] = float64(i + 1)
    }

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            for i, v := range data {
                data[i] = float64(C.sqrt(C.double(v)))
            }
        }
    })
}
```

Typical results show CGO calls costing 30-100ns per invocation due to goroutine stack switching, Go scheduler interaction, and thread-pinning overhead. Design CGO interfaces to batch operations rather than making many small calls.

### Reducing CGO Call Frequency

```go
package compression

// #include <zlib.h>
// #include <stdlib.h>
//
// // Wrapper to compress an entire buffer in a single CGO call
// int compress_buffer(
//     const uint8_t* src, size_t src_len,
//     uint8_t* dst, size_t* dst_len,
//     int level
// ) {
//     uLongf destLen = *dst_len;
//     int ret = compress2(dst, &destLen, src, src_len, level);
//     *dst_len = destLen;
//     return ret;
// }
import "C"

import (
    "fmt"
    "unsafe"
)

// CompressBuffer compresses data in a single CGO call, minimizing overhead.
// Using a single batch call instead of streaming via multiple CGO round-trips.
func CompressBuffer(data []byte, level int) ([]byte, error) {
    if len(data) == 0 {
        return nil, nil
    }

    // zlib worst-case output size
    maxOutputSize := len(data) + len(data)/1000 + 12 + 4
    output := make([]byte, maxOutputSize)
    outputLen := C.size_t(maxOutputSize)

    ret := C.compress_buffer(
        (*C.uint8_t)(unsafe.Pointer(&data[0])),
        C.size_t(len(data)),
        (*C.uint8_t)(unsafe.Pointer(&output[0])),
        &outputLen,
        C.int(level),
    )

    if ret != C.Z_OK {
        return nil, fmt.Errorf("zlib compression failed: error code %d", ret)
    }

    return output[:outputLen], nil
}
```

## Cross-Platform Binary Builds with CGO

### Docker Multi-Stage Cross-Compilation

```dockerfile
# Dockerfile.cross-compile

# Stage 1: Build for linux/amd64
FROM --platform=linux/amd64 golang:1.23-bullseye AS builder-amd64

RUN apt-get update && apt-get install -y \
    gcc \
    libc6-dev \
    libsodium-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
    go build -ldflags='-extldflags "-static" -s -w' \
    -o /out/server-amd64 ./cmd/server

# Stage 2: Build for linux/arm64
FROM --platform=linux/amd64 golang:1.23-bullseye AS builder-arm64

RUN apt-get update && apt-get install -y \
    gcc-aarch64-linux-gnu \
    libc6-dev-arm64-cross \
    && rm -rf /var/lib/apt/lists/*

# Install ARM64 libsodium
RUN wget https://download.libsodium.org/libsodium/releases/libsodium-1.0.18-stable.tar.gz \
    && tar xzf libsodium-1.0.18-stable.tar.gz \
    && cd libsodium-stable \
    && ./configure --host=aarch64-linux-gnu \
                   --prefix=/usr/aarch64-linux-gnu \
    && make -j4 && make install

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 GOOS=linux GOARCH=arm64 \
    CC=aarch64-linux-gnu-gcc \
    CGO_CFLAGS="-I/usr/aarch64-linux-gnu/include" \
    CGO_LDFLAGS="-L/usr/aarch64-linux-gnu/lib -lsodium" \
    go build -ldflags='-extldflags "-static" -s -w' \
    -o /out/server-arm64 ./cmd/server

# Final runtime images
FROM scratch AS runtime-amd64
COPY --from=builder-amd64 /out/server-amd64 /server
ENTRYPOINT ["/server"]

FROM scratch AS runtime-arm64
COPY --from=builder-arm64 /out/server-arm64 /server
ENTRYPOINT ["/server"]
```

### GitHub Actions CI for CGO Cross-Compilation

```yaml
# .github/workflows/build-cgo.yaml
name: CGO Cross-Platform Build

on:
  push:
    branches: [main, release/*]
  pull_request:
    branches: [main]

jobs:
  build-matrix:
    strategy:
      matrix:
        include:
          - goos: linux
            goarch: amd64
            cc: gcc
            cgo_flags: ""
          - goos: linux
            goarch: arm64
            cc: aarch64-linux-gnu-gcc
            cgo_flags: "-I/usr/aarch64-linux-gnu/include"
          - goos: linux
            goarch: arm
            goarm: 7
            cc: arm-linux-gnueabihf-gcc
            cgo_flags: "-I/usr/arm-linux-gnueabihf/include"

    runs-on: ubuntu-22.04
    name: Build ${{ matrix.goos }}/${{ matrix.goarch }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"

      - name: Install cross-compilation toolchain
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            gcc-aarch64-linux-gnu \
            gcc-arm-linux-gnueabihf \
            libc6-dev-arm64-cross \
            libc6-dev-armhf-cross

      - name: Build
        env:
          CGO_ENABLED: "1"
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
          GOARM: ${{ matrix.goarm }}
          CC: ${{ matrix.cc }}
          CGO_CFLAGS: ${{ matrix.cgo_flags }}
        run: |
          go build \
            -ldflags='-s -w' \
            -o bin/server-${{ matrix.goos }}-${{ matrix.goarch }} \
            ./cmd/server

      - name: Verify binary
        run: |
          file bin/server-${{ matrix.goos }}-${{ matrix.goarch }}

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: server-${{ matrix.goos }}-${{ matrix.goarch }}
          path: bin/server-${{ matrix.goos }}-${{ matrix.goarch }}
```

## CGO Alternatives for Common Use Cases

### Pure-Go Alternatives Evaluation

```go
// alternatives_comparison.go
package alternatives

// Instead of: wrapping libsqlite3 via CGO for SQLite access
// Use: modernc.org/sqlite (transpiled C to Go, pure Go output)
import (
    // Pure Go SQLite - no CGO required
    _ "modernc.org/sqlite"
    "database/sql"

    // Pure Go AES instead of CGO-linked OpenSSL
    "crypto/aes"
    "crypto/cipher"

    // Pure Go compression instead of CGO zlib
    "compress/zlib"

    // Pure Go image processing instead of CGO libjpeg
    "image/jpeg"
)

// SQLiteExample demonstrates pure-Go SQLite usage without CGO.
func SQLiteExample() (*sql.DB, error) {
    // modernc.org/sqlite driver works without cgo
    db, err := sql.Open("sqlite", "file:./data.db?cache=shared&mode=rwc")
    if err != nil {
        return nil, err
    }
    return db, nil
}

// AESGCMExample demonstrates Go's standard library AES-GCM.
// On x86-64, Go's crypto/aes uses AES-NI hardware acceleration
// via assembly intrinsics - no CGO required for hardware acceleration.
func AESGCMExample(key, plaintext, aad []byte) ([]byte, error) {
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, err
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }

    nonce := make([]byte, gcm.NonceSize())
    // In production: fill nonce with crypto/rand

    return gcm.Seal(nonce, nonce, plaintext, aad), nil
}

// CompressionExample demonstrates pure-Go zlib compression.
func CompressionExample(data []byte) ([]byte, error) {
    // This uses Go's pure-Go zlib which internally calls compress/flate
    // Performance within 20-30% of CGO zlib for most workloads
    _ = zlib.NewWriter
    _ = jpeg.Decode
    return data, nil
}
```

### Using WASM Instead of CGO for Plugin Systems

```go
// wasm_plugin_host.go - alternative to CGO for extensibility
package plugins

import (
    "context"
    "fmt"
    "os"

    "github.com/tetratelabs/wazero"
    "github.com/tetratelabs/wazero/api"
    "github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// WasmPlugin represents a sandboxed WASM extension module.
// This provides C-code execution capability without CGO's
// cross-compilation complexity or GC interaction issues.
type WasmPlugin struct {
    runtime wazero.Runtime
    module  api.Module
}

// NewWasmPlugin loads a WASM binary as a sandboxed plugin.
func NewWasmPlugin(ctx context.Context, wasmPath string) (*WasmPlugin, error) {
    wasmBytes, err := os.ReadFile(wasmPath)
    if err != nil {
        return nil, fmt.Errorf("reading WASM binary: %w", err)
    }

    r := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().
        WithCompilationCache(wazero.NewCompilationCache()))

    // Add WASI support for file system and stdio access
    wasi_snapshot_preview1.MustInstantiate(ctx, r)

    mod, err := r.Instantiate(ctx, wasmBytes)
    if err != nil {
        return nil, fmt.Errorf("instantiating WASM module: %w", err)
    }

    return &WasmPlugin{runtime: r, module: mod}, nil
}

// Process calls an exported WASM function with the given input.
func (p *WasmPlugin) Process(ctx context.Context, data []byte) ([]byte, error) {
    fn := p.module.ExportedFunction("process")
    if fn == nil {
        return nil, fmt.Errorf("function 'process' not exported by WASM module")
    }

    // Allocate memory in the WASM sandbox
    malloc := p.module.ExportedFunction("malloc")
    free := p.module.ExportedFunction("free")

    results, err := malloc.Call(ctx, uint64(len(data)))
    if err != nil {
        return nil, fmt.Errorf("WASM malloc failed: %w", err)
    }
    inputPtr := results[0]
    defer free.Call(ctx, inputPtr)

    // Copy data into WASM memory
    if !p.module.Memory().Write(uint32(inputPtr), data) {
        return nil, fmt.Errorf("writing to WASM memory failed")
    }

    // Call the WASM function
    output, err := fn.Call(ctx, inputPtr, uint64(len(data)))
    if err != nil {
        return nil, fmt.Errorf("WASM process call failed: %w", err)
    }

    if len(output) < 2 {
        return nil, fmt.Errorf("unexpected WASM return value count")
    }

    // Read output from WASM memory
    outputPtr := uint32(output[0])
    outputLen := uint32(output[1])

    result, ok := p.module.Memory().Read(outputPtr, outputLen)
    if !ok {
        return nil, fmt.Errorf("reading WASM output failed")
    }

    // Copy before freeing WASM memory
    out := make([]byte, len(result))
    copy(out, result)

    free.Call(ctx, uint64(outputPtr))
    return out, nil
}

// Close releases the WASM runtime.
func (p *WasmPlugin) Close(ctx context.Context) {
    p.module.Close(ctx)
    p.runtime.Close(ctx)
}
```

## Testing CGO Code

### Unit Testing with Mock C Functions

```go
// file: crypto_test.go
//go:build cgo

package crypto_test

import (
    "bytes"
    "testing"
    "crypto/rand"
    "io"

    "your.org/pkg/crypto"
)

func TestSecretBoxRoundTrip(t *testing.T) {
    t.Parallel()

    key := make([]byte, 32)
    if _, err := io.ReadFull(rand.Reader, key); err != nil {
        t.Fatalf("generating key: %v", err)
    }

    testCases := []struct {
        name    string
        message []byte
    }{
        {"empty", []byte{}},
        {"short", []byte("hello")},
        {"medium", bytes.Repeat([]byte("x"), 1024)},
        {"large", bytes.Repeat([]byte("y"), 1<<20)},
    }

    for _, tc := range testCases {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            sealed, err := crypto.SecretBoxSeal(tc.message, key)
            if err != nil {
                t.Fatalf("seal failed: %v", err)
            }

            opened, err := crypto.SecretBoxOpen(sealed, key)
            if err != nil {
                t.Fatalf("open failed: %v", err)
            }

            if !bytes.Equal(opened, tc.message) {
                t.Errorf("round-trip mismatch: got %x, want %x", opened, tc.message)
            }
        })
    }
}

func BenchmarkSecretBoxSeal_1KB(b *testing.B) {
    key := make([]byte, 32)
    io.ReadFull(rand.Reader, key)
    msg := bytes.Repeat([]byte("a"), 1024)

    b.SetBytes(int64(len(msg)))
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        _, err := crypto.SecretBoxSeal(msg, key)
        if err != nil {
            b.Fatal(err)
        }
    }
}
```

### Race Detection with CGO

```bash
# CGO code participates fully in Go's race detector
go test -race -count=10 -timeout=120s ./...

# Run the race detector specifically on CGO boundary code
go test -race -run TestSecretBox -v ./pkg/crypto/

# Use tsan sanitizer for C-side races (requires clang)
CGO_CFLAGS="-fsanitize=thread -g" \
CGO_LDFLAGS="-fsanitize=thread" \
CC=clang \
go test -c -o crypto_test.tsan ./pkg/crypto/
./crypto_test.tsan -test.v -test.run TestConcurrent
```

## Production Deployment Considerations

### Static Linking for Container Deployments

```bash
#!/bin/bash
# static-build.sh - Build a fully static binary for scratch containers

set -euo pipefail

# Verify musl-gcc is available
if ! command -v musl-gcc &>/dev/null; then
    echo "Installing musl-gcc..."
    apt-get install -y musl-tools
fi

# Build static binary
CGO_ENABLED=1 \
CC=musl-gcc \
go build \
    -ldflags='-extldflags "-static" -s -w' \
    -tags 'osusergo netgo static_build' \
    -trimpath \
    -o dist/server-static \
    ./cmd/server

# Verify no dynamic dependencies
ldd dist/server-static 2>&1 | grep -c "not a dynamic executable" \
    || { echo "Binary has dynamic dependencies!"; ldd dist/server-static; exit 1; }

echo "Static binary size: $(du -sh dist/server-static)"
echo "Build complete: dist/server-static"
```

```dockerfile
# Dockerfile.static
FROM golang:1.23-bullseye AS builder

RUN apt-get update && apt-get install -y musl-tools libsodium-dev

WORKDIR /app
COPY . .
RUN CGO_ENABLED=1 CC=musl-gcc \
    go build \
    -ldflags='-extldflags "-static" -s -w' \
    -tags 'osusergo netgo static_build' \
    -o /server ./cmd/server

# Verify static linking
RUN ldd /server 2>&1 | grep "not a dynamic executable"

FROM scratch
COPY --from=builder /server /server
ENTRYPOINT ["/server"]
```

CGO is a powerful capability that deserves careful consideration before adoption. The build complexity, cross-compilation challenges, and GC interaction overhead are real costs that must be weighed against the concrete benefits of the underlying C library. When those benefits are genuine — FIPS-validated crypto, hardware-accelerated codecs, or access to platform APIs — CGO delivers production-grade integration. For everything else, pure-Go equivalents and WASM plugins offer better operational properties.
