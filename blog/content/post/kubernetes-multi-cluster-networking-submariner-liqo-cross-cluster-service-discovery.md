---
title: "Kubernetes Multi-Cluster Networking: Submariner and Liqo for Cross-Cluster Service Discovery"
date: 2030-08-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Cluster", "Submariner", "Liqo", "Networking", "Service Discovery", "Federation"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise multi-cluster networking covering Submariner architecture and deployment, service export and import, cross-cluster DNS resolution, Liqo virtual node peering, and building globally distributed applications across Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-multi-cluster-networking-submariner-liqo-cross-cluster-service-discovery/"
---

As organizations scale beyond single-cluster Kubernetes deployments, connecting workloads across clusters becomes a critical infrastructure challenge. Whether driven by geographic distribution, fault isolation, cloud provider diversity, or regulatory data residency requirements, multi-cluster architectures require solutions for cross-cluster networking, service discovery, and workload placement. Submariner and Liqo represent two complementary approaches: Submariner focuses on L3 network connectivity and service discovery between clusters, while Liqo extends the Kubernetes API to schedule workloads transparently across cluster boundaries.

<!--more-->

## Multi-Cluster Networking Architecture Patterns

Before diving into tools, understanding the architectural options clarifies which solution fits a given requirement:

| Pattern | Description | Tools |
|---------|-------------|-------|
| L3 Mesh | IPsec/WireGuard tunnels between cluster networks | Submariner, Cilium Cluster Mesh |
| Service Mirroring | Remote services appear as local | Submariner ServiceExport, Linkerd multicluster |
| Virtual Nodes | Remote cluster's nodes appear in local scheduler | Liqo, Virtual Kubelet |
| Federation | API-level resource replication | Liqo, KubeFed |
| Shared Control Plane | Single API server, multiple data planes | Karmada, OCM |

## Submariner Architecture

Submariner creates an encrypted network overlay connecting pod and service CIDRs across clusters. It consists of several components:

- **Gateway Node**: IPsec or WireGuard tunnel endpoints on each cluster
- **Route Agent**: Programs routes on non-gateway nodes to reach remote CIDRs
- **Broker**: A Kubernetes cluster that acts as the control plane rendezvous point for cluster metadata
- **Globalnet**: Optional CIDR conflict resolution using global IP space
- **Lighthouse**: DNS-based service discovery for cross-cluster services

```
Cluster A (10.96.0.0/12 services, 10.244.0.0/16 pods)
  └─ Gateway Node ←──── IPsec/WireGuard ────→ Gateway Node
                                               Cluster B (10.98.0.0/12 services, 10.245.0.0/16 pods)
```

## Submariner Deployment

### Prerequisites

```bash
# Requirements:
# - Non-overlapping pod CIDRs between clusters
# - Non-overlapping service CIDRs between clusters
# - UDP 4500 open between gateway nodes (IPsec NAT-T)
# - UDP 4490 open between gateway nodes (Submariner cable driver)
# - TCP 443 open to broker cluster API server

# Install subctl (Submariner CLI)
curl -Ls https://get.submariner.io | VERSION=v0.17.0 bash
export PATH=$PATH:~/.local/bin

# Verify clusters
kubectl config get-contexts
# Output should show: cluster-a, cluster-b, broker-cluster
```

### Broker Cluster Setup

The broker cluster stores shared metadata. It does not need to host workloads:

```bash
# Deploy broker on the designated broker cluster
subctl deploy-broker \
    --kubeconfig ~/.kube/broker.yaml \
    --service-discovery

# This creates:
# - Namespace: submariner-k8s-broker
# - RBAC for clusters to join
# - Stores broker connection info in broker-info.subm file
ls -la broker-info.subm
```

### Joining Clusters to the Broker

