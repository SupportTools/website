---
title: "BGP with Cilium: Advanced Kubernetes Network Routing"
date: 2027-10-06T00:00:00-05:00
draft: false
tags: ["Cilium", "BGP", "Kubernetes", "Networking", "eBPF"]
categories:
- Networking
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to BGP routing with Cilium for Kubernetes — CiliumBGPPeeringPolicy, advertising LoadBalancer IPs and pod CIDRs, BFD for fast failure detection, ECMP load balancing, BGP communities, physical network integration, and replacing MetalLB."
more_link: "yes"
url: "/bgp-cilium-kubernetes-networking-guide/"
---

BGP integration transforms a Kubernetes cluster from an isolated network island into a first-class participant in the enterprise routing domain. When Cilium's BGP control plane advertises LoadBalancer service IPs and pod CIDRs directly to physical routers, pods become reachable across the datacenter without NAT, and external load balancer IPs are distributed with the same convergence behavior as any other BGP route. This guide covers Cilium's BGP control plane architecture — from CiliumBGPPeeringPolicy CRD design to BFD for sub-second failure detection, ECMP load distribution, BGP community tagging, integration with physical network infrastructure, and the complete workflow for replacing MetalLB with Cilium BGP on bare-metal clusters.

<!--more-->

# BGP with Cilium: Advanced Kubernetes Network Routing

## Section 1: BGP Control Plane Architecture

Cilium implements BGP using the GoBGP library. The Cilium agent on each node establishes BGP sessions to upstream routers and announces routes derived from Kubernetes service and pod state.

### Route Advertisement Model

```
Physical Network (Arista/Juniper/Cisco)
          │ BGP sessions
┌─────────▼──────────────────────────────────────────────┐
│              Kubernetes Nodes                           │
│                                                         │
│  Node 1 (10.0.1.10)      Node 2 (10.0.1.11)           │
│  Cilium Agent             Cilium Agent                  │
│  BGP Speaker              BGP Speaker                   │
│                                                         │
│  Advertises:              Advertises:                   │
│  - Pod CIDR: 10.244.1.0/24  - Pod CIDR: 10.244.2.0/24 │
│  - LB IPs: 203.0.113.10/32  - LB IPs: 203.0.113.10/32 │
│    (services on this node)    (services on this node)   │
└─────────────────────────────────────────────────────────┘
```

### Route Types Advertised by Cilium BGP

```
Route Type                    Use Case                      Advertisement Target
───────────────────────────────────────────────────────────────────────────────
Pod CIDR (/24 per node)       Direct pod routing            All BGP peers
Service ClusterIP             Internal service routing      Optional
Service ExternalIPs           Direct service access         All BGP peers
LoadBalancer IPs              External service access       All BGP peers
Node IPs                      Node-to-node direct routing   Optional
```

## Section 2: Prerequisites and Cilium Installation

### Kernel Requirements for BGP

```bash
# Minimum kernel version: 5.10 (5.15+ recommended)
uname -r

# Required for BGP control plane:
# - eBPF socket LB
# - kube-proxy replacement
# - Native routing mode

# Check available kernel features
cilium-dbg kernel-check 2>/dev/null || true
```

### Cilium Installation with BGP Control Plane

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

# Verify current node network configuration
NODE_CIDR=$(kubectl get nodes -o jsonpath='{.items[0].spec.podCIDR}')
echo "Pod CIDR: ${NODE_CIDR}"

helm upgrade --install cilium cilium/cilium \
  --version 1.15.6 \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=k8s-api.acme.internal \
  --set k8sServicePort=6443 \
  --set routingMode=native \
  --set autoDirectNodeRoutes=true \
  --set ipam.mode=kubernetes \
  --set bgpControlPlane.enabled=true \
  --set bgpControlPlane.secretsNamespace.create=false \
  --set bgpControlPlane.secretsNamespace.name=kube-system \
  --set bpf.masquerade=true \
  --set loadBalancer.mode=dsr \
  --set loadBalancer.algorithm=maglev \
  --set l7Proxy=true \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set prometheus.enabled=true \
  --set operator.prometheus.enabled=true \
  --wait \
  --timeout 10m
