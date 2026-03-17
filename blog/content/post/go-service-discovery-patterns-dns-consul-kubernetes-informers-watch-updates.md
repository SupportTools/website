---
title: "Go Service Discovery Patterns: DNS-Based, Consul Integration, Kubernetes Informers, and Watch-Based Updates"
date: 2031-12-19T00:00:00-05:00
draft: false
tags: ["Go", "Service Discovery", "Kubernetes", "Consul", "DNS", "Informers", "Microservices", "Architecture"]
categories:
- Go
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into service discovery patterns for Go microservices covering DNS SRV record resolution, HashiCorp Consul integration, Kubernetes informer-based discovery, and reactive watch-based endpoint updates with connection pool management."
more_link: "yes"
url: "/go-service-discovery-patterns-dns-consul-kubernetes-informers-watch-updates/"
---

Service discovery is a foundational concern in any microservices architecture. Without it, services cannot find each other dynamically as instances scale up and down, fail, or migrate between nodes. Go provides an excellent platform for implementing service discovery clients because of its strong concurrency primitives, low-overhead goroutines, and first-class network library support.

This guide covers four primary service discovery patterns used in production Go services: DNS SRV-based discovery, HashiCorp Consul integration, Kubernetes informer-based discovery, and reactive watch-based endpoint update propagation. Each pattern is implemented with production-grade considerations including error handling, backoff, circuit breaking, and connection lifecycle management.

<!--more-->

# Go Service Discovery Patterns: DNS, Consul, Kubernetes Informers, and Watch-Based Updates

## Section 1: Service Discovery Architecture

### 1.1 Core Concepts

Every service discovery system provides three fundamental operations:

- **Register**: announce that a service instance is available at a given address
- **Resolve**: look up the current set of healthy instances for a service
- **Watch**: receive notifications when the instance set changes

The resolver and watch pattern are the key to building clients that maintain accurate connection pools without polling.

### 1.2 The Resolver Interface

All discovery patterns in this guide implement a common interface:

```go
package discovery

import (
    "context"
    "net"
    "time"
)

// Endpoint represents a single service instance.
type Endpoint struct {
    Address  string            // host:port
    Metadata map[string]string // service tags, version, zone, etc.
    Healthy  bool
}

// Resolver discovers and watches service endpoints.
type Resolver interface {
    // Resolve returns the current set of healthy endpoints.
    Resolve(ctx context.Context, service string) ([]Endpoint, error)

    // Watch subscribes to endpoint changes. The channel receives
    // the full updated endpoint set whenever a change occurs.
    // The caller must drain the channel. Watch returns when ctx is cancelled.
    Watch(ctx context.Context, service string) (<-chan []Endpoint, error)

    // Close releases all resources associated with the resolver.
    Close() error
}

// BalancedResolver combines discovery with load balancing.
type BalancedResolver interface {
    Resolver
    // Pick selects a single endpoint for a request.
    Pick(ctx context.Context, service string) (Endpoint, error)
}
```

## Section 2: DNS SRV-Based Service Discovery

### 2.1 SRV Record Format

A DNS SRV record encodes service location:

```
_service._proto.name. TTL IN SRV priority weight port target.
_http._tcp.api.example.com. 30 IN SRV 10 100 8080 api-1.example.com.
_http._tcp.api.example.com. 30 IN SRV 10 100 8080 api-2.example.com.
_http._tcp.api.example.com. 30 IN SRV 20 100 8080 api-3.example.com.
```

Kubernetes creates these automatically for headless services.

### 2.2 DNS SRV Resolver Implementation

