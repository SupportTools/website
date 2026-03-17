---
title: "Go WebSocket Implementation: Real-Time Communication Patterns for Production Services"
date: 2030-06-27T00:00:00-05:00
draft: false
tags: ["Go", "WebSocket", "Real-Time", "gorilla/websocket", "Redis", "Production", "Concurrency"]
categories:
- Go
- Networking
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise WebSocket guide in Go: gorilla/websocket vs nhooyr.io/websocket, hub pattern, connection lifecycle management, backpressure handling, authentication, and horizontal scaling with Redis pub/sub."
more_link: "yes"
url: "/go-websocket-real-time-communication-production-patterns/"
---

WebSocket connections are deceptively simple to open and catastrophically difficult to operate at scale. Every connection is a persistent goroutine and a set of open file descriptors. Backpressure from slow clients cascades into memory exhaustion. Authentication tokens expire mid-connection. Horizontal scaling requires broadcasting across process boundaries. The gap between a WebSocket demo and a production WebSocket service that serves 100,000 concurrent connections reliably is measured in months of incident response experience.

<!--more-->

## Library Selection: gorilla/websocket vs nhooyr.io/websocket

### gorilla/websocket

gorilla/websocket has been the de-facto standard for Go WebSocket implementations for over a decade. Its API maps directly to the WebSocket protocol: upgrade an HTTP connection, then read and write frames explicitly.

```go
import "github.com/gorilla/websocket"
```

Characteristics:
- Explicit frame-level control (message type, fragmentation)
- Supports all WebSocket frame types (text, binary, ping, pong, close)
- Requires explicit concurrent read/write protection (one reader goroutine, one writer goroutine)
- Does not support context cancellation natively
- Well-tested, stable, widely deployed

### nhooyr.io/websocket

nhooyr.io/websocket (websocket package) is a newer implementation with a more ergonomic API:

```go
import "nhooyr.io/websocket"
```

Characteristics:
- Context-native: all operations accept `context.Context`
- Automatic connection management via `CloseRead`
- Supports WASM compilation
- Smaller API surface, harder to misuse
- Less community documentation than gorilla

### Decision Criteria

For new production services: nhooyr.io/websocket provides safer defaults and better context integration. For services with existing gorilla/websocket code or team familiarity: stick with gorilla until a migration is justified.

This guide focuses on gorilla/websocket for broader applicability, with nhooyr.io equivalents noted where the patterns differ significantly.

## Connection Upgrade and Lifecycle

### HTTP Upgrade Handler

```go
package ws

import (
    "log"
    "net/http"
    "time"

    "github.com/gorilla/websocket"
)

const (
    writeWait      = 10 * time.Second
    pongWait       = 60 * time.Second
    pingPeriod     = (pongWait * 9) / 10  // Must be less than pongWait
    maxMessageSize = 512 * 1024           // 512KB
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  4096,
    WriteBufferSize: 4096,
    // In production, validate origin against an allowlist
    CheckOrigin: func(r *http.Request) bool {
        origin := r.Header.Get("Origin")
        return isAllowedOrigin(origin)
    },
    // Enable compression for text-heavy workloads
    EnableCompression: true,
}

func isAllowedOrigin(origin string) bool {
    allowed := []string{
        "https://app.company.com",
        "https://admin.company.com",
    }
    for _, a := range allowed {
        if origin == a {
            return true
        }
    }
    return false
}

func ServeWS(hub *Hub, w http.ResponseWriter, r *http.Request) {
    // Authenticate before upgrading — cannot send HTTP errors after upgrade
    userID, err := authenticateRequest(r)
    if err != nil {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        log.Printf("websocket upgrade error: %v", err)
        return
    }

    client := &Client{
        hub:    hub,
        conn:   conn,
        send:   make(chan []byte, 256),
        userID: userID,
        rooms:  make(map[string]bool),
    }

    hub.register <- client

    // Launch goroutines for reading and writing
    // writePump must run in the same goroutine as all writes
    go client.writePump()
    go client.readPump()
}
```

## The Hub Pattern

