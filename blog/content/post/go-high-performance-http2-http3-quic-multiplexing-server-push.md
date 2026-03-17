---
title: "Go High-Performance HTTP/2 and HTTP/3: QUIC with quic-go, Multiplexing, Server Push, and h2c Cleartext"
date: 2031-11-02T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "HTTP/2", "HTTP/3", "QUIC", "Performance", "Networking", "quic-go"]
categories:
- Go
- Networking
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into high-performance HTTP/2 and HTTP/3 server and client implementations in Go: leveraging quic-go for QUIC transport, implementing HTTP/2 multiplexing and server push, configuring h2c cleartext for internal services, and optimizing connection management for maximum throughput."
more_link: "yes"
url: "/go-high-performance-http2-http3-quic-multiplexing-server-push/"
---

HTTP/2 and HTTP/3 offer substantial performance improvements over HTTP/1.1 through multiplexing, header compression, and server push — but realizing these gains requires understanding how to properly configure Go's standard library and the quic-go library. This guide covers production-ready implementations of both protocols, with particular focus on the connection management patterns that differentiate high-performance services from naive implementations.

<!--more-->

# Go High-Performance HTTP/2 and HTTP/3 Implementation Guide

## Protocol Comparison

| Feature | HTTP/1.1 | HTTP/2 | HTTP/3 |
|---------|----------|--------|--------|
| Transport | TCP | TCP | QUIC (UDP) |
| Multiplexing | No (pipelining only) | Yes, per connection | Yes, per connection |
| Head-of-line blocking | Yes | TCP level | No |
| Header compression | No | HPACK | QPACK |
| Server Push | No | Yes | Yes (draft) |
| 0-RTT | No | No | Yes |
| Connection migration | No | No | Yes |

HTTP/3's key advantage is eliminating TCP's head-of-line blocking — a single lost packet blocks all streams on an HTTP/2 connection, but in QUIC each stream is independent.

## HTTP/2 with Go's Standard Library

Go's `net/http` package implements HTTP/2 automatically when TLS is configured. Understanding the internal behavior is crucial for performance tuning.

### Basic HTTP/2 Server

```go
// cmd/h2-server/main.go
package main

import (
    "crypto/tls"
    "log/slog"
    "net/http"
    "os"
    "time"

    "golang.org/x/net/http2"
    "golang.org/x/net/http2/h2c"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    mux := http.NewServeMux()
    mux.HandleFunc("/api/data", handleData)
    mux.HandleFunc("/api/stream", handleStream)

    // HTTP/2 over TLS (standard HTTPS with ALPN negotiation)
    tlsCfg := &tls.Config{
        MinVersion: tls.VersionTLS13,
        NextProtos: []string{"h2", "http/1.1"},
        CurvePreferences: []tls.CurveID{
            tls.X25519,
            tls.CurveP256,
        },
        PreferServerCipherSuites: false, // TLS 1.3 ignores this
        SessionTicketsDisabled:   false,
        ClientSessionCache:       tls.NewLRUClientSessionCache(128),
    }

    h2Server := &http2.Server{
        MaxHandlers:                  0,  // no limit
        MaxConcurrentStreams:          250,
        MaxReadFrameSize:             1 << 20, // 1MB
        PermitProhibitedCipherSuites:  false,
        IdleTimeout:                  30 * time.Second,
        MaxUploadBufferPerConnection:  1 << 20,
        MaxUploadBufferPerStream:      1 << 20,
    }

    srv := &http.Server{
        Addr:         ":443",
        Handler:      mux,
        TLSConfig:    tlsCfg,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Configure HTTP/2 on the server
    if err := http2.ConfigureServer(srv, h2Server); err != nil {
        logger.Error("failed to configure HTTP/2", "error", err)
        os.Exit(1)
    }

    logger.Info("starting HTTP/2 server", "addr", ":443")
    if err := srv.ListenAndServeTLS("cert.pem", "key.pem"); err != nil {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
}

func handleData(w http.ResponseWriter, r *http.Request) {
    // Log protocol version
    slog.Info("request received",
        "proto", r.Proto,
        "method", r.Method,
        "path", r.URL.Path)

    w.Header().Set("Content-Type", "application/json")
    w.Write([]byte(`{"status":"ok","protocol":"` + r.Proto + `"}`))
}
```

