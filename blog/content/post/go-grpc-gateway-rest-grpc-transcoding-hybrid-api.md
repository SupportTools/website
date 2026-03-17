---
title: "Go gRPC Gateway: REST to gRPC Transcoding for Hybrid API Services"
date: 2031-04-24T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "REST", "API", "Protocol Buffers", "OpenAPI"]
categories:
- Go
- API Design
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to grpc-gateway for REST to gRPC transcoding: proto HTTP annotations, reverse proxy generation, request/response mapping, streaming endpoints, OpenAPI spec generation, and production deployment alongside a gRPC server."
more_link: "yes"
url: "/go-grpc-gateway-rest-grpc-transcoding-hybrid-api/"
---

The debate between REST and gRPC often produces a false choice: teams building new services want gRPC's type safety, bidirectional streaming, and code generation benefits, but must simultaneously support REST clients — browsers, third-party integrations, and mobile SDKs that cannot use HTTP/2 binary framing. The grpc-gateway project solves this by generating a reverse proxy that translates HTTP/1.1 REST requests into gRPC calls using annotations in your `.proto` files.

This guide walks through the complete grpc-gateway setup for a production service: annotating proto definitions with HTTP bindings, generating the gateway and OpenAPI specification, handling request/response transcoding edge cases, managing streaming endpoints, and deploying the gateway alongside your gRPC server in a Kubernetes environment.

<!--more-->

# Go gRPC Gateway: REST to gRPC Transcoding for Hybrid API Services

## Section 1: Architecture Overview

### What grpc-gateway Does

grpc-gateway reads the `google.api.http` annotations in your `.proto` files and generates:

1. A reverse proxy server (`RegisterXxxHandlerFromEndpoint`) that maps HTTP/JSON requests to gRPC calls.
2. An OpenAPI 2.0 (Swagger) specification from the proto definitions and annotations.

The generated proxy handles:
- HTTP method routing (GET/POST/PUT/DELETE → gRPC method)
- URL path parameter extraction and mapping to proto fields
- Query parameter mapping
- Request body deserialization from JSON to proto
- Response serialization from proto to JSON
- Error code translation (gRPC status codes → HTTP status codes)

### Deployment Topologies

**Same-process deployment**: The gRPC server and HTTP gateway share the same Go binary, listening on different ports. Simpler for small services.

**Sidecar deployment**: A dedicated gateway process proxies to a separate gRPC server. More flexible for independent scaling.

**Envoy-based**: Use Envoy's gRPC-JSON transcoder filter instead of grpc-gateway. Better for polyglot environments.

This guide covers same-process and sidecar deployment patterns.

## Section 2: Project Setup

### Install Dependencies

```bash
# Install buf for proto compilation
go install github.com/bufbuild/buf/cmd/buf@latest

# Install the required protoc plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2@latest

# Initialize Go module
mkdir -p myservice && cd myservice
go mod init github.com/support-tools/myservice

# Add dependencies
go get google.golang.org/grpc
go get google.golang.org/protobuf
go get github.com/grpc-ecosystem/grpc-gateway/v2
go get google.golang.org/grpc/credentials/insecure
```

### buf.yaml Configuration

```yaml
# buf.yaml
version: v2
modules:
  - path: proto
deps:
  - buf.build/googleapis/googleapis
  - buf.build/grpc-ecosystem/grpc-gateway

lint:
  use:
    - DEFAULT
  except:
    - FIELD_LOWER_SNAKE_CASE  # Allow camelCase for gateway fields

breaking:
  use:
    - FILE
```

```yaml
# buf.gen.yaml
version: v2
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: github.com/support-tools/myservice/gen
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

  - remote: buf.build/grpc-ecosystem/gateway
    out: gen
    opt:
      - paths=source_relative
      - generate_unbound_methods=true

  - remote: buf.build/grpc-ecosystem/openapiv2
    out: openapi
    opt:
      - output_format=json
      - allow_merge=true
      - merge_file_name=api.swagger.json
      - include_package_in_tags=false
      - simple_operation_ids=true
      - json_names_for_fields=true
      - openapi_naming_strategy=fqn
```

