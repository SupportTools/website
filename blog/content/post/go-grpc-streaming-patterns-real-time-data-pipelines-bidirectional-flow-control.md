---
title: "Go: gRPC Streaming Patterns for Real-Time Data Pipelines Including Bidirectional Streaming and Flow Control"
date: 2031-06-22T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Streaming", "Data Pipelines", "Protobuf", "Real-Time", "Microservices"]
categories:
- Go
- Microservices
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to gRPC streaming in Go covering server-side, client-side, and bidirectional streaming patterns, flow control, error handling, reconnection logic, and observability for real-time data pipelines."
more_link: "yes"
url: "/go-grpc-streaming-patterns-real-time-data-pipelines-bidirectional-flow-control/"
---

gRPC's streaming capabilities make it the right tool for any scenario where data must flow continuously between services: telemetry ingestion, live analytics, event broadcasting, command dispatch, and interactive protocols. Unlike REST with polling, gRPC streams maintain a single long-lived connection with protocol-level framing, backpressure, and flow control built in. The result is lower latency, lower overhead, and cleaner application code than any polling-based alternative.

This guide covers all three gRPC streaming modes in Go — server-side, client-side, and bidirectional — along with the production concerns that are rarely covered in basic tutorials: flow control, graceful shutdown, reconnection with exponential backoff, error propagation across stream boundaries, and distributed tracing integration.

<!--more-->

# Go: gRPC Streaming Patterns for Real-Time Data Pipelines Including Bidirectional Streaming and Flow Control

## Proto Definitions

The streaming mode is determined by the `stream` keyword in the proto definition:

```protobuf
// pipeline.proto
syntax = "proto3";

package pipeline.v1;

option go_package = "github.com/your-org/pipeline/gen/pipeline/v1;pipelinev1";

import "google/protobuf/timestamp.proto";

// --- Messages ---

message Event {
  string event_id = 1;
  string source = 2;
  string event_type = 3;
  bytes payload = 4;
  google.protobuf.Timestamp occurred_at = 5;
  map<string, string> metadata = 6;
}

message ProcessingResult {
  string event_id = 1;
  string status = 2;          // "processed", "skipped", "failed"
  string error_message = 3;
  int64 processing_time_us = 4;
}

message SubscribeRequest {
  repeated string topics = 1;
  string consumer_group = 2;
  google.protobuf.Timestamp from_timestamp = 3;
}

message AckRequest {
  string event_id = 1;
  bool   nack = 2;
  string nack_reason = 3;
}

message MetricsRequest {
  string service_name = 1;
  int32  interval_seconds = 2;
}

message MetricsSnapshot {
  google.protobuf.Timestamp collected_at = 1;
  double cpu_percent = 2;
  uint64 memory_bytes = 3;
  uint64 goroutine_count = 4;
  map<string, double> counters = 5;
}

// --- Service ---

service PipelineService {
  // Server streaming: client requests, server streams responses
  rpc Subscribe(SubscribeRequest) returns (stream Event);

  // Client streaming: client streams events, server returns summary
  rpc Ingest(stream Event) returns (ProcessingResult);

  // Bidirectional streaming: client sends ack/nack, server streams events
  rpc Process(stream AckRequest) returns (stream Event);

  // Server streaming: live metrics feed
  rpc StreamMetrics(MetricsRequest) returns (stream MetricsSnapshot);
}
```

Generate Go code:

```bash
buf generate
# or
protoc \
  --go_out=. --go_opt=paths=source_relative \
  --go-grpc_out=. --go-grpc_opt=paths=source_relative \
  pipeline.proto
```

## Server Implementation

### Server-Side Streaming: Subscribe

The server streams events to the client indefinitely until the client cancels or the server closes:

```go
// internal/service/pipeline_server.go
package service

import (
	"context"
	"fmt"
	"time"

	pipelinev1 "github.com/your-org/pipeline/gen/pipeline/v1"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type PipelineServer struct {
	pipelinev1.UnimplementedPipelineServiceServer
	broker  EventBroker
	tracer  trace.Tracer
}

func (s *PipelineServer) Subscribe(
	req *pipelinev1.SubscribeRequest,
	stream pipelinev1.PipelineService_SubscribeServer,
) error {
	ctx := stream.Context()

	// Validate request
	if len(req.Topics) == 0 {
		return status.Error(codes.InvalidArgument, "at least one topic is required")
	}
	if req.ConsumerGroup == "" {
		return status.Error(codes.InvalidArgument, "consumer_group is required")
	}

	// Subscribe to the broker
	ch, cancel, err := s.broker.Subscribe(ctx, req.Topics, req.ConsumerGroup)
	if err != nil {
		return status.Errorf(codes.Internal, "broker subscription failed: %v", err)
	}
	defer cancel()

	var sentCount int64

	for {
		select {
		case <-ctx.Done():
			// Client disconnected or RPC cancelled
			return status.Errorf(codes.Canceled, "stream cancelled after %d events", sentCount)

		case event, ok := <-ch:
			if !ok {
				// Broker closed the channel (graceful shutdown)
				return nil
			}

			// Send to client
			if err := stream.Send(event); err != nil {
				// Client may have disconnected
				return status.Errorf(codes.Unavailable,
					"send failed after %d events: %v", sentCount, err)
			}
			sentCount++
		}
	}
}
```

### Client-Side Streaming: Ingest

The client streams a batch of events; the server processes them and returns a single summary:

```go
func (s *PipelineServer) Ingest(
	stream pipelinev1.PipelineService_IngestServer,
) error {
	ctx := stream.Context()

	var (
		processed int64
		failed    int64
		firstErr  string
	)

	start := time.Now()

	for {
		event, err := stream.Recv()
		if err != nil {
			// io.EOF signals the client is done sending
			if isEOF(err) {
				break
			}
			return status.Errorf(codes.Internal, "receiving event: %v", err)
		}

		// Process each event
		if procErr := s.processEvent(ctx, event); procErr != nil {
			failed++
			if firstErr == "" {
				firstErr = procErr.Error()
			}
		} else {
			processed++
		}
	}

	// Send single response after all events received
	result := &pipelinev1.ProcessingResult{
		EventId:          fmt.Sprintf("batch-%d", time.Now().UnixNano()),
		Status:           "processed",
		ProcessingTimeUs: time.Since(start).Microseconds(),
	}

	if failed > 0 {
		result.Status = "partial_failure"
		result.ErrorMessage = fmt.Sprintf(
			"%d/%d failed; first error: %s",
			failed, processed+failed, firstErr,
		)
	}

	return stream.SendAndClose(result)
}

func isEOF(err error) bool {
	if err == nil {
		return false
	}
	// gRPC wraps io.EOF
	st, ok := status.FromError(err)
	if !ok {
		return err.Error() == "EOF"
	}
	return st.Code() == codes.OK
}
```

### Bidirectional Streaming: Process

The bidirectional stream is the most powerful and complex pattern. The client sends acknowledgements; the server sends events:

```go
func (s *PipelineServer) Process(
	stream pipelinev1.PipelineService_ProcessServer,
) error {
	ctx := stream.Context()

	// Channel for acks from client
	ackCh := make(chan *pipelinev1.AckRequest, 128)
	errCh := make(chan error, 1)

	// Goroutine: receive acks from client
	go func() {
		for {
			ack, err := stream.Recv()
			if err != nil {
				if isEOF(err) {
					close(ackCh)
					return
				}
				errCh <- fmt.Errorf("recv ack: %w", err)
				return
			}
			select {
			case ackCh <- ack:
			case <-ctx.Done():
				return
			}
		}
	}()

	// Subscribe to event broker
	eventCh, cancel, err := s.broker.Subscribe(ctx, []string{"all"}, "processor")
	if err != nil {
		return status.Errorf(codes.Internal, "broker subscribe: %v", err)
	}
	defer cancel()

	// Track in-flight events waiting for ack
	inflight := make(map[string]time.Time)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return status.FromContextError(ctx.Err()).Err()

		case err := <-errCh:
			return status.Errorf(codes.Internal, "stream error: %v", err)

		case ack, ok := <-ackCh:
			if !ok {
				// Client closed send side — drain remaining events
				return nil
			}
			delete(inflight, ack.EventId)
			if ack.Nack {
				// Re-queue the event for reprocessing
				s.broker.Nack(ctx, ack.EventId, ack.NackReason)
			} else {
				s.broker.Ack(ctx, ack.EventId)
			}

		case event, ok := <-eventCh:
			if !ok {
				return nil
			}

			// Apply flow control: limit in-flight events
			if len(inflight) >= 1000 {
				// Pause delivery to apply backpressure
				time.Sleep(10 * time.Millisecond)
				continue
			}

			if err := stream.Send(event); err != nil {
				return status.Errorf(codes.Unavailable, "send event: %v", err)
			}
			inflight[event.EventId] = time.Now()

		case <-ticker.C:
			// Detect stalled acks (events in-flight > 30s without ack)
			now := time.Now()
			for id, sentAt := range inflight {
				if now.Sub(sentAt) > 30*time.Second {
					s.broker.Nack(ctx, id, "ack timeout")
					delete(inflight, id)
				}
			}
		}
	}
}
```

