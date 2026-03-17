---
title: "Go: Building Reactive APIs with Server-Sent Events (SSE) for Real-Time Dashboards"
date: 2031-08-04T00:00:00-05:00
draft: false
tags: ["Go", "SSE", "Server-Sent Events", "Real-Time", "Dashboards", "HTTP", "Streaming", "Golang"]
categories:
- Go
- Web Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing Server-Sent Events in Go for real-time dashboard APIs, covering connection management, fan-out broadcasting, backpressure handling, reconnection logic, and production deployment behind Kubernetes ingress."
more_link: "yes"
url: "/go-server-sent-events-sse-reactive-apis-realtime-dashboards/"
---

WebSockets are the first technology that comes to mind for real-time browser-to-server communication, but for the majority of real-time dashboard use cases — streaming metrics, log tailing, event feeds, progress indicators — Server-Sent Events are simpler, more reliable, and better suited to the request-response model that HTTP infrastructure was designed for. SSE connections pass through standard HTTP load balancers, work with HTTP/2 multiplexing, support automatic reconnection in the browser, and require no special protocol negotiation.

This guide builds a production-grade SSE implementation in Go: a connection hub that manages thousands of concurrent listeners, a fan-out broadcaster with backpressure, reconnection support via last-event-id, and deployment patterns for Kubernetes with nginx ingress.

<!--more-->

# Go: Building Reactive APIs with Server-Sent Events (SSE) for Real-Time Dashboards

## SSE Protocol Basics

SSE is a standard browser API (EventSource) built on top of plain HTTP. The server sends a response with `Content-Type: text/event-stream` and keeps the connection open, writing events in a simple text format:

```
data: {"metric": "cpu", "value": 42.3}\n\n
```

Each event is terminated by two newlines. Events can include:
- `data:` — the event payload (required)
- `event:` — event type name (optional, default is `message`)
- `id:` — event identifier for reconnection (optional)
- `retry:` — milliseconds before browser retries a disconnected connection (optional)

The browser's `EventSource` API automatically reconnects when a connection drops, sending the last received `id` in the `Last-Event-ID` header. Your server uses this to replay missed events.

## Core SSE Handler

```go
// internal/sse/handler.go
package sse

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Event represents a single SSE event to be sent to clients.
type Event struct {
	// ID is the event sequence number for reconnection support.
	// Clients send this as Last-Event-ID on reconnect.
	ID uint64 `json:"-"`
	// Type is the EventSource event type. Clients subscribe with:
	// source.addEventListener('metrics', handler)
	Type string `json:"-"`
	// Data is the event payload. Will be JSON-encoded.
	Data interface{}
	// Retry instructs the browser how long to wait before reconnecting.
	// Only sent once; the browser remembers it.
	Retry time.Duration
}

// format serializes an Event to SSE wire format.
func (e Event) format() []byte {
	var buf []byte

	if e.ID > 0 {
		buf = append(buf, fmt.Sprintf("id: %d\n", e.ID)...)
	}
	if e.Type != "" {
		buf = append(buf, fmt.Sprintf("event: %s\n", e.Type)...)
	}
	if e.Retry > 0 {
		buf = append(buf, fmt.Sprintf("retry: %d\n", e.Retry.Milliseconds())...)
	}

	payload, err := json.Marshal(e.Data)
	if err != nil {
		payload = []byte(`{"error":"marshal failed"}`)
	}
	buf = append(buf, fmt.Sprintf("data: %s\n\n", payload)...)
	return buf
}

// client represents a single SSE connection.
type client struct {
	id       string
	ch       chan Event
	done     chan struct{}
	lastSeen uint64
}

// Hub manages all active SSE connections and broadcasts events to them.
type Hub struct {
	register   chan *client
	unregister chan *client
	broadcast  chan Event
	clients    map[string]*client
	log        *zap.Logger
	// Sequence counter for event IDs
	sequence atomic.Uint64
	// Event history for replay on reconnect
	history      *eventHistory
	// Maximum send buffer per client
	clientBuffer int
}

// HubConfig configures the SSE hub.
type HubConfig struct {
	// ClientBuffer is the channel buffer size for each client.
	// Messages are dropped for slow clients when the buffer is full.
	ClientBuffer int
	// HistorySize is the number of events to keep for reconnection replay.
	HistorySize int
	// HeartbeatInterval sends keepalive comments to prevent proxy timeouts.
	HeartbeatInterval time.Duration
}

// DefaultHubConfig returns sensible production defaults.
func DefaultHubConfig() HubConfig {
	return HubConfig{
		ClientBuffer:      256,
		HistorySize:       1000,
		HeartbeatInterval: 15 * time.Second,
	}
}

// NewHub creates a new SSE hub.
func NewHub(cfg HubConfig, log *zap.Logger) *Hub {
	return &Hub{
		register:     make(chan *client, 64),
		unregister:   make(chan *client, 64),
		broadcast:    make(chan Event, 1024),
		clients:      make(map[string]*client),
		log:          log,
		history:      newEventHistory(cfg.HistorySize),
		clientBuffer: cfg.ClientBuffer,
	}
}

// Run starts the hub event loop. Call this in a goroutine.
func (h *Hub) Run(ctx context.Context, heartbeatInterval time.Duration) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// Close all client channels on shutdown
			for _, c := range h.clients {
				close(c.ch)
			}
			return

		case c := <-h.register:
			h.clients[c.id] = c
			h.log.Debug("SSE client connected",
				zap.String("client_id", c.id),
				zap.Int("total_clients", len(h.clients)),
			)

		case c := <-h.unregister:
			if _, ok := h.clients[c.id]; ok {
				delete(h.clients, c.id)
				close(c.ch)
				h.log.Debug("SSE client disconnected",
					zap.String("client_id", c.id),
					zap.Int("total_clients", len(h.clients)),
				)
			}

		case event := <-h.broadcast:
			// Assign sequence ID and store in history
			event.ID = h.sequence.Add(1)
			h.history.append(event)

			// Fan out to all connected clients
			for id, c := range h.clients {
				select {
				case c.ch <- event:
					// Delivered
				default:
					// Client buffer is full; drop the event for this client.
					// The client will need to replay via Last-Event-ID on reconnect.
					h.log.Warn("SSE client buffer full, dropping event",
						zap.String("client_id", id),
						zap.Uint64("event_id", event.ID),
					)
				}
			}

		case <-ticker.C:
			// Send SSE comment as keepalive to prevent proxy and CDN timeouts
			for _, c := range h.clients {
				select {
				case c.ch <- Event{Type: "__heartbeat__"}:
				default:
				}
			}
		}
	}
}

// Publish sends an event to all connected clients.
// This is safe to call from any goroutine.
func (h *Hub) Publish(eventType string, data interface{}) {
	h.broadcast <- Event{
		Type: eventType,
		Data: data,
	}
}

// ClientCount returns the number of currently connected SSE clients.
func (h *Hub) ClientCount() int {
	return len(h.clients)
}
```

