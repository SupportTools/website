---
title: "Go Service Mesh Integration: Building gRPC Services with Envoy, xDS API, and Dynamic Configuration"
date: 2028-08-25T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Envoy", "xDS", "Service Mesh", "Dynamic Configuration"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production gRPC services in Go that integrate with Envoy proxy through the xDS API for dynamic configuration, load balancing, health checking, and service mesh integration."
more_link: "yes"
url: "/go-grpc-envoy-xds-service-mesh-guide/"
---

Envoy has become the de facto data plane for service meshes. Istio, AWS App Mesh, and Consul Connect all use Envoy as the proxy. The xDS (discovery service) API is the protocol through which control planes configure Envoy dynamically — no config file reloads, no downtime. Building Go services that speak xDS directly gives you precise control over Envoy's behavior: custom load balancing policies, cluster health updates, dynamic route configuration, and circuit breaking all become programmatic.

This guide covers building production gRPC services in Go, integrating them with Envoy as a sidecar, implementing an xDS control plane, and using the xDS API for dynamic traffic management.

<!--more-->

# [Go Service Mesh Integration: gRPC, Envoy, and xDS](#go-grpc-envoy-xds)

## Section 1: Understanding Envoy's xDS API

The xDS API (originally from Envoy) is a set of gRPC services that a control plane implements to configure Envoy. Envoy connects to the control plane and receives streaming configuration updates.

### Core xDS Services

| API | Purpose | Proto Service |
|-----|---------|---------------|
| LDS | Listener Discovery Service | Ports to listen on, filter chains |
| RDS | Route Discovery Service | Virtual hosts, routes, clusters |
| CDS | Cluster Discovery Service | Upstream service clusters |
| EDS | Endpoint Discovery Service | Individual endpoint addresses |
| SDS | Secret Discovery Service | TLS certificates and keys |
| ADS | Aggregated Discovery Service | Single stream for all above |

### xDS Resource Naming

```
# LDS listener name format
0.0.0.0_8080

# CDS cluster name format
outbound|8080||payment-service.production.svc.cluster.local

# EDS cluster name
outbound|8080||payment-service.production.svc.cluster.local
```

## Section 2: gRPC Service Definition

Start with a well-structured gRPC service. We'll build a payment service that Envoy will front.

### proto/payment/v1/payment.proto

```protobuf
syntax = "proto3";

package payment.v1;

option go_package = "github.com/myorg/payment-service/gen/payment/v1;paymentv1";

import "google/protobuf/timestamp.proto";

service PaymentService {
  rpc ProcessPayment(ProcessPaymentRequest) returns (ProcessPaymentResponse);
  rpc GetPayment(GetPaymentRequest) returns (GetPaymentResponse);
  rpc StreamPaymentEvents(StreamPaymentEventsRequest)
      returns (stream PaymentEvent);
}

message ProcessPaymentRequest {
  string idempotency_key = 1;
  string currency         = 2;
  int64  amount_cents     = 3;
  string payment_method   = 4;
  map<string, string> metadata = 5;
}

message ProcessPaymentResponse {
  string payment_id = 1;
  PaymentStatus status = 2;
  google.protobuf.Timestamp created_at = 3;
}

message GetPaymentRequest {
  string payment_id = 1;
}

message GetPaymentResponse {
  string payment_id = 1;
  PaymentStatus status = 2;
  int64  amount_cents  = 3;
  string currency      = 4;
  google.protobuf.Timestamp created_at  = 5;
  google.protobuf.Timestamp updated_at  = 6;
}

message StreamPaymentEventsRequest {
  repeated string payment_ids = 1;
}

message PaymentEvent {
  string payment_id = 1;
  PaymentStatus status = 2;
  google.protobuf.Timestamp occurred_at = 3;
}

enum PaymentStatus {
  PAYMENT_STATUS_UNSPECIFIED = 0;
  PAYMENT_STATUS_PENDING     = 1;
  PAYMENT_STATUS_PROCESSING  = 2;
  PAYMENT_STATUS_COMPLETED   = 3;
  PAYMENT_STATUS_FAILED      = 4;
  PAYMENT_STATUS_REFUNDED    = 5;
}
```

### Generating Go Code

```bash
# Install tools
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Generate
protoc \
  --go_out=gen \
  --go_opt=paths=source_relative \
  --go-grpc_out=gen \
  --go-grpc_opt=paths=source_relative \
  proto/payment/v1/payment.proto
```

## Section 3: Implementing the gRPC Server in Go

### internal/server/payment.go

