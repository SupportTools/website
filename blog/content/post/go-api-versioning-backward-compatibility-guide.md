---
title: "Go API Versioning: Backward Compatibility and Deprecation Strategies"
date: 2028-11-08T00:00:00-05:00
draft: false
tags: ["Go", "API Design", "Versioning", "REST", "gRPC"]
categories:
- Go
- API Design
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to API versioning in Go: URL versioning vs header versioning, semantic versioning principles, safe vs breaking changes, protobuf field number stability for gRPC, deprecation headers, OpenAPI versioned clients, and managing v1/v2 simultaneously in one binary."
more_link: "yes"
url: "/go-api-versioning-backward-compatibility-guide/"
---

API versioning is one of the most consequential architectural decisions you make for a long-lived service. Choose poorly and you face either frequent breaking changes that frustrate clients, or an accumulation of technical debt from maintaining compatibility shims. The Kubernetes API, Stripe's payment API, and GitHub's REST and GraphQL APIs are all studied examples of getting versioning right — and they all took different approaches.

This guide covers the principles and implementation patterns for API versioning in Go: when to increment versions, what changes are safe versus breaking, how to serve v1 and v2 from the same binary, gRPC protobuf field stability, and how to communicate deprecations to clients.

<!--more-->

# Go API Versioning: Backward Compatibility and Deprecation Strategies

## What Makes a Change Breaking?

Before choosing a versioning strategy, understand the compatibility rules:

### Safe (Backward-Compatible) Changes
```
Adding optional fields to request/response structs
Adding new endpoints or RPC methods
Adding new enum values (with caveats for exhaustive switches)
Relaxing validation (accepting more inputs)
Adding new error codes
Changing documentation
Performance improvements with the same semantics
Adding optional query parameters with sensible defaults
```

### Breaking Changes
```
Removing fields from request/response structs
Renaming fields
Changing field types (e.g., int → string)
Making optional fields required
Removing endpoints or RPC methods
Changing URL paths or HTTP methods
Tightening validation (rejecting previously-accepted inputs)
Changing authentication requirements
Changing error codes that clients may handle
Removing enum values
```

The principle: **adding is safe, removing or changing is breaking**.

## URL Path Versioning

The most common approach for REST APIs. The version is embedded in the URL path:

```
GET /api/v1/orders/123
GET /api/v2/orders/123
```

```go
// cmd/api/main.go
package main

import (
	"net/http"

	"github.com/example/api/internal/v1"
	"github.com/example/api/internal/v2"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Mount v1 handlers
	r.Mount("/api/v1", v1.Routes())

	// Mount v2 handlers — different URL prefix, different handlers
	r.Mount("/api/v2", v2.Routes())

	// Unversioned endpoints (health, metrics, OpenAPI spec)
	r.Get("/healthz", healthHandler)
	r.Get("/openapi/v1.json", serveOpenAPISpec("v1"))
	r.Get("/openapi/v2.json", serveOpenAPISpec("v2"))

	http.ListenAndServe(":8080", r)
}
```

```go
// internal/v1/routes.go
package v1

import (
	"github.com/go-chi/chi/v5"
)

func Routes() http.Handler {
	r := chi.NewRouter()

	// v1 Order API
	r.Route("/orders", func(r chi.Router) {
		r.Get("/", ListOrders)
		r.Post("/", CreateOrder)
		r.Get("/{orderID}", GetOrder)
		r.Put("/{orderID}", UpdateOrder)
		r.Delete("/{orderID}", DeleteOrder)
	})

	return r
}
```

```go
// internal/v2/routes.go
package v2

import (
	"github.com/go-chi/chi/v5"
)

func Routes() http.Handler {
	r := chi.NewRouter()

	// v2 Order API — different response shape, additional fields
	r.Route("/orders", func(r chi.Router) {
		r.Get("/", ListOrders)
		r.Post("/", CreateOrder)
		r.Get("/{orderID}", GetOrder)
		r.Put("/{orderID}", UpdateOrder)
		r.Delete("/{orderID}", DeleteOrder)
	})

	// v2 adds new endpoints not in v1
	r.Route("/orders/{orderID}/timeline", func(r chi.Router) {
		r.Get("/", GetOrderTimeline)
	})

	return r
}
```

