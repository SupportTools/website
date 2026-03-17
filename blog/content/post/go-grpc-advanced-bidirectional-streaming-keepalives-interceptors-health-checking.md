---
title: "Go gRPC Advanced: Bidirectional Streaming, Keepalives, Interceptors, Health Checking Protocol, and Reflection"
date: 2031-12-22T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Streaming", "Microservices", "Protobuf", "Networking", "Performance", "Interceptors"]
categories:
- Go
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to advanced gRPC patterns in Go including bidirectional streaming, keepalive configuration, chain interceptors, gRPC health checking protocol implementation, and server reflection for tooling integration."
more_link: "yes"
url: "/go-grpc-advanced-bidirectional-streaming-keepalives-interceptors-health-checking/"
---

gRPC is more than a simple RPC framework. Its streaming capabilities, pluggable interceptor chain, well-defined health protocol, and server reflection API together form a complete platform for building production microservices. Most Go gRPC implementations use only a fraction of these features, leaving performance and observability on the table.

This guide covers the advanced gRPC capabilities that separate production-grade services from basic implementations: bidirectional streaming patterns, keepalive and connection management configuration, composable interceptor chains for observability and authorization, the gRPC health checking protocol, and server reflection for integration with grpcurl and Postman.

<!--more-->

# Go gRPC Advanced: Bidirectional Streaming, Keepalives, Interceptors, Health Checking, and Reflection

## Section 1: gRPC Streaming Fundamentals

### 1.1 The Four Call Types

```protobuf
// order_service.proto
syntax = "proto3";
package order.v1;

import "google/protobuf/timestamp.proto";

service OrderService {
  // Unary: one request, one response
  rpc GetOrder(GetOrderRequest) returns (Order);

  // Server streaming: one request, multiple responses
  rpc WatchOrders(WatchOrdersRequest) returns (stream Order);

  // Client streaming: multiple requests, one response
  rpc BatchCreateOrders(stream CreateOrderRequest) returns (BatchCreateResponse);

  // Bidirectional streaming: multiple requests, multiple responses
  rpc ProcessOrderStream(stream OrderEvent) returns (stream OrderResult);
}

message OrderEvent {
  string order_id = 1;
  enum EventType {
    CREATED = 0;
    UPDATED = 1;
    CANCELLED = 2;
  }
  EventType type = 2;
  bytes payload = 3;
  google.protobuf.Timestamp timestamp = 4;
}

message OrderResult {
  string order_id = 1;
  bool success = 2;
  string error_message = 3;
  google.protobuf.Timestamp processed_at = 4;
}
```

### 1.2 Server Streaming Implementation

```go
// Server: streams all order updates matching the filter
func (s *orderServer) WatchOrders(
    req *orderv1.WatchOrdersRequest,
    stream orderv1.OrderService_WatchOrdersServer,
) error {
    ctx := stream.Context()

    // Subscribe to order events from a message bus or database CDC
    subscription, err := s.eventBus.Subscribe(ctx, req.CustomerID)
    if err != nil {
        return status.Errorf(codes.Internal, "subscription failed: %v", err)
    }
    defer subscription.Close()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case event, ok := <-subscription.Events():
            if !ok {
                // Subscription closed, send trailing metadata before returning
                stream.SetTrailer(metadata.Pairs(
                    "subscription-close-reason", "bus-closed",
                ))
                return nil
            }

            order := toProtoOrder(event)
            if err := stream.Send(order); err != nil {
                // Client disconnected or network error
                return status.Errorf(codes.Unavailable,
                    "failed to send order update: %v", err)
            }
        }
    }
}
```

### 1.3 Bidirectional Streaming Implementation

