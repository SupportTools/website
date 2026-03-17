---
title: "Go API Versioning: URL Versioning, Header Negotiation, and Backward Compatibility Strategies"
date: 2030-03-04T00:00:00-05:00
draft: false
tags: ["Go", "API Design", "REST", "Versioning", "Backward Compatibility", "Microservices"]
categories: ["Go", "API Design"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement API versioning in Go microservices with URL versioning, Accept header negotiation, schema evolution with protobuf and JSON, and disciplined deprecation workflows."
more_link: "yes"
url: "/go-api-versioning-url-header-backward-compatibility/"
---

API versioning is one of those problems that feels manageable until you have multiple client teams, multiple API versions in production, and a roadmap that requires breaking changes. The strategies you choose in the first API version — URL paths, header negotiation, schema design — determine how painful or painless the next three years of API evolution will be.

This guide covers the versioning approaches that work in production Go microservices, the mechanisms for content negotiation, schema evolution patterns that avoid breaking clients, and the operational workflows for deprecating API versions without causing incidents.

<!--more-->

## Versioning Strategy Comparison

No single versioning strategy is universally correct. The choice depends on your clients, your team structure, and your API's expected evolution rate.

| Strategy | Pros | Cons | Best For |
|----------|------|------|----------|
| URL path (`/v1/users`) | Simple, cacheable, explicit | URL changes on version bump, REST purists object | Public APIs, simple clients |
| Accept header (`Accept: application/vnd.myapi.v2+json`) | RESTful, same URL | Harder to test in browser/curl, proxy complexity | Internal microservices |
| Query parameter (`?version=2`) | Easy to add, no routing change | Not idiomatic HTTP, pollutes query space | Gradual migration only |
| Custom header (`X-API-Version: 2`) | Simple to implement | Not standard | Internal services with controlled clients |

For most production APIs, URL versioning provides the best balance of simplicity, debuggability, and cacheability. Accept header negotiation is excellent for internal services where you control all clients. Never use query parameter versioning as the primary strategy.

## URL-Based Versioning in Go

### Router Setup with Version Isolation

```go
// cmd/server/main.go
package main

import (
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"

    v1 "github.com/myorg/api/internal/api/v1"
    v2 "github.com/myorg/api/internal/api/v2"
    v3 "github.com/myorg/api/internal/api/v3"
)

func main() {
    r := chi.NewRouter()

    // Global middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)

    // Version-specific route groups
    r.Mount("/v1", v1.NewRouter())
    r.Mount("/v2", v2.NewRouter())
    r.Mount("/v3", v3.NewRouter())

    // Latest version alias (optional - can help clients not hardcode versions)
    r.Mount("/latest", v3.NewRouter())

    // Redirect bare /api to /v3 for browser convenience
    r.Get("/api", func(w http.ResponseWriter, r *http.Request) {
        http.Redirect(w, r, "/v3", http.StatusMovedPermanently)
    })

    http.ListenAndServe(":8080", r)
}
```

### Version-Specific Handler Packages

Each version is a separate Go package with its own types and handlers:

```
internal/api/
├── v1/
│   ├── router.go
│   ├── handlers/
│   │   ├── users.go
│   │   └── orders.go
│   └── types/
│       ├── user.go
│       └── order.go
├── v2/
│   ├── router.go
│   ├── handlers/
│   │   ├── users.go
│   │   └── orders.go
│   └── types/
│       ├── user.go
│       └── order.go
└── v3/
    ├── router.go
    └── handlers/
        └── users.go
```

```go
// internal/api/v1/router.go
package v1

import (
    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "github.com/myorg/api/internal/api/v1/handlers"
    "github.com/myorg/api/internal/service"
)

func NewRouter() *chi.Mux {
    r := chi.NewRouter()

    // Add deprecation header to all v1 responses
    r.Use(func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("Deprecation", "true")
            w.Header().Set("Sunset", "Sat, 01 Jan 2031 00:00:00 GMT")
            w.Header().Set("Link", `</v3/users>; rel="successor-version"`)
            next.ServeHTTP(w, r)
        })
    })

    userHandler := handlers.NewUserHandler(service.GetUserService())

    r.Get("/users", userHandler.List)
    r.Post("/users", userHandler.Create)
    r.Get("/users/{id}", userHandler.Get)
    r.Put("/users/{id}", userHandler.Update)
    r.Delete("/users/{id}", userHandler.Delete)

    return r
}
```

### V1 Types (Original API)

```go
// internal/api/v1/types/user.go
package v1types

// UserV1 is the original user representation
type UserV1 struct {
    ID        int64  `json:"id"`
    Name      string `json:"name"`       // Full name in one field
    Email     string `json:"email"`
    CreatedAt int64  `json:"created_at"` // Unix timestamp
}

type CreateUserRequestV1 struct {
    Name     string `json:"name"`
    Email    string `json:"email"`
    Password string `json:"password"`
}

type ListUsersResponseV1 struct {
    Users  []UserV1 `json:"users"`
    Total  int      `json:"total"`
    Offset int      `json:"offset"`
    Limit  int      `json:"limit"`
}
```

### V2 Types (Breaking Changes)

```go
// internal/api/v2/types/user.go
package v2types

// UserV2 splits name into first/last and changes timestamp to RFC3339
type UserV2 struct {
    ID        int64  `json:"id"`
    FirstName string `json:"first_name"`  // BREAKING: name field split
    LastName  string `json:"last_name"`   // BREAKING: name field split
    Email     string `json:"email"`
    CreatedAt string `json:"created_at"`  // BREAKING: changed from int64 to string
    UpdatedAt string `json:"updated_at"`  // NEW: added field
}

type CreateUserRequestV2 struct {
    FirstName string `json:"first_name"`
    LastName  string `json:"last_name"`
    Email     string `json:"email"`
    Password  string `json:"password"`
}

type ListUsersResponseV2 struct {
    Users      []UserV2 `json:"users"`
    Total      int      `json:"total"`
    Pagination struct {
        Page     int `json:"page"`
        PageSize int `json:"page_size"`
        Pages    int `json:"pages"`
    } `json:"pagination"`  // BREAKING: changed from offset/limit to page-based
}
```

### Domain Model Isolation

The key principle: each version translates between its own types and the shared domain model:

```go
// internal/domain/user.go - the canonical internal representation
package domain

import "time"

type User struct {
    ID        int64
    FirstName string
    LastName  string
    Email     string
    CreatedAt time.Time
    UpdatedAt time.Time
}

func (u *User) FullName() string {
    return u.FirstName + " " + u.LastName
}
```

```go
// internal/api/v1/handlers/users.go
package handlers

import (
    "encoding/json"
    "net/http"
    "strconv"

    "github.com/go-chi/chi/v5"
    "github.com/myorg/api/internal/domain"
    v1types "github.com/myorg/api/internal/api/v1/types"
)

type UserHandler struct {
    svc UserService
}

func (h *UserHandler) Get(w http.ResponseWriter, r *http.Request) {
    id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
    if err != nil {
        http.Error(w, "invalid id", http.StatusBadRequest)
        return
    }

    user, err := h.svc.GetUser(r.Context(), id)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    // Convert domain type to V1 API type
    response := domainToV1(user)

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

// domainToV1 converts domain.User to v1types.UserV1
// This is the adapter layer between domain model and API contract
func domainToV1(u *domain.User) v1types.UserV1 {
    return v1types.UserV1{
        ID:        u.ID,
        Name:      u.FullName(),
        Email:     u.Email,
        CreatedAt: u.CreatedAt.Unix(),
    }
}
```

```go
// internal/api/v2/handlers/users.go
package handlers

import (
    "github.com/myorg/api/internal/domain"
    v2types "github.com/myorg/api/internal/api/v2/types"
)

func domainToV2(u *domain.User) v2types.UserV2 {
    return v2types.UserV2{
        ID:        u.ID,
        FirstName: u.FirstName,
        LastName:  u.LastName,
        Email:     u.Email,
        CreatedAt: u.CreatedAt.Format(time.RFC3339),
        UpdatedAt: u.UpdatedAt.Format(time.RFC3339),
    }
}
```

## Accept Header Content Negotiation

Content negotiation allows clients to request a specific representation via the `Accept` header, keeping URLs stable:

```
GET /users/123 HTTP/1.1
Accept: application/vnd.myapi.v2+json

GET /users/123 HTTP/1.1
Accept: application/vnd.myapi.v3+json
```

### Implementing Content Negotiation

```go
// internal/api/negotiation/negotiation.go
package negotiation

import (
    "net/http"
    "strings"
)

// MediaType represents a versioned media type
type MediaType struct {
    Vendor  string
    Version int
    Type    string // "json", "msgpack", etc.
}

// Parse parses a vendor media type like "application/vnd.myapi.v2+json"
func Parse(accept string) (MediaType, bool) {
    // Handle multiple Accept values (comma-separated)
    for _, part := range strings.Split(accept, ",") {
        part = strings.TrimSpace(strings.Split(part, ";")[0]) // remove quality values

        if !strings.HasPrefix(part, "application/vnd.myapi.v") {
            continue
        }

        // Extract version and format
        // Format: application/vnd.myapi.v{N}+{format}
        rest := strings.TrimPrefix(part, "application/vnd.myapi.v")
        parts := strings.SplitN(rest, "+", 2)
        if len(parts) != 2 {
            continue
        }

        var version int
        if _, err := fmt.Sscanf(parts[0], "%d", &version); err != nil {
            continue
        }

        return MediaType{
            Vendor:  "myapi",
            Version: version,
            Type:    parts[1],
        }, true
    }

    return MediaType{}, false
}

// VersionFromRequest extracts the API version from a request.
// Priority: Accept header > URL path > default
func VersionFromRequest(r *http.Request) int {
    // Check Accept header first
    if mt, ok := Parse(r.Header.Get("Accept")); ok {
        return mt.Version
    }

    // Check URL path (/v1/..., /v2/...)
    path := r.URL.Path
    for _, segment := range strings.Split(path, "/") {
        if len(segment) > 1 && segment[0] == 'v' {
            var v int
            if _, err := fmt.Sscanf(segment[1:], "%d", &v); err == nil {
                return v
            }
        }
    }

    return 3 // Default to latest
}
```

### Unified Handler with Negotiation

```go
// internal/api/users.go - Single handler serving multiple versions
package api

import (
    "encoding/json"
    "net/http"
    "strconv"

    "github.com/go-chi/chi/v5"
    "github.com/myorg/api/internal/api/negotiation"
    "github.com/myorg/api/internal/domain"
    v1types "github.com/myorg/api/internal/api/v1/types"
    v2types "github.com/myorg/api/internal/api/v2/types"
    v3types "github.com/myorg/api/internal/api/v3/types"
)

type UnifiedUserHandler struct {
    svc UserService
}

func (h *UnifiedUserHandler) Get(w http.ResponseWriter, r *http.Request) {
    id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)

    user, err := h.svc.GetUser(r.Context(), id)
    if err != nil {
        writeError(w, err)
        return
    }

    version := negotiation.VersionFromRequest(r)

    var response interface{}
    var contentType string

    switch version {
    case 1:
        response = domainToV1(user)
        contentType = "application/vnd.myapi.v1+json"
    case 2:
        response = domainToV2(user)
        contentType = "application/vnd.myapi.v2+json"
    default: // v3 and above
        response = domainToV3(user)
        contentType = "application/vnd.myapi.v3+json"
    }

    w.Header().Set("Content-Type", contentType)
    w.Header().Set("Vary", "Accept")  // Important for caches
    json.NewEncoder(w).Encode(response)
}
```

## Schema Evolution: Backward-Compatible Changes

Not all API changes require a version bump. These changes are backward-compatible:

### Adding Optional Fields

```go
// V2 response with new optional field - existing V2 clients continue to work
// because JSON unmarshaling ignores unknown fields by default
type UserV2 struct {
    ID        int64  `json:"id"`
    FirstName string `json:"first_name"`
    LastName  string `json:"last_name"`
    Email     string `json:"email"`
    CreatedAt string `json:"created_at"`
    UpdatedAt string `json:"updated_at"`

    // New optional field - backward compatible because it has a zero value
    // Old clients ignore it; new clients can use it
    // +optional
    PhoneNumber *string `json:"phone_number,omitempty"`

    // New optional nested object
    // +optional
    Preferences *UserPreferences `json:"preferences,omitempty"`
}

type UserPreferences struct {
    Theme    string `json:"theme"`
    Language string `json:"language"`
    Timezone string `json:"timezone"`
}
```

### Expanding Enum Values

Adding new values to an enum is backward-compatible IF clients handle unknown values gracefully:

```go
// ClientCode for clients: always handle unknown enum values
type UserStatus string

const (
    UserStatusActive    UserStatus = "active"
    UserStatusInactive  UserStatus = "inactive"
    UserStatusSuspended UserStatus = "suspended"
    // New value added in v2.3 - clients should handle this gracefully
    UserStatusPending   UserStatus = "pending"
)

// Client-side: use a default for unknown values
func parseUserStatus(s string) UserStatus {
    switch UserStatus(s) {
    case UserStatusActive, UserStatusInactive, UserStatusSuspended, UserStatusPending:
        return UserStatus(s)
    default:
        return UserStatusActive // or handle unknown gracefully
    }
}
```

## Protobuf for Schema Evolution

protobuf provides built-in schema evolution support:

```protobuf
// api/proto/v1/user.proto
syntax = "proto3";
package myapi.v1;

option go_package = "github.com/myorg/api/gen/v1;v1";

message User {
    int64 id = 1;
    string name = 2;           // Full name in v1
    string email = 3;
    int64 created_at = 4;      // Unix timestamp
}

message CreateUserRequest {
    string name = 1;
    string email = 2;
    string password = 3;
}
```

```protobuf
// api/proto/v2/user.proto
syntax = "proto3";
package myapi.v2;

option go_package = "github.com/myorg/api/gen/v2;v2";

// Evolution rules:
// 1. Never reuse field numbers
// 2. Never change field types (in an incompatible way)
// 3. Never rename fields (wire format uses numbers, not names)
// 4. OK to add new fields
// 5. Use reserved to prevent future reuse of removed field numbers

message User {
    int64 id = 1;
    // Field 2 (name) removed - replaced by first_name and last_name
    reserved 2;
    reserved "name";

    string email = 3;
    // Field 4 (created_at as int64) repurposed as string in v2
    // This is a wire break - must be a new field number
    reserved 4;
    reserved "created_at";

    string first_name = 5;    // New: was part of name
    string last_name = 6;     // New: was part of name
    string created_at_rfc = 7;  // New field number for changed type
    string updated_at = 8;    // New field
}
```

## Deprecation Workflow

### HTTP Deprecation Headers (RFC 8594)

```go
// middleware/deprecation.go
package middleware

import (
    "fmt"
    "net/http"
    "time"
)

type DeprecationConfig struct {
    // When the version was deprecated
    DeprecatedAt time.Time
    // When the version will be removed (Sunset date per RFC 8594)
    SunsetAt time.Time
    // URL of the successor version
    SuccessorURL string
    // Migration guide URL
    MigrationGuideURL string
}

func DeprecationMiddleware(cfg DeprecationConfig) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // RFC 8594 deprecation header
            w.Header().Set("Deprecation", cfg.DeprecatedAt.Format(time.RFC1123))

            // Sunset header (when this version is removed)
            w.Header().Set("Sunset", cfg.SunsetAt.Format(time.RFC1123))

            // Link header pointing to successor
            if cfg.SuccessorURL != "" {
                w.Header().Add("Link",
                    fmt.Sprintf(`<%s>; rel="successor-version"`, cfg.SuccessorURL))
            }

            // Link to migration guide
            if cfg.MigrationGuideURL != "" {
                w.Header().Add("Link",
                    fmt.Sprintf(`<%s>; rel="deprecation"`, cfg.MigrationGuideURL))
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

```go
// In v1 router:
r.Use(middleware.DeprecationMiddleware(middleware.DeprecationConfig{
    DeprecatedAt:      time.Date(2029, 1, 1, 0, 0, 0, 0, time.UTC),
    SunsetAt:          time.Date(2031, 1, 1, 0, 0, 0, 0, time.UTC),
    SuccessorURL:      "https://api.example.com/v3",
    MigrationGuideURL: "https://docs.example.com/migration/v1-to-v3",
}))
```

### Tracking Deprecated Version Usage

```go
// middleware/version_tracking.go
package middleware

import (
    "net/http"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    apiVersionRequests = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "api_version_requests_total",
            Help: "Total requests per API version",
        },
        []string{"version", "method", "path", "status"},
    )

    deprecatedAPIRequests = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "deprecated_api_requests_total",
            Help: "Requests to deprecated API versions",
        },
        []string{"version", "client_id"},
    )
)

