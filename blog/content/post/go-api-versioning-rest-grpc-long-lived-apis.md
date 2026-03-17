---
title: "Go API Versioning: Strategies for Long-Lived REST and gRPC APIs"
date: 2029-08-13T00:00:00-05:00
draft: false
tags: ["Go", "API", "REST", "gRPC", "Versioning", "Protobuf", "OpenAPI"]
categories: ["Go", "API Design"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go API versioning: URL path versioning, header-based versioning, protobuf backward compatibility, deprecation lifecycle management, client SDK versioning strategies, and OpenAPI evolution patterns."
more_link: "yes"
url: "/go-api-versioning-rest-grpc-long-lived-apis/"
---

APIs are promises. When you ship a version 1 API and someone builds on it, you own that interface for as long as those clients exist. Breaking changes in APIs are one of the highest-friction events in engineering — they require coordinated upgrades across multiple teams, trigger incident reports, and damage trust. This post covers the strategies that keep Go REST and gRPC APIs evolvable without breaking existing clients.

<!--more-->

# Go API Versioning: Strategies for Long-Lived REST and gRPC APIs

## Section 1: What Counts as a Breaking Change

Before discussing strategies, be precise about what constitutes a breaking change. The answer differs between REST and gRPC.

### REST Breaking Changes

```text
BREAKING:
- Removing an endpoint
- Changing an endpoint's HTTP method (POST → PUT)
- Removing a required request field
- Making an optional field required
- Changing a field's type (int → string)
- Changing the semantics of a field (status: "active" now means something different)
- Removing an enum value that clients may have stored
- Changing error response format or error codes

NON-BREAKING:
- Adding new optional request fields (with zero/sensible defaults)
- Adding new response fields (clients must ignore unknown fields)
- Adding new endpoints
- Adding new enum values (clients must handle unknown enum values gracefully)
- Changing documentation
- Performance improvements
```

### gRPC / Protobuf Breaking Changes

```text
BREAKING:
- Renaming a field (clients use field names in JSON mode)
- Changing a field number (clients use field numbers in binary mode)
- Removing a required field
- Changing a field's scalar type (int32 → string)
- Changing a field from singular to repeated (or vice versa)
- Deleting a message type

NON-BREAKING:
- Adding new optional fields (with zero values as defaults)
- Adding new messages
- Adding new RPCs to a service
- Adding new enum values (with the unknowns-as-zero rule)
- Reserving removed field numbers/names
```

## Section 2: URL Path Versioning for REST APIs

URL path versioning is the most explicit approach and the most common in enterprise APIs.

```
/api/v1/users
/api/v2/users
```

### Router Setup in Go

```go
// cmd/server/main.go
package main

import (
    "log"
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"

    v1 "github.com/example/api/internal/handlers/v1"
    v2 "github.com/example/api/internal/handlers/v2"
)

func main() {
    r := chi.NewRouter()

    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Use(middleware.RequestID)

    // v1 routes — stable, no new features
    r.Mount("/api/v1", v1Router())

    // v2 routes — current development version
    r.Mount("/api/v2", v2Router())

    // Redirect bare /api to latest stable version
    r.Get("/api", func(w http.ResponseWriter, r *http.Request) {
        http.Redirect(w, r, "/api/v2", http.StatusMovedPermanently)
    })

    log.Fatal(http.ListenAndServe(":8080", r))
}

func v1Router() http.Handler {
    r := chi.NewRouter()
    h := v1.NewHandlers()

    r.Get("/users", h.ListUsers)
    r.Get("/users/{id}", h.GetUser)
    r.Post("/users", h.CreateUser)
    r.Put("/users/{id}", h.UpdateUser)
    r.Delete("/users/{id}", h.DeleteUser)

    return r
}

func v2Router() http.Handler {
    r := chi.NewRouter()
    h := v2.NewHandlers()

    r.Get("/users", h.ListUsers)           // now supports cursor pagination
    r.Get("/users/{id}", h.GetUser)        // returns additional fields
    r.Post("/users", h.CreateUser)         // accepts new optional fields
    r.Patch("/users/{id}", h.PatchUser)    // new: partial update
    r.Delete("/users/{id}", h.DeleteUser)

    // New endpoints in v2
    r.Get("/users/{id}/preferences", h.GetUserPreferences)
    r.Put("/users/{id}/preferences", h.UpdateUserPreferences)

    return r
}
```

### Version-Specific Types

```go
// internal/handlers/v1/types.go
package v1

// UserResponse is the v1 user response format.
// Do NOT change this struct once v1 is released.
type UserResponse struct {
    ID        string `json:"id"`
    Name      string `json:"name"`
    Email     string `json:"email"`
    CreatedAt string `json:"created_at"`
}

// internal/handlers/v2/types.go
package v2

// UserResponse is the v2 user response format.
// New fields added compared to v1.
type UserResponse struct {
    ID          string            `json:"id"`
    Name        string            `json:"name"`
    Email       string            `json:"email"`
    DisplayName string            `json:"display_name"`          // NEW in v2
    Tier        string            `json:"tier"`                  // NEW in v2
    Metadata    map[string]string `json:"metadata,omitempty"`    // NEW in v2
    CreatedAt   string            `json:"created_at"`
    UpdatedAt   string            `json:"updated_at"`            // NEW in v2
}

// ListUsersResponse v2 uses cursor pagination (v1 used offset/limit)
type ListUsersResponse struct {
    Users      []UserResponse `json:"users"`
    NextCursor string         `json:"next_cursor,omitempty"`
    HasMore    bool           `json:"has_more"`
}
```

### Sharing Domain Logic Across Versions

Version handlers should share domain logic but have version-specific translation layers:

```go
// internal/domain/user.go — shared domain model (no version coupling)
package domain

type User struct {
    ID          string
    Name        string
    Email       string
    DisplayName string
    Tier        string
    Metadata    map[string]string
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

// internal/handlers/v1/handlers.go
package v1

func (h *Handlers) GetUser(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    user, err := h.userService.GetByID(r.Context(), id)
    if err != nil {
        http.Error(w, "not found", http.StatusNotFound)
        return
    }
    // Translate domain model to v1 response (dropping new fields)
    resp := UserResponse{
        ID:        user.ID,
        Name:      user.Name,
        Email:     user.Email,
        CreatedAt: user.CreatedAt.Format(time.RFC3339),
    }
    writeJSON(w, http.StatusOK, resp)
}

// internal/handlers/v2/handlers.go
package v2

func (h *Handlers) GetUser(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    user, err := h.userService.GetByID(r.Context(), id)
    if err != nil {
        http.Error(w, "not found", http.StatusNotFound)
        return
    }
    // Translate domain model to v2 response (all fields)
    resp := UserResponse{
        ID:          user.ID,
        Name:        user.Name,
        Email:       user.Email,
        DisplayName: user.DisplayName,
        Tier:        user.Tier,
        Metadata:    user.Metadata,
        CreatedAt:   user.CreatedAt.Format(time.RFC3339),
        UpdatedAt:   user.UpdatedAt.Format(time.RFC3339),
    }
    writeJSON(w, http.StatusOK, resp)
}
```

## Section 3: Header-Based Versioning

Header versioning keeps URLs clean but makes APIs harder to use from browsers and curl without tooling.

```go
// internal/middleware/version.go
package middleware

import (
    "context"
    "net/http"
    "strings"
)

type versionKey struct{}

const (
    defaultAPIVersion = "v2"
    headerAPIVersion  = "X-API-Version"
    queryAPIVersion   = "api-version"
)

// ExtractVersion reads the API version from:
// 1. X-API-Version header
// 2. api-version query parameter
// 3. Default (latest stable)
func ExtractVersion(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := r.Header.Get(headerAPIVersion)
        if version == "" {
            version = r.URL.Query().Get(queryAPIVersion)
        }
        if version == "" {
            version = defaultAPIVersion
        }
        version = strings.TrimPrefix(version, "v")

        ctx := context.WithValue(r.Context(), versionKey{}, version)
        // Advertise supported versions
        w.Header().Set("X-API-Version", version)
        w.Header().Set("X-Supported-API-Versions", "1,2")

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// GetVersion returns the API version from context.
func GetVersion(ctx context.Context) string {
    if v, ok := ctx.Value(versionKey{}).(string); ok {
        return v
    }
    return defaultAPIVersion
}

// Usage in a combined handler
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    version := middleware.GetVersion(r.Context())
    id := chi.URLParam(r, "id")

    user, err := h.userService.GetByID(r.Context(), id)
    if err != nil {
        http.Error(w, "not found", http.StatusNotFound)
        return
    }

    switch version {
    case "1":
        writeJSON(w, http.StatusOK, toV1UserResponse(user))
    default: // v2 and above
        writeJSON(w, http.StatusOK, toV2UserResponse(user))
    }
}
```

## Section 4: Protobuf Backward Compatibility for gRPC

Protobuf's binary encoding is extremely backward compatible — if you follow the rules.

### The Golden Rules

```protobuf
// api/v1/user.proto
syntax = "proto3";
package myapi.v1;

option go_package = "github.com/example/api/gen/go/myapi/v1;myapiv1";

message User {
    string id = 1;
    string name = 2;
    string email = 3;
    // NEVER reuse field numbers 1, 2, 3 even after removing a field
    // NEVER change the type of field 1, 2, or 3
    // ALWAYS reserve removed fields
    google.protobuf.Timestamp created_at = 10;  // start non-critical fields at 10+
}

message ListUsersRequest {
    int32 page_size = 1;
    string page_token = 2;
    // filter was removed — MUST be reserved
    reserved 3;
    reserved "filter";  // reserve the name too (for JSON/proto3 compatibility)
}

message ListUsersResponse {
    repeated User users = 1;
    string next_page_token = 2;
    int32 total_count = 3;  // added in v1.2 — safe, optional with zero default
}
```

### Field Evolution Patterns

```protobuf
// Evolving a message over multiple releases

// v1.0 — initial
message CreateUserRequest {
    string name = 1;
    string email = 2;
}

// v1.1 — add optional fields (backward compatible)
message CreateUserRequest {
    string name = 1;
    string email = 2;
    string display_name = 3;         // optional, zero value = ""
    UserTier tier = 4;               // optional, zero value = USER_TIER_UNSPECIFIED
    map<string, string> metadata = 5; // optional, empty map by default
}

// If you must remove a field in v2
message CreateUserRequest {
    string name = 1;
    string email = 2;
    // display_name removed — reserved
    reserved 3;
    reserved "display_name";
    UserTier tier = 4;
    map<string, string> metadata = 5;
    string preferred_name = 6;  // replacement for display_name
}
```

### Versioned Proto Packages

For major breaking changes, use a new proto package:

```protobuf
// api/v1/user.proto
syntax = "proto3";
package myapi.v1;
option go_package = "github.com/example/api/gen/go/myapi/v1;myapiv1";

service UserService {
    rpc GetUser(GetUserRequest) returns (User);
    rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
    rpc CreateUser(CreateUserRequest) returns (User);
}

// api/v2/user.proto
syntax = "proto3";
package myapi.v2;
option go_package = "github.com/example/api/gen/go/myapi/v2;myapiv2";

// v2 breaks the RPC contract — new service definition
service UserService {
    rpc GetUser(GetUserRequest) returns (User);
    rpc ListUsers(ListUsersRequest) returns (stream User);  // streaming in v2
    rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
    rpc BatchCreateUsers(BatchCreateUsersRequest) returns (BatchCreateUsersResponse);
}
```

### gRPC Server with Multiple Versions

```go
// cmd/grpc-server/main.go
package main

import (
    "log"
    "net"

    "google.golang.org/grpc"
    "google.golang.org/grpc/reflection"

    v1pb "github.com/example/api/gen/go/myapi/v1"
    v2pb "github.com/example/api/gen/go/myapi/v2"
    v1svc "github.com/example/api/internal/grpc/v1"
    v2svc "github.com/example/api/internal/grpc/v2"
)

func main() {
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        log.Fatalf("listen: %v", err)
    }

    server := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            loggingInterceptor,
            metricsInterceptor,
        ),
    )

    // Register both versions on the same server
    // Clients select by fully-qualified service name:
    // myapi.v1.UserService vs myapi.v2.UserService
    v1pb.RegisterUserServiceServer(server, v1svc.New())
    v2pb.RegisterUserServiceServer(server, v2svc.New())

    reflection.Register(server) // enables grpcurl discovery

    log.Printf("gRPC server listening on :50051")
    if err := server.Serve(lis); err != nil {
        log.Fatalf("serve: %v", err)
    }
}
```

## Section 5: Deprecation Lifecycle

### Deprecation Headers and Documentation

```go
// internal/middleware/deprecation.go
package middleware

import (
    "net/http"
    "time"
)

// Deprecation adds RFC 8594 Deprecation headers to responses.
// https://datatracker.ietf.org/doc/html/rfc8594
func Deprecation(deprecatedAt time.Time, sunsetAt time.Time, successorURL string) func(http.Handler) http.Handler {
    deprecatedAtStr := deprecatedAt.Format(http.TimeFormat)
    sunsetAtStr := sunsetAt.Format(http.TimeFormat)

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("Deprecation", deprecatedAtStr)
            w.Header().Set("Sunset", sunsetAtStr)
            if successorURL != "" {
                w.Header().Set("Link", `<`+successorURL+`>; rel="successor-version"`)
            }
            next.ServeHTTP(w, r)
        })
    }
}

// Apply to the v1 router
func v1Router() http.Handler {
    r := chi.NewRouter()

    // Mark entire v1 API as deprecated
    r.Use(middleware.Deprecation(
        time.Date(2029, 6, 1, 0, 0, 0, 0, time.UTC),   // deprecated
        time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC),   // sunset (removal)
        "https://api.example.com/api/v2",
    ))

    h := v1.NewHandlers()
    r.Get("/users", h.ListUsers)
    // ...
    return r
}
```

### Deprecation Tracking Metrics

```go
// Track which clients are still calling deprecated endpoints
func DeprecationMetrics(meter metric.Meter) func(http.Handler) http.Handler {
    counter, _ := meter.Int64Counter(
        "api.deprecated.calls",
        metric.WithDescription("Calls to deprecated API endpoints"),
    )

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            counter.Add(r.Context(), 1,
                metric.WithAttributes(
                    attribute.String("api.version", "v1"),
                    attribute.String("http.route", chi.RouteContext(r.Context()).RoutePattern()),
                    attribute.String("user_agent", r.UserAgent()),
                    // Do not include IP/user — cardinality concern
                ),
            )
            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 6: Client SDK Versioning

### Versioned Go SDK

```go
// SDK package layout:
// github.com/example/api-sdk-go/
//   v1/       — SDK for API v1
//   v2/       — SDK for API v2
//   latest/   — alias for current stable (currently v2)

// v2/client.go
package v2

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

const defaultBaseURL = "https://api.example.com/api/v2"

// Client is the API v2 client.
type Client struct {
    httpClient *http.Client
    baseURL    string
    apiKey     string
    userAgent  string
}

type Option func(*Client)

func WithBaseURL(url string) Option {
    return func(c *Client) { c.baseURL = url }
}

func WithHTTPClient(hc *http.Client) Option {
    return func(c *Client) { c.httpClient = hc }
}

func WithUserAgent(ua string) Option {
    return func(c *Client) { c.userAgent = ua }
}

func New(apiKey string, opts ...Option) *Client {
    c := &Client{
        httpClient: &http.Client{Timeout: 30 * time.Second},
        baseURL:    defaultBaseURL,
        apiKey:     apiKey,
        userAgent:  "example-go-sdk/v2.0",
    }
    for _, opt := range opts {
        opt(c)
    }
    return c
}

// GetUser retrieves a user by ID.
func (c *Client) GetUser(ctx context.Context, id string) (*User, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet,
        fmt.Sprintf("%s/users/%s", c.baseURL, id), nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Authorization", "Bearer "+c.apiKey)
    req.Header.Set("User-Agent", c.userAgent)
    req.Header.Set("Accept", "application/json")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return nil, parseErrorResponse(resp)
    }

    var user User
    if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }
    return &user, nil
}

