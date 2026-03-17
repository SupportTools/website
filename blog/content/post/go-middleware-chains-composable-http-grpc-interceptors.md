---
title: "Go Middleware Chains: Building Composable HTTP and gRPC Interceptors"
date: 2031-01-01T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Middleware", "gRPC", "HTTP", "Interceptors", "Context Propagation"]
categories:
- Go
- Backend Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to building composable middleware chains for Go HTTP servers and gRPC interceptors, covering context propagation, panic recovery, request ID injection, and reusable library design."
more_link: "yes"
url: "/go-middleware-chains-composable-http-grpc-interceptors/"
---

Middleware is the connective tissue of Go services. Authentication, logging, tracing, rate limiting, panic recovery — all of these are best implemented as composable middleware that wraps handler logic without coupling to it. This guide builds a complete, production-grade middleware library from first principles, covering `net/http` middleware patterns, gRPC unary and stream interceptors, context propagation, and the architectural choices that distinguish a clean middleware chain from a maintenance burden.

<!--more-->

# Go Middleware Chains: Building Composable HTTP and gRPC Interceptors

## Section 1: The Middleware Contract

In Go's `net/http` package, a handler is anything that implements:

```go
type Handler interface {
    ServeHTTP(ResponseWriter, *Request)
}
```

A middleware is a function that takes a `Handler` and returns a `Handler`, inserting behavior before and/or after the inner handler:

```go
type Middleware func(http.Handler) http.Handler
```

This is the core contract. Everything else — panic recovery, request IDs, auth tokens — is just an implementation detail within this shape.

```go
// middleware/middleware.go
package middleware

import "net/http"

// Middleware wraps an http.Handler with additional behavior.
type Middleware func(http.Handler) http.Handler

// Chain applies multiple middlewares to a handler in left-to-right order.
// The first middleware is the outermost wrapper (executes first).
func Chain(h http.Handler, middlewares ...Middleware) http.Handler {
	// Apply in reverse so the first middleware in the list is outermost
	for i := len(middlewares) - 1; i >= 0; i-- {
		h = middlewares[i](h)
	}
	return h
}
```

The ordering matters: `Chain(handler, Logger, Auth, RateLimit)` means Logger wraps Auth which wraps RateLimit which wraps the handler. Logger sees every request and response, Auth sees only requests that pass logging, and so on.

## Section 2: Request ID Injection

Every distributed system needs correlation IDs. The request ID middleware generates one per request, propagates it through context, and adds it to response headers.

```go
// middleware/requestid.go
package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
)

// requestIDKey is an unexported context key to avoid collisions.
type requestIDKey struct{}

const requestIDHeader = "X-Request-ID"

// RequestID injects a unique request ID into the context and response headers.
// If the incoming request already carries X-Request-ID, it is propagated as-is.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(requestIDHeader)
		if id == "" {
			id = generateRequestID()
		}

		// Store in context for downstream use
		ctx := context.WithValue(r.Context(), requestIDKey{}, id)

		// Echo back in response headers for client correlation
		w.Header().Set(requestIDHeader, id)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GetRequestID retrieves the request ID from the context.
// Returns an empty string if no ID is present.
func GetRequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

func generateRequestID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Fallback: use a timestamp-based approach if entropy is exhausted
		return "fallback-" + hex.EncodeToString(b[:8])
	}
	return hex.EncodeToString(b)
}
```

## Section 3: Structured Logging Middleware

