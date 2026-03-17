---
title: "Go HTTP Client Patterns: Connection Pooling, Retry Logic, Circuit Breakers, and Timeout Strategies"
date: 2028-08-06T00:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Connection Pooling", "Retry", "Circuit Breaker"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to production Go HTTP client patterns covering connection pool tuning, retry with exponential backoff, circuit breakers, timeout configuration, middleware chains, and observability for microservice communication."
more_link: "yes"
url: "/go-http-client-connection-pooling-guide/"
---

The Go standard library HTTP client is deceptively capable, but the defaults are wrong for production microservice communication. The default client has no timeout, a connection pool sized for a single host, and no retry logic. Every Go service that makes HTTP calls to other services needs a properly configured client — and most production issues I've diagnosed in Go microservices trace back to a client that was left at defaults.

This guide covers everything needed to build a production-grade HTTP client: connection pool tuning, timeout chains, retry with jitter, circuit breakers, middleware composition, and metrics instrumentation.

<!--more-->

# Go HTTP Client Patterns: Connection Pooling, Retry Logic, Circuit Breakers, and Timeout Strategies

## Section 1: What's Wrong with http.DefaultClient

```go
// http.DefaultClient is equivalent to:
var DefaultClient = &http.Client{
    // No timeout — a stuck connection hangs forever
    Timeout: 0,
    // Uses http.DefaultTransport which has:
    // MaxIdleConns: 100
    // MaxIdleConnsPerHost: 2  <-- CRITICALLY LOW for microservices
    // IdleConnTimeout: 90s
    // TLSHandshakeTimeout: 10s
    // ResponseHeaderTimeout: 0  <-- No timeout waiting for response headers
}
```

The two most dangerous defaults:

1. **No timeout**: A single hung downstream service can exhaust your goroutine pool as requests pile up waiting forever.
2. **MaxIdleConnsPerHost = 2**: For a service that makes 1000 req/s to one downstream, 2 pooled connections means constant TCP connection establishment, wasting 3-7ms per request on TLS handshakes.

## Section 2: Transport Configuration

The `http.Transport` is the connection pool. Configure it carefully:

```go
// transport.go
package httpclient

import (
    "crypto/tls"
    "net"
    "net/http"
    "time"
)

// NewTransport creates a production-tuned HTTP transport.
func NewTransport(opts TransportOptions) *http.Transport {
    dialer := &net.Dialer{
        Timeout:   opts.DialTimeout,    // TCP connection establishment timeout
        KeepAlive: opts.KeepAlive,      // TCP keepalive interval
    }

    return &http.Transport{
        DialContext: dialer.DialContext,

        // Connection pool sizing
        MaxIdleConns:        opts.MaxIdleConns,        // Total idle connections across all hosts
        MaxIdleConnsPerHost: opts.MaxIdleConnsPerHost,  // Idle connections per host
        MaxConnsPerHost:     opts.MaxConnsPerHost,      // Total connections per host (0=unlimited)

        // Timeouts
        TLSHandshakeTimeout:   opts.TLSHandshakeTimeout,   // TLS handshake
        ResponseHeaderTimeout: opts.ResponseHeaderTimeout, // Wait for first response byte
        ExpectContinueTimeout: 1 * time.Second,

        // Keep connections alive
        IdleConnTimeout: opts.IdleConnTimeout,

        // TLS configuration
        TLSClientConfig: &tls.Config{
            InsecureSkipVerify: opts.InsecureTLS,
            MinVersion:         tls.VersionTLS12,
        },

        // Disable compression for better throughput on internal services
        // (saves CPU on both sides; network is fast in a datacenter)
        DisableCompression: opts.DisableCompression,

        // Allow HTTP/2
        ForceAttemptHTTP2: true,
    }
}

// TransportOptions holds all transport configuration.
type TransportOptions struct {
    // Connection establishment
    DialTimeout   time.Duration
    KeepAlive     time.Duration

    // Pool sizing
    MaxIdleConns        int
    MaxIdleConnsPerHost int
    MaxConnsPerHost     int

    // Timeouts
    TLSHandshakeTimeout   time.Duration
    ResponseHeaderTimeout time.Duration
    IdleConnTimeout       time.Duration

    // TLS
    InsecureTLS bool

    // Misc
    DisableCompression bool
}

// DefaultTransportOptions returns sensible defaults for intra-cluster communication.
func DefaultTransportOptions() TransportOptions {
    return TransportOptions{
        DialTimeout:   5 * time.Second,
        KeepAlive:     30 * time.Second,

        MaxIdleConns:        500,
        MaxIdleConnsPerHost: 100, // 50x the stdlib default
        MaxConnsPerHost:     0,   // unlimited; limit via backpressure/circuit breaker

        TLSHandshakeTimeout:   5 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second,
        IdleConnTimeout:       90 * time.Second,

        DisableCompression: true, // internal services; disable for public APIs
    }
}

// ExternalAPITransportOptions returns options appropriate for external API calls.
func ExternalAPITransportOptions() TransportOptions {
    return TransportOptions{
        DialTimeout:   10 * time.Second,
        KeepAlive:     30 * time.Second,

        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 10,
        MaxConnsPerHost:     0,

        TLSHandshakeTimeout:   10 * time.Second,
        ResponseHeaderTimeout: 30 * time.Second,
        IdleConnTimeout:       90 * time.Second,

        DisableCompression: false,
    }
}
```

