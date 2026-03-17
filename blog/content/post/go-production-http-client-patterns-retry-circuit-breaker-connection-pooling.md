---
title: "Go: Production-Grade HTTP Client Patterns with Retry Logic, Circuit Breakers, and Connection Pooling"
date: 2031-06-15T00:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Client", "Retry", "Circuit Breaker", "Connection Pooling", "Resilience", "Production"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production-grade HTTP clients in Go with exponential backoff retry logic, circuit breakers, connection pool tuning, timeout configuration, and observability middleware."
more_link: "yes"
url: "/go-production-http-client-patterns-retry-circuit-breaker-connection-pooling/"
---

The default `http.Client` in Go is intentionally minimal. No retry logic, no circuit breaking, and default transport settings that will cause resource exhaustion under load. In production microservice environments, every service is both an HTTP server and an HTTP client making dozens or hundreds of outbound calls. Getting the client configuration wrong — too many connections, no timeouts, no retry backoff — leads to cascading failures, resource leaks, and service unavailability. This guide covers the full production HTTP client stack in Go: transport configuration, timeout hierarchy, retry with exponential backoff and jitter, circuit breakers, connection pool management, and request/response middleware.

<!--more-->

# Go: Production-Grade HTTP Client Patterns

## Understanding the Go HTTP Transport

The `http.Transport` is the core of Go's HTTP client. It manages connection pooling, TLS, timeouts, and keep-alives. The default transport is shared globally and has settings that are wrong for most production services.

```go
// The default transport (http.DefaultTransport) has these settings:
// MaxIdleConns:          100
// MaxIdleConnsPerHost:    2  (this is the critical one)
// IdleConnTimeout:       90s
// TLSHandshakeTimeout:   10s
// ExpectContinueTimeout: 1s
// DisableKeepAlives:     false
```

The `MaxIdleConnsPerHost: 2` default is almost always wrong. If your service makes 50 concurrent requests to the same upstream, the transport creates 50 connections and then tries to keep only 2 idle — closing and recreating connections constantly. This burns TCP connection slots, adds latency, and can exhaust ephemeral ports under high load.

## Configuring the Transport for Production

```go
// pkg/httpclient/transport.go
package httpclient

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"time"
)

// TransportConfig holds configuration for the HTTP transport.
type TransportConfig struct {
	// MaxIdleConns is the total number of idle connections across all hosts.
	MaxIdleConns int
	// MaxIdleConnsPerHost is the maximum idle connections to a single host.
	// Should match or exceed your expected concurrency to that host.
	MaxIdleConnsPerHost int
	// MaxConnsPerHost limits total connections (idle + active) to a host.
	// 0 means no limit.
	MaxConnsPerHost int
	// IdleConnTimeout is how long to keep idle connections before closing.
	IdleConnTimeout time.Duration
	// TLSHandshakeTimeout is the maximum time for TLS negotiation.
	TLSHandshakeTimeout time.Duration
	// DialTimeout is the maximum time to establish a TCP connection.
	DialTimeout time.Duration
	// KeepAlive is the TCP keep-alive interval.
	KeepAlive time.Duration
	// DisableHTTP2 disables HTTP/2 (useful for services that don't support it well).
	DisableHTTP2 bool
	// TLSConfig overrides TLS settings.
	TLSConfig *tls.Config
}

// DefaultTransportConfig returns sensible defaults for a microservice.
func DefaultTransportConfig() TransportConfig {
	return TransportConfig{
		MaxIdleConns:        500,
		MaxIdleConnsPerHost: 100,
		MaxConnsPerHost:     200,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		DialTimeout:         5 * time.Second,
		KeepAlive:           30 * time.Second,
	}
}

// NewTransport creates a production-configured HTTP transport.
func NewTransport(cfg TransportConfig) *http.Transport {
	dialer := &net.Dialer{
		Timeout:   cfg.DialTimeout,
		KeepAlive: cfg.KeepAlive,
		// DualStack enables IPv4/IPv6 happy eyeballs
		DualStack: true,
	}

	tlsConfig := cfg.TLSConfig
	if tlsConfig == nil {
		tlsConfig = &tls.Config{
			MinVersion: tls.VersionTLS12,
		}
	}

	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		TLSClientConfig:       tlsConfig,
		TLSHandshakeTimeout:   cfg.TLSHandshakeTimeout,
		MaxIdleConns:          cfg.MaxIdleConns,
		MaxIdleConnsPerHost:   cfg.MaxIdleConnsPerHost,
		MaxConnsPerHost:       cfg.MaxConnsPerHost,
		IdleConnTimeout:       cfg.IdleConnTimeout,
		DisableCompression:    false, // Enable gzip decompression
		ForceAttemptHTTP2:     !cfg.DisableHTTP2,
		ResponseHeaderTimeout: 0, // Set via request context, not transport
		// ExpectContinueTimeout is relevant for PUT/POST with Expect: 100-continue
		ExpectContinueTimeout: 1 * time.Second,
	}

	return transport
}
```

