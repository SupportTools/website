---
title: "Go WebSocket: Real-Time Communication Patterns"
date: 2029-05-13T00:00:00-05:00
draft: false
tags: ["Go", "WebSocket", "Real-Time", "Redis", "Golang", "gorilla", "Concurrency"]
categories: ["Go", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production WebSocket patterns in Go covering gorilla/websocket vs nhooyr.io/websocket, connection lifecycle management, ping/pong heartbeat, fan-out broadcast architecture, and horizontal scaling with Redis pub/sub for stateful WebSocket servers."
more_link: "yes"
url: "/go-websocket-realtime-communication-patterns-guide/"
---

WebSocket servers that work for 10 connections stop working at 10,000. The patterns that look clean in tutorials — one goroutine per connection, in-process broadcast — become liabilities under load. This post covers production-grade WebSocket implementation in Go: choosing between the major libraries, managing connection lifecycle without goroutine leaks, implementing efficient fan-out, and scaling horizontally with Redis pub/sub when a single server can no longer serve your connection count.

<!--more-->

# Go WebSocket: Real-Time Communication Patterns

## Section 1: Library Comparison — gorilla/websocket vs nhooyr.io/websocket

### gorilla/websocket

The original and most widely deployed Go WebSocket library. Battle-tested, no dependencies beyond stdlib, but requires careful manual message-pump management.

```bash
go get github.com/gorilla/websocket
```

```go
package main

import (
    "net/http"
    "time"

    "github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    CheckOrigin: func(r *http.Request) bool {
        // In production: validate r.Header.Get("Origin")
        return true
    },
    HandshakeTimeout: 10 * time.Second,
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        // upgrader already sent an error response
        return
    }
    defer conn.Close()

    // gorilla/websocket is NOT safe for concurrent writes
    // Must serialize writes from a single goroutine
    for {
        messageType, p, err := conn.ReadMessage()
        if err != nil {
            // Distinguish clean close from network error
            if websocket.IsUnexpectedCloseError(err,
                websocket.CloseGoingAway,
                websocket.CloseNormalClosure) {
                log.Printf("unexpected close: %v", err)
            }
            return
        }
        // Echo back
        if err := conn.WriteMessage(messageType, p); err != nil {
            return
        }
    }
}
```

### nhooyr.io/websocket

A newer library with a cleaner API, context-aware operations, and safe concurrent usage without manual synchronization.

```bash
go get nhooyr.io/websocket
```

```go
package main

import (
    "context"
    "net/http"
    "time"

    "nhooyr.io/websocket"
    "nhooyr.io/websocket/wsjson"
)

func handleWebSocketNhooyr(w http.ResponseWriter, r *http.Request) {
    conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
        OriginPatterns:     []string{"*.example.com"},
        InsecureSkipVerify: false,
        // Subprotocol negotiation
        Subprotocols: []string{"chat", "v2"},
    })
    if err != nil {
        return
    }
    defer conn.CloseNow()

    // nhooyr.io/websocket uses context for cancellation
    ctx := r.Context()
    ctx, cancel := context.WithTimeout(ctx, 24*time.Hour)
    defer cancel()

    for {
        // Read with timeout
        readCtx, readCancel := context.WithTimeout(ctx, 30*time.Second)
        messageType, data, err := conn.Read(readCtx)
        readCancel()

        if err != nil {
            // Check if it was a clean close
            closeStatus := websocket.CloseStatus(err)
            if closeStatus == websocket.StatusNormalClosure ||
               closeStatus == websocket.StatusGoingAway {
                return
            }
            return
        }

        // Write JSON with nhooyr convenience helper
        if err := wsjson.Write(ctx, conn, map[string]interface{}{
            "echo":    string(data),
            "type":    messageType.String(),
            "ts":      time.Now().UnixMilli(),
        }); err != nil {
            return
        }
    }
}
```

### Side-by-Side Comparison

| Feature | gorilla/websocket | nhooyr.io/websocket |
|---------|-------------------|---------------------|
| Concurrent writes | Unsafe (lock required) | Safe |
| Context support | Limited | Full |
| API style | Imperative | Context-first |
| Dependencies | None | stdlib only |
| Maintenance status | Archived (community fork) | Active |
| Production usage | Extremely widespread | Growing |
| Compression | Yes (permessage-deflate) | Yes |

## Section 2: Production Connection Lifecycle

### The Connection Struct

```go
package ws

import (
    "context"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

const (
    // Time allowed to write a message to the peer
    writeWait = 10 * time.Second
    // Time allowed to read the next pong message from the peer
    pongWait = 60 * time.Second
    // Send pings to peer with this period (must be less than pongWait)
    pingPeriod = (pongWait * 9) / 10
    // Maximum message size
    maxMessageSize = 512 * 1024 // 512KB
)

type Connection struct {
    // The websocket connection
    conn *websocket.Conn

    // Buffered channel of outbound messages
    // Size 256 prevents blocking the hub when a client is slow
    send chan []byte

    // Hub reference for deregistration
    hub *Hub

    // Connection metadata
    id       string
    userID   string
    rooms    map[string]bool
    mu       sync.RWMutex

    // Lifecycle
    ctx    context.Context
    cancel context.CancelFunc
    done   chan struct{}
}

func NewConnection(conn *websocket.Conn, hub *Hub, userID string) *Connection {
    ctx, cancel := context.WithCancel(context.Background())
    return &Connection{
        conn:   conn,
        send:   make(chan []byte, 256),
        hub:    hub,
        id:     generateID(),
        userID: userID,
        rooms:  make(map[string]bool),
        ctx:    ctx,
        cancel: cancel,
        done:   make(chan struct{}),
    }
}
```

### Read Pump

The read pump runs in its own goroutine. It's the only goroutine that reads from the WebSocket.

```go
// ReadPump pumps messages from the websocket connection to the hub.
// The application runs ReadPump in a per-connection goroutine.
func (c *Connection) ReadPump() {
    defer func() {
        c.hub.Unregister(c)
        c.conn.Close()
        c.cancel()
        close(c.done)
    }()

    c.conn.SetReadLimit(maxMessageSize)
    c.conn.SetReadDeadline(time.Now().Add(pongWait))

    // The pong handler resets the read deadline
    c.conn.SetPongHandler(func(string) error {
        c.conn.SetReadDeadline(time.Now().Add(pongWait))
        return nil
    })

    // Handle close message from client
    c.conn.SetCloseHandler(func(code int, text string) error {
        // Send back a close message with the same code
        message := websocket.FormatCloseMessage(code, "")
        c.conn.WriteControl(websocket.CloseMessage, message, time.Now().Add(writeWait))
        return nil
    })

    for {
        messageType, rawMessage, err := c.conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err,
                websocket.CloseGoingAway,
                websocket.CloseNormalClosure,
                websocket.CloseNoStatusReceived) {
                log.Printf("ReadPump error: userID=%s connID=%s err=%v",
                    c.userID, c.id, err)
            }
            return
        }

        // Only handle text and binary frames
        if messageType != websocket.TextMessage && messageType != websocket.BinaryMessage {
            continue
        }

        // Parse and dispatch message
        if err := c.hub.HandleMessage(c, rawMessage); err != nil {
            log.Printf("HandleMessage error: %v", err)
            // Don't return on message handling error, stay connected
        }
    }
}
```

### Write Pump

The write pump is the only goroutine that writes to the WebSocket. Ping management happens here too.

```go
// WritePump pumps messages from the hub to the websocket connection.
// A goroutine running WritePump is started for each connection.
func (c *Connection) WritePump() {
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

            // Get a writer for a text message
            w, err := c.conn.NextWriter(websocket.TextMessage)
            if err != nil {
                return
            }
            w.Write(message)

            // Batch remaining queued messages in the same WebSocket frame
            // This reduces syscall overhead under high throughput
            n := len(c.send)
            for i := 0; i < n; i++ {
                w.Write(newline)
                w.Write(<-c.send)
            }

            if err := w.Close(); err != nil {
                return
            }

        case <-ticker.C:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                // Client disconnected, stop
                return
            }

        case <-c.ctx.Done():
            // Connection was cancelled externally
            c.conn.WriteMessage(websocket.CloseMessage,
                websocket.FormatCloseMessage(websocket.CloseNormalClosure, "server shutdown"))
            return
        }
    }
}

var newline = []byte{'\n'}
```

### Safe Send with Backpressure

```go
// Send queues a message for delivery to this connection.
// Returns false if the send buffer is full (client is slow).
func (c *Connection) Send(data []byte) bool {
    select {
    case c.send <- data:
        return true
    default:
        // Buffer full — client is too slow to consume messages
        // Could log here or increment a metric
        return false
    }
}

// SendOrClose sends a message or closes the connection if the buffer is full.
func (c *Connection) SendOrClose(data []byte) {
    if !c.Send(data) {
        // Close slow connections to prevent them from holding up broadcast
        c.hub.Unregister(c)
        c.conn.Close()
    }
}
```

## Section 3: Fan-Out Broadcast

### Hub-Based Fan-Out

The Hub is the central registry and broadcast engine. All connection management flows through it.

```go
package ws

import (
    "sync"
)

type Message struct {
    Data    []byte
    RoomID  string   // Empty = broadcast to all
    Exclude *Connection // Don't send to this connection
}

// Hub maintains the set of active connections and broadcasts messages.
type Hub struct {
    // All registered connections
    connections map[*Connection]bool

    // Room-based subscriptions: roomID -> set of connections
    rooms map[string]map[*Connection]bool

    // Inbound messages to broadcast
    broadcast chan Message

    // Register requests from connections
    register chan *Connection

    // Unregister requests from connections
    unregister chan *Connection

    mu sync.RWMutex
}

func NewHub() *Hub {
    return &Hub{
        connections: make(map[*Connection]bool),
        rooms:       make(map[string]map[*Connection]bool),
        broadcast:   make(chan Message, 1024),
        register:    make(chan *Connection),
        unregister:  make(chan *Connection),
    }
}

// Run starts the hub event loop. Must run in a goroutine.
func (h *Hub) Run() {
    for {
        select {
        case conn := <-h.register:
            h.mu.Lock()
            h.connections[conn] = true
            h.mu.Unlock()

        case conn := <-h.unregister:
            h.mu.Lock()
            if _, ok := h.connections[conn]; ok {
                delete(h.connections, conn)
                // Remove from all rooms
                for roomID, members := range h.rooms {
                    delete(members, conn)
                    if len(members) == 0 {
                        delete(h.rooms, roomID)
                    }
                }
                close(conn.send)
            }
            h.mu.Unlock()

        case msg := <-h.broadcast:
            h.mu.RLock()
            var targets map[*Connection]bool

            if msg.RoomID != "" {
                // Room-targeted broadcast
                targets = h.rooms[msg.RoomID]
            } else {
                // Global broadcast
                targets = h.connections
            }

            for conn := range targets {
                if conn == msg.Exclude {
                    continue
                }
                select {
                case conn.send <- msg.Data:
                default:
                    // Buffer full: queue removal outside lock
                    // We don't close here because we hold RLock
                    go func(c *Connection) {
                        h.Unregister(c)
                        c.conn.Close()
                    }(conn)
                }
            }
            h.mu.RUnlock()
        }
    }
}

func (h *Hub) Register(conn *Connection) {
    h.register <- conn
}

func (h *Hub) Unregister(conn *Connection) {
    h.unregister <- conn
}

func (h *Hub) Broadcast(msg Message) {
    select {
    case h.broadcast <- msg:
    default:
        // Broadcast channel full - drop or log
        log.Println("Warning: broadcast channel full, dropping message")
    }
}

// JoinRoom adds a connection to a room
func (h *Hub) JoinRoom(conn *Connection, roomID string) {
    h.mu.Lock()
    defer h.mu.Unlock()

    if h.rooms[roomID] == nil {
        h.rooms[roomID] = make(map[*Connection]bool)
    }
    h.rooms[roomID][conn] = true
    conn.mu.Lock()
    conn.rooms[roomID] = true
    conn.mu.Unlock()
}

// ConnectionCount returns total active connections
func (h *Hub) ConnectionCount() int {
    h.mu.RLock()
    defer h.mu.RUnlock()
    return len(h.connections)
}

// RoomCount returns connections in a specific room
func (h *Hub) RoomCount(roomID string) int {
    h.mu.RLock()
    defer h.mu.RUnlock()
    return len(h.rooms[roomID])
}
```

### High-Throughput Broadcast with Worker Pool

For very high connection counts, use a worker pool to parallelize fan-out:

```go
type ParallelHub struct {
    *Hub
    workers int
    msgCh   chan broadcastJob
}

type broadcastJob struct {
    conns []*Connection
    data  []byte
}

func NewParallelHub(workers int) *ParallelHub {
    h := &ParallelHub{
        Hub:     NewHub(),
        workers: workers,
        msgCh:   make(chan broadcastJob, 128),
    }

    for i := 0; i < workers; i++ {
        go h.broadcastWorker()
    }

    return h
}

func (h *ParallelHub) broadcastWorker() {
    for job := range h.msgCh {
        for _, conn := range job.conns {
            select {
            case conn.send <- job.data:
            default:
                go func(c *Connection) {
                    h.Unregister(c)
                    c.conn.Close()
                }(conn)
            }
        }
    }
}

func (h *ParallelHub) BroadcastParallel(roomID string, data []byte) {
    h.mu.RLock()
    var targets []*Connection
    if roomID != "" {
        for conn := range h.rooms[roomID] {
            targets = append(targets, conn)
        }
    } else {
        for conn := range h.connections {
            targets = append(targets, conn)
        }
    }
    h.mu.RUnlock()

    // Split into chunks for parallel processing
    chunkSize := (len(targets) + h.workers - 1) / h.workers
    for i := 0; i < len(targets); i += chunkSize {
        end := i + chunkSize
        if end > len(targets) {
            end = len(targets)
        }
        h.msgCh <- broadcastJob{
            conns: targets[i:end],
            data:  data,
        }
    }
}
```

## Section 4: Ping/Pong Heartbeat

WebSocket ping/pong frames detect dead connections. Without heartbeats, dead connections accumulate in memory because there's no traffic to trigger a TCP-level error.

```go
// HeartbeatManager manages ping/pong for a connection
type HeartbeatManager struct {
    conn          *Connection
    pingInterval  time.Duration
    pongTimeout   time.Duration
    lastPong      time.Time
    mu            sync.Mutex
}

func NewHeartbeatManager(conn *Connection) *HeartbeatManager {
    hm := &HeartbeatManager{
        conn:         conn,
        pingInterval: 25 * time.Second,
        pongTimeout:  10 * time.Second,
        lastPong:     time.Now(),
    }

    // Register pong handler
    conn.conn.SetPongHandler(func(appData string) error {
        hm.mu.Lock()
        hm.lastPong = time.Now()
        hm.mu.Unlock()
        conn.conn.SetReadDeadline(time.Now().Add(hm.pingInterval + hm.pongTimeout))
        return nil
    })

    return hm
}

// Run starts the heartbeat loop
func (hm *HeartbeatManager) Run(ctx context.Context) {
    ticker := time.NewTicker(hm.pingInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            hm.mu.Lock()
            sinceLastPong := time.Since(hm.lastPong)
            hm.mu.Unlock()

            // If we haven't received a pong since the last ping + timeout,
            // the connection is dead
            if sinceLastPong > hm.pingInterval+hm.pongTimeout {
                log.Printf("Heartbeat timeout: connID=%s userID=%s sinceLastPong=%v",
                    hm.conn.id, hm.conn.userID, sinceLastPong)
                hm.conn.conn.Close()
                return
            }

            // Send ping
            hm.conn.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := hm.conn.conn.WriteMessage(websocket.PingMessage, []byte("heartbeat")); err != nil {
                log.Printf("Ping failed: %v", err)
                hm.conn.conn.Close()
                return
            }

        case <-ctx.Done():
            return
        }
    }
}
```

## Section 5: Scaling with Redis Pub/Sub

A single Go process can handle ~50,000-100,000 WebSocket connections depending on hardware. Beyond that, or when you need zero-downtime deployments, you need multiple server instances with message routing between them.

### Architecture

```
Client A ──► Server 1 ──► Redis Pub/Sub ──► Server 2 ──► Client B
                                        └──► Server 3 ──► Client C
```

### Redis-Backed Hub

```go
package ws

import (
    "context"
    "encoding/json"
    "fmt"
    "log"

    "github.com/redis/go-redis/v9"
)

type RedisMessage struct {
    RoomID    string `json:"room_id"`
    Data      []byte `json:"data"`
    ServerID  string `json:"server_id"` // Sender's ID (to avoid echo)
}

type RedisHub struct {
    *Hub
    client   *redis.Client
    serverID string
    ctx      context.Context
    cancel   context.CancelFunc
}

func NewRedisHub(redisAddr, serverID string) *RedisHub {
    client := redis.NewClient(&redis.Options{
        Addr:         redisAddr,
        PoolSize:     10,
        MinIdleConns: 5,
    })

    ctx, cancel := context.WithCancel(context.Background())

    h := &RedisHub{
        Hub:      NewHub(),
        client:   client,
        serverID: serverID,
        ctx:      ctx,
        cancel:   cancel,
    }

    return h
}

// PublishToRoom publishes a message to a room via Redis
// All servers subscribed to the room channel will receive and fan out locally
func (h *RedisHub) PublishToRoom(roomID string, data []byte) error {
    msg := RedisMessage{
        RoomID:   roomID,
        Data:     data,
        ServerID: h.serverID,
    }

    payload, err := json.Marshal(msg)
    if err != nil {
        return fmt.Errorf("marshal message: %w", err)
    }

    channel := fmt.Sprintf("ws:room:%s", roomID)
    return h.client.Publish(h.ctx, channel, payload).Err()
}

// SubscribeToRoom subscribes this server to a room's Redis channel
func (h *RedisHub) SubscribeToRoom(roomID string) {
    channel := fmt.Sprintf("ws:room:%s", roomID)
    pubsub := h.client.Subscribe(h.ctx, channel)

    go func() {
        defer pubsub.Close()

        for {
            select {
            case msg, ok := <-pubsub.Channel():
                if !ok {
                    return
                }

                var wsMsg RedisMessage
                if err := json.Unmarshal([]byte(msg.Payload), &wsMsg); err != nil {
                    log.Printf("Failed to unmarshal message: %v", err)
                    continue
                }

                // Don't re-broadcast messages we sent
                if wsMsg.ServerID == h.serverID {
                    continue
                }

                // Fan out to local connections in this room
                h.Broadcast(Message{
                    RoomID: wsMsg.RoomID,
                    Data:   wsMsg.Data,
                })

            case <-h.ctx.Done():
                return
            }
        }
    }()
}

// BroadcastGlobal publishes to the global channel (all servers, all connections)
func (h *RedisHub) BroadcastGlobal(data []byte) error {
    msg := RedisMessage{
        Data:     data,
        ServerID: h.serverID,
    }

    payload, err := json.Marshal(msg)
    if err != nil {
        return err
    }

    return h.client.Publish(h.ctx, "ws:global", payload).Err()
}

// SubscribeGlobal subscribes to global broadcasts
func (h *RedisHub) SubscribeGlobal() {
    pubsub := h.client.Subscribe(h.ctx, "ws:global")

    go func() {
        defer pubsub.Close()

        for msg := range pubsub.Channel() {
            var wsMsg RedisMessage
            if err := json.Unmarshal([]byte(msg.Payload), &wsMsg); err != nil {
                continue
            }

            if wsMsg.ServerID == h.serverID {
                continue // Skip our own broadcasts
            }

            // Broadcast to all local connections
            h.Broadcast(Message{Data: wsMsg.Data})
        }
    }()
}
```

### Connection State in Redis

For session recovery after reconnect:

```go
type SessionStore struct {
    client *redis.Client
    ttl    time.Duration
}

type Session struct {
    UserID    string   `json:"user_id"`
    ServerID  string   `json:"server_id"`
    Rooms     []string `json:"rooms"`
    ConnectedAt int64  `json:"connected_at"`
}

func (s *SessionStore) SaveSession(ctx context.Context, connID string, session Session) error {
    data, err := json.Marshal(session)
    if err != nil {
        return err
    }
    return s.client.Set(ctx, fmt.Sprintf("ws:session:%s", connID), data, s.ttl).Err()
}

func (s *SessionStore) GetSession(ctx context.Context, connID string) (*Session, error) {
    data, err := s.client.Get(ctx, fmt.Sprintf("ws:session:%s", connID)).Bytes()
    if err == redis.Nil {
        return nil, nil
    }
    if err != nil {
        return nil, err
    }

    var session Session
    if err := json.Unmarshal(data, &session); err != nil {
        return nil, err
    }
    return &session, nil
}

// Online presence tracking
func (s *SessionStore) SetOnline(ctx context.Context, userID string) error {
    return s.client.SAdd(ctx, "ws:online", userID).Err()
}

func (s *SessionStore) SetOffline(ctx context.Context, userID string) error {
    return s.client.SRem(ctx, "ws:online", userID).Err()
}

func (s *SessionStore) IsOnline(ctx context.Context, userID string) (bool, error) {
    return s.client.SIsMember(ctx, "ws:online", userID).Result()
}

func (s *SessionStore) OnlineCount(ctx context.Context) (int64, error) {
    return s.client.SCard(ctx, "ws:online").Result()
}
```

## Section 6: Complete HTTP Server with WebSocket Support

```go
package main

import (
    "context"
    "encoding/json"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  4096,
    WriteBufferSize: 4096,
    CheckOrigin: func(r *http.Request) bool {
        origin := r.Header.Get("Origin")
        // Validate origin against allowed list
        allowed := map[string]bool{
            "https://app.example.com":     true,
            "https://staging.example.com": true,
        }
        return allowed[origin]
    },
    HandshakeTimeout: 10 * time.Second,
    // Enable permessage-deflate compression
    EnableCompression: true,
}

type Server struct {
    hub      *Hub
    sessions *SessionStore
    serverID string
    mux      *http.ServeMux
}

func NewServer(hub *Hub, sessions *SessionStore) *Server {
    s := &Server{
        hub:      hub,
        sessions: sessions,
        serverID: generateID(),
        mux:      http.NewServeMux(),
    }

    s.mux.HandleFunc("/ws", s.handleWebSocket)
    s.mux.HandleFunc("/health", s.handleHealth)
    s.mux.HandleFunc("/metrics/connections", s.handleConnectionMetrics)

    return s
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
    // Authenticate before upgrading
    userID, ok := authenticateRequest(r)
    if !ok {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        log.Printf("Upgrade failed: %v", err)
        return
    }

    // Create connection wrapper
    wsConn := NewConnection(conn, s.hub, userID)

    // Register with hub
    s.hub.Register(wsConn)

    // Save session
    ctx := context.Background()
    s.sessions.SaveSession(ctx, wsConn.id, Session{
        UserID:      userID,
        ServerID:    s.serverID,
        ConnectedAt: time.Now().Unix(),
    })
    s.sessions.SetOnline(ctx, userID)

    // Start connection goroutines
    go wsConn.WritePump()
    go wsConn.ReadPump()

    // Cleanup on disconnect
    go func() {
        <-wsConn.done
        s.sessions.SetOffline(context.Background(), userID)
        log.Printf("Connection closed: userID=%s connID=%s", userID, wsConn.id)
    }()

    log.Printf("WebSocket connected: userID=%s connID=%s", userID, wsConn.id)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(map[string]interface{}{
        "status":      "ok",
        "connections": s.hub.ConnectionCount(),
        "server_id":   s.serverID,
    })
}

func (s *Server) handleConnectionMetrics(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "total_connections": s.hub.ConnectionCount(),
        "server_id":         s.serverID,
    })
}

func main() {
    hub := NewHub()
    go hub.Run()

    sessions := &SessionStore{
        client: newRedisClient(),
        ttl:    24 * time.Hour,
    }

    server := NewServer(hub, sessions)

    httpServer := &http.Server{
        Addr:              ":8080",
        Handler:           server.mux,
        ReadHeaderTimeout: 10 * time.Second,
        // No overall ReadTimeout — WebSocket connections are long-lived
        WriteTimeout: 0,
        IdleTimeout:  120 * time.Second,
    }

    // Graceful shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        log.Printf("WebSocket server starting on :8080")
        if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("Server error: %v", err)
        }
    }()

    <-quit
    log.Println("Shutting down gracefully...")

    // Allow time for connections to drain
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    httpServer.Shutdown(ctx)
    log.Println("Server stopped")
}
```

## Section 7: Kubernetes Deployment for WebSocket Servers

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: websocket-server
  namespace: production
spec:
  replicas: 5
  strategy:
    # Use RollingUpdate with 0 maxUnavailable to never break existing connections
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    spec:
      # Allow 30s for connection drain on shutdown
      terminationGracePeriodSeconds: 60
      containers:
      - name: server
        image: myorg/ws-server:latest
        lifecycle:
          preStop:
            exec:
              # Signal server to stop accepting new connections
              # and drain existing ones
              command: ["/bin/sh", "-c", "sleep 5"]
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 1Gi
        ports:
        - containerPort: 8080
        env:
        - name: REDIS_ADDR
          valueFrom:
            secretKeyRef:
              name: redis-credentials
              key: addr
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: websocket-server
spec:
  # sessionAffinity keeps a client connected to the same pod
  # This reduces Redis pub/sub overhead for same-server clients
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 3600
  selector:
    app: websocket-server
  ports:
  - port: 80
    targetPort: 8080
---
# Ingress with sticky sessions via annotation
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: websocket-ingress
  annotations:
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/affinity-mode: "persistent"
    nginx.ingress.kubernetes.io/session-cookie-expires: "172800"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "172800"
    # Important: enable WebSocket proxy
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  rules:
  - host: ws.example.com
    http:
      paths:
      - path: /ws
        pathType: Prefix
        backend:
          service:
            name: websocket-server
            port:
              number: 80
```

WebSocket at production scale demands disciplined goroutine management, explicit backpressure handling, and a message routing layer for horizontal scale. The patterns here — single read/write pump per connection, hub-based fan-out, Redis pub/sub for cross-server routing — are proven at hundreds of thousands of concurrent connections and handle graceful degradation when any component experiences load.