## Client Implementation

### Server-Side Streaming Client

```go
// internal/client/pipeline_client.go
package client

import (
	"context"
	"fmt"
	"io"
	"time"

	pipelinev1 "github.com/your-org/pipeline/gen/pipeline/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/status"
)

type PipelineClient struct {
	conn   *grpc.ClientConn
	client pipelinev1.PipelineServiceClient
}

func NewPipelineClient(target string) (*PipelineClient, error) {
	conn, err := grpc.NewClient(target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second, // Ping after 30s idle
			Timeout:             10 * time.Second, // Wait 10s for pong
			PermitWithoutStream: true,
		}),
		grpc.WithDefaultCallOptions(
			// Unlimited message sizes for streaming
			grpc.MaxCallRecvMsgSize(64*1024*1024), // 64MB
			grpc.MaxCallSendMsgSize(64*1024*1024),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("dialing %s: %w", target, err)
	}

	return &PipelineClient{
		conn:   conn,
		client: pipelinev1.NewPipelineServiceClient(conn),
	}, nil
}

// SubscribeWithReconnect subscribes to events with automatic reconnection on failures.
func (c *PipelineClient) SubscribeWithReconnect(
	ctx context.Context,
	req *pipelinev1.SubscribeRequest,
	handler func(*pipelinev1.Event) error,
) error {
	backoff := newExponentialBackoff(
		100*time.Millisecond,
		30*time.Second,
		2.0,
		0.2, // 20% jitter
	)

	for {
		err := c.subscribe(ctx, req, handler)
		if err == nil {
			return nil // Clean shutdown
		}

		// Don't retry on context cancellation
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Check if error is retryable
		st, _ := status.FromError(err)
		switch st.Code() {
		case codes.Unavailable, codes.ResourceExhausted, codes.DeadlineExceeded:
			// Retryable
		case codes.PermissionDenied, codes.Unauthenticated, codes.InvalidArgument:
			return err // Not retryable
		}

		delay := backoff.Next()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
			// Retry
		}
	}
}

func (c *PipelineClient) subscribe(
	ctx context.Context,
	req *pipelinev1.SubscribeRequest,
	handler func(*pipelinev1.Event) error,
) error {
	stream, err := c.client.Subscribe(ctx, req)
	if err != nil {
		return fmt.Errorf("opening stream: %w", err)
	}

	for {
		event, err := stream.Recv()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("receiving event: %w", err)
		}

		if err := handler(event); err != nil {
			return fmt.Errorf("handling event %s: %w", event.EventId, err)
		}
	}
}
```

### Client-Side Streaming: Bulk Ingest

```go
// IngestBatch streams a slice of events to the server in a single RPC.
func (c *PipelineClient) IngestBatch(
	ctx context.Context,
	events []*pipelinev1.Event,
) (*pipelinev1.ProcessingResult, error) {
	stream, err := c.client.Ingest(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening ingest stream: %w", err)
	}

	// Send events with rate limiting
	limiter := rate.NewLimiter(rate.Limit(10000), 1000) // 10K/s burst 1K

	for _, event := range events {
		if err := limiter.Wait(ctx); err != nil {
			_ = stream.CloseSend()
			return nil, fmt.Errorf("rate limiter: %w", err)
		}

		if err := stream.Send(event); err != nil {
			return nil, fmt.Errorf("sending event %s: %w", event.EventId, err)
		}
	}

	// Signal end of client stream and get result
	result, err := stream.CloseAndRecv()
	if err != nil {
		return nil, fmt.Errorf("closing stream: %w", err)
	}

	return result, nil
}

// IngestChannel reads from a channel and streams to server.
// This pattern is ideal for piping events from another source.
func (c *PipelineClient) IngestChannel(
	ctx context.Context,
	events <-chan *pipelinev1.Event,
) (*pipelinev1.ProcessingResult, error) {
	stream, err := c.client.Ingest(ctx)
	if err != nil {
		return nil, err
	}

	for {
		select {
		case <-ctx.Done():
			_ = stream.CloseSend()
			return nil, ctx.Err()

		case event, ok := <-events:
			if !ok {
				// Channel closed — finish
				return stream.CloseAndRecv()
			}
			if err := stream.Send(event); err != nil {
				return nil, fmt.Errorf("send: %w", err)
			}
		}
	}
}
```

