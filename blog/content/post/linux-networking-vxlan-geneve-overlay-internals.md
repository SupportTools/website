---
title: "Linux Networking: VXLAN, Geneve, and Overlay Network Internals"
date: 2029-10-18T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "VXLAN", "Geneve", "Overlay Networks", "Kubernetes", "CNI"]
categories: ["Linux", "Networking", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into VXLAN encapsulation format, VTEP configuration, FDB entries, Geneve vs VXLAN trade-offs, BUM traffic handling, and how Kubernetes overlay CNIs use these primitives internally."
more_link: "yes"
url: "/linux-networking-vxlan-geneve-overlay-internals/"
---

When a Kubernetes pod on node A sends a packet to a pod on node B across a network that knows nothing about pod CIDRs, something has to bridge that gap. Overlay networks do it by encapsulating the original packet inside a UDP datagram that the underlay knows how to route. Understanding VXLAN and Geneve at the packet and kernel level makes you far more effective at debugging CNI issues, capacity planning, and understanding the real performance overhead of overlay networks.

<!--more-->

# Linux Networking: VXLAN, Geneve, and Overlay Network Internals

## Section 1: Why Overlays Exist

A flat data center network assigns IP addresses from a single block and every host is reachable by every other host at L3. This is simple but does not scale to multi-tenant environments or multi-cloud deployments where:

- Different tenants might need identical IP ranges (10.0.0.0/16 is used everywhere).
- Pod CIDR allocation is controlled by the orchestrator, not the network team.
- Hosts may span multiple physical networks with different L2 domains.

Overlay networks solve this by creating a virtual L2 or L3 network that lives "above" the underlay. Each participating host runs a VTEP (Virtual Tunnel Endpoint) that knows how to encapsulate outgoing frames and decapsulate incoming ones.

## Section 2: VXLAN Encapsulation Format

VXLAN (Virtual eXtensible LAN) is defined in RFC 7348. It encapsulates an entire Ethernet frame inside a UDP packet.

```
┌──────────────────────────────────────────────────────────────┐
│                    Outer Ethernet Header                     │
│  Src MAC: VTEP-A NIC MAC   Dst MAC: Next-hop MAC or VTEP-B  │
├──────────────────────────────────────────────────────────────┤
│                    Outer IP Header                           │
│  Src IP: VTEP-A IP (e.g., 192.168.1.10)                     │
│  Dst IP: VTEP-B IP (e.g., 192.168.1.20)                     │
├──────────────────────────────────────────────────────────────┤
│                    Outer UDP Header                          │
│  Src Port: ephemeral (computed from inner headers for ECMP)  │
│  Dst Port: 4789 (IANA assigned for VXLAN)                   │
├──────────────────────────────────────────────────────────────┤
│                    VXLAN Header (8 bytes)                    │
│  Flags: I=1 (VNI valid), rest reserved                      │
│  VXLAN Network Identifier (VNI): 24 bits (16M segments)     │
├──────────────────────────────────────────────────────────────┤
│                    Inner Ethernet Frame                      │
│  Src MAC: Pod A's veth MAC                                   │
│  Dst MAC: Pod B's veth MAC (or gateway MAC)                 │
│  Inner IP, TCP/UDP, Payload...                              │
└──────────────────────────────────────────────────────────────┘
```

The overhead is:
- Outer Ethernet: 14 bytes
- Outer IP: 20 bytes
- Outer UDP: 8 bytes
- VXLAN header: 8 bytes
- Inner Ethernet: 14 bytes
- **Total overhead: 64 bytes**

For a standard 1500-byte MTU underlay, the effective MTU for VXLAN traffic is 1500 − 64 = **1436 bytes**. Many CNIs set the pod MTU to 1450 or 1440 to leave room for IP options. If you do not account for this, packets get fragmented or silently dropped.

## Section 3: VTEP Configuration on Linux

The Linux kernel has native VXLAN support. You can create and inspect VTEPs with `ip link`.

### Creating a VXLAN Interface

```bash
# Create a VXLAN VTEP for VNI 100, using multicast for BUM traffic
ip link add vxlan0 type vxlan \
    id 100 \
    dstport 4789 \
    group 239.1.1.1 \      # multicast group for BUM traffic
    dev eth0 \             # outgoing interface
    ttl 10

ip addr add 10.200.0.1/24 dev vxlan0
ip link set vxlan0 up

# Verify
ip -d link show vxlan0
# vxlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> ...
#     vxlan id 100 group 239.1.1.1 dev eth0 srcport 0 0 dstport 4789 ttl 10 ageing 300 udpcsum noudp6zerocsumtx noudp6zerocsumrx
```

### Unicast VXLAN with Static FDB Entries

Most Kubernetes CNIs use unicast VXLAN rather than multicast because cloud providers do not support multicast and static multicast group management is operationally complex.

```bash
# Create VXLAN in unicast mode (no multicast group)
ip link add vxlan0 type vxlan \
    id 100 \
    dstport 4789 \
    dev eth0 \
    nolearning      # Disable MAC learning; we manage FDB manually

ip addr add 10.200.0.1/24 dev vxlan0
ip link set vxlan0 up

# Add FDB entries manually or via control plane
# Format: bridge fdb add <inner-MAC> dev vxlan0 dst <remote-VTEP-IP>

# "00:00:00:00:00:00" is the broadcast entry — used for unknown unicast / BUM traffic
bridge fdb add 00:00:00:00:00:00 dev vxlan0 dst 192.168.1.20
bridge fdb add 00:00:00:00:00:00 dev vxlan0 dst 192.168.1.30

# Add a specific MAC-to-VTEP mapping for a known pod MAC
bridge fdb add aa:bb:cc:dd:ee:ff dev vxlan0 dst 192.168.1.20 self permanent
```

### Inspecting FDB Entries

```bash
# Show all FDB entries for vxlan0
bridge fdb show dev vxlan0
# aa:bb:cc:dd:ee:ff dst 192.168.1.20 self permanent
# 00:00:00:00:00:00 dst 192.168.1.20 self permanent
# 00:00:00:00:00:00 dst 192.168.1.30 self permanent

# Show with additional detail
bridge fdb show dev vxlan0 -json | python3 -m json.tool
```

## Section 4: FDB Entries and ARP Suppression

### The ARP Problem at Scale

In a traditional bridged network, when a VM or pod wants to send to an IP it does not know the MAC for, it broadcasts an ARP request to every endpoint in the L2 domain. In a large overlay with thousands of endpoints, this creates enormous BUM (Broadcast, Unknown unicast, Multicast) traffic.

### ARP Suppression via NEIGH Entry

Linux VXLAN supports ARP suppression using neighbor (ARP) entries alongside FDB entries. When the local VTEP receives an ARP request for an IP it knows the MAC for (from its local ARP table), it responds locally without flooding the overlay.

```bash
# Add a neighbor entry so the VTEP can suppress ARP for 10.200.0.2
ip neigh add 10.200.0.2 lladdr aa:bb:cc:dd:ee:ff dev vxlan0 nud permanent

# Verify
ip neigh show dev vxlan0
# 10.200.0.2 lladdr aa:bb:cc:dd:ee:ff PERMANENT

# Enable ARP suppression on the VXLAN interface (requires kernel 4.15+)
ip link add vxlan0 type vxlan \
    id 100 \
    dstport 4789 \
    dev eth0 \
    nolearning \
    proxy          # Enable proxy ARP/ND
```

## Section 5: Geneve vs VXLAN

Geneve (Generic Network Virtualization Encapsulation, RFC 8926) was designed to address VXLAN's limitations, particularly its fixed 24-bit VNI and inflexible header.

### Geneve Encapsulation Format

```
┌──────────────────────────────────────────────────────────────┐
│                    Outer Ethernet + IP + UDP                 │
│  Dst UDP Port: 6081 (IANA assigned for Geneve)              │
├──────────────────────────────────────────────────────────────┤
│                    Geneve Header (variable length)           │
│  Version: 2 bits                                            │
│  Options Length: 6 bits (in 4-byte words, 0-252 bytes)      │
│  Control: 1 bit (OAM path if set)                           │
│  Critical: 1 bit (stop processing if option not understood)  │
│  Reserved: 6 bits                                           │
│  Protocol Type: 16 bits (Ethertype of inner frame)          │
│  Virtual Network Identifier: 24 bits                        │
│  Reserved: 8 bits                                           │
│  Options: 0-252 bytes of TLV-encoded metadata              │
├──────────────────────────────────────────────────────────────┤
│                    Inner Ethernet Frame                      │
└──────────────────────────────────────────────────────────────┘
```

### Key Differences

| Feature | VXLAN | Geneve |
|---|---|---|
| Header size | Fixed 8 bytes | Variable (8 + options) |
| VNI size | 24 bits (16M) | 24 bits (16M) |
| Options/metadata | None | Up to 252 bytes of TLVs |
| OVN/OVS support | Yes | Yes (preferred) |
| Hardware offload | Widely available | Increasingly available |
| Kernel support | 3.7+ | 3.18+ |
| Default UDP port | 4789 | 6081 |

The options field is Geneve's key advantage. OVN (Open Virtual Network) uses Geneve option TLVs to carry tunnel metadata (logical port IDs, logical switch IDs) in the header rather than requiring a separate out-of-band lookup. This enables stateless load balancing and connection tracking without per-flow state in the data plane.

### Creating a Geneve Interface

```bash
# Create a Geneve tunnel endpoint
ip link add geneve0 type geneve \
    id 100 \
    remote 192.168.1.20 \
    dstport 6081

ip addr add 10.201.0.1/30 dev geneve0
ip link set geneve0 up

# View geneve interface details
ip -d link show geneve0
# geneve0: ...
#     geneve id 100 remote 192.168.1.20 ttl inherit dstport 6081
```

## Section 6: BUM Traffic Handling

BUM (Broadcast, Unknown unicast, Multicast) traffic is traffic that must be delivered to all endpoints in the overlay segment because the destination is not known. The three approaches are:

### 1. Multicast-Based BUM

Each VNI maps to a multicast group. All VTEPs join the group. BUM traffic is sent to the multicast address, and the underlay's multicast routing replicates it to all group members.

```bash
# Node A: VTEP joins multicast group 239.1.1.1
ip link add vxlan100 type vxlan id 100 group 239.1.1.1 dev eth0 dstport 4789
```

Requires underlay multicast routing (PIM-SM or PIM-SSM). Not available on most cloud platforms.

### 2. Ingress Replication (Unicast Flooding)

The source VTEP replicates BUM frames and sends a copy to each known remote VTEP via unicast. This is the standard approach for cloud-based Kubernetes deployments.

```bash
# Add a BUM entry for each remote VTEP
bridge fdb add 00:00:00:00:00:00 dev vxlan100 dst 192.168.1.20
bridge fdb add 00:00:00:00:00:00 dev vxlan100 dst 192.168.1.30
bridge fdb add 00:00:00:00:00:00 dev vxlan100 dst 192.168.1.40
```

The cost is O(N) copies of every BUM frame, where N is the number of remote VTEPs. For a 500-node cluster, every ARP request is replicated 499 times. ARP suppression mitigates this significantly.

### 3. Controller-Based Unicast (Kubernetes CNI Approach)

The CNI control plane (etcd, Kubernetes API server, or a dedicated controller) maintains the mapping of pod IPs to node IPs. When a pod is scheduled, the control plane pushes the mapping to all nodes. VTEPs are pre-populated with FDB and neighbor entries so BUM traffic becomes rare.

This is how Flannel, Calico (VXLAN mode), and Cilium (in VXLAN mode) work.

## Section 7: Kubernetes Overlay CNI Internals

### Flannel VXLAN Mode

Flannel uses the Linux VXLAN kernel module in unicast/nolearning mode. The `flanneld` daemon watches the Kubernetes node API for new nodes and updates FDB entries.

```bash
# On a node running Flannel, inspect the VXLAN setup
ip link show flannel.1
# flannel.1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450 qdisc noqueue ...
#     link/ether ba:36:7b:24:18:a8 brd ff:ff:ff:ff:ff:ff

ip route show
# 10.244.1.0/24 via 10.244.1.0 dev flannel.1 onlink
# 10.244.2.0/24 via 10.244.2.0 dev flannel.1 onlink

bridge fdb show flannel.1
# c2:d4:3a:88:9b:12 dst 192.168.1.20 self permanent
# 00:00:00:00:00:00 dst 192.168.1.20 self permanent
```

The `onlink` flag in routes tells the kernel to treat the next-hop as directly reachable even though it's not in the same subnet. This is necessary because `10.244.1.0` is a pod subnet gateway address on a remote node.

### Calico VXLAN Mode

Calico VXLAN uses the same kernel VXLAN module but manages routes differently. Calico does not create a separate bridge; instead it programs routes directly to the VXLAN interface.

```bash
# On a Calico VXLAN node
ip link show vxlan.calico
# vxlan.calico: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450

# Routes for remote pods go via the VXLAN interface
ip route show | grep vxlan
# 192.168.1.0/26 via 192.168.1.0 dev vxlan.calico onlink

# Calico-managed FDB entries
bridge fdb show dev vxlan.calico
# 66:e4:de:cb:98:2e dst 10.128.0.5 self permanent
# 00:00:00:00:00:00 dst 10.128.0.5 self permanent
```

### Cilium VXLAN Mode

Cilium uses eBPF programs attached to the VXLAN interface instead of routing tables for some traffic classes. The VXLAN device still exists at the kernel level, but eBPF programs intercept packets before they hit the standard routing stack.

```bash
# Cilium's VXLAN device
ip link show cilium_vxlan
# cilium_vxlan: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500

# Cilium BPF maps contain the tunnel endpoint information
cilium bpf tunnel list
# PREFIX         ENDPOINT
# 10.0.1.0/24   192.168.1.20:8472
# 10.0.2.0/24   192.168.1.30:8472
```

Note that Cilium uses port 8472 by default for VXLAN — different from the IANA-assigned 4789. This is a legacy choice from when 4789 was not yet registered.

## Section 8: Performance Analysis and Overhead

### Measuring VXLAN Overhead

```bash
# Baseline: MTU of physical NIC
ip link show eth0 | grep mtu
# ... mtu 1500 ...

# VXLAN MTU (64 bytes overhead)
ip link show flannel.1 | grep mtu
# ... mtu 1450 ...  (some CNIs use 1450, others 1440 for extra headroom)

# Test throughput with and without VXLAN
# Direct (no overlay):
iperf3 -c 192.168.1.20 -t 30

# Through overlay:
iperf3 -c 10.244.1.5 -t 30  # pod IP on remote node

# Typical results on a 10Gbps link:
# Direct: ~9.4 Gbps
# VXLAN (software): ~7.0-8.0 Gbps
# VXLAN (NIC offload): ~9.0-9.2 Gbps
```

### NIC Hardware Offload

Modern NICs support VXLAN checksum offload and segmentation offload (TSO/GSO for VXLAN). This significantly reduces CPU overhead for tunnel encapsulation.

```bash
# Check NIC VXLAN offload capabilities
ethtool -k eth0 | grep -E "tx-udp_tnl|rx-udp_tnl|tx-gso-udp-tunnel"
# tx-udp_tnl-segmentation: on
# rx-udp_tnl-csum-segmentation: off [fixed]
# tx-gso-udp-tunnel: off [requested on]

# Enable VXLAN hardware offload
ethtool -K eth0 tx-udp_tnl-segmentation on
ethtool -K eth0 tx-gso-udp-tunnel on
```

### CPU Overhead Analysis

```bash
# Monitor CPU usage per-core during heavy VXLAN traffic
perf top -e cycles:u

# Check kernel statistics for VXLAN
cat /proc/net/dev | grep vxlan
watch -n 1 'cat /proc/net/dev | grep flannel'

# Use bpftrace to count VXLAN encapsulation events
bpftrace -e 'kprobe:vxlan_xmit { @[comm] = count(); }'
```

## Section 9: Troubleshooting Overlay Networks

### Packet Loss and MTU Issues

MTU mismatch is the most common cause of mysterious connectivity issues in overlay networks. Large packets work fine (because they get fragmented), small packets work fine, but medium-to-large packets with DF (Don't Fragment) bit set fail silently.

```bash
# Test with specific packet sizes to detect MTU issues
# Start large and work down until the ping succeeds
ping -c 3 -M do -s 1400 10.244.1.5  # -M do = don't fragment
ping -c 3 -M do -s 1300 10.244.1.5
ping -c 3 -M do -s 1200 10.244.1.5

# A working size suggests your effective MTU is approximately that size + 28 (IP+ICMP headers)

# Check if ICMP fragmentation-needed messages are being dropped
tcpdump -i eth0 'icmp[0] == 3 and icmp[1] == 4'
```

### Capturing VXLAN Traffic

```bash
# Capture outer VXLAN packets on the physical NIC
tcpdump -i eth0 -n 'udp port 4789' -w /tmp/vxlan.pcap

# Capture decapsulated traffic on the VXLAN interface
tcpdump -i flannel.1 -n host 10.244.1.5

# Decode a VXLAN capture in Wireshark or with tshark
tshark -r /tmp/vxlan.pcap -d udp.port==4789,vxlan -T fields \
    -e frame.number \
    -e vxlan.vni \
    -e inner.ip.src \
    -e inner.ip.dst
```

### FDB Stale Entries

```bash
# Check FDB entry ages (stale entries can cause packet black-holes)
bridge fdb show | grep "STALE\|extern_learn"

# Manually flush stale FDB entries for a remote host that was decommissioned
bridge fdb del 00:00:00:00:00:00 dev flannel.1 dst 192.168.1.99

# Monitor FDB changes in real-time
ip monitor neigh fdb
```

## Section 10: VXLAN with BGP EVPN (Advanced)

For large-scale deployments, manually managing FDB entries doesn't scale. EVPN (Ethernet VPN, RFC 7432) uses BGP to distribute MAC and IP reachability information across VTEPs automatically.

```bash
# Install FRRouting for BGP EVPN
apt-get install -y frr

# Enable BGP daemon in FRR
sed -i 's/bgpd=no/bgpd=yes/' /etc/frr/daemons

# Basic BGP EVPN configuration
cat > /etc/frr/frr.conf << 'EOF'
router bgp 65000
  bgp router-id 192.168.1.10
  neighbor 192.168.1.1 remote-as 65000
  !
  address-family l2vpn evpn
    neighbor 192.168.1.1 activate
    advertise-all-vni
  exit-address-family
!
vrf tenant1
  vni 100
!
EOF

systemctl restart frr

# Verify EVPN routes are being distributed
vtysh -c "show bgp l2vpn evpn summary"
vtysh -c "show bgp l2vpn evpn route"
```

EVPN-with-VXLAN is the foundation of modern data center fabrics (Arista, Cumulus, Juniper) and is also used by Calico's BGP mode when combined with VXLAN for tunnel termination.

Understanding these primitives — the packet format, FDB management, ARP suppression, and BUM handling — gives you the vocabulary and tools to diagnose any overlay network issue, whether it originates in the CNI control plane, the kernel VXLAN module, or the physical network below.
