---
title: "Go gRPC Streaming: Server-Side, Client-Side, and Bidirectional Streams with Backpressure"
date: 2028-07-23T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Streaming", "Protobuf", "Performance"]
categories:
- Go
- gRPC
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing all three gRPC streaming patterns in Go — server-side, client-side, and bidirectional — with production backpressure handling, flow control, and error recovery."
more_link: "yes"
url: "/go-grpc-streaming-patterns-guide-production/"
---

gRPC streaming is one of the most powerful features available in modern RPC frameworks, enabling long-lived connections, real-time data push, and high-throughput batch processing patterns that are impossible with simple request-response semantics. However, getting streaming right in production requires more than just following the happy path from the official documentation. Backpressure, flow control, connection reuse, and graceful shutdown are all concerns that will surface quickly once your service starts carrying real traffic.

This guide covers all three gRPC streaming modes in Go — server-side streaming, client-side streaming, and bidirectional streaming — with real-world production patterns for backpressure handling, error recovery, and observability.

<!--more-->

# Go gRPC Streaming: Production Patterns

## The Streaming Landscape

Before diving into implementation, it helps to understand when each pattern is appropriate:

- **Server-side streaming**: The client sends one request, the server sends back a stream of responses. Useful for real-time event feeds, log tailing, or paginated result sets.
- **Client-side streaming**: The client sends a stream of requests, the server sends one response. Useful for bulk uploads, batch processing, or aggregation.
- **Bidirectional streaming**: Both sides send independent streams. Useful for chat, collaborative editing, or reactive control planes.

All three patterns share the same underlying HTTP/2 transport, which means they automatically get flow control, multiplexing, and stream-level error isolation.

## Protobuf Service Definition

Start with a single proto file that covers all three streaming modes:

```protobuf
syntax = "proto3";

package streaming.v1;

option go_package = "github.com/example/streaming/v1;streamingv1";

// EventService demonstrates all three streaming patterns.
service EventService {
  // ServerStream: client sends one request, server streams responses
  rpc Subscribe(SubscribeRequest) returns (stream Event);

  // ClientStream: client streams requests, server sends one response
  rpc Publish(stream PublishRequest) returns (PublishResponse);

  // BidiStream: both sides stream independently
  rpc Exchange(stream ExchangeMessage) returns (stream ExchangeMessage);
}

message SubscribeRequest {
  string topic          = 1;
  int64  from_offset    = 2;
  Filter filter         = 3;
}

message Filter {
  repeated string event_types = 1;
  map<string, string> labels  = 2;
}

message Event {
  string   id         = 1;
  string   type       = 2;
  bytes    payload    = 3;
  int64    offset     = 4;
  int64    timestamp  = 5;
  map<string, string> metadata = 6;
}

message PublishRequest {
  string topic   = 1;
  bytes  payload = 2;
  map<string, string> metadata = 3;
}

message PublishResponse {
  int64 messages_accepted = 1;
  int64 messages_rejected = 2;
  repeated string errors  = 3;
}

message ExchangeMessage {
  string    id      = 1;
  bytes     payload = 2;
  string    ack_id  = 3;  // acknowledgment of a previously received message
  bool      eof     = 4;  // graceful close signal
}
```

Generate the Go code:

```bash
# Install the required plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Generate
protoc \
  --go_out=. \
  --go_opt=paths=source_relative \
  --go-grpc_out=. \
  --go-grpc_opt=paths=source_relative \
  proto/streaming/v1/streaming.proto
```

## Module Setup and Dependencies

```bash
go mod init github.com/example/streaming
go get google.golang.org/grpc@latest
go get google.golang.org/protobuf@latest
go get github.com/prometheus/client_golang/prometheus@latest
go get go.uber.org/zap@latest
```

## Section 1: Server-Side Streaming with Backpressure

Server-side streaming is conceptually simple but hides a critical production concern: the gRPC transport buffers writes internally. If your server produces events faster than the client can consume them, those buffers grow until either memory is exhausted or the connection is dropped. Proper backpressure requires monitoring the send buffer and slowing or pausing production when the client is not keeping up.

### The Event Source

