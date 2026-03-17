---
title: "Go WASM: WebAssembly Module Development, TinyGo Compilation, and Browser Integration"
date: 2028-07-14T00:00:00-05:00
draft: false
tags: ["Go", "WebAssembly", "WASM", "TinyGo", "Browser"]
categories:
- Go
- WebAssembly
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete production guide to building WebAssembly modules in Go and TinyGo, covering syscall/js bindings, wasm_exec.js integration, WASI targets, performance optimization, and real-world browser use cases."
more_link: "yes"
url: "/go-webassembly-wasm-tinygo-guide/"
---

Go's first-class WebAssembly support, combined with TinyGo's ability to produce dramatically smaller binaries, makes it a compelling choice for high-performance browser-side logic, edge computing, and plugin systems. This guide covers the full development lifecycle from compilation to browser integration, with working examples that go beyond the obligatory "Hello, World" to tackle real production concerns.

<!--more-->

# Go WASM: WebAssembly Module Development, TinyGo Compilation, and Browser Integration

## Section 1: Understanding Go WASM Targets

Go supports two WASM targets with different trade-offs:

| Target | Toolchain | Binary Size | WASI Support | Browser Support | Use Case |
|--------|-----------|------------|--------------|-----------------|----------|
| `GOOS=js GOARCH=wasm` | `go build` | 5–15 MB | No | Yes (needs wasm_exec.js) | Browser apps with full Go runtime |
| `GOARCH=wasm GOOS=wasip1` | `go build` (1.21+) | 5–15 MB | Yes | Via WASI polyfill | Edge/server-side |
| `GOARCH=wasm` | TinyGo | 50–500 KB | Both | Yes | Size-critical browser/edge |

### Standard Toolchain Build

```bash
# Standard library compilation
GOOS=js GOARCH=wasm go build -o main.wasm main.go

# WASI target (Go 1.21+)
GOOS=wasip1 GOARCH=wasm go build -o main.wasm main.go

# Copy the JavaScript glue file
cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" .

# Check binary size
ls -lh main.wasm
```

### TinyGo Build

```bash
# Install TinyGo (macOS)
brew tap tinygo-org/tools
brew install tinygo

# Build for browser
tinygo build -o main.wasm -target wasm ./main.go

# Build for WASI
tinygo build -o main.wasm -target wasi ./main.go

# Optimize for size (runs wasm-opt internally)
tinygo build -o main.wasm -target wasm -opt=2 ./main.go

# Compare sizes
ls -lh main.wasm
```

---

## Section 2: syscall/js — The Browser Bridge

### Registering Go Functions as JavaScript Callables

```go
// main.go — browser WASM module
//go:build js && wasm

package main

import (
	"fmt"
	"math"
	"syscall/js"
)

// Add two numbers — exposed to JavaScript
func add(this js.Value, args []js.Value) interface{} {
	if len(args) != 2 {
		return js.ValueOf("error: expected 2 arguments")
	}
	a := args[0].Float()
	b := args[1].Float()
	return js.ValueOf(a + b)
}

// Distance calculates Euclidean distance
func distance(this js.Value, args []js.Value) interface{} {
	if len(args) != 4 {
		return js.ValueOf("error: expected 4 arguments (x1,y1,x2,y2)")
	}
	x1, y1 := args[0].Float(), args[1].Float()
	x2, y2 := args[2].Float(), args[3].Float()
	d := math.Sqrt(math.Pow(x2-x1, 2) + math.Pow(y2-y1, 2))
	return js.ValueOf(d)
}

// parseJSON — demonstrate string handling
func parseAndProcess(this js.Value, args []js.Value) interface{} {
	if len(args) != 1 {
		return js.ValueOf(map[string]interface{}{"error": "expected 1 argument"})
	}
	input := args[0].String()
	// Process the string in Go
	result := fmt.Sprintf("Processed: %s (length: %d)", input, len(input))
	return js.ValueOf(result)
}

// registerCallbacks registers all Go functions on the global JS object
func registerCallbacks() {
	global := js.Global()
	global.Set("goAdd", js.FuncOf(add))
	global.Set("goDistance", js.FuncOf(distance))
	global.Set("goParseAndProcess", js.FuncOf(parseAndProcess))
}

func main() {
	// Register functions
	registerCallbacks()

	fmt.Println("Go WASM module loaded")

	// Keep the module alive — required for callback-based modules
	// The channel blocks main() from returning, keeping all registered
	// functions active for the lifetime of the page.
	done := make(chan struct{}, 0)
	<-done
}
```

