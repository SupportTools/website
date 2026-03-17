---
title: "API Versioning in Go: URL Paths, Headers, and Schema Evolution"
date: 2028-03-14T00:00:00-05:00
draft: false
tags: ["Go", "API Design", "REST", "API Versioning", "OpenAPI", "Schema Evolution", "swaggo"]
categories: ["Go", "API Design"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to API versioning in Go covering URL path versioning, Accept header negotiation, DTO versioning, field deprecation with Sunset headers, backwards-compatible schema evolution, version routing middleware, and OpenAPI spec generation with swaggo."
more_link: "yes"
url: "/go-api-versioning-patterns-guide/"
---

API versioning decisions made early in a service's lifecycle are difficult to reverse. Choosing the wrong strategy — or implementing it inconsistently — creates client compatibility problems, complicates documentation, and forces breaking changes that fragment the ecosystem. Go services benefit from explicit, type-safe versioning approaches that make the version contract visible in code. This guide covers the primary versioning strategies with production-grade implementations and the operational tooling to manage multi-version APIs.

<!--more-->

## Versioning Strategy Comparison

| Strategy | URL Example | Pros | Cons |
|---|---|---|---|
| URL path | `/v1/orders` | Simple, cacheable, explicit in logs | Version pollutes resource URL |
| Accept header | `Accept: application/vnd.api+json;version=2` | Clean URLs, REST-pure | Complex routing, poor browser support |
| Query parameter | `/orders?version=2` | Simple for clients | Caching complications, pollutes query space |
| Custom header | `API-Version: 2` | Clean URLs | Non-standard, invisible in logs |

URL path versioning is the most widely adopted for public APIs. Accept header versioning aligns better with REST semantics for internal services with sophisticated clients.

## URL Path Versioning

### Router Structure

```go
// cmd/api/main.go
package main

import (
    "net/http"

    "github.com/example/service/handler/v1"
    "github.com/example/service/handler/v2"
    "github.com/example/service/middleware"
)

func main() {
    mux := http.NewServeMux()

    // Version routing via path prefix
    v1Handler := buildV1Handler()
    v2Handler := buildV2Handler()

    mux.Handle("/v1/", http.StripPrefix("/v1", v1Handler))
    mux.Handle("/v2/", http.StripPrefix("/v2", v2Handler))

    // Redirect unversioned requests to current stable version
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        http.Redirect(w, r, "/v2"+r.URL.Path, http.StatusMovedPermanently)
    })

    srv := &http.Server{
        Addr:    ":8080",
        Handler: middleware.Chain(
            mux,
            middleware.RequestID,
            middleware.Logger,
            middleware.Recover,
        ),
    }
    srv.ListenAndServe()
}

func buildV1Handler() http.Handler {
    mux := http.NewServeMux()
    h := v1.NewOrderHandler(orderServiceV1)
    mux.HandleFunc("GET /orders/{id}", h.Get)
    mux.HandleFunc("POST /orders", h.Create)
    mux.HandleFunc("GET /orders", h.List)
    return mux
}

func buildV2Handler() http.Handler {
    mux := http.NewServeMux()
    h := v2.NewOrderHandler(orderServiceV2)
    mux.HandleFunc("GET /orders/{id}", h.Get)
    mux.HandleFunc("POST /orders", h.Create)
    mux.HandleFunc("GET /orders", h.List)
    mux.HandleFunc("POST /orders/{id}/cancel", h.Cancel)  // new in v2
    return mux
}
```

### Version Middleware for Logging and Tracing

```go
// middleware/version.go
package middleware

import (
    "context"
    "net/http"
)

type contextKey string

const apiVersionKey contextKey = "api_version"

// APIVersion extracts the version from the request path and injects it into context.
func APIVersion(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := extractVersion(r.URL.Path)
        ctx := context.WithValue(r.Context(), apiVersionKey, version)

        // Expose version in response headers for observability
        w.Header().Set("X-API-Version", version)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func extractVersion(path string) string {
    if len(path) >= 3 && path[1] == 'v' {
        end := 3
        for end < len(path) && path[end] != '/' {
            end++
        }
        return path[1:end]
    }
    return "unknown"
}

func VersionFromContext(ctx context.Context) string {
    if v, ok := ctx.Value(apiVersionKey).(string); ok {
        return v
    }
    return "unknown"
}
```

## Accept Header Version Negotiation

```go
// middleware/content_negotiation.go
package middleware

import (
    "fmt"
    "mime"
    "net/http"
    "strconv"
    "strings"
)

// ParseAPIVersion extracts the version from an Accept header.
// Supports:
//   Accept: application/json                          → default version
//   Accept: application/vnd.example.v2+json          → version 2
//   Accept: application/json; version=2               → version 2
func ParseAPIVersion(r *http.Request) (int, error) {
    accept := r.Header.Get("Accept")
    if accept == "" {
        return 1, nil // default to v1
    }

    // Check for vnd.example.v{N}+json pattern
    if strings.Contains(accept, "vnd.example.v") {
        parts := strings.Split(accept, "vnd.example.v")
        if len(parts) >= 2 {
            versionStr := strings.Split(parts[1], "+")[0]
            return strconv.Atoi(versionStr)
        }
    }

    // Check for version parameter in media type params
    mediaType, params, err := mime.ParseMediaType(accept)
    if err != nil {
        return 1, nil
    }
    _ = mediaType

    if versionStr, ok := params["version"]; ok {
        return strconv.Atoi(versionStr)
    }

    return 1, nil
}

// ContentNegotiation routes requests to the appropriate handler based on Accept header.
func ContentNegotiation(handlers map[int]http.Handler, defaultVersion int) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version, err := ParseAPIVersion(r)
        if err != nil {
            http.Error(w, fmt.Sprintf("invalid version in Accept header: %v", err), http.StatusBadRequest)
            return
        }

        handler, ok := handlers[version]
        if !ok {
            // Return a list of supported versions
            supportedVersions := make([]string, 0, len(handlers))
            for v := range handlers {
                supportedVersions = append(supportedVersions, fmt.Sprintf("v%d", v))
            }
            w.Header().Set("Content-Type", "application/problem+json")
            w.WriteHeader(http.StatusNotAcceptable)
            fmt.Fprintf(w, `{"error":"unsupported version","supported":["%s"]}`,
                strings.Join(supportedVersions, `","`))
            return
        }

        w.Header().Set("Content-Type", fmt.Sprintf("application/vnd.example.v%d+json", version))
        handler.ServeHTTP(w, r)
    })
}
```

## Request/Response DTO Versioning

Version-specific DTOs prevent accidental cross-version type pollution and enable independent evolution of each version's schema.

### Package Structure

```
handler/
  v1/
    order.go         # v1 handler
    dto.go           # v1 request/response types
  v2/
    order.go         # v2 handler
    dto.go           # v2 request/response types
service/
  order.go           # internal domain model (version-agnostic)
  order_v1.go        # v1 adapter
  order_v2.go        # v2 adapter
```

### V1 DTOs

```go
// handler/v1/dto.go
package v1

import "time"

// CreateOrderRequest is the v1 API request for creating an order.
// Deprecated: Use v2 CreateOrderRequest which supports multi-currency.
type CreateOrderRequest struct {
    Items    []OrderItemRequest `json:"items"`
    // v1 only supports USD amounts
    AmountUSD float64           `json:"amount_usd"`
    // v1 uses customer_id (deprecated in v2 in favor of user_id)
    CustomerID string            `json:"customer_id"`
}

type OrderItemRequest struct {
    SKU      string `json:"sku"`
    Quantity int    `json:"quantity"`
}

type OrderResponse struct {
    ID         string     `json:"id"`
    Status     string     `json:"status"`
    AmountUSD  float64    `json:"amount_usd"`
    CustomerID string     `json:"customer_id"`
    CreatedAt  time.Time  `json:"created_at"`
}
```

### V2 DTOs

```go
// handler/v2/dto.go
package v2

import "time"

type CreateOrderRequest struct {
    Items    []OrderItemRequest `json:"items"`
    // v2: multi-currency support
    Amount   MoneyRequest       `json:"amount"`
    // v2: renamed from customer_id
    UserID   string             `json:"user_id"`
    // v2: new field — optional shipping address
    Shipping *AddressRequest    `json:"shipping,omitempty"`
    // v2: new field — idempotency key
    IdempotencyKey string       `json:"idempotency_key,omitempty"`
}

type MoneyRequest struct {
    Amount   float64 `json:"amount"`
    Currency string  `json:"currency"` // ISO 4217
}

type OrderItemRequest struct {
    SKU      string `json:"sku"`
    Quantity int    `json:"quantity"`
    // v2: optional override price
    Price    *MoneyRequest `json:"price,omitempty"`
}

type AddressRequest struct {
    Line1      string `json:"line1"`
    Line2      string `json:"line2,omitempty"`
    City       string `json:"city"`
    State      string `json:"state"`
    PostalCode string `json:"postal_code"`
    Country    string `json:"country"` // ISO 3166-1 alpha-2
}

type OrderResponse struct {
    ID             string     `json:"id"`
    Status         string     `json:"status"`
    Amount         MoneyResponse `json:"amount"`
    UserID         string     `json:"user_id"`
    // v2 returns canonical URLs
    Links          OrderLinks `json:"_links"`
    CreatedAt      time.Time  `json:"created_at"`
    UpdatedAt      time.Time  `json:"updated_at"`
}

type MoneyResponse struct {
    Amount      float64 `json:"amount"`
    Currency    string  `json:"currency"`
    AmountCents int64   `json:"amount_cents"`
}

type OrderLinks struct {
    Self   string `json:"self"`
    Cancel string `json:"cancel,omitempty"`
}
```

### Domain Model Adapters

```go
// service/order_v1.go
package service

// ToV1Response converts an internal Order to the v1 API response format.
func (o *Order) ToV1Response() *v1.OrderResponse {
    return &v1.OrderResponse{
        ID:         o.ID,
        Status:     string(o.Status),
        AmountUSD:  float64(o.Amount.Cents) / 100.0,
        CustomerID: o.UserID, // backwards compat: v1 used customer_id
        CreatedAt:  o.CreatedAt,
    }
}

// FromV1Request converts a v1 CreateOrderRequest to an internal CreateOrderInput.
func FromV1CreateRequest(req *v1.CreateOrderRequest) CreateOrderInput {
    items := make([]OrderItem, len(req.Items))
    for i, item := range req.Items {
        items[i] = OrderItem{SKU: item.SKU, Quantity: item.Quantity}
    }
    return CreateOrderInput{
        Items:    items,
        Amount:   Money{Cents: int64(req.AmountUSD * 100), Currency: "USD"},
        UserID:   req.CustomerID,
    }
}

// service/order_v2.go
func (o *Order) ToV2Response(baseURL string) *v2.OrderResponse {
    resp := &v2.OrderResponse{
        ID:     o.ID,
        Status: string(o.Status),
        Amount: v2.MoneyResponse{
            Amount:      float64(o.Amount.Cents) / 100.0,
            Currency:    o.Amount.Currency,
            AmountCents: o.Amount.Cents,
        },
        UserID:    o.UserID,
        CreatedAt: o.CreatedAt,
        UpdatedAt: o.UpdatedAt,
        Links: v2.OrderLinks{
            Self: fmt.Sprintf("%s/v2/orders/%s", baseURL, o.ID),
        },
    }
    if o.Status == StatusPending || o.Status == StatusProcessing {
        resp.Links.Cancel = fmt.Sprintf("%s/v2/orders/%s/cancel", baseURL, o.ID)
    }
    return resp
}
```

## Field Deprecation with Sunset Headers

RFC 8594 defines the `Sunset` and `Deprecation` headers for communicating API lifecycle timelines.

### Deprecation Middleware

```go
// middleware/deprecation.go
package middleware

import (
    "net/http"
    "time"
)

type DeprecationConfig struct {
    DeprecationDate time.Time
    SunsetDate      time.Time
    Link            string // URL to migration docs
}

// Deprecated marks an HTTP handler's responses with deprecation headers.
func Deprecated(config DeprecationConfig, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // RFC 8594 deprecation header
        w.Header().Set("Deprecation", config.DeprecationDate.Format(time.RFC1123))

        // Sunset date — when the API will be removed
        w.Header().Set("Sunset", config.SunsetDate.Format(time.RFC1123))

        // Link to migration documentation
        if config.Link != "" {
            w.Header().Set("Link",
                fmt.Sprintf(`<%s>; rel="deprecation"; type="text/html"`, config.Link))
        }

        next.ServeHTTP(w, r)
    })
}
```

Apply to v1 routes:

```go
// Apply deprecation headers to entire v1 API
v1Handler := Deprecated(DeprecationConfig{
    DeprecationDate: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
    SunsetDate:      time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC),
    Link:            "https://docs.example.com/api/migrate-v1-to-v2",
}, buildV1Handler())
```

### Field-Level Deprecation in Response

```go
// Embed deprecation notices in JSON responses for fields
type CreateOrderV1Response struct {
    ID         string  `json:"id"`
    // Deprecated: Use user_id field in v2 API
    CustomerID string  `json:"customer_id"`
    AmountUSD  float64 `json:"amount_usd"`

    // Deprecation notice as response field (optional, informational)
    Deprecation *DeprecationNotice `json:"_deprecation,omitempty"`
}

type DeprecationNotice struct {
    Message string    `json:"message"`
    Sunset  time.Time `json:"sunset"`
    MigrateURL string `json:"migrate_url"`
}
```

## Backwards-Compatible Schema Evolution

### Additive Changes (Non-Breaking)

These changes are safe to make to any API version without a new version:

- Adding new optional fields to responses
- Adding new optional fields to requests (with sensible defaults)
- Adding new enum values (clients must tolerate unknown values)
- Adding new endpoints
- Relaxing validation rules (accepting inputs previously rejected)

```go
// Safe: add optional field with omitempty and backward-compatible default
type OrderResponse struct {
    ID     string `json:"id"`
    Status string `json:"status"`
    // New optional field — old clients ignore it
    Tags   []string `json:"tags,omitempty"`
}
```

### Forward Compatibility in Request Parsing

```go
// Use json.RawMessage for extensible fields that may grow
type CreateOrderRequest struct {
    Items    []OrderItemRequest `json:"items"`
    Amount   MoneyRequest       `json:"amount"`
    // Allows arbitrary future fields without breaking current parsing
    Metadata json.RawMessage    `json:"metadata,omitempty"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
    var req CreateOrderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    // Ignore unknown fields (Go's default decoder behavior)
    // but log them for forward-compat tracking:
    if req.Metadata != nil {
        var meta map[string]interface{}
        if err := json.Unmarshal(req.Metadata, &meta); err == nil {
            h.logger.Debug("received metadata fields", "fields", meta)
        }
    }
}
```

### Breaking Change Detection with go-apidiff

```bash
# Install go-apidiff
go install golang.org/x/exp/cmd/go-apidiff@latest