## Event History for Reconnection

```go
// internal/sse/history.go
package sse

import "sync"

// eventHistory maintains a ring buffer of recent events for replay.
type eventHistory struct {
	mu     sync.RWMutex
	events []Event
	size   int
	head   int
	count  int
}

func newEventHistory(size int) *eventHistory {
	return &eventHistory{
		events: make([]Event, size),
		size:   size,
	}
}

func (h *eventHistory) append(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.events[h.head] = e
	h.head = (h.head + 1) % h.size
	if h.count < h.size {
		h.count++
	}
}

// since returns all events with ID greater than lastID.
func (h *eventHistory) since(lastID uint64, maxEvents int) []Event {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var result []Event
	for i := 0; i < h.count; i++ {
		idx := (h.head - h.count + i + h.size) % h.size
		if h.events[idx].ID > lastID {
			result = append(result, h.events[idx])
			if len(result) >= maxEvents {
				break
			}
		}
	}
	return result
}
```

## HTTP Handler

```go
// internal/sse/http.go
package sse

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// Handler returns an http.HandlerFunc that serves SSE streams.
func (h *Hub) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		// SSE headers
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		// X-Accel-Buffering: no disables nginx proxy buffering for this response
		w.Header().Set("X-Accel-Buffering", "no")

		// Parse Last-Event-ID for reconnection replay
		var lastEventID uint64
		if lastIDHeader := r.Header.Get("Last-Event-ID"); lastIDHeader != "" {
			if id, err := strconv.ParseUint(lastIDHeader, 10, 64); err == nil {
				lastEventID = id
			}
		}

		// Register this client
		clientID := uuid.New().String()
		c := &client{
			id:       clientID,
			ch:       make(chan Event, h.clientBuffer),
			done:     make(chan struct{}),
			lastSeen: lastEventID,
		}

		h.register <- c
		defer func() { h.unregister <- c }()

		// Replay missed events if the client is reconnecting
		if lastEventID > 0 {
			missed := h.history.since(lastEventID, 100)
			for _, event := range missed {
				if err := writeEvent(w, event); err != nil {
					h.log.Debug("replay write error", zap.Error(err))
					return
				}
			}
			flusher.Flush()
		}

		// Send retry hint: browser retries after 3 seconds
		fmt.Fprintf(w, "retry: 3000\n\n")
		flusher.Flush()

		ctx := r.Context()
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-c.ch:
				if !ok {
					return
				}
				if event.Type == "__heartbeat__" {
					// SSE comments (lines starting with ':') are used as keepalives
					fmt.Fprintf(w, ": heartbeat\n\n")
				} else {
					if err := writeEvent(w, event); err != nil {
						h.log.Debug("write event error",
							zap.String("client_id", c.id),
							zap.Error(err),
						)
						return
					}
				}
				flusher.Flush()
			}
		}
	}
}

func writeEvent(w http.ResponseWriter, e Event) error {
	_, err := w.Write(e.format())
	return err
}
```

