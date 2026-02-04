---
title: "Cilium BGP Control Plane for Kubernetes: Complete Enterprise Implementation Guide"
date: 2026-02-10T09:00:00-05:00
draft: false
tags: ["Cilium", "BGP", "Kubernetes", "Networking", "Load Balancer", "LB-IPAM", "eBPF", "Bare Metal", "MetalLB", "GoBGP", "Traffic Engineering"]
categories: ["Kubernetes", "Networking", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Cilium BGP Control Plane for Kubernetes, covering v1 and v2 APIs, LB-IPAM integration, MetalLB migration, BGP communities, graceful restart, and production troubleshooting."
more_link: "yes"
url: "/cilium-bgp-control-plane-kubernetes-enterprise-guide/"
---

Bare-metal and on-premises Kubernetes clusters face a fundamental networking challenge that cloud providers solve transparently: making Services and Pods reachable from outside the cluster. In cloud environments, a LoadBalancer Service automatically provisions an external IP and programs the cloud provider's network fabric. On bare metal, that integration does not exist. **Border Gateway Protocol (BGP)** fills this gap by enabling Kubernetes nodes to advertise routes for Pod CIDRs, LoadBalancer IPs, and custom prefixes directly to the upstream network infrastructure.

Cilium's **BGP Control Plane** integrates this capability directly into the CNI layer. Built on the **GoBGP** routing library, the BGP Control Plane runs a BGP speaker on each selected node, advertising routes to configured peers without requiring an external component like MetalLB. Combined with Cilium's **LB-IPAM** (LoadBalancer IP Address Management), this provides a complete, single-stack solution for bare-metal service exposure — from IP allocation through route advertisement to eBPF-accelerated packet forwarding.

<!--more-->

## Cilium BGP Architecture

The BGP Control Plane operates as an extension of the Cilium agent rather than a standalone daemon. Each Cilium agent that matches a BGP configuration runs an embedded **GoBGP** routing instance, establishing BGP sessions with configured peers and injecting routes based on the cluster state. This architecture provides tight integration with Cilium's identity-aware networking and eBPF datapath while avoiding the operational complexity of managing a separate routing daemon.

The separation between the **control plane** and the **data plane** is an important distinction. The BGP Control Plane handles only route advertisement — it tells external routers how to reach Pod CIDRs, Service VIPs, and custom prefixes. The actual packet forwarding is handled by Cilium's eBPF programs in the kernel. BGP does not program the datapath, and it should not be used to establish reachability within the cluster itself.

### Enabling BGP Control Plane

The BGP Control Plane is enabled through a Helm value and requires Cilium to be running with an appropriate IPAM mode. The following Helm values provide a production-ready baseline:

```yaml
# cilium-bgp-values.yaml
bgpControlPlane:
  enabled: true

ipam:
  mode: "kubernetes"

kubeProxyReplacement: "true"

bpf:
  masquerade: true

operator:
  rollOutPods: true
```

Apply these values during installation or upgrade:

```bash
# Upgrade an existing Cilium installation with BGP support
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --values cilium-bgp-values.yaml
```

### Prerequisites and Supported Environments

Several requirements must be met before configuring BGP:

- **Cilium version**: BGP Control Plane v2 resources require Cilium 1.15 or later. Community attributes require Cilium 1.15+. Overlapping advertisement support requires Cilium 1.18+.
- **IPAM mode**: Kubernetes IPAM or ClusterPool IPAM are supported. Multi-pool IPAM (CiliumPodIPPool) is also supported for advertising custom Pod IP ranges.
- **Kernel version**: Linux 4.19+ for basic eBPF support, 5.10+ recommended for full feature set.
- **Network topology**: Direct layer 3 adjacency to BGP peers (eBGP single-hop) is the simplest configuration. eBGP multi-hop and iBGP are also supported.
- **kube-proxy replacement**: While not strictly required for BGP, enabling `kubeProxyReplacement` is strongly recommended when using Cilium as the sole networking and load balancing stack.

## BGP Control Plane v2 API (Recommended)

The v2 API introduces a modular, composable resource model that replaces the monolithic `CiliumBGPPeeringPolicy`. Four custom resources work together to define the complete BGP configuration:

| Resource | Purpose |
|----------|---------|
| **CiliumBGPClusterConfig** | Selects nodes, defines BGP instances and peer endpoints |
| **CiliumBGPPeerConfig** | Shared peer settings (timers, graceful restart, address families) |
| **CiliumBGPAdvertisement** | Defines what prefixes to advertise and with which attributes |
| **CiliumBGPNodeConfigOverride** | Per-node overrides for router ID, local address, and ASN |

This separation allows reusing peer configurations across multiple clusters and environments, and advertising different route types with independent policies.

### CiliumBGPClusterConfig

The **CiliumBGPClusterConfig** is the entry point for BGP configuration. It uses a `nodeSelector` to determine which nodes run BGP, defines one or more BGP instances (each with a local ASN), and references peers with their connection details.

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPClusterConfig
metadata:
  name: datacenter-bgp
spec:
  nodeSelector:
    matchLabels:
      bgp-policy: rack01
  bgpInstances:
  - name: "rack01-instance"
    localASN: 65001
    peers:
    - name: "tor-switch-1"
      peerASN: 65100
      peerAddress: "10.0.0.1"
      peerConfigRef:
        name: "datacenter-peer-config"
    - name: "tor-switch-2"
      peerASN: 65100
      peerAddress: "10.0.0.2"
      peerConfigRef:
        name: "datacenter-peer-config"
```

Key points about `CiliumBGPClusterConfig`:

- Only **one** CiliumBGPClusterConfig can select a given node. If multiple configs match the same node via their `nodeSelector`, a `ConflictingClusterConfigs` status condition is set and all BGP sessions on that node are torn down.
- The `peerConfigRef` field references a `CiliumBGPPeerConfig` resource by name. Multiple peers can share the same config.
- Multiple BGP instances can be defined on a single node, each with a different `localASN`, for scenarios like dual-stack or multi-VRF configurations.

### CiliumBGPPeerConfig

The **CiliumBGPPeerConfig** defines the operational parameters for BGP sessions. It is referenced by peers in the CiliumBGPClusterConfig and can be shared across many peers and clusters.

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeerConfig
metadata:
  name: datacenter-peer-config
spec:
  timers:
    holdTimeSeconds: 90       # How long to wait before declaring peer down
    keepAliveTimeSeconds: 30   # Interval between keepalive messages
    connectRetryTimeSeconds: 120  # Retry interval for failed connections
  transport:
    localPort: 179    # Local BGP port (default: 179)
    peerPort: 179     # Remote BGP port (default: 179)
  gracefulRestart:
    enabled: true             # Prevent route withdrawal during agent restarts
    restartTimeSeconds: 120   # Time window for session re-establishment
  families:
  - afi: ipv4
    safi: unicast
    advertisements:
      matchLabels:
        advertise: "bgp"      # Select CiliumBGPAdvertisement resources by label
  - afi: ipv6
    safi: unicast
    advertisements:
      matchLabels:
        advertise: "bgp"
```

The `families` field defines which address families are negotiated with the peer. The `advertisements.matchLabels` selector determines which `CiliumBGPAdvertisement` resources are used for that family. This is the link between peering configuration and route advertisement policy.

### CiliumBGPAdvertisement

The **CiliumBGPAdvertisement** defines the prefixes injected into the BGP routing table. It supports three advertisement types: **PodCIDR**, **Service**, and **CiliumPodIPPool**.

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPAdvertisement
metadata:
  name: bgp-advertisements
  labels:
    advertise: bgp   # Must match the selector in CiliumBGPPeerConfig.families
spec:
  advertisements:
  - advertisementType: "PodCIDR"   # Advertise each node's Pod CIDR
  - advertisementType: "Service"    # Advertise Service IPs
    service:
      addresses:
      - LoadBalancerIP   # IPs from LB-IPAM or cloud provider
      - ExternalIP       # Manually assigned external IPs
      - ClusterIP        # Internal ClusterIPs (use with caution)
    selector:
      matchExpressions:
      - key: bgp-announce
        operator: In
        values:
        - "true"   # Only advertise services with this label
```

The `selector` field on Service advertisements controls which Services are advertised. Without a selector, all Services of the matching type are advertised. The `service.addresses` field controls which IP types are included — typically `LoadBalancerIP` for bare-metal deployments using LB-IPAM.

### Node-Specific Overrides

In heterogeneous environments where nodes have different network configurations, the **CiliumBGPNodeConfigOverride** provides per-node control over router ID, local port, and peer-specific settings.

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPNodeConfigOverride
metadata:
  name: node-worker-03
spec:
  bgpInstances:
  - name: "rack01-instance"      # Must match the instance name in CiliumBGPClusterConfig
    routerID: "10.0.1.33"        # Override auto-detected router ID
    localPort: 1179              # Use non-standard port (e.g., if 179 is taken)
    peers:
    - name: "tor-switch-1"       # Must match the peer name
      localAddress: "10.0.1.33"  # Source address for this peering session
```

The override resource is matched to nodes by name (the `metadata.name` must match the Kubernetes node name). This is useful when nodes have multiple interfaces and the BGP session must use a specific source address, or when a non-standard BGP port is required.

### Multi-Peer and Multi-Instance Topologies

Modern datacenter networks often use **leaf-spine** topologies where each compute node peers with two or more top-of-rack (ToR) switches. The v2 API handles this naturally by defining multiple peers within a single BGP instance.

For more complex scenarios — such as peering with both eBGP neighbors (ToR switches) and an iBGP route reflector — multiple peers with different configurations can reference different `CiliumBGPPeerConfig` resources:

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPClusterConfig
metadata:
  name: leaf-spine-bgp
spec:
  nodeSelector:
    matchLabels:
      topology: leaf-spine
  bgpInstances:
  - name: "fabric-instance"
    localASN: 65010
    peers:
    - name: "spine-1"
      peerASN: 65000              # eBGP peer — different ASN
      peerAddress: "10.255.0.1"
      peerConfigRef:
        name: "spine-peer-config"
    - name: "spine-2"
      peerASN: 65000
      peerAddress: "10.255.0.2"
      peerConfigRef:
        name: "spine-peer-config"
    - name: "route-reflector"
      peerASN: 65010              # iBGP peer — same ASN
      peerAddress: "10.255.1.1"
      peerConfigRef:
        name: "ibgp-peer-config"  # Different config for iBGP (e.g., different timers)
```

This configuration establishes three BGP sessions per node: two eBGP sessions to spine switches for external reachability and one iBGP session to a route reflector for internal route distribution.

## Legacy API — CiliumBGPPeeringPolicy (v1)

The **CiliumBGPPeeringPolicy** was the original BGP configuration mechanism, introduced in Cilium 1.12. It remains functional but is marked for deprecation in a future release. All new deployments should use the v2 API. However, many production clusters still run the legacy API, and understanding it is necessary for migration planning.

The key differences from the v2 API:

- **Monolithic resource**: A single CiliumBGPPeeringPolicy contains node selection, peer configuration, route advertisement, and path attributes — all in one resource.
- **Single policy per node**: Only one CiliumBGPPeeringPolicy can match a node. If multiple policies match, all BGP sessions are cleared until the conflict is resolved.
- **No coexistence with v2**: CiliumBGPPeeringPolicy and CiliumBGPClusterConfig must not be used together. If both match a node, the legacy policy takes precedence, but this is unsupported and will cause unpredictable behavior.

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: rack01-peering
spec:
  nodeSelector:
    matchLabels:
      bgp-policy: rack01
  virtualRouters:
  - localASN: 65001
    exportPodCIDR: true     # Advertise this node's Pod CIDR to peers
    neighbors:
    - peerAddress: "10.0.0.1/32"   # Note: requires /32 suffix
      peerASN: 65100
      gracefulRestart:
        enabled: true
        restartTimeSeconds: 120
    - peerAddress: "10.0.0.2/32"
      peerASN: 65100
      gracefulRestart:
        enabled: true
        restartTimeSeconds: 120
    serviceSelector:
      matchExpressions:
      - key: bgp-announce
        operator: In
        values:
        - "true"     # Only advertise services with this label
```

Note the format difference: peer addresses in the legacy API require a CIDR suffix (`/32`), while the v2 API uses plain IP addresses.

### Migrating from v1 to v2

The migration from CiliumBGPPeeringPolicy to the v2 resources should follow a careful sequence to avoid session disruption:

1. **Create the v2 resources first** — Deploy `CiliumBGPPeerConfig`, `CiliumBGPAdvertisement`, and `CiliumBGPClusterConfig` resources, but configure the `CiliumBGPClusterConfig` with a `nodeSelector` that does **not** match any nodes yet.
2. **Validate the v2 configuration** — Review the resources for correctness. Confirm that the peer addresses, ASNs, and advertisement types match the existing legacy policy.
3. **Migrate one node at a time** — Remove the legacy policy label from a single node, then add the v2 label. Verify that BGP sessions re-establish with `cilium bgp peers`.
4. **Monitor route advertisement** — Use `cilium bgp routes advertised ipv4 unicast` to confirm that the same prefixes are being advertised under the v2 configuration.
5. **Complete the rollout** — Once validated on a canary node, migrate remaining nodes in batches.
6. **Delete the legacy policy** — After all nodes are running v2, remove the CiliumBGPPeeringPolicy resource.

The critical risk during migration is the brief BGP session reset when a node transitions between policies. With graceful restart enabled on the peer side, this should not cause traffic disruption, as the peer will retain routes during the restart window.

## LB-IPAM Integration — Replacing MetalLB

Cilium's **LB-IPAM** (LoadBalancer IP Address Management) provides automatic IP allocation for Services of type `LoadBalancer`, directly replacing MetalLB's core functionality. When combined with the BGP Control Plane, LB-IPAM handles IP assignment while BGP handles route advertisement — creating a complete MetalLB alternative within the Cilium stack.

LB-IPAM is enabled by default when Cilium is installed. The only requirement is defining one or more **CiliumLoadBalancerIPPool** resources to specify the available address ranges.

### Defining IP Pools

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: production-pool
spec:
  blocks:
  - cidr: "10.100.0.0/24"   # 254 usable IPs for production services
  - cidr: "10.100.1.0/24"   # Additional range for overflow
  serviceSelector:
    matchLabels:
      environment: production   # Only allocate to services with this label
```

Multiple pools can coexist, each with different CIDR ranges and service selectors:

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: staging-pool
spec:
  blocks:
  - cidr: "10.100.2.0/24"
  serviceSelector:
    matchLabels:
      environment: staging
```

When a LoadBalancer Service is created, LB-IPAM selects a pool whose `serviceSelector` matches the Service labels and allocates an IP from the pool's CIDR blocks. If no selector is defined on a pool, it matches all Services.

### Advertising LoadBalancer IPs via BGP

LB-IPAM allocates the IP, but BGP must advertise it to the upstream network. This is done with a `CiliumBGPAdvertisement` resource that includes `Service` advertisement type with `LoadBalancerIP` addresses:

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPAdvertisement
metadata:
  name: lb-service-advertisement
  labels:
    advertise: bgp
spec:
  advertisements:
  - advertisementType: "Service"
    service:
      addresses:
      - LoadBalancerIP       # Advertise IPs assigned by LB-IPAM
    selector:
      matchLabels:
        bgp-announce: "true"   # Only advertise labeled services
    attributes:
      communities:
        standard:
        - "65001:100"   # Tag with community for upstream routing policy
```

Verify that IPs are being allocated and advertised:

```bash
# Check which services have received LoadBalancer IPs
kubectl get svc -A -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.namespace}{"/"}{.metadata.name}{"\t"}{.status.loadBalancer.ingress[0].ip}{"\n"}{end}'
```

```bash
# Verify the IPs are in the BGP routing table
cilium bgp routes advertised ipv4 unicast
```

### Shared IPs and IP Pool Selectors

By default, each LoadBalancer Service receives a unique IP. However, multiple Services can share a single external IP when they use different ports. This is controlled with the `io.cilium/lb-ipam-sharing-key` annotation:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-http
  annotations:
    io.cilium/lb-ipam-ips: "10.100.0.50"
    io.cilium/lb-ipam-sharing-key: "web-frontend"
spec:
  type: LoadBalancer
  ports:
  - port: 80
    protocol: TCP
---
apiVersion: v1
kind: Service
metadata:
  name: web-https
  annotations:
    io.cilium/lb-ipam-ips: "10.100.0.50"
    io.cilium/lb-ipam-sharing-key: "web-frontend"
spec:
  type: LoadBalancer
  ports:
  - port: 443
    protocol: TCP
```

