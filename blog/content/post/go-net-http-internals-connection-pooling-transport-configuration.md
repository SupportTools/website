---
title: "Go net/http Internals: Connection Pooling, Keep-Alive Tuning, and Transport Configuration"
date: 2030-11-02T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "HTTP", "Performance", "net/http", "Connection Pooling", "Production"]
categories:
- Go
- Performance
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Production HTTP client configuration in Go: Transport struct tuning for MaxIdleConns and IdleConnTimeout, connection reuse patterns, HTTP/2 vs HTTP/1.1 behavior, all timeout layers, and diagnosing connection pool exhaustion in production systems."
more_link: "yes"
url: "/go-net-http-internals-connection-pooling-transport-configuration/"
---

The default `http.DefaultTransport` in Go is designed for general-purpose use, but production services that make significant numbers of outbound HTTP calls require deliberate transport configuration. Misconfigured transports cause connection pool exhaustion, spurious TLS handshake overhead, latency tail spikes, and eventually cascading service failures. This guide covers the internals of `http.Transport`, the interaction between all timeout layers, HTTP/2 multiplexing behavior, and diagnostics for connection pool problems in production Go services.

<!--more-->

## Understanding http.Transport

`http.Transport` is the core struct responsible for managing HTTP connections. It implements `http.RoundTripper` and handles connection establishment, TLS negotiation, connection pooling, and request lifecycle management.

```go
// The full Transport struct with all relevant fields
// From net/http package (Go 1.22+)
type Transport struct {
    // Proxy specifies a function to return a proxy for a given Request.
    Proxy func(*Request) (*url.URL, error)

    // DialContext specifies the dial function for creating unencrypted TCP connections.
    // If DialContext is nil, the transport dials using net.Dial.
    DialContext func(ctx context.Context, network, addr string) (net.Conn, error)

    // ForceAttemptHTTP2 controls whether HTTP/2 is enabled when a non-zero
    // Dial, DialTLS, or DialContext func or TLSClientConfig is provided.
    ForceAttemptHTTP2 bool

    // MaxIdleConns controls the maximum number of idle (keep-alive) connections
    // across all hosts. Zero means no limit.
    MaxIdleConns int

    // MaxIdleConnsPerHost controls the maximum idle connections per host.
    // Default: DefaultMaxIdleConnsPerHost (2 in Go standard library).
    MaxIdleConnsPerHost int

    // MaxConnsPerHost limits the total number of connections per host, including
    // connections in the dialing, active, and idle states.
    // Zero means no limit.
    MaxConnsPerHost int

    // IdleConnTimeout is the maximum amount of time an idle connection will remain
    // idle before closing itself.
    IdleConnTimeout time.Duration

    // ResponseHeaderTimeout, if non-zero, specifies the amount of time to wait
    // for a server's response headers after fully writing the request.
    ResponseHeaderTimeout time.Duration

    // ExpectContinueTimeout, if non-zero, specifies the amount of time to wait
    // for a server's first response headers after fully writing the request
    // headers if the request has an "Expect: 100-continue" header.
    ExpectContinueTimeout time.Duration

    // TLSHandshakeTimeout specifies the maximum amount of time to wait for a
    // TLS handshake. Zero means no timeout.
    TLSHandshakeTimeout time.Duration

    // TLSClientConfig specifies the TLS configuration to use with tls.Client.
    TLSClientConfig *tls.Config

    // TLSNextProto specifies how the Transport switches to an alternate protocol
    // (such as HTTP/2) after a TLS NPN/ALPN protocol negotiation.
    TLSNextProto map[string]func(authority string, c *tls.Conn) RoundTripper

    // DisableKeepAlives, if true, disables HTTP keep-alives and will only use
    // the connection to the server for a single HTTP request.
    DisableKeepAlives bool

    // DisableCompression, if true, prevents the Transport from requesting
    // compression with an "Accept-Encoding: gzip" request header.
    DisableCompression bool

    // WriteBufferSize specifies the size of the write buffer used when writing
    // to the transport. If zero, a default (currently 4096) is used.
    WriteBufferSize int

    // ReadBufferSize specifies the size of the read buffer used when reading
    // from the transport. If zero, a default (currently 4096) is used.
    ReadBufferSize int
}
```

## Default Transport Limitations

The `http.DefaultTransport` values are problematic for high-throughput services:

```go
// http.DefaultTransport (from Go source)
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
    // MaxIdleConnsPerHost defaults to DefaultMaxIdleConnsPerHost = 2
}
```

The critical limitation is `MaxIdleConnsPerHost: 2`. When a service makes concurrent calls to a single upstream host, only two connections can be kept alive in the pool. Any additional concurrent requests must open new connections, including a full TCP handshake and potentially a TLS handshake. Under load, this creates a burst of new connections that the upstream host must handle.

Consider a Go service receiving 500 requests per second, each making one downstream API call. With `MaxIdleConnsPerHost: 2`, and assuming 5ms average upstream response time, the maximum steady-state connections maintained is limited to 2, but the burst creates up to 500 concurrent connections. Most of these will require new TCP connections rather than reusing pooled ones.

## Production Transport Configuration

### General-Purpose High-Throughput Service

```go
package httpclient

import (
    "context"
    "crypto/tls"
    "net"
    "net/http"
    "net/http/httptrace"
    "time"
)

// NewProductionTransport creates an http.Transport configured for
// high-throughput production use against a small set of upstream hosts.
// Adjust MaxIdleConnsPerHost based on your target concurrency per host.
func NewProductionTransport(maxConnsPerHost int) *http.Transport {
    dialer := &net.Dialer{
        // Timeout for establishing the TCP connection.
        // Should be shorter than your overall request timeout.
        Timeout: 5 * time.Second,

        // Keep-alive interval. Sends TCP keep-alive probes to detect
        // dead connections. Does NOT control HTTP keep-alive.
        KeepAlive: 30 * time.Second,

        // DualStack enables IPv4 and IPv6 happy-eyeballs algorithm.
        // Recommended for services that may resolve to either address family.
        DualStack: true,
    }

    return &http.Transport{
        DialContext:           dialer.DialContext,
        ForceAttemptHTTP2:     true,

        // Maximum total idle connections across all hosts.
        // Set to at least maxConnsPerHost * number_of_upstream_hosts.
        MaxIdleConns:          maxConnsPerHost * 10,

        // THE critical parameter: maximum idle connections per host.
        // Set this to match your expected concurrency per host.
        // Formula: MaxIdleConnsPerHost >= peak_concurrent_requests_per_host
        // Common values: 50-200 for typical microservices
        MaxIdleConnsPerHost:   maxConnsPerHost,

        // Maximum total connections per host (idle + active + dialing).
        // Zero = no limit. Set to control connection count under extreme load.
        // Requests beyond this limit will block until a connection is available.
        MaxConnsPerHost:       maxConnsPerHost * 2,

        // Idle connection timeout: how long an idle pooled connection lives.
        // Should be less than the upstream server's keepalive timeout.
        // nginx default: 75s, so 60s is a safe value.
        // AWS ALB: 60s idle timeout, so use 55s.
        IdleConnTimeout:       55 * time.Second,

        // TLS handshake timeout. 5s is appropriate for same-region calls.
        // Increase to 10s for cross-region or external API calls.
        TLSHandshakeTimeout:   5 * time.Second,

        // Wait time after sending request headers before receiving first
        // response byte. Covers server processing time.
        ResponseHeaderTimeout: 10 * time.Second,

        // For requests with Expect: 100-continue
        ExpectContinueTimeout: 1 * time.Second,

        // Buffer sizes: increase for large request/response bodies
        // Default 4096 causes excessive syscalls for large payloads
        WriteBufferSize: 16 * 1024,
        ReadBufferSize:  16 * 1024,

        TLSClientConfig: &tls.Config{
            // Set minimum TLS version to 1.2 for production
            MinVersion: tls.VersionTLS12,

            // Disable session ticket rotation to improve session resumption rates
            // Only disable if using a single connection endpoint
            // SessionTicketsDisabled: false, // keep default

            // InsecureSkipVerify MUST be false in production
            InsecureSkipVerify: false,
        },
    }
}

// NewHTTPClient creates a production-ready HTTP client.
// requestTimeout is the end-to-end timeout per request.
func NewHTTPClient(maxConnsPerHost int, requestTimeout time.Duration) *http.Client {
    return &http.Client{
        Transport: NewProductionTransport(maxConnsPerHost),
        Timeout:   requestTimeout,
        // Do NOT follow redirects for API clients unless explicitly required
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            return http.ErrUseLastResponse
        },
    }
}
```

### Calculating MaxIdleConnsPerHost