## Section 3: Proto Definitions with HTTP Annotations

### A Complete Order Service Proto

```protobuf
// proto/orderservice/v1/order_service.proto
syntax = "proto3";

package orderservice.v1;

option go_package = "github.com/support-tools/myservice/gen/orderservice/v1;orderservicev1";

import "google/api/annotations.proto";
import "google/api/field_behavior.proto";
import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/field_mask.proto";
import "protoc-gen-openapiv2/options/annotations.proto";

// OpenAPI configuration for the entire service
option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger) = {
  info: {
    title: "Order Service API"
    version: "2.0.0"
    description: "Enterprise order management service"
    contact: {
      name: "Platform Team"
      email: "platform@support.tools"
    }
    license: {
      name: "Apache 2.0"
    }
  }
  schemes: HTTPS
  consumes: "application/json"
  produces: "application/json"
  security_definitions: {
    security: {
      key: "BearerAuth"
      value: {
        type: TYPE_API_KEY
        in: IN_HEADER
        name: "Authorization"
      }
    }
  }
  security: {
    security_requirement: {
      key: "BearerAuth"
      value: {}
    }
  }
  responses: {
    key: "400"
    value: {
      description: "Bad request — invalid input"
    }
  }
  responses: {
    key: "401"
    value: {
      description: "Unauthorized — missing or invalid authentication"
    }
  }
  responses: {
    key: "404"
    value: {
      description: "Not found — resource does not exist"
    }
  }
};

// Order represents a customer order.
message Order {
  option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_schema) = {
    json_schema: {
      title: "Order"
      description: "Represents a customer order with line items"
    }
    example: "{\"id\":\"ord-123\",\"customer_id\":\"cust-456\",\"status\":\"ORDER_STATUS_PENDING\"}"
  };

  string id = 1 [(google.api.field_behavior) = OUTPUT_ONLY];
  string customer_id = 2 [(google.api.field_behavior) = REQUIRED];
  OrderStatus status = 3 [(google.api.field_behavior) = OUTPUT_ONLY];
  repeated LineItem items = 4 [(google.api.field_behavior) = REQUIRED];
  int64 total_cents = 5 [(google.api.field_behavior) = OUTPUT_ONLY];
  google.protobuf.Timestamp created_at = 6 [(google.api.field_behavior) = OUTPUT_ONLY];
  google.protobuf.Timestamp updated_at = 7 [(google.api.field_behavior) = OUTPUT_ONLY];
  map<string, string> metadata = 8;
  ShippingAddress shipping_address = 9;
}

enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;
  ORDER_STATUS_PENDING = 1;
  ORDER_STATUS_CONFIRMED = 2;
  ORDER_STATUS_SHIPPED = 3;
  ORDER_STATUS_DELIVERED = 4;
  ORDER_STATUS_CANCELLED = 5;
}

message LineItem {
  string product_id = 1 [(google.api.field_behavior) = REQUIRED];
  string product_name = 2 [(google.api.field_behavior) = OUTPUT_ONLY];
  int32 quantity = 3 [(google.api.field_behavior) = REQUIRED];
  int64 unit_price_cents = 4 [(google.api.field_behavior) = OUTPUT_ONLY];
}

message ShippingAddress {
  string street_line1 = 1;
  string street_line2 = 2;
  string city = 3;
  string state = 4;
  string postal_code = 5;
  string country_code = 6;
}

// CreateOrderRequest
message CreateOrderRequest {
  string customer_id = 1 [(google.api.field_behavior) = REQUIRED];
  repeated LineItem items = 2 [(google.api.field_behavior) = REQUIRED];
  ShippingAddress shipping_address = 3;
  map<string, string> metadata = 4;
}

// GetOrderRequest
message GetOrderRequest {
  string order_id = 1 [
    (google.api.field_behavior) = REQUIRED,
    (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_field) = {
      description: "The unique order identifier"
      example: "\"ord-abc123\""
    }
  ];
}

// ListOrdersRequest
message ListOrdersRequest {
  string customer_id = 1;
  OrderStatus status = 2;
  int32 page_size = 3;
  string page_token = 4;
  string order_by = 5;
}

// ListOrdersResponse
message ListOrdersResponse {
  repeated Order orders = 1;
  string next_page_token = 2;
  int32 total_count = 3;
}

// UpdateOrderRequest — uses FieldMask for partial updates
message UpdateOrderRequest {
  string order_id = 1 [(google.api.field_behavior) = REQUIRED];
  Order order = 2 [(google.api.field_behavior) = REQUIRED];
  google.protobuf.FieldMask update_mask = 3;
}

// CancelOrderRequest
message CancelOrderRequest {
  string order_id = 1 [(google.api.field_behavior) = REQUIRED];
  string reason = 2;
}

// OrderEvent for streaming
message OrderEvent {
  string order_id = 1;
  OrderStatus new_status = 2;
  google.protobuf.Timestamp event_time = 3;
  string message = 4;
}

// OrderService — the main service definition
service OrderService {
  // CreateOrder creates a new order.
  rpc CreateOrder(CreateOrderRequest) returns (Order) {
    option (google.api.http) = {
      post: "/v1/orders"
      body: "*"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Create an order"
      description: "Creates a new order for the specified customer"
      tags: ["orders"]
      operation_id: "CreateOrder"
      responses: {
        key: "201"
        value: {
          description: "Order created successfully"
        }
      }
    };
  }

  // GetOrder retrieves an order by ID.
  rpc GetOrder(GetOrderRequest) returns (Order) {
    option (google.api.http) = {
      get: "/v1/orders/{order_id}"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Get an order"
      description: "Retrieves the details of an existing order"
      tags: ["orders"]
      operation_id: "GetOrder"
    };
  }

  // ListOrders retrieves orders with filtering and pagination.
  rpc ListOrders(ListOrdersRequest) returns (ListOrdersResponse) {
    option (google.api.http) = {
      get: "/v1/orders"
      additional_bindings: [
        { get: "/v1/customers/{customer_id}/orders" }
      ]
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "List orders"
      description: "Lists orders with optional filtering by customer or status"
      tags: ["orders"]
      operation_id: "ListOrders"
    };
  }

  // UpdateOrder updates an existing order using field masking.
  rpc UpdateOrder(UpdateOrderRequest) returns (Order) {
    option (google.api.http) = {
      patch: "/v1/orders/{order_id}"
      body: "order"
      // Additional binding for PUT (full replacement)
      additional_bindings: [
        {
          put: "/v1/orders/{order_id}"
          body: "order"
        }
      ]
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Update an order"
      tags: ["orders"]
      operation_id: "UpdateOrder"
    };
  }

  // CancelOrder cancels an order.
  rpc CancelOrder(CancelOrderRequest) returns (google.protobuf.Empty) {
    option (google.api.http) = {
      delete: "/v1/orders/{order_id}"
      // body with additional fields
      additional_bindings: [
        {
          post: "/v1/orders/{order_id}:cancel"
          body: "*"
        }
      ]
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Cancel an order"
      tags: ["orders"]
      operation_id: "CancelOrder"
      responses: {
        key: "204"
        value: {
          description: "Order cancelled successfully"
        }
      }
    };
  }

  // WatchOrder streams order status changes.
  rpc WatchOrder(GetOrderRequest) returns (stream OrderEvent) {
    option (google.api.http) = {
      get: "/v1/orders/{order_id}/events"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Watch order events"
      description: "Streams order status change events using chunked transfer encoding"
      tags: ["orders"]
      operation_id: "WatchOrder"
    };
  }
}
```