Both Services share the IP `10.100.0.50`, with traffic routed by port. The `io.cilium/lb-ipam-ips` annotation requests a specific IP, while the sharing key groups Services that should share it.

## Migrating from MetalLB to Cilium BGP

Migrating from MetalLB to Cilium BGP is a common operational task as teams consolidate their networking stack. The migration involves replacing three MetalLB components: **IP address pools**, **BGP peering configuration**, and **service annotations**. A phased approach with side-by-side operation minimizes risk.

### Resource Mapping

The following table maps MetalLB resources to their Cilium equivalents:

| MetalLB Resource | Cilium Equivalent |
|-----------------|-------------------|
| `IPAddressPool` | `CiliumLoadBalancerIPPool` |
| `BGPPeer` | `CiliumBGPClusterConfig` + `CiliumBGPPeerConfig` |
| `BGPAdvertisement` | `CiliumBGPAdvertisement` |
| `L2Advertisement` | `CiliumL2AnnouncementPolicy` |

**MetalLB IP pool:**

```yaml
# MetalLB IPAddressPool
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: production-pool
  namespace: metallb-system
spec:
  addresses:
  - 10.100.0.0/24
  - 10.100.1.0/24
```

**Equivalent Cilium IP pool:**

```yaml
# Cilium CiliumLoadBalancerIPPool
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: production-pool
spec:
  blocks:
  - cidr: "10.100.0.0/24"
  - cidr: "10.100.1.0/24"
  serviceSelector:
    matchLabels:
      environment: production
```