```go
// ProcessOrderStream processes a bidirectional stream of order events.
// It acknowledges each event as it is processed, allowing the client to
// send the next batch only after receiving acknowledgement.
func (s *orderServer) ProcessOrderStream(
    stream orderv1.OrderService_ProcessOrderStreamServer,
) error {
    ctx := stream.Context()
    log := s.logger.With(zap.String("method", "ProcessOrderStream"))

    // Read headers sent by the client
    if md, ok := metadata.FromIncomingContext(ctx); ok {
        if clientID := md.Get("client-id"); len(clientID) > 0 {
            log = log.With(zap.String("client_id", clientID[0]))
        }
    }

    // Send initial metadata to the client
    header := metadata.Pairs(
        "server-id", s.nodeID,
        "stream-opened", time.Now().Format(time.RFC3339),
    )
    if err := stream.SendHeader(header); err != nil {
        return status.Errorf(codes.Internal, "failed to send header: %v", err)
    }

    // Use a semaphore to limit concurrent in-flight processing
    sem := make(chan struct{}, 10)
    results := make(chan *orderv1.OrderResult, 100)
    var wg sync.WaitGroup
    var processingErr error
    var mu sync.Mutex

    // Goroutine to send results back to the client
    sendDone := make(chan struct{})
    go func() {
        defer close(sendDone)
        for result := range results {
            if err := stream.Send(result); err != nil {
                mu.Lock()
                processingErr = fmt.Errorf("send result failed: %w", err)
                mu.Unlock()
                return
            }
        }
    }()

    // Receive loop
    for {
        // Check for cancellation
        select {
        case <-ctx.Done():
            goto cleanup
        default:
        }

        // Acquire semaphore before reading next event
        select {
        case sem <- struct{}{}:
        case <-ctx.Done():
            goto cleanup
        }

        event, err := stream.Recv()
        if err == io.EOF {
            // Client has finished sending
            <-sem // release slot immediately
            break
        }
        if err != nil {
            <-sem
            mu.Lock()
            processingErr = status.Errorf(codes.Internal,
                "recv failed: %v", err)
            mu.Unlock()
            goto cleanup
        }

        wg.Add(1)
        go func(ev *orderv1.OrderEvent) {
            defer wg.Done()
            defer func() { <-sem }()

            result := s.processEvent(ctx, ev)
            select {
            case results <- result:
            case <-ctx.Done():
            }
        }(event)
    }

cleanup:
    // Wait for all in-flight processing to complete
    wg.Wait()
    close(results)
    <-sendDone

    mu.Lock()
    err := processingErr
    mu.Unlock()

    if err != nil {
        return err
    }

    // Set trailing metadata with processing summary
    stream.SetTrailer(metadata.Pairs(
        "processed-count", strconv.Itoa(s.processedCount.Load()),
    ))

    return nil
}

func (s *orderServer) processEvent(ctx context.Context, event *orderv1.OrderEvent) *orderv1.OrderResult {
    result := &orderv1.OrderResult{
        OrderId:     event.OrderId,
        ProcessedAt: timestamppb.Now(),
    }

    if err := s.processor.Process(ctx, event); err != nil {
        result.Success = false
        result.ErrorMessage = err.Error()
        return result
    }

    result.Success = true
    return result
}
```

## Section 2: Connection Keepalive Configuration

### 2.1 Understanding HTTP/2 Keepalives

gRPC runs over HTTP/2. Without keepalives, idle connections can be silently terminated by:
- Load balancers with idle timeout policies
- NAT tables with connection tracking TTLs
- Kubernetes `keepalive-timeout` settings on ingress controllers

Both client and server sides need tuning.

### 2.2 Server Keepalive Configuration