```go
// internal/eventsource/source.go
package eventsource

import (
	"context"
	"sync"
	"time"
)

// EventSource is a simple in-memory pub/sub event source for demonstration.
type EventSource struct {
	mu          sync.RWMutex
	subscribers map[string][]chan *Event
}

type Event struct {
	ID        string
	Type      string
	Payload   []byte
	Offset    int64
	Timestamp time.Time
	Metadata  map[string]string
}

func New() *EventSource {
	return &EventSource{
		subscribers: make(map[string][]chan *Event),
	}
}

func (es *EventSource) Subscribe(topic string, bufSize int) (ch <-chan *Event, unsub func()) {
	ch2 := make(chan *Event, bufSize)
	es.mu.Lock()
	es.subscribers[topic] = append(es.subscribers[topic], ch2)
	es.mu.Unlock()

	unsub = func() {
		es.mu.Lock()
		defer es.mu.Unlock()
		subs := es.subscribers[topic]
		for i, s := range subs {
			if s == ch2 {
				es.subscribers[topic] = append(subs[:i], subs[i+1:]...)
				close(ch2)
				return
			}
		}
	}
	return ch2, unsub
}

func (es *EventSource) Publish(topic string, event *Event) int {
	es.mu.RLock()
	defer es.mu.RUnlock()

	delivered := 0
	for _, ch := range es.subscribers[topic] {
		select {
		case ch <- event:
			delivered++
		default:
			// subscriber is slow; drop or record metrics
		}
	}
	return delivered
}
```

### Server Implementation with Backpressure

```go
// internal/server/server.go
package server

import (
	"context"
	"fmt"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/example/streaming/v1"
	"github.com/example/streaming/internal/eventsource"
	"github.com/example/streaming/internal/metrics"
)

const (
	// subscriberBufferSize is the number of events to buffer per subscriber
	// before applying backpressure.
	subscriberBufferSize = 256

	// sendTimeout is the maximum time to wait for a single Send call to
	// complete before treating the client as stalled.
	sendTimeout = 5 * time.Second

	// stallCheckInterval controls how often we poll for client staleness.
	stallCheckInterval = 500 * time.Millisecond
)

type EventServer struct {
	pb.UnimplementedEventServiceServer
	source  *eventsource.EventSource
	log     *zap.Logger
	metrics *metrics.StreamMetrics
}

func NewEventServer(
	src *eventsource.EventSource,
	log *zap.Logger,
	m *metrics.StreamMetrics,
) *EventServer {
	return &EventServer{source: src, log: log, metrics: m}
}

// Subscribe implements server-side streaming with backpressure handling.
func (s *EventServer) Subscribe(
	req *pb.SubscribeRequest,
	stream pb.EventService_SubscribeServer,
) error {
	ctx := stream.Context()
	log := s.log.With(zap.String("topic", req.Topic))

	log.Info("subscriber connected")
	s.metrics.ActiveSubscribers.Inc()
	defer s.metrics.ActiveSubscribers.Dec()

	// Subscribe to the event source with a local buffer.
	eventCh, unsub := s.source.Subscribe(req.Topic, subscriberBufferSize)
	defer unsub()

	// sendWithTimeout wraps stream.Send with a timeout to detect stalled clients.
	sendWithTimeout := func(event *pb.Event) error {
		done := make(chan error, 1)
		go func() {
			done <- stream.Send(event)
		}()

		select {
		case err := <-done:
			return err
		case <-time.After(sendTimeout):
			return status.Errorf(codes.DeadlineExceeded,
				"client did not consume event within %s", sendTimeout)
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	// Backpressure ticker: periodically check if the local buffer is filling up.
	stallTicker := time.NewTicker(stallCheckInterval)
	defer stallTicker.Stop()

	var consecutiveSlowSends int

	for {
		select {
		case <-ctx.Done():
			log.Info("subscriber disconnected", zap.Error(ctx.Err()))
			return status.FromContextError(ctx.Err()).Err()

		case event, ok := <-eventCh:
			if !ok {
				// Channel closed; source is shutting down.
				return nil
			}

			pbEvent := convertEvent(event)

			start := time.Now()
			if err := sendWithTimeout(pbEvent); err != nil {
				s.metrics.SendErrors.Inc()
				log.Warn("send failed", zap.Error(err))
				return err
			}

			latency := time.Since(start)
			s.metrics.SendLatency.Observe(latency.Seconds())

			// Adaptive backpressure: if sends are consistently slow,
			// log a warning. In a real system you might also signal the
			// producer to slow down.
			if latency > sendTimeout/2 {
				consecutiveSlowSends++
				if consecutiveSlowSends >= 3 {
					log.Warn("client consistently slow, backpressure active",
						zap.Int("consecutive_slow", consecutiveSlowSends))
				}
			} else {
				consecutiveSlowSends = 0
			}

		case <-stallTicker.C:
			// Check how full the subscriber's local buffer is.
			bufLen := len(eventCh)
			bufCap := cap(eventCh)
			fillPct := float64(bufLen) / float64(bufCap) * 100
			s.metrics.SubscriberBufferFill.Observe(fillPct)

			if fillPct > 80 {
				log.Warn("subscriber buffer nearly full",
					zap.Float64("fill_pct", fillPct),
					zap.Int("buffered", bufLen),
				)
			}
		}
	}
}

func convertEvent(e *eventsource.Event) *pb.Event {
	return &pb.Event{
		Id:        e.ID,
		Type:      e.Type,
		Payload:   e.Payload,
		Offset:    e.Offset,
		Timestamp: e.Timestamp.UnixMilli(),
		Metadata:  e.Metadata,
	}
}
```

