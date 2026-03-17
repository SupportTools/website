---
title: "Linux Network Bridging and Bonding: High-Availability Network Interfaces"
date: 2030-07-18T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Bonding", "Bridging", "LACP", "High Availability", "Kubernetes"]
categories:
- Linux
- Networking
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Linux networking guide covering bridge configuration with nmcli and netplan, active-backup and LACP bonding modes, VLAN trunking over bonds, network failover testing, and Kubernetes node network configuration patterns."
more_link: "yes"
url: "/linux-network-bridging-bonding-high-availability-interfaces/"
---

Enterprise Linux hosts require network configurations that survive individual NIC failures, provide aggregate bandwidth across multiple interfaces, and support isolated VLAN segments for multi-tenant environments. Bonding combines multiple physical interfaces into a single logical interface for redundancy or throughput, while bridging creates a virtual switch that forwards traffic between interfaces at Layer 2. Understanding these primitives is foundational for Kubernetes node networking, KVM hypervisor configuration, and any environment where network availability directly impacts service SLAs.

<!--more-->

## Network Bonding Fundamentals

Linux bonding (also called channel bonding or NIC teaming) aggregates multiple physical NICs into a single logical interface. The kernel bonding driver supports several modes with different tradeoff profiles:

| Mode | Name | Description | Switch Support Required |
|------|------|-------------|------------------------|
| 0 | balance-rr | Round-robin, load balancing + fault tolerance | None |
| 1 | active-backup | Only one active slave at a time, failover | None |
| 2 | balance-xor | XOR-based load balancing + fault tolerance | None |
| 3 | broadcast | Transmits on all slaves | None |
| 4 | 802.3ad | IEEE 802.3ad LACP dynamic link aggregation | LACP-enabled switch |
| 5 | balance-tlb | Adaptive transmit load balancing | None |
| 6 | balance-alb | Adaptive load balancing (RX + TX) | None |

For enterprise environments, `mode=1` (active-backup) is the safest failover option, while `mode=4` (802.3ad LACP) provides both redundancy and bandwidth aggregation when switch support is available.

## Configuring Bonding with nmcli (RHEL/Rocky Linux)

### Active-Backup Bond

```bash
# Create the bond interface
nmcli connection add \
  type bond \
  con-name bond0 \
  ifname bond0 \
  bond.options "mode=active-backup,miimon=100,updelay=200,downdelay=200,primary=ens3f0"

# Add first slave (primary)
nmcli connection add \
  type ethernet \
  con-name bond0-slave-ens3f0 \
  ifname ens3f0 \
  master bond0

# Add second slave (backup)
nmcli connection add \
  type ethernet \
  con-name bond0-slave-ens3f1 \
  ifname ens3f1 \
  master bond0

# Configure IP address on the bond
nmcli connection modify bond0 \
  ipv4.method manual \
  ipv4.addresses 10.10.1.50/24 \
  ipv4.gateway 10.10.1.1 \
  ipv4.dns "10.10.1.2,10.10.1.3" \
  ipv4.dns-search "prod.example.com" \
  connection.autoconnect yes

# Bring up the bond
nmcli connection up bond0
nmcli connection up bond0-slave-ens3f0
nmcli connection up bond0-slave-ens3f1

# Verify bond status
cat /proc/net/bonding/bond0
```

Expected `/proc/net/bonding/bond0` output:

```
Ethernet Channel Bonding Driver: v3.7.1

Bonding Mode: fault-tolerance (active-backup)
Primary Slave: ens3f0 (primary_reselect failure)
Currently Active Slave: ens3f0
MII Status: up
MII Polling Interval (ms): 100
Up Delay (ms): 200
Down Delay (ms): 200

Slave Interface: ens3f0
MII Status: up
Speed: 25000 Mbps
Duplex: full
Link Failure Count: 0
Permanent HW addr: 00:1a:4b:12:34:56
Slave queue ID: 0

Slave Interface: ens3f1
MII Status: up
Speed: 25000 Mbps
Duplex: full
Link Failure Count: 0
Permanent HW addr: 00:1a:4b:12:34:57
Slave queue ID: 0
```

### LACP (802.3ad) Bond

