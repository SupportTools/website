---
title: "Go REST API Design: OpenAPI Specs, Middleware Chains, and Versioning Strategies"
date: 2027-07-24T00:00:00-05:00
draft: false
tags: ["Go", "REST API", "OpenAPI", "Middleware", "API Design"]
categories:
- Go
- API Design
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to designing and implementing production Go REST APIs with OpenAPI 3.0 spec-first design, oapi-codegen, chi/gin/fiber router comparison, middleware chains, request validation, structured error responses, versioning, and graceful shutdown."
more_link: "yes"
url: "/go-api-design-rest-openapi-guide/"
---

A well-designed REST API is simultaneously a contract with consumers, documentation for operators, and a constraint system that makes wrong usage hard to express. The spec-first approach — writing the OpenAPI document before writing a single line of Go — enforces this discipline and enables automated code generation, validation, and documentation. This guide covers the complete spec-first workflow for production Go APIs, from OpenAPI document to a deployed, versioned service.

<!--more-->

# [Go REST API Design](#go-rest-api-design)

## Section 1: OpenAPI 3.0 Spec-First Design

### Why Spec-First

Writing the OpenAPI spec before the implementation provides several production benefits:

- Contract review can happen before engineering begins — catching API design mistakes early.
- Client SDKs and server stubs are generated from the same source of truth.
- Request/response validation is automatic — no hand-written validation logic.
- API documentation is always synchronized with implementation.
- Breaking-change detection is automatable in CI.

### A Complete Inventory API Spec

```yaml
# api/v1/openapi.yaml
openapi: "3.0.3"
info:
  title: Inventory Service API
  description: Manages warehouse inventory items.
  version: "1.0.0"
  contact:
    name: Platform Engineering
    email: platform@example.com

servers:
  - url: "https://api.example.com/v1"
    description: Production
  - url: "https://api.staging.example.com/v1"
    description: Staging
  - url: "http://localhost:8080/v1"
    description: Local Development

tags:
  - name: items
    description: Inventory item management

paths:
  /items:
    get:
      operationId: listItems
      summary: List inventory items
      tags: [items]
      parameters:
        - name: location
          in: query
          schema:
            type: string
          description: Filter items by warehouse location.
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 20
        - name: cursor
          in: query
          schema:
            type: string
          description: Opaque pagination cursor.
      responses:
        "200":
          description: Successful response
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ItemList"
        "400":
          $ref: "#/components/responses/BadRequest"
        "500":
          $ref: "#/components/responses/InternalError"

    post:
      operationId: createItem
      summary: Create a new item
      tags: [items]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateItemRequest"
      responses:
        "201":
          description: Item created
          headers:
            Location:
              schema:
                type: string
                format: uri
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
        "400":
          $ref: "#/components/responses/BadRequest"
        "409":
          $ref: "#/components/responses/Conflict"

  /items/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
          minLength: 1
    get:
      operationId: getItem
      summary: Get an item by ID
      tags: [items]
      responses:
        "200":
          description: Successful response
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
        "404":
          $ref: "#/components/responses/NotFound"

    patch:
      operationId: updateItem
      summary: Partially update an item
      tags: [items]
      requestBody:
        required: true
        content:
          application/merge-patch+json:
            schema:
              $ref: "#/components/schemas/UpdateItemRequest"
      responses:
        "200":
          description: Updated item
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
        "400":
          $ref: "#/components/responses/BadRequest"
        "404":
          $ref: "#/components/responses/NotFound"

    delete:
      operationId: deleteItem
      summary: Delete an item
      tags: [items]
      responses:
        "204":
          description: Item deleted
        "404":
          $ref: "#/components/responses/NotFound"

components:
  schemas:
    Item:
      type: object
      required: [id, sku, name, quantity, location, createdAt, updatedAt]
      properties:
        id:
          type: string
          readOnly: true
        sku:
          type: string
          minLength: 1
          maxLength: 64
        name:
          type: string
          minLength: 1
          maxLength: 255
        quantity:
          type: integer
          minimum: 0
        location:
          type: string
        createdAt:
          type: string
          format: date-time
          readOnly: true
        updatedAt:
          type: string
          format: date-time
          readOnly: true

    CreateItemRequest:
      type: object
      required: [sku, name, quantity, location]
      properties:
        sku:
          type: string
          minLength: 1
          maxLength: 64
        name:
          type: string
          minLength: 1
          maxLength: 255
        quantity:
          type: integer
          minimum: 0
        location:
          type: string

    UpdateItemRequest:
      type: object
      properties:
        name:
          type: string
          minLength: 1
          maxLength: 255
        quantity:
          type: integer
          minimum: 0
        location:
          type: string

    ItemList:
      type: object
      required: [items, nextCursor]
      properties:
        items:
          type: array
          items:
            $ref: "#/components/schemas/Item"
        nextCursor:
          type: string
          nullable: true

    Error:
      type: object
      required: [code, message, requestId]
      properties:
        code:
          type: string
          description: Machine-readable error code.
        message:
          type: string
          description: Human-readable error message.
        requestId:
          type: string
          description: Request ID for log correlation.
        details:
          type: array
          items:
            $ref: "#/components/schemas/ErrorDetail"

    ErrorDetail:
      type: object
      properties:
        field:
          type: string
        message:
          type: string

  responses:
    BadRequest:
      description: Invalid request
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    Conflict:
      description: Resource already exists
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    InternalError:
      description: Internal server error
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"

  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

security:
  - bearerAuth: []
```

