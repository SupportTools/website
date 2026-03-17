---
title: "Go HTTP Client Best Practices: Connection Pooling and Request Lifecycle"
date: 2029-10-17T00:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Performance", "Connection Pooling", "httptrace", "Networking"]
categories: ["Go", "Performance", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go HTTP client transport configuration, MaxIdleConnsPerHost, keep-alive tuning, request and response body handling, request tracing with httptrace, and the full timeout hierarchy for production services."
more_link: "yes"
url: "/go-http-client-connection-pooling-request-lifecycle/"
---

The Go standard library's `net/http` package ships with a production-capable HTTP client, but its default configuration is optimized for correctness and compatibility rather than performance or reliability under sustained load. In a microservices architecture where a single service makes thousands of outbound requests per second, understanding every knob on the transport layer is the difference between a stable service and one that leaks connections, exhausts file descriptors, or times out unpredictably.

<!--more-->

# Go HTTP Client Best Practices: Connection Pooling and Request Lifecycle

## Section 1: Why the Default Client Is Wrong for Production

The zero-value `http.Client{}` uses `http.DefaultTransport`, which has these defaults:

```go
var DefaultTransport RoundTripper = &Transport{
    Proxy:                 ProxyFromEnvironment,
    DialContext:           defaultTransportDialContext(&net.Dialer{
        Timeout:   30 * time.Second,
        KeepAlive: 30 * time.Second,
    }),
    ForceAttemptHTTP2:     true,
    MaxIdleConns:          100,
    IdleConnTimeout:       90 * time.Second,
    TLSHandshakeTimeout:   10 * time.Second,
    ExpectContinueTimeout: 1 * time.Second,
}
```

The problems for a production microservice:

1. `MaxIdleConns: 100` is a global pool. If you talk to 20 backends, each gets at most 5 idle connections.
2. `MaxIdleConnsPerHost` defaults to 2 — catastrophically low for any high-RPS target host.
3. There is no `ResponseHeaderTimeout`, so a slow server that accepts the connection but never sends headers will hold your goroutine indefinitely (limited only by the context deadline you attach).
4. Using `http.DefaultClient` or `http.DefaultTransport` is shared across all packages in your binary. Any library that also uses the default client contends with your connection pool.

## Section 2: Transport Configuration for High-Throughput Services

Start with a custom transport. Every field has a reason.

```go
package httpclient

import (
    "crypto/tls"
    "net"
    "net/http"
    "time"
)

// NewTransport returns a Transport configured for a service that makes
// sustained, high-volume requests to a small set of backend hosts.
func NewTransport(cfg TransportConfig) *http.Transport {
    dialer := &net.Dialer{
        Timeout:   cfg.DialTimeout,        // TCP SYN → SYN-ACK
        KeepAlive: cfg.TCPKeepAlive,       // TCP keepalive probe interval
        DualStack: true,
    }

    return &http.Transport{
        DialContext:            dialer.DialContext,
        MaxIdleConns:           cfg.MaxIdleConns,
        MaxIdleConnsPerHost:    cfg.MaxIdleConnsPerHost,
        MaxConnsPerHost:        cfg.MaxConnsPerHost,    // 0 = unlimited
        IdleConnTimeout:        cfg.IdleConnTimeout,
        TLSHandshakeTimeout:    cfg.TLSHandshakeTimeout,
        ResponseHeaderTimeout:  cfg.ResponseHeaderTimeout,
        ExpectContinueTimeout:  1 * time.Second,
        DisableCompression:     false,
        ForceAttemptHTTP2:      true,
        TLSClientConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
        },
        // WriteBufferSize and ReadBufferSize default to 4096 bytes.
        // Increase for bulk upload/download services.
        WriteBufferSize: 32 * 1024,
        ReadBufferSize:  32 * 1024,
    }
}

type TransportConfig struct {
    DialTimeout           time.Duration
    TCPKeepAlive          time.Duration
    MaxIdleConns          int
    MaxIdleConnsPerHost   int
    MaxConnsPerHost       int
    IdleConnTimeout       time.Duration
    TLSHandshakeTimeout   time.Duration
    ResponseHeaderTimeout time.Duration
}

// DefaultTransportConfig returns conservative but production-appropriate defaults.
func DefaultTransportConfig() TransportConfig {
    return TransportConfig{
        DialTimeout:           5 * time.Second,
        TCPKeepAlive:          30 * time.Second,
        MaxIdleConns:          1000,
        MaxIdleConnsPerHost:   100,
        MaxConnsPerHost:       200,
        IdleConnTimeout:       60 * time.Second,
        TLSHandshakeTimeout:   5 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second,
    }
}
```

### MaxIdleConnsPerHost: The Most Important Knob

This controls how many idle (keep-alive) connections the transport maintains per target host. An "idle" connection is one that has completed a request but is being held open for reuse.

```
Rule of thumb:
MaxIdleConnsPerHost ≥ (peak RPS to that host) × (average request duration in seconds) × 1.25
```

For a service sending 500 RPS to a backend with average 20ms latency:

```
500 × 0.020 × 1.25 = 12.5 → set MaxIdleConnsPerHost = 15 or 20
```

If this value is too low, the transport will create new connections and then immediately close them after use because the idle pool is full, which defeats keep-alive entirely.

### MaxConnsPerHost: Back-Pressure Control

`MaxConnsPerHost` limits the total number of connections (active + idle) to a given host. When the limit is reached, `Transport.RoundTrip` blocks until a connection becomes available or the request context is cancelled. This provides natural back-pressure against overloaded backends.

```go
// Service calling a database proxy — limit connections to match proxy's
// max_connections setting to avoid overwhelming it.
cfg := DefaultTransportConfig()
cfg.MaxConnsPerHost = 50   // proxy is configured for 60 max; leave headroom
cfg.MaxIdleConnsPerHost = 40
```

## Section 3: Keep-Alive Tuning and Idle Connection Management

### TCP Keep-Alive vs. HTTP Keep-Alive

These are two distinct mechanisms that are often confused.

**TCP Keep-Alive** is a kernel-level probe sent when a connection is idle. It detects half-open connections caused by network failures or NAT table evictions. Configure it on the `net.Dialer`.

**HTTP/1.1 Keep-Alive** (persistent connections) is the practice of reusing a TCP connection for multiple HTTP requests, controlled by the `Connection: keep-alive` header. This is enabled by default in Go's transport.

```go
// Demonstrate both levels
dialer := &net.Dialer{
    KeepAlive: 15 * time.Second,  // TCP keepalive: probe every 15s
}

transport := &http.Transport{
    DialContext:     dialer.DialContext,
    IdleConnTimeout: 45 * time.Second, // HTTP: close idle conn after 45s
    // 45s < typical NAT table timeout (60-120s) to avoid getting a
    // connection killed mid-use by NAT eviction
}
```

### Idle Connection Lifecycle

```
Request completes
      │
      ▼
  Response body fully read AND closed?
      │ yes
      ▼
  Connection returned to idle pool
      │
      ├─ Pool full (>MaxIdleConnsPerHost) → connection closed
      │
      └─ Pool has room → connection held for IdleConnTimeout
                               │
                         timeout expires → connection closed
```

If you do not read and close the response body, the connection is NOT returned to the pool. It is eventually closed when GC finalizes the `http.Response`, but you have leaked the connection for the duration.

## Section 4: Request and Response Body Handling

### The Body Drain Pattern

```go
func doRequest(client *http.Client, req *http.Request) ([]byte, error) {
    resp, err := client.Do(req)
    if err != nil {
        return nil, fmt.Errorf("request failed: %w", err)
    }
    // ALWAYS close the body, even if you do not read it.
    // Use defer to ensure this even on early returns.
    defer resp.Body.Close()

    // Read the full body. This is required for the connection to be
    // eligible for reuse. io.ReadAll returns on EOF, which signals
    // to the transport that the response is complete.
    body, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024)) // 10MB limit
    if err != nil {
        return nil, fmt.Errorf("reading body: %w", err)
    }

    if resp.StatusCode >= 400 {
        return nil, fmt.Errorf("server error %d: %s", resp.StatusCode, body)
    }

    return body, nil
}
```

### When You Do Not Need the Body

If you only care about the status code (e.g., a health check or a DELETE request), drain and discard the body explicitly rather than just closing it:

```go
func checkHealth(client *http.Client, url string) error {
    resp, err := client.Get(url)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    // Drain body so the connection can be reused
    _, _ = io.Copy(io.Discard, resp.Body)
    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("unhealthy: %d", resp.StatusCode)
    }
    return nil
}
```

### Large Body Streaming

For large uploads or downloads, do not buffer the entire body in memory:

```go
// Streaming download — write directly to file
func downloadToFile(client *http.Client, url, dest string) error {
    resp, err := client.Get(url)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    f, err := os.Create(dest)
    if err != nil {
        return err
    }
    defer f.Close()

    // io.Copy reads in 32KB chunks by default
    if _, err := io.Copy(f, resp.Body); err != nil {
        return fmt.Errorf("streaming body: %w", err)
    }
    return nil
}

// Streaming upload — send file without loading into memory
func uploadFromFile(client *http.Client, url, src string) error {
    f, err := os.Open(src)
    if err != nil {
        return err
    }
    defer f.Close()

    stat, err := f.Stat()
    if err != nil {
        return err
    }

    req, err := http.NewRequest(http.MethodPut, url, f)
    if err != nil {
        return err
    }
    req.ContentLength = stat.Size()
    req.Header.Set("Content-Type", "application/octet-stream")

    resp, err := client.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    _, _ = io.Copy(io.Discard, resp.Body)
    return nil
}
```

## Section 5: Request Tracing with httptrace

The `net/http/httptrace` package provides hooks that fire at each stage of the request lifecycle. This is invaluable for diagnosing connection pool behavior, DNS resolution latency, and TLS handshake costs.

```go
package httptrace_demo

import (
    "context"
    "crypto/tls"
    "fmt"
    "net/http"
    "net/http/httptrace"
    "time"
)

type RequestTrace struct {
    DNSStart        time.Time
    DNSDone         time.Time
    ConnectStart    time.Time
    ConnectDone     time.Time
    TLSStart        time.Time
    TLSDone         time.Time
    GotConn         time.Time
    WroteRequest    time.Time
    GotFirstByte    time.Time
    ConnectionReuse bool
    ConnectionIdle  bool
    RemoteAddr      string
}

func (t *RequestTrace) Summary() string {
    dnsLatency := t.DNSDone.Sub(t.DNSStart)
    tcpLatency := t.ConnectDone.Sub(t.ConnectStart)
    tlsLatency := t.TLSDone.Sub(t.TLSStart)
    ttfb := t.GotFirstByte.Sub(t.WroteRequest)
    return fmt.Sprintf(
        "reuse=%v dns=%v tcp=%v tls=%v ttfb=%v remote=%s",
        t.ConnectionReuse, dnsLatency, tcpLatency, tlsLatency, ttfb, t.RemoteAddr,
    )
}

func traceRequest(ctx context.Context, client *http.Client, url string) (*RequestTrace, *http.Response, error) {
    rt := &RequestTrace{}

    trace := &httptrace.ClientTrace{
        DNSStart: func(info httptrace.DNSStartInfo) {
            rt.DNSStart = time.Now()
        },
        DNSDone: func(info httptrace.DNSDoneInfo) {
            rt.DNSDone = time.Now()
        },
        ConnectStart: func(network, addr string) {
            rt.ConnectStart = time.Now()
        },
        ConnectDone: func(network, addr string, err error) {
            rt.ConnectDone = time.Now()
        },
        TLSHandshakeStart: func() {
            rt.TLSStart = time.Now()
        },
        TLSHandshakeDone: func(state tls.ConnectionState, err error) {
            rt.TLSDone = time.Now()
        },
        GotConn: func(info httptrace.GotConnInfo) {
            rt.GotConn = time.Now()
            rt.ConnectionReuse = info.Reused
            rt.ConnectionIdle = info.WasIdle
            if info.Conn != nil {
                rt.RemoteAddr = info.Conn.RemoteAddr().String()
            }
        },
        WroteRequest: func(info httptrace.WroteRequestInfo) {
            rt.WroteRequest = time.Now()
        },
        GotFirstResponseByte: func() {
            rt.GotFirstByte = time.Now()
        },
    }

    req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodGet, url, nil)
    if err != nil {
        return nil, nil, err
    }

    resp, err := client.Do(req)
    return rt, resp, err
}
```

### Integrating Trace Data with Metrics

```go
// Record httptrace observations as Prometheus histograms
var (
    dnsLatency = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_client_dns_duration_seconds",
            Help:    "DNS resolution latency per request",
            Buckets: prometheus.ExponentialBuckets(0.0001, 2, 12),
        },
        []string{"host"},
    )
    connReuseTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_client_connection_reuse_total",
            Help: "Number of requests that reused an existing connection",
        },
        []string{"host", "reused"},
    )
)

func observeTrace(host string, rt *RequestTrace) {
    if !rt.DNSStart.IsZero() && !rt.DNSDone.IsZero() {
        dnsLatency.WithLabelValues(host).Observe(rt.DNSDone.Sub(rt.DNSStart).Seconds())
    }
    reused := "false"
    if rt.ConnectionReuse {
        reused = "true"
    }
    connReuseTotal.WithLabelValues(host, reused).Inc()
}
```

## Section 6: The Timeout Hierarchy

Go's HTTP client has multiple independent timeout controls. They compose — a request must complete within ALL applicable timeouts, not just the most permissive one.

```
┌─────────────────────────────────────────────────────────────────┐
│                    http.Client.Timeout                          │
│  (wall-clock deadline from Do() call to body fully consumed)   │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐    │
│  │              context.WithTimeout / WithDeadline        │    │
│  │                                                        │    │
│  │  ┌──────────────┐  ┌────────────────────────────────┐ │    │
│  │  │ DialTimeout  │  │  TLSHandshakeTimeout           │ │    │
│  │  │ (net.Dialer) │  │  (Transport field)             │ │    │
│  │  └──────────────┘  └────────────────────────────────┘ │    │
│  │                                                        │    │
│  │  ┌────────────────────────────────────────────────┐   │    │
│  │  │         ResponseHeaderTimeout                  │   │    │
│  │  │  (time from request sent to first header byte) │   │    │
│  │  └────────────────────────────────────────────────┘   │    │
│  └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### Practical Timeout Configuration

```go
// Recommended production configuration for a service calling internal APIs
client := &http.Client{
    // Total request budget: use context.WithTimeout instead of this field
    // so each call site can tune it. But set a safety net here.
    Timeout: 30 * time.Second,

    Transport: &http.Transport{
        DialContext: (&net.Dialer{
            Timeout:   3 * time.Second,  // Fail fast on TCP connect
            KeepAlive: 30 * time.Second,
        }).DialContext,
        TLSHandshakeTimeout:   5 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second, // Detect slow/hung servers
        IdleConnTimeout:       60 * time.Second,
        MaxIdleConnsPerHost:   50,
    },
}

// Per-call timeout using context
func callAPI(ctx context.Context, client *http.Client, url string) ([]byte, error) {
    // Each call gets its own deadline, tighter than the client-level safety net
    callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    req, err := http.NewRequestWithContext(callCtx, http.MethodGet, url, nil)
    if err != nil {
        return nil, err
    }

    resp, err := client.Do(req)
    if err != nil {
        // Distinguish timeout from other errors
        if errors.Is(err, context.DeadlineExceeded) {
            return nil, fmt.Errorf("API call timed out after 5s: %w", err)
        }
        return nil, fmt.Errorf("API call failed: %w", err)
    }
    defer resp.Body.Close()
    return io.ReadAll(io.LimitReader(resp.Body, 1*1024*1024))
}
```

### Why `http.Client.Timeout` Is Dangerous Alone

`http.Client.Timeout` starts from the moment `Do()` is called and ends when the response body is fully consumed. This means if you hold a reference to `resp.Body` and read from it slowly, the timeout clock is still ticking. Worse, if you make a request with a large response and process the body in chunks, you can hit the client timeout mid-processing even if the server is responsive.

The recommended pattern is:

1. Set `http.Client.Timeout` as an outer safety net (e.g., 60 seconds).
2. Use `context.WithTimeout` per-call for the actual SLA (e.g., 5 seconds for headers + small body).
3. Use `ResponseHeaderTimeout` on the transport to catch hung servers early.

## Section 7: Connection Pool Monitoring

```go
// Expose transport statistics via Prometheus
type instrumentedTransport struct {
    base      http.RoundTripper
    inFlight  prometheus.Gauge
    requests  *prometheus.CounterVec
    durations *prometheus.HistogramVec
}

func (t *instrumentedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    t.inFlight.Inc()
    defer t.inFlight.Dec()

    start := time.Now()
    resp, err := t.base.RoundTrip(req)
    duration := time.Since(start)

    statusCode := "error"
    if resp != nil {
        statusCode = strconv.Itoa(resp.StatusCode)
    }

    t.requests.WithLabelValues(req.Method, req.URL.Host, statusCode).Inc()
    t.durations.WithLabelValues(req.Method, req.URL.Host).Observe(duration.Seconds())

    return resp, err
}

// Access internal transport pool stats (Go 1.13+)
func reportTransportStats(t *http.Transport) {
    // No public API; use net/http/pprof's /debug/pprof/goroutine
    // or instrument via RoundTripper wrapper above.
    // For connection counts, monitor file descriptor usage:
    //   /proc/self/fd or runtime.NumGoroutine()
}
```

## Section 8: HTTP/2 Considerations

When `ForceAttemptHTTP2: true` (the default), Go will attempt to negotiate HTTP/2 via ALPN for HTTPS connections. HTTP/2 multiplexes requests over a single TCP connection, which changes the connection pool semantics significantly.

```go
// For HTTP/2, MaxIdleConnsPerHost is less relevant because
// multiple requests share one connection. What matters more is
// the number of concurrent streams.

// To disable HTTP/2 (for debugging or compatibility):
transport := &http.Transport{
    ForceAttemptHTTP2: false,
    TLSNextProto: make(map[string]func(*http.Transport, *tls.Conn) http.RoundTripper),
}

// To verify which protocol was negotiated:
trace := &httptrace.ClientTrace{
    TLSHandshakeDone: func(state tls.ConnectionState, err error) {
        fmt.Printf("negotiated protocol: %s\n", state.NegotiatedProtocol)
        // "h2" for HTTP/2, "" or "http/1.1" for HTTP/1.1
    },
}
```

## Section 9: Testing HTTP Clients

### Using httptest.Server

```go
func TestClientRetry(t *testing.T) {
    callCount := 0
    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        callCount++
        if callCount < 3 {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        w.WriteHeader(http.StatusOK)
        _, _ = w.Write([]byte(`{"status":"ok"}`))
    }))
    defer server.Close()

    client := &http.Client{
        Transport: &http.Transport{
            MaxIdleConnsPerHost: 5,
            IdleConnTimeout:     30 * time.Second,
        },
        Timeout: 10 * time.Second,
    }

    // ... test retry logic ...
    _ = client
}
```

### Asserting Connection Reuse

```go
func TestConnectionReuse(t *testing.T) {
    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        _, _ = w.Write([]byte("ok"))
    }))
    defer server.Close()

    transport := &http.Transport{
        MaxIdleConnsPerHost: 10,
    }
    client := &http.Client{Transport: transport}

    var reuseCount int
    for i := 0; i < 10; i++ {
        rt := &RequestTrace{}
        trace := &httptrace.ClientTrace{
            GotConn: func(info httptrace.GotConnInfo) {
                if info.Reused {
                    reuseCount++
                }
            },
        }
        ctx := httptrace.WithClientTrace(context.Background(), trace)
        req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
        resp, err := client.Do(req)
        if err != nil {
            t.Fatal(err)
        }
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()
        _ = rt
    }

    // First request cannot reuse; remaining 9 should
    if reuseCount < 8 {
        t.Errorf("expected connection reuse, got only %d reuses out of 9 possible", reuseCount)
    }
}
```

## Section 10: Production Configuration Reference

```go
// Complete production HTTP client factory
package httpclient

