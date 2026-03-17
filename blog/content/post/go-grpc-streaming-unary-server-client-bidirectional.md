---
title: "Go gRPC Streaming: Unary, Server, Client, and Bidirectional"
date: 2029-06-08T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Streaming", "Protobuf", "Microservices", "Performance"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to all four gRPC communication patterns in Go: stream type comparison, flow control, stream multiplexing, error handling, keepalive tuning, and load balancing strategies for production deployments."
more_link: "yes"
url: "/go-grpc-streaming-unary-server-client-bidirectional/"
---

gRPC's four communication patterns — unary, server streaming, client streaming, and bidirectional streaming — each solve distinct problems. Choosing the wrong pattern leads to unnecessary complexity, poor performance, or incorrect semantics. This guide walks through each pattern with production-quality Go code, then covers the operational concerns that trip up teams in production: flow control, keepalive, multiplexing limits, and load balancing with long-lived streams.

<!--more-->

# Go gRPC Streaming: Unary, Server, Client, and Bidirectional

## The Four gRPC Communication Patterns

Before writing any code, it is worth understanding what problem each pattern solves:

| Pattern | Request | Response | Use case |
|---|---|---|---|
| Unary | Single message | Single message | Request/response API calls |
| Server streaming | Single message | Stream of messages | Large result sets, live feeds |
| Client streaming | Stream of messages | Single message | File uploads, aggregation |
| Bidirectional streaming | Stream of messages | Stream of messages | Chat, real-time collaboration, gaming |

Each pattern maps directly to a Protobuf service definition using the `stream` keyword.

## Protobuf Service Definitions

```protobuf
// streaming.proto
syntax = "proto3";
package streaming.v1;

option go_package = "github.com/example/streaming/gen/streaming/v1;streamingv1";

// Unary RPC
service DataService {
  // Unary: single request, single response
  rpc GetRecord(GetRecordRequest) returns (GetRecordResponse);

  // Server streaming: single request, stream of responses
  rpc ListRecords(ListRecordsRequest) returns (stream Record);

  // Client streaming: stream of requests, single response
  rpc CreateRecords(stream CreateRecordRequest) returns (CreateRecordsResponse);

  // Bidirectional streaming: stream of requests, stream of responses
  rpc SyncRecords(stream SyncRequest) returns (stream SyncResponse);
}

message GetRecordRequest  { string id = 1; }
message GetRecordResponse { Record record = 1; }

message ListRecordsRequest {
  string filter     = 1;
  int32  page_size  = 2;
}

message CreateRecordRequest {
  string key   = 1;
  bytes  value = 2;
}

message CreateRecordsResponse {
  int64 created = 1;
  int64 failed  = 2;
}

message SyncRequest {
  oneof payload {
    Subscribe   subscribe   = 1;
    Acknowledge acknowledge = 2;
  }
}

message SyncResponse {
  string event_id = 1;
  bytes  data     = 2;
}

message Record {
  string id        = 1;
  string key       = 2;
  bytes  value     = 3;
  int64  timestamp = 4;
}

message Subscribe   { string topic = 1; repeated string keys = 2; }
message Acknowledge { string event_id = 1; }
```

Generate the Go bindings:

```bash
buf generate
# or with protoc directly:
protoc \
  --go_out=gen \
  --go-grpc_out=gen \
  --go_opt=paths=source_relative \
  --go-grpc_opt=paths=source_relative \
  streaming.proto
```

## Pattern 1: Unary RPC

Unary is the simplest pattern and should be your default choice unless you have a specific reason to use streaming.

### Server Implementation

