---
title: "Go WebSocket Server: Gorilla WebSocket, Hub Pattern, and Horizontal Scaling"
date: 2029-12-16T00:00:00-05:00
draft: false
tags: ["Go", "WebSocket", "Gorilla", "Redis", "Pub/Sub", "Concurrency", "Horizontal Scaling", "Real-Time"]
categories:
- Go
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to gorilla/websocket in Go covering concurrent hub design, Redis pub/sub for horizontal scaling, client reconnect logic, binary protocols, and production hardening patterns."
more_link: "yes"
url: "/go-websocket-gorilla-hub-pattern-horizontal-scaling/"
---

WebSocket connections are stateful and long-lived, which makes them fundamentally different from the request-response model most Go services are built on. A naive single-server WebSocket implementation works fine for prototypes, but the moment you add a second pod behind a load balancer, clients connected to different instances can no longer exchange messages. This guide builds a production-ready WebSocket server in Go using gorilla/websocket, an efficient concurrent hub, Redis pub/sub for cross-instance messaging, and client-side reconnect logic.

<!--more-->

## The Gorilla WebSocket Upgrade

The `github.com/gorilla/websocket` package is the de-facto standard for WebSocket in Go. The HTTP upgrade is straightforward, but the upgrader configuration matters at production scale:

```go
// internal/ws/upgrader.go
package ws

import (
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

var Upgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	ReadBufferSize:   4096,
	WriteBufferSize:  4096,
	// Origin check — restrict to your domain in production
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		switch origin {
		case "https://app.example.com", "https://www.example.com":
			return true
		}
		return false
	},
	// Enable compression
	EnableCompression: true,
	Subprotocols:      []string{"chat.v1"},
}
```

### Connection Handler

```go
// internal/ws/handler.go
package ws

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 65536
)

type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	send     chan []byte
	userID   string
	roomID   string
	metadata map[string]string
}

func ServeWS(hub *Hub, w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("X-User-ID")
	roomID := r.URL.Query().Get("room")

	if userID == "" || roomID == "" {
		http.Error(w, "missing user_id or room parameter", http.StatusBadRequest)
		return
	}

	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("websocket upgrade failed", "err", err)
		return
	}

	client := &Client{
		hub:    hub,
		conn:   conn,
		send:   make(chan []byte, 256),
		userID: userID,
		roomID: roomID,
	}

	hub.register <- client

	go client.writePump()
	go client.readPump()
}

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
		messageType, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway,
				websocket.CloseAbnormalClosure,
			) {
				slog.Error("websocket read error", "user", c.userID, "err", err)
			}
			break
		}

		if messageType == websocket.BinaryMessage {
			c.hub.handleBinary(c, message)
			continue
		}

		msg := &Message{
			RoomID:  c.roomID,
			UserID:  c.userID,
			Payload: message,
			Type:    MessageTypeText,
		}
		c.hub.broadcast <- msg
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
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Drain buffered messages into the same WebSocket frame (batch writes)
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

## The Concurrent Hub

The hub is the single goroutine that owns the client registry. All mutations go through channels, eliminating the need for a mutex on the client map itself:

```go
// internal/ws/hub.go
package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"
)

type MessageType string

const (
	MessageTypeText   MessageType = "text"
	MessageTypeSystem MessageType = "system"
	MessageTypeBinary MessageType = "binary"
)

type Message struct {
	RoomID    string          `json:"room_id"`
	UserID    string          `json:"user_id"`
	Payload   json.RawMessage `json:"payload"`
	Type      MessageType     `json:"type"`
	Timestamp time.Time       `json:"timestamp"`
}

// rooms maps roomID -> set of clients
type rooms map[string]map[*Client]bool

type Hub struct {
	// Registered clients organized by room
	rooms rooms

	// Inbound messages from clients
	broadcast chan *Message

	// Register requests from clients
	register chan *Client

	// Unregister requests from clients
	unregister chan *Client

	// Redis pub/sub for cross-instance messaging
	pubsub PubSubBackend

	// Metrics
	metrics *HubMetrics

	mu sync.RWMutex
}

func NewHub(pubsub PubSubBackend) *Hub {
	return &Hub{
		rooms:      make(rooms),
		broadcast:  make(chan *Message, 1024),
		register:   make(chan *Client, 64),
		unregister: make(chan *Client, 64),
		pubsub:     pubsub,
		metrics:    newHubMetrics(),
	}
}

