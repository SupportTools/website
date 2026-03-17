---
title: "Kubernetes Multi-Cluster Service Discovery with Submariner and Skupper"
date: 2031-01-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Cluster", "Submariner", "Skupper", "Service Discovery", "Networking", "Hybrid Cloud"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes multi-cluster service discovery covering Submariner gateway and broker architecture, cross-cluster service export and import, Skupper virtual application networks, DNS-based vs VIP-based routing, and hybrid cloud connectivity patterns."
more_link: "yes"
url: "/kubernetes-multi-cluster-service-discovery-submariner-skupper/"
---

Running applications across multiple Kubernetes clusters is the reality for organizations operating in hybrid cloud, multi-region, or air-gapped environments. The challenge is enabling services in one cluster to discover and communicate with services in another without requiring full network mesh connectivity, managing complex VPN configurations, or accepting the operational overhead of duplicating services. Submariner and Skupper represent two philosophically distinct approaches to this problem, each excelling in different operational contexts. This guide provides production-ready implementations of both.

<!--more-->

# Kubernetes Multi-Cluster Service Discovery with Submariner and Skupper

## Section 1: Multi-Cluster Networking Fundamentals

### The Multi-Cluster Connectivity Problem

In a single Kubernetes cluster, services communicate via the cluster's flat network: every pod can reach every other pod (subject to NetworkPolicy), and DNS resolves service names to ClusterIPs automatically.

Across clusters, this breaks down:

1. **Routing**: Pod CIDRs in different clusters may overlap, and there is no default route between clusters
2. **Service Discovery**: DNS in cluster A does not resolve services in cluster B
3. **Authentication**: mTLS between clusters requires shared or federated certificate authority
4. **Network Policy**: Policies defined in cluster A have no effect on traffic in cluster B

The two approaches:

**Submariner**: Network-level solution. Creates encrypted tunnels between clusters. Services are accessible by IP or DNS. Full L3/L4 connectivity. Requires compatible (non-overlapping by default) pod and service CIDRs.

**Skupper**: Application-level solution. Proxies only the declared services over HTTP/2 (AMQP router protocol). No L3 routing changes required. Works across overlapping CIDRs, NAT, firewalls. Higher overhead per connection.

## Section 2: Submariner Architecture

### Component Overview

```
Cluster A                          Cluster B
┌────────────────────────┐         ┌────────────────────────┐
│                        │         │                        │
│  ┌──────────────────┐  │         │  ┌──────────────────┐  │
│  │ Broker (Passive) │  │         │  │ Gateway Node     │  │
│  │ (may be shared   │  │◄───────►│  │ - engine         │  │
│  │  or in cluster A)│  │ IPSec/  │  │ - route-agent    │  │
│  └──────────────────┘  │ WireGuard│  └──────────────────┘  │
│                        │ Tunnel  │                        │
│  ┌──────────────────┐  │         │  ┌──────────────────┐  │
│  │ Gateway Node     │  │         │  │ Service Discovery│  │
│  │ - engine         │  │         │  │ lighthouse-agent │  │
│  │ - route-agent    │  │         │  │ lighthouse-coredns│  │
│  └──────────────────┘  │         │  └──────────────────┘  │
│                        │         │                        │
│  ┌──────────────────┐  │         │  ServiceImport:        │
│  │ ServiceExport:   │  │         │  frontend.default.     │
│  │ backend.default  │  │         │  svc.clusterset.local  │
│  └──────────────────┘  │         │  → routes to cluster A │
└────────────────────────┘         └────────────────────────┘
                    │
                    ▼
              Broker (etcd-like)
              stores ServiceImport,
              ServiceExport, Endpoint
              information
```

### Installing Submariner

```bash
# Install subctl (Submariner CLI)
curl -Ls https://get.submariner.io | bash

# Broker cluster: the cluster that stores cross-cluster service information
# This can be a dedicated cluster or one of the application clusters
kubectl config use-context broker-cluster
subctl deploy-broker \
    --kubeconfig ~/.kube/config \
    --globalnet  # Enable if pod CIDRs overlap between clusters

# Join cluster A to the broker
kubectl config use-context cluster-a
subctl join broker-info.subm \
    --kubeconfig ~/.kube/config \
    --clusterid cluster-a \
    --natt=false \  # Disable NAT traversal if direct connectivity exists
    --cable-driver libreswan  # or wireguard, vxlan

# Join cluster B
kubectl config use-context cluster-b
subctl join broker-info.subm \
    --kubeconfig ~/.kube/config \
    --clusterid cluster-b \
    --natt=false \
    --cable-driver libreswan

# Verify connectivity
subctl verify --context cluster-a --tocontext cluster-b --verbose
```

