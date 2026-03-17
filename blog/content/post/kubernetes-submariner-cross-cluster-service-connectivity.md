---
title: "Kubernetes Submariner: Cross-Cluster Service Connectivity Without VPN Overlays"
date: 2031-04-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Submariner", "Multi-Cluster", "Networking", "Service Mesh", "DNS", "Globalnet"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes Submariner covering gateway node and broker architecture, ClusterSet service import/export, Lighthouse DNS for cross-cluster name resolution, Globalnet for overlapping CIDR management, cable driver selection between libreswan and VXLAN, and systematic troubleshooting of cross-cluster connectivity."
more_link: "yes"
url: "/kubernetes-submariner-cross-cluster-service-connectivity/"
---

Submariner enables direct network connectivity between Kubernetes clusters without requiring a traditional VPN overlay, service mesh federation, or manual BGP configuration. It connects cluster Pod and Service networks through encrypted tunnels between gateway nodes, enabling services to communicate across cluster boundaries using standard DNS. This guide covers the complete deployment: broker setup, gateway configuration, ClusterSet service export/import, Lighthouse DNS integration, Globalnet for overlapping CIDRs, and cable driver selection for different network environments.

<!--more-->

# Kubernetes Submariner: Cross-Cluster Service Connectivity Without VPN Overlays

## Section 1: Architecture Overview

Submariner consists of several components that work together to establish cross-cluster connectivity:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cluster A (us-east-1)                        │
│  Pod CIDR: 10.244.0.0/16  Service CIDR: 10.96.0.0/12           │
│                                                                  │
│  ┌────────────┐   ┌────────────┐   ┌────────────────────────┐  │
│  │  Gateway   │   │   Route    │   │   Lighthouse           │  │
│  │  Node      │   │   Agent    │   │   Agent                │  │
│  │ (tunnel    │   │ (routes    │   │ (DNS for cross-cluster │  │
│  │  endpoint) │   │  per node) │   │  service resolution)   │  │
│  └─────┬──────┘   └────────────┘   └────────────────────────┘  │
│        │ IPsec/VXLAN tunnel                                     │
└────────┼────────────────────────────────────────────────────────┘
         │
         │ Encrypted tunnel (IPsec ESP / VXLAN)
         │
┌────────┼────────────────────────────────────────────────────────┐
│        │             Cluster B (eu-west-1)                      │
│  Pod CIDR: 10.245.0.0/16  Service CIDR: 10.97.0.0/12           │
│                                                                  │
│  ┌─────┴──────┐   ┌────────────┐   ┌────────────────────────┐  │
│  │  Gateway   │   │   Route    │   │   Lighthouse           │  │
│  │  Node      │   │   Agent    │   │   Agent                │  │
│  └────────────┘   └────────────┘   └────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Broker Cluster                                  │
│  (can be a dedicated cluster or one of the above)               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Broker CRDs:                                            │   │
│  │  - Endpoints (gateway node info)                         │   │
│  │  - Clusters (cluster metadata)                           │   │
│  │  - GlobalIngressIPs                                      │   │
│  │  - ServiceExports / ServiceImports (ClusterSet)          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Component Roles

- **Gateway**: Terminates IPsec/VXLAN tunnels, routes cross-cluster traffic
- **Route Agent**: Configures routing table entries on non-gateway nodes to direct cross-cluster traffic to the gateway
- **Broker**: Kubernetes cluster hosting CRDs that store topology information (endpoints, clusters)
- **Lighthouse Agent**: Watches ServiceExport CRDs and syncs service information to the broker
- **Lighthouse DNS Plugin**: CoreDNS plugin that resolves `service.namespace.svc.clusterset.local` DNS names

## Section 2: Prerequisites and Planning

### CIDR Planning

Before deploying Submariner, ensure your clusters have non-overlapping CIDRs. If they do overlap, use Globalnet (covered in Section 6).

