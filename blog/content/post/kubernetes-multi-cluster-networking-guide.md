---
title: "Multi-Cluster Kubernetes Networking: Submariner, Skupper, and ClusterLink"
date: 2028-02-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Cluster", "Networking", "Submariner", "Skupper", "Cilium", "ClusterMesh"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to multi-cluster Kubernetes networking architectures using Submariner, Skupper, Cilium ClusterMesh, and ClusterLink. Covers L3 vs L7 approaches, BGP peering, ServiceImport/ServiceExport, and GlobalNetworkPolicy."
more_link: "yes"
url: "/kubernetes-multi-cluster-networking-guide/"
---

Multi-cluster Kubernetes deployments are increasingly common in enterprise environments for reasons ranging from failure domain isolation and regional latency optimization to regulatory data residency requirements. However, connecting these clusters introduces networking complexity that the standard Kubernetes API does not address: pods in cluster A need to reach services in cluster B, DNS must resolve cross-cluster service names, and network policies must extend across cluster boundaries.

This guide examines four production approaches to multi-cluster networking—Submariner for L3 IPsec/VXLAN tunneling, Skupper for L7 application-layer interconnect, Cilium ClusterMesh for CNI-native federation, and ClusterLink as an emerging CNCF sandbox project—covering their architecture, deployment, and operational characteristics.

<!--more-->

# Multi-Cluster Kubernetes Networking: Submariner, Skupper, and ClusterLink

## Multi-Cluster Networking Approaches

Before selecting a technology, understanding the design space helps match the solution to requirements:

| Approach | Layer | Encryption | DNS | Service Discovery | Use Case |
|----------|-------|-----------|-----|-------------------|----------|
| Submariner | L3 | IPsec/WireGuard | ServiceImport | Push (broker) | General pod-to-pod |
| Skupper | L7 | mTLS | FQDN | Pull (CLI) | App-layer, no CNI change |
| Cilium ClusterMesh | L3 | WireGuard | Internal DNS | Automatic | Cilium-native clusters |
| ClusterLink | L4/L7 | mTLS | Policy-based | Gateway | Zero-trust inter-cluster |

**L3 approaches** (Submariner, ClusterMesh) provide transparent pod-to-pod connectivity. A pod in cluster A reaches a pod in cluster B using the same networking primitives as within-cluster communication. This is the lowest-friction approach for existing applications.

**L7 approaches** (Skupper) intercept traffic at the application layer, enabling routing through virtual application networks without modifying pod CIDR routing tables. This trades transparency for flexibility and CNI independence.

## Submariner: L3 Cross-Cluster Networking

Submariner creates encrypted tunnels between cluster gateway nodes, routing pod CIDR and Service CIDR traffic across cluster boundaries.

### Submariner Architecture Components

```
Cluster A                              Cluster B
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ ┌─────────┐  ┌───────────┐  │        │ ┌──────────────┐ ┌─────────┐│
│ │ Route   │  │ Lighthouse │  │        │ │ Lighthouse   │ │ Route   ││
│ │ Agent   │  │ Agent     │  │        │ │ Agent        │ │ Agent   ││
│ └────┬────┘  └─────┬─────┘  │        │ └──────┬───────┘ └────┬────┘│
│      │             │         │        │        │               │     │
│ ┌────▼─────────────▼────┐    │        │ ┌──────▼───────────────▼──┐ │
│ │   Gateway Node         │◄──┼────────┼►│   Gateway Node          │ │
│ │   (IPsec/WireGuard)    │   │        │ │   (IPsec/WireGuard)     │ │
│ └───────────────────────┘    │        │ └─────────────────────────┘ │
└─────────────────────────────┘        └──────────────────────────────┘
                    │                              │
                    └──────────────┬───────────────┘
                              ┌────▼────┐
                              │  Broker │
                              │ Cluster │
                              └─────────┘
```

### Installing the Broker

The broker cluster holds global cluster state. It does not carry data plane traffic:

```bash
# Install subctl (Submariner CLI)
curl -Ls https://get.submariner.io | bash
export PATH=$PATH:~/.local/bin

# Set context for the broker cluster
kubectl config use-context broker-cluster

# Deploy the broker
subctl deploy-broker \
  --kubecontext broker-cluster \
  --globalnet                   # Enable GlobalNet for overlapping CIDRs

# Generate joining credentials
# broker-info.subm contains connection details for worker clusters
ls -la broker-info.subm
```

### Joining Worker Clusters

```bash
# Join cluster A to the broker
subctl join broker-info.subm \
  --kubecontext cluster-a \
  --clusterid cluster-a \
  --natt-port 4500 \
  --ikeport 500 \
  --cable-driver libreswan    # Cable driver: libreswan (IPsec) or wireguard

# Join cluster B
subctl join broker-info.subm \
  --kubecontext cluster-b \
  --clusterid cluster-b \
  --natt-port 4500 \
  --cable-driver libreswan

# Verify connectivity
subctl verify \
  --kubecontext cluster-a \
  --tocontext cluster-b \
  --connectivity   # Run connectivity tests

# Diagnose potential issues
subctl diagnose all \
  --kubecontext cluster-a
```

### ServiceExport and ServiceImport

Submariner uses the Kubernetes MCS (Multi-Cluster Services) API for service discovery across clusters:

```yaml
# service-export.yaml
# Export a service from cluster A to make it discoverable in other clusters.
# Apply this in cluster A where the service lives.
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: user-service
  namespace: microservices
  # No spec required: the export refers to the Service of the same name/namespace
---
# The exported service must exist:
apiVersion: v1
kind: Service
metadata:
  name: user-service
  namespace: microservices
spec:
  selector:
    app: user-service
  ports:
  - port: 8080
    targetPort: 8080
```

```bash
# After creating the ServiceExport in cluster A,
# Lighthouse syncs a ServiceImport to all other joined clusters

# Verify ServiceImport is visible in cluster B
kubectl --context cluster-b \
  get serviceimport user-service -n microservices -o yaml
```

```yaml
# ServiceImport auto-created by Lighthouse in cluster B
# Pods in cluster B can reach user-service via DNS:
# user-service.microservices.svc.clusterset.local
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: user-service
  namespace: microservices
spec:
  type: ClusterSetIP
  ports:
  - port: 8080
    protocol: TCP
  ips:
  - "242.0.0.1"   # GlobalNet virtual IP (if GlobalNet enabled)
```

### DNS Resolution for Cross-Cluster Services

```yaml
# coredns-lighthouse-config.yaml
# CoreDNS configuration updated by Submariner Lighthouse
# to resolve clusterset.local domain names.
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health
        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
        }
        # Lighthouse plugin handles clusterset.local queries
        lighthouse
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
```

```bash
# Test cross-cluster DNS resolution from a pod in cluster B
kubectl --context cluster-b \
  run dns-test \
  --image=nicolaka/netshoot \
  --rm -it \
  --restart=Never \
  -- nslookup user-service.microservices.svc.clusterset.local

# Expected output:
# Server: 10.96.0.10
# Address: 10.96.0.10#53
# Name: user-service.microservices.svc.clusterset.local
# Address: 242.0.0.1   <- GlobalNet virtual IP
```

### GlobalNet for Overlapping CIDRs

Most enterprise multi-cluster deployments have overlapping pod/service CIDRs because clusters were provisioned independently. Submariner GlobalNet solves this:

```yaml
# globalnet maps each cluster's pod CIDR to a unique global CIDR
# Cluster A pod CIDR: 10.244.0.0/16 -> GlobalNet: 242.0.0.0/16
# Cluster B pod CIDR: 10.244.0.0/16 -> GlobalNet: 242.1.0.0/16
# Traffic between clusters uses GlobalNet IPs, not original pod IPs

# Check GlobalCIDR allocation
kubectl --context broker-cluster \
  get clusterglobalegressips -A

# Per-cluster GlobalNet allocation
kubectl --context cluster-a \
  get globalingressips -n microservices
```

