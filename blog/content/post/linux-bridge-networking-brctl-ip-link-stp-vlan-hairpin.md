---
title: "Linux Bridge Networking with brctl and ip link: STP Configuration, VLAN Filtering, Hairpin Mode, and Kernel Bridge Internals"
date: 2032-01-19T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Bridge", "VLAN", "STP", "KVM", "Containers"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux kernel bridge networking covering bridge creation with ip link and brctl, Spanning Tree Protocol configuration to prevent loops, VLAN-aware bridge filtering for multi-tenant environments, hairpin mode for container networking, and performance tuning for KVM and container host deployments."
more_link: "yes"
url: "/linux-bridge-networking-brctl-ip-link-stp-vlan-hairpin/"
---

Linux bridge networking is the foundation of KVM virtual machine networking, container networking with Docker and Podman, and many SDN implementations. Despite being replaced in some environments by Open vSwitch, the kernel bridge remains the most performant, lowest-overhead solution for straightforward Layer 2 switching requirements. This guide covers bridge operation from the kernel data path through production configuration patterns.

<!--more-->

# Linux Bridge Networking: Production Guide

## Section 1: Kernel Bridge Architecture

The Linux bridge operates in the kernel's networking stack between Layer 2 (Ethernet) and Layer 3 (IP). It functions as a software Ethernet switch, learning MAC addresses, forwarding frames between ports, and optionally running STP to prevent loops.

### Data Path

```
Physical NIC (eth0)
    │
    ▼
Bridge (br0) ─── MAC learning table (FDB)
    │
    ├── tap0 (VM1 virtual NIC)
    ├── tap1 (VM2 virtual NIC)
    ├── veth0 (container veth pair end)
    └── bond0 (bonded physical uplink)
```

When a frame arrives on any bridge port:
1. The bridge records the source MAC → ingress port mapping in the FDB (Forwarding Database)
2. If destination MAC is known, frame is sent to that port only (unicast forwarding)
3. If destination MAC is unknown or broadcast, frame is flooded to all ports except ingress (flooding)
4. If destination MAC is the bridge itself, frame is delivered to the Linux network stack

### Kernel Modules

```bash
# Bridge functionality is built into the kernel on most distributions
# but may need explicit loading on minimal kernels
lsmod | grep bridge

# Load if needed
modprobe bridge
modprobe br_netfilter    # required for iptables to see bridged traffic
modprobe 8021q           # VLAN support

# Make persistent
cat >> /etc/modules-load.d/bridge.conf << 'EOF'
bridge
br_netfilter
8021q
EOF
```

### Bridge vs. Open vSwitch

| Feature | Linux Bridge | Open vSwitch |
|---------|-------------|--------------|
| Performance | Excellent (kernel native) | Good (kernel datapath) |
| VLAN support | Per-port (bridge vlan) | Full VLAN matrix |
| OpenFlow | No | Yes |
| DPDK | No | Yes (OVS-DPDK) |
| SDN integration | Limited | Full |
| Complexity | Low | High |
| Debugging tools | ip/bridge commands | ovs-vsctl, ovs-ofctl |

For KVM hosts and simple container networking, Linux bridge is the right choice. For cloud infrastructure with SDN requirements, OVS is warranted.

## Section 2: Creating Bridges with ip link

The `ip` command from iproute2 is the modern interface for bridge management. `brctl` (from bridge-utils) is legacy but still common.

### Creating a Basic Bridge

```bash
# Create bridge with ip link
ip link add name br0 type bridge

# Set bridge parameters at creation time
ip link add name br0 type bridge \
  stp_state 1 \
  forward_delay 4 \
  hello_time 2 \
  max_age 20 \
  ageing_time 300 \
  vlan_filtering 1 \
  vlan_default_pvid 1

# Bring it up
ip link set br0 up

# Assign IP if bridge needs to be routed
ip addr add 192.168.100.1/24 dev br0

# Add physical interface to bridge (becomes a "port")
# Note: removing IP from physical interface first is required
ip addr del 192.168.1.10/24 dev eth0
ip link set eth0 master br0

# Verify
bridge link show
ip link show type bridge
ip addr show br0
```

