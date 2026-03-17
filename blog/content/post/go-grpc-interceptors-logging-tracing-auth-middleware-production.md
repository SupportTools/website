---
title: "Go gRPC Interceptors: Logging, Tracing, and Auth Middleware for Production"
date: 2031-05-20T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Interceptors", "OpenTelemetry", "JWT", "mTLS", "Middleware", "Observability"]
categories:
- Go
- gRPC
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to building production-grade gRPC interceptor chains in Go, covering unary and streaming interceptors, OpenTelemetry tracing, JWT/mTLS authentication, rate limiting, and panic recovery middleware."
more_link: "yes"
url: "/go-grpc-interceptors-logging-tracing-auth-middleware-production/"
---

gRPC interceptors are the middleware layer of gRPC services—they handle cross-cutting concerns like authentication, observability, and resilience without polluting business logic. Building a well-structured interceptor chain is the difference between a maintainable microservice and one that collapses under the weight of scattered boilerplate. This guide builds a complete production interceptor stack from first principles.

<!--more-->

# Go gRPC Interceptors: Logging, Tracing, and Auth Middleware for Production

## Section 1: gRPC Interceptor Fundamentals

gRPC in Go provides four interceptor hooks:

1. `grpc.UnaryServerInterceptor` — server-side, single request/response
2. `grpc.StreamServerInterceptor` — server-side, streaming
3. `grpc.UnaryClientInterceptor` — client-side, single request/response
4. `grpc.StreamClientInterceptor` — client-side, streaming

### Project Structure

```
grpc-service/
├── cmd/
│   ├── server/main.go
│   └── client/main.go
├── interceptors/
│   ├── auth.go
│   ├── logging.go
│   ├── tracing.go
│   ├── ratelimit.go
│   ├── recovery.go
│   └── chain.go
├── proto/
│   └── example/v1/
│       ├── example.proto
│       └── example.pb.go
├── service/
│   └── example.go
└── go.mod
```

### go.mod Setup

```go
module github.com/yourorg/grpc-service

go 1.22

require (
    google.golang.org/grpc v1.62.1
    google.golang.org/protobuf v1.33.0
    github.com/grpc-ecosystem/go-grpc-middleware/v2 v2.1.0
    go.opentelemetry.io/otel v1.24.0
    go.opentelemetry.io/otel/trace v1.24.0
    go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc v0.49.0
    github.com/golang-jwt/jwt/v5 v5.2.1
    golang.org/x/time v0.5.0
    github.com/prometheus/client_golang v1.19.0
    go.uber.org/zap v1.27.0
    google.golang.org/grpc/examples v0.0.0-20240220013500-2de26e350a6e
)
```

## Section 2: Logging Interceptor

### Structured Logging with Zap

```go
// interceptors/logging.go
package interceptors

import (
    "context"
    "path"
    "time"

    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/peer"
    "google.golang.org/grpc/status"
)

// LoggingConfig configures the logging interceptor behavior.
type LoggingConfig struct {
    Logger            *zap.Logger
    LogRequestBody    bool
    LogResponseBody   bool
    SlowThreshold     time.Duration
    SkipPaths         []string
    AlwaysLogLevel    zapcore.Level
    ErrorLogLevel     zapcore.Level
}

// NewLoggingConfig returns a LoggingConfig with sensible defaults.
func NewLoggingConfig(logger *zap.Logger) LoggingConfig {
    return LoggingConfig{
        Logger:         logger,
        SlowThreshold:  500 * time.Millisecond,
        AlwaysLogLevel: zapcore.InfoLevel,
        ErrorLogLevel:  zapcore.ErrorLevel,
    }
}

// UnaryServerLogging returns a unary server interceptor that logs calls.
func UnaryServerLogging(cfg LoggingConfig) grpc.UnaryServerInterceptor {
    skipSet := make(map[string]bool, len(cfg.SkipPaths))
    for _, p := range cfg.SkipPaths {
        skipSet[p] = true
    }

    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        // Skip health checks and reflection
        if skipSet[info.FullMethod] {
            return handler(ctx, req)
        }

        start := time.Now()
        service := path.Dir(info.FullMethod)[1:]
        method := path.Base(info.FullMethod)

        // Extract metadata
        fields := extractLogFields(ctx, service, method)

        // Add request body if configured
        if cfg.LogRequestBody {
            fields = append(fields, zap.Any("request", req))
        }

        // Call the handler
        resp, err := handler(ctx, req)
        duration := time.Since(start)

        // Determine status code
        code := status.Code(err)
        fields = append(fields,
            zap.String("grpc.code", code.String()),
            zap.Duration("grpc.duration", duration),
        )

        if err != nil {
            fields = append(fields, zap.Error(err))
        }

        if cfg.LogResponseBody && resp != nil && err == nil {
            fields = append(fields, zap.Any("response", resp))
        }

        // Log at appropriate level
        msg := "gRPC call"
        switch {
        case err != nil && code != codes.OK:
            cfg.Logger.Error(msg, fields...)
        case duration > cfg.SlowThreshold:
            fields = append(fields, zap.Bool("slow", true))
            cfg.Logger.Warn(msg+" [SLOW]", fields...)
        default:
            cfg.Logger.Info(msg, fields...)
        }

        return resp, err
    }
}

// StreamServerLogging returns a stream server interceptor that logs calls.
func StreamServerLogging(cfg LoggingConfig) grpc.StreamServerInterceptor {
    skipSet := make(map[string]bool, len(cfg.SkipPaths))
    for _, p := range cfg.SkipPaths {
        skipSet[p] = true
    }

    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        if skipSet[info.FullMethod] {
            return handler(srv, ss)
        }

        start := time.Now()
        service := path.Dir(info.FullMethod)[1:]
        method := path.Base(info.FullMethod)

        fields := extractLogFields(ss.Context(), service, method)
        fields = append(fields,
            zap.Bool("grpc.is_client_stream", info.IsClientStream),
            zap.Bool("grpc.is_server_stream", info.IsServerStream),
        )

        cfg.Logger.Info("gRPC stream started", fields...)

        // Wrap the stream to count messages
        wrapped := &wrappedStream{
            ServerStream: ss,
            msgSent:      0,
            msgReceived:  0,
        }

        err := handler(srv, wrapped)
        duration := time.Since(start)
        code := status.Code(err)

        fields = append(fields,
            zap.String("grpc.code", code.String()),
            zap.Duration("grpc.duration", duration),
            zap.Int("grpc.msgs_sent", wrapped.msgSent),
            zap.Int("grpc.msgs_received", wrapped.msgReceived),
        )

        if err != nil {
            fields = append(fields, zap.Error(err))
            cfg.Logger.Error("gRPC stream finished", fields...)
        } else {
            cfg.Logger.Info("gRPC stream finished", fields...)
        }

        return err
    }
}

type wrappedStream struct {
    grpc.ServerStream
    msgSent     int
    msgReceived int
}

func (w *wrappedStream) SendMsg(m interface{}) error {
    err := w.ServerStream.SendMsg(m)
    if err == nil {
        w.msgSent++
    }
    return err
}

func (w *wrappedStream) RecvMsg(m interface{}) error {
    err := w.ServerStream.RecvMsg(m)
    if err == nil {
        w.msgReceived++
    }
    return err
}

func extractLogFields(ctx context.Context, service, method string) []zap.Field {
    fields := []zap.Field{
        zap.String("grpc.service", service),
        zap.String("grpc.method", method),
    }

    // Extract peer address
    if p, ok := peer.FromContext(ctx); ok {
        fields = append(fields, zap.String("grpc.peer", p.Addr.String()))
    }

    // Extract request ID from metadata
    if md, ok := metadata.FromIncomingContext(ctx); ok {
        if vals := md.Get("x-request-id"); len(vals) > 0 {
            fields = append(fields, zap.String("request_id", vals[0]))
        }
        if vals := md.Get("x-b3-traceid"); len(vals) > 0 {
            fields = append(fields, zap.String("trace_id", vals[0]))
        }
    }

    return fields
}
```

