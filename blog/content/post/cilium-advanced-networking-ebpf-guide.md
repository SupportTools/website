---
title: "Cilium Advanced Networking: eBPF, NetworkPolicy, BGP, and Cluster Mesh"
date: 2027-06-09T00:00:00-05:00
draft: false
tags: ["Cilium", "eBPF", "Kubernetes", "Networking", "BGP", "Network Policy"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Cilium's eBPF datapath, CiliumNetworkPolicy, BGP control plane for LoadBalancer IP advertisement, Cluster Mesh for cross-cluster connectivity, and Hubble observability."
more_link: "yes"
url: "/cilium-advanced-networking-ebpf-guide/"
---

Cilium has become the de-facto CNI for high-performance Kubernetes clusters running latency-sensitive or security-sensitive workloads. Built entirely on eBPF, Cilium bypasses the traditional iptables/netfilter stack and attaches programs directly to the Linux kernel networking hooks, delivering significant throughput gains, reduced CPU overhead, and rich Layer 7 visibility that no iptables-based CNI can offer. This guide covers everything required to deploy, harden, and operate Cilium in production: the internal architecture, kube-proxy replacement, L3/L4/L7 network policies, DNS-based egress controls, BGP advertisement of LoadBalancer IPs, Cluster Mesh for cross-cluster service discovery, Hubble observability, WireGuard encryption, and the bandwidth manager.

<!--more-->

## Cilium Architecture Overview

Cilium is composed of several cooperating components, each with a well-defined responsibility boundary.

### Core Components

**cilium-agent** runs as a DaemonSet on every node. It owns the eBPF program lifecycle: compiling, loading, and attaching BPF programs to network interfaces; managing BPF maps that encode policy, routing, and NAT state; and synchronizing local state with the Kubernetes API. The agent exposes a local gRPC API used by the CLI and Hubble.

**cilium-operator** runs as a Deployment (typically two replicas for HA). It handles cluster-wide concerns: IPAM IP block allocation, garbage collection of stale CiliumEndpoints and CiliumIdentities, CNI config management, and Kubernetes node IPAM annotations.

**Hubble relay** aggregates per-node flow data from each cilium-agent gRPC server into a single endpoint, enabling cluster-wide L7 flow queries.

**Hubble UI** provides a dependency graph and flow table backed by the relay.

**cilium-envoy** (optional) is spawned by the agent when L7 policy enforcement or HTTP-aware load balancing is required. Cilium embeds Envoy as a sidecar-free alternative to a service mesh for L7 operations.

### eBPF Datapath vs. iptables

Traditional CNIs (Flannel, Calico in iptables mode, Weave) insert thousands of iptables rules that are evaluated linearly for every packet. At scale, this linear scan becomes a bottleneck: a cluster with 10,000 Services generates tens of thousands of iptables rules, and every connection traverses all of them. eBPF programs use hash maps for O(1) lookups regardless of cluster size.

Key datapath advantages:

- **kube-proxy replacement**: Cilium implements ClusterIP, NodePort, LoadBalancer, and ExternalIP services entirely in BPF, eliminating the iptables-based kube-proxy.
- **Socket-level load balancing**: For pod-to-pod traffic on the same node, Cilium performs DNAT at the socket layer (connect-time load balancing), eliminating packet-level NAT overhead entirely.
- **Transparent encryption**: WireGuard key negotiation and packet encryption occur in kernel space via eBPF, with no per-connection overhead in userspace.
- **Identity-based policy**: Cilium assigns a numeric security identity to every endpoint based on its Kubernetes labels. Policy lookups become a single BPF map operation rather than IP-based rule matching.

---

## Installation with Helm (kube-proxy Replacement Mode)

### Prerequisites

- Kubernetes 1.26+ with a supported CRI (containerd or CRI-O).
- Linux kernel 5.10+ (recommended: 5.15+ for full feature coverage including WireGuard).
- Nodes must not already have kube-proxy running if enabling full replacement mode.

### Removing kube-proxy

On clusters that initially deployed with kube-proxy, the DaemonSet must be deleted and iptables rules cleared before enabling Cilium's replacement:

```bash
kubectl -n kube-system delete daemonset kube-proxy
# On each node (or via a privileged DaemonSet job):
iptables-save | grep -v KUBE | iptables-restore
ip6tables-save | grep -v KUBE | ip6tables-restore
```

### Helm Values for Production Deployment

```yaml
# cilium-values.yaml
kubeProxyReplacement: true
k8sServiceHost: "10.0.0.1"       # API server endpoint (or DNS name)
k8sServicePort: "6443"

ipam:
  mode: kubernetes                 # Use Kubernetes node CIDR annotations
  operator:
    clusterPoolIPv4PodCIDRList:
      - "10.244.0.0/16"

routingMode: native                # Native routing; requires BGP or pre-configured routing
autoDirectNodeRoutes: true         # Install /32 routes to pod CIDRs of other nodes

bpf:
  masquerade: true                 # BPF-based masquerade (replaces iptables MASQUERADE)
  preallocateMaps: true            # Pre-allocate BPF maps at startup for predictable latency

bandwidthManager:
  enabled: true                    # Bandwidth QoS using EDT + FQ
  bbr: true                        # Use BBR congestion control

hubble:
  enabled: true
  relay:
    enabled: true
  ui:
    enabled: true
  tls:
    auto:
      method: helm
  metrics:
    enableOpenMetrics: true
    enabled:
      - dns:query;ignoreAAAA
      - drop
      - tcp
      - flow
      - port-distribution
      - icmp
      - http

loadBalancer:
  algorithm: maglev                # Consistent hashing for session affinity
  mode: dsr                        # Direct Server Return (avoids double-hop for NodePort)

operator:
  replicas: 2
  rollOutPods: true

nodeinit:
  enabled: true

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 2000m
    memory: 1Gi

priorityClassName: system-node-critical
```

### Install Commands

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --values cilium-values.yaml
```

### Verify Installation

```bash
cilium status --wait
cilium connectivity test --test-concurrency 4
```

Expected output from `cilium status`:

```
    /¯¯\
 /¯¯\__/¯¯\    Cilium:             OK
 \__/¯¯\__/    Operator:           OK
 /¯¯\__/¯¯\    Envoy DaemonSet:    disabled
 \__/¯¯\__/    Hubble Relay:       OK
    \__/       ClusterMesh:        disabled

DaemonSet              cilium                   Desired: 6, Ready: 6/6, Available: 6/6
Deployment             cilium-operator          Desired: 2, Ready: 2/2, Available: 2/2
Deployment             hubble-relay             Desired: 1, Ready: 1/1, Available: 1/1
```

---

## CiliumNetworkPolicy: L3/L4/L7 Enforcement

### Understanding Identity-Based Policy

Cilium policy is not IP-based; it is identity-based. Every Cilium endpoint receives a numeric identity derived from its labels. Policy rules reference label selectors, and the enforcement decision is a BPF map lookup: "does identity A have permission to communicate with identity B on port P?"

This model is fundamentally more robust than IP-based policy because:
- Pod IPs change (on restarts or rescheduling) without requiring policy updates.
- Policy applies instantly to new pods matching a selector.
- Cross-node communication is enforced at the receiving node without requiring source IP tracking.

### L3/L4 Policy: Basic Pod Isolation

The following policy restricts the `frontend` workload to only accept ingress from the `api-gateway` within the same namespace, and restricts egress to only reach the `backend` service and Kubernetes DNS.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: frontend-isolation
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: frontend

  ingress:
    - fromEndpoints:
        - matchLabels:
            app: api-gateway
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP

  egress:
    # Allow DNS (required for any hostname resolution)
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            dns:
              - matchPattern: "*"

    # Allow traffic to backend service
    - toEndpoints:
        - matchLabels:
            app: backend
      toPorts:
        - ports:
            - port: "3000"
              protocol: TCP
```

### L7 HTTP Policy: Endpoint-Aware Rules

Cilium can enforce HTTP method and path restrictions at L7 without a separate sidecar. The cilium-envoy process intercepts the traffic transparently.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-http-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend-api

  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: /api/v1/.*
              - method: POST
                path: /api/v1/orders
              - method: PUT
                path: /api/v1/orders/.*
```

### L7 Kafka Policy

For Kafka clusters, Cilium can enforce topic-level access control:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: kafka-topic-policy
  namespace: messaging
spec:
  endpointSelector:
    matchLabels:
      app: kafka

  ingress:
    - fromEndpoints:
        - matchLabels:
            role: producer
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: produce
                topic: orders
              - role: produce
                topic: inventory

    - fromEndpoints:
        - matchLabels:
            role: consumer
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: consume
                topic: orders
```

### DNS-Based Egress Policy

DNS-based policy allows controlling egress to external services by hostname, including wildcard patterns. Cilium intercepts DNS responses and dynamically creates identity mappings for the returned IPs.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: egress-external-apis
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service

  egress:
    # DNS resolution must be permitted first
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            dns:
              - matchPattern: "*.stripe.com"
              - matchPattern: "*.amazonaws.com"
              - matchName: "api.pagerduty.com"

    # Allow HTTPS to resolved FQDNs
    - toFQDNs:
        - matchPattern: "*.stripe.com"
        - matchPattern: "*.amazonaws.com"
        - matchName: "api.pagerduty.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

### Egress Gateway

Egress Gateway allows pods to leave the cluster through a specific node with a predictable source IP. This is essential when external firewall rules require traffic to originate from known IPs.

```yaml
apiVersion: cilium.io/v2
kind: CiliumEgressGatewayPolicy
metadata:
  name: payment-egress
spec:
  selectors:
    - podSelector:
        matchLabels:
          app: payment-service
          namespace: production

  destinationCIDRs:
    - "203.0.113.0/24"   # Stripe IP range

  egressGateway:
    nodeSelector:
      matchLabels:
        role: egress-gateway
    egressIP: "10.0.1.50"   # Static IP on the egress node's interface
```

Label the designated egress node:

```bash
kubectl label node egress-node-1 role=egress-gateway
```

---

## BGP Control Plane for LoadBalancer IP Advertisement

Cilium's BGP control plane enables Kubernetes Services of type LoadBalancer and ExternalIP to be advertised to upstream BGP routers, eliminating the need for external load balancer controllers like MetalLB.

### BGPClusterConfig

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPClusterConfig
metadata:
  name: cilium-bgp
spec:
  nodeSelector:
    matchLabels:
      bgp-speaker: "true"

  bgpInstances:
    - name: tor-peering
      localASN: 65001
      peers:
        - name: tor-switch-1
          peerASN: 65000
          peerAddress: 10.0.0.1
          peerConfigRef:
            name: tor-peer-config

        - name: tor-switch-2
          peerASN: 65000
          peerAddress: 10.0.0.2
          peerConfigRef:
            name: tor-peer-config
```

### BGPPeerConfig

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeerConfig
metadata:
  name: tor-peer-config
spec:
  authSecretRef: bgp-auth-secret   # Optional MD5 auth
  gracefulRestart:
    enabled: true
    restartTimeSeconds: 120
  families:
    - afi: ipv4
      safi: unicast
      advertisements:
        matchLabels:
          advertise: bgp-services
```

### BGPAdvertisement

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPAdvertisement
metadata:
  name: service-advertisements
  labels:
    advertise: bgp-services
spec:
  advertisements:
    - advertisementType: Service
      service:
        addresses:
          - LoadBalancerIP
          - ExternalIP
      selector:
        matchExpressions:
          - key: somekey
            operator: NotIn
            values:
              - never-advertise

    - advertisementType: PodCIDR
```

### LoadBalancer IP Pool

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: production-pool
spec:
  blocks:
    - cidr: "203.0.113.128/26"
  serviceSelector:
    matchLabels:
      environment: production
```

Label nodes for BGP speaker role:

```bash
kubectl label node node-1 node-2 node-3 bgp-speaker=true
```

Verify BGP sessions:

```bash
cilium bgp peers
# NAME            PEER ADDRESS  PEER ASN  SESSION STATE  UPTIME
# tor-switch-1    10.0.0.1      65000     established    2h15m
# tor-switch-2    10.0.0.2      65000     established    2h15m
```

---

## Cluster Mesh: Cross-Cluster Connectivity

Cluster Mesh enables pods in one Kubernetes cluster to reach pods and services in other clusters as if they were local, using a shared etcd-based keystore for endpoint synchronization.

### Architecture

Each cluster runs a `clustermesh-apiserver` Deployment that exposes a TLS-secured etcd-compatible endpoint. Remote cilium-agents connect to this endpoint and sync remote CiliumEndpoints into local BPF maps. Traffic between clusters is routed using direct routing or VXLAN tunnels, depending on the network topology.

### Prerequisites

- Each cluster must have a unique `clusterMeshConfig.cluster.name` and `clusterMeshConfig.cluster.id` (1-255).
- Pod CIDRs must be non-overlapping across all clusters.
- Clusters must have mutual network connectivity on port 2379 for the clustermesh-apiserver.

### Enabling Cluster Mesh per Cluster

```yaml
# Additional Helm values for cluster mesh
cluster:
  name: cluster-west
  id: 1

clustermesh:
  useAPIServer: true
  apiserver:
    replicas: 2
    service:
      type: LoadBalancer
    tls:
      auto:
        method: helm
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
```

### Connecting Clusters

```bash
# After deploying both clusters, connect them using the CLI
cilium clustermesh connect \
  --context cluster-west \
  --destination-context cluster-east

cilium clustermesh status --context cluster-west --wait
```

### Global Services for Cross-Cluster Load Balancing

Services annotated with `service.cilium.io/global: "true"` receive endpoints from all clusters. Cilium automatically load-balances across local and remote endpoints.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-service
  namespace: production
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/shared: "true"   # Export this service to other clusters
spec:
  selector:
    app: payment
  ports:
    - port: 8080
      targetPort: 8080
```

To prefer local endpoints and only failover to remote clusters:

```yaml
metadata:
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/affinity: "local"
```

### Cross-Cluster Network Policy

CiliumNetworkPolicy selectors work across clusters. Remote endpoints are identified by their identity, which encodes cluster ID + labels:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-from-cluster-east
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: database

  ingress:
    - fromEndpoints:
        - matchLabels:
            app: backend
            io.cilium.k8s.policy.cluster: cluster-east
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
```

---

## Hubble Observability: Flows, Metrics, and UI

### Hubble CLI Usage

Install the Hubble CLI:

```bash
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --fail --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/
```

Port-forward the Hubble relay for local access:

```bash
cilium hubble port-forward &
```

Observe live flows for a specific namespace:

```bash
hubble observe --namespace production --follow

# Filter by pod
hubble observe --pod production/payment-service-abc123 --follow

# Filter by verdict
hubble observe --verdict DROPPED --follow

# Show L7 HTTP flows
hubble observe --protocol http --namespace production

# Show DNS queries
hubble observe --protocol dns --namespace production --follow
```

### Observing Dropped Traffic for Policy Debugging

When troubleshooting policy denials, Hubble provides precise visibility into why traffic was dropped:

```bash
hubble observe \
  --verdict DROPPED \
  --namespace production \
  --output jsonpb \
  | jq '{
      src: .source.labels,
      dst: .destination.labels,
      port: .l4.TCP.destination_port,
      reason: .drop_reason_desc
    }'
```

### Hubble Metrics with Prometheus

Hubble exposes Prometheus metrics from each node. Configure a ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: hubble-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      k8s-app: hubble
  namespaceSelector:
    matchNames:
      - kube-system
  endpoints:
    - port: hubble-metrics
      interval: 30s
      honorLabels: true
```

Key Hubble metrics:

| Metric | Description |
|---|---|
| `hubble_flows_processed_total` | Total flows processed, labeled by verdict, direction, protocol |
| `hubble_drop_total` | Dropped packets by reason |
| `hubble_http_requests_total` | HTTP request count with status code and method |
| `hubble_http_request_duration_seconds` | HTTP latency histogram |
| `hubble_dns_queries_total` | DNS query count and response type |

### Hubble UI Deployment

The Hubble UI is deployed via Helm when `hubble.ui.enabled: true`. Access it:

```bash
kubectl port-forward -n kube-system svc/hubble-ui 12000:80
```

The UI renders a real-time service dependency map. Namespaces appear as zones, and flows between workloads are drawn as directed edges with color-coded verdicts (green=allowed, red=dropped).

---

## WireGuard Transparent Encryption

Cilium integrates WireGuard for node-to-node pod traffic encryption. Unlike IPsec, WireGuard provides simpler key management and higher performance, with kernel-level implementation since Linux 5.6.

### Enabling WireGuard

```yaml
# Add to cilium-values.yaml
encryption:
  enabled: true
  type: wireguard
  nodeEncryption: true      # Encrypt node-to-node traffic (not just pod-to-pod)
  wireguard:
    userspaceFallback: false  # Use kernel WireGuard; fallback only for kernels < 5.6
```

Upgrade Cilium with the new values:

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --values cilium-values.yaml \
  --reuse-values
```

Verify WireGuard is active:

```bash
cilium encrypt status
# Encryption: Wireguard
# Decryption interface(s): eth0
# Keys in use: 1
# Max Seq. No: 0x0
# Errors: 0

# Verify WireGuard interface on each node
kubectl -n kube-system exec ds/cilium -- wg show
```

### WireGuard with Node Encryption

When `nodeEncryption: true` is set, traffic from the node itself (not just pods) is also encrypted, including health check traffic and Hubble relay communication.

---

## Bandwidth Manager

The bandwidth manager implements Earliest Departure Time (EDT) scheduling with the FQ (Fair Queue) qdisc to enforce per-pod bandwidth limits defined via Kubernetes resource annotations.

### Configuring Per-Pod Bandwidth Limits

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: bandwidth-limited-pod
  annotations:
    kubernetes.io/egress-bandwidth: "100M"
    kubernetes.io/ingress-bandwidth: "100M"
spec:
  containers:
    - name: app
      image: nginx:1.25
```

The bandwidth manager converts these annotations into BPF-enforced rate limits at the veth interface level, providing fair sharing without introducing artificial latency through token bucket algorithms.

### BBR Congestion Control

When `bandwidthManager.bbr: true`, Cilium sets the TCP congestion control algorithm to BBR for all pods. BBR is significantly more efficient than CUBIC for high-bandwidth, high-latency paths (cross-region traffic, storage replication):

```bash
# Verify BBR is active on a pod
kubectl exec -it some-pod -- sysctl net.ipv4.tcp_congestion_control
# net.ipv4.tcp_congestion_control = bbr
```

---

## Host Firewall

Cilium's host firewall extends identity-based policy to the Kubernetes node itself, protecting the host OS from unauthorized access.

### Enabling Host Firewall

```yaml
# cilium-values.yaml
hostFirewall:
  enabled: true
```

### CiliumClusterwideNetworkPolicy for Host Protection

```yaml
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: host-firewall-policy
spec:
  nodeSelector:
    matchLabels:
      node-role.kubernetes.io/worker: ""

  ingress:
    # Allow Kubernetes control plane access
    - fromCIDR:
        - "10.0.0.0/8"
      toPorts:
        - ports:
            - port: "10250"    # kubelet
              protocol: TCP
            - port: "10255"    # kubelet read-only
              protocol: TCP

    # Allow SSH from bastion only
    - fromCIDRSet:
        - cidr: "10.100.0.0/24"   # Bastion subnet
      toPorts:
        - ports:
            - port: "22"
              protocol: TCP

    # Allow ICMP for monitoring
    - fromCIDR:
        - "10.0.0.0/8"
      icmps:
        - fields:
            - type: 8
              family: IPv4

  egress:
    # Allow all outbound (restrict per-service as needed)
    - toCIDR:
        - "0.0.0.0/0"
```

---

## Production Operations and Troubleshooting

### Inspecting BPF Maps

BPF maps hold Cilium's runtime state. Direct inspection is invaluable for debugging:

```bash
# List all local endpoints and their identities
cilium endpoint list

# Show the policy map for a specific endpoint
ENDPOINT_ID=$(cilium endpoint list -o json | jq '.[0].id')
cilium bpf policy get ${ENDPOINT_ID}

# Inspect the service load-balancing map
cilium bpf lb list

# Show NAT table
cilium bpf nat list

# Show connection tracking table
cilium bpf ct list global
```

### Diagnosing Connectivity Issues

Use the built-in connectivity test for systematic validation:

```bash
# Full connectivity test suite
cilium connectivity test

# Test only specific scenarios
cilium connectivity test --test pod-to-pod
cilium connectivity test --test pod-to-service
cilium connectivity test --test pod-to-external-1111

# Test with specific source/destination namespaces
cilium connectivity test \
  --test-namespace cilium-test \
  --multi-cluster cluster-east
```

### Policy Troubleshooting Workflow

```bash
# Step 1: Identify the dropped flow with Hubble
hubble observe --verdict DROPPED --namespace production --follow &

# Step 2: Attempt the failing connection
kubectl exec -n production deploy/frontend -- curl -v http://backend:3000/api

# Step 3: Examine the drop reason
hubble observe --verdict DROPPED --output jsonpb \
  | jq '.drop_reason_desc'

# Common drop reasons:
# "Policy denied"           -> CiliumNetworkPolicy blocking the flow
# "CT: Map insertion failed" -> Connection tracking table exhausted
# "No tunnel header"        -> Tunnel mode misconfiguration

# Step 4: Check endpoint policy
cilium endpoint get <id> | jq '.[].status.policy'
```

### Common Production Issues

**Issue: BPF map pressure**

Large clusters can exhaust default BPF map sizes. Monitor and adjust:

```yaml
# cilium-values.yaml
bpf:
  mapDynamicSizeRatio: 0.0025   # Default; increase for large clusters
  # Or set explicit sizes:
  ctTcpMax: 524288
  ctAnyMax: 262144
  natMax: 524288
  neighMax: 524288
  policyMapMax: 16384
```

**Issue: DNS-based policy not matching**

Verify the Cilium DNS proxy is intercepting queries:

```bash
# Check DNS proxy status
cilium status | grep "DNS Proxy"

# Observe DNS flows
hubble observe --protocol dns --namespace production

# Verify FQDN cache
cilium fqdn cache list
```

**Issue: BGP session not establishing**

```bash
# Check BGP peer status
cilium bgp peers

# View BGP routes
cilium bgp routes

# Check logs for BGP errors
kubectl -n kube-system logs -l app.kubernetes.io/name=cilium \
  | grep -i bgp
```

### Upgrade Procedure

Cilium follows a rolling upgrade model. For minor versions, a Helm upgrade suffices:

```bash
# Verify current version
cilium version

# Upgrade (will perform a rolling restart of the DaemonSet)
helm upgrade cilium cilium/cilium \
  --version 1.17.0 \
  --namespace kube-system \
  --values cilium-values.yaml \
  --reuse-values

# Monitor rollout
kubectl -n kube-system rollout status daemonset/cilium
kubectl -n kube-system rollout status deployment/cilium-operator

# Validate post-upgrade
cilium status --wait
cilium connectivity test
```

For major version upgrades (e.g., 1.15 -> 1.16), consult the official upgrade guide for any breaking changes in CRD schemas or Helm value renames.

---

## Resource Sizing Guidelines

| Cluster Size | cilium-agent CPU Request | cilium-agent Memory Limit | Operator CPU | Operator Memory |
|---|---|---|---|---|
| < 100 nodes | 100m | 512Mi | 200m | 256Mi |
| 100-500 nodes | 500m | 1Gi | 500m | 512Mi |
| 500-1000 nodes | 1000m | 2Gi | 1000m | 1Gi |
| > 1000 nodes | 2000m | 4Gi | 2000m | 2Gi |

Hubble relay and UI are lightweight but scale with the number of flows:

```yaml
hubble:
  relay:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

---

## Security Hardening Checklist

- Enable WireGuard encryption for all inter-node traffic.
- Deploy default-deny CiliumClusterwideNetworkPolicy for all namespaces before allowing specific flows.
- Use L7 HTTP policy for all internal API communication where feasible.
- Enable DNS proxy and restrict FQDN egress to only required external endpoints.
- Deploy Egress Gateway for workloads requiring predictable egress IPs.
- Enable host firewall on all worker nodes.
- Configure Hubble with TLS and restrict relay access to authorized clients.
- Monitor `hubble_drop_total` metric for unexpected policy denials and alert on spikes.
- Audit CiliumNetworkPolicy resources quarterly using `cilium policy get` and remove stale rules.
- Pin BGP peer sessions with MD5 authentication.

---

## Summary

Cilium's eBPF foundation provides a qualitative leap over iptables-based CNIs: O(1) policy lookup, transparent L7 visibility, socket-level load balancing, and kernel-native WireGuard encryption. The BGP control plane eliminates the need for external load balancer controllers in bare-metal environments. Cluster Mesh enables truly multi-cluster service discovery with sub-second failover. Hubble provides the observability layer that makes operating all of these features at scale tractable. Combined with proper resource sizing, BPF map tuning, and a rigorous default-deny policy posture, Cilium provides a production-grade network foundation capable of supporting thousands of nodes and millions of concurrent connections.