### Bridge with Existing IP Migration

In production, migrating a physical interface into a bridge while maintaining connectivity requires careful sequencing:

```bash
#!/usr/bin/env bash
# Migrate eth0 from direct IP to bridge member
# Must be run with care - will briefly disrupt connectivity

set -euo pipefail

ETH=eth0
BRIDGE=br0
OLD_ADDR=$(ip -4 addr show "$ETH" | grep inet | awk '{print $2}')
OLD_GW=$(ip route show default | grep "$ETH" | awk '{print $3}')
OLD_MTU=$(ip link show "$ETH" | grep mtu | awk '{print $5}')

echo "Migrating $ETH ($OLD_ADDR, gw=$OLD_GW, mtu=$OLD_MTU) to bridge $BRIDGE"

# Create bridge with same MTU
ip link add name "$BRIDGE" type bridge stp_state 0
ip link set "$BRIDGE" mtu "$OLD_MTU"

# Remove IP from eth0 and add to bridge
ip addr del "$OLD_ADDR" dev "$ETH"
ip link set "$ETH" master "$BRIDGE"
ip link set "$ETH" up
ip link set "$BRIDGE" up

# Add IP to bridge and restore route
ip addr add "$OLD_ADDR" dev "$BRIDGE"
ip route add default via "$OLD_GW" dev "$BRIDGE"

echo "Migration complete"
ip addr show "$BRIDGE"
```

### Legacy brctl Commands

```bash
# brctl equivalents (still found in many scripts)
brctl addbr br0           # == ip link add name br0 type bridge
brctl delbr br0           # == ip link del br0
brctl addif br0 eth0      # == ip link set eth0 master br0
brctl delif br0 eth0      # == ip link set eth0 nomaster
brctl show                # == bridge link show
brctl showmacs br0        # == bridge fdb show dev br0
brctl stp br0 on          # == ip link set br0 type bridge stp_state 1

# brctl is DEPRECATED - prefer ip/bridge commands
# Install if needed: apt install bridge-utils
```

## Section 3: Spanning Tree Protocol (STP)

STP prevents forwarding loops in bridge networks with redundant links. Without STP, a loop causes a broadcast storm that saturates all links at 100%.

### STP Modes

| Mode | Standard | Convergence | Use Case |
|------|----------|-------------|----------|
| STP | 802.1D | 30-50 seconds | Legacy |
| RSTP | 802.1w | 1-2 seconds | Default in Linux |
| MSTP | 802.1s | Per-instance | VLAN load balancing |

The Linux bridge implements RSTP (Rapid STP) when STP is enabled.

### Enabling and Configuring STP

```bash
# Enable STP
ip link set br0 type bridge stp_state 1

# Configure timers (in seconds, set via sysfs)
# hello_time: how often BPDU is sent (1-10 seconds, default 2)
echo 2 > /sys/class/net/br0/bridge/hello_time

# max_age: maximum age of BPDU info (6-40 seconds, default 20)
echo 20 > /sys/class/net/br0/bridge/max_age

# forward_delay: time in listening/learning states (4-30 seconds, default 15)
# With RSTP this is usually bypassed via edge port negotiation
echo 4 > /sys/class/net/br0/bridge/forward_delay

# Bridge priority (0-65535, lower is better, multiples of 4096)
# Default is 32768; set lower to prefer this bridge as root
echo 4096 > /sys/class/net/br0/bridge/priority

# View STP state
cat /sys/class/net/br0/bridge/stp_state
bridge link show br0
```

### Per-Port STP Configuration

```bash
# View port roles and states
bridge link show br0
# Output:
# 4: eth0 state forwarding   priority 32 cost 4
# 5: tap0 state forwarding   priority 32 cost 100

# Set port cost (lower = preferred path for traffic)
# ip link set INTERFACE type bridge_slave cost VALUE
ip link set eth0 type bridge_slave cost 4
ip link set eth1 type bridge_slave cost 4

# Set port priority (lower = preferred as designated port)
ip link set eth0 type bridge_slave priority 32

# Portfast equivalent: mark port as edge port
# Edge ports skip listening/learning states (near-instant forwarding)
# Use ONLY for ports connected to hosts, never for switch-to-switch links
ip link set tap0 type bridge_slave state 3     # force forwarding
# Or use bridge tool:
bridge link set dev tap0 learning on flood on
```