```bash
# Check existing CIDRs in each cluster

# Cluster A
kubectl --context cluster-a get nodes -o jsonpath='{.items[0].spec.podCIDR}'
kubectl --context cluster-a get configmap -n kube-system kubeadm-config \
  -o jsonpath='{.data.ClusterConfiguration}' | grep -E "podSubnet|serviceSubnet"

# Or for kubeadm clusters
kubectl --context cluster-a get cm -n kube-system kubeadm-config -o yaml | \
  grep -A5 networking

# Cluster B
kubectl --context cluster-b get nodes -o jsonpath='{.items[0].spec.podCIDR}'
```

### Network Requirements

```
Required firewall rules for Submariner:

Gateway nodes MUST be reachable on:
- UDP 4500 (IPsec NAT-T, used by libreswan cable driver)
- UDP 4800 (Submariner metrics)
- TCP 8080 (health check)

For VXLAN cable driver:
- UDP 4800 (Submariner tunnel)
- UDP 4500 (optional, for metadata)

Between gateway nodes:
- All ports open (IPsec negotiates its own protocols)
- ICMP recommended for MTU discovery

Note: Non-gateway nodes only need routes to gateway,
no special firewall rules required
```

### Label Gateway Nodes

```bash
# Submariner requires designated gateway nodes
# Gateway nodes need public IPs or NAT traversal capability

# Cluster A gateway node
kubectl --context cluster-a label node worker-node-1 \
  submariner.io/gateway=true

# Cluster B gateway node
kubectl --context cluster-b label node worker-node-1 \
  submariner.io/gateway=true

# Verify labels
kubectl --context cluster-a get nodes -l submariner.io/gateway=true
kubectl --context cluster-b get nodes -l submariner.io/gateway=true
```

## Section 3: Submariner Installation with subctl

### Install subctl CLI

```bash
# Install subctl
curl -Ls https://get.submariner.io | bash

# Or via package manager
brew install submariner-io/tap/subctl  # macOS

# Verify
subctl version
```

### Deploy the Broker

The broker can be deployed on a dedicated management cluster or on one of the workload clusters:

```bash
# Deploy broker on the management/broker cluster
# This creates the necessary CRDs and RBAC
subctl deploy-broker \
  --kubeconfig ~/.kube/broker-kubeconfig \
  --globalnet \
  --globalnet-cidr-range 242.0.0.0/8 \
  --default-globalnet-cluster-size 65536

# This generates broker-info.subm file with:
# - Broker API endpoint
# - Service account credentials
# - CA certificate for TLS
ls broker-info.subm
```

### Join Cluster A to the Broker

```bash
# Join Cluster A
# This installs Submariner components and establishes tunnel
subctl join broker-info.subm \
  --kubeconfig ~/.kube/cluster-a-kubeconfig \
  --clusterid cluster-a \
  --cable-driver libreswan \
  --coredns-custom-configmap kube-system/coredns \
  --natt=true \
  --nattport=4500 \
  --ikeport=500 \
  --health-check=true

# Verify Cluster A components
kubectl --context cluster-a get pods -n submariner-operator
# NAME                                            READY   STATUS    RESTARTS   AGE
# submariner-gateway-xxxxx                        1/1     Running   0          2m
# submariner-routeagent-xxxxx                     1/1     Running   0          2m
# submariner-metrics-proxy-xxxxx                  1/1     Running   0          2m
# submariner-operator-xxxxx                       1/1     Running   0          2m
# submariner-lighthouse-agent-xxxxx               1/1     Running   0          2m
# submariner-lighthouse-coredns-xxxxx             1/1     Running   0          2m
```

### Join Cluster B to the Broker

```bash
subctl join broker-info.subm \
  --kubeconfig ~/.kube/cluster-b-kubeconfig \
  --clusterid cluster-b \
  --cable-driver libreswan \
  --coredns-custom-configmap kube-system/coredns \
  --natt=true \
  --nattport=4500

# Verify cross-cluster connectivity immediately
subctl verify \
  --kubeconfig ~/.kube/cluster-a-kubeconfig \
  --toconfig ~/.kube/cluster-b-kubeconfig \
  --only connectivity,service-discovery
```

