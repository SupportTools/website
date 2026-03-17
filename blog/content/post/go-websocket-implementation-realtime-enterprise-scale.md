---
title: "Go WebSocket Implementation: Real-Time Communication at Enterprise Scale"
date: 2030-12-08T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "WebSocket", "Real-Time", "Redis", "Pub/Sub", "Scalability", "TLS"]
categories:
- Go
- Architecture
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Go WebSocket implementation covering gorilla/websocket vs nhooyr.io/websocket, connection management and heartbeating, hub/spoke broadcast patterns, TLS termination, horizontal scaling with Redis pub/sub, and graceful shutdown."
more_link: "yes"
url: "/go-websocket-implementation-realtime-enterprise-scale/"
---

WebSocket connections are long-lived, stateful, and fundamentally different from HTTP request/response in how they interact with your infrastructure. A single Go process can handle tens of thousands of concurrent WebSocket connections efficiently, but getting from a working demo to a production deployment that handles reconnects, scales horizontally across multiple pods, implements proper backpressure, and shuts down gracefully requires careful engineering at every layer.

This guide provides a complete production WebSocket implementation in Go: library selection between gorilla/websocket and nhooyr.io/websocket, connection lifecycle management with heartbeating, the hub/spoke broadcast pattern for efficient multi-client messaging, TLS termination, horizontal scaling using Redis pub/sub to share messages across pod instances, and graceful shutdown that drains existing connections before terminating.

<!--more-->

# Go WebSocket Implementation: Real-Time Communication at Enterprise Scale

## Library Selection: gorilla/websocket vs nhooyr.io/websocket

Two mature WebSocket libraries dominate the Go ecosystem:

**gorilla/websocket** is the older, battle-tested library with the largest userbase. It provides low-level control over the WebSocket protocol, supports all standard features, and has known performance characteristics. The downside is its API is more verbose and it requires careful manual handling of concurrency (you must synchronize writes).

**nhooyr.io/websocket** is a newer library with a context-based API that is more idiomatic to modern Go. It handles concurrency correctly by default, integrates naturally with `context.Context` for cancellation, and uses a single goroutine model internally. The tradeoff is less community exposure and fewer advanced options.

For a new production implementation, either library works well. This guide uses gorilla/websocket for its wider adoption and detailed control, but the patterns apply equally to nhooyr.io/websocket.

```go
// go.mod dependencies
// github.com/gorilla/websocket v1.5.1
// github.com/redis/go-redis/v9
```

## Connection Lifecycle and the Client Type

### Core Connection Structure

```go
package ws

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

const (
    // Time allowed to write a message to the peer.
    writeWait = 10 * time.Second

    // Time allowed to read the next pong message from the peer.
    pongWait = 60 * time.Second

    // Send pings to peer with this period. Must be less than pongWait.
    pingPeriod = (pongWait * 9) / 10

    // Maximum message size allowed from peer (in bytes).
    maxMessageSize = 4096

    // Size of the client's send channel buffer.
    // If this channel fills up, the client is considered too slow and is disconnected.
    sendBufferSize = 256
)

// Message is the standard envelope for all WebSocket messages.
type Message struct {
    Type    string          `json:"type"`
    Payload json.RawMessage `json:"payload"`
}

// Client represents a WebSocket connection.
type Client struct {
    hub *Hub
    id  string

    // The WebSocket connection.
    conn *websocket.Conn

    // Buffered channel of outbound messages.
    send chan []byte

    // Subscriptions this client has registered.
    subscriptions map[string]struct{}
    subMu         sync.RWMutex

    // Context for this connection's lifetime.
    ctx    context.Context
    cancel context.CancelFunc

    // User identity extracted from the auth handshake.
    userID string

    // Metrics
    messagesReceived int64
    messagesSent     int64
    bytesReceived    int64
    bytesSent        int64
}

func NewClient(hub *Hub, conn *websocket.Conn, id, userID string) *Client {
    ctx, cancel := context.WithCancel(hub.ctx)
    return &Client{
        hub:           hub,
        id:            id,
        conn:          conn,
        send:          make(chan []byte, sendBufferSize),
        subscriptions: make(map[string]struct{}),
        ctx:           ctx,
        cancel:        cancel,
        userID:        userID,
    }
}
```

### Read Pump

The read pump runs in a dedicated goroutine and processes incoming messages:

```go
// ReadPump pumps messages from the WebSocket connection to the hub.
// It is run in a per-connection goroutine. The application ensures that
// there is at most one reader on a connection by running the goroutine.
func (c *Client) ReadPump() {
    defer func() {
        c.hub.unregister <- c
        c.conn.Close()
        c.cancel()
    }()

    c.conn.SetReadLimit(maxMessageSize)
    c.conn.SetReadDeadline(time.Now().Add(pongWait))

    // The pong handler resets the read deadline on each pong received.
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
            ) {
                slog.Error("websocket read error",
                    "client_id", c.id,
                    "user_id", c.userID,
                    "error", err)
            }
            return
        }

        c.bytesReceived += int64(len(rawMsg))
        c.messagesReceived++

        // Parse the message envelope
        var msg Message
        if err := json.Unmarshal(rawMsg, &msg); err != nil {
            slog.Warn("invalid message format",
                "client_id", c.id,
                "error", err)
            continue
        }

        // Route the message based on type
        if err := c.hub.handleClientMessage(c, &msg); err != nil {
            slog.Error("handling client message",
                "client_id", c.id,
                "type", msg.Type,
                "error", err)
        }
    }
}
```

### Write Pump

The write pump is the only goroutine that writes to the connection, which is required because gorilla/websocket connections do not support concurrent writes:

```go
// WritePump pumps messages from the hub to the WebSocket connection.
// A goroutine running WritePump is started for each connection.
// The application ensures that there is at most one writer to a connection
// by running this goroutine.
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
                // The hub closed the channel.
                c.conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }

            // Use NextWriter for efficient batched writes
            w, err := c.conn.NextWriter(websocket.TextMessage)
            if err != nil {
                return
            }
            w.Write(message)

            // Drain any additional queued messages into this write
            // This batches multiple messages into a single WebSocket frame
            n := len(c.send)
            for i := 0; i < n; i++ {
                w.Write([]byte{'\n'})
                w.Write(<-c.send)
            }

            if err := w.Close(); err != nil {
                return
            }

            c.bytesSent += int64(len(message))
            c.messagesSent++

        case <-ticker.C:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }

        case <-c.ctx.Done():
            // Graceful shutdown: send close message
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            c.conn.WriteMessage(websocket.CloseMessage,
                websocket.FormatCloseMessage(websocket.CloseNormalClosure, "server shutting down"))
            return
        }
    }
}
```

## The Hub: Connection Registry and Message Router

The hub is the central coordinator. It maintains the set of active clients and routes messages. The hub pattern serializes all mutations to the client map through a single select loop, eliminating the need for locks on the client map itself.

