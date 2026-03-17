---
title: "Kubernetes Multi-Cluster Service Discovery with Submariner"
date: 2028-12-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Submariner", "Multi-Cluster", "Service Discovery", "Networking", "Federation"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Submariner for Kubernetes multi-cluster connectivity, covering the broker model, IPsec/WireGuard tunnels, ServiceExport/ServiceImport, and DNS-based cross-cluster service discovery."
more_link: "yes"
url: "/kubernetes-multi-cluster-service-discovery-submariner/"
---

Running workloads across multiple Kubernetes clusters is a common enterprise requirement for disaster recovery, geographic distribution, and compliance isolation. The challenge is connecting those clusters so that services can communicate across cluster boundaries without requiring external load balancers or complex network routing between every pair of clusters. Submariner addresses this by establishing encrypted tunnels between cluster nodes, exchanging service endpoint information via a central broker, and providing DNS-based service discovery through the `ServiceExport` and `ServiceImport` Kubernetes API objects defined in the multi-cluster services KEP.

<!--more-->

## Submariner Architecture

Submariner has four main components:

1. **Broker**: A Kubernetes cluster (or a dedicated namespace) that acts as the rendezvous point for cluster metadata. It stores `Endpoint` and `Cluster` CRDs that describe each connected cluster's CIDR ranges and gateway nodes. The broker runs no data-plane traffic.

2. **Gateway Engine**: A DaemonSet pod running on designated gateway nodes. It establishes the encrypted tunnel (IPsec via Libreswan by default, or WireGuard) and handles packet encapsulation/decapsulation for inter-cluster traffic.

3. **Route Agent**: A DaemonSet pod on every non-gateway node. It programs kernel routing tables to direct traffic destined for remote cluster CIDRs toward the local gateway node.

4. **Lighthouse**: Implements the multi-cluster service discovery API (`ServiceExport`, `ServiceImport`) and integrates with CoreDNS to answer cross-cluster DNS queries.

```
Cluster A (us-east-1)          Cluster B (eu-west-1)
┌─────────────────────────┐    ┌─────────────────────────┐
│  App Pod                │    │  App Pod                │
│  10.244.1.5             │    │  10.245.2.10            │
│         │               │    │         │               │
│  Route Agent            │    │  Route Agent            │
│  (programs: 10.245/16   │    │  (programs: 10.244/16   │
│   → gateway-node)        │    │   → gateway-node)        │
│         │               │    │         │               │
│  Gateway Node           │◄──►│  Gateway Node           │
│  IPsec/WireGuard tunnel │    │  IPsec/WireGuard tunnel │
└─────────────────────────┘    └─────────────────────────┘
              │                              │
              └──────────┬───────────────────┘
                         │
                  Broker Cluster
                  (CRD storage only)
```

## Prerequisites and CIDR Planning

Before deploying Submariner, each cluster's pod CIDR and service CIDR must be non-overlapping:

```bash
# Verify CIDRs for each cluster — must not overlap
# Cluster A (us-east-1)
kubectl --context=cluster-a get nodes -o jsonpath='{.items[0].spec.podCIDR}'
# 10.244.0.0/24

kubectl --context=cluster-a cluster-info dump | grep -m1 "service-cluster-ip-range"
# --service-cluster-ip-range=10.96.0.0/12

# Cluster B (eu-west-1)
kubectl --context=cluster-b get nodes -o jsonpath='{.items[0].spec.podCIDR}'
# 10.245.0.0/24

kubectl --context=cluster-b cluster-info dump | grep -m1 "service-cluster-ip-range"
# --service-cluster-ip-range=10.100.0.0/12

# Recommended non-overlapping CIDR allocation:
# Cluster A: pods=10.244.0.0/16, services=10.96.0.0/16
# Cluster B: pods=10.245.0.0/16, services=10.100.0.0/16
# Cluster C: pods=10.246.0.0/16, services=10.104.0.0/16
```

## Installing subctl

```bash
# Install subctl (Submariner control tool)
curl -Ls https://get.submariner.io | VERSION=0.17.0 bash
export PATH=$PATH:~/.local/bin
subctl version

# Verify prerequisites for each cluster
subctl check firewall inter-cluster \
  --context=cluster-a \
  --remotecontext=cluster-b

# Required open ports between gateway nodes:
# - UDP 4500/4501 (IPsec NAT-T)
# - UDP 4800 (VXLAN — internal cluster traffic)
# - TCP/UDP 443 (broker API server)
```

