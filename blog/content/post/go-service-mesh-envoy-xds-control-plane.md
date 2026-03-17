---
title: "Go Service Mesh Integration: Envoy xDS API, Control Plane Development, and Dynamic Configuration"
date: 2030-01-24T00:00:00-05:00
draft: false
tags: ["Go", "Envoy", "xDS", "Service Mesh", "Control Plane", "gRPC", "Kubernetes"]
categories: ["Go", "Service Mesh", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Build custom Envoy control planes in Go using go-control-plane, implement xDS v3 API, configure dynamic routes, clusters, and listeners, and manage incremental xDS for large-scale service mesh deployments."
more_link: "yes"
url: "/go-service-mesh-envoy-xds-control-plane/"
---

Building a custom Envoy control plane gives your organization full ownership over service mesh behavior — traffic routing, load balancing, TLS configuration, and retries — without being constrained by the defaults of Istio, Linkerd, or Consul Connect. The xDS API (Discovery Service) is the protocol that makes this possible: a gRPC-based bidirectional streaming interface through which control planes push configuration snapshots to Envoy sidecars at runtime, with no proxy restart required.

This guide covers building production-grade Envoy control planes in Go using the `go-control-plane` library, implementing xDS v3 resources (LDS, RDS, CDS, EDS), incremental xDS for large fleets, and integrating dynamic service discovery from Kubernetes.

<!--more-->

## Understanding the xDS API Architecture

Envoy's data plane API (xDS) separates configuration from execution. Instead of static config files, Envoy connects to a Management Server (the control plane) and receives configuration through four primary discovery services:

- **LDS (Listener Discovery Service)**: Defines how Envoy accepts inbound connections (ports, filters)
- **RDS (Route Discovery Service)**: HTTP routing rules, virtual hosts, retry policies
- **CDS (Cluster Discovery Service)**: Upstream service definitions, load balancing config
- **EDS (Endpoint Discovery Service)**: The actual IP:port endpoints for each cluster

Aggregated Discovery Service (ADS) bundles all four over a single gRPC stream, which is the recommended approach for consistency — all resources arrive in a single ordered update.

### xDS v3 Resource Hierarchy

```
Listener (LDS)
  └── FilterChain
        └── HttpConnectionManager
              └── RouteConfiguration (RDS)
                    └── VirtualHost
                          └── Route → Cluster (CDS)
                                        └── LoadAssignment → Endpoints (EDS)
```

### State-of-the-World vs Incremental xDS

Two xDS variants exist:

- **SotW (State-of-the-World)**: Each response contains the full set of resources. Simpler but expensive at scale (10k+ clusters).
- **Delta xDS (Incremental)**: Only changed resources are sent. Essential for large deployments.

This guide implements both.

## Setting Up the Go Control Plane Project

### Module Initialization and Dependencies

```bash
mkdir envoy-control-plane && cd envoy-control-plane
go mod init github.com/yourorg/envoy-control-plane

go get github.com/envoyproxy/go-control-plane@v0.13.0
go get google.golang.org/grpc@v1.62.0
go get google.golang.org/protobuf@v1.33.0
go get k8s.io/client-go@v0.29.2
go get sigs.k8s.io/controller-runtime@v0.17.2
```

### Project Layout

```
envoy-control-plane/
├── cmd/
│   └── server/
│       └── main.go
├── pkg/
│   ├── snapshot/
│   │   ├── builder.go
│   │   └── cache.go
│   ├── xds/
│   │   ├── server.go
│   │   └── callbacks.go
│   ├── discovery/
│   │   ├── kubernetes.go
│   │   └── reconciler.go
│   └── resources/
│       ├── listener.go
│       ├── route.go
│       ├── cluster.go
│       └── endpoint.go
├── config/
│   └── envoy-bootstrap.yaml
└── deploy/
    └── k8s/
```

## Implementing the xDS Cache and Snapshot Manager

The snapshot cache is the heart of the control plane. It stores per-node configuration and serves it to Envoy instances.

### pkg/snapshot/cache.go

```go
package snapshot

import (
	"context"
	"fmt"
	"sync"
	"time"

	cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	resourcev3 "github.com/envoyproxy/go-control-plane/pkg/resource/v3"
	"go.uber.org/zap"
)

// Manager manages xDS snapshots for Envoy nodes.
type Manager struct {
	cache  cachev3.SnapshotCache
	mu     sync.RWMutex
	logger *zap.Logger

	// version counter per node group
	versions map[string]uint64
}

// NewManager creates a new snapshot manager.
// ads=true means all resource types are served via ADS (single stream).
func NewManager(logger *zap.Logger) *Manager {
	// true = ADS mode, hash function for node IDs
	cache := cachev3.NewSnapshotCache(true, cachev3.IDHash{}, logger.Sugar())
	return &Manager{
		cache:    cache,
		logger:   logger,
		versions: make(map[string]uint64),
	}
}

// Cache returns the underlying snapshot cache for use with the gRPC server.
func (m *Manager) Cache() cachev3.SnapshotCache {
	return m.cache
}

// UpdateSnapshot atomically updates the xDS snapshot for a node group.
// nodeID is typically the Envoy node cluster (e.g., "production").
func (m *Manager) UpdateSnapshot(ctx context.Context, nodeID string, resources *Resources) error {
	m.mu.Lock()
	m.versions[nodeID]++
	version := fmt.Sprintf("v%d-%d", m.versions[nodeID], time.Now().UnixNano())
	m.mu.Unlock()

	snapshot, err := cachev3.NewSnapshot(version,
		map[resourcev3.Type][]cachev3.Resource{
			resourcev3.ListenerType: resources.Listeners,
			resourcev3.RouteType:    resources.Routes,
			resourcev3.ClusterType:  resources.Clusters,
			resourcev3.EndpointType: resources.Endpoints,
		},
	)
	if err != nil {
		return fmt.Errorf("building snapshot for node %s: %w", nodeID, err)
	}

	if err := snapshot.Consistent(); err != nil {
		return fmt.Errorf("snapshot inconsistency for node %s: %w", nodeID, err)
	}

	if err := m.cache.SetSnapshot(ctx, nodeID, snapshot); err != nil {
		return fmt.Errorf("setting snapshot for node %s: %w", nodeID, err)
	}

	m.logger.Info("snapshot updated",
		zap.String("node_id", nodeID),
		zap.String("version", version),
		zap.Int("listeners", len(resources.Listeners)),
		zap.Int("clusters", len(resources.Clusters)),
		zap.Int("endpoints", len(resources.Endpoints)),
	)
	return nil
}

// Resources holds all xDS resources for a snapshot.
type Resources struct {
	Listeners []cachev3.Resource
	Routes    []cachev3.Resource
	Clusters  []cachev3.Resource
	Endpoints []cachev3.Resource
}
```

### pkg/snapshot/builder.go

```go
package snapshot

import (
	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	endpointv3 "github.com/envoyproxy/go-control-plane/envoy/config/endpoint/v3"
	listenerv3 "github.com/envoyproxy/go-control-plane/envoy/config/listener/v3"
	routev3 "github.com/envoyproxy/go-control-plane/envoy/config/route/v3"
	hcmv3 "github.com/envoyproxy/go-control-plane/envoy/extensions/filters/network/http_connection_manager/v3"
	cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/yourorg/envoy-control-plane/pkg/resources"
)

// Builder constructs xDS Resources from service discovery data.
type Builder struct{}

// NewBuilder creates a snapshot builder.
func NewBuilder() *Builder {
	return &Builder{}
}

// ServiceConfig represents a discovered service.
type ServiceConfig struct {
	Name      string
	Namespace string
	Port      uint32
	Endpoints []EndpointConfig
	TLSEnabled bool
}

// EndpointConfig represents an individual endpoint.
type EndpointConfig struct {
	Address string
	Port    uint32
	Weight  uint32
	Zone    string
}

// Build constructs a complete Resources snapshot from service configs.
func (b *Builder) Build(services []ServiceConfig) (*Resources, error) {
	r := &Resources{}

	for _, svc := range services {
		// Build cluster
		cluster, err := resources.BuildCluster(svc.Name, svc.TLSEnabled)
		if err != nil {
			return nil, err
		}
		r.Clusters = append(r.Clusters, cluster)

		// Build endpoint load assignment
		ela := resources.BuildEndpointLoadAssignment(svc.Name, svc.Endpoints)
		r.Endpoints = append(r.Endpoints, ela)
	}

	// Build the main ingress listener with route config
	routeConfig := buildRouteConfig("local_route", services)
	r.Routes = append(r.Routes, routeConfig)

	listener, err := buildHTTPListener("listener_0", 10000, "local_route")
	if err != nil {
		return nil, err
	}
	r.Listeners = append(r.Listeners, listener)

	return r, nil
}

func buildRouteConfig(name string, services []ServiceConfig) cachev3.Resource {
	var virtualHosts []*routev3.VirtualHost

	for _, svc := range services {
		vh := &routev3.VirtualHost{
			Name:    svc.Name,
			Domains: []string{svc.Name, svc.Name + "." + svc.Namespace + ".svc.cluster.local"},
			Routes: []*routev3.Route{
				{
					Match: &routev3.RouteMatch{
						PathSpecifier: &routev3.RouteMatch_Prefix{Prefix: "/"},
					},
					Action: &routev3.Route_Route{
						Route: &routev3.RouteAction{
							ClusterSpecifier: &routev3.RouteAction_Cluster{
								Cluster: svc.Name,
							},
							Timeout: durationpb.New(15 * 1e9), // 15s in nanoseconds
							RetryPolicy: &routev3.RetryPolicy{
								RetryOn:    "5xx,reset,connect-failure",
								NumRetries: wrapperspb.UInt32(3),
								PerTryTimeout: durationpb.New(5 * 1e9),
							},
						},
					},
				},
			},
		}
		virtualHosts = append(virtualHosts, vh)
	}

	return &routev3.RouteConfiguration{
		Name:         name,
		VirtualHosts: virtualHosts,
	}
}

func buildHTTPListener(name string, port uint32, routeConfigName string) (cachev3.Resource, error) {
	hcm := &hcmv3.HttpConnectionManager{
		StatPrefix: "ingress_http",
		RouteSpecifier: &hcmv3.HttpConnectionManager_Rds{
			Rds: &hcmv3.Rds{
				RouteConfigName: routeConfigName,
				ConfigSource: &corev3.ConfigSource{
					ResourceApiVersion: corev3.ApiVersion_V3,
					ConfigSourceSpecifier: &corev3.ConfigSource_Ads{
						Ads: &corev3.AggregatedConfigSource{},
					},
				},
			},
		},
		HttpFilters: []*hcmv3.HttpFilter{
			{
				Name: "envoy.filters.http.router",
				ConfigType: &hcmv3.HttpFilter_TypedConfig{
					TypedConfig: mustAny(&routerv3.Router{}),
				},
			},
		},
		AccessLog: buildAccessLog(),
	}

	hcmAny, err := anypb.New(hcm)
	if err != nil {
		return nil, fmt.Errorf("marshaling HCM: %w", err)
	}

	return &listenerv3.Listener{
		Name: name,
		Address: &corev3.Address{
			Address: &corev3.Address_SocketAddress{
				SocketAddress: &corev3.SocketAddress{
					Protocol: corev3.SocketAddress_TCP,
					Address:  "0.0.0.0",
					PortSpecifier: &corev3.SocketAddress_PortValue{
						PortValue: port,
					},
				},
			},
		},
		FilterChains: []*listenerv3.FilterChain{
			{
				Filters: []*listenerv3.Filter{
					{
						Name:       "envoy.filters.network.http_connection_manager",
						ConfigType: &listenerv3.Filter_TypedConfig{TypedConfig: hcmAny},
					},
				},
			},
		},
	}, nil
}
```

## Building xDS Resource Constructors

### pkg/resources/cluster.go

```go
package resources

import (
	"fmt"
	"time"

	clusterv3 "github.com/envoyproxy/go-control-plane/envoy/config/cluster/v3"
	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	tlsv3 "github.com/envoyproxy/go-control-plane/envoy/extensions/transport_sockets/tls/v3"
	cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/durationpb"
)

// BuildCluster creates an EDS-backed cluster resource.
func BuildCluster(name string, tlsEnabled bool) (cachev3.Resource, error) {
	cluster := &clusterv3.Cluster{
		Name:                 name,
		ConnectTimeout:       durationpb.New(5 * time.Second),
		ClusterDiscoveryType: &clusterv3.Cluster_Type{Type: clusterv3.Cluster_EDS},
		EdsClusterConfig: &clusterv3.Cluster_EdsClusterConfig{
			EdsConfig: &corev3.ConfigSource{
				ResourceApiVersion: corev3.ApiVersion_V3,
				ConfigSourceSpecifier: &corev3.ConfigSource_Ads{
					Ads: &corev3.AggregatedConfigSource{},
				},
			},
			ServiceName: name,
		},
		LbPolicy: clusterv3.Cluster_LEAST_REQUEST,
		CircuitBreakers: &clusterv3.CircuitBreakers{
			Thresholds: []*clusterv3.CircuitBreakers_Thresholds{
				{
					Priority:           corev3.RoutingPriority_DEFAULT,
					MaxConnections:     wrapperspb.UInt32(1024),
					MaxPendingRequests: wrapperspb.UInt32(1024),
					MaxRequests:        wrapperspb.UInt32(1024),
					MaxRetries:         wrapperspb.UInt32(3),
				},
			},
		},
		OutlierDetection: &clusterv3.OutlierDetection{
			Consecutive_5Xx:                    wrapperspb.UInt32(5),
			Interval:                           durationpb.New(10 * time.Second),
			BaseEjectionTime:                   durationpb.New(30 * time.Second),
			MaxEjectionPercent:                 wrapperspb.UInt32(50),
			ConsecutiveGatewayFailure:          wrapperspb.UInt32(3),
			EnforcingConsecutiveGatewayFailure: wrapperspb.UInt32(100),
		},
	}

	if tlsEnabled {
		tlsContext := &tlsv3.UpstreamTlsContext{
			CommonTlsContext: &tlsv3.CommonTlsContext{
				TlsParams: &tlsv3.TlsParameters{
					TlsMinimumProtocolVersion: tlsv3.TlsParameters_TLSv1_3,
				},
				ValidationContextType: &tlsv3.CommonTlsContext_ValidationContext{
					ValidationContext: &tlsv3.CertificateValidationContext{
						TrustedCa: &corev3.DataSource{
							Specifier: &corev3.DataSource_Filename{
								Filename: "/etc/ssl/certs/ca-certificates.crt",
							},
						},
					},
				},
			},
		}
		tlsAny, err := anypb.New(tlsContext)
		if err != nil {
			return nil, fmt.Errorf("marshaling TLS context: %w", err)
		}
		cluster.TransportSocket = &corev3.TransportSocket{
			Name: "envoy.transport_sockets.tls",
			ConfigType: &corev3.TransportSocket_TypedConfig{
				TypedConfig: tlsAny,
			},
		}
	}

	return cluster, nil
}
```

### pkg/resources/endpoint.go

```go
package resources

import (
	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	endpointv3 "github.com/envoyproxy/go-control-plane/envoy/config/endpoint/v3"
	cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// EndpointInfo holds endpoint connection details.
type EndpointInfo struct {
	Address string
	Port    uint32
	Weight  uint32
	Zone    string
}

// BuildEndpointLoadAssignment creates a ClusterLoadAssignment from endpoint info.
// Endpoints are grouped by zone for locality-aware load balancing.
func BuildEndpointLoadAssignment(clusterName string, endpoints []EndpointInfo) cachev3.Resource {
	// Group endpoints by zone
	zoneMap := make(map[string][]*endpointv3.LbEndpoint)
	for _, ep := range endpoints {
		zone := ep.Zone
		if zone == "" {
			zone = "default"
		}
		weight := ep.Weight
		if weight == 0 {
			weight = 1
		}
		lbEndpoint := &endpointv3.LbEndpoint{
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
			LoadBalancingWeight: wrapperspb.UInt32(weight),
			HealthStatus:        corev3.HealthStatus_HEALTHY,
		}
		zoneMap[zone] = append(zoneMap[zone], lbEndpoint)
	}

	var localityEndpoints []*endpointv3.LocalityLbEndpoints
	for zone, lbEndpoints := range zoneMap {
		localityEndpoints = append(localityEndpoints, &endpointv3.LocalityLbEndpoints{
			Locality: &corev3.Locality{
				Zone: zone,
			},
			LbEndpoints:         lbEndpoints,
			LoadBalancingWeight: wrapperspb.UInt32(uint32(len(lbEndpoints))),
		})
	}

	return &endpointv3.ClusterLoadAssignment{
		ClusterName: clusterName,
		Endpoints:   localityEndpoints,
		Policy: &endpointv3.ClusterLoadAssignment_Policy{
			OverprovisioningFactor: wrapperspb.UInt32(140),
		},
	}
}
```

## Implementing the gRPC xDS Server

### pkg/xds/server.go

```go
package xds

import (
	"context"
	"fmt"
	"net"

	discoveryv3 "github.com/envoyproxy/go-control-plane/envoy/service/discovery/v3"
	endpointservicev3 "github.com/envoyproxy/go-control-plane/envoy/service/endpoint/v3"
	listenerservicev3 "github.com/envoyproxy/go-control-plane/envoy/service/listener/v3"
	routeservicev3 "github.com/envoyproxy/go-control-plane/envoy/service/route/v3"
	serverv3 "github.com/envoyproxy/go-control-plane/pkg/server/v3"
	cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"
)

// Server wraps the xDS gRPC server.
type Server struct {
	grpcServer *grpc.Server
	xdsServer  serverv3.Server
	logger     *zap.Logger
	port       int
}

// NewServer creates an xDS server backed by the provided snapshot cache.
func NewServer(cache cachev3.Cache, callbacks serverv3.Callbacks, logger *zap.Logger, port int) *Server {
	// Use strict xDS v3 only
	xdsSrv := serverv3.NewServer(context.Background(), cache, callbacks)

	grpcSrv := grpc.NewServer(
		grpc.MaxConcurrentStreams(1000),
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionIdle: 15 * 60, // 15 minutes
			Time:              5 * 60,  // 5 minutes
			Timeout:           20,      // 20 seconds
		}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             10,
			PermitWithoutStream: true,
		}),
	)

	// Register all xDS services
	discoveryv3.RegisterAggregatedDiscoveryServiceServer(grpcSrv, xdsSrv)
	endpointservicev3.RegisterEndpointDiscoveryServiceServer(grpcSrv, xdsSrv)
	listenerservicev3.RegisterListenerDiscoveryServiceServer(grpcSrv, xdsSrv)
	routeservicev3.RegisterRouteDiscoveryServiceServer(grpcSrv, xdsSrv)

	// Enable gRPC reflection for debugging with grpc_cli
	reflection.Register(grpcSrv)

	return &Server{
		grpcServer: grpcSrv,
		xdsServer:  xdsSrv,
		logger:     logger,
		port:       port,
	}
}

// Start begins listening and serving xDS requests.
func (s *Server) Start(ctx context.Context) error {
	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", s.port))
	if err != nil {
		return fmt.Errorf("listening on port %d: %w", s.port, err)
	}

	s.logger.Info("xDS server listening", zap.Int("port", s.port))

	errCh := make(chan error, 1)
	go func() {
		if err := s.grpcServer.Serve(lis); err != nil {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		s.grpcServer.GracefulStop()
		return nil
	case err := <-errCh:
		return err
	}
}
```

### pkg/xds/callbacks.go

```go
package xds

import (
	"context"
	"sync"
	"sync/atomic"

	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	discoveryv3 "github.com/envoyproxy/go-control-plane/envoy/service/discovery/v3"
	"go.uber.org/zap"
)

// Callbacks implements xDS server callbacks for observability.
type Callbacks struct {
	logger        *zap.Logger
	mu            sync.Mutex
	connectedNodes map[string]*corev3.Node

	// Prometheus counters (use atomic for performance)
	requestCount  atomic.Int64
	responseCount atomic.Int64
	errorCount    atomic.Int64
}

// NewCallbacks creates a new Callbacks instance.
func NewCallbacks(logger *zap.Logger) *Callbacks {
	return &Callbacks{
		logger:        logger,
		connectedNodes: make(map[string]*corev3.Node),
	}
}

// Report returns observability metrics.
func (c *Callbacks) Report() (nodes int, requests, responses, errors int64) {
	c.mu.Lock()
	nodes = len(c.connectedNodes)
	c.mu.Unlock()
	return nodes, c.requestCount.Load(), c.responseCount.Load(), c.errorCount.Load()
}

func (c *Callbacks) OnStreamOpen(ctx context.Context, id int64, typ string) error {
	c.logger.Debug("stream opened", zap.Int64("stream_id", id), zap.String("type_url", typ))
	return nil
}

func (c *Callbacks) OnStreamClosed(id int64, node *corev3.Node) {
	c.logger.Debug("stream closed", zap.Int64("stream_id", id))
	if node != nil {
		c.mu.Lock()
		delete(c.connectedNodes, node.Id)
		c.mu.Unlock()
	}
}

func (c *Callbacks) OnStreamRequest(id int64, req *discoveryv3.DiscoveryRequest) error {
	c.requestCount.Add(1)
	if req.Node != nil {
		c.mu.Lock()
		c.connectedNodes[req.Node.Id] = req.Node
		c.mu.Unlock()
	}
	c.logger.Debug("stream request",
		zap.Int64("stream_id", id),
		zap.String("type_url", req.TypeUrl),
		zap.String("version", req.VersionInfo),
		zap.String("node", func() string {
			if req.Node != nil {
				return req.Node.Id
			}
			return "unknown"
		}()),
	)
	return nil
}

func (c *Callbacks) OnStreamResponse(ctx context.Context, id int64, req *discoveryv3.DiscoveryRequest, resp *discoveryv3.DiscoveryResponse) {
	c.responseCount.Add(1)
	c.logger.Debug("stream response",
		zap.Int64("stream_id", id),
		zap.String("type_url", resp.TypeUrl),
		zap.String("version", resp.VersionInfo),
		zap.Int("resources", len(resp.Resources)),
	)
}

func (c *Callbacks) OnFetchRequest(ctx context.Context, req *discoveryv3.DiscoveryRequest) error {
	c.requestCount.Add(1)
	return nil
}

func (c *Callbacks) OnFetchResponse(req *discoveryv3.DiscoveryRequest, resp *discoveryv3.DiscoveryResponse) {
	c.responseCount.Add(1)
}

func (c *Callbacks) OnDeltaStreamOpen(ctx context.Context, id int64, typ string) error {
	c.logger.Debug("delta stream opened", zap.Int64("stream_id", id))
	return nil
}

func (c *Callbacks) OnDeltaStreamClosed(id int64, node *corev3.Node) {
	c.logger.Debug("delta stream closed", zap.Int64("stream_id", id))
}

func (c *Callbacks) OnStreamDeltaRequest(id int64, req *discoveryv3.DeltaDiscoveryRequest) error {
	c.requestCount.Add(1)
	return nil
}

func (c *Callbacks) OnStreamDeltaResponse(id int64, req *discoveryv3.DeltaDiscoveryRequest, resp *discoveryv3.DeltaDiscoveryResponse) {
	c.responseCount.Add(1)
}
```

## Kubernetes Service Discovery Integration

### pkg/discovery/kubernetes.go

```go
package discovery

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/manager"

	"github.com/yourorg/envoy-control-plane/pkg/snapshot"
	"go.uber.org/zap"
)

// Reconciler watches Kubernetes Services and Endpoints and updates xDS snapshots.
type Reconciler struct {
	client   client.Client
	snapshot *snapshot.Manager
	logger   *zap.Logger
	nodeID   string
}

// NewReconciler creates a Kubernetes discovery reconciler.
func NewReconciler(mgr manager.Manager, snap *snapshot.Manager, nodeID string, logger *zap.Logger) *Reconciler {
	return &Reconciler{
		client:   mgr.GetClient(),
		snapshot: snap,
		logger:   logger,
		nodeID:   nodeID,
	}
}

// Reconcile is called by controller-runtime when Services or Endpoints change.
func (r *Reconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	r.logger.Info("reconciling", zap.String("resource", req.NamespacedName.String()))

	services, err := r.discoverServices(ctx)
	if err != nil {
		return reconcile.Result{}, fmt.Errorf("discovering services: %w", err)
	}

	if err := r.snapshot.UpdateSnapshot(ctx, r.nodeID, services); err != nil {
		return reconcile.Result{}, fmt.Errorf("updating snapshot: %w", err)
	}

	return reconcile.Result{}, nil
}

func (r *Reconciler) discoverServices(ctx context.Context) (*snapshot.Resources, error) {
	var serviceList corev1.ServiceList
	if err := r.client.List(ctx, &serviceList, client.InNamespace("")); err != nil {
		return nil, err
	}

	builder := snapshot.NewBuilder()
	var configs []snapshot.ServiceConfig

	for _, svc := range serviceList.Items {
		// Skip headless services and those without the mesh annotation
		if svc.Spec.ClusterIP == "None" {
			continue
		}
		if svc.Annotations["envoy.control-plane/enabled"] != "true" {
			continue
		}

		var endpointList corev1.EndpointsList
		if err := r.client.List(ctx, &endpointList,
			client.InNamespace(svc.Namespace),
			client.MatchingFields{"metadata.name": svc.Name},
		); err != nil {
			r.logger.Warn("failed to list endpoints", zap.String("service", svc.Name), zap.Error(err))
			continue
		}

		var eps []snapshot.EndpointInfo
		for _, ep := range endpointList.Items {
			for _, subset := range ep.Subsets {
				for _, addr := range subset.Addresses {
					zone := ""
					if addr.NodeName != nil {
						var node corev1.Node
						if err := r.client.Get(ctx, types.NamespacedName{Name: *addr.NodeName}, &node); err == nil {
							zone = node.Labels["topology.kubernetes.io/zone"]
						}
					}
					for _, port := range subset.Ports {
						eps = append(eps, snapshot.EndpointInfo{
							Address: addr.IP,
							Port:    uint32(port.Port),
							Zone:    zone,
							Weight:  1,
						})
					}
				}
			}
		}

		if len(eps) == 0 {
			continue
		}

		port := uint32(80)
		if len(svc.Spec.Ports) > 0 {
			port = uint32(svc.Spec.Ports[0].Port)
		}

		configs = append(configs, snapshot.ServiceConfig{
			Name:       fmt.Sprintf("%s.%s", svc.Name, svc.Namespace),
			Namespace:  svc.Namespace,
			Port:       port,
			Endpoints:  eps,
			TLSEnabled: svc.Annotations["envoy.control-plane/tls"] == "true",
		})
	}

	return builder.Build(configs)
}
```

## Envoy Bootstrap Configuration

### config/envoy-bootstrap.yaml

```yaml
node:
  id: "production-node-1"
  cluster: "production"
  metadata:
    region: "us-east-1"
    environment: "production"

dynamic_resources:
  ads_config:
    api_type: GRPC
    transport_api_version: V3
    grpc_services:
      - envoy_grpc:
          cluster_name: xds_cluster
    set_node_on_first_message_only: true
  cds_config:
    resource_api_version: V3
    ads: {}
  lds_config:
    resource_api_version: V3
    ads: {}

static_resources:
  clusters:
    - name: xds_cluster
      connect_timeout: 5s
      type: STRICT_DNS
      load_assignment:
        cluster_name: xds_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: envoy-control-plane.mesh-system.svc.cluster.local
                      port_value: 18000
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config:
            http2_protocol_options:
              connection_keepalive:
                interval: 30s
                timeout: 5s

layered_runtime:
  layers:
    - name: rtds_layer
      rtds_layer:
        name: runtime
        rtds_config:
          resource_api_version: V3
          ads: {}
    - name: static_layer
      static_layer:
        envoy.reloadable_features.enable_update_listener_socket_options: true

admin:
  address:
    socket_address:
      address: 0.0.0.0
      port_value: 9901
```

## Incremental xDS (Delta) Implementation

For fleets with thousands of clusters, state-of-the-world xDS becomes bandwidth-intensive. The delta xDS protocol sends only changed resources.

### pkg/xds/delta_server.go

```go
package xds

import (
	"context"

	cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	serverv3 "github.com/envoyproxy/go-control-plane/pkg/server/v3"
	"go.uber.org/zap"
)

// DeltaServer wraps incremental xDS. The go-control-plane library
// automatically serves delta xDS when clients request it via
// DeltaAggregatedResources RPC — no separate implementation needed.
// This wrapper adds metrics and logging.
type DeltaServer struct {
	inner  serverv3.Server
	logger *zap.Logger
}

// NewDeltaServer creates a delta-capable server. go-control-plane's
// LinearCache is optimized for delta scenarios.
func NewDeltaServer(ctx context.Context, cache cachev3.Cache, cb serverv3.Callbacks, logger *zap.Logger) *DeltaServer {
	return &DeltaServer{
		inner:  serverv3.NewServer(ctx, cache, cb),
		logger: logger,
	}
}

// LinearCacheExample demonstrates using the linear cache for large cluster
// counts where delta xDS provides the most benefit.
func BuildLinearCaches() map[string]cachev3.Cache {
	caches := make(map[string]cachev3.Cache)

	// Per-type linear caches for maximum delta efficiency
	clusterCache := cachev3.NewLinearCache(resourcev3.ClusterType,
		cachev3.WithVersionPrefix("cls-"),
	)
	endpointCache := cachev3.NewLinearCache(resourcev3.EndpointType,
		cachev3.WithVersionPrefix("ep-"),
	)
	listenerCache := cachev3.NewLinearCache(resourcev3.ListenerType,
		cachev3.WithVersionPrefix("lis-"),
	)
	routeCache := cachev3.NewLinearCache(resourcev3.RouteType,
		cachev3.WithVersionPrefix("rte-"),
	)

	caches["clusters"] = clusterCache
	caches["endpoints"] = endpointCache
	caches["listeners"] = listenerCache
	caches["routes"] = routeCache

	return caches
}

// UpdateCluster updates a single cluster in the linear cache.
// Only this cluster's update is propagated to connected Envoys.
func UpdateCluster(cache *cachev3.LinearCache, name string, resource cachev3.Resource) error {
	return cache.UpdateResource(name, resource)
}

// DeleteCluster removes a cluster from the linear cache.
// Connected Envoys receive a delta response with removal instructions.
func DeleteCluster(cache *cachev3.LinearCache, name string) error {
	return cache.DeleteResource(name)
}
```

## Kubernetes Deployment

### deploy/k8s/deployment.yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: envoy-control-plane
  namespace: mesh-system
  labels:
    app: envoy-control-plane
spec:
  replicas: 2
  selector:
    matchLabels:
      app: envoy-control-plane
  template:
    metadata:
      labels:
        app: envoy-control-plane
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      serviceAccountName: envoy-control-plane
      containers:
        - name: control-plane
          image: yourorg/envoy-control-plane:latest
          args:
            - --port=18000
            - --metrics-port=9090
            - --node-id=production
            - --log-level=info
          ports:
            - containerPort: 18000
              name: xds-grpc
            - containerPort: 9090
              name: metrics
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            grpc:
              port: 18000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            grpc:
              port: 18000
            initialDelaySeconds: 15
            periodSeconds: 20
---
apiVersion: v1
kind: Service
metadata:
  name: envoy-control-plane
  namespace: mesh-system
spec:
  selector:
    app: envoy-control-plane
  ports:
    - port: 18000
      name: xds-grpc
      targetPort: 18000
    - port: 9090
      name: metrics
      targetPort: 9090
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: envoy-control-plane
  namespace: mesh-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: envoy-control-plane
rules:
  - apiGroups: [""]
    resources: ["services", "endpoints", "nodes", "pods"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: envoy-control-plane
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: envoy-control-plane
subjects:
  - kind: ServiceAccount
    name: envoy-control-plane
    namespace: mesh-system
```

## Main Entry Point

### cmd/server/main.go

```go
package main

import (
	"context"
	"flag"
	"os"
	"os/signal"
	"syscall"

	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	"sigs.k8s.io/controller-runtime/pkg/client/config"

	"github.com/yourorg/envoy-control-plane/pkg/discovery"
	"github.com/yourorg/envoy-control-plane/pkg/snapshot"
	"github.com/yourorg/envoy-control-plane/pkg/xds"
)

func main() {
	port := flag.Int("port", 18000, "xDS gRPC server port")
	nodeID := flag.String("node-id", "default", "Target Envoy node ID / cluster")
	logLevel := flag.String("log-level", "info", "Log level (debug, info, warn, error)")
	flag.Parse()

	logger := buildLogger(*logLevel)
	defer logger.Sync()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	// Initialize snapshot manager
	snapManager := snapshot.NewManager(logger)

	// Initialize xDS callbacks for observability
	callbacks := xds.NewCallbacks(logger)

	// Build and start xDS gRPC server
	xdsSrv := xds.NewServer(snapManager.Cache(), callbacks, logger, *port)

	// Initialize Kubernetes manager for service discovery
	cfg, err := config.GetConfig()
	if err != nil {
		logger.Fatal("getting kubeconfig", zap.Error(err))
	}

	mgr, err := manager.New(cfg, manager.Options{
		LeaderElection:          true,
		LeaderElectionID:        "envoy-control-plane-leader",
		LeaderElectionNamespace: "mesh-system",
	})
	if err != nil {
		logger.Fatal("creating manager", zap.Error(err))
	}

	reconciler := discovery.NewReconciler(mgr, snapManager, *nodeID, logger)
	if err := reconciler.SetupWithManager(mgr); err != nil {
		logger.Fatal("setting up reconciler", zap.Error(err))
	}

	// Run everything concurrently
	g, ctx := errgroup.WithContext(ctx)
	g.Go(func() error { return xdsSrv.Start(ctx) })
	g.Go(func() error { return mgr.Start(ctx) })

	if err := g.Wait(); err != nil {
		logger.Error("server exited with error", zap.Error(err))
		os.Exit(1)
	}
}

func buildLogger(level string) *zap.Logger {
	cfg := zap.NewProductionConfig()
	if err := cfg.Level.UnmarshalText([]byte(level)); err != nil {
		cfg.Level = zap.NewAtomicLevelAt(zap.InfoLevel)
	}
	logger, _ := cfg.Build()
	return logger
}
```

## Testing the Control Plane

### Integration Test with envoy-test-utils

```go
// pkg/xds/server_test.go
package xds_test

import (
	"context"
	"testing"
	"time"

	clusterv3 "github.com/envoyproxy/go-control-plane/envoy/config/cluster/v3"
	cachev3 "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"

	"github.com/yourorg/envoy-control-plane/pkg/snapshot"
	"github.com/yourorg/envoy-control-plane/pkg/xds"
)

func TestSnapshotConsistency(t *testing.T) {
	logger := zaptest.NewLogger(t)
	mgr := snapshot.NewManager(logger)

	resources, err := snapshot.NewBuilder().Build([]snapshot.ServiceConfig{
		{
			Name:      "test-service.default",
			Namespace: "default",
			Port:      8080,
			Endpoints: []snapshot.EndpointInfo{
				{Address: "10.0.0.1", Port: 8080, Zone: "us-east-1a", Weight: 1},
				{Address: "10.0.0.2", Port: 8080, Zone: "us-east-1b", Weight: 1},
			},
		},
	})
	require.NoError(t, err)

	ctx := context.Background()
	err = mgr.UpdateSnapshot(ctx, "test-node", resources)
	require.NoError(t, err)

	snap, err := mgr.Cache().GetSnapshot("test-node")
	require.NoError(t, err)

	clusters := snap.GetResources(resourcev3.ClusterType)
	assert.Len(t, clusters, 1)

	endpoints := snap.GetResources(resourcev3.EndpointType)
	assert.Len(t, endpoints, 1)
}

func TestXDSServerStartup(t *testing.T) {
	logger := zaptest.NewLogger(t)
	mgr := snapshot.NewManager(logger)
	callbacks := xds.NewCallbacks(logger)
	srv := xds.NewServer(mgr.Cache(), callbacks, logger, 0) // port 0 = random

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Server should start and stop cleanly
	err := srv.Start(ctx)
	assert.NoError(t, err)
}
```

## Prometheus Metrics for the Control Plane

```go
// pkg/metrics/metrics.go
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	SnapshotUpdatesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "xds_snapshot_updates_total",
		Help: "Total number of xDS snapshot updates.",
	}, []string{"node_id"})

	ConnectedEnvoyNodes = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "xds_connected_envoy_nodes",
		Help: "Number of Envoy nodes currently connected.",
	})

	XDSRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "xds_requests_total",
		Help: "Total xDS requests received.",
	}, []string{"type_url"})

	XDSResponsesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "xds_responses_total",
		Help: "Total xDS responses sent.",
	}, []string{"type_url"})

	SnapshotBuildDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "xds_snapshot_build_duration_seconds",
		Help:    "Time to build xDS snapshots.",
		Buckets: prometheus.DefBuckets,
	}, []string{"node_id"})

	EndpointsPerCluster = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "xds_endpoints_per_cluster",
		Help: "Number of endpoints tracked per cluster.",
	}, []string{"cluster"})
)
```

## Troubleshooting Common Issues

### Issue: Envoy Reports "No healthy upstream"

```bash
# Check Envoy admin API for cluster health
kubectl exec -it <envoy-pod> -- curl localhost:9901/clusters