## Header Versioning

An alternative where the version is specified in an HTTP header:

```go
// middleware/version.go
package middleware

import (
	"context"
	"net/http"
	"strings"
)

type contextKey string
const APIVersionKey contextKey = "api-version"

// VersionMiddleware extracts the API version from headers and injects it into context.
// Supports:
//   Accept: application/vnd.example.v2+json  (content negotiation)
//   API-Version: 2                           (explicit header)
//   X-API-Version: 2                         (legacy header)
func VersionMiddleware(defaultVersion string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			version := defaultVersion

			// Check API-Version header (preferred)
			if v := r.Header.Get("API-Version"); v != "" {
				version = v
			}

			// Check Accept header with vendor media type
			if accept := r.Header.Get("Accept"); accept != "" {
				if v := extractVersionFromAccept(accept); v != "" {
					version = v
				}
			}

			ctx := context.WithValue(r.Context(), APIVersionKey, version)

			// Set the version in the response so clients know what they got
			w.Header().Set("API-Version", version)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func extractVersionFromAccept(accept string) string {
	// Parse: application/vnd.example.v2+json
	for _, part := range strings.Split(accept, ",") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "application/vnd.example.v") {
			// Extract version number
			rest := strings.TrimPrefix(part, "application/vnd.example.v")
			if idx := strings.Index(rest, "+"); idx > 0 {
				return rest[:idx]
			}
		}
	}
	return ""
}

func VersionFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(APIVersionKey).(string); ok {
		return v
	}
	return "1"
}
```

### Routing by Version in a Single Handler

```go
// handlers/orders.go — Version-aware handler
package handlers

import (
	"net/http"

	"github.com/example/api/middleware"
	v1 "github.com/example/api/internal/v1"
	v2 "github.com/example/api/internal/v2"
)

func GetOrder(w http.ResponseWriter, r *http.Request) {
	version := middleware.VersionFromContext(r.Context())

	switch version {
	case "1":
		v1.GetOrder(w, r)
	case "2":
		v2.GetOrder(w, r)
	default:
		// Unknown version: return the latest with a deprecation header
		w.Header().Set("Warning", `299 - "Unknown version, using latest"`)
		v2.GetOrder(w, r)
	}
}
```

## Structuring v1 and v2 Types

Share the domain logic but use separate request/response types per version:

```go
// internal/domain/order.go — Version-neutral domain model
package domain

import "time"

type Order struct {
	ID          string
	CustomerID  string
	Status      OrderStatus
	Items       []OrderItem
	TotalCents  int64
	Currency    string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	// v2 fields — ignored by v1 serialization
	Tags        []string
	Metadata    map[string]string
}

type OrderStatus string
const (
	StatusPending    OrderStatus = "pending"
	StatusProcessing OrderStatus = "processing"
	StatusComplete   OrderStatus = "complete"
	StatusFailed     OrderStatus = "failed"
)
```

```go
// internal/v1/types.go — v1 API response types
package v1

import "time"

// OrderResponse is the v1 API representation.
// Changing this struct is a BREAKING CHANGE for v1 clients.
type OrderResponse struct {
	ID         string          `json:"id"`
	CustomerID string          `json:"customer_id"`
	Status     string          `json:"status"`
	Items      []OrderItemV1   `json:"items"`
	Total      float64         `json:"total"`         // v1 uses float (known pain point)
	Currency   string          `json:"currency"`
	CreatedAt  time.Time       `json:"created_at"`
}

type OrderItemV1 struct {
	ProductID string  `json:"product_id"`
	Quantity  int     `json:"quantity"`
	Price     float64 `json:"price"`
}
```

```go
// internal/v2/types.go — v2 API response types
package v2

import "time"

// OrderResponse is the v2 API representation.
// v2 fixes the float total issue and adds new fields.
type OrderResponse struct {
	ID          string            `json:"id"`
	CustomerID  string            `json:"customer_id"`
	Status      string            `json:"status"`
	Items       []OrderItemV2     `json:"items"`
	TotalCents  int64             `json:"total_cents"`    // CHANGED: int cents instead of float dollars
	Currency    string            `json:"currency"`
	Tags        []string          `json:"tags,omitempty"` // NEW in v2
	Metadata    map[string]string `json:"metadata,omitempty"` // NEW in v2
	CreatedAt   time.Time         `json:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at"`     // NEW in v2
}

