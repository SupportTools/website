---
title: "gRPC in Go: Production Patterns for High-Performance Services"
date: 2027-11-24T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Protobuf", "Microservices", "Kubernetes"]
categories:
- Go
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building production-grade gRPC services in Go: protobuf schema design, streaming RPCs, interceptor chains, gRPC-Gateway, health checking, and Kubernetes deployment patterns."
more_link: "yes"
url: /go-grpc-advanced-kubernetes-production-guide/
---

gRPC has become the dominant RPC framework for Go microservices because it delivers HTTP/2 multiplexing, bidirectional streaming, and strongly typed contracts at the cost of a protobuf schema. However, the official documentation shows you how to compile a .proto file and make one unary call. Production systems demand interceptor chains for auth, logging, and recovery; server-side streaming for large result sets; client-side load balancing with retries; health checking integrated with Kubernetes probes; and a REST gateway for browser clients that cannot speak HTTP/2 directly.

This guide builds a complete order processing service that demonstrates every pattern your production gRPC service will need.

<!--more-->

# gRPC in Go: Production Patterns for High-Performance Services

## Why gRPC Over REST for Internal Services

REST over JSON is easy to understand but carries hidden costs in production. JSON parsing is slow compared to protobuf deserialization, HTTP/1.1 requires one connection per concurrent request which causes head-of-line blocking, and the schema is defined by convention rather than contract. A client and server can silently drift apart when a field is renamed because there is no compiler enforcing the contract.

gRPC fixes all three problems. Protobuf serialization is 3-10x faster than JSON for equivalent payloads. HTTP/2 multiplexes thousands of concurrent RPCs over a single TCP connection. The .proto schema is the contract, and if you add `reserved` fields and use the buf lint rules, breaking changes become compiler errors before they reach production.

The trade-off is tooling complexity. You need the protoc compiler, language-specific plugins, and a build pipeline that regenerates stubs when schemas change. This guide uses `buf` to manage that complexity.

## Protobuf Schema Design for Production

Schema design decisions made today are expensive to reverse. Field numbers in protobuf are permanent identifiers that appear in the wire format. Reserve numbers you may reuse, and think carefully about message composition before releasing a schema.

### Order Service Schema

```protobuf
// proto/order/v1/order.proto
syntax = "proto3";

package order.v1;

option go_package = "github.com/example/orderservice/gen/order/v1;orderv1";

import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";
import "google/api/annotations.proto";

// OrderStatus represents the lifecycle state of an order.
enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;
  ORDER_STATUS_PENDING     = 1;
  ORDER_STATUS_CONFIRMED   = 2;
  ORDER_STATUS_SHIPPED     = 3;
  ORDER_STATUS_DELIVERED   = 4;
  ORDER_STATUS_CANCELLED   = 5;
}

message OrderItem {
  string product_id = 1;
  string product_name = 2;
  int32  quantity = 3;
  // unit_price_cents avoids floating point representation errors.
  int64  unit_price_cents = 4;

  // Fields 5-9 reserved for future pricing attributes.
  reserved 5, 6, 7, 8, 9;
}

message Order {
  string                   id               = 1;
  string                   customer_id      = 2;
  repeated OrderItem       items            = 3;
  OrderStatus              status           = 4;
  google.protobuf.Timestamp created_at      = 5;
  google.protobuf.Timestamp updated_at      = 6;
  // total_cents is the sum of item quantities * unit_price_cents.
  int64                    total_cents      = 7;
  string                   shipping_address = 8;
  // idempotency_key must be provided by callers for CreateOrder.
  string                   idempotency_key  = 9;

  // Fields 10-19 reserved for payment integration.
  reserved 10, 11, 12, 13, 14, 15, 16, 17, 18, 19;
}

message CreateOrderRequest {
  string             customer_id      = 1;
  repeated OrderItem items            = 2;
  string             shipping_address = 3;
  string             idempotency_key  = 4;
}

message CreateOrderResponse {
  Order order = 1;
}

message GetOrderRequest {
  string id = 1;
}

message ListOrdersRequest {
  string customer_id = 1;
  // page_size limits the number of orders returned in one stream segment.
  int32  page_size   = 2;
  string page_token  = 3;
  OrderStatus status_filter = 4;
}

message BatchCreateOrdersRequest {
  repeated CreateOrderRequest orders = 1;
}

message BatchCreateOrdersResponse {
  repeated Order created_orders  = 1;
  repeated string failed_ids     = 2; // idempotency_keys that failed
}

message TrackOrderRequest {
  string order_id = 1;
}

message OrderStatusUpdate {
  string                   order_id   = 1;
  OrderStatus              new_status = 2;
  google.protobuf.Timestamp changed_at = 3;
  string                   message    = 4;
}

// OrderService exposes CRUD and streaming operations for orders.
service OrderService {
  // CreateOrder creates a single order. Idempotent via idempotency_key.
  rpc CreateOrder(CreateOrderRequest) returns (CreateOrderResponse) {
    option (google.api.http) = {
      post: "/v1/orders"
      body: "*"
    };
  }

  // GetOrder retrieves a single order by ID.
  rpc GetOrder(GetOrderRequest) returns (Order) {
    option (google.api.http) = {
      get: "/v1/orders/{id}"
    };
  }

  // ListOrders streams orders for a customer, supporting pagination.
  rpc ListOrders(ListOrdersRequest) returns (stream Order) {
    option (google.api.http) = {
      get: "/v1/orders"
    };
  }

  // BatchCreateOrders creates multiple orders from a client stream.
  rpc BatchCreateOrders(stream CreateOrderRequest) returns (BatchCreateOrdersResponse) {}

  // TrackOrder streams real-time status updates for an order.
  rpc TrackOrder(TrackOrderRequest) returns (stream OrderStatusUpdate) {
    option (google.api.http) = {
      get: "/v1/orders/{order_id}/track"
    };
  }
}
```

### buf Configuration

buf eliminates manual protoc plugin management and enforces lint rules and breaking change detection.

