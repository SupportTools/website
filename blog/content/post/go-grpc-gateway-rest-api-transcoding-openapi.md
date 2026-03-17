---
title: "Go gRPC Gateway: Exposing gRPC Services as REST APIs with Transcoding"
date: 2030-10-09T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "REST", "API Gateway", "Protobuf", "OpenAPI", "Kubernetes"]
categories:
- Go
- API
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise gRPC-gateway guide: proto service annotations for HTTP mapping, JSON transcoding, OpenAPI spec generation, streaming endpoint handling, authentication passthrough, and deploying gRPC-gateway alongside existing REST APIs."
more_link: "yes"
url: "/go-grpc-gateway-rest-api-transcoding-openapi/"
---

gRPC-gateway solves the dual-protocol problem: internal services communicate efficiently over gRPC with protobuf serialization, while external clients get a familiar JSON/REST interface — both served from the same Go binary. The gateway handles HTTP-to-gRPC transcoding transparently, including header mapping, query parameter extraction, and response envelope transformation.

<!--more-->

## Architecture Overview

gRPC-gateway works through code generation. Proto annotations specify how HTTP methods and paths map to RPC methods. The code generator produces a Go reverse proxy that:

1. Accepts incoming HTTP/JSON requests
2. Transcodes them to gRPC requests (marshaling JSON to protobuf)
3. Forwards to the gRPC server (which may be in the same process or remote)
4. Transcodes the gRPC response back to JSON

```
┌─────────────────────────────────────────────────┐
│  Go Binary                                       │
│  ┌─────────────────┐    ┌─────────────────────┐  │
│  │  HTTP/JSON      │    │  gRPC Server         │  │
│  │  Gateway        │───▶│  (same process)     │  │
│  │  :8080          │    │  :9090              │  │
│  └─────────────────┘    └─────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## Project Setup

### Dependencies

```bash
# Install protobuf compiler
sudo apt-get install -y protobuf-compiler

# Install Go plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2@latest

# Ensure $GOPATH/bin is in PATH
export PATH="$PATH:$(go env GOPATH)/bin"

# Verify
protoc --version
protoc-gen-go --version
```

### Go Module Initialization

```bash
mkdir payments-service && cd payments-service
go mod init github.com/myorg/payments-service

# Core dependencies
go get google.golang.org/grpc@latest
go get google.golang.org/protobuf@latest
go get github.com/grpc-ecosystem/grpc-gateway/v2@latest
go get google.golang.org/genproto/googleapis/api@latest
```

---

## Annotating Proto Files for HTTP Mapping

The annotations come from `google/api/annotations.proto`, which defines the HTTP binding options.

### Service Definition with HTTP Annotations

```protobuf
// proto/payments/v1/payments.proto
syntax = "proto3";

package payments.v1;

import "google/api/annotations.proto";
import "google/api/field_behavior.proto";
import "protoc-gen-openapiv2/options/annotations.proto";

option go_package = "github.com/myorg/payments-service/gen/payments/v1;paymentsv1";

// API-level OpenAPI metadata
option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger) = {
  info: {
    title: "Payments Service API";
    version: "1.0.0";
    description: "Enterprise payments processing service";
    contact: {
      name: "Platform Team";
      url: "https://docs.example.com/payments";
      email: "platform@example.com";
    };
  };
  schemes: HTTPS;
  consumes: "application/json";
  produces: "application/json";
  security_definitions: {
    security: {
      key: "bearer";
      value: {
        type: TYPE_API_KEY;
        in: IN_HEADER;
        name: "Authorization";
        description: "Bearer token authentication";
      };
    };
  };
  security: {
    security_requirement: {
      key: "bearer";
      value: {};
    };
  };
};

message Payment {
  string id = 1;
  string customer_id = 2;
  int64 amount_cents = 3;
  string currency = 4;
  PaymentStatus status = 5;
  string description = 6;
  map<string, string> metadata = 7;
  int64 created_at = 8;
  int64 updated_at = 9;
}

enum PaymentStatus {
  PAYMENT_STATUS_UNSPECIFIED = 0;
  PAYMENT_STATUS_PENDING = 1;
  PAYMENT_STATUS_PROCESSING = 2;
  PAYMENT_STATUS_COMPLETED = 3;
  PAYMENT_STATUS_FAILED = 4;
  PAYMENT_STATUS_REFUNDED = 5;
}