### HTML Integration

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Go WASM Demo</title>
</head>
<body>
  <h1>Go WASM Calculator</h1>
  <input id="a" type="number" value="3">
  <input id="b" type="number" value="4">
  <button onclick="calculate()">Calculate Distance</button>
  <p id="result"></p>

  <!-- Standard Go WASM runtime shim -->
  <script src="wasm_exec.js"></script>
  <script>
    const go = new Go();

    // Load and instantiate the WASM module
    WebAssembly.instantiateStreaming(fetch("main.wasm"), go.importObject)
      .then((result) => {
        go.run(result.instance);
        console.log("Go WASM module initialized");
      })
      .catch(err => console.error("Failed to load WASM:", err));

    function calculate() {
      const a = parseFloat(document.getElementById('a').value);
      const b = parseFloat(document.getElementById('b').value);
      // Call Go function registered on global scope
      const dist = goDistance(0, 0, a, b);
      document.getElementById('result').textContent = `Distance: ${dist.toFixed(4)}`;
    }
  </script>
</body>
</html>
```

---

## Section 3: TinyGo — Smaller, Faster WASM

TinyGo produces dramatically smaller binaries by using LLVM instead of the standard Go toolchain and eliminating reflection, goroutines (partially), and large runtime components.

### TinyGo-Compatible Code

TinyGo has restrictions: no `encoding/json` by default, limited goroutines, no `net/http`. Plan your module API accordingly.

```go
// tiny_main.go — TinyGo compatible
//go:build wasm

package main

import "unsafe"

// TinyGo uses a simpler export mechanism with //export directive
// instead of js.FuncOf for direct WASM function exports

