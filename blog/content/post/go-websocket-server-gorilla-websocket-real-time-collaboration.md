---
title: "Go: Building WebSocket Servers with gorilla/websocket for Real-Time Collaboration"
date: 2031-08-11T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "WebSocket", "Real-Time", "gorilla", "Concurrency"]
categories:
- Go
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production-grade WebSocket servers in Go using gorilla/websocket, covering connection management, pub-sub patterns, horizontal scaling with Redis, and graceful shutdown."
more_link: "yes"
url: "/go-websocket-server-gorilla-websocket-real-time-collaboration/"
---

Real-time collaboration features — live document editing, presence indicators, cursor sharing, notifications — require persistent bidirectional connections that HTTP cannot efficiently provide. WebSockets are the standard solution, and Go's concurrency model makes it an excellent choice for WebSocket server implementation. This post builds a complete, production-grade WebSocket server with connection hub, room-based pub-sub, authentication, and horizontal scaling via Redis.

<!--more-->

# Go: Building WebSocket Servers with gorilla/websocket for Real-Time Collaboration

## Overview

This guide builds a WebSocket server suitable for real-time collaboration features. The architecture handles:

- **Connection lifecycle** — upgrade, authentication, heartbeat, graceful disconnect
- **Room-based pub-sub** — users join rooms (documents, channels) and receive targeted messages
- **Presence tracking** — who is online, cursor positions, active selections
- **Horizontal scaling** — multiple server instances via Redis pub-sub fanout
- **Backpressure handling** — slow clients don't block fast ones
- **Graceful shutdown** — in-flight messages delivered, clients notified

---

## Section 1: Project Setup

```bash
mkdir collab-ws && cd collab-ws
go mod init github.com/yourorg/collab-ws

go get github.com/gorilla/websocket@v1.5.3
go get github.com/redis/go-redis/v9@latest
go get github.com/golang-jwt/jwt/v5@latest
go get go.uber.org/zap@latest
```

Project structure:

```
collab-ws/
├── cmd/server/main.go
├── internal/
│   ├── hub/
│   │   ├── hub.go          # Central connection hub
│   │   ├── client.go       # WebSocket client
│   │   └── room.go         # Room/channel management
│   ├── auth/
│   │   └── jwt.go          # JWT validation
│   ├── pubsub/
│   │   └── redis.go        # Redis pub-sub for horizontal scaling
│   └── protocol/
│       └── messages.go     # Message type definitions
└── go.mod
```

---

## Section 2: Message Protocol

### 2.1 Wire Protocol

```go
// internal/protocol/messages.go
package protocol

import "encoding/json"

// MessageType identifies the purpose of a WebSocket message.
type MessageType string

const (
    // Client -> Server
    TypeJoinRoom    MessageType = "join_room"
    TypeLeaveRoom   MessageType = "leave_room"
    TypeSendMessage MessageType = "send_message"
    TypeCursorMove  MessageType = "cursor_move"
    TypeEditDelta   MessageType = "edit_delta"
    TypePing        MessageType = "ping"

    // Server -> Client
    TypeRoomJoined    MessageType = "room_joined"
    TypeRoomLeft      MessageType = "room_left"
    TypeBroadcast     MessageType = "broadcast"
    TypePresenceUpdate MessageType = "presence_update"
    TypeError         MessageType = "error"
    TypePong          MessageType = "pong"
    TypeServerInfo    MessageType = "server_info"
)

// Envelope is the outer wrapper for all WebSocket messages.
type Envelope struct {
    Type      MessageType     `json:"type"`
    MessageID string          `json:"msg_id,omitempty"`
    RoomID    string          `json:"room_id,omitempty"`
    UserID    string          `json:"user_id,omitempty"`
    Timestamp int64           `json:"ts"`
    Payload   json.RawMessage `json:"payload,omitempty"`
}

// JoinRoomPayload is the payload for TypeJoinRoom messages.
type JoinRoomPayload struct {
    RoomID   string `json:"room_id"`
    UserName string `json:"user_name"`
}

// CursorPosition represents a user's cursor in a collaborative document.
type CursorPosition struct {
    Line   int    `json:"line"`
    Column int    `json:"col"`
    Color  string `json:"color"`
}

// EditDelta represents a text editing operation (operational transform).
type EditDelta struct {
    Position int    `json:"pos"`
    Delete   int    `json:"delete"`
    Insert   string `json:"insert"`
    Version  int64  `json:"version"`
}

// PresenceInfo describes a user's current presence state.
type PresenceInfo struct {
    UserID   string          `json:"user_id"`
    UserName string          `json:"user_name"`
    Online   bool            `json:"online"`
    Cursor   *CursorPosition `json:"cursor,omitempty"`
    Color    string          `json:"color"`
}

// ErrorPayload is sent when an error occurs.
type ErrorPayload struct {
    Code    int    `json:"code"`
    Message string `json:"message"`
}
```

