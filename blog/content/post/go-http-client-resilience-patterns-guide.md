---
title: "Go HTTP Client Resilience: Retries, Circuit Breakers, and Connection Pool Tuning"
date: 2027-09-11T00:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Resilience", "Microservices"]
categories:
- Go
- Backend
author: "Matthew Mattox - mmattox@support.tools"
description: "Building resilient Go HTTP clients: custom Transport configuration, connection pool tuning, retry with exponential backoff, circuit breaker with sony/gobreaker, timeout hierarchy, and OpenTelemetry tracing."
more_link: "yes"
url: "/go-http-client-resilience-patterns-guide/"
---

The default `http.Client` in Go is designed for correctness, not production resilience. It has no retry logic, no circuit breaking, and connection pool defaults tuned for low-concurrency use cases. A microservice that calls ten downstream APIs with the default client will suffer cascading failures the first time any one of those APIs slows down. This guide replaces those defaults with a production-grade HTTP client stack: custom Transport, connection pool tuning, retry with exponential backoff, circuit breaker, a correct timeout hierarchy, and OpenTelemetry span propagation.

<!--more-->

## Section 1: The Timeout Hierarchy

Go's `http.Client` has one `Timeout` field that applies to the entire request lifecycle. For microservices, granular timeout control is essential:

```text
Dial timeout       — TCP connection establishment
TLS handshake      — TLS negotiation after connection
Response header    — Time to first byte of response headers
Response body      — Time to read the complete response body
Total request      — End-to-end deadline (set via context)
```

```go
package httpclient

import (
    "context"
    "crypto/tls"
    "net"
    "net/http"
    "time"
)

// TransportConfig holds tunable Transport parameters.
type TransportConfig struct {
    // Connection pool
    MaxIdleConns        int
    MaxIdleConnsPerHost int
    MaxConnsPerHost     int
    IdleConnTimeout     time.Duration

    // Timeouts
    DialTimeout         time.Duration
    TLSHandshakeTimeout time.Duration
    ResponseHeaderTimeout time.Duration
    ExpectContinueTimeout time.Duration

    // TLS
    InsecureSkipVerify bool // never true in production
}

// DefaultTransportConfig returns sensible production defaults.
func DefaultTransportConfig() TransportConfig {
    return TransportConfig{
        MaxIdleConns:          200,
        MaxIdleConnsPerHost:   50,
        MaxConnsPerHost:       100,
        IdleConnTimeout:       90 * time.Second,
        DialTimeout:           5 * time.Second,
        TLSHandshakeTimeout:   10 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,
    }
}

// NewTransport builds an http.Transport with the given config.
func NewTransport(cfg TransportConfig) *http.Transport {
    dialer := &net.Dialer{
        Timeout:   cfg.DialTimeout,
        KeepAlive: 30 * time.Second,
    }
    return &http.Transport{
        DialContext:           dialer.DialContext,
        TLSHandshakeTimeout:   cfg.TLSHandshakeTimeout,
        ResponseHeaderTimeout: cfg.ResponseHeaderTimeout,
        ExpectContinueTimeout: cfg.ExpectContinueTimeout,
        MaxIdleConns:          cfg.MaxIdleConns,
        MaxIdleConnsPerHost:   cfg.MaxIdleConnsPerHost,
        MaxConnsPerHost:       cfg.MaxConnsPerHost,
        IdleConnTimeout:       cfg.IdleConnTimeout,
        DisableCompression:    false,
        ForceAttemptHTTP2:     true,
        TLSClientConfig: &tls.Config{
            MinVersion:         tls.VersionTLS12,
            InsecureSkipVerify: cfg.InsecureSkipVerify,
        },
    }
}
```

Set the total request deadline via `context.WithTimeout` at the call site, not on the client:

```go
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()

req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
resp, err := client.Do(req)
```

## Section 2: Connection Pool Tuning

The defaults (`MaxIdleConnsPerHost = 2`) are catastrophically low for microservices. When a service makes 100 concurrent requests to the same host, 98 connections are created and immediately discarded rather than returned to the pool.

```go
// Benchmark your actual concurrency profile first, then set:
// MaxIdleConnsPerHost >= expected p99 concurrent requests per host
// MaxConnsPerHost    >= expected burst concurrent requests per host

// For a service calling one upstream with ~50 concurrent requests:
transport := &http.Transport{
    MaxIdleConns:        100,
    MaxIdleConnsPerHost: 50,  // was 2 by default
    MaxConnsPerHost:     100,
    IdleConnTimeout:     90 * time.Second,
}
```

