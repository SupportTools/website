---
title: "Go gRPC Streaming: Bidirectional Streams for Real-Time Applications"
date: 2028-12-24T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Streaming", "Real-Time", "Protobuf", "Microservices"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing gRPC streaming in Go, covering server-side, client-side, and bidirectional streaming patterns for real-time data pipelines, telemetry collection, and command-and-control applications."
more_link: "yes"
url: "/go-grpc-streaming-bidirectional-real-time-applications/"
---

gRPC's four call types — unary, server-side streaming, client-side streaming, and bidirectional streaming — are not just protocol variations. They represent fundamentally different concurrency patterns for exchanging data between services. Bidirectional streaming in particular unlocks patterns that are impossible with HTTP/1.1 request-response semantics: a single persistent connection that allows either end to send messages at any time, with backpressure flowing in both directions via HTTP/2 flow control. This post covers production implementation of all three streaming types in Go, with emphasis on the bidirectional case for real-time telemetry, command-and-control, and pub/sub systems.

<!--more-->

## Proto Definition: Four Streaming Patterns

```protobuf
// api/telemetry/v1/telemetry.proto
syntax = "proto3";
package telemetry.v1;
option go_package = "go.support.tools/telemetry/api/telemetry/v1;telemetryv1";

import "google/protobuf/timestamp.proto";

// MetricPoint represents a single time-series data point
message MetricPoint {
  string name = 1;
  double value = 2;
  google.protobuf.Timestamp timestamp = 3;
  map<string, string> labels = 4;
}

// CollectionRequest tells the agent what to collect
message CollectionRequest {
  string agent_id = 1;
  repeated string metric_names = 2;
  int64 interval_seconds = 3;
}

// CollectionResponse is sent by agents in response to requests
message CollectionResponse {
  string agent_id = 1;
  repeated MetricPoint metrics = 2;
  int64 sequence_number = 3;
}

// CommandMessage is sent to agents to execute actions
message CommandMessage {
  string command_id = 1;
  string type = 2;      // "restart", "reconfigure", "collect_now"
  bytes payload = 3;
}

// CommandResult is the agent's response to a command
message CommandResult {
  string command_id = 1;
  bool success = 2;
  string message = 3;
  bytes output = 4;
}

service TelemetryService {
  // Unary: single metric query
  rpc GetMetric(GetMetricRequest) returns (MetricPoint);

  // Server streaming: push metric stream to client
  rpc StreamMetrics(StreamMetricsRequest) returns (stream MetricPoint);

  // Client streaming: agent pushes batch of metrics
  rpc UploadMetrics(stream MetricPoint) returns (UploadSummary);

  // Bidirectional: command-and-control with telemetry feedback
  rpc AgentSession(stream CollectionResponse) returns (stream CollectionRequest);
}

service CommandService {
  // Bidirectional: send commands, receive results
  rpc CommandChannel(stream CommandResult) returns (stream CommandMessage);
}

message GetMetricRequest { string name = 1; }
message StreamMetricsRequest {
  string name = 1;
  int64 interval_ms = 2;
  int64 duration_seconds = 3;
}
message UploadSummary {
  int64 accepted = 1;
  int64 rejected = 2;
  repeated string errors = 3;
}
```

```bash
# Generate Go code
buf generate --template buf.gen.yaml
# or directly:
protoc --go_out=. --go-grpc_out=. \
  --go_opt=paths=source_relative \
  --go-grpc_opt=paths=source_relative \
  api/telemetry/v1/telemetry.proto
```

## Server-Side Streaming Implementation

