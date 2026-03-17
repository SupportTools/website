---
title: "Go API Versioning: URL Path, Header, and Content Negotiation Strategies"
date: 2031-05-13T00:00:00-05:00
draft: false
tags: ["Go", "API", "REST", "Versioning", "OpenAPI", "chi", "gin", "gRPC"]
categories:
- Go
- API Design
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go API versioning strategies covering URL path versioning with chi/gin, Accept header versioning, custom media type content negotiation, sunset policies, backward compatibility testing, and versioned OpenAPI schema management."
more_link: "yes"
url: "/go-api-versioning-url-path-header-content-negotiation/"
---

API versioning is the contract management layer between your service and its consumers. Get it wrong and you either break consumers with every release or trap yourself in a legacy implementation you can't escape. Get it right and you can evolve your API surface freely while maintaining stability for existing clients.

Go's type system and interface model make versioning patterns that would be verbose in other languages surprisingly clean. This guide covers the three primary versioning strategies — URL path, Accept header, and content negotiation — with production-grade implementations using chi and gin, automated backward compatibility testing, and the operational discipline of sunset policies.

<!--more-->

# Go API Versioning: URL Path, Header, and Content Negotiation Strategies

## Section 1: URL Path Versioning

URL path versioning (`/v1/users`, `/v2/users`) is the most operationally visible approach. Clients know exactly which version they're calling, proxies can route by version, and logs make version distribution obvious.

### 1.1 Routing Structure with chi

```go
// internal/api/router.go
package api

import (
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "github.com/go-chi/cors"

    v1 "myapp/internal/api/v1"
    v2 "myapp/internal/api/v2"
)

func NewRouter(deps Dependencies) http.Handler {
    r := chi.NewRouter()

    // Global middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Use(middleware.StripSlashes)

    r.Use(cors.Handler(cors.Options{
        AllowedOrigins:   []string{"https://app.example.com"},
        AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
        AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
        ExposedHeaders:   []string{"X-Request-ID", "Sunset", "Deprecation"},
        MaxAge:           300,
    }))

    // Health and metrics (unversioned)
    r.Get("/healthz", healthHandler)
    r.Get("/readyz", readyHandler)
    r.Get("/metrics", metricsHandler)

    // API v1 (with deprecation notice)
    r.Mount("/v1", v1.NewRouter(deps))

    // API v2 (current stable)
    r.Mount("/v2", v2.NewRouter(deps))

    // Convenience: /api/v1 and /api/v2 aliases
    r.Mount("/api/v1", v1.NewRouter(deps))
    r.Mount("/api/v2", v2.NewRouter(deps))

    return r
}
```

### 1.2 V1 Handler Package

```go
// internal/api/v1/router.go
package v1

import (
    "net/http"
    "time"

    "github.com/go-chi/chi/v5"
)

// V1 is deprecated as of 2031-01-01, sunset on 2031-12-31
const (
    DeprecationDate = "2031-01-01"
    SunsetDate      = "2031-12-31"
    SunsetLink      = "https://docs.example.com/api/v1/migration-guide"
)

func NewRouter(deps Dependencies) http.Handler {
    r := chi.NewRouter()

    // Add deprecation headers to all v1 responses
    r.Use(deprecationMiddleware)

    r.Route("/users", func(r chi.Router) {
        r.Get("/", deps.UserHandler.List)
        r.Post("/", deps.UserHandler.Create)
        r.Get("/{id}", deps.UserHandler.Get)
        r.Put("/{id}", deps.UserHandler.Update)
        r.Delete("/{id}", deps.UserHandler.Delete)
    })

    r.Route("/orders", func(r chi.Router) {
        r.Get("/", deps.OrderHandler.List)
        r.Post("/", deps.OrderHandler.Create)
    })

    return r
}

// deprecationMiddleware adds Deprecation and Sunset headers per RFC 8594
func deprecationMiddleware(next http.Handler) http.Handler {
    sunsetTime, _ := time.Parse("2006-01-02", SunsetDate)
    deprecationTime, _ := time.Parse("2006-01-02", DeprecationDate)

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // RFC 8594 Deprecation header (HTTP date format)
        w.Header().Set("Deprecation", deprecationTime.UTC().Format(http.TimeFormat))

        // Sunset header with link to migration guide
        w.Header().Set("Sunset", sunsetTime.UTC().Format(http.TimeFormat))
        w.Header().Set("Link", `<`+SunsetLink+`>; rel="sunset"`)

        next.ServeHTTP(w, r)
    })
}
```

