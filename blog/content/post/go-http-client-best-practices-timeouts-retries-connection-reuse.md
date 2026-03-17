---
title: "Go HTTP Client Best Practices: Timeouts, Retries, and Connection Reuse"
date: 2031-04-11T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "HTTP", "Performance", "Networking", "Best Practices", "Production"]
categories:
- Go
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Go HTTP client configuration covering Transport tuning, per-request context deadlines, retry-after header handling, connection pool monitoring, and comprehensive testing with httptest for production-grade HTTP clients."
more_link: "yes"
url: "/go-http-client-best-practices-timeouts-retries-connection-reuse/"
---

Misconfigured HTTP clients are among the most common sources of production incidents in Go services. Default settings leave connection pools unbounded, requests without timeouts, and retries without backoff. This guide covers every layer of Go HTTP client configuration, from Transport-level connection pool tuning to context-based deadlines, retry logic with respect for Retry-After headers, connection pool monitoring, and thorough testing strategies.

<!--more-->

# Go HTTP Client Best Practices: Timeouts, Retries, and Connection Reuse

## Section 1: Understanding the Default Client's Problems

The `http.DefaultClient` is intentionally minimal for simplicity, but using it in production is dangerous:

```go
package main

import (
    "fmt"
    "net/http"
    "time"
)

func demonstrateDefaultClientProblems() {
    // DO NOT USE IN PRODUCTION
    // http.DefaultClient has NO timeouts set
    // This request can hang forever
    resp, err := http.Get("https://example.com")
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()

    // Problems with default client:
    // 1. No connection timeout - can hang forever establishing TCP
    // 2. No response header timeout - server can stall after accepting connection
    // 3. No response body timeout - slow body reads never time out
    // 4. Unlimited connection pool - can exhaust file descriptors
    // 5. No idle connection timeout - stale connections return errors
    fmt.Println("This is dangerous in production")
}

// The DefaultTransport settings:
// MaxIdleConns: 100
// MaxIdleConnsPerHost: 2 (too low for high-throughput services!)
// IdleConnTimeout: 90s
// TLSHandshakeTimeout: 10s
// ExpectContinueTimeout: 1s
// No DialTimeout, no ResponseHeaderTimeout, no overall timeout
_ = time.Second // silence unused import
```

## Section 2: Transport Configuration

The `http.Transport` is the heart of connection management. Every production client needs a carefully tuned Transport:

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

// TransportConfig holds all transport configuration
type TransportConfig struct {
    // Connection pool settings
    MaxIdleConns          int
    MaxIdleConnsPerHost   int
    MaxConnsPerHost       int
    IdleConnTimeout       time.Duration

    // Timeout settings
    DialTimeout           time.Duration
    KeepAlive             time.Duration
    TLSHandshakeTimeout   time.Duration
    ResponseHeaderTimeout time.Duration
    ExpectContinueTimeout time.Duration

    // TLS settings
    TLSConfig             *tls.Config

    // Proxy settings
    DisableCompression    bool
    ForceHTTP2            bool
}

// DefaultTransportConfig returns production-safe defaults
func DefaultTransportConfig() TransportConfig {
    return TransportConfig{
        // Pool sizing: tune MaxIdleConnsPerHost to match your QPS per host
        // Rule of thumb: peak_rps * average_latency_seconds * 1.2
        // For 1000 RPS at 50ms avg latency: 1000 * 0.05 * 1.2 = 60
        MaxIdleConns:        200,
        MaxIdleConnsPerHost: 50,
        MaxConnsPerHost:     100, // Hard cap to prevent connection storms

        // Keep connections alive but recycle them regularly
        // Set shorter than server-side idle timeout to avoid "connection reset"
        IdleConnTimeout: 60 * time.Second,

        // TCP connection establishment
        DialTimeout: 5 * time.Second,
        KeepAlive:   30 * time.Second,

        // TLS negotiation after TCP connect
        TLSHandshakeTimeout: 5 * time.Second,

        // Time to receive response headers after sending request body
        // This catches slow/hung servers
        ResponseHeaderTimeout: 30 * time.Second,

        // HTTP 100-continue wait time (for POST with large bodies)
        ExpectContinueTimeout: 1 * time.Second,
    }
}