```go
package server

import (
    "context"
    "fmt"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    pb "github.com/example/streaming/gen/streaming/v1"
)

type DataServer struct {
    pb.UnimplementedDataServiceServer
    store RecordStore
}

func (s *DataServer) GetRecord(ctx context.Context, req *pb.GetRecordRequest) (*pb.GetRecordResponse, error) {
    // Validate input early
    if req.GetId() == "" {
        return nil, status.Error(codes.InvalidArgument, "id is required")
    }

    // Always check context cancellation before expensive operations
    if err := ctx.Err(); err != nil {
        return nil, status.FromContextError(err).Err()
    }

    record, err := s.store.Get(ctx, req.Id)
    if err != nil {
        if isNotFound(err) {
            return nil, status.Errorf(codes.NotFound, "record %q not found", req.Id)
        }
        return nil, status.Errorf(codes.Internal, "store lookup failed: %v", err)
    }

    return &pb.GetRecordResponse{Record: toProto(record)}, nil
}
```

### Client Usage

```go
package client

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"

    pb "github.com/example/streaming/gen/streaming/v1"
)

func GetRecord(id string) (*pb.Record, error) {
    conn, err := grpc.NewClient(
        "localhost:9090",
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return nil, fmt.Errorf("dial: %w", err)
    }
    defer conn.Close()

    client := pb.NewDataServiceClient(conn)

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    resp, err := client.GetRecord(ctx, &pb.GetRecordRequest{Id: id})
    if err != nil {
        return nil, fmt.Errorf("GetRecord: %w", err)
    }
    return resp.Record, nil
}
```

## Pattern 2: Server-Side Streaming

Server streaming is ideal for large result sets, live event feeds, or any scenario where the server needs to push multiple messages after a single request.

### Server Implementation

```go
func (s *DataServer) ListRecords(req *pb.ListRecordsRequest, stream pb.DataService_ListRecordsServer) error {
    ctx := stream.Context()

    cursor, err := s.store.Query(ctx, req.Filter)
    if err != nil {
        return status.Errorf(codes.Internal, "query failed: %v", err)
    }
    defer cursor.Close()

    pageSize := int(req.GetPageSize())
    if pageSize <= 0 || pageSize > 1000 {
        pageSize = 100
    }

    sent := 0
    for cursor.Next(ctx) {
        // Critical: check context on each iteration
        if err := ctx.Err(); err != nil {
            return status.FromContextError(err).Err()
        }

        record := cursor.Record()
        if err := stream.Send(toProto(record)); err != nil {
            // Send returns io.EOF or a status error when the client disconnects
            return err
        }
        sent++

        // Demonstrate flow-control-aware batching
        if sent%pageSize == 0 {
            // Optional: yield after a batch to allow flow control to take effect
            // The gRPC runtime handles actual backpressure automatically via HTTP/2 flow control
        }
    }

    if err := cursor.Err(); err != nil {
        return status.Errorf(codes.Internal, "cursor error: %v", err)
    }
    return nil // returning nil closes the stream with OK status
}
```

### Client Consumption

```go
func ListAllRecords(filter string) ([]*pb.Record, error) {
    // ... connection setup omitted for brevity

    stream, err := client.ListRecords(ctx, &pb.ListRecordsRequest{
        Filter:   filter,
        PageSize: 100,
    })
    if err != nil {
        return nil, fmt.Errorf("ListRecords: %w", err)
    }

    var records []*pb.Record
    for {
        record, err := stream.Recv()
        if err == io.EOF {
            break // server closed the stream normally
        }
        if err != nil {
            // Decode the gRPC status for better error handling
            st, _ := status.FromError(err)
            return nil, fmt.Errorf("stream recv [%s]: %s", st.Code(), st.Message())
        }
        records = append(records, record)
    }
    return records, nil
}
```

### Streaming with Backpressure

The gRPC runtime uses HTTP/2 flow control windows to apply backpressure automatically. However, a slow consumer can still cause the server-side goroutine to block on `Send`. Structure your server to handle this gracefully:

```go
func (s *DataServer) ListRecords(req *pb.ListRecordsRequest, stream pb.DataService_ListRecordsServer) error {
    ctx := stream.Context()
    ch := make(chan *pb.Record, 64) // buffered channel decouples producer from sender

    // Producer goroutine
    g, gctx := errgroup.WithContext(ctx)
    g.Go(func() error {
        defer close(ch)
        cursor, err := s.store.Query(gctx, req.Filter)
        if err != nil {
            return err
        }
        defer cursor.Close()
        for cursor.Next(gctx) {
            select {
            case ch <- toProto(cursor.Record()):
            case <-gctx.Done():
                return gctx.Err()
            }
        }
        return cursor.Err()
    })

    // Sender goroutine (this is the main goroutine, keeps stream.Send serial)
    for record := range ch {
        if err := stream.Send(record); err != nil {
            g.Wait() // ensure producer is cleaned up
            return err
        }
    }

    return g.Wait()
}
```

## Pattern 3: Client-Side Streaming

Client streaming is the right choice for bulk uploads, aggregation operations, or when the client generates data faster than individual RPCs could handle.

### Server Implementation

```go
func (s *DataServer) CreateRecords(stream pb.DataService_CreateRecordsServer) error {
    ctx := stream.Context()
    var created, failed int64

    for {
        req, err := stream.Recv()
        if err == io.EOF {
            // Client finished sending; send the summary response
            return stream.SendAndClose(&pb.CreateRecordsResponse{
                Created: created,
                Failed:  failed,
            })
        }
        if err != nil {
            return err
        }

        if err := ctx.Err(); err != nil {
            return status.FromContextError(err).Err()
        }

        if err := s.store.Put(ctx, req.Key, req.Value); err != nil {
            failed++
            // Log and continue rather than aborting the stream
            log.Printf("WARN store.Put key=%q: %v", req.Key, err)
        } else {
            created++
        }
    }
}
```

### Batching in Client Streaming

For maximum throughput, batch writes on the server side:

```go
func (s *DataServer) CreateRecords(stream pb.DataService_CreateRecordsServer) error {
    ctx := stream.Context()
    const batchSize = 256
    batch := make([]*storeEntry, 0, batchSize)
    var created, failed int64

    flush := func() error {
        if len(batch) == 0 {
            return nil
        }
        results, err := s.store.BatchPut(ctx, batch)
        if err != nil {
            return err
        }
        for _, r := range results {
            if r.Err != nil {
                failed++
            } else {
                created++
            }
        }
        batch = batch[:0]
        return nil
    }

    for {
        req, err := stream.Recv()
        if err == io.EOF {
            if err := flush(); err != nil {
                return status.Errorf(codes.Internal, "final flush: %v", err)
            }
            return stream.SendAndClose(&pb.CreateRecordsResponse{
                Created: created,
                Failed:  failed,
            })
        }
        if err != nil {
            return err
        }

        batch = append(batch, &storeEntry{Key: req.Key, Value: req.Value})
        if len(batch) >= batchSize {
            if err := flush(); err != nil {
                return status.Errorf(codes.Internal, "batch flush: %v", err)
            }
        }
    }
}
```

### Client-Side Streaming Usage

```go
func BulkCreate(entries []Entry) (*pb.CreateRecordsResponse, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    stream, err := client.CreateRecords(ctx)
    if err != nil {
        return nil, fmt.Errorf("CreateRecords stream: %w", err)
    }

    for _, e := range entries {
        if err := stream.Send(&pb.CreateRecordRequest{
            Key:   e.Key,
            Value: e.Value,
        }); err != nil {
            return nil, fmt.Errorf("stream send: %w", err)
        }
    }

    resp, err := stream.CloseAndRecv()
    if err != nil {
        return nil, fmt.Errorf("CloseAndRecv: %w", err)
    }
    return resp, nil
}
```

## Pattern 4: Bidirectional Streaming

Bidirectional streaming is the most flexible and complex pattern. It is appropriate for real-time collaboration, pub/sub systems, and interactive protocols where the client and server communicate asynchronously.

### Server Implementation

