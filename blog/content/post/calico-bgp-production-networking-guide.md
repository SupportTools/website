---
title: "Calico BGP Production Networking: Route Reflectors, IPAM, and Network Policy"
date: 2027-06-29T00:00:00-05:00
draft: false
tags: ["Calico", "BGP", "Kubernetes", "Networking", "IPAM", "Network Policy"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Calico's BGP control plane, route reflectors, IPAM pool management, tiered NetworkPolicy, WireGuard encryption, and eBPF datapath mode for enterprise Kubernetes clusters."
more_link: "yes"
url: "/calico-bgp-production-networking-guide/"
---

Calico remains one of the most widely deployed CNI plugins in enterprise Kubernetes environments, largely due to its mature BGP control plane, flexible IPAM model, and tiered network policy engine that supports both standard Kubernetes NetworkPolicy and Calico-specific GlobalNetworkPolicy. This guide covers Calico's architecture in depth, walks through configuring BGP with route reflectors for large-scale clusters, explains IPAM block allocation and reservation strategies, demonstrates tiered policy enforcement, and explores both WireGuard-based encryption and the eBPF datapath mode as alternatives to the default iptables-based datapath.

<!--more-->

## Calico Architecture Overview

Calico implements networking and network policy through a set of cooperating components, each responsible for a distinct concern.

### Core Components

**Felix** is the per-node agent that owns the data plane. It watches the Calico datastore for policy, endpoint, and routing objects, then programs the appropriate rules into the Linux kernel. In iptables mode, Felix writes iptables rules; in eBPF mode, Felix loads BPF programs; in Windows mode, Felix programs HNS policies. Felix also manages the kernel routing table, BGP-learned routes, and IP forwarding settings.

**BIRD** (BGP Internet Routing Daemon) is the BGP speaker embedded in the Calico node DaemonSet. BIRD establishes BGP sessions with peers (other nodes, route reflectors, or physical switches) and advertises pod CIDR prefixes learned from the local kernel routing table. BIRD does not program the kernel directly; it works alongside Felix.

**confd** is a configuration management tool that watches the Calico datastore and regenerates BIRD configuration files when BGP topology changes occur (new peers, updated ASNs, etc.). confd triggers a BIRD reload after regenerating config.

**Typha** is an optional aggregation layer between the datastore and Felix. Without Typha, every Felix instance watches the Kubernetes API server directly. With Typha, Felix connects to Typha which fans out the watch stream. Typha is critical for clusters with more than ~200 nodes; without it, API server watch pressure causes significant latency.

**calico-kube-controllers** runs as a Deployment and handles garbage collection of stale Calico resources (IP allocations, endpoints) when Kubernetes objects are deleted.

**calicoctl** is the command-line tool for inspecting and managing Calico resources. It communicates directly with the Calico datastore, bypassing the Kubernetes API for some operations.

### Datastore Options

Calico supports two datastore backends:

- **Kubernetes API datastore** (recommended for most deployments): Calico stores all configuration as Kubernetes CRDs. This simplifies operations since `kubectl` and standard Kubernetes tooling manage Calico state.
- **etcd datastore**: A standalone etcd cluster separate from the Kubernetes control plane etcd. Required for legacy installations or environments where Calico manages non-Kubernetes workloads.

---

## Installation

### Helm Installation (Kubernetes Datastore)

```bash
helm repo add projectcalico https://docs.tigera.io/calico/charts
helm repo update

helm install calico projectcalico/tigera-operator \
  --version v3.28.0 \
  --namespace tigera-operator \
  --create-namespace \
  --set installation.kubernetesProvider=generic
```

### Installation Custom Resource

```yaml
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  registry: quay.io
  calicoNetwork:
    bgp: Enabled
    ipPools:
      - blockSize: 26            # /26 blocks assigned per node (64 IPs)
        cidr: 10.244.0.0/16
        encapsulation: None      # No encapsulation; requires BGP routing
        natOutgoing: Enabled
        nodeSelector: all()

  componentResources:
    - componentName: Node
      resourceRequirements:
        requests:
          cpu: 250m
          memory: 128Mi
        limits:
          cpu: "1"
          memory: 512Mi

    - componentName: Typha
      resourceRequirements:
        requests:
          cpu: 200m
          memory: 128Mi
        limits:
          cpu: "1"
          memory: 512Mi

  typhaMetricsPort: 9093

  nodeUpdateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
```

### APIServer (Needed for calicoctl CRD access)

```yaml
apiVersion: operator.tigera.io/v1
kind: APIServer
metadata:
  name: default
spec: {}
```

---

## BGP Configuration

### Full Mesh (Default)

By default, Calico establishes a full BGP mesh between all nodes. Each node peers with every other node. This works well for clusters up to approximately 100 nodes but becomes impractical beyond that due to O(n²) session count and configuration complexity.

For a 10-node cluster, Calico automatically establishes 45 BGP sessions. For 100 nodes: 4,950 sessions.

### Route Reflectors

Route reflectors eliminate the full mesh by acting as a hub. Clients (regular nodes) peer only with route reflectors, which reflect learned routes to all other clients. A standard production topology uses two route reflectors (odd number prevents split-brain; three is more common for very large clusters).

#### Designating Route Reflector Nodes

First, annotate the nodes that will serve as route reflectors:

```bash
# Designate nodes as route reflectors
kubectl annotate node rr-node-1 \
  projectcalico.org/RouteReflectorClusterID=244.0.0.1

kubectl annotate node rr-node-2 \
  projectcalico.org/RouteReflectorClusterID=244.0.0.1
```

Label them for easy selection:

```bash
kubectl label node rr-node-1 rr-node-2 route-reflector=true
```

#### Disable Full Mesh

```yaml
apiVersion: projectcalico.org/v3
kind: BGPConfiguration
metadata:
  name: default
spec:
  logSeverityScreen: Info
  nodeToNodeMeshEnabled: false    # Disable full mesh
  asNumber: 65001                 # Cluster AS number
  bindMode: NodeIP                # Bind BGP to node IP
  communities:
    - name: bgp-large-community
      value: 65001:100:200
  prefixAdvertisements:
    - cidr: 10.244.0.0/16
      communities:
        - bgp-large-community
```

#### Peer Workers to Route Reflectors

```yaml
# Peer all non-RR nodes with the RR nodes
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: worker-to-rr
spec:
  peerSelector: route-reflector == 'true'
  nodeSelector: route-reflector != 'true'
  asNumber: 65001
```

#### Route Reflector Self-Peering

```yaml
# Route reflectors peer with each other
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: rr-to-rr
spec:
  nodeSelector: route-reflector == 'true'
  peerSelector: route-reflector == 'true'
  asNumber: 65001
```

### Top-of-Rack BGP (ToR Peering)

In datacenter environments, peering each node directly with the ToR switch is preferred over using route reflectors within the cluster. This allows the physical network to carry pod routes natively.

```yaml
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: tor-switch-rack-a
spec:
  nodeSelector: "rack == 'a'"
  peerIP: 10.0.1.1
  asNumber: 65000
  password:
    secretKeyRef:
      name: bgp-passwords
      key: tor-rack-a

---
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: tor-switch-rack-b
spec:
  nodeSelector: "rack == 'b'"
  peerIP: 10.0.2.1
  asNumber: 65000
  password:
    secretKeyRef:
      name: bgp-passwords
      key: tor-rack-b
```

### Per-Node BGP Configuration

Override BGP settings on specific nodes (e.g., different AS number for a specific rack):

```yaml
apiVersion: projectcalico.org/v3
kind: BGPConfiguration
metadata:
  name: node.special-node-1
spec:
  asNumber: 65100
  logSeverityScreen: Debug
```

### Verify BGP Sessions

```bash
# Check all BGP sessions on a specific node
calicoctl node status

# Expected output:
# Calico process is running.
#
# IPv4 BGP status
# +--------------+-------------------+-------+----------+-------------+
# | PEER ADDRESS |     PEER TYPE     | STATE |  SINCE   |    INFO     |
# +--------------+-------------------+-------+----------+-------------+
# | 10.0.0.2     | node-to-node mesh | up    | 10:30:01 | Established |
# | 10.0.1.1     | global            | up    | 10:30:05 | Established |
# +--------------+-------------------+-------+----------+-------------+
```

---

## IPAM: Pools, Block Affinity, and Reservations

### IP Pool Design

Calico IPAM divides IP pools into blocks (default /26 = 64 IPs) and assigns blocks to nodes. When a node needs a new pod IP, Calico first allocates a block affinity to the node (if one is not already assigned) and then allocates an IP from that block.

```yaml
apiVersion: projectcalico.org/v3
kind: IPPool
metadata:
  name: production-pool
spec:
  cidr: 10.244.0.0/16
  blockSize: 26               # 64 IPs per block per node
  ipipMode: Never             # Disable IPIP
  vxlanMode: Never            # Disable VXLAN
  natOutgoing: true
  nodeSelector: all()
  allowedUses:
    - Workload
    - Tunnel
```

### Multiple IP Pools with Node Selectors

In a heterogeneous cluster, different pools can be assigned to different node groups:

```yaml
apiVersion: projectcalico.org/v3
kind: IPPool
metadata:
  name: gpu-pool
spec:
  cidr: 10.245.0.0/24
  blockSize: 28               # /28 = 16 IPs (GPU nodes run fewer pods)
  ipipMode: Never
  natOutgoing: true
  nodeSelector: "nvidia.com/gpu.present == 'true'"
  allowedUses:
    - Workload
```

### IPReservation

IPReservation prevents specific IPs from being allocated by Calico IPAM. This is essential when IPs are pre-assigned to physical devices, virtual IPs, or monitoring agents that use the pod CIDR range:

```yaml
apiVersion: projectcalico.org/v3
kind: IPReservation
metadata:
  name: infrastructure-ips
spec:
  reservedCIDRs:
    - "10.244.0.1/32"       # Cluster gateway
    - "10.244.0.10/32"      # Legacy monitoring agent
    - "10.244.1.0/28"       # Reserved for future use
```

### Viewing IPAM State

```bash
# Show IP utilization per block
calicoctl ipam show --show-blocks

# Check for leaked allocations
calicoctl ipam check

# View block affinity for a specific node
calicoctl get blockaffinity \
  --selector 'node == "worker-1"' -o yaml

# Release a leaked IP
calicoctl ipam release --ip=10.244.5.23
```

### Tuning Block Allocation

For clusters where nodes host many pods (e.g., 100+ pods per node), increase block size to reduce block exhaustion and fragmentation:

```yaml
spec:
  blockSize: 24    # /24 = 256 IPs per block
```

For clusters where nodes host few pods (e.g., spot instances that scale in/out frequently), smaller blocks reduce wasted IP space:

```yaml
spec:
  blockSize: 28    # /28 = 16 IPs per block
```

---

## Network Policy: Tiered GlobalNetworkPolicy

Calico extends the standard Kubernetes NetworkPolicy with additional constructs: GlobalNetworkPolicy (applies cluster-wide, not namespace-scoped), policy tiers (ordered evaluation with pass/allow/deny), and more granular rule capabilities (ICMP types, HTTP method matching, service account selectors).

### Policy Tiers

Tiers enforce a hierarchy. Policies in higher-precedence tiers are evaluated first. If a policy in tier A results in `Pass`, evaluation continues to the next tier. If a policy results in `Allow` or `Deny`, evaluation stops.

```yaml
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: security
spec:
  order: 100       # Lower order = higher precedence

---
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: platform
spec:
  order: 200

---
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: application
spec:
  order: 300
```

### GlobalNetworkPolicy in the Security Tier

The security tier holds baseline cluster-wide policies that no application policy can override:

```yaml
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: security.allow-dns-egress
spec:
  tier: security
  order: 10
  selector: all()
  types:
    - Egress

  egress:
    # Allow DNS from all pods
    - action: Allow
      protocol: UDP
      destination:
        ports:
          - 53
    - action: Allow
      protocol: TCP
      destination:
        ports:
          - 53
    # Pass remaining egress to lower tiers
    - action: Pass

---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: security.deny-internet-egress
spec:
  tier: security
  order: 100
  selector: "internet-access != 'true'"
  types:
    - Egress

  egress:
    - action: Deny
      destination:
        notNets:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
```

### Platform Tier: Infrastructure Services

```yaml
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: platform.allow-monitoring
spec:
  tier: platform
  order: 10
  selector: all()
  types:
    - Ingress

  ingress:
    # Allow Prometheus scraping from monitoring namespace
    - action: Allow
      protocol: TCP
      source:
        namespaceSelector: "kubernetes.io/metadata.name == 'monitoring'"
      destination:
        ports:
          - 9090
          - 9091
          - 9092
          - 9100
          - 8080

    - action: Pass
```

### Application Tier: Namespace-Scoped Policy

```yaml
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: application.frontend-policy
  namespace: production
spec:
  tier: application
  order: 10
  selector: app == 'frontend'
  types:
    - Ingress
    - Egress

  ingress:
    - action: Allow
      protocol: TCP
      source:
        selector: app == 'api-gateway'
      destination:
        ports:
          - 8080

  egress:
    - action: Allow
      protocol: TCP
      destination:
        selector: app == 'backend'
        namespaceSelector: "kubernetes.io/metadata.name == 'production'"
        ports:
          - 3000
    - action: Deny
```

### Default Deny GlobalNetworkPolicy

A default-deny policy at the bottom of each tier (high order number) ensures no unlabeled traffic passes:

```yaml
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: application.default-deny
spec:
  tier: application
  order: 9999
  selector: all()
  types:
    - Ingress
    - Egress
  ingress:
    - action: Deny
  egress:
    - action: Deny
```

### Service Account-Based Policy

```yaml
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: application.sa-based-access
  namespace: production
spec:
  tier: application
  order: 50
  selector: app == 'database'
  types:
    - Ingress

  ingress:
    - action: Allow
      protocol: TCP
      source:
        serviceAccounts:
          names:
            - "backend-service-account"
            - "migration-service-account"
      destination:
        ports:
          - 5432
```

### HTTP-Aware Policy

```yaml
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: application.http-method-policy
  namespace: production
spec:
  tier: application
  order: 20
  selector: app == 'api-server'
  types:
    - Ingress

  ingress:
    - action: Allow
      protocol: TCP
      http:
        methods:
          - GET
          - HEAD
      source:
        selector: role == 'read-only-client'
      destination:
        ports:
          - 8080

    - action: Allow
      protocol: TCP
      http:
        methods:
          - GET
          - POST
          - PUT
          - DELETE
      source:
        selector: role == 'admin-client'
      destination:
        ports:
          - 8080
```

---

## WireGuard Encryption

Calico supports WireGuard for pod-to-pod traffic encryption. Unlike IPsec (also supported), WireGuard is simpler to operate and provides higher performance at equivalent security levels.

### Enabling WireGuard

```yaml
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    windowsDataplane: Disabled
    linuxDataplane: VPP             # or 'Iptables' or 'BPF'
    wireguard:
      enabled: true
```

Or via FelixConfiguration:

```yaml
apiVersion: projectcalico.org/v3
kind: FelixConfiguration
metadata:
  name: default
spec:
  wireguardEnabled: true
  wireguardEnabledV6: false        # IPv6 WireGuard (requires kernel 5.6+)
  wireguardMTU: 1420               # WireGuard adds 60-byte overhead; set MTU = NIC_MTU - 60
  wireguardHostEncryptionEnabled: true   # Encrypt host-to-pod traffic as well
```

### Verify WireGuard Status

```bash
# Check WireGuard is active on a node
calicoctl get node worker-1 -o yaml | grep -i wireguard

# Verify WireGuard interface
kubectl -n calico-system exec ds/calico-node -- wg show

# Check WireGuard stats
kubectl -n calico-system exec ds/calico-node -- \
  wg show wg0 transfer
```

---

## eBPF Datapath Mode

Calico's eBPF mode replaces Felix's iptables programming with BPF programs, providing performance characteristics similar to Cilium's native eBPF mode. Key benefits include faster service load balancing (socket-level), reduced CPU overhead, and support for DSR (Direct Server Return) for NodePort services.

### Prerequisites for eBPF Mode

- Linux kernel 5.3+ (5.7+ recommended for full feature set).
- kube-proxy must be disabled (Calico replaces it entirely).
- No other iptables-based tools managing the same rules.

### Disabling kube-proxy

```bash
kubectl -n kube-system patch daemonset kube-proxy \
  -p '{"spec":{"template":{"spec":{"nodeSelector":{"non-existent":"true"}}}}}'
```

### Enabling eBPF Mode

```yaml
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    linuxDataplane: BPF
    hostPorts: Disabled          # Host ports not supported in BPF mode

---
apiVersion: projectcalico.org/v3
kind: FelixConfiguration
metadata:
  name: default
spec:
  bpfEnabled: true
  bpfLogLevel: ""               # Set to 'debug' for troubleshooting
  bpfKubeProxyIptablesCleanupEnabled: true   # Remove residual kube-proxy rules
  bpfExternalServiceMode: DSR   # 'DSR' or 'Tunnel'; DSR avoids double-hop
  bpfConntrackTimeouts:         # Tune connection tracking expiry
    tcpPreEstablished: 20s
    tcpEstablished: 3600s
    tcpFinWait: 40s
    udpTimeout: 60s
```

### Verifying eBPF Mode

```bash
# Verify BPF is active
calicoctl get felixconfig default -o yaml | grep bpfEnabled

# Check BPF program attachment on a node
kubectl -n calico-system exec ds/calico-node -- \
  calico-node -bpf-log-filter "" -bpf-list-programs

# Check BPF maps
kubectl -n calico-system exec ds/calico-node -- \
  calico-node -bpf-conntrack-dump
```

---

## Troubleshooting with calicoctl

### Checking Felix Health

```bash
# Run on the node directly or via kubectl exec
calicoctl node status

# Check Felix logs
kubectl -n calico-system logs ds/calico-node -c calico-node \
  --since=15m | grep -E "(ERROR|WARN|felix)"

# Trigger Felix diagnostic snapshot
kubectl -n calico-system exec ds/calico-node -- \
  calico-node -show-status
```

### Inspecting Policy Hit Counts

```bash
# Show policy enforcement statistics for a workload
calicoctl get workloadendpoint \
  -n production \
  --selector 'app == "frontend"' \
  -o wide

# Check policy counters (requires Calico Enterprise or eBPF mode)
calicoctl get stats
```

### Diagnosing IPAM Issues

```bash
# Show IPAM utilization
calicoctl ipam show

# Show details including per-block allocations
calicoctl ipam show --show-blocks

# Show IPs allocated but not associated with any pod
calicoctl ipam check --show-problem-ips

# Sample output:
# IPAMBlock 10.244.5.0/26
# Used: 14/64
# Free: 50/64
# Leaked IPs: 1 (10.244.5.23)
```

### Verifying Route Distribution

```bash
# Check routes installed by Felix
ip route show | grep bird

# Check BGP advertisements from a specific node
kubectl -n calico-system exec ds/calico-node -- \
  birdcl show route

# Check BGP session detail
kubectl -n calico-system exec ds/calico-node -- \
  birdcl show protocols all
```

### Policy Trace

Calico includes a policy trace capability that simulates the policy decision for a hypothetical packet:

```bash
calicoctl policy-status

# Trace a specific packet (Calico Enterprise feature)
calicoctl trace \
  --src-namespace production \
  --src-selector 'app == "frontend"' \
  --dst-namespace production \
  --dst-selector 'app == "backend"' \
  --dst-port 3000 \
  --proto tcp
```

---

## Typha Configuration for Large Clusters

Beyond ~200 nodes, Typha becomes essential. Without it, API server watch channels become saturated.

```yaml
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  typhaMetricsPort: 9093
  componentResources:
    - componentName: Typha
      resourceRequirements:
        requests:
          cpu: 500m
          memory: 256Mi
        limits:
          cpu: "2"
          memory: 1Gi
```

Typha scales horizontally. The recommended ratio is 1 Typha replica per 100-200 Felix instances (nodes):

```yaml
# Typha auto-scales based on node count via the operator
# Or set replicas explicitly:
apiVersion: operator.tigera.io/v1
kind: TigeraStatus
```

The Typha Prometheus metrics (on port 9093) expose `typha_connections_accepted`, `typha_connections_dropped`, and cache hit rates that indicate whether Typha capacity is sufficient.

---

## Production Checklist

### BGP
- Disable node-to-node mesh for clusters larger than 100 nodes.
- Deploy at least 2 route reflectors on dedicated nodes (tainted to prevent workloads).
- Use per-node ASN assignments when peering with physical ToR switches.
- Enable BGP MD5 authentication for all external peers.
- Monitor BGP session state with alerting on session drops.

### IPAM
- Set blockSize based on expected maximum pod density per node.
- Reserve IPs used by infrastructure components using IPReservation.
- Run `calicoctl ipam check` weekly to detect and clean leaked allocations.
- Size IP pools with 50% headroom beyond projected cluster growth.

### Network Policy
- Implement policy tiers (security > platform > application).
- Deploy default-deny policies at the application tier.
- Test policy changes in staging with `calicoctl policy-status` validation.
- Audit policy coverage quarterly.

### Performance
- Enable WireGuard for clusters that require in-transit encryption.
- Consider eBPF mode for clusters requiring improved service load balancing performance.
- Tune FelixConfiguration `bpfConntrackTimeouts` for workloads with short-lived connections.
- Set `prometheusMetricsEnabled: true` on FelixConfiguration and monitor Felix metrics.

### Upgrade Procedure

```bash
# Rolling upgrade via tigera-operator
kubectl set image -n tigera-operator \
  deployment/tigera-operator \
  tigera-operator=quay.io/tigera/operator:v1.35.0

# Monitor operator status
kubectl -n tigera-operator rollout status deploy/tigera-operator

# Monitor calico-node rollout
kubectl -n calico-system rollout status ds/calico-node

# Verify post-upgrade
calicoctl version
calicoctl node status
```

---

## Calico Enterprise Additional Features

Calico Enterprise extends the open-source feature set with:

**Egress Access Controls**: Named egress policies with per-namespace egress gateway assignments, similar to Cilium's Egress Gateway but with deeper integration into the Calico tier model.

**Compliance Reporting**: Automated generation of CIS benchmark, SOC2, and PCI-DSS compliance reports based on current NetworkPolicy coverage. Reports identify endpoints with no ingress policy, no egress policy, or overly permissive rules.

**Flow Log Aggregation**: Fine-grained per-policy-rule flow logs exported to Elasticsearch or S3, with a Kibana-based UI for flow analysis.

**Multi-Cluster Federation**: Federated endpoint identity and policy across multiple clusters, using a federated service account model for cross-cluster authorization.

**Threat Defense**: Integration with Calico's threat intelligence feeds to automatically deny traffic to/from known malicious IPs and domains.

The Enterprise tier is licensed per-node and typically deployed in regulated industries (financial services, healthcare) where compliance reporting and audit trail capabilities justify the cost.

---

## Summary

Calico's BGP-native approach makes it a natural fit for datacenter deployments where pod routes need to be visible to the physical network without encapsulation overhead. The route reflector topology scales cleanly to thousands of nodes. IPAM block affinity provides deterministic IP assignment with efficient block utilization. The tiered policy model allows security teams to enforce baseline controls without conflicting with application-level policies. WireGuard provides encryption with minimal operational complexity. The eBPF datapath, while newer, delivers competitive performance improvements for clusters with high service traffic. With proper BGP design, IPAM sizing, and tiered policy structure, Calico provides a robust and operationally transparent networking layer for production Kubernetes environments.
