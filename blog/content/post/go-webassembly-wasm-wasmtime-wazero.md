---
title: "Go WebAssembly: Compiling Go to WASM, Browser Integration, and Server-Side WASM with Wasmtime"
date: 2030-02-10T00:00:00-05:00
draft: false
tags: ["Go", "WebAssembly", "WASM", "TinyGo", "Wasmtime", "wazero", "Browser", "Server-Side"]
categories: ["Go", "WebAssembly"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go WebAssembly compilation, TinyGo for smaller binaries, JavaScript interop patterns, server-side WASM execution with Wasmtime and wazero, and practical use cases with performance tradeoffs."
more_link: "yes"
url: "/go-webassembly-wasm-wasmtime-wazero/"
---

WebAssembly has matured from a browser novelty to a serious deployment target for server-side workloads. Go's WASM compilation support, combined with the wazero runtime (pure Go WASM runtime with zero CGo dependencies) and Wasmtime (a high-performance WASM runtime written in Rust), enables Go applications to run untrusted plugins, execute logic in sandboxed environments, and distribute computation to browsers without rewriting in JavaScript.

This guide covers the complete Go WebAssembly ecosystem: standard compilation with `GOARCH=wasm`, TinyGo for size-optimized binaries, JavaScript interop patterns, and server-side execution with both wazero (embedded, no native dependencies) and Wasmtime (higher performance, native binding).

<!--more-->

## Why WebAssembly for Go Applications

WASM provides three capabilities that are difficult to achieve with native code:

**Sandboxed execution**: WASM modules run in a memory-isolated sandbox. A WASM module cannot access the host filesystem, network, or memory unless explicitly granted by the host. This makes it ideal for executing user-provided plugins without the security risks of loading native shared libraries.

**Portable distribution**: A WASM binary compiled on Linux runs identically on Windows, macOS, and in any browser supporting WebAssembly. No cross-compilation toolchain required at distribution time.

**Language interoperability**: A Go WASM module can be called from JavaScript, Rust, Python (with appropriate runtimes), or any other language with a WASM host implementation. This enables a plugin ecosystem where plugins can be written in any WASM-producing language.

## Standard Go WASM Compilation

### Basic Browser WASM

```go
// main.go
//go:build js && wasm

package main

import (
	"fmt"
	"syscall/js"
)

func add(this js.Value, inputs []js.Value) interface{} {
	a := inputs[0].Float()
	b := inputs[1].Float()
	return a + b
}

func processData(this js.Value, inputs []js.Value) interface{} {
	// Get data from JavaScript as a Uint8Array
	jsData := inputs[0]
	data := make([]byte, jsData.Length())
	js.CopyBytesToGo(data, jsData)

	// Process the data
	result := doComputation(data)

	// Return result to JavaScript
	jsResult := js.Global().Get("Uint8Array").New(len(result))
	js.CopyBytesToJS(jsResult, result)
	return jsResult
}

func doComputation(data []byte) []byte {
	// Example: compute a simple checksum
	var sum uint64
	for _, b := range data {
		sum += uint64(b)
	}
	result := fmt.Sprintf("checksum=%d,length=%d", sum, len(data))
	return []byte(result)
}

func registerCallbacks() {
	js.Global().Set("goAdd", js.FuncOf(add))
	js.Global().Set("goProcessData", js.FuncOf(processData))
}

func main() {
	registerCallbacks()
	fmt.Println("Go WASM initialized")

	// Keep the Go runtime alive
	select {}
}
```

```bash
# Build the WASM binary
GOOS=js GOARCH=wasm go build -o main.wasm main.go

# Check the binary size
ls -la main.wasm
# -rw-r--r-- 1 user user 2.1M main.wasm  -- Large due to Go runtime

# Copy the JS bridge file
cp $(go env GOROOT)/misc/wasm/wasm_exec.js .
```

### HTML Integration

```html
<!-- index.html -->
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Go WASM Demo</title>
</head>
<body>
<script src="wasm_exec.js"></script>
<script>
    const go = new Go();

    // Load and instantiate the WASM module
    WebAssembly.instantiateStreaming(
        fetch("main.wasm"),
        go.importObject
    ).then(result => {
        // Run the Go program
        go.run(result.instance);

        // Now we can call Go functions
        console.log("2 + 3 =", goAdd(2, 3));

        // Process binary data
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const result = goProcessData(data);
        console.log("Processed:", new TextDecoder().decode(result));
    }).catch(err => {
        console.error("Failed to load WASM:", err);
    });
</script>
</body>
</html>
```

## TinyGo for Smaller Binaries

Standard Go WASM binaries are 2-10MB due to the Go runtime inclusion. TinyGo produces much smaller binaries by using a different runtime and compiler:

```bash
# Install TinyGo
wget https://github.com/tinygo-org/tinygo/releases/download/v0.33.0/tinygo_0.33.0_amd64.deb
dpkg -i tinygo_0.33.0_amd64.deb

# Or using the package manager
# brew install tinygo

# Verify installation
tinygo version
# tinygo version 0.33.0 linux/amd64 (using go version go1.22.0 and LLVM version 18.1.2)
```

### TinyGo-Compatible WASM Module

TinyGo does not support the full Go standard library. Code must be written to avoid packages that TinyGo doesn't implement:

```go
// tinygo-module/main.go
// Compatible with TinyGo's limited stdlib support

package main

// No imports from packages that use syscall/js for non-browser targets
// For browser target, use:
// import "syscall/js"

// Export functions using //export directive
// These become exported WASM functions

//export add
func add(a, b int32) int32 {
	return a + b
}

//export multiply
func multiply(a, b int32) int32 {
	return a * b
}

//export fibonacci
func fibonacci(n int32) int32 {
	if n <= 1 {
		return n
	}
	a, b := int32(0), int32(1)
	for i := int32(2); i <= n; i++ {
		a, b = b, a+b
	}
	return b
}

// processBuffer demonstrates working with WASM linear memory directly
// The ptr is an offset into WASM memory, length is the buffer length
//export processBuffer
func processBuffer(ptr, length int32) int32 {
	// Create a Go slice backed by WASM linear memory
	data := (*[1 << 20]byte)(unsafePointer(uintptr(ptr)))[:length:length]

	sum := int32(0)
	for _, b := range data {
		sum += int32(b)
	}
	return sum
}

func main() {}
```

```bash
# Compile with TinyGo for browser target
tinygo build -o module-tiny.wasm -target wasm ./tinygo-module/

# Compare sizes
ls -la main.wasm module-tiny.wasm
# -rw-r--r-- 1 user user  2.1M main.wasm    (standard Go)
# -rw-r--r-- 1 user user   34K module-tiny.wasm  (TinyGo - 60x smaller!)

# Compile for WASI (server-side) target
tinygo build -o module-wasi.wasm -target wasip1 ./tinygo-module/

# Compile for a specific microcontroller (bonus TinyGo capability)
# tinygo build -o firmware.uf2 -target arduino-nano33 ./iot-firmware/
```

### TinyGo Binary Size Optimization

```bash
# Optimize for size with -opt=z (aggressive optimization)
tinygo build -o module-opt.wasm \
  -target wasm \
  -opt=z \
  -no-debug \
  ./tinygo-module/

# Apply wasm-opt for additional size reduction
# Install binaryen: apt-get install binaryen
wasm-opt -Oz module-opt.wasm -o module-final.wasm

ls -la module-*.wasm
# -rw-r--r-- 1 user user  34K module-tiny.wasm
# -rw-r--r-- 1 user user  28K module-opt.wasm
# -rw-r--r-- 1 user user  22K module-final.wasm  (after wasm-opt)
```

## Server-Side WASM with wazero

wazero is a pure Go WebAssembly runtime with no CGo dependencies. It embeds directly into Go applications:

```bash
go get github.com/tetratelabs/wazero
```

### Loading and Executing a WASM Module

```go
// internal/wasm/runtime.go
package wasm

import (
	"context"
	"fmt"
	"os"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// Runtime wraps the wazero runtime for executing WASM plugins
type Runtime struct {
	runtime wazero.Runtime
	cache   wazero.CompilationCache
}

// NewRuntime creates a new wazero runtime with compilation caching
func NewRuntime(ctx context.Context, cacheDir string) (*Runtime, error) {
	// Use compilation cache to avoid recompiling WASM on each restart
	cache, err := wazero.NewCompilationCacheWithDir(cacheDir)
	if err != nil {
		return nil, fmt.Errorf("create compilation cache: %w", err)
	}

	rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigCompiler().
		WithCompilationCache(cache).
		WithCloseOnContextDone(true),
	)

	return &Runtime{runtime: rt, cache: cache}, nil
}

func (r *Runtime) Close(ctx context.Context) error {
	return r.runtime.Close(ctx)
}

// Plugin represents a loaded WASM module with its exported functions
type Plugin struct {
	module api.Module
}

// LoadPlugin loads a WASM binary and prepares it for execution
func (r *Runtime) LoadPlugin(ctx context.Context, wasmBytes []byte) (*Plugin, error) {
	// Instantiate WASI (if the module uses filesystem/clock/random)
	wasi_snapshot_preview1.MustInstantiate(ctx, r.runtime)

	// Compile the module (cached after first compilation)
	compiled, err := r.runtime.CompileModule(ctx, wasmBytes)
	if err != nil {
		return nil, fmt.Errorf("compile module: %w", err)
	}

	// Instantiate the module
	module, err := r.runtime.InstantiateModule(ctx, compiled,
		wazero.NewModuleConfig().
			WithStdout(os.Stdout).
			WithStderr(os.Stderr).
			WithSysNanosleep().
			WithSysWalltime().
			WithSysNanosleep(),
	)
	if err != nil {
		return nil, fmt.Errorf("instantiate module: %w", err)
	}

	return &Plugin{module: module}, nil
}

// CallAdd calls the 'add' function exported from the WASM module
func (p *Plugin) CallAdd(ctx context.Context, a, b int32) (int32, error) {
	fn := p.module.ExportedFunction("add")
	if fn == nil {
		return 0, fmt.Errorf("function 'add' not found in module")
	}

	results, err := fn.Call(ctx, api.EncodeI32(a), api.EncodeI32(b))
	if err != nil {
		return 0, fmt.Errorf("call add(%d, %d): %w", a, b, err)
	}

	return api.DecodeI32(results[0]), nil
}

// CallProcessBytes calls a WASM function that works with byte slices
// through WASM linear memory
func (p *Plugin) CallProcessBytes(ctx context.Context, data []byte) ([]byte, error) {
	// Get memory access
	mem := p.module.Memory()
	if mem == nil {
		return nil, fmt.Errorf("module has no memory")
	}

	// Allocate memory in WASM for the input data
	allocFn := p.module.ExportedFunction("allocate")
	if allocFn == nil {
		return nil, fmt.Errorf("allocate function not exported")
	}

	// Allocate n bytes in WASM memory
	ptrResult, err := allocFn.Call(ctx, uint64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("allocate %d bytes: %w", len(data), err)
	}
	ptr := uint32(ptrResult[0])

	// Write data into WASM memory
	if ok := mem.Write(ptr, data); !ok {
		return nil, fmt.Errorf("write to WASM memory at offset %d", ptr)
	}

	// Call the processing function
	processFn := p.module.ExportedFunction("process_bytes")
	if processFn == nil {
		return nil, fmt.Errorf("process_bytes function not exported")
	}

	results, err := processFn.Call(ctx, uint64(ptr), uint64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("process_bytes: %w", err)
	}

	// Decode the result (pointer and length packed into a single uint64)
	resultPtr := uint32(results[0] >> 32)
	resultLen := uint32(results[0] & 0xFFFFFFFF)

	// Read result from WASM memory
	result, ok := mem.Read(resultPtr, resultLen)
	if !ok {
		return nil, fmt.Errorf("read result from WASM memory at offset %d", resultPtr)
	}

	// Make a copy since WASM memory may be mutated
	output := make([]byte, len(result))
	copy(output, result)

	// Free the allocated memory
	freeFn := p.module.ExportedFunction("free")
	if freeFn != nil {
		freeFn.Call(ctx, uint64(ptr))
		freeFn.Call(ctx, uint64(resultPtr))
	}

	return output, nil
}
```

### Host Function Registration

A key WASM capability is providing host functions that WASM modules can call back into:

```go
// internal/wasm/host_functions.go
package wasm

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// RegisterHostFunctions registers Go functions that WASM modules can call
func RegisterHostFunctions(ctx context.Context, rt wazero.Runtime) error {
	_, err := rt.NewHostModuleBuilder("env").
		// Log a message from the WASM module
		NewFunctionBuilder().
		WithGoModuleFunction(
			api.GoModuleFunc(hostLog),
			[]api.ValueType{api.ValueTypeI32, api.ValueTypeI32},
			[]api.ValueType{},
		).
		WithParameterNames("ptr", "len").
		Export("log").

		// Get current time as Unix timestamp
		NewFunctionBuilder().
		WithGoFunction(
			api.GoFunc(func(ctx context.Context, stack []uint64) {
				stack[0] = uint64(time.Now().UnixMilli())
			}),
			[]api.ValueType{},
			[]api.ValueType{api.ValueTypeI64},
		).
		Export("now_millis").

		// HTTP GET request from WASM (host handles network access)
		NewFunctionBuilder().
		WithGoModuleFunction(
			api.GoModuleFunc(hostHTTPGet),
			[]api.ValueType{
				api.ValueTypeI32, // URL pointer
				api.ValueTypeI32, // URL length
				api.ValueTypeI32, // response buffer pointer
				api.ValueTypeI32, // response buffer size
			},
			[]api.ValueType{api.ValueTypeI32}, // bytes written
		).
		Export("http_get").

		Instantiate(ctx)

	return err
}

// hostLog reads a string from WASM memory and logs it
func hostLog(ctx context.Context, mod api.Module, stack []uint64) {
	ptr := uint32(stack[0])
	length := uint32(stack[1])

	if length > 1024*1024 {
		slog.WarnContext(ctx, "WASM log message exceeds 1MB, truncating")
		length = 1024 * 1024
	}

	bytes, ok := mod.Memory().Read(ptr, length)
	if !ok {
		slog.ErrorContext(ctx, "failed to read WASM log message",
			"ptr", ptr,
			"length", length,
		)
		return
	}

	slog.InfoContext(ctx, "wasm",
		"message", string(bytes),
	)
}

// hostHTTPGet performs an HTTP GET from WASM context
func hostHTTPGet(ctx context.Context, mod api.Module, stack []uint64) {
	urlPtr := uint32(stack[0])
	urlLen := uint32(stack[1])
	responsePtr := uint32(stack[2])
	responseSize := uint32(stack[3])

	urlBytes, ok := mod.Memory().Read(urlPtr, urlLen)
	if !ok {
		stack[0] = 0
		return
	}

	url := string(urlBytes)

	// Validate the URL is allowed (security gate)
	if !isAllowedURL(url) {
		slog.WarnContext(ctx, "WASM HTTP request to disallowed URL", "url", url)
		stack[0] = 0
		return
	}

	// Perform the HTTP request
	resp, err := httpClient.Get(url)
	if err != nil {
		slog.ErrorContext(ctx, "WASM HTTP request failed", "url", url, "error", err)
		stack[0] = 0
		return
	}
	defer resp.Body.Close()

	// Read response body (limited to responseSize)
	buf := make([]byte, responseSize)
	n, _ := resp.Body.Read(buf)

	// Write response to WASM memory
	mod.Memory().Write(responsePtr, buf[:n])
	stack[0] = uint64(n)
}

func isAllowedURL(url string) bool {
	// Implement URL allowlist for security
	allowlist := []string{
		"https://api.internal.company.com",
		"https://metadata.google.internal",
	}
	for _, allowed := range allowlist {
		if len(url) >= len(allowed) && url[:len(allowed)] == allowed {
			return true
		}
	}
	return false
}
```

## Server-Side WASM with Wasmtime

Wasmtime provides higher performance than wazero for CPU-intensive WASM workloads, using the Cranelift JIT compiler:

```bash
# Install the wasmtime Go bindings
go get github.com/bytecodealliance/wasmtime-go/v27
```

```go
// internal/wasmtime/engine.go
package engine

import (
	"fmt"

	wasmtime "github.com/bytecodealliance/wasmtime-go/v27"
)

// Engine wraps Wasmtime for executing WASM modules with JIT compilation
type Engine struct {
	engine *wasmtime.Engine
	store  *wasmtime.Store
}

func NewEngine() *Engine {
	// Configure Wasmtime with optimization flags
	config := wasmtime.NewConfig()
	config.SetOptLevel(wasmtime.OptLevelSpeed)
	config.SetCraneliftOptLevel(wasmtime.OptLevelSpeed)

	// Enable WASM features
	config.SetWasmSIMD(true)
	config.SetWasmBulkMemory(true)
	config.SetWasmReferenceTypes(true)

	// Cache compiled modules
	config.CacheConfigLoadDefault()

	engine := wasmtime.NewEngineWithConfig(config)
	store := wasmtime.NewStore(engine)

	// Set resource limits
	store.Limiter(
		256*1024*1024, // 256MB max memory
		-1,            // No page limit
		1000,          // Max table elements
		1,             // Max memory instances
		10,            // Max table instances
	)

	return &Engine{engine: engine, store: store}
}

func (e *Engine) LoadModule(wasmBytes []byte) (*Module, error) {
	// Compile the module (cached by Wasmtime)
	module, err := wasmtime.NewModule(e.engine, wasmBytes)
	if err != nil {
		return nil, fmt.Errorf("compile module: %w", err)
	}

	// Create a linker for WASI support
	linker := wasmtime.NewLinker(e.engine)
	if err := linker.DefineWasi(); err != nil {
		return nil, fmt.Errorf("define wasi: %w", err)
	}

	// Configure WASI environment
	wasiConfig := wasmtime.NewWasiConfig()
	wasiConfig.InheritEnv()
	e.store.SetWasi(wasiConfig)

	// Instantiate the module
	instance, err := linker.Instantiate(e.store, module)
	if err != nil {
		return nil, fmt.Errorf("instantiate module: %w", err)
	}

	return &Module{
		instance: instance,
		store:    e.store,
		module:   module,
	}, nil
}

// Module wraps a Wasmtime module instance
type Module struct {
	instance *wasmtime.Instance
	store    *wasmtime.Store
	module   *wasmtime.Module
}

// CallInt32 calls a function that takes and returns int32 values
func (m *Module) CallInt32(name string, args ...int32) (int32, error) {
	fn := m.instance.GetFunc(m.store, name)
	if fn == nil {
		return 0, fmt.Errorf("function %q not found", name)
	}

	iArgs := make([]interface{}, len(args))
	for i, a := range args {
		iArgs[i] = a
	}

	result, err := fn.Call(m.store, iArgs...)
	if err != nil {
		return 0, fmt.Errorf("call %s: %w", name, err)
	}

	v, ok := result.(int32)
	if !ok {
		return 0, fmt.Errorf("unexpected return type: %T", result)
	}

	return v, nil
}

// CallBytes calls a function with byte slice input/output via WASM memory
func (m *Module) CallBytes(name string, input []byte) ([]byte, error) {
	mem := m.instance.GetExport(m.store, "memory")
	if mem == nil {
		return nil, fmt.Errorf("memory not exported")
	}
	memory := mem.Memory()

	// Allocate in WASM memory
	allocFn := m.instance.GetFunc(m.store, "allocate")
	if allocFn == nil {
		return nil, fmt.Errorf("allocate not exported")
	}

	result, err := allocFn.Call(m.store, int32(len(input)))
	if err != nil {
		return nil, fmt.Errorf("allocate: %w", err)
	}
	ptr := result.(int32)

	// Write input data
	data := memory.UnsafeData(m.store)
	copy(data[ptr:], input)

	// Call the function
	fn := m.instance.GetFunc(m.store, name)
	if fn == nil {
		return nil, fmt.Errorf("function %q not found", name)
	}

	callResult, err := fn.Call(m.store, ptr, int32(len(input)))
	if err != nil {
		return nil, fmt.Errorf("call %s: %w", name, err)
	}

	// Decode result (packed ptr+len as int64)
	packed := callResult.(int64)
	resultPtr := int32(packed >> 32)
	resultLen := int32(packed & 0xFFFFFFFF)

	// Copy result from WASM memory
	output := make([]byte, resultLen)
	copy(output, data[resultPtr:resultPtr+resultLen])

	return output, nil
}
```

## Plugin Architecture with WASM

A practical use case: a Go application that loads user-defined validation plugins as WASM modules:

```go
// internal/plugins/validator.go
package plugins

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"example.com/app/internal/wasm"
)

// ValidationResult from a WASM plugin
type ValidationResult struct {
	Valid   bool
	Message string
	Code    int
}

// PluginManager manages WASM validation plugins
type PluginManager struct {
	runtime *wasm.Runtime
	plugins map[string]*wasm.Plugin
	mu      sync.RWMutex
}

func NewPluginManager(ctx context.Context, cacheDir string) (*PluginManager, error) {
	rt, err := wasm.NewRuntime(ctx, cacheDir)
	if err != nil {
		return nil, fmt.Errorf("create runtime: %w", err)
	}

	return &PluginManager{
		runtime: rt,
		plugins: make(map[string]*wasm.Plugin),
	}, nil
}

// LoadPlugin loads a WASM validation plugin from a file
func (m *PluginManager) LoadPlugin(ctx context.Context, name, path string) error {
	wasmBytes, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read plugin file %s: %w", path, err)
	}

	plugin, err := m.runtime.LoadPlugin(ctx, wasmBytes)
	if err != nil {
		return fmt.Errorf("load plugin %s: %w", name, err)
	}

	m.mu.Lock()
	m.plugins[name] = plugin
	m.mu.Unlock()

	return nil
}

// LoadPluginsFromDir loads all .wasm files from a directory
func (m *PluginManager) LoadPluginsFromDir(ctx context.Context, dir string) error {
	entries, err := filepath.Glob(filepath.Join(dir, "*.wasm"))
	if err != nil {
		return fmt.Errorf("glob plugins: %w", err)
	}

	for _, path := range entries {
		name := filepath.Base(path[:len(path)-5]) // Remove .wasm extension
		if err := m.LoadPlugin(ctx, name, path); err != nil {
			return fmt.Errorf("load plugin %s: %w", name, err)
		}
	}

	return nil
}

// Validate runs all loaded plugins against the provided data
func (m *PluginManager) Validate(ctx context.Context, data []byte) ([]ValidationResult, error) {
	m.mu.RLock()
	plugins := make(map[string]*wasm.Plugin, len(m.plugins))
	for k, v := range m.plugins {
		plugins[k] = v
	}
	m.mu.RUnlock()

	results := make([]ValidationResult, 0, len(plugins))
	for name, plugin := range plugins {
		result, err := runValidation(ctx, plugin, data)
		if err != nil {
			return nil, fmt.Errorf("plugin %s: %w", name, err)
		}
		results = append(results, result)
	}

	return results, nil
}

func runValidation(ctx context.Context, plugin *wasm.Plugin, data []byte) (ValidationResult, error) {
	output, err := plugin.CallProcessBytes(ctx, data)
	if err != nil {
		return ValidationResult{}, err
	}

	// Parse the JSON result from the plugin
	var result ValidationResult
	if err := json.Unmarshal(output, &result); err != nil {
		return ValidationResult{}, fmt.Errorf("parse plugin output: %w", err)
	}

	return result, nil
}
```

## Performance Benchmarks

```go
// bench_test.go
package bench

import (
	"context"
	"os"
	"testing"

	"example.com/app/internal/wasm"
)

var wasmBytes []byte

func init() {
	var err error
	wasmBytes, err = os.ReadFile("testdata/fibonacci.wasm")
	if err != nil {
		panic(err)
	}
}

// Benchmark wazero execution
func BenchmarkWazeroFibonacci(b *testing.B) {
	ctx := context.Background()
	rt, _ := wasm.NewRuntime(ctx, b.TempDir())
	defer rt.Close(ctx)

	plugin, _ := rt.LoadPlugin(ctx, wasmBytes)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		plugin.CallAdd(ctx, 30, 0) // fibonacci(30) = 832040
	}
}

// Benchmark native Go
func BenchmarkNativeFibonacci(b *testing.B) {
	for i := 0; i < b.N; i++ {
		fibonacci(30)
	}
}

func fibonacci(n int32) int32 {
	if n <= 1 {
		return n
	}
	a, b := int32(0), int32(1)
	for i := int32(2); i <= n; i++ {
		a, b = b, a+b
	}
	return b
}

// Typical results:
// BenchmarkWazeroFibonacci-8    500000    2400 ns/op   (includes WASM overhead)
// BenchmarkNativeFibonacci-8  20000000      60 ns/op   (native is 40x faster)
// WASM overhead: ~2300ns per call for cross-boundary invocation
// For long-running WASM functions, the relative overhead is much lower
```

## Use Cases and Tradeoffs

### When WASM is the Right Choice

**Plugin systems with untrusted code**: Running user-provided code (validation rules, data transformations, custom algorithms) in a WASM sandbox prevents host system compromise. The sandbox boundary is enforced by the WASM runtime, not by operating system isolation.

**Cross-language interoperability**: Rust libraries compiled to WASM can be called from Go via wazero. This enables using best-of-breed libraries from other languages without native FFI complexity.

**Browser deployment of Go logic**: Business logic implemented in Go can be deployed to browsers as WASM, ensuring the same validation rules run on client and server.

### When WASM is the Wrong Choice

**High-frequency, low-latency calls**: The benchmark above shows ~2300ns overhead per WASM function call. For functions called millions of times per second, this overhead is significant. Pure-Go or native code is 40-100x faster for CPU-bound hot paths.

**Heavy filesystem and network operations**: WASM I/O through the WASI interface adds overhead compared to native system calls. For I/O-bound workloads, the cost of marshaling data across the WASM boundary outweighs the sandboxing benefits.

**Applications requiring full OS access**: WASM modules cannot access kernel APIs, raw sockets, or hardware directly. Applications that need these capabilities cannot run as WASM modules.

## Key Takeaways

**Standard Go WASM for browser, TinyGo for size**: Standard Go produces 2-10MB WASM binaries due to runtime inclusion. TinyGo produces 20-100KB binaries that are appropriate for browser distribution where download size matters. TinyGo has stdlib limitations that require code adaptation.

**wazero for embedding, Wasmtime for performance**: wazero is a pure Go WASM runtime that embeds without native dependencies — ideal for Go applications that need to run WASM plugins in a portable way. Wasmtime uses a Cranelift JIT that provides higher throughput for CPU-intensive WASM workloads at the cost of CGo dependency.

**Memory management is explicit**: WASM operates with a linear memory model where the host and guest share a flat byte array. Passing complex data (byte slices, structs) between Go and WASM requires explicit allocation and pointer arithmetic. Design your WASM API around simple parameter types (int32, int64, float64) where possible to minimize marshaling complexity.

**WASM call overhead matters**: Each cross-boundary function call incurs approximately 2-10 microseconds of overhead in current runtimes. Design WASM APIs to minimize call frequency — batch work into single invocations rather than making many small calls.