## Broker Deployment

The broker is deployed in a dedicated cluster or namespace that both clusters can reach:

```bash
# Deploy the broker on the management cluster
# The broker only stores CRD state — no data plane traffic
subctl deploy-broker \
  --context=broker-cluster \
  --globalnet \
  --globalnet-cidr-range=242.0.0.0/8 \
  --default-globalnet-cluster-size=65536

# This creates:
# - namespace: submariner-k8s-broker
# - CRDs: Cluster, Endpoint, GlobalEgressIP, GlobalIngressIP
# - ServiceAccount with join credentials
# - Secret: submariner-broker-info (contains broker access token)

# Verify broker deployment
kubectl --context=broker-cluster get all -n submariner-k8s-broker
```

## Joining Clusters to the Broker

```bash
# Join Cluster A
subctl join \
  --context=cluster-a \
  --clusterid=cluster-a \
  --servicecidr=10.96.0.0/16 \
  --clustercidr=10.244.0.0/16 \
  --natt=true \
  --cable-driver=libreswan \
  --coredns-custom-configmap=coredns/coredns \
  broker-info.subm

# Join Cluster B
subctl join \
  --context=cluster-b \
  --clusterid=cluster-b \
  --servicecidr=10.100.0.0/16 \
  --clustercidr=10.245.0.0/16 \
  --natt=true \
  --cable-driver=libreswan \
  broker-info.subm

# Verify gateway nodes are established
kubectl --context=cluster-a get gateways -n submariner
# NAME                     HA STATUS   CONNECTION STATUS
# node-a-gw-1              active      connected

kubectl --context=cluster-b get gateways -n submariner
# NAME                     HA STATUS   CONNECTION STATUS
# node-b-gw-1              active      connected
```

### Helm-Based Installation

For GitOps environments, use the Helm chart instead of subctl:

```yaml
# submariner-operator-values.yaml
opsNamespace: submariner-operator

broker:
  server: "https://broker.management.example.com:6443"
  token: "eyJhbGciOiJSUzI1NiIsImtpZCI6IjF..."  # From broker-info.subm
  ca: "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0t..."     # Base64-encoded CA cert
  namespace: submariner-k8s-broker

submariner:
  clusterCidr: "10.244.0.0/16"
  serviceCidr: "10.96.0.0/16"
  clusterID: cluster-a
  colorCodes: blue
  natEnabled: true
  debug: false
  broker: k8s
  cableDriver: libreswan

  # WireGuard alternative (faster, requires kernel module)
  # cableDriver: wireguard

gateway:
  replicas: 2               # HA gateways
  image:
    repository: quay.io/submariner/submariner-gateway
    tag: 0.17.0
  nodeSelector:
    submariner.io/gateway: "true"
  tolerations:
  - key: node-role.kubernetes.io/control-plane
    operator: Exists
    effect: NoSchedule

routeAgent:
  image:
    repository: quay.io/submariner/submariner-route-agent
    tag: 0.17.0

lighthouse:
  enabled: true
  image:
    repository: quay.io/submariner/lighthouse-agent
    tag: 0.17.0

serviceDiscovery: true
```

```bash
# Apply via Helm
helm repo add submariner-latest https://submariner-io.github.io/submariner-charts/charts
helm repo update

helm upgrade --install submariner-operator submariner-latest/submariner-operator \
  --namespace submariner-operator \
  --create-namespace \
  --values submariner-operator-values.yaml \
  --kube-context=cluster-a
```

## Labeling Gateway Nodes

Gateway nodes handle all inter-cluster tunnel traffic and require appropriate hardware:

```bash
# Label nodes as gateways in each cluster
# Recommended: dedicated gateway nodes with at least 2 vCPUs and 4GB RAM
# Must have stable external IP addresses or EIP in AWS

kubectl --context=cluster-a label node gw-node-1 submariner.io/gateway=true
kubectl --context=cluster-a label node gw-node-2 submariner.io/gateway=true

kubectl --context=cluster-b label node gw-node-1 submariner.io/gateway=true
kubectl --context=cluster-b label node gw-node-2 submariner.io/gateway=true

# Taint gateway nodes to prevent regular workloads
kubectl --context=cluster-a taint node gw-node-1 \
  submariner.io/gateway=true:NoSchedule

# Verify gateway nodes
subctl show gateways --context=cluster-a
# CLUSTER     NODE        HA STATUS    HEALTH STATUS   CONNECTIONS
# cluster-a   gw-node-1   active       healthy         1
# cluster-a   gw-node-2   passive      healthy         0
```

## Service Export and Import

Submariner implements the KEP-1645 multi-cluster services API. Services must be explicitly exported from a source cluster before they can be discovered in other clusters.

### Exporting a Service

```yaml
# In cluster-a: export the user-service
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: user-service
  namespace: production
---
apiVersion: v1
kind: Service
metadata:
  name: user-service
  namespace: production
spec:
  selector:
    app: user-service
  ports:
  - name: http
    port: 8080
    targetPort: 8080
  - name: grpc
    port: 9090
    targetPort: 9090
```

```bash
# Apply the export
kubectl --context=cluster-a apply -f user-service-export.yaml

# Verify the ServiceExport was accepted
kubectl --context=cluster-a get serviceexport user-service -n production
# NAME           AGE   VALID   REASON   MESSAGE
# user-service   2m    True

# Lighthouse creates a ServiceImport in all other clusters
kubectl --context=cluster-b get serviceimport user-service -n production
# NAME           TYPE           IP                 AGE
# user-service   ClusterSetIP   242.0.200.12       3m
```

### DNS Resolution

Lighthouse configures CoreDNS to resolve the multi-cluster DNS format:

```bash
# From a pod in cluster-b, resolve the exported service:
# Format: <service>.<namespace>.svc.<clusterset-domain>

# Resolve to the Cluster A endpoint
nslookup user-service.production.svc.clusterset.local
# Server: 10.100.0.10
# Address: 10.100.0.10#53
# Name: user-service.production.svc.clusterset.local
# Address: 242.0.200.12   <-- GlobalNet IP assigned to user-service in cluster-a

# Resolve to a specific cluster's service
nslookup cluster-a.user-service.production.svc.clusterset.local
# Address: 242.0.200.12

nslookup cluster-b.user-service.production.svc.clusterset.local
# Address: 242.0.200.45   <-- If user-service also runs in cluster-b
```

### CoreDNS Integration

```yaml
# submariner-coredns-configmap.yaml
# Applied in each member cluster to enable clusterset DNS
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
        # Forward clusterset DNS to Lighthouse DNS server
        clusterset.local:53 {
            forward . 10.96.0.53    # Lighthouse CoreDNS service IP
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

## Verifying Connectivity

```bash
# Run Submariner connectivity diagnostics
subctl diagnose all --context=cluster-a

# Test pod-to-pod connectivity between clusters
# Create a test pod in cluster-b
kubectl --context=cluster-b run test-pod \
  --image=busybox:1.36 \
  --restart=Never \
  --command -- sleep 3600

# Get a pod IP from cluster-a
POD_IP=$(kubectl --context=cluster-a get pod -n production \
  -l app=user-service \
  -o jsonpath='{.items[0].status.podIP}')

# Ping from cluster-b to cluster-a pod
kubectl --context=cluster-b exec test-pod -- ping -c 3 "${POD_IP}"

# Test service DNS resolution
kubectl --context=cluster-b exec test-pod -- \
  wget -qO- http://user-service.production.svc.clusterset.local:8080/health

# Run official Submariner connectivity test
subctl verify \
  --context=cluster-a \
  --tocontext=cluster-b \
  --verbose
```

## GlobalNet for Overlapping CIDRs

When existing clusters have overlapping pod/service CIDRs (a common situation in brownfield environments), GlobalNet provides NAT-based connectivity:

```bash
# GlobalNet assigns a global IP range (e.g., 242.0.0.0/8)
# Each cluster gets a /16 subnet within the global range

# After GlobalNet deployment, check global IP assignments
kubectl --context=cluster-a get globalingressips -n production
# NAME                 IP              ALLOCATED   SERVICE       NAMESPACE
# user-service-gip     242.0.200.12    true        user-service  production