type OrderItemV2 struct {
	ProductID   string `json:"product_id"`
	Quantity    int    `json:"quantity"`
	PriceCents  int64  `json:"price_cents"`  // CHANGED: int cents
	ProductName string `json:"product_name"` // NEW in v2
}
```

```go
// internal/v1/mapper.go — Convert domain model to v1 response
package v1

import "github.com/example/api/internal/domain"

func ToOrderResponse(o *domain.Order) *OrderResponse {
	items := make([]OrderItemV1, len(o.Items))
	for i, item := range o.Items {
		items[i] = OrderItemV1{
			ProductID: item.ProductID,
			Quantity:  item.Quantity,
			Price:     float64(item.PriceCents) / 100.0,
		}
	}

	return &OrderResponse{
		ID:         o.ID,
		CustomerID: o.CustomerID,
		Status:     string(o.Status),
		Items:      items,
		Total:      float64(o.TotalCents) / 100.0,
		Currency:   o.Currency,
		CreatedAt:  o.CreatedAt,
	}
}
```

## Deprecation Headers

When you want to signal that v1 is being deprecated without breaking clients:

```go
// middleware/deprecation.go
package middleware

import (
	"fmt"
	"net/http"
	"time"
)

// DeprecationMiddleware adds RFC 8594 deprecation headers to deprecated API versions.
// Clients that parse these headers can warn their users or log deprecation notices.
func DeprecationMiddleware(version string, sunsetDate time.Time) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// RFC 8594: Deprecation HTTP Response Header Field
			// Deprecated: true (as a boolean-impled date, or a specific date)
			w.Header().Set("Deprecation", "true")

			// Sunset header: the date when the API will be removed
			// Format: RFC 1123 date
			w.Header().Set("Sunset", sunsetDate.UTC().Format(http.TimeFormat))

			// Link header: point to the migration guide
			w.Header().Set("Link",
				fmt.Sprintf(`</api/%s/migration-guide>; rel="successor-version"`, nextVersion(version)))

			next.ServeHTTP(w, r)
		})
	}
}

func nextVersion(current string) string {
	switch current {
	case "v1":
		return "v2"
	default:
		return "latest"
	}
}
```

Apply the deprecation middleware only to v1:

```go
// cmd/api/main.go
func main() {
	r := chi.NewRouter()

	// v1 is deprecated — sunset date 6 months from now
	sunsetDate := time.Date(2029, 5, 1, 0, 0, 0, 0, time.UTC)
	r.Mount("/api/v1",
		middleware.DeprecationMiddleware("v1", sunsetDate)(v1.Routes()))

	// v2 is current — no deprecation headers
	r.Mount("/api/v2", v2.Routes())
}
```

## gRPC: Protobuf Field Number Stability

In gRPC, the protobuf field numbers are the contract — not the field names. Once a field number is assigned, it is permanent. This is fundamentally different from JSON where field names are the contract:

```protobuf
// orders/v1/orders.proto
syntax = "proto3";
package orders.v1;

message Order {
  string id = 1;              // Field 1 is FOREVER "id"
  string customer_id = 2;     // Field 2 is FOREVER "customer_id"
  OrderStatus status = 3;     // Field 3 is FOREVER "status"
  repeated OrderItem items = 4; // Field 4 is FOREVER "items"
  int64 total_cents = 5;      // Field 5 is FOREVER "total_cents"
  string currency = 6;        // Field 6 is FOREVER "currency"
  google.protobuf.Timestamp created_at = 7;
  google.protobuf.Timestamp updated_at = 8;

  // Adding new fields in a minor/patch update: SAFE
  // Always use new field numbers, never reuse old ones
  repeated string tags = 9;         // Added in patch release — safe
  map<string, string> metadata = 10; // Added in patch release — safe

  // NEVER DO THIS:
  // reserved 5;               // Would break existing clients reading total_cents
  // int64 amount_cents = 5;   // Reusing a field number — BINARY BREAKING
}

enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0; // Always have a 0 value for proto3 enums
  ORDER_STATUS_PENDING = 1;
  ORDER_STATUS_PROCESSING = 2;
  ORDER_STATUS_COMPLETE = 3;
  ORDER_STATUS_FAILED = 4;
  // Adding new enum values is safe
  ORDER_STATUS_REFUNDED = 5;   // New in patch — safe
}

// Use reserved to document removed fields
message OrderItem {
  string product_id = 1;
  int32 quantity = 2;
  int64 price_cents = 3;
  string product_name = 4;    // Added in v1.1 — safe

  // Reserved fields that were removed — do not reuse these numbers
  reserved 5, 6;
  reserved "old_sku", "legacy_price";
}
```

### gRPC API Versioning with Packages

For breaking changes in gRPC, use a new package:

```protobuf
// orders/v2/orders.proto — Breaking changes require a new package
syntax = "proto3";
package orders.v2;

// v2 Order — completely new schema in a new package
// Old clients can still call orders.v1.OrderService
// New clients use orders.v2.OrderService
message Order {
  string id = 1;
  string customer_id = 2;
  OrderStatus status = 3;
  repeated OrderItem items = 4;
  Money total = 5;              // CHANGED: from int64 cents to Money message
  google.protobuf.Timestamp created_at = 6;
  google.protobuf.Timestamp updated_at = 7;
  repeated string tags = 8;
  map<string, string> metadata = 9;
}

message Money {
  int64 amount_cents = 1;
  string currency = 2;          // Moved currency into Money message
}
```

### Serving v1 and v2 gRPC from One Binary

```go
// cmd/grpc/main.go
package main

import (
	"log"
	"net"

	ordersv1 "github.com/example/api/gen/orders/v1"
	ordersv2 "github.com/example/api/gen/orders/v2"
	handlersv1 "github.com/example/api/internal/grpc/v1"
	handlersv2 "github.com/example/api/internal/grpc/v2"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"
)

