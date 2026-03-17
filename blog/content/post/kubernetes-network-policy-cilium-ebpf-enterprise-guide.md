---
title: "Kubernetes Network Policy Deep Dive: Cilium eBPF Policy Enforcement at Scale"
date: 2029-11-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "eBPF", "Network Policy", "Security", "Multi-Cluster", "DNS Policy"]
categories:
- Kubernetes
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering Cilium network policies, eBPF-based enforcement, policy debugging, DNS-based policies, and multi-cluster policy federation at scale."
more_link: "yes"
url: "/kubernetes-network-policy-cilium-ebpf-enterprise-guide/"
---

Kubernetes NetworkPolicy objects are powerful, but the standard implementation leaves significant gaps: no egress DNS filtering, no Layer 7 policies, and no multi-cluster enforcement. Cilium fills every one of those gaps using eBPF programs loaded directly into the kernel, giving you microsecond-latency policy decisions without iptables overhead and a policy model expressive enough to govern the most complex enterprise environments.

<!--more-->

## Section 1: Why Cilium Over Standard NetworkPolicy

The standard Kubernetes NetworkPolicy API is intentionally minimal. It handles IP-based ingress and egress rules, but enforcement is delegated to the CNI plugin. Most plugins implement NetworkPolicy by generating iptables rules, which creates three significant problems at scale.

First, iptables is O(n) for every packet through the entire ruleset. A cluster with 500 services and 200 NetworkPolicy objects can generate 50,000+ iptables rules. On high-traffic nodes, the time spent evaluating rules becomes measurable latency.

Second, standard NetworkPolicy cannot filter on DNS names. You can allow `10.96.0.1/32` but not `api.example.com`. In practice, egress destinations are service hostnames, not static IPs. This forces teams to either run wide-open egress policies or maintain fragile IP allowlists.

Third, there is no concept of Layer 7 policy. You can allow TCP port 443, but you cannot say "allow HTTPS GET to /api/v1 but deny DELETE."

Cilium solves all three with eBPF programs attached at the socket layer and a CRD-based policy API that extends standard NetworkPolicy.

### Cilium Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Kubernetes API Server                       │
│  CiliumNetworkPolicy CRDs                    │
└──────────────────────┬──────────────────────┘
                       │ Watch
              ┌────────▼────────┐
              │  Cilium Agent   │  (DaemonSet, one per node)
              │  (cilium-agent) │
              └────────┬────────┘
                       │ Load eBPF programs
              ┌────────▼────────────────────────┐
              │  Linux Kernel                    │
              │  ┌──────────────┐ ┌───────────┐ │
              │  │ TC eBPF Hook │ │ XDP Hook  │ │
              │  │ (ingress/    │ │ (L3 drop) │ │
              │  │  egress)     │ └───────────┘ │
              │  └──────────────┘               │
              └─────────────────────────────────┘
```

The cilium-agent on each node watches CiliumNetworkPolicy objects via the Kubernetes API, compiles them into eBPF bytecode, and loads those programs into the kernel. Policy decisions happen entirely in kernel space without context switches to userspace.

## Section 2: Installing Cilium with Policy Enforcement Enabled

### Helm Installation

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --set policyEnforcementMode=default \
  --set enableIPv4Masquerade=true \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<API_SERVER_HOST> \
  --set k8sServicePort=6443 \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.enabled=true \
  --set operator.replicas=2
```

The `policyEnforcementMode` flag has three values:

- `default` — enforce policy only on endpoints that have at least one policy selecting them; all other traffic is allowed
- `always` — enforce policy on every endpoint; endpoints with no policy have no connectivity
- `never` — disable enforcement entirely (useful for migration)

For a greenfield cluster, start with `default` and migrate to `always` once all namespaces have baseline policies.

### Verifying Installation

```bash
cilium status --wait
cilium connectivity test
```

Expected output from `cilium status`:

```
    /¯¯\
 /¯¯\__/¯¯\    Cilium:          OK
 \__/¯¯\__/    Operator:        OK
 /¯¯\__/¯¯\    Envoy DaemonSet: OK
 \__/¯¯\__/    Hubble Relay:    OK
    \__/       ClusterMesh:     disabled

Deployment        cilium-operator    Desired: 2, Ready: 2/2, Available: 2/2
DaemonSet         cilium             Desired: 5, Ready: 5/5, Available: 5/5
```