---

## Section 3: WebSocket Client

### 3.1 Client Struct

```go
// internal/hub/client.go
package hub

import (
    "context"
    "encoding/json"
    "sync"
    "time"

    "github.com/gorilla/websocket"
    "github.com/yourorg/collab-ws/internal/protocol"
    "go.uber.org/zap"
)

const (
    writeWait      = 10 * time.Second
    pongWait       = 60 * time.Second
    pingPeriod     = (pongWait * 9) / 10
    maxMessageSize = 64 * 1024 // 64KB
    sendBufferSize = 256       // outbound message buffer
)

// Client represents a single WebSocket connection.
type Client struct {
    hub      *Hub
    conn     *websocket.Conn
    send     chan []byte     // outbound message queue
    rooms    map[string]bool // rooms the client has joined

    // User identity (populated after authentication)
    UserID   string
    UserName string
    Color    string

    mu     sync.RWMutex
    closed bool
    logger *zap.Logger
    ctx    context.Context
    cancel context.CancelFunc
}

// NewClient creates a new WebSocket client.
func NewClient(hub *Hub, conn *websocket.Conn, userID, userName string, logger *zap.Logger) *Client {
    ctx, cancel := context.WithCancel(context.Background())
    return &Client{
        hub:      hub,
        conn:     conn,
        send:     make(chan []byte, sendBufferSize),
        rooms:    make(map[string]bool),
        UserID:   userID,
        UserName: userName,
        Color:    assignColor(userID),
        logger:   logger.With(zap.String("user_id", userID)),
        ctx:      ctx,
        cancel:   cancel,
    }
}

// Send queues a message for delivery to the client.
// Returns false if the client's send buffer is full (backpressure).
func (c *Client) Send(msg []byte) bool {
    c.mu.RLock()
    closed := c.closed
    c.mu.RUnlock()
    if closed {
        return false
    }

    select {
    case c.send <- msg:
        return true
    default:
        // Buffer full — client is slow; disconnect it to protect other clients
        c.logger.Warn("client send buffer full, disconnecting",
            zap.String("user_id", c.UserID),
        )
        c.Close()
        return false
    }
}

// Close initiates a graceful client disconnect.
func (c *Client) Close() {
    c.mu.Lock()
    if c.closed {
        c.mu.Unlock()
        return
    }
    c.closed = true
    c.mu.Unlock()

    c.cancel()
    close(c.send)
}

// ReadPump processes incoming messages from the WebSocket connection.
// Must run in its own goroutine.
func (c *Client) ReadPump() {
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
        _, msg, err := c.conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err,
                websocket.CloseGoingAway,
                websocket.CloseAbnormalClosure,
            ) {
                c.logger.Error("unexpected websocket close", zap.Error(err))
            }
            break
        }

        var env protocol.Envelope
        if err := json.Unmarshal(msg, &env); err != nil {
            c.logger.Warn("failed to parse message", zap.Error(err))
            c.sendError(400, "invalid message format")
            continue
        }

        c.hub.process <- &clientMessage{client: c, envelope: &env}
    }
}

// WritePump delivers queued messages to the WebSocket connection.
// Must run in its own goroutine.
func (c *Client) WritePump() {
    ticker := time.NewTicker(pingPeriod)
    defer func() {
        ticker.Stop()
        c.conn.Close()
    }()

    for {
        select {
        case msg, ok := <-c.send:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if !ok {
                // Channel closed — send close frame
                c.conn.WriteMessage(websocket.CloseMessage,
                    websocket.FormatCloseMessage(websocket.CloseGoingAway, ""),
                )
                return
            }

            w, err := c.conn.NextWriter(websocket.TextMessage)
            if err != nil {
                return
            }
            w.Write(msg)

            // Batch pending messages into the same write call
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

        case <-c.ctx.Done():
            return
        }
    }
}

func (c *Client) sendError(code int, message string) {
    payload, _ := json.Marshal(protocol.ErrorPayload{Code: code, Message: message})
    env := protocol.Envelope{
        Type:      protocol.TypeError,
        Timestamp: time.Now().UnixMilli(),
        Payload:   payload,
    }
    data, _ := json.Marshal(env)
    c.Send(data)
}

// sendEnvelope is a helper to marshal and send a protocol envelope.
func (c *Client) sendEnvelope(env *protocol.Envelope) {
    data, err := json.Marshal(env)
    if err != nil {
        c.logger.Error("failed to marshal envelope", zap.Error(err))
        return
    }
    c.Send(data)
}

var colorPalette = []string{
    "#e6194b", "#3cb44b", "#4363d8", "#f58231",
    "#911eb4", "#42d4f4", "#f032e6", "#bfef45",
    "#fabebe", "#469990", "#e6beff", "#9a6324",
}

func assignColor(userID string) string {
    h := 0
    for _, b := range userID {
        h = (h*31 + int(b)) % len(colorPalette)
    }
    return colorPalette[h]
}
```