# Compare API between git commits
go-apidiff HEAD~1 HEAD -- ./handler/v1/...

# Output shows incompatible changes:
# github.com/example/service/handler/v1
#   CreateOrderRequest.CustomerID: field was removed
```

## Version Routing Middleware

```go
// middleware/version_router.go
package middleware

import (
    "net/http"
    "regexp"
    "strings"
)

var versionRegex = regexp.MustCompile(`^/v(\d+)/`)

type VersionRouter struct {
    handlers       map[string]http.Handler
    defaultVersion string
    fallback       http.Handler
}

func NewVersionRouter(defaultVersion string) *VersionRouter {
    return &VersionRouter{
        handlers:       make(map[string]http.Handler),
        defaultVersion: defaultVersion,
        fallback:       http.HandlerFunc(http.NotFound),
    }
}

func (vr *VersionRouter) Handle(version string, handler http.Handler) {
    vr.handlers[version] = handler
}

func (vr *VersionRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    matches := versionRegex.FindStringSubmatch(r.URL.Path)
    if len(matches) < 2 {
        // No version prefix — try Accept header, then default
        version, _ := ParseAPIVersion(r)
        versionKey := fmt.Sprintf("v%d", version)
        if handler, ok := vr.handlers[versionKey]; ok {
            handler.ServeHTTP(w, r)
            return
        }
        vr.handlers[vr.defaultVersion].ServeHTTP(w, r)
        return
    }

    version := "v" + matches[1]
    handler, ok := vr.handlers[version]
    if !ok {
        w.Header().Set("Content-Type", "application/problem+json")
        w.WriteHeader(http.StatusNotFound)
        supportedVersions := make([]string, 0)
        for v := range vr.handlers {
            supportedVersions = append(supportedVersions, v)
        }
        fmt.Fprintf(w,
            `{"error":"version not found","supported":["%s"],"current":"%s"}`,
            strings.Join(supportedVersions, `","`),
            vr.defaultVersion,
        )
        return
    }

    // Strip the version prefix before passing to the version handler
    r2 := r.Clone(r.Context())
    r2.URL.Path = strings.TrimPrefix(r.URL.Path, "/"+version)
    if r2.URL.Path == "" {
        r2.URL.Path = "/"
    }
    handler.ServeHTTP(w, r2)
}
```

## Generating OpenAPI Specs Per Version with swaggo

### Annotation Conventions

```go
// handler/v1/order.go
package v1

