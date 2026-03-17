---
title: "Go WASM: Compiling Go to WebAssembly for Server and Browser Runtimes"
date: 2031-06-02T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "WebAssembly", "WASM", "WASI", "TinyGo", "wazero"]
categories:
- Go
- WebAssembly
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete enterprise guide to compiling Go to WebAssembly for browser and server runtimes, covering GOOS=js and GOOS=wasip1, syscall/js DOM interaction, WASI with wazero, TinyGo for compact binaries, and embedding WASM in Go HTTP servers."
more_link: "yes"
url: "/go-wasm-webassembly-server-browser-runtimes-guide/"
---

Go has two WebAssembly compilation targets that serve different purposes. The classic `GOOS=js GOARCH=wasm` target produces browser-compatible binaries that interact with the DOM through `syscall/js`. The newer `GOOS=wasip1 GOARCH=wasm` target produces WASI-compliant binaries that run in server-side runtimes like wazero. TinyGo covers both targets with dramatically smaller output binaries. This guide covers the complete ecosystem: browser integration, WASI for server plugins, TinyGo for size-constrained use cases, and embedding WASM modules inside Go HTTP servers.

<!--more-->

# Go WASM: Compiling Go to WebAssembly for Server and Browser Runtimes

## Section 1: WebAssembly Fundamentals for Go Engineers

WebAssembly (WASM) is a binary instruction format designed as a portable compilation target. It provides a sandboxed execution environment with near-native performance. For Go engineers, WASM serves two distinct purposes:

1. **Browser runtime**: Execute Go code in the browser, access the DOM, handle events, and interact with JavaScript APIs
2. **Server runtime (WASI)**: Execute Go code as a portable, sandboxed plugin in server-side WASM runtimes

### The Two GOARCH=wasm Targets

```bash
# Target 1: Browser (GOOS=js)
# Uses syscall/js for JavaScript interop
# Requires wasm_exec.js runtime from the Go distribution
GOOS=js GOARCH=wasm go build -o main.wasm ./cmd/browser

# Target 2: WASI (GOOS=wasip1)
# Compliant with WASI Preview 1 specification
# Runs in wazero, Wasmtime, WasmEdge, and other WASI runtimes
GOOS=wasip1 GOARCH=wasm go build -o main.wasm ./cmd/server-plugin

# Check binary size (Go stdlib WASM binaries are large)
ls -lh *.wasm
# -rw-r--r-- 1 user user 2.8M main.wasm  (typical with GOOS=js)
# -rw-r--r-- 1 user user 1.9M main.wasm  (typical with GOOS=wasip1)
```

## Section 2: Browser WASM with GOOS=js

### Basic Browser WASM Program

```go
// cmd/browser/main.go
//go:build js && wasm

package main

import (
    "fmt"
    "syscall/js"
)

func main() {
    // Register Go functions as JavaScript callable functions
    js.Global().Set("goAdd", js.FuncOf(add))
    js.Global().Set("goFormatJSON", js.FuncOf(formatJSON))
    js.Global().Set("goValidateEmail", js.FuncOf(validateEmail))

    fmt.Println("Go WASM initialized")

    // Keep the Go runtime alive until JavaScript calls done()
    done := make(chan struct{})
    js.Global().Set("goRelease", js.FuncOf(func(this js.Value, args []js.Value) any {
        close(done)
        return nil
    }))

    <-done
}

func add(this js.Value, args []js.Value) any {
    if len(args) != 2 {
        return js.Global().Get("Error").New("add requires exactly 2 arguments")
    }
    a := args[0].Float()
    b := args[1].Float()
    return a + b
}

func formatJSON(this js.Value, args []js.Value) any {
    if len(args) != 1 {
        return js.Global().Get("Error").New("formatJSON requires 1 argument")
    }
    input := args[0].String()
    formatted, err := prettyPrintJSON(input)
    if err != nil {
        return js.Global().Get("Error").New(err.Error())
    }
    return formatted
}

func validateEmail(this js.Value, args []js.Value) any {
    if len(args) != 1 {
        return false
    }
    email := args[0].String()
    return isValidEmail(email)
}
```

