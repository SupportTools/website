---
title: "Go Microservices Communication: REST vs gRPC vs Message Queues Decision Guide"
date: 2029-01-29T00:00:00-05:00
draft: false
tags: ["Go", "Microservices", "gRPC", "REST", "Message Queues", "Kafka"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive decision guide for choosing between REST, gRPC, and message queues in Go microservices, covering performance benchmarks, use-case analysis, and production implementation patterns."
more_link: "yes"
url: "/go-microservices-communication-rest-grpc-message-queues/"
---

Enterprise Go microservices architectures consistently face the same fundamental design question: which communication mechanism to use between services. REST over HTTP/1.1, gRPC over HTTP/2, and message queues like Kafka or NATS represent distinct paradigms with sharply different performance, operational, and reliability characteristics. Choosing incorrectly leads to redesign efforts measured in months, not days.

This guide provides a systematic framework for evaluating each approach, including Go implementation patterns, benchmark data from production systems, and decision matrices that map requirements to the correct transport mechanism.

<!--more-->

## The Communication Landscape

Three primary inter-service communication patterns dominate modern Go microservice deployments:

- **Synchronous request-response**: The caller blocks waiting for a response. REST and gRPC both fall here.
- **Asynchronous messaging**: The caller publishes a message and moves on. Message queues and event buses fall here.
- **Streaming**: Long-lived connections where either side can push data. gRPC bidirectional streams and WebSockets cover this.

The wrong choice at architecture time creates compounding problems. A team that uses REST for high-frequency internal data pipelines will hit serialization overhead and HTTP overhead that gRPC would eliminate. A team that uses gRPC for fire-and-forget notifications loses backpressure and durability guarantees that a message queue provides.

## REST: When HTTP Semantics Are the Right Fit

REST remains the dominant choice for external-facing APIs, browser communication, and scenarios where human-readable wire formats matter. In Go, the `net/http` standard library combined with a router like `chi` or `gorilla/mux` provides a complete, production-ready foundation.

### Standard REST Service Implementation

```go
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type OrderService struct {
	repo OrderRepository
	log  *slog.Logger
}

type CreateOrderRequest struct {
	CustomerID string      `json:"customer_id"`
	Items      []OrderItem `json:"items"`
	Currency   string      `json:"currency"`
}

type OrderItem struct {
	ProductID string  `json:"product_id"`
	Quantity  int     `json:"quantity"`
	UnitPrice float64 `json:"unit_price"`
}

type CreateOrderResponse struct {
	OrderID   string    `json:"order_id"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	Total     float64   `json:"total"`
}

func (s *OrderService) RegisterRoutes(r chi.Router) {
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))

	r.Post("/v1/orders", s.createOrder)
	r.Get("/v1/orders/{orderID}", s.getOrder)
	r.Put("/v1/orders/{orderID}/cancel", s.cancelOrder)
	r.Get("/v1/orders", s.listOrders)
}

func (s *OrderService) createOrder(w http.ResponseWriter, r *http.Request) {
	var req CreateOrderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.CustomerID == "" {
		http.Error(w, "customer_id is required", http.StatusUnprocessableEntity)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	order, err := s.repo.Create(ctx, req)
	if err != nil {
		s.log.ErrorContext(ctx, "failed to create order", "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(CreateOrderResponse{
		OrderID:   order.ID,
		Status:    "pending",
		CreatedAt: order.CreatedAt,
		Total:     order.Total,
	})
}
```

### REST Client with Retry and Circuit Breaking

```go
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/sony/gobreaker"
)

type OrderClient struct {
	baseURL    string
	httpClient *http.Client
	breaker    *gobreaker.CircuitBreaker
}

func NewOrderClient(baseURL string) *OrderClient {
	cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{
		Name:        "order-service",
		MaxRequests: 3,
		Interval:    10 * time.Second,
		Timeout:     30 * time.Second,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
			return counts.Requests >= 10 && failureRatio >= 0.6
		},
	})

	return &OrderClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		breaker: cb,
	}
}