The correct value depends on your traffic pattern:

```go
// Calculate the recommended MaxIdleConnsPerHost
//
// Variables:
//   rps          = requests per second to a single upstream host
//   avg_latency  = average upstream response latency in seconds
//   burst_factor = multiplier for burst headroom (typically 1.5-2.0)
//
// Formula (Little's Law):
//   concurrent_connections = rps * avg_latency
//   MaxIdleConnsPerHost = ceil(concurrent_connections * burst_factor)
//
// Example:
//   rps = 1000
//   avg_latency = 0.020 (20ms)
//   burst_factor = 2.0
//
//   concurrent = 1000 * 0.020 = 20 connections
//   MaxIdleConnsPerHost = ceil(20 * 2.0) = 40

func RecommendedMaxIdleConns(rps float64, avgLatencyMs float64, burstFactor float64) int {
    concurrent := rps * (avgLatencyMs / 1000.0)
    recommended := int(math.Ceil(concurrent * burstFactor))
    // Minimum of 10 to handle burst variability
    if recommended < 10 {
        return 10
    }
    return recommended
}
```

## Timeout Layers Explained

Go's HTTP client has five distinct timeout layers that interact with each other. Understanding all five is critical for correctly diagnosing timeout failures.

```
Time →
0ms                                         end-to-end
├─────────────────────────────────────────────────────┤ http.Client.Timeout
│
│ context deadline (if used)
├──────────────────────────────────────────────────────
│
│     Dial timeout (net.Dialer.Timeout)
│     ├──────────┤
│               │
│               │ TLSHandshakeTimeout
│               ├────────────┤
│                           │
│                           │ ResponseHeaderTimeout
│                           ├──────────────────────────┤
│                                                      │
│ ← Request.Body write happens concurrently            │
│                                                      │
│                                              Body read
│                                              (no timeout — use context)
```

```go
package timeouts

import (
    "context"
    "net"
    "net/http"
    "time"
)

// TimeoutDemonstration shows all five timeout layers in action.
func TimeoutDemonstration() {
    // Layer 1: Dial timeout — controls TCP connection establishment
    // Set via net.Dialer.Timeout
    dialer := &net.Dialer{
        Timeout:   3 * time.Second,  // TCP connection must complete within 3s
        KeepAlive: 30 * time.Second,
    }

    transport := &http.Transport{
        DialContext: dialer.DialContext,

        // Layer 2: TLS handshake timeout — controls TLS negotiation after TCP connect
        TLSHandshakeTimeout: 5 * time.Second,

        // Layer 3: Response header timeout — controls server processing time
        // Starts after request body is fully sent
        // Does NOT cover response body reading
        ResponseHeaderTimeout: 10 * time.Second,
    }

    // Layer 4: http.Client.Timeout — end-to-end timeout for the entire request
    // Covers dial + TLS + write request + read headers + read body
    client := &http.Client{
        Transport: transport,
        Timeout:   30 * time.Second,
    }

    // Layer 5: context.WithTimeout — overrides or supplements client timeout
    // The more restrictive of client.Timeout and context deadline applies
    ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.example.com/data", nil)
    resp, err := client.Do(req)
    if err != nil {
        // Determine which timeout fired:
        // - "context deadline exceeded" → context or client timeout
        // - "i/o timeout" + stack mentions dial → Dial timeout
        // - "TLS handshake timeout" → TLSHandshakeTimeout
        // - "net/http: timeout awaiting response headers" → ResponseHeaderTimeout
        return
    }
    defer resp.Body.Close()

    // IMPORTANT: There is no timeout on Body reading via Transport.
    // For body read timeout, use context or wrap Body with a time-limited reader.
    // http.Client.Timeout DOES cover body reading, but only the total duration.
}

// TimeLimitedBodyReader wraps an io.Reader with a deadline.
// Use this when you need body read isolation from header read timeout.
type TimeLimitedBodyReader struct {
    body      io.ReadCloser
    conn      net.Conn
    deadline  time.Time
}

func (r *TimeLimitedBodyReader) Read(p []byte) (n int, err error) {
    if !r.deadline.IsZero() {
        r.conn.SetReadDeadline(r.deadline)
    }
    return r.body.Read(p)
}

func (r *TimeLimitedBodyReader) Close() error {
    return r.body.Close()
}
```

### Timeout Error Classification