### DOM Manipulation with syscall/js

```go
// cmd/browser/dom.go
//go:build js && wasm

package main

import (
    "fmt"
    "strings"
    "syscall/js"
)

// GetElementByID retrieves a DOM element
func GetElementByID(id string) js.Value {
    return js.Global().Get("document").Call("getElementById", id)
}

// SetInnerHTML sets the innerHTML of an element
func SetInnerHTML(id, html string) {
    el := GetElementByID(id)
    if el.IsNull() {
        fmt.Printf("element %s not found\n", id)
        return
    }
    el.Set("innerHTML", html)
}

// AddEventListener attaches an event handler to a DOM element
func AddEventListener(id, event string, fn func(js.Value, []js.Value) any) js.Func {
    el := GetElementByID(id)
    handler := js.FuncOf(fn)
    el.Call("addEventListener", event, handler)
    return handler
}

// RegisterFormHandlers demonstrates a practical form interaction pattern
func RegisterFormHandlers() {
    // Handle form submission
    submitHandler := AddEventListener("process-form", "submit", func(this js.Value, args []js.Value) any {
        args[0].Call("preventDefault") // Prevent default form submission

        // Read input values
        input := GetElementByID("user-input").Get("value").String()

        // Process in Go
        result := processInput(input)

        // Update the DOM with the result
        SetInnerHTML("output", fmt.Sprintf("<pre>%s</pre>", escapeHTML(result)))

        return nil
    })

    // Handle clear button
    clearHandler := AddEventListener("clear-btn", "click", func(this js.Value, args []js.Value) any {
        GetElementByID("user-input").Set("value", "")
        SetInnerHTML("output", "")
        return nil
    })

    // These must be kept alive to prevent garbage collection
    js.Global().Set("_submitHandler", submitHandler)
    js.Global().Set("_clearHandler", clearHandler)
}

func processInput(input string) string {
    // Example: reverse and uppercase
    runes := []rune(input)
    for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
        runes[i], runes[j] = runes[j], runes[i]
    }
    return strings.ToUpper(string(runes))
}

func escapeHTML(s string) string {
    s = strings.ReplaceAll(s, "&", "&amp;")
    s = strings.ReplaceAll(s, "<", "&lt;")
    s = strings.ReplaceAll(s, ">", "&gt;")
    return s
}
```

### Compiling and the wasm_exec.js Runtime

```bash
# Build the WASM binary
GOOS=js GOARCH=wasm go build -o static/main.wasm ./cmd/browser

# Copy the wasm_exec.js runtime from the Go installation
cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" static/

# The wasm_exec.js is required to bridge Go's runtime to the browser
# It provides: memory management, goroutine support, garbage collection
```

### HTML Integration

```html
<!DOCTYPE html>
<html>
<head>
    <title>Go WASM Demo</title>
</head>
<body>
    <h1>Go WASM Demo</h1>
    <form id="process-form">
        <input id="user-input" type="text" placeholder="Enter text...">
        <button type="submit">Process with Go</button>
        <button type="button" id="clear-btn">Clear</button>
    </form>
    <div id="output"></div>

    <script src="/static/wasm_exec.js"></script>
    <script>
        const go = new Go();
        WebAssembly.instantiateStreaming(fetch("/static/main.wasm"), go.importObject)
            .then(result => {
                go.run(result.instance);
                // Go functions are now available as window.goAdd, etc.
                console.log("Go WASM loaded");
                console.log("2 + 3 =", goAdd(2, 3));
            })
            .catch(err => console.error("Failed to load WASM:", err));
    </script>
</body>
</html>
```

### Async JavaScript Interop

```go
// Calling JavaScript async APIs from Go
func fetchURL(url string) (string, error) {
    result := make(chan string, 1)
    errCh := make(chan error, 1)

    successCb := js.FuncOf(func(this js.Value, args []js.Value) any {
        result <- args[0].String()
        return nil
    })
    failCb := js.FuncOf(func(this js.Value, args []js.Value) any {
        errCh <- fmt.Errorf("fetch failed: %s", args[0].String())
        return nil
    })
    defer successCb.Release()
    defer failCb.Release()

    js.Global().Call("fetch", url).
        Call("then", js.FuncOf(func(this js.Value, args []js.Value) any {
            // Get text from Response
            return args[0].Call("text")
        })).
        Call("then", successCb).
        Call("catch", failCb)

    select {
    case r := <-result:
        return r, nil
    case err := <-errCh:
        return "", err
    }
}
```

