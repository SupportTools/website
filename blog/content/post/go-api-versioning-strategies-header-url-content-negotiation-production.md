---
title: "Go API Versioning Strategies: Header-based, URL-based, and Content Negotiation Patterns for Production APIs"
date: 2032-04-17T00:00:00-05:00
draft: false
tags: ["Go", "API", "REST", "Versioning", "HTTP", "Production", "Backend"]
categories:
- Go
- API Design
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to API versioning in Go covering URL path versioning, header-based versioning, content negotiation with Accept headers, version deprecation policies, and migration patterns for production REST APIs."
more_link: "yes"
url: "/go-api-versioning-strategies-header-url-content-negotiation-production/"
---

API versioning is one of the most consequential decisions in API design. The strategy chosen at launch becomes a long-term operational commitment affecting client contracts, deployment complexity, and team velocity. This post covers all three major versioning strategies in Go with production-ready implementations including deprecation handling, version negotiation, and migration tooling.

<!--more-->

## Versioning Strategy Comparison

| Strategy | URL | Header | Content Negotiation |
|---|---|---|---|
| URL example | `/v1/users`, `/v2/users` | `API-Version: 2` | `Accept: application/vnd.api.v2+json` |
| Cache-friendly | Yes | No | Partial |
| REST purity | No (version in URL) | No (custom header) | Yes |
| Client complexity | Low | Medium | Medium-High |
| Proxy/CDN support | Excellent | Poor (custom headers) | Moderate |
| Discovery | Easy | Requires docs | Requires docs |
| Recommended for | Public APIs | Internal APIs | Standard-compliant APIs |

---

## URL Path Versioning

### Router Setup with Chi

```go
package main

import (
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "go.uber.org/zap"

    v1 "github.com/example/api/internal/handler/v1"
    v2 "github.com/example/api/internal/handler/v2"
    "github.com/example/api/internal/versionmw"
)

func buildRouter(logger *zap.Logger) http.Handler {
    r := chi.NewRouter()

    // Common middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Recoverer)
    r.Use(versionmw.DeprecationWarning)

    // V1 routes
    r.Route("/v1", func(r chi.Router) {
        r.Use(versionmw.SetVersion("v1"))
        r.Get("/users", v1.ListUsers)
        r.Post("/users", v1.CreateUser)
        r.Get("/users/{id}", v1.GetUser)
        r.Put("/users/{id}", v1.UpdateUser)
        r.Delete("/users/{id}", v1.DeleteUser)
        r.Get("/users/{id}/orders", v1.ListUserOrders)
    })

    // V2 routes - new response shapes, new endpoints
    r.Route("/v2", func(r chi.Router) {
        r.Use(versionmw.SetVersion("v2"))
        r.Get("/users", v2.ListUsers)
        r.Post("/users", v2.CreateUser)
        r.Get("/users/{id}", v2.GetUser)
        r.Patch("/users/{id}", v2.PatchUser) // V2 uses PATCH instead of PUT
        r.Delete("/users/{id}", v2.DeleteUser)
        r.Get("/users/{id}/orders", v2.ListUserOrders)
        // New V2 endpoints
        r.Get("/users/{id}/preferences", v2.GetUserPreferences)
        r.Put("/users/{id}/preferences", v2.UpdateUserPreferences)
    })

    // Latest alias - always points to most recent stable version
    r.Mount("/latest", http.StripPrefix("/latest", buildV2Router(logger)))

    return r
}

func buildV2Router(logger *zap.Logger) http.Handler {
    r := chi.NewRouter()
    r.Use(versionmw.SetVersion("v2"))
    r.Get("/users", v2.ListUsers)
    // ... same as /v2
    return r
}
```

### Version Context Middleware