```go
package errors

import (
    "errors"
    "net"
    "net/url"
    "os"
    "strings"
)

// ClassifyHTTPError categorizes HTTP client errors for monitoring and alerting.
type ErrorClass string

const (
    ErrDialTimeout         ErrorClass = "dial_timeout"
    ErrTLSHandshake        ErrorClass = "tls_handshake"
    ErrResponseHeader      ErrorClass = "response_header_timeout"
    ErrContextDeadline     ErrorClass = "context_deadline"
    ErrConnectionReset     ErrorClass = "connection_reset"
    ErrConnectionRefused   ErrorClass = "connection_refused"
    ErrDNSResolution       ErrorClass = "dns_resolution"
    ErrEOF                 ErrorClass = "unexpected_eof"
    ErrUnknown             ErrorClass = "unknown"
)

func ClassifyHTTPError(err error) ErrorClass {
    if err == nil {
        return ""
    }

    errStr := err.Error()

    // Check for context deadline (covers client.Timeout and context.WithTimeout)
    if errors.Is(err, context.DeadlineExceeded) {
        return ErrContextDeadline
    }

    // Unwrap URL error to get the underlying net error
    var urlErr *url.Error
    if errors.As(err, &urlErr) {
        err = urlErr.Err
    }

    // TLS handshake timeout
    if strings.Contains(errStr, "TLS handshake timeout") {
        return ErrTLSHandshake
    }

    // Response header timeout
    if strings.Contains(errStr, "timeout awaiting response headers") {
        return ErrResponseHeader
    }

    // DNS lookup failure
    var dnsErr *net.DNSError
    if errors.As(err, &dnsErr) {
        return ErrDNSResolution
    }

    // Network operation timeout (covers dial timeout)
    var netErr net.Error
    if errors.As(err, &netErr) && netErr.Timeout() {
        return ErrDialTimeout
    }

    // Connection reset by peer
    var opErr *net.OpError
    if errors.As(err, &opErr) {
        if strings.Contains(opErr.Error(), "connection reset") {
            return ErrConnectionReset
        }
        if strings.Contains(opErr.Error(), "connection refused") {
            return ErrConnectionRefused
        }
    }

    // Unexpected EOF (server closed connection mid-response)
    if errors.Is(err, io.ErrUnexpectedEOF) || strings.Contains(errStr, "EOF") {
        return ErrEOF
    }

    return ErrUnknown
}
```

## HTTP/2 vs HTTP/1.1 Connection Behavior

HTTP/2 changes the connection pooling model significantly. With HTTP/2, a single TCP connection can multiplex many concurrent requests via streams, whereas HTTP/1.1 requires one connection per in-flight request.

```go
package h2

import (
    "crypto/tls"
    "net/http"
    "golang.org/x/net/http2"
)

// HTTP2TransportConfig shows HTTP/2 specific tuning options.
// golang.org/x/net/http2 provides low-level HTTP/2 transport access.
func NewHTTP2Transport() *http.Transport {
    t := &http.Transport{
        // ForceAttemptHTTP2 enables HTTP/2 for custom Dial functions
        ForceAttemptHTTP2: true,
        TLSClientConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
        },
    }

    // Configure HTTP/2-specific settings via http2.ConfigureTransport
    // This gives access to stream-level settings
    h2Transport, err := http2.ConfigureTransport(t)
    if err != nil {
        panic(err)
    }

    // HTTP/2 connection-level flow control window
    // Increase for high-bandwidth responses (default 65535 bytes = 64KB)
    // Recommendation: 64MB for high-throughput services
    h2Transport.InitialWindowSize = 1 << 26 // 64 MB

    // Maximum number of HTTP/2 streams per connection
    // Server controls this via SETTINGS frame; this is the client's max
    // Default: unlimited (server dictates via MaxConcurrentStreams)
    // h2Transport.MaxFrameSize = 1 << 20 // 1 MB (max: 16MB-1)

    // ReadIdleTimeout: ping server to detect dead connections
    // Essential for long-lived HTTP/2 connections
    h2Transport.ReadIdleTimeout = 30 * time.Second
    h2Transport.PingTimeout = 15 * time.Second

    return t
}

// HTTP/2 vs HTTP/1.1 connection behavior differences:
//
// HTTP/1.1:
// - One request per connection (without pipelining)
// - MaxIdleConnsPerHost limits concurrent request capacity
// - New connection required for each request beyond pooled connections
// - HEAD-of-line blocking: slow responses block the connection
//
// HTTP/2:
// - Multiple streams per connection (multiplexed)
// - MaxIdleConnsPerHost still applies but usually 1-2 connections suffice
//   because one connection handles many concurrent streams
// - Head-of-line blocking at TCP level still exists
// - GOAWAY frame from server gracefully drains connection
//
// When HTTP/2 is NOT appropriate:
// - Uploading many large files (stream-level flow control adds overhead)
// - Servers that do not support HTTP/2 (fallback to HTTP/1.1 is automatic)
// - gRPC services (use google.golang.org/grpc which manages HTTP/2 internally)
```

