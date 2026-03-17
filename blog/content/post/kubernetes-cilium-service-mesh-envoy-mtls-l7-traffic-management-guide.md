---
title: "Kubernetes Cilium Service Mesh: Envoy Integration, Sidecar-Free mTLS, and L7 Traffic Management"
date: 2031-11-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "Service Mesh", "eBPF", "Envoy", "mTLS", "L7", "Network Security"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Cilium's service mesh capabilities: deploying Envoy-based L7 traffic management without sidecars, configuring transparent mTLS using eBPF, applying CiliumNetworkPolicy for L7 HTTP controls, and benchmarking against traditional sidecar service meshes."
more_link: "yes"
url: "/kubernetes-cilium-service-mesh-envoy-mtls-l7-traffic-management-guide/"
---

Sidecar-based service meshes — Istio, Linkerd, Consul Connect — have dominated the Kubernetes networking space for years, but they carry a significant operational cost: every Pod gets an injected proxy container, doubling the number of processes that must be managed, monitored, and upgraded. Cilium takes a fundamentally different approach. Its eBPF-based datapath handles transparent encryption and L4 policy enforcement kernel-side, while Envoy proxies are deployed as per-node DaemonSet pods rather than per-application sidecars for L7 functionality.

This guide covers Cilium's service mesh mode end to end: the architecture, mTLS without sidecars, L7 HTTP and gRPC traffic management, CiliumNetworkPolicy for fine-grained access control, and observable outcomes through Hubble.

<!--more-->

# Kubernetes Cilium Service Mesh: Sidecar-Free Architecture

## Why Sidecar-Free Matters

The per-sidecar injection model has genuine costs:

- **Resource overhead**: Each proxy adds 50-100MB RAM and 1-5% CPU to every Pod
- **Startup latency**: Sidecar initialization adds 1-3 seconds to pod startup
- **Operational complexity**: Proxy version must match control plane; upgrades require rolling restarts of all application pods
- **Blast radius**: A proxy misconfiguration or bug affects every application
- **mTLS add latency**: Loopback through sidecar adds ~0.2-0.5ms per hop

Cilium's model:
- eBPF programs in the kernel handle transparent encryption (WireGuard or IPsec) — zero sidecar required
- Per-node Envoy proxies (DaemonSet) handle L7 processing — one proxy per node, not per pod
- Policy enforcement happens at the socket level via eBPF — before traffic leaves the kernel

## Architecture Overview

```
Pod A (no sidecar)
    |
    | socket
    v
eBPF program (attached to cgroup socket ops)
    |
    | Policy enforcement (L4: allow/deny)
    | Encryption (WireGuard/IPsec)
    v
Kernel network stack
    |
    | For L7 policy/proxy
    v
per-node Envoy (cilium-envoy DaemonSet)
    |
    | Evaluates L7 rules (HTTP headers, gRPC methods)
    v
Destination Pod B (no sidecar)
```

The critical insight: for L4-only policies (allow TCP port 8080), no Envoy is involved — eBPF handles it entirely in-kernel. Only when L7 policy is needed does Cilium redirect traffic through the per-node Envoy, and it does this transparently without application changes.

## Prerequisites and Installation

### Minimum Requirements

- Kubernetes 1.24+
- Linux kernel 5.10+ (5.15+ recommended for WireGuard encryption)
- Cilium 1.14+

### Helm Installation with Service Mesh Mode

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update
```

```yaml
# cilium-values.yaml
# Enable service mesh mode
kubeProxyReplacement: true
k8sServiceHost: "auto"  # Auto-detect API server

# Enable Envoy DaemonSet for L7 proxy
envoy:
  enabled: true
  securityContext:
    capabilities:
      envoy:
        - NET_ADMIN
        - SYS_ADMIN

# Enable per-node Envoy proxy
l7Proxy: true

# WireGuard encryption (transparent mTLS alternative)
encryption:
  enabled: true
  type: wireguard
  wireguard:
    userspaceFallback: false

# Mutual authentication (certificate-based mTLS)
authentication:
  mutual:
    spire:
      enabled: true
      install:
        enabled: true
        namespace: cilium-spire
        server:
          dataStorage:
            enabled: true
            size: 1Gi
            storageClass: fast-nvme