### STP in KVM Environments

```bash
# For TAP interfaces to VMs: disable STP (they're always endpoints, not loops)
# This is the equivalent of "portfast" - instant state transition

# Method 1: Set port cost high to prevent being chosen as root port
# Method 2: Use kernel STP optimization
echo 0 > /sys/class/net/br0/bridge/stp_state   # Disable STP if no redundant links

# In libvirt networks, STP is typically disabled
virsh net-dumpxml default | grep stp
# <bridge name='virbr0' stp='off' delay='0'/>
```

### Detecting and Diagnosing STP Issues

```bash
# Watch bridge port states in real time
watch -n 1 "bridge link show"

# Port state codes:
# 0 = disabled
# 1 = listening (STP negotiating)
# 2 = learning (populating FDB, not forwarding)
# 3 = forwarding (normal operation)
# 4 = blocking (STP loop prevention)

# If a port stays in state 1 or 2 for > 30 seconds, STP is not converging
# Common cause: another device is claiming to be root bridge

# Check if bridge is root
cat /sys/class/net/br0/bridge/root_port
# 0 means this bridge IS the root bridge

# View root bridge MAC
cat /sys/class/net/br0/bridge/root_id
```

## Section 4: VLAN-Aware Bridge

The VLAN-aware bridge (introduced in kernel 3.9) allows a single bridge to handle multiple VLANs without creating separate bridges per VLAN. This is the Linux equivalent of a 802.1Q-capable switch.

### Enabling VLAN Filtering

```bash
# Create VLAN-aware bridge
ip link add name br0 type bridge vlan_filtering 1

# Or enable on existing bridge
ip link set br0 type bridge vlan_filtering 1

# Set default PVID (Port VLAN ID) - the VLAN untagged traffic is assigned to
ip link set br0 type bridge vlan_default_pvid 100

# Bring up bridge
ip link set br0 up
```

### VLAN Port Configuration

```bash
# Add physical uplink as trunk port (allows multiple VLANs)
ip link set eth0 master br0

# Add VLANs to trunk port
bridge vlan add vid 100 dev eth0        # VLAN 100 - tagged
bridge vlan add vid 200 dev eth0        # VLAN 200 - tagged
bridge vlan add vid 300 dev eth0        # VLAN 300 - tagged
bridge vlan add vid 1-100 dev eth0      # Range: VLANs 1-100

# Add access port (VM or container - single VLAN untagged)
ip link set tap0 master br0
bridge vlan del vid 1 dev tap0          # Remove default VLAN 1
bridge vlan add vid 100 dev tap0 pvid untagged  # VLAN 100 as access port

# Add second VM on VLAN 200
ip link set tap1 master br0
bridge vlan del vid 1 dev tap1
bridge vlan add vid 200 dev tap1 pvid untagged

# View VLAN assignments
bridge vlan show
# port    vlan ids
# eth0     1
#          100
#          200
#          300
# tap0     100 PVID Egress Untagged
# tap1     200 PVID Egress Untagged
# br0      1 PVID Egress Untagged
```

### VLAN Bridge for KVM Multi-Tenant Networking

```bash
#!/usr/bin/env bash
# Setup multi-tenant VLAN bridge for KVM hypervisor
# Assumes trunk uplink on eth0 with VLANs 100-110

BRIDGE=br-vlan
UPLINK=eth0

# Create VLAN-aware bridge
ip link add "$BRIDGE" type bridge vlan_filtering 1 vlan_default_pvid 0
ip link set "$BRIDGE" up

# Add uplink as trunk
ip link set "$UPLINK" master "$BRIDGE"

# Allow VLANs 100-110 on uplink (tagged)
for vlan in $(seq 100 110); do
    bridge vlan add vid "$vlan" dev "$UPLINK"
done

# Assign management IP to VLAN 100 on bridge
ip link add link "$BRIDGE" name "${BRIDGE}.100" type vlan id 100
ip link set "${BRIDGE}.100" up
ip addr add 10.100.0.1/24 dev "${BRIDGE}.100"

echo "Bridge $BRIDGE configured with VLAN trunk on $UPLINK"
bridge vlan show
```

