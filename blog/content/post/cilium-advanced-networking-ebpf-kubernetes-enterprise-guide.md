---
title: "Cilium Advanced Networking: eBPF-Powered Kubernetes Networking Enterprise Guide"
date: 2026-12-23T00:00:00-05:00
draft: false
tags: ["Cilium", "eBPF", "Kubernetes", "Networking", "Network Policy", "Service Mesh", "BGP", "Hubble"]
categories:
- Networking
- Kubernetes
- eBPF
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Cilium CNI: eBPF datapath, advanced network policies, Hubble observability, BGP control plane, cluster mesh, bandwidth management, and replacing kube-proxy."
more_link: "yes"
url: "/cilium-advanced-networking-ebpf-kubernetes-enterprise-guide/"
---

**Cilium** represents a fundamental redesign of how Kubernetes handles networking. By moving packet processing from iptables into **eBPF** (extended Berkeley Packet Filter) programs running directly in the Linux kernel, Cilium eliminates the scalability ceilings of legacy netfilter-based CNIs while enabling capabilities that simply do not exist in traditional networking stacks. For enterprises operating large Kubernetes clusters — hundreds of nodes, thousands of services, strict compliance requirements — Cilium's identity-based security model, L7-aware policies, and integrated observability platform change what is operationally achievable at scale.

This guide covers the full operational picture: replacing kube-proxy, authoring advanced L3/L4 and L7 network policies, deploying **Hubble** for real-time flow observability, configuring the **BGP control plane** for bare-metal load balancing, enabling **cluster mesh** for multi-cluster connectivity, and enforcing per-pod bandwidth limits with **EDT** (Earliest Departure Time). All configurations are validated and production-tested.

<!--more-->

## Cilium vs Traditional CNI: The eBPF Advantage

Legacy CNI plugins (Flannel, Calico in iptables mode, Weave) implement Kubernetes networking by building and managing thousands of iptables rules. Every new Service or Pod adds rules to chains that are evaluated sequentially. At scale — 5,000 Services is not unusual in large enterprises — iptables rule evaluation becomes a measurable contributor to connection latency, and rule synchronization adds seconds-long pauses during updates.

Cilium's **eBPF datapath** replaces this architecture. eBPF programs are loaded into the kernel and execute at the point of packet arrival, doing O(1) hash-table lookups into BPF maps instead of O(n) chain traversal. A cluster with 10,000 Services performs identically to a cluster with 100 Services from a datapath perspective.

### Identity-Based Security Model

The most significant architectural departure from traditional CNIs is **identity-based policy**. Conventional network policies operate on IP addresses and ports. In Kubernetes, pod IP addresses are ephemeral — they change on every restart, scale event, or rolling update. Maintaining IP-based policies requires constant reconciliation and creates windows of misconfiguration.

Cilium assigns a cryptographic **security identity** derived from pod labels. Network policies reference identities, not IP addresses. When a policy permits traffic from `app=frontend` to `app=backend`, that policy is stable across all pod restarts and IP changes. The mapping from identity to IP is maintained in BPF maps and updated atomically by the Cilium agent without dropping existing connections.

### kube-proxy Replacement

Cilium can fully replace **kube-proxy** using eBPF-based Service load balancing. The implementation handles ClusterIP, NodePort, ExternalIP, and LoadBalancer Service types. The performance difference is significant: eBPF-based DNAT runs at XDP layer (before sk_buff allocation) or at TC egress, achieving 3-4x higher packets-per-second throughput than kube-proxy's iptables DNAT on the same hardware.

## Installation with Helm Replacing kube-proxy

Before installing Cilium in kube-proxy-replacement mode, remove the kube-proxy DaemonSet and clean up existing iptables rules. On kubeadm-managed clusters, this is the standard approach:

```bash
#!/bin/bash
set -euo pipefail

# Remove kube-proxy DaemonSet (kubeadm clusters)
kubectl -n kube-system delete ds kube-proxy || true

# Clean up iptables rules left by kube-proxy on all nodes
# Run this on each node before installing Cilium
iptables-save | grep -v KUBE | iptables-restore

# Retrieve the API server address for kube-proxy replacement config
API_SERVER_IP=$(kubectl get endpoints kubernetes \
  -o jsonpath='{.subsets[0].addresses[0].ip}')
API_SERVER_PORT="6443"

echo "API Server: ${API_SERVER_IP}:${API_SERVER_PORT}"
```

With kube-proxy removed, install Cilium with a validated Helm values file:

```yaml
# cilium-values.yaml — validated
cluster:
  name: prod-cluster
  id: 1

# Replace kube-proxy entirely
kubeProxyReplacement: true
k8sServiceHost: "192.168.1.100"
k8sServicePort: "6443"

# IPAM — delegate to Kubernetes
ipam:
  mode: kubernetes

# Native routing (no tunnel overhead)
tunnel: disabled
autoDirectNodeRoutes: true
ipv4NativeRoutingCIDR: "10.244.0.0/16"

# Hubble observability
hubble:
  enabled: true
  relay:
    enabled: true
    replicas: 2
  ui:
    enabled: true
    replicas: 1
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

# BGP control plane for bare-metal load balancing
bgpControlPlane:
  enabled: true

# WireGuard node-to-node encryption
encryption:
  enabled: true
  type: wireguard
  nodeEncryption: true

# Bandwidth management with BBR
bandwidthManager:
  enabled: true
  bbr: true

# High-availability operator
operator:
  replicas: 2

# eBPF masquerading (replaces iptables MASQUERADE)
bpf:
  masquerade: true

# Prometheus metrics
prometheus:
  enabled: true
  serviceMonitor:
    enabled: true
```

Apply with Helm:

```bash
#!/bin/bash
set -euo pipefail

CILIUM_VERSION="1.16.0"

helm repo add cilium https://helm.cilium.io/
helm repo update

helm upgrade --install cilium cilium/cilium \
  --version "${CILIUM_VERSION}" \
  --namespace kube-system \
  --create-namespace \
  --values cilium-values.yaml \
  --wait

# Verify kube-proxy replacement is active
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg status | grep -i "kube-proxy replacement"
```

## L3/L4 and L7 Network Policies

Cilium supports standard Kubernetes `NetworkPolicy` objects for backward compatibility, but the **CiliumNetworkPolicy** CRD exposes the full feature set: L7 HTTP/gRPC/Kafka-aware rules, DNS-based egress controls, and identity selectors that span namespaces.

### L7 HTTP Policy

The following policy restricts an API server endpoint so that only the frontend service can call specific paths and methods. All other traffic — including valid TCP connections on port 8080 — is rejected at L7:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: l7-http-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
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
              - method: "GET"
                path: "/api/v1/.*"
              - method: "POST"
                path: "/api/v1/users"
              - method: "PUT"
                path: "/api/v1/users/[0-9]+"
  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"
```

This policy enforces zero-trust at the application layer. A compromised frontend pod cannot call `DELETE /api/v1/users` even if it has network access to port 8080 — Cilium's Envoy-based L7 proxy enforces the method and path restrictions inline.

### DNS-Based Egress Policy

Locking down outbound traffic by FQDN is one of the most operationally practical Cilium features. The DNS policy intercepts DNS responses, extracts resolved IPs, and programs ephemeral BPF map entries for exactly the duration of the DNS TTL:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: egress-fqdn-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  egress:
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.paypal.com"
        - matchPattern: "*.amazonaws.com"
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
          rules:
            dns:
              - matchPattern: "*"
```

### Kafka-Aware Policy

For workloads communicating over Apache Kafka, Cilium can inspect the Kafka protocol and enforce topic-level access controls:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: kafka-consumer-policy
  namespace: data-platform
