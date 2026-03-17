---
title: "gRPC-Gateway: Serving REST and gRPC from a Single Go Service"
date: 2028-10-11T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "REST", "API", "Protobuf"]
categories:
- Go
- gRPC
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to use gRPC-Gateway to serve both gRPC and HTTP/JSON from a single Go binary, including OpenAPI generation, authentication, streaming endpoints, and CORS configuration."
more_link: "yes"
url: "/go-grpc-gateway-rest-grpc-transcoding-guide/"
---

Modern API services increasingly need to support both gRPC clients (for internal microservice communication) and REST clients (for browsers, mobile apps, and external integrations). Maintaining two separate services for this is wasteful. gRPC-Gateway solves this by generating a reverse proxy that translates HTTP/JSON requests into gRPC calls, letting you ship a single binary that speaks both protocols fluently.

This guide covers the complete production setup: protobuf annotations, code generation, dual-server configuration, OpenAPI documentation, authentication through gRPC metadata, streaming endpoints, CORS, and client generation.

<!--more-->

# gRPC-Gateway: Serving REST and gRPC from a Single Go Service

## Why gRPC-Gateway

gRPC is excellent for internal service communication — it is fast, strongly typed, and generates clients in every major language. But it is a poor fit for browser clients and external API consumers who expect JSON over HTTP/1.1. The traditional answer is to write two services or maintain a hand-written translation layer, both of which create duplication and drift.

gRPC-Gateway generates this translation layer from your protobuf definitions. You annotate your `.proto` file with HTTP mapping rules using `google.api.http` options, then run `protoc-gen-grpc-gateway` to produce a Go handler that:

- Decodes JSON request bodies into protobuf messages
- Forwards calls to your gRPC server
- Encodes protobuf responses back to JSON

The result is a single Go binary listening on two ports (or multiplexed on one) that serves both gRPC and REST traffic with a single implementation.

## Project Layout

```
api-service/
├── proto/
│   └── v1/
│       └── service.proto
├── gen/
│   └── go/
│       └── v1/            # generated code lives here
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   └── server/
│       └── handler.go
├── buf.yaml
├── buf.gen.yaml
└── go.mod
```

## Setting Up the Toolchain

Install the required tools. Using `buf` is strongly recommended over raw `protoc` because it handles plugin versioning and import resolution cleanly.

```bash
# Install buf
go install github.com/bufbuild/buf/cmd/buf@latest

# Install protoc plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2@latest
```

Create `buf.yaml` at the repository root:

```yaml
version: v2
modules:
  - path: proto
deps:
  - buf.build/googleapis/googleapis
  - buf.build/grpc-ecosystem/grpc-gateway
lint:
  use:
    - DEFAULT
breaking:
  use:
    - FILE
```

Create `buf.gen.yaml`:

```yaml
version: v2
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: github.com/yourorg/api-service/gen/go
plugins:
  - remote: buf.build/protocolbuffers/go
    out: gen/go
    opt:
      - paths=source_relative
  - remote: buf.build/grpc/go
    out: gen/go
    opt:
      - paths=source_relative
  - remote: buf.build/grpc-ecosystem/gateway
    out: gen/go
    opt:
      - paths=source_relative
      - generate_unbound_methods=true
  - remote: buf.build/grpc-ecosystem/openapiv2
    out: gen/openapi
    opt:
      - output_format=yaml
      - allow_merge=true
      - merge_file_name=api
```

## Defining the Protobuf Service with HTTP Annotations

The key to gRPC-Gateway is the `google.api.http` annotation on each RPC. These annotations map HTTP methods and URL paths to gRPC calls.