The hub pattern centralizes connection management and message routing in a single goroutine. This eliminates race conditions on the connection map by ensuring all map mutations happen in one goroutine.

### Client Structure

```go
// Client represents a single WebSocket connection.
type Client struct {
    hub    *Hub
    conn   *websocket.Conn
    send   chan []byte  // Buffered channel for outbound messages
    userID string
    rooms  map[string]bool
    mu     sync.RWMutex // Protects rooms map only
}

// Message is the application-level envelope.
type Message struct {
    Type    string          `json:"type"`
    Room    string          `json:"room,omitempty"`
    Payload json.RawMessage `json:"payload"`
    From    string          `json:"from,omitempty"`
}
```

### Hub Implementation

```go
// Hub maintains the set of active clients and broadcasts messages.
type Hub struct {
    // All maps are only accessed from the run() goroutine
    clients    map[*Client]bool
    rooms      map[string]map[*Client]bool
    broadcast  chan *BroadcastMessage
    register   chan *Client
    unregister chan *Client
    metrics    *HubMetrics
}

type BroadcastMessage struct {
    room    string  // Empty string = broadcast to all clients
    userID  string  // Non-empty = unicast to specific user
    payload []byte
}

type HubMetrics struct {
    totalConnections  prometheus.Counter
    activeConnections prometheus.Gauge
    messagesIn        prometheus.Counter
    messagesOut       prometheus.Counter
    droppedMessages   prometheus.Counter
}

func NewHub(reg prometheus.Registerer) *Hub {
    h := &Hub{
        clients:    make(map[*Client]bool),
        rooms:      make(map[string]map[*Client]bool),
        broadcast:  make(chan *BroadcastMessage, 1024),
        register:   make(chan *Client),
        unregister: make(chan *Client),
    }
    h.metrics = registerHubMetrics(reg)
    return h
}

// Run processes all hub events in a single goroutine.
// This goroutine MUST NOT be blocked by I/O operations.
func (h *Hub) Run() {
    for {
        select {
        case client := <-h.register:
            h.clients[client] = true
            h.metrics.activeConnections.Inc()
            h.metrics.totalConnections.Inc()
            log.Printf("client registered: user=%s total=%d", client.userID, len(h.clients))

        case client := <-h.unregister:
            if _, ok := h.clients[client]; ok {
                delete(h.clients, client)
                // Remove from all rooms
                client.mu.RLock()
                for room := range client.rooms {
                    h.removeClientFromRoom(client, room)
                }
                client.mu.RUnlock()
                close(client.send)
                h.metrics.activeConnections.Dec()
                log.Printf("client unregistered: user=%s total=%d", client.userID, len(h.clients))
            }

        case msg := <-h.broadcast:
            h.metrics.messagesOut.Add(float64(len(h.clients)))
            if msg.room != "" {
                // Room-scoped broadcast
                h.broadcastToRoom(msg.room, msg.payload)
            } else if msg.userID != "" {
                // Unicast to specific user
                h.unicastToUser(msg.userID, msg.payload)
            } else {
                // Global broadcast
                h.broadcastAll(msg.payload)
            }
        }
    }
}

func (h *Hub) broadcastToRoom(room string, payload []byte) {
    clients, ok := h.rooms[room]
    if !ok {
        return
    }
    for client := range clients {
        select {
        case client.send <- payload:
        default:
            // Client send buffer is full — drop message, record metric, and disconnect
            h.metrics.droppedMessages.Inc()
            log.Printf("dropped message for user=%s room=%s: send buffer full", client.userID, room)
            close(client.send)
            delete(h.clients, client)
            h.removeClientFromRoom(client, room)
        }
    }
}

func (h *Hub) broadcastAll(payload []byte) {
    for client := range h.clients {
        select {
        case client.send <- payload:
        default:
            h.metrics.droppedMessages.Inc()
            close(client.send)
            delete(h.clients, client)
        }
    }
}

func (h *Hub) unicastToUser(userID string, payload []byte) {
    for client := range h.clients {
        if client.userID == userID {
            select {
            case client.send <- payload:
            default:
                h.metrics.droppedMessages.Inc()
                close(client.send)
                delete(h.clients, client)
            }
        }
    }
}

func (h *Hub) addClientToRoom(client *Client, room string) {
    if _, ok := h.rooms[room]; !ok {
        h.rooms[room] = make(map[*Client]bool)
    }
    h.rooms[room][client] = true
    client.mu.Lock()
    client.rooms[room] = true
    client.mu.Unlock()
}

func (h *Hub) removeClientFromRoom(client *Client, room string) {
    if clients, ok := h.rooms[room]; ok {
        delete(clients, client)
        if len(clients) == 0 {
            delete(h.rooms, room)
        }
    }
}
```

