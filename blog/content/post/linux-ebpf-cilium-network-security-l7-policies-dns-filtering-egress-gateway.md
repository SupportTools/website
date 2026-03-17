---
title: "Linux eBPF Network Security with Cilium: L7 Policies, DNS-Based Filtering, and Egress Gateway"
date: 2031-07-20T00:00:00-05:00
draft: false
tags: ["Cilium", "eBPF", "Kubernetes", "Network Security", "L7 Policy", "Egress Gateway"]
categories:
- Kubernetes
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Cilium's eBPF-based network security capabilities covering L7 HTTP/gRPC policies, DNS-based filtering with FQDNs, and egress gateway configuration for production enterprise environments."
more_link: "yes"
url: "/linux-ebpf-cilium-network-security-l7-policies-dns-filtering-egress-gateway/"
---

Cilium has become the CNI of choice for security-conscious Kubernetes deployments because it operates at a level of abstraction that iptables-based solutions cannot reach. By using eBPF programs loaded directly into the Linux kernel, Cilium can enforce network policy at Layer 7, perform identity-aware filtering based on Kubernetes labels rather than IP addresses, and implement DNS-based egress controls that survive pod IP churn. This guide covers these three capabilities in depth for production enterprise deployments.

<!--more-->

# Linux eBPF Network Security with Cilium: L7 Policies, DNS-Based Filtering, and Egress Gateway

## Why eBPF Changes Network Security

Traditional Kubernetes network policies operate at Layer 3/4 — they can allow or deny based on IP address and port, but they cannot inspect HTTP methods, paths, headers, or gRPC service names. This means a policy that allows port 443 from namespace A to namespace B effectively allows any HTTPS traffic, including exfiltration via HTTPS to unexpected paths.

Cilium solves this by using eBPF programs that run in the kernel network stack. These programs can:

- Parse HTTP/1.1, HTTP/2, gRPC, and Kafka at the kernel level
- Make allow/deny decisions based on HTTP method, URL path, and headers
- Resolve DNS names to IP addresses and dynamically update policy without pod restarts
- Assign cryptographic identities to pods based on labels, eliminating IP-based policy churn
- Transparently redirect egress traffic through designated gateway nodes with stable IP addresses

## Cilium Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Kubernetes Node                                             │
│                                                              │
│  ┌─────────────┐    ┌─────────────────────────────────────┐ │
│  │  Pod veth   │────│  eBPF Programs (tc/XDP hooks)       │ │
│  └─────────────┘    │  - Policy enforcement               │ │
│                     │  - L7 HTTP/gRPC inspection          │ │
│  ┌─────────────┐    │  - DNS tracking                     │ │
│  │  Cilium     │    │  - Egress redirection               │ │
│  │  Agent      │────│                                     │ │
│  │  (DaemonSet)│    └─────────────────────────────────────┘ │
│  └──────┬──────┘                                            │
│         │            ┌─────────────────────────────────────┐ │
│  ┌──────▼──────┐     │  BPF Maps (shared kernel memory)   │ │
│  │  Cilium     │────▶│  - Identity table                  │ │
│  │  Operator   │     │  - Policy map                      │ │
│  └─────────────┘     │  - DNS cache                       │ │
│                      └─────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Installing Cilium with Full Feature Set

### Prerequisites

- Kubernetes 1.27+
- Linux kernel 5.10+ (5.15+ recommended for full L7 support)
- kube-proxy disabled or running in iptables-free mode

Verify kernel version:

```bash
uname -r
# Should show 5.15.x or higher for full BPF feature set

# Verify BPF filesystem is mounted
mount | grep bpf
# bpf on /sys/fs/bpf type bpf (rw,nosuid,nodev,noexec,relatime,mode=700)
```

### Helm Installation

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update
```

Production Helm values:

```yaml
# cilium-values.yaml
image:
  tag: "v1.17.0"

# Enable kube-proxy replacement (requires kernel 5.10+)
kubeProxyReplacement: true
k8sServiceHost: "10.0.0.1"  # API server VIP
k8sServicePort: "6443"

# Enable L7 proxy for HTTP/gRPC policy enforcement
l7Proxy: true
envoy:
  enabled: true
  securityContext:
    capabilities:
      keepCapNetBindService: true

