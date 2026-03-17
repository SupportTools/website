---
title: "Go Error Wrapping and Structured Errors: fmt.Errorf, errors.Is/As, and Custom Error Types in Production APIs"
date: 2028-07-19T00:00:00-05:00
draft: false
tags: ["Go", "Error Handling", "Error Wrapping", "Production", "API"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Go error handling covering fmt.Errorf %w wrapping, errors.Is and errors.As matching, custom sentinel errors, structured error types, HTTP API error responses, and observability patterns for error classification."
more_link: "yes"
url: "/go-error-wrapping-structured-errors-guide/"
---

Go's error model is deliberately minimal: errors are values, and the interface requires only an `Error() string` method. That simplicity is both the model's greatest strength and the source of most production bugs in Go codebases. Getting error handling right — using wrapping, custom types, and structured classification — is what separates a maintainable production service from a debugging nightmare where `"connection refused"` traces back to nothing useful.

<!--more-->

# Go Error Wrapping and Structured Errors: fmt.Errorf, errors.Is/As, and Custom Error Types in Production APIs

## Section 1: Error Wrapping Fundamentals

### The %w Verb and errors.Is / errors.As

Go 1.13 introduced standard error wrapping. Understanding the mechanics is essential before building production patterns:

```go
package main

import (
	"errors"
	"fmt"
)

// Sentinel errors — package-level error values for comparison
var (
	ErrNotFound     = errors.New("not found")
	ErrUnauthorized = errors.New("unauthorized")
	ErrConflict     = errors.New("conflict")
)

func getUser(id string) error {
	if id == "" {
		return fmt.Errorf("getUser: %w", ErrNotFound)
	}
	return nil
}

func processUser(id string) error {
	if err := getUser(id); err != nil {
		// Wrap with context — the %w verb preserves the error chain
		return fmt.Errorf("processUser %q: %w", id, err)
	}
	return nil
}

func handleRequest(id string) error {
	if err := processUser(id); err != nil {
		return fmt.Errorf("handleRequest: %w", err)
	}
	return nil
}

func main() {
	err := handleRequest("")

	// errors.Is traverses the entire error chain
	fmt.Println(errors.Is(err, ErrNotFound))   // true

	// The full message still shows the context chain
	fmt.Println(err)
	// handleRequest: processUser "": getUser: not found

	// vs. errors.New — no wrapping
	err2 := fmt.Errorf("getUser: %s", ErrNotFound.Error()) // %s not %w
	fmt.Println(errors.Is(err2, ErrNotFound))   // false — chain broken
}
```

### errors.As — Type Matching Through the Chain

```go
package database

import (
	"database/sql"
	"errors"
	"fmt"
)

// DBError carries structured information about a database error
type DBError struct {
	Op      string // Operation that failed (SELECT, INSERT, etc.)
	Table   string // Target table
	Code    int    // Database error code
	Err     error  // Underlying error
}

func (e *DBError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("db %s on %s (code %d): %v", e.Op, e.Table, e.Code, e.Err)
	}
	return fmt.Sprintf("db %s on %s (code %d)", e.Op, e.Table, e.Code)
}

// Unwrap implements errors.Unwrap — required for errors.Is/As to traverse chain
func (e *DBError) Unwrap() error {
	return e.Err
}

func QueryUser(id string) (*User, error) {
	_, err := db.Query("SELECT * FROM users WHERE id = $1", id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, &DBError{Op: "SELECT", Table: "users", Code: 404, Err: ErrNotFound}
		}
		return nil, &DBError{Op: "SELECT", Table: "users", Code: 500, Err: err}
	}
	return &User{}, nil
}

// Caller code — extracting specific error information
func handleUserRequest(id string) {
	_, err := QueryUser(id)
	if err == nil {
		return
	}

	// Match sentinel
	if errors.Is(err, ErrNotFound) {
		// Handle not found
		return
	}

	// Extract typed error for structured handling
	var dbErr *DBError
	if errors.As(err, &dbErr) {
		// Now we have access to dbErr.Op, dbErr.Table, dbErr.Code
		fmt.Printf("Database error: op=%s table=%s code=%d\n",
			dbErr.Op, dbErr.Table, dbErr.Code)
	}
}
```

---

## Section 2: Sentinel Errors and Error Hierarchy

### Domain Error Packages

```go
// errors/errors.go — package-level error definitions
package apperrors

import "errors"

// Sentinel errors for each domain error category
var (
	// Resource errors
	ErrNotFound    = errors.New("not found")
	ErrAlreadyExists = errors.New("already exists")

	// Auth errors
	ErrUnauthorized  = errors.New("unauthorized")
	ErrForbidden     = errors.New("forbidden")
	ErrTokenExpired  = errors.New("token expired")

	// Input errors
	ErrInvalidInput  = errors.New("invalid input")
	ErrMissingField  = errors.New("missing required field")

	// System errors
	ErrInternal      = errors.New("internal error")
	ErrTimeout       = errors.New("timeout")
	ErrUnavailable   = errors.New("service unavailable")

	// Business logic errors
	ErrInsufficientBalance = errors.New("insufficient balance")
	ErrLimitExceeded       = errors.New("rate limit exceeded")
)

// HTTPStatus maps sentinel errors to HTTP status codes
func HTTPStatus(err error) int {
	switch {
	case errors.Is(err, ErrNotFound):
		return 404
	case errors.Is(err, ErrUnauthorized), errors.Is(err, ErrTokenExpired):
		return 401
	case errors.Is(err, ErrForbidden):
		return 403
	case errors.Is(err, ErrAlreadyExists), errors.Is(err, ErrConflict):
		return 409
	case errors.Is(err, ErrInvalidInput), errors.Is(err, ErrMissingField):
		return 400
	case errors.Is(err, ErrTimeout):
		return 408
	case errors.Is(err, ErrUnavailable):
		return 503
	case errors.Is(err, ErrLimitExceeded):
		return 429
	default:
		return 500
	}
}

// IsClientError returns true for errors caused by caller behavior (4xx)
func IsClientError(err error) bool {
	status := HTTPStatus(err)
	return status >= 400 && status < 500
}

// IsRetryable returns true for transient errors worth retrying
func IsRetryable(err error) bool {
	return errors.Is(err, ErrTimeout) ||
		errors.Is(err, ErrUnavailable) ||
		errors.Is(err, ErrInternal)
}
```

### Validation Error with Multiple Fields

```go
// errors/validation.go
package apperrors

import (
	"errors"
	"fmt"
	"strings"
)

// FieldError represents a validation failure for a specific field
type FieldError struct {
	Field   string
	Message string
}

func (e FieldError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// ValidationError accumulates multiple field errors
type ValidationError struct {
	Fields []FieldError
}

func (e *ValidationError) Error() string {
	if len(e.Fields) == 1 {
		return fmt.Sprintf("validation error: %s", e.Fields[0])
	}
	msgs := make([]string, len(e.Fields))
	for i, f := range e.Fields {
		msgs[i] = f.Error()
	}
	return fmt.Sprintf("validation errors: %s", strings.Join(msgs, "; "))
}

// Unwrap returns ErrInvalidInput so errors.Is(err, ErrInvalidInput) works
func (e *ValidationError) Unwrap() error {
	return ErrInvalidInput
}

// Validate runs validation functions and collects all errors
func Validate(validators ...func() *FieldError) error {
	ve := &ValidationError{}
	for _, v := range validators {
		if fe := v(); fe != nil {
			ve.Fields = append(ve.Fields, *fe)
		}
	}
	if len(ve.Fields) > 0 {
		return ve
	}
	return nil
}

// Usage example
func validateCreateUser(req CreateUserRequest) error {
	return Validate(
		func() *FieldError {
			if req.Email == "" {
				return &FieldError{Field: "email", Message: "required"}
			}
			if !strings.Contains(req.Email, "@") {
				return &FieldError{Field: "email", Message: "invalid format"}
			}
			return nil
		},
		func() *FieldError {
			if len(req.Password) < 8 {
				return &FieldError{Field: "password", Message: "minimum 8 characters"}
			}
			return nil
		},
		func() *FieldError {
			if req.Name == "" {
				return &FieldError{Field: "name", Message: "required"}
			}
			return nil
		},
	)
}
```

---

## Section 3: Custom Error Types for Domain Logic

### Rich Error Type with Context

```go
// errors/domain.go
package apperrors

import (
	"errors"
	"fmt"
	"time"
)

// AppError is the standard structured error for the application
type AppError struct {
	// Classification
	Kind    string // "validation", "database", "auth", "external", "internal"
	Code    string // Machine-readable code: "USER_NOT_FOUND", "INVALID_TOKEN"
	Message string // Human-readable message (safe to expose to clients)

	// Context
	Op        string            // Operation: "UserService.GetUser"
	RequestID string            // For log correlation
	UserID    string            // If user context is available
	Meta      map[string]string // Additional context

	// Internal
	Timestamp time.Time
	Err       error  // Wrapped underlying error
	Stack     string // Stack trace (only in development)
}

func (e *AppError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("[%s] %s: %s: %v", e.Kind, e.Code, e.Op, e.Err)
	}
	return fmt.Sprintf("[%s] %s: %s: %s", e.Kind, e.Code, e.Op, e.Message)
}

func (e *AppError) Unwrap() error {
	return e.Err
}

// Is makes AppError comparable by Code for errors.Is
func (e *AppError) Is(target error) bool {
	var t *AppError
	if errors.As(target, &t) {
		return e.Code == t.Code
	}
	return false
}

// Constructor helpers
func NotFound(op, resource, id string) *AppError {
	return &AppError{
		Kind:      "not_found",
		Code:      "RESOURCE_NOT_FOUND",
		Message:   fmt.Sprintf("%s with id %s not found", resource, id),
		Op:        op,
		Timestamp: time.Now(),
		Err:       ErrNotFound,
	}
}

func Unauthorized(op, reason string) *AppError {
	return &AppError{
		Kind:      "auth",
		Code:      "UNAUTHORIZED",
		Message:   reason,
		Op:        op,
		Timestamp: time.Now(),
		Err:       ErrUnauthorized,
	}
}

func Internal(op string, err error) *AppError {
	return &AppError{
		Kind:      "internal",
		Code:      "INTERNAL_ERROR",
		Message:   "An internal error occurred",
		Op:        op,
		Timestamp: time.Now(),
		Err:       err,
	}
}

func ValidationFailed(op string, ve *ValidationError) *AppError {
	return &AppError{
		Kind:      "validation",
		Code:      "VALIDATION_FAILED",
		Message:   ve.Error(),
		Op:        op,
		Timestamp: time.Now(),
		Err:       ve,
	}
}

// WithRequestID adds request correlation to an error
func WithRequestID(err *AppError, requestID string) *AppError {
	err.RequestID = requestID
	return err
}

// WithMeta adds key-value context
func WithMeta(err *AppError, key, value string) *AppError {
	if err.Meta == nil {
		err.Meta = make(map[string]string)
	}
	err.Meta[key] = value
	return err
}
```

---

## Section 4: HTTP API Error Responses

### Structured JSON Error Response

```go
// api/errors.go
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"your-org/your-app/apperrors"
)

// APIError is the JSON error response sent to API clients
type APIError struct {
	// Standard fields
	Status    int         `json:"status"`
	Code      string      `json:"code"`
	Message   string      `json:"message"`
	RequestID string      `json:"requestId,omitempty"`

	// Validation errors
	Details   interface{} `json:"details,omitempty"`
}

// WriteError writes a structured JSON error response
func WriteError(w http.ResponseWriter, r *http.Request, err error, logger *slog.Logger) {
	requestID := r.Header.Get("X-Request-ID")

	var appErr *apperrors.AppError
	var validErr *apperrors.ValidationError

	var response APIError
	var statusCode int

	switch {
	case errors.As(err, &appErr):
		statusCode = appErr.HTTPStatus()
		response = APIError{
			Status:    statusCode,
			Code:      appErr.Code,
			Message:   appErr.Message, // Safe for clients
			RequestID: requestID,
		}

		// Include field errors for validation failures
		if errors.As(err, &validErr) {
			response.Details = validErr.Fields
		}

		// Log internal errors with full detail; client errors at debug level
		if statusCode >= 500 {
			logger.Error("Internal API error",
				"request_id", requestID,
				"op", appErr.Op,
				"code", appErr.Code,
				"error", appErr.Err,
				"method", r.Method,
				"path", r.URL.Path,
			)
		} else {
			logger.Debug("Client error",
				"request_id", requestID,
				"op", appErr.Op,
				"code", appErr.Code,
				"status", statusCode,
			)
		}

	default:
		// Unknown error — treat as internal
		statusCode = 500
		response = APIError{
			Status:    500,
			Code:      "INTERNAL_ERROR",
			Message:   "An unexpected error occurred",
			RequestID: requestID,
		}
		logger.Error("Unhandled API error",
			"request_id", requestID,
			"error", err,
			"method", r.Method,
			"path", r.URL.Path,
		)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(response)
}

// HTTPStatus returns the appropriate HTTP status code for an AppError
func (e *AppError) HTTPStatus() int {
	return apperrors.HTTPStatus(e)
}
```

### Middleware for Request ID and Error Logging

```go
// middleware/errors.go
package middleware

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
)

type contextKey string

const RequestIDKey contextKey = "requestID"

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = uuid.New().String()
		}
		w.Header().Set("X-Request-ID", id)
		ctx := context.WithValue(r.Context(), RequestIDKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func GetRequestID(ctx context.Context) string {
	if id, ok := ctx.Value(RequestIDKey).(string); ok {
		return id
	}
	return ""
}

// PanicRecovery recovers from panics and converts them to 500 errors
func PanicRecovery(logger *slog.Logger) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					requestID := GetRequestID(r.Context())
					logger.Error("Panic recovered",
						"request_id", requestID,
						"panic", rec,
						"method", r.Method,
						"path", r.URL.Path,
					)
					http.Error(w, `{"code":"INTERNAL_ERROR","message":"Internal server error"}`, 500)
					w.Header().Set("Content-Type", "application/json")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
```

---

## Section 5: Error Handling in Service Layers

### Repository Layer

```go
// repository/user_repository.go
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/lib/pq"
	"your-org/your-app/apperrors"
)

const op = "UserRepository"

type UserRepository struct {
	db *sql.DB
}

func (r *UserRepository) GetByID(ctx context.Context, id string) (*User, error) {
	const opName = op + ".GetByID"

	var user User
	err := r.db.QueryRowContext(ctx,
		`SELECT id, email, name, created_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
		id,
	).Scan(&user.ID, &user.Email, &user.Name, &user.CreatedAt)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, apperrors.NotFound(opName, "user", id)
		}
		return nil, apperrors.Internal(opName, fmt.Errorf("query: %w", err))
	}

	return &user, nil
}