### Submariner Monitoring

```yaml
# prometheusrule-submariner.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: submariner-alerts
  namespace: submariner-operator
spec:
  groups:
  - name: submariner
    rules:
    # Alert when gateway tunnel is down
    - alert: SubmarinerGatewayTunnelDown
      expr: submariner_gateway_tunnel_status{status="connected"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Submariner tunnel down between {{ $labels.local_cluster }} and {{ $labels.remote_cluster }}"

    # High latency across tunnel
    - alert: SubmarinerTunnelLatencyHigh
      expr: >
        histogram_quantile(0.99,
          rate(submariner_gateway_roundtrip_time_seconds_bucket[5m])
        ) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Cross-cluster latency exceeds 100ms"
```

## Skupper: L7 Application-Layer Interconnect

Skupper creates a Virtual Application Network (VAN) using mTLS-encrypted connections between sites. Unlike Submariner, Skupper operates at L7 and requires no changes to cluster networking, making it suitable for environments where pod CIDR routing changes are not feasible.

### Skupper Architecture

```
Site A (cluster-a)                    Site B (cluster-b)
┌─────────────────────────────┐        ┌────────────────────────────┐
│ ┌──────────────────────┐    │        │ ┌───────────────────────┐  │
│ │ skupper-router       │    │        │ │ skupper-router        │  │
│ │ (Envoy L7 proxy)     │◄───┼────────┼►│ (Envoy L7 proxy)      │  │
│ └──────────────────────┘    │        │ └───────────────────────┘  │
│                              │        │                            │
│ app-pod ──► skupper-router  │        │ skupper-router ──► svc    │
└─────────────────────────────┘        └────────────────────────────┘
```

### Skupper Deployment

```bash
# Install Skupper CLI
curl https://skupper.io/install.sh | sh

# Initialize Skupper in cluster A (creates the router deployment)
kubectl config use-context cluster-a
skupper init \
  --site-name cluster-a \
  --enable-console \
  --enable-flow-collector \
  --console-auth=internal

# Initialize Skupper in cluster B
kubectl config use-context cluster-b
skupper init --site-name cluster-b

# Create a link token from cluster A (token grants cluster B the right to link)
kubectl config use-context cluster-a
skupper token create cluster-a-token.yaml

# Use the token to link cluster B to cluster A
kubectl config use-context cluster-b
skupper link create cluster-a-token.yaml \
  --name link-to-cluster-a

# Verify the link is active
skupper link status
# Link link-to-cluster-a is active
```

### Exposing Services via Skupper

```bash
# Expose a service from cluster A over the VAN
# The service becomes reachable from cluster B via Skupper routing
kubectl config use-context cluster-a

# Expose an existing Kubernetes service
skupper expose service user-service \
  --address user-service \   # Name used in VAN
  --port 8080

# Or expose a deployment directly
skupper expose deployment inventory-api \
  --port 9090 \
  --target-port 9090

# In cluster B, a Skupper service is automatically created
kubectl config use-context cluster-b
kubectl get service user-service
# NAME           TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)    AGE
# user-service   ClusterIP   10.100.5.200   <none>        8080/TCP   2m

# Pods in cluster B reach the service via normal Kubernetes DNS
# skupper-router transparently routes to cluster A
curl http://user-service.default.svc.cluster.local:8080/health
```

```yaml
# skupper-service-manifest.yaml
# Declarative Skupper service definition (alternative to CLI)
apiVersion: skupper.io/v1alpha1
kind: SkupperClusterPolicy
metadata:
  name: allow-incoming-links
  namespace: default
spec:
  # Allow other sites to link to this site
  allowIncomingLinks: true
  # Allow service exposure over VAN
  allowedExposedResources:
  - "service/user-service"
  - "deployment/inventory-api"
  # Restrict which namespaces can expose services
  allowedServices:
  - "user-service"
  - "inventory-api"
```

### Skupper Network Status

