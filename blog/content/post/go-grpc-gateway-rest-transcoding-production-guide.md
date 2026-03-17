---
title: "Go: Implementing a gRPC Gateway for REST-to-gRPC Transcoding with grpc-gateway"
date: 2031-09-20T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "REST", "API Gateway", "grpc-gateway", "Protobuf"]
categories:
- Go
- APIs
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to building a production-grade gRPC gateway in Go using grpc-gateway, covering protobuf annotations, OpenAPI generation, authentication, streaming, and deployment patterns."
more_link: "yes"
url: "/go-grpc-gateway-rest-transcoding-production-guide/"
---

gRPC is the right choice for high-performance internal communication between services, but HTTP/JSON REST remains the dominant interface for external consumers — browsers, mobile clients, third-party integrations, and teams that have not adopted gRPC tooling. The grpc-gateway project solves this by auto-generating a reverse proxy that translates REST requests to gRPC, allowing you to define your API once in Protobuf and serve both interfaces simultaneously.

This post builds a complete production gateway implementation in Go: protobuf service definition with HTTP annotations, gateway code generation, authentication middleware, response transcoding customization, OpenAPI documentation generation, streaming support, and deployment patterns for Kubernetes.

<!--more-->

# Building a gRPC Gateway in Go

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    External Clients                      │
│          Browser │ CLI │ Third-party │ Legacy           │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTPS/REST
┌───────────────────────────▼─────────────────────────────┐
│                    grpc-gateway                          │
│         HTTP/JSON ──► Protobuf ──► gRPC                 │
│         Auth Middleware │ Rate Limiting │ CORS           │
└───────────────────────────┬─────────────────────────────┘
                            │ gRPC (HTTP/2)
┌───────────────────────────▼─────────────────────────────┐
│                  Go gRPC Services                        │
│       UserService │ OrderService │ InventoryService      │
└─────────────────────────────────────────────────────────┘
```

The gateway and gRPC server can run in the same process (useful for simpler deployments) or as separate services (useful when the gRPC services are owned by different teams).

## Project Structure

```
api-gateway/
├── proto/
│   ├── user/
│   │   └── v1/
│   │       └── user.proto
│   ├── order/
│   │   └── v1/
│   │       └── order.proto
│   └── google/             # googleapis annotations
│       └── api/
│           ├── annotations.proto
│           └── http.proto
├── gen/
│   ├── user/v1/
│   │   ├── user.pb.go
│   │   ├── user_grpc.pb.go
│   │   └── user.pb.gw.go
│   └── order/v1/
│       ├── order.pb.go
│       ├── order_grpc.pb.go
│       └── order.pb.gw.go
├── internal/
│   ├── server/
│   │   ├── user.go
│   │   └── order.go
│   ├── middleware/
│   │   ├── auth.go
│   │   ├── logging.go
│   │   └── ratelimit.go
│   └── gateway/
│       ├── gateway.go
│       ├── mux.go
│       └── options.go
├── cmd/
│   ├── server/main.go
│   └── gateway/main.go
├── buf.yaml
├── buf.gen.yaml
└── Makefile
```

## Protobuf Service Definition

```protobuf
// proto/user/v1/user.proto
syntax = "proto3";

package user.v1;

import "google/api/annotations.proto";
import "google/api/field_behavior.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/timestamp.proto";
import "google/protobuf/field_mask.proto";

option go_package = "github.com/example/api-gateway/gen/user/v1;userv1";

// UserService manages user accounts.
service UserService {
  // GetUser retrieves a single user by ID.
  rpc GetUser(GetUserRequest) returns (User) {
    option (google.api.http) = {
      get: "/v1/users/{user_id}"
    };
  }

  // ListUsers retrieves a paginated list of users.
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse) {
    option (google.api.http) = {
      get: "/v1/users"
    };
  }

  // CreateUser creates a new user.
  rpc CreateUser(CreateUserRequest) returns (User) {
    option (google.api.http) = {
      post: "/v1/users"
      body: "*"
    };
  }

  // UpdateUser updates a user's fields.
  rpc UpdateUser(UpdateUserRequest) returns (User) {
    option (google.api.http) = {
      patch: "/v1/users/{user.user_id}"
      body: "user"
      additional_bindings {
        put: "/v1/users/{user.user_id}"
        body: "user"
      }
    };
  }

  // DeleteUser deletes a user.
  rpc DeleteUser(DeleteUserRequest) returns (google.protobuf.Empty) {
    option (google.api.http) = {
      delete: "/v1/users/{user_id}"
    };
  }

  // WatchUser streams events for a user.
  rpc WatchUser(WatchUserRequest) returns (stream UserEvent) {
    option (google.api.http) = {
      get: "/v1/users/{user_id}/watch"
    };
  }
}

