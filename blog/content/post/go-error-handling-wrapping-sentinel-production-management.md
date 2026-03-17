---
title: "Go Error Handling: Wrapping, Sentinel Errors, and Production Error Management"
date: 2030-06-10T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Error Handling", "Production", "Best Practices", "Software Engineering", "Observability"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Go error handling: errors.Is/As patterns, sentinel error types, error wrapping chains, structured error types, HTTP error translation, and building error handling that aids debugging without leaking internals."
more_link: "yes"
url: "/go-error-handling-wrapping-sentinel-production-management/"
---

Error handling is where Go code spends disproportionate attention relative to most languages. The language's explicit error return values, absence of exceptions, and rich standard library support for error wrapping create both opportunity and obligation: errors can carry complete context about what went wrong and where, or they can be meaningless string concatenations that obscure root causes. This guide covers the patterns that distinguish production-quality error handling from code that works until it doesn't.

<!--more-->

## The Go Error Model

### Why Explicit Errors Matter

Go's `error` interface is deliberately minimal:

```go
type error interface {
    Error() string
}
```

This simplicity enables a powerful consequence: errors are values. They can be stored in structs, returned in slices, wrapped in channels, compared with `==` (for sentinel errors), and inspected with `errors.Is`/`errors.As`. Unlike exception stacks which unwind automatically, Go errors travel explicitly through the call stack, visible at every function boundary.

The discipline this requires — handling errors at every level — becomes an asset in production systems where error propagation paths are documented in the code itself.

### The Two Failure Modes of Poor Error Handling

**Mode 1: Silent discard**

```go
// BAD: Error is ignored — failure is completely invisible
data, _ := json.Marshal(payload)
os.WriteFile("/var/log/app.log", data, 0644)
```

**Mode 2: Context-free propagation**

```go
// BAD: The caller has no idea what operation failed or why
func GetUser(id int64) (*User, error) {
    row := db.QueryRow("SELECT * FROM users WHERE id = $1", id)
    var u User
    if err := row.Scan(&u.ID, &u.Name); err != nil {
        return nil, err  // Which operation? Which user? What query?
    }
    return &u, nil
}
```

Both modes share the same outcome: debugging a production incident requires reading source code and guessing, because the logged error contains insufficient context.

## Sentinel Errors

Sentinel errors are package-level `error` values that represent specific, expected failure conditions. They enable callers to distinguish between different failure modes using `errors.Is`.

### Defining Sentinel Errors

```go
package user

import "errors"

// Sentinel errors represent the specific expected failures in the user package.
// They are exported so callers can distinguish error types.
var (
    ErrNotFound      = errors.New("user not found")
    ErrEmailTaken    = errors.New("email address already registered")
    ErrInvalidEmail  = errors.New("invalid email address format")
    ErrInvalidAge    = errors.New("age must be between 0 and 150")
    ErrPermission    = errors.New("insufficient permissions for this operation")
    ErrSuspended     = errors.New("user account is suspended")
)
```

### Checking Sentinel Errors with errors.Is

```go
// errors.Is traverses the error wrapping chain.
// It works even when the error has been wrapped multiple times.
func handleGetUser(ctx context.Context, userID int64) {
    user, err := userService.GetUser(ctx, userID)
    if err != nil {
        switch {
        case errors.Is(err, user.ErrNotFound):
            // Expected: return 404
            http.Error(w, "User not found", http.StatusNotFound)
        case errors.Is(err, user.ErrPermission):
            // Expected: return 403
            http.Error(w, "Access denied", http.StatusForbidden)
        case errors.Is(err, user.ErrSuspended):
            // Expected: return 403 with specific message
            http.Error(w, "Account suspended", http.StatusForbidden)
        default:
            // Unexpected: log and return 500
            logger.Error("unexpected error getting user",
                zap.Int64("user_id", userID),
                zap.Error(err))
            http.Error(w, "Internal server error", http.StatusInternalServerError)
        }
        return
    }
    // ...
}
```

### When Sentinel Errors Are NOT Appropriate

Sentinel errors are the wrong tool when:
- The error contains data (use typed errors instead)
- The failure has many variants (use error categories/types)
- The error is an internal implementation detail that should not leak

## Error Wrapping with fmt.Errorf

### Adding Context to Errors

Use `%w` verb to wrap errors, preserving the original for `errors.Is` and `errors.As`:

```go
package user

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
)

func (r *postgresRepository) GetByID(ctx context.Context, id int64) (*User, error) {
    query := `SELECT id, email, name, created_at FROM users WHERE id = $1`

    var u User
    err := r.db.QueryRowContext(ctx, query, id).Scan(
        &u.ID, &u.Email, &u.Name, &u.CreatedAt,
    )

    if errors.Is(err, sql.ErrNoRows) {
        // Translate database-specific error to domain error.
        // The caller sees ErrNotFound; the database layer is hidden.
        return nil, fmt.Errorf("getting user id=%d: %w", id, ErrNotFound)
    }
    if err != nil {
        // Unexpected database error — wrap with context but preserve original
        return nil, fmt.Errorf("querying user id=%d: %w", id, err)
    }

    return &u, nil
}
```

### The Wrapping Convention

Use the pattern `"<what operation>: %w"` to build readable error chains:

```go
// Entry point for a create user request
func (s *Service) CreateUser(ctx context.Context, req *CreateUserRequest) (*User, error) {
    if err := validateEmail(req.Email); err != nil {
        return nil, fmt.Errorf("creating user: validating email: %w", err)
    }

    existing, err := s.repo.GetByEmail(ctx, req.Email)
    if err != nil && !errors.Is(err, ErrNotFound) {
        return nil, fmt.Errorf("creating user: checking for duplicate email: %w", err)
    }
    if existing != nil {
        return nil, fmt.Errorf("creating user: %w", ErrEmailTaken)
    }

    user, err := s.repo.Create(ctx, req)
    if err != nil {
        return nil, fmt.Errorf("creating user: persisting to database: %w", err)
    }

    return user, nil
}
```

When this error reaches the HTTP handler and is logged:

```
creating user: persisting to database: querying database: pq: duplicate key value violates unique constraint "users_email_key"
```

Every level of context is present. `errors.Is(err, ErrEmailTaken)` still works correctly.

### Avoiding Over-Wrapping

Wrap errors at significant boundaries, not at every function call:

```go
// BAD: Redundant wrapping at every level
func level3() error { return fmt.Errorf("level3: %w", err) }
func level2() error {
    err := level3()
    return fmt.Errorf("level2: %w", err)
}
func level1() error {
    err := level2()
    return fmt.Errorf("level1: %w", err)  // Noise
}
```

```go
// GOOD: Wrap at architectural boundaries (repository → service → handler)
// Internal helper functions return errors directly without adding context
func (r *repo) scanUser(rows *sql.Rows) (*User, error) {
    var u User
    if err := rows.Scan(&u.ID, &u.Name); err != nil {
        return nil, err  // No wrap — caller adds context
    }
    return &u, nil
}

func (r *repo) GetByID(ctx context.Context, id int64) (*User, error) {
    rows, err := r.db.QueryContext(ctx, query, id)
    if err != nil {
        return nil, fmt.Errorf("querying user id=%d: %w", id, err)  // Context added here
    }
    defer rows.Close()

    if !rows.Next() {
        return nil, fmt.Errorf("getting user id=%d: %w", id, ErrNotFound)
    }

    return r.scanUser(rows)  // scanUser errors get wrapped by this function
}
```

## Structured Error Types

When an error needs to carry data beyond a message, define a type that implements the `error` interface.

### Validation Error Type

```go
package validation

import (
    "fmt"
    "strings"
)

// FieldError represents a validation failure for a specific field.
type FieldError struct {
    Field   string
    Message string
    Value   interface{} // The value that failed validation
}

func (e *FieldError) Error() string {
    return fmt.Sprintf("field %q: %s (got: %v)", e.Field, e.Message, e.Value)
}

// ValidationErrors is a collection of field-level validation failures.
type ValidationErrors []*FieldError

func (ve ValidationErrors) Error() string {
    if len(ve) == 0 {
        return "validation failed"
    }
    msgs := make([]string, len(ve))
    for i, e := range ve {
        msgs[i] = e.Error()
    }
    return "validation failed: " + strings.Join(msgs, "; ")
}

// Add appends a field error.
func (ve *ValidationErrors) Add(field, message string, value interface{}) {
    *ve = append(*ve, &FieldError{Field: field, Message: message, Value: value})
}

// HasErrors reports whether any validation errors were collected.
func (ve ValidationErrors) HasErrors() bool {
    return len(ve) > 0
}

// Usage:
func validateCreateUserRequest(req *CreateUserRequest) error {
    var errs validation.ValidationErrors

    if req.Email == "" {
        errs.Add("email", "is required", req.Email)
    } else if !emailRegex.MatchString(req.Email) {
        errs.Add("email", "is not a valid email address", req.Email)
    }

    if req.Name == "" {
        errs.Add("name", "is required", req.Name)
    } else if len(req.Name) < 2 {
        errs.Add("name", "must be at least 2 characters", req.Name)
    }

    if req.Age < 0 || req.Age > 150 {
        errs.Add("age", "must be between 0 and 150", req.Age)
    }

    if errs.HasErrors() {
        return errs
    }
    return nil
}
```

