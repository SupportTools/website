---
title: "Go API Versioning Strategies: URL Versioning, Header Versioning, Backward Compatibility, and Deprecation Lifecycle"
date: 2031-11-12T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "API Design", "API Versioning", "Backward Compatibility", "REST", "gRPC"]
categories: ["Go", "API Design"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go API versioning including URL path versioning, content negotiation, header-based versioning, backward compatibility patterns, and a complete deprecation lifecycle management system."
more_link: "yes"
url: "/go-api-versioning-strategies-url-header-backward-compatibility-deprecation-lifecycle/"
---

API versioning is a commitment to your consumers. The technical choice of where the version lives (URL, header, media type) is less consequential than the operational discipline of maintaining backward compatibility guarantees, communicating changes, and executing deprecations without breaking clients. This post covers the full spectrum of Go API versioning patterns with production-grade implementations for each strategy.

<!--more-->

# Go API Versioning Strategies: URL Versioning, Header Versioning, Backward Compatibility, and Deprecation Lifecycle

## The Versioning Decision Framework

Before choosing a versioning strategy, answer three questions:

1. **Who are your consumers?** Internal services can use header versioning. Public APIs should use URL versioning for cacheability and shareability.
2. **How different are versions?** Small additive changes do not need a version bump. Breaking changes require a new version.
3. **What is your support window?** A clear deprecation timeline lets clients plan migrations without surprises.

## Section 1: URL Path Versioning

### 1.1 Router Setup with net/http ServeMux

```go
// api/server.go
package api

import (
    "context"
    "log/slog"
    "net/http"

    v1 "github.com/exampleorg/api/v1"
    v2 "github.com/exampleorg/api/v2"
    "github.com/exampleorg/api/middleware"
)

// Server wires together multiple API version handlers.
type Server struct {
    mux    *http.ServeMux
    logger *slog.Logger
}

func NewServer(logger *slog.Logger) *Server {
    s := &Server{
        mux:    http.NewServeMux(),
        logger: logger,
    }
    s.routes()
    return s
}

func (s *Server) routes() {
    // V1 routes (deprecated, supported until 2033-01-01)
    v1Handler := v1.NewHandler()
    v1Deprecated := middleware.DeprecationWarning(
        v1Handler,
        middleware.DeprecationInfo{
            Version:        "v1",
            SunsetDate:     "2033-01-01",
            MigrationGuide: "https://docs.example.com/api/v1-to-v2-migration",
        },
    )
    s.mux.Handle("/v1/", http.StripPrefix("/v1", v1Deprecated))

    // V2 routes (current)
    v2Handler := v2.NewHandler()
    s.mux.Handle("/v2/", http.StripPrefix("/v2", v2Handler))

    // Unversioned routes always point to current stable version
    s.mux.Handle("/", http.StripPrefix("", v2Handler))
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    s.mux.ServeHTTP(w, r)
}
```

### 1.2 Version Handler Structure

```go
// api/v2/handler.go
package v2

import (
    "encoding/json"
    "net/http"
)

const APIVersion = "v2"

type Handler struct {
    mux *http.ServeMux
}

func NewHandler() *Handler {
    h := &Handler{mux: http.NewServeMux()}
    h.registerRoutes()
    return h
}

func (h *Handler) registerRoutes() {
    h.mux.HandleFunc("GET /users", h.ListUsers)
    h.mux.HandleFunc("GET /users/{id}", h.GetUser)
    h.mux.HandleFunc("POST /users", h.CreateUser)
    h.mux.HandleFunc("PUT /users/{id}", h.UpdateUser)
    h.mux.HandleFunc("DELETE /users/{id}", h.DeleteUser)

    // New in V2: batch operations
    h.mux.HandleFunc("POST /users/batch", h.BatchCreateUsers)
    h.mux.HandleFunc("GET /users/{id}/activity", h.GetUserActivity)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Set version header on all responses
    w.Header().Set("API-Version", APIVersion)
    h.mux.ServeHTTP(w, r)
}

// UserV2 is the V2 representation of a user.
// It differs from V1 by:
// - name is split into firstName/lastName
// - added preferences object
// - removed deprecated legacyID field
type UserV2 struct {
    ID          string            `json:"id"`
    FirstName   string            `json:"firstName"`
    LastName    string            `json:"lastName"`
    Email       string            `json:"email"`
    Preferences map[string]string `json:"preferences,omitempty"`
    CreatedAt   string            `json:"createdAt"`
    UpdatedAt   string            `json:"updatedAt"`
}

func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    // ... fetch user from service layer ...
    user := &UserV2{
        ID:        id,
        FirstName: "Alice",
        LastName:  "Smith",
        Email:     "alice@example.com",
    }
    writeJSON(w, http.StatusOK, user)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(v)
}
```

### 1.3 Deprecation Middleware

```go
// middleware/deprecation.go
package middleware

import (
    "fmt"
    "net/http"
    "time"
)

// DeprecationInfo describes a deprecated API version.
type DeprecationInfo struct {
    Version        string
    SunsetDate     string // RFC 3339 date, e.g., "2033-01-01"
    MigrationGuide string
}

// DeprecationWarning wraps a handler to add deprecation headers.
// Implements RFC 8594 (Sunset header) and draft-ietf-httpapi-deprecation-header.
func DeprecationWarning(next http.Handler, info DeprecationInfo) http.Handler {
    sunsetTime, err := time.Parse("2006-01-02", info.SunsetDate)
    if err != nil {
        panic(fmt.Sprintf("invalid sunset date %q: %v", info.SunsetDate, err))
    }

    // Pre-format headers
    sunsetHeader := sunsetTime.UTC().Format(http.TimeFormat)
    linkHeader := fmt.Sprintf(
        `<%s>; rel="successor-version", <%s>; rel="deprecation"`,
        info.MigrationGuide,
        info.MigrationGuide,
    )

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // RFC 8594 Sunset header
        w.Header().Set("Sunset", sunsetHeader)
        // Link header pointing to successor and deprecation docs
        w.Header().Set("Link", linkHeader)
        // Custom deprecation header with version info
        w.Header().Set("Deprecation", fmt.Sprintf(
            "version=%q, date=%q", info.Version, info.SunsetDate,
        ))
        // Warn header (RFC 7234)
        w.Header().Set("Warning", fmt.Sprintf(
            `299 - "This API version (%s) is deprecated and will be removed on %s. Migrate to the current version. See: %s"`,
            info.Version, info.SunsetDate, info.MigrationGuide,
        ))

        next.ServeHTTP(w, r)
    })
}
```

## Section 2: Header-Based Versioning

### 2.1 Accept Header Versioning

```go
// middleware/version_negotiation.go
package middleware

import (
    "net/http"
    "strings"
)

// VersionFromAcceptHeader extracts the API version from the Accept header.
// Supports format: application/vnd.example.v2+json
func VersionFromAcceptHeader(r *http.Request) string {
    accept := r.Header.Get("Accept")
    if accept == "" {
        return ""
    }

    // Parse media type with version qualifier
    for _, mediaType := range strings.Split(accept, ",") {
        mediaType = strings.TrimSpace(mediaType)
        // Strip quality parameter: application/vnd.example.v2+json;q=0.9
        if idx := strings.Index(mediaType, ";"); idx >= 0 {
            mediaType = mediaType[:idx]
        }
        mediaType = strings.TrimSpace(mediaType)

        // Look for versioned vendor media type
        if strings.HasPrefix(mediaType, "application/vnd.example.v") {
            // application/vnd.example.v2+json -> v2
            remainder := strings.TrimPrefix(mediaType, "application/vnd.example.v")
            if plus := strings.Index(remainder, "+"); plus >= 0 {
                version := "v" + remainder[:plus]
                return version
            }
        }
    }
    return ""
}

// VersionFromCustomHeader reads the API version from X-API-Version header.
func VersionFromCustomHeader(r *http.Request) string {
    v := r.Header.Get("X-API-Version")
    if v == "" {
        return ""
    }
    // Normalize: "2", "v2", "2.0" → "v2"
    v = strings.TrimPrefix(v, "v")
    if idx := strings.Index(v, "."); idx >= 0 {
        v = v[:idx]
    }
    return "v" + v
}

// VersionRouter dispatches requests to version-specific handlers.
type VersionRouter struct {
    handlers       map[string]http.Handler
    defaultVersion string
    extractors     []func(*http.Request) string
}

func NewVersionRouter(defaultVersion string) *VersionRouter {
    return &VersionRouter{
        handlers:       make(map[string]http.Handler),
        defaultVersion: defaultVersion,
        extractors: []func(*http.Request) string{
            VersionFromCustomHeader,
            VersionFromAcceptHeader,
        },
    }
}

func (vr *VersionRouter) Register(version string, handler http.Handler) {
    vr.handlers[version] = handler
}

func (vr *VersionRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    version := ""
    for _, extract := range vr.extractors {
        if v := extract(r); v != "" {
            version = v
            break
        }
    }

    if version == "" {
        version = vr.defaultVersion
    }

    handler, ok := vr.handlers[version]
    if !ok {
        http.Error(w,
            `{"error":"unsupported_version","message":"API version not supported"}`,
            http.StatusBadRequest,
        )
        return
    }

    // Echo the resolved version back to the client
    w.Header().Set("X-API-Version", version)
    w.Header().Set("Content-Type", "application/vnd.example."+version+"+json")

    handler.ServeHTTP(w, r)
}
```

## Section 3: Backward Compatibility Patterns

### 3.1 Additive-Only Changes (Safe)

The foundation of backward compatibility is making only additive, non-breaking changes within a version:

```go
// api/v2/types.go
package v2

// UserV2 is the stable V2 user type.
// Rules for backward compatibility within V2:
//   - Adding new optional fields: OK
//   - Adding new required fields: BREAKING (never do this in-place)
//   - Renaming fields: BREAKING
//   - Changing field types: BREAKING
//   - Removing fields: BREAKING
//   - Adding new optional query parameters: OK
//   - Removing query parameters: BREAKING
//   - Adding new endpoints: OK
//   - Removing endpoints: BREAKING
//   - Changing response status codes: BREAKING
type UserV2 struct {
    ID        string `json:"id"`
    FirstName string `json:"firstName"`
    LastName  string `json:"lastName"`
    Email     string `json:"email"`
    CreatedAt string `json:"createdAt"`
    UpdatedAt string `json:"updatedAt"`

    // Added in V2.1 — backward compatible because it's optional
    // +optional
    Preferences *UserPreferences `json:"preferences,omitempty"`

    // Added in V2.2 — optional, clients that don't know about it ignore it
    // +optional
    Labels map[string]string `json:"labels,omitempty"`
}
```

### 3.2 Field-Level Versioning with Custom Marshaling

```go
// api/v2/user_response.go
package v2

import (
    "encoding/json"
    "time"
)

// UserResponse is a versioned response that adapts to client capabilities.
// Clients can request the "slim" or "full" profile via Accept-Profile header.
type UserResponse struct {
    user         *User
    profileLevel string
}

func NewUserResponse(user *User, profileLevel string) *UserResponse {
    return &UserResponse{user: user, profileLevel: profileLevel}
}

// MarshalJSON implements a profile-based serialization.
func (r UserResponse) MarshalJSON() ([]byte, error) {
    // Base fields always included
    base := map[string]any{
        "id":        r.user.ID,
        "email":     r.user.Email,
        "createdAt": r.user.CreatedAt.Format(time.RFC3339),
    }

    switch r.profileLevel {
    case "slim":
        // Minimal profile: just identity fields
        return json.Marshal(base)

    case "full":
        // Full profile: include all fields
        base["firstName"] = r.user.FirstName
        base["lastName"] = r.user.LastName
        base["preferences"] = r.user.Preferences
        base["labels"] = r.user.Labels
        base["activity"] = r.user.RecentActivity
        return json.Marshal(base)

    default: // "standard"
        base["firstName"] = r.user.FirstName
        base["lastName"] = r.user.LastName
        base["preferences"] = r.user.Preferences
        return json.Marshal(base)
    }
}
```

### 3.3 Version-Aware Persistence Layer

```go
// storage/user_store.go
package storage

import (
    "context"
    "encoding/json"
    "fmt"
)

// StoredUser is the canonical, versionless representation stored in the database.
// API versions translate to/from this type.
type StoredUser struct {
    ID          string            `json:"id"`
    FullName    string            `json:"fullName"`    // V1 field
    FirstName   string            `json:"firstName"`   // V2 field
    LastName    string            `json:"lastName"`    // V2 field
    Email       string            `json:"email"`
    LegacyID    string            `json:"legacyId"`    // V1 only
    Preferences map[string]string `json:"preferences"` // V2 only
    Labels      map[string]string `json:"labels"`      // V2.2+
    CreatedAt   int64             `json:"createdAt"`
    UpdatedAt   int64             `json:"updatedAt"`
}

// ToV1 converts the stored user to the V1 API representation.
func (u *StoredUser) ToV1() map[string]any {
    return map[string]any{
        "id":        u.ID,
        "name":      u.FullName,  // V1 uses "name"
        "email":     u.Email,
        "legacyId":  u.LegacyID,
        "createdAt": u.CreatedAt,
        "updatedAt": u.UpdatedAt,
    }
}

// ToV2 converts the stored user to the V2 API representation.
func (u *StoredUser) ToV2() map[string]any {
    result := map[string]any{
        "id":        u.ID,
        "firstName": u.FirstName,
        "lastName":  u.LastName,
        "email":     u.Email,
        "createdAt": u.CreatedAt,
        "updatedAt": u.UpdatedAt,
    }
    if len(u.Preferences) > 0 {
        result["preferences"] = u.Preferences
    }
    if len(u.Labels) > 0 {
        result["labels"] = u.Labels
    }
    return result
}

// FromV1Request populates a StoredUser from a V1 create/update request.
func (u *StoredUser) FromV1Request(body json.RawMessage) error {
    var v1 struct {
        Name  string `json:"name"`
        Email string `json:"email"`
    }
    if err := json.Unmarshal(body, &v1); err != nil {
        return fmt.Errorf("parsing V1 request: %w", err)
    }

    u.FullName = v1.Name
    u.Email = v1.Email

    // Best-effort name split for V2 compatibility
    if parts := splitName(v1.Name); len(parts) >= 2 {
        u.FirstName = parts[0]
        u.LastName = parts[len(parts)-1]
    }
    return nil
}

// FromV2Request populates a StoredUser from a V2 create/update request.
func (u *StoredUser) FromV2Request(body json.RawMessage) error {
    var v2 struct {
        FirstName   string            `json:"firstName"`
        LastName    string            `json:"lastName"`
        Email       string            `json:"email"`
        Preferences map[string]string `json:"preferences"`
        Labels      map[string]string `json:"labels"`
    }
    if err := json.Unmarshal(body, &v2); err != nil {
        return fmt.Errorf("parsing V2 request: %w", err)
    }

    u.FirstName = v2.FirstName
    u.LastName = v2.LastName
    u.FullName = v2.FirstName + " " + v2.LastName  // Maintain V1 compatibility
    u.Email = v2.Email
    u.Preferences = v2.Preferences
    u.Labels = v2.Labels
    return nil
}

func splitName(name string) []string {
    // Simplified name splitting
    var parts []string
    start := 0
    for i, c := range name {
        if c == ' ' {
            if i > start {
                parts = append(parts, name[start:i])
            }
            start = i + 1
        }
    }
    if start < len(name) {
        parts = append(parts, name[start:])
    }
    return parts
}
```

## Section 4: Deprecation Lifecycle Management

### 4.1 Deprecation Registry

```go
// deprecation/registry.go
package deprecation

import (
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// DeprecatedFeature describes a deprecated API feature.
type DeprecatedFeature struct {
    ID             string
    Description    string
    SunsetDate     time.Time
    MigrationGuide string
    Replacement    string
}

// Phase returns the deprecation phase based on time to sunset.
func (d *DeprecatedFeature) Phase() Phase {
    remaining := time.Until(d.SunsetDate)
    switch {
    case remaining > 6*30*24*time.Hour:
        return PhaseDeprecated      // > 6 months: warn on each request
    case remaining > 30*24*time.Hour:
        return PhaseNearSunset      // 1-6 months: warn loudly
    case remaining > 0:
        return PhaseImminent        // < 1 month: critical warnings
    default:
        return PhaseSunset          // Past sunset: reject or degrade
    }
}

// Phase represents the lifecycle stage of a deprecated feature.
type Phase int

const (
    PhaseDeprecated Phase = iota
    PhaseNearSunset
    PhaseImminent
    PhaseSunset
)

// Registry tracks deprecated API features and their usage.
type Registry struct {
    mu       sync.RWMutex
    features map[string]*DeprecatedFeature
    logger   *slog.Logger

    // Metrics
    usageCounter *prometheus.CounterVec
}

func NewRegistry(logger *slog.Logger) *Registry {
    return &Registry{
        features: make(map[string]*DeprecatedFeature),
        logger:   logger,
        usageCounter: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Name: "api_deprecated_feature_usage_total",
                Help: "Total usage of deprecated API features",
            },
            []string{"feature_id", "phase"},
        ),
    }
}

// Register adds a deprecated feature to the registry.
func (r *Registry) Register(feature DeprecatedFeature) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.features[feature.ID] = &feature
}

// Track records usage of a deprecated feature and adds response headers.
func (r *Registry) Track(featureID string, w http.ResponseWriter) {
    r.mu.RLock()
    feature, ok := r.features[featureID]
    r.mu.RUnlock()

    if !ok {
        return
    }

    phase := feature.Phase()

    // Record metrics
    r.usageCounter.WithLabelValues(featureID, fmt.Sprintf("%d", phase)).Inc()

    // Log with appropriate severity
    switch phase {
    case PhaseNearSunset:
        r.logger.Warn("Near-sunset deprecated feature used",
            "feature", featureID,
            "sunset_date", feature.SunsetDate.Format("2006-01-02"),
            "days_remaining", int(time.Until(feature.SunsetDate).Hours()/24),
        )
    case PhaseImminent:
        r.logger.Error("Imminent sunset deprecated feature used",
            "feature", featureID,
            "sunset_date", feature.SunsetDate.Format("2006-01-02"),
            "days_remaining", int(time.Until(feature.SunsetDate).Hours()/24),
        )
    }

    // Set response headers
    w.Header().Set("Sunset", feature.SunsetDate.UTC().Format(http.TimeFormat))
    w.Header().Set("Deprecation", "true")
    w.Header().Set("Link",
        fmt.Sprintf(`<%s>; rel="deprecation"`, feature.MigrationGuide),
    )
}

// SunsetReport generates a report of all deprecated features and their status.
func (r *Registry) SunsetReport() []map[string]any {
    r.mu.RLock()
    defer r.mu.RUnlock()

    report := make([]map[string]any, 0, len(r.features))
    for _, f := range r.features {
        report = append(report, map[string]any{
            "id":             f.ID,
            "description":    f.Description,
            "sunsetDate":     f.SunsetDate.Format("2006-01-02"),
            "phase":          f.Phase(),
            "daysRemaining":  int(time.Until(f.SunsetDate).Hours() / 24),
            "migrationGuide": f.MigrationGuide,
            "replacement":    f.Replacement,
        })
    }
    return report
}
```

### 4.2 Lifecycle Enforcement Middleware

```go
// middleware/lifecycle.go
package middleware

import (
    "encoding/json"
    "net/http"
    "time"

    "github.com/exampleorg/api/deprecation"
)

// EnforceSunset rejects requests to sunset endpoints past their sunset date.
func EnforceSunset(next http.Handler, sunsetDate time.Time, replacement string) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if time.Now().After(sunsetDate) {
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusGone)
            json.NewEncoder(w).Encode(map[string]string{
                "error":       "endpoint_sunset",
                "message":     "This API endpoint has been removed as of " + sunsetDate.Format("2006-01-02"),
                "replacement": replacement,
            })
            return
        }
        next.ServeHTTP(w, r)
    })
}

// VersionSupportMatrix validates request versions against a support matrix.
type VersionSupportMatrix struct {
    versions map[string]VersionPolicy
}

type VersionPolicy struct {
    Status         string    // "current", "deprecated", "sunset"
    SunsetDate     time.Time
    MigrationGuide string
}

func NewVersionSupportMatrix() *VersionSupportMatrix {
    return &VersionSupportMatrix{
        versions: map[string]VersionPolicy{
            "v1": {
                Status:         "deprecated",
                SunsetDate:     time.Date(2033, 1, 1, 0, 0, 0, 0, time.UTC),
                MigrationGuide: "https://docs.example.com/migrate/v1-v2",
            },
            "v2": {
                Status: "current",
            },
        },
    }
}

func (m *VersionSupportMatrix) Enforce(next http.Handler, version string) http.Handler {
    policy, ok := m.versions[version]
    if !ok {
        // Unknown version: reject
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusBadRequest)
            json.NewEncoder(w).Encode(map[string]string{
                "error":   "unsupported_version",
                "message": "Unknown API version: " + version,
            })
        })
    }

    switch policy.Status {
    case "sunset":
        return EnforceSunset(next, policy.SunsetDate, policy.MigrationGuide)
    case "deprecated":
        return DeprecationWarning(next, DeprecationInfo{
            Version:        version,
            SunsetDate:     policy.SunsetDate.Format("2006-01-02"),
            MigrationGuide: policy.MigrationGuide,
        })
    default:
        return next
    }
}
```

## Section 5: gRPC API Versioning

### 5.1 Package-Based Versioning

```protobuf
// api/user/v2/user.proto
syntax = "proto3";

package api.user.v2;

option go_package = "github.com/exampleorg/api/gen/user/v2;userv2";

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);

  // New in v2
  rpc BatchCreateUsers(BatchCreateUsersRequest) returns (BatchCreateUsersResponse);
}

message User {
  string id = 1;
  string first_name = 2;  // Changed from "name" in v1
  string last_name = 3;   // New in v2
  string email = 4;
  map<string, string> preferences = 5;  // New in v2
  int64 created_at = 6;
  int64 updated_at = 7;
}
```

### 5.2 gRPC Version Interceptor

```go
// grpc/interceptors.go
package grpc

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// VersionInterceptor validates the API version in gRPC metadata.
func VersionInterceptor(supportedVersions []string) grpc.UnaryServerInterceptor {
    supported := make(map[string]bool)
    for _, v := range supportedVersions {
        supported[v] = true
    }

    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return handler(ctx, req)
        }

        versions := md.Get("x-api-version")
        if len(versions) == 0 {
            return handler(ctx, req)
        }

        version := versions[0]
        if !supported[version] {
            return nil, status.Errorf(
                codes.InvalidArgument,
                "unsupported API version %q; supported versions: %v",
                version, supportedVersions,
            )
        }

        return handler(ctx, req)
    }
}

// DeprecationInterceptor adds deprecation metadata to responses.
func DeprecationInterceptor(deprecatedMethods map[string]string) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        resp, err := handler(ctx, req)

        if sunsetDate, deprecated := deprecatedMethods[info.FullMethod]; deprecated {
            trailer := metadata.Pairs(
                "x-deprecated", "true",
                "x-sunset-date", sunsetDate,
            )
            grpc.SetTrailer(ctx, trailer)
        }

        return resp, err
    }
}
```

## Section 6: Testing Backward Compatibility

### 6.1 Contract Testing

```go
// api/v2/contract_test.go
package v2_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    v2 "github.com/exampleorg/api/v2"
)

// TestV2Contract verifies that the V2 API satisfies its published contract.
// These tests must NOT change when backward-compatible additions are made.
// If these tests fail after a change, the change is breaking.
func TestV2Contract(t *testing.T) {
    handler := v2.NewHandler()
    server := httptest.NewServer(handler)
    defer server.Close()

    t.Run("GetUser returns required fields", func(t *testing.T) {
        resp, err := http.Get(server.URL + "/users/user-123")
        if err != nil {
            t.Fatal(err)
        }
        defer resp.Body.Close()

        if resp.StatusCode != http.StatusOK {
            t.Fatalf("Expected 200, got %d", resp.StatusCode)
        }

        var user map[string]any
        if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
            t.Fatal(err)
        }

        // Required fields — these must ALWAYS be present
        requiredFields := []string{"id", "firstName", "lastName", "email", "createdAt", "updatedAt"}
        for _, field := range requiredFields {
            if _, ok := user[field]; !ok {
                t.Errorf("Required field %q missing from V2 user response", field)
            }
        }

        // Deprecated/removed fields — these must NEVER be present in V2
        forbiddenFields := []string{"name", "legacyId"}
        for _, field := range forbiddenFields {
            if _, ok := user[field]; ok {
                t.Errorf("Deprecated field %q should not be present in V2 user response", field)
            }
        }
    })

    t.Run("V2 response includes API-Version header", func(t *testing.T) {
        resp, err := http.Get(server.URL + "/users/user-123")
        if err != nil {
            t.Fatal(err)
        }
        defer resp.Body.Close()

        if resp.Header.Get("API-Version") != "v2" {
            t.Errorf("Expected API-Version: v2, got %q", resp.Header.Get("API-Version"))
        }
    })

    t.Run("Unknown fields are ignored in requests", func(t *testing.T) {
        // Send a request with extra fields (forward compatibility test)
        body := `{
            "firstName": "Bob",
            "lastName": "Jones",
            "email": "bob@example.com",
            "unknownFutureField": "someValue",
            "anotherUnknownField": {"nested": "object"}
        }`
        resp, err := http.Post(server.URL+"/users",
            "application/json",
            strings.NewReader(body),
        )
        if err != nil {
            t.Fatal(err)
        }
        defer resp.Body.Close()

        // Must accept the request despite unknown fields
        if resp.StatusCode != http.StatusCreated {
            t.Errorf("Expected 201 Created when unknown fields present, got %d", resp.StatusCode)
        }
    })
}
```

### 6.2 OpenAPI-Based Contract Validation

```go
// testing/openapi_validator.go
package testing

import (
    "net/http"
    "testing"

    "github.com/pb33f/libopenapi-validator/requests"
    "github.com/pb33f/libopenapi-validator/responses"
    libopenapi "github.com/pb33f/libopenapi"
    "os"
)

// ContractValidator validates HTTP interactions against an OpenAPI spec.
type ContractValidator struct {
    requestValidator  *requests.RequestBodyValidator
    responseValidator *responses.ResponseBodyValidator
}

func NewContractValidator(t *testing.T, specFile string) *ContractValidator {
    t.Helper()

    spec, err := os.ReadFile(specFile)
    if err != nil {
        t.Fatalf("reading OpenAPI spec %s: %v", specFile, err)
    }

    doc, err := libopenapi.NewDocument(spec)
    if err != nil {
        t.Fatalf("parsing OpenAPI spec: %v", err)
    }

    _, errs := doc.BuildV3Model()
    if len(errs) > 0 {
        t.Fatalf("building OpenAPI model: %v", errs)
    }

    return &ContractValidator{}
}

func (v *ContractValidator) ValidateResponse(t *testing.T, resp *http.Response) {
    t.Helper()
    // Validate response against OpenAPI spec
    // This catches response schema violations before they reach clients
}
```

## Section 7: Versioning Decision Guide

### Summary

API versioning strategy selection for Go services:

| Scenario | Recommended Strategy |
|---|---|
| Public REST API | URL path versioning (`/v2/`) |
| Internal microservices | Header versioning (`X-API-Version`) |
| GraphQL API | Deprecation directives, no version numbers |
| gRPC services | Package-level versioning (`api.user.v2`) |
| Event/message schemas | Schema registry with compatibility modes |

The operational practices matter more than the technical choice:

1. **URL versioning** with path prefix is most visible and cache-friendly. It is the right default for any API with external consumers.

2. **Deprecation headers** (Sunset, Deprecation, Warning) are mandatory. Clients need programmatic ways to detect deprecated API usage in their monitoring.

3. **Maintain previous versions** for a minimum of 12 months after deprecation announcement for external APIs. 6 months is acceptable for internal APIs with alerting.

4. **Track deprecated feature usage** with Prometheus counters tagged by consumer (`User-Agent` or API key). Use this data to prioritize migration outreach — help the top consumers by usage first.

5. **Contract tests** that verify required fields and forbidden fields provide a regression safety net. Run them in CI on every commit and treat any failure as a breaking change.

6. **Never change the meaning of an existing field**. Changing a field from an integer to a boolean is breaking even if JSON coercion handles it today — eventually a client will deserialize to a strictly-typed model.
