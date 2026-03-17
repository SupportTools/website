---
title: "Go WebAssembly: Compiling to WASM, syscall/js Interop, TinyGo for Smaller Binaries, and the WASM Component Model"
date: 2032-02-14T00:00:00-05:00
draft: false
tags: ["Go", "WebAssembly", "WASM", "TinyGo", "Frontend", "Performance"]
categories:
- Go
- WebAssembly
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise-grade guide to compiling Go to WebAssembly, bridging Go and JavaScript with syscall/js, reducing binary sizes with TinyGo, and adopting the WASM component model for portable, language-agnostic modules."
more_link: "yes"
url: "/go-webassembly-wasm-tinygo-component-model-enterprise-guide/"
---

WebAssembly enables Go programs to run at near-native speed inside browsers, edge runtimes, and server-side WASM hosts. This guide covers the full journey: compiling standard Go to `.wasm`, bridging the Go runtime to the JavaScript DOM via `syscall/js`, shrinking binaries dramatically with TinyGo, and understanding the emerging WASM Component Model that brings language-agnostic portability to WASM modules.

<!--more-->

# Go WebAssembly: Compiling, Interop, TinyGo, and the Component Model

## Section 1: Why Go and WebAssembly

Go compiles to a single binary with no runtime dependencies. That same property makes it attractive for WASM: you ship one `.wasm` file, and it runs identically in Chrome, Firefox, Deno, Wasmtime, and AWS Lambda@Edge. Common enterprise use cases include:

- **Browser-side cryptography**: run Go crypto libraries (FIPS-validated if needed) in the browser without exposing keys to JavaScript
- **Edge validation logic**: the same input validation code runs in the backend Go service and in the CDN edge function
- **Plugin systems**: load tenant-specific WASM modules at runtime without restarting the host
- **Porting CLI tools to the web**: wrap an existing Go CLI (linter, formatter, analyzer) into a browser playground

## Section 2: Compiling Standard Go to WASM

### Basic Compilation

The Go toolchain ships with WASM support out of the box. Set `GOOS=js` and `GOARCH=wasm`:

```bash
GOOS=js GOARCH=wasm go build -o main.wasm ./cmd/mywasm
```

To serve it in a browser you also need the glue JavaScript loader that the Go toolchain ships:

```bash
cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" ./static/
```

### Minimal HTML Harness

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Go WASM Demo</title>
</head>
<body>
  <script src="/static/wasm_exec.js"></script>
  <script>
    const go = new Go();
    WebAssembly.instantiateStreaming(fetch("/static/main.wasm"), go.importObject)
      .then(result => {
        go.run(result.instance);
      });
  </script>
  <div id="output"></div>
</body>
</html>
```

### Go HTTP Server to Serve WASM

```go
// cmd/server/main.go
package main

import (
    "log"
    "net/http"
    "os"
)

func main() {
    mux := http.NewServeMux()

    fs := http.FileServer(http.Dir("./static"))
    mux.Handle("/static/", http.StripPrefix("/static/", fs))

    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        http.ServeFile(w, r, "./static/index.html")
    })

    // WASM files must be served with the correct MIME type
    http.HandleFunc("/static/main.wasm", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/wasm")
        http.ServeFile(w, r, "./static/main.wasm")
    })

    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }

    log.Printf("Listening on :%s", port)
    log.Fatal(http.ListenAndServe(":"+port, mux))
}
```

## Section 3: syscall/js — Bridging Go and JavaScript

The `syscall/js` package provides the bridge between the Go WASM runtime and the browser's JavaScript environment. It exposes the global JavaScript object, allows calling JS functions, and lets Go register callbacks.

### Exposing a Go Function to JavaScript

```go
// cmd/mywasm/main.go
//go:build js && wasm

package main

import (
    "encoding/json"
    "fmt"
    "syscall/js"
)

