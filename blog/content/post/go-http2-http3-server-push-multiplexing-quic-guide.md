---
title: "Go HTTP/2 and HTTP/3: Server Push, Multiplexing, and QUIC"
date: 2029-05-10T00:00:00-05:00
draft: false
tags: ["Go", "HTTP/2", "HTTP/3", "QUIC", "Performance", "Networking", "Golang"]
categories: ["Go", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go's net/http HTTP/2 server with push promises, connection reuse, cleartext h2c, and experimental HTTP/3 using quic-go. Includes benchmarking methodology and production configuration for each protocol generation."
more_link: "yes"
url: "/go-http2-http3-server-push-multiplexing-quic-guide/"
---

HTTP/2 shipped with Go 1.6 and HTTP/3 is gaining production readiness through the `quic-go` ecosystem. Most Go developers use these protocols without understanding what they actually do or how to tune them. This post goes deep: stream multiplexing internals, server push implementation, h2c for service-mesh scenarios, QUIC's 0-RTT connection establishment, and how to measure the actual impact of each feature against HTTP/1.1 baselines.

<!--more-->

# Go HTTP/2 and HTTP/3: Server Push, Multiplexing, and QUIC

## Section 1: HTTP/2 Fundamentals in Go's net/http

Go's standard library enables HTTP/2 automatically when TLS is configured. No additional code is required for basic HTTP/2 support.

### How Go Enables HTTP/2

```go
package main

import (
    "crypto/tls"
    "fmt"
    "log"
    "net/http"
    "golang.org/x/net/http2"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Protocol: %s\n", r.Proto)
    })

    // HTTP/2 is automatic with TLS
    srv := &http.Server{
        Addr:    ":8443",
        Handler: mux,
        TLSConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
            // HTTP/2 requires ALPN negotiation
            NextProtos: []string{"h2", "http/1.1"},
        },
    }

    // Optionally configure HTTP/2 parameters
    h2Server := &http2.Server{
        MaxHandlers:                  0,      // Default: no limit
        MaxConcurrentStreams:         250,    // Per connection limit
        MaxReadFrameSize:             0,      // Default: 16KB
        PermitProhibitedCipherSuites: false,
        IdleTimeout:                  0,      // Default: no limit
        MaxUploadBufferPerConnection: 65535,
        MaxUploadBufferPerStream:     65535,
    }

    if err := http2.ConfigureServer(srv, h2Server); err != nil {
        log.Fatal(err)
    }

    log.Println("Listening on :8443 with HTTP/2")
    log.Fatal(srv.ListenAndServeTLS("cert.pem", "key.pem"))
}
```

### Understanding HTTP/2 Streams and Frames

HTTP/2 multiplexes multiple requests over a single TCP connection using streams. Each stream is assigned an odd integer ID by the client or even ID by the server (for pushes).

```go
package main

import (
    "fmt"
    "log"
    "net/http"
    "sync"
    "time"
)

// StreamObserver middleware shows HTTP/2 frame info
func streamObserver(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // HTTP/2 specific info available in request
        log.Printf("Proto: %s | Method: %s | Path: %s | RemoteAddr: %s",
            r.Proto, r.Method, r.URL.Path, r.RemoteAddr)

        next.ServeHTTP(w, r)

        log.Printf("Completed in %v", time.Since(start))
    })
}

// DemonstrateConcurrentStreams shows multiplexing in action
func DemonstrateConcurrentStreams() {
    client := &http.Client{
        Transport: &http.Transport{
            TLSClientConfig:     tlsConfig(),
            ForceAttemptHTTP2:   true,
            MaxIdleConns:        100,
            IdleConnTimeout:     90 * time.Second,
            DisableCompression:  false,
        },
    }

    var wg sync.WaitGroup
    results := make([]time.Duration, 10)

    start := time.Now()
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func(idx int) {
            defer wg.Done()
            reqStart := time.Now()
            resp, err := client.Get(fmt.Sprintf("https://localhost:8443/slow/%d", idx))
            if err != nil {
                log.Printf("Request %d failed: %v", idx, err)
                return
            }
            defer resp.Body.Close()
            results[idx] = time.Since(reqStart)
        }(i)
    }
    wg.Wait()

    // With HTTP/2, all 10 requests share one connection and run concurrently
    // Total time should be close to the slowest single request, not sum of all
    log.Printf("Total time (HTTP/2): %v (vs ~%v for HTTP/1.1 serial)",
        time.Since(start), 10*200*time.Millisecond)
}
```

### HTTP/2 Priority and Flow Control

```go
// Demonstrate flow control settings
func configureFlowControl() *http2.Server {
    return &http2.Server{
        // Initial window size for each stream (default: 65535)
        // Increase for high-throughput streaming
        MaxUploadBufferPerStream: 1 << 20, // 1MB per stream

        // Initial window size for the connection
        MaxUploadBufferPerConnection: 1 << 23, // 8MB per connection

        // Maximum concurrent streams per connection
        MaxConcurrentStreams: 500,

        // Maximum frame size (default: 16KB, max: 16MB)
        MaxReadFrameSize: 1 << 17, // 128KB
    }
}
```

## Section 2: Server Push Implementation

HTTP/2 server push allows the server to preemptively send resources to the client before they are requested. Used correctly, it eliminates round trips for critical page resources.

### Basic Server Push

```go
package main

import (
    "fmt"
    "log"
    "net/http"
)

func pageHandler(w http.ResponseWriter, r *http.Request) {
    // Check if the client supports HTTP/2 push
    pusher, ok := w.(http.Pusher)
    if !ok {
        log.Println("Server push not supported (HTTP/1.1 or push disabled)")
        servePageHTTP1(w, r)
        return
    }

    // Push CSS before the HTML response
    pushOptions := &http.PushOptions{
        Method: "GET",
        Header: http.Header{
            "Accept-Encoding": r.Header["Accept-Encoding"],
        },
    }

    resources := []string{
        "/static/css/app.css",
        "/static/js/app.js",
        "/static/fonts/inter.woff2",
    }

    for _, resource := range resources {
        if err := pusher.Push(resource, pushOptions); err != nil {
            // Push may fail if the client has the resource cached (304)
            // or if the push stream limit is reached
            log.Printf("Failed to push %s: %v", resource, err)
        }
    }

    // Now send the HTML response
    w.Header().Set("Content-Type", "text/html")
    fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="/static/css/app.css">
    <script src="/static/js/app.js" defer></script>
</head>
<body>
    <h1>HTTP/2 Server Push Demo</h1>
    <p>CSS and JS were pushed before this HTML arrived.</p>
</body>
</html>`)
}

