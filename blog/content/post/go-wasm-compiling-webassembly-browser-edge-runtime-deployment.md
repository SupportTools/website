---
title: "Go WASM: Compiling Go to WebAssembly for Browser and Edge Runtime Deployment"
date: 2030-09-29T00:00:00-05:00
draft: false
tags: ["Go", "WebAssembly", "WASM", "WASI", "TinyGo", "Browser", "Edge Computing"]
categories:
- Go
- WebAssembly
- Edge Computing
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go WASM guide covering GOOS=js GOARCH=wasm compilation, wasm_exec.js integration, syscall/js DOM manipulation, TinyGo for smaller binaries, WASI for server-side WASM, and performance characteristics compared to JavaScript."
more_link: "yes"
url: "/go-wasm-compiling-webassembly-browser-edge-runtime-deployment/"
---

WebAssembly brings Go's type safety, concurrency model, and standard library to the browser and edge runtimes without rewriting logic in JavaScript. The use cases are compelling: port a complex validation library used server-side to run identically client-side, run computationally intensive algorithms in the browser at near-native speed, or deploy Go business logic to edge workers without a container runtime. The tradeoff is binary size — the Go runtime adds overhead — which makes the TinyGo alternative important for size-constrained deployments.

<!--more-->

## Go WASM Compilation Overview

Go supports two WebAssembly targets:

1. **`GOOS=js GOARCH=wasm`**: Targets browser JavaScript environments. The compiled binary interacts with the browser via `syscall/js`. Requires `wasm_exec.js` from the Go runtime.

2. **`GOOS=wasip1 GOARCH=wasm`**: Targets WASI (WebAssembly System Interface) environments like Wasmtime, WasmEdge, and Cloudflare Workers. No browser dependency.

## Basic Browser WASM Compilation

### Minimal Hello World

```go
// main.go
//go:build js && wasm

package main

import (
    "fmt"
    "syscall/js"
)

func main() {
    fmt.Println("Go WASM loaded")

    // Register a Go function callable from JavaScript
    js.Global().Set("goHello", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        name := "World"
        if len(args) > 0 {
            name = args[0].String()
        }
        return fmt.Sprintf("Hello, %s from Go!", name)
    }))

    // Keep the Go runtime alive (goroutine blocks indefinitely)
    select {}
}
```

```bash
# Compile to WASM
GOOS=js GOARCH=wasm go build -o main.wasm .

# Copy the JavaScript runtime glue (must match Go version)
cp $(go env GOROOT)/misc/wasm/wasm_exec.js .

# Check binary size
ls -lh main.wasm
# -rw-r--r-- 1 user group 2.3M main.wasm  (typical for small programs)
```

### HTML Integration

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Go WASM Example</title>
</head>
<body>
    <div id="output"></div>
    <button id="btn">Call Go Function</button>

    <!-- Must be loaded before WASM -->
    <script src="wasm_exec.js"></script>
    <script>
        const go = new Go();

        // Load and instantiate the WASM binary
        WebAssembly.instantiateStreaming(fetch("main.wasm"), go.importObject)
            .then((result) => {
                // Start the Go runtime
                go.run(result.instance);

                // WASM is now running - Go functions are available
                document.getElementById("btn").addEventListener("click", () => {
                    // Call Go function registered via js.Global().Set()
                    const result = window.goHello("Enterprise Developer");
                    document.getElementById("output").textContent = result;
                });
            })
            .catch((err) => {
                console.error("Failed to load WASM:", err);
            });
    </script>
</body>
</html>
```

## syscall/js: DOM Manipulation and Browser APIs

The `syscall/js` package provides Go access to the JavaScript environment. It is a thin wrapper around the browser's JavaScript values.

### DOM Manipulation

```go
//go:build js && wasm

package main

import (
    "encoding/json"
    "fmt"
    "syscall/js"
    "time"
)