func (r *UserRepository) Create(ctx context.Context, user *User) error {
	const opName = op + ".Create"

	_, err := r.db.ExecContext(ctx,
		`INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, NOW())`,
		user.ID, user.Email, user.Name,
	)
	if err != nil {
		// Check for unique constraint violation
		var pqErr *pq.Error
		if errors.As(err, &pqErr) {
			if pqErr.Code == "23505" { // unique_violation
				return &apperrors.AppError{
					Kind:    "conflict",
					Code:    "EMAIL_ALREADY_EXISTS",
					Message: fmt.Sprintf("email %s is already registered", user.Email),
					Op:      opName,
					Err:     apperrors.ErrAlreadyExists,
				}
			}
		}
		return apperrors.Internal(opName, fmt.Errorf("insert: %w", err))
	}
	return nil
}

func (r *UserRepository) Update(ctx context.Context, user *User, version int) error {
	const opName = op + ".Update"

	result, err := r.db.ExecContext(ctx,
		`UPDATE users SET name = $1, version = version + 1 WHERE id = $2 AND version = $3`,
		user.Name, user.ID, version,
	)
	if err != nil {
		return apperrors.Internal(opName, fmt.Errorf("update: %w", err))
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return apperrors.Internal(opName, fmt.Errorf("rows affected: %w", err))
	}

	if rows == 0 {
		// Either not found or version conflict
		_, getErr := r.GetByID(ctx, user.ID)
		if getErr != nil {
			return getErr // Not found
		}
		// User exists but version mismatch = optimistic lock failure
		return &apperrors.AppError{
			Kind:    "conflict",
			Code:    "OPTIMISTIC_LOCK_FAILURE",
			Message: "The record was modified by another request. Please retry.",
			Op:      opName,
			Err:     apperrors.ErrConflict,
		}
	}
	return nil
}
```

### Service Layer

```go
// service/user_service.go
package service