// ListUsersOptions configures the ListUsers request.
type ListUsersOptions struct {
    PageSize  int
    PageToken string
    Filter    string // v2 addition
}

// ListUsers returns a page of users.
func (c *Client) ListUsers(ctx context.Context, opts ListUsersOptions) (*ListUsersResponse, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet,
        c.baseURL+"/users", nil)
    if err != nil {
        return nil, err
    }

    q := req.URL.Query()
    if opts.PageSize > 0 {
        q.Set("page_size", fmt.Sprintf("%d", opts.PageSize))
    }
    if opts.PageToken != "" {
        q.Set("page_token", opts.PageToken)
    }
    if opts.Filter != "" {
        q.Set("filter", opts.Filter)
    }
    req.URL.RawQuery = q.Encode()

    req.Header.Set("Authorization", "Bearer "+c.apiKey)
    req.Header.Set("User-Agent", c.userAgent)

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var result ListUsersResponse
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, err
    }
    return &result, nil
}
```

### SDK Backward Compatibility via Options Pattern

```go
// Use functional options to add new parameters without breaking callers.

// v2.1 — adds Tier filter without breaking v2.0 SDK callers
type ListOption func(*listOptions)

type listOptions struct {
    pageSize  int
    pageToken string
    filter    string
    tier      string  // added in v2.1
}