func servePageHTTP1(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/html")
    // Add Link preload hints as HTTP/1.1 alternative
    w.Header().Add("Link", `</static/css/app.css>; rel=preload; as=style`)
    w.Header().Add("Link", `</static/js/app.js>; rel=preload; as=script`)
    fmt.Fprintf(w, `<!DOCTYPE html><html><body><h1>HTTP/1.1 Page</h1></body></html>`)
}
```

### Conditional Push with Cache Digest

Implement a cookie-based push strategy to avoid re-pushing cached resources:

```go
package main

import (
    "crypto/sha256"
    "encoding/base64"
    "fmt"
    "net/http"
    "strings"
)

type PushTracker struct {
    // Track which resources have been pushed in this session
}

func conditionalPush(w http.ResponseWriter, r *http.Request, resources []string) {
    pusher, ok := w.(http.Pusher)
    if !ok {
        return
    }

    // Read push history from cookie
    pushed := getPushedResources(r)

    for _, resource := range resources {
        resourceHash := hashResource(resource)
        if pushed[resourceHash] {
            // Client likely has this cached, skip push
            continue
        }

        opts := &http.PushOptions{
            Header: http.Header{
                "Accept-Encoding": r.Header["Accept-Encoding"],
                "Accept":          {"*/*"},
            },
        }

        if err := pusher.Push(resource, opts); err == nil {
            pushed[resourceHash] = true
        }
    }

    // Update push history cookie
    setPushedResources(w, pushed)
}