// FormData represents parsed form input
type FormData struct {
    Name  string `json:"name"`
    Email string `json:"email"`
    Value float64 `json:"value"`
}

// ValidationResult contains validation outcomes
type ValidationResult struct {
    Valid    bool     `json:"valid"`
    Errors   []string `json:"errors"`
}

func validateForm(data FormData) ValidationResult {
    var errors []string

    if len(data.Name) < 2 {
        errors = append(errors, "Name must be at least 2 characters")
    }
    if len(data.Name) > 100 {
        errors = append(errors, "Name must be at most 100 characters")
    }

    if len(data.Email) == 0 {
        errors = append(errors, "Email is required")
    } else if !isValidEmail(data.Email) {
        errors = append(errors, "Email format is invalid")
    }

    if data.Value < 0 {
        errors = append(errors, "Value cannot be negative")
    }
    if data.Value > 1_000_000 {
        errors = append(errors, "Value cannot exceed 1,000,000")
    }

    return ValidationResult{
        Valid:  len(errors) == 0,
        Errors: errors,
    }
}

func isValidEmail(email string) bool {
    // Basic validation - real implementation would be more thorough
    for i, c := range email {
        if c == '@' && i > 0 && i < len(email)-1 {
            return true
        }
    }
    return false
}

// Register functions and manipulate DOM
func main() {
    document := js.Global().Get("document")

    // Register validate function - returns JSON
    js.Global().Set("goValidateForm", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        if len(args) == 0 {
            return `{"valid":false,"errors":["no data provided"]}`
        }

        var data FormData
        if err := json.Unmarshal([]byte(args[0].String()), &data); err != nil {
            return fmt.Sprintf(`{"valid":false,"errors":["%s"]}`, err.Error())
        }

        result := validateForm(data)
        resultJSON, _ := json.Marshal(result)
        return string(resultJSON)
    }))

    // Register a function that creates DOM elements
    js.Global().Set("goCreateTable", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        if len(args) < 2 {
            return nil
        }

        targetID := args[0].String()
        dataJSON := args[1].String()

        var rows []map[string]interface{}
        if err := json.Unmarshal([]byte(dataJSON), &rows); err != nil {
            return nil
        }

        target := document.Call("getElementById", targetID)
        if target.IsNull() || target.IsUndefined() {
            return nil
        }

        // Clear existing content
        target.Set("innerHTML", "")

        // Create table
        table := document.Call("createElement", "table")
        table.Get("classList").Call("add", "data-table")

        if len(rows) > 0 {
            // Create header row
            thead := document.Call("createElement", "thead")
            tr := document.Call("createElement", "tr")
            for key := range rows[0] {
                th := document.Call("createElement", "th")
                th.Set("textContent", key)
                tr.Call("appendChild", th)
            }
            thead.Call("appendChild", tr)
            table.Call("appendChild", thead)
        }

        // Create data rows
        tbody := document.Call("createElement", "tbody")
        for _, row := range rows {
            tr := document.Call("createElement", "tr")
            for _, val := range row {
                td := document.Call("createElement", "td")
                td.Set("textContent", fmt.Sprintf("%v", val))
                tr.Call("appendChild", td)
            }
            tbody.Call("appendChild", tr)
        }
        table.Call("appendChild", tbody)
        target.Call("appendChild", table)

        return nil
    }))

    // Register a real-time calculation function
    js.Global().Set("goCalculate", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        if len(args) < 3 {
            return 0.0
        }
        a := args[0].Float()
        b := args[1].Float()
        op := args[2].String()

        switch op {
        case "add":
            return a + b
        case "subtract":
            return a - b
        case "multiply":
            return a * b
        case "divide":
            if b == 0 {
                return js.Global().Get("NaN")
            }
            return a / b
        default:
            return 0.0
        }
    }))

    // Set up event listener for automatic form validation
    formEl := document.Call("getElementById", "data-form")
    if !formEl.IsNull() && !formEl.IsUndefined() {
        var inputHandler js.Func
        inputHandler = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
            // Extract form data
            nameEl := document.Call("getElementById", "field-name")
            emailEl := document.Call("getElementById", "field-email")
            valueEl := document.Call("getElementById", "field-value")

            data := FormData{
                Name:  nameEl.Get("value").String(),
                Email: emailEl.Get("value").String(),
            }
            if v := valueEl.Get("value").String(); v != "" {
                fmt.Sscanf(v, "%f", &data.Value)
            }

            result := validateForm(data)
            resultJSON, _ := json.Marshal(result)

            // Update UI
            errDisplay := document.Call("getElementById", "validation-errors")
            if !errDisplay.IsNull() {
                if result.Valid {
                    errDisplay.Set("innerHTML", "<span class='valid'>Valid</span>")
                } else {
                    html := "<ul class='errors'>"
                    for _, e := range result.Errors {
                        html += fmt.Sprintf("<li>%s</li>", e)
                    }
                    html += "</ul>"
                    errDisplay.Set("innerHTML", html)
                }
            }

            _ = string(resultJSON) // Return ignored for event handlers
            return nil
        })
        formEl.Call("addEventListener", "input", inputHandler)
    }

    fmt.Printf("Go WASM initialized at %s\n", time.Now().Format(time.RFC3339))

    // Block forever to keep Go runtime alive
    c := make(chan struct{})
    <-c
}
```

### Calling JavaScript Promises from Go

```go
//go:build js && wasm