# Enable Hubble for observability
hubble:
  enabled: true
  relay:
    enabled: true
  ui:
    enabled: true
  metrics:
    enabled:
      - dns:query;ignoreAAAA
      - drop
      - tcp
      - flow
      - port-distribution
      - icmp
      - http
    serviceMonitor:
      enabled: true

# Enable egress gateway
egressGateway:
  enabled: true
  reconcilerQueueSize: 1024

# Identity allocation
identityAllocationMode: crd

# Enable encryption (optional but recommended)
encryption:
  enabled: true
  type: wireguard

# IPAM configuration
ipam:
  mode: kubernetes

# Enable host firewall for node-level policy
hostFirewall:
  enabled: true

# Resource configuration for production
resources:
  requests:
    cpu: 100m
    memory: 512Mi
  limits:
    cpu: "2"
    memory: 2Gi

operator:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

# DNS proxy for FQDN policy
dnsPolicyUnloadOnShutdown: false
dnsProxyResponseMaxDelay: 100ms
```

```bash
helm upgrade --install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.17.0 \
  --values cilium-values.yaml \
  --wait
```

Verify installation:

```bash
cilium status --wait
cilium connectivity test
```

## Layer 7 Network Policies

### L7 HTTP Policy

Standard Kubernetes NetworkPolicy allows port 80 but cannot distinguish GET from POST or /api/v1/users from /admin. Cilium CiliumNetworkPolicy adds this capability:

```yaml
# l7-http-policy.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: payments-api-policy
  namespace: payments
spec:
  # Select the payments API backend
  endpointSelector:
    matchLabels:
      app: payments-api
      tier: backend

  ingress:
    # Allow the payments frontend to call specific endpoints
    - fromEndpoints:
        - matchLabels:
            app: payments-frontend
            k8s:io.kubernetes.pod.namespace: payments
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Allow health checks from all internal services
              - method: "GET"
                path: "/health"
              # Allow frontend to initiate payments
              - method: "POST"
                path: "/api/v1/payments"
                headers:
                  - "X-API-Version: v1"
              # Allow payment status queries
              - method: "GET"
                path: "/api/v1/payments/[0-9a-f-]+"

    # Allow the audit service to read-only access
    - fromEndpoints:
        - matchLabels:
            app: audit-service
            k8s:io.kubernetes.pod.namespace: audit
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/api/v1/payments"
              - method: "GET"
                path: "/api/v1/payments/[0-9a-f-]+"

  egress:
    # Allow DNS resolution
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            dns:
              - matchPattern: "*.payments.svc.cluster.local"
              - matchPattern: "*.internal.example.com"

    # Allow calls to the fraud detection service
    - toEndpoints:
        - matchLabels:
            app: fraud-detection
            k8s:io.kubernetes.pod.namespace: payments
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
          rules:
            http:
              - method: "POST"
                path: "/v1/check"
```

### L7 gRPC Policy

For gRPC services, Cilium can filter by service and method name:

```yaml
# grpc-policy.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: user-service-grpc-policy
  namespace: platform
spec:
  endpointSelector:
    matchLabels:
      app: user-service

  ingress:
    - fromEndpoints:
        - matchLabels:
            app: api-gateway
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          rules:
            http:
              # gRPC method filtering uses path format: /package.Service/Method
              - method: "POST"
                path: "/users.UserService/GetUser"
              - method: "POST"
                path: "/users.UserService/CreateUser"
              - method: "POST"
                path: "/users.UserService/UpdateUser"

    # Internal services can only read user data
    - fromEndpoints:
        - matchLabels:
            role: internal-service
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          rules:
            http:
              - method: "POST"
                path: "/users.UserService/GetUser"
              - method: "POST"
                path: "/users.UserService/ListUsers"
```

### Kafka L7 Policy

Cilium also supports Kafka topic-level access control:

```yaml
# kafka-policy.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: kafka-topic-policy
  namespace: data
spec:
  endpointSelector:
    matchLabels:
      app: kafka-broker

  ingress:
    # Payment producer can only produce to payments topics
    - fromEndpoints:
        - matchLabels:
            app: payment-producer
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - apiKey: produce
                topic: "payments.*"
              - apiKey: metadata

    # Analytics consumer can only consume from specific topics
    - fromEndpoints:
        - matchLabels:
            app: analytics-consumer
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - apiKey: fetch
                topic: "payments.events"
              - apiKey: fetch
                topic: "orders.events"
              - apiKey: offsetCommit
                topic: "payments.events"
              - apiKey: offsetCommit
                topic: "orders.events"
              - apiKey: offsetFetch
              - apiKey: findCoordinator
              - apiKey: joinGroup
              - apiKey: heartbeat
              - apiKey: leaveGroup
              - apiKey: syncGroup
              - apiKey: metadata
