---
title: "Go HTTP Middleware Chains: Logging, Auth, Rate Limiting, and Tracing"
date: 2029-01-06T00:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Middleware", "Observability", "Security"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to building composable HTTP middleware chains in Go, covering structured logging, JWT authentication, adaptive rate limiting, distributed tracing, and panic recovery for production API services."
more_link: "yes"
url: "/go-http-middleware-chains-logging-auth-rate-limiting/"
---

HTTP middleware chains represent one of the most common architectural patterns in Go web services. A well-designed middleware stack intercepts requests before they reach handlers and responses before they leave, enabling cross-cutting concerns—logging, authentication, rate limiting, tracing—to be implemented once and applied uniformly across all routes.

This guide builds a production-grade middleware chain from first principles, covering the standard `http.Handler` interface, functional middleware composition, and the specific implementations used in enterprise Go APIs.

<!--more-->

## The Middleware Pattern

In Go's `net/http` package, the middleware pattern wraps an `http.Handler` to add behavior:

```go
// Middleware signature: wraps a handler and returns a new handler
type Middleware func(http.Handler) http.Handler

// Chain composes multiple middleware functions into a single handler.
// Middleware is applied in left-to-right order (outermost first).
func Chain(h http.Handler, middlewares ...Middleware) http.Handler {
	for i := len(middlewares) - 1; i >= 0; i-- {
		h = middlewares[i](h)
	}
	return h
}
```

Usage:

```go
mux := http.NewServeMux()
mux.HandleFunc("/api/v1/users", usersHandler)

handler := Chain(
    mux,
    RecoverMiddleware,
    TracingMiddleware,
    LoggingMiddleware,
    AuthMiddleware,
    RateLimitMiddleware,
)

server := &http.Server{Addr: ":8080", Handler: handler}
```

The outermost middleware (first in the list) is the first to receive the request and the last to see the response. This ordering matters: recovery should be outermost to catch panics from all inner middleware, tracing should be established before logging (so trace IDs are available), and authentication should precede business logic.

## Request ID and Context Values

A request ID ties all log lines for a single request together. Use `context.WithValue` to propagate it through the call chain:

```go
package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
)

type contextKey string

const (
	RequestIDKey contextKey = "request_id"
	UserIDKey    contextKey = "user_id"
	TraceIDKey   contextKey = "trace_id"
)

func generateRequestID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// RequestID injects a unique request ID into the request context and response headers.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Honor X-Request-ID from upstream (load balancer, API gateway)
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			requestID = generateRequestID()
		}

		ctx := context.WithValue(r.Context(), RequestIDKey, requestID)
		w.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func GetRequestID(ctx context.Context) string {
	if v := ctx.Value(RequestIDKey); v != nil {
		return v.(string)
	}
	return ""
}
```

## Structured Logging Middleware

```go
package middleware

import (
	"bytes"
	"log/slog"
	"net/http"
	"time"
)

// responseWriter wraps http.ResponseWriter to capture status code and bytes written.
type responseWriter struct {
	http.ResponseWriter
	statusCode   int
	bytesWritten int
	written      bool
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
	return &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
}

func (rw *responseWriter) WriteHeader(code int) {
	if !rw.written {
		rw.statusCode = code
		rw.written = true
		rw.ResponseWriter.WriteHeader(code)
	}
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	rw.written = true
	n, err := rw.ResponseWriter.Write(b)
	rw.bytesWritten += n
	return n, err
}

// Logging creates structured access log entries using log/slog.
func Logging(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rw := newResponseWriter(w)

			next.ServeHTTP(rw, r)

			duration := time.Since(start)
			logger.InfoContext(r.Context(), "http request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.String("query", r.URL.RawQuery),
				slog.Int("status", rw.statusCode),
				slog.Int("bytes_written", rw.bytesWritten),
				slog.Duration("duration", duration),
				slog.String("remote_addr", r.RemoteAddr),
				slog.String("user_agent", r.UserAgent()),
				slog.String("request_id", GetRequestID(r.Context())),
				slog.String("trace_id", GetTraceID(r.Context())),
				slog.String("proto", r.Proto),
				slog.String("host", r.Host),
			)
		})
	}
}
```

## Panic Recovery Middleware

