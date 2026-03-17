---
title: "Kubernetes CNI Deep Dive: Understanding Container Network Interface Architecture"
date: 2027-08-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CNI", "Networking", "Cilium", "Calico"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes CNI architecture covering Flannel, Calico, Cilium, and Weave, with IPAM deep dives, overlay vs underlay networking, BGP peering, eBPF datapath analysis, and production troubleshooting techniques."
more_link: "yes"
url: "/kubernetes-cni-deep-dive-guide/"
---

The Container Network Interface (CNI) specification is the foundation of all pod-to-pod communication in Kubernetes. Selecting and operating the wrong CNI for a workload profile leads to unpredictable latency spikes, NAT hairpin issues, and difficult-to-diagnose connectivity failures at scale. This guide provides a production-grade treatment of CNI architecture, plugin comparison, IPAM models, and debugging methodology that enterprise teams can apply directly to running clusters.

<!--more-->

## Section 1: CNI Specification and Plugin Invocation Lifecycle

The CNI specification defines a minimal contract between a container runtime and a network plugin. When the kubelet creates a pod sandbox, it invokes the configured CNI plugin binary via the `ADD` operation, passing a JSON configuration on stdin and environment variables describing the container namespace, interface name, and network configuration.

### Plugin Binary Invocation

```bash
# CNI binaries reside in /opt/cni/bin on each node
ls /opt/cni/bin
# bandwidth  bridge  dhcp  firewall  flannel  host-device  host-local
# ipvlan  loopback  macvlan  portmap  ptp  sbr  static  tuning  vlan  vrf

# The kubelet reads configuration from /etc/cni/net.d/
ls /etc/cni/net.d/
# 05-cilium.conflist  10-calico.conflist

# A conflist chains multiple plugins
cat /etc/cni/net.d/05-cilium.conflist
```

```json
{
  "name": "cilium",
  "cniVersion": "0.3.1",
  "plugins": [
    {
      "type": "cilium-cni",
      "enable-debug": false,
      "log-file": "/var/run/cilium/cilium-cni.log"
    }
  ]
}
```

### ADD / DEL / CHECK Operations

The three mandatory operations are:

| Operation | Trigger | Purpose |
|-----------|---------|---------|
| `ADD` | Pod creation | Attach network interface, allocate IP, configure routes |
| `DEL` | Pod deletion | Release IP, remove interface and routes |
| `CHECK` | Periodic health | Verify interface and routing still match expected state |

The runtime passes `CNI_COMMAND`, `CNI_CONTAINERID`, `CNI_NETNS`, `CNI_IFNAME`, and `CNI_PATH` as environment variables to the plugin binary.

## Section 2: IP Address Management (IPAM)

IPAM is the sub-component responsible for allocating IP addresses from a pool. CNI delegates IPAM to either a bundled binary (`host-local`, `dhcp`, `static`) or a custom daemon (Calico's IPAM, Cilium's IPAM operator).

### host-local IPAM

The simplest model: allocate from a subnet on each node, stored in flat files under `/var/lib/cni/networks/`.

```json
{
  "ipam": {
    "type": "host-local",
    "ranges": [
      [{ "subnet": "10.244.0.0/24" }]
    ],
    "routes": [
      { "dst": "0.0.0.0/0" }
    ]
  }
}
```

Limitations: no cross-node deduplication, lease files lost on node reimaging, no IPv6 dual-stack support in older versions.

### Calico IPAM

Calico uses a distributed block-allocation model. The `calico-ipam` daemon divides a larger CIDR into `/26` blocks (64 addresses) and assigns entire blocks to nodes. This eliminates per-IP coordination overhead.

```bash
# Inspect block allocation across nodes
calicoctl ipam show --show-blocks
# +----------+-------------------+------------+------------+
# | GROUPING |       CIDR        | IPS TOTAL  | IPS IN USE |
# +----------+-------------------+------------+------------+
# | IP Pool  | 192.168.0.0/16    | 65536      | 312        |
# | Block    | 192.168.0.0/26    | 64         | 14         |
# | Block    | 192.168.0.64/26   | 64         | 21         |
# +----------+-------------------+------------+------------+

# Check which node owns a block
calicoctl get ipamblock 192.168.0.0-26 -o yaml
```

### Cilium IPAM Modes

Cilium supports multiple IPAM modes selected via Helm values:

```yaml
# values.yaml excerpt
ipam:
  mode: "cluster-pool"          # Options: cluster-pool, kubernetes, eni, azure, alibabacloud
  operator:
    clusterPoolIPv4PodCIDRList:
      - "10.0.0.0/8"
    clusterPoolIPv4MaskSize: 24  # /24 per node = 254 pods
```

The `kubernetes` mode delegates allocation to the node's `podCIDR` field set by the controller-manager, while `cluster-pool` gives Cilium's operator full control.

## Section 3: Overlay vs. Underlay Networking Models

### Overlay Networking (VXLAN, GENEVE, WireGuard)

Overlay networks encapsulate pod traffic inside UDP packets, allowing pods on different subnets to communicate without BGP or route redistribution on the physical fabric.

```
Pod A (10.244.1.5)
  → flannel0 (VXLAN tunnel, encap in UDP 8472)
    → eth0 Node A (192.168.1.10)
      → eth0 Node B (192.168.1.11)
    → flannel0 (decap)
  → Pod B (10.244.2.7)
```

VXLAN overhead: 50 bytes per packet (UDP + VXLAN header). At 1500-byte MTU, effective payload drops to 1450 bytes, causing fragmentation for applications that assume standard Ethernet MTU.

```bash
# Check VXLAN tunnel device on a node
ip -d link show flannel.1
# flannel.1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450 qdisc noqueue state UNKNOWN
#   vxlan id 1 local 192.168.1.10 dev eth0 srcport 0 0 dstport 8472 nolearning

# Verify MTU propagation to pods
kubectl exec -n default pod/web-6d8b9 -- ip link show eth0
# eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450
```

### Underlay Networking (BGP, Direct Routing)

Calico in BGP mode programs routes directly on the node's routing table and peers with the physical Top-of-Rack (ToR) switch, eliminating encapsulation overhead.

```yaml
# Calico BGPConfiguration
apiVersion: projectcalico.org/v3
kind: BGPConfiguration
metadata:
  name: default
spec:
  logSeverityScreen: Info
  nodeToNodeMeshEnabled: true
  asNumber: 65001
---
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: tor-switch-peer
spec:
  peerIP: 192.168.1.1
  asNumber: 65000
  keepOriginalNextHop: false
```

```bash
# Verify BGP sessions
calicoctl node status
# Calico process is running.
# IPv4 BGP status
# +---------------+-------------------+-------+----------+
# | PEER ADDRESS  |     PEER TYPE     | STATE |  SINCE   |
# +---------------+-------------------+-------+----------+
# | 192.168.1.1   | node specific     | up    | 10:30:12 |
# | 192.168.1.20  | node-to-node mesh | up    | 10:30:15 |
# +---------------+-------------------+-------+----------+
```

## Section 4: Flannel Architecture and Use Cases

Flannel is the simplest CNI plugin, suitable for small clusters or development environments where operational complexity must be minimized.

### Flannel Backend Options

```json
{
  "Network": "10.244.0.0/16",
  "Backend": {
    "Type": "vxlan",
    "DirectRouting": true
  }
}
```

With `DirectRouting: true`, Flannel attempts to route directly between nodes on the same L2 segment, falling back to VXLAN only for nodes on different subnets.

### Flannel Limitations

- No network policy support (requires pairing with Calico policy engine via Canal)
- No per-pod bandwidth limiting
- VXLAN-only encapsulation on heterogeneous L3 networks
- No IPv6 support in default configurations

## Section 5: Calico Deep Dive

### Calico Architecture Components

```
┌─────────────────────────────────────────────┐
│ Kubernetes Node                              │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Pod A   │  │  Pod B   │  │ calico   │  │
│  │10.0.0.5  │  │10.0.0.6  │  │  node   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │             │         │
│  ┌────┴──────────────┴─────────────┴─────┐  │
│  │         veth pairs + iptables/eBPF    │  │
│  └────────────────────────────────────────┘  │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │  Felix (policy enforcement daemon)  │   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │  BIRD (BGP daemon)                  │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
         │
         │ BGP
         ▼
   ToR Switch / Route Reflector
```

### Felix Policy Enforcement

Felix translates NetworkPolicy and GlobalNetworkPolicy objects into iptables rules or eBPF programs.