---

## Section 4: Connection Hub

### 4.1 Hub Implementation

```go
// internal/hub/hub.go
package hub

import (
    "context"
    "encoding/json"
    "sync"
    "time"

    "github.com/yourorg/collab-ws/internal/protocol"
    "github.com/yourorg/collab-ws/internal/pubsub"
    "go.uber.org/zap"
)

type clientMessage struct {
    client   *Client
    envelope *protocol.Envelope
}

// Hub manages all WebSocket connections and message routing.
type Hub struct {
    clients    map[string]*Client     // userID -> client
    rooms      map[string]*Room       // roomID -> room
    register   chan *Client
    unregister chan *Client
    process    chan *clientMessage
    shutdown   chan struct{}
    logger     *zap.Logger
    pubsub     *pubsub.RedisClient
    mu         sync.RWMutex
}

// NewHub creates a new Hub.
func NewHub(logger *zap.Logger, ps *pubsub.RedisClient) *Hub {
    h := &Hub{
        clients:    make(map[string]*Client),
        rooms:      make(map[string]*Room),
        register:   make(chan *Client, 64),
        unregister: make(chan *Client, 64),
        process:    make(chan *clientMessage, 1024),
        shutdown:   make(chan struct{}),
        logger:     logger,
        pubsub:     ps,
    }
    return h
}

// Run starts the hub event loop. Must run in its own goroutine.
func (h *Hub) Run(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            h.gracefulShutdown()
            return

        case client := <-h.register:
            h.handleRegister(client)

        case client := <-h.unregister:
            h.handleUnregister(client)

        case msg := <-h.process:
            h.handleMessage(msg)
        }
    }
}

func (h *Hub) handleRegister(c *Client) {
    h.mu.Lock()
    h.clients[c.UserID] = c
    h.mu.Unlock()

    h.logger.Info("client registered", zap.String("user_id", c.UserID))

    // Send server info
    c.sendEnvelope(&protocol.Envelope{
        Type:      protocol.TypeServerInfo,
        Timestamp: time.Now().UnixMilli(),
    })
}

func (h *Hub) handleUnregister(c *Client) {
    h.mu.Lock()
    if _, ok := h.clients[c.UserID]; ok {
        delete(h.clients, c.UserID)
    }
    h.mu.Unlock()

    // Remove from all rooms
    c.mu.RLock()
    rooms := make([]string, 0, len(c.rooms))
    for roomID := range c.rooms {
        rooms = append(rooms, roomID)
    }
    c.mu.RUnlock()

    for _, roomID := range rooms {
        h.leaveRoom(c, roomID)
    }

    c.Close()
    h.logger.Info("client unregistered", zap.String("user_id", c.UserID))
}

func (h *Hub) handleMessage(msg *clientMessage) {
    env := msg.envelope
    c := msg.client

    switch env.Type {
    case protocol.TypeJoinRoom:
        var payload protocol.JoinRoomPayload
        if err := json.Unmarshal(env.Payload, &payload); err != nil {
            c.sendError(400, "invalid join_room payload")
            return
        }
        h.joinRoom(c, payload.RoomID)

    case protocol.TypeLeaveRoom:
        h.leaveRoom(c, env.RoomID)

    case protocol.TypeSendMessage, protocol.TypeEditDelta, protocol.TypeCursorMove:
        h.broadcastToRoom(c, env)

    case protocol.TypePing:
        c.sendEnvelope(&protocol.Envelope{
            Type:      protocol.TypePong,
            MessageID: env.MessageID,
            Timestamp: time.Now().UnixMilli(),
        })

    default:
        c.sendError(400, "unknown message type")
    }
}

func (h *Hub) joinRoom(c *Client, roomID string) {
    h.mu.Lock()
    room, ok := h.rooms[roomID]
    if !ok {
        room = NewRoom(roomID, h.logger)
        h.rooms[roomID] = room
    }
    h.mu.Unlock()

    room.AddClient(c)

    c.mu.Lock()
    c.rooms[roomID] = true
    c.mu.Unlock()

    // Subscribe to Redis channel for this room (for multi-instance fanout)
    if h.pubsub != nil {
        go h.pubsub.Subscribe(context.Background(), "room:"+roomID, func(msg []byte) {
            room.Broadcast(msg, c.UserID) // exclude sender (already sent directly)
        })
    }

    // Notify the joining client
    presence := room.GetPresence()
    payload, _ := json.Marshal(presence)
    c.sendEnvelope(&protocol.Envelope{
        Type:      protocol.TypeRoomJoined,
        RoomID:    roomID,
        Timestamp: time.Now().UnixMilli(),
        Payload:   payload,
    })

    // Notify room members of new presence
    h.broadcastPresenceUpdate(room, c, true)

    h.logger.Info("client joined room",
        zap.String("user_id", c.UserID),
        zap.String("room_id", roomID),
    )
}

func (h *Hub) leaveRoom(c *Client, roomID string) {
    h.mu.RLock()
    room, ok := h.rooms[roomID]
    h.mu.RUnlock()
    if !ok {
        return
    }

    room.RemoveClient(c)

    c.mu.Lock()
    delete(c.rooms, roomID)
    c.mu.Unlock()

    // Notify remaining room members
    h.broadcastPresenceUpdate(room, c, false)

    // Clean up empty rooms
    h.mu.Lock()
    if room.Size() == 0 {
        delete(h.rooms, roomID)
    }
    h.mu.Unlock()
}

func (h *Hub) broadcastToRoom(sender *Client, env *protocol.Envelope) {
    h.mu.RLock()
    room, ok := h.rooms[env.RoomID]
    h.mu.RUnlock()
    if !ok {
        sender.sendError(404, "room not found")
        return
    }

    // Set sender information
    env.UserID = sender.UserID
    env.Timestamp = time.Now().UnixMilli()

    data, err := json.Marshal(env)
    if err != nil {
        h.logger.Error("marshal error", zap.Error(err))
        return
    }

    // Broadcast to local clients in this room
    room.Broadcast(data, sender.UserID)

    // Publish to Redis for other instances
    if h.pubsub != nil {
        h.pubsub.Publish(context.Background(), "room:"+env.RoomID, data)
    }
}

func (h *Hub) broadcastPresenceUpdate(room *Room, c *Client, online bool) {
    presence := protocol.PresenceInfo{
        UserID:   c.UserID,
        UserName: c.UserName,
        Online:   online,
        Color:    c.Color,
    }
    payload, _ := json.Marshal(presence)
    env := protocol.Envelope{
        Type:      protocol.TypePresenceUpdate,
        RoomID:    room.ID,
        UserID:    c.UserID,
        Timestamp: time.Now().UnixMilli(),
        Payload:   payload,
    }
    data, _ := json.Marshal(env)
    room.Broadcast(data, "")  // broadcast to all including sender
}

func (h *Hub) gracefulShutdown() {
    h.logger.Info("hub shutting down, notifying clients")
    h.mu.RLock()
    clients := make([]*Client, 0, len(h.clients))
    for _, c := range h.clients {
        clients = append(clients, c)
    }
    h.mu.RUnlock()

    for _, c := range clients {
        c.conn.WriteControl(
            websocket.CloseMessage,
            websocket.FormatCloseMessage(websocket.CloseServiceRestart, "server restarting"),
            time.Now().Add(writeWait),
        )
        c.Close()
    }
}
```