message User {
  string user_id = 1;
  string email = 2 [(google.api.field_behavior) = REQUIRED];
  string display_name = 3;
  UserRole role = 4;
  bool active = 5;
  google.protobuf.Timestamp created_at = 6;
  google.protobuf.Timestamp updated_at = 7;
  map<string, string> labels = 8;
}

enum UserRole {
  USER_ROLE_UNSPECIFIED = 0;
  USER_ROLE_VIEWER = 1;
  USER_ROLE_EDITOR = 2;
  USER_ROLE_ADMIN = 3;
}

message GetUserRequest {
  string user_id = 1 [(google.api.field_behavior) = REQUIRED];
}

message ListUsersRequest {
  int32 page_size = 1;
  string page_token = 2;
  string filter = 3;
  string order_by = 4;
}

message ListUsersResponse {
  repeated User users = 1;
  string next_page_token = 2;
  int32 total_size = 3;
}

message CreateUserRequest {
  User user = 1 [(google.api.field_behavior) = REQUIRED];
}

message UpdateUserRequest {
  User user = 1 [(google.api.field_behavior) = REQUIRED];
  google.protobuf.FieldMask update_mask = 2;
}

message DeleteUserRequest {
  string user_id = 1 [(google.api.field_behavior) = REQUIRED];
}

message WatchUserRequest {
  string user_id = 1 [(google.api.field_behavior) = REQUIRED];
}

message UserEvent {
  string event_type = 1; // "CREATED", "UPDATED", "DELETED"
  User user = 2;
  google.protobuf.Timestamp event_time = 3;
}
```

## Code Generation with Buf

```yaml
# buf.yaml
version: v1
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
version: v1
plugins:
  - plugin: buf.build/protocolbuffers/go
    out: gen
    opt:
      - paths=source_relative

  - plugin: buf.build/grpc/go
    out: gen
    opt:
      - paths=source_relative
      - require_unimplemented_servers=false

  - plugin: buf.build/grpc-ecosystem/gateway/v2
    out: gen
    opt:
      - paths=source_relative
      - generate_unbound_methods=true

  - plugin: buf.build/grpc-ecosystem/openapiv2
    out: docs/openapi
    opt:
      - allow_merge=true
      - merge_file_name=api
      - json_names_for_fields=true
      - include_package_in_tags=false
```

```makefile
# Makefile
.PHONY: generate proto lint test

generate:
	buf generate

lint:
	buf lint

breaking:
	buf breaking --against .git#branch=main

test:
	go test ./...
```

## gRPC Service Implementation

```go
// internal/server/user.go
package server

import (
    "context"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/emptypb"
    "google.golang.org/protobuf/types/known/timestamppb"

    userv1 "github.com/example/api-gateway/gen/user/v1"
)

type UserServer struct {
    userv1.UnimplementedUserServiceServer
    store UserStore
}

type UserStore interface {
    Get(ctx context.Context, id string) (*userv1.User, error)
    List(ctx context.Context, req *userv1.ListUsersRequest) ([]*userv1.User, string, int32, error)
    Create(ctx context.Context, user *userv1.User) (*userv1.User, error)
    Update(ctx context.Context, user *userv1.User, mask []string) (*userv1.User, error)
    Delete(ctx context.Context, id string) error
}

func NewUserServer(store UserStore) *UserServer {
    return &UserServer{store: store}
}

