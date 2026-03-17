---
title: "Linux IPv6 in Production: Kubernetes Dual-Stack Configuration and Troubleshooting"
date: 2030-10-20T00:00:00-05:00
draft: false
tags: ["IPv6", "Kubernetes", "Dual-Stack", "Networking", "Linux", "SLAAC", "DHCPv6"]
categories:
- Kubernetes
- Networking
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise IPv6 guide: dual-stack Kubernetes cluster configuration, IPv6 pod addressing, LoadBalancer IPs, network policy for IPv6, DHCPv6 vs SLAAC, troubleshooting IPv6 connectivity, and transitioning production workloads."
more_link: "yes"
url: "/linux-ipv6-production-kubernetes-dual-stack-configuration-troubleshooting/"
---

IPv6 adoption in production Kubernetes clusters is no longer optional for enterprises with public-facing services — IPv4 exhaustion has made IPv6 addressing mandatory in many regulatory contexts, and cloud provider pricing incentives for IPv6 are increasingly significant. Kubernetes dual-stack support (stable since 1.23) allows pods and services to have both IPv4 and IPv6 addresses simultaneously, enabling gradual migration without service disruption.

<!--more-->

## IPv6 Fundamentals for Kubernetes Operators

### Address Types and Scopes

```bash
# Global unicast addresses (public Internet-routable)
# Range: 2000::/3
# Example: 2001:db8:1234:5678::1/64
# Kubernetes pods typically receive addresses from this range

# Link-local addresses (not routable, auto-generated)
# Range: fe80::/10
# Example: fe80::1%eth0
# Every IPv6-enabled interface gets one automatically

# Unique local addresses (private, similar to RFC 1918)
# Range: fc00::/7 (fd00::/8 in practice)
# Example: fd12:3456:789a::1/48
# Good for internal cluster traffic

# Loopback
# ::1/128

# Show all addresses on an interface
ip -6 addr show eth0
ip -6 route show
```

### DHCPv6 vs SLAAC

```bash
# SLAAC (Stateless Address Autoconfiguration)
# - IPv6 host generates its own address from prefix + MAC (EUI-64) or random
# - Router advertises the prefix via RA (Router Advertisement)
# - No DHCP server required
# - Works without configuration for outbound-only connectivity

# Check RA (Router Advertisement) settings on the router
sysctl net.ipv6.conf.eth0.accept_ra
sysctl net.ipv6.conf.eth0.autoconf

# DHCPv6 (Stateful)
# - Like DHCP for IPv4, provides address + DNS + other options
# - Requires DHCPv6 server
# - Provides predictable addresses for servers

# Check if DHCPv6 is in use
ip -6 addr show | grep "dynamic"

# On nodes that need stable addresses, use DHCPv6 stateful mode
# or configure static addresses in cloud provider settings

# For Kubernetes nodes, assign static IPv6 addresses manually or via
# cloud provider IPAM to ensure stability during upgrades
```

## Dual-Stack Kubernetes Cluster Configuration

### kubeadm Dual-Stack Setup

```yaml
# kubeadm-dual-stack-config.yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: v1.31.0
clusterName: production-dual-stack

networking:
  # Dual-stack pod CIDRs: comma-separated IPv4,IPv6 or IPv6,IPv4
  podSubnet: "10.244.0.0/16,fd00:10:244::/56"
  serviceSubnet: "10.96.0.0/16,fd00:10:96::/108"
  dnsDomain: cluster.local

controllerManager:
  extraArgs:
    # Allocate pod CIDRs from both families
    node-cidr-mask-size-ipv4: "24"
    node-cidr-mask-size-ipv6: "72"

apiServer:
  extraArgs:
    # Bind API server to both IPv4 and IPv6
    advertise-address: ""  # Will be auto-detected

---
apiVersion: kubeadm.k8s.io/v1beta3
kind: InitConfiguration
nodeRegistration:
  # Specify the node's IPv6 address for registration
  # kubeletExtraArgs:
  #   node-ip: "192.168.1.10,2001:db8::10"
```

```bash
# Initialize the cluster
kubeadm init --config kubeadm-dual-stack-config.yaml

# Verify dual-stack is active
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{.spec.podCIDR}{"\n"}{.spec.podCIDRs}{"\n"}{end}'

# Should show both CIDRs per node:
# worker-1
# 10.244.1.0/24
# [10.244.1.0/24, fd00:10:244:0:1::/72]
```