package main

import (
    "syscall/js"
    "fmt"
)

// awaitPromise converts a JavaScript Promise to Go channel result
func awaitPromise(promise js.Value) (js.Value, error) {
    resultCh := make(chan js.Value, 1)
    errCh := make(chan error, 1)

    var thenFunc js.Func
    var catchFunc js.Func

    thenFunc = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        if len(args) > 0 {
            resultCh <- args[0]
        } else {
            resultCh <- js.Undefined()
        }
        thenFunc.Release()
        catchFunc.Release()
        return nil
    })

    catchFunc = js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        errMsg := "promise rejected"
        if len(args) > 0 {
            errMsg = args[0].String()
        }
        errCh <- fmt.Errorf("%s", errMsg)
        thenFunc.Release()
        catchFunc.Release()
        return nil
    })

    promise.Call("then", thenFunc).Call("catch", catchFunc)

    select {
    case result := <-resultCh:
        return result, nil
    case err := <-errCh:
        return js.Undefined(), err
    }
}

// FetchJSON fetches JSON from a URL using browser's fetch API
func FetchJSON(url string) ([]byte, error) {
    fetchPromise := js.Global().Call("fetch", url)
    response, err := awaitPromise(fetchPromise)
    if err != nil {
        return nil, fmt.Errorf("fetch %s: %w", url, err)
    }

    jsonPromise := response.Call("json")
    jsonValue, err := awaitPromise(jsonPromise)
    if err != nil {
        return nil, fmt.Errorf("parsing JSON: %w", err)
    }

    // Convert JS value to Go string via JSON.stringify
    jsonStr := js.Global().Get("JSON").Call("stringify", jsonValue).String()
    return []byte(jsonStr), nil
}
```

## TinyGo for Smaller WASM Binaries

Standard Go WASM binaries include the full Go runtime and garbage collector, which inflates binary size. TinyGo compiles Go for resource-constrained environments and produces dramatically smaller WASM.

### Installation and Basic Usage

```bash
# Install TinyGo
wget https://github.com/tinygo-org/tinygo/releases/download/v0.33.0/tinygo_0.33.0_amd64.deb
dpkg -i tinygo_0.33.0_amd64.deb

# Or via brew on macOS:
# brew tap tinygo-org/tools && brew install tinygo

# Verify
tinygo version
# tinygo version 0.33.0 linux/amd64 (using go version go1.23 and LLVM version 18.1.2)

# Compile for WASM
tinygo build -o main-tiny.wasm -target wasm ./main.go

