---
title: "Cilium ClusterMesh: Multi-Cluster Connectivity and Network Policy Federation"
date: 2029-01-04T00:00:00-05:00
draft: false
tags: ["Cilium", "ClusterMesh", "Kubernetes", "Networking", "eBPF"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying Cilium ClusterMesh for multi-cluster service discovery, cross-cluster load balancing, and federated network policies in enterprise Kubernetes environments."
more_link: "yes"
url: "/cilium-clustermesh-multi-cluster-connectivity/"
---

As Kubernetes deployments grow beyond single clusters, organizations face the challenge of enabling services to communicate across cluster boundaries while maintaining consistent security policies. Cilium ClusterMesh extends eBPF-based networking across multiple clusters, providing global service load balancing, cross-cluster network policies, and unified identity-based security without a central service mesh control plane.

This guide covers ClusterMesh architecture, deployment procedures, global service configuration, network policy federation, and operational runbooks for enterprise multi-cluster environments.

<!--more-->

## ClusterMesh Architecture

Cilium ClusterMesh establishes a control plane connection between clusters using etcd as the state synchronization substrate. Each cluster runs its own Cilium installation, and ClusterMesh adds:

- **Cluster mesh API server**: Exposes the cluster's Cilium state (endpoints, identities, services) via a dedicated etcd instance
- **Cross-cluster service discovery**: Services annotated as global are visible to all connected clusters
- **Identity federation**: Cilium security identities (based on pod labels) are synchronized across clusters, enabling policy enforcement that spans cluster boundaries
- **Remote node tunnel**: Data plane traffic between clusters flows through encrypted tunnels (VXLAN or Geneve)

### ClusterMesh vs. Other Multi-Cluster Approaches

| Approach | Control Plane | Data Plane | Policy Federation | Latency |
|----------|--------------|------------|-------------------|---------|
| ClusterMesh | Cilium etcd mesh | Direct eBPF | Yes | Low |
| Istio Federation | Istiod | Envoy sidecar | Limited | Medium |
| Submariner | Broker CRD | IPsec/VXLAN | No | Medium |
| KubeFed | Federation controller | Kubernetes native | No | N/A |

ClusterMesh's direct eBPF data plane avoids the latency and resource overhead of sidecar proxies while providing richer policy capabilities than pure network-level solutions.

## Prerequisites and Planning

### Network Requirements

ClusterMesh requires that:
1. Pod CIDR ranges do not overlap between clusters (each cluster needs a unique pod subnet)
2. Node IP ranges do not overlap between clusters
3. The ClusterMesh API server is reachable from all member clusters on port 2379

| Cluster | Pod CIDR | Service CIDR | Node Range |
|---------|----------|--------------|------------|
| cluster-us-east | 10.0.0.0/16 | 10.100.0.0/16 | 10.200.0.0/16 |
| cluster-us-west | 10.1.0.0/16 | 10.101.0.0/16 | 10.201.0.0/16 |
| cluster-eu-west | 10.2.0.0/16 | 10.102.0.0/16 | 10.202.0.0/16 |

### Cluster Naming

Each cluster must have a unique name configured in the Cilium Helm values. This name identifies the cluster in ClusterMesh and is used in service annotations:

```bash
# Verify current cluster name
kubectl -n kube-system get configmap cilium-config -o jsonpath='{.data.cluster-name}'
kubectl -n kube-system get configmap cilium-config -o jsonpath='{.data.cluster-id}'
```

Cluster IDs must be unique integers in the range 1-255.

## Installing Cilium with ClusterMesh Support

### Helm Installation

```bash
# Add Cilium Helm repository
helm repo add cilium https://helm.cilium.io/
helm repo update

# Install Cilium on cluster-us-east with ClusterMesh enabled
helm install cilium cilium/cilium \
  --version 1.16.3 \
  --namespace kube-system \
  --set cluster.name=cluster-us-east \
  --set cluster.id=1 \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.replicas=3 \
  --set clustermesh.apiserver.service.type=LoadBalancer \
  --set clustermesh.apiserver.tls.auto.method=helm \
  --set ipam.mode=cluster-pool \
  --set ipam.operator.clusterPoolIPv4PodCIDRList="10.0.0.0/16" \
  --set operator.replicas=2 \
  --set tunnel=vxlan \
  --set encryption.enabled=true \
  --set encryption.type=wireguard
```

```bash
# Install on cluster-us-west
helm install cilium cilium/cilium \
  --version 1.16.3 \
  --namespace kube-system \
  --set cluster.name=cluster-us-west \
  --set cluster.id=2 \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.replicas=3 \
  --set clustermesh.apiserver.service.type=LoadBalancer \
  --set clustermesh.apiserver.tls.auto.method=helm \
  --set ipam.mode=cluster-pool \
  --set ipam.operator.clusterPoolIPv4PodCIDRList="10.1.0.0/16" \
  --set operator.replicas=2 \
  --set tunnel=vxlan \
  --set encryption.enabled=true \
  --set encryption.type=wireguard
```

### Verify ClusterMesh API Server

```bash
# Check ClusterMesh API server status
kubectl -n kube-system get pods -l app=clustermesh-apiserver

# Get the external IP for the ClusterMesh API server
kubectl -n kube-system get svc clustermesh-apiserver
```

## Connecting Clusters

### Using cilium CLI

The `cilium` CLI automates the mutual certificate exchange and kubeconfig creation required to join clusters:

```bash
# Install cilium CLI
curl -L --remote-name-all https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz
tar -xzf cilium-linux-amd64.tar.gz -C /usr/local/bin

# Connect cluster-us-east and cluster-us-west
# Run from a host with kubectl access to both clusters
cilium clustermesh connect \
  --context cluster-us-east \
  --destination-context cluster-us-west

# Check connection status
cilium clustermesh status --context cluster-us-east
```

Expected output after successful connection:

```
ClusterMesh:                        OK
✅ Cluster Connections:
  - cluster-us-west: OK, 3 nodes connected
  - cluster-eu-west: OK, 5 nodes connected
```

### Manual Certificate Exchange (Air-Gapped Environments)

```bash
# Extract CA certificate from source cluster
kubectl --context cluster-us-east \
  -n kube-system \
  get secret clustermesh-apiserver-remote-cert \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > us-east-ca.crt

# Get the ClusterMesh API server address
EAST_ADDRESS=$(kubectl --context cluster-us-east \
  -n kube-system \
  get svc clustermesh-apiserver \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Create secret in destination cluster
kubectl --context cluster-us-west \
  -n kube-system \
  create secret generic cilium-clustermesh-us-east \
  --from-file=ca.crt=us-east-ca.crt \
  --from-literal=address="${EAST_ADDRESS}:2379"

# Repeat in reverse for bidirectional connectivity
```

## Global Services

ClusterMesh's most powerful feature is global service load balancing. A service annotated as global receives traffic from all connected clusters:

### Defining a Global Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-api
  namespace: production
  annotations:
    # Mark this service as global - it will be included in ClusterMesh
    service.cilium.io/global: "true"
    # Optional: enable shared load balancing across all clusters
    service.cilium.io/shared: "true"
spec:
  selector:
    app: payment-api
  ports:
    - name: http
      port: 8080
      targetPort: 8080
  type: ClusterIP
---
# Deploy on cluster-us-east
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-api
      io.cilium.clustermesh/cluster: cluster-us-east
  template:
    metadata:
      labels:
        app: payment-api
        io.cilium.clustermesh/cluster: cluster-us-east
    spec:
      containers:
        - name: payment-api
          image: registry.example.com/payment-api:2.4.1
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

When `service.cilium.io/shared: "true"` is set, the service's endpoints from all clusters are merged. Traffic is load-balanced across pods in all clusters using eBPF, without any service mesh proxy overhead.

### Service Topology Affinity

For latency-sensitive services, configure affinity to prefer local cluster endpoints:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: user-session-store
  namespace: production
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/shared: "true"
    # Prefer local cluster endpoints; fall back to remote only if local is unavailable
    service.cilium.io/affinity: "local"
spec:
  selector:
    app: session-store
  ports:
    - port: 6379
      targetPort: 6379
```

### Topology-Aware Routing

```yaml
# Configure service topology at the Cilium config level
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Enable topology-aware routing
  enable-service-topology: "true"
  # k8s-require-ipv4-pod-cidr: "true"
```

## Federated Network Policies

ClusterMesh enables network policies that reference pods in remote clusters using their Cilium security identities:

### Cross-Cluster Policy: Allow Specific Service

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-cross-cluster-frontend
  namespace: production
spec:
  description: "Allow frontend pods from cluster-us-west to access API in cluster-us-east"
  endpointSelector:
    matchLabels:
      app: payment-api
  ingress:
    - fromEndpoints:
        - matchLabels:
            # Select pods in the remote cluster using cluster-name label
            io.cilium.k8s.policy.cluster: cluster-us-west
            app: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: POST
                path: "/api/v1/payments"
              - method: GET
                path: "/api/v1/payments/[0-9]+"
```

### Zero-Trust Cross-Cluster Policy

A complete zero-trust policy that denies all cross-cluster traffic by default and permits only explicitly allowed flows:

```yaml
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: default-deny-cross-cluster
spec:
  description: "Default deny all cross-cluster ingress traffic"
  endpointSelector: {}
  ingress:
    - fromEndpoints:
        - matchLabels:
            # Allow traffic from same cluster only
            io.cilium.k8s.policy.cluster: cluster-us-east
    - fromEntities:
        - host
        - remote-node
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-metrics-scraping-cross-cluster
  namespace: monitoring
spec:
  endpointSelector:
    matchLabels:
      app: prometheus
  egress:
    - toEndpoints:
        - matchLabels:
            io.cilium.k8s.policy.cluster: cluster-us-west
            app.kubernetes.io/name: node-exporter
      toPorts:
        - ports:
            - port: "9100"
              protocol: TCP
    - toEndpoints:
        - matchLabels:
            io.cilium.k8s.policy.cluster: cluster-eu-west
            app.kubernetes.io/name: node-exporter
      toPorts:
        - ports:
            - port: "9100"
              protocol: TCP
```

## ClusterMesh with Encryption

All cross-cluster traffic should be encrypted in transit. Cilium supports WireGuard for node-to-node encryption:

```yaml
# Helm values for WireGuard encryption
# Apply to all clusters
ciliumConfig:
  encryption:
    enabled: true
    type: wireguard
    nodeEncryption: true
  # Ensure WireGuard keys are rotated periodically
  wireguard:
    userspaceFallback: false
```

```bash
# Verify WireGuard encryption is active
cilium encrypt status

# Expected output:
# Encryption:      Wireguard
# Node Encryption: Enabled
# Number of peers: 8
```

## Observability

### Hubble for Multi-Cluster Traffic Visibility

Hubble, Cilium's observability platform, provides flow visibility across cluster boundaries:

```bash
# Deploy Hubble UI with relay support for ClusterMesh
helm upgrade cilium cilium/cilium \
  --reuse-values \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.tls.auto.method=helm

# Forward Hubble UI port
kubectl -n kube-system port-forward svc/hubble-ui 12000:80

# Watch cross-cluster flows via CLI
hubble observe \
  --from-label "io.cilium.k8s.policy.cluster=cluster-us-west" \
  --to-label "app=payment-api" \
  --follow
```

### Prometheus Metrics for ClusterMesh

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cilium-clustermesh-alerts
  namespace: monitoring
spec:
  groups:
    - name: clustermesh.availability
      rules:
        - alert: ClusterMeshConnectionDown
          expr: |
            cilium_clustermesh_remote_clusters_total - cilium_clustermesh_remote_clusters_ready_total > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "ClusterMesh cluster connection is down"
            description: "One or more remote clusters are not connected to ClusterMesh. Service discovery and cross-cluster policies are degraded."

        - alert: ClusterMeshAPIServerUnhealthy
          expr: |
            cilium_clustermesh_apiserver_ready_total < 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "ClusterMesh API server is not ready"
            description: "The ClusterMesh API server is not accepting connections. Cross-cluster service discovery will fail."

        - alert: ClusterMeshEndpointSyncLag
          expr: |
            cilium_clustermesh_endpoints_total - cilium_clustermesh_endpoints_synced_total > 100
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "ClusterMesh endpoint sync lag is high"
            description: "There are {{ $value }} endpoints that have not been synchronized across clusters."
```

## Troubleshooting

### Diagnosing Connection Issues

```bash
# Check ClusterMesh status from all clusters
for cluster in cluster-us-east cluster-us-west cluster-eu-west; do
  echo "=== ${cluster} ==="
  kubectl --context "${cluster}" \
    -n kube-system exec -it \
    $(kubectl --context "${cluster}" -n kube-system get pod -l k8s-app=cilium \
      -o jsonpath='{.items[0].metadata.name}') \
    -- cilium-dbg status --verbose | grep -A 20 "ClusterMesh"
done

# Check etcd connectivity from Cilium agent
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l k8s-app=cilium -o jsonpath='{.items[0].metadata.name}') \
  -- cilium-dbg debuginfo | grep -A 10 "clustermesh"