### Client-Side Consumer

```go
// cmd/subscriber/main.go
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"

	pb "github.com/example/streaming/v1"
)

func main() {
	conn, err := grpc.NewClient(
		"localhost:9090",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
	)
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	client := pb.NewEventServiceClient(conn)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stream, err := client.Subscribe(ctx, &pb.SubscribeRequest{
		Topic: "orders",
	})
	if err != nil {
		log.Fatalf("subscribe: %v", err)
	}

	for {
		event, err := stream.Recv()
		if err == io.EOF {
			log.Println("stream closed by server")
			return
		}
		if err != nil {
			log.Fatalf("recv: %v", err)
		}

		// Simulate slow consumer — this is what causes backpressure on the server.
		time.Sleep(50 * time.Millisecond)
		fmt.Printf("received event id=%s type=%s\n", event.Id, event.Type)
	}
}
```

## Section 2: Client-Side Streaming

Client-side streaming inverts the flow: the client sends many messages, the server accumulates them and returns a single response. This pattern is ideal for bulk ingest pipelines.

```go
// Publish implements client-side streaming with validation and rate tracking.
func (s *EventServer) Publish(stream pb.EventService_PublishServer) error {
	ctx := stream.Context()
	log := s.log

	var (
		accepted int64
		rejected int64
		errs     []string
	)

	// Receive all messages from the client stream.
	for {
		req, err := stream.Recv()
		if err == io.EOF {
			// Client has finished sending; send the summary response.
			return stream.SendAndClose(&pb.PublishResponse{
				MessagesAccepted: accepted,
				MessagesRejected: rejected,
				Errors:           errs,
			})
		}
		if err != nil {
			return status.Errorf(codes.Internal, "recv: %v", err)
		}

		// Check for client cancellation mid-stream.
		select {
		case <-ctx.Done():
			return status.FromContextError(ctx.Err()).Err()
		default:
		}

		// Validate the incoming message.
		if err := validatePublishRequest(req); err != nil {
			rejected++
			errs = append(errs, err.Error())
			continue
		}

		// Forward to the event source.
		n := s.source.Publish(req.Topic, &eventsource.Event{
			Payload:  req.Payload,
			Metadata: req.Metadata,
		})
		if n == 0 {
			// No subscribers; still accept the message but note it.
			log.Debug("published to topic with no subscribers",
				zap.String("topic", req.Topic))
		}

		accepted++
		s.metrics.PublishedMessages.Inc()
	}
}

func validatePublishRequest(req *pb.PublishRequest) error {
	if req.Topic == "" {
		return fmt.Errorf("topic is required")
	}
	if len(req.Payload) == 0 {
		return fmt.Errorf("payload is required")
	}
	if len(req.Payload) > 1<<20 { // 1 MiB
		return fmt.Errorf("payload exceeds 1 MiB limit")
	}
	return nil
}
```

### Client-Side Streaming Client

```go
// cmd/publisher/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/example/streaming/v1"
)

func main() {
	conn, err := grpc.NewClient("localhost:9090",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	client := pb.NewEventServiceClient(conn)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stream, err := client.Publish(ctx)
	if err != nil {
		log.Fatalf("publish stream: %v", err)
	}

	// Send 1000 events in a single stream.
	for i := 0; i < 1000; i++ {
		err := stream.Send(&pb.PublishRequest{
			Topic:   "orders",
			Payload: []byte(fmt.Sprintf(`{"order_id": %d}`, i)),
			Metadata: map[string]string{
				"source": "publisher-cmd",
			},
		})
		if err != nil {
			log.Fatalf("send[%d]: %v", i, err)
		}
	}

	resp, err := stream.CloseAndRecv()
	if err != nil {
		log.Fatalf("close: %v", err)
	}

	fmt.Printf("accepted=%d rejected=%d errors=%v\n",
		resp.MessagesAccepted, resp.MessagesRejected, resp.Errors)
}
```