//export add
func add(a, b float64) float64 {
	return a + b
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

//export stringLength
func stringLength(ptr *byte, length int32) int32 {
	// Work with raw memory for string passing
	_ = unsafe.Slice(ptr, length)
	return length
}

// Required by TinyGo WASM target
func main() {}
```

### JavaScript Integration for TinyGo Exports

TinyGo with `//export` directives creates plain WASM exports (no Go runtime wrapper):

```javascript
// tinygo_loader.js
async function loadTinyGoWasm(path) {
  const response = await fetch(path);
  const buffer = await response.arrayBuffer();

  // TinyGo WASM with //export doesn't need wasm_exec.js
  const wasmModule = await WebAssembly.instantiate(buffer, {
    env: {
      // TinyGo may need these imports
      __stack_chk_fail: () => { throw new Error("stack overflow"); },
    },
    wasi_snapshot_preview1: {
      // Minimal WASI stubs if needed
      proc_exit: (code) => { throw new Error(`exit: ${code}`); },
      fd_write: () => 0,
    }
  });

  const exports = wasmModule.instance.exports;

  return {
    add: (a, b) => exports.add(a, b),
    fibonacci: (n) => exports.fibonacci(n),
    memory: exports.memory,
  };
}

// Usage
loadTinyGoWasm("tiny_main.wasm").then(wasm => {
  console.log("3 + 4 =", wasm.add(3, 4));
  console.log("fib(10) =", wasm.fibonacci(10));
});
```

---

## Section 4: Memory Management — Sharing Data Between Go and JS

The critical challenge in WASM development is passing complex data (strings, arrays, structs) between Go and JavaScript, since WASM's linear memory is a shared byte array.

### String Passing Pattern (Standard Go)

```go
//go:build js && wasm

package main

import (
	"syscall/js"
	"unsafe"
)

// Global buffer for zero-copy string returns
var outputBuffer []byte

// processData takes a JS ArrayBuffer, processes it in Go, and returns a string
func processData(this js.Value, args []js.Value) interface{} {
	if len(args) != 1 {
		return js.ValueOf("error: expected ArrayBuffer argument")
	}

	// Copy JS ArrayBuffer into Go slice
	data := make([]byte, args[0].Get("byteLength").Int())
	js.CopyBytesToGo(data, args[0])

	// Process: count non-zero bytes as example
	count := 0
	for _, b := range data {
		if b != 0 {
			count++
		}
	}

	return js.ValueOf(count)
}

// allocBuffer allocates a Go byte slice and returns its pointer to JS
// Useful for zero-copy patterns where JS writes directly into Go memory
func allocBuffer(this js.Value, args []js.Value) interface{} {
	size := args[0].Int()
	outputBuffer = make([]byte, size)
	// Return pointer as integer for JS to use with DataView
	return js.ValueOf(int(uintptr(unsafe.Pointer(&outputBuffer[0]))))
}

// getBufferResult reads back the output buffer into a JS Uint8Array
func getBufferResult(this js.Value, args []js.Value) interface{} {
	dst := js.Global().Get("Uint8Array").New(len(outputBuffer))
	js.CopyBytesToJS(dst, outputBuffer)
	return dst
}

func main() {
	js.Global().Set("goProcessData", js.FuncOf(processData))
	js.Global().Set("goAllocBuffer", js.FuncOf(allocBuffer))
	js.Global().Set("goGetBufferResult", js.FuncOf(getBufferResult))
	<-make(chan struct{})
}
```

### Structured Data via JSON

```go
//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"
)

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type AnalysisResult struct {
	Centroid  Point   `json:"centroid"`
	MaxDist   float64 `json:"maxDist"`
	PointCount int    `json:"pointCount"`
}

func analyzePoints(this js.Value, args []js.Value) interface{} {
	if len(args) != 1 {
		return js.ValueOf(`{"error":"expected JSON string"}`)
	}

	var points []Point
	if err := json.Unmarshal([]byte(args[0].String()), &points); err != nil {
		result, _ := json.Marshal(map[string]string{"error": err.Error()})
		return js.ValueOf(string(result))
	}

	if len(points) == 0 {
		result, _ := json.Marshal(map[string]string{"error": "empty points array"})
		return js.ValueOf(string(result))
	}

	// Calculate centroid
	var sumX, sumY float64
	for _, p := range points {
		sumX += p.X
		sumY += p.Y
	}
	centroid := Point{
		X: sumX / float64(len(points)),
		Y: sumY / float64(len(points)),
	}

	// Find max distance from centroid
	var maxDist float64
	for _, p := range points {
		dx := p.X - centroid.X
		dy := p.Y - centroid.Y
		d := dx*dx + dy*dy
		if d > maxDist {
			maxDist = d
		}
	}

	result := AnalysisResult{
		Centroid:   centroid,
		MaxDist:    maxDist,
		PointCount: len(points),
	}

	out, _ := json.Marshal(result)
	return js.ValueOf(string(out))
}

func main() {
	js.Global().Set("goAnalyzePoints", js.FuncOf(analyzePoints))
	<-make(chan struct{})
}
```

---

## Section 5: Serving WASM from a Go HTTP Server

```go
// server.go — serves WASM with correct MIME type and COOP/COEP headers
package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	mux := http.NewServeMux()

	// Static files handler with WASM MIME type
	mux.Handle("/", wasmHandler(http.FileServer(http.Dir("./static"))))

	// Serve the wasm_exec.js from Go installation
	goRoot := os.Getenv("GOROOT")
	if goRoot == "" {
		log.Fatal("GOROOT not set — run: export GOROOT=$(go env GOROOT)")
	}
	wasmExecPath := filepath.Join(goRoot, "misc", "wasm", "wasm_exec.js")
	mux.HandleFunc("/wasm_exec.js", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, wasmExecPath)
	})

	log.Println("Serving on :8080")
	if err := http.ListenAndServe(":8080", mux); err != nil {
		log.Fatal(err)
	}
}

// wasmHandler adds required headers for SharedArrayBuffer and WASM threading
func wasmHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Required for SharedArrayBuffer (needed by Go WASM threading)
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")

		// Set correct MIME type for .wasm files
		if strings.HasSuffix(r.URL.Path, ".wasm") {
			w.Header().Set("Content-Type", "application/wasm")
		}

		next.ServeHTTP(w, r)
	})
}
```

---

## Section 6: WASI Target for Edge and Server-Side

WASI (WebAssembly System Interface) enables WASM outside the browser — on Wasmtime, WasmEdge, Fastly Compute, Cloudflare Workers, and Kubernetes via WASM runtimes.

```go
// wasi_main.go — WASI target, no browser APIs
//go:build wasip1

package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func main() {
	// WASI modules can read stdin, write stdout/stderr, access env vars
	fmt.Fprintln(os.Stderr, "Go WASI module starting")

	// Read environment variables
	for _, env := range os.Environ() {
		if strings.HasPrefix(env, "APP_") {
			fmt.Println("Config:", env)
		}
	}

	// Read stdin line by line (useful for CLI tools compiled to WASM)
	scanner := bufio.NewScanner(os.Stdin)
	lineCount := 0
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Printf("Line %d: %s\n", lineCount+1, strings.ToUpper(line))
		lineCount++
	}

	fmt.Fprintf(os.Stderr, "Processed %d lines\n", lineCount)
}
```

```bash
# Build for WASI
GOOS=wasip1 GOARCH=wasm go build -o processor.wasm wasi_main.go

# Run with wasmtime
wasmtime processor.wasm <<< "hello world"

# Run with wasmer
wasmer run processor.wasm < input.txt

# Run in Kubernetes via containerd WASM shim
# (requires containerd-shim-wasmtime)
```

---

## Section 7: Real-World Use Case — Image Processing in WASM

```go
//go:build js && wasm

package main

import (
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"bytes"
	"encoding/base64"
	"syscall/js"
)

// applyGrayscale converts image data to grayscale
// Takes a base64-encoded PNG/JPEG, returns base64-encoded grayscale PNG
func applyGrayscale(this js.Value, args []js.Value) interface{} {
	if len(args) != 1 {
		return js.ValueOf(map[string]interface{}{"error": "expected base64 string"})
	}

	// Decode base64
	b64Data := args[0].String()
	// Strip data URL prefix if present
	if idx := bytes.IndexByte([]byte(b64Data), ','); idx != -1 {
		b64Data = b64Data[idx+1:]
	}

	imgBytes, err := base64.StdEncoding.DecodeString(b64Data)
	if err != nil {
		return js.ValueOf(map[string]interface{}{"error": "base64 decode failed: " + err.Error()})
	}

	// Decode image
	img, _, err := image.Decode(bytes.NewReader(imgBytes))
	if err != nil {
		return js.ValueOf(map[string]interface{}{"error": "image decode failed: " + err.Error()})
	}

	// Apply grayscale transformation
	bounds := img.Bounds()
	gray := image.NewGray(bounds)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			originalColor := img.At(x, y)
			grayColor := color.GrayModel.Convert(originalColor)
			gray.Set(x, y, grayColor)
		}
	}

	// Encode to PNG
	var buf bytes.Buffer
	if err := png.Encode(&buf, gray); err != nil {
		return js.ValueOf(map[string]interface{}{"error": "png encode failed: " + err.Error()})
	}

	// Return as base64
	result := "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	return js.ValueOf(result)
}

// brightnessAdjust adjusts image brightness
func brightnessAdjust(this js.Value, args []js.Value) interface{} {
	if len(args) != 2 {
		return js.ValueOf(map[string]interface{}{"error": "expected base64 string and factor"})
	}

	b64Data := args[0].String()
	factor := args[1].Float() // 0.5 = 50% darker, 1.5 = 50% brighter

	if idx := bytes.IndexByte([]byte(b64Data), ','); idx != -1 {
		b64Data = b64Data[idx+1:]
	}

	imgBytes, err := base64.StdEncoding.DecodeString(b64Data)
	if err != nil {
		return js.ValueOf(map[string]interface{}{"error": err.Error()})
	}

	img, _, err := image.Decode(bytes.NewReader(imgBytes))
	if err != nil {
		return js.ValueOf(map[string]interface{}{"error": err.Error()})
	}

	bounds := img.Bounds()
	result := image.NewRGBA(bounds)

	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r, g, b, a := img.At(x, y).RGBA()
			clamp := func(v float64) uint8 {
				if v > 255 {
					return 255
				}
				if v < 0 {
					return 0
				}
				return uint8(v)
			}
			result.Set(x, y, color.RGBA{
				R: clamp(float64(r>>8) * factor),
				G: clamp(float64(g>>8) * factor),
				B: clamp(float64(b>>8) * factor),
				A: uint8(a >> 8),
			})
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, result); err != nil {
		return js.ValueOf(map[string]interface{}{"error": err.Error()})
	}

	return js.ValueOf("data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()))
}

func main() {
	js.Global().Set("goGrayscale", js.FuncOf(applyGrayscale))
	js.Global().Set("goBrightness", js.FuncOf(brightnessAdjust))
	<-make(chan struct{})
}
```

---

## Section 8: Build Pipeline and CI/CD Integration

### Makefile for WASM Builds

```makefile
# Makefile

GOROOT := $(shell go env GOROOT)
TINYGO_VERSION := 0.31.2

.PHONY: all build-standard build-tinygo serve clean size-compare

all: build-standard build-tinygo size-compare

build-standard:
	@echo "Building standard Go WASM..."
	GOOS=js GOARCH=wasm go build -o static/main.wasm ./cmd/wasm/
	cp $(GOROOT)/misc/wasm/wasm_exec.js static/
	@ls -lh static/main.wasm

build-tinygo:
	@echo "Building TinyGo WASM..."
	tinygo build -o static/tiny.wasm -target wasm -opt=2 ./cmd/wasm/
	@ls -lh static/tiny.wasm

build-wasi:
	@echo "Building WASI target..."
	GOOS=wasip1 GOARCH=wasm go build -o dist/processor.wasm ./cmd/wasi/
	@ls -lh dist/processor.wasm

size-compare:
	@echo "\n--- Size Comparison ---"
	@ls -lh static/*.wasm 2>/dev/null || true
	@ls -lh dist/*.wasm 2>/dev/null || true

# Optimize with Binaryen wasm-opt (install: brew install binaryen)
optimize:
	wasm-opt -O3 --enable-bulk-memory -o static/main.opt.wasm static/main.wasm
	@echo "Optimized:"
	@ls -lh static/main.opt.wasm

serve:
	go run ./cmd/server/

clean:
	rm -f static/main.wasm static/tiny.wasm static/wasm_exec.js
	rm -f dist/processor.wasm
```

### GitHub Actions Workflow

```yaml
# .github/workflows/wasm-build.yml
name: WASM Build and Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      - name: Set up TinyGo
        run: |
          wget -q https://github.com/tinygo-org/tinygo/releases/download/v0.31.2/tinygo_0.31.2_amd64.deb
          sudo dpkg -i tinygo_0.31.2_amd64.deb
          tinygo version

      - name: Install wasm-pack and Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Build standard WASM
        run: GOOS=js GOARCH=wasm go build -o main.wasm ./cmd/wasm/

      - name: Build TinyGo WASM
        run: tinygo build -o tiny.wasm -target wasm -opt=2 ./cmd/wasm/

      - name: Build WASI
        run: GOOS=wasip1 GOARCH=wasm go build -o processor.wasm ./cmd/wasi/

      - name: Test WASI module
        run: |
          curl -fsSL https://wasmtime.dev/install.sh | bash
          export PATH="$HOME/.wasmtime/bin:$PATH"
          echo "test input" | wasmtime processor.wasm

      - name: Report sizes
        run: ls -lh *.wasm

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: wasm-modules
          path: "*.wasm"
```

---

## Section 9: Performance Tuning

### Reducing Standard Go WASM Size

```bash
# Dead code elimination with ldflags
GOOS=js GOARCH=wasm go build \
  -ldflags="-s -w" \
  -trimpath \
  -o main.wasm ./cmd/wasm/

# Apply Binaryen optimizer (often 20-40% reduction)
wasm-opt -O4 --enable-bulk-memory --enable-mutable-globals \
  -o main.opt.wasm main.wasm

# Compare
ls -lh main.wasm main.opt.wasm
```

### Lazy Loading Pattern

```javascript
// Lazy-load the WASM module only when needed
let wasmReady = null;

async function ensureWasmLoaded() {
  if (wasmReady) return wasmReady;

  wasmReady = new Promise(async (resolve, reject) => {
    const go = new Go();
    try {
      const result = await WebAssembly.instantiateStreaming(
        fetch("/main.wasm"),
        go.importObject
      );
      go.run(result.instance);
      resolve(true);
    } catch (err) {
      reject(err);
    }
  });

  return wasmReady;
}

// Only loads WASM when first called
document.getElementById('analyzeBtn').addEventListener('click', async () => {
  await ensureWasmLoaded();
  const result = goAnalyzePoints(JSON.stringify(getPoints()));
  displayResult(JSON.parse(result));
});
```

### Worker Thread Offloading

```javascript
// wasm-worker.js — run WASM in a Web Worker to avoid blocking main thread
importScripts('wasm_exec.js');

let wasmInstance = null;

const go = new Go();
WebAssembly.instantiateStreaming(fetch('/main.wasm'), go.importObject)
  .then(result => {
    go.run(result.instance);
    wasmInstance = result.instance;
    postMessage({ type: 'ready' });
  });

self.onmessage = function(e) {
  if (e.data.type === 'process') {
    // Call Go function (registered on global scope accessible in worker)
    const result = goProcessData(e.data.payload);
    postMessage({ type: 'result', id: e.data.id, result });
  }
};
```

```javascript
// main.js — using the worker
const worker = new Worker('wasm-worker.js');

worker.onmessage = function(e) {
  if (e.data.type === 'ready') {
    console.log('WASM Worker ready');
  } else if (e.data.type === 'result') {
    handleResult(e.data.id, e.data.result);
  }
};

function processInBackground(data) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const handler = (e) => {
      if (e.data.id === id) {
        worker.removeEventListener('message', handler);
        resolve(e.data.result);
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'process', id, payload: data });
  });
}
```

---

## Section 10: Testing WASM Modules

### Unit Tests (Non-WASM Logic)

Extract WASM-bound functions into pure Go packages testable without the `js` build tag:

```go
// pkg/calculator/calculator.go (no build tags — testable anywhere)
package calculator

import "math"

func Distance(x1, y1, x2, y2 float64) float64 {
	return math.Sqrt(math.Pow(x2-x1, 2) + math.Pow(y2-y1, 2))
}

func Centroid(points [][2]float64) [2]float64 {
	if len(points) == 0 {
		return [2]float64{}
	}
	var sumX, sumY float64
	for _, p := range points {
		sumX += p[0]
		sumY += p[1]
	}
	n := float64(len(points))
	return [2]float64{sumX / n, sumY / n}
}
```

```go
// pkg/calculator/calculator_test.go
package calculator_test

import (
	"math"
	"testing"

	"github.com/your-org/your-app/pkg/calculator"
)

func TestDistance(t *testing.T) {
	tests := []struct {
		x1, y1, x2, y2 float64
		want            float64
	}{
		{0, 0, 3, 4, 5},
		{0, 0, 0, 0, 0},
		{1, 1, 4, 5, 5},
	}
	for _, tt := range tests {
		got := calculator.Distance(tt.x1, tt.y1, tt.x2, tt.y2)
		if math.Abs(got-tt.want) > 1e-9 {
			t.Errorf("Distance(%v,%v,%v,%v) = %v, want %v", tt.x1, tt.y1, tt.x2, tt.y2, got, tt.want)
		}
	}
}
```

```go
// cmd/wasm/main.go (thin JS bridge, delegates to pkg/calculator)
//go:build js && wasm

package main

import (
	"syscall/js"
	"github.com/your-org/your-app/pkg/calculator"
)

func main() {
	js.Global().Set("goDistance", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		return js.ValueOf(calculator.Distance(
			args[0].Float(), args[1].Float(),
			args[2].Float(), args[3].Float(),
		))
	}))
	<-make(chan struct{})
}
```

### Integration Test with Playwright

```javascript
// tests/wasm.spec.js (Playwright)
const { test, expect } = require('@playwright/test');

test('Go WASM distance calculation', async ({ page }) => {
  await page.goto('http://localhost:8080');

  // Wait for WASM module to load
  await page.waitForFunction(() => typeof window.goDistance === 'function', {
    timeout: 10000,
  });

  const result = await page.evaluate(() => window.goDistance(0, 0, 3, 4));
  expect(result).toBeCloseTo(5.0, 5);
});

test('Go WASM grayscale processing', async ({ page }) => {
  await page.goto('http://localhost:8080');
  await page.waitForFunction(() => typeof window.goGrayscale === 'function');

  // Test with a small data URL
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 10; canvas.height = 10;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 10, 10);
    const dataURL = canvas.toDataURL('image/png');
    return window.goGrayscale(dataURL);
  });

  expect(result).toMatch(/^data:image\/png;base64,/);
});
```

WebAssembly with Go offers a practical path to moving performance-critical browser logic to compiled code without rewriting in C++ or Rust. The key is structuring your modules to separate testable business logic from the `syscall/js` bridge layer, keeping WASM binary sizes in check with TinyGo or Binaryen optimization, and using Web Workers to prevent WASM execution from blocking the UI thread.