```yaml
# buf.yaml
version: v2
modules:
  - path: proto
lint:
  use:
    - STANDARD
  except:
    - UNARY_RPC  # allow streaming RPCs alongside unary
breaking:
  use:
    - WIRE_COMPATIBLE
deps:
  - buf.build/googleapis/googleapis
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
  - remote: buf.build/grpc-ecosystem/gateway
    out: gen
    opt:
      - paths=source_relative
      - generate_unbound_methods=true
  - remote: buf.build/grpc-ecosystem/openapiv2
    out: openapi
    opt:
      - json_names_for_fields=true
```

Run code generation with:

```bash
buf generate
buf lint
buf breaking --against '.git#branch=main'
```

## Server Implementation

### Core Server Struct

```go
// internal/server/order_server.go
package server

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	orderv1 "github.com/example/orderservice/gen/order/v1"
	"github.com/example/orderservice/internal/store"
)

// OrderServer implements the gRPC OrderService.
type OrderServer struct {
	orderv1.UnimplementedOrderServiceServer
	store   store.OrderStore
	tracker *StatusTracker
}

// NewOrderServer constructs an OrderServer with its dependencies.
func NewOrderServer(s store.OrderStore, t *StatusTracker) *OrderServer {
	return &OrderServer{store: s, tracker: t}
}

// CreateOrder handles idempotent order creation.
func (s *OrderServer) CreateOrder(ctx context.Context, req *orderv1.CreateOrderRequest) (*orderv1.CreateOrderResponse, error) {
	if req.IdempotencyKey == "" {
		return nil, status.Error(codes.InvalidArgument, "idempotency_key is required")
	}
	if req.CustomerId == "" {
		return nil, status.Error(codes.InvalidArgument, "customer_id is required")
	}
	if len(req.Items) == 0 {
		return nil, status.Error(codes.InvalidArgument, "at least one item is required")
	}

	// Check idempotency cache before creating.
	existing, err := s.store.GetByIdempotencyKey(ctx, req.IdempotencyKey)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, status.Errorf(codes.Internal, "idempotency check failed: %v", err)
	}
	if existing != nil {
		return &orderv1.CreateOrderResponse{Order: toProto(existing)}, nil
	}

	var totalCents int64
	for _, item := range req.Items {
		if item.Quantity <= 0 {
			return nil, status.Errorf(codes.InvalidArgument, "item %s: quantity must be positive", item.ProductId)
		}
		if item.UnitPriceCents <= 0 {
			return nil, status.Errorf(codes.InvalidArgument, "item %s: unit_price_cents must be positive", item.ProductId)
		}
		totalCents += int64(item.Quantity) * item.UnitPriceCents
	}

	order := &store.Order{
		ID:              uuid.New().String(),
		CustomerID:      req.CustomerId,
		Status:          store.OrderStatusPending,
		ShippingAddress: req.ShippingAddress,
		IdempotencyKey:  req.IdempotencyKey,
		TotalCents:      totalCents,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}
	for _, item := range req.Items {
		order.Items = append(order.Items, store.OrderItem{
			ProductID:      item.ProductId,
			ProductName:    item.ProductName,
			Quantity:       int(item.Quantity),
			UnitPriceCents: item.UnitPriceCents,
		})
	}

	if err := s.store.Create(ctx, order); err != nil {
		if errors.Is(err, store.ErrConflict) {
			// Race condition: another request created with same idempotency key.
			existing, _ = s.store.GetByIdempotencyKey(ctx, req.IdempotencyKey)
			if existing != nil {
				return &orderv1.CreateOrderResponse{Order: toProto(existing)}, nil
			}
		}
		return nil, status.Errorf(codes.Internal, "create order: %v", err)
	}

	return &orderv1.CreateOrderResponse{Order: toProto(order)}, nil
}

// GetOrder retrieves a single order by ID.
func (s *OrderServer) GetOrder(ctx context.Context, req *orderv1.GetOrderRequest) (*orderv1.Order, error) {
	if req.Id == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}

	order, err := s.store.GetByID(ctx, req.Id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, status.Errorf(codes.NotFound, "order %s not found", req.Id)
		}
		return nil, status.Errorf(codes.Internal, "get order: %v", err)
	}

	return toProto(order), nil
}

// ListOrders streams orders matching the filter criteria.
// Server-streaming allows the client to start processing results before all
// rows have been fetched from the database.
func (s *OrderServer) ListOrders(req *orderv1.ListOrdersRequest, stream orderv1.OrderService_ListOrdersServer) error {
	ctx := stream.Context()

	if req.CustomerId == "" {
		return status.Error(codes.InvalidArgument, "customer_id is required")
	}

	pageSize := int(req.PageSize)
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 50
	}

	filter := store.OrderFilter{
		CustomerID: req.CustomerId,
		PageSize:   pageSize,
		PageToken:  req.PageToken,
	}
	if req.StatusFilter != orderv1.OrderStatus_ORDER_STATUS_UNSPECIFIED {
		statusStr := protoStatusToStore(req.StatusFilter)
		filter.Status = &statusStr
	}

	for {
		orders, nextToken, err := s.store.List(ctx, filter)
		if err != nil {
			return status.Errorf(codes.Internal, "list orders: %v", err)
		}

		for _, order := range orders {
			// Check for context cancellation between sends to avoid holding
			// resources after the client has disconnected.
			if err := ctx.Err(); err != nil {
				return status.FromContextError(err).Err()
			}
			if err := stream.Send(toProto(order)); err != nil {
				return err
			}
		}

		if nextToken == "" {
			break
		}
		filter.PageToken = nextToken
	}

	return nil
}

// BatchCreateOrders reads orders from a client stream and creates them.
// Client-streaming allows clients to send large batches without assembling a
// single large request in memory.
func (s *OrderServer) BatchCreateOrders(stream orderv1.OrderService_BatchCreateOrdersServer) error {
	ctx := stream.Context()

	var created []*orderv1.Order
	var failedKeys []string

	for {
		req, err := stream.Recv()
		if err != nil {
			// io.EOF signals normal end of client stream.
			break
		}

		resp, err := s.CreateOrder(ctx, req)
		if err != nil {
			// Record the failure but continue processing remaining items.
			st, _ := status.FromError(err)
			failedKeys = append(failedKeys, fmt.Sprintf("%s: %s", req.IdempotencyKey, st.Message()))
			continue
		}
		created = append(created, resp.Order)
	}

	return stream.SendAndClose(&orderv1.BatchCreateOrdersResponse{
		CreatedOrders: created,
		FailedIds:     failedKeys,
	})
}

// TrackOrder streams real-time status updates for a specific order.
// Bidirectional streaming (here implemented as server-streaming) is appropriate
// when the server needs to push updates over a long-lived connection.
func (s *OrderServer) TrackOrder(req *orderv1.TrackOrderRequest, stream orderv1.OrderService_TrackOrderServer) error {
	ctx := stream.Context()

	if req.OrderId == "" {
		return status.Error(codes.InvalidArgument, "order_id is required")
	}

	// Verify the order exists before subscribing.
	if _, err := s.store.GetByID(ctx, req.OrderId); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return status.Errorf(codes.NotFound, "order %s not found", req.OrderId)
		}
		return status.Errorf(codes.Internal, "get order: %v", err)
	}

	updates := s.tracker.Subscribe(req.OrderId)
	defer s.tracker.Unsubscribe(req.OrderId, updates)

	for {
		select {
		case <-ctx.Done():
			return status.FromContextError(ctx.Err()).Err()
		case update, ok := <-updates:
			if !ok {
				// Channel closed means the order reached a terminal state.
				return nil
			}
			if err := stream.Send(&orderv1.OrderStatusUpdate{
				OrderId:   update.OrderID,
				NewStatus: storeStatusToProto(update.NewStatus),
				ChangedAt: timestamppb.New(update.ChangedAt),
				Message:   update.Message,
			}); err != nil {
				return err
			}
		}
	}
}

// toProto converts a store order to its protobuf representation.
func toProto(o *store.Order) *orderv1.Order {
	p := &orderv1.Order{
		Id:              o.ID,
		CustomerId:      o.CustomerID,
		Status:          storeStatusToProto(o.Status),
		TotalCents:      o.TotalCents,
		ShippingAddress: o.ShippingAddress,
		IdempotencyKey:  o.IdempotencyKey,
		CreatedAt:       timestamppb.New(o.CreatedAt),
		UpdatedAt:       timestamppb.New(o.UpdatedAt),
	}
	for _, item := range o.Items {
		p.Items = append(p.Items, &orderv1.OrderItem{
			ProductId:      item.ProductID,
			ProductName:    item.ProductName,
			Quantity:       int32(item.Quantity),
			UnitPriceCents: item.UnitPriceCents,
		})
	}
	return p
}
```