func (s *UserServer) GetUser(ctx context.Context, req *userv1.GetUserRequest) (*userv1.User, error) {
    if req.UserId == "" {
        return nil, status.Error(codes.InvalidArgument, "user_id is required")
    }

    user, err := s.store.Get(ctx, req.UserId)
    if err != nil {
        return nil, mapStoreError(err)
    }
    return user, nil
}

func (s *UserServer) ListUsers(ctx context.Context, req *userv1.ListUsersRequest) (*userv1.ListUsersResponse, error) {
    if req.PageSize <= 0 {
        req.PageSize = 50
    }
    if req.PageSize > 1000 {
        return nil, status.Error(codes.InvalidArgument, "page_size must be <= 1000")
    }

    users, nextToken, total, err := s.store.List(ctx, req)
    if err != nil {
        return nil, mapStoreError(err)
    }

    return &userv1.ListUsersResponse{
        Users:         users,
        NextPageToken: nextToken,
        TotalSize:     total,
    }, nil
}

func (s *UserServer) CreateUser(ctx context.Context, req *userv1.CreateUserRequest) (*userv1.User, error) {
    if req.User == nil {
        return nil, status.Error(codes.InvalidArgument, "user is required")
    }
    if req.User.Email == "" {
        return nil, status.Error(codes.InvalidArgument, "user.email is required")
    }

    req.User.CreatedAt = timestamppb.New(time.Now())
    req.User.UpdatedAt = timestamppb.New(time.Now())

    return s.store.Create(ctx, req.User)
}

func (s *UserServer) UpdateUser(ctx context.Context, req *userv1.UpdateUserRequest) (*userv1.User, error) {
    if req.User == nil {
        return nil, status.Error(codes.InvalidArgument, "user is required")
    }

    var paths []string
    if req.UpdateMask != nil {
        paths = req.UpdateMask.Paths
    }

    req.User.UpdatedAt = timestamppb.New(time.Now())
    return s.store.Update(ctx, req.User, paths)
}

func (s *UserServer) DeleteUser(ctx context.Context, req *userv1.DeleteUserRequest) (*emptypb.Empty, error) {
    if req.UserId == "" {
        return nil, status.Error(codes.InvalidArgument, "user_id is required")
    }
    return &emptypb.Empty{}, s.store.Delete(ctx, req.UserId)
}

func (s *UserServer) WatchUser(req *userv1.WatchUserRequest, stream userv1.UserService_WatchUserServer) error {
    // Server-streaming RPC — send events as they occur
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-stream.Context().Done():
            return stream.Context().Err()
        case t := <-ticker.C:
            // In production, this would listen to a pubsub/event bus
            if err := stream.Send(&userv1.UserEvent{
                EventType: "HEARTBEAT",
                EventTime: timestamppb.New(t),
            }); err != nil {
                return err
            }
        }
    }
}

func mapStoreError(err error) error {
    if err == nil {
        return nil
    }
    // Map application errors to gRPC status codes
    switch err.Error() {
    case "not found":
        return status.Error(codes.NotFound, err.Error())
    case "already exists":
        return status.Error(codes.AlreadyExists, err.Error())
    case "permission denied":
        return status.Error(codes.PermissionDenied, err.Error())
    default:
        return status.Error(codes.Internal, "internal error")
    }
}
```

## Gateway Configuration

```go
// internal/gateway/gateway.go
package gateway

import (
    "context"
    "net/http"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/protobuf/encoding/protojson"

    userv1 "github.com/example/api-gateway/gen/user/v1"
    orderv1 "github.com/example/api-gateway/gen/order/v1"
)

type Config struct {
    GRPCAddr string
    HTTPAddr string
}

