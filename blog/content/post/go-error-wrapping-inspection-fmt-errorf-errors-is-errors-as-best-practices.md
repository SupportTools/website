---
title: "Go Error Wrapping and Inspection: fmt.Errorf, errors.Is, errors.As Best Practices"
date: 2031-02-03T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Error Handling", "Best Practices", "gRPC", "HTTP", "Observability"]
categories:
- Go
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Go error handling: error wrapping with %w, errors.Is for sentinel comparison, errors.As for type extraction, custom error types with context, error chains in gRPC and HTTP responses, and structured error logging."
more_link: "yes"
url: "/go-error-wrapping-inspection-fmt-errorf-errors-is-errors-as-best-practices/"
---

Go's error handling model is intentionally minimal: errors are values, and the standard library provides just enough to build expressive error systems without mandating a particular approach. The wrapping and inspection functions added in Go 1.13 — `fmt.Errorf` with `%w`, `errors.Is`, and `errors.As` — form the foundation of idiomatic Go error handling. Used correctly, they enable rich error context without sacrificing type safety or adding unnecessary dependencies.

<!--more-->

# Go Error Wrapping and Inspection: fmt.Errorf, errors.Is, errors.As Best Practices

## Section 1: The Error Interface and Sentinel Errors

The `error` interface in Go is a single-method interface:

```go
type error interface {
    Error() string
}
```

**Sentinel errors** are package-level error values used for comparison. They are the simplest form of structured errors:

```go
package storage

import "errors"

// Exported sentinel errors — callers can compare against these
var (
    ErrNotFound      = errors.New("record not found")
    ErrConflict      = errors.New("record already exists")
    ErrInvalidInput  = errors.New("invalid input")
    ErrUnauthorized  = errors.New("unauthorized")
    ErrQuotaExceeded = errors.New("quota exceeded")
)
```

### Direct Sentinel Comparison (Before Go 1.13)

```go
// The naive approach — works only for unwrapped errors
if err == storage.ErrNotFound {
    // handle not found
}
```

This breaks when errors are wrapped, because the wrapped error is a different value than the sentinel.

## Section 2: Error Wrapping with fmt.Errorf and %w

The `%w` verb wraps an error, making it available for inspection by `errors.Is` and `errors.As` while adding context to the error message:

```go
package service

import (
    "fmt"
    "yourcompany.com/storage"
)

func GetUser(ctx context.Context, userID string) (*User, error) {
    user, err := storage.FindUser(ctx, userID)
    if err != nil {
        // Wrap with context: who called what, with what input
        return nil, fmt.Errorf("GetUser(%q): %w", userID, err)
    }
    return user, nil
}
```

The resulting error message when `FindUser` returns `ErrNotFound`:
```
GetUser("user-123"): record not found
```

### Wrapping Multiple Error Contexts

Each layer of the call stack should add its specific context:

```go
// storage layer
func (r *UserRepository) FindByEmail(ctx context.Context, email string) (*User, error) {
    var u User
    err := r.db.QueryRowContext(ctx,
        "SELECT id, name, email FROM users WHERE email = $1", email,
    ).Scan(&u.ID, &u.Name, &u.Email)

    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("FindByEmail(%q): %w", email, ErrNotFound)
    }
    if err != nil {
        return nil, fmt.Errorf("FindByEmail(%q): database query: %w", email, err)
    }
    return &u, nil
}

// service layer
func (s *UserService) GetUserByEmail(ctx context.Context, email string) (*User, error) {
    user, err := s.repo.FindByEmail(ctx, email)
    if err != nil {
        return nil, fmt.Errorf("UserService.GetUserByEmail: %w", err)
    }
    return user, nil
}

// handler layer
func (h *Handler) HandleGetUser(w http.ResponseWriter, r *http.Request) {
    email := r.URL.Query().Get("email")
    user, err := h.svc.GetUserByEmail(r.Context(), email)
    if err != nil {
        h.handleError(w, r, err)
        return
    }
    // ... respond
}
```

The full error chain would be:
```
UserService.GetUserByEmail: FindByEmail("alice@company.com"): record not found
```