```go
// middleware/logger.go
package middleware

import (
	"net/http"
	"time"

	"go.uber.org/zap"
)

// responseWriter wraps http.ResponseWriter to capture the status code.
type responseWriter struct {
	http.ResponseWriter
	statusCode    int
	bytesWritten  int64
	headerWritten bool
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
	return &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
}

func (rw *responseWriter) WriteHeader(code int) {
	if !rw.headerWritten {
		rw.statusCode = code
		rw.headerWritten = true
		rw.ResponseWriter.WriteHeader(code)
	}
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	rw.headerWritten = true
	n, err := rw.ResponseWriter.Write(b)
	rw.bytesWritten += int64(n)
	return n, err
}

// Logger returns a middleware that logs structured request/response data.
func Logger(log *zap.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rw := newResponseWriter(w)

			// Log when the request comes in (good for debugging slow requests)
			log.Debug("request started",
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
				zap.String("request_id", GetRequestID(r.Context())),
				zap.String("remote_addr", r.RemoteAddr),
			)

			next.ServeHTTP(rw, r)

			duration := time.Since(start)

			fields := []zap.Field{
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
				zap.String("query", r.URL.RawQuery),
				zap.Int("status", rw.statusCode),
				zap.Int64("bytes", rw.bytesWritten),
				zap.Duration("duration", duration),
				zap.String("request_id", GetRequestID(r.Context())),
				zap.String("user_agent", r.UserAgent()),
				zap.String("remote_addr", r.RemoteAddr),
			}

			// Log at appropriate level based on status code
			switch {
			case rw.statusCode >= 500:
				log.Error("request completed", fields...)
			case rw.statusCode >= 400:
				log.Warn("request completed", fields...)
			default:
				log.Info("request completed", fields...)
			}
		})
	}
}
```

## Section 4: Panic Recovery Middleware

A single goroutine panic can take down the entire process. Recovery middleware catches panics, logs the stack trace, and returns a 500 response instead.

```go
// middleware/recovery.go
package middleware

import (
	"fmt"
	"net/http"
	"runtime/debug"

	"go.uber.org/zap"
)

// Recovery catches panics in downstream handlers, logs the stack trace,
// and writes a 500 Internal Server Error response.
func Recovery(log *zap.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if err := recover(); err != nil {
					// Capture the full stack trace
					stack := debug.Stack()

					log.Error("panic recovered",
						zap.String("request_id", GetRequestID(r.Context())),
						zap.String("method", r.Method),
						zap.String("path", r.URL.Path),
						zap.Any("panic", err),
						zap.String("stack", string(stack)),
					)

					// Check if headers have already been sent
					// If so, we can't write a new status code
					if rw, ok := w.(*responseWriter); ok && rw.headerWritten {
						return
					}

					http.Error(w,
						fmt.Sprintf("Internal Server Error\nRequest-ID: %s", GetRequestID(r.Context())),
						http.StatusInternalServerError,
					)
				}
			}()

			next.ServeHTTP(w, r)
		})
	}
}
```

## Section 5: Authentication and Authorization Middleware

```go
// middleware/auth.go
package middleware

import (
	"context"
	"net/http"
	"strings"

	"go.uber.org/zap"
)

// Principal holds authenticated identity information.
type Principal struct {
	UserID   string
	Email    string
	Roles    []string
	TenantID string
}

type principalKey struct{}

// Authenticator validates tokens and returns a Principal.
type Authenticator interface {
	Authenticate(ctx context.Context, token string) (*Principal, error)
}

// Auth validates Bearer tokens and injects the Principal into context.
// Requests without a valid token receive 401.
func Auth(authenticator Authenticator, log *zap.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, "Authorization header required", http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
				http.Error(w, "Invalid Authorization header format", http.StatusUnauthorized)
				return
			}

			principal, err := authenticator.Authenticate(r.Context(), parts[1])
			if err != nil {
				log.Warn("authentication failed",
					zap.String("request_id", GetRequestID(r.Context())),
					zap.Error(err),
				)
				http.Error(w, "Invalid or expired token", http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), principalKey{}, principal)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireRole returns a middleware that checks the principal has one of the
// specified roles. Auth middleware must precede this in the chain.
func RequireRole(roles ...string) Middleware {
	roleSet := make(map[string]struct{}, len(roles))
	for _, r := range roles {
		roleSet[r] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			principal := GetPrincipal(r.Context())
			if principal == nil {
				http.Error(w, "Authentication required", http.StatusUnauthorized)
				return
			}

			for _, role := range principal.Roles {
				if _, ok := roleSet[role]; ok {
					next.ServeHTTP(w, r)
					return
				}
			}

			http.Error(w, "Insufficient permissions", http.StatusForbidden)
		})
	}
}

// GetPrincipal retrieves the authenticated principal from context.
func GetPrincipal(ctx context.Context) *Principal {
	p, _ := ctx.Value(principalKey{}).(*Principal)
	return p
}

// OptionalAuth validates a token if present but does not require it.
// Unauthenticated requests are passed through with a nil principal.
func OptionalAuth(authenticator Authenticator, log *zap.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				next.ServeHTTP(w, r)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
				if principal, err := authenticator.Authenticate(r.Context(), parts[1]); err == nil {
					ctx := context.WithValue(r.Context(), principalKey{}, principal)
					r = r.WithContext(ctx)
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}
```

