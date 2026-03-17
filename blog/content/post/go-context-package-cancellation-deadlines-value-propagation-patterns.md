---
title: "Go Context Package: Cancellation, Deadlines, and Value Propagation Patterns"
date: 2030-05-21T00:00:00-05:00
draft: false
tags: ["Go", "Context", "Concurrency", "Cancellation", "Middleware", "Best Practices", "Enterprise"]
categories:
- Go
- Concurrency
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise patterns for Go context usage: cancellation propagation, deadline management, value passing conventions, context-aware middleware, and common anti-patterns to avoid."
more_link: "yes"
url: "/go-context-package-cancellation-deadlines-value-propagation-patterns/"
---

The `context` package is one of Go's most consequential design decisions. Nearly every function that touches I/O, network calls, database queries, or long-running computations in a well-structured Go service accepts a `context.Context` as its first argument. Despite its ubiquity, context is frequently misused: values are passed through context when they belong in function parameters, deadlines are set without accounting for child operation latency budgets, and cancellation signals are ignored rather than propagated. This guide covers the patterns that separate reliable production services from those that accumulate timeout debt and goroutine leaks.

<!--more-->

## Context Fundamentals

A `context.Context` forms a tree rooted at `context.Background()`. Each derived context inherits the parent's cancellation and deadline while potentially adding tighter constraints. Cancellation propagates downward: cancelling a parent cancels all children. A child context with a shorter deadline than its parent will be cancelled at the earlier time.

```
context.Background()
└── ctx with 30s deadline (HTTP request handler)
    ├── ctx with 10s deadline (database query)
    │   └── ctx with 5s deadline (individual DB operation)
    └── ctx with 20s deadline (external API call)
```

### Context Creation Functions

```go
// Background: root context, never cancelled
ctx := context.Background()

// TODO: placeholder for code that needs context but doesn't have one yet
// Should be eliminated before production
ctx := context.TODO()

// WithCancel: manually cancellable
ctx, cancel := context.WithCancel(parentCtx)
defer cancel() // ALWAYS defer cancel to release resources

// WithTimeout: cancelled after duration from now
ctx, cancel := context.WithTimeout(parentCtx, 5*time.Second)
defer cancel()

// WithDeadline: cancelled at an absolute time
deadline := time.Now().Add(5 * time.Second)
ctx, cancel := context.WithDeadline(parentCtx, deadline)
defer cancel()

// WithValue: attaches a value (use sparingly)
ctx = context.WithValue(parentCtx, requestIDKey{}, "req-001")
```

## Cancellation Propagation

### HTTP Handler Cancellation

HTTP request contexts are automatically cancelled when the client disconnects. Propagating this context to all downstream operations ensures goroutines clean up promptly.

```go
// internal/api/handler.go
package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"go.uber.org/zap"
)

type UserHandler struct {
	db     UserRepository
	cache  CacheRepository
	logger *zap.Logger
}

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context() // Contains request deadline and client disconnect signal

	userID := r.PathValue("id")

	// Attempt cache lookup with a short deadline
	cacheCtx, cacheCancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cacheCancel()

	user, err := h.cache.Get(cacheCtx, userID)
	if err == nil {
		h.writeJSON(w, user)
		return
	}

	// Cache miss or error: fall through to database
	// The original request ctx propagates; if the client disconnects,
	// the DB query will be cancelled automatically.
	user, err = h.db.GetUser(ctx, userID)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			// Client disconnected; no point writing a response
			h.logger.Debug("client disconnected before response", zap.String("userID", userID))
			return
		}
		if errors.Is(err, context.DeadlineExceeded) {
			http.Error(w, "request timed out", http.StatusGatewayTimeout)
			return
		}
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	// Populate cache asynchronously; use a fresh context since the request
	// context may expire before the cache write completes.
	go func() {
		cacheWriteCtx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		if err := h.cache.Set(cacheWriteCtx, userID, user); err != nil {
			h.logger.Warn("cache write failed", zap.String("userID", userID), zap.Error(err))
		}
	}()

	h.writeJSON(w, user)
}

func (h *UserHandler) writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
```

### Propagating Cancellation Through Worker Pools

