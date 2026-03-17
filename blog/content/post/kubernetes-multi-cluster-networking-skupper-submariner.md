---
title: "Kubernetes Multi-Cluster Networking: Skupper, Submariner, and Cross-Cluster Service Discovery"
date: 2030-04-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Cluster", "Skupper", "Submariner", "Networking", "Service Mesh"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to multi-cluster Kubernetes networking covering Skupper for L7 application-level connectivity, Submariner for L3 network extension, CoreDNS stub zone configuration for cross-cluster service discovery, and cross-cluster traffic encryption patterns."
more_link: "yes"
url: "/kubernetes-multi-cluster-networking-skupper-submariner/"
---

Running workloads across multiple Kubernetes clusters creates a fundamental challenge: the pod network CIDR and service CIDR of each cluster are private, non-routable namespaces that cannot communicate with each other by default. Solving this requires either extending the network layer between clusters (L3 approach) or building application-level connectivity that proxies traffic across cluster boundaries (L7 approach).

The choice between these approaches has significant implications for security, operational complexity, and the types of workloads you can interconnect.

<!--more-->

# Kubernetes Multi-Cluster Networking: Skupper, Submariner, and Cross-Cluster Service Discovery

## Topology and Use Case Matrix

Before choosing a technology, identify which connectivity model your workloads require.

| Requirement | Skupper (L7) | Submariner (L3) |
|---|---|---|
| Connect services by DNS name | Yes | Yes |
| Pods communicate using pod IPs directly | No | Yes |
| Databases requiring direct TCP connections | Limited | Yes |
| HTTP/gRPC microservice connectivity | Excellent | Yes |
| Overlapping pod CIDRs across clusters | Works (proxy model) | Requires non-overlapping CIDRs |
| Encryption in transit | TLS by default | Libreswan IPSec / WireGuard |
| Network policy enforcement | Via Skupper policies | Cluster-level network policies |
| Multi-cloud without VPN | Yes | Requires reachable endpoints |
| Complexity | Low | Medium |

## Skupper: L7 Application-Level Connectivity

Skupper creates a virtual application network that operates at Layer 7. It deploys a router process in each participating namespace and establishes encrypted TLS tunnels between them. Services are "exposed" into the virtual network and become accessible in all linked namespaces.

### Installing Skupper

```bash
# Install Skupper CLI
curl https://skupper.io/install.sh | sh

# Verify installation
skupper version
# skupper version 1.7.0

# Alternative: install via krew
kubectl krew install skupper
```

### Initializing Skupper in Each Cluster

```bash
# Context 1: production cluster
kubectl config use-context prod-cluster
kubectl create namespace cross-cluster-apps

skupper init \
  --namespace cross-cluster-apps \
  --site-name prod-site \
  --enable-console \
  --enable-flow-collector \
  --console-auth openshift  # or 'internal' for standalone k8s

# Verify Skupper components are running
kubectl get pods -n cross-cluster-apps
# skupper-router-xxxxx           1/1     Running
# skupper-service-controller-xx  1/1     Running
# skupper-flow-collector-xxx     1/1     Running

# Context 2: staging cluster
kubectl config use-context staging-cluster
kubectl create namespace cross-cluster-apps

skupper init \
  --namespace cross-cluster-apps \
  --site-name staging-site \
  --enable-console
```

### Linking Clusters

```bash
# On the prod cluster: generate a link token
kubectl config use-context prod-cluster

skupper token create /tmp/prod-link-token.yaml \
  --namespace cross-cluster-apps \
  --name staging-to-prod-link

# Copy token to staging cluster and create link
kubectl config use-context staging-cluster

skupper link create /tmp/prod-link-token.yaml \
  --namespace cross-cluster-apps \
  --name prod-link

# Verify link is established
skupper link status -n cross-cluster-apps
# Link prod-link is active (connected to prod-site)
```

### Exposing Services Across Clusters

```bash
# On prod cluster: expose a database service
kubectl config use-context prod-cluster

# Expose the PostgreSQL service running in prod
skupper expose service postgresql \
  --namespace cross-cluster-apps \
  --port 5432 \
  --protocol tcp

# On staging cluster: the service is now available
kubectl config use-context staging-cluster

skupper service status -n cross-cluster-apps
# NAME         PROTOCOL    PORT
# postgresql   tcp         5432

# Verify it's accessible as a Kubernetes service
kubectl get service postgresql -n cross-cluster-apps
# NAME         TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
# postgresql   ClusterIP   10.100.45.23    <none>        5432/TCP   2m
```

