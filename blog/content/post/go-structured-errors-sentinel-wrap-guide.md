---
title: "Go Error Architecture: Sentinel Errors, Wrapping, and Structured Error Types"
date: 2028-11-28T00:00:00-05:00
draft: false
tags: ["Go", "Error Handling", "Software Design", "Production", "Architecture"]
categories:
- Go
- Software Design
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go error architecture: sentinel errors vs structured types, fmt.Errorf %w wrapping, errors.Is/errors.As for unwrapping, HTTP status mapping, errors.Join for multi-error grouping, stack trace capture, and testing error paths."
more_link: "yes"
url: "/go-structured-errors-sentinel-wrap-guide/"
---

Go's error handling gets criticism for verbosity, but its simplicity is intentional. The `error` interface is just one method: `Error() string`. Everything else - wrapping, inspection, structured context - is built on top of this foundation using a small set of conventions. The problem in production code is not the language but the inconsistency: mixing sentinel errors, string comparisons, type assertions, and `fmt.Errorf` without a coherent architecture leads to error handling that is hard to test, debug, and maintain.

This guide establishes a complete Go error architecture: when to use each error strategy, how wrapping and unwrapping works, how to map domain errors to HTTP responses, and how to write error handling that can actually be tested.

<!--more-->

# Go Error Architecture: Sentinel Errors, Wrapping, and Structured Types

## Three Error Strategies

### Strategy 1: Sentinel Errors

Sentinel errors are package-level error values compared with `==` or `errors.Is`. They signal a specific condition without additional context.

```go
package storage

import "errors"

// Sentinel errors for storage package
var (
    ErrNotFound   = errors.New("not found")
    ErrConflict   = errors.New("conflict: resource already exists")
    ErrExpired    = errors.New("resource has expired")
    ErrPermission = errors.New("permission denied")
)

func GetUser(id string) (*User, error) {
    row := db.QueryRow("SELECT * FROM users WHERE id = $1", id)
    var u User
    if err := row.Scan(&u.ID, &u.Name); err != nil {
        if err == sql.ErrNoRows {
            return nil, ErrNotFound  // Wrap with our sentinel
        }
        return nil, fmt.Errorf("storage.GetUser: %w", err)
    }
    return &u, nil
}

// Caller uses errors.Is for comparison
user, err := storage.GetUser(id)
if errors.Is(err, storage.ErrNotFound) {
    http.Error(w, "User not found", http.StatusNotFound)
    return
}
```

**Use sentinel errors when**:
- The error condition is a well-known state (not found, conflict, permission denied)
- No additional context is needed at the point of the error
- Multiple callers need to distinguish this condition

**Do not use sentinel errors when**:
- The error needs to carry variable data (which ID, which field, what limit)

### Strategy 2: Structured Error Types

Structured error types implement the `error` interface and carry additional fields that callers can extract via `errors.As`.

```go
package validation

import (
    "fmt"
    "strings"
)

// ValidationError carries field-level validation failures.
type ValidationError struct {
    Field   string
    Message string
    Value   any
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation error: field %q - %s (got: %v)", e.Field, e.Message, e.Value)
}

// MultiValidationError aggregates multiple validation errors.
type MultiValidationError struct {
    Errors []*ValidationError
}

func (e *MultiValidationError) Error() string {
    msgs := make([]string, len(e.Errors))
    for i, err := range e.Errors {
        msgs[i] = err.Error()
    }
    return strings.Join(msgs, "; ")
}

func ValidatePayment(p Payment) error {
    var errs []*ValidationError

    if p.Amount <= 0 {
        errs = append(errs, &ValidationError{
            Field:   "amount",
            Message: "must be positive",
            Value:   p.Amount,
        })
    }

    if len(p.CardNumber) != 16 {
        errs = append(errs, &ValidationError{
            Field:   "card_number",
            Message: "must be 16 digits",
            Value:   "***",
        })
    }

    if p.Currency == "" {
        errs = append(errs, &ValidationError{
            Field:   "currency",
            Message: "required",
            Value:   "",
        })
    }

    if len(errs) > 0 {
        return &MultiValidationError{Errors: errs}
    }
    return nil
}

// Caller extracts structured data
err := ValidatePayment(p)
if err != nil {
    var multiErr *MultiValidationError
    if errors.As(err, &multiErr) {
        // Return detailed validation errors to client
        writeValidationResponse(w, multiErr.Errors)
        return
    }
    // Unknown error - log and return 500
    slog.Error("validation error", slog.Any("error", err))
    http.Error(w, "internal error", http.StatusInternalServerError)
    return
}
```