```

## DNS-Based Filtering (FQDN Policy)

Traditional NetworkPolicy requires specifying pod CIDRs or namespaces. For external services, you'd need to pin IP addresses — which change constantly. Cilium's FQDN policy resolves DNS names and dynamically maintains the IP set.

### How DNS Policy Works

1. The Cilium DNS proxy intercepts DNS responses from pods
2. When a pod resolves `api.external-service.com`, Cilium records the returned IPs
3. The FQDN policy rule dynamically populates an IPSet with those IPs
4. The eBPF program uses the IPSet to enforce egress policy
5. When DNS TTL expires, Cilium re-resolves and updates the IPSet

### Basic FQDN Egress Policy

```yaml
# fqdn-egress-policy.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: backend-egress-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend-service

  egress:
    # Allow DNS resolution first (required for FQDN rules to work)
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            dns:
              - matchPattern: "*"

    # Allow HTTPS to specific external services only
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.sendgrid.com"
        - matchPattern: "*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow NTP synchronization
    - toFQDNs:
        - matchName: "time.google.com"
        - matchName: "pool.ntp.org"
      toPorts:
        - ports:
            - port: "123"
              protocol: UDP

    # Internal Kubernetes services
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: database
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
```

### FQDN Policy with Pattern Matching

```yaml
# fqdn-pattern-policy.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: ml-service-egress
  namespace: ml
spec:
  endpointSelector:
    matchLabels:
      app: model-inference

  egress:
    - toEndpoints:
        - matchLabels:
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            dns:
              - matchPattern: "*"

    # Allow S3 access for model artifacts
    - toFQDNs:
        - matchPattern: "s3.amazonaws.com"
        - matchPattern: "*.s3.amazonaws.com"
        - matchPattern: "s3.*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow inference API endpoints
    - toFQDNs:
        - matchPattern: "*.openai.com"
        - matchName: "api.anthropic.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Deny all other external traffic (implicit deny after explicit rules)
```

### DNS Policy Visibility

Inspect what DNS queries are being made and which IPs are mapped:

```bash
# View DNS policy state for a pod
kubectl exec -n kube-system <cilium-pod> -- cilium fqdn cache list

# Sample output:
# FQDN                         SOURCE   IPs                           TTL
# api.stripe.com               lookup   54.187.174.169,18.234.13.9   3600
# api.sendgrid.com             lookup   167.89.47.148                 300

# Monitor DNS requests in real-time with Hubble
hubble observe --namespace production --verdict DROPPED -f

# Check policy enforcement for a specific endpoint
kubectl exec -n kube-system <cilium-pod> -- cilium endpoint list
kubectl exec -n kube-system <cilium-pod> -- cilium endpoint get <endpoint-id>
```

### Handling DNS TTL Edge Cases

FQDN policies can have race conditions when a DNS TTL expires but the eBPF map hasn't been updated yet. Configure a grace period:

```yaml
# cilium-config ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Keep IPs in the FQDN cache for this long after TTL expiry
  # Prevents brief connectivity drops during TTL refresh
  tofqdns-min-ttl: "3600"
  # How often the FQDN proxy checks for TTL expiry
  tofqdns-proxy-response-max-delay: "100ms"
  # Enable pre-cache: resolve FQDNs proactively
  tofqdns-pre-cache: "true"
```

## Egress Gateway

The Egress Gateway feature allows you to route pod egress traffic through a specific node with a stable, routable IP address. This is essential when:

- External services whitelist source IPs
- Compliance requires auditable egress points
- You need NAT for pods in private subnets

### Architecture

```
Pod (10.0.1.5) → Egress Gateway Node (192.168.1.100) → Internet
                 [eBPF redirects traffic here]
                 [Node has stable IP whitelisted externally]