import (
	"context"
	"errors"
	"fmt"

	"your-org/your-app/apperrors"
	"your-org/your-app/repository"
)

type UserService struct {
	repo  *repository.UserRepository
	email EmailSender
	audit AuditLogger
}

func (s *UserService) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
	const opName = "UserService.CreateUser"

	// Validate input
	if err := validateCreateUser(req); err != nil {
		var ve *apperrors.ValidationError
		if errors.As(err, &ve) {
			return nil, apperrors.ValidationFailed(opName, ve)
		}
		return nil, fmt.Errorf("%s: validation: %w", opName, err)
	}

	// Create user
	user := &repository.User{
		ID:    newID(),
		Email: req.Email,
		Name:  req.Name,
	}

	if err := s.repo.Create(ctx, user); err != nil {
		// Enrich with service context without re-wrapping AppError
		var appErr *apperrors.AppError
		if errors.As(err, &appErr) {
			return nil, err // Pass through AppError as-is
		}
		return nil, fmt.Errorf("%s: %w", opName, err)
	}

	// Send welcome email — don't fail user creation if email fails
	if err := s.email.SendWelcome(ctx, user.Email, user.Name); err != nil {
		// Log but don't propagate — non-critical operation
		// Use structured logging with error context
		logFromContext(ctx).Warn("Failed to send welcome email",
			"user_id", user.ID,
			"email", user.Email,
			"error", err,
		)
	}

	// Audit log — this IS critical, propagate failure
	if err := s.audit.LogCreate(ctx, "user", user.ID, req); err != nil {
		// Compensate: rollback user creation
		_ = s.repo.Delete(ctx, user.ID) // Best-effort cleanup
		return nil, fmt.Errorf("%s: audit log failed: %w", opName, err)
	}

	return toServiceUser(user), nil
}