func (h *Hub) Run(ctx context.Context) {
	// Subscribe to inbound messages from other instances via Redis
	inbound := h.pubsub.Subscribe(ctx)

	for {
		select {
		case <-ctx.Done():
			return

		case client := <-h.register:
			h.mu.Lock()
			if _, ok := h.rooms[client.roomID]; !ok {
				h.rooms[client.roomID] = make(map[*Client]bool)
			}
			h.rooms[client.roomID][client] = true
			h.mu.Unlock()
			h.metrics.clientsConnected.Inc()
			slog.Info("client registered", "user", client.userID, "room", client.roomID)

		case client := <-h.unregister:
			h.mu.Lock()
			if room, ok := h.rooms[client.roomID]; ok {
				if _, ok := room[client]; ok {
					delete(room, client)
					close(client.send)
					if len(room) == 0 {
						delete(h.rooms, client.roomID)
					}
				}
			}
			h.mu.Unlock()
			h.metrics.clientsConnected.Dec()
			slog.Info("client unregistered", "user", client.userID, "room", client.roomID)

		case msg := <-h.broadcast:
			// Fan out to local clients in the room
			h.broadcastToRoom(msg)
			// Publish to Redis so other instances deliver to their local clients
			if err := h.pubsub.Publish(ctx, msg); err != nil {
				slog.Error("redis publish failed", "room", msg.RoomID, "err", err)
			}

		case msg := <-inbound:
			// Message from another instance — deliver locally only
			h.broadcastToRoom(msg)
		}
	}
}

func (h *Hub) broadcastToRoom(msg *Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("marshal message failed", "err", err)
		return
	}

	h.mu.RLock()
	room, ok := h.rooms[msg.RoomID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	// Copy the client set to avoid holding the lock during sends
	clients := make([]*Client, 0, len(room))
	for c := range room {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		select {
		case c.send <- data:
			h.metrics.messagesSent.Inc()
		default:
			// Client's send buffer full — disconnect it
			h.mu.Lock()
			if room, ok := h.rooms[c.roomID]; ok {
				delete(room, c)
				close(c.send)
			}
			h.mu.Unlock()
			h.metrics.droppedMessages.Inc()
		}
	}
}

func (h *Hub) handleBinary(c *Client, data []byte) {
	// Decode binary protocol frame and dispatch
	frame, err := DecodeBinaryFrame(data)
	if err != nil {
		slog.Error("invalid binary frame", "user", c.userID, "err", err)
		return
	}
	msg := &Message{
		RoomID:    c.roomID,
		UserID:    c.userID,
		Payload:   frame.Payload,
		Type:      MessageTypeBinary,
		Timestamp: time.Now(),
	}
	h.broadcast <- msg
}
```

## Redis Pub/Sub Backend

The pub/sub backend abstracts the Redis interaction so it can be swapped for NATS or any other broker in tests:

```go
// internal/ws/pubsub.go
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/redis/go-redis/v9"
)

const redisChannel = "ws:broadcast"

// PubSubBackend is the interface the hub depends on.
type PubSubBackend interface {
	Publish(ctx context.Context, msg *Message) error
	Subscribe(ctx context.Context) <-chan *Message
}

type RedisPubSub struct {
	client     *redis.Client
	instanceID string // unique per pod, used to skip echo
}

func NewRedisPubSub(addr, password string, db int, instanceID string) *RedisPubSub {
	rdb := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,
	})
	return &RedisPubSub{client: rdb, instanceID: instanceID}
}

type envelope struct {
	InstanceID string   `json:"instance_id"`
	Msg        *Message `json:"msg"`
}

func (r *RedisPubSub) Publish(ctx context.Context, msg *Message) error {
	env := envelope{InstanceID: r.instanceID, Msg: msg}
	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("marshal envelope: %w", err)
	}
	return r.client.Publish(ctx, redisChannel, data).Err()
}

func (r *RedisPubSub) Subscribe(ctx context.Context) <-chan *Message {
	ch := make(chan *Message, 512)

	go func() {
		defer close(ch)

		sub := r.client.Subscribe(ctx, redisChannel)
		defer sub.Close()

		msgs := sub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case redisMsg, ok := <-msgs:
				if !ok {
					slog.Error("redis subscription channel closed")
					return
				}
				var env envelope
				if err := json.Unmarshal([]byte(redisMsg.Payload), &env); err != nil {
					slog.Error("unmarshal envelope failed", "err", err)
					continue
				}
				// Skip messages published by this instance (already delivered locally)
				if env.InstanceID == r.instanceID {
					continue
				}
				ch <- env.Msg
			}
		}
	}()

	return ch
}
```

## Binary Protocol with Custom Framing

For high-frequency data (game state, financial ticks, telemetry), a compact binary frame is more efficient than JSON:

```go
// internal/ws/binary.go
package ws

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
)

