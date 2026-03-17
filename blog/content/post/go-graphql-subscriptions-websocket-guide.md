---
title: "GraphQL Subscriptions in Go: Real-Time APIs with WebSockets and gqlgen"
date: 2028-11-30T00:00:00-05:00
draft: false
tags: ["Go", "GraphQL", "WebSocket", "Real-Time", "API"]
categories:
- Go
- GraphQL
author: "Matthew Mattox - mmattox@support.tools"
description: "Build production-grade GraphQL subscription servers in Go using gqlgen with WebSocket transport, Redis pub/sub fan-out, backpressure handling, and authentication middleware."
more_link: "yes"
url: "/go-graphql-subscriptions-websocket-guide/"
---

GraphQL subscriptions are the standard for pushing real-time data to clients through a persistent connection. Unlike polling or SSE, subscriptions layer a publish/subscribe semantic on top of the GraphQL execution model, allowing clients to declare exactly what data they want delivered whenever an event occurs. Go, with its goroutine-per-connection model and channel primitives, is an excellent fit for high-volume subscription servers.

This guide covers everything required to ship a production GraphQL subscription service in Go: schema definition, gqlgen channel-based resolvers, WebSocket transport, authentication, server-side filtering, backpressure, and scaling with Redis pub/sub.

<!--more-->

# GraphQL Subscriptions in Go

## Section 1: Project Setup and Schema Design

Start with a module and the gqlgen code-generation toolchain.

```bash
mkdir realtime-api && cd realtime-api
go mod init github.com/example/realtime-api

go get github.com/99designs/gqlgen@v0.17.49
go get github.com/99designs/gqlgen/graphql/handler/transport@v0.17.49
go get github.com/redis/go-redis/v9@v9.5.1
go get github.com/golang-jwt/jwt/v5@v5.2.1
go get nhooyr.io/websocket@v1.8.11

go run github.com/99designs/gqlgen init
```

Define the schema at `graph/schema.graphqls`:

```graphql
type Query {
  messages(roomID: ID!): [Message!]!
  room(id: ID!): Room
}

type Mutation {
  postMessage(input: PostMessageInput!): Message!
  createRoom(name: String!): Room!
}

type Subscription {
  messagePosted(roomID: ID!): Message!
  roomActivity(roomID: ID!): RoomEvent!
  systemAlerts(severity: AlertSeverity): Alert!
}

type Message {
  id:        ID!
  roomID:    ID!
  userID:    ID!
  body:      String!
  createdAt: String!
}

type Room {
  id:   ID!
  name: String!
}

type RoomEvent {
  type:   RoomEventType!
  roomID: ID!
  userID: ID!
}

type Alert {
  id:       ID!
  severity: AlertSeverity!
  message:  String!
  source:   String!
}

input PostMessageInput {
  roomID: ID!
  body:   String!
}

enum RoomEventType {
  USER_JOINED
  USER_LEFT
  TYPING
}

enum AlertSeverity {
  INFO
  WARNING
  CRITICAL
}
```

Generate the resolver stubs:

```bash
go run github.com/99designs/gqlgen generate
```

`gqlgen.yml` configuration for resolver location:

```yaml
schema:
  - graph/*.graphqls

exec:
  filename: graph/generated.go
  package: graph

model:
  filename: graph/model/models_gen.go
  package: model

resolver:
  layout: follow-schema
  dir: graph
  package: graph
  filename_template: "{name}.resolvers.go"

autobind:
  - "github.com/example/realtime-api/graph/model"
```

## Section 2: Domain Models and Event Bus

Define the in-process event bus before writing resolvers. The bus will later be backed by Redis for multi-instance deployments.

```go
// internal/bus/bus.go
package bus

import (
	"context"
	"sync"

	"github.com/example/realtime-api/graph/model"
)

// Topic keys
const (
	TopicMessage      = "message"
	TopicRoomActivity = "room_activity"
	TopicAlerts       = "alerts"
)

type EventBus struct {
	mu          sync.RWMutex
	subscribers map[string]map[string]chan any // topic -> subID -> ch
}

func New() *EventBus {
	return &EventBus{
		subscribers: make(map[string]map[string]chan any),
	}
}

// Subscribe returns a channel that receives events for the given topic.
// The caller must call the returned cancel function when done.
func (b *EventBus) Subscribe(ctx context.Context, topic string) (<-chan any, func()) {
	ch := make(chan any, 64) // buffered to absorb bursts
	subID := newID()

	b.mu.Lock()
	if b.subscribers[topic] == nil {
		b.subscribers[topic] = make(map[string]chan any)
	}
	b.subscribers[topic][subID] = ch
	b.mu.Unlock()

	cancel := func() {
		b.mu.Lock()
		delete(b.subscribers[topic], subID)
		close(ch)
		b.mu.Unlock()
	}

	// Auto-cancel when context is done.
	go func() {
		<-ctx.Done()
		cancel()
	}()

	return ch, cancel
}

// Publish sends an event to all subscribers of the given topic.
// Slow subscribers are skipped (non-blocking send) to prevent backpressure from
// one slow client from blocking all others.
func (b *EventBus) Publish(topic string, event any) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, ch := range b.subscribers[topic] {
		select {
		case ch <- event:
		default:
			// subscriber is slow; drop this event for them
		}
	}
}
```