func hashResource(resource string) string {
    h := sha256.Sum256([]byte(resource))
    return base64.StdEncoding.EncodeToString(h[:8])
}

func getPushedResources(r *http.Request) map[string]bool {
    cookie, err := r.Cookie("pushed")
    if err != nil {
        return make(map[string]bool)
    }

    pushed := make(map[string]bool)
    for _, hash := range strings.Split(cookie.Value, ",") {
        if hash != "" {
            pushed[hash] = true
        }
    }
    return pushed
}

func setPushedResources(w http.ResponseWriter, pushed map[string]bool) {
    hashes := make([]string, 0, len(pushed))
    for hash := range pushed {
        hashes = append(hashes, hash)
    }

    // Limit cookie size to avoid headers being too large
    if len(hashes) > 50 {
        hashes = hashes[:50]
    }

    http.SetCookie(w, &http.Cookie{
        Name:  "pushed",
        Value: strings.Join(hashes, ","),
        Path:  "/",
        // Session cookie (no MaxAge)
    })
}

func main() {
    mux := http.NewServeMux()

    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        resources := []string{
            "/static/app.css",
            "/static/app.js",
            "/api/initial-data",
        }
        conditionalPush(w, r, resources)

        w.Header().Set("Content-Type", "text/html")
        fmt.Fprintln(w, "<html><body>App</body></html>")
    })

    // Static file handler
    mux.Handle("/static/", http.StripPrefix("/static/",
        http.FileServer(http.Dir("./static"))))

    srv := &http.Server{
        Addr:    ":8443",
        Handler: mux,
    }

    log.Fatal(srv.ListenAndServeTLS("cert.pem", "key.pem"))
}
```

## Section 3: HTTP/2 Cleartext (h2c)

h2c allows HTTP/2 without TLS. This is common in service mesh scenarios where TLS is handled by a sidecar (Envoy/Linkerd), and inter-service communication can use h2c for the plaintext connection multiplexing benefits.

### h2c Server

```go
package main

import (
    "fmt"
    "log"
    "net"
    "net/http"

    "golang.org/x/net/http2"
    "golang.org/x/net/http2/h2c"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Protocol: %s\n", r.Proto)
        fmt.Fprintf(w, "TLS: %v\n", r.TLS != nil)
    })

    mux.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "text/plain")
        flusher, ok := w.(http.Flusher)
        if !ok {
            http.Error(w, "streaming not supported", http.StatusInternalServerError)
            return
        }

        for i := 0; i < 10; i++ {
            fmt.Fprintf(w, "chunk %d\n", i)
            flusher.Flush()
        }
    })

    // h2c handler wraps the mux and handles HTTP/2 upgrade
    h2cHandler := h2c.NewHandler(mux, &http2.Server{
        MaxConcurrentStreams: 250,
        MaxReadFrameSize:     1 << 17,
    })

    srv := &http.Server{
        Addr:    ":8080",
        Handler: h2cHandler,
    }

    log.Println("h2c server listening on :8080")
    log.Fatal(srv.ListenAndServe())
}
```

### h2c Client

```go
package main

import (
    "context"
    "fmt"
    "io"
    "log"
    "net"
    "net/http"
    "time"

    "golang.org/x/net/http2"
)

func newH2CClient() *http.Client {
    return &http.Client{
        Transport: &http2.Transport{
            // Allow h2c (HTTP/2 without TLS)
            AllowHTTP: true,
            DialTLSContext: func(ctx context.Context, network, addr string, cfg *tls.Config) (net.Conn, error) {
                // Dial without TLS for h2c
                return net.Dial(network, addr)
            },
            // Tune connection parameters
            ReadIdleTimeout:  30 * time.Second,
            PingTimeout:      15 * time.Second,
            MaxReadFrameSize: 1 << 17,
        },
        Timeout: 30 * time.Second,
    }
}