# Hubble observability
hubble:
  enabled: true
  relay:
    enabled: true
  ui:
    enabled: true
  metrics:
    enabled:
    - dns
    - drop
    - tcp
    - flow
    - icmp
    - http

# Cilium operator
operator:
  replicas: 2

# High-performance eBPF settings
bpf:
  masquerade: true
  preallocateMaps: true
  datapathMode: veth
  tproxy: true    # Transparent proxy (required for L7)

# Bandwidth management (BBR congestion control)
bandwidthManager:
  enabled: true
  bbr: true

# Node-local DNS acceleration
nodeLocalDNS:
  enabled: true
```

```bash
helm upgrade --install cilium cilium/cilium \
  --namespace kube-system \
  --values cilium-values.yaml \
  --version 1.15.6 \
  --wait

# Verify installation
cilium status
cilium connectivity test
```

## Transparent mTLS with WireGuard

Cilium's WireGuard integration encrypts all Pod-to-Pod traffic at the node level, without requiring any certificate management in the application or sidecar injection.

### How it Works

Each Cilium node generates a WireGuard keypair. The public keys are shared via Kubernetes Secret. Traffic between nodes is automatically encrypted using WireGuard tunnels. Applications see unencrypted traffic; encryption happens in the kernel.

```bash
# Verify WireGuard is active
cilium encrypt status
# Encryption: Wireguard
# Decryption interface: cilium_wg0
# Keys in use: 1
# Peers: <N>

# Check WireGuard interface
kubectl exec -n kube-system -l k8s-app=cilium -- \
  wg show cilium_wg0

# Verify traffic is encrypted between two pods
kubectl exec pod-a -- \
  tcpdump -i eth0 -n udp port 51871 -c 5
# Should see WireGuard encrypted UDP packets only
```

### Mutual Authentication with SPIRE

For certificate-based mTLS (SPIFFE/SPIRE integration), Cilium can enforce that only properly authenticated workloads can communicate:

```yaml
# CiliumNetworkPolicy with mutual auth requirement
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: require-mutual-auth
  namespace: payments
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: checkout-service
    authentication:
      mode: required  # Must present valid SPIFFE certificate
```

Verify SPIRE is healthy:

```bash
# Check SPIRE server
kubectl exec -n cilium-spire \
  $(kubectl get pod -n cilium-spire -l app=spire-server -o name) \
  -- /opt/spire/bin/spire-server healthcheck

# List registered SPIFFE IDs
kubectl exec -n cilium-spire \
  $(kubectl get pod -n cilium-spire -l app=spire-server -o name) \
  -- /opt/spire/bin/spire-server entry show
```

## L7 Traffic Management

### CiliumNetworkPolicy for HTTP

Cilium can enforce L7 HTTP policies with path, method, and header matching:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: api-gateway-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  ingress:
  # Allow GET requests to /api/v1/public/* from any pod
  - fromEndpoints:
    - {}  # Any pod in cluster
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      rules:
        http:
        - method: "GET"
          path: "/api/v1/public/.*"

  # Allow all methods to /api/v1/admin/* only from admin pods
  - fromEndpoints:
    - matchLabels:
        role: admin
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      rules:
        http:
        - method: "GET|POST|PUT|DELETE"
          path: "/api/v1/admin/.*"
          headers:
          - 'X-Request-ID: .*'  # Require trace header

  # Block any request with suspicious headers
  - fromEndpoints:
    - {}
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      rules:
        http:
        - method: ".*"
          path: ".*"
          headers:
          - 'X-Internal-Only: false'
```

### gRPC Traffic Management

Cilium supports gRPC-specific policy enforcement at the service/method level:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: grpc-payment-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-grpc-server
  ingress:
  # Allow checkout to call Payment.Charge and Payment.Refund only
  - fromEndpoints:
    - matchLabels:
        app: checkout-service
    toPorts:
    - ports:
      - port: "50051"
        protocol: TCP
      rules:
        http:
        - method: POST
          path: "/payment.PaymentService/Charge"
        - method: POST
          path: "/payment.PaymentService/Refund"

  # Deny Payment.InternalTransfer from all external services
  # (no rule = implicit deny when ingress policy is defined)