```bash
# Join cluster-a to the broker
subctl join broker-info.subm \
    --kubeconfig ~/.kube/cluster-a.yaml \
    --clusterid cluster-a \
    --natt=true \
    --cable-driver wireguard \
    --label-gateway=true  # Will prompt to label a gateway node

# Join cluster-b to the broker
subctl join broker-info.subm \
    --kubeconfig ~/.kube/cluster-b.yaml \
    --clusterid cluster-b \
    --natt=true \
    --cable-driver wireguard

# Verify the join
subctl show all --kubeconfig ~/.kube/cluster-a.yaml
```

### Gateway Node Selection

For production, designate specific nodes as gateway nodes to control where IPsec/WireGuard tunnel endpoints land:

```bash
# Label specific nodes as Submariner gateways on each cluster
# cluster-a
kubectl --context cluster-a label node node-01 \
    submariner.io/gateway=true

# cluster-b
kubectl --context cluster-b label node node-05 \
    submariner.io/gateway=true

# For HA gateways (active-passive failover)
kubectl --context cluster-a label node node-01 node-02 \
    submariner.io/gateway=true

# View gateway status
kubectl --context cluster-a get gateway -n submariner-operator
```

### Installing via Helm

For GitOps-managed deployments:

```yaml
# cluster-a/submariner-values.yaml
submariner:
  clusterCidr: "10.244.0.0/16"
  serviceCidr: "10.96.0.0/12"
  clusterID: "cluster-a"
  broker: "k8s"
  ceIPSecPSK: "<pre-shared-key-base64-encoded>"
  brokerURL: "https://broker.platform.io:6443"
  nattPort: 4500
  cableDriver: "wireguard"
  natEnabled: true

serviceAccounts:
  globalnet:
    create: true

ipsec:
  debug: false
  ikePort: 500
  natPort: 4500

globalnet:
  enabled: false  # Enable only when CIDRs overlap

lighthouse:
  enabled: true

serviceDiscovery:
  enabled: true
```

```bash
# Install via Helm
helm repo add submariner-latest https://submariner-io.github.io/submariner-charts/charts
helm repo update

helm install submariner-operator submariner-latest/submariner-operator \
    --namespace submariner-operator \
    --create-namespace \
    --values cluster-a/submariner-values.yaml
```

## Service Export and Import with Submariner Lighthouse

Submariner Lighthouse enables cross-cluster service discovery using the MCS (Multi-Cluster Services) API.

### Exporting a Service

To make a service in cluster-a accessible from cluster-b, export it:

```yaml
# In cluster-a: Deploy the service
apiVersion: v1
kind: Service
metadata:
  name: order-service
  namespace: ecommerce
spec:
  selector:
    app: order-service
  ports:
    - port: 8080
      targetPort: 8080
---
# Export the service using Submariner ServiceExport
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: order-service
  namespace: ecommerce
```

```bash
# Apply to cluster-a
kubectl --context cluster-a apply -f order-service-export.yaml

# Verify the export was acknowledged
kubectl --context cluster-a get serviceexport order-service -n ecommerce
# Status: Exported: True

# Submariner creates a ServiceImport in cluster-b automatically
kubectl --context cluster-b get serviceimport -n ecommerce
# NAME            TYPE           IP                          AGE
# order-service   ClusterSetIP   10.98.100.23                5m
```

### Cross-Cluster DNS Resolution

Lighthouse configures CoreDNS to resolve cross-cluster services. The DNS format is:

```
<service>.<namespace>.svc.clusterset.local
```

```bash
# Test from a pod in cluster-b
kubectl --context cluster-b run dns-test \
    --image=busybox:1.36 \
    --restart=Never \
    --rm -it \
    -- nslookup order-service.ecommerce.svc.clusterset.local

# Expected output:
# Server:    10.98.0.10
# Address 1: 10.98.0.10 kube-dns.kube-system.svc.cluster.local
# Name:      order-service.ecommerce.svc.clusterset.local
# Address 1: 10.98.100.23 order-service.ecommerce.svc.clusterset.local

# Test connectivity
kubectl --context cluster-b run curl-test \
    --image=curlimages/curl:8.5.0 \
    --restart=Never \
    --rm -it \
    -- curl -s http://order-service.ecommerce.svc.clusterset.local:8080/health
```