## Section 2: Code Generation with oapi-codegen

`oapi-codegen` generates Go types, server interfaces, and client code from an OpenAPI spec.

```bash
go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest
```

```yaml
# .oapi-codegen.yaml
package: inventoryapi
generate:
  models: true
  chi-server: true   # or gin-server, fiber-server, echo-server
  strict-server: true
  embedded-spec: true
output: gen/inventoryapi/server.gen.go
output-options:
  skip-prune: false
```

```bash
oapi-codegen --config .oapi-codegen.yaml api/v1/openapi.yaml
```

The generated `StrictServerInterface` maps operations to typed handler functions:

```go
// Generated (do not edit):
type StrictServerInterface interface {
    ListItems(ctx context.Context, request ListItemsRequestObject) (ListItemsResponseObject, error)
    CreateItem(ctx context.Context, request CreateItemRequestObject) (CreateItemResponseObject, error)
    GetItem(ctx context.Context, request GetItemRequestObject) (GetItemResponseObject, error)
    UpdateItem(ctx context.Context, request UpdateItemRequestObject) (UpdateItemResponseObject, error)
    DeleteItem(ctx context.Context, request DeleteItemRequestObject) (DeleteItemResponseObject, error)
}
```

### Implementing the Generated Interface

```go
package server

import (
    "context"
    "errors"
    "time"

    "github.com/google/uuid"
    api "github.com/example/services/gen/inventoryapi"
    "github.com/example/services/internal/inventory"
)

type InventoryServer struct {
    store inventory.Store
}

func NewInventoryServer(store inventory.Store) *InventoryServer {
    return &InventoryServer{store: store}
}

func (s *InventoryServer) ListItems(
    ctx context.Context,
    req api.ListItemsRequestObject,
) (api.ListItemsResponseObject, error) {
    params := inventory.ListParams{
        Limit:    derefInt(req.Params.Limit, 20),
        Cursor:   derefString(req.Params.Cursor),
        Location: derefString(req.Params.Location),
    }

    items, nextCursor, err := s.store.List(ctx, params)
    if err != nil {
        return nil, err
    }

    apiItems := make([]api.Item, len(items))
    for i, item := range items {
        apiItems[i] = toAPIItem(item)
    }

    return api.ListItems200JSONResponse{
        Items:      apiItems,
        NextCursor: nextCursor,
    }, nil
}

func (s *InventoryServer) GetItem(
    ctx context.Context,
    req api.GetItemRequestObject,
) (api.GetItemResponseObject, error) {
    item, err := s.store.GetByID(ctx, req.Id)
    if errors.Is(err, inventory.ErrNotFound) {
        return api.GetItem404JSONResponse{
            Code:      "NOT_FOUND",
            Message:   "Item not found",
            RequestId: requestIDFromContext(ctx),
        }, nil
    }
    if err != nil {
        return nil, err
    }
    return api.GetItem200JSONResponse(toAPIItem(item)), nil
}

func (s *InventoryServer) CreateItem(
    ctx context.Context,
    req api.CreateItemRequestObject,
) (api.CreateItemResponseObject, error) {
    item := inventory.Item{
        ID:       uuid.New().String(),
        SKU:      req.Body.Sku,
        Name:     req.Body.Name,
        Quantity: req.Body.Quantity,
        Location: req.Body.Location,
    }

    if err := s.store.Create(ctx, &item); err != nil {
        if errors.Is(err, inventory.ErrAlreadyExists) {
            return api.CreateItem409JSONResponse{
                Code:      "CONFLICT",
                Message:   "SKU already exists",
                RequestId: requestIDFromContext(ctx),
            }, nil
        }
        return nil, err
    }

    apiItem := toAPIItem(item)
    return api.CreateItem201JSONResponse(apiItem), nil
}

func toAPIItem(item inventory.Item) api.Item {
    now := time.Now()
    return api.Item{
        Id:        item.ID,
        Sku:       item.SKU,
        Name:      item.Name,
        Quantity:  item.Quantity,
        Location:  item.Location,
        CreatedAt: item.CreatedAt.UTC(),
        UpdatedAt: item.UpdatedAt.UTC(),
        _ :        now, // suppress unused warning; remove in real code
    }
}

func derefInt(p *int, def int) int {
    if p != nil {
        return *p
    }
    return def
}

func derefString(p *string) string {
    if p != nil {
        return *p
    }
    return ""
}
```