```proto
syntax = "proto3";

package v1;

option go_package = "github.com/yourorg/api-service/gen/go/v1;v1";

import "google/api/annotations.proto";
import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";
import "protoc-gen-openapiv2/options/annotations.proto";

option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_swagger) = {
  info: {
    title: "User Service API"
    version: "1.0"
    contact: {
      name: "Platform Team"
      email: "platform@yourorg.com"
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
};

// CreateUserRequest represents a user creation payload.
message CreateUserRequest {
  string email    = 1;
  string username = 2;
  string role     = 3;
}

message User {
  string                    id         = 1;
  string                    email      = 2;
  string                    username   = 3;
  string                    role       = 4;
  google.protobuf.Timestamp created_at = 5;
}

message GetUserRequest {
  string id = 1;
}

message ListUsersRequest {
  int32  page_size  = 1;
  string page_token = 2;
  string filter     = 3;
}

message ListUsersResponse {
  repeated User users          = 1;
  string        next_page_token = 2;
  int32         total_count    = 3;
}

message UpdateUserRequest {
  string id       = 1;
  string username = 2;
  string role     = 3;
}

message DeleteUserRequest {
  string id = 1;
}

// StreamUsersRequest triggers a server-side streaming response.
message StreamUsersRequest {
  string filter = 1;
}

// UserService manages user accounts.
service UserService {
  // CreateUser creates a new user account.
  rpc CreateUser(CreateUserRequest) returns (User) {
    option (google.api.http) = {
      post: "/v1/users"
      body: "*"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Create a new user"
      security: { security_requirement: { key: "BearerAuth" value: {} } }
    };
  }

  // GetUser retrieves a user by ID.
  rpc GetUser(GetUserRequest) returns (User) {
    option (google.api.http) = {
      get: "/v1/users/{id}"
    };
  }

  // ListUsers returns a paginated list of users.
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse) {
    option (google.api.http) = {
      get: "/v1/users"
    };
  }

  // UpdateUser modifies an existing user.
  rpc UpdateUser(UpdateUserRequest) returns (User) {
    option (google.api.http) = {
      patch: "/v1/users/{id}"
      body: "*"
    };
    // Also expose via PUT for clients that prefer full replacement semantics
    additional_bindings: {
      put: "/v1/users/{id}"
      body: "*"
    }
  }

  // DeleteUser removes a user account.
  rpc DeleteUser(DeleteUserRequest) returns (google.protobuf.Empty) {
    option (google.api.http) = {
      delete: "/v1/users/{id}"
    };
  }

  // StreamUsers streams users matching a filter (server-side streaming).
  rpc StreamUsers(StreamUsersRequest) returns (stream User) {
    option (google.api.http) = {
      get: "/v1/users:stream"
    };
  }
}
```

Generate the code:

```bash
buf generate
```

This produces:
- `gen/go/v1/service.pb.go` — protobuf message types
- `gen/go/v1/service_grpc.pb.go` — gRPC server/client stubs
- `gen/go/v1/service.pb.gw.go` — gRPC-Gateway HTTP handler
- `gen/openapi/api.yaml` — OpenAPI 2.0 specification

## Implementing the gRPC Server Handler

The gRPC server is a standard Go struct that implements the generated interface. gRPC-Gateway calls this same implementation — there is no separate REST handler to write.