```go
// internal/bus/id.go
package bus

import (
	"crypto/rand"
	"encoding/hex"
)

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
```

## Section 3: Subscription Resolvers

gqlgen subscription resolvers return a `<-chan T`. The resolver must create the channel, start a goroutine feeding it, and return immediately.

```go
// graph/subscription.resolvers.go
package graph

import (
	"context"
	"strings"

	"github.com/example/realtime-api/graph/model"
	"github.com/example/realtime-api/internal/bus"
)

// MessagePosted subscribes to new messages in a room.
func (r *subscriptionResolver) MessagePosted(
	ctx context.Context,
	roomID string,
) (<-chan *model.Message, error) {

	topic := bus.TopicMessage + ":" + roomID
	rawCh, _ := r.Bus.Subscribe(ctx, topic)

	out := make(chan *model.Message, 8)

	go func() {
		defer close(out)
		for raw := range rawCh {
			msg, ok := raw.(*model.Message)
			if !ok {
				continue
			}
			select {
			case out <- msg:
			case <-ctx.Done():
				return
			}
		}
	}()

	return out, nil
}

// RoomActivity subscribes to join/leave/typing events in a room.
func (r *subscriptionResolver) RoomActivity(
	ctx context.Context,
	roomID string,
) (<-chan *model.RoomEvent, error) {

	topic := bus.TopicRoomActivity + ":" + roomID
	rawCh, _ := r.Bus.Subscribe(ctx, topic)

	out := make(chan *model.RoomEvent, 8)

	go func() {
		defer close(out)
		for raw := range rawCh {
			ev, ok := raw.(*model.RoomEvent)
			if !ok {
				continue
			}
			select {
			case out <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()

	return out, nil
}

// SystemAlerts subscribes to alerts, optionally filtered by minimum severity.
func (r *subscriptionResolver) SystemAlerts(
	ctx context.Context,
	severity *model.AlertSeverity,
) (<-chan *model.Alert, error) {

	rawCh, _ := r.Bus.Subscribe(ctx, bus.TopicAlerts)
	out := make(chan *model.Alert, 8)

	go func() {
		defer close(out)
		for raw := range rawCh {
			alert, ok := raw.(*model.Alert)
			if !ok {
				continue
			}
			// Server-side filtering: skip alerts below requested severity.
			if severity != nil && !meetsSeverity(alert.Severity, *severity) {
				continue
			}
			select {
			case out <- alert:
			case <-ctx.Done():
				return
			}
		}
	}()

	return out, nil
}

// severityRank maps enum values to integers for comparison.
var severityRank = map[model.AlertSeverity]int{
	model.AlertSeverityInfo:     0,
	model.AlertSeverityWarning:  1,
	model.AlertSeverityCritical: 2,
}

func meetsSeverity(have, want model.AlertSeverity) bool {
	return severityRank[have] >= severityRank[want]
}

// subscriptionResolver is the concrete type that satisfies the generated interface.
type subscriptionResolver struct{ *Resolver }

func (r *Resolver) Subscription() SubscriptionResolver {
	return &subscriptionResolver{r}
}
```

## Section 4: Authentication Middleware for Subscriptions

WebSocket connections carry the auth token in the connection_init payload, not HTTP headers (the initial HTTP upgrade can carry a header, but many browser clients do not support custom headers for WebSocket upgrades).

```go
// internal/auth/auth.go
package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const userIDKey contextKey = "userID"

var ErrUnauthorized = errors.New("unauthorized")

type Claims struct {
	UserID string `json:"sub"`
	jwt.RegisteredClaims
}

func ParseToken(tokenString, secret string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{},
		func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return []byte(secret), nil
		},
	)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnauthorized, err)
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, ErrUnauthorized
	}
	return claims, nil
}

func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDKey, userID)
}

func UserIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(userIDKey).(string)
	return id, ok
}
```

The gqlgen transport exposes an `InitFunc` for WebSocket connections. Validate the token there:

```go
// graph/server.go
package graph

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/extension"
	"github.com/99designs/gqlgen/graphql/handler/lru"
	"github.com/99designs/gqlgen/graphql/handler/transport"
	"github.com/99designs/gqlgen/graphql/playground"
	"github.com/gorilla/websocket"

	"github.com/example/realtime-api/internal/auth"
	"github.com/example/realtime-api/internal/bus"
)

func NewServer(jwtSecret string, b *bus.EventBus) http.Handler {
	resolver := &Resolver{Bus: b}
	schema := NewExecutableSchema(Config{Resolvers: resolver})

	srv := handler.New(schema)

	// HTTP transports
	srv.AddTransport(transport.Options{})
	srv.AddTransport(transport.GET{})
	srv.AddTransport(transport.POST{})
	srv.AddTransport(transport.MultipartForm{})

	// WebSocket transport for subscriptions
	srv.AddTransport(transport.Websocket{
		KeepAlivePingInterval: 10 * time.Second,
		Upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// TODO: enforce allowed origins in production
				return true
			},
		},
		InitFunc: func(ctx context.Context, initPayload transport.InitPayload) (context.Context, *transport.InitPayload, error) {
			token, _ := initPayload["authToken"].(string)
			if token == "" {
				return nil, nil, auth.ErrUnauthorized
			}
			claims, err := auth.ParseToken(token, jwtSecret)
			if err != nil {
				return nil, nil, err
			}
			ctx = auth.WithUserID(ctx, claims.UserID)
			return ctx, &initPayload, nil
		},
	})

	srv.SetQueryCache(lru.New[any](1000))
	srv.Use(extension.Introspection{})
	srv.Use(extension.AutomaticPersistedQuery{Cache: lru.New[any](100)})

	mux := http.NewServeMux()
	mux.Handle("/query", srv)
	mux.Handle("/", playground.Handler("GraphQL Playground", "/query"))
	return mux
}
```

## Section 5: Backpressure and Slow-Consumer Handling

The buffer on the outbound channel (`make(chan *model.Message, 8)`) absorbs micro-bursts, but a truly slow consumer will fill it. Add a deadline-based drop strategy so one slow subscriber cannot block publishing goroutines.

```go
// internal/sub/safe_send.go
package sub

import (
	"context"
	"time"
)

// SendWithTimeout attempts to deliver v to ch within d.
// Returns false if the channel is full and the deadline is exceeded.
func SendWithTimeout[T any](ctx context.Context, ch chan<- T, v T, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case ch <- v:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}
```

Update the subscription resolver goroutine to use it:

```go
go func() {
    defer close(out)
    for raw := range rawCh {
        msg, ok := raw.(*model.Message)
        if !ok {
            continue
        }
        if !sub.SendWithTimeout(ctx, out, msg, 200*time.Millisecond) {
            // Log dropped event; optionally disconnect the slow client
            // by returning, which closes `out` and gqlgen terminates the subscription.
            return
        }
    }
}()
```

## Section 6: Scaling with Redis Pub/Sub

The in-process bus works for a single instance. For multiple replicas, replace it with Redis pub/sub.

```go
// internal/redisbus/redisbus.go
package redisbus

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/redis/go-redis/v9"
)

type RedisBus struct {
	client *redis.Client
	mu     sync.RWMutex
	locals map[string]map[string]chan []byte // topic -> subID -> ch
}

func New(client *redis.Client) *RedisBus {
	return &RedisBus{
		client: client,
		locals: make(map[string]map[string]chan []byte),
	}
}

// Subscribe to a Redis channel. The returned channel delivers raw JSON bytes.
func (b *RedisBus) Subscribe(ctx context.Context, topic string) (<-chan []byte, func()) {
	ch := make(chan []byte, 64)
	subID := newID()

	b.mu.Lock()
	if b.locals[topic] == nil {
		b.locals[topic] = make(map[string]chan []byte)
		// Start the Redis subscription goroutine for this topic only once.
		go b.listenRedis(topic)
	}
	b.locals[topic][subID] = ch
	b.mu.Unlock()

	cancel := func() {
		b.mu.Lock()
		delete(b.locals[topic], subID)
		close(ch)
		b.mu.Unlock()
	}

	go func() {
		<-ctx.Done()
		cancel()
	}()

	return ch, cancel
}

func (b *RedisBus) listenRedis(topic string) {
	pubsub := b.client.Subscribe(context.Background(), topic)
	defer pubsub.Close()

	ch := pubsub.Channel()
	for msg := range ch {
		b.fanout(topic, []byte(msg.Payload))
	}
}

func (b *RedisBus) fanout(topic string, payload []byte) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, ch := range b.locals[topic] {
		select {
		case ch <- payload:
		default:
		}
	}
}

// Publish serializes v to JSON and publishes it to Redis.
func (b *RedisBus) Publish(ctx context.Context, topic string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return b.client.Publish(ctx, topic, data).Err()
}
```

