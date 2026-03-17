---
title: "Go Embed and Static Asset Serving: High-Performance Frontend Delivery from Go Binaries"
date: 2030-10-26T00:00:00-05:00
draft: false
tags: ["Go", "embed", "Static Assets", "HTTP", "Performance", "SPA", "Caching"]
categories:
- Go
- Backend Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Production static serving in Go using embed.FS for single-binary deployment, HTTP filesystem caching headers, gzip and brotli compression middleware, SPA routing with catch-all handlers, ETags and conditional requests, and Content Security Policy headers."
more_link: "yes"
url: "/go-embed-static-asset-serving-high-performance-frontend-delivery/"
---

Embedding static assets directly into a Go binary eliminates the operational complexity of managing separate asset deployments, CDN invalidation timing, and file permission issues. A properly configured Go static file server rivals dedicated CDN edge nodes for single-origin traffic and requires zero external dependencies.

<!--more-->

This guide covers production-grade static asset serving: embed.FS configuration, compression pipelines, cache control strategies, SPA routing, and security hardening through response headers.

## Section 1: embed.FS Fundamentals

### The embed Directive

The `//go:embed` directive is a compile-time instruction that copies files from the source tree into the binary. It accepts glob patterns and can embed entire directory trees:

```go
package main

import "embed"

// Embed a single file
//go:embed static/index.html
var indexHTML []byte

// Embed an entire directory tree
//go:embed static
var staticFS embed.FS

// Embed multiple patterns
//go:embed static/css static/js static/fonts
var assetsFS embed.FS
```

Key constraints:
- The path in the directive is relative to the Go source file containing the directive
- Directories that start with `.` or `_` are excluded unless explicitly named
- Only the `embed` package can work with `embed.FS`; it is not a standard `fs.FS` directly but implements `fs.FS`, `fs.ReadDirFS`, and `fs.ReadFileFS`

### Directory Structure

```
myapp/
  main.go
  server/
    server.go
  web/
    dist/           # Built by npm run build
      index.html
      assets/
        main-abc123.js
        main-xyz789.css
        fonts/
          Inter-Regular.woff2
  embed.go          # Embed directive lives here
```

```go
// embed.go
package main

import "embed"

//go:embed web/dist
var webFS embed.FS
```

### Serving the Embedded Filesystem

```go
package main

import (
    "embed"
    "io/fs"
    "log"
    "net/http"
)

//go:embed web/dist
var webFS embed.FS

func main() {
    // Trim the web/dist prefix so paths are served from /
    distFS, err := fs.Sub(webFS, "web/dist")
    if err != nil {
        log.Fatalf("failed to create sub filesystem: %v", err)
    }

    mux := http.NewServeMux()
    mux.Handle("/", http.FileServer(http.FS(distFS)))

    log.Println("Serving on :8080")
    log.Fatal(http.ListenAndServe(":8080", mux))
}
```

## Section 2: Compression Middleware

Modern browsers support both gzip and brotli (br) content encoding. Brotli provides 15-20% better compression ratios than gzip for typical HTML/CSS/JS assets at the cost of higher CPU usage. The optimal strategy is to pre-compress assets at build time and serve the pre-compressed versions at runtime.

### Pre-Compression at Build Time

```bash
#!/usr/bin/env bash
# compress-assets.sh — run after npm build

DIST_DIR="web/dist"

find "$DIST_DIR" -type f \( -name "*.js" -o -name "*.css" -o -name "*.html" -o -name "*.svg" -o -name "*.json" \) | while read -r file; do
    # Brotli
    brotli --best --force --output="${file}.br" "$file"
    # Gzip
    gzip --best --keep --force "$file"
    echo "Compressed: $file"
done
```

Embed both the original and compressed versions:

```go
//go:embed web/dist
var webFS embed.FS
```

### Runtime Compression Selection Middleware