func New(ctx context.Context, cfg Config) (http.Handler, error) {
    // Configure JSON marshaling
    marshalOpts := runtime.WithMarshalerOption(
        runtime.MIMEWildcard,
        &runtime.JSONPb{
            MarshalOptions: protojson.MarshalOptions{
                EmitUnpopulated: false,
                UseProtoNames:   false, // use camelCase in JSON
                UseEnumNumbers:  false, // use enum names
            },
            UnmarshalOptions: protojson.UnmarshalOptions{
                DiscardUnknown: true,
            },
        },
    )

    mux := runtime.NewServeMux(
        marshalOpts,
        runtime.WithErrorHandler(customErrorHandler),
        runtime.WithRoutingErrorHandler(routingErrorHandler),
        runtime.WithIncomingHeaderMatcher(headerMatcher),
        runtime.WithOutgoingHeaderMatcher(outgoingHeaderMatcher),
        runtime.WithMetadata(extractMetadata),
        runtime.WithForwardResponseOption(forwardResponseOption),
    )

    opts := []grpc.DialOption{
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultCallOptions(
            grpc.MaxCallRecvMsgSize(32*1024*1024),
            grpc.MaxCallSendMsgSize(32*1024*1024),
        ),
    }

    // Register service handlers
    if err := userv1.RegisterUserServiceHandlerFromEndpoint(
        ctx, mux, cfg.GRPCAddr, opts,
    ); err != nil {
        return nil, err
    }

    if err := orderv1.RegisterOrderServiceHandlerFromEndpoint(
        ctx, mux, cfg.GRPCAddr, opts,
    ); err != nil {
        return nil, err
    }

    return mux, nil
}
```

## Custom Error Handling

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
    s := status.Convert(err)

    httpStatus := runtime.HTTPStatusFromCode(s.Code())
    if s.Code() == codes.Unauthenticated {
        w.Header().Set("WWW-Authenticate", "Bearer realm=\"api\"")
    }

    resp := ErrorResponse{
        Code:    int(s.Code()),
        Message: s.Message(),
    }

    for _, detail := range s.Details() {
        resp.Details = append(resp.Details, detail)
    }

    body, _ := json.Marshal(resp)
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-Content-Type-Options", "nosniff")
    w.WriteHeader(httpStatus)
    _, _ = w.Write(body)
}

func routingErrorHandler(
    ctx context.Context,
    mux *runtime.ServeMux,
    marshaler runtime.Marshaler,
    w http.ResponseWriter,
    r *http.Request,
    httpStatus int,
) {
    resp := ErrorResponse{
        Code:    httpStatus,
        Message: http.StatusText(httpStatus),
    }
    body, _ := json.Marshal(resp)
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(httpStatus)
    _, _ = w.Write(body)
}
```

## Authentication Middleware

```go
// internal/middleware/auth.go
package middleware

import (
    "context"
    "net/http"
    "strings"

    "google.golang.org/grpc/metadata"
)

// BearerTokenToMetadata extracts Bearer tokens from HTTP Authorization headers
// and forwards them as gRPC metadata.
func BearerTokenToMetadata(ctx context.Context, r *http.Request) metadata.MD {
    auth := r.Header.Get("Authorization")
    if auth == "" {
        return nil
    }

    parts := strings.SplitN(auth, " ", 2)
    if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
        return nil
    }

    return metadata.Pairs("authorization", auth)
}

// APIKeyToMetadata extracts API keys from X-API-Key headers.
func APIKeyToMetadata(ctx context.Context, r *http.Request) metadata.MD {
    apiKey := r.Header.Get("X-API-Key")
    if apiKey == "" {
        return nil
    }
    return metadata.Pairs("x-api-key", apiKey)
}

// CombineMetadataExtractors combines multiple metadata extractors.
func CombineMetadataExtractors(
    extractors ...func(context.Context, *http.Request) metadata.MD,
) func(context.Context, *http.Request) metadata.MD {
    return func(ctx context.Context, r *http.Request) metadata.MD {
        combined := metadata.MD{}
        for _, e := range extractors {
            for k, v := range e(ctx, r) {
                combined[k] = append(combined[k], v...)
            }
        }
        return combined
    }
}

// HTTPMiddleware wraps an http.Handler with auth validation.
func HTTPMiddleware(
    allowedOrigins []string,
    next http.Handler,
) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // CORS
        origin := r.Header.Get("Origin")
        for _, allowed := range allowedOrigins {
            if origin == allowed || allowed == "*" {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Access-Control-Allow-Methods",
                    "GET, POST, PUT, PATCH, DELETE, OPTIONS")
                w.Header().Set("Access-Control-Allow-Headers",
                    "Authorization, Content-Type, X-API-Key, X-Request-ID")
                w.Header().Set("Access-Control-Expose-Headers",
                    "X-Request-ID, X-Trace-ID")
                break
            }
        }

        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusNoContent)
            return
        }

        // Request ID propagation
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = generateRequestID()
        }
        w.Header().Set("X-Request-ID", requestID)
        r = r.WithContext(context.WithValue(r.Context(), requestIDKey{}, requestID))

        next.ServeHTTP(w, r)
    })
}

type requestIDKey struct{}

func generateRequestID() string {
    // Simple implementation; use UUID in production
    return fmt.Sprintf("req-%d", time.Now().UnixNano())
}
```