```yaml
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: deny-all-egress-except-dns
spec:
  selector: all()
  types:
  - Egress
  egress:
  - action: Allow
    protocol: UDP
    destination:
      ports: [53]
  - action: Allow
    protocol: TCP
    destination:
      ports: [53]
```

```bash
# Inspect iptables rules generated by Felix
iptables -L cali-fw-cali1234abcd -n --line-numbers
# Chain cali-fw-cali1234abcd (1 references)
# num  target     prot opt source     destination
# 1    ACCEPT     all  --  0.0.0.0/0  0.0.0.0/0   /* allowed egress */
# 2    DROP       all  --  0.0.0.0/0  0.0.0.0/0
```

### Calico eBPF Datapath

Enable eBPF mode for Calico to bypass iptables entirely:

```bash
# Enable eBPF datapath
kubectl patch felixconfiguration default \
  --type merge \
  --patch '{"spec":{"bpfEnabled":true}}'

# Verify eBPF maps are loaded
bpftool map list | grep cali
# 42: hash  name cali_v4_snat  flags 0x0
# 43: lpm_trie  name cali_v4_pol  flags 0x1
```

## Section 6: Cilium eBPF Datapath

Cilium replaces the traditional networking stack (iptables + kube-proxy) with eBPF programs loaded directly into the Linux kernel, enabling microsecond-latency policy enforcement.

### Cilium Installation via Helm

```bash
helm repo add cilium https://helm.cilium.io/
helm install cilium cilium/cilium --version 1.15.0 \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=10.0.0.1 \
  --set k8sServicePort=6443 \
  --set ipam.mode=cluster-pool \
  --set ipam.operator.clusterPoolIPv4PodCIDRList="{10.0.0.0/8}" \
  --set ipam.operator.clusterPoolIPv4MaskSize=24 \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true
```

### Hubble Network Observability

Hubble is Cilium's built-in network observability layer, providing per-flow visibility without packet capture overhead.

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --fail --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe live flows
hubble observe --namespace production --follow
# Feb 28 10:30:01.234: production/frontend-6d8 (ID:1234) -> production/backend-9f2 (ID:5678) to-endpoint FORWARDED (TCP Flags: SYN)

# Observe drops
hubble observe --verdict DROPPED --namespace production
```

### Cilium Network Policy (L7-Aware)

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend
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
          path: "/api/v1/.*"
        - method: POST
          path: "/api/v1/items"
```

## Section 7: Weave Net

Weave Net uses an encrypted overlay (Weave Data Plane) and a distributed routing protocol. It is notable for supporting encryption without a key management system and for automatic topology discovery.

```bash
# Weave peer status
kubectl exec -n kube-system weave-net-abcde -c weave -- /home/weave/weave --local status peers
# 70:19:3d:8f:1a:2b(node-1)
#    <- 192.168.1.10:37286    70:20:3d:8f:1a:3c(node-2)
#    <- 192.168.1.11:48921    70:21:3d:8f:1a:4d(node-3)
```

Weave's primary limitation is throughput: the user-space routing daemon creates CPU bottlenecks at high packet rates (>100k pps per node).

## Section 8: CNI Debugging Methodology

### Step 1: Verify Plugin Invocation

```bash
# kubelet CNI plugin failure log
journalctl -u kubelet --since "10 minutes ago" | grep -i cni
# kubelet[12345]: E0228 10:30:01 cni.go:255] Error adding network: failed to set bridge addr
# kubelet[12345]: E0228 10:30:01 cni.go:255] CNI plugin returned error: exit status 1

# Check CNI logs on the node
cat /var/run/cilium/cilium-cni.log
```

### Step 2: Inspect Pod Network Namespace

```bash
# Get the container ID of a failing pod
CONTAINER_ID=$(kubectl get pod web-abc -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's/containerd:\/\///')

# Find the network namespace
crictl inspect $CONTAINER_ID | jq '.info.runtimeSpec.linux.namespaces[] | select(.type=="network")'
# {"type":"network","path":"/var/run/netns/cni-a1b2c3d4-e5f6-7890-abcd-ef1234567890"}

# Enter the namespace and inspect
nsenter --net=/var/run/netns/cni-a1b2c3d4-e5f6-7890-abcd-ef1234567890 ip addr
nsenter --net=/var/run/netns/cni-a1b2c3d4-e5f6-7890-abcd-ef1234567890 ip route
```