// NewTransport creates a configured HTTP transport
func NewTransport(cfg TransportConfig) *http.Transport {
    dialer := &net.Dialer{
        Timeout:   cfg.DialTimeout,
        KeepAlive: cfg.KeepAlive,
        // DualStack enables both IPv4 and IPv6 (Happy Eyeballs)
        // This avoids hangs when one address family is unreachable
        DualStack: true,
        // Resolver configuration for DNS caching control
        Resolver: &net.Resolver{
            PreferGo: true,
        },
    }

    tlsConfig := cfg.TLSConfig
    if tlsConfig == nil {
        tlsConfig = &tls.Config{
            MinVersion: tls.VersionTLS12,
            // Modern cipher suites only - no RC4, 3DES, etc.
            CipherSuites: []uint16{
                tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
                tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
                tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
                tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
                tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
                tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
            },
        }
    }

    t := &http.Transport{
        DialContext:           dialer.DialContext,
        MaxIdleConns:          cfg.MaxIdleConns,
        MaxIdleConnsPerHost:   cfg.MaxIdleConnsPerHost,
        MaxConnsPerHost:       cfg.MaxConnsPerHost,
        IdleConnTimeout:       cfg.IdleConnTimeout,
        TLSHandshakeTimeout:   cfg.TLSHandshakeTimeout,
        ResponseHeaderTimeout: cfg.ResponseHeaderTimeout,
        ExpectContinueTimeout: cfg.ExpectContinueTimeout,
        TLSClientConfig:       tlsConfig,
        DisableCompression:    cfg.DisableCompression,
        // ForceAttemptHTTP2 enables HTTP/2 for non-TLS connections
        ForceAttemptHTTP2: cfg.ForceHTTP2,
        // WriteBufferSize and ReadBufferSize tuning for large payloads
        WriteBufferSize: 32 * 1024,
        ReadBufferSize:  32 * 1024,
    }

    return t
}

// NewClient creates a production-ready HTTP client
func NewClient(cfg TransportConfig, timeout time.Duration) *http.Client {
    return &http.Client{
        Transport: NewTransport(cfg),
        // Overall timeout: this covers entire request lifecycle
        // Use context for per-request control instead
        // Set a reasonable default that prevents zombies
        Timeout: timeout,
        // CheckRedirect controls redirect behavior
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            if len(via) >= 5 {
                return http.ErrUseLastResponse
            }
            // Preserve Authorization header across redirects to same host
            if len(via) > 0 && req.URL.Host != via[0].URL.Host {
                // Strip auth headers when redirecting to different host
                req.Header.Del("Authorization")
            }
            return nil
        },
    }
}

// WithConnectionTrace adds httptrace to a request for debugging
func WithConnectionTrace(ctx context.Context) context.Context {
    trace := &httptrace.ClientTrace{
        GetConn: func(hostPort string) {
            // log.Printf("Getting connection for %s", hostPort)
        },
        GotConn: func(info httptrace.GotConnInfo) {
            // log.Printf("Got connection: reused=%v, wasIdle=%v, idleTime=%v",
            //     info.Reused, info.WasIdle, info.IdleTime)
        },
        ConnectStart: func(network, addr string) {
            // log.Printf("Connecting to %s %s", network, addr)
        },
        ConnectDone: func(network, addr string, err error) {
            if err != nil {
                // log.Printf("Connection failed to %s %s: %v", network, addr, err)
            }
        },
        TLSHandshakeStart: func() {
            // log.Printf("TLS handshake starting")
        },
        TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
            if err != nil {
                // log.Printf("TLS handshake failed: %v", err)
            }
        },
        WroteRequest: func(info httptrace.WroteRequestInfo) {
            if info.Err != nil {
                // log.Printf("Write request error: %v", info.Err)
            }
        },
    }
    return httptrace.WithClientTrace(ctx, trace)
}
```

## Section 3: Per-Request Context Deadlines

Using `client.Timeout` sets a global timeout, but per-request context deadlines provide finer control and proper cancellation propagation:

```go
package httpclient

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"
)

// RequestConfig configures a single request
type RequestConfig struct {
    // Timeout for this specific request
    Timeout time.Duration

    // Headers to add to every request
    Headers map[string]string

    // Body size limit (0 = unlimited, dangerous!)
    MaxResponseBytes int64
}

// DoWithContext executes an HTTP request with context-based timeout
func DoWithContext(ctx context.Context, client *http.Client, req *http.Request, cfg RequestConfig) (*http.Response, error) {
    // Apply per-request timeout via context
    // This is more flexible than client.Timeout because:
    // 1. Different endpoints can have different timeouts
    // 2. Remaining time from parent context is respected
    // 3. Cancellation propagates through entire call chain
    if cfg.Timeout > 0 {
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, cfg.Timeout)
        defer cancel()
    }

    // Apply headers
    for k, v := range cfg.Headers {
        req.Header.Set(k, v)
    }

    // Associate context with request
    req = req.WithContext(ctx)

    resp, err := client.Do(req)
    if err != nil {
        // Provide context about whether it was a timeout
        if ctx.Err() != nil {
            return nil, fmt.Errorf("request timed out after %v: %w", cfg.Timeout, ctx.Err())
        }
        return nil, err
    }

    // Protect against giant responses
    if cfg.MaxResponseBytes > 0 {
        resp.Body = io.NopCloser(
            io.LimitReader(resp.Body, cfg.MaxResponseBytes),
        )
    }

    return resp, nil
}

