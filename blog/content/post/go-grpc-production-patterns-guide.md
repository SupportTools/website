---
title: "Go gRPC Production Patterns: Interceptors, Load Balancing, and Streaming"
date: 2027-09-12T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Microservices", "Protobuf"]
categories:
- Go
- Backend
author: "Matthew Mattox - mmattox@support.tools"
description: "Production gRPC in Go: interceptor chains, metadata propagation, client-side load balancing, gRPC health checking, grpcurl reflection, and bidirectional streaming with proper error handling."
more_link: "yes"
url: "/go-grpc-production-patterns-guide/"
---

gRPC is the dominant RPC framework for Go microservices, offering strongly typed contracts via Protocol Buffers, bi-directional streaming, and built-in HTTP/2 multiplexing. However, using gRPC correctly in production — with proper interceptor chains, metadata propagation, client-side load balancing that actually works, health checking, and streaming error recovery — requires going well beyond the getting-started examples. This guide covers each of those areas with production-ready patterns.

<!--more-->

## Section 1: Project Setup and Proto Compilation

Install the required toolchain:

```bash
# Protocol Buffers compiler
brew install protobuf  # macOS
apt-get install -y protobuf-compiler  # Debian/Ubuntu

# Go plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Go dependencies
go get google.golang.org/grpc@v1.64.0
go get google.golang.org/protobuf@v1.34.2
go get google.golang.org/grpc/health@v1.64.0
```

Example proto definition:

```protobuf
syntax = "proto3";

package user.v1;

option go_package = "github.com/example/myapp/gen/user/v1;userv1";

service UserService {
  rpc GetUser (GetUserRequest) returns (GetUserResponse);
  rpc ListUsers (ListUsersRequest) returns (stream ListUsersResponse);
  rpc WatchUsers (stream WatchUserRequest) returns (stream WatchUserEvent);
}

message GetUserRequest {
  string id = 1;
}

message GetUserResponse {
  User user = 1;
}

message User {
  string id = 1;
  string name = 2;
  string email = 3;
  int64 created_at = 4;
}

message ListUsersRequest {
  int32 page_size = 1;
  string page_token = 2;
}

message ListUsersResponse {
  User user = 1;
}

message WatchUserRequest {
  repeated string user_ids = 1;
}

message WatchUserEvent {
  string user_id = 1;
  string event_type = 2;
}
```

Generate Go code:

```bash
protoc \
  --go_out=gen \
  --go_opt=paths=source_relative \
  --go-grpc_out=gen \
  --go-grpc_opt=paths=source_relative \
  proto/user/v1/user.proto
```

## Section 2: Unary and Streaming Interceptors

Interceptors are gRPC's equivalent of HTTP middleware. Chain multiple interceptors using `grpc.ChainUnaryInterceptor` and `grpc.ChainStreamInterceptor`.

### Unary Server Interceptor

```go
package interceptor

import (
    "context"
    "fmt"
    "time"

    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// LoggingInterceptor logs request duration, method, and status code.
func LoggingInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        start := time.Now()
        resp, err := handler(ctx, req)
        code := status.Code(err)
        logger.Info("grpc unary",
            zap.String("method", info.FullMethod),
            zap.Duration("duration", time.Since(start)),
            zap.String("code", code.String()),
        )
        return resp, err
    }
}

// RecoveryInterceptor catches panics and converts them to gRPC Internal errors.
func RecoveryInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (resp interface{}, err error) {
        defer func() {
            if r := recover(); r != nil {
                logger.Error("panic recovered",
                    zap.String("method", info.FullMethod),
                    zap.Any("panic", r),
                )
                err = status.Errorf(codes.Internal, "internal server error")
            }
        }()
        return handler(ctx, req)
    }
}

// AuthInterceptor validates the Bearer token in incoming metadata.
func AuthInterceptor(validate func(token string) error) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Error(codes.Unauthenticated, "missing metadata")
        }
        tokens := md.Get("authorization")
        if len(tokens) == 0 {
            return nil, status.Error(codes.Unauthenticated, "missing authorization")
        }
        token := strings.TrimPrefix(tokens[0], "Bearer ")
        if err := validate(token); err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
        }
        return handler(ctx, req)
    }
}
```

