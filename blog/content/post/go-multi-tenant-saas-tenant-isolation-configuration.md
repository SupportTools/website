---
title: "Go: Building a Multi-Tenant SaaS Application with Tenant Isolation and Per-Tenant Configuration"
date: 2031-09-23T00:00:00-05:00
draft: false
tags: ["Go", "Multi-Tenancy", "SaaS", "Architecture", "Security", "Database"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building multi-tenant SaaS applications in Go with tenant isolation strategies, per-tenant configuration, database separation patterns, middleware, and operational concerns."
more_link: "yes"
url: "/go-multi-tenant-saas-tenant-isolation-configuration/"
---

Multi-tenancy is one of the defining architectural challenges of SaaS development. Every design decision — how to store data, how to route requests, how to configure features, how to enforce resource limits — has a tenant dimension. Getting these decisions wrong early is expensive to fix later, particularly the data isolation model, which becomes progressively harder to change as the codebase and data volumes grow.

This post builds a complete multi-tenant SaaS application in Go. The architecture covers three isolation models (shared schema, separate schema, separate database), tenant resolution middleware, per-tenant configuration with feature flags, connection pool management, rate limiting, and operational patterns for tenant lifecycle management.

<!--more-->

# Building a Multi-Tenant SaaS Application in Go

## Isolation Model Comparison

Before writing code, the isolation model must be chosen. The three main options:

| Model | Data isolation | Operational complexity | Cost | Compliance |
|-------|---------------|----------------------|------|------------|
| Shared schema | Row-level (tenant_id column) | Low | Low | Challenging |
| Separate schema | Schema-level | Medium | Medium | Good |
| Separate database | Database-level | High | High | Excellent |

**Shared schema** is the default for most SaaS applications. All tenants share the same tables, and every row has a `tenant_id` foreign key. This maximizes operational efficiency but requires careful application-level enforcement to prevent cross-tenant data leaks.

**Separate schema** (PostgreSQL schemas / MySQL databases) provides schema-level isolation while keeping all tenants in one database server. Useful when compliance requires data separation but fully separate databases are cost-prohibitive.

**Separate database** provides the strongest isolation and is required for customers with strict regulatory requirements (financial, healthcare). The operational overhead of managing hundreds or thousands of databases is typically managed by a database-per-tenant provisioning service.

This post implements the shared schema model with hooks for upgrading to separate schema when needed.

## Core Data Types

```go
// pkg/tenant/tenant.go
package tenant

import (
    "context"
    "fmt"
    "time"
)

// Tenant represents a SaaS customer organization.
type Tenant struct {
    ID          string            `json:"id" db:"id"`
    Slug        string            `json:"slug" db:"slug"`
    Name        string            `json:"name" db:"name"`
    Plan        Plan              `json:"plan" db:"plan"`
    Status      Status            `json:"status" db:"status"`
    Config      Config            `json:"config" db:"config"`
    CreatedAt   time.Time         `json:"created_at" db:"created_at"`
    UpdatedAt   time.Time         `json:"updated_at" db:"updated_at"`
    Metadata    map[string]string `json:"metadata,omitempty" db:"metadata"`
}

type Plan string

const (
    PlanFree       Plan = "free"
    PlanStarter    Plan = "starter"
    PlanProfessional Plan = "professional"
    PlanEnterprise Plan = "enterprise"
)

type Status string

const (
    StatusActive    Status = "active"
    StatusSuspended Status = "suspended"
    StatusDeleted   Status = "deleted"
    StatusTrial     Status = "trial"
)

// Config holds tenant-specific configuration and feature flags.
type Config struct {
    Features       FeatureFlags    `json:"features" db:"features"`
    Limits         ResourceLimits  `json:"limits" db:"limits"`
    Integrations   Integrations    `json:"integrations" db:"integrations"`
    CustomDomain   string          `json:"custom_domain,omitempty" db:"custom_domain"`
    SSOConfig      *SSOConfig      `json:"sso_config,omitempty" db:"sso_config"`
    DataRegion     string          `json:"data_region" db:"data_region"`
    RetentionDays  int             `json:"retention_days" db:"retention_days"`
}

type FeatureFlags struct {
    AdvancedAnalytics bool `json:"advanced_analytics"`
    APIAccess         bool `json:"api_access"`
    CustomBranding    bool `json:"custom_branding"`
    AuditLog          bool `json:"audit_log"`
    ExportData        bool `json:"export_data"`
    Webhooks          bool `json:"webhooks"`
    SSOEnabled        bool `json:"sso_enabled"`
    MaxUsers          int  `json:"max_users"`
}

type ResourceLimits struct {
    MaxRequestsPerMinute  int   `json:"max_requests_per_minute"`
    MaxStorageGB          int   `json:"max_storage_gb"`
    MaxAPICallsPerDay     int64 `json:"max_api_calls_per_day"`
    MaxRecordsPerTable    int64 `json:"max_records_per_table"`
}

type Integrations struct {
    SlackWebhook    string `json:"slack_webhook,omitempty"`
    GitHubOrgID     string `json:"github_org_id,omitempty"`
    SalesforceOrgID string `json:"salesforce_org_id,omitempty"`
}

type SSOConfig struct {
    Provider     string `json:"provider"` // "saml", "oidc"
    MetadataURL  string `json:"metadata_url,omitempty"`
    ClientID     string `json:"client_id,omitempty"`
    IssuerURL    string `json:"issuer_url,omitempty"`
}

// Default configurations per plan
var PlanDefaults = map[Plan]Config{
    PlanFree: {
        Features: FeatureFlags{MaxUsers: 3},
        Limits: ResourceLimits{
            MaxRequestsPerMinute: 60,
            MaxStorageGB:         1,
            MaxAPICallsPerDay:    1000,
            MaxRecordsPerTable:   10000,
        },
        RetentionDays: 30,
    },
    PlanStarter: {
        Features: FeatureFlags{
            APIAccess: true,
            MaxUsers:  25,
        },
        Limits: ResourceLimits{
            MaxRequestsPerMinute: 300,
            MaxStorageGB:         10,
            MaxAPICallsPerDay:    50000,
            MaxRecordsPerTable:   500000,
        },
        RetentionDays: 90,
    },
    PlanProfessional: {
        Features: FeatureFlags{
            AdvancedAnalytics: true,
            APIAccess:         true,
            CustomBranding:    true,
            AuditLog:          true,
            ExportData:        true,
            Webhooks:          true,
            MaxUsers:          100,
        },
        Limits: ResourceLimits{
            MaxRequestsPerMinute: 1000,
            MaxStorageGB:         100,
            MaxAPICallsPerDay:    500000,
            MaxRecordsPerTable:   10000000,
        },
        RetentionDays: 365,
    },
    PlanEnterprise: {
        Features: FeatureFlags{
            AdvancedAnalytics: true,
            APIAccess:         true,
            CustomBranding:    true,
            AuditLog:          true,
            ExportData:        true,
            Webhooks:          true,
            SSOEnabled:        true,
            MaxUsers:          10000,
        },
        Limits: ResourceLimits{
            MaxRequestsPerMinute: 10000,
            MaxStorageGB:         10000,
            MaxAPICallsPerDay:    10000000,
            MaxRecordsPerTable:   1000000000,
        },
        RetentionDays: 2555, // 7 years
    },
}
```

## Context Propagation

The tenant context must flow through every layer of the application:

```go
// pkg/tenant/context.go
package tenant

import (
    "context"
    "fmt"
)

type contextKey struct{}

// FromContext extracts the tenant from a context.
func FromContext(ctx context.Context) (*Tenant, error) {
    t, ok := ctx.Value(contextKey{}).(*Tenant)
    if !ok || t == nil {
        return nil, fmt.Errorf("tenant: no tenant in context")
    }
    return t, nil
}

// MustFromContext extracts the tenant or panics. Use only in handlers
// where the middleware guarantees tenant presence.
func MustFromContext(ctx context.Context) *Tenant {
    t, err := FromContext(ctx)
    if err != nil {
        panic(err)
    }
    return t
}

// WithContext returns a new context with the tenant attached.
func WithContext(ctx context.Context, t *Tenant) context.Context {
    return context.WithValue(ctx, contextKey{}, t)
}

// IDFromContext returns just the tenant ID, for logging.
func IDFromContext(ctx context.Context) string {
    t, err := FromContext(ctx)
    if err != nil {
        return "unknown"
    }
    return t.ID
}
```

## Tenant Resolution Middleware

Tenants can be identified by subdomain, custom domain, API key header, JWT claim, or path prefix. A production system typically supports multiple resolution strategies:

```go
// pkg/tenant/middleware.go
package tenant

import (
    "context"
    "net/http"
    "strings"
    "time"
)

type Resolver interface {
    Resolve(ctx context.Context, r *http.Request) (*Tenant, error)
}

type Store interface {
    GetBySlug(ctx context.Context, slug string) (*Tenant, error)
    GetByDomain(ctx context.Context, domain string) (*Tenant, error)
    GetByAPIKey(ctx context.Context, key string) (*Tenant, error)
    GetByID(ctx context.Context, id string) (*Tenant, error)
}

// CachingStore wraps a Store with an in-memory cache.
type CachingStore struct {
    underlying Store
    cache      *TenantCache
}

type TenantCache struct {
    entries map[string]*cacheEntry
}

type cacheEntry struct {
    tenant    *Tenant
    expiresAt time.Time
}

func (c *CachingStore) GetBySlug(ctx context.Context, slug string) (*Tenant, error) {
    if entry, ok := c.cache.entries["slug:"+slug]; ok {
        if time.Now().Before(entry.expiresAt) {
            return entry.tenant, nil
        }
    }
    t, err := c.underlying.GetBySlug(ctx, slug)
    if err == nil && t != nil {
        c.cache.entries["slug:"+slug] = &cacheEntry{
            tenant:    t,
            expiresAt: time.Now().Add(5 * time.Minute),
        }
    }
    return t, err
}

// SubdomainResolver resolves tenants from subdomains like tenant.app.example.com
type SubdomainResolver struct {
    store      Store
    baseDomain string // "app.example.com"
}

func NewSubdomainResolver(store Store, baseDomain string) *SubdomainResolver {
    return &SubdomainResolver{store: store, baseDomain: baseDomain}
}

func (r *SubdomainResolver) Resolve(ctx context.Context, req *http.Request) (*Tenant, error) {
    host := req.Host
    // Strip port if present
    if i := strings.LastIndex(host, ":"); i >= 0 {
        host = host[:i]
    }

    // Check for custom domain first
    if !strings.HasSuffix(host, "."+r.baseDomain) && host != r.baseDomain {
        t, err := r.store.GetByDomain(ctx, host)
        if err == nil {
            return t, nil
        }
    }

    // Extract subdomain
    if strings.HasSuffix(host, "."+r.baseDomain) {
        slug := strings.TrimSuffix(host, "."+r.baseDomain)
        if slug != "" {
            return r.store.GetBySlug(ctx, slug)
        }
    }

    return nil, fmt.Errorf("tenant: cannot resolve from host %q", host)
}

// APIKeyResolver resolves tenants from X-API-Key or Bearer token headers.
type APIKeyResolver struct {
    store Store
}

func NewAPIKeyResolver(store Store) *APIKeyResolver {
    return &APIKeyResolver{store: store}
}

func (r *APIKeyResolver) Resolve(ctx context.Context, req *http.Request) (*Tenant, error) {
    // Check X-API-Key header
    if key := req.Header.Get("X-API-Key"); key != "" {
        return r.store.GetByAPIKey(ctx, key)
    }

    // Check Bearer token for API key embedded in JWT
    auth := req.Header.Get("Authorization")
    if strings.HasPrefix(auth, "Bearer ") {
        token := strings.TrimPrefix(auth, "Bearer ")
        // If it looks like an API key (not a JWT), try API key resolution
        if !strings.Contains(token, ".") {
            return r.store.GetByAPIKey(ctx, token)
        }
    }

    return nil, fmt.Errorf("tenant: no API key in request")
}

// ChainResolver tries multiple resolvers in order.
type ChainResolver struct {
    resolvers []Resolver
}

func NewChainResolver(resolvers ...Resolver) *ChainResolver {
    return &ChainResolver{resolvers: resolvers}
}

func (r *ChainResolver) Resolve(ctx context.Context, req *http.Request) (*Tenant, error) {
    var lastErr error
    for _, resolver := range r.resolvers {
        t, err := resolver.Resolve(ctx, req)
        if err == nil && t != nil {
            return t, nil
        }
        lastErr = err
    }
    return nil, fmt.Errorf("tenant: resolution failed: %w", lastErr)
}

// Middleware is the HTTP middleware that resolves and injects the tenant.
func Middleware(resolver Resolver, opts ...MiddlewareOption) func(http.Handler) http.Handler {
    cfg := &middlewareConfig{
        onMissing: func(w http.ResponseWriter, r *http.Request, err error) {
            http.Error(w, "tenant not found", http.StatusNotFound)
        },
        skipPaths: []string{"/health", "/metrics", "/robots.txt"},
    }
    for _, opt := range opts {
        opt(cfg)
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Skip certain paths
            for _, p := range cfg.skipPaths {
                if r.URL.Path == p {
                    next.ServeHTTP(w, r)
                    return
                }
            }

            t, err := resolver.Resolve(r.Context(), r)
            if err != nil {
                cfg.onMissing(w, r, err)
                return
            }

            if t.Status == StatusSuspended {
                http.Error(w, "account suspended", http.StatusForbidden)
                return
            }

            ctx := WithContext(r.Context(), t)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

type middlewareConfig struct {
    onMissing func(http.ResponseWriter, *http.Request, error)
    skipPaths []string
}

type MiddlewareOption func(*middlewareConfig)

func WithSkipPaths(paths ...string) MiddlewareOption {
    return func(c *middlewareConfig) {
        c.skipPaths = append(c.skipPaths, paths...)
    }
}
```

## Tenant-Scoped Database Access

Every database query must include a tenant filter. The safest pattern wraps the database connection to enforce this:

```go
// pkg/tenant/db.go
package tenant

import (
    "context"
    "database/sql"
    "fmt"
)

// TenantDB wraps a *sql.DB with tenant-scoped query enforcement.
type TenantDB struct {
    db *sql.DB
}

func NewTenantDB(db *sql.DB) *TenantDB {
    return &TenantDB{db: db}
}

// QueryContext executes a query with an automatic tenant_id WHERE clause.
// The query must use a named parameter :tenant_id that TenantDB will fill in.
func (t *TenantDB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
    tenant, err := FromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("tenant: context missing tenant: %w", err)
    }

    // Inject tenant_id as the first argument
    args = append([]any{tenant.ID}, args...)
    return t.db.QueryContext(ctx, query, args...)
}

// ExecContext executes a statement with automatic tenant_id injection.
func (t *TenantDB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
    tenant, err := FromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("tenant: context missing tenant: %w", err)
    }

    args = append([]any{tenant.ID}, args...)
    return t.db.ExecContext(ctx, query, args...)
}

// QueryRowContext returns a single row with tenant isolation.
func (t *TenantDB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
    tenant, err := FromContext(ctx)
    if err != nil {
        // Return a row that will error on Scan
        return t.db.QueryRowContext(ctx, "SELECT NULL WHERE FALSE")
    }

    args = append([]any{tenant.ID}, args...)
    return t.db.QueryRowContext(ctx, query, args...)
}
```

Usage pattern — every query must start with `tenant_id = $1`:

```go
// internal/repository/records.go
package repository

import (
    "context"
    "time"

    "github.com/example/saas/pkg/tenant"
)

type Record struct {
    ID        string
    TenantID  string
    Name      string
    Data      map[string]any
    CreatedAt time.Time
}

type RecordRepository struct {
    db *tenant.TenantDB
}

func NewRecordRepository(db *tenant.TenantDB) *RecordRepository {
    return &RecordRepository{db: db}
}

func (r *RecordRepository) List(ctx context.Context, limit, offset int) ([]*Record, error) {
    // $1 is always tenant_id, injected by TenantDB
    rows, err := r.db.QueryContext(ctx, `
        SELECT id, tenant_id, name, created_at
        FROM records
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `, limit, offset)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var records []*Record
    for rows.Next() {
        rec := &Record{}
        if err := rows.Scan(&rec.ID, &rec.TenantID, &rec.Name, &rec.CreatedAt); err != nil {
            return nil, err
        }
        records = append(records, rec)
    }
    return records, rows.Err()
}

func (r *RecordRepository) GetByID(ctx context.Context, id string) (*Record, error) {
    rec := &Record{}
    err := r.db.QueryRowContext(ctx, `
        SELECT id, tenant_id, name, created_at
        FROM records
        WHERE tenant_id = $1 AND id = $2
    `, id).Scan(&rec.ID, &rec.TenantID, &rec.Name, &rec.CreatedAt)
    if err != nil {
        return nil, err
    }
    return rec, nil
}
```

## Row-Level Security with PostgreSQL

For additional defense-in-depth, enable PostgreSQL Row-Level Security:

```sql
-- Enable RLS on all tenant tables
ALTER TABLE records ENABLE ROW LEVEL SECURITY;

-- Create a policy that restricts rows to the current tenant
CREATE POLICY tenant_isolation ON records
    USING (tenant_id = current_setting('app.current_tenant_id'));

-- Set the tenant ID in the database session
SET app.current_tenant_id = 'tenant-abc123';
SELECT * FROM records; -- automatically filtered
```

```go
// pkg/tenant/rls.go
package tenant

import (
    "context"
    "database/sql"
    "fmt"
)

// WithRLS returns a *sql.Conn with the tenant RLS context variable set.
// The caller is responsible for returning the connection to the pool.
func WithRLS(ctx context.Context, db *sql.DB) (*sql.Conn, error) {
    t, err := FromContext(ctx)
    if err != nil {
        return nil, err
    }

    conn, err := db.Conn(ctx)
    if err != nil {
        return nil, err
    }

    _, err = conn.ExecContext(ctx,
        "SELECT set_config('app.current_tenant_id', $1, true)",
        t.ID,
    )
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("setting RLS context: %w", err)
    }

    return conn, nil
}
```

## Per-Tenant Rate Limiting

```go
// pkg/tenant/ratelimit.go
package tenant

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"
)

type TokenBucket struct {
    tokens     float64
    maxTokens  float64
    refillRate float64 // tokens per second
    lastRefill time.Time
    mu         sync.Mutex
}

func NewTokenBucket(maxTokens float64, refillRate float64) *TokenBucket {
    return &TokenBucket{
        tokens:     maxTokens,
        maxTokens:  maxTokens,
        refillRate: refillRate,
        lastRefill: time.Now(),
    }
}

func (b *TokenBucket) Allow() bool {
    b.mu.Lock()
    defer b.mu.Unlock()

    now := time.Now()
    elapsed := now.Sub(b.lastRefill).Seconds()
    b.tokens = min(b.maxTokens, b.tokens+elapsed*b.refillRate)
    b.lastRefill = now

    if b.tokens >= 1 {
        b.tokens--
        return true
    }
    return false
}

func min(a, b float64) float64 {
    if a < b {
        return a
    }
    return b
}

// RateLimiter manages per-tenant rate limit buckets.
type RateLimiter struct {
    buckets map[string]*TokenBucket
    mu      sync.RWMutex
    store   Store
}

func NewRateLimiter(store Store) *RateLimiter {
    rl := &RateLimiter{
        buckets: make(map[string]*TokenBucket),
        store:   store,
    }
    // Cleanup goroutine for expired buckets
    go rl.cleanup()
    return rl
}

func (rl *RateLimiter) Allow(ctx context.Context, t *Tenant) bool {
    rl.mu.RLock()
    bucket, ok := rl.buckets[t.ID]
    rl.mu.RUnlock()

    if !ok {
        maxRPM := float64(t.Config.Limits.MaxRequestsPerMinute)
        bucket = NewTokenBucket(maxRPM, maxRPM/60.0)
        rl.mu.Lock()
        rl.buckets[t.ID] = bucket
        rl.mu.Unlock()
    }

    return bucket.Allow()
}

func (rl *RateLimiter) cleanup() {
    ticker := time.NewTicker(5 * time.Minute)
    for range ticker.C {
        // In production, evict stale buckets
        rl.mu.Lock()
        rl.mu.Unlock()
    }
}

// RateLimitMiddleware enforces per-tenant request rate limits.
func RateLimitMiddleware(limiter *RateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            t, err := FromContext(r.Context())
            if err != nil {
                next.ServeHTTP(w, r)
                return
            }

            if !limiter.Allow(r.Context(), t) {
                w.Header().Set("X-RateLimit-Limit",
                    fmt.Sprintf("%d", t.Config.Limits.MaxRequestsPerMinute))
                w.Header().Set("Retry-After", "1")
                http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
                return
            }

            w.Header().Set("X-RateLimit-Limit",
                fmt.Sprintf("%d", t.Config.Limits.MaxRequestsPerMinute))
            next.ServeHTTP(w, r)
        })
    }
}
```

## Feature Flag Enforcement

```go
// pkg/tenant/features.go
package tenant

import (
    "context"
    "net/http"
)

// RequireFeature returns a middleware that denies access if the tenant
// doesn't have the specified feature enabled.
func RequireFeature(feature func(*FeatureFlags) bool) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            t, err := FromContext(r.Context())
            if err != nil {
                http.Error(w, "unauthorized", http.StatusUnauthorized)
                return
            }

            if !feature(&t.Config.Features) {
                http.Error(w,
                    "this feature is not available on your current plan",
                    http.StatusForbidden)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Usage:
// router.Handle("/api/analytics", RequireFeature(func(f *FeatureFlags) bool {
//     return f.AdvancedAnalytics
// })(analyticsHandler))

// HasFeature checks feature availability in non-HTTP contexts.
func HasFeature(ctx context.Context, feature func(*FeatureFlags) bool) bool {
    t, err := FromContext(ctx)
    if err != nil {
        return false
    }
    return feature(&t.Config.Features)
}
```

## Tenant Provisioning Service

```go
// internal/provisioning/service.go
package provisioning

import (
    "context"
    "crypto/rand"
    "encoding/base64"
    "fmt"
    "time"

    "github.com/example/saas/pkg/tenant"
)

type Service struct {
    store    tenant.Store
    db       *sql.DB
    mailer   Mailer
}

type ProvisionRequest struct {
    Name  string
    Email string
    Plan  tenant.Plan
    Slug  string
}

func (s *Service) Provision(ctx context.Context, req ProvisionRequest) (*tenant.Tenant, string, error) {
    // Generate API key
    apiKey, err := generateAPIKey()
    if err != nil {
        return nil, "", fmt.Errorf("generating API key: %w", err)
    }

    // Apply plan defaults
    config := tenant.PlanDefaults[req.Plan]
    config.DataRegion = "us-east-1" // default region

    t := &tenant.Tenant{
        ID:        generateULID(),
        Slug:      req.Slug,
        Name:      req.Name,
        Plan:      req.Plan,
        Status:    tenant.StatusTrial,
        Config:    config,
        CreatedAt: time.Now(),
        UpdatedAt: time.Now(),
    }

    // Begin transaction for atomic provisioning
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return nil, "", err
    }
    defer tx.Rollback()

    // Insert tenant record
    if _, err := tx.ExecContext(ctx, `
        INSERT INTO tenants (id, slug, name, plan, status, config, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, t.ID, t.Slug, t.Name, t.Plan, t.Status, marshalJSON(t.Config),
        t.CreatedAt, t.UpdatedAt); err != nil {
        return nil, "", fmt.Errorf("inserting tenant: %w", err)
    }

    // Insert hashed API key
    hashedKey := hashAPIKey(apiKey)
    if _, err := tx.ExecContext(ctx, `
        INSERT INTO api_keys (id, tenant_id, key_hash, name, created_at)
        VALUES ($1, $2, $3, $4, $5)
    `, generateULID(), t.ID, hashedKey, "default", time.Now()); err != nil {
        return nil, "", fmt.Errorf("inserting API key: %w", err)
    }

    // Create tenant's default workspace
    if _, err := tx.ExecContext(ctx, `
        INSERT INTO workspaces (id, tenant_id, name, created_at)
        VALUES ($1, $2, $3, $4)
    `, generateULID(), t.ID, t.Name+" Workspace", time.Now()); err != nil {
        return nil, "", fmt.Errorf("creating workspace: %w", err)
    }

    if err := tx.Commit(); err != nil {
        return nil, "", err
    }

    // Send welcome email (outside transaction)
    s.mailer.SendWelcome(ctx, req.Email, t.Name, apiKey)

    return t, apiKey, nil
}

