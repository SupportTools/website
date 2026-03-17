---
title: "Go HTTP/2 and gRPC Server Implementation: High-Performance Service Patterns"
date: 2030-06-18T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "gRPC", "HTTP2", "Microservices", "Performance"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Go HTTP/2 and gRPC guide: server streaming, client streaming, bidirectional streaming, interceptors, health checking, reflection, and production deployment with TLS and connection management."
more_link: "yes"
url: "/go-http2-grpc-server-high-performance-service-patterns/"
---

gRPC over HTTP/2 is the dominant protocol for high-performance inter-service communication in Go microservice architectures. Its advantages over REST/JSON — strongly typed contracts, efficient Protobuf serialization, multiplexed streams over a single connection, and built-in bidirectional streaming — translate directly to lower latency and higher throughput for internal services. This guide covers complete production gRPC server implementation in Go: service definitions, all four RPC types, interceptor chains, health checking, reflection, TLS configuration, and connection management.

<!--more-->

## Protocol Buffer Service Definition

All gRPC services begin with a `.proto` file defining the service contract:

```protobuf
// proto/inventory/v1/inventory.proto
syntax = "proto3";

package inventory.v1;

option go_package = "github.com/example/platform/gen/inventory/v1;inventoryv1";

import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";

// InventoryService manages product inventory
service InventoryService {
  // Unary RPC: get a single product
  rpc GetProduct(GetProductRequest) returns (GetProductResponse);

  // Server streaming: watch a product for stock changes
  rpc WatchProduct(WatchProductRequest) returns (stream ProductEvent);

  // Client streaming: batch update multiple products
  rpc BulkUpdateStock(stream StockUpdate) returns (BulkUpdateResponse);

  // Bidirectional streaming: live inventory sync
  rpc SyncInventory(stream SyncRequest) returns (stream SyncResponse);
}

message GetProductRequest {
  string product_id = 1;
}

message GetProductResponse {
  Product product = 1;
}

message Product {
  string id = 1;
  string name = 2;
  int64 stock_quantity = 3;
  double price = 4;
  string sku = 5;
  google.protobuf.Timestamp updated_at = 6;
}

message WatchProductRequest {
  string product_id = 1;
}

message ProductEvent {
  enum EventType {
    EVENT_TYPE_UNSPECIFIED = 0;
    EVENT_TYPE_STOCK_UPDATED = 1;
    EVENT_TYPE_PRICE_UPDATED = 2;
    EVENT_TYPE_PRODUCT_DELETED = 3;
  }
  EventType event_type = 1;
  Product product = 2;
  google.protobuf.Timestamp occurred_at = 3;
}

message StockUpdate {
  string product_id = 1;
  int64 delta = 2;
  string reason = 3;
}

message BulkUpdateResponse {
  int32 succeeded = 1;
  int32 failed = 2;
  repeated string error_product_ids = 3;
}

message SyncRequest {
  string client_id = 1;
  repeated string product_ids = 2;
  int64 sequence_number = 3;
}

message SyncResponse {
  repeated Product products = 1;
  int64 sequence_number = 2;
}
```

### Code Generation

```bash
# Install protoc plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Generate Go code
protoc \
  --proto_path=proto \
  --go_out=gen \
  --go_opt=paths=source_relative \
  --go-grpc_out=gen \
  --go-grpc_opt=paths=source_relative \
  proto/inventory/v1/inventory.proto
```

## Service Implementation

### Unary RPC

```go
package service

import (
    "context"
    "fmt"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    inventoryv1 "github.com/example/platform/gen/inventory/v1"
)

type InventoryService struct {
    inventoryv1.UnimplementedInventoryServiceServer
    store ProductStore
    events EventBus
}

func NewInventoryService(store ProductStore, events EventBus) *InventoryService {
    return &InventoryService{
        store:  store,
        events: events,
    }
}

// GetProduct handles unary RPC
func (s *InventoryService) GetProduct(
    ctx context.Context,
    req *inventoryv1.GetProductRequest,
) (*inventoryv1.GetProductResponse, error) {
    if req.GetProductId() == "" {
        return nil, status.Error(codes.InvalidArgument, "product_id is required")
    }

    product, err := s.store.GetProduct(ctx, req.GetProductId())
    if err != nil {
        if isNotFound(err) {
            return nil, status.Errorf(codes.NotFound,
                "product %q not found", req.GetProductId())
        }
        return nil, status.Errorf(codes.Internal,
            "failed to retrieve product: %v", err)
    }

    return &inventoryv1.GetProductResponse{
        Product: productToProto(product),
    }, nil
}

func productToProto(p *Product) *inventoryv1.Product {
    return &inventoryv1.Product{
        Id:            p.ID,
        Name:          p.Name,
        StockQuantity: p.StockQuantity,
        Price:         p.Price,
        Sku:           p.SKU,
        UpdatedAt:     timestamppb.New(p.UpdatedAt),
    }
}
```

