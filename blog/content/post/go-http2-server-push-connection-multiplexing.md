---
title: "Go HTTP/2 Server Push and Connection Multiplexing for API Performance"
date: 2029-01-26T00:00:00-05:00
draft: false
tags: ["Go", "HTTP/2", "Performance", "API", "TLS", "gRPC", "Multiplexing"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Go HTTP/2 configuration, server push, connection multiplexing, and gRPC performance tuning for high-throughput API services in production environments."
more_link: "yes"
url: "/go-http2-server-push-connection-multiplexing/"
---

HTTP/2 fundamentally changes the connection model between clients and servers. Where HTTP/1.1 requires separate TCP connections for concurrent requests (or head-of-line blocking on a single connection), HTTP/2 multiplexes multiple request/response streams over a single TCP connection, enabling parallel requests without connection overhead. For Go API services, enabling HTTP/2 correctly—and understanding its interaction with TLS, timeouts, and gRPC—significantly impacts throughput, latency, and resource efficiency.

This post covers Go's `net/http` HTTP/2 support, server push, flow control, connection management, gRPC performance tuning, and the operational considerations for running HTTP/2 services in production behind reverse proxies.

<!--more-->

## HTTP/2 in Go: What the Standard Library Provides

Go's `net/http` server automatically negotiates HTTP/2 when TLS is configured via ALPN (Application-Layer Protocol Negotiation). No code changes are required for basic HTTP/2 support—serving HTTPS automatically enables HTTP/2 for clients that support it.

```go
// server_basic.go — HTTP/2 is automatic with TLS
package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "proto=%s host=%s\n", r.Proto, r.Host)
	})

	srv := &http.Server{
		Addr:    ":8443",
		Handler: mux,
		TLSConfig: &tls.Config{
			// HTTP/2 requires TLS 1.2+ with specific cipher suites
			// Go's crypto/tls negotiates ALPN automatically
			MinVersion: tls.VersionTLS12,
			CurvePreferences: []tls.CurveID{
				tls.X25519,
				tls.CurveP256,
			},
			CipherSuites: []uint16{
				tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
				tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
				tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			},
			PreferServerCipherSuites: false, // Go 1.17+ ignores this
		},
	}

	log.Println("Starting HTTP/2 server on :8443")
	if err := srv.ListenAndServeTLS("server.crt", "server.key"); err != nil {
		log.Fatal(err)
	}
}
```

### Verifying HTTP/2 Negotiation

```bash
# Check that HTTP/2 is being negotiated
curl -v --http2 https://localhost:8443/api/v1/health 2>&1 | grep -E "HTTP/2|ALPN|proto"

# Or using nghttp2 for detailed HTTP/2 framing info
nghttp -v https://localhost:8443/api/v1/health

# Expected output includes:
# [  0.000] recv SETTINGS frame
# [  0.001] recv (stream_id=1) :status: 200
```

## Production HTTP/2 Server Configuration

```go
// server/server.go — Production-hardened HTTP/2 server
package server

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

// Config holds all server configuration.
type Config struct {
	// Listener settings
	Addr    string
	TLSCert string
	TLSKey  string

	// HTTP/2 settings
	HTTP2MaxConcurrentStreams        uint32
	HTTP2MaxReadFrameSize            uint32
	HTTP2MaxUploadBufferPerStream    int32
	HTTP2MaxUploadBufferPerConnCount int32
	HTTP2WriteByteTimeout            time.Duration

	// HTTP timeouts
	ReadHeaderTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration

	// Request size limits
	MaxRequestBodySize int64
}

// DefaultConfig returns production-ready defaults.
func DefaultConfig(addr string) Config {
	return Config{
		Addr: addr,

		// HTTP/2: allow up to 250 concurrent streams per connection
		HTTP2MaxConcurrentStreams:        250,
		HTTP2MaxReadFrameSize:            1 << 20, // 1 MiB
		HTTP2MaxUploadBufferPerStream:    1 << 20, // 1 MiB flow control window
		HTTP2MaxUploadBufferPerConnCount: 1 << 23, // 8 MiB connection-level window
		HTTP2WriteByteTimeout:            30 * time.Second,

		// Timeouts: balance between long-running requests and connection hygiene
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute,  // Allow long streaming responses
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       120 * time.Second,

		MaxRequestBodySize: 32 << 20, // 32 MiB
	}
}

// New creates a configured HTTP/2 server.
func New(cfg Config, handler http.Handler) (*http.Server, error) {
	// Wrap handler with size limit middleware
	limitedHandler := http.MaxBytesHandler(handler, cfg.MaxRequestBodySize)

	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"h2", "http/1.1"}, // Prefer HTTP/2
		CurvePreferences: []tls.CurveID{
			tls.X25519,
			tls.CurveP256,
		},
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           limitedHandler,
		TLSConfig:         tlsCfg,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
	}

	// Configure HTTP/2 transport settings explicitly
	h2s := &http2.Server{
		MaxConcurrentStreams:         cfg.HTTP2MaxConcurrentStreams,
		MaxReadFrameSize:             cfg.HTTP2MaxReadFrameSize,
		MaxUploadBufferPerStream:     cfg.HTTP2MaxUploadBufferPerStream,
		MaxUploadBufferPerConnection: cfg.HTTP2MaxUploadBufferPerConnCount,
		WriteByteTimeout:             cfg.HTTP2WriteByteTimeout,
		// IdleTimeout: different from the HTTP/1.1 idle timeout
		// This governs how long an idle HTTP/2 connection is kept open
		IdleTimeout: 180 * time.Second,
	}

	if err := http2.ConfigureServer(srv, h2s); err != nil {
		return nil, fmt.Errorf("configure http2: %w", err)
	}

	return srv, nil
}

// NewH2CServer creates an HTTP/2 cleartext server (h2c) for internal services.
// h2c is HTTP/2 without TLS, suitable for internal cluster communication
// behind an TLS-terminating reverse proxy.
func NewH2CServer(cfg Config, handler http.Handler) *http.Server {
	h2s := &http2.Server{
		MaxConcurrentStreams: cfg.HTTP2MaxConcurrentStreams,
		MaxReadFrameSize:     cfg.HTTP2MaxReadFrameSize,
	}

	return &http.Server{
		Addr:              cfg.Addr,
		Handler:           h2c.NewHandler(handler, h2s),
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
	}
}
```

## HTTP/2 Server Push

Server Push allows the server to proactively send resources before the client requests them. This is valuable for API servers that serve a known set of related resources (e.g., a list endpoint that returns IDs, followed by individual detail requests):

```go
// handlers/api_handler.go
package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
)

// DashboardHandler demonstrates HTTP/2 server push for pre-loading related resources.
// When a client requests /dashboard, it pushes the user profile and notifications
// data before the client can even parse the dashboard response.
func DashboardHandler(w http.ResponseWriter, r *http.Request) {
	// Attempt to use HTTP/2 server push
	if pusher, ok := w.(http.Pusher); ok {
		// Push user profile endpoint
		pushOpts := &http.PushOptions{
			Method: "GET",
			Header: http.Header{
				"Accept":        []string{"application/json"},
				"Authorization": r.Header["Authorization"], // Forward auth
			},
		}

		// These pushes happen concurrently with the main response
		if err := pusher.Push("/api/v1/user/profile", pushOpts); err != nil {
			// Non-fatal: client may not support push or push limit may be reached
			fmt.Printf("push /user/profile: %v\n", err)
		}
		if err := pusher.Push("/api/v1/notifications?limit=10", pushOpts); err != nil {
			fmt.Printf("push /notifications: %v\n", err)
		}
	}

	// Return the main dashboard response
	// By the time the JavaScript client parses this and fires the sub-requests,
	// the pushed responses may already be in the client's push cache.
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"message": "Dashboard loaded",
	})
}

// StreamingHandler demonstrates HTTP/2 streaming responses.
// HTTP/2 multiplexing allows this to run concurrently with other requests
// without blocking a connection.
func StreamingHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	// Stream events until client disconnects or context is cancelled
	ctx := r.Context()
	eventID := 0
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		eventID++
		fmt.Fprintf(w, "id: %d\n", eventID)
		fmt.Fprintf(w, "event: metrics\n")
		fmt.Fprintf(w, "data: {\"timestamp\":%d,\"value\":%d}\n\n",
			time.Now().Unix(), eventID*100)

		// Flush sends the event immediately without buffering
		flusher.Flush()

		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}
```

## HTTP/2 Client Configuration

```go
// client/http2_client.go
package client

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"time"

	"golang.org/x/net/http2"
)

// NewHTTP2Client creates an HTTP/2-optimized client.
// The client reuses connections aggressively — a single connection
// can carry hundreds of concurrent streams.
func NewHTTP2Client(opts ...Option) *http.Client {
	cfg := defaultClientConfig()
	for _, opt := range opts {
		opt(cfg)
	}

	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
	}
	if cfg.InsecureSkipVerify {
		tlsCfg.InsecureSkipVerify = true
	}

	// Use http2.Transport directly for full HTTP/2 control
	h2Transport := &http2.Transport{
		TLSClientConfig: tlsCfg,

		// Allow up to 250 concurrent streams per connection
		// Before creating a new connection, the client will use existing ones
		// up to this limit.
		// Default is 100; increase for high-throughput services.
		MaxHeaderListSize: 65536,

		// Aggressive connection reuse
		// StrictMaxConcurrentStreams: false means the client can exceed
		// the server's advertised MaxConcurrentStreams during the initial
		// connection setup.
		StrictMaxConcurrentStreams: false,

		// Ping period for connection health checks
		ReadIdleTimeout: 30 * time.Second,
		PingTimeout:     15 * time.Second,

		// WriteByteTimeout: how long to wait for a write to complete
		WriteByteTimeout: 30 * time.Second,

		DialTLSContext: func(ctx context.Context, network, addr string, cfg *tls.Config) (net.Conn, error) {
			dialer := &net.Dialer{
				Timeout:   5 * time.Second,
				KeepAlive: 30 * time.Second,
			}
			conn, err := tls.DialWithDialer(dialer, network, addr, cfg)
			if err != nil {
				return nil, err
			}
			return conn, nil
		},
	}

	return &http.Client{
		Transport: h2Transport,
		Timeout:   cfg.RequestTimeout,
	}
}

// NewH2CClient creates a client for h2c (HTTP/2 cleartext) backends.
// Use for internal service-to-service communication.
func NewH2CClient() *http.Client {
	h2Transport := &http2.Transport{
		// Allow HTTP/2 without TLS
		AllowHTTP: true,
		// Custom dialer that does NOT upgrade to TLS
		DialTLSContext: func(ctx context.Context, network, addr string, cfg *tls.Config) (net.Conn, error) {
			return net.Dial(network, addr)
		},
		ReadIdleTimeout:  30 * time.Second,
		PingTimeout:      15 * time.Second,
		WriteByteTimeout: 30 * time.Second,
	}

	return &http.Client{
		Transport: h2Transport,
		Timeout:   60 * time.Second,
	}
}

type clientConfig struct {
	RequestTimeout     time.Duration
	InsecureSkipVerify bool
}

func defaultClientConfig() *clientConfig {
	return &clientConfig{
		RequestTimeout: 30 * time.Second,
	}
}

type Option func(*clientConfig)

func WithTimeout(d time.Duration) Option {
	return func(c *clientConfig) { c.RequestTimeout = d }
}

func WithInsecureSkipVerify(skip bool) Option {
	return func(c *clientConfig) { c.InsecureSkipVerify = skip }
}
```

## gRPC Performance with HTTP/2

gRPC uses HTTP/2 natively. Understanding the HTTP/2 layer helps tune gRPC performance:

```go
// grpc/server.go — Production gRPC server with HTTP/2 tuning
package grpcserver

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
)

// NewGRPCServer creates a production-hardened gRPC server.
func NewGRPCServer(certFile, keyFile, caFile string) (*grpc.Server, error) {
	// Load TLS credentials
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load cert: %w", err)
	}

	caCert, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read CA: %w", err)
	}
	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("parse CA cert")
	}

	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    caPool,
		MinVersion:   tls.VersionTLS12,
	}

	creds := credentials.NewTLS(tlsCfg)

	opts := []grpc.ServerOption{
		grpc.Creds(creds),

		// HTTP/2 flow control: initial window size for streams and connections
		// Larger windows reduce round-trips for large payloads
		grpc.InitialWindowSize(1 << 20),           // 1 MiB per stream
		grpc.InitialConnWindowSize(1 << 23),        // 8 MiB per connection

		// Maximum concurrent streams per connection
		grpc.MaxConcurrentStreams(500),

		// Message size limits — prevent OOM from oversized payloads
		grpc.MaxRecvMsgSize(16 << 20),  // 16 MiB
		grpc.MaxSendMsgSize(16 << 20),

		// Keepalive parameters for idle connection health
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionIdle:     5 * time.Minute,   // Close idle connections after 5m
			MaxConnectionAge:      30 * time.Minute,  // Force reconnect after 30m
			MaxConnectionAgeGrace: 5 * time.Second,   // Grace period for in-flight RPCs
			Time:                  2 * time.Minute,   // Send ping every 2m
			Timeout:               20 * time.Second,  // Kill connection if no ping ACK in 20s
		}),

		// Enforce client keepalive policy to prevent abuse
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             1 * time.Minute,  // Min time between client pings
			PermitWithoutStream: true,              // Allow pings without active streams
		}),

		// Read buffer size for incoming streams
		grpc.ReadBufferSize(64 << 10),  // 64 KiB
		grpc.WriteBufferSize(64 << 10),
	}

	return grpc.NewServer(opts...), nil
}

// NewGRPCClient creates a connection pool-friendly gRPC client.
func NewGRPCClient(target, certFile, keyFile, caFile string) (*grpc.ClientConn, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load client cert: %w", err)
	}

	caCert, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read CA: %w", err)
	}
	caPool := x509.NewCertPool()
	caPool.AppendCertsFromPEM(caCert)

	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      caPool,
		MinVersion:   tls.VersionTLS12,
	}

	return grpc.NewClient(target,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)),
		grpc.WithInitialWindowSize(1<<20),
		grpc.WithInitialConnWindowSize(1<<23),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(16<<20),
			grpc.MaxCallSendMsgSize(16<<20),
		),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                2 * time.Minute,
			Timeout:             20 * time.Second,
			PermitWithoutStream: true,
		}),
		grpc.WithReadBufferSize(64<<10),
		grpc.WithWriteBufferSize(64<<10),
		// Enable client-side load balancing across multiple backend IPs
		grpc.WithDefaultServiceConfig(`{"loadBalancingPolicy":"round_robin"}`),
	)
}
```

## Benchmarking HTTP/2 Multiplexing

```go
// bench/http2_bench_test.go
package bench_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/http2"
)

func BenchmarkHTTP2Concurrent(b *testing.B) {
	// Setup HTTP/2 test server
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(10 * time.Millisecond) // Simulate backend latency
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"status":"ok"}`)
	})

	srv := httptest.NewTLSServer(handler)
	defer srv.Close()

	// Create HTTP/2 client
	transport := srv.Client().Transport.(*http.Transport)
	http2.ConfigureTransport(transport)

	client := &http.Client{Transport: transport}

	concurrency := []int{1, 10, 50, 100, 200}
	for _, c := range concurrency {
		b.Run(fmt.Sprintf("concurrency-%d", c), func(b *testing.B) {
			b.SetParallelism(c)
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					resp, err := client.Get(srv.URL + "/api/v1/test")
					if err != nil {
						b.Errorf("request failed: %v", err)
						return
					}
					resp.Body.Close()
				}
			})
		})
	}
}
```

## Reverse Proxy Considerations

Most production Go HTTP/2 services sit behind nginx or Envoy. HTTP/2 between the proxy and the backend (h2c or h2) provides multiplexing benefits even when the frontend terminates TLS:

```nginx
# nginx.conf — HTTP/2 proxy to Go backend
upstream go_backend {
    server 10.0.1.10:8080;
    server 10.0.1.11:8080;
    keepalive 32;      # Keep 32 idle connections per nginx worker
    keepalive_requests 10000;
    keepalive_timeout 120s;
}