```go
package dnsdiscovery

import (
    "context"
    "fmt"
    "net"
    "sort"
    "sync"
    "time"

    "go.uber.org/zap"
)

// DNSResolver implements service discovery via DNS SRV records.
type DNSResolver struct {
    resolver *net.Resolver
    ttl      time.Duration
    logger   *zap.Logger

    mu        sync.RWMutex
    cache     map[string]cacheEntry
    watchers  map[string][]chan []Endpoint

    done chan struct{}
}

type cacheEntry struct {
    endpoints []Endpoint
    expiry    time.Time
}

type Config struct {
    // DNSServer is the DNS server to use (e.g., "10.96.0.10:53" for kube-dns).
    // If empty, the system resolver is used.
    DNSServer string
    // TTL overrides the DNS record TTL for cache expiry.
    // If zero, uses the TTL from the SRV record.
    TTL time.Duration
    // RefreshInterval is how often to proactively refresh cached entries.
    RefreshInterval time.Duration
    Logger          *zap.Logger
}

func NewDNSResolver(cfg Config) *DNSResolver {
    if cfg.TTL == 0 {
        cfg.TTL = 30 * time.Second
    }
    if cfg.RefreshInterval == 0 {
        cfg.RefreshInterval = 15 * time.Second
    }

    r := &DNSResolver{
        ttl:      cfg.TTL,
        logger:   cfg.Logger,
        cache:    make(map[string]cacheEntry),
        watchers: make(map[string][]chan []Endpoint),
        done:     make(chan struct{}),
    }

    if cfg.DNSServer != "" {
        r.resolver = &net.Resolver{
            PreferGo: true,
            Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
                d := net.Dialer{Timeout: 3 * time.Second}
                return d.DialContext(ctx, "udp", cfg.DNSServer)
            },
        }
    } else {
        r.resolver = net.DefaultResolver
    }

    go r.refreshLoop(cfg.RefreshInterval)
    return r
}

func (r *DNSResolver) Resolve(ctx context.Context, service string) ([]Endpoint, error) {
    // Check cache first
    r.mu.RLock()
    if entry, ok := r.cache[service]; ok && time.Now().Before(entry.expiry) {
        r.mu.RUnlock()
        return entry.endpoints, nil
    }
    r.mu.RUnlock()

    return r.resolveAndCache(ctx, service)
}

func (r *DNSResolver) resolveAndCache(ctx context.Context, service string) ([]Endpoint, error) {
    // Look up SRV records
    cname, srvRecords, err := r.resolver.LookupSRV(ctx, "", "", service)
    if err != nil {
        return nil, fmt.Errorf("SRV lookup for %q failed: %w", service, err)
    }
    _ = cname

    if len(srvRecords) == 0 {
        return nil, fmt.Errorf("no SRV records found for %q", service)
    }

    // Sort by priority, then by weight (higher weight = more traffic)
    sort.Slice(srvRecords, func(i, j int) bool {
        if srvRecords[i].Priority != srvRecords[j].Priority {
            return srvRecords[i].Priority < srvRecords[j].Priority
        }
        return srvRecords[i].Weight > srvRecords[j].Weight
    })

    var endpoints []Endpoint
    for _, srv := range srvRecords {
        // Resolve A/AAAA records for each target
        addrs, err := r.resolver.LookupHost(ctx, srv.Target)
        if err != nil {
            r.logger.Warn("failed to resolve SRV target",
                zap.String("target", srv.Target),
                zap.Error(err))
            continue
        }

        for _, addr := range addrs {
            endpoints = append(endpoints, Endpoint{
                Address: fmt.Sprintf("%s:%d", addr, srv.Port),
                Metadata: map[string]string{
                    "priority": fmt.Sprintf("%d", srv.Priority),
                    "weight":   fmt.Sprintf("%d", srv.Weight),
                    "target":   srv.Target,
                },
                Healthy: true,
            })
        }
    }

    if len(endpoints) == 0 {
        return nil, fmt.Errorf("SRV lookup for %q returned no resolvable endpoints", service)
    }

    // Update cache
    r.mu.Lock()
    oldEndpoints := r.cache[service].endpoints
    r.cache[service] = cacheEntry{
        endpoints: endpoints,
        expiry:    time.Now().Add(r.ttl),
    }
    r.mu.Unlock()

    // Notify watchers if endpoints changed
    if !endpointsEqual(oldEndpoints, endpoints) {
        r.notifyWatchers(service, endpoints)
    }

    return endpoints, nil
}

func (r *DNSResolver) Watch(ctx context.Context, service string) (<-chan []Endpoint, error) {
    ch := make(chan []Endpoint, 10)

    r.mu.Lock()
    r.watchers[service] = append(r.watchers[service], ch)
    r.mu.Unlock()

    // Send current state immediately
    if endpoints, err := r.Resolve(ctx, service); err == nil {
        select {
        case ch <- endpoints:
        default:
        }
    }

    // Clean up on context cancellation
    go func() {
        <-ctx.Done()
        r.mu.Lock()
        watchers := r.watchers[service]
        for i, w := range watchers {
            if w == ch {
                r.watchers[service] = append(watchers[:i], watchers[i+1:]...)
                break
            }
        }
        r.mu.Unlock()
        close(ch)
    }()

    return ch, nil
}

func (r *DNSResolver) notifyWatchers(service string, endpoints []Endpoint) {
    r.mu.RLock()
    watchers := make([]chan []Endpoint, len(r.watchers[service]))
    copy(watchers, r.watchers[service])
    r.mu.RUnlock()

    for _, ch := range watchers {
        select {
        case ch <- endpoints:
        default:
            r.logger.Warn("watcher channel full, dropping update",
                zap.String("service", service))
        }
    }
}

func (r *DNSResolver) refreshLoop(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-r.done:
            return
        case <-ticker.C:
            r.mu.RLock()
            services := make([]string, 0, len(r.cache))
            for svc := range r.cache {
                services = append(services, svc)
            }
            r.mu.RUnlock()

            for _, svc := range services {
                ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                if _, err := r.resolveAndCache(ctx, svc); err != nil {
                    r.logger.Warn("DNS refresh failed",
                        zap.String("service", svc),
                        zap.Error(err))
                }
                cancel()
            }
        }
    }
}

func (r *DNSResolver) Close() error {
    close(r.done)
    return nil
}

func endpointsEqual(a, b []Endpoint) bool {
    if len(a) != len(b) {
        return false
    }
    aMap := make(map[string]bool, len(a))
    for _, e := range a {
        aMap[e.Address] = true
    }
    for _, e := range b {
        if !aMap[e.Address] {
            return false
        }
    }
    return true
}
```