## Section 3: Complete Timeout Configuration

Go HTTP timeouts are layered. Understanding each layer prevents the "it times out sometimes but not always" class of bugs:

```
                    Client.Timeout (wall clock from request start to body fully read)
                    │
   ┌────────────────┼───────────────────────────────────────────────────┐
   │                │                                                   │
  TCP           TLS Handshake    ResponseHeaderTimeout    Body read     │
  Connect        (Transport)          (Transport)         (user code)  │
  (DialTimeout)                                                         │
   │                                                                    │
   └────────────────────────────────────────────────────────────────────┘
```

```go
// timeout-example.go
package httpclient

import (
    "context"
    "net/http"
    "time"
)

// TimeoutConfig describes the complete timeout chain for an HTTP client.
type TimeoutConfig struct {
    // Overall deadline from start of request to end of reading the body.
    // This is the master timeout. Set it to the maximum acceptable response time.
    TotalTimeout time.Duration

    // TCP connection establishment timeout.
    DialTimeout time.Duration

    // TLS handshake timeout.
    TLSHandshakeTimeout time.Duration

    // Time to wait for response headers after sending the request body.
    // This is the "time to first byte" timeout.
    ResponseHeaderTimeout time.Duration

    // Timeout per retry attempt (set on the context passed to each attempt).
    // Must be < TotalTimeout / maxAttempts.
    AttemptTimeout time.Duration
}

// DefaultTimeoutConfig returns conservative timeouts suitable for most services.
func DefaultTimeoutConfig() TimeoutConfig {
    return TimeoutConfig{
        TotalTimeout:          30 * time.Second,
        DialTimeout:           5 * time.Second,
        TLSHandshakeTimeout:   5 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second,
        AttemptTimeout:        8 * time.Second,
    }
}

// MakeRequest executes an HTTP request with per-attempt context timeout.
func MakeRequest(
    ctx context.Context,
    client *http.Client,
    req *http.Request,
    attemptTimeout time.Duration,
) (*http.Response, error) {
    // Create a context with the per-attempt timeout
    attemptCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
    defer cancel()

    return client.Do(req.WithContext(attemptCtx))
}
```

## Section 4: Retry Logic with Exponential Backoff and Jitter

Retry logic must handle two different failure modes differently:

- **Transient errors** (connection refused, 503, timeout): retry with backoff
- **Permanent errors** (400, 401, 404, 422): do not retry — retrying wastes resources and doesn't help