```go
package middleware

import (
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
)

// Recover catches panics from downstream handlers and returns a 500 response
// with the stack trace logged. Without this, a panic kills the goroutine
// serving the request, causing the client to receive a connection reset.
func Recover(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					stack := debug.Stack()
					logger.ErrorContext(r.Context(), "panic recovered",
						slog.String("panic", fmt.Sprintf("%v", rec)),
						slog.String("stack", string(stack)),
						slog.String("request_id", GetRequestID(r.Context())),
						slog.String("method", r.Method),
						slog.String("path", r.URL.Path),
					)

					// Only write 500 if headers have not been sent yet
					// (responseWriter.written check prevents double-write)
					if rw, ok := w.(*responseWriter); ok && !rw.written {
						http.Error(w, "internal server error", http.StatusInternalServerError)
					}
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
```

## JWT Authentication Middleware

```go
package middleware

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims defines the expected JWT payload structure.
type Claims struct {
	UserID    string   `json:"sub"`
	Email     string   `json:"email"`
	Roles     []string `json:"roles"`
	TenantID  string   `json:"tenant_id"`
	jwt.RegisteredClaims
}

// JWTConfig holds JWT validation parameters.
type JWTConfig struct {
	SecretKey   []byte
	Issuer      string
	Audience    string
	// Optional: skip auth for these paths
	SkipPaths   []string
}

// Auth validates JWT Bearer tokens and injects claims into the request context.
func Auth(cfg JWTConfig) Middleware {
	skipPaths := make(map[string]struct{}, len(cfg.SkipPaths))
	for _, p := range cfg.SkipPaths {
		skipPaths[p] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, skip := skipPaths[r.URL.Path]; skip {
				next.ServeHTTP(w, r)
				return
			}

			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, "authorization header required", http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
				http.Error(w, "invalid authorization header format", http.StatusUnauthorized)
				return
			}

			tokenStr := parts[1]
			claims := &Claims{}

			token, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
				if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
					return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
				}
				return cfg.SecretKey, nil
			},
				jwt.WithIssuer(cfg.Issuer),
				jwt.WithAudience(cfg.Audience),
				jwt.WithLeeway(30*time.Second),
				jwt.WithExpirationRequired(),
			)

			if err != nil || !token.Valid {
				http.Error(w, "invalid or expired token", http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), UserIDKey, claims.UserID)
			ctx = context.WithValue(ctx, "claims", claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireRole returns a middleware that checks for a required role in the JWT claims.
func RequireRole(role string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := r.Context().Value("claims").(*Claims)
			if !ok || claims == nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			for _, r := range claims.Roles {
				if r == role {
					next.ServeHTTP(w, r)
					return
				}
			}
			http.Error(w, "forbidden", http.StatusForbidden)
		})
	}
}
```

## Token Bucket Rate Limiting

```go
package middleware

import (
	"net/http"
	"sync"
	"time"
)

// bucket implements the token bucket algorithm for rate limiting.
type bucket struct {
	tokens     float64
	maxTokens  float64
	refillRate float64 // tokens per second
	lastRefill time.Time
	mu         sync.Mutex
}

func newBucket(maxTokens, refillRate float64) *bucket {
	return &bucket{
		tokens:     maxTokens,
		maxTokens:  maxTokens,
		refillRate: refillRate,
		lastRefill: time.Now(),
	}
}

func (b *bucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens += elapsed * b.refillRate
	if b.tokens > b.maxTokens {
		b.tokens = b.maxTokens
	}
	b.lastRefill = now

	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

// RateLimiter stores per-key token buckets.
type RateLimiter struct {
	mu          sync.RWMutex
	buckets     map[string]*bucket
	maxTokens   float64
	refillRate  float64
	cleanupTick time.Duration
}

// NewRateLimiter creates a per-key rate limiter.
// maxTokens: burst capacity (max requests before throttling)
// refillRate: sustained rate in requests/second
func NewRateLimiter(maxTokens, refillRate float64) *RateLimiter {
	rl := &RateLimiter{
		buckets:     make(map[string]*bucket),
		maxTokens:   maxTokens,
		refillRate:  refillRate,
		cleanupTick: 5 * time.Minute,
	}
	go rl.cleanup()
	return rl
}

func (rl *RateLimiter) Allow(key string) bool {
	rl.mu.RLock()
	b, ok := rl.buckets[key]
	rl.mu.RUnlock()

	if !ok {
		rl.mu.Lock()
		b, ok = rl.buckets[key]
		if !ok {
			b = newBucket(rl.maxTokens, rl.refillRate)
			rl.buckets[key] = b
		}
		rl.mu.Unlock()
	}
	return b.allow()
}

func (rl *RateLimiter) cleanup() {
	ticker := time.NewTicker(rl.cleanupTick)
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-10 * time.Minute)
		rl.mu.Lock()
		for key, b := range rl.buckets {
			b.mu.Lock()
			if b.lastRefill.Before(cutoff) {
				delete(rl.buckets, key)
			}
			b.mu.Unlock()
		}
		rl.mu.Unlock()
	}
}

// RateLimit middleware limits requests per IP address (or user ID if authenticated).
func RateLimit(limiter *RateLimiter) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Use user ID if available, fall back to IP
			key := GetRequestID(r.Context())
			if userID, ok := r.Context().Value(UserIDKey).(string); ok && userID != "" {
				key = "user:" + userID
			} else {
				ip := r.Header.Get("X-Forwarded-For")
				if ip == "" {
					ip = r.RemoteAddr
				}
				key = "ip:" + ip
			}

			if !limiter.Allow(key) {
				w.Header().Set("Retry-After", "1")
				http.Error(w, "too many requests", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

## OpenTelemetry Tracing Middleware

```go
package middleware

