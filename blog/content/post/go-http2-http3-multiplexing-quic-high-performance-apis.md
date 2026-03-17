---
title: "Go HTTP/2 and HTTP/3: Multiplexing and QUIC for High-Performance APIs"
date: 2031-02-13T00:00:00-05:00
draft: false
tags: ["Go", "HTTP/2", "HTTP/3", "QUIC", "Performance", "TLS", "Networking"]
categories:
- Go
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go HTTP/2 and HTTP/3 covering net/http automatic H2 enablement, h2c cleartext HTTP/2, HTTP/3 with quic-go, server push deprecation, multiplexing benefits for microservices, and production TLS configuration."
more_link: "yes"
url: "/go-http2-http3-multiplexing-quic-high-performance-apis/"
---

HTTP/2 and HTTP/3 offer fundamental improvements over HTTP/1.1 for microservice-to-microservice communication: multiplexed streams over a single connection, header compression, and in the case of HTTP/3, elimination of head-of-line blocking at the transport layer. This guide covers how to configure and optimize these protocols in Go for production API services.

<!--more-->

# Go HTTP/2 and HTTP/3: Multiplexing and QUIC for High-Performance APIs

## Why HTTP/2 and HTTP/3 Matter for Microservices

HTTP/1.1 has a fundamental limitation: one request per TCP connection at a time (without pipelining, which is rarely used). Browsers work around this by opening 6-8 connections per origin. Microservices typically maintain connection pools for the same reason.

HTTP/2 solves the request serialization problem with multiplexing: multiple requests and responses can be in flight simultaneously over a single connection. For microservices making dozens of concurrent calls, this reduces connection overhead dramatically.

HTTP/3 goes further by running over QUIC (a UDP-based transport) instead of TCP, eliminating head-of-line blocking at the transport layer. A single dropped packet in HTTP/2 (over TCP) stalls all streams. In HTTP/3, a dropped packet only affects the stream that was using that packet.

## Section 1: HTTP/2 in Go's net/http Package

### Automatic HTTP/2 Enablement

Go's `net/http` package automatically negotiates HTTP/2 when TLS is configured. No additional code is needed for the server to support HTTP/2:

```go
package main

import (
    "crypto/tls"
    "fmt"
    "log"
    "net/http"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Protocol: %s\n", r.Proto)
        // r.Proto will be "HTTP/2.0" for HTTP/2 requests
    })

    server := &http.Server{
        Addr:    ":8443",
        Handler: mux,
        TLSConfig: &tls.Config{
            MinVersion: tls.VersionTLS13,
        },
    }

    // HTTP/2 is automatically enabled when using ListenAndServeTLS
    log.Printf("Starting server on :8443 (HTTP/2 enabled automatically)")
    log.Fatal(server.ListenAndServeTLS("server.crt", "server.key"))
}
```

### Verifying HTTP/2 is Active

```bash
# Use curl to check the protocol
curl -k --http2 -v https://localhost:8443/ 2>&1 | grep "Using HTTP"
# > Using HTTP2, server supports multiplexing

# Use the HTTP/2 debugging tool
go install golang.org/x/net/http2/h2c@latest

# Check server ALPN negotiation
openssl s_client -connect localhost:8443 -alpn h2 </dev/null 2>&1 | grep "ALPN"
# ALPN protocol: h2
```

### HTTP/2 Server Configuration Tuning

