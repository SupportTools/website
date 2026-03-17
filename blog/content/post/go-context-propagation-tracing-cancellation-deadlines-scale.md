---
title: "Go Context Propagation Patterns: Tracing, Cancellation, and Deadlines at Scale"
date: 2028-12-28T00:00:00-05:00
draft: false
tags: ["Go", "Context", "Distributed Tracing", "Cancellation", "Observability", "Microservices"]
categories:
- Go
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go context propagation patterns for production microservices, covering context value conventions, trace ID propagation, timeout cascading, cancellation semantics, and common pitfalls in high-throughput systems."
more_link: "yes"
url: "/go-context-propagation-tracing-cancellation-deadlines-scale/"
---

`context.Context` is Go's mechanism for carrying request-scoped values, deadlines, and cancellation signals across API boundaries and between goroutines. In theory it is simple. In practice, context propagation in large distributed systems involves subtle decisions about value storage, deadline inheritance, cancellation semantics, and the interaction between library-managed contexts and application logic. Getting these decisions wrong produces systems that ignore cancellation (wasting resources), lose trace IDs at service boundaries (breaking distributed tracing), or cascade timeouts incorrectly (causing unnecessary failures). This post examines production patterns that avoid these pitfalls.

<!--more-->

## Context Value Conventions

The `context.WithValue` function accepts `interface{}` keys, which creates ambiguity about where values come from and type-safety when retrieving them. The standard pattern is to use unexported types as keys:

```go
// pkg/ctxkeys/keys.go
package ctxkeys

// requestContextKey is an unexported type to prevent key collisions
// between packages that happen to use the same string as a key.
type requestContextKey int

const (
    TraceIDKey requestContextKey = iota
    SpanIDKey
    RequestIDKey
    UserIDKey
    TenantIDKey
    AuthTokenKey
)

// traceKey is a named type for OpenTelemetry span context
// (distinct from our custom trace ID type)
type traceKey struct{}

// spanKey is a named type for holding the active span
type spanKey struct{}
```

```go
// pkg/reqctx/context.go
package reqctx

import (
    "context"

    "go.opentelemetry.io/otel/trace"
    "go.support.tools/myapp/pkg/ctxkeys"
)

// RequestContext wraps a standard context.Context with typed accessors
// for request-scoped values. This avoids scattered context.Value calls
// and provides compile-time safety.
type RequestContext struct {
    ctx context.Context
}

// Wrap creates a RequestContext from a standard context
func Wrap(ctx context.Context) *RequestContext {
    return &RequestContext{ctx: ctx}
}

// Context returns the underlying context.Context
// for use with libraries that require context.Context directly
func (r *RequestContext) Context() context.Context {
    return r.ctx
}

// WithTraceID returns a new RequestContext with the trace ID set
func WithTraceID(ctx context.Context, traceID string) context.Context {
    return context.WithValue(ctx, ctxkeys.TraceIDKey, traceID)
}

// TraceID extracts the trace ID from a context, returning empty string if absent
func TraceID(ctx context.Context) string {
    if v, ok := ctx.Value(ctxkeys.TraceIDKey).(string); ok {
        return v
    }
    return ""
}

// WithRequestID sets a unique request ID (distinct from distributed trace ID)
func WithRequestID(ctx context.Context, requestID string) context.Context {
    return context.WithValue(ctx, ctxkeys.RequestIDKey, requestID)
}

// RequestID extracts the request ID
func RequestID(ctx context.Context) string {
    if v, ok := ctx.Value(ctxkeys.RequestIDKey).(string); ok {
        return v
    }
    return ""
}

// WithUserID sets the authenticated user ID
func WithUserID(ctx context.Context, userID int64) context.Context {
    return context.WithValue(ctx, ctxkeys.UserIDKey, userID)
}

// UserID extracts the user ID, returning 0 if absent
func UserID(ctx context.Context) int64 {
    if v, ok := ctx.Value(ctxkeys.UserIDKey).(int64); ok {
        return v
    }
    return 0
}

// WithTenantID sets the tenant ID for multi-tenant systems
func WithTenantID(ctx context.Context, tenantID string) context.Context {
    return context.WithValue(ctx, ctxkeys.TenantIDKey, tenantID)
}

// TenantID extracts the tenant ID
func TenantID(ctx context.Context) string {
    if v, ok := ctx.Value(ctxkeys.TenantIDKey).(string); ok {
        return v
    }
    return ""
}
```