# Verify global service endpoints are propagated
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l k8s-app=cilium -o jsonpath='{.items[0].metadata.name}') \
  -- cilium-dbg service list | grep payment-api
```

### Resolving Certificate Issues

```bash
# Check certificate expiry for ClusterMesh components
kubectl -n kube-system get secret clustermesh-apiserver-ca-cert -o yaml | \
  grep 'ca.crt' | awk '{print $2}' | base64 -d | \
  openssl x509 -noout -enddate

# Rotate ClusterMesh certificates
cilium clustermesh disconnect --context cluster-us-east --destination-context cluster-us-west
# Update certificates
cilium clustermesh connect --context cluster-us-east --destination-context cluster-us-west
```

### Debugging Service Discovery

```bash
# Check if a global service is visible in remote cluster
kubectl --context cluster-us-west \
  -n kube-system exec -it \
  $(kubectl --context cluster-us-west -n kube-system get pod -l k8s-app=cilium \
    -o jsonpath='{.items[0].metadata.name}') \
  -- cilium-dbg service list | grep payment-api

# Check endpoint distribution
kubectl --context cluster-us-west \
  -n kube-system exec -it \
  $(kubectl --context cluster-us-west -n kube-system get pod -l k8s-app=cilium \
    -o jsonpath='{.items[0].metadata.name}') \
  -- cilium-dbg endpoint list | grep payment-api