```go
// internal/worker/pool.go
package worker

import (
	"context"
	"fmt"
	"sync"
)

// Task represents a unit of work.
type Task struct {
	ID   string
	Data interface{}
}

// Result holds the outcome of processing a task.
type Result struct {
	TaskID string
	Value  interface{}
	Err    error
}

// Pool processes tasks concurrently while respecting context cancellation.
type Pool struct {
	workers int
	process func(ctx context.Context, task Task) (interface{}, error)
}

// NewPool creates a worker pool with the given concurrency level.
func NewPool(workers int, fn func(ctx context.Context, task Task) (interface{}, error)) *Pool {
	return &Pool{workers: workers, process: fn}
}

// Run processes all tasks concurrently. Returns all results when complete or
// when the context is cancelled.
func (p *Pool) Run(ctx context.Context, tasks []Task) ([]Result, error) {
	taskCh := make(chan Task, len(tasks))
	resultCh := make(chan Result, len(tasks))

	// Feed all tasks into the channel
	for _, t := range tasks {
		taskCh <- t
	}
	close(taskCh)

	var wg sync.WaitGroup
	for i := 0; i < p.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for task := range taskCh {
				// Check for cancellation before starting each task
				select {
				case <-ctx.Done():
					resultCh <- Result{TaskID: task.ID, Err: ctx.Err()}
					continue
				default:
				}

				value, err := p.process(ctx, task)
				resultCh <- Result{TaskID: task.ID, Value: value, Err: err}
			}
		}()
	}

	// Close result channel when all workers are done
	go func() {
		wg.Wait()
		close(resultCh)
	}()

	var results []Result
	for result := range resultCh {
		results = append(results, result)
	}

	// Return context error if cancelled, alongside any partial results
	if err := ctx.Err(); err != nil {
		return results, fmt.Errorf("pool cancelled: %w", err)
	}
	return results, nil
}
```

## Deadline and Timeout Management

### Latency Budget Allocation

In distributed systems, each hop consumes a portion of the end-to-end latency budget. Use `context.WithTimeout` at each service boundary to enforce that no single operation consumes the entire budget.

```go
// internal/service/order.go
package service

import (
	"context"
	"fmt"
	"time"
)

const (
	totalRequestBudget   = 500 * time.Millisecond
	inventoryBudget      = 100 * time.Millisecond
	pricingBudget        = 80 * time.Millisecond
	paymentBudget        = 200 * time.Millisecond
	notificationBudget   = 50 * time.Millisecond
)

type OrderService struct {
	inventory    InventoryClient
	pricing      PricingClient
	payment      PaymentClient
	notification NotificationClient
}

func (s *OrderService) PlaceOrder(ctx context.Context, req OrderRequest) (*Order, error) {
	// Verify the incoming context has budget remaining
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining < 100*time.Millisecond {
			return nil, fmt.Errorf("insufficient time budget: %v remaining", remaining)
		}
	}

	// Inventory check: short deadline, critical path
	invCtx, invCancel := context.WithTimeout(ctx, inventoryBudget)
	defer invCancel()
	available, err := s.inventory.CheckAvailability(invCtx, req.Items)
	if err != nil {
		return nil, fmt.Errorf("inventory check: %w", err)
	}
	if !available {
		return nil, ErrOutOfStock
	}

	// Pricing calculation: can run after inventory without adding to critical path
	pricingCtx, pricingCancel := context.WithTimeout(ctx, pricingBudget)
	defer pricingCancel()
	price, err := s.pricing.Calculate(pricingCtx, req.Items, req.CustomerID)
	if err != nil {
		return nil, fmt.Errorf("pricing: %w", err)
	}

	// Payment processing: longest operation, gets the largest budget
	payCtx, payCancel := context.WithTimeout(ctx, paymentBudget)
	defer payCancel()
	payment, err := s.payment.Charge(payCtx, PaymentRequest{
		CustomerID: req.CustomerID,
		Amount:     price.Total,
		Currency:   price.Currency,
	})
	if err != nil {
		return nil, fmt.Errorf("payment: %w", err)
	}

	order := &Order{
		ID:        generateOrderID(),
		Items:     req.Items,
		Price:     price,
		PaymentID: payment.ID,
		Status:    OrderStatusConfirmed,
	}

	// Notification is non-critical: fire and forget with a short deadline
	go func() {
		notifCtx, notifCancel := context.WithTimeout(context.Background(), notificationBudget)
		defer notifCancel()
		if err := s.notification.SendOrderConfirmation(notifCtx, order); err != nil {
			// Log but do not fail the order
			_ = err
		}
	}()

	return order, nil
}
```

