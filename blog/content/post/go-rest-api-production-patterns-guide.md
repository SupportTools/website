---
title: "Go REST API Production Patterns: Chi, Middleware, and API Versioning"
date: 2027-09-08T00:00:00-05:00
draft: false
tags: ["Go", "REST API", "Chi", "Backend"]
categories:
- Go
- Backend
author: "Matthew Mattox - mmattox@support.tools"
description: "Production patterns for Go REST APIs using Chi: middleware chains, request validation, structured error responses, API versioning, OpenAPI generation with swaggo, and graceful shutdown."
more_link: "yes"
url: "/go-rest-api-production-patterns-guide/"
---

Building a REST API in Go is straightforward; building one that survives production traffic, supports multiple API versions simultaneously, and returns machine-readable error responses across every failure mode is considerably harder. This guide covers the full production stack: Chi router composition, middleware chains for auth and observability, request validation with `go-playground/validator`, consistent error envelopes, API versioning strategies, OpenAPI spec generation, and zero-downtime graceful shutdown.

<!--more-->

## Section 1: Project Layout

A domain-driven layout separates transport concerns from business logic and makes the codebase navigable as it grows:

```text
myapi/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── api/
│   │   ├── v1/
│   │   │   ├── handler_users.go
│   │   │   └── handler_orders.go
│   │   └── v2/
│   │       └── handler_users.go
│   ├── middleware/
│   │   ├── auth.go
│   │   ├── logging.go
│   │   └── recovery.go
│   ├── model/
│   │   └── user.go
│   └── service/
│       └── user_service.go
├── docs/                  # swaggo output
└── go.mod
```

Install dependencies:

```bash
go get github.com/go-chi/chi/v5@v5.1.0
go get github.com/go-chi/chi/v5/middleware
go get github.com/go-playground/validator/v10@v10.22.0
go get github.com/swaggo/swag/cmd/swag@v1.16.3
go get github.com/swaggo/http-swagger/v2@v2.0.2
go get go.uber.org/zap@v1.27.0
```

## Section 2: Router and Middleware Chain

Chi's composable sub-routers make API versioning and middleware scoping clean:

```go
package server

import (
    "net/http"
    "time"

    "github.com/go-chi/chi/v5"
    chimw "github.com/go-chi/chi/v5/middleware"
    httpSwagger "github.com/swaggo/http-swagger/v2"
    _ "github.com/example/myapi/docs" // swaggo generated docs
    apiv1 "github.com/example/myapi/internal/api/v1"
    apiv2 "github.com/example/myapi/internal/api/v2"
    "github.com/example/myapi/internal/middleware"
)

// New builds the root router with all middleware and route groups.
func New(userSvc apiv1.UserService) http.Handler {
    r := chi.NewRouter()

    // Global middleware — applied to every request.
    r.Use(chimw.RequestID)
    r.Use(chimw.RealIP)
    r.Use(middleware.StructuredLogger)
    r.Use(middleware.Recoverer)
    r.Use(chimw.Timeout(30 * time.Second))
    r.Use(chimw.Compress(5))

    // Health and metrics endpoints bypass authentication.
    r.Get("/healthz", handleHealthz)
    r.Get("/readyz", handleReadyz)
    r.Get("/swagger/*", httpSwagger.Handler(
        httpSwagger.URL("/swagger/doc.json"),
    ))

    // Versioned API groups with their own middleware.
    r.Route("/api", func(r chi.Router) {
        r.Route("/v1", func(r chi.Router) {
            r.Use(middleware.Authenticate)
            r.Use(middleware.RateLimiter(100, time.Minute))
            apiv1.RegisterRoutes(r, userSvc)
        })
        r.Route("/v2", func(r chi.Router) {
            r.Use(middleware.Authenticate)
            r.Use(middleware.RateLimiter(200, time.Minute))
            apiv2.RegisterRoutes(r)
        })
    })

    return r
}

func handleHealthz(w http.ResponseWriter, _ *http.Request) {
    w.WriteHeader(http.StatusOK)
}

func handleReadyz(w http.ResponseWriter, _ *http.Request) {
    w.WriteHeader(http.StatusOK)
}
```

## Section 3: Structured Error Responses