import "net/http"

// @title          Orders API v1
// @version        1.0
// @description    Order management API (Deprecated - use v2)
// @basePath       /v1
// @schemes        https

// Get retrieves an order by ID.
// @Summary      Get order by ID
// @Description  Retrieves full order details including items and payment status
// @Tags         orders
// @Accept       json
// @Produce      json
// @Param        id   path      string  true  "Order ID"
// @Success      200  {object}  OrderResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Deprecated   true
// @Router       /orders/{id} [get]
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
    // implementation
}

// Create creates a new order.
// @Summary      Create order
// @Description  Creates a new order. Note: this endpoint accepts USD amounts only.
//               For multi-currency support, use the v2 API.
// @Tags         orders
// @Accept       json
// @Produce      json
// @Param        order  body      CreateOrderRequest  true  "Order creation request"
// @Success      201    {object}  OrderResponse
// @Failure      400    {object}  ErrorResponse
// @Failure      422    {object}  ValidationErrorResponse
// @Failure      500    {object}  ErrorResponse
// @Deprecated   true
// @Router       /orders [post]
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
    // implementation
}
```

```go
// handler/v2/order.go
package v2

// @title          Orders API v2
// @version        2.0
// @description    Order management API with multi-currency support
// @basePath       /v2
// @schemes        https

