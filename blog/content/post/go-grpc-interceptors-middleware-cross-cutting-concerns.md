---
title: "Go gRPC Interceptors and Middleware: Cross-Cutting Concerns at Scale"
date: 2030-07-10T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "gRPC", "Microservices", "Observability", "Authentication", "Middleware"]
categories:
- Go
- Microservices
- Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Production gRPC interceptors in Go covering unary and streaming interceptor patterns, interceptor chaining, authentication and authorization, rate limiting, circuit breakers, distributed tracing injection, and comprehensive testing strategies for interceptor chains."
more_link: "yes"
url: "/go-grpc-interceptors-middleware-cross-cutting-concerns/"
---

gRPC interceptors are the equivalent of HTTP middleware for RPC services — they execute around method handlers, enabling authentication, authorization, rate limiting, observability, and error handling to be implemented once and applied consistently across all service methods. Unlike HTTP middleware, gRPC distinguishes between unary RPCs (single request, single response) and streaming RPCs (bidirectional byte streams), requiring separate interceptor types for each. Production gRPC services in Go typically run four to eight interceptors chained together, and the order in which they are applied determines both correctness and performance.

<!--more-->

## Interceptor Fundamentals

### Unary Interceptor Interface

A unary interceptor has the signature:

```go
type UnaryServerInterceptor func(
    ctx     context.Context,
    req     interface{},
    info    *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error)
```

The `handler` is the next interceptor in the chain, or the actual method handler if this is the last interceptor. Calling `handler(ctx, req)` invokes the downstream logic.

### Streaming Interceptor Interface

```go
type StreamServerInterceptor func(
    srv     interface{},
    ss      grpc.ServerStream,
    info    *grpc.StreamServerInfo,
    handler grpc.StreamHandler,
) error
```

Streaming interceptors wrap the `grpc.ServerStream` interface to observe or modify individual messages:

```go
package interceptor

import "google.golang.org/grpc"

// wrappedStream wraps grpc.ServerStream to intercept SendMsg/RecvMsg
type wrappedStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (w *wrappedStream) Context() context.Context {
    return w.ctx
}

func (w *wrappedStream) RecvMsg(m interface{}) error {
    // Intercept incoming stream messages
    err := w.ServerStream.RecvMsg(m)
    if err != nil {
        return err
    }
    // Post-receive logic here
    return nil
}

func (w *wrappedStream) SendMsg(m interface{}) error {
    // Pre-send logic here
    return w.ServerStream.SendMsg(m)
}
```

## Interceptor Chaining

### go-grpc-middleware Chain

The `google.golang.org/grpc/middleware` package (formerly `github.com/grpc-ecosystem/go-grpc-middleware`) provides chain construction:

```go
package server

import (
    "google.golang.org/grpc"
    grpcmiddleware "github.com/grpc-ecosystem/go-grpc-middleware/v2"
    "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"
)

func NewServer(opts ...ServerOption) *grpc.Server {
    cfg := applyOptions(opts...)

    unaryInterceptors := []grpc.UnaryServerInterceptor{
        // Order matters — executes outermost to innermost on request,
        // innermost to outermost on response
        RecoveryInterceptor(),           // 1. Catch panics — must be outermost
        RequestIDInterceptor(),          // 2. Inject request ID
        LoggingInterceptor(cfg.logger),  // 3. Log with request ID in context
        TracingInterceptor(),            // 4. Start trace span
        AuthInterceptor(cfg.auth),       // 5. Authenticate
        AuthzInterceptor(cfg.authz),     // 6. Authorize
        RateLimitInterceptor(cfg.limiter), // 7. Rate limit
        ValidationInterceptor(),         // 8. Validate request
    }

    streamInterceptors := []grpc.StreamServerInterceptor{
        StreamRecoveryInterceptor(),
        StreamRequestIDInterceptor(),
        StreamLoggingInterceptor(cfg.logger),
        StreamTracingInterceptor(),
        StreamAuthInterceptor(cfg.auth),
        StreamAuthzInterceptor(cfg.authz),
        StreamRateLimitInterceptor(cfg.limiter),
    }

    return grpc.NewServer(
        grpc.ChainUnaryInterceptor(unaryInterceptors...),
        grpc.ChainStreamInterceptor(streamInterceptors...),
        grpc.MaxRecvMsgSize(4*1024*1024),  // 4 MB
        grpc.MaxSendMsgSize(4*1024*1024),
    )
}
```

## Authentication Interceptor