### EKS Dual-Stack Configuration

```bash
# Create a dual-stack EKS cluster
eksctl create cluster \
  --name production-dual-stack \
  --region us-east-1 \
  --version 1.31 \
  --ip-family IPv6 \
  --nodegroup-name workers \
  --node-type m6i.xlarge \
  --nodes 3 \
  --nodes-min 3 \
  --nodes-max 10

# For existing clusters, enable dual-stack on VPC first
aws ec2 associate-vpc-cidr-block \
  --vpc-id vpc-12345678 \
  --amazon-provided-ipv6-cidr-block

# Update the VPC CNI (aws-vpc-cni) to support IPv6
kubectl set env daemonset aws-node -n kube-system \
  ENABLE_IPv6=true \
  ENABLE_PREFIX_DELEGATION=true \
  WARM_PREFIX_TARGET=1
```

### GKE Dual-Stack Configuration

```bash
# Create a dual-stack GKE cluster
gcloud container clusters create production-dual-stack \
  --region us-east1 \
  --cluster-version "1.31" \
  --network my-vpc \
  --subnetwork my-subnet \
  --stack-type IPV4_IPV6 \
  --ipv6-access-type EXTERNAL \
  --cluster-ipv4-cidr "10.0.0.0/16" \
  --cluster-ipv6-cidr "/112" \
  --services-ipv4-cidr "10.1.0.0/16" \
  --services-ipv6-cidr "/112" \
  --enable-ip-alias \
  --num-nodes 3

# Verify
gcloud container clusters describe production-dual-stack \
  --region us-east1 \
  --format="value(ipAllocationPolicy)"
```

## Pod IPv6 Addressing

### Verifying Pod Dual-Stack Assignment

```bash
# Check a pod's IP addresses
kubectl get pod my-app-abc123 -o jsonpath='{.status.podIPs[*].ip}'
# Output: 10.244.1.5 fd00:10:244:0:1::5

# Get all pod IPs across the cluster
kubectl get pods -A -o json \
  | jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name): \([.status.podIPs[].ip] | join(", "))"' \
  | head -20

# Verify dual-stack assignment in a pod
kubectl exec -it my-app-abc123 -- ip -6 addr show
kubectl exec -it my-app-abc123 -- ip -6 route show

# Test IPv6 connectivity from within a pod
kubectl exec -it my-app-abc123 -- ping6 -c 3 ::1
kubectl exec -it my-app-abc123 -- ping6 -c 3 fd00:10:244::1  # Gateway
kubectl exec -it my-app-abc123 -- curl -6 http://[2607:f8b0:4004:c07::6a]:80  # Google IPv6
```

### Node IPAM Verification

```bash
# Check node CIDR allocation
kubectl describe node worker-1 | grep -A5 "PodCIDR"

# Verify the CNI is allocating from both CIDRs
kubectl get nodes -o json | jq '.items[] | {
  name: .metadata.name,
  podCIDR: .spec.podCIDR,
  podCIDRs: .spec.podCIDRs,
  internalIPs: [.status.addresses[] | select(.type == "InternalIP") | .address]
}'
```

## Dual-Stack Services

### Creating Dual-Stack Services

```yaml
# dual-stack-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-api
  namespace: production
spec:
  # Dual-stack: prefer IPv6 but also respond on IPv4
  ipFamilyPolicy: PreferDualStack
  # Or: RequireDualStack, SingleStack
  ipFamilies:
  - IPv6
  - IPv4

  selector:
    app: payment-api

  ports:
  - port: 443
    targetPort: 8080
    protocol: TCP
    name: https

  type: ClusterIP
---
# Verify the service received both addresses
# kubectl get svc payment-api -o yaml
# spec:
#   clusterIPs:
#   - 10.96.1.100
#   - fd00:10:96::100
#   ipFamilies:
#   - IPv6
#   - IPv4
```

### LoadBalancer with IPv6

```yaml
# loadbalancer-ipv6.yaml
apiVersion: v1
kind: Service
metadata:
  name: public-api
  namespace: production
  annotations:
    # AWS NLB: request IPv6 LoadBalancer IP
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
    service.beta.kubernetes.io/aws-load-balancer-ip-address-type: "dualstack"
    # GCP: request global IPv6 load balancer IP
    # cloud.google.com/l4-rbs: "enabled"
    # Azure: request IPv6 load balancer
    # service.beta.kubernetes.io/azure-pip-name: "my-public-ip-ipv6"

spec:
  ipFamilyPolicy: RequireDualStack
  ipFamilies:
  - IPv4
  - IPv6

  type: LoadBalancer
  selector:
    app: public-api
  ports:
  - port: 443
    targetPort: 8080
    protocol: TCP
```