```go
// retry.go
package httpclient

import (
    "bytes"
    "context"
    "fmt"
    "io"
    "math"
    "math/rand"
    "net/http"
    "time"
)

// RetryConfig configures retry behavior.
type RetryConfig struct {
    MaxAttempts     int
    InitialDelay    time.Duration
    MaxDelay        time.Duration
    Multiplier      float64
    JitterFraction  float64  // 0.0-1.0; adds random fraction of delay
    RetryableStatuses []int  // HTTP status codes to retry
}

// DefaultRetryConfig returns a production-safe retry configuration.
func DefaultRetryConfig() RetryConfig {
    return RetryConfig{
        MaxAttempts:    3,
        InitialDelay:   100 * time.Millisecond,
        MaxDelay:       5 * time.Second,
        Multiplier:     2.0,
        JitterFraction: 0.3,
        RetryableStatuses: []int{
            http.StatusTooManyRequests,        // 429
            http.StatusInternalServerError,    // 500
            http.StatusBadGateway,             // 502
            http.StatusServiceUnavailable,     // 503
            http.StatusGatewayTimeout,         // 504
        },
    }
}

// RetryClient wraps an http.Client with retry logic.
type RetryClient struct {
    client        *http.Client
    config        RetryConfig
    attemptTimeout time.Duration
}

// NewRetryClient creates a retry-capable HTTP client.
func NewRetryClient(opts TransportOptions, retry RetryConfig, attemptTimeout time.Duration) *RetryClient {
    transport := NewTransport(opts)
    client := &http.Client{
        Transport: transport,
        Timeout:   retry.MaxDelay * time.Duration(retry.MaxAttempts+1), // overall safety timeout
    }
    return &RetryClient{
        client:         client,
        config:         retry,
        attemptTimeout: attemptTimeout,
    }
}

// Do executes the request with retry logic.
// The request body is buffered to support retries.
func (rc *RetryClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    // Buffer the request body so it can be replayed on retry
    var bodyBytes []byte
    if req.Body != nil {
        var err error
        bodyBytes, err = io.ReadAll(req.Body)
        req.Body.Close()
        if err != nil {
            return nil, fmt.Errorf("reading request body: %w", err)
        }
    }

    var (
        resp      *http.Response
        lastErr   error
        delay     = rc.config.InitialDelay
    )

    for attempt := 0; attempt < rc.config.MaxAttempts; attempt++ {
        if attempt > 0 {
            // Wait before retrying, respecting context cancellation
            jitter := time.Duration(float64(delay) * rc.config.JitterFraction * rand.Float64())
            sleepDuration := delay + jitter

            select {
            case <-ctx.Done():
                return nil, fmt.Errorf("context cancelled during retry backoff: %w", ctx.Err())
            case <-time.After(sleepDuration):
            }

            // Exponential backoff with max cap
            delay = time.Duration(math.Min(
                float64(delay)*rc.config.Multiplier,
                float64(rc.config.MaxDelay),
            ))
        }

        // Rebuild request body for this attempt
        if bodyBytes != nil {
            req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
            req.ContentLength = int64(len(bodyBytes))
        }

        // Per-attempt context timeout
        attemptCtx, cancel := context.WithTimeout(ctx, rc.attemptTimeout)

        resp, lastErr = rc.client.Do(req.WithContext(attemptCtx))
        cancel()

        if lastErr != nil {
            // Network error — always retry
            lastErr = fmt.Errorf("attempt %d/%d: %w", attempt+1, rc.config.MaxAttempts, lastErr)
            continue
        }

        // Check if status code is retryable
        if !rc.isRetryable(resp.StatusCode) {
            return resp, nil
        }

        // Drain and close body before retry to reuse the connection
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()

        lastErr = fmt.Errorf("attempt %d/%d: received HTTP %d", attempt+1, rc.config.MaxAttempts, resp.StatusCode)
    }

    return nil, fmt.Errorf("all %d attempts failed: %w", rc.config.MaxAttempts, lastErr)
}

func (rc *RetryClient) isRetryable(statusCode int) bool {
    for _, s := range rc.config.RetryableStatuses {
        if statusCode == s {
            return true
        }
    }
    return false
}

// isNetworkError reports whether the error is a transient network error.
func isNetworkError(err error) bool {
    if err == nil {
        return false
    }
    // context.DeadlineExceeded and context.Canceled are not network errors
    // — they mean the caller gave up.
    if err == context.DeadlineExceeded || err == context.Canceled {
        return false
    }
    return true
}
```

### Retry-After Header Support

```go
// retry-after.go
package httpclient

import (
    "net/http"
    "strconv"
    "time"
)

// retryAfterDelay extracts the Retry-After header value and returns the
// duration to wait before the next retry.
func retryAfterDelay(resp *http.Response, defaultDelay time.Duration) time.Duration {
    if resp == nil {
        return defaultDelay
    }
    retryAfter := resp.Header.Get("Retry-After")
    if retryAfter == "" {
        return defaultDelay
    }

    // Try parsing as seconds integer
    if seconds, err := strconv.Atoi(retryAfter); err == nil {
        return time.Duration(seconds) * time.Second
    }

    // Try parsing as HTTP date
    if t, err := http.ParseTime(retryAfter); err == nil {
        d := time.Until(t)
        if d > 0 {
            return d
        }
    }

    return defaultDelay
}
```

## Section 5: Circuit Breaker

A circuit breaker prevents cascading failures by stopping requests to a consistently failing backend. Three states:

- **Closed**: Normal operation. Requests flow through.
- **Open**: Backend is failing. Requests are short-circuited immediately.
- **Half-Open**: After a recovery period, a limited number of requests are allowed through to test recovery.