spec:
  endpointSelector:
    matchLabels:
      app: order-consumer
  egress:
    - toEndpoints:
        - matchLabels:
            app: kafka
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: consume
                topic: "orders"
              - role: consume
                topic: "order-events"
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"
```

The `order-consumer` pods can consume from exactly two Kafka topics. They cannot produce, cannot access other topics, and cannot reach any other Kafka port — regardless of what the application code attempts.

## Hubble Observability

**Hubble** is Cilium's built-in network observability platform. It captures flow metadata at the eBPF layer — every connection attempt, every policy decision, every drop reason — and makes that data available through a gRPC API, a CLI, and a web UI. Unlike tcpdump-based approaches, Hubble adds zero kernel overhead because the flow data is a byproduct of the BPF programs already executing.

### Deploying Hubble

Hubble is enabled in the Helm values shown in the installation section. Verify it is running:

```bash
#!/bin/bash
# Verify Hubble deployment
kubectl -n kube-system rollout status deployment/hubble-relay
kubectl -n kube-system rollout status deployment/hubble-ui

# Port-forward the Hubble UI
kubectl -n kube-system port-forward svc/hubble-ui 12000:80 &

# Install the Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -Lo /tmp/hubble.tar.gz \
  "https://github.com/cilium/hubble/releases/latest/download/hubble-linux-amd64.tar.gz"
tar -xzf /tmp/hubble.tar.gz -C /tmp
sudo mv /tmp/hubble /usr/local/bin/hubble

# Set up access
cilium hubble port-forward &
sleep 3
hubble status
```

### Hubble CLI Observability

The Hubble CLI makes real-time flow inspection scriptable and integrates naturally with incident response workflows:

```bash
#!/bin/bash
# Observe all drops in the production namespace
hubble observe --namespace production --type drop --follow

# Observe all flows from a specific pod
hubble observe \
  --namespace production \
  --pod frontend-7d5c84b9f-xk2lp \
  --follow

# Find L7 policy violations
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --protocol http \
  --output json \
  | jq '{
      source: .source.namespace + "/" + .source.pod_name,
      destination: .destination.namespace + "/" + .destination.pod_name,
      method: .l7.http.method,
      url: .l7.http.url,
      verdict: .verdict,
      drop_reason: .drop_reason_desc
    }'

# Summarise traffic between two services over 60 seconds
hubble observe \
  --namespace production \
  --from-label "app=frontend" \
  --to-label "app=api-server" \
  --last 60s \
  --output json \
  | jq -s 'group_by(.verdict) | map({verdict: .[0].verdict, count: length})'
```

### Hubble Metrics Configuration

Hubble exposes Prometheus metrics for flow-level observability. Configure fine-grained metric labels:

```yaml
hubble:
  enabled: true
  relay:
    enabled: true
    replicas: 2
  ui:
    enabled: true
    replicas: 1
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
```

Key Prometheus metrics surfaced by Hubble include `hubble_drop_total` (labelled by reason and direction), `hubble_flows_processed_total` (labelled by verdict, protocol, and direction), and `hubble_http_requests_total` (labelled by method, status code, source, and destination workload).

## BGP Control Plane for Bare-Metal Load Balancing

In cloud environments, LoadBalancer Services are provisioned by the cloud controller manager. On bare-metal or private clouds, that mechanism is absent. Cilium's **BGP control plane** fills this gap by advertising Service VIPs to upstream routers using standard BGP, enabling physical load balancers and ToR switches to route directly to Kubernetes pods.

### CiliumBGPPeeringPolicy

The `CiliumBGPPeeringPolicy` CRD configures BGP peering on a per-node basis using label selectors:

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: bgp-peering-policy
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux
  virtualRouters:
    - localASN: 64512
      exportPodCIDR: true
      serviceSelector:
        matchExpressions:
          - key: somekey
            operator: NotIn
            values:
              - never-used-value
      neighbors:
        - peerAddress: "10.0.0.1/32"
          peerASN: 64513
          connectRetryTimeSeconds: 120
          holdTimeSeconds: 90
          keepAliveTimeSeconds: 30
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 120
```