## Interceptor Chain

Interceptors are gRPC's middleware. The chain runs in the order it is registered for unary calls, and wraps the streaming handler for streaming calls.

`★ Insight ─────────────────────────────────────`
The `grpc.ChainUnaryInterceptor` runs interceptors in order, so place the recovery interceptor first (outermost) so it catches panics from all subsequent interceptors. Place the auth interceptor second so downstream interceptors can assume a valid identity. Logging should be last in the inbound direction but first to record the outbound response, which is the natural inside-out execution order.
`─────────────────────────────────────────────────`

```go
// internal/interceptor/auth.go
package interceptor

import (
	"context"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type contextKey string

const callerIDKey contextKey = "caller_id"

// AuthInterceptor validates bearer tokens and injects caller identity.
type AuthInterceptor struct {
	validator TokenValidator
	// publicMethods are fully qualified method names that skip auth.
	publicMethods map[string]bool
}

// TokenValidator validates a bearer token and returns the caller ID.
type TokenValidator interface {
	Validate(ctx context.Context, token string) (callerID string, err error)
}

func NewAuthInterceptor(v TokenValidator, public ...string) *AuthInterceptor {
	m := make(map[string]bool, len(public))
	for _, p := range public {
		m[p] = true
	}
	return &AuthInterceptor{validator: v, publicMethods: m}
}

func (a *AuthInterceptor) Unary() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		if a.publicMethods[info.FullMethod] {
			return handler(ctx, req)
		}
		ctx, err := a.authenticate(ctx)
		if err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

func (a *AuthInterceptor) Stream() grpc.StreamServerInterceptor {
	return func(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if a.publicMethods[info.FullMethod] {
			return handler(srv, ss)
		}
		ctx, err := a.authenticate(ss.Context())
		if err != nil {
			return err
		}
		return handler(srv, &wrappedStream{ss, ctx})
	}
}

func (a *AuthInterceptor) authenticate(ctx context.Context) (context.Context, error) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "missing metadata")
	}

	values := md.Get("authorization")
	if len(values) == 0 {
		return nil, status.Error(codes.Unauthenticated, "missing authorization header")
	}

	token := strings.TrimPrefix(values[0], "Bearer ")
	if token == values[0] {
		return nil, status.Error(codes.Unauthenticated, "authorization header must be Bearer token")
	}

	callerID, err := a.validator.Validate(ctx, token)
	if err != nil {
		return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
	}

	return context.WithValue(ctx, callerIDKey, callerID), nil
}

// CallerIDFromContext extracts the caller ID set by AuthInterceptor.
func CallerIDFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(callerIDKey).(string)
	return v, ok
}

// wrappedStream replaces the context on a ServerStream.
type wrappedStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *wrappedStream) Context() context.Context { return w.ctx }
```

```go
// internal/interceptor/logging.go
package interceptor

import (
	"context"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

// LoggingInterceptor logs each RPC with duration and status code.
type LoggingInterceptor struct {
	logger *zap.Logger
}

func NewLoggingInterceptor(logger *zap.Logger) *LoggingInterceptor {
	return &LoggingInterceptor{logger: logger}
}

func (l *LoggingInterceptor) Unary() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		start := time.Now()
		resp, err := handler(ctx, req)
		l.log(ctx, info.FullMethod, time.Since(start), err)
		return resp, err
	}
}

func (l *LoggingInterceptor) Stream() grpc.StreamServerInterceptor {
	return func(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		start := time.Now()
		err := handler(srv, ss)
		l.log(ss.Context(), info.FullMethod, time.Since(start), err)
		return err
	}
}

func (l *LoggingInterceptor) log(ctx context.Context, method string, duration time.Duration, err error) {
	code := codes.OK
	if err != nil {
		code = status.Code(err)
	}

	fields := []zap.Field{
		zap.String("method", method),
		zap.Duration("duration", duration),
		zap.String("code", code.String()),
	}

	if p, ok := peer.FromContext(ctx); ok {
		fields = append(fields, zap.String("peer", p.Addr.String()))
	}
	if callerID, ok := CallerIDFromContext(ctx); ok {
		fields = append(fields, zap.String("caller_id", callerID))
	}
	if err != nil {
		fields = append(fields, zap.Error(err))
	}

	if code == codes.OK || code == codes.Canceled {
		l.logger.Info("rpc", fields...)
	} else {
		l.logger.Error("rpc", fields...)
	}
}
```

