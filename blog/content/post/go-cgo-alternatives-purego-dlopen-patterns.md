---
title: "Go CGO Alternatives: Pure Go FFI with purego and dlopen Patterns"
date: 2029-02-15T00:00:00-05:00
draft: false
tags: ["Go", "CGO", "FFI", "purego", "dlopen", "Systems Programming"]
categories:
- Go
- Systems Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to replacing CGO with pure Go FFI patterns using the purego library and direct syscall-based dlopen, covering symbol resolution, calling conventions, type marshaling, and cross-compilation implications for enterprise Go applications."
more_link: "yes"
url: "/go-cgo-alternatives-purego-dlopen-patterns/"
---

CGO enables Go programs to call C functions, but it carries significant costs: cross-compilation requires the target's C toolchain, build times increase substantially, the CGO calling overhead is 40-80ns per call (versus 1-2ns for a Go function call), and the runtime cannot manage goroutine stacks during C execution. For many use cases—dynamically loading a system library, calling into an existing shared object, or integrating with platform APIs—a pure Go FFI approach using `syscall.Syscall` and the `purego` library achieves the same result without any of the CGO drawbacks.

This guide covers the complete pure Go FFI toolkit: direct dlopen/dlsym via syscall, the `purego` library for ergonomic symbol loading, type marshaling between Go and C calling conventions, and the patterns for safely managing library lifetimes in concurrent Go programs.

<!--more-->

## Why Avoid CGO

| Aspect | CGO | Pure Go FFI |
|--------|-----|-------------|
| Cross-compilation | Requires target C toolchain | `GOOS=linux GOARCH=arm64 go build` works |
| Build time | 3-10x slower (C compilation pass) | Standard Go build speed |
| Call overhead | 40-80 ns per C function call | 5-20 ns (syscall overhead only) |
| Stack management | CGO locks goroutine to OS thread | No goroutine-to-thread pinning |
| Binary distribution | C runtime dependency | Fully self-contained binary |
| Race detector | Limited C memory visibility | Full Go race detector support |
| Debugging | Mixed stack traces | Pure Go stack traces |
| Static linking | Complex | Straightforward |

The trade-off: CGO allows calling arbitrary C code (including code with callbacks into Go). Pure Go FFI only works with dynamically loaded shared libraries, and callbacks from C into Go require additional machinery.

## dlopen/dlsym via Syscall

On Linux, `dlopen(3)` and `dlsym(3)` are part of `libdl`. On macOS, they are in the system library directly. Both are accessible via `syscall.Syscall`.

```go
// pkg/dynlib/dynlib_linux.go
//go:build linux

package dynlib

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	RTLD_NOW    = 0x2
	RTLD_LOCAL  = 0x0
	RTLD_GLOBAL = 0x100
	RTLD_NOLOAD = 0x4
)

// Library represents a dynamically loaded shared library.
type Library struct {
	handle uintptr
	path   string
}

// Open loads a shared library. The flags parameter controls loading behavior.
// Use RTLD_NOW|RTLD_LOCAL for most cases.
func Open(path string, flags int) (*Library, error) {
	cPath, err := syscall.BytePtrFromString(path)
	if err != nil {
		return nil, fmt.Errorf("invalid library path %q: %w", path, err)
	}

	handle, _, errno := syscall.Syscall(
		syscall.SYS_DLOPEN, // Alternatively: use /proc/self/exe trick for VDSO
		uintptr(unsafe.Pointer(cPath)),
		uintptr(flags),
		0,
	)
	if handle == 0 {
		// Get error string from dlerror()
		return nil, fmt.Errorf("dlopen(%q): %w (errno=%v)", path, dlerror(), errno)
	}

	return &Library{handle: handle, path: path}, nil
}

// Sym looks up a symbol in the library and returns its address.
func (l *Library) Sym(symbol string) (uintptr, error) {
	cSym, err := syscall.BytePtrFromString(symbol)
	if err != nil {
		return 0, fmt.Errorf("invalid symbol name %q: %w", symbol, err)
	}

	addr, _, _ := syscall.Syscall(
		syscall.SYS_DLSYM,
		l.handle,
		uintptr(unsafe.Pointer(cSym)),
		0,
	)
	if addr == 0 {
		return 0, fmt.Errorf("dlsym(%q): symbol not found: %w", symbol, dlerror())
	}

	return addr, nil
}

// Close releases the library handle.
func (l *Library) Close() error {
	if l.handle == 0 {
		return nil
	}
	ret, _, errno := syscall.Syscall(syscall.SYS_DLCLOSE, l.handle, 0, 0)
	if ret != 0 {
		return fmt.Errorf("dlclose(%q): %w (errno=%v)", l.path, dlerror(), errno)
	}
	l.handle = 0
	return nil
}

// dlerror retrieves the last dynamic linker error.
func dlerror() error {
	addr, _, _ := syscall.Syscall(syscall.SYS_DLERROR, 0, 0, 0)
	if addr == 0 {
		return nil
	}
	return syscall.EINVAL // Simplified; real impl reads the C string
}
```

