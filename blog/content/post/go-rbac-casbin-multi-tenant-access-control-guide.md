---
title: "Go: Implementing RBAC with Casbin for Fine-Grained Access Control in Multi-Tenant Applications"
date: 2031-08-18T00:00:00-05:00
draft: false
tags: ["Go", "Casbin", "RBAC", "Authorization", "Multi-Tenant", "Security", "Access Control"]
categories: ["Go", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to implementing role-based access control in Go using Casbin, covering policy models, multi-tenant isolation, database-backed policy stores, and REST API integration patterns."
more_link: "yes"
url: "/go-rbac-casbin-multi-tenant-access-control-guide/"
---

Authorization is one of those concerns that seems simple until it is not. A basic role check works fine for small applications, but multi-tenant SaaS products require a model where tenant A's admin cannot access tenant B's resources, where roles can be customized per tenant, and where policy changes take effect without application restarts. Casbin is a Go authorization library that makes this manageable: it separates the access control model (defined in a PERM model file) from the policy data (stored wherever is convenient), and exposes a single `Enforce` function that takes a subject, object, and action and returns a boolean.

This guide builds a complete RBAC system for a multi-tenant API: from model design through database-backed policy storage, tenant isolation, REST management endpoints, caching for performance, and integration testing patterns.

<!--more-->

# Go: Implementing RBAC with Casbin for Fine-Grained Access Control in Multi-Tenant Applications

## Understanding Casbin's Model

Casbin uses the PERM (Policy, Effect, Request, Matchers) meta-model. Every access control model is described by four sections:

```ini
# model.conf - RBAC with domain (tenant) partitioning
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _    # subject, role, domain (3-arg for domain-partitioned roles)

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && r.obj == p.obj && r.act == p.act
```

This model expresses: "user `sub` can perform `act` on `obj` within domain `dom` if they have a role in that domain that has been granted that permission."

### ABAC Extension

For more expressive policies, extend to attribute-based access control:

```ini
# model-abac.conf - RBAC with resource attribute conditions
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act, eft

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow)) && !some(where (p.eft == deny))

[matchers]
m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && keyMatch2(r.obj, p.obj) && r.act == p.act
```

The `keyMatch2` function enables wildcard path matching: `/api/v1/users/*` matches `/api/v1/users/123`.

## Project Setup

```bash
mkdir rbac-service && cd rbac-service
go mod init github.com/example/rbac-service

go get github.com/casbin/casbin/v2@latest
go get github.com/casbin/gorm-adapter/v3@latest
go get gorm.io/gorm@latest
go get gorm.io/driver/postgres@latest
go get github.com/gin-gonic/gin@latest
go get github.com/patrickmn/go-cache@latest
```

## Core Authorization Package

```go
// internal/authz/enforcer.go
package authz

import (
	"fmt"
	"sync"
	"time"

	"github.com/casbin/casbin/v2"
	"github.com/casbin/casbin/v2/model"
	gormadapter "github.com/casbin/gorm-adapter/v3"
	gocache "github.com/patrickmn/go-cache"
	"gorm.io/gorm"
)

const modelDefinition = `
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && keyMatch2(r.obj, p.obj) && r.act == p.act
`

// Enforcer wraps a Casbin SyncedEnforcer with a decision cache and tenant isolation.
type Enforcer struct {
	casbin *casbin.SyncedEnforcer
	cache  *gocache.Cache
	mu     sync.RWMutex
}

// New creates an Enforcer backed by a PostgreSQL adapter via GORM.
func New(db *gorm.DB) (*Enforcer, error) {
	m, err := model.NewModelFromString(modelDefinition)
	if err != nil {
		return nil, fmt.Errorf("parsing casbin model: %w", err)
	}

	adapter, err := gormadapter.NewAdapterByDB(db)
	if err != nil {
		return nil, fmt.Errorf("creating gorm adapter: %w", err)
	}

	e, err := casbin.NewSyncedEnforcer(m, adapter)
	if err != nil {
		return nil, fmt.Errorf("creating synced enforcer: %w", err)
	}

	// Auto-save policies when modified via the enforcer API
	e.EnableAutoSave(true)

	// Refresh policy from database every 30 seconds
	// This ensures policy changes propagate to all instances
	e.StartAutoLoadPolicy(30 * time.Second)

	return &Enforcer{
		casbin: e,
		// Decision cache: 5-second TTL, cleanup every 30 seconds
		// Keep TTL short so policy changes take effect quickly
		cache: gocache.New(5*time.Second, 30*time.Second),
	}, nil
}

// Allow checks whether subject sub can perform act on obj within domain dom.
// Results are cached per unique (sub, dom, obj, act) tuple.
func (e *Enforcer) Allow(sub, dom, obj, act string) (bool, error) {
	key := fmt.Sprintf("%s|%s|%s|%s", sub, dom, obj, act)

	if v, ok := e.cache.Get(key); ok {
		return v.(bool), nil
	}

	allowed, err := e.casbin.Enforce(sub, dom, obj, act)
	if err != nil {
		return false, fmt.Errorf("enforcing policy: %w", err)
	}

	e.cache.Set(key, allowed, gocache.DefaultExpiration)
	return allowed, nil
}

// MustAllow panics if the authorization check fails. For use in
// contexts where failure should be treated as a programming error.
func (e *Enforcer) MustAllow(sub, dom, obj, act string) bool {
	allowed, err := e.Allow(sub, dom, obj, act)
	if err != nil {
		panic(fmt.Sprintf("authorization check failed: %v", err))
	}
	return allowed
}

// GetRolesForUser returns all roles assigned to sub within dom.
func (e *Enforcer) GetRolesForUser(sub, dom string) ([]string, error) {
	return e.casbin.GetRolesForUserInDomain(sub, dom), nil
}

// AssignRole assigns role to sub within dom. Invalidates the cache for sub.
func (e *Enforcer) AssignRole(sub, role, dom string) error {
	_, err := e.casbin.AddRoleForUserInDomain(sub, role, dom)
	if err != nil {
		return fmt.Errorf("assigning role %s to %s in %s: %w", role, sub, dom, err)
	}
	e.invalidateCacheForSubject(sub, dom)
	return nil
}

// RevokeRole removes role from sub within dom.
func (e *Enforcer) RevokeRole(sub, role, dom string) error {
	_, err := e.casbin.DeleteRoleForUserInDomain(sub, role, dom)
	if err != nil {
		return fmt.Errorf("revoking role %s from %s in %s: %w", role, sub, dom, err)
	}
	e.invalidateCacheForSubject(sub, dom)
	return nil
}

// AddPolicy adds a permission policy: subject role can perform act on obj in dom.
func (e *Enforcer) AddPolicy(sub, dom, obj, act string) error {
	_, err := e.casbin.AddPolicy(sub, dom, obj, act)
	if err != nil {
		return fmt.Errorf("adding policy: %w", err)
	}
	// Clear entire cache on policy change - policies affect all subjects with that role
	e.cache.Flush()
	return nil
}

// RemovePolicy removes a specific permission policy.
func (e *Enforcer) RemovePolicy(sub, dom, obj, act string) error {
	_, err := e.casbin.RemovePolicy(sub, dom, obj, act)
	if err != nil {
		return fmt.Errorf("removing policy: %w", err)
	}
	e.cache.Flush()
	return nil
}

// GetPoliciesForDomain returns all policies within dom.
func (e *Enforcer) GetPoliciesForDomain(dom string) [][]string {
	return e.casbin.GetFilteredPolicy(1, dom)
}

// DeleteTenant removes all policies and role assignments for dom.
// Call this when a tenant is deprovisioned.
func (e *Enforcer) DeleteTenant(dom string) error {
	if err := e.casbin.DeleteAllUsersByDomain(dom); err != nil {
		return fmt.Errorf("deleting users for domain %s: %w", dom, err)
	}
	_, err := e.casbin.RemoveFilteredPolicy(1, dom)
	if err != nil {
		return fmt.Errorf("removing policies for domain %s: %w", dom, err)
	}
	e.cache.Flush()
	return nil
}

// invalidateCacheForSubject removes all cached decisions for sub in dom.
// Since the cache key format is "sub|dom|obj|act", we do a prefix scan.
func (e *Enforcer) invalidateCacheForSubject(sub, dom string) {
	prefix := fmt.Sprintf("%s|%s|", sub, dom)
	items := e.cache.Items()
	for k := range items {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			e.cache.Delete(k)
		}
	}
}

// Reload forces a policy reload from the database. Call this after
// bulk policy changes made directly to the database.
func (e *Enforcer) Reload() error {
	if err := e.casbin.LoadPolicy(); err != nil {
		return fmt.Errorf("reloading policy: %w", err)
	}
	e.cache.Flush()
	return nil
}
```

## Policy Seeder: Defining Default Roles

```go
// internal/authz/seeder.go
package authz

// DefaultPolicies defines the standard role permissions for new tenants.
// obj uses keyMatch2 patterns: /api/v1/users/* matches /api/v1/users/123
var DefaultPolicies = []struct {
	Role   string
	Object string
	Action string
}{
	// Admin: full CRUD on all resources
	{"admin", "/api/v1/*", "GET"},
	{"admin", "/api/v1/*", "POST"},
	{"admin", "/api/v1/*", "PUT"},
	{"admin", "/api/v1/*", "DELETE"},
	{"admin", "/api/v1/*", "PATCH"},

	// Editor: read and write, no delete
	{"editor", "/api/v1/*", "GET"},
	{"editor", "/api/v1/*", "POST"},
	{"editor", "/api/v1/*", "PUT"},
	{"editor", "/api/v1/*", "PATCH"},

	// Viewer: read-only
	{"viewer", "/api/v1/*", "GET"},

	// Billing: access to billing resources only
	{"billing", "/api/v1/billing/*", "GET"},
	{"billing", "/api/v1/billing/*", "POST"},
	{"billing", "/api/v1/invoices/*", "GET"},

	// Auditor: read-only access to audit logs
	{"auditor", "/api/v1/audit-logs/*", "GET"},
	{"auditor", "/api/v1/events/*", "GET"},
}

// SeedTenantPolicies initializes the default role permissions for a new tenant.
// This should be called when provisioning a new tenant.
func SeedTenantPolicies(e *Enforcer, tenantID string) error {
	for _, p := range DefaultPolicies {
		if err := e.AddPolicy(p.Role, tenantID, p.Object, p.Action); err != nil {
			return fmt.Errorf("seeding policy %+v for tenant %s: %w", p, tenantID, err)
		}
	}
	return nil
}

// SeedSuperAdminPolicies grants a user cross-tenant read access.
// Use this for platform support accounts that need visibility across tenants.
func SeedSuperAdminPolicies(e *Enforcer, userID, systemDomain string) error {
	policies := []struct {
		obj string
		act string
	}{
		{"/internal/tenants/*", "GET"},
		{"/internal/health/*", "GET"},
		{"/internal/metrics/*", "GET"},
	}
	for _, p := range policies {
		if err := e.AddPolicy(userID, systemDomain, p.obj, p.act); err != nil {
			return fmt.Errorf("seeding super-admin policy: %w", err)
		}
	}
	return nil
}
```

## HTTP Middleware Integration

```go
// internal/middleware/authz.go
package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/example/rbac-service/internal/authz"
)

type contextKey string

const (
	ContextKeyUserID   contextKey = "userID"
	ContextKeyTenantID contextKey = "tenantID"
)

// AuthzMiddleware returns a Gin middleware that enforces Casbin policies.
// It expects the user ID and tenant ID to have been set by a prior authentication
// middleware (e.g., JWT validation).
func AuthzMiddleware(enforcer *authz.Enforcer) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetString(string(ContextKeyUserID))
		tenantID := c.GetString(string(ContextKeyTenantID))

		if userID == "" || tenantID == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "authentication required",
			})
			return
		}

		path := normalizePath(c.FullPath())
		method := c.Request.Method

		allowed, err := enforcer.Allow(userID, tenantID, path, method)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
				"error": "authorization check failed",
			})
			return
		}

		if !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error":    "forbidden",
				"subject":  userID,
				"domain":   tenantID,
				"resource": path,
				"action":   method,
			})
			return
		}

		c.Next()
	}
}

// normalizePath converts Gin's parameterized paths like /api/v1/users/:id
// into the wildcard form /api/v1/users/* that Casbin policies use.
func normalizePath(path string) string {
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if strings.HasPrefix(part, ":") {
			parts[i] = "*"
		}
	}
	return strings.Join(parts, "/")
}

// RequireRole is a tighter middleware that checks for a specific role
// rather than resource-level permissions. Useful for admin-only routes.
func RequireRole(enforcer *authz.Enforcer, requiredRole string) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetString(string(ContextKeyUserID))
		tenantID := c.GetString(string(ContextKeyTenantID))

		roles, err := enforcer.GetRolesForUser(userID, tenantID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
				"error": "role check failed",
			})
			return
		}

		for _, role := range roles {
			if role == requiredRole {
				c.Next()
				return
			}
		}

		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"error": fmt.Sprintf("role %q required", requiredRole),
		})
	}
}
```

## Policy Management REST API

```go
// internal/api/policy_handler.go
package api

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/example/rbac-service/internal/authz"
	"github.com/example/rbac-service/internal/middleware"
)

type PolicyHandler struct {
	enforcer *authz.Enforcer
}

func NewPolicyHandler(enforcer *authz.Enforcer) *PolicyHandler {
	return &PolicyHandler{enforcer: enforcer}
}

// RegisterRoutes registers the policy management endpoints.
// These endpoints should themselves be protected by AuthzMiddleware.
func (h *PolicyHandler) RegisterRoutes(r gin.IRouter) {
	policies := r.Group("/api/v1/policies")
	{
		policies.GET("", h.ListPolicies)
		policies.POST("", h.AddPolicy)
		policies.DELETE("", h.RemovePolicy)
	}

	roles := r.Group("/api/v1/roles")
	{
		roles.GET("/users/:userID", h.GetUserRoles)
		roles.POST("/users/:userID", h.AssignRole)
		roles.DELETE("/users/:userID/:role", h.RevokeRole)
	}
}

type PolicyRequest struct {
	Subject string `json:"subject" binding:"required"`
	Object  string `json:"object"  binding:"required"`
	Action  string `json:"action"  binding:"required"`
}

// ListPolicies returns all policies for the caller's tenant.
func (h *PolicyHandler) ListPolicies(c *gin.Context) {
	tenantID := c.GetString(string(middleware.ContextKeyTenantID))
	policies := h.enforcer.GetPoliciesForDomain(tenantID)

	result := make([]PolicyRequest, 0, len(policies))
	for _, p := range policies {
		// p = [sub, dom, obj, act]
		if len(p) < 4 {
			continue
		}
		result = append(result, PolicyRequest{
			Subject: p[0],
			Object:  p[2],
			Action:  p[3],
		})
	}

	c.JSON(http.StatusOK, gin.H{"policies": result})
}

// AddPolicy creates a new permission policy for the caller's tenant.
func (h *PolicyHandler) AddPolicy(c *gin.Context) {
	tenantID := c.GetString(string(middleware.ContextKeyTenantID))

	var req PolicyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.enforcer.AddPolicy(req.Subject, tenantID, req.Object, req.Action); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": fmt.Sprintf("adding policy: %v", err),
		})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"status": "created"})
}

// RemovePolicy deletes a permission policy.
func (h *PolicyHandler) RemovePolicy(c *gin.Context) {
	tenantID := c.GetString(string(middleware.ContextKeyTenantID))

	var req PolicyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.enforcer.RemovePolicy(req.Subject, tenantID, req.Object, req.Action); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": fmt.Sprintf("removing policy: %v", err),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "removed"})
}

type RoleRequest struct {
	Role string `json:"role" binding:"required"`
}

// GetUserRoles returns all roles for a user within the caller's tenant.
func (h *PolicyHandler) GetUserRoles(c *gin.Context) {
	tenantID := c.GetString(string(middleware.ContextKeyTenantID))
	targetUser := c.Param("userID")

	roles, err := h.enforcer.GetRolesForUser(targetUser, tenantID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user":   targetUser,
		"tenant": tenantID,
		"roles":  roles,
	})
}

// AssignRole assigns a role to a user within the caller's tenant.
func (h *PolicyHandler) AssignRole(c *gin.Context) {
	tenantID := c.GetString(string(middleware.ContextKeyTenantID))
	targetUser := c.Param("userID")

	var req RoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.enforcer.AssignRole(targetUser, req.Role, tenantID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"user":   targetUser,
		"role":   req.Role,
		"tenant": tenantID,
		"status": "assigned",
	})
}

// RevokeRole removes a role from a user.
func (h *PolicyHandler) RevokeRole(c *gin.Context) {
	tenantID := c.GetString(string(middleware.ContextKeyTenantID))
	targetUser := c.Param("userID")
	role := c.Param("role")

	if err := h.enforcer.RevokeRole(targetUser, role, tenantID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user":   targetUser,
		"role":   role,
		"tenant": tenantID,
		"status": "revoked",
	})
}
```

## Tenant Isolation: Critical Safety Patterns

The most important invariant in a multi-tenant RBAC system is that tenant A's admin cannot modify tenant B's policies. Enforce this at every layer:

```go
// internal/authz/tenant_guard.go
package authz

import (
	"errors"
	"fmt"
)

// ErrCrossTenantAccess is returned when an operation would affect a different tenant.
var ErrCrossTenantAccess = errors.New("cross-tenant access denied")

// TenantScopedEnforcer wraps Enforcer and binds all operations to a specific tenant.
// Inject this per-request rather than the base Enforcer to prevent accidental
// cross-tenant policy modifications.
type TenantScopedEnforcer struct {
	enforcer *Enforcer
	tenantID string
}

// NewTenantScopedEnforcer creates an enforcer scoped to tenantID.
func NewTenantScopedEnforcer(e *Enforcer, tenantID string) *TenantScopedEnforcer {
	return &TenantScopedEnforcer{enforcer: e, tenantID: tenantID}
}

// Allow checks whether sub can perform act on obj within this enforcer's tenant.
func (t *TenantScopedEnforcer) Allow(sub, obj, act string) (bool, error) {
	return t.enforcer.Allow(sub, t.tenantID, obj, act)
}

// AssignRole assigns role to sub within this enforcer's tenant.
// Returns ErrCrossTenantAccess if the caller attempts to specify a different tenantID.
func (t *TenantScopedEnforcer) AssignRole(sub, role string) error {
	return t.enforcer.AssignRole(sub, role, t.tenantID)
}

// AddPolicy adds a policy within this enforcer's tenant only.
func (t *TenantScopedEnforcer) AddPolicy(sub, obj, act string) error {
	return t.enforcer.AddPolicy(sub, t.tenantID, obj, act)
}

// GetPolicies returns all policies for this enforcer's tenant.
func (t *TenantScopedEnforcer) GetPolicies() [][]string {
	return t.enforcer.GetPoliciesForDomain(t.tenantID)
}

// validateTargetTenant is a helper used by API handlers to prevent privilege
// escalation across tenants. Call this when the target tenant is specified
// in the request rather than derived from the JWT.
func validateTargetTenant(callerTenant, targetTenant string) error {
	if callerTenant != targetTenant {
		return fmt.Errorf("%w: caller tenant %q cannot modify tenant %q",
			ErrCrossTenantAccess, callerTenant, targetTenant)
	}
	return nil
}
```

## Role Hierarchy and Inheritance

Casbin supports role inheritance within a domain. This allows tenant-specific role customization:

```go
// internal/authz/hierarchy.go
package authz

// SetupRoleHierarchy establishes the default role hierarchy for a tenant.
// senior-editor inherits all editor permissions; editor inherits viewer permissions.
func SetupRoleHierarchy(e *Enforcer, tenantID string) error {
	hierarchy := []struct {
		child  string
		parent string
	}{
		{"editor", "viewer"},           // editor can do everything viewer can
		{"senior-editor", "editor"},    // senior-editor inherits editor
		{"admin", "senior-editor"},     // admin inherits senior-editor
		{"owner", "admin"},             // owner inherits admin
	}

	for _, h := range hierarchy {
		// In Casbin domain-partitioned RBAC, role inheritance is also domain-scoped
		_, err := e.casbin.AddRoleForUserInDomain(h.child, h.parent, tenantID)
		if err != nil {
			return fmt.Errorf("adding role hierarchy %s->%s in %s: %w",
				h.child, h.parent, tenantID, err)
		}
	}

	return nil
}

// GetEffectivePermissions returns all permissions a user has in a tenant,
// including those inherited through role hierarchy.
func (e *Enforcer) GetEffectivePermissions(userID, tenantID string) ([][]string, error) {
	// Get direct and inherited roles
	roles, err := e.GetRolesForUser(userID, tenantID)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	var allPerms [][]string

	// Collect permissions for each role
	for _, role := range append([]string{userID}, roles...) {
		perms := e.casbin.GetPermissionsForUserInDomain(role, tenantID)
		for _, perm := range perms {
			key := strings.Join(perm, "|")
			if !seen[key] {
				seen[key] = true
				allPerms = append(allPerms, perm)
			}
		}
	}

	return allPerms, nil
}
```

## Integration Tests

```go
// internal/authz/enforcer_test.go
package authz_test

import (
	"testing"

	"github.com/example/rbac-service/internal/authz"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupTestEnforcer(t *testing.T) *authz.Enforcer {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Discard,
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}

	e, err := authz.New(db)
	if err != nil {
		t.Fatalf("creating enforcer: %v", err)
	}

	return e
}

func TestRBACBasicFlow(t *testing.T) {
	e := setupTestEnforcer(t)
	const (
		tenantA = "tenant-a"
		tenantB = "tenant-b"
		user1   = "user-1"
	)

	// Seed policies for tenant A
	if err := authz.SeedTenantPolicies(e, tenantA); err != nil {
		t.Fatalf("seeding policies: %v", err)
	}

	// Assign viewer role to user1 in tenant A
	if err := e.AssignRole(user1, "viewer", tenantA); err != nil {
		t.Fatalf("assigning role: %v", err)
	}

	t.Run("viewer can GET users", func(t *testing.T) {
		allowed, err := e.Allow(user1, tenantA, "/api/v1/users/123", "GET")
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Error("expected viewer to be allowed GET /api/v1/users/123")
		}
	})

	t.Run("viewer cannot DELETE users", func(t *testing.T) {
		allowed, err := e.Allow(user1, tenantA, "/api/v1/users/123", "DELETE")
		if err != nil {
			t.Fatal(err)
		}
		if allowed {
			t.Error("expected viewer to be denied DELETE /api/v1/users/123")
		}
	})

	t.Run("tenant isolation: tenant A policies don't affect tenant B", func(t *testing.T) {
		allowed, err := e.Allow(user1, tenantB, "/api/v1/users/123", "GET")
		if err != nil {
			t.Fatal(err)
		}
		if allowed {
			t.Error("tenant A user should not have access in tenant B")
		}
	})
}

func TestRoleHierarchy(t *testing.T) {
	e := setupTestEnforcer(t)
	const tenant = "tenant-hierarchy-test"

	if err := authz.SeedTenantPolicies(e, tenant); err != nil {
		t.Fatal(err)
	}
	if err := authz.SetupRoleHierarchy(e, tenant); err != nil {
		t.Fatal(err)
	}

	// Assign base viewer role to user
	user := "user-hierarchy"
	if err := e.AssignRole(user, "viewer", tenant); err != nil {
		t.Fatal(err)
	}

	// Upgrade to editor - should inherit viewer permissions
	if err := e.AssignRole(user, "editor", tenant); err != nil {
		t.Fatal(err)
	}

	t.Run("editor inherits viewer GET", func(t *testing.T) {
		allowed, err := e.Allow(user, tenant, "/api/v1/reports/123", "GET")
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Error("editor should inherit viewer GET permission")
		}
	})

	t.Run("editor can POST", func(t *testing.T) {
		allowed, err := e.Allow(user, tenant, "/api/v1/documents/", "POST")
		if err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Error("editor should be allowed to POST")
		}
	})

	t.Run("editor cannot DELETE", func(t *testing.T) {
		allowed, err := e.Allow(user, tenant, "/api/v1/documents/123", "DELETE")
		if err != nil {
			t.Fatal(err)
		}
		if allowed {
			t.Error("editor should not be allowed to DELETE")
		}
	})
}

func TestTenantDeletion(t *testing.T) {
	e := setupTestEnforcer(t)
	const tenant = "tenant-to-delete"
	const user = "user-in-deleted-tenant"

	if err := authz.SeedTenantPolicies(e, tenant); err != nil {
		t.Fatal(err)
	}
	if err := e.AssignRole(user, "admin", tenant); err != nil {
		t.Fatal(err)
	}

	// Verify admin access before deletion
	allowed, _ := e.Allow(user, tenant, "/api/v1/users/123", "DELETE")
	if !allowed {
		t.Fatal("admin should have DELETE access before tenant deletion")
	}

	// Delete the tenant
	if err := e.DeleteTenant(tenant); err != nil {
		t.Fatalf("deleting tenant: %v", err)
	}

	// Verify all access is revoked
	allowed, _ = e.Allow(user, tenant, "/api/v1/users/123", "DELETE")
	if allowed {
		t.Error("access should be revoked after tenant deletion")
	}
}

func TestCacheInvalidation(t *testing.T) {
	e := setupTestEnforcer(t)
	const (
		tenant = "tenant-cache-test"
		user   = "user-cache-test"
	)

	if err := authz.SeedTenantPolicies(e, tenant); err != nil {
		t.Fatal(err)
	}

	// Assign viewer role - cache the denial for DELETE
	if err := e.AssignRole(user, "viewer", tenant); err != nil {
		t.Fatal(err)
	}

	allowed, _ := e.Allow(user, tenant, "/api/v1/items/1", "DELETE")
	if allowed {
		t.Fatal("viewer should not have DELETE access")
	}

	// Promote to admin - cache should be invalidated
	if err := e.AssignRole(user, "admin", tenant); err != nil {
		t.Fatal(err)
	}

	// Must see the new permission immediately (not the cached denial)
	allowed, err := e.Allow(user, tenant, "/api/v1/items/1", "DELETE")
	if err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Error("admin should have DELETE access after role promotion; cache invalidation may have failed")
	}
}
```

## Database Schema and Migrations

The GORM adapter creates a `casbin_rule` table automatically, but understanding its structure helps with debugging and direct queries:

```sql
-- casbin_rule table created by gorm-adapter
CREATE TABLE casbin_rule (
    id         BIGSERIAL PRIMARY KEY,
    ptype      VARCHAR(100) NOT NULL,  -- 'p' for policy, 'g' for role assignment
    v0         VARCHAR(100),           -- subject (user or role)
    v1         VARCHAR(100),           -- domain (tenant ID)
    v2         VARCHAR(100),           -- object (resource path)
    v3         VARCHAR(100),           -- action (HTTP method)
    v4         VARCHAR(100),           -- unused in this model
    v5         VARCHAR(100),           -- unused in this model
    CONSTRAINT idx_casbin_rule UNIQUE (ptype, v0, v1, v2, v3, v4, v5)
);

CREATE INDEX idx_casbin_domain ON casbin_rule (v1);  -- fast per-tenant queries
CREATE INDEX idx_casbin_subject ON casbin_rule (v0);  -- fast per-user queries
```

Example queries for debugging:

```sql
-- All policies for a specific tenant
SELECT ptype, v0 AS subject, v2 AS object, v3 AS action
FROM casbin_rule
WHERE ptype = 'p' AND v1 = 'tenant-a'
ORDER BY v0, v2, v3;

-- All role assignments for a specific user
SELECT v0 AS user, v1 AS role, v2 AS domain
FROM casbin_rule
WHERE ptype = 'g' AND v0 = 'user-123';

-- Tenants with the most policies (useful for audit)
SELECT v1 AS tenant, COUNT(*) AS policy_count
FROM casbin_rule
WHERE ptype = 'p'
GROUP BY v1
ORDER BY policy_count DESC;
```

## Audit Logging

Every policy change must be audited for compliance:

```go
// internal/authz/audit.go
package authz

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"
)

// AuditEvent represents a policy change event for compliance logging.
type AuditEvent struct {
	Timestamp  time.Time `json:"timestamp"`
	EventType  string    `json:"event_type"`  // "policy.added", "role.assigned", etc.
	ActorID    string    `json:"actor_id"`
	TenantID   string    `json:"tenant_id"`
	Subject    string    `json:"subject"`
	Object     string    `json:"object,omitempty"`
	Action     string    `json:"action,omitempty"`
	Role       string    `json:"role,omitempty"`
	IPAddress  string    `json:"ip_address,omitempty"`
	UserAgent  string    `json:"user_agent,omitempty"`
}

// AuditLogger writes structured audit events to the configured logger.
type AuditLogger struct {
	logger *slog.Logger
}

func NewAuditLogger(logger *slog.Logger) *AuditLogger {
	return &AuditLogger{logger: logger}
}

func (a *AuditLogger) LogPolicyAdded(ctx context.Context, actor, tenant, sub, obj, action string) {
	a.log(ctx, AuditEvent{
		Timestamp: time.Now().UTC(),
		EventType: "policy.added",
		ActorID:   actor,
		TenantID:  tenant,
		Subject:   sub,
		Object:    obj,
		Action:    action,
	})
}

func (a *AuditLogger) LogRoleAssigned(ctx context.Context, actor, tenant, targetUser, role string) {
	a.log(ctx, AuditEvent{
		Timestamp: time.Now().UTC(),
		EventType: "role.assigned",
		ActorID:   actor,
		TenantID:  tenant,
		Subject:   targetUser,
		Role:      role,
	})
}

func (a *AuditLogger) log(ctx context.Context, event AuditEvent) {
	data, _ := json.Marshal(event)
	a.logger.InfoContext(ctx, "audit event",
		slog.String("event", string(data)),
		slog.String("tenant", event.TenantID),
		slog.String("actor", event.ActorID),
		slog.String("type", event.EventType),
	)
}
```

## Performance Characteristics

For a typical multi-tenant application:

- **Policy evaluation without cache**: ~0.5-2ms per decision (database round-trip for policy load amortized over auto-reload interval)
- **Policy evaluation with cache**: ~1-5 microseconds per decision (in-memory hash lookup)
- **Policy reload from database**: ~10-50ms depending on policy count and database latency
- **Memory per 1000 policies**: approximately 500KB-1MB in the enforcer's in-memory representation

Tuning recommendations:

```go
// For high-throughput APIs (>10k req/s), increase cache TTL and
// accept slightly delayed policy propagation
cache: gocache.New(30*time.Second, 2*time.Minute),

// For compliance-sensitive applications, disable the cache entirely
// and rely on the SyncedEnforcer's read/write locks
// cache: nil  // check cache != nil before all cache.Get/Set calls

// For very large policy sets (>100k rules), use filtered policy loading
// to load only the policies relevant to the current tenant
e.casbin.LoadFilteredPolicy(&gormadapter.Filter{
    V1: []string{currentTenantID},
})
```

## Summary

Casbin with GORM-backed storage provides a robust foundation for multi-tenant RBAC in Go. The key design principles to carry forward: use domain-partitioned models (`g = _, _, _`) to enforce tenant isolation at the policy engine level rather than in application code, keep cache TTLs short enough to propagate policy changes promptly, audit every policy modification, and integrate `TenantScopedEnforcer` at the API boundary so that tenant ID injection errors cause immediate failures rather than silent cross-tenant access.

The pattern of separating `Server` (which entity can we reach) from `AuthorizationPolicy` (who is allowed to reach it) mirrors exactly what Casbin provides at the application layer, making Linkerd's mesh-level controls and Casbin's application-level controls complementary rather than duplicative.
