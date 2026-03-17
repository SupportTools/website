---
title: "Kubernetes Headless Services and DNS: StatefulSet Service Discovery Internals"
date: 2029-09-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "DNS", "StatefulSet", "Service Discovery", "Networking", "CoreDNS"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes headless services, DNS record mechanics for StatefulSets, SRV records, pod hostname and subdomain configuration, stable network identity, and client-side load balancing patterns."
more_link: "yes"
url: "/kubernetes-headless-services-dns-statefulset-discovery/"
---

Kubernetes headless services unlock a class of distributed system patterns that ClusterIP services simply cannot support. When you deploy a StatefulSet and need each pod to have a stable, individually addressable DNS name, headless services are the mechanism that makes it work. This post examines the DNS internals in depth, covering how CoreDNS generates records for headless services, what SRV records look like and when to use them, how pod hostname and subdomain fields compose into fully qualified domain names, and how client-side load balancing replaces kube-proxy in this topology.

<!--more-->

# Kubernetes Headless Services and DNS: StatefulSet Service Discovery Internals

## What Makes a Service Headless

A service becomes headless by setting `clusterIP: None` in its spec. This single field change alters the entire traffic path:

- No virtual IP is allocated
- kube-proxy does not configure iptables or ipvs rules for the service
- CoreDNS returns individual pod IP addresses rather than a single stable VIP
- Clients resolve DNS and connect directly to pods

```yaml
apiVersion: v1
kind: Service
metadata:
  name: cassandra
  namespace: data
  labels:
    app: cassandra
spec:
  clusterIP: None           # This is the defining characteristic
  selector:
    app: cassandra
  ports:
    - name: cql
      port: 9042
      targetPort: 9042
    - name: intra-node
      port: 7000
      targetPort: 7000
    - name: tls-intra-node
      port: 7001
      targetPort: 7001
    - name: jmx
      port: 7199
      targetPort: 7199
```

Compare the kube-proxy behavior difference. With a standard ClusterIP service:

```
$ kubectl get svc cassandra
NAME        TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
cassandra   ClusterIP   10.96.134.201   <none>        9042/TCP   5m

# iptables has a DNAT chain for this VIP
$ iptables -t nat -L KUBE-SERVICES | grep cassandra
KUBE-SVC-XXXX  tcp  --  anywhere  10.96.134.201  tcp dpt:9042
```

With a headless service:

```
$ kubectl get svc cassandra
NAME        TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)    AGE
cassandra   ClusterIP   None         <none>        9042/TCP   5m

# No iptables rules exist for this service
$ iptables -t nat -L KUBE-SERVICES | grep cassandra
# (empty)
```

## DNS Record Types for Headless Services

CoreDNS generates fundamentally different record sets for headless services. Understanding the record types is essential for designing service discovery correctly.

### A Records: One per Pod

For a headless service with a selector, CoreDNS returns one A record per ready pod endpoint:

```
$ kubectl exec -it debug-pod -- nslookup cassandra.data.svc.cluster.local
Server:         10.96.0.10
Address:        10.96.0.10#53

Name:    cassandra.data.svc.cluster.local
Address: 10.244.1.5
Address: 10.244.2.7
Address: 10.244.3.11
```

This is the multi-A response that enables client-side load balancing. The client receives all endpoints and chooses which to connect to. For comparison, a ClusterIP service returns only the VIP:

```
$ kubectl exec -it debug-pod -- nslookup my-service.default.svc.cluster.local
Name:    my-service.default.svc.cluster.local
Address: 10.96.134.201    # Single VIP, always
```

### Per-Pod DNS Records for StatefulSets

StatefulSets compose pod-level DNS names using the pod's hostname and the service's subdomain. The format is:

```
<pod-hostname>.<headless-service-name>.<namespace>.svc.<cluster-domain>
```

For a StatefulSet named `cassandra` with a headless service also named `cassandra`:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: data
spec:
  serviceName: cassandra      # Must match the headless service name
  replicas: 3
  selector:
    matchLabels:
      app: cassandra
  template:
    metadata:
      labels:
        app: cassandra
    spec:
      containers:
        - name: cassandra
          image: cassandra:4.1
          ports:
            - containerPort: 9042
              name: cql