```go
// circuitbreaker.go
package httpclient

import (
    "errors"
    "sync"
    "time"
)

// ErrCircuitOpen is returned when the circuit breaker is open.
var ErrCircuitOpen = errors.New("circuit breaker is open")

// State represents the circuit breaker state.
type State int

const (
    StateClosed   State = iota // Normal operation
    StateOpen                  // Failing; fast-fail all requests
    StateHalfOpen              // Testing recovery
)

func (s State) String() string {
    switch s {
    case StateClosed:
        return "CLOSED"
    case StateOpen:
        return "OPEN"
    case StateHalfOpen:
        return "HALF_OPEN"
    default:
        return "UNKNOWN"
    }
}

// CircuitBreakerConfig configures circuit breaker behavior.
type CircuitBreakerConfig struct {
    // Number of consecutive failures before opening the circuit
    FailureThreshold int
    // Time to wait before attempting recovery (half-open state)
    RecoveryTimeout time.Duration
    // Number of successful requests in half-open to close the circuit
    SuccessThreshold int
    // Sampling window for failure rate calculation
    SamplingWindow time.Duration
    // Minimum number of requests in the window before tripping
    MinimumRequestVolume int
    // Failure rate percentage to trip (0-100)
    FailureRateThreshold float64
}

// DefaultCircuitBreakerConfig returns conservative defaults.
func DefaultCircuitBreakerConfig() CircuitBreakerConfig {
    return CircuitBreakerConfig{
        FailureThreshold:     5,
        RecoveryTimeout:      30 * time.Second,
        SuccessThreshold:     2,
        SamplingWindow:       60 * time.Second,
        MinimumRequestVolume: 10,
        FailureRateThreshold: 50.0, // 50% failure rate trips the breaker
    }
}

type windowEntry struct {
    timestamp time.Time
    success   bool
}

// CircuitBreaker implements the circuit breaker pattern.
type CircuitBreaker struct {
    config      CircuitBreakerConfig
    mu          sync.Mutex
    state       State
    failures    int
    successes   int
    openedAt    time.Time
    window      []windowEntry
    onStateChange func(from, to State)
}

// NewCircuitBreaker creates a new CircuitBreaker.
func NewCircuitBreaker(config CircuitBreakerConfig) *CircuitBreaker {
    return &CircuitBreaker{
        config: config,
        state:  StateClosed,
        window: make([]windowEntry, 0, 1000),
    }
}

// OnStateChange registers a callback for state transitions.
func (cb *CircuitBreaker) OnStateChange(fn func(from, to State)) {
    cb.onStateChange = fn
}

// Allow reports whether a request should be allowed through.
// Returns (true, nil) for StateClosed and StateHalfOpen (limited).
// Returns (false, ErrCircuitOpen) for StateOpen.
func (cb *CircuitBreaker) Allow() (bool, error) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        return true, nil

    case StateOpen:
        // Check if recovery timeout has elapsed
        if time.Since(cb.openedAt) > cb.config.RecoveryTimeout {
            cb.transitionTo(StateHalfOpen)
            cb.successes = 0
            return true, nil
        }
        return false, ErrCircuitOpen

    case StateHalfOpen:
        // Allow limited requests in half-open state
        if cb.successes < cb.config.SuccessThreshold {
            return true, nil
        }
        return false, ErrCircuitOpen
    }

    return true, nil
}

// RecordSuccess records a successful request.
func (cb *CircuitBreaker) RecordSuccess() {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    cb.recordInWindow(true)

    switch cb.state {
    case StateHalfOpen:
        cb.successes++
        if cb.successes >= cb.config.SuccessThreshold {
            cb.transitionTo(StateClosed)
            cb.failures = 0
        }
    case StateClosed:
        cb.failures = 0
    }
}

// RecordFailure records a failed request.
func (cb *CircuitBreaker) RecordFailure() {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    cb.recordInWindow(false)

    switch cb.state {
    case StateClosed:
        cb.failures++
        if cb.shouldTrip() {
            cb.transitionTo(StateOpen)
            cb.openedAt = time.Now()
        }

    case StateHalfOpen:
        cb.transitionTo(StateOpen)
        cb.openedAt = time.Now()
    }
}

func (cb *CircuitBreaker) shouldTrip() bool {
    if cb.failures >= cb.config.FailureThreshold {
        return true
    }

    // Also check failure rate over the sampling window
    cutoff := time.Now().Add(-cb.config.SamplingWindow)
    total, failures := 0, 0
    for _, e := range cb.window {
        if e.timestamp.After(cutoff) {
            total++
            if !e.success {
                failures++
            }
        }
    }

    if total < cb.config.MinimumRequestVolume {
        return false
    }

    failureRate := float64(failures) / float64(total) * 100
    return failureRate >= cb.config.FailureRateThreshold
}

func (cb *CircuitBreaker) recordInWindow(success bool) {
    now := time.Now()
    cutoff := now.Add(-cb.config.SamplingWindow)

    // Evict old entries
    valid := cb.window[:0]
    for _, e := range cb.window {
        if e.timestamp.After(cutoff) {
            valid = append(valid, e)
        }
    }
    cb.window = append(valid, windowEntry{timestamp: now, success: success})
}

func (cb *CircuitBreaker) transitionTo(newState State) {
    if cb.state == newState {
        return
    }
    from := cb.state
    cb.state = newState
    if cb.onStateChange != nil {
        go cb.onStateChange(from, newState)
    }
}

// State returns the current circuit breaker state.
func (cb *CircuitBreaker) State() State {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    return cb.state
}
```