## Section 3: OpenTelemetry Tracing Interceptor

### Custom Tracing with Span Enrichment

```go
// interceptors/tracing.go
package interceptors

import (
    "context"
    "path"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/propagation"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
    grpccodes "google.golang.org/grpc/codes"
    grpcstatus "google.golang.org/grpc/status"
)

const tracerName = "grpc-service/interceptors"

// metadataCarrier implements TextMapCarrier for gRPC metadata.
type metadataCarrier struct {
    md *metadata.MD
}

func (c metadataCarrier) Get(key string) string {
    vals := c.md.Get(key)
    if len(vals) == 0 {
        return ""
    }
    return vals[0]
}

func (c metadataCarrier) Set(key, value string) {
    c.md.Set(key, value)
}

func (c metadataCarrier) Keys() []string {
    keys := make([]string, 0, len(*c.md))
    for k := range *c.md {
        keys = append(keys, k)
    }
    return keys
}

// UnaryServerTracing returns a server interceptor that creates spans for each call.
func UnaryServerTracing(tracer trace.Tracer) grpc.UnaryServerInterceptor {
    if tracer == nil {
        tracer = otel.Tracer(tracerName)
    }
    propagator := otel.GetTextMapPropagator()

    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        service := path.Dir(info.FullMethod)[1:]
        method := path.Base(info.FullMethod)

        // Extract trace context from incoming metadata
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            md = metadata.New(nil)
        }
        ctx = propagator.Extract(ctx, metadataCarrier{md: &md})

        // Start server span
        spanName := info.FullMethod
        ctx, span := tracer.Start(ctx, spanName,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                semconv.RPCSystemGRPC,
                semconv.RPCService(service),
                semconv.RPCMethod(method),
            ),
        )
        defer span.End()

        // Add peer information
        if p, ok := extractPeerFromContext(ctx); ok {
            span.SetAttributes(attribute.String("peer.address", p))
        }

        // Execute handler
        resp, err := handler(ctx, req)

        // Record outcome
        grpcCode := grpccodes.OK
        if err != nil {
            grpcCode = grpcstatus.Code(err)
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
        } else {
            span.SetStatus(codes.Ok, "")
        }
        span.SetAttributes(semconv.RPCGRPCStatusCodeKey.Int(int(grpcCode)))

        return resp, err
    }
}

// UnaryClientTracing returns a client interceptor that propagates trace context.
func UnaryClientTracing(tracer trace.Tracer) grpc.UnaryClientInterceptor {
    if tracer == nil {
        tracer = otel.Tracer(tracerName)
    }
    propagator := otel.GetTextMapPropagator()

    return func(
        ctx context.Context,
        method string,
        req, reply interface{},
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        service := path.Dir(method)[1:]
        methodName := path.Base(method)

        // Start client span
        ctx, span := tracer.Start(ctx, method,
            trace.WithSpanKind(trace.SpanKindClient),
            trace.WithAttributes(
                semconv.RPCSystemGRPC,
                semconv.RPCService(service),
                semconv.RPCMethod(methodName),
            ),
        )
        defer span.End()

        // Inject trace context into outgoing metadata
        md, ok := metadata.FromOutgoingContext(ctx)
        if !ok {
            md = metadata.New(nil)
        }
        propagator.Inject(ctx, metadataCarrier{md: &md})
        ctx = metadata.NewOutgoingContext(ctx, md)

        // Execute the call
        err := invoker(ctx, method, req, reply, cc, opts...)

        grpcCode := grpccodes.OK
        if err != nil {
            grpcCode = grpcstatus.Code(err)
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
        }
        span.SetAttributes(semconv.RPCGRPCStatusCodeKey.Int(int(grpcCode)))

        return err
    }
}

// StreamServerTracing returns a stream server interceptor with tracing.
func StreamServerTracing(tracer trace.Tracer) grpc.StreamServerInterceptor {
    if tracer == nil {
        tracer = otel.Tracer(tracerName)
    }
    propagator := otel.GetTextMapPropagator()

    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        ctx := ss.Context()
        service := path.Dir(info.FullMethod)[1:]
        method := path.Base(info.FullMethod)

        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            md = metadata.New(nil)
        }
        ctx = propagator.Extract(ctx, metadataCarrier{md: &md})

        ctx, span := tracer.Start(ctx, info.FullMethod,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                semconv.RPCSystemGRPC,
                semconv.RPCService(service),
                semconv.RPCMethod(method),
                attribute.Bool("grpc.is_server_stream", info.IsServerStream),
                attribute.Bool("grpc.is_client_stream", info.IsClientStream),
            ),
        )
        defer span.End()

        wrapped := &tracedStream{ServerStream: ss, ctx: ctx}
        err := handler(srv, wrapped)

        if err != nil {
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
            grpcCode := grpcstatus.Code(err)
            span.SetAttributes(semconv.RPCGRPCStatusCodeKey.Int(int(grpcCode)))
        } else {
            span.SetStatus(codes.Ok, "")
        }

        return err
    }
}

type tracedStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (s *tracedStream) Context() context.Context {
    return s.ctx
}

func extractPeerFromContext(ctx context.Context) (string, bool) {
    // This is a simplified version; in production you'd use peer.FromContext
    return "", false
}
```

