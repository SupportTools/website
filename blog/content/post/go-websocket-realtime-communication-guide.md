---
title: "WebSockets in Go: Real-Time Communication with gorilla/websocket"
date: 2028-10-25T00:00:00-05:00
draft: false
tags: ["Go", "WebSocket", "Real-Time", "Networking", "API"]
categories:
- Go
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to WebSocket servers in Go using gorilla/websocket including connection hubs, JWT authentication, load balancing with sticky sessions, Redis pub/sub for horizontal scaling, and Kubernetes ingress configuration."
more_link: "yes"
url: "/go-websocket-realtime-communication-guide/"
---

WebSockets enable full-duplex communication over a single TCP connection — essential for real-time dashboards, chat systems, live notifications, and collaborative applications. Go's goroutine model makes it exceptionally well-suited for managing thousands of concurrent WebSocket connections. This guide covers the full production stack: upgrading HTTP connections, the hub-client broadcast pattern, JWT authentication, Redis pub/sub for multi-pod scaling, and Kubernetes ingress configuration.

<!--more-->

# WebSockets in Go: Production Implementation Guide

## Project Setup

```bash
mkdir ws-server && cd ws-server
go mod init github.com/example/ws-server
go get github.com/gorilla/websocket@v1.5.3
go get github.com/golang-jwt/jwt/v5@v5.2.1
go get github.com/redis/go-redis/v9@v9.6.1
```

## Basic WebSocket Upgrade

The gorilla/websocket `Upgrader` converts an HTTP/1.1 connection to a WebSocket connection.

```go
package main

import (
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// CheckOrigin prevents cross-origin WebSocket connections.
	// In production, validate against an allowlist.
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		allowed := map[string]bool{
			"https://app.example.com":   true,
			"https://admin.example.com": true,
		}
		return allowed[origin]
	},
	// Subprotocol negotiation
	Subprotocols: []string{"chat", "notifications"},
	// Compression (use sparingly — high CPU for small messages)
	EnableCompression: false,
	HandshakeTimeout:  10 * time.Second,
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Set read deadline — disconnect idle clients
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("unexpected close: %v", err)
			}
			break
		}
		log.Printf("received: type=%d len=%d", messageType, len(message))

		// Echo back
		if err := conn.WriteMessage(messageType, message); err != nil {
			log.Printf("write error: %v", err)
			break
		}
	}
}

func main() {
	http.HandleFunc("/ws", wsHandler)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
```

## Message Protocol Design

Use a typed JSON envelope for all messages. This makes client-side routing deterministic and enables versioning.

```go
package protocol

import "encoding/json"

// MessageType identifies the type of message.
type MessageType string

const (
	TypePing          MessageType = "ping"
	TypePong          MessageType = "pong"
	TypeChatMessage   MessageType = "chat.message"
	TypeUserJoined    MessageType = "user.joined"
	TypeUserLeft      MessageType = "user.left"
	TypeError         MessageType = "error"
	TypeNotification  MessageType = "notification"
	TypeSubscribe     MessageType = "subscribe"
	TypeUnsubscribe   MessageType = "unsubscribe"
)

// Envelope wraps every WebSocket message.
type Envelope struct {
	Type      MessageType     `json:"type"`
	ID        string          `json:"id,omitempty"`   // Client-generated correlation ID
	Timestamp int64           `json:"ts"`             // Unix milliseconds
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// ChatMessage is the payload for TypeChatMessage.
type ChatMessage struct {
	RoomID  string `json:"room_id"`
	Text    string `json:"text"`
	UserID  string `json:"user_id"`
	Display string `json:"display_name"`
}

// ErrorPayload is the payload for TypeError.
type ErrorPayload struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// NewEnvelope creates a typed envelope.
func NewEnvelope(msgType MessageType, payload interface{}) (*Envelope, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return &Envelope{
		Type:      msgType,
		Timestamp: time.Now().UnixMilli(),
		Payload:   raw,
	}, nil
}
```

## Connection Hub Pattern