### Server Streaming RPC

```go
// WatchProduct streams product events to the client
func (s *InventoryService) WatchProduct(
    req *inventoryv1.WatchProductRequest,
    stream inventoryv1.InventoryService_WatchProductServer,
) error {
    productID := req.GetProductId()
    if productID == "" {
        return status.Error(codes.InvalidArgument, "product_id is required")
    }

    // Subscribe to events for this product
    eventCh, unsubscribe, err := s.events.Subscribe(stream.Context(), productID)
    if err != nil {
        return status.Errorf(codes.Internal, "failed to subscribe to events: %v", err)
    }
    defer unsubscribe()

    // Send the current state as the first event
    product, err := s.store.GetProduct(stream.Context(), productID)
    if err != nil {
        if !isNotFound(err) {
            return status.Errorf(codes.Internal, "failed to get initial state: %v", err)
        }
    } else {
        if err := stream.Send(&inventoryv1.ProductEvent{
            EventType:  inventoryv1.ProductEvent_EVENT_TYPE_STOCK_UPDATED,
            Product:    productToProto(product),
            OccurredAt: timestamppb.Now(),
        }); err != nil {
            return err // Client disconnected
        }
    }

    // Stream subsequent events
    for {
        select {
        case event, ok := <-eventCh:
            if !ok {
                return nil // Event bus closed
            }

            protoEvent := &inventoryv1.ProductEvent{
                OccurredAt: timestamppb.New(event.OccurredAt),
            }

            switch event.Type {
            case EventTypeStockUpdated:
                protoEvent.EventType = inventoryv1.ProductEvent_EVENT_TYPE_STOCK_UPDATED
            case EventTypePriceUpdated:
                protoEvent.EventType = inventoryv1.ProductEvent_EVENT_TYPE_PRICE_UPDATED
            case EventTypeProductDeleted:
                protoEvent.EventType = inventoryv1.ProductEvent_EVENT_TYPE_PRODUCT_DELETED
            }

            if event.Product != nil {
                protoEvent.Product = productToProto(event.Product)
            }

            if err := stream.Send(protoEvent); err != nil {
                // gRPC stream errors are expected when client disconnects
                return err
            }

        case <-stream.Context().Done():
            return stream.Context().Err()
        }
    }
}
```

### Client Streaming RPC

```go
// BulkUpdateStock accepts a stream of stock updates from the client
func (s *InventoryService) BulkUpdateStock(
    stream inventoryv1.InventoryService_BulkUpdateStockServer,
) error {
    var (
        succeeded    int32
        failed       int32
        errorIDs     []string
        updates      []StockUpdate
    )

    // Receive all updates from client
    for {
        update, err := stream.Recv()
        if err == io.EOF {
            // Client finished sending
            break
        }
        if err != nil {
            return status.Errorf(codes.Internal, "error receiving update: %v", err)
        }

        if update.GetProductId() == "" {
            failed++
            continue
        }

        updates = append(updates, StockUpdate{
            ProductID: update.GetProductId(),
            Delta:     update.GetDelta(),
            Reason:    update.GetReason(),
        })
    }

    // Process all updates in a batch
    results, err := s.store.BulkUpdateStock(stream.Context(), updates)
    if err != nil {
        return status.Errorf(codes.Internal, "batch update failed: %v", err)
    }

    for _, result := range results {
        if result.Error != nil {
            failed++
            errorIDs = append(errorIDs, result.ProductID)
        } else {
            succeeded++
        }
    }

    // Send single response after all updates processed
    return stream.SendAndClose(&inventoryv1.BulkUpdateResponse{
        Succeeded:      succeeded,
        Failed:         failed,
        ErrorProductIds: errorIDs,
    })
}
```