### HTTP Error Type

```go
package apierr

import (
    "fmt"
    "net/http"
)

// APIError carries both a user-facing message and an HTTP status code.
type APIError struct {
    Status  int
    Code    string // Machine-readable error code for client handling
    Message string // Human-readable message (safe to expose to users)
    Cause   error  // Internal cause (logged, never exposed to users)
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

// Constructors for common HTTP error types
func NotFound(code, message string) *APIError {
    return &APIError{Status: http.StatusNotFound, Code: code, Message: message}
}

func BadRequest(code, message string, cause error) *APIError {
    return &APIError{Status: http.StatusBadRequest, Code: code, Message: message, Cause: cause}
}

func InternalError(cause error) *APIError {
    return &APIError{
        Status:  http.StatusInternalServerError,
        Code:    "INTERNAL_ERROR",
        Message: "An unexpected error occurred",
        Cause:   cause,
    }
}

func Forbidden(code, message string) *APIError {
    return &APIError{Status: http.StatusForbidden, Code: code, Message: message}
}

func Conflict(code, message string) *APIError {
    return &APIError{Status: http.StatusConflict, Code: code, Message: message}
}
```

### errors.As for Typed Error Inspection

```go
// errors.As traverses the wrapping chain to find a value of the specified type.
func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
    var req CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, apierr.BadRequest("INVALID_JSON", "Request body is not valid JSON", err))
        return
    }

    user, err := h.service.CreateUser(r.Context(), &req)
    if err != nil {
        // Check for validation errors
        var validationErrs validation.ValidationErrors
        if errors.As(err, &validationErrs) {
            // Build a detailed validation error response
            respondValidationError(w, validationErrs)
            return
        }

        // Check for domain errors
        if errors.Is(err, user.ErrEmailTaken) {
            respondError(w, apierr.Conflict("EMAIL_TAKEN", "Email address already registered"))
            return
        }

        // Log unexpected errors with full context
        h.logger.Error("unexpected error creating user",
            zap.String("email", req.Email),
            zap.Error(err))

        respondError(w, apierr.InternalError(err))
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(user)
}
```

## HTTP Error Response Patterns

### Consistent Error Response Structure

```go
package handler

import (
    "encoding/json"
    "net/http"

    "github.com/example/app/apierr"
    "github.com/example/app/validation"
    "go.uber.org/zap"
)

// ErrorResponse is the JSON structure returned for all API errors.
type ErrorResponse struct {
    Code    string            `json:"code"`
    Message string            `json:"message"`
    Fields  map[string]string `json:"fields,omitempty"` // For validation errors
    TraceID string            `json:"trace_id,omitempty"`
}

// respondError writes a structured error response.
func respondError(w http.ResponseWriter, err *apierr.APIError) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(err.Status)
    json.NewEncoder(w).Encode(ErrorResponse{
        Code:    err.Code,
        Message: err.Message,
    })
}

// respondValidationError writes a field-level validation error response.
func respondValidationError(w http.ResponseWriter, errs validation.ValidationErrors) {
    fields := make(map[string]string, len(errs))
    for _, e := range errs {
        fields[e.Field] = e.Message
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusUnprocessableEntity)
    json.NewEncoder(w).Encode(ErrorResponse{
        Code:    "VALIDATION_FAILED",
        Message: "The request contains invalid field values",
        Fields:  fields,
    })
}
```

### Centralized Error Translation Middleware

```go
// ErrorTranslator middleware catches panics and provides a centralized
// error response for unhandled errors.
func ErrorTranslator(logger *zap.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Panic recovery
            defer func() {
                if rec := recover(); rec != nil {
                    logger.Error("panic recovered",
                        zap.Any("panic", rec),
                        zap.String("path", r.URL.Path),
                        zap.String("method", r.Method),
                    )
                    w.Header().Set("Content-Type", "application/json")
                    w.WriteHeader(http.StatusInternalServerError)
                    json.NewEncoder(w).Encode(ErrorResponse{
                        Code:    "INTERNAL_ERROR",
                        Message: "An unexpected error occurred",
                    })
                }
            }()
            next.ServeHTTP(w, r)
        })
    }
}
```

## Error Logging Strategies

### What to Log at Each Level

