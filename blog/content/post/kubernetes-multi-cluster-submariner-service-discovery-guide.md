---
title: "Kubernetes Multi-Cluster Service Discovery with Submariner"
date: 2029-05-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Submariner", "Multi-Cluster", "Service Discovery", "Networking", "MCS API"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production deployment guide for Submariner multi-cluster connectivity covering broker architecture, gateway nodes, Globalnet for overlapping CIDRs, cross-cluster DNS with ServiceExport/ServiceImport, and the Kubernetes Multi-Cluster Services (MCS) API."
more_link: "yes"
url: "/kubernetes-multi-cluster-submariner-service-discovery-guide/"
---

Running multiple Kubernetes clusters is increasingly common — for geographic distribution, workload isolation, or regulatory compliance. But connecting those clusters so services can communicate transparently is non-trivial. Submariner solves this by creating encrypted tunnels between cluster networks and providing cross-cluster DNS, enabling services in one cluster to resolve and reach services in another as if they were local. This post covers a complete production Submariner deployment, including the tricky Globalnet configuration for clusters with overlapping pod CIDRs.

<!--more-->

# Kubernetes Multi-Cluster Service Discovery with Submariner

## Section 1: Submariner Architecture

Submariner establishes direct pod-to-pod and service-to-pod connectivity between clusters. It consists of several components working together:

```
Cluster A                           Cluster B
┌─────────────────────┐             ┌─────────────────────┐
│  submariner-gateway  │◄─WireGuard/IPSec─►submariner-gateway │
│  (per cluster)      │             │  (per cluster)      │
└─────────────────────┘             └─────────────────────┘
┌─────────────────────┐             ┌─────────────────────┐
│  route-agent        │             │  route-agent        │
│  (DaemonSet)        │             │  (DaemonSet)        │
└─────────────────────┘             └─────────────────────┘
┌─────────────────────┐             ┌─────────────────────┐
│  lighthouse-agent   │◄────────────►  lighthouse-agent   │
│  (service discovery)│             │  (service discovery)│
└─────────────────────┘             └─────────────────────┘
         │                                    │
         └──────────────┐ ┌──────────────────┘
                        ▼ ▼
                ┌───────────────┐
                │    Broker     │
                │  (K8s cluster │
                │  or dedicated)│
                └───────────────┘
```

### Core Components

- **Gateway**: One or more nodes per cluster with public IPs that establish the encrypted tunnels. Supports IPSec (libreswan) or WireGuard.
- **Route Agent**: DaemonSet on every node that programs routes so pod traffic destined for remote clusters is directed to the gateway node.
- **Broker**: A Kubernetes cluster (can be one of the workload clusters) that stores cluster metadata and endpoint information. Acts as a rendezvous point for cluster registration.
- **Lighthouse Agent**: Syncs ServiceExport/ServiceImport resources across clusters for cross-cluster DNS.
- **Lighthouse DNS Server**: CoreDNS plugin that answers DNS queries for exported services from remote clusters.
- **Globalnet**: Optional component for clusters with overlapping pod/service CIDRs.

## Section 2: Prerequisites and Installation

### System Requirements

```bash
# On each cluster node that will serve as a gateway:
# - Public or routable IP address
# - UDP port 4500 (IPSec NAT-T) or 51820 (WireGuard)
# - TCP/UDP 8080 for Submariner metrics
# - No firewall blocking inter-cluster traffic

# Check kernel modules
lsmod | grep xfrm  # Required for IPSec
lsmod | grep wireguard  # Required for WireGuard

# Enable required kernel modules
sudo modprobe xfrm_algo
sudo modprobe esp4
sudo modprobe ah4
# Or for WireGuard:
sudo modprobe wireguard

# Verify no CIDR overlap (in standard mode)
# Cluster A: pod CIDR 10.244.0.0/16, service CIDR 10.96.0.0/12
# Cluster B: pod CIDR 10.245.0.0/16, service CIDR 10.97.0.0/12
# (use Globalnet if they overlap)
```

