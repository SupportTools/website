---
title: "Kubernetes Multi-Cluster Service Discovery: MCS API and Submariner"
date: 2028-11-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Cluster", "Service Discovery", "Networking", "Federation"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes multi-cluster service discovery using the Multi-Cluster Services API (ServiceExport/ServiceImport) and Submariner for cross-cluster networking, with DNS configuration and failover patterns."
more_link: "yes"
url: "/kubernetes-multi-cluster-service-discovery-guide/"
---

Running Kubernetes workloads across multiple clusters is standard practice for high availability and geographic distribution. The challenge is service discovery: how does a pod in cluster-west find and connect to a service in cluster-east? DNS works within a cluster, but cross-cluster service discovery requires additional infrastructure.

The Multi-Cluster Services (MCS) API provides a standard Kubernetes-native interface for exporting services across clusters. Combined with Submariner for the networking layer, it delivers DNS-based cross-cluster service discovery with failover. This guide covers the complete architecture and production deployment.

<!--more-->

# Kubernetes Multi-Cluster Service Discovery: MCS API and Submariner

## The Multi-Cluster Service Discovery Problem

Without cross-cluster service discovery, teams resort to:
- Hardcoded external IP addresses or load balancer hostnames
- Custom service registries outside Kubernetes
- Complicated DNS-based routing that bypasses Kubernetes service abstractions

All of these approaches break when pods move, load balancer IPs change, or clusters are rebuilt. The MCS API provides a Kubernetes-native solution that works with existing DNS resolution patterns.

## Multi-Cluster Services API Overview

The MCS API (KEP-1645) introduces two CRDs:

- **ServiceExport**: Marks a service in a cluster as exportable to the clusterset
- **ServiceImport**: Automatically created in member clusters when a ServiceExport exists, provides a virtual service for cross-cluster access

DNS for exported services resolves via `<service>.<namespace>.svc.clusterset.local`, making cross-cluster service access look identical to in-cluster access from an application perspective.

## Submariner Architecture

Submariner provides the tunnel-based network overlay that connects clusters. Its components:

- **Broker**: A central Kubernetes cluster (or namespace) that stores cluster membership and endpoint information
- **Gateway**: Pods running on gateway nodes that create IPsec/WireGuard tunnels between clusters
- **Route Agent**: DaemonSet that programs routes on each node to direct cross-cluster traffic through the gateway
- **Service Discovery**: Controller that implements the MCS API, creating ServiceImport objects from ServiceExport data

### Prerequisites

```
Cluster 1 (cluster-west): CIDR 10.0.0.0/16, Service CIDR 10.96.0.0/12
Cluster 2 (cluster-east): CIDR 10.1.0.0/16, Service CIDR 10.97.0.0/12
Broker Cluster: Any cluster, no workloads needed

Requirements:
- Cluster CIDRs must NOT overlap
- Service CIDRs must NOT overlap
- Gateway nodes need UDP 4500 (IPsec NAT-T) open between clusters
- Outbound connectivity from gateway to gateway (direct or via NAT)
```

## Deploying Submariner

### Step 1: Install subctl CLI

```bash
curl -Ls https://get.submariner.io | VERSION=0.17.0 bash
export PATH=$PATH:~/.local/bin
subctl version
```

### Step 2: Configure Broker

```bash
# Use the broker cluster context
kubectl config use-context broker-cluster

# Deploy broker
subctl deploy-broker \
  --kubeconfig ~/.kube/config \
  --context broker-cluster

# This creates a submariner-k8s-broker namespace and exports credentials
ls broker-info.subm  # broker credentials file
```

### Step 3: Join Cluster West

```bash
# Join cluster-west to the broker
subctl join broker-info.subm \
  --kubeconfig ~/.kube/config \
  --context cluster-west \
  --clusterid cluster-west \
  --cable-driver libreswan \
  --natt-port 4500

# Verify gateway pod is running
kubectl --context cluster-west get pods -n submariner-operator
# NAME                                      READY   STATUS    RESTARTS
# submariner-gateway-xxxxx                  1/1     Running   0
# submariner-routeagent-xxxxx (daemonset)   1/1     Running   0
```

### Step 4: Join Cluster East

```bash
subctl join broker-info.subm \
  --kubeconfig ~/.kube/config \
  --context cluster-east \
  --clusterid cluster-east \
  --cable-driver libreswan \
  --natt-port 4500
```

### Step 5: Verify Connectivity

```bash
# Check connection status
subctl show connections --context cluster-west

# Expected output:
# GATEWAY      CLUSTER          REMOTE IP     NAT  CABLE DRIVER  SUBNETS  STATUS
# gateway-west cluster-west  10.100.1.5   no   libreswan        10.0.0.0/16  connected
# gateway-east cluster-east  10.100.2.5   no   libreswan        10.1.0.0/16  connected

# Run connectivity diagnostics
subctl diagnose all --context cluster-west

# Test direct pod-to-pod connectivity
subctl benchmark latency \
  --context cluster-west \
  --tocontext cluster-east
```