## Section 3: errors.Is for Sentinel Comparison

`errors.Is` walks the error chain looking for a match:

```go
import "errors"

func (h *Handler) handleError(w http.ResponseWriter, r *http.Request, err error) {
    switch {
    case errors.Is(err, storage.ErrNotFound):
        // Map domain error to HTTP status
        http.Error(w, "resource not found", http.StatusNotFound)

    case errors.Is(err, storage.ErrConflict):
        http.Error(w, "resource already exists", http.StatusConflict)

    case errors.Is(err, storage.ErrUnauthorized):
        http.Error(w, "unauthorized", http.StatusUnauthorized)

    case errors.Is(err, storage.ErrQuotaExceeded):
        http.Error(w, "quota exceeded", http.StatusTooManyRequests)

    case errors.Is(err, context.Canceled):
        // Client disconnected — don't log as error
        return

    case errors.Is(err, context.DeadlineExceeded):
        http.Error(w, "request timeout", http.StatusGatewayTimeout)

    default:
        // Unknown error — log it
        slog.Error("unhandled error",
            "error", err,
            "path", r.URL.Path,
            "method", r.Method)
        http.Error(w, "internal server error", http.StatusInternalServerError)
    }
}
```

### Custom Is Method

For errors where equality isn't just pointer identity:

```go
// HTTPError wraps an HTTP status code as an error
type HTTPError struct {
    StatusCode int
    Message    string
}

func (e *HTTPError) Error() string {
    return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.Message)
}

// Is allows matching by status code, not pointer identity
func (e *HTTPError) Is(target error) bool {
    t, ok := target.(*HTTPError)
    if !ok {
        return false
    }
    // Match if target has the same status code
    return t.StatusCode == e.StatusCode
}

// Usage
var ErrNotFound = &HTTPError{StatusCode: 404}

func checkResponse(resp *http.Response) error {
    if resp.StatusCode == 404 {
        return fmt.Errorf("resource %q: %w", resp.Request.URL.Path, ErrNotFound)
    }
    return nil
}

// errors.Is(err, ErrNotFound) will call ErrNotFound.Is(wrapped) at each level
if errors.Is(err, &HTTPError{StatusCode: 404}) {
    // true even for wrapped errors
}
```

## Section 4: errors.As for Type Extraction

`errors.As` walks the error chain looking for a type match, and sets the target pointer to the found error. This is how you extract additional context from typed errors:

```go
// ValidationError carries per-field validation failures
type ValidationError struct {
    Field   string
    Message string
    Value   interface{}
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed for field %q: %s (got %v)",
        e.Field, e.Message, e.Value)
}

// DatabaseError carries query context
type DatabaseError struct {
    Op    string  // Operation: "query", "exec", "scan"
    Query string  // The SQL query (potentially redacted)
    Err   error   // Underlying error
}

func (e *DatabaseError) Error() string {
    return fmt.Sprintf("database %s: %v", e.Op, e.Err)
}

func (e *DatabaseError) Unwrap() error {
    return e.Err
}
```

```go
func handleServiceError(err error) {
    // Extract ValidationError for user-facing messages
    var ve *ValidationError
    if errors.As(err, &ve) {
        respondWithJSON(w, http.StatusBadRequest, map[string]interface{}{
            "error": "validation_error",
            "field": ve.Field,
            "message": ve.Message,
        })
        return
    }

    // Extract DatabaseError for detailed logging
    var de *DatabaseError
    if errors.As(err, &de) {
        slog.Error("database error",
            "operation", de.Op,
            "query_redacted", redactQuery(de.Query),
            "error", de.Err)
        respondWithJSON(w, http.StatusInternalServerError, map[string]string{
            "error": "database_error",
        })
        return
    }

    // ... other error types
}
```

### errors.As with Interface Types

`errors.As` also works with interface types, not just concrete types:

```go
// Retryable is an interface for errors that support retry decisions
type Retryable interface {
    error
    IsRetryable() bool
    RetryAfter() time.Duration
}

// NetworkError implements Retryable
type NetworkError struct {
    Msg        string
    Temporary  bool
    RetryDelay time.Duration
}

func (e *NetworkError) Error() string       { return e.Msg }
func (e *NetworkError) IsRetryable() bool    { return e.Temporary }
func (e *NetworkError) RetryAfter() time.Duration { return e.RetryDelay }

// Check for retryable interface
func shouldRetry(err error) (bool, time.Duration) {
    var r Retryable
    if errors.As(err, &r) {
        return r.IsRetryable(), r.RetryAfter()
    }
    // Context errors are never retryable
    if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
        return false, 0
    }
    return false, 0
}
```

## Section 5: Custom Error Types with Rich Context

For production systems, errors should carry enough context to diagnose the issue without reading the source code:

```go
// errors/errors.go — centralized error types for the service
package apierrors

import (
    "fmt"
    "net/http"
    "time"
)

// Code is a machine-readable error classification
type Code string

const (
    CodeNotFound       Code = "NOT_FOUND"
    CodeConflict       Code = "CONFLICT"
    CodeInvalidInput   Code = "INVALID_INPUT"
    CodeUnauthorized   Code = "UNAUTHORIZED"
    CodeForbidden      Code = "FORBIDDEN"
    CodeQuotaExceeded  Code = "QUOTA_EXCEEDED"
    CodeInternal       Code = "INTERNAL"
    CodeUnavailable    Code = "UNAVAILABLE"
)

// APIError is the standard error type for the service API layer.
type APIError struct {
    Code       Code                   `json:"code"`
    Message    string                 `json:"message"`
    Details    map[string]interface{} `json:"details,omitempty"`
    HTTPStatus int                    `json:"-"`
    Cause      error                  `json:"-"`  // The underlying error (not serialized)
    TraceID    string                 `json:"trace_id,omitempty"`
    Timestamp  time.Time              `json:"timestamp"`
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

// Is implements custom equality — match by Code
func (e *APIError) Is(target error) bool {
    t, ok := target.(*APIError)
    if !ok {
        return false
    }
    return t.Code == e.Code
}

// Constructor functions for each error type

func NotFound(resource string, id interface{}) *APIError {
    return &APIError{
        Code:       CodeNotFound,
        Message:    fmt.Sprintf("%s not found", resource),
        HTTPStatus: http.StatusNotFound,
        Details:    map[string]interface{}{"resource": resource, "id": fmt.Sprint(id)},
        Timestamp:  time.Now(),
    }
}

func NotFoundWithCause(resource string, id interface{}, cause error) *APIError {
    e := NotFound(resource, id)
    e.Cause = cause
    return e
}

func InvalidInput(field, message string) *APIError {
    return &APIError{
        Code:       CodeInvalidInput,
        Message:    message,
        HTTPStatus: http.StatusBadRequest,
        Details:    map[string]interface{}{"field": field},
        Timestamp:  time.Now(),
    }
}

func Internal(message string, cause error) *APIError {
    return &APIError{
        Code:       CodeInternal,
        Message:    message,
        HTTPStatus: http.StatusInternalServerError,
        Cause:      cause,
        Timestamp:  time.Now(),
    }
}

// Sentinel values for errors.Is matching
var (
    ErrNotFound      = &APIError{Code: CodeNotFound}
    ErrConflict      = &APIError{Code: CodeConflict}
    ErrInvalidInput  = &APIError{Code: CodeInvalidInput}
    ErrUnauthorized  = &APIError{Code: CodeUnauthorized}
    ErrInternal      = &APIError{Code: CodeInternal}
)
```

### Using Rich Error Types

```go
func (s *UserService) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
    // Input validation
    if req.Email == "" {
        return nil, apierrors.InvalidInput("email", "email is required")
    }
    if !isValidEmail(req.Email) {
        return nil, apierrors.InvalidInput("email", "invalid email format")
    }

    // Check for existing user
    existing, err := s.repo.FindByEmail(ctx, req.Email)
    if err != nil && !errors.Is(err, storage.ErrNotFound) {
        return nil, apierrors.Internal("failed to check existing user", err)
    }
    if existing != nil {
        return nil, &apierrors.APIError{
            Code:       apierrors.CodeConflict,
            Message:    "user with this email already exists",
            HTTPStatus: http.StatusConflict,
            Details:    map[string]interface{}{"email": req.Email},
            Timestamp:  time.Now(),
        }
    }

    // Create the user
    user, err := s.repo.Create(ctx, req)
    if err != nil {
        return nil, fmt.Errorf("CreateUser: %w",
            apierrors.Internal("failed to create user", err))
    }

    return user, nil
}
```