## Read and Write Pumps

The read pump and write pump pattern enforces the gorilla/websocket requirement that concurrent reads and writes use separate goroutines:

### Write Pump

```go
// writePump pumps messages from the hub to the WebSocket connection.
// All writes MUST happen in this goroutine.
func (c *Client) writePump() {
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
                // Hub closed the channel
                c.conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }

            w, err := c.conn.NextWriter(websocket.TextMessage)
            if err != nil {
                return
            }
            w.Write(message)

            // Batch any queued messages into the same write frame
            n := len(c.send)
            for i := 0; i < n; i++ {
                w.Write([]byte{'\n'})
                w.Write(<-c.send)
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

### Read Pump

```go
// readPump pumps messages from the WebSocket connection to the hub.
func (c *Client) readPump() {
    defer func() {
        c.hub.unregister <- c
        c.conn.Close()
    }()

    c.conn.SetReadLimit(maxMessageSize)
    c.conn.SetReadDeadline(time.Now().Add(pongWait))
    c.conn.SetPongHandler(func(string) error {
        c.conn.SetReadDeadline(time.Now().Add(pongWait))
        return nil
    })

    for {
        _, message, err := c.conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err,
                websocket.CloseGoingAway,
                websocket.CloseAbnormalClosure,
                websocket.CloseNormalClosure) {
                log.Printf("unexpected close error for user=%s: %v", c.userID, err)
            }
            break
        }

        // Parse and route the message
        var msg Message
        if err := json.Unmarshal(message, &msg); err != nil {
            log.Printf("invalid message from user=%s: %v", c.userID, err)
            continue
        }

        c.hub.metrics.messagesIn.Inc()
        c.handleMessage(msg)
    }
}

func (c *Client) handleMessage(msg Message) {
    switch msg.Type {
    case "join":
        c.hub.register <- c  // Re-register with room info
        // Note: actual room join must be processed in hub.Run() goroutine
        // Send a join request via a dedicated channel instead
        c.hub.joinRoom <- &RoomRequest{client: c, room: msg.Room}

    case "leave":
        c.hub.leaveRoom <- &RoomRequest{client: c, room: msg.Room}

    case "message":
        payload, _ := json.Marshal(Message{
            Type:    "message",
            Room:    msg.Room,
            Payload: msg.Payload,
            From:    c.userID,
        })
        c.hub.broadcast <- &BroadcastMessage{room: msg.Room, payload: payload}

    default:
        log.Printf("unknown message type '%s' from user=%s", msg.Type, c.userID)
    }
}
```

## Authentication

### Token-Based Authentication at Upgrade Time

```go
func authenticateRequest(r *http.Request) (string, error) {
    // Check Authorization header first
    authHeader := r.Header.Get("Authorization")
    if authHeader != "" {
        token := strings.TrimPrefix(authHeader, "Bearer ")
        return validateJWT(token)
    }

    // Fall back to query parameter (less secure but needed for browser clients)
    token := r.URL.Query().Get("token")
    if token == "" {
        return "", fmt.Errorf("no authentication credentials provided")
    }
    return validateJWT(token)
}