```

### Verify BGP Control Plane

```bash
# Check Cilium status
cilium status --wait

# Verify BGP is enabled
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=cilium -o jsonpath='{.items[0].metadata.name}') \
  -- cilium bgp peers
```

## Section 3: CiliumBGPPeeringPolicy CRD

### Basic Peering Policy

```yaml
# cilium-bgp-peering-policy.yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: bgp-peering-production
spec:
  # This policy applies to nodes matching this selector
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux

  virtualRouters:
    - localASN: 65001        # Cluster AS number
      exportPodCIDR: true    # Advertise pod CIDRs to peers
      podIPPoolSelector:
        matchExpressions:
          - key: somekey
            operator: NotIn
            values:
              - somevalue

      # Service advertisement configuration
      serviceSelector:
        matchExpressions:
          - key: somekey
            operator: NotIn
            values:
              - somevalue

      # BGP peers — upstream routers
      neighbors:
        - peerAddress: "10.0.0.1/32"     # Leaf switch 1
          peerASN: 65000
          connectRetryTimeSeconds: 120
          holdTimeSeconds: 90
          keepAliveTimeSeconds: 30
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 120
          advertisements:
            withAdvertisements:
              - advertisementType: PodCIDR
              - advertisementType: Service
                service:
                  addresses:
                    - LoadBalancerIP
                    - ExternalIP

        - peerAddress: "10.0.0.2/32"     # Leaf switch 2 (redundant)
          peerASN: 65000
          connectRetryTimeSeconds: 120
          holdTimeSeconds: 90
          keepAliveTimeSeconds: 30
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 120
          advertisements:
            withAdvertisements:
              - advertisementType: PodCIDR
              - advertisementType: Service
                service:
                  addresses:
                    - LoadBalancerIP
                    - ExternalIP
```

### Per-Node BGP Configuration

```yaml
# cilium-bgp-node-config.yaml — Different ASNs per node (iBGP)
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPNodeConfig
metadata:
  name: bgp-node-config
spec:
  bgpInstances:
    - name: tor-peering
      localASN: 65001
      routerID: ""    # Auto-detect from node IP
      listenPort: 179
      neighbors:
        - name: tor-switch-1
          peerAddress: "10.0.0.1"
          peerASN: 65000
          peerPort: 179
          localAddress: ""    # Auto-detect
          connectRetryTimeSeconds: 120
          holdTimeSeconds: 90
          keepAliveTimeSeconds: 30
          ebgpMultihop: 1
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 120
          families:
            - afi: ipv4
              safi: unicast
              advertisements:
                matchers:
                  - matchType: PodCIDR
                  - matchType: Service
                    matchLabels:
                      advertise-via-bgp: "true"
```

### Multi-Home BGP (Active-Active)

```yaml
# cilium-bgp-multihome.yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: bgp-multihome
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux

  virtualRouters:
    - localASN: 65001
      exportPodCIDR: true
      neighbors:
        # Primary upstream (higher weight/preference)
        - peerAddress: "10.0.0.1/32"
          peerASN: 65000
          connectRetryTimeSeconds: 60
          holdTimeSeconds: 30
          keepAliveTimeSeconds: 10
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 60

        # Secondary upstream (equal-cost multipath)
        - peerAddress: "10.0.0.2/32"
          peerASN: 65000
          connectRetryTimeSeconds: 60
          holdTimeSeconds: 30
          keepAliveTimeSeconds: 10
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 60
```

## Section 4: Advertising LoadBalancer IPs

### IP Pool Configuration

```yaml
# cilium-lb-ippool.yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: production-ip-pool
spec:
  cidrs:
    - cidr: "203.0.113.0/27"   # 30 usable IPs for services
  serviceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: NotIn
        values:
          - kube-system