message CreatePaymentRequest {
  string customer_id = 1 [(google.api.field_behavior) = REQUIRED];
  int64 amount_cents = 2 [(google.api.field_behavior) = REQUIRED];
  string currency = 3 [(google.api.field_behavior) = REQUIRED];
  string description = 4;
  map<string, string> metadata = 5;
  string idempotency_key = 6 [(google.api.field_behavior) = REQUIRED];
}

message GetPaymentRequest {
  string payment_id = 1 [(google.api.field_behavior) = REQUIRED];
}

message ListPaymentsRequest {
  string customer_id = 1;
  int32 page_size = 2;
  string page_token = 3;
  PaymentStatus status_filter = 4;
}

message ListPaymentsResponse {
  repeated Payment payments = 1;
  string next_page_token = 2;
  int32 total_count = 3;
}

message RefundPaymentRequest {
  string payment_id = 1 [(google.api.field_behavior) = REQUIRED];
  int64 amount_cents = 2;
  string reason = 3 [(google.api.field_behavior) = REQUIRED];
}

service PaymentsService {
  // Create a new payment
  // POST /v1/payments
  rpc CreatePayment(CreatePaymentRequest) returns (Payment) {
    option (google.api.http) = {
      post: "/v1/payments"
      body: "*"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Create a payment";
      operation_id: "PaymentsService_CreatePayment";
      tags: ["payments"];
    };
  }

  // Get a payment by ID
  // GET /v1/payments/{payment_id}
  rpc GetPayment(GetPaymentRequest) returns (Payment) {
    option (google.api.http) = {
      get: "/v1/payments/{payment_id}"
    };
  }

  // List payments with optional filters
  // GET /v1/payments?customer_id=...&page_size=...
  rpc ListPayments(ListPaymentsRequest) returns (ListPaymentsResponse) {
    option (google.api.http) = {
      get: "/v1/payments"
      additional_bindings: {
        get: "/v1/customers/{customer_id}/payments"
      }
    };
  }

  // Refund a payment
  // POST /v1/payments/{payment_id}/refund
  rpc RefundPayment(RefundPaymentRequest) returns (Payment) {
    option (google.api.http) = {
      post: "/v1/payments/{payment_id}/refund"
      body: "*"
    };
  }
}
```

### Code Generation

```bash
# Create the buf.yaml configuration (preferred over raw protoc)
cat > buf.yaml <<EOF
version: v1
deps:
  - buf.build/googleapis/googleapis
  - buf.build/grpc-ecosystem/grpc-gateway
lint:
  use:
    - DEFAULT
breaking:
  use:
    - FILE
EOF

cat > buf.gen.yaml <<EOF
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
  - plugin: grpc-gateway
    out: gen
    opt:
      - paths=source_relative
      - generate_unbound_methods=true
  - plugin: openapiv2
    out: gen/openapi
    opt:
      - generate_unbound_methods=true
      - json_names_for_fields=true
EOF

# Generate code
buf generate proto/

# Or using raw protoc:
protoc \
  -I proto/ \
  -I $(go env GOPATH)/pkg/mod/github.com/grpc-ecosystem/grpc-gateway/v2@*/third_party/googleapis \
  --go_out=gen --go_opt=paths=source_relative \
  --go-grpc_out=gen --go-grpc_opt=paths=source_relative \
  --grpc-gateway_out=gen --grpc-gateway_opt=paths=source_relative \
  --openapiv2_out=gen/openapi \
  proto/payments/v1/payments.proto
```

---

## gRPC Server Implementation

```go
// internal/server/payments.go
package server

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
    paymentsv1 "github.com/myorg/payments-service/gen/payments/v1"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type PaymentsServer struct {
    paymentsv1.UnimplementedPaymentsServiceServer
    // db *database.DB
}

func NewPaymentsServer() *PaymentsServer {
    return &PaymentsServer{}
}

func (s *PaymentsServer) CreatePayment(
    ctx context.Context,
    req *paymentsv1.CreatePaymentRequest,
) (*paymentsv1.Payment, error) {
    if req.CustomerId == "" {
        return nil, status.Error(codes.InvalidArgument, "customer_id is required")
    }
    if req.AmountCents <= 0 {
        return nil, status.Error(codes.InvalidArgument, "amount_cents must be positive")
    }
    if req.Currency == "" {
        return nil, status.Error(codes.InvalidArgument, "currency is required")
    }
    if req.IdempotencyKey == "" {
        return nil, status.Error(codes.InvalidArgument, "idempotency_key is required")
    }

    // In production: check idempotency key in database
    // In production: process payment via payment processor

    now := time.Now().Unix()
    payment := &paymentsv1.Payment{
        Id:          uuid.New().String(),
        CustomerId:  req.CustomerId,
        AmountCents: req.AmountCents,
        Currency:    req.Currency,
        Status:      paymentsv1.PaymentStatus_PAYMENT_STATUS_PENDING,
        Description: req.Description,
        Metadata:    req.Metadata,
        CreatedAt:   now,
        UpdatedAt:   now,
    }

    return payment, nil
}

