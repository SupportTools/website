---
title: "Go gRPC Load Balancing: Client-Side with xDS and Server-Side Strategies"
date: 2029-11-21T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Load Balancing", "xDS", "Envoy", "Service Mesh"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to gRPC load balancing in Go: built-in policies (round_robin, pick_first, least_request), xDS control plane integration, Envoy as xDS server, and production strategies for client-side and server-side load balancing."
more_link: "yes"
url: "/go-grpc-load-balancing-xds-client-side-strategies/"
---

Load balancing gRPC services in production environments requires a different approach than traditional HTTP/1.1 load balancing. Because gRPC multiplexes requests over persistent HTTP/2 connections, a Layer 4 load balancer that distributes TCP connections will send all requests from a given client to a single server — defeating the purpose of horizontal scaling. This guide covers gRPC's client-side load balancing architecture, the built-in balancing policies (round_robin, least_request, pick_first), xDS protocol integration for dynamic service discovery, and Envoy as an xDS control plane and proxy.

<!--more-->

# Go gRPC Load Balancing: Client-Side with xDS and Server-Side Strategies

## Why gRPC Load Balancing Is Different

A traditional load balancer for HTTP/1.1 operates at the connection layer: it receives a TCP connection from a client and forwards it to a backend server. Since each HTTP/1.1 request typically opens a new connection (or uses connection pooling with short-lived connections), request-level load balancing happens naturally.

gRPC uses HTTP/2, which multiplexes many concurrent streams over a single TCP connection. If you put a vanilla L4 load balancer in front of gRPC servers, each gRPC client will establish one long-lived TCP connection to one backend. All of that client's requests go to the same backend — no distribution.

### Solutions

1. **L7 load balancing**: Use a proxy that understands HTTP/2 and can distribute individual gRPC streams across backends. Envoy is the dominant choice. The proxy adds latency overhead.

2. **Client-side load balancing**: The gRPC client itself maintains connections to multiple backends and distributes requests across them. No proxy overhead, but requires the client to discover backend addresses.

3. **Lookaside load balancing**: A separate load balancer service (not in the data path) tells clients which backend to use for each request. The client connects directly to the chosen backend.

## gRPC Client Architecture for Load Balancing

The gRPC Go client's load balancing is built around three abstraction layers:

**Resolver**: Discovers the current set of server addresses for a given service name. The resolver watches for changes and notifies the balancer when the set changes. Built-in resolvers include DNS, passthrough (single address), and xDS.

**Balancer (Load Balancer Policy)**: Receives the address list from the resolver and decides which SubConn (connection to a specific backend) to use for each RPC. It also manages when to connect and reconnect.

**SubConn**: A connection to a single backend server. The balancer may maintain multiple SubConns and pick among them.

```
gRPC Client
    |
    |  Dial("my-service")
    v
Resolver (DNS / xDS / custom)
    |  Returns: [10.0.1.1:9090, 10.0.1.2:9090, 10.0.1.3:9090]
    v
Balancer (round_robin / least_request / custom)
    |  Manages: SubConn1→10.0.1.1, SubConn2→10.0.1.2, SubConn3→10.0.1.3
    v
Pick (for each RPC)
    |  Returns: SubConn2
    v
RPC sent to 10.0.1.2:9090
```

## Built-In Load Balancing Policies

### pick_first (Default)

`pick_first` connects to the first address in the resolver's list and sends all RPCs to it. If that address fails, it tries the next. This is the default policy when no other is specified.

```go
import (
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    _ "google.golang.org/grpc/balancer/pickfirst" // imported for side effects
)

// pick_first is the default — no explicit configuration needed
conn, err := grpc.Dial(
    "localhost:9090",
    grpc.WithTransportCredentials(insecure.NewCredentials()),
)

// Explicit service config to use pick_first
conn, err = grpc.Dial(
    "my-service:9090",
    grpc.WithTransportCredentials(insecure.NewCredentials()),
    grpc.WithDefaultServiceConfig(`{"loadBalancingPolicy":"pick_first"}`),
)
```

**When to use**: Single-server connections, services where connection affinity matters, or services where round-robin would be counterproductive (stateful sessions without server-side session management).