# Compare sizes
ls -lh main.wasm main-tiny.wasm
# -rw-r--r-- 1 user group 2.3M main.wasm
# -rw-r--r-- 1 user group 52K  main-tiny.wasm
# TinyGo: ~45x smaller

# For even smaller output, optimize aggressively
tinygo build -o main-tiny-opt.wasm \
  -target wasm \
  -opt=2 \
  -no-debug \
  ./main.go

# Compress with gzip or brotli for delivery
gzip -9 -k main-tiny.wasm
brotli --best main-tiny.wasm
ls -lh main-tiny.wasm.gz main-tiny.wasm.br
```

### TinyGo Limitations

TinyGo does not support the full Go standard library. Key limitations:

```go
// NOT supported in TinyGo (or limited support):
// - reflect package (limited)
// - encoding/json (use tinygo-specific alternatives)
// - net/http (no browser HTTP, use syscall/js fetch)
// - database/sql
// - sync/atomic on some targets
// - goroutines (limited support on wasm target)

// SUPPORTED alternatives:
import "github.com/tidwall/gjson"  // JSON parsing without reflection
import "github.com/valyala/fastjson" // Another reflection-free JSON
```

### TinyGo DOM Manipulation

TinyGo includes a `syscall/js` compatible package but with some differences:

```go
// tinygo-specific: use //go:build tinygo for conditional compilation
//go:build tinygo

package main

import (
    "syscall/js"
)

// TinyGo-compatible WASM functions
func main() {
    js.Global().Set("tinyValidate", js.FuncOf(validateInput))
    // TinyGo programs exit unless there's a blocking operation
    // Use a channel to block
    <-make(chan struct{})
}

func validateInput(this js.Value, args []js.Value) interface{} {
    if len(args) == 0 {
        return map[string]interface{}{
            "valid":  false,
            "error": "no input",
        }
    }
    input := args[0].String()
    if len(input) < 3 {
        return map[string]interface{}{
            "valid":  false,
            "error": "too short",
        }
    }
    return map[string]interface{}{
        "valid":  true,
        "result": input,
    }
}
```

## WASI: Server-Side WebAssembly

WASI (WebAssembly System Interface) standardizes WASM interaction with the host OS, enabling Go WASM modules to run in server contexts: Wasmtime, WasmEdge, Cloudflare Workers, Fastly Compute@Edge, and others.

### Compiling for WASI

```bash
# WASI target in standard Go
GOOS=wasip1 GOARCH=wasm go build -o main.wasi.wasm ./main.go

# Run with Wasmtime
wasmtime main.wasi.wasm

# Run with WasmEdge
wasmedge main.wasi.wasm

# TinyGo WASI compilation
tinygo build -o main-tiny.wasi.wasm -target wasi ./main.go
```

### WASI-Compatible Go Program

```go
// wasi/main.go - runs in WASI environments
// NOT browser-specific: uses standard os/fmt/io packages

package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "io"
    "os"
)

type Request struct {
    Action string          `json:"action"`
    Data   json.RawMessage `json:"data"`
}

type Response struct {
    Success bool        `json:"success"`
    Result  interface{} `json:"result,omitempty"`
    Error   string      `json:"error,omitempty"`
}

func main() {
    // WASI programs communicate via stdin/stdout
    scanner := bufio.NewScanner(os.Stdin)
    encoder := json.NewEncoder(os.Stdout)

    for scanner.Scan() {
        line := scanner.Text()
        if line == "" {
            continue
        }

        var req Request
        if err := json.Unmarshal([]byte(line), &req); err != nil {
            encoder.Encode(Response{
                Success: false,
                Error:   fmt.Sprintf("invalid request: %v", err),
            })
            continue
        }

        result, err := processAction(req)
        if err != nil {
            encoder.Encode(Response{
                Success: false,
                Error:   err.Error(),
            })
        } else {
            encoder.Encode(Response{
                Success: true,
                Result:  result,
            })
        }
    }

    if err := scanner.Err(); err != nil && err != io.EOF {
        fmt.Fprintf(os.Stderr, "scanner error: %v\n", err)
        os.Exit(1)
    }
}