### 1.3 V1 and V2 Response Models

The key to clean URL versioning is having distinct, independent model types per version. Don't share models between versions:

```go
// internal/api/v1/models/user.go
package models

// UserV1 - original user model
// DEPRECATED: Use UserV2 for new clients
type UserV1 struct {
    ID        string `json:"id"`
    Name      string `json:"name"`       // Combined first+last
    Email     string `json:"email"`
    CreatedAt string `json:"created_at"` // RFC3339 string (inconsistent, fixed in v2)
    Role      string `json:"role"`       // Single role string (v2 supports multiple)
}

type UserListV1 struct {
    Users  []UserV1 `json:"users"`
    Total  int      `json:"total"`
    Offset int      `json:"offset"`
    Limit  int      `json:"limit"`
}
```

```go
// internal/api/v2/models/user.go
package models

import "time"

// UserV2 - improved user model with breaking changes from v1
type UserV2 struct {
    ID        string    `json:"id"`
    FirstName string    `json:"first_name"`  // Split from v1's Name field
    LastName  string    `json:"last_name"`
    Email     string    `json:"email"`
    CreatedAt time.Time `json:"created_at"`  // Proper time.Time (marshals to RFC3339)
    Roles     []string  `json:"roles"`        // Multiple roles
    Metadata  Metadata  `json:"metadata,omitempty"`
}

type Metadata struct {
    Labels      map[string]string `json:"labels,omitempty"`
    Annotations map[string]string `json:"annotations,omitempty"`
}

type UserListV2 struct {
    Items      []UserV2   `json:"items"`
    Pagination Pagination `json:"pagination"`
}

type Pagination struct {
    Total   int    `json:"total"`
    Cursor  string `json:"cursor,omitempty"`  // Cursor-based pagination (replaces offset)
    HasMore bool   `json:"has_more"`
}
```

### 1.4 Domain-to-API Model Converters

The service layer uses domain models. Converters translate to API version models:

```go
// internal/api/v1/converters/user.go
package converters

import (
    "fmt"
    "time"

    "myapp/internal/domain"
    modelsv1 "myapp/internal/api/v1/models"
)

func UserToV1(u *domain.User) modelsv1.UserV1 {
    return modelsv1.UserV1{
        ID:        u.ID.String(),
        Name:      fmt.Sprintf("%s %s", u.FirstName, u.LastName),
        Email:     u.Email,
        CreatedAt: u.CreatedAt.Format(time.RFC3339),
        Role:      primaryRole(u.Roles), // Take first role for v1 compatibility
    }
}

func primaryRole(roles []string) string {
    if len(roles) == 0 {
        return "viewer"
    }
    // Priority order for v1 compatibility
    for _, priority := range []string{"admin", "editor", "viewer"} {
        for _, r := range roles {
            if r == priority {
                return r
            }
        }
    }
    return roles[0]
}
```

```go
// internal/api/v2/converters/user.go
package converters

import (
    "myapp/internal/domain"
    modelsv2 "myapp/internal/api/v2/models"
)

func UserToV2(u *domain.User) modelsv2.UserV2 {
    return modelsv2.UserV2{
        ID:        u.ID.String(),
        FirstName: u.FirstName,
        LastName:  u.LastName,
        Email:     u.Email,
        CreatedAt: u.CreatedAt,
        Roles:     u.Roles,
        Metadata: modelsv2.Metadata{
            Labels:      u.Labels,
            Annotations: u.Annotations,
        },
    }
}

func UsersToV2List(users []*domain.User, cursor string, hasMore bool) modelsv2.UserListV2 {
    items := make([]modelsv2.UserV2, len(users))
    for i, u := range users {
        items[i] = UserToV2(u)
    }
    return modelsv2.UserListV2{
        Items: items,
        Pagination: modelsv2.Pagination{
            Total:   len(users),
            Cursor:  cursor,
            HasMore: hasMore,
        },
    }
}
```