## Section 3: Bidirectional Streaming

Bidirectional streaming is the most complex pattern. Both sides send and receive independently on the same connection. The key challenge is coordinating the read and write goroutines while ensuring proper shutdown.

```go
// Exchange implements bidirectional streaming with graceful shutdown
// and message acknowledgment.
func (s *EventServer) Exchange(stream pb.EventService_ExchangeServer) error {
	ctx := stream.Context()
	log := s.log.With(zap.String("method", "Exchange"))

	// outbound carries messages the server wants to send to the client.
	outbound := make(chan *pb.ExchangeMessage, 64)
	// done signals both goroutines to stop.
	done := make(chan struct{})
	// errs collects errors from both goroutines.
	errs := make(chan error, 2)

	// Sender goroutine: reads from outbound, writes to stream.
	go func() {
		defer close(done)
		for {
			select {
			case <-ctx.Done():
				errs <- ctx.Err()
				return
			case msg, ok := <-outbound:
				if !ok {
					// Channel closed; send EOF signal to client.
					_ = stream.Send(&pb.ExchangeMessage{Eof: true})
					errs <- nil
					return
				}
				if err := stream.Send(msg); err != nil {
					errs <- fmt.Errorf("send: %w", err)
					return
				}
			}
		}
	}()

	// Receiver goroutine: reads from stream, processes messages.
	go func() {
		defer close(outbound)
		for {
			msg, err := stream.Recv()
			if err == io.EOF {
				errs <- nil
				return
			}
			if err != nil {
				errs <- fmt.Errorf("recv: %w", err)
				return
			}

			// Process the incoming message.
			if msg.Eof {
				log.Info("client sent EOF")
				errs <- nil
				return
			}

			// Echo back with an acknowledgment.
			response := &pb.ExchangeMessage{
				Id:     generateID(),
				AckId:  msg.Id,
				Payload: []byte(fmt.Sprintf("ack:%s", msg.Id)),
			}

			select {
			case outbound <- response:
			case <-ctx.Done():
				errs <- ctx.Err()
				return
			case <-done:
				errs <- nil
				return
			}

			s.metrics.ExchangeMessages.Inc()
		}
	}()

	// Wait for both goroutines to finish; return first non-nil error.
	var firstErr error
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil && firstErr == nil {
			firstErr = err
		}
	}

	if firstErr != nil {
		return status.Errorf(codes.Internal, "exchange error: %v", firstErr)
	}
	return nil
}
```

### Bidirectional Client

```go
// cmd/exchange/main.go
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/example/streaming/v1"
)

func main() {
	conn, err := grpc.NewClient("localhost:9090",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	client := pb.NewEventServiceClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	stream, err := client.Exchange(ctx)
	if err != nil {
		log.Fatalf("exchange: %v", err)
	}

	var wg sync.WaitGroup

	// Receiver goroutine.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			msg, err := stream.Recv()
			if err == io.EOF {
				return
			}
			if err != nil {
				log.Printf("recv error: %v", err)
				return
			}
			if msg.Eof {
				log.Println("server sent EOF")
				return
			}
			fmt.Printf("received ack for %s\n", msg.AckId)
		}
	}()

	// Sender: send 10 messages with a short delay between each.
	for i := 0; i < 10; i++ {
		err := stream.Send(&pb.ExchangeMessage{
			Id:      fmt.Sprintf("msg-%d", i),
			Payload: []byte(fmt.Sprintf("hello %d", i)),
		})
		if err != nil {
			log.Fatalf("send[%d]: %v", i, err)
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Signal graceful close.
	_ = stream.Send(&pb.ExchangeMessage{Eof: true})
	_ = stream.CloseSend()

	wg.Wait()
	fmt.Println("exchange complete")
}
```

## Section 4: Metrics and Observability