### 4.2 Room Implementation

```go
// internal/hub/room.go
package hub

import (
    "sync"

    "github.com/yourorg/collab-ws/internal/protocol"
    "go.uber.org/zap"
)

// Room represents a collaborative session that clients can join.
type Room struct {
    ID      string
    clients map[string]*Client
    mu      sync.RWMutex
    logger  *zap.Logger
}

// NewRoom creates a new room.
func NewRoom(id string, logger *zap.Logger) *Room {
    return &Room{
        ID:      id,
        clients: make(map[string]*Client),
        logger:  logger.With(zap.String("room_id", id)),
    }
}

// AddClient adds a client to the room.
func (r *Room) AddClient(c *Client) {
    r.mu.Lock()
    r.clients[c.UserID] = c
    r.mu.Unlock()
}

// RemoveClient removes a client from the room.
func (r *Room) RemoveClient(c *Client) {
    r.mu.Lock()
    delete(r.clients, c.UserID)
    r.mu.Unlock()
}

// Broadcast sends a message to all clients in the room except excludeUserID.
func (r *Room) Broadcast(msg []byte, excludeUserID string) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    for userID, client := range r.clients {
        if userID == excludeUserID {
            continue
        }
        if !client.Send(msg) {
            r.logger.Warn("failed to send to client", zap.String("user_id", userID))
        }
    }
}

// GetPresence returns presence information for all clients in the room.
func (r *Room) GetPresence() []protocol.PresenceInfo {
    r.mu.RLock()
    defer r.mu.RUnlock()

    presence := make([]protocol.PresenceInfo, 0, len(r.clients))
    for _, c := range r.clients {
        presence = append(presence, protocol.PresenceInfo{
            UserID:   c.UserID,
            UserName: c.UserName,
            Online:   true,
            Color:    c.Color,
        })
    }
    return presence
}

// Size returns the number of clients in the room.
func (r *Room) Size() int {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return len(r.clients)
}
```