## Section 3: Router Comparison — chi vs gin vs fiber

### chi

chi is a lightweight, idiomatic router that uses only the standard `net/http` interfaces. Middleware is standard `http.Handler` chains.

```go
import "github.com/go-chi/chi/v5"

r := chi.NewRouter()
r.Use(middleware.RequestID)
r.Use(middleware.RealIP)
r.Use(middleware.Logger)
r.Use(middleware.Recoverer)
r.Use(middleware.Timeout(30 * time.Second))

r.Route("/v1", func(r chi.Router) {
    r.Use(authMiddleware)
    r.Mount("/items", itemsRouter())
})
```

**Best for**: services that prefer stdlib compatibility, teams already using `net/http` patterns.

### gin

gin offers higher throughput than chi through a custom `httprouter` and a `Context` object that combines request/response handling.

```go
import "github.com/gin-gonic/gin"

r := gin.New()
r.Use(gin.Logger())
r.Use(gin.Recovery())
r.Use(RequestIDMiddleware())

v1 := r.Group("/v1")
v1.Use(AuthMiddleware())

items := v1.Group("/items")
items.GET("", listItemsHandler)
items.POST("", createItemHandler)
items.GET("/:id", getItemHandler)
items.PATCH("/:id", updateItemHandler)
items.DELETE("/:id", deleteItemHandler)
```

**Best for**: high-throughput services where router overhead matters; teams that prefer gin's `Context`.

### fiber

fiber uses fasthttp instead of net/http, providing the highest raw throughput at the cost of incompatibility with standard `http.Handler` middleware.

```go
import "github.com/gofiber/fiber/v2"

app := fiber.New(fiber.Config{
    ErrorHandler: customErrorHandler,
})

app.Use(logger.New())
app.Use(recover.New())
app.Use(requestid.New())

v1 := app.Group("/v1")
v1.Use(authMiddleware)
v1.Get("/items", listItemsHandler)
v1.Post("/items", createItemHandler)
v1.Get("/items/:id", getItemHandler)
v1.Patch("/items/:id", updateItemHandler)
v1.Delete("/items/:id", deleteItemHandler)
```

**Best for**: edge proxies, high-fanout services; teams that do not need net/http middleware compatibility.

### Decision Matrix

| Criterion | chi | gin | fiber |
|---|---|---|---|
| net/http compatibility | Full | Full | No (fasthttp) |
| Raw throughput | Moderate | High | Highest |
| Ecosystem | stdlib | Gin ecosystem | Fiber ecosystem |
| Testing | Standard | Standard | Requires fiber test helpers |
| Learning curve | Low | Low | Medium |