func validateJWT(tokenString string) (string, error) {
    type Claims struct {
        UserID string `json:"sub"`
        jwt.RegisteredClaims
    }

    token, err := jwt.ParseWithClaims(tokenString, &Claims{},
        func(token *jwt.Token) (interface{}, error) {
            if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
                return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
            }
            return []byte(jwtSecretFromEnvironment()), nil
        },
    )
    if err != nil {
        return "", fmt.Errorf("invalid token: %w", err)
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return "", fmt.Errorf("invalid claims")
    }

    return claims.UserID, nil
}
```

### Token Refresh Mid-Connection

JWT tokens expire. For long-lived WebSocket connections, implement a client-initiated token refresh:

```go
case "auth_refresh":
    var payload struct {
        Token string `json:"token"`
    }
    if err := json.Unmarshal(msg.Payload, &payload); err != nil {
        c.sendError("invalid auth_refresh payload")
        break
    }

    newUserID, err := validateJWT(payload.Token)
    if err != nil {
        // Send error and close connection
        c.sendError("token refresh failed: " + err.Error())
        c.conn.WriteControl(
            websocket.CloseMessage,
            websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "authentication expired"),
            time.Now().Add(writeWait),
        )
        return
    }

    if newUserID != c.userID {
        c.sendError("token user mismatch")
        return
    }

    // Token refreshed successfully — no action needed, connection continues
    c.send <- marshalMessage(Message{Type: "auth_refreshed"})
```

## Backpressure Handling

### Slow Consumer Detection

The send channel buffer provides backpressure detection. A full buffer indicates a slow consumer:

```go
// Tiered backpressure response
func (h *Hub) sendWithBackpressure(client *Client, payload []byte) bool {
    select {
    case client.send <- payload:
        return true
    default:
        // Buffer full — check fill level
    }

    // Check buffer utilization
    utilization := float64(len(client.send)) / float64(cap(client.send))

    if utilization > 0.9 {
        // >90% full: disconnect the client
        h.metrics.droppedMessages.Inc()
        log.Printf("disconnecting slow client user=%s (buffer %.0f%% full)", 
            client.userID, utilization*100)
        close(client.send)
        delete(h.clients, client)
        return false
    }

    // Drop this message but keep the connection
    h.metrics.droppedMessages.Inc()
    return false
}
```

### Rate Limiting per Connection

```go
type RateLimiter struct {
    limiter *rate.Limiter
    userID  string
}

func NewRateLimiter(userID string, rps int, burst int) *RateLimiter {
    return &RateLimiter{
        limiter: rate.NewLimiter(rate.Limit(rps), burst),
        userID:  userID,
    }
}

// In the read pump, before processing each message:
func (c *Client) readPump() {
    rl := NewRateLimiter(c.userID, 50, 100) // 50 msg/sec, burst of 100

    for {
        _, message, err := c.conn.ReadMessage()
        if err != nil {
            break
        }

        if !rl.limiter.Allow() {
            log.Printf("rate limit exceeded for user=%s", c.userID)
            // Send rate limit error to client
            c.sendError("rate limit exceeded")
            // Optional: close connection on persistent abuse
            continue
        }

        c.handleMessage(message)
    }
}
```

## Horizontal Scaling with Redis Pub/Sub

When running multiple WebSocket server instances behind a load balancer, messages sent to one instance must reach clients connected to other instances. Redis pub/sub provides the inter-process broadcast mechanism.

### Redis Pub/Sub Hub

```go
package ws

import (
    "context"
    "encoding/json"
    "log"

    "github.com/redis/go-redis/v9"
)

type DistributedHub struct {
    *Hub
    redis     *redis.Client
    serverID  string
    ctx       context.Context
    cancel    context.CancelFunc
}

type RedisMessage struct {
    ServerID string `json:"server_id"` // Sender's instance ID
    Room     string `json:"room,omitempty"`
    UserID   string `json:"user_id,omitempty"`
    Payload  []byte `json:"payload"`
}

func NewDistributedHub(hub *Hub, redisClient *redis.Client, serverID string) *DistributedHub {
    ctx, cancel := context.WithCancel(context.Background())
    return &DistributedHub{
        Hub:      hub,
        redis:    redisClient,
        serverID: serverID,
        ctx:      ctx,
        cancel:   cancel,
    }
}