**MetalLB BGP peer:**

```yaml
# MetalLB BGPPeer
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: tor-switch-1
  namespace: metallb-system
spec:
  myASN: 65001
  peerASN: 65100
  peerAddress: 10.0.0.1
  holdTime: "90s"
  keepaliveTime: "30s"
```

**Equivalent Cilium BGP configuration** requires two resources — the cluster config and the peer config — as shown in the v2 API section above.

### Annotation Migration

MetalLB and Cilium use different annotations for IP assignment and sharing:

| MetalLB Annotation | Cilium Annotation |
|-------------------|-------------------|
| `metallb.universe.tf/loadBalancerIPs` | `io.cilium/lb-ipam-ips` |
| `metallb.universe.tf/allow-shared-ip` | `io.cilium/lb-ipam-sharing-key` |

Migrate annotations on existing Services:

```bash
# Remove MetalLB annotation and add Cilium annotation in a single command
kubectl annotate svc my-service metallb.universe.tf/loadBalancerIPs- io.cilium/lb-ipam-ips=10.100.0.50
```

### Side-by-Side Operation

The safest migration strategy runs MetalLB and Cilium LB-IPAM simultaneously during the transition. To prevent IP conflicts, partition the address space:

1. **Split the IP pool** — Assign a portion of the CIDR range to MetalLB and the remainder to Cilium. For example, if the current MetalLB pool is `10.100.0.0/24`, reduce it to `10.100.0.0/25` and create a Cilium pool for `10.100.0.128/25`.
2. **Migrate services incrementally** — For each service, update the annotation from MetalLB to Cilium format and assign an IP from the Cilium pool range. The service will be re-allocated by Cilium LB-IPAM.
3. **Validate BGP advertisement** — After each service migration, confirm the new IP appears in `cilium bgp routes advertised ipv4 unicast` and that the upstream router has the route.