### CoreDNS Configuration for Lighthouse

Submariner modifies the CoreDNS ConfigMap to delegate `clusterset.local` to Lighthouse:

```bash
# View Lighthouse's CoreDNS configuration
kubectl --context cluster-b get configmap coredns -n kube-system -o yaml | \
    grep -A 10 "clusterset"

# Expected addition:
# clusterset.local:53 {
#     forward . <lighthouse-dns-service-ip>:53
#     cache 30
# }
```

### Multi-Cluster Service Load Balancing

Exported services support round-robin load balancing across clusters:

```yaml
# Export the same service from multiple clusters
# cluster-a: order-service exported (3 pods)
# cluster-b: order-service exported (2 pods)

# Result: DNS round-robins between cluster-a and cluster-b VIPs
# cluster-b pods calling clusterset.local DNS get both IPs

# For active-active load balancing, clients resolve to multiple IPs
# For active-passive, use annotation to prefer local cluster:
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: order-service
  namespace: ecommerce
  annotations:
    submariner.io/export-local-only: "false"  # Include in global DNS
```

## Globalnet: Overlapping CIDR Resolution

When clusters have overlapping pod or service CIDRs (common in managed clusters), Submariner Globalnet assigns a non-overlapping global IP space:

```bash
# Enable Globalnet during cluster join
subctl join broker-info.subm \
    --kubeconfig ~/.kube/cluster-a.yaml \
    --clusterid cluster-a \
    --globalnet \
    --globalnet-cidr 242.0.0.0/24  # Unique per cluster

subctl join broker-info.subm \
    --kubeconfig ~/.kube/cluster-b.yaml \
    --clusterid cluster-b \
    --globalnet \
    --globalnet-cidr 242.1.0.0/24

# Globalnet assigns each exported service a GlobalEgressIP
kubectl --context cluster-a get globalingressip -n ecommerce
# NAME            IP              ALLOCATED   AGE
# order-service   242.0.0.45      true        5m
```

## Liqo: Virtual Node Cross-Cluster Scheduling

While Submariner focuses on networking, Liqo virtualizes cluster compute resources. Remote clusters appear as virtual nodes in the local cluster's scheduler, enabling workloads to be scheduled transparently across cluster boundaries.

### Liqo Architecture

```
Cluster A (home)
  ├── Real Node: node-01 (CPU: 8, Memory: 32GB)
  ├── Real Node: node-02 (CPU: 8, Memory: 32GB)
  └── Virtual Node: liqo-cluster-b (CPU: 16, Memory: 64GB)  ← Cluster B's resources
       └── Pods appear here, actually run in Cluster B
```

### Liqo Installation

```bash
# Install liqo CLI
curl -sL https://get.liqo.io/liqoctl.sh | bash

# Install Liqo on cluster-a
liqoctl install \
    --kubeconfig ~/.kube/cluster-a.yaml \
    --cluster-id cluster-a \
    --chart-version v0.10.0

# Install Liqo on cluster-b
liqoctl install \
    --kubeconfig ~/.kube/cluster-b.yaml \
    --cluster-id cluster-b \
    --chart-version v0.10.0

# Verify installation
kubectl --context cluster-a get pods -n liqo
```

### Peering Clusters with Liqo

```bash
# Peer cluster-a with cluster-b (bidirectional)
liqoctl peer out-of-band cluster-b \
    --kubeconfig ~/.kube/cluster-a.yaml \
    --remote-kubeconfig ~/.kube/cluster-b.yaml

# Check peering status
liqoctl status \
    --kubeconfig ~/.kube/cluster-a.yaml

# View virtual nodes created by Liqo
kubectl --context cluster-a get nodes
# NAME                    STATUS   ROLES    AGE
# node-01                 Ready    worker   30d
# node-02                 Ready    worker   30d
# liqo-cluster-b          Ready    agent    5m   ← Virtual node

# View virtual node details
kubectl --context cluster-a describe node liqo-cluster-b
```