```go
// internal/interceptor/recovery.go
package interceptor

import (
	"context"
	"runtime/debug"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// RecoveryInterceptor converts panics to Internal gRPC errors.
type RecoveryInterceptor struct {
	logger *zap.Logger
}

func NewRecoveryInterceptor(logger *zap.Logger) *RecoveryInterceptor {
	return &RecoveryInterceptor{logger: logger}
}

func (r *RecoveryInterceptor) Unary() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp interface{}, err error) {
		defer func() {
			if p := recover(); p != nil {
				r.logger.Error("panic recovered",
					zap.String("method", info.FullMethod),
					zap.Any("panic", p),
					zap.ByteString("stack", debug.Stack()),
				)
				err = status.Errorf(codes.Internal, "internal server error")
			}
		}()
		return handler(ctx, req)
	}
}

func (r *RecoveryInterceptor) Stream() grpc.StreamServerInterceptor {
	return func(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
		defer func() {
			if p := recover(); p != nil {
				r.logger.Error("panic recovered in stream",
					zap.String("method", info.FullMethod),
					zap.Any("panic", p),
					zap.ByteString("stack", debug.Stack()),
				)
				err = status.Errorf(codes.Internal, "internal server error")
			}
		}()
		return handler(srv, ss)
	}
}
```

## Main Server Setup

```go
// cmd/server/main.go
package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"

	orderv1 "github.com/example/orderservice/gen/order/v1"
	"github.com/example/orderservice/internal/interceptor"
	"github.com/example/orderservice/internal/server"
	"github.com/example/orderservice/internal/store/postgres"
)

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	db, err := postgres.NewDB(os.Getenv("DATABASE_URL"))
	if err != nil {
		logger.Fatal("connect to database", zap.Error(err))
	}
	defer db.Close()

	orderStore := postgres.NewOrderStore(db)
	statusTracker := server.NewStatusTracker()

	// Interceptors run outermost-first on the way in. Recovery is outermost
	// so it catches panics in auth and logging. Auth is second so logging has
	// access to caller identity. Logging is innermost so it measures only the
	// handler latency, not auth overhead.
	recovery := interceptor.NewRecoveryInterceptor(logger)
	auth := interceptor.NewAuthInterceptor(
		newJWTValidator(os.Getenv("JWT_PUBLIC_KEY")),
		"/grpc.health.v1.Health/Check",
	)
	logging := interceptor.NewLoggingInterceptor(logger)

	grpcServer := grpc.NewServer(
		grpc.ChainUnaryInterceptor(
			recovery.Unary(),
			auth.Unary(),
			logging.Unary(),
		),
		grpc.ChainStreamInterceptor(
			recovery.Stream(),
			auth.Stream(),
			logging.Stream(),
		),
		// Keepalive prevents idle connections from being silently dropped by
		// load balancers and firewalls.
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
		grpc.MaxConcurrentStreams(1000),
	)

	orderServer := server.NewOrderServer(orderStore, statusTracker)
	orderv1.RegisterOrderServiceServer(grpcServer, orderServer)

	// Health server supports Kubernetes readiness and liveness probes.
	healthServer := health.NewServer()
	grpc_health_v1.RegisterHealthServer(grpcServer, healthServer)
	healthServer.SetServingStatus("order.v1.OrderService", grpc_health_v1.HealthCheckResponse_SERVING)

	// Reflection allows grpcurl and Postman to discover services without
	// the .proto files. Disable in production if service discovery is a
	// security concern.
	reflection.Register(grpcServer)

	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		logger.Fatal("listen", zap.Error(err))
	}

	// Start REST gateway alongside the gRPC server.
	gatewayServer := buildGatewayServer(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("grpc server listening", zap.String("addr", ":50051"))
		if err := grpcServer.Serve(lis); err != nil {
			logger.Error("grpc serve", zap.Error(err))
		}
	}()

	go func() {
		logger.Info("rest gateway listening", zap.String("addr", ":8080"))
		if err := gatewayServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("gateway serve", zap.Error(err))
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")

	// Mark as not serving so health probes fail and Kubernetes removes the
	// pod from Service endpoints before connections are terminated.
	healthServer.SetServingStatus("order.v1.OrderService", grpc_health_v1.HealthCheckResponse_NOT_SERVING)
	time.Sleep(5 * time.Second) // Allow in-flight requests to complete.

	grpcServer.GracefulStop()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := gatewayServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("gateway shutdown", zap.Error(err))
	}
}
```

## gRPC-Gateway: REST Bridge

gRPC-Gateway generates an HTTP/1.1 reverse proxy from `google.api.http` annotations in the .proto file. This allows browser clients and tools that do not support HTTP/2 to call the same gRPC service.