```go
// internal/telemetry/server.go
package telemetry

import (
    "context"
    "fmt"
    "time"

    "go.uber.org/zap"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    telemetryv1 "go.support.tools/telemetry/api/telemetry/v1"
)

type TelemetryServer struct {
    telemetryv1.UnimplementedTelemetryServiceServer
    collector MetricCollector
    store     MetricStore
    logger    *zap.Logger
}

// StreamMetrics implements server-side streaming.
// The server sends metric data to the client at the requested interval
// until the stream is cancelled or the duration expires.
func (s *TelemetryServer) StreamMetrics(
    req *telemetryv1.StreamMetricsRequest,
    stream telemetryv1.TelemetryService_StreamMetricsServer,
) error {
    if req.Name == "" {
        return status.Error(codes.InvalidArgument, "metric name is required")
    }
    if req.IntervalMs <= 0 {
        req.IntervalMs = 1000
    }

    ctx := stream.Context()
    ticker := time.NewTicker(time.Duration(req.IntervalMs) * time.Millisecond)
    defer ticker.Stop()

    deadline := time.Time{}
    if req.DurationSeconds > 0 {
        deadline = time.Now().Add(time.Duration(req.DurationSeconds) * time.Second)
    }

    s.logger.Info("starting metric stream",
        zap.String("metric", req.Name),
        zap.Int64("interval_ms", req.IntervalMs),
    )

    for {
        select {
        case <-ctx.Done():
            s.logger.Info("stream cancelled by client",
                zap.String("metric", req.Name),
                zap.Error(ctx.Err()),
            )
            return nil

        case t := <-ticker.C:
            if !deadline.IsZero() && t.After(deadline) {
                return nil
            }

            val, err := s.collector.Collect(ctx, req.Name)
            if err != nil {
                s.logger.Error("collection error",
                    zap.String("metric", req.Name),
                    zap.Error(err),
                )
                return status.Errorf(codes.Internal, "collecting %s: %v", req.Name, err)
            }

            point := &telemetryv1.MetricPoint{
                Name:      req.Name,
                Value:     val,
                Timestamp: timestamppb.New(t),
            }

            if err := stream.Send(point); err != nil {
                // Client disconnected or stream errored
                s.logger.Info("stream send error",
                    zap.String("metric", req.Name),
                    zap.Error(err),
                )
                return err
            }
        }
    }
}
```

## Client-Side Streaming Implementation

```go
// internal/telemetry/upload.go

// UploadMetrics implements client-side streaming.
// Agents send batches of metric points; the server batches and stores them.
func (s *TelemetryServer) UploadMetrics(
    stream telemetryv1.TelemetryService_UploadMetricsServer,
) error {
    ctx := stream.Context()

    var (
        accepted int64
        rejected int64
        errs     []string
        batch    []*telemetryv1.MetricPoint
    )

    const batchSize = 100

    flush := func() error {
        if len(batch) == 0 {
            return nil
        }
        if err := s.store.WriteBatch(ctx, batch); err != nil {
            return fmt.Errorf("flushing batch of %d: %w", len(batch), err)
        }
        batch = batch[:0]
        return nil
    }

    for {
        point, err := stream.Recv()
        if err != nil {
            // io.EOF signals the client has finished sending
            if isEOF(err) {
                break
            }
            return status.Errorf(codes.Internal, "receiving metric: %v", err)
        }

        // Validate incoming point
        if point.Name == "" {
            rejected++
            errs = append(errs, fmt.Sprintf("metric at seq has empty name"))
            continue
        }

        batch = append(batch, point)
        accepted++

        if int64(len(batch)) >= batchSize {
            if err := flush(); err != nil {
                return status.Errorf(codes.Internal, "%v", err)
            }
        }
    }

    // Flush remaining
    if err := flush(); err != nil {
        return status.Errorf(codes.Internal, "%v", err)
    }

    return stream.SendAndClose(&telemetryv1.UploadSummary{
        Accepted: accepted,
        Rejected: rejected,
        Errors:   errs,
    })
}

func isEOF(err error) bool {
    return err != nil && err.Error() == "EOF"
}
```

## Bidirectional Streaming: Agent Session

The bidirectional stream enables the server to send collection instructions while simultaneously receiving telemetry data from the agent:

```go
// internal/telemetry/session.go

// AgentSession handles a persistent bidirectional connection with a telemetry agent.
// The server sends CollectionRequests; the agent responds with CollectionResponses.
// This pattern enables dynamic reconfiguration without reconnection.
func (s *TelemetryServer) AgentSession(
    stream telemetryv1.TelemetryService_AgentSessionServer,
) error {
    ctx := stream.Context()

    // Channels for coordinating send and receive goroutines
    recvCh := make(chan *telemetryv1.CollectionResponse, 32)
    sendCh := make(chan *telemetryv1.CollectionRequest, 8)
    errCh  := make(chan error, 2)

    // Goroutine 1: Receive data from agent
    go func() {
        for {
            resp, err := stream.Recv()
            if err != nil {
                errCh <- fmt.Errorf("recv: %w", err)
                return
            }
            select {
            case recvCh <- resp:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Goroutine 2: Send instructions to agent
    go func() {
        for {
            select {
            case req, ok := <-sendCh:
                if !ok {
                    return
                }
                if err := stream.Send(req); err != nil {
                    errCh <- fmt.Errorf("send: %w", err)
                    return
                }
            case <-ctx.Done():
                return
            }
        }
    }()

    // Send initial configuration to agent
    agentID := extractAgentID(ctx)
    initialConfig, err := s.getAgentConfig(ctx, agentID)
    if err != nil {
        return status.Errorf(codes.Internal, "getting agent config: %v", err)
    }

    select {
    case sendCh <- initialConfig:
    case <-ctx.Done():
        return ctx.Err()
    }

    // Watch for config changes and reconfigure agent dynamically
    configUpdates := s.watchAgentConfig(ctx, agentID)

    // Main event loop
    var sequenceExpected int64 = 1
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()

        case err := <-errCh:
            if isEOF(err) {
                s.logger.Info("agent disconnected", zap.String("agent", agentID))
                return nil
            }
            s.logger.Error("stream error",
                zap.String("agent", agentID),
                zap.Error(err),
            )
            return status.Errorf(codes.Internal, "%v", err)

        case resp := <-recvCh:
            // Detect out-of-order or missing responses
            if resp.SequenceNumber != sequenceExpected {
                s.logger.Warn("sequence gap",
                    zap.String("agent", agentID),
                    zap.Int64("expected", sequenceExpected),
                    zap.Int64("got", resp.SequenceNumber),
                )
            }
            sequenceExpected = resp.SequenceNumber + 1

            // Store received metrics
            if err := s.store.WriteBatch(ctx, resp.Metrics); err != nil {
                s.logger.Error("storing metrics", zap.Error(err))
            }

        case newConfig, ok := <-configUpdates:
            if !ok {
                configUpdates = nil
                continue
            }
            s.logger.Info("pushing config update to agent",
                zap.String("agent", agentID),
            )
            select {
            case sendCh <- newConfig:
            default:
                s.logger.Warn("send channel full, dropping config update",
                    zap.String("agent", agentID),
                )
            }
        }
    }
}
```

## Client Implementation: Bidirectional Stream Consumer

```go
// cmd/agent/main.go
package main

import (
    "context"
    "fmt"
    "math/rand"
    "sync/atomic"
    "time"

    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/protobuf/types/known/timestamppb"

    telemetryv1 "go.support.tools/telemetry/api/telemetry/v1"
)

type Agent struct {
    client     telemetryv1.TelemetryServiceClient
    agentID    string
    collectors map[string]MetricCollector
    logger     *zap.Logger
}

func (a *Agent) RunSession(ctx context.Context) error {
    stream, err := a.client.AgentSession(ctx)
    if err != nil {
        return fmt.Errorf("opening session: %w", err)
    }

    var seq atomic.Int64
    collectionCh := make(chan *telemetryv1.CollectionRequest, 4)
    errCh := make(chan error, 2)

    // Goroutine: receive instructions from server
    go func() {
        for {
            req, err := stream.Recv()
            if err != nil {
                errCh <- fmt.Errorf("recv: %w", err)
                return
            }
            select {
            case collectionCh <- req:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Wait for initial config
    var currentConfig *telemetryv1.CollectionRequest
    select {
    case cfg := <-collectionCh:
        currentConfig = cfg
        a.logger.Info("received initial config",
            zap.Strings("metrics", cfg.MetricNames),
            zap.Int64("interval_s", cfg.IntervalSeconds),
        )
    case err := <-errCh:
        return fmt.Errorf("waiting for config: %w", err)
    case <-ctx.Done():
        return ctx.Err()
    }

    ticker := time.NewTicker(time.Duration(currentConfig.IntervalSeconds) * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()

        case err := <-errCh:
            return fmt.Errorf("session error: %w", err)

        // Reconfiguration from server
        case newConfig := <-collectionCh:
            currentConfig = newConfig
            ticker.Reset(time.Duration(newConfig.IntervalSeconds) * time.Second)
            a.logger.Info("reconfigured",
                zap.Strings("metrics", newConfig.MetricNames),
                zap.Int64("interval_s", newConfig.IntervalSeconds),
            )

        case <-ticker.C:
            metrics, err := a.collectMetrics(ctx, currentConfig)
            if err != nil {
                a.logger.Error("collection error", zap.Error(err))
                continue
            }

            seqNum := seq.Add(1)
            resp := &telemetryv1.CollectionResponse{
                AgentId:        a.agentID,
                Metrics:        metrics,
                SequenceNumber: seqNum,
            }

            if err := stream.Send(resp); err != nil {
                return fmt.Errorf("sending metrics: %w", err)
            }
        }
    }
}

func (a *Agent) collectMetrics(
    ctx context.Context,
    cfg *telemetryv1.CollectionRequest,
) ([]*telemetryv1.MetricPoint, error) {
    now := time.Now()
    points := make([]*telemetryv1.MetricPoint, 0, len(cfg.MetricNames))

    for _, name := range cfg.MetricNames {
        collector, ok := a.collectors[name]
        if !ok {
            continue
        }
        val, err := collector.Collect(ctx)
        if err != nil {
            a.logger.Warn("metric collection error",
                zap.String("metric", name),
                zap.Error(err),
            )
            continue
        }
        points = append(points, &telemetryv1.MetricPoint{
            Name:      name,
            Value:     val,
            Timestamp: timestamppb.New(now),
            Labels: map[string]string{
                "agent_id": a.agentID,
                "host":     "node-42.prod.example.com",
            },
        })
    }

    return points, nil
}
```