# Verify EDS responses are being received
kubectl exec -it <envoy-pod> -- curl localhost:9901/config_dump | \
  jq '.configs[] | select(.["@type"] | contains("ClusterDiscovery"))'

# Check control plane logs for snapshot errors
kubectl logs -n mesh-system deployment/envoy-control-plane --tail=100 | \
  grep -i "error\|snapshot\|inconsist"
```

### Issue: Snapshot Inconsistency Errors

Envoy validates that all referenced resources exist within a snapshot. Common causes:
- A route references a cluster that was not included in the snapshot
- An HCM references an RDS config name that does not match the RouteConfiguration name

```go
// Always call snapshot.Consistent() before SetSnapshot()
if err := snapshot.Consistent(); err != nil {
    log.Errorf("snapshot inconsistent: %v", err)
    // Log the specific missing resources
    for typeURL, missing := range snapshot.GetConsistencyErrors() {
        log.Errorf("missing %s: %v", typeURL, missing)
    }
    return err
}
```

### Issue: High Memory Usage in Control Plane

With large numbers of endpoints, snapshot memory grows. Use the linear cache with delta xDS:

```bash
# Profile control plane memory
kubectl exec -it -n mesh-system deployment/envoy-control-plane -- \
  curl localhost:6060/debug/pprof/heap > heap.prof