```go
package static

import (
    "io/fs"
    "net/http"
    "strings"
)

// compressedFileServer serves pre-compressed files when the client supports them.
// It falls back to the original file if no pre-compressed version exists.
func CompressedFileServer(fsys fs.FS) http.Handler {
    fileServer := http.FileServer(http.FS(fsys))

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        acceptEncoding := r.Header.Get("Accept-Encoding")
        path := strings.TrimPrefix(r.URL.Path, "/")
        if path == "" {
            path = "index.html"
        }

        // Try brotli first (better compression)
        if strings.Contains(acceptEncoding, "br") {
            if serveCompressed(w, r, fsys, path+".br", "br") {
                return
            }
        }

        // Try gzip
        if strings.Contains(acceptEncoding, "gzip") {
            if serveCompressed(w, r, fsys, path+".gz", "gzip") {
                return
            }
        }

        // Fall back to uncompressed
        fileServer.ServeHTTP(w, r)
    })
}

func serveCompressed(w http.ResponseWriter, r *http.Request, fsys fs.FS, compressedPath, encoding string) bool {
    f, err := fsys.Open(compressedPath)
    if err != nil {
        return false
    }
    defer f.Close()

    stat, err := f.Stat()
    if err != nil {
        return false
    }

    // Set appropriate headers
    w.Header().Set("Content-Encoding", encoding)
    w.Header().Set("Vary", "Accept-Encoding")

    // Set Content-Type based on original path (without .br/.gz suffix)
    originalPath := strings.TrimSuffix(strings.TrimSuffix(compressedPath, ".br"), ".gz")
    w.Header().Set("Content-Type", mimeTypeFor(originalPath))

    http.ServeContent(w, r, originalPath, stat.ModTime(), f.(interface {
        io.ReadSeeker
    }))
    return true
}

func mimeTypeFor(path string) string {
    switch {
    case strings.HasSuffix(path, ".js"):
        return "application/javascript; charset=utf-8"
    case strings.HasSuffix(path, ".css"):
        return "text/css; charset=utf-8"
    case strings.HasSuffix(path, ".html"):
        return "text/html; charset=utf-8"
    case strings.HasSuffix(path, ".json"):
        return "application/json"
    case strings.HasSuffix(path, ".svg"):
        return "image/svg+xml"
    case strings.HasSuffix(path, ".woff2"):
        return "font/woff2"
    case strings.HasSuffix(path, ".woff"):
        return "font/woff"
    default:
        return "application/octet-stream"
    }
}
```

### Runtime gzip Middleware (Fallback)

When pre-compression is not feasible, use runtime gzip. Use a sync.Pool to amortize gzip.Writer allocation costs:

```go
package static

import (
    "compress/gzip"
    "io"
    "net/http"
    "strings"
    "sync"
)

var gzipWriterPool = sync.Pool{
    New: func() interface{} {
        w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
        return w
    },
}

type gzipResponseWriter struct {
    http.ResponseWriter
    Writer     io.Writer
    statusCode int
}

func (grw *gzipResponseWriter) Write(b []byte) (int, error) {
    return grw.Writer.Write(b)
}

func (grw *gzipResponseWriter) WriteHeader(code int) {
    grw.statusCode = code
    grw.ResponseWriter.WriteHeader(code)
}

func GzipMiddleware(minSize int) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
                next.ServeHTTP(w, r)
                return
            }

            gz := gzipWriterPool.Get().(*gzip.Writer)
            gz.Reset(w)
            defer func() {
                gz.Close()
                gzipWriterPool.Put(gz)
            }()

            w.Header().Set("Content-Encoding", "gzip")
            w.Header().Set("Vary", "Accept-Encoding")
            w.Header().Del("Content-Length")

            next.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, Writer: gz}, r)
        })
    }
}
```

## Section 3: Cache Control and ETag Headers

### Cache Strategy by Asset Type

Different asset types require different cache policies:

| Asset Type | Cache-Control | Rationale |
|------------|--------------|-----------|
| Hashed JS/CSS (`main-abc123.js`) | `public, max-age=31536000, immutable` | Content hash ensures uniqueness; cache forever |
| Fonts | `public, max-age=31536000, immutable` | Fonts rarely change |
| `index.html` | `no-cache` | Must revalidate to pick up new asset hashes |
| API responses | `no-store` | Dynamic content |
| Images (versioned) | `public, max-age=31536000, immutable` | If filename includes content hash |
| Images (unversioned) | `public, max-age=86400` | Revalidate daily |

### Cache Control Middleware

```go
package static

import (
    "net/http"
    "path/filepath"
    "strings"
)

type CachePolicy struct {
    // Patterns that match hashed/versioned assets
    HashedPatterns []string
    // Patterns for HTML files (no-cache)
    HTMLPatterns []string
    // Default max-age for other assets
    DefaultMaxAge int
}

var DefaultCachePolicy = CachePolicy{
    HashedPatterns: []string{
        // Match files with content hash in name: main-abc123.js, chunk-xyz.css
        "*-[0-9a-f]*.js",
        "*-[0-9a-f]*.css",
        "*.woff2",
        "*.woff",
        "*.ttf",
    },
    HTMLPatterns:  []string{"*.html"},
    DefaultMaxAge: 3600,
}

func CacheControlMiddleware(policy CachePolicy) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            path := r.URL.Path
            base := filepath.Base(path)

            // Check if this is an HTML file
            for _, pattern := range policy.HTMLPatterns {
                if matched, _ := filepath.Match(pattern, base); matched {
                    w.Header().Set("Cache-Control", "no-cache, must-revalidate")
                    next.ServeHTTP(w, r)
                    return
                }
            }

            // Check if this is a hashed/immutable asset
            for _, pattern := range policy.HashedPatterns {
                if matched, _ := filepath.Match(pattern, base); matched {
                    w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
                    next.ServeHTTP(w, r)
                    return
                }
            }

            // Check for content hash in path (Vite/Webpack patterns)
            if isHashedAsset(path) {
                w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
                next.ServeHTTP(w, r)
                return
            }

            // Default cache policy
            w.Header().Set("Cache-Control", "public, max-age=3600")
            next.ServeHTTP(w, r)
        })
    }
}

// isHashedAsset detects Vite/webpack hash patterns like /assets/index-BsHEAKbB.js
func isHashedAsset(path string) bool {
    segments := strings.Split(path, "/")
    if len(segments) < 2 {
        return false
    }
    filename := segments[len(segments)-1]
    // Look for pattern: name-HASH.ext where HASH is 8+ hex chars
    parts := strings.Split(strings.TrimSuffix(filename, filepath.Ext(filename)), "-")
    if len(parts) < 2 {
        return false
    }
    lastPart := parts[len(parts)-1]
    if len(lastPart) < 8 {
        return false
    }
    for _, c := range lastPart {
        if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
            return false
        }
    }
    return true
}
```

### ETag Generation for Embedded Files

```go
package static

import (
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io/fs"
    "net/http"
    "strings"
    "sync"
)

type etagCache struct {
    mu    sync.RWMutex
    tags  map[string]string
    fsys  fs.FS
}

func newETagCache(fsys fs.FS) *etagCache {
    return &etagCache{
        tags: make(map[string]string),
        fsys: fsys,
    }
}

func (ec *etagCache) getETag(path string) (string, error) {
    ec.mu.RLock()
    if tag, ok := ec.tags[path]; ok {
        ec.mu.RUnlock()
        return tag, nil
    }
    ec.mu.RUnlock()

    // Compute ETag
    data, err := fs.ReadFile(ec.fsys, path)
    if err != nil {
        return "", err
    }
    hash := sha256.Sum256(data)
    tag := fmt.Sprintf(`"%s"`, hex.EncodeToString(hash[:8]))

    ec.mu.Lock()
    ec.tags[path] = tag
    ec.mu.Unlock()

    return tag, nil
}

func ETagMiddleware(fsys fs.FS) func(http.Handler) http.Handler {
    cache := newETagCache(fsys)

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            path := strings.TrimPrefix(r.URL.Path, "/")
            if path == "" {
                path = "index.html"
            }

            etag, err := cache.getETag(path)
            if err != nil {
                // File not found or unreadable; let the file server handle it
                next.ServeHTTP(w, r)
                return
            }

            w.Header().Set("ETag", etag)

            // Check If-None-Match header
            if r.Header.Get("If-None-Match") == etag {
                w.WriteHeader(http.StatusNotModified)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 4: SPA Routing with Catch-All Handler

Single Page Applications use client-side routing. A request to `/app/users/123` should serve `index.html` from the server, letting the SPA's router take over. Only requests to files that actually exist should be served as files.

```go
package static