---
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: internal-ip-pool
spec:
  cidrs:
    - cidr: "172.20.0.0/24"    # Internal services pool
  serviceSelector:
    matchLabels:
      service-type: internal
```

### Service with LoadBalancer IP

```yaml
# service-with-bgp-lb.yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-api
  namespace: payments
  labels:
    advertise-via-bgp: "true"
  annotations:
    # Request specific IP from pool
    io.cilium/lb-ipam-ips: "203.0.113.10"
    # Or request from specific pool
    # io.cilium/lb-ipam-pool: production-ip-pool
spec:
  type: LoadBalancer
  selector:
    app: payment-service
  ports:
    - name: https
      port: 443
      targetPort: 8443
      protocol: TCP
    - name: http
      port: 80
      targetPort: 8080
      protocol: TCP
  externalTrafficPolicy: Local   # Preserve source IP, required for DSR
  ipFamilyPolicy: SingleStack
  ipFamilies:
    - IPv4
```

### Verify IP Allocation and BGP Advertisement

```bash
# Check IP pool status
kubectl get ciliumbgppeeringpolicy -o wide
kubectl get ciliumloadbalancerippools

# Verify service got an external IP
kubectl get svc payment-api -n payments
# NAME          TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S)
# payment-api   LoadBalancer   10.96.45.123    203.0.113.10    443:32443/TCP

# Check BGP route advertisement from a node
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=cilium -o jsonpath='{.items[0].metadata.name}') \
  -- cilium bgp routes advertised ipv4 unicast

# Verify route is received by upstream router (Arista)
# show ip bgp 203.0.113.10/32
```

## Section 5: BFD for Fast Failure Detection

BFD (Bidirectional Forwarding Detection) detects link failures in milliseconds rather than the 90-second default BGP hold time.

### BFD Configuration in Cilium BGP

```yaml
# cilium-bgp-bfd.yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: bgp-with-bfd
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux

  virtualRouters:
    - localASN: 65001
      exportPodCIDR: true
      neighbors:
        - peerAddress: "10.0.0.1/32"
          peerASN: 65000
          holdTimeSeconds: 30
          keepAliveTimeSeconds: 10
          # BFD configuration for fast failure detection
          # Requires GoBGP BFD support and router-side BFD configuration
          # Detection time: multiplier * interval = 3 * 300ms = 900ms
          bfd:
            enabled: true
            detectMultiplier: 3
            receiveIntervalMilliseconds: 300
            transmitIntervalMilliseconds: 300
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 120
```

### Router-Side BFD Configuration (Arista EOS)

```text
! Arista EOS BFD configuration for Kubernetes BGP peers
router bgp 65000
   neighbor 10.0.1.10 remote-as 65001
   neighbor 10.0.1.10 bfd
   neighbor 10.0.1.10 description kubernetes-node-1
   neighbor 10.0.1.10 maximum-routes 12000
   neighbor 10.0.1.10 send-community
   neighbor 10.0.1.11 remote-as 65001
   neighbor 10.0.1.11 bfd
   neighbor 10.0.1.11 description kubernetes-node-2

! BFD global settings
bfd interval 300 min-rx 300 multiplier 3
```

### Router-Side BFD Configuration (Juniper)

```text
# Juniper Junos BFD for Kubernetes BGP
protocols {
    bgp {
        group kubernetes-nodes {
            type external;
            peer-as 65001;
            bfd-liveness-detection {
                minimum-interval 300;
                multiplier 3;
                session-mode single;
            }
            neighbor 10.0.1.10 {
                description "kubernetes-node-1";
            }
            neighbor 10.0.1.11 {
                description "kubernetes-node-2";
            }
        }
    }
}
```

## Section 6: ECMP Load Balancing

ECMP distributes traffic to LoadBalancer IPs across all nodes advertising the same prefix.

### ECMP Configuration

```bash
# Cilium uses Maglev hashing for consistent ECMP
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set loadBalancer.algorithm=maglev \
  --set loadBalancer.mode=dsr \
  --set maglev.tableSize=65521 \
  --set tunnel=disabled