### JWT Verification

```go
package interceptor

import (
    "context"
    "fmt"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

type Claims struct {
    jwt.RegisteredClaims
    UserID    string   `json:"uid"`
    Roles     []string `json:"roles"`
    ServiceID string   `json:"svc"`
}

type ctxKeyType string

const (
    ctxKeyUserID    ctxKeyType = "user_id"
    ctxKeyRoles     ctxKeyType = "roles"
    ctxKeyServiceID ctxKeyType = "service_id"
)

type JWTAuthenticator struct {
    signingKey  []byte
    publicMethods map[string]bool  // Methods that skip authentication
}

func NewJWTAuthenticator(signingKey []byte, publicMethods ...string) *JWTAuthenticator {
    pm := make(map[string]bool, len(publicMethods))
    for _, m := range publicMethods {
        pm[m] = true
    }
    return &JWTAuthenticator{
        signingKey:    signingKey,
        publicMethods: pm,
    }
}

func (a *JWTAuthenticator) UnaryInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        if a.publicMethods[info.FullMethod] {
            return handler(ctx, req)
        }

        ctx, err := a.authenticate(ctx)
        if err != nil {
            return nil, err
        }
        return handler(ctx, req)
    }
}

func (a *JWTAuthenticator) StreamInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        if a.publicMethods[info.FullMethod] {
            return handler(srv, ss)
        }

        ctx, err := a.authenticate(ss.Context())
        if err != nil {
            return err
        }
        return handler(srv, &wrappedStream{ss, ctx})
    }
}

func (a *JWTAuthenticator) authenticate(ctx context.Context) (context.Context, error) {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return nil, status.Error(codes.Unauthenticated, "missing metadata")
    }

    authHeader := md.Get("authorization")
    if len(authHeader) == 0 {
        return nil, status.Error(codes.Unauthenticated, "missing authorization header")
    }

    token := strings.TrimPrefix(authHeader[0], "Bearer ")
    if token == authHeader[0] {
        return nil, status.Error(codes.Unauthenticated, "invalid authorization format")
    }

    claims, err := a.parseToken(token)
    if err != nil {
        return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
    }

    ctx = context.WithValue(ctx, ctxKeyUserID, claims.UserID)
    ctx = context.WithValue(ctx, ctxKeyRoles, claims.Roles)
    ctx = context.WithValue(ctx, ctxKeyServiceID, claims.ServiceID)
    return ctx, nil
}

func (a *JWTAuthenticator) parseToken(tokenStr string) (*Claims, error) {
    token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(token *jwt.Token) (interface{}, error) {
        if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return a.signingKey, nil
    })
    if err != nil {
        return nil, err
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return nil, fmt.Errorf("invalid token claims")
    }

    if claims.ExpiresAt != nil && claims.ExpiresAt.Before(time.Now()) {
        return nil, fmt.Errorf("token expired")
    }

    return claims, nil
}

// Context helpers
func UserIDFromContext(ctx context.Context) (string, bool) {
    v, ok := ctx.Value(ctxKeyUserID).(string)
    return v, ok
}

func RolesFromContext(ctx context.Context) []string {
    v, _ := ctx.Value(ctxKeyRoles).([]string)
    return v
}
```

## Authorization Interceptor

```go
package interceptor

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// MethodPolicy defines required roles for a gRPC method
type MethodPolicy struct {
    RequiredRoles []string // Any of these roles grants access
    AllRolesRequired bool  // If true, ALL roles are required
}

type RBACAuthorizer struct {
    policies map[string]MethodPolicy  // FullMethod → policy
    defaultDeny bool
}

func NewRBACAuthorizer(defaultDeny bool) *RBACAuthorizer {
    return &RBACAuthorizer{
        policies:    make(map[string]MethodPolicy),
        defaultDeny: defaultDeny,
    }
}

func (a *RBACAuthorizer) AddPolicy(fullMethod string, policy MethodPolicy) {
    a.policies[fullMethod] = policy
}

func (a *RBACAuthorizer) UnaryInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        if err := a.authorize(ctx, info.FullMethod); err != nil {
            return nil, err
        }
        return handler(ctx, req)
    }
}

func (a *RBACAuthorizer) authorize(ctx context.Context, fullMethod string) error {
    policy, exists := a.policies[fullMethod]
    if !exists {
        if a.defaultDeny {
            return status.Errorf(codes.PermissionDenied,
                "no policy for method %s", fullMethod)
        }
        return nil // default allow
    }

    if len(policy.RequiredRoles) == 0 {
        return nil // no role requirements
    }

    userRoles := RolesFromContext(ctx)
    roleSet := make(map[string]bool, len(userRoles))
    for _, r := range userRoles {
        roleSet[r] = true
    }

    if policy.AllRolesRequired {
        for _, required := range policy.RequiredRoles {
            if !roleSet[required] {
                return status.Errorf(codes.PermissionDenied,
                    "missing required role: %s", required)
            }
        }
        return nil
    }

    // Any role sufficient
    for _, required := range policy.RequiredRoles {
        if roleSet[required] {
            return nil
        }
    }

    return status.Errorf(codes.PermissionDenied,
        "insufficient permissions for %s", fullMethod)
}
```