## Section 4: Generating Code

```bash
# Generate all code from proto definitions
buf generate proto/

# This generates:
# gen/orderservice/v1/order_service.pb.go         (protobuf structs)
# gen/orderservice/v1/order_service_grpc.pb.go    (gRPC service interfaces)
# gen/orderservice/v1/order_service.pb.gw.go      (HTTP gateway code)
# openapi/api.swagger.json                        (OpenAPI specification)

# Verify generated files
ls -la gen/orderservice/v1/
```

## Section 5: Implementing the gRPC Server

```go
// internal/server/order_server.go
package server

import (
    "context"
    "fmt"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/emptypb"
    "google.golang.org/protobuf/types/known/timestamppb"

    pb "github.com/support-tools/myservice/gen/orderservice/v1"
)

// OrderServer implements the gRPC OrderService.
type OrderServer struct {
    pb.UnimplementedOrderServiceServer
    store OrderStore
}

// OrderStore is the interface for order persistence.
type OrderStore interface {
    Create(ctx context.Context, order *pb.Order) (*pb.Order, error)
    Get(ctx context.Context, id string) (*pb.Order, error)
    List(ctx context.Context, filter OrderFilter) ([]*pb.Order, string, error)
    Update(ctx context.Context, order *pb.Order, mask []string) (*pb.Order, error)
    Cancel(ctx context.Context, id string, reason string) error
}

type OrderFilter struct {
    CustomerID string
    Status     pb.OrderStatus
    PageSize   int32
    PageToken  string
    OrderBy    string
}

func NewOrderServer(store OrderStore) *OrderServer {
    return &OrderServer{store: store}
}

func (s *OrderServer) CreateOrder(ctx context.Context, req *pb.CreateOrderRequest) (*pb.Order, error) {
    if req.CustomerId == "" {
        return nil, status.Error(codes.InvalidArgument, "customer_id is required")
    }
    if len(req.Items) == 0 {
        return nil, status.Error(codes.InvalidArgument, "items cannot be empty")
    }

    // Validate items
    for i, item := range req.Items {
        if item.ProductId == "" {
            return nil, status.Errorf(codes.InvalidArgument, "items[%d].product_id is required", i)
        }
        if item.Quantity <= 0 {
            return nil, status.Errorf(codes.InvalidArgument, "items[%d].quantity must be positive", i)
        }
    }

    order := &pb.Order{
        CustomerId:      req.CustomerId,
        Items:           req.Items,
        ShippingAddress: req.ShippingAddress,
        Metadata:        req.Metadata,
        Status:          pb.OrderStatus_ORDER_STATUS_PENDING,
        CreatedAt:       timestamppb.Now(),
        UpdatedAt:       timestamppb.Now(),
    }

    created, err := s.store.Create(ctx, order)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "creating order: %v", err)
    }

    return created, nil
}

func (s *OrderServer) GetOrder(ctx context.Context, req *pb.GetOrderRequest) (*pb.Order, error) {
    if req.OrderId == "" {
        return nil, status.Error(codes.InvalidArgument, "order_id is required")
    }

    order, err := s.store.Get(ctx, req.OrderId)
    if err != nil {
        // Map store errors to gRPC status codes
        if isNotFound(err) {
            return nil, status.Errorf(codes.NotFound, "order %q not found", req.OrderId)
        }
        return nil, status.Errorf(codes.Internal, "getting order: %v", err)
    }

    return order, nil
}

func (s *OrderServer) ListOrders(ctx context.Context, req *pb.ListOrdersRequest) (*pb.ListOrdersResponse, error) {
    pageSize := req.PageSize
    if pageSize <= 0 || pageSize > 100 {
        pageSize = 50
    }

    filter := OrderFilter{
        CustomerID: req.CustomerId,
        Status:     req.Status,
        PageSize:   pageSize,
        PageToken:  req.PageToken,
        OrderBy:    req.OrderBy,
    }

    orders, nextToken, err := s.store.List(ctx, filter)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "listing orders: %v", err)
    }

    return &pb.ListOrdersResponse{
        Orders:        orders,
        NextPageToken: nextToken,
        TotalCount:    int32(len(orders)),
    }, nil
}

func (s *OrderServer) UpdateOrder(ctx context.Context, req *pb.UpdateOrderRequest) (*pb.Order, error) {
    if req.OrderId == "" {
        return nil, status.Error(codes.InvalidArgument, "order_id is required")
    }
    if req.Order == nil {
        return nil, status.Error(codes.InvalidArgument, "order is required")
    }

    // Extract field mask paths
    var paths []string
    if req.UpdateMask != nil {
        paths = req.UpdateMask.Paths
    }

    // Set the ID from the path parameter
    req.Order.Id = req.OrderId

    updated, err := s.store.Update(ctx, req.Order, paths)
    if err != nil {
        if isNotFound(err) {
            return nil, status.Errorf(codes.NotFound, "order %q not found", req.OrderId)
        }
        return nil, status.Errorf(codes.Internal, "updating order: %v", err)
    }

    return updated, nil
}

func (s *OrderServer) CancelOrder(ctx context.Context, req *pb.CancelOrderRequest) (*emptypb.Empty, error) {
    if req.OrderId == "" {
        return nil, status.Error(codes.InvalidArgument, "order_id is required")
    }

    if err := s.store.Cancel(ctx, req.OrderId, req.Reason); err != nil {
        if isNotFound(err) {
            return nil, status.Errorf(codes.NotFound, "order %q not found", req.OrderId)
        }
        return nil, status.Errorf(codes.Internal, "cancelling order: %v", err)
    }

    return &emptypb.Empty{}, nil
}

func (s *OrderServer) WatchOrder(req *pb.GetOrderRequest, stream pb.OrderService_WatchOrderServer) error {
    if req.OrderId == "" {
        return status.Error(codes.InvalidArgument, "order_id is required")
    }

    // Simulate streaming order events
    // In production, this would subscribe to a message bus or database change stream
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-stream.Context().Done():
            return nil // Client disconnected
        case <-ticker.C:
            order, err := s.store.Get(stream.Context(), req.OrderId)
            if err != nil {
                if isNotFound(err) {
                    return status.Errorf(codes.NotFound, "order %q not found", req.OrderId)
                }
                return status.Errorf(codes.Internal, "watching order: %v", err)
            }

            event := &pb.OrderEvent{
                OrderId:   order.Id,
                NewStatus: order.Status,
                EventTime: timestamppb.Now(),
                Message:   fmt.Sprintf("Status: %s", order.Status.String()),
            }

            if err := stream.Send(event); err != nil {
                return err // Client disconnected or network error
            }

            // Stop streaming when order reaches terminal state
            if order.Status == pb.OrderStatus_ORDER_STATUS_DELIVERED ||
                order.Status == pb.OrderStatus_ORDER_STATUS_CANCELLED {
                return nil
            }
        }
    }
}

func isNotFound(err error) bool {
    // Check for domain-specific not-found errors
    return err != nil && err.Error() == "not found"
}
```