func main() {
    client := newH2CClient()

    // All requests share a single h2c connection (multiplexed)
    for i := 0; i < 5; i++ {
        resp, err := client.Get("http://localhost:8080/")
        if err != nil {
            log.Printf("Request %d failed: %v", i, err)
            continue
        }

        body, _ := io.ReadAll(resp.Body)
        resp.Body.Close()
        fmt.Printf("Response %d: %s", i, body)
    }
}
```

### Connection Reuse and Keep-Alive

```go
// Properly configure transport for connection reuse
func productionTransport() *http.Transport {
    t := &http.Transport{
        // Reuse connections aggressively
        MaxIdleConns:          100,
        MaxIdleConnsPerHost:   10,
        MaxConnsPerHost:       0, // 0 = unlimited
        IdleConnTimeout:       90 * time.Second,

        // TLS configuration
        TLSClientConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
        },

        // Force HTTP/2 even without HTTPS
        ForceAttemptHTTP2: true,

        // Dial settings
        DialContext: (&net.Dialer{
            Timeout:   30 * time.Second,
            KeepAlive: 30 * time.Second,
        }).DialContext,

        // Response handling
        ResponseHeaderTimeout: 10 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,

        // Compression
        DisableCompression: false,
    }

    // Enable HTTP/2 on the transport
    if err := http2.ConfigureTransport(t); err != nil {
        log.Fatalf("failed to configure HTTP/2 transport: %v", err)
    }

    return t
}
```

## Section 4: HTTP/3 and QUIC with quic-go

HTTP/3 runs over QUIC (UDP) instead of TCP. This eliminates head-of-line blocking at the transport layer, provides 0-RTT connection establishment, and handles network changes gracefully via connection migration.

### Setting Up a quic-go HTTP/3 Server

```bash
go get github.com/quic-go/quic-go@latest
go get github.com/quic-go/quic-go/http3@latest
```

```go
package main

import (
    "fmt"
    "log"
    "net/http"
    "time"

    "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Protocol: %s\n", r.Proto)
        // r.Proto will be "HTTP/3.0" for HTTP/3 connections
    })

    mux.HandleFunc("/large", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/octet-stream")
        // QUIC handles packet loss much better than TCP for large transfers
        buf := make([]byte, 1024)
        for i := 0; i < 1024; i++ {
            if _, err := w.Write(buf); err != nil {
                return
            }
        }
    })

    quicConf := &quic.Config{
        // 0-RTT resumption (reduces latency for returning clients)
        Allow0RTT: true,

        // Maximum number of streams
        MaxIncomingStreams:    1000,
        MaxIncomingUniStreams: 1000,

        // Keep-alive
        KeepAlivePeriod: 30 * time.Second,

        // Maximum idle timeout
        MaxIdleTimeout: 30 * time.Second,

        // Initial packet size (default: 1200 bytes for PMTUD compatibility)
        InitialPacketSize: 1200,

        // Enable DATAGRAM frames (RFC 9221)
        EnableDatagrams: false,
    }

    server := &http3.Server{
        Addr:       ":8443",
        TLSConfig:  generateTLSConfig(),
        QuicConfig: quicConf,
        Handler:    mux,
    }

    // Add Alt-Svc header to upgrade HTTP/1.1 or HTTP/2 clients to HTTP/3
    // This tells browsers: "I support HTTP/3 on UDP port 8443"
    handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        server.SetQUICHeaders(w.Header())
        mux.ServeHTTP(w, r)
    })

    // Run both HTTP/2 (for initial discovery) and HTTP/3 servers
    go func() {
        log.Println("HTTP/3 server listening on UDP :8443")
        if err := server.ListenAndServeTLS("cert.pem", "key.pem"); err != nil {
            log.Fatalf("HTTP/3 server error: %v", err)
        }
    }()

    // HTTP/2 server to announce HTTP/3 via Alt-Svc
    http2Srv := &http.Server{
        Addr:    ":8444",
        Handler: handler,
    }
    log.Println("HTTP/2 server listening on TCP :8444")
    log.Fatal(http2Srv.ListenAndServeTLS("cert.pem", "key.pem"))
}
```

### HTTP/3 Client

```go
package main