func WithPageSize(n int) ListOption {
    return func(o *listOptions) { o.pageSize = n }
}

func WithPageToken(t string) ListOption {
    return func(o *listOptions) { o.pageToken = t }
}

func WithFilter(f string) ListOption {
    return func(o *listOptions) { o.filter = f }
}

// New in v2.1 — callers on v2.0 SDK just don't use this option
func WithTier(t string) ListOption {
    return func(o *listOptions) { o.tier = t }
}

func (c *Client) ListUsersV2(ctx context.Context, opts ...ListOption) (*ListUsersResponse, error) {
    o := &listOptions{pageSize: 20} // sensible default
    for _, opt := range opts {
        opt(o)
    }
    // build request using o
    return nil, nil
}

// Callers on v2.0 SDK:
resp, err := client.ListUsersV2(ctx, WithPageSize(100))

// Callers on v2.1 SDK can add tier filter:
resp, err = client.ListUsersV2(ctx, WithPageSize(100), WithTier("enterprise"))
```

## Section 7: OpenAPI Evolution

### OpenAPI Spec per Version

```yaml
# api/v2/openapi.yaml
openapi: "3.1.0"
info:
  title: "Example API"
  version: "2.0.0"
  description: |
    Example API v2. For migration from v1, see the migration guide:
    https://docs.example.com/api/migration/v1-to-v2

