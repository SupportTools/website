---
title: "Cilium BGP Control Plane: Advanced Kubernetes Networking with eBPF"
date: 2028-09-16T00:00:00-05:00
draft: false
tags: ["Cilium", "BGP", "eBPF", "Kubernetes", "Networking"]
categories:
- Cilium
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Cilium BGP Control Plane configuration for bare-metal Kubernetes — CiliumBGPPeeringPolicy, BGP advertisement of pod CIDRs and LoadBalancer IPs, Hubble observability, L7 network policies, WireGuard encryption, and comparing Cilium vs Calico BGP."
more_link: "yes"
url: "/cilium-bgp-control-plane-enterprise-networking-guide/"
---

The combination of Cilium's eBPF dataplane with a native BGP control plane removes the last reason to run a separate CNI plugin alongside a BGP daemon like BIRD or FRR for bare-metal Kubernetes clusters. Cilium's BGP Control Plane, introduced as stable in Cilium 1.14, allows Kubernetes nodes to peer directly with physical routers, advertise pod CIDRs and LoadBalancer service IPs, and participate in your existing network routing infrastructure — all configured through Kubernetes CRDs without touching daemon configuration files. This guide covers the complete deployment: Helm installation with BGP enabled, peering policies, IP pool management, Hubble observability, L7 network policies, WireGuard node-to-node encryption, and a direct comparison with Calico's BGP implementation.

<!--more-->

# Cilium BGP Control Plane: Advanced Kubernetes Networking with eBPF

## Architecture Overview

Cilium's BGP Control Plane (BGP-CP) runs as part of the Cilium agent on each node. Each agent:

1. Reads `CiliumBGPPeeringPolicy` objects selecting nodes where it runs
2. Establishes BGP sessions with configured peers (physical ToR switches, route reflectors)
3. Advertises configured routes: pod CIDRs, LoadBalancer IPs from `CiliumLoadBalancerIPPool`
4. Programs the eBPF dataplane for all forwarding decisions — no iptables

The eBPF dataplane provides measurable performance advantages: 3-4x lower per-packet latency than iptables-based CNIs at scale, native load balancing via XDP (before packets even reach the kernel network stack), and built-in network policy enforcement at L3, L4, and L7.

## Section 1: Cilium Installation with BGP Control Plane

This assumes a bare-metal cluster where nodes have dual-homed connectivity to access/distribution layer switches that run BGP.

```bash
helm repo add cilium https://helm.cilium.io
helm repo update

# Get current node CIDRs for reference
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name} {.spec.podCIDR}{"\n"}{end}'
```

```yaml
# cilium-values.yaml
# Core configuration
kubeProxyReplacement: true    # Replace kube-proxy entirely
k8sServiceHost: 10.0.0.100   # Your API server VIP
k8sServicePort: 6443

# BGP Control Plane
bgpControlPlane:
  enabled: true

# IPAM
ipam:
  mode: kubernetes              # Use Kubernetes node CIDR allocation
  # Alternative for BGP-centric deployments:
  # mode: cluster-pool
  # operator:
  #   clusterPoolIPv4PodCIDRList: ["10.244.0.0/16"]
  #   clusterPoolIPv4MaskSize: 24

# Enable IPv4 and IPv6 dual-stack
ipv4:
  enabled: true
ipv6:
  enabled: false

# Routing mode — native (direct routing, no encapsulation)
routingMode: native
autoDirectNodeRoutes: true
ipv4NativeRoutingCIDR: "10.244.0.0/16"

# WireGuard transparent encryption
encryption:
  enabled: true
  type: wireguard
  wireguard:
    userspaceFallback: false

# Bandwidth manager (eBPF-based QoS)
bandwidthManager:
  enabled: true
  bbr: true      # Use BBR congestion control

# Hubble observability
hubble:
  enabled: true
  relay:
    enabled: true
    replicas: 2
  ui:
    enabled: true
  metrics:
    enabled:
      - dns:query;ignoreAAAA
      - drop
      - tcp
      - flow
      - port-distribution
      - icmp
      - http
    serviceMonitor:
      enabled: true
  tls:
    auto:
      method: certmanager
      certManagerIssuerRef:
        group: cert-manager.io
        kind: ClusterIssuer
        name: selfsigned

# Load balancing
loadBalancer:
  algorithm: maglev     # Consistent hashing for stateful sessions
  mode: dsr             # Direct Server Return for single-hop load balancing

# L7 policy (requires Envoy)
envoyConfig:
  enabled: true

# Prometheus metrics
prometheus:
  enabled: true
  serviceMonitor:
    enabled: true

# High availability
operator:
  replicas: 2

resources:
  requests:
    cpu: 100m
    memory: 512Mi
  limits:
    cpu: 4000m
    memory: 4Gi
```