### Streaming Server Interceptor

```go
// LoggingStreamInterceptor logs stream lifecycle events.
func LoggingStreamInterceptor(logger *zap.Logger) grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        start := time.Now()
        logger.Info("grpc stream started",
            zap.String("method", info.FullMethod),
            zap.Bool("client_stream", info.IsClientStream),
            zap.Bool("server_stream", info.IsServerStream),
        )
        err := handler(srv, ss)
        logger.Info("grpc stream completed",
            zap.String("method", info.FullMethod),
            zap.Duration("duration", time.Since(start)),
            zap.String("code", status.Code(err).String()),
        )
        return err
    }
}
```

### Wiring Interceptors

```go
srv := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        interceptor.RecoveryInterceptor(logger),  // first: catch panics
        interceptor.LoggingInterceptor(logger),   // second: log after
        interceptor.AuthInterceptor(validateToken),
        otelgrpc.UnaryServerInterceptor(),        // OpenTelemetry
    ),
    grpc.ChainStreamInterceptor(
        interceptor.LoggingStreamInterceptor(logger),
        otelgrpc.StreamServerInterceptor(),
    ),
)
```

## Section 3: Metadata Propagation

gRPC metadata is the equivalent of HTTP headers. Propagate request IDs and trace context through every hop:

```go
package metadata

import (
    "context"

    "google.golang.org/grpc/metadata"
)

const (
    keyRequestID = "x-request-id"
    keyUserID    = "x-user-id"
)

// InjectRequestID adds the request ID to outgoing gRPC metadata.
func InjectRequestID(ctx context.Context, requestID string) context.Context {
    return metadata.AppendToOutgoingContext(ctx, keyRequestID, requestID)
}

// ExtractRequestID reads the request ID from incoming gRPC metadata.
func ExtractRequestID(ctx context.Context) string {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return ""
    }
    values := md.Get(keyRequestID)
    if len(values) == 0 {
        return ""
    }
    return values[0]
}

// PropagateMetadata returns a unary client interceptor that copies the
// request ID from the context into outgoing metadata.
func PropagateMetadata() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply interface{},
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        if id := GetRequestIDFromContext(ctx); id != "" {
            ctx = metadata.AppendToOutgoingContext(ctx, keyRequestID, id)
        }
        return invoker(ctx, method, req, reply, cc, opts...)
    }
}
```

## Section 4: Client-Side Load Balancing

gRPC supports client-side load balancing via name resolver + balancer plugins. Use the built-in `round_robin` balancer with a DNS resolver for Kubernetes headless services:

```go
package client

import (
    "context"
    "fmt"

    "google.golang.org/grpc"
    "google.golang.org/grpc/balancer/roundrobin"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"
    _ "google.golang.org/grpc/xds" // import for side effects: registers xDS balancer
)

// NewConn creates a gRPC client connection with client-side round-robin LB.
// target should be "dns:///service-name.namespace.svc.cluster.local:50051"
// for Kubernetes headless services.
func NewConn(ctx context.Context, target string) (*grpc.ClientConn, error) {
    conn, err := grpc.DialContext(ctx, target,
        grpc.WithTransportCredentials(insecure.NewCredentials()), // use TLS in production
        grpc.WithDefaultServiceConfig(fmt.Sprintf(`{
            "loadBalancingConfig": [{"%s": {}}],
            "methodConfig": [{
                "name": [{"service": ""}],
                "retryPolicy": {
                    "maxAttempts": 3,
                    "initialBackoff": "0.1s",
                    "maxBackoff": "5s",
                    "backoffMultiplier": 2,
                    "retryableStatusCodes": ["UNAVAILABLE", "DEADLINE_EXCEEDED"]
                }
            }]
        }`, roundrobin.Name)),
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second, // send pings every 10s of inactivity
            Timeout:             5 * time.Second,  // wait 5s for ping ack
            PermitWithoutStream: true,
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("grpc dial %s: %w", target, err)
    }
    return conn, nil
}
```