func (s *PaymentsServer) GetPayment(
    ctx context.Context,
    req *paymentsv1.GetPaymentRequest,
) (*paymentsv1.Payment, error) {
    if req.PaymentId == "" {
        return nil, status.Error(codes.InvalidArgument, "payment_id is required")
    }

    // In production: fetch from database
    return nil, status.Errorf(codes.NotFound, "payment %q not found", req.PaymentId)
}

func (s *PaymentsServer) ListPayments(
    ctx context.Context,
    req *paymentsv1.ListPaymentsRequest,
) (*paymentsv1.ListPaymentsResponse, error) {
    pageSize := req.PageSize
    if pageSize <= 0 || pageSize > 100 {
        pageSize = 20
    }

    // In production: query database with pagination
    return &paymentsv1.ListPaymentsResponse{
        Payments:      []*paymentsv1.Payment{},
        NextPageToken: "",
        TotalCount:    0,
    }, nil
}

func (s *PaymentsServer) RefundPayment(
    ctx context.Context,
    req *paymentsv1.RefundPaymentRequest,
) (*paymentsv1.Payment, error) {
    if req.PaymentId == "" {
        return nil, status.Error(codes.InvalidArgument, "payment_id is required")
    }
    if req.Reason == "" {
        return nil, status.Error(codes.InvalidArgument, "reason is required")
    }

    // In production: process refund
    return nil, status.Errorf(codes.NotFound, "payment %q not found", req.PaymentId)
}
```

---

## Gateway Server with Authentication

```go
// cmd/server/main.go
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "net"
    "net/http"
    "os"
    "os/signal"
    "strings"
    "syscall"
    "time"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    paymentsv1 "github.com/myorg/payments-service/gen/payments/v1"
    "github.com/myorg/payments-service/internal/server"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/reflection"
    "google.golang.org/protobuf/encoding/protojson"
)

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    grpcPort := envOrDefault("GRPC_PORT", "9090")
    httpPort := envOrDefault("HTTP_PORT", "8080")

    // Start gRPC server
    grpcServer := grpc.NewServer(
        grpc.UnaryInterceptor(loggingInterceptor(logger)),
    )

    paymentsServer := server.NewPaymentsServer()
    paymentsv1.RegisterPaymentsServiceServer(grpcServer, paymentsServer)
    reflection.Register(grpcServer)

    grpcLis, err := net.Listen("tcp", ":"+grpcPort)
    if err != nil {
        logger.Fatal("failed to listen on gRPC port", zap.Error(err))
    }

    go func() {
        logger.Info("gRPC server starting", zap.String("port", grpcPort))
        if err := grpcServer.Serve(grpcLis); err != nil {
            logger.Fatal("gRPC server failed", zap.Error(err))
        }
    }()

    // Start HTTP/JSON gateway
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    mux := runtime.NewServeMux(
        // Custom JSON marshaling options
        runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
            MarshalOptions: protojson.MarshalOptions{
                UseProtoNames:   false,  // Use camelCase field names in JSON
                EmitUnpopulated: false,  // Don't emit zero-value fields
            },
            UnmarshalOptions: protojson.UnmarshalOptions{
                DiscardUnknown: true,
            },
        }),
        // Incoming HTTP headers → gRPC metadata passthrough
        runtime.WithIncomingHeaderMatcher(customHeaderMatcher),
        // Outgoing gRPC metadata → HTTP headers
        runtime.WithOutgoingHeaderMatcher(customOutgoingHeaderMatcher),
        // Error handler for consistent JSON error responses
        runtime.WithErrorHandler(customErrorHandler),
    )

    // Connect gateway to local gRPC server
    opts := []grpc.DialOption{
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    }

    if err := paymentsv1.RegisterPaymentsServiceHandlerFromEndpoint(
        ctx,
        mux,
        "localhost:"+grpcPort,
        opts,
    ); err != nil {
        logger.Fatal("failed to register gateway", zap.Error(err))
    }

    // Serve OpenAPI spec at /openapi.json
    openAPIHandler := http.FileServer(http.Dir("gen/openapi"))

    httpMux := http.NewServeMux()
    httpMux.Handle("/v1/", authMiddleware(mux))
    httpMux.Handle("/openapi.json", openAPIHandler)
    httpMux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte(`{"status":"ok"}`))
    })

    httpServer := &http.Server{
        Addr:         ":" + httpPort,
        Handler:      httpMux,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
        TLSConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
        },
    }

    logger.Info("HTTP gateway starting", zap.String("port", httpPort))
    go func() {
        if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
            logger.Fatal("HTTP server failed", zap.Error(err))
        }
    }()

    // Graceful shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    logger.Info("shutting down servers...")
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    httpServer.Shutdown(shutdownCtx)
    grpcServer.GracefulStop()
    logger.Info("servers stopped")
}