import (
    "io/fs"
    "net/http"
    "path/filepath"
    "strings"
)

// SPAHandler serves a Single Page Application.
// Requests to paths that correspond to real files serve those files.
// All other requests serve index.html for client-side routing.
type SPAHandler struct {
    fsys       fs.FS
    fileServer http.Handler
    indexPath  string
}

func NewSPAHandler(fsys fs.FS, indexPath string) *SPAHandler {
    return &SPAHandler{
        fsys:       fsys,
        fileServer: http.FileServer(http.FS(fsys)),
        indexPath:  indexPath,
    }
}

func (h *SPAHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    path := strings.TrimPrefix(r.URL.Path, "/")

    // Check if the file exists in the embedded filesystem
    if h.fileExists(path) {
        h.fileServer.ServeHTTP(w, r)
        return
    }

    // For API paths, return 404 instead of serving SPA
    if strings.HasPrefix(r.URL.Path, "/api/") {
        http.NotFound(w, r)
        return
    }

    // Serve index.html for all other paths (SPA routing)
    r2 := *r
    r2.URL = *r.URL
    r2.URL.Path = "/" + h.indexPath
    h.fileServer.ServeHTTP(w, &r2)
}

func (h *SPAHandler) fileExists(path string) bool {
    if path == "" {
        return false
    }
    // Don't treat directory paths as files
    if strings.HasSuffix(path, "/") {
        return false
    }
    f, err := h.fsys.Open(path)
    if err != nil {
        return false
    }
    defer f.Close()
    stat, err := f.Stat()
    if err != nil {
        return false
    }
    return !stat.IsDir()
}
```

### Full Server Integration

```go
package main

import (
    "context"
    "embed"
    "io/fs"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

//go:embed web/dist
var webFS embed.FS

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    distFS, err := fs.Sub(webFS, "web/dist")
    if err != nil {
        logger.Error("failed to create sub filesystem", "error", err)
        os.Exit(1)
    }

    // Build middleware stack
    spaHandler := NewSPAHandler(distFS, "index.html")
    etagHandler := ETagMiddleware(distFS)(spaHandler)
    cacheHandler := CacheControlMiddleware(DefaultCachePolicy)(etagHandler)
    securityHandler := SecurityHeadersMiddleware(SecurityConfig{
        CSPDirectives: defaultCSP,
        HSTSMaxAge:    31536000,
    })(cacheHandler)
    loggedHandler := RequestLogMiddleware(logger)(securityHandler)

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      loggedHandler,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Graceful shutdown
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        <-sigChan
        logger.Info("shutdown signal received")
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        if err := srv.Shutdown(ctx); err != nil {
            logger.Error("graceful shutdown failed", "error", err)
        }
    }()

    logger.Info("starting server", "addr", srv.Addr)
    if err := srv.ListenAndServe(); err != http.ErrServerClosed {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
    logger.Info("server stopped")
}
```

## Section 5: Security Headers

### Content Security Policy

CSP prevents cross-site scripting attacks by restricting which sources the browser can load scripts, styles, and other resources from:

```go
package static

import (
    "fmt"
    "net/http"
    "strings"
)

type SecurityConfig struct {
    CSPDirectives []CSPDirective
    HSTSMaxAge    int
    FrameOptions  string // DENY, SAMEORIGIN
}

type CSPDirective struct {
    Name   string
    Values []string
}