```go
// internal/gateway/gateway.go
package gateway

import (
	"context"
	"net/http"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"

	orderv1 "github.com/example/orderservice/gen/order/v1"
)

// BuildGatewayServer creates an HTTP server that proxies requests to the gRPC server.
func BuildGatewayServer(logger *zap.Logger, grpcAddr string) *http.Server {
	mux := runtime.NewServeMux(
		runtime.WithErrorHandler(customErrorHandler(logger)),
		runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
			MarshalOptions: protojson.MarshalOptions{
				UseProtoNames:   true,
				EmitUnpopulated: false,
			},
			UnmarshalOptions: protojson.UnmarshalOptions{
				DiscardUnknown: true,
			},
		}),
		// Forward incoming HTTP headers as gRPC metadata.
		runtime.WithIncomingHeaderMatcher(func(key string) (string, bool) {
			switch key {
			case "Authorization", "X-Request-Id", "X-Trace-Id":
				return key, true
			default:
				return runtime.DefaultHeaderMatcher(key)
			}
		}),
	)

	opts := []grpc.DialOption{
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	}

	ctx := context.Background()
	if err := orderv1.RegisterOrderServiceHandlerFromEndpoint(ctx, mux, grpcAddr, opts); err != nil {
		logger.Fatal("register gateway handler", zap.Error(err))
	}

	// Add CORS headers for browser clients.
	handler := corsMiddleware(mux)

	return &http.Server{
		Addr:         ":8080",
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
}

// customErrorHandler translates gRPC status codes to HTTP status codes with
// a consistent JSON error body.
func customErrorHandler(logger *zap.Logger) runtime.ErrorHandlerFunc {
	return func(ctx context.Context, mux *runtime.ServeMux, m runtime.Marshaler, w http.ResponseWriter, r *http.Request, err error) {
		st, _ := status.FromError(err)

		httpCode := runtime.HTTPStatusFromCode(st.Code())
		logger.Warn("gateway error",
			zap.Int("http_status", httpCode),
			zap.String("grpc_code", st.Code().String()),
			zap.String("message", st.Message()),
			zap.String("path", r.URL.Path),
		)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(httpCode)
		w.Write([]byte(`{"error":{"code":"` + st.Code().String() + `","message":"` + st.Message() + `"}}`))
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

## Client Patterns

### Service Config for Load Balancing and Retry

```go
// internal/client/order_client.go
package client

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"

	orderv1 "github.com/example/orderservice/gen/order/v1"
)

// serviceConfig configures client-side load balancing and retry policy.
// The retry policy applies to UNAVAILABLE and RESOURCE_EXHAUSTED codes,
// which cover transient server overload and pod restarts respectively.
var serviceConfig = mustMarshal(map[string]interface{}{
	"loadBalancingConfig": []map[string]interface{}{
		{"round_robin": map[string]interface{}{}},
	},
	"methodConfig": []map[string]interface{}{
		{
			"name": []map[string]interface{}{
				{"service": "order.v1.OrderService", "method": "CreateOrder"},
			},
			"waitForReady": true,
			"timeout":      "10s",
			"retryPolicy": map[string]interface{}{
				"maxAttempts":          4,
				"initialBackoff":       "0.5s",
				"maxBackoff":           "5s",
				"backoffMultiplier":    2.0,
				"retryableStatusCodes": []string{"UNAVAILABLE", "RESOURCE_EXHAUSTED"},
			},
		},
		{
			"name": []map[string]interface{}{
				{"service": "order.v1.OrderService", "method": "GetOrder"},
			},
			"waitForReady": true,
			"timeout":      "5s",
			"retryPolicy": map[string]interface{}{
				"maxAttempts":          5,
				"initialBackoff":       "0.1s",
				"maxBackoff":           "2s",
				"backoffMultiplier":    2.0,
				"retryableStatusCodes": []string{"UNAVAILABLE", "RESOURCE_EXHAUSTED"},
			},
		},
		{
			// Streaming RPCs are not retried automatically because the stream
			// may have partially consumed. The client application must handle
			// reconnection.
			"name": []map[string]interface{}{
				{"service": "order.v1.OrderService"},
			},
			"waitForReady": true,
			"timeout":      "60s",
		},
	},
})

func mustMarshal(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// OrderClient wraps the generated gRPC client with production patterns.
type OrderClient struct {
	conn   *grpc.ClientConn
	client orderv1.OrderServiceClient
}

// NewOrderClient creates a client connected to the given address.
// For Kubernetes, addr is the headless Service DNS name with scheme:
//
//	dns:///order-service.production.svc.cluster.local:50051
//
// The dns:/// scheme triggers the round_robin load balancer to resolve
// all A records and distribute requests across pods.
func NewOrderClient(addr string) (*OrderClient, error) {
	conn, err := grpc.Dial(
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultServiceConfig(serviceConfig),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                10 * time.Second,
			Timeout:             3 * time.Second,
			PermitWithoutStream: true,
		}),
		// MaxHeaderListSize prevents header injection attacks.
		grpc.WithMaxHeaderListSize(8192),
	)
	if err != nil {
		return nil, err
	}
	return &OrderClient{conn: conn, client: orderv1.NewOrderServiceClient(conn)}, nil
}

func (c *OrderClient) Close() error {
	return c.conn.Close()
}

// CreateOrder creates an order with the given deadline propagated from context.
// The caller is responsible for setting a context deadline before calling.
func (c *OrderClient) CreateOrder(ctx context.Context, req *orderv1.CreateOrderRequest) (*orderv1.Order, error) {
	resp, err := c.client.CreateOrder(ctx, req)
	if err != nil {
		return nil, err
	}
	return resp.Order, nil
}

// ListAllOrders consumes a server-streaming ListOrders call and collects all
// results into a slice. For large result sets, use ListOrdersStream instead
// to process orders as they arrive.
func (c *OrderClient) ListAllOrders(ctx context.Context, customerID string) ([]*orderv1.Order, error) {
	stream, err := c.client.ListOrders(ctx, &orderv1.ListOrdersRequest{
		CustomerId: customerID,
		PageSize:   50,
	})
	if err != nil {
		return nil, err
	}

	var orders []*orderv1.Order
	for {
		order, err := stream.Recv()
		if err != nil {
			// io.EOF is the normal end-of-stream signal, not an error.
			break
		}
		if err != nil {
			return nil, err
		}
		orders = append(orders, order)
	}
	return orders, nil
}

// BatchCreate sends a batch of order requests using client-streaming.
func (c *OrderClient) BatchCreate(ctx context.Context, requests []*orderv1.CreateOrderRequest) (*orderv1.BatchCreateOrdersResponse, error) {
	stream, err := c.client.BatchCreateOrders(ctx)
	if err != nil {
		return nil, err
	}

	for _, req := range requests {
		if err := stream.Send(req); err != nil {
			return nil, err
		}
	}

	return stream.CloseAndRecv()
}