func (s *UserService) GetUser(ctx context.Context, requestingUserID, targetUserID string) (*User, error) {
	const opName = "UserService.GetUser"

	// Authorization check
	if requestingUserID != targetUserID {
		// Check if admin
		isAdmin, err := s.isAdmin(ctx, requestingUserID)
		if err != nil {
			return nil, fmt.Errorf("%s: checking admin status: %w", opName, err)
		}
		if !isAdmin {
			return nil, apperrors.Unauthorized(opName, "access denied to other user's data")
		}
	}

	user, err := s.repo.GetByID(ctx, targetUserID)
	if err != nil {
		return nil, err // Already an AppError from repo layer
	}

	return toServiceUser(user), nil
}
```

---

## Section 6: Error Handling in Concurrent Code

```go
// concurrent/errors.go
package concurrent

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// MultiError collects errors from concurrent operations
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

func (m *MultiError) Error() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.errs) == 0 {
		return ""
	}
	if len(m.errs) == 1 {
		return m.errs[0].Error()
	}
	return fmt.Sprintf("%d errors occurred: [%v]", len(m.errs), m.errs)
}

func (m *MultiError) Unwrap() []error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.errs
}

func (m *MultiError) HasErrors() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.errs) > 0
}

// errors.Join is available in Go 1.20+ and supports multiple wraps
func (m *MultiError) AsError() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.errs) == 0 {
		return nil
	}
	return errors.Join(m.errs...)
}