### Scheduling Workloads to Remote Clusters

Liqo uses virtual node taints and namespace offloading to control workload placement:

```yaml
# Namespace offloading: schedule the entire namespace to remote cluster
apiVersion: offloading.liqo.io/v1alpha1
kind: NamespaceOffloading
metadata:
  name: offloading
  namespace: batch-jobs
spec:
  # Which clusters are eligible
  clusterSelector:
    matchLabels:
      liqo.io/remote-cluster-id: cluster-b
  # How to handle resource names
  namespaceMappingStrategy: EnforceSameName
  # How to distribute pods across clusters
  podOffloadingStrategy: LocalAndRemote  # or Remote or Local
```

```yaml
# Force-schedule specific pods to remote cluster using node selector
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
  namespace: batch-jobs
spec:
  replicas: 10
  selector:
    matchLabels:
      app: batch-processor
  template:
    metadata:
      labels:
        app: batch-processor
    spec:
      # Schedule to the Liqo virtual node
      nodeSelector:
        liqo.io/remote-cluster-id: cluster-b
      tolerations:
        - key: liqo.io/remote-cluster
          operator: Exists
          effect: NoExecute
      containers:
        - name: processor
          image: myregistry/batch-processor:2.1.0
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
```

### Liqo Resource Reflection

When pods are scheduled to virtual nodes, Liqo creates shadow pods and mirrors resources:

```bash
# Pod in cluster-a scheduled to liqo-cluster-b virtual node
kubectl --context cluster-a get pod batch-processor-xyz \
    -n batch-jobs -o wide
# NAME                   READY   STATUS    NODE
# batch-processor-xyz    1/1     Running   liqo-cluster-b  ← Virtual node

# Actual pod runs in cluster-b as an offloaded pod
kubectl --context cluster-b get pod \
    -n liqo-cluster-a-batch-jobs \
    -l liqo.io/origin-pod-name=batch-processor-xyz

# Logs flow through cluster-a's API server transparently
kubectl --context cluster-a logs batch-processor-xyz -n batch-jobs
```

### Cross-Cluster Service Connectivity with Liqo

Liqo can be combined with Submariner for networking:

```bash
# Install Submariner for L3 connectivity
# Install Liqo for compute federation
# Services exported via Submariner are accessible to offloaded pods

# Verify offloaded pod can reach cluster-a services
kubectl --context cluster-b exec \
    -n liqo-cluster-a-batch-jobs \
    liqo-batch-processor-xyz \
    -- curl http://order-service.ecommerce.svc.clusterset.local:8080/health
```

## Multi-Cluster DNS Federation

A complete multi-cluster DNS setup combines several layers:

```yaml
# CoreDNS configuration for multi-cluster DNS
# coredns-configmap.yaml
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
        # Local cluster DNS
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
        }
        # Cross-cluster services via Submariner Lighthouse
        clusterset.local:53 {
            forward . 10.98.100.50:53   # Lighthouse DNS service
            cache 30
            log
        }
        # Remote cluster's own DNS (for direct resolution)
        cluster-b.local:53 {
            forward . 192.168.10.100:53  # Cluster B's CoreDNS
            cache 60
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

### ExternalDNS for Multi-Cluster

ExternalDNS can propagate service DNS entries across clusters:

```yaml
# external-dns deployment for multi-cluster
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
          image: registry.k8s.io/external-dns/external-dns:v0.14.2
          args:
            - --source=service
            - --source=ingress
            - --provider=cloudflare
            - --cloudflare-proxied=false
            # Multi-cluster annotation to avoid conflicts
            - --annotation-filter=external-dns.alpha.kubernetes.io/cluster-id=cluster-a
            - --domain-filter=platform.example.com
            - --registry=txt
            - --txt-owner-id=cluster-a