```go
package grpcserver

import (
    "net"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"
)

func NewServer(opts ...grpc.ServerOption) *grpc.Server {
    kaPolicy := keepalive.ServerParameters{
        // MaxConnectionIdle: If a client is idle for this duration,
        // send a GOAWAY to close the connection.
        MaxConnectionIdle: 15 * time.Minute,

        // MaxConnectionAge: Maximum lifetime of a connection.
        // After this, send GOAWAY; allows load balancer rebalancing.
        MaxConnectionAge: 30 * time.Minute,

        // MaxConnectionAgeGrace: After sending GOAWAY, allow this
        // much time for in-flight RPCs to complete before forcibly closing.
        MaxConnectionAgeGrace: 5 * time.Second,

        // Time: If the server detects no activity, ping the client after this.
        Time: 2 * time.Minute,

        // Timeout: Wait this long for a ping ack before considering the
        // connection dead.
        Timeout: 20 * time.Second,
    }

    kaEnforcement := keepalive.EnforcementPolicy{
        // MinTime: minimum time a client should wait before sending a ping.
        // Reject (close connection) if client pings more frequently.
        MinTime: 5 * time.Second,

        // PermitWithoutStream: allow pings even when no active streams.
        // Required when clients use keepalive.ClientParameters with
        // PermitWithoutStream: true.
        PermitWithoutStream: true,
    }

    defaultOpts := []grpc.ServerOption{
        grpc.KeepaliveParams(kaPolicy),
        grpc.KeepaliveEnforcementPolicy(kaEnforcement),
        grpc.MaxRecvMsgSize(32 * 1024 * 1024),  // 32MB
        grpc.MaxSendMsgSize(32 * 1024 * 1024),  // 32MB
        // Maximum concurrent streams per connection
        grpc.MaxConcurrentStreams(1000),
        // Read buffer size for network I/O
        grpc.ReadBufferSize(32 * 1024),
        grpc.WriteBufferSize(32 * 1024),
    }

    return grpc.NewServer(append(defaultOpts, opts...)...)
}
```

### 2.3 Client Keepalive Configuration

```go
func NewClientConnection(target string, opts ...grpc.DialOption) (*grpc.ClientConn, error) {
    kaParams := keepalive.ClientParameters{
        // Time: Send a ping if no activity for this duration.
        Time: 10 * time.Second,

        // Timeout: Wait this long for a ping ack.
        Timeout: 5 * time.Second,

        // PermitWithoutStream: Send pings even when there are no active RPCs.
        // Set true for persistent connections that may be idle between bursts.
        PermitWithoutStream: true,
    }

    defaultOpts := []grpc.DialOption{
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithKeepaliveParams(kaParams),
        grpc.WithDefaultCallOptions(
            grpc.MaxCallRecvMsgSize(32 * 1024 * 1024),
            grpc.MaxCallSendMsgSize(32 * 1024 * 1024),
        ),
        // Connection backoff policy
        grpc.WithConnectParams(grpc.ConnectParams{
            Backoff: backoff.Config{
                BaseDelay:  1 * time.Second,
                Multiplier: 1.6,
                Jitter:     0.2,
                MaxDelay:   30 * time.Second,
            },
            MinConnectTimeout: 20 * time.Second,
        }),
        // Wait for connection to be ready before sending RPCs
        grpc.WithBlock(),
    }

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    return grpc.DialContext(ctx, target, append(defaultOpts, opts...)...)
}
```

## Section 3: Interceptor Chains

### 3.1 Unary Server Interceptor