// ParallelExecute runs tasks concurrently and returns all errors
func ParallelExecute(ctx context.Context, tasks []func(ctx context.Context) error) error {
	var (
		wg      sync.WaitGroup
		multiErr MultiError
	)

	for _, task := range tasks {
		wg.Add(1)
		go func(t func(ctx context.Context) error) {
			defer wg.Done()
			if err := t(ctx); err != nil {
				multiErr.Add(err)
			}
		}(task)
	}

	wg.Wait()
	return multiErr.AsError()
}

// FirstError returns as soon as the first error occurs (fail-fast)
func FirstError(ctx context.Context, tasks []func(ctx context.Context) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	errCh := make(chan error, len(tasks))
	var wg sync.WaitGroup

	for _, task := range tasks {
		wg.Add(1)
		go func(t func(ctx context.Context) error) {
			defer wg.Done()
			if err := t(ctx); err != nil {
				select {
				case errCh <- err:
					cancel() // Signal other goroutines to stop
				default:
				}
			}
		}(task)
	}

	// Close errCh when all goroutines finish
	go func() {
		wg.Wait()
		close(errCh)
	}()

	return <-errCh // Returns first error or nil if channel closed empty
}
```

---

## Section 7: Error Observability

### Structured Error Logging with slog

```go
// observability/error_logger.go
package observability

import (
	"context"
	"errors"
	"log/slog"

	"your-org/your-app/apperrors"
)