import (
    "crypto/tls"
    "fmt"
    "io"
    "log"
    "net/http"

    "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
)

func newHTTP3Client() *http.Client {
    roundTripper := &http3.RoundTripper{
        TLSClientConfig: &tls.Config{
            InsecureSkipVerify: false,
            MinVersion:         tls.VersionTLS13, // QUIC requires TLS 1.3
        },
        QuicConfig: &quic.Config{
            Allow0RTT:           true,
            MaxIncomingStreams:   100,
            KeepAlivePeriod:     10,
            MaxIdleTimeout:      30,
        },
        // Disable HTTP/3 upgrade for a specific host
        // DisableCompression: false,
    }

    // Ensure cleanup
    // defer roundTripper.Close()

    return &http.Client{
        Transport: roundTripper,
    }
}

func main() {
    client := newHTTP3Client()

    resp, err := client.Get("https://localhost:8443/")
    if err != nil {
        log.Fatalf("Request failed: %v", err)
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Printf("Status: %s\nProto: %s\nBody: %s\n",
        resp.Status, resp.Proto, body)
}
```

### 0-RTT Connection Establishment

```go
package main

import (
    "context"
    "crypto/tls"
    "log"
    "time"

    "github.com/quic-go/quic-go"
)

func demonstrate0RTT() {
    tlsConf := &tls.Config{
        InsecureSkipVerify: true,
        NextProtos:         []string{"demo"},
        MinVersion:         tls.VersionTLS13,
        // Enable session ticket storage for 0-RTT
        ClientSessionCache: tls.NewLRUClientSessionCache(100),
    }

    // First connection: 1-RTT handshake (stores session ticket)
    log.Println("First connection (1-RTT)...")
    start := time.Now()
    conn1, err := quic.DialAddr(context.Background(),
        "localhost:4433",
        tlsConf,
        &quic.Config{Allow0RTT: true},
    )
    if err != nil {
        log.Fatalf("First dial failed: %v", err)
    }
    log.Printf("First connection established in %v", time.Since(start))
    conn1.CloseWithError(0, "done")

    // Small delay to allow session ticket storage
    time.Sleep(100 * time.Millisecond)

    // Second connection: 0-RTT using cached session ticket
    log.Println("Second connection (0-RTT)...")
    start = time.Now()
    conn2, err := quic.DialAddrEarly(context.Background(),
        "localhost:4433",
        tlsConf,
        &quic.Config{Allow0RTT: true},
    )
    if err != nil {
        log.Fatalf("Second dial failed: %v", err)
    }
    log.Printf("0-RTT connection established in %v", time.Since(start))
    // With 0-RTT, we can start sending data before the handshake completes

    defer conn2.CloseWithError(0, "done")
}
```

## Section 5: Benchmarking HTTP Protocols

### Benchmark Framework

```go
package bench

import (
    "crypto/tls"
    "fmt"
    "io"
    "io/ioutil"
    "log"
    "net/http"
    "sync"
    "testing"
    "time"

    "golang.org/x/net/http2"
)

type BenchConfig struct {
    ServerAddr  string
    Concurrency int
    Requests    int
    PayloadSize int
}

type BenchResult struct {
    Protocol      string
    TotalRequests int
    Duration      time.Duration
    RPS           float64
    P50           time.Duration
    P95           time.Duration
    P99           time.Duration
    Errors        int
}

func RunHTTP1Benchmark(cfg BenchConfig) BenchResult {
    client := &http.Client{
        Transport: &http.Transport{
            TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
            MaxIdleConnsPerHost: cfg.Concurrency,
            DisableKeepAlives:   false,
        },
    }
    return runBench(client, "HTTP/1.1", cfg)
}

func RunHTTP2Benchmark(cfg BenchConfig) BenchResult {
    t := &http.Transport{
        TLSClientConfig:   &tls.Config{InsecureSkipVerify: true},
        ForceAttemptHTTP2: true,
    }
    http2.ConfigureTransport(t)

    client := &http.Client{Transport: t}
    return runBench(client, "HTTP/2", cfg)
}

func runBench(client *http.Client, proto string, cfg BenchConfig) BenchResult {
    latencies := make([]time.Duration, 0, cfg.Requests)
    var mu sync.Mutex
    var errors int

    sem := make(chan struct{}, cfg.Concurrency)
    var wg sync.WaitGroup

    start := time.Now()

    for i := 0; i < cfg.Requests; i++ {
        wg.Add(1)
        sem <- struct{}{}

        go func() {
            defer wg.Done()
            defer func() { <-sem }()

            reqStart := time.Now()
            resp, err := client.Get(fmt.Sprintf("https://%s/bench?size=%d",
                cfg.ServerAddr, cfg.PayloadSize))
            if err != nil {
                mu.Lock()
                errors++
                mu.Unlock()
                return
            }
            defer resp.Body.Close()
            io.Copy(ioutil.Discard, resp.Body)

            lat := time.Since(reqStart)
            mu.Lock()
            latencies = append(latencies, lat)
            mu.Unlock()
        }()
    }

    wg.Wait()
    duration := time.Since(start)

    // Sort latencies
    sortDurations(latencies)

    n := len(latencies)
    return BenchResult{
        Protocol:      proto,
        TotalRequests: cfg.Requests,
        Duration:      duration,
        RPS:           float64(cfg.Requests) / duration.Seconds(),
        P50:           latencies[n/2],
        P95:           latencies[n*95/100],
        P99:           latencies[n*99/100],
        Errors:        errors,
    }
}

func BenchmarkComparison(b *testing.B) {
    cfg := BenchConfig{
        ServerAddr:  "localhost:8443",
        Concurrency: 50,
        Requests:    1000,
        PayloadSize: 4096,
    }

    b.Run("HTTP/1.1", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            result := RunHTTP1Benchmark(cfg)
            b.ReportMetric(result.RPS, "req/s")
            b.ReportMetric(float64(result.P99.Milliseconds()), "P99-ms")
        }
    })

    b.Run("HTTP/2", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            result := RunHTTP2Benchmark(cfg)
            b.ReportMetric(result.RPS, "req/s")
            b.ReportMetric(float64(result.P99.Milliseconds()), "P99-ms")
        }
    })
}
```

### Using hey and wrk for Protocol Benchmarking

```bash
# Install hey
go install github.com/rakyll/hey@latest