// JSONDo performs a JSON request with full lifecycle management
func JSONDo[T any](ctx context.Context, client *http.Client, method, url string, body any, cfg RequestConfig) (T, error) {
    var result T

    // Encode body
    var bodyReader io.Reader
    if body != nil {
        data, err := json.Marshal(body)
        if err != nil {
            return result, fmt.Errorf("marshaling request body: %w", err)
        }
        bodyReader = bytes.NewReader(data)
    }

    req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
    if err != nil {
        return result, fmt.Errorf("creating request: %w", err)
    }

    if body != nil {
        req.Header.Set("Content-Type", "application/json")
    }
    req.Header.Set("Accept", "application/json")

    // Default to 30s if not set
    if cfg.Timeout == 0 {
        cfg.Timeout = 30 * time.Second
    }

    // Default max response to 10MB
    if cfg.MaxResponseBytes == 0 {
        cfg.MaxResponseBytes = 10 * 1024 * 1024
    }

    resp, err := DoWithContext(ctx, client, req, cfg)
    if err != nil {
        return result, err
    }
    defer resp.Body.Close()

    // Read limited body
    respBody, err := io.ReadAll(resp.Body)
    if err != nil {
        return result, fmt.Errorf("reading response body: %w", err)
    }

    if resp.StatusCode >= 400 {
        return result, &HTTPError{
            StatusCode: resp.StatusCode,
            Body:       respBody,
            URL:        url,
            Method:     method,
        }
    }

    if err := json.Unmarshal(respBody, &result); err != nil {
        return result, fmt.Errorf("unmarshaling response (status %d): %w", resp.StatusCode, err)
    }

    return result, nil
}

// HTTPError represents an HTTP error response
type HTTPError struct {
    StatusCode int
    Body       []byte
    URL        string
    Method     string
}

func (e *HTTPError) Error() string {
    return fmt.Sprintf("HTTP %d %s %s: %s", e.StatusCode, e.Method, e.URL, string(e.Body))
}

func (e *HTTPError) IsClientError() bool {
    return e.StatusCode >= 400 && e.StatusCode < 500
}

func (e *HTTPError) IsServerError() bool {
    return e.StatusCode >= 500
}

func (e *HTTPError) IsRetryable() bool {
    switch e.StatusCode {
    case http.StatusTooManyRequests,
        http.StatusBadGateway,
        http.StatusServiceUnavailable,
        http.StatusGatewayTimeout:
        return true
    }
    return false
}
```

## Section 4: Retry Logic with Retry-After Header Handling

```go
package httpclient

import (
    "context"
    "errors"
    "fmt"
    "math"
    "math/rand"
    "net/http"
    "strconv"
    "time"
)

// RetryConfig configures retry behavior
type RetryConfig struct {
    // MaxAttempts is total attempts (1 = no retry)
    MaxAttempts int

    // InitialDelay is base delay before first retry
    InitialDelay time.Duration

    // MaxDelay caps the exponential backoff
    MaxDelay time.Duration

    // Multiplier for exponential backoff (typically 2.0)
    Multiplier float64

    // Jitter fraction to randomize delay (0.0-1.0)
    // Helps prevent thundering herd
    JitterFraction float64

    // RetryableStatusCodes defines which HTTP status codes trigger retry
    // If nil, defaults to 429, 502, 503, 504
    RetryableStatusCodes []int

    // ShouldRetry allows custom retry logic beyond status codes
    ShouldRetry func(resp *http.Response, err error) bool

    // OnRetry is called before each retry (useful for logging/metrics)
    OnRetry func(attempt int, delay time.Duration, resp *http.Response, err error)
}

// DefaultRetryConfig returns sensible production defaults
func DefaultRetryConfig() RetryConfig {
    return RetryConfig{
        MaxAttempts:          4,
        InitialDelay:         100 * time.Millisecond,
        MaxDelay:             30 * time.Second,
        Multiplier:           2.0,
        JitterFraction:       0.25,
        RetryableStatusCodes: []int{429, 502, 503, 504},
    }
}

// RetryableClient wraps http.Client with retry logic
type RetryableClient struct {
    client      *http.Client
    retryConfig RetryConfig
}

// NewRetryableClient creates a client with retry support
func NewRetryableClient(client *http.Client, cfg RetryConfig) *RetryableClient {
    if cfg.MaxAttempts <= 0 {
        cfg.MaxAttempts = 1
    }
    return &RetryableClient{
        client:      client,
        retryConfig: cfg,
    }
}