// TrackOrder subscribes to order status updates and calls handler for each
// update until the stream closes or the context is cancelled.
func (c *OrderClient) TrackOrder(ctx context.Context, orderID string, handler func(*orderv1.OrderStatusUpdate)) error {
	stream, err := c.client.TrackOrder(ctx, &orderv1.TrackOrderRequest{OrderId: orderID})
	if err != nil {
		return err
	}

	for {
		update, err := stream.Recv()
		if err != nil {
			if codes.Code(codes.OK) == codes.Code(0) {
				return nil
			}
			return err
		}
		handler(update)
	}
}
```

## Dynamic Health Server

The standard `grpc/health` package sets static status. A production service should set SERVING only after it has verified its dependencies are available at startup, and transition back to NOT_SERVING before the pod is removed from Service endpoints during shutdown.

```go
// internal/health/health.go
package health

import (
	"context"
	"sync"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
)

// DynamicHealthServer wraps the standard health server to add dependency checking.
type DynamicHealthServer struct {
	server  *health.Server
	checks  []HealthCheck
	logger  *zap.Logger
	service string
	mu      sync.RWMutex
	healthy bool
}

// HealthCheck represents a dependency that must be available for the service
// to be considered healthy.
type HealthCheck struct {
	Name  string
	Check func(ctx context.Context) error
}

func NewDynamicHealthServer(service string, logger *zap.Logger, checks ...HealthCheck) *DynamicHealthServer {
	return &DynamicHealthServer{
		server:  health.NewServer(),
		checks:  checks,
		logger:  logger,
		service: service,
	}
}

func (d *DynamicHealthServer) Server() grpc_health_v1.HealthServer {
	return d.server
}

// Run starts the periodic health check loop. It blocks until ctx is cancelled.
func (d *DynamicHealthServer) Run(ctx context.Context) {
	// Run initial check immediately so the pod starts serving as soon as ready.
	d.runChecks(ctx)

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.runChecks(ctx)
		}
	}
}

func (d *DynamicHealthServer) runChecks(ctx context.Context) {
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	allHealthy := true
	for _, check := range d.checks {
		if err := check.Check(checkCtx); err != nil {
			d.logger.Warn("health check failed",
				zap.String("check", check.Name),
				zap.Error(err),
			)
			allHealthy = false
		}
	}

	d.mu.Lock()
	d.healthy = allHealthy
	d.mu.Unlock()

	if allHealthy {
		d.server.SetServingStatus(d.service, grpc_health_v1.HealthCheckResponse_SERVING)
	} else {
		d.server.SetServingStatus(d.service, grpc_health_v1.HealthCheckResponse_NOT_SERVING)
	}
}

// SetNotServing marks the service as not serving without stopping the check loop.
// Call this during graceful shutdown before GracefulStop.
func (d *DynamicHealthServer) SetNotServing() {
	d.server.SetServingStatus(d.service, grpc_health_v1.HealthCheckResponse_NOT_SERVING)
}
```

## Testing with bufconn

bufconn replaces the TCP listener with an in-memory pipe, allowing gRPC tests to run without a network.

```go
// internal/server/order_server_test.go
package server_test

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"

	orderv1 "github.com/example/orderservice/gen/order/v1"
	"github.com/example/orderservice/internal/server"
	"github.com/example/orderservice/internal/store/memory"
)

const bufSize = 1024 * 1024

func setupTestServer(t *testing.T) orderv1.OrderServiceClient {
	t.Helper()

	lis := bufconn.Listen(bufSize)
	t.Cleanup(func() { lis.Close() })

	memStore := memory.NewOrderStore()
	tracker := server.NewStatusTracker()
	orderServer := server.NewOrderServer(memStore, tracker)

	srv := grpc.NewServer()
	orderv1.RegisterOrderServiceServer(srv, orderServer)

	go func() {
		if err := srv.Serve(lis); err != nil {
			t.Logf("test server stopped: %v", err)
		}
	}()
	t.Cleanup(srv.Stop)

	conn, err := grpc.DialContext(
		context.Background(),
		"bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	return orderv1.NewOrderServiceClient(conn)
}

func TestCreateOrder_Idempotency(t *testing.T) {
	client := setupTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req := &orderv1.CreateOrderRequest{
		CustomerId:     "cust-123",
		IdempotencyKey: "idem-key-001",
		ShippingAddress: "123 Main St, Springfield, IL 62701",
		Items: []*orderv1.OrderItem{
			{
				ProductId:      "prod-abc",
				ProductName:    "Widget Pro",
				Quantity:       2,
				UnitPriceCents: 4999,
			},
		},
	}

	resp1, err := client.CreateOrder(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp1.Order)
	assert.Equal(t, "cust-123", resp1.Order.CustomerId)
	assert.EqualValues(t, 9998, resp1.Order.TotalCents) // 2 * 4999

	// Second call with the same idempotency key must return the same order.
	resp2, err := client.CreateOrder(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, resp1.Order.Id, resp2.Order.Id)
}

func TestListOrders_Streaming(t *testing.T) {
	client := setupTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Create 5 orders for customer.
	for i := 0; i < 5; i++ {
		_, err := client.CreateOrder(ctx, &orderv1.CreateOrderRequest{
			CustomerId:      "cust-stream",
			IdempotencyKey:  fmt.Sprintf("idem-%d", i),
			ShippingAddress: "456 Oak Ave",
			Items: []*orderv1.OrderItem{
				{ProductId: "prod-1", ProductName: "Item", Quantity: 1, UnitPriceCents: 100},
			},
		})
		require.NoError(t, err)
	}

	stream, err := client.ListOrders(ctx, &orderv1.ListOrdersRequest{
		CustomerId: "cust-stream",
		PageSize:   10,
	})
	require.NoError(t, err)

	var received int
	for {
		_, err := stream.Recv()
		if err != nil {
			break
		}
		received++
	}
	assert.Equal(t, 5, received)
}

func TestCreateOrder_ValidationErrors(t *testing.T) {
	client := setupTestServer(t)
	ctx := context.Background()

	tests := []struct {
		name    string
		req     *orderv1.CreateOrderRequest
		wantMsg string
	}{
		{
			name:    "missing idempotency key",
			req:     &orderv1.CreateOrderRequest{CustomerId: "cust-1"},
			wantMsg: "idempotency_key is required",
		},
		{
			name:    "missing customer id",
			req:     &orderv1.CreateOrderRequest{IdempotencyKey: "key-1"},
			wantMsg: "customer_id is required",
		},
		{
			name: "no items",
			req: &orderv1.CreateOrderRequest{
				CustomerId:     "cust-1",
				IdempotencyKey: "key-2",
			},
			wantMsg: "at least one item is required",
		},
		{
			name: "negative quantity",
			req: &orderv1.CreateOrderRequest{
				CustomerId:     "cust-1",
				IdempotencyKey: "key-3",
				Items: []*orderv1.OrderItem{
					{ProductId: "p1", Quantity: -1, UnitPriceCents: 100},
				},
			},
			wantMsg: "quantity must be positive",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := client.CreateOrder(ctx, tc.req)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantMsg)
		})
	}
}
```

## Kubernetes Deployment

### Deployment with Headless Service

A headless Service (ClusterIP: None) causes DNS to return individual pod IP addresses rather than a single virtual IP. This enables the gRPC client's round_robin load balancer to distribute requests across all pods without an external proxy.

```yaml
# k8s/order-service-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
  labels:
    app: order-service
    version: v1.4.2
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
        version: v1.4.2
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: order-service
      terminationGracePeriodSeconds: 60
      containers:
        - name: order-service
          image: registry.example.com/order-service:v1.4.2
          ports:
            - name: grpc
              containerPort: 50051
              protocol: TCP
            - name: http
              containerPort: 8080
              protocol: TCP
            - name: metrics
              containerPort: 9090
              protocol: TCP
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: order-service-db
                  key: url
            - name: JWT_PUBLIC_KEY
              valueFrom:
                secretKeyRef:
                  name: order-service-jwt
                  key: public-key
          readinessProbe:
            grpc:
              port: 50051
              service: order.v1.OrderService
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            grpc:
              port: 50051
              service: order.v1.OrderService
            initialDelaySeconds: 30
            periodSeconds: 20
            failureThreshold: 3
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          lifecycle:
            preStop:
              exec:
                # Sleep allows Kubernetes to remove the pod from Service
                # endpoints before the process starts refusing connections.
                command: ["/bin/sh", "-c", "sleep 5"]
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: order-service
```

```yaml
# k8s/order-service-headless.yaml
# Headless Service for gRPC client-side load balancing.
apiVersion: v1
kind: Service
metadata:
  name: order-service-headless
  namespace: production
  labels:
    app: order-service