```go
// internal/server/handler.go
package server

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/yourorg/api-service/gen/go/v1"
)

// UserServiceServer implements v1.UserServiceServer.
type UserServiceServer struct {
	v1.UnimplementedUserServiceServer
	store UserStore
}

// UserStore is the interface for user persistence.
type UserStore interface {
	Create(ctx context.Context, u *v1.User) error
	Get(ctx context.Context, id string) (*v1.User, error)
	List(ctx context.Context, pageSize int32, pageToken, filter string) ([]*v1.User, string, int32, error)
	Update(ctx context.Context, u *v1.User) (*v1.User, error)
	Delete(ctx context.Context, id string) error
}

func NewUserServiceServer(store UserStore) *UserServiceServer {
	return &UserServiceServer{store: store}
}

func (s *UserServiceServer) CreateUser(ctx context.Context, req *v1.CreateUserRequest) (*v1.User, error) {
	// Extract caller identity from metadata (set by auth interceptor).
	md, _ := metadata.FromIncomingContext(ctx)
	callerID := ""
	if vals := md.Get("x-caller-id"); len(vals) > 0 {
		callerID = vals[0]
	}
	_ = callerID // use for audit logging in production

	if req.Email == "" {
		return nil, status.Error(codes.InvalidArgument, "email is required")
	}
	if req.Username == "" {
		return nil, status.Error(codes.InvalidArgument, "username is required")
	}

	user := &v1.User{
		Id:        uuid.New().String(),
		Email:     req.Email,
		Username:  req.Username,
		Role:      req.Role,
		CreatedAt: timestamppb.New(time.Now()),
	}

	if err := s.store.Create(ctx, user); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create user: %v", err)
	}
	return user, nil
}

func (s *UserServiceServer) GetUser(ctx context.Context, req *v1.GetUserRequest) (*v1.User, error) {
	if req.Id == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}

	user, err := s.store.Get(ctx, req.Id)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "user %q not found", req.Id)
	}
	return user, nil
}

func (s *UserServiceServer) ListUsers(ctx context.Context, req *v1.ListUsersRequest) (*v1.ListUsersResponse, error) {
	pageSize := req.PageSize
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 20
	}

	users, nextToken, total, err := s.store.List(ctx, pageSize, req.PageToken, req.Filter)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "list failed: %v", err)
	}

	return &v1.ListUsersResponse{
		Users:         users,
		NextPageToken: nextToken,
		TotalCount:    total,
	}, nil
}

func (s *UserServiceServer) UpdateUser(ctx context.Context, req *v1.UpdateUserRequest) (*v1.User, error) {
	if req.Id == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}

	existing, err := s.store.Get(ctx, req.Id)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "user %q not found", req.Id)
	}

	if req.Username != "" {
		existing.Username = req.Username
	}
	if req.Role != "" {
		existing.Role = req.Role
	}

	updated, err := s.store.Update(ctx, existing)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "update failed: %v", err)
	}
	return updated, nil
}

func (s *UserServiceServer) DeleteUser(ctx context.Context, req *v1.DeleteUserRequest) (*emptypb.Empty, error) {
	if req.Id == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}
	if err := s.store.Delete(ctx, req.Id); err != nil {
		return nil, status.Errorf(codes.NotFound, "user %q not found", req.Id)
	}
	return &emptypb.Empty{}, nil
}

// StreamUsers demonstrates server-side streaming via gRPC-Gateway.
// The gateway transcodes this to chunked HTTP/1.1 or HTTP/2 SSE.
func (s *UserServiceServer) StreamUsers(req *v1.StreamUsersRequest, stream v1.UserService_StreamUsersServer) error {
	ctx := stream.Context()

	// In production, paginate through the store rather than loading everything.
	users, _, _, err := s.store.List(ctx, 100, "", req.Filter)
	if err != nil {
		return status.Errorf(codes.Internal, "stream failed: %v", err)
	}

	for _, user := range users {
		if err := stream.Send(user); err != nil {
			return fmt.Errorf("send failed: %w", err)
		}
		// Simulate realistic streaming — remove in production
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}
```

## Wiring the Dual Server in main.go

This is where the magic happens. We run a gRPC server and an HTTP server (powered by gRPC-Gateway) from the same binary. The HTTP server can optionally be multiplexed onto the same port using `cmux`.

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
	"github.com/rs/cors"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/reflection"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/yourorg/api-service/gen/go/v1"
	"github.com/yourorg/api-service/internal/server"
	"github.com/yourorg/api-service/internal/store"
)