```bash
helm upgrade --install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --values cilium-values.yaml \
  --wait \
  --timeout 15m

# Verify installation
cilium status --wait
cilium connectivity test --test-namespace cilium-test
```

## Section 2: BGP Peering Configuration

The topology assumes:
- Kubernetes nodes: 10.0.1.0/24 (VLAN 10)
- ToR switches acting as BGP peers: 10.0.1.1, 10.0.1.2
- Pod CIDR: 10.244.0.0/16
- LoadBalancer IP pool: 10.250.0.0/16
- Kubernetes nodes AS: 65001
- Physical fabric AS: 65000

### LoadBalancer IP Pool

```yaml
# lb-ippool.yaml
apiVersion: "cilium.io/v2alpha1"
kind: CiliumLoadBalancerIPPool
metadata:
  name: production-pool
spec:
  blocks:
    - cidr: "10.250.0.0/24"     # First /24 for production services
  serviceSelector:
    matchExpressions:
      - {key: environment, operator: In, values: [production]}

---
apiVersion: "cilium.io/v2alpha1"
kind: CiliumLoadBalancerIPPool
metadata:
  name: staging-pool
spec:
  blocks:
    - cidr: "10.250.1.0/24"
  serviceSelector:
    matchExpressions:
      - {key: environment, operator: In, values: [staging]}
```

### BGP Peering Policy

```yaml
# bgp-peering-policy.yaml
apiVersion: "cilium.io/v2alpha1"
kind: CiliumBGPPeeringPolicy
metadata:
  name: rack-1-peering
spec:
  # This policy applies to all nodes in rack-1
  nodeSelector:
    matchLabels:
      rack: rack-1

  virtualRouters:
    - localASN: 65001
      exportPodCIDR: true
      serviceSelector:
        matchExpressions:
          # Advertise LoadBalancer IPs for all services
          - {key: somekey, operator: NotIn, values: [never-true]}
      serviceAdvertisements:
        - LoadBalancerIP

      neighbors:
        # Peer with ToR switch 1
        - peerAddress: "10.0.1.1/32"
          peerASN: 65000
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 120
          families:
            - afi: ipv4
              safi: unicast
          timers:
            holdTimeSeconds: 9
            keepAliveTimeSeconds: 3
          authSecretRef: bgp-auth-secret

        # Peer with ToR switch 2 (redundant)
        - peerAddress: "10.0.1.2/32"
          peerASN: 65000
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 120
          families:
            - afi: ipv4
              safi: unicast
          timers:
            holdTimeSeconds: 9
            keepAliveTimeSeconds: 3
          authSecretRef: bgp-auth-secret
```

```bash
# Create BGP MD5 authentication secret
kubectl create secret generic bgp-auth-secret \
  --namespace kube-system \
  --from-literal=password=your-bgp-md5-password

# Label nodes by rack
kubectl label node k8s-node-01 rack=rack-1
kubectl label node k8s-node-02 rack=rack-1
kubectl label node k8s-node-03 rack=rack-2
kubectl label node k8s-node-04 rack=rack-2
```

### Verify BGP Session Establishment