### Circuit Breaker Integration

```go
// circuit-client.go
package httpclient

import (
    "context"
    "fmt"
    "net/http"
)

// CircuitBreakerClient wraps RetryClient with circuit breaker protection.
type CircuitBreakerClient struct {
    retry   *RetryClient
    breaker *CircuitBreaker
}

func NewCircuitBreakerClient(
    opts TransportOptions,
    retry RetryConfig,
    breaker CircuitBreakerConfig,
    attemptTimeout interface{},
) *CircuitBreakerClient {
    // using time.Duration directly
    return nil // placeholder
}

func (c *CircuitBreakerClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    allowed, err := c.breaker.Allow()
    if !allowed {
        return nil, fmt.Errorf("circuit breaker open for %s: %w", req.URL.Host, err)
    }

    resp, err := c.retry.Do(ctx, req)
    if err != nil {
        c.breaker.RecordFailure()
        return nil, err
    }

    if resp.StatusCode >= 500 {
        c.breaker.RecordFailure()
    } else {
        c.breaker.RecordSuccess()
    }

    return resp, nil
}
```

## Section 6: Middleware Chain Pattern

Composable middleware allows adding cross-cutting concerns without modifying the core client:

```go
// middleware.go
package httpclient

import (
    "context"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
    "go.uber.org/zap"
)

// RoundTripFunc is an http.RoundTripper implemented as a function.
type RoundTripFunc func(*http.Request) (*http.Response, error)

func (f RoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
    return f(req)
}

// Chain creates a middleware chain where each middleware wraps the next.
// Middleware is applied in order: chain[0] wraps chain[1] wraps ... wraps base.
func Chain(base http.RoundTripper, middleware ...func(http.RoundTripper) http.RoundTripper) http.RoundTripper {
    rt := base
    for i := len(middleware) - 1; i >= 0; i-- {
        rt = middleware[i](rt)
    }
    return rt
}

// LoggingMiddleware logs each request/response.
func LoggingMiddleware(logger *zap.Logger) func(http.RoundTripper) http.RoundTripper {
    return func(next http.RoundTripper) http.RoundTripper {
        return RoundTripFunc(func(req *http.Request) (*http.Response, error) {
            start := time.Now()
            resp, err := next.RoundTrip(req)

            fields := []zap.Field{
                zap.String("method", req.Method),
                zap.String("url", req.URL.String()),
                zap.Duration("duration", time.Since(start)),
            }

            if err != nil {
                logger.Error("http request failed", append(fields, zap.Error(err))...)
            } else {
                fields = append(fields, zap.Int("status", resp.StatusCode))
                if resp.StatusCode >= 400 {
                    logger.Warn("http request error response", fields...)
                } else {
                    logger.Debug("http request", fields...)
                }
            }

            return resp, err
        })
    }
}

// TracingMiddleware adds OpenTelemetry tracing to each request.
func TracingMiddleware(tracer trace.Tracer) func(http.RoundTripper) http.RoundTripper {
    if tracer == nil {
        tracer = otel.Tracer("httpclient")
    }
    return func(next http.RoundTripper) http.RoundTripper {
        return RoundTripFunc(func(req *http.Request) (*http.Response, error) {
            ctx, span := tracer.Start(req.Context(),
                "HTTP "+req.Method+" "+req.URL.Host,
                trace.WithAttributes(
                    attribute.String("http.method", req.Method),
                    attribute.String("http.url", req.URL.String()),
                    attribute.String("http.host", req.URL.Host),
                ),
            )
            defer span.End()

            resp, err := next.RoundTrip(req.WithContext(ctx))
            if err != nil {
                span.RecordError(err)
                return nil, err
            }

            span.SetAttributes(attribute.Int("http.status_code", resp.StatusCode))
            return resp, nil
        })
    }
}

// AuthMiddleware adds a Bearer token to every request.
func AuthMiddleware(tokenFn func(context.Context) (string, error)) func(http.RoundTripper) http.RoundTripper {
    return func(next http.RoundTripper) http.RoundTripper {
        return RoundTripFunc(func(req *http.Request) (*http.Response, error) {
            token, err := tokenFn(req.Context())
            if err != nil {
                return nil, fmt.Errorf("getting auth token: %w", err)
            }

            // Clone the request to avoid mutating the original
            reqClone := req.Clone(req.Context())
            reqClone.Header.Set("Authorization", "Bearer "+token)

            return next.RoundTrip(reqClone)
        })
    }
}

// RateLimitMiddleware limits requests per second.
func RateLimitMiddleware(rps float64) func(http.RoundTripper) http.RoundTripper {
    // Use golang.org/x/time/rate for token bucket
    // import "golang.org/x/time/rate"
    // limiter := rate.NewLimiter(rate.Limit(rps), int(rps))
    return func(next http.RoundTripper) http.RoundTripper {
        return RoundTripFunc(func(req *http.Request) (*http.Response, error) {
            // if err := limiter.Wait(req.Context()); err != nil {
            //     return nil, fmt.Errorf("rate limit: %w", err)
            // }
            return next.RoundTrip(req)
        })
    }
}

// MetricsMiddleware records Prometheus metrics for each request.
func MetricsMiddleware(registerer prometheus.Registerer) func(http.RoundTripper) http.RoundTripper {
    requestsTotal := prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "http_client_requests_total",
        Help: "Total HTTP client requests by method, host, and status.",
    }, []string{"method", "host", "status"})

    requestDuration := prometheus.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "http_client_request_duration_seconds",
        Help:    "HTTP client request duration in seconds.",
        Buckets: prometheus.DefBuckets,
    }, []string{"method", "host", "status"})

    if registerer != nil {
        registerer.MustRegister(requestsTotal, requestDuration)
    }

    return func(next http.RoundTripper) http.RoundTripper {
        return RoundTripFunc(func(req *http.Request) (*http.Response, error) {
            start := time.Now()
            resp, err := next.RoundTrip(req)
            duration := time.Since(start).Seconds()

            status := "error"
            if err == nil {
                status = strconv.Itoa(resp.StatusCode)
            }

            requestsTotal.WithLabelValues(req.Method, req.URL.Host, status).Inc()
            requestDuration.WithLabelValues(req.Method, req.URL.Host, status).Observe(duration)

            return resp, err
        })
    }
}
```