// Do executes a request with retries
func (r *RetryableClient) Do(ctx context.Context, makeRequest func() (*http.Request, error)) (*http.Response, error) {
    var (
        lastResp *http.Response
        lastErr  error
    )

    for attempt := 0; attempt < r.retryConfig.MaxAttempts; attempt++ {
        if attempt > 0 {
            delay := r.calculateDelay(attempt, lastResp)

            // Respect context cancellation during delay
            select {
            case <-ctx.Done():
                return nil, fmt.Errorf("context cancelled during retry delay: %w", ctx.Err())
            case <-time.After(delay):
            }

            // Notify retry observer
            if r.retryConfig.OnRetry != nil {
                r.retryConfig.OnRetry(attempt, delay, lastResp, lastErr)
            }

            // Close previous response body if we're retrying
            if lastResp != nil {
                lastResp.Body.Close()
                lastResp = nil
            }
        }

        // Create fresh request for each attempt
        // This is critical: request bodies are streams and cannot be re-read
        req, err := makeRequest()
        if err != nil {
            return nil, fmt.Errorf("creating request for attempt %d: %w", attempt+1, err)
        }
        req = req.WithContext(ctx)

        resp, err := r.client.Do(req)
        lastErr = err
        lastResp = resp

        if err != nil {
            if !r.isRetryableError(err) {
                return nil, err
            }
            continue
        }

        if !r.shouldRetry(resp) {
            return resp, nil
        }
    }

    if lastResp != nil {
        return lastResp, nil
    }
    return nil, fmt.Errorf("all %d attempts failed, last error: %w", r.retryConfig.MaxAttempts, lastErr)
}

// calculateDelay computes the retry delay respecting Retry-After header
func (r *RetryableClient) calculateDelay(attempt int, resp *http.Response) time.Duration {
    // First, check if server provided a Retry-After header
    if resp != nil {
        if delay, ok := parseRetryAfter(resp); ok {
            // Cap at MaxDelay
            if delay > r.retryConfig.MaxDelay {
                return r.retryConfig.MaxDelay
            }
            return delay
        }
    }

    // Exponential backoff: initialDelay * multiplier^(attempt-1)
    delay := float64(r.retryConfig.InitialDelay) * math.Pow(r.retryConfig.Multiplier, float64(attempt-1))

    // Apply jitter to spread out retries
    // Full jitter: delay = random(0, delay)
    // This is better than "equal jitter" for reducing thundering herd
    if r.retryConfig.JitterFraction > 0 {
        jitter := rand.Float64() * r.retryConfig.JitterFraction * delay
        // Add or subtract jitter randomly
        if rand.Intn(2) == 0 {
            delay += jitter
        } else {
            delay -= jitter
        }
    }

    result := time.Duration(delay)

    // Clamp to MaxDelay
    if result > r.retryConfig.MaxDelay {
        result = r.retryConfig.MaxDelay
    }

    // Ensure positive delay
    if result < time.Millisecond {
        result = time.Millisecond
    }

    return result
}

// parseRetryAfter parses the Retry-After header
// Supports both delay-seconds (integer) and HTTP-date formats
func parseRetryAfter(resp *http.Response) (time.Duration, bool) {
    header := resp.Header.Get("Retry-After")
    if header == "" {
        return 0, false
    }

    // Try parsing as integer seconds first
    if seconds, err := strconv.ParseFloat(header, 64); err == nil {
        if seconds < 0 {
            return 0, false
        }
        return time.Duration(seconds * float64(time.Second)), true
    }

    // Try parsing as HTTP-date
    if t, err := http.ParseTime(header); err == nil {
        delay := time.Until(t)
        if delay > 0 {
            return delay, true
        }
        return 0, false
    }

    return 0, false
}

// shouldRetry determines if a successful HTTP response should be retried
func (r *RetryableClient) shouldRetry(resp *http.Response) bool {
    // Check custom retry logic first
    if r.retryConfig.ShouldRetry != nil {
        return r.retryConfig.ShouldRetry(resp, nil)
    }

    // Check status code list
    for _, code := range r.retryConfig.RetryableStatusCodes {
        if resp.StatusCode == code {
            return true
        }
    }

    return false
}

// isRetryableError determines if a network error is retryable
func (r *RetryableClient) isRetryableError(err error) bool {
    // Custom logic takes precedence
    if r.retryConfig.ShouldRetry != nil {
        return r.retryConfig.ShouldRetry(nil, err)
    }

    // Never retry context cancellations - those are intentional
    if errors.Is(err, context.Canceled) {
        return false
    }

    // Retry timeouts (these may be transient)
    if errors.Is(err, context.DeadlineExceeded) {
        return false // Deadline exceeded means we're out of time
    }

    // Check for net.Error timeout (different from context timeout)
    var netErr interface{ Timeout() bool }
    if errors.As(err, &netErr) && netErr.Timeout() {
        return true
    }

    // Retry temporary network errors
    var tempErr interface{ Temporary() bool }
    if errors.As(err, &tempErr) && tempErr.Temporary() {
        return true
    }

    return false
}
```

## Section 5: Connection Pool Monitoring

Monitoring connection pool health is critical for diagnosing bottlenecks:

```go
package httpclient