## Section 3: WASI with GOOS=wasip1

WASI (WebAssembly System Interface) is a standardized interface that allows WASM programs to access system resources in a portable, capability-based way. Go 1.21 added official WASI Preview 1 support.

### Basic WASI Program

```go
// cmd/wasi-plugin/main.go
// This file works for BOTH native and WASI compilation

package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "os"
    "strings"
)

type Request struct {
    Input string `json:"input"`
}

type Response struct {
    Output  string `json:"output"`
    Error   string `json:"error,omitempty"`
}

func main() {
    scanner := bufio.NewScanner(os.Stdin)
    for scanner.Scan() {
        line := scanner.Text()
        if strings.TrimSpace(line) == "" {
            continue
        }

        var req Request
        if err := json.Unmarshal([]byte(line), &req); err != nil {
            writeResponse(Response{Error: fmt.Sprintf("invalid JSON: %v", err)})
            continue
        }

        result := process(req.Input)
        writeResponse(Response{Output: result})
    }

    if err := scanner.Err(); err != nil {
        fmt.Fprintf(os.Stderr, "scanner error: %v\n", err)
        os.Exit(1)
    }
}

func process(input string) string {
    // Complex data processing that benefits from Go's safety
    words := strings.Fields(input)
    for i, word := range words {
        words[i] = strings.Title(strings.ToLower(word))
    }
    return strings.Join(words, " ")
}

func writeResponse(resp Response) {
    data, _ := json.Marshal(resp)
    fmt.Println(string(data))
}
```

```bash
# Build for WASI
GOOS=wasip1 GOARCH=wasm go build -o plugin.wasm ./cmd/wasi-plugin

# Test with wasmtime (if installed)
echo '{"input":"hello world from wasi"}' | wasmtime run plugin.wasm

# Test with wazero CLI
echo '{"input":"hello world"}' | wazero run plugin.wasm
```

## Section 4: wazero for Server-Side WASM

wazero is a pure-Go WASM runtime that enables embedding WASM execution inside Go applications without CGO or external dependencies.

```bash
go get github.com/tetratelabs/wazero@latest
```

### Embedding a WASI Plugin

```go
// server/wasm_runner.go
package server

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "os"

    "github.com/tetratelabs/wazero"
    "github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

type PluginRequest struct {
    Input string `json:"input"`
}

type PluginResponse struct {
    Output string `json:"output"`
    Error  string `json:"error,omitempty"`
}

type WASMPlugin struct {
    runtime  wazero.Runtime
    module   wazero.CompiledModule
    wasmCode []byte
}

func NewWASMPlugin(ctx context.Context, wasmPath string) (*WASMPlugin, error) {
    wasmCode, err := os.ReadFile(wasmPath)
    if err != nil {
        return nil, fmt.Errorf("failed to read WASM file: %w", err)
    }

    // Create a runtime with compilation cache for performance
    cache := wazero.NewCompilationCache()
    rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().
        WithCompilationCache(cache).
        WithCloseOnContextDone(true),
    )

    // Instantiate WASI support
    if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
        return nil, fmt.Errorf("failed to instantiate WASI: %w", err)
    }

    // Compile the module (can be done once, reused for multiple executions)
    compiled, err := rt.CompileModule(ctx, wasmCode)
    if err != nil {
        return nil, fmt.Errorf("failed to compile WASM module: %w", err)
    }

    return &WASMPlugin{
        runtime:  rt,
        module:   compiled,
        wasmCode: wasmCode,
    }, nil
}

func (p *WASMPlugin) Execute(ctx context.Context, req PluginRequest) (PluginResponse, error) {
    inputJSON, err := json.Marshal(req)
    if err != nil {
        return PluginResponse{}, fmt.Errorf("failed to marshal request: %w", err)
    }

    // Each execution gets its own stdin/stdout
    stdin := bytes.NewReader(append(inputJSON, '\n'))
    stdout := &bytes.Buffer{}
    stderr := &bytes.Buffer{}

    // Configure module instance with I/O
    moduleConfig := wazero.NewModuleConfig().
        WithStdin(stdin).
        WithStdout(stdout).
        WithStderr(stderr).
        WithSysNanotimeNosyscall()

    // Instantiate and run the module
    mod, err := p.runtime.InstantiateModule(ctx, p.module, moduleConfig)
    if err != nil {
        return PluginResponse{}, fmt.Errorf("failed to instantiate module: %w (stderr: %s)", err, stderr.String())
    }
    defer mod.Close(ctx)

    // Parse the response
    var resp PluginResponse
    if err := json.Unmarshal(stdout.Bytes(), &resp); err != nil {
        return PluginResponse{}, fmt.Errorf("failed to parse plugin response: %w (stdout: %q)", err, stdout.String())
    }

    return resp, nil
}

func (p *WASMPlugin) Close(ctx context.Context) error {
    return p.runtime.Close(ctx)
}
```