```go
package interceptors

import (
    "context"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// LoggingUnaryInterceptor logs all unary RPC calls with timing and status.
func LoggingUnaryInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        start := time.Now()

        // Extract request metadata for logging context
        var requestID string
        if md, ok := metadata.FromIncomingContext(ctx); ok {
            if ids := md.Get("x-request-id"); len(ids) > 0 {
                requestID = ids[0]
            }
        }

        log := logger.With(
            zap.String("method", info.FullMethod),
            zap.String("request_id", requestID),
        )

        resp, err := handler(ctx, req)

        duration := time.Since(start)
        st, _ := status.FromError(err)

        fields := []zap.Field{
            zap.Duration("duration", duration),
            zap.String("grpc_code", st.Code().String()),
        }

        if err != nil {
            log.Warn("RPC failed", append(fields, zap.Error(err))...)
        } else {
            log.Info("RPC completed", fields...)
        }

        return resp, err
    }
}

// TracingUnaryInterceptor adds OpenTelemetry tracing to unary RPCs.
func TracingUnaryInterceptor() grpc.UnaryServerInterceptor {
    tracer := otel.Tracer("grpc-server")

    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        ctx, span := tracer.Start(ctx, info.FullMethod)
        defer span.End()

        span.SetAttributes(
            attribute.String("rpc.system", "grpc"),
            attribute.String("rpc.method", info.FullMethod),
        )

        resp, err := handler(ctx, req)
        if err != nil {
            st, _ := status.FromError(err)
            span.SetStatus(codes.Error, st.Message())
            span.SetAttributes(
                attribute.String("rpc.grpc.status_code", st.Code().String()),
            )
        } else {
            span.SetStatus(codes.Ok, "")
        }

        return resp, err
    }
}

// RecoveryUnaryInterceptor recovers from panics in RPC handlers.
func RecoveryUnaryInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (resp interface{}, err error) {
        defer func() {
            if r := recover(); r != nil {
                logger.Error("panic in gRPC handler",
                    zap.String("method", info.FullMethod),
                    zap.Any("panic", r),
                    zap.Stack("stack"),
                )
                err = status.Errorf(codes.Internal, "internal server error")
            }
        }()
        return handler(ctx, req)
    }
}

// AuthUnaryInterceptor validates JWT bearer tokens.
func AuthUnaryInterceptor(verifier TokenVerifier) grpc.UnaryServerInterceptor {
    // Paths that don't require authentication
    skipAuth := map[string]bool{
        "/grpc.health.v1.Health/Check": true,
        "/grpc.health.v1.Health/Watch": true,
    }

    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        if skipAuth[info.FullMethod] {
            return handler(ctx, req)
        }

        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Error(codes.Unauthenticated, "missing metadata")
        }

        tokens := md.Get("authorization")
        if len(tokens) == 0 {
            return nil, status.Error(codes.Unauthenticated, "missing authorization header")
        }

        token := tokens[0]
        if len(token) < 8 || token[:7] != "Bearer " {
            return nil, status.Error(codes.Unauthenticated, "invalid authorization format")
        }

        claims, err := verifier.Verify(ctx, token[7:])
        if err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
        }

        // Add claims to context for handler access
        ctx = context.WithValue(ctx, claimsKey{}, claims)
        return handler(ctx, req)
    }
}

// RateLimitUnaryInterceptor applies per-client rate limiting.
func RateLimitUnaryInterceptor(limiter RateLimiter) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        clientID := extractClientID(ctx)

        if !limiter.Allow(clientID, info.FullMethod) {
            return nil, status.Errorf(codes.ResourceExhausted,
                "rate limit exceeded for client %q on method %q",
                clientID, info.FullMethod)
        }

        return handler(ctx, req)
    }
}

type claimsKey struct{}

type TokenVerifier interface {
    Verify(ctx context.Context, token string) (Claims, error)
}

type Claims interface {
    Subject() string
    Scopes() []string
}

type RateLimiter interface {
    Allow(clientID, method string) bool
}

func extractClientID(ctx context.Context) string {
    if md, ok := metadata.FromIncomingContext(ctx); ok {
        if ids := md.Get("x-client-id"); len(ids) > 0 {
            return ids[0]
        }
    }
    return "unknown"
}
```

### 3.2 Streaming Server Interceptor

```go
// LoggingStreamInterceptor logs streaming RPCs including per-message counts.
func LoggingStreamInterceptor(logger *zap.Logger) grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        start := time.Now()
        wrapped := newWrappedServerStream(ss)

        err := handler(srv, wrapped)

        duration := time.Since(start)
        st, _ := status.FromError(err)

        logger.Info("stream completed",
            zap.String("method", info.FullMethod),
            zap.Bool("client_streaming", info.IsClientStream),
            zap.Bool("server_streaming", info.IsServerStream),
            zap.Int32("sent", wrapped.sentCount.Load()),
            zap.Int32("received", wrapped.recvCount.Load()),
            zap.Duration("duration", duration),
            zap.String("grpc_code", st.Code().String()),
            zap.Error(err),
        )

        return err
    }
}

type wrappedServerStream struct {
    grpc.ServerStream
    sentCount atomic.Int32
    recvCount atomic.Int32
}

func newWrappedServerStream(ss grpc.ServerStream) *wrappedServerStream {
    return &wrappedServerStream{ServerStream: ss}
}

func (w *wrappedServerStream) SendMsg(m interface{}) error {
    err := w.ServerStream.SendMsg(m)
    if err == nil {
        w.sentCount.Add(1)
    }
    return err
}

func (w *wrappedServerStream) RecvMsg(m interface{}) error {
    err := w.ServerStream.RecvMsg(m)
    if err == nil {
        w.recvCount.Add(1)
    }
    return err
}
```