### Disabling HTTP/2 for Specific Hosts

```go
// DisableHTTP2ForHost shows how to force HTTP/1.1 for specific hosts
// while using HTTP/2 for others.
func NewSelectiveH2Transport() *http.Transport {
    t := &http.Transport{
        ForceAttemptHTTP2:   true,
        MaxIdleConns:        200,
        MaxIdleConnsPerHost: 50,
        IdleConnTimeout:     55 * time.Second,
        TLSHandshakeTimeout: 5 * time.Second,
    }

    // Disable HTTP/2 for specific hosts by intercepting ALPN negotiation
    t.TLSNextProto = make(map[string]func(authority string, c *tls.Conn) http.RoundTripper)

    return t
}
```

## Diagnosing Connection Pool Exhaustion

### httptrace Integration

Go's `net/http/httptrace` package provides detailed visibility into the connection lifecycle:

```go
package tracing

import (
    "context"
    "fmt"
    "net/http"
    "net/http/httptrace"
    "sync/atomic"
    "time"
)

// ConnectionStats tracks connection lifecycle events for monitoring.
type ConnectionStats struct {
    NewConnections    atomic.Int64
    ReusedConnections atomic.Int64
    IdleConnWaits     atomic.Int64
    DNSResolutions    atomic.Int64
    TLSHandshakes     atomic.Int64
}

// InstrumentRequest adds httptrace to a request for connection pool monitoring.
func InstrumentRequest(req *http.Request, stats *ConnectionStats) *http.Request {
    var (
        startDial     time.Time
        startTLS      time.Time
        startHeader   time.Time
        gotConn       time.Time
    )

    trace := &httptrace.ClientTrace{
        // Called when attempting to find an idle connection
        GetConn: func(hostPort string) {
            startHeader = time.Now()
        },

        // Called when a connection is obtained (either new or from pool)
        GotConn: func(info httptrace.GotConnInfo) {
            gotConn = time.Now()
            waitMs := gotConn.Sub(startHeader).Milliseconds()

            if info.Reused {
                stats.ReusedConnections.Add(1)
            } else {
                stats.NewConnections.Add(1)
            }

            if info.WasIdle {
                stats.IdleConnWaits.Add(1)
            }

            if waitMs > 100 {
                // High wait time suggests pool exhaustion or slow dialing
                fmt.Printf("WARN: connection wait %dms for %s (reused=%v, idle=%v)\n",
                    waitMs, hostPort, info.Reused, info.WasIdle)
            }
        },

        // Called when DNS lookup begins
        DNSStart: func(info httptrace.DNSStartInfo) {
            stats.DNSResolutions.Add(1)
        },

        // Called when DNS lookup completes
        DNSDone: func(info httptrace.DNSDoneInfo) {
            if info.Err != nil {
                fmt.Printf("DNS error for %s: %v\n", info.Addrs, info.Err)
            }
        },

        // Called when TCP dialing begins
        ConnectStart: func(network, addr string) {
            startDial = time.Now()
        },

        // Called when TCP connection is established
        ConnectDone: func(network, addr string, err error) {
            if err != nil {
                fmt.Printf("Connect failed to %s/%s: %v\n", network, addr, err)
                return
            }
            dialMs := time.Since(startDial).Milliseconds()
            if dialMs > 50 {
                fmt.Printf("WARN: slow TCP dial to %s: %dms\n", addr, dialMs)
            }
        },

        // Called when TLS handshake begins
        TLSHandshakeStart: func() {
            startTLS = time.Now()
            stats.TLSHandshakes.Add(1)
        },

        // Called when TLS handshake completes
        TLSHandshakeDone: func(state tls.ConnectionState, err error) {
            tlsMs := time.Since(startTLS).Milliseconds()
            if err != nil {
                fmt.Printf("TLS handshake error: %v\n", err)
                return
            }
            if tlsMs > 100 {
                fmt.Printf("WARN: slow TLS handshake: %dms (resumed=%v)\n",
                    tlsMs, state.DidResume)
            }
        },

        // Called when request headers are written
        WroteHeaders: func() {
            // Headers sent, waiting for response
        },

        // Called when response headers are received
        GotFirstResponseByte: func() {
            responseMs := time.Since(gotConn).Milliseconds()
            if responseMs > 500 {
                fmt.Printf("WARN: slow server response: %dms\n", responseMs)
            }
        },
    }

    return req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
}
```