## Header Matchers

```go
// internal/gateway/mux.go
package gateway

import (
    "strings"
)

// headerMatcher controls which HTTP request headers are forwarded as gRPC metadata.
func headerMatcher(key string) (string, bool) {
    switch strings.ToLower(key) {
    case "authorization", "x-api-key", "x-request-id",
        "x-forwarded-for", "x-real-ip", "x-trace-id":
        return key, true
    default:
        // Also forward headers with grpc- prefix
        if strings.HasPrefix(strings.ToLower(key), "grpc-") {
            return key, true
        }
        return "", false
    }
}

// outgoingHeaderMatcher controls which gRPC response metadata is forwarded as HTTP headers.
func outgoingHeaderMatcher(key string) (string, bool) {
    switch strings.ToLower(key) {
    case "x-request-id", "x-trace-id", "x-ratelimit-limit",
        "x-ratelimit-remaining", "x-ratelimit-reset":
        return key, true
    default:
        return "", false
    }
}

// extractMetadata extracts request metadata forwarded to gRPC services.
func extractMetadata(ctx context.Context, r *http.Request) metadata.MD {
    return CombineMetadataExtractors(
        BearerTokenToMetadata,
        APIKeyToMetadata,
    )(ctx, r)
}

// forwardResponseOption modifies gRPC responses before JSON marshaling.
func forwardResponseOption(ctx context.Context, w http.ResponseWriter, resp proto.Message) error {
    // Example: add ETag based on response content
    if resp != nil {
        // In production, compute a proper ETag
        w.Header().Set("Cache-Control", "private, max-age=0")
    }
    return nil
}
```

## Combined gRPC + HTTP Server

```go
// cmd/server/main.go
package main

import (
    "context"
    "log"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "golang.org/x/net/http2"
    "golang.org/x/net/http2/h2c"
    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    healthpb "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/reflection"

    userv1 "github.com/example/api-gateway/gen/user/v1"
    "github.com/example/api-gateway/internal/gateway"
    "github.com/example/api-gateway/internal/middleware"
    "github.com/example/api-gateway/internal/server"
)

func main() {
    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    grpcServer := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            middleware.UnaryLogging(),
            middleware.UnaryRecovery(),
            middleware.UnaryAuth(),
        ),
        grpc.ChainStreamInterceptor(
            middleware.StreamLogging(),
            middleware.StreamRecovery(),
            middleware.StreamAuth(),
        ),
    )

    // Register services
    userSrv := server.NewUserServer(newUserStore())
    userv1.RegisterUserServiceServer(grpcServer, userSrv)

    // Health and reflection
    healthSrv := health.NewServer()
    healthpb.RegisterHealthServer(grpcServer, healthSrv)
    reflection.Register(grpcServer)

    // Build HTTP gateway
    gwHandler, err := gateway.New(ctx, gateway.Config{
        GRPCAddr: "localhost:9090",
        HTTPAddr: ":8080",
    })
    if err != nil {
        log.Fatal(err)
    }

    // Wrap with middleware
    httpHandler := middleware.HTTPMiddleware(
        []string{"https://app.example.com", "http://localhost:3000"},
        http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Route /healthz directly without going through gRPC
            if r.URL.Path == "/healthz" {
                w.WriteHeader(http.StatusOK)
                _, _ = w.Write([]byte(`{"status":"ok"}`))
                return
            }
            gwHandler.ServeHTTP(w, r)
        }),
    )

    // Single port serving both gRPC and HTTP/1.1+HTTP/2 (h2c)
    // In production, use TLS and separate ports
    combinedHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.ProtoMajor == 2 &&
            r.Header.Get("Content-Type") == "application/grpc" {
            grpcServer.ServeHTTP(w, r)
        } else {
            httpHandler.ServeHTTP(w, r)
        }
    })

    httpSrv := &http.Server{
        Addr:              ":8080",
        Handler:           h2c.NewHandler(combinedHandler, &http2.Server{}),
        ReadHeaderTimeout: 10 * time.Second,
        ReadTimeout:       30 * time.Second,
        WriteTimeout:      30 * time.Second,
        IdleTimeout:       120 * time.Second,
    }

    // Start gRPC on dedicated port
    lis, err := net.Listen("tcp", ":9090")
    if err != nil {
        log.Fatal(err)
    }
    go func() {
        log.Println("gRPC server listening on :9090")
        if err := grpcServer.Serve(lis); err != nil {
            log.Printf("gRPC server error: %v", err)
        }
    }()

    go func() {
        log.Println("HTTP gateway listening on :8080")
        if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Printf("HTTP server error: %v", err)
        }
    }()

    healthSrv.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

    <-ctx.Done()
    log.Println("Shutting down...")

    grpcServer.GracefulStop()

    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()
    _ = httpSrv.Shutdown(shutdownCtx)
}

func newUserStore() server.UserStore { return nil } // inject real store
```