**Use structured error types when**:
- The error needs to carry variable data (field names, IDs, limits)
- Callers need to programmatically extract error details
- You need to aggregate multiple errors (form validation)

### Strategy 3: Wrapped Errors with fmt.Errorf %w

Wrapping adds context to an error while preserving the original for `errors.Is` and `errors.As` inspection:

```go
func processOrder(ctx context.Context, orderID string) error {
    order, err := orderRepo.Get(ctx, orderID)
    if err != nil {
        // Wrap with operation context, preserve original for Is/As inspection
        return fmt.Errorf("processOrder %s: %w", orderID, err)
    }

    if err := paymentService.Charge(ctx, order.PaymentID, order.Amount); err != nil {
        return fmt.Errorf("processOrder %s: charging payment %s: %w",
            orderID, order.PaymentID, err)
    }

    return nil
}
```

The wrapped error chain allows callers to:
1. Check the original sentinel: `errors.Is(err, storage.ErrNotFound)` - returns true even through the wrapping
2. Extract structured error type: `errors.As(err, &validErr)` - searches the entire chain
3. See the full context: `err.Error()` returns the full chain "processOrder 123: charging payment pay-456: storage: not found"

## errors.Is and errors.As Deep Dive

```go
// errors.Is traverses the error chain checking for equality
// It calls Unwrap() recursively until it finds a match or nil

// Chain: processOrder: charging payment: storage.ErrNotFound

err := processOrder(ctx, "order-123")

// All of these return true:
errors.Is(err, storage.ErrNotFound)   // Traverses chain
errors.Is(err, err)                    // Identity match

// errors.As traverses the chain checking for type assignability
var validErr *validation.ValidationError
var multiErr *validation.MultiValidationError

if errors.As(err, &validErr) {
    // validErr is now set to the first ValidationError in the chain
    fmt.Printf("field: %s, message: %s\n", validErr.Field, validErr.Message)
}

// Custom Is/As support in error types:
type NotFoundError struct {
    Resource string
    ID       string
}

func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s %q not found", e.Resource, e.ID)
}

// Custom Is allows value-based comparison (optional)
func (e *NotFoundError) Is(target error) bool {
    t, ok := target.(*NotFoundError)
    if !ok {
        return false
    }
    // Match if both resource and ID match (or target has empty ID = match any)
    return e.Resource == t.Resource && (t.ID == "" || e.ID == t.ID)
}

// Usage:
var anyUserErr = &NotFoundError{Resource: "user"}
err := &NotFoundError{Resource: "user", ID: "123"}
errors.Is(err, anyUserErr) // true - custom Is implementation matches on Resource only when ID is ""
```

## Comprehensive Domain Error Architecture