## Section 6: Error Chains in HTTP Responses

Converting internal errors to appropriate HTTP responses while maintaining proper error context:

```go
// middleware/error_handler.go
package middleware

import (
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"

    "yourcompany.com/apierrors"
)

type ErrorResponse struct {
    Code      string                 `json:"code"`
    Message   string                 `json:"message"`
    Details   map[string]interface{} `json:"details,omitempty"`
    TraceID   string                 `json:"trace_id,omitempty"`
}

// HandleHTTPError converts an error to an HTTP response.
// It logs internal errors and returns safe messages to clients.
func HandleHTTPError(w http.ResponseWriter, r *http.Request, err error) {
    traceID := getTraceID(r.Context())

    var apiErr *apierrors.APIError
    if errors.As(err, &apiErr) {
        // Known API error — use its HTTP status and code
        if apiErr.HTTPStatus >= 500 {
            // Log server errors with full detail including the cause chain
            slog.ErrorContext(r.Context(), "server error",
                "code", apiErr.Code,
                "message", apiErr.Message,
                "cause", apiErr.Cause,
                "error_chain", err.Error(),
                "trace_id", traceID,
                "path", r.URL.Path,
                "method", r.Method)
        }

        respondJSON(w, apiErr.HTTPStatus, ErrorResponse{
            Code:    string(apiErr.Code),
            Message: apiErr.Message,
            Details: apiErr.Details,
            TraceID: traceID,
        })
        return
    }

    // Check for well-known standard errors
    switch {
    case errors.Is(err, context.Canceled):
        // Client disconnected; no response needed
        return
    case errors.Is(err, context.DeadlineExceeded):
        respondJSON(w, http.StatusGatewayTimeout, ErrorResponse{
            Code:    "TIMEOUT",
            Message: "request timed out",
            TraceID: traceID,
        })
        return
    }

    // Unknown error — log with full chain, respond with generic message
    slog.ErrorContext(r.Context(), "unhandled error",
        "error", err,
        "error_chain", fmt.Sprintf("%+v", err),
        "trace_id", traceID,
        "path", r.URL.Path,
        "method", r.Method)

    respondJSON(w, http.StatusInternalServerError, ErrorResponse{
        Code:    "INTERNAL",
        Message: "an internal error occurred",
        TraceID: traceID,
    })
}

func respondJSON(w http.ResponseWriter, status int, body interface{}) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(body)
}
```

## Section 7: Error Chains in gRPC Responses

gRPC uses `google.golang.org/grpc/status` for structured error responses:

```go
// grpc/errors.go
package grpc

import (
    "errors"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    "yourcompany.com/apierrors"
)

// APIErrorToGRPCStatus converts an APIError to a gRPC status.
func APIErrorToGRPCStatus(err error) error {
    var apiErr *apierrors.APIError
    if !errors.As(err, &apiErr) {
        // Check standard errors
        if errors.Is(err, context.Canceled) {
            return status.Error(codes.Canceled, "request canceled")
        }
        if errors.Is(err, context.DeadlineExceeded) {
            return status.Error(codes.DeadlineExceeded, "deadline exceeded")
        }
        return status.Error(codes.Internal, "internal server error")
    }

    grpcCode := apiCodeToGRPC(apiErr.Code)

    // Build a status with error details
    st := status.New(grpcCode, apiErr.Message)

    // Attach details if available
    if len(apiErr.Details) > 0 {
        // Use google.rpc.ErrorInfo or google.rpc.BadRequest as appropriate
        errInfo := &errdetails.ErrorInfo{
            Reason: string(apiErr.Code),
            Domain: "yourcompany.com",
            Metadata: func() map[string]string {
                m := make(map[string]string)
                for k, v := range apiErr.Details {
                    m[k] = fmt.Sprint(v)
                }
                return m
            }(),
        }
        st, _ = st.WithDetails(errInfo)
    }

    return st.Err()
}

func apiCodeToGRPC(code apierrors.Code) codes.Code {
    switch code {
    case apierrors.CodeNotFound:
        return codes.NotFound
    case apierrors.CodeConflict:
        return codes.AlreadyExists
    case apierrors.CodeInvalidInput:
        return codes.InvalidArgument
    case apierrors.CodeUnauthorized:
        return codes.Unauthenticated
    case apierrors.CodeForbidden:
        return codes.PermissionDenied
    case apierrors.CodeQuotaExceeded:
        return codes.ResourceExhausted
    case apierrors.CodeUnavailable:
        return codes.Unavailable
    default:
        return codes.Internal
    }
}
```