```go
// internal/metrics/metrics.go
package metrics

import "github.com/prometheus/client_golang/prometheus"

type StreamMetrics struct {
	ActiveSubscribers   prometheus.Gauge
	SendErrors          prometheus.Counter
	SendLatency         prometheus.Histogram
	SubscriberBufferFill prometheus.Histogram
	PublishedMessages   prometheus.Counter
	ExchangeMessages    prometheus.Counter
}

func New(reg prometheus.Registerer) *StreamMetrics {
	m := &StreamMetrics{
		ActiveSubscribers: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "grpc_stream_active_subscribers",
			Help: "Number of active server-streaming subscribers.",
		}),
		SendErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "grpc_stream_send_errors_total",
			Help: "Total number of stream send errors.",
		}),
		SendLatency: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "grpc_stream_send_latency_seconds",
			Help:    "Latency of individual stream.Send calls.",
			Buckets: prometheus.DefBuckets,
		}),
		SubscriberBufferFill: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "grpc_stream_subscriber_buffer_fill_pct",
			Help:    "Subscriber local buffer fill percentage at check time.",
			Buckets: []float64{10, 25, 50, 75, 90, 100},
		}),
		PublishedMessages: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "grpc_stream_published_messages_total",
			Help: "Total messages published via client streaming.",
		}),
		ExchangeMessages: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "grpc_stream_exchange_messages_total",
			Help: "Total messages processed in bidi exchange streams.",
		}),
	}

	reg.MustRegister(
		m.ActiveSubscribers,
		m.SendErrors,
		m.SendLatency,
		m.SubscriberBufferFill,
		m.PublishedMessages,
		m.ExchangeMessages,
	)

	return m
}
```

## Section 5: Server Bootstrap with TLS and Keepalive

```go
// cmd/server/main.go
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	pb "github.com/example/streaming/v1"
	"github.com/example/streaming/internal/eventsource"
	"github.com/example/streaming/internal/metrics"
	"github.com/example/streaming/internal/server"
)

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	reg := prometheus.NewRegistry()
	m := metrics.New(reg)

	src := eventsource.New()

	srv := server.NewEventServer(src, logger, m)

	grpcServer := grpc.NewServer(
		// Keepalive: send pings to detect dead connections.
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionIdle:     5 * time.Minute,
			MaxConnectionAge:      30 * time.Minute,
			MaxConnectionAgeGrace: 5 * time.Second,
			Time:                  2 * time.Minute,
			Timeout:               20 * time.Second,
		}),
		// Enforce client keepalive policy to prevent abuse.
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             30 * time.Second,
			PermitWithoutStream: true,
		}),
		// Limit maximum message size to 4 MiB.
		grpc.MaxRecvMsgSize(4<<20),
		grpc.MaxSendMsgSize(4<<20),
		// Use insecure credentials for this example; use TLS in production.
		grpc.Creds(insecure.NewCredentials()),
	)

	pb.RegisterEventServiceServer(grpcServer, srv)
	reflection.Register(grpcServer)

	// Prometheus metrics endpoint.
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
		if err := http.ListenAndServe(":9091", mux); err != nil {
			logger.Fatal("metrics server", zap.Error(err))
		}
	}()

	lis, err := net.Listen("tcp", ":9090")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	fmt.Println("gRPC server listening on :9090")
	if err := grpcServer.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
```

## Section 6: Interceptors for Streaming

Interceptors are the gRPC equivalent of middleware. Stream interceptors wrap the entire lifecycle of a stream and are the right place to add logging, tracing, and authentication.