For Kubernetes, create a headless service so that DNS returns individual pod IPs:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: user-service
spec:
  clusterIP: None  # headless
  selector:
    app: user-service
  ports:
  - port: 50051
    targetPort: 50051
    name: grpc
```

## Section 5: Health Checking (GRPC_HEALTH)

The [gRPC health checking protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md) is the standard for readiness probes in Kubernetes:

```go
package main

import (
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
)

// Register the health server.
healthSrv := health.NewServer()
grpc_health_v1.RegisterHealthServer(srv, healthSrv)

// Mark the service as serving.
healthSrv.SetServingStatus("user.v1.UserService", grpc_health_v1.HealthCheckResponse_SERVING)

// During graceful shutdown, mark as not serving.
healthSrv.SetServingStatus("user.v1.UserService", grpc_health_v1.HealthCheckResponse_NOT_SERVING)
```

Kubernetes probe configuration using `grpc-health-probe`:

```yaml
livenessProbe:
  grpc:
    port: 50051
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  grpc:
    port: 50051
  initialDelaySeconds: 5
  periodSeconds: 5
```

## Section 6: gRPC Reflection for grpcurl

Register the reflection service in development and staging environments to enable tooling like `grpcurl`:

```go
import "google.golang.org/grpc/reflection"

// Register reflection — disable in production if the API is private.
if os.Getenv("APP_ENV") != "production" {
    reflection.Register(srv)
}
```

Usage with `grpcurl`:

```bash
# List all services
grpcurl -plaintext localhost:50051 list

# Describe a service
grpcurl -plaintext localhost:50051 describe user.v1.UserService

# Call a method
grpcurl -plaintext \
  -d '{"id":"usr_123"}' \
  -H 'authorization: Bearer EXAMPLE_TOKEN_REPLACE_ME' \
  localhost:50051 \
  user.v1.UserService/GetUser

# Test health endpoint
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
```

## Section 7: Server-Side Streaming

```go
package service

import (
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    userv1 "github.com/example/myapp/gen/user/v1"
)

// ListUsers implements server-side streaming.
func (s *UserService) ListUsers(
    req *userv1.ListUsersRequest,
    stream userv1.UserService_ListUsersServer,
) error {
    ctx := stream.Context()
    pageSize := int(req.PageSize)
    if pageSize <= 0 || pageSize > 1000 {
        pageSize = 100
    }

    users, err := s.repo.ListAll(ctx)
    if err != nil {
        return status.Errorf(codes.Internal, "list users: %v", err)
    }

    for _, u := range users {
        // Check context cancellation on each iteration.
        select {
        case <-ctx.Done():
            return status.Error(codes.Canceled, "stream cancelled by client")
        default:
        }

        if err := stream.Send(&userv1.ListUsersResponse{User: toProto(u)}); err != nil {
            // Client disconnected or stream is broken.
            return status.Errorf(codes.Unavailable, "send: %v", err)
        }
    }
    return nil
}
```

## Section 8: Bidirectional Streaming

Bidirectional streaming requires careful goroutine management to avoid leaks:

```go
// WatchUsers implements a bidirectional streaming RPC.
func (s *UserService) WatchUsers(
    stream userv1.UserService_WatchUsersServer,
) error {
    ctx := stream.Context()

    // Receive goroutine.
    subscriptions := make(chan []string, 1)
    recvErr := make(chan error, 1)
    go func() {
        for {
            req, err := stream.Recv()
            if err != nil {
                recvErr <- err
                return
            }
            subscriptions <- req.UserIds
        }
    }()

    // Current set of watched user IDs.
    watchedIDs := make(map[string]bool)
    events := s.eventBus.Subscribe(ctx)

    for {
        select {
        case <-ctx.Done():
            return status.Error(codes.Canceled, ctx.Err().Error())

        case err := <-recvErr:
            if err == io.EOF {
                return nil // client closed send side
            }
            return status.Errorf(codes.Internal, "receive error: %v", err)

        case ids := <-subscriptions:
            watchedIDs = make(map[string]bool, len(ids))
            for _, id := range ids {
                watchedIDs[id] = true
            }

        case event := <-events:
            if !watchedIDs[event.UserID] {
                continue
            }
            if err := stream.Send(&userv1.WatchUserEvent{
                UserId:    event.UserID,
                EventType: event.Type,
            }); err != nil {
                return status.Errorf(codes.Unavailable, "send event: %v", err)
            }
        }
    }
}
```

## Section 9: gRPC Error Handling

Always use `status.Error` with meaningful codes. Include structured error details for client-parseable errors:

```go
package grpcerr