## Rate Limiting Interceptor

```go
package interceptor

import (
    "context"
    "sync"
    "time"

    "golang.org/x/time/rate"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// PerUserRateLimiter applies per-user rate limits
type PerUserRateLimiter struct {
    ratePerUser  rate.Limit
    burstPerUser int
    limiters     sync.Map // userID → *rate.Limiter
    globalLimit  *rate.Limiter
    cleanupTick  *time.Ticker
}

func NewPerUserRateLimiter(
    globalRPS float64,
    userRPS float64,
    burst int,
) *PerUserRateLimiter {
    rl := &PerUserRateLimiter{
        ratePerUser:  rate.Limit(userRPS),
        burstPerUser: burst,
        globalLimit:  rate.NewLimiter(rate.Limit(globalRPS), int(globalRPS)),
        cleanupTick:  time.NewTicker(5 * time.Minute),
    }
    go rl.cleanup()
    return rl
}

func (rl *PerUserRateLimiter) getLimiter(userID string) *rate.Limiter {
    actual, _ := rl.limiters.LoadOrStore(userID,
        rate.NewLimiter(rl.ratePerUser, rl.burstPerUser))
    return actual.(*rate.Limiter)
}

func (rl *PerUserRateLimiter) UnaryInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        // Global rate check
        if !rl.globalLimit.Allow() {
            return nil, status.Error(codes.ResourceExhausted,
                "global rate limit exceeded")
        }

        // Per-user rate check
        if userID, ok := UserIDFromContext(ctx); ok {
            if !rl.getLimiter(userID).Allow() {
                return nil, status.Errorf(codes.ResourceExhausted,
                    "rate limit exceeded for user %s", userID)
            }
        }

        return handler(ctx, req)
    }
}

// cleanup removes idle limiters to prevent map growth
func (rl *PerUserRateLimiter) cleanup() {
    for range rl.cleanupTick.C {
        rl.limiters.Range(func(key, value interface{}) bool {
            limiter := value.(*rate.Limiter)
            // Remove limiters that are at full capacity (idle users)
            if limiter.Tokens() == float64(rl.burstPerUser) {
                rl.limiters.Delete(key)
            }
            return true
        })
    }
}
```

## Circuit Breaker Interceptor