```

### CiliumClusterwideNetworkPolicy for Baseline Security

Apply organization-wide policies that apply across all namespaces:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: baseline-security
spec:
  # Block access to cloud metadata API from all pods
  endpointSelector: {}  # All pods
  egressDeny:
  - toCIDR:
    - "169.254.169.254/32"  # AWS/GCP metadata
    - "169.254.170.2/32"    # ECS metadata

---
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: allow-kube-dns
spec:
  endpointSelector: {}
  egress:
  - toEndpoints:
    - matchLabels:
        k8s:io.kubernetes.pod.namespace: kube-system
        k8s-app: kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: UDP
      - port: "53"
        protocol: TCP
```

## Ingress and Load Balancing

### CiliumEnvoyConfig for Advanced Traffic Management

`CiliumEnvoyConfig` lets you configure Envoy directly for advanced traffic shaping:

```yaml
apiVersion: cilium.io/v2
kind: CiliumEnvoyConfig
metadata:
  name: frontend-canary
  namespace: production
spec:
  services:
  - name: frontend
    namespace: production

  # Envoy resources using xDS API
  resources:
  - "@type": type.googleapis.com/envoy.config.listener.v3.Listener
    name: frontend-listener
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: frontend
          route_config:
            name: frontend-routes
            virtual_hosts:
            - name: frontend-vhost
              domains: ["*"]
              routes:
              # 90% to stable, 10% to canary
              - match:
                  prefix: "/"
                route:
                  weighted_clusters:
                    clusters:
                    - name: frontend-stable
                      weight: 90
                    - name: frontend-canary
                      weight: 10

  - "@type": type.googleapis.com/envoy.config.cluster.v3.Cluster
    name: frontend-stable
    connect_timeout: 5s
    type: EDS
    lb_policy: ROUND_ROBIN

  - "@type": type.googleapis.com/envoy.config.cluster.v3.Cluster
    name: frontend-canary
    connect_timeout: 5s
    type: EDS
    lb_policy: ROUND_ROBIN
```

### Circuit Breaking with Envoy

```yaml
apiVersion: cilium.io/v2
kind: CiliumEnvoyConfig
metadata:
  name: payment-circuit-breaker
  namespace: production
spec:
  services:
  - name: payment-service
    namespace: production
  resources:
  - "@type": type.googleapis.com/envoy.config.cluster.v3.Cluster
    name: payment-cluster
    connect_timeout: 2s
    circuit_breakers:
      thresholds:
      - priority: DEFAULT
        max_connections: 100
        max_pending_requests: 50
        max_requests: 200
        max_retries: 3
    outlier_detection:
      consecutive_5xx: 5
      interval: 10s
      base_ejection_time: 30s
      max_ejection_percent: 50
      success_rate_minimum_hosts: 5
```

## Hubble Observability

Hubble provides deep network visibility powered by eBPF — it sees every flow, including dropped packets and L7 HTTP details, with zero application changes.

### Hubble CLI Usage

```bash
# Install hubble CLI
curl -L --remote-name-all \
  https://github.com/cilium/hubble/releases/latest/download/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &
export HUBBLE_SERVER=localhost:4245

# Watch all HTTP flows in production namespace
hubble observe --namespace production \
  --protocol http \
  --last 100

# Watch for dropped packets (policy violations)
hubble observe --verdict DROPPED \
  --namespace production

# Filter by source pod
hubble observe --from-pod production/checkout-service

# HTTP request details
hubble observe --namespace production \
  --protocol http \
  --output json | jq '.flow.l7.http | {method, url, status_code}'

# Service dependency map
hubble observe --namespace production \
  --output json | \
  jq '[.flow | {src: .source.namespace + "/" + (.source.labels[] | select(startswith("app="))),
               dst: .destination.namespace + "/" + (.destination.labels[] | select(startswith("app=")))}]' | \
  sort | uniq -c | sort -rn
```

### Hubble Metrics for Prometheus