```

## Upgrade Procedures

ClusterMesh upgrades require careful sequencing to maintain connectivity:

```bash
# Upgrade procedure for a 3-cluster mesh
# Always upgrade one cluster at a time

# Step 1: Verify current status
cilium clustermesh status --context cluster-us-east

# Step 2: Upgrade cluster-us-east
helm upgrade cilium cilium/cilium \
  --context cluster-us-east \
  --namespace kube-system \
  --reuse-values \
  --version 1.17.0

# Step 3: Wait for rollout
kubectl --context cluster-us-east \
  -n kube-system rollout status daemonset/cilium --timeout=600s

# Step 4: Verify cross-cluster connectivity
cilium connectivity test --context cluster-us-east \
  --multi-cluster cluster-us-west

# Step 5: Proceed with next cluster
```

## Summary

Cilium ClusterMesh provides enterprise-grade multi-cluster networking without the complexity of a centralized service mesh control plane. Its eBPF-based data plane delivers:

- Sub-millisecond cross-cluster service discovery via global services
- Identity-based network policies that span cluster boundaries
- Encrypted node-to-node communication via WireGuard
- Rich observability through Hubble flow capture and Prometheus metrics

The topology affinity feature enables latency-optimized request routing that prefers local cluster endpoints while automatically failing over to remote clusters when local capacity is unavailable, making ClusterMesh an effective foundation for active-active multi-region Kubernetes deployments.