```bash
# Create LACP bond (requires switch configuration)
nmcli connection add \
  type bond \
  con-name bond0-lacp \
  ifname bond0 \
  bond.options "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=layer3+4"

# Add slaves
nmcli connection add \
  type ethernet \
  con-name bond0-lacp-slave-ens3f0 \
  ifname ens3f0 \
  master bond0

nmcli connection add \
  type ethernet \
  con-name bond0-lacp-slave-ens3f1 \
  ifname ens3f1 \
  master bond0

# Apply IP configuration
nmcli connection modify bond0-lacp \
  ipv4.method manual \
  ipv4.addresses 10.10.1.50/24 \
  ipv4.gateway 10.10.1.1

nmcli connection up bond0-lacp
nmcli connection up bond0-lacp-slave-ens3f0
nmcli connection up bond0-lacp-slave-ens3f1

# Verify LACP negotiation
cat /proc/net/bonding/bond0
# Look for "Aggregator ID" values matching between slaves
```

## Configuring Bonding with Netplan (Ubuntu)

### Active-Backup Bond with netplan

```yaml
# /etc/netplan/01-bond0.yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    ens3f0:
      dhcp4: false
      dhcp6: false
    ens3f1:
      dhcp4: false
      dhcp6: false
  bonds:
    bond0:
      interfaces:
        - ens3f0
        - ens3f1
      parameters:
        mode: active-backup
        primary: ens3f0
        mii-monitor-interval: 100ms
        up-delay: 200ms
        down-delay: 200ms
        fail-over-mac-policy: active
        gratuitious-arp: 5
      dhcp4: false
      addresses:
        - 10.10.1.50/24
      routes:
        - to: default
          via: 10.10.1.1
          metric: 100
      nameservers:
        addresses:
          - 10.10.1.2
          - 10.10.1.3
        search:
          - prod.example.com
```

### LACP Bond with Netplan

```yaml
# /etc/netplan/01-bond0-lacp.yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    ens3f0:
      dhcp4: false
      dhcp6: false
    ens3f1:
      dhcp4: false
      dhcp6: false
  bonds:
    bond0:
      interfaces:
        - ens3f0
        - ens3f1
      parameters:
        mode: 802.3ad
        lacp-rate: fast
        mii-monitor-interval: 100ms
        transmit-hash-policy: layer3+4
        ad-select: stable
      dhcp4: false
      addresses:
        - 10.10.1.50/24
      routes:
        - to: default
          via: 10.10.1.1
```

```bash
# Apply the netplan configuration
sudo netplan generate
sudo netplan apply

# Verify the bond
ip link show bond0
ip addr show bond0
```

## Network Bridging

### Creating a Bridge with nmcli

Bridges are used to connect physical interfaces and virtual interfaces (KVM tap devices, container veth pairs) at Layer 2:

```bash
# Create bridge interface
nmcli connection add \
  type bridge \
  con-name br0 \
  ifname br0 \
  bridge.stp no \
  bridge.forward-delay 0 \
  bridge.hello-time 2 \
  bridge.max-age 20

# Add physical interface as bridge port
nmcli connection add \
  type ethernet \
  con-name br0-port-ens3f0 \
  ifname ens3f0 \
  master br0

# Configure IP on the bridge (not the physical interface)
nmcli connection modify br0 \
  ipv4.method manual \
  ipv4.addresses 10.10.1.50/24 \
  ipv4.gateway 10.10.1.1 \
  ipv4.dns "10.10.1.2"

nmcli connection up br0
nmcli connection up br0-port-ens3f0

# Verify bridge
bridge link show
bridge fdb show dev br0
```

### Bridge over Bond (Recommended Production Pattern)

For KVM hypervisors and Kubernetes nodes, the recommended pattern is bond + bridge:

```bash
# Step 1: Create the bond
nmcli connection add \
  type bond \
  con-name bond0 \
  ifname bond0 \
  bond.options "mode=active-backup,miimon=100,updelay=200,downdelay=200"

nmcli connection add type ethernet \
  con-name bond0-slave-ens3f0 \
  ifname ens3f0 \
  master bond0

nmcli connection add type ethernet \
  con-name bond0-slave-ens3f1 \
  ifname ens3f1 \
  master bond0

# Step 2: Create the bridge using the bond as its port
nmcli connection add \
  type bridge \
  con-name br0 \
  ifname br0 \
  bridge.stp no \
  bridge.forward-delay 0

# Add bond as bridge port (bond has no IP)
nmcli connection modify bond0 \
  master br0 \
  slave-type bridge \
  ipv4.method disabled \
  ipv6.method disabled

# Configure IP on bridge
nmcli connection modify br0 \
  ipv4.method manual \
  ipv4.addresses 10.10.1.50/24 \
  ipv4.gateway 10.10.1.1 \
  ipv4.dns "10.10.1.2,10.10.1.3"

# Bring up in order: slaves -> bond -> bridge
nmcli connection up bond0-slave-ens3f0
nmcli connection up bond0-slave-ens3f1
nmcli connection up bond0
nmcli connection up br0

# Verify
bridge link show
cat /proc/net/bonding/bond0
```