```

The pods receive hostnames `cassandra-0`, `cassandra-1`, `cassandra-2`. CoreDNS then creates:

```
cassandra-0.cassandra.data.svc.cluster.local -> 10.244.1.5
cassandra-1.cassandra.data.svc.cluster.local -> 10.244.2.7
cassandra-2.cassandra.data.svc.cluster.local -> 10.244.3.11
```

Verify from within the cluster:

```
$ kubectl exec -it cassandra-0 -n data -- nslookup cassandra-0.cassandra.data.svc.cluster.local
Name:    cassandra-0.cassandra.data.svc.cluster.local
Address: 10.244.1.5

$ kubectl exec -it cassandra-0 -n data -- nslookup cassandra-1.cassandra.data.svc.cluster.local
Name:    cassandra-1.cassandra.data.svc.cluster.local
Address: 10.244.2.7
```

## SRV Records: Port and Target Discovery

SRV records encode service port information alongside target hostnames. Kubernetes generates SRV records for named ports on headless services.

### SRV Record Format

The query format for SRV records is:

```
_<port-name>._<protocol>.<service>.<namespace>.svc.<cluster-domain>
```

For the Cassandra service with a named port `cql`:

```
$ kubectl exec -it debug-pod -- dig _cql._tcp.cassandra.data.svc.cluster.local SRV

;; ANSWER SECTION:
_cql._tcp.cassandra.data.svc.cluster.local. 30 IN SRV 0 33 9042 cassandra-0.cassandra.data.svc.cluster.local.
_cql._tcp.cassandra.data.svc.cluster.local. 30 IN SRV 0 33 9042 cassandra-1.cassandra.data.svc.cluster.local.
_cql._tcp.cassandra.data.svc.cluster.local. 30 IN SRV 0 33 9042 cassandra-2.cassandra.data.svc.cluster.local.

;; ADDITIONAL SECTION:
cassandra-0.cassandra.data.svc.cluster.local. 30 IN A 10.244.1.5
cassandra-1.cassandra.data.svc.cluster.local. 30 IN A 10.244.2.7
cassandra-2.cassandra.data.svc.cluster.local. 30 IN A 10.244.3.11
```

The SRV record fields are: priority, weight, port, target. The additional section provides the A records so clients can resolve in one round trip.

### Using SRV Records in Go

Go's `net` package can perform SRV lookups directly:

```go
package main

import (
    "context"
    "fmt"
    "net"
    "time"
)

type CassandraDiscovery struct {
    service   string
    namespace string
    domain    string
    resolver  *net.Resolver
}

func NewCassandraDiscovery(service, namespace string) *CassandraDiscovery {
    return &CassandraDiscovery{
        service:   service,
        namespace: namespace,
        domain:    "cluster.local",
        resolver:  net.DefaultResolver,
    }
}

// DiscoverNodes returns host:port pairs for all Cassandra nodes via SRV lookup
func (d *CassandraDiscovery) DiscoverNodes(ctx context.Context) ([]string, error) {
    srvName := fmt.Sprintf("_cql._tcp.%s.%s.svc.%s", d.service, d.namespace, d.domain)

    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    _, srvRecords, err := d.resolver.LookupSRV(ctx, "cql", "tcp",
        fmt.Sprintf("%s.%s.svc.%s", d.service, d.namespace, d.domain))
    if err != nil {
        return nil, fmt.Errorf("SRV lookup failed for %s: %w", srvName, err)
    }

    nodes := make([]string, 0, len(srvRecords))
    for _, srv := range srvRecords {
        // SRV Target includes trailing dot; trim it
        target := srv.Target
        if len(target) > 0 && target[len(target)-1] == '.' {
            target = target[:len(target)-1]
        }
        nodes = append(nodes, fmt.Sprintf("%s:%d", target, srv.Port))
    }

    return nodes, nil
}

func main() {
    disc := NewCassandraDiscovery("cassandra", "data")
    ctx := context.Background()

    nodes, err := disc.DiscoverNodes(ctx)
    if err != nil {
        panic(err)
    }

    fmt.Println("Discovered Cassandra nodes:")
    for _, node := range nodes {
        fmt.Printf("  %s\n", node)
    }
}
```

## Pod Hostname and Subdomain Configuration

Beyond StatefulSets, any pod can be configured with explicit hostname and subdomain fields to receive a stable DNS entry.

### Manual Pod DNS Configuration

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: custom-node
  namespace: infra
spec:
  hostname: node-primary        # Sets the pod's hostname
  subdomain: cluster-nodes      # Must match a headless service name
  containers:
    - name: app
      image: myapp:latest
```