### round_robin

`round_robin` distributes RPCs evenly across all healthy backends. It maintains a SubConn to every address in the resolver's list and cycles through them.

```go
import (
    "google.golang.org/grpc"
    _ "google.golang.org/grpc/balancer/roundrobin" // imported for side effects
    "google.golang.org/grpc/credentials/insecure"
)

conn, err := grpc.Dial(
    "dns:///payment-service.production.svc.cluster.local:9090",
    grpc.WithTransportCredentials(insecure.NewCredentials()),
    grpc.WithDefaultServiceConfig(`{"loadBalancingPolicy":"round_robin"}`),
)
```

**DNS resolver for Kubernetes**: In Kubernetes, `dns:///service.namespace.svc.cluster.local:port` resolves to a list of Pod IPs (when using headless services), enabling round_robin distribution across pods.

```yaml
# Kubernetes headless service for gRPC load balancing
apiVersion: v1
kind: Service
metadata:
  name: payment-service
  namespace: production
spec:
  clusterIP: None      # Headless: DNS returns pod IPs, not VIP
  selector:
    app: payment-service
  ports:
    - port: 9090
      targetPort: 9090
      protocol: TCP
```

```go
// Client configuration for headless service load balancing
func NewPaymentServiceClient() (pb.PaymentServiceClient, error) {
    // dns:/// prefix tells gRPC to use the DNS resolver
    // The DNS resolver will return all Pod IPs for the headless service
    target := "dns:///payment-service.production.svc.cluster.local:9090"

    conn, err := grpc.Dial(
        target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultServiceConfig(`{
            "loadBalancingPolicy": "round_robin",
            "methodConfig": [{
                "name": [{"service": "payment.v1.PaymentService"}],
                "retryPolicy": {
                    "maxAttempts": 3,
                    "initialBackoff": "0.1s",
                    "maxBackoff": "1s",
                    "backoffMultiplier": 2,
                    "retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
                },
                "timeout": "10s"
            }]
        }`),
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second,
            Timeout:             5 * time.Second,
            PermitWithoutStream: true,
        }),
    )

    if err != nil {
        return nil, fmt.Errorf("dialing payment service: %w", err)
    }

    return pb.NewPaymentServiceClient(conn), nil
}
```

### least_request (Weighted Round Robin variant)

`least_request` is available as an experimental balancer. It tracks in-flight RPCs per SubConn and routes new RPCs to the backend with the fewest active requests, reducing head-of-line blocking on slow backends.

```go
import (
    "google.golang.org/grpc"
    _ "google.golang.org/grpc/balancer/leastrequest" // experimental
)

conn, err := grpc.Dial(
    "dns:///my-service.prod:9090",
    grpc.WithTransportCredentials(insecure.NewCredentials()),
    grpc.WithDefaultServiceConfig(`{
        "loadBalancingPolicy": "least_request_experimental",
        "loadBalancingConfig": [{
            "least_request_experimental": {
                "choiceCount": 2
            }
        }]
    }`),
)
```

The `choiceCount` parameter implements the "power of two choices" algorithm: pick 2 random SubConns, route to the one with fewer in-flight requests. This provides near-optimal distribution with much lower coordination overhead than true least-request.

### Weighted Round Robin

```go
// Weighted round robin via service config
// (server must send load reports via ORCA or similar)
conn, err := grpc.Dial(
    "xds:///my-service",
    grpc.WithTransportCredentials(insecure.NewCredentials()),
    grpc.WithDefaultServiceConfig(`{
        "loadBalancingConfig": [{
            "weighted_round_robin": {
                "enableOobLoadReport": true,
                "oobReportingPeriod": "0.1s",
                "blackoutPeriod": "1s",
                "weightExpirationPeriod": "3s",
                "weightUpdatePeriod": "1s"
            }
        }]
    }`),
)
```

## Custom Resolver

When DNS is insufficient (e.g., service registry via etcd or Consul), implement a custom resolver:

```go
// internal/resolver/consul_resolver.go
package resolver

import (
    "context"
    "fmt"
    "sync"
    "time"

    "google.golang.org/grpc/resolver"
    consul "github.com/hashicorp/consul/api"
)

const ConsulScheme = "consul"

// Register the resolver with gRPC
func init() {
    resolver.Register(&ConsulResolverBuilder{})
}

type ConsulResolverBuilder struct{}

func (b *ConsulResolverBuilder) Build(
    target resolver.Target,
    cc resolver.ClientConn,
    opts resolver.BuildOptions,
) (resolver.Resolver, error) {
    client, err := consul.NewClient(consul.DefaultConfig())
    if err != nil {
        return nil, fmt.Errorf("creating consul client: %w", err)
    }

    r := &consulResolver{
        serviceName: target.Endpoint(),
        cc:          cc,
        client:      client,
        ctx:         context.Background(),
    }
    r.ctx, r.cancel = context.WithCancel(context.Background())

    go r.watch()
    return r, nil
}

func (b *ConsulResolverBuilder) Scheme() string {
    return ConsulScheme
}

type consulResolver struct {
    serviceName string
    cc          resolver.ClientConn
    client      *consul.Client
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

        entries, meta, err := r.client.Health().Service(
            r.serviceName, "", true,
            &consul.QueryOptions{
                WaitIndex: r.lastIndex,
                WaitTime:  30 * time.Second,
                Context:   r.ctx,
            },
        )

        if err != nil {
            if r.ctx.Err() != nil {
                return
            }
            r.cc.ReportError(fmt.Errorf("consul watch error: %w", err))
            time.Sleep(5 * time.Second)
            continue
        }

        r.lastIndex = meta.LastIndex

        var addrs []resolver.Address
        for _, entry := range entries {
            addr := fmt.Sprintf("%s:%d",
                entry.Service.Address, entry.Service.Port)
            addrs = append(addrs, resolver.Address{
                Addr:       addr,
                ServerName: entry.Service.ID,
                Attributes: nil,
            })
        }

        r.cc.UpdateState(resolver.State{Addresses: addrs})
    }
}

func (r *consulResolver) ResolveNow(resolver.ResolveNowOptions) {}
func (r *consulResolver) Close() { r.cancel() }
```

```go
// Usage
import _ "github.com/myorg/myservice/internal/resolver"

conn, err := grpc.Dial(
    "consul:///payment-service",  // consul:///service-name
    grpc.WithTransportCredentials(insecure.NewCredentials()),
    grpc.WithDefaultServiceConfig(`{"loadBalancingPolicy":"round_robin"}`),
)
```

## xDS Protocol: Dynamic Service Discovery

xDS (originally "x Discovery Service") is a set of APIs developed for Envoy that allow a control plane to dynamically configure load balancers, routes, and clusters. gRPC has implemented the xDS client protocol in Go, allowing gRPC clients to act as xDS clients without an Envoy proxy in the data path.

### xDS API Surface

| API | Description |
|-----|-------------|
| LDS (Listener Discovery Service) | Virtual listener configuration |
| RDS (Route Discovery Service) | HTTP routing rules |
| CDS (Cluster Discovery Service) | Backend cluster definitions |
| EDS (Endpoint Discovery Service) | Backend instance addresses |
| SDS (Secret Discovery Service) | TLS certificates |

### gRPC xDS Client Setup

```go
import (
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    _ "google.golang.org/grpc/xds" // Register xDS resolvers and balancers
    xdscreds "google.golang.org/grpc/credentials/xds"
)

func NewXDSClient(serviceName string) (*grpc.ClientConn, error) {
    // xds:/// scheme triggers the xDS resolver
    // The xDS bootstrap config tells the client where to find the control plane
    // Bootstrap config is read from GRPC_XDS_BOOTSTRAP env var
    // or GRPC_XDS_BOOTSTRAP_CONFIG for inline JSON

    conn, err := grpc.Dial(
        fmt.Sprintf("xds:///%s", serviceName),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )

    return conn, err
}
```

### xDS Bootstrap Configuration