server {
    listen 443 ssl;
    http2 on;

    ssl_certificate     /etc/ssl/certs/api.example.com.pem;
    ssl_certificate_key /etc/ssl/private/api.example.com.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    location / {
        proxy_pass http://go_backend;
        proxy_http_version 1.1;    # nginx->backend uses HTTP/1.1 with keepalive
        proxy_set_header Connection "";  # Required for keepalive with HTTP/1.1
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Enable HTTP/2 push pass-through (nginx 1.13.9+)
        http2_push_preload on;
    }
}
```

## Monitoring HTTP/2 Performance

```go
// middleware/metrics.go — Prometheus metrics for HTTP/2 observability
package middleware

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	requestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "myservice",
		Subsystem: "http",
		Name:      "requests_total",
		Help:      "Total HTTP requests",
	}, []string{"method", "path", "status", "proto"})

	requestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "myservice",
		Subsystem: "http",
		Name:      "request_duration_seconds",
		Help:      "HTTP request duration in seconds",
		Buckets:   prometheus.ExponentialBuckets(0.001, 2, 12),
	}, []string{"method", "path", "status", "proto"})

	activeStreams = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "myservice",
		Subsystem: "http",
		Name:      "active_streams",
		Help:      "Number of currently active HTTP/2 streams",
	}, []string{"proto"})
)

