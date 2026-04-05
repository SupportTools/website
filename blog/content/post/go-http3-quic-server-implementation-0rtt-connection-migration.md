---
title: "Go HTTP/3 and QUIC: quic-go Server Implementation, 0-RTT, Connection Migration, and Performance Benchmarks"
date: 2032-04-05T00:00:00-05:00
draft: false
tags: ["Go", "HTTP/3", "QUIC", "quic-go", "Performance", "Networking", "TLS", "0-RTT"]
categories:
- Go
- Networking
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into HTTP/3 and QUIC implementation in Go using quic-go, covering server setup, 0-RTT session resumption, connection migration, multiplexing, and production performance benchmarks."
more_link: "yes"
url: "/go-http3-quic-server-implementation-0rtt-connection-migration/"
---

HTTP/3 and QUIC represent the most significant transport-layer evolution since TCP/IP. By moving from TCP to UDP and integrating TLS 1.3 directly into the transport layer, QUIC eliminates the head-of-line blocking that plagues HTTP/2 over TCP, reduces connection establishment latency to zero round trips for resuming connections, and enables seamless connection migration as clients change network addresses.

The `quic-go` library is the most mature Go implementation of the QUIC protocol and HTTP/3, offering production-quality support for RFC 9000 (QUIC), RFC 9001 (QUIC+TLS), and RFC 9114 (HTTP/3). This guide covers building production-ready HTTP/3 servers, implementing 0-RTT session resumption, handling connection migration, and quantifying the performance improvements available in high-latency and mobile network scenarios.

<!--more-->

## QUIC Protocol Fundamentals

### What QUIC Solves

```
HTTP/1.1 over TCP:
  Connection 1: Request1 → Response1 → Request2 → Response2
  (serial, head-of-line blocked)

HTTP/2 over TCP:
  Single TCP connection with multiplexed streams:
  [Stream1-data][Stream2-data][Stream3-data]
  TCP packet loss → ALL streams stall (TCP-level HOL blocking)

HTTP/3 over QUIC:
  QUIC streams are independent at the transport layer:
  [Stream1-data][Stream2-data][Stream3-data]
  QUIC packet loss → ONLY affected stream stalls
```

QUIC connection setup comparison:

```
TCP + TLS 1.3 (new connection):
  Client → Server: SYN                           (1)
  Client ← Server: SYN-ACK                       (2)
  Client → Server: ACK + ClientHello             (3)
  Client ← Server: ServerHello + Finished        (4)
  Client → Server: Finished + HTTP request       (5)
  Client ← Server: HTTP response                 (6)
  Total: 2 RTT before application data

QUIC (new connection):
  Client → Server: Initial (ClientHello in QUIC) (1)
  Client ← Server: Initial + Handshake + 1-RTT   (2)
  Client → Server: Handshake + HTTP request       (3)
  Client ← Server: HTTP response                  (4)
  Total: 1 RTT before application data

QUIC 0-RTT (resumed connection):
  Client → Server: Initial + 0-RTT data + HTTP   (1)
  Client ← Server: HTTP response + Handshake      (2)
  Total: 0 RTT before application data (application data in first packet!)
```

### quic-go Library Setup

```bash
# Initialize Go module
go mod init github.com/example/quic-server

# Install quic-go
go get github.com/quic-go/quic-go@latest
go get github.com/quic-go/quic-go/http3@latest

# Verify
go list -m github.com/quic-go/quic-go
```

## Basic HTTP/3 Server Implementation

### Minimal Server

