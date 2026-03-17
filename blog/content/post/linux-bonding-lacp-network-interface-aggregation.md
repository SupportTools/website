---
title: "Linux Bonding and LACP: Network Interface Aggregation"
date: 2029-10-21T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Bonding", "LACP", "High Availability", "Network Performance"]
categories: ["Linux", "Networking", "System Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux network interface bonding modes including active-backup, 802.3ad LACP, and balance-alb/tlb, with LACP negotiation details, transmit hash policies, and failover detection tuning for production servers."
more_link: "yes"
url: "/linux-bonding-lacp-network-interface-aggregation/"
---

A server with a single network interface has a single point of failure and a fixed bandwidth ceiling. Linux bonding aggregates multiple physical interfaces into a single logical interface, providing either redundancy, increased throughput, or both — depending on the bonding mode. Understanding which mode to use, how LACP negotiation works, and how to tune failover detection separates a robust network configuration from one that causes outages during routine maintenance.

<!--more-->

# Linux Bonding and LACP: Network Interface Aggregation

## Section 1: Bonding Architecture Overview

The Linux bonding driver creates a virtual interface (bond0, bond1, etc.) that presents a single MAC address and IP to the rest of the system. The driver manages traffic distribution and failover across the underlying slave (member) interfaces according to the configured mode.

```
Application / IP Stack
        │
    bond0 (virtual interface)
   ┌─────┴─────┐
  eth0        eth1
(physical)  (physical)
```

The bonding driver intercepts all packets sent to bond0 and decides which physical interface to transmit on. For incoming traffic, any slave can receive packets destined for bond0's MAC address.

### Installing and Loading the Bonding Driver

```bash
# Load the bonding kernel module
modprobe bonding

# Verify it's loaded
lsmod | grep bonding
# bonding               196608  0

# Make it persistent
echo "bonding" >> /etc/modules-load.d/bonding.conf

# Check available bonding modes
modinfo bonding | grep mode
# parm: mode: Mode of operation; 0 for balance-rr...
```

## Section 2: Bonding Modes Reference

Linux bonding supports seven modes. Each has different requirements, behaviors, and trade-offs.

| Mode | Name | Switch Required | Throughput | Failover |
|---|---|---|---|---|
| 0 | balance-rr | None | Up to N×bandwidth | Yes |
| 1 | active-backup | None | 1× bandwidth | Yes |
| 2 | balance-xor | Yes (static LAG) | Up to N×bandwidth | Yes |
| 3 | broadcast | None | N× redundancy (waste) | Yes |
| 4 | 802.3ad (LACP) | LACP-capable | Up to N×bandwidth | Yes |
| 5 | balance-tlb | None | Up to N×bandwidth (TX) | Yes |
| 6 | balance-alb | None | Up to N×bandwidth (TX+RX) | Yes |

### Mode 0: balance-rr (Round Robin)

Transmits packets sequentially on each slave. Simple but problematic: packets from the same flow may arrive out of order because they travel through different physical paths with different latencies.

```
Flow 1 packet 1 → eth0
Flow 1 packet 2 → eth1  ← arrives after packet 3 if eth1 is slower
Flow 1 packet 3 → eth0
```

TCP handles reordering via its sequence number mechanism, but excessive reordering triggers spurious retransmits and throughput collapse. balance-rr is rarely appropriate for TCP traffic.

### Mode 1: active-backup

Only one slave is active at a time. The other slaves are standby. On slave failure, a standby slave takes over. The bond MAC address does not change on failover, so upstream switches do not need reconfiguration.

This is the simplest and most universally compatible mode. Use it when you need redundancy but not increased bandwidth.

### Mode 4: 802.3ad (LACP)

The only mode defined by an IEEE standard. Requires switch support for LACP (Link Aggregation Control Protocol, 802.1ax). Both endpoints (server and switch) negotiate which ports to aggregate and can detect failures automatically.

### Modes 5 and 6: Adaptive Load Balancing

These modes do not require switch configuration. Mode 5 (balance-tlb) distributes outbound traffic across slaves based on load. Mode 6 (balance-alb) adds inbound load balancing using ARP negotiation to distribute the MAC address across slaves.

## Section 3: Configuring active-backup with NetworkManager

```bash
# Using nmcli to create a bond in active-backup mode
nmcli connection add type bond con-name bond0 ifname bond0 \
    bond.options "mode=active-backup,miimon=100,fail_over_mac=active"

# Add slave interfaces
nmcli connection add type ethernet con-name bond0-slave1 ifname eth0 \
    master bond0

nmcli connection add type ethernet con-name bond0-slave2 ifname eth1 \
    master bond0

# Assign IP to the bond
nmcli connection modify bond0 ipv4.method manual \
    ipv4.addresses "192.168.1.10/24" \
    ipv4.gateway "192.168.1.1" \
    ipv4.dns "8.8.8.8"

# Bring up the bond
nmcli connection up bond0
```

### Verifying active-backup Operation

```bash
# Check bond status
cat /proc/net/bonding/bond0
# Ethernet Channel Bonding Driver: v3.7.1
#
# Bonding Mode: fault-tolerance (active-backup)
# Primary Slave: eth0 (primary_reselect failure)
# Currently Active Slave: eth0
# MII Status: up
# MII Polling Interval (ms): 100
# Up Delay (ms): 200
# Down Delay (ms): 200
#
# Slave Interface: eth0
# MII Status: up
# Speed: 1000 Mbps
# Duplex: full
# Link Failure Count: 0
# Permanent HW addr: aa:bb:cc:dd:ee:01
# Slave queue ID: 0
#
# Slave Interface: eth1
# MII Status: up
# Speed: 1000 Mbps
# Duplex: full
# Link Failure Count: 0
# Permanent HW addr: aa:bb:cc:dd:ee:02
# Slave queue ID: 0

# Monitor for failover events
journalctl -f -u NetworkManager | grep -i bond
# Or watch kernel messages
dmesg -w | grep bond0
```

## Section 4: 802.3ad LACP Configuration

LACP is the preferred mode for production servers where switch support is available. It provides standardized link aggregation with automatic negotiation.

### How LACP Works

LACP uses Link Aggregation Control Protocol Data Units (LACPDUs) exchanged between the server and switch every second (fast) or every 30 seconds (slow). Each LACPDU contains:
- System priority
- System ID (MAC address)
- Port priority
- Port number
- Actor state (activity, timeout, aggregation, synchronization, collecting, distributing)

Both ends negotiate which ports to aggregate into a Link Aggregation Group (LAG). Ports with matching aggregation keys are bundled together.

```
Server (Actor)                    Switch (Partner)
┌─────────────┐                   ┌─────────────────┐
│ eth0 ─────────── LACPDU ──────── Port 1/1         │
│ eth1 ─────────── LACPDU ──────── Port 1/2         │
│ bond0                           Port-channel 10   │
│ (802.3ad)                       (Po10)            │
└─────────────┘                   └─────────────────┘
```

### Configuring LACP on the Server

```bash
# Using systemd-networkd (recommended for servers without a desktop)
cat > /etc/systemd/network/20-bond0.netdev << 'EOF'
[NetDev]
Name=bond0
Kind=bond

[Bond]
Mode=802.3ad
LACPTransmitRate=fast
TransmitHashPolicy=layer3+4
MIIMonitorSec=100ms
UpDelaySec=200ms
DownDelaySec=200ms
AdSelect=bandwidth
MinLinks=1
EOF

cat > /etc/systemd/network/21-bond0-eth0.network << 'EOF'
[Match]
Name=eth0

[Network]
Bond=bond0
EOF

cat > /etc/systemd/network/21-bond0-eth1.network << 'EOF'
[Match]
Name=eth1

[Network]
Bond=bond0
EOF

cat > /etc/systemd/network/22-bond0.network << 'EOF'
[Match]
Name=bond0

[Network]
DHCP=no
Address=192.168.1.10/24
Gateway=192.168.1.1
DNS=8.8.8.8
EOF

systemctl restart systemd-networkd
```

### Verifying LACP Negotiation

```bash
# Check LACP partner information
cat /proc/net/bonding/bond0
# Bonding Mode: IEEE 802.3ad Dynamic link aggregation
# Transmit Hash Policy: layer3+4 (1)
# MII Status: up
# MII Polling Interval (ms): 100
# Up Delay (ms): 200
# Down Delay (ms): 200
# 802.3ad info
# LACP rate: fast
# Min links: 0
# Aggregator selection policy (ad_select): bandwidth
# System priority: 65535
# System MAC address: aa:bb:cc:dd:ee:01
# Active Aggregator Info:
#         Aggregator ID: 1
#         Number of ports: 2
#         Actor Key: 15
#         Partner Key: 500
#         Partner Mac Address: 00:1a:2b:3c:4d:5e
#
# Slave Interface: eth0
# MII Status: up
# LACP PDUs tx: 1842
# LACP PDUs rx: 1841
# aggregator ID: 1
# actor/partner churn state: none

# Monitor LACP PDU counters
watch -n 1 'cat /proc/net/bonding/bond0 | grep -A2 "LACP PDUs"'
```

### Switch Configuration (Cisco IOS Example)

```
! Configure LACP on the switch side
interface GigabitEthernet1/0/1
 channel-group 10 mode active
 channel-protocol lacp
!
interface GigabitEthernet1/0/2
 channel-group 10 mode active
 channel-protocol lacp
!
interface Port-channel10
 description bond0 on server-prod-01
 switchport mode trunk
 switchport trunk allowed vlan 100,200
```

## Section 5: Transmit Hash Policies

The transmit hash policy determines how traffic is distributed across slaves. This applies to modes 2, 4, 5, and 6.

### layer2 (Default)

Uses source and destination MAC addresses. All traffic from the same source MAC to the same destination MAC goes through the same slave. This limits parallelism to the number of unique MAC pairs.

```
XOR(src_mac XOR dst_mac) modulo num_slaves
```

### layer3+4 (Recommended for Most Workloads)

Uses source/destination IPs and ports. Different connections between the same two hosts (different port numbers) may use different slaves, providing better distribution.

```
XOR(src_ip XOR dst_ip XOR src_port XOR dst_port) modulo num_slaves
```

This is the most common choice for 802.3ad and provides good distribution for multi-connection workloads.

### layer2+3

A compromise between layer2 and layer3+4, using both MAC addresses and IP addresses without port numbers.

```
XOR(src_mac XOR dst_mac XOR src_ip XOR dst_ip) modulo num_slaves
```

### encap2+3 and encap3+4

These policies inspect the inner headers of encapsulated traffic (VXLAN, GRE). Critical for Kubernetes nodes using overlay networking — without these policies, all VXLAN traffic appears as one flow (same outer src/dst) and only uses one slave.

```bash
# For a Kubernetes node with VXLAN overlay traffic
ip link set bond0 type bond xmit_hash_policy encap3+4

# Or in configuration
echo "encap3+4" > /sys/class/net/bond0/bonding/xmit_hash_policy
```

### Verifying Hash Distribution

```bash
# Check current hash policy
cat /sys/class/net/bond0/bonding/xmit_hash_policy

# Monitor per-slave traffic to assess distribution
watch -n 1 'cat /proc/net/dev | grep -E "eth0|eth1"'

# For more detailed per-slave statistics
ethtool -S eth0 | grep -E "rx_packets|tx_packets"
ethtool -S eth1 | grep -E "rx_packets|tx_packets"
```

## Section 6: Failover Detection Tuning

How quickly bonding detects a link failure determines how long traffic is disrupted during a failure event.

### MII Monitoring

MII (Media Independent Interface) monitoring checks the link state by polling the NIC's register. It is fast and does not generate network traffic.

```bash
# Set MII monitoring interval to 100ms (check every 100ms)
# up_delay: wait 200ms before considering a recovered link as up
# down_delay: wait 200ms before marking a link as down (avoids flapping)
cat > /etc/modprobe.d/bonding.conf << 'EOF'
options bonding miimon=100 updelay=200 downdelay=200
EOF
```

The default MII interval is 0 (disabled). Always set `miimon` explicitly. A value of 100ms provides detection within ~100ms with minimal CPU overhead.

### ARP Monitoring

ARP monitoring sends ARP requests to target IPs and checks for responses. It detects network connectivity problems that MII monitoring cannot see (e.g., the cable is plugged in but the upstream switch port is disabled).

```bash
# Use ARP monitoring instead of MII
ip link set bond0 type bond arp_interval 1000 arp_ip_target 192.168.1.1

# Or in modprobe configuration
options bonding arp_interval=1000 arp_ip_target=192.168.1.1
```

Avoid using ARP monitoring with LACP (mode 4). LACP has its own keepalive mechanism and ARP monitoring can interfere with it. Use MII monitoring with LACP.

### Combining MII and ARP Monitoring

You cannot use both simultaneously. Choose based on your failure scenarios:
- **MII only**: Detects physical link failures quickly. Misses logical failures (e.g., switch drops traffic but link is up).
- **ARP only**: Detects network-level failures. Slower and generates traffic.
- **MII + switch portfast**: The recommended combination for most enterprise environments.

### Failover Test Procedure

```bash
# Test failover without bringing down the interface
# Method 1: Bring down a slave
ip link set eth0 down

# Check that bond switches active slave
cat /proc/net/bonding/bond0 | grep "Currently Active"

# Verify traffic continues (ping from another host to the bond IP)
ping 192.168.1.10

# Restore the slave
ip link set eth0 up

# Method 2: Unplug the cable (if physically accessible)
# The bond should detect the link down within miimon milliseconds

# Method 3: Simulate failure with tc (traffic control)
tc qdisc add dev eth0 root netem loss 100%   # 100% packet loss
sleep 10
tc qdisc del dev eth0 root
```

## Section 7: balance-alb and balance-tlb Deep Dive

These modes are unique because they provide load balancing without requiring switch configuration, using client-specific techniques instead.

### balance-tlb (Adaptive Transmit Load Balancing)

Each slave transmits based on the current load (bytes/second). The slave with the lowest load gets the next outbound flow. Incoming traffic is received only on the active slave.

```
Server (TX distribution):         Remote Host
eth0 (40% load) ──── flow 1 ────→  X.X.X.X
eth1 (60% load) ──── flow 2 ────→  X.X.X.X
eth1 (60% load) ──── flow 3 ────→  X.X.X.X

All incoming traffic:
eth0 (active MAC) ← all RX ──────  X.X.X.X
```

### balance-alb (Adaptive Load Balancing)

Extends balance-tlb by also distributing incoming traffic. It uses ARP replies to tell different remote hosts to send to different slave MAC addresses.

```
ARP reply to host A: "My MAC is aa:bb:cc:dd:ee:01 (eth0)"
ARP reply to host B: "My MAC is aa:bb:cc:dd:ee:02 (eth1)"

Server (TX+RX distribution):
eth0 ←──── traffic from host A ────→  Host A (ARP told it eth0 MAC)
eth1 ←──── traffic from host B ────→  Host B (ARP told it eth1 MAC)
```

### Configuring balance-alb

```bash
ip link add bond0 type bond mode 6
ip link set eth0 master bond0
ip link set eth1 master bond0
ip addr add 192.168.1.10/24 dev bond0
ip link set bond0 up

# balance-alb specific options
echo 100 > /sys/class/net/bond0/bonding/miimon
echo 0 > /sys/class/net/bond0/bonding/arp_interval  # Use MII, not ARP
```

### balance-alb Limitations

- The ARP-based RX distribution only works for IPv4. IPv6 traffic always uses one slave.
- Some managed switches detect the "MAC flapping" (same IP with different MACs responding) and disable the ports.
- Remote hosts cache ARP entries and may continue sending to the old MAC for several minutes after a slave failure.

## Section 8: Systemd-networkd Production Configuration

```ini
# /etc/systemd/network/10-bond0.netdev
[NetDev]
Name=bond0
Kind=bond

[Bond]
Mode=802.3ad
LACPTransmitRate=fast
TransmitHashPolicy=layer3+4
MIIMonitorSec=100ms
UpDelaySec=0
DownDelaySec=0
AdSelect=bandwidth
MinLinks=1
```

```ini
# /etc/systemd/network/11-bond-slaves.network
# Apply to both physical interfaces
[Match]
Name=eth0
Name=eth1

[Network]
Bond=bond0
```

```ini
# /etc/systemd/network/12-bond0-ip.network
[Match]
Name=bond0

[Network]
DHCP=no
LinkLocalAddressing=no

[Address]
Address=10.0.0.10/24
Peer=10.0.0.1

[Route]
Gateway=10.0.0.1
Metric=100

[LLDP]
Emit=yes
Accept=yes
```

## Section 9: Monitoring and Alerting

```bash
# Script to monitor bond health and alert on degraded state
#!/bin/bash
BOND=bond0
BOND_FILE="/proc/net/bonding/${BOND}"
ALERT_THRESHOLD=1  # Alert if fewer than this many slaves are up

if [ ! -f "${BOND_FILE}" ]; then
    echo "CRITICAL: Bond ${BOND} does not exist"
    exit 2
fi

ACTIVE_SLAVES=$(grep -c "MII Status: up" "${BOND_FILE}")
TOTAL_SLAVES=$(grep -c "Slave Interface:" "${BOND_FILE}")
CURRENTLY_ACTIVE=$(grep "Currently Active Slave:" "${BOND_FILE}" | awk '{print $NF}')

if [ "${ACTIVE_SLAVES}" -lt "${THRESHOLD:-2}" ]; then
    echo "WARNING: Bond ${BOND} has only ${ACTIVE_SLAVES}/${TOTAL_SLAVES} slaves up (active: ${CURRENTLY_ACTIVE})"
    exit 1
fi

echo "OK: Bond ${BOND} has ${ACTIVE_SLAVES}/${TOTAL_SLAVES} slaves up (active: ${CURRENTLY_ACTIVE})"
exit 0
```

### Prometheus Metrics for Bonding

```bash
# node_exporter automatically exports bond metrics when the bonding module is loaded
# Key metrics:
# node_network_carrier{device="bond0"} 1  (link carrier up)
# node_network_transmit_packets_total{device="eth0"}
# node_network_transmit_packets_total{device="eth1"}

# Check balance: TX packets should be roughly equal on both slaves for 802.3ad
promql: rate(node_network_transmit_bytes_total{device=~"eth[01]"}[5m])
```

## Section 10: Troubleshooting Common Issues

### LACP Not Forming Aggregation

```bash
# Check if LACP PDUs are being sent and received
cat /proc/net/bonding/bond0 | grep "LACP PDUs"
# Slave Interface: eth0
# LACP PDUs tx: 0    ← PDUs not being sent means LACP disabled locally
# LACP PDUs rx: 100  ← PDUs received means switch is sending

# If tx is 0, check bond mode
cat /sys/class/net/bond0/bonding/mode
# Should be "802.3ad 4"

# Check switch side for any LACP errors
# Cisco: show lacp counters
# Arista: show lacp counters
```

### ARP Table Issues with balance-alb

```bash
# Remote hosts stuck sending to wrong MAC
# Force ARP re-learning on remote hosts
arping -U -I bond0 192.168.1.10

# Check which MAC addresses are being advertised
tcpdump -i eth0 arp
tcpdump -i eth1 arp
```

### Bonding Not Distributing Traffic

```bash
# Verify hash policy is appropriate for your traffic
cat /sys/class/net/bond0/bonding/xmit_hash_policy

# Check if traffic is all one flow (single connection won't span slaves)
ss -s  # Connection summary

# For Kubernetes nodes, use encap3+4 for VXLAN traffic
echo "encap3+4" > /sys/class/net/bond0/bonding/xmit_hash_policy
```

Bonding configuration is one of those areas where a small mistake — wrong hash policy, missing LACP on the switch, incorrect MII timing — can cause subtle issues that only appear under load or during failure scenarios. Testing failover explicitly during maintenance windows, before production traffic depends on it, is essential to building confidence in your configuration.