// Get retrieves an order by ID.
// @Summary      Get order by ID
// @Tags         orders
// @Accept       json
// @Produce      json
// @Param        id   path      string  true  "Order ID"
// @Success      200  {object}  OrderResponse
// @Header       200  {string}  X-Request-ID  "Request tracing ID"
// @Failure      404  {object}  ErrorResponse
// @Router       /orders/{id} [get]
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
    // implementation
}
```

### Generating Separate Specs

```bash
# Install swag CLI
go install github.com/swaggo/swag/cmd/swag@latest

# Generate v1 spec
swag init \
  --generalInfo handler/v1/order.go \
  --output docs/v1 \
  --outputTypes json,yaml \
  --dir ./handler/v1 \
  --parseDependency

# Generate v2 spec
swag init \
  --generalInfo handler/v2/order.go \
  --output docs/v2 \
  --outputTypes json,yaml \
  --dir ./handler/v2 \
  --parseDependency
```

### Serving OpenAPI Specs and Swagger UI

```go
// main.go — serve Swagger UI for each version
import (
    v1docs "github.com/example/service/docs/v1"
    v2docs "github.com/example/service/docs/v2"
    "github.com/swaggo/http-swagger"
)

// Serve Swagger UI
mux.Handle("/docs/v1/", httpSwagger.Handler(
    httpSwagger.URL("/docs/v1/swagger.json"),
    httpSwagger.DocExpansion("list"),
    httpSwagger.DeepLinking(true),
))
mux.HandleFunc("/docs/v1/swagger.json", func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.Write([]byte(v1docs.SwaggerJSON))
})