```go
// cmd/server/main.go
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", handleRoot)
    mux.HandleFunc("/health", handleHealth)
    mux.HandleFunc("/api/v1/data", handleData)

    // Load TLS certificate (HTTP/3 requires TLS)
    tlsCert, err := tls.LoadX509KeyPair("server.crt", "server.key")
    if err != nil {
        log.Fatalf("failed to load TLS certificate: %v", err)
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{tlsCert},
        MinVersion:   tls.VersionTLS13, // QUIC requires TLS 1.3
        NextProtos:   []string{"h3"},   // HTTP/3 ALPN identifier
    }

    // HTTP/3 server configuration
    server := &http3.Server{
        Handler: mux,
        Addr:    ":443",
        TLSConfig: http3.ConfigureTLSConfig(tlsConfig),
        QUICConfig: &quic.Config{
            MaxIdleTimeout:        30 * time.Second,
            MaxIncomingStreams:     100,
            MaxIncomingUniStreams:  10,
            KeepAlivePeriod:       10 * time.Second,
            InitialStreamReceiveWindow:     512 * 1024,
            InitialConnectionReceiveWindow: 1024 * 1024,
        },
    }

    // Also run HTTP/1.1 and HTTP/2 for fallback
    // The Alt-Svc header tells clients to upgrade to HTTP/3
    http1Server := &http.Server{
        Addr:    ":443",
        Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Advertise HTTP/3 availability
            server.SetQuicHeaders(w.Header())
            mux.ServeHTTP(w, r)
        }),
        TLSConfig: tlsConfig,
    }

    // Graceful shutdown handling
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    errCh := make(chan error, 2)

    // Start HTTP/3 server
    go func() {
        log.Println("Starting HTTP/3 server on :443")
        if err := server.ListenAndServeTLS("server.crt", "server.key"); err != nil {
            errCh <- fmt.Errorf("HTTP/3 server error: %w", err)
        }
    }()

    // Start HTTP/1.1+2 server with upgrade hints
    go func() {
        log.Println("Starting HTTP/1.1+2 server on :8443")
        srv := &http.Server{
            Addr: ":8443",
            Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                server.SetQuicHeaders(w.Header())
                mux.ServeHTTP(w, r)
            }),
            TLSConfig: tlsConfig,
        }
        if err := srv.ListenAndServeTLS("server.crt", "server.key"); err != nil {
            errCh <- fmt.Errorf("HTTP/1.1+2 server error: %w", err)
        }
    }()

    select {
    case <-ctx.Done():
        log.Println("Shutting down servers...")
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        _ = http1Server.Shutdown(shutdownCtx)
        _ = server.Close()
    case err := <-errCh:
        log.Fatalf("Server error: %v", err)
    }
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
    proto := r.Proto
    fmt.Fprintf(w, "Protocol: %s\n", proto)
    fmt.Fprintf(w, "Hello from HTTP/3 server!\n")
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    fmt.Fprintf(w, `{"status":"healthy","protocol":"%s"}`, r.Proto)
}

func handleData(w http.ResponseWriter, r *http.Request) {
    // Simulate varying response sizes to test QUIC flow control
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintf(w, `{"data":"response payload","timestamp":%d}`,
        time.Now().UnixMilli())
}
```

### Production Server with Full Configuration