The hub is a goroutine-safe registry of connected clients. All broadcast and unicast operations go through the hub's channel-based interface, avoiding mutex contention.

```go
package hub

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	maxMessage = 512 * 1024 // 512 KB
)

// Client represents a single WebSocket connection.
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	send   chan []byte
	UserID string
	Rooms  map[string]bool
	mu     sync.Mutex
}

// Hub maintains the set of active clients and broadcasts messages.
type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	unicast    chan unicastMsg
	register   chan *Client
	unregister chan *Client
	rooms      map[string]map[*Client]bool
	mu         sync.RWMutex
}

type unicastMsg struct {
	client  *Client
	message []byte
}

func NewHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte, 256),
		unicast:    make(chan unicastMsg, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		rooms:      make(map[string]map[*Client]bool),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.clients[client] = true
			log.Printf("hub: client registered userID=%s total=%d", client.UserID, len(h.clients))

		case client := <-h.unregister:
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
				// Remove from all rooms
				for room := range client.Rooms {
					h.leaveRoom(client, room)
				}
				log.Printf("hub: client unregistered userID=%s total=%d", client.UserID, len(h.clients))
			}

		case message := <-h.broadcast:
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					// Client's send buffer is full — disconnect
					close(client.send)
					delete(h.clients, client)
				}
			}

		case msg := <-h.unicast:
			select {
			case msg.client.send <- msg.message:
			default:
				close(msg.client.send)
				delete(h.clients, msg.client)
			}
		}
	}
}

func (h *Hub) Broadcast(message []byte) {
	h.broadcast <- message
}

func (h *Hub) BroadcastToRoom(roomID string, message []byte) {
	h.mu.RLock()
	room := h.rooms[roomID]
	h.mu.RUnlock()
	for client := range room {
		select {
		case client.send <- message:
		default:
			// Drop slow client
		}
	}
}

func (h *Hub) Unicast(client *Client, message []byte) {
	h.unicast <- unicastMsg{client: client, message: message}
}

func (h *Hub) JoinRoom(client *Client, roomID string) {
	h.mu.Lock()
	if h.rooms[roomID] == nil {
		h.rooms[roomID] = make(map[*Client]bool)
	}
	h.rooms[roomID][client] = true
	h.mu.Unlock()

	client.mu.Lock()
	client.Rooms[roomID] = true
	client.mu.Unlock()
}

func (h *Hub) leaveRoom(client *Client, roomID string) {
	h.mu.Lock()
	if room, ok := h.rooms[roomID]; ok {
		delete(room, client)
		if len(room) == 0 {
			delete(h.rooms, roomID)
		}
	}
	h.mu.Unlock()
}

// ServeWS upgrades the HTTP connection and registers the client with the hub.
func (h *Hub) ServeWS(conn *websocket.Conn, userID string) {
	client := &Client{
		hub:    h,
		conn:   conn,
		send:   make(chan []byte, 256),
		UserID: userID,
		Rooms:  make(map[string]bool),
	}

	h.register <- client

	go client.writePump()
	client.readPump()
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessage)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("readPump error userID=%s: %v", c.UserID, err)
			}
			return
		}

		var env protocol.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			log.Printf("readPump parse error: %v", err)
			continue
		}

		c.hub.handleMessage(c, &env)
	}
}

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

			// Flush any queued messages into the same write
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

## JWT Authentication During Handshake

Authentication must happen during the HTTP upgrade, before the WebSocket connection is established.

```go
package auth

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var jwtSecret = []byte(os.Getenv("JWT_SECRET"))

type Claims struct {
	UserID      string   `json:"sub"`
	DisplayName string   `json:"name"`
	Roles       []string `json:"roles"`
	jwt.RegisteredClaims
}