```go
package ws

import (
    "context"
    "encoding/json"
    "log/slog"
    "sync/atomic"
)

// Hub maintains the set of active clients and broadcasts messages.
type Hub struct {
    ctx    context.Context
    cancel context.CancelFunc

    // Registered clients
    clients map[string]*Client

    // Channel for inbound messages from clients
    inbound chan *inboundMessage

    // Register requests from clients
    register chan *Client

    // Unregister requests from clients
    unregister chan *Client

    // Broadcast to all clients
    broadcast chan []byte

    // Broadcast to a specific room/channel
    roomBroadcast chan *roomMessage

    // Handlers for client message types
    handlers map[string]MessageHandler

    // Metrics
    totalClients    int64
    peakClients     int64
    totalMessages   int64
}

type inboundMessage struct {
    client  *Client
    message *Message
}

type roomMessage struct {
    room    string
    payload []byte
}

// MessageHandler processes a specific message type from a client.
type MessageHandler func(ctx context.Context, client *Client, payload json.RawMessage) error

func NewHub(ctx context.Context) *Hub {
    ctx, cancel := context.WithCancel(ctx)
    return &Hub{
        ctx:           ctx,
        cancel:        cancel,
        clients:       make(map[string]*Client),
        inbound:       make(chan *inboundMessage, 1000),
        register:      make(chan *Client, 100),
        unregister:    make(chan *Client, 100),
        broadcast:     make(chan []byte, 1000),
        roomBroadcast: make(chan *roomMessage, 1000),
        handlers:      make(map[string]MessageHandler),
    }
}

// RegisterHandler registers a handler for a specific message type.
func (h *Hub) RegisterHandler(msgType string, handler MessageHandler) {
    h.handlers[msgType] = handler
}

// Run processes all hub events in a single goroutine.
// This serializes all client map mutations without locks.
func (h *Hub) Run() {
    for {
        select {
        case <-h.ctx.Done():
            // Shut down all clients
            for id, client := range h.clients {
                close(client.send)
                delete(h.clients, id)
            }
            return

        case client := <-h.register:
            h.clients[client.id] = client
            current := int64(len(h.clients))
            atomic.StoreInt64(&h.totalClients, current)
            if current > atomic.LoadInt64(&h.peakClients) {
                atomic.StoreInt64(&h.peakClients, current)
            }
            slog.Info("client registered",
                "client_id", client.id,
                "user_id", client.userID,
                "total_clients", current)

        case client := <-h.unregister:
            if _, ok := h.clients[client.id]; ok {
                delete(h.clients, client.id)
                close(client.send)
                atomic.StoreInt64(&h.totalClients, int64(len(h.clients)))
                slog.Info("client unregistered",
                    "client_id", client.id,
                    "user_id", client.userID,
                    "messages_received", client.messagesReceived,
                    "messages_sent", client.messagesSent)
            }

        case message := <-h.broadcast:
            // Broadcast to all connected clients
            for id, client := range h.clients {
                select {
                case client.send <- message:
                    atomic.AddInt64(&h.totalMessages, 1)
                default:
                    // Client send buffer is full — they are too slow
                    // Disconnect them to prevent the hub from blocking
                    slog.Warn("client send buffer full, disconnecting",
                        "client_id", id)
                    delete(h.clients, id)
                    close(client.send)
                }
            }

        case rm := <-h.roomBroadcast:
            // Broadcast to clients subscribed to a specific room
            for id, client := range h.clients {
                client.subMu.RLock()
                _, subscribed := client.subscriptions[rm.room]
                client.subMu.RUnlock()

                if !subscribed {
                    continue
                }

                select {
                case client.send <- rm.payload:
                    atomic.AddInt64(&h.totalMessages, 1)
                default:
                    slog.Warn("client send buffer full in room broadcast, disconnecting",
                        "client_id", id, "room", rm.room)
                    delete(h.clients, id)
                    close(client.send)
                }
            }

        case msg := <-h.inbound:
            atomic.AddInt64(&h.totalMessages, 1)
            handler, ok := h.handlers[msg.message.Type]
            if !ok {
                slog.Warn("unknown message type",
                    "type", msg.message.Type,
                    "client_id", msg.client.id)
                continue
            }
            // Handle in a goroutine to avoid blocking the hub
            go func(m *inboundMessage) {
                if err := handler(m.client.ctx, m.client, m.message.Payload); err != nil {
                    slog.Error("message handler error",
                        "type", m.message.Type,
                        "client_id", m.client.id,
                        "error", err)
                }
            }(msg)
        }
    }
}

func (h *Hub) handleClientMessage(client *Client, msg *Message) error {
    select {
    case h.inbound <- &inboundMessage{client: client, message: msg}:
        return nil
    default:
        return fmt.Errorf("inbound message buffer full")
    }
}

// SendToClient sends a message to a specific client by ID.
func (h *Hub) SendToClient(clientID string, msg []byte) error {
    // Note: this is called from outside the hub goroutine.
    // We cannot access h.clients directly. Use a dedicated channel.
    // For simplicity, we use a targeted broadcast with ID check.
    // For high-frequency per-client sends, maintain a concurrent map.
    return nil  // Implemented via a targetedSend channel in production
}

// BroadcastToRoom sends a message to all clients subscribed to a room.
func (h *Hub) BroadcastToRoom(room string, payload []byte) {
    select {
    case h.roomBroadcast <- &roomMessage{room: room, payload: payload}:
    default:
        slog.Warn("room broadcast channel full", "room", room)
    }
}
```

## HTTP Upgrade Handler

The HTTP handler upgrades connections and starts the client goroutines:

```go
package handler

import (
    "net/http"
    "strings"

    "github.com/gorilla/websocket"
    "github.com/google/uuid"
    "myservice/internal/ws"
    "myservice/internal/auth"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    // CheckOrigin validates the request origin.
    // In production, validate against an allowlist.
    CheckOrigin: func(r *http.Request) bool {
        origin := r.Header.Get("Origin")
        if origin == "" {
            return true  // Allow non-browser clients
        }
        // Validate against allowed origins
        allowedOrigins := []string{
            "https://app.example.com",
            "https://staging.example.com",
        }
        for _, allowed := range allowedOrigins {
            if strings.EqualFold(origin, allowed) {
                return true
            }
        }
        return false
    },
    // Set subprotocol for structured communication
    Subprotocols: []string{"json-v1"},
    // Enable compression for large messages
    EnableCompression: true,
}

type WSHandler struct {
    hub      *ws.Hub
    authSvc  auth.Service
}

func NewWSHandler(hub *ws.Hub, authSvc auth.Service) *WSHandler {
    return &WSHandler{hub: hub, authSvc: authSvc}
}

func (h *WSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Authenticate before upgrading
    token := r.URL.Query().Get("token")
    if token == "" {
        token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
    }

    userID, err := h.authSvc.ValidateToken(r.Context(), token)
    if err != nil {
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        return
    }

    // Upgrade the connection
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        // upgrader.Upgrade writes the error response automatically
        return
    }

    // Create and register the client
    clientID := uuid.New().String()
    client := ws.NewClient(h.hub, conn, clientID, userID)
    h.hub.Register(client)

    // Start goroutines for this connection
    go client.WritePump()
    go client.ReadPump()
}
```

## TLS Configuration

Never run WebSocket servers without TLS in production. Use `wss://` for all connections:

```go
package server

import (
    "context"
    "crypto/tls"
    "net/http"
    "time"
)

func NewServer(addr string, tlsCertFile, tlsKeyFile string, handler http.Handler) *http.Server {
    tlsConfig := &tls.Config{
        // Prefer TLS 1.3; support TLS 1.2 minimum
        MinVersion: tls.VersionTLS12,
        // Cipher suites ordered by performance and security
        CipherSuites: []uint16{
            tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
            tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
            tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        },
        // Prefer server cipher suites
        PreferServerCipherSuites: true,
        // Session tickets for connection resumption (reduces TLS overhead on reconnects)
        SessionTicketsDisabled: false,
    }

    return &http.Server{
        Addr:         addr,
        Handler:      handler,
        TLSConfig:    tlsConfig,
        ReadTimeout:  5 * time.Second,    // Time to read request headers
        WriteTimeout: 0,                   // No timeout for WebSocket connections
        IdleTimeout:  120 * time.Second,
    }
}

func (s *Server) ListenAndServeTLS(ctx context.Context, certFile, keyFile string) error {
    go func() {
        <-ctx.Done()
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        s.httpServer.Shutdown(shutdownCtx)
    }()
    return s.httpServer.ListenAndServeTLS(certFile, keyFile)
}
```

## Horizontal Scaling with Redis Pub/Sub

When running multiple WebSocket server pods, messages sent to one pod must be forwarded to all other pods so their connected clients receive them. Redis pub/sub is the standard solution:

```go
package pubsub

import (
    "context"
    "encoding/json"
    "log/slog"

    "github.com/redis/go-redis/v9"
    "myservice/internal/ws"
)

const (
    // Channel prefix for room broadcasts
    roomChannelPrefix = "ws:room:"
    // Global broadcast channel
    globalChannel = "ws:global"
)

// RedisRelay bridges Redis pub/sub to the local Hub.
// All pod instances subscribe to Redis; when any pod publishes,
// all pods receive the message and deliver it to their local clients.
type RedisRelay struct {
    hub    *ws.Hub
    client *redis.Client
}

func NewRedisRelay(hub *ws.Hub, client *redis.Client) *RedisRelay {
    return &RedisRelay{hub: hub, client: client}
}

// Subscribe starts listening for messages from Redis and delivering
// them to local clients.
func (r *RedisRelay) Subscribe(ctx context.Context) error {
    pubsub := r.client.PSubscribe(ctx,
        globalChannel,
        roomChannelPrefix+"*",  // Pattern subscribe to all room channels
    )
    defer pubsub.Close()

    ch := pubsub.Channel()
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case msg, ok := <-ch:
            if !ok {
                return nil
            }
            r.handleRedisMessage(msg)
        }
    }
}

func (r *RedisRelay) handleRedisMessage(msg *redis.Message) {
    if msg.Channel == globalChannel {
        // Broadcast to all local clients
        // Avoid re-publishing to Redis (would cause infinite loop)
        r.hub.BroadcastLocal([]byte(msg.Payload))
        return
    }

    // Extract room name from channel
    if len(msg.Channel) > len(roomChannelPrefix) {
        room := msg.Channel[len(roomChannelPrefix):]
        r.hub.BroadcastToRoomLocal(room, []byte(msg.Payload))
    }
}

// PublishGlobal publishes a message to all clients across all pods.
func (r *RedisRelay) PublishGlobal(ctx context.Context, payload []byte) error {
    return r.client.Publish(ctx, globalChannel, payload).Err()
}

// PublishToRoom publishes a message to all clients in a room across all pods.
func (r *RedisRelay) PublishToRoom(ctx context.Context, room string, payload []byte) error {
    channel := roomChannelPrefix + room
    return r.client.Publish(ctx, channel, payload).Err()
}

// BroadcastEnvelope publishes a typed message envelope.
func (r *RedisRelay) BroadcastEnvelope(ctx context.Context, room string, msgType string, payload interface{}) error {
    rawPayload, err := json.Marshal(payload)
    if err != nil {
        return fmt.Errorf("marshaling payload: %w", err)
    }

    envelope, err := json.Marshal(ws.Message{
        Type:    msgType,
        Payload: rawPayload,
    })
    if err != nil {
        return fmt.Errorf("marshaling envelope: %w", err)
    }

    if room == "" {
        return r.PublishGlobal(ctx, envelope)
    }
    return r.PublishToRoom(ctx, room, envelope)
}
```