mux.Handle("/docs/v2/", httpSwagger.Handler(
    httpSwagger.URL("/docs/v2/swagger.json"),
    httpSwagger.DocExpansion("list"),
))
mux.HandleFunc("/docs/v2/swagger.json", func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.Write([]byte(v2docs.SwaggerJSON))
})
```

## Client SDK Versioning Strategy

### Go Client SDK Structure

```
clients/
  go/
    v1/
      client.go       # v1 client
      orders.go       # v1 order operations
      types.go        # v1 types
    v2/
      client.go       # v2 client
      orders.go       # v2 order operations
      types.go        # v2 types
    README.md
```

```go
// clients/go/v2/client.go
package v2

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

const (
    DefaultBaseURL     = "https://api.example.com/v2"
    DefaultTimeout     = 30 * time.Second
    CurrentAPIVersion  = "v2"
)

type Client struct {
    baseURL    string
    httpClient *http.Client
    apiKey     string
}

type Option func(*Client)

func WithTimeout(d time.Duration) Option {
    return func(c *Client) {
        c.httpClient.Timeout = d
    }
}

func WithHTTPClient(hc *http.Client) Option {
    return func(c *Client) {
        c.httpClient = hc
    }
}

func New(apiKey string, opts ...Option) *Client {
    c := &Client{
        baseURL: DefaultBaseURL,
        apiKey:  apiKey,
        httpClient: &http.Client{
            Timeout: DefaultTimeout,
        },
    }
    for _, opt := range opts {
        opt(c)
    }
    return c
}