## Section 4: JWT Authentication Interceptor

### JWT Validation with JWKS Support

```go
// interceptors/auth.go
package interceptors

import (
    "context"
    "crypto/rsa"
    "encoding/json"
    "fmt"
    "net/http"
    "strings"
    "sync"
    "time"

    "github.com/golang-jwt/jwt/v5"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// contextKey is an unexported type for context keys in this package.
type contextKey int

const (
    claimsKey contextKey = iota
    principalKey
)

// Claims represents JWT claims for the service.
type Claims struct {
    jwt.RegisteredClaims
    UserID   string   `json:"uid"`
    Email    string   `json:"email"`
    Roles    []string `json:"roles"`
    TenantID string   `json:"tid"`
}

// JWTConfig holds JWT validation configuration.
type JWTConfig struct {
    // JWKS endpoint for key rotation
    JWKSURL string
    // Static public key (alternative to JWKS)
    PublicKey *rsa.PublicKey
    // Expected issuer
    Issuer string
    // Expected audience
    Audience string
    // Methods that bypass authentication
    PublicMethods []string
    // Refresh JWKS keys every interval
    KeyRefreshInterval time.Duration
}

// JWKSCache caches JWKS keys with TTL.
type JWKSCache struct {
    mu          sync.RWMutex
    keys        map[string]*rsa.PublicKey
    lastFetched time.Time
    ttl         time.Duration
    url         string
}

// NewJWKSCache creates a new JWKS key cache.
func NewJWKSCache(url string, ttl time.Duration) *JWKSCache {
    return &JWKSCache{
        keys: make(map[string]*rsa.PublicKey),
        ttl:  ttl,
        url:  url,
    }
}

// GetKey returns a public key by kid, refreshing if necessary.
func (c *JWKSCache) GetKey(kid string) (*rsa.PublicKey, error) {
    c.mu.RLock()
    if key, ok := c.keys[kid]; ok && time.Since(c.lastFetched) < c.ttl {
        c.mu.RUnlock()
        return key, nil
    }
    c.mu.RUnlock()

    // Refresh keys
    if err := c.refresh(); err != nil {
        return nil, fmt.Errorf("failed to refresh JWKS: %w", err)
    }

    c.mu.RLock()
    defer c.mu.RUnlock()
    key, ok := c.keys[kid]
    if !ok {
        return nil, fmt.Errorf("key ID %q not found in JWKS", kid)
    }
    return key, nil
}

func (c *JWKSCache) refresh() error {
    c.mu.Lock()
    defer c.mu.Unlock()

    resp, err := http.Get(c.url) //nolint:gosec // URL is from trusted config
    if err != nil {
        return fmt.Errorf("JWKS request failed: %w", err)
    }
    defer resp.Body.Close()

    var jwks struct {
        Keys []struct {
            Kid string `json:"kid"`
            Kty string `json:"kty"`
            N   string `json:"n"`
            E   string `json:"e"`
        } `json:"keys"`
    }

    if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
        return fmt.Errorf("failed to decode JWKS: %w", err)
    }

    newKeys := make(map[string]*rsa.PublicKey)
    for _, k := range jwks.Keys {
        if k.Kty != "RSA" {
            continue
        }
        pubKey, err := parseRSAPublicKeyFromJWK(k.N, k.E)
        if err != nil {
            continue
        }
        newKeys[k.Kid] = pubKey
    }

    c.keys = newKeys
    c.lastFetched = time.Now()
    return nil
}

// UnaryServerJWT returns a JWT authentication interceptor.
func UnaryServerJWT(cfg JWTConfig, cache *JWKSCache) grpc.UnaryServerInterceptor {
    publicSet := make(map[string]bool)
    for _, m := range cfg.PublicMethods {
        publicSet[m] = true
    }

    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        // Skip authentication for public methods
        if publicSet[info.FullMethod] {
            return handler(ctx, req)
        }

        claims, err := validateJWT(ctx, cfg, cache)
        if err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "authentication failed: %v", err)
        }

        // Inject claims into context
        ctx = context.WithValue(ctx, claimsKey, claims)
        ctx = context.WithValue(ctx, principalKey, claims.UserID)

        return handler(ctx, req)
    }
}

// StreamServerJWT returns a JWT authentication interceptor for streams.
func StreamServerJWT(cfg JWTConfig, cache *JWKSCache) grpc.StreamServerInterceptor {
    publicSet := make(map[string]bool)
    for _, m := range cfg.PublicMethods {
        publicSet[m] = true
    }

    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        if publicSet[info.FullMethod] {
            return handler(srv, ss)
        }

        claims, err := validateJWT(ss.Context(), cfg, cache)
        if err != nil {
            return status.Errorf(codes.Unauthenticated, "authentication failed: %v", err)
        }

        wrapped := &authenticatedStream{
            ServerStream: ss,
            ctx:          context.WithValue(ss.Context(), claimsKey, claims),
        }

        return handler(srv, wrapped)
    }
}

type authenticatedStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (s *authenticatedStream) Context() context.Context {
    return s.ctx
}

func validateJWT(ctx context.Context, cfg JWTConfig, cache *JWKSCache) (*Claims, error) {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return nil, fmt.Errorf("no metadata in context")
    }

    authHeader := md.Get("authorization")
    if len(authHeader) == 0 {
        return nil, fmt.Errorf("missing authorization header")
    }

    tokenStr := strings.TrimPrefix(authHeader[0], "Bearer ")
    if tokenStr == authHeader[0] {
        return nil, fmt.Errorf("authorization header must use Bearer scheme")
    }

    claims := &Claims{}
    token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
        if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
        }

        kid, ok := t.Header["kid"].(string)
        if !ok || kid == "" {
            // Fall back to static key
            if cfg.PublicKey != nil {
                return cfg.PublicKey, nil
            }
            return nil, fmt.Errorf("missing key ID in token header")
        }

        if cache != nil {
            return cache.GetKey(kid)
        }
        return cfg.PublicKey, nil
    })

    if err != nil {
        return nil, fmt.Errorf("invalid token: %w", err)
    }

    if !token.Valid {
        return nil, fmt.Errorf("token is not valid")
    }

    if cfg.Issuer != "" && claims.Issuer != cfg.Issuer {
        return nil, fmt.Errorf("invalid issuer: expected %q, got %q", cfg.Issuer, claims.Issuer)
    }

    return claims, nil
}

// GetClaimsFromContext extracts JWT claims from context.
func GetClaimsFromContext(ctx context.Context) (*Claims, bool) {
    claims, ok := ctx.Value(claimsKey).(*Claims)
    return claims, ok
}

// GetPrincipalFromContext extracts the user ID from context.
func GetPrincipalFromContext(ctx context.Context) (string, bool) {
    principal, ok := ctx.Value(principalKey).(string)
    return principal, ok
}

// parseRSAPublicKeyFromJWK parses an RSA public key from JWK components.
// In production, use a proper JWK parsing library.
func parseRSAPublicKeyFromJWK(n, e string) (*rsa.PublicKey, error) {
    // Implementation uses encoding/base64 and math/big in production
    return nil, fmt.Errorf("implement JWK RSA parsing")
}
```