```bash
# Verify Cilium IP pool allocation status
kubectl get ciliumloadbalancerippool -o wide
```

### Cutover and Rollback

Once all services have been migrated to Cilium LB-IPAM:

1. **Remove MetalLB BGP peers** — Delete the MetalLB `BGPPeer` resources. The upstream router will withdraw MetalLB-originated routes.
2. **Expand Cilium IP pool** — Update the `CiliumLoadBalancerIPPool` to cover the full CIDR range.
3. **Uninstall MetalLB** — Remove the MetalLB deployment, CRDs, and namespace.

**Rollback plan**: If Cilium BGP sessions fail to establish during migration, the MetalLB installation is still running and serving the original IP range. Revert the service annotations to MetalLB format and restore the original MetalLB IP pool range. Because the IP ranges are partitioned, there is no conflict.

The critical validation before removing MetalLB is confirming that every LoadBalancer Service has an IP assigned by Cilium LB-IPAM and that the IP is present in the BGP routing table as advertised by Cilium:

```bash
# Confirm all LB services have IPs and BGP is advertising them
cilium bgp routes advertised ipv4 unicast
```

## Traffic Engineering with BGP Communities

**BGP communities** are routing metadata tags that enable upstream routers to apply policy to advertised routes. Cilium supports three community formats and LocalPreference for iBGP traffic engineering.