## Section 6: Building the Combined Server

```go
// cmd/server/main.go
package main

import (
    "context"
    "fmt"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/health"
    healthpb "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/reflection"
    "google.golang.org/protobuf/encoding/protojson"

    pb "github.com/support-tools/myservice/gen/orderservice/v1"
    "github.com/support-tools/myservice/internal/server"
    "github.com/support-tools/myservice/internal/store"
)

const (
    grpcAddr    = ":50051"
    httpAddr    = ":8080"
    metricsAddr = ":9090"
)

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Initialize store
    orderStore, err := store.NewPostgresStore(os.Getenv("DATABASE_URL"))
    if err != nil {
        logger.Fatal("initializing store", zap.Error(err))
    }

    // Start gRPC server
    grpcServer := newGRPCServer(orderStore, logger)
    grpcListener, err := net.Listen("tcp", grpcAddr)
    if err != nil {
        logger.Fatal("listening on gRPC address", zap.Error(err), zap.String("addr", grpcAddr))
    }

    go func() {
        logger.Info("Starting gRPC server", zap.String("addr", grpcAddr))
        if err := grpcServer.Serve(grpcListener); err != nil {
            logger.Error("gRPC server error", zap.Error(err))
        }
    }()

    // Start HTTP gateway
    httpServer, err := newHTTPGateway(ctx, grpcAddr, logger)
    if err != nil {
        logger.Fatal("creating HTTP gateway", zap.Error(err))
    }

    go func() {
        logger.Info("Starting HTTP gateway", zap.String("addr", httpAddr))
        if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            logger.Error("HTTP gateway error", zap.Error(err))
        }
    }()

    // Wait for shutdown signal
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    logger.Info("Shutting down servers...")

    // Graceful shutdown
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    grpcServer.GracefulStop()
    httpServer.Shutdown(shutdownCtx)

    logger.Info("Servers stopped")
}

func newGRPCServer(orderStore server.OrderStore, logger *zap.Logger) *grpc.Server {
    // Interceptors for logging, auth, and metrics
    opts := []grpc.ServerOption{
        grpc.ChainUnaryInterceptor(
            loggingUnaryInterceptor(logger),
            authUnaryInterceptor,
            recoveryUnaryInterceptor(logger),
        ),
        grpc.ChainStreamInterceptor(
            loggingStreamInterceptor(logger),
            authStreamInterceptor,
        ),
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle:     15 * time.Second,
            MaxConnectionAge:      30 * time.Second,
            MaxConnectionAgeGrace: 5 * time.Second,
            Time:                  5 * time.Second,
            Timeout:               1 * time.Second,
        }),
        grpc.MaxRecvMsgSize(16 * 1024 * 1024), // 16MB
        grpc.MaxSendMsgSize(16 * 1024 * 1024),
    }

    srv := grpc.NewServer(opts...)

    // Register the order service
    orderSrv := server.NewOrderServer(orderStore)
    pb.RegisterOrderServiceServer(srv, orderSrv)

    // Register health check
    healthServer := health.NewServer()
    healthpb.RegisterHealthServer(srv, healthServer)
    healthServer.SetServingStatus("orderservice.v1.OrderService", healthpb.HealthCheckResponse_SERVING)

    // Register reflection for grpcurl/grpc-cli discovery
    reflection.Register(srv)

    return srv
}

func newHTTPGateway(ctx context.Context, grpcAddr string, logger *zap.Logger) (*http.Server, error) {
    // JSON marshaling options — use proto field names, emit defaults
    marshalerOpts := runtime.WithMarshalerOption(
        runtime.MIMEWildcard,
        &runtime.JSONPb{
            MarshalOptions: protojson.MarshalOptions{
                UseProtoNames:   false, // Use camelCase JSON names (standard)
                EmitUnpopulated: false,
                Multiline:       false,
            },
            UnmarshalOptions: protojson.UnmarshalOptions{
                DiscardUnknown: true,
            },
        },
    )

    // Custom error handler
    errorHandler := runtime.WithErrorHandler(customErrorHandler)

    // Custom routing error handler (for 404 etc.)
    routingErrorHandler := runtime.WithRoutingErrorHandler(customRoutingErrorHandler)

    // Forward specific headers from HTTP to gRPC metadata
    incomingHeaderMatcher := runtime.WithIncomingHeaderMatcher(func(key string) (string, bool) {
        switch key {
        case "X-Request-Id", "X-Trace-Id", "Authorization", "X-Tenant-Id":
            return key, true
        default:
            return runtime.DefaultHeaderMatcher(key)
        }
    })

    // Forward specific gRPC metadata keys back to HTTP headers
    outgoingHeaderMatcher := runtime.WithOutgoingHeaderMatcher(func(key string) (string, bool) {
        switch key {
        case "x-request-id", "x-trace-id":
            return key, true
        default:
            return "", false
        }
    })

    mux := runtime.NewServeMux(
        marshalerOpts,
        errorHandler,
        routingErrorHandler,
        incomingHeaderMatcher,
        outgoingHeaderMatcher,
        // Map gRPC metadata to HTTP response headers
        runtime.WithMetadata(func(ctx context.Context, r *http.Request) metadata.MD {
            md := metadata.New(nil)
            if traceID := r.Header.Get("X-Trace-Id"); traceID != "" {
                md.Set("x-trace-id", traceID)
            }
            return md
        }),
    )

    // Connect to the gRPC server
    conn, err := grpc.DialContext(
        ctx,
        grpcAddr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultCallOptions(
            grpc.MaxCallRecvMsgSize(16*1024*1024),
            grpc.MaxCallSendMsgSize(16*1024*1024),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("connecting to gRPC: %w", err)
    }

    // Register the HTTP handler
    if err := pb.RegisterOrderServiceHandler(ctx, mux, conn); err != nil {
        return nil, fmt.Errorf("registering handler: %w", err)
    }

    // Wrap the mux with HTTP middleware
    handler := corsMiddleware(
        loggingMiddleware(logger,
            requestIDMiddleware(mux),
        ),
    )

    return &http.Server{
        Addr:         httpAddr,
        Handler:      handler,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  60 * time.Second,
    }, nil
}
```