### Bidirectional Streaming Client

```go
// ProcessWithAck establishes a bidirectional stream, processes events,
// and sends acknowledgements after each successful handler call.
func (c *PipelineClient) ProcessWithAck(
	ctx context.Context,
	handler func(context.Context, *pipelinev1.Event) error,
) error {
	stream, err := c.client.Process(ctx)
	if err != nil {
		return fmt.Errorf("opening process stream: %w", err)
	}

	// Send initial greeting (some protocols require this)
	if err := stream.Send(&pipelinev1.AckRequest{
		EventId: "init",
	}); err != nil {
		return fmt.Errorf("sending init ack: %w", err)
	}

	// Receive events and send acks
	for {
		event, err := stream.Recv()
		if err != nil {
			if err == io.EOF {
				return stream.CloseSend()
			}
			return fmt.Errorf("recv: %w", err)
		}

		// Process with timeout
		procCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		handlerErr := handler(procCtx, event)
		cancel()

		ack := &pipelinev1.AckRequest{
			EventId: event.EventId,
		}

		if handlerErr != nil {
			ack.Nack = true
			ack.NackReason = handlerErr.Error()
		}

		if err := stream.Send(ack); err != nil {
			return fmt.Errorf("sending ack for %s: %w", event.EventId, err)
		}
	}
}
```

## Flow Control

gRPC uses HTTP/2 flow control. Understanding the window sizes is critical for tuning throughput:

### Server-Side Flow Control

```go
// Configure gRPC server with tuned flow control parameters
grpcServer := grpc.NewServer(
	// Initial connection-level flow control window
	grpc.InitialConnWindowSize(1 << 24),     // 16MB
	// Initial stream-level flow control window
	grpc.InitialWindowSize(1 << 23),         // 8MB
	// Maximum number of concurrent streams per connection
	grpc.MaxConcurrentStreams(1000),
	// Maximum message size
	grpc.MaxRecvMsgSize(64 << 20),           // 64MB
	grpc.MaxSendMsgSize(64 << 20),

	// Keepalive for detecting dead clients
	grpc.KeepaliveParams(keepalive.ServerParameters{
		MaxConnectionIdle:     30 * time.Second,
		MaxConnectionAge:      300 * time.Second,
		MaxConnectionAgeGrace: 30 * time.Second,
		Time:                  10 * time.Second,
		Timeout:               5 * time.Second,
	}),
	grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
		MinTime:             5 * time.Second,
		PermitWithoutStream: true,
	}),
)
```

### Application-Level Backpressure

```go
// TokenBucket implements a simple application-level backpressure mechanism
// when the HTTP/2 flow control window is not sufficient.

type streamSender struct {
	stream     pipelinev1.PipelineService_SubscribeServer
	semaphore  chan struct{}  // Limits in-flight sends
	bufferFull int64         // Atomic counter for monitoring
}

func newStreamSender(stream pipelinev1.PipelineService_SubscribeServer, maxInFlight int) *streamSender {
	sem := make(chan struct{}, maxInFlight)
	for i := 0; i < maxInFlight; i++ {
		sem <- struct{}{}
	}
	return &streamSender{
		stream:    stream,
		semaphore: sem,
	}
}

func (s *streamSender) Send(ctx context.Context, event *pipelinev1.Event) error {
	// Acquire token (backpressure)
	select {
	case <-s.semaphore:
	case <-ctx.Done():
		return ctx.Err()
	}

	if err := s.stream.Send(event); err != nil {
		s.semaphore <- struct{}{} // Return token on failure
		return err
	}

	// Release token after send completes (non-blocking)
	go func() { s.semaphore <- struct{}{} }()
	return nil
}
```

## Error Handling and Status Codes

gRPC error handling requires using `status` package — not Go errors:

```go
// server: return typed gRPC errors
func (s *PipelineServer) Subscribe(
	req *pipelinev1.SubscribeRequest,
	stream pipelinev1.PipelineService_SubscribeServer,
) error {
	// Attach structured error details
	st := status.New(codes.Internal, "broker unavailable")
	st, _ = st.WithDetails(&errdetails.ErrorInfo{
		Reason: "BROKER_DOWN",
		Domain: "pipeline.example.com",
		Metadata: map[string]string{
			"broker_address": "kafka-0:9092",
			"retry_after":    "30s",
		},
	})
	return st.Err()
}

// client: extract error details
func handleStreamError(err error) {
	st, ok := status.FromError(err)
	if !ok {
		log.Printf("non-gRPC error: %v", err)
		return
	}

	switch st.Code() {
	case codes.Canceled:
		log.Println("stream cancelled by client")
	case codes.Unavailable:
		log.Printf("server unavailable: %s — will retry", st.Message())
		for _, detail := range st.Details() {
			switch d := detail.(type) {
			case *errdetails.ErrorInfo:
				log.Printf("  reason: %s, retry_after: %s",
					d.Reason, d.Metadata["retry_after"])
			}
		}
	case codes.ResourceExhausted:
		log.Printf("rate limited: %s", st.Message())
	case codes.InvalidArgument:
		log.Printf("invalid request (not retryable): %s", st.Message())
	default:
		log.Printf("gRPC error %s: %s", st.Code(), st.Message())
	}
}
```

## Exponential Backoff Implementation

```go
// pkg/retry/backoff.go
package retry

import (
	"math"
	"math/rand"
	"time"
)

type ExponentialBackoff struct {
	initial    time.Duration
	max        time.Duration
	multiplier float64
	jitter     float64
	attempt    int
}

func NewExponentialBackoff(initial, max time.Duration, multiplier, jitter float64) *ExponentialBackoff {
	return &ExponentialBackoff{
		initial:    initial,
		max:        max,
		multiplier: multiplier,
		jitter:     jitter,
	}
}

func (b *ExponentialBackoff) Next() time.Duration {
	delay := float64(b.initial) * math.Pow(b.multiplier, float64(b.attempt))
	if delay > float64(b.max) {
		delay = float64(b.max)
	}

	// Add random jitter to avoid thundering herd
	jitterRange := delay * b.jitter
	delay += (rand.Float64()*2 - 1) * jitterRange

	b.attempt++
	return time.Duration(delay)
}

func (b *ExponentialBackoff) Reset() {
	b.attempt = 0
}
```

## Graceful Shutdown

```go
// main.go
func main() {
	// ... setup

	grpcServer := grpc.NewServer(
		grpc.UnaryInterceptor(/* ... */),
		grpc.StreamInterceptor(/* ... */),
	)
	pipelinev1.RegisterPipelineServiceServer(grpcServer, svc)

	// Listen
	lis, err := net.Listen("tcp", ":9090")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	go func() {
		if err := grpcServer.Serve(lis); err != nil {
			log.Printf("grpc serve: %v", err)
		}
	}()

	// Wait for signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("shutting down gRPC server...")

	// GracefulStop waits for in-flight RPCs to complete (up to a timeout)
	stopped := make(chan struct{})
	go func() {
		grpcServer.GracefulStop()
		close(stopped)
	}()

	timeout := time.NewTimer(30 * time.Second)
	select {
	case <-stopped:
		log.Println("gRPC server stopped gracefully")
	case <-timeout.C:
		log.Println("graceful stop timed out — forcing stop")
		grpcServer.Stop()
	}
}
```

## Interceptors for Cross-Cutting Concerns

### Logging and Tracing Interceptor

```go
// internal/interceptor/logging.go
package interceptor

func StreamLoggingInterceptor(logger *slog.Logger) grpc.StreamServerInterceptor {
	return func(
		srv interface{},
		stream grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		start := time.Now()

		// Extract peer info
		peer, _ := peer.FromContext(stream.Context())

		wrapped := &wrappedStream{
			ServerStream: stream,
			logger:       logger,
			method:       info.FullMethod,
		}

		err := handler(srv, wrapped)

		duration := time.Since(start)
		code := status.Code(err)

		logger.Info("stream rpc completed",
			"method", info.FullMethod,
			"code", code.String(),
			"duration_ms", duration.Milliseconds(),
			"peer", peer.Addr.String(),
			"messages_sent", wrapped.sentCount,
			"messages_recv", wrapped.recvCount,
			"error", err,
		)

		return err
	}
}

type wrappedStream struct {
	grpc.ServerStream
	logger     *slog.Logger
	method     string
	sentCount  int64
	recvCount  int64
}

func (w *wrappedStream) SendMsg(m interface{}) error {
	err := w.ServerStream.SendMsg(m)
	if err == nil {
		atomic.AddInt64(&w.sentCount, 1)
	}
	return err
}

func (w *wrappedStream) RecvMsg(m interface{}) error {
	err := w.ServerStream.RecvMsg(m)
	if err == nil {
		atomic.AddInt64(&w.recvCount, 1)
	}
	return err
}
```