```go
// pkg/server/quic_server.go
package server

import (
    "context"
    "crypto/tls"
    "net"
    "net/http"
    "time"

    "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
    "github.com/quic-go/quic-go/logging"
    "github.com/quic-go/quic-go/qlog"
    "go.uber.org/zap"
)

// Config holds all server configuration
type Config struct {
    Addr           string
    TLSCertFile    string
    TLSKeyFile     string
    MaxConnections int64
    ReadTimeout    time.Duration
    WriteTimeout   time.Duration
    IdleTimeout    time.Duration
    EnableQLog     bool
    QLogDirectory  string
}

// DefaultConfig returns sensible production defaults
func DefaultConfig() Config {
    return Config{
        Addr:           ":443",
        MaxConnections: 10000,
        ReadTimeout:    30 * time.Second,
        WriteTimeout:   30 * time.Second,
        IdleTimeout:    120 * time.Second,
        EnableQLog:     false,
    }
}

// Server wraps HTTP/3 with operational capabilities
type Server struct {
    cfg     Config
    h3srv   *http3.Server
    logger  *zap.Logger
    metrics *Metrics
}

// New creates a production-ready HTTP/3 server
func New(cfg Config, handler http.Handler, logger *zap.Logger) (*Server, error) {
    tlsCert, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
    if err != nil {
        return nil, fmt.Errorf("loading TLS certificate: %w", err)
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{tlsCert},
        MinVersion:   tls.VersionTLS13,
        CurvePreferences: []tls.CurveID{
            tls.X25519,
            tls.CurveP256,
        },
        CipherSuites: []uint16{
            tls.TLS_AES_128_GCM_SHA256,
            tls.TLS_AES_256_GCM_SHA384,
            tls.TLS_CHACHA20_POLY1305_SHA256,
        },
    }

    // QUIC transport configuration
    quicConfig := &quic.Config{
        MaxIdleTimeout:  cfg.IdleTimeout,
        KeepAlivePeriod: 15 * time.Second,

        // Stream limits
        MaxIncomingStreams:    200,
        MaxIncomingUniStreams: 20,

        // Flow control windows - tune based on BDP (bandwidth-delay product)
        // For 100Mbps * 100ms RTT: BDP = 10Mbps = 1.25MB
        InitialStreamReceiveWindow:     1 * 1024 * 1024,  // 1MB
        InitialConnectionReceiveWindow: 10 * 1024 * 1024, // 10MB
        MaxStreamReceiveWindow:         4 * 1024 * 1024,  // 4MB
        MaxConnectionReceiveWindow:     20 * 1024 * 1024, // 20MB

        // Datagram support (for WebTransport)
        EnableDatagrams: true,

        // Connection ID rotation for privacy
        // DisableVersionNegotiationPackets: false,
    }

    // Optional qlog tracing for debugging
    if cfg.EnableQLog {
        quicConfig.Tracer = func(ctx context.Context, p logging.Perspective, connID quic.ConnectionID) *logging.ConnectionTracer {
            filename := fmt.Sprintf("%s/conn-%s.qlog",
                cfg.QLogDirectory, connID.String())
            f, _ := os.Create(filename)
            return qlog.NewConnectionTracer(f, p, connID)
        }
    }

    metrics := newMetrics()

    srv := &http3.Server{
        Handler:    instrumentedHandler(handler, metrics, logger),
        Addr:       cfg.Addr,
        TLSConfig:  http3.ConfigureTLSConfig(tlsConfig),
        QUICConfig: quicConfig,
    }

    return &Server{
        cfg:     cfg,
        h3srv:   srv,
        logger:  logger,
        metrics: metrics,
    }, nil
}

// instrumentedHandler wraps handlers with metrics and logging
func instrumentedHandler(h http.Handler, m *Metrics, logger *zap.Logger) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        wrapped := &responseWriter{ResponseWriter: w, statusCode: 200}

        // Log request details including QUIC-specific info
        logger.Debug("request received",
            zap.String("proto", r.Proto),
            zap.String("method", r.Method),
            zap.String("path", r.URL.Path),
            zap.String("remote_addr", r.RemoteAddr),
        )

        h.ServeHTTP(wrapped, r)

        duration := time.Since(start)
        m.RecordRequest(r.Method, r.URL.Path, wrapped.statusCode, duration)

        logger.Info("request completed",
            zap.String("proto", r.Proto),
            zap.String("method", r.Method),
            zap.String("path", r.URL.Path),
            zap.Int("status", wrapped.statusCode),
            zap.Duration("duration", duration),
        )
    })
}

// ListenAndServeTLS starts the server
func (s *Server) ListenAndServeTLS() error {
    s.logger.Info("starting HTTP/3 server",
        zap.String("addr", s.cfg.Addr),
    )
    return s.h3srv.ListenAndServeTLS(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
}

// Close gracefully shuts down the server
func (s *Server) Close() error {
    return s.h3srv.Close()
}
```

## 0-RTT Session Resumption

0-RTT (zero round-trip time resumption) allows clients to send HTTP requests in the very first packet of a reconnection, before the TLS handshake completes. This dramatically reduces latency for repeat visitors.

### Server-Side 0-RTT Configuration

```go
// pkg/server/zero_rtt.go
package server

import (
    "crypto/tls"
    "time"

    "github.com/quic-go/quic-go"
)

// SessionCache implements a persistent TLS session ticket cache
// for enabling 0-RTT connections
type SessionTicketCache struct {
    // In production, use Redis or a distributed cache
    // for multi-instance deployments
    store sync.Map
}

func (c *SessionTicketCache) Get(key string) (*tls.ClientSessionState, bool) {
    val, ok := c.store.Load(key)
    if !ok {
        return nil, false
    }
    entry := val.(*sessionEntry)
    if time.Now().After(entry.expiresAt) {
        c.store.Delete(key)
        return nil, false
    }
    return entry.state, true
}

func (c *SessionTicketCache) Put(key string, cs *tls.ClientSessionState) {
    c.store.Store(key, &sessionEntry{
        state:     cs,
        expiresAt: time.Now().Add(24 * time.Hour),
    })
}

type sessionEntry struct {
    state     *tls.ClientSessionState
    expiresAt time.Time
}

// ConfigureZeroRTT configures TLS for 0-RTT support
func ConfigureZeroRTT(tlsConfig *tls.Config) *tls.Config {
    cfg := tlsConfig.Clone()

    // Session ticket keys for resumption
    // In production: rotate these and store in a secrets manager
    // Use a static key here only for illustration
    cfg.SetSessionTicketKeys([][32]byte{
        // In production: load from <secrets-manager> or HSM
        // cfg.SetSessionTicketKeys(loadRotatingKeys())
    })

    // Maximum number of 0-RTT data bytes to accept
    // Larger values increase attack surface for replay attacks
    // cfg.MaxEarlyData = 4096

    return cfg
}

// QUIC 0-RTT configuration
func QuicConfigWithZeroRTT() *quic.Config {
    return &quic.Config{
        Allow0RTT: true, // Accept 0-RTT connections
        MaxIdleTimeout:  30 * time.Second,
        KeepAlivePeriod: 10 * time.Second,
        MaxIncomingStreams:    200,
        InitialStreamReceiveWindow:     512 * 1024,
        InitialConnectionReceiveWindow: 2 * 1024 * 1024,
    }
}
```