## Section 2: URL Path Versioning with Gin

```go
// internal/api/router_gin.go
package api

import (
    "github.com/gin-gonic/gin"

    v1handlers "myapp/internal/api/v1/handlers"
    v2handlers "myapp/internal/api/v2/handlers"
)

func SetupGinRouter(deps Dependencies) *gin.Engine {
    gin.SetMode(gin.ReleaseMode)
    r := gin.New()

    r.Use(gin.Recovery())
    r.Use(requestIDMiddleware())
    r.Use(metricsMiddleware())

    // V1 group with deprecation middleware
    v1 := r.Group("/v1")
    v1.Use(ginDeprecationMiddleware("2031-12-31", "https://docs.example.com/api/v1/migration"))
    {
        users := v1.Group("/users")
        uh1 := v1handlers.NewUserHandler(deps.UserService)
        users.GET("", uh1.List)
        users.POST("", uh1.Create)
        users.GET("/:id", uh1.Get)
        users.PUT("/:id", uh1.Update)
        users.DELETE("/:id", uh1.Delete)
    }

    // V2 group (current)
    v2 := r.Group("/v2")
    {
        users := v2.Group("/users")
        uh2 := v2handlers.NewUserHandler(deps.UserService)
        users.GET("", uh2.List)
        users.POST("", uh2.Create)
        users.GET("/:id", uh2.Get)
        users.PATCH("/:id", uh2.Update)   // v2 uses PATCH instead of PUT
        users.DELETE("/:id", uh2.Delete)

        // New in v2: user roles management
        users.GET("/:id/roles", uh2.GetRoles)
        users.POST("/:id/roles", uh2.AddRole)
        users.DELETE("/:id/roles/:role", uh2.RemoveRole)
    }

    return r
}

func ginDeprecationMiddleware(sunsetDate, migrationLink string) gin.HandlerFunc {
    return func(c *gin.Context) {
        c.Header("Sunset", sunsetDate)
        c.Header("Link", `<`+migrationLink+`>; rel="sunset"`)
        c.Header("Deprecation", "true")
        c.Next()
    }
}
```

## Section 3: Accept Header Versioning

Header versioning keeps URLs clean but requires clients to set the `Accept` header explicitly. Less visible in browser address bars but common in enterprise APIs.

### 3.1 Accept Header Version Parser

```go
// internal/api/versioning/accept.go
package versioning

import (
    "fmt"
    "mime"
    "net/http"
    "strconv"
    "strings"
)

type Version struct {
    Major int
    Minor int
}

func (v Version) String() string {
    return fmt.Sprintf("%d.%d", v.Major, v.Minor)
}

// ParseAcceptVersion extracts version from Accept header
// Accepts: application/json; version=2, application/vnd.myapp.v2+json
func ParseAcceptVersion(r *http.Request) (Version, error) {
    accept := r.Header.Get("Accept")
    if accept == "" {
        return Version{Major: 1}, nil // Default to v1
    }

    // Check for versioned media type: application/vnd.myapp.v2+json
    if v, ok := parseVendorMediaType(accept); ok {
        return v, nil
    }

    // Check for version parameter: application/json; version=2.0
    mediaType, params, err := mime.ParseMediaType(accept)
    if err != nil {
        return Version{}, fmt.Errorf("invalid Accept header: %w", err)
    }
    _ = mediaType

    if versionStr, ok := params["version"]; ok {
        return parseVersionString(versionStr)
    }

    // Check X-API-Version header as fallback
    if versionStr := r.Header.Get("X-API-Version"); versionStr != "" {
        return parseVersionString(versionStr)
    }

    return Version{Major: 1}, nil // Default
}

func parseVendorMediaType(accept string) (Version, bool) {
    // Match: application/vnd.myapp.v2+json or application/vnd.myapp.v2.1+json
    for _, part := range strings.Split(accept, ",") {
        part = strings.TrimSpace(part)
        if strings.Contains(part, "vnd.myapp.v") {
            // Extract version number
            start := strings.Index(part, "vnd.myapp.v") + len("vnd.myapp.v")
            end := strings.Index(part[start:], "+")
            if end == -1 {
                end = strings.Index(part[start:], ";")
            }
            if end == -1 {
                end = len(part[start:])
            }
            versionStr := part[start : start+end]
            if v, err := parseVersionString(versionStr); err == nil {
                return v, true
            }
        }
    }
    return Version{}, false
}

func parseVersionString(s string) (Version, error) {
    parts := strings.Split(strings.TrimPrefix(s, "v"), ".")
    if len(parts) == 0 {
        return Version{}, fmt.Errorf("empty version string")
    }

    major, err := strconv.Atoi(parts[0])
    if err != nil {
        return Version{}, fmt.Errorf("invalid major version %q: %w", parts[0], err)
    }

    minor := 0
    if len(parts) > 1 {
        minor, err = strconv.Atoi(parts[1])
        if err != nil {
            return Version{}, fmt.Errorf("invalid minor version %q: %w", parts[1], err)
        }
    }

    return Version{Major: major, Minor: minor}, nil
}
```

