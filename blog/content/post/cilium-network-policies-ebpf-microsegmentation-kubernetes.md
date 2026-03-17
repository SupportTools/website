---
title: "Cilium Network Policies: Advanced eBPF-Based Microsegmentation for Kubernetes"
date: 2030-06-03T00:00:00-05:00
draft: false
tags: ["Cilium", "Kubernetes", "eBPF", "Network Policy", "Hubble", "Microsegmentation", "Security"]
categories:
- Kubernetes
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Cilium network policies beyond basic L3/L4: L7 HTTP/gRPC policies, FQDN-based egress, CiliumClusterwideNetworkPolicy, Hubble observability integration, and production policy management."
more_link: "yes"
url: "/cilium-network-policies-ebpf-microsegmentation-kubernetes/"
---

Cilium transforms Kubernetes network policy from a blunt instrument into a surgical tool. Built on eBPF, it enforces policies at the kernel level without the overhead of userspace proxies, enabling L7-aware microsegmentation that standard `NetworkPolicy` objects cannot approach. This guide covers the production patterns that matter: hierarchical policy models, FQDN-based egress control, HTTP/gRPC method-level enforcement, and the Hubble observability layer that makes policy debugging tractable.

<!--more-->

## Why Cilium Network Policy Supersedes Standard Kubernetes NetworkPolicy

Standard Kubernetes `NetworkPolicy` operates exclusively at L3/L4. It can restrict traffic based on IP addresses, CIDR blocks, ports, and pod selectors — nothing more. This is adequate for basic isolation but falls short in three common enterprise scenarios:

1. **Service-to-service authentication** — Policies must restrict not just which pods can reach a service, but which HTTP methods or gRPC RPCs are permitted, preventing a compromised pod from calling destructive endpoints.
2. **Egress to external services** — Blocking egress by IP is unworkable when SaaS endpoints use dynamic IPs or shared CDNs. DNS name-based policies are required.
3. **Cluster-wide enforcement** — Standard `NetworkPolicy` is namespace-scoped. Platform teams cannot define policies that apply across all namespaces without copying objects into every namespace.

Cilium's `CiliumNetworkPolicy` (CNP) and `CiliumClusterwideNetworkPolicy` (CCNP) address all three gaps while leveraging eBPF for kernel-native enforcement.

## Cilium Architecture and Policy Enforcement Model

### How eBPF Enforcement Works

When Cilium is installed, it attaches eBPF programs to the tc (traffic control) hooks on every pod's veth interface. These programs evaluate policy decisions in-kernel before packets reach the pod's network stack — no iptables chains, no userspace proxy round-trips.

Each pod receives a numeric **security identity** derived from its labels. Cilium agents distribute identity-to-policy mappings across all nodes via a distributed key-value store (etcd or the Cilium KVStore abstraction). When a packet arrives, the eBPF program looks up the source identity and evaluates the applicable policy in microseconds.

For L7 policies, Cilium injects an Envoy proxy as a sidecar or uses its integrated Envoy implementation. The eBPF program redirects matching flows to Envoy, which enforces the HTTP/gRPC rules, then forwards allowed traffic to the destination.

### Policy Priority and Precedence

Cilium uses a **default-deny-per-selector** model with explicit allowances:

- If any ingress or egress policy selects a pod, all non-matching traffic in that direction is denied.
- Multiple CNP/CCNP objects can select the same pod; their rules are unioned (OR logic within the same direction).
- `CiliumClusterwideNetworkPolicy` rules are additive with namespace-scoped `CiliumNetworkPolicy` rules.

This differs subtly from standard `NetworkPolicy`: a CCNP that allows traffic does not cancel a CNP that denies the same traffic on a different pod selector, because selectors are evaluated independently.

## Installing Cilium with Required Features

### Helm Installation for Production

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.15.3 \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<api-server-ip> \
  --set k8sServicePort=6443 \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,port-distribution,icmp,http}" \
  --set l7Proxy=true \
  --set policyEnforcementMode=default \
  --set ipam.mode=cluster-pool \
  --set ipam.operator.clusterPoolIPv4PodCIDRList="10.244.0.0/16" \
  --set operator.replicas=2 \
  --set prometheus.enabled=true \
  --set operator.prometheus.enabled=true
```

### Verifying the Installation

```bash
# Check Cilium pod status
kubectl -n kube-system get pods -l k8s-app=cilium