```go
package server

import (
	"context"
	"fmt"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	paymentv1 "github.com/myorg/payment-service/gen/payment/v1"
)

type PaymentServer struct {
	paymentv1.UnimplementedPaymentServiceServer
	mu       sync.RWMutex
	payments map[string]*paymentv1.GetPaymentResponse
	events   map[string]chan *paymentv1.PaymentEvent
}

func NewPaymentServer() *PaymentServer {
	return &PaymentServer{
		payments: make(map[string]*paymentv1.GetPaymentResponse),
		events:   make(map[string]chan *paymentv1.PaymentEvent),
	}
}

func (s *PaymentServer) ProcessPayment(
	ctx context.Context,
	req *paymentv1.ProcessPaymentRequest,
) (*paymentv1.ProcessPaymentResponse, error) {
	// Extract request metadata
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return nil, status.Error(codes.InvalidArgument, "missing metadata")
	}

	// Log request ID for tracing
	requestID := ""
	if ids := md.Get("x-request-id"); len(ids) > 0 {
		requestID = ids[0]
	}

	_ = requestID // use in structured logging

	// Validate input
	if req.IdempotencyKey == "" {
		return nil, status.Error(codes.InvalidArgument, "idempotency_key is required")
	}
	if req.AmountCents <= 0 {
		return nil, status.Error(codes.InvalidArgument, "amount_cents must be positive")
	}
	if req.Currency == "" {
		return nil, status.Error(codes.InvalidArgument, "currency is required")
	}

	// Check idempotency
	s.mu.RLock()
	if existing, ok := s.payments[req.IdempotencyKey]; ok {
		s.mu.RUnlock()
		return &paymentv1.ProcessPaymentResponse{
			PaymentId: existing.PaymentId,
			Status:    existing.Status,
			CreatedAt: existing.CreatedAt,
		}, nil
	}
	s.mu.RUnlock()

	// Process payment
	paymentID := fmt.Sprintf("pay_%s", generateID())
	now := timestamppb.Now()

	payment := &paymentv1.GetPaymentResponse{
		PaymentId:   paymentID,
		Status:      paymentv1.PaymentStatus_PAYMENT_STATUS_PROCESSING,
		AmountCents: req.AmountCents,
		Currency:    req.Currency,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	s.mu.Lock()
	s.payments[req.IdempotencyKey] = payment
	s.payments[paymentID] = payment
	eventCh := make(chan *paymentv1.PaymentEvent, 100)
	s.events[paymentID] = eventCh
	s.mu.Unlock()

	// Async processing simulation
	go s.processAsync(paymentID, eventCh)

	return &paymentv1.ProcessPaymentResponse{
		PaymentId: paymentID,
		Status:    paymentv1.PaymentStatus_PAYMENT_STATUS_PENDING,
		CreatedAt: now,
	}, nil
}

func (s *PaymentServer) GetPayment(
	ctx context.Context,
	req *paymentv1.GetPaymentRequest,
) (*paymentv1.GetPaymentResponse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	payment, ok := s.payments[req.PaymentId]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "payment %q not found", req.PaymentId)
	}
	return payment, nil
}

func (s *PaymentServer) StreamPaymentEvents(
	req *paymentv1.StreamPaymentEventsRequest,
	stream paymentv1.PaymentService_StreamPaymentEventsServer,
) error {
	ctx := stream.Context()

	// Set trailing metadata to signal stream is ready
	if err := stream.SetHeader(metadata.Pairs("stream-status", "ready")); err != nil {
		return status.Errorf(codes.Internal, "setting header: %v", err)
	}

	// Subscribe to events for requested payment IDs
	channels := make([]<-chan *paymentv1.PaymentEvent, 0, len(req.PaymentIds))

	s.mu.RLock()
	for _, id := range req.PaymentIds {
		if ch, ok := s.events[id]; ok {
			channels = append(channels, ch)
		}
	}
	s.mu.RUnlock()

	// Fan-in all event channels
	merged := mergeChannels(channels...)

	for {
		select {
		case <-ctx.Done():
			return status.Error(codes.Canceled, "client disconnected")
		case event, ok := <-merged:
			if !ok {
				return nil
			}
			if err := stream.Send(event); err != nil {
				return status.Errorf(codes.Unavailable, "sending event: %v", err)
			}
		}
	}
}

func (s *PaymentServer) processAsync(paymentID string, eventCh chan *paymentv1.PaymentEvent) {
	defer close(eventCh)

	time.Sleep(100 * time.Millisecond) // Simulate processing

	s.mu.Lock()
	for _, p := range s.payments {
		if p.PaymentId == paymentID {
			p.Status = paymentv1.PaymentStatus_PAYMENT_STATUS_COMPLETED
			p.UpdatedAt = timestamppb.Now()
		}
	}
	s.mu.Unlock()

	eventCh <- &paymentv1.PaymentEvent{
		PaymentId:  paymentID,
		Status:     paymentv1.PaymentStatus_PAYMENT_STATUS_COMPLETED,
		OccurredAt: timestamppb.Now(),
	}
}
```