## gRPC Connection Management

```go
// pkg/grpc/client.go
package grpcutil

import (
    "context"
    "crypto/tls"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/backoff"
    "google.golang.org/grpc/credentials"
    "google.golang.org/grpc/keepalive"
)

// NewClientConn creates a production-ready gRPC client connection
// with TLS, keepalives, retry backoff, and observability interceptors.
func NewClientConn(ctx context.Context, target string) (*grpc.ClientConn, error) {
    tlsConfig := &tls.Config{
        MinVersion: tls.VersionTLS13,
    }

    opts := []grpc.DialOption{
        grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),

        // Keepalive: ping server every 30s, expect pong within 10s
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                30 * time.Second,
            Timeout:             10 * time.Second,
            PermitWithoutStream: true,
        }),

        // Connection backoff for reconnects
        grpc.WithConnectParams(grpc.ConnectParams{
            Backoff: backoff.Config{
                BaseDelay:  500 * time.Millisecond,
                Multiplier: 1.5,
                Jitter:     0.2,
                MaxDelay:   30 * time.Second,
            },
            MinConnectTimeout: 10 * time.Second,
        }),

        // Interceptor chain: tracing → metrics → retry → logging
        grpc.WithChainUnaryInterceptor(
            otelgrpc.UnaryClientInterceptor(),
            grpcprom.UnaryClientInterceptor,
            retryUnaryInterceptor(3),
        ),
        grpc.WithChainStreamInterceptor(
            otelgrpc.StreamClientInterceptor(),
            grpcprom.StreamClientInterceptor,
        ),

        // Initial window size for flow control (4MB default is low for bulk transfers)
        grpc.WithInitialWindowSize(4 * 1024 * 1024),
        grpc.WithInitialConnWindowSize(16 * 1024 * 1024),
    }

    return grpc.DialContext(ctx, target, opts...)
}
```

## Flow Control and Backpressure

HTTP/2 flow control is the backbone of gRPC backpressure. When a receiver's flow control window fills, the sender blocks. Tuning these values is critical for high-throughput streams:

```go
// Server-side: tune window sizes for bulk telemetry ingestion
serverOpts := []grpc.ServerOption{
    grpc.InitialWindowSize(4 * 1024 * 1024),      // 4MB per-stream
    grpc.InitialConnWindowSize(64 * 1024 * 1024), // 64MB per-connection

    // Limit concurrent streams to prevent memory exhaustion
    grpc.MaxConcurrentStreams(1000),

    // Limit message sizes
    grpc.MaxRecvMsgSize(16 * 1024 * 1024),  // 16MB receive
    grpc.MaxSendMsgSize(16 * 1024 * 1024),  // 16MB send

    // Keepalive enforcement on server side
    grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
        MinTime:             5 * time.Second,
        PermitWithoutStream: true,
    }),
    grpc.KeepaliveParams(keepalive.ServerParameters{
        MaxConnectionIdle:     15 * time.Minute,
        MaxConnectionAge:      30 * time.Minute,
        MaxConnectionAgeGrace: 5 * time.Minute,
        Time:                  5 * time.Minute,
        Timeout:               1 * time.Minute,
    }),
}
```