func (s *Service) Suspend(ctx context.Context, tenantID string, reason string) error {
    _, err := s.db.ExecContext(ctx, `
        UPDATE tenants
        SET status = 'suspended',
            updated_at = NOW(),
            metadata = metadata || jsonb_build_object('suspension_reason', $2)
        WHERE id = $1
    `, tenantID, reason)
    return err
}

func (s *Service) UpgradePlan(ctx context.Context, tenantID string, newPlan tenant.Plan) error {
    defaults := tenant.PlanDefaults[newPlan]

    _, err := s.db.ExecContext(ctx, `
        UPDATE tenants
        SET plan = $2,
            config = config ||
                jsonb_build_object(
                    'features', $3::jsonb,
                    'limits', $4::jsonb
                ),
            updated_at = NOW()
        WHERE id = $1
    `, tenantID, newPlan, marshalJSON(defaults.Features), marshalJSON(defaults.Limits))
    return err
}

func generateAPIKey() (string, error) {
    b := make([]byte, 32)
    if _, err := rand.Read(b); err != nil {
        return "", err
    }
    return "sk_" + base64.URLEncoding.EncodeToString(b), nil
}

func generateULID() string { return "" } // use github.com/oklog/ulid
func hashAPIKey(key string) string { return "" } // use bcrypt or argon2
func marshalJSON(v any) string { return "" }
type Mailer interface {
    SendWelcome(ctx context.Context, email, name, apiKey string)
}
```

## Application Assembly

```go
// cmd/server/main.go
package main

