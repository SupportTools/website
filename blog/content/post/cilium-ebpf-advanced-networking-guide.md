---
title: "Cilium eBPF Advanced Networking: Beyond CNI in Production Kubernetes"
date: 2027-06-14T00:00:00-05:00
draft: false
tags: ["Cilium", "eBPF", "Kubernetes", "Networking", "CNI", "Security"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Cilium's eBPF dataplane covering network policy enforcement, Hubble observability, Cluster Mesh, XDP load balancing, kube-proxy replacement, and production tuning for enterprise Kubernetes clusters."
more_link: "yes"
url: "/cilium-ebpf-advanced-networking-guide/"
---

Cilium has redefined what a Kubernetes CNI plugin can be. Where traditional CNI implementations wrap iptables or IPVS, Cilium compiles eBPF programs directly into the Linux kernel, giving operators a programmable dataplane with microsecond-level policy enforcement, deep Layer 7 visibility, and multi-cluster connectivity — all without a single iptables rule.

This guide covers the complete operational picture: architecture internals, replacing kube-proxy, Hubble for real-time flow observability, Cluster Mesh for multi-cluster service discovery, XDP-accelerated load balancing, BPF map tuning, and a production hardening checklist drawn from running Cilium at scale.

<!--more-->

# Cilium eBPF Advanced Networking: Beyond CNI in Production Kubernetes

## Section 1: Cilium Architecture and eBPF Dataplane

### How Cilium Differs from Traditional CNI Plugins

Classical CNI plugins such as Flannel or Calico rely on the kernel's netfilter stack (iptables/nftables) or IPVS to implement pod networking and network policy. At scale, iptables becomes a bottleneck: every packet traverses a linear chain of rules, and rule insertion/deletion is O(n) against the full ruleset. Cilium takes a fundamentally different approach.

Cilium compiles eBPF programs — small, sandboxed bytecode verified and JIT-compiled by the kernel — and attaches them to network hooks inside the kernel. These programs execute at wire speed in kernel context, completely bypassing netfilter for pod-to-pod and service traffic.

The key eBPF attachment points Cilium uses:

| Attachment Point | Hook | Purpose |
|-----------------|------|---------|
| `tc ingress` | Traffic Control | Pod egress policy, SNAT |
| `tc egress` | Traffic Control | Host-facing pod traffic |
| `XDP` | eXpress Data Path | High-throughput L4 LB, DDoS drop |
| `cgroup/connect4` | cgroup BPF | Transparent service proxy |
| `kprobe/kretprobe` | Kernel probes | Hubble kernel-level tracing |

### Control Plane Components

Cilium's control plane consists of the following components:

- **cilium-agent**: A DaemonSet pod on every node. Manages eBPF program compilation and loading, endpoint lifecycle, BPF map population, and integration with the Kubernetes API.
- **cilium-operator**: A Deployment (typically 2 replicas). Handles cluster-wide tasks: IP pool management, CiliumEndpoint GC, node resource updates.
- **Hubble Relay**: Aggregates per-node Hubble servers into a cluster-wide gRPC API.
- **Hubble UI**: A React frontend that visualises service dependency graphs.
- **cilium-envoy**: An optional sidecar-less Envoy instance for L7 policy when deployed in embedded mode.

### Installing Cilium with Helm

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=10.0.0.1 \
  --set k8sServicePort=6443 \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set prometheus.enabled=true \
  --set operator.prometheus.enabled=true \
  --set bpf.masquerade=true \
  --set ipam.mode=kubernetes \
  --set tunnel=disabled \
  --set autoDirectNodeRoutes=true \
  --set ipv4NativeRoutingCIDR=10.0.0.0/8
```

Verify the installation:

```bash
cilium status --wait
cilium connectivity test
```

Expected output snippet:

```
    /¯¯\
 /¯¯\__/¯¯\    Cilium:             OK
 \__/¯¯\__/    Operator:           OK
 /¯¯\__/¯¯\    Envoy DaemonSet:    OK
 \__/¯¯\__/    Hubble Relay:       OK
    \__/

DaemonSet         cilium             Desired: 6, Ready: 6/6, Available: 6/6
Deployment        cilium-operator    Desired: 2, Ready: 2/2, Available: 2/2
Deployment        hubble-relay       Desired: 1, Ready: 1/1, Available: 1/1
```

## Section 2: Replacing kube-proxy with Cilium

### Why Replace kube-proxy

kube-proxy implements Kubernetes Service VIP routing using iptables NAT rules or IPVS. Both approaches have limitations:

- **iptables**: Rule count grows O(services × endpoints); each Service/Endpoint update triggers a full iptables-restore on older kernels.
- **IPVS**: Better for large clusters but still uses netfilter conntrack, which imposes memory and CPU overhead.

Cilium's kube-proxy replacement implements ClusterIP, NodePort, ExternalIP, and LoadBalancer services entirely through eBPF socket operations and XDP programs — no netfilter involvement.

### Configuring kube-proxy Replacement

Full replacement requires a Kubernetes cluster bootstrapped without kube-proxy. For existing clusters migrating from kube-proxy:

```bash
# Step 1: Cordon all nodes and drain workloads to a maintenance window
# Step 2: Delete the kube-proxy DaemonSet
kubectl -n kube-system delete daemonset kube-proxy

# Step 3: Clean up iptables rules kube-proxy left behind
# Run on every node:
iptables-save | grep -v KUBE | iptables-restore
ip6tables-save | grep -v KUBE | ip6tables-restore

# Step 4: Upgrade Cilium with full kube-proxy replacement
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<API_SERVER_IP> \
  --set k8sServicePort=6443
```

Validate that kube-proxy replacement is active:

```bash
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg status | grep KubeProxyReplacement
```

```
KubeProxyReplacement:    True   [eth0 (Direct Routing), eth1]
```

### NodePort and Direct Server Return (DSR)

DSR eliminates the second hop in external traffic by having backend pods reply directly to the client rather than returning traffic through the node that received the request. This halves latency for external-facing services:

```yaml
# values.yaml
nodePort:
  mode: dsr
  acceleration: native
```

DSR requires that backends have the external IP reachable (typically BGP or a routable underlay). Validate:

```bash
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg service list | grep NodePort
```

## Section 3: Network Policy Enforcement

### CiliumNetworkPolicy vs. Kubernetes NetworkPolicy

Kubernetes NetworkPolicy is limited to L3/L4 (IP, port, protocol). Cilium extends this with:

- **L7 policies**: HTTP path/method, gRPC service/method, Kafka topic, DNS FQDN.
- **Identity-based**: Policies reference Cilium Security Identities derived from pod labels — not ephemeral IP addresses.
- **FQDN-based egress**: Allow egress to `*.amazonaws.com` without maintaining IP lists.

### Example: L7 HTTP Policy

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-http-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend-api
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: frontend
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      rules:
        http:
        - method: GET
          path: /api/v1/.*
        - method: POST
          path: /api/v1/orders
  egress:
  - toFQDNs:
    - matchPattern: "*.amazonaws.com"
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
```

### Example: DNS FQDN Egress Policy

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-external-dns
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: worker
  egress:
  - toEndpoints:
    - matchLabels:
        k8s:io.kubernetes.pod.namespace: kube-system
        k8s:k8s-app: kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: ANY
      rules:
        dns:
        - matchPattern: "*.internal.example.com"
  - toFQDNs:
    - matchName: "api.stripe.com"
    - matchPattern: "*.s3.amazonaws.com"
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
```

### Verifying Policy Enforcement

```bash
# List all endpoints and their policy enforcement status
kubectl -n production exec ds/cilium -- cilium-dbg endpoint list

# Inspect the policy for a specific endpoint (replace ENDPOINT_ID)
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg endpoint get ENDPOINT_ID -o json | \
  jq '.spec.policy'

# Test connectivity from the Cilium connectivity test suite
cilium connectivity test --test egress-l7-policy
```

### Identity-Based Policy Internals

Every Cilium endpoint is assigned a numeric Security Identity based on its label set. BPF maps store (source_identity, destination_identity, port, protocol) → allow/deny tuples. This means policy lookups are O(1) hash map operations, not linear rule scans.

```bash
# View current identity mappings
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg identity list

# View BPF policy map for a specific endpoint
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg bpf policy get ENDPOINT_ID
```

## Section 4: Hubble Observability

### Hubble Architecture

Hubble is Cilium's built-in observability layer. It works by attaching eBPF programs that record every network flow — including dropped packets with the drop reason — and exposing them through a gRPC API. No packet sampling, no sidecar overhead.

Components:
- **Hubble server**: Embedded in each cilium-agent, exposes flows on a Unix socket.
- **Hubble Relay**: Aggregates flows from all nodes into a single cluster-scoped API endpoint.
- **Hubble CLI**: Query flows, DNS lookups, HTTP requests in real time.
- **Hubble UI**: Browser-based service map with flow drill-down.

### Installing and Using the Hubble CLI

```bash
# Download Hubble CLI
HUBBLE_VERSION=v1.16.0
curl -L --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/

# Port-forward to Hubble Relay
kubectl -n kube-system port-forward svc/hubble-relay 4245:80 &

# Check Hubble status
hubble status

# Observe all flows in the production namespace
hubble observe --namespace production --follow

# Observe only dropped packets
hubble observe --verdict DROPPED --follow

# Observe HTTP flows with method and path
hubble observe --namespace production \
  --protocol http \
  --http-method GET \
  --follow

# Observe flows between two specific services
hubble observe \
  --from-label app=frontend \
  --to-label app=backend-api \
  --follow
```

### Hubble Metrics for Prometheus

Cilium exposes Hubble flow metrics as Prometheus metrics. Enable them:

```yaml
# values.yaml
hubble:
  metrics:
    enabled:
    - dns:query;ignoreAAAA
    - drop
    - tcp
    - flow
    - icmp
    - http
    serviceMonitor:
      enabled: true
```

Key metrics to alert on:

| Metric | Alert Condition |
|--------|----------------|
| `hubble_drop_total` | Rate > 0 for non-test namespaces |
| `hubble_http_requests_total` | Error rate > 1% per service pair |
| `hubble_dns_queries_total{rcode!="NOERROR"}` | Elevated NXDOMAIN rate |
| `hubble_tcp_flags_total{flags="RST"}` | Spike in TCP RST |

### Hubble UI Service Map

The Hubble UI provides a real-time directed graph of all service-to-service communication, colour-coded by verdict (forwarded/dropped/error). Access it:

```bash
cilium hubble ui &
# Opens http://localhost:12000 in the default browser
```

## Section 5: Cluster Mesh Multi-Cluster Networking

### What Cluster Mesh Provides

Cluster Mesh connects multiple Cilium-enabled clusters so that:

1. Services in cluster A can be accessed by pods in cluster B using their original ClusterIP DNS name.
2. Network policies span cluster boundaries based on Cilium identities.
3. Global load balancing distributes traffic across clusters with health-aware failover.

### Prerequisites and Architecture

Each cluster must have:
- Non-overlapping pod and service CIDRs.
- Unique cluster name and cluster ID (1–255).
- Reachable etcd/Kubernetes API servers across clusters.

```bash
# Cluster A
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set cluster.name=cluster-a \
  --set cluster.id=1 \
  --set clustermesh.useAPIServer=true

# Cluster B
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set cluster.name=cluster-b \
  --set cluster.id=2 \
  --set clustermesh.useAPIServer=true
```

### Enabling Cluster Mesh

```bash
# Enable Cluster Mesh API server on both clusters
cilium clustermesh enable --service-type LoadBalancer

# Connect the clusters (run from cluster A with kubeconfig for both)
cilium clustermesh connect \
  --destination-context cluster-b-context

# Verify mesh status
cilium clustermesh status --wait
```

Expected output:

```
✅  Cluster Connections:
  - cluster-b: 3/3 nodes connected, 3/3 endpoints synced
```

### Global Services

Annotate a Service to make it global — reachable from all connected clusters:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: database
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/shared: "true"
spec:
  selector:
    app: postgres
  ports:
  - port: 5432
    targetPort: 5432
```

With `shared: "true"`, both clusters expose the service and traffic is load-balanced globally. Remove the annotation from one cluster to make that cluster a consumer only.

### Cluster Mesh Failover

```yaml
# Annotate with affinity=local to prefer local endpoints
metadata:
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/affinity: "local"
```

When local endpoints are unavailable (all pods CrashLooping), Cilium automatically routes to remote cluster endpoints.

## Section 6: XDP Load Balancing

### XDP Program Attachment

XDP (eXpress Data Path) programs run at the earliest possible point in the network stack — inside the NIC driver, before the socket buffer (SKB) is allocated. This makes XDP ideal for high-throughput L4 load balancing and rate limiting.

Cilium uses XDP to accelerate NodePort and LoadBalancer service handling when enabled:

```yaml
# values.yaml
nodePort:
  acceleration: native   # native XDP (requires driver support)
  # acceleration: generic  # software XDP, works on all drivers
```

Verify XDP is active:

```bash
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg status | grep XDP
```

```
XDP Acceleration:   Native
```

### Supported NICs for Native XDP

| Driver | NIC Families |
|--------|-------------|
| `mlx5` | Mellanox ConnectX-4/5/6 |
| `i40e` | Intel X710/XXV710 |
| `ixgbe` | Intel X540/X550 |
| `bnxt_en` | Broadcom NetXtreme-E |
| `virtio_net` | KVM virtio (with XDP support) |

AWS instances using ENA (`ena` driver) support generic XDP. Use `acceleration: generic` for ENA.

### Benchmarking XDP Performance

```bash
# Generate load with netperf or wrk from a client pod
kubectl run netperf-client --image=networkstatic/netperf \
  --restart=Never -- \
  netperf -H <service-ip> -t TCP_RR -l 60

# Compare throughput with acceleration disabled vs. enabled
# iptables baseline:      ~200k req/s per core
# IPVS baseline:          ~350k req/s per core
# Cilium with XDP native: ~1.2M req/s per core (Mellanox 100G)
```

## Section 7: BPF Map Management

### Understanding BPF Maps

BPF maps are key/value stores shared between eBPF programs and userspace. Cilium uses dozens of map types. The most operationally significant:

| Map Name | Type | Default Size | Purpose |
|----------|------|-------------|---------|
| `cilium_lxc` | Hash | 65536 | Endpoint metadata |
| `cilium_ct4_global` | Hash | 512000 | Connection tracking (IPv4) |
| `cilium_lb4_services_v2` | Hash | 65536 | Service VIP mappings |
| `cilium_lb4_backends_v3` | Hash | 196608 | Service backend IPs |
| `cilium_policy` | Hash | 16384 | Policy map per-endpoint |
| `cilium_events` | Perf event array | 128 | Kernel→userspace events |

### Monitoring Map Pressure

```bash
# List all BPF maps and their utilisation
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg bpf map list

# Check connection tracking table usage
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg bpf ct list global | wc -l

# Check for map full errors (indicates sizing issue)
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg metrics list | grep bpf_map_ops_errors
```

### Tuning Map Sizes

When running thousands of pods per node or high-connection-rate workloads, the default map sizes may be insufficient:

```yaml
# values.yaml
bpf:
  ctTcpMax: 1048576       # CT entries for TCP (default: 512000)
  ctAnyMax: 524288        # CT entries for non-TCP (default: 256000)
  natMax: 1048576         # NAT table entries (default: 524288)
  neighMax: 131072        # Neighbour table (default: 131072)
  lbMapMax: 262144        # LB service/backend entries (default: 65536)
  policyMapMax: 65536     # Policy entries per endpoint (default: 16384)
```

Each BPF map is pinned under `/sys/fs/bpf/tc/globals/`. Changes take effect on cilium-agent restart:

```bash
kubectl -n kube-system rollout restart daemonset/cilium
kubectl -n kube-system rollout status daemonset/cilium
```

### Connection Tracking Garbage Collection

Cilium runs an internal GC loop to expire CT entries. Tune the GC interval for high-churn environments:

```yaml
# values.yaml
conntrackGCInterval: "30s"   # default: varies by kernel, ~2m
conntrackGCMaxInterval: "60s"
```

## Section 8: Production Tuning

### Resource Requests and Limits

Cilium agents are node-critical DaemonSets. Set appropriate resources:

```yaml
# values.yaml
resources:
  requests:
    cpu: 200m
    memory: 512Mi
  limits:
    cpu: 2000m
    memory: 1Gi

operator:
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi
```

### Masquerading and eBPF-Based SNAT

Replace iptables MASQUERADE with eBPF masquerade for better performance:

```yaml
# values.yaml
bpf:
  masquerade: true

# Also ensure ip masq agent is disabled if present
ipMasqAgent:
  enabled: false
```

### Bandwidth Manager (TCP BBR)

Cilium's bandwidth manager uses eBPF-based EDT (Earliest Departure Time) packet scheduling to enforce pod egress bandwidth limits without needing the kernel's traffic shaping subsystem:

```yaml
# values.yaml
bandwidthManager:
  enabled: true
  bbr: true   # Use BBR congestion control for pods
```

Apply bandwidth limits via Kubernetes annotations:

```yaml
metadata:
  annotations:
    kubernetes.io/egress-bandwidth: "100M"
    kubernetes.io/ingress-bandwidth: "100M"
```

### Enabling Encryption (WireGuard)

Cilium supports node-to-node transparent encryption via WireGuard (kernel ≥ 5.6):

```yaml
# values.yaml
encryption:
  enabled: true
  type: wireguard
  wireguard:
    userspaceFallback: false
```

Verify encryption is active:

```bash
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg status | grep Encryption
```

```
Encryption:   Wireguard   [cilium_wg0 (Pubkey: <key>)]
```

### Monitoring and Alerting

Prometheus recording rules for Cilium:

```yaml
groups:
- name: cilium.rules
  rules:
  - record: cilium:agent_up
    expr: up{job="cilium-agent"}

  - alert: CiliumAgentDown
    expr: cilium:agent_up == 0
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Cilium agent is down on node {{ $labels.node }}"

  - alert: CiliumDropHigh
    expr: rate(hubble_drop_total[5m]) > 10
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High packet drop rate: {{ $value }} drops/s in namespace {{ $labels.namespace }}"

  - alert: CiliumBPFMapPressure
    expr: cilium_bpf_map_pressure > 0.9
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "BPF map {{ $labels.map_name }} is at {{ $value | humanizePercentage }} capacity"
```

## Section 9: Troubleshooting

### Common Issues and Diagnostics

#### Pods cannot reach other pods

```bash
# Run Cilium connectivity test
cilium connectivity test

# Check endpoint health
kubectl -n kube-system exec ds/cilium -- cilium-dbg endpoint list

# Look for policy drops in Hubble
hubble observe --verdict DROPPED --follow

# Check if endpoints have correct labels/identity
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg endpoint get <endpoint-id>
```

#### Service VIP not reachable

```bash
# Verify the service is in the BPF LB map
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg bpf lb list | grep <service-ip>

# Check backend health
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg bpf lb list --backends

# Verify kube-proxy replacement status
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg status --verbose | grep -A5 KubeProxyReplacement
```

#### DNS resolution failures

```bash
# Check Cilium DNS proxy
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg bpf dns list

# Observe DNS flows
hubble observe --protocol dns --follow

# Check FQDN cache
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg fqdn cache list
```

#### High CPU on cilium-agent

```bash
# Check which BPF programs are consuming CPU
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg metrics list | grep cpu

# Check regeneration rate (high rate = frequent policy changes)
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg metrics list | grep endpoint_regeneration
```

### Collecting a Sysdump

For escalated support cases, collect a comprehensive sysdump:

```bash
cilium sysdump \
  --output-filename cilium-sysdump-$(date +%Y%m%d-%H%M%S)
```

This captures: agent logs, endpoint state, BPF map contents, Hubble flows (last 10k), kernel parameters, and network interface configuration.

## Section 10: Production Hardening Checklist

```
Cilium Production Checklist
============================

Installation
[ ] kubeProxyReplacement=true with kube-proxy DaemonSet removed
[ ] tunnel=disabled with autoDirectNodeRoutes=true (native routing)
[ ] IPAM mode matches cluster requirements (kubernetes/cluster-pool/eni)
[ ] Cluster name and ID set for Cluster Mesh readiness

Security
[ ] encryption.type=wireguard enabled for multi-tenant clusters
[ ] Default deny CiliumClusterwideNetworkPolicy applied
[ ] FQDN-based egress policies for external service access
[ ] L7 policies for sensitive HTTP/gRPC services
[ ] Audit CiliumNetworkPolicy coverage gaps with hubble observe --verdict DROPPED

Performance
[ ] bpf.masquerade=true (iptables MASQUERADE disabled)
[ ] nodePort.acceleration=native (XDP) on supported NICs
[ ] bandwidthManager.enabled=true for bandwidth-sensitive workloads
[ ] CT/NAT map sizes tuned for expected connection rates
[ ] conntrackGCInterval tuned for high-churn environments

Observability
[ ] hubble.relay.enabled=true
[ ] Hubble metrics ServiceMonitor deployed
[ ] Prometheus alerts for drop rate, map pressure, agent health
[ ] Hubble UI accessible for on-call engineers
[ ] cilium-dbg sysdump runbook documented

Upgrade Path
[ ] Test upgrades in dev/staging before production
[ ] Use helm upgrade --reuse-values to avoid configuration drift
[ ] Verify connectivity test passes post-upgrade
[ ] Monitor hubble_drop_total during rollout
```

## Summary

Cilium's eBPF dataplane represents a generational shift in Kubernetes networking. By moving packet processing into the kernel with verified, JIT-compiled programs, Cilium eliminates the iptables scaling wall, provides microsecond-level policy decisions based on stable identity rather than ephemeral IPs, and delivers a built-in observability layer through Hubble — all with lower CPU overhead than traditional approaches.

The operational investment in understanding BPF maps, identity management, and Cluster Mesh is repaid many times over in reduced latency, simpler policy models, and the ability to debug network flows with the granularity of a packet capture without the overhead of one.

For teams running production Kubernetes at scale, Cilium is no longer an experimental choice — it is the production-grade CNI that removes the ceiling on what Kubernetes networking can do.