// validateEmail validates an email address using Go's net/mail package
// and exposes the result to JavaScript.
func validateEmail(this js.Value, args []js.Value) interface{} {
    if len(args) == 0 {
        return map[string]interface{}{
            "valid": false,
            "error": "no argument provided",
        }
    }
    email := args[0].String()

    // Use a simple validation rule for demonstration
    valid := len(email) > 3 && containsAt(email)

    return map[string]interface{}{
        "valid": valid,
        "email": email,
    }
}

func containsAt(s string) bool {
    for _, c := range s {
        if c == '@' {
            return true
        }
    }
    return false
}

// processJSON parses a JSON payload, transforms it, and returns new JSON.
func processJSON(this js.Value, args []js.Value) interface{} {
    if len(args) == 0 {
        return js.ValueOf("error: no argument")
    }

    raw := args[0].String()
    var data map[string]interface{}
    if err := json.Unmarshal([]byte(raw), &data); err != nil {
        return js.ValueOf(fmt.Sprintf("error: %v", err))
    }

    // Transform: add a "processed_by" key
    data["processed_by"] = "go-wasm"
    data["field_count"] = len(data)

    result, err := json.Marshal(data)
    if err != nil {
        return js.ValueOf(fmt.Sprintf("error: %v", err))
    }
    return js.ValueOf(string(result))
}

func main() {
    // Register functions on the global JS object
    js.Global().Set("goValidateEmail", js.FuncOf(validateEmail))
    js.Global().Set("goProcessJSON", js.FuncOf(processJSON))

    fmt.Println("Go WASM module loaded")

    // Keep the Go runtime alive; the WASM module exits when main returns
    // unless we block here
    select {}
}
```

### Calling DOM APIs from Go

```go
//go:build js && wasm

package main

import (
    "fmt"
    "syscall/js"
    "time"
)

func appendToDOM(id, text string) {
    doc := js.Global().Get("document")
    el := doc.Call("getElementById", id)
    if el.IsNull() || el.IsUndefined() {
        fmt.Printf("element %q not found\n", id)
        return
    }

    p := doc.Call("createElement", "p")
    p.Set("textContent", text)
    el.Call("appendChild", p)
}

func registerClickHandler(buttonID string, handler func()) {
    doc := js.Global().Get("document")
    btn := doc.Call("getElementById", buttonID)
    if btn.IsNull() {
        fmt.Printf("button %q not found\n", buttonID)
        return
    }

    cb := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        handler()
        return nil
    })
    // Store reference to prevent garbage collection
    js.Global().Set("_goClickHandler_"+buttonID, cb)
    btn.Call("addEventListener", "click", cb)
}

func main() {
    registerClickHandler("run-btn", func() {
        now := time.Now().Format(time.RFC3339)
        appendToDOM("output", fmt.Sprintf("Button clicked at %s (from Go)", now))
    })
    select {}
}
```

### Calling Async JavaScript Promises from Go

```go
//go:build js && wasm

package main

import (
    "fmt"
    "syscall/js"
)

// fetchURL wraps the browser fetch() API and returns the response body.
func fetchURL(url string) (string, error) {
    // Create a channel to receive the result
    resultCh := make(chan string, 1)
    errCh := make(chan error, 1)

    // Call fetch() and attach .then()/.catch()
    fetchPromise := js.Global().Call("fetch", url)

    thenFn := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        response := args[0]
        textPromise := response.Call("text")
        textThen := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
            resultCh <- args[0].String()
            return nil
        })
        textPromise.Call("then", textThen)
        return nil
    })

    catchFn := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        errCh <- fmt.Errorf("fetch error: %s", args[0].String())
        return nil
    })

    fetchPromise.Call("then", thenFn).Call("catch", catchFn)

    select {
    case result := <-resultCh:
        return result, nil
    case err := <-errCh:
        return "", err
    }
}