### IP Pool and Advertisement

Pair the BGP policy with a `CiliumLoadBalancerIPPool` to allocate addresses from a dedicated range, then create a `CiliumBGPAdvertisement` to announce them:

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: production-pool
spec:
  cidrs:
    - cidr: "192.168.10.0/24"
---
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPAdvertisement
metadata:
  name: lb-advertisement
  labels:
    advertise: bgp
spec:
  advertisements:
    - advertisementType: Service
      service:
        addresses:
          - LoadBalancerIP
      selector:
        matchExpressions:
          - key: somekey
            operator: NotIn
            values:
              - never-used-value
```

Services annotated with `io.cilium/lb-ipam-ips` or without a specific IP request receive an address from `production-pool`. The BGP control plane then advertises that address through all configured peering sessions, and the upstream router begins forwarding packets to the Kubernetes nodes.

## Cluster Mesh for Multi-Cluster Connectivity

**Cluster Mesh** extends Cilium's identity model across multiple Kubernetes clusters. Services in cluster-a can reach services in cluster-b using their normal DNS names, and network policies apply across cluster boundaries using shared identities. There is no VPN tunnel overhead — traffic flows directly between nodes across clusters, with eBPF enforcing the cross-cluster policies.

### Cluster Mesh Configuration

Each cluster participating in the mesh requires a unique `cluster.id` and a shared CA. Enable the cluster mesh API server:

```yaml
cluster:
  name: cluster-a
  id: 1

clustermesh:
  useAPIServer: true
  apiserver:
    replicas: 2
    kvstoremesh:
      enabled: true
    service:
      type: LoadBalancer
```

Connect clusters using the Cilium CLI:

```bash
#!/bin/bash
set -euo pipefail

# On cluster-a (context set to cluster-a)
cilium clustermesh enable --service-type LoadBalancer

# On cluster-b (context set to cluster-b)
cilium clustermesh enable --service-type LoadBalancer

# Connect the two clusters (run from cluster-a context)
cilium clustermesh connect --destination-context cluster-b

# Verify mesh status
cilium clustermesh status --wait
```

Once connected, annotate services with `service.cilium.io/global: "true"` to make them globally routable. Cilium automatically load-balances across all endpoints in both clusters, respecting topology-aware routing preferences.

## Bandwidth Management with EDT

The **Earliest Departure Time** (EDT) algorithm is Cilium's implementation of per-pod bandwidth enforcement. Unlike traditional `tc qdisc` approaches that drop packets when limits are exceeded, EDT schedules packet departure times to smooth traffic, dramatically reducing tail latency compared to token-bucket-based rate limiting.

### Enabling Bandwidth Limits

Bandwidth limits are enforced through Kubernetes annotations on pods. Enable the manager in Helm values:

```yaml
bandwidthManager:
  enabled: true
  bbr: true

encryption:
  enabled: true
  type: wireguard
  nodeEncryption: true
  wireguard:
    userspaceFallback: false
```

Apply per-pod limits with annotations:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: bandwidth-limited-pod
  namespace: production
  annotations:
    kubernetes.io/egress-bandwidth: "100M"
    kubernetes.io/ingress-bandwidth: "100M"
spec:
  containers:
    - name: app
      image: nginx:latest
      resources:
        requests:
          cpu: 200m
          memory: 256Mi
        limits:
          cpu: 500m
          memory: 512Mi
```

The `bbr: true` option enables **TCP BBR** congestion control at the eBPF layer for all pods on the node, improving throughput utilization under packet loss conditions — particularly valuable for cross-AZ traffic.

## WireGuard Encryption Between Nodes