```go
package versionmw

import (
    "context"
    "net/http"
    "time"
)

type contextKey string

const versionContextKey contextKey = "api-version"

// SetVersion injects the API version into the request context.
func SetVersion(version string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx := context.WithValue(r.Context(), versionContextKey, version)
            // Set version header in response for client awareness
            w.Header().Set("API-Version", version)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// FromContext retrieves the API version from context.
func FromContext(ctx context.Context) string {
    if v, ok := ctx.Value(versionContextKey).(string); ok {
        return v
    }
    return "unknown"
}

// DeprecationWarning adds Deprecation headers to responses for deprecated API versions.
func DeprecationWarning(next http.Handler) http.Handler {
    // V1 is deprecated
    deprecations := map[string]deprecationInfo{
        "v1": {
            deprecatedSince: "2032-01-01",
            sunsetDate:      "2033-01-01",
            migrationURL:    "https://docs.example.com/migration/v1-to-v2",
        },
    }

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        next.ServeHTTP(w, r)

        version := FromContext(r.Context())
        if dep, ok := deprecations[version]; ok {
            // RFC 8594 deprecation headers
            w.Header().Set("Deprecation", dep.deprecatedSince)
            w.Header().Set("Sunset", dep.sunsetDate)
            w.Header().Set("Link",
                `<`+dep.migrationURL+`>; rel="successor-version"`)
        }
    })
}

type deprecationInfo struct {
    deprecatedSince string
    sunsetDate      string
    migrationURL    string
}
```

---

## Header-Based Versioning

### Version Router Middleware

```go
package versionrouter

import (
    "fmt"
    "net/http"
    "strconv"
    "strings"
)

// VersionRouter routes requests to different handlers based on API-Version header.
type VersionRouter struct {
    handlers       map[int]http.Handler
    defaultVersion int
    minVersion     int
    maxVersion     int
}

// NewVersionRouter creates a version router.
func NewVersionRouter(defaultVersion, minVersion, maxVersion int) *VersionRouter {
    return &VersionRouter{
        handlers:       make(map[int]http.Handler),
        defaultVersion: defaultVersion,
        minVersion:     minVersion,
        maxVersion:     maxVersion,
    }
}

// Register registers a handler for a specific API version.
func (vr *VersionRouter) Register(version int, handler http.Handler) {
    vr.handlers[version] = handler
}

// ServeHTTP routes the request to the appropriate version handler.
func (vr *VersionRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    version, err := vr.parseVersion(r)
    if err != nil {
        http.Error(w, fmt.Sprintf("invalid API-Version: %v", err), http.StatusBadRequest)
        return
    }

    if version < vr.minVersion {
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusGone)
        fmt.Fprintf(w, `{"error":"API version %d is no longer supported. Minimum version: %d"}`,
            version, vr.minVersion)
        return
    }

    if version > vr.maxVersion {
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusBadRequest)
        fmt.Fprintf(w, `{"error":"API version %d does not exist. Maximum version: %d"}`,
            version, vr.maxVersion)
        return
    }

    // Find the closest matching version (floor)
    for v := version; v >= vr.minVersion; v-- {
        if h, ok := vr.handlers[v]; ok {
            w.Header().Set("API-Version", strconv.Itoa(v))
            if v < version {
                // Indicate we're serving a lower version
                w.Header().Set("API-Version-Served", strconv.Itoa(v))
            }
            h.ServeHTTP(w, r)
            return
        }
    }

    http.Error(w, "no handler found for version", http.StatusInternalServerError)
}

// parseVersion extracts the API version from request headers or query string.
func (vr *VersionRouter) parseVersion(r *http.Request) (int, error) {
    // Check header first
    if v := r.Header.Get("API-Version"); v != "" {
        version, err := strconv.Atoi(strings.TrimSpace(v))
        if err != nil {
            return 0, fmt.Errorf("header value %q is not a valid integer", v)
        }
        return version, nil
    }

    // Fall back to query parameter
    if v := r.URL.Query().Get("api_version"); v != "" {
        version, err := strconv.Atoi(v)
        if err != nil {
            return 0, fmt.Errorf("query value %q is not a valid integer", v)
        }
        return version, nil
    }

    return vr.defaultVersion, nil
}
```

### Usage with Multiple API Versions

```go
func buildHeaderVersionedRouter() http.Handler {
    router := versionrouter.NewVersionRouter(2, 1, 3)

    // V1 handler
    v1Mux := http.NewServeMux()
    v1Mux.HandleFunc("/users", handleUsersV1)
    router.Register(1, v1Mux)

    // V2 handler
    v2Mux := http.NewServeMux()
    v2Mux.HandleFunc("/users", handleUsersV2)
    router.Register(2, v2Mux)

    // V3 handler (new features)
    v3Mux := http.NewServeMux()
    v3Mux.HandleFunc("/users", handleUsersV3)
    router.Register(3, v3Mux)

    return router
}
```

---

## Content Negotiation Versioning

Content negotiation uses the `Accept` header to specify both the media type and version:

```
Accept: application/vnd.example.v2+json
Accept: application/vnd.example.users.v2+json
```