## HTTP Middleware for Context Population

```go
// internal/middleware/context.go
package middleware

import (
    "net/http"
    "time"

    "github.com/google/uuid"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
    "go.support.tools/myapp/pkg/reqctx"
)

// ContextPopulator extracts distributed tracing headers, assigns request IDs,
// and populates the request context before handlers see it.
func ContextPopulator(next http.Handler) http.Handler {
    propagator := otel.GetTextMapPropagator()

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // 1. Extract OpenTelemetry trace context from incoming headers
        // This handles W3C Trace Context, B3, and Jaeger headers
        ctx = propagator.Extract(ctx, propagation.HeaderCarrier(r.Header))

        // 2. Extract or generate a request ID
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.New().String()
        }
        ctx = reqctx.WithRequestID(ctx, requestID)

        // 3. Extract trace ID from the active span (set by OTel propagation above)
        // This makes the trace ID available to non-OTel-aware code like loggers
        if span := getSpanFromContext(ctx); span != nil {
            traceID := span.SpanContext().TraceID().String()
            ctx = reqctx.WithTraceID(ctx, traceID)
        }

        // 4. Set response headers for client-side correlation
        w.Header().Set("X-Request-ID", requestID)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// TimeoutMiddleware applies a per-request deadline
// based on the endpoint's configured timeout
func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Create a context with deadline
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            // Wrap the response writer to detect if the handler wrote a response
            // before checking context cancellation
            rw := &responseWriterWrapper{ResponseWriter: w, headerWritten: false}

            done := make(chan struct{})
            go func() {
                defer close(done)
                next.ServeHTTP(rw, r.WithContext(ctx))
            }()

            select {
            case <-done:
                // Handler completed normally
            case <-ctx.Done():
                if !rw.headerWritten {
                    http.Error(w, "request timeout", http.StatusGatewayTimeout)
                }
            }
        })
    }
}
```

## Deadline Propagation Across gRPC Boundaries

gRPC automatically propagates deadlines in the metadata. When a Go HTTP handler calls a downstream gRPC service, the remaining deadline flows:

```go
// internal/client/user_client.go
package client

import (
    "context"
    "fmt"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "go.support.tools/myapp/pkg/reqctx"
    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
    userpb "go.support.tools/myapp/api/user/v1"
)

type UserClient struct {
    conn   *grpc.ClientConn
    client userpb.UserServiceClient
}

// GetUser fetches a user, propagating the incoming context's deadline,
// trace context, and custom request metadata.
func (c *UserClient) GetUser(ctx context.Context, userID int64) (*userpb.User, error) {
    // If the incoming context has a deadline, gRPC will automatically
    // set the deadline on the outgoing call. If there is no deadline,
    // add a conservative one to prevent hanging indefinitely.
    if _, hasDeadline := ctx.Deadline(); !hasDeadline {
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, 5*time.Second)
        defer cancel()
    }

    // Propagate custom metadata (request ID, tenant ID) via gRPC metadata
    md := metadata.Pairs(
        "x-request-id", reqctx.RequestID(ctx),
        "x-tenant-id", reqctx.TenantID(ctx),
    )
    ctx = metadata.NewOutgoingContext(ctx, md)

    user, err := c.client.GetUser(ctx, &userpb.GetUserRequest{Id: userID})
    if err != nil {
        // Classify the error based on context state for better observability
        if ctx.Err() == context.DeadlineExceeded {
            return nil, fmt.Errorf("user service deadline exceeded for user %d: %w",
                userID, ErrDeadlineExceeded)
        }
        if ctx.Err() == context.Canceled {
            return nil, fmt.Errorf("request cancelled while fetching user %d: %w",
                userID, ErrRequestCancelled)
        }
        return nil, fmt.Errorf("fetching user %d: %w", userID, err)
    }

    return user, nil
}
```

## Cancellation-Aware Database Operations