```go
// Repository layer: log with full technical context
func (r *repo) GetByID(ctx context.Context, id int64) (*User, error) {
    user, err := r.queryUserByID(ctx, id)
    if err != nil {
        if !errors.Is(err, ErrNotFound) {
            // Log unexpected database errors at the repository layer
            r.logger.Error("database query failed",
                zap.Int64("user_id", id),
                zap.String("query", "GetByID"),
                zap.Error(err),
            )
        }
        return nil, fmt.Errorf("getting user id=%d: %w", id, err)
    }
    return user, nil
}

// Service layer: log business-logic failures
func (s *Service) CreateUser(ctx context.Context, req *CreateUserRequest) (*User, error) {
    user, err := s.repo.Create(ctx, req)
    if err != nil {
        // Already logged at repo layer if it's a database error
        // Log at service layer for business context
        s.logger.Warn("user creation failed",
            zap.String("email", req.Email),
            zap.Error(err),
        )
        return nil, fmt.Errorf("creating user: %w", err)
    }
    return user, nil
}

// Handler layer: log only unexpected errors
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.service.CreateUser(r.Context(), req)
    if err != nil {
        var apiErr *apierr.APIError
        if errors.As(err, &apiErr) && apiErr.Status < 500 {
            // Client errors (4xx): expected, do not log
            respondError(w, apiErr)
            return
        }
        // Server errors (5xx): unexpected, log with full context
        h.logger.Error("unhandled service error",
            zap.String("endpoint", "POST /users"),
            zap.String("request_id", requestIDFromContext(r.Context())),
            zap.Error(err),
        )
        respondError(w, apierr.InternalError(err))
    }
}
```

### Structured Error Logging with zap

```go
// Include error in structured log fields
logger.Error("payment processing failed",
    zap.String("payment_id", payment.ID),
    zap.String("customer_id", payment.CustomerID),
    zap.Int64("amount", payment.Amount),
    zap.String("currency", payment.Currency),
    zap.String("error_type", fmt.Sprintf("%T", errors.Unwrap(err))),
    zap.Error(err),
)

// Log error chains for debugging
func logErrorChain(logger *zap.Logger, err error) {
    type withStack interface {
        StackTrace() []uintptr
    }

    // Log each wrapped error in the chain
    current := err
    depth := 0
    for current != nil {
        logger.Debug("error chain",
            zap.Int("depth", depth),
            zap.String("type", fmt.Sprintf("%T", current)),
            zap.String("message", current.Error()),
        )
        current = errors.Unwrap(current)
        depth++
    }
}
```

## Error Handling in Concurrent Code

### Collecting Errors from Goroutines

```go
package concurrent

import (
    "context"
    "fmt"
    "sync"
)

// MultiError aggregates errors from multiple concurrent operations.
type MultiError struct {
    mu   sync.Mutex
    errs []error
}

func (m *MultiError) Add(err error) {
    if err == nil {
        return
    }
    m.mu.Lock()
    m.errs = append(m.errs, err)
    m.mu.Unlock()
}

func (m *MultiError) Err() error {
    m.mu.Lock()
    defer m.mu.Unlock()
    if len(m.errs) == 0 {
        return nil
    }
    return m
}

func (m *MultiError) Error() string {
    m.mu.Lock()
    defer m.mu.Unlock()
    msgs := make([]string, len(m.errs))
    for i, err := range m.errs {
        msgs[i] = fmt.Sprintf("[%d] %v", i, err)
    }
    return fmt.Sprintf("%d errors occurred: %s", len(m.errs), strings.Join(msgs, "; "))
}

// ProcessBatch processes items concurrently, collecting all errors.
func ProcessBatch(ctx context.Context, items []Item, processor Processor) error {
    var (
        wg       sync.WaitGroup
        multiErr MultiError
        sem      = make(chan struct{}, 10) // Limit to 10 concurrent goroutines
    )

    for i, item := range items {
        wg.Add(1)
        go func(idx int, item Item) {
            defer wg.Done()

            sem <- struct{}{}
            defer func() { <-sem }()

            if err := processor.Process(ctx, item); err != nil {
                multiErr.Add(fmt.Errorf("item %d (id=%s): %w", idx, item.ID, err))
            }
        }(i, item)
    }

    wg.Wait()
    return multiErr.Err()
}
```

### errgroup for Structured Concurrent Error Handling