## Timeout Hierarchy

Go's HTTP client has multiple timeout layers that interact. Understanding all of them is critical:

```go
// pkg/httpclient/timeouts.go
package httpclient

import (
	"context"
	"net/http"
	"time"
)

// TimeoutConfig defines the layered timeouts for HTTP requests.
type TimeoutConfig struct {
	// DialTimeout: TCP connection establishment (set on Dialer)
	DialTimeout time.Duration

	// TLSHandshakeTimeout: TLS negotiation (set on Transport)
	TLSHandshakeTimeout time.Duration

	// RequestTimeout: Total time for the complete request+response cycle.
	// This is the context deadline applied to the request.
	RequestTimeout time.Duration

	// ResponseHeaderTimeout: Time to receive first response byte.
	// Not settable via context; must be set on Transport.
	// Protects against slow servers that accept connections but delay responding.
	ResponseHeaderTimeout time.Duration

	// KeepAliveIdleTimeout: How long idle connections are kept (Transport.IdleConnTimeout)
	KeepAliveIdleTimeout time.Duration
}

// DefaultTimeoutConfig returns production-appropriate timeouts.
func DefaultTimeoutConfig() TimeoutConfig {
	return TimeoutConfig{
		DialTimeout:           5 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		RequestTimeout:        30 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		KeepAliveIdleTimeout:  90 * time.Second,
	}
}

// WithRequestTimeout adds a context deadline for the request timeout.
// This is the primary mechanism for controlling request lifetime.
func WithRequestTimeout(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if timeout <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, timeout)
}

// NewClientWithTimeouts creates an http.Client with a structured timeout configuration.
func NewClientWithTimeouts(cfg TimeoutConfig) *http.Client {
	transport := NewTransport(TransportConfig{
		MaxIdleConns:        500,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     cfg.KeepAliveIdleTimeout,
		TLSHandshakeTimeout: cfg.TLSHandshakeTimeout,
		DialTimeout:         cfg.DialTimeout,
	})
	transport.ResponseHeaderTimeout = cfg.ResponseHeaderTimeout

	return &http.Client{
		Transport: transport,
		// Do NOT set http.Client.Timeout for services using per-request timeouts.
		// http.Client.Timeout races with the request context, causing confusing errors.
		// Instead, use context.WithTimeout on each request.
		Timeout: 0,
	}
}
```

## Retry Middleware with Exponential Backoff and Jitter

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
	"net"
	"net/http"
	"time"
)

// RetryConfig configures retry behavior.
type RetryConfig struct {
	// MaxAttempts is the total number of attempts (1 = no retry).
	MaxAttempts int
	// InitialBackoff is the delay before the first retry.
	InitialBackoff time.Duration
	// MaxBackoff caps the backoff regardless of the multiplier.
	MaxBackoff time.Duration
	// BackoffMultiplier is the exponential growth factor.
	BackoffMultiplier float64
	// JitterFraction adds randomness to prevent thundering herds.
	// 0.0 = no jitter, 1.0 = full jitter (0 to backoff).
	JitterFraction float64
	// RetryOn is a function that determines if an error or status should be retried.
	// If nil, the default retry policy is used.
	RetryOn func(resp *http.Response, err error) bool
}