## Section 4: Middleware Chain Design

### Middleware Ordering Matters

Middleware executes in registration order. The correct order for most production services is:

```
Request ID → Real IP → Rate Limiter → Auth → Logging → Timeout → Business Handler
```

Logging after auth ensures the user identity is available in log entries. Rate limiting before auth rejects bots before incurring auth overhead.

### Request ID Middleware

```go
package middleware

import (
    "context"
    "net/http"

    "github.com/google/uuid"
)

type contextKey string

const requestIDKey contextKey = "request_id"

func RequestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := r.Header.Get("X-Request-Id")
        if id == "" {
            id = uuid.New().String()
        }
        ctx := context.WithValue(r.Context(), requestIDKey, id)
        w.Header().Set("X-Request-Id", id)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func RequestIDFromContext(ctx context.Context) string {
    if id, ok := ctx.Value(requestIDKey).(string); ok {
        return id
    }
    return ""
}
```

### Structured Logging Middleware

```go
func StructuredLogging(log *zap.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            rw := &responseRecorder{ResponseWriter: w, statusCode: http.StatusOK}

            next.ServeHTTP(rw, r)

            log.Info("http request",
                zap.String("method", r.Method),
                zap.String("path", r.URL.Path),
                zap.Int("status", rw.statusCode),
                zap.Duration("duration", time.Since(start)),
                zap.String("request_id", RequestIDFromContext(r.Context())),
                zap.String("user_agent", r.UserAgent()),
                zap.String("remote_addr", r.RemoteAddr),
            )
        })
    }
}

type responseRecorder struct {
    http.ResponseWriter
    statusCode  int
    bytesWritten int
}

func (rr *responseRecorder) WriteHeader(code int) {
    rr.statusCode = code
    rr.ResponseWriter.WriteHeader(code)
}

func (rr *responseRecorder) Write(b []byte) (int, error) {
    n, err := rr.ResponseWriter.Write(b)
    rr.bytesWritten += n
    return n, err
}
```

### JWT Authentication Middleware

```go
func JWTAuth(jwksURL string) func(http.Handler) http.Handler {
    // Cache the JWKS, refreshing periodically.
    keySet := jwk.NewAutoRefresh(context.Background())
    keySet.Configure(jwksURL, jwk.WithRefreshInterval(15*time.Minute))
    if _, err := keySet.Refresh(context.Background(), jwksURL); err != nil {
        log.Fatalf("fetch JWKS: %v", err)
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            token := extractBearerToken(r)
            if token == "" {
                writeError(w, r, http.StatusUnauthorized, "UNAUTHENTICATED", "missing bearer token")
                return
            }

            set, err := keySet.Fetch(r.Context(), jwksURL)
            if err != nil {
                writeError(w, r, http.StatusInternalServerError, "AUTH_ERROR", "failed to fetch key set")
                return
            }

            parsed, err := jwt.Parse([]byte(token), jwt.WithKeySet(set), jwt.WithValidate(true))
            if err != nil {
                writeError(w, r, http.StatusUnauthorized, "INVALID_TOKEN", "token validation failed")
                return
            }

            ctx := context.WithValue(r.Context(), claimsKey, parsed)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func extractBearerToken(r *http.Request) string {
    auth := r.Header.Get("Authorization")
    if !strings.HasPrefix(auth, "Bearer ") {
        return ""
    }
    return strings.TrimPrefix(auth, "Bearer ")
}
```

## Section 5: Structured Error Responses

Consistent, machine-readable error responses are essential for client reliability. The error envelope should carry:

- A stable machine-readable code (not an HTTP status message).
- A human-readable message.
- The request ID for log correlation.
- Optional field-level validation details.