import (
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
	"go.opentelemetry.io/otel/trace"
)

const tracerName = "api-server"

// Tracing creates spans for each HTTP request, extracting trace context from headers.
func Tracing(serviceName string) Middleware {
	tracer := otel.Tracer(tracerName)
	propagator := otel.GetTextMapPropagator()

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Extract trace context from incoming headers
			ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

			spanName := r.Method + " " + r.URL.Path
			ctx, span := tracer.Start(ctx, spanName,
				trace.WithSpanKind(trace.SpanKindServer),
				trace.WithAttributes(
					semconv.HTTPRequestMethodKey.String(r.Method),
					semconv.URLPath(r.URL.Path),
					semconv.URLQuery(r.URL.RawQuery),
					semconv.NetworkProtocolName(r.Proto),
					semconv.ServerAddress(r.Host),
					semconv.ClientAddress(r.RemoteAddr),
					attribute.String("http.user_agent", r.UserAgent()),
				),
			)
			defer span.End()

			// Inject trace ID into context for logging
			spanCtx := span.SpanContext()
			if spanCtx.HasTraceID() {
				ctx = context.WithValue(ctx, TraceIDKey, spanCtx.TraceID().String())
			}

			rw := newResponseWriter(w)
			next.ServeHTTP(rw, r.WithContext(ctx))

			span.SetAttributes(
				semconv.HTTPResponseStatusCode(rw.statusCode),
				attribute.Int("http.response.bytes", rw.bytesWritten),
			)

			if rw.statusCode >= 500 {
				span.SetStatus(codes.Error, http.StatusText(rw.statusCode))
			} else {
				span.SetStatus(codes.Ok, "")
			}
		})
	}
}

func GetTraceID(ctx context.Context) string {
	if v := ctx.Value(TraceIDKey); v != nil {
		return v.(string)
	}
	return ""
}
```

## CORS Middleware

```go
package middleware

import (
	"net/http"
	"strings"
)

// CORSConfig defines allowed origins, methods, and headers.
type CORSConfig struct {
	AllowedOrigins   []string
	AllowedMethods   []string
	AllowedHeaders   []string
	ExposedHeaders   []string
	AllowCredentials bool
	MaxAge           int
}

// DefaultCORSConfig returns a safe production CORS configuration.
func DefaultCORSConfig() CORSConfig {
	return CORSConfig{
		AllowedOrigins:   []string{"https://app.example.com", "https://admin.example.com"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "X-Request-ID"},
		ExposedHeaders:   []string{"X-Request-ID", "X-RateLimit-Remaining"},
		AllowCredentials: true,
		MaxAge:           600,
	}
}