# HTTP/1.1 baseline
hey -n 10000 -c 100 -disable-compression https://localhost:8443/

# HTTP/2 (same command, hey auto-negotiates)
hey -n 10000 -c 100 https://localhost:8443/

# HTTP/3 with curl
curl --http3 https://localhost:8443/ -v

# Compare connection count
# HTTP/1.1 with 100 concurrent clients: ~100 connections
# HTTP/2 with 100 concurrent clients: ~4-8 connections (multiplexed)
ss -tn dst 127.0.0.1:8443 | grep ESTABLISHED | wc -l
```

## Section 6: HTTP/2 HEADERS Compression (HPACK)

```go
// HPACK (Header Compression for HTTP/2) reduces header overhead
// Go handles this automatically, but you can observe its impact

package main

import (
    "net/http/httptrace"
    "context"
    "log"
    "net/http"
)

func traceHTTP2Headers() {
    trace := &httptrace.ClientTrace{
        WroteHeaders: func() {
            log.Println("Headers written (compressed with HPACK)")
        },
        GotConn: func(info httptrace.GotConnInfo) {
            log.Printf("Got conn: reused=%v | idle=%v | idleTime=%v",
                info.Reused, info.WasIdle, info.IdleTime)
        },
        TLSHandshakeStart: func() {
            log.Println("TLS handshake started (includes ALPN h2 negotiation)")
        },
        TLSHandshakeDone: func(state tls.ConnectionState, err error) {
            if err == nil {
                log.Printf("TLS done: protocol=%s | negotiated=%s",
                    tls.VersionName(state.Version),
                    state.NegotiatedProtocol)
            }
        },
    }

    req, _ := http.NewRequestWithContext(
        httptrace.WithClientTrace(context.Background(), trace),
        "GET", "https://localhost:8443/", nil,
    )

    // Set headers that benefit from HPACK compression on subsequent requests
    req.Header.Set("Authorization", "Bearer eyJ...")
    req.Header.Set("Accept", "application/json")
    req.Header.Set("User-Agent", "myapp/1.0")

    client := &http.Client{Transport: productionTransport()}
    resp, err := client.Do(req)
    if err != nil {
        log.Fatal(err)
    }
    defer resp.Body.Close()
}
```

## Section 7: Production Configuration and Deployment

### Generating TLS Certificates

```go
package main