spec:
  clusterIP: None  # headless
  selector:
    app: order-service
  ports:
    - name: grpc
      port: 50051
      targetPort: grpc
      protocol: TCP
---
# Regular ClusterIP Service for REST clients and external load balancers.
apiVersion: v1
kind: Service
metadata:
  name: order-service
  namespace: production
  labels:
    app: order-service
spec:
  selector:
    app: order-service
  ports:
    - name: http
      port: 80
      targetPort: http
      protocol: TCP
    - name: grpc
      port: 50051
      targetPort: grpc
      protocol: TCP
```

```yaml
# k8s/order-service-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Pods
      pods:
        metric:
          name: grpc_server_started_total
        target:
          type: AverageValue
          averageValue: 1000
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

### PodDisruptionBudget

```yaml
# k8s/order-service-pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: order-service
```

## Prometheus Metrics

The grpc-go library exposes metrics via `go-grpc-prometheus`. Register the interceptors to get automatic metrics for request counts, latencies, and in-flight RPCs.

```go
// internal/metrics/grpc.go
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	grpcprom "github.com/grpc-ecosystem/go-grpc-prometheus"
	"google.golang.org/grpc"
)

var (
	// OrderProcessingDuration tracks business-level order processing time,
	// separate from gRPC transport latency.
	OrderProcessingDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "orderservice",
		Name:      "order_processing_duration_seconds",
		Help:      "Time to process an order from receipt to database write.",
		Buckets:   prometheus.DefBuckets,
	}, []string{"status"})

	// IdempotencyHits counts how often idempotency keys deduplicate requests.
	IdempotencyHits = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "orderservice",
		Name:      "idempotency_hits_total",
		Help:      "Number of requests deduplicated by idempotency key.",
	}, []string{"method"})
)

// GRPCMetricsInterceptors returns pre-configured grpc-prometheus interceptors.
// Call EnableHandlingTimeHistogram after server registration to enable latency histograms.
func GRPCMetricsInterceptors() (grpc.UnaryServerInterceptor, grpc.StreamServerInterceptor) {
	grpcprom.EnableHandlingTimeHistogram(
		grpcprom.WithHistogramBuckets([]float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5}),
	)
	return grpcprom.UnaryServerInterceptor, grpcprom.StreamServerInterceptor
}
```

## Alerting Rules

```yaml
# monitoring/grpc-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: order-service-grpc-alerts
  namespace: production
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: order-service.grpc
      interval: 30s
      rules:
        - alert: GRPCHighErrorRate
          expr: |
            (
              sum by (grpc_method) (
                rate(grpc_server_handled_total{
                  grpc_service="order.v1.OrderService",
                  grpc_code!~"OK|CANCELLED|NOT_FOUND"
                }[5m])
              )
              /
              sum by (grpc_method) (
                rate(grpc_server_handled_total{
                  grpc_service="order.v1.OrderService"
                }[5m])
              )
            ) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High gRPC error rate for {{ $labels.grpc_method }}"
            description: "Error rate {{ $value | humanizePercentage }} exceeds 5% for {{ $labels.grpc_method }}"

        - alert: GRPCHighLatency
          expr: |
            histogram_quantile(0.99,
              sum by (grpc_method, le) (
                rate(grpc_server_handling_seconds_bucket{
                  grpc_service="order.v1.OrderService"
                }[5m])
              )
            ) > 1.0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High p99 gRPC latency for {{ $labels.grpc_method }}"
            description: "p99 latency {{ $value | humanizeDuration }} exceeds 1s for {{ $labels.grpc_method }}"

        - alert: GRPCServerDown
          expr: |
            absent(grpc_server_started_total{
              grpc_service="order.v1.OrderService"
            })
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "OrderService gRPC server is down"
            description: "No gRPC requests have been recorded for 2 minutes"
```

