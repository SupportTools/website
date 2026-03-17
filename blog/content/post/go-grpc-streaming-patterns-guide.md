---
title: "gRPC Streaming in Go: Server-Side, Client-Side, and Bidirectional Patterns"
date: 2028-03-03T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Streaming", "Protobuf", "Microservices", "API"]
categories: ["Go", "Microservices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to gRPC streaming in Go: proto3 service definitions, server/client/bidirectional stream implementation, flow control, keepalive, interceptor chains, gRPC-Gateway REST bridge, grpcurl testing, and health check protocol."
more_link: "yes"
url: "/go-grpc-streaming-patterns-guide/"
---

gRPC's streaming RPCs enable patterns that are impossible with unary calls: real-time event feeds, incremental result delivery, bidirectional chat protocols, and long-lived connections that push updates as they occur. Go's gRPC implementation provides all four RPC types—unary, server-streaming, client-streaming, and bidirectional streaming—with idiomatic goroutine-based APIs. This guide covers complete implementations for each streaming type, flow control, production keepalive configuration, interceptor chains for cross-cutting concerns, the gRPC-Gateway for REST bridging, testing with grpcurl, and the standard health check protocol.

<!--more-->

## Proto3 Service Definitions for All Streaming Types

Start with protocol buffer definitions that cover all four RPC variants:

```protobuf
// streaming.proto
syntax = "proto3";

package streaming.v1;

option go_package = "github.com/example/service/gen/streaming/v1;streamingv1";

import "google/protobuf/timestamp.proto";

// DataService demonstrates all four RPC types
service DataService {
  // Unary: single request, single response
  rpc GetRecord(GetRecordRequest) returns (GetRecordResponse);

  // Server streaming: single request, multiple responses
  // Client subscribes to a feed of events
  rpc WatchEvents(WatchEventsRequest) returns (stream Event);

  // Client streaming: multiple requests, single response
  // Client uploads a batch of records; server acknowledges once complete
  rpc UploadRecords(stream UploadRecordRequest) returns (UploadRecordResponse);

  // Bidirectional streaming: multiple requests, multiple responses
  // Suitable for interactive sessions, proxies, and chat-like protocols
  rpc ProcessStream(stream ProcessRequest) returns (stream ProcessResponse);
}

message GetRecordRequest {
  string id = 1;
}

message GetRecordResponse {
  Record record = 1;
}

message WatchEventsRequest {
  string filter = 1;
  google.protobuf.Timestamp since = 2;
  repeated string event_types = 3;
}

message Event {
  string id = 1;
  string type = 2;
  bytes payload = 3;
  google.protobuf.Timestamp timestamp = 4;
}

message UploadRecordRequest {
  Record record = 1;
}

message UploadRecordResponse {
  int64 records_processed = 1;
  int64 records_failed = 2;
  repeated string errors = 3;
}

message ProcessRequest {
  string session_id = 1;
  bytes data = 2;
  map<string, string> metadata = 3;
}

message ProcessResponse {
  string request_id = 1;
  bytes result = 2;
  bool is_final = 3;
  string error = 4;
}

message Record {
  string id = 1;
  string name = 2;
  bytes data = 3;
  google.protobuf.Timestamp created_at = 4;
}
```

Generate Go code:

```bash
# Install protoc and plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@latest

# Generate
protoc \
  --proto_path=proto \
  --go_out=gen \
  --go_opt=paths=source_relative \
  --go-grpc_out=gen \
  --go-grpc_opt=paths=source_relative \
  proto/streaming.proto
```

## Server Implementation: All Streaming Types

```go
package server

import (
    "context"
    "fmt"
    "io"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    pb "github.com/example/service/gen/streaming/v1"
)

type DataServiceServer struct {
    pb.UnimplementedDataServiceServer
    store RecordStore
    bus   EventBus
}

// Unary RPC
func (s *DataServiceServer) GetRecord(
    ctx context.Context,
    req *pb.GetRecordRequest,
) (*pb.GetRecordResponse, error) {
    record, err := s.store.Get(ctx, req.Id)
    if err != nil {
        return nil, status.Errorf(codes.NotFound, "record %s not found: %v", req.Id, err)
    }
    return &pb.GetRecordResponse{Record: record}, nil
}

// Server-streaming RPC
// The server sends multiple messages to one client request.
// Pattern: subscribe to an event source and forward events.
func (s *DataServiceServer) WatchEvents(
    req *pb.WatchEventsRequest,
    stream pb.DataService_WatchEventsServer,
) error {
    ctx := stream.Context()

    sub, err := s.bus.Subscribe(ctx, req.Filter, req.EventTypes)
    if err != nil {
        return status.Errorf(codes.Internal, "subscribing to events: %v", err)
    }
    defer sub.Close()

    for {
        select {
        case <-ctx.Done():
            // Client disconnected or deadline exceeded
            return nil

        case event, ok := <-sub.Events():
            if !ok {
                // Event bus closed
                return nil
            }

            if err := stream.Send(event); err != nil {
                // Client disconnected during send
                if status.Code(err) == codes.Canceled {
                    return nil
                }
                return fmt.Errorf("sending event %s: %w", event.Id, err)
            }
        }
    }
}

// Client-streaming RPC
// The client sends multiple messages; the server reads them all and responds once.
// Pattern: batch upload with accumulated processing.
func (s *DataServiceServer) UploadRecords(
    stream pb.DataService_UploadRecordsServer,
) error {
    var (
        processed int64
        failed    int64
        errors    []string
    )

    for {
        req, err := stream.Recv()
        if err == io.EOF {
            // Client finished sending; send the final summary
            return stream.SendAndClose(&pb.UploadRecordResponse{
                RecordsProcessed: processed,
                RecordsFailed:    failed,
                Errors:           errors,
            })
        }
        if err != nil {
            return status.Errorf(codes.Internal, "receiving record: %v", err)
        }

        // Check context on each iteration
        if err := stream.Context().Err(); err != nil {
            return status.FromContextError(err).Err()
        }

        if err := s.store.Create(stream.Context(), req.Record); err != nil {
            failed++
            errors = append(errors, fmt.Sprintf("record %s: %v", req.Record.Id, err))
            if len(errors) > 100 {
                errors = errors[:100] // Cap error list size
            }
        } else {
            processed++
        }
    }
}

// Bidirectional streaming RPC
// Both client and server send streams of messages concurrently.
// Pattern: request-response pairs where server can respond out of order.
func (s *DataServiceServer) ProcessStream(
    stream pb.DataService_ProcessStreamServer,
) error {
    ctx := stream.Context()
    results := make(chan *pb.ProcessResponse, 10)
    errs := make(chan error, 1)

    // Goroutine: read client requests and process them
    go func() {
        defer close(results)
        for {
            req, err := stream.Recv()
            if err == io.EOF {
                return
            }
            if err != nil {
                if status.Code(err) == codes.Canceled {
                    return
                }
                select {
                case errs <- fmt.Errorf("receiving request: %w", err):
                default:
                }
                return
            }

            // Process each request asynchronously
            go func(r *pb.ProcessRequest) {
                result, err := s.process(ctx, r)
                if err != nil {
                    result = &pb.ProcessResponse{
                        RequestId: r.SessionId,
                        Error:     err.Error(),
                        IsFinal:   true,
                    }
                }
                select {
                case results <- result:
                case <-ctx.Done():
                }
            }(req)
        }
    }()

    // Send results as they become available
    for {
        select {
        case <-ctx.Done():
            return nil

        case err := <-errs:
            return err

        case result, ok := <-results:
            if !ok {
                return nil // Receiver closed results
            }
            if err := stream.Send(result); err != nil {
                return fmt.Errorf("sending result: %w", err)
            }
        }
    }
}

func (s *DataServiceServer) process(
    ctx context.Context,
    req *pb.ProcessRequest,
) (*pb.ProcessResponse, error) {
    // Simulate processing
    return &pb.ProcessResponse{
        RequestId: req.SessionId,
        Result:    req.Data,
        IsFinal:   true,
    }, nil
}

// Interfaces for dependency injection
type RecordStore interface {
    Get(ctx context.Context, id string) (*pb.Record, error)
    Create(ctx context.Context, record *pb.Record) error
}

type EventBus interface {
    Subscribe(ctx context.Context, filter string, types []string) (Subscription, error)
}

type Subscription interface {
    Events() <-chan *pb.Event
    Close()
}
```

## Client Implementation: All Streaming Types

```go
package client

import (
    "context"
    "fmt"
    "io"
    "log/slog"

    "google.golang.org/grpc"

    pb "github.com/example/service/gen/streaming/v1"
)

type DataClient struct {
    client pb.DataServiceClient
}

func NewDataClient(conn *grpc.ClientConn) *DataClient {
    return &DataClient{client: pb.NewDataServiceClient(conn)}
}

// Server-streaming client: receive multiple messages from one request
func (c *DataClient) WatchEvents(
    ctx context.Context,
    filter string,
    handler func(*pb.Event) error,
) error {
    stream, err := c.client.WatchEvents(ctx, &pb.WatchEventsRequest{
        Filter: filter,
    })
    if err != nil {
        return fmt.Errorf("starting watch: %w", err)
    }

    for {
        event, err := stream.Recv()
        if err == io.EOF {
            return nil // Normal stream end
        }
        if err != nil {
            return fmt.Errorf("receiving event: %w", err)
        }

        if err := handler(event); err != nil {
            return fmt.Errorf("handling event %s: %w", event.Id, err)
        }
    }
}

// Client-streaming: send multiple messages, receive one response
func (c *DataClient) UploadRecords(
    ctx context.Context,
    records []*pb.Record,
) (*pb.UploadRecordResponse, error) {
    stream, err := c.client.UploadRecords(ctx)
    if err != nil {
        return nil, fmt.Errorf("starting upload stream: %w", err)
    }

    for i, record := range records {
        if err := stream.Send(&pb.UploadRecordRequest{Record: record}); err != nil {
            return nil, fmt.Errorf("sending record %d/%d: %w", i+1, len(records), err)
        }

        // Check context periodically
        if i%100 == 0 {
            if err := ctx.Err(); err != nil {
                return nil, fmt.Errorf("upload cancelled: %w", err)
            }
        }
    }

    resp, err := stream.CloseAndRecv()
    if err != nil {
        return nil, fmt.Errorf("closing stream: %w", err)
    }
    return resp, nil
}

// Bidirectional streaming: concurrent send and receive
func (c *DataClient) ProcessStream(
    ctx context.Context,
    requests <-chan *pb.ProcessRequest,
    handler func(*pb.ProcessResponse),
) error {
    stream, err := c.client.ProcessStream(ctx)
    if err != nil {
        return fmt.Errorf("starting process stream: %w", err)
    }

    // Goroutine: send requests
    sendErr := make(chan error, 1)
    go func() {
        defer func() {
            if err := stream.CloseSend(); err != nil {
                slog.Error("closing send stream", "error", err)
            }
        }()
        for req := range requests {
            if err := stream.Send(req); err != nil {
                sendErr <- fmt.Errorf("sending request: %w", err)
                return
            }
        }
    }()

    // Main goroutine: receive responses
    for {
        resp, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return fmt.Errorf("receiving response: %w", err)
        }
        handler(resp)
    }

    // Check if sender encountered an error
    select {
    case err := <-sendErr:
        return err
    default:
        return nil
    }
}
```

## Flow Control and Backpressure

gRPC uses HTTP/2 flow control to prevent fast senders from overwhelming slow receivers. The key settings are `InitialWindowSize` (per-stream) and `InitialConnWindowSize` (per-connection).

```go
package grpcconfig

import (
    "google.golang.org/grpc"
    "google.golang.org/grpc/keepalive"
)

// ServerOptions returns production-tuned gRPC server options
func ServerOptions() []grpc.ServerOption {
    return []grpc.ServerOption{
        // HTTP/2 flow control windows
        // Default 64KB is too small for high-throughput streaming
        grpc.InitialWindowSize(1 << 20),     // 1 MB per stream
        grpc.InitialConnWindowSize(1 << 23), // 8 MB per connection

        // Maximum message size (default: 4MB receive, unlimited send)
        grpc.MaxRecvMsgSize(16 * 1024 * 1024), // 16 MB receive
        grpc.MaxSendMsgSize(16 * 1024 * 1024), // 16 MB send

        // Keepalive: detect dead connections quickly
        grpc.KeepaliveParams(keepalive.ServerParameters{
            // Send keepalive ping if no activity for this duration
            Time: 30 * time.Second,
            // Close connection if no response within this duration
            Timeout: 10 * time.Second,
            // Allow keepalive pings even with no active streams
            MaxConnectionIdle: 5 * time.Minute,
            // Force reconnect after this duration regardless
            MaxConnectionAge:      30 * time.Minute,
            MaxConnectionAgeGrace: 5 * time.Second,
        }),
        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            // Minimum interval between client keepalive pings
            MinTime: 15 * time.Second,
            // Allow keepalive pings with no active streams
            PermitWithoutStream: true,
        }),
    }
}

// ClientDialOptions returns production-tuned gRPC client dial options
func ClientDialOptions() []grpc.DialOption {
    return []grpc.DialOption{
        grpc.WithInitialWindowSize(1 << 20),
        grpc.WithInitialConnWindowSize(1 << 23),

        grpc.WithDefaultCallOptions(
            grpc.MaxCallRecvMsgSize(16 * 1024 * 1024),
            grpc.MaxCallSendMsgSize(16 * 1024 * 1024),
        ),

        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            // Send keepalive ping after this much idle time
            Time: 30 * time.Second,
            // Close connection if no response within this duration
            Timeout: 10 * time.Second,
            // Allow pings with no active streams (for long-idle connections)
            PermitWithoutStream: false,
        }),
    }
}
```

## Interceptor Chains for Auth, Metrics, and Tracing

Interceptors are gRPC middleware. They wrap RPC calls to add cross-cutting behavior.

```go
package interceptors

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "go.opentelemetry.io/otel/trace"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    grpcRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "grpc_server_handled_total",
        Help: "Total number of RPCs completed on the server.",
    }, []string{"grpc_method", "grpc_type", "grpc_code"})

    grpcRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "grpc_server_handling_seconds",
        Help:    "Histogram of response latency (seconds) of gRPC that had been application-level handled by the server.",
        Buckets: prometheus.DefBuckets,
    }, []string{"grpc_method", "grpc_type"})
)

// UnaryServerInterceptors returns the standard unary interceptor chain
func UnaryServerInterceptors() grpc.ServerOption {
    return grpc.ChainUnaryInterceptor(
        UnaryRecoveryInterceptor(),
        UnaryAuthInterceptor(),
        UnaryMetricsInterceptor(),
        UnaryTracingInterceptor(),
        UnaryLoggingInterceptor(),
    )
}

// StreamServerInterceptors returns the standard streaming interceptor chain
func StreamServerInterceptors() grpc.ServerOption {
    return grpc.ChainStreamInterceptor(
        StreamRecoveryInterceptor(),
        StreamAuthInterceptor(),
        StreamMetricsInterceptor(),
        StreamTracingInterceptor(),
    )
}

// Auth interceptor: validates bearer token from metadata
func UnaryAuthInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        if err := validateToken(ctx); err != nil {
            return nil, err
        }
        return handler(ctx, req)
    }
}

func StreamAuthInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        if err := validateToken(ss.Context()); err != nil {
            return err
        }
        return handler(srv, ss)
    }
}

func validateToken(ctx context.Context) error {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return status.Error(codes.Unauthenticated, "missing metadata")
    }
    tokens := md.Get("authorization")
    if len(tokens) == 0 {
        return status.Error(codes.Unauthenticated, "missing authorization header")
    }
    // Validate token against auth service
    // if !authService.Validate(tokens[0]) { ... }
    return nil
}

// Metrics interceptor
func UnaryMetricsInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        start := time.Now()
        resp, err := handler(ctx, req)
        duration := time.Since(start)

        code := status.Code(err)
        grpcRequestsTotal.WithLabelValues(info.FullMethod, "unary", code.String()).Inc()
        grpcRequestDuration.WithLabelValues(info.FullMethod, "unary").Observe(duration.Seconds())

        return resp, err
    }
}

// Tracing interceptor using OpenTelemetry
func UnaryTracingInterceptor() grpc.UnaryServerInterceptor {
    tracer := otel.Tracer("grpc-server")
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        ctx, span := tracer.Start(ctx, info.FullMethod,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                semconv.RPCSystemGRPC,
                semconv.RPCMethod(info.FullMethod),
            ),
        )
        defer span.End()

        resp, err := handler(ctx, req)
        if err != nil {
            span.RecordError(err)
            span.SetAttributes(
                attribute.String("grpc.status_code", status.Code(err).String()),
            )
        }
        return resp, err
    }
}

// Recovery interceptor: convert panics to gRPC Internal errors
func UnaryRecoveryInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (resp any, err error) {
        defer func() {
            if r := recover(); r != nil {
                err = status.Errorf(codes.Internal, "panic: %v", r)
            }
        }()
        return handler(ctx, req)
    }
}

func StreamRecoveryInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) (err error) {
        defer func() {
            if r := recover(); r != nil {
                err = status.Errorf(codes.Internal, "panic: %v", r)
            }
        }()
        return handler(srv, ss)
    }
}

func UnaryLoggingInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        return handler(ctx, req)
    }
}

func StreamMetricsInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        start := time.Now()
        streamType := "server_stream"
        if info.IsClientStream {
            streamType = "client_stream"
        }
        if info.IsClientStream && info.IsServerStream {
            streamType = "bidi_stream"
        }

        err := handler(srv, ss)
        duration := time.Since(start)
        code := status.Code(err)
        grpcRequestsTotal.WithLabelValues(info.FullMethod, streamType, code.String()).Inc()
        grpcRequestDuration.WithLabelValues(info.FullMethod, streamType).Observe(duration.Seconds())
        return err
    }
}

func StreamTracingInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        return handler(srv, ss)
    }
}
```

## gRPC-Gateway for REST Bridge

gRPC-Gateway generates an HTTP/JSON proxy that translates between REST and gRPC, enabling services to serve both protocols from the same implementation.

Add HTTP annotations to the proto:

```protobuf
// streaming.proto (with gateway annotations)
import "google/api/annotations.proto";

service DataService {
  rpc GetRecord(GetRecordRequest) returns (GetRecordResponse) {
    option (google.api.http) = {
      get: "/v1/records/{id}"
    };
  }

  // Note: streaming RPCs are not directly exposed as REST via gateway
  // They require WebSocket or Server-Sent Events bridges
  rpc WatchEvents(WatchEventsRequest) returns (stream Event) {
    option (google.api.http) = {
      get: "/v1/events/watch"
    };
  }
}
```

Gateway server setup:

```go
package gateway

import (
    "context"
    "net/http"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/protobuf/encoding/protojson"

    pb "github.com/example/service/gen/streaming/v1"
)

func NewGateway(ctx context.Context, grpcAddr string) (http.Handler, error) {
    mux := runtime.NewServeMux(
        // Use proto field names in JSON (not camelCase)
        runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
            MarshalOptions: protojson.MarshalOptions{
                UseProtoNames:   true,
                EmitUnpopulated: false,
            },
            UnmarshalOptions: protojson.UnmarshalOptions{
                DiscardUnknown: true,
            },
        }),
        // Forward metadata from HTTP headers to gRPC metadata
        runtime.WithIncomingHeaderMatcher(func(s string) (string, bool) {
            switch s {
            case "X-Request-Id", "X-Trace-Id", "Authorization":
                return s, true
            }
            return runtime.DefaultHeaderMatcher(s)
        }),
    )

    opts := []grpc.DialOption{
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    }

    if err := pb.RegisterDataServiceHandlerFromEndpoint(ctx, mux, grpcAddr, opts); err != nil {
        return nil, err
    }
    return mux, nil
}
```

## Testing with grpcurl

```bash
# List available services
grpcurl -plaintext localhost:50051 list

# List methods for a service
grpcurl -plaintext localhost:50051 list streaming.v1.DataService

# Describe a message type
grpcurl -plaintext localhost:50051 describe streaming.v1.Event

# Unary call
grpcurl -plaintext \
  -d '{"id": "record-123"}' \
  localhost:50051 \
  streaming.v1.DataService/GetRecord

# Server-streaming call (grpcurl streams output)
grpcurl -plaintext \
  -d '{"filter": "type=order", "event_types": ["created", "updated"]}' \
  localhost:50051 \
  streaming.v1.DataService/WatchEvents

# Client-streaming call (pipe multiple JSON messages, one per line)
echo '{"record": {"id": "1", "name": "first"}}
{"record": {"id": "2", "name": "second"}}
{"record": {"id": "3", "name": "third"}}' | \
grpcurl -plaintext \
  -d @ \
  localhost:50051 \
  streaming.v1.DataService/UploadRecords

# With authorization header
grpcurl -plaintext \
  -H "authorization: Bearer my-token" \
  -d '{"id": "record-123"}' \
  localhost:50051 \
  streaming.v1.DataService/GetRecord

# With TLS
grpcurl \
  -cert client.crt \
  -key client.key \
  -cacert ca.crt \
  -d '{"id": "record-123"}' \
  localhost:50051 \
  streaming.v1.DataService/GetRecord
```

## gRPC Health Check Protocol

The gRPC health check protocol (grpc.health.v1) is the standard way to expose service health for load balancers and orchestration systems.

```go
package server

import (
    "context"
    "sync"

    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// HealthManager manages health status for multiple gRPC services
type HealthManager struct {
    server *health.Server
    mu     sync.RWMutex
}

func NewHealthManager() *HealthManager {
    return &HealthManager{
        server: health.NewServer(),
    }
}

func (h *HealthManager) Register(grpcServer *grpc.Server) {
    healthpb.RegisterHealthServer(grpcServer, h.server)
}

func (h *HealthManager) SetServing(service string) {
    h.server.SetServingStatus(service, healthpb.HealthCheckResponse_SERVING)
}

func (h *HealthManager) SetNotServing(service string) {
    h.server.SetServingStatus(service, healthpb.HealthCheckResponse_NOT_SERVING)
}

func (h *HealthManager) SetUnknown(service string) {
    h.server.SetServingStatus(service, healthpb.HealthCheckResponse_UNKNOWN)
}

// WatchDependencies monitors dependencies and updates health status
func (h *HealthManager) WatchDependencies(
    ctx context.Context,
    service string,
    checks []func(context.Context) error,
) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            case <-time.After(10 * time.Second):
                allHealthy := true
                for _, check := range checks {
                    if err := check(ctx); err != nil {
                        allHealthy = false
                        break
                    }
                }
                if allHealthy {
                    h.SetServing(service)
                } else {
                    h.SetNotServing(service)
                }
            }
        }
    }()
}
```

Complete server setup integrating all components:

```go
package main

import (
    "context"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "google.golang.org/grpc"
    "log/slog"

    pb "github.com/example/service/gen/streaming/v1"
    "github.com/example/service/internal/gateway"
    "github.com/example/service/internal/interceptors"
    "github.com/example/service/internal/server"
)

func main() {
    ctx, cancel := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer cancel()

    // gRPC server
    grpcServer := grpc.NewServer(
        interceptors.UnaryServerInterceptors(),
        interceptors.StreamServerInterceptors(),
    )

    svc := server.NewDataServiceServer()
    pb.RegisterDataServiceServer(grpcServer, svc)

    healthMgr := server.NewHealthManager()
    healthMgr.Register(grpcServer)
    healthMgr.SetServing("streaming.v1.DataService")

    grpcLis, err := net.Listen("tcp", ":50051")
    if err != nil {
        slog.Error("failed to listen", "error", err)
        os.Exit(1)
    }

    // gRPC-Gateway (HTTP/JSON proxy)
    gwHandler, err := gateway.NewGateway(ctx, "localhost:50051")
    if err != nil {
        slog.Error("failed to create gateway", "error", err)
        os.Exit(1)
    }
    httpServer := &http.Server{
        Addr:    ":8080",
        Handler: gwHandler,
    }

    // Start gRPC server
    go func() {
        slog.Info("gRPC server starting", "addr", ":50051")
        if err := grpcServer.Serve(grpcLis); err != nil {
            slog.Error("gRPC server error", "error", err)
        }
    }()

    // Start HTTP/JSON gateway
    go func() {
        slog.Info("HTTP gateway starting", "addr", ":8080")
        if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
            slog.Error("HTTP gateway error", "error", err)
        }
    }()

    <-ctx.Done()
    slog.Info("shutting down")

    // Graceful shutdown
    grpcServer.GracefulStop()

    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()
    if err := httpServer.Shutdown(shutdownCtx); err != nil {
        slog.Error("HTTP gateway shutdown error", "error", err)
    }

    slog.Info("shutdown complete")
}
```

gRPC streaming provides the performance and protocol richness needed for real-time data feeds, bidirectional interactions, and high-throughput batch operations. The patterns in this guide—flow control tuning, interceptor chains, gateway integration, and standard health check—represent the complete set of production concerns for gRPC services in Kubernetes environments.