// ExtractToken gets the JWT from Authorization header or query parameter.
// WebSocket clients often can't set headers, so query param fallback is common.
func ExtractToken(r *http.Request) (string, error) {
	// Header: Authorization: Bearer <token>
	if auth := r.Header.Get("Authorization"); auth != "" {
		parts := strings.SplitN(auth, " ", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
			return parts[1], nil
		}
	}
	// Query parameter: ?token=<token>
	if token := r.URL.Query().Get("token"); token != "" {
		return token, nil
	}
	// Cookie
	if cookie, err := r.Cookie("auth_token"); err == nil {
		return cookie.Value, nil
	}
	return "", errors.New("no token provided")
}

// ParseToken validates the JWT and returns claims.
func ParseToken(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token claims")
	}
	if claims.ExpiresAt != nil && claims.ExpiresAt.Before(time.Now()) {
		return nil, errors.New("token expired")
	}
	return claims, nil
}
```

WebSocket handler with JWT authentication:

```go
func wsHandler(hub *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Authenticate before upgrading
		tokenStr, err := auth.ExtractToken(r)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		claims, err := auth.ParseToken(tokenStr)
		if err != nil {
			http.Error(w, "invalid token: "+err.Error(), http.StatusUnauthorized)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("upgrade error: %v", err)
			return
		}

		// Hub takes ownership of the connection
		hub.ServeWS(conn, claims.UserID)
	}
}
```

## Scaling with Redis Pub/Sub

A single hub works for one process. For horizontal scaling across multiple pods, Redis pub/sub fans messages out to all instances.

```go
package pubsub

import (
	"context"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
)

const channelPrefix = "ws:"

// RedisBroker bridges Redis pub/sub and the local hub.
type RedisBroker struct {
	client *redis.Client
	hub    *hub.Hub
}

func NewRedisBroker(client *redis.Client, hub *hub.Hub) *RedisBroker {
	return &RedisBroker{client: client, hub: hub}
}

