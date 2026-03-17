---
title: "Go gRPC Gateway: REST/gRPC Transcoding for Enterprise APIs"
date: 2030-01-18T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "REST", "API", "Protobuf", "OpenAPI", "Microservices"]
categories: ["Go", "API Design"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Implementing dual REST and gRPC API exposure with grpc-gateway, covering proto HTTP annotations, OpenAPI generation, middleware chains, streaming endpoint transcoding, and production deployment patterns."
more_link: "yes"
url: "/go-grpc-gateway-rest-grpc-transcoding-enterprise/"
---

gRPC is the right protocol for service-to-service communication: binary encoding, streaming, bidirectional flow, and generated clients in every language. But browser clients, third-party integrations, and legacy systems expect REST/JSON. grpc-gateway solves this by translating HTTP/1.1 REST calls into gRPC calls — a single Go binary exposes both protocols from the same service implementation. This guide builds a complete enterprise API with grpc-gateway, covering proto annotations, OpenAPI generation, authentication middleware, streaming transcoding, and production deployment with TLS termination.

<!--more-->

# Go gRPC Gateway: REST/gRPC Transcoding for Enterprise APIs

## Architecture Overview

grpc-gateway works as a reverse proxy that runs in-process with your gRPC server:

```
Browser / REST client                    gRPC client
       │                                      │
       │ HTTP/1.1 JSON                        │ HTTP/2 protobuf
       ▼                                      ▼
┌──────────────────────────────────────────────────┐
│               Go Service Binary                   │
│  ┌─────────────────┐    ┌───────────────────────┐ │
│  │  HTTP/1.1       │    │   gRPC Server         │ │
│  │  grpc-gateway   │───▶│   (real impl)         │ │
│  │  (port 8080)    │    │   (port 9090)         │ │
│  └─────────────────┘    └───────────────────────┘ │
│  ┌─────────────────────────────────────────────┐  │
│  │  Shared Middleware                           │  │
│  │  (auth, rate-limit, logging, tracing)        │  │
│  └─────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
                          │
               OpenAPI v2/v3 spec
               (auto-generated)
```

## Project Setup

### Dependencies

```bash
mkdir -p api-gateway && cd api-gateway
go mod init github.com/company/api-gateway

# Core dependencies
go get google.golang.org/grpc@v1.64.0
go get google.golang.org/protobuf@v1.34.0
go get github.com/grpc-ecosystem/grpc-gateway/v2@v2.21.0
go get github.com/grpc-ecosystem/go-grpc-middleware/v2@v2.1.0
go get github.com/grpc-ecosystem/go-grpc-prometheus@v1.2.0

# OpenAPI generation
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2@latest
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# buf for proto management
go install github.com/bufbuild/buf/cmd/buf@latest
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
    - UNARY_RPC
breaking:
  use:
    - FILE
```

### Proto Generation Configuration

```yaml
# buf.gen.yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go
    out: gen/go
    opt:
      - paths=source_relative

  - remote: buf.build/grpc/go
    out: gen/go
    opt:
      - paths=source_relative
      - require_unimplemented_servers=false

  - remote: buf.build/grpc-ecosystem/gateway
    out: gen/go
    opt:
      - paths=source_relative
      - generate_unbound_methods=true

  - remote: buf.build/grpc-ecosystem/openapiv2
    out: gen/openapi
    opt:
      - logtostderr=true
      - json_names_for_fields=true
      - openapi_naming_strategy=fqn
      - allow_merge=true
      - merge_file_name=api
      - include_package_in_tags=false
```

## Proto Service Definition

### Complete Order Service Proto

```protobuf
// proto/order/v1/order_service.proto
syntax = "proto3";

package order.v1;

import "google/api/annotations.proto";
import "google/api/field_behavior.proto";
import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";
import "protoc-gen-openapiv2/options/annotations.proto";

option go_package = "github.com/company/api-gateway/gen/go/order/v1;orderv1";

// OpenAPI-level metadata
option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger) = {
  info: {
    title: "Order Management API"
    version: "2.0.0"
    contact: {
      name: "Platform Team"
      url: "https://internal.company.com/docs/orders"
      email: "platform@company.com"
    }
    license: {
      name: "Proprietary"
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
        description: "JWT bearer token"
      }
    }
  }
  security: {
    security_requirement: {
      key: "BearerAuth"
      value: {}
    }
  }
};

// OrderService manages the order lifecycle
service OrderService {
  // CreateOrder places a new order
  rpc CreateOrder(CreateOrderRequest) returns (Order) {
    option (google.api.http) = {
      post: "/v1/orders"
      body: "*"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Create a new order"
      description: "Places a new order for the authenticated customer."
      tags: ["Orders"]
      responses: {
        key: "201"
        value: {
          description: "Order created successfully"
        }
      }
    };
  }

  // GetOrder retrieves an order by ID
  rpc GetOrder(GetOrderRequest) returns (Order) {
    option (google.api.http) = {
      get: "/v1/orders/{order_id}"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Get order by ID"
      tags: ["Orders"]
    };
  }

  // ListOrders returns a paginated list of orders for a customer
  rpc ListOrders(ListOrdersRequest) returns (ListOrdersResponse) {
    option (google.api.http) = {
      get: "/v1/customers/{customer_id}/orders"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "List orders for a customer"
      tags: ["Orders"]
    };
  }

  // UpdateOrder modifies an existing order (partial update)
  rpc UpdateOrder(UpdateOrderRequest) returns (Order) {
    option (google.api.http) = {
      patch: "/v1/orders/{order_id}"
      body: "order"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Update order"
      tags: ["Orders"]
    };
  }

  // CancelOrder cancels an order
  rpc CancelOrder(CancelOrderRequest) returns (Order) {
    option (google.api.http) = {
      post: "/v1/orders/{order_id}:cancel"
      body: "*"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Cancel an order"
      tags: ["Orders"]
    };
  }

  // WatchOrder streams order status changes (server-streaming)
  rpc WatchOrder(WatchOrderRequest) returns (stream OrderEvent) {
    option (google.api.http) = {
      get: "/v1/orders/{order_id}/events"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Stream order status events"
      description: "Opens a long-lived connection that streams order status changes. REST clients receive newline-delimited JSON."
      tags: ["Orders", "Streaming"]
    };
  }
}

// Messages

message Order {
  string order_id = 1 [(google.api.field_behavior) = OUTPUT_ONLY];
  string customer_id = 2 [(google.api.field_behavior) = REQUIRED];
  OrderStatus status = 3 [(google.api.field_behavior) = OUTPUT_ONLY];
  repeated OrderItem items = 4 [(google.api.field_behavior) = REQUIRED];
  int64 total_cents = 5 [(google.api.field_behavior) = OUTPUT_ONLY];
  string currency = 6;
  google.protobuf.Timestamp created_at = 7 [(google.api.field_behavior) = OUTPUT_ONLY];
  google.protobuf.Timestamp updated_at = 8 [(google.api.field_behavior) = OUTPUT_ONLY];
  string tracking_number = 9 [(google.api.field_behavior) = OUTPUT_ONLY];
}

message OrderItem {
  string product_id = 1 [(google.api.field_behavior) = REQUIRED];
  string sku = 2;
  int32 quantity = 3 [(google.api.field_behavior) = REQUIRED];
  int64 unit_price_cents = 4 [(google.api.field_behavior) = REQUIRED];
}

enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;
  ORDER_STATUS_DRAFT = 1;
  ORDER_STATUS_CONFIRMED = 2;
  ORDER_STATUS_PAID = 3;
  ORDER_STATUS_SHIPPED = 4;
  ORDER_STATUS_DELIVERED = 5;
  ORDER_STATUS_CANCELLED = 6;
}

message CreateOrderRequest {
  string customer_id = 1 [(google.api.field_behavior) = REQUIRED];
  repeated OrderItem items = 2 [(google.api.field_behavior) = REQUIRED];
  string currency = 3;
  // Idempotency key to prevent duplicate orders
  string idempotency_key = 4;
}

message GetOrderRequest {
  string order_id = 1 [(google.api.field_behavior) = REQUIRED];
}

message ListOrdersRequest {
  string customer_id = 1 [(google.api.field_behavior) = REQUIRED];
  int32 page_size = 2;
  string page_token = 3;
  OrderStatus status_filter = 4;
}

message ListOrdersResponse {
  repeated Order orders = 1;
  string next_page_token = 2;
  int32 total_count = 3;
}

message UpdateOrderRequest {
  string order_id = 1 [(google.api.field_behavior) = REQUIRED];
  Order order = 2 [(google.api.field_behavior) = REQUIRED];
  // Fields to update (using field mask pattern)
  repeated string update_mask = 3;
}

message CancelOrderRequest {
  string order_id = 1 [(google.api.field_behavior) = REQUIRED];
  string reason = 2 [(google.api.field_behavior) = REQUIRED];
}

message WatchOrderRequest {
  string order_id = 1 [(google.api.field_behavior) = REQUIRED];
}

message OrderEvent {
  string event_id = 1;
  string order_id = 2;
  OrderStatus previous_status = 3;
  OrderStatus current_status = 4;
  google.protobuf.Timestamp occurred_at = 5;
  string description = 6;
}
```

## Server Implementation

### gRPC Server with Gateway

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
    grpcmiddleware "github.com/grpc-ecosystem/go-grpc-middleware/v2"
    grpcauth "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/auth"
    grpclogging "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/logging"
    grpcrecovery "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"
    grpcvalidator "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/validator"
    grpcprom "github.com/grpc-ecosystem/go-grpc-prometheus"
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "go.uber.org/zap"
    "golang.org/x/net/http2"
    "golang.org/x/net/http2/h2c"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/reflection"
    "google.golang.org/grpc/status"

    orderv1 "github.com/company/api-gateway/gen/go/order/v1"
    "github.com/company/api-gateway/internal/service"
    "github.com/company/api-gateway/internal/auth"
)

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    ctx, cancel := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer cancel()

    if err := run(ctx, logger); err != nil {
        logger.Fatal("server failed", zap.Error(err))
    }
}

