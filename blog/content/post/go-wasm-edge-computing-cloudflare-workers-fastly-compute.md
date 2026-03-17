---
title: "Go WASM and Edge Computing: Cloudflare Workers, Fastly Compute, and Edge Functions in Go"
date: 2030-04-01T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "WebAssembly", "WASM", "Cloudflare Workers", "Fastly Compute", "Edge Computing"]
categories: ["Go", "Edge Computing", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying Go compiled to WebAssembly on Cloudflare Workers and Fastly Compute@Edge, covering edge-side request modification, KV store access, performance characteristics, and the trade-offs of running Go at the edge."
more_link: "yes"
url: "/go-wasm-edge-computing-cloudflare-workers-fastly-compute/"
---

Edge computing pushes application logic to CDN PoPs around the world, running code milliseconds from end users rather than hundreds of milliseconds away in a central data center. For teams that have invested heavily in Go for their backend services, the prospect of reusing Go code at the edge — without rewriting in JavaScript or Rust — is compelling.

The reality of running Go at the edge in 2030 is nuanced. TinyGo enables compiling significant subsets of Go to compact WebAssembly modules. The standard `go` compiler can produce WASM for environments that support it. Cloudflare Workers and Fastly Compute@Edge have taken different approaches to WASM support, with different performance characteristics, feature sets, and compatibility constraints. This guide navigates those differences and provides production-ready patterns for Go edge functions.

<!--more-->

## Edge Computing Architecture

Understanding what makes edge functions different from serverless functions in a single region helps set expectations:

```
User (Tokyo)
    │
    │ 2ms
    ▼
Cloudflare PoP (Tokyo)
┌─────────────────────────────────┐
│ Edge Function (WASM)            │
│  - Runs in V8 isolate (CF) or   │
│    Wasmtime sandbox (Fastly)    │
│  - No OS, no filesystem         │
│  - Limited standard library     │
│  - Max execution: 50ms (CF)     │
│              unlimited (Fastly) │
└────────────┬────────────────────┘
             │ (cache miss)
             │ 50-100ms
             ▼
        Origin Server
        (us-east-1)

Compared to: User → Origin Server directly = 150-250ms
```

Key constraints of edge environments:
- No OS-level calls (no `os.Stat`, no `net.Dial` to arbitrary hosts)
- Limited runtime: sub-millisecond cold starts are required
- No persistent goroutines between requests (in Cloudflare Workers)
- Memory limits: typically 128 MB per isolate
- CPU time limits: 50ms CPU per request on Cloudflare free tier, 30s on paid

## TinyGo for WASM

TinyGo is the primary tool for compiling Go to WebAssembly for edge environments. The standard `go` compiler produces much larger WASM modules and requires the WASI (WebAssembly System Interface) runtime which not all environments support.

```bash
# Install TinyGo
# Option 1: apt (Ubuntu)
curl -sL https://github.com/tinygo-org/tinygo/releases/download/v0.34.0/tinygo_0.34.0_amd64.deb \
  -o /tmp/tinygo.deb
sudo dpkg -i /tmp/tinygo.deb

# Option 2: Homebrew (macOS)
brew tap tinygo-org/tools
brew install tinygo

# Verify installation
tinygo version

# Supported targets
tinygo targets | grep wasm

# Compile for Cloudflare Workers (JavaScript + WASM target)
tinygo build -o main.wasm -target wasm ./

# Check compiled size
ls -lh main.wasm

# Standard go compiler (produces larger binary, requires WASI)
GOOS=wasip1 GOARCH=wasm go build -o main-std.wasm ./
ls -lh main-std.wasm
# TinyGo: ~300KB
# Standard go: ~3-10MB (too large for most edge environments)
```

### TinyGo Compatibility Considerations

TinyGo does not support the full Go standard library. Understanding what works helps design edge functions correctly.

```go
// Supported in TinyGo for WASM edge:
// ✓ fmt.Sprintf (limited)
// ✓ strings, bytes, unicode packages
// ✓ encoding/json (limited)
// ✓ net/url
// ✓ crypto/sha256, crypto/hmac
// ✓ sync.Mutex
// ✓ regexp (limited)

// NOT supported in TinyGo WASM:
// ✗ net.Dial, http.Client (use runtime-provided fetch)
// ✗ os.File, os.Stat
// ✗ goroutines with blocking I/O
// ✗ reflect (limited)
// ✗ database/* packages
// ✗ runtime.GOMAXPROCS (WASM is single-threaded)
```

## Cloudflare Workers with Go

Cloudflare Workers runs in V8 isolates with WASM support. Go code compiles via TinyGo to a WASM module, which is loaded into the V8 isolate alongside a thin JavaScript wrapper.

### Project Structure

```
cloudflare-go-worker/
├── go.mod
├── main.go              # Go logic
├── wasm_exec.js         # TinyGo WASM bootstrap (from TinyGo installation)
├── worker.js            # JavaScript entry point
├── wrangler.toml        # Cloudflare deployment configuration
└── Makefile
```

### Go Handler Implementation

```go
// main.go — Cloudflare Worker in Go
//go:build js && wasm

package main

import (
    "encoding/json"
    "fmt"
    "net/url"
    "strings"
    "syscall/js"
)

// handleRequest is called by the JavaScript wrapper for each incoming request
func handleRequest(this js.Value, args []js.Value) interface{} {
    // args[0] is the Request object from the Workers runtime
    req := args[0]

    // Extract request properties
    method := req.Get("method").String()
    urlStr := req.Get("url").String()

    parsedURL, err := url.Parse(urlStr)
    if err != nil {
        return createResponse(400, "Invalid URL", map[string]string{
            "Content-Type": "application/json",
        })
    }

    // Route based on path
    switch {
    case method == "GET" && strings.HasPrefix(parsedURL.Path, "/api/health"):
        return handleHealth()

    case method == "GET" && strings.HasPrefix(parsedURL.Path, "/api/transform"):
        return handleTransform(parsedURL)

    case method == "POST" && parsedURL.Path == "/api/validate":
        // For POST, we need to return a Promise for the async body read
        return handleValidateAsync(req)

    default:
        return createResponse(404, `{"error":"not found"}`, map[string]string{
            "Content-Type": "application/json",
        })
    }
}

func handleHealth() interface{} {
    body := `{"status":"ok","runtime":"go-wasm","version":"1.0.0"}`
    return createResponse(200, body, map[string]string{
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
    })
}

func handleTransform(u *url.URL) interface{} {
    // Example: transform query parameters
    params := u.Query()
    name := params.Get("name")
    if name == "" {
        return createResponse(400, `{"error":"name parameter required"}`, map[string]string{
            "Content-Type": "application/json",
        })
    }

    result := map[string]interface{}{
        "original":  name,
        "upper":     strings.ToUpper(name),
        "lower":     strings.ToLower(name),
        "length":    len(name),
        "processed": true,
    }

    body, err := json.Marshal(result)
    if err != nil {
        return createResponse(500, `{"error":"marshal failed"}`, nil)
    }

    return createResponse(200, string(body), map[string]string{
        "Content-Type": "application/json",
        // Add edge caching headers
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "Vary":          "Accept-Encoding",
    })
}

// handleValidateAsync returns a Promise for async body processing
func handleValidateAsync(req js.Value) interface{} {
    // Return a JS Promise
    promiseConstructor := js.Global().Get("Promise")
    return promiseConstructor.New(js.FuncOf(func(this js.Value, args []js.Value) interface{} {
        resolve := args[0]
        reject := args[1]

        // Read the request body asynchronously
        bodyPromise := req.Call("text")
        bodyPromise.Call("then",
            js.FuncOf(func(this js.Value, args []js.Value) interface{} {
                body := args[0].String()
                result := validateRequestBody(body)

                resultJSON, err := json.Marshal(result)
                if err != nil {
                    resolve.Invoke(createResponse(500, `{"error":"internal"}`, nil))
                    return nil
                }

                statusCode := 200
                if !result["valid"].(bool) {
                    statusCode = 400
                }

                resolve.Invoke(createResponse(statusCode, string(resultJSON), map[string]string{
                    "Content-Type": "application/json",
                }))
                return nil
            }),
            js.FuncOf(func(this js.Value, args []js.Value) interface{} {
                reject.Invoke(args[0])
                return nil
            }),
        )
        return nil
    }))
}

func validateRequestBody(body string) map[string]interface{} {
    if len(body) == 0 {
        return map[string]interface{}{
            "valid":   false,
            "error":   "empty body",
        }
    }
    if len(body) > 1<<20 { // 1 MB limit
        return map[string]interface{}{
            "valid":   false,
            "error":   "body too large",
        }
    }

    // Try to parse as JSON
    var parsed interface{}
    if err := json.Unmarshal([]byte(body), &parsed); err != nil {
        return map[string]interface{}{
            "valid":   false,
            "error":   fmt.Sprintf("invalid JSON: %v", err),
        }
    }

    return map[string]interface{}{
        "valid":  true,
        "size":   len(body),
    }
}

// createResponse creates a Cloudflare Workers Response object
func createResponse(status int, body string, headers map[string]string) js.Value {
    responseInit := js.Global().Get("Object").New()

    // Set status
    responseInit.Set("status", status)

    // Build headers
    headersObj := js.Global().Get("Headers").New()
    for k, v := range headers {
        headersObj.Call("set", k, v)
    }
    responseInit.Set("headers", headersObj)

    // Create and return Response
    responseConstructor := js.Global().Get("Response")
    return responseConstructor.New(body, responseInit)
}

func main() {
    // Register the Go handler as a global JavaScript function
    js.Global().Set("goHandleRequest", js.FuncOf(handleRequest))

    // Block main goroutine — required for WASM to stay alive
    select {}
}
```

### JavaScript Wrapper

```javascript
// worker.js — Cloudflare Worker entry point
import './wasm_exec.js';

// Load the compiled WASM module
const go = new Go();
let wasmReady;

async function initWasm() {
  // The wasm binary is bundled by wrangler
  const wasmModule = await WebAssembly.instantiateStreaming(
    fetch(new URL('./main.wasm', import.meta.url)),
    go.importObject
  );
  go.run(wasmModule.instance);
  wasmReady = true;
}

// Initialize WASM at module load time (runs once per isolate)
const wasmInitPromise = initWasm().catch(err => {
  console.error('Failed to initialize WASM:', err);
});

export default {
  async fetch(request, env, ctx) {
    // Wait for WASM initialization
    await wasmInitPromise;

    if (!wasmReady) {
      return new Response('Service unavailable', { status: 503 });
    }

    try {
      // Inject environment bindings into Go's global scope
      // KV namespaces, Durable Objects, etc.
      globalThis.__ENV__ = env;

      // Call the Go handler
      const response = await globalThis.goHandleRequest(request);
      return response;
    } catch (err) {
      console.error('Handler error:', err);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
```

### Wrangler Configuration

```toml
# wrangler.toml
name = "go-edge-worker"
main = "worker.js"
compatibility_date = "2030-03-01"
compatibility_flags = ["streams_enable_constructors"]

# KV Namespace bindings
[[kv_namespaces]]
binding = "CACHE"
id = "<your-kv-namespace-id>"
preview_id = "<your-preview-kv-namespace-id>"

# Environment variables
[vars]
ENVIRONMENT = "production"
LOG_LEVEL = "info"

# Build configuration
[build]
command = "make build"

[build.upload]
format = "modules"
main = "./worker.js"

[[build.upload.rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
```

### Makefile for Build Pipeline

```makefile
# Makefile
.PHONY: build deploy clean test

WASM_TARGET = main.wasm

build: $(WASM_TARGET)

$(WASM_TARGET): main.go
	@echo "Compiling Go to WASM with TinyGo..."
	tinygo build -o $(WASM_TARGET) -target wasm -no-debug .
	@echo "WASM size: $$(ls -lh $(WASM_TARGET) | awk '{print $$5}')"

	@echo "Copying wasm_exec.js from TinyGo..."
	@cp "$$(tinygo env TINYGOROOT)/targets/wasm_exec.js" .

test:
	go test ./... -tags !wasm

deploy: build
	wrangler deploy

preview: build
	wrangler dev

clean:
	rm -f $(WASM_TARGET) wasm_exec.js

# Size optimization
build-optimized: main.go
	tinygo build \
		-o $(WASM_TARGET) \
		-target wasm \
		-no-debug \
		-opt=2 \
		-gc=leaking \
		.
	# Further optimize with wasm-opt if available
	@command -v wasm-opt && wasm-opt -O3 $(WASM_TARGET) -o $(WASM_TARGET) || true
	@echo "Optimized WASM size: $$(ls -lh $(WASM_TARGET) | awk '{print $$5}')"
```

## Fastly Compute@Edge with Go

Fastly Compute@Edge runs WASM in Wasmtime rather than V8, which means it uses WASI and supports a more complete standard library. Fastly provides the `fastly-go` SDK.

```bash
# Install Fastly CLI
go install github.com/fastly/cli/cmd/fastly@latest

# Create a new Go Compute project
fastly compute init --language go

# Install the Fastly Go SDK
go get github.com/fastly/compute-sdk-go@latest
```

### Fastly Go Handler

```go
// main.go — Fastly Compute@Edge handler
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "strings"
    "time"

    "github.com/fastly/compute-sdk-go/fsthttp"
    "github.com/fastly/compute-sdk-go/kvstore"
)

func main() {
    // Fastly uses http.ListenAndServe pattern
    fsthttp.ServeFunc(handler)
}

func handler(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
    // Route incoming requests
    switch {
    case r.Method == http.MethodGet && r.URL.Path == "/health":
        handleHealthFastly(ctx, w, r)

    case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/geo"):
        handleGeoLookupFastly(ctx, w, r)

    case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/cache"):
        handleKVCacheFastly(ctx, w, r)

    default:
        // Pass through to origin
        passToOrigin(ctx, w, r)
    }
}

func handleHealthFastly(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
    response := map[string]interface{}{
        "status":  "ok",
        "runtime": "fastly-compute-go",
        "time":    time.Now().UTC().Format(time.RFC3339),
    }

    body, _ := json.Marshal(response)
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Cache-Control", "no-store")
    w.WriteHeader(http.StatusOK)
    w.Write(body)
}

// handleGeoLookupFastly uses Fastly's geolocation data
// (available via the request's geo data)
func handleGeoLookupFastly(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
    geo := r.Geo

    response := map[string]interface{}{
        "country_code":     geo.CountryCode,
        "country_name":     geo.CountryName,
        "region":          geo.Region,
        "city":            geo.City,
        "latitude":        geo.Latitude,
        "longitude":       geo.Longitude,
        "postal_code":     geo.PostalCode,
        "as_number":       geo.ASNumber,
        "as_name":         geo.ASName,
        "connection_speed": geo.ConnectionSpeed,
    }

    body, _ := json.Marshal(response)
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Cache-Control", "private, no-store")
    w.WriteHeader(http.StatusOK)
    w.Write(body)
}

// handleKVCacheFastly demonstrates KV store access
func handleKVCacheFastly(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
    key := r.URL.Query().Get("key")
    if key == "" {
        http.Error(w, `{"error":"key parameter required"}`, http.StatusBadRequest)
        return
    }

    // Open KV store
    store, err := kvstore.Open("my-edge-store")
    if err != nil {
        http.Error(w, fmt.Sprintf(`{"error":"kv open: %v"}`, err), http.StatusInternalServerError)
        return
    }

    // Look up key
    item, err := store.Lookup(key)
    if err != nil {
        // Key not found
        w.Header().Set("Content-Type", "application/json")
        w.Header().Set("X-Cache-Status", "MISS")
        w.WriteHeader(http.StatusNotFound)
        fmt.Fprintf(w, `{"key":%q,"found":false}`, key)
        return
    }

    value, err := io.ReadAll(item.Value)
    item.Close()
    if err != nil {
        http.Error(w, `{"error":"read value"}`, http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-Cache-Status", "HIT")
    w.WriteHeader(http.StatusOK)
    fmt.Fprintf(w, `{"key":%q,"found":true,"value":%s}`, key, value)
}

// passToOrigin forwards the request to the configured backend
func passToOrigin(ctx context.Context, w fsthttp.ResponseWriter, r *fsthttp.Request) {
    // Clone the request for backend
    backendReq, err := fsthttp.NewRequest(r.Method, r.URL.String(), r.Body)
    if err != nil {
        http.Error(w, "failed to create backend request", http.StatusInternalServerError)
        return
    }

    // Copy headers
    for key, values := range r.Header {
        for _, v := range values {
            backendReq.Header.Add(key, v)
        }
    }

    // Add edge identification header
    backendReq.Header.Set("X-Forwarded-By", "fastly-edge")

    // Send to origin — "origin" is the backend name configured in fastly.toml
    resp, err := backendReq.Send(ctx, "origin")
    if err != nil {
        http.Error(w, "origin request failed", http.StatusBadGateway)
        return
    }
    defer resp.Body.Close()

    // Copy response headers
    for key, values := range resp.Header {
        for _, v := range values {
            w.Header().Add(key, v)
        }
    }

    // Set cache TTL for cacheable responses
    if resp.StatusCode == http.StatusOK {
        w.Header().Set("Surrogate-Control", "max-age=300")
    }

    w.WriteHeader(resp.StatusCode)
    io.Copy(w, resp.Body)
}
```

### Fastly Configuration

```toml
# fastly.toml
manifest_version = 3
name = "go-edge-function"
description = "Go WASM edge function on Fastly Compute"
language = "go"
service_id = "<your-fastly-service-id>"

[scripts]
build = "go build -o bin/main ./... && fastly compute pack --wasm bin/main"

[[setup.backends]]
name = "origin"
address = "api.yourapp.com"
port = 443

[[setup.kv_stores]]
name = "my-edge-store"
```

## Performance Characteristics

### Latency Benchmarks

Understanding the performance profile of Go WASM at the edge helps set realistic expectations.

```bash
# Test cold start latency
# Cloudflare Workers: first request to a fresh isolate
time curl -w "\n%{time_total}" https://your-worker.workers.dev/health

# Compare warm (isolate reused) vs cold (new isolate)
for i in $(seq 1 10); do
    time curl -s https://your-worker.workers.dev/health > /dev/null
    sleep 0.1
done

# Typical results (Go WASM vs JavaScript):
# Cold start: Go WASM ~2-5ms, JavaScript ~0.2-0.5ms
# Warm execution: Go WASM ~0.5-2ms, JavaScript ~0.1-0.5ms
# WASM module size impact on cold start: ~1ms per 100KB
```

### Module Size Optimization

```makefile
# Size optimization chain for production deployments
build-production:
	# Step 1: TinyGo with all optimizations
	tinygo build \
		-o main.wasm \
		-target wasm \
		-no-debug \
		-opt=2 \
		-scheduler=none \
		-gc=leaking \
		.

	# Step 2: Strip symbols
	wasm-strip main.wasm 2>/dev/null || true

	# Step 3: Optimize with Binaryen
	wasm-opt -O3 --strip-debug --strip-producers main.wasm -o main.wasm

	# Step 4: Compress (handled by CDN edge, but check size)
	gzip -k main.wasm
	@echo "Raw WASM:        $$(ls -lh main.wasm | awk '{print $$5}')"
	@echo "Gzipped WASM:    $$(ls -lh main.wasm.gz | awk '{print $$5}')"
```

```go
// Memory optimization: use leaking GC for request-scoped memory
// When using -gc=leaking, objects are never freed
// This is acceptable for edge functions because:
// 1. Each request gets a fresh WASM instance (Fastly)
// 2. Memory is bounded by request processing time

// Pre-allocate response buffer to avoid GC pressure
var responseBuf [65536]byte

func handleWithPrealloc(w fsthttp.ResponseWriter, r *fsthttp.Request) {
    // Use fixed-size buffer for small responses
    n := buildResponse(responseBuf[:])
    w.Write(responseBuf[:n])
}
```

## Edge A/B Testing with WASM

```go
// ab_test.go — A/B testing logic running at the edge
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/binary"
    "net/http"
)

// AssignVariant deterministically assigns a request to a variant
// based on user ID for consistent assignment across requests
func AssignVariant(userID string, experimentID string, variants []string) string {
    if len(variants) == 0 {
        return ""
    }

    // HMAC-based assignment for deterministic, tamper-resistant bucketing
    key := []byte(experimentID)
    mac := hmac.New(sha256.New, key)
    mac.Write([]byte(userID))
    hash := mac.Sum(nil)

    // Use first 8 bytes as uint64 for bucket calculation
    bucket := binary.BigEndian.Uint64(hash[:8])
    idx := bucket % uint64(len(variants))

    return variants[idx]
}

// EdgeABTest modifies the request based on variant assignment
func EdgeABTest(r *fsthttp.Request, experimentID string) string {
    // Get user ID from cookie or generate from IP
    userID := r.Header.Get("Cookie")
    if userID == "" {
        userID = r.RemoteAddr
    }

    variant := AssignVariant(userID, experimentID, []string{"control", "treatment"})

    // Add variant header for origin to read
    r.Header.Set("X-AB-Variant", variant)
    r.Header.Set("X-AB-Experiment", experimentID)

    return variant
}
```

## Edge Authentication Verification

```go
// auth/jwt.go — JWT verification at the edge (no database call required)
package auth

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "strings"
    "time"
)

// VerifyHS256JWT verifies a HS256 JWT token at the edge
// This eliminates an auth round-trip to the origin for every request
func VerifyHS256JWT(tokenStr string, secret []byte) (map[string]interface{}, error) {
    parts := strings.Split(tokenStr, ".")
    if len(parts) != 3 {
        return nil, fmt.Errorf("invalid JWT format")
    }

    // Verify signature
    signingInput := parts[0] + "." + parts[1]
    mac := hmac.New(sha256.New, secret)
    mac.Write([]byte(signingInput))
    expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

    if expectedSig != parts[2] {
        return nil, fmt.Errorf("invalid signature")
    }

    // Decode claims
    claimsBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
    if err != nil {
        return nil, fmt.Errorf("decode claims: %w", err)
    }

    var claims map[string]interface{}
    if err := json.Unmarshal(claimsBytes, &claims); err != nil {
        return nil, fmt.Errorf("parse claims: %w", err)
    }

    // Verify expiration
    if exp, ok := claims["exp"].(float64); ok {
        if time.Now().Unix() > int64(exp) {
            return nil, fmt.Errorf("token expired")
        }
    }

    return claims, nil
}
```

## Testing Edge Functions Locally

```bash
# Test Go WASM locally with Cloudflare Wrangler dev
make build
wrangler dev --local

# Test with curl
curl -v http://localhost:8787/api/health

# Test with hey (load testing)
hey -n 1000 -c 10 http://localhost:8787/api/transform?name=hello

# Run Go unit tests (without WASM build tag)
go test ./... -tags !wasm

# Test with WASM simulator
# Install wasmer or wasmtime for local testing
wasmer main.wasm --invoke _start

# Fastly local testing
fastly compute serve
curl http://localhost:7676/api/geo
```

## Choosing Between TinyGo and Standard Go for WASM

```
┌────────────────────────────────────────────────────────────────┐
│           Go WASM for Edge: Decision Guide                      │
├────────────────┬───────────────────┬────────────────────────────┤
│                │    TinyGo          │   Standard go (WASI)       │
├────────────────┼───────────────────┼────────────────────────────┤
│ Binary size    │ ~200-500KB         │ ~3-15MB                    │
│ Cold start     │ ~1-3ms             │ ~5-20ms                    │
│ Stdlib support │ Limited            │ Near complete              │
│ goroutines     │ Limited (no I/O)   │ Full (with WASI)           │
│ encoding/json  │ Basic              │ Full including generics    │
│ Target         │ Cloudflare Workers │ Fastly Compute@Edge        │
│                │ (JS WASM target)   │ (WASI target)              │
│ Use when       │ Request routing,   │ Complex business logic,    │
│                │ auth, A/B tests,   │ full stdlib needed,        │
│                │ geo-based logic    │ Fastly platform            │
└────────────────┴───────────────────┴────────────────────────────┘
```

## Key Takeaways

Go at the edge is production-viable in 2030, but with clear constraints that shape the types of problems it solves well.

TinyGo is the right tool for Cloudflare Workers. It produces compact WASM modules (200-500KB) with sub-millisecond cold starts, and its limited standard library is sufficient for the request routing, authentication, A/B testing, and response transformation use cases that make the most sense at the edge. Accept the stdlib limitations and design around them rather than fighting them.

Fastly Compute@Edge with standard WASI Go offers a much closer experience to writing regular Go — essentially any Go code that does not require persistent connections or filesystem access works. The trade-off is larger binary sizes and slightly higher cold starts compared to TinyGo.

The primary value proposition for Go at the edge is code reuse: the same authentication library, the same request validation logic, the same geo-routing rules that run in your backend services can run at the edge without rewriting in JavaScript. Measure carefully whether the reuse benefit justifies the additional complexity over a simple JavaScript worker for any given use case.

Keep edge functions focused on I/O-minimal, compute-bound tasks. Request validation, JWT verification, geo-based routing, A/B assignment, and response transformation are all excellent edge use cases. Anything requiring a database query or significant external API calls should stay at the origin where those latencies are tolerable.