### Skupper with Helm-Deployed Applications

```yaml
# skupper-site-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: skupper-site
  namespace: cross-cluster-apps
  labels:
    "app.kubernetes.io/part-of": skupper
data:
  name: "prod-site"
  console: "true"
  flow-collector: "true"
  router-mode: "interior"
  router-cpu: "1"
  router-memory: "256Mi"
  router-cpu-limit: "2"
  router-memory-limit: "1Gi"
  router-logging: "info"
```

```yaml
# skupper-token-secret.yaml (store securely, rotate regularly)
apiVersion: v1
kind: Secret
metadata:
  name: skupper-site-server
  namespace: cross-cluster-apps
  labels:
    skupper.io/type: connection-token-request
data:
  # Certificate is managed by Skupper — placeholder shown
  ca.crt: <base64-encoded-ca-cert>
```

### Service Mirroring Pattern

For high-availability across clusters where you want the same logical service to have replicas in both clusters:

```bash
# Deploy the service in both clusters
kubectl config use-context prod-cluster
kubectl apply -f product-catalog-deployment.yaml -n cross-cluster-apps

kubectl config use-context dr-cluster
kubectl apply -f product-catalog-deployment.yaml -n cross-cluster-apps

# Expose from both sides — Skupper balances across all endpoints
kubectl config use-context prod-cluster
skupper expose deployment product-catalog --port 8080 -n cross-cluster-apps

kubectl config use-context dr-cluster
skupper expose deployment product-catalog --port 8080 -n cross-cluster-apps

# Verify load distribution
skupper service status product-catalog -n cross-cluster-apps
```

## Submariner: L3 Network Extension

Submariner extends the Kubernetes network at Layer 3 using either IPsec (Libreswan) or WireGuard tunnels between clusters. This makes pod IPs and service IPs from remote clusters directly routable.

### Prerequisites

```
Cluster 1 (prod):     Pod CIDR: 10.0.0.0/14    Service CIDR: 100.64.0.0/13
Cluster 2 (staging):  Pod CIDR: 10.4.0.0/14    Service CIDR: 100.72.0.0/13
```

Pod and service CIDRs must not overlap between clusters.

### Installing the Broker

The Submariner Broker is a Kubernetes API server that manages cluster metadata. It must be deployed in a cluster accessible by all participant clusters (or in a dedicated management cluster).

```bash
# Install subctl CLI
curl -Ls https://get.submariner.io | bash
export PATH=$PATH:~/.local/bin
subctl version

# Deploy the broker in the management cluster
kubectl config use-context management-cluster

subctl deploy-broker \
  --kubecontext management-cluster \
  --globalnet=false  # Set true if clusters have overlapping CIDRs (uses NAT)

# This creates broker-info.subm file
ls broker-info.subm
```

### Joining Clusters to the Broker

```bash
# Join the prod cluster
subctl join broker-info.subm \
  --kubecontext prod-cluster \
  --clusterid prod \
  --natt-discovery-port 4491 \
  --cable-driver wireguard \  # or 'libreswan' for IPsec
  --health-check-enabled

# Join the staging cluster
subctl join broker-info.subm \
  --kubecontext staging-cluster \
  --clusterid staging \
  --natt-discovery-port 4491 \
  --cable-driver wireguard \
  --health-check-enabled

# Verify cluster connection
subctl show connections --kubecontext prod-cluster
# CLUSTER ID   ENDPOINT IP       CABLE DRIVER  SUBNETS                    STATUS
# staging      203.0.113.45      wireguard     10.4.0.0/14,100.72.0.0/13  connected
```

### ServiceExport and ServiceImport

Submariner uses the `ServiceExport` and `ServiceImport` CRDs (from the Multi-Cluster Services API spec) to make services discoverable across clusters.

```yaml
# On prod cluster: export the PostgreSQL service
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: postgresql
  namespace: databases
```