| Community Type | Format | RFC | Example |
|---------------|--------|-----|---------|
| Standard | `ASN:value` (32-bit) | RFC 1997 | `65001:100` |
| Well-Known | Named string | RFC 1997 | `no-export`, `no-advertise` |
| Large | `ASN:value1:value2` (96-bit) | RFC 8092 | `65001:200:300` |

Common use cases for communities in a Kubernetes context:

- **`no-export`** — Prevent Pod CIDR routes from being advertised beyond the local AS. Useful when Pod CIDRs should only be reachable within the datacenter, not across WAN links.
- **ISP traffic steering** — Tag Service VIPs with communities that signal upstream ISP routers to prefer certain paths (e.g., `65001:200` for premium transit).
- **Blackhole** — Tag routes for DDoS mitigation, signaling upstream providers to drop traffic destined for specific prefixes.

### v2 API Community Configuration

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPAdvertisement
metadata:
  name: traffic-engineering
  labels:
    advertise: bgp
spec:
  advertisements:
  - advertisementType: "PodCIDR"
    attributes:
      communities:
        standard:
        - "65001:100"          # Tag Pod CIDRs with datacenter community
        wellKnown:
        - "no-export"          # Prevent Pod CIDRs from leaving the AS
        large:
        - "65001:200:300"      # Large community for granular policy
      localPreference: 150     # iBGP preference (ignored for eBGP peers)
  - advertisementType: "Service"
    service:
      addresses:
      - LoadBalancerIP
    selector:
      matchLabels:
        traffic-class: premium
    attributes:
      communities:
        standard:
        - "65001:200"          # Premium services get higher-priority community
      localPreference: 200     # Higher preference for premium traffic