### 3.2 Header-Based Version Router

```go
// internal/api/versioning/router.go
package versioning

import (
    "context"
    "net/http"

    "github.com/go-chi/chi/v5"
)

type contextKey string

const versionKey contextKey = "api_version"

// VersionedRouter routes requests to different handlers based on version
type VersionedRouter struct {
    handlers map[int]http.Handler
    defaultV int
}

func NewVersionedRouter() *VersionedRouter {
    return &VersionedRouter{
        handlers: make(map[int]http.Handler),
        defaultV: 1,
    }
}

func (vr *VersionedRouter) Register(version int, handler http.Handler) {
    vr.handlers[version] = handler
}

func (vr *VersionedRouter) SetDefault(version int) {
    vr.defaultV = version
}

func (vr *VersionedRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    version, err := ParseAcceptVersion(r)
    if err != nil {
        http.Error(w, "Invalid API version requested", http.StatusBadRequest)
        return
    }

    handler, ok := vr.handlers[version.Major]
    if !ok {
        // Check if version is too old (below minimum supported)
        if version.Major < minimumSupportedVersion {
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusGone)
            w.Write([]byte(`{"error":"API version `+version.String()+` is no longer supported. Please upgrade to v2 or later."}`))
            return
        }
        // Unknown future version - use latest
        handler = vr.handlers[vr.defaultV]
    }

    // Store version in context for handlers to use
    ctx := context.WithValue(r.Context(), versionKey, version)
    handler.ServeHTTP(w, r.WithContext(ctx))
}

const minimumSupportedVersion = 1

// GetVersionFromContext retrieves the parsed version from request context
func GetVersionFromContext(ctx context.Context) Version {
    if v, ok := ctx.Value(versionKey).(Version); ok {
        return v
    }
    return Version{Major: 1}
}

// Example: Single endpoint that handles multiple versions
type UserHandler struct {
    svc UserService
}

func (h *UserHandler) Get(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    user, err := h.svc.GetUser(r.Context(), id)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    version := GetVersionFromContext(r.Context())
    switch version.Major {
    case 1:
        respondJSON(w, http.StatusOK, userToV1Response(user))
    case 2:
        respondJSON(w, http.StatusOK, userToV2Response(user))
    default:
        respondJSON(w, http.StatusOK, userToV2Response(user)) // Latest
    }
}
```

## Section 4: Custom Media Type Versioning

Content negotiation with custom media types is the most REST-pure approach but least commonly used in practice:

```
Accept: application/vnd.myapp.users.v2+json
Content-Type: application/vnd.myapp.users.v2+json
```

### 4.1 Media Type Registry