```

### Verify ECMP Routes on Upstream Router (Arista)

```text
! Arista EOS ECMP verification
show ip route 203.0.113.10/32

! Expected output with ECMP:
! B E      203.0.113.10/32 [200/0] via 10.0.1.10, Ethernet1
!                                  via 10.0.1.11, Ethernet2
!                                  via 10.0.1.12, Ethernet3

! Enable ECMP for BGP routes
router bgp 65000
   maximum-paths 8 ecmp 8
```

### DSR (Direct Server Return) for ECMP

```yaml
# DSR ensures that return traffic goes directly from the server to the client
# without bouncing back through the original entry node
# This requires externalTrafficPolicy: Local on services

apiVersion: v1
kind: Service
metadata:
  name: payment-api-ecmp
  namespace: payments
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local     # Required for DSR
  selector:
    app: payment-service
  ports:
    - port: 443
      targetPort: 8443
```

## Section 7: BGP Communities for Traffic Engineering

BGP communities allow selective route filtering and traffic steering at the network level.

### Community Configuration

```yaml
# cilium-bgp-communities.yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: bgp-with-communities
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux

  virtualRouters:
    - localASN: 65001
      exportPodCIDR: true
      neighbors:
        - peerAddress: "10.0.0.1/32"
          peerASN: 65000
          holdTimeSeconds: 90
          keepAliveTimeSeconds: 30
          # Advertise with communities
          # Communities are set per-advertisement-type in Cilium BGP
          advertisements:
            withAdvertisements:
              - advertisementType: PodCIDR
                communities:
                  standard:
                    - "65000:100"   # Internal traffic community
                    - "65000:200"   # Production cluster marker
              - advertisementType: Service
                service:
                  addresses:
                    - LoadBalancerIP
                communities:
                  standard:
                    - "65000:300"   # External service community
                  wellKnown:
                    - "no-export"   # Don't export to eBGP peers
```

### Router-Side Community Filtering (Arista)

```text
! Accept routes from Kubernetes with specific community
ip community-list standard k8s-pods-community permit 65000:100
ip community-list standard k8s-services-community permit 65000:300

! Route maps for community-based traffic steering
route-map k8s-inbound permit 10
   match community k8s-pods-community
   set local-preference 150
   set metric 100
!
route-map k8s-services-inbound permit 10
   match community k8s-services-community
   set local-preference 200
   set metric 50

! Apply to BGP neighbors
router bgp 65000
   neighbor kubernetes-nodes route-map k8s-inbound in
   neighbor kubernetes-nodes route-map k8s-services-inbound in
```

## Section 8: Integration with Physical Network Infrastructure

### Complete Leaf-Spine Integration

```yaml
# Production BGP topology: Nodes peer with leaf switches
# Leaf switches peer with spine switches
# Spine switches connect to external network

# Node BGP configuration for leaf-spine topology
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: leaf-spine-bgp
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux

  virtualRouters:
    - localASN: 65001
      exportPodCIDR: true
      neighbors:
        # Primary leaf pair (eBGP to leaf switches)
        - peerAddress: "10.0.0.1/32"
          peerASN: 65100   # Leaf-1 ASN
          holdTimeSeconds: 30
          keepAliveTimeSeconds: 10
          bfd:
            enabled: true
            detectMultiplier: 3
            receiveIntervalMilliseconds: 300
            transmitIntervalMilliseconds: 300
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 60
          advertisements:
            withAdvertisements:
              - advertisementType: PodCIDR
              - advertisementType: Service
                service:
                  addresses:
                    - LoadBalancerIP

        - peerAddress: "10.0.0.2/32"
          peerASN: 65101   # Leaf-2 ASN
          holdTimeSeconds: 30
          keepAliveTimeSeconds: 10
          bfd:
            enabled: true
            detectMultiplier: 3
            receiveIntervalMilliseconds: 300
            transmitIntervalMilliseconds: 300
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 60
          advertisements:
            withAdvertisements:
              - advertisementType: PodCIDR
              - advertisementType: Service
                service:
                  addresses:
                    - LoadBalancerIP