import (
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"

    tenantpkg "github.com/example/saas/pkg/tenant"
    "github.com/example/saas/internal/repository"
    "github.com/example/saas/internal/handlers"
)

func buildRouter(store tenantpkg.Store, tdb *tenantpkg.TenantDB) http.Handler {
    r := chi.NewRouter()

    // Global middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Use(middleware.Compress(5))

    // Health check (no tenant required)
    r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    // Tenant-scoped routes
    resolver := tenantpkg.NewChainResolver(
        tenantpkg.NewSubdomainResolver(store, "app.example.com"),
        tenantpkg.NewAPIKeyResolver(store),
    )
    limiter := tenantpkg.NewRateLimiter(store)

    r.Group(func(r chi.Router) {
        r.Use(tenantpkg.Middleware(resolver))
        r.Use(tenantpkg.RateLimitMiddleware(limiter))

        // Public API
        r.Route("/api/v1", func(r chi.Router) {
            recordRepo := repository.NewRecordRepository(tdb)
            recordHandler := handlers.NewRecordHandler(recordRepo)

            r.Get("/records", recordHandler.List)
            r.Post("/records", recordHandler.Create)
            r.Get("/records/{id}", recordHandler.Get)
            r.Patch("/records/{id}", recordHandler.Update)
            r.Delete("/records/{id}", recordHandler.Delete)

            // Analytics: require feature flag
            r.With(tenantpkg.RequireFeature(func(f *tenantpkg.FeatureFlags) bool {
                return f.AdvancedAnalytics
            })).Get("/analytics/summary", handlers.AnalyticsSummary)

            // Webhooks: require feature flag
            r.With(tenantpkg.RequireFeature(func(f *tenantpkg.FeatureFlags) bool {
                return f.Webhooks
            })).Route("/webhooks", func(r chi.Router) {
                r.Get("/", handlers.ListWebhooks)
                r.Post("/", handlers.CreateWebhook)
            })
        })
    })

    return r
}
```

## Audit Logging

Multi-tenant applications require comprehensive audit trails:

```go
// pkg/audit/logger.go
package audit