### Inspecting the Remaining Deadline

```go
// remainingBudget returns how much time is left in ctx's deadline.
// Returns -1 if ctx has no deadline.
func remainingBudget(ctx context.Context) time.Duration {
	deadline, ok := ctx.Deadline()
	if !ok {
		return -1
	}
	return time.Until(deadline)
}

// MustHaveBudget returns an error if the context has less than minBudget remaining.
func MustHaveBudget(ctx context.Context, minBudget time.Duration) error {
	remaining := remainingBudget(ctx)
	if remaining < 0 {
		return nil // no deadline, unlimited budget
	}
	if remaining < minBudget {
		return fmt.Errorf("context has only %v remaining, need %v", remaining, minBudget)
	}
	return nil
}
```

## Context Value Patterns

### Typed Key Pattern (Prevents Collisions)

Never use built-in types as context keys. Using a private unexported type ensures that only code within the same package can access the value.

```go
// internal/middleware/requestid.go
package middleware

import (
	"context"
	"net/http"
)

// requestIDKey is an unexported type to prevent key collisions.
// No external package can create a value of this type.
type requestIDKey struct{}

// WithRequestID attaches a request ID to the context.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

// RequestIDFrom retrieves the request ID from the context.
// Returns empty string if not present.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// RequestIDMiddleware generates and attaches a request ID to every HTTP request.
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Prefer the upstream-provided ID for distributed tracing
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			requestID = generateRequestID()
		}

		ctx := WithRequestID(r.Context(), requestID)
		w.Header().Set("X-Request-ID", requestID)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

### What Belongs in Context vs. Function Parameters

Context values should be request-scoped metadata that crosses API boundaries implicitly. Business logic parameters should be explicit function arguments.

```go
// CORRECT: request metadata in context
type ctxKeys struct {
	requestID  requestIDKey
	userID     userIDKey
	traceSpan  traceSpanKey
	authClaims authClaimsKey
}

// CORRECT: business logic as explicit parameters
func (s *OrderService) GetOrders(ctx context.Context, customerID string, filter OrderFilter) ([]Order, error)

// INCORRECT: business logic parameters in context
// ctx = context.WithValue(ctx, customerIDKey{}, customerID)  ← DO NOT DO THIS
// func (s *OrderService) GetOrders(ctx context.Context) ([]Order, error)
// customerID := ctx.Value(customerIDKey{}).(string)          ← anti-pattern
```

### Structured Logging with Context Values

```go
// internal/logging/context.go
package logging

import (
	"context"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

type loggerKey struct{}

// WithLogger embeds a logger with request-scoped fields into the context.
func WithLogger(ctx context.Context, logger *zap.Logger) context.Context {
	return context.WithValue(ctx, loggerKey{}, logger)
}

// LoggerFrom retrieves the logger from the context.
// Falls back to the global logger if none is present.
func LoggerFrom(ctx context.Context) *zap.Logger {
	if logger, ok := ctx.Value(loggerKey{}).(*zap.Logger); ok {
		return logger
	}
	return zap.L() // global fallback
}

// EnrichLogger adds fields to the context logger for the duration of the request.
func EnrichLogger(ctx context.Context, fields ...zapcore.Field) (context.Context, *zap.Logger) {
	logger := LoggerFrom(ctx).With(fields...)
	return WithLogger(ctx, logger), logger
}

// Usage in HTTP middleware:
func LoggingMiddleware(logger *zap.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestLogger := logger.With(
				zap.String("request_id", middleware.RequestIDFrom(r.Context())),
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
				zap.String("remote_addr", r.RemoteAddr),
			)
			ctx := WithLogger(r.Context(), requestLogger)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
```

## Context-Aware Middleware Chain

### Database Query Wrapper

```go
// internal/storage/db.go
package storage

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/example/service/internal/logging"
	"go.uber.org/zap"
)

// DB wraps sql.DB with context-aware query helpers.
type DB struct {
	db     *sql.DB
	tracer Tracer
}

// QueryContext executes a query and logs slow queries with context information.
func (d *DB) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	logger := logging.LoggerFrom(ctx)

	start := time.Now()
	rows, err := d.db.QueryContext(ctx, query, args...)
	duration := time.Since(start)

	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("query cancelled: %w", ctx.Err())
		}
		logger.Error("database query failed",
			zap.String("query", sanitizeQuery(query)),
			zap.Duration("duration", duration),
			zap.Error(err),
		)
		return nil, fmt.Errorf("query: %w", err)
	}

	if duration > 100*time.Millisecond {
		logger.Warn("slow database query",
			zap.String("query", sanitizeQuery(query)),
			zap.Duration("duration", duration),
		)
	}

	return rows, nil
}