### cmd/server/main.go

```go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"

	paymentv1 "github.com/myorg/payment-service/gen/payment/v1"
	"github.com/myorg/payment-service/internal/interceptors"
	"github.com/myorg/payment-service/internal/server"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	grpcPort := getEnvOrDefault("GRPC_PORT", "9000")
	healthPort := getEnvOrDefault("HEALTH_PORT", "8080")

	// Build gRPC server with production settings
	grpcServer := grpc.NewServer(
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionIdle:     15 * time.Second,
			MaxConnectionAge:      30 * time.Second,
			MaxConnectionAgeGrace: 5 * time.Second,
			Time:                  5 * time.Second,
			Timeout:               1 * time.Second,
		}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             5 * time.Second,
			PermitWithoutStream: true,
		}),
		grpc.ChainUnaryInterceptor(
			interceptors.RecoveryInterceptor(),
			interceptors.LoggingInterceptor(logger),
			interceptors.MetricsInterceptor(),
		),
		grpc.ChainStreamInterceptor(
			interceptors.StreamRecoveryInterceptor(),
			interceptors.StreamLoggingInterceptor(logger),
		),
	)

	// Register services
	paymentSvc := server.NewPaymentServer()
	paymentv1.RegisterPaymentServiceServer(grpcServer, paymentSvc)

	// Health check service
	healthServer := health.NewServer()
	grpc_health_v1.RegisterHealthServer(grpcServer, healthServer)
	healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	healthServer.SetServingStatus("payment.v1.PaymentService",
		grpc_health_v1.HealthCheckResponse_SERVING)

	// gRPC reflection (for grpcurl, grpc-gateway)
	reflection.Register(grpcServer)

	// HTTP health endpoint for Kubernetes probes
	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/healthz/live", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	httpMux.HandleFunc("/healthz/ready", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Start listeners
	grpcLis, err := net.Listen("tcp", ":"+grpcPort)
	if err != nil {
		slog.Error("Failed to listen for gRPC", "port", grpcPort, "error", err)
		os.Exit(1)
	}

	// Start servers
	go func() {
		slog.Info("gRPC server starting", "port", grpcPort)
		if err := grpcServer.Serve(grpcLis); err != nil {
			slog.Error("gRPC server error", "error", err)
		}
	}()

	httpServer := &http.Server{
		Addr:    ":" + healthPort,
		Handler: httpMux,
	}
	go func() {
		slog.Info("HTTP health server starting", "port", healthPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP health server error", "error", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	slog.Info("Shutting down servers...")
	healthServer.Shutdown()
	grpcServer.GracefulStop()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	httpServer.Shutdown(ctx)

	slog.Info("Shutdown complete")
}
```

## Section 4: Envoy Sidecar Configuration for gRPC

### envoy-sidecar.yaml — Static Configuration

```yaml
static_resources:
  listeners:
  # Ingress: Envoy receives traffic on 8080, forwards to gRPC on 9000
  - name: ingress_listener
    address:
      socket_address:
        address: 0.0.0.0
        port_value: 8080
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress_http
          codec_type: AUTO
          route_config:
            name: local_route
            virtual_hosts:
            - name: local_service
              domains: ["*"]
              routes:
              - match:
                  prefix: "/payment.v1.PaymentService"
                route:
                  cluster: local_grpc_service
                  timeout: 30s
                  retry_policy:
                    retry_on: "reset,connect-failure,retriable-status-codes"
                    retriable_status_codes: [14]  # UNAVAILABLE
                    num_retries: 3
                    per_try_timeout: 10s
          http_filters:
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

  clusters:
  # The local gRPC service (the app container)
  - name: local_grpc_service
    connect_timeout: 5s
    type: STATIC
    lb_policy: ROUND_ROBIN
    typed_extension_protocol_options:
      envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
        "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
        explicit_http_config:
          http2_protocol_options: {}  # Force HTTP/2 for gRPC
    load_assignment:
      cluster_name: local_grpc_service
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              socket_address:
                address: 127.0.0.1
                port_value: 9000
    health_checks:
    - timeout: 5s
      interval: 10s
      unhealthy_threshold: 3
      healthy_threshold: 1
      grpc_health_check:
        service_name: "payment.v1.PaymentService"

admin:
  address:
    socket_address:
      address: 127.0.0.1
      port_value: 9901
```