Every error, regardless of origin, should return a consistent JSON envelope that API consumers can parse programmatically:

```go
package apierr

import (
    "encoding/json"
    "net/http"
)

// ErrorResponse is the canonical error envelope for all API errors.
//
// swagger:model ErrorResponse
type ErrorResponse struct {
    // HTTP status code.
    Status int `json:"status"`
    // Machine-readable error code.
    Code string `json:"code"`
    // Human-readable description.
    Message string `json:"message"`
    // Optional per-field validation details.
    Details []FieldError `json:"details,omitempty"`
    // Request ID for correlation with server logs.
    RequestID string `json:"request_id,omitempty"`
}

// FieldError describes a single validation failure.
type FieldError struct {
    Field   string `json:"field"`
    Message string `json:"message"`
}

// Write serialises the error and sets the HTTP status code.
func Write(w http.ResponseWriter, r *http.Request, status int, code, message string, details ...FieldError) {
    resp := ErrorResponse{
        Status:    status,
        Code:      code,
        Message:   message,
        Details:   details,
        RequestID: middleware.GetRequestID(r.Context()),
    }
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    _ = json.NewEncoder(w).Encode(resp)
}

// NotFound writes a 404 error.
func NotFound(w http.ResponseWriter, r *http.Request) {
    Write(w, r, http.StatusNotFound, "NOT_FOUND", "the requested resource does not exist")
}

// BadRequest writes a 400 error with optional field details.
func BadRequest(w http.ResponseWriter, r *http.Request, details ...FieldError) {
    Write(w, r, http.StatusBadRequest, "BAD_REQUEST", "request validation failed", details...)
}

// InternalServerError writes a 500 error without leaking internal details.
func InternalServerError(w http.ResponseWriter, r *http.Request) {
    Write(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "an unexpected error occurred")
}
```

## Section 4: Request Validation

`go-playground/validator` provides struct tag-based validation. Wire it once and reuse across all handlers:

```go
package validation

import (
    "encoding/json"
    "fmt"
    "net/http"
    "strings"

    "github.com/go-playground/validator/v10"
)

var validate = validator.New(validator.WithRequiredStructFields())

func init() {
    // Register tag name function to use JSON field names in error messages.
    validate.RegisterTagNameFunc(func(fld reflect.StructField) string {
        name := strings.SplitN(fld.Tag.Get("json"), ",", 2)[0]
        if name == "-" {
            return ""
        }
        return name
    })
}

// DecodeAndValidate decodes JSON from r.Body into dst and validates it.
// Returns a slice of FieldErrors on validation failure, or an error on
// decode failure.
func DecodeAndValidate(r *http.Request, dst interface{}) ([]apierr.FieldError, error) {
    if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
        return nil, fmt.Errorf("decode body: %w", err)
    }
    if err := validate.Struct(dst); err != nil {
        var ve validator.ValidationErrors
        if !errors.As(err, &ve) {
            return nil, err
        }
        fields := make([]apierr.FieldError, len(ve))
        for i, fe := range ve {
            fields[i] = apierr.FieldError{
                Field:   fe.Field(),
                Message: humanMessage(fe),
            }
        }
        return fields, nil
    }
    return nil, nil
}

func humanMessage(fe validator.FieldError) string {
    switch fe.Tag() {
    case "required":
        return "field is required"
    case "email":
        return "must be a valid email address"
    case "min":
        return fmt.Sprintf("must be at least %s characters", fe.Param())
    case "max":
        return fmt.Sprintf("must not exceed %s characters", fe.Param())
    default:
        return fmt.Sprintf("failed validation rule: %s", fe.Tag())
    }
}
```

### Handler Using Validation