func (c *Client) do(ctx context.Context, method, path string, body, result interface{}) error {
    req, err := buildRequest(ctx, method, c.baseURL+path, body)
    if err != nil {
        return fmt.Errorf("build request: %w", err)
    }

    req.Header.Set("Authorization", "Bearer "+c.apiKey)
    req.Header.Set("Accept", fmt.Sprintf("application/vnd.example.%s+json", CurrentAPIVersion))
    req.Header.Set("User-Agent", "example-go-sdk/2.0")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return fmt.Errorf("do request: %w", err)
    }
    defer resp.Body.Close()

    // Log deprecation warnings
    if dep := resp.Header.Get("Deprecation"); dep != "" {
        sunset := resp.Header.Get("Sunset")
        fmt.Printf("WARNING: API deprecated since %s, sunset: %s\n", dep, sunset)
    }

    if resp.StatusCode >= 400 {
        var apiErr APIError
        if err := json.NewDecoder(resp.Body).Decode(&apiErr); err != nil {
            return fmt.Errorf("http %d: failed to decode error response", resp.StatusCode)
        }
        return &apiErr
    }

    if result != nil {
        return json.NewDecoder(resp.Body).Decode(result)
    }
    return nil
}
```

## API Versioning Testing

```go
// handler/v1/order_test.go
package v1_test