### Kubernetes Deployment with Envoy Sidecar

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      containers:
      - name: payment-service
        image: payment-service:v2.3.1
        env:
        - name: GRPC_PORT
          value: "9000"
        - name: HEALTH_PORT
          value: "8080"
        ports:
        - name: grpc
          containerPort: 9000
        - name: health
          containerPort: 8080
        readinessProbe:
          grpc:
            port: 9000
            service: "payment.v1.PaymentService"
          periodSeconds: 5

      - name: envoy
        image: envoyproxy/envoy:v1.29-latest
        args:
        - -c
        - /etc/envoy/envoy.yaml
        - --service-cluster
        - payment-service
        - --service-node
        - $(POD_NAME)
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        ports:
        - name: http
          containerPort: 8080
        - name: admin
          containerPort: 9901
        volumeMounts:
        - name: envoy-config
          mountPath: /etc/envoy
        readinessProbe:
          httpGet:
            path: /ready
            port: 9901
          periodSeconds: 3

      volumes:
      - name: envoy-config
        configMap:
          name: payment-service-envoy-config
```

## Section 5: Building an xDS Control Plane in Go

The xDS control plane dynamically pushes configuration to Envoy. This is how Istio Pilot, AWS App Mesh, and custom service meshes work.

### Dependencies

```bash
go get github.com/envoyproxy/go-control-plane/pkg/cache/v3@latest
go get github.com/envoyproxy/go-control-plane/pkg/server/v3@latest
go get github.com/envoyproxy/go-control-plane/envoy/service/discovery/v3@latest
```

### cmd/control-plane/main.go

```go
package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"time"

	"google.golang.org/grpc"

	cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	serverv3 "github.com/envoyproxy/go-control-plane/pkg/server/v3"
	discoveryv3 "github.com/envoyproxy/go-control-plane/envoy/service/discovery/v3"

	"github.com/myorg/control-plane/internal/xds"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	// Snapshot cache: stores Envoy config snapshots per node
	// Hash-based: Envoy nodes identified by their node ID
	snapshotCache := cachev3.NewSnapshotCache(
		false, // ads = false (allow partial updates)
		cachev3.IDHash{},
		logger,
	)

	// Build the xDS server
	xdsServer := serverv3.NewServer(context.Background(), snapshotCache, nil)

	// gRPC server for Envoy to connect to
	grpcServer := grpc.NewServer()

	// Register all xDS services
	discoveryv3.RegisterAggregatedDiscoveryServiceServer(grpcServer, xdsServer)

	// Start the xDS manager — watches Kubernetes and updates snapshots
	manager := xds.NewManager(snapshotCache, logger)
	go manager.Run(context.Background())

	// Listen and serve
	lis, err := net.Listen("tcp", ":18000")
	if err != nil {
		logger.Error("Failed to listen", "error", err)
		os.Exit(1)
	}

	logger.Info("xDS control plane starting", "port", 18000)
	if err := grpcServer.Serve(lis); err != nil {
		logger.Error("gRPC server failed", "error", err)
	}
}
```

### internal/xds/manager.go

```go
package xds

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	clusterv3 "github.com/envoyproxy/go-control-plane/envoy/config/cluster/v3"
	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	endpointv3 "github.com/envoyproxy/go-control-plane/envoy/config/endpoint/v3"
	listenerv3 "github.com/envoyproxy/go-control-plane/envoy/config/listener/v3"
	routev3 "github.com/envoyproxy/go-control-plane/envoy/config/route/v3"
	hcmv3 "github.com/envoyproxy/go-control-plane/envoy/extensions/filters/network/http_connection_manager/v3"
	routerv3 "github.com/envoyproxy/go-control-plane/envoy/extensions/filters/http/router/v3"
	upstreamhttpv3 "github.com/envoyproxy/go-control-plane/envoy/extensions/upstreams/http/v3"
	cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	resourcev3 "github.com/envoyproxy/go-control-plane/pkg/resource/v3"

	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type Manager struct {
	cache  cachev3.SnapshotCache
	logger *slog.Logger
	nodeID string
}