### Installing subctl

```bash
# Install subctl (the Submariner CLI)
curl -Ls https://get.submariner.io | bash

# Or via direct download
SUBCTL_VERSION="0.17.0"
curl -Lo subctl "https://github.com/submariner-io/subctl/releases/download/v${SUBCTL_VERSION}/subctl-v${SUBCTL_VERSION}-linux-amd64.tar.gz" | \
  tar -xz --strip-components=1 && \
  chmod +x subctl && \
  sudo mv subctl /usr/local/bin/

subctl version
```

### Setting Up the Broker

The broker is typically deployed in a dedicated cluster or on the primary cluster:

```bash
# Set context to the broker cluster
export KUBECONFIG=/path/to/broker-cluster.yaml

# Deploy the broker
subctl deploy-broker \
  --kubeconfig /path/to/broker-cluster.yaml \
  --globalnet \
  --globalnet-cidr-range 169.254.0.0/16 \
  --default-globalnet-cluster-size 8192

# This creates broker-info.subm file with:
# - Broker CA cert
# - Service account token
# - Broker API endpoint
ls -la broker-info.subm
```

## Section 3: Joining Clusters

### Join Cluster A

```bash
# Set context to Cluster A
export KUBECONFIG=/path/to/cluster-a.yaml

# Join cluster to broker
# Note: --natt=true for NAT traversal (most cloud environments need this)
subctl join broker-info.subm \
  --kubeconfig /path/to/cluster-a.yaml \
  --clusterid cluster-a \
  --natt=true \
  --cable-driver wireguard \
  --health-check=true \
  --globalnet-cidr 169.254.1.0/24

# For IPSec instead of WireGuard:
# --cable-driver libreswan

# Label gateway node(s) - Submariner will deploy gateway pod here
kubectl label node worker-1 submariner.io/gateway=true

# Verify join
subctl show connections
subctl show endpoints
subctl show gateways
```

### Join Cluster B

```bash
export KUBECONFIG=/path/to/cluster-b.yaml

subctl join broker-info.subm \
  --kubeconfig /path/to/cluster-b.yaml \
  --clusterid cluster-b \
  --natt=true \
  --cable-driver wireguard \
  --health-check=true \
  --globalnet-cidr 169.254.2.0/24

kubectl label node worker-2 submariner.io/gateway=true
```

### Verify Connectivity

```bash
# Check all clusters see each other
subctl show all

# Run the built-in connectivity test
subctl verify /path/to/cluster-a.yaml /path/to/cluster-b.yaml \
  --only connectivity \
  --verbose

# Manual test: ping across clusters
# Deploy test pod in cluster A
kubectl --kubeconfig cluster-a.yaml run test-a --image=busybox -- sleep 3600
POD_A_IP=$(kubectl --kubeconfig cluster-a.yaml get pod test-a \
  -o jsonpath='{.status.podIP}')

# Deploy test pod in cluster B
kubectl --kubeconfig cluster-b.yaml run test-b --image=busybox -- sleep 3600

# Ping from B to A
kubectl --kubeconfig cluster-b.yaml exec test-b -- ping -c3 $POD_A_IP
```

## Section 4: Globalnet for Overlapping CIDRs

Many organizations use the same pod/service CIDRs in different clusters. Without Globalnet, this creates routing ambiguity. Globalnet assigns each cluster a "global CIDR" from which globally-routable IPs are allocated to pods and services that need cross-cluster access.

### How Globalnet Works

```
Without Globalnet (requires non-overlapping CIDRs):
  Cluster A pod 10.244.1.5  → directly reachable from Cluster B

With Globalnet (handles overlapping CIDRs):
  Cluster A pod 10.244.1.5  → gets GlobalIP 169.254.1.10
  Cluster B sees traffic to 169.254.1.10 → gateway NATs to 10.244.1.5
```

### Globalnet Configuration

