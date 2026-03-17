---
title: "Go gRPC Gateway: Transcoding REST to gRPC"
date: 2029-11-18T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "REST", "API Gateway", "Protobuf", "OpenAPI"]
categories: ["Go", "API Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to grpc-gateway for Go: protoc plugin setup, HTTP/JSON to gRPC transcoding, custom marshaling, OpenAPI generation, streaming REST endpoints, and production deployment patterns."
more_link: "yes"
url: "/go-grpc-gateway-rest-grpc-transcoding-guide-guide/"
---

gRPC is the ideal protocol for internal service communication — compact binary encoding, strongly typed contracts, bidirectional streaming, and excellent tooling. But exposing gRPC directly to web browsers, mobile clients, or third-party integrators remains impractical. grpc-gateway solves this by generating a reverse proxy that transcodes HTTP/JSON requests to gRPC calls, letting you maintain a single service implementation that serves both gRPC and REST clients simultaneously. This guide covers the complete grpc-gateway workflow: proto annotations, code generation, custom marshaling, OpenAPI spec generation, streaming REST endpoints, and production deployment considerations.

<!--more-->

# Go gRPC Gateway: Transcoding REST to gRPC

## Architecture Overview

grpc-gateway generates a Go HTTP server that acts as a translation layer between REST clients and your gRPC server. The generated proxy:

1. Receives HTTP/JSON requests
2. Validates and parses the JSON body and URL parameters
3. Translates the request to the corresponding gRPC message
4. Calls the gRPC server (typically in the same process or on localhost)
5. Translates the gRPC response back to JSON
6. Returns the HTTP response

```
REST Client         grpc-gateway proxy          gRPC Server
    |                      |                         |
    |  POST /v1/users      |                         |
    |--------------------->|                         |
    |                      |  CreateUser(request)    |
    |                      |------------------------>|
    |                      |  UserResponse           |
    |                      |<------------------------|
    |  HTTP 200 JSON       |                         |
    |<---------------------|                         |
```

The proxy and gRPC server typically run in the same binary, communicating over a local Unix socket or `localhost:port` to avoid the overhead of network round trips.

## Project Setup

### Required Tools

```bash
# Install protoc
apt-get install -y protobuf-compiler
# or on macOS:
brew install protobuf

# Install Go protoc plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2@latest

# Verify installations
protoc --version       # libprotoc 24.x
protoc-gen-go --version
protoc-gen-go-grpc --version

# Add Go bin to PATH
export PATH="$PATH:$(go env GOPATH)/bin"
```

### Go Module Setup

```bash
mkdir payment-service && cd payment-service
go mod init github.com/myorg/payment-service

# Dependencies
go get google.golang.org/grpc
go get google.golang.org/protobuf
go get github.com/grpc-ecosystem/grpc-gateway/v2
go get github.com/grpc-ecosystem/grpc-gateway/v2/runtime
go get google.golang.org/grpc/credentials/insecure
```

### Project Structure

```
payment-service/
├── proto/
│   ├── payment/v1/
│   │   └── payment.proto
│   └── google/
│       └── api/               # googleapis annotations (or use buf)
│           ├── annotations.proto
│           └── http.proto
├── gen/
│   └── payment/v1/           # Generated code
├── internal/
│   └── service/
│       └── payment.go        # gRPC service implementation
├── cmd/
│   └── server/
│       └── main.go
├── buf.gen.yaml              # buf code generation config
└── Makefile
```

## Defining the Proto Service with HTTP Annotations

The key to grpc-gateway is the `google.api.http` annotation on each RPC method, which maps HTTP verbs and URL patterns to gRPC calls.

```protobuf
// proto/payment/v1/payment.proto
syntax = "proto3";

package payment.v1;

option go_package = "github.com/myorg/payment-service/gen/payment/v1;paymentv1";

import "google/api/annotations.proto";
import "google/api/field_behavior.proto";
import "protoc-gen-openapiv2/options/annotations.proto";
import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/field_mask.proto";

// OpenAPI service-level metadata
option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger) = {
    info: {
        title: "Payment Service API"
        version: "1.0"
        description: "API for processing payments and managing transactions"
    }
    schemes: [HTTPS]
    consumes: ["application/json"]
    produces: ["application/json"]
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
};

message CreatePaymentRequest {
    string user_id = 1 [(google.api.field_behavior) = REQUIRED];
    double amount = 2 [(google.api.field_behavior) = REQUIRED];
    string currency = 3 [(google.api.field_behavior) = REQUIRED];
    string merchant_id = 4 [(google.api.field_behavior) = REQUIRED];
    string idempotency_key = 5;
    map<string, string> metadata = 6;
}

message Payment {
    string id = 1;
    string user_id = 2;
    double amount = 3;
    string currency = 4;
    string merchant_id = 5;
    PaymentStatus status = 6;
    google.protobuf.Timestamp created_at = 7;
    google.protobuf.Timestamp updated_at = 8;
    map<string, string> metadata = 9;
}

enum PaymentStatus {
    PAYMENT_STATUS_UNSPECIFIED = 0;
    PAYMENT_STATUS_PENDING = 1;
    PAYMENT_STATUS_COMPLETED = 2;
    PAYMENT_STATUS_FAILED = 3;
    PAYMENT_STATUS_REFUNDED = 4;
}

message GetPaymentRequest {
    string id = 1 [(google.api.field_behavior) = REQUIRED];
}

message ListPaymentsRequest {
    string user_id = 1;
    int32 page_size = 2;
    string page_token = 3;
    PaymentStatus status_filter = 4;
}

message ListPaymentsResponse {
    repeated Payment payments = 1;
    string next_page_token = 2;
    int32 total_count = 3;
}

message UpdatePaymentRequest {
    string id = 1 [(google.api.field_behavior) = REQUIRED];
    Payment payment = 2 [(google.api.field_behavior) = REQUIRED];
    google.protobuf.FieldMask update_mask = 3;
}

message RefundPaymentRequest {
    string id = 1 [(google.api.field_behavior) = REQUIRED];
    double amount = 2;
    string reason = 3;
}

message PaymentEventStream {
    string payment_id = 1;
    PaymentStatus status = 2;
    google.protobuf.Timestamp event_time = 3;
    string message = 4;
}

service PaymentService {
    // HTTP: POST /v1/payments
    rpc CreatePayment(CreatePaymentRequest) returns (Payment) {
        option (google.api.http) = {
            post: "/v1/payments"
            body: "*"
        };
        option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
            summary: "Create a payment"
            tags: ["Payments"]
        };
    }

    // HTTP: GET /v1/payments/{id}
    rpc GetPayment(GetPaymentRequest) returns (Payment) {
        option (google.api.http) = {
            get: "/v1/payments/{id}"
        };
    }

    // HTTP: GET /v1/payments  or  GET /v1/users/{user_id}/payments
    rpc ListPayments(ListPaymentsRequest) returns (ListPaymentsResponse) {
        option (google.api.http) = {
            get: "/v1/payments"
            additional_bindings: {
                get: "/v1/users/{user_id}/payments"
            }
        };
    }

    // HTTP: PATCH /v1/payments/{id}
    rpc UpdatePayment(UpdatePaymentRequest) returns (Payment) {
        option (google.api.http) = {
            patch: "/v1/payments/{id}"
            body: "*"
        };
    }

    // HTTP: POST /v1/payments/{id}:refund  (custom method pattern)
    rpc RefundPayment(RefundPaymentRequest) returns (Payment) {
        option (google.api.http) = {
            post: "/v1/payments/{id}:refund"
            body: "*"
        };
    }

    // HTTP: DELETE /v1/payments/{id}
    rpc DeletePayment(GetPaymentRequest) returns (google.protobuf.Empty) {
        option (google.api.http) = {
            delete: "/v1/payments/{id}"
        };
    }

    // HTTP: GET /v1/payments/{id}/events  (server-streaming via chunked JSON)
    rpc WatchPaymentEvents(GetPaymentRequest) returns (stream PaymentEventStream) {
        option (google.api.http) = {
            get: "/v1/payments/{id}/events"
        };
    }
}
```

## Code Generation

### Using buf (Recommended)

```yaml
# buf.gen.yaml
version: v1
plugins:
  - plugin: go
    out: gen
    opt:
      - paths=source_relative

  - plugin: go-grpc
    out: gen
    opt:
      - paths=source_relative
      - require_unimplemented_servers=false

  - plugin: grpc-gateway
    out: gen
    opt:
      - paths=source_relative
      - generate_unbound_methods=true

  - plugin: openapiv2
    out: gen/openapi
    opt:
      - allow_merge=true
      - merge_file_name=payment-api
      - output_format=yaml
      - simple_operation_ids=true
```

```bash
# Generate code with buf
buf generate

# Generated files:
# gen/payment/v1/payment.pb.go           — message types
# gen/payment/v1/payment_grpc.pb.go      — gRPC server/client interfaces
# gen/payment/v1/payment.pb.gw.go        — HTTP gateway handlers
# gen/openapi/payment-api.yaml           — OpenAPI v2 spec
```

### Using protoc Directly

```makefile
# Makefile
PROTO_DIR := proto
GEN_DIR := gen
GOOGLEAPIS := third_party/googleapis

.PHONY: generate
generate:
	protoc \
		-I $(PROTO_DIR) \
		-I $(GOOGLEAPIS) \
		--go_out=$(GEN_DIR) \
		--go_opt=paths=source_relative \
		--go-grpc_out=$(GEN_DIR) \
		--go-grpc_opt=paths=source_relative \
		--grpc-gateway_out=$(GEN_DIR) \
		--grpc-gateway_opt=paths=source_relative \
		--openapiv2_out=$(GEN_DIR)/openapi \
		--openapiv2_opt=allow_merge=true \
		$(PROTO_DIR)/payment/v1/payment.proto
```

## Implementing the gRPC Service

```go
// internal/service/payment.go
package service

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    paymentv1 "github.com/myorg/payment-service/gen/payment/v1"
)

type PaymentService struct {
    paymentv1.UnimplementedPaymentServiceServer
    store PaymentStore
}

type PaymentStore interface {
    Create(ctx context.Context, p *paymentv1.Payment) error
    Get(ctx context.Context, id string) (*paymentv1.Payment, error)
    List(ctx context.Context, userID string, status paymentv1.PaymentStatus,
        pageSize int32, pageToken string) ([]*paymentv1.Payment, string, error)
    Update(ctx context.Context, p *paymentv1.Payment, mask []string) (*paymentv1.Payment, error)
    Delete(ctx context.Context, id string) error
}

func NewPaymentService(store PaymentStore) *PaymentService {
    return &PaymentService{store: store}
}

func (s *PaymentService) CreatePayment(
    ctx context.Context,
    req *paymentv1.CreatePaymentRequest,
) (*paymentv1.Payment, error) {
    if req.UserId == "" {
        return nil, status.Error(codes.InvalidArgument, "user_id is required")
    }
    if req.Amount <= 0 {
        return nil, status.Error(codes.InvalidArgument, "amount must be positive")
    }
    if req.Currency == "" {
        return nil, status.Error(codes.InvalidArgument, "currency is required")
    }

    now := timestamppb.New(time.Now())
    payment := &paymentv1.Payment{
        Id:         uuid.New().String(),
        UserId:     req.UserId,
        Amount:     req.Amount,
        Currency:   req.Currency,
        MerchantId: req.MerchantId,
        Status:     paymentv1.PaymentStatus_PAYMENT_STATUS_PENDING,
        CreatedAt:  now,
        UpdatedAt:  now,
        Metadata:   req.Metadata,
    }

    if err := s.store.Create(ctx, payment); err != nil {
        return nil, status.Errorf(codes.Internal, "creating payment: %v", err)
    }

    return payment, nil
}

func (s *PaymentService) GetPayment(
    ctx context.Context,
    req *paymentv1.GetPaymentRequest,
) (*paymentv1.Payment, error) {
    if req.Id == "" {
        return nil, status.Error(codes.InvalidArgument, "id is required")
    }

    payment, err := s.store.Get(ctx, req.Id)
    if err != nil {
        return nil, status.Errorf(codes.NotFound, "payment %s not found", req.Id)
    }

    return payment, nil
}

func (s *PaymentService) RefundPayment(
    ctx context.Context,
    req *paymentv1.RefundPaymentRequest,
) (*paymentv1.Payment, error) {
    payment, err := s.store.Get(ctx, req.Id)
    if err != nil {
        return nil, status.Errorf(codes.NotFound, "payment %s not found", req.Id)
    }

    if payment.Status != paymentv1.PaymentStatus_PAYMENT_STATUS_COMPLETED {
        return nil, status.Errorf(
            codes.FailedPrecondition,
            "payment %s is not COMPLETED (current: %s)",
            req.Id, payment.Status,
        )
    }

    refundAmount := req.Amount
    if refundAmount <= 0 {
        refundAmount = payment.Amount
    }
    if refundAmount > payment.Amount {
        return nil, status.Error(codes.InvalidArgument, "refund amount exceeds payment amount")
    }

    payment.Status = paymentv1.PaymentStatus_PAYMENT_STATUS_REFUNDED
    payment.UpdatedAt = timestamppb.Now()

    updated, err := s.store.Update(ctx, payment, []string{"status", "updated_at"})
    if err != nil {
        return nil, status.Errorf(codes.Internal, "updating payment: %v", err)
    }

    return updated, nil
}

func (s *PaymentService) WatchPaymentEvents(
    req *paymentv1.GetPaymentRequest,
    stream paymentv1.PaymentService_WatchPaymentEventsServer,
) error {
    if req.Id == "" {
        return status.Error(codes.InvalidArgument, "id is required")
    }

    ctx := stream.Context()

    payment, err := s.store.Get(ctx, req.Id)
    if err != nil {
        return status.Errorf(codes.NotFound, "payment %s not found", req.Id)
    }

    if err := stream.Send(&paymentv1.PaymentEventStream{
        PaymentId: payment.Id,
        Status:    payment.Status,
        EventTime: timestamppb.Now(),
        Message:   "initial_state",
    }); err != nil {
        return fmt.Errorf("sending initial state: %w", err)
    }

    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil
        case <-ticker.C:
            current, err := s.store.Get(ctx, req.Id)
            if err != nil {
                return status.Errorf(codes.Internal, "fetching payment: %v", err)
            }

            if err := stream.Send(&paymentv1.PaymentEventStream{
                PaymentId: current.Id,
                Status:    current.Status,
                EventTime: timestamppb.Now(),
                Message:   "status_update",
            }); err != nil {
                return fmt.Errorf("sending update: %w", err)
            }
        }
    }
}
```

## Building the Combined Server

```go
// cmd/server/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/reflection"
    "google.golang.org/protobuf/encoding/protojson"

    paymentv1 "github.com/myorg/payment-service/gen/payment/v1"
    "github.com/myorg/payment-service/internal/service"
)

func main() {
    grpcAddr := ":9090"
    httpAddr := ":8080"

    grpcServer := setupGRPCServer()
    grpcListener, err := net.Listen("tcp", grpcAddr)
    if err != nil {
        log.Fatalf("failed to listen on %s: %v", grpcAddr, err)
    }

    go func() {
        log.Printf("gRPC server listening on %s", grpcAddr)
        if err := grpcServer.Serve(grpcListener); err != nil {
            log.Fatalf("gRPC server failed: %v", err)
        }
    }()

    httpServer, err := setupHTTPGateway(grpcAddr, httpAddr)
    if err != nil {
        log.Fatalf("failed to setup HTTP gateway: %v", err)
    }

    go func() {
        log.Printf("HTTP gateway listening on %s", httpAddr)
        if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("HTTP server failed: %v", err)
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    log.Println("shutting down...")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    httpServer.Shutdown(ctx)
    grpcServer.GracefulStop()
    log.Println("shutdown complete")
}

func setupGRPCServer() *grpc.Server {
    store := service.NewInMemoryStore()
    svc := service.NewPaymentService(store)

    server := grpc.NewServer(
        grpc.UnaryInterceptor(loggingUnaryInterceptor),
        grpc.StreamInterceptor(loggingStreamInterceptor),
    )

    paymentv1.RegisterPaymentServiceServer(server, svc)
    reflection.Register(server)

    return server
}

func setupHTTPGateway(grpcAddr, httpAddr string) (*http.Server, error) {
    ctx := context.Background()

    jsonpbMarshaler := &runtime.JSONPb{
        MarshalOptions: protojson.MarshalOptions{
            UseProtoNames:   true,
            EmitUnpopulated: false,
        },
        UnmarshalOptions: protojson.UnmarshalOptions{
            DiscardUnknown: true,
        },
    }

    mux := runtime.NewServeMux(
        runtime.WithMarshalerOption(runtime.MIMEWildcard, jsonpbMarshaler),
        runtime.WithErrorHandler(customErrorHandler),
        runtime.WithIncomingHeaderMatcher(customHeaderMatcher),
        runtime.WithOutgoingHeaderMatcher(customOutgoingHeaderMatcher),
    )

    opts := []grpc.DialOption{
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    }

    if err := paymentv1.RegisterPaymentServiceHandlerFromEndpoint(
        ctx, mux, grpcAddr, opts,
    ); err != nil {
        return nil, fmt.Errorf("registering gateway: %w", err)
    }

    handler := corsMiddleware(requestIDMiddleware(mux))

    return &http.Server{
        Addr:         httpAddr,
        Handler:      handler,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 60 * time.Second,
        IdleTimeout:  120 * time.Second,
    }, nil
}
```

## Custom Marshaling and Error Handling

```go
import (
    "encoding/json"
    "net/http"
    "strings"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type ErrorResponse struct {
    Code    int    `json:"code"`
    Status  string `json:"status"`
    Message string `json:"message"`
    Details []any  `json:"details,omitempty"`
}

func customErrorHandler(
    ctx context.Context,
    mux *runtime.ServeMux,
    marshaler runtime.Marshaler,
    w http.ResponseWriter,
    r *http.Request,
    err error,
) {
    s, ok := status.FromError(err)
    if !ok {
        s = status.New(codes.Internal, err.Error())
    }

    httpCode := runtime.HTTPStatusFromCode(s.Code())
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(httpCode)

    resp := ErrorResponse{
        Code:    int(s.Code()),
        Status:  s.Code().String(),
        Message: s.Message(),
    }

    for _, detail := range s.Details() {
        resp.Details = append(resp.Details, detail)
    }

    body, _ := json.Marshal(resp)
    w.Write(body)
}

func customHeaderMatcher(key string) (string, bool) {
    switch strings.ToLower(key) {
    case "authorization":
        return "authorization", true
    case "x-request-id":
        return "x-request-id", true
    case "x-correlation-id":
        return "x-correlation-id", true
    default:
        return runtime.DefaultHeaderMatcher(key)
    }
}

func customOutgoingHeaderMatcher(key string) (string, bool) {
    switch key {
    case "x-request-id", "x-ratelimit-remaining":
        return key, true
    default:
        return "", false
    }
}

func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "*")
        w.Header().Set("Access-Control-Allow-Methods",
            "GET, POST, PATCH, DELETE, OPTIONS")
        w.Header().Set("Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Request-ID")

        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusNoContent)
            return
        }

        next.ServeHTTP(w, r)
    })
}

func requestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.New().String()
        }
        r.Header.Set("X-Request-ID", requestID)
        w.Header().Set("X-Request-ID", requestID)
        next.ServeHTTP(w, r)
    })
}
```

## HTTP Annotation Patterns Reference

### URL Path Variables

```protobuf
// Simple path variable: {id} maps to GetPaymentRequest.id
rpc GetPayment(GetPaymentRequest) returns (Payment) {
    option (google.api.http) = { get: "/v1/payments/{id}" };
}

// Nested field path variable: {payment.merchant_id}
rpc GetByMerchant(Request) returns (Response) {
    option (google.api.http) = {
        get: "/v1/merchants/{payment.merchant_id}/payments"
    };
}

// Wildcard path segment: {name=projects/*/payments/**}
rpc GetNestedResource(Request) returns (Response) {
    option (google.api.http) = {
        get: "/v1/{name=projects/*/payments/**}"
    };
}
```

### Request Body Mapping

```protobuf
// body: "*" — entire request body maps to the message
rpc CreatePayment(CreatePaymentRequest) returns (Payment) {
    option (google.api.http) = {
        post: "/v1/payments"
        body: "*"
    };
}

// body: "payment" — only the "payment" field maps to request body
// Other fields (id) come from URL path
rpc UpdatePayment(UpdatePaymentRequest) returns (Payment) {
    option (google.api.http) = {
        put: "/v1/payments/{id}"
        body: "payment"  // Only Payment sub-message in body
    };
}

// No body field — all fields must come from URL query params or path
rpc DeletePayment(DeleteRequest) returns (Empty) {
    option (google.api.http) = { delete: "/v1/payments/{id}" };
}
```

### Additional HTTP Bindings (Multiple URLs for One RPC)

```protobuf
rpc ListPayments(ListPaymentsRequest) returns (ListPaymentsResponse) {
    option (google.api.http) = {
        get: "/v1/payments"
        additional_bindings: [
            { get: "/v1/users/{user_id}/payments" },
            { get: "/v1/merchants/{merchant_id}/payments" }
        ]
    };
}
```

## OpenAPI Generation and Serving

```bash
# Generated OpenAPI spec location:
# gen/openapi/payment-api.yaml

# Serve Swagger UI locally
docker run -p 8081:8080 \
  -e SWAGGER_JSON=/api/payment-api.yaml \
  -v $(pwd)/gen/openapi:/api \
  swaggerapi/swagger-ui

# Or serve via the Go server
```

```go
//go:embed gen/openapi/payment-api.yaml
var openAPISpec []byte

// Add to HTTP mux
mux.HandleFunc("GET /openapi.yaml", func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/yaml")
    w.Write(openAPISpec)
})
```

## Streaming REST Endpoints

Server-streaming gRPC methods become chunked HTTP responses with newline-delimited JSON:

```bash
# Call the streaming endpoint via curl (-N disables output buffering)
curl -N -H "Accept: application/json" \
  "http://localhost:8080/v1/payments/pay-12345/events"

# Each line is a separate JSON object:
# {"payment_id":"pay-12345","status":"PAYMENT_STATUS_PENDING","event_time":"2029-11-18T...","message":"initial_state"}
# {"payment_id":"pay-12345","status":"PAYMENT_STATUS_COMPLETED","event_time":"2029-11-18T...","message":"status_update"}
```

```go
// Server-Sent Events (SSE) wrapper for browser compatibility
func sseHandler(grpcAddr string) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        paymentID := r.PathValue("id")

        w.Header().Set("Content-Type", "text/event-stream")
        w.Header().Set("Cache-Control", "no-cache")
        w.Header().Set("Connection", "keep-alive")

        flusher, ok := w.(http.Flusher)
        if !ok {
            http.Error(w, "streaming not supported", http.StatusInternalServerError)
            return
        }

        conn, _ := grpc.Dial(grpcAddr,
            grpc.WithTransportCredentials(insecure.NewCredentials()))
        defer conn.Close()

        client := paymentv1.NewPaymentServiceClient(conn)
        stream, err := client.WatchPaymentEvents(r.Context(),
            &paymentv1.GetPaymentRequest{Id: paymentID})
        if err != nil {
            http.Error(w, "stream error", http.StatusInternalServerError)
            return
        }

        for {
            event, err := stream.Recv()
            if err != nil {
                fmt.Fprintf(w, "data: {\"error\":\"stream ended\"}\n\n")
                flusher.Flush()
                return
            }

            data, _ := json.Marshal(event)
            fmt.Fprintf(w, "data: %s\n\n", data)
            flusher.Flush()
        }
    }
}
```

## Testing the Gateway

```bash
# Create a payment
curl -X POST http://localhost:8080/v1/payments \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user-123",
    "amount": 99.99,
    "currency": "USD",
    "merchant_id": "merchant-456",
    "idempotency_key": "order-789"
  }'

# Get a payment
curl http://localhost:8080/v1/payments/pay-abc123

# List payments via alternate URL
curl "http://localhost:8080/v1/users/user-123/payments?page_size=10"

# Refund (custom method)
curl -X POST http://localhost:8080/v1/payments/pay-abc123:refund \
  -H "Content-Type: application/json" \
  -d '{"amount": 49.99, "reason": "partial_refund"}'

# Test gRPC directly with grpcurl
grpcurl -plaintext \
  -d '{"user_id": "user-123", "amount": 99.99, "currency": "USD"}' \
  localhost:9090 payment.v1.PaymentService/CreatePayment
```

## Logging Interceptors

```go
func loggingUnaryInterceptor(
    ctx context.Context,
    req interface{},
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error) {
    start := time.Now()
    resp, err := handler(ctx, req)

    code := codes.OK
    if s, ok := status.FromError(err); ok {
        code = s.Code()
    }

    log.Printf("gRPC unary method=%s code=%s duration=%s",
        info.FullMethod, code, time.Since(start))

    return resp, err
}

func loggingStreamInterceptor(
    srv interface{},
    stream grpc.ServerStream,
    info *grpc.StreamServerInfo,
    handler grpc.StreamHandler,
) error {
    start := time.Now()
    err := handler(srv, stream)

    code := codes.OK
    if s, ok := status.FromError(err); ok {
        code = s.Code()
    }

    log.Printf("gRPC stream method=%s code=%s duration=%s",
        info.FullMethod, code, time.Since(start))

    return err
}
```

## Summary

grpc-gateway enables a single Go service implementation to serve both gRPC and REST/JSON clients. The proto HTTP annotation approach maintains a single source of truth for the API contract, auto-generates both the HTTP gateway and the OpenAPI documentation, and eliminates maintaining a separate REST layer. Key production considerations: always implement custom error handlers for consistent error shapes, configure header forwarding carefully for authentication propagation, serve the OpenAPI spec alongside the API for developer self-service, and use SSE or WebSocket handlers for browser-compatible streaming rather than relying on the gateway's default chunked JSON streaming.