### 3.3 Chaining Interceptors

```go
import "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"

func BuildServer(cfg *Config, logger *zap.Logger) *grpc.Server {
    // Chain unary interceptors (executed in order)
    unaryInterceptors := []grpc.UnaryServerInterceptor{
        RecoveryUnaryInterceptor(logger),    // Always first: catches panics
        TracingUnaryInterceptor(),            // Tracing: establish span context
        LoggingUnaryInterceptor(logger),      // Logging: after tracing has span ID
        AuthUnaryInterceptor(cfg.Verifier),   // Auth: before handler logic
        RateLimitUnaryInterceptor(cfg.Limiter),
    }

    // Chain streaming interceptors
    streamInterceptors := []grpc.StreamServerInterceptor{
        LoggingStreamInterceptor(logger),
    }

    return NewServer(
        grpc.ChainUnaryInterceptor(unaryInterceptors...),
        grpc.ChainStreamInterceptor(streamInterceptors...),
    )
}
```

## Section 4: gRPC Health Checking Protocol

### 4.1 Health Service Implementation

The gRPC health checking protocol (grpc.health.v1) is the standard for liveness/readiness probes:

```go
package health

import (
    "context"
    "sync"

    "google.golang.org/grpc/codes"
    healthv1 "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/status"
)

// HealthManager manages service health state and implements the
// gRPC health checking protocol.
type HealthManager struct {
    mu       sync.RWMutex
    services map[string]healthv1.HealthCheckResponse_ServingStatus
    watchers map[string][]chan healthv1.HealthCheckResponse_ServingStatus
}

func NewHealthManager() *HealthManager {
    m := &HealthManager{
        services: make(map[string]healthv1.HealthCheckResponse_ServingStatus),
        watchers: make(map[string][]chan healthv1.HealthCheckResponse_ServingStatus),
    }
    // Set overall server status
    m.SetStatus("", healthv1.HealthCheckResponse_SERVING)
    return m
}

func (m *HealthManager) SetStatus(service string, s healthv1.HealthCheckResponse_ServingStatus) {
    m.mu.Lock()
    old := m.services[service]
    m.services[service] = s
    watchers := make([]chan healthv1.HealthCheckResponse_ServingStatus, len(m.watchers[service]))
    copy(watchers, m.watchers[service])
    m.mu.Unlock()

    if old != s {
        for _, ch := range watchers {
            select {
            case ch <- s:
            default:
            }
        }
    }
}

// Check implements the health check RPC (for Kubernetes probes and load balancers).
func (m *HealthManager) Check(ctx context.Context, req *healthv1.HealthCheckRequest) (
    *healthv1.HealthCheckResponse, error) {

    m.mu.RLock()
    s, ok := m.services[req.Service]
    m.mu.RUnlock()

    if !ok {
        return nil, status.Errorf(codes.NotFound, "service %q not found", req.Service)
    }

    return &healthv1.HealthCheckResponse{Status: s}, nil
}

// Watch implements the streaming health check RPC (for gRPC client-side LB).
func (m *HealthManager) Watch(req *healthv1.HealthCheckRequest,
    stream healthv1.Health_WatchServer) error {

    ctx := stream.Context()

    // Create a watcher channel
    ch := make(chan healthv1.HealthCheckResponse_ServingStatus, 10)

    m.mu.Lock()
    m.watchers[req.Service] = append(m.watchers[req.Service], ch)
    // Send current state immediately
    current, ok := m.services[req.Service]
    if !ok {
        current = healthv1.HealthCheckResponse_SERVICE_UNKNOWN
    }
    m.mu.Unlock()

    // Send initial state
    if err := stream.Send(&healthv1.HealthCheckResponse{Status: current}); err != nil {
        return err
    }

    defer func() {
        m.mu.Lock()
        watchers := m.watchers[req.Service]
        for i, w := range watchers {
            if w == ch {
                m.watchers[req.Service] = append(watchers[:i], watchers[i+1:]...)
                break
            }
        }
        m.mu.Unlock()
        close(ch)
    }()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case newStatus := <-ch:
            if err := stream.Send(&healthv1.HealthCheckResponse{
                Status: newStatus,
            }); err != nil {
                return err
            }
        }
    }
}
```