## Section 4: Manual Helm Deployment

For production environments where subctl is not suitable:

```yaml
# submariner-operator-values.yaml
operator:
  repository: quay.io/submariner
  tag: "0.16.0"

submariner:
  repository: quay.io/submariner
  tag: "0.16.0"

  cableDriver: libreswan  # or vxlan, wireguard

  # Cluster-specific settings
  clusterCidr: "10.244.0.0/16"
  serviceCidr: "10.96.0.0/12"
  clusterID: "cluster-a"
  colorCodes: "blue"  # Unused but required

  # Nat traversal
  natEnabled: true
  healthCheckEnabled: true
  healthCheckInterval: 1
  healthCheckMaxPacketLossCount: 5

  # Debug
  debug: false

broker:
  # Reference to broker cluster's API server
  server: "https://broker.example.com:6443"
  token: "<broker-service-account-token>"  # Use sealed secret in production
  ca: "<base64-encoded-tls-certificate>"
  namespace: "submariner-k8s-broker"
  globalnet: true

serviceAccounts:
  globalnet:
    create: true
  lighthouseAgent:
    create: true
  lighthouseCoreDns:
    create: true

# Resource configuration
gateway:
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

routeAgent:
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 128Mi
```

```bash
helm repo add submariner https://submariner-io.github.io/submariner-charts/charts
helm repo update

helm install submariner-operator submariner/submariner-operator \
  --namespace submariner-operator \
  --create-namespace \
  -f submariner-operator-values.yaml
```

## Section 5: ClusterSet Service Export and Import

Submariner implements the Kubernetes ClusterSet service discovery model via ServiceExport and ServiceImport CRDs.

### Exporting a Service

```yaml
# Deploy a service in Cluster A
apiVersion: v1
kind: Service
metadata:
  name: user-service
  namespace: api
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
  type: ClusterIP
---
# Export the service for cross-cluster discovery
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: user-service
  namespace: api
# No spec needed - just creating the CR triggers export
```

```bash
# Apply the ServiceExport
kubectl --context cluster-a apply -f user-service-export.yaml

# Verify export was registered on the broker
kubectl --context broker \
  get serviceimport -n submariner-k8s-broker

# Check lighthouse agent synced it
kubectl --context cluster-a logs -n submariner-operator \
  -l app=submariner-lighthouse-agent | tail -20
```

### Viewing ServiceImports in Cluster B

After exporting, Submariner automatically creates ServiceImport resources in the other connected clusters:

```bash
# View the ServiceImport in Cluster B
kubectl --context cluster-b get serviceimport -n api

# NAME           TYPE           IP                  AGE
# user-service   ClusterSetIP   [242.0.10.1]        5m

# Get full details
kubectl --context cluster-b describe serviceimport user-service -n api
# Name:         user-service
# Namespace:    api
# Annotations:
#   multicluster.x-k8s.io/service-ip: 242.0.10.1
# Spec:
#   Ports:
#     - Name: http
#       Port: 8080
#       Protocol: TCP
#     - Name: grpc
#       Port: 9090
#       Protocol: TCP
#   Type: ClusterSetIP
# Status:
#   Clusters:
#     - Cluster: cluster-a
```

### DNS Resolution with Lighthouse

Once exported, services are accessible via DNS in other clusters:

```bash
# DNS format: <service>.<namespace>.svc.clusterset.local
# This resolves in ALL connected clusters

# From a pod in Cluster B, resolve the exported service:
kubectl --context cluster-b run -it --rm dns-test \
  --image=busybox --restart=Never -- \
  sh -c "nslookup user-service.api.svc.clusterset.local"

# Expected output:
# Server:    10.96.0.10
# Address 1: 10.96.0.10 kube-dns.kube-system.svc.cluster.local
#
# Name:      user-service.api.svc.clusterset.local
# Address 1: 242.0.10.1 user-service.api.svc.cluster-a.local

# Test HTTP connectivity
kubectl --context cluster-b run -it --rm http-test \
  --image=curlimages/curl --restart=Never -- \
  curl http://user-service.api.svc.clusterset.local:8080/health
```