var defaultCSP = []CSPDirective{
    {Name: "default-src", Values: []string{"'self'"}},
    {Name: "script-src", Values: []string{
        "'self'",
        // Add nonce support in production if using inline scripts
        // "'nonce-${NONCE}'",
    }},
    {Name: "style-src", Values: []string{"'self'", "'unsafe-inline'"}}, // unsafe-inline needed for many CSS-in-JS frameworks
    {Name: "img-src", Values: []string{"'self'", "data:", "https:"}},
    {Name: "font-src", Values: []string{"'self'"}},
    {Name: "connect-src", Values: []string{"'self'", "https://api.example.com"}},
    {Name: "frame-ancestors", Values: []string{"'none'"}},
    {Name: "base-uri", Values: []string{"'self'"}},
    {Name: "form-action", Values: []string{"'self'"}},
    {Name: "object-src", Values: []string{"'none'"}},
    {Name: "upgrade-insecure-requests", Values: []string{}},
}

func buildCSP(directives []CSPDirective) string {
    parts := make([]string, 0, len(directives))
    for _, d := range directives {
        if len(d.Values) == 0 {
            parts = append(parts, d.Name)
        } else {
            parts = append(parts, fmt.Sprintf("%s %s", d.Name, strings.Join(d.Values, " ")))
        }
    }
    return strings.Join(parts, "; ")
}