```go
// internal/interceptors/interceptors.go
package interceptors

import (
	"context"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// LoggingStreamInterceptor logs the start, end, and duration of each stream.
func LoggingStreamInterceptor(log *zap.Logger) grpc.StreamServerInterceptor {
	return func(
		srv interface{},
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		start := time.Now()
		log.Info("stream started",
			zap.String("method", info.FullMethod),
			zap.Bool("client_stream", info.IsClientStream),
			zap.Bool("server_stream", info.IsServerStream),
		)

		err := handler(srv, ss)

		log.Info("stream finished",
			zap.String("method", info.FullMethod),
			zap.Duration("duration", time.Since(start)),
			zap.Error(err),
		)
		return err
	}
}

// AuthStreamInterceptor validates a bearer token from stream metadata.
func AuthStreamInterceptor(validateToken func(string) error) grpc.StreamServerInterceptor {
	return func(
		srv interface{},
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		md, ok := metadata.FromIncomingContext(ss.Context())
		if !ok {
			return status.Error(codes.Unauthenticated, "missing metadata")
		}

		vals := md.Get("authorization")
		if len(vals) == 0 {
			return status.Error(codes.Unauthenticated, "missing authorization header")
		}

		token := vals[0]
		if len(token) > 7 && token[:7] == "Bearer " {
			token = token[7:]
		}

		if err := validateToken(token); err != nil {
			return status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
		}

		return handler(srv, ss)
	}
}

// RecoveryStreamInterceptor recovers from panics in stream handlers.
func RecoveryStreamInterceptor(log *zap.Logger) grpc.StreamServerInterceptor {
	return func(
		srv interface{},
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) (err error) {
		defer func() {
			if r := recover(); r != nil {
				log.Error("stream handler panic",
					zap.String("method", info.FullMethod),
					zap.Any("panic", r),
				)
				err = status.Errorf(codes.Internal, "internal server error")
			}
		}()
		return handler(srv, ss)
	}
}

// wrappedServerStream wraps grpc.ServerStream to allow replacing the context.
type wrappedServerStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *wrappedServerStream) Context() context.Context {
	return w.ctx
}

// WrapServerStream wraps a ServerStream with a new context.
func WrapServerStream(ss grpc.ServerStream, ctx context.Context) grpc.ServerStream {
	return &wrappedServerStream{ServerStream: ss, ctx: ctx}
}

// ChainStreamInterceptors chains multiple stream interceptors into one.
func ChainStreamInterceptors(interceptors ...grpc.StreamServerInterceptor) grpc.StreamServerInterceptor {
	return func(
		srv interface{},
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		chain := handler
		for i := len(interceptors) - 1; i >= 0; i-- {
			interceptor := interceptors[i]
			next := chain
			chain = func(s interface{}, stream grpc.ServerStream) error {
				return interceptor(s, stream, info, next)
			}
		}
		return chain(srv, ss)
	}
}
```

## Section 7: Flow Control and Window Size Tuning

HTTP/2 flow control uses a sliding window. By default, gRPC sets the initial window size to 64 KiB per stream. For high-throughput streaming, increasing this value reduces round-trips but increases memory usage per stream.

```go
// Tuned server for high-throughput streaming
grpcServer := grpc.NewServer(
	// Increase initial window size to 1 MiB per stream.
	grpc.InitialWindowSize(1 << 20),
	// Increase connection-level window to 8 MiB.
	grpc.InitialConnWindowSize(8 << 20),
	// Allow up to 1000 concurrent streams per connection.
	grpc.MaxConcurrentStreams(1000),
)

// Matching client configuration
conn, err := grpc.NewClient(
	addr,
	grpc.WithInitialWindowSize(1<<20),
	grpc.WithInitialConnWindowSize(8<<20),
)
```

Window size guidance:

| Scenario | Stream Window | Conn Window |
|---|---|---|
| Low-latency, few streams | 64 KiB (default) | 1 MiB |
| Bulk data transfer | 4 MiB | 16 MiB |
| Many concurrent streams | 256 KiB | 8 MiB |
| Real-time telemetry | 512 KiB | 4 MiB |

## Section 8: Graceful Shutdown

Graceful shutdown for streaming services must drain in-flight streams before the process exits.

```go
// Graceful shutdown handler
func gracefulShutdown(grpcServer *grpc.Server, timeout time.Duration) {
	// Create a channel to receive OS signals.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	<-sigs

	log.Println("shutdown signal received, draining streams...")

	// GracefulStop blocks until all active RPCs have completed or
	// the process is killed.
	done := make(chan struct{})
	go func() {
		grpcServer.GracefulStop()
		close(done)
	}()

	select {
	case <-done:
		log.Println("all streams drained")
	case <-time.After(timeout):
		log.Println("drain timeout exceeded, forcing stop")
		grpcServer.Stop()
	}
}
```

## Section 9: Testing Streaming Handlers

gRPC provides test helpers for streaming via `google.golang.org/grpc/interop/grpc_testing`, but for unit tests a simple mock is more practical.