```go
package apierror

import (
    "encoding/json"
    "net/http"
)

// Error is the standard JSON error envelope.
type Error struct {
    Code      string        `json:"code"`
    Message   string        `json:"message"`
    RequestID string        `json:"requestId"`
    Details   []FieldError  `json:"details,omitempty"`
}

type FieldError struct {
    Field   string `json:"field"`
    Message string `json:"message"`
}

// Write serializes an Error to the ResponseWriter with the given HTTP status.
func Write(w http.ResponseWriter, r *http.Request, status int, code, message string, details ...FieldError) {
    body := Error{
        Code:      code,
        Message:   message,
        RequestID: middleware.RequestIDFromContext(r.Context()),
        Details:   details,
    }
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(body)
}

// Common error constructors.
func NotFound(w http.ResponseWriter, r *http.Request, resource string) {
    Write(w, r, http.StatusNotFound, "NOT_FOUND",
        fmt.Sprintf("%s not found", resource))
}

func BadRequest(w http.ResponseWriter, r *http.Request, message string, details ...FieldError) {
    Write(w, r, http.StatusBadRequest, "BAD_REQUEST", message, details...)
}

func Conflict(w http.ResponseWriter, r *http.Request, message string) {
    Write(w, r, http.StatusConflict, "CONFLICT", message)
}

func InternalError(w http.ResponseWriter, r *http.Request) {
    Write(w, r, http.StatusInternalServerError, "INTERNAL_ERROR",
        "an unexpected error occurred")
}

func Unauthorized(w http.ResponseWriter, r *http.Request, message string) {
    Write(w, r, http.StatusUnauthorized, "UNAUTHENTICATED", message)
}

func Forbidden(w http.ResponseWriter, r *http.Request) {
    Write(w, r, http.StatusForbidden, "FORBIDDEN",
        "you do not have permission to perform this action")
}
```

## Section 6: Request Validation

oapi-codegen's strict server validates request bodies against the OpenAPI schema before calling handler code. For custom validation beyond JSON Schema, add domain validators:

```go
package validation

import (
    "fmt"
    "regexp"
)

var skuPattern = regexp.MustCompile(`^[A-Z0-9\-]{3,64}$`)

type CreateItemValidator struct{}

type ValidationError struct {
    Field   string
    Message string
}

func (v *CreateItemValidator) Validate(req CreateItemRequest) []ValidationError {
    var errs []ValidationError

    if !skuPattern.MatchString(req.SKU) {
        errs = append(errs, ValidationError{
            Field:   "sku",
            Message: "must match pattern [A-Z0-9-]{3,64}",
        })
    }

    if req.Quantity < 0 {
        errs = append(errs, ValidationError{
            Field:   "quantity",
            Message: "must be non-negative",
        })
    }

    if req.Location == "" {
        errs = append(errs, ValidationError{
            Field:   "location",
            Message: "is required",
        })
    }

    return errs
}
```

Use the validator in the handler before persisting:

```go
func (s *InventoryServer) CreateItem(ctx context.Context, req api.CreateItemRequestObject) (api.CreateItemResponseObject, error) {
    validator := &validation.CreateItemValidator{}
    if errs := validator.Validate(toCreateItemRequest(req.Body)); len(errs) > 0 {
        details := make([]api.ErrorDetail, len(errs))
        for i, e := range errs {
            details[i] = api.ErrorDetail{Field: &e.Field, Message: &e.Message}
        }
        return api.CreateItem400JSONResponse{
            Code:      "VALIDATION_ERROR",
            Message:   "request validation failed",
            RequestId: requestIDFromContext(ctx),
            Details:   details,
        }, nil
    }
    // ... proceed with creation
}
```

## Section 7: API Versioning Strategies

### URL Path Versioning (Recommended for Public APIs)

```
GET /v1/items/{id}
GET /v2/items/{id}
```

Pros: explicit, cacheable, easy to route by version in proxies.
Cons: duplicates URL structure; clients must change URLs when upgrading.

```go
r := chi.NewRouter()
r.Mount("/v1", v1Router())
r.Mount("/v2", v2Router())
```

### Header Versioning

```
GET /items/{id}
Accept-Version: v2
```

Pros: clean URLs; same path works across versions.
Cons: caches must vary by header; not visible in logs without custom logging.

```go
func VersionRouter(v1, v2 http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        switch r.Header.Get("Accept-Version") {
        case "v2":
            v2.ServeHTTP(w, r)
        default:
            v1.ServeHTTP(w, r)
        }
    })
}
```

### Additive Versioning (Preferred for Internal APIs)

For services where all consumers are owned by the same organization, the additive approach is simpler: add fields to responses without removing them; use feature flags for behavioral changes.