### Media Type Parser

```go
package mediatype

import (
    "fmt"
    "regexp"
    "strconv"
    "strings"
)

// VendorMediaType represents a versioned vendor media type.
// Example: application/vnd.example.v2+json
type VendorMediaType struct {
    Vendor  string // "example"
    Version int    // 2
    Suffix  string // "json"
    Raw     string // original string
}

var vendorPattern = regexp.MustCompile(
    `^application/vnd\.([a-z][a-z0-9-]*)\.v(\d+)\+([a-z]+)$`,
)

// Parse parses a vendor media type string.
func Parse(mediaType string) (*VendorMediaType, error) {
    // Strip quality factor if present: "application/vnd.x.v1+json;q=0.9"
    mediaType = strings.SplitN(mediaType, ";", 2)[0]
    mediaType = strings.TrimSpace(mediaType)

    matches := vendorPattern.FindStringSubmatch(mediaType)
    if matches == nil {
        return nil, fmt.Errorf("not a versioned vendor media type: %q", mediaType)
    }

    version, err := strconv.Atoi(matches[2])
    if err != nil {
        return nil, fmt.Errorf("parsing version number: %w", err)
    }

    return &VendorMediaType{
        Vendor:  matches[1],
        Version: version,
        Suffix:  matches[3],
        Raw:     mediaType,
    }, nil
}

// String returns the canonical media type string.
func (v *VendorMediaType) String() string {
    return fmt.Sprintf("application/vnd.%s.v%d+%s", v.Vendor, v.Version, v.Suffix)
}

// ParseAcceptHeader parses the Accept header and returns media types in preference order.
func ParseAcceptHeader(accept string) []string {
    if accept == "" {
        return nil
    }

    type acceptItem struct {
        mediaType string
        quality   float64
    }

    items := []acceptItem{}

    for _, part := range strings.Split(accept, ",") {
        part = strings.TrimSpace(part)
        if part == "" {
            continue
        }

        segments := strings.SplitN(part, ";", 2)
        mt := strings.TrimSpace(segments[0])
        quality := 1.0

        if len(segments) == 2 {
            param := strings.TrimSpace(segments[1])
            if strings.HasPrefix(param, "q=") {
                if q, err := strconv.ParseFloat(param[2:], 64); err == nil {
                    quality = q
                }
            }
        }

        items = append(items, acceptItem{mt, quality})
    }

    // Sort by quality (stable sort preserves order for equal quality)
    for i := 1; i < len(items); i++ {
        for j := i; j > 0 && items[j].quality > items[j-1].quality; j-- {
            items[j], items[j-1] = items[j-1], items[j]
        }
    }

    result := make([]string, len(items))
    for i, item := range items {
        result[i] = item.mediaType
    }
    return result
}
```

### Content Negotiation Middleware

```go
package versionmw

import (
    "context"
    "fmt"
    "net/http"

    "github.com/example/api/internal/mediatype"
)

// ContentNegotiationVersioning extracts the API version from Accept header.
func ContentNegotiationVersioning(vendorName string, defaultVersion, maxVersion int) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            accept := r.Header.Get("Accept")
            version := defaultVersion

            if accept != "" && accept != "*/*" && accept != "application/json" {
                mediaTypes := mediatype.ParseAcceptHeader(accept)
                for _, mt := range mediaTypes {
                    parsed, err := mediatype.Parse(mt)
                    if err != nil {
                        continue
                    }
                    if parsed.Vendor == vendorName {
                        version = parsed.Version
                        break
                    }
                }
            }

            if version > maxVersion {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusNotAcceptable)
                fmt.Fprintf(w, `{"error":"requested version %d exceeds maximum supported version %d"}`,
                    version, maxVersion)
                return
            }

            // Set Content-Type in response to match requested version
            contentType := fmt.Sprintf("application/vnd.%s.v%d+json", vendorName, version)
            w.Header().Set("Content-Type", contentType)

            ctx := context.WithValue(r.Context(), versionContextKey, version)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

---

## Version-Aware Request/Response Transformation

### Shared Domain Model with Version Adapters

The recommended pattern is to maintain one canonical domain model and transform to/from version-specific API models:

```go
package domain

import "time"

// User is the canonical domain model.
type User struct {
    ID          int64
    Email       string
    FirstName   string
    LastName    string
    DisplayName string // Added in V2
    Role        string
    CreatedAt   time.Time
    UpdatedAt   time.Time
    DeletedAt   *time.Time
}

