---
title: "Go Protobuf and gRPC Code Generation: buf CLI and Buf Schema Registry"
date: 2031-05-03T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Protobuf", "buf", "Schema Registry", "API Design", "Code Generation"]
categories: ["Go", "API Design"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master proto-first API design with buf CLI: buf.yaml configuration, breaking change detection, remote plugins, multi-language code generation, and Buf Schema Registry for shared schema management."
more_link: "yes"
url: "/go-protobuf-grpc-code-generation-buf-cli-schema-registry/"
---

The `buf` CLI has replaced the fragile `protoc` plugin chain as the standard for Protocol Buffer and gRPC code generation. It provides dependency management, breaking change detection, linting, and integration with the Buf Schema Registry (BSR) for sharing schemas across organizations. This guide covers the complete proto-first API workflow from local development to CI/CD and schema publishing.

<!--more-->

# Go Protobuf and gRPC Code Generation: buf CLI and Buf Schema Registry

## Section 1: Proto-First API Design Philosophy

Proto-first API design means the `.proto` file is the authoritative source of truth for your API contract. Code generation produces client and server stubs in multiple languages from a single definition. Benefits:

- **Language neutrality** - Generate Go server, TypeScript client, Python analytics client from one schema
- **Breaking change detection** - Automated checks prevent accidentally breaking existing clients
- **Documentation** - Proto files serve as executable API documentation
- **Backward compatibility** - Proto's evolution rules allow safe schema evolution

The wrong approach is to write code first and generate protos as an afterthought. Schema design decisions made in proto have long-lasting consequences.

## Section 2: Installation and Project Structure

```bash
# Install buf CLI
# macOS/Linux via binary
BUF_VERSION="1.30.0"
curl -sSL "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-$(uname -s)-$(uname -m)" \
  -o /usr/local/bin/buf
chmod +x /usr/local/bin/buf

# Verify installation
buf --version

# Install via Homebrew (macOS)
brew install bufbuild/buf/buf

# Install via Go (get latest)
go install github.com/bufbuild/buf/cmd/buf@latest
```

Recommended project structure:

```
payment-service/
├── buf.yaml              # Module configuration
├── buf.gen.yaml          # Code generation configuration
├── buf.lock              # Dependency lock file
├── proto/
│   ├── payment/
│   │   └── v1/
│   │       ├── payment.proto
│   │       ├── payment_service.proto
│   │       └── types.proto
│   └── shared/
│       └── v1/
│           ├── errors.proto
│           └── pagination.proto
├── gen/                  # Generated code (gitignored or committed)
│   └── go/
│       └── payment/
│           └── v1/
│               ├── payment.pb.go
│               ├── payment_service.pb.go
│               └── payment_service_grpc.pb.go
└── internal/
    └── server/
        └── payment_server.go
```

## Section 3: buf.yaml - Module Configuration

```yaml
# buf.yaml
version: v2

# Module name for the Buf Schema Registry
name: buf.build/myorg/payment-api

# Lint configuration
lint:
  use:
    - DEFAULT
    - UNARY_RPC  # Enforce unary RPCs have request/response names matching
  except:
    - PACKAGE_VERSION_SUFFIX  # Allow packages without version suffix during migration
  ignore:
    - proto/shared/v1/legacy.proto  # Explicitly ignore legacy file
  ignore_only:
    RPC_REQUEST_RESPONSE_UNIQUE:
      - proto/payment/v1/payment_service.proto
  enum_zero_value_suffix: _UNSPECIFIED
  rpc_allow_same_request_response: false
  rpc_allow_google_protobuf_empty_requests: false
  rpc_allow_google_protobuf_empty_responses: false

# Breaking change detection configuration
breaking:
  use:
    - FILE   # Detect any file-level breaking changes (most strict)
    # Alternatives:
    # - WIRE_JSON  # Only detect wire-breaking changes (least strict)
    # - WIRE       # Only proto wire breaking changes
  ignore:
    - proto/shared/v1/experimental.proto
  ignore_only:
    FIELD_SAME_NAME:
      - proto/payment/v1/legacy_types.proto

# Dependencies
deps:
  - buf.build/googleapis/googleapis  # google.api.*
  - buf.build/grpc-ecosystem/grpc-gateway  # grpc-gateway annotations
  - buf.build/bufbuild/protovalidate  # Field validation
```

## Section 4: Writing Production Proto Files

### Service Definition

```protobuf
// proto/payment/v1/payment_service.proto
syntax = "proto3";

package payment.v1;

import "google/api/annotations.proto";
import "google/protobuf/timestamp.proto";
import "google/protobuf/field_mask.proto";
import "buf/validate/validate.proto";
import "payment/v1/types.proto";

option go_package = "github.com/myorg/payment-service/gen/go/payment/v1;paymentv1";
option java_multiple_files = true;
option java_package = "com.myorg.payment.v1";

// PaymentService provides payment processing operations.
service PaymentService {
  // CreatePayment initiates a new payment.
  rpc CreatePayment(CreatePaymentRequest) returns (CreatePaymentResponse) {
    option (google.api.http) = {
      post: "/v1/payments"
      body: "*"
    };
  }

  // GetPayment retrieves a payment by ID.
  rpc GetPayment(GetPaymentRequest) returns (GetPaymentResponse) {
    option (google.api.http) = {
      get: "/v1/payments/{payment_id}"
    };
  }

  // ListPayments lists payments with filtering and pagination.
  rpc ListPayments(ListPaymentsRequest) returns (ListPaymentsResponse) {
    option (google.api.http) = {
      get: "/v1/payments"
    };
  }

  // UpdatePayment updates a payment's mutable fields.
  rpc UpdatePayment(UpdatePaymentRequest) returns (UpdatePaymentResponse) {
    option (google.api.http) = {
      patch: "/v1/payments/{payment_id}"
      body: "payment"
    };
  }

  // RefundPayment issues a refund for a completed payment.
  rpc RefundPayment(RefundPaymentRequest) returns (RefundPaymentResponse) {
    option (google.api.http) = {
      post: "/v1/payments/{payment_id}:refund"
      body: "*"
    };
  }

  // StreamPaymentEvents streams payment status change events.
  rpc StreamPaymentEvents(StreamPaymentEventsRequest)
    returns (stream PaymentEvent) {
    option (google.api.http) = {
      get: "/v1/payments/{payment_id}/events"
    };
  }
}

// CreatePaymentRequest is the request to create a new payment.
message CreatePaymentRequest {
  // order_id is the unique identifier for the order being paid.
  string order_id = 1 [
    (buf.validate.field).string.uuid = true,
    (buf.validate.field).required = true
  ];

  // amount is the payment amount in the smallest currency unit (e.g., cents for USD).
  int64 amount = 2 [
    (buf.validate.field).int64 = {gt: 0, lte: 1000000000},
    (buf.validate.field).required = true
  ];

  // currency is the ISO 4217 currency code.
  string currency = 3 [
    (buf.validate.field).string = {min_len: 3, max_len: 3, pattern: "^[A-Z]{3}$"},
    (buf.validate.field).required = true
  ];

  // idempotency_key prevents duplicate payment creation.
  string idempotency_key = 4 [
    (buf.validate.field).string = {min_len: 1, max_len: 64},
    (buf.validate.field).required = true
  ];

  // metadata is optional key-value metadata attached to the payment.
  map<string, string> metadata = 5 [
    (buf.validate.field).map.max_pairs = 10
  ];
}

// CreatePaymentResponse contains the created payment.
message CreatePaymentResponse {
  Payment payment = 1;
}

// GetPaymentRequest is the request to retrieve a payment.
message GetPaymentRequest {
  string payment_id = 1 [
    (buf.validate.field).string.uuid = true,
    (buf.validate.field).required = true
  ];
}

// GetPaymentResponse contains the retrieved payment.
message GetPaymentResponse {
  Payment payment = 1;
}

// ListPaymentsRequest is the request to list payments.
message ListPaymentsRequest {
  // order_id filters payments by order.
  string order_id = 1;

  // status filters payments by status.
  repeated PaymentStatus status = 2 [
    (buf.validate.field).repeated.max_items = 5
  ];

  // page_size is the maximum number of payments to return.
  int32 page_size = 3 [
    (buf.validate.field).int32 = {gte: 1, lte: 100}
  ];

  // page_token is the pagination token from a previous response.
  string page_token = 4;
}

// ListPaymentsResponse contains the list of payments.
message ListPaymentsResponse {
  repeated Payment payments = 1;
  string next_page_token = 2;
  int32 total_count = 3;
}

// UpdatePaymentRequest updates a payment's mutable fields.
message UpdatePaymentRequest {
  string payment_id = 1 [
    (buf.validate.field).string.uuid = true,
    (buf.validate.field).required = true
  ];
  Payment payment = 2 [(buf.validate.field).required = true];
  google.protobuf.FieldMask update_mask = 3;
}

// UpdatePaymentResponse contains the updated payment.
message UpdatePaymentResponse {
  Payment payment = 1;
}

// RefundPaymentRequest initiates a refund.
message RefundPaymentRequest {
  string payment_id = 1 [
    (buf.validate.field).string.uuid = true,
    (buf.validate.field).required = true
  ];
  int64 amount = 2 [(buf.validate.field).int64.gt = 0];
  string reason = 3 [
    (buf.validate.field).string = {min_len: 1, max_len: 500},
    (buf.validate.field).required = true
  ];
}

// RefundPaymentResponse contains the refund details.
message RefundPaymentResponse {
  string refund_id = 1;
  int64 refunded_amount = 2;
  google.protobuf.Timestamp refunded_at = 3;
}

// StreamPaymentEventsRequest requests payment event streaming.
message StreamPaymentEventsRequest {
  string payment_id = 1 [
    (buf.validate.field).string.uuid = true,
    (buf.validate.field).required = true
  ];
}
```

### Types Definition

```protobuf
// proto/payment/v1/types.proto
syntax = "proto3";

package payment.v1;

import "google/protobuf/timestamp.proto";

option go_package = "github.com/myorg/payment-service/gen/go/payment/v1;paymentv1";

// Payment represents a payment transaction.
message Payment {
  // id is the unique payment identifier.
  string id = 1;

  // order_id is the associated order identifier.
  string order_id = 2;

  // amount is the payment amount in smallest currency unit.
  int64 amount = 3;

  // currency is the ISO 4217 currency code.
  string currency = 4;

  // status is the current payment status.
  PaymentStatus status = 5;

  // metadata is optional key-value metadata.
  map<string, string> metadata = 6;

  // created_at is when the payment was created.
  google.protobuf.Timestamp created_at = 7;

  // updated_at is when the payment was last updated.
  google.protobuf.Timestamp updated_at = 8;

  // failure_reason is set when status is FAILED.
  string failure_reason = 9;

  // processor_reference is the external payment processor's reference ID.
  string processor_reference = 10;
}

// PaymentStatus represents the lifecycle state of a payment.
enum PaymentStatus {
  PAYMENT_STATUS_UNSPECIFIED = 0;
  PAYMENT_STATUS_PENDING = 1;
  PAYMENT_STATUS_PROCESSING = 2;
  PAYMENT_STATUS_COMPLETED = 3;
  PAYMENT_STATUS_FAILED = 4;
  PAYMENT_STATUS_REFUNDED = 5;
  PAYMENT_STATUS_PARTIALLY_REFUNDED = 6;
  PAYMENT_STATUS_CANCELLED = 7;
}

// PaymentEvent represents a state change event for a payment.
message PaymentEvent {
  string payment_id = 1;
  PaymentStatus previous_status = 2;
  PaymentStatus new_status = 3;
  google.protobuf.Timestamp occurred_at = 4;
  string event_id = 5;
}
```

## Section 5: buf.gen.yaml - Code Generation

```yaml
# buf.gen.yaml
version: v2

# Use managed mode for consistent options across all generated files
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: github.com/myorg/payment-service/gen/go
    - file_option: java_package_prefix
      value: com.myorg
    - file_option: java_multiple_files
      value: "true"
    - file_option: objc_class_prefix
      value: PYT

plugins:
  # Go proto generation
  - remote: buf.build/protocolbuffers/go:v1.33.0
    out: gen/go
    opt:
      - paths=source_relative

  # Go gRPC generation
  - remote: buf.build/grpc/go:v1.4.0
    out: gen/go
    opt:
      - paths=source_relative
      - require_unimplemented_servers=true

  # gRPC-Gateway for REST-to-gRPC transcoding
  - remote: buf.build/grpc-ecosystem/gateway/v2:v2.19.1
    out: gen/go
    opt:
      - paths=source_relative
      - generate_unbound_methods=true

  # OpenAPI v2 from gRPC-Gateway annotations
  - remote: buf.build/grpc-ecosystem/openapiv2:v2.19.1
    out: gen/openapi
    opt:
      - json_names_for_fields=true
      - enums_as_ints=false
      - allow_merge=true
      - merge_file_name=api.swagger
      - fqn_for_openapi_name=false

  # TypeScript with connect-web (for browser clients)
  - remote: buf.build/connectrpc/es:v1.4.0
    out: gen/ts
    opt:
      - target=ts

  # Python (for data science/analytics clients)
  - remote: buf.build/protocolbuffers/python:v5.26.1
    out: gen/python

  # Java (for Android and backend services)
  - remote: buf.build/protocolbuffers/java:v4.26.1
    out: gen/java

  # protovalidate-go for validation
  - remote: buf.build/bufbuild/protovalidate-go:v0.6.2
    out: gen/go
    opt:
      - paths=source_relative

inputs:
  - directory: proto
```

## Section 6: Running Code Generation

```bash
# Update buf.lock with dependency hashes
buf dep update

# Lint proto files
buf lint
# Example output for violations:
# proto/payment/v1/payment_service.proto:25:3:RPC request message "CreatePaymentRequest"
# should be named "CreatePaymentRequest" but is named "PaymentCreateRequest"

# Format proto files (auto-fix)
buf format --write

# Check for breaking changes against the registry
buf breaking --against 'buf.build/myorg/payment-api'

# Check against a specific git branch
buf breaking --against '.git#branch=main'

# Check against a specific git tag
buf breaking --against '.git#tag=v1.2.0'

# Generate code for all configured plugins
buf generate

# Generate code for a specific proto directory
buf generate proto/payment

# Generate with verbose output
buf generate --verbose

# Generate to a specific output base directory
buf generate --output /tmp/generated

# Build the proto module (validates syntax and dependencies)
buf build

# Print the full dependency graph
buf dep visualize
```

Verify the generated output structure:

```
gen/
├── go/
│   └── payment/
│       └── v1/
│           ├── payment.pb.go              # Message types
│           ├── payment_service.pb.go      # Request/response types
│           ├── payment_service_grpc.pb.go # gRPC stubs
│           └── payment_service.pb.gw.go  # gRPC-Gateway handlers
├── openapi/
│   └── api.swagger.json                   # OpenAPI v2 spec
├── ts/
│   └── payment/
│       └── v1/
│           ├── payment_pb.ts
│           └── payment_service_pb.ts
└── python/
    └── payment/
        └── v1/
            ├── payment_pb2.py
            └── payment_service_pb2_grpc.py
```

## Section 7: Implementing the Go gRPC Server

```go
// internal/server/payment_server.go
package server

import (
	"context"
	"fmt"

	"buf.build/gen/go/bufbuild/protovalidate/protocolbuffers/go/buf/validate"
	"github.com/bufbuild/protovalidate-go"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	paymentv1 "github.com/myorg/payment-service/gen/go/payment/v1"
	"github.com/myorg/payment-service/internal/domain"
	"github.com/myorg/payment-service/internal/repository"
)

// PaymentServer implements the gRPC PaymentService.
type PaymentServer struct {
	paymentv1.UnimplementedPaymentServiceServer
	repo      *repository.PaymentRepository
	validator *protovalidate.Validator
}

// NewPaymentServer creates a new PaymentServer.
func NewPaymentServer(repo *repository.PaymentRepository) (*PaymentServer, error) {
	v, err := protovalidate.New()
	if err != nil {
		return nil, fmt.Errorf("creating validator: %w", err)
	}

	return &PaymentServer{
		repo:      repo,
		validator: v,
	}, nil
}

// CreatePayment creates a new payment.
func (s *PaymentServer) CreatePayment(
	ctx context.Context,
	req *paymentv1.CreatePaymentRequest,
) (*paymentv1.CreatePaymentResponse, error) {
	// Validate using protovalidate (buf validate annotations)
	if err := s.validator.Validate(req); err != nil {
		return nil, validationError(err)
	}

	// Check for idempotency
	existing, err := s.repo.FindByIdempotencyKey(ctx, req.IdempotencyKey)
	if err != nil && !isNotFound(err) {
		return nil, status.Errorf(codes.Internal, "checking idempotency: %v", err)
	}
	if existing != nil {
		// Idempotent: return the existing payment
		return &paymentv1.CreatePaymentResponse{
			Payment: domainToProto(existing),
		}, nil
	}

	payment, err := s.repo.Create(ctx, &domain.Payment{
		OrderID:         req.OrderId,
		Amount:          req.Amount,
		Currency:        req.Currency,
		IdempotencyKey:  req.IdempotencyKey,
		Metadata:        req.Metadata,
		Status:          domain.StatusPending,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "creating payment: %v", err)
	}

	return &paymentv1.CreatePaymentResponse{
		Payment: domainToProto(payment),
	}, nil
}

// GetPayment retrieves a payment by ID.
func (s *PaymentServer) GetPayment(
	ctx context.Context,
	req *paymentv1.GetPaymentRequest,
) (*paymentv1.GetPaymentResponse, error) {
	if err := s.validator.Validate(req); err != nil {
		return nil, validationError(err)
	}

	id, err := uuid.Parse(req.PaymentId)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid payment_id: %v", err)
	}

	payment, err := s.repo.FindByID(ctx, id)
	if err != nil {
		if isNotFound(err) {
			return nil, status.Errorf(codes.NotFound, "payment %s not found", req.PaymentId)
		}
		return nil, status.Errorf(codes.Internal, "fetching payment: %v", err)
	}

	return &paymentv1.GetPaymentResponse{
		Payment: domainToProto(payment),
	}, nil
}

// StreamPaymentEvents streams payment status changes.
func (s *PaymentServer) StreamPaymentEvents(
	req *paymentv1.StreamPaymentEventsRequest,
	stream paymentv1.PaymentService_StreamPaymentEventsServer,
) error {
	if err := s.validator.Validate(req); err != nil {
		return validationError(err)
	}

	ctx := stream.Context()
	eventCh, err := s.repo.SubscribeToPaymentEvents(ctx, req.PaymentId)
	if err != nil {
		return status.Errorf(codes.Internal, "subscribing to events: %v", err)
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-eventCh:
			if !ok {
				return nil
			}
			if err := stream.Send(&paymentv1.PaymentEvent{
				PaymentId:      event.PaymentID,
				PreviousStatus: domainStatusToProto(event.PreviousStatus),
				NewStatus:      domainStatusToProto(event.NewStatus),
				OccurredAt:     timestamppb.New(event.OccurredAt),
				EventId:        event.EventID,
			}); err != nil {
				return err
			}
		}
	}
}

func validationError(err error) error {
	var valErr *protovalidate.ValidationError
	if ok := false; !ok {
		return status.Errorf(codes.InvalidArgument, "validation failed: %v", err)
	}
	_ = valErr
	return status.Errorf(codes.InvalidArgument, "validation failed: %v", err)
}

func domainToProto(p *domain.Payment) *paymentv1.Payment {
	return &paymentv1.Payment{
		Id:                 p.ID.String(),
		OrderId:            p.OrderID,
		Amount:             p.Amount,
		Currency:           p.Currency,
		Status:             domainStatusToProto(p.Status),
		Metadata:           p.Metadata,
		CreatedAt:          timestamppb.New(p.CreatedAt),
		UpdatedAt:          timestamppb.New(p.UpdatedAt),
		FailureReason:      p.FailureReason,
		ProcessorReference: p.ProcessorReference,
	}
}

func domainStatusToProto(s domain.PaymentStatus) paymentv1.PaymentStatus {
	switch s {
	case domain.StatusPending:
		return paymentv1.PaymentStatus_PAYMENT_STATUS_PENDING
	case domain.StatusProcessing:
		return paymentv1.PaymentStatus_PAYMENT_STATUS_PROCESSING
	case domain.StatusCompleted:
		return paymentv1.PaymentStatus_PAYMENT_STATUS_COMPLETED
	case domain.StatusFailed:
		return paymentv1.PaymentStatus_PAYMENT_STATUS_FAILED
	default:
		return paymentv1.PaymentStatus_PAYMENT_STATUS_UNSPECIFIED
	}
}
```

## Section 8: gRPC Server Setup with Interceptors

```go
// cmd/server/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"

	paymentv1 "github.com/myorg/payment-service/gen/go/payment/v1"
	"github.com/myorg/payment-service/internal/middleware"
	"github.com/myorg/payment-service/internal/repository"
	"github.com/myorg/payment-service/internal/server"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	repo, err := repository.New(os.Getenv("DATABASE_URL"))
	if err != nil {
		logger.Error("failed to create repository", "error", err)
		os.Exit(1)
	}

	paymentServer, err := server.NewPaymentServer(repo)
	if err != nil {
		logger.Error("failed to create payment server", "error", err)
		os.Exit(1)
	}

	// gRPC server with production-grade settings
	grpcServer := grpc.NewServer(
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
		grpc.ChainUnaryInterceptor(
			middleware.RecoveryInterceptor(logger),
			middleware.RequestIDInterceptor(),
			middleware.LoggingInterceptor(logger),
			middleware.AuthInterceptor(),
			middleware.ValidationInterceptor(),
		),
		grpc.ChainStreamInterceptor(
			middleware.StreamRecoveryInterceptor(logger),
			middleware.StreamLoggingInterceptor(logger),
		),
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
		grpc.MaxRecvMsgSize(4*1024*1024),  // 4MB
		grpc.MaxSendMsgSize(4*1024*1024),
	)

	// Register services
	paymentv1.RegisterPaymentServiceServer(grpcServer, paymentServer)
	healthServer := health.NewServer()
	healthpb.RegisterHealthServer(grpcServer, healthServer)
	reflection.Register(grpcServer)

	// Mark service as serving
	healthServer.SetServingStatus("payment.v1.PaymentService", healthpb.HealthCheckResponse_SERVING)

	// Start gRPC listener
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		logger.Error("failed to listen", "error", err)
		os.Exit(1)
	}

	// gRPC-Gateway for REST transcoding
	gwMux := runtime.NewServeMux(
		runtime.WithForwardResponseOption(middleware.ForwardResponseOption),
		runtime.WithErrorHandler(middleware.ErrorHandler),
		runtime.WithIncomingHeaderMatcher(middleware.HeaderMatcher),
	)

	opts := []grpc.DialOption{
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	}

	if err := paymentv1.RegisterPaymentServiceHandlerFromEndpoint(
		context.Background(),
		gwMux,
		":50051",
		opts,
	); err != nil {
		logger.Error("failed to register gateway", "error", err)
		os.Exit(1)
	}

	httpServer := &http.Server{
		Addr:         ":8080",
		Handler:      gwMux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start servers
	go func() {
		logger.Info("gRPC server listening", "addr", ":50051")
		if err := grpcServer.Serve(lis); err != nil {
			logger.Error("gRPC server error", "error", err)
		}
	}()

	go func() {
		logger.Info("HTTP gateway listening", "addr", ":8080")
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("HTTP server error", "error", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	logger.Info("shutting down servers")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	healthServer.SetServingStatus("payment.v1.PaymentService", healthpb.HealthCheckResponse_NOT_SERVING)

	grpcServer.GracefulStop()

	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Error("HTTP server shutdown error", "error", err)
	}

	logger.Info("servers stopped")
}
```

## Section 9: Buf Schema Registry (BSR) for Shared Schemas

The BSR is a hosted registry for sharing proto schemas across teams and organizations.

### Publishing to BSR

```bash
# Authenticate with BSR
buf registry login

# Push the module to BSR
buf push

# Push with a specific tag
buf push --tag v1.2.3

# Push with commit metadata
buf push \
  --tag "v1.2.3" \
  --source-control-url "https://github.com/myorg/payment-api/commit/abc123"
```

### Consuming from BSR in Other Services

```yaml
# buf.yaml in a consuming service
version: v2

deps:
  - buf.build/myorg/payment-api:v1.2.3  # Pin to specific version
  - buf.build/myorg/shared-types         # Latest

lint:
  use:
    - DEFAULT
```

```yaml
# buf.gen.yaml in the consuming service
version: v2

plugins:
  - remote: buf.build/protocolbuffers/go:v1.33.0
    out: gen/go
    opt:
      - paths=source_relative

inputs:
  - module: buf.build/myorg/payment-api:v1.2.3
    paths:
      - payment/v1/payment_service.proto
```

```bash
# Update dependencies
buf dep update

# Generate code from BSR module
buf generate buf.build/myorg/payment-api

# Generate from a specific BSR tag
buf generate buf.build/myorg/payment-api:v1.2.3
```

## Section 10: Breaking Change Detection in CI/CD

```yaml
# .github/workflows/proto-check.yaml
name: Proto Checks

on:
  push:
    paths:
      - 'proto/**'
      - 'buf.yaml'
      - 'buf.gen.yaml'

jobs:
  lint-and-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for branch comparison

      - name: Setup buf
        uses: bufbuild/buf-setup-action@v1
        with:
          version: '1.30.0'
          github_token: ${{ secrets.GITHUB_TOKEN }}

      - name: Lint proto files
        run: buf lint

      - name: Check breaking changes against main
        run: |
          buf breaking --against '.git#branch=main'

      - name: Check breaking changes against BSR
        if: github.ref == 'refs/heads/main'
        env:
          BUF_TOKEN: ${{ secrets.BUF_TOKEN }}
        run: |
          buf breaking --against "buf.build/myorg/payment-api:latest"

      - name: Generate code
        run: buf generate

      - name: Verify generated code is up to date
        run: |
          git diff --exit-code gen/ || {
            echo "Generated code is out of date. Run 'buf generate' and commit the changes."
            exit 1
          }

  push-to-bsr:
    runs-on: ubuntu-latest
    needs: lint-and-check
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - name: Setup buf
        uses: bufbuild/buf-setup-action@v1
        with:
          version: '1.30.0'

      - name: Push to Buf Schema Registry
        env:
          BUF_TOKEN: ${{ secrets.BUF_TOKEN }}
        run: |
          buf push --tag "${GITHUB_SHA}"

      - name: Tag release if this is a tagged commit
        if: startsWith(github.ref, 'refs/tags/v')
        env:
          BUF_TOKEN: ${{ secrets.BUF_TOKEN }}
        run: |
          buf push --tag "${GITHUB_REF_NAME}"
```

## Section 11: Connect-Go (Replacement for Standard gRPC)

`connect-go` is Buf's modern gRPC replacement with better browser support:

```yaml
# buf.gen.yaml with connect-go
plugins:
  - remote: buf.build/protocolbuffers/go:v1.33.0
    out: gen/go
    opt:
      - paths=source_relative

  # connect-go replaces grpc-go
  - remote: buf.build/connectrpc/go:v1.16.2
    out: gen/go
    opt:
      - paths=source_relative
```

Connect-go server implementation:

```go
// connect-go server is simpler than standard gRPC
import (
    "net/http"

    "connectrpc.com/connect"
    paymentv1 "github.com/myorg/payment-service/gen/go/payment/v1"
    "github.com/myorg/payment-service/gen/go/payment/v1/paymentv1connect"
)

// paymentv1connect is the generated connect package
path, handler := paymentv1connect.NewPaymentServiceHandler(
    &PaymentServer{},
    connect.WithInterceptors(
        connect.UnaryInterceptorFunc(loggingInterceptor),
        connect.UnaryInterceptorFunc(authInterceptor),
    ),
)

mux := http.NewServeMux()
mux.Handle(path, handler)

// h2c allows HTTP/2 without TLS for internal traffic
srv := &http.Server{
    Addr:    ":8080",
    Handler: h2c.NewHandler(mux, &http2.Server{}),
}
```

## Section 12: Makefile for Common buf Operations

```makefile
# Makefile
.PHONY: proto-lint proto-format proto-check proto-generate proto-push

PROTO_DIR := proto
GEN_DIR   := gen

# Install buf
.PHONY: install-buf
install-buf:
	go install github.com/bufbuild/buf/cmd/buf@v1.30.0

# Lint proto files
proto-lint:
	buf lint

# Format proto files
proto-format:
	buf format --write

# Check for breaking changes against main branch
proto-check:
	buf breaking --against '.git#branch=main'

# Check against the BSR
proto-check-bsr:
	buf breaking --against 'buf.build/myorg/payment-api:latest'

# Generate code for all languages
proto-generate:
	buf generate
	@echo "Generated code written to $(GEN_DIR)/"

# Generate and verify no drift
proto-generate-check: proto-generate
	git diff --exit-code $(GEN_DIR)/ || \
	  (echo "Generated code is out of date" && exit 1)

# Update dependencies
proto-dep-update:
	buf dep update

# Push to BSR
proto-push:
	buf push

# Push with tag
proto-push-tag:
	buf push --tag $(TAG)

# Full proto CI check
proto-ci: proto-lint proto-format proto-check proto-generate-check
	@echo "All proto checks passed"
```

## Summary

The `buf` CLI transforms proto-based API development with:

1. **`buf.yaml`** with lint and breaking change rules enforces API quality from day one
2. **`buf.gen.yaml`** with remote plugins eliminates `protoc` installation and plugin management
3. **Breaking change detection** against `git` branches or BSR prevents accidental client breakage
4. **BSR** provides versioned schema sharing across teams without private registry infrastructure
5. **`protovalidate`** annotations add field validation directly to the proto schema
6. **gRPC-Gateway** generates REST transcoding from the same proto file
7. **CI/CD integration** makes schema quality checks automatic

Start with `buf lint` and `buf format` to get immediate value - they catch common proto mistakes that waste code review time. Add `buf breaking` once you have multiple API consumers who could be broken by changes.