// MetricsMiddleware records HTTP/2 vs HTTP/1.1 traffic separately.
func MetricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proto := r.Proto // "HTTP/2.0" or "HTTP/1.1"
		activeStreams.WithLabelValues(proto).Inc()
		defer activeStreams.WithLabelValues(proto).Dec()

		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, statusCode: 200}

		next.ServeHTTP(rw, r)

		duration := time.Since(start).Seconds()
		status := strconv.Itoa(rw.statusCode)

		requestsTotal.WithLabelValues(r.Method, r.URL.Path, status, proto).Inc()
		requestDuration.WithLabelValues(r.Method, r.URL.Path, status, proto).Observe(duration)
	})
}

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}
```

## Summary

HTTP/2 provides meaningful performance improvements for Go API services with three core benefits:

1. **Connection multiplexing** eliminates the overhead of establishing multiple TCP connections for concurrent API calls. A single connection from a client to the server can handle hundreds of in-flight requests simultaneously.

2. **Header compression (HPACK)** reduces bandwidth for APIs with repetitive headers (authorization tokens, content-type, correlation IDs).

3. **Server Push** allows pre-loading related resources before the client requests them, reducing perceived latency for browser clients and API gateways that follow known access patterns.

The key operational points:
- HTTP/2 is automatic in Go when TLS is configured—no code changes are needed for basic HTTP/2 support.
- Use `golang.org/x/net/http2` for explicit control over stream windows, concurrent stream limits, and keepalive parameters.
- Use h2c (cleartext HTTP/2) for internal service communication behind TLS-terminating proxies to maintain multiplexing benefits without double-TLS overhead.
- Configure nginx with `keepalive` and `proxy_http_version 1.1` upstream keepalive to prevent connection churn, even without h2c backend support.
- Monitor `active_streams` and protocol distribution to verify that HTTP/2 is being negotiated by clients and that multiplexing is providing the expected concurrency.
