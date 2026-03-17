---
title: "Go Security Patterns: Building Secure Production Services"
date: 2027-10-20T00:00:00-05:00
draft: false
tags: ["Go", "Security", "Production", "TLS", "Authentication"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Security patterns for production Go services including TLS hardening, JWT validation with JWKS, input validation, SSRF prevention, rate limiting, secrets management with Vault, and gosec integration."
more_link: "yes"
url: "/go-security-patterns-production-guide/"
---

Security in production Go services is not a single feature — it is a collection of decisions made consistently across TLS configuration, input validation, authentication, secret handling, and dependency management. This guide covers each layer with production-ready implementations and explains the reasoning behind each choice.

<!--more-->

# Go Security Patterns: Building Secure Production Services

## Section 1: TLS Configuration Hardening

The default TLS configuration in Go's `net/http` package is permissive. Production services must explicitly restrict supported versions and cipher suites.

### Secure TLS Server Configuration

```go
// tls/config.go
package tlsconfig

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"time"
)

// ServerConfig returns a hardened TLS configuration for HTTPS servers.
// It enforces TLS 1.2 minimum, drops weak cipher suites, and enables
// HTTP Strict Transport Security headers.
func ServerConfig(certFile, keyFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load cert: %w", err)
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
		// TLS 1.3 cipher suites are fixed and cannot be configured;
		// these suites apply to TLS 1.2 only.
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		},
		PreferServerCipherSuites: true,
		CurvePreferences: []tls.CurveID{
			tls.X25519,
			tls.CurveP256,
		},
		// Session resumption with forward-secrecy-preserving tickets.
		SessionTicketsDisabled: false,
	}, nil
}

// SecureServer wraps an http.Server with production TLS settings.
func SecureServer(addr, certFile, keyFile string, handler http.Handler) (*http.Server, error) {
	tlsCfg, err := ServerConfig(certFile, keyFile)
	if err != nil {
		return nil, err
	}

	return &http.Server{
		Addr:      addr,
		Handler:   addSecurityHeaders(handler),
		TLSConfig: tlsCfg,
		// Timeouts prevent Slowloris and slow-read attacks.
		ReadTimeout:       5 * time.Second,
		ReadHeaderTimeout: 2 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}, nil
}

// addSecurityHeaders injects standard security headers on every response.
func addSecurityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; object-src 'none'")
		h.ServeHTTP(w, r)
	})
}
```

### Secure TLS Client Configuration

```go
// tls/client.go
package tlsconfig

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
	"time"
)

// ClientConfig returns a hardened TLS config for outbound HTTP clients.
func ClientConfig(caCertFile string) (*tls.Config, error) {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}

	if caCertFile != "" {
		pem, err := os.ReadFile(caCertFile)
		if err != nil {
			return nil, fmt.Errorf("read CA cert: %w", err)
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("parse CA cert from %s", caCertFile)
		}
	}

	return &tls.Config{
		RootCAs:    pool,
		MinVersion: tls.VersionTLS12,
		// Do NOT set InsecureSkipVerify: true in any production code path.
	}, nil
}

// SecureHTTPClient returns an http.Client safe for external service calls.
func SecureHTTPClient(caCertFile string) (*http.Client, error) {
	tlsCfg, err := ClientConfig(caCertFile)
	if err != nil {
		return nil, err
	}

	transport := &http.Transport{
		TLSClientConfig:     tlsCfg,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		DisableKeepAlives:   false,
	}

	return &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}, nil
}
```

---

## Section 2: JWT Validation with JWKS

Validating JWTs against a JWKS endpoint (used by Auth0, Cognito, Keycloak, and Kubernetes service accounts) requires fetching the public key, verifying the signature, and checking standard claims.

### JWKS Client with Key Caching

```go
// auth/jwks.go
package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"
)

// JWKSClient fetches and caches JWKS public keys.
type JWKSClient struct {
	url        string
	httpClient *http.Client
	mu         sync.RWMutex
	keys       map[string]*rsa.PublicKey
	lastFetch  time.Time
	ttl        time.Duration
}

func NewJWKSClient(url string, httpClient *http.Client, ttl time.Duration) *JWKSClient {
	return &JWKSClient{
		url:        url,
		httpClient: httpClient,
		keys:       make(map[string]*rsa.PublicKey),
		ttl:        ttl,
	}
}

type jwksResponse struct {
	Keys []jwk `json:"keys"`
}

type jwk struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// GetKey returns the RSA public key for the given key ID.
func (c *JWKSClient) GetKey(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	c.mu.RLock()
	key, ok := c.keys[kid]
	stale := time.Since(c.lastFetch) > c.ttl
	c.mu.RUnlock()

	if ok && !stale {
		return key, nil
	}

	if err := c.refresh(ctx); err != nil {
		// On refresh failure, serve stale keys if available.
		if ok {
			return key, nil
		}
		return nil, fmt.Errorf("refresh jwks: %w", err)
	}

	c.mu.RLock()
	key, ok = c.keys[kid]
	c.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("key ID %q not found in JWKS", kid)
	}
	return key, nil
}

func (c *JWKSClient) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("JWKS endpoint returned %d", resp.StatusCode)
	}

	var jwksResp jwksResponse
	if err := json.NewDecoder(resp.Body).Decode(&jwksResp); err != nil {
		return fmt.Errorf("decode JWKS: %w", err)
	}

	newKeys := make(map[string]*rsa.PublicKey, len(jwksResp.Keys))
	for _, k := range jwksResp.Keys {
		if k.Kty != "RSA" || k.Use != "sig" {
			continue
		}
		pubKey, err := rsaPublicKeyFromJWK(k)
		if err != nil {
			return fmt.Errorf("parse key %s: %w", k.Kid, err)
		}
		newKeys[k.Kid] = pubKey
	}

	c.mu.Lock()
	c.keys = newKeys
	c.lastFetch = time.Now()
	c.mu.Unlock()

	return nil
}

func rsaPublicKeyFromJWK(k jwk) (*rsa.PublicKey, error) {
	nb, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, fmt.Errorf("decode N: %w", err)
	}
	eb, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, fmt.Errorf("decode E: %w", err)
	}

	n := new(big.Int).SetBytes(nb)
	e := new(big.Int).SetBytes(eb)

	return &rsa.PublicKey{
		N: n,
		E: int(e.Int64()),
	}, nil
}
```

### JWT Validation Middleware

```go
// auth/middleware.go
package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims extends the standard JWT claims with application-specific fields.
type Claims struct {
	jwt.RegisteredClaims
	Email  string   `json:"email"`
	Roles  []string `json:"roles"`
	OrgID  string   `json:"org_id"`
}

type contextKey int

const claimsKey contextKey = iota

// ValidateJWT returns a middleware that validates Bearer tokens.
func ValidateJWT(jwks *JWKSClient, audience, issuer string) func(http.Handler) http.Handler {
	parser := jwt.NewParser(
		jwt.WithAudience(audience),
		jwt.WithIssuer(issuer),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(30*time.Second),
	)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, err := extractBearerToken(r)
			if err != nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			parsed, err := parser.ParseWithClaims(token, &Claims{},
				func(t *jwt.Token) (interface{}, error) {
					if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
						return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
					}
					kid, ok := t.Header["kid"].(string)
					if !ok {
						return nil, fmt.Errorf("missing kid header")
					}
					return jwks.GetKey(r.Context(), kid)
				},
			)
			if err != nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			claims, ok := parsed.Claims.(*Claims)
			if !ok || !parsed.Valid {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func extractBearerToken(r *http.Request) (string, error) {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return "", fmt.Errorf("missing Authorization header")
	}
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", fmt.Errorf("invalid Authorization header format")
	}
	return parts[1], nil
}

// ClaimsFromContext retrieves validated claims from the request context.
func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*Claims)
	return c, ok
}
```

---

## Section 3: Input Validation with go-playground/validator

Validate every request body before processing it:

```go
// validation/validator.go
package validation

import (
	"fmt"
	"net/http"
	"reflect"
	"strings"

	"github.com/go-playground/validator/v10"
)

var validate = validator.New(validator.WithRequiredStructFields())

func init() {
	// Use JSON tag names in validation error messages.
	validate.RegisterTagNameFunc(func(fld reflect.StructField) string {
		name := strings.SplitN(fld.Tag.Get("json"), ",", 2)[0]
		if name == "-" {
			return ""
		}
		return name
	})

	// Custom validator: email domain allowlist.
	validate.RegisterValidation("corporate_email", func(fl validator.FieldLevel) bool {
		email := fl.Field().String()
		return strings.HasSuffix(email, "@example.com") ||
			strings.HasSuffix(email, "@example.org")
	})
}

// ValidationError represents a field-level validation failure.
type ValidationError struct {
	Field   string `json:"field"`
	Tag     string `json:"tag"`
	Message string `json:"message"`
}

// Validate validates a struct and returns structured errors.
func Validate(v interface{}) []ValidationError {
	if err := validate.Struct(v); err != nil {
		var errs []ValidationError
		for _, e := range err.(validator.ValidationErrors) {
			errs = append(errs, ValidationError{
				Field:   e.Field(),
				Tag:     e.Tag(),
				Message: humanize(e),
			})
		}
		return errs
	}
	return nil
}

func humanize(e validator.FieldError) string {
	switch e.Tag() {
	case "required":
		return fmt.Sprintf("%s is required", e.Field())
	case "email":
		return fmt.Sprintf("%s must be a valid email address", e.Field())
	case "min":
		return fmt.Sprintf("%s must be at least %s characters", e.Field(), e.Param())
	case "max":
		return fmt.Sprintf("%s must be at most %s characters", e.Field(), e.Param())
	case "oneof":
		return fmt.Sprintf("%s must be one of: %s", e.Field(), e.Param())
	default:
		return fmt.Sprintf("%s failed validation rule '%s'", e.Field(), e.Tag())
	}
}

// Request types with validation tags.
type CreateUserRequest struct {
	Email string `json:"email" validate:"required,email,max=254"`
	Name  string `json:"name"  validate:"required,min=2,max=100"`
	Role  string `json:"role"  validate:"required,oneof=member admin viewer"`
}

type UpdateUserRequest struct {
	Name string `json:"name" validate:"omitempty,min=2,max=100"`
	Role string `json:"role" validate:"omitempty,oneof=member admin viewer"`
}
```

### Handler with Validation

```go
// handler/user.go
package handler

import (
	"encoding/json"
	"net/http"

	"myapp/validation"
)

func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
	var req validation.CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	if errs := validation.Validate(req); errs != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"errors": errs,
		})
		return
	}

	// req is now safe to use.
	user, err := h.svc.CreateUser(r.Context(), req.Email, req.Name, req.Role)
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(user)
}
```

---

## Section 4: SQL Injection Prevention

With sqlc or parameterized queries, SQL injection is structurally impossible because user input never becomes part of the query string:

```go
// SAFE: parameterized query — the database driver handles escaping.
rows, err := pool.Query(ctx,
	"SELECT id, email FROM users WHERE email = $1 AND role = $2",
	emailInput, roleInput,
)

// UNSAFE: string interpolation — never do this.
// query := "SELECT id, email FROM users WHERE email = '" + emailInput + "'"
// rows, err := pool.Query(ctx, query)

// SAFE with sqlc: the generated code uses placeholders automatically.
user, err := queries.GetUserByEmail(ctx, emailInput)
```

When dynamic query construction is unavoidable (e.g., building ORDER BY clauses), use an allowlist:

```go
// store/safe_order.go
package store

import "fmt"

var allowedSortColumns = map[string]string{
	"created_at": "created_at",
	"name":       "name",
	"email":      "email",
}

var allowedSortDirections = map[string]string{
	"asc":  "ASC",
	"desc": "DESC",
}

// SafeOrderClause returns a validated ORDER BY clause.
func SafeOrderClause(column, direction string) (string, error) {
	col, ok := allowedSortColumns[column]
	if !ok {
		return "", fmt.Errorf("invalid sort column: %q", column)
	}
	dir, ok := allowedSortDirections[direction]
	if !ok {
		return "", fmt.Errorf("invalid sort direction: %q", direction)
	}
	return fmt.Sprintf("%s %s", col, dir), nil
}
```

---

## Section 5: SSRF Prevention

Server-Side Request Forgery (SSRF) occurs when an attacker controls a URL that the server fetches. Block private IP ranges and metadata endpoints:

```go
// security/ssrf.go
package security

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
)

// privateRanges contains all RFC-1918 and link-local ranges.
var privateRanges []*net.IPNet

func init() {
	for _, cidr := range []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"127.0.0.0/8",
		"::1/128",
		"fc00::/7",
		"169.254.0.0/16", // link-local, AWS metadata
		"[::ffff:169.254.0.0]/112", // IPv4-mapped
		"100.64.0.0/10", // Carrier-grade NAT
	} {
		_, network, _ := net.ParseCIDR(cidr)
		privateRanges = append(privateRanges, network)
	}
}

// isPrivateIP returns true if the IP is in a private/reserved range.
func isPrivateIP(ip net.IP) bool {
	for _, r := range privateRanges {
		if r.Contains(ip) {
			return true
		}
	}
	return false
}

// SSRFSafeDialer returns an http.Transport that refuses connections
// to private IP addresses and the cloud metadata endpoint.
func SSRFSafeDialer() *http.Transport {
	dialer := &net.Dialer{}
	return &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, fmt.Errorf("parse addr: %w", err)
			}

			ips, err := net.DefaultResolver.LookupHost(ctx, host)
			if err != nil {
				return nil, fmt.Errorf("resolve %s: %w", host, err)
			}

			for _, ipStr := range ips {
				ip := net.ParseIP(ipStr)
				if isPrivateIP(ip) {
					return nil, fmt.Errorf("SSRF: request to private address %s rejected", ipStr)
				}
			}

			return dialer.DialContext(ctx, network, addr)
		},
	}
}

// ValidateWebhookURL checks that a user-supplied URL is safe to call.
func ValidateWebhookURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	if u.Scheme != "https" {
		return fmt.Errorf("webhook URL must use HTTPS, got %q", u.Scheme)
	}

	host := u.Hostname()
	ips, err := net.LookupHost(host)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", host, err)
	}

	for _, ipStr := range ips {
		ip := net.ParseIP(ipStr)
		if isPrivateIP(ip) {
			return fmt.Errorf("webhook URL resolves to private address %s", ipStr)
		}
	}

	return nil
}
```

---

## Section 6: Rate Limiting with Token Bucket

```go
// ratelimit/limiter.go
package ratelimit

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// TokenBucket implements a per-key token bucket rate limiter.
type TokenBucket struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	rate     float64 // tokens per second
	capacity float64 // maximum tokens
	cleanup  time.Duration
}

type bucket struct {
	tokens     float64
	lastRefill time.Time
	lastAccess time.Time
}

func NewTokenBucket(requestsPerSecond, burst float64, cleanupInterval time.Duration) *TokenBucket {
	tb := &TokenBucket{
		buckets:  make(map[string]*bucket),
		rate:     requestsPerSecond,
		capacity: burst,
		cleanup:  cleanupInterval,
	}
	go tb.cleanupLoop()
	return tb
}

// Allow returns true if the key has available tokens.
func (tb *TokenBucket) Allow(key string) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	b, ok := tb.buckets[key]
	if !ok {
		tb.buckets[key] = &bucket{
			tokens:     tb.capacity - 1,
			lastRefill: time.Now(),
			lastAccess: time.Now(),
		}
		return true
	}

	now := time.Now()
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens = min(tb.capacity, b.tokens+elapsed*tb.rate)
	b.lastRefill = now
	b.lastAccess = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func (tb *TokenBucket) cleanupLoop() {
	ticker := time.NewTicker(tb.cleanup)
	defer ticker.Stop()
	for range ticker.C {
		tb.mu.Lock()
		cutoff := time.Now().Add(-tb.cleanup)
		for key, b := range tb.buckets {
			if b.lastAccess.Before(cutoff) {
				delete(tb.buckets, key)
			}
		}
		tb.mu.Unlock()
	}
}

// RateLimitMiddleware limits requests by IP address.
func RateLimitMiddleware(rps, burst float64) func(http.Handler) http.Handler {
	limiter := NewTokenBucket(rps, burst, 10*time.Minute)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := realIP(r)
			if !limiter.Allow(ip) {
				w.Header().Set("Retry-After", "1")
				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func realIP(r *http.Request) string {
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		// Take only the first IP — others may be spoofed.
		return strings.SplitN(ip, ",", 2)[0]
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}
```

---

## Section 7: Secrets Management with Vault SDK

Never read secrets from environment variables as plain strings in long-running services. Use dynamic secrets with automatic renewal:

```go
// secrets/vault.go
package secrets

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	vault "github.com/hashicorp/vault/api"
	auth "github.com/hashicorp/vault/api/auth/kubernetes"
)

// VaultClient wraps the Vault SDK with secret caching and renewal.
type VaultClient struct {
	client *vault.Client
	token  string
}

// NewVaultClient creates an authenticated Vault client using
// Kubernetes service account token injection (Vault agent or direct auth).
func NewVaultClient(vaultAddr, roleID string) (*VaultClient, error) {
	cfg := vault.DefaultConfig()
	cfg.Address = vaultAddr

	client, err := vault.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("vault client: %w", err)
	}

	// Authenticate using Kubernetes service account.
	k8sAuth, err := auth.NewKubernetesAuth(roleID)
	if err != nil {
		return nil, fmt.Errorf("k8s auth: %w", err)
	}

	authInfo, err := client.Auth().Login(context.Background(), k8sAuth)
	if err != nil {
		return nil, fmt.Errorf("vault login: %w", err)
	}

	vc := &VaultClient{client: client}

	// Start background token renewal.
	go vc.renewToken(authInfo)

	return vc, nil
}

func (vc *VaultClient) renewToken(secret *vault.Secret) {
	renewer, err := vc.client.NewLifetimeWatcher(&vault.LifetimeWatcherInput{
		Secret: secret,
	})
	if err != nil {
		slog.Error("create token renewer", "err", err)
		return
	}
	go renewer.Start()
	defer renewer.Stop()

	for {
		select {
		case err := <-renewer.DoneCh():
			if err != nil {
				slog.Error("token renewal failed", "err", err)
			}
			return
		case renewal := <-renewer.RenewCh():
			slog.Info("vault token renewed",
				"ttl", renewal.Secret.Auth.LeaseDuration,
			)
		}
	}
}

// GetSecret retrieves a KV secret from the given path.
func (vc *VaultClient) GetSecret(ctx context.Context, path string) (map[string]interface{}, error) {
	secret, err := vc.client.KVv2("secret").Get(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("get secret %s: %w", path, err)
	}
	if secret == nil || secret.Data == nil {
		return nil, fmt.Errorf("secret %s not found or empty", path)
	}
	return secret.Data, nil
}

// GetDatabaseCredentials returns dynamic PostgreSQL credentials.
func (vc *VaultClient) GetDatabaseCredentials(ctx context.Context, role string) (username, password string, err error) {
	secret, err := vc.client.Logical().ReadWithContext(ctx,
		fmt.Sprintf("database/creds/%s", role),
	)
	if err != nil {
		return "", "", fmt.Errorf("read db creds for %s: %w", role, err)
	}
	if secret == nil {
		return "", "", fmt.Errorf("no credentials for role %s", role)
	}

	username, _ = secret.Data["username"].(string)
	password, _ = secret.Data["password"].(string)

	if username == "" || password == "" {
		return "", "", fmt.Errorf("incomplete credentials for role %s", role)
	}
	return username, password, nil
}
```

---

## Section 8: gosec Static Analysis Integration

`gosec` catches common Go security issues at CI time:

```yaml
# .github/workflows/security.yaml
name: Security Scan

on:
  push:
    branches: [main, release/*]
  pull_request:

jobs:
  gosec:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - name: Install gosec
        run: go install github.com/securego/gosec/v2/cmd/gosec@latest
      - name: Run gosec
        run: |
          gosec \
            -severity medium \
            -confidence high \
            -exclude-generated \
            -fmt sarif \
            -out gosec-results.sarif \
            ./...
      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: gosec-results.sarif
```

Common gosec findings and remediations:

| Rule | Finding | Fix |
|---|---|---|
| G101 | Hardcoded credentials | Use environment variables or Vault |
| G201 | SQL string formatting | Use parameterized queries |
| G304 | File path traversal | Validate and sanitize paths |
| G401 | Weak crypto (MD5/SHA1) | Use SHA-256 or SHA-512 |
| G501 | Weak crypto import | Replace with `crypto/sha256` |
| G601 | Implicit memory aliasing | Use explicit address capture |

---

## Section 9: Security Code Review Checklist

Before merging any Go service change, verify:

```
Authentication and Authorization
  [ ] All non-public endpoints require valid JWT
  [ ] Role checks use server-side claims (not client-supplied roles)
  [ ] Sensitive operations log the actor (user ID, IP) for audit

Input Handling
  [ ] All request bodies decoded and validated before use
  [ ] File paths sanitized (filepath.Clean + chroot check)
  [ ] URL parameters validated to allowlist where applicable
  [ ] Content-Type verified before processing

Cryptography
  [ ] No MD5 or SHA1 for security purposes
  [ ] TLS min version is 1.2
  [ ] No InsecureSkipVerify in any code path
  [ ] Secrets never logged or returned in API responses

Error Handling
  [ ] Internal errors do not leak stack traces or SQL to clients
  [ ] Generic error messages for unauthenticated endpoints
  [ ] Database errors wrapped with context but internal details hidden

Dependencies
  [ ] go mod tidy run and go.sum committed
  [ ] govulncheck run: go install golang.org/x/vuln/cmd/govulncheck@latest
  [ ] No direct dependencies with known CVEs
```

```bash
# Run all security tools locally before pushing:
gosec ./...
govulncheck ./...
go vet ./...
staticcheck ./...
```