### Bidirectional Streaming RPC

```go
// SyncInventory maintains a live sync session with a client
func (s *InventoryService) SyncInventory(
    stream inventoryv1.InventoryService_SyncInventoryServer,
) error {
    ctx := stream.Context()

    // Receive/send concurrently
    errCh := make(chan error, 2)

    // Goroutine to receive requests from client
    requestCh := make(chan *inventoryv1.SyncRequest, 32)
    go func() {
        defer close(requestCh)
        for {
            req, err := stream.Recv()
            if err == io.EOF {
                errCh <- nil
                return
            }
            if err != nil {
                errCh <- err
                return
            }
            select {
            case requestCh <- req:
            case <-ctx.Done():
                errCh <- ctx.Err()
                return
            }
        }
    }()

    // Process requests and send responses
    var seqNum int64
    for {
        select {
        case req, ok := <-requestCh:
            if !ok {
                // Client closed the send side
                return nil
            }

            products, err := s.store.GetProducts(ctx, req.GetProductIds())
            if err != nil {
                return status.Errorf(codes.Internal, "failed to get products: %v", err)
            }

            seqNum++
            protoProducts := make([]*inventoryv1.Product, 0, len(products))
            for _, p := range products {
                protoProducts = append(protoProducts, productToProto(p))
            }

            if err := stream.Send(&inventoryv1.SyncResponse{
                Products:       protoProducts,
                SequenceNumber: seqNum,
            }); err != nil {
                return err
            }

        case err := <-errCh:
            return err

        case <-ctx.Done():
            return ctx.Err()
        }
    }
}
```

## Interceptors

Interceptors are the gRPC equivalent of HTTP middleware. They wrap every RPC call with cross-cutting concerns: logging, metrics, authentication, tracing, and error transformation.

### Unary Interceptor

```go
package interceptor

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "log/slog"
)

// UnaryLogging logs every unary RPC with duration and status code.
func UnaryLogging(logger *slog.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        start := time.Now()

        resp, err := handler(ctx, req)

        code := codes.OK
        if err != nil {
            code = status.Code(err)
        }

        logLevel := slog.LevelInfo
        if code != codes.OK && code != codes.NotFound && code != codes.AlreadyExists {
            logLevel = slog.LevelError
        }

        logger.Log(ctx, logLevel, "grpc request",
            slog.String("method", info.FullMethod),
            slog.String("code", code.String()),
            slog.Duration("duration", time.Since(start)),
            slog.Any("error", err),
        )

        return resp, err
    }
}

// UnaryRecovery recovers from panics in handlers and returns Internal error.
func UnaryRecovery(logger *slog.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (resp any, err error) {
        defer func() {
            if r := recover(); r != nil {
                logger.Error("panic recovered in gRPC handler",
                    slog.String("method", info.FullMethod),
                    slog.Any("panic", r),
                )
                err = status.Errorf(codes.Internal, "internal server error")
            }
        }()
        return handler(ctx, req)
    }
}

// UnaryAuth validates JWT tokens from request metadata.
func UnaryAuth(validator TokenValidator) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Skip auth for health check methods
        if isHealthCheckMethod(info.FullMethod) {
            return handler(ctx, req)
        }

        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Error(codes.Unauthenticated, "no metadata in request")
        }

        authHeader := md.Get("authorization")
        if len(authHeader) == 0 {
            return nil, status.Error(codes.Unauthenticated, "authorization header required")
        }

        token := strings.TrimPrefix(authHeader[0], "Bearer ")
        claims, err := validator.ValidateToken(ctx, token)
        if err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
        }

        // Add claims to context for downstream use
        ctx = withClaims(ctx, claims)
        return handler(ctx, req)
    }
}

// UnaryRateLimit applies per-method rate limiting.
func UnaryRateLimit(limiter RateLimiter) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        if !limiter.Allow(info.FullMethod) {
            return nil, status.Error(codes.ResourceExhausted,
                "rate limit exceeded; please retry later")
        }
        return handler(ctx, req)
    }
}
```

### Stream Interceptor