```go
// V1 response.
type ItemV1 struct {
    ID       string `json:"id"`
    SKU      string `json:"sku"`
    Name     string `json:"name"`
    Quantity int    `json:"quantity"`
}

// V2 extends V1 — never remove fields, only add.
type ItemV2 struct {
    ItemV1
    Location    string    `json:"location"`    // Added in v2.
    WarehouseID string    `json:"warehouseId"` // Added in v2.
}
```

## Section 8: Rate Limiting Middleware

```go
package middleware

import (
    "net/http"
    "sync"

    "golang.org/x/time/rate"
)

type IPRateLimiter struct {
    mu       sync.Mutex
    limiters map[string]*rate.Limiter
    rps      float64
    burst    int
}

func NewIPRateLimiter(rps float64, burst int) *IPRateLimiter {
    return &IPRateLimiter{
        limiters: make(map[string]*rate.Limiter),
        rps:      rps,
        burst:    burst,
    }
}

func (l *IPRateLimiter) getLimiter(ip string) *rate.Limiter {
    l.mu.Lock()
    defer l.mu.Unlock()
    lim, ok := l.limiters[ip]
    if !ok {
        lim = rate.NewLimiter(rate.Limit(l.rps), l.burst)
        l.limiters[ip] = lim
    }
    return lim
}

func RateLimit(limiter *IPRateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ip := realIP(r)
            if !limiter.getLimiter(ip).Allow() {
                w.Header().Set("Retry-After", "1")
                apierror.Write(w, r, http.StatusTooManyRequests,
                    "RATE_LIMITED", "too many requests")
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

func realIP(r *http.Request) string {
    if ip := r.Header.Get("X-Real-Ip"); ip != "" {
        return ip
    }
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        return strings.SplitN(xff, ",", 2)[0]
    }
    host, _, _ := net.SplitHostPort(r.RemoteAddr)
    return host
}
```

## Section 9: Graceful Shutdown

A production HTTP server must drain in-flight requests before termination. The Kubernetes termination lifecycle sends `SIGTERM`, then waits `terminationGracePeriodSeconds` before sending `SIGKILL`. The server must complete its shutdown within that window.

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

func main() {
    log, _ := zap.NewProduction()
    defer log.Sync()

    handler := buildHandler(log)

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      handler,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
        // Prevent Slowloris attacks.
        ReadHeaderTimeout: 5 * time.Second,
    }

    // Start server in background.
    go func() {
        log.Info("HTTP server starting", zap.String("addr", srv.Addr))
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatal("server error", zap.Error(err))
        }
    }()

    // Wait for termination signal.
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    sig := <-quit
    log.Info("shutdown signal received", zap.String("signal", sig.String()))

    // Give active requests 25 seconds to complete (Kubernetes default grace period is 30s).
    ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
    defer cancel()

    if err := srv.Shutdown(ctx); err != nil {
        log.Error("graceful shutdown failed", zap.Error(err))
    } else {
        log.Info("server stopped cleanly")
    }
}
```

### Kubernetes Deployment Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-api
spec:
  replicas: 3
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: inventory-api
          image: registry.example.com/inventory-api:1.0.0
          ports:
            - containerPort: 8080
              name: http
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz/live
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
          lifecycle:
            preStop:
              # Give the load balancer time to drain connections before SIGTERM.
              exec:
                command: ["/bin/sleep", "5"]
```

## Section 10: API Documentation with Swagger UI

Embed the OpenAPI spec and serve Swagger UI from the same binary:

```go
package docs

import (
    "embed"
    "net/http"
)

//go:embed openapi.yaml
var spec embed.FS

//go:embed swagger-ui
var swaggerUI embed.FS

func Handler() http.Handler {
    mux := http.NewServeMux()

    // Serve raw spec.
    mux.HandleFunc("/openapi.yaml", func(w http.ResponseWriter, r *http.Request) {
        data, _ := spec.ReadFile("openapi.yaml")
        w.Header().Set("Content-Type", "application/yaml")
        w.Write(data)
    })

    // Serve Swagger UI at /docs.
    uiFS, _ := fs.Sub(swaggerUI, "swagger-ui")
    mux.Handle("/docs/", http.StripPrefix("/docs/", http.FileServer(http.FS(uiFS))))

    return mux
}
```