func NewManager(cache cachev3.SnapshotCache, logger *slog.Logger) *Manager {
	return &Manager{
		cache:  cache,
		logger: logger,
		nodeID: "payment-service-envoy",
	}
}

func (m *Manager) Run(ctx context.Context) {
	// Initial snapshot
	if err := m.updateSnapshot(ctx, m.buildInitialConfig()); err != nil {
		m.logger.Error("Failed to set initial snapshot", "error", err)
	}

	// Periodic refresh (in production, watch Kubernetes endpoints instead)
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			config := m.buildInitialConfig()
			if err := m.updateSnapshot(ctx, config); err != nil {
				m.logger.Error("Failed to update snapshot", "error", err)
			}
		}
	}
}

type ServiceConfig struct {
	ClusterName string
	Endpoints   []Endpoint
	ConnTimeout time.Duration
}

type Endpoint struct {
	Address string
	Port    uint32
	Weight  uint32
}

func (m *Manager) buildInitialConfig() []ServiceConfig {
	return []ServiceConfig{
		{
			ClusterName: "payment-service",
			ConnTimeout: 5 * time.Second,
			Endpoints: []Endpoint{
				{Address: "10.0.0.1", Port: 9000, Weight: 100},
				{Address: "10.0.0.2", Port: 9000, Weight: 100},
				{Address: "10.0.0.3", Port: 9000, Weight: 100},
			},
		},
	}
}

func (m *Manager) updateSnapshot(ctx context.Context, configs []ServiceConfig) error {
	version := fmt.Sprintf("%d", time.Now().UnixNano())

	clusters := make([]cachev3.Resource, 0, len(configs))
	endpoints := make([]cachev3.Resource, 0, len(configs))

	for _, cfg := range configs {
		cluster, err := m.buildCluster(cfg)
		if err != nil {
			return fmt.Errorf("building cluster %s: %w", cfg.ClusterName, err)
		}
		clusters = append(clusters, cluster)

		eds, err := m.buildEndpoints(cfg)
		if err != nil {
			return fmt.Errorf("building endpoints %s: %w", cfg.ClusterName, err)
		}
		endpoints = append(endpoints, eds)
	}

	listeners, err := m.buildListeners(configs)
	if err != nil {
		return fmt.Errorf("building listeners: %w", err)
	}

	routes, err := m.buildRoutes(configs)
	if err != nil {
		return fmt.Errorf("building routes: %w", err)
	}

	snapshot, err := cachev3.NewSnapshot(version,
		map[resourcev3.Type][]cachev3.Resource{
			resourcev3.ListenerType: listeners,
			resourcev3.RouteType:    routes,
			resourcev3.ClusterType:  clusters,
			resourcev3.EndpointType: endpoints,
		},
	)
	if err != nil {
		return fmt.Errorf("creating snapshot: %w", err)
	}

	if err := snapshot.Consistent(); err != nil {
		return fmt.Errorf("inconsistent snapshot: %w", err)
	}

	if err := m.cache.SetSnapshot(ctx, m.nodeID, snapshot); err != nil {
		return fmt.Errorf("setting snapshot: %w", err)
	}

	m.logger.Info("Snapshot updated", "version", version,
		"clusters", len(clusters),
		"endpoints", len(endpoints),
	)
	return nil
}

func (m *Manager) buildCluster(cfg ServiceConfig) (*clusterv3.Cluster, error) {
	// HTTP/2 for gRPC upstreams
	http2Options, err := anypb.New(&upstreamhttpv3.HttpProtocolOptions{
		UpstreamProtocolOptions: &upstreamhttpv3.HttpProtocolOptions_ExplicitHttpConfig_{
			ExplicitHttpConfig: &upstreamhttpv3.HttpProtocolOptions_ExplicitHttpConfig{
				ProtocolConfig: &upstreamhttpv3.HttpProtocolOptions_ExplicitHttpConfig_Http2ProtocolOptions{
					Http2ProtocolOptions: &corev3.Http2ProtocolOptions{},
				},
			},
		},
	})
	if err != nil {
		return nil, err
	}

	return &clusterv3.Cluster{
		Name:                 cfg.ClusterName,
		ConnectTimeout:       durationpb.New(cfg.ConnTimeout),
		ClusterDiscoveryType: &clusterv3.Cluster_Type{Type: clusterv3.Cluster_EDS},
		EdsClusterConfig: &clusterv3.Cluster_EdsClusterConfig{
			EdsConfig: &corev3.ConfigSource{
				ResourceApiVersion: corev3.ApiVersion_V3,
				ConfigSourceSpecifier: &corev3.ConfigSource_Ads{
					Ads: &corev3.AggregatedConfigSource{},
				},
			},
			ServiceName: cfg.ClusterName,
		},
		LbPolicy: clusterv3.Cluster_LEAST_REQUEST,
		TypedExtensionProtocolOptions: map[string]*anypb.Any{
			"envoy.extensions.upstreams.http.v3.HttpProtocolOptions": http2Options,
		},
		// Circuit breaker
		CircuitBreakers: &clusterv3.CircuitBreakers{
			Thresholds: []*clusterv3.CircuitBreakers_Thresholds{
				{
					Priority:           corev3.RoutingPriority_DEFAULT,
					MaxConnections:     wrapperspb.UInt32(100),
					MaxPendingRequests: wrapperspb.UInt32(1000),
					MaxRequests:        wrapperspb.UInt32(1000),
					MaxRetries:         wrapperspb.UInt32(3),
				},
			},
		},
	}, nil
}