With a matching headless service named `cluster-nodes` in the `infra` namespace, this pod receives:

```
node-primary.cluster-nodes.infra.svc.cluster.local
```

The subdomain field must match an existing headless service with `publishNotReadyAddresses: true` if you want the DNS entry to exist before the pod is ready.

### publishNotReadyAddresses: Critical for Clustering

Many distributed systems (Zookeeper, etcd, Cassandra) need to resolve peer addresses during their startup sequence — before they pass readiness probes. The `publishNotReadyAddresses` field addresses this:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: zookeeper-headless
  namespace: data
spec:
  clusterIP: None
  publishNotReadyAddresses: true    # Publish DNS records even when pods aren't ready
  selector:
    app: zookeeper
  ports:
    - name: client
      port: 2181
    - name: follower
      port: 2888
    - name: election
      port: 3888
```

Without this, `zookeeper-0.zookeeper-headless.data.svc.cluster.local` won't resolve until zookeeper-0 passes its readiness probe — but zookeeper-0 can't pass its readiness probe until it can contact its peers, creating a deadlock.

## CoreDNS Configuration for Headless Services

Understanding how CoreDNS handles headless service records helps with debugging and optimization.

### CoreDNS Corefile

```
$ kubectl get configmap coredns -n kube-system -o yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health {
           lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf {
           max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
```

The `kubernetes` plugin handles both service and pod DNS. The `pods insecure` directive enables pod-level DNS records (the `<pod-ip>.<namespace>.pod.cluster.local` format). The `ttl 30` means DNS records expire in 30 seconds — critical for failover timing.

### CoreDNS Metrics for Debugging

```bash
# Check CoreDNS request rates by record type
kubectl exec -n kube-system -it coredns-xxxx -- \
  wget -qO- http://localhost:9153/metrics | grep coredns_dns_requests_total

# Look for SRV vs A record distributions
kubectl exec -n kube-system -it coredns-xxxx -- \
  wget -qO- http://localhost:9153/metrics | \
  grep 'coredns_dns_requests_total.*type="SRV"'
```

### Debugging DNS Resolution

```bash
# Deploy a debug pod with dig/nslookup
kubectl run dnsutils --image=registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3 \
  --restart=Never --rm -it -- bash

# Full DNS trace for a headless service
dig +search +noall +answer cassandra.data.svc.cluster.local

# Trace SRV record resolution
dig +search _cql._tcp.cassandra.data.svc.cluster.local SRV

# Check if per-pod records exist
for i in 0 1 2; do
  echo "cassandra-$i:"
  dig +short cassandra-$i.cassandra.data.svc.cluster.local
done

# Reverse lookup
dig +short -x 10.244.1.5
```

## Client-Side Load Balancing Patterns

With headless services, the client receives multiple IP addresses and must select which to use. Several patterns exist depending on the use case.

### Round-Robin DNS (Naive)

The simplest approach: resolve the service name, get all IPs, connect to a random one. Go's `net.Dial` does this automatically when given a hostname that resolves to multiple A records. However, this approach has connection-level granularity — once a TCP connection is established it stays with one backend.

```go
package main

import (
    "context"
    "net/http"
    "time"
)

func NewRoundRobinClient(serviceURL string) *http.Client {
    transport := &http.Transport{
        // Go's default resolver will pick a random A record on each new connection
        MaxIdleConnsPerHost: 10,
        IdleConnTimeout:     90 * time.Second,
        // Force new connections periodically so round-robin actually works
        MaxIdleConns:        100,
    }

    return &http.Client{
        Transport: transport,
        Timeout:   30 * time.Second,
    }
}
```

### Consistent Hashing for Stateful Workloads

For databases like Cassandra where data is partitioned, you need to route requests to specific nodes based on the partition key:

```go
package main

import (
    "context"
    "crypto/sha256"
    "encoding/binary"
    "fmt"
    "net"
    "sort"
    "sync"
    "time"
)

type ConsistentHashBalancer struct {
    mu          sync.RWMutex
    ring        []uint64
    nodeMap     map[uint64]string
    replicas    int
    serviceFQDN string
    refreshTick *time.Ticker
}

func NewConsistentHashBalancer(serviceFQDN string, replicas int) *ConsistentHashBalancer {
    b := &ConsistentHashBalancer{
        nodeMap:     make(map[uint64]string),
        replicas:    replicas,
        serviceFQDN: serviceFQDN,
        refreshTick: time.NewTicker(30 * time.Second),
    }
    b.refresh(context.Background())
    go b.refreshLoop()
    return b
}

func (b *ConsistentHashBalancer) refreshLoop() {
    for range b.refreshTick.C {
        b.refresh(context.Background())
    }
}

func (b *ConsistentHashBalancer) refresh(ctx context.Context) {
    addrs, err := net.DefaultResolver.LookupHost(ctx, b.serviceFQDN)
    if err != nil {
        return
    }

    ring := make([]uint64, 0, len(addrs)*b.replicas)
    nodeMap := make(map[uint64]string, len(addrs)*b.replicas)

    for _, addr := range addrs {
        for i := 0; i < b.replicas; i++ {
            key := b.hash(fmt.Sprintf("%s-%d", addr, i))
            ring = append(ring, key)
            nodeMap[key] = addr
        }
    }

    sort.Slice(ring, func(i, j int) bool { return ring[i] < ring[j] })

    b.mu.Lock()
    b.ring = ring
    b.nodeMap = nodeMap
    b.mu.Unlock()
}

func (b *ConsistentHashBalancer) hash(key string) uint64 {
    h := sha256.Sum256([]byte(key))
    return binary.BigEndian.Uint64(h[:8])
}

func (b *ConsistentHashBalancer) GetNode(key string) (string, error) {
    b.mu.RLock()
    defer b.mu.RUnlock()

    if len(b.ring) == 0 {
        return "", fmt.Errorf("no nodes available")
    }

    h := b.hash(key)
    idx := sort.Search(len(b.ring), func(i int) bool {
        return b.ring[i] >= h
    })

    if idx == len(b.ring) {
        idx = 0
    }

    return b.nodeMap[b.ring[idx]], nil
}
```

### gRPC Client-Side Load Balancing with Headless Services

gRPC has native support for client-side load balancing using the `round_robin` policy. When combined with a headless service, gRPC resolves all pod addresses and distributes requests at the RPC level:

```go
package main

import (
    "context"
    "fmt"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/balancer/roundrobin"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/resolver"
)

func NewGRPCConnection(headlessService, namespace, port string) (*grpc.ClientConn, error) {
    // Use dns:/// scheme to trigger multi-A record resolution
    target := fmt.Sprintf("dns:///%s.%s.svc.cluster.local:%s",
        headlessService, namespace, port)

    conn, err := grpc.NewClient(
        target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithDefaultServiceConfig(fmt.Sprintf(`{
            "loadBalancingConfig": [{"%s": {}}],
            "methodConfig": [{
                "name": [{"service": ""}],
                "retryPolicy": {
                    "maxAttempts": 3,
                    "initialBackoff": "0.1s",
                    "maxBackoff": "1s",
                    "backoffMultiplier": 2.0,
                    "retryableStatusCodes": ["UNAVAILABLE"]
                }
            }]
        }`, roundrobin.Name)),
        grpc.WithResolvers(resolver.NewDefaultScheme()),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create gRPC connection: %w", err)
    }

    return conn, nil
}
```

## Stable Network Identity After Pod Restarts

One of the key properties of StatefulSets is that pod identity is preserved across restarts. When `cassandra-1` is killed, the replacement pod gets the same hostname and — after the DNS TTL expires — the same DNS name pointing to the new pod IP.

### DNS TTL and Reconnection Behavior

The default TTL of 30 seconds means clients may connect to stale IPs for up to 30 seconds after a pod restart. For long-lived connections, this is not relevant — clients detect the broken connection and reconnect. For short-lived connection pooling, it matters more.

```go
package main

import (
    "context"
    "net"
    "sync"
    "time"
)

// RefreshingResolver periodically re-resolves DNS to detect pod IP changes
type RefreshingResolver struct {
    mu       sync.RWMutex
    addrs    map[string][]string
    interval time.Duration
    resolver *net.Resolver
}

func NewRefreshingResolver(interval time.Duration) *RefreshingResolver {
    r := &RefreshingResolver{
        addrs:    make(map[string][]string),
        interval: interval,
        resolver: &net.Resolver{
            PreferGo: true,
            Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
                d := net.Dialer{Timeout: 5 * time.Second}
                // Connect directly to CoreDNS
                return d.DialContext(ctx, "udp", "10.96.0.10:53")
            },
        },
    }
    return r
}

func (r *RefreshingResolver) Track(hostname string) {
    r.resolve(hostname)
    go func() {
        ticker := time.NewTicker(r.interval)
        defer ticker.Stop()
        for range ticker.C {
            r.resolve(hostname)
        }
    }()
}

func (r *RefreshingResolver) resolve(hostname string) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    addrs, err := r.resolver.LookupHost(ctx, hostname)
    if err != nil {
        return
    }

    r.mu.Lock()
    r.addrs[hostname] = addrs
    r.mu.Unlock()
}