### Gateway Node Requirements

Submariner gateway nodes need specific capabilities:

```yaml
# Node labels for gateway selection
kubectl label node gateway-node-1 submariner.io/gateway=true
kubectl annotate node gateway-node-1 submariner.io/public-ip=<public-ip>

# Submariner needs these ports open:
# UDP 4500 (IPsec NAT traversal)
# UDP 4800 (Submariner Encapsulation - VXLAN fallback)
# UDP 500 (IPsec IKE)
# TCP 8080 (metrics)
```

### Gatewway HA Configuration

```yaml
# config/submariner-operator.yaml
apiVersion: submariner.io/v1alpha1
kind: Submariner
metadata:
  name: submariner
  namespace: submariner-operator
spec:
  # Enable gateway HA: multiple gateways with active/passive failover
  ceIPSecNATTPort: 4500
  cableDriver: libreswan
  connectionHealthCheck:
    enabled: true
    intervalSeconds: 1
    maxPacketLossCount: 5

  # Gateway node selector (all nodes labeled as gateway)
  gatewayConfig:
    labelselector:
      submariner.io/gateway: "true"
    # HA: use multiple gateways
    # One active, others in standby
```

## Section 3: ServiceExport and ServiceImport

### Exporting a Service

ServiceExport makes a service available to other clusters:

```yaml
# In Cluster A: export the backend service
# First, create the service normally
apiVersion: v1
kind: Service
metadata:
  name: backend
  namespace: production
spec:
  selector:
    app: backend
  ports:
    - port: 8080
      targetPort: 8080
  type: ClusterIP

---
# Then export it via ServiceExport
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: backend
  namespace: production
```

### Importing a Service

After export, the service appears in other clusters as a ServiceImport:

```bash
# In Cluster B: view available imports
kubectl get serviceimport -A

# NAME      TYPE           IP                 AGE
# backend   ClusterSetIP   ["242.1.5.200"]    5m
```

ServiceImport is created automatically by Submariner's lighthouse-agent. You can then access the service:

```bash
# From any pod in Cluster B, access the service using DNS:
curl http://backend.production.svc.clusterset.local:8080/

# The DNS name format:
# <service>.<namespace>.svc.clusterset.local

# This resolves to the ServiceImport's ClusterSet IP
# which is load-balanced across all clusters that export this service
```

### Multi-Cluster Load Balancing

When multiple clusters export the same service, Submariner distributes traffic:

```yaml
# Both Cluster A and Cluster B export the "database" service.
# Cluster C can reach either.

# Check which endpoints are available for a ServiceImport
kubectl get endpointslice -n production -l multicluster.kubernetes.io/service-name=database
# Shows endpoints from all clusters
```

### Custom DNS Configuration

```yaml
# Submariner installs a CoreDNS plugin for clusterset.local resolution
# Verify CoreDNS config includes Lighthouse plugin:
kubectl get configmap -n kube-system coredns -o yaml

# Expected entry:
# lighthouse {
#     fallthrough
# }
```

## Section 4: GlobalNet for Overlapping CIDRs

When cluster pod/service CIDRs overlap (common in managed Kubernetes), GlobalNet assigns unique virtual IPs:

```bash
# Install with GlobalNet
subctl deploy-broker --globalnet

# GlobalNet assigns a "global CIDR" to each cluster
# Each cluster gets a unique /16 within the global CIDR
# Exported services get a GlobalIP from the global CIDR

# Check GlobalIPs assigned to exported services
kubectl get globalingressip -n production
# NAME      IP             AGE
# backend   242.0.128.1    5m
```

```yaml
# With GlobalNet, access service by GlobalIP or DNS:
# dns: backend.production.svc.clusterset.local
# resolves to: 242.0.128.1 (a unique GlobalIP)
# traffic is SNAT'd to the actual pod IP in cluster A
```