servers:
  - url: "https://api.example.com/api/v2"
    description: "Production"

paths:
  /users:
    get:
      operationId: listUsers
      summary: "List users"
      parameters:
        - name: page_size
          in: query
          schema:
            type: integer
            default: 20
            maximum: 100
        - name: page_token
          in: query
          schema:
            type: string
      responses:
        "200":
          description: "Success"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ListUsersResponse"
          headers:
            Deprecation:
              description: "Present if this endpoint is deprecated"
              schema:
                type: string
            Sunset:
              description: "Present if endpoint will be removed"
              schema:
                type: string
```

### Generating Go Server Code from OpenAPI

```bash
# Generate server stubs from OpenAPI spec
go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest

# Generate strict server interface
oapi-codegen \
    --config=codegen-config.yaml \
    --package=v2 \
    api/v2/openapi.yaml \
    > internal/handlers/v2/generated.go

# codegen-config.yaml
generate:
  strict-server: true
  models: true
output-options:
  skip-prune: false
```

### API Changelog Automation

```go
// tools/api-diff/main.go
// Compare two OpenAPI specs and classify changes as breaking or non-breaking
package main

import (
    "fmt"
    "log"
    "os"

    "github.com/tufin/oasdiff/diff"
    "github.com/tufin/oasdiff/load"
    "github.com/tufin/oasdiff/report"
)