## VLAN Trunking over Bonds

Enterprise environments require VLAN segmentation over the same physical bond for management, storage, and application traffic:

### nmcli VLAN Configuration

```bash
# Bond exists as bond0 (no IP - trunk interface)
# Create VLAN interfaces on top of the bond

# Management VLAN 100
nmcli connection add \
  type vlan \
  con-name bond0.100 \
  ifname bond0.100 \
  vlan.parent bond0 \
  vlan.id 100 \
  ipv4.method manual \
  ipv4.addresses 10.100.1.50/24 \
  ipv4.gateway 10.100.1.1

# Storage VLAN 200
nmcli connection add \
  type vlan \
  con-name bond0.200 \
  ifname bond0.200 \
  vlan.parent bond0 \
  vlan.id 200 \
  ipv4.method manual \
  ipv4.addresses 10.200.1.50/24

# Application VLAN 300
nmcli connection add \
  type vlan \
  con-name bond0.300 \
  ifname bond0.300 \
  vlan.parent bond0 \
  vlan.id 300 \
  ipv4.method manual \
  ipv4.addresses 10.300.1.50/24

nmcli connection up bond0.100
nmcli connection up bond0.200
nmcli connection up bond0.300

# Verify VLAN interfaces
ip -d link show bond0.100
# 5: bond0.100@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue
#     link/ether 00:1a:4b:12:34:56 brd ff:ff:ff:ff:ff:ff
#     vlan protocol 802.1Q id 100 <REORDER_HDR>
```

### Netplan VLAN over Bond

```yaml
# /etc/netplan/01-vlan-bond.yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    ens3f0:
      dhcp4: false
    ens3f1:
      dhcp4: false
  bonds:
    bond0:
      interfaces:
        - ens3f0
        - ens3f1
      parameters:
        mode: active-backup
        mii-monitor-interval: 100ms
      dhcp4: false
  vlans:
    bond0.100:
      id: 100
      link: bond0
      addresses:
        - 10.100.1.50/24
      routes:
        - to: default
          via: 10.100.1.1
    bond0.200:
      id: 200
      link: bond0
      addresses:
        - 10.200.1.50/24
    bond0.300:
      id: 300
      link: bond0
      addresses:
        - 10.300.1.50/24
```

## Kubernetes Node Network Configuration

### Kubernetes with Bridge-on-Bond

Kubernetes nodes typically use a bridge for pod networking (when using kubenet or bridge CNI) and a direct bond for cluster traffic:

```bash
# Example for a Kubernetes node with:
# - bond0: Management + Kubernetes API traffic (10.10.1.x)
# - bond1: Pod network traffic (10.20.0.x)
# - br-pods: Bridge for pod veth pairs

# Management bond (active-backup)
nmcli connection add type bond con-name bond0 ifname bond0 \
  bond.options "mode=active-backup,miimon=100"
nmcli connection add type ethernet con-name bond0-s0 ifname ens3f0 master bond0
nmcli connection add type ethernet con-name bond0-s1 ifname ens3f1 master bond0
nmcli connection modify bond0 \
  ipv4.method manual \
  ipv4.addresses 10.10.1.100/24 \
  ipv4.gateway 10.10.1.1

# Pod network bond (LACP for throughput)
nmcli connection add type bond con-name bond1 ifname bond1 \
  bond.options "mode=802.3ad,miimon=100,xmit_hash_policy=layer3+4"
nmcli connection add type ethernet con-name bond1-s0 ifname ens4f0 master bond1
nmcli connection add type ethernet con-name bond1-s1 ifname ens4f1 master bond1

# Bridge for pod traffic
nmcli connection add type bridge con-name br-pods ifname br-pods \
  bridge.stp no \
  bridge.forward-delay 0
nmcli connection modify bond1 master br-pods slave-type bridge \
  ipv4.method disabled

nmcli connection modify br-pods \
  ipv4.method manual \
  ipv4.addresses 10.20.0.1/16

# Bring everything up
for conn in bond0-s0 bond0-s1 bond0 bond1-s0 bond1-s1 bond1 br-pods; do
  nmcli connection up $conn
done
```

