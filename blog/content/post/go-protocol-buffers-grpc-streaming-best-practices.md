---
title: "Go Protocol Buffers: proto3, gRPC Server Streaming, and Protobuf Best Practices"
date: 2030-04-25T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Protocol Buffers", "Protobuf", "Streaming", "API Design"]
categories: ["Go", "APIs"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Protocol Buffers and gRPC in Go covering proto3 schema design for API evolution, optional fields, well-known types, server and bidirectional streaming patterns, and buf CLI for schema linting and breaking change detection."
more_link: "yes"
url: "/go-protocol-buffers-grpc-streaming-best-practices/"
---

Protocol Buffers paired with gRPC give Go services a type-safe, wire-efficient, and evolvable communication layer that REST+JSON cannot match at scale. But the benefits only materialize when you treat your `.proto` files with the same discipline you apply to database schemas — because breaking a proto schema in a deployed system is equivalent to dropping a column from a production table.

This guide covers proto3 design for long-term API evolution, Go's gRPC streaming patterns, well-known types, and the buf CLI toolchain for enforcing schema hygiene across teams.

<!--more-->

# Go Protocol Buffers: proto3, gRPC Server Streaming, and Protobuf Best Practices

## Project Setup

### Tool Installation

```bash
# Install protoc
apt-get install -y protobuf-compiler  # Debian/Ubuntu
# OR
brew install protobuf  # macOS

# Install Go plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Install buf CLI (preferred over raw protoc for teams)
brew install bufbuild/buf/buf  # macOS
# OR
curl -sSL https://github.com/bufbuild/buf/releases/latest/download/buf-Linux-x86_64 \
  -o /usr/local/bin/buf && chmod +x /usr/local/bin/buf
```

### Go Module Setup

```bash
mkdir grpc-demo && cd grpc-demo
go mod init github.com/yourorg/grpc-demo

go get google.golang.org/grpc@latest
go get google.golang.org/protobuf@latest
go get google.golang.org/grpc/codes
go get google.golang.org/grpc/status
go get google.golang.org/grpc/metadata
go get google.golang.org/grpc/health/grpc_health_v1
```

### buf.yaml Configuration

```yaml
# buf.yaml
version: v2
modules:
  - path: proto
deps:
  - buf.build/googleapis/googleapis
  - buf.build/grpc/grpc
lint:
  use:
    - DEFAULT
  except:
    - UNARY_RPC          # Allow when intentional
  ignore_only:
    PACKAGE_VERSION_SUFFIX:
      - proto/internal   # Internal packages exempt
breaking:
  use:
    - FILE
  except:
    - FIELD_SAME_DEFAULT # Relaxed for internal services
```

```yaml
# buf.gen.yaml
version: v2
plugins:
  - plugin: go
    out: gen/go
    opt:
      - paths=source_relative
  - plugin: go-grpc
    out: gen/go
    opt:
      - paths=source_relative
      - require_unimplemented_servers=false
```

## proto3 Schema Design for API Evolution

### Foundational Rules

The cardinal rule of protobuf schema design: **field numbers are permanent**. Once a field number is used in a released binary, it cannot be reused or removed — only reserved.

```protobuf
// proto/catalog/v1/catalog.proto
syntax = "proto3";

package catalog.v1;

option go_package = "github.com/yourorg/grpc-demo/gen/go/catalog/v1;catalogv1";

import "google/protobuf/timestamp.proto";
import "google/protobuf/duration.proto";
import "google/protobuf/wrappers.proto";
import "google/protobuf/field_mask.proto";

// Product represents a catalog entry.
// Field numbers 1-15 use 1-byte tags (prefer for frequent fields).
// Field numbers 16-2047 use 2-byte tags.
message Product {
  // Core identity fields (1-byte range — use for most common fields)
  string id = 1;
  string name = 2;
  string description = 3;
  Price price = 4;
  ProductStatus status = 5;

  // Timestamps using well-known types
  google.protobuf.Timestamp created_at = 6;
  google.protobuf.Timestamp updated_at = 7;

  // Nested messages
  repeated Category categories = 8;
  Inventory inventory = 9;

  // Optional fields using proto3 optional (requires protoc 3.15+)
  optional string sku = 10;
  optional string barcode = 11;

  // Map field for extensible key-value metadata
  map<string, string> attributes = 12;

  // Oneof for mutually exclusive variants
  oneof pricing_model {
    FixedPricing fixed = 13;
    SubscriptionPricing subscription = 14;
    AuctionPricing auction = 15;
  }

  // Reserved field numbers and names to prevent accidental reuse
  // These were removed in v1.2 but numbers must never be recycled
  reserved 20, 21, 22;
  reserved "legacy_sku", "old_price_cents";
}

message Price {
  int64 amount_micros = 1;  // Amount in millionths of currency unit
  string currency_code = 2; // ISO 4217 currency code
}

enum ProductStatus {
  PRODUCT_STATUS_UNSPECIFIED = 0; // Always include unspecified as zero value
  PRODUCT_STATUS_ACTIVE = 1;
  PRODUCT_STATUS_INACTIVE = 2;
  PRODUCT_STATUS_DISCONTINUED = 3;
}

message Category {
  string id = 1;
  string name = 2;
  string parent_id = 3;
}

message Inventory {
  int32 quantity_on_hand = 1;
  int32 quantity_reserved = 2;
  optional string warehouse_id = 3;
  google.protobuf.Timestamp last_updated = 4;
}

message FixedPricing {
  Price msrp = 1;
  optional Price sale_price = 2;
}

message SubscriptionPricing {
  Price monthly_price = 1;
  Price annual_price = 2;
  google.protobuf.Duration trial_period = 3;
}

message AuctionPricing {
  Price starting_bid = 1;
  Price reserve_price = 2;
  google.protobuf.Timestamp auction_end = 3;
}
```

### Well-Known Types in Practice

```protobuf
// proto/catalog/v1/service.proto
syntax = "proto3";

package catalog.v1;

option go_package = "github.com/yourorg/grpc-demo/gen/go/catalog/v1;catalogv1";

import "catalog/v1/catalog.proto";
import "google/protobuf/field_mask.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/timestamp.proto";

service CatalogService {
  // Unary RPCs
  rpc GetProduct(GetProductRequest) returns (GetProductResponse);
  rpc CreateProduct(CreateProductRequest) returns (CreateProductResponse);
  rpc UpdateProduct(UpdateProductRequest) returns (UpdateProductResponse);
  rpc DeleteProduct(DeleteProductRequest) returns (google.protobuf.Empty);

  // Server streaming: large result sets
  rpc ListProducts(ListProductsRequest) returns (stream Product);

  // Client streaming: batch import
  rpc ImportProducts(stream ImportProductRequest) returns (ImportProductResponse);

  // Bidirectional streaming: real-time price sync
  rpc SyncPrices(stream PriceSyncRequest) returns (stream PriceSyncResponse);
}

message GetProductRequest {
  string id = 1;
  // FieldMask limits which fields are returned — reduces payload size
  google.protobuf.FieldMask read_mask = 2;
}

message GetProductResponse {
  Product product = 1;
}

message CreateProductRequest {
  Product product = 1;
  // Idempotency key prevents duplicate creation on retries
  string idempotency_key = 2;
}

message CreateProductResponse {
  Product product = 1;
}

message UpdateProductRequest {
  Product product = 1;
  // FieldMask specifies which fields to update (PATCH semantics)
  google.protobuf.FieldMask update_mask = 2;
}

message UpdateProductResponse {
  Product product = 1;
}

message DeleteProductRequest {
  string id = 1;
}

message ListProductsRequest {
  // Cursor-based pagination (prefer over offset for large datasets)
  string page_token = 1;
  int32 page_size = 2;
  // Filter expression (AIP-160 style)
  string filter = 3;
  // Sort order (AIP-132 style)
  string order_by = 4;
  // Time range filter using well-known Timestamp
  google.protobuf.Timestamp created_after = 5;
  google.protobuf.Timestamp created_before = 6;
}

message ImportProductRequest {
  Product product = 1;
  bool upsert = 2;  // true = create or update, false = create only
}

message ImportProductResponse {
  int32 created_count = 1;
  int32 updated_count = 2;
  int32 failed_count = 3;
  repeated ImportError errors = 4;
}

message ImportError {
  int32 index = 1;          // Position in import stream
  string product_id = 2;
  string error_message = 3;
}

message PriceSyncRequest {
  string product_id = 1;
  Price new_price = 2;
  string reason = 3;
}

message PriceSyncResponse {
  string product_id = 1;
  Price applied_price = 2;
  bool success = 3;
  string error_message = 4;
}
```

## Go gRPC Server Implementation

### Server with All Streaming Patterns

```go
// server/catalog_server.go
package server

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"

	catalogv1 "github.com/yourorg/grpc-demo/gen/go/catalog/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type CatalogServer struct {
	catalogv1.UnimplementedCatalogServiceServer
	store  ProductStore
	logger *slog.Logger
}

func NewCatalogServer(store ProductStore, logger *slog.Logger) *CatalogServer {
	return &CatalogServer{store: store, logger: logger}
}

// GetProduct — unary RPC with FieldMask support
func (s *CatalogServer) GetProduct(
	ctx context.Context,
	req *catalogv1.GetProductRequest,
) (*catalogv1.GetProductResponse, error) {
	if req.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "product id is required")
	}

	product, err := s.store.Get(ctx, req.GetId())
	if err != nil {
		if isNotFound(err) {
			return nil, status.Errorf(codes.NotFound, "product %q not found", req.GetId())
		}
		s.logger.ErrorContext(ctx, "failed to get product", "id", req.GetId(), "error", err)
		return nil, status.Error(codes.Internal, "internal error")
	}

	// Apply FieldMask if provided
	if req.GetReadMask() != nil && len(req.GetReadMask().GetPaths()) > 0 {
		applyFieldMask(product, req.GetReadMask())
	}

	return &catalogv1.GetProductResponse{Product: product}, nil
}

// ListProducts — server streaming RPC for large result sets
func (s *CatalogServer) ListProducts(
	req *catalogv1.ListProductsRequest,
	stream catalogv1.CatalogService_ListProductsServer,
) error {
	ctx := stream.Context()

	// Send initial metadata with stream info
	header := metadata.New(map[string]string{
		"x-stream-start": time.Now().UTC().Format(time.RFC3339),
	})
	if err := stream.SendHeader(header); err != nil {
		return status.Errorf(codes.Internal, "failed to send header: %v", err)
	}

	pageSize := req.GetPageSize()
	if pageSize <= 0 || pageSize > 1000 {
		pageSize = 100
	}

	var (
		cursor    = req.GetPageToken()
		totalSent int
	)

	for {
		// Check if client has cancelled
		select {
		case <-ctx.Done():
			s.logger.InfoContext(ctx, "stream cancelled by client", "sent", totalSent)
			return status.Error(codes.Canceled, "stream cancelled")
		default:
		}

		products, nextCursor, err := s.store.List(ctx, ListOptions{
			PageToken:     cursor,
			PageSize:      int(pageSize),
			Filter:        req.GetFilter(),
			OrderBy:       req.GetOrderBy(),
			CreatedAfter:  req.GetCreatedAfter().AsTime(),
			CreatedBefore: req.GetCreatedBefore().AsTime(),
		})
		if err != nil {
			return status.Errorf(codes.Internal, "failed to list products: %v", err)
		}

		for _, product := range products {
			if err := stream.Send(product); err != nil {
				// Client disconnected — this is normal, not an error worth logging at ERROR
				s.logger.InfoContext(ctx, "stream send failed", "error", err, "sent", totalSent)
				return err
			}
			totalSent++
		}

		if nextCursor == "" {
			// No more pages
			break
		}
		cursor = nextCursor
	}

	// Send trailing metadata with summary
	trailer := metadata.New(map[string]string{
		"x-total-sent": fmt.Sprintf("%d", totalSent),
	})
	stream.SetTrailer(trailer)

	s.logger.InfoContext(ctx, "stream completed", "sent", totalSent)
	return nil
}

// ImportProducts — client streaming RPC for batch operations
func (s *CatalogServer) ImportProducts(
	stream catalogv1.CatalogService_ImportProductsServer,
) error {
	ctx := stream.Context()

	var (
		createdCount int32
		updatedCount int32
		failedCount  int32
		errors       []*catalogv1.ImportError
		index        int32
	)

	for {
		req, err := stream.Recv()
		if err == io.EOF {
			// Client done sending
			break
		}
		if err != nil {
			return status.Errorf(codes.Internal, "receive error: %v", err)
		}

		select {
		case <-ctx.Done():
			return status.Error(codes.Canceled, "import cancelled")
		default:
		}

		if req.GetUpsert() {
			_, upsertErr := s.store.Upsert(ctx, req.GetProduct())
			if upsertErr != nil {
				failedCount++
				errors = append(errors, &catalogv1.ImportError{
					Index:        index,
					ProductId:    req.GetProduct().GetId(),
					ErrorMessage: upsertErr.Error(),
				})
			} else {
				updatedCount++
			}
		} else {
			_, createErr := s.store.Create(ctx, req.GetProduct())
			if createErr != nil {
				failedCount++
				errors = append(errors, &catalogv1.ImportError{
					Index:        index,
					ProductId:    req.GetProduct().GetId(),
					ErrorMessage: createErr.Error(),
				})
			} else {
				createdCount++
			}
		}
		index++
	}

	return stream.SendAndClose(&catalogv1.ImportProductResponse{
		CreatedCount: createdCount,
		UpdatedCount: updatedCount,
		FailedCount:  failedCount,
		Errors:       errors,
	})
}

// SyncPrices — bidirectional streaming for real-time price updates
func (s *CatalogServer) SyncPrices(
	stream catalogv1.CatalogService_SyncPricesServer,
) error {
	ctx := stream.Context()
	s.logger.InfoContext(ctx, "price sync stream opened")

	for {
		req, err := stream.Recv()
		if err == io.EOF {
			s.logger.InfoContext(ctx, "price sync stream closed by client")
			return nil
		}
		if err != nil {
			return status.Errorf(codes.Internal, "sync receive error: %v", err)
		}

		select {
		case <-ctx.Done():
			return status.Error(codes.Canceled, "sync cancelled")
		default:
		}

		// Apply price update
		updatedProduct, applyErr := s.store.UpdatePrice(ctx, req.GetProductId(), req.GetNewPrice())

		var response *catalogv1.PriceSyncResponse
		if applyErr != nil {
			response = &catalogv1.PriceSyncResponse{
				ProductId:    req.GetProductId(),
				Success:      false,
				ErrorMessage: applyErr.Error(),
			}
		} else {
			response = &catalogv1.PriceSyncResponse{
				ProductId:    req.GetProductId(),
				AppliedPrice: updatedProduct.GetPrice(),
				Success:      true,
			}
		}

		if sendErr := stream.Send(response); sendErr != nil {
			return sendErr
		}
	}
}

// DeleteProduct — returns well-known Empty type
func (s *CatalogServer) DeleteProduct(
	ctx context.Context,
	req *catalogv1.DeleteProductRequest,
) (*emptypb.Empty, error) {
	if req.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "product id is required")
	}

	if err := s.store.Delete(ctx, req.GetId()); err != nil {
		if isNotFound(err) {
			return nil, status.Errorf(codes.NotFound, "product %q not found", req.GetId())
		}
		return nil, status.Error(codes.Internal, "delete failed")
	}

	return &emptypb.Empty{}, nil
}
```

### Server Bootstrap with Middleware

```go
// server/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"

	catalogv1 "github.com/yourorg/grpc-demo/gen/go/catalog/v1"
	"github.com/yourorg/grpc-demo/server"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	// Keepalive parameters — important for streaming under load balancers
	kaParams := keepalive.ServerParameters{
		MaxConnectionIdle:     5 * time.Minute,
		MaxConnectionAge:      30 * time.Minute,
		MaxConnectionAgeGrace: 5 * time.Second,
		Time:                  2 * time.Minute,
		Timeout:               20 * time.Second,
	}

	kaPolicy := keepalive.EnforcementPolicy{
		MinTime:             30 * time.Second,
		PermitWithoutStream: true,
	}

	grpcServer := grpc.NewServer(
		grpc.KeepaliveParams(kaParams),
		grpc.KeepaliveEnforcementPolicy(kaPolicy),
		grpc.MaxRecvMsgSize(16*1024*1024),  // 16 MB
		grpc.MaxSendMsgSize(16*1024*1024),  // 16 MB
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
		grpc.ChainUnaryInterceptor(
			loggingUnaryInterceptor(logger),
			recoveryUnaryInterceptor(logger),
			validationUnaryInterceptor(),
		),
		grpc.ChainStreamInterceptor(
			loggingStreamInterceptor(logger),
			recoveryStreamInterceptor(logger),
		),
	)

	// Register services
	store := server.NewInMemoryStore()
	catalogService := server.NewCatalogServer(store, logger)
	catalogv1.RegisterCatalogServiceServer(grpcServer, catalogService)

	// Health check service
	healthServer := health.NewServer()
	healthServer.SetServingStatus("catalog.v1.CatalogService", grpc_health_v1.HealthCheckResponse_SERVING)
	grpc_health_v1.RegisterHealthServer(grpcServer, healthServer)

	// Reflection for tools like grpcurl
	reflection.Register(grpcServer)

	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		logger.Error("failed to listen", "error", err)
		os.Exit(1)
	}

	go func() {
		logger.Info("gRPC server starting", "addr", ":50051")
		if err := grpcServer.Serve(lis); err != nil {
			logger.Error("server failed", "error", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	logger.Info("shutting down gRPC server")
	healthServer.SetServingStatus("catalog.v1.CatalogService", grpc_health_v1.HealthCheckResponse_NOT_SERVING)

	// GracefulStop waits for active RPCs to complete
	stopped := make(chan struct{})
	go func() {
		grpcServer.GracefulStop()
		close(stopped)
	}()

	select {
	case <-stopped:
		logger.Info("server stopped gracefully")
	case <-time.After(30 * time.Second):
		logger.Warn("graceful stop timed out, forcing stop")
		grpcServer.Stop()
	}
}
```

## Go gRPC Client Patterns

### Client with Streaming Consumption

```go
// client/catalog_client.go
package client

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	catalogv1 "github.com/yourorg/grpc-demo/gen/go/catalog/v1"
)

type CatalogClient struct {
	conn   *grpc.ClientConn
	client catalogv1.CatalogServiceClient
	logger *slog.Logger
}

func NewCatalogClient(addr string, logger *slog.Logger) (*CatalogClient, error) {
	conn, err := grpc.NewClient(
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                10 * time.Second,
			Timeout:             5 * time.Second,
			PermitWithoutStream: true,
		}),
		grpc.WithDefaultServiceConfig(`{
			"methodConfig": [{
				"name": [{"service": "catalog.v1.CatalogService"}],
				"retryPolicy": {
					"maxAttempts": 4,
					"initialBackoff": "0.5s",
					"maxBackoff": "10s",
					"backoffMultiplier": 2,
					"retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
				}
			}]
		}`),
	)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", addr, err)
	}

	return &CatalogClient{
		conn:   conn,
		client: catalogv1.NewCatalogServiceClient(conn),
		logger: logger,
	}, nil
}

func (c *CatalogClient) Close() error {
	return c.conn.Close()
}

// ConsumeProductStream demonstrates server streaming consumption
func (c *CatalogClient) ConsumeProductStream(
	ctx context.Context,
	req *catalogv1.ListProductsRequest,
	handler func(*catalogv1.Product) error,
) error {
	// Request trailing metadata to capture summary
	var trailer metadata.MD
	stream, err := c.client.ListProducts(ctx, req,
		grpc.Trailer(&trailer),
	)
	if err != nil {
		return fmt.Errorf("list products stream: %w", err)
	}

	// Read header metadata
	header, err := stream.Header()
	if err != nil {
		c.logger.Warn("failed to read stream header", "error", err)
	} else {
		c.logger.Info("stream opened", "start", header.Get("x-stream-start"))
	}

	var received int
	for {
		product, err := stream.Recv()
		if err == io.EOF {
			// Stream completed normally
			c.logger.Info("stream completed",
				"received", received,
				"total_sent", trailer.Get("x-total-sent"),
			)
			return nil
		}
		if err != nil {
			st, ok := status.FromError(err)
			if ok && st.Code() == codes.Canceled {
				c.logger.Info("stream cancelled", "received", received)
				return nil
			}
			return fmt.Errorf("recv: %w", err)
		}

		if err := handler(product); err != nil {
			// Cancel stream on handler error
			return fmt.Errorf("handler error at index %d: %w", received, err)
		}
		received++
	}
}

// RunPriceSync demonstrates bidirectional streaming
func (c *CatalogClient) RunPriceSync(
	ctx context.Context,
	updates <-chan *catalogv1.PriceSyncRequest,
	results chan<- *catalogv1.PriceSyncResponse,
) error {
	stream, err := c.client.SyncPrices(ctx)
	if err != nil {
		return fmt.Errorf("open sync stream: %w", err)
	}

	// Receive goroutine
	receiveErr := make(chan error, 1)
	go func() {
		defer close(results)
		for {
			resp, err := stream.Recv()
			if err == io.EOF {
				receiveErr <- nil
				return
			}
			if err != nil {
				receiveErr <- fmt.Errorf("sync recv: %w", err)
				return
			}
			select {
			case results <- resp:
			case <-ctx.Done():
				receiveErr <- ctx.Err()
				return
			}
		}
	}()

	// Send loop
	for {
		select {
		case req, ok := <-updates:
			if !ok {
				// Sender done — close send half
				if err := stream.CloseSend(); err != nil {
					return fmt.Errorf("close send: %w", err)
				}
				return <-receiveErr
			}
			if err := stream.Send(req); err != nil {
				return fmt.Errorf("sync send: %w", err)
			}
		case <-ctx.Done():
			_ = stream.CloseSend()
			return ctx.Err()
		case err := <-receiveErr:
			return err
		}
	}
}
```

## buf CLI for Schema Governance

### Linting Configuration

```yaml
# buf.yaml (full lint configuration)
version: v2
modules:
  - path: proto
lint:
  use:
    - DEFAULT      # Includes all stable rules
    - COMMENTS     # Require comments on all public types
  except:
    - PACKAGE_VERSION_SUFFIX   # Suppress if not using versioned packages everywhere
  ignore_only:
    RPC_RESPONSE_STANDARD_NAME:
      - proto/legacy  # Legacy package exemption
  enum_zero_value_suffix: _UNSPECIFIED
  service_suffix: Service
  rpc_allow_same_request_response: false
  rpc_allow_google_protobuf_empty_requests: true   # Allow for DELETE RPCs
  rpc_allow_google_protobuf_empty_responses: true  # Allow for DELETE RPCs
```

### Breaking Change Detection

```bash
# Check for breaking changes against main branch
buf breaking --against '.git#branch=main'

# Check against a specific git tag
buf breaking --against '.git#tag=v1.2.0'

# Check against a remote BSR (Buf Schema Registry)
buf breaking --against buf.build/yourorg/catalog

# Output in JSON for CI integration
buf breaking --against '.git#branch=main' --error-format json
```

### CI/CD Pipeline Integration

```yaml
# .github/workflows/proto-checks.yml
name: Protobuf CI

on:
  pull_request:
    paths:
      - 'proto/**'
      - 'buf.yaml'
      - 'buf.gen.yaml'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - uses: bufbuild/buf-action@v1
      with:
        setup_only: true

    - name: Lint protobuf files
      run: buf lint

    - name: Check for breaking changes
      run: buf breaking --against '.git#branch=main'

    - name: Generate code
      run: buf generate

    - name: Verify generated code is committed
      run: |
        if [ -n "$(git status --porcelain gen/)" ]; then
          echo "Generated code is out of date. Run 'buf generate' and commit."
          git diff gen/
          exit 1
        fi

  test:
    runs-on: ubuntu-latest
    needs: lint
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.24'
    - run: go test ./...
```

## Advanced Patterns

### Interceptors for Request Tracing and Validation

```go
// middleware/interceptors.go
package middleware

import (
	"context"
	"log/slog"
	"runtime/debug"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

func LoggingUnaryInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		start := time.Now()

		p, _ := peer.FromContext(ctx)
		addr := ""
		if p != nil {
			addr = p.Addr.String()
		}

		resp, err := handler(ctx, req)

		st, _ := status.FromError(err)
		logger.InfoContext(ctx, "unary rpc",
			"method", info.FullMethod,
			"peer", addr,
			"duration_ms", time.Since(start).Milliseconds(),
			"code", st.Code().String(),
		)

		return resp, err
	}
}

func RecoveryUnaryInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (resp interface{}, err error) {
		defer func() {
			if r := recover(); r != nil {
				logger.ErrorContext(ctx, "panic in handler",
					"method", info.FullMethod,
					"panic", r,
					"stack", string(debug.Stack()),
				)
				err = status.Errorf(codes.Internal, "internal server error")
			}
		}()
		return handler(ctx, req)
	}
}

// ValidationUnaryInterceptor invokes Validate() if the message implements it
func ValidationUnaryInterceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		if v, ok := req.(interface{ Validate() error }); ok {
			if err := v.Validate(); err != nil {
				return nil, status.Errorf(codes.InvalidArgument, "validation: %v", err)
			}
		}
		return handler(ctx, req)
	}
}
```

### Using Wrappers for Nullable Scalar Fields

Proto3 does not natively distinguish between "field not set" and "field set to zero value" for scalar types. The `google.protobuf.Wrappers` types provide nullable scalars:

```protobuf
import "google/protobuf/wrappers.proto";

message ProductFilter {
  // These can distinguish between "not set" and "explicitly 0"
  google.protobuf.Int32Value min_quantity = 1;
  google.protobuf.DoubleValue min_price = 2;
  google.protobuf.BoolValue in_stock = 3;  // true=in stock, false=out of stock, nil=any
}
```

In Go:

```go
import "google.golang.org/protobuf/types/known/wrapperspb"

filter := &catalogv1.ProductFilter{
    MinQuantity: wrapperspb.Int32(0),  // Explicitly include zero-quantity products
    InStock:     wrapperspb.Bool(true), // Filter to in-stock only
    // MinPrice not set — means no price filter
}

// Reading
if filter.GetMinQuantity() != nil {
    // Apply minimum quantity filter
    minQty := filter.GetMinQuantity().GetValue()
}
```

Note: For new schemas, proto3 `optional` fields (using `optional string field = N`) are preferred over wrapper types for simple scalars. Wrapper types are more explicit but add message encoding overhead.

## Key Takeaways

- Field numbers in `.proto` files are permanent identifiers — once published, never reuse or remove them; use `reserved` instead.
- Use `optional` for scalar fields when you need to distinguish "not set" from zero value; use `google.protobuf.Wrappers` when you need nullable scalars in older schemas or across languages.
- Server streaming is appropriate for large result sets where the full response would exceed memory or timeout constraints; use trailing metadata to communicate result summaries.
- Bidirectional streaming with separate send/receive goroutines on the client side requires careful context cancellation handling to avoid goroutine leaks.
- The `partition` field in StatefulSet rolling updates and the buf `breaking` command share a common theme: both enforce that changes flow in a controlled, verifiable order.
- Run `buf breaking` in every PR that touches `.proto` files to catch API compatibility regressions before they reach production clients.
- Keepalive parameters are essential for streaming connections through load balancers; the defaults are too aggressive for most infrastructure.