func main() {
    js.Global().Set("goFetch", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        if len(args) == 0 {
            return js.ValueOf("error: URL required")
        }
        url := args[0].String()

        // Run in a goroutine because we block on the channel
        go func() {
            body, err := fetchURL(url)
            if err != nil {
                fmt.Printf("fetchURL error: %v\n", err)
                return
            }
            doc := js.Global().Get("document")
            el := doc.Call("getElementById", "fetch-result")
            if !el.IsNull() {
                el.Set("textContent", body[:min(len(body), 500)])
            }
        }()
        return nil
    }))
    select {}
}

func min(a, b int) int {
    if a < b {
        return a
    }
    return b
}
```

## Section 4: Binary Size and the Problem with the Standard Go Runtime

A minimal "Hello, World" Go WASM binary is approximately 2.5 MB uncompressed, 800 KB gzip-compressed. This is because the standard Go runtime includes:

- A full garbage collector
- The goroutine scheduler
- Reflection support
- All of `fmt`, `os`, `net`, and other standard packages pulled transitively

For browser delivery, 800 KB is acceptable on fast connections but painful on mobile or slow CDN edges. The solution is TinyGo.

## Section 5: TinyGo for Smaller Binaries

TinyGo is an alternative Go compiler targeting microcontrollers and WebAssembly. It produces dramatically smaller binaries by:

- Using LLVM instead of gc
- Eliminating unused code more aggressively (tree-shaking)
- Using a minimal GC (leaking GC or conservative GC)
- Not including the full reflection machinery

### Installing TinyGo

```bash
# Ubuntu / Debian
wget https://github.com/tinygo-org/tinygo/releases/download/v0.32.0/tinygo_0.32.0_amd64.deb
sudo dpkg -i tinygo_0.32.0_amd64.deb

# macOS
brew tap tinygo-org/tools
brew install tinygo

# Verify
tinygo version
```

### Compiling with TinyGo

```bash
# Target: WASM for browser (uses wasi_snapshot_preview1 or js target)
tinygo build -o main-tiny.wasm -target wasm ./cmd/mywasm

# Target: WASI for server-side WASM runtimes (Wasmtime, WasmEdge)
tinygo build -o main-wasi.wasm -target wasip1 ./cmd/mywasm

# Check sizes
ls -lh main.wasm main-tiny.wasm
# main.wasm:      2.8M
# main-tiny.wasm: 142K
```

The TinyGo binary is typically 10-20x smaller for comparable logic.

### TinyGo WASM Glue JavaScript

TinyGo has its own glue script, different from the standard Go one:

```bash
cp "$(tinygo env TINYGOROOT)/targets/wasm_exec.js" ./static/wasm_exec_tiny.js
```

```html
<script src="/static/wasm_exec_tiny.js"></script>
<script>
  const go = new TinyGo();
  WebAssembly.instantiateStreaming(fetch("/static/main-tiny.wasm"), go.importObject)
    .then(result => {
      go.run(result.instance);
    });
</script>
```

### TinyGo Limitations

TinyGo does not support all Go features. Key limitations to plan for:

| Feature | Standard Go | TinyGo |
|---|---|---|
| Full `reflect` package | Yes | Partial |
| `encoding/json` with interfaces | Yes | Limited |
| Goroutines | Yes | Stackful coroutines |
| `cgo` | Yes | No |
| `net` package | Yes | Limited |
| Finalizers | Yes | No |

For WASM browser builds, the most common workaround is replacing `encoding/json` with a simpler JSON library:

```go
// Instead of encoding/json with interfaces, use a struct-based approach
// or a TinyGo-compatible JSON library like tinygo.org/x/drivers

// Good: struct with known fields
type Config struct {
    Timeout int    `json:"timeout"`
    Host    string `json:"host"`
}

// Avoid: interface{} maps
// var data map[string]interface{}   // slow reflection path
```

### Size Comparison: Optimization Flags

```bash
# Standard Go with optimizations
GOOS=js GOARCH=wasm go build \
  -ldflags="-s -w" \
  -trimpath \
  -o main-opt.wasm ./cmd/mywasm