### Step 3: Trace Packet Path

```bash
# Test connectivity between pods
kubectl exec -n default pod/client -- tracepath 10.0.1.5

# Use Cilium connectivity test
cilium connectivity test --test pod-to-pod

# Calico packet trace
calicoctl node diags
```

### Step 4: Validate IPAM Allocation

```bash
# Check for IP exhaustion (Calico)
calicoctl ipam show --show-blocks | grep "IPS IN USE"

# Check for IP leaks (orphaned allocations)
calicoctl ipam check

# Cilium IPAM state
cilium ipam
# IP            OWNER                        NAMESPACE   NODE
# 10.0.0.100    pod-name-abc123              default     node-1
```

## Section 9: CNI Plugin Comparison Matrix

| Feature | Flannel | Calico | Cilium | Weave |
|---------|---------|--------|--------|-------|
| Datapath | iptables/VXLAN | iptables/eBPF/BGP | eBPF | Userspace |
| Network Policy | No (needs Canal) | Yes (L3/L4) | Yes (L3/L4/L7) | Yes (L3/L4) |
| Encryption | No | WireGuard | WireGuard | AES/NaCl |
| IPv6 | Partial | Yes | Yes | Yes |
| BGP Peering | No | Yes | Yes | No |
| Overlay | VXLAN | VXLAN/IPIP | VXLAN/GENEVE | Weave |
| Observability | None | Felix stats | Hubble | Weave Status |
| Multi-cluster | No | Federation | Cluster Mesh | No |
| Throughput | Medium | High | Highest | Low |
| Operational Complexity | Low | Medium | High | Low |

## Section 10: Choosing a CNI for Production

### Decision Tree

```
Start
  │
  ├─ Need L7 network policy (HTTP, gRPC methods)?
  │    └─ YES → Cilium
  │
  ├─ Need multi-cluster connectivity?
  │    ├─ YES → Cilium Cluster Mesh or Calico Federation
  │    └─ Need to peer with ToR switches via BGP?
  │         └─ YES → Calico BGP mode
  │
  ├─ Need encrypted pod traffic?
  │    └─ YES → Cilium WireGuard or Calico WireGuard
  │
  ├─ Running on managed cloud (EKS, GKE, AKS)?
  │    ├─ EKS → AWS VPC CNI (primary) or Cilium (ENI mode)
  │    ├─ GKE → Dataplane V2 (Cilium-based)
  │    └─ AKS → Azure CNI Overlay or Cilium
  │
  └─ Small cluster, minimal ops overhead?
       └─ YES → Flannel
```

### Production Recommendations

For clusters exceeding 500 nodes, avoid iptables-based CNIs. At that scale, iptables rule sets grow to tens of thousands of entries, and each rule update requires a full table rewrite, causing latency spikes.

```bash
# Measure iptables rule count on a large cluster node
iptables-save | wc -l
# 47382  ← problematic at this scale

# Compare with Cilium eBPF map lookup (O(1) regardless of policy count)
cilium bpf policy get --all | wc -l
# 142  ← flat regardless of cluster size
```

## Section 11: CNI Upgrade Procedures

### Calico Version Upgrade

```bash
# Check current version
kubectl get daemonset calico-node -n kube-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
# docker.io/calico/node:v3.27.0

# Apply new version manifest
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/calico.yaml

# Monitor rollout
kubectl rollout status daemonset/calico-node -n kube-system --timeout=300s

# Verify all nodes have updated
kubectl get pods -n kube-system -l k8s-app=calico-node \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\t"}{.status.containerStatuses[0].image}{"\n"}{end}'
```

### Cilium Version Upgrade

```bash
# Use Cilium CLI for safe upgrades (validates compatibility)
cilium upgrade --version 1.16.0

# Monitor upgrade progress
cilium status --wait

# Validate connectivity after upgrade
cilium connectivity test --test pod-to-pod --test pod-to-service
```

## Summary

CNI selection is a foundational architectural decision with long-term operational consequences. Flannel serves development and small clusters. Calico with BGP delivers wire-rate performance in bare-metal environments with complex policy requirements. Cilium provides the highest throughput, L7-aware policy enforcement, and multi-cluster connectivity via Cluster Mesh, at the cost of higher operational complexity. Always validate MTU propagation, IPAM exhaustion headroom, and node-level eBPF map limits before deploying to production.