```go
// errors/errors.go - central error definitions for a payment service

package apierrors

import (
    "errors"
    "fmt"
    "net/http"
)

// Domain error codes - stable identifiers for client error handling
type ErrorCode string

const (
    CodeNotFound       ErrorCode = "NOT_FOUND"
    CodeConflict       ErrorCode = "CONFLICT"
    CodeValidation     ErrorCode = "VALIDATION_ERROR"
    CodeUnauthorized   ErrorCode = "UNAUTHORIZED"
    CodeForbidden      ErrorCode = "FORBIDDEN"
    CodeRateLimited    ErrorCode = "RATE_LIMITED"
    CodeInternalError  ErrorCode = "INTERNAL_ERROR"
    CodeServiceDown    ErrorCode = "SERVICE_UNAVAILABLE"
)

// APIError is the structured error type for all domain errors
type APIError struct {
    Code       ErrorCode `json:"code"`
    Message    string    `json:"message"`
    Detail     string    `json:"detail,omitempty"`
    StatusCode int       `json:"-"` // HTTP status, not in JSON response
    Cause      error     `json:"-"` // Internal cause, not in JSON response
}

func (e *APIError) Error() string {
    if e.Cause != nil {
        return fmt.Sprintf("[%s] %s: %v", e.Code, e.Message, e.Cause)
    }
    return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

func (e *APIError) Unwrap() error {
    return e.Cause
}

// Constructors for common errors
func NotFound(resource, id string) *APIError {
    return &APIError{
        Code:       CodeNotFound,
        Message:    fmt.Sprintf("%s not found", resource),
        Detail:     fmt.Sprintf("%s with ID %q does not exist", resource, id),
        StatusCode: http.StatusNotFound,
    }
}

func Conflict(resource, message string) *APIError {
    return &APIError{
        Code:       CodeConflict,
        Message:    fmt.Sprintf("%s conflict", resource),
        Detail:     message,
        StatusCode: http.StatusConflict,
    }
}

func ValidationFailed(detail string) *APIError {
    return &APIError{
        Code:       CodeValidation,
        Message:    "validation failed",
        Detail:     detail,
        StatusCode: http.StatusUnprocessableEntity,
    }
}

func Unauthorized(message string) *APIError {
    return &APIError{
        Code:       CodeUnauthorized,
        Message:    message,
        StatusCode: http.StatusUnauthorized,
    }
}

func Internal(cause error) *APIError {
    return &APIError{
        Code:       CodeInternalError,
        Message:    "internal server error",
        StatusCode: http.StatusInternalServerError,
        Cause:      cause,
    }
}

func RateLimited(retryAfterSeconds int) *APIError {
    return &APIError{
        Code:       CodeRateLimited,
        Message:    "rate limit exceeded",
        Detail:     fmt.Sprintf("retry after %d seconds", retryAfterSeconds),
        StatusCode: http.StatusTooManyRequests,
    }
}

// Wrap adds operation context while preserving the error type
func Wrap(err error, operation string) error {
    return fmt.Errorf("%s: %w", operation, err)
}
```

## HTTP Status Code Mapping

```go
// handler/errors.go - HTTP error response formatting

package handler

import (
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"

    "your-module/apierrors"
)

type ErrorResponse struct {
    Code    string `json:"code"`
    Message string `json:"message"`
    Detail  string `json:"detail,omitempty"`
}

// WriteError writes a consistent JSON error response.
// It maps domain errors to HTTP status codes and logs internal errors.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
    var apiErr *apierrors.APIError
    if errors.As(err, &apiErr) {
        // Domain error - known status code and code
        if apiErr.StatusCode >= 500 {
            // Log 5xx errors with full chain
            slog.ErrorContext(r.Context(), "internal error",
                slog.String("error", err.Error()),
                slog.String("path", r.URL.Path),
                slog.String("code", string(apiErr.Code)),
            )
        }

        writeJSON(w, apiErr.StatusCode, ErrorResponse{
            Code:    string(apiErr.Code),
            Message: apiErr.Message,
            Detail:  apiErr.Detail,
        })
        return
    }

    // Unknown error - log and return 500
    slog.ErrorContext(r.Context(), "unhandled error",
        slog.String("error", err.Error()),
        slog.String("path", r.URL.Path),
    )

    writeJSON(w, http.StatusInternalServerError, ErrorResponse{
        Code:    string(apierrors.CodeInternalError),
        Message: "internal server error",
    })
}

func writeJSON(w http.ResponseWriter, status int, v any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(v)
}

// Example handler using this pattern
func (h *PaymentHandler) GetPayment(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    payment, err := h.service.GetPayment(r.Context(), id)
    if err != nil {
        WriteError(w, r, err)
        return
    }

    writeJSON(w, http.StatusOK, payment)
}
```

## errors.Join for Multi-Error Grouping

Go 1.20 introduced `errors.Join` for combining multiple errors into one:

```go
package batch

import (
    "errors"
    "fmt"
)

type BatchProcessor struct {
    service PaymentService
}

func (b *BatchProcessor) ProcessBatch(ctx context.Context, payments []Payment) error {
    var errs []error

    for i, payment := range payments {
        if err := b.service.Process(ctx, payment); err != nil {
            errs = append(errs, fmt.Errorf("payment[%d] %s: %w", i, payment.ID, err))
        }
    }

    // Join all errors into one
    // errors.Join returns nil if all errs are nil
    return errors.Join(errs...)
}

// Caller can unwrap the joined error
err := processor.ProcessBatch(ctx, payments)
if err != nil {
    // Check if any specific payment had a not-found error
    if errors.Is(err, apierrors.ErrNotFound) {
        // At least one payment was not found
    }

    // Log all individual errors
    var joinedErr interface{ Unwrap() []error }
    if errors.As(err, &joinedErr) {
        for _, e := range joinedErr.Unwrap() {
            slog.Error("batch error", slog.Any("error", e))
        }
    }
}
```

## Stack Trace Capture

The standard library does not capture stack traces. For debugging production issues, use a wrapper that captures the call stack at the point of error creation:

```go
package stackerr

import (
    "fmt"
    "runtime"
    "strings"
)

// StackError wraps an error with a captured call stack.
type StackError struct {
    err   error
    stack []uintptr
}

func New(err error) *StackError {
    if err == nil {
        return nil
    }
    pcs := make([]uintptr, 32)
    n := runtime.Callers(2, pcs) // Skip Callers and New
    return &StackError{err: err, stack: pcs[:n]}
}

func (e *StackError) Error() string {
    return e.err.Error()
}

func (e *StackError) Unwrap() error {
    return e.err
}

func (e *StackError) StackTrace() string {
    frames := runtime.CallersFrames(e.stack)
    var sb strings.Builder
    for {
        frame, more := frames.Next()
        // Skip runtime internals
        if strings.HasPrefix(frame.Function, "runtime.") {
            if !more {
                break
            }
            continue
        }
        fmt.Fprintf(&sb, "\n  %s\n    %s:%d", frame.Function, frame.File, frame.Line)
        if !more {
            break
        }
    }
    return sb.String()
}

// Capture is a convenience function for use in error return paths
func Capture(err error) error {
    if err == nil {
        return nil
    }
    // Don't double-wrap stack errors
    var se *StackError
    if errors.As(err, &se) {
        return err
    }
    return New(err)
}
```

Only capture stack traces for unexpected errors. For expected domain errors (`ErrNotFound`, `ValidationError`), stack traces add noise without value:

```go
func GetPayment(ctx context.Context, id string) (*Payment, error) {
    row := db.QueryRowContext(ctx, "SELECT * FROM payments WHERE id = $1", id)

    var p Payment
    if err := row.Scan(&p.ID, &p.Amount); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            // Expected condition - no stack trace needed
            return nil, apierrors.NotFound("payment", id)
        }
        // Unexpected database error - capture stack
        return nil, stackerr.Capture(fmt.Errorf("db scan: %w", err))
    }
    return &p, nil
}
```

## Consistent API Error Response Format

```go
// Standard JSON error response for all API endpoints:
// {
//   "code": "NOT_FOUND",
//   "message": "payment not found",
//   "detail": "payment with ID \"pay-123\" does not exist",
//   "request_id": "req-456"  // from context
// }

type APIErrorResponse struct {
    Code      string `json:"code"`
    Message   string `json:"message"`
    Detail    string `json:"detail,omitempty"`
    RequestID string `json:"request_id,omitempty"`
}

func WriteError(w http.ResponseWriter, r *http.Request, err error) {
    requestID, _ := r.Context().Value(requestIDKey{}).(string)

    var apiErr *apierrors.APIError
    if !errors.As(err, &apiErr) {
        // Promote unknown errors to internal error
        apiErr = apierrors.Internal(err)
    }

    if apiErr.StatusCode >= 500 {
        slog.ErrorContext(r.Context(), "request error",
            slog.String("error", err.Error()),
            slog.Int("status", apiErr.StatusCode),
        )
    }

    writeJSON(w, apiErr.StatusCode, APIErrorResponse{
        Code:      string(apiErr.Code),
        Message:   apiErr.Message,
        Detail:    apiErr.Detail,
        RequestID: requestID,
    })
}
```