```go
// internal/redisbus/id.go
package redisbus

import (
	"crypto/rand"
	"encoding/hex"
)

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
```

Wire the Redis bus in `main.go`:

```go
// cmd/server/main.go
package main

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/redis/go-redis/v9"

	"github.com/example/realtime-api/graph"
	"github.com/example/realtime-api/internal/redisbus"
)

func main() {
	rdb := redis.NewClient(&redis.Options{
		Addr:     envOrDefault("REDIS_ADDR", "localhost:6379"),
		Password: os.Getenv("REDIS_PASSWORD"),
		DB:       0,
	})

	b := redisbus.New(rdb)
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		slog.Error("JWT_SECRET not set")
		os.Exit(1)
	}

	srv := graph.NewServer(jwtSecret, b)

	addr := envOrDefault("LISTEN_ADDR", ":8080")
	slog.Info("starting server", "addr", addr)
	if err := http.ListenAndServe(addr, srv); err != nil {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
```

## Section 7: Mutation that Triggers a Subscription Event

The mutation resolver publishes to the bus so all subscribers to the relevant room receive the new message.

```go
// graph/mutation.resolvers.go
package graph

import (
	"context"
	"fmt"
	"time"

	"github.com/example/realtime-api/graph/model"
	"github.com/example/realtime-api/internal/auth"
	"github.com/example/realtime-api/internal/bus"
)

func (r *mutationResolver) PostMessage(
	ctx context.Context,
	input model.PostMessageInput,
) (*model.Message, error) {
	userID, ok := auth.UserIDFromContext(ctx)
	if !ok {
		return nil, fmt.Errorf("unauthenticated")
	}

	msg := &model.Message{
		ID:        newID(),
		RoomID:    input.RoomID,
		UserID:    userID,
		Body:      input.Body,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}

	// Persist to DB here (omitted for brevity).

	// Publish to all subscribers of this room.
	topic := bus.TopicMessage + ":" + input.RoomID
	r.Bus.Publish(topic, msg)

	return msg, nil
}

type mutationResolver struct{ *Resolver }

func (r *Resolver) Mutation() MutationResolver { return &mutationResolver{r} }
```

## Section 8: Testing Subscriptions

gqlgen provides a test client that drives the schema without a real network connection.

```go
// graph/subscription_test.go
package graph_test

import (
	"context"
	"testing"
	"time"

	"github.com/99designs/gqlgen/client"
	"github.com/99designs/gqlgen/graphql/handler"

	"github.com/example/realtime-api/graph"
	"github.com/example/realtime-api/internal/auth"
	"github.com/example/realtime-api/internal/bus"
)

func TestMessagePostedSubscription(t *testing.T) {
	b := bus.New()
	resolver := &graph.Resolver{Bus: b}
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: resolver})

	srv := handler.NewDefaultServer(schema)
	c := client.New(srv)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Inject a user into context to satisfy auth checks.
	ctx = auth.WithUserID(ctx, "user-1")

	sub := c.Websocket(`
		subscription {
			messagePosted(roomID: "room-1") {
				id body userID roomID
			}
		}
	`)
	defer sub.Close()

	// Publish a message concurrently.
	go func() {
		time.Sleep(50 * time.Millisecond)
		b.Publish(bus.TopicMessage+":room-1", &graph.model.Message{
			ID:     "msg-1",
			RoomID: "room-1",
			UserID: "user-1",
			Body:   "hello",
		})
	}()

	var resp struct {
		MessagePosted struct {
			ID   string
			Body string
		}
	}
	if err := sub.Next(&resp); err != nil {
		t.Fatalf("Next() error: %v", err)
	}
	if resp.MessagePosted.Body != "hello" {
		t.Errorf("expected 'hello', got %q", resp.MessagePosted.Body)
	}
}

func TestSystemAlertsFiltering(t *testing.T) {
	b := bus.New()
	resolver := &graph.Resolver{Bus: b}
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: resolver})
	srv := handler.NewDefaultServer(schema)
	c := client.New(srv)

	sub := c.Websocket(`
		subscription {
			systemAlerts(severity: CRITICAL) {
				id severity message
			}
		}
	`)
	defer sub.Close()

	go func() {
		time.Sleep(20 * time.Millisecond)
		// This INFO alert should be filtered out.
		b.Publish(bus.TopicAlerts, &graph.model.Alert{
			ID:       "a1",
			Severity: graph.model.AlertSeverityInfo,
			Message:  "disk 80% full",
			Source:   "node-1",
		})
		time.Sleep(20 * time.Millisecond)
		// This CRITICAL alert should arrive.
		b.Publish(bus.TopicAlerts, &graph.model.Alert{
			ID:       "a2",
			Severity: graph.model.AlertSeverityCritical,
			Message:  "OOM kill",
			Source:   "node-2",
		})
	}()

	var resp struct {
		SystemAlerts struct {
			ID       string
			Severity string
			Message  string
		}
	}
	if err := sub.Next(&resp); err != nil {
		t.Fatalf("Next() error: %v", err)
	}
	if resp.SystemAlerts.ID != "a2" {
		t.Errorf("expected critical alert a2, got %q", resp.SystemAlerts.ID)
	}
}
```