## Metrics and Dashboard Data Types

```go
// internal/metrics/types.go
package metrics

import "time"

// SystemMetrics represents a snapshot of system resource usage.
type SystemMetrics struct {
	Timestamp   time.Time `json:"timestamp"`
	ClusterName string    `json:"cluster"`
	Nodes       int       `json:"nodes"`
	CPUPercent  float64   `json:"cpu_percent"`
	MemPercent  float64   `json:"mem_percent"`
	PodCount    int       `json:"pod_count"`
	ErrorRate   float64   `json:"error_rate"`
}

// ServiceStatus represents the health of a single service.
type ServiceStatus struct {
	Name          string    `json:"name"`
	Namespace     string    `json:"namespace"`
	Healthy       bool      `json:"healthy"`
	Replicas      int       `json:"replicas"`
	ReadyReplicas int       `json:"ready_replicas"`
	P99Latency    float64   `json:"p99_latency_ms"`
	RequestRate   float64   `json:"request_rate"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// AlertEvent represents a triggered alert.
type AlertEvent struct {
	ID          string            `json:"id"`
	Severity    string            `json:"severity"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Labels      map[string]string `json:"labels"`
	FiredAt     time.Time         `json:"fired_at"`
	ResolvedAt  *time.Time        `json:"resolved_at,omitempty"`
	Value       float64           `json:"value"`
}
```

## Complete Server Implementation

```go
// cmd/dashboard-api/main.go
package main

import (
	"context"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yourorg/dashboard-api/internal/metrics"
	"github.com/yourorg/dashboard-api/internal/sse"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync()

	ctx, cancel := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer cancel()

	cfg := sse.DefaultHubConfig()
	hub := sse.NewHub(cfg, log)
	go hub.Run(ctx, cfg.HeartbeatInterval)

	go collectAndPublishMetrics(ctx, hub, log)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/events/metrics", hub.Handler())
	mux.HandleFunc("/api/v1/events/alerts", hub.Handler())
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"status":"ok","connected_clients":%d}`, hub.ClientCount())
	})

	srv := &http.Server{
		Addr:    ":8080",
		Handler: mux,
		// WriteTimeout must be 0 for SSE — streaming responses must not be cut off
		WriteTimeout: 0,
		ReadTimeout:  10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		log.Info("starting SSE server", zap.String("addr", ":8080"))
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal("http server error", zap.Error(err))
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	srv.Shutdown(shutdownCtx)
}

func collectAndPublishMetrics(ctx context.Context, hub *sse.Hub, log *zap.Logger) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			hub.Publish("metrics", metrics.SystemMetrics{
				Timestamp:   time.Now(),
				ClusterName: "production-us-east-1",
				Nodes:       12,
				CPUPercent:  30 + rand.Float64()*40,
				MemPercent:  45 + rand.Float64()*30,
				PodCount:    247 + rand.Intn(20),
				ErrorRate:   rand.Float64() * 2.5,
			})
		}
	}
}
```

## Browser Client (Safe DOM Manipulation)

The following example uses safe DOM manipulation with `textContent` rather than `innerHTML` to display metric values:

```javascript
// dashboard.js
const evtSource = new EventSource('/api/v1/events/metrics');

evtSource.onopen = function() {
  console.log('SSE connection established');
};

evtSource.onerror = function(err) {
  console.error('SSE error:', err);
  // The browser automatically reconnects with Last-Event-ID
};

evtSource.addEventListener('metrics', function(event) {
  const data = JSON.parse(event.data);
  updateMetrics(data);
});

function updateMetrics(metrics) {
  // Use textContent (not innerHTML) to safely display values
  const el = function(id) { return document.getElementById(id); };

  const cluster = el('cluster-name');
  if (cluster) {
    cluster.textContent = metrics.cluster;
  }

  const cpu = el('cpu-value');
  if (cpu) {
    cpu.textContent = metrics.cpu_percent.toFixed(1) + '%';
  }

  const mem = el('mem-value');
  if (mem) {
    mem.textContent = metrics.mem_percent.toFixed(1) + '%';
  }

  const pods = el('pod-count');
  if (pods) {
    pods.textContent = String(metrics.pod_count);
  }

  const updatedAt = el('last-updated');
  if (updatedAt) {
    // toLocaleTimeString is safe — it returns a formatted time string
    updatedAt.textContent = new Date(metrics.timestamp).toLocaleTimeString();
  }
}