## Section 6: Rate Limiting Middleware

```go
// middleware/ratelimit.go
package middleware

import (
	"context"
	"net/http"
	"sync"
	"time"

	"go.uber.org/zap"
	"golang.org/x/time/rate"
)

// RateLimiter defines the interface for rate limit implementations.
type RateLimiter interface {
	Allow(ctx context.Context, key string) (bool, time.Duration)
}

// TokenBucketLimiter implements per-key token bucket rate limiting.
type TokenBucketLimiter struct {
	mu       sync.Mutex
	limiters map[string]*rateLimiterEntry
	rate     rate.Limit
	burst    int
	cleanup  time.Duration
}

type rateLimiterEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// NewTokenBucketLimiter creates a new per-key token bucket limiter.
// r is requests per second, burst is the maximum burst size.
func NewTokenBucketLimiter(r rate.Limit, burst int) *TokenBucketLimiter {
	tbl := &TokenBucketLimiter{
		limiters: make(map[string]*rateLimiterEntry),
		rate:     r,
		burst:    burst,
		cleanup:  5 * time.Minute,
	}
	go tbl.cleanupLoop()
	return tbl
}

func (tbl *TokenBucketLimiter) getLimiter(key string) *rate.Limiter {
	tbl.mu.Lock()
	defer tbl.mu.Unlock()

	entry, exists := tbl.limiters[key]
	if !exists {
		entry = &rateLimiterEntry{
			limiter: rate.NewLimiter(tbl.rate, tbl.burst),
		}
		tbl.limiters[key] = entry
	}
	entry.lastSeen = time.Now()
	return entry.limiter
}

func (tbl *TokenBucketLimiter) Allow(ctx context.Context, key string) (bool, time.Duration) {
	limiter := tbl.getLimiter(key)
	reservation := limiter.Reserve()
	if reservation.OK() && reservation.Delay() == 0 {
		return true, 0
	}
	delay := reservation.Delay()
	reservation.Cancel()
	return false, delay
}

func (tbl *TokenBucketLimiter) cleanupLoop() {
	ticker := time.NewTicker(tbl.cleanup)
	defer ticker.Stop()
	for range ticker.C {
		tbl.mu.Lock()
		cutoff := time.Now().Add(-tbl.cleanup)
		for key, entry := range tbl.limiters {
			if entry.lastSeen.Before(cutoff) {
				delete(tbl.limiters, key)
			}
		}
		tbl.mu.Unlock()
	}
}

// KeyExtractor determines the rate limit key from a request.
type KeyExtractor func(r *http.Request) string

// IPKeyExtractor uses the remote IP address as the rate limit key.
func IPKeyExtractor(r *http.Request) string {
	ip := r.RemoteAddr
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ip = xff
	}
	return "ip:" + ip
}

// UserKeyExtractor uses the authenticated user ID as the rate limit key.
func UserKeyExtractor(r *http.Request) string {
	if p := GetPrincipal(r.Context()); p != nil {
		return "user:" + p.UserID
	}
	return "anon:" + r.RemoteAddr
}

// RateLimit enforces request rate limits per extracted key.
func RateLimit(limiter RateLimiter, extractor KeyExtractor, log *zap.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := extractor(r)
			allowed, retryAfter := limiter.Allow(r.Context(), key)

			if !allowed {
				log.Warn("rate limit exceeded",
					zap.String("request_id", GetRequestID(r.Context())),
					zap.String("key", key),
					zap.Duration("retry_after", retryAfter),
				)
				w.Header().Set("Retry-After", retryAfter.String())
				http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
```