func (m *Manager) buildEndpoints(cfg ServiceConfig) (*endpointv3.ClusterLoadAssignment, error) {
	lbEndpoints := make([]*endpointv3.LbEndpoint, 0, len(cfg.Endpoints))

	for _, ep := range cfg.Endpoints {
		lbEndpoints = append(lbEndpoints, &endpointv3.LbEndpoint{
			HostIdentifier: &endpointv3.LbEndpoint_Endpoint{
				Endpoint: &endpointv3.Endpoint{
					Address: &corev3.Address{
						Address: &corev3.Address_SocketAddress{
							SocketAddress: &corev3.SocketAddress{
								Protocol: corev3.SocketAddress_TCP,
								Address:  ep.Address,
								PortSpecifier: &corev3.SocketAddress_PortValue{
									PortValue: ep.Port,
								},
							},
						},
					},
					HealthCheckConfig: &endpointv3.Endpoint_HealthCheckConfig{
						PortValue: ep.Port,
					},
				},
			},
			LoadBalancingWeight: wrapperspb.UInt32(ep.Weight),
		})
	}

	return &endpointv3.ClusterLoadAssignment{
		ClusterName: cfg.ClusterName,
		Endpoints: []*endpointv3.LocalityLbEndpoints{
			{LbEndpoints: lbEndpoints},
		},
	}, nil
}

func (m *Manager) buildListeners(configs []ServiceConfig) ([]cachev3.Resource, error) {
	// Build HTTP connection manager filter
	routerAny, err := anypb.New(&routerv3.Router{})
	if err != nil {
		return nil, err
	}

	hcm := &hcmv3.HttpConnectionManager{
		StatPrefix:  "ingress_http",
		CodecType:   hcmv3.HttpConnectionManager_AUTO,
		HttpFilters: []*hcmv3.HttpFilter{{
			Name:       "envoy.filters.http.router",
			ConfigType: &hcmv3.HttpFilter_TypedConfig{TypedConfig: routerAny},
		}},
		RouteSpecifier: &hcmv3.HttpConnectionManager_Rds{
			Rds: &hcmv3.Rds{
				ConfigSource: &corev3.ConfigSource{
					ResourceApiVersion: corev3.ApiVersion_V3,
					ConfigSourceSpecifier: &corev3.ConfigSource_Ads{
						Ads: &corev3.AggregatedConfigSource{},
					},
				},
				RouteConfigName: "local_route",
			},
		},
	}

	hcmAny, err := anypb.New(hcm)
	if err != nil {
		return nil, err
	}

	listener := &listenerv3.Listener{
		Name: "0.0.0.0_8080",
		Address: &corev3.Address{
			Address: &corev3.Address_SocketAddress{
				SocketAddress: &corev3.SocketAddress{
					Protocol: corev3.SocketAddress_TCP,
					Address:  "0.0.0.0",
					PortSpecifier: &corev3.SocketAddress_PortValue{PortValue: 8080},
				},
			},
		},
		FilterChains: []*listenerv3.FilterChain{{
			Filters: []*listenerv3.Filter{{
				Name:       "envoy.filters.network.http_connection_manager",
				ConfigType: &listenerv3.Filter_TypedConfig{TypedConfig: hcmAny},
			}},
		}},
	}

	return []cachev3.Resource{listener}, nil
}