// PublishToRoom publishes a message to a room across all server instances.
func (dh *DistributedHub) PublishToRoom(room string, payload []byte) error {
    msg := RedisMessage{
        ServerID: dh.serverID,
        Room:     room,
        Payload:  payload,
    }
    data, err := json.Marshal(msg)
    if err != nil {
        return err
    }
    return dh.redis.Publish(dh.ctx, "ws:room:"+room, data).Err()
}

// PublishToUser publishes a message to a specific user across all server instances.
func (dh *DistributedHub) PublishToUser(userID string, payload []byte) error {
    msg := RedisMessage{
        ServerID: dh.serverID,
        UserID:   userID,
        Payload:  payload,
    }
    data, err := json.Marshal(msg)
    if err != nil {
        return err
    }
    return dh.redis.Publish(dh.ctx, "ws:user:"+userID, data).Err()
}

// SubscribeToRooms subscribes to Redis channels for all rooms the local hub has clients in.
func (dh *DistributedHub) SubscribeToRooms() {
    // Use a pattern subscription to catch all room channels
    pubsub := dh.redis.PSubscribe(dh.ctx, "ws:room:*", "ws:user:*")
    defer pubsub.Close()

    for {
        select {
        case <-dh.ctx.Done():
            return
        case msg, ok := <-pubsub.Channel():
            if !ok {
                return
            }
            dh.handleRedisMessage(msg)
        }
    }
}

func (dh *DistributedHub) handleRedisMessage(msg *redis.Message) {
    var rMsg RedisMessage
    if err := json.Unmarshal([]byte(msg.Payload), &rMsg); err != nil {
        log.Printf("failed to parse redis message: %v", err)
        return
    }

    // Ignore messages from this server (already delivered locally)
    if rMsg.ServerID == dh.serverID {
        return
    }

    // Forward to local hub for delivery to connected clients
    if rMsg.Room != "" {
        dh.Hub.broadcast <- &BroadcastMessage{
            room:    rMsg.Room,
            payload: rMsg.Payload,
        }
    } else if rMsg.UserID != "" {
        dh.Hub.broadcast <- &BroadcastMessage{
            userID:  rMsg.UserID,
            payload: rMsg.Payload,
        }
    }
}
```

### Connection Affinity

When using sticky sessions (connection affinity), the load balancer routes a client's reconnect attempts to the same server. This reduces inter-server traffic but requires fallback routing when a server restarts:

```nginx
# nginx WebSocket upstream with sticky sessions
upstream websocket_backend {
    ip_hash;  # Connection affinity by client IP
    server ws1.internal:8080;
    server ws2.internal:8080;
    server ws3.internal:8080;
}