## Section 7: Timeout and Deadline Middleware

```go
// middleware/timeout.go
package middleware

import (
	"context"
	"net/http"
	"time"

	"go.uber.org/zap"
)

// Timeout wraps requests with a context deadline.
// If the handler does not complete within d, the request is cancelled.
// NOTE: This does not stop the handler goroutine — the handler must check
// ctx.Done() or use context-aware operations to respect the cancellation.
func Timeout(d time.Duration, log *zap.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()

			// Channel to detect if handler completes before timeout
			done := make(chan struct{})

			// Wrap response writer to detect if headers have been sent
			rw := newResponseWriter(w)

			go func() {
				next.ServeHTTP(rw, r.WithContext(ctx))
				close(done)
			}()

			select {
			case <-done:
				// Handler completed normally
			case <-ctx.Done():
				if !rw.headerWritten {
					log.Warn("request timed out",
						zap.String("request_id", GetRequestID(r.Context())),
						zap.String("path", r.URL.Path),
						zap.Duration("timeout", d),
					)
					http.Error(w, "Request Timeout", http.StatusGatewayTimeout)
				}
			}
		})
	}
}
```

## Section 8: gRPC Unary Interceptors

gRPC interceptors are the equivalent of HTTP middleware. Unary interceptors wrap individual RPC calls.

```go
// grpcmiddleware/interceptors.go
package grpcmiddleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"runtime/debug"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const grpcRequestIDKey = "x-request-id"

// requestIDFromContext extracts or generates a request ID for gRPC calls.
func requestIDFromIncoming(ctx context.Context) (context.Context, string) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		md = metadata.New(nil)
	}

	ids := md.Get(grpcRequestIDKey)
	var id string
	if len(ids) > 0 && ids[0] != "" {
		id = ids[0]
	} else {
		b := make([]byte, 16)
		rand.Read(b)
		id = hex.EncodeToString(b)
	}

	// Inject into outgoing metadata for downstream propagation
	ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs(grpcRequestIDKey, id))
	// Store in context value for handler access
	ctx = context.WithValue(ctx, requestIDCtxKey{}, id)
	return ctx, id
}

type requestIDCtxKey struct{}

// GetGRPCRequestID retrieves the request ID from a gRPC handler's context.
func GetGRPCRequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDCtxKey{}).(string)
	return id
}

// UnaryRequestID is a unary server interceptor that injects request IDs.
func UnaryRequestID() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		ctx, _ = requestIDFromIncoming(ctx)
		return handler(ctx, req)
	}
}

// UnaryLogger is a unary server interceptor that logs each RPC call.
func UnaryLogger(log *zap.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		start := time.Now()
		requestID := GetGRPCRequestID(ctx)

		log.Debug("grpc call started",
			zap.String("method", info.FullMethod),
			zap.String("request_id", requestID),
		)

		resp, err := handler(ctx, req)

		code := codes.OK
		if err != nil {
			code = status.Code(err)
		}

		fields := []zap.Field{
			zap.String("method", info.FullMethod),
			zap.String("request_id", requestID),
			zap.String("code", code.String()),
			zap.Duration("duration", time.Since(start)),
		}

		if err != nil {
			if code == codes.Internal || code == codes.Unknown {
				log.Error("grpc call failed", append(fields, zap.Error(err))...)
			} else {
				log.Warn("grpc call failed", append(fields, zap.Error(err))...)
			}
		} else {
			log.Info("grpc call completed", fields...)
		}

		return resp, err
	}
}

// UnaryRecovery is a unary server interceptor that recovers from panics.
func UnaryRecovery(log *zap.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp interface{}, err error) {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic in grpc handler",
					zap.String("method", info.FullMethod),
					zap.String("request_id", GetGRPCRequestID(ctx)),
					zap.Any("panic", r),
					zap.String("stack", string(debug.Stack())),
				)
				err = status.Errorf(codes.Internal, "internal server error")
			}
		}()
		return handler(ctx, req)
	}
}

// UnaryAuth validates Bearer tokens for gRPC calls.
func UnaryAuth(authenticator interface {
	AuthenticateToken(ctx context.Context, token string) (userID string, err error)
}, log *zap.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "missing metadata")
		}

		authValues := md.Get("authorization")
		if len(authValues) == 0 {
			return nil, status.Error(codes.Unauthenticated, "authorization header required")
		}

		token := authValues[0]
		userID, err := authenticator.AuthenticateToken(ctx, token)
		if err != nil {
			log.Warn("grpc auth failed",
				zap.String("method", info.FullMethod),
				zap.String("request_id", GetGRPCRequestID(ctx)),
				zap.Error(err),
			)
			return nil, status.Error(codes.Unauthenticated, "invalid token")
		}

		ctx = context.WithValue(ctx, grpcUserIDKey{}, userID)
		return handler(ctx, req)
	}
}

type grpcUserIDKey struct{}

// ChainUnaryInterceptors chains multiple unary interceptors.
// This is equivalent to grpc.ChainUnaryInterceptor but demonstrates the pattern.
func ChainUnaryInterceptors(interceptors ...grpc.UnaryServerInterceptor) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		// Build the chain from the innermost out
		chained := handler
		for i := len(interceptors) - 1; i >= 0; i-- {
			i := i
			inner := chained
			outer := interceptors[i]
			chained = func(ctx context.Context, req interface{}) (interface{}, error) {
				return outer(ctx, req, info, inner)
			}
		}
		return chained(ctx, req)
	}
}
```