// V1 API model - original contract
package v1

type UserResponse struct {
    ID        int64  `json:"id"`
    Email     string `json:"email"`
    Name      string `json:"name"` // Single name field in V1
    Role      string `json:"role"`
    CreatedAt string `json:"created_at"`
}

type CreateUserRequest struct {
    Email    string `json:"email" validate:"required,email"`
    Name     string `json:"name" validate:"required,min=2,max=100"`
    Role     string `json:"role" validate:"required,oneof=admin user viewer"`
    Password string `json:"password" validate:"required,min=8"`
}

// ToV1Response converts a domain User to V1 API response.
func ToV1Response(u *domain.User) UserResponse {
    return UserResponse{
        ID:        u.ID,
        Email:     u.Email,
        Name:      u.FirstName + " " + u.LastName, // Combine for V1
        Role:      u.Role,
        CreatedAt: u.CreatedAt.Format(time.RFC3339),
    }
}

// V2 API model - updated contract
package v2

type UserResponse struct {
    ID          int64  `json:"id"`
    Email       string `json:"email"`
    FirstName   string `json:"first_name"` // Split in V2
    LastName    string `json:"last_name"`
    DisplayName string `json:"display_name,omitempty"` // New in V2
    Role        string `json:"role"`
    CreatedAt   string `json:"created_at"`
    UpdatedAt   string `json:"updated_at"` // New in V2
}

// ToV2Response converts a domain User to V2 API response.
func ToV2Response(u *domain.User) UserResponse {
    return UserResponse{
        ID:          u.ID,
        Email:       u.Email,
        FirstName:   u.FirstName,
        LastName:    u.LastName,
        DisplayName: u.DisplayName,
        Role:        u.Role,
        CreatedAt:   u.CreatedAt.Format(time.RFC3339),
        UpdatedAt:   u.UpdatedAt.Format(time.RFC3339),
    }
}
```

### Generic Response Marshaler

```go
package response

import (
    "encoding/json"
    "net/http"

    "github.com/example/api/internal/versionmw"
    v1 "github.com/example/api/internal/model/v1"
    v2 "github.com/example/api/internal/model/v2"
    "github.com/example/api/internal/domain"
)

// UserEncoder encodes User domain objects for the API version in context.
type UserEncoder struct{}