```bash
# Check that the LoadBalancer received both external IPs
kubectl get svc public-api -o jsonpath='{.status.loadBalancer.ingress}'
# [{"hostname":"abc.us-east-1.elb.amazonaws.com"},{"ip":"2600:1f18:1234::1"}]

# Test IPv6 connectivity to the LoadBalancer
curl -6 --resolve "api.example.com:443:[2600:1f18:1234::1]" https://api.example.com/healthz
```

## Network Policy for Dual-Stack

```yaml
# dual-stack-network-policy.yaml
# Network policies apply to all pod IPs (both IPv4 and IPv6)
# The Kubernetes network policy API is family-agnostic

apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-api-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: payment-api

  policyTypes:
  - Ingress
  - Egress

  ingress:
  # Allow from frontend pods
  - from:
    - podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 8080

  # Allow from monitoring
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app: prometheus
    ports:
    - protocol: TCP
      port: 9090

  egress:
  # Allow DNS (both IPv4 and IPv6)
  - to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53

  # Allow outbound to database (IPv4 and IPv6 CIDRs)
  - to:
    - ipBlock:
        cidr: 10.0.0.0/8  # IPv4 database range
    - ipBlock:
        cidr: fd00::/8     # IPv6 internal range
    ports:
    - protocol: TCP
      port: 5432
```

### CNI-Specific IPv6 Network Policy (Cilium)

```yaml
# cilium-ipv6-policy.yaml
# Cilium supports IPv6-specific CIDR policies
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-ipv6-egress-to-internet
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: content-fetcher

  egress:
  # Allow outbound IPv6 to public internet
  - toCIDRSet:
    - cidr: "2000::/3"  # Global unicast (public Internet)
      except:
      - "fd00::/8"      # Exclude private IPv6 ranges
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
      - port: "80"
        protocol: TCP

  # Allow internal IPv6 communications
  - toCIDRSet:
    - cidr: "fd00:10:244::/56"  # Pod CIDR
    - cidr: "fd00:10:96::/108"  # Service CIDR
```

## Configuring Applications for Dual-Stack

### Go Application Dual-Stack Server

```go
// cmd/server/main.go
package main

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    "os"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // Listen on both IPv4 and IPv6 by binding to "::" (all interfaces)
    // "::" is the IPv6 equivalent of "0.0.0.0"
    // On Linux, this also accepts IPv4 connections via IPv4-mapped IPv6 addresses
    // unless IPV6_V6ONLY socket option is set

    // For explicit dual-stack, create two listeners
    listener4, err := net.Listen("tcp4", "0.0.0.0:8080")
    if err != nil {
        logger.Error("IPv4 listen failed", "error", err)
        os.Exit(1)
    }

    listener6, err := net.Listen("tcp6", "[::]:8080")
    if err != nil {
        logger.Warn("IPv6 listen failed, running IPv4 only", "error", err)
        // Continue without IPv6 - graceful degradation
        http.Serve(listener4, buildHandler(logger))
        return
    }

    mux := buildHandler(logger)
    server := &http.Server{Handler: mux}

    // Serve on both listeners
    go func() {
        if err := server.Serve(listener4); err != nil && err != http.ErrServerClosed {
            logger.Error("IPv4 server error", "error", err)
        }
    }()

    go func() {
        if err := server.Serve(listener6); err != nil && err != http.ErrServerClosed {
            logger.Error("IPv6 server error", "error", err)
        }
    }()

    logger.Info("server listening", "ipv4", ":8080", "ipv6", "[::]:8080")
    <-context.Background().Done()
}

func buildHandler(logger *slog.Logger) *http.ServeMux {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        // Log the client address family for observability
        host, _, _ := net.SplitHostPort(r.RemoteAddr)
        ip := net.ParseIP(host)
        family := "IPv4"
        if ip != nil && ip.To4() == nil {
            family = "IPv6"
        }
        logger.Info("request received",
            "path", r.URL.Path,
            "remote_addr", r.RemoteAddr,
            "address_family", family,
        )
        fmt.Fprintf(w, "Hello from %s address family\n", family)
    })
    return mux
}
```

### NGINX Dual-Stack Configuration