```go
// StreamLogging logs stream RPC lifecycle events.
func StreamLogging(logger *slog.Logger) grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        start := time.Now()

        logger.Info("grpc stream started",
            slog.String("method", info.FullMethod),
            slog.Bool("client_stream", info.IsClientStream),
            slog.Bool("server_stream", info.IsServerStream),
        )

        err := handler(srv, ss)

        code := codes.OK
        if err != nil {
            code = status.Code(err)
        }

        logger.Info("grpc stream completed",
            slog.String("method", info.FullMethod),
            slog.String("code", code.String()),
            slog.Duration("duration", time.Since(start)),
            slog.Any("error", err),
        )

        return err
    }
}
```

## Server Construction

### Production Server Setup

```go
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/reflection"
    "log/slog"

    inventoryv1 "github.com/example/platform/gen/inventory/v1"
    "github.com/example/platform/internal/interceptor"
    "github.com/example/platform/internal/service"
)

func main() {
    logger := setupLogger()

    // Load TLS credentials
    tlsCert, err := tls.LoadX509KeyPair("/etc/tls/tls.crt", "/etc/tls/tls.key")
    if err != nil {
        logger.Error("failed to load TLS credentials", slog.Any("error", err))
        os.Exit(1)
    }
    creds := credentials.NewTLS(&tls.Config{
        Certificates: []tls.Certificate{tlsCert},
        MinVersion:   tls.VersionTLS13,
        // Client certificate required for mTLS
        ClientAuth: tls.RequireAndVerifyClientCert,
    })

    // Build interceptor chain
    unaryInterceptors := grpc.ChainUnaryInterceptor(
        interceptor.UnaryRecovery(logger),
        interceptor.UnaryLogging(logger),
        interceptor.UnaryAuth(tokenValidator),
        interceptor.UnaryRateLimit(limiter),
    )

    streamInterceptors := grpc.ChainStreamInterceptor(
        interceptor.StreamLogging(logger),
    )

    // Configure server options
    serverOpts := []grpc.ServerOption{
        grpc.Creds(creds),
        unaryInterceptors,
        streamInterceptors,

        // Keep-alive: send pings to detect dead connections
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle:     15 * time.Minute,
            MaxConnectionAge:      30 * time.Minute,
            MaxConnectionAgeGrace: 5 * time.Second,
            Time:                  5 * time.Second,
            Timeout:               1 * time.Second,
        }),

        // Keep-alive enforcement policy
        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            MinTime:             5 * time.Second,
            PermitWithoutStream: true,
        }),

        // Message size limits
        grpc.MaxRecvMsgSize(4 * 1024 * 1024),  // 4 MiB
        grpc.MaxSendMsgSize(4 * 1024 * 1024),  // 4 MiB

        // Connection concurrency
        grpc.MaxConcurrentStreams(1000),

        // Initial window sizes for flow control
        grpc.InitialWindowSize(65536),
        grpc.InitialConnWindowSize(1048576),
    }

    server := grpc.NewServer(serverOpts...)

    // Register services
    inventorySvc := service.NewInventoryService(store, eventBus)
    inventoryv1.RegisterInventoryServiceServer(server, inventorySvc)

    // Register health checking service
    healthSvc := health.NewServer()
    grpc_health_v1.RegisterHealthServer(server, healthSvc)

    // Mark service as serving
    healthSvc.SetServingStatus("inventory.v1.InventoryService", grpc_health_v1.HealthCheckResponse_SERVING)

    // Register reflection service (for grpcurl, Postman, etc.)
    // Disable in strict production environments where service discovery is controlled
    if os.Getenv("GRPC_REFLECTION") == "true" {
        reflection.Register(server)
    }

    // Start listener
    listener, err := net.Listen("tcp", ":50051")
    if err != nil {
        logger.Error("failed to listen", slog.Any("error", err))
        os.Exit(1)
    }

    // Graceful shutdown
    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    go func() {
        logger.Info("gRPC server starting", slog.String("addr", ":50051"))
        if err := server.Serve(listener); err != nil {
            logger.Error("server error", slog.Any("error", err))
        }
    }()

    <-ctx.Done()
    logger.Info("shutdown signal received")

    // Mark service as not serving during shutdown
    healthSvc.SetServingStatus("inventory.v1.InventoryService",
        grpc_health_v1.HealthCheckResponse_NOT_SERVING)

    // Graceful stop: wait for in-flight RPCs to complete
    gracefulDone := make(chan struct{})
    go func() {
        server.GracefulStop()
        close(gracefulDone)
    }()

    select {
    case <-gracefulDone:
        logger.Info("graceful shutdown completed")
    case <-time.After(30 * time.Second):
        logger.Warn("graceful shutdown timed out, forcing stop")
        server.Stop()
    }
}
```