func SecurityHeadersMiddleware(cfg SecurityConfig) func(http.Handler) http.Handler {
    csp := buildCSP(cfg.CSPDirectives)
    frameOptions := cfg.FrameOptions
    if frameOptions == "" {
        frameOptions = "DENY"
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Content Security Policy
            w.Header().Set("Content-Security-Policy", csp)

            // Prevent embedding in frames
            w.Header().Set("X-Frame-Options", frameOptions)

            // Prevent MIME type sniffing
            w.Header().Set("X-Content-Type-Options", "nosniff")

            // Referrer policy
            w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

            // Permissions policy (formerly Feature-Policy)
            w.Header().Set("Permissions-Policy",
                "camera=(), microphone=(), geolocation=(), payment=(), usb=()")

            // HSTS (only meaningful when served over HTTPS)
            if cfg.HSTSMaxAge > 0 {
                w.Header().Set("Strict-Transport-Security",
                    fmt.Sprintf("max-age=%d; includeSubDomains", cfg.HSTSMaxAge))
            }

            // Cross-Origin policies
            w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
            w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
            w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")

            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 6: Performance Testing and Benchmarking

### Benchmark Embedded vs Disk Serving

```go
package static_test

import (
    "embed"
    "io/fs"
    "net/http"
    "net/http/httptest"
    "testing"
)

//go:embed testdata
var testDataFS embed.FS

func BenchmarkEmbeddedFileServing(b *testing.B) {
    distFS, _ := fs.Sub(testDataFS, "testdata")
    handler := http.FileServer(http.FS(distFS))

    req := httptest.NewRequest(http.MethodGet, "/index.html", nil)

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        rr := httptest.NewRecorder()
        handler.ServeHTTP(rr, req)
    }
}

func BenchmarkSPAHandlerWithMiddleware(b *testing.B) {
    distFS, _ := fs.Sub(testDataFS, "testdata")
    spaHandler := NewSPAHandler(distFS, "index.html")
    etagHandler := ETagMiddleware(distFS)(spaHandler)
    cacheHandler := CacheControlMiddleware(DefaultCachePolicy)(etagHandler)

    req := httptest.NewRequest(http.MethodGet, "/some/spa/route", nil)
    req.Header.Set("Accept-Encoding", "gzip, deflate, br")

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        rr := httptest.NewRecorder()
        cacheHandler.ServeHTTP(rr, req)
    }
}

func BenchmarkETagConditionalRequest(b *testing.B) {
    distFS, _ := fs.Sub(testDataFS, "testdata")
    spaHandler := NewSPAHandler(distFS, "index.html")
    handler := ETagMiddleware(distFS)(spaHandler)

    // Pre-warm to get the ETag
    warmReq := httptest.NewRequest(http.MethodGet, "/index.html", nil)
    warmRR := httptest.NewRecorder()
    handler.ServeHTTP(warmRR, warmReq)
    etag := warmRR.Header().Get("ETag")

    // Benchmark conditional requests (should return 304)
    req := httptest.NewRequest(http.MethodGet, "/index.html", nil)
    req.Header.Set("If-None-Match", etag)

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        rr := httptest.NewRecorder()
        handler.ServeHTTP(rr, req)
        if rr.Code != http.StatusNotModified {
            b.Fatalf("expected 304, got %d", rr.Code)
        }
    }
}
```

### Load Testing with hey

```bash
# Install hey
go install github.com/rakyll/hey@latest

# Benchmark static file serving
hey -n 100000 -c 100 -q 0 http://localhost:8080/assets/main-abc123.js

# Benchmark SPA routing
hey -n 50000 -c 50 http://localhost:8080/dashboard/users/123

# Test conditional request performance (304 responses)
ETAG=$(curl -s -I http://localhost:8080/ | grep ETag | awk '{print $2}' | tr -d '\r')
hey -n 50000 -c 50 -h "If-None-Match: $ETAG" http://localhost:8080/
```

## Section 7: Multi-Environment Configuration

The embedded binary can serve different configurations based on runtime environment variables, even though the assets themselves are compiled in:

```go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "text/template"
)

// RuntimeConfig is injected into the SPA at request time
// This avoids needing separate builds per environment
type RuntimeConfig struct {
    APIBaseURL   string `json:"apiBaseURL"`
    Environment  string `json:"environment"`
    FeatureFlags map[string]bool `json:"featureFlags"`
}

func runtimeConfigHandler(w http.ResponseWriter, r *http.Request) {
    cfg := RuntimeConfig{
        APIBaseURL:  getenv("API_BASE_URL", "https://api.example.com"),
        Environment: getenv("ENVIRONMENT", "production"),
        FeatureFlags: map[string]bool{
            "newDashboard":     getenv("FEATURE_NEW_DASHBOARD", "false") == "true",
            "betaOnboarding":   getenv("FEATURE_BETA_ONBOARDING", "false") == "true",
        },
    }

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Cache-Control", "no-store")
    json.NewEncoder(w).Encode(cfg)
}

func getenv(key, defaultValue string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return defaultValue
}
```

The SPA fetches `/config.json` at startup:

```javascript
// In the SPA (React/Vue/etc.)
const config = await fetch('/api/runtime-config').then(r => r.json());
window.__CONFIG__ = config;
```

## Section 8: Kubernetes Deployment

A Go binary with embedded assets deploys as a single container with no volume mounts:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend-server
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: frontend-server
  template:
    metadata:
      labels:
        app: frontend-server
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: frontend-server
          image: registry.example.com/frontend-server:v2.1.0
          ports:
            - containerPort: 8080
              name: http
          env:
            - name: API_BASE_URL
              value: "https://api.example.com"
            - name: ENVIRONMENT
              value: "production"
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
```

### Dockerfile for Single-Binary Build

```dockerfile
# Build stage
FROM node:22-alpine AS node-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --frozen-lockfile
COPY . .
RUN npm run build
# Pre-compress assets
RUN find dist -type f \( -name "*.js" -o -name "*.css" -o -name "*.html" \) \
    -exec brotli --best --force --output={}.br {} \; \
    -exec gzip --best --keep --force {} \;

# Go build stage
FROM golang:1.23-alpine AS go-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=node-builder /app/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server ./cmd/server

# Final stage — scratch for minimal image
FROM scratch
COPY --from=go-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=go-builder /app/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
```

The resulting image is typically 15-40 MB depending on asset size, with no OS layer, shell, or package manager to attack.

A well-implemented Go static file server handles 50,000+ RPS on modest hardware by leveraging the kernel's sendfile syscall, pre-computed ETags from the embedded filesystem's immutable content, and conditional request short-circuits that avoid reading file content entirely for cached resources.
