---
title: "Go Error Design: Sentinel Errors, Custom Types, and Wrapping Patterns"
date: 2028-03-21T00:00:00-05:00
draft: false
tags: ["Go", "Error Handling", "Best Practices", "Software Design", "Production Engineering"]
categories: ["Go", "Software Design"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go error design covering errors.Is and errors.As unwrapping chains, sentinel errors vs typed errors, fmt.Errorf %w wrapping, stack traces, domain error modeling, HTTP status mapping, and concurrent error handling."
more_link: "yes"
url: "/go-error-wrapping-sentinel-guide/"
---

Go's error handling model is intentional in its simplicity: errors are values. This simplicity creates design space that teams must occupy deliberately. Without a consistent error strategy, codebases accumulate an inconsistent mix of string comparison, type assertions, ignored errors, and lost context. The `errors` package additions in Go 1.13—wrapping with `%w`, `errors.Is`, and `errors.As`—provide the foundation for a principled approach.

This guide covers the complete Go error design space: sentinel errors, typed errors, wrapping chains, stack traces, domain modeling, HTTP status mapping, and error patterns in concurrent code.

<!--more-->

## Error Fundamentals

```go
// The error interface — the entire standard library builds on this
type error interface {
    Error() string
}
```

Three mechanisms for creating errors:

```go
// 1. errors.New — immutable error value, suitable for sentinels
var ErrNotFound = errors.New("not found")

// 2. fmt.Errorf — formatted string, supports %w for wrapping
err := fmt.Errorf("lookup user %d: %w", userID, ErrNotFound)

// 3. Custom type — carries structured context
type ValidationError struct {
    Field   string
    Message string
}
func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation: field %s: %s", e.Field, e.Message)
}
```

## Sentinel Errors

Sentinel errors are package-level variables that represent specific error conditions. Callers compare against them using `errors.Is`:

```go
// pkg/store/errors.go
package store

import "errors"

// Sentinel errors — use these for conditions callers need to handle distinctly
var (
    ErrNotFound      = errors.New("record not found")
    ErrAlreadyExists = errors.New("record already exists")
    ErrOptimisticLock = errors.New("optimistic lock conflict")
    ErrConnectionFailed = errors.New("database connection failed")
)
```

```go
// Caller code
user, err := store.GetUser(ctx, userID)
if err != nil {
    if errors.Is(err, store.ErrNotFound) {
        return nil, fmt.Errorf("create user profile: user %d not found", userID)
    }
    return nil, fmt.Errorf("get user: %w", err)
}
```

### When to Use Sentinels

Sentinel errors work well when:
- The error condition is a distinct, recognizable state (not found, conflict, unauthorized)
- Multiple callers need to handle the condition the same way
- No additional context needs to travel with the error value

Sentinels do NOT work when:
- The error carries data (which field failed validation, which resource was not found)
- Different call sites require different handling based on context

## Custom Error Types

Custom error types carry structured context and allow `errors.As` extraction:

```go
// pkg/store/errors.go — typed errors with context
package store

import "fmt"

// NotFoundError carries the resource type and identifier.
type NotFoundError struct {
    Resource string
    ID       string
}

func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s %q not found", e.Resource, e.ID)
}

// ConflictError carries the conflicting resource details.
type ConflictError struct {
    Resource  string
    Attribute string
    Value     string
}

func (e *ConflictError) Error() string {
    return fmt.Sprintf("%s with %s=%q already exists", e.Resource, e.Attribute, e.Value)
}

// ValidationErrors is a collection of field-level validation failures.
type ValidationErrors []FieldError

type FieldError struct {
    Field   string
    Code    string
    Message string
}

func (ve ValidationErrors) Error() string {
    if len(ve) == 0 {
        return "no validation errors"
    }
    msgs := make([]string, len(ve))
    for i, fe := range ve {
        msgs[i] = fmt.Sprintf("%s: %s", fe.Field, fe.Message)
    }
    return "validation failed: " + strings.Join(msgs, "; ")
}
```

```go
// pkg/service/user.go
func (s *UserService) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
    if err := validateCreateUserRequest(req); err != nil {
        return nil, err  // ValidationErrors already has context
    }

    _, err := s.store.GetUserByEmail(ctx, req.Email)
    if err == nil {
        // User exists — return a typed conflict error
        return nil, &store.ConflictError{
            Resource:  "user",
            Attribute: "email",
            Value:     req.Email,
        }
    }
    if !errors.As(err, &store.NotFoundError{}) {
        return nil, fmt.Errorf("check existing user: %w", err)
    }
    // ...
}
```

## fmt.Errorf with %w Wrapping

`%w` wraps an error, preserving it in the chain for `errors.Is` and `errors.As`:

```go
// Correct — %w wraps the original error for chain traversal
return fmt.Errorf("fetch order %s: %w", orderID, err)

// Incorrect — %v converts to string, loses the original error type
return fmt.Errorf("fetch order %s: %v", orderID, err)  // chain is broken

// Multi-level wrapping — each level adds context
func (s *OrderService) processPayment(ctx context.Context, order *Order) error {
    if err := s.paymentClient.Charge(ctx, order.Amount); err != nil {
        return fmt.Errorf("charge order %s amount %.2f: %w", order.ID, order.Amount, err)
    }
    return nil
}

func (s *OrderService) PlaceOrder(ctx context.Context, req PlaceOrderRequest) error {
    order, err := s.createOrderRecord(ctx, req)
    if err != nil {
        return fmt.Errorf("place order for customer %s: %w", req.CustomerID, err)
    }
    if err := s.processPayment(ctx, order); err != nil {
        return fmt.Errorf("place order for customer %s: %w", req.CustomerID, err)
    }
    return nil
}

// At the top level, errors.Is traverses the full chain:
err := service.PlaceOrder(ctx, req)
if errors.Is(err, payment.ErrInsufficientFunds) {
    // Matches even though the error is wrapped several levels deep
}
```

## errors.Is and errors.As Semantics

```go
// errors.Is — checks if any error in the chain matches the target
// Uses == comparison by default, or a custom Is() method

// errors.As — finds the first error in chain matching the target type
// Extracts the typed error for field access

// Custom Is() method for flexible sentinel matching
type TemporaryError struct {
    Underlying error
    RetryAfter time.Duration
}

func (e *TemporaryError) Error() string {
    return fmt.Sprintf("temporary error (retry after %s): %s", e.RetryAfter, e.Underlying)
}

// Is() allows matching against any TemporaryError, not just a specific instance
func (e *TemporaryError) Is(target error) bool {
    _, ok := target.(*TemporaryError)
    return ok
}

func (e *TemporaryError) Unwrap() error {
    return e.Underlying
}

// Usage
if errors.Is(err, &TemporaryError{}) {
    var te *TemporaryError
    errors.As(err, &te)
    time.Sleep(te.RetryAfter)
    // retry
}
```

## Stack Traces

Go's standard `errors` package does not capture stack traces. For production diagnostics, use `github.com/pkg/errors` or a custom approach:

```go
// internal/apperrors/errors.go
package apperrors

import (
    "fmt"
    "runtime"
    "strings"
)

// stackTrace captures the call stack at error creation time.
type stackTrace []uintptr

func callers() stackTrace {
    const depth = 32
    var pcs [depth]uintptr
    n := runtime.Callers(3, pcs[:])
    return pcs[:n]
}

func (st stackTrace) Format() string {
    frames := runtime.CallersFrames([]uintptr(st))
    var sb strings.Builder
    for {
        frame, more := frames.Next()
        // Skip runtime and stdlib frames
        if !strings.Contains(frame.File, "support-tools") {
            if !more {
                break
            }
            continue
        }
        fmt.Fprintf(&sb, "\n  %s\n\t%s:%d", frame.Function, frame.File, frame.Line)
        if !more {
            break
        }
    }
    return sb.String()
}

// WithStack wraps an error with a captured stack trace.
type WithStack struct {
    cause error
    stack stackTrace
}

func New(msg string) error {
    return &WithStack{cause: errors.New(msg), stack: callers()}
}

func Wrap(err error, msg string) error {
    if err == nil {
        return nil
    }
    return &WithStack{
        cause: fmt.Errorf("%s: %w", msg, err),
        stack: callers(),
    }
}

func (e *WithStack) Error() string { return e.cause.Error() }
func (e *WithStack) Unwrap() error { return e.cause }
func (e *WithStack) Stack() string { return e.stack.Format() }

// StackTrace extracts the formatted stack from an error chain, if present.
func StackTrace(err error) string {
    var ws *WithStack
    if errors.As(err, &ws) {
        return ws.Stack()
    }
    return ""
}
```

## Domain Error Modeling

Group errors by category to simplify HTTP status mapping and consistent handling:

```go
// pkg/domain/errors.go
package domain

import (
    "errors"
    "fmt"
    "net/http"
)

// Category classifies errors for status code mapping and logging decisions.
type Category int

const (
    CategoryUnknown    Category = iota
    CategoryNotFound            // 404
    CategoryConflict            // 409
    CategoryValidation          // 400
    CategoryUnauthorized        // 401
    CategoryForbidden           // 403
    CategoryRateLimit           // 429
    CategoryInternal            // 500
    CategoryUnavailable         // 503
)

// DomainError is the standard error type for all domain-layer failures.
type DomainError struct {
    Category Category
    Code     string
    Message  string
    Details  map[string]any
    Cause    error
}

func (e *DomainError) Error() string {
    if e.Cause != nil {
        return fmt.Sprintf("[%s] %s: %v", e.Code, e.Message, e.Cause)
    }
    return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

func (e *DomainError) Unwrap() error { return e.Cause }

func (e *DomainError) Is(target error) bool {
    t, ok := target.(*DomainError)
    if !ok {
        return false
    }
    // Match by category if the target has no specific code
    if t.Code == "" {
        return e.Category == t.Category
    }
    return e.Code == t.Code
}

// Constructor helpers
func NotFound(code, msg string, cause error) *DomainError {
    return &DomainError{Category: CategoryNotFound, Code: code, Message: msg, Cause: cause}
}

func Conflict(code, msg string, details map[string]any) *DomainError {
    return &DomainError{Category: CategoryConflict, Code: code, Message: msg, Details: details}
}

func Validation(fields map[string]string) *DomainError {
    details := make(map[string]any, len(fields))
    for k, v := range fields {
        details[k] = v
    }
    return &DomainError{
        Category: CategoryValidation,
        Code:     "VALIDATION_FAILED",
        Message:  "request validation failed",
        Details:  details,
    }
}

func Internal(msg string, cause error) *DomainError {
    return &DomainError{Category: CategoryInternal, Code: "INTERNAL_ERROR", Message: msg, Cause: cause}
}

// HTTPStatus maps domain error categories to HTTP status codes.
func HTTPStatus(err error) int {
    var de *DomainError
    if !errors.As(err, &de) {
        return http.StatusInternalServerError
    }
    switch de.Category {
    case CategoryNotFound:
        return http.StatusNotFound
    case CategoryConflict:
        return http.StatusConflict
    case CategoryValidation:
        return http.StatusBadRequest
    case CategoryUnauthorized:
        return http.StatusUnauthorized
    case CategoryForbidden:
        return http.StatusForbidden
    case CategoryRateLimit:
        return http.StatusTooManyRequests
    case CategoryUnavailable:
        return http.StatusServiceUnavailable
    default:
        return http.StatusInternalServerError
    }
}
```

## HTTP Handler Error Mapping

```go
// internal/api/errors.go
package api

import (
    "encoding/json"
    "log/slog"
    "net/http"

    "github.com/support-tools/myservice/pkg/domain"
)

type ErrorResponse struct {
    Code    string         `json:"code"`
    Message string         `json:"message"`
    Details map[string]any `json:"details,omitempty"`
    TraceID string         `json:"trace_id,omitempty"`
}

// RespondError writes a standardized JSON error response.
// Internal errors are logged but not exposed to callers.
func RespondError(w http.ResponseWriter, r *http.Request, err error) {
    status := domain.HTTPStatus(err)
    logger := slog.Default()

    var resp ErrorResponse

    var de *domain.DomainError
    if errors.As(err, &de) {
        resp = ErrorResponse{
            Code:    de.Code,
            Message: de.Message,
            Details: sanitizeDetails(de.Details, status),
        }
        // Log internal errors with full context; log user errors at debug
        if de.Category == domain.CategoryInternal {
            logger.ErrorContext(r.Context(), "internal error",
                "error", err,
                "code", de.Code,
                "path", r.URL.Path,
                "stack", domain.StackTrace(err),
            )
            // Sanitize message for external consumers
            resp.Message = "an internal error occurred"
        } else {
            logger.DebugContext(r.Context(), "domain error",
                "error", err,
                "code", de.Code,
                "status", status,
            )
        }
    } else {
        // Unexpected non-domain error
        logger.ErrorContext(r.Context(), "unhandled error",
            "error", err,
            "path", r.URL.Path,
        )
        resp = ErrorResponse{
            Code:    "INTERNAL_ERROR",
            Message: "an internal error occurred",
        }
    }

    // Add trace ID from span context if available
    if spanCtx := trace.SpanFromContext(r.Context()); spanCtx.IsRecording() {
        resp.TraceID = spanCtx.SpanContext().TraceID().String()
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(resp)
}

// sanitizeDetails strips internal details from non-internal errors in production.
func sanitizeDetails(details map[string]any, status int) map[string]any {
    if status >= 500 {
        return nil
    }
    return details
}
```

## Errors in Concurrent Code

### Collecting Errors from Goroutines

```go
// errgroup — the standard approach for concurrent error collection
import "golang.org/x/sync/errgroup"

func processOrders(ctx context.Context, orders []Order) error {
    g, ctx := errgroup.WithContext(ctx)

    for _, order := range orders {
        order := order  // Capture loop variable
        g.Go(func() error {
            if err := processOrder(ctx, order); err != nil {
                return fmt.Errorf("process order %s: %w", order.ID, err)
            }
            return nil
        })
    }

    // Wait returns the first non-nil error, cancels ctx for others
    return g.Wait()
}
```

### Collecting All Errors (not just first)

```go
// multierror — collect all failures, not just the first
package multierror

import (
    "errors"
    "fmt"
    "strings"
    "sync"
)

type MultiError struct {
    mu   sync.Mutex
    errs []error
}

func (m *MultiError) Add(err error) {
    if err == nil {
        return
    }
    m.mu.Lock()
    defer m.mu.Unlock()
    m.errs = append(m.errs, err)
}

func (m *MultiError) Err() error {
    m.mu.Lock()
    defer m.mu.Unlock()
    if len(m.errs) == 0 {
        return nil
    }
    return &MultiError{errs: append([]error(nil), m.errs...)}
}

func (m *MultiError) Error() string {
    m.mu.Lock()
    defer m.mu.Unlock()
    msgs := make([]string, len(m.errs))
    for i, err := range m.errs {
        msgs[i] = err.Error()
    }
    return fmt.Sprintf("%d errors: [%s]", len(m.errs), strings.Join(msgs, "; "))
}

func (m *MultiError) Unwrap() []error {
    m.mu.Lock()
    defer m.mu.Unlock()
    return append([]error(nil), m.errs...)
}

// Is traverses all contained errors for errors.Is compatibility
func (m *MultiError) Is(target error) bool {
    m.mu.Lock()
    defer m.mu.Unlock()
    for _, err := range m.errs {
        if errors.Is(err, target) {
            return true
        }
    }
    return false
}

// Usage
func validateAll(items []Item) error {
    var me multierror.MultiError
    for _, item := range items {
        me.Add(validate(item))
    }
    return me.Err()
}
```

## Error Logging vs Returning

```
Rule                                          | Guideline
----------------------------------------------|--------------------------------------------------
Log at the origination point                  | Only log once per error — the first handler that
                                              | decides to swallow it rather than propagate
Return with context, don't log and return     | Logging AND returning duplicates log entries
Distinguish user errors from system errors    | user errors: debug/info; system errors: error/warn
Never swallow errors silently                 | At minimum assign to _ with a comment
Top-level handler logs, lower layers return   | Service layer returns; handler/main logs
```

```go
// WRONG — logs AND returns, causing duplicate log entries upstream
func (s *Store) GetUser(ctx context.Context, id string) (*User, error) {
    row := s.db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id)
    var user User
    if err := row.Scan(&user); err != nil {
        log.Printf("ERROR: GetUser scan: %v", err)  // logged here
        return nil, fmt.Errorf("scan user: %w", err)  // and returned for caller to log again
    }
    return &user, nil
}

// CORRECT — return with context, let the handler log once
func (s *Store) GetUser(ctx context.Context, id string) (*User, error) {
    row := s.db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id)
    var user User
    if err := row.Scan(&user); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.NotFound("USER_NOT_FOUND", "user not found", nil)
        }
        return nil, fmt.Errorf("scan user %s: %w", id, err)
    }
    return &user, nil
}
```

## Testing Error Handling

```go
// Test error chain traversal
func TestErrorChain(t *testing.T) {
    // Build a wrapped error chain
    original := &store.NotFoundError{Resource: "user", ID: "abc123"}
    wrapped := fmt.Errorf("get profile: %w",
        fmt.Errorf("load user: %w", original))

    // errors.Is should traverse the chain
    if !errors.Is(wrapped, store.ErrNotFound) {
        t.Errorf("expected ErrNotFound in chain")
    }

    // errors.As should extract the typed error
    var nfe *store.NotFoundError
    if !errors.As(wrapped, &nfe) {
        t.Errorf("expected NotFoundError in chain")
    }
    if nfe.ID != "abc123" {
        t.Errorf("unexpected ID: got %q, want %q", nfe.ID, "abc123")
    }
}

// Test HTTP status mapping
func TestHTTPStatus(t *testing.T) {
    cases := []struct {
        err  error
        want int
    }{
        {domain.NotFound("X", "msg", nil), http.StatusNotFound},
        {domain.Conflict("X", "msg", nil), http.StatusConflict},
        {domain.Validation(nil), http.StatusBadRequest},
        {fmt.Errorf("unwrapped: %w", domain.NotFound("X", "msg", nil)), http.StatusNotFound},
        {errors.New("generic"), http.StatusInternalServerError},
    }

    for _, tc := range cases {
        got := domain.HTTPStatus(tc.err)
        if got != tc.want {
            t.Errorf("HTTPStatus(%v) = %d, want %d", tc.err, got, tc.want)
        }
    }
}
```

## Production Checklist

```
Error Design
[ ] Package-level sentinel errors for recognizable conditions
[ ] Custom types for errors requiring field extraction (NotFound, Conflict, Validation)
[ ] fmt.Errorf with %w at every wrapping site (never %v for wrapped errors)
[ ] Stack traces captured at domain boundary entry points (not every wrap)
[ ] Error codes defined as typed constants, not raw strings

Domain Modeling
[ ] All errors categorized (NotFound, Conflict, Validation, Internal, etc.)
[ ] HTTP status mapping centralized in domain package
[ ] Internal error messages not exposed to external callers
[ ] Error details (field names, values) included for user-actionable errors

Concurrency
[ ] errgroup used for concurrent operations that must all succeed
[ ] MultiError pattern for collecting all validation/processing failures
[ ] Context cancellation propagated through error groups

Logging
[ ] Errors logged once at the first handler that stops propagation
[ ] Internal errors logged at Error level with full context
[ ] User input errors logged at Debug level
[ ] Trace IDs included in error responses for cross-signal correlation
```

A principled error model is not about eliminating errors—it is about ensuring that when errors occur, they carry sufficient context for diagnosis without leaking sensitive implementation details to callers, and that every error has a clear owner that handles or escalates it.