## Health Checking

### Implementing the Health Protocol

The gRPC health checking protocol is supported by Kubernetes liveness and readiness probes:

```go
// Health check with dependency verification
func setupHealthChecker(healthSvc *health.Server, store ProductStore, cache Cache) {
    go func() {
        ticker := time.NewTicker(10 * time.Second)
        defer ticker.Stop()

        for range ticker.C {
            // Check store connectivity
            storeHealthy := store.Ping(context.Background()) == nil
            // Check cache connectivity
            cacheHealthy := cache.Ping(context.Background()) == nil

            if storeHealthy && cacheHealthy {
                healthSvc.SetServingStatus(
                    "inventory.v1.InventoryService",
                    grpc_health_v1.HealthCheckResponse_SERVING,
                )
            } else {
                healthSvc.SetServingStatus(
                    "inventory.v1.InventoryService",
                    grpc_health_v1.HealthCheckResponse_NOT_SERVING,
                )
            }
        }
    }()
}
```

### Kubernetes Probe Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-service
spec:
  template:
    spec:
      containers:
        - name: inventory-service
          image: inventory-service:v2.1.0
          ports:
            - containerPort: 50051
              name: grpc
            - containerPort: 8080
              name: http-metrics
          livenessProbe:
            grpc:
              port: 50051
              service: inventory.v1.InventoryService
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            grpc:
              port: 50051
              service: inventory.v1.InventoryService
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 2
```

## Client Implementation

### Connection Pool Management

```go
package client

import (
    "crypto/tls"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"

    inventoryv1 "github.com/example/platform/gen/inventory/v1"
)

// InventoryClient wraps the gRPC client with connection lifecycle management.
type InventoryClient struct {
    conn   *grpc.ClientConn
    client inventoryv1.InventoryServiceClient
}

func NewInventoryClient(target string, tlsEnabled bool) (*InventoryClient, error) {
    opts := []grpc.DialOption{
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second,
            Timeout:             3 * time.Second,
            PermitWithoutStream: false,
        }),

        // Client-side retry policy
        grpc.WithDefaultServiceConfig(`{
            "methodConfig": [{
                "name": [{"service": "inventory.v1.InventoryService"}],
                "waitForReady": true,
                "retryPolicy": {
                    "maxAttempts": 4,
                    "initialBackoff": "0.1s",
                    "maxBackoff": "1s",
                    "backoffMultiplier": 2.0,
                    "retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
                }
            }]
        }`),
    }

    if tlsEnabled {
        creds := credentials.NewTLS(&tls.Config{
            InsecureSkipVerify: false,
            MinVersion:         tls.VersionTLS13,
        })
        opts = append(opts, grpc.WithTransportCredentials(creds))
    } else {
        opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()))
    }

    conn, err := grpc.NewClient(target, opts...)
    if err != nil {
        return nil, fmt.Errorf("failed to create gRPC client: %w", err)
    }

    return &InventoryClient{
        conn:   conn,
        client: inventoryv1.NewInventoryServiceClient(conn),
    }, nil
}

func (c *InventoryClient) Close() error {
    return c.conn.Close()
}

// GetProduct calls the unary RPC with context timeout.
func (c *InventoryClient) GetProduct(ctx context.Context, productID string) (*inventoryv1.Product, error) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    resp, err := c.client.GetProduct(ctx, &inventoryv1.GetProductRequest{
        ProductId: productID,
    })
    if err != nil {
        return nil, err
    }
    return resp.GetProduct(), nil
}
```

## gRPC-Web and HTTP/2 Gateway

For browser clients, gRPC-Web provides a compatible subset of the protocol over standard HTTP/1.1 and HTTP/2:

```go
package main

import (
    "net/http"

    "github.com/improbable-eng/grpc-web/go/grpcweb"
    "google.golang.org/grpc"
)