### Redis Connection for High-Throughput Pub/Sub

Pub/sub connections must be separate from command connections:

```go
func NewRedisClients(addr, password string) (cmd *redis.Client, pubsub *redis.Client) {
    opts := &redis.Options{
        Addr:     addr,
        Password: password,
        // Pub/sub uses persistent connections — different pool settings
        PoolSize:     5,
        MinIdleConns: 2,
    }

    // Command client for general Redis operations
    cmd = redis.NewClient(opts)

    // Dedicated client for pub/sub — subscription blocks the connection
    pubsub = redis.NewClient(opts)

    return cmd, pubsub
}
```

## Graceful Shutdown

WebSocket connections are long-lived. Kubernetes terminates pods with SIGTERM followed by SIGKILL after the grace period. The shutdown sequence must:
1. Stop accepting new connections
2. Notify existing clients that the server is shutting down
3. Wait for existing clients to disconnect (or force-close after timeout)

```go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    // ... setup hub, handlers, server ...

    // Create context that cancels on SIGTERM/SIGINT
    ctx, stop := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    // Start serving
    serverErr := make(chan error, 1)
    go func() {
        slog.Info("starting WebSocket server", "addr", ":8443")
        serverErr <- server.ListenAndServeTLS(certFile, keyFile)
    }()

    // Start Redis relay
    go relay.Subscribe(ctx)

    // Start hub
    go hub.Run()

    // Wait for shutdown signal or server error
    select {
    case err := <-serverErr:
        slog.Error("server error", "error", err)
    case <-ctx.Done():
        slog.Info("shutdown signal received")
    }

    // Graceful shutdown sequence
    slog.Info("initiating graceful shutdown")

    // 1. Stop accepting new connections (close the listener)
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
    defer cancel()

    // 2. Notify the HTTP server to stop (no more upgrades)
    if err := server.Shutdown(shutdownCtx); err != nil {
        slog.Error("HTTP server shutdown error", "error", err)
    }

    // 3. Stop the hub (sends close messages to all clients)
    hub.Shutdown()

    // 4. Wait for all client goroutines to finish
    // (tracked by a WaitGroup in the hub)
    done := make(chan struct{})
    go func() {
        hub.WaitForClients()
        close(done)
    }()

    select {
    case <-done:
        slog.Info("all clients disconnected, shutdown complete")
    case <-shutdownCtx.Done():
        slog.Warn("shutdown timeout: some clients did not disconnect cleanly")
    }
}
```

### Hub Shutdown with WaitGroup

```go
// Add to Hub struct:
//   clientWg sync.WaitGroup

func (h *Hub) Register(client *Client) {
    h.clientWg.Add(1)
    h.register <- client
}

// Modify the unregister case in Run():
case client := <-h.unregister:
    if _, ok := h.clients[client.id]; ok {
        delete(h.clients, client.id)
        close(client.send)
        h.clientWg.Done()
    }

func (h *Hub) Shutdown() {
    h.cancel()
}

func (h *Hub) WaitForClients() {
    h.clientWg.Wait()
}
```

## Connection Metadata and Room Subscription Handlers

Register handlers for subscription management:

```go
func SetupHandlers(hub *ws.Hub) {
    // Subscribe to a room
    hub.RegisterHandler("subscribe", func(ctx context.Context, client *ws.Client, payload json.RawMessage) error {
        var req struct {
            Room string `json:"room"`
        }
        if err := json.Unmarshal(payload, &req); err != nil {
            return err
        }
        if req.Room == "" {
            return fmt.Errorf("room is required")
        }

        client.Subscribe(req.Room)
        slog.Info("client subscribed to room",
            "client_id", client.ID(),
            "room", req.Room)

        // Confirm subscription
        resp, _ := json.Marshal(ws.Message{
            Type:    "subscribed",
            Payload: payload,
        })
        client.Send(resp)
        return nil
    })

    // Unsubscribe from a room
    hub.RegisterHandler("unsubscribe", func(ctx context.Context, client *ws.Client, payload json.RawMessage) error {
        var req struct {
            Room string `json:"room"`
        }
        if err := json.Unmarshal(payload, &req); err != nil {
            return err
        }
        client.Unsubscribe(req.Room)
        return nil
    })

    // Ping handler (application-level, separate from WebSocket ping/pong)
    hub.RegisterHandler("ping", func(ctx context.Context, client *ws.Client, payload json.RawMessage) error {
        pong, _ := json.Marshal(ws.Message{Type: "pong"})
        client.Send(pong)
        return nil
    })
}
```

## Monitoring WebSocket Connections

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    activeConnections = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "websocket_active_connections",
        Help: "Number of active WebSocket connections.",
    })

    connectionDuration = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "websocket_connection_duration_seconds",
        Help:    "Duration of WebSocket connections.",
        Buckets: []float64{1, 5, 30, 60, 300, 900, 3600, 86400},
    })

    messagesSent = promauto.NewCounter(prometheus.CounterOpts{
        Name: "websocket_messages_sent_total",
        Help: "Total WebSocket messages sent to clients.",
    })

    messagesReceived = promauto.NewCounter(prometheus.CounterOpts{
        Name: "websocket_messages_received_total",
        Help: "Total WebSocket messages received from clients.",
    })

    slowClientsDisconnected = promauto.NewCounter(prometheus.CounterOpts{
        Name: "websocket_slow_clients_disconnected_total",
        Help: "Clients disconnected due to full send buffer.",
    })
)
```

## Load Testing WebSocket Servers

```go
// cmd/ws-loadtest/main.go
// Simple WebSocket load test tool
package main

import (
    "context"
    "flag"
    "fmt"
    "log"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

func main() {
    addr := flag.String("addr", "wss://localhost:8443/ws", "WebSocket server address")
    connections := flag.Int("connections", 1000, "Number of concurrent connections")
    duration := flag.Duration("duration", 60*time.Second, "Test duration")
    flag.Parse()

    ctx, cancel := context.WithTimeout(context.Background(), *duration)
    defer cancel()

    var wg sync.WaitGroup
    var successCount, failCount int64

    sem := make(chan struct{}, *connections)

    start := time.Now()
    for i := 0; i < *connections; i++ {
        sem <- struct{}{}
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            defer func() { <-sem }()

            conn, _, err := websocket.DefaultDialer.DialContext(ctx, *addr, nil)
            if err != nil {
                atomic.AddInt64(&failCount, 1)
                return
            }
            defer conn.Close()
            atomic.AddInt64(&successCount, 1)

            // Keep connection alive
            for {
                select {
                case <-ctx.Done():
                    return
                case <-time.After(30 * time.Second):
                    if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                        return
                    }
                }
            }
        }(i)
    }

    wg.Wait()
    elapsed := time.Since(start)
    fmt.Printf("Results after %v:\n", elapsed)
    fmt.Printf("  Successful connections: %d\n", atomic.LoadInt64(&successCount))
    fmt.Printf("  Failed connections: %d\n", atomic.LoadInt64(&failCount))
}
```

## Summary

A production-grade Go WebSocket implementation requires careful attention at every layer: the goroutine-per-connection model with separate read and write pumps, a hub that serializes all client map mutations, backpressure via bounded send buffers with forced disconnection of slow clients, heartbeat-based liveness detection, and Redis pub/sub for cross-pod message delivery in multi-replica deployments. Graceful shutdown with a WaitGroup ensures in-flight connections receive close messages before the pod terminates, satisfying Kubernetes graceful termination semantics. These patterns together support tens of thousands of concurrent connections per pod while maintaining the reliability and operational predictability that enterprise real-time applications require.