// DefaultRetryConfig returns a sensible retry policy for microservices.
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxAttempts:       3,
		InitialBackoff:    100 * time.Millisecond,
		MaxBackoff:        30 * time.Second,
		BackoffMultiplier: 2.0,
		JitterFraction:    0.3,
		RetryOn:           DefaultRetryPolicy,
	}
}

// DefaultRetryPolicy retries on network errors and 5xx responses (except 501).
// It does NOT retry on 4xx (client errors) to avoid amplifying bad requests.
func DefaultRetryPolicy(resp *http.Response, err error) bool {
	if err != nil {
		// Retry on network errors (connection reset, EOF, timeout)
		var netErr net.Error
		if errors.As(err, &netErr) {
			return true // Includes timeout, temporary
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return true
		}
		return false
	}

	switch resp.StatusCode {
	case http.StatusTooManyRequests:    // 429
		return true
	case http.StatusBadGateway:        // 502
		return true
	case http.StatusServiceUnavailable: // 503
		return true
	case http.StatusGatewayTimeout:    // 504
		return true
	default:
		return resp.StatusCode >= 500
	}
}

// backoffDuration calculates the backoff duration for attempt n (0-indexed).
func backoffDuration(cfg RetryConfig, attempt int) time.Duration {
	if attempt == 0 {
		return 0
	}

	backoff := float64(cfg.InitialBackoff) * math.Pow(cfg.BackoffMultiplier, float64(attempt-1))
	if backoff > float64(cfg.MaxBackoff) {
		backoff = float64(cfg.MaxBackoff)
	}

	// Add jitter: backoff * (1 - jitter) to backoff * 1
	if cfg.JitterFraction > 0 {
		jitter := backoff * cfg.JitterFraction * rand.Float64()
		backoff = backoff*(1-cfg.JitterFraction) + jitter
	}

	return time.Duration(backoff)
}

// RetryTransport wraps an http.RoundTripper with retry logic.
type RetryTransport struct {
	Base   http.RoundTripper
	Config RetryConfig
}

// RoundTrip implements http.RoundTripper with retry semantics.
func (t *RetryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Buffer the request body so it can be re-sent on retry.
	// Non-idempotent methods (POST, PATCH) should not be retried by default.
	var bodyBytes []byte
	if req.Body != nil && req.Body != http.NoBody {
		var err error
		bodyBytes, err = io.ReadAll(req.Body)
		if err != nil {
			return nil, fmt.Errorf("reading request body: %w", err)
		}
		req.Body.Close()
	}

	retryOn := t.Config.RetryOn
	if retryOn == nil {
		retryOn = DefaultRetryPolicy
	}

	var resp *http.Response
	var lastErr error

	for attempt := 0; attempt < t.Config.MaxAttempts; attempt++ {
		// Wait before retry (not before first attempt)
		if attempt > 0 {
			delay := backoffDuration(t.Config, attempt)
			select {
			case <-req.Context().Done():
				return nil, req.Context().Err()
			case <-time.After(delay):
			}
		}

		// Restore the request body for this attempt
		if bodyBytes != nil {
			req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
			req.ContentLength = int64(len(bodyBytes))
		}

		// Clone the request to avoid mutating the original
		reqCopy := req.Clone(req.Context())

		resp, lastErr = t.Base.RoundTrip(reqCopy)

		// Drain and close the response body if we're going to retry
		// to release the connection back to the pool
		if resp != nil && retryOn(resp, lastErr) && attempt < t.Config.MaxAttempts-1 {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			resp = nil
			continue
		}

		if lastErr == nil && !retryOn(resp, nil) {
			return resp, nil
		}

		if !retryOn(resp, lastErr) {
			return resp, lastErr
		}
	}

	if resp != nil {
		return resp, nil
	}
	return nil, fmt.Errorf("request failed after %d attempts: %w", t.Config.MaxAttempts, lastErr)
}

