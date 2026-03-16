---
title: "Go Microservices with gRPC: Service Definition, Streaming, and Production Patterns"
date: 2027-07-20T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Microservices", "Protobuf", "Production"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production-grade Go microservices with gRPC, covering Protobuf schema design, streaming RPCs, interceptors, health checks, connection pooling, gRPC-gateway, and Kubernetes deployment."
more_link: "yes"
url: "/go-microservices-grpc-production-guide/"
---

gRPC has become the dominant inter-service communication protocol for high-performance microservices. Its combination of strongly-typed contracts via Protocol Buffers, HTTP/2 multiplexing, and first-class streaming support makes it an excellent choice for Go services that must communicate at scale. This guide covers the full production journey from schema design through Kubernetes deployment, including the operational patterns that separate hobby projects from production systems.

<!--more-->

# [Go Microservices with gRPC](#go-microservices-grpc)

## Section 1: Protobuf Schema Design

Schema design is the most consequential decision in a gRPC service. Poor schema design forces painful migrations later; thoughtful schema design enables evolution without breaking clients.

### File Organization

Organize `.proto` files to mirror the domain boundary of each service. Use a top-level `proto/` directory with versioned subdirectories:

```
proto/
  inventory/
    v1/
      inventory.proto
      types.proto
  orders/
    v1/
      orders.proto
```

### A Practical Inventory Service Schema

```protobuf
syntax = "proto3";

package inventory.v1;

option go_package = "github.com/example/services/gen/inventory/v1;inventoryv1";

import "google/protobuf/timestamp.proto";
import "google/protobuf/field_mask.proto";

// Item represents a stocked product in the warehouse.
message Item {
  string  id          = 1;
  string  sku         = 2;
  string  name        = 3;
  int64   quantity    = 4;
  string  location    = 5;
  google.protobuf.Timestamp updated_at = 6;
}

message GetItemRequest {
  string id = 1;
}

message GetItemResponse {
  Item item = 1;
}

message UpdateItemRequest {
  Item                        item        = 1;
  google.protobuf.FieldMask   update_mask = 2;
}

message UpdateItemResponse {
  Item item = 1;
}

message WatchItemsRequest {
  repeated string ids = 1;
}

message ItemEvent {
  enum EventType {
    EVENT_TYPE_UNSPECIFIED = 0;
    EVENT_TYPE_UPDATED     = 1;
    EVENT_TYPE_DELETED     = 2;
  }
  EventType event_type = 1;
  Item      item       = 2;
}

service InventoryService {
  rpc GetItem    (GetItemRequest)    returns (GetItemResponse);
  rpc UpdateItem (UpdateItemRequest) returns (UpdateItemResponse);
  // Server-side streaming: pushes item events as they occur.
  rpc WatchItems (WatchItemsRequest) returns (stream ItemEvent);
  // Bidirectional streaming: bulk reconciliation.
  rpc ReconcileItems (stream Item) returns (stream ItemEvent);
}
```

### Schema Evolution Rules

Follow these rules to keep schemas backward-compatible:

- Never reuse a field number once it has been used — tombstone it with `reserved`.
- Never rename a field without an alias strategy — field names matter in JSON transcoding.
- Add new fields with higher field numbers; never insert between existing ones.
- Use `FieldMask` for partial updates rather than nullable wrappers on every field.
- Prefer `oneof` for mutually exclusive fields over parallel optional fields.

```protobuf
// Correct: tombstoning deprecated field number and name
message Item {
  reserved 7;
  reserved "legacy_barcode";
  string id  = 1;
  // ...
}
```

## Section 2: Code Generation and Project Structure

### Buf for Reproducible Generation