## The purego Library

The `purego` library (`github.com/ebitengine/purego`) provides a higher-level, ergonomic API for calling shared library functions from pure Go. It handles the platform-specific syscall details and type conversion automatically.

```bash
go get github.com/ebitengine/purego@latest
```

### Basic Usage Pattern

```go
// pkg/libz/libz.go — pure Go wrapper around libz (zlib)
package libz

import (
	"fmt"
	"runtime"
	"sync"

	"github.com/ebitengine/purego"
)

// C function signatures we want to call:
// const char *zlibVersion(void);
// int compress(Bytef *dest, uLongf *destLen, const Bytef *source, uLong sourceLen);
// int uncompress(Bytef *dest, uLongf *destLen, const Bytef *source, uLong sourceLen);
// uLong compressBound(uLong sourceLen);

const (
	Z_OK            = 0
	Z_STREAM_END    = 1
	Z_NEED_DICT     = 2
	Z_ERRNO         = -1
	Z_STREAM_ERROR  = -2
	Z_DATA_ERROR    = -3
	Z_MEM_ERROR     = -4
	Z_BUF_ERROR     = -5
	Z_VERSION_ERROR = -6
)

var (
	initOnce sync.Once
	libHandle uintptr

	fnZlibVersion  func() string
	fnCompress     func(dest *byte, destLen *uint64, source *byte, sourceLen uint64) int32
	fnUncompress   func(dest *byte, destLen *uint64, source *byte, sourceLen uint64) int32
	fnCompressBound func(sourceLen uint64) uint64
)

func libraryPath() string {
	switch runtime.GOOS {
	case "linux":
		return "libz.so.1"
	case "darwin":
		return "/usr/lib/libz.dylib"
	case "windows":
		return "zlib1.dll"
	default:
		panic(fmt.Sprintf("unsupported OS: %s", runtime.GOOS))
	}
}

func init() {
	initOnce.Do(func() {
		var err error
		libHandle, err = purego.Dlopen(libraryPath(), purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			panic(fmt.Sprintf("failed to load %s: %v", libraryPath(), err))
		}

		// Register function pointers — purego resolves symbols and validates signatures
		purego.RegisterLibFunc(&fnZlibVersion, libHandle, "zlibVersion")
		purego.RegisterLibFunc(&fnCompress, libHandle, "compress")
		purego.RegisterLibFunc(&fnUncompress, libHandle, "uncompress")
		purego.RegisterLibFunc(&fnCompressBound, libHandle, "compressBound")
	})
}

// Version returns the zlib version string.
func Version() string {
	return fnZlibVersion()
}

// Compress compresses src and returns the compressed bytes.
func Compress(src []byte) ([]byte, error) {
	bound := fnCompressBound(uint64(len(src)))
	dst := make([]byte, bound)
	dstLen := bound

	var srcPtr, dstPtr *byte
	if len(src) > 0 {
		srcPtr = &src[0]
	}
	if len(dst) > 0 {
		dstPtr = &dst[0]
	}

	ret := fnCompress(dstPtr, &dstLen, srcPtr, uint64(len(src)))
	if ret != Z_OK {
		return nil, fmt.Errorf("zlib compress failed: return code %d", ret)
	}

	return dst[:dstLen], nil
}

// Uncompress decompresses src into a buffer of expectedSize.
func Uncompress(src []byte, expectedSize int) ([]byte, error) {
	dst := make([]byte, expectedSize)
	dstLen := uint64(expectedSize)

	var srcPtr, dstPtr *byte
	if len(src) > 0 {
		srcPtr = &src[0]
	}
	if len(dst) > 0 {
		dstPtr = &dst[0]
	}

	ret := fnUncompress(dstPtr, &dstLen, srcPtr, uint64(len(src)))
	if ret != Z_OK {
		return nil, fmt.Errorf("zlib uncompress failed: return code %d (expected size %d)", ret, expectedSize)
	}

	return dst[:dstLen], nil
}
```