go tool pprof heap.prof
```

## Production Operational Runbook

### Scaling the Control Plane

The snapshot cache is keyed per node ID. For HA deployments:

1. Use leader election (shown in main.go) so only one instance generates snapshots
2. Both instances serve xDS responses from an in-memory cache populated by the leader
3. Use separate nodeIDs per logical group (not per Envoy instance) to reduce snapshot count

### Rolling Control Plane Updates

```bash
# Verify all Envoys have received the latest snapshot version before update
kubectl exec -it -n mesh-system deployment/envoy-control-plane -- \
  curl -s localhost:9090/metrics | grep xds_snapshot_version

# Graceful rollout
kubectl rollout restart deployment/envoy-control-plane -n mesh-system
kubectl rollout status deployment/envoy-control-plane -n mesh-system
```

## Key Takeaways

Building a custom Envoy control plane in Go provides complete ownership over service mesh configuration. The critical points to internalize:

1. **Snapshot consistency is mandatory**: All referenced resources must exist in the same snapshot version. The `Consistent()` check prevents silent failures.

2. **ADS over individual xDS**: Use aggregated discovery for ordered, consistent updates. Individual services can cause race conditions.

3. **Node ID grouping**: Keying snapshots by cluster/group rather than individual Envoy pod ID dramatically reduces control plane memory and CPU.

4. **Delta xDS for scale**: Beyond ~500 clusters, switch to delta xDS (incremental) to avoid full-state broadcasts on every endpoint change.

5. **Circuit breakers and outlier detection**: Always configure these in cluster resources. Envoy without these settings will keep sending traffic to unhealthy backends.

6. **Leader election**: Run multiple control plane replicas but only let the leader write snapshots to prevent version conflicts.

The `go-control-plane` library handles the gRPC protocol complexities. Your focus should be on correct resource construction, snapshot consistency, and integrating with your service registry.