### HTTP/2 Server Push

Server push allows the server to proactively send resources the client will need:

```go
// handler with server push
func handleIndex(w http.ResponseWriter, r *http.Request) {
    // Check if the client supports HTTP/2 push
    pusher, ok := w.(http.Pusher)
    if ok {
        // Push CSS before sending the HTML response
        pushOpts := &http.PushOptions{
            Header: http.Header{
                "Accept-Encoding": r.Header["Accept-Encoding"],
                "Cache-Control":   []string{"max-age=31536000"},
            },
        }

        resources := []string{
            "/static/css/main.css",
            "/static/js/bundle.js",
            "/static/fonts/roboto.woff2",
        }

        for _, resource := range resources {
            if err := pusher.Push(resource, pushOpts); err != nil {
                // Push failed - not fatal, client will request normally
                slog.Debug("server push failed", "resource", resource, "error", err)
            } else {
                slog.Debug("pushed resource", "resource", resource)
            }
        }
    }

    w.Header().Set("Content-Type", "text/html")
    http.ServeFile(w, r, "static/index.html")
}
```

### HTTP/2 Streaming (Server-Sent Events)

```go
// handler for streaming responses
func handleStream(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("X-Accel-Buffering", "no")

    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "streaming not supported", http.StatusInternalServerError)
        return
    }

    // Context for client disconnect detection
    ctx := r.Context()
    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case t := <-ticker.C:
            fmt.Fprintf(w, "data: {\"time\":\"%s\",\"proto\":\"%s\"}\n\n",
                t.Format(time.RFC3339), r.Proto)
            flusher.Flush()
        }
    }
}
```

## h2c (HTTP/2 Cleartext) for Internal Services

HTTP/2 without TLS is essential for internal microservice communication where TLS overhead is undesirable:

```go
// internal/server/h2c.go
package server

import (
    "net/http"
    "time"

    "golang.org/x/net/http2"
    "golang.org/x/net/http2/h2c"
)

// NewH2CServer creates an HTTP/2 cleartext server for internal use
func NewH2CServer(addr string, handler http.Handler) *http.Server {
    h2s := &http2.Server{
        MaxConcurrentStreams: 250,
        IdleTimeout:         30 * time.Second,
    }

    return &http.Server{
        Addr:    addr,
        Handler: h2c.NewHandler(handler, h2s),
        // No TLS configuration needed for h2c
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
    }
}
```

### h2c Client

```go
// internal/client/h2c.go
package client

import (
    "crypto/tls"
    "net"
    "net/http"
    "time"

    "golang.org/x/net/http2"
)

// NewH2CClient creates an HTTP client that speaks h2c (HTTP/2 cleartext)
func NewH2CClient() *http.Client {
    transport := &http2.Transport{
        // Allow h2c (no TLS)
        AllowHTTP: true,
        // Use a custom dial function that doesn't negotiate TLS
        DialTLS: func(network, addr string, cfg *tls.Config) (net.Conn, error) {
            return net.DialTimeout(network, addr, 30*time.Second)
        },
        // Connection pooling settings
        MaxHeaderListSize:  16 << 10, // 16KB
        StrictMaxConcurrentStreams: false,
    }

    return &http.Client{
        Transport: transport,
        Timeout:   30 * time.Second,
    }
}

// Usage:
// client := NewH2CClient()
// resp, err := client.Get("http://internal-service:8080/api/v1/data")
```

## HTTP/2 Multiplexing in Practice

HTTP/2 multiplexes multiple requests over a single TCP connection. This requires changing how you think about connection management:

```go
// internal/httpclient/pool.go
package httpclient

import (
    "crypto/tls"
    "net"
    "net/http"
    "time"

    "golang.org/x/net/http2"
)

// NewHTTP2Client creates an HTTP client optimized for HTTP/2 multiplexing
// Key insight: with HTTP/2, you want FEWER connections with more streams,
// not more connections as with HTTP/1.1
func NewHTTP2Client(maxIdleConnsPerHost int) *http.Client {
    transport := &http.Transport{
        // HTTP/2 uses far fewer connections than HTTP/1.1
        // Increase per-host limit to allow connection reuse
        MaxIdleConnsPerHost: maxIdleConnsPerHost,
        MaxIdleConns:        maxIdleConnsPerHost * 10,

        // Longer idle timeout to keep HTTP/2 connections alive
        IdleConnTimeout:       120 * time.Second,

        // Connection timeouts
        DialContext: (&net.Dialer{
            Timeout:   10 * time.Second,
            KeepAlive: 30 * time.Second,
        }).DialContext,

        TLSHandshakeTimeout:   10 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,

        TLSClientConfig: &tls.Config{
            MinVersion: tls.VersionTLS13,
            // TLS session resumption reduces handshake overhead
            ClientSessionCache: tls.NewLRUClientSessionCache(256),
        },

        // HTTP/2 settings
        ForceAttemptHTTP2: true,
    }

    // Configure HTTP/2-specific settings on the transport
    if err := http2.ConfigureTransport(transport); err != nil {
        panic(err)
    }

    return &http.Client{
        Transport: transport,
        Timeout:   30 * time.Second,
    }
}
```

### Connection Multiplexing Benchmark

```go
// cmd/benchmark/main.go
package main

import (
    "fmt"
    "io"
    "log"
    "net/http"
    "sync"
    "sync/atomic"
    "time"

    "github.com/example/myapp/internal/httpclient"
)

func benchmarkHTTP(protocol string, client *http.Client, url string, concurrency, requests int) {
    var completed atomic.Int64
    var errors atomic.Int64
    var totalBytes atomic.Int64

    start := time.Now()

    sem := make(chan struct{}, concurrency)
    var wg sync.WaitGroup

    for i := 0; i < requests; i++ {
        wg.Add(1)
        sem <- struct{}{}

        go func() {
            defer wg.Done()
            defer func() { <-sem }()

            resp, err := client.Get(url)
            if err != nil {
                errors.Add(1)
                return
            }
            defer resp.Body.Close()

            n, _ := io.Copy(io.Discard, resp.Body)
            totalBytes.Add(n)
            completed.Add(1)
        }()
    }

    wg.Wait()
    elapsed := time.Since(start)

    rps := float64(completed.Load()) / elapsed.Seconds()
    mbps := float64(totalBytes.Load()) / elapsed.Seconds() / 1024 / 1024

    fmt.Printf("Protocol: %s\n", protocol)
    fmt.Printf("  Completed: %d/%d requests\n", completed.Load(), requests)
    fmt.Printf("  Errors: %d\n", errors.Load())
    fmt.Printf("  Duration: %v\n", elapsed.Round(time.Millisecond))
    fmt.Printf("  RPS: %.0f\n", rps)
    fmt.Printf("  Throughput: %.2f MB/s\n", mbps)
    fmt.Println()
}

func main() {
    h1Client := &http.Client{Timeout: 30 * time.Second}
    h2Client := httpclient.NewHTTP2Client(10)

    url := "https://benchmark-server:8443/api/data"
    concurrency := 100
    requests := 10000

    benchmarkHTTP("HTTP/1.1", h1Client, url, concurrency, requests)
    benchmarkHTTP("HTTP/2", h2Client, url, concurrency, requests)
}
```

## HTTP/3 with quic-go

### Installing quic-go

```bash
go get github.com/quic-go/quic-go@latest
go get github.com/quic-go/quic-go/http3@latest
```

### HTTP/3 Server Implementation