```nginx
# /etc/nginx/nginx.conf
events {
    worker_connections 1024;
}

http {
    # Listen on IPv4 and IPv6
    server {
        listen 80;          # IPv4
        listen [::]:80;     # IPv6

        server_name example.com;

        location / {
            # Log real client IP (may be IPv6)
            log_format main '$remote_addr - $remote_user [$time_local] '
                           '"$request" $status $body_bytes_sent '
                           '"$http_referer" "$http_user_agent" '
                           'address_family=$binary_remote_addr';

            proxy_pass http://backend;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }

    upstream backend {
        # Backend pods can be accessed via IPv6 ClusterIP
        server [fd00:10:96::100]:8080;
        # Fallback to IPv4
        server 10.96.1.100:8080 backup;
    }
}
```

## Troubleshooting IPv6 Connectivity

### Systematic Diagnostics

```bash
#!/bin/bash
# ipv6-diagnostics.sh
# Systematic IPv6 connectivity troubleshooting on a Kubernetes node

set -euo pipefail

echo "=== IPv6 Connectivity Diagnostics ==="

# 1. Kernel IPv6 support
echo ""
echo "--- Kernel IPv6 Status ---"
cat /proc/net/if_inet6 | head -5 || echo "No IPv6 interfaces"
sysctl net.ipv6.conf.all.disable_ipv6

# 2. Interface addressing
echo ""
echo "--- IPv6 Interface Addresses ---"
ip -6 addr show | grep -v "link" | head -30

# 3. Default route
echo ""
echo "--- IPv6 Routing Table ---"
ip -6 route show table main | head -20
ip -6 route show table local | head -10

# 4. Router advertisements received
echo ""
echo "--- Router Advertisements ---"
rdisc6 eth0 2>/dev/null || echo "rdisc6 not available"

# 5. DNS resolution for IPv6
echo ""
echo "--- DNS AAAA Record Resolution ---"
dig AAAA kubernetes.default.svc.cluster.local @10.96.0.10 +short 2>/dev/null \
  || echo "DNS lookup failed"
dig AAAA google.com +short 2>/dev/null || echo "DNS AAAA failed"

# 6. Connectivity to cluster DNS
echo ""
echo "--- CoreDNS IPv6 Connectivity ---"
kubectl get svc kube-dns -n kube-system -o jsonpath='{.spec.clusterIPs[*]}'

# 7. Pod-to-pod IPv6 test
echo ""
echo "--- Pod-to-Pod IPv6 Test ---"
POD1=$(kubectl get pods -A -o jsonpath='{.items[0].metadata.namespace}/{.items[0].metadata.name}')
POD2=$(kubectl get pods -A -o jsonpath='{.items[1].metadata.namespace}/{.items[1].metadata.name}')
POD2_IPV6=$(kubectl get pod ${POD2##*/} -n ${POD2%%/*} -o jsonpath='{.status.podIPs[1].ip}' 2>/dev/null || echo "N/A")

if [ "$POD2_IPV6" != "N/A" ] && [ -n "$POD2_IPV6" ]; then
    echo "Testing ping from $POD1 to $POD2 ($POD2_IPV6)"
    kubectl exec -n ${POD1%%/*} ${POD1##*/} -- ping6 -c 3 "$POD2_IPV6" 2>/dev/null \
      || echo "IPv6 ping failed"
fi

# 8. External IPv6 connectivity
echo ""
echo "--- External IPv6 Connectivity ---"
ping6 -c 3 2001:4860:4860::8888 2>/dev/null \
  && echo "Google DNS IPv6 reachable" \
  || echo "External IPv6 not reachable from node"

echo ""
echo "=== Diagnostics Complete ==="
```

### Common IPv6 Issues and Solutions