```go
// internal/repository/user_repository.go
package repository

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "go.support.tools/myapp/internal/domain"
)

type UserRepository struct {
    pool *pgxpool.Pool
}

// FindByID queries the database, respecting context cancellation.
// When the client disconnects or the deadline expires, the database
// query is cancelled via pgx's context support.
func (r *UserRepository) FindByID(ctx context.Context, id int64) (*domain.User, error) {
    // pgx.Pool.QueryRow respects ctx — if ctx is cancelled before the
    // query completes, the query is sent a cancellation to PostgreSQL
    // via the cancellation protocol, freeing server resources immediately.
    const query = `
        SELECT id, email, name, created_at, updated_at
        FROM users
        WHERE id = $1 AND deleted_at IS NULL
    `

    var u domain.User
    err := r.pool.QueryRow(ctx, query, id).
        Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.UpdatedAt)
    if err != nil {
        // Distinguish between context cancellation and actual query errors
        if ctx.Err() != nil {
            return nil, fmt.Errorf("query cancelled: %w", ctx.Err())
        }
        if isNoRows(err) {
            return nil, domain.ErrNotFound
        }
        return nil, fmt.Errorf("querying user %d: %w", id, err)
    }

    return &u, nil
}

// BatchFindByIDs illustrates context checking in a loop.
// This is essential for long-running batch operations where early
// cancellation avoids unnecessary work.
func (r *UserRepository) BatchFindByIDs(
    ctx context.Context,
    ids []int64,
) ([]*domain.User, error) {
    results := make([]*domain.User, 0, len(ids))

    for i, id := range ids {
        // Check context before each iteration — don't start work if already cancelled
        select {
        case <-ctx.Done():
            return nil, fmt.Errorf("batch cancelled after %d/%d users: %w",
                i, len(ids), ctx.Err())
        default:
        }

        user, err := r.FindByID(ctx, id)
        if err != nil {
            if ctx.Err() != nil {
                return nil, fmt.Errorf("batch cancelled mid-flight: %w", ctx.Err())
            }
            // Non-fatal: log and continue for individual lookup failures
            continue
        }
        results = append(results, user)
    }

    return results, nil
}
```

## Context in Goroutines: The Parent-Child Pattern

```go
// internal/service/notification_service.go
package service

import (
    "context"
    "fmt"
    "sync"
    "time"

    "go.uber.org/zap"
    "go.support.tools/myapp/internal/domain"
)

type NotificationService struct {
    emailSender EmailSender
    smsSender   SMSSender
    logger      *zap.Logger
}

// SendMultiChannel sends a notification via multiple channels concurrently.
// If the parent context is cancelled, all in-flight sends are also cancelled.
func (s *NotificationService) SendMultiChannel(
    ctx context.Context,
    notification *domain.Notification,
) error {
    // Create a child context with a shorter timeout for the fan-out
    // The parent deadline cascades: if the parent has 2s left and we
    // set 3s here, the effective deadline is still 2s.
    ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
    defer cancel()

    type result struct {
        channel string
        err     error
    }

    results := make(chan result, 2) // buffered to prevent goroutine leak
    var wg sync.WaitGroup

    // Launch concurrent sends
    channels := []struct {
        name string
        fn   func(context.Context, *domain.Notification) error
    }{
        {"email", s.emailSender.Send},
        {"sms", s.smsSender.Send},
    }

    for _, ch := range channels {
        ch := ch // capture loop variable
        wg.Add(1)
        go func() {
            defer wg.Done()
            err := ch.fn(ctx, notification)
            select {
            case results <- result{channel: ch.name, err: err}:
            case <-ctx.Done():
                // Parent cancelled — don't block trying to send result
            }
        }()
    }

    // Close results channel when all goroutines complete
    go func() {
        wg.Wait()
        close(results)
    }()

    var errs []error
    for r := range results {
        if r.err != nil {
            s.logger.Warn("channel send failed",
                zap.String("channel", r.channel),
                zap.Error(r.err),
            )
            errs = append(errs, fmt.Errorf("%s: %w", r.channel, r.err))
        }
    }

    if ctx.Err() != nil {
        return fmt.Errorf("notification cancelled: %w", ctx.Err())
    }

    if len(errs) == len(channels) {
        return fmt.Errorf("all channels failed: %v", errs)
    }

    return nil
}
```

## Context Detachment for Background Work

Sometimes work initiated by a request must outlive the request's context. The canonical pattern is to copy values from the request context into a new background context:

```go
// pkg/ctxutil/detach.go
package ctxutil

import (
    "context"
    "time"

    "go.opentelemetry.io/otel/trace"
    "go.support.tools/myapp/pkg/reqctx"
)

// DetachedContext creates a new context that copies the trace span and
// request metadata from src but is NOT tied to src's cancellation/deadline.
// Use this when starting background work that must outlive the request.
func DetachedContext(src context.Context) context.Context {
    // Start from background — no cancellation, no deadline
    dst := context.Background()

    // Copy custom request metadata
    if v := reqctx.TraceID(src); v != "" {
        dst = reqctx.WithTraceID(dst, v)
    }
    if v := reqctx.RequestID(src); v != "" {
        dst = reqctx.WithRequestID(dst, v)
    }
    if v := reqctx.TenantID(src); v != "" {
        dst = reqctx.WithTenantID(dst, v)
    }
    if v := reqctx.UserID(src); v != 0 {
        dst = reqctx.WithUserID(dst, v)
    }

    // Copy the OpenTelemetry span so background work appears as a child
    // of the original trace, not disconnected
    if span := trace.SpanFromContext(src); span.SpanContext().IsValid() {
        dst = trace.ContextWithSpan(dst, span)
    }

    return dst
}

// DetachedContextWithTimeout creates a detached context with a deadline.
// Useful for background tasks that should complete within a bounded time.
func DetachedContextWithTimeout(
    src context.Context,
    timeout time.Duration,
) (context.Context, context.CancelFunc) {
    return context.WithTimeout(DetachedContext(src), timeout)
}
```

```go
// Usage in a handler: launch async processing that outlives HTTP response
func (h *OrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    order, err := h.orderSvc.Create(ctx, parseOrderRequest(r))
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    // Respond immediately
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(order)

    // Launch background processing AFTER responding.
    // Using a detached context ensures the background work continues
    // even after the HTTP connection closes.
    bgCtx, cancel := ctxutil.DetachedContextWithTimeout(ctx, 30*time.Second)
    go func() {
        defer cancel()
        if err := h.fulfillmentSvc.Process(bgCtx, order); err != nil {
            h.logger.Error("fulfillment processing failed",
                zap.String("order_id", order.ID),
                zap.String("trace_id", reqctx.TraceID(bgCtx)),
                zap.Error(err),
            )
        }
    }()
}
```

## Context Propagation Across Kafka Messages

HTTP and gRPC carry context in headers. Message queues require explicit serialization:

```go
// pkg/kafka/context.go
package kafka

import (
    "context"
    "encoding/json"

    "github.com/IBM/sarama"
    "go.opentelemetry.io/otel/propagation"
    "go.support.tools/myapp/pkg/reqctx"
)

// ContextHeaders holds serialized context values for Kafka messages
type ContextHeaders struct {
    TraceID   string `json:"trace_id"`
    RequestID string `json:"request_id"`
    TenantID  string `json:"tenant_id"`
    UserID    int64  `json:"user_id,omitempty"`
    // W3C Trace Context headers for OTel propagation
    TraceParent string `json:"traceparent,omitempty"`
    TraceState  string `json:"tracestate,omitempty"`
}

// InjectContext serializes context values into Kafka message headers
func InjectContext(ctx context.Context, msg *sarama.ProducerMessage) {
    headers := ContextHeaders{
        TraceID:   reqctx.TraceID(ctx),
        RequestID: reqctx.RequestID(ctx),
        TenantID:  reqctx.TenantID(ctx),
        UserID:    reqctx.UserID(ctx),
    }

    // Also inject W3C trace context for OTel propagation
    carrier := &mapCarrier{}
    otel.GetTextMapPropagator().Inject(ctx, carrier)
    headers.TraceParent = carrier.Get("traceparent")
    headers.TraceState = carrier.Get("tracestate")

    data, _ := json.Marshal(headers)
    msg.Headers = append(msg.Headers, sarama.RecordHeader{
        Key:   []byte("x-context"),
        Value: data,
    })
}

// ExtractContext reconstructs a context from Kafka message headers
func ExtractContext(msg *sarama.ConsumerMessage) context.Context {
    ctx := context.Background()

    for _, h := range msg.Headers {
        if string(h.Key) != "x-context" {
            continue
        }

        var headers ContextHeaders
        if err := json.Unmarshal(h.Value, &headers); err != nil {
            return ctx
        }

        ctx = reqctx.WithTraceID(ctx, headers.TraceID)
        ctx = reqctx.WithRequestID(ctx, headers.RequestID)
        ctx = reqctx.WithTenantID(ctx, headers.TenantID)
        if headers.UserID != 0 {
            ctx = reqctx.WithUserID(ctx, headers.UserID)
        }

        // Re-attach OTel trace context
        if headers.TraceParent != "" {
            carrier := &mapCarrier{
                "traceparent": headers.TraceParent,
                "tracestate":  headers.TraceState,
            }
            ctx = otel.GetTextMapPropagator().Extract(ctx, carrier)
        }

        return ctx
    }

    return ctx
}
```