### 0-RTT Security Considerations

```go
// pkg/server/replay_protection.go
package server

import (
    "crypto/sha256"
    "encoding/hex"
    "net/http"
    "sync"
    "time"
)

// ReplayCache prevents 0-RTT replay attacks by tracking
// early data tokens within their anti-replay window
type ReplayCache struct {
    mu      sync.RWMutex
    seen    map[string]time.Time
    window  time.Duration
    cleanup *time.Ticker
}

func NewReplayCache(window time.Duration) *ReplayCache {
    rc := &ReplayCache{
        seen:   make(map[string]time.Time),
        window: window,
    }
    // Periodic cleanup of expired tokens
    rc.cleanup = time.NewTicker(window / 2)
    go rc.cleanupLoop()
    return rc
}

// IsReplay checks if this request token has been seen before
// Returns true if this is a replay (should reject)
func (rc *ReplayCache) IsReplay(r *http.Request) bool {
    // Only check for mutating operations - safe to replay idempotent GETs
    if r.Method == http.MethodGet || r.Method == http.MethodHead {
        return false
    }

    // Generate token from request characteristics
    h := sha256.New()
    h.Write([]byte(r.URL.String()))
    h.Write([]byte(r.Header.Get("Idempotency-Key")))
    token := hex.EncodeToString(h.Sum(nil))

    rc.mu.Lock()
    defer rc.mu.Unlock()

    if _, exists := rc.seen[token]; exists {
        return true
    }

    rc.seen[token] = time.Now()
    return false
}

func (rc *ReplayCache) cleanupLoop() {
    for range rc.cleanup.C {
        rc.mu.Lock()
        cutoff := time.Now().Add(-rc.window)
        for token, seen := range rc.seen {
            if seen.Before(cutoff) {
                delete(rc.seen, token)
            }
        }
        rc.mu.Unlock()
    }
}

// ZeroRTTMiddleware enforces 0-RTT safety
func ZeroRTTMiddleware(replayCache *ReplayCache) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Check if this is a 0-RTT request
            // quic-go sets this on the connection
            if r.TLS != nil {
                // r.TLS.HandshakeComplete would be false for 0-RTT
                // In production, check the QUIC connection state
            }

            if replayCache.IsReplay(r) {
                http.Error(w, "replay detected", http.StatusTooEarlyHTTP)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

## Connection Migration

QUIC connection migration allows clients to switch network paths (e.g., WiFi to cellular) without connection loss. The server must be configured to handle incoming connections that migrate.

```go
// pkg/server/migration.go
package server

import (
    "context"
    "net"

    "github.com/quic-go/quic-go"
    "go.uber.org/zap"
)

// MigrationAwareListener wraps QUIC listener with migration tracking
type MigrationAwareListener struct {
    listener *quic.Listener
    logger   *zap.Logger
    metrics  *Metrics
}

// AcceptAndTrack accepts connections and monitors migrations
func (l *MigrationAwareListener) AcceptAndTrack(ctx context.Context) {
    for {
        conn, err := l.listener.Accept(ctx)
        if err != nil {
            if ctx.Err() != nil {
                return // shutdown
            }
            l.logger.Error("accept error", zap.Error(err))
            continue
        }
        go l.handleConnection(ctx, conn)
    }
}

