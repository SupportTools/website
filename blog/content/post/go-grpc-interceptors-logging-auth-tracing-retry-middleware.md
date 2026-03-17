---
title: "Go gRPC Interceptors: Logging, Auth, Tracing, and Retry as Middleware"
date: 2029-03-24T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Middleware", "OpenTelemetry", "Observability", "Microservices"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production-grade gRPC interceptor chains in Go, covering structured logging, JWT authentication, OpenTelemetry tracing, exponential backoff retry, and panic recovery for both unary and streaming RPCs."
more_link: "yes"
url: "/go-grpc-interceptors-logging-auth-tracing-retry-middleware/"
---

gRPC interceptors are the equivalent of HTTP middleware: functions that wrap every RPC handler with cross-cutting concerns. Authentication, distributed tracing, request logging, rate limiting, and retry logic all belong in interceptors rather than in individual service handlers. This separation keeps business logic clean and ensures consistent behavior across all RPCs.

Go's `google.golang.org/grpc` package provides both unary and streaming interceptor types, and the `grpc.ChainUnaryInterceptor` and `grpc.ChainStreamInterceptor` helpers compose multiple interceptors into a single chain with defined execution order.

<!--more-->

## Module Setup

```bash
go get google.golang.org/grpc@v1.64.0
go get go.opentelemetry.io/otel@v1.27.0
go get go.opentelemetry.io/otel/trace@v1.27.0
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc@v0.52.0
go get github.com/golang-jwt/jwt/v5@v5.2.1
go get go.uber.org/zap@v1.27.0
go get google.golang.org/grpc/codes@v1.64.0
go get google.golang.org/grpc/status@v1.64.0
```

---

## Interceptor Fundamentals

### Unary vs. Streaming

A **unary interceptor** wraps a single request-response RPC:

```go
type UnaryServerInterceptor func(
    ctx context.Context,
    req interface{},
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error)
```

A **stream interceptor** wraps streaming RPCs (server-streaming, client-streaming, bidirectional):

```go
type StreamServerInterceptor func(
    srv interface{},
    ss grpc.ServerStream,
    info *grpc.StreamServerInfo,
    handler grpc.StreamHandler,
) error
```

The client side mirrors these signatures with `UnaryClientInterceptor` and `StreamClientInterceptor`.

### Chaining Interceptors

```go
server := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        PanicRecoveryInterceptor(),
        RequestIDInterceptor(),
        AuthInterceptor(jwtValidator),
        LoggingInterceptor(logger),
        TracingInterceptor(),
        RateLimitInterceptor(limiter),
    ),
    grpc.ChainStreamInterceptor(
        StreamPanicRecoveryInterceptor(),
        StreamAuthInterceptor(jwtValidator),
        StreamLoggingInterceptor(logger),
    ),
)
```

Interceptors execute in order from outermost to innermost on the way in, and in reverse on the way out. Panic recovery must be the outermost interceptor so it catches panics from all downstream interceptors.

---

## Panic Recovery Interceptor

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

// PanicRecoveryInterceptor catches panics, logs a stack trace, and returns an
// INTERNAL error to the caller rather than crashing the server process.
func PanicRecoveryInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (resp interface{}, err error) {
		defer func() {
			if r := recover(); r != nil {
				stack := debug.Stack()
				logger.Error("panic recovered in gRPC handler",
					zap.String("method", info.FullMethod),
					zap.Any("panic", r),
					zap.ByteString("stack", stack),
				)
				err = status.Errorf(codes.Internal,
					"internal server error: %v", r)
			}
		}()
		return handler(ctx, req)
	}
}