func run(ctx context.Context, logger *zap.Logger) error {
    // Auth validator
    authFn := auth.NewJWTValidator(os.Getenv("JWT_PUBLIC_KEY_PATH"))

    // Panic recovery handler
    recoveryHandler := func(p interface{}) error {
        logger.Error("panic recovered", zap.Any("panic", p))
        return status.Errorf(codes.Internal, "internal server error")
    }

    // Build gRPC server with middleware chain
    grpcServer := grpc.NewServer(
        grpc.StatsHandler(otelgrpc.NewServerHandler()),
        grpc.ChainUnaryInterceptor(
            grpcrecovery.UnaryServerInterceptor(
                grpcrecovery.WithRecoveryHandler(recoveryHandler),
            ),
            grpcprom.UnaryServerInterceptor,
            grpclogging.UnaryServerInterceptor(grpclogger(logger)),
            grpcauth.UnaryServerInterceptor(authFn.Authenticate),
            grpcvalidator.UnaryServerInterceptor(),
            rateLimitInterceptor(),
        ),
        grpc.ChainStreamInterceptor(
            grpcrecovery.StreamServerInterceptor(
                grpcrecovery.WithRecoveryHandler(recoveryHandler),
            ),
            grpcprom.StreamServerInterceptor,
            grpclogging.StreamServerInterceptor(grpclogger(logger)),
            grpcauth.StreamServerInterceptor(authFn.Authenticate),
        ),
    )

    // Register services
    orderSvc := service.NewOrderService(logger)
    orderv1.RegisterOrderServiceServer(grpcServer, orderSvc)

    // Enable reflection for grpcurl and Postman
    reflection.Register(grpcServer)

    // Enable Prometheus metrics collection
    grpcprom.Register(grpcServer)

    // Start gRPC listener
    grpcLn, err := net.Listen("tcp", ":9090")
    if err != nil {
        return fmt.Errorf("gRPC listen: %w", err)
    }

    go func() {
        logger.Info("gRPC server starting", zap.String("addr", ":9090"))
        if err := grpcServer.Serve(grpcLn); err != nil {
            logger.Error("gRPC server error", zap.Error(err))
        }
    }()

    // Build gRPC-Gateway mux
    gwMux := runtime.NewServeMux(
        runtime.WithErrorHandler(customErrorHandler),
        runtime.WithMetadata(extractHTTPMetadata),
        runtime.WithForwardResponseOption(setHTTPStatusCode),
        runtime.WithIncomingHeaderMatcher(customHeaderMatcher),
        runtime.WithOutgoingHeaderMatcher(customOutgoingHeaderMatcher),
        runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
            MarshalOptions: protojson.MarshalOptions{
                UseProtoNames:   false,
                EmitUnpopulated: false,
            },
            UnmarshalOptions: protojson.UnmarshalOptions{
                DiscardUnknown: true,
            },
        }),
    )

    // Dial the local gRPC server
    conn, err := grpc.DialContext(ctx, "localhost:9090",
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(16*1024*1024)),
    )
    if err != nil {
        return fmt.Errorf("dial gRPC: %w", err)
    }

    // Register gateway handlers
    if err := orderv1.RegisterOrderServiceHandler(ctx, gwMux, conn); err != nil {
        return fmt.Errorf("register gateway: %w", err)
    }

    // Build HTTP mux combining gateway + health + metrics
    httpMux := http.NewServeMux()
    httpMux.Handle("/v1/", corsMiddleware(authMiddleware(authFn, gwMux)))
    httpMux.HandleFunc("/healthz", healthHandler)
    httpMux.Handle("/metrics", promhttp.Handler())
    httpMux.HandleFunc("/openapi.json", serveOpenAPI)

    // h2c enables HTTP/2 without TLS (for in-cluster use)
    httpServer := &http.Server{
        Addr:         ":8080",
        Handler:      h2c.NewHandler(httpMux, &http2.Server{}),
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    go func() {
        logger.Info("HTTP/REST gateway starting", zap.String("addr", ":8080"))
        if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            logger.Error("HTTP server error", zap.Error(err))
        }
    }()

    <-ctx.Done()

    logger.Info("Shutting down...")
    grpcServer.GracefulStop()

    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()
    return httpServer.Shutdown(shutdownCtx)
}
```

### Custom Error Handler

```go
// internal/gateway/errors.go
package gateway