```go
package main

import (
    "crypto/tls"
    "log"
    "net/http"
    "time"

    "golang.org/x/net/http2"
)

func buildHTTP2Server(handler http.Handler) *http.Server {
    tlsConfig := &tls.Config{
        MinVersion: tls.VersionTLS13,
        // Explicitly list cipher suites for TLS 1.2 compatibility
        CipherSuites: []uint16{
            tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        },
        // ALPN protocol negotiation — h2 must be listed before http/1.1
        NextProtos: []string{"h2", "http/1.1"},
    }

    server := &http.Server{
        Addr:         ":8443",
        Handler:      handler,
        TLSConfig:    tlsConfig,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Configure HTTP/2-specific settings
    h2Server := &http2.Server{
        // Maximum number of concurrent streams per connection
        MaxConcurrentStreams: 250,

        // Maximum receive window size (flow control)
        // Default is 65535; increase for high-bandwidth scenarios
        MaxUploadBufferPerConnection: 1 << 20, // 1 MB

        // Maximum receive window per stream
        MaxUploadBufferPerStream: 1 << 20, // 1 MB

        // How long to wait for the first byte of a request
        // Prevents slow-loris attacks
        NewWriteScheduler: func() http2.WriteScheduler {
            return http2.NewPriorityWriteScheduler(nil)
        },
    }

    // Register the HTTP/2 configuration with the server
    if err := http2.ConfigureServer(server, h2Server); err != nil {
        log.Fatalf("configuring HTTP/2: %v", err)
    }

    return server
}
```

## Section 2: h2c — Cleartext HTTP/2

HTTP/2 without TLS (h2c) is useful for internal microservice communication where the network is already trusted (service mesh with mTLS, for example) and you want to avoid the TLS overhead.

### h2c Server

```go
package main

import (
    "fmt"
    "log"
    "net/http"

    "golang.org/x/net/http2"
    "golang.org/x/net/http2/h2c"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Protocol: %s, RemoteAddr: %s\n", r.Proto, r.RemoteAddr)
    })

    mux.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
        // HTTP/2 allows streaming responses
        flusher, ok := w.(http.Flusher)
        if !ok {
            http.Error(w, "streaming not supported", http.StatusInternalServerError)
            return
        }

        w.Header().Set("Content-Type", "text/event-stream")
        w.Header().Set("Cache-Control", "no-cache")

        for i := 0; i < 10; i++ {
            fmt.Fprintf(w, "data: event %d\n\n", i)
            flusher.Flush()
        }
    })

    // h2c.NewHandler wraps any http.Handler and adds HTTP/2 cleartext support
    h2cHandler := h2c.NewHandler(mux, &http2.Server{
        MaxConcurrentStreams: 100,
    })

    server := &http.Server{
        Addr:    ":8080",
        Handler: h2cHandler,
    }

    log.Printf("Starting h2c server on :8080")
    log.Fatal(server.ListenAndServe())
}
```

### h2c Client

```go
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "io"
    "log"
    "net"
    "net/http"
    "sync"
    "time"

    "golang.org/x/net/http2"
)

func buildH2CClient() *http.Client {
    // http2.Transport configured for cleartext h2c
    h2Transport := &http2.Transport{
        AllowHTTP: true, // Required for h2c (cleartext)
        DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
            // Dial plain TCP (no TLS) for h2c
            dialer := &net.Dialer{
                Timeout:   10 * time.Second,
                KeepAlive: 30 * time.Second,
            }
            return dialer.DialContext(ctx, network, addr)
        },
    }

    return &http.Client{
        Transport: h2Transport,
        Timeout:   30 * time.Second,
    }
}

// DemoConcurrentRequests demonstrates HTTP/2 multiplexing by sending
// multiple requests concurrently over a single connection.
func DemoConcurrentRequests(baseURL string, concurrency int) {
    client := buildH2CClient()

    var wg sync.WaitGroup
    start := time.Now()

    for i := 0; i < concurrency; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()

            resp, err := client.Get(fmt.Sprintf("%s/?req=%d", baseURL, n))
            if err != nil {
                log.Printf("request %d failed: %v", n, err)
                return
            }
            defer resp.Body.Close()

            body, _ := io.ReadAll(resp.Body)
            log.Printf("request %d: proto=%s body=%s",
                n, resp.Proto, string(body))
        }(i)
    }

    wg.Wait()
    log.Printf("All %d requests completed in %v", concurrency, time.Since(start))
}
```