## Debugging Tools

### grpcurl Commands

```bash
# Discover services without .proto files (requires reflection).
grpcurl -plaintext localhost:50051 list

# Describe a service.
grpcurl -plaintext localhost:50051 describe order.v1.OrderService

# Call CreateOrder with JSON input.
grpcurl -plaintext \
  -H 'authorization: Bearer eyJhbGciOiJSUzI1NiJ9...' \
  -d '{
    "customer_id": "cust-abc123",
    "idempotency_key": "req-2024-001",
    "shipping_address": "100 Industrial Way, Chicago, IL 60601",
    "items": [
      {
        "product_id": "prod-widget",
        "product_name": "Industrial Widget",
        "quantity": 10,
        "unit_price_cents": 2500
      }
    ]
  }' \
  localhost:50051 \
  order.v1.OrderService/CreateOrder

# Stream orders for a customer.
grpcurl -plaintext \
  -H 'authorization: Bearer eyJhbGciOiJSUzI1NiJ9...' \
  -d '{"customer_id": "cust-abc123", "page_size": 20}' \
  localhost:50051 \
  order.v1.OrderService/ListOrders

# Check health.
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check

# Check specific service health.
grpcurl -plaintext -d '{"service": "order.v1.OrderService"}' \
  localhost:50051 grpc.health.v1.Health/Check
```

### Port-Forward and Debug

```bash
# Forward gRPC port for local debugging.
kubectl port-forward -n production deployment/order-service 50051:50051

# Check server reflection is enabled.
grpcurl -plaintext localhost:50051 list

# Trace a single request with verbose output.
grpcurl -plaintext -v \
  -H 'authorization: Bearer eyJhbGciOiJSUzI1NiJ9...' \
  -d '{"id": "ord-7f3a9b12"}' \
  localhost:50051 \
  order.v1.OrderService/GetOrder

# Benchmark with ghz.
ghz --insecure \
  --proto proto/order/v1/order.proto \
  --call order.v1.OrderService.GetOrder \
  --data '{"id": "ord-7f3a9b12"}' \
  --rps 500 \
  --duration 30s \
  --metadata '{"authorization": "Bearer eyJhbGciOiJSUzI1NiJ9..."}' \
  localhost:50051
```

## Common Production Issues

### Pods Behind ClusterIP Do Not Balance

**Symptom**: All gRPC requests go to one pod despite multiple replicas.

**Cause**: gRPC reuses HTTP/2 connections. A standard ClusterIP Service routes based on IP tables (TCP layer), not HTTP/2 stream multiplexing, so all streams over one connection go to one pod.

**Fix**: Use a headless Service with `dns:///` scheme in the client address to enable per-RPC load balancing:

```go
conn, err := grpc.Dial(
    "dns:///order-service-headless.production.svc.cluster.local:50051",
    grpc.WithDefaultServiceConfig(`{"loadBalancingConfig":[{"round_robin":{}}]}`),
    // ...
)
```

Or deploy a Layer-7 proxy (Envoy, Istio, Linkerd) that understands HTTP/2 framing.

### Client Context Deadline Exceeded During Pod Restart

**Symptom**: Clients receive `DeadlineExceeded` during rolling deployments.

**Cause**: When a pod is terminated, in-flight RPCs on streams to that pod fail immediately. Clients with short deadlines fail before the retry policy can act.

**Fix**: Set `waitForReady: true` in the service config and ensure deadlines are long enough to accommodate at least one retry cycle. Add a preStop sleep hook to delay SIGTERM until the pod is removed from endpoints:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 5"]
```

### io.EOF on Server-Streaming Recv

**Symptom**: `stream.Recv()` returns `io.EOF` before all expected messages are received.

**Cause**: `io.EOF` is the normal signal that the server has finished sending and closed the stream. It is not an error. The client must treat it as end-of-stream, not as a failure.

**Fix**:

```go
for {
    msg, err := stream.Recv()
    if err == io.EOF {
        break // Normal end of stream
    }
    if err != nil {
        return err // Actual error
    }
    process(msg)
}
```

### Large Message Payloads

**Symptom**: gRPC returns `ResourceExhausted: received message larger than max`.

**Cause**: The default maximum message size is 4 MB. Streaming RPCs for large result sets help avoid this, but sometimes clients send large batches.

**Fix**: Increase the limit on both server and client:

```go
grpc.NewServer(
    grpc.MaxRecvMsgSize(16 * 1024 * 1024), // 16 MB
    grpc.MaxSendMsgSize(16 * 1024 * 1024),
)

grpc.Dial(addr,
    grpc.WithDefaultCallOptions(
        grpc.MaxCallRecvMsgSize(16 * 1024 * 1024),
    ),
)
```

`★ Insight ─────────────────────────────────────`
Increasing message limits is a short-term fix. The long-term solution is to redesign APIs that produce large messages to use server-streaming RPCs. This keeps individual messages small while allowing large logical responses, and allows the client to start processing results before the full dataset is assembled.
`─────────────────────────────────────────────────`

## Summary

Production gRPC services in Go require more than the basic stub registration shown in getting-started guides. The patterns in this post address the full production surface:

- **Schema design**: field number reservation, reserved ranges, buf for lint and breaking change detection
- **All four RPC types**: unary, server-streaming, client-streaming, with proper io.EOF handling
- **Interceptor chain**: recovery outermost, auth second, logging innermost to capture caller identity
- **Load balancing**: headless Service DNS + round_robin service config for per-RPC distribution
- **Retry policy**: service config JSON with retryableStatusCodes, backoff, and waitForReady
- **Health checking**: DynamicHealthServer with dependency checks, pre-shutdown NOT_SERVING transition
- **gRPC-Gateway**: REST bridge for browser clients with custom error handler and CORS
- **Testing**: bufconn in-memory transport, table-driven tests for validation, streaming tests
- **Kubernetes**: preStop sleep, gRPC readiness/liveness probes, headless Service, HPA with RPS metrics

These patterns together deliver a service that handles rolling deployments without dropped requests, distributes load across pods without a service mesh, and provides observability through structured logging and Prometheus metrics.