```

### Arista Leaf Switch Configuration

```text
! Arista EOS leaf switch BGP for Kubernetes nodes
! Leaf ASN: 65100

service routing protocols model multi-agent

ip routing

! BGP prefix limits and route dampening
router bgp 65100
   router-id 10.0.0.1
   maximum-paths 8 ecmp 8
   bgp log-neighbor-changes

   ! Spine peer group
   peer-group SPINE
   peer-group SPINE remote-as 65000
   peer-group SPINE bfd
   peer-group SPINE send-community

   ! Kubernetes node peer group
   peer-group K8S-NODES
   peer-group K8S-NODES remote-as 65001
   peer-group K8S-NODES bfd
   peer-group K8S-NODES send-community
   peer-group K8S-NODES maximum-routes 1000

   ! Spine neighbors
   neighbor 10.1.0.1 peer-group SPINE
   neighbor 10.1.0.2 peer-group SPINE

   ! Kubernetes node neighbors (auto-discovered via management prefix)
   bgp listen range 10.0.1.0/24 peer-group K8S-NODES

   ! Redistribute connected networks
   redistribute connected route-map LEAF-LOOPBACK

   address-family ipv4
      neighbor SPINE activate
      neighbor K8S-NODES activate
      network 10.0.0.0/24
```

### Node Labeling for Rack-Aware BGP

```bash
# Label nodes with rack/ToR information for topology-aware BGP
kubectl label node k8s-node-01 rack=rack-a tor=tor-1
kubectl label node k8s-node-02 rack=rack-a tor=tor-1
kubectl label node k8s-node-03 rack=rack-b tor=tor-2
kubectl label node k8s-node-04 rack=rack-b tor=tor-2

# Different peering policies per rack
kubectl apply -f - <<'EOF'
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: bgp-rack-a
spec:
  nodeSelector:
    matchLabels:
      rack: rack-a
  virtualRouters:
    - localASN: 65001
      exportPodCIDR: true
      neighbors:
        - peerAddress: "10.0.0.1/32"  # ToR-1
          peerASN: 65100
          holdTimeSeconds: 30
          keepAliveTimeSeconds: 10
EOF
```

## Section 9: Replacing MetalLB with Cilium BGP

### Migration Strategy

```bash
# Step 1: Verify Cilium BGP is functional with test service
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: bgp-test
  namespace: default
  annotations:
    io.cilium/lb-ipam-pool: production-ip-pool
spec:
  type: LoadBalancer
  selector:
    app: nginx-test
  ports:
    - port: 80
      targetPort: 80
EOF

kubectl get svc bgp-test
# Verify EXTERNAL-IP is assigned from Cilium pool

# Step 2: Check route is advertised
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=cilium -o jsonpath='{.items[0].metadata.name}') \
  -- cilium bgp routes advertised ipv4 unicast

# Step 3: Verify connectivity from outside the cluster
curl -v http://$(kubectl get svc bgp-test -o jsonpath='{.status.loadBalancer.ingress[0].ip}')/

# Step 4: Migrate services from MetalLB IP pools to Cilium IP pools
# Add Cilium annotation before removing MetalLB annotation
kubectl annotate svc payment-api \
  io.cilium/lb-ipam-ips=203.0.113.10 \
  metallb.universe.tf/address-pool-

# Step 5: Scale down MetalLB components
kubectl scale deployment controller \
  -n metallb-system --replicas=0
kubectl scale daemonset speaker \
  -n metallb-system --replicas=0

# Step 6: Remove MetalLB
helm uninstall metallb -n metallb-system
```

### MetalLB to Cilium Configuration Mapping

```yaml
# MetalLB address pool (before)
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: production-pool
  namespace: metallb-system
spec:
  addresses:
    - 203.0.113.0/27
---
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: production-advertisement
  namespace: metallb-system