## Section 7: Custom Error Handling

```go
// internal/gateway/errors.go
package gateway

import (
    "context"
    "encoding/json"
    "net/http"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// ErrorResponse is the standard error format for the REST API.
type ErrorResponse struct {
    Code    int    `json:"code"`
    Message string `json:"message"`
    Status  string `json:"status"`
    Details []interface{} `json:"details,omitempty"`
}

// gRPC status code to HTTP status code mapping
var grpcToHTTP = map[codes.Code]int{
    codes.OK:                 http.StatusOK,
    codes.Canceled:           http.StatusRequestTimeout,
    codes.Unknown:            http.StatusInternalServerError,
    codes.InvalidArgument:    http.StatusBadRequest,
    codes.DeadlineExceeded:   http.StatusGatewayTimeout,
    codes.NotFound:           http.StatusNotFound,
    codes.AlreadyExists:      http.StatusConflict,
    codes.PermissionDenied:   http.StatusForbidden,
    codes.ResourceExhausted:  http.StatusTooManyRequests,
    codes.FailedPrecondition: http.StatusBadRequest,
    codes.Aborted:            http.StatusConflict,
    codes.OutOfRange:         http.StatusBadRequest,
    codes.Unimplemented:      http.StatusNotImplemented,
    codes.Internal:           http.StatusInternalServerError,
    codes.Unavailable:        http.StatusServiceUnavailable,
    codes.DataLoss:           http.StatusInternalServerError,
    codes.Unauthenticated:    http.StatusUnauthorized,
}

func customErrorHandler(
    ctx context.Context,
    mux *runtime.ServeMux,
    marshaler runtime.Marshaler,
    w http.ResponseWriter,
    r *http.Request,
    err error,
) {
    s := status.Convert(err)
    httpCode := grpcToHTTP[s.Code()]
    if httpCode == 0 {
        httpCode = http.StatusInternalServerError
    }

    resp := ErrorResponse{
        Code:    int(s.Code()),
        Message: s.Message(),
        Status:  s.Code().String(),
    }

    // Extract error details if present
    for _, detail := range s.Details() {
        resp.Details = append(resp.Details, detail)
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(httpCode)
    json.NewEncoder(w).Encode(resp)
}

func customRoutingErrorHandler(
    ctx context.Context,
    mux *runtime.ServeMux,
    marshaler runtime.Marshaler,
    w http.ResponseWriter,
    r *http.Request,
    httpStatus int,
) {
    statusCode := codes.Unknown
    switch httpStatus {
    case http.StatusNotFound:
        statusCode = codes.NotFound
    case http.StatusMethodNotAllowed:
        statusCode = codes.Unimplemented
    }

    customErrorHandler(ctx, mux, marshaler, w, r,
        status.Errorf(statusCode, "HTTP %d: %s %s", httpStatus, r.Method, r.URL.Path))
}
```