import (
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/errdetailspb"
)

// NotFound returns a gRPC NOT_FOUND status with resource information.
func NotFound(resourceType, id string) error {
    st := status.New(codes.NotFound, fmt.Sprintf("%s %q not found", resourceType, id))
    info := &errdetails.ResourceInfo{
        ResourceType: resourceType,
        ResourceName: id,
        Description:  "the requested resource does not exist",
    }
    st, _ = st.WithDetails(info)
    return st.Err()
}

// ValidationFailed returns a gRPC INVALID_ARGUMENT status with field violations.
func ValidationFailed(violations map[string]string) error {
    st := status.New(codes.InvalidArgument, "request validation failed")
    var fvs []*errdetails.BadRequest_FieldViolation
    for field, desc := range violations {
        fvs = append(fvs, &errdetails.BadRequest_FieldViolation{
            Field:       field,
            Description: desc,
        })
    }
    br := &errdetails.BadRequest{FieldViolations: fvs}
    st, _ = st.WithDetails(br)
    return st.Err()
}
```

Extract error details on the client side:

```go
func extractFieldViolations(err error) []string {
    st, ok := status.FromError(err)
    if !ok {
        return nil
    }
    var violations []string
    for _, detail := range st.Details() {
        switch d := detail.(type) {
        case *errdetails.BadRequest:
            for _, v := range d.FieldViolations {
                violations = append(violations, fmt.Sprintf("%s: %s", v.Field, v.Description))
            }
        }
    }
    return violations
}
```

## Section 10: Graceful Shutdown

gRPC servers must drain in-flight RPCs before stopping, especially for streaming calls:

```go
package main

import (
    "context"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"

    "google.golang.org/grpc"
)

func runServer(srv *grpc.Server, addr string) error {
    lis, err := net.Listen("tcp", addr)
    if err != nil {
        return fmt.Errorf("listen %s: %w", addr, err)
    }

    errCh := make(chan error, 1)
    go func() {
        if err := srv.Serve(lis); err != nil {
            errCh <- err
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

    select {
    case err := <-errCh:
        return err
    case sig := <-quit:
        logger.Info("shutdown signal received", zap.String("signal", sig.String()))
    }

    // Mark service as not serving before stopping.
    healthSrv.SetServingStatus("",
        grpc_health_v1.HealthCheckResponse_NOT_SERVING)

    // Allow time for load balancer to drain traffic.
    time.Sleep(5 * time.Second)

    // GracefulStop waits for all RPCs to complete.
    // Use a timeout to avoid hanging indefinitely.
    stopped := make(chan struct{})
    go func() {
        srv.GracefulStop()
        close(stopped)
    }()

    select {
    case <-stopped:
        logger.Info("grpc server stopped gracefully")
    case <-time.After(30 * time.Second):
        logger.Warn("graceful stop timeout; forcing stop")
        srv.Stop()
    }
    return nil
}
```

### Server Options for Production

```go
srv := grpc.NewServer(
    grpc.MaxRecvMsgSize(4 * 1024 * 1024),  // 4 MB
    grpc.MaxSendMsgSize(4 * 1024 * 1024),  // 4 MB
    grpc.KeepaliveParams(keepalive.ServerParameters{
        MaxConnectionIdle:     15 * time.Minute,
        MaxConnectionAge:      30 * time.Minute,
        MaxConnectionAgeGrace: 5 * time.Second,
        Time:                  5 * time.Second,
        Timeout:               1 * time.Second,
    }),
    grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
        MinTime:             5 * time.Second,
        PermitWithoutStream: true,
    }),
    // Interceptors...
)
```