import (
    "context"
    "net/http"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/encoding/protojson"
)

// ErrorResponse is the standard error format for REST clients
type ErrorResponse struct {
    Code    int    `json:"code"`
    Message string `json:"message"`
    Details []any  `json:"details,omitempty"`
    TraceID string `json:"traceId,omitempty"`
}

func customErrorHandler(
    ctx context.Context,
    mux *runtime.ServeMux,
    marshaler runtime.Marshaler,
    w http.ResponseWriter,
    r *http.Request,
    err error,
) {
    st := status.Convert(err)

    httpStatus := runtime.HTTPStatusFromCode(st.Code())

    // Map specific gRPC codes to appropriate HTTP status codes
    switch st.Code() {
    case codes.InvalidArgument, codes.OutOfRange:
        httpStatus = http.StatusBadRequest
    case codes.Unauthenticated:
        httpStatus = http.StatusUnauthorized
    case codes.PermissionDenied:
        httpStatus = http.StatusForbidden
    case codes.NotFound:
        httpStatus = http.StatusNotFound
    case codes.AlreadyExists, codes.Aborted:
        httpStatus = http.StatusConflict
    case codes.ResourceExhausted:
        httpStatus = http.StatusTooManyRequests
    case codes.Unimplemented:
        httpStatus = http.StatusNotImplemented
    case codes.Unavailable:
        httpStatus = http.StatusServiceUnavailable
    case codes.DeadlineExceeded:
        httpStatus = http.StatusGatewayTimeout
    }

    // Extract trace ID from context
    traceID := extractTraceID(ctx)

    body := ErrorResponse{
        Code:    int(st.Code()),
        Message: st.Message(),
        TraceID: traceID,
    }

    // Include error details if any
    for _, detail := range st.Details() {
        body.Details = append(body.Details, detail)
    }

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-Trace-ID", traceID)
    w.WriteHeader(httpStatus)

    data, _ := json.Marshal(body)
    w.Write(data)
}