## Section 3: CiliumNetworkPolicy vs Standard NetworkPolicy

Cilium supports both standard `NetworkPolicy` objects and its own `CiliumNetworkPolicy` CRD. Standard policies are automatically converted to Cilium's internal representation. The CRD extends the API with:

- DNS-based egress rules via `toFQDNs`
- HTTP/gRPC Layer 7 rules via `toPorts[].rules.http`
- Entity-based rules (`world`, `cluster`, `host`, `remote-node`)
- Service account-based selectors
- Per-endpoint policy statistics

### Basic Namespace Isolation

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: namespace-isolation
  namespace: production
spec:
  endpointSelector: {}
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: production
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: monitoring
            app: prometheus
  egress:
    - toEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: production
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
              k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*.cluster.local"
```

The empty `endpointSelector: {}` selects all endpoints in the namespace. The ingress rules allow traffic from the same namespace and from Prometheus in the monitoring namespace. The egress rules allow internal namespace traffic and DNS to kube-dns.

### DNS-Based Egress Policies

This is Cilium's killer feature for egress control. The DNS policy intercepts DNS responses and dynamically updates the eBPF map with resolved IPs, which are then matched against egress rules.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-external-apis
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  egress:
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.braintreegateway.com"
        - matchPattern: "*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"
```

The DNS egress rule must always be paired with a DNS allow rule to kube-dns. Without the DNS allow, the FQDN rule cannot resolve hostnames.

### Layer 7 HTTP Policies

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-gateway-l7
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
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/api/v1/users/.*"
              - method: "POST"
                path: "/api/v1/users"
              - method: "PUT"
                path: "/api/v1/users/[0-9]+"
```

Layer 7 enforcement requires Cilium's Envoy integration. The cilium-agent injects an Envoy sidecar at the network level without modifying pod manifests.

## Section 4: Policy Debugging with Hubble

Hubble is Cilium's observability layer. It runs as a gRPC server on each node, exporting flow records from the eBPF ring buffer. The Hubble relay aggregates flows cluster-wide.

### Observing Policy Decisions

```bash
# Install the Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/

# Port-forward the Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe flows for a specific pod
hubble observe \
  --pod production/payment-service-7d9f8c-xkq2p \
  --verdict DROPPED \
  --follow

# Observe all policy drops in a namespace
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --type policy-verdict
```

Sample output showing a blocked egress attempt:

```
Nov 25 14:32:01.451: production/payment-service-7d9f8c-xkq2p:52341
  -> 203.0.113.15:443 policy-verdict:denied DROPPED
  (egress missing rule: destination IP 203.0.113.15 not matched by any fqdn rule)
```

### Checking Endpoint Policy State

```bash
# List all endpoints and their policy enforcement status
kubectl exec -n kube-system ds/cilium -- cilium endpoint list

# Dump the full policy for a specific endpoint
ENDPOINT_ID=$(kubectl exec -n kube-system ds/cilium -- \
  cilium endpoint list -o json | \
  jq -r '.[] | select(.status.labels."k8s:app" == "payment-service") | .id' | head -1)

kubectl exec -n kube-system ds/cilium -- \
  cilium endpoint get "${ENDPOINT_ID}" -o json | \
  jq '.status.policy'
```

### BPF Map Inspection

```bash
# View the eBPF policy map for an endpoint
kubectl exec -n kube-system ds/cilium -- \
  cilium bpf policy get "${ENDPOINT_ID}"

# View DNS cache (FQDN-to-IP mappings)
kubectl exec -n kube-system ds/cilium -- \
  cilium fqdn cache list

# View connection tracking table
kubectl exec -n kube-system ds/cilium -- \
  cilium bpf ct list global | head -50
```

## Section 5: Policy Testing with Network Policy Editor

Before deploying policies to production, validate them with `netpol` or Cilium's built-in policy editor.

### Automated Policy Validation

```bash
# Use cyclonus for policy conformance testing
kubectl apply -f https://raw.githubusercontent.com/mattfenwick/cyclonus/main/pkg/generator/testcases.yaml

# Run the cyclonus probe
kubectl run cyclonus \
  --image=mfenwick100/cyclonus:latest \
  --restart=Never \
  -- \
  probe \
    --mode=job \
    --policy-source=kube \
    --namespaces=cyclonus \
    --target-namespaces=cyclonus