## Section 5: Skupper Architecture

Skupper takes a fundamentally different approach. Instead of L3 tunnels, it creates an application-level "virtual application network" (VAN) using AMQP router connections over TLS.

```
Cluster A                           Cluster B
┌─────────────────────────┐         ┌─────────────────────────┐
│                         │         │                         │
│  Application Pod        │         │  Application Pod        │
│  ┌─────────────────┐    │         │    ┌─────────────────┐  │
│  │  frontend app   │    │         │    │  backend app    │  │
│  │  calls backend  │    │         │    │  :8080          │  │
│  └────────┬────────┘    │         │    └────────▲────────┘  │
│           │             │         │             │           │
│           │ DNS         │         │             │           │
│           ▼             │         │             │           │
│  ┌─────────────────┐    │         │    ┌────────┴────────┐  │
│  │ Skupper Router  │    │  TLS    │    │ Skupper Router  │  │
│  │ (skupper-router │◄──►│◄───────►│◄──►│ (skupper-router │  │
│  │  pod)           │    │ AMQP    │    │  pod)           │  │
│  └─────────────────┘    │         │    └─────────────────┘  │
│                         │         │                         │
│  Skupper proxy for      │         │  AnnotatedService:      │
│  backend.default:8080   │         │  skupper.io/proxy=tcp   │
│  (virtual service)      │         │  backend:8080           │
└─────────────────────────┘         └─────────────────────────┘
```

### Installing Skupper

```bash
# Install skupper CLI
curl https://skupper.io/install.sh | sh

# Initialize Skupper in Cluster A
kubectl config use-context cluster-a
skupper init \
    --enable-console \
    --enable-flow-collector \
    --console-auth openshift  # or internal/unsecured

# Initialize Skupper in Cluster B
kubectl config use-context cluster-b
skupper init

# Create a link token in Cluster A
kubectl config use-context cluster-a
skupper token create cluster-a-token.yaml

# Link Cluster B to Cluster A
kubectl config use-context cluster-b
skupper link create cluster-a-token.yaml --name cluster-a-link

# Verify links
skupper link status
# Links created from this site:
# ╰─ Link cluster-a-link is connected
```

### Exposing Services Across Clusters

```bash
# In Cluster B: expose the backend service to the virtual network
kubectl config use-context cluster-b
skupper expose deployment backend \
    --port 8080 \
    --protocol tcp

# This creates:
# 1. A Skupper service binding (virtual service in the network)
# 2. Makes backend:8080 accessible to all linked Skupper sites
```

```yaml
# Alternative: declarative service annotation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  namespace: default
  annotations:
    skupper.io/proxy: "tcp"          # Protocol: tcp, http, http2
    skupper.io/address: "backend"    # Service name in the virtual network
    skupper.io/port: "8080"
spec:
  # ... deployment spec
```

### Consuming Skupper Services in Cluster A

After exposing the backend in Cluster B, it automatically appears in Cluster A:

```bash
# In Cluster A: view available skupper services
kubectl config use-context cluster-a
skupper service status

# backend (tcp port 8080):
#   Sites:
#     └─ cluster-b/default ● 3 targets
#        └─ name=backend
```

```bash
# From a pod in Cluster A, access the backend as if it were local
curl http://backend:8080/api/health

# Skupper intercepts DNS resolution for services in the virtual network
# "backend" resolves to the Skupper router, which forwards to Cluster B
```

### Advanced Skupper Configuration

```yaml
# skupper-site ConfigMap for advanced configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: skupper-site
  namespace: default
data:
  # Site name for identification
  name: production-cluster-a

  # Router console
  console: "true"
  console-authentication: "internal"

  # Router configuration
  router-mode: interior       # interior (part of mesh) or edge (connects to one interior)
  router-cpu-request: "500m"
  router-memory-request: "256Mi"
  router-cpu-limit: "2000m"
  router-memory-limit: "1Gi"

  # Service controller
  service-controller: "true"
  service-sync: "true"        # Sync services automatically across sites

  # Flow collector for metrics
  flow-collector: "true"
```

### Skupper HTTP2/gRPC Services

For HTTP/2 and gRPC services, Skupper provides transparent protocol awareness:

```bash
# Expose a gRPC service
skupper expose deployment grpc-backend \
    --port 9090 \
    --protocol http2  # Enables HTTP/2 framing

# Expose an HTTP service with header-based routing
skupper expose service my-service \
    --port 80 \
    --protocol http   # Enables HTTP routing features
```

## Section 6: DNS-Based vs VIP-Based Cross-Cluster Routing

### DNS-Based Service Discovery (Submariner Lighthouse)

Submariner uses DNS for service discovery. The `clusterset.local` domain is handled by a CoreDNS Lighthouse plugin:

```bash
# DNS resolution flow:
# frontend-pod (cluster-b) -> resolves backend.production.svc.clusterset.local
# -> CoreDNS in cluster-b
# -> Lighthouse plugin
# -> Returns ServiceImport ClusterSet IP
# -> traffic routes to cluster-a via Submariner tunnel

# Verify DNS resolution from a pod
kubectl run -it --rm debug --image=busybox -- nslookup backend.production.svc.clusterset.local
# Server: 10.96.0.10
# Address: 10.96.0.10:53
#
# Name: backend.production.svc.clusterset.local
# Address: 242.0.128.1
```

### VIP-Based Routing (ServiceImport ClusterSetIP)

ServiceImport creates a virtual IP (ClusterSetIP) that acts as a stable address for the exported service:

```yaml
# The ServiceImport object automatically created in cluster-b:
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: backend
  namespace: production
spec:
  type: ClusterSetIP
  ips:
    - 242.0.128.1       # ClusterSet IP (GlobalIP in GlobalNet mode)
  ports:
    - port: 8080
      protocol: TCP
```

### Headless ServiceImport (Direct Pod Routing)

For stateful applications, headless ServiceImport enables direct pod-to-pod routing:

```yaml
# Export a headless service (StatefulSet pattern)
apiVersion: v1
kind: Service
metadata:
  name: postgres-headless
  namespace: database
spec:
  clusterIP: None   # Headless
  selector:
    app: postgres
  ports:
    - port: 5432

---
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: postgres-headless
  namespace: database
```

```bash
# Each pod gets its own DNS entry in other clusters:
# postgres-0.postgres-headless.database.svc.clusterset.local
# postgres-1.postgres-headless.database.svc.clusterset.local

# Direct pod routing avoids load balancing for stateful traffic
psql -h postgres-0.postgres-headless.database.svc.clusterset.local -U myuser mydb
```

## Section 7: Hybrid Cloud Connectivity Patterns

### Pattern 1: Active-Active Database Across Clouds

```yaml
# Cluster A (AWS): primary database cluster
# Cluster B (on-premises): replica/failover database cluster

# Cluster A: Export primary PostgreSQL service
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: postgres-primary
  namespace: database

---
# Cluster B: Import and consume primary
# Application in Cluster B reads/writes to Cluster A's primary
# If Cluster A fails, Cluster B can promote its replica to primary
# and re-export under the same name
```

### Pattern 2: Edge Compute with Central Services

```bash
# Skupper is well-suited for edge scenarios where:
# - Edge clusters have dynamic/changing public IPs
# - NAT/firewalls between edge and central
# - Edge nodes have limited connectivity

# Edge cluster (behind NAT)
skupper init --router-mode=edge  # Edge mode: no incoming connections

# Create link to central cluster
skupper link create central-cluster-token.yaml

# Expose local sensor data collection service
skupper expose deployment sensor-collector \
    --port 9200 \
    --protocol tcp

# Central cluster can now query sensor-collector at edge
# without needing to know edge's IP or manage firewall rules
```

### Pattern 3: Active-Active API with Regional Routing

```yaml
# Multiple clusters export the same "api" service.
# DNS-based routing can return endpoints from the closest cluster.
# (Requires DNS-based geographic routing, e.g., AWS Route53 latency routing)

# Cluster US-East: export API service
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: api
  namespace: production
  annotations:
    # Submariner annotations for weight/preference (future feature)
    submariner.io/region: us-east-1

---
# Cluster EU-West: export same API service
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: api
  namespace: production
  annotations:
    submariner.io/region: eu-west-1
```

## Section 8: Security Considerations

### Submariner TLS Configuration