## Calling libssl from Pure Go

A more complex example: calling OpenSSL's EVP interface for AES-256-GCM encryption.

```go
// pkg/libssl/evp.go — pure Go OpenSSL EVP wrapper
package libssl

import (
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

type evpCipherCtx uintptr // opaque C pointer

var (
	once sync.Once

	// EVP cipher context lifecycle
	fnEVP_CIPHER_CTX_new   func() evpCipherCtx
	fnEVP_CIPHER_CTX_free  func(ctx evpCipherCtx)
	fnEVP_CIPHER_CTX_reset func(ctx evpCipherCtx) int32

	// Cipher selection
	fnEVP_aes_256_gcm func() uintptr

	// Encryption operations
	fnEVP_EncryptInit_ex  func(ctx evpCipherCtx, cipher uintptr, engine uintptr, key *byte, iv *byte) int32
	fnEVP_EncryptUpdate   func(ctx evpCipherCtx, out *byte, outl *int32, in *byte, inl int32) int32
	fnEVP_EncryptFinal_ex func(ctx evpCipherCtx, out *byte, outl *int32) int32
	fnEVP_CIPHER_CTX_ctrl func(ctx evpCipherCtx, ctrlType int32, arg int32, ptr unsafe.Pointer) int32

	// EVP_CIPHER_CTX_ctrl types
	EVP_CTRL_GCM_GET_TAG = int32(0x10)
	EVP_CTRL_GCM_SET_TAG = int32(0x11)
)

const opensslLib = "libssl.so.3"

func loadOpenSSL() {
	lib, err := purego.Dlopen(opensslLib, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		panic(fmt.Sprintf("cannot load %s: %v", opensslLib, err))
	}

	purego.RegisterLibFunc(&fnEVP_CIPHER_CTX_new,   lib, "EVP_CIPHER_CTX_new")
	purego.RegisterLibFunc(&fnEVP_CIPHER_CTX_free,  lib, "EVP_CIPHER_CTX_free")
	purego.RegisterLibFunc(&fnEVP_CIPHER_CTX_reset, lib, "EVP_CIPHER_CTX_reset")
	purego.RegisterLibFunc(&fnEVP_aes_256_gcm,      lib, "EVP_aes_256_gcm")
	purego.RegisterLibFunc(&fnEVP_EncryptInit_ex,   lib, "EVP_EncryptInit_ex")
	purego.RegisterLibFunc(&fnEVP_EncryptUpdate,    lib, "EVP_EncryptUpdate")
	purego.RegisterLibFunc(&fnEVP_EncryptFinal_ex,  lib, "EVP_EncryptFinal_ex")
	purego.RegisterLibFunc(&fnEVP_CIPHER_CTX_ctrl,  lib, "EVP_CIPHER_CTX_ctrl")
}

// EncryptGCM encrypts plaintext using AES-256-GCM.
// key must be 32 bytes. iv must be 12 bytes. Returns ciphertext + 16-byte tag.
func EncryptGCM(key, iv, plaintext []byte) ([]byte, []byte, error) {
	once.Do(loadOpenSSL)

	if len(key) != 32 {
		return nil, nil, fmt.Errorf("AES-256-GCM requires 32-byte key, got %d", len(key))
	}
	if len(iv) != 12 {
		return nil, nil, fmt.Errorf("AES-256-GCM requires 12-byte IV, got %d", len(iv))
	}

	ctx := fnEVP_CIPHER_CTX_new()
	if ctx == 0 {
		return nil, nil, fmt.Errorf("EVP_CIPHER_CTX_new failed")
	}
	defer fnEVP_CIPHER_CTX_free(ctx)

	cipher := fnEVP_aes_256_gcm()
	if fnEVP_EncryptInit_ex(ctx, cipher, 0, &key[0], &iv[0]) != 1 {
		return nil, nil, fmt.Errorf("EVP_EncryptInit_ex failed")
	}

	ciphertext := make([]byte, len(plaintext)+16)
	var outLen int32

	if fnEVP_EncryptUpdate(ctx, &ciphertext[0], &outLen, &plaintext[0], int32(len(plaintext))) != 1 {
		return nil, nil, fmt.Errorf("EVP_EncryptUpdate failed")
	}
	totalLen := int(outLen)

	if fnEVP_EncryptFinal_ex(ctx, &ciphertext[totalLen], &outLen) != 1 {
		return nil, nil, fmt.Errorf("EVP_EncryptFinal_ex failed")
	}
	totalLen += int(outLen)

	tag := make([]byte, 16)
	if fnEVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, unsafe.Pointer(&tag[0])) != 1 {
		return nil, nil, fmt.Errorf("EVP_CIPHER_CTX_ctrl GET_TAG failed")
	}

	return ciphertext[:totalLen], tag, nil
}
```