### CoreDNS Configuration for Lighthouse

Submariner automatically modifies CoreDNS to add the clusterset.local zone, but you can verify and customize:

```yaml
# Verify Lighthouse CoreDNS configuration
kubectl --context cluster-a get configmap coredns-custom -n kube-system -o yaml

# Expected addition to Corefile:
# clusterset.local:53 {
#     forward . <lighthouse-coredns-service-ip>
# }
```

## Section 6: Globalnet for Overlapping CIDRs

When clusters have overlapping Pod or Service CIDRs (common with many cloud providers), Globalnet assigns unique global IPs that route correctly across clusters:

```yaml
# Check Globalnet configuration
kubectl --context broker get globalnetcidrconfig -n submariner-k8s-broker

# View cluster CIDR allocations
kubectl --context broker get clusters -n submariner-k8s-broker -o yaml
# spec:
#   global_cidr:
#     - 242.0.0.0/24    # Cluster A global CIDR
#
# And for Cluster B:
#   global_cidr:
#     - 242.0.1.0/24    # Cluster B global CIDR
```

### GlobalIngressIP and GlobalEgressIP

```bash
# When Globalnet is enabled, services get Global IPs
kubectl --context cluster-a get globalingressip -n api
# NAME                  IP             AGE
# user-service          242.0.0.10     5m

kubectl --context cluster-a get globalegressip -A
# NAMESPACE   NAME          PODS-SELECTOR          IP
# api         api-egress    app=user-service        242.0.0.50

# Pods in Cluster B reach user-service via its Global IP
# The GlobalIngressIP (242.0.0.10) routes to the actual ClusterIP
```

### Manually Allocate GlobalCIDR

```yaml
# SubmarinerConfig CRD for fine-grained Globalnet control
apiVersion: submarineraddon.open-cluster-management.io/v1alpha1
kind: SubmarinerConfig
metadata:
  name: submariner-config
  namespace: cluster-a
spec:
  gatewayConfig:
    aws:
      instanceType: c5.xlarge
    gcp:
      instanceType: n1-standard-4
  globalnetCIDRRange: "242.0.0.0/16"
  globalnetClusterSize: 65536  # /16 = 65536 IPs per cluster
  credentialsSecret:
    name: aws-credentials
```

## Section 7: Cable Driver Selection

### libreswan (IPsec)

Best for: Production, compliance requirements (IPsec/IKEv2), encrypted traffic

```yaml
# libreswan configuration in SubmarinerConfig
apiVersion: submariner.io/v1alpha1
kind: Submariner
metadata:
  name: submariner
  namespace: submariner-operator
spec:
  cableDriver: libreswan

  # libreswan-specific settings
  # These are set via environment variables on the gateway pod
  # IPSEC_DEBUG=0 (0=disabled, 1=enabled)
  # IPSEC_NATT=yes (NAT traversal)
  # IKE_PORT=500
  # NATT_PORT=4500

  # For AWS/cloud environments with NAT:
  natEnabled: true
  nattPort: 4500
  ikePort: 500
```

```bash
# Verify libreswan tunnels are established
kubectl --context cluster-a exec -n submariner-operator \
  -l app=submariner-gateway -- ipsec status

# Expected output shows active connections:
# 000 "submariner-cls-cluster-b-0-0": 192.0.2.1...192.0.2.2
# 000 #1: "submariner-cls-cluster-b-0-0" ...ESTABLISHED ...

# Check IPsec statistics
kubectl --context cluster-a exec -n submariner-operator \
  -l app=submariner-gateway -- ipsec whack --trafficstatus
```

### VXLAN Cable Driver

Best for: Environments where IPsec is blocked, lower overhead, non-encrypted internal networks