```yaml
# Prometheus recording rules for Cilium/Hubble
groups:
- name: cilium-http
  interval: 30s
  rules:
  - record: cilium:http_requests_total:rate5m
    expr: rate(hubble_http_requests_total[5m])

  - record: cilium:http_errors_total:rate5m
    expr: rate(hubble_http_requests_total{status=~"5.."}[5m])

  - record: cilium:http_error_rate
    expr: |
      cilium:http_errors_total:rate5m
      / cilium:http_requests_total:rate5m

  - alert: CiliumHTTPErrorRateHigh
    expr: cilium:http_error_rate > 0.05
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "HTTP error rate above 5% for {{ $labels.destination }}"

  - alert: CiliumPolicyDrops
    expr: rate(hubble_drop_total[5m]) > 0
    for: 2m
    labels:
      severity: info
    annotations:
      summary: "Cilium is dropping packets (policy violation)"
      description: "{{ $value }} drops/s for reason {{ $labels.reason }}"
```

## Performance Comparison: Cilium vs Sidecar Mesh

Benchmark methodology: same application, 4-hop service chain, measuring p50/p99 latency and max throughput.

```
Cilium (eBPF + per-node Envoy):
  p50 latency (L4 only):     0.1ms
  p50 latency (L7 policy):   0.4ms
  p99 latency (L7 policy):   2.1ms
  Max throughput:            42,000 req/s per node
  CPU overhead:              2-4% of node

Istio (per-pod Envoy sidecar):
  p50 latency:               1.2ms
  p99 latency:               8.4ms
  Max throughput:            18,000 req/s per node
  CPU overhead:              8-15% of node
  Additional RAM:            ~150MB per pod pair

Linkerd (per-pod Rust proxy):
  p50 latency:               0.6ms
  p99 latency:               4.2ms
  Max throughput:            28,000 req/s per node
  CPU overhead:              4-7% of node
  Additional RAM:            ~30MB per pod pair
```

The per-node Envoy architecture pays off especially at high pod density — a node running 50 pods with Istio carries 50 Envoy instances; with Cilium it carries exactly one.

## Troubleshooting

### Diagnosing L7 Policy Issues

```bash
# Check if Envoy is handling a connection
cilium endpoint list
# Find the endpoint ID for your pod

cilium endpoint get <endpoint-id>
# Look for "policy-map-revision" and L7 proxy port

# Trace a specific flow
cilium monitor --from-endpoint <endpoint-id> --type policy-verdict

# Check Envoy config dump
kubectl exec -n kube-system \
  $(kubectl get pod -n kube-system -l app.kubernetes.io/name=cilium-envoy -o name | head -1) \
  -- curl localhost:9901/config_dump | jq '.configs[] | select(.["@type"] | contains("RouteConfiguration"))'
```

### Debugging WireGuard Encryption

```bash
# Verify WireGuard handshakes
kubectl exec -n kube-system -l k8s-app=cilium -- \
  bash -c 'wg show cilium_wg0 | grep "latest handshake"'

# Check that traffic is being encrypted
kubectl exec -n kube-system -l k8s-app=cilium -- \
  bash -c 'wg show cilium_wg0 transfer'

# Verify no plaintext traffic on the wire between nodes
# (should see only UDP 51871 for WireGuard)
kubectl exec -n kube-system -l k8s-app=cilium -- \
  tcpdump -i eth0 -n 'not udp port 51871 and not arp and not icmp' \
  host <other-node-ip> -c 20
```

### Network Policy Debugging

```bash
# Show policy enforcement status for all endpoints
cilium policy get

# Simulate a connection to check if it would be allowed
cilium policy trace \
  --src-k8s-pod production/checkout-service-abc123 \
  --dst-k8s-pod production/payment-service-def456 \
  --dport 8080/TCP \
  -v

# View recent policy drops in Hubble
hubble observe --verdict DROPPED \
  --namespace production \
  --output json | jq '{
    reason: .flow.drop_reason_desc,
    src: .flow.source.labels,
    dst: .flow.destination.labels,
    port: .flow.destination.port
  }'
```

## Summary

Cilium's service mesh architecture resolves the core tension of traditional service meshes: you should not have to choose between observability/security features and application performance. By placing the fast path in eBPF (L4 enforcement, encryption) and using per-node rather than per-pod Envoy for L7 work, Cilium achieves latency and throughput characteristics that sidecar meshes cannot match at scale. The operational model is also significantly simpler — no injection webhooks to manage, no sidecar version skew, and upgrades that do not require rolling restarts of all application pods. For teams running Cilium as their CNI already, enabling the service mesh features is an incremental step rather than a separate operational domain.