### Comparing HTTP/1.1 vs HTTP/2 Connection Behavior

```go
// Demonstrates the connection pooling difference between HTTP/1.1 and HTTP/2

func benchmarkHTTP1(baseURL string, requests int) time.Duration {
    // HTTP/1.1 needs multiple connections for concurrent requests
    client := &http.Client{
        Transport: &http.Transport{
            MaxIdleConns:        100,
            MaxIdleConnsPerHost: 10, // Will open up to 10 connections per host
            IdleConnTimeout:     90 * time.Second,
        },
    }

    start := time.Now()
    var wg sync.WaitGroup

    for i := 0; i < requests; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            resp, err := client.Get(fmt.Sprintf("%s/api/resource/%d", baseURL, n))
            if err != nil {
                return
            }
            io.Copy(io.Discard, resp.Body)
            resp.Body.Close()
        }(i)
    }

    wg.Wait()
    return time.Since(start)
}

func benchmarkHTTP2(baseURL string, requests int) time.Duration {
    // HTTP/2 uses a single connection for all concurrent requests
    client := buildH2CClient()

    start := time.Now()
    var wg sync.WaitGroup

    for i := 0; i < requests; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            resp, err := client.Get(fmt.Sprintf("%s/api/resource/%d", baseURL, n))
            if err != nil {
                return
            }
            io.Copy(io.Discard, resp.Body)
            resp.Body.Close()
        }(i)
    }

    wg.Wait()
    return time.Since(start)
}
```

## Section 3: Server Push (Deprecated but Documented)

HTTP/2 Server Push allowed servers to proactively send resources to clients. Go's `http2.Pusher` interface exposed this. However, Server Push was deprecated in Chrome 106 (2022) due to implementation complexity and limited real-world benefit.

```go
// Server Push — for historical reference only.
// Modern browsers have dropped support; use <link rel=preload> instead.

func pushHandler(w http.ResponseWriter, r *http.Request) {
    if pusher, ok := w.(http2.Pusher); ok {
        // Push a CSS file before the HTML response
        opts := &http2.PushOptions{
            Header: http.Header{
                "Content-Type": []string{"text/css"},
            },
        }
        if err := pusher.Push("/static/style.css", opts); err != nil {
            log.Printf("push failed: %v", err)
        }
    }

    // Send the HTML response
    w.Header().Set("Content-Type", "text/html")
    fmt.Fprintf(w, `<html><head><link rel="stylesheet" href="/static/style.css"></head><body>Hello</body></html>`)
}
```

The modern recommendation is to use HTTP `Link` headers with `rel=preload` instead:

```go
func modernPreloadHandler(w http.ResponseWriter, r *http.Request) {
    // Hint to the browser (and CDN) to preload resources
    w.Header().Add("Link", `</static/style.css>; rel=preload; as=style`)
    w.Header().Add("Link", `</static/app.js>; rel=preload; as=script`)

    w.Header().Set("Content-Type", "text/html")
    fmt.Fprintf(w, `<html><head>
        <link rel="stylesheet" href="/static/style.css">
        <script src="/static/app.js"></script>
    </head><body>Hello</body></html>`)
}
```

## Section 4: HTTP/3 with quic-go

HTTP/3 runs over QUIC, a UDP-based transport developed by Google. QUIC provides:
- 0-RTT connection establishment (on reconnect)
- Per-stream flow control (packet loss affects only the affected stream)
- Built-in TLS 1.3 (QUIC does not support TLS below 1.3)
- Connection migration (mobile devices can move between networks)

### Setting Up HTTP/3 with quic-go

```bash
# Install the quic-go library
go get github.com/quic-go/quic-go
go get github.com/quic-go/quic-go/http3
```

### HTTP/3 Server