```yaml
# GlobalnetClusterConfig - set per-cluster CIDR allocations
apiVersion: submariner.io/v1alpha1
kind: ClusterGlobalEgressIP
metadata:
  name: cluster-a-egress
  namespace: submariner-operator
spec:
  # All pods in cluster A egress via this CIDR when talking to remote clusters
  numberOfIPs: 8
---
# For specific namespace egress
apiVersion: submariner.io/v1alpha1
kind: GlobalEgressIP
metadata:
  name: production-egress
  namespace: production
spec:
  numberOfIPs: 4
  podSelector:
    matchLabels:
      app: api-server
```

### Verifying Globalnet

```bash
# Check global IPs assigned to pods
kubectl get globalingressip -A
kubectl get globalegressip -A

# Check GlobalIP annotations on pods
kubectl get pod my-pod -o jsonpath='{.metadata.annotations}'
# Look for: submariner.io/globalIp: 169.254.1.15

# Verify routing table on gateway node
ssh gateway-node-a "ip route show table submariner_mss"

# Check Globalnet controller logs
kubectl logs -n submariner-operator -l app=submariner-globalnet -f
```

## Section 5: Cross-Cluster DNS with ServiceExport and ServiceImport

The Multi-Cluster Services (MCS) API uses two custom resources:
- **ServiceExport**: In the source cluster, marks a service for export
- **ServiceImport**: Automatically created in destination clusters when a ServiceExport is detected

### Exporting a Service

```yaml
# In Cluster A: deploy a backend service
apiVersion: apps/v1
kind: Deployment
metadata:
  name: product-api
  namespace: microservices
spec:
  replicas: 3
  selector:
    matchLabels:
      app: product-api
  template:
    metadata:
      labels:
        app: product-api
    spec:
      containers:
      - name: api
        image: myorg/product-api:v2.1.0
        ports:
        - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: product-api
  namespace: microservices
spec:
  selector:
    app: product-api
  ports:
  - port: 8080
    targetPort: 8080
  type: ClusterIP
---
# Export the service across clusters
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: product-api
  namespace: microservices
```

### Viewing Imports in Other Clusters

```bash
# After export, Lighthouse syncs the ServiceImport to all joined clusters
# In Cluster B:
kubectl --kubeconfig cluster-b.yaml get serviceimport -A

# Output:
# NAMESPACE       NAME          TYPE           IP               AGE
# microservices   product-api   ClusterSetIP   169.254.1.25     2m

# The ServiceImport details
kubectl --kubeconfig cluster-b.yaml describe serviceimport product-api -n microservices
```

### Accessing Exported Services via DNS

Submariner's Lighthouse DNS server answers queries for the format:
`<service>.<namespace>.svc.clusterset.local`

```bash
# From a pod in Cluster B:
# Resolve the service from Cluster A
nslookup product-api.microservices.svc.clusterset.local
# Returns: 169.254.1.25 (the GlobalIP or ClusterSetIP)

# Also works with cluster-specific DNS:
# <service>.<namespace>.svc.<clusterId>.local
nslookup product-api.microservices.svc.cluster-a.local

# Test from a pod
kubectl --kubeconfig cluster-b.yaml exec -it test-pod -- \
  curl http://product-api.microservices.svc.clusterset.local:8080/health
```

### CoreDNS Configuration for Lighthouse

Submariner automatically configures CoreDNS to forward `clusterset.local` queries to Lighthouse:

```yaml
# Submariner patches the CoreDNS ConfigMap like this:
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
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
        }
        # Submariner Lighthouse DNS for cross-cluster service discovery
        forward clusterset.local 100.96.0.10 {
            force_tcp
        }
        prometheus :9153
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
```

```bash
# Verify Lighthouse DNS service
kubectl get svc -n submariner-operator lighthouse-coredns
# NAME                    TYPE        CLUSTER-IP    PORT(S)
# lighthouse-coredns      ClusterIP   100.96.0.10   53/UDP,53/TCP

# Check Lighthouse CoreDNS is responding
kubectl run dns-test --image=busybox --rm -it --restart=Never -- \
  nslookup product-api.microservices.svc.clusterset.local 100.96.0.10
```