```go
// internal/api/versioning/mediatypes.go
package versioning

import (
    "fmt"
    "net/http"
    "strings"
)

type MediaType struct {
    Vendor    string
    Resource  string
    Version   int
    Format    string // json, xml, msgpack
}

func (m MediaType) String() string {
    return fmt.Sprintf("application/vnd.%s.%s.v%d+%s", m.Vendor, m.Resource, m.Version, m.Format)
}

// ParseContentType parses: application/vnd.myapp.users.v2+json
func ParseContentType(contentType string) (*MediaType, error) {
    // Strip parameters
    if idx := strings.Index(contentType, ";"); idx != -1 {
        contentType = strings.TrimSpace(contentType[:idx])
    }

    if !strings.HasPrefix(contentType, "application/vnd.") {
        return nil, nil // Not a vendor media type
    }

    rest := strings.TrimPrefix(contentType, "application/vnd.")

    // Split vendor+format
    var format string
    if idx := strings.LastIndex(rest, "+"); idx != -1 {
        format = rest[idx+1:]
        rest = rest[:idx]
    }

    parts := strings.Split(rest, ".")
    if len(parts) < 3 {
        return nil, fmt.Errorf("invalid vendor media type: %s", contentType)
    }

    vendor := parts[0]
    // Last part is version (vN)
    versionPart := parts[len(parts)-1]
    if !strings.HasPrefix(versionPart, "v") {
        return nil, fmt.Errorf("missing version in media type: %s", contentType)
    }

    var version int
    if _, err := fmt.Sscanf(versionPart, "v%d", &version); err != nil {
        return nil, fmt.Errorf("invalid version in media type: %s", contentType)
    }

    resource := strings.Join(parts[1:len(parts)-1], ".")

    if format == "" {
        format = "json"
    }

    return &MediaType{
        Vendor:   vendor,
        Resource: resource,
        Version:  version,
        Format:   format,
    }, nil
}

// NegotiateVersion middleware for content negotiation
func NegotiateVersion(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        accept := r.Header.Get("Accept")
        if accept == "" {
            accept = r.Header.Get("Content-Type")
        }

        mt, err := ParseContentType(accept)
        if err != nil || mt == nil {
            // Fall back to URL path version or default
            next.ServeHTTP(w, r)
            return
        }

        ctx := context.WithValue(r.Context(), versionKey, Version{Major: mt.Version})
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

## Section 5: API Sunset Policies

### 5.1 Sunset Policy Enforcement

```go
// internal/api/versioning/sunset.go
package versioning

import (
    "encoding/json"
    "net/http"
    "time"
)

type SunsetPolicy struct {
    // Version this policy applies to
    Version int
    // DeprecationDate when this version was marked deprecated
    DeprecationDate time.Time
    // SunsetDate when this version will be removed
    SunsetDate time.Time
    // MigrationGuideURL link to migration documentation
    MigrationGuideURL string
    // GracePeriod after sunset before hard shutdown
    GracePeriod time.Duration
}

var sunsetPolicies = map[int]SunsetPolicy{
    1: {
        Version:           1,
        DeprecationDate:   time.Date(2031, 1, 1, 0, 0, 0, 0, time.UTC),
        SunsetDate:        time.Date(2031, 12, 31, 0, 0, 0, 0, time.UTC),
        MigrationGuideURL: "https://docs.example.com/api/migration/v1-to-v2",
        GracePeriod:       30 * 24 * time.Hour, // 30 days grace after sunset
    },
}

