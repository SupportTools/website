---
title: "eBPF Network Policy: Cilium L3/L4/L7 Policy Implementation Deep Dive"
date: 2029-03-26T00:00:00-05:00
draft: false
tags: ["eBPF", "Cilium", "Kubernetes", "Network Policy", "Security", "Linux Networking"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical dive into Cilium's eBPF-based network policy enforcement, covering L3 identity-based policies, L4 port policies, L7 HTTP/gRPC-aware enforcement with Envoy, Hubble network observability, and production policy debugging workflows."
more_link: "yes"
url: "/ebpf-network-policy-cilium-l3-l4-l7-policy-deep-dive/"
---

Standard Kubernetes NetworkPolicy objects operate at L3/L4 using IP address and port matching. This works adequately when all traffic is plaintext and IP addresses are stable, but breaks down for service-to-service communication where pod IPs change constantly, mutual TLS is in use, and policy enforcement at the HTTP or gRPC method level is required.

Cilium replaces kube-proxy and implements network policy using eBPF programs attached to network device hooks. This eliminates iptables entirely, provides sub-microsecond policy enforcement, and enables L7-aware policies that can match HTTP paths, methods, gRPC service/method names, and Kafka topics. This guide examines how each policy layer is implemented and operated in production.

<!--more-->

## Cilium Architecture

Cilium's policy enforcement model is built on three components:

1. **eBPF programs** attached to `tc ingress`/`tc egress` hooks on each pod's virtual Ethernet interface (`veth`). These programs enforce L3 and L4 policies with nanosecond latency by making allow/deny decisions in the kernel without context switching.

2. **Envoy proxy** (started as a sidecar or as a DaemonSet process) handles L7 policy enforcement. When a CiliumNetworkPolicy includes L7 rules, Cilium redirects matching traffic through Envoy transparently.

3. **Cilium Agent** running as a DaemonSet pod on each node. It watches CiliumNetworkPolicy and CiliumClusterwideNetworkPolicy objects, compiles policy decisions to eBPF maps, and manages the Envoy configuration.

### Identity-Based Policy

Unlike standard NetworkPolicy which matches on IP addresses, Cilium assigns **security identities** to pods based on their labels. These identities are small integers stored in eBPF maps. The eBPF policy program looks up the source identity from the packet's source IP and compares it against the allowed-identity set.

```bash
# View identities in the cluster
cilium identity list

# Example output:
# ID       LABELS
# 1        reserved:world
# 2        reserved:host
# 100      k8s:app=api-server,k8s:io.kubernetes.pod.namespace=production
# 101      k8s:app=worker,k8s:io.kubernetes.pod.namespace=production
# 102      k8s:app=postgres,k8s:io.kubernetes.pod.namespace=production

# View the policy map for a specific endpoint
ENDPOINT_ID=$(cilium endpoint list | grep api-server | awk '{print $1}' | head -1)
cilium bpf policy get "$ENDPOINT_ID"
```

---

## Installing Cilium

```bash
# Install Cilium with kube-proxy replacement and Hubble enabled
helm repo add cilium https://helm.cilium.io
helm repo update

helm upgrade --install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.15.6 \
  --set kubeProxyReplacement=strict \
  --set k8sServiceHost=api.acme-cluster.internal \
  --set k8sServicePort=6443 \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.enabled=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,icmp,http}" \
  --set prometheus.enabled=true \
  --set operator.prometheus.enabled=true \
  --set policyEnforcementMode=default

# Verify installation
cilium status --wait
cilium connectivity test
```

---

## L3 Identity Policies

L3 policies control which **identities** (label sets) may communicate, independent of IP addresses.

### Deny All by Default, Allow Specific Services

```yaml
# Apply a default-deny policy to the production namespace
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  endpointSelector: {}
  ingress:
    - {}
  egress:
    - {}
  # An empty ingress/egress rule set with endpointSelector: {} denies all traffic
  # to/from all endpoints in the namespace.
```

Wait—the Cilium policy model is **additive**. An empty `ingress: [{}]` does not deny; it allows all ingress. The correct deny-all syntax requires a policy that matches but has no rules:

```yaml
# Correct default-deny for Cilium: select all endpoints, allow nothing
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: production
spec:
  endpointSelector: {}
  ingress: []
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: default-deny-egress
  namespace: production
spec:
  endpointSelector: {}
  egress: []
```

### Allow Specific Service-to-Service Communication

```yaml
# Allow the api-server to receive traffic only from the ingress controller
# and from within the production namespace on specific ports.
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-server-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  ingress:
    - fromEndpoints:
        - matchLabels:
            app.kubernetes.io/name: ingress-nginx
            io.kubernetes.pod.namespace: ingress-nginx
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: production
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
              # Allow Prometheus scraping from monitoring namespace
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: monitoring
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
  egress:
    - toEndpoints:
        - matchLabels:
            app: postgres
            io.kubernetes.pod.namespace: production
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
    - toEndpoints:
        - matchLabels:
            k8s-app: kube-dns
            io.kubernetes.pod.namespace: kube-system
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP
```

The `io.kubernetes.pod.namespace` label is automatically injected by Cilium and enables cross-namespace matching without knowing IP addresses.

---

## L4 Port Policies and Protocol Enforcement

L4 policies can restrict by port and protocol. Cilium also supports protocol-specific parsing:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: redis-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: redis
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: production
      toPorts:
        - ports:
            - port: "6379"
              protocol: TCP
          # Optional: parse as Redis protocol for L7 policy enforcement
          # rules:
          #   kafka: ...
  egress: []
```

---

## L7 HTTP Policy

L7 HTTP policies redirect matching traffic through Envoy. The Cilium agent installs an eBPF socket redirect rule that transparently proxies connections to Envoy on localhost.

```yaml
# Enforce HTTP-level access control on the api-server
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-server-http-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend
            io.kubernetes.pod.namespace: production
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Allow GET /api/v1/users and its sub-paths
              - method: GET
                path: "^/api/v1/users(/.*)?$"
              # Allow POST /api/v1/orders only
              - method: POST
                path: "^/api/v1/orders$"
                headers:
                  - "X-Tenant-ID: [a-zA-Z0-9-]{36}"
    - fromEndpoints:
        - matchLabels:
            app: admin-console
            io.kubernetes.pod.namespace: production
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Admin console gets broader access
              - method: "(GET|POST|PUT|DELETE|PATCH)"
                path: "^/api/.*"
```

### L7 gRPC Policy

For gRPC services, Cilium can match on service and method names:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: user-service-grpc-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: user-service
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: api-gateway
            io.kubernetes.pod.namespace: production
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          rules:
            http:
              # gRPC uses HTTP/2; match the gRPC path format: /package.Service/Method
              - method: POST
                path: "^/acme.user.v1.UserService/(GetUser|ListUsers|CreateUser)$"
              - method: POST
                path: "^/grpc.health.v1.Health/Check$"
```

---

## Hubble: Network Observability

Hubble is the observability layer built on top of Cilium. It exposes flow-level visibility for all traffic processed by Cilium eBPF programs.

```bash
# Install Hubble CLI
HUBBLE_VERSION=v0.13.0
curl -L --fail --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward to Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe all flows in the production namespace
hubble observe \
  --namespace production \
  --follow \
  --output json \
  | jq '{
    source: .source.pod_name,
    dest: .destination.pod_name,
    verdict: .verdict,
    type: .type,
    l7: .l7
  }'

# Show only dropped flows (policy violations)
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --follow
```

### Debugging Policy Violations

```bash
# Find why a specific connection is being dropped
hubble observe \
  --from-pod production/frontend-7d9f6b \
  --to-pod production/api-server-abc123 \
  --verdict DROPPED \
  --last 100

# Check the policy state of an endpoint
ENDPOINT=$(cilium endpoint list | grep "api-server" | awk '{print $1}' | head -1)
cilium endpoint get "$ENDPOINT"

# View the compiled policy map
cilium bpf policy get "$ENDPOINT" -n

# Test connectivity with policy tracing
cilium policy trace \
  --src-k8s-pod production/frontend-7d9f6b \
  --dst-k8s-pod production/api-server-abc123 \
  --dport 8080
```

---

## CiliumClusterwideNetworkPolicy for Platform-Level Rules

`CiliumClusterwideNetworkPolicy` (CCNP) applies across all namespaces and is appropriate for platform-level rules that cannot be bypassed by namespace operators:

```yaml
# Block all pods from accessing the AWS metadata endpoint
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: block-aws-metadata
spec:
  endpointSelector: {}
  egressDeny:
    - toCIDR:
        - 169.254.169.254/32
      toPorts:
        - ports:
            - port: "80"
              protocol: TCP
            - port: "443"
              protocol: TCP
---
# Allow kube-system components to communicate with the Kubernetes API
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: allow-system-to-apiserver
spec:
  endpointSelector:
    matchLabels:
      io.kubernetes.pod.namespace: kube-system
  egress:
    - toEntities:
        - kube-apiserver
      toPorts:
        - ports:
            - port: "6443"
              protocol: TCP
```

---

## Performance Characteristics

```bash
# Measure policy enforcement overhead using netperf
# Without Cilium policy (baseline):
kubectl exec -it netperf-client -n testing -- netperf -H netperf-server.testing.svc -l 30
# Throughput: 9,850 Mbit/s  Latency: 0.023 ms

# With L3/L4 Cilium policy (eBPF enforcement):
# Throughput: 9,720 Mbit/s  Latency: 0.025 ms
# Overhead: ~1.3% throughput, ~0.002ms latency

# With L7 HTTP policy (Envoy proxy):
# Throughput: 3,200 Mbit/s  Latency: 0.18 ms
# Overhead: ~67% throughput, ~0.16ms latency (Envoy proxy overhead)
```

L7 policies have significant overhead because traffic must traverse Envoy. Use L7 policies selectively for services where HTTP-level access control is required; use L3/L4 policies for all other services.

---

## Prometheus Metrics and Alerting

```yaml
# Alert on high policy drop rates
groups:
  - name: cilium-policy
    rules:
      - alert: CiliumHighDropRate
        expr: |
          sum(rate(hubble_drop_total[5m])) by (namespace, direction, reason) > 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "High packet drop rate in {{ $labels.namespace }}"
          description: "Direction: {{ $labels.direction }}, Reason: {{ $labels.reason }}. Check policy configuration."

      - alert: CiliumPolicyMapPressure
        expr: |
          cilium_bpf_map_capacity{map_name="cilium_policy"} /
          cilium_bpf_map_max_capacity{map_name="cilium_policy"} > 0.85
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Cilium policy BPF map is {{ $value | humanizePercentage }} full"
```

---

## Summary

Cilium's eBPF-based policy enforcement provides three enforcement tiers:

- **L3 identity policies**: Allow/deny based on pod label sets (security identities), not IP addresses. Eliminates IP-based policy churn as pods scale. Near-zero overhead via eBPF map lookups.

- **L4 port policies**: Restrict communication to specific TCP/UDP ports. Combines with L3 identity rules. Sub-microsecond enforcement in the kernel.

- **L7 application policies**: HTTP path/method matching and gRPC service/method enforcement via Envoy. Significant latency overhead (~0.15ms per request); use selectively.

Hubble provides the observability needed to understand and debug policy behavior without inserting debug pods. The `cilium policy trace` command simulates policy evaluation for a given source/destination pair, enabling pre-deployment policy validation. For platform teams, `CiliumClusterwideNetworkPolicy` enforces cluster-wide security invariants that namespace operators cannot override.