```go
package main

import (
    "crypto/tls"
    "fmt"
    "log"
    "net/http"
    "time"

    "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
)

func buildHTTP3Server(certFile, keyFile string) (*http3.Server, error) {
    tlsCert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("loading TLS certificate: %w", err)
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{tlsCert},
        MinVersion:   tls.VersionTLS13, // HTTP/3 requires TLS 1.3
        NextProtos:   []string{"h3"},
    }

    quicConfig := &quic.Config{
        MaxIdleTimeout:  30 * time.Second,
        KeepAlivePeriod: 10 * time.Second,

        // Maximum number of concurrent bidirectional streams
        MaxIncomingStreams: 1000,

        // Maximum number of concurrent unidirectional streams
        MaxIncomingUniStreams: 100,

        // Initial receive window size (flow control)
        InitialStreamReceiveWindow:     1 << 20, // 1 MB
        InitialConnectionReceiveWindow: 1 << 23, // 8 MB

        // Enable 0-RTT for reconnecting clients
        Allow0RTT: true,
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        // Set Alt-Svc header to advertise HTTP/3 support
        w.Header().Set("Alt-Svc", `h3=":443"; ma=86400`)
        fmt.Fprintf(w, "Protocol: %s\n", r.Proto)
    })

    server := &http3.Server{
        Addr:       ":443",
        Handler:    mux,
        TLSConfig:  tlsConfig,
        QUICConfig: quicConfig,
    }

    return server, nil
}

func main() {
    // Run HTTP/2 and HTTP/3 servers simultaneously
    // HTTP/3 server (QUIC/UDP)
    h3Server, err := buildHTTP3Server("server.crt", "server.key")
    if err != nil {
        log.Fatalf("building HTTP/3 server: %v", err)
    }

    // HTTP/2 server (TCP) — serves clients that don't support QUIC yet
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        // Advertise HTTP/3 upgrade via Alt-Svc header
        h3Server.SetQUICHeaders(w.Header())
        fmt.Fprintf(w, "Protocol: %s\n", r.Proto)
    })

    h2Server := &http.Server{
        Addr:    ":443",
        Handler: mux,
        TLSConfig: &tls.Config{
            MinVersion: tls.VersionTLS13,
        },
    }

    // Start both servers
    go func() {
        log.Printf("Starting HTTP/3 server on UDP :443")
        if err := h3Server.ListenAndServeTLS("server.crt", "server.key"); err != nil {
            log.Fatalf("HTTP/3 server: %v", err)
        }
    }()

    log.Printf("Starting HTTP/2 server on TCP :443")
    log.Fatal(h2Server.ListenAndServeTLS("server.crt", "server.key"))
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
    "time"

    "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
)

func buildHTTP3Client(insecureSkipVerify bool) *http.Client {
    tlsConfig := &tls.Config{
        InsecureSkipVerify: insecureSkipVerify, // Only for testing!
        MinVersion:         tls.VersionTLS13,
        NextProtos:         []string{"h3"},
    }

    quicConfig := &quic.Config{
        MaxIdleTimeout:  30 * time.Second,
        KeepAlivePeriod: 10 * time.Second,
    }

    roundTripper := &http3.RoundTripper{
        TLSClientConfig: tlsConfig,
        QUICConfig:      quicConfig,

        // Dial function — optional for custom network configuration
        // Dial: func(...) (quic.EarlyConnection, error) {...},
    }

    return &http.Client{
        Transport: roundTripper,
        Timeout:   30 * time.Second,
    }
}

// HTTP/3 client that automatically upgrades from HTTP/1.1 or HTTP/2
// using the Alt-Svc response header
func buildHTTP3UpgradingClient() *http.Client {
    // Use a RoundTripper that tries HTTP/1.1 first, then upgrades
    // based on Alt-Svc headers
    roundTripper := &http3.RoundTripper{
        TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13},
    }

    // The http3.RoundTripper.RoundTrip method handles Alt-Svc-based upgrades
    return &http.Client{
        Transport: roundTripper,
    }
}

func main() {
    client := buildHTTP3Client(true) // true only for development self-signed certs
    defer client.Transport.(*http3.RoundTripper).Close()

    resp, err := client.Get("https://localhost:443/")
    if err != nil {
        log.Fatalf("request failed: %v", err)
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Printf("Status: %s\n", resp.Status)
    fmt.Printf("Protocol: %s\n", resp.Proto)
    fmt.Printf("Body: %s\n", body)
}
```