func (r *RefreshingResolver) Addrs(hostname string) []string {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return r.addrs[hostname]
}
```

## Headless Services Without Selectors

A headless service can be created without a selector. In this case, CoreDNS does not auto-populate endpoints — you manage them manually via Endpoints or EndpointSlice resources.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-kafka
  namespace: streaming
spec:
  clusterIP: None
  ports:
    - name: kafka
      port: 9092
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: external-kafka-eps
  namespace: streaming
  labels:
    kubernetes.io/service-name: external-kafka
addressType: IPv4
endpoints:
  - addresses:
      - "192.168.10.51"
    conditions:
      ready: true
  - addresses:
      - "192.168.10.52"
    conditions:
      ready: true
  - addresses:
      - "192.168.10.53"
    conditions:
      ready: true
ports:
  - name: kafka
    port: 9092
    protocol: TCP
```

This pattern integrates external services into the cluster's DNS namespace, giving in-cluster clients a stable DNS name for external infrastructure.

## Production Considerations

### ndots and Search Domains

Kubernetes pods have `ndots: 5` configured in `/etc/resolv.conf`, meaning any name with fewer than 5 dots triggers a search through the configured search domains before attempting the absolute FQDN. For a headless service lookup, this means:

```
cassandra.data
  -> cassandra.data.default.svc.cluster.local  (fails)
  -> cassandra.data.svc.cluster.local           (fails)
  -> cassandra.data.cluster.local               (fails)
  -> cassandra.data                             (fails, becomes FQDN with trailing dot)
```