```

### Legacy API Community Configuration

The legacy CiliumBGPPeeringPolicy uses `pathAttributes` with selector types to attach communities:

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: traffic-engineering-legacy
spec:
  nodeSelector:
    matchLabels:
      bgp-policy: rack01
  virtualRouters:
  - localASN: 65001
    exportPodCIDR: true
    neighbors:
    - peerAddress: "10.0.0.1/32"
      peerASN: 65100
    pathAttributes:
    - selectorType: PodCIDR          # Apply to Pod CIDR routes
      communities:
        standard:
        - "65001:100"
        wellKnown:
        - "no-export"
    - selectorType: CiliumLoadBalancerIPPool   # Apply to LB pool routes
      selector:
        matchLabels:
          pool: premium
      communities:
        standard:
        - "65001:200"
      localPreference: 200
```

The legacy API supports three `selectorType` values: `PodCIDR`, `CiliumLoadBalancerIPPool`, and `CiliumPodIPPool`. Each applies path attributes to the routes matching that selector.

### Overlapping Advertisements (Cilium 1.18+)

When multiple `CiliumBGPAdvertisement` resources match the same Service, Cilium takes the **union** of all community values. Prior to Cilium 1.18, the last matching advertisement would overwrite earlier ones. With 1.18+, overlapping selectors are explicitly supported and communities are merged.