```go
// cmd/h3-server/main.go
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
    "github.com/quic-go/quic-go/qlog"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // Load TLS certificate
    cert, err := tls.LoadX509KeyPair("cert.pem", "key.pem")
    if err != nil {
        logger.Error("failed to load certificate", "error", err)
        os.Exit(1)
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{cert},
        MinVersion:   tls.VersionTLS13,
        NextProtos:   []string{"h3"},
    }

    // QUIC configuration for production
    quicConfig := &quic.Config{
        // Maximum number of concurrent bidirectional streams per connection
        MaxIncomingStreams: 1000,
        // Maximum number of concurrent unidirectional streams
        MaxIncomingUniStreams: 100,
        // Keep-alive to detect dead connections
        KeepAlivePeriod: 15 * time.Second,
        // Maximum connection idle timeout
        MaxIdleTimeout: 30 * time.Second,
        // Enable 0-RTT resumption for repeat clients
        Allow0RTT: true,
        // Enable qlog for debugging (disable in production for performance)
        Tracer: func(ctx context.Context, p quic.Perspective, id quic.ConnectionID) *logging.ConnectionTracer {
            if os.Getenv("QUIC_QLOG") == "true" {
                return qlog.NewConnectionTracer(
                    qlog.NewDefaultTracer(os.Stderr),
                    p, id)
            }
            return nil
        },
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/api/data", handleDataH3)
    mux.HandleFunc("/api/stream", handleStreamH3)

    // HTTP/3 server
    h3Server := &http3.Server{
        Addr:       ":443",
        Handler:    mux,
        TLSConfig:  tlsConfig,
        QUICConfig: quicConfig,
    }

    // Also run HTTP/2 server for clients that don't support HTTP/3
    h2Server := &http.Server{
        Addr:    ":443",
        Handler: mux,
    }

    // The Alt-Svc header advertises HTTP/3 availability to HTTP/2 clients
    // Wrap the mux to add Alt-Svc headers
    altSvcMux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Advertise HTTP/3 on port 443
        w.Header().Set("Alt-Svc", `h3=":443"; ma=2592000`)
        mux.ServeHTTP(w, r)
    })
    h2Server.Handler = altSvcMux

    // Start both servers
    errCh := make(chan error, 2)

    go func() {
        logger.Info("starting HTTP/3 server", "addr", ":443/udp")
        errCh <- h3Server.ListenAndServeTLS("cert.pem", "key.pem")
    }()

    go func() {
        logger.Info("starting HTTP/2 server (with Alt-Svc)", "addr", ":443/tcp")
        errCh <- h2Server.ListenAndServeTLS("cert.pem", "key.pem")
    }()

    // Graceful shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

    select {
    case err := <-errCh:
        logger.Error("server error", "error", err)
    case sig := <-sigCh:
        logger.Info("shutting down", "signal", sig)
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        h3Server.Shutdown(ctx)
        h2Server.Shutdown(ctx)
    }
}

func handleDataH3(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintf(w, `{"status":"ok","protocol":"%s","tls":"%s"}`,
        r.Proto,
        r.TLS.Version)
}

func handleStreamH3(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")

    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "streaming not supported", http.StatusInternalServerError)
        return
    }

    ctx := r.Context()
    ticker := time.NewTicker(500 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case t := <-ticker.C:
            fmt.Fprintf(w, "data: {\"time\":\"%s\",\"quic\":true}\n\n", t.Format(time.RFC3339Nano))
            flusher.Flush()
        }
    }
}
```

### HTTP/3 Client