### 2.3 Kubernetes Headless Service SRV

For Kubernetes, headless services automatically generate SRV records:

```yaml
# headless-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: order-service
  namespace: production
spec:
  clusterIP: None  # headless
  selector:
    app: order-service
  ports:
    - name: grpc
      port: 9000
      targetPort: 9000
```

The SRV record becomes: `_grpc._tcp.order-service.production.svc.cluster.local`

```go
// Usage
resolver := dnsdiscovery.NewDNSResolver(dnsdiscovery.Config{
    DNSServer: "10.96.0.10:53",
    TTL:       30 * time.Second,
    Logger:    logger,
})

endpoints, err := resolver.Resolve(ctx, "_grpc._tcp.order-service.production.svc.cluster.local")
```

## Section 3: HashiCorp Consul Integration

### 3.1 Consul Service Discovery Client

```go
package consuldiscovery

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/hashicorp/consul/api"
    "github.com/hashicorp/consul/api/watch"
    "go.uber.org/zap"
)

type ConsulResolver struct {
    client  *api.Client
    logger  *zap.Logger

    mu       sync.RWMutex
    cache    map[string][]Endpoint
    watchers map[string][]chan []Endpoint

    plans map[string]*watch.Plan // consul watch plans
}

type ConsulConfig struct {
    Address    string // Consul agent address, e.g., "consul.service.consul:8500"
    Datacenter string
    Token      string // ACL token, passed as <consul-acl-token-placeholder>
    TLSConfig  *api.TLSConfig
    Logger     *zap.Logger
}

func NewConsulResolver(cfg ConsulConfig) (*ConsulResolver, error) {
    consulCfg := api.DefaultConfig()
    consulCfg.Address = cfg.Address
    consulCfg.Datacenter = cfg.Datacenter
    consulCfg.Token = cfg.Token

    if cfg.TLSConfig != nil {
        consulCfg.TLSConfig = *cfg.TLSConfig
    }

    client, err := api.NewClient(consulCfg)
    if err != nil {
        return nil, fmt.Errorf("creating Consul client: %w", err)
    }

    return &ConsulResolver{
        client:   client,
        logger:   cfg.Logger,
        cache:    make(map[string][]Endpoint),
        watchers: make(map[string][]chan []Endpoint),
        plans:    make(map[string]*watch.Plan),
    }, nil
}

func (r *ConsulResolver) Resolve(ctx context.Context, service string) ([]Endpoint, error) {
    r.mu.RLock()
    if endpoints, ok := r.cache[service]; ok {
        r.mu.RUnlock()
        return endpoints, nil
    }
    r.mu.RUnlock()

    return r.fetchHealthy(ctx, service)
}

func (r *ConsulResolver) fetchHealthy(ctx context.Context, service string) ([]Endpoint, error) {
    health := r.client.Health()

    var queryOpts api.QueryOptions
    if dl, ok := ctx.Deadline(); ok {
        queryOpts.WaitTime = time.Until(dl)
    }
    queryOpts = *queryOpts.WithContext(ctx)

    entries, _, err := health.Service(service, "", true, &queryOpts)
    if err != nil {
        return nil, fmt.Errorf("Consul health query for %q: %w", service, err)
    }

    endpoints := make([]Endpoint, 0, len(entries))
    for _, entry := range entries {
        addr := entry.Service.Address
        if addr == "" {
            addr = entry.Node.Address
        }
        endpoints = append(endpoints, Endpoint{
            Address: fmt.Sprintf("%s:%d", addr, entry.Service.Port),
            Metadata: mergeMaps(
                tagsToMap(entry.Service.Tags),
                entry.Service.Meta,
                map[string]string{
                    "node":       entry.Node.Node,
                    "datacenter": entry.Node.Datacenter,
                    "service_id": entry.Service.ID,
                },
            ),
            Healthy: true,
        })
    }

    r.mu.Lock()
    r.cache[service] = endpoints
    r.mu.Unlock()

    return endpoints, nil
}

func (r *ConsulResolver) Watch(ctx context.Context, service string) (<-chan []Endpoint, error) {
    ch := make(chan []Endpoint, 10)

    r.mu.Lock()
    r.watchers[service] = append(r.watchers[service], ch)
    needPlan := r.plans[service] == nil
    r.mu.Unlock()

    // Start a Consul watch plan for this service if not already running
    if needPlan {
        if err := r.startWatchPlan(service); err != nil {
            return nil, fmt.Errorf("starting Consul watch for %q: %w", service, err)
        }
    }

    // Send current state
    if endpoints, err := r.Resolve(ctx, service); err == nil {
        select {
        case ch <- endpoints:
        default:
        }
    }

    go func() {
        <-ctx.Done()
        r.mu.Lock()
        watchers := r.watchers[service]
        for i, w := range watchers {
            if w == ch {
                r.watchers[service] = append(watchers[:i], watchers[i+1:]...)
                break
            }
        }
        r.mu.Unlock()
        close(ch)
    }()

    return ch, nil
}

func (r *ConsulResolver) startWatchPlan(service string) error {
    params := map[string]interface{}{
        "type":    "service",
        "service": service,
        "passingonly": true,
    }

    plan, err := watch.Parse(params)
    if err != nil {
        return fmt.Errorf("parsing watch plan: %w", err)
    }

    plan.HybridHandler = func(blockParamVal watch.BlockingParamVal, rawVal interface{}) {
        entries, ok := rawVal.([]*api.ServiceEntry)
        if !ok {
            return
        }

        endpoints := make([]Endpoint, 0, len(entries))
        for _, entry := range entries {
            addr := entry.Service.Address
            if addr == "" {
                addr = entry.Node.Address
            }
            endpoints = append(endpoints, Endpoint{
                Address: fmt.Sprintf("%s:%d", addr, entry.Service.Port),
                Metadata: map[string]string{
                    "node":       entry.Node.Node,
                    "datacenter": entry.Node.Datacenter,
                },
                Healthy: true,
            })
        }

        r.mu.Lock()
        r.cache[service] = endpoints
        watchers := make([]chan []Endpoint, len(r.watchers[service]))
        copy(watchers, r.watchers[service])
        r.mu.Unlock()

        for _, ch := range watchers {
            select {
            case ch <- endpoints:
            default:
                r.logger.Warn("watcher channel full",
                    zap.String("service", service))
            }
        }
    }

    r.mu.Lock()
    r.plans[service] = plan
    r.mu.Unlock()

    go func() {
        if err := plan.RunWithClientAndHclog(r.client, nil); err != nil {
            r.logger.Error("Consul watch plan failed",
                zap.String("service", service),
                zap.Error(err))
        }
    }()

    return nil
}

func (r *ConsulResolver) Register(service, id, addr string, port int, tags []string, meta map[string]string) error {
    reg := &api.AgentServiceRegistration{
        ID:      id,
        Name:    service,
        Address: addr,
        Port:    port,
        Tags:    tags,
        Meta:    meta,
        Check: &api.AgentServiceCheck{
            Interval:                       "10s",
            Timeout:                        "3s",
            DeregisterCriticalServiceAfter: "30s",
            GRPC:                           fmt.Sprintf("%s:%d", addr, port),
            GRPCUseTLS:                     false,
        },
    }
    return r.client.Agent().ServiceRegister(reg)
}

func (r *ConsulResolver) Deregister(id string) error {
    return r.client.Agent().ServiceDeregister(id)
}

func (r *ConsulResolver) Close() error {
    r.mu.Lock()
    defer r.mu.Unlock()
    for _, plan := range r.plans {
        plan.Stop()
    }
    return nil
}

func tagsToMap(tags []string) map[string]string {
    m := make(map[string]string, len(tags))
    for _, tag := range tags {
        m["tag:"+tag] = tag
    }
    return m
}

func mergeMaps(maps ...map[string]string) map[string]string {
    result := make(map[string]string)
    for _, m := range maps {
        for k, v := range m {
            result[k] = v
        }
    }
    return result
}
```