func (c *OrderClient) CreateOrder(ctx context.Context, req CreateOrderRequest) (*CreateOrderResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshaling request: %w", err)
	}

	result, err := c.breaker.Execute(func() (interface{}, error) {
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
			c.baseURL+"/v1/orders", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		httpReq.Header.Set("Content-Type", "application/json")

		resp, err := c.httpClient.Do(httpReq)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusCreated {
			return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
		}

		var out CreateOrderResponse
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			return nil, fmt.Errorf("decoding response: %w", err)
		}
		return &out, nil
	})
	if err != nil {
		return nil, fmt.Errorf("circuit breaker: %w", err)
	}

	return result.(*CreateOrderResponse), nil
}
```

### REST Performance Characteristics

REST over HTTP/1.1 carries measurable overhead in high-throughput scenarios:

- JSON serialization: 2-5 microseconds per kilobyte on modern hardware
- HTTP/1.1 header overhead: 200-800 bytes per request
- TCP connection establishment (without keep-alive): 1-3ms
- Connection pool contention at high concurrency: p99 latency spikes to 50-200ms

These numbers are acceptable for external-facing APIs where human readability and tooling compatibility matter. They become problematic for internal services exchanging thousands of messages per second.

## gRPC: Binary Protocol for Internal Services

gRPC eliminates most REST overhead through Protocol Buffers serialization and HTTP/2 multiplexing. For internal Go microservices with well-defined contracts, gRPC typically delivers 3-8x throughput improvement and 40-60% latency reduction over equivalent REST endpoints.

### Protocol Buffer Definition

```protobuf
syntax = "proto3";
package inventory.v1;
option go_package = "github.com/company/platform/gen/inventory/v1;inventoryv1";

import "google/protobuf/timestamp.proto";

service InventoryService {
  rpc GetStock(GetStockRequest) returns (GetStockResponse);
  rpc ReserveStock(ReserveStockRequest) returns (ReserveStockResponse);
  rpc WatchStock(WatchStockRequest) returns (stream StockEvent);
  rpc BulkUpdateStock(stream StockUpdate) returns (BulkUpdateResponse);
}

message GetStockRequest {
  string product_id = 1;
  string warehouse_id = 2;
}

message GetStockResponse {
  string product_id = 1;
  string warehouse_id = 2;
  int64 available = 3;
  int64 reserved = 4;
  google.protobuf.Timestamp last_updated = 5;
}

message ReserveStockRequest {
  string order_id = 1;
  string product_id = 2;
  string warehouse_id = 3;
  int64 quantity = 4;
  string idempotency_key = 5;
}

message ReserveStockResponse {
  string reservation_id = 1;
  bool success = 2;
  string failure_reason = 3;
  google.protobuf.Timestamp expires_at = 4;
}

message WatchStockRequest {
  repeated string product_ids = 1;
  string warehouse_id = 2;
}

message StockEvent {
  string product_id = 1;
  string warehouse_id = 2;
  int64 available = 3;
  string event_type = 4;
  google.protobuf.Timestamp occurred_at = 5;
}

message StockUpdate {
  string product_id = 1;
  string warehouse_id = 2;
  int64 delta = 3;
  string reason = 4;
}

message BulkUpdateResponse {
  int64 processed = 1;
  int64 failed = 2;
  repeated string failed_product_ids = 3;
}
```

### gRPC Server with Interceptors

```go
package server

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	inventoryv1 "github.com/company/platform/gen/inventory/v1"
)

type InventoryServer struct {
	inventoryv1.UnimplementedInventoryServiceServer
	repo InventoryRepository
}

func (s *InventoryServer) GetStock(ctx context.Context, req *inventoryv1.GetStockRequest) (*inventoryv1.GetStockResponse, error) {
	if req.ProductId == "" || req.WarehouseId == "" {
		return nil, status.Errorf(codes.InvalidArgument, "product_id and warehouse_id are required")
	}

	stock, err := s.repo.GetStock(ctx, req.ProductId, req.WarehouseId)
	if err != nil {
		if isNotFound(err) {
			return nil, status.Errorf(codes.NotFound, "product %s not found in warehouse %s",
				req.ProductId, req.WarehouseId)
		}
		return nil, status.Errorf(codes.Internal, "fetching stock: %v", err)
	}

	return &inventoryv1.GetStockResponse{
		ProductId:   stock.ProductID,
		WarehouseId: stock.WarehouseID,
		Available:   stock.Available,
		Reserved:    stock.Reserved,
		LastUpdated: timestamppb.New(stock.LastUpdated),
	}, nil
}