```

### Egress Gateway Policy

First, label the nodes that will act as egress gateways:

```bash
kubectl label node node-egress-1 egress-gateway=payments
kubectl label node node-egress-2 egress-gateway=payments
```

Create the EgressGatewayPolicy:

```yaml
# egress-gateway-policy.yaml
apiVersion: cilium.io/v2
kind: CiliumEgressGatewayPolicy
metadata:
  name: payments-egress
spec:
  # Select source pods
  selectors:
    - podSelector:
        matchLabels:
          app: payment-processor
          k8s:io.kubernetes.pod.namespace: payments
    - podSelector:
        matchLabels:
          app: payment-webhook
          k8s:io.kubernetes.pod.namespace: payments

  # Route to these external destinations through the gateway
  destinationCIDRs:
    - "0.0.0.0/0"  # All external traffic (after excluding cluster CIDRs)

  # Exclude cluster-internal traffic from egress redirection
  excludedCIDRs:
    - "10.0.0.0/8"
    - "172.16.0.0/12"
    - "192.168.0.0/16"

  # Select egress gateway nodes
  egressGateway:
    nodeSelector:
      matchLabels:
        egress-gateway: payments
    # Use this IP on the gateway node for masquerading
    egressIP: "192.168.1.100"
```

For high availability with multiple gateway nodes:

```yaml
# ha-egress-gateway.yaml
apiVersion: cilium.io/v2
kind: CiliumEgressGatewayPolicy
metadata:
  name: payments-egress-ha
spec:
  selectors:
    - podSelector:
        matchLabels:
          app: payment-processor
          k8s:io.kubernetes.pod.namespace: payments

  destinationCIDRs:
    - "0.0.0.0/0"

  excludedCIDRs:
    - "10.0.0.0/8"
    - "172.16.0.0/12"
    - "192.168.0.0/16"

  egressGateway:
    nodeSelector:
      matchLabels:
        egress-gateway: payments
    # When multiple nodes match, Cilium uses the node where the pod runs
    # if that node is an egress gateway, otherwise picks one consistently
```

### Configuring the Gateway Node

The egress gateway node needs the IP configured on an interface:

```bash
# On the egress gateway node, add the stable egress IP
ip addr add 192.168.1.100/32 dev eth0

# Or use a systemd-networkd configuration:
cat > /etc/systemd/network/10-egress.network <<EOF
[Match]
Name=eth0

[Network]
Address=192.168.1.100/32
EOF
```

For AWS, assign an Elastic IP to the egress node and ensure the instance's ENI has that IP. For GKE, use an alias IP range.

### Verifying Egress Gateway Behavior

```bash
# Check egress gateway policy status
kubectl get ciliumbgppeeringpolicies  # if using BGP
kubectl get ciliumegressgatewaypolicies

# Test from a payments pod that the source IP is the gateway IP
kubectl exec -n payments deploy/payment-processor -- \
  curl -s https://api.ipify.org
# Should return 192.168.1.100

# Monitor traffic in Hubble
hubble observe --namespace payments --verdict REDIRECTED -f
```

## Hubble Observability Integration

Hubble is Cilium's built-in observability layer. It provides real-time visibility into network flows enforced by the eBPF programs.

### Hubble CLI Usage

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --fail --remote-name-all \
  https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward Hubble relay
cilium hubble port-forward &

# Observe all dropped flows
hubble observe --verdict DROPPED -f

# Observe flows for a specific namespace
hubble observe --namespace payments -f

# Observe HTTP flows
hubble observe --protocol http -f

# Observe flows to a specific pod
hubble observe --to-pod payments/payment-processor-abc123 -f

# Show L7 details
hubble observe --namespace payments --protocol http \
  --output jsonpb | jq '.flow.l7.http | {method, url, status_code}'
```

### Hubble UI with Grafana Dashboards

Hubble exposes Prometheus metrics. A useful recording rule:

```yaml
# hubble-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hubble-recording-rules
  namespace: monitoring
spec:
  groups:
    - name: hubble
      rules:
        - record: cilium:policy_drops:rate5m
          expr: |
            rate(hubble_drop_total[5m])

        - alert: CiliumPolicyDropRateHigh
          expr: |
            sum by (namespace, direction, reason) (
              rate(hubble_drop_total[5m])
            ) > 10
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High rate of Cilium policy drops"
            description: "Namespace {{ $labels.namespace }} {{ $labels.direction }} drops at {{ $value | humanize }}/s reason={{ $labels.reason }}"

        - alert: CiliumL7PolicyViolation
          expr: |
            sum by (namespace) (
              rate(hubble_http_responses_total{status=~"4.."}[5m])
            ) > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High rate of HTTP 4xx from Cilium L7 policy enforcement"
```