```go
// internal/h3client/client.go
package h3client

import (
    "context"
    "crypto/tls"
    "net/http"
    "time"

    "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
)

// NewHTTP3Client creates an HTTP client that prefers HTTP/3
// and falls back to HTTP/2 or HTTP/1.1
func NewHTTP3Client(insecureSkipVerify bool) *http.Client {
    tlsConfig := &tls.Config{
        InsecureSkipVerify: insecureSkipVerify,
        MinVersion:         tls.VersionTLS13,
        ClientSessionCache: tls.NewLRUClientSessionCache(256),
    }

    // QUIC transport for HTTP/3
    quicTransport := &http3.RoundTripper{
        TLSClientConfig: tlsConfig,
        QUICConfig: &quic.Config{
            MaxIdleTimeout:       30 * time.Second,
            KeepAlivePeriod:      15 * time.Second,
            MaxIncomingStreams:    100,
            MaxIncomingUniStreams: 10,
        },
        EnableDatagrams:  false,
        DisableCompression: false,
    }

    return &http.Client{
        Transport: quicTransport,
        Timeout:   30 * time.Second,
    }
}

// NewH3WithFallback creates a client that tries HTTP/3 first and falls
// back to HTTP/2/1.1 if unavailable
func NewH3WithFallback(insecureSkipVerify bool) *http.Client {
    tlsConfig := &tls.Config{
        InsecureSkipVerify: insecureSkipVerify,
        MinVersion:         tls.VersionTLS13,
    }

    roundTripper := &http3.RoundTripper{
        TLSClientConfig: tlsConfig,
        QUICConfig: &quic.Config{
            MaxIdleTimeout:  30 * time.Second,
            KeepAlivePeriod: 15 * time.Second,
        },
    }

    // The RoundTripper handles fallback internally when the server
    // doesn't support QUIC
    return &http.Client{
        Transport: roundTripper,
        Timeout:   30 * time.Second,
    }
}
```

## QUIC Connection Management

### Connection Multiplexing with QUIC

QUIC streams are more powerful than HTTP/2 streams because they're independently flow-controlled:

```go
// internal/quic/multiplexer.go
package quicconn

import (
    "context"
    "crypto/tls"
    "fmt"
    "io"
    "sync"
    "time"

    "github.com/quic-go/quic-go"
)

// StreamPool manages a pool of QUIC streams for custom protocols
type StreamPool struct {
    conn    quic.Connection
    streams []quic.Stream
    mu      sync.Mutex
    maxSize int
}

func NewStreamPool(conn quic.Connection, maxSize int) *StreamPool {
    return &StreamPool{
        conn:    conn,
        streams: make([]quic.Stream, 0, maxSize),
        maxSize: maxSize,
    }
}

func (p *StreamPool) Get(ctx context.Context) (quic.Stream, error) {
    p.mu.Lock()
    if len(p.streams) > 0 {
        s := p.streams[len(p.streams)-1]
        p.streams = p.streams[:len(p.streams)-1]
        p.mu.Unlock()
        return s, nil
    }
    p.mu.Unlock()

    return p.conn.OpenStreamSync(ctx)
}

func (p *StreamPool) Put(s quic.Stream) {
    p.mu.Lock()
    defer p.mu.Unlock()

    if len(p.streams) < p.maxSize {
        p.streams = append(p.streams, s)
    } else {
        s.Close()
    }
}

// QUICServer implements a custom protocol over QUIC
type QUICServer struct {
    listener *quic.Listener
}

func NewQUICServer(addr string, tlsConfig *tls.Config) (*QUICServer, error) {
    listener, err := quic.ListenAddr(addr, tlsConfig, &quic.Config{
        MaxIncomingStreams:  1000,
        MaxIdleTimeout:     30 * time.Second,
        KeepAlivePeriod:    15 * time.Second,
        Allow0RTT:          true,
    })
    if err != nil {
        return nil, fmt.Errorf("failed to listen: %w", err)
    }
    return &QUICServer{listener: listener}, nil
}

func (s *QUICServer) Accept(ctx context.Context) error {
    for {
        conn, err := s.listener.Accept(ctx)
        if err != nil {
            return err
        }
        go s.handleConnection(conn)
    }
}

func (s *QUICServer) handleConnection(conn quic.Connection) {
    defer conn.CloseWithError(0, "server done")

    // Accept streams concurrently - each stream is independent
    for {
        stream, err := conn.AcceptStream(context.Background())
        if err != nil {
            return
        }
        go s.handleStream(stream)
    }
}

func (s *QUICServer) handleStream(stream quic.Stream) {
    defer stream.Close()

    buf := make([]byte, 4096)
    for {
        n, err := stream.Read(buf)
        if err == io.EOF {
            return
        }
        if err != nil {
            return
        }

        // Echo back (example protocol)
        if _, err := stream.Write(buf[:n]); err != nil {
            return
        }
    }
}
```

### 0-RTT Connection Establishment