The key insight: `stream.Send` and `stream.Recv` can be called concurrently from different goroutines on the same stream.

```go
func (s *DataServer) SyncRecords(stream pb.DataService_SyncRecordsServer) error {
    ctx := stream.Context()
    g, gctx := errgroup.WithContext(ctx)

    // Receiver goroutine: reads client requests
    subscriptions := make(chan subscribeCmd, 8)
    acks := make(chan string, 64)

    g.Go(func() error {
        defer close(subscriptions)
        defer close(acks)
        for {
            req, err := stream.Recv()
            if err == io.EOF {
                return nil
            }
            if err != nil {
                return err
            }
            switch p := req.Payload.(type) {
            case *pb.SyncRequest_Subscribe:
                select {
                case subscriptions <- subscribeCmd{
                    Topic: p.Subscribe.Topic,
                    Keys:  p.Subscribe.Keys,
                }:
                case <-gctx.Done():
                    return gctx.Err()
                }
            case *pb.SyncRequest_Acknowledge:
                select {
                case acks <- p.Acknowledge.EventId:
                case <-gctx.Done():
                    return gctx.Err()
                }
            }
        }
    })

    // Sender goroutine: pushes events to client
    g.Go(func() error {
        sub, err := s.eventBus.Subscribe(gctx, subscriptions)
        if err != nil {
            return err
        }
        defer sub.Close()

        for {
            select {
            case event, ok := <-sub.Events():
                if !ok {
                    return nil
                }
                if err := stream.Send(&pb.SyncResponse{
                    EventId: event.ID,
                    Data:    event.Data,
                }); err != nil {
                    return err
                }
            case ack := <-acks:
                s.eventBus.Acknowledge(gctx, ack)
            case <-gctx.Done():
                return gctx.Err()
            }
        }
    })

    return g.Wait()
}
```

### Client Bidirectional Streaming

```go
func SyncClient(topics []string) error {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    stream, err := client.SyncRecords(ctx)
    if err != nil {
        return fmt.Errorf("SyncRecords: %w", err)
    }

    // Subscribe to topics first
    for _, topic := range topics {
        if err := stream.Send(&pb.SyncRequest{
            Payload: &pb.SyncRequest_Subscribe{
                Subscribe: &pb.Subscribe{Topic: topic},
            },
        }); err != nil {
            return fmt.Errorf("subscribe %q: %w", topic, err)
        }
    }

    // Receive events
    for {
        resp, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return fmt.Errorf("recv: %w", err)
        }

        processEvent(resp)

        // Acknowledge
        if err := stream.Send(&pb.SyncRequest{
            Payload: &pb.SyncRequest_Acknowledge{
                Acknowledge: &pb.Acknowledge{EventId: resp.EventId},
            },
        }); err != nil {
            return fmt.Errorf("ack %q: %w", resp.EventId, err)
        }
    }
}
```

## Flow Control and Stream Multiplexing

gRPC streams run over HTTP/2 connections. HTTP/2 provides two levels of flow control:

1. **Connection-level**: shared window across all streams on a connection
2. **Stream-level**: per-stream window

```go
// Configure flow control on the server
server := grpc.NewServer(
    grpc.InitialWindowSize(1 << 20),       // 1 MiB per stream (default 64 KiB)
    grpc.InitialConnWindowSize(1 << 23),   // 8 MiB per connection (default 64 KiB)
    grpc.MaxConcurrentStreams(250),         // HTTP/2 SETTINGS_MAX_CONCURRENT_STREAMS
    grpc.MaxRecvMsgSize(16 * 1024 * 1024), // 16 MiB max message size
    grpc.MaxSendMsgSize(16 * 1024 * 1024),
)

// Configure on the client
conn, err := grpc.NewClient(
    addr,
    grpc.WithInitialWindowSize(1<<20),
    grpc.WithInitialConnWindowSize(1<<23),
    grpc.WithDefaultCallOptions(
        grpc.MaxCallRecvMsgSize(16*1024*1024),
        grpc.MaxCallSendMsgSize(16*1024*1024),
    ),
)
```