## Section 4: Kubernetes Informer-Based Discovery

### 4.1 Informer Architecture

Kubernetes informers are the standard pattern for cache-consistent watching of API objects. The `client-go` library provides:

- `ListWatch`: lists all objects initially, then watches for changes
- `Informer`: maintains a local cache and calls event handlers
- `Lister`: provides read access to the informer's local cache

### 4.2 EndpointSlice-Based Resolver

```go
package k8sdiscovery

import (
    "context"
    "fmt"
    "sync"

    discoveryv1 "k8s.io/api/discovery/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/labels"
    "k8s.io/client-go/informers"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/cache"
    "go.uber.org/zap"
)

type K8sResolver struct {
    factory   informers.SharedInformerFactory
    informer  cache.SharedIndexInformer
    logger    *zap.Logger

    mu       sync.RWMutex
    watchers map[string][]chan []Endpoint
    cache    map[string][]Endpoint
}

type K8sConfig struct {
    Client    kubernetes.Interface
    Namespace string // watch a single namespace, or "" for all
    Logger    *zap.Logger
}

func NewK8sResolver(cfg K8sConfig) (*K8sResolver, error) {
    var factory informers.SharedInformerFactory
    if cfg.Namespace != "" {
        factory = informers.NewSharedInformerFactoryWithOptions(
            cfg.Client,
            0, // no resync
            informers.WithNamespace(cfg.Namespace),
        )
    } else {
        factory = informers.NewSharedInformerFactory(cfg.Client, 0)
    }

    sliceInformer := factory.Discovery().V1().EndpointSlices().Informer()

    r := &K8sResolver{
        factory:  factory,
        informer: sliceInformer,
        logger:   cfg.Logger,
        watchers: make(map[string][]chan []Endpoint),
        cache:    make(map[string][]Endpoint),
    }

    sliceInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc:    r.handleAdd,
        UpdateFunc: r.handleUpdate,
        DeleteFunc: r.handleDelete,
    })

    return r, nil
}

func (r *K8sResolver) Start(ctx context.Context) error {
    r.factory.Start(ctx.Done())

    // Wait for the informer cache to sync
    r.logger.Info("Waiting for Kubernetes EndpointSlice informer cache sync")
    if !cache.WaitForCacheSync(ctx.Done(), r.informer.HasSynced) {
        return fmt.Errorf("timed out waiting for EndpointSlice informer cache sync")
    }
    r.logger.Info("Kubernetes EndpointSlice informer cache synced")
    return nil
}

func serviceKey(namespace, name string) string {
    return namespace + "/" + name
}

func (r *K8sResolver) handleAdd(obj interface{}) {
    slice, ok := obj.(*discoveryv1.EndpointSlice)
    if !ok { return }
    r.updateFromSlice(slice)
}

func (r *K8sResolver) handleUpdate(oldObj, newObj interface{}) {
    slice, ok := newObj.(*discoveryv1.EndpointSlice)
    if !ok { return }
    r.updateFromSlice(slice)
}

func (r *K8sResolver) handleDelete(obj interface{}) {
    var slice *discoveryv1.EndpointSlice
    switch v := obj.(type) {
    case *discoveryv1.EndpointSlice:
        slice = v
    case cache.DeletedFinalStateUnknown:
        if s, ok := v.Obj.(*discoveryv1.EndpointSlice); ok {
            slice = s
        }
    }
    if slice == nil { return }

    svcName := slice.Labels[discoveryv1.LabelServiceName]
    if svcName == "" { return }

    key := serviceKey(slice.Namespace, svcName)
    r.rebuildFromInformer(key, slice.Namespace, svcName)
}

func (r *K8sResolver) updateFromSlice(slice *discoveryv1.EndpointSlice) {
    svcName := slice.Labels[discoveryv1.LabelServiceName]
    if svcName == "" { return }

    key := serviceKey(slice.Namespace, svcName)
    r.rebuildFromInformer(key, slice.Namespace, svcName)
}

func (r *K8sResolver) rebuildFromInformer(key, namespace, svcName string) {
    // Re-aggregate all slices for this service from the informer cache
    selector := labels.Set{
        discoveryv1.LabelServiceName: svcName,
    }.AsSelector()

    allSlices, err := r.factory.Discovery().V1().EndpointSlices().
        Lister().EndpointSlices(namespace).List(selector)
    if err != nil {
        r.logger.Error("listing EndpointSlices",
            zap.String("service", key), zap.Error(err))
        return
    }

    var endpoints []Endpoint
    for _, slice := range allSlices {
        for _, ep := range slice.Endpoints {
            if ep.Conditions.Ready != nil && !*ep.Conditions.Ready {
                continue
            }
            for _, addr := range ep.Addresses {
                for _, port := range slice.Ports {
                    if port.Port == nil { continue }
                    endpoints = append(endpoints, Endpoint{
                        Address: fmt.Sprintf("%s:%d", addr, *port.Port),
                        Metadata: map[string]string{
                            "namespace":  namespace,
                            "service":    svcName,
                            "protocol":   string(*port.Protocol),
                            "port_name":  portName(port.Name),
                            "node":       nodeName(ep.NodeName),
                            "zone":       zone(ep.Zone),
                        },
                        Healthy: true,
                    })
                }
            }
        }
    }

    r.mu.Lock()
    oldEndpoints := r.cache[key]
    r.cache[key] = endpoints
    watchers := make([]chan []Endpoint, len(r.watchers[key]))
    copy(watchers, r.watchers[key])
    r.mu.Unlock()

    if !endpointsEqual(oldEndpoints, endpoints) {
        r.logger.Info("service endpoints updated",
            zap.String("service", key),
            zap.Int("count", len(endpoints)))
        for _, ch := range watchers {
            select {
            case ch <- endpoints:
            default:
            }
        }
    }
}

func (r *K8sResolver) Resolve(ctx context.Context, service string) ([]Endpoint, error) {
    r.mu.RLock()
    if endpoints, ok := r.cache[service]; ok {
        r.mu.RUnlock()
        return endpoints, nil
    }
    r.mu.RUnlock()
    return nil, fmt.Errorf("service %q not found in discovery cache", service)
}

func (r *K8sResolver) Watch(ctx context.Context, service string) (<-chan []Endpoint, error) {
    ch := make(chan []Endpoint, 10)

    r.mu.Lock()
    r.watchers[service] = append(r.watchers[service], ch)
    current := r.cache[service]
    r.mu.Unlock()

    if len(current) > 0 {
        select {
        case ch <- current:
        default:
        }
    }

    go func() {
        <-ctx.Done()
        r.mu.Lock()
        watchers := r.watchers[service]
        for i, w := range watchers {
            if w == ch {
                r.watchers[service] = append(watchers[:i], watchers[i+1:]...)
                break
            }
        }
        r.mu.Unlock()
        close(ch)
    }()

    return ch, nil
}

func (r *K8sResolver) Close() error {
    r.factory.Shutdown()
    return nil
}

func portName(n *string) string {
    if n == nil { return "" }
    return *n
}

func nodeName(n *string) string {
    if n == nil { return "" }
    return *n
}

func zone(z *string) string {
    if z == nil { return "" }
    return *z
}
```

