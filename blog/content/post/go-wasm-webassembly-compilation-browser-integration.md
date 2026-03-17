---
title: "Go WASM: WebAssembly Compilation and Browser Integration"
date: 2029-06-02T00:00:00-05:00
draft: false
tags: ["Go", "WebAssembly", "WASM", "JavaScript", "TinyGo", "Browser", "Performance"]
categories: ["Go", "WebAssembly"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to compiling Go to WebAssembly with GOOS=js, using the syscall/js package for DOM interaction, wasm_exec.js integration, TinyGo for smaller binaries, calling Go from JavaScript, and performance considerations for production WASM deployments."
more_link: "yes"
url: "/go-wasm-webassembly-compilation-browser-integration/"
---

WebAssembly lets Go code run in the browser at near-native speed, enabling teams to share validation logic, cryptographic primitives, compression algorithms, and complex business rules between server and client without rewriting them in JavaScript. Go's standard toolchain has supported WASM as a compilation target since Go 1.11. This guide covers the full development cycle: compilation, JavaScript bridge, DOM interaction, memory management, TinyGo for smaller binaries, and the performance characteristics that determine when WASM is the right choice.

<!--more-->

# Go WASM: WebAssembly Compilation and Browser Integration

## Go WASM Architecture Overview

When you compile Go to WebAssembly with `GOOS=js GOARCH=wasm`, the compiler produces a `.wasm` binary that requires the `wasm_exec.js` JavaScript glue file provided by the Go distribution. This glue file implements the Go runtime's host bindings — it provides the JavaScript side of the bridge that allows Go code to call into browser APIs and vice versa.

The execution model:
1. Browser downloads the `.wasm` module
2. JavaScript instantiates the module with `WebAssembly.instantiateStreaming`
3. `wasm_exec.js` sets up the Go runtime environment
4. The Go `main()` function runs and blocks (using `<-make(chan struct{})` or similar)
5. JavaScript calls exported Go functions through the `syscall/js` bridge
6. Go callbacks can call JavaScript functions through the same bridge

## Basic Compilation

```bash
# Compile a Go package to WebAssembly
GOOS=js GOARCH=wasm go build -o main.wasm ./cmd/wasm/

# The wasm_exec.js glue file — copy it to your web assets
cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" ./web/static/

# Check the output size
ls -lh main.wasm
# Typical Go WASM output: 5-15 MB (includes full Go runtime + GC + scheduler)

# Build with size optimization
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o main.wasm ./cmd/wasm/
# -s: strip symbol table
# -w: strip DWARF debug info
# Result: typically 2-6 MB

# Further compression with wasm-opt (from binaryen)
wasm-opt -O3 -o main-opt.wasm main.wasm
gzip -9 main-opt.wasm  # .wasm.gz typically 1-3 MB
```

## The syscall/js Package

The `syscall/js` package provides the Go-side API for interacting with the browser's JavaScript environment.

### Basic DOM Manipulation

```go
// cmd/wasm/main.go
//go:build js && wasm

package main

import (
	"fmt"
	"syscall/js"
)

func main() {
	// Get the global JavaScript object (window in browsers)
	global := js.Global()

	// Access document.getElementById
	document := global.Get("document")
	element := document.Call("getElementById", "output")
	element.Set("textContent", "Hello from Go WASM!")

	// Create a new DOM element
	div := document.Call("createElement", "div")
	div.Set("className", "go-output")
	div.Set("innerHTML", "<strong>Created by Go</strong>")

	body := document.Get("body")
	body.Call("appendChild", div)

	// Log to the browser console
	console := global.Get("console")
	console.Call("log", "Go WASM initialized successfully")

	// Keep the Go runtime alive
	// Without this, main() returns and the WASM module unloads
	select {}
}
```

### Registering Go Functions as JavaScript Callbacks

```go
//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"syscall/js"
)

// RegisterFunctions exports Go functions to the JavaScript global scope.
func RegisterFunctions() {
	js.Global().Set("goValidateEmail", js.FuncOf(validateEmail))
	js.Global().Set("goCalculateDistance", js.FuncOf(calculateDistance))
	js.Global().Set("goCompressJSON", js.FuncOf(compressJSON))
}

// validateEmail validates an email address from JavaScript.
// JavaScript call: goValidateEmail("user@example.com")
func validateEmail(this js.Value, args []js.Value) interface{} {
	if len(args) != 1 {
		return map[string]interface{}{
			"valid":   false,
			"error":   "expected exactly one argument",
		}
	}
	email := args[0].String()

	// Use your Go email validation logic
	valid, reason := validateEmailInternal(email)
	return map[string]interface{}{
		"valid":  valid,
		"reason": reason,
	}
}

func validateEmailInternal(email string) (bool, string) {
	if len(email) == 0 {
		return false, "email is empty"
	}
	// Production implementation would use net/mail or a regex
	for i, c := range email {
		if c == '@' {
			if i == 0 {
				return false, "email cannot start with @"
			}
			if i == len(email)-1 {
				return false, "email cannot end with @"
			}
			return true, ""
		}
	}
	return false, "email missing @ symbol"
}

// calculateDistance computes the Haversine distance between two GPS coordinates.
// JavaScript call: goCalculateDistance(lat1, lon1, lat2, lon2)
func calculateDistance(this js.Value, args []js.Value) interface{} {
	if len(args) != 4 {
		return js.Undefined()
	}
	lat1 := args[0].Float()
	lon1 := args[1].Float()
	lat2 := args[2].Float()
	lon2 := args[3].Float()

	return haversineDistance(lat1, lon1, lat2, lon2)
}

func haversineDistance(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371.0 // Earth radius in km
	dLat := (lat2 - lat1) * math.Pi / 180.0
	dLon := (lon2 - lon1) * math.Pi / 180.0
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180.0)*math.Cos(lat2*math.Pi/180.0)*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}

// compressJSON minifies a JSON string (shared logic between Go server and browser).
func compressJSON(this js.Value, args []js.Value) interface{} {
	if len(args) != 1 {
		return js.Undefined()
	}
	input := args[0].String()

	var v interface{}
	if err := json.Unmarshal([]byte(input), &v); err != nil {
		return map[string]interface{}{
			"error": fmt.Sprintf("invalid JSON: %v", err),
		}
	}

	compact, err := json.Marshal(v)
	if err != nil {
		return map[string]interface{}{
			"error": fmt.Sprintf("marshal error: %v", err),
		}
	}

	return map[string]interface{}{
		"result": string(compact),
		"saved":  len(input) - len(compact),
	}
}

func main() {
	RegisterFunctions()
	fmt.Println("Go WASM module loaded")

	// Signal readiness to JavaScript
	js.Global().Call("dispatchEvent",
		js.Global().Get("CustomEvent").New("goWasmReady"))

	select {}
}
```

### Passing Complex Data Between Go and JavaScript

```go
//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"
)

// JsValueToGoValue converts a js.Value to a native Go type.
func JsValueToGoValue(v js.Value) interface{} {
	switch v.Type() {
	case js.TypeNull, js.TypeUndefined:
		return nil
	case js.TypeBoolean:
		return v.Bool()
	case js.TypeNumber:
		return v.Float()
	case js.TypeString:
		return v.String()
	case js.TypeObject:
		if v.Get("length").Truthy() {
			// Array
			length := v.Length()
			result := make([]interface{}, length)
			for i := 0; i < length; i++ {
				result[i] = JsValueToGoValue(v.Index(i))
			}
			return result
		}
		// Object — convert via JSON round-trip for simplicity
		jsonStr := js.Global().Get("JSON").Call("stringify", v).String()
		var result map[string]interface{}
		_ = json.Unmarshal([]byte(jsonStr), &result)
		return result
	}
	return nil
}

// GoValueToJsValue converts a Go map/slice to a js.Value.
func GoValueToJsValue(v interface{}) js.Value {
	data, err := json.Marshal(v)
	if err != nil {
		return js.Null()
	}
	return js.Global().Get("JSON").Call("parse", string(data))
}

// processOrder demonstrates complex data exchange
func processOrder(this js.Value, args []js.Value) interface{} {
	if len(args) != 1 {
		return GoValueToJsValue(map[string]interface{}{
			"error": "expected one argument",
		})
	}

	// Convert JavaScript object to Go map
	orderData := JsValueToGoValue(args[0])
	orderMap, ok := orderData.(map[string]interface{})
	if !ok {
		return GoValueToJsValue(map[string]interface{}{
			"error": "argument must be an object",
		})
	}

	// Process with Go business logic
	result := processOrderLogic(orderMap)
	return GoValueToJsValue(result)
}

func processOrderLogic(order map[string]interface{}) map[string]interface{} {
	// Your Go business logic here
	total := 0.0
	if items, ok := order["items"].([]interface{}); ok {
		for _, item := range items {
			if itemMap, ok := item.(map[string]interface{}); ok {
				if price, ok := itemMap["price"].(float64); ok {
					if qty, ok := itemMap["quantity"].(float64); ok {
						total += price * qty
					}
				}
			}
		}
	}
	return map[string]interface{}{
		"total":    total,
		"currency": "USD",
		"valid":    total > 0,
	}
}
```

## wasm_exec.js Integration

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Go WASM Demo</title>
</head>
<body>
  <div id="output">Loading Go WASM...</div>
  <input id="email-input" type="text" placeholder="Enter email">
  <button id="validate-btn">Validate</button>
  <div id="result"></div>

  <!-- Required: Go WASM runtime glue -->
  <script src="/static/wasm_exec.js"></script>

  <script>
    // Feature detection
    if (!WebAssembly.instantiateStreaming) {
      // Polyfill for older browsers
      WebAssembly.instantiateStreaming = async (resp, importObject) => {
        const source = await (await resp).arrayBuffer();
        return await WebAssembly.instantiate(source, importObject);
      };
    }

    async function loadGoWasm() {
      const go = new Go();

      try {
        // Stream the WASM module for efficiency
        const result = await WebAssembly.instantiateStreaming(
          fetch('/static/main.wasm'),
          go.importObject
        );

        // Run the Go program (non-blocking — Go's main() will keep running)
        go.run(result.instance);

        // Wait for Go to signal readiness
        await new Promise((resolve) => {
          window.addEventListener('goWasmReady', resolve, { once: true });
          // Fallback timeout
          setTimeout(resolve, 5000);
        });

        console.log('Go WASM loaded successfully');
        document.getElementById('output').textContent = 'Go WASM loaded!';
        enableUI();

      } catch (err) {
        console.error('Failed to load Go WASM:', err);
        document.getElementById('output').textContent = `Error: ${err.message}`;
      }
    }

    function enableUI() {
      document.getElementById('validate-btn').addEventListener('click', () => {
        const email = document.getElementById('email-input').value;

        // Call the Go function — returns a JavaScript object
        const result = goValidateEmail(email);

        document.getElementById('result').textContent =
          result.valid
            ? `Valid email: ${email}`
            : `Invalid: ${result.reason}`;
      });
    }

    // Load on page load
    loadGoWasm();
  </script>
</body>
</html>
```

### WASM Loading with Service Worker Caching

```javascript
// service-worker.js — cache the WASM binary for subsequent loads
const CACHE_NAME = 'go-wasm-v1';
const WASM_URL = '/static/main.wasm';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([WASM_URL, '/static/wasm_exec.js']);
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.url.endsWith('.wasm')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            cache.put(event.request, response.clone());
            return response;
          });
        });
      })
    );
  }
});
```

## Async Go Functions with Promises

Go WASM functions are synchronous by default. For long-running operations, use JavaScript Promises:

```go
//go:build js && wasm