```go
package interceptor

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type circuitState int32

const (
    stateClosed   circuitState = 0  // Normal operation
    stateOpen     circuitState = 1  // Failing — reject requests
    stateHalfOpen circuitState = 2  // Testing recovery
)

var ErrCircuitOpen = errors.New("circuit breaker open")

type CircuitBreaker struct {
    name           string
    state          int32 // atomic access via circuitState
    failures       int64 // atomic
    successes      int64 // atomic
    lastFailure    int64 // unix nano, atomic
    threshold      int64 // failures before opening
    successThresh  int64 // successes to close from half-open
    timeout        time.Duration
    mu             sync.Mutex
}

func NewCircuitBreaker(name string, threshold, successThreshold int64, timeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        name:          name,
        threshold:     threshold,
        successThresh: successThreshold,
        timeout:       timeout,
    }
}

func (cb *CircuitBreaker) allow() bool {
    state := circuitState(atomic.LoadInt32(&cb.state))

    switch state {
    case stateClosed:
        return true
    case stateOpen:
        lastFailure := time.Unix(0, atomic.LoadInt64(&cb.lastFailure))
        if time.Since(lastFailure) > cb.timeout {
            // Try to transition to half-open
            if atomic.CompareAndSwapInt32(&cb.state, int32(stateOpen), int32(stateHalfOpen)) {
                atomic.StoreInt64(&cb.successes, 0)
            }
            return true
        }
        return false
    case stateHalfOpen:
        return true
    }
    return false
}

func (cb *CircuitBreaker) recordSuccess() {
    state := circuitState(atomic.LoadInt32(&cb.state))
    if state == stateHalfOpen {
        n := atomic.AddInt64(&cb.successes, 1)
        if n >= cb.successThresh {
            atomic.StoreInt32(&cb.state, int32(stateClosed))
            atomic.StoreInt64(&cb.failures, 0)
        }
    } else {
        atomic.StoreInt64(&cb.failures, 0)
    }
}

func (cb *CircuitBreaker) recordFailure() {
    atomic.StoreInt64(&cb.lastFailure, time.Now().UnixNano())
    n := atomic.AddInt64(&cb.failures, 1)
    if n >= cb.threshold {
        atomic.StoreInt32(&cb.state, int32(stateOpen))
    }
}

// CircuitBreakerInterceptor wraps downstream calls with circuit breaker protection
// Useful on the CLIENT side to avoid cascading failures to a failing downstream service
func CircuitBreakerInterceptor(cb *CircuitBreaker) grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply interface{},
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        if !cb.allow() {
            return status.Errorf(codes.Unavailable,
                "circuit breaker %s is open", cb.name)
        }

        err := invoker(ctx, method, req, reply, cc, opts...)
        if err != nil {
            s, ok := status.FromError(err)
            if ok && isServerError(s.Code()) {
                cb.recordFailure()
            }
        } else {
            cb.recordSuccess()
        }
        return err
    }
}

func isServerError(code codes.Code) bool {
    switch code {
    case codes.Internal, codes.Unavailable, codes.DeadlineExceeded, codes.ResourceExhausted:
        return true
    }
    return false
}
```

## Distributed Tracing Interceptor

```go
package interceptor

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/propagation"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    grpcmetadata "google.golang.org/grpc/metadata"
    otelgrpc "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

// TracingInterceptor returns a server interceptor that extracts trace context
// from incoming gRPC metadata and starts a span for each RPC.
// The otelgrpc package provides production-ready tracing interceptors.
func TracingInterceptor() grpc.UnaryServerInterceptor {
    tracer := otel.Tracer("grpc-server")
    propagator := otel.GetTextMapPropagator()

    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        // Extract trace context from incoming metadata
        md, ok := grpcmetadata.FromIncomingContext(ctx)
        if ok {
            carrier := metadataCarrier(md)
            ctx = propagator.Extract(ctx, carrier)
        }

        // Start span
        ctx, span := tracer.Start(ctx, info.FullMethod,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                semconv.RPCSystemGRPC,
                semconv.RPCMethod(info.FullMethod),
            ),
        )
        defer span.End()

        // Add request ID to span if available
        if reqID, ok := RequestIDFromContext(ctx); ok {
            span.SetAttributes(attribute.String("request.id", reqID))
        }

        // Add user ID to span if authenticated
        if userID, ok := UserIDFromContext(ctx); ok {
            span.SetAttributes(attribute.String("user.id", userID))
        }

        resp, err := handler(ctx, req)
        if err != nil {
            s, _ := grpc.Code(err)
            span.SetStatus(codes.Error, err.Error())
            span.SetAttributes(attribute.String("grpc.status_code", s.String()))
        } else {
            span.SetStatus(codes.Ok, "")
        }

        return resp, err
    }
}

// metadataCarrier adapts gRPC metadata to the OpenTelemetry TextMapCarrier interface
type metadataCarrier grpcmetadata.MD

func (mc metadataCarrier) Get(key string) string {
    vals := grpcmetadata.MD(mc).Get(key)
    if len(vals) > 0 {
        return vals[0]
    }
    return ""
}

func (mc metadataCarrier) Set(key, val string) {
    grpcmetadata.MD(mc).Set(key, val)
}

func (mc metadataCarrier) Keys() []string {
    keys := make([]string, 0, len(mc))
    for k := range mc {
        keys = append(keys, k)
    }
    return keys
}
```

## Recovery Interceptor

```go
package interceptor

import (
    "context"
    "fmt"
    "runtime/debug"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// RecoveryInterceptor catches panics and converts them to gRPC errors
func RecoveryInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (resp interface{}, err error) {
        panicked := true
        defer func() {
            if panicked {
                p := recover()
                stack := debug.Stack()

                // Log the panic with stack trace
                if logger, ok := LoggerFromContext(ctx); ok {
                    logger.Error("panic in gRPC handler",
                        "method", info.FullMethod,
                        "panic", fmt.Sprintf("%v", p),
                        "stack", string(stack),
                    )
                }

                err = status.Errorf(codes.Internal,
                    "internal server error — request ID: %s",
                    requestIDFromContext(ctx))
            }
        }()

        resp, err = handler(ctx, req)
        panicked = false
        return resp, err
    }
}

func requestIDFromContext(ctx context.Context) string {
    id, _ := RequestIDFromContext(ctx)
    return id
}
```