## Section 5: Watch-Based Connection Pool

### 5.1 Reactive gRPC Connection Pool

The watch mechanism feeds directly into a connection pool that maintains live connections to all current endpoints:

```go
package connpool

import (
    "context"
    "fmt"
    "math/rand"
    "sync"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"
    "go.uber.org/zap"
)

type GRPCPool struct {
    resolver Resolver
    service  string
    logger   *zap.Logger
    dialOpts []grpc.DialOption

    mu          sync.RWMutex
    connections map[string]*grpc.ClientConn // address -> connection
    endpoints   []Endpoint

    refreshC chan struct{}
    done     chan struct{}
}

type PoolConfig struct {
    Resolver Resolver
    Service  string
    Logger   *zap.Logger
    DialOpts []grpc.DialOption
}

func NewGRPCPool(cfg PoolConfig) (*GRPCPool, error) {
    defaultOpts := []grpc.DialOption{
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second,
            Timeout:             3 * time.Second,
            PermitWithoutStream: true,
        }),
        grpc.WithDefaultCallOptions(
            grpc.MaxCallRecvMsgSize(32 * 1024 * 1024),
        ),
    }

    pool := &GRPCPool{
        resolver:    cfg.Resolver,
        service:     cfg.Service,
        logger:      cfg.Logger,
        dialOpts:    append(defaultOpts, cfg.DialOpts...),
        connections: make(map[string]*grpc.ClientConn),
        refreshC:    make(chan struct{}, 1),
        done:        make(chan struct{}),
    }

    // Initial resolution
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    endpoints, err := cfg.Resolver.Resolve(ctx, cfg.Service)
    if err != nil {
        return nil, fmt.Errorf("initial service resolution failed: %w", err)
    }

    if err := pool.updateConnections(endpoints); err != nil {
        return nil, fmt.Errorf("initial connection pool setup: %w", err)
    }

    // Start watch goroutine
    go pool.watchLoop()

    return pool, nil
}

func (p *GRPCPool) watchLoop() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    go func() {
        <-p.done
        cancel()
    }()

    backoff := 1 * time.Second
    maxBackoff := 30 * time.Second

    for {
        updates, err := p.resolver.Watch(ctx, p.service)
        if err != nil {
            select {
            case <-p.done:
                return
            default:
            }
            p.logger.Error("watch failed, retrying",
                zap.String("service", p.service),
                zap.Duration("backoff", backoff),
                zap.Error(err))
            time.Sleep(backoff)
            backoff *= 2
            if backoff > maxBackoff {
                backoff = maxBackoff
            }
            continue
        }

        backoff = 1 * time.Second // reset on successful watch

        for {
            select {
            case <-p.done:
                return
            case endpoints, ok := <-updates:
                if !ok {
                    // Channel closed, restart watch
                    goto restart
                }
                p.logger.Info("endpoint update received",
                    zap.String("service", p.service),
                    zap.Int("endpoints", len(endpoints)))
                if err := p.updateConnections(endpoints); err != nil {
                    p.logger.Error("connection update failed",
                        zap.Error(err))
                }
            }
        }
    restart:
    }
}

func (p *GRPCPool) updateConnections(endpoints []Endpoint) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    newAddrs := make(map[string]bool)
    for _, ep := range endpoints {
        newAddrs[ep.Address] = true
    }

    // Add new connections
    for addr := range newAddrs {
        if _, exists := p.connections[addr]; !exists {
            conn, err := grpc.Dial(addr, p.dialOpts...)
            if err != nil {
                p.logger.Error("failed to dial endpoint",
                    zap.String("address", addr),
                    zap.Error(err))
                continue
            }
            p.connections[addr] = conn
            p.logger.Info("added connection to pool",
                zap.String("address", addr))
        }
    }

    // Remove stale connections
    for addr, conn := range p.connections {
        if !newAddrs[addr] {
            conn.Close()
            delete(p.connections, addr)
            p.logger.Info("removed stale connection from pool",
                zap.String("address", addr))
        }
    }

    p.endpoints = endpoints
    return nil
}

// Pick returns a single gRPC connection using random load balancing.
func (p *GRPCPool) Pick() (*grpc.ClientConn, error) {
    p.mu.RLock()
    defer p.mu.RUnlock()

    if len(p.connections) == 0 {
        return nil, fmt.Errorf("no connections available for service %q", p.service)
    }

    addrs := make([]string, 0, len(p.connections))
    for addr := range p.connections {
        addrs = append(addrs, addr)
    }

    addr := addrs[rand.Intn(len(addrs))]
    return p.connections[addr], nil
}

// PickByZone returns a connection in the preferred zone if available,
// falling back to any available connection.
func (p *GRPCPool) PickByZone(preferredZone string) (*grpc.ClientConn, error) {
    p.mu.RLock()
    defer p.mu.RUnlock()

    if len(p.connections) == 0 {
        return nil, fmt.Errorf("no connections available for service %q", p.service)
    }

    // Filter by zone
    var zoneAddrs []string
    for _, ep := range p.endpoints {
        if ep.Metadata["zone"] == preferredZone {
            if _, ok := p.connections[ep.Address]; ok {
                zoneAddrs = append(zoneAddrs, ep.Address)
            }
        }
    }

    if len(zoneAddrs) > 0 {
        addr := zoneAddrs[rand.Intn(len(zoneAddrs))]
        return p.connections[addr], nil
    }

    // Fall back to any connection
    addrs := make([]string, 0, len(p.connections))
    for addr := range p.connections {
        addrs = append(addrs, addr)
    }
    addr := addrs[rand.Intn(len(addrs))]
    return p.connections[addr], nil
}

func (p *GRPCPool) Size() int {
    p.mu.RLock()
    defer p.mu.RUnlock()
    return len(p.connections)
}

func (p *GRPCPool) Close() error {
    close(p.done)

    p.mu.Lock()
    defer p.mu.Unlock()

    var lastErr error
    for addr, conn := range p.connections {
        if err := conn.Close(); err != nil {
            p.logger.Error("error closing connection",
                zap.String("address", addr),
                zap.Error(err))
            lastErr = err
        }
    }
    return lastErr
}
```