// setHTTPStatusCode allows returning 201 for POST create operations
func setHTTPStatusCode(
    ctx context.Context,
    w http.ResponseWriter,
    resp proto.Message,
) error {
    // Check if the gRPC method is a create operation
    if md, ok := runtime.ServerMetadataFromContext(ctx); ok {
        if md.HeaderMD.Get("x-http-code") != nil {
            code := md.HeaderMD.Get("x-http-code")[0]
            if code == "201" {
                w.WriteHeader(http.StatusCreated)
            }
        }
    }
    return nil
}
```

### Streaming Endpoint Handler

```go
// internal/service/order_service.go (streaming portion)
package service

import (
    "fmt"
    "time"

    orderv1 "github.com/company/api-gateway/gen/go/order/v1"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"
)

// WatchOrder implements server-side streaming
// REST clients receive newline-delimited JSON via grpc-gateway
func (s *OrderService) WatchOrder(
    req *orderv1.WatchOrderRequest,
    stream orderv1.OrderService_WatchOrderServer,
) error {
    if req.OrderId == "" {
        return status.Error(codes.InvalidArgument, "order_id is required")
    }

    // Validate order exists
    _, err := s.repo.GetByID(stream.Context(), req.OrderId)
    if err != nil {
        return status.Errorf(codes.NotFound, "order %s not found", req.OrderId)
    }

    // Subscribe to order events from message bus
    events, cancel, err := s.eventBus.Subscribe(stream.Context(), req.OrderId)
    if err != nil {
        return status.Errorf(codes.Internal, "failed to subscribe: %v", err)
    }
    defer cancel()

    // Keep-alive ticker for REST clients (prevents proxy timeouts)
    keepAlive := time.NewTicker(30 * time.Second)
    defer keepAlive.Stop()

    for {
        select {
        case <-stream.Context().Done():
            return nil

        case <-keepAlive.C:
            // Send a heartbeat event to keep the connection alive
            heartbeat := &orderv1.OrderEvent{
                EventId:     fmt.Sprintf("heartbeat-%d", time.Now().Unix()),
                OrderId:     req.OrderId,
                OccurredAt:  timestamppb.Now(),
                Description: "heartbeat",
            }
            if err := stream.Send(heartbeat); err != nil {
                return err
            }

        case event, ok := <-events:
            if !ok {
                return nil
            }
            if err := stream.Send(event); err != nil {
                return err
            }
        }
    }
}
```

## Middleware Chain

### Authentication Middleware

```go
// internal/auth/jwt.go
package auth