const (
	grpcPort = ":9090"
	httpPort = ":8080"
)

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize backing store (replace with real DB in production).
	userStore := store.NewInMemoryUserStore()
	svc := server.NewUserServiceServer(userStore)

	// ── gRPC Server ───────────────────────────────────────────────────
	grpcServer := grpc.NewServer(
		grpc.ChainUnaryInterceptor(
			authInterceptor(logger),
			loggingInterceptor(logger),
		),
		grpc.ChainStreamInterceptor(
			authStreamInterceptor(logger),
		),
	)
	v1.RegisterUserServiceServer(grpcServer, svc)
	reflection.Register(grpcServer)

	grpcLis, err := net.Listen("tcp", grpcPort)
	if err != nil {
		logger.Fatal("failed to listen on gRPC port", zap.Error(err))
	}

	go func() {
		logger.Info("gRPC server listening", zap.String("addr", grpcPort))
		if err := grpcServer.Serve(grpcLis); err != nil {
			logger.Error("gRPC server stopped", zap.Error(err))
		}
	}()

	// ── gRPC-Gateway HTTP/JSON Server ─────────────────────────────────
	// Use EmitUnpopulated so zero-value fields appear in JSON responses.
	gwMux := runtime.NewServeMux(
		runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
			MarshalOptions: protojson.MarshalOptions{
				EmitUnpopulated: true,
				UseProtoNames:   true, // snake_case field names
			},
			UnmarshalOptions: protojson.UnmarshalOptions{
				DiscardUnknown: true,
			},
		}),
		runtime.WithIncomingHeaderMatcher(customHeaderMatcher),
		runtime.WithErrorHandler(customErrorHandler),
		runtime.WithRoutingErrorHandler(customRoutingErrorHandler),
	)

	opts := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	if err := v1.RegisterUserServiceHandlerFromEndpoint(ctx, gwMux, "localhost"+grpcPort, opts); err != nil {
		logger.Fatal("failed to register gateway", zap.Error(err))
	}

	// Wrap with CORS and logging middleware.
	httpHandler := buildHTTPHandler(gwMux, logger)

	httpServer := &http.Server{
		Addr:         httpPort,
		Handler:      httpHandler,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		logger.Info("HTTP/JSON gateway listening", zap.String("addr", httpPort))
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("HTTP server stopped", zap.Error(err))
		}
	}()

	// ── Graceful Shutdown ─────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down servers")
	grpcServer.GracefulStop()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP shutdown error", zap.Error(err))
	}
	logger.Info("shutdown complete")
}

// buildHTTPHandler layers CORS, health check, and OpenAPI serving on top of the gateway mux.
func buildHTTPHandler(gwMux *runtime.ServeMux, logger *zap.Logger) http.Handler {
	mux := http.NewServeMux()

	// Health endpoint (not behind auth).
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})

	// Serve the generated OpenAPI spec.
	mux.HandleFunc("/openapi.yaml", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "gen/openapi/api.yaml")
	})

	// All other paths go to the gRPC-Gateway mux.
	mux.Handle("/", gwMux)

	// CORS configuration for browser clients.
	corsHandler := cors.New(cors.Options{
		AllowedOrigins: []string{
			"https://app.yourorg.com",
			"http://localhost:3000",
		},
		AllowedMethods: []string{
			http.MethodGet,
			http.MethodPost,
			http.MethodPut,
			http.MethodPatch,
			http.MethodDelete,
			http.MethodOptions,
		},
		AllowedHeaders: []string{
			"Authorization",
			"Content-Type",
			"X-Request-ID",
			"X-Correlation-ID",
		},
		ExposedHeaders:   []string{"X-Request-ID", "X-Total-Count"},
		AllowCredentials: true,
		MaxAge:           300,
	})

	return corsHandler.Handler(mux)
}

// customHeaderMatcher passes additional headers from HTTP into gRPC metadata.
func customHeaderMatcher(key string) (string, bool) {
	switch key {
	case "X-Request-Id", "X-Correlation-Id", "X-Caller-Id":
		return key, true
	default:
		return runtime.DefaultHeaderMatcher(key)
	}
}
```

## Authentication: gRPC Interceptors and Metadata

Authentication is handled uniformly in a gRPC unary interceptor. The same interceptor protects both gRPC and HTTP/JSON calls because the gateway translates HTTP headers into gRPC metadata before calling the interceptor chain.

```go
// internal/server/interceptors.go
package server

import (
	"context"
	"strings"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// unauthenticatedMethods are RPC paths that bypass JWT verification.
var unauthenticatedMethods = map[string]bool{
	"/v1.UserService/HealthCheck": true,
}

func authInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if unauthenticatedMethods[info.FullMethod] {
			return handler(ctx, req)
		}

		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "missing metadata")
		}

		// gRPC-Gateway forwards the HTTP Authorization header as "authorization" metadata.
		authHeader := ""
		if vals := md.Get("authorization"); len(vals) > 0 {
			authHeader = vals[0]
		}
		if authHeader == "" {
			return nil, status.Error(codes.Unauthenticated, "missing authorization header")
		}

		token, found := strings.CutPrefix(authHeader, "Bearer ")
		if !found {
			return nil, status.Error(codes.Unauthenticated, "authorization must be Bearer token")
		}

		claims, err := validateJWT(token)
		if err != nil {
			logger.Warn("invalid JWT", zap.Error(err))
			return nil, status.Error(codes.Unauthenticated, "invalid token")
		}

		// Inject verified claims into context for downstream handlers.
		ctx = metadata.NewIncomingContext(ctx, metadata.Join(md, metadata.Pairs(
			"x-caller-id", claims.Subject,
			"x-caller-role", claims.Role,
		)))

		return handler(ctx, req)
	}
}