import (
    "crypto/ecdsa"
    "crypto/elliptic"
    "crypto/rand"
    "crypto/tls"
    "crypto/x509"
    "crypto/x509/pkix"
    "encoding/pem"
    "math/big"
    "os"
    "time"
)

func generateTLSConfig() *tls.Config {
    key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
    if err != nil {
        panic(err)
    }

    template := x509.Certificate{
        SerialNumber: big.NewInt(1),
        Subject: pkix.Name{
            Organization: []string{"Example Corp"},
            CommonName:   "localhost",
        },
        NotBefore:             time.Now(),
        NotAfter:              time.Now().Add(365 * 24 * time.Hour),
        KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
        ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
        BasicConstraintsValid: true,
        DNSNames:              []string{"localhost"},
    }

    certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
    if err != nil {
        panic(err)
    }

    keyPEM, _ := x509.MarshalECPrivateKey(key)

    return &tls.Config{
        MinVersion: tls.VersionTLS12,
        // HTTP/3 requires TLS 1.3
        // MinVersion: tls.VersionTLS13,
        CurvePreferences: []tls.CurveID{
            tls.X25519,
            tls.CurveP256,
        },
        CipherSuites: []uint16{
            tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
        },
        Certificates: []tls.Certificate{
            {
                Certificate: [][]byte{certDER},
                PrivateKey:  key,
                Leaf:        &template,
            },
        },
        // Enable session tickets for 0-RTT
        SessionTicketsDisabled: false,
    }

    _ = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyPEM})
    _ = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
}
```

### Kubernetes Deployment with HTTP/2 and HTTP/3

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: http3-server
  namespace: production
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: server
        image: myapp:latest
        ports:
        - name: http2
          containerPort: 8443
          protocol: TCP
        - name: http3
          containerPort: 8443
          protocol: UDP  # HTTP/3 runs over UDP
        resources:
          requests:
            cpu: 500m
            memory: 256Mi
          limits:
            cpu: 2000m
            memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: http3-server
spec:
  selector:
    app: http3-server
  ports:
  - name: http2
    port: 443
    targetPort: 8443
    protocol: TCP
  - name: http3
    port: 443
    targetPort: 8443
    protocol: UDP  # Requires NodePort or LoadBalancer with UDP support
```

### Performance Tuning Summary

| Setting | HTTP/1.1 | HTTP/2 | HTTP/3 |
|---------|----------|--------|--------|
| Max concurrent requests | Limited by connections | 250+ per conn | 1000+ per conn |
| Head-of-line blocking | Per connection | Per connection (TCP) | None (QUIC) |
| Handshake RTTs | 1-3 (TLS 1.3) | 1 (TLS 1.3) | 0-1 (0-RTT) |
| Connection migration | No | No | Yes |
| Server push | No | Yes | No (deprecated) |
| Header compression | None | HPACK | QPACK |

HTTP/2 delivers the most immediate benefit in Go applications — no library changes, automatic protocol negotiation, and multiplexing for free. HTTP/3 adds value in high-latency or lossy network environments. h2c is the right choice for internal microservice communication behind a TLS-terminating ingress.