## Section 5: mTLS Authentication Interceptor

```go
// interceptors/mtls.go
package interceptors

import (
    "context"
    "crypto/tls"
    "crypto/x509"
    "fmt"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/credentials"
    "google.golang.org/grpc/peer"
    "google.golang.org/grpc/status"
)

// MTLSConfig holds mTLS configuration.
type MTLSConfig struct {
    // Require client certificates
    RequireClientCert bool
    // Allowed client certificate SANs (empty = allow all)
    AllowedSANs []string
    // Allowed client certificate organizations (empty = allow all)
    AllowedOrgs []string
}

// UnaryServerMTLS validates mTLS client certificates.
func UnaryServerMTLS(cfg MTLSConfig) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        if err := validateClientCert(ctx, cfg); err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "mTLS validation failed: %v", err)
        }
        return handler(ctx, req)
    }
}

func validateClientCert(ctx context.Context, cfg MTLSConfig) error {
    p, ok := peer.FromContext(ctx)
    if !ok {
        if cfg.RequireClientCert {
            return fmt.Errorf("no peer information in context")
        }
        return nil
    }

    tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
    if !ok {
        if cfg.RequireClientCert {
            return fmt.Errorf("connection is not TLS")
        }
        return nil
    }

    if tlsInfo.State.HandshakeComplete {
        if len(tlsInfo.State.PeerCertificates) == 0 {
            if cfg.RequireClientCert {
                return fmt.Errorf("no client certificate presented")
            }
            return nil
        }
    }

    cert := tlsInfo.State.PeerCertificates[0]
    return validateCertAttributes(cert, cfg)
}

func validateCertAttributes(cert *x509.Certificate, cfg MTLSConfig) error {
    // Validate SANs
    if len(cfg.AllowedSANs) > 0 {
        allowed := false
        for _, san := range cfg.AllowedSANs {
            for _, dns := range cert.DNSNames {
                if dns == san {
                    allowed = true
                    break
                }
            }
        }
        if !allowed {
            return fmt.Errorf("client certificate SAN not in allowed list: %v", cert.DNSNames)
        }
    }

    // Validate organizations
    if len(cfg.AllowedOrgs) > 0 {
        allowed := false
        for _, allowedOrg := range cfg.AllowedOrgs {
            for _, org := range cert.Subject.Organization {
                if org == allowedOrg {
                    allowed = true
                    break
                }
            }
        }
        if !allowed {
            return fmt.Errorf("client certificate organization not allowed: %v", cert.Subject.Organization)
        }
    }

    return nil
}

// NewMTLSServerCredentials creates TLS credentials requiring client certificates.
func NewMTLSServerCredentials(certFile, keyFile, caFile string) (credentials.TransportCredentials, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("failed to load server certificate: %w", err)
    }

    caPool := x509.NewCertPool()
    // In production, load CA cert from caFile
    _ = caFile

    tlsCfg := &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientAuth:   tls.RequireAndVerifyClientCert,
        ClientCAs:    caPool,
        MinVersion:   tls.VersionTLS13,
        CipherSuites: []uint16{
            tls.TLS_AES_128_GCM_SHA256,
            tls.TLS_AES_256_GCM_SHA384,
            tls.TLS_CHACHA20_POLY1305_SHA256,
        },
    }

    return credentials.NewTLS(tlsCfg), nil
}
```