### Rate Limiting Interceptor

```go
// internal/interceptor/ratelimit.go
package interceptor

func StreamRateLimitInterceptor(rps float64) grpc.StreamServerInterceptor {
	limiter := rate.NewLimiter(rate.Limit(rps), int(rps))

	return func(
		srv interface{},
		stream grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		ctx := stream.Context()

		if !limiter.Allow() {
			return status.Errorf(codes.ResourceExhausted,
				"rate limit exceeded for %s", info.FullMethod)
		}

		return handler(srv, stream)
	}
}
```

## Live Metrics Streaming Example

A complete, practical example showing server-side streaming for live metrics:

```go
func (s *PipelineServer) StreamMetrics(
	req *pipelinev1.MetricsRequest,
	stream pipelinev1.PipelineService_StreamMetricsServer,
) error {
	ctx := stream.Context()

	interval := time.Duration(req.IntervalSeconds) * time.Second
	if interval < time.Second {
		interval = time.Second
	}
	if interval > time.Minute {
		interval = time.Minute
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil

		case t := <-ticker.C:
			var memStats runtime.MemStats
			runtime.ReadMemStats(&memStats)

			snapshot := &pipelinev1.MetricsSnapshot{
				CollectedAt:    timestamppb.New(t),
				CpuPercent:     getCPUPercent(),
				MemoryBytes:    memStats.Alloc,
				GoroutineCount: uint64(runtime.NumGoroutine()),
				Counters: map[string]float64{
					"gc_runs":    float64(memStats.NumGC),
					"heap_objs":  float64(memStats.HeapObjects),
					"gc_pause_ms": float64(memStats.PauseTotalNs) / 1e6,
				},
			}

			if err := stream.Send(snapshot); err != nil {
				return status.Errorf(codes.Unavailable, "send metrics: %v", err)
			}
		}
	}
}
```

## Testing Streaming RPCs

```go
// internal/service/pipeline_server_test.go
package service_test

import (
	"context"
	"testing"
	"time"

	pipelinev1 "github.com/your-org/pipeline/gen/pipeline/v1"
	"github.com/your-org/pipeline/internal/service"
	"google.golang.org/grpc"
	"google.golang.org/grpc/test/bufconn"
	"net"
)

const bufSize = 1 << 20 // 1MB

func TestSubscribe_ReceivesEvents(t *testing.T) {
	lis := bufconn.Listen(bufSize)

	srv := grpc.NewServer()
	pipelinev1.RegisterPipelineServiceServer(srv, &service.PipelineServer{
		broker: newFakeBroker(t, 5), // Will publish 5 events
	})

	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	client := pipelinev1.NewPipelineServiceClient(conn)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stream, err := client.Subscribe(ctx, &pipelinev1.SubscribeRequest{
		Topics:        []string{"test"},
		ConsumerGroup: "test-consumer",
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	var received int
	for {
		_, err := stream.Recv()
		if err != nil {
			break
		}
		received++
	}

	if received != 5 {
		t.Errorf("expected 5 events, got %d", received)
	}
}
```

## Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pipeline-server
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: pipeline-server
  template:
    spec:
      containers:
        - name: pipeline-server
          image: your-registry/pipeline-server:latest
          ports:
            - containerPort: 9090
              name: grpc
              protocol: TCP
          env:
            - name: MAX_CONCURRENT_STREAMS
              value: "1000"
            - name: KEEPALIVE_TIME
              value: "30s"
          resources:
            requests:
              cpu: "1"
              memory: "512Mi"
            limits:
              cpu: "4"
              memory: "2Gi"

          # Graceful shutdown
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]
          terminationGracePeriodSeconds: 60
---
apiVersion: v1
kind: Service
metadata:
  name: pipeline-server
  namespace: production
  annotations:
    # AWS NLB for gRPC (ALB requires gRPC protocol setting)
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
spec:
  selector:
    app: pipeline-server
  ports:
    - port: 9090
      targetPort: 9090
      name: grpc
  type: LoadBalancer
```

gRPC streaming in Go provides the foundation for building low-latency, high-throughput data pipelines. The bidirectional streaming pattern with application-level acks and flow control is the right model for reliable event delivery. Combined with reconnection logic, proper gRPC status codes, and graceful shutdown, these patterns produce systems that handle both normal operation and failure conditions without data loss.