// ExecContext executes a statement with request context propagation.
func (d *DB) ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	logger := logging.LoggerFrom(ctx)

	start := time.Now()
	result, err := d.db.ExecContext(ctx, query, args...)
	duration := time.Since(start)

	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("exec cancelled: %w", ctx.Err())
		}
		logger.Error("database exec failed",
			zap.String("query", sanitizeQuery(query)),
			zap.Duration("duration", duration),
			zap.Error(err),
		)
		return nil, fmt.Errorf("exec: %w", err)
	}

	return result, nil
}
```

## Common Anti-Patterns and Corrections

### Anti-Pattern 1: Ignoring Context Done

```go
// WRONG: loops forever even when context is cancelled
func processItems(ctx context.Context, items []Item) error {
	for _, item := range items {
		// No cancellation check; context.Done() is ignored
		if err := process(ctx, item); err != nil {
			return err
		}
	}
	return nil
}

// CORRECT: check for cancellation between iterations
func processItems(ctx context.Context, items []Item) error {
	for _, item := range items {
		select {
		case <-ctx.Done():
			return fmt.Errorf("processing cancelled: %w", ctx.Err())
		default:
		}
		if err := process(ctx, item); err != nil {
			return err
		}
	}
	return nil
}
```

### Anti-Pattern 2: Storing Context in Structs

```go
// WRONG: storing context in a struct breaks the request-scoped model
type UserService struct {
	ctx context.Context  // ← never do this
	db  *DB
}

func (s *UserService) GetUser(id string) (*User, error) {
	return s.db.GetUser(s.ctx, id)  // Uses stale/wrong context
}

// CORRECT: context is always a function parameter
type UserService struct {
	db *DB
}

func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
	return s.db.GetUser(ctx, id)
}
```

### Anti-Pattern 3: Using Background Context for Long-Running Work

```go
// WRONG: using context.Background() inside a request handler
// loses the request's cancellation and deadline
func (h *Handler) ProcessUpload(w http.ResponseWriter, r *http.Request) {
	go func() {
		// context.Background() never cancels; if the request fails,
		// this goroutine runs indefinitely
		if err := h.processor.Process(context.Background(), uploadID); err != nil {
			log.Println(err)
		}
	}()
}

// CORRECT: create a new context derived from a long-lived base
// that is independent of the HTTP request lifecycle
func (h *Handler) ProcessUpload(w http.ResponseWriter, r *http.Request) {
	uploadID := generateUploadID()
	requestID := middleware.RequestIDFrom(r.Context())

	// Copy relevant values but with a new, longer deadline
	processingCtx, cancel := context.WithTimeout(
		context.Background(),
		30*time.Minute,
	)
	processingCtx = middleware.WithRequestID(processingCtx, requestID)

	go func() {
		defer cancel()
		if err := h.processor.Process(processingCtx, uploadID); err != nil {
			h.logger.Error("upload processing failed",
				zap.String("uploadID", uploadID),
				zap.Error(err),
			)
		}
	}()

	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"upload_id": uploadID})
}
```

### Anti-Pattern 4: Not Deferring cancel()

```go
// WRONG: cancel() not called on early return paths
func fetchData(ctx context.Context) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	// cancel is not called if err != nil ← resource leak
	data, err := http.Get(ctx, "https://api.example.com/data")
	if err != nil {
		return nil, err
	}
	cancel()  // only called on success path
	return data, nil
}