### 4.2 Dependency-Based Health Management

```go
// HealthController manages health state based on dependency availability.
type HealthController struct {
    manager     *HealthManager
    deps        map[string]HealthChecker
    mu          sync.Mutex
    depStatus   map[string]bool
    checkPeriod time.Duration
    logger      *zap.Logger
}

type HealthChecker interface {
    HealthCheck(ctx context.Context) error
}

func NewHealthController(manager *HealthManager, period time.Duration, logger *zap.Logger) *HealthController {
    return &HealthController{
        manager:     manager,
        deps:        make(map[string]HealthChecker),
        depStatus:   make(map[string]bool),
        checkPeriod: period,
        logger:      logger,
    }
}

func (hc *HealthController) AddDependency(name string, checker HealthChecker) {
    hc.mu.Lock()
    hc.deps[name] = checker
    hc.mu.Unlock()
}

func (hc *HealthController) Start(ctx context.Context) {
    ticker := time.NewTicker(hc.checkPeriod)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            hc.checkDependencies(ctx)
        }
    }
}

func (hc *HealthController) checkDependencies(ctx context.Context) {
    hc.mu.Lock()
    deps := make(map[string]HealthChecker, len(hc.deps))
    for k, v := range hc.deps {
        deps[k] = v
    }
    hc.mu.Unlock()

    allHealthy := true
    for name, checker := range deps {
        checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
        err := checker.HealthCheck(checkCtx)
        cancel()

        healthy := err == nil
        hc.mu.Lock()
        prev := hc.depStatus[name]
        hc.depStatus[name] = healthy
        hc.mu.Unlock()

        if !healthy {
            allHealthy = false
            if prev != healthy {
                hc.logger.Warn("dependency unhealthy",
                    zap.String("dependency", name),
                    zap.Error(err))
            }
        } else if prev != healthy {
            hc.logger.Info("dependency recovered",
                zap.String("dependency", name))
        }
    }

    var newStatus healthv1.HealthCheckResponse_ServingStatus
    if allHealthy {
        newStatus = healthv1.HealthCheckResponse_SERVING
    } else {
        newStatus = healthv1.HealthCheckResponse_NOT_SERVING
    }
    hc.manager.SetStatus("", newStatus)
}
```

### 4.3 Kubernetes Probe Configuration

```yaml
# deployment.yaml with gRPC probes
spec:
  containers:
    - name: order-service
      ports:
        - containerPort: 9000
          name: grpc
      livenessProbe:
        grpc:
          port: 9000
          service: ""  # empty = overall server health
        initialDelaySeconds: 10
        periodSeconds: 10
        failureThreshold: 3
      readinessProbe:
        grpc:
          port: 9000
          service: "order.v1.OrderService"
        initialDelaySeconds: 5
        periodSeconds: 5
        failureThreshold: 2
      startupProbe:
        grpc:
          port: 9000
        failureThreshold: 30
        periodSeconds: 2
```

## Section 5: Server Reflection API

### 5.1 Enabling Reflection

Server reflection allows tools like `grpcurl`, `grpc-client-cli`, and Postman to discover available services and their schema at runtime without needing `.proto` files.

