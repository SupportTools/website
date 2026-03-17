---
title: "Go WebSocket Production Patterns: Connection Lifecycle, Authentication, and Redis Pub/Sub Scaling"
date: 2028-05-25T00:00:00-05:00
draft: false
tags: ["Go", "WebSocket", "Redis", "gorilla/websocket", "Real-Time", "Production"]
categories: ["Go", "Backend Engineering", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production WebSocket patterns in Go covering gorilla/websocket, nhooyr/websocket, connection lifecycle management, heartbeats, room-based broadcast, authentication, and horizontal scaling with Redis pub/sub."
more_link: "yes"
url: "/go-websocket-production-patterns-advanced/"
---

WebSocket connections present unique production challenges: long-lived connections that consume memory, goroutine leaks from improper cleanup, authentication that must survive connection upgrades, and stateful routing that breaks horizontal scaling. This guide addresses all of these with production-tested patterns covering the two dominant Go WebSocket libraries and a complete architecture for scaling to hundreds of thousands of concurrent connections.

<!--more-->

## Library Comparison: gorilla/websocket vs nhooyr/websocket

Both libraries are production-worthy with different trade-offs.

**gorilla/websocket** (github.com/gorilla/websocket) is the most widely deployed Go WebSocket library. It provides fine-grained control over framing, binary/text message types, compression, and connection parameters. The API is explicit about read/write deadlines.

**nhooyr/websocket** (nhooyr.io/websocket) offers a cleaner, context-aware API. It handles graceful closes more ergonomically and integrates naturally with Go's `context` package for cancellation. It compiles to WebAssembly for browser usage.

Choose gorilla/websocket for maximum control and ecosystem compatibility. Choose nhooyr/websocket for cleaner context propagation and WASM targets.

## Core Connection Lifecycle

### Connection Upgrade and Initial Handshake

```go
package websocket

import (
    "context"
    "log/slog"
    "net/http"
    "time"

    "github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  4096,
    WriteBufferSize: 4096,
    // HandshakeTimeout controls how long the upgrade can take
    HandshakeTimeout: 10 * time.Second,
    // CheckOrigin must be implemented for production — never allow all origins
    CheckOrigin: func(r *http.Request) bool {
        origin := r.Header.Get("Origin")
        return isAllowedOrigin(origin)
    },
    // Enable per-message compression for text-heavy protocols
    EnableCompression: true,
    // Subprotocol negotiation
    Subprotocols: []string{"v1.chat", "v2.chat"},
    // Error handler for failed upgrades
    Error: func(w http.ResponseWriter, r *http.Request, status int, reason error) {
        slog.Error("websocket upgrade failed",
            "status", status,
            "reason", reason,
            "remote_addr", r.RemoteAddr,
        )
        http.Error(w, reason.Error(), status)
    },
}

func isAllowedOrigin(origin string) bool {
    allowed := map[string]bool{
        "https://app.example.com":     true,
        "https://staging.example.com": true,
        "http://localhost:3000":        true,
    }
    return allowed[origin]
}

func HandleWebSocket(hub *Hub, auth Authenticator) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Authenticate before upgrading — once upgraded, returning 401 is impossible
        user, err := auth.ValidateRequest(r)
        if err != nil {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }

        conn, err := upgrader.Upgrade(w, r, nil)
        if err != nil {
            // upgrader already wrote the error response
            return
        }

        // Configure connection parameters
        conn.SetReadLimit(maxMessageSize)

        // Create client and register with hub
        client := &Client{
            ID:      generateClientID(),
            UserID:  user.ID,
            conn:    conn,
            hub:     hub,
            send:    make(chan []byte, sendChannelBuffer),
            rooms:   make(map[string]struct{}),
            created: time.Now(),
        }

        hub.Register(client)
        defer hub.Unregister(client)

        // Run read and write pumps concurrently
        // writePump owns the write side of the connection
        // readPump owns the read side
        go client.writePump(ctx)
        client.readPump(ctx) // blocks until connection closes
    }
}
```

### The Read Pump

The read pump is the heart of the connection. It must handle timeouts, ping/pong, and message routing.

```go
const (
    // Time allowed to read the next pong message from the client
    pongWait = 60 * time.Second
    // Send pings to client with this period (must be less than pongWait)
    pingPeriod = (pongWait * 9) / 10
    // Maximum message size allowed from client
    maxMessageSize = 65536 // 64KB
    // Send channel buffer size
    sendChannelBuffer = 256
)

func (c *Client) readPump(ctx context.Context) {
    defer func() {
        // Drain the send channel to unblock writePump
        close(c.send)
    }()

    c.conn.SetReadLimit(maxMessageSize)

    // Initial read deadline — pong handler will extend this
    if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
        slog.Error("failed to set read deadline", "client_id", c.ID, "err", err)
        return
    }

    // Pong handler extends the read deadline each time a pong arrives
    c.conn.SetPongHandler(func(appData string) error {
        c.lastPong = time.Now()
        return c.conn.SetReadDeadline(time.Now().Add(pongWait))
    })

    // Close handler for graceful close
    c.conn.SetCloseHandler(func(code int, text string) error {
        slog.Info("client sent close",
            "client_id", c.ID,
            "code", code,
            "text", text,
        )
        // Send close message back
        message := websocket.FormatCloseMessage(code, "")
        c.conn.WriteControl(websocket.CloseMessage, message, time.Now().Add(time.Second))
        return nil
    })

    for {
        messageType, data, err := c.conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err,
                websocket.CloseGoingAway,
                websocket.CloseAbnormalClosure,
                websocket.CloseNormalClosure,
            ) {
                slog.Warn("unexpected websocket close",
                    "client_id", c.ID,
                    "err", err,
                )
            }
            return
        }

        // Only accept text or binary messages
        if messageType != websocket.TextMessage && messageType != websocket.BinaryMessage {
            continue
        }

        // Route the message through the hub
        msg := &IncomingMessage{
            ClientID: c.ID,
            UserID:   c.UserID,
            Type:     messageType,
            Data:     data,
            ReceivedAt: time.Now(),
        }

        select {
        case c.hub.incoming <- msg:
        case <-ctx.Done():
            return
        default:
            // Hub's incoming channel is full — client is sending too fast
            slog.Warn("hub incoming channel full, dropping message",
                "client_id", c.ID,
            )
        }
    }
}
```

### The Write Pump

```go
func (c *Client) writePump(ctx context.Context) {
    ticker := time.NewTicker(pingPeriod)
    defer func() {
        ticker.Stop()
        // Initiate connection close from the write side
        c.conn.Close()
    }()

    for {
        select {
        case message, ok := <-c.send:
            // Extend write deadline for each message
            if err := c.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
                return
            }

            if !ok {
                // Hub closed the send channel — send a close message
                c.conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }

            // Use NextWriter for efficient batching of multiple messages
            w, err := c.conn.NextWriter(websocket.TextMessage)
            if err != nil {
                return
            }
            w.Write(message)

            // Drain any pending messages in the send channel
            // This batches multiple messages into a single WebSocket frame
            pending := len(c.send)
            for i := 0; i < pending; i++ {
                w.Write(newline)
                w.Write(<-c.send)
            }

            if err := w.Close(); err != nil {
                return
            }

        case <-ticker.C:
            // Send ping — read pump's pong handler resets the read deadline
            if err := c.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
                return
            }
            if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }

        case <-ctx.Done():
            // Server-side shutdown — send close message
            c.conn.WriteMessage(
                websocket.CloseMessage,
                websocket.FormatCloseMessage(websocket.CloseServiceRestart, "server shutdown"),
            )
            return
        }
    }
}
```

## Hub Architecture

The Hub manages all active connections, room memberships, and message routing.

```go
package websocket

import (
    "context"
    "log/slog"
    "sync"
    "time"
)

// Hub maintains the set of active clients and broadcasts messages
type Hub struct {
    // Registered clients (client ID → client)
    clients   map[string]*Client
    clientsMu sync.RWMutex

    // Room memberships (room ID → set of client IDs)
    rooms   map[string]map[string]struct{}
    roomsMu sync.RWMutex

    // Inbound messages from clients
    incoming chan *IncomingMessage

    // Register/Unregister channels (avoids locking in hot path)
    register   chan *Client
    unregister chan *Client

    // Broadcast to a specific room
    broadcast chan *BroadcastMessage

    // Metrics
    metrics *HubMetrics
}

type BroadcastMessage struct {
    RoomID  string
    Payload []byte
    // Exclude specific client from receiving
    ExcludeClientID string
}

type IncomingMessage struct {
    ClientID   string
    UserID     string
    Type       int
    Data       []byte
    ReceivedAt time.Time
}

func NewHub(metrics *HubMetrics) *Hub {
    return &Hub{
        clients:    make(map[string]*Client),
        rooms:      make(map[string]map[string]struct{}),
        incoming:   make(chan *IncomingMessage, 4096),
        register:   make(chan *Client, 64),
        unregister: make(chan *Client, 64),
        broadcast:  make(chan *BroadcastMessage, 4096),
        metrics:    metrics,
    }
}

func (h *Hub) Run(ctx context.Context) {
    for {
        select {
        case client := <-h.register:
            h.clientsMu.Lock()
            h.clients[client.ID] = client
            h.clientsMu.Unlock()
            h.metrics.ClientsConnected.Inc()
            slog.Info("client registered", "client_id", client.ID, "user_id", client.UserID)

        case client := <-h.unregister:
            h.clientsMu.Lock()
            if _, ok := h.clients[client.ID]; ok {
                delete(h.clients, client.ID)
            }
            h.clientsMu.Unlock()

            // Remove from all rooms
            h.roomsMu.Lock()
            for roomID, members := range h.rooms {
                if _, ok := members[client.ID]; ok {
                    delete(members, client.ID)
                    if len(members) == 0 {
                        delete(h.rooms, roomID)
                    }
                }
            }
            h.roomsMu.Unlock()

            h.metrics.ClientsConnected.Dec()
            slog.Info("client unregistered", "client_id", client.ID)

        case msg := <-h.broadcast:
            h.broadcastToRoom(msg)

        case <-ctx.Done():
            h.closeAllClients()
            return
        }
    }
}

func (h *Hub) broadcastToRoom(msg *BroadcastMessage) {
    h.roomsMu.RLock()
    members, ok := h.rooms[msg.RoomID]
    if !ok {
        h.roomsMu.RUnlock()
        return
    }
    // Copy member IDs to avoid holding lock during sends
    memberIDs := make([]string, 0, len(members))
    for id := range members {
        if id != msg.ExcludeClientID {
            memberIDs = append(memberIDs, id)
        }
    }
    h.roomsMu.RUnlock()

    h.clientsMu.RLock()
    defer h.clientsMu.RUnlock()

    sent := 0
    for _, id := range memberIDs {
        client, ok := h.clients[id]
        if !ok {
            continue
        }
        select {
        case client.send <- msg.Payload:
            sent++
        default:
            // Client's send buffer is full — slow consumer
            slog.Warn("client send buffer full",
                "client_id", id,
                "room_id", msg.RoomID,
            )
            h.metrics.DroppedMessages.Inc()
        }
    }
    h.metrics.MessagesDelivered.Add(float64(sent))
}

func (h *Hub) JoinRoom(clientID, roomID string) {
    h.roomsMu.Lock()
    defer h.roomsMu.Unlock()

    if _, ok := h.rooms[roomID]; !ok {
        h.rooms[roomID] = make(map[string]struct{})
    }
    h.rooms[roomID][clientID] = struct{}{}
}

func (h *Hub) LeaveRoom(clientID, roomID string) {
    h.roomsMu.Lock()
    defer h.roomsMu.Unlock()

    if members, ok := h.rooms[roomID]; ok {
        delete(members, clientID)
        if len(members) == 0 {
            delete(h.rooms, roomID)
        }
    }
}

func (h *Hub) closeAllClients() {
    h.clientsMu.RLock()
    defer h.clientsMu.RUnlock()
    for _, client := range h.clients {
        close(client.send)
    }
}

func (h *Hub) Register(c *Client) {
    h.register <- c
}

func (h *Hub) Unregister(c *Client) {
    h.unregister <- c
}

func (h *Hub) Broadcast(msg *BroadcastMessage) {
    select {
    case h.broadcast <- msg:
    default:
        slog.Warn("broadcast channel full", "room_id", msg.RoomID)
    }
}
```

## Authentication Patterns

### JWT Validation During Upgrade

```go
package auth

import (
    "errors"
    "net/http"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

type Claims struct {
    UserID    string   `json:"sub"`
    Username  string   `json:"username"`
    Roles     []string `json:"roles"`
    SessionID string   `json:"sid"`
    jwt.RegisteredClaims
}

type JWTAuthenticator struct {
    signingKey []byte
    issuer     string
}

type User struct {
    ID        string
    Username  string
    Roles     []string
    SessionID string
}

func (a *JWTAuthenticator) ValidateRequest(r *http.Request) (*User, error) {
    token := extractToken(r)
    if token == "" {
        return nil, errors.New("no token provided")
    }

    claims := &Claims{}
    parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
        if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, errors.New("unexpected signing method")
        }
        return a.signingKey, nil
    },
        jwt.WithIssuer(a.issuer),
        jwt.WithExpirationRequired(),
    )

    if err != nil || !parsed.Valid {
        return nil, errors.New("invalid token")
    }

    // Reject tokens expiring very soon to avoid mid-session expiry
    if time.Until(claims.ExpiresAt.Time) < 30*time.Second {
        return nil, errors.New("token expiring too soon")
    }

    return &User{
        ID:        claims.UserID,
        Username:  claims.Username,
        Roles:     claims.Roles,
        SessionID: claims.SessionID,
    }, nil
}

func extractToken(r *http.Request) string {
    // Check Authorization header first
    authHeader := r.Header.Get("Authorization")
    if strings.HasPrefix(authHeader, "Bearer ") {
        return strings.TrimPrefix(authHeader, "Bearer ")
    }

    // WebSocket clients often can't set custom headers from the browser
    // Accept token in query parameter for browser WebSocket API compatibility
    // Note: query params appear in server access logs — use short-lived tokens
    if token := r.URL.Query().Get("token"); token != "" {
        return token
    }

    // Also check Sec-WebSocket-Protocol header (subprotocol hack)
    // Some browser environments support this pattern
    protocol := r.Header.Get("Sec-WebSocket-Protocol")
    if strings.HasPrefix(protocol, "Bearer.") {
        return strings.TrimPrefix(protocol, "Bearer.")
    }

    return ""
}
```

### Token Refresh During Session

```go
// TokenRefresher sends updated tokens to maintain long-lived connections
type TokenRefresher struct {
    client       *Client
    tokenSource  TokenSource
    refreshBefore time.Duration
}

func (tr *TokenRefresher) Run(ctx context.Context) {
    for {
        token, expiry, err := tr.tokenSource.CurrentToken(ctx)
        if err != nil {
            slog.Error("failed to get current token", "client_id", tr.client.ID, "err", err)
            return
        }

        // Wait until it's time to refresh
        refreshAt := time.Until(expiry) - tr.refreshBefore
        if refreshAt < 0 {
            refreshAt = 0
        }

        select {
        case <-time.After(refreshAt):
        case <-ctx.Done():
            return
        }

        newToken, _, err := tr.tokenSource.RefreshToken(ctx)
        if err != nil {
            slog.Error("failed to refresh token", "client_id", tr.client.ID, "err", err)
            return
        }

        // Send token refresh message to client
        msg := map[string]string{
            "type":  "token_refresh",
            "token": newToken,
        }
        data, _ := json.Marshal(msg)
        select {
        case tr.client.send <- data:
        case <-ctx.Done():
            return
        }
    }
}
```

## Message Protocol Design

```go
package protocol

import (
    "encoding/json"
    "fmt"
    "time"
)

// Envelope is the top-level message format
type Envelope struct {
    Type      string          `json:"type"`
    ID        string          `json:"id,omitempty"`   // for request-response correlation
    Timestamp int64           `json:"ts"`              // unix milliseconds
    Payload   json.RawMessage `json:"payload,omitempty"`
    Error     *ErrorPayload   `json:"error,omitempty"`
}

type ErrorPayload struct {
    Code    string `json:"code"`
    Message string `json:"message"`
}

// Common message types
const (
    TypePing         = "ping"
    TypePong         = "pong"
    TypeJoinRoom     = "join_room"
    TypeLeaveRoom    = "leave_room"
    TypeChatMessage  = "chat_message"
    TypePresence     = "presence"
    TypeTokenRefresh = "token_refresh"
    TypeError        = "error"
    TypeAck          = "ack"
)

type JoinRoomPayload struct {
    RoomID string `json:"room_id"`
}

type ChatMessagePayload struct {
    RoomID  string `json:"room_id"`
    Content string `json:"content"`
    Format  string `json:"format"` // text, markdown
}

func ParseEnvelope(data []byte) (*Envelope, error) {
    if len(data) > maxMessageSize {
        return nil, fmt.Errorf("message size %d exceeds limit %d", len(data), maxMessageSize)
    }

    var env Envelope
    if err := json.Unmarshal(data, &env); err != nil {
        return nil, fmt.Errorf("invalid envelope: %w", err)
    }

    if env.Type == "" {
        return nil, fmt.Errorf("missing message type")
    }

    return &env, nil
}

func NewEnvelope(msgType string, payload interface{}) ([]byte, error) {
    p, err := json.Marshal(payload)
    if err != nil {
        return nil, err
    }

    env := Envelope{
        Type:      msgType,
        Timestamp: time.Now().UnixMilli(),
        Payload:   p,
    }

    return json.Marshal(env)
}

func ErrorEnvelope(code, message string) []byte {
    env := Envelope{
        Type:      TypeError,
        Timestamp: time.Now().UnixMilli(),
        Error: &ErrorPayload{
            Code:    code,
            Message: message,
        },
    }
    data, _ := json.Marshal(env)
    return data
}
```

## Message Routing and Handler Registry

```go
package handler

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
)

type MessageHandler func(ctx context.Context, client *Client, env *Envelope) error

type Router struct {
    handlers map[string]MessageHandler
    hub      *Hub
}

func NewRouter(hub *Hub) *Router {
    r := &Router{
        handlers: make(map[string]MessageHandler),
        hub:      hub,
    }

    // Register built-in handlers
    r.Register(TypePing, r.handlePing)
    r.Register(TypeJoinRoom, r.handleJoinRoom)
    r.Register(TypeLeaveRoom, r.handleLeaveRoom)
    r.Register(TypeChatMessage, r.handleChatMessage)

    return r
}

func (r *Router) Register(msgType string, handler MessageHandler) {
    r.handlers[msgType] = handler
}

func (r *Router) Route(ctx context.Context, client *Client, data []byte) {
    env, err := ParseEnvelope(data)
    if err != nil {
        slog.Warn("failed to parse message",
            "client_id", client.ID,
            "err", err,
        )
        client.SendError("parse_error", err.Error())
        return
    }

    handler, ok := r.handlers[env.Type]
    if !ok {
        client.SendError("unknown_type", fmt.Sprintf("unknown message type: %s", env.Type))
        return
    }

    if err := handler(ctx, client, env); err != nil {
        slog.Error("handler error",
            "client_id", client.ID,
            "type", env.Type,
            "err", err,
        )
        client.SendError("handler_error", "internal error processing message")
    }
}

func (r *Router) handlePing(ctx context.Context, client *Client, env *Envelope) error {
    pong, _ := NewEnvelope(TypePong, nil)
    return client.Send(pong)
}

func (r *Router) handleJoinRoom(ctx context.Context, client *Client, env *Envelope) error {
    var payload JoinRoomPayload
    if err := json.Unmarshal(env.Payload, &payload); err != nil {
        return fmt.Errorf("invalid join_room payload: %w", err)
    }

    if payload.RoomID == "" {
        return fmt.Errorf("room_id required")
    }

    // Enforce room membership limit
    if len(client.rooms) >= maxRoomsPerClient {
        return fmt.Errorf("room limit reached")
    }

    r.hub.JoinRoom(client.ID, payload.RoomID)
    client.rooms[payload.RoomID] = struct{}{}

    ack, _ := NewEnvelope(TypeAck, map[string]string{"room_id": payload.RoomID})
    return client.Send(ack)
}

func (r *Router) handleChatMessage(ctx context.Context, client *Client, env *Envelope) error {
    var payload ChatMessagePayload
    if err := json.Unmarshal(env.Payload, &payload); err != nil {
        return fmt.Errorf("invalid chat_message payload: %w", err)
    }

    // Validate client is in the room
    if _, ok := client.rooms[payload.RoomID]; !ok {
        return fmt.Errorf("not a member of room %s", payload.RoomID)
    }

    // Sanitize content
    payload.Content = sanitizeContent(payload.Content)
    if len(payload.Content) > maxChatLength {
        return fmt.Errorf("message too long")
    }

    outbound := &OutboundChatMessage{
        RoomID:   payload.RoomID,
        SenderID: client.UserID,
        Content:  payload.Content,
        Format:   payload.Format,
        SentAt:   time.Now().UnixMilli(),
    }

    outboundData, err := NewEnvelope(TypeChatMessage, outbound)
    if err != nil {
        return err
    }

    r.hub.Broadcast(&BroadcastMessage{
        RoomID:          payload.RoomID,
        Payload:         outboundData,
        ExcludeClientID: "", // include sender
    })

    return nil
}
```

## Scaling with Redis Pub/Sub

When running multiple WebSocket server instances, a message broadcast on server A needs to reach clients connected to server B. Redis pub/sub provides the inter-node message bus.

### Redis Broker

```go
package broker

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"

    "github.com/redis/go-redis/v9"
)

const (
    roomChannelPrefix = "ws:room:"
    presenceKeyPrefix = "ws:presence:"
    presenceTTL       = 5 * time.Minute
)

type RedisBroker struct {
    client   *redis.Client
    hub      *Hub
    serverID string
}

type BrokerMessage struct {
    ServerID string          `json:"server_id"`
    RoomID   string          `json:"room_id"`
    Payload  json.RawMessage `json:"payload"`
    // Exclude clients on the originating server (they already received it)
    ExcludeOnServer string `json:"exclude_server,omitempty"`
}

func NewRedisBroker(redisClient *redis.Client, hub *Hub, serverID string) *RedisBroker {
    return &RedisBroker{
        client:   redisClient,
        hub:      hub,
        serverID: serverID,
    }
}

// PublishToRoom publishes a message to all servers subscribed to a room channel
func (b *RedisBroker) PublishToRoom(ctx context.Context, roomID string, payload []byte) error {
    msg := BrokerMessage{
        ServerID: b.serverID,
        RoomID:   roomID,
        Payload:  payload,
    }
    data, err := json.Marshal(msg)
    if err != nil {
        return fmt.Errorf("marshal broker message: %w", err)
    }

    channel := roomChannelPrefix + roomID
    result := b.client.Publish(ctx, channel, data)
    if err := result.Err(); err != nil {
        return fmt.Errorf("redis publish: %w", err)
    }
    return nil
}

// SubscribeToRoom subscribes this server to a room channel
func (b *RedisBroker) SubscribeToRoom(ctx context.Context, roomID string) {
    channel := roomChannelPrefix + roomID

    // Check if already subscribed
    b.mu.RLock()
    _, subscribed := b.subscriptions[roomID]
    b.mu.RUnlock()

    if subscribed {
        return
    }

    b.mu.Lock()
    defer b.mu.Unlock()

    pubsub := b.client.Subscribe(ctx, channel)
    b.subscriptions[roomID] = pubsub

    go b.handleSubscription(ctx, roomID, pubsub)
}

func (b *RedisBroker) handleSubscription(ctx context.Context, roomID string, pubsub *redis.PubSub) {
    defer pubsub.Close()

    ch := pubsub.Channel()
    for {
        select {
        case msg, ok := <-ch:
            if !ok {
                return
            }

            var brokerMsg BrokerMessage
            if err := json.Unmarshal([]byte(msg.Payload), &brokerMsg); err != nil {
                slog.Error("failed to unmarshal broker message",
                    "room_id", roomID,
                    "err", err,
                )
                continue
            }

            // Skip messages from this server — we already broadcast locally
            if brokerMsg.ServerID == b.serverID {
                continue
            }

            // Broadcast to local clients in the room
            b.hub.Broadcast(&BroadcastMessage{
                RoomID:  roomID,
                Payload: brokerMsg.Payload,
            })

        case <-ctx.Done():
            return
        }
    }
}

// TrackPresence updates the server registry for a client
func (b *RedisBroker) TrackPresence(ctx context.Context, userID string) error {
    key := presenceKeyPrefix + userID
    return b.client.Set(ctx, key, b.serverID, presenceTTL).Err()
}

// RefreshPresence prevents the presence key from expiring
func (b *RedisBroker) RefreshPresence(ctx context.Context, userID string) {
    ticker := time.NewTicker(presenceTTL / 2)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            key := presenceKeyPrefix + userID
            b.client.Expire(ctx, key, presenceTTL)
        case <-ctx.Done():
            return
        }
    }
}

// GetPresence returns which server a user is connected to
func (b *RedisBroker) GetPresence(ctx context.Context, userID string) (string, error) {
    key := presenceKeyPrefix + userID
    serverID, err := b.client.Get(ctx, key).Result()
    if err == redis.Nil {
        return "", nil // user not connected
    }
    return serverID, err
}
```

### Integrated Hub with Broker

```go
// FederatedHub coordinates local hub and Redis broker
type FederatedHub struct {
    local  *Hub
    broker *RedisBroker
}

func (h *FederatedHub) BroadcastToRoom(ctx context.Context, roomID string, payload []byte, excludeClientID string) {
    // Broadcast to local clients immediately
    h.local.Broadcast(&BroadcastMessage{
        RoomID:          roomID,
        Payload:         payload,
        ExcludeClientID: excludeClientID,
    })

    // Publish to Redis for remote servers
    if err := h.broker.PublishToRoom(ctx, roomID, payload); err != nil {
        slog.Error("failed to publish to broker",
            "room_id", roomID,
            "err", err,
        )
    }
}

func (h *FederatedHub) JoinRoom(ctx context.Context, clientID, roomID string) {
    h.local.JoinRoom(clientID, roomID)
    h.broker.SubscribeToRoom(ctx, roomID)
}
```

## Connection Rate Limiting

```go
package ratelimit

import (
    "net/http"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

type IPLimiter struct {
    limiters map[string]*rate.Limiter
    mu       sync.RWMutex
    rate     rate.Limit
    burst    int
    // Cleanup interval for idle entries
    cleanupTicker *time.Ticker
}

func NewIPLimiter(r rate.Limit, burst int) *IPLimiter {
    il := &IPLimiter{
        limiters:      make(map[string]*rate.Limiter),
        rate:          r,
        burst:         burst,
        cleanupTicker: time.NewTicker(5 * time.Minute),
    }
    go il.cleanup()
    return il
}

func (l *IPLimiter) GetLimiter(ip string) *rate.Limiter {
    l.mu.RLock()
    limiter, ok := l.limiters[ip]
    l.mu.RUnlock()

    if ok {
        return limiter
    }

    l.mu.Lock()
    defer l.mu.Unlock()

    // Check again under write lock
    if limiter, ok = l.limiters[ip]; ok {
        return limiter
    }

    limiter = rate.NewLimiter(l.rate, l.burst)
    l.limiters[ip] = limiter
    return limiter
}

func (l *IPLimiter) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ip := extractIP(r)
        limiter := l.GetLimiter(ip)

        if !limiter.Allow() {
            http.Error(w, "too many connections", http.StatusTooManyRequests)
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

## Metrics and Observability

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

type HubMetrics struct {
    ClientsConnected  prometheus.Gauge
    MessagesReceived  prometheus.Counter
    MessagesDelivered prometheus.Counter
    DroppedMessages   prometheus.Counter
    RoomCount         prometheus.Gauge
    ConnectionErrors  prometheus.Counter
    MessageLatency    prometheus.Histogram
}

func NewHubMetrics(reg prometheus.Registerer) *HubMetrics {
    factory := promauto.With(reg)
    return &HubMetrics{
        ClientsConnected: factory.NewGauge(prometheus.GaugeOpts{
            Name: "websocket_clients_connected_total",
            Help: "Number of currently connected WebSocket clients",
        }),
        MessagesReceived: factory.NewCounter(prometheus.CounterOpts{
            Name: "websocket_messages_received_total",
            Help: "Total messages received from clients",
        }),
        MessagesDelivered: factory.NewCounter(prometheus.CounterOpts{
            Name: "websocket_messages_delivered_total",
            Help: "Total messages delivered to clients",
        }),
        DroppedMessages: factory.NewCounter(prometheus.CounterOpts{
            Name: "websocket_messages_dropped_total",
            Help: "Total messages dropped due to full send buffers",
        }),
        RoomCount: factory.NewGauge(prometheus.GaugeOpts{
            Name: "websocket_rooms_active_total",
            Help: "Number of active rooms with at least one member",
        }),
        MessageLatency: factory.NewHistogram(prometheus.HistogramOpts{
            Name:    "websocket_message_processing_seconds",
            Help:    "Histogram of message processing latency",
            Buckets: prometheus.ExponentialBuckets(0.0001, 2, 16),
        }),
    }
}
```

## Graceful Shutdown

```go
func (s *Server) GracefulShutdown(ctx context.Context) error {
    slog.Info("initiating websocket server graceful shutdown")

    // Stop accepting new connections
    s.httpServer.Shutdown(ctx)

    // Notify all clients of impending shutdown
    shutdownMsg, _ := NewEnvelope("server_shutdown", map[string]interface{}{
        "reason":     "scheduled maintenance",
        "reconnect":  true,
        "retry_after": 30,
    })

    s.hub.BroadcastAll(shutdownMsg)

    // Give clients time to receive the message and reconnect
    select {
    case <-time.After(5 * time.Second):
    case <-ctx.Done():
    }

    // Cancel hub context — closes all connections
    s.cancel()

    // Wait for all goroutines to finish
    done := make(chan struct{})
    go func() {
        s.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        slog.Info("websocket server shutdown complete")
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

## Production Configuration

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: websocket-server
spec:
  replicas: 5
  template:
    spec:
      containers:
        - name: websocket-server
          image: registry.example.com/ws-server:v2.1.0
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: metrics
          env:
            - name: REDIS_ADDR
              value: "redis-cluster.default.svc.cluster.local:6379"
            - name: SERVER_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: MAX_CONNECTIONS
              value: "50000"
            - name: PING_PERIOD_SECONDS
              value: "54"
            - name: PONG_WAIT_SECONDS
              value: "60"
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2
              memory: 2Gi
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]
---
# Service with session affinity for load balancer sticky connections
apiVersion: v1
kind: Service
metadata:
  name: websocket-server
spec:
  selector:
    app: websocket-server
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 3600
  ports:
    - port: 80
      targetPort: 8080
```

## Testing WebSocket Handlers

```go
package websocket_test

import (
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
    "time"

    "github.com/gorilla/websocket"
)

func TestChatBroadcast(t *testing.T) {
    hub := NewHub(NewNopMetrics())
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    go hub.Run(ctx)

    auth := &MockAuthenticator{UserID: "user-1"}
    server := httptest.NewServer(HandleWebSocket(hub, auth))
    defer server.Close()

    wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
    header := http.Header{"Origin": []string{"http://localhost:3000"}}

    // Connect two clients
    conn1, _, err := websocket.DefaultDialer.Dial(wsURL+"?token=valid-token-user1", header)
    if err != nil {
        t.Fatalf("conn1 dial failed: %v", err)
    }
    defer conn1.Close()

    conn2, _, err := websocket.DefaultDialer.Dial(wsURL+"?token=valid-token-user2", header)
    if err != nil {
        t.Fatalf("conn2 dial failed: %v", err)
    }
    defer conn2.Close()

    // Both clients join the same room
    joinMsg, _ := NewEnvelope(TypeJoinRoom, JoinRoomPayload{RoomID: "test-room"})
    conn1.WriteMessage(websocket.TextMessage, joinMsg)
    conn2.WriteMessage(websocket.TextMessage, joinMsg)

    time.Sleep(100 * time.Millisecond) // allow hub to process

    // conn1 sends a chat message
    chatMsg, _ := NewEnvelope(TypeChatMessage, ChatMessagePayload{
        RoomID:  "test-room",
        Content: "hello world",
        Format:  "text",
    })
    conn1.WriteMessage(websocket.TextMessage, chatMsg)

    // conn2 should receive it
    conn2.SetReadDeadline(time.Now().Add(2 * time.Second))
    _, data, err := conn2.ReadMessage()
    if err != nil {
        t.Fatalf("conn2 read failed: %v", err)
    }

    var env Envelope
    if err := json.Unmarshal(data, &env); err != nil {
        t.Fatalf("unmarshal failed: %v", err)
    }

    if env.Type != TypeChatMessage {
        t.Errorf("expected chat_message, got %s", env.Type)
    }
}
```

## Summary

Production WebSocket services in Go require careful attention to goroutine lifecycle, backpressure handling, and horizontal scaling strategy. The key patterns covered:

- Read pumps own the connection read side; write pumps own the write side — no other goroutine should call the connection directly
- Ping/pong with read deadlines provides reliable dead connection detection
- Authenticate before upgrading the connection — HTTP-level auth is impossible post-upgrade
- Hub architecture centralizes connection state and prevents data races
- Redis pub/sub enables room-based broadcasting across multiple server instances
- Session affinity in the load balancer is only a soft dependency when Redis brokers cross-server messages correctly
- Bounded send channels with default cases prevent slow consumers from blocking broadcast operations
