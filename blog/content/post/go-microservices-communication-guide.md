---
title: "Go Microservices Communication: REST, gRPC, and Event-Driven Patterns"
date: 2027-10-21T00:00:00-05:00
draft: false
tags: ["Go", "Microservices", "gRPC", "REST", "Event-Driven"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Communication patterns for Go microservices covering REST API design with chi/fiber/gin comparison, gRPC with buf, Connect protocol, Kafka messaging, NATS, saga pattern implementation, and service discovery."
more_link: "yes"
url: "/go-microservices-communication-guide/"
---

Go microservices must communicate reliably across process boundaries under partial failure conditions. The choice of transport — REST, gRPC, or async messaging — shapes latency, coupling, and operational complexity. This guide covers every major pattern with production-tested Go implementations.

<!--more-->

# Go Microservices Communication: REST, gRPC, and Event-Driven Patterns

## Section 1: REST API Design — chi vs fiber vs gin

Three routers dominate new Go HTTP services. The choice matters for performance, middleware compatibility, and team familiarity.

### chi — Standard Library Compatible

`chi` is the preferred choice when the service will be tested with `net/http/httptest`, when middleware must compose with standard library handlers, or when the team values minimal external dependencies:

```go
// api/rest/chi_server.go
package rest

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"myapp/service"
)

func NewChiRouter(svc *service.UserService) http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))

	r.Route("/api/v1/users", func(r chi.Router) {
		r.Get("/",         listUsers(svc))
		r.Post("/",        createUser(svc))
		r.Route("/{id}", func(r chi.Router) {
			r.Use(userCtx(svc))
			r.Get("/",    getUser(svc))
			r.Put("/",    updateUser(svc))
			r.Delete("/", deleteUser(svc))
		})
	})

	return r
}

func listUsers(svc *service.UserService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page < 1 {
			page = 1
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit < 1 || limit > 100 {
			limit = 20
		}

		users, total, err := svc.List(r.Context(), page, limit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to list users")
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"data":  users,
			"total": total,
			"page":  page,
			"limit": limit,
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
```

### fiber — High-Performance with fasthttp

Use `fiber` when raw throughput is the primary concern (e.g., proxies, data ingestion endpoints):

```go
// api/rest/fiber_server.go
package rest

import (
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/compress"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/gofiber/fiber/v2/middleware/requestid"
	"myapp/service"
)

func NewFiberApp(svc *service.UserService) *fiber.App {
	app := fiber.New(fiber.Config{
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		// Return errors as JSON, not HTML.
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			code := fiber.StatusInternalServerError
			if e, ok := err.(*fiber.Error); ok {
				code = e.Code
			}
			return c.Status(code).JSON(fiber.Map{"error": err.Error()})
		},
	})

	app.Use(requestid.New())
	app.Use(recover.New())
	app.Use(compress.New(compress.Config{Level: compress.LevelDefault}))
	app.Use(cors.New(cors.Config{
		AllowOrigins: "https://app.example.com",
		AllowMethods: "GET,POST,PUT,DELETE,OPTIONS",
	}))

	v1 := app.Group("/api/v1")
	users := v1.Group("/users")
	users.Get("/",     fiberListUsers(svc))
	users.Post("/",    fiberCreateUser(svc))
	users.Get("/:id",  fiberGetUser(svc))
	users.Put("/:id",  fiberUpdateUser(svc))

	return app
}

func fiberListUsers(svc *service.UserService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		page, _ := strconv.Atoi(c.Query("page", "1"))
		limit, _ := strconv.Atoi(c.Query("limit", "20"))

		users, total, err := svc.List(c.Context(), page, limit)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, err.Error())
		}

		return c.JSON(fiber.Map{
			"data":  users,
			"total": total,
		})
	}
}
```

### Framework Comparison

| Aspect | chi | fiber | gin |
|---|---|---|---|
| HTTP package | net/http | fasthttp | net/http |
| Allocs/req | ~5 | ~2 | ~8 |
| Middleware ecosystem | Large | Growing | Large |
| Testing | httptest native | fiber.Test() | httptest native |
| ctx.Context() | Standard | Custom adapter | Standard |
| Best for | Standard services | High throughput | Brownfield migration |

---

## Section 2: gRPC with buf

`buf` replaces manual `protoc` invocations with a reproducible, dependency-managed workflow.

### buf Configuration

```yaml
# buf.yaml
version: v2
modules:
  - path: proto
deps:
  - buf.build/googleapis/googleapis
  - buf.build/grpc/grpc
lint:
  use:
    - DEFAULT
  except:
    - FIELD_NOT_REQUIRED
breaking:
  use:
    - FILE
```

```yaml
# buf.gen.yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go
    out: gen/go
    opt:
      - paths=source_relative
  - remote: buf.build/grpc/go
    out: gen/go
    opt:
      - paths=source_relative
      - require_unimplemented_servers=true
```

### Service Definition

```protobuf
// proto/user/v1/user.proto
syntax = "proto3";
package user.v1;
option go_package = "myapp/gen/go/user/v1;userv1";

import "google/protobuf/timestamp.proto";

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
  rpc WatchUserEvents(WatchUserEventsRequest) returns (stream UserEvent);
}

message User {
  int64  id         = 1;
  string email      = 2;
  string name       = 3;
  string role       = 4;
  google.protobuf.Timestamp created_at = 5;
}

message GetUserRequest  { int64 id = 1; }
message GetUserResponse { User  user = 1; }

message ListUsersRequest {
  int32  page  = 1;
  int32  limit = 2;
  string role  = 3; // optional filter
}
message ListUsersResponse {
  repeated User users = 1;
  int32 total = 2;
}

message CreateUserRequest {
  string email = 1;
  string name  = 2;
  string role  = 3;
}
message CreateUserResponse { User user = 1; }

message WatchUserEventsRequest { string org_id = 1; }
message UserEvent {
  enum EventType {
    EVENT_TYPE_UNSPECIFIED = 0;
    EVENT_TYPE_CREATED     = 1;
    EVENT_TYPE_UPDATED     = 2;
    EVENT_TYPE_DELETED     = 3;
  }
  EventType event_type = 1;
  User      user       = 2;
  google.protobuf.Timestamp occurred_at = 3;
}
```

Generate:

```bash
buf generate
```

### gRPC Server Implementation

```go
// grpc/user_server.go
package grpcserver

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "myapp/gen/go/user/v1"
	"myapp/service"
)

type UserServer struct {
	pb.UnimplementedUserServiceServer
	svc *service.UserService
}

func NewUserServer(svc *service.UserService) *UserServer {
	return &UserServer{svc: svc}
}

func (s *UserServer) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.GetUserResponse, error) {
	if req.Id <= 0 {
		return nil, status.Errorf(codes.InvalidArgument, "id must be positive, got %d", req.Id)
	}

	user, err := s.svc.GetUser(ctx, req.Id)
	if err != nil {
		if isNotFound(err) {
			return nil, status.Errorf(codes.NotFound, "user %d not found", req.Id)
		}
		return nil, status.Errorf(codes.Internal, "internal error")
	}

	return &pb.GetUserResponse{
		User: toProto(user),
	}, nil
}

func (s *UserServer) WatchUserEvents(
	req *pb.WatchUserEventsRequest,
	stream pb.UserService_WatchUserEventsServer,
) error {
	ch, cancel, err := s.svc.SubscribeToOrgEvents(stream.Context(), req.OrgId)
	if err != nil {
		return status.Errorf(codes.Internal, "subscribe: %v", err)
	}
	defer cancel()

	for {
		select {
		case <-stream.Context().Done():
			return nil
		case event, ok := <-ch:
			if !ok {
				return nil
			}
			if err := stream.Send(&pb.UserEvent{
				EventType:  pb.UserEvent_EventType(event.Type),
				User:       toProto(event.User),
				OccurredAt: timestamppb.New(event.OccurredAt),
			}); err != nil {
				return err
			}
		}
	}
}

func toProto(u *service.User) *pb.User {
	return &pb.User{
		Id:        u.ID,
		Email:     u.Email,
		Name:      u.Name,
		Role:      u.Role,
		CreatedAt: timestamppb.New(u.CreatedAt),
	}
}
```

### gRPC Server Bootstrap with Interceptors

```go
// grpc/server.go
package grpcserver

import (
	"net"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	grpcprom "github.com/grpc-ecosystem/go-grpc-middleware/providers/prometheus"
	"github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/logging"
	"github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"
)

func NewGRPCServer() *grpc.Server {
	metrics := grpcprom.NewServerMetrics(
		grpcprom.WithServerHandlingTimeHistogram(),
	)

	srv := grpc.NewServer(
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
		grpc.ChainUnaryInterceptor(
			metrics.UnaryServerInterceptor(),
			recovery.UnaryServerInterceptor(),
		),
		grpc.ChainStreamInterceptor(
			metrics.StreamServerInterceptor(),
			recovery.StreamServerInterceptor(),
		),
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionIdle:     15 * time.Minute,
			MaxConnectionAge:      30 * time.Minute,
			MaxConnectionAgeGrace: 5 * time.Second,
			Time:                  5 * time.Minute,
			Timeout:               20 * time.Second,
		}),
		grpc.MaxRecvMsgSize(4 * 1024 * 1024), // 4 MB
		grpc.MaxSendMsgSize(4 * 1024 * 1024),
	)

	// Enable server reflection for grpcurl and Postman.
	reflection.Register(srv)
	return srv
}
```

---

## Section 3: Connect Protocol

Connect is gRPC-compatible but also speaks HTTP/1.1 and HTTP/2 JSON, making it browser-compatible without a proxy:

```go
// connect/user_handler.go
package connecthandler

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	pb "myapp/gen/go/user/v1"
	pbconnect "myapp/gen/go/user/v1/userv1connect"
	"myapp/service"
)

type UserHandler struct {
	svc *service.UserService
}

func NewUserHandler(svc *service.UserService) (string, http.Handler) {
	h := &UserHandler{svc: svc}
	return pbconnect.NewUserServiceHandler(h)
}

func (h *UserHandler) GetUser(
	ctx context.Context,
	req *connect.Request[pb.GetUserRequest],
) (*connect.Response[pb.GetUserResponse], error) {
	user, err := h.svc.GetUser(ctx, req.Msg.Id)
	if err != nil {
		if isNotFound(err) {
			return nil, connect.NewError(connect.CodeNotFound, err)
		}
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("internal"))
	}

	return connect.NewResponse(&pb.GetUserResponse{
		User: toProto(user),
	}), nil
}
```

```go
// connect/server.go
package connectserver

import (
	"net/http"

	"connectrpc.com/connect"
	"connectrpc.com/grpchealth"
	"connectrpc.com/grpcreflect"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

func NewConnectServer(userHandler connecthandler.UserHandler) http.Handler {
	mux := http.NewServeMux()

	// Register the service handler.
	path, handler := connecthandler.NewUserHandler(userHandler)
	mux.Handle(path, handler)

	// Standard health check endpoint.
	checker := grpchealth.NewStaticChecker(
		"user.v1.UserService",
	)
	mux.Handle(grpchealth.NewHandler(checker))

	// Server reflection for tools like grpcurl.
	reflector := grpcreflect.NewStaticReflector("user.v1.UserService")
	mux.Handle(grpcreflect.NewHandlerV1(reflector))
	mux.Handle(grpcreflect.NewHandlerV1Alpha(reflector))

	// h2c allows HTTP/2 without TLS (useful behind a TLS-terminating proxy).
	return h2c.NewHandler(mux, &http2.Server{})
}
```

---

## Section 4: Kafka with confluent-kafka-go

Kafka provides durable, ordered, partitioned event streams for high-throughput async communication:

```go
// kafka/producer.go
package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// Producer wraps the Kafka producer with serialization and error handling.
type Producer struct {
	producer *kafka.Producer
	topic    string
}

func NewProducer(brokers, topic string) (*Producer, error) {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":            brokers,
		"acks":                         "all",
		"retries":                      10,
		"retry.backoff.ms":             100,
		"max.in.flight.requests.per.connection": 5,
		"enable.idempotence":           true,
		"compression.type":             "snappy",
		"batch.size":                   65536,
		"linger.ms":                    5,
	})
	if err != nil {
		return nil, fmt.Errorf("create producer: %w", err)
	}

	// Drain delivery reports in the background.
	go func() {
		for e := range p.Events() {
			switch ev := e.(type) {
			case *kafka.Message:
				if ev.TopicPartition.Error != nil {
					// In production, increment an error counter here.
					fmt.Printf("delivery failed: %v\n", ev.TopicPartition.Error)
				}
			}
		}
	}()

	return &Producer{producer: p, topic: topic}, nil
}

// Publish serializes a message and sends it to Kafka.
// The key is used for partition assignment — use the entity ID for ordering.
func (p *Producer) Publish(ctx context.Context, key string, event interface{}) error {
	value, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	return p.producer.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{
			Topic:     &p.topic,
			Partition: kafka.PartitionAny,
		},
		Key:   []byte(key),
		Value: value,
		Headers: []kafka.Header{
			{Key: "content-type", Value: []byte("application/json")},
			{Key: "producer-ts", Value: []byte(time.Now().UTC().Format(time.RFC3339Nano))},
		},
	}, nil)
}

// Flush waits for all enqueued messages to be delivered.
func (p *Producer) Flush(timeoutMs int) int {
	return p.producer.Flush(timeoutMs)
}

func (p *Producer) Close() {
	p.producer.Close()
}
```

```go
// kafka/consumer.go
package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// ConsumerConfig holds consumer group configuration.
type ConsumerConfig struct {
	Brokers        string
	GroupID        string
	Topics         []string
	AutoOffsetReset string // "earliest" or "latest"
}

// Consumer wraps the Kafka consumer with context-aware polling.
type Consumer struct {
	consumer *kafka.Consumer
	cfg      ConsumerConfig
}

func NewConsumer(cfg ConsumerConfig) (*Consumer, error) {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":        cfg.Brokers,
		"group.id":                 cfg.GroupID,
		"auto.offset.reset":        cfg.AutoOffsetReset,
		"enable.auto.commit":       false, // Manual commit for at-least-once.
		"max.poll.interval.ms":     300000,
		"session.timeout.ms":       30000,
		"heartbeat.interval.ms":    3000,
		"fetch.min.bytes":          1,
		"fetch.wait.max.ms":        500,
	})
	if err != nil {
		return nil, fmt.Errorf("create consumer: %w", err)
	}

	if err := c.SubscribeTopics(cfg.Topics, nil); err != nil {
		c.Close()
		return nil, fmt.Errorf("subscribe: %w", err)
	}

	return &Consumer{consumer: c, cfg: cfg}, nil
}

// Handler processes a decoded Kafka message.
type Handler func(ctx context.Context, key string, value json.RawMessage) error

// Consume polls Kafka until the context is cancelled.
func (c *Consumer) Consume(ctx context.Context, handler Handler) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		msg, err := c.consumer.ReadMessage(100 * time.Millisecond)
		if err != nil {
			if kerr, ok := err.(kafka.Error); ok && kerr.IsTimeout() {
				continue
			}
			return fmt.Errorf("read message: %w", err)
		}

		if err := handler(ctx, string(msg.Key), json.RawMessage(msg.Value)); err != nil {
			slog.Error("handler failed",
				"topic", *msg.TopicPartition.Topic,
				"partition", msg.TopicPartition.Partition,
				"offset", msg.TopicPartition.Offset,
				"err", err,
			)
			// Decide: DLQ vs retry vs skip based on error type.
			continue
		}

		// Commit only after successful processing.
		if _, err := c.consumer.CommitMessage(msg); err != nil {
			return fmt.Errorf("commit: %w", err)
		}
	}
}
```

---

## Section 5: NATS for Lightweight Messaging

NATS is well-suited for lower-latency, lower-durability messaging compared to Kafka:

```go
// nats/client.go
package natslient

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Client wraps the NATS JetStream client.
type Client struct {
	conn *nats.Conn
	js   jetstream.JetStream
}

func NewClient(servers string) (*Client, error) {
	conn, err := nats.Connect(servers,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
		nats.Timeout(5*time.Second),
		nats.Name("myapp"),
	)
	if err != nil {
		return nil, fmt.Errorf("nats connect: %w", err)
	}

	js, err := jetstream.New(conn)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("jetstream: %w", err)
	}

	return &Client{conn: conn, js: js}, nil
}

// EnsureStream creates or updates a JetStream stream.
func (c *Client) EnsureStream(ctx context.Context, cfg jetstream.StreamConfig) error {
	_, err := c.js.CreateOrUpdateStream(ctx, cfg)
	return err
}

// Publish publishes a JSON-encoded message to a NATS subject.
func (c *Client) Publish(ctx context.Context, subject string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	_, err = c.js.Publish(ctx, subject, data)
	return err
}

// Subscribe creates a durable push consumer.
func (c *Client) Subscribe(
	ctx context.Context,
	stream, consumer, subject string,
	handler func(ctx context.Context, msg jetstream.Msg) error,
) error {
	cons, err := c.js.CreateOrUpdateConsumer(ctx, stream, jetstream.ConsumerConfig{
		Durable:       consumer,
		AckPolicy:     jetstream.AckExplicitPolicy,
		FilterSubject: subject,
		MaxDeliver:    5,
		AckWait:       30 * time.Second,
		DeliverPolicy: jetstream.DeliverNewPolicy,
	})
	if err != nil {
		return fmt.Errorf("create consumer: %w", err)
	}

	cc, err := cons.Consume(func(msg jetstream.Msg) {
		if err := handler(ctx, msg); err != nil {
			msg.Nak()
			return
		}
		msg.Ack()
	})
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	go func() {
		<-ctx.Done()
		cc.Stop()
	}()

	return nil
}
```

---

## Section 6: Saga Pattern for Distributed Transactions

When a business operation spans multiple services, sagas coordinate steps with compensating transactions:

```go
// saga/orchestrator.go
package saga

import (
	"context"
	"fmt"
	"log/slog"
)

// Step is one operation in a saga with its compensation.
type Step struct {
	Name      string
	Execute   func(ctx context.Context, state map[string]interface{}) error
	Compensate func(ctx context.Context, state map[string]interface{}) error
}

// Orchestrator runs saga steps and rolls back on failure.
type Orchestrator struct {
	steps []Step
}

func New(steps ...Step) *Orchestrator {
	return &Orchestrator{steps: steps}
}

// Run executes each step in order. On failure, all executed steps
// are compensated in reverse order.
func (o *Orchestrator) Run(ctx context.Context) error {
	state := make(map[string]interface{})
	var executed []int

	for i, step := range o.steps {
		slog.Info("executing saga step", "step", step.Name)
		if err := step.Execute(ctx, state); err != nil {
			slog.Error("saga step failed",
				"step", step.Name,
				"err", err,
			)
			// Compensate already-executed steps in reverse.
			for j := len(executed) - 1; j >= 0; j-- {
				s := o.steps[executed[j]]
				slog.Info("compensating saga step", "step", s.Name)
				if cErr := s.Compensate(ctx, state); cErr != nil {
					slog.Error("compensation failed",
						"step", s.Name,
						"err", cErr,
					)
				}
			}
			return fmt.Errorf("saga failed at step %q: %w", step.Name, err)
		}
		executed = append(executed, i)
	}

	return nil
}
```

### Order Fulfillment Saga

```go
// sagas/order.go
package sagas

import (
	"context"

	"myapp/saga"
	"myapp/service"
)

// NewOrderSaga creates a saga that spans inventory, payment, and shipping.
func NewOrderSaga(inv *service.InventoryService, pay *service.PaymentService, ship *service.ShippingService) *saga.Orchestrator {
	return saga.New(
		saga.Step{
			Name: "reserve_inventory",
			Execute: func(ctx context.Context, state map[string]interface{}) error {
				orderID := state["order_id"].(string)
				items := state["items"].([]service.OrderItem)
				reservationID, err := inv.Reserve(ctx, orderID, items)
				if err != nil {
					return err
				}
				state["reservation_id"] = reservationID
				return nil
			},
			Compensate: func(ctx context.Context, state map[string]interface{}) error {
				if id, ok := state["reservation_id"].(string); ok {
					return inv.CancelReservation(ctx, id)
				}
				return nil
			},
		},
		saga.Step{
			Name: "charge_payment",
			Execute: func(ctx context.Context, state map[string]interface{}) error {
				orderID := state["order_id"].(string)
				amount := state["amount"].(int64)
				chargeID, err := pay.Charge(ctx, orderID, amount)
				if err != nil {
					return err
				}
				state["charge_id"] = chargeID
				return nil
			},
			Compensate: func(ctx context.Context, state map[string]interface{}) error {
				if id, ok := state["charge_id"].(string); ok {
					return pay.Refund(ctx, id)
				}
				return nil
			},
		},
		saga.Step{
			Name: "create_shipment",
			Execute: func(ctx context.Context, state map[string]interface{}) error {
				orderID := state["order_id"].(string)
				shipmentID, err := ship.Create(ctx, orderID)
				if err != nil {
					return err
				}
				state["shipment_id"] = shipmentID
				return nil
			},
			Compensate: func(ctx context.Context, state map[string]interface{}) error {
				if id, ok := state["shipment_id"].(string); ok {
					return ship.Cancel(ctx, id)
				}
				return nil
			},
		},
	)
}
```

---

## Section 7: Service Discovery with Kubernetes DNS

In Kubernetes, service discovery is built into DNS. Configure clients to use the cluster DNS directly:

```go
// discovery/k8s.go
package discovery

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// K8sServiceAddress returns the in-cluster DNS address for a service.
// Format: <service-name>.<namespace>.svc.cluster.local:<port>
func K8sServiceAddress(service, namespace string, port int) string {
	return fmt.Sprintf("%s.%s.svc.cluster.local:%d", service, namespace, port)
}

// K8sHTTPClient creates an HTTP client pre-configured for in-cluster calls.
func K8sHTTPClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			MaxIdleConns:        50,
			MaxIdleConnsPerHost: 10,
			IdleConnTimeout:     30 * time.Second,
			// In-cluster traffic is unencrypted; use mTLS via a service mesh instead.
			DisableKeepAlives: false,
		},
		Timeout: 10 * time.Second,
	}
}

// K8sGRPCConn returns a gRPC connection for in-cluster services.
func K8sGRPCConn(service, namespace string, port int) (*grpc.ClientConn, error) {
	addr := K8sServiceAddress(service, namespace, port)
	return grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultServiceConfig(`{
			"loadBalancingConfig": [{"round_robin":{}}],
			"methodConfig": [{
				"name": [{}],
				"retryPolicy": {
					"maxAttempts": 4,
					"initialBackoff": "0.1s",
					"maxBackoff": "1s",
					"backoffMultiplier": 2,
					"retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
				}
			}]
		}`),
	)
}
```

---

## Section 8: Resilience Patterns — Retry, Timeout, Circuit Breaker

```go
// resilience/retry.go
package resilience

import (
	"context"
	"fmt"
	"math"
	"time"
)

// RetryConfig controls retry behavior.
type RetryConfig struct {
	MaxAttempts     int
	InitialInterval time.Duration
	MaxInterval     time.Duration
	Multiplier      float64
}

// DefaultRetryConfig is appropriate for most service calls.
var DefaultRetryConfig = RetryConfig{
	MaxAttempts:     4,
	InitialInterval: 100 * time.Millisecond,
	MaxInterval:     2 * time.Second,
	Multiplier:      2.0,
}

// Retry executes fn with exponential backoff.
func Retry(ctx context.Context, cfg RetryConfig, fn func(ctx context.Context) error) error {
	interval := cfg.InitialInterval

	for attempt := 1; attempt <= cfg.MaxAttempts; attempt++ {
		if err := fn(ctx); err == nil {
			return nil
		} else if attempt == cfg.MaxAttempts {
			return fmt.Errorf("all %d attempts failed: %w", cfg.MaxAttempts, err)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}

		interval = time.Duration(
			math.Min(float64(interval)*cfg.Multiplier, float64(cfg.MaxInterval)),
		)
	}
	return nil
}
```

These resilience primitives compose cleanly with the Kafka consumer, Connect handler, and gRPC client patterns to create a service mesh that degrades gracefully under load.