# TinyGo with optimizations
tinygo build \
  -target wasm \
  -opt 2 \
  -no-debug \
  -o main-tiny-opt.wasm ./cmd/mywasm

# Compress for serving
wasm-opt -Oz --enable-bulk-memory main-tiny-opt.wasm -o main-tiny-final.wasm
gzip -9 -k main-tiny-final.wasm

ls -lh main-opt.wasm main-tiny-opt.wasm main-tiny-final.wasm main-tiny-final.wasm.gz
```

`wasm-opt` from the Binaryen toolkit applies additional WASM-level optimizations independent of the compiler.

## Section 6: WASI — Running Go WASM Outside the Browser

WASI (WebAssembly System Interface) is a standardized syscall API for WASM modules running outside the browser. It gives WASM programs access to files, environment variables, clocks, and sockets without the browser DOM.

```go
//go:build wasip1

// cmd/wasiapp/main.go
package main

import (
    "bufio"
    "fmt"
    "os"
    "strings"
)

func main() {
    // Read from stdin, transform, write to stdout
    // This runs in Wasmtime, WasmEdge, Docker+WASM, etc.
    scanner := bufio.NewScanner(os.Stdin)
    for scanner.Scan() {
        line := scanner.Text()
        fmt.Println(strings.ToUpper(line))
    }
    if err := scanner.Err(); err != nil {
        fmt.Fprintln(os.Stderr, "error:", err)
        os.Exit(1)
    }
}
```

```bash
# Build for WASI
GOOS=wasip1 GOARCH=wasm go build -o app.wasm ./cmd/wasiapp

# Run with Wasmtime
echo "hello from wasi" | wasmtime app.wasm

# Run inside Docker with WASM runtime support (Docker Desktop >= 4.15)
docker run --runtime=io.containerd.wasmtime.v1 \
  --platform wasi/wasm \
  -v $(pwd)/app.wasm:/app.wasm \
  scratch /app.wasm
```

## Section 7: The WASM Component Model

The WASM Component Model (WCM) is a specification from the W3C WebAssembly CG that adds:

- **Typed interface definitions** via WIT (WebAssembly Interface Types)
- **Composability**: components expose and consume typed interfaces, enabling language-agnostic composition
- **Resource types**: first-class handles to objects owned by a component
- **Linking**: components are linked at runtime, not compile time

### WIT Interface Definition

```wit
// greeter.wit
package example:greeter;

interface greeter {
  greet: func(name: string) -> string;
  greet-many: func(names: list<string>) -> list<string>;
}

world greeter-world {
  export greeter;
}
```

### Generating Go Bindings with wit-bindgen

```bash
# Install wit-bindgen
cargo install wit-bindgen-cli

# Generate Go bindings for the component
wit-bindgen tiny-go \
  --world greeter-world \
  --out-dir ./generated \
  greeter.wit
```

The generated bindings provide type-safe Go functions. You implement the interface:

```go
// component/main.go
package main

import (
    "fmt"
    // Generated by wit-bindgen
    greeter "example/generated"
)

// Implement the exported interface
type GreeterImpl struct{}

func (g *GreeterImpl) Greet(name string) string {
    return fmt.Sprintf("Hello, %s! (from Go component)", name)
}

func (g *GreeterImpl) GreetMany(names []string) []string {
    results := make([]string, len(names))
    for i, name := range names {
        results[i] = g.Greet(name)
    }
    return results
}

func init() {
    greeter.SetGreeter(&GreeterImpl{})
}

func main() {}
```

### Building a Component with TinyGo

```bash
# Build the core WASM module
tinygo build \
  -target wasip1 \
  -buildmode c-shared \
  -o core.wasm \
  ./component

# Adapt to component model format using wasm-tools
wasm-tools component new core.wasm \
  --adapt wasi_snapshot_preview1=wasi_snapshot_preview1.reactor.wasm \
  -o greeter.component.wasm