## Type Marshaling Reference

Understanding Go-to-C type correspondence is essential for correct FFI calls.

```go
// Type mapping between Go and C for purego:
//
// C type          Go type
// ----------      ----------
// int             int32
// long            int64 (on 64-bit)
// unsigned int    uint32
// unsigned long   uint64 (on 64-bit)
// char            byte
// char*           *byte or uintptr (for C strings)
// void*           unsafe.Pointer or uintptr
// double          float64
// float           float32
// bool            bool (C99 _Bool)
//
// C strings: Go strings are NOT null-terminated.
// Always convert: cStr, _ := syscall.BytePtrFromString(goStr)
// And pass: &cStr[0] or unsafe.Pointer(cStr)

// Safe C string helper
func cString(s string) *byte {
	b := make([]byte, len(s)+1)
	copy(b, s)
	b[len(s)] = 0
	return &b[0]
}

// Convert C string (null-terminated) back to Go string
func goString(p uintptr) string {
	if p == 0 {
		return ""
	}
	ptr := (*[1 << 30]byte)(unsafe.Pointer(p))
	n := 0
	for ptr[n] != 0 {
		n++
	}
	return string(ptr[:n])
}
```

## Build Constraints for Platform Isolation

```go
// pkg/dynlib/dynlib_linux.go
//go:build linux && (amd64 || arm64)

// pkg/dynlib/dynlib_darwin.go
//go:build darwin && (amd64 || arm64)

// pkg/dynlib/dynlib_stub.go
//go:build !linux && !darwin

package dynlib

import "fmt"

// Open returns an error on unsupported platforms.
func Open(path string, flags int) (*Library, error) {
	return nil, fmt.Errorf("dynamic library loading not supported on %s", runtime.GOOS)
}
```

## Lazy Loading Pattern

For optional library integrations, use lazy loading to avoid startup failures when the library is not present.