```bash
# Check BGP peering status on a node
kubectl exec -n kube-system -it ds/cilium -- cilium bgp peers

# Expected output:
# Local AS   Peer AS   Peer Address   Session State   Up/Down    Prefixes Received
# 65001      65000     10.0.1.1       ESTABLISHED     00:15:23   0
# 65001      65000     10.0.1.2       ESTABLISHED     00:15:21   0

# Check advertised routes
kubectl exec -n kube-system -it ds/cilium -- cilium bgp routes advertised

# On the physical router (e.g., Arista):
# show ip bgp neighbors 10.0.1.10 received-routes
```

## Section 3: L7 Network Policies with Envoy

Cilium supports L7-aware policies that can allow/deny based on HTTP methods, paths, and headers — something traditional iptables-based CNIs cannot do.

```yaml
# payments-network-policy.yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: payments-api-policy
  namespace: payments
spec:
  endpointSelector:
    matchLabels:
      app: payments-api

  ingress:
    # Allow health checks from kube-proxy/ALB
    - fromEntities:
        - health
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP

    # Allow only specific HTTP methods/paths from order-service
    - fromEndpoints:
        - matchLabels:
            app: orders-api
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Only allow POST to /v1/payments and GET to /v1/payments/*
              - method: "POST"
                path: "/v1/payments"
              - method: "GET"
                path: "/v1/payments/[a-f0-9-]{36}"  # UUID pattern
              - method: "GET"
                path: "/health"

    # Allow Prometheus scraping from monitoring namespace
    - fromEndpoints:
        - matchLabels:
            app.kubernetes.io/name: prometheus
      fromNamespaces:
        - matchLabels:
            name: monitoring
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP

  egress:
    # Allow DNS
    - toEndpoints:
        - matchLabels:
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP

    # Allow database access only to payments-db namespace
    - toEndpoints:
        - matchLabels:
            cnpg.io/cluster: payments-db
      toNamespaces:
        - matchLabels:
            kubernetes.io/metadata.name: payments-db
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # Allow Redis access
    - toEndpoints:
        - matchLabels:
            app: redis
      toPorts:
        - ports:
            - port: "6379"
              protocol: TCP

    # Block all other external egress (except to known CIDRs)
    - toCIDRSet:
        - cidr: 10.0.0.0/8
          except:
            - 10.0.100.0/24   # Block access to corporate secrets server
```

## Section 4: Hubble Observability

Hubble provides real-time network flow visibility using eBPF without packet capture overhead.

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --fail --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/

# Port-forward to Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:443 &

# Observe all flows in the payments namespace
hubble observe --namespace payments --follow

# Observe dropped packets
hubble observe --namespace payments --verdict DROPPED --follow

# Observe specific pod's flows
hubble observe --pod payments/payments-api-7d6b9f-xk2pq --follow

# Get network flows as JSON for analysis
hubble observe --namespace payments --output json --last 1000 \
  | jq 'select(.verdict == "DROPPED") | {src: .source.pod_name, dst: .destination.pod_name, reason: .drop_reason_desc}'
```

### Hubble L7 Metrics in Grafana

```bash
# Access Hubble UI
kubectl port-forward -n kube-system svc/hubble-ui 12000:80

# The UI shows:
# - Service map with live traffic flows
# - HTTP request rates per endpoint
# - DNS query/response flows
# - Drop reason distribution
```

## Section 5: WireGuard Transparent Encryption

WireGuard encryption is configured at the Helm values level and requires no application-level changes. Every packet leaving a node to a different Kubernetes node is encrypted transparently.

```bash
# Verify WireGuard is active
kubectl exec -n kube-system ds/cilium -- cilium encrypt status

# Expected:
# Encryption: Wireguard
# Wireguard port: 51871
# Keys in use: 1
# Nodes with WireGuard enabled: 6
# Error: None

# Check WireGuard interface on a node
kubectl exec -n kube-system ds/cilium -- ip link show cilium_wg0
# 8: cilium_wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 ...

# Verify inter-node traffic is encrypted by checking the WireGuard stats
kubectl exec -n kube-system ds/cilium -- wg show
```

## Section 6: Bandwidth Manager and Pod QoS

Cilium's bandwidth manager enforces pod network bandwidth limits using eBPF tc programs, replacing Linux traffic shaping with a more efficient implementation.

```yaml
# Annotate pods to enforce bandwidth limits
apiVersion: apps/v1
kind: Deployment
metadata:
  name: media-transcoder
  namespace: media