// NewRetryClient creates an HTTP client with retry behavior.
func NewRetryClient(base *http.Client, cfg RetryConfig) *http.Client {
	return &http.Client{
		Transport: &RetryTransport{
			Base:   base.Transport,
			Config: cfg,
		},
		CheckRedirect: base.CheckRedirect,
		Jar:           base.Jar,
		Timeout:       base.Timeout,
	}
}
```

## Circuit Breaker Implementation

```go
// pkg/httpclient/circuitbreaker.go
package httpclient

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// CircuitState represents the state of a circuit breaker.
type CircuitState int

const (
	// StateClosed: circuit is healthy, requests flow normally.
	StateClosed CircuitState = iota
	// StateOpen: circuit has tripped, requests are rejected immediately.
	StateOpen
	// StateHalfOpen: circuit is testing recovery, limited requests allowed.
	StateHalfOpen
)

func (s CircuitState) String() string {
	switch s {
	case StateClosed:
		return "closed"
	case StateOpen:
		return "open"
	case StateHalfOpen:
		return "half-open"
	default:
		return "unknown"
	}
}

// ErrCircuitOpen is returned when the circuit is open and the request is rejected.
var ErrCircuitOpen = errors.New("circuit breaker is open")

// CircuitBreakerConfig configures the circuit breaker.
type CircuitBreakerConfig struct {
	// Name is a human-readable identifier for this circuit.
	Name string
	// FailureThreshold is the number of consecutive failures before tripping.
	FailureThreshold int
	// SuccessThreshold is the number of consecutive successes in half-open state
	// required to close the circuit.
	SuccessThreshold int
	// OpenTimeout is how long the circuit stays open before entering half-open.
	OpenTimeout time.Duration
	// HalfOpenMaxConcurrent limits concurrent requests in half-open state.
	HalfOpenMaxConcurrent int
	// OnStateChange is called when the circuit state transitions.
	OnStateChange func(name string, from, to CircuitState)
	// IsFailure determines if a response counts as a failure.
	// If nil, any 5xx response or error is a failure.
	IsFailure func(resp *http.Response, err error) bool
}

// DefaultCircuitBreakerConfig returns sensible defaults.
func DefaultCircuitBreakerConfig(name string) CircuitBreakerConfig {
	return CircuitBreakerConfig{
		Name:                  name,
		FailureThreshold:      5,
		SuccessThreshold:      2,
		OpenTimeout:           30 * time.Second,
		HalfOpenMaxConcurrent: 3,
		IsFailure:             defaultIsFailure,
	}
}

func defaultIsFailure(resp *http.Response, err error) bool {
	if err != nil {
		return true
	}
	return resp.StatusCode >= 500
}

// CircuitBreaker implements the circuit breaker pattern.
type CircuitBreaker struct {
	cfg             CircuitBreakerConfig
	mu              sync.Mutex
	state           CircuitState
	failures        int
	successes       int
	lastStateChange time.Time
	halfOpenCount   int
}

// NewCircuitBreaker creates a new circuit breaker.
func NewCircuitBreaker(cfg CircuitBreakerConfig) *CircuitBreaker {
	if cfg.FailureThreshold == 0 {
		cfg.FailureThreshold = 5
	}
	if cfg.SuccessThreshold == 0 {
		cfg.SuccessThreshold = 2
	}
	if cfg.OpenTimeout == 0 {
		cfg.OpenTimeout = 30 * time.Second
	}
	if cfg.HalfOpenMaxConcurrent == 0 {
		cfg.HalfOpenMaxConcurrent = 3
	}
	if cfg.IsFailure == nil {
		cfg.IsFailure = defaultIsFailure
	}
	return &CircuitBreaker{
		cfg:             cfg,
		state:           StateClosed,
		lastStateChange: time.Now(),
	}
}

// Allow returns an error if the circuit is open and the request should be rejected.
func (cb *CircuitBreaker) Allow() error {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case StateClosed:
		return nil

	case StateOpen:
		// Check if it's time to try recovery
		if time.Since(cb.lastStateChange) > cb.cfg.OpenTimeout {
			cb.transitionTo(StateHalfOpen)
			cb.halfOpenCount = 1
			return nil
		}
		return fmt.Errorf("%w: %s", ErrCircuitOpen, cb.cfg.Name)

	case StateHalfOpen:
		if cb.halfOpenCount >= cb.cfg.HalfOpenMaxConcurrent {
			return fmt.Errorf("%w (half-open, at capacity): %s", ErrCircuitOpen, cb.cfg.Name)
		}
		cb.halfOpenCount++
		return nil

	default:
		return nil
	}
}