### Metrics-Based Pool Monitoring

```go
package metrics

import (
    "net/http"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    httpConnNew = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "http_client_connections_new_total",
        Help: "Total number of new HTTP connections opened",
    }, []string{"host"})

    httpConnReused = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "http_client_connections_reused_total",
        Help: "Total number of reused HTTP connections",
    }, []string{"host"})

    httpConnWaitSeconds = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "http_client_connection_wait_seconds",
        Help:    "Time waiting to obtain a connection from the pool",
        Buckets: prometheus.ExponentialBuckets(0.001, 2, 12),
    }, []string{"host"})

    httpDialSeconds = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "http_client_dial_seconds",
        Help:    "TCP dial duration",
        Buckets: prometheus.ExponentialBuckets(0.001, 2, 10),
    }, []string{"host"})

    httpTLSSeconds = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "http_client_tls_handshake_seconds",
        Help:    "TLS handshake duration",
        Buckets: prometheus.ExponentialBuckets(0.005, 2, 10),
    }, []string{"host", "resumed"})
)

// InstrumentedRoundTripper wraps http.RoundTripper with Prometheus metrics.
type InstrumentedRoundTripper struct {
    wrapped http.RoundTripper
}

func NewInstrumentedRoundTripper(t http.RoundTripper) *InstrumentedRoundTripper {
    return &InstrumentedRoundTripper{wrapped: t}
}

func (rt *InstrumentedRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
    host := req.URL.Host

    var (
        connStart  time.Time
        dialStart  time.Time
        tlsStart   time.Time
    )

    trace := &httptrace.ClientTrace{
        GetConn: func(_ string) {
            connStart = time.Now()
        },
        GotConn: func(info httptrace.GotConnInfo) {
            waitSecs := time.Since(connStart).Seconds()
            httpConnWaitSeconds.WithLabelValues(host).Observe(waitSecs)

            if info.Reused {
                httpConnReused.WithLabelValues(host).Inc()
            } else {
                httpConnNew.WithLabelValues(host).Inc()
            }
        },
        ConnectStart: func(_, _ string) {
            dialStart = time.Now()
        },
        ConnectDone: func(_, addr string, err error) {
            if err == nil {
                httpDialSeconds.WithLabelValues(host).Observe(time.Since(dialStart).Seconds())
            }
        },
        TLSHandshakeStart: func() {
            tlsStart = time.Now()
        },
        TLSHandshakeDone: func(state tls.ConnectionState, err error) {
            if err == nil {
                resumed := strconv.FormatBool(state.DidResume)
                httpTLSSeconds.WithLabelValues(host, resumed).Observe(time.Since(tlsStart).Seconds())
            }
        },
    }

    instrumentedReq := req.WithContext(
        httptrace.WithClientTrace(req.Context(), trace),
    )

    return rt.wrapped.RoundTrip(instrumentedReq)
}
```

## Connection Reuse Best Practices

### Always Close Response Bodies

The most common cause of connection pool exhaustion is failing to drain and close response bodies:

```go
package patterns

import (
    "io"
    "net/http"
)

// Correct response body handling
func CorrectBodyHandling(client *http.Client, url string) error {
    resp, err := client.Get(url)
    if err != nil {
        return err
    }
    // ALWAYS close the response body, even on error status codes
    defer resp.Body.Close()

    // For connection reuse, the body MUST be fully consumed before closing.
    // io.Copy to io.Discard drains the body without allocating memory.
    // If you don't need the body at all:
    _, _ = io.Copy(io.Discard, resp.Body)

    return nil
}

// WRONG — these patterns prevent connection reuse:

// Missing defer close:
func WrongNoClose(client *http.Client, url string) {
    resp, err := client.Get(url)
    if err != nil {
        return
    }
    // Body never closed → connection leaked → pool exhaustion
    _ = resp
}

// Closing without draining:
func WrongCloseWithoutDrain(client *http.Client, url string) {
    resp, err := client.Get(url)
    if err != nil {
        return
    }
    // Closing without draining forces the transport to discard the connection
    // since there may be unread data on the wire
    resp.Body.Close()
    // Connection will NOT be returned to the pool
}
```