Cilium's **WireGuard** integration provides transparent, kernel-accelerated encryption for all node-to-node traffic. Every packet leaving a node for another cluster node is encrypted in the kernel WireGuard implementation, with zero application changes required. Keys are automatically rotated by the Cilium agent.

WireGuard encryption is configured in the Helm values shown earlier. Verify encryption is active:

```bash
#!/bin/bash
# Verify WireGuard encryption status
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg encrypt status

# Show WireGuard peers on a node
kubectl -n kube-system exec ds/cilium -- \
  wg show cilium_wg0

# Verify traffic is encrypted between two nodes
# (should show WireGuard tunnel interface in path)
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg debuginfo | grep -A 5 "WireGuard"
```

The `nodeEncryption: true` flag additionally encrypts host-to-pod traffic, not just pod-to-pod traffic. This is critical for compliance frameworks that require encryption of all data in transit, including management plane communications.

## Egress Gateway Policy

The **Egress Gateway** feature allows specific pods to exit the cluster through a dedicated node, presenting a stable source IP to external services. This is essential when external firewalls or APIs enforce IP allowlisting:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: egress-gateway-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: legacy-service
  egress:
    - toFQDNs:
        - matchPattern: "*.internal.example.com"
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
          rules:
            dns:
              - matchPattern: "*"
```

Pair this with a `CiliumEgressGatewayPolicy` (in the `cilium.io/v2` API) to specify which node serves as the gateway:

```yaml
apiVersion: cilium.io/v2
kind: CiliumEgressGatewayPolicy
metadata:
  name: legacy-service-egress
spec:
  selectors:
    - podSelector:
        matchLabels:
          app: legacy-service
  destinationCIDRs:
    - "10.100.0.0/16"
  egressGateway:
    nodeSelector:
      matchLabels:
        egress-gateway: "true"
    interface: eth0
    egressIP: "10.100.200.50"
```

All egress traffic from `app: legacy-service` pods to `10.100.0.0/16` is SNAT'd to `10.100.200.50` on the designated gateway node, regardless of which node the originating pod runs on.

## Troubleshooting: cilium-dbg and Connectivity Tests

### cilium-dbg: The Primary Diagnostic Tool

The `cilium-dbg` binary (packaged inside the Cilium agent container) provides deep insight into the eBPF datapath state. It is the first tool to reach for when diagnosing policy, connectivity, or performance issues:

```bash
#!/bin/bash
# Comprehensive Cilium diagnostics

# Overall agent status
cilium-dbg status --verbose

# List all endpoints and their security identities
cilium-dbg endpoint list

# Inspect policy for a specific endpoint (use endpoint ID from list above)
cilium-dbg bpf policy get --all

# Check connection tracking table
cilium-dbg bpf ct list global | head -50

# Inspect BPF map sizes (check for near-full maps)
cilium-dbg bpf metrics list

# Check NAT table
cilium-dbg bpf nat list | grep -v "EXPIRES" | wc -l

# Verify service load balancing entries
cilium-dbg service list

# Check for policy drops with reason
cilium-dbg monitor --type drop
```

### Cilium Connectivity Tests

The `cilium connectivity test` suite validates the full datapath end-to-end, including L7 policy enforcement, DNS resolution, and external connectivity:

```bash
#!/bin/bash
set -euo pipefail

# Run connectivity tests in dedicated namespace
cilium connectivity test --test-namespace cilium-test

# Run only specific test categories
cilium connectivity test \
  --test-namespace cilium-test \
  --include-conn-disrupt-test \
  --collect-sysdump-on-failure

# Observe flows during tests with Hubble
hubble observe --namespace cilium-test --follow &
HUBBLE_PID=$!