func main() {
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	srv := grpc.NewServer(
		// Add interceptors for auth, logging, tracing
	)

	// Register both v1 and v2 services on the same server
	// Clients choose which service they call by the full method path:
	//   /orders.v1.OrderService/GetOrder
	//   /orders.v2.OrderService/GetOrder
	ordersv1.RegisterOrderServiceServer(srv, handlersv1.NewOrderService())
	ordersv2.RegisterOrderServiceServer(srv, handlersv2.NewOrderService())

	// Server reflection lets clients (like grpcurl) discover available services
	reflection.Register(srv)

	log.Printf("gRPC server listening on :50051")
	if err := srv.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
```

## OpenAPI Spec Versioning

Generate versioned OpenAPI specifications for REST APIs and use them to generate clients:

```go
// internal/openapi/spec.go
package openapi

import (
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
)

//go:embed specs/*.json
var specFS embed.FS

// ServeSpec serves the OpenAPI spec for the requested version.
func ServeSpec(version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := specFS.ReadFile(fmt.Sprintf("specs/openapi-%s.json", version))
		if err != nil {
			http.Error(w, "spec not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
	}
}
```

Generate versioned Go clients from the OpenAPI spec:

```bash
# Generate v1 client
oapi-codegen -generate types,client \
  -package v1client \
  -o internal/generated/v1client/client.go \
  api/openapi/v1.yaml

# Generate v2 client
oapi-codegen -generate types,client \
  -package v2client \
  -o internal/generated/v2client/client.go \
  api/openapi/v2.yaml
```

## Version Negotiation in Clients

Well-designed clients negotiate versions and handle deprecation warnings:

```go
// pkg/client/client.go
package client

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

type Client struct {
	baseURL    string
	version    string
	httpClient *http.Client
}

func New(baseURL, version string) *Client {
	return &Client{
		baseURL: baseURL,
		version: version,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) do(ctx context.Context, method, path string) (*http.Response, error) {
	url := fmt.Sprintf("%s/api/%s%s", c.baseURL, c.version, path)
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Accept", fmt.Sprintf("application/vnd.example.%s+json", c.version))
	req.Header.Set("API-Version", c.version)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}

	// Check for deprecation headers and warn
	c.checkDeprecation(resp)

	return resp, nil
}

func (c *Client) checkDeprecation(resp *http.Response) {
	if resp.Header.Get("Deprecation") != "" {
		sunset := resp.Header.Get("Sunset")
		link := resp.Header.Get("Link")
		log.Printf("WARNING: API version %s is deprecated. Sunset: %s. Migration: %s",
			c.version, sunset, link)
		// In production, emit a metric here so you can track deprecated API usage
	}
}

// GetOrder demonstrates the versioned client call.
func (c *Client) GetOrder(ctx context.Context, orderID string) (*OrderResponse, error) {
	resp, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/orders/%s", orderID))
	if err != nil {
		return nil, fmt.Errorf("get order: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var order OrderResponse
	if err := json.NewDecoder(resp.Body).Decode(&order); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}
	return &order, nil
}
```

## Compatibility Testing

Write tests that verify v1 and v2 clients can work with the current server:

```go
// integration/compatibility_test.go
package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/example/api/cmd/api"
)

func TestV1BackwardCompatibility(t *testing.T) {
	srv := httptest.NewServer(api.NewRouter())
	defer srv.Close()

	ctx := context.Background()

	// Test that v1 response shape is unchanged
	resp, err := http.Get(srv.URL + "/api/v1/orders/test-order-1")
	if err != nil {
		t.Fatalf("get order: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	// Decode into the v1 response type
	var order struct {
		ID         string  `json:"id"`
		CustomerID string  `json:"customer_id"`
		Status     string  `json:"status"`
		Total      float64 `json:"total"`     // v1 uses float
		Currency   string  `json:"currency"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&order); err != nil {
		t.Fatalf("decoding v1 response: %v", err)
	}

	// Verify v1-specific fields are present
	if order.ID == "" {
		t.Error("expected non-empty id")
	}
	if order.Total == 0 {
		t.Error("expected non-zero total (float in v1)")
	}

	// Verify v2-only fields are NOT present in v1
	var raw map[string]interface{}
	// Re-request for the raw check
	resp2, _ := http.Get(srv.URL + "/api/v1/orders/test-order-1")
	json.NewDecoder(resp2.Body).Decode(&raw)
	resp2.Body.Close()

	if _, ok := raw["total_cents"]; ok {
		t.Error("v1 response should NOT contain total_cents (that's a v2 field)")
	}
	if _, ok := raw["metadata"]; ok {
		t.Error("v1 response should NOT contain metadata (that's a v2 field)")
	}
}

func TestV2NewFields(t *testing.T) {
	srv := httptest.NewServer(api.NewRouter())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/v2/orders/test-order-1")
	if err != nil {
		t.Fatalf("get order: %v", err)
	}
	defer resp.Body.Close()

	var order struct {
		ID         string            `json:"id"`
		TotalCents int64             `json:"total_cents"` // v2 uses cents
		Tags       []string          `json:"tags"`
		Metadata   map[string]string `json:"metadata"`
		UpdatedAt  string            `json:"updated_at"`  // new in v2
	}

	if err := json.NewDecoder(resp.Body).Decode(&order); err != nil {
		t.Fatalf("decoding v2 response: %v", err)
	}

	if order.TotalCents == 0 {
		t.Error("expected non-zero total_cents in v2")
	}
}
```

## Summary

API versioning in Go follows a set of clear principles:

1. **URL versioning** (`/api/v1/`, `/api/v2/`) is the most explicit and cache-friendly strategy — use it for REST APIs with long support windows
2. **Header versioning** suits APIs with many media types or where URL changes are disruptive — requires client discipline to set the header
3. **Adding is safe, removing is breaking** — internalize this rule and you will break clients far less often
4. **Separate response types per version** — share domain models but use version-specific serialization types with explicit mappers
5. **Serve v1 and v2 from one binary** — version-specific package separation (`internal/v1`, `internal/v2`) keeps things organized without running multiple services
6. **protobuf field numbers are permanent** — never reuse a field number; use `reserved` to document removed fields
7. **gRPC versioning uses packages** (`orders.v1.OrderService`, `orders.v2.OrderService`) — both can be registered on the same gRPC server
8. **Deprecation headers** (RFC 8594 `Deprecation` + `Sunset`) give clients advance notice with machine-readable sunset dates
9. **Compatibility tests** prevent accidental breaking changes — test that your v1 response shape hasn't changed with every PR