// BinaryFrame wire format:
// [1 byte version][1 byte msg_type][2 bytes payload_len][N bytes payload]
const binaryFrameVersion = 0x01

type FrameType uint8

const (
	FrameTypeMessage  FrameType = 0x01
	FrameTypePresence FrameType = 0x02
	FrameTypeAck      FrameType = 0x03
)

type BinaryFrame struct {
	Version   uint8
	FrameType FrameType
	Payload   json.RawMessage
}

func EncodeBinaryFrame(ft FrameType, payload interface{}) ([]byte, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}

	if len(payloadBytes) > 65535 {
		return nil, fmt.Errorf("payload exceeds max frame size: %d bytes", len(payloadBytes))
	}

	buf := new(bytes.Buffer)
	buf.WriteByte(binaryFrameVersion)
	buf.WriteByte(byte(ft))
	payloadLen := uint16(len(payloadBytes))
	binary.Write(buf, binary.BigEndian, payloadLen)
	buf.Write(payloadBytes)

	return buf.Bytes(), nil
}

func DecodeBinaryFrame(data []byte) (*BinaryFrame, error) {
	if len(data) < 4 {
		return nil, fmt.Errorf("frame too short: %d bytes", len(data))
	}

	version := data[0]
	if version != binaryFrameVersion {
		return nil, fmt.Errorf("unsupported frame version: %d", version)
	}

	frameType := FrameType(data[1])
	payloadLen := binary.BigEndian.Uint16(data[2:4])

	if len(data) < int(4+payloadLen) {
		return nil, fmt.Errorf("frame truncated: expected %d bytes, got %d", 4+payloadLen, len(data))
	}

	payload := data[4 : 4+payloadLen]

	return &BinaryFrame{
		Version:   version,
		FrameType: frameType,
		Payload:   json.RawMessage(payload),
	}, nil
}
```

## Client-Side Reconnect Logic

The JavaScript client uses exponential backoff with jitter to reconnect after unexpected disconnections:

```javascript
// static/ws-client.js
class ReconnectingWebSocket {
  constructor(url, options = {}) {
    this.url = url;
    this.options = {
      minReconnectDelay: options.minReconnectDelay ?? 1000,
      maxReconnectDelay: options.maxReconnectDelay ?? 30000,
      reconnectDecay: options.reconnectDecay ?? 1.5,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
      shouldReconnect: options.shouldReconnect ?? (() => true),
    };

    this.readyState = WebSocket.CONNECTING;
    this.reconnectAttempts = 0;
    this._listeners = { open: [], message: [], close: [], error: [] };

    this._connect();
  }