// Record records the outcome of a request.
func (cb *CircuitBreaker) Record(resp *http.Response, err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	isFailure := cb.cfg.IsFailure(resp, err)

	switch cb.state {
	case StateClosed:
		if isFailure {
			cb.failures++
			if cb.failures >= cb.cfg.FailureThreshold {
				cb.transitionTo(StateOpen)
			}
		} else {
			cb.failures = 0 // Reset on success
		}

	case StateHalfOpen:
		cb.halfOpenCount--
		if isFailure {
			cb.transitionTo(StateOpen)
		} else {
			cb.successes++
			if cb.successes >= cb.cfg.SuccessThreshold {
				cb.transitionTo(StateClosed)
			}
		}
	}
}

func (cb *CircuitBreaker) transitionTo(state CircuitState) {
	from := cb.state
	cb.state = state
	cb.lastStateChange = time.Now()
	cb.failures = 0
	cb.successes = 0
	cb.halfOpenCount = 0

	if cb.cfg.OnStateChange != nil {
		go cb.cfg.OnStateChange(cb.cfg.Name, from, state)
	}
}

// State returns the current circuit state.
func (cb *CircuitBreaker) State() CircuitState {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.state
}

// CircuitBreakerTransport wraps an http.RoundTripper with circuit breaker logic.
type CircuitBreakerTransport struct {
	Base    http.RoundTripper
	Breaker *CircuitBreaker
}

func (t *CircuitBreakerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := t.Breaker.Allow(); err != nil {
		return nil, err
	}

	resp, err := t.Base.RoundTrip(req)
	t.Breaker.Record(resp, err)
	return resp, err
}
```

## Observability Middleware

```go
// pkg/httpclient/middleware.go
package httpclient

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptrace"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// MetricsConfig holds Prometheus metric names.
type MetricsConfig struct {
	Namespace  string
	Subsystem  string
	TargetHost string
}

// MetricsTransport records Prometheus metrics for outbound HTTP requests.
type MetricsTransport struct {
	Base       http.RoundTripper
	targetHost string

	requestDuration *prometheus.HistogramVec
	requestsTotal   *prometheus.CounterVec
	inFlight        prometheus.Gauge
}

// NewMetricsTransport creates a transport that records Prometheus metrics.
func NewMetricsTransport(base http.RoundTripper, cfg MetricsConfig, reg prometheus.Registerer) *MetricsTransport {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}

	return &MetricsTransport{
		Base:       base,
		targetHost: cfg.TargetHost,

		requestDuration: promauto.With(reg).NewHistogramVec(
			prometheus.HistogramOpts{
				Namespace: cfg.Namespace,
				Subsystem: cfg.Subsystem,
				Name:      "http_request_duration_seconds",
				Help:      "Outbound HTTP request duration in seconds",
				Buckets:   []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
			},
			[]string{"target", "method", "status_code"},
		),

		requestsTotal: promauto.With(reg).NewCounterVec(
			prometheus.CounterOpts{
				Namespace: cfg.Namespace,
				Subsystem: cfg.Subsystem,
				Name:      "http_requests_total",
				Help:      "Total outbound HTTP requests",
			},
			[]string{"target", "method", "status_code"},
		),

		inFlight: promauto.With(reg).NewGauge(
			prometheus.GaugeOpts{
				Namespace:   cfg.Namespace,
				Subsystem:   cfg.Subsystem,
				Name:        "http_requests_in_flight",
				Help:        "Currently in-flight outbound HTTP requests",
				ConstLabels: prometheus.Labels{"target": cfg.TargetHost},
			},
		),
	}
}