## Section 9: gRPC Stream Interceptors

Stream interceptors wrap streaming RPCs. They are more complex because the interceptor must also wrap the stream object to intercept individual messages.

```go
// grpcmiddleware/stream.go
package grpcmiddleware

import (
	"context"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"runtime/debug"
)

// wrappedServerStream wraps grpc.ServerStream to override Context().
type wrappedServerStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *wrappedServerStream) Context() context.Context {
	return w.ctx
}

// wrapServerStream creates a wrapped stream with the given context.
func wrapServerStream(stream grpc.ServerStream, ctx context.Context) grpc.ServerStream {
	return &wrappedServerStream{ServerStream: stream, ctx: ctx}
}

// StreamRequestID injects request IDs into streaming RPCs.
func StreamRequestID() grpc.StreamServerInterceptor {
	return func(srv interface{}, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		ctx, _ := requestIDFromIncoming(stream.Context())
		return handler(srv, wrapServerStream(stream, ctx))
	}
}

// StreamLogger logs streaming RPC calls with duration and error info.
func StreamLogger(log *zap.Logger) grpc.StreamServerInterceptor {
	return func(srv interface{}, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		start := time.Now()
		requestID := GetGRPCRequestID(stream.Context())

		log.Info("grpc stream started",
			zap.String("method", info.FullMethod),
			zap.String("request_id", requestID),
			zap.Bool("client_stream", info.IsClientStream),
			zap.Bool("server_stream", info.IsServerStream),
		)

		err := handler(srv, stream)

		code := codes.OK
		if err != nil {
			code = status.Code(err)
		}

		log.Info("grpc stream completed",
			zap.String("method", info.FullMethod),
			zap.String("request_id", requestID),
			zap.String("code", code.String()),
			zap.Duration("duration", time.Since(start)),
			zap.Error(err),
		)

		return err
	}
}

// StreamRecovery recovers from panics in streaming handlers.
func StreamRecovery(log *zap.Logger) grpc.StreamServerInterceptor {
	return func(srv interface{}, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic in grpc stream handler",
					zap.String("method", info.FullMethod),
					zap.Any("panic", r),
					zap.String("stack", string(debug.Stack())),
				)
				err = status.Errorf(codes.Internal, "internal server error")
			}
		}()
		return handler(srv, stream)
	}
}

// countingServerStream counts messages sent and received for metrics.
type countingServerStream struct {
	grpc.ServerStream
	messagesSent     int64
	messagesReceived int64
}

func (s *countingServerStream) SendMsg(m interface{}) error {
	err := s.ServerStream.SendMsg(m)
	if err == nil {
		s.messagesSent++
	}
	return err
}

func (s *countingServerStream) RecvMsg(m interface{}) error {
	err := s.ServerStream.RecvMsg(m)
	if err == nil {
		s.messagesReceived++
	}
	return err
}
```