func main() {
    if len(os.Args) != 3 {
        log.Fatal("usage: api-diff <old-spec> <new-spec>")
    }

    loader := load.NewSpecLoader()
    s1, err := loader.LoadFromFile(os.Args[1])
    if err != nil {
        log.Fatalf("loading old spec: %v", err)
    }
    s2, err := loader.LoadFromFile(os.Args[2])
    if err != nil {
        log.Fatalf("loading new spec: %v", err)
    }

    d, err := diff.Get(diff.NewConfig(), s1, s2)
    if err != nil {
        log.Fatalf("diffing specs: %v", err)
    }

    breaking := report.GetBreakingChanges(d)
    if len(breaking) > 0 {
        fmt.Println("BREAKING CHANGES DETECTED:")
        for _, change := range breaking {
            fmt.Printf("  - %s\n", change)
        }
        os.Exit(1) // Fail CI when breaking changes are introduced without version bump
    }

    fmt.Println("No breaking changes detected.")
}
```

## Section 8: Version Negotiation

### Content-Type Based Versioning

```go
// Support version negotiation via Content-Type header
// Accept: application/vnd.example.api+json; version=2

func contentTypeVersion(r *http.Request) string {
    accept := r.Header.Get("Accept")
    // Parse: application/vnd.example.api+json; version=2
    parts := strings.Split(accept, ";")
    for _, part := range parts {
        part = strings.TrimSpace(part)
        if strings.HasPrefix(part, "version=") {
            return strings.TrimPrefix(part, "version=")
        }
    }
    return ""
}