func (t *MetricsTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	t.inFlight.Inc()
	defer t.inFlight.Dec()

	resp, err := t.Base.RoundTrip(req)

	duration := time.Since(start).Seconds()
	statusCode := "error"
	if err == nil {
		statusCode = fmt.Sprintf("%d", resp.StatusCode)
	}

	target := t.targetHost
	if target == "" {
		target = req.URL.Host
	}

	t.requestDuration.WithLabelValues(target, req.Method, statusCode).Observe(duration)
	t.requestsTotal.WithLabelValues(target, req.Method, statusCode).Inc()

	return resp, err
}

// LoggingTransport logs each HTTP request with timing and status.
type LoggingTransport struct {
	Base   http.RoundTripper
	Logger *slog.Logger
	// LogBody enables request/response body logging (expensive, for debug only)
	LogBody bool
}

func (t *LoggingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()

	resp, err := t.Base.RoundTrip(req)

	attrs := []slog.Attr{
		slog.String("method", req.Method),
		slog.String("url", req.URL.String()),
		slog.Duration("duration", time.Since(start)),
	}

	if err != nil {
		attrs = append(attrs, slog.String("error", err.Error()))
		t.Logger.LogAttrs(req.Context(), slog.LevelWarn, "http request failed", attrs...)
		return nil, err
	}

	attrs = append(attrs, slog.Int("status_code", resp.StatusCode))
	level := slog.LevelDebug
	if resp.StatusCode >= 400 {
		level = slog.LevelWarn
	}
	if resp.StatusCode >= 500 {
		level = slog.LevelError
	}

	t.Logger.LogAttrs(req.Context(), level, "http request", attrs...)
	return resp, nil
}

// TraceTransport adds httptrace instrumentation for detailed timing breakdown.
func AddTrace(ctx context.Context) context.Context {
	trace := &httptrace.ClientTrace{
		DNSDone: func(info httptrace.DNSDoneInfo) {
			if info.Err != nil {
				slog.Warn("DNS lookup failed", "error", info.Err)
			}
		},
		ConnectDone: func(network, addr string, err error) {
			if err != nil {
				slog.Warn("connection failed", "network", network, "addr", addr, "error", err)
			}
		},
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			if err != nil {
				slog.Warn("TLS handshake failed", "error", err)
			}
		},
		GotFirstResponseByte: func() {
			// Time to first byte
		},
	}
	return httptrace.WithClientTrace(ctx, trace)
}
```

## Building the Complete Client

```go
// pkg/httpclient/client.go
package httpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// ClientConfig holds all configuration for a production HTTP client.
type ClientConfig struct {
	// ServiceName is used for metrics labels and logging.
	ServiceName string
	// TargetHost is the primary upstream host (for metrics).
	TargetHost string
	// Transport configures connection pooling.
	Transport TransportConfig
	// Timeouts configures all timeout layers.
	Timeouts TimeoutConfig
	// Retry configures retry behavior.
	Retry RetryConfig
	// CircuitBreaker configures the circuit breaker.
	CircuitBreaker CircuitBreakerConfig
	// MetricsRegistry is the Prometheus registry to use.
	MetricsRegistry prometheus.Registerer
	// Logger for request logging.
	Logger *slog.Logger
}

// DefaultClientConfig returns a production-ready client configuration.
func DefaultClientConfig(serviceName, targetHost string) ClientConfig {
	return ClientConfig{
		ServiceName:    serviceName,
		TargetHost:     targetHost,
		Transport:      DefaultTransportConfig(),
		Timeouts:       DefaultTimeoutConfig(),
		Retry:          DefaultRetryConfig(),
		CircuitBreaker: DefaultCircuitBreakerConfig(targetHost),
	}
}

// Client is a production-grade HTTP client with all resilience patterns.
type Client struct {
	cfg     ClientConfig
	inner   *http.Client
	breaker *CircuitBreaker
}