### Connecting VM TAP Interface to Specific VLAN

```bash
# Create TAP interface for a VM
ip tuntap add tap-vm1 mode tap
ip link set tap-vm1 up

# Add to bridge
ip link set tap-vm1 master br-vlan

# Assign VLAN 105 as access (untagged from VM's perspective)
bridge vlan del vid 0 dev tap-vm1 2>/dev/null || true
bridge vlan add vid 105 dev tap-vm1 pvid untagged

# VM on tap-vm1 sends untagged traffic, bridge tags it VLAN 105
# Uplink to physical switch carries it tagged as VLAN 105
```

## Section 5: Hairpin Mode

Hairpin mode allows traffic from a bridge port to be forwarded back to the same port. This is required for scenarios where multiple virtual machines or containers share a TAP interface and need to communicate via the bridge.

### When Hairpin Mode is Needed

```
Without hairpin:
VM1 ──► tap0 ──► bridge ──► tap0 (blocked - same port)
                                   No delivery to VM2 sharing tap0

With hairpin:
VM1 ──► tap0 ──► bridge ──► tap0 ──► VM2
                           hairpin enabled - loop back permitted
```

This pattern appears in:
- macvtap interfaces where multiple VMs share a physical NIC
- VEPA (Virtual Ethernet Port Aggregator) mode
- Some bonding configurations

### Configuring Hairpin Mode

```bash
# Enable hairpin mode on a specific port
ip link set tap0 type bridge_slave hairpin on

# Or via sysfs
echo 1 > /sys/class/net/tap0/brport/hairpin_mode

# Verify
bridge link show dev tap0
# 12: tap0 state forwarding priority 32 cost 100 hairpin on

# Disable hairpin
ip link set tap0 type bridge_slave hairpin off
```

### Hairpin in Macvlan/Macvtap Setups

```bash
# For macvtap devices in bridge mode with multiple VMs on same NIC
# Each macvtap gets hairpin enabled

for dev in /sys/class/net/macvtap*/brport; do
    echo 1 > "$dev/hairpin_mode"
done

# Verify all macvtap devices have hairpin enabled
for dev in /sys/class/net/macvtap*/brport/hairpin_mode; do
    echo "$dev: $(cat $dev)"
done
```

## Section 6: Bridge FDB (Forwarding Database) Management

The FDB maps MAC addresses to ports. Understanding it is essential for debugging forwarding issues.

```bash
# View complete FDB
bridge fdb show

# View FDB for specific bridge
bridge fdb show br br0

# View FDB for specific device
bridge fdb show dev eth0

# Typical FDB output:
# 00:11:22:33:44:55 dev tap0 master br0
# 33:33:00:00:00:01 dev eth0 self permanent    <- multicast
# ff:ff:ff:ff:ff:ff dev eth0 self permanent    <- broadcast

# Add static FDB entry (prevent learning/flooding for specific MAC)
bridge fdb add 00:11:22:33:44:55 dev tap0 master

# Delete FDB entry
bridge fdb del 00:11:22:33:44:55 dev tap0 master

# Flush all dynamic entries (force re-learning)
bridge fdb flush dev br0

# Set ageing time (seconds before unused entries expire)
echo 300 > /sys/class/net/br0/bridge/ageing_time
```

## Section 7: Performance Tuning

### Kernel Bridge Parameters

```bash
# Tune bridge parameters via sysctl
cat > /etc/sysctl.d/10-bridge.conf << 'EOF'
# Required for iptables to process bridged traffic
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-arptables = 0

# Disable netfilter on bridge ports for pure L2 switching performance
# WARNING: This bypasses all iptables rules for bridged traffic
# Only use if you have no container/VM firewall requirements
# net.bridge.bridge-nf-call-iptables = 0
EOF

sysctl --system
```

### Offloading to Hardware