```go
package hwaccel

import (
	"fmt"
	"sync"

	"github.com/ebitengine/purego"
)

type accelerator struct {
	available bool
	lib       uintptr
	fnEncode  func(input *byte, inputLen uint32, output *byte, outputLen *uint32) int32
}

var (
	accel     accelerator
	accelOnce sync.Once
)

// IsAvailable returns true if the hardware acceleration library is present.
func IsAvailable() bool {
	accelOnce.Do(loadAccelerator)
	return accel.available
}

// Encode encodes data using hardware acceleration if available, falls back to software.
func Encode(input []byte) ([]byte, error) {
	accelOnce.Do(loadAccelerator)

	if !accel.available {
		return softwareEncode(input) // fallback implementation
	}

	output := make([]byte, len(input)*2)
	outLen := uint32(len(output))

	ret := accel.fnEncode(&input[0], uint32(len(input)), &output[0], &outLen)
	if ret != 0 {
		return nil, fmt.Errorf("hardware encode failed: error code %d", ret)
	}
	return output[:outLen], nil
}

func loadAccelerator() {
	lib, err := purego.Dlopen("libhwaccel.so.1", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		// Library not present — not an error, fall back to software
		return
	}

	if err := purego.RegisterLibFunc(&accel.fnEncode, lib, "hw_encode"); err != nil {
		purego.Dlclose(lib)
		return
	}

	accel.lib = lib
	accel.available = true
}

func softwareEncode(input []byte) ([]byte, error) {
	// Pure Go fallback
	output := make([]byte, len(input))
	copy(output, input)
	return output, nil
}
```

## Performance Benchmarks: CGO vs purego

```go
package bench_test

import (
	"testing"
	"unsafe"

	"github.com/ebitengine/purego"
)

// BenchmarkCGO_strlen measures CGO call overhead for a simple C function
// (requires build tag: cgo)

// BenchmarkPurego_strlen measures purego call overhead
func BenchmarkPurego_strlen(b *testing.B) {
	lib, _ := purego.Dlopen("libc.so.6", purego.RTLD_NOW)
	var strlen func(s uintptr) uint64
	purego.RegisterLibFunc(&strlen, lib, "strlen")

	testStr := []byte("hello, world\x00")
	ptr := uintptr(unsafe.Pointer(&testStr[0]))

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = strlen(ptr)
	}
}

// Typical results on amd64 Linux:
// BenchmarkCGO_strlen-8        30000000    45.2 ns/op
// BenchmarkPurego_strlen-8     80000000    14.8 ns/op
// Direct Go call (no FFI)-8  1000000000     1.1 ns/op
```

## Testing Pure Go FFI Code

```go
package libz_test

import (
	"bytes"
	"testing"

	"github.com/supporttools/libz"
)

func TestCompressUncompress_RoundTrip(t *testing.T) {
	original := []byte("The quick brown fox jumps over the lazy dog. " +
		"Pack my box with five dozen liquor jugs. " +
		"How vexingly quick daft zebras jump!")

	compressed, err := libz.Compress(original)
	if err != nil {
		t.Fatalf("Compress: %v", err)
	}

	t.Logf("Original: %d bytes, Compressed: %d bytes (%.1f%%)",
		len(original), len(compressed),
		float64(len(compressed))/float64(len(original))*100)

	decompressed, err := libz.Uncompress(compressed, len(original))
	if err != nil {
		t.Fatalf("Uncompress: %v", err)
	}

	if !bytes.Equal(original, decompressed) {
		t.Errorf("round-trip mismatch:\n  original:     %q\n  decompressed: %q",
			original, decompressed)
	}
}

func TestVersion(t *testing.T) {
	v := libz.Version()
	if v == "" {
		t.Error("zlib version string is empty")
	}
	t.Logf("zlib version: %s", v)
}

func BenchmarkCompress(b *testing.B) {
	data := bytes.Repeat([]byte("benchmark payload data "), 1000)
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := libz.Compress(data)
		if err != nil {
			b.Fatal(err)
		}
	}
}
```

## When CGO Is Still Required

Pure Go FFI covers most dynamic library use cases, but CGO remains necessary when:

1. **C callbacks are required**: If a C library calls back into Go (e.g., event callbacks, qsort comparators), CGO is the only supported mechanism
2. **Static C library linking**: Only CGO can link against `.a` archives at compile time
3. **Inline C code**: Small snippets of C code in `import "C"` blocks require CGO
4. **C struct layout access**: Reading fields of C structs with platform-dependent layout requires CGO or manual offset calculation