# Verify eBPF programs are loaded
kubectl -n kube-system exec ds/cilium -- cilium status --verbose

# Check L7 proxy is enabled
kubectl -n kube-system exec ds/cilium -- cilium config | grep l7-proxy
```

Expected output from `cilium status`:
```
KVStore:                Ok   etcd: 3/3 connected
Kubernetes:             Ok   1.29 (v1.29.2)
Kubernetes Node Name:   node-1
L7 Proxy:               Ok
Hubble:                 Ok   Current/Max Flows: 8192/8192, Flows/s: 412.85/s
ClusterMesh:            Disabled
```

## Basic L3/L4 Policies: Foundation Before L7

### Default Deny All

Establishing a default-deny posture is the foundation of any microsegmentation strategy:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  endpointSelector: {}  # Matches all pods in namespace
  ingress:
    - fromEntities:
        - host          # Allow health checks from node
  egress:
    - toEntities:
        - kube-apiserver  # Allow API server access
    - toEntities:
        - host          # Allow DNS via node
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

### Pod-to-Pod L3/L4 Policy

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: allow-frontend-to-backend
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend
      tier: api
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend
            tier: web
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
    - fromEndpoints:
        - matchLabels:
            app: prometheus
            namespace: monitoring
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
```

### Cross-Namespace Policy

Cilium CNP can reference pods in other namespaces using the special `k8s:io.kubernetes.pod.namespace` label:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: allow-monitoring-scrape
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      metrics: "true"
  ingress:
    - fromEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: monitoring
            app.kubernetes.io/name: prometheus
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
            - port: "9091"
              protocol: TCP
```

## L7 HTTP Policies

L7 policies require Cilium's integrated Envoy proxy. When a policy includes L7 rules, Cilium transparently redirects matching flows through Envoy for inspection.

### HTTP Method and Path Restrictions

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: payment-service-l7
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: order-service
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "POST"
                path: "/api/v1/payments"
              - method: "GET"
                path: "/api/v1/payments/[0-9]+"
              - method: "GET"
                path: "/health"
              - method: "GET"
                path: "/metrics"
    - fromEndpoints:
        - matchLabels:
            app: admin-service
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/api/v1/payments(/.*)?$"
              - method: "POST"
                path: "/api/v1/payments"
              - method: "DELETE"
                path: "/api/v1/payments/[0-9]+"
              - method: "PUT"
                path: "/api/v1/payments/[0-9]+"
```

### HTTP Header-Based Policies

Cilium can enforce policies based on HTTP headers, enabling tenant isolation or canary routing:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: tenant-isolation-http
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: multi-tenant-api
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: tenant-a-frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/api/.*"
                headers:
                  - "X-Tenant-ID: tenant-a"
              - method: "POST"
                path: "/api/.*"
                headers:
                  - "X-Tenant-ID: tenant-a"
```

### L7 Kafka Policy

Cilium supports Kafka protocol inspection for topic-level access control:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: kafka-topic-acl
  namespace: data-platform
spec:
  endpointSelector:
    matchLabels:
      app: kafka
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: order-producer
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: "produce"
                topic: "orders"
              - role: "produce"
                topic: "order-events"
    - fromEndpoints:
        - matchLabels:
            app: order-consumer
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: "consume"
                topic: "orders"
              - role: "consume"
                topic: "order-events"
```

## L7 gRPC Policies

gRPC is a binary protocol over HTTP/2. Cilium can parse the `:path` pseudo-header to identify gRPC service methods:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: grpc-service-policy
  namespace: production
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
              - method: "POST"
                path: "/com.example.UserService/GetUser"
              - method: "POST"
                path: "/com.example.UserService/ListUsers"
              - method: "POST"
                path: "/grpc.health.v1.Health/Check"
    - fromEndpoints:
        - matchLabels:
            app: admin-console
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          rules:
            http:
              - method: "POST"
                path: "/com.example.UserService/.*"
              - method: "POST"
                path: "/com.example.AdminService/.*"
