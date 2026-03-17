---
title: "Kubernetes Cilium Cluster Mesh: Cross-Cluster Networking and Service Discovery"
date: 2029-10-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "Networking", "Service Mesh", "eBPF", "Multi-Cluster"]
categories:
- Kubernetes
- Networking
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Cilium Cluster Mesh covering architecture, ClusterMesh API, global services, cross-cluster network policy enforcement, and load balancing across Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-cilium-cluster-mesh-cross-cluster-networking-guide/"
---

Running multiple Kubernetes clusters is the operational reality for any organization pursuing high availability, geographic distribution, or regulatory isolation. The challenge is making those clusters feel like one cohesive network: services need to discover endpoints in remote clusters, network policies need to span cluster boundaries, and load balancers need to distribute traffic globally. Cilium Cluster Mesh provides this capability through eBPF-based networking that extends Cilium's dataplane across cluster boundaries without a service mesh sidecar per pod.

<!--more-->

# Kubernetes Cilium Cluster Mesh: Cross-Cluster Networking and Service Discovery

## Architecture Overview

Cilium Cluster Mesh works by having each cluster expose its etcd key-value store (or Cilium's internal KVStore) through a dedicated API server endpoint. Other clusters subscribe to this endpoint and synchronize Cilium's internal representations of services, endpoints, and identities. The result is a shared view of the distributed system that the eBPF dataplane can act on directly.

```
Cluster A (us-east-1)          Cluster B (us-west-2)
┌─────────────────────┐        ┌─────────────────────┐
│  cilium-agent       │        │  cilium-agent       │
│  ┌───────────────┐  │        │  ┌───────────────┐  │
│  │ KVStore       │◄─┼────────┼─►│ KVStore       │  │
│  │ (etcd/CRD)    │  │  mTLS  │  │ (etcd/CRD)    │  │
│  └───────────────┘  │        │  └───────────────┘  │
│  eBPF Maps          │        │  eBPF Maps          │
│  ┌─────────────┐    │        │    ┌─────────────┐  │
│  │ Service Map  │    │        │    │ Service Map  │  │
│  │ (local+remote│    │        │    │ (local+remote│  │
│  │  endpoints)  │    │        │    │  endpoints)  │  │
│  └─────────────┘    │        │    └─────────────┘  │
└─────────────────────┘        └─────────────────────┘
         │                                │
         └──────── ClusterMesh API ────────┘
                   (HTTPS + client certs)
```

Key design properties:
- No sidecar proxies — eBPF handles cross-cluster forwarding at the kernel level
- mTLS between ClusterMesh API servers for control plane security
- Node-to-node tunneling (Geneve/VXLAN) or direct routing for data plane
- Identity-based policy that spans cluster boundaries using numeric security identities

## Section 1: Prerequisites and Cluster Configuration

### Cluster Requirements

Before enabling Cluster Mesh:
- Cilium must be the CNI on all participating clusters (version 1.13+)
- Clusters must have non-overlapping pod CIDR ranges
- Each cluster must have a unique name (`clusterName`) and unique ID (`clusterID`, 1-255)
- The ClusterMesh API server must be reachable from all participating cluster nodes

### Assigning Cluster Names and IDs

```bash
# When installing Cilium with Helm on cluster A
helm install cilium cilium/cilium \
  --namespace kube-system \
  --set cluster.name=cluster-a \
  --set cluster.id=1 \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.replicas=2 \
  --set clustermesh.apiserver.service.type=LoadBalancer \
  --set clustermesh.apiserver.tls.auto.method=helm

# Cluster B
helm install cilium cilium/cilium \
  --namespace kube-system \
  --set cluster.name=cluster-b \
  --set cluster.id=2 \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.replicas=2 \
  --set clustermesh.apiserver.service.type=LoadBalancer \
  --set clustermesh.apiserver.tls.auto.method=helm
```

For existing Cilium installations, upgrade the Helm release:

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set cluster.name=cluster-a \
  --set cluster.id=1 \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.service.type=LoadBalancer
```

### Verify the ClusterMesh API Server

```bash
# Check the ClusterMesh API server is running
kubectl get pods -n kube-system -l app.kubernetes.io/name=clustermesh-apiserver

# Get the external IP
kubectl get svc -n kube-system clustermesh-apiserver
# NAME                    TYPE           CLUSTER-IP    EXTERNAL-IP     PORT(S)
# clustermesh-apiserver   LoadBalancer   10.96.0.100   203.0.113.10    2379:32100/TCP

# Verify TLS certificates were generated
kubectl get secret -n kube-system clustermesh-apiserver-remote-cert
```

## Section 2: Connecting Clusters with cilium CLI

### Install cilium CLI

```bash
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --fail --remote-name-all \
  https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz
tar xzvf cilium-linux-amd64.tar.gz
sudo mv cilium /usr/local/bin/
```

### Establishing Cluster Mesh Peering

```bash
# Switch to cluster A's kubeconfig
export KUBECONFIG=~/.kube/cluster-a.yaml

# Enable cluster mesh and connect to cluster B
cilium clustermesh connect \
  --destination-context cluster-b \
  --destination-endpoint "203.0.113.20:2379"

# Alternatively, if using kubeconfig contexts:
cilium clustermesh connect \
  --context cluster-a \
  --destination-context cluster-b

# Check status
cilium clustermesh status --context cluster-a
```

Expected output:

```
Cluster Mesh:  OK

Name: cluster-a
ID:   1
Services & Endpoints:
  Total: 47 services, 134 endpoints

Remote Clusters (1):
  cluster-b:
    URL:    https://203.0.113.20:2379
    Status: OK
    Services:       23
    Endpoints:      67
    Identities:     89
    Nodes:          3
    Last Updated:   2029-10-08 09:14:27 UTC
```

### Troubleshooting Connectivity

```bash
# Debug cluster mesh connectivity
cilium clustermesh status --verbose

# Check cilium-agent logs for mesh connectivity
kubectl logs -n kube-system -l k8s-app=cilium | grep -i "cluster-mesh\|remote cluster"

# Test connectivity between clusters
cilium connectivity test --multi-cluster \
  --context cluster-a \
  --multi-cluster-target-context cluster-b

# Inspect the etcd state from cluster A's perspective
kubectl exec -n kube-system ds/cilium -- cilium debuginfo | grep -A 20 "ClusterMesh"
```

## Section 3: Global Services

A global service is a Kubernetes Service that spans multiple clusters. Pods in any cluster can reach it, and the eBPF load balancer distributes traffic across all endpoints regardless of cluster location.

### Annotating Services as Global

```yaml
# global-service.yaml — deploy identically in both clusters
apiVersion: v1
kind: Service
metadata:
  name: product-catalog
  namespace: ecommerce
  annotations:
    # Mark this service as global (visible across all clusters)
    service.cilium.io/global: "true"
    # Optional: share load across all clusters (default behavior)
    service.cilium.io/shared: "true"
spec:
  selector:
    app: product-catalog
  ports:
    - name: http
      port: 80
      targetPort: 8080
  type: ClusterIP
```

Apply this manifest in both clusters. Each cluster's cilium-agent will synchronize the service endpoints and include them in the eBPF service map.

### Affinity-Based Load Balancing

By default, Cluster Mesh distributes requests across all clusters equally. For latency-sensitive services, prefer local cluster endpoints:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: product-catalog
  namespace: ecommerce
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/shared: "true"
    # Prefer local endpoints; only spill to remote if none are available
    service.cilium.io/affinity: "local"
spec:
  selector:
    app: product-catalog
  ports:
    - port: 80
      targetPort: 8080
```

Valid values for `service.cilium.io/affinity`:
- `none` (default) — round-robin across all clusters
- `local` — prefer same-cluster endpoints, fallback to remote
- `remote` — prefer remote cluster endpoints (useful for active-passive setups)

### ExternalWorkload Services

For workloads outside the cluster (VMs, bare metal), Cilium supports ExternalWorkload resources:

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumExternalWorkload
metadata:
  name: legacy-api-server
  namespace: platform
spec:
  ipv4AllocCIDR: "10.200.1.0/30"
```

After registering the external workload, it participates in global service selection like any pod endpoint.

## Section 4: Cross-Cluster Network Policy

One of Cluster Mesh's most powerful features is the ability to write CiliumNetworkPolicy that references identities from remote clusters.

### Cilium Identity Labels Across Clusters

Each workload in Cilium has a numeric identity derived from its labels. When Cluster Mesh is enabled, identities are synchronized across clusters with a cluster prefix. This allows policies to reference remote cluster identities directly.

```yaml
# Allow traffic from cluster-b's payment-service to cluster-a's accounts-service
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-remote-payment-service
  namespace: finance
spec:
  endpointSelector:
    matchLabels:
      app: accounts-service
  ingress:
    - fromEndpoints:
        - matchLabels:
            # Standard k8s labels
            app: payment-service
            # Cilium adds this label to identify the source cluster
            io.cilium.k8s.policy.cluster: cluster-b
      toPorts:
        - ports:
            - port: "8443"
              protocol: TCP
```

### Cluster-Aware Egress Policy

```yaml
# Allow cluster-a's frontend to reach cluster-b's recommendation engine only
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: frontend-egress-to-remote
  namespace: web
spec:
  endpointSelector:
    matchLabels:
      app: frontend
  egress:
    - toEndpoints:
        - matchLabels:
            app: recommendation-engine
            io.cilium.k8s.policy.cluster: cluster-b
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
    # Also allow local DNS
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
```

### Default-Deny Policy for Remote Traffic

For high-security environments, implement default-deny for cross-cluster traffic and explicitly allow only necessary flows:

```yaml
# default-deny-remote-ingress.yaml
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: default-deny-cross-cluster-ingress
spec:
  endpointSelector: {}
  ingress:
    - fromEndpoints:
        - matchLabels:
            # Allow from same cluster only by default
            io.cilium.k8s.policy.cluster: cluster-a
```

### Verifying Policy Enforcement

```bash
# Check policy verdicts in real time
kubectl exec -n kube-system ds/cilium -- cilium monitor --type policy-verdict

# Show current policy for a specific endpoint
POD=$(kubectl get pod -n finance -l app=accounts-service -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n kube-system ds/cilium -- cilium endpoint list | grep "$POD"
# Get the endpoint ID, then:
kubectl exec -n kube-system ds/cilium -- cilium endpoint get <EP_ID>

# Test connectivity between clusters
kubectl exec -n web deploy/frontend -- curl -sv http://recommendation-engine.cluster-b:9090/
```

## Section 5: Load Balancing Across Clusters

### Global Load Balancing Architecture

With Cluster Mesh, every cluster's eBPF service map knows about endpoints in all connected clusters. The per-node eBPF program handles the forwarding decision — no external load balancer is required for east-west traffic.

```
Client Pod (cluster-a)
    │
    ▼ kube-proxy replacement (eBPF)
    │  DNAT to backend selection
    │
    ├── 60% → local endpoints (cluster-a)
    │         Pod A1 (10.1.0.5)
    │         Pod A2 (10.1.0.6)
    │
    └── 40% → remote endpoints (cluster-b)
              Pod B1 (10.2.0.5) via tunnel
              Pod B2 (10.2.0.6) via tunnel
```

### Weight-Based Distribution

Use the `service.cilium.io/topology-aware-hints` or endpoint weight annotations to control distribution:

```yaml
# In cluster-a: weight this cluster's endpoints more heavily
apiVersion: v1
kind: Endpoints
metadata:
  name: product-catalog
  namespace: ecommerce
  annotations:
    # This annotation gives local endpoints 3x the weight of remote
    service.cilium.io/weight: "3"
subsets:
  - addresses:
      - ip: 10.1.0.5
      - ip: 10.1.0.6
    ports:
      - port: 8080
```

### Health-Aware Load Balancing

Cilium automatically removes endpoints from the eBPF map when their pods fail readiness checks. For cross-cluster traffic, this means that if cluster-b's pods become unhealthy, all traffic automatically routes to cluster-a's healthy endpoints.

```bash
# Observe endpoint health changes
kubectl exec -n kube-system ds/cilium -- cilium monitor --type drop 2>&1 | \
  grep -E "health|endpoint"

# Verify service backends
kubectl exec -n kube-system ds/cilium -- cilium service list | grep product-catalog
# ID   Frontend              Service Type   Backend
# 45   10.96.50.100:80/TCP   ClusterIP      10.1.0.5:8080 (active)
#                                           10.1.0.6:8080 (active)
#                                           10.2.0.5:8080 (active) [remote]
#                                           10.2.0.6:8080 (active) [remote]
```

### Mutual TLS Between Clusters

By default, pod-to-pod traffic between clusters traverses a tunnel (Geneve or VXLAN). For sensitive data, enable transparent mTLS via Cilium's mutual authentication:

```yaml
# cilium-values.yaml
encryption:
  enabled: true
  type: wireguard
  nodeEncryption: true

# For in-cluster mTLS with SPIFFE/SPIRE
authentication:
  mutual:
    spire:
      enabled: true
      install:
        enabled: true
```

## Section 6: Observability and Metrics

### Hubble Cross-Cluster Flows

Hubble is Cilium's observability layer. It can be configured to aggregate flows from all clusters in a mesh:

```bash
# Install Hubble relay (federation mode)
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true

# Port-forward Hubble UI
kubectl port-forward -n kube-system svc/hubble-ui 12000:80

# CLI: observe all flows including cross-cluster
hubble observe --context cluster-a \
  --namespace ecommerce \
  --follow \
  --output json | jq '
    select(.flow.is_reply == false) |
    {
      from: .flow.source.pod_name,
      to: .flow.destination.pod_name,
      verdict: .flow.verdict,
      cluster: .flow.destination.cluster_name
    }
  '
```

### Key Prometheus Metrics

```promql
# Cross-cluster service endpoint count
cilium_services_events_total{action="add",source_cluster!=""}

# Policy verdict drops (cross-cluster denied traffic)
sum(rate(cilium_drop_count_total[5m])) by (reason, direction)

# Remote endpoint health
cilium_remote_cluster_last_failure_ts

# Cluster mesh sync latency
cilium_clustermesh_sync_duration_seconds
```

### Grafana Dashboard for Cluster Mesh

```yaml
# configmap for a basic Cluster Mesh dashboard
# (abbreviated — key panels)
panels:
  - title: "Remote Cluster Endpoint Count"
    expr: "cilium_remote_cluster_endpoints"
    by: [cluster_name]

  - title: "Cross-Cluster Policy Drops"
    expr: "rate(cilium_drop_count_total{reason=\"Policy denied\"}[5m])"

  - title: "Cluster Mesh API Server Latency"
    expr: "histogram_quantile(0.99, rate(cilium_clustermesh_kvstore_duration_seconds_bucket[5m]))"
```

## Section 7: Operational Procedures

### Adding a Third Cluster

```bash
# Connect new cluster-c to both existing clusters
cilium clustermesh connect \
  --context cluster-a \
  --destination-context cluster-c

cilium clustermesh connect \
  --context cluster-b \
  --destination-context cluster-c

# Verify all three clusters see each other
cilium clustermesh status --context cluster-a
cilium clustermesh status --context cluster-b
cilium clustermesh status --context cluster-c
```

### Graceful Cluster Removal

```bash
# Step 1: Remove global service annotations to stop routing traffic to cluster-b
kubectl annotate service product-catalog \
  -n ecommerce \
  service.cilium.io/global-
# (Remove the annotation by appending '-' to the key)

# Step 2: Wait for traffic to drain from cluster-b endpoints
sleep 60

# Step 3: Disconnect the cluster peer
cilium clustermesh disconnect \
  --context cluster-a \
  --destination-context cluster-b
```

### Certificate Rotation

```bash
# Rotate ClusterMesh API server certificates
cilium clustermesh enable --context cluster-a --create-ca

# Re-connect affected clusters
cilium clustermesh connect \
  --context cluster-a \
  --destination-context cluster-b
```

## Section 8: Common Issues and Solutions

### Issue: Remote Endpoints Not Appearing

```bash
# Check KVStore connectivity
kubectl exec -n kube-system ds/cilium -- cilium kvstore get \
  cilium/state/nodes/v1/

# Verify ClusterMesh API server TLS certificates are valid
kubectl exec -n kube-system deploy/clustermesh-apiserver -- \
  openssl s_client -connect localhost:2379 </dev/null 2>&1 | grep -E "subject|issuer|expire"

# Check remote cluster status detail
kubectl exec -n kube-system ds/cilium -- cilium remote-node-identity list
```

### Issue: Cross-Cluster Policy Not Enforced

```bash
# Verify that cluster name labels are being applied
kubectl exec -n kube-system ds/cilium -- cilium endpoint list --output json | \
  jq '.[].status.labels | select(."io.cilium.k8s.policy.cluster" != null)'

# Test policy with direct endpoint match
kubectl exec -n kube-system ds/cilium -- cilium policy get
```

### Issue: Tunnel Traffic Not Reaching Remote Nodes

```bash
# Check node-to-node tunnel status
kubectl exec -n kube-system ds/cilium -- cilium tunnel list

# Verify Geneve port (6081) is open between clusters
nmap -sU -p 6081 <remote-cluster-node-ip>

# Examine BPF tunnel map
kubectl exec -n kube-system ds/cilium -- cilium bpf tunnel list
```

## Conclusion

Cilium Cluster Mesh provides a robust, eBPF-native approach to multi-cluster Kubernetes networking. By extending Cilium's identity-based security model and eBPF dataplane across cluster boundaries, it achieves cross-cluster service discovery, load balancing, and network policy enforcement without sidecar overhead. The combination of global services with affinity policies, cluster-aware network policies, and Hubble observability makes it production-grade for organizations operating geographically distributed Kubernetes fleets.