## Graceful Stream Shutdown

```go
// Graceful shutdown for the bidirectional stream server
func (s *TelemetryServer) shutdown(ctx context.Context) error {
    // Signal all active sessions to finish
    s.mu.Lock()
    sessions := make([]*Session, 0, len(s.sessions))
    for _, sess := range s.sessions {
        sessions = append(sessions, sess)
    }
    s.mu.Unlock()

    // Send shutdown notification to all connected agents
    shutdownMsg := &telemetryv1.CollectionRequest{
        AgentId:         "server",
        MetricNames:     nil,
        IntervalSeconds: -1, // Sentinel: agent should disconnect
    }

    for _, sess := range sessions {
        select {
        case sess.sendCh <- shutdownMsg:
        case <-time.After(2 * time.Second):
            s.logger.Warn("timeout sending shutdown to agent",
                zap.String("agent", sess.agentID),
            )
        }
    }

    // Wait for sessions to close with deadline
    deadline := time.Now().Add(30 * time.Second)
    for _, sess := range sessions {
        remaining := time.Until(deadline)
        if remaining <= 0 {
            break
        }
        select {
        case <-sess.done:
        case <-time.After(remaining):
            s.logger.Warn("session did not close gracefully",
                zap.String("agent", sess.agentID),
            )
        }
    }

    return nil
}
```

## Testing gRPC Streams

```go
// internal/telemetry/server_test.go
package telemetry_test

import (
    "context"
    "io"
    "net"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/test/bufconn"

    telemetryv1 "go.support.tools/telemetry/api/telemetry/v1"
    "go.support.tools/telemetry/internal/telemetry"
)

const bufSize = 1024 * 1024

func setupTestServer(t *testing.T) telemetryv1.TelemetryServiceClient {
    t.Helper()

    lis := bufconn.Listen(bufSize)
    srv := grpc.NewServer()

    collector := &StubCollector{values: map[string]float64{
        "cpu.usage": 45.2,
        "mem.used":  72.1,
    }}
    store := NewInMemoryStore()
    logger := zaptest.NewLogger(t)

    telemetryv1.RegisterTelemetryServiceServer(srv,
        telemetry.NewTelemetryServer(collector, store, logger),
    )

    go func() {
        if err := srv.Serve(lis); err != nil {
            t.Logf("test server error: %v", err)
        }
    }()
    t.Cleanup(srv.GracefulStop)

    conn, err := grpc.DialContext(context.Background(), "bufnet",
        grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
            return lis.DialContext(ctx)
        }),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    require.NoError(t, err)
    t.Cleanup(func() { conn.Close() })

    return telemetryv1.NewTelemetryServiceClient(conn)
}

func TestStreamMetrics_ReceivesPoints(t *testing.T) {
    client := setupTestServer(t)

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    stream, err := client.StreamMetrics(ctx, &telemetryv1.StreamMetricsRequest{
        Name:            "cpu.usage",
        IntervalMs:      100,
        DurationSeconds: 2,
    })
    require.NoError(t, err)

    var received []*telemetryv1.MetricPoint
    for {
        point, err := stream.Recv()
        if err == io.EOF {
            break
        }
        require.NoError(t, err)
        received = append(received, point)
    }

    assert.GreaterOrEqual(t, len(received), 15, "expected at least 15 points in 2s at 100ms interval")
    assert.Equal(t, "cpu.usage", received[0].Name)
    assert.InDelta(t, 45.2, received[0].Value, 0.001)
}
```

Bidirectional gRPC streaming in Go requires careful goroutine coordination, explicit flow control tuning, and well-defined lifecycle management for graceful shutdown. The patterns shown here — receive-in-goroutine plus send-via-channel, connection pooling, keepalive configuration, and the bufconn test harness — form a solid foundation for production telemetry collection, command dispatch, and real-time data pipeline systems.