[Buf](https://buf.build) supersedes raw `protoc` invocations with linting, breaking-change detection, and reproducible builds.

```yaml
# buf.yaml
version: v2
modules:
  - path: proto
deps:
  - buf.build/googleapis/googleapis
lint:
  use:
    - DEFAULT
breaking:
  use:
    - FILE
```

```yaml
# buf.gen.yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go
    out: gen
    opt:
      - paths=source_relative
  - remote: buf.build/grpc/go
    out: gen
    opt:
      - paths=source_relative
      - require_unimplemented_servers=false
```

Generate code with:

```bash
buf generate
```

Lint and check for breaking changes:

```bash
buf lint
buf breaking --against '.git#branch=main'
```

### Generated Code Layout

After generation the `gen/` tree mirrors `proto/`:

```
gen/
  inventory/
    v1/
      inventory.pb.go
      inventory_grpc.pb.go
```

The `_grpc.pb.go` file contains the `InventoryServiceClient` interface, `InventoryServiceServer` interface, and `UnimplementedInventoryServiceServer` struct that satisfies the interface with safe no-op defaults.

## Section 3: Implementing the gRPC Server

### Server Implementation

```go
package inventorysvc

import (
    "context"
    "fmt"
    "sync"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    inventoryv1 "github.com/example/services/gen/inventory/v1"
)

// Server implements inventoryv1.InventoryServiceServer.
type Server struct {
    inventoryv1.UnimplementedInventoryServiceServer

    mu    sync.RWMutex
    items map[string]*inventoryv1.Item

    // subscribers receive item events from WatchItems.
    subsMu sync.Mutex
    subs   map[string][]chan *inventoryv1.ItemEvent
}

func NewServer() *Server {
    return &Server{
        items: make(map[string]*inventoryv1.Item),
        subs:  make(map[string][]chan *inventoryv1.ItemEvent),
    }
}

func (s *Server) GetItem(ctx context.Context, req *inventoryv1.GetItemRequest) (*inventoryv1.GetItemResponse, error) {
    if req.GetId() == "" {
        return nil, status.Error(codes.InvalidArgument, "id is required")
    }

    s.mu.RLock()
    item, ok := s.items[req.GetId()]
    s.mu.RUnlock()

    if !ok {
        return nil, status.Errorf(codes.NotFound, "item %q not found", req.GetId())
    }

    return &inventoryv1.GetItemResponse{Item: item}, nil
}

func (s *Server) UpdateItem(ctx context.Context, req *inventoryv1.UpdateItemRequest) (*inventoryv1.UpdateItemResponse, error) {
    item := req.GetItem()
    if item == nil {
        return nil, status.Error(codes.InvalidArgument, "item is required")
    }
    if item.GetId() == "" {
        return nil, status.Error(codes.InvalidArgument, "item.id is required")
    }

    item.UpdatedAt = timestamppb.Now()

    s.mu.Lock()
    s.items[item.GetId()] = item
    s.mu.Unlock()

    // Notify subscribers.
    go s.broadcast(item.GetId(), &inventoryv1.ItemEvent{
        EventType: inventoryv1.ItemEvent_EVENT_TYPE_UPDATED,
        Item:      item,
    })

    return &inventoryv1.UpdateItemResponse{Item: item}, nil
}

func (s *Server) WatchItems(req *inventoryv1.WatchItemsRequest, stream inventoryv1.InventoryService_WatchItemsServer) error {
    ch := make(chan *inventoryv1.ItemEvent, 64)

    for _, id := range req.GetIds() {
        s.subscribe(id, ch)
    }
    defer func() {
        for _, id := range req.GetIds() {
            s.unsubscribe(id, ch)
        }
    }()

    for {
        select {
        case <-stream.Context().Done():
            return status.FromContextError(stream.Context().Err()).Err()
        case evt, ok := <-ch:
            if !ok {
                return nil
            }
            if err := stream.Send(evt); err != nil {
                return err
            }
        }
    }
}

func (s *Server) subscribe(id string, ch chan *inventoryv1.ItemEvent) {
    s.subsMu.Lock()
    s.subs[id] = append(s.subs[id], ch)
    s.subsMu.Unlock()
}

func (s *Server) unsubscribe(id string, ch chan *inventoryv1.ItemEvent) {
    s.subsMu.Lock()
    defer s.subsMu.Unlock()
    chans := s.subs[id]
    for i, c := range chans {
        if c == ch {
            s.subs[id] = append(chans[:i], chans[i+1:]...)
            return
        }
    }
}

func (s *Server) broadcast(id string, evt *inventoryv1.ItemEvent) {
    s.subsMu.Lock()
    chans := make([]chan *inventoryv1.ItemEvent, len(s.subs[id]))
    copy(chans, s.subs[id])
    s.subsMu.Unlock()

    for _, ch := range chans {
        select {
        case ch <- evt:
        default:
            // Drop event for slow consumer rather than blocking.
        }
    }
}

// Ensure compile-time interface satisfaction.
var _ inventoryv1.InventoryServiceServer = (*Server)(nil)
```

### Main Entry Point

```go
package main

import (
    "fmt"
    "net"
    "os"
    "os/signal"
    "syscall"

    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/reflection"

    inventoryv1 "github.com/example/services/gen/inventory/v1"
    "github.com/example/services/internal/inventorysvc"
    "github.com/example/services/internal/middleware"
)

func main() {
    log, _ := zap.NewProduction()
    defer log.Sync()

    addr := ":50051"
    lis, err := net.Listen("tcp", addr)
    if err != nil {
        log.Fatal("failed to listen", zap.Error(err))
    }

    srv := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            middleware.UnaryLogging(log),
            middleware.UnaryRecovery(log),
            middleware.UnaryAuth(),
            middleware.UnaryMetrics(),
        ),
        grpc.ChainStreamInterceptor(
            middleware.StreamLogging(log),
            middleware.StreamRecovery(log),
            middleware.StreamAuth(),
        ),
        grpc.MaxRecvMsgSize(4*1024*1024), // 4 MB
        grpc.MaxSendMsgSize(4*1024*1024),
    )

    // Business service.
    inventoryv1.RegisterInventoryServiceServer(srv, inventorysvc.NewServer())

    // Standard health protocol.
    healthSrv := health.NewServer()
    grpc_health_v1.RegisterHealthServer(srv, healthSrv)
    healthSrv.SetServingStatus("inventory.v1.InventoryService", grpc_health_v1.HealthCheckResponse_SERVING)

    // Reflection for grpcurl/Evans in non-production environments.
    if os.Getenv("GRPC_REFLECTION") == "true" {
        reflection.Register(srv)
    }

    go func() {
        log.Info("gRPC server listening", zap.String("addr", addr))
        if err := srv.Serve(lis); err != nil {
            log.Fatal("serve error", zap.Error(err))
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    log.Info("graceful shutdown initiated")
    srv.GracefulStop()
    log.Info("server stopped")
}
```

## Section 4: Interceptors for Logging, Auth, and Tracing

Interceptors are middleware for gRPC. Unary interceptors wrap single request-response RPCs; stream interceptors wrap streaming RPCs.

### Logging Interceptor

```go
package middleware

import (
    "context"
    "time"

    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/status"
)

func UnaryLogging(log *zap.Logger) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
        start := time.Now()
        resp, err := handler(ctx, req)
        st, _ := status.FromError(err)

        log.Info("unary rpc",
            zap.String("method", info.FullMethod),
            zap.Duration("duration", time.Since(start)),
            zap.String("code", st.Code().String()),
        )
        return resp, err
    }
}

func StreamLogging(log *zap.Logger) grpc.StreamServerInterceptor {
    return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
        start := time.Now()
        err := handler(srv, ss)
        st, _ := status.FromError(err)

        log.Info("stream rpc",
            zap.String("method", info.FullMethod),
            zap.Duration("duration", time.Since(start)),
            zap.String("code", st.Code().String()),
        )
        return err
    }
}
```

### Recovery Interceptor

```go
func UnaryRecovery(log *zap.Logger) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
        defer func() {
            if r := recover(); r != nil {
                log.Error("panic in unary handler",
                    zap.String("method", info.FullMethod),
                    zap.Any("panic", r),
                )
                err = status.Errorf(codes.Internal, "internal server error")
            }
        }()
        return handler(ctx, req)
    }
}
```

### JWT Auth Interceptor

```go
import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// skipAuthMethods lists RPCs that do not require authentication.
var skipAuthMethods = map[string]bool{
    "/grpc.health.v1.Health/Check": true,
}

func UnaryAuth() grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
        if skipAuthMethods[info.FullMethod] {
            return handler(ctx, req)
        }
        if err := validateToken(ctx); err != nil {
            return nil, err
        }
        return handler(ctx, req)
    }
}

func validateToken(ctx context.Context) error {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return status.Error(codes.Unauthenticated, "missing metadata")
    }
    values := md.Get("authorization")
    if len(values) == 0 {
        return status.Error(codes.Unauthenticated, "missing authorization header")
    }
    token := values[0]
    // TODO: Validate JWT signature against your JWKS endpoint.
    if token == "" {
        return status.Error(codes.Unauthenticated, "invalid token")
    }
    return nil
}
```

### Metrics Interceptor (Prometheus)

```go
import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    rpcDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "grpc_server_duration_seconds",
        Help:    "Duration of gRPC server calls.",
        Buckets: prometheus.DefBuckets,
    }, []string{"method", "code"})
)

func UnaryMetrics() grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
        start := time.Now()
        resp, err := handler(ctx, req)
        st, _ := status.FromError(err)
        rpcDuration.WithLabelValues(info.FullMethod, st.Code().String()).
            Observe(time.Since(start).Seconds())
        return resp, err
    }
}
```

## Section 5: Client-Side Patterns

### Connection Pooling and Load Balancing

gRPC connections use HTTP/2 multiplexing, so a single connection can handle many concurrent streams. For client-to-server scenarios the recommended pattern is a single `*grpc.ClientConn` per target shared across goroutines.

```go
package inventoryclient

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/balancer/roundrobin"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"

    inventoryv1 "github.com/example/services/gen/inventory/v1"
)

func NewConn(target string) (*grpc.ClientConn, error) {
    return grpc.NewClient(
        target,
        grpc.WithTransportCredentials(insecure.NewCredentials()), // Use TLS in production.
        grpc.WithDefaultServiceConfig(`{"loadBalancingPolicy":"round_robin"}`),
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second,
            Timeout:             5 * time.Second,
            PermitWithoutStream: true,
        }),
        grpc.WithChainUnaryInterceptor(
            clientUnaryLogging(),
            clientUnaryRetry(),
        ),
    )
}

// Client wraps the generated stub with higher-level helpers.
type Client struct {
    stub inventoryv1.InventoryServiceClient
}

func New(conn *grpc.ClientConn) *Client {
    return &Client{stub: inventoryv1.NewInventoryServiceClient(conn)}
}

func (c *Client) GetItem(ctx context.Context, id string) (*inventoryv1.Item, error) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    resp, err := c.stub.GetItem(ctx, &inventoryv1.GetItemRequest{Id: id})
    if err != nil {
        return nil, err
    }
    return resp.GetItem(), nil
}
```

### Deadlines and Cancellation

Always attach a deadline to outbound RPCs. Never rely on the server to enforce timeouts from the client's perspective.

```go
// Per-call timeout derived from context budget.
func callWithBudget(ctx context.Context, client *Client, id string) (*inventoryv1.Item, error) {
    // Respect any deadline already set by the caller while capping at 3 s.
    if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 3*time.Second {
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, 3*time.Second)
        defer cancel()
    }
    return client.GetItem(ctx, id)
}
```

### Error Status Codes

Map gRPC status codes to appropriate actions in the client:

```go
import (
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

func handleRPCError(err error) {
    st := status.Convert(err)
    switch st.Code() {
    case codes.NotFound:
        // Cache miss or item deleted — treat as absence.
    case codes.InvalidArgument:
        // Caller bug — do not retry.
    case codes.Unavailable, codes.DeadlineExceeded:
        // Transient — eligible for retry with backoff.
    case codes.PermissionDenied, codes.Unauthenticated:
        // Credentials problem — refresh token then retry once.
    case codes.ResourceExhausted:
        // Rate limited — back off significantly.
    case codes.Internal, codes.Unknown:
        // Server-side bug — log and alert.
    }
}
```

## Section 6: gRPC-Gateway REST Bridging

gRPC-gateway generates a reverse-proxy that translates RESTful HTTP/JSON calls into gRPC. This enables a single Protobuf definition to serve both gRPC and REST clients.

### Annotating the Proto

```protobuf
import "google/api/annotations.proto";

service InventoryService {
  rpc GetItem (GetItemRequest) returns (GetItemResponse) {
    option (google.api.http) = {
      get: "/v1/items/{id}"
    };
  }

  rpc UpdateItem (UpdateItemRequest) returns (UpdateItemResponse) {
    option (google.api.http) = {
      patch: "/v1/items/{item.id}"
      body: "item"
    };
  }
}
```

Add to `buf.gen.yaml`:

```yaml
  - remote: buf.build/grpc-ecosystem/gateway
    out: gen
    opt:
      - paths=source_relative
      - generate_unbound_methods=true
  - remote: buf.build/grpc-ecosystem/openapiv2
    out: gen/openapi
```

### Gateway Server

```go
package main

import (
    "context"
    "net/http"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"

    inventoryv1 "github.com/example/services/gen/inventory/v1"
)

func runGateway(ctx context.Context, grpcAddr string) error {
    mux := runtime.NewServeMux(
        runtime.WithErrorHandler(runtime.DefaultHTTPErrorHandler),
        runtime.WithIncomingHeaderMatcher(func(key string) (string, bool) {
            switch key {
            case "X-Request-Id":
                return key, true
            default:
                return runtime.DefaultHeaderMatcher(key)
            }
        }),
    )

    opts := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
    if err := inventoryv1.RegisterInventoryServiceHandlerFromEndpoint(ctx, mux, grpcAddr, opts); err != nil {
        return err
    }

    return http.ListenAndServe(":8080", mux)
}
```

## Section 7: Health Check Protocol

gRPC defines a standard health checking protocol (`grpc.health.v1`). Kubernetes probes can target this endpoint directly using `grpc` probe type (available since Kubernetes 1.24).

```yaml
# Kubernetes deployment snippet
livenessProbe:
  grpc:
    port: 50051
    service: "inventory.v1.InventoryService"
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  grpc:
    port: 50051
    service: "inventory.v1.InventoryService"
  initialDelaySeconds: 3
  periodSeconds: 5
```

For clusters running Kubernetes < 1.24, use grpc_health_probe as an exec probe:

```yaml
livenessProbe:
  exec:
    command:
      - /bin/grpc_health_probe
      - -addr=:50051
      - -service=inventory.v1.InventoryService
  initialDelaySeconds: 5
  periodSeconds: 10
```

## Section 8: Debugging with grpcurl and Reflection

When `GRPC_REFLECTION=true` is set (typically in dev/staging), `grpcurl` provides curl-equivalent introspection:

```bash
# List all services registered on the server.
grpcurl -plaintext localhost:50051 list

# Describe a service and its methods.
grpcurl -plaintext localhost:50051 describe inventory.v1.InventoryService

# Unary call with JSON body.
grpcurl -plaintext -d '{"id":"item-42"}' \
  localhost:50051 inventory.v1.InventoryService/GetItem

# Server streaming — prints each event as JSON.
grpcurl -plaintext -d '{"ids":["item-1","item-2"]}' \
  localhost:50051 inventory.v1.InventoryService/WatchItems

# Include metadata (auth header).
grpcurl -plaintext \
  -H 'authorization: Bearer TOKEN_VALUE' \
  -d '{"id":"item-42"}' \
  localhost:50051 inventory.v1.InventoryService/GetItem
```

Restrict reflection to internal networks via an interceptor that checks caller IP:

```go
func UnaryReflectionGuard() grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
        if strings.HasPrefix(info.FullMethod, "/grpc.reflection.") {
            p, ok := peer.FromContext(ctx)
            if !ok || !isInternalAddr(p.Addr.String()) {
                return nil, status.Error(codes.PermissionDenied, "reflection restricted to internal network")
            }
        }
        return handler(ctx, req)
    }
}
```

## Section 9: Production Deployment on Kubernetes

### Helm Chart Values

```yaml
# values.yaml
replicaCount: 3

image:
  repository: registry.example.com/inventory-service
  tag: ""  # overridden per release
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  grpcPort: 50051
  httpPort: 8080   # gRPC-gateway

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

env:
  GRPC_REFLECTION: "false"
  LOG_LEVEL: "info"

podDisruptionBudget:
  minAvailable: 2

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 20
  targetCPUUtilizationPercentage: 60
```

### Service and Ingress

```yaml
apiVersion: v1
kind: Service
metadata:
  name: inventory-service
spec:
  selector:
    app: inventory-service
  ports:
    - name: grpc
      port: 50051
      targetPort: 50051
      protocol: TCP
    - name: http
      port: 8080
      targetPort: 8080
      protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: inventory-gateway
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /v1/items
            pathType: Prefix
            backend:
              service:
                name: inventory-service
                port:
                  number: 8080
```

For gRPC traffic from external clients, use the `nginx.ingress.kubernetes.io/backend-protocol: "GRPC"` annotation and ensure TLS termination:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: inventory-grpc
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "GRPC"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  tls:
    - hosts:
        - grpc.example.com
      secretName: grpc-tls-secret
  rules:
    - host: grpc.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: inventory-service
                port:
                  number: 50051
```

## Section 10: Performance Tuning

### gRPC Server Options

```go
srv := grpc.NewServer(
    // Increase window sizes for high-throughput streams.
    grpc.InitialWindowSize(1 << 20),          // 1 MB per-stream
    grpc.InitialConnWindowSize(1 << 23),       // 8 MB per-connection
    grpc.MaxConcurrentStreams(500),
    grpc.MaxRecvMsgSize(8 * 1024 * 1024),
    grpc.MaxSendMsgSize(8 * 1024 * 1024),
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
)
```

### Protobuf Serialization Pool

For hot paths with frequent serialization of the same message types, use a sync.Pool to reuse proto.Marshal buffers:

```go
var marshalPool = sync.Pool{
    New: func() any { return &proto.MarshalOptions{} },
}

func marshalItem(item *inventoryv1.Item) ([]byte, error) {
    opts := marshalPool.Get().(*proto.MarshalOptions)
    defer marshalPool.Put(opts)
    return opts.Marshal(item)
}
```

## Section 11: Testing gRPC Services

### Unit Testing with bufconn

```go
package inventorysvc_test

import (
    "context"
    "net"
    "testing"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/test/bufconn"

    inventoryv1 "github.com/example/services/gen/inventory/v1"
    "github.com/example/services/internal/inventorysvc"
)

const bufSize = 1024 * 1024

func startTestServer(t *testing.T) inventoryv1.InventoryServiceClient {
    t.Helper()

    lis := bufconn.Listen(bufSize)
    srv := grpc.NewServer()
    inventoryv1.RegisterInventoryServiceServer(srv, inventorysvc.NewServer())

    go srv.Serve(lis)
    t.Cleanup(srv.GracefulStop)

    conn, err := grpc.NewClient(
        "passthrough:///bufnet",
        grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
            return lis.DialContext(ctx)
        }),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        t.Fatalf("dial bufconn: %v", err)
    }
    t.Cleanup(func() { conn.Close() })

    return inventoryv1.NewInventoryServiceClient(conn)
}