func VersionTrackingMiddleware(version string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            wrapped := &responseWriter{ResponseWriter: w, status: 200}
            next.ServeHTTP(wrapped, r)

            apiVersionRequests.WithLabelValues(
                version,
                r.Method,
                r.URL.Path,
                strconv.Itoa(wrapped.status),
            ).Inc()
        })
    }
}

func DeprecatedVersionTrackingMiddleware(version string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            clientID := r.Header.Get("X-Client-ID")
            if clientID == "" {
                clientID = "unknown"
            }

            deprecatedAPIRequests.WithLabelValues(version, clientID).Inc()

            next.ServeHTTP(w, r)
        })
    }
}
```

```yaml
# Prometheus alert for deprecated API usage
groups:
  - name: api-deprecation
    rules:
      - alert: DeprecatedAPIVersionInUse
        expr: |
          sum by (version, client_id) (
            rate(deprecated_api_requests_total[5m])
          ) > 0
        labels:
          severity: info
        annotations:
          summary: "Client {{ $labels.client_id }} is using deprecated API {{ $labels.version }}"
          description: "Consider reaching out to help them migrate before the sunset date."

      - alert: DeprecatedAPIVersionHighTraffic
        expr: |
          sum by (version) (
            rate(deprecated_api_requests_total[1h])
          ) > 10
        labels:
          severity: warning
        annotations:
          summary: "High traffic on deprecated API version {{ $labels.version }}"