import (
    "context"
    "net/http"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// PoolMetrics tracks connection pool statistics
type PoolMetrics struct {
    mu              sync.Mutex
    connsInUse      int64
    connsIdle       int64
    connWaits       int64
    connWaitDur     time.Duration
    totalConns      int64
    failedConns     int64
}

// InstrumentedTransport wraps Transport with Prometheus metrics
type InstrumentedTransport struct {
    base           http.RoundTripper
    name           string

    // Prometheus metrics
    requestsTotal   *prometheus.CounterVec
    requestDuration *prometheus.HistogramVec
    requestsInFlight prometheus.Gauge
    connectionReuse *prometheus.CounterVec
    dnsLookupDur   prometheus.Histogram
    tlsHandshakeDur prometheus.Histogram
    connEstablishDur prometheus.Histogram
}

// NewInstrumentedTransport creates a transport with full observability
func NewInstrumentedTransport(base http.RoundTripper, name string, reg prometheus.Registerer) *InstrumentedTransport {
    factory := promauto.With(reg)

    return &InstrumentedTransport{
        base: base,
        name: name,

        requestsTotal: factory.NewCounterVec(prometheus.CounterOpts{
            Name: "http_client_requests_total",
            Help: "Total HTTP client requests",
        }, []string{"client", "method", "host", "status_class"}),

        requestDuration: factory.NewHistogramVec(prometheus.HistogramOpts{
            Name:    "http_client_request_duration_seconds",
            Help:    "HTTP client request duration",
            Buckets: prometheus.DefBuckets,
        }, []string{"client", "method", "host", "status_class"}),

        requestsInFlight: factory.NewGauge(prometheus.GaugeOpts{
            Name:        "http_client_requests_in_flight",
            Help:        "Current in-flight HTTP client requests",
            ConstLabels: prometheus.Labels{"client": name},
        }),

        connectionReuse: factory.NewCounterVec(prometheus.CounterOpts{
            Name: "http_client_connection_reuse_total",
            Help: "HTTP client connection reuse count",
        }, []string{"client", "reused", "was_idle"}),

        dnsLookupDur: factory.NewHistogram(prometheus.HistogramOpts{
            Name:        "http_client_dns_lookup_duration_seconds",
            Help:        "DNS lookup duration",
            Buckets:     []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1},
            ConstLabels: prometheus.Labels{"client": name},
        }),

        tlsHandshakeDur: factory.NewHistogram(prometheus.HistogramOpts{
            Name:        "http_client_tls_handshake_duration_seconds",
            Help:        "TLS handshake duration",
            Buckets:     []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1},
            ConstLabels: prometheus.Labels{"client": name},
        }),

        connEstablishDur: factory.NewHistogram(prometheus.HistogramOpts{
            Name:        "http_client_connection_establish_duration_seconds",
            Help:        "TCP connection establishment duration",
            Buckets:     []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5},
            ConstLabels: prometheus.Labels{"client": name},
        }),
    }
}

// RoundTrip implements http.RoundTripper with instrumentation
func (t *InstrumentedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    start := time.Now()
    t.requestsInFlight.Inc()
    defer t.requestsInFlight.Dec()

    // Track timing via httptrace
    var (
        dnsStart    time.Time
        tlsStart    time.Time
        connStart   time.Time
        gotConn     bool
        connReused  bool
        wasIdle     bool
    )

    ctx := req.Context()
    trace := &httptrace.ClientTrace{
        DNSStart: func(_ httptrace.DNSStartInfo) {
            dnsStart = time.Now()
        },
        DNSDone: func(_ httptrace.DNSDoneInfo) {
            if !dnsStart.IsZero() {
                t.dnsLookupDur.Observe(time.Since(dnsStart).Seconds())
            }
        },
        ConnectStart: func(_, _ string) {
            connStart = time.Now()
        },
        ConnectDone: func(_, _ string, _ error) {
            if !connStart.IsZero() {
                t.connEstablishDur.Observe(time.Since(connStart).Seconds())
            }
        },
        TLSHandshakeStart: func() {
            tlsStart = time.Now()
        },
        TLSHandshakeDone: func(_ tls.ConnectionState, _ error) {
            if !tlsStart.IsZero() {
                t.tlsHandshakeDur.Observe(time.Since(tlsStart).Seconds())
            }
        },
        GotConn: func(info httptrace.GotConnInfo) {
            gotConn = true
            connReused = info.Reused
            wasIdle = info.WasIdle
        },
    }

    req = req.WithContext(httptrace.WithClientTrace(ctx, trace))

    resp, err := t.base.RoundTrip(req)

    duration := time.Since(start)
    host := req.URL.Host
    method := req.Method

    if gotConn {
        t.connectionReuse.With(prometheus.Labels{
            "client":   t.name,
            "reused":   boolLabel(connReused),
            "was_idle": boolLabel(wasIdle),
        }).Inc()
    }

    statusClass := "error"
    if err == nil {
        statusClass = statusClass2xx(resp.StatusCode)
    }

    t.requestsTotal.With(prometheus.Labels{
        "client":       t.name,
        "method":       method,
        "host":         host,
        "status_class": statusClass,
    }).Inc()

    t.requestDuration.With(prometheus.Labels{
        "client":       t.name,
        "method":       method,
        "host":         host,
        "status_class": statusClass,
    }).Observe(duration.Seconds())

    return resp, err
}