```yaml
apiVersion: submariner.io/v1alpha1
kind: Submariner
metadata:
  name: submariner
  namespace: submariner-operator
spec:
  cableDriver: vxlan

  # VXLAN uses UDP port 4800 by default
  # No encryption - use in trusted networks or with separate TLS
  # Lower CPU overhead than IPsec

  # VXLAN-specific settings
  # VXLAN_PORT=4800
```

### WireGuard Cable Driver

Best for: Modern encryption, lower overhead than IPsec, simpler key management

```bash
# WireGuard requires kernel module
# Check availability:
lsmod | grep wireguard
# Or for newer kernels:
modinfo wireguard

# Install WireGuard tools if needed
sudo apt-get install -y wireguard-tools  # Ubuntu/Debian
sudo dnf install -y wireguard-tools      # RHEL/Fedora
```

```yaml
apiVersion: submariner.io/v1alpha1
kind: Submariner
metadata:
  name: submariner
  namespace: submariner-operator
spec:
  cableDriver: wireguard

  # WireGuard uses UDP 4500 by default for Submariner
  # Keys are auto-generated and rotated
```

## Section 8: Troubleshooting Cross-Cluster Connectivity

### Diagnostic Commands

```bash
# Full connectivity check
subctl verify \
  --kubeconfig ~/.kube/cluster-a-kubeconfig \
  --toconfig ~/.kube/cluster-b-kubeconfig

# Gather diagnostics for support
subctl gather \
  --kubeconfig ~/.kube/cluster-a-kubeconfig \
  --dir ./submariner-diagnose

# Check Submariner connections
kubectl --context cluster-a get connections -n submariner-operator
# NAME             STATUS    LATENCY   LOSS     AGE
# cluster-b-10.0   Connected  2ms      0%       1h
```

### Common Issues and Solutions

**Issue 1: Gateway nodes cannot establish tunnel**

```bash
# Check gateway pod logs
kubectl --context cluster-a logs -n submariner-operator \
  -l app=submariner-gateway --since=5m

# Look for:
# "Failed to connect" -> firewall issue
# "No proposal chosen" -> cipher mismatch
# "Authentication failed" -> PSK mismatch

# Test port connectivity between gateway nodes
# From gateway node in Cluster A:
nc -vuz <cluster-b-gateway-public-ip> 4500
nc -vuz <cluster-b-gateway-public-ip> 4800

# Check security groups / firewall rules
# AWS:
aws ec2 describe-security-groups \
  --group-ids sg-xxxxx \
  --query 'SecurityGroups[].IpPermissions'
```

**Issue 2: Service not resolving via clusterset.local DNS**

```bash
# Check Lighthouse CoreDNS is running
kubectl --context cluster-b get pods -n submariner-operator \
  -l app=submariner-lighthouse-coredns

# Verify CoreDNS is forwarding clusterset.local to Lighthouse
kubectl --context cluster-b get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}'

# Check if the ServiceImport exists
kubectl --context cluster-b get serviceimport -A

# Debug DNS resolution
kubectl --context cluster-b run -it --rm debug \
  --image=nicolaka/netshoot --restart=Never -- \
  dig @10.96.0.10 user-service.api.svc.clusterset.local

# If no answer, check Lighthouse agent is exporting correctly
kubectl --context cluster-a logs -n submariner-operator \
  -l app=submariner-lighthouse-agent --since=10m | grep -i "export\|error"
```

**Issue 3: Routes not installed on worker nodes**

```bash
# Check route agent logs
kubectl --context cluster-a logs -n submariner-operator \
  -l app=submariner-routeagent --since=5m

# Verify routes exist on a worker node
# Note: requires node shell access
kubectl --context cluster-a debug node/worker-node-1 \
  -it --image=busybox -- sh -c "ip route | grep 242"

# Expected route entries:
# 242.0.1.0/24 via <gateway-node-ip> dev vxlan-tunnel
# 10.245.0.0/16 via <gateway-node-ip> dev vxlan-tunnel
```

**Issue 4: Connection flapping or high latency**