## Section 6: Caching and Circuit Breaking

### 6.1 Circuit Breaker Integration

```go
package circuitbreaker

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type State int

const (
    StateClosed   State = iota // normal operation
    StateOpen                  // failing, reject fast
    StateHalfOpen              // testing recovery
)

type CircuitBreaker struct {
    mu             sync.Mutex
    state          State
    failures       int
    successes      int
    lastStateChange time.Time

    maxFailures    int
    timeout        time.Duration
    halfOpenProbes int
}

func NewCircuitBreaker(maxFailures int, timeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        state:          StateClosed,
        maxFailures:    maxFailures,
        timeout:        timeout,
        halfOpenProbes: 3,
        lastStateChange: time.Now(),
    }
}

func (cb *CircuitBreaker) Allow() (bool, func(success bool)) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        return true, cb.recordResult
    case StateOpen:
        if time.Since(cb.lastStateChange) >= cb.timeout {
            cb.state = StateHalfOpen
            cb.successes = 0
            cb.failures = 0
            return true, cb.recordResult
        }
        return false, nil
    case StateHalfOpen:
        if cb.successes+cb.failures < cb.halfOpenProbes {
            return true, cb.recordResult
        }
        return false, nil
    }
    return false, nil
}

func (cb *CircuitBreaker) recordResult(success bool) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if success {
        cb.successes++
        cb.failures = 0
        if cb.state == StateHalfOpen && cb.successes >= cb.halfOpenProbes {
            cb.state = StateClosed
            cb.lastStateChange = time.Now()
        }
    } else {
        cb.failures++
        cb.successes = 0
        if cb.failures >= cb.maxFailures {
            cb.state = StateOpen
            cb.lastStateChange = time.Now()
        }
    }
}

// ResilientPool wraps a GRPCPool with per-endpoint circuit breakers.
type ResilientPool struct {
    pool     *GRPCPool
    breakers sync.Map // address -> *CircuitBreaker
}

func (rp *ResilientPool) CallWithCircuitBreaker(
    ctx context.Context,
    addr string,
    fn func(conn *grpc.ClientConn) error,
) error {
    cbVal, _ := rp.breakers.LoadOrStore(addr, NewCircuitBreaker(5, 30*time.Second))
    cb := cbVal.(*CircuitBreaker)

    allowed, record := cb.Allow()
    if !allowed {
        return fmt.Errorf("circuit breaker open for %s", addr)
    }

    conn, err := rp.pool.Pick()
    if err != nil {
        if record != nil { record(false) }
        return err
    }

    err = fn(conn)
    if record != nil {
        record(err == nil)
    }
    return err
}
```

