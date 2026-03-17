---
title: "Go Service Discovery and Client-Side Load Balancing with gRPC and Consul"
date: 2030-08-06T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Consul", "Service Discovery", "Load Balancing", "Microservices", "Resilience"]
categories:
- Go
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Production service discovery in Go: gRPC name resolver interface, Consul service catalog integration, health-check aware load balancing, connection warmup, retry policies, and building resilient service clients for microservices."
more_link: "yes"
url: "/go-service-discovery-client-side-load-balancing-grpc-consul/"
---

Client-side load balancing in Go microservices combines service discovery, health checking, and connection management into a coherent strategy for distributing traffic across healthy service instances. When implemented correctly, it eliminates single points of failure, handles rolling deployments gracefully, and provides faster failover than infrastructure-level load balancers can achieve.

<!--more-->

## Overview

This guide implements production-grade service discovery and client-side load balancing for Go gRPC services using Consul as the service registry. It covers the gRPC name resolver interface, custom Consul resolver implementation, health-check aware backends, retry policies, connection warmup, and patterns for building resilient service clients.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Client Service                       │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              gRPC Client Connection             │   │
│  │  ┌───────────────┐    ┌─────────────────────┐   │   │
│  │  │  Name Resolver│    │   Load Balancer      │   │   │
│  │  │  (Consul)     │───▶│   (Round Robin /     │   │   │
│  │  │               │    │    Least Conn)       │   │   │
│  │  └───────────────┘    └──────────┬──────────┘   │   │
│  └───────────────────────────────────┼─────────────┘   │
│                                      │                  │
│                    ┌─────────────────┼─────────────┐    │
│                    ▼                 ▼             ▼    │
│              Instance 1       Instance 2    Instance 3  │
└─────────────────────────────────────────────────────────┘
                     ▲                 ▲             ▲
                     └─────────────────┴─────────────┘
                                 Consul
                          (service registry +
                           health checking)
```

## Consul Service Registration

### Agent Configuration

```hcl
# /etc/consul.d/order-service.hcl
service {
  name = "order-service"
  id   = "order-service-1"
  port = 9090
  tags = ["grpc", "v2", "production"]

  meta = {
    grpc_version = "2.0"
    region       = "us-east-1"
    weight       = "100"
  }

  check {
    id       = "order-service-grpc-health"
    name     = "gRPC Health Check"
    grpc     = "127.0.0.1:9090/order.v2.OrderService"
    interval = "10s"
    timeout  = "3s"
    # Deregister after extended failure
    deregister_critical_service_after = "90s"
  }

  check {
    id       = "order-service-tcp"
    name     = "TCP Port Check"
    tcp      = "127.0.0.1:9090"
    interval = "30s"
    timeout  = "3s"
  }
}
```

### Programmatic Service Registration in Go

```go
// consul/registration.go
package consul

import (
	"fmt"
	"os"
	"time"

	consulapi "github.com/hashicorp/consul/api"
	"google.golang.org/grpc/health/grpc_health_v1"
)

type ServiceRegistrar struct {
	client      *consulapi.Client
	serviceID   string
	serviceName string
	port        int
	ttl         time.Duration
	stopCh      chan struct{}
}

func NewRegistrar(serviceName string, port int) (*ServiceRegistrar, error) {
	cfg := consulapi.DefaultConfig()
	// CONSUL_HTTP_ADDR is read automatically from environment
	client, err := consulapi.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("creating consul client: %w", err)
	}

	hostname, _ := os.Hostname()
	serviceID := fmt.Sprintf("%s-%s-%d", serviceName, hostname, port)

	return &ServiceRegistrar{
		client:      client,
		serviceID:   serviceID,
		serviceName: serviceName,
		port:        port,
		ttl:         15 * time.Second,
		stopCh:      make(chan struct{}),
	}, nil
}