```

## FQDN-Based Egress Policies

DNS-based egress control solves the problem of controlling access to external services whose IPs change frequently.

### How FQDN Policy Works

Cilium intercepts DNS responses and dynamically updates policy with the resolved IPs. The eBPF programs enforce based on these dynamically maintained IP sets, with configurable TTL handling.

### Basic FQDN Egress Policy

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: allow-external-apis
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-processor
  egress:
    # Allow DNS resolution first
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
    # Allow specific external SaaS endpoints
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.paypal.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
    # Allow pattern matching for AWS endpoints
    - toFQDNs:
        - matchPattern: "*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
    # Allow internal services by DNS name
    - toFQDNs:
        - matchName: "postgres.internal.example.com"
        - matchName: "redis.internal.example.com"
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
            - port: "6379"
              protocol: TCP
```

### FQDN with HTTP Inspection

Combine FQDN targeting with L7 inspection for encrypted external traffic (requires TLS termination or trust-on-first-use):

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: github-api-restricted
  namespace: ci-system
spec:
  endpointSelector:
    matchLabels:
      app: ci-runner
  egress:
    - toFQDNs:
        - matchName: "api.github.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
```

### DNS Policy Enforcement Mode

Configure how Cilium handles DNS responses to prevent TOCTOU races:

```yaml
# cilium-config ConfigMap
data:
  # Restrict to only observed DNS names; drops packets to unresolved IPs
  tofqdns-enable-poller: "true"
  # How long to keep IPs after DNS TTL expires
  tofqdns-min-ttl: "3600"
  # Maximum number of IPs per FQDN entry
  tofqdns-max-deferred-connection-deletes: "100"
```

## CiliumClusterwideNetworkPolicy

`CiliumClusterwideNetworkPolicy` (CCNP) is a cluster-scoped resource that applies policies across all namespaces without duplication. Platform teams use CCNP to enforce baseline security postures.

### Baseline Cluster Security Policy

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: baseline-cluster-security
spec:
  # Apply to all pods cluster-wide
  endpointSelector: {}
  egress:
    # All pods must reach kube-dns
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
    # All pods can reach the Kubernetes API server
    - toEntities:
        - kube-apiserver
  ingress:
    # Allow Kubernetes health checks from nodes
    - fromEntities:
        - host
      toPorts:
        - ports:
            - port: "10250"
              protocol: TCP
```

### Protecting the Control Plane

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: protect-control-plane
spec:
  # Target control plane components
  endpointSelector:
    matchExpressions:
      - key: "k8s:io.kubernetes.pod.namespace"
        operator: In
        values:
          - kube-system
          - cert-manager
          - monitoring
  ingress:
    # Only allow access from pods in approved namespaces
    - fromEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
    - fromEntities:
        - host
        - remote-node
  egress:
    - toEntities:
        - world
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
```

### Node-to-Node Communication Policy

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: allow-node-communication
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux
  egress:
    - toEntities:
        - remote-node
    - toEntities:
        - host
  ingress:
    - fromEntities:
        - remote-node
    - fromEntities:
        - host
```

## Hubble Observability Integration

Hubble is Cilium's built-in observability layer. It captures flow-level data using eBPF ring buffers and provides both a CLI and a Prometheus metrics interface.

### Installing the Hubble CLI

```bash
# Download and install hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -LO "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/

# Port-forward Hubble relay for CLI access
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Verify Hubble connectivity
hubble status --server localhost:4245
```

### Flow Observation Commands

```bash
# Watch all flows in a namespace
hubble observe --namespace production --follow

# Filter by pod
hubble observe --pod production/payment-service --follow

# Filter dropped flows (policy violations)
hubble observe --verdict DROPPED --follow

# Show L7 HTTP flows
hubble observe --type l7 --protocol http --namespace production

# Observe flows between specific pods
hubble observe \
  --from-pod production/frontend \
  --to-pod production/backend \
  --follow

# JSON output for log aggregation
hubble observe --namespace production --output json | jq .

# Show policy audit events
hubble observe --type policy-verdict --follow
```

### Policy Audit Mode

Before enforcing a new policy, run it in audit mode to see what would be dropped:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: new-policy-audit
  namespace: production
  annotations:
    policy.cilium.io/enforcement-mode: "audit"
spec:
  endpointSelector:
    matchLabels:
      app: new-service
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: trusted-caller
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
```

Then observe what audit mode would block:

```bash
hubble observe \
  --verdict AUDIT \
  --namespace production \
  --follow \
  --output json | jq 'select(.flow.verdict == "AUDIT")'