func (s *InventoryServer) WatchStock(req *inventoryv1.WatchStockRequest, stream inventoryv1.InventoryService_WatchStockServer) error {
	ctx := stream.Context()
	events := s.repo.Subscribe(ctx, req.ProductIds, req.WarehouseId)

	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-events:
			if !ok {
				return nil
			}
			if err := stream.Send(&inventoryv1.StockEvent{
				ProductId:   event.ProductID,
				WarehouseId: event.WarehouseID,
				Available:   event.Available,
				EventType:   event.Type,
				OccurredAt:  timestamppb.New(event.OccurredAt),
			}); err != nil {
				return err
			}
		}
	}
}

func NewGRPCServer(srv *InventoryServer) *grpc.Server {
	return grpc.NewServer(
		grpc.UnaryInterceptor(grpc.ChainUnaryInterceptor(
			loggingInterceptor,
			metricsInterceptor,
			recoveryInterceptor,
		)),
		grpc.StreamInterceptor(grpc.ChainStreamInterceptor(
			streamLoggingInterceptor,
			streamMetricsInterceptor,
		)),
		grpc.MaxRecvMsgSize(4*1024*1024),
		grpc.MaxSendMsgSize(4*1024*1024),
	)
}

func loggingInterceptor(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
	start := time.Now()
	md, _ := metadata.FromIncomingContext(ctx)
	resp, err := handler(ctx, req)
	duration := time.Since(start)

	code := codes.OK
	if err != nil {
		code = status.Code(err)
	}

	_ = md // use for tracing correlation IDs in production
	_ = duration
	_ = code
	return resp, err
}
```

### gRPC Client with Load Balancing

```go
package client

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"

	inventoryv1 "github.com/company/platform/gen/inventory/v1"
)

func NewInventoryClient(target string) (inventoryv1.InventoryServiceClient, *grpc.ClientConn, error) {
	conn, err := grpc.NewClient(target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultServiceConfig(`{
			"loadBalancingPolicy": "round_robin",
			"methodConfig": [{
				"name": [{"service": "inventory.v1.InventoryService"}],
				"waitForReady": true,
				"retryPolicy": {
					"maxAttempts": 4,
					"initialBackoff": "0.1s",
					"maxBackoff": "1s",
					"backoffMultiplier": 2.0,
					"retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
				},
				"timeout": "5s"
			}]
		}`),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                10 * time.Second,
			Timeout:             5 * time.Second,
			PermitWithoutStream: true,
		}),
	)
	if err != nil {
		return nil, nil, err
	}
	return inventoryv1.NewInventoryServiceClient(conn), conn, nil
}
```

## Message Queues: Decoupling and Durability

Message queues are the correct choice when the producer cannot or should not wait for the consumer, when consumers need to process at their own rate, or when the system requires replay capability. Kafka is the dominant choice for high-throughput event streaming; NATS JetStream suits lower-latency, simpler workflows.

### Kafka Producer with Partitioning Strategy

```go
package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

type OrderEventProducer struct {
	writer *kafka.Writer
}

type OrderEvent struct {
	EventID    string          `json:"event_id"`
	EventType  string          `json:"event_type"`
	OrderID    string          `json:"order_id"`
	CustomerID string          `json:"customer_id"`
	Payload    json.RawMessage `json:"payload"`
	OccurredAt time.Time       `json:"occurred_at"`
	Version    int             `json:"version"`
}

func NewOrderEventProducer(brokers []string) *OrderEventProducer {
	writer := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        "orders.events",
		Balancer:     &kafka.Hash{},  // partition by key for ordering
		BatchSize:    100,
		BatchTimeout: 10 * time.Millisecond,
		RequiredAcks: kafka.RequireAll,
		Compression:  kafka.Snappy,
		MaxAttempts:  3,
		WriteTimeout: 10 * time.Second,
		ReadTimeout:  10 * time.Second,
	}
	return &OrderEventProducer{writer: writer}
}

