---
title: "WebSocket Production Patterns in Go: Hub Architecture and Scaling"
date: 2028-03-26T00:00:00-05:00
draft: false
tags: ["Go", "WebSocket", "Redis", "Concurrency", "Production", "Scaling", "gorilla"]
categories: ["Go", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to WebSocket server implementation in Go covering the hub pattern, connection lifecycle, JWT authentication, Redis pub/sub horizontal scaling, graceful shutdown, rate limiting, and load balancer configuration."
more_link: "yes"
url: "/go-websocket-production-patterns-guide/"
---

WebSocket connections in Go require a fundamentally different mental model than HTTP handlers. Where HTTP is stateless and handlers complete in milliseconds, WebSocket connections persist for minutes or hours, require their own goroutines, and must coordinate state across a potentially large number of concurrent connections. This guide builds a production-ready WebSocket server from first principles, addressing every concern that arises when moving from a prototype to a system handling tens of thousands of concurrent connections.

<!--more-->

## Hub Architecture Overview

The hub pattern is the canonical approach to managing WebSocket broadcast in Go. A single goroutine — the hub — owns all connection state and serializes all mutations to that state. Individual connection goroutines communicate with the hub through typed channels, eliminating data races without explicit locking.

```
┌─────────────────────────────────────────────┐
│                  Hub Goroutine               │
│                                             │
│  clients map[*Client]bool                   │
│  register   chan *Client                    │
│  unregister chan *Client                    │
│  broadcast  chan Message                    │
│                                             │
└──────────────────┬──────────────────────────┘
                   │ channels
    ┌──────────────┼──────────────┐
    │              │              │
┌───▼──┐      ┌───▼──┐      ┌───▼──┐
│Client│      │Client│      │Client│
│  R/W │      │  R/W │      │  R/W │
│gorout│      │gorout│      │gorout│
└──────┘      └──────┘      └──────┘
  read          read          read
  gorout        gorout        gorout
```

Each client connection spawns two goroutines: one for reading from the WebSocket (blocking on `conn.ReadMessage()`) and one for writing (blocking on a channel). The hub goroutine handles all state changes.

## Core Types

```go
package hub

import (
    "context"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

// MessageType classifies WebSocket messages for routing.
type MessageType string

const (
    MessageTypeChat        MessageType = "chat"
    MessageTypePresence    MessageType = "presence"
    MessageTypeSystem      MessageType = "system"
    MessageTypePing        MessageType = "ping"
    MessageTypePong        MessageType = "pong"
)

// Message is the canonical wire format for all WebSocket messages.
type Message struct {
    Type      MessageType `json:"type"`
    RoomID    string      `json:"room_id,omitempty"`
    UserID    string      `json:"user_id,omitempty"`
    Payload   []byte      `json:"payload"`
    Timestamp time.Time   `json:"timestamp"`
}

// Client represents a single connected WebSocket peer.
type Client struct {
    hub      *Hub
    conn     *websocket.Conn
    send     chan Message
    userID   string
    roomIDs  map[string]bool
    mu       sync.RWMutex

    // Rate limiting state
    msgCount    int64
    windowStart time.Time

    // Connection metadata
    remoteAddr string
    connectedAt time.Time
}

// Hub maintains the set of active clients and routes messages.
type Hub struct {
    // Registered clients
    clients map[*Client]bool

    // Inbound messages from clients
    broadcast chan Message

    // Register requests from clients
    register chan *Client

    // Unregister requests from clients
    unregister chan *Client

    // Room subscriptions: roomID -> set of clients
    rooms map[string]map[*Client]bool

    // Metrics
    connectedClients int64
    messagesRelayed  int64

    // Shutdown signal
    quit chan struct{}
    done chan struct{}
}

// NewHub creates a hub ready to run.
func NewHub() *Hub {
    return &Hub{
        broadcast:  make(chan Message, 256),
        register:   make(chan *Client, 64),
        unregister: make(chan *Client, 64),
        clients:    make(map[*Client]bool),
        rooms:      make(map[string]map[*Client]bool),
        quit:       make(chan struct{}),
        done:       make(chan struct{}),
    }
}
```

## Hub Run Loop

The hub's `Run` method is a single-goroutine event loop. Every mutation to `clients` and `rooms` happens here, making the data structures inherently thread-safe without locks:

```go
// Run processes all hub events until shutdown is requested.
func (h *Hub) Run(ctx context.Context) {
    defer close(h.done)

    // Drain connections on shutdown
    defer func() {
        for client := range h.clients {
            h.disconnectClient(client, "server shutdown")
        }
    }()

    for {
        select {
        case <-ctx.Done():
            return

        case <-h.quit:
            return

        case client := <-h.register:
            h.clients[client] = true
            atomic.AddInt64(&h.connectedClients, 1)

        case client := <-h.unregister:
            if _, ok := h.clients[client]; ok {
                h.removeClientFromRooms(client)
                delete(h.clients, client)
                close(client.send)
                atomic.AddInt64(&h.connectedClients, -1)
            }

        case message := <-h.broadcast:
            h.routeMessage(message)
        }
    }
}

func (h *Hub) routeMessage(msg Message) {
    atomic.AddInt64(&h.messagesRelayed, 1)

    if msg.RoomID != "" {
        // Room-scoped broadcast
        if room, ok := h.rooms[msg.RoomID]; ok {
            for client := range room {
                select {
                case client.send <- msg:
                default:
                    // Client send buffer full — disconnect slow consumer
                    h.disconnectClient(client, "send buffer overflow")
                }
            }
        }
        return
    }

    // Global broadcast
    for client := range h.clients {
        select {
        case client.send <- msg:
        default:
            h.disconnectClient(client, "send buffer overflow")
        }
    }
}

func (h *Hub) disconnectClient(client *Client, reason string) {
    if _, ok := h.clients[client]; !ok {
        return
    }
    h.removeClientFromRooms(client)
    delete(h.clients, client)
    close(client.send)
    atomic.AddInt64(&h.connectedClients, -1)
}

func (h *Hub) removeClientFromRooms(client *Client) {
    client.mu.RLock()
    roomIDs := make([]string, 0, len(client.roomIDs))
    for roomID := range client.roomIDs {
        roomIDs = append(roomIDs, roomID)
    }
    client.mu.RUnlock()

    for _, roomID := range roomIDs {
        if room, ok := h.rooms[roomID]; ok {
            delete(room, client)
            if len(room) == 0 {
                delete(h.rooms, roomID)
            }
        }
    }
}
```

## Connection Lifecycle Management

### WebSocket Upgrader Configuration

```go
package server

import (
    "net/http"
    "strings"
    "time"

    "github.com/gorilla/websocket"
)

const (
    writeWait      = 10 * time.Second
    pongWait       = 60 * time.Second
    pingPeriod     = (pongWait * 9) / 10   // 54 seconds
    maxMessageSize = 512 * 1024            // 512KB
    sendBufferSize = 256
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  4096,
    WriteBufferSize: 4096,
    // Production: validate Origin header against allowed origins list
    CheckOrigin: func(r *http.Request) bool {
        origin := r.Header.Get("Origin")
        if origin == "" {
            return false
        }
        allowed := []string{
            "https://app.example.com",
            "https://staging.example.com",
        }
        for _, o := range allowed {
            if strings.EqualFold(origin, o) {
                return true
            }
        }
        return false
    },
    HandshakeTimeout: 10 * time.Second,
    Subprotocols:     []string{"v1.chat.example.com"},
}
```

### JWT Authentication During Handshake

Authentication must happen before the upgrade. The HTTP handshake is the only point where standard HTTP middleware (cookies, headers) is available:

```go
package server

import (
    "fmt"
    "net/http"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
    "github.com/gorilla/websocket"
)

type Claims struct {
    UserID    string   `json:"sub"`
    RoomIDs   []string `json:"room_ids"`
    jwt.RegisteredClaims
}

func (s *Server) ServeWebSocket(w http.ResponseWriter, r *http.Request) {
    // 1. Authenticate before upgrading — HTTP errors are still possible here
    claims, err := s.authenticateRequest(r)
    if err != nil {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    // 2. Rate limit connections per user
    if !s.connRateLimiter.Allow(claims.UserID) {
        http.Error(w, "Too Many Connections", http.StatusTooManyRequests)
        return
    }

    // 3. Upgrade the HTTP connection to WebSocket
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        // upgrader has already written the error response
        s.logger.Error("websocket upgrade failed", "error", err, "remote", r.RemoteAddr)
        return
    }

    // 4. Configure connection limits
    conn.SetReadLimit(maxMessageSize)

    // 5. Create and register the client
    client := &hub.Client{
        UserID:      claims.UserID,
        RoomIDs:     make(map[string]bool),
        RemoteAddr:  r.RemoteAddr,
        ConnectedAt: time.Now(),
    }
    // Internal fields set through constructor
    client = hub.NewClient(s.hub, conn, claims.UserID)

    s.hub.Register <- client

    // 6. Start I/O goroutines (non-blocking: hub manages lifecycle)
    go client.WritePump()
    go client.ReadPump()
}

func (s *Server) authenticateRequest(r *http.Request) (*Claims, error) {
    tokenStr := ""

    // Check Authorization header first
    auth := r.Header.Get("Authorization")
    if strings.HasPrefix(auth, "Bearer ") {
        tokenStr = strings.TrimPrefix(auth, "Bearer ")
    }

    // Fall back to query parameter (for clients that cannot set headers)
    if tokenStr == "" {
        tokenStr = r.URL.Query().Get("token")
    }

    if tokenStr == "" {
        return nil, fmt.Errorf("no token provided")
    }

    claims := &Claims{}
    token, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
        if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return s.jwtSecret, nil
    })

    if err != nil || !token.Valid {
        return nil, fmt.Errorf("invalid token: %w", err)
    }

    return claims, nil
}
```

### Read and Write Pumps

```go
// ReadPump pumps messages from the WebSocket connection to the hub.
// A goroutine running ReadPump is started for each connection.
// The application ensures there is at most one reader on a connection by
// executing all reads from this goroutine.
func (c *Client) ReadPump() {
    defer func() {
        c.hub.Unregister <- c
        c.conn.Close()
    }()

    c.conn.SetReadLimit(maxMessageSize)
    c.conn.SetReadDeadline(time.Now().Add(pongWait))
    c.conn.SetPongHandler(func(string) error {
        c.conn.SetReadDeadline(time.Now().Add(pongWait))
        return nil
    })

    for {
        _, rawMsg, err := c.conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err,
                websocket.CloseGoingAway,
                websocket.CloseAbnormalClosure,
                websocket.CloseNormalClosure,
            ) {
                c.hub.logger.Warn("unexpected websocket close",
                    "user_id", c.userID,
                    "error", err,
                )
            }
            return
        }

        // Rate limit inbound messages
        if !c.checkMessageRateLimit() {
            c.sendSystemMessage("rate_limit_exceeded", "Message rate limit exceeded")
            continue
        }

        msg, err := parseMessage(rawMsg)
        if err != nil {
            c.sendSystemMessage("parse_error", "Invalid message format")
            continue
        }

        msg.UserID = c.userID
        msg.Timestamp = time.Now().UTC()

        c.hub.Broadcast <- msg
    }
}

// WritePump pumps messages from the hub to the WebSocket connection.
// A goroutine running WritePump is started for each connection.
// The application ensures there is at most one writer to a connection by
// executing all writes from this goroutine.
func (c *Client) WritePump() {
    ticker := time.NewTicker(pingPeriod)
    defer func() {
        ticker.Stop()
        c.conn.Close()
    }()

    for {
        select {
        case message, ok := <-c.send:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if !ok {
                // Hub closed the channel — send close frame
                c.conn.WriteMessage(websocket.CloseMessage,
                    websocket.FormatCloseMessage(websocket.CloseNormalClosure, "server closing"),
                )
                return
            }

            w, err := c.conn.NextWriter(websocket.TextMessage)
            if err != nil {
                return
            }

            if err := json.NewEncoder(w).Encode(message); err != nil {
                w.Close()
                return
            }

            // Drain any additional pending messages into the same WebSocket frame
            // to improve throughput under load
            n := len(c.send)
            for i := 0; i < n; i++ {
                additional := <-c.send
                if err := json.NewEncoder(w).Encode(additional); err != nil {
                    break
                }
            }

            if err := w.Close(); err != nil {
                return
            }

        case <-ticker.C:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }
}
```

## Ping/Pong Keepalive

The ping/pong mechanism in gorilla/websocket uses the WebSocket protocol's built-in control frames. The server sends ping frames on a regular interval; the client (browser or native client) automatically responds with pong frames. If no pong is received within `pongWait`, the read deadline expires and `ReadMessage` returns an error, triggering cleanup.

```go
const (
    // pongWait: how long to wait for a pong before considering the connection dead
    pongWait = 60 * time.Second

    // pingPeriod: how often to send pings
    // Must be less than pongWait to allow time for the pong to arrive
    pingPeriod = 54 * time.Second
)

// The pong handler resets the read deadline every time a pong arrives,
// keeping the connection alive as long as the client is responsive.
c.conn.SetPongHandler(func(appData string) error {
    return c.conn.SetReadDeadline(time.Now().Add(pongWait))
})
```

## Connection Rate Limiting

```go
package ratelimit

import (
    "sync"
    "time"
)

// ConnectionLimiter tracks concurrent connections per user.
type ConnectionLimiter struct {
    mu          sync.Mutex
    connections map[string]int
    maxPerUser  int
}

// MessageRateLimiter enforces messages-per-second per connection.
type MessageRateLimiter struct {
    mu          sync.Mutex
    windowSize  time.Duration
    maxMessages int
    counts      map[string]*windowCounter
}

type windowCounter struct {
    count       int
    windowStart time.Time
}

func NewMessageRateLimiter(windowSize time.Duration, maxMessages int) *MessageRateLimiter {
    rl := &MessageRateLimiter{
        windowSize:  windowSize,
        maxMessages: maxMessages,
        counts:      make(map[string]*windowCounter),
    }
    go rl.cleanup()
    return rl
}

func (rl *MessageRateLimiter) Allow(userID string) bool {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    now := time.Now()
    counter, ok := rl.counts[userID]
    if !ok || now.Sub(counter.windowStart) > rl.windowSize {
        rl.counts[userID] = &windowCounter{count: 1, windowStart: now}
        return true
    }

    counter.count++
    return counter.count <= rl.maxMessages
}

func (rl *MessageRateLimiter) cleanup() {
    ticker := time.NewTicker(5 * time.Minute)
    defer ticker.Stop()
    for range ticker.C {
        rl.mu.Lock()
        cutoff := time.Now().Add(-rl.windowSize * 2)
        for id, counter := range rl.counts {
            if counter.windowStart.Before(cutoff) {
                delete(rl.counts, id)
            }
        }
        rl.mu.Unlock()
    }
}
```

## Horizontal Scaling with Redis Pub/Sub

A single-instance hub cannot serve connections distributed across multiple pods. Redis pub/sub acts as the cross-process message bus, allowing any pod to broadcast to connections on any other pod.

```go
package redishub

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"

    "github.com/redis/go-redis/v9"
)

const (
    globalChannel  = "ws:broadcast:global"
    roomChannelFmt = "ws:broadcast:room:%s"
)

// RedisHub wraps a local Hub with Redis pub/sub for cross-pod messaging.
type RedisHub struct {
    localHub *Hub
    client   *redis.Client
    logger   *slog.Logger
}

func NewRedisHub(localHub *Hub, redisClient *redis.Client, logger *slog.Logger) *RedisHub {
    return &RedisHub{
        localHub: localHub,
        client:   redisClient,
        logger:   logger,
    }
}

// Publish sends a message to all pods via Redis.
func (rh *RedisHub) Publish(ctx context.Context, msg Message) error {
    payload, err := json.Marshal(msg)
    if err != nil {
        return fmt.Errorf("marshal message: %w", err)
    }

    channel := globalChannel
    if msg.RoomID != "" {
        channel = fmt.Sprintf(roomChannelFmt, msg.RoomID)
    }

    return rh.client.Publish(ctx, channel, payload).Err()
}

// Subscribe starts consuming messages from Redis and forwarding them to the local hub.
func (rh *RedisHub) Subscribe(ctx context.Context) error {
    pubsub := rh.client.Subscribe(ctx, globalChannel)

    // Dynamically subscribe to room channels as rooms are created
    go rh.manageRoomSubscriptions(ctx, pubsub)

    ch := pubsub.Channel()
    for {
        select {
        case <-ctx.Done():
            return pubsub.Close()
        case redisMsg, ok := <-ch:
            if !ok {
                return fmt.Errorf("redis subscription channel closed")
            }

            var msg Message
            if err := json.Unmarshal([]byte(redisMsg.Payload), &msg); err != nil {
                rh.logger.Error("failed to unmarshal redis message", "error", err)
                continue
            }

            // Deliver to local connections only
            rh.localHub.Broadcast <- msg
        }
    }
}

func (rh *RedisHub) manageRoomSubscriptions(ctx context.Context, pubsub *redis.PubSub) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            // Subscribe to any rooms that have local clients
            activeRooms := rh.localHub.ActiveRooms()
            channels := make([]string, 0, len(activeRooms))
            for _, roomID := range activeRooms {
                channels = append(channels, fmt.Sprintf(roomChannelFmt, roomID))
            }
            if len(channels) > 0 {
                if err := pubsub.Subscribe(ctx, channels...); err != nil {
                    rh.logger.Error("room subscription failed", "error", err)
                }
            }
        }
    }
}
```

### Redis Connection Pool Configuration

```go
func newRedisClient(addr string) *redis.Client {
    return redis.NewClient(&redis.Options{
        Addr:            addr,
        MaxRetries:      3,
        MinRetryBackoff: 8 * time.Millisecond,
        MaxRetryBackoff: 512 * time.Millisecond,
        DialTimeout:     5 * time.Second,
        ReadTimeout:     3 * time.Second,
        WriteTimeout:    3 * time.Second,
        PoolSize:        10,
        MinIdleConns:    2,
        ConnMaxIdleTime: 5 * time.Minute,
    })
}
```

## Graceful Shutdown

Graceful shutdown must drain all in-flight messages and close connections cleanly before the process exits:

```go
func (s *Server) Shutdown(ctx context.Context) error {
    s.logger.Info("starting graceful websocket shutdown")

    // 1. Stop accepting new WebSocket upgrades
    s.acceptingConnections.Store(false)

    // 2. Signal hub to stop (closes all send channels → WritePump exits → connections close)
    close(s.hub.quit)

    // 3. Wait for hub to finish draining with a deadline
    select {
    case <-s.hub.done:
        s.logger.Info("hub drained cleanly")
    case <-ctx.Done():
        s.logger.Warn("hub drain timed out, forcing shutdown")
    }

    // 4. Wait for HTTP server to finish
    return s.httpServer.Shutdown(ctx)
}

// In main():
func main() {
    hub := hub.NewHub()
    server := server.New(hub)

    go hub.Run(context.Background())

    // Handle SIGTERM and SIGINT
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        if err := server.ListenAndServe(":8080"); err != nil && err != http.ErrServerClosed {
            log.Fatal(err)
        }
    }()

    <-sigCh
    log.Println("shutdown signal received")

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        log.Printf("shutdown error: %v", err)
        os.Exit(1)
    }

    log.Println("server shut down cleanly")
}
```

## WebSocket Load Balancing with Sticky Sessions

WebSocket connections are stateful and must route to the same pod for their lifetime. Configure sticky sessions at the ingress layer:

### NGINX Ingress (legacy)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: websocket-ingress
  annotations:
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "WS_ROUTE"
    nginx.ingress.kubernetes.io/session-cookie-expires: "172800"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "172800"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/upstream-hash-by: "$http_x_user_id"
spec:
  rules:
    - host: ws.example.com
      http:
        paths:
          - path: /ws
            pathType: Prefix
            backend:
              service:
                name: websocket-service
                port:
                  number: 8080
```

### Gateway API with Envoy BackendLBPolicy

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendLBPolicy
metadata:
  name: websocket-sticky
  namespace: production
spec:
  targetRef:
    group: ""
    kind: Service
    name: websocket-service
  sessionPersistence:
    sessionName: WS_ROUTE
    type: Cookie
    cookieConfig:
      lifetimeType: Persistent
      ttl: 48h
```

## Kubernetes Deployment Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: websocket-server
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: websocket-server
  template:
    metadata:
      labels:
        app: websocket-server
    spec:
      # Ensure graceful shutdown waits for connections to drain
      terminationGracePeriodSeconds: 60
      containers:
        - name: websocket-server
          image: registry.example.com/websocket-server:v1.2.0
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: metrics
          env:
            - name: REDIS_ADDR
              valueFrom:
                secretKeyRef:
                  name: redis-credentials
                  key: addr
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: jwt-credentials
                  key: secret
          resources:
            requests:
              cpu: 500m
              memory: 256Mi
            limits:
              cpu: 2000m
              memory: 1Gi
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz/live
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
          lifecycle:
            preStop:
              exec:
                # Signal the server to stop accepting new connections
                # before Kubernetes removes it from the service endpoints
                command: ["/bin/sh", "-c", "sleep 10"]
```

## Metrics and Observability

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    ConnectedClients = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "websocket_connected_clients",
        Help: "Number of currently connected WebSocket clients",
    })

    MessagesReceived = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "websocket_messages_received_total",
        Help: "Total number of WebSocket messages received",
    }, []string{"message_type"})

    MessagesSent = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "websocket_messages_sent_total",
        Help: "Total number of WebSocket messages sent",
    }, []string{"message_type"})

    ConnectionDuration = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "websocket_connection_duration_seconds",
        Help:    "Duration of WebSocket connections",
        Buckets: []float64{1, 10, 60, 300, 600, 1800, 3600},
    })

    UpgradeFailures = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "websocket_upgrade_failures_total",
        Help: "Total number of failed WebSocket upgrade attempts",
    }, []string{"reason"})

    SendBufferOverflows = promauto.NewCounter(prometheus.CounterOpts{
        Name: "websocket_send_buffer_overflow_total",
        Help: "Number of client disconnections due to full send buffer",
    })
)
```

## Testing Concurrent Connections

```go
package main

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

// LoadTest simulates concurrent WebSocket connections.
func LoadTest(serverURL string, numClients int, testDuration time.Duration) {
    var wg sync.WaitGroup
    errors := make(chan error, numClients)

    start := time.Now()
    fmt.Printf("Starting %d concurrent WebSocket connections...\n", numClients)

    for i := 0; i < numClients; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()

            header := http.Header{}
            header.Set("Authorization", "Bearer test-token-"+fmt.Sprint(id))

            conn, _, err := websocket.DefaultDialer.Dial(serverURL, header)
            if err != nil {
                errors <- fmt.Errorf("client %d: dial failed: %w", id, err)
                return
            }
            defer conn.Close()

            // Send and receive for testDuration
            deadline := time.After(testDuration)
            ticker := time.NewTicker(100 * time.Millisecond)
            defer ticker.Stop()

            for {
                select {
                case <-deadline:
                    return
                case <-ticker.C:
                    msg := []byte(fmt.Sprintf(`{"type":"chat","payload":"hello from %d"}`, id))
                    if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
                        errors <- fmt.Errorf("client %d: write failed: %w", id, err)
                        return
                    }
                }
            }
        }(i)
    }

    wg.Wait()
    close(errors)

    elapsed := time.Since(start)
    errorCount := 0
    for err := range errors {
        errorCount++
        fmt.Printf("Error: %v\n", err)
    }

    fmt.Printf("Test complete: %d clients, %v duration, %d errors\n",
        numClients, elapsed, errorCount)
}
```

## Summary

Production WebSocket servers in Go require careful attention to connection lifecycle, concurrency primitives, and horizontal scaling. The hub pattern provides the correct foundation by serializing all shared state mutations through a single goroutine. JWT authentication at the HTTP handshake phase provides security without WebSocket protocol changes. Redis pub/sub enables scaling across pods without sticky session limitations becoming a bottleneck.

Key operational rules: always set read deadlines, always implement ping/pong keepalive, always handle slow consumers by disconnecting rather than blocking the hub, and always implement graceful shutdown with a drain period that matches the load balancer's connection draining timeout.