```bash
# Show Skupper network topology and service status
skupper network status

# Output:
# Sites:
# - cluster-a: active (2 links)
#   - Services: user-service, inventory-api
# - cluster-b: active (1 link)
#   - Services: payment-service
#
# Connections:
# - cluster-a ↔ cluster-b (mTLS, latency: 8ms)

# Check service binding
skupper service status

# Monitor traffic flow
skupper network status --verbose
```

## Cilium ClusterMesh

ClusterMesh is Cilium's native multi-cluster feature. When all clusters run Cilium as their CNI, ClusterMesh enables transparent pod-to-pod connectivity and shared network policies without the overhead of separate overlay tunnels.

### ClusterMesh Prerequisites

```bash
# All clusters must run Cilium with ClusterMesh enabled
# Cluster IDs must be unique (1-255)
# Pod CIDRs must not overlap

# Enable ClusterMesh in cluster A
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --set cluster.id=1 \
  --set cluster.name=cluster-a \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.service.type=LoadBalancer

# Enable ClusterMesh in cluster B
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --set cluster.id=2 \
  --set cluster.name=cluster-b \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.service.type=LoadBalancer
```

### Connecting Clusters

```bash
# Install cilium CLI
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
CLI_ARCH=amd64
curl -L --fail --remote-name-all \
  "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${CLI_ARCH}.tar.gz"
tar xzvf cilium-linux-${CLI_ARCH}.tar.gz
sudo mv cilium /usr/local/bin

# Connect cluster A and cluster B
# This exchanges API server credentials between clusters
cilium clustermesh connect \
  --context cluster-a \
  --destination-context cluster-b

# Verify ClusterMesh status
cilium clustermesh status \
  --context cluster-a \
  --wait

# Output:
# ClusterMesh:           OK
# MaxConnectedClusters:  255
# Connected Clusters:    1
# Cluster:               cluster-b
#   Status:              OK
#   IP:                  192.168.1.100
#   Endpoints:           3
```

### Global Services for Load Balancing

```yaml
# global-service.yaml
# A Global Service distributes traffic across pods in all connected clusters.
# The annotation makes Cilium route requests to healthy backends globally.
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: production
  annotations:
    # Marks this as a globally shared service
    service.cilium.io/global: "true"
    # shared: endpoints from this cluster are visible to other clusters
    service.cilium.io/shared: "true"
spec:
  selector:
    app: api-gateway
  ports:
  - port: 8080
    targetPort: 8080
  type: ClusterIP
```

```bash
# Verify global service endpoints are distributed
# Run from cluster A
kubectl --context cluster-a \
  get ciliumendpointslice \
  -l service=api-gateway

# Check global service status
cilium service list --context cluster-a \
  | grep api-gateway
```

### GlobalNetworkPolicy for Multi-Cluster Security

```yaml
# global-network-policy.yaml
# CiliumClusterwideNetworkPolicy applies across all connected clusters.
# This policy allows microservices in cluster A to reach services
# in cluster B on the authorized port only.
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-cross-cluster-api
  namespace: microservices
spec:
  endpointSelector:
    matchLabels:
      app: frontend

  # Allow egress to the API in any cluster within the mesh
  egress:
  - toEndpoints:
    - matchLabels:
        app: api-gateway
        # io.cilium.k8s.policy.cluster matches the source cluster label
        # empty string = any cluster in the mesh
        io.cilium.k8s.policy.cluster: ""
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
```

### ClusterMesh Affinity Policies

```yaml
# cluster-affinity-service.yaml
# Configure traffic affinity to prefer local cluster endpoints.
# Falls back to remote clusters only when local pods are unhealthy.
apiVersion: v1
kind: Service
metadata:
  name: user-service
  namespace: microservices
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/shared: "true"
    # Affinity: local = prefer local cluster, none = round-robin globally
    service.cilium.io/affinity: "local"
spec:
  selector:
    app: user-service
  ports:
  - port: 8080
```

## BGP Peering Between Clusters

For environments using on-premises hardware where an L3 fabric is available, BGP peering between cluster gateway nodes enables cluster-native routing without tunnel overhead:

```yaml
# cilium-bgpconfig-cluster-a.yaml
# Cilium BGP configuration for cluster A.
# Advertises pod CIDR to the datacenter fabric.
# Remote clusters receive the routes via iBGP/eBGP.
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPClusterConfig
metadata:
  name: cluster-a-bgp
spec:
  nodeSelector:
    matchLabels:
      node-role.kubernetes.io/gateway: "true"

  bgpInstances:
  - name: cluster-a-instance
    localASN: 65001   # Cluster A's private AS number

    peers:
    # Peer with datacenter spine switches
    - name: spine-01
      peerASN: 65000   # Fabric AS number
      peerAddress: "10.0.0.1"
      peerConfigRef:
        name: cluster-peer-config

    - name: spine-02
      peerASN: 65000
      peerAddress: "10.0.0.2"
      peerConfigRef:
        name: cluster-peer-config
---
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeerConfig
metadata:
  name: cluster-peer-config
spec:
  authSecretRef:
    name: bgp-auth-secret  # MD5 BGP session password
  gracefulRestart:
    enabled: true
    restartTimeSeconds: 120
  families:
  - afi: ipv4
    safi: unicast
    advertisements:
      matchLabels:
        advertise: "pod-cidr"  # Advertise pod CIDR routes
---
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPAdvertisement
metadata:
  name: pod-cidr-advertisement
  labels:
    advertise: "pod-cidr"
spec:
  advertisements:
  - advertisementType: "PodCIDR"    # Advertise this cluster's pod CIDR
  - advertisementType: "Service"    # Also advertise Service CIDRs
    service:
      addresses:
      - ClusterIP
      - ExternalIP
```

## ClusterLink: CNCF Sandbox Multi-Cluster Gateway

ClusterLink is a newer approach that uses dedicated gateways and access policies to enable application-level multi-cluster connectivity with zero-trust semantics:

```yaml
# clusterlink-gateway.yaml
# Deploy a ClusterLink gateway in each cluster.
# Gateways authenticate with mTLS and enforce access policies.
apiVersion: clusterlink.net/v1alpha1
kind: Instance
metadata:
  name: cl-gateway
  namespace: clusterlink-system
spec:
  # Number of gateway replicas
  dataplaneReplicas: 2
  # Gateway image (adjust version as needed)
  containerRegistry: ghcr.io/clusterlink-net
  # Ingress for receiving inter-cluster connections
  ingress:
    type: LoadBalancer
    port: 443
```

```yaml
# clusterlink-peer.yaml
# Register cluster B as a peer of cluster A
apiVersion: clusterlink.net/v1alpha1
kind: Peer
metadata:
  name: cluster-b
  namespace: clusterlink-system
spec:
  gateways:
  - host: "cluster-b-gateway.example.com"
    port: 443
```

```yaml
# clusterlink-export-import.yaml
# Export a service from cluster A
apiVersion: clusterlink.net/v1alpha1
kind: Export
metadata:
  name: user-service-export
  namespace: default
spec:
  port: 8080
  host: user-service.default.svc.cluster.local
---
# Import the service in cluster B
apiVersion: clusterlink.net/v1alpha1
kind: Import
metadata:
  name: user-service
  namespace: default
spec:
  port: 8080
  sources:
  - exportName: user-service-export
    exportNamespace: default
    peer: cluster-a
---
# Access policy: allow frontend pods in cluster B to reach user-service
apiVersion: clusterlink.net/v1alpha1
kind: AccessPolicy
metadata:
  name: allow-frontend-to-user-service
  namespace: default
spec:
  action: allow
  from:
  - workloadSelector:
      matchLabels:
        app: frontend
  to:
  - workloadSelector:
      matchLabels:
        app: user-service
```

## Comparative Analysis

### Latency Overhead