## Zero-Trust Network Policy Architecture

A complete zero-trust implementation starts with a default-deny posture:

```yaml
# default-deny-all.yaml
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: default-deny-all
spec:
  description: "Default deny all ingress and egress for all pods"
  endpointSelector: {}
  ingress:
    - fromEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
```

Then grant permissions explicitly per namespace and application:

```yaml
# namespace-baseline.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: baseline-ingress
  namespace: production
spec:
  endpointSelector: {}
  ingress:
    # Allow health checks from the load balancer
    - fromCIDR:
        - "10.0.0.0/8"
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/health"
              - method: "GET"
                path: "/ready"
```

## Troubleshooting Cilium Policies

### Policy Not Taking Effect

```bash
# Check if the policy was accepted
kubectl get cnp -n payments payments-api-policy -o yaml | grep -A5 status

# Check endpoint policy status
kubectl exec -n kube-system <cilium-pod> -- cilium endpoint list
kubectl exec -n kube-system <cilium-pod> -- \
  cilium endpoint get $(cilium endpoint list | grep payments-api | awk '{print $1}')

# Enable policy tracing for debugging
kubectl exec -n kube-system <cilium-pod> -- \
  cilium policy trace --src-k8s-pod payments:payment-frontend-xyz \
  --dst-k8s-pod payments:payments-api-abc --dport 8080
```

### L7 Policy Drops Without Reason

```bash
# Check if envoy proxy is running for the endpoint
kubectl exec -n kube-system <cilium-pod> -- \
  cilium status --brief

# Check envoy logs
kubectl logs -n kube-system <cilium-envoy-pod> --tail=50

# Inspect active policy in BPF map
kubectl exec -n kube-system <cilium-pod> -- \
  cilium bpf policy get <endpoint-id>
```

### FQDN Policy Not Resolving

```bash
# Check DNS proxy status
kubectl exec -n kube-system <cilium-pod> -- \
  cilium dns fqdn cache list

# Verify DNS traffic is going through Cilium proxy
kubectl exec -n payments <pod> -- \
  dig +short api.stripe.com
# Then check:
kubectl exec -n kube-system <cilium-pod> -- \
  cilium dns fqdn cache list | grep stripe

# Check if DNS redirect is configured
kubectl exec -n kube-system <cilium-pod> -- \
  cilium bpf redirect list
```

## Performance Considerations

eBPF programs add minimal overhead compared to iptables at scale. Benchmark data from production deployments:

- **L3/L4 policy enforcement**: ~1-3% overhead vs no-policy baseline
- **L7 HTTP policy**: ~5-15% overhead (Envoy proxy involvement)
- **FQDN policy**: ~2-5% overhead (DNS proxy)
- **Egress gateway**: ~3-8% overhead (additional routing step)

To minimize L7 overhead:
- Apply L7 policies only to endpoints that require them
- Use `toEndpoints` with label selectors rather than `toCIDR` where possible
- Enable connection tracking bypass for known-good high-volume flows

```yaml
# High-throughput service: only use L3/L4, not L7
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: high-throughput-data-pipeline
  namespace: data
spec:
  endpointSelector:
    matchLabels:
      app: kafka-consumer
      throughput-tier: high

  egress:
    # Use L3/L4 only for Kafka - no L7 overhead
    - toEndpoints:
        - matchLabels:
            app: kafka-broker
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
```

## Summary

Cilium's eBPF-based network security model provides capabilities that are impossible with iptables-based solutions:

- **L7 policies** enforce HTTP methods, paths, headers, and gRPC methods at the kernel level, eliminating the broad "allow port 443" attack surface
- **DNS-based filtering** tracks FQDN-to-IP mappings dynamically, making external allowlists resilient to IP changes without policy restarts
- **Egress gateway** provides stable, auditable egress points for workloads that require source IP whitelisting at external services

The combination of these three capabilities with Hubble's observability creates a network security posture that satisfies zero-trust architecture requirements for enterprise Kubernetes deployments without the operational overhead of a full service mesh for every use case.