func TestVersionHeaders(t *testing.T) {
    tests := []struct {
        name          string
        url           string
        acceptHeader  string
        wantVersion   string
        wantDeprecated bool
    }{
        {
            name:          "v1 path sets version header",
            url:           "/v1/orders",
            wantVersion:   "v1",
            wantDeprecated: true,
        },
        {
            name:          "v2 path sets version header",
            url:           "/v2/orders",
            wantVersion:   "v2",
            wantDeprecated: false,
        },
        {
            name:         "accept header selects v2",
            url:          "/orders",
            acceptHeader: "application/vnd.example.v2+json",
            wantVersion:  "v2",
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            handler := buildTestRouter()
            rec := httptest.NewRecorder()
            req := httptest.NewRequest("GET", tc.url, nil)
            if tc.acceptHeader != "" {
                req.Header.Set("Accept", tc.acceptHeader)
            }

            handler.ServeHTTP(rec, req)

            if got := rec.Header().Get("X-API-Version"); got != tc.wantVersion {
                t.Errorf("X-API-Version = %q, want %q", got, tc.wantVersion)
            }

            _, hasDeprecation := rec.HeaderMap["Deprecation"]
            if hasDeprecation != tc.wantDeprecated {
                t.Errorf("Deprecation header present = %v, want %v", hasDeprecation, tc.wantDeprecated)
            }
        })
    }
}
```

## Lifecycle Management

### Version Status Matrix

```go
// versions/registry.go
package versions

import "time"

type Status string

const (
    StatusAlpha      Status = "alpha"
    StatusBeta       Status = "beta"
    StatusStable     Status = "stable"
    StatusDeprecated Status = "deprecated"
    StatusRetired    Status = "retired"
)

type Version struct {
    Name            string
    Status          Status
    ReleasedAt      time.Time
    DeprecatedAt    *time.Time
    SunsetAt        *time.Time
    MigrationGuide  string
}

var Registry = map[string]Version{
    "v1": {
        Name:           "v1",
        Status:         StatusDeprecated,
        ReleasedAt:     time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
        DeprecatedAt:   timePtr(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
        SunsetAt:       timePtr(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)),
        MigrationGuide: "https://docs.example.com/api/v1-to-v2",
    },
    "v2": {
        Name:       "v2",
        Status:     StatusStable,
        ReleasedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
    },
}

func timePtr(t time.Time) *time.Time { return &t }
```

### Version Discovery Endpoint

```go
// GET /api/versions
func (h *MetaHandler) ListVersions(w http.ResponseWriter, r *http.Request) {
    type versionInfo struct {
        Version        string     `json:"version"`
        Status         string     `json:"status"`
        ReleasedAt     time.Time  `json:"released_at"`
        DeprecatedAt   *time.Time `json:"deprecated_at,omitempty"`
        SunsetAt       *time.Time `json:"sunset_at,omitempty"`
        MigrationGuide string     `json:"migration_guide,omitempty"`
        DocsURL        string     `json:"docs_url"`
    }

    var versions []versionInfo
    for k, v := range versions.Registry {
        versions = append(versions, versionInfo{
            Version:        k,
            Status:         string(v.Status),
            ReleasedAt:     v.ReleasedAt,
            DeprecatedAt:   v.DeprecatedAt,
            SunsetAt:       v.SunsetAt,
            MigrationGuide: v.MigrationGuide,
            DocsURL:        fmt.Sprintf("https://docs.example.com/api/%s", k),
        })
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "versions": versions,
        "current":  "v2",
    })
}
```

## Summary

API versioning in Go requires consistent decisions across routing, DTOs, documentation, and client SDKs. URL path versioning provides the clearest operational experience: versions are visible in logs, cacheable at the CDN layer, and self-documenting in code. Version-specific DTO packages prevent cross-version type contamination while domain adapters translate between the internal model and each version's contract. RFC 8594 `Sunset` and `Deprecation` headers communicate lifecycle timelines to clients programmatically. The swaggo annotation approach generates per-version OpenAPI specs that power interactive documentation and client SDK code generation, closing the loop between API implementation and consumer tooling.