## Testing Context Propagation

```go
// pkg/reqctx/context_test.go
package reqctx_test

import (
    "context"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "go.support.tools/myapp/pkg/reqctx"
)

func TestContextValueRoundTrip(t *testing.T) {
    ctx := context.Background()
    ctx = reqctx.WithTraceID(ctx, "abc123trace")
    ctx = reqctx.WithRequestID(ctx, "req-456")
    ctx = reqctx.WithTenantID(ctx, "acme-corp")
    ctx = reqctx.WithUserID(ctx, 42)

    assert.Equal(t, "abc123trace", reqctx.TraceID(ctx))
    assert.Equal(t, "req-456", reqctx.RequestID(ctx))
    assert.Equal(t, "acme-corp", reqctx.TenantID(ctx))
    assert.Equal(t, int64(42), reqctx.UserID(ctx))
}

func TestContextMissingValues(t *testing.T) {
    ctx := context.Background()
    assert.Equal(t, "", reqctx.TraceID(ctx))
    assert.Equal(t, "", reqctx.RequestID(ctx))
    assert.Equal(t, int64(0), reqctx.UserID(ctx))
}

func TestCancellationPropagation(t *testing.T) {
    parent, cancel := context.WithCancel(context.Background())
    child := reqctx.WithTraceID(parent, "trace-789")

    // Values still accessible in child
    assert.Equal(t, "trace-789", reqctx.TraceID(child))

    // Cancel parent — child should also be cancelled
    cancel()

    select {
    case <-child.Done():
        // Correct: child context was cancelled
    case <-time.After(100 * time.Millisecond):
        t.Fatal("child context was not cancelled when parent was cancelled")
    }
}

func TestDeadlineInheritance(t *testing.T) {
    // Parent has 1 second deadline
    parent, cancel := context.WithTimeout(context.Background(), time.Second)
    defer cancel()

    // Child requests 5 seconds but inherits 1 second from parent
    child, childCancel := context.WithTimeout(parent, 5*time.Second)
    defer childCancel()

    deadline, ok := child.Deadline()
    require.True(t, ok)

    // Child deadline should be ~1s from now (parent's deadline), not 5s
    remaining := time.Until(deadline)
    assert.Less(t, remaining, 2*time.Second,
        "child deadline should not exceed parent deadline of 1s")
}
```

## Common Anti-Patterns

### Storing Contexts in Structs

```go
// WRONG: Storing context in a struct couples the struct's lifetime to the request
type UserRepository struct {
    db  *sql.DB
    ctx context.Context  // Anti-pattern: context belongs to the call, not the struct
}

// CORRECT: Pass context as first argument to methods
type UserRepository struct {
    db *sql.DB
}
func (r *UserRepository) FindByID(ctx context.Context, id int64) (*User, error) { ... }
```

### Ignoring Cancellation in Critical Paths

```go
// WRONG: Long loop without checking context
func processAll(ctx context.Context, items []Item) error {
    for _, item := range items {
        doExpensiveWork(item) // Never checks if ctx was cancelled
    }
    return nil
}

// CORRECT: Check context at loop boundaries
func processAll(ctx context.Context, items []Item) error {
    for i, item := range items {
        if err := ctx.Err(); err != nil {
            return fmt.Errorf("cancelled after %d/%d items: %w", i, len(items), err)
        }
        if err := doExpensiveWork(ctx, item); err != nil {
            return err
        }
    }
    return nil
}
```

### Using context.Background() in Tests Instead of a Cancelable Context

```go
// Less useful in tests: no cancellation testing
func TestService(t *testing.T) {
    ctx := context.Background()
    // ...
}

// Better: Use a test context that cancels on test completion
func TestService(t *testing.T) {
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    // Test will fail fast if it takes longer than 10s
    // and all database/network calls will be cancelled on timeout
}
```

Context propagation is the connective tissue of distributed Go services. Typed key conventions prevent value collisions across packages, explicit deadline forwarding ensures downstream services respect upstream budgets, and detached contexts enable background work that maintains tracing lineage without inheriting request cancellation. These patterns collectively produce systems that are observable, resource-efficient, and correctly-behaved under load.