package main

import (
	"syscall/js"
	"time"
)

// asyncWrapper wraps a Go function to return a JavaScript Promise.
func asyncWrapper(fn func(args []js.Value) (interface{}, error)) js.Func {
	return js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		// Create a new Promise
		promiseConstructor := js.Global().Get("Promise")
		return promiseConstructor.New(js.FuncOf(func(this js.Value, promiseArgs []js.Value) interface{} {
			resolve := promiseArgs[0]
			reject := promiseArgs[1]

			go func() {
				result, err := fn(args)
				if err != nil {
					errorConstructor := js.Global().Get("Error")
					reject.Invoke(errorConstructor.New(err.Error()))
					return
				}
				resolve.Invoke(GoValueToJsValue(result))
			}()

			return nil
		}))
	})
}

// Example: async heavy computation that returns a Promise
var heavyCompute = asyncWrapper(func(args []js.Value) (interface{}, error) {
	if len(args) == 0 {
		return nil, fmt.Errorf("no input provided")
	}
	n := int(args[0].Float())

	// Simulate heavy work (in production: actual computation)
	time.Sleep(100 * time.Millisecond)
	result := computePrimes(n)

	return map[string]interface{}{
		"count": len(result),
		"primes": result,
	}, nil
})

func computePrimes(limit int) []int {
	sieve := make([]bool, limit+1)
	for i := range sieve {
		sieve[i] = true
	}
	var primes []int
	for i := 2; i <= limit; i++ {
		if sieve[i] {
			primes = append(primes, i)
			for j := i * i; j <= limit; j += i {
				sieve[j] = false
			}
		}
	}
	return primes
}