# Compose with another component
wasm-tools compose \
  greeter.component.wasm \
  -d logger.component.wasm \
  -o composed.wasm
```

### Runtime: Wasmtime Component Model Support

```go
// host/main.go — a Go program that loads and runs a WASM component
package main

import (
    "context"
    "fmt"
    "log"

    // wasmtime Go SDK (github.com/bytecodealliance/wasmtime-go)
    "github.com/bytecodealliance/wasmtime-go/v14"
)

func main() {
    engine := wasmtime.NewEngine()
    store := wasmtime.NewStore(engine)

    // Load the component WASM bytes
    wasmBytes, err := os.ReadFile("greeter.component.wasm")
    if err != nil {
        log.Fatal(err)
    }

    module, err := wasmtime.NewModule(engine, wasmBytes)
    if err != nil {
        log.Fatal(err)
    }

    linker := wasmtime.NewLinker(engine)
    if err := linker.DefineWasi(); err != nil {
        log.Fatal(err)
    }

    instance, err := linker.Instantiate(store, module)
    if err != nil {
        log.Fatal(err)
    }

    // Call the exported greet function
    greetFn := instance.GetFunc(store, "example:greeter/greeter#greet")
    if greetFn == nil {
        log.Fatal("greet function not found")
    }

    result, err := greetFn.Call(store, "World")
    if err != nil {
        log.Fatal(err)
    }

    fmt.Println(result)
    // Output: Hello, World! (from Go component)
    _ = context.Background()
}
```

## Section 8: Enterprise Deployment Patterns

### Pattern 1: Browser-Side Validation with Shared Go Logic

```
┌─────────────────────────────────────────────────────┐
│ shared/validation                                     │
│   validate.go  (pure Go, no OS/network calls)        │
└─────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌──────────────────┐    ┌──────────────────────────────┐
│ cmd/api-server   │    │ cmd/browser-wasm              │
│ (Linux/amd64)    │    │ (GOOS=js GOARCH=wasm)         │
│ Full Go server   │    │ Thin wrapper + syscall/js     │
└──────────────────┘    └──────────────────────────────┘
```

### Pattern 2: Edge Function Deployment

```bash
# Build for Cloudflare Workers (uses V8 WASM, not WASI)
GOOS=js GOARCH=wasm go build -o worker.wasm ./cmd/edge-validator

# Cloudflare Wrangler config
cat > wrangler.toml << 'EOF'
name = "go-validator"
main = "src/index.js"

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
fallthrough = true
EOF

# JavaScript wrapper for Cloudflare Workers
cat > src/index.js << 'EOF'
import goWasm from '../worker.wasm';
import { WASI } from '@cloudflare/workers-wasm';

export default {
  async fetch(request) {
    const wasi = new WASI();
    const instance = await WebAssembly.instantiate(goWasm, {
      ...wasi.getImportObject(),
    });
    wasi.start(instance);
    // Call exported Go functions
    const result = instance.exports.validateRequest(await request.text());
    return new Response(result, { status: 200 });
  }
};
EOF
```

### Pattern 3: Plugin System with Dynamic WASM Loading

```go
// plugin/manager.go
package plugin