```go
package apiv1

import (
    "net/http"

    "github.com/example/myapi/internal/apierr"
    "github.com/example/myapi/internal/validation"
)

// CreateUserRequest represents the request body for POST /api/v1/users.
//
// swagger:parameters createUser
type CreateUserRequest struct {
    // required: true
    // min length: 2
    Name string `json:"name" validate:"required,min=2,max=100"`
    // required: true
    Email string `json:"email" validate:"required,email"`
    // minimum: 13
    Age int `json:"age" validate:"required,min=13,max=150"`
}

// CreateUser godoc
// @Summary      Create a user
// @Description  Create a new user account
// @Tags         users
// @Accept       json
// @Produce      json
// @Param        request body CreateUserRequest true "User creation request"
// @Success      201 {object} UserResponse
// @Failure      400 {object} apierr.ErrorResponse
// @Failure      500 {object} apierr.ErrorResponse
// @Router       /api/v1/users [post]
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
    var req CreateUserRequest
    fields, err := validation.DecodeAndValidate(r, &req)
    if err != nil {
        apierr.BadRequest(w, r)
        return
    }
    if len(fields) > 0 {
        apierr.BadRequest(w, r, fields...)
        return
    }

    user, err := h.userSvc.Create(r.Context(), req.Name, req.Email, req.Age)
    if err != nil {
        apierr.InternalServerError(w, r)
        return
    }
    writeJSON(w, http.StatusCreated, toUserResponse(user))
}
```

## Section 5: API Versioning Strategies

Three approaches to REST API versioning each have different trade-offs:

### URI Versioning (Recommended for Public APIs)

```go
r.Route("/api/v1", func(r chi.Router) { apiv1.RegisterRoutes(r, deps) })
r.Route("/api/v2", func(r chi.Router) { apiv2.RegisterRoutes(r, deps) })
```

Advantages: immediately visible in logs and browsers; easy to route at load balancer layer.

### Header Versioning

```go
r.Route("/api/users", func(r chi.Router) {
    r.Use(func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            switch r.Header.Get("API-Version") {
            case "2":
                apiv2.HandleUsers(w, r)
            default:
                next.ServeHTTP(w, r)
            }
        })
    })
    apiv1.HandleUsers(w, r) // default version
})
```

### Version Sunset Policy

```go
// SunsetMiddleware adds the Sunset and Deprecation headers defined in RFC 8594.
func SunsetMiddleware(sunsetDate string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("Sunset", sunsetDate)           // "Sat, 31 Dec 2027 23:59:59 GMT"
            w.Header().Set("Deprecation", "true")
            w.Header().Set("Link", `</api/v2/users>; rel="successor-version"`)
            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 6: Logging Middleware

Structured request logging with `zap` captures the fields needed for observability:

```go
package middleware

import (
    "net/http"
    "time"

    "github.com/go-chi/chi/v5/middleware"
    "go.uber.org/zap"
)

// StructuredLogger returns a middleware that logs each request with zap.
func StructuredLogger(logger *zap.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
            start := time.Now()
            defer func() {
                logger.Info("http request",
                    zap.String("method", r.Method),
                    zap.String("path", r.URL.Path),
                    zap.String("query", r.URL.RawQuery),
                    zap.Int("status", ww.Status()),
                    zap.Int("bytes", ww.BytesWritten()),
                    zap.Duration("latency", time.Since(start)),
                    zap.String("request_id", middleware.GetReqID(r.Context())),
                    zap.String("remote_addr", r.RemoteAddr),
                    zap.String("user_agent", r.UserAgent()),
                )
            }()
            next.ServeHTTP(ww, r)
        })
    }
}
```

## Section 7: OpenAPI Spec Generation with swaggo

Annotate handlers with swaggo comments, then generate the spec:

```go
// @title           MyAPI
// @version         1.0
// @description     Production REST API example
// @termsOfService  https://example.com/terms

// @contact.name   Support Tools
// @contact.url    https://support.tools
// @contact.email  support@support.tools

// @license.name  Apache 2.0
// @license.url   http://www.apache.org/licenses/LICENSE-2.0.html

// @host      api.example.com
// @BasePath  /api/v1

// @securityDefinitions.apikey BearerAuth
// @in header
// @name Authorization
```

Generate and serve:

```bash
# Install swag CLI
go install github.com/swaggo/swag/cmd/swag@latest

# Generate docs from annotations
swag init -g cmd/server/main.go -o docs