### Understanding Stream Multiplexing

Multiple gRPC streams share a single TCP connection. This means:

- One slow stream does not block others (head-of-line blocking is eliminated)
- Total throughput is bounded by connection-level flow control
- `MaxConcurrentStreams` on the server is enforced per HTTP/2 connection, not globally

```go
// Monitor active streams with a custom interceptor
func streamCountInterceptor(
    srv interface{},
    ss grpc.ServerStream,
    info *grpc.StreamServerInfo,
    handler grpc.StreamHandler,
) error {
    activeStreams.Inc()
    defer activeStreams.Dec()

    start := time.Now()
    err := handler(srv, ss)
    duration := time.Since(start)

    code := codes.OK
    if err != nil {
        st, _ := status.FromError(err)
        code = st.Code()
    }
    streamDuration.WithLabelValues(info.FullMethod, code.String()).Observe(duration.Seconds())
    return err
}
```

## Error Handling in Streams

Error handling in streams differs from unary RPCs because errors can occur mid-stream.

### Server-Side Error Propagation

```go
func (s *DataServer) ListRecords(req *pb.ListRecordsRequest, stream pb.DataService_ListRecordsServer) error {
    ctx := stream.Context()

    cursor, err := s.store.Query(ctx, req.Filter)
    if err != nil {
        // This becomes a trailer status on the stream
        return status.Errorf(codes.Internal, "failed to open cursor: %v", err)
    }
    defer cursor.Close()

    for cursor.Next(ctx) {
        if err := stream.Send(toProto(cursor.Record())); err != nil {
            // Client disconnected or flow control timeout
            // Do NOT wrap this error — return it as-is
            return err
        }
    }

    if err := cursor.Err(); err != nil {
        // Error after partial stream: client receives all messages sent so far,
        // then receives this error status in the trailer
        return status.Errorf(codes.DataLoss, "cursor failed mid-stream: %v", err)
    }
    return nil
}
```

### Client-Side Error Handling

```go
func consumeStream(stream pb.DataService_ListRecordsClient) error {
    for {
        record, err := stream.Recv()
        if err == io.EOF {
            return nil // Clean close
        }
        if err != nil {
            st := status.Convert(err)
            switch st.Code() {
            case codes.Canceled:
                // Context was canceled — expected, not an error
                return nil
            case codes.DeadlineExceeded:
                return fmt.Errorf("stream timed out after receiving partial data")
            case codes.Unavailable:
                // Transient: server restarting, retry with backoff
                return fmt.Errorf("server unavailable: %w", err)
            case codes.DataLoss:
                // Partial stream — log and decide whether to retry from scratch
                return fmt.Errorf("partial stream data loss: %s", st.Message())
            default:
                return fmt.Errorf("stream error [%s]: %s", st.Code(), st.Message())
            }
        }
        _ = record
    }
}
```

### Retry Logic for Streaming

Unlike unary RPCs, streaming retries are more complex because partial data may have been received:

```go
func ListWithRetry(ctx context.Context, client pb.DataServiceClient, filter string) ([]*pb.Record, error) {
    var lastErr error
    for attempt := 0; attempt < 3; attempt++ {
        if attempt > 0 {
            wait := time.Duration(1<<attempt) * 100 * time.Millisecond
            select {
            case <-time.After(wait):
            case <-ctx.Done():
                return nil, ctx.Err()
            }
        }

        records, err := doList(ctx, client, filter)
        if err == nil {
            return records, nil
        }

        st := status.Convert(err)
        if !isRetryable(st.Code()) {
            return nil, err // Don't retry permanent errors
        }
        lastErr = err
    }
    return nil, fmt.Errorf("exhausted retries: %w", lastErr)
}

func isRetryable(c codes.Code) bool {
    switch c {
    case codes.Unavailable, codes.ResourceExhausted:
        return true
    default:
        return false
    }
}
```