```bash
# By default Submariner uses IPsec for tunnel encryption.
# View tunnel status
subctl show connections --context cluster-a

# Cluster ID  | Endpoint IP    | Status  | RTT avg | Latency
# cluster-b   | 34.1.2.3       | connected| 35ms    | -

# Verify IPsec is encrypting traffic
# On gateway node:
ip xfrm policy   # Shows IPsec policies
ip xfrm state    # Shows IPsec SAs (Security Associations)
```

### Skupper TLS Certificate Management

```bash
# Skupper generates and rotates TLS certificates automatically.
# View router credentials
kubectl get secret skupper-router-tls -n default -o yaml

# Skupper link tokens are single-use by default
skupper token create my-token.yaml --uses 1 --expiry 24h

# Rotate all site credentials
skupper secret rotate
```

### NetworkPolicy for Cross-Cluster Traffic

```yaml
# Restrict which services can be reached from other clusters.
# Submariner traffic arrives from the gateway pod's IP range.

# Allow only explicitly defined cross-cluster access
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-cross-cluster-to-backend
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: backend
  ingress:
    - from:
        # Submariner gateway pod
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: submariner-operator
          podSelector:
            matchLabels:
              app: submariner-routeagent
      ports:
        - port: 8080
```

## Section 9: Observability for Multi-Cluster Services

### Submariner Metrics

```bash
# Submariner exposes Prometheus metrics
kubectl port-forward -n submariner-operator svc/submariner-metrics 9090:9090

# Key metrics:
# submariner_connections_total: number of gateway connections
# submariner_connection_status: connection state per remote cluster
# submariner_requested_connections: connections being established

# Alert: connection down
submariner_connection_status{status!="connected"} == 1
```

### Skupper Flow Collector

```bash
# Enable flow collector for distributed tracing across sites
skupper init --enable-flow-collector

# View service traffic flows
skupper network status
# Site: cluster-a (interior)
# ├─ Services:
# │   └─ backend (tcp:8080)
# │       ├─ 127 active connections
# │       └─ 3.2 MB transferred
# └─ Links:
#     └─ cluster-b-link ● connected (latency: 45ms)
```

### Cross-Cluster Request Tracing

```yaml
# For distributed tracing across clusters:
# Both clusters need a shared trace collector or federated Jaeger

# Propagate trace headers through Skupper HTTP2 proxy
# The Skupper proxy forwards standard W3C Trace Context headers

# Jaeger multi-cluster configuration
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: shared-tracing
spec:
  strategy: production
  storage:
    type: elasticsearch
    options:
      es:
        server-urls: https://elasticsearch.observability.svc.cluster.local:9200
  # Both clusters point to this same Elasticsearch
```

## Section 10: Choosing Between Submariner and Skupper

```
Factor                          | Submariner    | Skupper
--------------------------------|---------------|------------------
Network model                   | L3 (IP tunnel) | L7 (proxy)
Overlapping CIDRs               | GlobalNet reqd | Supported natively
Firewall/NAT traversal          | Limited       | Excellent
Protocol support                | All TCP/UDP   | TCP, HTTP, HTTP2
gRPC support                    | Yes           | Yes (http2 mode)
Latency overhead                | ~1-2ms        | ~5-10ms
Throughput                      | Near-native   | ~80% of native
Cluster join complexity         | Medium        | Low
Operational maintenance         | Medium        | Low
Services discovery DNS          | clusterset.local| Through proxy
Multi-cloud                     | Yes           | Yes
Air-gapped environments         | Limited       | Good
Kubernetes Multicluster SIG API | Yes (MCS API) | Partial
```

**Choose Submariner when:**
- Applications use non-HTTP protocols (databases, custom TCP)
- You need lowest latency and highest throughput
- Pod CIDRs don't overlap (or you're willing to use GlobalNet)
- You have network-level access between clusters

**Choose Skupper when:**
- Clusters are behind NAT or strict firewalls
- Simplicity and low operational overhead are paramount
- Your traffic is primarily HTTP/HTTP2/gRPC
- You need edge-to-cloud connectivity with frequently changing network topology
- You cannot modify cluster-level networking (managed clusters with restricted access)

Multi-cluster service discovery transforms isolated Kubernetes clusters into a federated platform that spans clouds and data centers. The choice between Submariner and Skupper ultimately comes down to whether you need L3 network-level integration or prefer an application-layer proxy approach that works through any network topology.