// CORS handles Cross-Origin Resource Sharing headers.
func CORS(cfg CORSConfig) Middleware {
	allowedOrigins := make(map[string]struct{}, len(cfg.AllowedOrigins))
	for _, o := range cfg.AllowedOrigins {
		allowedOrigins[o] = struct{}{}
	}
	allowedMethods := strings.Join(cfg.AllowedMethods, ", ")
	allowedHeaders := strings.Join(cfg.AllowedHeaders, ", ")
	exposedHeaders := strings.Join(cfg.ExposedHeaders, ", ")

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				if _, allowed := allowedOrigins[origin]; allowed {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
					if cfg.AllowCredentials {
						w.Header().Set("Access-Control-Allow-Credentials", "true")
					}
					if exposedHeaders != "" {
						w.Header().Set("Access-Control-Expose-Headers", exposedHeaders)
					}
				}
			}

			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", allowedMethods)
				w.Header().Set("Access-Control-Allow-Headers", allowedHeaders)
				if cfg.MaxAge > 0 {
					w.Header().Set("Access-Control-Max-Age", fmt.Sprintf("%d", cfg.MaxAge))
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
```

## Security Headers Middleware

```go
package middleware

import "net/http"

// SecurityHeaders adds HTTP security headers to every response.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Prevent MIME type sniffing
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Prevent clickjacking
		w.Header().Set("X-Frame-Options", "DENY")
		// Enable XSS protection (legacy browsers)
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		// Strict Transport Security (HSTS)
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
		// Referrer policy
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		// Permissions policy
		w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		// Content Security Policy
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'")

		next.ServeHTTP(w, r)
	})
}
```

## Composing the Complete Stack

```go
package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/example/api/internal/handler"
	"github.com/example/api/internal/middleware"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	jwtCfg := middleware.JWTConfig{
		SecretKey: []byte(os.Getenv("JWT_SECRET")),
		Issuer:    "api.example.com",
		Audience:  "api-clients",
		SkipPaths: []string{"/healthz", "/readyz", "/metrics", "/api/v1/auth/login"},
	}

	limiter := middleware.NewRateLimiter(
		100,  // burst: 100 requests
		10,   // sustained: 10 req/sec
	)

	corsCfg := middleware.DefaultCORSConfig()

	// Build the route tree
	mux := http.NewServeMux()
	mux.Handle("/api/v1/users", handler.Users(logger))
	mux.Handle("/api/v1/orders", handler.Orders(logger))
	mux.HandleFunc("/api/v1/auth/login", handler.Login(jwtCfg))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Per-route admin middleware
	adminMux := http.NewServeMux()
	adminMux.Handle("/api/v1/admin/", handler.Admin(logger))

	mux.Handle("/api/v1/admin/", middleware.Chain(
		adminMux,
		middleware.RequireRole("admin"),
	))

	// Global middleware stack (applied outermost-first)
	h := middleware.Chain(
		mux,
		middleware.Recover(logger),          // 1. catch panics
		middleware.Tracing("api-server"),     // 2. establish trace
		middleware.RequestID,                 // 3. assign request ID
		middleware.Logging(logger),           // 4. access logging
		middleware.SecurityHeaders,           // 5. security headers
		middleware.CORS(corsCfg),             // 6. CORS
		middleware.Auth(jwtCfg),              // 7. authentication
		middleware.RateLimit(limiter),        // 8. rate limiting
	)

	server := &http.Server{
		Addr:              ":8080",
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	logger.Info("server starting", "addr", ":8080")
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}
}
```

## Testing Middleware

```go
package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRateLimitMiddleware(t *testing.T) {
	limiter := middleware.NewRateLimiter(5, 1)  // burst 5, 1 req/sec
	handler := middleware.RateLimit(limiter)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// First 5 requests should succeed (burst)
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
		req.RemoteAddr = "192.168.1.100:12345"
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Errorf("request %d: expected 200, got %d", i+1, rr.Code)
		}
	}

	// 6th request should be throttled
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.RemoteAddr = "192.168.1.100:12345"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", rr.Code)
	}
}

func TestSecurityHeaders(t *testing.T) {
	handler := middleware.SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	tests := []struct {
		header string
		want   string
	}{
		{"X-Content-Type-Options", "nosniff"},
		{"X-Frame-Options", "DENY"},
		{"Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload"},
	}

	for _, tt := range tests {
		if got := rr.Header().Get(tt.header); got != tt.want {
			t.Errorf("header %s: got %q, want %q", tt.header, got, tt.want)
		}
	}
}
```

## Summary

A well-structured Go middleware chain provides comprehensive request/response processing with minimal coupling between concerns. The key design principles are:

- **Order matters**: Place recovery outermost, authentication before rate limiting, and logging after tracing is established
- **Context propagation**: Use typed context keys to pass request metadata (IDs, claims) safely through the chain
- **Testability**: Each middleware should be independently testable with `httptest.NewRecorder()`
- **Performance**: Avoid allocations in the hot path; pre-compute allowed sets and close over configuration at construction time
- **Observability**: Emit structured log fields and OpenTelemetry spans from every middleware to enable full request lifecycle visibility

This pattern scales from small APIs to large service meshes with hundreds of routes, providing consistent behavior across all endpoints without repetition.