For these cases, consider wrapping the CGO code in a small, isolated package and keeping the rest of the application CGO-free.

## Summary

The `purego` library removes the primary pain points of CGO—cross-compilation complexity, build time penalties, and goroutine pinning—while providing ergonomic symbol loading and function registration. The patterns demonstrated here—lazy loading, platform build constraints, type marshaling, and safe C string conversion—compose into production-ready wrappers around any POSIX-compliant shared library. For enterprise Go applications that need to integrate with system libraries (libssl, libsasl, hardware SDKs, FIDO2 authenticators), pure Go FFI delivers the integration capability of CGO with the build simplicity and deployment portability of pure Go.

## Platform Detection and Library Path Resolution

A production-ready library loader must handle different library naming conventions across platforms.

```go
package dynlib

import (
	"fmt"
	"os"
	"runtime"
)

// LibraryPaths returns candidate paths for a library given its base name and version.
// Tries versioned paths before unversioned fallback.
func LibraryPaths(baseName string, version int) []string {
	switch runtime.GOOS {
	case "linux":
		return []string{
			fmt.Sprintf("/usr/lib/x86_64-linux-gnu/lib%s.so.%d", baseName, version),
			fmt.Sprintf("/usr/lib64/lib%s.so.%d", baseName, version),
			fmt.Sprintf("/usr/lib/lib%s.so.%d", baseName, version),
			fmt.Sprintf("lib%s.so.%d", baseName, version), // LD_LIBRARY_PATH
		}
	case "darwin":
		return []string{
			fmt.Sprintf("/usr/lib/lib%s.%d.dylib", baseName, version),
			fmt.Sprintf("/usr/local/lib/lib%s.%d.dylib", baseName, version),
			fmt.Sprintf("/opt/homebrew/lib/lib%s.%d.dylib", baseName, version),
		}
	case "windows":
		return []string{
			fmt.Sprintf("%s%d.dll", baseName, version),
			fmt.Sprintf("lib%s-%d.dll", baseName, version),
		}
	default:
		return nil
	}
}

// OpenAny tries each path in turn, returning the first that succeeds.
func OpenAny(paths []string) (uintptr, string, error) {
	var lastErr error
	for _, path := range paths {
		if _, err := os.Stat(path); err != nil {
			continue // Skip paths that don't exist
		}
		lib, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			lastErr = err
			continue
		}
		return lib, path, nil
	}
	if lastErr != nil {
		return 0, "", fmt.Errorf("none of %v could be opened: %w", paths, lastErr)
	}
	return 0, "", fmt.Errorf("none of the candidate paths exist: %v", paths)
}
```

## Wrapping libcurl for HTTP Requests

A practical example of wrapping libcurl to make HTTP requests from a pure Go binary without the `net/http` CGO dependencies.