---

## Section 5: Redis Pub-Sub for Horizontal Scaling

```go
// internal/pubsub/redis.go
package pubsub

import (
    "context"
    "fmt"

    "github.com/redis/go-redis/v9"
    "go.uber.org/zap"
)

// RedisClient wraps Redis for pub-sub operations.
type RedisClient struct {
    client *redis.Client
    logger *zap.Logger
}

// NewRedisClient creates a new Redis pub-sub client.
func NewRedisClient(addr, password string, db int, logger *zap.Logger) (*RedisClient, error) {
    rdb := redis.NewClient(&redis.Options{
        Addr:     addr,
        Password: password,
        DB:       db,
    })

    ctx := context.Background()
    if err := rdb.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("redis ping failed: %w", err)
    }

    return &RedisClient{client: rdb, logger: logger}, nil
}

// Publish sends a message to a Redis channel.
func (r *RedisClient) Publish(ctx context.Context, channel string, message []byte) error {
    return r.client.Publish(ctx, channel, message).Err()
}

// Subscribe listens for messages on a Redis channel and calls handler for each.
// Blocks until ctx is cancelled.
func (r *RedisClient) Subscribe(ctx context.Context, channel string, handler func([]byte)) {
    sub := r.client.Subscribe(ctx, channel)
    defer sub.Close()

    ch := sub.Channel()
    for {
        select {
        case <-ctx.Done():
            return
        case msg, ok := <-ch:
            if !ok {
                return
            }
            handler([]byte(msg.Payload))
        }
    }
}

// Close shuts down the Redis connection.
func (r *RedisClient) Close() error {
    return r.client.Close()
}
```

---

## Section 6: HTTP Handler and Authentication

### 6.1 JWT Authentication