## Section 9: Client-Side Connection with graphql-ws

The canonical JavaScript client for gqlgen subscriptions is `graphql-ws`:

```typescript
// frontend/src/subscriptionClient.ts
import { createClient } from "graphql-ws";

const client = createClient({
  url: "ws://localhost:8080/query",
  connectionParams: async () => {
    const token = await getAuthToken(); // fetch from storage
    return { authToken: token };
  },
  retryAttempts: 5,
  on: {
    connected: () => console.log("ws connected"),
    error: (err) => console.error("ws error", err),
  },
});

// Subscribe to messages in a room.
const unsubscribe = client.subscribe(
  {
    query: `
      subscription MessagePosted($roomID: ID!) {
        messagePosted(roomID: $roomID) {
          id body userID createdAt
        }
      }
    `,
    variables: { roomID: "room-42" },
  },
  {
    next: ({ data }) => console.log("new message", data?.messagePosted),
    error: (err) => console.error("subscription error", err),
    complete: () => console.log("subscription complete"),
  }
);

// Tear down when component unmounts.
// unsubscribe();
```

## Section 10: Kubernetes Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: realtime-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: realtime-api
  template:
    metadata:
      labels:
        app: realtime-api
    spec:
      containers:
        - name: api
          image: ghcr.io/example/realtime-api:v1.2.0
          ports:
            - containerPort: 8080
          env:
            - name: REDIS_ADDR
              value: "redis-service:6379"
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: realtime-api-secrets
                  key: jwt-secret
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "256Mi"
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: realtime-api
  namespace: production
spec:
  selector:
    app: realtime-api
  ports:
    - port: 80
      targetPort: 8080
---
# WebSocket connections require session affinity when not using Redis
# fan-out. With Redis pub/sub, any replica serves any client.
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: realtime-api
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-http-version: "1.1"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "Upgrade";
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /query
            pathType: Prefix
            backend:
              service:
                name: realtime-api
                port:
                  number: 80
```

## Section 11: Operational Considerations

**Connection limits.** Each WebSocket subscription holds a goroutine (the fan-out loop) and a channel. At 10 000 concurrent subscribers and 2 KB per goroutine stack, expect roughly 20 MB baseline. Profile with `pprof` under load.

**Heartbeats.** The `KeepAlivePingInterval` in the transport config sends WebSocket ping frames. Set it to less than any load balancer or firewall idle-connection timeout (typically 60 s).

**Graceful shutdown.** Cancel the root context passed to the server on SIGTERM. All subscription resolver goroutines observing `ctx.Done()` will drain and close their output channels, which causes gqlgen to send a `complete` message to each client.

```go
// Graceful shutdown wiring in main.go
ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
defer stop()

httpSrv := &http.Server{Addr: addr, Handler: graph.NewServer(jwtSecret, b)}

go func() {
    <-ctx.Done()
    shutCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    _ = httpSrv.Shutdown(shutCtx)
}()

if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
    slog.Error("server error", "err", err)
    os.Exit(1)
}
```

**Metrics.** Track active subscription count with a Prometheus gauge, incremented on subscribe and decremented on resolver goroutine exit:

```go
var activeSubscriptions = promauto.NewGaugeVec(prometheus.GaugeOpts{
    Name: "graphql_active_subscriptions_total",
    Help: "Number of active GraphQL subscriptions.",
}, []string{"operation"})
```

GraphQL subscriptions in Go with gqlgen are straightforward once the channel contract is understood: return a typed read-only channel, feed it from a goroutine observing `ctx.Done()`, and close it on exit. Redis pub/sub provides horizontal scaling with minimal code changes. The patterns above give a foundation for any real-time feature from live dashboards to collaborative editing.