## Section 6: Rate Limiting Interceptor

```go
// interceptors/ratelimit.go
package interceptors

import (
    "context"
    "fmt"
    "sync"
    "time"

    "golang.org/x/time/rate"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// RateLimitConfig configures rate limiting behavior.
type RateLimitConfig struct {
    // Global rate limit (requests per second)
    GlobalRPS float64
    // Global burst size
    GlobalBurst int
    // Per-client rate limit (keyed by IP or user ID)
    PerClientRPS float64
    // Per-client burst size
    PerClientBurst int
    // Header to extract client ID from
    ClientIDHeader string
    // Methods exempt from rate limiting
    ExemptMethods []string
    // TTL for per-client limiters
    ClientLimiterTTL time.Duration
}

type clientLimiter struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

// RateLimiter manages global and per-client rate limiters.
type RateLimiter struct {
    cfg           RateLimitConfig
    globalLimiter *rate.Limiter
    clients       map[string]*clientLimiter
    mu            sync.Mutex
    cleanupTicker *time.Ticker
    stopCleanup   chan struct{}
}

// NewRateLimiter creates and starts a new RateLimiter.
func NewRateLimiter(cfg RateLimitConfig) *RateLimiter {
    rl := &RateLimiter{
        cfg:           cfg,
        globalLimiter: rate.NewLimiter(rate.Limit(cfg.GlobalRPS), cfg.GlobalBurst),
        clients:       make(map[string]*clientLimiter),
        cleanupTicker: time.NewTicker(cfg.ClientLimiterTTL),
        stopCleanup:   make(chan struct{}),
    }

    go rl.cleanupExpired()
    return rl
}

// Stop stops the cleanup goroutine.
func (rl *RateLimiter) Stop() {
    rl.cleanupTicker.Stop()
    close(rl.stopCleanup)
}

func (rl *RateLimiter) cleanupExpired() {
    for {
        select {
        case <-rl.cleanupTicker.C:
            rl.mu.Lock()
            for id, cl := range rl.clients {
                if time.Since(cl.lastSeen) > rl.cfg.ClientLimiterTTL {
                    delete(rl.clients, id)
                }
            }
            rl.mu.Unlock()
        case <-rl.stopCleanup:
            return
        }
    }
}

func (rl *RateLimiter) getClientLimiter(clientID string) *rate.Limiter {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    cl, exists := rl.clients[clientID]
    if !exists {
        cl = &clientLimiter{
            limiter: rate.NewLimiter(
                rate.Limit(rl.cfg.PerClientRPS),
                rl.cfg.PerClientBurst,
            ),
        }
        rl.clients[clientID] = cl
    }
    cl.lastSeen = time.Now()
    return cl.limiter
}

func (rl *RateLimiter) Allow(clientID string) error {
    // Check global limit
    if !rl.globalLimiter.Allow() {
        return fmt.Errorf("global rate limit exceeded")
    }

    // Check per-client limit
    if clientID != "" && rl.cfg.PerClientRPS > 0 {
        limiter := rl.getClientLimiter(clientID)
        if !limiter.Allow() {
            return fmt.Errorf("per-client rate limit exceeded for %q", clientID)
        }
    }

    return nil
}

// UnaryServerRateLimit returns a rate limiting interceptor for unary calls.
func UnaryServerRateLimit(rl *RateLimiter) grpc.UnaryServerInterceptor {
    exemptSet := make(map[string]bool)
    for _, m := range rl.cfg.ExemptMethods {
        exemptSet[m] = true
    }

    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        if exemptSet[info.FullMethod] {
            return handler(ctx, req)
        }

        clientID := extractClientID(ctx, rl.cfg.ClientIDHeader)
        if err := rl.Allow(clientID); err != nil {
            return nil, status.Errorf(codes.ResourceExhausted,
                "rate limit exceeded: %v", err)
        }

        return handler(ctx, req)
    }
}

// StreamServerRateLimit returns a rate limiting interceptor for streams.
func StreamServerRateLimit(rl *RateLimiter) grpc.StreamServerInterceptor {
    exemptSet := make(map[string]bool)
    for _, m := range rl.cfg.ExemptMethods {
        exemptSet[m] = true
    }

    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        if exemptSet[info.FullMethod] {
            return handler(srv, ss)
        }

        clientID := extractClientID(ss.Context(), rl.cfg.ClientIDHeader)
        if err := rl.Allow(clientID); err != nil {
            return status.Errorf(codes.ResourceExhausted,
                "rate limit exceeded: %v", err)
        }

        return handler(srv, ss)
    }
}

func extractClientID(ctx context.Context, header string) string {
    // Try JWT claims first
    if claims, ok := GetClaimsFromContext(ctx); ok {
        return claims.UserID
    }

    // Fall back to metadata header
    if header != "" {
        if md, ok := metadata.FromIncomingContext(ctx); ok {
            if vals := md.Get(header); len(vals) > 0 {
                return vals[0]
            }
        }
    }

    // Fall back to peer address
    return ""
}
```