## Kubernetes Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: platform
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9091"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        - name: gateway
          image: example.com/api-gateway:latest
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: grpc
            - containerPort: 9091
              name: metrics
          env:
            - name: GRPC_ADDR
              value: "localhost:9090"
            - name: LOG_LEVEL
              value: "info"
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "1000m"
              memory: "512Mi"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            grpc:
              port: 9090
              service: ""
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: platform
spec:
  selector:
    app: api-gateway
  ports:
    - port: 80
      targetPort: 8080
      name: http
    - port: 9090
      targetPort: 9090
      name: grpc
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-gateway
  namespace: platform
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "GRPC"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-gateway
                port:
                  number: 80
```

## OpenAPI Documentation

The `buf.gen.yaml` configuration above generates OpenAPI v2 (Swagger) documentation. Serve it with Swagger UI:

```yaml
# k8s/swagger-ui.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: swagger-ui
  namespace: platform
spec:
  replicas: 1
  selector:
    matchLabels:
      app: swagger-ui
  template:
    spec:
      containers:
        - name: swagger-ui
          image: swaggerapi/swagger-ui:latest
          env:
            - name: SWAGGER_JSON_URL
              value: "https://api.example.com/openapi/v2/api.json"
          ports:
            - containerPort: 8080
```

Serve the OpenAPI spec from the gateway:

```go
// In cmd/server/main.go, add a route for the OpenAPI spec
mux.Handle("/openapi/", http.StripPrefix("/openapi/",
    http.FileServer(http.FS(openAPIFiles)))) // embed docs/openapi
```

## Testing

```bash
# Test REST endpoint
curl -s https://api.example.com/v1/users \
  -H "Authorization: Bearer <token>" | jq .

# Test with grpcurl for direct gRPC
grpcurl -plaintext \
  -H "authorization: Bearer <token>" \
  -d '{"page_size": 10}' \
  localhost:9090 \
  user.v1.UserService/ListUsers

# Test server-streaming via REST (SSE/chunked transfer)
curl -N https://api.example.com/v1/users/abc123/watch \
  -H "Authorization: Bearer <token>"

# Load test
hey -n 10000 -c 100 \
  -H "Authorization: Bearer <token>" \
  https://api.example.com/v1/users
```

## Summary

grpc-gateway provides a clean, maintainable solution for exposing gRPC services as REST APIs. The combination of protobuf annotations, code generation, and the runtime mux eliminates the manual work of writing a separate REST layer. By embedding the gateway in the same process as the gRPC server, you can achieve sub-millisecond REST-to-gRPC transcoding while maintaining a single service definition as the source of truth for your API. The pattern scales well from a single microservice to a platform with dozens of services sharing a common gateway deployment.