  _connect() {
    this._ws = new WebSocket(this.url);

    this._ws.onopen = (event) => {
      this.readyState = WebSocket.OPEN;
      this.reconnectAttempts = 0;
      this._emit('open', event);
    };

    this._ws.onmessage = (event) => {
      this._emit('message', event);
    };

    this._ws.onerror = (event) => {
      this._emit('error', event);
    };

    this._ws.onclose = (event) => {
      this.readyState = WebSocket.CLOSED;
      this._emit('close', event);

      if (
        !event.wasClean &&
        this.reconnectAttempts < this.options.maxReconnectAttempts &&
        this.options.shouldReconnect(event)
      ) {
        const delay = this._getReconnectDelay();
        console.info(`WebSocket closed. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
        setTimeout(() => {
          this.reconnectAttempts++;
          this.readyState = WebSocket.CONNECTING;
          this._connect();
        }, delay);
      }
    };
  }

  _getReconnectDelay() {
    const base = this.options.minReconnectDelay *
      Math.pow(this.options.reconnectDecay, this.reconnectAttempts);
    const capped = Math.min(base, this.options.maxReconnectDelay);
    // Add ±20% jitter to prevent thundering herd
    const jitter = capped * 0.2 * (Math.random() * 2 - 1);
    return Math.floor(capped + jitter);
  }

  send(data) {
    if (this.readyState === WebSocket.OPEN) {
      this._ws.send(data);
    } else {
      console.warn('WebSocket not open. Message dropped.');
    }
  }

  close(code, reason) {
    this.options.shouldReconnect = () => false;
    this._ws.close(code, reason);
  }

  on(event, listener) {
    if (this._listeners[event]) {
      this._listeners[event].push(listener);
    }
    return this;
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }
}
```

## Horizontal Scaling with Kubernetes

### Sticky Sessions vs. Redis Fan-Out

There are two approaches to horizontal scaling:

1. **Sticky sessions (session affinity)**: Route each client to the same pod via `sessionAffinity: ClientIP` or an Ingress cookie. Simple but creates uneven load distribution and makes rolling deploys disruptive.

2. **Redis fan-out (recommended)**: Each pod maintains its own client connections and uses Redis pub/sub to relay messages to all peers. No stickiness required.

The Ingress configuration for Redis fan-out (no sticky sessions needed):

```yaml
# ws-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: websocket-server
  namespace: realtime
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
    - host: ws.example.com
      http:
        paths:
          - path: /ws
            pathType: Prefix
            backend:
              service:
                name: websocket-server
                port:
                  number: 8080
```

### Deployment with HPA

```yaml
# ws-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: websocket-server
  namespace: realtime
spec:
  replicas: 3
  selector:
    matchLabels:
      app: websocket-server
  template:
    metadata:
      labels:
        app: websocket-server
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      terminationGracePeriodSeconds: 90
      containers:
        - name: websocket-server
          image: my-org/websocket-server:latest
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: metrics
          env:
            - name: REDIS_ADDR
              value: redis-master.realtime.svc.cluster.local:6379
            - name: INSTANCE_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          lifecycle:
            preStop:
              exec:
                # Allow in-flight connections to drain
                command: ["sleep", "15"]
          resources:
            requests:
              cpu: 250m
              memory: 128Mi
            limits:
              cpu: 1000m
              memory: 512Mi
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: websocket-server
  namespace: realtime
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: websocket-server
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
    - type: Pods
      pods:
        metric:
          name: websocket_active_connections
        target:
          type: AverageValue
          averageValue: "500"
```

## Prometheus Metrics

```go
// internal/ws/metrics.go
package ws

import "github.com/prometheus/client_golang/prometheus"

type HubMetrics struct {
	clientsConnected prometheus.Gauge
	messagesSent     prometheus.Counter
	droppedMessages  prometheus.Counter
	broadcastLatency prometheus.Histogram
}

func newHubMetrics() *HubMetrics {
	m := &HubMetrics{
		clientsConnected: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "websocket",
			Name:      "active_connections",
			Help:      "Number of currently active WebSocket connections.",
		}),
		messagesSent: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "websocket",
			Name:      "messages_sent_total",
			Help:      "Total number of messages sent to clients.",
		}),
		droppedMessages: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "websocket",
			Name:      "messages_dropped_total",
			Help:      "Total number of messages dropped due to full client buffers.",
		}),
		broadcastLatency: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: "websocket",
			Name:      "broadcast_duration_seconds",
			Help:      "Time taken to broadcast a message to all clients in a room.",
			Buckets:   prometheus.DefBuckets,
		}),
	}
	prometheus.MustRegister(
		m.clientsConnected,
		m.messagesSent,
		m.droppedMessages,
		m.broadcastLatency,
	)
	return m
}
```

## Graceful Shutdown

Drain active connections before the pod terminates to avoid abrupt disconnections:

```go
// cmd/server/main.go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/my-org/wsserver/internal/ws"
)

func main() {
	pubsub := ws.NewRedisPubSub(
		os.Getenv("REDIS_ADDR"),
		os.Getenv("REDIS_PASSWORD"),
		0,
		os.Getenv("INSTANCE_ID"),
	)

	hub := ws.NewHub(pubsub)

	ctx, cancel := context.WithCancel(context.Background())
	go hub.Run(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws.ServeWS(hub, w, r)
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("websocket server starting", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("shutdown signal received")
	cancel() // stop hub goroutine

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
	}
	slog.Info("server exited cleanly")
}
```

## Summary

This architecture delivers a horizontally scalable WebSocket server in Go with zero sticky-session requirements. The concurrent hub pattern keeps all client-map mutations in a single goroutine, eliminating lock contention. Redis pub/sub fans out messages across instances in near-real-time. The binary frame format provides a compact wire protocol for high-frequency data. Combined with exponential-backoff reconnect on the client side and Kubernetes lifecycle hooks for graceful drain, this system handles rolling deploys and autoscaling events without client-visible disruptions.