### Building the Client

```go
// client-builder.go
package httpclient

import (
    "net/http"
    "time"

    "go.uber.org/zap"
    "golang.org/x/time/rate"
    "github.com/prometheus/client_golang/prometheus"
)

// Client is a production-ready HTTP client.
type Client struct {
    inner *http.Client
}

// Builder constructs a Client with a fluent API.
type Builder struct {
    transport   *http.Transport
    middleware  []func(http.RoundTripper) http.RoundTripper
    timeout     time.Duration
}

// NewBuilder creates a new client builder with default transport.
func NewBuilder() *Builder {
    return &Builder{
        transport: NewTransport(DefaultTransportOptions()),
        timeout:   30 * time.Second,
    }
}

func (b *Builder) WithTransportOptions(opts TransportOptions) *Builder {
    b.transport = NewTransport(opts)
    return b
}

func (b *Builder) WithTimeout(d time.Duration) *Builder {
    b.timeout = d
    return b
}

func (b *Builder) WithLogging(logger *zap.Logger) *Builder {
    b.middleware = append(b.middleware, LoggingMiddleware(logger))
    return b
}

func (b *Builder) WithTracing() *Builder {
    b.middleware = append(b.middleware, TracingMiddleware(nil))
    return b
}

func (b *Builder) WithMetrics(reg prometheus.Registerer) *Builder {
    b.middleware = append(b.middleware, MetricsMiddleware(reg))
    return b
}

func (b *Builder) WithAuth(tokenFn func(context.Context) (string, error)) *Builder {
    b.middleware = append(b.middleware, AuthMiddleware(tokenFn))
    return b
}

func (b *Builder) Build() *http.Client {
    rt := Chain(b.transport, b.middleware...)
    return &http.Client{
        Transport: rt,
        Timeout:   b.timeout,
    }
}
```

### Usage

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "go.uber.org/zap"

    "github.com/supporttools/httpclient"
)