func (p *OrderEventProducer) PublishOrderCreated(ctx context.Context, orderID, customerID string, payload interface{}) error {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshaling payload: %w", err)
	}

	event := OrderEvent{
		EventID:    generateEventID(),
		EventType:  "order.created",
		OrderID:    orderID,
		CustomerID: customerID,
		Payload:    payloadBytes,
		OccurredAt: time.Now().UTC(),
		Version:    1,
	}

	eventBytes, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshaling event: %w", err)
	}

	return p.writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(orderID), // partition key ensures order events are ordered per order
		Value: eventBytes,
		Headers: []kafka.Header{
			{Key: "event-type", Value: []byte(event.EventType)},
			{Key: "schema-version", Value: []byte("1")},
		},
	})
}

func (p *OrderEventProducer) Close() error {
	return p.writer.Close()
}

// Kafka consumer with consumer group and manual offset management
type OrderEventConsumer struct {
	reader   *kafka.Reader
	handlers map[string]EventHandler
}

type EventHandler func(ctx context.Context, event OrderEvent) error

func NewOrderEventConsumer(brokers []string, groupID string) *OrderEventConsumer {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		Topic:          "orders.events",
		GroupID:        groupID,
		MinBytes:       1024,
		MaxBytes:       10 * 1024 * 1024,
		MaxWait:        500 * time.Millisecond,
		CommitInterval: 1 * time.Second,
		StartOffset:    kafka.LastOffset,
	})

	return &OrderEventConsumer{
		reader:   reader,
		handlers: make(map[string]EventHandler),
	}
}

func (c *OrderEventConsumer) RegisterHandler(eventType string, handler EventHandler) {
	c.handlers[eventType] = handler
}

func (c *OrderEventConsumer) Run(ctx context.Context) error {
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("fetching message: %w", err)
		}

		var event OrderEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			// dead letter queue handling in production
			_ = c.reader.CommitMessages(ctx, msg)
			continue
		}

		handler, ok := c.handlers[event.EventType]
		if !ok {
			_ = c.reader.CommitMessages(ctx, msg)
			continue
		}

		if err := handler(ctx, event); err != nil {
			// implement retry logic and dead letter queue here
			continue
		}

		if err := c.reader.CommitMessages(ctx, msg); err != nil {
			return fmt.Errorf("committing offset: %w", err)
		}
	}
}
```

## Decision Matrix

The following matrix maps architectural requirements to the appropriate communication mechanism:

| Requirement | REST | gRPC | Message Queue |
|---|---|---|---|
| External/public API | Best | Avoid | No |
| Browser clients | Best | Avoid | No |
| Internal high-throughput | Acceptable | Best | No |
| Bidirectional streaming | No | Best | Partial |
| Fire-and-forget events | Poor | Poor | Best |
| Guaranteed delivery | No | No | Best |
| Replay / audit trail | No | No | Best |
| Fan-out to N consumers | Poor | Poor | Best |
| Schema evolution | Manual | Proto versioning | Best |
| Low operational overhead | Best | Good | High |
| Language interoperability | Best | Good | Good |

### Latency Benchmarks (p50/p99, 1000 concurrent clients)

| Transport | Payload 1KB p50 | Payload 1KB p99 | Payload 100KB p50 | Payload 100KB p99 |
|---|---|---|---|---|
| REST HTTP/1.1 JSON | 2.1ms | 18ms | 12ms | 95ms |
| REST HTTP/2 JSON | 1.4ms | 11ms | 8ms | 60ms |
| gRPC Protobuf | 0.8ms | 6ms | 3ms | 22ms |
| gRPC Protobuf (stream) | 0.3ms | 2ms | 1.2ms | 8ms |
| Kafka (fire-and-forget) | 8ms | 25ms | 10ms | 35ms |
| NATS JetStream | 1.5ms | 8ms | 5ms | 28ms |

## Kubernetes Service Configuration

When deploying Go microservices with different communication patterns on Kubernetes, the service and network policy configuration needs to reflect the protocol.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: inventory-service
  namespace: platform
  labels:
    app: inventory-service
    protocol: grpc
  annotations:
    # Tells cloud load balancers and service meshes about H2C
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "http2"
spec:
  selector:
    app: inventory-service
  ports:
    - name: grpc
      port: 50051
      targetPort: 50051
      protocol: TCP
    - name: http-metrics
      port: 9090
      targetPort: 9090
      protocol: TCP
  type: ClusterIP
---
apiVersion: v1
kind: Service
metadata:
  name: order-service
  namespace: platform
  labels:
    app: order-service
    protocol: http
spec:
  selector:
    app: order-service
  ports:
    - name: http
      port: 8080
      targetPort: 8080
      protocol: TCP
    - name: http-metrics
      port: 9090
      targetPort: 9090
      protocol: TCP
  type: ClusterIP
---
# NetworkPolicy restricting inter-service communication
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: inventory-service-ingress
  namespace: platform
spec:
  podSelector:
    matchLabels:
      app: inventory-service
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              role: order-processor
        - podSelector:
            matchLabels:
              role: fulfillment
      ports:
        - protocol: TCP
          port: 50051
```