## Section 5: Multiplexing Benefits for Microservices

### Connection Multiplexing Architecture

```go
package multiplexing

import (
    "context"
    "crypto/tls"
    "net/http"
    "sync"
    "time"

    "golang.org/x/net/http2"
)

// ServiceClient provides an HTTP/2 client optimized for microservice communication
type ServiceClient struct {
    client   *http.Client
    baseURL  string
    mu       sync.RWMutex
    metrics  *ClientMetrics
}

// ClientMetrics tracks connection and request statistics
type ClientMetrics struct {
    ActiveRequests    int64
    ConnectionReuses  int64
    TotalRequests     int64
}

// NewServiceClient creates an HTTP/2 client for internal service communication
func NewServiceClient(baseURL string) *ServiceClient {
    // For internal services with h2c (no TLS)
    h2Transport := &http2.Transport{
        AllowHTTP: true,
        DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
            return (&net.Dialer{
                Timeout:   5 * time.Second,
                KeepAlive: 30 * time.Second,
            }).DialContext(ctx, network, addr)
        },

        // HTTP/2 connection settings
        MaxHeaderListSize: 1 << 20,            // 1 MB max header size
        PingTimeout:       15 * time.Second,    // How long to wait for PING response
        ReadIdleTimeout:   60 * time.Second,    // Send PING after this idle period
    }

    return &ServiceClient{
        baseURL: baseURL,
        client: &http.Client{
            Transport: h2Transport,
            Timeout:   30 * time.Second,
        },
    }
}

// FanOutRequests makes N concurrent requests and collects results.
// With HTTP/2, all requests share a single connection — no connection pool needed.
func (c *ServiceClient) FanOutRequests(ctx context.Context, paths []string) ([]*http.Response, error) {
    results := make([]*http.Response, len(paths))
    errors := make([]error, len(paths))

    var wg sync.WaitGroup
    for i, path := range paths {
        i, path := i, path
        wg.Add(1)
        go func() {
            defer wg.Done()
            req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
            if err != nil {
                errors[i] = err
                return
            }
            results[i], errors[i] = c.client.Do(req)
        }()
    }
    wg.Wait()

    // Return the first error encountered
    for _, err := range errors {
        if err != nil {
            return nil, err
        }
    }

    return results, nil
}
```

### HTTP/2 Stream Priority

HTTP/2 supports stream priority, allowing critical requests to be served before non-critical ones:

```go
package priority

import (
    "net/http"

    "golang.org/x/net/http2"
)

// PriorityAwareHandler adjusts processing order based on stream priority
func PriorityAwareHandler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Check if this is an HTTP/2 request
        if r.ProtoMajor == 2 {
            // In HTTP/2, stream priority is available via the http2.StreamID
            // High-priority requests should be processed first
            priority := r.Header.Get("X-Priority")
            if priority == "high" {
                // Process synchronously (no queuing)
                next.ServeHTTP(w, r)
                return
            }
        }

        next.ServeHTTP(w, r)
    })
}
```

## Section 6: TLS Configuration for H2 and H3

### Production TLS Configuration