func boolLabel(b bool) string {
    if b {
        return "true"
    }
    return "false"
}

func statusClass2xx(code int) string {
    switch {
    case code >= 200 && code < 300:
        return "2xx"
    case code >= 300 && code < 400:
        return "3xx"
    case code >= 400 && code < 500:
        return "4xx"
    case code >= 500:
        return "5xx"
    default:
        return "unknown"
    }
}

// ConnectionPoolStats returns current pool statistics
// Useful for health checks and debugging
func ConnectionPoolStats(client *http.Client) map[string]interface{} {
    t, ok := client.Transport.(*http.Transport)
    if !ok {
        return nil
    }

    // Use reflection or the undocumented internal stats
    // In Go 1.21+, use Transport.IdleConnCount/ConnStats
    stats := make(map[string]interface{})

    // You can monitor these via expvar or custom metrics
    // The transport doesn't expose direct pool stats publicly
    // but you can track them via httptrace in production

    _ = t
    return stats
}
```

## Section 6: Common Timeout Mistakes and How to Avoid Them

```go
package httpclient

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "time"
)

// MistakeExamples documents common timeout mistakes
// DO NOT USE these patterns in production

// Mistake 1: Not reading the response body
// This leaks connections - they can't be reused until body is consumed
func badBodyHandling(client *http.Client, url string) error {
    resp, err := client.Get(url)
    if err != nil {
        return err
    }
    // BUG: body not read, connection cannot be reused
    // defer resp.Body.Close() without reading first
    defer resp.Body.Close()
    return nil
}

// Correct: Always drain body before closing
func goodBodyHandling(client *http.Client, url string) error {
    resp, err := client.Get(url)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    // Drain the body to allow connection reuse
    // io.Discard is efficient - it doesn't allocate
    if _, err := io.Copy(io.Discard, resp.Body); err != nil {
        return fmt.Errorf("draining response body: %w", err)
    }
    return nil
}

// Mistake 2: Setting timeout on client AND context
// The shorter one wins, which can be confusing
func confusingTimeoutLayers(url string) {
    client := &http.Client{
        Timeout: 30 * time.Second, // Client-level timeout
    }

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second) // Context timeout
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
    // The 5-second context timeout wins here
    // If you meant 30 seconds, remove the context timeout
    // If you meant 5 seconds, remove client.Timeout
    resp, err := client.Do(req)
    if err != nil {
        // Error might say "context deadline exceeded" but which one?
        // Very confusing to debug
        _ = err
    }
    if resp != nil {
        resp.Body.Close()
    }
}

// Correct: Use context for per-request timeouts, no client.Timeout
func correctTimeoutLayers(client *http.Client, url string, timeout time.Duration) error {
    ctx, cancel := context.WithTimeout(context.Background(), timeout)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return err
    }

    resp, err := client.Do(req)
    if err != nil {
        if ctx.Err() != nil {
            return fmt.Errorf("request to %s timed out after %v: %w", url, timeout, ctx.Err())
        }
        return fmt.Errorf("request to %s failed: %w", url, err)
    }
    defer resp.Body.Close()

    if _, err := io.Copy(io.Discard, resp.Body); err != nil {
        return fmt.Errorf("reading response: %w", err)
    }
    return nil
}

// Mistake 3: Using http.DefaultClient with no timeout for health checks
// Even health checks can hang and block goroutines
func badHealthCheck(targetURL string) bool {
    resp, err := http.DefaultClient.Get(targetURL) // No timeout!
    if err != nil {
        return false
    }
    defer resp.Body.Close()
    io.Copy(io.Discard, resp.Body)
    return resp.StatusCode == 200
}

// Correct: Dedicated health check client with short timeout
var healthCheckClient = &http.Client{
    Timeout: 5 * time.Second,
    Transport: &http.Transport{
        DialContext: (&net.Dialer{
            Timeout: 2 * time.Second,
        }).DialContext,
        TLSHandshakeTimeout: 2 * time.Second,
        MaxIdleConns:        10,
        MaxIdleConnsPerHost: 2,
    },
}

func goodHealthCheck(targetURL string) bool {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
    if err != nil {
        return false
    }

    resp, err := healthCheckClient.Do(req)
    if err != nil {
        return false
    }
    defer resp.Body.Close()
    io.Copy(io.Discard, resp.Body)
    return resp.StatusCode == 200
}