// WriteUser writes a single user response appropriate for the request version.
func (e *UserEncoder) WriteUser(w http.ResponseWriter, r *http.Request, user *domain.User) {
    version := versionmw.IntFromContext(r.Context())

    var body interface{}
    switch version {
    case 1:
        body = v1.ToV1Response(user)
    case 2:
        body = v2.ToV2Response(user)
    default:
        body = v2.ToV2Response(user) // Latest as default
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(body)
}

// WriteUsers writes a paginated user list response.
func (e *UserEncoder) WriteUsers(w http.ResponseWriter, r *http.Request, users []*domain.User, total int, page, pageSize int) {
    version := versionmw.IntFromContext(r.Context())

    type paginatedResponse struct {
        Data       interface{} `json:"data"`
        Total      int         `json:"total"`
        Page       int         `json:"page"`
        PageSize   int         `json:"page_size"`
        TotalPages int         `json:"total_pages"`
    }

    var items interface{}
    switch version {
    case 1:
        v1Items := make([]v1.UserResponse, len(users))
        for i, u := range users {
            v1Items[i] = v1.ToV1Response(u)
        }
        items = v1Items
    case 2:
        v2Items := make([]v2.UserResponse, len(users))
        for i, u := range users {
            v2Items[i] = v2.ToV2Response(u)
        }
        items = v2Items
    default:
        v2Items := make([]v2.UserResponse, len(users))
        for i, u := range users {
            v2Items[i] = v2.ToV2Response(u)
        }
        items = v2Items
    }

    totalPages := (total + pageSize - 1) / pageSize

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(paginatedResponse{
        Data:       items,
        Total:      total,
        Page:       page,
        PageSize:   pageSize,
        TotalPages: totalPages,
    })
}
```

---

## Version Deprecation Management

### Deprecation Policy Implementation

```go
package deprecation

import (
    "fmt"
    "net/http"
    "time"
)

// Policy defines the lifecycle of an API version.
type Policy struct {
    Version           string
    DeprecatedAt      time.Time
    SunsetAt          time.Time
    MigrationGuideURL string
    SuccessorVersion  string
}

// Manager tracks API version lifecycle and adds appropriate headers.
type Manager struct {
    policies map[string]Policy
    now      func() time.Time // Injectable for testing
}

// NewManager creates a deprecation manager.
func NewManager(policies []Policy) *Manager {
    m := &Manager{
        policies: make(map[string]Policy),
        now:      time.Now,
    }
    for _, p := range policies {
        m.policies[p.Version] = p
    }
    return m
}

// IsExpired returns true if the version's sunset date has passed.
func (m *Manager) IsExpired(version string) bool {
    p, ok := m.policies[version]
    if !ok {
        return false
    }
    return m.now().After(p.SunsetAt)
}

// IsDeprecated returns true if the version is deprecated but not yet expired.
func (m *Manager) IsDeprecated(version string) bool {
    p, ok := m.policies[version]
    if !ok {
        return false
    }
    now := m.now()
    return now.After(p.DeprecatedAt) && !now.After(p.SunsetAt)
}

// SetHeaders adds RFC 8594-compliant deprecation headers to the response.
func (m *Manager) SetHeaders(w http.ResponseWriter, version string) {
    p, ok := m.policies[version]
    if !ok {
        return
    }

    if m.now().After(p.DeprecatedAt) {
        // RFC 8594: Deprecation header
        w.Header().Set("Deprecation", p.DeprecatedAt.UTC().Format(http.TimeFormat))

        // RFC 8594: Sunset header
        w.Header().Set("Sunset", p.SunsetAt.UTC().Format(http.TimeFormat))

        // Link to migration guide and successor version
        links := fmt.Sprintf(`<%s>; rel="deprecation"`, p.MigrationGuideURL)
        if p.SuccessorVersion != "" {
            links += fmt.Sprintf(`, <%s/docs>; rel="successor-version"`, p.SuccessorVersion)
        }
        w.Header().Set("Link", links)
    }
}

// Middleware applies deprecation headers and rejects expired versions.
func (m *Manager) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := versionmw.FromContext(r.Context())

        if m.IsExpired(version) {
            p := m.policies[version]
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusGone)
            fmt.Fprintf(w, `{
                "error": "API version %s was sunset on %s",
                "migration_guide": "%s",
                "successor_version": "%s"
            }`, version, p.SunsetAt.Format(time.RFC3339),
                p.MigrationGuideURL, p.SuccessorVersion)
            return
        }

        m.SetHeaders(w, version)
        next.ServeHTTP(w, r)
    })
}
```

### Versioning Observability

```go
package metrics

import (
    "net/http"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    apiVersionRequests = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "api_version_requests_total",
        Help: "Total requests per API version",
    }, []string{"version", "method", "path", "status"})

    deprecatedVersionRequests = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "api_deprecated_version_requests_total",
        Help: "Requests to deprecated API versions",
    }, []string{"version", "client_id"})
)

// VersionMetricsMiddleware records per-version request metrics.
func VersionMetricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
        next.ServeHTTP(rw, r)

        version := versionmw.FromContext(r.Context())
        apiVersionRequests.WithLabelValues(
            version,
            r.Method,
            sanitizePath(r.URL.Path),
            fmt.Sprintf("%d", rw.status),
        ).Inc()
    })
}

type statusRecorder struct {
    http.ResponseWriter
    status int
}

func (r *statusRecorder) WriteHeader(status int) {
    r.status = status
    r.ResponseWriter.WriteHeader(status)
}

func sanitizePath(path string) string {
    // Replace UUIDs and IDs with placeholders for cardinality control
    // e.g., /users/12345 -> /users/:id
    return idPattern.ReplaceAllString(path, "/:id")
}
```

---

## Request Version Routing with Feature Flags

For gradual migration, use feature flags to enable V2 behavior for specific clients:

```go
package features

import (
    "context"
    "net/http"
)

type contextKey string

const featuresKey contextKey = "features"

// Features is a set of enabled features for a request.
type Features struct {
    UseNewPagination   bool
    UseExpandedProfile bool
    EnableBetaEndpoints bool
}

// FromRequest determines enabled features based on API version and client headers.
func FromRequest(r *http.Request) Features {
    version := versionmw.IntFromContext(r.Context())
    clientID := r.Header.Get("X-Client-ID")

    f := Features{}

    // Version-based feature flags
    if version >= 2 {
        f.UseNewPagination = true
        f.UseExpandedProfile = true
    }

    // Client-specific early access
    if isEarlyAccessClient(clientID) {
        f.EnableBetaEndpoints = true
    }

    return f
}