Use FQDNs with a trailing dot in performance-sensitive code to avoid the search domain traversal:

```go
// Instead of:
addrs, _ := net.LookupHost("cassandra.data.svc.cluster.local")

// Use FQDN with trailing dot:
addrs, _ := net.LookupHost("cassandra.data.svc.cluster.local.")
```

### DNS Caching at the Node Level

Each node runs a `node-local-dns` cache (in clusters with it enabled) that reduces CoreDNS load. Pods are directed to the node-local cache via iptables. The cache stores negative results too, so failed lookups are cached for `ncache` seconds.

```bash
# Check if node-local-dns is running
kubectl get daemonset node-local-dns -n kube-system

# View the node-local-dns configmap
kubectl get configmap node-local-dns -n kube-system -o yaml
```

### Monitoring Headless Service DNS Health

```yaml
# PrometheusRule for DNS health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: coredns-headless-alerts
  namespace: monitoring
spec:
  groups:
    - name: coredns.headless
      rules:
        - alert: CoreDNSHighErrorRate
          expr: |
            rate(coredns_dns_responses_total{rcode="SERVFAIL"}[5m]) > 0.05
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "CoreDNS SERVFAIL rate above 5%"

        - alert: HeadlessServiceNoEndpoints
          expr: |
            kube_endpoint_info{namespace="data",endpoint="cassandra"} == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Headless service cassandra has no endpoints"
```

## Summary

Headless services combined with StatefulSets provide the foundation for running distributed stateful systems on Kubernetes. The DNS internals — A records per pod, SRV records for port discovery, per-pod FQDN composition — give clients the information they need to implement topology-aware routing. Key takeaways:

- Set `clusterIP: None` to make a service headless
- The `serviceName` field in StatefulSpec must match the headless service name
- `publishNotReadyAddresses: true` prevents bootstrap deadlocks in clustering protocols
- SRV records encode port numbers and require named ports in the service spec
- Client-side load balancing strategies range from simple round-robin DNS to consistent hashing
- Use FQDNs with trailing dots in performance-sensitive paths to skip search domain traversal
- The default DNS TTL of 30 seconds governs how quickly clients detect pod IP changes