spec:
  ipAddressPools:
    - production-pool
  peers:
    - router-1

# Equivalent Cilium configuration (after)
---
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: production-ip-pool
spec:
  cidrs:
    - cidr: "203.0.113.0/27"
---
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: bgp-peering-production
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux
  virtualRouters:
    - localASN: 65001
      exportPodCIDR: true
      neighbors:
        - peerAddress: "10.0.0.1/32"
          peerASN: 65000
          advertisements:
            withAdvertisements:
              - advertisementType: Service
                service:
                  addresses:
                    - LoadBalancerIP
```

## Section 10: Monitoring BGP State

### Prometheus Metrics

```yaml
# cilium-bgp-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cilium-bgp-metrics
  namespace: kube-system
spec:
  selector:
    matchLabels:
      k8s-app: cilium
  endpoints:
    - port: prometheus
      path: /metrics
      interval: 30s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
```

### BGP Prometheus Alert Rules

```yaml
# cilium-bgp-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cilium-bgp-alerts
  namespace: kube-system
spec:
  groups:
    - name: cilium.bgp
      rules:
        - alert: CiliumBGPSessionDown
          expr: |
            cilium_bgp_peer_state{state!="established"} == 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Cilium BGP session is not established"
            description: "BGP session to {{ $labels.peer }} on node {{ $labels.node }} is {{ $labels.state }}"

        - alert: CiliumBGPNoRoutes
          expr: |
            sum by (node) (cilium_bgp_routes_advertised) == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Cilium BGP node advertising no routes"
            description: "Node {{ $labels.node }} has no BGP routes being advertised"

        - alert: CiliumBGPIPPoolExhausted
          expr: |
            cilium_ipam_ips_used / cilium_ipam_ips_capacity > 0.90
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Cilium IP pool more than 90% exhausted"
```

### BGP Troubleshooting Commands

```bash
# Check BGP session state for all nodes
for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
  echo "=== Node: ${node} ==="
  kubectl exec -n kube-system \
    $(kubectl get pods -n kube-system -l k8s-app=cilium \
      --field-selector spec.nodeName="${node}" \
      -o jsonpath='{.items[0].metadata.name}') \
    -- cilium bgp peers 2>/dev/null || echo "Could not query ${node}"
done

# View all advertised routes
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=cilium -o jsonpath='{.items[0].metadata.name}') \
  -- cilium bgp routes advertised ipv4 unicast

# View routes received from peers
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=cilium -o jsonpath='{.items[0].metadata.name}') \
  -- cilium bgp routes available ipv4 unicast

# Check IP pool assignments
kubectl get ciliumpodippools -o wide
kubectl get ciliumloadbalancerippools -o wide

# Verify service external IP is from expected pool
kubectl get svc -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,TYPE:.spec.type,EXTERNAL-IP:.status.loadBalancer.ingress[0].ip' | \
  grep LoadBalancer | grep -v none

# Test BGP route from node to external
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=cilium -o jsonpath='{.items[0].metadata.name}') \
  -- sh -c "ip route show 203.0.113.0/27"
```

## Summary

Cilium BGP control plane delivers native Kubernetes network routing without the overhead of cloud load balancer abstractions. The CiliumBGPPeeringPolicy CRD provides a declarative, Kubernetes-native interface for configuring BGP sessions that previously required separate tooling (MetalLB, ExaBGP) or manual router configuration.

Key operational benefits over MetalLB include tighter eBPF integration for DSR and Maglev-based ECMP, a unified control plane with Cilium's network policy and observability features, and support for both LoadBalancer IP advertisement and pod CIDR routing in the same policy. BFD integration reduces failure detection from 90 seconds to under 1 second, enabling the network to respond to node failures at the same speed as Kubernetes' own health checking.

For bare-metal clusters, the migration path from MetalLB to Cilium BGP is zero-downtime: deploy the Cilium IP pool alongside the MetalLB pool, migrate services one by one using annotations, verify each service maintains connectivity, then decommission MetalLB after all services are verified.