```

### Hubble Metrics Configuration

Configure Cilium to export Hubble metrics to Prometheus:

```yaml
# values.yaml for Cilium Helm chart
hubble:
  metrics:
    enabled:
      - dns:query;ignoreAAAA
      - drop
      - tcp
      - flow
      - port-distribution
      - icmp
      - http:sourceContext=workload-name|reserved-identity;destinationContext=workload-name|reserved-identity
      - httpV2:exemplars=true;labelsContext=source_ip,source_namespace,source_workload,destination_ip,destination_namespace,destination_workload,traffic_direction
    serviceMonitor:
      enabled: true
      labels:
        prometheus: kube-prometheus
```

## Policy Management Patterns

### Policy-as-Code with GitOps

Structure network policies in Git alongside application manifests:

```
apps/
  payment-service/
    base/
      deployment.yaml
      service.yaml
      network-policy/
        ingress-from-order.yaml
        ingress-from-admin.yaml
        egress-to-stripe.yaml
        egress-to-postgres.yaml
    overlays/
      production/
        kustomization.yaml
        network-policy/
          ingress-monitoring.yaml
```

### Kustomize Network Policy Composition

```yaml
# apps/payment-service/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - deployment.yaml
  - service.yaml
  - network-policy/ingress-from-order.yaml
  - network-policy/ingress-from-admin.yaml
  - network-policy/egress-to-stripe.yaml
  - network-policy/egress-to-postgres.yaml
```

### Policy Testing with Connectivity Checks

Use `cilium connectivity test` for validation:

```bash
# Run the built-in connectivity test suite
cilium connectivity test \
  --namespace cilium-test \
  --test-namespace production \
  --flow-validation strict

# Test specific pod pairs
cilium connectivity test \
  --include-conn-disrupt-test \
  --conn-disrupt-test-setup
```

### Debugging Policy Drops

```bash
# Check policy enforcement on a specific pod
kubectl -n kube-system exec ds/cilium -- \
  cilium endpoint list | grep <pod-ip>

# Get the endpoint ID
ENDPOINT_ID=$(kubectl -n kube-system exec ds/cilium -- \
  cilium endpoint list --output json | \
  jq '.[] | select(.status["networking"]["addressing"][0]["ipv4"] == "<pod-ip>") | .id')

# Show policy for this endpoint
kubectl -n kube-system exec ds/cilium -- \
  cilium endpoint get ${ENDPOINT_ID} | jq '.spec.policy'

# Monitor drops in real time
kubectl -n kube-system exec ds/cilium -- \
  cilium monitor --type drop

# Check policy verdict for a specific flow
kubectl -n kube-system exec ds/cilium -- \
  cilium policy trace \
    --src-k8s-pod production/frontend \
    --dst-k8s-pod production/backend \
    --dport 8080 \
    --proto tcp
```

## Production Operational Considerations

### Policy Rollout Strategy

Apply policies incrementally to avoid disrupting production traffic:

```bash
# Step 1: Deploy policy in audit mode
kubectl apply -f policy-audit.yaml

# Step 2: Monitor for 24-48 hours, collect audit events
hubble observe --verdict AUDIT --namespace production --output json \
  > policy-audit-events.json

# Step 3: Review blocked flows
cat policy-audit-events.json | jq '.flow | {
  source: .source.workloads[0].name,
  destination: .destination.workloads[0].name,
  port: .l4.TCP.destination_port,
  verdict: .verdict
}'

# Step 4: Adjust policy based on findings, then switch to enforce mode
# Remove annotation: policy.cilium.io/enforcement-mode: "audit"
kubectl annotate cnp new-policy-audit \
  policy.cilium.io/enforcement-mode- \
  -n production
```

### Performance Impact of L7 Policies

L7 policies incur overhead from the Envoy proxy. Benchmark before and after enabling L7 rules:

```bash
# Measure baseline L3/L4 latency
kubectl run -it --rm perf-test \
  --image=nicolaka/netshoot \
  --restart=Never \
  -- wrk -t4 -c100 -d30s http://backend-service:8080/api/health

# After enabling L7 policy, re-run and compare
# Expected overhead: 0.5-2ms additional latency per request
# CPU overhead: 1-5% additional per Envoy instance
```

### Resource Sizing for L7 Proxy

```yaml
# Cilium ConfigMap - L7 proxy resource limits
data:
  proxy-prometheus-port: "9095"
  # Envoy connection buffer sizes
  envoy-max-requests-per-connection: "1000"
  # Proxy memory limits
  proxy-max-connection-duration-seconds: "0"
  proxy-max-requests-per-connection: "0"