// StreamPanicRecoveryInterceptor wraps streaming RPCs with panic recovery.
func StreamPanicRecoveryInterceptor(logger *zap.Logger) grpc.StreamServerInterceptor {
	return func(
		srv interface{},
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) (err error) {
		defer func() {
			if r := recover(); r != nil {
				logger.Error("panic recovered in gRPC stream handler",
					zap.String("method", info.FullMethod),
					zap.Any("panic", r),
					zap.String("stack", fmt.Sprintf("%s", debug.Stack())),
				)
				err = status.Errorf(codes.Internal, "internal server error")
			}
		}()
		return handler(srv, ss)
	}
}
```

---

## Request ID Interceptor

Every RPC should carry a unique request ID for log correlation. The interceptor generates one if the client did not provide it via metadata:

```go
// interceptors/requestid.go
package interceptors

import (
	"context"
	"crypto/rand"
	"encoding/hex"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

type contextKey string

const RequestIDKey contextKey = "request_id"

func RequestIDInterceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		md, ok := metadata.FromIncomingContext(ctx)
		var requestID string
		if ok {
			if ids := md.Get("x-request-id"); len(ids) > 0 {
				requestID = ids[0]
			}
		}
		if requestID == "" {
			b := make([]byte, 8)
			_, _ = rand.Read(b)
			requestID = hex.EncodeToString(b)
		}
		ctx = context.WithValue(ctx, RequestIDKey, requestID)
		// Echo the request ID back to the client in the response header.
		_ = grpc.SetHeader(ctx, metadata.Pairs("x-request-id", requestID))
		return handler(ctx, req)
	}
}

func RequestIDFromContext(ctx context.Context) string {
	if id, ok := ctx.Value(RequestIDKey).(string); ok {
		return id
	}
	return ""
}
```

---

## JWT Authentication Interceptor

```go
// interceptors/auth.go
package interceptors

import (
	"context"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type ClaimsKey struct{}

// JWTValidator holds the key material and parser configuration.
type JWTValidator struct {
	keyFunc      jwt.Keyfunc
	publicRoutes map[string]bool
}

func NewJWTValidator(signingKey []byte, publicRoutes ...string) *JWTValidator {
	routes := make(map[string]bool, len(publicRoutes))
	for _, r := range publicRoutes {
		routes[r] = true
	}
	return &JWTValidator{
		keyFunc: func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, status.Errorf(codes.Unauthenticated,
					"unexpected signing method: %v", t.Header["alg"])
			}
			return signingKey, nil
		},
		publicRoutes: routes,
	}
}

func AuthInterceptor(v *JWTValidator) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		if v.publicRoutes[info.FullMethod] {
			return handler(ctx, req)
		}

		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "missing metadata")
		}

		authHeader := md.Get("authorization")
		if len(authHeader) == 0 {
			return nil, status.Error(codes.Unauthenticated, "missing authorization header")
		}

		tokenStr := strings.TrimPrefix(authHeader[0], "Bearer ")
		claims := jwt.MapClaims{}
		token, err := jwt.ParseWithClaims(tokenStr, claims, v.keyFunc,
			jwt.WithExpirationRequired(),
			jwt.WithIssuedAt(),
		)
		if err != nil || !token.Valid {
			return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
		}

		ctx = context.WithValue(ctx, ClaimsKey{}, claims)
		return handler(ctx, req)
	}
}

func ClaimsFromContext(ctx context.Context) (jwt.MapClaims, bool) {
	claims, ok := ctx.Value(ClaimsKey{}).(jwt.MapClaims)
	return claims, ok
}
```

---

## Structured Logging Interceptor

```go
// interceptors/logging.go
package interceptors

import (
	"context"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

func LoggingInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		start := time.Now()
		requestID := RequestIDFromContext(ctx)

		// Collect peer address.
		peerAddr := "unknown"
		if p, ok := peer.FromContext(ctx); ok {
			peerAddr = p.Addr.String()
		}

		resp, err := handler(ctx, req)

		code := codes.OK
		if err != nil {
			code = status.Code(err)
		}
		duration := time.Since(start)

		fields := []zap.Field{
			zap.String("request_id", requestID),
			zap.String("method", info.FullMethod),
			zap.String("peer", peerAddr),
			zap.String("code", code.String()),
			zap.Duration("duration", duration),
		}
		if err != nil {
			fields = append(fields, zap.Error(err))
		}

		switch {
		case code == codes.OK:
			logger.Info("gRPC request", fields...)
		case isClientError(code):
			logger.Warn("gRPC client error", fields...)
		default:
			logger.Error("gRPC server error", fields...)
		}

		return resp, err
	}
}

