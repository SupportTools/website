---
title: "Go Service Discovery: Consul, etcd, and Kubernetes-Native Patterns"
date: 2029-07-04T00:00:00-05:00
draft: false
tags: ["Go", "Service Discovery", "Consul", "etcd", "Kubernetes", "gRPC", "Load Balancing"]
categories: ["Go", "Distributed Systems", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go service discovery patterns: Consul service registration, etcd watch API, Kubernetes EndpointSlices, DNS-based discovery, and client-side load balancing with gRPC name resolvers."
more_link: "yes"
url: "/go-service-discovery-consul-etcd-kubernetes-native-patterns/"
---

Service discovery is the mechanism by which services locate each other in a distributed system. In Kubernetes-native environments, DNS and EndpointSlices handle most cases. But complex multi-cluster deployments, hybrid cloud setups, and non-Kubernetes services often require Consul or etcd. This post implements service discovery in Go for each backend and explains how gRPC name resolvers tie everything together.

<!--more-->

# Go Service Discovery: Consul, etcd, and Kubernetes-Native Patterns

## The Discovery Landscape

Service discovery has two fundamental models:

**Server-side discovery**: The client sends requests to a load balancer (e.g., kube-proxy, AWS ALB). The load balancer performs the discovery and routing. The client only knows the load balancer's address.

**Client-side discovery**: The client queries a registry (Consul, etcd, Kubernetes API) directly, receives a list of healthy instances, and selects one using a local load-balancing algorithm.

Client-side discovery eliminates the single-point-of-failure load balancer and allows the client to make intelligent routing decisions (latency-based routing, consistent hashing, zone-aware routing). gRPC uses client-side discovery as its primary model.

## Section 1: Consul Service Discovery

Consul provides a distributed key-value store, health checking, and service catalog. It is commonly used in multi-cloud and hybrid deployments where workloads span Kubernetes and non-Kubernetes infrastructure.

### Service Registration

Services register themselves with the local Consul agent at startup and deregister on shutdown:

```go
package consul

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "os"
    "time"

    consulapi "github.com/hashicorp/consul/api"
)

type ServiceRegistrar struct {
    client    *consulapi.Client
    serviceID string
    logger    *slog.Logger
}

// Register registers the service with the local Consul agent.
// It starts a background goroutine that deregisters on context cancellation.
func Register(ctx context.Context, serviceName, addr string, port int, tags []string) (*ServiceRegistrar, error) {
    cfg := consulapi.DefaultConfig()
    // CONSUL_HTTP_ADDR env var is automatically picked up
    client, err := consulapi.NewClient(cfg)
    if err != nil {
        return nil, fmt.Errorf("create consul client: %w", err)
    }

    hostname, _ := os.Hostname()
    serviceID := fmt.Sprintf("%s-%s-%d", serviceName, hostname, port)

    registration := &consulapi.AgentServiceRegistration{
        ID:      serviceID,
        Name:    serviceName,
        Address: addr,
        Port:    port,
        Tags:    tags,
        Check: &consulapi.AgentServiceCheck{
            TCP:                            fmt.Sprintf("%s:%d", addr, port),
            Interval:                       "10s",
            Timeout:                        "3s",
            DeregisterCriticalServiceAfter: "60s",
        },
        // Additional metadata for version, region, etc.
        Meta: map[string]string{
            "version": os.Getenv("APP_VERSION"),
            "region":  os.Getenv("AWS_REGION"),
        },
    }

    if err := client.Agent().ServiceRegister(registration); err != nil {
        return nil, fmt.Errorf("register service: %w", err)
    }

    r := &ServiceRegistrar{
        client:    client,
        serviceID: serviceID,
        logger:    slog.Default(),
    }

    // Deregister when context is done
    go func() {
        <-ctx.Done()
        if err := client.Agent().ServiceDeregister(serviceID); err != nil {
            r.logger.Error("deregister service", "service_id", serviceID, "err", err)
        }
    }()

    return r, nil
}
```

### Service Discovery with Health Checking

```go
package consul

import (
    "context"
    "fmt"
    "time"

    consulapi "github.com/hashicorp/consul/api"
)

type Instance struct {
    ID      string
    Address string
    Port    int
    Tags    []string
    Meta    map[string]string
}

type Resolver struct {
    client  *consulapi.Client
    service string
    dc      string
}

// Resolve returns the current set of healthy instances for the service.
func (r *Resolver) Resolve(ctx context.Context) ([]Instance, error) {
    opts := &consulapi.QueryOptions{
        RequireConsistent: false, // stale reads are acceptable for discovery
    }
    opts = opts.WithContext(ctx)

    entries, _, err := r.client.Health().Service(r.service, "", true, opts)
    if err != nil {
        return nil, fmt.Errorf("consul health service %q: %w", r.service, err)
    }

    instances := make([]Instance, 0, len(entries))
    for _, entry := range entries {
        addr := entry.Service.Address
        if addr == "" {
            addr = entry.Node.Address
        }
        instances = append(instances, Instance{
            ID:      entry.Service.ID,
            Address: addr,
            Port:    entry.Service.Port,
            Tags:    entry.Service.Tags,
            Meta:    entry.Service.Meta,
        })
    }
    return instances, nil
}

// Watch blocks until the service catalog changes, then returns.
// Uses Consul's blocking query (long-polling) feature.
func (r *Resolver) Watch(ctx context.Context, lastIndex uint64) ([]Instance, uint64, error) {
    opts := &consulapi.QueryOptions{
        WaitIndex: lastIndex,
        WaitTime:  5 * time.Minute, // Consul will hold the connection for up to 5m
    }
    opts = opts.WithContext(ctx)

    entries, meta, err := r.client.Health().Service(r.service, "", true, opts)
    if err != nil {
        return nil, lastIndex, fmt.Errorf("consul watch %q: %w", r.service, err)
    }

    instances := make([]Instance, 0, len(entries))
    for _, entry := range entries {
        addr := entry.Service.Address
        if addr == "" {
            addr = entry.Node.Address
        }
        instances = append(instances, Instance{
            ID:   entry.Service.ID,
            Address: addr,
            Port:    entry.Service.Port,
        })
    }
    return instances, meta.LastIndex, nil
}
```

### Consul-Backed gRPC Name Resolver

```go
package consul

import (
    "context"
    "fmt"
    "sync"

    "google.golang.org/grpc/resolver"
)

// ConsulResolver implements gRPC's resolver.Resolver interface.
type ConsulResolver struct {
    cc      resolver.ClientConn
    service string
    r       *Resolver
    cancel  context.CancelFunc
    wg      sync.WaitGroup
}

func (cr *ConsulResolver) start() {
    ctx, cancel := context.WithCancel(context.Background())
    cr.cancel = cancel

    cr.wg.Add(1)
    go func() {
        defer cr.wg.Done()

        var lastIndex uint64
        for {
            instances, newIndex, err := cr.r.Watch(ctx, lastIndex)
            if err != nil {
                if ctx.Err() != nil {
                    return
                }
                cr.cc.ReportError(err)
                continue
            }

            addrs := make([]resolver.Address, 0, len(instances))
            for _, inst := range instances {
                addrs = append(addrs, resolver.Address{
                    Addr:       fmt.Sprintf("%s:%d", inst.Address, inst.Port),
                    ServerName: cr.service,
                })
            }

            cr.cc.UpdateState(resolver.State{Addresses: addrs})
            lastIndex = newIndex
        }
    }()
}

func (cr *ConsulResolver) ResolveNow(resolver.ResolveNowOptions) {}

func (cr *ConsulResolver) Close() {
    cr.cancel()
    cr.wg.Wait()
}

// ConsulResolverBuilder registers the consul:// scheme with gRPC
type ConsulResolverBuilder struct {
    client *consulapi.Client
}

func (b *ConsulResolverBuilder) Scheme() string { return "consul" }

func (b *ConsulResolverBuilder) Build(
    target resolver.Target,
    cc resolver.ClientConn,
    opts resolver.BuildOptions,
) (resolver.Resolver, error) {
    serviceName := target.Endpoint()
    cr := &ConsulResolver{
        cc:      cc,
        service: serviceName,
        r:       &Resolver{client: b.client, service: serviceName},
    }
    cr.start()
    return cr, nil
}

// Usage:
// resolver.Register(&ConsulResolverBuilder{client: consulClient})
// conn, err := grpc.Dial("consul:///my-service", grpc.WithDefaultServiceConfig(`{
//     "loadBalancingPolicy": "round_robin"
// }`))
```

## Section 2: etcd Watch API

etcd is the distributed key-value store that underlies Kubernetes. It can also be used directly for service discovery via its watch API.

### Service Registration with etcd

```go
package etcd

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
)

const (
    servicePrefix = "/services/"
    leaseTTL      = 30 // seconds
)

type ServiceInfo struct {
    ID      string            `json:"id"`
    Address string            `json:"address"`
    Port    int               `json:"port"`
    Meta    map[string]string `json:"meta,omitempty"`
}

type Registration struct {
    client   *clientv3.Client
    leaseID  clientv3.LeaseID
    key      string
    cancel   context.CancelFunc
}

// Register registers the service using an etcd lease for TTL-based health.
// The registration is automatically removed if the process dies (lease expires).
func Register(ctx context.Context, client *clientv3.Client, svc ServiceInfo) (*Registration, error) {
    // Grant a lease with TTL
    leaseResp, err := client.Grant(ctx, leaseTTL)
    if err != nil {
        return nil, fmt.Errorf("etcd grant lease: %w", err)
    }

    data, err := json.Marshal(svc)
    if err != nil {
        return nil, fmt.Errorf("marshal service info: %w", err)
    }

    key := fmt.Sprintf("%s%s/%s", servicePrefix, svc.ID[:strings.LastIndex(svc.ID, "-")], svc.ID)

    // Register with the lease
    _, err = client.Put(ctx, key, string(data), clientv3.WithLease(leaseResp.ID))
    if err != nil {
        return nil, fmt.Errorf("etcd put service: %w", err)
    }

    // Keep the lease alive in the background
    keepAliveCh, err := client.KeepAlive(ctx, leaseResp.ID)
    if err != nil {
        return nil, fmt.Errorf("etcd keepalive: %w", err)
    }

    liveCtx, cancel := context.WithCancel(ctx)
    go func() {
        for {
            select {
            case _, ok := <-keepAliveCh:
                if !ok {
                    return // lease expired or context cancelled
                }
            case <-liveCtx.Done():
                return
            }
        }
    }()

    return &Registration{
        client:  client,
        leaseID: leaseResp.ID,
        key:     key,
        cancel:  cancel,
    }, nil
}

func (r *Registration) Deregister(ctx context.Context) error {
    r.cancel()
    _, err := r.client.Delete(ctx, r.key)
    return err
}
```

### etcd Watch-Based Service Discovery

```go
package etcd

import (
    "context"
    "encoding/json"
    "fmt"
    "strings"
    "sync"

    clientv3 "go.etcd.io/etcd/client/v3"
    mvccpb "go.etcd.io/etcd/api/v3/mvccpb"
)

type ServiceWatcher struct {
    client    *clientv3.Client
    service   string
    mu        sync.RWMutex
    instances map[string]ServiceInfo // key -> instance
    updateCh  chan struct{}
}

func NewServiceWatcher(client *clientv3.Client, serviceName string) *ServiceWatcher {
    return &ServiceWatcher{
        client:    client,
        service:   serviceName,
        instances: make(map[string]ServiceInfo),
        updateCh:  make(chan struct{}, 1),
    }
}

// Start loads current instances and then watches for changes.
func (w *ServiceWatcher) Start(ctx context.Context) error {
    prefix := fmt.Sprintf("%s%s/", servicePrefix, w.service)

    // Initial load
    resp, err := w.client.Get(ctx, prefix, clientv3.WithPrefix())
    if err != nil {
        return fmt.Errorf("etcd get prefix %q: %w", prefix, err)
    }

    w.mu.Lock()
    for _, kv := range resp.Kvs {
        var svc ServiceInfo
        if err := json.Unmarshal(kv.Value, &svc); err != nil {
            continue
        }
        w.instances[string(kv.Key)] = svc
    }
    w.mu.Unlock()
    w.notify()

    // Watch for changes starting from the current revision
    go w.watch(ctx, prefix, resp.Header.Revision+1)
    return nil
}

func (w *ServiceWatcher) watch(ctx context.Context, prefix string, startRev int64) {
    watchCh := w.client.Watch(ctx, prefix,
        clientv3.WithPrefix(),
        clientv3.WithRev(startRev),
    )

    for {
        select {
        case <-ctx.Done():
            return
        case wresp, ok := <-watchCh:
            if !ok {
                return
            }
            if wresp.Err() != nil {
                continue
            }

            w.mu.Lock()
            for _, event := range wresp.Events {
                key := string(event.Kv.Key)
                switch event.Type {
                case mvccpb.PUT:
                    var svc ServiceInfo
                    if err := json.Unmarshal(event.Kv.Value, &svc); err == nil {
                        w.instances[key] = svc
                    }
                case mvccpb.DELETE:
                    delete(w.instances, key)
                }
            }
            w.mu.Unlock()
            w.notify()
        }
    }
}

func (w *ServiceWatcher) notify() {
    select {
    case w.updateCh <- struct{}{}:
    default: // already a pending update
    }
}

// Instances returns a snapshot of current healthy instances.
func (w *ServiceWatcher) Instances() []ServiceInfo {
    w.mu.RLock()
    defer w.mu.RUnlock()

    result := make([]ServiceInfo, 0, len(w.instances))
    for _, svc := range w.instances {
        result = append(result, svc)
    }
    return result
}

// Updates returns a channel that receives a value whenever the instance list changes.
func (w *ServiceWatcher) Updates() <-chan struct{} {
    return w.updateCh
}
```

## Section 3: Kubernetes EndpointSlices

In Kubernetes, EndpointSlices are the native mechanism for tracking pod IPs and ports. They replaced the original Endpoints object for scalability reasons (a single Endpoints object with 5000 pods was 1.5MB; EndpointSlices are sharded into chunks of 100).

### Watching EndpointSlices from a Go Client

```go
package k8s

import (
    "context"
    "fmt"

    discoveryv1 "k8s.io/api/discovery/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/watch"
    "k8s.io/client-go/informers"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/cache"
)

type EndpointWatcher struct {
    client      kubernetes.Interface
    namespace   string
    serviceName string
    updateCh    chan []Endpoint
}

type Endpoint struct {
    Address string
    Port    int32
    Ready   bool
}

func NewEndpointWatcher(client kubernetes.Interface, namespace, service string) *EndpointWatcher {
    return &EndpointWatcher{
        client:      client,
        namespace:   namespace,
        serviceName: service,
        updateCh:    make(chan []Endpoint, 10),
    }
}

func (w *EndpointWatcher) Start(ctx context.Context) {
    factory := informers.NewSharedInformerFactoryWithOptions(
        w.client,
        0, // no resync
        informers.WithNamespace(w.namespace),
    )

    sliceInformer := factory.Discovery().V1().EndpointSlices().Informer()

    sliceInformer.AddEventHandler(cache.FilteringResourceEventHandler{
        // Only process EndpointSlices for our service
        FilterFunc: func(obj interface{}) bool {
            slice, ok := obj.(*discoveryv1.EndpointSlice)
            if !ok {
                return false
            }
            svcName := slice.Labels[discoveryv1.LabelServiceName]
            return svcName == w.serviceName
        },
        Handler: cache.ResourceEventHandlerFuncs{
            AddFunc:    func(obj interface{}) { w.sync(ctx) },
            UpdateFunc: func(old, new interface{}) { w.sync(ctx) },
            DeleteFunc: func(obj interface{}) { w.sync(ctx) },
        },
    })

    factory.Start(ctx.Done())
    factory.WaitForCacheSync(ctx.Done())
}

func (w *EndpointWatcher) sync(ctx context.Context) {
    slices, err := w.client.DiscoveryV1().EndpointSlices(w.namespace).List(ctx,
        metav1.ListOptions{
            LabelSelector: fmt.Sprintf("%s=%s", discoveryv1.LabelServiceName, w.serviceName),
        },
    )
    if err != nil {
        return
    }

    var endpoints []Endpoint
    for _, slice := range slices.Items {
        // Find the primary port
        var port int32
        for _, p := range slice.Ports {
            if p.Port != nil {
                port = *p.Port
                break
            }
        }

        for _, ep := range slice.Endpoints {
            ready := ep.Conditions.Ready != nil && *ep.Conditions.Ready
            for _, addr := range ep.Addresses {
                endpoints = append(endpoints, Endpoint{
                    Address: addr,
                    Port:    port,
                    Ready:   ready,
                })
            }
        }
    }

    select {
    case w.updateCh <- endpoints:
    default:
    }
}

func (w *EndpointWatcher) Updates() <-chan []Endpoint {
    return w.updateCh
}
```

## Section 4: DNS-Based Service Discovery

For simpler scenarios, DNS-based discovery using `SRV` records is sufficient and requires no client-side library:

```go
package dns

import (
    "context"
    "fmt"
    "net"
    "time"
)

type DNSResolver struct {
    service   string
    proto     string
    namespace string
    domain    string
}

// NewKubernetesResolver creates a resolver for a Kubernetes service.
// The SRV record format is: _<port-name>._<proto>.<service>.<namespace>.svc.cluster.local
func NewKubernetesResolver(service, namespace, portName string) *DNSResolver {
    return &DNSResolver{
        service:   service,
        proto:     "tcp",
        namespace: namespace,
        domain:    portName,
    }
}

type ServiceEndpoint struct {
    Address  string
    Port     uint16
    Priority uint16
    Weight   uint16
}

func (r *DNSResolver) Resolve(ctx context.Context) ([]ServiceEndpoint, error) {
    srvName := fmt.Sprintf("_%s._%s.%s.%s.svc.cluster.local",
        r.domain, r.proto, r.service, r.namespace)

    var resolver net.Resolver
    _, addrs, err := resolver.LookupSRV(ctx, r.domain, r.proto,
        fmt.Sprintf("%s.%s.svc.cluster.local", r.service, r.namespace))
    if err != nil {
        // Fall back to A record lookup
        ips, err2 := resolver.LookupIPAddr(ctx,
            fmt.Sprintf("%s.%s.svc.cluster.local", r.service, r.namespace))
        if err2 != nil {
            return nil, fmt.Errorf("SRV lookup %q failed (%v); A lookup also failed: %w",
                srvName, err, err2)
        }
        result := make([]ServiceEndpoint, 0, len(ips))
        for _, ip := range ips {
            result = append(result, ServiceEndpoint{Address: ip.IP.String()})
        }
        return result, nil
    }

    result := make([]ServiceEndpoint, 0, len(addrs))
    for _, srv := range addrs {
        // Resolve the target hostname to IPs
        ips, err := resolver.LookupIPAddr(ctx, srv.Target)
        if err != nil {
            continue
        }
        for _, ip := range ips {
            result = append(result, ServiceEndpoint{
                Address:  ip.IP.String(),
                Port:     srv.Port,
                Priority: srv.Priority,
                Weight:   srv.Weight,
            })
        }
    }
    return result, nil
}
```

### Headless Services for Per-Pod DNS

For StatefulSets and databases, Kubernetes headless services expose per-pod DNS records:

```yaml
# Headless service for StatefulSet
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: data
spec:
  clusterIP: None  # headless
  selector:
    app: postgres
  ports:
  - port: 5432
    name: postgres
```

```go
// Connect to specific replicas using DNS
func buildPostgresConnString(namespace string, replicas int) []string {
    addrs := make([]string, replicas)
    for i := 0; i < replicas; i++ {
        // DNS: <pod-name>.<service>.<namespace>.svc.cluster.local
        addrs[i] = fmt.Sprintf(
            "postgres://%s-postgres-%d.postgres.%s.svc.cluster.local:5432/mydb",
            "myapp", i, namespace,
        )
    }
    return addrs
}
```

## Section 5: gRPC Client-Side Load Balancing with Custom Resolver

gRPC's name resolver and balancer abstractions allow full client-side discovery with any backend:

```go
package grpclb

import (
    "context"
    "fmt"
    "sync"

    "google.golang.org/grpc"
    "google.golang.org/grpc/balancer/roundrobin"
    "google.golang.org/grpc/resolver"
)

// ServiceRegistry is the interface for any discovery backend
type ServiceRegistry interface {
    Instances(ctx context.Context, service string) ([]string, error)
    Watch(ctx context.Context, service string) <-chan []string
}

// dynamicResolver implements grpc resolver.Resolver backed by a ServiceRegistry
type dynamicResolver struct {
    cc       resolver.ClientConn
    service  string
    registry ServiceRegistry
    cancel   context.CancelFunc
    wg       sync.WaitGroup
}

func (r *dynamicResolver) start() {
    ctx, cancel := context.WithCancel(context.Background())
    r.cancel = cancel

    r.wg.Add(1)
    go func() {
        defer r.wg.Done()
        ch := r.registry.Watch(ctx, r.service)
        for {
            select {
            case addrs, ok := <-ch:
                if !ok {
                    return
                }
                grpcAddrs := make([]resolver.Address, 0, len(addrs))
                for _, addr := range addrs {
                    grpcAddrs = append(grpcAddrs, resolver.Address{Addr: addr})
                }
                r.cc.UpdateState(resolver.State{Addresses: grpcAddrs})
            case <-ctx.Done():
                return
            }
        }
    }()
}

func (r *dynamicResolver) ResolveNow(resolver.ResolveNowOptions) {
    // Trigger an immediate re-resolve if needed
}

func (r *dynamicResolver) Close() {
    r.cancel()
    r.wg.Wait()
}

// DynamicResolverBuilder creates resolvers backed by the provided registry
type DynamicResolverBuilder struct {
    scheme   string
    registry ServiceRegistry
}

func NewBuilder(scheme string, registry ServiceRegistry) *DynamicResolverBuilder {
    return &DynamicResolverBuilder{scheme: scheme, registry: registry}
}

func (b *DynamicResolverBuilder) Scheme() string { return b.scheme }

func (b *DynamicResolverBuilder) Build(
    target resolver.Target,
    cc resolver.ClientConn,
    opts resolver.BuildOptions,
) (resolver.Resolver, error) {
    r := &dynamicResolver{
        cc:       cc,
        service:  target.Endpoint(),
        registry: b.registry,
    }
    r.start()
    return r, nil
}

// Dial creates a gRPC connection with client-side load balancing backed by
// the provided registry.
func Dial(ctx context.Context, scheme, service string, registry ServiceRegistry, opts ...grpc.DialOption) (*grpc.ClientConn, error) {
    resolver.Register(NewBuilder(scheme, registry))

    opts = append(opts,
        grpc.WithDefaultServiceConfig(fmt.Sprintf(`{
            "loadBalancingPolicy": %q,
            "methodConfig": [{
                "name": [{}],
                "retryPolicy": {
                    "maxAttempts": 4,
                    "initialBackoff": "0.1s",
                    "maxBackoff": "1s",
                    "backoffMultiplier": 2,
                    "retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
                }
            }]
        }`, roundrobin.Name)),
    )

    target := fmt.Sprintf("%s:///%s", scheme, service)
    return grpc.DialContext(ctx, target, opts...)
}
```

## Section 6: Zone-Aware Load Balancing

For multi-AZ deployments, prefer routing to same-zone instances to reduce latency and cross-AZ data transfer costs:

```go
package zoneaware

import (
    "os"

    "google.golang.org/grpc/balancer"
    "google.golang.org/grpc/balancer/base"
    "google.golang.org/grpc/resolver"
)

const Name = "zone_aware_round_robin"

// zoneAwarePickerBuilder prefers same-zone endpoints
type zoneAwarePickerBuilder struct{}

func (b *zoneAwarePickerBuilder) Build(info base.PickerBuildInfo) balancer.Picker {
    currentZone := os.Getenv("AVAILABILITY_ZONE") // e.g., "us-east-1a"

    var sameZone, otherZone []balancer.SubConn

    for sc, scInfo := range info.ReadySCs {
        zone := scInfo.Address.Attributes.Value("zone").(string)
        if zone == currentZone {
            sameZone = append(sameZone, sc)
        } else {
            otherZone = append(otherZone, sc)
        }
    }

    preferred := sameZone
    if len(preferred) == 0 {
        preferred = otherZone // fallback to other zones if no same-zone instances
    }

    return &roundRobinPicker{
        subConns: preferred,
        idx:      0,
    }
}

// Register the custom balancer
func init() {
    balancer.Register(base.NewBalancerBuilder(
        Name,
        &zoneAwarePickerBuilder{},
        base.Config{HealthCheck: true},
    ))
}
```

The zone attribute must be set by the resolver when it creates address entries:

```go
// In the resolver, attach zone metadata to each address
import "google.golang.org/grpc/attributes"

resolver.Address{
    Addr: "10.0.1.5:8080",
    Attributes: attributes.New("zone", instance.Zone),
}
```

## Section 7: Comparing Discovery Backends

| Property | Consul | etcd | k8s EndpointSlices | DNS (SRV) |
|----------|--------|------|---------------------|-----------|
| Health checking | Built-in (TCP/HTTP/script) | Via lease TTL | Via readiness probe | No native health |
| Watch latency | ~1s | ~100ms | ~100ms | TTL-limited |
| Multi-datacenter | Native | No | With submariner | Partial |
| Client library | hashicorp/consul/api | go.etcd.io/etcd | k8s.io/client-go | stdlib net |
| Non-k8s services | Yes | Yes | No | Partial |
| Scale | 10K+ services | 10K+ keys | 100K+ pods | Unlimited |

### Decision Guide

- **Consul**: Multi-cloud, hybrid k8s/non-k8s, native health checking, service mesh features
- **etcd**: Kubernetes-native services, tight control over TTL and watch behavior, already using etcd
- **EndpointSlices**: Pure Kubernetes, maximum integration with k8s lifecycle, no extra infrastructure
- **DNS (SRV)**: Simplest clients, language-agnostic, when watch-based updates are not needed

## Conclusion

Service discovery in Go requires choosing both the backend (Consul, etcd, Kubernetes, DNS) and the load-balancing model (server-side vs client-side). For gRPC services, client-side discovery with a custom name resolver provides the most flexibility: any backend can be plugged in, and policies like zone-aware routing and consistent hashing are implementable without changing service code.

The patterns shown here — Consul blocking queries, etcd watch streams, Kubernetes informers, and gRPC resolver/balancer integration — are all production-proven approaches. The Kubernetes EndpointSlice-based approach is preferred for pure Kubernetes deployments; Consul is the right choice when services span multiple runtime environments.