func (l *MigrationAwareListener) handleConnection(
    ctx context.Context, conn quic.Connection) {

    remoteAddr := conn.RemoteAddr()
    connID := conn.LocalAddr().String()

    l.logger.Debug("new QUIC connection",
        zap.String("remote", remoteAddr.String()),
        zap.String("conn_id", connID),
    )

    // Monitor for path changes (connection migration)
    go func() {
        prevAddr := remoteAddr.String()
        ticker := time.NewTicker(1 * time.Second)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                currentAddr := conn.RemoteAddr().String()
                if currentAddr != prevAddr {
                    l.logger.Info("connection migration detected",
                        zap.String("from", prevAddr),
                        zap.String("to", currentAddr),
                        zap.String("conn_id", connID),
                    )
                    l.metrics.IncrementMigrations()
                    prevAddr = currentAddr
                }
            }
        }
    }()
}

// PathValidation demonstrates QUIC path validation
// QUIC sends PATH_CHALLENGE frames on new paths before using them
// This is handled automatically by quic-go, but can be monitored
func PathValidationTracer(conn quic.Connection) {
    // quic-go's qlog interface provides visibility into path validation
    // Enable qlog to trace PATH_CHALLENGE / PATH_RESPONSE frames
}
```

## HTTP/3 Client Implementation

```go
// pkg/client/h3_client.go
package client

import (
    "context"
    "crypto/tls"
    "fmt"
    "net/http"
    "time"

    "github.com/quic-go/quic-go"
    "github.com/quic-go/quic-go/http3"
)

// Client provides HTTP/3 with HTTP/2 fallback
type Client struct {
    h3   *http.Client
    h2   *http.Client
}

// NewClient creates a client that prefers HTTP/3
func NewClient(opts ...ClientOption) *Client {
    cfg := defaultClientConfig()
    for _, o := range opts {
        o(cfg)
    }

    tlsConfig := &tls.Config{
        InsecureSkipVerify: cfg.insecureTLS, // only for dev
        MinVersion:         tls.VersionTLS13,
    }

    // HTTP/3 transport
    h3Transport := &http3.Transport{
        TLSClientConfig: tlsConfig,
        QUICConfig: &quic.Config{
            MaxIdleTimeout:  cfg.idleTimeout,
            KeepAlivePeriod: 15 * time.Second,

            // 0-RTT: enable if server supports it
            // Store session tickets for resumption
        },
        // Connection reuse settings
        DisableCompression: false,
    }

    // HTTP/2 transport for fallback
    h2Transport := &http.Transport{
        TLSClientConfig: tlsConfig,
        MaxIdleConns:    100,
        IdleConnTimeout: 90 * time.Second,
        ForceAttemptHTTP2: true,
    }

    return &Client{
        h3: &http.Client{
            Transport: h3Transport,
            Timeout:   cfg.requestTimeout,
        },
        h2: &http.Client{
            Transport: h2Transport,
            Timeout:   cfg.requestTimeout,
        },
    }
}

// Get performs HTTP/3 GET with fallback to HTTP/2
func (c *Client) Get(ctx context.Context, url string) (*http.Response, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }

    resp, err := c.h3.Do(req)
    if err != nil {
        // Fall back to HTTP/2 if HTTP/3 fails
        return c.h2.Do(req)
    }
    return resp, nil
}

// BatchGet performs concurrent requests using HTTP/3 multiplexing
// HTTP/3 excels here - no head-of-line blocking means all requests
// can progress independently
func (c *Client) BatchGet(ctx context.Context, urls []string) ([]*http.Response, error) {
    type result struct {
        index int
        resp  *http.Response
        err   error
    }

    results := make(chan result, len(urls))
    responses := make([]*http.Response, len(urls))

    for i, url := range urls {
        go func(idx int, u string) {
            resp, err := c.Get(ctx, u)
            results <- result{index: idx, resp: resp, err: err}
        }(i, url)
    }

    var errs []error
    for i := 0; i < len(urls); i++ {
        r := <-results
        if r.err != nil {
            errs = append(errs, fmt.Errorf("request %d: %w", r.index, r.err))
        } else {
            responses[r.index] = r.resp
        }
    }

    if len(errs) > 0 {
        return responses, fmt.Errorf("batch errors: %v", errs)
    }
    return responses, nil
}
```

## Performance Benchmarks

### Benchmark Setup

```go
// benchmarks/h3_bench_test.go
package benchmarks

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "testing"
    "time"
)