Monitor the connection pool health with `http.Transport.CloseIdleConnections()` and custom metrics:

```go
type instrumentedTransport struct {
    base    http.RoundTripper
    metrics *prometheus.CounterVec
}

func (t *instrumentedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    start := time.Now()
    resp, err := t.base.RoundTrip(req)
    duration := time.Since(start)

    host := req.URL.Host
    status := "error"
    if err == nil {
        status = fmt.Sprintf("%dxx", resp.StatusCode/100)
    }
    t.metrics.WithLabelValues(host, req.Method, status).
        Add(duration.Seconds())
    return resp, err
}
```

## Section 3: Retry with Exponential Backoff

Only retry on idempotent methods (GET, HEAD, PUT, DELETE, OPTIONS) and specific error conditions. Never retry on 4xx responses unless specifically handling 429 with Retry-After.

```go
package httpclient

import (
    "context"
    "errors"
    "fmt"
    "io"
    "math"
    "math/rand"
    "net"
    "net/http"
    "time"
)

// RetryConfig controls the retry behaviour.
type RetryConfig struct {
    MaxAttempts     int
    BaseDelay       time.Duration
    MaxDelay        time.Duration
    JitterFraction  float64 // 0.0–1.0; adds randomness to avoid thundering herd
}

// DefaultRetryConfig returns sensible production retry defaults.
func DefaultRetryConfig() RetryConfig {
    return RetryConfig{
        MaxAttempts:    3,
        BaseDelay:      100 * time.Millisecond,
        MaxDelay:       30 * time.Second,
        JitterFraction: 0.25,
    }
}

// retryTransport wraps a base RoundTripper with retry logic.
type retryTransport struct {
    base   http.RoundTripper
    config RetryConfig
}

func (rt *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    if !isIdempotent(req.Method) {
        return rt.base.RoundTrip(req)
    }

    var (
        resp *http.Response
        err  error
    )
    for attempt := 0; attempt < rt.config.MaxAttempts; attempt++ {
        if attempt > 0 {
            delay := rt.backoffDelay(attempt)
            select {
            case <-req.Context().Done():
                return nil, req.Context().Err()
            case <-time.After(delay):
            }
            // Clone the request body for retries (it may have been consumed).
            if req.Body != nil && req.GetBody != nil {
                req.Body, _ = req.GetBody()
            }
        }

        resp, err = rt.base.RoundTrip(req)
        if err != nil {
            if !isRetryableError(err) {
                return nil, err
            }
            continue
        }

        if !isRetryableStatus(resp.StatusCode) {
            return resp, nil
        }

        // Consume and discard the response body to allow connection reuse.
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()
    }
    return resp, err
}

func (rt *retryTransport) backoffDelay(attempt int) time.Duration {
    base := float64(rt.config.BaseDelay) * math.Pow(2, float64(attempt-1))
    jitter := rand.Float64() * rt.config.JitterFraction * base
    delay := time.Duration(base + jitter)
    if delay > rt.config.MaxDelay {
        delay = rt.config.MaxDelay
    }
    return delay
}

func isIdempotent(method string) bool {
    switch method {
    case http.MethodGet, http.MethodHead, http.MethodPut,
        http.MethodDelete, http.MethodOptions:
        return true
    }
    return false
}

func isRetryableError(err error) bool {
    if errors.Is(err, context.DeadlineExceeded) ||
        errors.Is(err, context.Canceled) {
        return false // do not retry on context cancellation
    }
    var netErr net.Error
    if errors.As(err, &netErr) {
        return netErr.Timeout()
    }
    return false
}

func isRetryableStatus(code int) bool {
    switch code {
    case http.StatusTooManyRequests,       // 429
        http.StatusBadGateway,             // 502
        http.StatusServiceUnavailable,     // 503
        http.StatusGatewayTimeout:         // 504
        return true
    }
    return false
}
```

### Respecting Retry-After Header

```go
func retryAfterDelay(resp *http.Response, defaultDelay time.Duration) time.Duration {
    ra := resp.Header.Get("Retry-After")
    if ra == "" {
        return defaultDelay
    }
    if seconds, err := strconv.Atoi(ra); err == nil {
        return time.Duration(seconds) * time.Second
    }
    if t, err := http.ParseTime(ra); err == nil {
        d := time.Until(t)
        if d > 0 {
            return d
        }
    }
    return defaultDelay
}
```

## Section 4: Circuit Breaker with sony/gobreaker

```bash
go get github.com/sony/gobreaker@v0.5.0
```