func isClientError(code codes.Code) bool {
	switch code {
	case codes.InvalidArgument, codes.NotFound, codes.AlreadyExists,
		codes.PermissionDenied, codes.Unauthenticated, codes.ResourceExhausted,
		codes.FailedPrecondition, codes.Aborted, codes.OutOfRange:
		return true
	}
	return false
}
```

---

## OpenTelemetry Tracing Interceptor

Rather than writing a custom tracing interceptor, use the official `otelgrpc` package which implements the OpenTelemetry gRPC semantic conventions:

```go
// server/main.go
package main

import (
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"google.golang.org/grpc"
)

func initTracer(ctx context.Context, serviceName string) func() {
	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint("otel-collector.observability.svc:4317"),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		panic(err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(serviceName),
			semconv.ServiceVersion("v2.3.1"),
		)),
		sdktrace.WithSampler(sdktrace.ParentBased(
			sdktrace.TraceIDRatioBased(0.1), // 10% sampling
		)),
	)
	otel.SetTracerProvider(tp)
	return func() { _ = tp.Shutdown(context.Background()) }
}

func newGRPCServer(logger *zap.Logger, jwtKey []byte) *grpc.Server {
	validator := NewJWTValidator(jwtKey,
		"/grpc.health.v1.Health/Check",
		"/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
	)

	return grpc.NewServer(
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
		grpc.ChainUnaryInterceptor(
			PanicRecoveryInterceptor(logger),
			RequestIDInterceptor(),
			AuthInterceptor(validator),
			LoggingInterceptor(logger),
		),
		grpc.ChainStreamInterceptor(
			StreamPanicRecoveryInterceptor(logger),
			StreamAuthInterceptor(validator),
			StreamLoggingInterceptor(logger),
		),
	)
}
```

Using `grpc.StatsHandler(otelgrpc.NewServerHandler())` instead of interceptor-based tracing is the recommended approach for otelgrpc v0.52+, as it provides lower overhead and handles both unary and streaming RPCs automatically.

---

## Client-Side Retry Interceptor

The gRPC `WaitForReady` option and `ServiceConfig` retry policies handle most retry cases without custom interceptors, but custom interceptors provide more control:

```go
// interceptors/retry.go (client-side)
package interceptors

import (
	"context"
	"math"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type RetryConfig struct {
	MaxAttempts     int
	InitialBackoff  time.Duration
	MaxBackoff      time.Duration
	BackoffFactor   float64
	RetryableCodes  []codes.Code
}

func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxAttempts:    4,
		InitialBackoff: 100 * time.Millisecond,
		MaxBackoff:     2 * time.Second,
		BackoffFactor:  2.0,
		RetryableCodes: []codes.Code{
			codes.Unavailable,
			codes.ResourceExhausted,
			codes.DeadlineExceeded,
		},
	}
}