window.addEventListener('beforeunload', function() {
  evtSource.close();
});
```

Corresponding HTML structure:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Dashboard</title></head>
<body>
  <h3>Cluster: <span id="cluster-name">—</span></h3>
  <p>CPU: <span id="cpu-value">—</span></p>
  <p>Memory: <span id="mem-value">—</span></p>
  <p>Pods: <span id="pod-count">—</span></p>
  <p>Updated: <span id="last-updated">—</span></p>
  <script src="dashboard.js"></script>
</body>
</html>
```

## Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dashboard-api
  namespace: production
spec:
  # In-process hub: use 1 replica, or add Redis pub/sub for multiple replicas
  replicas: 1
  template:
    spec:
      containers:
        - name: dashboard-api
          image: yourorg/dashboard-api:v1.2.0
          ports:
            - name: http
              containerPort: 8080
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
```

```yaml
# nginx ingress: disable proxy buffering for SSE endpoints
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: dashboard-api
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Connection '';
      proxy_http_version 1.1;
      chunked_transfer_encoding on;
spec:
  ingressClassName: nginx
  rules:
    - host: dashboard.internal.example.com
      http:
        paths:
          - path: /api/v1/events
            pathType: Prefix
            backend:
              service:
                name: dashboard-api
                port:
                  number: 8080
```

## Multi-Instance Scaling with Redis Pub/Sub

For deployments with multiple replicas, use Redis pub/sub as a fan-out layer:

```go
// internal/sse/redis_hub.go
package sse

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

// RedisHub extends Hub with cross-instance event distribution.
type RedisHub struct {
	*Hub
	rdb     *redis.Client
	channel string
}

func NewRedisHub(hub *Hub, rdb *redis.Client, channel string) *RedisHub {
	return &RedisHub{Hub: hub, rdb: rdb, channel: channel}
}

// PublishGlobal publishes an event to all instances via Redis.
func (h *RedisHub) PublishGlobal(ctx context.Context, eventType string, data interface{}) error {
	payload, err := json.Marshal(Event{Type: eventType, Data: data})
	if err != nil {
		return err
	}
	return h.rdb.Publish(ctx, h.channel, payload).Err()
}

// SubscribeToRedis consumes events from Redis and broadcasts locally.
func (h *RedisHub) SubscribeToRedis(ctx context.Context) {
	sub := h.rdb.Subscribe(ctx, h.channel)
	defer sub.Close()

	for msg := range sub.Channel() {
		var event Event
		if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
			continue
		}
		h.Hub.broadcast <- event
	}
}
```

## Testing SSE Endpoints

```go
// internal/sse/handler_test.go
package sse_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yourorg/dashboard-api/internal/sse"
	"go.uber.org/zap/zaptest"
)

func TestSSEHandler(t *testing.T) {
	log := zaptest.NewLogger(t)
	hub := sse.NewHub(sse.DefaultHubConfig(), log)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go hub.Run(ctx, 30*time.Second)

	server := httptest.NewServer(hub.Handler())
	defer server.Close()

	resp, err := http.Get(server.URL + "/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Errorf("expected text/event-stream content type, got %s",
			resp.Header.Get("Content-Type"))
	}

	go func() {
		time.Sleep(100 * time.Millisecond)
		hub.Publish("metrics", map[string]float64{"cpu": 42.3})
	}()

	scanner := bufio.NewScanner(resp.Body)
	var received []string
	deadline := time.After(2 * time.Second)

readLoop:
	for {
		lineCh := make(chan string, 1)
		go func() {
			if scanner.Scan() {
				lineCh <- scanner.Text()
			}
		}()

		select {
		case line := <-lineCh:
			if strings.HasPrefix(line, "data:") {
				received = append(received, line)
				if len(received) >= 1 {
					break readLoop
				}
			}
		case <-deadline:
			t.Error("timed out waiting for SSE event")
			break readLoop
		}
	}

	if len(received) == 0 {
		t.Error("received no SSE events")
	}
}
```

## Summary

Server-Sent Events provide the right level of complexity for real-time dashboards: simpler than WebSockets, more real-time than polling, and fully compatible with standard HTTP infrastructure. The patterns in this guide that have the most impact in production:

- Keep `WriteTimeout` at zero on the HTTP server; streaming responses must not have a write deadline
- Set `X-Accel-Buffering: no` in response headers and the corresponding nginx annotation to prevent proxy buffering that would delay event delivery
- Use event IDs and history replay to handle client reconnections without data loss
- Use typed events (`event:` field) rather than encoding event type in the data payload; the browser EventSource API handles typed events with `addEventListener`
- For multi-replica deployments, add Redis pub/sub as the fan-out layer between instances
- Use `textContent` rather than `innerHTML` when displaying SSE data in the browser to prevent XSS
- Monitor connected client count and the broadcast channel depth as primary operational metrics for the SSE layer