func (r *ServiceRegistrar) Register(version, region string) error {
	registration := &consulapi.AgentServiceRegistration{
		ID:   r.serviceID,
		Name: r.serviceName,
		Port: r.port,
		Tags: []string{"grpc", version},
		Meta: map[string]string{
			"version": version,
			"region":  region,
		},
		Checks: consulapi.AgentServiceChecks{
			{
				CheckID:                        r.serviceID + "-ttl",
				TTL:                            r.ttl.String(),
				DeregisterCriticalServiceAfter: "5m",
			},
			{
				CheckID:  r.serviceID + "-grpc",
				GRPC:     fmt.Sprintf("127.0.0.1:%d", r.port),
				Interval: "10s",
				Timeout:  "3s",
			},
		},
	}

	if err := r.client.Agent().ServiceRegister(registration); err != nil {
		return fmt.Errorf("registering service: %w", err)
	}

	// Start TTL heartbeat
	go r.heartbeat()
	return nil
}

func (r *ServiceRegistrar) heartbeat() {
	ticker := time.NewTicker(r.ttl / 2)
	defer ticker.Stop()

	checkID := "service:" + r.serviceID + ":1"
	for {
		select {
		case <-ticker.C:
			if err := r.client.Agent().UpdateTTL(checkID, "service healthy", consulapi.HealthPassing); err != nil {
				// Log but don't exit; Consul will eventually deregister if TTL expires
				fmt.Fprintf(os.Stderr, "consul TTL update failed: %v\n", err)
			}
		case <-r.stopCh:
			return
		}
	}
}

func (r *ServiceRegistrar) Deregister() error {
	close(r.stopCh)
	return r.client.Agent().ServiceDeregister(r.serviceID)
}
```

## Implementing a Custom gRPC Name Resolver for Consul

The gRPC `resolver.Builder` interface allows injecting custom service discovery logic into the gRPC dial process.

```go
// consul/resolver.go
package consul

import (
	"context"
	"fmt"
	"sync"
	"time"

	consulapi "github.com/hashicorp/consul/api"
	"google.golang.org/grpc/resolver"
)

const (
	consulScheme   = "consul"
	watchInterval  = 5 * time.Second
)

func init() {
	resolver.Register(&consulBuilder{})
}

// consulBuilder implements resolver.Builder
type consulBuilder struct{}

func (b *consulBuilder) Build(target resolver.Target, cc resolver.ClientConn, opts resolver.BuildOptions) (resolver.Resolver, error) {
	cfg := consulapi.DefaultConfig()
	// Allow overriding Consul address via target authority
	if target.URL.Host != "" {
		cfg.Address = target.URL.Host
	}

	client, err := consulapi.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("consul resolver: creating client: %w", err)
	}

	serviceName := target.Endpoint()
	ctx, cancel := context.WithCancel(context.Background())

	r := &consulResolver{
		client:      client,
		cc:          cc,
		serviceName: serviceName,
		ctx:         ctx,
		cancel:      cancel,
	}

	go r.watch()
	return r, nil
}

func (b *consulBuilder) Scheme() string { return consulScheme }

// consulResolver implements resolver.Resolver
type consulResolver struct {
	client      *consulapi.Client
	cc          resolver.ClientConn
	serviceName string
	ctx         context.Context
	cancel      context.CancelFunc
	mu          sync.Mutex
	lastIndex   uint64
}

func (r *consulResolver) watch() {
	for {
		select {
		case <-r.ctx.Done():
			return
		default:
		}

		addrs, newIndex, err := r.resolve()
		if err != nil {
			r.cc.ReportError(fmt.Errorf("consul resolver: %w", err))
			select {
			case <-time.After(watchInterval):
			case <-r.ctx.Done():
				return
			}
			continue
		}

		r.mu.Lock()
		r.lastIndex = newIndex
		r.mu.Unlock()

		if len(addrs) == 0 {
			r.cc.ReportError(fmt.Errorf("consul resolver: no healthy instances for %s", r.serviceName))
			select {
			case <-time.After(watchInterval):
			case <-r.ctx.Done():
				return
			}
			continue
		}

		grpcAddrs := make([]resolver.Address, 0, len(addrs))
		for _, a := range addrs {
			grpcAddrs = append(grpcAddrs, resolver.Address{
				Addr:       fmt.Sprintf("%s:%d", a.Service.Address, a.Service.Port),
				ServerName: r.serviceName,
				Attributes: buildAttributes(a.Service),
			})
		}

		r.cc.UpdateState(resolver.State{Addresses: grpcAddrs})
	}
}