## Testing Interceptor Chains

```go
package interceptor_test

import (
    "context"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"

    "yourmodule/interceptor"
)

// testHandler simulates a gRPC method handler
type testHandler struct {
    called  bool
    retResp interface{}
    retErr  error
}

func (h *testHandler) handle(ctx context.Context, req interface{}) (interface{}, error) {
    h.called = true
    return h.retResp, h.retErr
}

func TestJWTAuthenticator_ValidToken(t *testing.T) {
    signingKey := []byte("test-secret-key-256-bits-long-!!!!")
    auth := interceptor.NewJWTAuthenticator(signingKey)

    // Generate a valid test token
    token := generateTestToken(t, signingKey, "user-123", []string{"admin"}, time.Hour)

    md := metadata.New(map[string]string{
        "authorization": "Bearer " + token,
    })
    ctx := metadata.NewIncomingContext(context.Background(), md)

    handler := &testHandler{retResp: "ok", retErr: nil}
    interceptorFn := auth.UnaryInterceptor()

    resp, err := interceptorFn(ctx, nil, &grpc.UnaryServerInfo{
        FullMethod: "/myservice.MyService/MyMethod",
    }, handler.handle)

    require.NoError(t, err)
    assert.Equal(t, "ok", resp)
    assert.True(t, handler.called)

    // Verify context enrichment
    userID, ok := interceptor.UserIDFromContext(ctx)
    _ = ok
    _ = userID
}

func TestJWTAuthenticator_MissingToken(t *testing.T) {
    signingKey := []byte("test-secret-key-256-bits-long-!!!!")
    auth := interceptor.NewJWTAuthenticator(signingKey)

    ctx := context.Background() // No metadata
    handler := &testHandler{}
    interceptorFn := auth.UnaryInterceptor()

    _, err := interceptorFn(ctx, nil, &grpc.UnaryServerInfo{
        FullMethod: "/myservice.MyService/MyMethod",
    }, handler.handle)

    require.Error(t, err)
    assert.Equal(t, codes.Unauthenticated, status.Code(err))
    assert.False(t, handler.called)
}

func TestJWTAuthenticator_PublicMethod(t *testing.T) {
    signingKey := []byte("test-secret-key-256-bits-long-!!!!")
    auth := interceptor.NewJWTAuthenticator(signingKey,
        "/myservice.MyService/HealthCheck") // Public method

    ctx := context.Background() // No auth header
    handler := &testHandler{retResp: "healthy"}
    interceptorFn := auth.UnaryInterceptor()

    resp, err := interceptorFn(ctx, nil, &grpc.UnaryServerInfo{
        FullMethod: "/myservice.MyService/HealthCheck",
    }, handler.handle)

    require.NoError(t, err)
    assert.Equal(t, "healthy", resp)
    assert.True(t, handler.called)
}

func TestRateLimiter_BurstExceeded(t *testing.T) {
    // Rate: 1 RPS, burst: 2
    limiter := interceptor.NewPerUserRateLimiter(100, 1, 2)
    interceptorFn := limiter.UnaryInterceptor()

    ctx := context.WithValue(context.Background(), ctxKeyUserIDTest, "user-123")
    handler := &testHandler{retResp: "ok"}

    info := &grpc.UnaryServerInfo{FullMethod: "/svc/Method"}

    // First two requests succeed (burst)
    _, err := interceptorFn(ctx, nil, info, handler.handle)
    require.NoError(t, err)

    _, err = interceptorFn(ctx, nil, info, handler.handle)
    require.NoError(t, err)

    // Third request should be rate limited
    _, err = interceptorFn(ctx, nil, info, handler.handle)
    assert.Equal(t, codes.ResourceExhausted, status.Code(err))
}

func TestCircuitBreaker_Opens_After_Threshold(t *testing.T) {
    cb := interceptor.NewCircuitBreaker("test-service", 3, 2, 5*time.Second)
    interceptorFn := interceptor.CircuitBreakerInterceptor(cb)

    serverErr := status.Error(codes.Internal, "server error")

    failingInvoker := func(ctx context.Context, method string, req, reply interface{},
        cc *grpc.ClientConn, opts ...grpc.CallOption) error {
        return serverErr
    }

    // Record 3 failures to trip the breaker
    for i := 0; i < 3; i++ {
        err := interceptorFn(context.Background(), "/svc/Method", nil, nil, nil, failingInvoker)
        require.Equal(t, codes.Internal, status.Code(err))
    }

    // Next call should be rejected by circuit breaker
    err := interceptorFn(context.Background(), "/svc/Method", nil, nil, nil, failingInvoker)
    require.Error(t, err)
    assert.Equal(t, codes.Unavailable, status.Code(err))
    assert.Contains(t, err.Error(), "circuit breaker")
}
```