### Cilium CNI Node Configuration

When using Cilium, the node configuration typically does not use a bridge. Cilium uses eBPF to manage packet routing:

```bash
# Cilium prefers a flat L3 configuration with direct routing
# Configure node IP on bond0
nmcli connection modify bond0 \
  ipv4.method manual \
  ipv4.addresses 10.10.1.100/24 \
  ipv4.gateway 10.10.1.1

# Ensure ip_forward is enabled
echo "net.ipv4.ip_forward = 1" | sudo tee /etc/sysctl.d/99-k8s-networking.conf
echo "net.ipv6.conf.all.forwarding = 1" >> /etc/sysctl.d/99-k8s-networking.conf
echo "net.bridge.bridge-nf-call-iptables = 1" >> /etc/sysctl.d/99-k8s-networking.conf
sudo sysctl --system

# Required kernel modules for Cilium
modprobe overlay
modprobe br_netfilter
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
```

## Network Failover Testing

### Simulating NIC Failure

```bash
# Identify the current active slave
cat /proc/net/bonding/bond0 | grep "Currently Active Slave"

# Simulate NIC failure by bringing down the active slave
sudo ip link set ens3f0 down
# OR
sudo nmcli device disconnect ens3f0

# Immediately check failover happened
cat /proc/net/bonding/bond0 | grep "Currently Active Slave"
# Should now show ens3f1

# Verify network connectivity during failover
ping -c 100 -i 0.1 10.10.1.1 &
PING_PID=$!

# Bring down primary while ping is running
sleep 2 && sudo ip link set ens3f0 down

# Wait for failover and restore
sleep 5 && sudo ip link set ens3f0 up

wait $PING_PID
# Check for packet loss in ping output
```

### Automated Failover Testing Script

```bash
#!/bin/bash
# bond-failover-test.sh
# Tests bonding failover behavior

set -euo pipefail

BOND_INTERFACE="${1:-bond0}"
GATEWAY="${2:-10.10.1.1}"
TEST_DURATION=30  # seconds
PING_INTERVAL=0.2

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

get_active_slave() {
    grep "Currently Active Slave" /proc/net/bonding/${BOND_INTERFACE} \
        | awk '{print $NF}'
}

get_slaves() {
    grep "Slave Interface:" /proc/net/bonding/${BOND_INTERFACE} \
        | awk '{print $NF}'
}

# Start continuous ping
log "Starting ping to $GATEWAY"
ping -i $PING_INTERVAL -c $((TEST_DURATION * 5)) $GATEWAY \
    > /tmp/bond-test-ping.log 2>&1 &
PING_PID=$!

log "Initial active slave: $(get_active_slave)"
log "All slaves: $(get_slaves | tr '\n' ' ')"

# Fail over each slave in turn
for slave in $(get_slaves); do
    active=$(get_active_slave)
    if [ "$slave" = "$active" ]; then
        log "Bringing down active slave: $slave"
        ip link set "$slave" down
        sleep 2
        log "New active slave: $(get_active_slave)"
        sleep 3
        log "Restoring slave: $slave"
        ip link set "$slave" up
        sleep 3
    fi
done

wait $PING_PID || true

# Parse ping results
TRANSMITTED=$(grep -oP '\d+ packets transmitted' /tmp/bond-test-ping.log | grep -oP '\d+')
RECEIVED=$(grep -oP '\d+ received' /tmp/bond-test-ping.log | grep -oP '\d+')
LOST=$((TRANSMITTED - RECEIVED))
LOSS_PCT=$(echo "scale=1; $LOST * 100 / $TRANSMITTED" | bc)

log "Ping results: $TRANSMITTED transmitted, $RECEIVED received, $LOST lost ($LOSS_PCT% loss)"

if (( $(echo "$LOSS_PCT > 5" | bc -l) )); then
    log "FAIL: Packet loss $LOSS_PCT% exceeds 5% threshold"
    exit 1
else
    log "PASS: Packet loss $LOSS_PCT% within acceptable threshold"
fi
```

## Performance Tuning

### Ring Buffer and Interrupt Coalescing