func (r *consulResolver) resolve() ([]*consulapi.ServiceEntry, uint64, error) {
	r.mu.Lock()
	lastIndex := r.lastIndex
	r.mu.Unlock()

	// Blocking query: returns when health state changes or WaitTime expires
	entries, meta, err := r.client.Health().Service(
		r.serviceName,
		"",         // tag filter (empty = all tags)
		true,       // passing only
		&consulapi.QueryOptions{
			WaitIndex: lastIndex,
			WaitTime:  30 * time.Second,
			UseCache:  true,
		},
	)
	if err != nil {
		return nil, lastIndex, err
	}
	return entries, meta.LastIndex, nil
}

func buildAttributes(svc *consulapi.AgentService) *attributes.Attributes {
	// Store service metadata as gRPC resolver attributes for use by custom LB policies
	return attributes.New(
		"weight", parseWeight(svc.Meta["weight"]),
		"region", svc.Meta["region"],
		"version", svc.Meta["version"],
	)
}

func parseWeight(s string) int {
	w := 100
	fmt.Sscanf(s, "%d", &w)
	return w
}

func (r *consulResolver) ResolveNow(_ resolver.ResolveNowOptions) {
	// Blocking query handles updates; nothing needed here
}

func (r *consulResolver) Close() {
	r.cancel()
}
```

## gRPC Client with Load Balancing

### Creating the gRPC Connection

```go
// client/connection.go
package client

import (
	"context"
	"time"

	_ "github.com/supporttools/order-client/consul" // register consul resolver
	"google.golang.org/grpc"
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/balancer/roundrobin"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
)

type ConnectionConfig struct {
	ServiceName    string
	ConsulAddress  string
	TLSEnabled     bool
	MaxRetries     int
	WarmupTimeout  time.Duration
}

func NewServiceConnection(cfg ConnectionConfig) (*grpc.ClientConn, error) {
	// Target uses the consul:// scheme registered by our builder
	target := "consul://" + cfg.ConsulAddress + "/" + cfg.ServiceName

	dialOpts := []grpc.DialOption{
		// Use round-robin load balancing across resolved addresses
		grpc.WithDefaultServiceConfig(`{
			"loadBalancingConfig": [{"round_robin": {}}],
			"methodConfig": [{
				"name": [{}],
				"retryPolicy": {
					"maxAttempts": 4,
					"initialBackoff": "0.1s",
					"maxBackoff": "2s",
					"backoffMultiplier": 2.0,
					"retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
				},
				"waitForReady": true,
				"timeout": "10s"
			}]
		}`),
		// Keepalive to detect dead connections
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                20 * time.Second,
			Timeout:             5 * time.Second,
			PermitWithoutStream: true,
		}),
		// Retry connect with backoff
		grpc.WithConnectParams(grpc.ConnectParams{
			Backoff: backoff.Config{
				BaseDelay:  1 * time.Second,
				Multiplier: 1.6,
				Jitter:     0.2,
				MaxDelay:   30 * time.Second,
			},
			MinConnectTimeout: 5 * time.Second,
		}),
	}

	if cfg.TLSEnabled {
		// Load TLS credentials (omitted for brevity)
		// dialOpts = append(dialOpts, grpc.WithTransportCredentials(tlsCreds))
	} else {
		dialOpts = append(dialOpts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	}

	conn, err := grpc.NewClient(target, dialOpts...)
	if err != nil {
		return nil, err
	}

	// Connection warmup: wait for at least one ready subchannel
	if cfg.WarmupTimeout > 0 {
		if err := warmup(conn, cfg.WarmupTimeout); err != nil {
			conn.Close()
			return nil, err
		}
	}

	return conn, nil
}
```

### Connection Warmup

Warmup prevents the first requests from hitting an unready connection:

```go
// client/warmup.go
package client

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
)