```

## Verifying Multi-Cluster Connectivity

### Submariner Connectivity Validation

```bash
# Run Submariner's built-in connectivity check
subctl verify \
    --kubeconfig ~/.kube/cluster-a.yaml \
    --toconfig ~/.kube/cluster-b.yaml \
    --verbose

# Check specific connectivity
subctl diagnose all \
    --kubeconfig ~/.kube/cluster-a.yaml

# View gateway connection status
kubectl --context cluster-a get gateway -n submariner-operator -o yaml
# spec:
#   connections:
#   - endpoint:
#       cluster_id: cluster-b
#       hostname: node-05
#       public_ip: 1.2.3.4
#       subnets:
#       - 10.245.0.0/16
#       - 10.98.0.0/12
#     status: connected
#     statusMessage: "connected"

# Check route agent status
kubectl --context cluster-a get pod \
    -n submariner-operator \
    -l app=submariner-routeagent \
    -o wide
```

### End-to-End Connectivity Test

```bash
# Deploy test pods in both clusters
kubectl --context cluster-a run nettest \
    --image=nicolaka/netshoot:v0.12 \
    -n default \
    --restart=Never \
    -- sleep infinity

kubectl --context cluster-b run nettest-target \
    --image=nginx:1.25 \
    -n default \
    --restart=Never

# Get cluster-b pod IP
CLUSTER_B_POD_IP=$(kubectl --context cluster-b get pod nettest-target \
    -o jsonpath='{.status.podIP}')

# Ping from cluster-a to cluster-b pod (tests L3 tunnel)
kubectl --context cluster-a exec nettest \
    -- ping -c 3 $CLUSTER_B_POD_IP

# Test service DNS resolution
kubectl --context cluster-a exec nettest \
    -- nslookup nettest-target.default.svc.clusterset.local

# Test HTTP connectivity
kubectl --context cluster-a exec nettest \
    -- curl http://nettest-target.default.svc.clusterset.local
```

## Building Globally Distributed Applications

### Active-Active Multi-Region Deployment

```yaml
# Deploy in both clusters with preference for local
# cluster-a/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: platform
  annotations:
    liqo.io/scheduling-enabled: "false"  # Don't offload this deployment
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: api-gateway
          image: myregistry/api-gateway:3.0.0
          env:
            - name: CLUSTER_ID
              value: cluster-a
            - name: REGION
              value: us-east-1
            # Service discovery via clusterset.local DNS
            - name: ORDER_SERVICE_URL
              value: http://order-service.ecommerce.svc.clusterset.local:8080
            - name: INVENTORY_SERVICE_URL
              value: http://inventory-service.ecommerce.svc.clusterset.local:8080
---
# Export api-gateway from both clusters
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: api-gateway
  namespace: platform
```

### Traffic Locality Preference

For latency-sensitive workloads, prefer local cluster services but fall back to remote:

```go
// internal/httpclient/multicluster.go
package httpclient

import (
    "context"
    "fmt"
    "net/http"
    "os"
    "time"
)

// MultiClusterClient prefers local service endpoints, falls back to clusterset.
type MultiClusterClient struct {
    clusterID  string
    httpClient *http.Client
}

func NewMultiClusterClient(clusterID string) *MultiClusterClient {
    return &MultiClusterClient{
        clusterID: clusterID,
        httpClient: &http.Client{
            Timeout: 10 * time.Second,
        },
    }
}

func (c *MultiClusterClient) Get(ctx context.Context, service, namespace, path string) (*http.Response, error) {
    // Try local cluster first
    localURL := fmt.Sprintf("http://%s.%s.svc.cluster.local%s", service, namespace, path)
    resp, err := c.httpClient.Get(localURL)
    if err == nil && resp.StatusCode < 500 {
        return resp, nil
    }

    // Fall back to clusterset (any cluster)
    clustersetURL := fmt.Sprintf("http://%s.%s.svc.clusterset.local%s", service, namespace, path)
    return c.httpClient.Get(clustersetURL)
}
```

## Monitoring Multi-Cluster Connectivity

### Prometheus Multi-Cluster Metrics

```yaml
# Submariner exposes Prometheus metrics
# submariner-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: submariner-gateway
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: submariner-gateway
  namespaceSelector:
    matchNames:
      - submariner-operator
  endpoints:
    - port: metrics
      interval: 30s