```bash
kubectl apply -f service-export.yaml --context prod-cluster

# Verify it was exported
kubectl get serviceexport postgresql -n databases --context prod-cluster
# NAME         AGE
# postgresql   30s

# On staging cluster: the service is now importable
kubectl get serviceimport postgresql -n databases --context staging-cluster
# NAME         TYPE           IP                    AGE
# postgresql   ClusterSetIP   100.0.252.1           30s
```

### DNS-Based Cross-Cluster Discovery with Submariner

Submariner's Lighthouse plugin configures CoreDNS to resolve cross-cluster service names using the format `<service>.<namespace>.svc.clusterset.local`:

```bash
# Test cross-cluster DNS resolution from staging
kubectl exec -n staging-apps -it debug-pod --context staging-cluster -- \
  nslookup postgresql.databases.svc.clusterset.local

# Server:    100.72.0.10
# Address 1: 100.72.0.10 kube-dns.kube-system.svc.cluster.local
# Name:      postgresql.databases.svc.clusterset.local
# Address 1: 100.0.252.1

# Direct connection using pod IP (L3 routing via Submariner tunnels)
kubectl exec -n staging-apps -it debug-pod --context staging-cluster -- \
  psql -h postgresql.databases.svc.clusterset.local -U app -d appdb -c "SELECT 1;"
```

## CoreDNS Stub Zone Configuration

Both Skupper and Submariner benefit from explicit CoreDNS configuration for cross-cluster DNS. Stub zones allow a cluster's CoreDNS to forward specific domain queries to a different DNS server.

### Stub Zone for Cross-Cluster Service Resolution

```yaml
# CoreDNS ConfigMap modification
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
        # Stub zone: forward *.clusterset.local to Lighthouse DNS
        clusterset.local:53 {
            forward . 100.72.0.253:53 {
                force_tcp
            }
            errors
            reload
        }
        # Stub zone: forward *.prod.svc.cluster.local to prod cluster DNS
        prod.svc.cluster.local:53 {
            forward . 10.0.0.10:53 {
                force_tcp
                max_fails 3
            }
            errors
            reload
            health_check 30s
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

```bash
# Apply CoreDNS configuration update
kubectl apply -f coredns-configmap.yaml -n kube-system

# Reload CoreDNS (it watches the configmap automatically)
kubectl rollout restart deployment/coredns -n kube-system

# Verify stub zone is working
kubectl run dns-test --image=busybox:1.36 --restart=Never -- \
  nslookup postgresql.databases.prod.svc.cluster.local

kubectl logs dns-test
kubectl delete pod dns-test
```

### Split-Horizon DNS for Multiple Clusters

When services exist in multiple clusters with the same name, split-horizon DNS routes queries to the local cluster preferentially:

```
.:53 {
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    # Local cluster takes priority via kubernetes plugin
    # Remote clusters use stub zones with explicit domain
    remote-cluster.svc.cluster.local:53 {
        forward . <remote-coredns-ip>:53 {
            prefer_udp
        }
        cache 10  # Short TTL for cross-cluster (network partitions)
    }
    forward . /etc/resolv.conf
    cache 30
}
```

## Cross-Cluster Traffic Encryption

### Submariner WireGuard Configuration

```bash
# Verify WireGuard tunnel status
subctl diagnose firewall inter-cluster \
  --kubeconfig /path/to/prod-kubeconfig \
  --remoteconfig /path/to/staging-kubeconfig

# Check WireGuard interface on gateway node
kubectl exec -n submariner-operator \
  $(kubectl get pods -n submariner-operator -l app=submariner-gateway -o name | head -1) \
  -- wg show

# Expected output:
# interface: submariner
#   public key: <key>
#   listening port: 4500
# peer: <staging-gateway-key>
#   endpoint: 203.0.113.45:4500
#   allowed ips: 10.4.0.0/14, 100.72.0.0/13
#   latest handshake: 5 seconds ago
#   transfer: 1.23 GiB received, 2.45 GiB sent
```

### Skupper TLS Verification

```bash
# Verify Skupper router certificate chain
kubectl exec -n cross-cluster-apps \
  $(kubectl get pods -n cross-cluster-apps -l app=skupper-router -o name) \
  -- openssl s_client -connect staging-site:55671 -CAfile /etc/skupper-router-certs/ca.crt