```go
package tls_config

import (
    "crypto/tls"
    "crypto/x509"
    "os"
)

// BuildProductionTLSConfig creates a TLS configuration suitable for
// serving HTTP/2 and HTTP/3 in production.
func BuildProductionTLSConfig(certFile, keyFile string) (*tls.Config, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, err
    }

    return &tls.Config{
        // Certificates
        Certificates: []tls.Certificate{cert},

        // Minimum TLS version — HTTP/2 requires TLS 1.2, HTTP/3 requires TLS 1.3
        MinVersion: tls.VersionTLS12,

        // For pure HTTP/3 deployments, use:
        // MinVersion: tls.VersionTLS13,

        // Cipher suites for TLS 1.2 (TLS 1.3 ciphers are not configurable)
        CipherSuites: []uint16{
            tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
            tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
        },

        // Prefer server cipher order for security
        PreferServerCipherSuites: true,

        // ALPN protocol negotiation
        // For H2+H1.1 fallback:
        NextProtos: []string{"h2", "http/1.1"},
        // For H3+H2+H1.1:
        // NextProtos: []string{"h3", "h2", "http/1.1"},

        // Curve preferences — restrict to modern curves
        CurvePreferences: []tls.CurveID{
            tls.X25519,
            tls.CurveP256,
            tls.CurveP384,
        },

        // Session ticket rotation (important for forward secrecy)
        // By default Go rotates session tickets on startup only
        // For production, implement periodic rotation
        SessionTicketsDisabled: false,
    }, nil
}

// BuildMTLSConfig creates a configuration for mutual TLS authentication.
// Required for service-to-service authentication.
func BuildMTLSConfig(certFile, keyFile, caCertFile string) (*tls.Config, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, err
    }

    caCert, err := os.ReadFile(caCertFile)
    if err != nil {
        return nil, err
    }

    caPool := x509.NewCertPool()
    if !caPool.AppendCertsFromPEM(caCert) {
        return nil, fmt.Errorf("failed to parse CA certificate")
    }

    return &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientAuth:   tls.RequireAndVerifyClientCert,
        ClientCAs:    caPool,
        MinVersion:   tls.VersionTLS13,
        NextProtos:   []string{"h2", "http/1.1"},
    }, nil
}
```

### Dynamic Certificate Loading

For zero-downtime certificate rotation, use `GetCertificate` to load certificates dynamically:

```go
package certs

import (
    "crypto/tls"
    "sync"
    "time"
)

// DynamicCertStore loads and caches TLS certificates, refreshing them periodically.
type DynamicCertStore struct {
    mu       sync.RWMutex
    cert     *tls.Certificate
    certFile string
    keyFile  string
}

func NewDynamicCertStore(certFile, keyFile string) (*DynamicCertStore, error) {
    store := &DynamicCertStore{
        certFile: certFile,
        keyFile:  keyFile,
    }

    if err := store.reload(); err != nil {
        return nil, err
    }

    // Start background refresh goroutine
    go store.refreshLoop()

    return store, nil
}

func (s *DynamicCertStore) reload() error {
    cert, err := tls.LoadX509KeyPair(s.certFile, s.keyFile)
    if err != nil {
        return err
    }

    s.mu.Lock()
    s.cert = &cert
    s.mu.Unlock()
    return nil
}

func (s *DynamicCertStore) refreshLoop() {
    ticker := time.NewTicker(1 * time.Hour)
    defer ticker.Stop()

    for range ticker.C {
        if err := s.reload(); err != nil {
            log.Printf("certificate reload failed: %v", err)
        }
    }
}

// GetCertificate is called by the TLS stack for each new connection.
// By implementing this, we enable zero-downtime certificate rotation.
func (s *DynamicCertStore) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return s.cert, nil
}

// Usage
func buildServerWithDynamicCerts(certFile, keyFile string) (*http.Server, error) {
    store, err := NewDynamicCertStore(certFile, keyFile)
    if err != nil {
        return nil, err
    }

    tlsConfig := &tls.Config{
        GetCertificate: store.GetCertificate,
        MinVersion:     tls.VersionTLS13,
        NextProtos:     []string{"h2", "http/1.1"},
    }

    server := &http.Server{
        Addr:      ":8443",
        TLSConfig: tlsConfig,
    }

    return server, nil
}
```

## Section 7: Performance Benchmarking

### HTTP/1.1 vs HTTP/2 vs HTTP/3 Benchmark