```go
import (
    "google.golang.org/grpc/reflection"
)

func main() {
    s := BuildServer(cfg, logger)

    // Register your services
    orderv1.RegisterOrderServiceServer(s, &orderServer{})

    // Register health service
    healthManager := health.NewHealthManager()
    healthv1.RegisterHealthServer(s, healthManager)

    // Enable server reflection (disable in production if security requires it)
    if cfg.EnableReflection {
        reflection.Register(s)
    }

    lis, err := net.Listen("tcp", ":9000")
    if err != nil {
        log.Fatalf("listen: %v", err)
    }

    log.Println("gRPC server starting on :9000")
    if err := s.Serve(lis); err != nil {
        log.Fatalf("serve: %v", err)
    }
}
```

### 5.2 Using grpcurl for Development and Debugging

```bash
# List all services on the server
grpcurl -plaintext localhost:9000 list

# Describe a service
grpcurl -plaintext localhost:9000 describe order.v1.OrderService

# Describe a specific message type
grpcurl -plaintext localhost:9000 describe order.v1.OrderEvent

# Call a unary RPC
grpcurl -plaintext \
  -H "authorization: Bearer <jwt-token-placeholder>" \
  -d '{"order_id": "ord-12345"}' \
  localhost:9000 order.v1.OrderService/GetOrder

# Stream server events
grpcurl -plaintext \
  -H "authorization: Bearer <jwt-token-placeholder>" \
  -d '{"customer_id": "cust-001"}' \
  localhost:9000 order.v1.OrderService/WatchOrders

# Check health
grpcurl -plaintext localhost:9000 grpc.health.v1.Health/Check

# Check specific service health
grpcurl -plaintext \
  -d '{"service": "order.v1.OrderService"}' \
  localhost:9000 grpc.health.v1.Health/Check
```

## Section 6: Advanced gRPC Patterns

### 6.1 Metadata Propagation

```go
// Client: forward trace context and authentication
func CallWithContext(ctx context.Context, client orderv1.OrderServiceClient,
    orderID string) (*orderv1.Order, error) {

    // Build outgoing metadata
    md := metadata.New(map[string]string{
        "x-request-id": generateRequestID(),
        "x-client-id":  "payment-service",
    })

    // Propagate existing metadata (e.g., from incoming request)
    if incoming, ok := metadata.FromIncomingContext(ctx); ok {
        // Forward trace IDs
        for _, key := range []string{"traceparent", "tracestate", "baggage"} {
            if vals := incoming.Get(key); len(vals) > 0 {
                md.Set(key, vals...)
            }
        }
    }

    ctx = metadata.NewOutgoingContext(ctx, md)

    // Capture response headers and trailers
    var header, trailer metadata.MD

    resp, err := client.GetOrder(ctx,
        &orderv1.GetOrderRequest{OrderId: orderID},
        grpc.Header(&header),
        grpc.Trailer(&trailer),
    )
    if err != nil {
        return nil, err
    }

    // Log server-side correlation ID from response header
    if reqIDs := header.Get("x-request-id"); len(reqIDs) > 0 {
        log.Printf("server request ID: %s", reqIDs[0])
    }

    return resp, nil
}
```

### 6.2 Error Handling with Rich Status Details