func processAction(req Request) (interface{}, error) {
    switch req.Action {
    case "validate":
        var data struct {
            Value string `json:"value"`
        }
        if err := json.Unmarshal(req.Data, &data); err != nil {
            return nil, err
        }
        // Validation logic here (shared with server-side Go code)
        return map[string]interface{}{
            "valid":  len(data.Value) >= 3,
            "length": len(data.Value),
        }, nil

    case "transform":
        var data struct {
            Values []float64 `json:"values"`
        }
        if err := json.Unmarshal(req.Data, &data); err != nil {
            return nil, err
        }
        // Transformation logic
        result := make([]float64, len(data.Values))
        for i, v := range data.Values {
            result[i] = v * 1.1
        }
        return result, nil

    default:
        return nil, fmt.Errorf("unknown action: %s", req.Action)
    }
}
```

### Cloudflare Workers with WASM

```javascript
// cloudflare-worker.js
import wasmBinary from './main.wasi.wasm';

let wasmInstance = null;
let wasmMemory = null;

async function initWASM() {
    if (wasmInstance) return;

    const module = await WebAssembly.compile(wasmBinary);
    wasmInstance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: {
            // Minimal WASI implementation for Cloudflare Workers
            proc_exit: (code) => { throw new Error(`WASI exit: ${code}`); },
            fd_write: (fd, iovs, iovs_len, nwritten) => {
                // Handle stdout/stderr
                return 0;
            },
            // ... other WASI syscalls
        }
    });
}

export default {
    async fetch(request, env, ctx) {
        await initWASM();

        const url = new URL(request.url);
        const body = await request.json();

        // Call Go WASM function
        const result = callGoFunction(body);

        return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
        });
    }
};
```

## Performance Characteristics vs JavaScript

Understanding the performance model is critical for deciding when WASM makes sense.

### Benchmark: Computation-Heavy Task

```go
//go:build js && wasm

package main

import (
    "syscall/js"
    "math"
)

// computePrimes finds all primes up to n using Sieve of Eratosthenes
func computePrimes(n int) []int {
    sieve := make([]bool, n+1)
    for i := 2; i <= n; i++ {
        sieve[i] = true
    }
    for i := 2; i*i <= n; i++ {
        if sieve[i] {
            for j := i * i; j <= n; j += i {
                sieve[j] = false
            }
        }
    }
    primes := make([]int, 0)
    for i := 2; i <= n; i++ {
        if sieve[i] {
            primes = append(primes, i)
        }
    }
    return primes
}

func main() {
    js.Global().Set("goPrimeSieve", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        n := 1000000
        if len(args) > 0 {
            n = args[0].Int()
        }
        primes := computePrimes(n)
        return len(primes)
    }))

    // Also expose a matrix multiplication for numeric benchmark
    js.Global().Set("goMatMul", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        n := 100
        if len(args) > 0 {
            n = args[0].Int()
        }
        a := make([][]float64, n)
        b := make([][]float64, n)
        c := make([][]float64, n)
        for i := range a {
            a[i] = make([]float64, n)
            b[i] = make([]float64, n)
            c[i] = make([]float64, n)
            for j := range a[i] {
                a[i][j] = math.Sin(float64(i*n + j))
                b[i][j] = math.Cos(float64(i*n + j))
            }
        }
        for i := 0; i < n; i++ {
            for j := 0; j < n; j++ {
                sum := 0.0
                for k := 0; k < n; k++ {
                    sum += a[i][k] * b[k][j]
                }
                c[i][j] = sum
            }
        }
        return c[0][0] // Return corner value to prevent optimization
    }))

    select {}
}
```

### Performance Guidance

| Workload Type | WASM vs JS Performance |
|---|---|
| Pure computation (crypto, math) | WASM 1.2-2x faster |
| String processing | Comparable or JS faster |
| DOM manipulation | WASM slower (JS bridge overhead) |
| WebGL/Canvas | Comparable |
| JSON parsing | JS faster (native engine support) |
| Startup time | WASM slower (module instantiation) |

**Use Go WASM when:**
- Sharing business logic between server (Go) and browser (WASM) is the primary goal
- The computation is CPU-intensive (cryptography, compression, encoding, complex validation)
- Type safety and correctness of the Go implementation are more valuable than raw performance
- Binary size is managed via TinyGo or brotli compression

**Avoid Go WASM when:**
- The workload is primarily DOM manipulation or animation
- Binary size is critical and TinyGo limitations are prohibitive
- The required Go packages are not supported by TinyGo and the full runtime size is unacceptable

## Build Tooling and CI/CD

### Makefile for Multi-Target WASM Builds

```makefile
GOOS_JS     := js
GOARCH_WASM := wasm
GOOS_WASI   := wasip1

