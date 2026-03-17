---
title: "Go Protocol Buffers: Protobuf v2, gRPC Service Design, Backward Compatibility, and Buf CLI"
date: 2028-08-19T00:00:00-05:00
draft: false
tags: ["Go", "Protobuf", "gRPC", "Buf", "API Design"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Protocol Buffers and gRPC in Go. Covers protobuf v2 API, schema design for backward compatibility, the Buf CLI for linting and breaking change detection, gRPC service patterns, and performance optimization."
more_link: "yes"
url: "/go-protobuf-grpc-service-design-buf-guide/"
---

Protocol Buffers and gRPC have become the dominant choice for internal service communication at companies that care about performance and schema evolution. The Go protobuf v2 API (`google.golang.org/protobuf`) is a significant improvement over the original v1 API, and the Buf CLI solves the historical pain points of managing proto schemas. This guide covers everything from proto schema design to gRPC service implementation, backward compatibility rules, and production performance tuning.

<!--more-->

# [Go Protocol Buffers and gRPC](#go-protobuf-grpc)

## Section 1: Proto Schema Design

### Project Structure

```
myapp/
├── proto/
│   ├── buf.yaml
│   ├── buf.gen.yaml
│   ├── buf.lock
│   └── myapp/
│       ├── v1/
│       │   ├── order.proto
│       │   ├── order_service.proto
│       │   └── common.proto
│       └── v2/
│           └── order_service.proto
├── gen/
│   └── go/
│       └── myapp/
│           └── v1/
└── cmd/
    └── server/
```

### Core Proto Definitions

```protobuf
// proto/myapp/v1/common.proto
syntax = "proto3";

package myapp.v1;

option go_package = "github.com/myorg/myapp/gen/go/myapp/v1;myappv1";

import "google/protobuf/timestamp.proto";

// Money is a value type for monetary amounts.
// Store as cents to avoid floating point issues.
message Money {
  // Currency code per ISO 4217 (e.g., "USD", "EUR")
  string currency_code = 1;
  // Amount in the currency's smallest unit (cents for USD)
  int64 amount = 2;
}

// PageRequest contains pagination parameters.
message PageRequest {
  // page_token from the previous response.
  // Empty string for the first page.
  string page_token = 1;
  // Maximum number of items to return.
  // The server may return fewer. 0 means server default.
  int32 page_size = 2;
}

// PageResponse contains pagination metadata for list responses.
message PageResponse {
  // next_page_token is empty if there are no more pages.
  string next_page_token = 1;
  // total_size is the total number of items (may be approximate).
  int32 total_size = 2;
}

// Error represents a rich error response.
message Error {
  // code is the gRPC status code.
  int32 code = 1;
  // message is human-readable.
  string message = 2;
  // details contains additional context.
  repeated ErrorDetail details = 3;
}

message ErrorDetail {
  string key = 1;
  string value = 2;
}
```

```protobuf
// proto/myapp/v1/order.proto
syntax = "proto3";

package myapp.v1;

option go_package = "github.com/myorg/myapp/gen/go/myapp/v1;myappv1";

import "google/protobuf/timestamp.proto";
import "myapp/v1/common.proto";

// OrderStatus represents the lifecycle state of an order.
enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;  // Always include unspecified as 0
  ORDER_STATUS_PENDING = 1;
  ORDER_STATUS_CONFIRMED = 2;
  ORDER_STATUS_PROCESSING = 3;
  ORDER_STATUS_SHIPPED = 4;
  ORDER_STATUS_DELIVERED = 5;
  ORDER_STATUS_CANCELLED = 6;
  ORDER_STATUS_REFUNDED = 7;
}

// Order represents a customer order.
message Order {
  // id is the globally unique order identifier.
  string id = 1;
  // user_id identifies the customer.
  string user_id = 2;
  // status is the current order lifecycle state.
  OrderStatus status = 3;
  // items contains the ordered line items.
  repeated OrderItem items = 4;
  // total is the calculated order total.
  Money total = 5;
  // shipping_address is where the order ships.
  Address shipping_address = 6;
  // created_at is when the order was placed.
  google.protobuf.Timestamp created_at = 7;
  // updated_at is when the order was last modified.
  google.protobuf.Timestamp updated_at = 8;
  // metadata contains arbitrary key-value pairs for extensibility.
  // Keys must be lowercase with underscores. Values must be strings.
  map<string, string> metadata = 9;
}

// OrderItem is a single line item in an order.
message OrderItem {
  // product_id is the SKU or catalog identifier.
  string product_id = 1;
  // name is the display name at time of purchase.
  string name = 2;
  // quantity must be > 0.
  int32 quantity = 3;
  // unit_price is the price per unit at time of purchase.
  Money unit_price = 4;
  // subtotal = unit_price * quantity.
  Money subtotal = 5;
}

// Address is a postal address.
message Address {
  string line1 = 1;
  string line2 = 2;
  string city = 3;
  string state = 4;
  string postal_code = 5;
  // country_code per ISO 3166-1 alpha-2.
  string country_code = 6;
}
```

```protobuf
// proto/myapp/v1/order_service.proto
syntax = "proto3";

package myapp.v1;

option go_package = "github.com/myorg/myapp/gen/go/myapp/v1;myappv1";

import "myapp/v1/order.proto";
import "myapp/v1/common.proto";

// OrderService provides order management operations.
service OrderService {
  // CreateOrder creates a new order.
  // Returns ALREADY_EXISTS if an idempotency key is reused.
  rpc CreateOrder(CreateOrderRequest) returns (CreateOrderResponse);

  // GetOrder retrieves an order by ID.
  // Returns NOT_FOUND if the order does not exist.
  rpc GetOrder(GetOrderRequest) returns (GetOrderResponse);

  // ListOrders lists orders for a user.
  rpc ListOrders(ListOrdersRequest) returns (ListOrdersResponse);

  // UpdateOrderStatus updates an order's status.
  // Returns FAILED_PRECONDITION for invalid state transitions.
  rpc UpdateOrderStatus(UpdateOrderStatusRequest) returns (UpdateOrderStatusResponse);

  // CancelOrder cancels a pending or confirmed order.
  rpc CancelOrder(CancelOrderRequest) returns (CancelOrderResponse);

  // WatchOrders streams order status updates for a user.
  rpc WatchOrders(WatchOrdersRequest) returns (stream WatchOrdersResponse);
}

message CreateOrderRequest {
  // idempotency_key ensures at-most-once delivery.
  // Clients MUST provide this. Reusing a key within 24h returns the original response.
  string idempotency_key = 1;
  // user_id of the customer placing the order.
  string user_id = 2;
  // items must contain at least one item.
  repeated OrderItem items = 3;
  // shipping_address is required.
  Address shipping_address = 4;
}

message CreateOrderResponse {
  Order order = 1;
}

message GetOrderRequest {
  string id = 1;
  // Optional: provide user_id for authorization check.
  string user_id = 2;
}

message GetOrderResponse {
  Order order = 1;
}

message ListOrdersRequest {
  string user_id = 1;
  // Filter by status. Empty means all statuses.
  repeated OrderStatus statuses = 2;
  PageRequest page = 3;
}

message ListOrdersResponse {
  repeated Order orders = 1;
  PageResponse page = 2;
}

message UpdateOrderStatusRequest {
  string id = 1;
  OrderStatus status = 2;
  // reason is required for cancellations and refunds.
  string reason = 3;
}

message UpdateOrderStatusResponse {
  Order order = 1;
}

message CancelOrderRequest {
  string id = 1;
  string user_id = 2;
  string reason = 3;
}

message CancelOrderResponse {
  Order order = 1;
}

message WatchOrdersRequest {
  string user_id = 1;
}

message WatchOrdersResponse {
  Order order = 1;
  // event_type describes what changed.
  string event_type = 2;
}
```

## Section 2: Buf CLI Configuration

Buf replaces `protoc` with a simpler, reproducible build system. It also adds linting and breaking change detection.

### Buf Configuration Files

```yaml
# proto/buf.yaml
version: v2
modules:
  - path: .
lint:
  use:
    - DEFAULT
    # Additional rules
    - COMMENTS          # All public types must have comments
    - PACKAGE_AFFINITY  # Message/enum/service must be in correct package
  except:
    - FIELD_LOWER_SNAKE_CASE  # We sometimes use camelCase in metadata
  ignore_only:
    PACKAGE_VERSION_SUFFIX:
      - myapp/v1/common.proto  # common.proto doesn't need versioned package

breaking:
  use:
    - FILE
  except:
    - FIELD_SAME_DEFAULT  # Acceptable to change defaults

deps:
  - buf.build/googleapis/googleapis
  - buf.build/grpc-ecosystem/grpc-gateway
```

```yaml
# proto/buf.gen.yaml
version: v2
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: github.com/myorg/myapp/gen/go

plugins:
  # Go protobuf types
  - remote: buf.build/protocolbuffers/go
    out: ../gen/go
    opt:
      - paths=source_relative

  # gRPC service stubs
  - remote: buf.build/grpc/go
    out: ../gen/go
    opt:
      - paths=source_relative
      - require_unimplemented_servers=true

  # gRPC-Gateway (HTTP/JSON transcoding)
  - remote: buf.build/grpc-ecosystem/gateway
    out: ../gen/go
    opt:
      - paths=source_relative
      - generate_unbound_methods=true

  # OpenAPI v2 documentation
  - remote: buf.build/grpc-ecosystem/openapiv2
    out: ../gen/openapi
    opt:
      - allow_merge=true
      - merge_file_name=api
```

### Buf Workflows

```bash
# Initialize buf workspace
cd proto && buf mod init

# Add dependencies
buf dep update

# Lint proto files
buf lint

# Check for breaking changes against the last release
buf breaking --against '.git#branch=main'

# Check against BSR (Buf Schema Registry)
buf breaking --against 'buf.build/myorg/myapp:main'

# Generate code
buf generate

# Push to Buf Schema Registry
buf push --tag v1.2.3

# Format proto files
buf format -w

# List all services and methods
buf ls-files
buf image build -o -  | buf protoc-gen-buf-check-lint --input -
```

## Section 3: gRPC Server Implementation

### Server Setup with All Interceptors

```go
// cmd/server/main.go
package main

import (
    "context"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"
    "log/slog"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/reflection"
    "google.golang.org/grpc/status"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/logging"
    "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"
    "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/validator"

    myappv1 "github.com/myorg/myapp/gen/go/myapp/v1"
    "github.com/myorg/myapp/internal/service"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // Recovery handler
    recoveryOpts := []recovery.Option{
        recovery.WithRecoveryHandlerContext(func(ctx context.Context, p interface{}) error {
            logger.ErrorContext(ctx, "panic recovered", "panic", p)
            return status.Errorf(codes.Internal, "internal server error")
        }),
    }

    // Logging interceptor
    logOpts := []logging.Option{
        logging.WithLogOnEvents(logging.StartCall, logging.FinishCall),
        logging.WithDurationField(logging.DurationToDurationField),
    }

    srv := grpc.NewServer(
        // TLS credentials (in production)
        // grpc.Creds(creds),

        // Keepalive: detect dead connections
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

        // Message size limits
        grpc.MaxRecvMsgSize(16 * 1024 * 1024), // 16MB
        grpc.MaxSendMsgSize(16 * 1024 * 1024),

        // Concurrency limits
        grpc.MaxConcurrentStreams(1000),

        // Interceptors
        grpc.ChainUnaryInterceptor(
            otelgrpc.UnaryServerInterceptor(),
            recovery.UnaryServerInterceptor(recoveryOpts...),
            logging.UnaryServerInterceptor(interceptorLogger(logger), logOpts...),
            validator.UnaryServerInterceptor(),
            authUnaryInterceptor,
        ),
        grpc.ChainStreamInterceptor(
            otelgrpc.StreamServerInterceptor(),
            recovery.StreamServerInterceptor(recoveryOpts...),
            logging.StreamServerInterceptor(interceptorLogger(logger), logOpts...),
            validator.StreamServerInterceptor(),
            authStreamInterceptor,
        ),

        // Stats handler for OpenTelemetry
        grpc.StatsHandler(otelgrpc.NewServerHandler()),
    )

    // Register services
    orderSvc := service.NewOrderService(/* deps */)
    myappv1.RegisterOrderServiceServer(srv, orderSvc)

    // Register reflection for tools like grpcurl, evans
    reflection.Register(srv)

    // Start listening
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        logger.Error("failed to listen", "error", err)
        os.Exit(1)
    }

    // Graceful shutdown
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    go func() {
        logger.Info("gRPC server starting", "addr", lis.Addr())
        if err := srv.Serve(lis); err != nil {
            logger.Error("server error", "error", err)
        }
    }()

    <-ctx.Done()
    logger.Info("shutting down gRPC server")

    // GracefulStop waits for in-flight requests
    gracefulStop := make(chan struct{})
    go func() {
        srv.GracefulStop()
        close(gracefulStop)
    }()

    select {
    case <-gracefulStop:
        logger.Info("server stopped gracefully")
    case <-time.After(30 * time.Second):
        logger.Warn("forcing server stop after timeout")
        srv.Stop()
    }
}

func interceptorLogger(l *slog.Logger) logging.Logger {
    return logging.LoggerFunc(func(ctx context.Context, lvl logging.Level, msg string, fields ...any) {
        l.Log(ctx, slog.Level(lvl), msg, fields...)
    })
}

func authUnaryInterceptor(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
    // Skip auth for health check
    if info.FullMethod == "/grpc.health.v1.Health/Check" {
        return handler(ctx, req)
    }
    ctx, err := authenticate(ctx)
    if err != nil {
        return nil, err
    }
    return handler(ctx, req)
}

func authStreamInterceptor(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
    _, err := authenticate(ss.Context())
    if err != nil {
        return err
    }
    return handler(srv, ss)
}

func authenticate(ctx context.Context) (context.Context, error) {
    // Extract and validate bearer token
    return ctx, nil
}
```

### OrderService Implementation

```go
// internal/service/order_service.go
package service

import (
    "context"
    "fmt"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    myappv1 "github.com/myorg/myapp/gen/go/myapp/v1"
)

type OrderService struct {
    myappv1.UnimplementedOrderServiceServer // Required for forward compatibility
    db    OrderRepository
    cache CacheClient
}

func NewOrderService(db OrderRepository, cache CacheClient) *OrderService {
    return &OrderService{db: db, cache: cache}
}

func (s *OrderService) CreateOrder(ctx context.Context, req *myappv1.CreateOrderRequest) (*myappv1.CreateOrderResponse, error) {
    // Validate required fields
    if req.IdempotencyKey == "" {
        return nil, status.Error(codes.InvalidArgument, "idempotency_key is required")
    }
    if req.UserId == "" {
        return nil, status.Error(codes.InvalidArgument, "user_id is required")
    }
    if len(req.Items) == 0 {
        return nil, status.Error(codes.InvalidArgument, "items cannot be empty")
    }
    if req.ShippingAddress == nil {
        return nil, status.Error(codes.InvalidArgument, "shipping_address is required")
    }

    // Idempotency check
    existing, err := s.cache.GetIdempotentResponse(ctx, req.IdempotencyKey)
    if err == nil && existing != nil {
        // Return cached response
        var resp myappv1.CreateOrderResponse
        if err := existing.UnmarshalTo(&resp); err == nil {
            return &resp, nil
        }
    }

    // Create the order
    order, err := s.db.CreateOrder(ctx, req)
    if err != nil {
        return nil, toGRPCError(err)
    }

    resp := &myappv1.CreateOrderResponse{
        Order: toProtoOrder(order),
    }

    // Cache the response for idempotency
    s.cache.SetIdempotentResponse(ctx, req.IdempotencyKey, resp, 24*60*60)

    return resp, nil
}

func (s *OrderService) GetOrder(ctx context.Context, req *myappv1.GetOrderRequest) (*myappv1.GetOrderResponse, error) {
    if req.Id == "" {
        return nil, status.Error(codes.InvalidArgument, "id is required")
    }

    order, err := s.db.GetOrder(ctx, req.Id)
    if err != nil {
        return nil, toGRPCError(err)
    }

    // Authorization: ensure user can access this order
    if req.UserId != "" && order.UserID != req.UserId {
        return nil, status.Error(codes.PermissionDenied, "access denied")
    }

    return &myappv1.GetOrderResponse{
        Order: toProtoOrder(order),
    }, nil
}

func (s *OrderService) ListOrders(ctx context.Context, req *myappv1.ListOrdersRequest) (*myappv1.ListOrdersResponse, error) {
    if req.UserId == "" {
        return nil, status.Error(codes.InvalidArgument, "user_id is required")
    }

    pageSize := 20
    if req.Page != nil && req.Page.PageSize > 0 {
        pageSize = int(req.Page.PageSize)
        if pageSize > 100 {
            pageSize = 100
        }
    }

    var pageToken string
    if req.Page != nil {
        pageToken = req.Page.PageToken
    }

    orders, nextToken, total, err := s.db.ListOrders(ctx, req.UserId, pageToken, pageSize)
    if err != nil {
        return nil, toGRPCError(err)
    }

    protoOrders := make([]*myappv1.Order, len(orders))
    for i, o := range orders {
        protoOrders[i] = toProtoOrder(o)
    }

    return &myappv1.ListOrdersResponse{
        Orders: protoOrders,
        Page: &myappv1.PageResponse{
            NextPageToken: nextToken,
            TotalSize:     int32(total),
        },
    }, nil
}

func (s *OrderService) WatchOrders(req *myappv1.WatchOrdersRequest, stream myappv1.OrderService_WatchOrdersServer) error {
    if req.UserId == "" {
        return status.Error(codes.InvalidArgument, "user_id is required")
    }

    ctx := stream.Context()
    events := s.db.SubscribeToOrderEvents(ctx, req.UserId)

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case event, ok := <-events:
            if !ok {
                return nil // Channel closed
            }
            if err := stream.Send(&myappv1.WatchOrdersResponse{
                Order:     toProtoOrder(event.Order),
                EventType: event.Type,
            }); err != nil {
                return err
            }
        }
    }
}

// toGRPCError converts domain errors to gRPC status errors
func toGRPCError(err error) error {
    if err == nil {
        return nil
    }

    switch {
    case isNotFoundError(err):
        return status.Errorf(codes.NotFound, "not found: %v", err)
    case isAlreadyExistsError(err):
        return status.Errorf(codes.AlreadyExists, "already exists: %v", err)
    case isValidationError(err):
        return status.Errorf(codes.InvalidArgument, "invalid argument: %v", err)
    case isPreconditionError(err):
        return status.Errorf(codes.FailedPrecondition, "precondition failed: %v", err)
    default:
        return status.Errorf(codes.Internal, "internal error: %v", err)
    }
}
```

## Section 4: Backward Compatibility Rules

Proto schema backward compatibility is critical. Breaking changes cause runtime panics or silent data corruption in clients that have not been updated.

### Safe Changes

```protobuf
// SAFE: Add new optional fields
message Order {
  string id = 1;
  string user_id = 2;
  // NEW: Adding a field with a new field number
  string merchant_id = 10;  // Safe to add
  // NEW: Adding a new enum value (not breaking for proto3)
  // OLD: enum OrderStatus { ... CANCELLED = 6; }
  // NEW: enum OrderStatus { ... CANCELLED = 6; EXPIRED = 8; }
}

// SAFE: Add a new method to a service
service OrderService {
  rpc CreateOrder(...) returns (...);
  rpc GetOrder(...) returns (...);
  rpc BulkGetOrders(...) returns (...);  // New method — safe
}

// SAFE: Add a new message type
message OrderSummary {  // New message type — safe
  string id = 1;
  Money total = 2;
}
```

### Unsafe Changes

```protobuf
// BREAKING: Removing a field
message Order {
  string id = 1;
  // string user_id = 2;  -- NEVER DELETE! Reserve instead:
  reserved 2;
  reserved "user_id";
}

// BREAKING: Changing a field type
message Order {
  string id = 1;
  // int64 user_id = 2;   -- Changed from string to int64 — BREAKING
  int64 user_id = 2;  // DO NOT DO THIS
}

// BREAKING: Reusing a field number with different type
message Order {
  string id = 1;
  // string user_id = 2;  -- Removed
  // int64 amount = 2;    -- Reusing field 2 — BREAKING (wire format conflict)
}

// BREAKING: Renaming a field (wire format is by field number,
// but JSON serialization uses field names)
message Order {
  string id = 1;
  // string user_id = 2;    -- Renaming user_id to customer_id
  string customer_id = 2;  -- BREAKS JSON clients
}
```

### Using Reserved Fields

```protobuf
message Order {
  string id = 1;
  string user_id = 2;
  // Field 3 was "shipping_status" — removed in v1.2
  // Field 4 was "internal_notes" — removed in v1.3
  reserved 3, 4;
  reserved "shipping_status", "internal_notes";

  OrderStatus status = 5;
  repeated OrderItem items = 6;
  Money total = 7;
  Address shipping_address = 8;
  google.protobuf.Timestamp created_at = 9;
  google.protobuf.Timestamp updated_at = 10;

  // Fields 11-20 reserved for future use
  reserved 11, 12, 13, 14, 15, 16, 17, 18, 19, 20;
}
```

### Buf Breaking Change Detection

```bash
# Configure breaking change detection in CI
# buf.yaml
breaking:
  use:
    - FILE           # Default: check file-level breaking changes
  ignore_unstable_packages: true  # Ignore alpha/beta packages
```

```yaml
# .github/workflows/proto-check.yml
name: Proto Validation
on:
  pull_request:
    paths:
      - 'proto/**'

jobs:
  buf-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for comparison

      - uses: bufbuild/buf-setup-action@v1
        with:
          version: '1.34.0'

      - name: Buf lint
        run: buf lint proto/

      - name: Buf breaking changes
        run: |
          buf breaking proto/ \
            --against '.git#branch=main,subdir=proto'

      - name: Buf generate (verify codegen works)
        run: buf generate proto/

      - name: Check generated code is up to date
        run: |
          git diff --exit-code gen/
          if [ $? -ne 0 ]; then
            echo "Generated code is out of date. Run 'buf generate proto/' and commit."
            exit 1
          fi
```

## Section 5: gRPC Client Implementation

### Resilient Client with Retry and Circuit Breaker

```go
// internal/client/order_client.go
package client

import (
    "context"
    "fmt"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/status"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"

    myappv1 "github.com/myorg/myapp/gen/go/myapp/v1"
)

type OrderClient struct {
    conn   *grpc.ClientConn
    client myappv1.OrderServiceClient
}

func NewOrderClient(ctx context.Context, target string) (*OrderClient, error) {
    // Service config with retry policy
    serviceConfig := `{
        "methodConfig": [{
            "name": [{"service": "myapp.v1.OrderService"}],
            "waitForReady": true,
            "retryPolicy": {
                "MaxAttempts": 4,
                "InitialBackoff": "0.1s",
                "MaxBackoff": "1s",
                "BackoffMultiplier": 2,
                "RetryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
            },
            "timeout": "30s"
        }, {
            "name": [{"service": "myapp.v1.OrderService", "method": "GetOrder"}],
            "retryPolicy": {
                "MaxAttempts": 5,
                "InitialBackoff": "0.05s",
                "MaxBackoff": "0.5s",
                "BackoffMultiplier": 2,
                "RetryableStatusCodes": ["UNAVAILABLE", "NOT_FOUND"]
            }
        }]
    }`

    conn, err := grpc.DialContext(ctx, target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultServiceConfig(serviceConfig),
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second,
            Timeout:             3 * time.Second,
            PermitWithoutStream: true,
        }),
        grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
        grpc.WithDefaultCallOptions(
            grpc.MaxCallRecvMsgSize(16*1024*1024),
            grpc.MaxCallSendMsgSize(16*1024*1024),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("dialing %s: %w", target, err)
    }

    return &OrderClient{
        conn:   conn,
        client: myappv1.NewOrderServiceClient(conn),
    }, nil
}

func (c *OrderClient) Close() error {
    return c.conn.Close()
}

func (c *OrderClient) CreateOrder(ctx context.Context, req *myappv1.CreateOrderRequest) (*myappv1.Order, error) {
    resp, err := c.client.CreateOrder(ctx, req)
    if err != nil {
        return nil, translateError(err)
    }
    return resp.Order, nil
}

func (c *OrderClient) GetOrder(ctx context.Context, orderID string) (*myappv1.Order, error) {
    resp, err := c.client.GetOrder(ctx, &myappv1.GetOrderRequest{Id: orderID})
    if err != nil {
        return nil, translateError(err)
    }
    return resp.Order, nil
}

// WatchOrders subscribes to order updates and calls handler for each event.
func (c *OrderClient) WatchOrders(ctx context.Context, userID string, handler func(*myappv1.Order, string) error) error {
    stream, err := c.client.WatchOrders(ctx, &myappv1.WatchOrdersRequest{UserId: userID})
    if err != nil {
        return fmt.Errorf("opening watch stream: %w", err)
    }

    for {
        resp, err := stream.Recv()
        if err != nil {
            if s, ok := status.FromError(err); ok {
                if s.Code() == codes.Canceled || s.Code() == codes.Unavailable {
                    return nil
                }
            }
            return fmt.Errorf("receiving: %w", err)
        }

        if err := handler(resp.Order, resp.EventType); err != nil {
            return err
        }
    }
}

// translateError converts gRPC status errors to domain errors
func translateError(err error) error {
    if err == nil {
        return nil
    }
    s, ok := status.FromError(err)
    if !ok {
        return err
    }

    switch s.Code() {
    case codes.NotFound:
        return fmt.Errorf("not found: %s", s.Message())
    case codes.AlreadyExists:
        return fmt.Errorf("already exists: %s", s.Message())
    case codes.InvalidArgument:
        return fmt.Errorf("invalid argument: %s", s.Message())
    case codes.DeadlineExceeded:
        return fmt.Errorf("deadline exceeded: %s", s.Message())
    case codes.Canceled:
        return context.Canceled
    case codes.Unauthenticated:
        return fmt.Errorf("unauthenticated: %s", s.Message())
    case codes.PermissionDenied:
        return fmt.Errorf("permission denied: %s", s.Message())
    default:
        return fmt.Errorf("gRPC error %s: %s", s.Code(), s.Message())
    }
}
```

## Section 6: gRPC Performance Optimization

### Connection Pool

```go
// internal/pool/grpc_pool.go
package pool

import (
    "context"
    "fmt"
    "sync"
    "sync/atomic"

    "google.golang.org/grpc"
)

// Pool maintains multiple gRPC connections for high-throughput scenarios.
// gRPC multiplexes streams over a single TCP connection (HTTP/2),
// so multiple connections are needed to saturate high-bandwidth links.
type Pool struct {
    mu      sync.RWMutex
    conns   []*grpc.ClientConn
    counter uint64
    size    int
    dialer  func(ctx context.Context) (*grpc.ClientConn, error)
}

func NewPool(size int, dialer func(ctx context.Context) (*grpc.ClientConn, error)) (*Pool, error) {
    p := &Pool{
        conns:  make([]*grpc.ClientConn, size),
        size:   size,
        dialer: dialer,
    }

    ctx := context.Background()
    for i := 0; i < size; i++ {
        conn, err := dialer(ctx)
        if err != nil {
            p.Close()
            return nil, fmt.Errorf("dialing connection %d: %w", i, err)
        }
        p.conns[i] = conn
    }

    return p, nil
}

// Get returns a connection using round-robin selection
func (p *Pool) Get() *grpc.ClientConn {
    idx := atomic.AddUint64(&p.counter, 1) % uint64(p.size)
    return p.conns[idx]
}

func (p *Pool) Close() {
    for _, conn := range p.conns {
        if conn != nil {
            conn.Close()
        }
    }
}
```

### Streaming for Batch Operations

```go
// Batch fetch using client streaming
func (c *OrderClient) BulkGetOrders(ctx context.Context, orderIDs []string) ([]*myappv1.Order, error) {
    // For small batches, parallel unary calls are sufficient
    if len(orderIDs) <= 10 {
        return c.parallelGetOrders(ctx, orderIDs)
    }

    // For large batches, use a single list call with ID filter
    // or implement client-streaming RPC
    orders := make([]*myappv1.Order, 0, len(orderIDs))
    for i := 0; i < len(orderIDs); i += 50 {
        end := i + 50
        if end > len(orderIDs) {
            end = len(orderIDs)
        }

        // Use ListOrders with ID filter
        batch, err := c.getOrderBatch(ctx, orderIDs[i:end])
        if err != nil {
            return nil, err
        }
        orders = append(orders, batch...)
    }
    return orders, nil
}

func (c *OrderClient) parallelGetOrders(ctx context.Context, orderIDs []string) ([]*myappv1.Order, error) {
    type result struct {
        order *myappv1.Order
        err   error
        idx   int
    }

    results := make(chan result, len(orderIDs))
    for i, id := range orderIDs {
        go func(idx int, orderID string) {
            order, err := c.GetOrder(ctx, orderID)
            results <- result{order: order, err: err, idx: idx}
        }(i, id)
    }

    orders := make([]*myappv1.Order, len(orderIDs))
    for range orderIDs {
        r := <-results
        if r.err != nil {
            return nil, r.err
        }
        orders[r.idx] = r.order
    }
    return orders, nil
}

func (c *OrderClient) getOrderBatch(ctx context.Context, ids []string) ([]*myappv1.Order, error) {
    // Implementation depends on your proto service definition
    return nil, nil
}
```

## Section 7: Protobuf v2 Go API

```go
// Using the modern protobuf v2 API (google.golang.org/protobuf)
package main

import (
    "fmt"

    "google.golang.org/protobuf/proto"
    "google.golang.org/protobuf/reflect/protoreflect"
    "google.golang.org/protobuf/types/dynamicpb"
    "google.golang.org/protobuf/encoding/protojson"
    "google.golang.org/protobuf/encoding/prototext"

    myappv1 "github.com/myorg/myapp/gen/go/myapp/v1"
)

func demonstrateV2API() {
    order := &myappv1.Order{
        Id:     "order-123",
        UserId: "user-456",
        Status: myappv1.OrderStatus_ORDER_STATUS_PENDING,
        Total: &myappv1.Money{
            CurrencyCode: "USD",
            Amount:       9900,
        },
    }

    // Binary serialization
    data, err := proto.Marshal(order)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Binary size: %d bytes\n", len(data))

    // Deserialization
    var decoded myappv1.Order
    if err := proto.Unmarshal(data, &decoded); err != nil {
        panic(err)
    }

    // JSON serialization with field names
    jsonBytes, err := protojson.Marshal(order)
    if err != nil {
        panic(err)
    }
    fmt.Printf("JSON: %s\n", jsonBytes)

    // JSON with custom options
    marshaler := protojson.MarshalOptions{
        UseProtoNames:   true,   // snake_case instead of camelCase
        EmitUnpopulated: false,  // Omit zero-value fields
        Indent:          "  ",
    }
    jsonBytes, _ = marshaler.Marshal(order)
    fmt.Printf("JSON (proto names):\n%s\n", jsonBytes)

    // Text format (for debug/logging)
    textBytes := prototext.Format(order)
    fmt.Printf("Text:\n%s\n", textBytes)

    // Reflection API — enumerate fields
    md := order.ProtoReflect().Descriptor()
    for i := 0; i < md.Fields().Len(); i++ {
        fd := md.Fields().Get(i)
        val := order.ProtoReflect().Get(fd)
        if order.ProtoReflect().Has(fd) {
            fmt.Printf("Field %s = %v\n", fd.Name(), val)
        }
    }

    // Clone
    cloned := proto.Clone(order).(*myappv1.Order)
    cloned.Status = myappv1.OrderStatus_ORDER_STATUS_SHIPPED

    // Merge
    update := &myappv1.Order{
        Status: myappv1.OrderStatus_ORDER_STATUS_CONFIRMED,
    }
    proto.Merge(order, update)

    // Equal comparison
    fmt.Printf("Equal: %v\n", proto.Equal(order, &decoded))

    // Dynamic message (when you don't have the generated type)
    dynamicMsg := dynamicpb.NewMessage(md)
    idField := md.Fields().ByName(protoreflect.Name("id"))
    dynamicMsg.Set(idField, protoreflect.ValueOfString("dynamic-123"))
    fmt.Printf("Dynamic ID: %s\n", dynamicMsg.Get(idField).String())
}
```

## Conclusion

Protocol Buffers and gRPC form a robust foundation for internal service communication. The key practices are: use Buf CLI to enforce linting and catch breaking changes before they reach production; follow the backward compatibility rules religiously — reserved fields, never reuse field numbers; use the protobuf v2 Go API for reflection and dynamic message handling; and implement retry policies in your service config rather than in application code.

Schema evolution is where most teams struggle. Building a habit of running `buf breaking` on every proto PR catches issues that would otherwise surface as silent data corruption or runtime panics in old clients.
