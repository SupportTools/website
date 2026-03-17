---
title: "Go HTTP Client Best Practices: Timeouts, Retries, and Connection Management"
date: 2028-01-29T00:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Performance", "Networking", "Reliability", "Circuit Breaker", "mTLS"]
categories: ["Go", "Backend Engineering", "Reliability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Go HTTP client configuration including http.Transport tuning, context-based timeouts, exponential backoff retry logic, circuit breaker integration, mTLS client certificates, and per-host connection pool management."
more_link: "yes"
url: "/go-http-client-best-practices-guide/"
---

The default Go HTTP client is production-unsafe. It has no timeouts, an unbounded number of idle connections, and no retry logic. In a microservices environment, a single slow upstream can exhaust all goroutines waiting for responses that never arrive, creating a cascading failure across the entire call graph. This guide covers every layer of safe HTTP client construction: transport-level connection management, timeout strategy, retry with exponential backoff, circuit breaking, and mTLS for service-to-service authentication.

<!--more-->

# Go HTTP Client Best Practices: Timeouts, Retries, and Connection Management

## Why the Default Client is Dangerous

```go
// DANGEROUS: the default http client has no timeouts
// A hung upstream will block this goroutine indefinitely
resp, err := http.Get("https://api.example.com/data")

// ALSO DANGEROUS: a client with only a total timeout
// This does not protect against slow response bodies
client := &http.Client{Timeout: 30 * time.Second}
```

The `http.Client.Timeout` field sets a total request deadline including connection establishment, TLS handshake, request writing, and response body reading. It does not prevent individual phases from hanging independently. For production use, each phase needs its own timeout.

## Understanding the Timeout Model

```
                    Dial Timeout
                    ┌──────────┐
                    │          │
 http.Client.Timeout│  TLS     │ Response Header  Body Read
 ┌──────────────────┤ Handshake├─────────────────►├──────────►
 │                  │          │                  │           │
 └──────────────────┴──────────┴──────────────────┴───────────┘
        Total deadline (from request start to body close)

Transport-level timeouts (finer control):
  DialContext:            Connection establishment timeout
  TLSHandshakeTimeout:    TLS negotiation timeout
  ResponseHeaderTimeout:  Time from request sent to first response byte
  ExpectContinueTimeout:  Time to wait for 100-continue response
  IdleConnTimeout:        How long idle connections live in the pool
```

## Production-Ready Transport Configuration

```go
// pkg/httpclient/transport.go
package httpclient

import (
    "crypto/tls"
    "net"
    "net/http"
    "time"
)

// TransportConfig holds all tuneable parameters for the HTTP transport.
// These values are calibrated for typical microservice-to-microservice
// communication within a data center or cloud region.
type TransportConfig struct {
    // DialTimeout is the maximum time to wait for a TCP connection
    DialTimeout time.Duration
    // TLSHandshakeTimeout is the maximum time for TLS negotiation
    TLSHandshakeTimeout time.Duration
    // ResponseHeaderTimeout is the time from sending the request to
    // receiving the first byte of the response headers
    ResponseHeaderTimeout time.Duration
    // IdleConnTimeout is how long idle connections live in the pool
    // before being closed
    IdleConnTimeout time.Duration
    // MaxIdleConns is the total number of idle connections across all hosts
    MaxIdleConns int
    // MaxIdleConnsPerHost limits idle connections to a single host
    // Default is 2, which is far too low for high-concurrency services
    MaxIdleConnsPerHost int
    // MaxConnsPerHost limits total (idle + active) connections to a host
    // 0 means unlimited
    MaxConnsPerHost int
    // KeepAlive interval for TCP keep-alive probes
    KeepAlive time.Duration
    // DisableKeepAlives disables HTTP keep-alive (connection pooling)
    // Only set this for one-off clients or when talking to HTTP/1.0 servers
    DisableKeepAlives bool
    // TLSConfig allows customization of TLS settings
    TLSConfig *tls.Config
}

// DefaultTransportConfig returns conservative defaults suitable for
// internal microservice calls.
func DefaultTransportConfig() TransportConfig {
    return TransportConfig{
        DialTimeout:           5 * time.Second,
        TLSHandshakeTimeout:   5 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second,
        IdleConnTimeout:       90 * time.Second,
        MaxIdleConns:          1000,
        MaxIdleConnsPerHost:   100, // Sized for ~100 concurrent requests per host
        MaxConnsPerHost:       0,   // Unlimited by default
        KeepAlive:             30 * time.Second,
        DisableKeepAlives:     false,
    }
}

// NewTransport creates a configured http.Transport.
// The transport is safe for concurrent use and maintains connection pools.
func NewTransport(cfg TransportConfig) *http.Transport {
    dialer := &net.Dialer{
        Timeout:   cfg.DialTimeout,
        KeepAlive: cfg.KeepAlive,
        // DualStack enables both IPv4 and IPv6 Happy Eyeballs
        DualStack: true,
    }

    tlsConfig := cfg.TLSConfig
    if tlsConfig == nil {
        tlsConfig = &tls.Config{
            MinVersion: tls.VersionTLS12,
            // CurvePreferences limits to curves that do not have known weaknesses
            CurvePreferences: []tls.CurveID{
                tls.CurveP256,
                tls.X25519,
            },
        }
    }

    return &http.Transport{
        DialContext:           dialer.DialContext,
        TLSClientConfig:       tlsConfig,
        TLSHandshakeTimeout:   cfg.TLSHandshakeTimeout,
        ResponseHeaderTimeout: cfg.ResponseHeaderTimeout,
        IdleConnTimeout:       cfg.IdleConnTimeout,
        MaxIdleConns:          cfg.MaxIdleConns,
        MaxIdleConnsPerHost:   cfg.MaxIdleConnsPerHost,
        MaxConnsPerHost:       cfg.MaxConnsPerHost,
        DisableKeepAlives:     cfg.DisableKeepAlives,
        // ForceAttemptHTTP2 enables HTTP/2 when TLS is configured
        ForceAttemptHTTP2: true,
        // DisableCompression: false allows the transport to request
        // and decompress gzip responses automatically
        DisableCompression: false,
    }
}
```

## Context-Based Timeout Strategy

```go
// pkg/httpclient/client.go
package httpclient

import (
    "context"
    "fmt"
    "io"
    "net/http"
    "time"
)

// Client wraps http.Client with sensible defaults and convenience methods.
type Client struct {
    inner   *http.Client
    baseURL string
    headers map[string]string
}

// NewClient creates a production-ready HTTP client.
func NewClient(baseURL string, opts ...ClientOption) *Client {
    transport := NewTransport(DefaultTransportConfig())
    c := &Client{
        inner: &http.Client{
            Transport: transport,
            // Do NOT follow redirects automatically in service-to-service calls
            // Redirects can mask failures and introduce unexpected behavior
            CheckRedirect: func(req *http.Request, via []*http.Request) error {
                return http.ErrUseLastResponse
            },
        },
        baseURL: baseURL,
        headers: make(map[string]string),
    }
    for _, opt := range opts {
        opt(c)
    }
    return c
}

// ClientOption is a functional option for Client.
type ClientOption func(*Client)

// WithHeader adds a default header to all requests.
func WithHeader(key, value string) ClientOption {
    return func(c *Client) {
        c.headers[key] = value
    }
}

// WithTimeout sets the total request timeout on the underlying http.Client.
// This acts as a backstop — the context passed to Do() takes precedence.
func WithTimeout(d time.Duration) ClientOption {
    return func(c *Client) {
        c.inner.Timeout = d
    }
}

// Get performs an HTTP GET with context-controlled timeout.
// The caller is responsible for creating a context with an appropriate deadline.
//
// Example:
//   ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
//   defer cancel()
//   resp, err := client.Get(ctx, "/api/v1/users/123")
func (c *Client) Get(ctx context.Context, path string) (*http.Response, error) {
    return c.Do(ctx, http.MethodGet, path, nil)
}

// Do executes an HTTP request with the given method, path, and body.
func (c *Client) Do(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
    url := c.baseURL + path
    req, err := http.NewRequestWithContext(ctx, method, url, body)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }

    // Apply default headers
    for k, v := range c.headers {
        req.Header.Set(k, v)
    }

    resp, err := c.inner.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request to %s: %w", url, err)
    }

    return resp, nil
}
```

## Retryable HTTP Client with Exponential Backoff

```go
// pkg/httpclient/retry.go
package httpclient

import (
    "bytes"
    "context"
    "errors"
    "fmt"
    "io"
    "math"
    "math/rand"
    "net/http"
    "time"
)

// RetryConfig configures retry behavior.
type RetryConfig struct {
    // MaxAttempts is the total number of attempts (1 = no retries)
    MaxAttempts int
    // InitialDelay is the base delay for the exponential backoff calculation
    InitialDelay time.Duration
    // MaxDelay caps the exponential backoff
    MaxDelay time.Duration
    // JitterFraction adds randomness to prevent thundering herd
    // A value of 0.1 adds ±10% jitter to the computed delay
    JitterFraction float64
    // RetryableStatusCodes are HTTP status codes that should be retried
    RetryableStatusCodes []int
}

// DefaultRetryConfig returns sensible retry defaults.
func DefaultRetryConfig() RetryConfig {
    return RetryConfig{
        MaxAttempts:  3,
        InitialDelay: 100 * time.Millisecond,
        MaxDelay:     5 * time.Second,
        JitterFraction: 0.1,
        RetryableStatusCodes: []int{
            http.StatusRequestTimeout,      // 408
            http.StatusTooManyRequests,      // 429
            http.StatusInternalServerError,  // 500
            http.StatusBadGateway,           // 502
            http.StatusServiceUnavailable,   // 503
            http.StatusGatewayTimeout,       // 504
        },
    }
}

// RetryTransport is an http.RoundTripper that retries requests on transient failures.
type RetryTransport struct {
    Base   http.RoundTripper
    Config RetryConfig
}

// RoundTrip implements http.RoundTripper with retry logic.
func (rt *RetryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    // Read and buffer the request body so it can be resent on retry
    var bodyBytes []byte
    if req.Body != nil {
        var err error
        bodyBytes, err = io.ReadAll(req.Body)
        if err != nil {
            return nil, fmt.Errorf("reading request body for retry buffer: %w", err)
        }
        req.Body.Close()
    }

    var (
        resp     *http.Response
        lastErr  error
    )

    for attempt := 0; attempt < rt.Config.MaxAttempts; attempt++ {
        // Re-create the body reader for each attempt
        if bodyBytes != nil {
            req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
        }

        // Clone the request to avoid mutation issues across retries
        reqCopy := req.Clone(req.Context())

        resp, lastErr = rt.Base.RoundTrip(reqCopy)

        // Check if the context was cancelled
        if errors.Is(lastErr, context.Canceled) || errors.Is(lastErr, context.DeadlineExceeded) {
            return nil, lastErr
        }

        // Network error — always retry
        if lastErr != nil {
            if attempt < rt.Config.MaxAttempts-1 {
                rt.sleep(req.Context(), attempt)
            }
            continue
        }

        // Check if the status code is retryable
        if !rt.isRetryable(resp.StatusCode) {
            return resp, nil
        }

        // Drain and close the body before retry to free the connection
        // back to the pool
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()

        if attempt < rt.Config.MaxAttempts-1 {
            // Respect Retry-After header if present (common for 429 responses)
            if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
                // Simple numeric seconds parsing
                var seconds float64
                if _, err := fmt.Sscanf(retryAfter, "%f", &seconds); err == nil {
                    delay := time.Duration(seconds * float64(time.Second))
                    if delay > rt.Config.MaxDelay {
                        delay = rt.Config.MaxDelay
                    }
                    select {
                    case <-time.After(delay):
                    case <-req.Context().Done():
                        return nil, req.Context().Err()
                    }
                    continue
                }
            }
            rt.sleep(req.Context(), attempt)
        }
    }

    // All attempts exhausted
    if lastErr != nil {
        return nil, fmt.Errorf("after %d attempts: %w", rt.Config.MaxAttempts, lastErr)
    }
    // Return the last response (even if retryable status) — caller can inspect it
    return resp, nil
}

// sleep waits for the computed backoff duration, respecting context cancellation.
func (rt *RetryTransport) sleep(ctx context.Context, attempt int) {
    // Exponential backoff: delay = initialDelay * 2^attempt
    delay := float64(rt.Config.InitialDelay) * math.Pow(2, float64(attempt))
    if delay > float64(rt.Config.MaxDelay) {
        delay = float64(rt.Config.MaxDelay)
    }
    // Add jitter to prevent synchronized retries
    jitter := (rand.Float64()*2 - 1) * rt.Config.JitterFraction * delay
    sleepDuration := time.Duration(delay + jitter)

    select {
    case <-time.After(sleepDuration):
    case <-ctx.Done():
    }
}

// isRetryable returns true if the status code should be retried.
func (rt *RetryTransport) isRetryable(statusCode int) bool {
    for _, code := range rt.Config.RetryableStatusCodes {
        if statusCode == code {
            return true
        }
    }
    return false
}

// NewRetryableClient creates an HTTP client with retry logic.
func NewRetryableClient(baseURL string, opts ...ClientOption) *Client {
    transport := NewTransport(DefaultTransportConfig())
    retryTransport := &RetryTransport{
        Base:   transport,
        Config: DefaultRetryConfig(),
    }

    c := &Client{
        inner: &http.Client{
            Transport: retryTransport,
            CheckRedirect: func(req *http.Request, via []*http.Request) error {
                return http.ErrUseLastResponse
            },
        },
        baseURL: baseURL,
        headers: make(map[string]string),
    }
    for _, opt := range opts {
        opt(c)
    }
    return c
}
```

## Circuit Breaker Integration

```go
// pkg/httpclient/circuitbreaker.go
package httpclient

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"
)

// CircuitState represents the current state of the circuit breaker.
type CircuitState int

const (
    // StateClosed: requests flow normally
    StateClosed CircuitState = iota
    // StateOpen: requests are rejected immediately
    StateOpen
    // StateHalfOpen: one test request is allowed through
    StateHalfOpen
)

// CircuitBreakerConfig configures the circuit breaker.
type CircuitBreakerConfig struct {
    // FailureThreshold is the number of failures that trip the circuit
    FailureThreshold int
    // SuccessThreshold is the number of successes needed to close a half-open circuit
    SuccessThreshold int
    // Timeout is how long the circuit stays open before transitioning to half-open
    Timeout time.Duration
    // IsFailure determines if a response counts as a failure
    // Defaults to: network errors and 5xx responses
    IsFailure func(resp *http.Response, err error) bool
}

// DefaultCircuitBreakerConfig returns sensible circuit breaker defaults.
func DefaultCircuitBreakerConfig() CircuitBreakerConfig {
    return CircuitBreakerConfig{
        FailureThreshold: 5,
        SuccessThreshold: 2,
        Timeout:          30 * time.Second,
        IsFailure: func(resp *http.Response, err error) bool {
            if err != nil {
                return true
            }
            return resp.StatusCode >= 500
        },
    }
}

// CircuitBreaker implements the circuit breaker pattern for HTTP clients.
type CircuitBreaker struct {
    mu               sync.Mutex
    state            CircuitState
    failures         int
    successes        int
    lastFailureTime  time.Time
    cfg              CircuitBreakerConfig
}

// NewCircuitBreaker creates a new circuit breaker.
func NewCircuitBreaker(cfg CircuitBreakerConfig) *CircuitBreaker {
    return &CircuitBreaker{
        state: StateClosed,
        cfg:   cfg,
    }
}

// Allow returns true if a request should be allowed through.
func (cb *CircuitBreaker) Allow() bool {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        return true
    case StateOpen:
        // Check if the timeout has elapsed
        if time.Since(cb.lastFailureTime) >= cb.cfg.Timeout {
            cb.state = StateHalfOpen
            cb.successes = 0
            return true
        }
        return false
    case StateHalfOpen:
        // Allow only one request through in half-open state
        return cb.successes == 0
    }
    return false
}

// Record records the outcome of a request.
func (cb *CircuitBreaker) Record(resp *http.Response, err error) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if cb.cfg.IsFailure(resp, err) {
        cb.onFailure()
    } else {
        cb.onSuccess()
    }
}

func (cb *CircuitBreaker) onFailure() {
    cb.lastFailureTime = time.Now()
    switch cb.state {
    case StateClosed:
        cb.failures++
        if cb.failures >= cb.cfg.FailureThreshold {
            cb.state = StateOpen
            cb.failures = 0
        }
    case StateHalfOpen:
        cb.state = StateOpen
        cb.successes = 0
    }
}

func (cb *CircuitBreaker) onSuccess() {
    switch cb.state {
    case StateClosed:
        cb.failures = 0
    case StateHalfOpen:
        cb.successes++
        if cb.successes >= cb.cfg.SuccessThreshold {
            cb.state = StateClosed
            cb.successes = 0
            cb.failures = 0
        }
    }
}

// CircuitBreakerTransport wraps an http.RoundTripper with circuit breaker logic.
type CircuitBreakerTransport struct {
    Base    http.RoundTripper
    Breaker *CircuitBreaker
}

// ErrCircuitOpen is returned when the circuit is open.
var ErrCircuitOpen = fmt.Errorf("circuit breaker is open")

// RoundTrip implements http.RoundTripper with circuit breaker protection.
func (t *CircuitBreakerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    if !t.Breaker.Allow() {
        return nil, fmt.Errorf("%w: too many recent failures", ErrCircuitOpen)
    }

    resp, err := t.Base.RoundTrip(req)
    t.Breaker.Record(resp, err)

    return resp, err
}

// NewCircuitBreakerClient creates an HTTP client with circuit breaker protection.
func NewCircuitBreakerClient(baseURL string, opts ...ClientOption) *Client {
    transport := NewTransport(DefaultTransportConfig())
    retryTransport := &RetryTransport{
        Base:   transport,
        Config: DefaultRetryConfig(),
    }
    cbTransport := &CircuitBreakerTransport{
        Base:    retryTransport,
        Breaker: NewCircuitBreaker(DefaultCircuitBreakerConfig()),
    }

    c := &Client{
        inner: &http.Client{
            Transport: cbTransport,
            CheckRedirect: func(req *http.Request, via []*http.Request) error {
                return http.ErrUseLastResponse
            },
        },
        baseURL: baseURL,
        headers: make(map[string]string),
    }
    for _, opt := range opts {
        opt(c)
    }
    return c
}
```

## mTLS Client Certificates

```go
// pkg/httpclient/mtls.go
package httpclient

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "os"
)

// MTLSConfig holds paths to the client certificate files.
type MTLSConfig struct {
    // CertFile is the path to the client certificate (PEM)
    CertFile string
    // KeyFile is the path to the client private key (PEM)
    KeyFile string
    // CAFile is the path to the CA certificate that signed the server cert
    // Leave empty to use the system CA pool
    CAFile string
    // ServerName overrides the server name for TLS verification
    // Useful when the server cert CN does not match the DNS name
    ServerName string
    // InsecureSkipVerify disables TLS verification — NEVER use in production
    InsecureSkipVerify bool
}

// NewMTLSTLSConfig creates a tls.Config for mutual TLS authentication.
// This is used when the server requires the client to present a certificate.
func NewMTLSTLSConfig(cfg MTLSConfig) (*tls.Config, error) {
    // Load the client certificate and key
    clientCert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
    if err != nil {
        return nil, fmt.Errorf("loading client certificate: %w", err)
    }

    // Set up the CA pool
    rootCAs := x509.NewCertPool()
    if cfg.CAFile != "" {
        caCert, err := os.ReadFile(cfg.CAFile)
        if err != nil {
            return nil, fmt.Errorf("reading CA certificate: %w", err)
        }
        if !rootCAs.AppendCertsFromPEM(caCert) {
            return nil, fmt.Errorf("failed to append CA certificate to pool")
        }
    } else {
        // Fall back to the system CA pool
        systemPool, err := x509.SystemCertPool()
        if err != nil {
            return nil, fmt.Errorf("loading system CA pool: %w", err)
        }
        rootCAs = systemPool
    }

    tlsConfig := &tls.Config{
        // Present this certificate when the server requests client auth
        Certificates: []tls.Certificate{clientCert},
        RootCAs:      rootCAs,
        MinVersion:   tls.VersionTLS12,
        ServerName:   cfg.ServerName,
        // GetClientCertificate allows dynamic certificate selection
        // Useful when certificates are rotated frequently
        GetClientCertificate: func(info *tls.CertificateRequestInfo) (*tls.Certificate, error) {
            // Re-read the certificate from disk on each TLS handshake
            // This enables certificate rotation without restarting the process
            cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
            if err != nil {
                return nil, fmt.Errorf("reloading client certificate: %w", err)
            }
            return &cert, nil
        },
    }

    return tlsConfig, nil
}

// NewMTLSClient creates an HTTP client with mutual TLS authentication.
func NewMTLSClient(baseURL string, mtlsCfg MTLSConfig, opts ...ClientOption) (*Client, error) {
    tlsConfig, err := NewMTLSTLSConfig(mtlsCfg)
    if err != nil {
        return nil, err
    }

    transportCfg := DefaultTransportConfig()
    transportCfg.TLSConfig = tlsConfig
    transport := NewTransport(transportCfg)

    c := &Client{
        inner: &http.Client{
            Transport: transport,
            CheckRedirect: func(req *http.Request, via []*http.Request) error {
                return http.ErrUseLastResponse
            },
        },
        baseURL: baseURL,
        headers: make(map[string]string),
    }
    for _, opt := range opts {
        opt(c)
    }
    return c, nil
}
```

## Per-Host Connection Pool Tuning

For services that call many different upstream hosts, a single transport with global limits may be insufficient. A per-host approach allows different connection pool sizes for different services.

```go
// pkg/httpclient/perhost.go
package httpclient

import (
    "net/http"
    "sync"
)

// HostTransportRegistry maintains separate transports per host,
// allowing different connection pool sizes for different upstreams.
type HostTransportRegistry struct {
    mu       sync.RWMutex
    transports map[string]*http.Transport
    defaultCfg TransportConfig
}

// NewHostTransportRegistry creates a new registry with default transport config.
func NewHostTransportRegistry(defaultCfg TransportConfig) *HostTransportRegistry {
    return &HostTransportRegistry{
        transports: make(map[string]*http.Transport),
        defaultCfg: defaultCfg,
    }
}

// Get returns the transport for the given host, creating it if necessary.
func (r *HostTransportRegistry) Get(host string) *http.Transport {
    r.mu.RLock()
    t, ok := r.transports[host]
    r.mu.RUnlock()
    if ok {
        return t
    }

    r.mu.Lock()
    defer r.mu.Unlock()
    // Double-check after acquiring write lock
    if t, ok = r.transports[host]; ok {
        return t
    }
    t = NewTransport(r.defaultCfg)
    r.transports[host] = t
    return t
}

// Register allows setting a custom config for a specific host.
func (r *HostTransportRegistry) Register(host string, cfg TransportConfig) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.transports[host] = NewTransport(cfg)
}

// MultiHostTransport routes requests to per-host transports.
type MultiHostTransport struct {
    registry *HostTransportRegistry
}

// RoundTrip implements http.RoundTripper by selecting the per-host transport.
func (t *MultiHostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    transport := t.registry.Get(req.URL.Host)
    return transport.RoundTrip(req)
}

// Example usage demonstrating per-host configuration:
func ExamplePerHostConfiguration() *http.Client {
    registry := NewHostTransportRegistry(DefaultTransportConfig())

    // High-traffic internal service needs more connections
    registry.Register("high-traffic-api.internal:8080", TransportConfig{
        MaxIdleConnsPerHost:   500,
        MaxConnsPerHost:       1000,
        ResponseHeaderTimeout: 5 * time.Second,
        DialTimeout:           1 * time.Second,
        TLSHandshakeTimeout:   3 * time.Second,
        IdleConnTimeout:       60 * time.Second,
        KeepAlive:             30 * time.Second,
    })

    // Slow external API needs longer timeouts but fewer connections
    registry.Register("slow-vendor-api.example.com:443", TransportConfig{
        MaxIdleConnsPerHost:   10,
        ResponseHeaderTimeout: 30 * time.Second,
        DialTimeout:           10 * time.Second,
        TLSHandshakeTimeout:   10 * time.Second,
        IdleConnTimeout:       120 * time.Second,
        KeepAlive:             60 * time.Second,
    })

    return &http.Client{
        Transport: &MultiHostTransport{registry: registry},
    }
}
```

## Connection Pool Metrics

```go
// pkg/httpclient/metrics.go
package httpclient

import (
    "crypto/tls"
    "net/http/httptrace"
    "context"
    "net/http"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // Track connection reuse rate (high reuse = healthy pool)
    connectionsReused = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_client_connections_reused_total",
            Help: "Number of HTTP connections reused from the pool.",
        },
        []string{"host"},
    )

    connectionsCreated = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_client_connections_created_total",
            Help: "Number of new HTTP connections created.",
        },
        []string{"host"},
    )

    // DNS resolution latency
    dnsLookupDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_client_dns_duration_seconds",
            Help:    "DNS lookup duration.",
            Buckets: prometheus.DefBuckets,
        },
        []string{"host"},
    )

    // TLS handshake latency
    tlsHandshakeDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_client_tls_duration_seconds",
            Help:    "TLS handshake duration.",
            Buckets: prometheus.DefBuckets,
        },
        []string{"host"},
    )
)

// InstrumentedRequest wraps a request with httptrace to collect
// connection-level metrics.
func InstrumentedRequest(ctx context.Context, req *http.Request) (*http.Request, func()) {
    var (
        dnsStart       time.Time
        connectStart   time.Time
        tlsStart       time.Time
    )
    host := req.URL.Host

    trace := &httptrace.ClientTrace{
        // Called when DNS lookup starts
        DNSStart: func(info httptrace.DNSStartInfo) {
            dnsStart = time.Now()
        },
        // Called when DNS lookup completes
        DNSDone: func(info httptrace.DNSDoneInfo) {
            dnsLookupDuration.WithLabelValues(host).
                Observe(time.Since(dnsStart).Seconds())
        },
        // Called when a new connection is established
        ConnectStart: func(network, addr string) {
            connectStart = time.Now()
        },
        // Called when a connection is reused from the pool
        GotConn: func(info httptrace.GotConnInfo) {
            if info.Reused {
                connectionsReused.WithLabelValues(host).Inc()
            } else {
                connectionsCreated.WithLabelValues(host).Inc()
            }
        },
        // Called when TLS handshake starts
        TLSHandshakeStart: func() {
            tlsStart = time.Now()
        },
        // Called when TLS handshake completes
        TLSHandshakeDone: func(state tls.ConnectionState, err error) {
            if err == nil {
                tlsHandshakeDuration.WithLabelValues(host).
                    Observe(time.Since(tlsStart).Seconds())
            }
        },
    }

    ctx = httptrace.WithClientTrace(ctx, trace)
    return req.WithContext(ctx), func() {}
}
```

## Complete Usage Example

```go
// cmd/example/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "time"

    "myapp/pkg/httpclient"
)

type UserResponse struct {
    ID   int    `json:"id"`
    Name string `json:"name"`
}

func main() {
    // Create a production-ready client with retries and circuit breaker
    client := httpclient.NewCircuitBreakerClient(
        "https://api.example.com",
        httpclient.WithHeader("Content-Type", "application/json"),
        httpclient.WithHeader("Authorization", "Bearer "+getToken()),
        httpclient.WithTimeout(30*time.Second),
    )

    // Each request gets its own context with a tight deadline
    // The client timeout is a backstop; context is the primary control
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    resp, err := client.Get(ctx, "/api/v1/users/123")
    if err != nil {
        log.Fatalf("request failed: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        log.Fatalf("unexpected status: %d", resp.StatusCode)
    }

    var user UserResponse
    if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
        log.Fatalf("decoding response: %v", err)
    }

    fmt.Printf("User: %+v\n", user)
}

func getToken() string {
    // In production, load from vault, env, or IMDS
    return "example-token"
}
```

## Summary

Safe Go HTTP clients require deliberate configuration at every layer. The transport must have bounds on dial timeout, TLS handshake duration, response header timeout, and idle connection lifetime. Connection pool sizes per host should reflect the actual concurrency requirements of the specific upstream relationship. Context deadlines on individual requests allow callers to control the full request lifecycle independently of the transport's per-phase limits. Exponential backoff with jitter prevents thundering herd reconvergence after upstream recovery. Circuit breakers shed load during sustained outages rather than queuing requests that will ultimately fail. mTLS with certificate hot-reloading via `GetClientCertificate` ensures authentication credentials can be rotated without restarting the service. The combination of these patterns, instrumented with connection-level Prometheus metrics, produces HTTP clients that behave predictably under the full range of upstream failure modes encountered in production.