This enables layered policies: a base advertisement can apply default communities to all services, while a second advertisement adds additional communities to a subset of premium services.

## Graceful Restart and High Availability

In production environments, Cilium agent restarts — whether for upgrades, configuration changes, or crash recovery — must not cause route withdrawal and traffic disruption. **BGP graceful restart** addresses this by allowing the peer router to retain routes from the restarting speaker for a configurable time window.

When graceful restart is enabled, the Cilium BGP speaker advertises the "graceful restart" capability in the BGP OPEN message. If the Cilium agent restarts, the peer does not immediately withdraw routes. The eBPF datapath continues forwarding traffic independently of the agent, so there is no data plane disruption during the restart window.

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeerConfig
metadata:
  name: production-peer-config
spec:
  timers:
    holdTimeSeconds: 90        # Peer declares session down after 90s of silence
    keepAliveTimeSeconds: 30   # Send keepalive every 30s
    connectRetryTimeSeconds: 120  # Retry connection every 120s
  gracefulRestart:
    enabled: true              # Enable graceful restart capability
    restartTimeSeconds: 120    # Peer retains routes for 120s during restart
  ebgpMultihop: 1              # TTL for eBGP sessions (1 = directly connected)
  families:
  - afi: ipv4
    safi: unicast
    advertisements:
      matchLabels:
        advertise: "bgp"
```

**Timer tuning recommendations for production:**

- **`holdTimeSeconds`**: 90 seconds (default) is appropriate for most environments. Lowering it detects failures faster but increases the risk of false positives during agent restarts.
- **`keepAliveTimeSeconds`**: Should be roughly one-third of `holdTimeSeconds`. The default of 30 seconds is a good balance.
- **`restartTimeSeconds`**: Must be long enough for the Cilium agent to restart and re-establish all BGP sessions. 120 seconds provides ample margin for most clusters. Set this based on the observed restart time of the Cilium DaemonSet.

Verify that graceful restart is negotiated with the peer:

```bash
# Check peer status — look for "Graceful Restart" in the capabilities
cilium bgp peers
```

The output should show `Session State: established` and the graceful restart capability as negotiated. If the peer router does not support graceful restart, the capability will not appear even if enabled on the Cilium side.

## Production Troubleshooting

Troubleshooting BGP issues in Cilium follows a systematic approach: verify peer status, inspect routes, check CRD status, and examine logs. The Cilium CLI and standard Kubernetes tools provide all the necessary instrumentation.

### Verifying BGP Peer Status

The first step in any BGP troubleshooting workflow is checking whether sessions are established:

```bash
# List all BGP peers and their session state
cilium bgp peers
```

Expected output for a healthy configuration:

```text
Node          Local AS   Peer AS   Peer Address   Session State   Uptime      Received   Advertised
worker-01     65001      65100     10.0.0.1       established     4h32m15s    12         8
worker-01     65001      65100     10.0.0.2       established     4h32m12s    12         8
worker-02     65001      65100     10.0.0.1       established     4h31m58s    12         6
worker-02     65001      65100     10.0.0.2       established     4h31m55s    12         6
```

If a node appears with a non-`established` state, the BGP session is not up. If a node does not appear at all, the `nodeSelector` in the CiliumBGPClusterConfig does not match that node.

### Inspecting Advertised Routes

```bash
# View routes being advertised to peers
cilium bgp routes advertised ipv4 unicast
```

```bash
# View routes available in the local BGP table
cilium bgp routes available ipv4 unicast
```

Compare the advertised routes against the expected Pod CIDRs and Service IPs. Missing routes indicate a problem with the `CiliumBGPAdvertisement` configuration or the service selector.

### Checking CRD Status

```bash
# Verify CiliumBGPNodeConfig resources are created for each node
kubectl get ciliumbgpnodeconfigs.cilium.io -o wide
```

The Cilium operator creates a `CiliumBGPNodeConfig` resource for each node matched by a `CiliumBGPClusterConfig`. If this resource is missing, check the operator logs for errors.

### Log Analysis

```bash
# Filter Cilium agent logs for BGP-specific messages
kubectl -n kube-system logs -l app.kubernetes.io/name=cilium-agent --tail=100 | grep bgp-control-plane
```

Common error patterns in the logs:

- **`as number mismatch expected X, received Y`** — The configured `peerASN` does not match the ASN the peer is actually announcing. Verify the ASN configuration on both sides.
- **`connection refused`** — The peer IP is unreachable or not running a BGP daemon on the expected port. Verify network connectivity and firewall rules.
- **`hold timer expired`** — The peer stopped sending keepalives. This can indicate a network partition, peer misconfiguration, or the peer being overloaded.

### Common Failure Modes

**BGP session stuck in `Active` or `Connect` state:**
The Cilium agent is attempting to connect but cannot establish a TCP session to the peer. Common causes: firewall blocking port 179, incorrect peer IP address, or the peer not configured to accept connections from the node's IP. Use `tcpdump` on the node to verify TCP SYN packets are being sent and whether SYN-ACK is received.

**Session establishes but no routes advertised:**
Check that the `CiliumBGPAdvertisement` resource exists, has the correct labels matching the `families.advertisements.matchLabels` in the `CiliumBGPPeerConfig`, and that the advertisement types and selectors match existing resources (Pod CIDRs, Services, IP pools).

**Pod CIDRs not re-advertised after Cilium restart:**
This was a known bug in Cilium 1.13.x. Upgrading to Cilium 1.14+ resolves this issue. As a workaround on affected versions, delete and recreate the CiliumBGPPeeringPolicy after a restart.

**Conflicting cluster configurations:**
If two `CiliumBGPClusterConfig` resources match the same node, a `ConflictingClusterConfigs` status condition is set and all BGP sessions on that node are torn down. Use node labels carefully to ensure each node matches exactly one cluster config.

### Monitoring BGP with Prometheus

Cilium exposes BGP-related metrics through its Prometheus endpoint. A `ServiceMonitor` resource can scrape these metrics for Grafana dashboards and alerting:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cilium-bgp-metrics
  namespace: monitoring
  labels:
    app: cilium
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: cilium-agent
  namespaceSelector:
    matchNames:
    - kube-system
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
    relabelings:
    - sourceLabels: [__name__]
      regex: "cilium_bgp_.*"
      action: keep
```