func warmup(conn *grpc.ClientConn, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Trigger connection establishment
	conn.Connect()

	for {
		state := conn.GetState()
		switch state {
		case connectivity.Ready:
			return nil
		case connectivity.TransientFailure, connectivity.Shutdown:
			return fmt.Errorf("connection failed during warmup: state=%s", state)
		}

		if !conn.WaitForStateChange(ctx, state) {
			return fmt.Errorf("warmup timeout after %v: state=%s", timeout, conn.GetState())
		}
	}
}
```

## Retry Policy Configuration

gRPC retry policies are defined in the service config JSON embedded in dial options:

```go
const serviceConfig = `{
  "loadBalancingConfig": [{"round_robin": {}}],
  "methodConfig": [
    {
      "name": [{"service": "order.v2.OrderService", "method": "CreateOrder"}],
      "retryPolicy": {
        "maxAttempts": 3,
        "initialBackoff": "0.05s",
        "maxBackoff": "1s",
        "backoffMultiplier": 2.0,
        "retryableStatusCodes": ["UNAVAILABLE"]
      },
      "timeout": "5s"
    },
    {
      "name": [{"service": "order.v2.OrderService", "method": "GetOrder"}],
      "retryPolicy": {
        "maxAttempts": 5,
        "initialBackoff": "0.1s",
        "maxBackoff": "2s",
        "backoffMultiplier": 2.0,
        "retryableStatusCodes": ["UNAVAILABLE", "NOT_FOUND"]
      },
      "timeout": "3s"
    },
    {
      "name": [{"service": "order.v2.OrderService"}],
      "retryPolicy": {
        "maxAttempts": 4,
        "initialBackoff": "0.1s",
        "maxBackoff": "2s",
        "backoffMultiplier": 2.0,
        "retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
      },
      "timeout": "10s"
    }
  ]
}`
```

### Hedging for Latency Reduction

Hedging issues redundant requests after a deadline, returning the first successful response:

```go
const hedgedServiceConfig = `{
  "loadBalancingConfig": [{"round_robin": {}}],
  "methodConfig": [
    {
      "name": [{"service": "inventory.v1.InventoryService", "method": "CheckStock"}],
      "hedgingPolicy": {
        "maxAttempts": 3,
        "hedgingDelay": "100ms",
        "nonFatalStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
      },
      "timeout": "500ms"
    }
  ]
}`
```

## Resilient Service Client Pattern

```go
// client/order_client.go
package client

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	orderpb "github.com/supporttools/order-service/gen/order/v2"
)

type OrderServiceClient struct {
	conn   *grpc.ClientConn
	client orderpb.OrderServiceClient
	cfg    ConnectionConfig
}

func NewOrderServiceClient(cfg ConnectionConfig) (*OrderServiceClient, error) {
	conn, err := NewServiceConnection(cfg)
	if err != nil {
		return nil, fmt.Errorf("creating order service connection: %w", err)
	}

	return &OrderServiceClient{
		conn:   conn,
		client: orderpb.NewOrderServiceClient(conn),
		cfg:    cfg,
	}, nil
}

func (c *OrderServiceClient) CreateOrder(ctx context.Context, req *orderpb.CreateOrderRequest) (*orderpb.CreateOrderResponse, error) {
	resp, err := c.client.CreateOrder(ctx, req)
	if err != nil {
		return nil, c.wrapError("CreateOrder", err)
	}
	return resp, nil
}

func (c *OrderServiceClient) wrapError(method string, err error) error {
	st, ok := status.FromError(err)
	if !ok {
		return fmt.Errorf("%s: non-gRPC error: %w", method, err)
	}
	switch st.Code() {
	case codes.Unavailable:
		return fmt.Errorf("%s: service unavailable (all retries exhausted): %w", method, err)
	case codes.DeadlineExceeded:
		return fmt.Errorf("%s: deadline exceeded: %w", method, err)
	case codes.ResourceExhausted:
		return fmt.Errorf("%s: rate limited: %w", method, err)
	default:
		return fmt.Errorf("%s: %w", method, err)
	}
}