## Section 7: Production Patterns

### 7.1 Health-Based Filtering

```go
// Integrate with health checking
type HealthCheckingResolver struct {
    base     Resolver
    checker  HealthChecker
    interval time.Duration
}

type HealthChecker interface {
    Check(ctx context.Context, addr string) error
}

func (r *HealthCheckingResolver) startHealthChecks(service string, endpoints []Endpoint) {
    for _, ep := range endpoints {
        go func(addr string) {
            ticker := time.NewTicker(r.interval)
            defer ticker.Stop()
            for range ticker.C {
                ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
                err := r.checker.Check(ctx, addr)
                cancel()
                if err != nil {
                    // Remove from active endpoints via watch notification
                    r.markUnhealthy(service, addr)
                }
            }
        }(ep.Address)
    }
}
```

### 7.2 Topology-Aware Load Balancing

```go
// Prefer endpoints in the same availability zone
func ZoneAwareBalancer(endpoints []Endpoint, localZone string) Endpoint {
    // Tier 1: same zone
    var local []Endpoint
    for _, ep := range endpoints {
        if ep.Metadata["zone"] == localZone {
            local = append(local, ep)
        }
    }
    if len(local) > 0 {
        return local[rand.Intn(len(local))]
    }

    // Tier 2: any endpoint (cross-zone fallback)
    return endpoints[rand.Intn(len(endpoints))]
}
```

## Summary

Service discovery in Go requires choosing the right mechanism for your infrastructure:

- **DNS SRV** works in any environment, requires no additional dependencies, and integrates natively with Kubernetes headless services; TTL-based caching with proactive refresh handles the latency-correctness tradeoff
- **Consul** provides rich health checking, service metadata, multi-datacenter support, and watch-based push updates; the watch plan abstraction delivers sub-second endpoint update propagation
- **Kubernetes informers** offer the highest-fidelity view of endpoint state by mirroring the API server cache locally; EndpointSlice informers are more scalable than the legacy Endpoints informer at large cluster sizes
- **Watch-based connection pools** combine any of the above resolvers with reactive connection management, avoiding the overhead of per-request resolution

The common Resolver interface allows the connection pool and load balancing layers to be written once and operated against any discovery backend.