```

Key Submariner metrics:

```promql
# Gateway connection status (1=connected, 0=disconnected)
submariner_gateway_connections{status="connected"}

# Tunnel latency between clusters
submariner_gateway_latency_seconds

# Bytes transmitted between clusters
rate(submariner_gateway_rx_bytes[5m])
rate(submariner_gateway_tx_bytes[5m])

# Failed cross-cluster service resolutions
rate(lighthouse_dns_request_duration_seconds_count{code!="NOERROR"}[5m])
```

### Alerting Rules

```yaml
# multi-cluster-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: multi-cluster-alerts
  namespace: monitoring
spec:
  groups:
    - name: submariner
      rules:
        - alert: SubmarinerGatewayDisconnected
          expr: submariner_gateway_connections == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Submariner gateway disconnected: {{ $labels.remote_cluster }}"
            description: "No active tunnel to cluster {{ $labels.remote_cluster }}. Cross-cluster traffic will fail."
            runbook_url: "https://wiki.platform.io/runbooks/submariner-gateway-down"

        - alert: SubmarinerHighTunnelLatency
          expr: |
            submariner_gateway_latency_seconds > 0.050
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High latency to cluster {{ $labels.remote_cluster }}: {{ $value * 1000 }}ms"

        - alert: CrossClusterDNSFailures
          expr: |
            rate(lighthouse_dns_request_duration_seconds_count{
              code=~"SERVFAIL|NXDOMAIN"
            }[5m]) > 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cross-cluster DNS failures detected"
```

## Operational Considerations

### Certificate Management Across Clusters

Submariner uses pre-shared keys or certificates for IPsec/WireGuard tunnels. Rotation should be automated:

```bash
# Rotate Submariner IPsec PSK
# Generate new PSK
NEW_PSK=$(openssl rand -base64 64 | tr -d '\n')

# Update the secret in all clusters
for ctx in cluster-a cluster-b; do
    kubectl --context $ctx \
        create secret generic submariner-ipsec-psk \
        --from-literal=psk="$NEW_PSK" \
        -n submariner-operator \
        --dry-run=client -o yaml | \
        kubectl --context $ctx apply -f -
done

# Restart gateways to pick up new PSK
kubectl --context cluster-a rollout restart \
    deployment/submariner-gateway \
    -n submariner-operator
```

### Disaster Recovery for Broker

The Submariner broker is a critical dependency. Back it up and plan for its recovery:

```bash
# Backup broker state
kubectl --context broker get \
    -n submariner-k8s-broker \
    brokers,endpoints,clusters,gateways \
    -o yaml > broker-backup-$(date +%Y%m%d).yaml

# The broker can be rebuilt from scratch if clusters are accessible
# Existing tunnels continue to function without the broker
# (Broker is only needed for initial setup and metadata sync)
```

## Summary

Multi-cluster Kubernetes networking with Submariner and Liqo enables organizations to distribute workloads globally while maintaining service connectivity and discovery. Submariner provides the foundational L3 mesh networking and service discovery layer through WireGuard/IPsec tunnels and Lighthouse DNS, implementing the Multi-Cluster Services API for standardized cross-cluster service access. Liqo complements this by virtualizing compute resources from remote clusters, enabling the Kubernetes scheduler to place workloads across cluster boundaries transparently. Together, these tools provide the building blocks for globally distributed applications that span multiple cloud providers, regions, or organizational boundaries — with the operational familiarity of standard Kubernetes APIs and the observability infrastructure needed to maintain them in production.