import (
    "context"
    "fmt"
    "os"
    "sync"

    "github.com/tetratelabs/wazero"
    "github.com/tetratelabs/wazero/api"
    "github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// Manager loads and executes WASM plugins at runtime.
type Manager struct {
    mu      sync.RWMutex
    runtime wazero.Runtime
    plugins map[string]api.Module
    ctx     context.Context
}

func NewManager(ctx context.Context) (*Manager, error) {
    r := wazero.NewRuntime(ctx)
    if _, err := wasi_snapshot_preview1.Instantiate(ctx, r); err != nil {
        return nil, fmt.Errorf("failed to instantiate WASI: %w", err)
    }
    return &Manager{
        runtime: r,
        plugins: make(map[string]api.Module),
        ctx:     ctx,
    }, nil
}

func (m *Manager) LoadPlugin(name, path string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    wasmBytes, err := os.ReadFile(path)
    if err != nil {
        return fmt.Errorf("read plugin %q: %w", name, err)
    }

    compiled, err := m.runtime.CompileModule(m.ctx, wasmBytes)
    if err != nil {
        return fmt.Errorf("compile plugin %q: %w", name, err)
    }

    mod, err := m.runtime.InstantiateModule(m.ctx, compiled,
        wazero.NewModuleConfig().
            WithName(name).
            WithStdout(os.Stdout).
            WithStderr(os.Stderr),
    )
    if err != nil {
        return fmt.Errorf("instantiate plugin %q: %w", name, err)
    }

    m.plugins[name] = mod
    return nil
}

func (m *Manager) Call(pluginName, funcName string, args ...uint64) ([]uint64, error) {
    m.mu.RLock()
    mod, ok := m.plugins[pluginName]
    m.mu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("plugin %q not loaded", pluginName)
    }

    fn := mod.ExportedFunction(funcName)
    if fn == nil {
        return nil, fmt.Errorf("function %q not found in plugin %q", funcName, pluginName)
    }

    return fn.Call(m.ctx, args...)
}

func (m *Manager) UnloadPlugin(name string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    mod, ok := m.plugins[name]
    if !ok {
        return fmt.Errorf("plugin %q not found", name)
    }

    if err := mod.Close(m.ctx); err != nil {
        return fmt.Errorf("close plugin %q: %w", name, err)
    }

    delete(m.plugins, name)
    return nil
}
```

## Section 9: Testing WASM Modules

```go
// cmd/mywasm/main_test.go
//go:build js && wasm

package main

import (
    "testing"
    "syscall/js"
)

func TestValidateEmail(t *testing.T) {
    tests := []struct {
        input string
        want  bool
    }{
        {"user@example.com", true},
        {"invalid", false},
        {"@", false},
        {"a@b", true},
    }

    for _, tt := range tests {
        arg := js.ValueOf(tt.input)
        result := validateEmail(js.Value{}, []js.Value{arg})
        m, ok := result.(map[string]interface{})
        if !ok {
            t.Fatalf("expected map, got %T", result)
        }
        if got := m["valid"].(bool); got != tt.want {
            t.Errorf("validateEmail(%q) = %v, want %v", tt.input, got, tt.want)
        }
    }
}
```

Run tests in a headless browser (via `go test` with WASM support):

```bash
# Using Node.js as the WASM test runner
GOOS=js GOARCH=wasm go test -v ./cmd/mywasm/ \
  -exec "$(go env GOROOT)/misc/wasm/go_js_wasm_exec"
```

For TinyGo tests:

```bash
tinygo test -target wasm -v ./cmd/mywasm/
```

## Section 10: Performance Profiling

```go
//go:build js && wasm

package main

import (
    "fmt"
    "syscall/js"
    "time"
)

// Benchmark a Go function from JavaScript
func benchmarkFn(this js.Value, args []js.Value) interface{} {
    if len(args) < 2 {
        return js.ValueOf("error: need function name and iterations")
    }

    name := args[0].String()
    iterations := args[1].Int()

    start := time.Now()
    switch name {
    case "json-parse":
        for i := 0; i < iterations; i++ {
            processJSON(js.Value{}, []js.Value{
                js.ValueOf(`{"key":"value","num":42}`),
            })
        }
    default:
        return js.ValueOf(fmt.Sprintf("unknown benchmark: %s", name))
    }

    elapsed := time.Since(start)
    opsPerSec := float64(iterations) / elapsed.Seconds()

    return map[string]interface{}{
        "benchmark":   name,
        "iterations":  iterations,
        "elapsed_ms":  elapsed.Milliseconds(),
        "ops_per_sec": opsPerSec,
    }
}