Add to the main router:

```go
r.Mount("/", docs.Handler())
```

Gate documentation behind internal network access in production:

```go
func InternalOnly(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ip := realIP(r)
        if !isPrivateIP(ip) {
            http.NotFound(w, r)
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

## Section 11: Testing the API

### Handler Tests with httptest

```go
package server_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
)

func TestCreateItem(t *testing.T) {
    store := inventory.NewMemoryStore()
    srv := server.NewInventoryServer(store)
    handler := buildTestHandler(srv) // Sets up routing and middleware.

    body := map[string]any{
        "sku":      "WIDGET-001",
        "name":     "Widget",
        "quantity": 100,
        "location": "A1-B2",
    }
    bodyJSON, _ := json.Marshal(body)

    req := httptest.NewRequest(http.MethodPost, "/v1/items", bytes.NewReader(bodyJSON))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer "+testToken())

    rr := httptest.NewRecorder()
    handler.ServeHTTP(rr, req)

    if rr.Code != http.StatusCreated {
        t.Fatalf("expected 201, got %d: %s", rr.Code, rr.Body.String())
    }

    var created map[string]any
    if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
        t.Fatalf("decode response: %v", err)
    }
    if created["sku"] != "WIDGET-001" {
        t.Errorf("unexpected sku: %v", created["sku"])
    }
    if rr.Header().Get("X-Request-Id") == "" {
        t.Error("missing X-Request-Id header")
    }
}

func TestGetItem_NotFound(t *testing.T) {
    store := inventory.NewMemoryStore()
    srv := server.NewInventoryServer(store)
    handler := buildTestHandler(srv)

    req := httptest.NewRequest(http.MethodGet, "/v1/items/nonexistent", nil)
    req.Header.Set("Authorization", "Bearer "+testToken())

    rr := httptest.NewRecorder()
    handler.ServeHTTP(rr, req)

    if rr.Code != http.StatusNotFound {
        t.Fatalf("expected 404, got %d", rr.Code)
    }

    var errResp map[string]any
    json.Unmarshal(rr.Body.Bytes(), &errResp)
    if errResp["code"] != "NOT_FOUND" {
        t.Errorf("expected NOT_FOUND code, got %v", errResp["code"])
    }
}
```

### Contract Testing with Spectral

Validate the OpenAPI spec in CI to catch schema errors before generation:

```bash
# Install Spectral.
npm install -g @stoplight/spectral-cli

# Run Spectral against the spec.
spectral lint api/v1/openapi.yaml --ruleset .spectral.yaml
```

```yaml
# .spectral.yaml
extends: ["spectral:oas"]
rules:
  operation-success-response: error
  operation-operationId: error
  operation-description: warn
  info-contact: warn
  oas3-valid-media-example: error
```

## Section 12: Summary

A production Go REST API built spec-first achieves correctness by construction:

- **OpenAPI first**: write the spec before the implementation; run Spectral in CI to catch design errors early.
- **oapi-codegen**: generate types, server stubs, and client code from the single source of truth; never hand-write boilerplate.
- **Router choice**: chi for stdlib compatibility, gin for higher throughput, fiber for maximum performance at the cost of ecosystem.
- **Middleware order**: request ID → rate limiter → auth → logging → timeout; each layer depends on the next.
- **Structured errors**: stable machine-readable codes, human-readable messages, and request IDs in every error response.
- **Validation**: JSON Schema validation from the spec plus domain validators for business rules.
- **Versioning**: URL path versioning for public APIs; additive versioning for internal services.
- **Rate limiting**: token bucket per IP or per client; return `429` with `Retry-After` header.
- **Graceful shutdown**: `context.WithTimeout` on `Shutdown`, `preStop` hook in Kubernetes, `terminationGracePeriodSeconds` aligned with the Go shutdown timeout.
- **Testing**: `httptest.NewRecorder` for handler tests; Spectral for spec linting in CI.

The investment in a well-defined OpenAPI spec pays compound returns: auto-generated clients, automatic validation, always-accurate documentation, and a contractual forcing function that prevents silent breaking changes from reaching consumers.