```

### Policy Backup and Recovery

```bash
# Export all CNPs for backup
kubectl get cnp,ccnp -A -o yaml > cilium-policies-backup.yaml

# Validate policy syntax before applying
cilium policy validate cilium-policies-backup.yaml

# Restore from backup
kubectl apply -f cilium-policies-backup.yaml
```

## Monitoring and Alerting

### Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cilium-policy-alerts
  namespace: monitoring
spec:
  groups:
    - name: cilium.policy
      rules:
        - alert: CiliumHighDropRate
          expr: |
            rate(hubble_drop_total[5m]) > 100
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High Cilium packet drop rate detected"
            description: "Cilium is dropping {{ $value }} packets/s on {{ $labels.node }}"

        - alert: CiliumPolicyDropSpike
          expr: |
            increase(hubble_drop_total{reason="POLICY_DENIED"}[5m]) > 500
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Policy drop spike detected"
            description: "{{ $value }} policy drops in 5 minutes on {{ $labels.node }}"

        - alert: CiliumEndpointNotReady
          expr: |
            cilium_endpoint_state{endpoint_state!="ready"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cilium endpoint not in ready state"
            description: "Endpoint {{ $labels.endpoint_state }} on {{ $labels.node }}"
```

### Grafana Dashboard Queries

Key metrics for Cilium network policy monitoring:

```promql
# Policy drop rate by namespace
sum by (namespace) (
  rate(hubble_drop_total{reason="POLICY_DENIED"}[5m])
)

# L7 HTTP error rate
sum by (destination) (
  rate(hubble_http_requests_total{status=~"5.."}[5m])
) / sum by (destination) (
  rate(hubble_http_requests_total[5m])
)

# Top policy drop sources
topk(10,
  sum by (source_pod, destination_pod) (
    rate(hubble_drop_total{reason="POLICY_DENIED"}[5m])
  )
)

# DNS lookup failures (FQDN policy failures often show as DNS issues)
rate(hubble_drop_total{reason="DNS_ERROR"}[5m])
```

## Advanced Patterns

### Identity-Aware Policy with Service Accounts

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: service-account-based-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: secrets-service
  ingress:
    - fromEndpoints:
        - matchLabels:
            k8s:serviceaccount.name: payment-processor
            k8s:io.kubernetes.pod.namespace: production
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/secrets/payment/.*"
    - fromEndpoints:
        - matchLabels:
            k8s:serviceaccount.name: admin-operator
            k8s:io.kubernetes.pod.namespace: operations
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/secrets/.*"
              - method: "PUT"
                path: "/secrets/.*"
```

### Mutual TLS with Cilium mTLS

Cilium can enforce mTLS between pods using its transparent encryption feature:

```yaml
# Enable WireGuard-based transparent encryption
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: require-encrypted-traffic
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      requires-encryption: "true"
  ingress:
    - fromEndpoints:
        - matchLabels:
            requires-encryption: "true"
      authentication:
        mode: "required"  # Requires Cilium mTLS
```

Enable WireGuard encryption cluster-wide:

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set encryption.enabled=true \
  --set encryption.type=wireguard \
  --set encryption.wireguard.userspaceFallback=true
```

## Summary

Cilium's eBPF-based network policy engine provides enforcement capabilities that fundamentally exceed standard Kubernetes `NetworkPolicy`. The progression from L3/L4 to L7 HTTP/gRPC policies, combined with FQDN-based egress control and cluster-scoped `CiliumClusterwideNetworkPolicy`, enables a microsegmentation model that matches how modern applications actually communicate.

Hubble observability closes the operational loop: policy violations are visible in real time, audit mode allows safe policy iteration, and Prometheus metrics feed into existing alerting infrastructure. The result is a network security posture that security teams can reason about, operators can manage at scale, and developers can extend without breaking production.

Key production recommendations:
- Start with `CiliumClusterwideNetworkPolicy` for baseline cluster security before adding namespace-scoped policies
- Use audit mode for all new policies before switching to enforce
- Enable Hubble metrics and configure drop-rate alerts before deploying L7 policies
- Measure L7 proxy latency overhead in staging before enabling in production
- Store all policies in Git and validate with `cilium policy validate` in CI