# Regenerate on every build in Makefile:
# generate: swag init -g cmd/server/main.go -o docs
```

The generated `docs/swagger.json` is served by `httpSwagger.Handler` at `/swagger/*`.

## Section 8: Rate Limiting Middleware

Token bucket rate limiting per IP address using `golang.org/x/time/rate`:

```go
package middleware

import (
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

type ipLimiter struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

var (
    mu       sync.Mutex
    limiters = make(map[string]*ipLimiter)
)

func getLimiter(ip string, r rate.Limit, b int) *rate.Limiter {
    mu.Lock()
    defer mu.Unlock()
    if l, ok := limiters[ip]; ok {
        l.lastSeen = time.Now()
        return l.limiter
    }
    l := &ipLimiter{
        limiter:  rate.NewLimiter(r, b),
        lastSeen: time.Now(),
    }
    limiters[ip] = l
    return l.limiter
}

// RateLimiter limits requests to limit per window, burst of 2*limit.
func RateLimiter(perMinute int, _ time.Duration) func(http.Handler) http.Handler {
    r := rate.Limit(float64(perMinute) / 60.0)
    b := perMinute * 2
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
            ip := req.RemoteAddr
            if !getLimiter(ip, r, b).Allow() {
                w.Header().Set("Retry-After", "60")
                http.Error(w, `{"code":"RATE_LIMITED","message":"too many requests"}`,
                    http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, req)
        })
    }
}
```

## Section 9: Graceful Shutdown

Zero-downtime deployments require the server to stop accepting new connections, drain in-flight requests, and close background resources before exiting:

```go
package main

import (
    "context"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "go.uber.org/zap"
)

func run(logger *zap.Logger, handler http.Handler) error {
    srv := &http.Server{
        Addr:         ":8080",
        Handler:      handler,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    errCh := make(chan error, 1)
    go func() {
        logger.Info("server starting", zap.String("addr", srv.Addr))
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            errCh <- err
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

    select {
    case err := <-errCh:
        return err
    case sig := <-quit:
        logger.Info("shutdown signal received", zap.String("signal", sig.String()))
    }

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(ctx); err != nil {
        return fmt.Errorf("graceful shutdown: %w", err)
    }
    logger.Info("server stopped cleanly")
    return nil
}
```

### Kubernetes Compatibility

Add a pre-stop sleep to account for the time between SIGTERM and kube-proxy propagating the endpoint removal:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sleep", "5"]
terminationGracePeriodSeconds: 60
```

The 30-second `Shutdown` timeout in the Go code must be less than `terminationGracePeriodSeconds` minus the pre-stop sleep duration.

## Section 10: Integration Testing

Test the full HTTP stack including middleware using `httptest`:

```go
package server_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestCreateUser_Valid(t *testing.T) {
    svc := &fakeUserService{}
    router := server.New(svc)
    ts := httptest.NewServer(router)
    defer ts.Close()

    body := `{"name":"Alice","email":"alice@example.com","age":30}`
    req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/users",
        bytes.NewBufferString(body))
    require.NoError(t, err)
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer EXAMPLE_VALID_TOKEN_REPLACE_ME")

    resp, err := http.DefaultClient.Do(req)
    require.NoError(t, err)
    defer resp.Body.Close()

    assert.Equal(t, http.StatusCreated, resp.StatusCode)

    var result map[string]interface{}
    require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))
    assert.Equal(t, "Alice", result["name"])
}

func TestCreateUser_InvalidEmail(t *testing.T) {
    svc := &fakeUserService{}
    router := server.New(svc)

    body := `{"name":"Bob","email":"not-an-email","age":25}`
    req := httptest.NewRequest(http.MethodPost, "/api/v1/users",
        bytes.NewBufferString(body))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer EXAMPLE_VALID_TOKEN_REPLACE_ME")
    w := httptest.NewRecorder()

    router.ServeHTTP(w, req)

    assert.Equal(t, http.StatusBadRequest, w.Code)

    var errResp apierr.ErrorResponse
    require.NoError(t, json.NewDecoder(w.Body).Decode(&errResp))
    assert.Equal(t, "BAD_REQUEST", errResp.Code)
    require.Len(t, errResp.Details, 1)
    assert.Equal(t, "email", errResp.Details[0].Field)
}
```

Benchmark the routing layer to detect regression from middleware additions:

```go
func BenchmarkRouter(b *testing.B) {
    router := server.New(&fakeUserService{})
    req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
    w := httptest.NewRecorder()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        router.ServeHTTP(w, req)
    }
}
```