// Subscribe starts consuming messages from a Redis channel and forwarding
// them to the local hub.
func (b *RedisBroker) Subscribe(ctx context.Context, channels ...string) {
	prefixed := make([]string, len(channels))
	for i, ch := range channels {
		prefixed[i] = channelPrefix + ch
	}

	sub := b.client.Subscribe(ctx, prefixed...)
	ch := sub.Channel()

	go func() {
		defer sub.Close()
		for {
			select {
			case msg, ok := <-ch:
				if !ok {
					return
				}
				// Determine target: broadcast or room-specific
				var env BrokerEnvelope
				if err := json.Unmarshal([]byte(msg.Payload), &env); err != nil {
					log.Printf("pubsub: parse error: %v", err)
					continue
				}
				payload, _ := json.Marshal(env.Message)
				if env.RoomID != "" {
					b.hub.BroadcastToRoom(env.RoomID, payload)
				} else {
					b.hub.Broadcast(payload)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}

// Publish sends a message to all instances via Redis.
func (b *RedisBroker) Publish(ctx context.Context, channel string, roomID string, message interface{}) error {
	env := BrokerEnvelope{
		RoomID:  roomID,
		Message: message,
	}
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return b.client.Publish(ctx, channelPrefix+channel, data).Err()
}

type BrokerEnvelope struct {
	RoomID  string      `json:"room_id,omitempty"`
	Message interface{} `json:"message"`
}
```

## Load Balancing with Sticky Sessions

WebSocket connections are stateful. A load balancer must route all requests from the same client to the same backend pod (sticky sessions). Without stickiness, the upgrade request and subsequent frames may hit different pods, breaking the connection.

### nginx-ingress WebSocket configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ws-server
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/upstream-hash-by: "$http_x_forwarded_for"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_http_version 1.1;
      proxy_buffering off;
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - ws.example.com
    secretName: ws-tls
  rules:
  - host: ws.example.com
    http:
      paths:
      - path: /ws
        pathType: Prefix
        backend:
          service:
            name: ws-server
            port:
              number: 8080
```

### Kubernetes Service with sessionAffinity

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ws-server
  namespace: production
spec:
  selector:
    app: ws-server
  ports:
  - port: 8080
    targetPort: 8080
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800  # 3 hours — matches max WebSocket session length
```

### Kubernetes Deployment for WebSocket server

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ws-server
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: ws-server
  template:
    metadata:
      labels:
        app: ws-server
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      terminationGracePeriodSeconds: 60
      containers:
      - name: ws-server
        image: registry.example.com/ws-server:latest
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: metrics
        env:
        - name: REDIS_ADDR
          value: "redis-cluster:6379"
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: ws-secrets
              key: jwt_secret
        resources:
          requests:
            cpu: 200m
            memory: 128Mi
          limits:
            cpu: 1000m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
        lifecycle:
          preStop:
            exec:
              # Allow existing connections to drain before shutdown
              command: ["sleep", "30"]
```

## Graceful Connection Cleanup on Shutdown

When a pod receives SIGTERM, connections must be cleanly closed with a WebSocket close frame.

```go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	h := hub.NewHub()
	go h.Run()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler(h))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:    ":8080",
		Handler: mux,
	}

	// Start server in background
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	log.Println("server started on :8080")

	// Wait for signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	log.Println("shutdown signal received")

	// Stop accepting new connections immediately
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Send close frames to all connected clients
	h.CloseAll(websocket.CloseGoingAway, "server shutting down")

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("server stopped")
}
```

## Prometheus Metrics

```go
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	ActiveConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "ws_active_connections",
		Help: "Number of active WebSocket connections.",
	})

	MessagesReceived = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_messages_received_total",
		Help: "Total messages received by type.",
	}, []string{"type"})

	MessagesSent = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_messages_sent_total",
		Help: "Total messages sent by type.",
	}, []string{"type"})

	ConnectionDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "ws_connection_duration_seconds",
		Help:    "Duration of WebSocket connections.",
		Buckets: []float64{1, 5, 30, 60, 300, 600, 1800, 3600},
	})

	BroadcastQueueDepth = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "ws_broadcast_queue_depth",
		Help: "Current depth of the broadcast channel.",
	})
)
```

## Testing WebSocket Handlers

```go
package ws_test

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestEchoHandler(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(echoHandler))
	defer srv.Close()

	// Convert http:// to ws://
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	tests := []string{"hello", "world", `{"type":"chat.message"}`}
	for _, msg := range tests {
		if err := conn.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
			t.Fatalf("write: %v", err)
		}
		_, reply, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if string(reply) != msg {
			t.Errorf("expected %q got %q", msg, reply)
		}
	}
}

func TestBroadcast(t *testing.T) {
	h := hub.NewHub()
	go h.Run()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.ServeWS(conn, "test-user")
	}))
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	// Connect two clients
	c1, _, _ := websocket.DefaultDialer.Dial(url, nil)
	c2, _, _ := websocket.DefaultDialer.Dial(url, nil)
	defer c1.Close()
	defer c2.Close()

	time.Sleep(50 * time.Millisecond) // Allow goroutines to start

	// Broadcast from the hub
	msg := []byte(`{"type":"test","payload":"hello"}`)
	h.Broadcast(msg)

	// Both clients should receive the message
	for _, c := range []*websocket.Conn{c1, c2} {
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, received, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if string(received) != string(msg) {
			t.Errorf("unexpected message: %s", received)
		}
	}
}
```

## Summary

Building production WebSocket services in Go requires:

- Use `gorilla/websocket` `Upgrader` with explicit `CheckOrigin` to prevent unauthorized cross-origin upgrades.
- Implement the hub pattern with buffered channels to decouple connection goroutines and avoid blocking.
- Authenticate during the HTTP upgrade phase using JWT from `Authorization` header or `?token=` query parameter.
- Run multiple read and write goroutines per connection — one to receive, one to send with ping/pong keepalives.
- For multi-pod deployments, use Redis pub/sub as the message fan-out layer so broadcasts reach all connected clients.
- Configure nginx-ingress with `upstream-hash-by` for sticky sessions, and set `proxy-read-timeout` to a value longer than your longest expected connection duration.
- Export active connections, message rates, and connection durations as Prometheus metrics for capacity planning.