```go
import (
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/errdetails"
)

func (s *orderServer) GetOrder(ctx context.Context, req *orderv1.GetOrderRequest) (
    *orderv1.Order, error) {

    order, err := s.store.GetOrder(ctx, req.OrderId)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            // Return rich error with request violation details
            st := status.New(codes.NotFound, "order not found")
            // Attach request info for debugging
            st, _ = st.WithDetails(
                &errdetails.RequestInfo{
                    RequestId:   req.OrderId,
                    ServingData: s.nodeID,
                },
                &errdetails.ResourceInfo{
                    ResourceType: "order",
                    ResourceName: req.OrderId,
                    Owner:        "",
                    Description:  fmt.Sprintf("Order %q does not exist", req.OrderId),
                },
            )
            return nil, st.Err()
        }

        if errors.Is(err, ErrRateLimit) {
            st := status.New(codes.ResourceExhausted, "too many requests")
            st, _ = st.WithDetails(
                &errdetails.RetryInfo{
                    RetryDelay: durationpb.New(5 * time.Second),
                },
            )
            return nil, st.Err()
        }

        return nil, status.Errorf(codes.Internal, "internal error: %v", err)
    }

    return toProtoOrder(order), nil
}

// Client: handle rich error details
func handleRichError(err error) {
    st, ok := status.FromError(err)
    if !ok {
        log.Printf("non-gRPC error: %v", err)
        return
    }

    log.Printf("gRPC error code=%s msg=%s", st.Code(), st.Message())

    for _, detail := range st.Details() {
        switch v := detail.(type) {
        case *errdetails.RetryInfo:
            delay := v.RetryDelay.AsDuration()
            log.Printf("  retry after: %v", delay)
            time.Sleep(delay)
        case *errdetails.ResourceInfo:
            log.Printf("  resource: type=%s name=%s", v.ResourceType, v.ResourceName)
        case *errdetails.RequestInfo:
            log.Printf("  request info: id=%s", v.RequestId)
        }
    }
}
```

### 6.3 Client-Side Load Balancing

```go
// Use round-robin load balancing across multiple endpoints
conn, err := grpc.Dial(
    // Use a multi-endpoint target
    "dns:///order-service.production.svc.cluster.local:9000",
    grpc.WithTransportCredentials(insecure.NewCredentials()),
    grpc.WithDefaultServiceConfig(`{
        "loadBalancingPolicy": "round_robin",
        "methodConfig": [{
            "name": [{"service": "order.v1.OrderService"}],
            "retryPolicy": {
                "maxAttempts": 4,
                "initialBackoff": "0.1s",
                "maxBackoff": "1s",
                "backoffMultiplier": 2.0,
                "retryableStatusCodes": ["UNAVAILABLE", "UNKNOWN"]
            },
            "timeout": "10s"
        }]
    }`),
)
```

## Section 7: Performance Benchmarking

### 7.1 gRPC Benchmark Tool

```bash
# Built-in gRPC benchmark tool
ghz --insecure \
    --proto order_service.proto \
    --call order.v1.OrderService.GetOrder \
    --data '{"order_id": "ord-test-001"}' \
    --rps 1000 \
    --duration 30s \
    --connections 10 \
    --concurrency 100 \
    localhost:9000

# Example output:
# Summary:
#   Count:        30000
#   Total:        30.01s
#   Slowest:      98.23ms
#   Fastest:      0.41ms
#   Average:      3.27ms
#   Requests/sec: 999.67
#
# Status code distribution:
#   [OK]   30000 responses

# Benchmark streaming
ghz --insecure \
    --proto order_service.proto \
    --call order.v1.OrderService.WatchOrders \
    --stream-interval 100ms \
    --stream-call-count 10 \
    --data '{"customer_id": "cust-001"}' \
    --connections 50 \
    --concurrency 200 \
    --duration 60s \
    localhost:9000
```

## Summary

Advanced gRPC in Go requires mastering several interdependent systems:

- **Bidirectional streaming** enables real-time event processing with flow control via semaphore-bounded goroutine pools; always handle `io.EOF` and context cancellation correctly
- **Keepalive configuration** prevents silent connection termination by load balancers; align server `MaxConnectionAge` with load balancer idle timeouts and use `PermitWithoutStream: true` for persistent clients
- **Interceptor chains** compose cross-cutting concerns in the right order: panic recovery first, then tracing, then logging, then authentication, then rate limiting
- **Health checking protocol** provides both point-in-time `Check` RPCs for Kubernetes probes and streaming `Watch` RPCs for gRPC client-side load balancers
- **Server reflection** eliminates the need to distribute `.proto` files to development tooling and enables runtime API introspection
- **Rich error details** carry structured, machine-readable context (retry delays, resource names) that clients can use for intelligent error handling

These patterns, combined, produce gRPC services that are observable, resilient, and production-ready at scale.