import (
    "context"
    "crypto/rsa"
    "fmt"
    "os"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

type Claims struct {
    jwt.RegisteredClaims
    UserID      string   `json:"sub"`
    Roles       []string `json:"roles"`
    CustomerID  string   `json:"customer_id,omitempty"`
    Permissions []string `json:"permissions,omitempty"`
}

type contextKey string

const (
    claimsKey  contextKey = "claims"
    userIDKey  contextKey = "user_id"
)

// JWTValidator validates JWT tokens for both gRPC and HTTP contexts
type JWTValidator struct {
    publicKey *rsa.PublicKey
}

func NewJWTValidator(keyPath string) *JWTValidator {
    data, err := os.ReadFile(keyPath)
    if err != nil {
        panic(fmt.Sprintf("failed to read public key: %v", err))
    }

    key, err := jwt.ParseRSAPublicKeyFromPEM(data)
    if err != nil {
        panic(fmt.Sprintf("failed to parse public key: %v", err))
    }

    return &JWTValidator{publicKey: key}
}

// Authenticate is the gRPC auth middleware function
func (v *JWTValidator) Authenticate(ctx context.Context) (context.Context, error) {
    token, err := extractBearerToken(ctx)
    if err != nil {
        return ctx, status.Errorf(codes.Unauthenticated, "missing or invalid token: %v", err)
    }

    claims, err := v.validate(token)
    if err != nil {
        return ctx, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
    }

    ctx = context.WithValue(ctx, claimsKey, claims)
    ctx = context.WithValue(ctx, userIDKey, claims.UserID)
    return ctx, nil
}

func (v *JWTValidator) validate(tokenStr string) (*Claims, error) {
    token, err := jwt.ParseWithClaims(tokenStr, &Claims{},
        func(t *jwt.Token) (interface{}, error) {
            if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
                return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
            }
            return v.publicKey, nil
        },
        jwt.WithExpirationRequired(),
        jwt.WithIssuedAt(),
        jwt.WithAudience("api.company.com"),
    )
    if err != nil {
        return nil, err
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return nil, fmt.Errorf("invalid token claims")
    }

    return claims, nil
}