func RetryInterceptor(cfg RetryConfig) grpc.UnaryClientInterceptor {
	retryable := make(map[codes.Code]bool, len(cfg.RetryableCodes))
	for _, c := range cfg.RetryableCodes {
		retryable[c] = true
	}

	return func(
		ctx context.Context,
		method string,
		req, reply interface{},
		cc *grpc.ClientConn,
		invoker grpc.UnaryInvoker,
		opts ...grpc.CallOption,
	) error {
		var lastErr error
		backoff := cfg.InitialBackoff

		for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
			if attempt > 0 {
				jitter := time.Duration(float64(backoff) * 0.2)
				sleep := backoff + time.Duration(float64(jitter)*math.Abs(float64(time.Now().UnixNano()%100)/100-0.5))
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(sleep):
				}
				backoff = time.Duration(math.Min(
					float64(backoff)*cfg.BackoffFactor,
					float64(cfg.MaxBackoff),
				))
			}

			lastErr = invoker(ctx, method, req, reply, cc, opts...)
			if lastErr == nil {
				return nil
			}
			if !retryable[status.Code(lastErr)] {
				return lastErr
			}
		}
		return lastErr
	}
}
```

Use the service config retry policy for most cases (no code required):

```go
conn, err := grpc.NewClient(
	"dns:///api.internal.acme.com:443",
	grpc.WithDefaultServiceConfig(`{
		"methodConfig": [{
			"name": [{"service": "acme.UserService"}],
			"retryPolicy": {
				"maxAttempts": 4,
				"initialBackoff": "0.1s",
				"maxBackoff": "2s",
				"backoffMultiplier": 2,
				"retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
			},
			"waitForReady": true
		}]
	}`),
	grpc.WithTransportCredentials(tlsCreds),
)
```

---

## Testing Interceptors

```go
// interceptors/logging_test.go
package interceptors_test

import (
	"context"
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
	"go.uber.org/zap/zaptest/observer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestLoggingInterceptor_LogsSuccessAtInfo(t *testing.T) {
	core, logs := observer.New(zap.InfoLevel)
	logger := zap.New(core)

	interceptor := LoggingInterceptor(logger)
	info := &grpc.UnaryServerInfo{FullMethod: "/acme.UserService/GetUser"}
	handler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return "response", nil
	}

	ctx := context.WithValue(context.Background(), RequestIDKey, "req-abc123")
	_, err := interceptor(ctx, "request", info, handler)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if logs.Len() != 1 {
		t.Fatalf("expected 1 log entry, got %d", logs.Len())
	}
	entry := logs.All()[0]
	if entry.Level != zap.InfoLevel {
		t.Errorf("expected Info level, got %s", entry.Level)
	}
	if entry.ContextMap()["code"] != "OK" {
		t.Errorf("expected code=OK, got %v", entry.ContextMap()["code"])
	}
}

func TestLoggingInterceptor_LogsErrorAtError(t *testing.T) {
	core, logs := observer.New(zap.DebugLevel)
	logger := zap.New(core)

	interceptor := LoggingInterceptor(logger)
	info := &grpc.UnaryServerInfo{FullMethod: "/acme.UserService/CreateUser"}
	handler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return nil, status.Error(codes.Internal, "database connection lost")
	}

	ctx := context.WithValue(context.Background(), RequestIDKey, "req-def456")
	_, err := interceptor(ctx, "request", info, handler)
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal error, got: %v", err)
	}

	errorLogs := logs.FilterLevel(zap.ErrorLevel).All()
	if len(errorLogs) != 1 {
		t.Fatalf("expected 1 error log, got %d", len(errorLogs))
	}
}
```

---

## Summary

Production gRPC interceptor chains address five concerns:

| Interceptor | Position | Purpose |
|-------------|----------|---------|
| Panic Recovery | Outermost | Prevent server crash from handler panics |
| Request ID | 2nd | Correlate logs across services |
| Authentication | 3rd | Reject unauthenticated requests early |
| Logging | 4th | Record structured access logs with timing |
| Tracing (via StatsHandler) | Server option | Propagate trace context to all RPCs |

Client-side retry with exponential backoff and jitter, combined with gRPC service config retry policies, provides resilience against transient `UNAVAILABLE` and `RESOURCE_EXHAUSTED` errors. Every interceptor should have isolated unit tests using `zaptest/observer` for logging validation and in-process gRPC servers for integration testing, ensuring the interceptor chain behaves correctly before deployment.
