---
title: "Go gRPC Production Patterns: Load Balancing, TLS, Interceptors, and Health Checking"
date: 2028-04-05T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Protobuf", "TLS", "Load Balancing"]
categories: ["Go", "Microservices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to production gRPC in Go covering client-side load balancing, mutual TLS, unary and streaming interceptors, health checking, and observability patterns."
more_link: "yes"
url: "/go-grpc-production-patterns-guide-advanced/"
---

gRPC is the backbone of many high-performance microservice architectures, but running it reliably in production requires mastering several advanced patterns beyond the basics. This guide covers client-side load balancing, mutual TLS configuration, interceptor chains for observability and auth, and the gRPC health checking protocol with real Go code ready for production use.

<!--more-->

# Go gRPC Production Patterns: Load Balancing, TLS, Interceptors, and Health Checking

## Why gRPC Needs Special Production Attention

HTTP/1.1 clients work well with traditional load balancers because each request establishes a new connection. gRPC uses HTTP/2 with persistent multiplexed connections, which means a single TCP connection can carry thousands of concurrent RPCs. This fundamentally changes how load balancing works — a Layer 4 load balancer (TCP) will typically pin all traffic from one client to one server instance.

Production gRPC deployments require deliberate decisions about:
- Where load balancing happens (client-side vs. proxy-based)
- How TLS is configured for security (server TLS vs. mutual TLS)
- How cross-cutting concerns like auth, logging, and tracing are applied
- How service health is communicated and monitored

## Service Definition

Start with a well-designed protobuf schema that serves as the contract between client and server.

```protobuf
// api/v1/service.proto
syntax = "proto3";

package myservice.v1;
option go_package = "github.com/example/myservice/api/v1;servicev1";

import "google/protobuf/timestamp.proto";

// UserService manages user lifecycle operations
service UserService {
    // GetUser retrieves a single user by ID
    rpc GetUser(GetUserRequest) returns (GetUserResponse);

    // ListUsers streams users matching criteria
    rpc ListUsers(ListUsersRequest) returns (stream User);

    // CreateUser creates a new user
    rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);

    // WatchUserEvents streams real-time user events
    rpc WatchUserEvents(WatchUserEventsRequest) returns (stream UserEvent);
}

message GetUserRequest {
    string user_id = 1;
}

message GetUserResponse {
    User user = 1;
}

message ListUsersRequest {
    string organization_id = 1;
    int32 page_size = 2;
    string page_token = 3;
    repeated string roles = 4;
}

message CreateUserRequest {
    string email = 1;
    string display_name = 2;
    string organization_id = 3;
    repeated string roles = 4;
}

message CreateUserResponse {
    User user = 1;
}

message WatchUserEventsRequest {
    string organization_id = 1;
    repeated string event_types = 2;
}

message User {
    string user_id = 1;
    string email = 2;
    string display_name = 3;
    string organization_id = 4;
    repeated string roles = 5;
    google.protobuf.Timestamp created_at = 6;
    google.protobuf.Timestamp updated_at = 7;
}

message UserEvent {
    string event_id = 1;
    string event_type = 2;
    User user = 3;
    google.protobuf.Timestamp occurred_at = 4;
}
```

```bash
# Generate Go code from proto
protoc \
    --go_out=. \
    --go_opt=paths=source_relative \
    --go-grpc_out=. \
    --go-grpc_opt=paths=source_relative \
    api/v1/service.proto
```

## Server Implementation

```go
// internal/server/server.go
package server

import (
    "context"
    "fmt"
    "io"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    servicev1 "github.com/example/myservice/api/v1"
)

// UserServiceServer implements the gRPC UserService
type UserServiceServer struct {
    servicev1.UnimplementedUserServiceServer
    store UserStore
    events EventBus
}

func NewUserServiceServer(store UserStore, events EventBus) *UserServiceServer {
    return &UserServiceServer{store: store, events: events}
}

// GetUser implements the unary RPC
func (s *UserServiceServer) GetUser(ctx context.Context, req *servicev1.GetUserRequest) (*servicev1.GetUserResponse, error) {
    if req.UserId == "" {
        return nil, status.Error(codes.InvalidArgument, "user_id is required")
    }

    user, err := s.store.GetUser(ctx, req.UserId)
    if err != nil {
        if isNotFound(err) {
            return nil, status.Errorf(codes.NotFound, "user %q not found", req.UserId)
        }
        return nil, status.Errorf(codes.Internal, "fetching user: %v", err)
    }

    return &servicev1.GetUserResponse{User: userToProto(user)}, nil
}

// ListUsers implements server streaming
func (s *UserServiceServer) ListUsers(req *servicev1.ListUsersRequest, stream servicev1.UserService_ListUsersServer) error {
    if req.OrganizationId == "" {
        return status.Error(codes.InvalidArgument, "organization_id is required")
    }

    ctx := stream.Context()
    users, err := s.store.ListUsers(ctx, req.OrganizationId, req.Roles)
    if err != nil {
        return status.Errorf(codes.Internal, "listing users: %v", err)
    }

    for _, user := range users {
        // Check if the client has cancelled
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        if err := stream.Send(userToProto(user)); err != nil {
            if err == io.EOF {
                return nil
            }
            return status.Errorf(codes.Internal, "sending user: %v", err)
        }
    }

    return nil
}

// WatchUserEvents implements bidirectional streaming for real-time events
func (s *UserServiceServer) WatchUserEvents(req *servicev1.WatchUserEventsRequest, stream servicev1.UserService_WatchUserEventsServer) error {
    if req.OrganizationId == "" {
        return status.Error(codes.InvalidArgument, "organization_id is required")
    }

    ctx := stream.Context()
    ch, unsubscribe := s.events.Subscribe(req.OrganizationId, req.EventTypes)
    defer unsubscribe()

    for {
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()

        case event, ok := <-ch:
            if !ok {
                return status.Error(codes.Unavailable, "event stream closed")
            }

            protoEvent := &servicev1.UserEvent{
                EventId:    event.ID,
                EventType:  event.Type,
                User:       userToProto(event.User),
                OccurredAt: timestamppb.New(event.OccurredAt),
            }

            if err := stream.Send(protoEvent); err != nil {
                return status.Errorf(codes.Internal, "sending event: %v", err)
            }
        }
    }
}

func userToProto(u *User) *servicev1.User {
    return &servicev1.User{
        UserId:         u.ID,
        Email:          u.Email,
        DisplayName:    u.DisplayName,
        OrganizationId: u.OrganizationID,
        Roles:          u.Roles,
        CreatedAt:      timestamppb.New(u.CreatedAt),
        UpdatedAt:      timestamppb.New(u.UpdatedAt),
    }
}
```

## Mutual TLS Configuration

Mutual TLS (mTLS) provides both server authentication and client authentication. Every service must present a valid certificate signed by a trusted CA.

```go
// pkg/tlsconfig/tlsconfig.go
package tlsconfig

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "os"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials"
)

// ServerTLSConfig returns TLS configuration for a gRPC server with mTLS
func ServerTLSConfig(certFile, keyFile, caFile string) (*tls.Config, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("loading server certificate: %w", err)
    }

    caCert, err := os.ReadFile(caFile)
    if err != nil {
        return nil, fmt.Errorf("reading CA certificate: %w", err)
    }

    caPool := x509.NewCertPool()
    if !caPool.AppendCertsFromPEM(caCert) {
        return nil, fmt.Errorf("parsing CA certificate")
    }

    return &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientAuth:   tls.RequireAndVerifyClientCert,
        ClientCAs:    caPool,
        MinVersion:   tls.VersionTLS13,
        CipherSuites: []uint16{
            tls.TLS_AES_128_GCM_SHA256,
            tls.TLS_AES_256_GCM_SHA384,
            tls.TLS_CHACHA20_POLY1305_SHA256,
        },
    }, nil
}

// ClientTLSConfig returns TLS configuration for a gRPC client with mTLS
func ClientTLSConfig(certFile, keyFile, caFile, serverName string) (*tls.Config, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("loading client certificate: %w", err)
    }

    caCert, err := os.ReadFile(caFile)
    if err != nil {
        return nil, fmt.Errorf("reading CA certificate: %w", err)
    }

    caPool := x509.NewCertPool()
    if !caPool.AppendCertsFromPEM(caCert) {
        return nil, fmt.Errorf("parsing CA certificate")
    }

    return &tls.Config{
        Certificates: []tls.Certificate{cert},
        RootCAs:      caPool,
        ServerName:   serverName,
        MinVersion:   tls.VersionTLS13,
    }, nil
}

// NewServerWithTLS creates a gRPC server with mTLS and standard options
func NewServerWithTLS(certFile, keyFile, caFile string, opts ...grpc.ServerOption) (*grpc.Server, error) {
    tlsConf, err := ServerTLSConfig(certFile, keyFile, caFile)
    if err != nil {
        return nil, err
    }

    creds := credentials.NewTLS(tlsConf)
    opts = append([]grpc.ServerOption{grpc.Creds(creds)}, opts...)
    return grpc.NewServer(opts...), nil
}
```

## Interceptors: Unary and Streaming

Interceptors are middleware for gRPC. They implement cross-cutting concerns like authentication, logging, tracing, and rate limiting.

```go
// pkg/interceptors/interceptors.go
package interceptors

import (
    "context"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"

    grpccodes "google.golang.org/grpc/codes"
)

// LoggingUnaryInterceptor logs all unary RPCs with timing and error information
func LoggingUnaryInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        start := time.Now()
        resp, err := handler(ctx, req)
        duration := time.Since(start)

        code := grpccodes.OK
        if err != nil {
            code = status.Code(err)
        }

        fields := []zap.Field{
            zap.String("method", info.FullMethod),
            zap.Duration("duration", duration),
            zap.String("grpc.code", code.String()),
        }

        if err != nil {
            logger.Error("RPC failed", append(fields, zap.Error(err))...)
        } else if duration > 500*time.Millisecond {
            logger.Warn("RPC slow", fields...)
        } else {
            logger.Info("RPC completed", fields...)
        }

        return resp, err
    }
}

// LoggingStreamInterceptor logs streaming RPCs
func LoggingStreamInterceptor(logger *zap.Logger) grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        stream grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        start := time.Now()
        err := handler(srv, stream)
        duration := time.Since(start)

        code := grpccodes.OK
        if err != nil {
            code = status.Code(err)
        }

        logger.Info("Streaming RPC completed",
            zap.String("method", info.FullMethod),
            zap.Duration("duration", duration),
            zap.String("grpc.code", code.String()),
            zap.Bool("is_client_stream", info.IsClientStream),
            zap.Bool("is_server_stream", info.IsServerStream),
            zap.Error(err),
        )
        return err
    }
}

// AuthUnaryInterceptor validates JWT tokens from metadata
func AuthUnaryInterceptor(validator TokenValidator) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        // Skip health check endpoints
        if info.FullMethod == "/grpc.health.v1.Health/Check" {
            return handler(ctx, req)
        }

        token, err := extractToken(ctx)
        if err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "missing token: %v", err)
        }

        claims, err := validator.Validate(ctx, token)
        if err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
        }

        // Add claims to context for downstream handlers
        ctx = contextWithClaims(ctx, claims)
        return handler(ctx, req)
    }
}

// RecoveryUnaryInterceptor catches panics and converts them to gRPC errors
func RecoveryUnaryInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (resp interface{}, err error) {
        defer func() {
            if r := recover(); r != nil {
                logger.Error("Panic in RPC handler",
                    zap.String("method", info.FullMethod),
                    zap.Any("panic", r),
                )
                err = status.Errorf(codes.Internal, "internal server error")
            }
        }()
        return handler(ctx, req)
    }
}

// TracingUnaryInterceptor adds OpenTelemetry tracing to unary RPCs
func TracingUnaryInterceptor(tracer trace.Tracer) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        ctx, span := tracer.Start(ctx, info.FullMethod,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                attribute.String("rpc.system", "grpc"),
                attribute.String("rpc.method", info.FullMethod),
            ),
        )
        defer span.End()

        resp, err := handler(ctx, req)
        if err != nil {
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
        } else {
            span.SetStatus(codes.Ok, "")
        }

        return resp, err
    }
}

// RateLimitingUnaryInterceptor enforces per-method rate limits
func RateLimitingUnaryInterceptor(limiter RateLimiter) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        if !limiter.Allow(info.FullMethod) {
            return nil, status.Errorf(codes.ResourceExhausted,
                "rate limit exceeded for method %s", info.FullMethod)
        }
        return handler(ctx, req)
    }
}

// TimeoutUnaryInterceptor enforces maximum RPC duration
func TimeoutUnaryInterceptor(timeout time.Duration) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        ctx, cancel := context.WithTimeout(ctx, timeout)
        defer cancel()

        type result struct {
            resp interface{}
            err  error
        }

        ch := make(chan result, 1)
        go func() {
            resp, err := handler(ctx, req)
            ch <- result{resp, err}
        }()

        select {
        case r := <-ch:
            return r.resp, r.err
        case <-ctx.Done():
            return nil, status.Errorf(codes.DeadlineExceeded,
                "RPC timed out after %s", timeout)
        }
    }
}

func extractToken(ctx context.Context) (string, error) {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return "", fmt.Errorf("no metadata")
    }

    values := md.Get("authorization")
    if len(values) == 0 {
        return "", fmt.Errorf("authorization header missing")
    }

    token := values[0]
    if len(token) > 7 && token[:7] == "Bearer " {
        return token[7:], nil
    }
    return token, nil
}
```

## Chaining Interceptors

Use `grpc.ChainUnaryInterceptor` and `grpc.ChainStreamInterceptor` to compose multiple interceptors:

```go
// cmd/server/main.go
package main

import (
    "crypto/tls"
    "fmt"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"

    "go.opentelemetry.io/otel"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials"
    "google.golang.org/grpc/health"
    healthpb "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/reflection"

    servicev1 "github.com/example/myservice/api/v1"
    "github.com/example/myservice/internal/server"
    "github.com/example/myservice/pkg/interceptors"
    "github.com/example/myservice/pkg/tlsconfig"
)

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    tracer := otel.Tracer("myservice")

    // Build TLS credentials with mTLS
    tlsConf, err := tlsconfig.ServerTLSConfig(
        os.Getenv("TLS_CERT_FILE"),
        os.Getenv("TLS_KEY_FILE"),
        os.Getenv("TLS_CA_FILE"),
    )
    if err != nil {
        logger.Fatal("TLS configuration failed", zap.Error(err))
    }

    validator := NewJWTValidator(os.Getenv("JWT_PUBLIC_KEY"))
    rateLimiter := NewTokenBucketLimiter(1000, 100) // 1000 RPS, burst 100

    srv := grpc.NewServer(
        grpc.Creds(credentials.NewTLS(tlsConf)),

        // Keepalive to detect dead connections
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle:     15 * time.Minute,
            MaxConnectionAge:      30 * time.Minute,
            MaxConnectionAgeGrace: 5 * time.Minute,
            Time:                  5 * time.Second,
            Timeout:               1 * time.Second,
        }),
        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            MinTime:             5 * time.Second,
            PermitWithoutStream: true,
        }),

        // Message size limits (prevent abuse)
        grpc.MaxRecvMsgSize(4 * 1024 * 1024),  // 4MB
        grpc.MaxSendMsgSize(16 * 1024 * 1024), // 16MB

        // Unary interceptor chain (executed in order)
        grpc.ChainUnaryInterceptor(
            interceptors.RecoveryUnaryInterceptor(logger),    // 1. Panic recovery (outermost)
            interceptors.TracingUnaryInterceptor(tracer),     // 2. Tracing
            interceptors.LoggingUnaryInterceptor(logger),     // 3. Logging
            interceptors.AuthUnaryInterceptor(validator),     // 4. Authentication
            interceptors.RateLimitingUnaryInterceptor(rateLimiter), // 5. Rate limiting
            interceptors.TimeoutUnaryInterceptor(30*time.Second),   // 6. Timeout
        ),

        // Stream interceptor chain
        grpc.ChainStreamInterceptor(
            interceptors.LoggingStreamInterceptor(logger),
        ),
    )

    // Register services
    userStore := server.NewUserStore()
    eventBus := server.NewEventBus()
    servicev1.RegisterUserServiceServer(srv, server.NewUserServiceServer(userStore, eventBus))

    // Health checking service
    healthServer := health.NewServer()
    healthpb.RegisterHealthServer(srv, healthServer)
    healthServer.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
    healthServer.SetServingStatus("myservice.v1.UserService", healthpb.HealthCheckResponse_SERVING)

    // gRPC reflection for debugging with grpcurl
    reflection.Register(srv)

    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        logger.Fatal("Failed to listen", zap.Error(err))
    }

    go func() {
        logger.Info("Starting gRPC server", zap.String("addr", ":50051"))
        if err := srv.Serve(lis); err != nil {
            logger.Fatal("Server failed", zap.Error(err))
        }
    }()

    // Graceful shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
    <-quit

    logger.Info("Initiating graceful shutdown")
    healthServer.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)

    // Allow in-flight RPCs to complete (30s grace period)
    done := make(chan struct{})
    go func() {
        srv.GracefulStop()
        close(done)
    }()

    select {
    case <-done:
        logger.Info("Server stopped gracefully")
    case <-time.After(30 * time.Second):
        logger.Warn("Graceful shutdown timed out, forcing stop")
        srv.Stop()
    }
}
```

## Client-Side Load Balancing

gRPC supports client-side load balancing with DNS resolution and round-robin scheduling. This is the preferred approach in Kubernetes with headless services.

```go
// pkg/client/client.go
package client

import (
    "context"
    "crypto/tls"
    "fmt"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/balancer/roundrobin"
    "google.golang.org/grpc/credentials"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/resolver"

    servicev1 "github.com/example/myservice/api/v1"
    "github.com/example/myservice/pkg/tlsconfig"
)

// ClientConfig holds connection configuration
type ClientConfig struct {
    // Target is the gRPC target (e.g., "dns:///myservice.namespace.svc.cluster.local:50051")
    Target string
    // TLSCertFile is the client certificate for mTLS
    TLSCertFile string
    // TLSKeyFile is the client private key
    TLSKeyFile string
    // TLSCAFile is the CA certificate for server verification
    TLSCAFile string
    // ServerName overrides the server name in the certificate
    ServerName string
    // ConnectTimeout is how long to wait for initial connection
    ConnectTimeout time.Duration
    // MaxRetries controls how many times a failed RPC is retried
    MaxRetries int
}

// NewUserServiceClient creates a production-ready gRPC client
func NewUserServiceClient(cfg ClientConfig, logger *zap.Logger) (servicev1.UserServiceClient, *grpc.ClientConn, error) {
    tlsConf, err := tlsconfig.ClientTLSConfig(cfg.TLSCertFile, cfg.TLSKeyFile, cfg.TLSCAFile, cfg.ServerName)
    if err != nil {
        return nil, nil, fmt.Errorf("building TLS config: %w", err)
    }

    connectTimeout := cfg.ConnectTimeout
    if connectTimeout == 0 {
        connectTimeout = 10 * time.Second
    }

    // Service config enables client-side load balancing and retry
    serviceConfig := `{
        "loadBalancingPolicy": "round_robin",
        "retryPolicy": {
            "maxAttempts": 4,
            "initialBackoff": "0.5s",
            "maxBackoff": "10s",
            "backoffMultiplier": 2.0,
            "retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
        },
        "methodConfig": [{
            "name": [{"service": "myservice.v1.UserService"}],
            "timeout": "30s",
            "waitForReady": true
        }, {
            "name": [{"service": "myservice.v1.UserService", "method": "WatchUserEvents"}],
            "timeout": "0s",
            "waitForReady": true
        }]
    }`

    ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
    defer cancel()

    conn, err := grpc.DialContext(ctx, cfg.Target,
        grpc.WithTransportCredentials(credentials.NewTLS(tlsConf)),

        // Client-side round-robin load balancing
        grpc.WithDefaultServiceConfig(serviceConfig),

        // Keepalive to detect dead connections
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second,
            Timeout:             5 * time.Second,
            PermitWithoutStream: true,
        }),

        // OpenTelemetry instrumentation
        grpc.WithStatsHandler(otelgrpc.NewClientHandler()),

        // Block until connection is established
        grpc.WithBlock(),

        // Limit message sizes
        grpc.WithDefaultCallOptions(
            grpc.MaxCallRecvMsgSize(16*1024*1024),
            grpc.MaxCallSendMsgSize(4*1024*1024),
        ),

        // Client-side interceptors
        grpc.WithChainUnaryInterceptor(
            clientLoggingInterceptor(logger),
            clientRetryInterceptor(cfg.MaxRetries),
        ),
    )
    if err != nil {
        return nil, nil, fmt.Errorf("connecting to %s: %w", cfg.Target, err)
    }

    return servicev1.NewUserServiceClient(conn), conn, nil
}

// clientLoggingInterceptor logs outbound RPC calls
func clientLoggingInterceptor(logger *zap.Logger) grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply interface{},
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        start := time.Now()
        err := invoker(ctx, method, req, reply, cc, opts...)
        logger.Debug("gRPC client call",
            zap.String("method", method),
            zap.Duration("duration", time.Since(start)),
            zap.Error(err),
        )
        return err
    }
}

// clientRetryInterceptor implements client-side retry with exponential backoff
func clientRetryInterceptor(maxRetries int) grpc.UnaryClientInterceptor {
    if maxRetries <= 0 {
        maxRetries = 3
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
        for attempt := 0; attempt <= maxRetries; attempt++ {
            if attempt > 0 {
                backoff := time.Duration(attempt*attempt) * 100 * time.Millisecond
                select {
                case <-time.After(backoff):
                case <-ctx.Done():
                    return ctx.Err()
                }
            }

            lastErr = invoker(ctx, method, req, reply, cc, opts...)
            if lastErr == nil {
                return nil
            }

            // Only retry on transient errors
            code := status.Code(lastErr)
            if code != grpccodes.Unavailable && code != grpccodes.ResourceExhausted {
                return lastErr
            }
        }
        return lastErr
    }
}
```

## Kubernetes Headless Service for gRPC Load Balancing

For client-side load balancing in Kubernetes, use a headless service so DNS returns all pod IPs:

```yaml
# kubernetes/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: userservice
  namespace: myservice
spec:
  # clusterIP: None makes this a headless service
  # DNS returns individual pod IPs instead of a single VIP
  clusterIP: None
  selector:
    app: userservice
  ports:
  - name: grpc
    port: 50051
    targetPort: 50051
    protocol: TCP
---
# The client target would be:
# dns:///userservice.myservice.svc.cluster.local:50051
```

## Health Checking Protocol

The gRPC health checking protocol is standardized and supported by most load balancers and Kubernetes probes.

```go
// pkg/health/health.go
package health

import (
    "context"
    "sync"

    healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// DynamicHealthServer implements gRPC health checking with dynamic service status
type DynamicHealthServer struct {
    mu       sync.RWMutex
    statuses map[string]healthpb.HealthCheckResponse_ServingStatus
    changes  chan struct{}
}

func NewDynamicHealthServer() *DynamicHealthServer {
    return &DynamicHealthServer{
        statuses: make(map[string]healthpb.HealthCheckResponse_ServingStatus),
        changes:  make(chan struct{}, 1),
    }
}

func (h *DynamicHealthServer) SetServingStatus(service string, status healthpb.HealthCheckResponse_ServingStatus) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.statuses[service] = status

    // Non-blocking notify
    select {
    case h.changes <- struct{}{}:
    default:
    }
}

func (h *DynamicHealthServer) Check(ctx context.Context, req *healthpb.HealthCheckRequest) (*healthpb.HealthCheckResponse, error) {
    h.mu.RLock()
    defer h.mu.RUnlock()

    status, ok := h.statuses[req.Service]
    if !ok {
        return &healthpb.HealthCheckResponse{
            Status: healthpb.HealthCheckResponse_SERVICE_UNKNOWN,
        }, nil
    }

    return &healthpb.HealthCheckResponse{Status: status}, nil
}

func (h *DynamicHealthServer) Watch(req *healthpb.HealthCheckRequest, stream healthpb.Health_WatchServer) error {
    // Send initial status
    resp, err := h.Check(stream.Context(), &healthpb.HealthCheckRequest{Service: req.Service})
    if err != nil {
        return err
    }
    if err := stream.Send(resp); err != nil {
        return err
    }

    // Stream status changes
    for {
        select {
        case <-stream.Context().Done():
            return stream.Context().Err()
        case <-h.changes:
            resp, err := h.Check(stream.Context(), &healthpb.HealthCheckRequest{Service: req.Service})
            if err != nil {
                return err
            }
            if err := stream.Send(resp); err != nil {
                return err
            }
        }
    }
}
```

## Kubernetes Probe Configuration

```yaml
# kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: userservice
  namespace: myservice
spec:
  replicas: 3
  selector:
    matchLabels:
      app: userservice
  template:
    spec:
      containers:
      - name: userservice
        image: userservice:latest
        ports:
        - name: grpc
          containerPort: 50051
        livenessProbe:
          grpc:
            port: 50051
            service: ""  # Empty string checks the overall health
          initialDelaySeconds: 10
          periodSeconds: 10
          failureThreshold: 3
        readinessProbe:
          grpc:
            port: 50051
            service: "myservice.v1.UserService"
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3
        startupProbe:
          grpc:
            port: 50051
          failureThreshold: 30
          periodSeconds: 2
```

## gRPC Error Handling Best Practices

```go
// pkg/errors/grpcerrors.go
package grpcerrors

import (
    "fmt"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/anypb"

    errorpb "google.golang.org/genproto/googleapis/rpc/error_details"
)

// NewValidationError creates a detailed validation error
func NewValidationError(field, description string) error {
    st := status.New(codes.InvalidArgument, fmt.Sprintf("validation failed: %s", description))

    violations := &errorpb.BadRequest_FieldViolation{
        Field:       field,
        Description: description,
    }
    br := &errorpb.BadRequest{FieldViolations: []*errorpb.BadRequest_FieldViolation{violations}}

    detail, _ := anypb.New(br)
    st, _ = st.WithDetails(detail)
    return st.Err()
}

// NewNotFoundError creates a structured not-found error
func NewNotFoundError(resourceType, resourceName string) error {
    st := status.New(codes.NotFound, fmt.Sprintf("%s %q not found", resourceType, resourceName))
    detail := &errorpb.ResourceInfo{
        ResourceType: resourceType,
        ResourceName: resourceName,
        Description:  fmt.Sprintf("The requested %s does not exist", resourceType),
    }
    d, _ := anypb.New(detail)
    st, _ = st.WithDetails(d)
    return st.Err()
}

// NewRateLimitError creates a rate limit error with retry information
func NewRateLimitError(retryAfterSeconds int32) error {
    st := status.New(codes.ResourceExhausted, "rate limit exceeded")
    retryInfo := &errorpb.RetryInfo{
        RetryDelay: &durationpb.Duration{Seconds: int64(retryAfterSeconds)},
    }
    d, _ := anypb.New(retryInfo)
    st, _ = st.WithDetails(d)
    return st.Err()
}
```

## Testing gRPC Services

```go
// internal/server/server_test.go
package server_test

import (
    "context"
    "net"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/test/bufconn"

    servicev1 "github.com/example/myservice/api/v1"
    "github.com/example/myservice/internal/server"
)

const bufSize = 1024 * 1024

func setupTestServer(t *testing.T) servicev1.UserServiceClient {
    t.Helper()

    lis := bufconn.Listen(bufSize)
    srv := grpc.NewServer()

    store := server.NewMockUserStore()
    events := server.NewMockEventBus()
    servicev1.RegisterUserServiceServer(srv, server.NewUserServiceServer(store, events))

    go func() {
        if err := srv.Serve(lis); err != nil {
            t.Logf("test server stopped: %v", err)
        }
    }()
    t.Cleanup(srv.Stop)

    conn, err := grpc.DialContext(context.Background(), "bufnet",
        grpc.WithContextDialer(func(ctx context.Context, s string) (net.Conn, error) {
            return lis.DialContext(ctx)
        }),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    require.NoError(t, err)
    t.Cleanup(func() { conn.Close() })

    return servicev1.NewUserServiceClient(conn)
}

func TestGetUser(t *testing.T) {
    client := setupTestServer(t)

    t.Run("existing user", func(t *testing.T) {
        resp, err := client.GetUser(context.Background(), &servicev1.GetUserRequest{
            UserId: "user-123",
        })
        require.NoError(t, err)
        assert.Equal(t, "user-123", resp.User.UserId)
    })

    t.Run("missing user_id", func(t *testing.T) {
        _, err := client.GetUser(context.Background(), &servicev1.GetUserRequest{})
        require.Error(t, err)
        assert.Contains(t, err.Error(), "InvalidArgument")
    })

    t.Run("not found", func(t *testing.T) {
        _, err := client.GetUser(context.Background(), &servicev1.GetUserRequest{
            UserId: "nonexistent",
        })
        require.Error(t, err)
        assert.Contains(t, err.Error(), "NotFound")
    })
}
```

## Conclusion

Production gRPC services in Go require deliberate configuration across several dimensions. Mutual TLS ensures both service identity and encrypted transport. Client-side load balancing with headless Kubernetes services prevents connection pinning to single instances. Interceptor chains provide a clean mechanism for cross-cutting concerns without polluting handler logic. The standardized health checking protocol integrates naturally with Kubernetes probes and load balancer health checks. Together, these patterns form a robust foundation for high-performance gRPC microservices that operate reliably at scale.