server {
    listen 443 ssl;
    server_name ws.company.com;

    location / {
        proxy_pass http://websocket_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## Connection Metrics and Observability

```go
func registerHubMetrics(reg prometheus.Registerer) *HubMetrics {
    m := &HubMetrics{}

    m.totalConnections = promauto.With(reg).NewCounter(prometheus.CounterOpts{
        Name: "websocket_connections_total",
        Help: "Total number of WebSocket connections accepted",
    })

    m.activeConnections = promauto.With(reg).NewGauge(prometheus.GaugeOpts{
        Name: "websocket_connections_active",
        Help: "Current number of active WebSocket connections",
    })

    m.messagesIn = promauto.With(reg).NewCounter(prometheus.CounterOpts{
        Name: "websocket_messages_received_total",
        Help: "Total number of messages received from clients",
    })

    m.messagesOut = promauto.With(reg).NewCounter(prometheus.CounterOpts{
        Name: "websocket_messages_sent_total",
        Help: "Total number of messages sent to clients",
    })

    m.droppedMessages = promauto.With(reg).NewCounter(prometheus.CounterOpts{
        Name: "websocket_messages_dropped_total",
        Help: "Total number of messages dropped due to slow clients",
    })

    return m
}

// Prometheus alerting rules for WebSocket health
// websocket_connections_active > 50000  -> WARNING
// rate(websocket_messages_dropped_total[5m]) > 100 -> WARNING: slow clients
// rate(websocket_connections_total[1m]) > 1000 -> WARNING: connection storm
```

## Graceful Shutdown

```go
func (h *Hub) Shutdown(timeout time.Duration) error {
    closeMsg := websocket.FormatCloseMessage(
        websocket.CloseServiceRestart,
        "server restarting, please reconnect",
    )

    deadline := time.Now().Add(timeout)

    // Notify all clients and close their connections
    for client := range h.clients {
        client.conn.SetWriteDeadline(deadline)
        client.conn.WriteControl(websocket.CloseMessage, closeMsg, deadline)
        close(client.send)
    }

    // Wait for all write pumps to finish
    wg := sync.WaitGroup{}
    for client := range h.clients {
        wg.Add(1)
        go func(c *Client) {
            defer wg.Done()
            // Write pump will exit when send channel is closed
            time.Sleep(writeWait)
            c.conn.Close()
        }(client)
    }

    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-time.After(timeout):
        return fmt.Errorf("shutdown timed out with %d connections remaining", len(h.clients))
    }
}

// HTTP server graceful shutdown
func main() {
    hub := NewHub(prometheus.DefaultRegisterer)
    go hub.Run()

    srv := &http.Server{
        Addr:    ":8080",
        Handler: setupRoutes(hub),
    }

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
    <-quit

    log.Println("shutting down websocket server...")

    // Give connections 30 seconds to drain
    if err := hub.Shutdown(30 * time.Second); err != nil {
        log.Printf("hub shutdown: %v", err)
    }

    ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
    defer cancel()
    if err := srv.Shutdown(ctx); err != nil {
        log.Printf("http server shutdown: %v", err)
    }
}
```

## Testing WebSocket Handlers

```go
package ws_test

import (
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
    "time"

    "github.com/gorilla/websocket"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestHubBroadcast(t *testing.T) {
    hub := NewHub(prometheus.NewRegistry())
    go hub.Run()

    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ServeWS(hub, w, r)
    }))
    defer server.Close()

    // Convert http://... to ws://...
    wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/?token=test-token-user1"

    dialer := websocket.Dialer{
        HandshakeTimeout: 5 * time.Second,
    }

    conn1, _, err := dialer.Dial(wsURL, nil)
    require.NoError(t, err)
    defer conn1.Close()

    conn2URL := "ws" + strings.TrimPrefix(server.URL, "http") + "/?token=test-token-user2"
    conn2, _, err := dialer.Dial(conn2URL, nil)
    require.NoError(t, err)
    defer conn2.Close()

    // Give hub time to register both clients
    time.Sleep(50 * time.Millisecond)

    // Broadcast from hub
    hub.broadcast <- &BroadcastMessage{
        payload: []byte(`{"type":"test","payload":"hello"}`),
    }

    // Both clients should receive the message
    conn1.SetReadDeadline(time.Now().Add(2 * time.Second))
    _, msg1, err := conn1.ReadMessage()
    require.NoError(t, err)
    assert.Contains(t, string(msg1), "hello")

    conn2.SetReadDeadline(time.Now().Add(2 * time.Second))
    _, msg2, err := conn2.ReadMessage()
    require.NoError(t, err)
    assert.Contains(t, string(msg2), "hello")
}
```

## Production Checklist

- Write deadline set before every write (`conn.SetWriteDeadline`)
- Read deadline extended on every received pong (`SetPongHandler`)
- Message size limit configured (`SetReadLimit`)
- Origin validation implemented in `CheckOrigin`
- Authentication happens before HTTP upgrade
- Send buffer size sized for expected burst traffic
- Slow client detection and disconnection logic implemented
- Redis pub/sub integration for horizontal scaling
- Prometheus metrics for connections, messages, and drops
- Graceful shutdown sends CloseMessage before terminating connections
- Rate limiting per connection to prevent message flooding
- Integration tests cover concurrent connections and hub broadcast

A production WebSocket service that handles these concerns correctly can sustain hundreds of thousands of concurrent connections on modest hardware. The goroutine-per-connection model is efficient when each goroutine spends most of its time blocked on channel operations rather than consuming CPU.