// LogError logs an error with full structured context
func LogError(ctx context.Context, logger *slog.Logger, msg string, err error, attrs ...slog.Attr) {
	if err == nil {
		return
	}

	args := []any{
		"error", err.Error(),
	}

	// Extract AppError fields for structured logging
	var appErr *apperrors.AppError
	if errors.As(err, &appErr) {
		args = append(args,
			"error_kind", appErr.Kind,
			"error_code", appErr.Code,
			"error_op", appErr.Op,
			"error_request_id", appErr.RequestID,
		)
		if appErr.UserID != "" {
			args = append(args, "user_id", appErr.UserID)
		}
		for k, v := range appErr.Meta {
			args = append(args, "error_meta_"+k, v)
		}
		// Log underlying error separately for root cause
		if appErr.Err != nil {
			args = append(args, "error_cause", appErr.Err.Error())
		}
	}

	// Add extra attrs
	for _, a := range attrs {
		args = append(args, a.Key, a.Value)
	}

	// Choose log level based on error type
	if apperrors.IsClientError(err) {
		logger.DebugContext(ctx, msg, args...)
	} else {
		logger.ErrorContext(ctx, msg, args...)
	}
}
```

### Prometheus Error Metrics

```go
// metrics/errors.go
package metrics

import (
	"errors"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"your-org/your-app/apperrors"
)

var (
	apiErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "api_errors_total",
			Help: "Total API errors by code, kind, and status",
		},
		[]string{"code", "kind", "status", "path"},
	)

	errorsByOp = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "app_errors_by_operation_total",
			Help: "Total errors by operation and code",
		},
		[]string{"op", "code"},
	)
)

func init() {
	prometheus.MustRegister(apiErrors, errorsByOp)
}

// RecordError increments error metrics
func RecordError(err error, path string) {
	if err == nil {
		return
	}

	status := apperrors.HTTPStatus(err)
	kind := "unknown"
	code := "UNKNOWN"
	op := "unknown"

	var appErr *apperrors.AppError
	if errors.As(err, &appErr) {
		kind = appErr.Kind
		code = appErr.Code
		op = appErr.Op
	}

	apiErrors.WithLabelValues(
		code, kind,
		http.StatusText(status),
		path,
	).Inc()

	errorsByOp.WithLabelValues(op, code).Inc()
}
```

---

## Section 8: Error Handling Patterns for External Calls

### Retry with Error Classification

```go
// retry/retry.go
package retry

import (
	"context"
	"errors"
	"math/rand"
	"time"

	"your-org/your-app/apperrors"
)

type Config struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
	Multiplier  float64
	Jitter      float64
}

var DefaultConfig = Config{
	MaxAttempts: 3,
	BaseDelay:   100 * time.Millisecond,
	MaxDelay:    10 * time.Second,
	Multiplier:  2.0,
	Jitter:      0.1,
}

// Do retries the operation according to the config, only for retryable errors
func Do(ctx context.Context, cfg Config, op func(ctx context.Context) error) error {
	var lastErr error

	for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
		if attempt > 0 {
			delay := cfg.BaseDelay
			for i := 0; i < attempt-1; i++ {
				delay = time.Duration(float64(delay) * cfg.Multiplier)
				if delay > cfg.MaxDelay {
					delay = cfg.MaxDelay
					break
				}
			}

			// Add jitter to prevent thundering herd
			jitter := time.Duration(float64(delay) * cfg.Jitter * (rand.Float64()*2 - 1))
			delay += jitter
			if delay < 0 {
				delay = 0
			}

			select {
			case <-ctx.Done():
				return fmt.Errorf("retry cancelled: %w", ctx.Err())
			case <-time.After(delay):
			}
		}

		err := op(ctx)
		if err == nil {
			return nil
		}

		lastErr = err

		// Don't retry non-retryable errors
		if !apperrors.IsRetryable(err) {
			return err
		}

		// Don't retry if context is cancelled
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
	}

	return fmt.Errorf("after %d attempts: %w", cfg.MaxAttempts, lastErr)
}
```

### Circuit Breaker with Error Counting

```go
// circuitbreaker/breaker.go
package circuitbreaker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"your-org/your-app/apperrors"
)

type State int

const (
	StateClosed   State = iota // Normal operation
	StateOpen                  // Failing — reject calls immediately
	StateHalfOpen              // Testing recovery
)

var ErrCircuitOpen = errors.New("circuit breaker is open")

type CircuitBreaker struct {
	mu sync.Mutex

	state       State
	failCount   int
	successCount int
	lastFailure time.Time

	threshold   int           // Failures before opening
	timeout     time.Duration // How long to stay open
	halfOpenMax int           // Successes needed to close
}