Modern NICs support VLAN and bridge offloading:

```bash
# Enable hardware offloading for bridge (if NIC supports it)
# This offloads MAC learning and forwarding to NIC hardware

# Check if NIC supports bridge offloading
ethtool -k eth0 | grep -E "rx-hashing|tx-checksumming|rx-checksumming|l2-fwd-offload"

# Enable offloading (vendor-specific)
# Intel ixgbe/i40e:
ethtool -K eth0 l2-fwd-offload on

# Verify
ip link show eth0 | grep bridge_compat
```

### Bridge with XDP for High Performance

For high-throughput scenarios, XDP (eXpress Data Path) can process frames before they reach the bridge:

```bash
# Load XDP program on bridge uplink
# This requires a compiled XDP program - example uses generic mode
ip link set eth0 xdp obj /usr/local/lib/xdp/bridge_redirect.o sec xdp

# Verify XDP is loaded
ip link show eth0 | grep xdp

# Remove XDP
ip link set eth0 xdp off
```

## Section 8: NetworkManager and systemd-networkd Bridge Config

### NetworkManager (nmcli)

```bash
# Create bridge via NetworkManager
nmcli connection add \
  type bridge \
  con-name br0 \
  ifname br0 \
  bridge.stp yes \
  bridge.forward-delay 4 \
  bridge.hello-time 2 \
  bridge.max-age 20

# Add port to bridge
nmcli connection add \
  type ethernet \
  con-name br0-port-eth0 \
  ifname eth0 \
  master br0

# Configure IP
nmcli connection modify br0 \
  ipv4.addresses 192.168.100.1/24 \
  ipv4.method manual

nmcli connection up br0
```

### systemd-networkd

```ini
# /etc/systemd/network/10-br0.netdev
[NetDev]
Name=br0
Kind=bridge

[Bridge]
STP=yes
ForwardDelaySec=4
HelloTimeSec=2
MaxAgeSec=20
VLANFiltering=yes
DefaultPVID=1
```

```ini
# /etc/systemd/network/20-eth0.network
[Match]
Name=eth0

[Network]
Bridge=br0
```

```ini
# /etc/systemd/network/30-br0.network
[Match]
Name=br0

[Network]
DHCP=no
Address=192.168.100.1/24

[BridgeVLAN]
VLAN=100
VLAN=200
EgressUntagged=100
PVID=100
```

## Section 9: Troubleshooting

### Diagnosing Forwarding Issues

```bash
# Check bridge port states
bridge link show

# Verify FDB has expected MAC entries
bridge fdb show br br0 | grep "de:ad:be:ef"

# Trace frame through bridge with tcpdump
# Capture on uplink
tcpdump -i eth0 -e -n "ether host de:ad:be:ef:00:01"
# Capture on specific tap
tcpdump -i tap0 -e -n

# Check if bridge is filtering with ebtables
ebtables -L
ebtables -t filter -L

# Check if iptables/nftables is affecting bridged traffic
iptables -L FORWARD -v -n | grep -v "0     0"
nft list ruleset | grep bridge
```

### STP Convergence Problems

```bash
# If ports are stuck in learning/listening state
# Check for conflicting root bridge
cat /sys/class/net/br0/bridge/root_id

# Force root bridge election by lowering priority
echo 0 > /sys/class/net/br0/bridge/priority

# Disable STP if no redundant links (fastest fix)
ip link set br0 type bridge stp_state 0
```

### VLAN Issues

```bash
# If VMs can't communicate across VLANs when they should be on same VLAN
# Check VLAN table
bridge vlan show

# Verify PVID is set correctly on access ports
bridge vlan show dev tap0
# Should show: 100 PVID Egress Untagged

# Check if VLAN filtering is actually enabled
cat /sys/class/net/br0/bridge/vlan_filtering

# Check if default PVID matches
cat /sys/class/net/br0/bridge/default_pvid
```

Linux bridge networking is mature, well-understood, and performant for its target use cases. The combination of VLAN-aware filtering, proper STP configuration, and hairpin mode where needed covers the vast majority of KVM hypervisor and container host networking requirements without the operational complexity of OVS.