func main() {
	js.Global().Set("goHeavyCompute", heavyCompute)
	select {}
}
```

JavaScript usage:
```javascript
// Returns a Promise — use async/await
const result = await goHeavyCompute(10000);
console.log(`Found ${result.count} primes`);
```

## TinyGo for Smaller Binaries

TinyGo compiles Go to WebAssembly without the full Go runtime, producing binaries 10-50x smaller. The tradeoff is reduced standard library support and some Go features are unavailable.

```bash
# Install TinyGo
wget https://github.com/tinygo-org/tinygo/releases/download/v0.32.0/tinygo_0.32.0_amd64.deb
dpkg -i tinygo_0.32.0_amd64.deb

# Compile with TinyGo
tinygo build -o main-tiny.wasm -target wasm ./cmd/wasm/

# Compare sizes
ls -lh main.wasm main-tiny.wasm
# main.wasm:      8.2 MB (standard toolchain)
# main-tiny.wasm: 280 KB (TinyGo)

# After optimization and compression
wasm-opt -Oz main-tiny.wasm -o main-tiny-opt.wasm
gzip -9 main-tiny-opt.wasm
ls -lh main-tiny-opt.wasm.gz
# main-tiny-opt.wasm.gz: ~80 KB
```

### TinyGo Code Differences

TinyGo's `syscall/js` API is the same, but several standard library packages are unavailable or partial:

```go
//go:build js && wasm
// +build js wasm