// Mistake 4: Creating a new client per request
// This defeats connection pooling entirely
func badClientPerRequest(urls []string) {
    for _, url := range urls {
        client := &http.Client{} // New client = new pool = no reuse
        resp, err := client.Get(url)
        if err != nil {
            continue
        }
        defer resp.Body.Close()
    }
}
```

## Section 7: Testing with httptest

```go
package httpclient_test

import (
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "sync/atomic"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// TestRetryOnServerError validates retry behavior
func TestRetryOnServerError(t *testing.T) {
    var attempts int32

    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        attempt := atomic.AddInt32(&attempts, 1)
        if attempt < 3 {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
    }))
    defer server.Close()

    client := NewClient(DefaultTransportConfig(), 30*time.Second)
    retryClient := NewRetryableClient(client, RetryConfig{
        MaxAttempts:          4,
        InitialDelay:         10 * time.Millisecond,
        MaxDelay:             100 * time.Millisecond,
        Multiplier:           2.0,
        JitterFraction:       0,
        RetryableStatusCodes: []int{503},
    })

    resp, err := retryClient.Do(context.Background(), func() (*http.Request, error) {
        return http.NewRequest("GET", server.URL+"/api", nil)
    })
    require.NoError(t, err)
    defer resp.Body.Close()

    assert.Equal(t, http.StatusOK, resp.StatusCode)
    assert.Equal(t, int32(3), atomic.LoadInt32(&attempts))
}

// TestRetryAfterHeaderRespected validates Retry-After parsing
func TestRetryAfterHeaderRespected(t *testing.T) {
    var retryCount int32
    retryDelay := 50 * time.Millisecond

    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if atomic.AddInt32(&retryCount, 1) == 1 {
            w.Header().Set("Retry-After", "0.05") // 50ms in seconds
            w.WriteHeader(http.StatusTooManyRequests)
            return
        }
        w.WriteHeader(http.StatusOK)
    }))
    defer server.Close()

    client := NewClient(DefaultTransportConfig(), 30*time.Second)
    retryClient := NewRetryableClient(client, RetryConfig{
        MaxAttempts:          3,
        InitialDelay:         500 * time.Millisecond, // Would be 500ms without Retry-After
        MaxDelay:             5 * time.Second,
        Multiplier:           2.0,
        RetryableStatusCodes: []int{429},
    })

    start := time.Now()
    resp, err := retryClient.Do(context.Background(), func() (*http.Request, error) {
        return http.NewRequest("GET", server.URL, nil)
    })
    elapsed := time.Since(start)

    require.NoError(t, err)
    defer resp.Body.Close()

    // Should have respected the 50ms Retry-After, not waited 500ms
    assert.True(t, elapsed >= retryDelay, "should have waited at least %v", retryDelay)
    assert.True(t, elapsed < 400*time.Millisecond, "should not have waited 500ms, Retry-After should reduce delay")
    assert.Equal(t, http.StatusOK, resp.StatusCode)
}

// TestContextCancellation validates context propagation
func TestContextCancellation(t *testing.T) {
    slowServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        select {
        case <-r.Context().Done():
            // Client cancelled, server sees it
            return
        case <-time.After(10 * time.Second):
            w.WriteHeader(http.StatusOK)
        }
    }))
    defer slowServer.Close()

    client := NewClient(DefaultTransportConfig(), 30*time.Second)

    ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
    defer cancel()

    start := time.Now()
    req, _ := http.NewRequestWithContext(ctx, "GET", slowServer.URL, nil)
    _, err := client.Do(req)
    elapsed := time.Since(start)

    assert.Error(t, err)
    assert.True(t, elapsed < 500*time.Millisecond, "should cancel quickly, took %v", elapsed)
}

// TestConnectionReuse validates pool behavior
func TestConnectionReuse(t *testing.T) {
    var connectionCount int32

    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    }))
    defer server.Close()

    // Track new connections using custom transport
    transport := &connectionCountingTransport{
        base:  &http.Transport{MaxIdleConnsPerHost: 10},
        count: &connectionCount,
    }

    client := &http.Client{Transport: transport}

    // Make 10 sequential requests
    for i := 0; i < 10; i++ {
        resp, err := client.Get(server.URL)
        require.NoError(t, err)
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()
    }

    // With connection reuse, should have far fewer than 10 new connections
    newConns := atomic.LoadInt32(&connectionCount)
    t.Logf("New connections for 10 requests: %d", newConns)
    assert.True(t, newConns <= 2, "expected connection reuse, got %d new connections", newConns)
}