func extractBearerToken(ctx context.Context) (string, error) {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return "", fmt.Errorf("no metadata")
    }

    authHeaders := md.Get("authorization")
    if len(authHeaders) == 0 {
        return "", fmt.Errorf("no authorization header")
    }

    parts := strings.SplitN(authHeaders[0], " ", 2)
    if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
        return "", fmt.Errorf("invalid authorization format")
    }

    return parts[1], nil
}

// ClaimsFromContext extracts JWT claims from the context
func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
    claims, ok := ctx.Value(claimsKey).(*Claims)
    return claims, ok
}
```

### Rate Limiting Interceptor

```go
// internal/middleware/ratelimit.go
package middleware

import (
    "context"
    "sync"
    "time"

    "golang.org/x/time/rate"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/peer"
    "google.golang.org/grpc/status"
)

type perClientLimiter struct {
    mu       sync.Mutex
    limiters map[string]*rate.Limiter
    r        rate.Limit
    b        int
}

func newPerClientLimiter(r rate.Limit, b int) *perClientLimiter {
    return &perClientLimiter{
        limiters: make(map[string]*rate.Limiter),
        r:        r,
        b:        b,
    }
}

func (l *perClientLimiter) getLimiter(key string) *rate.Limiter {
    l.mu.Lock()
    defer l.mu.Unlock()

    limiter, ok := l.limiters[key]
    if !ok {
        limiter = rate.NewLimiter(l.r, l.b)
        l.limiters[key] = limiter
    }
    return limiter
}

// RateLimitInterceptor creates a per-IP rate limiting interceptor
func RateLimitInterceptor(rps float64, burst int) grpc.UnaryServerInterceptor {
    limiter := newPerClientLimiter(rate.Limit(rps), burst)

    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        clientKey := clientKeyFromContext(ctx)
        l := limiter.getLimiter(clientKey)

        if !l.Allow() {
            return nil, status.Errorf(
                codes.ResourceExhausted,
                "rate limit exceeded: %s allows %.0f requests/second",
                info.FullMethod, rps,
            )
        }

        return handler(ctx, req)
    }
}

func clientKeyFromContext(ctx context.Context) string {
    // Use user ID if authenticated
    if claims, ok := auth.ClaimsFromContext(ctx); ok {
        return "user:" + claims.UserID
    }
    // Fall back to IP
    if p, ok := peer.FromContext(ctx); ok {
        return "ip:" + p.Addr.String()
    }
    return "unknown"
}
```

## HTTP Metadata Extraction

```go
// internal/gateway/metadata.go
package gateway

import (
    "context"
    "net/http"
    "strings"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc/metadata"
)

// extractHTTPMetadata converts HTTP headers to gRPC metadata
func extractHTTPMetadata(
    ctx context.Context,
    r *http.Request,
) metadata.MD {
    md := make(metadata.MD)

    // Forward tracing headers
    for _, header := range []string{
        "x-request-id",
        "x-b3-traceid",
        "x-b3-spanid",
        "x-b3-parentspanid",
        "x-b3-sampled",
        "traceparent",
        "tracestate",
    } {
        if val := r.Header.Get(header); val != "" {
            md.Set(header, val)
        }
    }

    // Forward idempotency key
    if key := r.Header.Get("idempotency-key"); key != "" {
        md.Set("idempotency-key", key)
    }

    // Real IP (when behind a load balancer)
    if ip := r.Header.Get("x-forwarded-for"); ip != "" {
        md.Set("x-forwarded-for", strings.Split(ip, ",")[0])
    }

    return md
}

// customHeaderMatcher allows forwarding custom HTTP headers as gRPC metadata
func customHeaderMatcher(key string) (string, bool) {
    key = strings.ToLower(key)
    switch key {
    case "x-request-id",
        "x-correlation-id",
        "idempotency-key",
        "x-api-version":
        return key, true
    }
    return runtime.DefaultHeaderMatcher(key)
}

func customOutgoingHeaderMatcher(key string) (string, bool) {
    switch key {
    case "x-request-id", "x-trace-id":
        return key, true
    }
    return runtime.DefaultHeaderMatcher(key)
}
```

## CORS Middleware

```go
// internal/middleware/cors.go
package middleware