func (m *Manager) buildRoutes(configs []ServiceConfig) ([]cachev3.Resource, error) {
	routes := make([]*routev3.Route, 0, len(configs))

	for _, cfg := range configs {
		routes = append(routes, &routev3.Route{
			Match: &routev3.RouteMatch{
				PathSpecifier: &routev3.RouteMatch_Prefix{
					Prefix: fmt.Sprintf("/payment.v1.PaymentService"),
				},
			},
			Action: &routev3.Route_Route{
				Route: &routev3.RouteAction{
					ClusterSpecifier: &routev3.RouteAction_Cluster{
						Cluster: cfg.ClusterName,
					},
					Timeout: durationpb.New(30 * time.Second),
					RetryPolicy: &routev3.RetryPolicy{
						RetryOn:              "reset,connect-failure,retriable-status-codes",
						RetriableStatusCodes: []uint32{14}, // UNAVAILABLE
						NumRetries:           wrapperspb.UInt32(3),
						PerTryTimeout:        durationpb.New(10 * time.Second),
					},
				},
			},
		})
	}

	routeConfig := &routev3.RouteConfiguration{
		Name: "local_route",
		VirtualHosts: []*routev3.VirtualHost{{
			Name:    "local_service",
			Domains: []string{"*"},
			Routes:  routes,
		}},
	}

	return []cachev3.Resource{routeConfig}, nil
}
```

## Section 6: gRPC Interceptors for Production

### internal/interceptors/logging.go

```go
package interceptors

import (
	"context"
	"log/slog"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func LoggingInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		start := time.Now()

		// Extract trace/request IDs from metadata
		md, _ := metadata.FromIncomingContext(ctx)
		requestID := firstMD(md, "x-request-id")
		traceID := firstMD(md, "x-b3-traceid")

		resp, err := handler(ctx, req)

		code := codes.OK
		if err != nil {
			code = status.Code(err)
		}

		logger.InfoContext(ctx, "gRPC request",
			"method", info.FullMethod,
			"code", code.String(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", requestID,
			"trace_id", traceID,
			"error", err,
		)

		return resp, err
	}
}

func firstMD(md metadata.MD, key string) string {
	if vals := md.Get(key); len(vals) > 0 {
		return vals[0]
	}
	return ""
}
```

### internal/interceptors/recovery.go

```go
package interceptors

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func RecoveryInterceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (resp any, err error) {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("gRPC panic recovered",
					"method", info.FullMethod,
					"panic", fmt.Sprintf("%v", r),
					"stack", string(debug.Stack()),
				)
				err = status.Errorf(codes.Internal, "internal server error")
			}
		}()
		return handler(ctx, req)
	}
}
```

## Section 7: gRPC Client with Envoy Load Balancing

When your Go service is also a client calling other services through Envoy:

```go
package client

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"

	paymentv1 "github.com/myorg/payment-service/gen/payment/v1"
)

type PaymentClient struct {
	client paymentv1.PaymentServiceClient
	conn   *grpc.ClientConn
}

func NewPaymentClient(envoyAddr string) (*PaymentClient, error) {
	// Connect to Envoy sidecar (which load balances to payment-service)
	conn, err := grpc.NewClient(
		envoyAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                10 * time.Second,
			Timeout:             3 * time.Second,
			PermitWithoutStream: true,
		}),
		grpc.WithDefaultCallOptions(
			grpc.WaitForReady(true),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("connecting to payment service: %w", err)
	}

	return &PaymentClient{
		client: paymentv1.NewPaymentServiceClient(conn),
		conn:   conn,
	}, nil
}

func (c *PaymentClient) ProcessPayment(
	ctx context.Context,
	req *paymentv1.ProcessPaymentRequest,
	requestID string,
) (*paymentv1.ProcessPaymentResponse, error) {
	// Inject metadata for tracing
	ctx = metadata.AppendToOutgoingContext(ctx,
		"x-request-id", requestID,
		"content-type", "application/grpc",
	)

	return c.client.ProcessPayment(ctx, req)
}

func (c *PaymentClient) Close() error {
	return c.conn.Close()
}
```

## Section 8: Envoy Dynamic Configuration via Admin API

The admin API allows you to inspect and modify Envoy's runtime configuration:

```bash
# Check Envoy's view of clusters
curl -s http://localhost:9901/clusters | head -50

# Check Envoy's listeners
curl -s http://localhost:9901/listeners

# Check xDS server connection status
curl -s http://localhost:9901/config_dump | jq '.configs[] | select(.["@type"] | contains("BootstrapConfig"))'

# Drain connections gracefully
curl -s -X POST http://localhost:9901/drain_listeners?inboundonly

# Check Envoy's runtime flags
curl -s http://localhost:9901/runtime