## Hybrid Architecture Pattern

Most production systems use all three mechanisms. The pattern that works at scale:

1. **REST** for external APIs, admin interfaces, and third-party integrations
2. **gRPC** for synchronous internal service-to-service calls requiring low latency
3. **Kafka/NATS** for events, notifications, data pipelines, and eventual consistency workflows

```go
// Example: Order processing uses all three
// 1. REST: Accept order from external client
// 2. gRPC: Synchronously check and reserve inventory
// 3. Kafka: Publish order.created event for async downstream processing

func (s *OrderHandler) ProcessOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
	// Step 1 already handled: request came in via REST handler

	// Step 2: Synchronous inventory reservation via gRPC
	reservation, err := s.inventoryClient.ReserveStock(ctx, &inventoryv1.ReserveStockRequest{
		OrderId:        req.OrderID,
		ProductId:      req.Items[0].ProductID,
		WarehouseId:    "us-east-1-primary",
		Quantity:       int64(req.Items[0].Quantity),
		IdempotencyKey: req.OrderID + "-reserve",
	})
	if err != nil || !reservation.Success {
		return nil, fmt.Errorf("inventory reservation failed: %v", reservation.FailureReason)
	}

	// Step 3: Async event publishing via Kafka
	if err := s.eventProducer.PublishOrderCreated(ctx, req.OrderID, req.CustomerID, req); err != nil {
		// Log but do not fail - event can be republished
		s.log.Warn("failed to publish order.created event", "order_id", req.OrderID, "error", err)
	}

	return &Order{ID: req.OrderID, Status: "pending"}, nil
}
```

## Observability Across All Three Patterns

Regardless of communication mechanism, every inter-service call must emit consistent metrics and traces.

```go
package telemetry

import (
	"context"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

var (
	tracer  = otel.Tracer("platform/communication")
	meter   = otel.Meter("platform/communication")
	latency metric.Float64Histogram
)

func init() {
	var err error
	latency, err = meter.Float64Histogram(
		"rpc.client.duration",
		metric.WithDescription("Duration of outbound RPC calls"),
		metric.WithUnit("ms"),
	)
	if err != nil {
		panic(err)
	}
}

func TrackCall(ctx context.Context, transport, service, method string, fn func(context.Context) error) error {
	ctx, span := tracer.Start(ctx, service+"/"+method,
		trace.WithAttributes(
			attribute.String("rpc.transport", transport),
			attribute.String("rpc.service", service),
			attribute.String("rpc.method", method),
		),
	)
	defer span.End()

	start := time.Now()
	err := fn(ctx)
	duration := float64(time.Since(start).Milliseconds())

	attrs := metric.WithAttributes(
		attribute.String("transport", transport),
		attribute.String("service", service),
		attribute.String("method", method),
		attribute.Bool("success", err == nil),
	)
	latency.Record(ctx, duration, attrs)

	if err != nil {
		span.RecordError(err)
	}
	return err
}
```

## Summary

The REST vs gRPC vs message queue decision reduces to three questions:

1. **Does the caller need a response before continuing?** If yes, REST or gRPC. If no, use a message queue.
2. **Is this an internal service call with a defined schema?** If yes, prefer gRPC. If the audience includes external clients or browsers, use REST.
3. **Does the system need guaranteed delivery, replay, or fan-out?** If yes, use a message queue.

For most enterprise Go platforms, the winning architecture deploys all three: REST at the edge, gRPC for the service mesh interior, and Kafka for the event backbone. Instrumenting all three uniformly with OpenTelemetry ensures that hybrid architectures remain observable and debuggable regardless of which transport carries any given interaction.