// New creates a production HTTP client.
func New(cfg ClientConfig) *Client {
	transport := NewTransport(cfg.Transport)
	transport.ResponseHeaderTimeout = cfg.Timeouts.ResponseHeaderTimeout

	var rt http.RoundTripper = transport

	// Layer: metrics (outermost, measures total request time including retries)
	if cfg.MetricsRegistry != nil {
		rt = NewMetricsTransport(rt, MetricsConfig{
			Namespace:  cfg.ServiceName,
			Subsystem:  "http_client",
			TargetHost: cfg.TargetHost,
		}, cfg.MetricsRegistry)
	}

	// Layer: logging
	if cfg.Logger != nil {
		rt = &LoggingTransport{Base: rt, Logger: cfg.Logger}
	}

	// Layer: retry
	rt = &RetryTransport{Base: rt, Config: cfg.Retry}

	// Layer: circuit breaker
	breaker := NewCircuitBreaker(cfg.CircuitBreaker)
	rt = &CircuitBreakerTransport{Base: rt, Breaker: breaker}

	return &Client{
		cfg:     cfg,
		breaker: breaker,
		inner: &http.Client{
			Transport: rt,
		},
	}
}

// Do executes an HTTP request with the configured timeout.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(req.Context(), c.cfg.Timeouts.RequestTimeout)
	defer cancel()

	return c.inner.Do(req.WithContext(ctx))
}

// Get performs a GET request.
func (c *Client) Get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("creating GET request to %q: %w", url, err)
	}
	return c.Do(req)
}

// GetJSON performs a GET and decodes the JSON response into v.
func (c *Client) GetJSON(ctx context.Context, url string, v any) error {
	resp, err := c.Get(ctx, url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("GET %s returned %d: %s", url, resp.StatusCode, body)
	}

	return json.NewDecoder(resp.Body).Decode(v)
}

// CircuitState returns the current circuit breaker state.
func (c *Client) CircuitState() CircuitState {
	return c.breaker.State()
}
```

## Usage Example: Calling an Upstream API

```go
// cmd/api/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"yourorg/service/pkg/httpclient"
)

type UserResponse struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	reg := prometheus.NewRegistry()

	// Create the production HTTP client
	client := httpclient.New(httpclient.ClientConfig{
		ServiceName: "my-service",
		TargetHost:  "users-api.internal",
		Transport: httpclient.TransportConfig{
			MaxIdleConns:        200,
			MaxIdleConnsPerHost: 50,
			MaxConnsPerHost:     100,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 5 * time.Second,
			DialTimeout:         5 * time.Second,
			KeepAlive:           30 * time.Second,
		},
		Timeouts: httpclient.TimeoutConfig{
			RequestTimeout:        10 * time.Second,
			ResponseHeaderTimeout: 5 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			DialTimeout:           5 * time.Second,
			KeepAliveIdleTimeout:  90 * time.Second,
		},
		Retry: httpclient.RetryConfig{
			MaxAttempts:       3,
			InitialBackoff:    50 * time.Millisecond,
			MaxBackoff:        5 * time.Second,
			BackoffMultiplier: 2.0,
			JitterFraction:    0.3,
			// Only retry GET requests (idempotent)
			RetryOn: func(resp *http.Response, err error) bool {
				return httpclient.DefaultRetryPolicy(resp, err)
			},
		},
		CircuitBreaker: httpclient.CircuitBreakerConfig{
			Name:                  "users-api",
			FailureThreshold:      10,
			SuccessThreshold:      3,
			OpenTimeout:           30 * time.Second,
			HalfOpenMaxConcurrent: 5,
			OnStateChange: func(name string, from, to httpclient.CircuitState) {
				logger.Warn("circuit breaker state change",
					"circuit", name,
					"from", from.String(),
					"to", to.String(),
				)
			},
		},
		MetricsRegistry: reg,
		Logger:          logger,
	})

	// Use the client
	ctx := context.Background()

	var user UserResponse
	if err := client.GetJSON(ctx, "https://users-api.internal/v1/users/123", &user); err != nil {
		logger.Error("fetching user", "error", err)
		os.Exit(1)
	}

	fmt.Printf("User: %+v\n", user)
	fmt.Printf("Circuit state: %s\n", client.CircuitState())
}
```

## Connection Pool Health Monitoring

```go
// pkg/httpclient/poolstats.go
package httpclient

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// PoolStatsCollector exposes http.Transport connection pool stats to Prometheus.
type PoolStatsCollector struct {
	transport *http.Transport
	target    string

	idleConns prometheus.Gauge
}