# Get endpoint health
curl -s http://localhost:9901/clusters | grep -A 5 "payment-service"

# Force a health check update
curl -s -X POST "http://localhost:9901/healthcheck/ok"
```

### Monitoring Envoy Metrics via Prometheus

```yaml
# Envoy stats endpoint (text format)
# http://localhost:9901/stats/prometheus

# Key gRPC metrics to watch:
# envoy_cluster_grpc_<cluster_name>_0_request_message_count
# envoy_cluster_grpc_<cluster_name>_0_response_message_count
# envoy_cluster_upstream_rq_total{envoy_cluster_name="payment-service"}
# envoy_cluster_upstream_rq_pending_overflow{envoy_cluster_name="payment-service"}
# envoy_cluster_upstream_cx_connect_fail{envoy_cluster_name="payment-service"}

# Prometheus scrape config for Envoy admin:
scrape_configs:
- job_name: 'envoy-sidecar'
  metrics_path: '/stats/prometheus'
  static_configs:
  - targets: ['localhost:9901']
```

## Section 9: Testing gRPC Services

### Integration Test with grpc Testing Package

```go
package server_test

import (
	"context"
	"net"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"

	paymentv1 "github.com/myorg/payment-service/gen/payment/v1"
	"github.com/myorg/payment-service/internal/server"
)

const bufSize = 1024 * 1024

func setupTestServer(t *testing.T) paymentv1.PaymentServiceClient {
	t.Helper()

	lis := bufconn.Listen(bufSize)
	grpcServer := grpc.NewServer()
	paymentv1.RegisterPaymentServiceServer(grpcServer, server.NewPaymentServer())

	go func() {
		if err := grpcServer.Serve(lis); err != nil {
			t.Errorf("Server serve failed: %v", err)
		}
	}()
	t.Cleanup(grpcServer.GracefulStop)

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	return paymentv1.NewPaymentServiceClient(conn)
}

func TestProcessPayment(t *testing.T) {
	client := setupTestServer(t)

	resp, err := client.ProcessPayment(context.Background(), &paymentv1.ProcessPaymentRequest{
		IdempotencyKey: "test-key-001",
		Currency:       "USD",
		AmountCents:    1000,
		PaymentMethod:  "card",
	})

	require.NoError(t, err)
	assert.NotEmpty(t, resp.PaymentId)
	assert.NotNil(t, resp.CreatedAt)
}

func TestIdempotency(t *testing.T) {
	client := setupTestServer(t)

	req := &paymentv1.ProcessPaymentRequest{
		IdempotencyKey: "idempotent-key-001",
		Currency:       "USD",
		AmountCents:    500,
	}

	resp1, err := client.ProcessPayment(context.Background(), req)
	require.NoError(t, err)

	resp2, err := client.ProcessPayment(context.Background(), req)
	require.NoError(t, err)

	// Same idempotency key must return same payment ID
	assert.Equal(t, resp1.PaymentId, resp2.PaymentId)
}
```

## Section 10: Production Readiness Checklist

### gRPC Server Checklist

```bash
# Verify gRPC reflection is registered (for grpcurl)
grpcurl -plaintext localhost:9000 list

# Test health check
grpcurl -plaintext localhost:9000 grpc.health.v1.Health/Check

# Test service method
grpcurl -plaintext -d '{
  "idempotency_key": "test-001",
  "currency": "USD",
  "amount_cents": 1000
}' localhost:9000 payment.v1.PaymentService/ProcessPayment

# Verify Envoy is proxying correctly
grpcurl -plaintext -d '{
  "idempotency_key": "test-002",
  "currency": "USD",
  "amount_cents": 2000
}' localhost:8080 payment.v1.PaymentService/ProcessPayment
```

### xDS Control Plane Checklist

```bash
# Verify Envoy connected to xDS control plane
curl -s http://localhost:9901/config_dump | \
  jq '.configs[] | select(."@type" | contains("ListenersConfig")) | .dynamic_listeners[].name'

# Verify EDS endpoints are populated
curl -s http://localhost:9901/clusters | grep "payment-service"

# Force snapshot update and watch Envoy logs
# In control plane logs, look for:
# {"level":"info","msg":"Snapshot updated","version":"1234567890","clusters":1,"endpoints":1}
```

This architecture provides a production-grade gRPC service with Envoy acting as a dynamic, programmable proxy. The xDS control plane enables zero-downtime routing updates, traffic splitting for canary deployments, and centralized observability — the foundation of any modern service mesh.