```go
// internal/quic/client_0rtt.go
package quicconn

import (
    "context"
    "crypto/tls"
    "fmt"

    "github.com/quic-go/quic-go"
)

// Dial0RTT establishes a QUIC connection with 0-RTT if a session ticket is available
func Dial0RTT(ctx context.Context, addr string, tlsConfig *tls.Config) (quic.EarlyConnection, error) {
    cfg := &quic.Config{
        MaxIdleTimeout:  30 * time.Second,
        KeepAlivePeriod: 15 * time.Second,
    }

    conn, err := quic.DialEarlyAddr(ctx, addr, tlsConfig, cfg)
    if err != nil {
        return nil, fmt.Errorf("dial failed: %w", err)
    }

    return conn, nil
}

// CheckResumed checks whether a connection used 0-RTT
func CheckResumed(conn quic.Connection) bool {
    state := conn.ConnectionState()
    return state.TLS.DidResume && !state.Used0RTT == false
}
```

## HTTP/2 Priority and Flow Control

### Understanding Stream Priority

HTTP/2 allows clients to declare stream priority using weight and dependency:

```go
// HTTP/2 stream priority hints
func handlePrioritizedRequest(w http.ResponseWriter, r *http.Request) {
    // In Go's http2 implementation, priority is set via headers
    // The :priority pseudo-header (HTTP/3) or HEADERS+PRIORITY frame (HTTP/2)

    // For server-side, respond with appropriate cache headers
    // to influence client-side priority
    w.Header().Set("Cache-Control", "no-store")  // Critical resources
    w.Header().Set("Content-Type", "application/javascript")

    // Write response
    http.ServeFile(w, r, "static/critical.js")
}
```

### Flow Control Tuning

```go
// Fine-tune HTTP/2 flow control windows
h2Config := &http2.Server{
    // Initial flow control window for connections (bytes)
    // Default: 65535 (64KB) - too small for high-latency links
    // Increase for high-BDP paths
    MaxUploadBufferPerConnection: 1 << 24, // 16MB
    MaxUploadBufferPerStream:     1 << 23, // 8MB

    // Maximum frame size (default: 16384)
    MaxReadFrameSize: 1 << 20, // 1MB - for large payloads

    // Maximum number of streams per connection
    MaxConcurrentStreams: 250, // Default is 250 per RFC
}
```

## Performance Tuning and Profiling

### HTTP/2 Connection Reuse Verification

```go
// cmd/verify-h2-reuse/main.go
package main

import (
    "crypto/tls"
    "fmt"
    "net/http"
    "net/http/httptrace"
    "sync/atomic"
    "time"

    "golang.org/x/net/http2"
)

func main() {
    transport := &http.Transport{
        ForceAttemptHTTP2: true,
        MaxIdleConnsPerHost: 5,
        TLSClientConfig: &tls.Config{
            InsecureSkipVerify: true, // Only for testing
        },
    }
    http2.ConfigureTransport(transport)

    client := &http.Client{Transport: transport}

    var newConns atomic.Int64
    var reusedConns atomic.Int64

    trace := &httptrace.ClientTrace{
        GotConn: func(info httptrace.GotConnInfo) {
            if info.Reused {
                reusedConns.Add(1)
            } else {
                newConns.Add(1)
            }
            fmt.Printf("Connection: reused=%v idle=%v\n",
                info.Reused, info.WasIdle)
        },
    }

    // Make 20 requests
    for i := 0; i < 20; i++ {
        req, _ := http.NewRequest("GET", "https://localhost:8443/api/data", nil)
        req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))

        resp, err := client.Do(req)
        if err != nil {
            fmt.Printf("Error: %v\n", err)
            continue
        }
        resp.Body.Close()
    }

    fmt.Printf("\nNew connections: %d\n", newConns.Load())
    fmt.Printf("Reused connections: %d\n", reusedConns.Load())
    // With HTTP/2, all 20 requests should use 1 connection (19 reused)
}
```

### Benchmarking HTTP/2 vs HTTP/3

