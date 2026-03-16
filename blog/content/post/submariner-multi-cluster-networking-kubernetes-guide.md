---
title: "Submariner: Cross-Cluster Networking for Kubernetes Federation"
date: 2027-01-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Submariner", "Multi-Cluster", "Networking", "Federation"]
categories: ["Kubernetes", "Networking", "Multi-Cluster"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Submariner for cross-cluster Kubernetes networking, covering gateway setup, service discovery with Lighthouse, Globalnet for overlapping CIDRs, cable drivers, and production troubleshooting."
more_link: "yes"
url: "/submariner-multi-cluster-networking-kubernetes-guide/"
---

Connecting multiple Kubernetes clusters so that pods on one cluster can communicate directly with pods and services on another has historically required complex VPN overlays, external load balancers, or custom proxy layers. **Submariner** solves this problem natively: it establishes encrypted tunnels between cluster gateways, synchronises service discovery via Lighthouse, and handles overlapping pod CIDRs through its Globalnet extension. This guide covers every layer of a production Submariner deployment—from architecture and installation through service export patterns, cable driver selection, and day-2 operations.

<!--more-->

## Submariner Architecture

Submariner is composed of four core components that work together across cluster boundaries.

### Core Components

**The Broker** is a Kubernetes API server (or a dedicated namespace on an existing cluster) that acts as the coordination plane. All participating clusters connect to the Broker to exchange network topology information—pod CIDRs, service CIDRs, and endpoint metadata—without routing actual data-plane traffic through it.

**The Gateway** is a DaemonSet pod (typically pinned to one or more designated gateway nodes) that terminates the inter-cluster tunnels. Gateways elect an active leader using leader election; standby gateways take over automatically if the active one fails.

**The Route Agent** is a DaemonSet that runs on every node in the cluster. It programs the local routing table so that traffic destined for a remote cluster's pod CIDR is forwarded to the local gateway node.

**Lighthouse** provides cross-cluster DNS-based service discovery. It consists of a CoreDNS plugin (`lighthouse-agent`) running on each cluster that synchronises `ServiceImport` and `ServiceExport` objects through the Broker, and a `lighthouse-coredns` server that resolves `<service>.<namespace>.svc.clusterset.local` queries.

```
Cluster A                           Cluster B
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  Pod → Route Agent (node)   │     │  Route Agent (node) → Pod   │
│         ↓                   │     │         ↑                   │
│  Gateway (active)  ──────── tunnel ──────── Gateway (active)    │
│         │                   │     │         │                   │
│  Lighthouse Agent           │     │  Lighthouse Agent           │
│         │                   │     │         │                   │
└─────────┼───────────────────┘     └─────────┼───────────────────┘
          └─────────── Broker ────────────────┘
                 (ServiceImport/ServiceExport sync)
```

### Network Flow for Cross-Cluster Traffic

When a pod in Cluster A sends a packet to a pod in Cluster B:

1. The Route Agent on the source node has installed a route for Cluster B's pod CIDR pointing at the local gateway node.
2. The packet reaches the active gateway in Cluster A.
3. The gateway encapsulates the packet using the configured cable driver (WireGuard, VXLAN, or IPsec).
4. The encapsulated packet traverses the underlay network to Cluster B's active gateway.
5. The gateway decapsulates the packet and delivers it to the Route Agent path on the destination node.

## Installing subctl

`subctl` is the CLI that orchestrates Submariner installation, cluster joining, diagnostics, and benchmark testing.

```bash
#!/bin/bash
# Install subctl - the Submariner CLI tool
set -euo pipefail

SUBCTL_VERSION="0.17.0"
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  *)       echo "Unsupported architecture: ${ARCH}"; exit 1 ;;
esac

curl -sLO "https://github.com/submariner-io/subctl/releases/download/v${SUBCTL_VERSION}/subctl-v${SUBCTL_VERSION}-linux-${ARCH}.tar.gz"
tar xzf "subctl-v${SUBCTL_VERSION}-linux-${ARCH}.tar.gz"
sudo install "subctl-v${SUBCTL_VERSION}/subctl-linux-${ARCH}" /usr/local/bin/subctl
rm -rf "subctl-v${SUBCTL_VERSION}" "subctl-v${SUBCTL_VERSION}-linux-${ARCH}.tar.gz"

subctl version
```

## Deploying the Broker

The Broker should be deployed on a cluster (or dedicated control plane) that all participating clusters can reach. Typically this is the management cluster or a dedicated Broker cluster.

```bash
#!/bin/bash
# Deploy the Submariner Broker
# Run this against the broker cluster context

set -euo pipefail

BROKER_KUBECONFIG="${HOME}/.kube/broker-cluster.yaml"

export KUBECONFIG="${BROKER_KUBECONFIG}"

# Deploy broker with default settings; enable Globalnet for overlapping CIDRs
subctl deploy-broker \
  --globalnet \
  --globalnet-cidr-range "242.0.0.0/8" \
  --default-globalnet-cluster-size 65536

# The broker deployment creates submariner-k8s-broker namespace
# and exports broker-info.subm containing credentials
ls -la broker-info.subm
echo "Broker deployed. broker-info.subm contains join credentials."
```

The generated `broker-info.subm` file contains the Broker API endpoint, CA certificate, and a service account token. Treat it as a secret and distribute it securely to operators of each joining cluster.

### Broker High Availability

For production environments, the Broker namespace should live on a highly available control plane. The Broker itself is stateless beyond the Kubernetes objects it stores, so any multi-master cluster provides HA automatically. Back up the `broker-info.subm` file in a secrets manager (HashiCorp Vault, AWS Secrets Manager, or similar) immediately after generation.

## Joining Clusters

Each data-plane cluster runs the full Submariner stack (gateway, route agent, Lighthouse). Join each cluster using `subctl join`.

### Joining Cluster A

```bash
#!/bin/bash
# Join Cluster A to the Submariner mesh
set -euo pipefail

CLUSTER_A_KUBECONFIG="${HOME}/.kube/cluster-a.yaml"
export KUBECONFIG="${CLUSTER_A_KUBECONFIG}"

# Label dedicated gateway nodes before joining
# Gateway nodes need a public IP or stable private IP reachable by peers
kubectl label node gateway-node-a1 submariner.io/gateway=true
kubectl label node gateway-node-a2 submariner.io/gateway=true

subctl join broker-info.subm \
  --clusterid cluster-a \
  --cable-driver wireguard \
  --natt-discovery-port 4490 \
  --pod-debug-log \
  --kubeconfig "${CLUSTER_A_KUBECONFIG}"
```

### Joining Cluster B

```bash
#!/bin/bash
# Join Cluster B to the Submariner mesh
set -euo pipefail

CLUSTER_B_KUBECONFIG="${HOME}/.kube/cluster-b.yaml"
export KUBECONFIG="${CLUSTER_B_KUBECONFIG}"

kubectl label node gateway-node-b1 submariner.io/gateway=true

subctl join broker-info.subm \
  --clusterid cluster-b \
  --cable-driver wireguard \
  --natt-discovery-port 4490 \
  --kubeconfig "${CLUSTER_B_KUBECONFIG}"
```

### Verifying the Connection

```bash
#!/bin/bash
# Verify cross-cluster connectivity
set -euo pipefail

export KUBECONFIG="${HOME}/.kube/cluster-a.yaml"

# Check overall Submariner status
subctl show all

# Run the built-in connectivity diagnostic
subctl diagnose all

# Run the data-plane benchmark between clusters
subctl benchmark latency \
  --kubecontexts cluster-a,cluster-b \
  --verbose

subctl benchmark throughput \
  --kubecontexts cluster-a,cluster-b \
  --verbose
```

Expected `subctl show all` output shows connected endpoints, cable driver, and NAT-T discovery state for each gateway pair.

## Service Discovery with Lighthouse

Lighthouse extends Kubernetes service discovery across cluster boundaries using the **MCS API** (Multi-Cluster Services) defined in KEP-1645.

### Exporting a Service

A `ServiceExport` object signals Lighthouse to make a service discoverable from other clusters.

```yaml
# Export the orders-api service from Cluster A
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: orders-api
  namespace: commerce
```

Lighthouse on Cluster A sees this object, creates a corresponding `ServiceImport` on the Broker, which is then propagated to all other joined clusters.

### Consuming an Exported Service

From any pod in Cluster B, the service is reachable at:

```
orders-api.commerce.svc.clusterset.local
```

The `clusterset.local` zone is served by the Lighthouse CoreDNS plugin. If the pod needs to target a specific cluster's instance, use:

```
orders-api.commerce.svc.cluster-a.svc.clusterset.local
```

### Lighthouse CoreDNS Plugin Configuration

Submariner automatically patches the CoreDNS ConfigMap on each cluster to add the Lighthouse zone. Verify the patch is in place:

```bash
kubectl -n kube-system get configmap coredns -o yaml
```

The relevant snippet should appear as:

```
clusterset.local:53 {
    forward . submariner-lighthouse-coredns.submariner-operator.svc.cluster.local:53
}
```

### ServiceExport for a StatefulSet with Individual Endpoints

For headless services backed by a StatefulSet (databases, queues), export the headless service so that DNS returns individual pod IPs from all clusters:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: cassandra-headless
  namespace: datastores
spec:
  clusterIP: None
  selector:
    app: cassandra
  ports:
    - port: 9042
      name: cql
---
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: cassandra-headless
  namespace: datastores
```

## Globalnet: Handling Overlapping CIDRs

In environments where clusters were provisioned independently, pod CIDRs and service CIDRs frequently overlap (e.g., every cluster uses `10.244.0.0/16`). **Globalnet** solves this by assigning each cluster a unique global CIDR block from a non-overlapping range, then translating local addresses to global addresses at the gateway.

### How Globalnet Works

When Globalnet is enabled:

1. Each cluster receives a unique `/16` (or configured size) block from the global CIDR pool (e.g., `242.0.0.0/8`).
2. The gateway uses iptables rules to SNAT outbound traffic from the cluster's pod CIDR to a global IP within the cluster's assigned block.
3. Remote clusters route to the global IP, which the gateway translates back to the actual pod IP on ingress.

### Globalnet ClusterGlobalEgressIP

Control which global IPs are allocated per namespace or per pod using `ClusterGlobalEgressIP`:

```yaml
apiVersion: submariner.io/v1alpha1
kind: ClusterGlobalEgressIP
metadata:
  name: cluster-a-egress
  namespace: submariner-operator
spec:
  numberOfIPs: 5
```

For namespace-scoped allocation:

```yaml
apiVersion: submariner.io/v1alpha1
kind: GlobalEgressIP
metadata:
  name: commerce-egress
  namespace: commerce
spec:
  numberOfIPs: 3
  podSelector:
    matchLabels:
      tier: backend
```

### Verifying Globalnet Assignments

```bash
#!/bin/bash
# Inspect Globalnet IP assignments
set -euo pipefail

export KUBECONFIG="${HOME}/.kube/cluster-a.yaml"

# Show global CIDR assignments per cluster
kubectl -n submariner-operator get clusterglobalegressips -o wide

# Show per-namespace global egress IPs
kubectl get globalegressips --all-namespaces

# Show gateway endpoint with global CIDR
kubectl -n submariner-operator get endpoints.submariner.io -o yaml | \
  grep -A 5 "globalCIDR"
```

## Cable Driver Selection

The cable driver controls how inter-gateway tunnels are established. Submariner supports three drivers, each with distinct trade-offs.

### WireGuard (Recommended for Production)

WireGuard provides the best throughput-to-CPU ratio and automatic key rotation. It requires the WireGuard kernel module (`wireguard` or built-in on Linux 5.6+).

**Characteristics:**
- Kernel-space implementation: lowest latency, highest throughput
- ChaCha20-Poly1305 encryption: hardware-accelerated on modern CPUs
- UDP port 4500 (configurable)
- Automatic peer key rotation via Submariner operator

```bash
# Verify WireGuard module availability before joining
lsmod | grep wireguard
# or on kernels 5.6+:
modinfo wireguard

# Check WireGuard tunnel status after join
kubectl -n submariner-operator exec -it ds/submariner-gateway -- \
  wg show all
```

### VXLAN (No Encryption, High Throughput)

VXLAN is suitable for environments where the underlay network provides its own encryption (e.g., IPsec-enabled fabric) or when maximum raw throughput is the priority.

- Layer 2 encapsulation over UDP
- Lower CPU overhead than WireGuard for pure throughput
- No built-in encryption—combine with network-level encryption

### IPsec (Libreswan)

IPsec via Libreswan is the legacy default. It is more widely supported in regulated environments that mandate IPsec for compliance.

- Standards-based (IKEv2)
- Higher CPU overhead than WireGuard
- Compatible with external IPsec peers and hardware VPN appliances

```bash
# Join with IPsec cable driver
subctl join broker-info.subm \
  --clusterid cluster-c \
  --cable-driver libreswan \
  --natt-discovery-port 4490
```

### Cable Driver Performance Comparison

| Driver     | Throughput  | CPU overhead | Encryption | NAT traversal |
|------------|-------------|--------------|------------|---------------|
| WireGuard  | Highest     | Lowest       | Yes        | Yes (UDP 4500) |
| VXLAN      | High        | Low          | No         | Yes (UDP 4800) |
| Libreswan  | Moderate    | Moderate     | Yes        | Yes (UDP 4500) |

## Network Policies Across Clusters

Submariner does not extend Kubernetes `NetworkPolicy` objects across clusters—network policies remain cluster-local. Cross-cluster traffic arrives at pods from the gateway node IP. To enforce policies on cross-cluster ingress, use the gateway node's IP range as the source CIDR in `NetworkPolicy` objects.

### Restricting Cross-Cluster Ingress

```yaml
# Allow ingress only from the other cluster's pod CIDR via the gateway
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-cross-cluster-orders
  namespace: commerce
spec:
  podSelector:
    matchLabels:
      app: orders-api
  ingress:
    - from:
        - ipBlock:
            # Cluster B's pod CIDR
            cidr: "10.128.0.0/14"
      ports:
        - protocol: TCP
          port: 8080
  policyTypes:
    - Ingress
```

When Globalnet is active, remote pods appear as IPs from the global CIDR block. Adjust the `ipBlock` to reference the remote cluster's assigned global CIDR instead of its pod CIDR.

### Using Cilium for Cross-Cluster Policies

If Cilium is the CNI on both clusters, `CiliumNetworkPolicy` objects can match on labels from `ServiceImport` objects, providing identity-aware cross-cluster policies without relying on CIDR-based rules. This integration is experimental as of Submariner 0.17.

## Monitoring Submariner

### Prometheus Metrics

Submariner exposes Prometheus metrics from the gateway and operator pods.

```yaml
# ServiceMonitor for Submariner gateway metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: submariner-gateway
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - submariner-operator
  selector:
    matchLabels:
      app: submariner-gateway
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Metrics to Alert On

```yaml
# PrometheusRule for Submariner alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: submariner-alerts
  namespace: monitoring
spec:
  groups:
    - name: submariner.gateway
      rules:
        - alert: SubmarinerGatewayConnectionDown
          expr: submariner_gateway_connections{status="error"} > 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Submariner gateway connection is in error state"
            description: "Gateway {{ $labels.local_cluster }} to {{ $labels.remote_cluster }} via {{ $labels.cable_driver }} is down."

        - alert: SubmarinerGatewayNotConnected
          expr: submariner_gateway_connections{status="connecting"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Submariner gateway is stuck connecting"
            description: "Gateway {{ $labels.local_cluster }} has been in connecting state for >5 minutes."

        - alert: SubmarinerRouteAgentUnhealthy
          expr: kube_daemonset_status_number_unavailable{daemonset="submariner-routeagent", namespace="submariner-operator"} > 0
          for: 3m
          labels:
            severity: warning
          annotations:
            summary: "Submariner route agent pods unavailable"
            description: "{{ $value }} route agent pod(s) are unavailable."

        - alert: SubmarinerLighthouseCoreDNSDown
          expr: kube_deployment_status_replicas_available{deployment="submariner-lighthouse-coredns", namespace="submariner-operator"} == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Lighthouse CoreDNS has no available replicas"
            description: "Cross-cluster service discovery is broken."
```

### Grafana Dashboard Panels

Key panels for a Submariner operations dashboard:

- **Gateway connection status**: `submariner_gateway_connections` grouped by `status`
- **Tunnel packet counts**: `rate(submariner_gateway_rx_bytes_total[5m])` and `rate(submariner_gateway_tx_bytes_total[5m])`
- **Route agent sync latency**: `submariner_routeagent_sync_duration_seconds`
- **Lighthouse DNS resolution latency**: Capture from CoreDNS `coredns_dns_request_duration_seconds{server="dns://0.0.0.0:53",zone="clusterset.local."}`

## Troubleshooting Connectivity

### Systematic Diagnostic Runbook

```bash
#!/bin/bash
# Submariner connectivity troubleshooting runbook
set -euo pipefail

CLUSTER_A_CTX="cluster-a"
CLUSTER_B_CTX="cluster-b"

echo "=== Step 1: Check Submariner component health ==="
subctl show all --kubeconfig "${HOME}/.kube/cluster-a.yaml"

echo ""
echo "=== Step 2: Run built-in diagnostics ==="
subctl diagnose all --kubeconfig "${HOME}/.kube/cluster-a.yaml"

echo ""
echo "=== Step 3: Check gateway pod logs ==="
kubectl --context="${CLUSTER_A_CTX}" \
  -n submariner-operator logs \
  -l app=submariner-gateway \
  --tail=100

echo ""
echo "=== Step 4: Check route agent logs on source node ==="
kubectl --context="${CLUSTER_A_CTX}" \
  -n submariner-operator logs \
  -l app=submariner-routeagent \
  --tail=50

echo ""
echo "=== Step 5: Verify routing table on a worker node ==="
# Run on the node where the test pod is scheduled
kubectl --context="${CLUSTER_A_CTX}" \
  -n submariner-operator debug node/worker-node-a1 \
  --image=busybox -- ip route show table all | grep -E "242\.|10\.128\."

echo ""
echo "=== Step 6: Direct pod-to-pod connectivity test ==="
# Create a test pod in Cluster A
kubectl --context="${CLUSTER_A_CTX}" run nettest \
  --image=busybox --restart=Never --rm -it \
  -- sh -c 'ping -c 3 <CLUSTER_B_POD_IP>'

echo ""
echo "=== Step 7: DNS resolution test ==="
kubectl --context="${CLUSTER_A_CTX}" run dnstest \
  --image=busybox --restart=Never --rm -it \
  -- nslookup orders-api.commerce.svc.clusterset.local
```

### Common Issues and Resolutions

**Issue: Gateways connect but pods cannot reach remote pods**

Check that route agent pods are running on the source node and that the routing table entry is installed:

```bash
ip route show table 100
# Expected: <remote-cluster-pod-cidr> via <gateway-node-ip> dev vxlan0
```

If missing, restart the route agent on the affected node:

```bash
AFFECTED_NODE="worker-node-01"
kubectl -n submariner-operator delete pod -l app=submariner-routeagent \
  --field-selector "spec.nodeName=${AFFECTED_NODE}"
```

**Issue: DNS resolution returns NXDOMAIN for clusterset.local**

Verify the CoreDNS patch is applied:

```bash
kubectl -n kube-system get configmap coredns -o yaml | grep clusterset
```

If absent, Lighthouse failed to patch CoreDNS. Check the Lighthouse agent logs:

```bash
kubectl -n submariner-operator logs -l app=submariner-lighthouse-agent --tail=100
```

**Issue: Gateway in "connecting" state for more than 5 minutes**

Common causes:
1. Firewall blocking UDP 4500 (WireGuard/IPsec NAT-T) between gateway node IPs
2. Gateway nodes behind symmetric NAT without hole punching support (use VXLAN driver instead)
3. Mismatched Submariner versions between clusters

Verify firewall rules from each gateway node:

```bash
# From Cluster A gateway node, test UDP connectivity to Cluster B gateway
nc -u -v <cluster-b-gateway-ip> 4500
```

**Issue: Globalnet IP exhaustion**

Check current allocations and free pool:

```bash
kubectl -n submariner-operator get globalnetworks -o yaml
# Look for: allocatedGlobalNetworks and globalCIDRs fields
```

If the pool is exhausted, allocate a larger range during initial Broker deployment or extend it by updating the `ClusterGlobalIngressIPs` pool.

## Use Cases

### Disaster Recovery

In an active-passive DR configuration, export critical services from the primary cluster. When a failover is triggered, the DR cluster's services become the active endpoints without DNS reconfiguration on clients:

```yaml
# Primary cluster: export the payment service
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: payment-service
  namespace: payments
```

Clients resolve `payment-service.payments.svc.clusterset.local`, which initially returns the primary cluster's endpoints. After failover, the DR cluster's Lighthouse agent removes the primary endpoints (the primary's gateway goes offline) and returns only DR endpoints.

### Hybrid Cloud Connectivity

Connect an on-premises cluster to cloud-hosted clusters without external load balancers or VPN appliances. The Submariner gateway on the on-premises cluster establishes WireGuard tunnels directly to cloud cluster gateways, using NAT traversal for firewall traversal.

### Shared Services Model

Deploy shared platform services (observability, secret management, image scanning) on a dedicated services cluster and export them to all application clusters. Application teams consume `vault.platform.svc.clusterset.local` without knowing which cluster hosts Vault.

## Production Hardening

### Gateway Node Selection

Pin gateway pods to nodes with:
- Direct internet access or stable private IPs reachable by peers
- Higher network bandwidth (dedicated network interfaces)
- Low workload contention (taint gateway nodes to prevent regular workloads)

```bash
# Taint gateway nodes so only Submariner pods tolerate them
kubectl taint nodes gateway-node-a1 \
  submariner.io/gateway=true:NoSchedule
```

Submariner automatically tolerates this taint.

### Multiple Gateways for HA

Deploy two gateway nodes per cluster. Submariner performs active-standby leader election automatically. The standby gateway monitors the active via a health check and assumes leadership within 10 seconds of active failure.

```bash
kubectl label node gateway-node-a1 submariner.io/gateway=true
kubectl label node gateway-node-a2 submariner.io/gateway=true
```

### Cable Driver NAT Traversal

For clusters behind NAT, enable NAT traversal discovery:

```bash
subctl join broker-info.subm \
  --clusterid cluster-a \
  --cable-driver wireguard \
  --natt-discovery-port 4490 \
  --force-udp-encaps \
  --natt-port 4500
```

### Upgrading Submariner

Use `subctl` for in-place upgrades. The upgrade process drains gateways one at a time to minimise downtime:

```bash
# Check available versions
subctl version

# Upgrade Cluster A
export KUBECONFIG="${HOME}/.kube/cluster-a.yaml"
subctl upgrade --to-version 0.18.0

# Upgrade Cluster B
export KUBECONFIG="${HOME}/.kube/cluster-b.yaml"
subctl upgrade --to-version 0.18.0

# Verify post-upgrade
subctl show all
subctl diagnose all
```

Always upgrade the Broker cluster last, as newer gateways are backward-compatible with the previous Broker version.

## Performance Benchmarking and Baseline Metrics

Before deploying workloads over Submariner tunnels, establish a performance baseline. Use `subctl benchmark` to measure latency and throughput for each cluster pair:

```bash
#!/bin/bash
# Baseline performance benchmarking between cluster pairs
set -euo pipefail

BENCHMARK_OUTPUT_DIR="submariner-benchmarks-$(date +%Y%m%d)"
mkdir -p "${BENCHMARK_OUTPUT_DIR}"

echo "=== Latency benchmark: cluster-a <-> cluster-b ==="
subctl benchmark latency \
  --kubecontexts cluster-a,cluster-b \
  --verbose \
  2>&1 | tee "${BENCHMARK_OUTPUT_DIR}/latency-a-b.txt"

echo ""
echo "=== Throughput benchmark: cluster-a <-> cluster-b ==="
subctl benchmark throughput \
  --kubecontexts cluster-a,cluster-b \
  --verbose \
  2>&1 | tee "${BENCHMARK_OUTPUT_DIR}/throughput-a-b.txt"

echo ""
echo "=== Extracting key numbers ==="
echo "Latency P50:"
grep -oP 'P50: \K[0-9.]+' "${BENCHMARK_OUTPUT_DIR}/latency-a-b.txt" || echo "  not found"
echo "Throughput:"
grep -oP 'Bandwidth: \K[0-9.]+ [A-Za-z/]+' "${BENCHMARK_OUTPUT_DIR}/throughput-a-b.txt" || echo "  not found"
```

### Expected Performance Characteristics

For a WireGuard-based tunnel between two clusters in the same AWS region:

| Metric | Typical value |
|---|---|
| Additional latency vs bare pod-to-pod | 0.2–0.5 ms |
| Throughput (single flow, m5.4xlarge) | 3–6 Gbps |
| CPU overhead per Gbps | ~5% (WireGuard) |
| Gateway failover time | 8–12 seconds |

Performance degrades linearly with geographic distance. Cross-region deployments (e.g., us-east-1 to eu-west-1) will see 70–90 ms base latency, which is a property of the physical network rather than Submariner overhead.

## Security Considerations

### Rotating WireGuard Keys

Submariner automatically rotates WireGuard keys on a schedule controlled by the `submariner-operator` reconciliation loop. Verify the rotation is occurring:

```bash
#!/bin/bash
# Check WireGuard key rotation timestamps
set -euo pipefail

export KUBECONFIG="${HOME}/.kube/cluster-a.yaml"

# The gateway manages WireGuard public keys via Kubernetes secrets
kubectl -n submariner-operator get secret \
  -l submariner.io/managed-by=submariner \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp'

# Check current WireGuard peers from within the gateway pod
kubectl -n submariner-operator exec -it \
  "$(kubectl -n submariner-operator get pod -l app=submariner-gateway -o name | head -1)" \
  -- wg show wg0
```

### Broker TLS Certificate Management

The Broker endpoint uses TLS certificates stored in the `submariner-k8s-broker` namespace. Monitor certificate expiry:

```bash
#!/bin/bash
# Check Broker TLS certificate expiry
set -euo pipefail

BROKER_KUBECONFIG="${HOME}/.kube/broker-cluster.yaml"
export KUBECONFIG="${BROKER_KUBECONFIG}"

kubectl -n submariner-k8s-broker get secret \
  -l submariner.io/cert-type=broker-tls \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.cert-manager\.io/certificate-expiry-timestamp}{"\n"}{end}'
```

Rotate the Broker credentials by re-running `subctl deploy-broker` with `--force-redeploy` and distributing the new `broker-info.subm` to all joined clusters, then re-running `subctl join`.

## Summary

Submariner delivers production-grade cross-cluster networking through a compact, operator-managed architecture. Its four-component design (Broker, Gateway, Route Agent, Lighthouse) cleanly separates the control plane from the data plane, enabling independent scaling and failure isolation. WireGuard as the cable driver provides the best balance of performance and security for modern Linux kernels, while Globalnet eliminates the CIDR overlap problem that affects most enterprise multi-cluster environments. Combined with the MCS-API-compatible Lighthouse for DNS-based service discovery, Submariner provides the network foundation needed for disaster recovery, hybrid cloud, and shared-services multi-cluster architectures.