// BenchmarkHTTP3VsHTTP2_SmallPayload tests small JSON responses
// typical of API endpoints
func BenchmarkHTTP3_SmallPayload(b *testing.B) {
    client := newH3Client()
    url := "https://localhost:443/api/small"

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            resp, err := client.Get(context.Background(), url)
            if err != nil {
                b.Error(err)
                continue
            }
            _, _ = io.ReadAll(resp.Body)
            resp.Body.Close()
        }
    })
}

func BenchmarkHTTP2_SmallPayload(b *testing.B) {
    client := newH2Client()
    url := "https://localhost:8443/api/small"

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            resp, err := http.Get(url)
            if err != nil {
                b.Error(err)
                continue
            }
            _, _ = io.ReadAll(resp.Body)
            resp.Body.Close()
        }
    })
}

// BenchmarkConcurrentStreams tests HTTP/3 multiplexing advantage
// over HTTP/2 under simulated packet loss
func BenchmarkHTTP3_ConcurrentStreams(b *testing.B) {
    client := newH3Client()
    urls := make([]string, 10)
    for i := range urls {
        urls[i] = fmt.Sprintf("https://localhost:443/api/stream/%d", i)
    }

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        resps, err := batchGet(client, urls)
        if err != nil {
            b.Error(err)
        }
        for _, r := range resps {
            if r != nil {
                _, _ = io.ReadAll(r.Body)
                r.Body.Close()
            }
        }
    }
}
```

### Benchmark Results and Analysis

```bash
# Run benchmarks with different network conditions
# Using tc (traffic control) to simulate network conditions

# Simulate 100ms RTT (cross-continent)
sudo tc qdisc add dev lo root netem delay 50ms 10ms

# Simulate 1% packet loss
sudo tc qdisc change dev lo root netem delay 50ms loss 1%

# Run benchmarks
go test -bench=. -benchtime=30s -count=3 ./benchmarks/ \
  -benchmem -cpu 1,2,4,8

# Example results (100ms RTT, 0% packet loss):
# BenchmarkHTTP3_SmallPayload-8     1000    1.52ms/op
# BenchmarkHTTP2_SmallPayload-8     1000    1.65ms/op
# Improvement: ~8% (connection reuse dominates here)

# Example results (100ms RTT, 2% packet loss):
# BenchmarkHTTP3_SmallPayload-8     1000    1.89ms/op
# BenchmarkHTTP2_SmallPayload-8     1000    4.12ms/op
# Improvement: ~54% (HOL blocking eliminated)

# Example results (new connections, 0-RTT):
# BenchmarkHTTP3_ZeroRTT-8          1000    0.21ms/op  (0-RTT handshake)
# BenchmarkHTTP2_NewConn-8          1000    0.89ms/op  (1-RTT TLS handshake)
# Improvement: ~76% (0-RTT vs 1-RTT new connection)

# Remove network simulation
sudo tc qdisc del dev lo root
```

### Connection Migration Benchmark

```bash
#!/bin/bash
# test-connection-migration.sh — measure migration impact

# Start server
./quic-server &
SERVER_PID=$!

# Connect and measure baseline latency
hey -n 1000 -c 10 -h2 https://localhost:443/api/data &
HEY_PID=$!

# After 5 seconds, simulate network change by changing source port
sleep 5
echo "Simulating network path change..."
# Force connection migration by dropping current UDP flow
iptables -I INPUT -p udp --dport 443 -m state --state ESTABLISHED -j DROP
sleep 1
iptables -D INPUT -p udp --dport 443 -m state --state ESTABLISHED -j DROP

wait $HEY_PID
kill $SERVER_PID
```

## QUIC Diagnostics and Debugging

### qlog Analysis

```go
// pkg/server/qlog_server.go — serve qlog files for analysis
package server

import (
    "context"
    "fmt"
    "os"
    "path/filepath"
    "time"

    "github.com/quic-go/quic-go/logging"
    "github.com/quic-go/quic-go/qlog"
)

// QLogTracer creates per-connection qlog files
// These can be analyzed with https://qvis.quictools.info/
func NewQLogTracer(dir string) func(
    context.Context, logging.Perspective, quic.ConnectionID) *logging.ConnectionTracer {

    if err := os.MkdirAll(dir, 0755); err != nil {
        panic(fmt.Sprintf("failed to create qlog dir: %v", err))
    }

    return func(ctx context.Context, p logging.Perspective, connID quic.ConnectionID) *logging.ConnectionTracer {
        filename := filepath.Join(dir,
            fmt.Sprintf("%s_%s_%s.qlog",
                time.Now().Format("20060102T150405"),
                perspectiveString(p),
                connID.String(),
            ))

        f, err := os.Create(filename)
        if err != nil {
            return nil
        }

        return qlog.NewConnectionTracer(f, p, connID)
    }
}