### HTTP Handler Using WASM Plugin

```go
// server/handler.go
package server

import (
    "context"
    "encoding/json"
    "net/http"
    "time"
)

type PluginHandler struct {
    plugin *WASMPlugin
}

func NewPluginHandler(plugin *WASMPlugin) *PluginHandler {
    return &PluginHandler{plugin: plugin}
}

func (h *PluginHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
        return
    }

    var req PluginRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    resp, err := h.plugin.Execute(ctx, req)
    if err != nil {
        http.Error(w, fmt.Sprintf("plugin error: %v", err), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}
```

### Host Functions: Calling Go from WASM

wazero allows you to register Go functions that WASM modules can call:

```go
// server/host_functions.go
package server

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/tetratelabs/wazero"
    "github.com/tetratelabs/wazero/api"
)

// RegisterHostFunctions adds Go functions that WASM modules can call
func RegisterHostFunctions(ctx context.Context, rt wazero.Runtime) error {
    _, err := rt.NewHostModuleBuilder("env").
        NewFunctionBuilder().
        WithFunc(hostLog).
        Export("log").
        NewFunctionBuilder().
        WithFunc(hostGetConfig).
        Export("get_config").
        Instantiate(ctx)
    return err
}

// hostLog is a host function callable from WASM
func hostLog(ctx context.Context, mod api.Module, ptr, length uint32) {
    memory := mod.Memory()
    if memory == nil {
        return
    }
    data, ok := memory.Read(ptr, length)
    if !ok {
        return
    }
    fmt.Printf("[WASM LOG] %s\n", string(data))
}

// hostGetConfig returns a configuration value to the WASM module
func hostGetConfig(ctx context.Context, mod api.Module, keyPtr, keyLen, outPtr, outMaxLen uint32) uint32 {
    memory := mod.Memory()
    if memory == nil {
        return 0
    }

    keyBytes, ok := memory.Read(keyPtr, keyLen)
    if !ok {
        return 0
    }
    key := string(keyBytes)

    // Look up config from context or environment
    config := map[string]string{
        "api_endpoint": "https://api.internal.example.com",
        "timeout_ms":   "5000",
    }
    value, found := config[key]
    if !found {
        return 0
    }

    data := []byte(value)
    if uint32(len(data)) > outMaxLen {
        data = data[:outMaxLen]
    }
    if ok := memory.Write(outPtr, data); !ok {
        return 0
    }
    return uint32(len(data))
}
```

## Section 5: TinyGo for Smaller Binaries

TinyGo is an alternative Go compiler that produces dramatically smaller WASM binaries by using LLVM and stripping unused stdlib code:

```bash
# Install TinyGo
# https://tinygo.org/getting-started/install/
brew install tinygo          # macOS
snap install --classic tinygo  # Linux

# Verify installation
tinygo version

# Build for browser
tinygo build -o main.wasm -target wasm ./cmd/browser

# Build for WASI
tinygo build -o plugin.wasm -target wasip1 ./cmd/wasi-plugin

# Compare binary sizes
ls -lh *.wasm
# Go compiler:   2.8MB
# TinyGo:        87KB  (32x smaller)
```

### TinyGo Compatibility Considerations

TinyGo does not support all of the Go standard library. Important limitations:

```go
// These packages work in TinyGo:
// fmt, strings, strconv, encoding/json, math, sort, sync (partial)

// These packages do NOT work in TinyGo for WASM:
// database/sql - no goroutines/OS threads
// net/http - no networking in browser WASM
// reflect - partial support, some features missing
// runtime/debug - limited

// TinyGo-compatible code pattern
package main

import (
    "encoding/json"  // Works
    "fmt"           // Works
    "strconv"       // Works
    // NOT: "net/http" - won't compile for browser WASM
)
```

### TinyGo Browser Example

```go
// cmd/tinygo-browser/main.go
// Compatible with both tinygo and standard go for browser WASM

//go:build js && wasm

package main

import (
    "encoding/json"
    "fmt"
    "syscall/js"
)

type SortRequest struct {
    Numbers []int `json:"numbers"`
}

type SortResponse struct {
    Sorted []int  `json:"sorted"`
    Error  string `json:"error,omitempty"`
}

func main() {
    js.Global().Set("goSortNumbers", js.FuncOf(sortNumbers))
    js.Global().Set("goParseJSON", js.FuncOf(parseJSON))

    fmt.Println("TinyGo WASM initialized")
    select {} // Block forever
}

func sortNumbers(this js.Value, args []js.Value) any {
    if len(args) != 1 {
        return map[string]any{"error": "requires 1 argument"}
    }

    // Convert JS array to Go slice
    jsArr := args[0]
    length := jsArr.Length()
    numbers := make([]int, length)
    for i := 0; i < length; i++ {
        numbers[i] = jsArr.Index(i).Int()
    }

    // Sort using a simple quicksort (avoiding sort.Slice for TinyGo compat)
    sortInts(numbers)

    // Convert back to JS array
    result := js.Global().Get("Array").New(length)
    for i, n := range numbers {
        result.SetIndex(i, n)
    }
    return result
}

func sortInts(arr []int) {
    if len(arr) <= 1 {
        return
    }
    pivot := arr[len(arr)/2]
    left, right := 0, len(arr)-1
    for left <= right {
        for arr[left] < pivot {
            left++
        }
        for arr[right] > pivot {
            right--
        }
        if left <= right {
            arr[left], arr[right] = arr[right], arr[left]
            left++
            right--
        }
    }
    sortInts(arr[:right+1])
    sortInts(arr[left:])
}

func parseJSON(this js.Value, args []js.Value) any {
    if len(args) != 1 {
        return nil
    }
    var result any
    if err := json.Unmarshal([]byte(args[0].String()), &result); err != nil {
        return map[string]any{"error": err.Error()}
    }
    return js.ValueOf(result)
}
```

```bash
# Build with TinyGo (87KB vs 2.8MB)
tinygo build -o static/main.wasm -target wasm -opt=2 ./cmd/tinygo-browser

# The wasm_exec.js is different for TinyGo - use TinyGo's version
cp $(tinygo env TINYGOROOT)/targets/wasm_exec.js static/
```

## Section 6: Embedding WASM in a Go HTTP Server

A common production pattern is a Go HTTP server that serves WASM files and provides the API that WASM modules call back to:

```go
// cmd/server/main.go
package main

import (
    "context"
    "embed"
    "io/fs"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

//go:embed static
var staticFiles embed.FS

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Load the WASM plugin
    plugin, err := server.NewWASMPlugin(ctx, "plugins/processor.wasm")
    if err != nil {
        log.Fatalf("failed to load WASM plugin: %v", err)
    }
    defer plugin.Close(ctx)

    mux := http.NewServeMux()

    // Serve static files (including the browser WASM binary)
    staticFS, _ := fs.Sub(staticFiles, "static")
    mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

    // Serve the main page
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        http.ServeFileFS(w, r, staticFiles, "static/index.html")
    })

    // API endpoint that uses the WASI plugin
    mux.Handle("/api/process", server.NewPluginHandler(plugin))

    // Set correct WASM MIME type (required for browser loading)
    origHandler := mux
    wrappedHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if len(r.URL.Path) > 5 && r.URL.Path[len(r.URL.Path)-5:] == ".wasm" {
            w.Header().Set("Content-Type", "application/wasm")
        }
        origHandler.ServeHTTP(w, r)
    })

    srv := &http.Server{
        Addr:    ":8080",
        Handler: wrappedHandler,
    }

    go func() {
        log.Println("Server listening on :8080")
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatalf("server error: %v", err)
        }
    }()

    sig := make(chan os.Signal, 1)
    signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
    <-sig

    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()
    if err := srv.Shutdown(shutdownCtx); err != nil {
        log.Printf("server shutdown error: %v", err)
    }
}
```

### Build Process Integration

```makefile
# Makefile

BROWSER_WASM_DIR := cmd/browser
SERVER_PLUGIN_DIR := cmd/wasi-plugin
STATIC_DIR := cmd/server/static
PLUGIN_DIR := cmd/server/plugins

.PHONY: build-all
build-all: build-browser-wasm build-server-plugin build-server

.PHONY: build-browser-wasm
build-browser-wasm:
	mkdir -p $(STATIC_DIR)
	GOOS=js GOARCH=wasm go build -o $(STATIC_DIR)/main.wasm ./$(BROWSER_WASM_DIR)
	cp "$(shell go env GOROOT)/misc/wasm/wasm_exec.js" $(STATIC_DIR)/

.PHONY: build-browser-wasm-tiny
build-browser-wasm-tiny:
	mkdir -p $(STATIC_DIR)
	tinygo build -o $(STATIC_DIR)/main.wasm -target wasm -opt=2 ./$(BROWSER_WASM_DIR)
	cp "$(shell tinygo env TINYGOROOT)/targets/wasm_exec.js" $(STATIC_DIR)/

.PHONY: build-server-plugin
build-server-plugin:
	mkdir -p $(PLUGIN_DIR)
	GOOS=wasip1 GOARCH=wasm go build -o $(PLUGIN_DIR)/processor.wasm ./$(SERVER_PLUGIN_DIR)

.PHONY: build-server
build-server:
	go build -o bin/server ./cmd/server

.PHONY: run
run: build-all
	./bin/server
```

## Section 7: Performance Optimization

### Reducing WASM Binary Size

```bash
# Standard Go compiler with size optimization
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o main.wasm ./cmd/browser
# -s: omit symbol table
# -w: omit DWARF debug information
# Result: ~30% size reduction

# With TinyGo and maximum optimization
tinygo build -o main.wasm -target wasm -opt=2 -no-debug ./cmd/browser
# Result: >90% size reduction from standard Go

# Compress for HTTP delivery
gzip -9 -k main.wasm  # Produces main.wasm.gz
brotli --best main.wasm  # Produces main.wasm.br

# Nginx config for compressed WASM delivery
# gzip_types application/wasm;
# brotli_types application/wasm;
```

### Caching Compiled Modules

```go
// Cache compiled WASM modules to avoid repeated compilation
// wazero provides a compilation cache that persists to disk

func NewCachedRuntime(ctx context.Context, cacheDir string) (wazero.Runtime, error) {
    cache, err := wazero.NewCompilationCacheWithDir(cacheDir)
    if err != nil {
        return nil, fmt.Errorf("failed to create compilation cache: %w", err)
    }

    rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().
        WithCompilationCache(cache),
    )

    return rt, nil
}
```

### Module Instance Pooling