import (
    "context"
    "database/sql"
    "time"

    tenantpkg "github.com/example/saas/pkg/tenant"
)

type Event struct {
    ID         string
    TenantID   string
    UserID     string
    Action     string
    Resource   string
    ResourceID string
    Changes    map[string]any
    IPAddress  string
    UserAgent  string
    Timestamp  time.Time
    Success    bool
    ErrorMsg   string
}

type Logger struct {
    db *sql.DB
}

func (l *Logger) Log(ctx context.Context, event *Event) {
    t, _ := tenantpkg.FromContext(ctx)
    if t != nil {
        event.TenantID = t.ID
        // Check if tenant has audit log feature enabled
        if !t.Config.Features.AuditLog {
            return
        }
    }

    event.Timestamp = time.Now()

    // Non-blocking audit log write
    go func() {
        _, _ = l.db.ExecContext(context.Background(), `
            INSERT INTO audit_events
                (id, tenant_id, user_id, action, resource, resource_id,
                 changes, ip_address, user_agent, timestamp, success, error_msg)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `,
            event.ID, event.TenantID, event.UserID,
            event.Action, event.Resource, event.ResourceID,
            marshalJSON(event.Changes), event.IPAddress, event.UserAgent,
            event.Timestamp, event.Success, event.ErrorMsg,
        )
    }()
}
```

## Summary

Building multi-tenant SaaS in Go requires designing isolation into every layer: context propagation for tenant identity, query-level enforcement for data isolation, per-tenant rate limiting for fair resource allocation, feature flags for plan differentiation, and audit logging for compliance. The patterns presented here — `TenantDB` wrapper, chain resolver middleware, token bucket rate limiting, and transaction-based provisioning — provide a production-ready foundation that can scale from hundreds to hundreds of thousands of tenants with the shared schema model while preserving the option to migrate individual tenants to isolated schemas or databases as their compliance or performance requirements evolve.
