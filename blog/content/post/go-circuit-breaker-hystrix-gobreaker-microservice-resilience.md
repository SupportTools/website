---
title: "Go: Implementing Circuit Breakers with hystrix-go and gobreaker for Microservice Resilience"
date: 2031-09-03T00:00:00-05:00
draft: false
tags: ["Go", "Circuit Breaker", "Resilience", "Microservices", "hystrix-go", "gobreaker", "Fault Tolerance"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement the circuit breaker pattern in Go using hystrix-go and gobreaker, with bulkheads, fallbacks, metrics dashboards, and production-ready integration patterns for microservice resilience."
more_link: "yes"
url: "/go-circuit-breaker-hystrix-gobreaker-microservice-resilience/"
---

A circuit breaker is the pattern that separates well-designed microservice architectures from cascading failure disasters. Without it, a single downstream service timeout propagates upstream, exhausting connection pools and goroutines until the entire system enters a state of synchronized failure. This post implements circuit breakers with both major Go libraries, discusses their trade-offs, and builds production-ready resilience patterns around them.

<!--more-->

# Go: Implementing Circuit Breakers with hystrix-go and gobreaker for Microservice Resilience

## The Cascading Failure Problem

Consider a payment service that calls three downstream services: fraud detection, inventory, and notification. Without circuit breakers:

1. Fraud detection service begins responding slowly (60-second timeouts instead of 100ms)
2. Payment service goroutines pile up waiting for fraud detection
3. Payment service's connection pool exhausts
4. API gateway's upstream pool to payment service exhausts
5. All requests fail with 503 — the system appears fully down, though only fraud detection is slow

With circuit breakers:

1. Fraud detection begins failing
2. After N failures, the circuit opens
3. Payment service immediately returns a fallback (approve with flag for manual review)
4. No goroutines pile up; throughput remains high
5. After a configured timeout, the circuit half-opens and probes fraud detection
6. When fraud detection recovers, the circuit closes automatically

## Library Comparison

| Feature | hystrix-go | gobreaker |
|---------|-----------|-----------|
| State machine | Three-state (closed/open/half-open) | Three-state |
| Configuration | Per-command global registry | Per-breaker struct |
| Concurrency limit | Yes (semaphore pool) | No |
| Timeout handling | Built-in | Manual (context) |
| Fallback | First-class | Manual |
| Metrics stream | SSE endpoint (Hystrix Dashboard) | Custom |
| Thread safety | Yes | Yes |
| Maintenance | Low (afew releases/year) | Active |

Use **hystrix-go** when you need a Hystrix Dashboard or are migrating from Java Hystrix. Use **gobreaker** when you want a simple, well-tested state machine to wrap yourself.

## hystrix-go Implementation

### Installation and Configuration

```bash
go get github.com/afex/hystrix-go/hystrix
go get github.com/prometheus/client_golang/prometheus
```

### Configuring Commands

```go
// resilience/hystrix.go
package resilience

import (
	"time"

	"github.com/afex/hystrix-go/hystrix"
)

// CommandConfig wraps hystrix settings for readability.
type CommandConfig struct {
	Name                   string
	Timeout                time.Duration
	MaxConcurrentRequests  int
	ErrorThresholdPercent  int
	RequestVolumeThreshold int   // Min requests before circuit can open
	SleepWindow            time.Duration
}

// DefaultCommandConfig returns sensible production defaults.
func DefaultCommandConfig(name string) CommandConfig {
	return CommandConfig{
		Name:                   name,
		Timeout:                1000 * time.Millisecond,
		MaxConcurrentRequests:  100,
		ErrorThresholdPercent:  50,
		RequestVolumeThreshold: 20,
		SleepWindow:            5000 * time.Millisecond,
	}
}

// Configure registers a hystrix command with the given settings.
func Configure(cfg CommandConfig) {
	hystrix.ConfigureCommand(cfg.Name, hystrix.CommandConfig{
		Timeout:                int(cfg.Timeout.Milliseconds()),
		MaxConcurrentRequests:  cfg.MaxConcurrentRequests,
		ErrorPercentThreshold:  cfg.ErrorThresholdPercent,
		RequestVolumeThreshold: cfg.RequestVolumeThreshold,
		SleepWindow:            int(cfg.SleepWindow.Milliseconds()),
	})
}

// ConfigureAll registers all service commands at startup.
func ConfigureAll() {
	services := []CommandConfig{
		{
			Name:                   "fraud-detection",
			Timeout:                500 * time.Millisecond,
			MaxConcurrentRequests:  50,
			ErrorThresholdPercent:  40,
			RequestVolumeThreshold: 10,
			SleepWindow:            3000 * time.Millisecond,
		},
		{
			Name:                   "inventory-check",
			Timeout:                200 * time.Millisecond,
			MaxConcurrentRequests:  200,
			ErrorThresholdPercent:  50,
			RequestVolumeThreshold: 20,
			SleepWindow:            5000 * time.Millisecond,
		},
		{
			Name:                   "notification-service",
			Timeout:                300 * time.Millisecond,
			MaxConcurrentRequests:  100,
			ErrorThresholdPercent:  60,  // Higher tolerance: non-critical
			RequestVolumeThreshold: 15,
			SleepWindow:            10000 * time.Millisecond,
		},
		{
			Name:                   "payment-gateway",
			Timeout:                3000 * time.Millisecond,
			MaxConcurrentRequests:  25,  // Payment is expensive; limit concurrency
			ErrorThresholdPercent:  20,  // Open faster: payments are critical
			RequestVolumeThreshold: 5,
			SleepWindow:            30000 * time.Millisecond,
		},
	}

	for _, s := range services {
		Configure(s)
	}
}
```

### Service Clients with Circuit Breakers

```go
// clients/fraud.go
package clients

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/afex/hystrix-go/hystrix"
)

// FraudResult is the response from the fraud detection service.
type FraudResult struct {
	Score      float64 `json:"score"`
	Approved   bool    `json:"approved"`
	Flags      []string `json:"flags,omitempty"`
	Fallback   bool    `json:"-"`    // True when circuit breaker used fallback
}

// FraudClient calls the fraud detection service with a circuit breaker.
type FraudClient struct {
	baseURL string
	client  *http.Client
}

func NewFraudClient(baseURL string) *FraudClient {
	return &FraudClient{
		baseURL: baseURL,
		client: &http.Client{
			Timeout: 600 * time.Millisecond,  // Slightly over hystrix timeout
		},
	}
}

// CheckFraud calls fraud detection, falling back to a safe approval if the
// circuit is open.
func (c *FraudClient) CheckFraud(ctx context.Context, orderID string, amount float64) (*FraudResult, error) {
	var result FraudResult

	err := hystrix.DoC(ctx, "fraud-detection",
		// Primary function
		func(ctx context.Context) error {
			url := fmt.Sprintf("%s/check?order_id=%s&amount=%.2f", c.baseURL, orderID, amount)
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if err != nil {
				return err
			}

			resp, err := c.client.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()

			if resp.StatusCode >= 500 {
				return fmt.Errorf("fraud service error: %d", resp.StatusCode)
			}

			return json.NewDecoder(resp.Body).Decode(&result)
		},
		// Fallback function — called when circuit is open OR primary fails
		func(ctx context.Context, err error) error {
			// Safe fallback: approve with low score, flag for manual review
			result = FraudResult{
				Score:    0.5,    // Neutral score
				Approved: true,   // Approve to avoid blocking customer
				Flags:    []string{"FRAUD_CHECK_UNAVAILABLE"},
				Fallback: true,
			}
			return nil  // Don't propagate the error when fallback succeeds
		},
	)

	return &result, err
}
```

### Bulkhead Pattern with hystrix

The `MaxConcurrentRequests` setting implements the bulkhead pattern — limiting the number of concurrent goroutines per command, so a slow downstream cannot consume all available goroutines:

```go
// clients/inventory.go
package clients

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/afex/hystrix-go/hystrix"
)

type InventoryResult struct {
	Available bool  `json:"available"`
	Quantity  int   `json:"quantity"`
	Fallback  bool  `json:"-"`
}

type InventoryClient struct {
	baseURL string
	client  *http.Client
}

func NewInventoryClient(baseURL string) *InventoryClient {
	return &InventoryClient{baseURL: baseURL, client: &http.Client{}}
}

func (c *InventoryClient) CheckAvailability(ctx context.Context, skuID string, qty int) (*InventoryResult, error) {
	var result InventoryResult

	err := hystrix.DoC(ctx, "inventory-check",
		func(ctx context.Context) error {
			url := fmt.Sprintf("%s/inventory/%s?qty=%d", c.baseURL, skuID, qty)
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			resp, err := c.client.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			return json.NewDecoder(resp.Body).Decode(&result)
		},
		func(ctx context.Context, err error) error {
			// Fallback: optimistically allow the order; inventory confirmed on fulfillment
			result = InventoryResult{Available: true, Quantity: qty, Fallback: true}
			return nil
		},
	)

	return &result, err
}
```

### Exposing the Hystrix Metrics Stream

```go
// cmd/server/main.go — expose Hystrix metrics for dashboard
import (
	"net/http"

	"github.com/afex/hystrix-go/hystrix/metric_collector"
	"github.com/afex/hystrix-go/plugins"
)

func setupHystrixMetrics(addr string) {
	// Built-in turbine-compatible SSE stream
	hystrixStreamHandler := hystrix.NewStreamHandler()
	hystrixStreamHandler.Start()

	go func() {
		http.Handle("/hystrix.stream", hystrixStreamHandler)
		http.ListenAndServe(addr, nil)
	}()
}

// Or export to Prometheus
func setupPrometheusMetrics() {
	collector, err := plugins.InitializePrometheusCollector(
		plugins.PrometheusCollectorConfig{
			Namespace: "myapp",
		},
	)
	if err != nil {
		panic(err)
	}
	metricCollector.Registry.Register(collector.NewPrometheusCollector)
}
```

## gobreaker Implementation

gobreaker provides a cleaner, more Go-idiomatic API. It is easier to test and compose.

```bash
go get github.com/sony/gobreaker
```

### Core gobreaker Usage

```go
// resilience/breaker.go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/sony/gobreaker"
)

// BreakerConfig holds circuit breaker parameters.
type BreakerConfig struct {
	Name        string
	MaxFailures uint32
	Interval    time.Duration  // Rolling window for failure counting
	Timeout     time.Duration  // How long to stay open before half-opening
	ReadyToTrip func(counts gobreaker.Counts) bool
	OnStateChange func(name string, from, to gobreaker.State)
}

// NewBreaker creates a gobreaker with sensible defaults.
func NewBreaker(cfg BreakerConfig, log *slog.Logger) *gobreaker.CircuitBreaker {
	readyToTrip := cfg.ReadyToTrip
	if readyToTrip == nil {
		readyToTrip = func(counts gobreaker.Counts) bool {
			failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
			return counts.Requests >= 5 && failureRatio >= 0.5
		}
	}

	onStateChange := cfg.OnStateChange
	if onStateChange == nil {
		onStateChange = func(name string, from, to gobreaker.State) {
			log.Warn("circuit breaker state change",
				"circuit", name,
				"from", from.String(),
				"to", to.String(),
			)
		}
	}

	return gobreaker.NewCircuitBreaker(gobreaker.Settings{
		Name:          cfg.Name,
		MaxRequests:   1,              // In half-open state, allow 1 probe request
		Interval:      cfg.Interval,
		Timeout:       cfg.Timeout,
		ReadyToTrip:   readyToTrip,
		OnStateChange: onStateChange,
	})
}
```

### Generic Retry + Circuit Breaker Wrapper

```go
// resilience/executor.go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"time"

	"github.com/sony/gobreaker"
)

// ErrCircuitOpen indicates the circuit breaker is open.
var ErrCircuitOpen = errors.New("circuit breaker is open")

// Executor wraps a circuit breaker with retry and timeout logic.
type Executor struct {
	breaker    *gobreaker.CircuitBreaker
	maxRetries int
	baseDelay  time.Duration
	maxDelay   time.Duration
}

// NewExecutor creates an executor wrapping the given breaker.
func NewExecutor(breaker *gobreaker.CircuitBreaker, maxRetries int) *Executor {
	return &Executor{
		breaker:    breaker,
		maxRetries: maxRetries,
		baseDelay:  100 * time.Millisecond,
		maxDelay:   2 * time.Second,
	}
}

// ExecuteWithContext runs fn within the circuit breaker, retrying on transient errors.
// The circuit breaker counts ALL failures (including retries after exhaustion).
func (e *Executor) ExecuteWithContext(ctx context.Context, fn func(context.Context) error) error {
	var lastErr error

	for attempt := 0; attempt <= e.maxRetries; attempt++ {
		if attempt > 0 {
			delay := e.backoffDelay(attempt)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}

		_, err := e.breaker.Execute(func() (interface{}, error) {
			return nil, fn(ctx)
		})

		if err == nil {
			return nil
		}

		// Do not retry if circuit is open — it will not help.
		if errors.Is(err, gobreaker.ErrOpenState) ||
			errors.Is(err, gobreaker.ErrTooManyRequests) {
			return fmt.Errorf("%w: %v", ErrCircuitOpen, err)
		}

		lastErr = err

		// Do not retry context errors.
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
	}

	return fmt.Errorf("exhausted %d retries: %w", e.maxRetries, lastErr)
}

// backoffDelay computes exponential backoff with full jitter.
func (e *Executor) backoffDelay(attempt int) time.Duration {
	exp := e.baseDelay * (1 << uint(attempt-1))
	if exp > e.maxDelay {
		exp = e.maxDelay
	}
	// Full jitter: random in [0, exp]
	jitter := time.Duration(rand.Int63n(int64(exp) + 1))
	return jitter
}
```

### HTTP Client with gobreaker

```go
// clients/payment.go
package clients

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/sony/gobreaker"
	"github.com/yourorg/myapp/resilience"
)

// PaymentRequest is the payload for a payment request.
type PaymentRequest struct {
	OrderID string  `json:"order_id"`
	Amount  float64 `json:"amount"`
	Currency string `json:"currency"`
}

// PaymentResponse is the response from the payment gateway.
type PaymentResponse struct {
	TransactionID string `json:"transaction_id"`
	Status        string `json:"status"`
}

// PaymentClient makes payment requests with circuit breaker protection.
type PaymentClient struct {
	baseURL  string
	client   *http.Client
	executor *resilience.Executor
}

func NewPaymentClient(baseURL string, breaker *gobreaker.CircuitBreaker) *PaymentClient {
	return &PaymentClient{
		baseURL: baseURL,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
		executor: resilience.NewExecutor(breaker, 2), // 2 retries
	}
}

func (c *PaymentClient) ProcessPayment(ctx context.Context, req *PaymentRequest) (*PaymentResponse, error) {
	var resp *PaymentResponse

	err := c.executor.ExecuteWithContext(ctx, func(ctx context.Context) error {
		body, err := json.Marshal(req)
		if err != nil {
			return err // Non-retryable encoding error.
		}

		httpReq, err := http.NewRequestWithContext(ctx,
			http.MethodPost,
			c.baseURL+"/payments",
			bytes.NewReader(body),
		)
		if err != nil {
			return err
		}
		httpReq.Header.Set("Content-Type", "application/json")

		httpResp, err := c.client.Do(httpReq)
		if err != nil {
			return err // Retryable network error.
		}
		defer httpResp.Body.Close()

		// 4xx errors are client errors — do not retry, do not count as circuit failure.
		if httpResp.StatusCode >= 400 && httpResp.StatusCode < 500 {
			return &nonRetryableError{fmt.Errorf("client error: %d", httpResp.StatusCode)}
		}

		// 5xx errors count toward circuit breaker.
		if httpResp.StatusCode >= 500 {
			return fmt.Errorf("server error: %d", httpResp.StatusCode)
		}

		return json.NewDecoder(httpResp.Body).Decode(&resp)
	})

	if err != nil {
		if errors.Is(err, resilience.ErrCircuitOpen) {
			// Return a specific error type so callers can handle gracefully.
			return nil, &CircuitOpenError{Service: "payment-gateway", Cause: err}
		}
		return nil, err
	}

	return resp, nil
}

// nonRetryableError wraps an error to signal that it should not be retried.
type nonRetryableError struct{ err error }

func (e *nonRetryableError) Error() string { return e.err.Error() }
func (e *nonRetryableError) Unwrap() error { return e.err }

// CircuitOpenError indicates the circuit breaker prevented the request.
type CircuitOpenError struct {
	Service string
	Cause   error
}

func (e *CircuitOpenError) Error() string {
	return fmt.Sprintf("circuit open for service %s: %v", e.Service, e.Cause)
}

func (e *CircuitOpenError) Unwrap() error { return e.Cause }
```

## Prometheus Metrics for Circuit Breakers

gobreaker does not export metrics directly; add them via state change callbacks:

```go
// resilience/metrics.go
package resilience

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/sony/gobreaker"
)

var (
	circuitState = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "circuit_breaker_state",
		Help: "Current circuit breaker state: 0=closed, 1=half-open, 2=open",
	}, []string{"circuit"})

	circuitRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "circuit_breaker_requests_total",
		Help: "Total requests through the circuit breaker",
	}, []string{"circuit", "result"})

	circuitStateChanges = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "circuit_breaker_state_changes_total",
		Help: "Total circuit breaker state transitions",
	}, []string{"circuit", "from", "to"})
)

// InstrumentedBreaker wraps gobreaker with Prometheus instrumentation.
type InstrumentedBreaker struct {
	cb *gobreaker.CircuitBreaker
}

func NewInstrumentedBreaker(cfg BreakerConfig, log *slog.Logger) *InstrumentedBreaker {
	originalStateChange := cfg.OnStateChange
	cfg.OnStateChange = func(name string, from, to gobreaker.State) {
		stateValue(to)
		circuitState.WithLabelValues(name).Set(float64(stateValue(to)))
		circuitStateChanges.WithLabelValues(name, from.String(), to.String()).Inc()

		if originalStateChange != nil {
			originalStateChange(name, from, to)
		}
	}

	cb := NewBreaker(cfg, log)
	circuitState.WithLabelValues(cfg.Name).Set(0) // Start closed.

	return &InstrumentedBreaker{cb: cb}
}

func stateValue(s gobreaker.State) float64 {
	switch s {
	case gobreaker.StateClosed:
		return 0
	case gobreaker.StateHalfOpen:
		return 1
	case gobreaker.StateOpen:
		return 2
	}
	return -1
}

// Execute wraps the circuit breaker's Execute and records metrics.
func (b *InstrumentedBreaker) Execute(fn func() (interface{}, error)) (interface{}, error) {
	result, err := b.cb.Execute(fn)

	label := "success"
	if err != nil {
		label = "failure"
		if isCircuitOpen(err) {
			label = "rejected"
		}
	}
	circuitRequests.WithLabelValues(b.cb.Name(), label).Inc()

	return result, err
}

func isCircuitOpen(err error) bool {
	return errors.Is(err, gobreaker.ErrOpenState) ||
		errors.Is(err, gobreaker.ErrTooManyRequests)
}
```

## Grafana Dashboard Alerts

```yaml
# PrometheusRule for circuit breaker alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: circuit-breaker-alerts
  namespace: production
spec:
  groups:
    - name: circuit-breakers
      rules:
        - alert: CircuitBreakerOpen
          expr: circuit_breaker_state{} == 2
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Circuit breaker {{ $labels.circuit }} is OPEN"
            description: "The {{ $labels.circuit }} circuit breaker has been open for 1 minute."

        - alert: CircuitBreakerFlapping
          expr: |
            increase(circuit_breaker_state_changes_total[10m]) > 5
          labels:
            severity: warning
          annotations:
            summary: "Circuit breaker {{ $labels.circuit }} is flapping"

        - alert: CircuitBreakerHighRejectionRate
          expr: |
            rate(circuit_breaker_requests_total{result="rejected"}[5m])
            /
            rate(circuit_breaker_requests_total[5m]) > 0.1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "{{ $labels.circuit }}: {{ $value | humanizePercentage }} of requests rejected"
```

## Testing Circuit Breakers

```go
// resilience/executor_test.go
package resilience_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/sony/gobreaker"
	"github.com/yourorg/myapp/resilience"
)

func newTestBreaker(t *testing.T) *gobreaker.CircuitBreaker {
	t.Helper()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	return resilience.NewBreaker(resilience.BreakerConfig{
		Name:     t.Name(),
		Interval: 1 * time.Second,
		Timeout:  500 * time.Millisecond,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			return counts.ConsecutiveFailures >= 3
		},
	}, log)
}

func TestCircuitOpensAfterConsecutiveFailures(t *testing.T) {
	breaker := newTestBreaker(t)
	exec := resilience.NewExecutor(breaker, 0) // No retries.

	alwaysFails := func(ctx context.Context) error {
		return errors.New("service unavailable")
	}

	// Three failures — circuit should open.
	for i := 0; i < 3; i++ {
		if err := exec.ExecuteWithContext(context.Background(), alwaysFails); err == nil {
			t.Fatalf("iteration %d: expected error", i)
		}
	}

	// Next call should be rejected immediately by the open circuit.
	err := exec.ExecuteWithContext(context.Background(), alwaysFails)
	if !errors.Is(err, resilience.ErrCircuitOpen) {
		t.Fatalf("expected ErrCircuitOpen, got: %v", err)
	}
}

func TestCircuitHalfOpensAndCloses(t *testing.T) {
	breaker := newTestBreaker(t)
	exec := resilience.NewExecutor(breaker, 0)

	failFn := func(ctx context.Context) error { return errors.New("fail") }
	okFn := func(ctx context.Context) error { return nil }

	// Open the circuit.
	for i := 0; i < 3; i++ {
		exec.ExecuteWithContext(context.Background(), failFn)
	}

	// Wait for the timeout to allow half-open.
	time.Sleep(600 * time.Millisecond)

	// One successful probe should close the circuit.
	if err := exec.ExecuteWithContext(context.Background(), okFn); err != nil {
		t.Fatalf("expected nil, got: %v", err)
	}

	// Circuit should now be closed; subsequent calls succeed.
	if err := exec.ExecuteWithContext(context.Background(), okFn); err != nil {
		t.Fatalf("circuit should be closed: %v", err)
	}
}

func TestNonRetryableErrorsDoNotCountAsCircuitFailures(t *testing.T) {
	// This tests application-specific behavior:
	// 404 Not Found should not count toward the circuit failure threshold.
	// (Requires custom ReadyToTrip that inspects error type.)
	t.Skip("implementation-specific test")
}
```

## Integration with HTTP Middleware

```go
// middleware/circuitbreaker.go
package middleware

import (
	"errors"
	"net/http"

	"github.com/yourorg/myapp/clients"
)

// CircuitBreakerMiddleware returns a 503 when a circuit is open.
// This is useful for internal service-to-service calls over HTTP.
func CircuitBreakerMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
		}()

		// Wrap the request handler in recovery, then let business logic
		// handle circuit open errors and return 503.
		next.ServeHTTP(w, r)
	})
}

// RespondOnCircuitOpen checks if an error is a circuit open error and writes
// an appropriate HTTP response.
func RespondOnCircuitOpen(w http.ResponseWriter, err error) bool {
	var circuitErr *clients.CircuitOpenError
	if errors.As(err, &circuitErr) {
		w.Header().Set("Retry-After", "30")
		http.Error(w,
			"Service temporarily unavailable. Please retry later.",
			http.StatusServiceUnavailable,
		)
		return true
	}
	return false
}
```

## Wiring Everything Together

```go
// cmd/payment-processor/main.go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/sony/gobreaker"
	"github.com/yourorg/myapp/clients"
	"github.com/yourorg/myapp/middleware"
	"github.com/yourorg/myapp/resilience"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	resilience.ConfigureAll()

	// gobreaker for payment gateway (critical path)
	paymentBreaker := resilience.NewInstrumentedBreaker(resilience.BreakerConfig{
		Name:     "payment-gateway",
		Interval: 10 * time.Second,
		Timeout:  30 * time.Second,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			if counts.Requests < 5 {
				return false
			}
			failRate := float64(counts.TotalFailures) / float64(counts.Requests)
			return failRate >= 0.3
		},
	}, log)

	fraudClient := clients.NewFraudClient(os.Getenv("FRAUD_SERVICE_URL"))
	paymentClient := clients.NewPaymentClient(
		os.Getenv("PAYMENT_GATEWAY_URL"),
		paymentBreaker.CircuitBreaker(),
	)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders", func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Fraud check (hystrix, with fallback)
		fraudResult, err := fraudClient.CheckFraud(ctx, "order-123", 99.99)
		if err != nil {
			log.Error("fraud check failed", "error", err)
			http.Error(w, "order processing failed", http.StatusInternalServerError)
			return
		}

		if fraudResult.Fallback {
			log.Warn("fraud check used fallback", "order", "order-123")
		}

		if !fraudResult.Approved {
			http.Error(w, "order declined", http.StatusForbidden)
			return
		}

		// Payment (gobreaker)
		payResp, err := paymentClient.ProcessPayment(ctx, &clients.PaymentRequest{
			OrderID:  "order-123",
			Amount:   99.99,
			Currency: "USD",
		})
		if err != nil {
			if middleware.RespondOnCircuitOpen(w, err) {
				return
			}
			log.Error("payment failed", "error", err)
			http.Error(w, "payment processing failed", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(payResp)
	})

	log.Info("starting payment processor", "addr", ":8080")
	http.ListenAndServe(":8080", mux)
}
```

## Summary

Circuit breakers are not optional for production microservice systems — they are the mechanism that converts cascading failures into isolated outages. Key decisions:

1. **Choose libraries based on requirements**: hystrix-go for full Hystrix Dashboard integration and bulkhead concurrency limits; gobreaker for simplicity, testability, and an idiomatic Go API.
2. **Tune `RequestVolumeThreshold` carefully**: A threshold too low causes flapping; too high delays circuit opening during genuine outages. Start at 20 requests per 10-second window.
3. **Implement fallbacks for every critical path**: A circuit that opens without a fallback converts "downstream degraded" into "entire request fails" — no better than having no circuit breaker.
4. **Export circuit state as metrics**: Alert on open circuits; treat circuit flapping (rapid open/close) as a signal of an underlying instability that needs investigation.
5. **Test circuit behavior explicitly**: The circuit breaker is infrastructure code — integration tests that actually open and close the circuit are essential for confidence in resilience behavior.