## Keepalive Configuration

Long-lived streams require keepalive to detect dead connections. Without keepalive, a client may wait indefinitely for messages that will never arrive because the TCP connection has silently failed.

### Server Keepalive

```go
import "google.golang.org/grpc/keepalive"

serverParams := keepalive.ServerParameters{
    // Send a PING frame to the client after this duration of inactivity
    Time: 2 * time.Minute,
    // Wait this long for the client to respond to a PING
    Timeout: 20 * time.Second,
    // Allow clients to send keepalive PINGs even without active streams
    // (required when using connection pools that hold idle connections)
    MaxConnectionIdle: 15 * time.Minute,
    // Gracefully close connections that have been alive this long
    MaxConnectionAge: 30 * time.Minute,
    // Give active RPCs this long to finish after MaxConnectionAge
    MaxConnectionAgeGrace: 5 * time.Minute,
}

enforcementPolicy := keepalive.EnforcementPolicy{
    // Minimum interval between PINGs from clients
    MinTime: 5 * time.Second,
    // Allow clients to send PINGs even without active streams
    PermitWithoutStream: true,
}

server := grpc.NewServer(
    grpc.KeepaliveParams(serverParams),
    grpc.KeepaliveEnforcementPolicy(enforcementPolicy),
)
```

### Client Keepalive

```go
clientParams := keepalive.ClientParameters{
    // Send PINGs after this duration of inactivity
    Time: 30 * time.Second,
    // Wait this long for PING ack
    Timeout: 10 * time.Second,
    // Send PINGs even without active streams
    PermitWithoutStream: true,
}

conn, err := grpc.NewClient(
    addr,
    grpc.WithKeepaliveParams(clientParams),
    grpc.WithTransportCredentials(insecure.NewCredentials()),
)
```

## Load Balancing with Long-Lived Streams

Streaming RPCs create a fundamental tension with load balancing: a stream is pinned to one server for its entire lifetime, so simple round-robin connection selection under-distributes load.

### The Problem

```
Client <──stream1──> Server A  (handling 100 concurrent streams)
Client <──stream2──> Server A
Client <──stream3──> Server A
...
Server B  (idle)
```

### Solution 1: gRPC Client-Side Load Balancing

```go
// Use the round_robin policy for stream establishment
// Each new stream goes to the next server, spreading load at stream creation time
conn, err := grpc.NewClient(
    "dns:///grpc-service.namespace.svc.cluster.local:9090",
    grpc.WithDefaultServiceConfig(`{
        "loadBalancingPolicy": "round_robin",
        "methodConfig": [{
            "name": [{"service": "streaming.v1.DataService"}],
            "waitForReady": true,
            "retryPolicy": {
                "maxAttempts": 3,
                "initialBackoff": "0.1s",
                "maxBackoff": "1s",
                "backoffMultiplier": 2,
                "retryableStatusCodes": ["UNAVAILABLE"]
            }
        }]
    }`),
    grpc.WithTransportCredentials(insecure.NewCredentials()),
)
```

### Solution 2: Envoy or a Service Mesh

For Kubernetes deployments, routing streaming gRPC through Envoy (via Istio or a standalone proxy) provides HTTP/2-aware load balancing at the stream level:

```yaml
# Envoy virtual host configuration for gRPC
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: grpc-service
spec:
  http:
  - match:
    - headers:
        content-type:
          prefix: application/grpc
    route:
    - destination:
        host: grpc-service
        port:
          number: 9090
```

### Solution 3: Limit Stream Duration

Long-lived streams accumulate on the servers that were available when the stream started. Enforce a maximum stream duration and have clients reconnect periodically:

```go
func (s *DataServer) SyncRecords(stream pb.DataService_SyncRecordsServer) error {
    // Enforce maximum stream lifetime
    ctx, cancel := context.WithTimeout(stream.Context(), 10*time.Minute)
    defer cancel()

    // Replace stream context (wrap the stream to use the deadline context)
    wrappedStream := &contextStream{ServerStream: stream, ctx: ctx}
    return s.doSync(wrappedStream)
}

type contextStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (cs *contextStream) Context() context.Context { return cs.ctx }
```

## Interceptors for Streams

Stream interceptors differ from unary interceptors: you wrap the stream object rather than handling the full RPC in a function.

```go
// Logging interceptor for server-side streams
func loggingStreamInterceptor(
    srv interface{},
    ss grpc.ServerStream,
    info *grpc.StreamServerInfo,
    handler grpc.StreamHandler,
) error {
    start := time.Now()
    peer, _ := peer.FromContext(ss.Context())

    log.Printf("stream start method=%s peer=%s", info.FullMethod, peer.Addr)

    // Wrap the stream to intercept Send/Recv calls
    ws := &wrappedStream{ServerStream: ss}
    err := handler(srv, ws)

    code := codes.OK
    if err != nil {
        st, _ := status.FromError(err)
        code = st.Code()
    }

    log.Printf("stream end method=%s peer=%s duration=%s msgs_sent=%d msgs_recv=%d code=%s",
        info.FullMethod, peer.Addr, time.Since(start),
        ws.sentCount, ws.recvCount, code)

    return err
}

type wrappedStream struct {
    grpc.ServerStream
    sentCount int64
    recvCount int64
}

func (ws *wrappedStream) Send(m proto.Message) error {
    ws.sentCount++
    return ws.ServerStream.SendMsg(m)
}

func (ws *wrappedStream) Recv(m proto.Message) error {
    ws.recvCount++
    return ws.ServerStream.RecvMsg(m)
}
```

## Monitoring and Observability

Use `go-grpc-prometheus` or OpenTelemetry for stream metrics:

```go
import grpcprom "github.com/grpc-ecosystem/go-grpc-prometheus"

// Enable histogram metrics for stream durations
grpcprom.EnableHandlingTimeHistogram()

server := grpc.NewServer(
    grpc.StreamInterceptor(grpcprom.StreamServerInterceptor),
    grpc.UnaryInterceptor(grpcprom.UnaryServerInterceptor),
)
grpcprom.Register(server)

// Prometheus metrics available:
// grpc_server_started_total{grpc_method, grpc_service, grpc_type}
// grpc_server_handled_total{grpc_code, grpc_method, grpc_service, grpc_type}
// grpc_server_msg_received_total{grpc_method, grpc_service, grpc_type}
// grpc_server_msg_sent_total{grpc_method, grpc_service, grpc_type}
// grpc_server_handling_seconds_bucket{...}
```

## Choosing the Right Pattern

```
Need to upload data → Client streaming
    ↓
Is the upload size < 4 MiB? → Unary with large payload (simpler)
    ↓
Need to push results → Server streaming
    ↓
Are results > 1000 items or unbounded? → Server streaming (required)
    ↓ otherwise
Unary (simpler, easier to retry)
    ↓
Need real-time interactivity? → Bidirectional streaming
    ↓
Is the interaction request/response-like? → Multiple unary calls (simpler)
```

When in doubt, start with unary RPCs. They are easier to implement, test, retry, and load balance. Graduate to streaming when you hit concrete performance or functionality limitations.

## Summary

gRPC's four communication patterns map to distinct use cases. Unary remains the default for most service-to-service calls. Server streaming handles large result sets and live feeds. Client streaming enables efficient bulk ingestion. Bidirectional streaming supports real-time interactive protocols.

The operational considerations — flow control window sizing, keepalive tuning, maximum stream durations, and service-mesh-aware load balancing — are often more important than the initial pattern selection. Configure keepalive on both sides, size flow control windows for your message sizes, and enforce stream lifetime limits to prevent stale streams from accumulating on specific servers.