```json
// /etc/grpc/xds_bootstrap.json
// (set GRPC_XDS_BOOTSTRAP=/etc/grpc/xds_bootstrap.json)
{
  "xds_servers": [
    {
      "server_uri": "xds-control-plane.prod.internal:443",
      "channel_creds": [
        {
          "type": "google_default"
        }
      ],
      "server_features": ["xds_v3"]
    }
  ],
  "node": {
    "id": "payment-service-grpc-client",
    "cluster": "payment-service",
    "locality": {
      "region": "us-east-1",
      "zone": "us-east-1a"
    },
    "metadata": {
      "version": "2.0"
    }
  },
  "certificate_providers": {
    "default": {
      "plugin_instance_name": "file_watcher",
      "plugin_config": {
        "certificate_file": "/etc/certs/tls.crt",
        "private_key_file": "/etc/certs/tls.key",
        "ca_certificate_file": "/etc/certs/ca.crt",
        "refresh_interval": "600s"
      }
    }
  },
  "authorities": {
    "traffic-director.googleapis.com": {
      "xds_servers": [
        {
          "server_uri": "trafficdirector.googleapis.com:443",
          "channel_creds": [{"type": "google_default"}],
          "server_features": ["xds_v3"]
        }
      ]
    }
  }
}
```

## Envoy as xDS Server

Envoy can act as both an xDS client (receiving config from a management plane) and as a side-process L7 proxy for gRPC services.

### Envoy as gRPC Proxy (L7 Load Balancing)

```yaml
# envoy-grpc-proxy.yaml
static_resources:
  listeners:
    - name: grpc_listener
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 8080
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                codec_type: AUTO
                stat_prefix: ingress_grpc
                route_config:
                  name: local_route
                  virtual_hosts:
                    - name: payment_service
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/payment.v1.PaymentService/"
                          route:
                            cluster: payment_service_cluster
                            timeout: 30s
                            # gRPC deadline passthrough
                            max_stream_duration:
                              grpc_timeout_header_max: 0s
                http_filters:
                  # gRPC-specific filters
                  - name: envoy.filters.http.grpc_stats
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.grpc_stats.v3.FilterConfig
                      emit_filter_state: true
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

  clusters:
    - name: payment_service_cluster
      connect_timeout: 1s
      type: STRICT_DNS
      lb_policy: LEAST_REQUEST
      http2_protocol_options: {}  # Enable HTTP/2 for gRPC backend
      load_assignment:
        cluster_name: payment_service_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: payment-service.production.svc.cluster.local
                      port_value: 9090
      health_checks:
        - timeout: 1s
          interval: 10s
          unhealthy_threshold: 3
          healthy_threshold: 2
          grpc_health_check:
            service_name: "payment.v1.PaymentService"
      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 1000
            max_pending_requests: 500
            max_requests: 5000
```

### Envoy xDS Management Plane (Simple Go Implementation)