## Exporting Services with MCS API

### ServiceExport for a Stateless Service

```yaml
# payment-service.yaml - create in cluster-west
apiVersion: v1
kind: Service
metadata:
  name: payment-api
  namespace: payments
spec:
  selector:
    app: payment-api
  ports:
  - name: http
    port: 8080
    targetPort: 8080
  - name: grpc
    port: 9090
    targetPort: 9090
---
# Export the service to the clusterset
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: payment-api
  namespace: payments
```

```bash
kubectl --context cluster-west apply -f payment-service.yaml

# Verify ServiceExport was accepted
kubectl --context cluster-west get serviceexport -n payments payment-api
# NAME          AGE   VALID
# payment-api   30s   True

# Submariner creates a ServiceImport in cluster-east automatically
kubectl --context cluster-east get serviceimport -n payments payment-api
# NAME          TYPE           IP                    AGE
# payment-api   ClusterSetIP   []                    30s
```

### ServiceExport for a Headless Service (StatefulSet)

```yaml
# database-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres-headless
  namespace: database
spec:
  clusterIP: None  # Headless service
  selector:
    app: postgres
  ports:
  - name: postgres
    port: 5432
    targetPort: 5432
---
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: postgres-headless
  namespace: database
```

Headless service exports create DNS entries for individual pod IPs, enabling direct pod addressing across clusters:

```
# DNS resolution for headless service:
# postgres-headless.database.svc.clusterset.local -> returns all pod IPs from all clusters
# pod-0.postgres-headless.database.svc.clusterset.local -> specific pod across clusters
```

## DNS Resolution for Cross-Cluster Services

### How clusterset.local DNS Works

Submariner's service discovery component runs a CoreDNS instance that handles `clusterset.local` queries. It is configured as an additional DNS server in cluster CoreDNS via a stub zone:

```yaml
# CoreDNS ConfigMap addition (applied automatically by Submariner)
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
    # Submariner adds this stub zone:
    clusterset.local:53 {
        forward . <submariner-lighthouse-dns-service-ip>:53
    }
```

### Testing Cross-Cluster DNS

```bash
# From a pod in cluster-east, resolve the payment-api exported from cluster-west
kubectl --context cluster-east run dns-test \
  --image=busybox --restart=Never --rm -it -- \
  nslookup payment-api.payments.svc.clusterset.local

# Expected output:
# Server:    169.254.20.10 (or cluster DNS IP)
# Address:   169.254.20.10:53
#
# Name:      payment-api.payments.svc.clusterset.local
# Address:   100.64.x.x  (Submariner's ServiceImport ClusterSetIP)

# Test actual connectivity
kubectl --context cluster-east run curl-test \
  --image=curlimages/curl --restart=Never --rm -it -- \
  curl -v http://payment-api.payments.svc.clusterset.local:8080/health
```

## Weight-Based Load Balancing Across Clusters

ServiceImport supports weight-based routing across clusters using annotations:

```yaml
# Set weight for cluster-west's endpoints (applied in cluster-west)
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: payment-api
  namespace: payments
  annotations:
    # Weight relative to other clusters exporting this service
    # cluster-west: 80, cluster-east: 20 = 80% west, 20% east
    multicluster.x-k8s.io/service-weight: "80"
```

For more sophisticated load balancing policies, combine with an external load balancer that understands MCS (like Liqo or Istio with multi-cluster configuration).

## Cluster Failover

When a cluster fails, its service endpoints become unavailable. Submariner detects this via gateway health monitoring and removes the failed cluster's endpoints from DNS.

### Configuring Health Check

```bash
# Enable health check for gateway connections
subctl join broker-info.subm \
  --context cluster-west \
  --clusterid cluster-west \
  --cable-driver libreswan \
  --health-check-enabled \
  --health-check-interval 1 \  # Check every 1 second
  --health-check-max-packet-loss-count 5  # Fail after 5 lost packets
```

### Testing Failover

```bash
# Simulate cluster-west gateway failure
kubectl --context cluster-west scale deployment submariner-gateway \
  -n submariner-operator --replicas=0

# Wait for health check to detect failure (5-10 seconds)
sleep 15

# Verify DNS now returns only cluster-east endpoints
kubectl --context cluster-east run dns-test \
  --image=busybox --restart=Never --rm -it -- \
  nslookup payment-api.payments.svc.clusterset.local

# Restore cluster-west gateway
kubectl --context cluster-west scale deployment submariner-gateway \
  -n submariner-operator --replicas=1
```

## Liqo as a Lightweight Alternative

For clusters where Submariner's full IPsec tunnel approach is too heavyweight, Liqo provides a simpler multi-cluster connectivity model based on virtual node abstraction.