```go
// gRPC interceptor for consistent error handling
func ErrorHandlingInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        resp, err := handler(ctx, req)
        if err == nil {
            return resp, nil
        }

        // Log internal errors before converting
        var apiErr *apierrors.APIError
        if errors.As(err, &apiErr) && apiErr.HTTPStatus >= 500 {
            slog.ErrorContext(ctx, "gRPC handler error",
                "method", info.FullMethod,
                "error", err)
        }

        return nil, APIErrorToGRPCStatus(err)
    }
}
```

### Handling gRPC Errors on the Client Side

```go
// client/errors.go
package client

import (
    "errors"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/grpc/status/statuspb"
)

var (
    ErrNotFound     = errors.New("not found")
    ErrConflict     = errors.New("conflict")
    ErrUnauthorized = errors.New("unauthorized")
)

// GRPCErrorToAPIError converts a gRPC status error to a domain error.
func GRPCErrorToAPIError(err error) error {
    st, ok := status.FromError(err)
    if !ok {
        return err
    }

    switch st.Code() {
    case codes.NotFound:
        return fmt.Errorf("%s: %w", st.Message(), ErrNotFound)
    case codes.AlreadyExists:
        return fmt.Errorf("%s: %w", st.Message(), ErrConflict)
    case codes.Unauthenticated:
        return fmt.Errorf("%s: %w", st.Message(), ErrUnauthorized)
    case codes.Canceled:
        return context.Canceled
    case codes.DeadlineExceeded:
        return context.DeadlineExceeded
    default:
        return fmt.Errorf("gRPC error [%s]: %s", st.Code(), st.Message())
    }
}
```

## Section 8: Structured Error Logging

Errors should produce structured log entries that can be queried programmatically:

```go
// logging/errors.go
package logging

import (
    "context"
    "errors"
    "log/slog"

    "yourcompany.com/apierrors"
)

// LogError logs an error with structured fields appropriate to its type.
// It handles APIErrors specially to extract the error code and cause.
func LogError(ctx context.Context, msg string, err error, attrs ...slog.Attr) {
    if err == nil {
        return
    }

    // Start with common attributes
    logAttrs := []any{
        "error", err.Error(),
    }

    // Add error chain if wrapped
    if cause := errors.Unwrap(err); cause != nil {
        logAttrs = append(logAttrs, "cause", cause.Error())
    }

    // Add APIError-specific fields
    var apiErr *apierrors.APIError
    if errors.As(err, &apiErr) {
        logAttrs = append(logAttrs,
            "error_code", string(apiErr.Code),
            "http_status", apiErr.HTTPStatus,
        )
        if apiErr.Cause != nil {
            logAttrs = append(logAttrs, "root_cause", apiErr.Cause.Error())
        }
    }

    // Add caller-provided attributes
    for _, a := range attrs {
        logAttrs = append(logAttrs, a.Key, a.Value)
    }

    // Choose log level based on error type
    if isClientError(err) {
        slog.InfoContext(ctx, msg, logAttrs...)
    } else {
        slog.ErrorContext(ctx, msg, logAttrs...)
    }
}

func isClientError(err error) bool {
    var apiErr *apierrors.APIError
    if errors.As(err, &apiErr) {
        return apiErr.HTTPStatus >= 400 && apiErr.HTTPStatus < 500
    }
    return false
}
```