```go
// cmd/xds-server/main.go
// Minimal xDS v3 server that serves EDS (endpoint discovery)

package main

import (
    "context"
    "fmt"
    "net"
    "sync"
    "time"

    cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
    serverv3 "github.com/envoyproxy/go-control-plane/pkg/server/v3"
    testv3 "github.com/envoyproxy/go-control-plane/pkg/test/v3"

    clusterv3 "github.com/envoyproxy/go-control-plane/envoy/config/cluster/v3"
    corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
    endpointv3 "github.com/envoyproxy/go-control-plane/envoy/config/endpoint/v3"
    listenerv3 "github.com/envoyproxy/go-control-plane/envoy/config/listener/v3"
    routev3 "github.com/envoyproxy/go-control-plane/envoy/config/route/v3"

    "github.com/envoyproxy/go-control-plane/pkg/resource/v3"
    "google.golang.org/grpc"
    "google.golang.org/protobuf/types/known/wrapperspb"
)

func makeEndpoints(serviceName string, addrs []string) *endpointv3.ClusterLoadAssignment {
    var lbEndpoints []*endpointv3.LbEndpoint
    for _, addr := range addrs {
        host, portStr, _ := net.SplitHostPort(addr)
        port, _ := strconv.Atoi(portStr)

        lbEndpoints = append(lbEndpoints, &endpointv3.LbEndpoint{
            HostIdentifier: &endpointv3.LbEndpoint_Endpoint{
                Endpoint: &endpointv3.Endpoint{
                    Address: &corev3.Address{
                        Address: &corev3.Address_SocketAddress{
                            SocketAddress: &corev3.SocketAddress{
                                Address:  host,
                                Protocol: corev3.SocketAddress_TCP,
                                PortSpecifier: &corev3.SocketAddress_PortValue{
                                    PortValue: uint32(port),
                                },
                            },
                        },
                    },
                },
            },
        })
    }

    return &endpointv3.ClusterLoadAssignment{
        ClusterName: serviceName,
        Endpoints: []*endpointv3.LocalityLbEndpoints{
            {
                Locality: &corev3.Locality{
                    Region: "us-east-1",
                    Zone:   "us-east-1a",
                },
                LbEndpoints: lbEndpoints,
                LoadBalancingWeight: &wrapperspb.UInt32Value{Value: 100},
            },
        },
    }
}

type XDSServer struct {
    cache   cachev3.SnapshotCache
    version int64
    mu      sync.Mutex
}

func NewXDSServer() *XDSServer {
    cache := cachev3.NewSnapshotCache(false, cachev3.IDHash{}, nil)
    return &XDSServer{cache: cache}
}

func (s *XDSServer) UpdateEndpoints(nodeID, serviceName string, addrs []string) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.version++

    snap, _ := cachev3.NewSnapshot(
        fmt.Sprintf("%d", s.version),
        map[resource.Type][]cachev3.Resource{
            resource.EndpointType: {makeEndpoints(serviceName, addrs)},
        },
    )

    return s.cache.SetSnapshot(context.Background(), nodeID, snap)
}

func main() {
    srv := NewXDSServer()

    // Initial configuration
    srv.UpdateEndpoints("payment-service-client", "payment_service_cluster", []string{
        "10.0.1.1:9090",
        "10.0.1.2:9090",
        "10.0.1.3:9090",
    })

    // Start xDS gRPC server
    grpcServer := grpc.NewServer()
    xdsServer := serverv3.NewServer(context.Background(), srv.cache, nil)

    // Register all discovery services
    // (EDS, CDS, LDS, RDS, SDS, ADS)
    testv3.RegisterServer(grpcServer, xdsServer)

    lis, _ := net.Listen("tcp", ":18000")
    fmt.Println("xDS server listening on :18000")
    grpcServer.Serve(lis)
}
```

## Service Mesh Integration: Istio

In an Istio service mesh, gRPC load balancing is handled by the Envoy sidecar injected into each pod. No client-side configuration is needed — Istio's control plane (Istiod) acts as the xDS control plane for all Envoy sidecars.

```yaml
# VirtualService for gRPC traffic splitting (canary deployment)
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-service
  namespace: production
spec:
  hosts:
    - payment-service.production.svc.cluster.local
  http:
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: payment-service
            subset: canary
          weight: 100
    - route:
        - destination:
            host: payment-service
            subset: stable
          weight: 90
        - destination:
            host: payment-service
            subset: canary
          weight: 10

---
# DestinationRule for load balancing policy
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payment-service
  namespace: production
spec:
  host: payment-service.production.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      simple: LEAST_CONN  # Least connections (approximate least request)
    connectionPool:
      http:
        h2UpgradePolicy: UPGRADE  # Use HTTP/2 for gRPC
        http2MaxRequests: 1000
        maxRequestsPerConnection: 0  # No limit
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
  subsets:
    - name: stable
      labels:
        version: stable
    - name: canary
      labels:
        version: canary
```

## Health Checking and Circuit Breaking