```go
// internal/auth/jwt.go
package auth

import (
    "errors"
    "fmt"
    "net/http"
    "strings"

    "github.com/golang-jwt/jwt/v5"
)

// Claims represents the JWT claims for a WebSocket user.
type Claims struct {
    UserID   string `json:"sub"`
    UserName string `json:"name"`
    Email    string `json:"email"`
    jwt.RegisteredClaims
}

// Validator validates JWT tokens.
type Validator struct {
    secret []byte
}

// NewValidator creates a JWT validator with the given secret.
func NewValidator(secret string) *Validator {
    return &Validator{secret: []byte(secret)}
}

// ValidateFromRequest extracts and validates the JWT from the request.
// Accepts token via Authorization header or ?token= query parameter.
func (v *Validator) ValidateFromRequest(r *http.Request) (*Claims, error) {
    tokenStr := extractToken(r)
    if tokenStr == "" {
        return nil, errors.New("no token provided")
    }

    token, err := jwt.ParseWithClaims(tokenStr, &Claims{},
        func(t *jwt.Token) (interface{}, error) {
            if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
                return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
            }
            return v.secret, nil
        },
        jwt.WithExpirationRequired(),
    )
    if err != nil {
        return nil, fmt.Errorf("invalid token: %w", err)
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return nil, errors.New("invalid token claims")
    }

    return claims, nil
}

func extractToken(r *http.Request) string {
    // Check Authorization header first
    if auth := r.Header.Get("Authorization"); auth != "" {
        if strings.HasPrefix(auth, "Bearer ") {
            return strings.TrimPrefix(auth, "Bearer ")
        }
    }
    // Fall back to query parameter (used during WebSocket upgrade)
    return r.URL.Query().Get("token")
}
```

### 6.2 WebSocket HTTP Handler

```go
// cmd/server/main.go
package main

import (
    "context"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/gorilla/websocket"
    "github.com/yourorg/collab-ws/internal/auth"
    "github.com/yourorg/collab-ws/internal/hub"
    "github.com/yourorg/collab-ws/internal/pubsub"
    "go.uber.org/zap"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  4096,
    WriteBufferSize: 4096,
    CheckOrigin: func(r *http.Request) bool {
        // In production, validate against allowed origins
        origin := r.Header.Get("Origin")
        allowedOrigins := map[string]bool{
            "https://app.yourcompany.com": true,
            "https://staging.yourcompany.com": true,
        }
        return allowedOrigins[origin]
    },
    HandshakeTimeout: 10 * time.Second,
    // Enable compression
    EnableCompression: true,
}

type Server struct {
    hub       *hub.Hub
    validator *auth.Validator
    logger    *zap.Logger
}

func (s *Server) ServeWebSocket(w http.ResponseWriter, r *http.Request) {
    // Authenticate before upgrading
    claims, err := s.validator.ValidateFromRequest(r)
    if err != nil {
        s.logger.Warn("websocket auth failed",
            zap.String("remote_addr", r.RemoteAddr),
            zap.Error(err),
        )
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        return
    }

    // Upgrade the HTTP connection to WebSocket
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        s.logger.Error("websocket upgrade failed", zap.Error(err))
        return
    }
    conn.SetCompressionLevel(6)

    // Create the client
    client := hub.NewClient(
        s.hub,
        conn,
        claims.UserID,
        claims.UserName,
        s.logger,
    )

    // Register with hub
    s.hub.Register(client)

    // Start read and write pumps in separate goroutines
    go client.WritePump()
    go client.ReadPump()

    s.logger.Info("websocket client connected",
        zap.String("user_id", claims.UserID),
        zap.String("remote_addr", r.RemoteAddr),
    )
}

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM,
    )
    defer stop()

    // Initialize Redis pub-sub for horizontal scaling
    redisAddr := os.Getenv("REDIS_ADDR")
    if redisAddr == "" {
        redisAddr = "localhost:6379"
    }

    var ps *pubsub.RedisClient
    if redisAddr != "" {
        var err error
        ps, err = pubsub.NewRedisClient(redisAddr, "", 0, logger)
        if err != nil {
            logger.Warn("Redis unavailable, running single-instance", zap.Error(err))
        }
        defer ps.Close()
    }

    // Initialize hub
    h := hub.NewHub(logger, ps)
    go h.Run(ctx)

    // Initialize JWT validator
    jwtSecret := os.Getenv("JWT_SECRET")
    if jwtSecret == "" {
        logger.Fatal("JWT_SECRET environment variable required")
    }
    validator := auth.NewValidator(jwtSecret)

    server := &Server{
        hub:       h,
        validator: validator,
        logger:    logger,
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/ws", server.ServeWebSocket)
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("ok"))
    })

    httpServer := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Start HTTP server
    go func() {
        logger.Info("websocket server starting", zap.String("addr", httpServer.Addr))
        if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
            logger.Fatal("server error", zap.Error(err))
        }
    }()

    // Wait for shutdown signal
    <-ctx.Done()
    logger.Info("shutdown signal received")

    // Graceful shutdown: allow 30s for in-flight connections
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := httpServer.Shutdown(shutdownCtx); err != nil {
        logger.Error("server shutdown error", zap.Error(err))
    }
    logger.Info("server stopped")
}
```