func (c *OrderServiceClient) Close() error {
	return c.conn.Close()
}

// HealthCheck verifies the connection is functional
func (c *OrderServiceClient) HealthCheck(ctx context.Context) error {
	state := c.conn.GetState()
	if state == connectivity.Shutdown {
		return fmt.Errorf("connection is shut down")
	}
	return nil
}
```

## Custom Least-Connection Load Balancer

Round-robin is sufficient for stateless services, but services with variable request duration benefit from least-connection balancing:

```go
// balancer/leastconn/leastconn.go
package leastconn

import (
	"sync"
	"sync/atomic"

	"google.golang.org/grpc/balancer"
	"google.golang.org/grpc/balancer/base"
)

const Name = "least_conn"

func init() {
	balancer.Register(base.NewBalancerBuilder(Name, &pickerBuilder{}, base.Config{}))
}

type pickerBuilder struct{}

func (*pickerBuilder) Build(info base.PickerBuildInfo) balancer.Picker {
	if len(info.ReadySCs) == 0 {
		return base.NewErrPicker(balancer.ErrNoSubConnAvailable)
	}
	scs := make([]*subConnEntry, 0, len(info.ReadySCs))
	for sc := range info.ReadySCs {
		scs = append(scs, &subConnEntry{SubConn: sc})
	}
	return &picker{subConns: scs}
}

type subConnEntry struct {
	balancer.SubConn
	inflight int64
}

type picker struct {
	mu       sync.Mutex
	subConns []*subConnEntry
}

func (p *picker) Pick(info balancer.PickInfo) (balancer.PickResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Select the SubConn with fewest in-flight requests
	var selected *subConnEntry
	for _, sc := range p.subConns {
		if selected == nil || atomic.LoadInt64(&sc.inflight) < atomic.LoadInt64(&selected.inflight) {
			selected = sc
		}
	}

	atomic.AddInt64(&selected.inflight, 1)
	done := func(info balancer.DoneInfo) {
		atomic.AddInt64(&selected.inflight, -1)
	}

	return balancer.PickResult{SubConn: selected.SubConn, Done: done}, nil
}
```

Use the custom balancer:

```go
import _ "github.com/supporttools/order-client/balancer/leastconn"

const serviceConfig = `{
  "loadBalancingConfig": [{"least_conn": {}}]
}`
```

## Circuit Breaker Integration

Combine client-side load balancing with circuit breaking to prevent cascading failures:

```go
// client/circuit_breaker.go
package client

import (
	"context"
	"fmt"

	"github.com/sony/gobreaker"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type CircuitBreakerOrderClient struct {
	inner   *OrderServiceClient
	breaker *gobreaker.CircuitBreaker
}

func NewCircuitBreakerOrderClient(inner *OrderServiceClient) *CircuitBreakerOrderClient {
	cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{
		Name:        "order-service",
		MaxRequests: 5,  // Half-open state: allow 5 requests
		Interval:    30, // Reset counters every 30 seconds in closed state
		Timeout:     10, // Stay open for 10 seconds after tripping
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
			return counts.Requests >= 10 && failureRatio >= 0.5
		},
		OnStateChange: func(name string, from, to gobreaker.State) {
			fmt.Printf("circuit breaker %s: %s -> %s\n", name, from, to)
		},
		IsSuccessful: func(err error) bool {
			if err == nil {
				return true
			}
			st, ok := status.FromError(err)
			if !ok {
				return false
			}
			// Don't count client errors as failures
			switch st.Code() {
			case codes.InvalidArgument, codes.NotFound, codes.AlreadyExists, codes.PermissionDenied:
				return true
			}
			return false
		},
	})
	return &CircuitBreakerOrderClient{inner: inner, breaker: cb}
}