func SunsetEnforcementMiddleware(version int) func(http.Handler) http.Handler {
    policy, exists := sunsetPolicies[version]

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if !exists {
                next.ServeHTTP(w, r)
                return
            }

            now := time.Now().UTC()

            // After sunset + grace period: return 410 Gone
            if now.After(policy.SunsetDate.Add(policy.GracePeriod)) {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusGone)
                json.NewEncoder(w).Encode(map[string]interface{}{
                    "error": map[string]string{
                        "code":            "API_VERSION_SUNSET",
                        "message":         "This API version is no longer available",
                        "migration_guide": policy.MigrationGuideURL,
                    },
                })
                return
            }

            // After sunset but within grace: return 410 with warning
            if now.After(policy.SunsetDate) {
                w.Header().Set("Warning", `299 - "This API version has been sunset. Please migrate immediately."`)
                w.Header().Set("Link", `<`+policy.MigrationGuideURL+`>; rel="sunset"`)
            } else if now.After(policy.DeprecationDate) {
                // After deprecation: add headers
                w.Header().Set("Deprecation", policy.DeprecationDate.UTC().Format(http.TimeFormat))
                w.Header().Set("Sunset", policy.SunsetDate.UTC().Format(http.TimeFormat))
                w.Header().Set("Link", `<`+policy.MigrationGuideURL+`>; rel="sunset"`)
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 6: Backward Compatibility Testing

### 6.1 Contract Testing with Response Snapshots

```go
// internal/api/v1/handlers/users_compat_test.go
package handlers_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// TestV1ResponseShape ensures the v1 API response shape never changes
// This test will FAIL if any field is renamed, removed, or changes type
func TestV1UserResponseShape(t *testing.T) {
    router := setupTestRouter(t)

    req := httptest.NewRequest("GET", "/v1/users/test-user-id", nil)
    w := httptest.NewRecorder()
    router.ServeHTTP(w, req)

    require.Equal(t, http.StatusOK, w.Code)

    var response map[string]interface{}
    require.NoError(t, json.NewDecoder(w.Body).Decode(&response))

    // These fields MUST always be present in v1 responses
    requiredFields := []string{"id", "name", "email", "created_at", "role"}
    for _, field := range requiredFields {
        assert.Contains(t, response, field,
            "v1 response must contain field %q - removing or renaming fields is a breaking change", field)
    }

    // Type assertions - ensure field types don't change
    assert.IsType(t, "", response["id"], "id must be string")
    assert.IsType(t, "", response["name"], "name must be string")
    assert.IsType(t, "", response["created_at"], "created_at must be string in v1 (NOT time.Time)")
    assert.IsType(t, "", response["role"], "role must be string (NOT array) in v1")

    // v1 must NOT include v2-only fields
    v2OnlyFields := []string{"first_name", "last_name", "roles", "metadata"}
    for _, field := range v2OnlyFields {
        assert.NotContains(t, response, field,
            "v1 response must not include v2 field %q", field)
    }
}

// TestV1SnapshotResponse compares against a golden file
func TestV1SnapshotResponse(t *testing.T) {
    router := setupTestRouter(t)

    req := httptest.NewRequest("GET", "/v1/users", nil)
    w := httptest.NewRecorder()
    router.ServeHTTP(w, req)

    require.Equal(t, http.StatusOK, w.Code)

    goldenFile := "testdata/v1_users_list.golden.json"
    if os.Getenv("UPDATE_GOLDEN") == "true" {
        err := os.WriteFile(goldenFile, w.Body.Bytes(), 0644)
        require.NoError(t, err, "updating golden file")
        t.Log("Golden file updated. Re-run without UPDATE_GOLDEN=true to verify.")
        return
    }

    golden, err := os.ReadFile(goldenFile)
    require.NoError(t, err, "golden file should exist; run with UPDATE_GOLDEN=true to create")

    // Normalize JSON for comparison
    var actual, expected interface{}
    require.NoError(t, json.Unmarshal(w.Body.Bytes(), &actual))
    require.NoError(t, json.Unmarshal(golden, &expected))

    assert.Equal(t, expected, actual,
        "v1 response shape changed - this is a breaking change. "+
            "If this change is intentional for v1, create a v3 instead.")
}
```

### 6.2 OpenAPI Schema Diff Testing

```go
// cmd/api-diff/main.go
// Run in CI to detect breaking changes in OpenAPI schemas
package main

import (
    "fmt"
    "log"
    "os"
    "os/exec"
)

func main() {
    // Compare OpenAPI specs using oasdiff
    cmd := exec.Command("oasdiff", "breaking",
        "--base", "api/openapi/v1.yaml",
        "--revision", "api/openapi/v1.yaml.new",
        "--format", "text",
        "--fail-on", "ERR",
    )
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    if err := cmd.Run(); err != nil {
        if exitErr, ok := err.(*exec.ExitError); ok {
            fmt.Fprintf(os.Stderr, "Breaking changes detected in v1 API (exit code %d)\n", exitErr.ExitCode())
            fmt.Fprintf(os.Stderr, "Breaking changes are not allowed in stable API versions.\n")
            fmt.Fprintf(os.Stderr, "Create a new major version (v2) for breaking changes.\n")
            os.Exit(1)
        }
        log.Fatal(err)
    }

    fmt.Println("No breaking changes detected in v1 API")
}
```

## Section 7: Versioned OpenAPI Schema Management

### 7.1 Generating Per-Version OpenAPI Specs

```go
// internal/api/docs/swagger.go
package docs

import (
    "github.com/swaggo/swag"
)

// @title           MyApp API
// @version         2.0
// @description     Production API for MyApp
// @host            api.example.com
// @BasePath        /v2
// @securityDefinitions.apikey BearerAuth
// @in header
// @name Authorization

// Keep separate swagger files per version:
// api/openapi/v1.yaml - V1 spec (frozen, no changes allowed)
// api/openapi/v2.yaml - V2 spec (active development)

func RegisterSwaggerV1(r chi.Router) {
    r.Get("/api/v1/openapi.json", func(w http.ResponseWriter, r *http.Request) {
        http.ServeFile(w, r, "api/openapi/v1.yaml")
    })
}

func RegisterSwaggerV2(r chi.Router) {
    r.Get("/api/v2/openapi.json", swaggerHandler)
    r.Get("/api/v2/docs/*", httpSwagger.Handler(
        httpSwagger.URL("/api/v2/openapi.json"),
    ))
}
```

### 7.2 CI Workflow for Schema Management

```yaml
# .github/workflows/api-compat.yml
name: API Compatibility Check

on:
  pull_request:
    paths:
      - 'internal/api/**'
      - 'api/openapi/**'

jobs:
  breaking-change-check:
    name: Check for Breaking API Changes
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Need full history for base ref

      - name: Install oasdiff
        run: go install github.com/tufin/oasdiff@latest

      - name: Generate OpenAPI specs
        run: |
          go run cmd/generate-openapi/main.go --version=v1 --output=api/openapi/v1.new.yaml
          go run cmd/generate-openapi/main.go --version=v2 --output=api/openapi/v2.new.yaml

      - name: Check v1 for breaking changes (MUST NOT have any)
        run: |
          oasdiff breaking \
            --base api/openapi/v1.yaml \
            --revision api/openapi/v1.new.yaml \
            --fail-on ERR \
            --format text
          echo "V1 backward compatibility check passed"

      - name: Check v2 for breaking changes (warn only on stable endpoints)
        run: |
          oasdiff breaking \
            --base api/openapi/v2.yaml \
            --revision api/openapi/v2.new.yaml \
            --format text || true  # Warn but don't fail during development
          echo "V2 changes noted"

      - name: Update committed spec files
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        run: |
          cp api/openapi/v1.new.yaml api/openapi/v1.yaml
          cp api/openapi/v2.new.yaml api/openapi/v2.yaml
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add api/openapi/
          git commit -m "ci: update OpenAPI specs [skip ci]" || true
          git push
```

## Section 8: gRPC Protobuf Version Management

For gRPC APIs, versioning is managed at the package level:

```protobuf
// proto/users/v1/users.proto
syntax = "proto3";
package users.v1;
option go_package = "myapp/gen/proto/users/v1;usersv1";

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
}

message User {
  string id = 1;
  string name = 2;       // v1: combined first+last
  string email = 3;
  string created_at = 4; // v1: string format
  string role = 5;       // v1: single role
}
```

```protobuf
// proto/users/v2/users.proto
syntax = "proto3";
package users.v2;
option go_package = "myapp/gen/proto/users/v2;usersv2";

import "google/protobuf/timestamp.proto";

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc ListUsers(ListUsersRequest) returns (stream User);  // Streaming in v2
}

message User {
  string id = 1;
  string first_name = 2;  // v2: split fields
  string last_name = 3;
  string email = 4;
  google.protobuf.Timestamp created_at = 5;  // v2: proper timestamp
  repeated string roles = 6;  // v2: multiple roles
  map<string, string> labels = 7;  // v2: metadata
}
```

API versioning is fundamentally a promise to your consumers. URL path versioning makes that promise visible. Header versioning makes it invisible. Content negotiation makes it precise. Choose the approach that matches your consumers' sophistication and your operational team's comfort level — and then enforce it rigorously in CI to ensure you never accidentally break that promise.