```go
package benchmark

import (
    "fmt"
    "io"
    "net/http"
    "sync"
    "testing"
    "time"
)

func BenchmarkHTTP1Concurrent(b *testing.B) {
    client := &http.Client{
        Transport: &http.Transport{
            MaxIdleConnsPerHost: 10,
        },
    }

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            resp, err := client.Get("http://localhost:8080/api/ping")
            if err != nil {
                b.Error(err)
                continue
            }
            io.Copy(io.Discard, resp.Body)
            resp.Body.Close()
        }
    })
}

func BenchmarkHTTP2Concurrent(b *testing.B) {
    client := buildH2CClient()

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            resp, err := client.Get("http://localhost:8080/api/ping")
            if err != nil {
                b.Error(err)
                continue
            }
            io.Copy(io.Discard, resp.Body)
            resp.Body.Close()
        }
    })
}

// Typical benchmark results (requests/second):
// BenchmarkHTTP1Concurrent-8    5000    230000 ns/op    (connection overhead)
// BenchmarkHTTP2Concurrent-8    20000   55000 ns/op     (4x improvement from multiplexing)
//
// Results vary significantly based on:
// - Network latency (higher latency benefits more from multiplexing)
// - Payload size
// - Number of concurrent requests
// - TLS handshake overhead (0-RTT in HTTP/3 eliminates this on reconnect)
```

## Section 8: Production Deployment Considerations

### Kubernetes Service Configuration for HTTP/2

```yaml
# For HTTP/2 to work end-to-end through Kubernetes, the Service and Ingress
# must be configured appropriately.

---
# Service: use HTTPS backend so H2 is preserved to the pod
apiVersion: v1
kind: Service
metadata:
  name: my-h2-service
  annotations:
    # Tell load balancers (ALB, NGINX) to use HTTP/2 backend protocol
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "http"
    nginx.ingress.kubernetes.io/backend-protocol: "GRPC"  # For gRPC/H2 backends
spec:
  ports:
    - name: https
      port: 443
      targetPort: 8443
      protocol: TCP
    - name: http  # For h2c
      port: 80
      targetPort: 8080
      protocol: TCP
  selector:
    app: my-h2-service
---
# Ingress: configure for H2 backend protocol
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-h2-ingress
  annotations:
    # NGINX: configure H2 backend communication
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    nginx.ingress.kubernetes.io/http2-push-preload: "true"
    # Enable HTTP/3 with Alt-Svc header injection
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "Alt-Svc: h3=\":443\"; ma=86400";
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-secret
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-h2-service
                port:
                  number: 443
```

### Graceful Shutdown with HTTP/2 Active Streams

```go
// GracefulShutdown handles HTTP/2 graceful shutdown, which must drain
// active streams before closing the connection.
func GracefulShutdown(server *http.Server, timeout time.Duration) error {
    // Signal the client via GOAWAY frame that no new streams are accepted
    // The client will open a new connection for any new requests
    shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
    defer cancel()

    // Shutdown waits for active connections to close
    // For HTTP/2, this means waiting for all active streams to complete
    if err := server.Shutdown(shutdownCtx); err != nil {
        if err == context.DeadlineExceeded {
            log.Printf("Graceful shutdown timed out; forcing close")
            return server.Close()
        }
        return err
    }

    return nil
}
```

## Conclusion

Go's net/http package provides first-class HTTP/2 support with zero configuration for HTTPS servers. h2c enables HTTP/2 for internal microservice communication without TLS overhead. HTTP/3 with quic-go brings QUIC's improved packet loss resilience and 0-RTT connection establishment to Go services, particularly valuable for geographically distributed deployments or mobile API clients. The multiplexing benefits of HTTP/2 are most pronounced in high-concurrency scenarios — microservices making many parallel downstream calls see the greatest improvements, often reducing P99 latency by 40-60% compared to HTTP/1.1 with equivalent connection pools.