package main

// TinyGo compatible - avoid these packages:
// - reflect (limited)
// - encoding/json (use a custom or simplified version)
// - net (not available in wasm target)
// - os (limited)

import (
	"math"
	"strconv"
	"strings"
	"syscall/js"
)

// TinyGo works well for pure computation with basic I/O
func formatNumber(this js.Value, args []js.Value) interface{} {
	if len(args) != 1 {
		return ""
	}
	n := args[0].Float()

	// Format with commas — stdlib compatible with TinyGo
	formatted := formatWithCommas(n)
	return formatted
}

func formatWithCommas(n float64) string {
	parts := strings.Split(strconv.FormatFloat(math.Abs(n), 'f', 2, 64), ".")
	integer := parts[0]
	var result []string
	for i, c := range integer {
		if i > 0 && (len(integer)-i)%3 == 0 {
			result = append(result, ",")
		}
		result = append(result, string(c))
	}
	formatted := strings.Join(result, "")
	if len(parts) > 1 {
		formatted += "." + parts[1]
	}
	if n < 0 {
		formatted = "-" + formatted
	}
	return formatted
}

// TinyGo WASM uses a different startup — no wasm_exec.js required for tinygo target
// Use the generated wasm_exec.js from TinyGo instead:
// cp $(tinygo env TINYGOROOT)/targets/wasm_exec.js ./web/static/wasm_exec_tinygo.js