## Section 7: Panic Recovery Interceptor

```go
// interceptors/recovery.go
package interceptors

import (
    "context"
    "fmt"
    "runtime/debug"

    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// RecoveryConfig configures panic recovery behavior.
type RecoveryConfig struct {
    Logger       *zap.Logger
    // Custom handler for panics, returns the error to send to client
    PanicHandler func(p interface{}) error
    // Whether to include stack trace in logs
    LogStackTrace bool
}

// UnaryServerRecovery returns a panic recovery interceptor for unary calls.
func UnaryServerRecovery(cfg RecoveryConfig) grpc.UnaryServerInterceptor {
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
                err = handlePanic(p, info.FullMethod, cfg)
            }
        }()

        resp, err = handler(ctx, req)
        panicked = false
        return resp, err
    }
}

// StreamServerRecovery returns a panic recovery interceptor for streams.
func StreamServerRecovery(cfg RecoveryConfig) grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) (err error) {
        panicked := true
        defer func() {
            if panicked {
                p := recover()
                err = handlePanic(p, info.FullMethod, cfg)
            }
        }()

        err = handler(srv, ss)
        panicked = false
        return err
    }
}

func handlePanic(p interface{}, method string, cfg RecoveryConfig) error {
    if p == nil {
        return nil
    }

    stack := debug.Stack()

    if cfg.Logger != nil {
        fields := []zap.Field{
            zap.Any("panic", p),
            zap.String("grpc.method", method),
        }
        if cfg.LogStackTrace {
            fields = append(fields, zap.ByteString("stack_trace", stack))
        }
        cfg.Logger.Error("gRPC panic recovered", fields...)
    }

    if cfg.PanicHandler != nil {
        return cfg.PanicHandler(p)
    }

    return status.Errorf(codes.Internal,
        "internal server error (panic): %v", fmt.Sprintf("%v", p))
}
```

## Section 8: Interceptor Chain Assembly

### Using go-grpc-middleware v2

```go
// interceptors/chain.go
package interceptors

import (
    "crypto/tls"

    "go.opentelemetry.io/otel/trace"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials"
)

// ServerOptions builds production-ready gRPC server options.
func ServerOptions(
    logger *zap.Logger,
    tracer trace.Tracer,
    jwtCache *JWKSCache,
    rateLimiter *RateLimiter,
) []grpc.ServerOption {
    // JWT config
    jwtCfg := JWTConfig{
        Issuer:   "https://auth.yourdomain.com",
        Audience: "grpc-service",
        PublicMethods: []string{
            "/grpc.health.v1.Health/Check",
            "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
        },
        KeyRefreshInterval: 300,
    }

    // Logging config
    logCfg := NewLoggingConfig(logger)
    logCfg.SlowThreshold = 500
    logCfg.SkipPaths = []string{
        "/grpc.health.v1.Health/Check",
    }

    // Recovery config
    recoveryCfg := RecoveryConfig{
        Logger:        logger,
        LogStackTrace: true,
        PanicHandler: func(p interface{}) error {
            return nil // returns codes.Internal automatically
        },
    }

    // Unary interceptor chain (order matters: first in, last out)
    unaryInterceptors := []grpc.UnaryServerInterceptor{
        // 1. Recovery must be outermost to catch panics in other interceptors
        UnaryServerRecovery(recoveryCfg),
        // 2. Tracing for distributed trace context
        UnaryServerTracing(tracer),
        // 3. Logging to capture all calls with trace IDs
        UnaryServerLogging(logCfg),
        // 4. Rate limiting before expensive auth
        UnaryServerRateLimit(rateLimiter),
        // 5. Authentication last (close to business logic)
        UnaryServerJWT(jwtCfg, jwtCache),
    }

    // Stream interceptor chain
    streamInterceptors := []grpc.StreamServerInterceptor{
        StreamServerRecovery(recoveryCfg),
        StreamServerTracing(tracer),
        StreamServerLogging(logCfg),
        StreamServerRateLimit(rateLimiter),
        StreamServerJWT(jwtCfg, jwtCache),
    }

    return []grpc.ServerOption{
        grpc.ChainUnaryInterceptor(unaryInterceptors...),
        grpc.ChainStreamInterceptor(streamInterceptors...),
        grpc.MaxRecvMsgSize(16 * 1024 * 1024), // 16MB
        grpc.MaxSendMsgSize(16 * 1024 * 1024), // 16MB
    }
}

// ClientOptions builds production-ready gRPC client options.
func ClientOptions(tracer trace.Tracer, tlsConfig *tls.Config) []grpc.DialOption {
    unaryInterceptors := []grpc.UnaryClientInterceptor{
        UnaryClientTracing(tracer),
        UnaryClientLogging(),
    }

    streamInterceptors := []grpc.StreamClientInterceptor{
        StreamClientTracing(tracer),
    }

    opts := []grpc.DialOption{
        grpc.WithChainUnaryInterceptor(unaryInterceptors...),
        grpc.WithChainStreamInterceptor(streamInterceptors...),
    }

    if tlsConfig != nil {
        opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)))
    }

    return opts
}

// UnaryClientLogging is a minimal client-side unary logging interceptor.
func UnaryClientLogging() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply interface{},
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // Client logging is typically handled by the server-side interceptors
        // Add client-specific logging here if needed
        return invoker(ctx, method, req, reply, cc, opts...)
    }
}

// StreamClientTracing returns a stream client interceptor with tracing.
func StreamClientTracing(tracer trace.Tracer) grpc.StreamClientInterceptor {
    return func(
        ctx context.Context,
        desc *grpc.StreamDesc,
        cc *grpc.ClientConn,
        method string,
        streamer grpc.Streamer,
        opts ...grpc.CallOption,
    ) (grpc.ClientStream, error) {
        return streamer(ctx, desc, cc, method, opts...)
    }
}
```