```bash
# Install liqoctl
curl --fail -LS "https://github.com/liqotech/liqo/releases/download/v0.10.0/liqoctl-linux-amd64.tar.gz" \
  | tar -xz liqoctl
mv liqoctl /usr/local/bin/

# Install Liqo on cluster-west
liqoctl install kubernetes \
  --cluster-name cluster-west \
  --kubeconfig ~/.kube/config \
  --context cluster-west

# Install Liqo on cluster-east
liqoctl install kubernetes \
  --cluster-name cluster-east \
  --kubeconfig ~/.kube/config \
  --context cluster-east

# Peer clusters
EAST_AUTH=$(liqoctl get peer-info --context cluster-east)
liqoctl peer \
  --kubeconfig ~/.kube/config \
  --context cluster-west \
  $EAST_AUTH
```

Liqo offloads namespaces to remote clusters, making remote pods appear as local pods with local DNS. This is simpler for active-active deployments but less suitable for scenarios where explicit cluster control is needed.

## Active-Active Multi-Region Patterns

### Pattern 1: Read from Local, Write to Primary

```yaml
# Service configuration for active-active with locality preference
apiVersion: v1
kind: Service
metadata:
  name: user-service
  namespace: app
  annotations:
    # Submariner annotation to prefer local cluster endpoints
    submariner.io/prefer-local: "true"
spec:
  selector:
    app: user-service
  ports:
  - port: 8080
```

```go
// Application code: try local cluster first, fall back to clusterset
func getUser(ctx context.Context, userID string) (*User, error) {
    // Try local cluster service first (lower latency)
    user, err := userServiceClient.Get(ctx, "user-service.app.svc.cluster.local", userID)
    if err == nil {
        return user, nil
    }

    // Fall back to clusterset (cross-cluster)
    log.Warn("local cluster failed, falling back to clusterset", "error", err)
    return userServiceClient.Get(ctx, "user-service.app.svc.clusterset.local", userID)
}
```

### Pattern 2: Namespace-Level Cluster Assignment

```yaml
# Assign specific services to specific clusters via labels
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: payments
  labels:
    cluster-assignment: cluster-west  # Documentation label
spec:
  template:
    spec:
      # Use affinity to ensure pods run in intended cluster
      # Combined with ServiceExport for discovery
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: topology.kubernetes.io/region
                operator: In
                values:
                - us-west-2
```

## Monitoring Multi-Cluster Connectivity

### Submariner Metrics

```yaml
# PodMonitor for Submariner metrics
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: submariner-gateway
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
    - submariner-operator
  selector:
    matchLabels:
      app: submariner-gateway
  podMetricsEndpoints:
  - port: metrics
    path: /metrics
    interval: 30s
```

Key metrics to alert on:

```promql
# Gateway connection status (0 = connected, 1 = error)
submariner_gateway_connections{status!="connected"} > 0

# Packet loss on tunnel
rate(submariner_gateway_rx_packets_total[5m]) == 0
  and
submariner_gateway_connections{status="connected"} > 0

# Service discovery sync errors
rate(submariner_service_discovery_syncs_total{result="error"}[5m]) > 0
```

## Common Issues and Solutions

### ServiceExport Not Creating ServiceImport

```bash
# Check ServiceExport status
kubectl --context cluster-west describe serviceexport payment-api -n payments

# Check Submariner lighthouse controller logs
kubectl --context cluster-west logs -n submariner-operator \
  -l app=submariner-lighthouse-agent --tail=50

# Verify broker connectivity
subctl show endpoints --context cluster-west
```

### Cross-Cluster DNS Not Resolving

```bash
# Test Lighthouse DNS directly
kubectl --context cluster-east run dns-debug \
  --image=busybox --restart=Never --rm -it -- \
  nslookup payment-api.payments.svc.clusterset.local \
  <lighthouse-dns-service-ip>

# Check CoreDNS forwarding is configured
kubectl --context cluster-east get configmap coredns -n kube-system -o yaml | grep clusterset

# Restart CoreDNS to pick up ConfigMap changes
kubectl --context cluster-east rollout restart deployment coredns -n kube-system
```

### Gateway Tunnel Not Establishing

```bash
# Check NAT-T port accessibility
subctl diagnose firewall inter-cluster \
  --context cluster-west \
  --remotecontext cluster-east

# Check gateway pod logs
kubectl --context cluster-west logs -n submariner-operator \
  -l app=submariner-gateway --tail=100 | grep -i error

# Verify no CIDR overlap
subctl show networks --context cluster-west
subctl show networks --context cluster-east
```

## Summary

Multi-cluster service discovery with MCS API and Submariner provides a Kubernetes-native path to cross-cluster connectivity. The key operational principles:

1. Never overlap CIDRs between clusters - verify before joining
2. Use `subctl diagnose` to validate connectivity and firewall rules before deploying applications
3. Export services explicitly with ServiceExport rather than relying on implicit cross-cluster access
4. Monitor gateway connection status and tunnel metrics as first-line SLIs
5. Test failover behavior in staging before relying on it in production
6. Use `submariner.io/prefer-local: "true"` annotation to minimize cross-cluster latency in normal operation
7. Consider Liqo for simpler active-active scenarios where full IPSEC tunnel control is not required

The MCS API is still evolving (it graduated to beta in Kubernetes 1.27), so review the KEP for your cluster version to understand which features are stable.