// customHeaderMatcher controls which HTTP headers are forwarded as gRPC metadata
func customHeaderMatcher(header string) (string, bool) {
    switch strings.ToLower(header) {
    case "authorization":
        return "authorization", true
    case "x-request-id":
        return "x-request-id", true
    case "x-trace-id":
        return "x-trace-id", true
    case "x-user-id":
        return "x-user-id", true
    default:
        return runtime.DefaultHeaderMatcher(header)
    }
}

func customOutgoingHeaderMatcher(key string) (string, bool) {
    switch key {
    case "x-request-id", "x-rate-limit-remaining":
        return key, true
    }
    return "", false
}

// authMiddleware validates Bearer tokens before forwarding to gRPC
func authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Skip auth for health checks
        if r.URL.Path == "/health" {
            next.ServeHTTP(w, r)
            return
        }

        authHeader := r.Header.Get("Authorization")
        if !strings.HasPrefix(authHeader, "Bearer ") {
            http.Error(w, `{"code":16,"message":"missing or invalid authorization header"}`,
                http.StatusUnauthorized)
            return
        }

        token := strings.TrimPrefix(authHeader, "Bearer ")

        // Validate token (JWT verification, etc.)
        userID, err := validateToken(token)
        if err != nil {
            http.Error(w, `{"code":16,"message":"invalid token"}`,
                http.StatusUnauthorized)
            return
        }

        // Pass user ID downstream via header (will be picked up by header matcher)
        r.Header.Set("X-User-ID", userID)
        next.ServeHTTP(w, r)
    })
}

func validateToken(token string) (string, error) {
    // Production: validate JWT signature, expiry, claims
    if token == "" {
        return "", fmt.Errorf("empty token")
    }
    return "user-from-jwt-claims", nil
}

func envOrDefault(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}
```

---

## Custom Error Handler

```go
// internal/gateway/errors.go
package gateway

import (
    "context"
    "net/http"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type HTTPError struct {
    Code    int    `json:"code"`
    Message string `json:"message"`
    Details string `json:"details,omitempty"`
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

    httpCode := runtime.HTTPStatusFromCode(s.Code())

    // Map specific gRPC codes to appropriate HTTP status codes
    switch s.Code() {
    case codes.InvalidArgument:
        httpCode = http.StatusBadRequest
    case codes.NotFound:
        httpCode = http.StatusNotFound
    case codes.AlreadyExists:
        httpCode = http.StatusConflict
    case codes.PermissionDenied:
        httpCode = http.StatusForbidden
    case codes.Unauthenticated:
        httpCode = http.StatusUnauthorized
    case codes.ResourceExhausted:
        httpCode = http.StatusTooManyRequests
    case codes.Unimplemented:
        httpCode = http.StatusNotImplemented
    case codes.Unavailable:
        httpCode = http.StatusServiceUnavailable
    case codes.DeadlineExceeded:
        httpCode = http.StatusGatewayTimeout
    }

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-Content-Type-Options", "nosniff")
    w.WriteHeader(httpCode)

    body := HTTPError{
        Code:    int(s.Code()),
        Message: s.Message(),
    }

    data, _ := marshaler.Marshal(&body)
    w.Write(data)
}
```

---

## Streaming Endpoints

gRPC-gateway supports server-side streaming over HTTP/1.1 using newline-delimited JSON (NDJSON):

```protobuf
// Server-side streaming RPC
rpc WatchPayments(WatchPaymentsRequest) returns (stream Payment) {
  option (google.api.http) = {
    get: "/v1/payments:watch"
  };
}

message WatchPaymentsRequest {
  string customer_id = 1;
  repeated PaymentStatus status_filter = 2;
}
```

```go
// Server-side streaming implementation
func (s *PaymentsServer) WatchPayments(
    req *paymentsv1.WatchPaymentsRequest,
    stream paymentsv1.PaymentsService_WatchPaymentsServer,
) error {
    ctx := stream.Context()
    // ticker simulates real-time payment events
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            payment := &paymentsv1.Payment{
                Id:          uuid.New().String(),
                CustomerId:  req.CustomerId,
                AmountCents: 1000,
                Status:      paymentsv1.PaymentStatus_PAYMENT_STATUS_COMPLETED,
                CreatedAt:   time.Now().Unix(),
            }
            if err := stream.Send(payment); err != nil {
                return err
            }
        }
    }
}
```

The HTTP client receives NDJSON:

```bash
# Stream payments via HTTP
curl -N -H "Authorization: Bearer <token>" \
  "https://api.example.com/v1/payments:watch?customer_id=cust_123"