## Section 9: Complete Server Bootstrap

```go
// cmd/server/main.go
package main

import (
    "context"
    "fmt"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/reflection"

    "github.com/yourorg/grpc-service/interceptors"
)

func main() {
    // Initialize logger
    logCfg := zap.NewProductionConfig()
    logCfg.Level = zap.NewAtomicLevelAt(zapcore.InfoLevel)
    logger, err := logCfg.Build()
    if err != nil {
        panic(fmt.Sprintf("failed to build logger: %v", err))
    }
    defer logger.Sync() //nolint:errcheck

    // Initialize OpenTelemetry tracer
    ctx := context.Background()
    tp, err := initTracer(ctx)
    if err != nil {
        logger.Fatal("failed to initialize tracer", zap.Error(err))
    }
    defer func() {
        ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
        defer cancel()
        if err := tp.Shutdown(ctx); err != nil {
            logger.Error("tracer shutdown error", zap.Error(err))
        }
    }()

    tracer := otel.Tracer("grpc-service")

    // Initialize JWKS cache
    jwksCache := interceptors.NewJWKSCache(
        "https://auth.yourdomain.com/.well-known/jwks.json",
        5*time.Minute,
    )

    // Initialize rate limiter
    rateLimiter := interceptors.NewRateLimiter(interceptors.RateLimitConfig{
        GlobalRPS:        1000,
        GlobalBurst:      2000,
        PerClientRPS:     50,
        PerClientBurst:   100,
        ClientIDHeader:   "x-client-id",
        ClientLimiterTTL: 10 * time.Minute,
    })
    defer rateLimiter.Stop()

    // Build server options
    serverOpts := interceptors.ServerOptions(logger, tracer, jwksCache, rateLimiter)

    // Create gRPC server
    srv := grpc.NewServer(serverOpts...)

    // Register services
    // examplepb.RegisterExampleServiceServer(srv, &service.ExampleService{})
    healthSrv := health.NewServer()
    grpc_health_v1.RegisterHealthServer(srv, healthSrv)
    reflection.Register(srv)

    // Mark service as healthy
    healthSrv.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)

    // Start listener
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        logger.Fatal("failed to listen", zap.Error(err))
    }

    // Graceful shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        sig := <-sigCh
        logger.Info("received signal, shutting down", zap.String("signal", sig.String()))
        healthSrv.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)

        // Allow in-flight requests to complete
        gracePeriod := 30 * time.Second
        shutdownCh := make(chan struct{})
        go func() {
            srv.GracefulStop()
            close(shutdownCh)
        }()

        select {
        case <-shutdownCh:
            logger.Info("server stopped gracefully")
        case <-time.After(gracePeriod):
            logger.Warn("grace period expired, forcing shutdown")
            srv.Stop()
        }
    }()

    logger.Info("gRPC server starting", zap.String("addr", lis.Addr().String()))
    if err := srv.Serve(lis); err != nil {
        logger.Error("server stopped", zap.Error(err))
    }
}

func initTracer(ctx context.Context) (*sdktrace.TracerProvider, error) {
    otlpEndpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if otlpEndpoint == "" {
        otlpEndpoint = "localhost:4317"
    }

    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithInsecure(),
        otlptracegrpc.WithEndpoint(otlpEndpoint),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create OTLP exporter: %w", err)
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName("grpc-service"),
            semconv.ServiceVersion("1.0.0"),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create resource: %w", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1))),
    )
    otel.SetTracerProvider(tp)
    return tp, nil
}
```

## Section 10: Testing Interceptors

### Unit Testing Interceptors

```go
// interceptors/logging_test.go
package interceptors_test

import (
    "context"
    "testing"

    "go.uber.org/zap"
    "go.uber.org/zap/zaptest"
    "google.golang.org/grpc"

    "github.com/yourorg/grpc-service/interceptors"
)

func TestUnaryServerLogging(t *testing.T) {
    logger := zaptest.NewLogger(t)
    cfg := interceptors.NewLoggingConfig(logger)

    interceptor := interceptors.UnaryServerLogging(cfg)

    info := &grpc.UnaryServerInfo{
        FullMethod: "/example.v1.ExampleService/GetExample",
    }

    called := false
    handler := func(ctx context.Context, req interface{}) (interface{}, error) {
        called = true
        return "response", nil
    }

    resp, err := interceptor(context.Background(), "request", info, handler)

    if !called {
        t.Fatal("handler was not called")
    }
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if resp != "response" {
        t.Fatalf("unexpected response: %v", resp)
    }
}

func TestUnaryServerRateLimit(t *testing.T) {
    rl := interceptors.NewRateLimiter(interceptors.RateLimitConfig{
        GlobalRPS:        2,
        GlobalBurst:      2,
        ClientLimiterTTL: 60,
    })
    defer rl.Stop()

    interceptor := interceptors.UnaryServerRateLimit(rl)
    info := &grpc.UnaryServerInfo{
        FullMethod: "/example.v1.ExampleService/GetExample",
    }

    handler := func(ctx context.Context, req interface{}) (interface{}, error) {
        return nil, nil
    }

    // First 2 calls should succeed (burst=2)
    for i := 0; i < 2; i++ {
        _, err := interceptor(context.Background(), nil, info, handler)
        if err != nil {
            t.Fatalf("call %d failed unexpectedly: %v", i+1, err)
        }
    }

    // Third call should be rate limited
    _, err := interceptor(context.Background(), nil, info, handler)
    if err == nil {
        t.Fatal("expected rate limit error but got none")
    }
}

// TestRecovery verifies that panics are recovered.
func TestUnaryServerRecovery(t *testing.T) {
    logger := zap.NewNop()
    cfg := interceptors.RecoveryConfig{
        Logger:        logger,
        LogStackTrace: false,
    }

    interceptor := interceptors.UnaryServerRecovery(cfg)
    info := &grpc.UnaryServerInfo{
        FullMethod: "/example.v1.ExampleService/GetExample",
    }

    panicHandler := func(ctx context.Context, req interface{}) (interface{}, error) {
        panic("test panic")
    }

    _, err := interceptor(context.Background(), nil, info, panicHandler)
    if err == nil {
        t.Fatal("expected error from panic recovery but got nil")
    }
}
```