import (
    "net/http"
    "os"
    "strings"
)

var allowedOrigins = strings.Split(
    envOrDefault("CORS_ALLOWED_ORIGINS", "https://app.company.com"),
    ",",
)

// CORSMiddleware handles CORS for the REST gateway
func CORSMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        origin := r.Header.Get("Origin")
        if isAllowedOrigin(origin) {
            w.Header().Set("Access-Control-Allow-Origin", origin)
            w.Header().Set("Access-Control-Allow-Methods",
                "GET, POST, PUT, PATCH, DELETE, OPTIONS")
            w.Header().Set("Access-Control-Allow-Headers",
                "Authorization, Content-Type, X-Request-ID, Idempotency-Key")
            w.Header().Set("Access-Control-Expose-Headers",
                "X-Trace-ID, X-Request-ID")
            w.Header().Set("Access-Control-Max-Age", "86400")
        }

        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusNoContent)
            return
        }

        next.ServeHTTP(w, r)
    })
}

func isAllowedOrigin(origin string) bool {
    for _, allowed := range allowedOrigins {
        if strings.TrimSpace(allowed) == origin {
            return true
        }
    }
    return false
}

func envOrDefault(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}
```

## Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-api
  template:
    metadata:
      labels:
        app: order-api
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        - name: order-api
          image: registry.company.com/order-api:v2.0.0
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: grpc
          env:
            - name: JWT_PUBLIC_KEY_PATH
              value: /etc/jwt/public.pem
            - name: CORS_ALLOWED_ORIGINS
              value: "https://app.company.com,https://admin.company.com"
          volumeMounts:
            - name: jwt-keys
              mountPath: /etc/jwt
              readOnly: true
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "1"
              memory: "512Mi"
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 30
      volumes:
        - name: jwt-keys
          secret:
            secretName: jwt-public-keys
---
apiVersion: v1
kind: Service
metadata:
  name: order-api
  namespace: production
spec:
  selector:
    app: order-api
  ports:
    - name: http
      port: 80
      targetPort: 8080
    - name: grpc
      port: 9090
      targetPort: 9090
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: order-api
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-body-size: "16m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.company.com
      secretName: api-tls
  rules:
    - host: api.company.com
      http:
        paths:
          - path: /v1
            pathType: Prefix
            backend:
              service:
                name: order-api
                port:
                  name: http
```

## Testing the Dual Protocol

```bash
# REST via curl
curl -s -X POST https://api.company.com/v1/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "customerId": "cust-123",
    "items": [
      {"productId": "prod-456", "sku": "SKU-001", "quantity": 2, "unitPriceCents": 999}
    ],
    "currency": "USD"
  }' | jq .

# gRPC via grpcurl
grpcurl \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"customer_id": "cust-123", "items": [{"product_id": "prod-456", "quantity": 2, "unit_price_cents": 999}]}' \
  api.company.com:9090 \
  order.v1.OrderService/CreateOrder

# Stream via REST (newline-delimited JSON)
curl -s -N \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.company.com/v1/orders/ord-789/events"

# OpenAPI spec
curl https://api.company.com/openapi.json | jq '.paths | keys'
```

## Conclusion

grpc-gateway enables the best of both worlds: the type safety, streaming, and code generation benefits of gRPC for internal services, with REST/JSON compatibility for external consumers. The key production considerations:

- **Custom error handling** translates gRPC status codes to semantically correct HTTP status codes — this matters for REST client error handling
- **Metadata extraction** ensures tracing headers flow through both protocol stacks, maintaining observability across REST and gRPC hops
- **Streaming transcoding** converts server-side streaming gRPC to newline-delimited JSON for REST clients, enabling real-time feeds without WebSockets
- **OpenAPI generation** from proto annotations keeps REST documentation synchronized with the implementation automatically
- **CORS middleware** is needed at the HTTP gateway layer, not the gRPC layer, since gRPC clients don't send CORS preflight requests

The most important architectural decision is running the gateway in-process with the gRPC server rather than as a sidecar: it eliminates an extra network hop for every REST request and simplifies deployment, while the performance cost (JSON serialization) is on the REST critical path anyway.