// betaEarlyAccessClients is a set of client IDs that have beta access.
// In production, this would come from a database or feature flag service.
var betaEarlyAccessClients = map[string]bool{
    "client-internal-001": true,
    "client-preview-002":  true,
}

func isEarlyAccessClient(clientID string) bool {
    return betaEarlyAccessClients[clientID]
}

// Middleware injects features into request context.
func Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        features := FromRequest(r)
        ctx := context.WithValue(r.Context(), featuresKey, features)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

---

## Version Compatibility Matrix

```go
package compatibility

import "fmt"

// Matrix tracks which API client version ranges are compatible
// with which server versions.
type Matrix struct {
    // serverVersion -> []compatible client versions
    entries map[int]Range
}

type Range struct {
    Min int
    Max int
}

func NewMatrix() *Matrix {
    return &Matrix{
        entries: map[int]Range{
            1: {Min: 1, Max: 1},
            2: {Min: 1, Max: 2}, // V2 server is backward-compatible with V1 clients
            3: {Min: 2, Max: 3}, // V3 server dropped V1 support
        },
    }
}

// IsCompatible checks if a client requesting clientVersion can use serverVersion.
func (m *Matrix) IsCompatible(serverVersion, clientVersion int) bool {
    r, ok := m.entries[serverVersion]
    if !ok {
        return false
    }
    return clientVersion >= r.Min && clientVersion <= r.Max
}

// LatestCompatibleVersion returns the latest server version that supports
// the given client version.
func (m *Matrix) LatestCompatibleVersion(clientVersion int) (int, error) {
    latest := 0
    for sv, r := range m.entries {
        if clientVersion >= r.Min && clientVersion <= r.Max {
            if sv > latest {
                latest = sv
            }
        }
    }
    if latest == 0 {
        return 0, fmt.Errorf("no server version supports client version %d", clientVersion)
    }
    return latest, nil
}
```

---

## Testing Versioned APIs

```go
package api_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestUserEndpointVersioning(t *testing.T) {
    router := buildRouter(zap.NewNop())
    server := httptest.NewServer(router)
    defer server.Close()

    t.Run("v1 returns single name field", func(t *testing.T) {
        resp, err := http.Get(server.URL + "/v1/users/1")
        require.NoError(t, err)
        defer resp.Body.Close()

        assert.Equal(t, http.StatusOK, resp.StatusCode)

        var body map[string]interface{}
        require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))

        assert.Contains(t, body, "name")
        assert.NotContains(t, body, "first_name")
        assert.NotContains(t, body, "last_name")
    })

    t.Run("v2 returns split name fields", func(t *testing.T) {
        resp, err := http.Get(server.URL + "/v2/users/1")
        require.NoError(t, err)
        defer resp.Body.Close()

        assert.Equal(t, http.StatusOK, resp.StatusCode)

        var body map[string]interface{}
        require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))

        assert.Contains(t, body, "first_name")
        assert.Contains(t, body, "last_name")
        assert.NotContains(t, body, "name")
    })

    t.Run("deprecated v1 returns deprecation headers", func(t *testing.T) {
        resp, err := http.Get(server.URL + "/v1/users/1")
        require.NoError(t, err)
        defer resp.Body.Close()

        assert.NotEmpty(t, resp.Header.Get("Deprecation"),
            "Deprecation header should be set for V1")
        assert.NotEmpty(t, resp.Header.Get("Sunset"),
            "Sunset header should be set for V1")
    })

    t.Run("content negotiation selects v2 with vendor media type", func(t *testing.T) {
        req, err := http.NewRequest("GET", server.URL+"/users/1", nil)
        require.NoError(t, err)
        req.Header.Set("Accept", "application/vnd.example.v2+json")

        client := &http.Client{}
        resp, err := client.Do(req)
        require.NoError(t, err)
        defer resp.Body.Close()

        assert.Contains(t, resp.Header.Get("Content-Type"), "vnd.example.v2+json")
    })
}
```

The three versioning strategies each have distinct tradeoffs. URL-based versioning is easiest for clients and infrastructure but violates REST purity. Header-based versioning is clean but cache-unfriendly. Content negotiation is most RESTful but adds client implementation complexity. Most successful production APIs use URL versioning for its operational simplicity and combine it with deprecation headers following RFC 8594 to communicate lifecycle to clients.