## Section 8: Streaming Endpoint Handling

Server-streaming gRPC methods are translated to chunked HTTP responses by grpc-gateway. The client receives newline-delimited JSON objects:

```bash
# Client receives chunked JSON (newline-delimited)
curl -N http://localhost:8080/v1/orders/ord-123/events

# Response (streaming):
# {"orderId":"ord-123","newStatus":"ORDER_STATUS_CONFIRMED","eventTime":"2031-04-24T10:00:00Z","message":"Status: ORDER_STATUS_CONFIRMED"}
# {"orderId":"ord-123","newStatus":"ORDER_STATUS_SHIPPED","eventTime":"2031-04-24T10:05:00Z","message":"Status: ORDER_STATUS_SHIPPED"}
```

### JavaScript Client for Streaming

```javascript
// Consuming the streaming endpoint from a browser
async function watchOrder(orderId) {
  const response = await fetch(`/v1/orders/${orderId}/events`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          const event = JSON.parse(line);
          console.log('Order event:', event);
          updateOrderUI(event);
        } catch (e) {
          // grpc-gateway may send {"result": {...}} or {"error": {...}} wrappers
          try {
            const wrapper = JSON.parse(line);
            if (wrapper.result) {
              updateOrderUI(wrapper.result);
            } else if (wrapper.error) {
              console.error('Stream error:', wrapper.error);
            }
          } catch (e2) {
            console.warn('Could not parse line:', line);
          }
        }
      }
    }
  }
}
```