// CORRECT: always defer cancel() immediately after creation
func fetchData(ctx context.Context) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()  // guaranteed to run on all return paths

	data, err := http.Get(ctx, "https://api.example.com/data")
	if err != nil {
		return nil, fmt.Errorf("fetching data: %w", err)
	}
	return data, nil
}
```

### Anti-Pattern 5: Overusing WithValue

```go
// WRONG: using context values for business logic
func (s *Service) CreateOrder(ctx context.Context) error {
	// Business-critical parameters should NOT be in context
	customerID := ctx.Value(customerIDKey{}).(string)     // risky type assertion
	items := ctx.Value(itemsKey{}).([]OrderItem)          // invisible to caller
	discount := ctx.Value(discountKey{}).(float64)        // hard to test

	return s.db.CreateOrder(ctx, customerID, items, discount)
}

// CORRECT: explicit parameters for all business logic
func (s *Service) CreateOrder(ctx context.Context, customerID string, items []OrderItem, discount float64) error {
	return s.db.CreateOrder(ctx, customerID, items, discount)
}
```

## Context in gRPC Services

```go
// internal/grpc/interceptors.go
package grpc

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/codes"
)

// UnaryTimeoutInterceptor adds a deadline to unary gRPC calls if none is set.
func UnaryTimeoutInterceptor(defaultTimeout time.Duration) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		if _, ok := ctx.Deadline(); !ok {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, defaultTimeout)
			defer cancel()
		}

		resp, err := handler(ctx, req)
		if err != nil {
			if ctx.Err() == context.DeadlineExceeded {
				return nil, status.Errorf(codes.DeadlineExceeded,
					"method %s exceeded timeout", info.FullMethod)
			}
			return nil, err
		}
		return resp, nil
	}
}

// UnaryRequestIDInterceptor propagates or generates request IDs.
func UnaryRequestIDInterceptor(next grpc.UnaryHandler) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		md, _ := metadata.FromIncomingContext(ctx)
		var requestID string
		if ids := md.Get("x-request-id"); len(ids) > 0 {
			requestID = ids[0]
		} else {
			requestID = generateRequestID()
		}
		ctx = middleware.WithRequestID(ctx, requestID)
		return handler(ctx, req)
	}
}
```

## Context Timeout Testing

```go
// internal/service/order_test.go
package service_test

import (
	"context"
	"testing"
	"time"
)

func TestPlaceOrder_TimeoutPropagation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		ctxTimeout time.Duration
		mockDelay  time.Duration
		wantErr    error
	}{
		{
			name:       "succeeds within deadline",
			ctxTimeout: 500 * time.Millisecond,
			mockDelay:  100 * time.Millisecond,
			wantErr:    nil,
		},
		{
			name:       "fails when context expires",
			ctxTimeout: 50 * time.Millisecond,
			mockDelay:  200 * time.Millisecond,
			wantErr:    context.DeadlineExceeded,
		},
		{
			name:       "fails when context already cancelled",
			ctxTimeout: 0, // Pre-cancel the context
			mockDelay:  0,
			wantErr:    context.Canceled,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var ctx context.Context
			var cancel context.CancelFunc

			if tt.ctxTimeout == 0 {
				ctx, cancel = context.WithCancel(context.Background())
				cancel() // pre-cancel
			} else {
				ctx, cancel = context.WithTimeout(context.Background(), tt.ctxTimeout)
				defer cancel()
			}

			svc := newOrderServiceWithDelays(tt.mockDelay)
			_, err := svc.PlaceOrder(ctx, defaultOrderRequest())

			if tt.wantErr == nil {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
				return
			}

			if !errors.Is(err, tt.wantErr) {
				t.Errorf("error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}
```

Mastering the context package is essential for building Go services that behave correctly under failure conditions. The discipline of passing context everywhere, setting appropriate deadlines, and propagating cancellation to all goroutines is what separates Go services that degrade gracefully from those that accumulate goroutine leaks and timeouts under load.