func main() {
	js.Global().Set("goFormatNumber", js.FuncOf(formatNumber))

	// TinyGo uses a channel to keep the runtime alive
	c := make(chan struct{})
	<-c
}
```

### TinyGo vs Standard Toolchain Decision Matrix

| Criteria | Standard Go | TinyGo |
|---|---|---|
| Binary size | 5-15 MB (2-5 MB gzipped) | 50-500 KB (20-100 KB gzipped) |
| Load time (3G) | 2-5 seconds | 0.1-0.5 seconds |
| Standard library | Full | Partial |
| Goroutines | Full support | Limited |
| GC | Full (pauses possible) | Conservative (no pauses) |
| Reflection | Full | Limited |
| encoding/json | Full | Not available |
| net/http | Not in WASM | Not in WASM |
| Build time | Slower | Faster |

Use TinyGo for: utility functions, validation logic, number formatting, compression, simple data processing.

Use standard Go for: complex business logic requiring full stdlib, goroutine-heavy code, anything using `encoding/json`.

## Memory Management Considerations

Go's garbage collector runs in the WASM module. The GC pauses are typically short, but be aware of:

```go
//go:build js && wasm

package main

import (
	"runtime"
	"syscall/js"
)

// forceGC exposes manual GC triggering to JavaScript for performance testing.
func forceGC(this js.Value, args []js.Value) interface{} {
	before := getMemStats()
	runtime.GC()
	after := getMemStats()
	return map[string]interface{}{
		"before": before,
		"after":  after,
	}
}

func getMemStats() map[string]interface{} {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return map[string]interface{}{
		"alloc_mb":   float64(m.Alloc) / 1024 / 1024,
		"sys_mb":     float64(m.Sys) / 1024 / 1024,
		"gc_runs":    m.NumGC,
		"heap_mb":    float64(m.HeapInuse) / 1024 / 1024,
	}
}

// releaseMemory cleans up large allocations after processing
func releaseMemory(this js.Value, args []js.Value) interface{} {
	// Let GC collect unreachable objects
	runtime.GC()
	// Return memory to OS (experimental)
	runtime.GOMAXPROCS(runtime.GOMAXPROCS(0))
	return nil
}

func main() {
	js.Global().Set("goMemStats", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		return GoValueToJsValue(getMemStats())
	}))
	js.Global().Set("goForceGC", js.FuncOf(forceGC))
	select {}
}
```

## HTTP Server for WASM Development

```go
// cmd/server/main.go — development server with correct MIME types and headers
package main

import (
	"log"
	"net/http"
	"os"
)

func main() {
	mux := http.NewServeMux()

	// Serve static files with correct MIME type for .wasm
	fs := http.FileServer(http.Dir("./web"))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WASM requires application/wasm MIME type
		if len(r.URL.Path) > 5 && r.URL.Path[len(r.URL.Path)-5:] == ".wasm" {
			w.Header().Set("Content-Type", "application/wasm")
		}
		// Enable compression negotiation
		w.Header().Set("Vary", "Accept-Encoding")
		// Cache WASM binary aggressively (content-addressed if using hash in filename)
		if r.URL.Path != "/" {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		fs.ServeHTTP(w, r)
	}))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Serving on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
```

## Build Automation with Makefile

```makefile
# Makefile
GOROOT := $(shell go env GOROOT)
WASM_EXEC_JS := $(GOROOT)/misc/wasm/wasm_exec.js

.PHONY: wasm wasm-tiny serve clean

# Standard Go WASM build
wasm:
	GOOS=js GOARCH=wasm go build \
		-ldflags="-s -w" \
		-o web/static/main.wasm \
		./cmd/wasm/
	cp "$(WASM_EXEC_JS)" web/static/wasm_exec.js
	@echo "Size: $$(wc -c < web/static/main.wasm) bytes"