cilium connectivity test --test-namespace cilium-test
kill "${HUBBLE_PID}" 2>/dev/null || true
```

### Common Troubleshooting Scenarios

**Pods cannot communicate after policy applied:** Check the Hubble observe output for drops, then verify the endpoint identity assigned to the source pod matches the `fromEndpoints` selector. Use `cilium-dbg endpoint list` to see identities and `cilium-dbg policy get` to inspect the compiled policy.

**kube-proxy replacement issues with NodePort:** Verify `cilium-dbg status` shows `KubeProxyReplacement: True` and that the `k8sServiceHost` and `k8sServicePort` values match the actual API server endpoint. Misconfigured values cause the agent to fall back to partial replacement mode.

**High drop rate visible in Hubble:** Examine `hubble observe --type drop --follow`. The `drop_reason_desc` field identifies the specific BPF program decision. Common reasons include `Policy denied`, `No mapping for ingress policy`, and `Unknown L3 destination`.

**BGP peering not establishing:** Use `cilium-dbg bgp peers` to view peering state. Check that the node label selector in `CiliumBGPPeeringPolicy` matches the nodes where peering should activate, and verify network connectivity between Kubernetes nodes and the BGP neighbor on port 179.

## Production Operational Considerations

### BPF Map Sizing

BPF maps have hard size limits configured at install time. Monitor map utilization proactively:

```bash
#!/bin/bash
# Check BPF map fill percentages
kubectl -n kube-system exec ds/cilium -- \
  cilium-dbg bpf metrics list \
  | awk 'NR > 1 && $3 != "0" {
      used=$3; capacity=$4;
      if (capacity > 0) {
        pct = (used/capacity)*100;
        if (pct > 70) printf "WARNING: %s is %.1f%% full (%d/%d)\n", $1, pct, used, capacity
      }
    }'
```

Maps that approach capacity cause silent drops. Adjust `bpfMapDynamicSizeRatio` in Helm values (default `0.25`) or set explicit map sizes for high-traffic clusters.

### Upgrading Cilium

Cilium supports rolling upgrades with no downtime. The standard procedure updates the operator first, then the agents:

```bash
#!/bin/bash
set -euo pipefail

NEW_VERSION="1.16.1"

# Pre-flight check
cilium upgrade --dry-run \
  --version "${NEW_VERSION}" \
  --values cilium-values.yaml

# Apply upgrade
helm upgrade cilium cilium/cilium \
  --version "${NEW_VERSION}" \
  --namespace kube-system \
  --values cilium-values.yaml \
  --wait

# Verify post-upgrade
cilium-dbg status
cilium connectivity test --test-namespace cilium-test
```

### Monitoring and Alerting

Critical Cilium alerts for production environments:

- `cilium_drop_count_total` spike by reason `Policy denied` — indicates a policy misconfiguration affecting live traffic
- `cilium_endpoint_regenerations_total` with state `failure` — endpoint policy compilation failures
- `hubble_flows_processed_total` drop to zero — Hubble relay failure, loss of observability
- BPF map utilization above 80% on any map type — impending silent drop condition
- BGP session flaps in `CiliumBGPPeeringPolicy` state — upstream routing disruption

Cilium exposes all of these as Prometheus metrics. The Cilium project provides an official Grafana dashboard (ID 16611) as a starting point for production dashboards.

## Conclusion

Cilium's eBPF-based architecture provides capabilities that simply cannot be replicated with iptables-based networking: O(1) service lookup at any scale, L7-aware policies that enforce application-layer intent, DNS-based egress controls with TTL-accurate IP tracking, and transparent WireGuard encryption without application modification. The Hubble observability plane makes network behavior inspectable in real time — a capability that transforms incident response from guesswork into systematic diagnosis.

For enterprise Kubernetes deployments, the operational investment in Cilium pays compounding dividends: fewer policy exceptions due to IP address churn, lower latency at high service counts, and an observability foundation that supports both security investigations and performance engineering. The BGP control plane and cluster mesh capabilities extend these benefits to bare-metal and multi-cluster architectures that cloud-native load balancers cannot serve.