## Testing Error Handling Paths

Tests for error handling are as important as tests for the happy path. Many production bugs live in error branches.

```go
// payment_service_test.go
package service_test

import (
    "context"
    "errors"
    "testing"

    "your-module/apierrors"
    "your-module/service"
    "your-module/storage/mock"
)

func TestGetPayment_NotFound(t *testing.T) {
    repo := mock.NewPaymentRepository()
    repo.GetFunc = func(ctx context.Context, id string) (*domain.Payment, error) {
        return nil, apierrors.NotFound("payment", id)
    }

    svc := service.NewPaymentService(repo)
    _, err := svc.GetPayment(context.Background(), "pay-nonexistent")

    if err == nil {
        t.Fatal("expected error, got nil")
    }

    // Verify the correct error type is returned
    var apiErr *apierrors.APIError
    if !errors.As(err, &apiErr) {
        t.Fatalf("expected *APIError, got %T: %v", err, err)
    }

    if apiErr.Code != apierrors.CodeNotFound {
        t.Errorf("expected code NOT_FOUND, got %s", apiErr.Code)
    }

    if apiErr.StatusCode != 404 {
        t.Errorf("expected status 404, got %d", apiErr.StatusCode)
    }
}

func TestGetPayment_DatabaseError(t *testing.T) {
    dbErr := errors.New("connection refused")
    repo := mock.NewPaymentRepository()
    repo.GetFunc = func(ctx context.Context, id string) (*domain.Payment, error) {
        return nil, fmt.Errorf("db.Get: %w", dbErr)
    }

    svc := service.NewPaymentService(repo)
    _, err := svc.GetPayment(context.Background(), "pay-123")

    if err == nil {
        t.Fatal("expected error, got nil")
    }

    // Database errors should become internal errors at service boundary
    var apiErr *apierrors.APIError
    if !errors.As(err, &apiErr) {
        t.Fatalf("expected *APIError, got %T: %v", err, err)
    }

    if apiErr.Code != apierrors.CodeInternalError {
        t.Errorf("expected INTERNAL_ERROR, got %s", apiErr.Code)
    }

    // Original error should be preserved in chain
    if !errors.Is(err, dbErr) {
        t.Error("original db error should be preserved in error chain")
    }
}

func TestValidatePayment_MultipleErrors(t *testing.T) {
    err := service.ValidatePayment(domain.Payment{
        Amount:   -100,
        Currency: "",
    })

    if err == nil {
        t.Fatal("expected validation error")
    }

    var multiErr *apierrors.MultiValidationError
    if !errors.As(err, &multiErr) {
        t.Fatalf("expected *MultiValidationError, got %T: %v", err, err)
    }

    if len(multiErr.Errors) != 2 {
        t.Errorf("expected 2 validation errors, got %d", len(multiErr.Errors))
    }

    fields := make(map[string]bool)
    for _, e := range multiErr.Errors {
        fields[e.Field] = true
    }

    if !fields["amount"] {
        t.Error("expected 'amount' validation error")
    }
    if !fields["currency"] {
        t.Error("expected 'currency' validation error")
    }
}
```

## Summary

A maintainable Go error architecture uses three strategies consistently:

1. **Sentinel errors** for known, parameterless conditions (`ErrNotFound`, `ErrConflict`) - comparable with `errors.Is`
2. **Structured error types** for errors with variable context (validation failures, resource conflicts with IDs) - inspectable with `errors.As`
3. **Wrapped errors** with `fmt.Errorf("%w")` for adding operation context while preserving the original error for inspection

The supporting practices:
- Map all domain errors to a central `APIError` type with HTTP status codes at the handler boundary
- Use `errors.Join` to aggregate batch operation failures while preserving individual error inspection
- Only capture stack traces for unexpected errors to avoid noise
- Test every error return path explicitly - the race condition and nil pointer dereference is almost always in the error handling code that was never tested
- Return a consistent JSON error format from all API endpoints so clients can handle errors programmatically