import (
    "context"
    "crypto/tls"
    "io"
    "net"
    "net/http"
    "time"
)

type ClientOptions struct {
    // Per-host connection pool size
    MaxIdleConnsPerHost int
    // Hard cap on concurrent connections per host (0 = no limit)
    MaxConnsPerHost int
    // How long to keep idle connections alive
    IdleConnTimeout time.Duration
    // TCP dial timeout
    DialTimeout time.Duration
    // TLS negotiation timeout
    TLSHandshakeTimeout time.Duration
    // Time to wait for server to start sending headers after request is sent
    ResponseHeaderTimeout time.Duration
    // Safety net for the entire request lifecycle (use context for per-call tuning)
    ClientTimeout time.Duration
    // Custom TLS configuration (nil = use system defaults)
    TLSConfig *tls.Config
}

func DefaultClientOptions() ClientOptions {
    return ClientOptions{
        MaxIdleConnsPerHost:   100,
        MaxConnsPerHost:       200,
        IdleConnTimeout:       60 * time.Second,
        DialTimeout:           5 * time.Second,
        TLSHandshakeTimeout:   5 * time.Second,
        ResponseHeaderTimeout: 15 * time.Second,
        ClientTimeout:         60 * time.Second,
    }
}

func NewClient(opts ClientOptions) *http.Client {
    dialer := &net.Dialer{
        Timeout:   opts.DialTimeout,
        KeepAlive: 30 * time.Second,
        DualStack: true,
    }

    tlsCfg := opts.TLSConfig
    if tlsCfg == nil {
        tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12}
    }

    transport := &http.Transport{
        DialContext:           dialer.DialContext,
        MaxIdleConns:          opts.MaxIdleConnsPerHost * 10,
        MaxIdleConnsPerHost:   opts.MaxIdleConnsPerHost,
        MaxConnsPerHost:       opts.MaxConnsPerHost,
        IdleConnTimeout:       opts.IdleConnTimeout,
        TLSHandshakeTimeout:   opts.TLSHandshakeTimeout,
        ResponseHeaderTimeout: opts.ResponseHeaderTimeout,
        ExpectContinueTimeout: 1 * time.Second,
        ForceAttemptHTTP2:     true,
        TLSClientConfig:       tlsCfg,
        WriteBufferSize:       32 * 1024,
        ReadBufferSize:        32 * 1024,
    }

    return &http.Client{
        Transport: transport,
        Timeout:   opts.ClientTimeout,
    }
}

// Do executes a request with context and returns the response body.
// The caller does not need to close the response body.
func Do(ctx context.Context, client *http.Client, req *http.Request, maxBodyBytes int64) ([]byte, *http.Response, error) {
    if maxBodyBytes <= 0 {
        maxBodyBytes = 10 * 1024 * 1024 // 10MB default
    }
    req = req.WithContext(ctx)
    resp, err := client.Do(req)
    if err != nil {
        return nil, nil, err
    }
    defer resp.Body.Close()
    body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
    if err != nil {
        return nil, resp, err
    }
    return body, resp, nil
}
```

The Go HTTP client is powerful but requires deliberate configuration for production workloads. The investment in understanding connection pooling, timeout hierarchies, and body handling pays dividends in stability under load and dramatically simplifies debugging when things go wrong.