## Putting It Together: Full Server Setup

```go
package main

import (
    "fmt"
    "log/slog"
    "net"
    "os"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    healthpb "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/reflection"

    "yourmodule/interceptor"
    pb "yourmodule/proto/v1"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    signingKey := []byte(os.Getenv("JWT_SIGNING_KEY"))

    auth := interceptor.NewJWTAuthenticator(signingKey,
        "/grpc.health.v1.Health/Check",
        "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
    )

    authz := interceptor.NewRBACAuthorizer(true /* default deny */)
    authz.AddPolicy("/myservice.v1.UserService/GetUser", interceptor.MethodPolicy{
        RequiredRoles: []string{"user:read", "admin"},
    })
    authz.AddPolicy("/myservice.v1.UserService/DeleteUser", interceptor.MethodPolicy{
        RequiredRoles:    []string{"admin"},
        AllRolesRequired: false,
    })

    rateLimiter := interceptor.NewPerUserRateLimiter(
        10000, // global: 10k RPS
        100,   // per-user: 100 RPS
        200,   // burst
    )

    srv := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            interceptor.RecoveryInterceptor(),
            interceptor.RequestIDInterceptor(),
            interceptor.LoggingInterceptor(logger),
            interceptor.TracingInterceptor(),
            auth.UnaryInterceptor(),
            authz.UnaryInterceptor(),
            rateLimiter.UnaryInterceptor(),
            interceptor.ValidationInterceptor(),
        ),
        grpc.ChainStreamInterceptor(
            interceptor.StreamRecoveryInterceptor(),
            interceptor.StreamRequestIDInterceptor(),
            interceptor.StreamLoggingInterceptor(logger),
            interceptor.StreamTracingInterceptor(),
            auth.StreamInterceptor(),
            authz.StreamInterceptor(),
        ),
        grpc.MaxRecvMsgSize(4*1024*1024),
        grpc.MaxSendMsgSize(4*1024*1024),
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle:     15 * time.Minute,
            MaxConnectionAge:      30 * time.Minute,
            MaxConnectionAgeGrace: 5 * time.Second,
            Time:                  5 * time.Second,
            Timeout:               1 * time.Second,
        }),
    )

    // Register services
    pb.RegisterUserServiceServer(srv, &UserServiceImpl{})
    healthpb.RegisterHealthServer(srv, health.NewServer())
    reflection.Register(srv)

    lis, err := net.Listen("tcp", fmt.Sprintf(":%s", os.Getenv("GRPC_PORT")))
    if err != nil {
        logger.Error("failed to listen", "error", err)
        os.Exit(1)
    }

    logger.Info("gRPC server starting", "addr", lis.Addr())
    if err := srv.Serve(lis); err != nil {
        logger.Error("server failed", "error", err)
        os.Exit(1)
    }
}
```

## Summary

gRPC interceptors are the mechanism for building production-grade cross-cutting concerns into Go RPC services without coupling authentication, tracing, or rate limiting logic to business methods. Key principles:

1. **Ordering is critical**: Recovery (outermost) → request ID → logging → tracing → auth → authz → rate limiting → validation.
2. **Unary and streaming require separate implementations**: Always provide both unless streaming is unused.
3. **Context threading**: Each interceptor adds to context (user ID, request ID, span) for downstream access.
4. **Circuit breakers belong on the client side**: Protect the caller from cascading failures, not the server from excessive load (that's rate limiting's job).
5. **Test interceptors in isolation**: Mock `grpc.UnaryHandler` to test each interceptor's behavior independently, then integration-test the chain.

With these patterns, cross-cutting concerns become a one-time implementation that every service inherits, dramatically reducing the surface area for security misconfigurations and observability gaps.