## Section 6: Multi-Cluster Service with Load Balancing

When the same service is exported from multiple clusters, Lighthouse performs round-robin across all cluster endpoints.

### Exporting the Same Service from Multiple Clusters

```yaml
# Cluster A: product-api ServiceExport
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: product-api
  namespace: microservices
  annotations:
    # Optional: weight for load balancing
    submariner.io/weight: "100"
```

```yaml
# Cluster B: same service, same export
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: product-api
  namespace: microservices
  annotations:
    submariner.io/weight: "50"  # Less capacity, less traffic
```

```bash
# Verify multi-cluster endpoints
kubectl get endpointslice -n microservices \
  -l multicluster.kubernetes.io/service-name=product-api

# Each cluster's endpoints appear as separate EndpointSlice
# Lighthouse returns all IPs, client performs selection

# Test that requests go to both clusters
for i in $(seq 1 20); do
  curl -s http://product-api.microservices.svc.clusterset.local:8080/cluster-id
done
# Should show cluster-a and cluster-b responses
```

## Section 7: Network Policies for Cross-Cluster Traffic

Submariner does not automatically allow all cross-cluster traffic. Network policies must explicitly permit it.

### Allow Ingress from Remote Clusters

```yaml
# In Cluster A: allow product-api to receive traffic from any cluster
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-remote-clusters
  namespace: microservices
spec:
  podSelector:
    matchLabels:
      app: product-api
  ingress:
  - from:
    # Allow from Globalnet CIDR (all remote clusters)
    - ipBlock:
        cidr: 169.254.0.0/16
    ports:
    - protocol: TCP
      port: 8080
  policyTypes:
  - Ingress
```

```yaml
# In Cluster B: allow pods to egress to remote cluster CIDRs
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-to-remote-clusters
  namespace: frontend
spec:
  podSelector:
    matchLabels:
      tier: frontend
  egress:
  - to:
    # Cluster A's GlobalNet CIDR
    - ipBlock:
        cidr: 169.254.1.0/24
    ports:
    - protocol: TCP
      port: 8080
  policyTypes:
  - Egress
```

## Section 8: High Availability Gateway Configuration

For production, deploy multiple gateway nodes with active-passive failover:

```bash
# Label multiple nodes as gateways
kubectl label node worker-1 submariner.io/gateway=true
kubectl label node worker-2 submariner.io/gateway=true

# Verify HA gateway setup
kubectl get gateway -n submariner-operator
# NAME       HA STATUS   LOCAL HOSTNAME   CONNECTIONS   AGE
# worker-1   active      worker-1         2             10m
# worker-2   passive     worker-2         0             10m

# Test failover by cordoning the active gateway
kubectl cordon worker-1
kubectl delete pod -n submariner-operator -l app=submariner-gateway \
  --field-selector spec.nodeName=worker-1

# Verify failover
kubectl get gateway -n submariner-operator
# worker-2 should now be active
```

### Gateway Health Check Configuration

```yaml
# submariner-operator configuration
apiVersion: submariner.io/v1alpha1
kind: Submariner
metadata:
  name: submariner
  namespace: submariner-operator
spec:
  # Gateway settings
  ceIPSecNATTPort: 4500
  ceIPSecPreferredServer: false
  ceIPSecForceUDPEncaps: false

  # WireGuard (alternative to IPSec)
  cableDriver: wireguard

  # Health checking
  connectionHealthCheck:
    enabled: true
    intervalSeconds: 1
    maxPacketLossCount: 5

  # Broker connection
  brokerK8sApiServer: https://broker.example.com:6443
  brokerK8sApiServerToken: "" # managed by subctl
  brokerK8sCA: ""             # managed by subctl
  brokerK8sRemoteNamespace: submariner-k8s-broker

  # Globalnet
  globalCIDR: 169.254.1.0/24

  # Metrics
  serviceDiscoveryEnabled: true
  natEnabled: true
  colorCodes: "blue"
```