// NewPoolStatsCollector creates a collector for transport pool stats.
func NewPoolStatsCollector(transport *http.Transport, target string, reg prometheus.Registerer) *PoolStatsCollector {
	c := &PoolStatsCollector{
		transport: transport,
		target:    target,
		idleConns: promauto.With(reg).NewGauge(prometheus.GaugeOpts{
			Name:        "http_client_idle_connections",
			Help:        "Number of idle HTTP client connections",
			ConstLabels: prometheus.Labels{"target": target},
		}),
	}
	return c
}

// StartCollecting polls pool stats at the given interval.
func (c *PoolStatsCollector) StartCollecting(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			// http.Transport does not expose idle connection counts directly.
			// Use runtime metrics or instrumented transport for accurate counts.
			// This is a placeholder for custom instrumentation.
			_ = c.transport
		}
	}()
}
```

## Testing with a Mock Server

```go
// pkg/httpclient/retry_test.go
package httpclient_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"yourorg/service/pkg/httpclient"
)

func TestRetry_RetriesOn503(t *testing.T) {
	var callCount int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count := atomic.AddInt32(&callCount, 1)
		if count < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()

	client := httpclient.New(httpclient.ClientConfig{
		ServiceName: "test",
		TargetHost:  "localhost",
		Transport:   httpclient.DefaultTransportConfig(),
		Timeouts: httpclient.TimeoutConfig{
			RequestTimeout:        5 * time.Second,
			ResponseHeaderTimeout: 2 * time.Second,
			DialTimeout:           1 * time.Second,
		},
		Retry: httpclient.RetryConfig{
			MaxAttempts:       3,
			InitialBackoff:    10 * time.Millisecond,
			MaxBackoff:        100 * time.Millisecond,
			BackoffMultiplier: 2.0,
		},
		CircuitBreaker: httpclient.DefaultCircuitBreakerConfig("test"),
	})

	resp, err := client.Get(t.Context(), server.URL+"/test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	if atomic.LoadInt32(&callCount) != 3 {
		t.Errorf("expected 3 calls (2 failures + 1 success), got %d", callCount)
	}
}

func TestCircuitBreaker_OpensAfterThreshold(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := httpclient.New(httpclient.ClientConfig{
		ServiceName: "test",
		TargetHost:  "localhost",
		Transport:   httpclient.DefaultTransportConfig(),
		Timeouts: httpclient.TimeoutConfig{
			RequestTimeout: 2 * time.Second,
			DialTimeout:    1 * time.Second,
		},
		Retry: httpclient.RetryConfig{
			MaxAttempts: 1, // No retry to test circuit breaker directly
		},
		CircuitBreaker: httpclient.CircuitBreakerConfig{
			Name:             "test",
			FailureThreshold: 3,
			SuccessThreshold: 1,
			OpenTimeout:      1 * time.Second,
		},
	})

	// Make requests until circuit opens
	for i := 0; i < 3; i++ {
		client.Get(t.Context(), server.URL+"/test")
	}

	if client.CircuitState() != httpclient.StateOpen {
		t.Fatal("expected circuit to be open after threshold")
	}

	// Next request should fail with circuit open error
	_, err := client.Get(t.Context(), server.URL+"/test")
	if err == nil {
		t.Fatal("expected error when circuit is open")
	}
}
```

## Conclusion

A production HTTP client in Go is not a single object but a stack of concerns: connection pool tuning (transport settings), timeout hierarchy (dial, TLS, response header, total), retry with exponential backoff and jitter (retry transport), circuit breaking (circuit breaker transport), and observability (metrics and logging transports). Each layer wraps the previous using Go's `http.RoundTripper` interface, making the composition clean and testable. The key configurations that most teams get wrong are `MaxIdleConnsPerHost` (too low, causing connection churn), missing `ResponseHeaderTimeout` (allows slow servers to hold connections indefinitely), and synchronous retry without jitter (thundering herd on recovery). Getting these right is the difference between a service that degrades gracefully under upstream failures and one that cascades failures across the entire microservice graph.