### Request Context and Connection Reuse

```go
// Context cancellation returns connections to the pool correctly
func ContextAwareRequest(client *http.Client, url string) error {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return err
    }

    resp, err := client.Do(req)
    if err != nil {
        // If context was cancelled: connection is properly cleaned up
        // Connection may not return to pool if request was mid-flight
        return err
    }
    defer resp.Body.Close()

    // Read body — the context timeout also covers body read
    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return err
    }
    _ = body
    return nil
}
```

## Production Configuration Reference

```go
package config

import (
    "net"
    "net/http"
    "time"
)

// ServiceClass defines traffic patterns for transport tuning.
type ServiceClass string

const (
    // InternalLowLatency: same-region internal microservice calls
    // Typical: 1-5ms latency, 1000+ RPS, limited hosts
    InternalLowLatency ServiceClass = "internal_low_latency"

    // ExternalAPI: third-party API calls
    // Typical: 100-500ms latency, 50-200 RPS, external hosts
    ExternalAPI ServiceClass = "external_api"

    // BatchProcessing: bulk data transfer
    // Typical: 1-30s latency, low concurrency, large payloads
    BatchProcessing ServiceClass = "batch_processing"
)

// TransportForClass returns a tuned Transport for the given service class.
func TransportForClass(class ServiceClass) *http.Transport {
    switch class {
    case InternalLowLatency:
        return &http.Transport{
            DialContext: (&net.Dialer{
                Timeout:   2 * time.Second,
                KeepAlive: 30 * time.Second,
            }).DialContext,
            MaxIdleConns:          500,
            MaxIdleConnsPerHost:   100,
            MaxConnsPerHost:       200,
            IdleConnTimeout:       55 * time.Second,
            TLSHandshakeTimeout:   3 * time.Second,
            ResponseHeaderTimeout: 5 * time.Second,
            ForceAttemptHTTP2:     true,
        }

    case ExternalAPI:
        return &http.Transport{
            DialContext: (&net.Dialer{
                Timeout:   10 * time.Second,
                KeepAlive: 30 * time.Second,
            }).DialContext,
            MaxIdleConns:          100,
            MaxIdleConnsPerHost:   20,
            MaxConnsPerHost:       50,
            IdleConnTimeout:       90 * time.Second,
            TLSHandshakeTimeout:   10 * time.Second,
            ResponseHeaderTimeout: 30 * time.Second,
            ForceAttemptHTTP2:     true,
        }

    case BatchProcessing:
        return &http.Transport{
            DialContext: (&net.Dialer{
                Timeout:   30 * time.Second,
                KeepAlive: 60 * time.Second,
            }).DialContext,
            MaxIdleConns:          50,
            MaxIdleConnsPerHost:   5,
            MaxConnsPerHost:       10,
            IdleConnTimeout:       120 * time.Second,
            TLSHandshakeTimeout:   15 * time.Second,
            ResponseHeaderTimeout: 120 * time.Second,
            // Increase buffers for large payloads
            WriteBufferSize:       64 * 1024,
            ReadBufferSize:        64 * 1024,
            ForceAttemptHTTP2:     false, // HTTP/1.1 for large file transfers
        }

    default:
        return http.DefaultTransport.(*http.Transport).Clone()
    }
}
```

## Summary

Correct `http.Transport` configuration is foundational for Go services making outbound HTTP calls at scale. The key takeaways are:

- Set `MaxIdleConnsPerHost` based on `rps * avg_latency_seconds * burst_factor` — the default value of 2 is almost always wrong for production services
- Use all five timeout layers deliberately: dial, TLS, response header, request context, and client timeout serve different purposes
- HTTP/2 multiplexing changes the connection pool math — a small number of connections handles many concurrent streams
- Always drain response bodies before closing to enable connection reuse
- Instrument transports with `httptrace` or a metrics-aware `RoundTripper` to detect pool exhaustion before it causes outages
- Size `MaxConnsPerHost` to protect upstream services during bursts rather than leaving it unlimited