// TestSlowHeaderTimeout validates ResponseHeaderTimeout
func TestSlowHeaderTimeout(t *testing.T) {
    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Delay before sending any response (simulates slow backend)
        time.Sleep(2 * time.Second)
        w.WriteHeader(http.StatusOK)
    }))
    defer server.Close()

    cfg := DefaultTransportConfig()
    cfg.ResponseHeaderTimeout = 100 * time.Millisecond // Very short

    client := NewClient(cfg, 30*time.Second)

    start := time.Now()
    resp, err := client.Get(server.URL)
    elapsed := time.Since(start)

    assert.Error(t, err, "should have timed out")
    assert.True(t, elapsed < 500*time.Millisecond, "should timeout quickly, took %v", elapsed)
    if resp != nil {
        resp.Body.Close()
    }
}

// connectionCountingTransport counts new TCP connections
type connectionCountingTransport struct {
    base  http.RoundTripper
    count *int32
}

func (t *connectionCountingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    ctx := httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
        ConnectDone: func(_, _ string, err error) {
            if err == nil {
                atomic.AddInt32(t.count, 1)
            }
        },
    })
    return t.base.RoundTrip(req.WithContext(ctx))
}
```

## Section 8: Complete Production Client

```go
package httpclient

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// Client is the production-ready HTTP client
type Client struct {
    raw        *RetryableClient
    baseURL    string
    headers    map[string]string
    reqTimeout time.Duration
    maxRespBytes int64
}

// ClientBuilder builds a production HTTP client
type ClientBuilder struct {
    transportCfg  TransportConfig
    retryCfg      RetryConfig
    clientTimeout time.Duration
    baseURL       string
    headers       map[string]string
    reqTimeout    time.Duration
    maxRespBytes  int64
    registry      prometheus.Registerer
    clientName    string
}

// NewClientBuilder returns a builder with production defaults
func NewClientBuilder(name string) *ClientBuilder {
    return &ClientBuilder{
        transportCfg:  DefaultTransportConfig(),
        retryCfg:      DefaultRetryConfig(),
        clientTimeout: 0, // Use per-request timeouts only
        reqTimeout:    30 * time.Second,
        maxRespBytes:  10 * 1024 * 1024,
        clientName:    name,
        headers:       make(map[string]string),
    }
}

func (b *ClientBuilder) WithBaseURL(url string) *ClientBuilder {
    b.baseURL = url
    return b
}

func (b *ClientBuilder) WithDefaultHeader(key, value string) *ClientBuilder {
    b.headers[key] = value
    return b
}

func (b *ClientBuilder) WithRequestTimeout(d time.Duration) *ClientBuilder {
    b.reqTimeout = d
    return b
}

func (b *ClientBuilder) WithMaxIdleConnsPerHost(n int) *ClientBuilder {
    b.transportCfg.MaxIdleConnsPerHost = n
    return b
}

func (b *ClientBuilder) WithMaxRetries(n int) *ClientBuilder {
    b.retryCfg.MaxAttempts = n
    return b
}

func (b *ClientBuilder) WithMetrics(reg prometheus.Registerer) *ClientBuilder {
    b.registry = reg
    return b
}

func (b *ClientBuilder) Build() *Client {
    transport := NewTransport(b.transportCfg)

    var roundTripper http.RoundTripper = transport
    if b.registry != nil {
        roundTripper = NewInstrumentedTransport(transport, b.clientName, b.registry)
    }

    raw := &http.Client{
        Transport: roundTripper,
        Timeout:   b.clientTimeout,
    }

    b.retryCfg.OnRetry = func(attempt int, delay time.Duration, resp *http.Response, err error) {
        statusCode := 0
        if resp != nil {
            statusCode = resp.StatusCode
        }
        fmt.Printf("client=%s attempt=%d delay=%v status=%d err=%v\n",
            b.clientName, attempt, delay, statusCode, err)
    }

    return &Client{
        raw:          NewRetryableClient(raw, b.retryCfg),
        baseURL:      b.baseURL,
        headers:      b.headers,
        reqTimeout:   b.reqTimeout,
        maxRespBytes: b.maxRespBytes,
    }
}

// Get performs a GET request
func (c *Client) Get(ctx context.Context, path string) (*http.Response, error) {
    ctx, cancel := context.WithTimeout(ctx, c.reqTimeout)
    defer cancel()

    url := c.baseURL + path
    return c.raw.Do(ctx, func() (*http.Request, error) {
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
        if err != nil {
            return nil, err
        }
        for k, v := range c.headers {
            req.Header.Set(k, v)
        }
        return req, nil
    })
}
```

Properly configured Go HTTP clients are not merely a performance concern — they are a reliability concern. Misconfigured timeouts allow goroutines to accumulate until a service exhausts memory. Lack of retry logic causes avoidable errors during transient network hiccups. Connection pool exhaustion causes cascading failures across dependent services. The patterns in this guide provide a solid foundation for building Go services that behave correctly under production load and failure conditions.