```go
// pool.go - Pool of pre-compiled module instances for high throughput

type WASMPool struct {
    plugin  *WASMPlugin
    pool    chan struct{}
    sem     chan struct{}
}

func NewWASMPool(plugin *WASMPlugin, concurrency int) *WASMPool {
    return &WASMPool{
        plugin: plugin,
        sem:    make(chan struct{}, concurrency),
    }
}

func (p *WASMPool) Execute(ctx context.Context, req PluginRequest) (PluginResponse, error) {
    // Limit concurrent WASM executions
    select {
    case p.sem <- struct{}{}:
        defer func() { <-p.sem }()
    case <-ctx.Done():
        return PluginResponse{}, ctx.Err()
    }

    return p.plugin.Execute(ctx, req)
}
```

## Section 8: Testing WASM Code

### Unit Testing Without WASM Compilation

Structure code to separate WASM-specific I/O from pure logic:

```go
// processor/logic.go (no build tags - testable normally)
package processor

import "strings"

func Process(input string) string {
    words := strings.Fields(input)
    for i, w := range words {
        words[i] = strings.Title(strings.ToLower(w))
    }
    return strings.Join(words, " ")
}
```

```go
// processor/logic_test.go
package processor_test

import (
    "testing"
    "example.com/myapp/processor"
)

func TestProcess(t *testing.T) {
    tests := []struct {
        input string
        want  string
    }{
        {"hello world", "Hello World"},
        {"  multiple   spaces  ", "Multiple Spaces"},
        {"", ""},
    }
    for _, tc := range tests {
        got := processor.Process(tc.input)
        if got != tc.want {
            t.Errorf("Process(%q) = %q, want %q", tc.input, got, tc.want)
        }
    }
}
```

### Testing WASI Plugins with wazero

```go
// wasm_test.go
//go:build integration

package server_test

import (
    "context"
    "os"
    "testing"

    "example.com/myapp/server"
)

func TestWASMPlugin_Integration(t *testing.T) {
    // Build the WASM plugin first: GOOS=wasip1 GOARCH=wasm go build -o testdata/plugin.wasm ./cmd/wasi-plugin
    if _, err := os.Stat("testdata/plugin.wasm"); os.IsNotExist(err) {
        t.Skip("testdata/plugin.wasm not found, run: make build-server-plugin")
    }

    ctx := context.Background()
    plugin, err := server.NewWASMPlugin(ctx, "testdata/plugin.wasm")
    if err != nil {
        t.Fatalf("failed to create plugin: %v", err)
    }
    defer plugin.Close(ctx)

    resp, err := plugin.Execute(ctx, server.PluginRequest{Input: "hello world"})
    if err != nil {
        t.Fatalf("Execute failed: %v", err)
    }
    if resp.Error != "" {
        t.Fatalf("plugin error: %s", resp.Error)
    }
    if resp.Output != "Hello World" {
        t.Errorf("expected 'Hello World', got %q", resp.Output)
    }
}
```

## Section 9: Production Deployment Patterns

### Multi-Stage Docker Build

```dockerfile
# Dockerfile
FROM golang:1.22-alpine AS wasm-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Build browser WASM
RUN GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o static/main.wasm ./cmd/browser
RUN cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" static/
# Build server plugin
RUN GOOS=wasip1 GOARCH=wasm go build -ldflags="-s -w" -o plugins/processor.wasm ./cmd/wasi-plugin

FROM golang:1.22-alpine AS server-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=wasm-builder /app/static ./cmd/server/static
COPY --from=wasm-builder /app/plugins ./cmd/server/plugins
RUN go build -ldflags="-s -w" -o bin/server ./cmd/server

FROM alpine:3.19
WORKDIR /app
COPY --from=server-builder /app/bin/server .
EXPOSE 8080
CMD ["./server"]
```

## Conclusion

Go's WASM support spans two distinct runtime environments: the browser via `GOOS=js` with `syscall/js` for DOM interaction, and server-side WASI via `GOOS=wasip1` with runtimes like wazero. TinyGo provides a path to dramatically smaller binaries when stdlib compatibility constraints are acceptable. The key architectural insight is that WASM works best when pure logic is separated from I/O: the logic layer compiles unchanged to WASM, WASI, and native Go, while the I/O layer adapts to each environment. For server-side plugin systems, wazero enables sandboxed, untrusted code execution inside Go applications without CGO, making it an excellent foundation for extensible platform architectures.