# Check certificate expiration
kubectl get secret skupper-tls-site -n cross-cluster-apps \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -noout -dates
```

### mTLS for Cross-Cluster Application Traffic

For workloads that require application-layer mTLS regardless of the underlying transport:

```yaml
# Istio ServiceEntry for cross-cluster service (when using Istio in both clusters)
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: remote-postgresql
  namespace: databases
spec:
  hosts:
  - postgresql.databases.svc.clusterset.local
  ports:
  - number: 5432
    name: tcp-postgresql
    protocol: TCP
  location: MESH_EXTERNAL
  resolution: DNS
  endpoints:
  - address: postgresql.databases.svc.clusterset.local
    ports:
      tcp-postgresql: 5432
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: remote-postgresql-tls
  namespace: databases
spec:
  host: postgresql.databases.svc.clusterset.local
  trafficPolicy:
    tls:
      mode: ISTIO_MUTUAL
```

## Production Deployment Pattern: Active-Active

### Database Primary in One Cluster, Read Replicas in Another

```bash
# Prod cluster: PostgreSQL primary
kubectl apply -f postgres-primary.yaml --context prod-cluster

# Export the primary service
kubectl apply -f - --context prod-cluster << 'EOF'
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: postgres-primary
  namespace: databases
EOF

# DR cluster: PostgreSQL read replicas connecting to prod primary
# The replicas use the cross-cluster DNS name for primary connection
kubectl apply -f postgres-replica.yaml --context dr-cluster
# postgres-replica.yaml configures PGHOST=postgres-primary.databases.svc.clusterset.local
```

### Health Checking and Failover

```yaml
# Submariner health check configuration
apiVersion: submariner.io/v1
kind: Endpoint
metadata:
  name: prod-gateway
  namespace: submariner-operator
spec:
  cluster_id: prod
  cable_name: wireguard:prod-gateway
  healthCheckEnabled: true
  healthCheckInterval: 10  # seconds
  healthCheckMaxPacketLossCount: 5
  hostname: prod-gateway-node
```

```bash
# Monitor cross-cluster connection health
subctl show connections --kubecontext prod-cluster

# Watch for connection events
kubectl get events -n submariner-operator --watch \
  --field-selector reason=ConnectionError \
  --context prod-cluster
```

## Observability for Multi-Cluster Traffic

### Skupper Traffic Metrics

```bash
# Access Skupper console
kubectl port-forward svc/skupper -n cross-cluster-apps 8080:8080

# Skupper exposes Prometheus metrics
curl http://localhost:9090/metrics | grep skupper_

# Example metrics:
# skupper_messages_received_total{site="prod-site",service="postgresql"} 12345
# skupper_bytes_sent_total{site="prod-site",link="staging-link"} 987654321
```

### Submariner Connection Metrics

```bash
# Submariner route agent metrics
kubectl port-forward -n submariner-operator svc/submariner-metrics 8080:8080

curl http://localhost:8080/metrics | grep submariner_

# Key metrics:
# submariner_gateway_connections_established_total
# submariner_gateway_connections_dropped_total
# submariner_gateway_rx_bytes_total
# submariner_gateway_tx_bytes_total
```

## Key Takeaways

- Skupper operates at L7 using proxy-based connectivity — it works across overlapping CIDRs and is ideal for HTTP/gRPC microservice interconnects, but cannot support workloads that require direct pod-to-pod IP routing.
- Submariner extends L3 networking using WireGuard or IPsec tunnels — pod IPs and service IPs become directly routable across clusters, but clusters must have non-overlapping pod and service CIDRs (or use GlobalNet for NAT).
- CoreDNS stub zones enable transparent cross-cluster service resolution without application changes; use `clusterset.local` as the multi-cluster domain for Submariner with the Lighthouse plugin.
- Cross-cluster tokens in Skupper are short-lived credentials — implement rotation procedures and monitor certificate expiration to prevent link failures.
- For production active-active topologies, combine Submariner for L3 routing with Istio ServiceEntries for mTLS enforcement at the application layer.
- Submariner GlobalNet provides NAT-based connectivity when cluster CIDRs overlap, at the cost of complexity and some performance overhead from the additional NAT layer.