---

## Section 7: Client-Side JavaScript

### 7.1 WebSocket Client Library

```javascript
// client/websocket-client.js
class CollabWebSocketClient {
    constructor(url, token, options = {}) {
        this.url = url;
        this.token = token;
        this.options = {
            reconnectInterval: 1000,
            maxReconnectInterval: 30000,
            reconnectDecay: 1.5,
            pingInterval: 45000,
            ...options
        };

        this.ws = null;
        this.reconnectAttempts = 0;
        this.connected = false;
        this.handlers = new Map();
        this.pendingMessages = [];

        this._connect();
    }

    _connect() {
        const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;

            // Flush pending messages
            while (this.pendingMessages.length > 0) {
                this.ws.send(this.pendingMessages.shift());
            }

            this._startPing();
            this._emit('connected');
        };

        this.ws.onmessage = (event) => {
            try {
                const envelope = JSON.parse(event.data);
                this._emit(envelope.type, envelope);
            } catch (e) {
                console.error('Failed to parse WebSocket message:', e);
            }
        };

        this.ws.onclose = (event) => {
            this.connected = false;
            this._stopPing();

            if (event.code === 1008) {
                // Policy violation (e.g., auth failed) — don't reconnect
                console.error('WebSocket closed: auth failed');
                this._emit('auth_failed');
                return;
            }

            this._emit('disconnected', event);
            this._scheduleReconnect();
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this._emit('error', error);
        };
    }

    _scheduleReconnect() {
        const delay = Math.min(
            this.options.reconnectInterval * Math.pow(
                this.options.reconnectDecay,
                this.reconnectAttempts
            ),
            this.options.maxReconnectInterval
        );

        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
        setTimeout(() => {
            this.reconnectAttempts++;
            this._connect();
        }, delay);
    }

    _startPing() {
        this._pingTimer = setInterval(() => {
            if (this.connected) {
                this.send('ping', {});
            }
        }, this.options.pingInterval);
    }

    _stopPing() {
        clearInterval(this._pingTimer);
    }

    send(type, payload, roomId = null) {
        const envelope = {
            type,
            msg_id: crypto.randomUUID(),
            room_id: roomId,
            ts: Date.now(),
            payload: payload ? JSON.stringify(payload) : undefined
        };
        const data = JSON.stringify(envelope);

        if (this.connected && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data);
        } else {
            this.pendingMessages.push(data);
        }
    }

    joinRoom(roomId) {
        this.send('join_room', { room_id: roomId, user_name: this.userName }, roomId);
    }

    leaveRoom(roomId) {
        this.send('leave_room', null, roomId);
    }

    sendMessage(roomId, content) {
        this.send('send_message', { content }, roomId);
    }

    sendCursorMove(roomId, line, col) {
        this.send('cursor_move', { line, col }, roomId);
    }

    on(event, handler) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event).push(handler);
        return () => this.off(event, handler);
    }

    off(event, handler) {
        const handlers = this.handlers.get(event) || [];
        this.handlers.set(event, handlers.filter(h => h !== handler));
    }

    _emit(event, data) {
        const handlers = this.handlers.get(event) || [];
        handlers.forEach(h => h(data));
    }

    disconnect() {
        this._stopPing();
        if (this.ws) {
            this.ws.close(1000, 'client disconnect');
        }
    }
}

// Usage
const client = new CollabWebSocketClient('wss://api.yourcompany.com/ws', '<jwt-token>');

client.on('connected', () => {
    client.joinRoom('document-abc123');
});

client.on('presence_update', (envelope) => {
    const presence = JSON.parse(envelope.payload);
    console.log(`User ${presence.user_name} is ${presence.online ? 'online' : 'offline'}`);
});

client.on('broadcast', (envelope) => {
    const msg = JSON.parse(envelope.payload);
    console.log(`Message from ${envelope.user_id}:`, msg);
});
```

---

## Section 8: Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: collab-ws
  namespace: production