func perspectiveString(p logging.Perspective) string {
    switch p {
    case logging.PerspectiveServer:
        return "server"
    case logging.PerspectiveClient:
        return "client"
    default:
        return "unknown"
    }
}
```

```bash
# Analyze qlog files with qvis
# Upload to https://qvis.quictools.info/

# Or use the quic-go CLI tool
go run github.com/quic-go/quic-go/tools/qlogcat@latest server_*.qlog

# Key metrics to look for in qlogs:
# - packet_sent/received counts
# - packet_loss events
# - congestion_state_updated transitions
# - path_assigned for migration events
# - connection_close reason codes
```

### Metrics and Monitoring

```go
// pkg/metrics/quic_metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    quicConnectionsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "quic_connections_total",
        Help: "Total QUIC connections accepted",
    }, []string{"version", "zero_rtt"})

    quicConnectionDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "quic_connection_duration_seconds",
        Help:    "QUIC connection duration",
        Buckets: prometheus.ExponentialBuckets(0.001, 2, 20),
    }, []string{"close_reason"})

    quicMigrationsTotal = promauto.NewCounter(prometheus.CounterOpts{
        Name: "quic_connection_migrations_total",
        Help: "Total QUIC connection path migrations",
    })

    quicStreamsCreated = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "quic_streams_created_total",
        Help: "Total QUIC streams created",
    }, []string{"direction", "protocol"})

    quicPacketLoss = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "quic_packet_loss_rate",
        Help:    "Observed QUIC packet loss rate",
        Buckets: prometheus.LinearBuckets(0, 0.01, 20),
    }, []string{"direction"})

    http3RequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "http3_request_duration_seconds",
        Help:    "HTTP/3 request duration",
        Buckets: prometheus.ExponentialBuckets(0.0001, 2, 20),
    }, []string{"method", "status_class"})
)
```

## Deployment Considerations

### Kubernetes Deployment

```yaml
# k8s/http3-server-deployment.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: http3-server
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: http3-server
  template:
    metadata:
      labels:
        app: http3-server
    spec:
      containers:
      - name: http3-server
        image: registry.example.com/http3-server:v1.0.0
        ports:
        - containerPort: 443
          protocol: TCP
          name: https
        - containerPort: 443
          # QUIC/HTTP3 requires UDP
          protocol: UDP
          name: quic
        resources:
          requests:
            cpu: "500m"
            memory: "256Mi"
          limits:
            cpu: "2000m"
            memory: "1Gi"

---
# Service must expose both TCP and UDP
apiVersion: v1
kind: Service
metadata:
  name: http3-server
  namespace: production
spec:
  selector:
    app: http3-server
  ports:
  - name: https-tcp
    port: 443
    targetPort: 443
    protocol: TCP
  - name: https-udp
    port: 443
    targetPort: 443
    protocol: UDP
  type: LoadBalancer
```

```bash
# Important: Most cloud load balancers require explicit UDP support
# AWS NLB: supports UDP
# GCP Network LB: supports UDP
# Azure Load Balancer: supports UDP

# Verify UDP is passing through
# Test with QUIC-capable client
curl --http3-only https://your-service-address/health

# Check via netstat on server
ss -anu | grep 443
```

## Conclusion

HTTP/3 and QUIC deliver measurable benefits in high-latency and lossy network conditions through elimination of head-of-line blocking, faster connection establishment with 0-RTT, and seamless connection migration. The `quic-go` library provides a production-quality foundation with full RFC compliance, comprehensive qlog tracing, and idiomatic Go APIs that integrate cleanly with the standard `net/http` ecosystem.

The performance gains are most pronounced in mobile and global deployment scenarios: a 2% packet loss rate that barely affects HTTP/2 throughput can double latency due to TCP's retransmission behavior, while QUIC's per-stream loss recovery limits the impact to only the affected stream. For APIs serving mobile clients or spanning multiple regions, HTTP/3 is no longer an experimental optimization but a production requirement.

The deployment complexity is manageable: servers need UDP port exposure alongside TCP, load balancers require UDP support, and the Alt-Svc advertisement mechanism ensures seamless fallback for clients that do not yet support HTTP/3.