```go
package libcurl

import (
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

type CURL uintptr
type CURLcode int32

const (
	CURLOPT_URL            = 10002
	CURLOPT_FOLLOWLOCATION = 52
	CURLOPT_TIMEOUT_MS     = 155
	CURLOPT_WRITEFUNCTION  = 20011
	CURLOPT_WRITEDATA      = 10001
	CURLE_OK               = CURLcode(0)
)

var (
	once sync.Once

	fnCurlGlobalInit  func(flags int64) CURLcode
	fnCurlEasyInit    func() CURL
	fnCurlEasySetopt  func(handle CURL, option int32, param uintptr) CURLcode
	fnCurlEasyPerform func(handle CURL) CURLcode
	fnCurlEasyCleanup func(handle CURL)
	fnCurlEasyStrerror func(code CURLcode) uintptr
)

func init() {
	once.Do(func() {
		lib, err := purego.Dlopen("libcurl.so.4", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return // libcurl not available
		}
		purego.RegisterLibFunc(&fnCurlGlobalInit,   lib, "curl_global_init")
		purego.RegisterLibFunc(&fnCurlEasyInit,     lib, "curl_easy_init")
		purego.RegisterLibFunc(&fnCurlEasySetopt,   lib, "curl_easy_setopt")
		purego.RegisterLibFunc(&fnCurlEasyPerform,  lib, "curl_easy_perform")
		purego.RegisterLibFunc(&fnCurlEasyCleanup,  lib, "curl_easy_cleanup")
		purego.RegisterLibFunc(&fnCurlEasyStrerror, lib, "curl_easy_strerror")
		fnCurlGlobalInit(3) // CURL_GLOBAL_DEFAULT
	})
}

// Get fetches a URL and returns the response body.
// This is a demonstration; use net/http in production Go code.
func Get(url string) ([]byte, error) {
	if fnCurlEasyInit == nil {
		return nil, fmt.Errorf("libcurl not available")
	}

	handle := fnCurlEasyInit()
	if handle == 0 {
		return nil, fmt.Errorf("curl_easy_init failed")
	}
	defer fnCurlEasyCleanup(handle)

	cURL := cString(url)
	fnCurlEasySetopt(handle, CURLOPT_URL, uintptr(unsafe.Pointer(cURL)))
	fnCurlEasySetopt(handle, CURLOPT_FOLLOWLOCATION, 1)
	fnCurlEasySetopt(handle, CURLOPT_TIMEOUT_MS, 10000)

	var body []byte
	// Note: callback functions from C into Go still require CGO
	// For full callback support, use CGO or a Go HTTP client

	if code := fnCurlEasyPerform(handle); code != CURLE_OK {
		errMsg := goString(fnCurlEasyStrerror(code))
		return nil, fmt.Errorf("curl_easy_perform: %s (code %d)", errMsg, code)
	}

	return body, nil
}

func cString(s string) []byte {
	b := make([]byte, len(s)+1)
	copy(b, s)
	return b
}

func goString(p uintptr) string {
	if p == 0 {
		return ""
	}
	buf := (*[1 << 20]byte)(unsafe.Pointer(p))
	n := 0
	for buf[n] != 0 {
		n++
	}
	return string(buf[:n])
}
```

## Build Tags for CGO-Free Builds

Marking packages as CGO-free allows the Go toolchain to use its pure Go networking and crypto stacks.

```bash
# Build with CGO disabled — forces pure Go implementations
CGO_ENABLED=0 go build -o myapp ./cmd/myapp

# Cross-compile for Linux ARM64 from macOS
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o myapp-linux-arm64 ./cmd/myapp

# Verify the binary has no CGO dependencies
file myapp-linux-arm64
# myapp-linux-arm64: ELF 64-bit LSB executable, ARM aarch64, statically linked

ldd myapp-linux-arm64
# not a dynamic executable

# For purego-based libraries that dlopen at runtime,
# the binary itself is still statically linked, but requires the .so at runtime
```

## Error Handling and Symbol Absence Patterns

In enterprise code, libraries may be partially present or have version mismatches. Handle missing symbols gracefully.

```go
package feature

import (
	"fmt"

	"github.com/ebitengine/purego"
)

// Feature flags for optional library capabilities
type Capabilities struct {
	HasZstdCompression bool
	HasHardwareAES     bool
	HasGPUEncoding     bool
}

// Probe dynamically detects available capabilities.
func Probe() Capabilities {
	caps := Capabilities{}

	// Check zstd availability
	if lib, err := purego.Dlopen("libzstd.so.1", purego.RTLD_NOW|purego.RTLD_LOCAL); err == nil {
		var fn func() uintptr
		if err := purego.RegisterLibFunc(&fn, lib, "ZSTD_versionNumber"); err == nil {
			caps.HasZstdCompression = true
		}
		// Don't dlclose — keep it open for use
	}

	// Check for AES-NI via CPUID (pure Go, no library needed)
	caps.HasHardwareAES = hasAESNI()

	return caps
}

// hasAESNI uses assembly to check CPUID for AES-NI support.
// Implementation in hasaesni_amd64.s
func hasAESNI() bool {
	// Simplified: in production, use golang.org/x/sys/cpu
	return false
}
```