```go
// internal/server/server_test.go
package server_test

import (
	"context"
	"io"
	"testing"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"

	pb "github.com/example/streaming/v1"
	"github.com/example/streaming/internal/eventsource"
	"github.com/example/streaming/internal/metrics"
	"github.com/example/streaming/internal/server"
	"github.com/prometheus/client_golang/prometheus"
)

// mockSubscribeStream implements pb.EventService_SubscribeServer for testing.
type mockSubscribeStream struct {
	grpc.ServerStream
	ctx    context.Context
	sent   []*pb.Event
	sendFn func(*pb.Event) error
}

func (m *mockSubscribeStream) Send(e *pb.Event) error {
	if m.sendFn != nil {
		return m.sendFn(e)
	}
	m.sent = append(m.sent, e)
	return nil
}

func (m *mockSubscribeStream) Context() context.Context {
	return m.ctx
}

func TestSubscribe_ClientDisconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	reg := prometheus.NewRegistry()
	m := metrics.New(reg)
	src := eventsource.New()
	log := zap.NewNop()

	srv := server.NewEventServer(src, log, m)

	stream := &mockSubscribeStream{ctx: ctx}

	// Cancel the context after a short delay to simulate client disconnect.
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	err := srv.Subscribe(&pb.SubscribeRequest{Topic: "test"}, stream)
	if err == nil {
		t.Fatal("expected error on context cancellation, got nil")
	}
}

func TestSubscribe_ReceivesEvents(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	reg := prometheus.NewRegistry()
	m := metrics.New(reg)
	src := eventsource.New()
	log := zap.NewNop()

	srv := server.NewEventServer(src, log, m)

	received := make(chan *pb.Event, 10)
	stream := &mockSubscribeStream{
		ctx: ctx,
		sendFn: func(e *pb.Event) error {
			received <- e
			return nil
		},
	}

	// Subscribe in the background.
	go func() {
		_ = srv.Subscribe(&pb.SubscribeRequest{Topic: "test"}, stream)
	}()

	// Give the subscriber time to register.
	time.Sleep(10 * time.Millisecond)

	// Publish an event.
	src.Publish("test", &eventsource.Event{
		ID:      "evt-1",
		Type:    "order.created",
		Payload: []byte(`{"id": 1}`),
	})

	select {
	case e := <-received:
		if e.Id != "evt-1" {
			t.Errorf("expected id evt-1, got %s", e.Id)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for event")
	}
}
```

## Section 10: Production Checklist

Before deploying gRPC streaming services to production, verify the following:

**Connection Management**
- Keepalive parameters configured on both client and server
- Maximum connection age set to force periodic reconnects (prevents stale connections)
- Client implements reconnect with exponential backoff

**Backpressure**
- Server-side streaming monitors send latency and buffer fill
- Client-side streaming validates and rate-limits incoming requests
- Bidirectional streaming has bounded channels to prevent unbounded memory growth

**Error Handling**
- All stream errors are mapped to appropriate gRPC status codes
- Stream interceptors include panic recovery
- Client retries on transient errors using the gRPC retry policy

**Observability**
- Active stream count tracked as a gauge
- Send/receive latency tracked as histograms
- Error counts tracked per error code
- Distributed tracing spans created per stream

**Shutdown**
- `GracefulStop` called with a timeout on SIGTERM
- Contexts propagated correctly so streams drain cleanly
- Event sources/producers shut down before the gRPC server

**Resource Limits**
- `MaxConcurrentStreams` set to prevent resource exhaustion
- Message size limits configured
- Buffer sizes chosen based on expected event rates

```go
// Production retry policy (set in service config JSON)
const retryServiceConfig = `{
  "methodConfig": [{
    "name": [{"service": "streaming.v1.EventService"}],
    "retryPolicy": {
      "maxAttempts": 5,
      "initialBackoff": "0.5s",
      "maxBackoff": "30s",
      "backoffMultiplier": 2,
      "retryableStatusCodes": ["UNAVAILABLE", "DEADLINE_EXCEEDED"]
    }
  }]
}`

conn, _ := grpc.NewClient(
	addr,
	grpc.WithDefaultServiceConfig(retryServiceConfig),
)
```

## Conclusion

gRPC streaming in Go gives you a powerful toolkit for real-time data pipelines, but each streaming pattern comes with distinct operational concerns. Server-side streaming requires backpressure to protect against slow consumers. Client-side streaming needs validation and flow accounting. Bidirectional streaming demands careful goroutine coordination and graceful shutdown sequencing.

The patterns shown here — bounded channels, send timeouts, stream interceptors, buffer fill monitoring, and graceful drain — are the foundation of production-ready gRPC streaming services. Combined with proper HTTP/2 window size tuning and a complete Prometheus metrics setup, they give you the visibility and control necessary to operate these services reliably at scale.