### Error Aggregation for Multiple Failures

```go
// multierr.go — aggregate multiple errors
package errors

import (
    "strings"
)

// MultiError collects multiple errors.
// Useful for validation that should report all failures, not just the first.
type MultiError struct {
    Errors []error
}

func (m *MultiError) Error() string {
    if len(m.Errors) == 1 {
        return m.Errors[0].Error()
    }
    msgs := make([]string, len(m.Errors))
    for i, e := range m.Errors {
        msgs[i] = e.Error()
    }
    return fmt.Sprintf("%d errors: %s", len(m.Errors), strings.Join(msgs, "; "))
}

// Add appends an error if it is non-nil.
func (m *MultiError) Add(err error) {
    if err != nil {
        m.Errors = append(m.Errors, err)
    }
}

// Err returns nil if no errors were added, or the MultiError itself.
func (m *MultiError) Err() error {
    if len(m.Errors) == 0 {
        return nil
    }
    return m
}

// Is implements errors.Is — matches if any wrapped error matches target.
func (m *MultiError) Is(target error) bool {
    for _, e := range m.Errors {
        if errors.Is(e, target) {
            return true
        }
    }
    return false
}

// As implements errors.As — matches if any wrapped error can be assigned to target.
func (m *MultiError) As(target interface{}) bool {
    for _, e := range m.Errors {
        if errors.As(e, target) {
            return true
        }
    }
    return false
}
```

```go
// Usage in validation
func (s *UserService) validateCreateRequest(req CreateUserRequest) error {
    var errs MultiError

    if req.Name == "" {
        errs.Add(apierrors.InvalidInput("name", "name is required"))
    }
    if req.Email == "" {
        errs.Add(apierrors.InvalidInput("email", "email is required"))
    } else if !isValidEmail(req.Email) {
        errs.Add(apierrors.InvalidInput("email", "invalid email format"))
    }
    if req.Age < 0 || req.Age > 150 {
        errs.Add(apierrors.InvalidInput("age", "age must be between 0 and 150"))
    }

    return errs.Err()
}
```

## Section 9: Error Handling Patterns Comparison

### Pattern 1: Panic and Recover (Not Recommended for Production)

```go
// AVOID: using panic for business logic errors
func dangerousGetUser(id string) *User {
    user, err := db.Find(id)
    if err != nil {
        panic(err) // Don't do this
    }
    return user
}
```

### Pattern 2: Result Type (Popular but Verbose)

```go
// Some teams use a Result type inspired by Rust
type Result[T any] struct {
    value T
    err   error
}

func Ok[T any](v T) Result[T]    { return Result[T]{value: v} }
func Err[T any](e error) Result[T] { return Result[T]{err: e} }

func (r Result[T]) Unwrap() (T, error) { return r.value, r.err }
func (r Result[T]) IsOk() bool          { return r.err == nil }

// Usage
result := getUser(ctx, id)
if !result.IsOk() {
    user, err := result.Unwrap()
    // ...
}
```

### Pattern 3: Idiomatic Go (Recommended)

```go
// PREFER: standard return (value, error) with wrapping
func getUser(ctx context.Context, id string) (*User, error) {
    user, err := db.Find(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("getUser(%q): %w", id, err)
    }
    return user, nil
}
```

## Section 10: Testing Error Handling