```

## Sunset Implementation

When a version reaches its sunset date, return 410 Gone:

```go
// middleware/sunset.go
package middleware

import (
    "encoding/json"
    "net/http"
    "time"
)

type SunsetMiddleware struct {
    SunsetAt    time.Time
    Version     string
    SuccessorURL string
}

func (s *SunsetMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if time.Now().After(s.SunsetAt) {
            w.Header().Set("Content-Type", "application/json")
            w.Header().Set("Link",
                fmt.Sprintf(`<%s>; rel="successor-version"`, s.SuccessorURL))
            w.WriteHeader(http.StatusGone)
            json.NewEncoder(w).Encode(map[string]interface{}{
                "error": "api_version_sunset",
                "message": fmt.Sprintf(
                    "API version %s was sunset on %s. Please migrate to %s",
                    s.Version,
                    s.SunsetAt.Format("2006-01-02"),
                    s.SuccessorURL,
                ),
                "successor_url": s.SuccessorURL,
                "sunset_date": s.SunsetAt.Format("2006-01-02"),
            })
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

## Testing API Versioning

```go
// internal/api/version_compat_test.go
package api_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    v1types "github.com/myorg/api/internal/api/v1/types"
    v2types "github.com/myorg/api/internal/api/v2/types"
)

// TestVersionContract verifies that each version's contract is stable
func TestVersionContract_V1UserResponse(t *testing.T) {
    server := setupTestServer(t)

    resp, err := http.Get(server.URL + "/v1/users/123")
    if err != nil {
        t.Fatal(err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        t.Fatalf("expected 200, got %d", resp.StatusCode)
    }

    // Verify exact V1 contract: must have these fields, must NOT have v2 fields
    var user map[string]interface{}
    json.NewDecoder(resp.Body).Decode(&user)

    // V1 contract: has 'name' field
    if _, ok := user["name"]; !ok {
        t.Error("V1 contract: missing 'name' field")
    }

    // V1 contract: does NOT have 'first_name'/'last_name'
    if _, ok := user["first_name"]; ok {
        t.Error("V1 contract violation: 'first_name' should not be in V1 response")
    }

    // V1 contract: created_at is an integer (Unix timestamp)
    createdAt, ok := user["created_at"].(float64) // JSON numbers are float64
    if !ok {
        t.Errorf("V1 contract: created_at should be an integer, got %T", user["created_at"])
    }
    if createdAt < 0 {
        t.Error("V1 contract: created_at should be a positive Unix timestamp")
    }
}

func TestVersionContract_V2UserResponse(t *testing.T) {
    server := setupTestServer(t)

    resp, err := http.Get(server.URL + "/v2/users/123")
    if err != nil {
        t.Fatal(err)
    }
    defer resp.Body.Close()

    var user map[string]interface{}
    json.NewDecoder(resp.Body).Decode(&user)

    // V2 contract: has first_name and last_name
    if _, ok := user["first_name"]; !ok {
        t.Error("V2 contract: missing 'first_name'")
    }
    if _, ok := user["last_name"]; !ok {
        t.Error("V2 contract: missing 'last_name'")
    }

    // V2 contract: created_at is a string (RFC3339)
    createdAt, ok := user["created_at"].(string)
    if !ok {
        t.Errorf("V2 contract: created_at should be a string, got %T", user["created_at"])
    }
    if _, err := time.Parse(time.RFC3339, createdAt); err != nil {
        t.Errorf("V2 contract: created_at should be RFC3339, got %q: %v", createdAt, err)
    }
}

// TestBackwardCompatibility verifies V1 clients still work after internal changes
func TestBackwardCompatibility_AddingFieldsDoesNotBreakV1(t *testing.T) {
    server := setupTestServer(t)

    resp, _ := http.Get(server.URL + "/v1/users/123")
    defer resp.Body.Close()

    // V1 client only cares about these fields
    var v1User v1types.UserV1
    if err := json.NewDecoder(resp.Body).Decode(&v1User); err != nil {
        t.Fatalf("V1 client failed to parse response: %v", err)
    }

    // Verify the fields V1 clients depend on are present and correct type
    if v1User.ID == 0 {
        t.Error("V1 compatibility: ID should not be zero")
    }
    if v1User.Email == "" {
        t.Error("V1 compatibility: Email should not be empty")
    }
}
```

## Versioning with gRPC and protobuf

For gRPC services, package-based versioning is idiomatic:

```protobuf
// api/proto/user/v1/user_service.proto
syntax = "proto3";
package user.v1;
option go_package = "github.com/myorg/api/gen/user/v1;userv1";

service UserService {
    rpc GetUser (GetUserRequest) returns (User);
    rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);
    rpc CreateUser (CreateUserRequest) returns (User);
}
```

```go
// internal/grpc/user_v1_server.go
package grpc

import (
    "context"

    userv1 "github.com/myorg/api/gen/user/v1"
    "github.com/myorg/api/internal/domain"
)

type UserServiceV1 struct {
    userv1.UnimplementedUserServiceServer
    svc domain.UserService
}

// Register both versions on the same gRPC server
func RegisterHandlers(server *grpc.Server, svc domain.UserService) {
    userv1.RegisterUserServiceServer(server, &UserServiceV1{svc: svc})
    userv2.RegisterUserServiceServer(server, &UserServiceV2{svc: svc})
}
```

## Key Takeaways

API versioning done well makes breaking changes manageable and keeps client teams from being blocked by server changes:

1. **URL versioning is simplest and most cache-friendly**: Use it as the default. Add Accept header negotiation only if you need very fine-grained control or are optimizing for REST purity.
2. **Version packages, not handlers**: Each API version should be a separate Go package with its own types. The domain model is shared; the API representation is per-version.
3. **Backward-compatible changes extend existing versions**: Adding optional fields, adding enum values, and adding new endpoints do not require a new version. Reserve new versions for actual breaking changes.
4. **Deprecation headers communicate sunset dates in-band**: Use RFC 8594 `Deprecation` and `Sunset` headers so clients can programmatically detect when they need to migrate.
5. **Track deprecated version usage with metrics**: You cannot sunset a version if you don't know who is still using it. Prometheus metrics on version + client ID give you the data to identify and contact clients.
6. **Contract tests prevent accidental breaks**: Tests that verify the exact JSON schema of each version's response catch regressions when internal domain models change.
7. **Plan for at most 3 active versions**: More than three versions in production simultaneously creates a maintenance burden that grows faster than the team can manage.