// Respond with matching Content-Type
func writeVersionedJSON(w http.ResponseWriter, version string, status int, body interface{}) {
    w.Header().Set("Content-Type",
        fmt.Sprintf("application/vnd.example.api+json; version=%s", version))
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(body)
}
```

## Section 9: Testing API Versions

```go
// internal/handlers/v1/handlers_test.go
package v1_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    v1 "github.com/example/api/internal/handlers/v1"
)

// TestGetUser_v1_ResponseShape verifies that the v1 response shape
// does not change. This test should NEVER be updated to match server changes
// without a version bump.
func TestGetUser_v1_ResponseShape(t *testing.T) {
    h := v1.NewHandlers(fakeUserService())
    r := httptest.NewRequest(http.MethodGet, "/users/123", nil)
    w := httptest.NewRecorder()

    h.GetUser(w, r)

    require.Equal(t, http.StatusOK, w.Code)

    var resp map[string]interface{}
    require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))

    // Assert exact shape — fail if fields are added or removed
    expectedKeys := []string{"id", "name", "email", "created_at"}
    for _, key := range expectedKeys {
        assert.Contains(t, resp, key, "v1 response must contain %q", key)
    }

    // Assert v2-only fields are NOT present in v1 response
    v2OnlyFields := []string{"display_name", "tier", "metadata", "updated_at"}
    for _, key := range v2OnlyFields {
        assert.NotContains(t, resp, key, "v1 response must NOT contain v2-only field %q", key)
    }
}

// Contract test: v1 clients must still work with no changes
func TestV1BackwardCompatibility(t *testing.T) {
    // Record the exact v1 response from initial release
    goldenResponse := `{"id":"123","name":"Alice","email":"alice@example.com","created_at":"2029-01-01T00:00:00Z"}`

    h := v1.NewHandlers(fakeUserServiceWithFixedTime(time.Date(2029, 1, 1, 0, 0, 0, 0, time.UTC)))
    r := httptest.NewRequest(http.MethodGet, "/users/123", nil)
    w := httptest.NewRecorder()

    h.GetUser(w, r)

    assert.JSONEq(t, goldenResponse, w.Body.String(),
        "v1 response must match golden response exactly")
}
```

## Section 10: Production Checklist

- [ ] Versioning strategy chosen (URL path, header, or content-type) and documented
- [ ] Version-specific request/response types defined separately (no shared structs across versions)
- [ ] Domain model decoupled from API types (translation layer at handler boundary)
- [ ] Protobuf field numbers never reused; removed fields reserved with `reserved` keyword
- [ ] gRPC: versioned proto packages for major changes (`myapi.v1`, `myapi.v2`)
- [ ] Deprecation headers (RFC 8594: `Deprecation`, `Sunset`) added to deprecated routes
- [ ] Deprecation metrics tracking which clients are calling deprecated endpoints
- [ ] Sunset date communicated to clients with at least 12 months notice
- [ ] Client SDK uses functional options pattern for backward-compatible extension
- [ ] OpenAPI spec per version committed to repository and validated in CI
- [ ] API diff tool in CI pipeline — fails on breaking changes without version bump
- [ ] Golden response tests for each version — fail if v1 response shape changes
- [ ] Migration guide published when introducing a new major version

## Conclusion

Long-lived APIs require discipline at every level: in your proto files, in your Go type definitions, in your router setup, in your SDK design, and in your change management process. The most important habit is treating each version as a contract — once published, the contract cannot change without incrementing the version.

For REST, URL path versioning is the most explicit and easiest to operate. For gRPC, the protobuf field number rules are your contract. In both cases, the functional options pattern in Go SDKs and the deprecation lifecycle headers are what turn a "version upgrade" from a breaking event into a smooth migration over months.