Key metrics to monitor:

- **`cilium_bgp_peers`** — Number of configured BGP peers and their session state. Alert on any peer in non-established state for more than 5 minutes.
- **`cilium_bgp_route_advertisements_total`** — Total number of route advertisements sent. A sudden drop may indicate a configuration change or agent restart.
- **`cilium_bgp_session_state`** — Current session state per peer. Use this for dashboarding and alerting.

## Conclusion

Cilium's BGP Control Plane provides a production-grade solution for advertising Kubernetes routes to external network infrastructure, eliminating the need for separate components like MetalLB on bare-metal and on-premises clusters.

- **Use the v2 API** (`CiliumBGPClusterConfig`, `CiliumBGPPeerConfig`, `CiliumBGPAdvertisement`) for all new deployments. The legacy `CiliumBGPPeeringPolicy` is functional but deprecated.
- **LB-IPAM + BGP replaces MetalLB** completely — Cilium handles both IP allocation and route advertisement in a single stack, with eBPF-accelerated forwarding.
- **BGP communities** enable traffic engineering directly from Kubernetes — tag Pod CIDRs with `no-export`, assign premium communities to critical services, and control upstream routing policy.
- **Graceful restart is essential** for production — it prevents route withdrawal during Cilium agent restarts, maintaining traffic continuity during upgrades.
- **Troubleshooting starts with `cilium bgp peers`** — verify session state, inspect advertised routes, check CRD status, and filter logs with `subsys=bgp-control-plane`.
- **Migrate from MetalLB incrementally** — partition IP pools, run side-by-side, migrate annotations, validate BGP advertisements, then remove MetalLB.