```go
import "golang.org/x/sync/errgroup"

// FetchUserWithRelations fetches a user and their related data concurrently.
// If any fetch fails, all are cancelled and the error is returned.
func FetchUserWithRelations(ctx context.Context, userID int64) (*UserWithRelations, error) {
    g, ctx := errgroup.WithContext(ctx)

    var user *User
    var orders []*Order
    var preferences *Preferences

    g.Go(func() error {
        var err error
        user, err = userRepo.GetByID(ctx, userID)
        if err != nil {
            return fmt.Errorf("fetching user: %w", err)
        }
        return nil
    })

    g.Go(func() error {
        var err error
        orders, err = orderRepo.ListByUser(ctx, userID)
        if err != nil {
            return fmt.Errorf("fetching orders: %w", err)
        }
        return nil
    })

    g.Go(func() error {
        var err error
        preferences, err = prefRepo.GetByUser(ctx, userID)
        if err != nil {
            if errors.Is(err, ErrNotFound) {
                preferences = DefaultPreferences()  // Non-fatal: use defaults
                return nil
            }
            return fmt.Errorf("fetching preferences: %w", err)
        }
        return nil
    })

    if err := g.Wait(); err != nil {
        return nil, fmt.Errorf("fetching user with relations (id=%d): %w", userID, err)
    }

    return &UserWithRelations{
        User:        user,
        Orders:      orders,
        Preferences: preferences,
    }, nil
}
```

## Testing Error Handling

### Testing that Errors Wrap Correctly

```go
func TestGetUser_NotFound_WrapsCorrectly(t *testing.T) {
    repo := &postgresRepository{db: testDB}

    _, err := repo.GetByID(context.Background(), 999999)
    if err == nil {
        t.Fatal("expected error for non-existent user")
    }

    // Verify the error wraps ErrNotFound
    if !errors.Is(err, ErrNotFound) {
        t.Errorf("expected error to wrap ErrNotFound, got: %T: %v", err, err)
    }

    // Verify the error message contains useful context
    if !strings.Contains(err.Error(), "999999") {
        t.Errorf("expected error message to contain the user ID, got: %v", err)
    }
}

func TestCreateUser_ValidationError_ReturnsValidationErrors(t *testing.T) {
    svc := newTestService(t)

    _, err := svc.CreateUser(context.Background(), &CreateUserRequest{
        Email: "not-an-email",
        Name:  "",
    })
    if err == nil {
        t.Fatal("expected validation error")
    }

    var validationErrs validation.ValidationErrors
    if !errors.As(err, &validationErrs) {
        t.Fatalf("expected ValidationErrors, got %T: %v", err, err)
    }

    fieldMap := make(map[string]string)
    for _, fe := range validationErrs {
        fieldMap[fe.Field] = fe.Message
    }

    if _, ok := fieldMap["email"]; !ok {
        t.Error("expected validation error for email field")
    }
    if _, ok := fieldMap["name"]; !ok {
        t.Error("expected validation error for name field")
    }
}
```

## Common Patterns Reference

### Error Handling Decision Tree

```
Is the error an expected failure that callers can handle?
  YES → Use sentinel error (errors.New) or typed error
  NO  → Wrap with context and propagate

Does the error carry data the caller needs?
  YES → Define a type that implements error and use errors.As
  NO  → Sentinel error with errors.Is

Is this the error's first appearance in this call stack?
  YES → Annotate with context: fmt.Errorf("doing X with param Y: %w", err)
  NO  → Propagate as-is (context already added)

Is this an HTTP handler receiving an error?
  Is it a client error (validation, not found, conflict)?
    YES → Return 4xx, do not log
    NO  → Return 500, log with full context
```

### Standard Library Error Patterns

```go
// errors.New: Simple sentinel errors
var ErrEmpty = errors.New("buffer is empty")

// fmt.Errorf with %w: Wrapping
return fmt.Errorf("reading config file %s: %w", path, err)

// errors.Is: Check for specific error (works through chains)
if errors.Is(err, ErrNotFound) { ... }

// errors.As: Extract typed error from chain
var pathErr *fs.PathError
if errors.As(err, &pathErr) {
    fmt.Println("path:", pathErr.Path)
}

// errors.Unwrap: Get the directly wrapped error
cause := errors.Unwrap(err)

// errors.Join (Go 1.20+): Multiple errors as one
err := errors.Join(err1, err2, err3)
```

## Summary

Production-quality Go error handling rests on three principles: errors carry context about what went wrong and where; callers can distinguish between error types without string matching; and internal implementation details do not leak through public interfaces.

Sentinel errors with `errors.Is` handle expected, named failure conditions. Typed errors with `errors.As` carry structured data that callers need to make decisions. The `%w` wrapping verb builds error chains that preserve root causes while adding layer-appropriate context. HTTP handlers translate domain errors to appropriate status codes without logging expected failures.

The investment in clear error types and wrapping conventions pays dividends during incident response: a logged error chain that reads `"processing payment id=pay-123: charging card: stripe API: rate limit exceeded"` is self-explanatory. An error that reads `"too many requests"` is not.