```bash
# Check current ring buffer sizes
ethtool -g ens3f0

# Set maximum ring buffers
sudo ethtool -G ens3f0 rx 4096 tx 4096
sudo ethtool -G ens3f1 rx 4096 tx 4096

# Configure interrupt coalescing for throughput vs latency
# For throughput (bulk data transfer):
sudo ethtool -C ens3f0 adaptive-rx on adaptive-tx on

# For low latency (finance, real-time):
sudo ethtool -C ens3f0 \
  rx-usecs 50 \
  rx-frames 8 \
  tx-usecs 50 \
  tx-frames 8 \
  adaptive-rx off \
  adaptive-tx off

# Enable hardware offloading
sudo ethtool -K ens3f0 \
  rx on \
  tx on \
  gso on \
  gro on \
  tso on \
  lro off  # LRO can cause issues in virtualized environments
```

### CPU Affinity for Network Interrupts

```bash
# Check IRQ numbers for NICs
grep ens3f0 /proc/interrupts | awk '{print $1}' | tr -d ':'

# View current IRQ affinity
for irq in $(grep ens3f0 /proc/interrupts | awk '{print $1}' | tr -d ':'); do
  echo -n "IRQ $irq: "
  cat /proc/irq/$irq/smp_affinity_list
done

# Set IRQ affinity to specific CPUs (pin NIC interrupts to NUMA node 0)
for irq in $(grep ens3f0 /proc/interrupts | awk '{print $1}' | tr -d ':'); do
  echo "0-7" | sudo tee /proc/irq/$irq/smp_affinity_list
done

# Use irqbalance for automatic IRQ distribution (simpler but less control)
sudo systemctl enable --now irqbalance
```

### MTU Configuration for High-Throughput

```bash
# Enable jumbo frames (9000 MTU) for storage and high-throughput networks
sudo ip link set ens3f0 mtu 9000
sudo ip link set ens3f1 mtu 9000

# Set MTU on bond and bridge
sudo ip link set bond0 mtu 9000
sudo ip link set br0 mtu 9000

# Persist via nmcli
nmcli connection modify bond0-slave-ens3f0 ethernet.mtu 9000
nmcli connection modify bond0-slave-ens3f1 ethernet.mtu 9000
nmcli connection modify bond0 ethernet.mtu 9000

# Verify MTU propagation
ip link show | grep mtu
```

## Persistent Configuration Validation

```bash
# Test that configuration persists after reboot
# Validate network configuration syntax
nmcli connection verify all

# Check connections will autoconnect
nmcli -f NAME,AUTOCONNECT,AUTOCONNECT-PRIORITY connection show

# Verify network readiness target dependency
systemctl cat network-online.target

# Check networkd state (Ubuntu/systemd-networkd)
networkctl status --all

# RHEL/Rocky - check NetworkManager
nmcli -f DEVICE,TYPE,STATE,CONNECTION device status
```

## Troubleshooting

### Diagnosing Bonding Issues

```bash
# Check for LACP negotiation issues
cat /proc/net/bonding/bond0 | grep -E "Aggregator|LACP|Partner"

# Monitor bond events in real time
journalctl -f -u NetworkManager | grep -i "bond\|slave\|failover"

# Check ethtool for link status
for slave in ens3f0 ens3f1; do
  echo "=== $slave ==="
  ethtool $slave | grep -E "Speed|Duplex|Link"
done

# Check for LACP PDU transmission
tcpdump -i ens3f0 -nn 'ether proto 0x8809' -v

# Verify bonding module options
cat /sys/class/net/bond0/bonding/mode
cat /sys/class/net/bond0/bonding/miimon
cat /sys/class/net/bond0/bonding/slaves
cat /sys/class/net/bond0/bonding/active_slave
```

### Bridge Troubleshooting

```bash
# Show bridge topology
bridge -d link show
bridge -d fdb show

# Show bridge STP state
bridge -d -j link show | python3 -m json.tool

# Check bridge statistics
ip -s link show br0

# Monitor bridge forwarding database
watch -n1 'bridge fdb show | head -30'

# Capture bridge traffic for debugging
tcpdump -i br0 -nn -v 'not arp' host 10.10.1.100
```

## Summary

Linux bonding and bridging are the foundation of enterprise node networking. Active-backup bonding provides simple failover without switch coordination, while LACP (802.3ad) delivers both redundancy and aggregate bandwidth when paired with LACP-capable switches. The bridge-over-bond pattern is the standard configuration for KVM hypervisors and Kubernetes nodes that need to share physical interfaces between the host and guest workloads. VLAN trunking over bonds enables traffic segmentation without additional physical interfaces. Systematic failover testing with controlled packet loss measurement validates that the configuration meets availability SLAs before systems are placed in production.