## Section 9: OpenAPI Specification and Documentation

After running `buf generate`, the `openapi/api.swagger.json` file contains the complete API specification. Serve it with Swagger UI:

```yaml
# swagger-ui-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: swagger-ui
  namespace: api-docs
spec:
  replicas: 1
  selector:
    matchLabels:
      app: swagger-ui
  template:
    metadata:
      labels:
        app: swagger-ui
    spec:
      containers:
      - name: swagger-ui
        image: swaggerapi/swagger-ui:latest
        env:
        - name: SWAGGER_JSON_URL
          value: /api-spec/api.swagger.json
        - name: BASE_URL
          value: /docs
        ports:
        - containerPort: 8080
        volumeMounts:
        - name: api-spec
          mountPath: /api-spec
      initContainers:
      - name: copy-spec
        image: registry.support.tools/myservice:latest
        command: ["cp", "/app/openapi/api.swagger.json", "/api-spec/"]
        volumeMounts:
        - name: api-spec
          mountPath: /api-spec
      volumes:
      - name: api-spec
        emptyDir: {}
```

### Generating Clients from OpenAPI

```bash
# Generate a TypeScript client
npx @openapitools/openapi-generator-cli generate \
  -i openapi/api.swagger.json \
  -g typescript-fetch \
  -o clients/typescript \
  --additional-properties=typescriptThreePlus=true

# Generate a Python client
npx @openapitools/openapi-generator-cli generate \
  -i openapi/api.swagger.json \
  -g python \
  -o clients/python \
  --additional-properties=packageName=myservice_client

# Generate a Java client
npx @openapitools/openapi-generator-cli generate \
  -i openapi/api.swagger.json \
  -g java \
  -o clients/java \
  --additional-properties=groupId=com.example,artifactId=myservice-client
```

