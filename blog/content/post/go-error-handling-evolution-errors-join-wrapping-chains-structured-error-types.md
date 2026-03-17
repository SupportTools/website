---
title: "Go Error Handling Evolution: errors.Join, Wrapping Chains, and Structured Error Types"
date: 2030-03-16T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Error Handling", "errors.Join", "Observability", "gRPC"]
categories: ["Go", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Modern Go error handling with errors.Join, building error type hierarchies, sentinel errors versus typed errors, error context for observability, and gRPC status code mapping in production systems."
more_link: "yes"
url: "/go-error-handling-evolution-errors-join-wrapping-chains-structured-error-types/"
---

Error handling is the unglamorous but critical discipline that separates production-grade Go code from code that merely works in happy-path scenarios. Go's error handling model has evolved significantly from the original `errors.New` and `fmt.Errorf` primitives. Go 1.13 introduced error wrapping with `%w`, Go 1.20 added `errors.Join` for multi-error aggregation, and the broader ecosystem has developed rich patterns for structured errors that carry context for observability systems, gRPC status codes, and HTTP response mapping.

This guide covers the complete spectrum of modern Go error handling: from the fundamentals of error wrapping through to production patterns for error type hierarchies, structured error context, and mapping errors across service boundaries.

<!--more-->

## The Error Interface and Its Implications

Go's `error` interface is intentionally minimal:

```go
type error interface {
    Error() string
}
```

This simplicity is both Go's greatest strength and its most challenging aspect. Any type with an `Error() string` method satisfies the interface. This means errors can carry arbitrary context, but consuming code must know how to extract that context.

The evolution of Go error handling is a progression from string-based errors toward rich, structured types that preserve context through call stacks and service boundaries.

## Pre-1.13 Error Handling: The Sentinel Era

Before Go 1.13, the dominant patterns were sentinel errors and type assertions:

```go
// Sentinel errors: values compared with ==
var (
    ErrNotFound   = errors.New("not found")
    ErrPermission = errors.New("permission denied")
    ErrTimeout    = errors.New("operation timed out")
)

func findUser(id string) (*User, error) {
    user, err := db.Query("SELECT * FROM users WHERE id = ?", id)
    if err != nil {
        if err == sql.ErrNoRows {
            return nil, ErrNotFound  // Loses the original sql error context
        }
        return nil, err
    }
    return user, nil
}

// Calling code must use == for comparison
func handleRequest(id string) error {
    user, err := findUser(id)
    if err == ErrNotFound {
        return respondWith404()
    }
    if err != nil {
        return err
    }
    // ...
}
```

The limitation: wrapping an error in another error broke sentinel comparisons. `fmt.Errorf("operation failed: %v", ErrNotFound)` creates a new error string, and `err == ErrNotFound` returns false.

## Go 1.13: The %w Verb and errors.Is/As

Go 1.13 introduced the `%w` formatting verb and the `errors.Is` and `errors.As` functions, enabling error wrapping chains:

```go
package errors_demo

import (
    "errors"
    "fmt"
)

var ErrNotFound = errors.New("not found")

// Wrapping preserves the chain while adding context
func findUser(id string) (*User, error) {
    user, err := db.Query("SELECT * FROM users WHERE id = ?", id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            // Wrap with context, preserve sentinel for comparison
            return nil, fmt.Errorf("user %s: %w", id, ErrNotFound)
        }
        return nil, fmt.Errorf("querying user %s: %w", err)
    }
    return user, nil
}

// errors.Is traverses the wrapping chain
func handleRequest(id string) error {
    user, err := findUser(id)
    if errors.Is(err, ErrNotFound) {
        // Works even with wrapped error
        return respondWith404()
    }
    return err
}
```

### Implementing Custom Is/As Methods

For custom error types, implement `Is` and `As` for comparison semantics:

```go
// DatabaseError carries structured context
type DatabaseError struct {
    Code      int
    Message   string
    Table     string
    Operation string
    Cause     error
}

func (e *DatabaseError) Error() string {
    if e.Cause != nil {
        return fmt.Sprintf("database error (code=%d, table=%s, op=%s): %s: %v",
            e.Code, e.Table, e.Operation, e.Message, e.Cause)
    }
    return fmt.Sprintf("database error (code=%d, table=%s, op=%s): %s",
        e.Code, e.Table, e.Operation, e.Message)
}

// Unwrap allows errors.Is/As to traverse the chain
func (e *DatabaseError) Unwrap() error {
    return e.Cause
}

// Is enables value-based comparison on specific fields
func (e *DatabaseError) Is(target error) bool {
    t, ok := target.(*DatabaseError)
    if !ok {
        return false
    }
    // Match on code if target has a code set
    if t.Code != 0 {
        return e.Code == t.Code
    }
    // Match on operation if set
    if t.Operation != "" {
        return e.Operation == t.Operation
    }
    return false
}

// Sentinel-style DatabaseError values for comparison
var (
    ErrDBNotFound    = &DatabaseError{Code: 404}
    ErrDBConflict    = &DatabaseError{Code: 409}
    ErrDBConstraint  = &DatabaseError{Code: 23505} // PostgreSQL unique violation
)

// Usage
func insertUser(u *User) error {
    _, err := db.Exec("INSERT INTO users ...", u.ID, u.Email)
    if err != nil {
        var pgErr *pgconn.PgError
        if errors.As(err, &pgErr) && pgErr.Code == "23505" {
            return &DatabaseError{
                Code:      409,
                Message:   "user already exists",
                Table:     "users",
                Operation: "INSERT",
                Cause:     err,
            }
        }
        return fmt.Errorf("inserting user %s: %w", u.ID, err)
    }
    return nil
}

// Caller
func createUser(u *User) error {
    if err := insertUser(u); err != nil {
        if errors.Is(err, ErrDBConflict) {
            return fmt.Errorf("user creation failed: %w", ErrUserAlreadyExists)
        }
        return err
    }
    return nil
}
```

## Go 1.20: errors.Join for Multi-Error Aggregation

`errors.Join` addresses a common production scenario: operations that attempt multiple sub-operations and want to report all failures, not just the first:

```go
package multierr

import (
    "errors"
    "fmt"
)

// errors.Join creates an error that wraps multiple errors
// errors.Is and errors.As traverse all wrapped errors
func validateUser(u *User) error {
    var errs []error

    if u.Email == "" {
        errs = append(errs, fmt.Errorf("email: %w", ErrRequired))
    } else if !isValidEmail(u.Email) {
        errs = append(errs, fmt.Errorf("email %q: %w", u.Email, ErrInvalidFormat))
    }

    if u.Name == "" {
        errs = append(errs, fmt.Errorf("name: %w", ErrRequired))
    } else if len(u.Name) > 100 {
        errs = append(errs, fmt.Errorf("name: exceeds maximum length 100: %w", ErrTooLong))
    }

    if u.Age < 0 || u.Age > 150 {
        errs = append(errs, fmt.Errorf("age %d: %w", u.Age, ErrOutOfRange))
    }

    return errors.Join(errs...)  // Returns nil if errs is empty
}

// errors.Join result supports errors.Is traversal
func handleValidation(u *User) {
    if err := validateUser(u); err != nil {
        if errors.Is(err, ErrRequired) {
            // At least one required field was missing
            fmt.Println("required fields missing")
        }
        // Can also check for multiple specific errors
        fmt.Printf("validation errors: %v\n", err)
        // Output: "email: required\nname: required"  (newline-separated)
    }
}
```

### Advanced Multi-Error Collection

For more sophisticated multi-error scenarios, build a collector that provides richer formatting:

```go
package multierr

import (
    "errors"
    "fmt"
    "strings"
)

// MultiError collects multiple errors with field context
type MultiError struct {
    Errors []FieldError
}

type FieldError struct {
    Field   string
    Message string
    Code    string
    Err     error
}

func (fe FieldError) Error() string {
    return fmt.Sprintf("%s: %s", fe.Field, fe.Message)
}

func (fe FieldError) Unwrap() error {
    return fe.Err
}

func (m *MultiError) Error() string {
    if len(m.Errors) == 0 {
        return "no errors"
    }
    var sb strings.Builder
    sb.WriteString(fmt.Sprintf("%d validation error(s):\n", len(m.Errors)))
    for i, e := range m.Errors {
        sb.WriteString(fmt.Sprintf("  [%d] %s\n", i+1, e.Error()))
    }
    return sb.String()
}

func (m *MultiError) Add(field, code, message string, err error) {
    m.Errors = append(m.Errors, FieldError{
        Field:   field,
        Message: message,
        Code:    code,
        Err:     err,
    })
}

func (m *MultiError) OrNil() error {
    if len(m.Errors) == 0 {
        return nil
    }
    return m
}

// Unwrap returns all errors for errors.Is/As traversal
func (m *MultiError) Unwrap() []error {
    errs := make([]error, len(m.Errors))
    for i, e := range m.Errors {
        fe := e
        errs[i] = &fe
    }
    return errs
}

// Usage
func validateUserAdvanced(u *User) error {
    me := &MultiError{}

    if u.Email == "" {
        me.Add("email", "REQUIRED", "email is required", ErrRequired)
    }
    if u.Password != "" && len(u.Password) < 8 {
        me.Add("password", "TOO_SHORT", "password must be at least 8 characters", ErrTooShort)
    }
    if u.Role != "" && !isValidRole(u.Role) {
        me.Add("role", "INVALID_VALUE", fmt.Sprintf("role %q is not valid", u.Role), ErrInvalidValue)
    }

    return me.OrNil()
}
```

## Error Type Hierarchies for Production Systems

Production systems require error hierarchies that can be mapped to HTTP status codes, gRPC status codes, retry decisions, and observability labels. Here is a complete hierarchy pattern:

```go
// errors/types.go
package apierrors

import (
    "errors"
    "fmt"
    "net/http"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// ErrorCategory classifies errors for handling decisions
type ErrorCategory int

const (
    CategoryUnknown    ErrorCategory = iota
    CategoryValidation               // Client input errors (4xx)
    CategoryNotFound                 // Resource not found (404)
    CategoryConflict                 // Resource conflict (409)
    CategoryPermission               // Authorization failure (403)
    CategoryRateLimit                // Rate limiting (429)
    CategoryInternal                 // Internal server errors (5xx)
    CategoryExternal                 // Upstream service errors (502/503)
    CategoryTimeout                  // Operation timeout (504)
)

// AppError is the root structured error type
type AppError struct {
    // Machine-readable error code (e.g., "USER_NOT_FOUND")
    Code string
    // Human-readable message
    Message string
    // Error category for routing logic
    Category ErrorCategory
    // HTTP status code
    HTTPStatus int
    // gRPC status code
    GRPCCode codes.Code
    // Whether the operation can be retried
    Retryable bool
    // Structured fields for observability
    Fields map[string]interface{}
    // Underlying cause
    Cause error
}

func (e *AppError) Error() string {
    if e.Cause != nil {
        return fmt.Sprintf("[%s] %s: %v", e.Code, e.Message, e.Cause)
    }
    return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

func (e *AppError) Unwrap() error {
    return e.Cause
}

func (e *AppError) Is(target error) bool {
    t, ok := target.(*AppError)
    if !ok {
        return false
    }
    if t.Code != "" {
        return e.Code == t.Code
    }
    if t.Category != CategoryUnknown {
        return e.Category == t.Category
    }
    return false
}

// WithField adds structured context to the error
func (e *AppError) WithField(key string, value interface{}) *AppError {
    clone := *e
    if clone.Fields == nil {
        clone.Fields = make(map[string]interface{})
    }
    clone.Fields[key] = value
    return &clone
}

// WithCause wraps an underlying error
func (e *AppError) WithCause(cause error) *AppError {
    clone := *e
    clone.Cause = cause
    return &clone
}

// Predefined error instances for the sentinel pattern
var (
    ErrNotFound = &AppError{
        Code:       "NOT_FOUND",
        Message:    "resource not found",
        Category:   CategoryNotFound,
        HTTPStatus: http.StatusNotFound,
        GRPCCode:   codes.NotFound,
        Retryable:  false,
    }

    ErrValidation = &AppError{
        Code:       "VALIDATION_ERROR",
        Message:    "input validation failed",
        Category:   CategoryValidation,
        HTTPStatus: http.StatusBadRequest,
        GRPCCode:   codes.InvalidArgument,
        Retryable:  false,
    }

    ErrUnauthorized = &AppError{
        Code:       "UNAUTHORIZED",
        Message:    "authentication required",
        Category:   CategoryPermission,
        HTTPStatus: http.StatusUnauthorized,
        GRPCCode:   codes.Unauthenticated,
        Retryable:  false,
    }

    ErrForbidden = &AppError{
        Code:       "FORBIDDEN",
        Message:    "insufficient permissions",
        Category:   CategoryPermission,
        HTTPStatus: http.StatusForbidden,
        GRPCCode:   codes.PermissionDenied,
        Retryable:  false,
    }

    ErrConflict = &AppError{
        Code:       "CONFLICT",
        Message:    "resource conflict",
        Category:   CategoryConflict,
        HTTPStatus: http.StatusConflict,
        GRPCCode:   codes.AlreadyExists,
        Retryable:  false,
    }

    ErrRateLimit = &AppError{
        Code:       "RATE_LIMITED",
        Message:    "rate limit exceeded",
        Category:   CategoryRateLimit,
        HTTPStatus: http.StatusTooManyRequests,
        GRPCCode:   codes.ResourceExhausted,
        Retryable:  true,
    }

    ErrInternal = &AppError{
        Code:       "INTERNAL_ERROR",
        Message:    "internal server error",
        Category:   CategoryInternal,
        HTTPStatus: http.StatusInternalServerError,
        GRPCCode:   codes.Internal,
        Retryable:  true,
    }

    ErrServiceUnavailable = &AppError{
        Code:       "SERVICE_UNAVAILABLE",
        Message:    "service temporarily unavailable",
        Category:   CategoryExternal,
        HTTPStatus: http.StatusServiceUnavailable,
        GRPCCode:   codes.Unavailable,
        Retryable:  true,
    }

    ErrTimeout = &AppError{
        Code:       "TIMEOUT",
        Message:    "operation timed out",
        Category:   CategoryTimeout,
        HTTPStatus: http.StatusGatewayTimeout,
        GRPCCode:   codes.DeadlineExceeded,
        Retryable:  true,
    }
)

// Constructor functions for creating specific error instances
func NotFoundError(resource, id string) *AppError {
    return ErrNotFound.WithField("resource", resource).WithField("id", id)
}

func ValidationError(message string, fields map[string]interface{}) *AppError {
    e := &AppError{
        Code:       "VALIDATION_ERROR",
        Message:    message,
        Category:   CategoryValidation,
        HTTPStatus: http.StatusBadRequest,
        GRPCCode:   codes.InvalidArgument,
        Fields:     fields,
    }
    return e
}
```

### HTTP Handler Error Mapping

```go
// http/middleware/error_handler.go
package middleware

import (
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"

    apierrors "myapp/errors"
)

type ErrorResponse struct {
    Code    string                 `json:"code"`
    Message string                 `json:"message"`
    Fields  map[string]interface{} `json:"fields,omitempty"`
    TraceID string                 `json:"trace_id,omitempty"`
}

func WriteError(w http.ResponseWriter, r *http.Request, err error) {
    traceID := r.Header.Get("X-Trace-ID")

    var appErr *apierrors.AppError
    if !errors.As(err, &appErr) {
        // Unknown error: treat as internal
        appErr = apierrors.ErrInternal.WithCause(err)
    }

    // Log with structured context
    slog.ErrorContext(r.Context(), "request error",
        "error_code", appErr.Code,
        "error_category", appErr.Category,
        "http_status", appErr.HTTPStatus,
        "retryable", appErr.Retryable,
        "trace_id", traceID,
        "error", err,
    )

    // Build response (never expose internal details)
    response := ErrorResponse{
        Code:    appErr.Code,
        Message: appErr.Message,
        TraceID: traceID,
    }

    // Include field context for validation errors
    if appErr.Category == apierrors.CategoryValidation {
        response.Fields = appErr.Fields
    }

    w.Header().Set("Content-Type", "application/json")

    // Add Retry-After header for rate limiting
    if appErr.Category == apierrors.CategoryRateLimit {
        w.Header().Set("Retry-After", "60")
    }

    w.WriteHeader(appErr.HTTPStatus)
    json.NewEncoder(w).Encode(response)
}
```

## gRPC Status Code Mapping

gRPC uses a different error model based on status codes. Mapping between application errors and gRPC codes correctly is critical for interoperability:

```go
// grpc/interceptors/error_interceptor.go
package interceptors

import (
    "context"
    "errors"

    apierrors "myapp/errors"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// UnaryServerInterceptor converts AppErrors to gRPC status errors
func UnaryErrorInterceptor(
    ctx context.Context,
    req interface{},
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error) {
    resp, err := handler(ctx, req)
    if err != nil {
        return nil, toGRPCError(err)
    }
    return resp, nil
}

func toGRPCError(err error) error {
    if err == nil {
        return nil
    }

    // Already a gRPC status error, pass through
    if _, ok := status.FromError(err); ok {
        return err
    }

    var appErr *apierrors.AppError
    if errors.As(err, &appErr) {
        st := status.New(appErr.GRPCCode, appErr.Message)

        // Attach error details using proto
        // This requires google.golang.org/grpc/status
        return st.Err()
    }

    // Context errors map to specific codes
    if errors.Is(err, context.DeadlineExceeded) {
        return status.Error(codes.DeadlineExceeded, "deadline exceeded")
    }
    if errors.Is(err, context.Canceled) {
        return status.Error(codes.Canceled, "request canceled")
    }

    // Default to internal error
    return status.Error(codes.Internal, "internal server error")
}

// Client-side: convert gRPC status errors back to AppErrors
func fromGRPCError(err error) error {
    if err == nil {
        return nil
    }

    st, ok := status.FromError(err)
    if !ok {
        return err
    }

    switch st.Code() {
    case codes.NotFound:
        return apierrors.ErrNotFound.WithCause(err)
    case codes.InvalidArgument:
        return apierrors.ErrValidation.WithCause(err)
    case codes.AlreadyExists:
        return apierrors.ErrConflict.WithCause(err)
    case codes.PermissionDenied:
        return apierrors.ErrForbidden.WithCause(err)
    case codes.Unauthenticated:
        return apierrors.ErrUnauthorized.WithCause(err)
    case codes.ResourceExhausted:
        return apierrors.ErrRateLimit.WithCause(err)
    case codes.DeadlineExceeded:
        return apierrors.ErrTimeout.WithCause(err)
    case codes.Unavailable:
        return apierrors.ErrServiceUnavailable.WithCause(err)
    default:
        return apierrors.ErrInternal.WithCause(err)
    }
}

// Retry logic based on error retryability
func isRetryable(err error) bool {
    var appErr *apierrors.AppError
    if errors.As(err, &appErr) {
        return appErr.Retryable
    }

    // gRPC retryable codes
    st, ok := status.FromError(err)
    if ok {
        switch st.Code() {
        case codes.Unavailable, codes.ResourceExhausted, codes.DeadlineExceeded:
            return true
        }
    }

    return false
}
```

## Error Context for Observability

Structured errors enable rich observability. Here is how to extract error context for logging, metrics, and tracing:

```go
// observability/errors.go
package observability

import (
    "context"
    "errors"
    "log/slog"

    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"

    apierrors "myapp/errors"
)

// RecordError records an error with full context across logging, metrics, and tracing
func RecordError(ctx context.Context, err error, operation string) {
    if err == nil {
        return
    }

    var appErr *apierrors.AppError
    errors.As(err, &appErr)

    // Span recording
    span := trace.SpanFromContext(ctx)
    if span.IsRecording() {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())

        if appErr != nil {
            span.SetAttributes(
                attribute.String("error.code", appErr.Code),
                attribute.Int("error.http_status", appErr.HTTPStatus),
                attribute.Bool("error.retryable", appErr.Retryable),
                attribute.String("error.category", errorCategoryString(appErr.Category)),
            )
            for k, v := range appErr.Fields {
                span.SetAttributes(attribute.String("error.field."+k, fmt.Sprint(v)))
            }
        }
    }

    // Structured logging
    attrs := []any{
        "operation", operation,
        "error", err.Error(),
    }
    if appErr != nil {
        attrs = append(attrs,
            "error_code", appErr.Code,
            "error_category", errorCategoryString(appErr.Category),
            "error_retryable", appErr.Retryable,
            "error_http_status", appErr.HTTPStatus,
        )
        for k, v := range appErr.Fields {
            attrs = append(attrs, "error_field_"+k, v)
        }
    }

    level := slog.LevelError
    if appErr != nil && (appErr.Category == apierrors.CategoryValidation ||
        appErr.Category == apierrors.CategoryNotFound) {
        level = slog.LevelWarn // Client errors are warnings, not errors
    }

    slog.Log(ctx, level, "operation failed", attrs...)
}

func errorCategoryString(c apierrors.ErrorCategory) string {
    switch c {
    case apierrors.CategoryValidation:
        return "validation"
    case apierrors.CategoryNotFound:
        return "not_found"
    case apierrors.CategoryConflict:
        return "conflict"
    case apierrors.CategoryPermission:
        return "permission"
    case apierrors.CategoryRateLimit:
        return "rate_limit"
    case apierrors.CategoryInternal:
        return "internal"
    case apierrors.CategoryExternal:
        return "external"
    case apierrors.CategoryTimeout:
        return "timeout"
    default:
        return "unknown"
    }
}
```

### Prometheus Error Metrics

```go
// metrics/errors.go
package metrics

import (
    "errors"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"

    apierrors "myapp/errors"
)

var (
    errorTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "app_errors_total",
            Help: "Total number of application errors by code and category",
        },
        []string{"code", "category", "retryable"},
    )

    errorsByOperation = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "app_operation_errors_total",
            Help: "Total errors by operation and error code",
        },
        []string{"operation", "code", "category"},
    )
)

func RecordErrorMetric(err error, operation string) {
    if err == nil {
        return
    }

    var appErr *apierrors.AppError
    if !errors.As(err, &appErr) {
        appErr = apierrors.ErrInternal
    }

    retryable := "false"
    if appErr.Retryable {
        retryable = "true"
    }

    errorTotal.WithLabelValues(
        appErr.Code,
        errorCategoryString(appErr.Category),
        retryable,
    ).Inc()

    errorsByOperation.WithLabelValues(
        operation,
        appErr.Code,
        errorCategoryString(appErr.Category),
    ).Inc()
}
```

## Panic Recovery and Error Conversion

Convert panics to errors at service boundaries to prevent goroutine crashes from taking down the entire service:

```go
// recovery/recover.go
package recovery

import (
    "fmt"
    "runtime/debug"

    apierrors "myapp/errors"
)

// RecoverToError converts a panic into an AppError
// Intended to be used as a deferred function
func RecoverToError(err *error) {
    if r := recover(); r != nil {
        stack := debug.Stack()
        *err = apierrors.ErrInternal.
            WithField("panic_value", fmt.Sprintf("%v", r)).
            WithField("stack_trace", string(stack))
    }
}

// Usage in a handler
func processRequest(req *Request) (resp *Response, err error) {
    defer recovery.RecoverToError(&err)

    // Panicking code won't crash the server
    result := mightPanic(req.Data)
    return &Response{Result: result}, nil
}
```

## Error Boundary Pattern for Service Calls

When calling external services, define clear error boundaries that normalize foreign errors into your application's error hierarchy:

```go
// boundary/user_service.go
package boundary

import (
    "context"
    "errors"
    "fmt"

    apierrors "myapp/errors"
    "myapp/proto/userpb"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// UserServiceClient is an error boundary around the gRPC user service
type UserServiceClient struct {
    inner userpb.UserServiceClient
}

func (c *UserServiceClient) GetUser(ctx context.Context, id string) (*User, error) {
    resp, err := c.inner.GetUser(ctx, &userpb.GetUserRequest{Id: id})
    if err != nil {
        return nil, c.normalizeError(err, "GetUser", map[string]interface{}{
            "user_id": id,
        })
    }
    return protoToUser(resp.User), nil
}

func (c *UserServiceClient) normalizeError(
    err error,
    operation string,
    fields map[string]interface{},
) error {
    if err == nil {
        return nil
    }

    // Wrap with operation context
    fields["operation"] = operation
    fields["service"] = "user-service"

    st, ok := status.FromError(err)
    if !ok {
        return apierrors.ErrInternal.
            WithCause(err).
            WithField("operation", operation).
            WithField("service", "user-service")
    }

    switch st.Code() {
    case codes.NotFound:
        e := apierrors.ErrNotFound.WithCause(err)
        for k, v := range fields {
            e = e.WithField(k, v)
        }
        return e

    case codes.Unavailable, codes.DeadlineExceeded:
        e := apierrors.ErrServiceUnavailable.WithCause(err)
        for k, v := range fields {
            e = e.WithField(k, v)
        }
        return fmt.Errorf("user service unavailable during %s: %w", operation, e)

    case codes.ResourceExhausted:
        e := apierrors.ErrRateLimit.WithCause(err)
        for k, v := range fields {
            e = e.WithField(k, v)
        }
        return e

    default:
        e := apierrors.ErrInternal.WithCause(err)
        for k, v := range fields {
            e = e.WithField(k, v)
        }
        return e
    }
}
```

## Testing Error Handling

Thorough error handling testing is as important as the implementation:

```go
// errors_test.go
package apierrors_test

import (
    "errors"
    "testing"

    apierrors "myapp/errors"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestErrorWrappingChain(t *testing.T) {
    // Build a deep wrapping chain
    cause := errors.New("database connection refused")
    dbErr := &apierrors.AppError{
        Code:       "DB_ERROR",
        Category:   apierrors.CategoryInternal,
        HTTPStatus: 500,
        Cause:      cause,
    }
    wrapped := fmt.Errorf("processing user request: %w", dbErr)

    // errors.Is should traverse the chain
    assert.True(t, errors.Is(wrapped, dbErr))
    assert.True(t, errors.Is(wrapped, apierrors.ErrInternal))

    // errors.As should extract the AppError
    var extracted *apierrors.AppError
    require.True(t, errors.As(wrapped, &extracted))
    assert.Equal(t, "DB_ERROR", extracted.Code)
}

func TestErrorsJoin(t *testing.T) {
    err1 := fmt.Errorf("field A: %w", apierrors.ErrValidation)
    err2 := fmt.Errorf("field B: %w", apierrors.ErrValidation)
    combined := errors.Join(err1, err2)

    // errors.Is checks all joined errors
    assert.True(t, errors.Is(combined, apierrors.ErrValidation))

    // Error message contains both
    assert.Contains(t, combined.Error(), "field A")
    assert.Contains(t, combined.Error(), "field B")
}

func TestNilErrorHandling(t *testing.T) {
    // errors.Join with no non-nil errors returns nil
    assert.Nil(t, errors.Join())
    assert.Nil(t, errors.Join(nil, nil, nil))
    assert.NotNil(t, errors.Join(nil, errors.New("one"), nil))
}

func TestGRPCErrorMapping(t *testing.T) {
    tests := []struct {
        name         string
        appErr       *apierrors.AppError
        expectedCode codes.Code
    }{
        {"not found", apierrors.ErrNotFound, codes.NotFound},
        {"validation", apierrors.ErrValidation, codes.InvalidArgument},
        {"conflict", apierrors.ErrConflict, codes.AlreadyExists},
        {"internal", apierrors.ErrInternal, codes.Internal},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            grpcErr := toGRPCError(tt.appErr)
            st, ok := status.FromError(grpcErr)
            require.True(t, ok)
            assert.Equal(t, tt.expectedCode, st.Code())
        })
    }
}
```

## Key Takeaways

Modern Go error handling is a discipline that spans the entire service architecture. The key principles:

**Use errors.Join for multi-error scenarios**: Validation, batch processing, and parallel operations benefit from collecting all errors rather than failing on the first.

**Build typed error hierarchies**: `AppError` or equivalent types carry the metadata needed to map errors to HTTP status codes, gRPC codes, retry decisions, and observability labels without switch statements scattered throughout your codebase.

**Sentinel errors remain valuable**: The `&AppError{Code: "NOT_FOUND"}` sentinel pattern, combined with `errors.Is` and the `Is()` method override, gives you value-based comparison semantics with rich context.

**Define error boundaries at service edges**: Normalize foreign errors (gRPC, database, HTTP client) into your application's error type at the point of call, not deep in the call stack.

**Log at the right level**: 4xx errors from client mistakes are warnings; 5xx errors from system failures are errors. This distinction prevents alert fatigue and makes error dashboards meaningful.

**Never expose internal errors to clients**: The error type hierarchy should cleanly separate what is safe to surface (code, message, field context) from what must stay internal (stack traces, internal system details, database query specifics).