```bash
# Install h2load (nghttp2)
apt-get install -y nghttp2-client

# Benchmark HTTP/2
h2load -n 10000 -c 100 -m 10 https://server:443/api/data

# Benchmark using wrk with HTTP/2 support
wrk --latency -t 4 -c 100 -d 30s \
  --header "Accept: application/json" \
  https://server:443/api/data

# For HTTP/3, use curl with QUIC support
curl --http3 -o /dev/null -s -w "Protocol: %{http_version}\nTime: %{time_total}s\n" \
  https://server:443/api/data

# Batch benchmark with curl
for i in $(seq 1 100); do
    curl --http3 -o /dev/null -s -w "%{time_total}\n" https://server:443/api/data
done | awk '{sum+=$1; count++} END {print "Avg: " sum/count "s, Count: " count}'
```

## Production Deployment Considerations

### Kubernetes Service for UDP (QUIC/HTTP/3)

HTTP/3 requires UDP support, which needs explicit Kubernetes configuration:

```yaml
# service-h3.yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    # AWS: Ensure NLB supports UDP (not ALB)
    service.beta.kubernetes.io/aws-load-balancer-type: external
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
spec:
  type: LoadBalancer
  selector:
    app: api-service
  ports:
    - name: https-tcp
      port: 443
      targetPort: 443
      protocol: TCP
    - name: https-udp
      port: 443
      targetPort: 443
      protocol: UDP
```

### NGINX as HTTP/3 Front-End with Upstream HTTP/2

```nginx
# nginx.conf
http {
    upstream api_backend {
        server api-service:8080;
        keepalive 32;  # Maintain HTTP/2 connections to backend
    }

    server {
        listen 443 ssl;
        listen 443 quic reuseport;  # HTTP/3

        ssl_certificate     /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;
        ssl_protocols       TLSv1.3;

        # HTTP/3 advertisement
        add_header Alt-Svc 'h3=":443"; ma=86400';

        location / {
            proxy_pass http://api_backend;
            proxy_http_version 1.1;  # or 2.0 if backend supports it
            proxy_set_header Connection "";  # Enable keepalive

            # HTTP/2 to backend (requires NGINX Plus)
            # grpc_pass grpc://api_backend;
        }
    }
}
```

### QUIC Firewall Considerations

```bash
# QUIC uses UDP port 443 - ensure firewall allows it
# For AWS Security Groups:
aws ec2 authorize-security-group-ingress \
  --group-id sg-0123456789abcdef0 \
  --protocol udp \
  --port 443 \
  --cidr 0.0.0.0/0

# For iptables:
iptables -A INPUT -p udp --dport 443 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# For nftables:
nft add rule inet filter input udp dport 443 accept
nft add rule inet filter input tcp dport 443 accept
```

## Monitoring HTTP/2 and HTTP/3 Performance

```go
// internal/metrics/http_metrics.go
package metrics

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    requestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration by protocol",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path", "status", "protocol"},
    )

    activeStreams = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "http_active_streams",
            Help: "Number of active HTTP streams",
        },
        []string{"protocol"},
    )
)

// InstrumentHandler wraps an HTTP handler with protocol-aware metrics
func InstrumentHandler(handler http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        proto := r.Proto

        activeStreams.WithLabelValues(proto).Inc()
        defer activeStreams.WithLabelValues(proto).Dec()

        rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
        handler.ServeHTTP(rw, r)

        duration := time.Since(start)
        requestDuration.WithLabelValues(
            r.Method,
            r.URL.Path,
            strconv.Itoa(rw.statusCode),
            proto,
        ).Observe(duration.Seconds())
    })
}

type responseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}
```

## Conclusion

HTTP/2 and HTTP/3 offer genuine performance improvements for Go services, but they require protocol-aware configuration. The key patterns are: use HTTP/2 multiplexing to reduce connection count (not increase it), configure flow control windows for your network's BDP, use h2c for internal microservices to avoid TLS overhead, and deploy HTTP/3 via quic-go where UDP is available and the latency benefits justify the added complexity. For most enterprise internal APIs, HTTP/2 with properly tuned connection pooling provides the best balance of performance and operational simplicity.