func TestGetItem_NotFound(t *testing.T) {
    client := startTestServer(t)
    _, err := client.GetItem(context.Background(), &inventoryv1.GetItemRequest{Id: "missing"})
    if status.Code(err) != codes.NotFound {
        t.Fatalf("expected NotFound, got %v", err)
    }
}

func TestUpdateAndGetItem(t *testing.T) {
    client := startTestServer(t)
    ctx := context.Background()

    item := &inventoryv1.Item{Id: "item-1", Sku: "SKU-001", Name: "Widget", Quantity: 100}
    _, err := client.UpdateItem(ctx, &inventoryv1.UpdateItemRequest{Item: item})
    if err != nil {
        t.Fatalf("UpdateItem: %v", err)
    }

    resp, err := client.GetItem(ctx, &inventoryv1.GetItemRequest{Id: "item-1"})
    if err != nil {
        t.Fatalf("GetItem: %v", err)
    }
    if resp.GetItem().GetName() != "Widget" {
        t.Errorf("expected Widget, got %q", resp.GetItem().GetName())
    }
}
```

## Section 12: Summary

Building production gRPC services in Go requires attention at every layer:

- **Schema**: design for evolution with `reserved` fields and `FieldMask`.
- **Generation**: use Buf for reproducible, lint-validated code generation.
- **Server**: embed `UnimplementedXxxServer`, chain interceptors for cross-cutting concerns.
- **Client**: share a single `ClientConn`, always set deadlines, map status codes to actions.
- **Gateway**: use grpc-gateway to serve REST clients from the same proto definition.
- **Health**: register `grpc_health_v1` and configure Kubernetes gRPC probes.
- **Debugging**: enable reflection selectively; use `grpcurl` for ad-hoc calls.
- **Deployment**: set PodDisruptionBudget, HPA, keepalive parameters, and message size limits.
- **Testing**: use `bufconn` for fast in-process integration tests without network overhead.

The combination of strict schema discipline, layered interceptors, and thoughtful client-side deadline management provides a foundation that scales from a handful of requests per second to hundreds of thousands.