```go
// errors_test.go
package service_test

import (
    "errors"
    "testing"

    "yourcompany.com/apierrors"
    "yourcompany.com/service"
)

func TestGetUser_NotFound(t *testing.T) {
    repo := &mockUserRepository{
        findByIDErr: storage.ErrNotFound,
    }
    svc := service.NewUserService(repo)

    _, err := svc.GetUser(t.Context(), "nonexistent-id")

    // Verify the error type is preserved through the call stack
    if !errors.Is(err, storage.ErrNotFound) {
        t.Errorf("expected ErrNotFound in chain, got: %v (type: %T)", err, err)
    }

    // Verify the error was also wrapped as an APIError
    var apiErr *apierrors.APIError
    if !errors.As(err, &apiErr) {
        t.Errorf("expected *apierrors.APIError in chain, got: %T", err)
    } else {
        if apiErr.Code != apierrors.CodeNotFound {
            t.Errorf("expected code NOT_FOUND, got %s", apiErr.Code)
        }
        if apiErr.HTTPStatus != 404 {
            t.Errorf("expected HTTP 404, got %d", apiErr.HTTPStatus)
        }
    }

    // Verify the error message contains context
    if !strings.Contains(err.Error(), "nonexistent-id") {
        t.Errorf("error message should contain the ID: %v", err)
    }
}

func TestGetUser_DatabaseError(t *testing.T) {
    dbErr := &storage.DatabaseError{
        Op:    "query",
        Query: "SELECT * FROM users WHERE id = $1",
        Err:   errors.New("connection reset"),
    }
    repo := &mockUserRepository{findByIDErr: dbErr}
    svc := service.NewUserService(repo)

    _, err := svc.GetUser(t.Context(), "user-123")

    // Should be wrapped as an internal APIError
    if !errors.Is(err, apierrors.ErrInternal) {
        t.Errorf("database error should be wrapped as internal: %v", err)
    }

    // The DatabaseError should still be accessible in the chain
    var de *storage.DatabaseError
    if !errors.As(err, &de) {
        t.Errorf("DatabaseError should be in the chain: %v", err)
    }
}
```

## Section 11: Common Mistakes and How to Avoid Them

### Mistake 1: Checking err != nil Before errors.Is

```go
// WRONG: double-checking is redundant
if err != nil && errors.Is(err, ErrNotFound) {
    // errors.Is handles nil correctly — if err is nil, Is returns false
}

// CORRECT:
if errors.Is(err, ErrNotFound) {
    // errors.Is returns false when err is nil
}
```

### Mistake 2: Using fmt.Errorf Without %w When You Need Wrapping

```go
// WRONG: %v creates a new error string, losing the original type
return fmt.Errorf("operation failed: %v", err)

// CORRECT: %w wraps, preserving errors.Is/As traversal
return fmt.Errorf("operation failed: %w", err)
```

### Mistake 3: Wrapping Errors Multiple Times at the Same Layer

```go
// WRONG: double-wrapping at the same call site
return fmt.Errorf("outer: %w", fmt.Errorf("inner: %w", originalErr))

// CORRECT: wrap once with all relevant context
return fmt.Errorf("functionName(%q) step X: %w", param, originalErr)
```

### Mistake 4: Logging and Returning the Same Error

```go
// WRONG: the caller will also log this error, causing duplicate log entries
func doSomething() error {
    err := downstream()
    if err != nil {
        log.Printf("error: %v", err)  // Log here
        return fmt.Errorf("doSomething: %w", err)  // AND return
    }
    return nil
}

// CORRECT: only log at the boundary (HTTP handler, gRPC interceptor, main)
// Intermediate functions only wrap and return
func doSomething() error {
    err := downstream()
    if err != nil {
        return fmt.Errorf("doSomething: %w", err)  // Wrap, don't log
    }
    return nil
}
```

### Mistake 5: Ignoring Errors from Cleanup Functions

```go
// WRONG: silently ignoring Close errors can hide data loss
defer file.Close()

// CORRECT: log Close errors (but don't return them from defer in most cases)
defer func() {
    if err := file.Close(); err != nil {
        slog.Warn("failed to close file", "path", file.Name(), "err", err)
    }
}()

// Or for functions where Close failure matters:
defer func() {
    cerr := file.Close()
    if cerr != nil && err == nil {
        err = fmt.Errorf("close file: %w", cerr)
    }
}()
```

Go's error model rewards consistency. A codebase that wraps errors at every boundary, uses `errors.Is` for sentinel matching, and `errors.As` for type extraction provides debuggability that rivals exception-based languages — without the overhead of stack unwinding or the ambiguity of which exceptions can escape a function boundary.