```

### Policy as Code with Helm

Structure your policies as Helm templates for environment-specific configuration:

```yaml
# templates/network-policies/baseline.yaml
{{- range .Values.namespaces }}
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: baseline-deny-all
  namespace: {{ .name }}
spec:
  endpointSelector: {}
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: {{ .name }}
  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*.cluster.local"
              - matchPattern: "*.svc.cluster.local"
{{- end }}
```

## Section 6: Multi-Cluster Policy Federation with ClusterMesh

ClusterMesh extends Cilium's policy model across multiple clusters. Endpoints in different clusters can be selected by policy as if they were in the same cluster.

### ClusterMesh Setup

```bash
# Enable ClusterMesh on cluster 1
cilium clustermesh enable \
  --context cluster1 \
  --service-type LoadBalancer

# Enable ClusterMesh on cluster 2
cilium clustermesh enable \
  --context cluster2 \
  --service-type LoadBalancer

# Connect the clusters
cilium clustermesh connect \
  --context cluster1 \
  --destination-context cluster2

# Verify mesh connectivity
cilium clustermesh status \
  --context cluster1 \
  --wait
```

### Cross-Cluster Policy

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-cross-cluster-monitoring
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: database
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.cilium.k8s.policy.cluster: cluster2
            app: prometheus
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
```

The `io.cilium.k8s.policy.cluster` label is automatically injected by ClusterMesh, allowing cross-cluster endpoint selection without managing IP ranges.

## Section 7: Performance Tuning for Large Clusters

### eBPF Map Sizing

Default eBPF map sizes are conservative. For clusters with thousands of endpoints:

```yaml
# Helm values for large clusters
cilium:
  bpf:
    mapDynamicSizeRatio: 0.0025
    policyMapMax: 65536
    ctTcpMax: 524288
    ctAnyMax: 262144
    natMax: 524288
    neighMax: 524288
    lbMapMax: 65536
  resources:
    requests:
      cpu: 100m
      memory: 512Mi
    limits:
      cpu: 4000m
      memory: 4Gi
```

### Policy Pre-Compilation

Cilium compiles policies to eBPF bytecode when they are applied. For large clusters with frequent policy updates, enable pre-compilation:

```bash
# Check policy revision count (high churn is a warning sign)
kubectl exec -n kube-system ds/cilium -- \
  cilium metrics list | grep policy_revision
```

### Monitoring Policy Enforcement Overhead

```bash
# Check eBPF program execution time via perf
kubectl exec -n kube-system ds/cilium -- \
  bpftool prog show | grep cilium

# View policy verdict metrics
kubectl port-forward -n kube-system svc/cilium-agent 9962:9962 &
curl -s localhost:9962/metrics | grep -E 'cilium_policy|cilium_drop'
```

## Section 8: Production Operational Runbook

### Day-2 Operations Checklist

```bash
# Weekly: audit endpoints without policies
kubectl exec -n kube-system ds/cilium -- \
  cilium endpoint list -o json | \
  jq -r '.[] | select(.status.policy.realized.["ingress-policy-enabled"] == false) | .status.labels'

# Verify no policy drops on critical services
hubble observe \
  --namespace production \
  --label app=api-gateway \
  --verdict DROPPED \
  --since 24h \
  --output json | jq '.flow.destination'

# Check for stale FQDN cache entries
kubectl exec -n kube-system ds/cilium -- \
  cilium fqdn cache list | \
  awk '$3 < systime() { print "EXPIRED: " $1 }'
```

### Rollback Strategy

```bash
# Disable enforcement on a specific namespace without deleting policies
kubectl annotate namespace production \
  "policy.cilium.io/enforcement"=disabled

# Re-enable
kubectl annotate namespace production \
  "policy.cilium.io/enforcement"=enabled \
  --overwrite

# Emergency: set global mode to never
helm upgrade cilium cilium/cilium \
  -n kube-system \
  --reuse-values \
  --set policyEnforcementMode=never
```

Cilium's eBPF-based network policy enforcement delivers the performance and expressiveness required for serious production environments. The combination of DNS-based egress control, Layer 7 HTTP policies, and ClusterMesh federation makes it the most complete network policy solution available for Kubernetes today.