```go
// gRPC health protocol implementation for load balancer health checks
package health

import (
    "context"

    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc"
)

func RegisterHealthServer(server *grpc.Server, serviceName string) *health.Server {
    healthServer := health.NewServer()

    // Set initial status
    healthServer.SetServingStatus(
        serviceName,
        grpc_health_v1.HealthCheckResponse_SERVING,
    )
    healthServer.SetServingStatus(
        "",  // Empty string = overall server health
        grpc_health_v1.HealthCheckResponse_SERVING,
    )

    grpc_health_v1.RegisterHealthServer(server, healthServer)
    return healthServer
}

// Mark service as not serving during graceful shutdown
func GracefulShutdown(healthServer *health.Server, serviceName string) {
    healthServer.SetServingStatus(
        serviceName,
        grpc_health_v1.HealthCheckResponse_NOT_SERVING,
    )
}
```

## Retry and Hedging Policies

```go
// Service config with retry and hedging policies
// (These work with any load balancing policy)
const serviceConfig = `{
    "methodConfig": [
        {
            "name": [
                {"service": "payment.v1.PaymentService", "method": "GetPayment"},
                {"service": "payment.v1.PaymentService", "method": "ListPayments"}
            ],
            "retryPolicy": {
                "maxAttempts": 3,
                "initialBackoff": "0.1s",
                "maxBackoff": "2s",
                "backoffMultiplier": 2.0,
                "retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
            },
            "timeout": "10s"
        },
        {
            "name": [
                {"service": "payment.v1.PaymentService", "method": "CreatePayment"}
            ],
            "retryPolicy": {
                "maxAttempts": 2,
                "initialBackoff": "0.5s",
                "maxBackoff": "5s",
                "backoffMultiplier": 2.0,
                "retryableStatusCodes": ["UNAVAILABLE"]
            },
            "timeout": "30s"
        },
        {
            "name": [
                {"service": "latency.v1.SearchService", "method": "Search"}
            ],
            "hedgingPolicy": {
                "maxAttempts": 3,
                "hedgingDelay": "50ms",
                "nonFatalStatusCodes": ["UNAVAILABLE", "INTERNAL"]
            },
            "timeout": "5s"
        }
    ]
}`
```

## Monitoring Load Balancing

```go
// Observe pick outcomes for monitoring
import (
    "google.golang.org/grpc/stats"
)

type LBStatsHandler struct{}

func (h *LBStatsHandler) TagConn(ctx context.Context,
    info *stats.ConnTagInfo) context.Context {
    return ctx
}

func (h *LBStatsHandler) HandleConn(ctx context.Context, s stats.ConnStats) {
    switch s.(type) {
    case *stats.ConnBegin:
        lbConnectionsTotal.With(prometheus.Labels{
            "remote_addr": s.(*stats.ConnBegin).RemoteAddr.String(),
        }).Inc()
    }
}

func (h *LBStatsHandler) TagRPC(ctx context.Context,
    info *stats.RPCTagInfo) context.Context {
    return ctx
}

func (h *LBStatsHandler) HandleRPC(ctx context.Context, s stats.RPCStats) {
    switch rpc := s.(type) {
    case *stats.End:
        if rpc.Error != nil {
            lbErrorsTotal.Inc()
        }
    }
}
```

## Choosing the Right Strategy

| Strategy | Pros | Cons | When to Use |
|----------|------|------|-------------|
| Client-side round_robin (DNS) | No proxy overhead, simple | Client must handle DNS refresh | Internal services in Kubernetes |
| Client-side xDS | Dynamic, supports advanced policies | Complex setup | Large service meshes, GCP Traffic Director |
| Envoy sidecar (Istio) | Transparent, feature-rich | Sidecar overhead, ops complexity | Full service mesh environments |
| Envoy proxy (standalone) | L7 LB, retries, circuit breaking | Single proxy is a bottleneck | Edge/ingress, external-facing gRPC |
| Server-side (K8s Service VIP) | Simple, zero client changes | L4 only, uneven distribution | Small deployments, quick start |

## Summary

gRPC load balancing in production requires moving beyond simple TCP load balancers. Client-side load balancing with round_robin over headless Kubernetes services is the simplest effective approach for most deployments. For more sophisticated needs, xDS provides a standards-based protocol for dynamic configuration that works with both Envoy proxies and gRPC-native clients. The key insight is that gRPC's pluggable resolver and balancer architecture allows you to adopt any of these strategies incrementally, moving from DNS round_robin to xDS-based control planes as your operational maturity grows.