```bash
# Measure latency overhead of each approach
# Run from a pod in cluster B to a service in cluster A

# Direct service (baseline, same cluster)
kubectl exec -it test-pod -- \
  curl -w "%{time_connect}ms\n" -o /dev/null -s \
  http://local-service:8080/

# Submariner (IPsec tunnel)
kubectl exec -it test-pod -- \
  curl -w "%{time_connect}ms\n" -o /dev/null -s \
  http://user-service.microservices.svc.clusterset.local:8080/

# Skupper (L7 proxy)
kubectl exec -it test-pod -- \
  curl -w "%{time_connect}ms\n" -o /dev/null -s \
  http://user-service.default.svc.cluster.local:8080/

# Cilium ClusterMesh (direct routing, no tunnel for same L3 segment)
kubectl exec -it test-pod -- \
  curl -w "%{time_connect}ms\n" -o /dev/null -s \
  http://user-service.microservices.svc.cluster.local:8080/
```

### Decision Framework

```
Requirements                           Recommended Approach
─────────────────────────────────────────────────────────────
All clusters run Cilium                → Cilium ClusterMesh
Overlapping pod CIDRs                  → Submariner + GlobalNet
No CNI changes permitted               → Skupper
On-premises with L3 fabric             → BGP peering (native routing)
Zero-trust between clusters required   → ClusterLink
Mixed CNIs, diverse environments       → Submariner
Compliance requiring protocol-level control → Skupper (L7 inspection)
```

## Operational Considerations

### Multi-Cluster DNS Strategy

```yaml
# external-dns-multicluster.yaml
# Configure ExternalDNS to create DNS records for cross-cluster services.
# Each cluster's services get entries in a shared DNS zone.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: external-dns
        image: registry.k8s.io/external-dns/external-dns:v0.14.0
        args:
        - --source=service
        - --source=ingress
        # clusterset.local records for Submariner compatibility
        - --domain-filter=clusterset.local
        - --domain-filter=internal.example.com
        - --provider=aws
        # Tag records with cluster ID for ownership tracking
        - --txt-owner-id=cluster-a
        - --registry=txt
```

### Cross-Cluster Health Checking

```bash
#!/bin/bash
# check-cross-cluster-health.sh
# Validates connectivity between all cluster pairs.
# Run as a CronJob in the broker/management cluster.

CLUSTERS=("cluster-a" "cluster-b" "cluster-c")
NAMESPACE="cross-cluster-test"

for src in "${CLUSTERS[@]}"; do
    for dst in "${CLUSTERS[@]}"; do
        if [ "${src}" == "${dst}" ]; then
            continue
        fi

        echo -n "Testing ${src} → ${dst}: "

        # Create a test pod in the source cluster
        result=$(kubectl --context "${src}" run cross-cluster-test-${RANDOM} \
          --image=curlimages/curl:8.4.0 \
          --rm \
          --restart=Never \
          --namespace="${NAMESPACE}" \
          -q \
          --command -- \
          curl -s -o /dev/null -w "%{http_code}" \
          --max-time 5 \
          "http://health-service.${NAMESPACE}.svc.clusterset.local/health" \
          2>/dev/null)

        if [ "${result}" == "200" ]; then
            echo "OK (HTTP ${result})"
        else
            echo "FAIL (HTTP ${result})"
        fi
    done
done
```

## Summary

Multi-cluster Kubernetes networking requires choosing the right abstraction layer for the operational environment. Submariner provides transparent L3 connectivity with GlobalNet support for overlapping CIDRs, making it the most general solution. Cilium ClusterMesh offers the lowest overhead when all clusters run Cilium, with native support for global services and cross-cluster network policies. Skupper enables application-layer connectivity without modifying cluster networking, suited for mixed CNI environments or where network teams cannot be engaged. ClusterLink provides zero-trust semantics with explicit access policies.

In practice, enterprise deployments often combine these approaches: Cilium ClusterMesh for greenfield clusters, Submariner for connecting legacy clusters with different CNIs, and Skupper for connecting cloud environments to on-premises infrastructure. The ServiceImport/ServiceExport API provides a standard cross-cluster service discovery mechanism that multiple implementations support, enabling flexibility in the underlying transport layer.