func New(threshold int, timeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		state:       StateClosed,
		threshold:   threshold,
		timeout:     timeout,
		halfOpenMax: 3,
	}
}

func (cb *CircuitBreaker) Execute(ctx context.Context, op func(ctx context.Context) error) error {
	cb.mu.Lock()
	state := cb.getState()
	if state == StateOpen {
		cb.mu.Unlock()
		return apperrors.Unavailable("CircuitBreaker.Execute",
			fmt.Sprintf("circuit breaker open since %v", cb.lastFailure))
	}
	cb.mu.Unlock()

	err := op(ctx)

	cb.mu.Lock()
	defer cb.mu.Unlock()

	if err != nil && apperrors.IsRetryable(err) {
		cb.failCount++
		cb.lastFailure = time.Now()

		if cb.state == StateHalfOpen || cb.failCount >= cb.threshold {
			cb.state = StateOpen
			cb.failCount = 0
		}
		return err
	}

	// Success
	if cb.state == StateHalfOpen {
		cb.successCount++
		if cb.successCount >= cb.halfOpenMax {
			cb.state = StateClosed
			cb.failCount = 0
			cb.successCount = 0
		}
	} else {
		cb.failCount = 0
	}
	return err
}

func (cb *CircuitBreaker) getState() State {
	if cb.state == StateOpen && time.Since(cb.lastFailure) > cb.timeout {
		cb.state = StateHalfOpen
		cb.successCount = 0
	}
	return cb.state
}

func apperrors_Unavailable(op, msg string) *apperrors.AppError {
	return &apperrors.AppError{
		Kind:    "unavailable",
		Code:    "SERVICE_UNAVAILABLE",
		Message: msg,
		Op:      op,
		Err:     apperrors.ErrUnavailable,
	}
}
```

---

## Section 9: Testing Error Handling

```go
// repository/user_repository_test.go
package repository_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"your-org/your-app/apperrors"
	"your-org/your-app/repository"
)

func TestGetByID_NotFound(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT .* FROM users`).
		WithArgs("nonexistent-id").
		WillReturnError(sql.ErrNoRows)

	repo := repository.NewUserRepository(db)
	_, err = repo.GetByID(context.Background(), "nonexistent-id")

	// Verify the error is wrapped correctly
	if !errors.Is(err, apperrors.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got: %v", err)
	}

	// Verify AppError fields
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatal("expected *AppError")
	}
	if appErr.Code != "RESOURCE_NOT_FOUND" {
		t.Errorf("expected RESOURCE_NOT_FOUND, got: %s", appErr.Code)
	}
}

func TestCreate_DuplicateEmail(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Simulate unique constraint violation
	mock.ExpectExec(`INSERT INTO users`).
		WillReturnError(&pq.Error{Code: "23505"})

	repo := repository.NewUserRepository(db)
	err = repo.Create(context.Background(), &repository.User{
		ID:    "test-id",
		Email: "existing@example.com",
	})

	if !errors.Is(err, apperrors.ErrAlreadyExists) {
		t.Errorf("expected ErrAlreadyExists, got: %v", err)
	}

	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatal("expected *AppError")
	}
	if appErr.Code != "EMAIL_ALREADY_EXISTS" {
		t.Errorf("expected EMAIL_ALREADY_EXISTS, got: %s", appErr.Code)
	}
}

// Test that error wrapping doesn't lose context
func TestErrorChain(t *testing.T) {
	original := errors.New("original database error")
	wrapped := fmt.Errorf("repo operation: %w", original)
	doubleWrapped := fmt.Errorf("service operation: %w", wrapped)

	if !errors.Is(doubleWrapped, original) {
		t.Error("errors.Is should find original through double wrap")
	}

	// Test unwrap depth
	depth := 0
	var e error = doubleWrapped
	for e != nil {
		depth++
		e = errors.Unwrap(e)
	}
	if depth != 3 { // doubleWrapped, wrapped, original
		t.Errorf("expected depth 3, got %d", depth)
	}
}
```

The Go error model rewards investment in consistent patterns. Sentinel errors for behavioral branching, custom types for rich context, `%w` wrapping throughout the call chain, and `errors.Is`/`errors.As` at decision points — these four practices together create error handling that is simultaneously debuggable, observable, and safe to expose through API boundaries.