```go
package httpclient

import (
    "errors"
    "fmt"
    "net/http"
    "time"

    "github.com/sony/gobreaker"
)

// circuitBreakerTransport wraps a base RoundTripper with a circuit breaker.
type circuitBreakerTransport struct {
    base http.RoundTripper
    cb   *gobreaker.CircuitBreaker
}

// NewCircuitBreakerTransport creates a transport with circuit breaker protection.
// The breaker opens after 5 consecutive failures and attempts to close
// (half-open) after 30 seconds.
func NewCircuitBreakerTransport(base http.RoundTripper, name string) http.RoundTripper {
    settings := gobreaker.Settings{
        Name:        name,
        MaxRequests: 3, // max requests in half-open state
        Interval:    10 * time.Second,
        Timeout:     30 * time.Second, // time before attempting to close
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.Requests >= 3 && failureRatio >= 0.6
        },
        OnStateChange: func(name string, from, to gobreaker.State) {
            fmt.Printf("circuit breaker %s: %s -> %s\n", name, from, to)
        },
    }
    return &circuitBreakerTransport{
        base: base,
        cb:   gobreaker.NewCircuitBreaker(settings),
    }
}

func (t *circuitBreakerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    result, err := t.cb.Execute(func() (interface{}, error) {
        resp, err := t.base.RoundTrip(req)
        if err != nil {
            return nil, err
        }
        // Treat 5xx responses as circuit breaker failures.
        if resp.StatusCode >= 500 {
            return resp, fmt.Errorf("server error: %d", resp.StatusCode)
        }
        return resp, nil
    })

    if errors.Is(err, gobreaker.ErrOpenState) {
        return nil, fmt.Errorf("circuit breaker open for %s: %w",
            req.URL.Host, ErrCircuitOpen)
    }
    if errors.Is(err, gobreaker.ErrTooManyRequests) {
        return nil, fmt.Errorf("circuit breaker half-open limit: %w",
            ErrCircuitOpen)
    }
    if err != nil {
        return nil, err
    }
    return result.(*http.Response), nil
}

// ErrCircuitOpen is returned when the circuit breaker is open.
var ErrCircuitOpen = errors.New("circuit breaker open")
```

## Section 5: Composing the Transport Chain

Build the transport stack by layering RoundTrippers from inner to outer:

```go
package httpclient

import (
    "net/http"
    "time"
)

// Builder constructs a resilient HTTP client.
type Builder struct {
    transportConfig  TransportConfig
    retryConfig      RetryConfig
    circuitBreaker   bool
    cbName           string
    otelEnabled      bool
}

// NewBuilder returns a Builder with production defaults.
func NewBuilder() *Builder {
    return &Builder{
        transportConfig: DefaultTransportConfig(),
        retryConfig:     DefaultRetryConfig(),
    }
}

func (b *Builder) WithCircuitBreaker(name string) *Builder {
    b.circuitBreaker = true
    b.cbName = name
    return b
}

func (b *Builder) WithOpenTelemetry() *Builder {
    b.otelEnabled = true
    return b
}

// Build returns the configured http.Client.
// Transport layers from inner to outer:
//   1. Base Transport (connection pool, TLS, timeouts)
//   2. Retry Transport
//   3. Circuit Breaker Transport
//   4. OpenTelemetry Transport (outermost — traces include CB and retry delays)
func (b *Builder) Build() *http.Client {
    var transport http.RoundTripper = NewTransport(b.transportConfig)

    transport = &retryTransport{
        base:   transport,
        config: b.retryConfig,
    }

    if b.circuitBreaker {
        transport = NewCircuitBreakerTransport(transport, b.cbName)
    }

    if b.otelEnabled {
        transport = NewOTelTransport(transport)
    }

    return &http.Client{
        Transport: transport,
        // Do NOT set Timeout here; use context deadlines instead.
    }
}
```

## Section 6: OpenTelemetry Trace Propagation

```bash
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.52.0
```

```go
package httpclient

import (
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel"
)

// NewOTelTransport wraps the base transport to inject trace context into
// outgoing requests and record spans.
func NewOTelTransport(base http.RoundTripper) http.RoundTripper {
    return otelhttp.NewTransport(base,
        otelhttp.WithPropagators(
            propagation.NewCompositeTextMapPropagator(
                propagation.TraceContext{},
                propagation.Baggage{},
            ),
        ),
        otelhttp.WithTracerProvider(otel.GetTracerProvider()),
        otelhttp.WithSpanNameFormatter(func(operation string, req *http.Request) string {
            return fmt.Sprintf("HTTP %s %s", req.Method, req.URL.Path)
        }),
    )
}
```