## Section 9: Monitoring and Observability

### Submariner Metrics

```bash
# Port-forward to metrics endpoints
kubectl port-forward -n submariner-operator svc/submariner-metrics 8080

# Key metrics
curl -s http://localhost:8080/metrics | grep -E \
  "submariner_connections_total|submariner_gateway_rx_bytes|submariner_gateway_tx_bytes"
```

Prometheus scrape configuration:

```yaml
- job_name: 'submariner'
  kubernetes_sd_configs:
  - role: pod
    namespaces:
      names: ['submariner-operator']
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
    action: keep
    regex: true
  - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
    action: replace
    target_label: __metrics_path__
    regex: (.+)
```

### Troubleshooting Cross-Cluster Connectivity

```bash
# Step 1: Check gateway connection status
subctl show connections
# Expected:
# GATEWAY          CLUSTER    REMOTE IP    NAT    CABLE DRIVER    SUBNETS    STATUS
# worker-1.a       cluster-b  1.2.3.4      false  wireguard       2          connected

# Step 2: Check endpoint synchronization
kubectl get submarinerendpoints -n submariner-operator
kubectl get submariners -A

# Step 3: Check route agent logs on the node where the failing pod runs
kubectl logs -n submariner-operator -l app=submariner-routeagent \
  --field-selector spec.nodeName=problem-node

# Step 4: Verify routes are programmed
ssh worker-1 "ip route show table submariner_mss"
# Should show routes to remote cluster CIDRs via the tunnel interface

# Step 5: Test with netcat
# On pod in Cluster A:
nc -l 9999
# On pod in Cluster B (using pod IP from Cluster A):
nc <pod-a-ip> 9999

# Step 6: Check IPtables NAT rules (for Globalnet)
ssh gateway-node "iptables -t nat -L SUBMARINER-GN-INGRESS -n -v"
ssh gateway-node "iptables -t nat -L SUBMARINER-GN-EGRESS -n -v"

# Step 7: Packet capture across tunnel
ssh gateway-node "tcpdump -i vxlan0 -n host <remote-pod-ip>"
```

### Common Issues

**Connection state "Connecting" never reaches "Connected":**
```bash
# Check if UDP 4500 (IPSec) or 51820 (WireGuard) is reachable
nc -uvz <remote-gateway-ip> 4500
nc -uvz <remote-gateway-ip> 51820

# Check cloud security groups / firewall rules allow UDP on those ports
# AWS: check security group inbound rules
# GCP: check firewall rules for UDP ports
```

**DNS resolution fails for clusterset.local:**
```bash
# Check Lighthouse CoreDNS pod
kubectl get pods -n submariner-operator -l app=submariner-lighthouse-coredns

# Check CoreDNS forward rule was added
kubectl get configmap -n kube-system coredns -o yaml | grep clusterset

# Manually query Lighthouse
kubectl run dns-test --image=busybox --rm -it --restart=Never -- \
  nslookup product-api.microservices.svc.clusterset.local 100.96.0.10
```

**ServiceImport not appearing:**
```bash
# Check Lighthouse agent logs
kubectl logs -n submariner-operator -l app=submariner-lighthouse-agent

# Verify ServiceExport was created correctly
kubectl get serviceexport -n microservices
kubectl describe serviceexport product-api -n microservices
# Look for "Valid" condition = True

# Check broker has the endpoint
kubectl --kubeconfig broker.yaml get endpoints -n submariner-k8s-broker
```

Submariner provides a production-ready path to multi-cluster connectivity with strong community backing from CNCF. The key operational investment is in the Globalnet configuration (if you have overlapping CIDRs), gateway high availability setup, and integrating cross-cluster service DNS into your applications' service discovery patterns.