# Each payment arrives as a separate JSON object on its own line:
# {"id":"pay_abc","customerId":"cust_123","amountCents":"1000","status":"PAYMENT_STATUS_COMPLETED",...}
# {"id":"pay_def","customerId":"cust_123","amountCents":"2500","status":"PAYMENT_STATUS_COMPLETED",...}
```

---

## OpenAPI Spec Generation and Swagger UI

The `protoc-gen-openapiv2` plugin generates an OpenAPI 2.0 (Swagger) specification:

```bash
# Generated file: gen/openapi/payments/v1/payments.swagger.json

# Serve Swagger UI
cat > docker-compose.swagger.yml <<EOF
services:
  swagger-ui:
    image: swaggerapi/swagger-ui
    ports:
      - "8081:8080"
    environment:
      SWAGGER_JSON_URL: http://localhost:8080/openapi.json
EOF

docker compose -f docker-compose.swagger.yml up -d
```

Serve the spec from the gateway:

```go
// In main.go — serve OpenAPI spec with CORS headers for Swagger UI
httpMux.HandleFunc("/openapi.json", func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Access-Control-Allow-Origin", "*")
    http.ServeFile(w, r, "gen/openapi/payments/v1/payments.swagger.json")
})
```

---

## Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-service
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payments-service
  template:
    metadata:
      labels:
        app: payments-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9091"
    spec:
      containers:
        - name: payments-service
          image: myorg/payments-service:v1.2.0
          ports:
            - name: http
              containerPort: 8080
            - name: grpc
              containerPort: 9090
            - name: metrics
              containerPort: 9091
          env:
            - name: HTTP_PORT
              value: "8080"
            - name: GRPC_PORT
              value: "9090"
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: payments-service
  namespace: payments
spec:
  selector:
    app: payments-service
  ports:
    - name: http
      port: 8080
      targetPort: 8080
    - name: grpc
      port: 9090
      targetPort: 9090
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payments-service
  namespace: payments
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    # Enable gRPC passthrough for direct gRPC clients on a separate host
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  rules:
    - host: api.payments.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: payments-service
                port:
                  number: 8080
```

---

## Testing the Gateway

```bash
# Create a payment via REST
curl -X POST https://api.payments.example.com/v1/payments \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cust_123",
    "amountCents": 2500,
    "currency": "USD",
    "description": "Monthly subscription",
    "idempotencyKey": "idem_abc123"
  }'

# Get a payment
curl https://api.payments.example.com/v1/payments/pay_abc123 \
  -H "Authorization: Bearer <token>"

# List payments with query params
curl "https://api.payments.example.com/v1/payments?customer_id=cust_123&page_size=10" \
  -H "Authorization: Bearer <token>"

# Use the alternative URL binding
curl "https://api.payments.example.com/v1/customers/cust_123/payments?page_size=5" \
  -H "Authorization: Bearer <token>"

# Test error handling
curl https://api.payments.example.com/v1/payments/nonexistent \
  -H "Authorization: Bearer <token>"
# {"code":5,"message":"payment \"nonexistent\" not found"}

# Test via gRPC directly (bypassing gateway)
grpcurl \
  -plaintext \
  -d '{"customer_id":"cust_123","amount_cents":1000,"currency":"USD","idempotency_key":"key1"}' \
  localhost:9090 \
  payments.v1.PaymentsService/CreatePayment
```

The gRPC-gateway pattern provides a clean path to API evolution: gRPC semantics govern the canonical service definition in proto files, code generation handles the REST translation layer automatically, and a single binary serves both protocols — reducing operational overhead while keeping the developer experience clean for both internal gRPC consumers and external REST clients.