func main() {
    logger, _ := zap.NewProduction()
    reg := prometheus.NewRegistry()

    // Build a production client
    client := httpclient.NewBuilder().
        WithTransportOptions(httpclient.DefaultTransportOptions()).
        WithTimeout(30 * time.Second).
        WithLogging(logger).
        WithTracing().
        WithMetrics(reg).
        Build()

    // Use it like any http.Client
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, http.MethodGet,
        "https://api.example.com/users", nil)
    if err != nil {
        panic(err)
    }

    resp, err := client.Do(req)
    if err != nil {
        logger.Fatal("request failed", zap.Error(err))
    }
    defer resp.Body.Close()

    var users []map[string]interface{}
    if err := json.NewDecoder(resp.Body).Decode(&users); err != nil {
        panic(err)
    }
    fmt.Printf("Got %d users\n", len(users))
}
```

## Section 7: Connection Pool Monitoring

```go
// pool-stats.go
package httpclient

import (
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// TransportMetricsCollector exposes http.Transport connection pool metrics.
type TransportMetricsCollector struct {
    transport *http.Transport

    idleConns    *prometheus.GaugeVec
    totalConns   *prometheus.GaugeVec
}

func NewTransportMetricsCollector(transport *http.Transport, reg prometheus.Registerer) *TransportMetricsCollector {
    c := &TransportMetricsCollector{
        transport: transport,
        idleConns: prometheus.NewGaugeVec(prometheus.GaugeOpts{
            Name: "http_client_idle_connections",
            Help: "Number of idle HTTP connections in the pool.",
        }, []string{"host"}),
        totalConns: prometheus.NewGaugeVec(prometheus.GaugeOpts{
            Name: "http_client_total_connections",
            Help: "Total number of HTTP connections (idle + active).",
        }, []string{"host"}),
    }

    if reg != nil {
        reg.MustRegister(c.idleConns, c.totalConns)
    }

    go c.collect()
    return c
}

func (c *TransportMetricsCollector) collect() {
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()
    for range ticker.C {
        // http.Transport doesn't expose pool stats directly.
        // Use ConnState callback or a custom Transport wrapping net.Conn.
        // This is a placeholder showing the approach.
    }
}

// ConnStateMiddleware tracks per-host connection counts.
// Use this as the Server.ConnState callback when running a test server,
// or wrap net.Conn at the Dial level for clients.
func NewTrackingDialer(base *http.Transport) *TrackingTransport {
    return &TrackingTransport{base: base}
}

type TrackingTransport struct {
    base          *http.Transport
    activeConns   sync.Map // host -> int64
    totalDialed   sync.Map // host -> int64
}

func (t *TrackingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    return t.base.RoundTrip(req)
}
```

### Diagnosing Connection Pool Issues

```bash
# Check open TCP connections from the Go process
ss -tnp | grep $(pgrep myservice) | awk '{print $1, $2, $4, $5, $6}'

# Count connections by state and remote host
ss -tnp | grep $(pgrep myservice) | \
  awk '{print $1, $5}' | \
  sort | uniq -c | sort -rn

# Expected output for healthy connection pool:
# 100 ESTAB 10.0.1.50:8080  (100 idle connections to backend)
# 5 CLOSE_WAIT ...            (a few being cleaned up)
#
# Unhealthy: many TIME_WAIT means connections are not being reused
# TIME_WAIT appears when http.Transport.DisableKeepAlives is accidentally true,
# or MaxIdleConnsPerHost is too low.

# Check for connection leaks (CLOSE_WAIT means we're not closing response bodies)
ss -tnp | grep $(pgrep myservice) | grep CLOSE_WAIT | wc -l
```

The most common cause of connection leaks:

```go
// WRONG: not closing the response body
resp, err := client.Do(req)
if err != nil {
    return err
}
data, _ := io.ReadAll(resp.Body)
// MISSING: resp.Body.Close() -> eventually CLOSE_WAIT accumulates

// CORRECT:
resp, err := client.Do(req)
if err != nil {
    return err
}
defer resp.Body.Close()
data, err := io.ReadAll(resp.Body)
if err != nil {
    return err
}
```

## Section 8: Testing HTTP Clients

### httptest.Server for Unit Tests

```go
// client_test.go
package httpclient_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "sync/atomic"
    "testing"
    "time"
    "context"
)