kubectl --context=cluster-b get globalingressips -n production
# NAME                 IP              ALLOCATED   SERVICE       NAMESPACE
# order-service-gip    242.1.100.8     true        order-service production

# Traffic flow with GlobalNet:
# Pod in cluster-b (10.245.1.5) → GlobalNet IP 242.0.200.12
# → Cluster-b gateway translates to tunnel packet
# → Cluster-a gateway receives, looks up GlobalNet IP mapping
# → DNAT to actual pod IP 10.244.1.20
```

## High Availability Gateway Configuration

```yaml
# Deploy HA gateway nodes with active-passive failover
apiVersion: v1
kind: ConfigMap
metadata:
  name: submariner-gateway-ha
  namespace: submariner
data:
  HA_CONFIG: |
    ha_mode: active-passive
    failover_threshold: 3
    healthcheck_interval: 10s
    recovery_timeout: 60s
```

```bash
# Monitor gateway health
watch -n 5 kubectl --context=cluster-a get gateways -n submariner

# Simulate gateway failover
kubectl --context=cluster-a cordon gw-node-1
kubectl --context=cluster-a delete pod -n submariner \
  -l app=submariner-gateway \
  --field-selector spec.nodeName=gw-node-1

# Active gateway should shift to gw-node-2 within ~30 seconds
kubectl --context=cluster-a get gateways -n submariner
# NAME        HA STATUS    CONNECTION STATUS
# gw-node-1   passive      connected
# gw-node-2   active       connected
```

## Prometheus Monitoring

```yaml
# submariner-alerts.yaml
groups:
- name: submariner
  rules:
  - alert: SubmarinerConnectionDown
    expr: |
      submariner_connections{status="error"} > 0
    for: 2m
    labels:
      severity: critical
      team: platform
    annotations:
      summary: "Submariner connection error from {{ $labels.cluster_id }} to {{ $labels.remote_cluster_id }}"
      description: "Inter-cluster tunnel is down. Cross-cluster service calls will fail."
      runbook: "https://runbooks.support.tools/submariner-connection-down"

  - alert: SubmarinerGatewayNotActive
    expr: |
      submariner_gateway_count{ha_status="active"} == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "No active Submariner gateway in cluster {{ $labels.cluster_id }}"

  - alert: SubmarinerGatewayLatencyHigh
    expr: |
      submariner_gateway_rx_bytes_total == 0
      and
      submariner_gateway_tx_bytes_total == 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "No inter-cluster traffic through Submariner gateway"
      description: "Gateway may be misconfigured or service exports may be missing."
```

## Troubleshooting Common Issues

```bash
# Issue 1: Connection stuck in "connecting" state
# Check IPsec/Libreswan logs on gateway node
kubectl --context=cluster-a logs -n submariner \
  -l app=submariner-gateway \
  --container submariner-gateway | grep -i "ipsec\|connecting\|error"

# Issue 2: DNS resolution not working
# Check Lighthouse CoreDNS pod
kubectl --context=cluster-b get pods -n submariner \
  -l app=submariner-lighthouse-coredns

kubectl --context=cluster-b logs -n submariner \
  -l app=submariner-lighthouse-coredns

# Issue 3: Route agent not programming routes
kubectl --context=cluster-a logs -n submariner \
  -l app=submariner-routeagent \
  --container submariner-route-agent | grep -i "error\|route"

# Verify routes are installed on worker nodes
kubectl --context=cluster-a exec -n submariner \
  -l app=submariner-routeagent \
  -- ip route show | grep "10.245"
# 10.245.0.0/16 via 192.168.1.100 dev vxlan0  <-- Route to cluster-b

# Issue 4: ServiceExport stuck in NotValid state
kubectl --context=cluster-a describe serviceexport user-service -n production
# Look for: "ServiceExportConflict" or "NoPortConflict"

# Validate the exported service has endpoints
kubectl --context=cluster-a get endpoints user-service -n production
```

Submariner's broker model, encrypted tunnels, and Lighthouse DNS integration provide a battle-tested foundation for multi-cluster Kubernetes deployments. The combination of GlobalNet for CIDR conflict resolution, HA gateways for tunnel resilience, and standard Kubernetes CRDs for service discovery makes it suitable for enterprise environments where cluster sprawl demands a structured connectivity solution.