## Section 10: Complete Server Assembly

Putting it all together into a production server:

```go
// main.go
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"
	"golang.org/x/time/rate"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	"github.com/support-tools/example/grpcmiddleware"
	"github.com/support-tools/example/middleware"
)

func main() {
	logger, err := zap.NewProduction()
	if err != nil {
		log.Fatalf("failed to create logger: %v", err)
	}
	defer logger.Sync()

	// HTTP Server with full middleware chain
	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/api/v1/users", usersHandler)
	httpMux.HandleFunc("/api/v1/admin/config", adminHandler)
	httpMux.HandleFunc("/healthz", healthHandler)

	// Compose the middleware chain
	// Order (outermost to innermost): Recovery -> RequestID -> Logger -> Timeout -> RateLimit -> Auth
	rateLimiter := middleware.NewTokenBucketLimiter(rate.Limit(100), 200)

	httpHandler := middleware.Chain(
		httpMux,
		middleware.Recovery(logger),
		middleware.RequestID,
		middleware.Logger(logger),
		middleware.Timeout(30*time.Second, logger),
		middleware.RateLimit(rateLimiter, middleware.IPKeyExtractor, logger),
	)

	// Route-specific auth: apply Auth only to /api paths
	apiMux := http.NewServeMux()
	apiMux.Handle("/api/", middleware.Chain(
		http.StripPrefix("/api", httpMux),
		// middleware.Auth(myAuthenticator, logger), // uncomment to enable
	))
	apiMux.Handle("/healthz", http.HandlerFunc(healthHandler))

	httpServer := &http.Server{
		Addr:         ":8080",
		Handler:      httpHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 35 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// gRPC Server with full interceptor chain
	grpcServer := grpc.NewServer(
		grpc.ChainUnaryInterceptor(
			grpcmiddleware.UnaryRecovery(logger),
			grpcmiddleware.UnaryRequestID(),
			grpcmiddleware.UnaryLogger(logger),
		),
		grpc.ChainStreamInterceptor(
			grpcmiddleware.StreamRecovery(logger),
			grpcmiddleware.StreamRequestID(),
			grpcmiddleware.StreamLogger(logger),
		),
	)

	reflection.Register(grpcServer)

	// Register your gRPC services here:
	// pb.RegisterMyServiceServer(grpcServer, &myServiceImpl{})

	// Start servers
	go func() {
		logger.Info("HTTP server listening", zap.String("addr", ":8080"))
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("HTTP server error", zap.Error(err))
		}
	}()

	go func() {
		lis, err := net.Listen("tcp", ":9090")
		if err != nil {
			logger.Fatal("failed to listen for gRPC", zap.Error(err))
		}
		logger.Info("gRPC server listening", zap.String("addr", ":9090"))
		if err := grpcServer.Serve(lis); err != nil {
			logger.Fatal("gRPC server error", zap.Error(err))
		}
	}()

	// Graceful shutdown on signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	logger.Info("shutting down servers")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Error("HTTP server shutdown error", zap.Error(err))
	}

	grpcServer.GracefulStop()
	logger.Info("shutdown complete")
}

func usersHandler(w http.ResponseWriter, r *http.Request) {
	requestID := middleware.GetRequestID(r.Context())
	fmt.Fprintf(w, `{"request_id":"%s","users":[]}`, requestID)
}

func adminHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprint(w, `{"status":"ok"}`)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, `{"status":"healthy"}`)
}
```

## Section 11: Middleware Testing

Testing middleware in isolation requires mock handlers and response recorders.