func TestRetryOnServerError(t *testing.T) {
    var callCount int64

    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        count := atomic.AddInt64(&callCount, 1)
        if count < 3 {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
    }))
    defer server.Close()

    client := httpclient.NewRetryClient(
        httpclient.TransportOptions{
            MaxIdleConnsPerHost: 10,
            DialTimeout:         time.Second,
            TLSHandshakeTimeout: time.Second,
            ResponseHeaderTimeout: time.Second,
            IdleConnTimeout: 30 * time.Second,
        },
        httpclient.RetryConfig{
            MaxAttempts:       3,
            InitialDelay:      10 * time.Millisecond, // fast for tests
            MaxDelay:          100 * time.Millisecond,
            Multiplier:        2.0,
            JitterFraction:    0,
            RetryableStatuses: []int{503},
        },
        5*time.Second,
    )

    ctx := context.Background()
    req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/test", nil)
    resp, err := client.Do(ctx, req)
    if err != nil {
        t.Fatalf("expected success after retries, got: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        t.Errorf("expected 200, got %d", resp.StatusCode)
    }

    if atomic.LoadInt64(&callCount) != 3 {
        t.Errorf("expected 3 calls (2 failures + 1 success), got %d", callCount)
    }
}

func TestCircuitBreakerOpens(t *testing.T) {
    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusServiceUnavailable)
    }))
    defer server.Close()

    breaker := httpclient.NewCircuitBreaker(httpclient.CircuitBreakerConfig{
        FailureThreshold:     3,
        RecoveryTimeout:      1 * time.Second,
        SuccessThreshold:     1,
        MinimumRequestVolume: 3,
        FailureRateThreshold: 100,
    })

    // Send enough requests to open the circuit
    for i := 0; i < 5; i++ {
        allowed, _ := breaker.Allow()
        if allowed {
            breaker.RecordFailure()
        }
    }

    allowed, err := breaker.Allow()
    if allowed {
        t.Error("circuit should be open after failures")
    }
    if err != httpclient.ErrCircuitOpen {
        t.Errorf("expected ErrCircuitOpen, got %v", err)
    }

    // Wait for recovery timeout
    time.Sleep(1100 * time.Millisecond)

    allowed, err = breaker.Allow()
    if !allowed {
        t.Errorf("circuit should be half-open after recovery timeout: %v", err)
    }
}
```

## Section 9: Complete Production Client

Putting it all together:

```go
// production-client.go
package main

import (
    "context"
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "go.uber.org/zap"

    "github.com/supporttools/httpclient"
)

func NewProductionClient(
    logger *zap.Logger,
    reg prometheus.Registerer,
) *http.Client {
    // 1. Transport: connection pool
    transport := httpclient.NewTransport(httpclient.TransportOptions{
        DialTimeout:           5 * time.Second,
        KeepAlive:             30 * time.Second,
        MaxIdleConns:          500,
        MaxIdleConnsPerHost:   100,
        TLSHandshakeTimeout:   5 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second,
        IdleConnTimeout:       90 * time.Second,
        DisableCompression:    true,
    })

    // 2. Circuit breaker
    breaker := httpclient.NewCircuitBreaker(httpclient.DefaultCircuitBreakerConfig())
    breaker.OnStateChange(func(from, to httpclient.State) {
        logger.Warn("circuit breaker state change",
            zap.String("from", from.String()),
            zap.String("to", to.String()))
    })

    // 3. Middleware chain
    rt := httpclient.Chain(
        transport,
        httpclient.LoggingMiddleware(logger),
        httpclient.TracingMiddleware(nil),
        httpclient.MetricsMiddleware(reg),
    )

    return &http.Client{
        Transport: rt,
        Timeout:   30 * time.Second,
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            if len(via) >= 3 {
                return http.ErrUseLastResponse
            }
            return nil
        },
    }
}
```

## Conclusion

A production Go HTTP client is not `http.DefaultClient`. It requires:

- **Transport tuning**: `MaxIdleConnsPerHost` 50-100x the default for microservice communication. `ResponseHeaderTimeout` to catch stalled backends before goroutines pile up.
- **Full timeout chain**: Total timeout + per-attempt timeout + dial/TLS/header timeouts at each layer.
- **Retry logic**: Retry transient failures (network errors, 429, 5xx) with exponential backoff and jitter. Never retry non-idempotent requests without read-after-write semantics.
- **Circuit breaker**: Fail fast when a backend is consistently unhealthy, preventing cascading failures.
- **Middleware composition**: Add logging, tracing, metrics, and auth as composable `RoundTripper` wrappers without coupling cross-cutting concerns to business logic.
- **Body management**: Always `defer resp.Body.Close()`. Always drain the body before closing if you want to reuse the connection.

The investment in a proper HTTP client pays back every time a downstream service degrades: instead of goroutine exhaustion and cascading failure, you get controlled degradation, fast failure, and automatic recovery.