```bash
# Issue: Pod not getting IPv6 address
# Check if CNI is configured for dual-stack
kubectl get configmap -n kube-system -o yaml | grep -A10 "cni-conf"

# For Calico: check IP pool configuration
kubectl get ippools -o yaml 2>/dev/null | grep -E "cidr|disabled"
calicoctl get ippool -o yaml 2>/dev/null

# For Cilium: check dual-stack status
cilium status | grep -i ipv6
kubectl -n kube-system exec ds/cilium -- cilium status | grep IPv6

# Issue: Service not getting IPv6 ClusterIP
# Verify kube-proxy / iptables rules for IPv6
kubectl get svc my-service -o jsonpath='{.spec.ipFamilyPolicy}'
kubectl get svc my-service -o jsonpath='{.spec.clusterIPs}'

# Check kube-proxy IPv6 rules
ip6tables -t nat -L KUBE-SERVICES 2>/dev/null | head -30

# Issue: IPv6 traffic not reaching external destinations
# Check masquerade rules for IPv6
ip6tables -t nat -L POSTROUTING -v | grep -i masq

# Enable IPv6 masquerade if missing
ip6tables -t nat -A POSTROUTING -s fd00:10:244::/56 ! -d fd00:10:244::/56 -j MASQUERADE

# For AWS/GCP: check if IPv6 gateway is configured
ip -6 route | grep default
# Should show: default via fe80::1 dev eth0 proto ra

# Issue: Node not receiving IPv6 RA
sysctl net.ipv6.conf.eth0.accept_ra
# If 0, enable it:
sysctl -w net.ipv6.conf.eth0.accept_ra=1
# Make persistent:
echo "net.ipv6.conf.eth0.accept_ra = 1" >> /etc/sysctl.d/99-ipv6.conf
```

### IPv6-Specific iptables Rules

```bash
# List IPv6 NAT rules (kube-proxy creates these)
ip6tables -t nat -L -n -v | head -50

# List IPv6 filter rules for Kubernetes
ip6tables -t filter -L KUBE-FORWARD -n -v

# Verify IPv6 service forwarding works
kubectl exec -it debug-pod -- curl -6 http://[fd00:10:96::100]:8080/healthz

# Trace IPv6 packet flow
ip6tables -t raw -A PREROUTING -p tcp --dport 8080 -j TRACE
ip6tables -t raw -A OUTPUT -p tcp --dport 8080 -j TRACE
# View in kernel logs:
dmesg | grep -i "TRACE:" | tail -20
# Remove when done:
ip6tables -t raw -D PREROUTING -p tcp --dport 8080 -j TRACE
ip6tables -t raw -D OUTPUT -p tcp --dport 8080 -j TRACE
```

## Transitioning Production Workloads to Dual-Stack

```bash
#!/bin/bash
# dual-stack-migration-validation.sh
# Validate readiness for dual-stack migration

set -euo pipefail

NAMESPACE="${1:-production}"

echo "=== Dual-Stack Migration Readiness Check ==="
echo "Namespace: $NAMESPACE"
echo ""

# 1. Check application binds to all addresses
echo "--- Application Socket Binding ---"
for POD in $(kubectl get pods -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}'); do
  echo "Pod: $POD"
  kubectl exec -n "$NAMESPACE" "$POD" -- ss -tlnp 2>/dev/null | \
    grep -E "LISTEN|*:.*" | head -5 || true
done

echo ""

# 2. Check services for dual-stack compatibility
echo "--- Service IP Family Policies ---"
kubectl get services -n "$NAMESPACE" -o json | jq -r '
  .items[] |
  "\(.metadata.name): ipFamilyPolicy=\(.spec.ipFamilyPolicy // "SingleStack"), ipFamilies=\(.spec.ipFamilies // ["IPv4"] | join(","))"
'

echo ""

# 3. Check ingress controllers
echo "--- Ingress Controller IPv6 Support ---"
kubectl get svc -n ingress-nginx -o json 2>/dev/null | \
  jq -r '.items[] | "\(.metadata.name): \(.spec.ipFamilyPolicy // "SingleStack")"' \
  || echo "No ingress-nginx found"

echo ""

# 4. Verify DNS returns AAAA records
echo "--- DNS AAAA Record Check ---"
for SVC in $(kubectl get svc -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}'); do
  RESULT=$(kubectl exec -n "$NAMESPACE" \
    "$(kubectl get pod -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')" \
    -- nslookup -type=AAAA "${SVC}.${NAMESPACE}.svc.cluster.local" 2>/dev/null \
    | grep "Address:" | grep -v "::1" | tail -1 || echo "no IPv6")
  echo "  $SVC: $RESULT"
done

echo ""
echo "=== Migration Check Complete ==="
```

IPv6 dual-stack in Kubernetes is mature enough for production deployments as of Kubernetes 1.31. The primary operational challenges are application-level socket binding (applications that hardcode `0.0.0.0` instead of `::` miss IPv6), service discovery (ensuring CoreDNS returns both A and AAAA records), and monitoring (ensuring network metrics capture both address families). Clusters that complete the dual-stack transition gain access to simpler NAT topologies, improved routing performance, and future-proofed address allocation.