func main() {
    js.Global().Set("goBenchmark", js.FuncOf(benchmarkFn))
    select {}
}
```

## Section 11: CI/CD Integration

```yaml
# .github/workflows/wasm-build.yaml
name: Build and Test WASM

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-standard:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'

    - name: Build WASM (standard Go)
      run: |
        GOOS=js GOARCH=wasm go build \
          -ldflags="-s -w" \
          -trimpath \
          -o dist/main.wasm \
          ./cmd/mywasm

    - name: Test WASM
      run: |
        npm install -g node
        GOOS=js GOARCH=wasm go test -v ./cmd/mywasm/ \
          -exec "$(go env GOROOT)/misc/wasm/go_js_wasm_exec"

    - name: Report size
      run: |
        ls -lh dist/main.wasm
        gzip -9 -k dist/main.wasm
        ls -lh dist/main.wasm.gz

  build-tinygo:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Install TinyGo
      run: |
        wget -q https://github.com/tinygo-org/tinygo/releases/download/v0.32.0/tinygo_0.32.0_amd64.deb
        sudo dpkg -i tinygo_0.32.0_amd64.deb

    - name: Build WASM (TinyGo)
      run: |
        tinygo build \
          -target wasm \
          -opt 2 \
          -no-debug \
          -o dist/main-tiny.wasm \
          ./cmd/mywasm

    - name: Install wasm-opt
      run: sudo apt-get install -y binaryen

    - name: Optimize with wasm-opt
      run: |
        wasm-opt -Oz \
          dist/main-tiny.wasm \
          -o dist/main-tiny-opt.wasm

    - name: Report sizes
      run: |
        echo "Standard Go WASM:"
        ls -lh dist/main.wasm || true
        echo "TinyGo WASM:"
        ls -lh dist/main-tiny.wasm
        echo "TinyGo WASM (optimized):"
        ls -lh dist/main-tiny-opt.wasm

    - uses: actions/upload-artifact@v4
      with:
        name: wasm-binaries
        path: dist/*.wasm
```

## Section 12: Memory Management Considerations

The Go GC runs inside the WASM sandbox. For browser applications, large in-memory allocations compete with the JavaScript heap. Key practices:

```go
//go:build js && wasm

package main

import (
    "runtime"
    "syscall/js"
)

// Expose GC control to JavaScript for benchmarking
func gcStats(this js.Value, args []js.Value) interface{} {
    var stats runtime.MemStats
    runtime.ReadMemStats(&stats)
    return map[string]interface{}{
        "alloc_mb":       float64(stats.Alloc) / 1024 / 1024,
        "total_alloc_mb": float64(stats.TotalAlloc) / 1024 / 1024,
        "sys_mb":         float64(stats.Sys) / 1024 / 1024,
        "num_gc":         stats.NumGC,
        "heap_objects":   stats.HeapObjects,
    }
}

func forceGC(this js.Value, args []js.Value) interface{} {
    runtime.GC()
    return nil
}

func main() {
    js.Global().Set("goGCStats", js.FuncOf(gcStats))
    js.Global().Set("goForceGC", js.FuncOf(forceGC))
    select {}
}
```

## Summary

Go's WASM story has matured significantly:

- **Standard Go** (`GOOS=js GOARCH=wasm`) provides full Go compatibility in browsers via `syscall/js`, at the cost of a ~2-3 MB binary
- **TinyGo** shrinks binaries by 10-20x by eliminating unused runtime features, suitable for performance-sensitive browser delivery
- **WASI** (`GOOS=wasip1`) enables Go WASM in server-side runtimes (Wasmtime, WasmEdge, Docker) with filesystem and network access
- **The WASM Component Model** is the next step: typed interfaces via WIT, language-agnostic composition, and runtime linking — positioning WASM as a universal plugin format for enterprise systems

When choosing between standard Go and TinyGo for production WASM, profile the specific use case. TinyGo wins on binary size; standard Go wins on full standard library compatibility and goroutine behavior.