spec:
  template:
    metadata:
      annotations:
        # Kubernetes bandwidth plugin annotations — Cilium honors these
        kubernetes.io/ingress-bandwidth: "100M"
        kubernetes.io/egress-bandwidth: "500M"
    spec:
      containers:
        - name: transcoder
          image: ghcr.io/acme/media-transcoder:1.2.0
          resources:
            requests:
              cpu: 4
              memory: 8Gi
```

## Section 7: Cilium vs Calico BGP Comparison

| Feature | Cilium BGP-CP | Calico BGP |
|---|---|---|
| BGP implementation | GoBGP integrated into agent | BIRD daemon as DaemonSet |
| Dataplane | eBPF (XDP, tc, sockops) | iptables or eBPF (Felix) |
| L7 policy | Native via Envoy sidecar | Not supported |
| Encryption | WireGuard (transparent) | WireGuard (transparent) |
| ECMP | Native eBPF Maglev LB | iptables ECMP |
| BGP policy (route maps) | Limited (v1.16+) | Full BIRD config |
| Configuration | CRDs | CRDs + BGP peer configs |
| Observability | Hubble (eBPF flow visibility) | Flow logs via external tooling |
| Kubernetes-native | Full CRD API | Full CRD API |
| Production maturity | v1.14+ stable | Stable, long track record |

Calico's BIRD-based BGP remains the better choice when you need complex BGP policy (route maps, community manipulation, conditional advertisements). Cilium's BGP-CP is the better choice when you want L7 network policies, Hubble observability, and eBPF performance in the same stack without managing a separate BGP daemon process.

## Section 8: Troubleshooting BGP

```bash
#!/bin/bash
# cilium-bgp-debug.sh

NODE="${1:?Usage: cilium-bgp-debug.sh <node-name>}"

CILIUM_POD=$(kubectl get pod -n kube-system \
  -l k8s-app=cilium \
  --field-selector spec.nodeName="${NODE}" \
  -o jsonpath='{.items[0].metadata.name}')

echo "=== Cilium Pod: ${CILIUM_POD} on ${NODE} ==="

echo ""
echo "=== BGP Peer Status ==="
kubectl exec -n kube-system "${CILIUM_POD}" -- cilium bgp peers

echo ""
echo "=== BGP Advertised Routes ==="
kubectl exec -n kube-system "${CILIUM_POD}" -- cilium bgp routes advertised ipv4 unicast

echo ""
echo "=== BGP Received Routes ==="
kubectl exec -n kube-system "${CILIUM_POD}" -- cilium bgp routes available ipv4 unicast

echo ""
echo "=== Cilium Status ==="
kubectl exec -n kube-system "${CILIUM_POD}" -- cilium status

echo ""
echo "=== Drop Reasons (last 60s) ==="
kubectl exec -n kube-system "${CILIUM_POD}" -- cilium monitor --type drop 2>/dev/null &
MONITOR_PID=$!
sleep 10
kill ${MONITOR_PID} 2>/dev/null

echo ""
echo "=== BPF Load Balancer Backend Entries ==="
kubectl exec -n kube-system "${CILIUM_POD}" -- cilium bpf lb list | head -20
```

## Conclusion

Cilium's BGP Control Plane delivers the routing integration of traditional BGP CNIs with the performance and observability advantages of an eBPF-native dataplane. The combination of pod CIDR and LoadBalancer IP advertisement eliminates the need for MetalLB or external load balancers on bare-metal clusters. Hubble's eBPF-based flow visibility answers questions that iptables LOG rules and tcpdump cannot: which HTTP paths are being called between which services, why specific packets are being dropped by policy, and what the actual network topology looks like in real time. For new bare-metal Kubernetes deployments that value operational simplicity and observability, Cilium with BGP-CP is the strongest single-CNI choice available.