.PHONY: wasm-browser wasm-wasi wasm-tiny-browser wasm-tiny-wasi compress

wasm-browser:
	GOOS=$(GOOS_JS) GOARCH=$(GOARCH_WASM) go build \
	  -ldflags="-s -w" \
	  -o dist/main.wasm \
	  ./cmd/wasm/
	cp $(shell go env GOROOT)/misc/wasm/wasm_exec.js dist/

wasm-wasi:
	GOOS=$(GOOS_WASI) GOARCH=$(GOARCH_WASM) go build \
	  -ldflags="-s -w" \
	  -o dist/main.wasi.wasm \
	  ./cmd/wasi/

wasm-tiny-browser:
	tinygo build \
	  -target wasm \
	  -opt=2 \
	  -no-debug \
	  -o dist/main-tiny.wasm \
	  ./cmd/wasm/
	cp $(shell tinygo env TINYGOROOT)/targets/wasm_exec.js dist/wasm_exec_tiny.js

wasm-tiny-wasi:
	tinygo build \
	  -target wasi \
	  -opt=2 \
	  -no-debug \
	  -o dist/main-tiny.wasi.wasm \
	  ./cmd/wasi/

compress: wasm-browser wasm-tiny-browser
	brotli --best dist/main.wasm
	brotli --best dist/main-tiny.wasm
	gzip -9 -k dist/main.wasm
	gzip -9 -k dist/main-tiny.wasm
	@echo "File sizes:"
	@ls -lh dist/*.wasm dist/*.wasm.br dist/*.wasm.gz

# Run WASI binary with Wasmtime (for testing)
test-wasi: wasm-wasi
	echo '{"action":"validate","data":{"value":"test"}}' | \
	  wasmtime dist/main.wasi.wasm
```

### Serving WASM with Correct MIME Type

```nginx
# nginx configuration
server {
    listen 80;
    server_name example.com;
    root /var/www/html;

    # WASM requires correct MIME type for streaming instantiation
    types {
        application/wasm wasm;
    }

    # Enable compression - WASM compresses very well
    gzip on;
    gzip_types application/wasm text/javascript;
    gzip_min_length 1024;

    # Brotli pre-compressed (if available)
    location ~* \.wasm$ {
        # Serve pre-compressed brotli if available and client supports it
        add_header Vary Accept-Encoding;
        try_files $uri.br $uri.gz $uri =404;
        add_header Content-Encoding br;  # Set when serving .br
        types { application/wasm wasm; }
    }

    # Cache WASM aggressively (versioned by filename)
    location ~* \.(wasm|js)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

Go WASM is most valuable when it enables code reuse between server and browser without a JavaScript rewrite, not when it is pursued for raw performance gains. The operational complexity of managing WASM artifacts in CI/CD and the startup latency cost make it a considered architectural decision rather than a default choice for client-side computation.