```bash
# Check health check status
kubectl --context cluster-a get connections -n submariner-operator -o yaml | \
  grep -A10 status

# View health check metrics
kubectl --context cluster-a port-forward svc/submariner-metrics -n submariner-operator 8080:8080 &
curl http://localhost:8080/metrics | grep submariner_connections

# Useful metrics:
# submariner_connections_status{cable_driver="libreswan",cluster_id="cluster-b"}
# submariner_latency_seconds{cluster_id="cluster-b"}
# submariner_requested_connections{cluster_id="cluster-b"}
```

### Checking Tunnel Status Programmatically

```go
package submariner

import (
    "context"
    "fmt"
    "time"

    submarinerv1 "github.com/submariner-io/submariner/pkg/apis/submariner.io/v1"
    "k8s.io/client-go/tools/clientcmd"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// ConnectionChecker monitors Submariner tunnel health
type ConnectionChecker struct {
    client client.Client
}

func NewConnectionChecker(kubeconfigPath string) (*ConnectionChecker, error) {
    cfg, err := clientcmd.BuildConfigFromFlags("", kubeconfigPath)
    if err != nil {
        return nil, err
    }

    c, err := client.New(cfg, client.Options{})
    if err != nil {
        return nil, err
    }

    return &ConnectionChecker{client: c}, nil
}

// CheckAllConnections returns the status of all Submariner connections
func (cc *ConnectionChecker) CheckAllConnections(ctx context.Context) ([]ConnectionStatus, error) {
    var connections submarinerv1.ConnectionList
    if err := cc.client.List(ctx, &connections,
        client.InNamespace("submariner-operator")); err != nil {
        return nil, fmt.Errorf("listing connections: %w", err)
    }

    statuses := make([]ConnectionStatus, 0, len(connections.Items))
    for _, conn := range connections.Items {
        latency := time.Duration(0)
        if conn.Status.LatencyRTT != nil {
            latency = time.Duration(*conn.Status.LatencyRTT.Average) * time.Nanosecond
        }

        statuses = append(statuses, ConnectionStatus{
            RemoteCluster:  conn.Spec.Endpoint.ClusterID,
            Status:         string(conn.Status.Status),
            Latency:        latency,
            LastTransition: conn.Status.StatusMessage,
        })
    }

    return statuses, nil
}

type ConnectionStatus struct {
    RemoteCluster  string
    Status         string
    Latency        time.Duration
    LastTransition string
}
```

## Section 9: Monitoring and Alerting

```yaml
# PrometheusRule for Submariner health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: submariner-alerts
  namespace: monitoring
spec:
  groups:
    - name: submariner.connectivity
      rules:
        - alert: SubmarinerTunnelDown
          expr: |
            submariner_connections_status != 2
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Submariner tunnel to {{ $labels.cluster_id }} is down"
            description: |
              Cross-cluster connectivity to {{ $labels.cluster_id }} is disrupted.
              All cross-cluster service calls will fail.
            runbook_url: "https://wiki.example.com/runbooks/submariner-tunnel-down"

        - alert: SubmarinerHighLatency
          expr: |
            submariner_latency_seconds{quantile="0.99"} > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High cross-cluster latency to {{ $labels.cluster_id }}"
            description: |
              P99 latency to {{ $labels.cluster_id }} is {{ $value }}s (>50ms).
              Check network path between gateway nodes.

        - alert: SubmarinerGatewayHighCPU
          expr: |
            rate(container_cpu_usage_seconds_total{
              pod=~"submariner-gateway-.*"
            }[5m]) > 0.8
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Submariner gateway CPU high"
            description: "Gateway pod is using >80% CPU. Consider upgrading instance type."
```

Submariner provides the network connectivity layer for multi-cluster Kubernetes architectures without requiring application changes or a full service mesh. Combined with Lighthouse for DNS-based service discovery and Globalnet for CIDR conflict resolution, it enables seamless cross-cluster communication that integrates with standard Kubernetes networking primitives. The key operational consideration is ensuring gateway nodes have stable public IPs and appropriate firewall rules, after which the system is largely self-managing.