spec:
  replicas: 4
  selector:
    matchLabels:
      app: collab-ws
  template:
    metadata:
      labels:
        app: collab-ws
    spec:
      containers:
        - name: collab-ws
          image: yourorg/collab-ws:v1.0.0
          ports:
            - containerPort: 8080
              name: ws
          env:
            - name: REDIS_ADDR
              value: redis-master.cache.svc.cluster.local:6379
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: collab-ws-secrets
                  key: jwt-secret
          resources:
            requests:
              cpu: 200m
              memory: 128Mi
            limits:
              cpu: 1000m
              memory: 512Mi
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
          # Allow time for WebSocket connections to drain
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]
      # Long termination grace period for WebSocket drain
      terminationGracePeriodSeconds: 60

---
# Sticky sessions are required for WebSocket when not using Redis
# Without Redis, all connections to same pod must be maintained
apiVersion: v1
kind: Service
metadata:
  name: collab-ws
  namespace: production
  annotations:
    # AWS ALB: enable sticky sessions for WebSocket
    service.beta.kubernetes.io/aws-load-balancer-target-group-attributes: |
      stickiness.enabled=true,stickiness.lb_cookie.duration_seconds=86400
spec:
  selector:
    app: collab-ws
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: collab-ws
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    # Enable WebSocket upgrade
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
spec:
  rules:
    - host: ws.yourcompany.com
      http:
        paths:
          - path: /ws
            pathType: Prefix
            backend:
              service:
                name: collab-ws
                port:
                  number: 80
```

---

## Section 9: Performance and Monitoring

### 9.1 Prometheus Metrics

```go
// Add to hub.go
import "github.com/prometheus/client_golang/prometheus"

var (
    connectedClients = prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "ws_connected_clients",
        Help: "Number of currently connected WebSocket clients",
    })
    messagesTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "ws_messages_total",
        Help: "Total WebSocket messages by type",
    }, []string{"type", "direction"})
    activeRooms = prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "ws_active_rooms",
        Help: "Number of active rooms",
    })
    messageDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "ws_message_processing_duration_seconds",
        Help:    "Time to process a WebSocket message",
        Buckets: prometheus.DefBuckets,
    }, []string{"type"})
)

func init() {
    prometheus.MustRegister(connectedClients, messagesTotal, activeRooms, messageDuration)
}
```

### 9.2 Load Testing

```bash
# Install websocat for WebSocket testing
# or use k6 with WebSocket support

# k6 WebSocket load test
cat > ws-load-test.js << 'EOF'
import ws from 'k6/ws';
import { check } from 'k6';

export const options = {
    vus: 100,
    duration: '60s',
};

export default function () {
    const token = '<test-jwt-token>';
    const url = `wss://ws.yourcompany.com/ws?token=${token}`;

    const res = ws.connect(url, {}, function (socket) {
        socket.on('open', () => {
            socket.send(JSON.stringify({
                type: 'join_room',
                room_id: 'load-test-room',
                ts: Date.now(),
                payload: JSON.stringify({ room_id: 'load-test-room', user_name: 'test-user' }),
            }));
        });

        socket.on('message', (data) => {
            const msg = JSON.parse(data);
            check(msg, {
                'received valid message': (m) => m.type !== undefined,
            });
        });

        socket.setTimeout(() => {
            socket.close();
        }, 50000);
    });

    check(res, { 'connected successfully': (r) => r && r.status === 101 });
}
EOF

k6 run ws-load-test.js
```

---

## Summary

Building a production WebSocket server in Go requires careful attention to concurrency, backpressure, and horizontal scaling. The key design decisions:

1. **Separate read and write pumps** — each in its own goroutine prevents head-of-line blocking
2. **Buffered send channels with drop-on-full** — protects fast clients from slow clients
3. **Hub pattern** — centralize connection state to avoid distributed locking
4. **Redis pub-sub** — enables horizontal scaling without sticky sessions becoming a requirement
5. **JWT in query parameter** — WebSocket upgrade requests cannot include custom headers in most browsers
6. **Long termination grace period** — allow existing connections to drain before pod replacement
7. **Per-message type metrics** — visibility into which message types dominate traffic

With Redis pub-sub, this architecture scales horizontally to handle hundreds of thousands of concurrent connections across multiple instances.