func authStreamInterceptor(logger *zap.Logger) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if unauthenticatedMethods[info.FullMethod] {
			return handler(srv, ss)
		}

		md, ok := metadata.FromIncomingContext(ss.Context())
		if !ok {
			return status.Error(codes.Unauthenticated, "missing metadata")
		}

		authHeader := ""
		if vals := md.Get("authorization"); len(vals) > 0 {
			authHeader = vals[0]
		}
		if authHeader == "" {
			return status.Error(codes.Unauthenticated, "missing authorization header")
		}

		token, _ := strings.CutPrefix(authHeader, "Bearer ")
		if _, err := validateJWT(token); err != nil {
			return status.Error(codes.Unauthenticated, "invalid token")
		}

		return handler(srv, ss)
	}
}

func loggingInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		resp, err := handler(ctx, req)
		if err != nil {
			st, _ := status.FromError(err)
			logger.Warn("RPC error",
				zap.String("method", info.FullMethod),
				zap.String("code", st.Code().String()),
				zap.String("message", st.Message()),
			)
		}
		return resp, err
	}
}

// Claims is a minimal JWT claims struct.
type Claims struct {
	Subject string
	Role    string
}

// validateJWT is a placeholder — replace with your JWT library (e.g., golang-jwt/jwt).
func validateJWT(token string) (Claims, error) {
	// Production: parse and verify signature, expiry, audience.
	_ = token
	return Claims{Subject: "user-123", Role: "admin"}, nil
}
```

## Custom Error Handler

gRPC-Gateway's default error handler maps gRPC status codes to HTTP status codes. Extend it to add a consistent error envelope:

```go
// internal/server/errors.go
package server

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type errorResponse struct {
	Code    int    `json:"code"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

func customErrorHandler(ctx context.Context, mux *runtime.ServeMux, m runtime.Marshaler, w http.ResponseWriter, r *http.Request, err error) {
	st, ok := status.FromError(err)
	if !ok {
		st = status.New(codes.Internal, err.Error())
	}

	httpCode := runtime.HTTPStatusFromCode(st.Code())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(httpCode)

	body := errorResponse{
		Code:    httpCode,
		Status:  st.Code().String(),
		Message: st.Message(),
	}
	if encErr := json.NewEncoder(w).Encode(body); encErr != nil {
		_ = encErr
	}
}

func customRoutingErrorHandler(ctx context.Context, mux *runtime.ServeMux, m runtime.Marshaler, w http.ResponseWriter, r *http.Request, httpStatus int) {
	sterr := status.Error(runtime.HTTPStatusCode(httpStatus), http.StatusText(httpStatus))
	customErrorHandler(ctx, mux, m, w, r, sterr)
}
```

## Streaming Endpoints

Server-side streaming over gRPC-Gateway works but has limitations. The gateway uses HTTP chunked encoding to stream gRPC server-side streams to HTTP/1.1 clients. Each streamed message is sent as a separate JSON object in the response body, prefixed with a content-length delimiter in the `application/grpc` framing.

For browser compatibility, the recommended pattern is to use the streaming endpoint directly from gRPC clients and expose a pagination endpoint for REST clients:

```bash
# gRPC streaming client (grpcurl)
grpcurl -H "Authorization: Bearer $TOKEN" \
  -d '{"filter": "role=admin"}' \
  localhost:9090 v1.UserService/StreamUsers

# HTTP streaming (curl — receives newline-delimited JSON)
curl -H "Authorization: Bearer $TOKEN" \
  -N "http://localhost:8080/v1/users:stream?filter=role%3Dadmin"
```

The gateway produces output like:

```
{"id":"abc","email":"alice@example.com","username":"alice","role":"admin","created_at":"2024-01-01T00:00:00Z"}
{"id":"def","email":"bob@example.com","username":"bob","role":"admin","created_at":"2024-01-02T00:00:00Z"}
```

## Generating the OpenAPI Specification

After running `buf generate`, you get `gen/openapi/api.yaml`. Serve it with SwaggerUI for interactive documentation:

```yaml
# docker-compose.yaml (for local development)
services:
  swagger-ui:
    image: swaggerapi/swagger-ui:latest
    ports:
      - "8090:8080"
    environment:
      SWAGGER_JSON_URL: http://localhost:8080/openapi.yaml
    depends_on:
      - api-server
```

You can also embed the spec in the binary itself:

```go
// cmd/server/main.go — add to mux setup
//go:embed gen/openapi/api.yaml
var openAPISpec []byte

mux.HandleFunc("/openapi.yaml", func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/yaml")
    w.Write(openAPISpec)
})
```

## Client Code Generation

Generate TypeScript clients from the OpenAPI spec using `openapi-generator`:

```bash
npx @openapitools/openapi-generator-cli generate \
  -i gen/openapi/api.yaml \
  -g typescript-fetch \
  -o client/typescript \
  --additional-properties=typescriptThreePlus=true,npmName=@yourorg/api-client
```

For Go gRPC clients, the generated stub is already in `gen/go/v1`:

```go
// Example Go gRPC client
conn, err := grpc.NewClient("localhost:9090",
    grpc.WithTransportCredentials(insecure.NewCredentials()),
    grpc.WithUnaryInterceptor(func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
        ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+os.Getenv("API_TOKEN"))
        return invoker(ctx, method, req, reply, cc, opts...)
    }),
)
if err != nil {
    log.Fatal(err)
}
defer conn.Close()

client := v1.NewUserServiceClient(conn)
user, err := client.CreateUser(context.Background(), &v1.CreateUserRequest{
    Email:    "alice@example.com",
    Username: "alice",
    Role:     "engineer",
})
```

## go.mod Dependencies

```go
module github.com/yourorg/api-service

go 1.22

require (
    github.com/google/uuid v1.6.0
    github.com/grpc-ecosystem/grpc-gateway/v2 v2.22.0
    github.com/rs/cors v1.11.1
    go.uber.org/zap v1.27.0
    google.golang.org/grpc v1.67.1
    google.golang.org/protobuf v1.35.1
)
```

## Testing the Gateway

```bash
# Create a user via REST
curl -s -X POST http://localhost:8080/v1/users \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","username":"alice","role":"engineer"}' | jq .

# Get user by ID via REST
curl -s http://localhost:8080/v1/users/abc-123 \
  -H "Authorization: Bearer test-token" | jq .

# List users with pagination
curl -s "http://localhost:8080/v1/users?page_size=10&filter=role%3Dengineer" \
  -H "Authorization: Bearer test-token" | jq .

# Same call via gRPC (grpcurl)
grpcurl -plaintext -H "Authorization: Bearer test-token" \
  -d '{"page_size":10,"filter":"role=engineer"}' \
  localhost:9090 v1.UserService/ListUsers
```

## Production Considerations

**TLS termination**: In production, TLS terminates at the ingress (NGINX/Envoy). Internal gRPC uses plaintext within the cluster. If you need end-to-end TLS, use `grpc.WithTransportCredentials(credentials.NewTLS(...))` on the gateway's dial options.

**Request ID propagation**: The `customHeaderMatcher` passes `X-Request-ID` through metadata. Log it in every interceptor for distributed tracing correlation.

**Rate limiting**: Add a gRPC unary interceptor using `golang.org/x/time/rate` or integrate with Envoy's rate limit service via the gateway's `runtime.WithMetadata` hook.

**Protobuf field masks**: For partial updates, use `google.protobuf.FieldMask` in `UpdateUserRequest` and apply it via `fieldmaskpb.Update` to avoid overwriting unset fields.

**Health checks**: Register the gRPC health service (`google.golang.org/grpc/health`) alongside the user service. gRPC-Gateway transparently exposes it over HTTP at `/grpc.health.v1.Health/Check`.

gRPC-Gateway eliminates the cost of maintaining two separate API layers. A single protobuf definition becomes the contract for both gRPC and REST, the generated gateway enforces it at runtime, and your authentication, validation, and business logic run once regardless of which protocol the client speaks.