```go
// middleware/middleware_test.go
package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap/zaptest"

	"github.com/support-tools/example/middleware"
)

func TestRequestID_GeneratesID(t *testing.T) {
	handler := middleware.RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := middleware.GetRequestID(r.Context())
		if id == "" {
			t.Error("expected request ID in context, got empty string")
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Header().Get("X-Request-ID") == "" {
		t.Error("expected X-Request-ID response header")
	}
}

func TestRequestID_PropagatesExistingID(t *testing.T) {
	const existingID = "test-correlation-id-12345"

	var capturedID string
	handler := middleware.RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedID = middleware.GetRequestID(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Request-ID", existingID)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if capturedID != existingID {
		t.Errorf("expected request ID %q, got %q", existingID, capturedID)
	}
}

func TestRecovery_CatchesPanic(t *testing.T) {
	log := zaptest.NewLogger(t)

	handler := middleware.Recovery(log)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("test panic")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	// Should not panic
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}
}

func TestChain_OrderIsPreserved(t *testing.T) {
	var order []string

	mw1 := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			order = append(order, "mw1-before")
			next.ServeHTTP(w, r)
			order = append(order, "mw1-after")
		})
	}

	mw2 := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			order = append(order, "mw2-before")
			next.ServeHTTP(w, r)
			order = append(order, "mw2-after")
		})
	}

	handler := middleware.Chain(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			order = append(order, "handler")
		}),
		middleware.Middleware(mw1),
		middleware.Middleware(mw2),
	)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	expected := []string{"mw1-before", "mw2-before", "handler", "mw2-after", "mw1-after"}
	for i, step := range expected {
		if i >= len(order) || order[i] != step {
			t.Errorf("position %d: expected %q, got %q", i, step, order[i])
		}
	}
}

func TestRateLimit_BlocksExcessRequests(t *testing.T) {
	log := zaptest.NewLogger(t)
	limiter := middleware.NewTokenBucketLimiter(1, 1) // 1 req/sec, burst of 1

	handler := middleware.RateLimit(limiter, middleware.IPKeyExtractor, log)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
	)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.1:12345"

	// First request should pass
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req)
	if rec1.Code != http.StatusOK {
		t.Errorf("first request: expected 200, got %d", rec1.Code)
	}

	// Second immediate request should be rate limited
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusTooManyRequests {
		t.Errorf("second request: expected 429, got %d", rec2.Code)
	}
}
```

## Section 12: Context Propagation Best Practices

Context propagation is the hardest part of middleware to get right. These rules prevent the most common mistakes.

**Rule 1: Never store context in a struct.** Pass it as a function argument.

```go
// WRONG
type MyService struct {
    ctx context.Context // never do this
}

// CORRECT
func (s *MyService) DoWork(ctx context.Context) error {
    // use ctx here
    return nil
}
```

**Rule 2: Use typed unexported keys to avoid collisions.**

```go
// WRONG: string keys collide across packages
ctx = context.WithValue(ctx, "userID", userID)

// CORRECT: unexported type prevents collisions
type userIDKey struct{}
ctx = context.WithValue(ctx, userIDKey{}, userID)
```

**Rule 3: Document the context contract.** Every function that reads from context must document what it expects.

```go
// GetUserID retrieves the authenticated user ID from ctx.
// Requires middleware.Auth to have run upstream in the middleware chain.
// Returns an empty string if no user is authenticated.
func GetUserID(ctx context.Context) string {
    id, _ := ctx.Value(userIDKey{}).(string)
    return id
}
```

**Rule 4: Propagate cancellation.** All database calls, HTTP calls to upstream services, and blocking operations must use the request context.

```go
// WRONG: ignores cancellation
rows, err := db.Query("SELECT * FROM users WHERE id = $1", userID)

// CORRECT: respects cancellation and timeout
rows, err := db.QueryContext(ctx, "SELECT * FROM users WHERE id = $1", userID)
```

## Summary

A production Go middleware library has three layers:

1. **Infrastructure middlewares** (outermost): Recovery, RequestID, Logger. These run on every request and must be bulletproof.
2. **Traffic control middlewares**: Timeout, RateLimit, Auth. These enforce operational constraints.
3. **Business logic middlewares** (innermost): RequireRole, tenant isolation, feature flags. These are specific to your application.

The `Chain` function provides clean left-to-right composition that mirrors the mental model of request flow. For gRPC, use `grpc.ChainUnaryInterceptor` and `grpc.ChainStreamInterceptor` for the same composability. Keep each middleware focused on a single responsibility, test each in isolation with `httptest`, and always propagate context correctly to avoid silent timeouts and cancellation leaks.