## Section 10: Kubernetes Deployment

```yaml
# kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
    spec:
      containers:
      - name: order-service
        image: registry.support.tools/order-service:v2.0.0
        ports:
        - name: grpc
          containerPort: 50051
        - name: http
          containerPort: 8080
        - name: metrics
          containerPort: 9090
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: order-service-secrets
              key: database-url
        readinessProbe:
          grpc:
            port: 50051
            service: orderservice.v1.OrderService
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /healthz
            port: http
          initialDelaySeconds: 15
          periodSeconds: 20
---
apiVersion: v1
kind: Service
metadata:
  name: order-service-grpc
  namespace: production
spec:
  selector:
    app: order-service
  ports:
  - name: grpc
    port: 50051
    targetPort: grpc
  type: ClusterIP
---
apiVersion: v1
kind: Service
metadata:
  name: order-service-http
  namespace: production
spec:
  selector:
    app: order-service
  ports:
  - name: http
    port: 80
    targetPort: http
  type: ClusterIP
---
# Separate Ingress for REST and gRPC
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: order-service
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  rules:
  - host: api.support.tools
    http:
      paths:
      - path: /v1/orders
        pathType: Prefix
        backend:
          service:
            name: order-service-http
            port:
              name: http
```

The grpc-gateway pattern enables teams to publish a single protobuf-defined API surface that is simultaneously a high-performance gRPC service for internal microservices and a standard REST/JSON API for external clients. The investment in the proto annotation layer pays dividends in generated documentation, client SDKs, and type-safe request handling across all consumer languages.