func setupGRPCWebProxy(grpcServer *grpc.Server) http.Handler {
    wrapped := grpcweb.WrapServer(grpcServer,
        grpcweb.WithOriginFunc(func(origin string) bool {
            // Restrict to known origins in production
            allowed := map[string]bool{
                "https://app.example.com":    true,
                "https://admin.example.com":  true,
            }
            return allowed[origin]
        }),
        grpcweb.WithAllowedRequestHeaders([]string{
            "authorization",
            "content-type",
            "x-request-id",
        }),
    )
    return wrapped
}
```

## Testing gRPC Services

### Unit Testing with Bufconn

```go
package service_test

import (
    "context"
    "net"
    "testing"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/test/bufconn"

    inventoryv1 "github.com/example/platform/gen/inventory/v1"
    "github.com/example/platform/internal/service"
)

const bufSize = 1024 * 1024

func setupTestServer(t *testing.T) (inventoryv1.InventoryServiceClient, func()) {
    t.Helper()

    // In-memory listener
    lis := bufconn.Listen(bufSize)

    // Real server with fake dependencies
    store := NewMockProductStore()
    eventBus := NewMockEventBus()
    svc := service.NewInventoryService(store, eventBus)

    server := grpc.NewServer()
    inventoryv1.RegisterInventoryServiceServer(server, svc)

    go server.Serve(lis)

    // Connect using bufconn dialer
    conn, err := grpc.NewClient(
        "passthrough:///bufnet",
        grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
            return lis.DialContext(ctx)
        }),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        t.Fatalf("failed to connect: %v", err)
    }

    client := inventoryv1.NewInventoryServiceClient(conn)

    cleanup := func() {
        conn.Close()
        server.Stop()
        lis.Close()
    }

    return client, cleanup
}

func TestGetProduct_Found(t *testing.T) {
    client, cleanup := setupTestServer(t)
    defer cleanup()

    ctx := context.Background()
    resp, err := client.GetProduct(ctx, &inventoryv1.GetProductRequest{
        ProductId: "prod-123",
    })
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }

    if resp.GetProduct().GetId() != "prod-123" {
        t.Errorf("expected product ID prod-123, got %s", resp.GetProduct().GetId())
    }
}

func TestGetProduct_NotFound(t *testing.T) {
    client, cleanup := setupTestServer(t)
    defer cleanup()

    ctx := context.Background()
    _, err := client.GetProduct(ctx, &inventoryv1.GetProductRequest{
        ProductId: "nonexistent",
    })

    if status.Code(err) != codes.NotFound {
        t.Errorf("expected NotFound, got %v", status.Code(err))
    }
}
```

## Metrics and Observability

### Prometheus gRPC Metrics

```go
import (
    grpc_prometheus "github.com/grpc-ecosystem/go-grpc-prometheus"
)

// Add metrics interceptors
serverOpts = append(serverOpts,
    grpc.ChainUnaryInterceptor(
        grpc_prometheus.UnaryServerInterceptor,
    ),
    grpc.ChainStreamInterceptor(
        grpc_prometheus.StreamServerInterceptor,
    ),
)

// Enable detailed histograms for latency tracking
grpc_prometheus.EnableHandlingTimeHistogram(
    grpc_prometheus.WithHistogramBuckets(
        []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
    ),
)

// Register Prometheus metrics after all services are registered
grpc_prometheus.Register(server)
```

## Summary

Production Go gRPC services require attention across multiple dimensions: service definition quality (clear, versioned proto contracts), all four RPC types used appropriately (unary for request-response, server streaming for live updates, client streaming for ingestion, bidirectional for sync), layered interceptors for cross-cutting concerns, and proper connection management with keep-alive and graceful shutdown.

Key operational considerations:

- Use `grpc.ChainUnaryInterceptor` to compose multiple interceptors in predictable order
- Always register the gRPC health service and configure Kubernetes probes against it
- Enable reflection only in development or controlled environments
- Configure keep-alive parameters to match your load balancer and network topology
- Test with `bufconn` for fast, isolated unit tests without network overhead
- Add `grpc_prometheus` interceptors for standard request rate, error rate, and latency metrics

These patterns produce gRPC services that are reliable under production load, observable through standard tooling, and operationally straightforward to manage.