# TinyGo build (smaller)
wasm-tiny:
	tinygo build \
		-target wasm \
		-no-debug \
		-o web/static/main-tiny.wasm \
		./cmd/wasm/
	cp "$$(tinygo env TINYGOROOT)/targets/wasm_exec.js" \
		web/static/wasm_exec_tinygo.js
	@echo "TinyGo size: $$(wc -c < web/static/main-tiny.wasm) bytes"

# Optimize and compress
wasm-opt: wasm
	wasm-opt -Oz web/static/main.wasm -o web/static/main.wasm
	gzip -kf web/static/main.wasm
	brotli -kf web/static/main.wasm
	@echo "Gzip size: $$(wc -c < web/static/main.wasm.gz) bytes"
	@echo "Brotli size: $$(wc -c < web/static/main.wasm.br) bytes"

# Development server
serve: wasm
	go run ./cmd/server/

# Run WASM tests in Node.js (requires node and GOROOT/misc/wasm/go_js_wasm_exec)
test-wasm:
	GOOS=js GOARCH=wasm go test -v ./pkg/wasm/...

clean:
	rm -f web/static/main.wasm web/static/main.wasm.gz web/static/main.wasm.br
	rm -f web/static/wasm_exec.js web/static/main-tiny.wasm
```

## Performance Benchmarking

```javascript
// benchmark.js — measure Go WASM vs native JavaScript performance
async function benchmarkGoWasm() {
  const iterations = 100000;

  // Benchmark 1: Email validation
  console.time('Go WASM email validation');
  for (let i = 0; i < iterations; i++) {
    goValidateEmail(`user${i}@example.com`);
  }
  console.timeEnd('Go WASM email validation');

  // Compare with JS implementation
  function jsValidateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  console.time('JS email validation');
  for (let i = 0; i < iterations; i++) {
    jsValidateEmail(`user${i}@example.com`);
  }
  console.timeEnd('JS email validation');

  // Benchmark 2: Distance calculation
  console.time('Go WASM distance calc');
  for (let i = 0; i < iterations; i++) {
    goCalculateDistance(40.7128, -74.0060, 34.0522, -118.2437);
  }
  console.timeEnd('Go WASM distance calc');
}

// Expected results on modern hardware:
// Go WASM email validation: ~500ms for 100K iterations (5µs/call)
// JS email validation: ~50ms for 100K iterations (0.5µs/call — JS is faster for simple ops)
// Go WASM distance calc: ~300ms for 100K iterations (3µs/call)
//
// Key insight: WASM call overhead from JS is ~1-2µs per invocation.
// Go WASM is slower than JS for simple operations but competitive for complex ones.
// The advantage is code sharing between server and client, not raw speed.
```

## Production Deployment Checklist

Before deploying Go WASM to production:

- Serve `.wasm` files with `Content-Type: application/wasm`
- Configure `Content-Encoding: gzip` or Brotli for WASM files
- Set `Cache-Control: public, max-age=31536000` with content-hashed filenames
- Add `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` if using `SharedArrayBuffer`
- Test in Chrome, Firefox, Safari, and Edge
- Measure initial load time on simulated 3G connection
- Consider lazy loading: only download WASM when the feature is first needed
- Implement loading state UX — WASM instantiation takes 100ms-2s
- Monitor `wasm` startup failures via error tracking (Sentry/Datadog)
- Build and test with both standard Go and TinyGo if size is a constraint

## Summary

Go WASM enables sharing business logic between server and browser without JavaScript rewrites. The `syscall/js` package provides a complete bridge for DOM manipulation and function export. The primary limitation is binary size: the standard Go toolchain produces 5-15 MB WASM binaries, while TinyGo reduces this to 50-500 KB at the cost of standard library coverage. For production deployments, combine `wasm-opt` optimization with Brotli compression to achieve 80-200 KB payloads from TinyGo or 1-2 MB from the standard toolchain. The WASM call overhead from JavaScript is approximately 1-2 microseconds per call, making Go WASM efficient for complex operations but not for simple per-element DOM operations where the overhead dominates.