## Section 7: Named Client Factory

Services typically talk to multiple upstream APIs, each with different resilience parameters:

```go
package httpclient

import (
    "sync"
    "time"
)

// Registry holds named HTTP clients.
type Registry struct {
    mu      sync.RWMutex
    clients map[string]*http.Client
}

var globalRegistry = &Registry{clients: make(map[string]*http.Client)}

// Register creates and stores a named HTTP client.
func Register(name string, opts ...Option) {
    b := NewBuilder()
    for _, opt := range opts {
        opt(b)
    }
    globalRegistry.mu.Lock()
    globalRegistry.clients[name] = b.Build()
    globalRegistry.mu.Unlock()
}

// Get returns a named HTTP client, panicking if not found.
func Get(name string) *http.Client {
    globalRegistry.mu.RLock()
    defer globalRegistry.mu.RUnlock()
    c, ok := globalRegistry.clients[name]
    if !ok {
        panic("http client not registered: " + name)
    }
    return c
}

type Option func(*Builder)

func WithRetryMaxAttempts(n int) Option {
    return func(b *Builder) { b.retryConfig.MaxAttempts = n }
}

func WithBaseDelay(d time.Duration) Option {
    return func(b *Builder) { b.retryConfig.BaseDelay = d }
}

func WithMaxConnsPerHost(n int) Option {
    return func(b *Builder) { b.transportConfig.MaxConnsPerHost = n }
}
```

Usage in `main.go`:

```go
httpclient.Register("payments-api",
    httpclient.WithRetryMaxAttempts(3),
    httpclient.WithBaseDelay(200*time.Millisecond),
    httpclient.WithCircuitBreaker("payments-api"),
    httpclient.WithOpenTelemetry(),
)

httpclient.Register("auth-api",
    httpclient.WithRetryMaxAttempts(2),
    httpclient.WithMaxConnsPerHost(20),
    httpclient.WithOpenTelemetry(),
)
```

## Section 8: Integration Testing

```go
package httpclient_test

import (
    "net/http"
    "net/http/httptest"
    "sync/atomic"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestRetryTransport_RetriesOnServiceUnavailable(t *testing.T) {
    var callCount atomic.Int32
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if callCount.Add(1) < 3 {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        w.WriteHeader(http.StatusOK)
    }))
    defer srv.Close()

    client := NewBuilder().Build()

    req, err := http.NewRequest(http.MethodGet, srv.URL+"/test", nil)
    require.NoError(t, err)

    resp, err := client.Do(req)
    require.NoError(t, err)
    defer resp.Body.Close()

    assert.Equal(t, http.StatusOK, resp.StatusCode)
    assert.Equal(t, int32(3), callCount.Load())
}

func TestCircuitBreakerTransport_OpensAfterFailures(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusInternalServerError)
    }))
    defer srv.Close()

    client := NewBuilder().
        WithCircuitBreaker("test-breaker").
        Build()

    // Exhaust requests to open the circuit.
    for i := 0; i < 5; i++ {
        req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
        client.Do(req)
    }

    // Next request should fail fast with circuit open error.
    req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
    _, err := client.Do(req)
    assert.ErrorIs(t, err, ErrCircuitOpen)
}
```

## Section 9: Production Checklist

```text
MaxIdleConnsPerHost set to expected p99 concurrent requests per host
MaxConnsPerHost set to burst concurrency limit
Dial and TLS timeouts set to prevent indefinite connection hangs
ResponseHeaderTimeout set to detect slow TTFB on upstream APIs
Total request deadline set via context, not http.Client.Timeout
Retry limited to idempotent HTTP methods only
Retry excludes context cancellation and 4xx errors (except 429)
Circuit breaker configured per-upstream, not globally
Circuit breaker state changes logged and exposed as metrics
OpenTelemetry transport propagates W3C trace context
```

## Section 10: Metrics and Observability

Expose circuit breaker state and request metrics via Prometheus:

```go
var (
    httpRequestsTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_client_requests_total",
            Help: "Total outbound HTTP requests by host, method, and status class.",
        },
        []string{"host", "method", "status_class"},
    )
    httpRequestDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_client_request_duration_seconds",
            Help:    "Outbound HTTP request duration.",
            Buckets: prometheus.DefBuckets,
        },
        []string{"host", "method"},
    )
    circuitBreakerState = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "http_client_circuit_breaker_state",
            Help: "Circuit breaker state: 0=closed, 1=half-open, 2=open.",
        },
        []string{"name"},
    )
)
```