### Integration Test with Mock gRPC Server

```go
// interceptors/integration_test.go
package interceptors_test

import (
    "context"
    "net"
    "testing"

    "go.uber.org/zap/zaptest"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/health"
    healthpb "google.golang.org/grpc/health/grpc_health_v1"

    "github.com/yourorg/grpc-service/interceptors"
)

func TestInterceptorChainIntegration(t *testing.T) {
    logger := zaptest.NewLogger(t)
    rateLimiter := interceptors.NewRateLimiter(interceptors.RateLimitConfig{
        GlobalRPS:        100,
        GlobalBurst:      200,
        ClientLimiterTTL: 60,
    })
    defer rateLimiter.Stop()

    logCfg := interceptors.NewLoggingConfig(logger)
    recoveryCfg := interceptors.RecoveryConfig{Logger: logger}

    srv := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            interceptors.UnaryServerRecovery(recoveryCfg),
            interceptors.UnaryServerLogging(logCfg),
            interceptors.UnaryServerRateLimit(rateLimiter),
        ),
    )

    healthSrv := health.NewServer()
    healthpb.RegisterHealthServer(srv, healthSrv)
    healthSrv.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

    lis, err := net.Listen("tcp", "127.0.0.1:0")
    if err != nil {
        t.Fatalf("failed to listen: %v", err)
    }

    go srv.Serve(lis) //nolint:errcheck
    defer srv.Stop()

    conn, err := grpc.Dial(lis.Addr().String(),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        t.Fatalf("failed to dial: %v", err)
    }
    defer conn.Close()

    client := healthpb.NewHealthClient(conn)
    resp, err := client.Check(context.Background(), &healthpb.HealthCheckRequest{})
    if err != nil {
        t.Fatalf("health check failed: %v", err)
    }
    if resp.Status != healthpb.HealthCheckResponse_SERVING {
        t.Fatalf("unexpected health status: %v", resp.Status)
    }
}
```

## Section 11: Prometheus Metrics for Interceptors

```go
// interceptors/metrics.go
package interceptors

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "google.golang.org/grpc"
    grpccodes "google.golang.org/grpc/codes"
    grpcstatus "google.golang.org/grpc/status"
)

var (
    grpcRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "grpc_server_requests_total",
            Help: "Total number of gRPC requests by method and status code.",
        },
        []string{"grpc_service", "grpc_method", "grpc_code"},
    )

    grpcRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "grpc_server_request_duration_seconds",
            Help:    "Duration of gRPC requests in seconds.",
            Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
        },
        []string{"grpc_service", "grpc_method"},
    )

    grpcActiveRequests = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "grpc_server_active_requests",
            Help: "Number of currently active gRPC requests.",
        },
        []string{"grpc_service", "grpc_method"},
    )

    grpcPanicsTotal = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "grpc_server_panics_total",
            Help: "Total number of gRPC panics recovered.",
        },
    )
)

// UnaryServerMetrics returns a Prometheus metrics interceptor.
func UnaryServerMetrics() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        service, method := splitMethodName(info.FullMethod)

        grpcActiveRequests.WithLabelValues(service, method).Inc()
        defer grpcActiveRequests.WithLabelValues(service, method).Dec()

        start := time.Now()
        resp, err := handler(ctx, req)
        duration := time.Since(start)

        code := grpccodes.OK
        if err != nil {
            code = grpcstatus.Code(err)
        }

        grpcRequestsTotal.WithLabelValues(service, method, code.String()).Inc()
        grpcRequestDuration.WithLabelValues(service, method).Observe(duration.Seconds())

        return resp, err
    }
}

func splitMethodName(fullMethod string) (string, string) {
    if len(fullMethod) == 0 {
        return "unknown", "unknown"
    }
    // /package.Service/Method -> package.Service, Method
    pos := len(fullMethod) - 1
    for pos >= 0 && fullMethod[pos] != '/' {
        pos--
    }
    if pos < 0 {
        return "unknown", fullMethod
    }
    service := fullMethod[1:pos]
    method := fullMethod[pos+1:]
    return service, method
}
```

This interceptor stack provides a complete production middleware solution. The ordering within the chain is critical: recovery wraps everything, tracing provides context for logging, and authentication gates access to business logic. When combined with proper health checks and graceful shutdown, this pattern supports the operational requirements of enterprise gRPC services.