func (c *CircuitBreakerOrderClient) CreateOrder(ctx context.Context, req *orderpb.CreateOrderRequest) (*orderpb.CreateOrderResponse, error) {
	result, err := c.breaker.Execute(func() (interface{}, error) {
		return c.inner.CreateOrder(ctx, req)
	})
	if err != nil {
		if err == gobreaker.ErrOpenState {
			return nil, status.Error(codes.Unavailable, "circuit breaker open: order-service")
		}
		return nil, err
	}
	return result.(*orderpb.CreateOrderResponse), nil
}
```

## Observability: Metrics and Tracing

### gRPC Interceptors for Observability

```go
// Prometheus metrics interceptor
import (
	grpc_prometheus "github.com/grpc-ecosystem/go-grpc-prometheus"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

conn, err := grpc.NewClient(target,
	grpc.WithTransportCredentials(insecure.NewCredentials()),
	grpc.WithChainUnaryInterceptor(
		// Propagate OpenTelemetry trace context
		otelgrpc.UnaryClientInterceptor(),
		// Collect Prometheus metrics
		grpc_prometheus.UnaryClientInterceptor,
		// Log slow requests
		loggingInterceptor(logger),
	),
	grpc.WithChainStreamInterceptor(
		otelgrpc.StreamClientInterceptor(),
		grpc_prometheus.StreamClientInterceptor,
	),
)
```

### Connection State Monitoring

```go
// Monitor connection state changes for alerting
func monitorConnectionState(conn *grpc.ClientConn, serviceName string) {
	go func() {
		for {
			prev := conn.GetState()
			conn.WaitForStateChange(context.Background(), prev)
			curr := conn.GetState()
			connectionStateGauge.WithLabelValues(serviceName, curr.String()).Set(1)
			connectionStateGauge.WithLabelValues(serviceName, prev.String()).Set(0)
		}
	}()
}

var connectionStateGauge = prometheus.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "grpc_client_connection_state",
		Help: "Current gRPC client connection state.",
	},
	[]string{"service", "state"},
)
```

## Graceful Handling of Rolling Deployments

When services deploy with rolling updates, Consul briefly marks old instances as draining. The resolver must handle this correctly:

```go
// In the Consul resolver, filter out instances in maintenance mode
func filterHealthy(entries []*consulapi.ServiceEntry) []*consulapi.ServiceEntry {
	healthy := make([]*consulapi.ServiceEntry, 0, len(entries))
	for _, e := range entries {
		// Skip instances in maintenance mode
		if e.Service.EnableTagOverride {
			continue
		}
		// Consul health check filter already handles passing/failing
		// but double-check for deregistering instances
		if e.Service.Port == 0 {
			continue
		}
		healthy = append(healthy, e)
	}
	return healthy
}
```

## Complete Main Function Example

```go
// main.go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/supporttools/order-client/consul" // register consul:// scheme

	clientpkg "github.com/supporttools/order-client/client"
	orderpb "github.com/supporttools/order-service/gen/order/v2"
)

func main() {
	cfg := clientpkg.ConnectionConfig{
		ServiceName:   "order-service",
		ConsulAddress: os.Getenv("CONSUL_HTTP_ADDR"),
		TLSEnabled:    false,
		MaxRetries:    3,
		WarmupTimeout: 15 * time.Second,
	}

	client, err := clientpkg.NewOrderServiceClient(cfg)
	if err != nil {
		log.Fatalf("failed to create order service client: %v", err)
	}
	defer client.Close()

	cbClient := clientpkg.NewCircuitBreakerOrderClient(client)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	// Example call
	resp, err := cbClient.CreateOrder(ctx, &orderpb.CreateOrderRequest{
		CustomerId: "cust-001",
		Items: []*orderpb.OrderItem{
			{ProductId: "prod-abc", Quantity: 2},
		},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "create order: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Order created: %s\n", resp.OrderId)
}
```

## Summary

Client-side load balancing in Go with gRPC and Consul provides granular control over traffic distribution, health-aware routing, and failure isolation. The custom Consul name resolver uses Consul's blocking query API for real-time updates without polling overhead. Combined with retry policies, hedging, and circuit breakers, the service client handles all classes of transient failure without exposing callers to infrastructure concerns. Observability through gRPC interceptors provides per-method metrics and distributed tracing that integrate naturally with OpenTelemetry backends.
