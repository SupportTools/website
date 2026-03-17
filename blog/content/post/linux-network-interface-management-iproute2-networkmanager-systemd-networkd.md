---
title: "Linux Network Interface Management: ip command, NetworkManager, systemd-networkd Advanced Config"
date: 2030-05-12T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "iproute2", "NetworkManager", "systemd-networkd", "VLAN", "Bonding", "LACP"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux network interface management: advanced iproute2 configuration, NetworkManager profiles for workstations, systemd-networkd for servers, VLAN tagging, bonding and LACP, and network namespace usage."
more_link: "yes"
url: "/linux-network-interface-management-iproute2-networkmanager-systemd-networkd/"
---

Linux provides three primary network configuration stacks: the `ip` command suite from iproute2 for direct kernel configuration, NetworkManager for desktop and laptop environments with dynamic connectivity, and systemd-networkd for server environments requiring declarative, boot-time configuration. Each has its appropriate domain, and many production servers use all three in combination — systemd-networkd for static infrastructure, NetworkManager for management network interfaces, and `ip` commands for transient debugging.

This guide covers the complete network interface lifecycle: physical interface configuration, VLAN tagging, bonding and LACP for redundancy and throughput, network namespaces for isolation, and the trade-offs between management approaches.

<!--more-->

## iproute2: The Foundation

### Interface State Management

```bash
# Show all interfaces with state
ip link show
ip link show dev eth0  # Single interface

# Show with statistics
ip -s link show dev eth0

# Enable/disable interface
ip link set eth0 up
ip link set eth0 down

# Set MTU (Maximum Transmission Unit)
ip link set eth0 mtu 9000    # Jumbo frames for storage/HPC networks
ip link set eth0 mtu 1500    # Standard Ethernet

# Set interface flags
ip link set eth0 promisc on   # Enable promiscuous mode (packet capture)
ip link set eth0 promisc off

# Rename interface (requires interface to be down)
ip link set eth0 down
ip link set eth0 name wan0
ip link set wan0 up

# Set hardware address
ip link set eth0 address 02:00:00:00:00:01

# Show interface with detailed information
ip -d link show eth0
# -d flag shows driver information, bonding mode, VLAN filtering, etc.
```

### IP Address Management

```bash
# Show all IP addresses
ip addr show
ip addr show dev eth0
ip -4 addr show  # IPv4 only
ip -6 addr show  # IPv6 only

# Add IP address (primary)
ip addr add 192.168.1.100/24 dev eth0

# Add secondary IP address (multiple IPs on one interface)
ip addr add 192.168.1.101/24 dev eth0 label eth0:1
ip addr add 10.0.0.1/8 dev eth0 label eth0:2

# Add IP with broadcast address explicitly
ip addr add 192.168.1.100/24 brd 192.168.1.255 dev eth0

# Add IPv6 address
ip addr add 2001:db8::1/64 dev eth0

# Remove IP address
ip addr del 192.168.1.100/24 dev eth0

# Flush all addresses from an interface
ip addr flush dev eth0

# Show address with scope
ip addr show scope global  # Only globally-routable addresses
ip addr show scope link    # Only link-local addresses
```

### Routing Table Management

```bash
# Show routing table
ip route show
ip route show table main   # Explicit main table
ip route show table local  # Local addresses (managed by kernel)
ip route show table all    # All routing tables

# Show route for a specific destination
ip route get 8.8.8.8
# Returns: 8.8.8.8 via 192.168.1.1 dev eth0 src 192.168.1.100 uid 0
#          cache

# Add default route
ip route add default via 192.168.1.1 dev eth0

# Add specific route
ip route add 10.0.0.0/8 via 192.168.1.1 dev eth0
ip route add 172.16.0.0/12 via 10.10.1.1 dev eth1

# Add route with metric (lower = preferred)
ip route add default via 192.168.1.1 dev eth0 metric 100
ip route add default via 192.168.2.1 dev eth1 metric 200  # Failover route

# Delete route
ip route del default via 192.168.1.1
ip route del 10.0.0.0/8

# Replace route (atomic replace - avoids brief route absence)
ip route replace 10.0.0.0/8 via 10.10.1.1 dev eth1

# Policy-based routing: route based on source address
# Add routing table for specific traffic
echo "200 mgmt" >> /etc/iproute2/rt_tables
ip route add default via 10.1.0.1 table mgmt
ip route add 10.1.0.0/24 dev eth1 table mgmt
# Add rule: traffic from 10.1.0.x uses the mgmt table
ip rule add from 10.1.0.0/24 table mgmt priority 100
```

### Network Namespace Operations

```bash
# Create a network namespace
ip netns add blue
ip netns add red

# List namespaces
ip netns list

# Execute command in namespace
ip netns exec blue ip link show
ip netns exec blue ip addr show

# Move interface into namespace
ip link set eth1 netns blue

# Configure interface inside namespace
ip netns exec blue ip link set eth1 up
ip netns exec blue ip addr add 10.10.0.1/24 dev eth1
ip netns exec blue ip route add default via 10.10.0.254

# Create a veth pair connecting two namespaces
ip link add veth-blue type veth peer name veth-red

ip link set veth-blue netns blue
ip link set veth-red netns red

ip netns exec blue ip addr add 192.168.100.1/30 dev veth-blue
ip netns exec blue ip link set veth-blue up
ip netns exec red ip addr add 192.168.100.2/30 dev veth-red
ip netns exec red ip link set veth-red up

# Ping across namespaces
ip netns exec blue ping -c 3 192.168.100.2

# Delete namespace (also removes all interfaces in it)
ip netns del blue
ip netns del red
```

## VLAN Configuration

### 802.1Q VLAN Tagging

```bash
# Method 1: ip link (iproute2) - preferred for temporary config
# Load 8021q kernel module
modprobe 8021q
echo "8021q" >> /etc/modules-load.d/network.conf

# Create VLAN interface on physical interface
ip link add link eth0 name eth0.100 type vlan id 100
ip link add link eth0 name eth0.200 type vlan id 200

# Configure VLAN interfaces
ip link set eth0.100 up
ip addr add 10.10.100.1/24 dev eth0.100

ip link set eth0.200 up
ip addr add 10.10.200.1/24 dev eth0.200

# Verify VLAN configuration
ip -d link show eth0.100
# eth0.100@eth0: <BROADCAST,MULTICAST,UP,LOWER_UP>
#     link/ether 00:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff promiscuity 0
#     vlan protocol 802.1Q id 100 <REORDER_HDR>

# VLAN filtering on bridge (for virtualization hosts)
ip link add name br0 type bridge
ip link set br0 type bridge vlan_filtering 1

ip link set eth0 master br0
bridge vlan add vid 100 dev eth0 tagged
bridge vlan add vid 200 dev eth0 tagged

# Show bridge VLAN information
bridge vlan show
```

### systemd-networkd VLAN Configuration

```ini
# /etc/systemd/network/10-eth0.network
[Match]
Name=eth0

[Network]
# Trunk port: carries tagged traffic for multiple VLANs
VLAN=vlan100
VLAN=vlan200
VLAN=vlan300
```

```ini
# /etc/systemd/network/20-vlan100.netdev
[NetDev]
Name=vlan100
Kind=vlan

[VLAN]
Id=100
```

```ini
# /etc/systemd/network/20-vlan100.network
[Match]
Name=vlan100

[Network]
Address=10.10.100.1/24
Gateway=10.10.100.254
DNS=10.10.100.53

[Link]
MTUBytes=1500
```

```ini
# /etc/systemd/network/20-vlan200.netdev
[NetDev]
Name=vlan200
Kind=vlan

[VLAN]
Id=200
```

```ini
# /etc/systemd/network/20-vlan200.network
[Match]
Name=vlan200

[Network]
Address=10.10.200.1/24
# This VLAN has no gateway - host-only network
```

## Network Bonding and LACP

### Bonding Modes

```
Mode 0 (balance-rr): Round-robin packet distribution
  - Fault tolerance: YES (failover on port failure)
  - Load balancing: YES (packet-level across all slaves)
  - Requires switch: No special config needed
  - Use case: Simple multi-path with any switch

Mode 1 (active-backup): One active, others standby
  - Fault tolerance: YES
  - Load balancing: NO (only one interface active)
  - Requires switch: No special config needed
  - Use case: High availability without switch coordination

Mode 2 (balance-xor): XOR of source/dest MAC for distribution
  - Fault tolerance: YES
  - Load balancing: YES (flow-level)
  - Requires switch: No special config needed
  - Use case: Better than round-robin for connection-oriented traffic

Mode 3 (broadcast): All packets sent on all interfaces
  - Fault tolerance: YES
  - Load balancing: NO (duplicates traffic)
  - Use case: Rarely useful; fault tolerance in some storage protocols

Mode 4 (802.3ad LACP): Link Aggregation Control Protocol
  - Fault tolerance: YES
  - Load balancing: YES (flow-level with switch coordination)
  - Requires switch: YES - switch must support LACP (802.3ad)
  - Use case: Enterprise servers with managed switches

Mode 5 (balance-tlb): Adaptive transmit load balancing
  - Fault tolerance: YES
  - Load balancing: TX only
  - Requires switch: No
  - Use case: When switch doesn't support LACP

Mode 6 (balance-alb): Adaptive load balancing (TX + RX)
  - Fault tolerance: YES
  - Load balancing: TX and RX
  - Requires switch: No
  - Use case: Maximum throughput without switch LACP support
```

### LACP (802.3ad) Bonding Setup

```bash
# Method 1: Manual configuration with ip commands
# Load bonding module with LACP mode
modprobe bonding mode=4 miimon=100 lacp_rate=fast xmit_hash_policy=layer3+4

# Create bond interface
ip link add bond0 type bond

# Configure bond options
echo 4 > /sys/class/net/bond0/bonding/mode               # 802.3ad (LACP)
echo 100 > /sys/class/net/bond0/bonding/miimon           # 100ms link check
echo fast > /sys/class/net/bond0/bonding/lacp_rate        # Fast LACP PDU exchange
echo layer3+4 > /sys/class/net/bond0/bonding/xmit_hash_policy  # Use IP:port for hashing

# Bring down physical interfaces before bonding
ip link set eth0 down
ip link set eth1 down

# Remove existing IP addresses
ip addr flush dev eth0
ip addr flush dev eth1

# Add interfaces as bond slaves
ip link set eth0 master bond0
ip link set eth1 master bond0

# Bring up everything
ip link set eth0 up
ip link set eth1 up
ip link set bond0 up

# Assign IP to bond
ip addr add 192.168.1.100/24 dev bond0
ip route add default via 192.168.1.1 dev bond0

# Verify bond status
cat /proc/net/bonding/bond0
```

### systemd-networkd LACP Bonding

```ini
# /etc/systemd/network/10-bond0.netdev
[NetDev]
Name=bond0
Kind=bond

[Bond]
Mode=802.3ad
TransmitHashPolicy=layer3+4
MIIMonitorSec=100ms
LACPTransmitRate=fast
# Minimum number of active links before bond is considered down
MinLinks=1
```

```ini
# /etc/systemd/network/20-bond0.network
[Match]
Name=bond0

[Network]
Address=192.168.1.100/24
Gateway=192.168.1.1
DNS=8.8.8.8
DNS=8.8.4.4

[Link]
MTUBytes=9000
```

```ini
# /etc/systemd/network/30-eth0-bond.network
[Match]
Name=eth0
# Match by MAC address to avoid interface renaming issues
# MACAddress=00:11:22:33:44:55

[Network]
Bond=bond0
```

```ini
# /etc/systemd/network/30-eth1-bond.network
[Match]
Name=eth1

[Network]
Bond=bond0
```

```bash
# Apply and verify
networkctl reload
networkctl status bond0

# Check LACP negotiation status
cat /proc/net/bonding/bond0
# Bonding Mode: IEEE 802.3ad Dynamic link aggregation
# Transmit Hash Policy: layer3+4 (1)
# MII Status: up
# MII Polling Interval (ms): 100
# Up Delay (ms): 0
# Down Delay (ms): 0
# 802.3ad info
# LACP rate: fast
# Active Aggregator Info:
#         Aggregator ID: 1
#         Number of ports: 2
#         Actor Key: 15
#         Partner Key: 100
#         Partner Mac Address: aa:bb:cc:dd:ee:ff
# Slave Interface: eth0
#         MII Status: up
#         Speed: 10000 Mbps
#         Duplex: full
#         Link Failure Count: 0
#         Aggregator ID: 1
#         Actor Churn State: none
#         Partner Churn State: none
# Slave Interface: eth1
#         MII Status: up
#         Speed: 10000 Mbps
#         Duplex: full
#         Link Failure Count: 0
#         Aggregator ID: 1
```

## NetworkManager for Desktop/Workstation

### nmcli Command Reference

```bash
# Show all connections
nmcli connection show
nmcli con show --active   # Only active connections

# Show device status
nmcli device status
nmcli device show eth0    # Detailed device info

# Create a new connection profile
nmcli connection add \
    type ethernet \
    con-name "office-static" \
    ifname eth0 \
    ipv4.method manual \
    ipv4.addresses "192.168.1.100/24" \
    ipv4.gateway "192.168.1.1" \
    ipv4.dns "8.8.8.8,8.8.4.4" \
    ipv6.method ignore

# Modify an existing connection
nmcli connection modify "office-static" \
    ipv4.dns "192.168.1.53,8.8.8.8"

# Add a secondary IP address to a connection
nmcli connection modify "office-static" \
    +ipv4.addresses "192.168.1.101/24"

# Activate a connection
nmcli connection up "office-static"
nmcli connection down "office-static"

# Delete a connection
nmcli connection delete "office-static"

# Create VLAN connection
nmcli connection add \
    type vlan \
    con-name "vlan100" \
    ifname vlan100 \
    vlan.parent eth0 \
    vlan.id 100 \
    ipv4.method manual \
    ipv4.addresses "10.10.100.50/24"

# Create bond with LACP
nmcli connection add \
    type bond \
    con-name "bond0" \
    ifname bond0 \
    bond.options "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=layer3+4"

# Add slave interfaces to bond
nmcli connection add \
    type ethernet \
    con-name "bond0-slave-eth0" \
    ifname eth0 \
    master bond0

nmcli connection add \
    type ethernet \
    con-name "bond0-slave-eth1" \
    ifname eth1 \
    master bond0

# Activate bond (activates slaves too)
nmcli connection up "bond0"
```

### NetworkManager Dispatcher Scripts

Dispatcher scripts run when network events occur:

```bash
# /etc/NetworkManager/dispatcher.d/50-routing
#!/bin/bash
# Run when interface comes up: add policy routing

INTERFACE="$1"
STATUS="$2"

case "$STATUS" in
    up)
        if [ "$INTERFACE" = "eth1" ]; then
            # Add management network routing table
            ip route add 10.1.0.0/24 dev eth1 table mgmt
            ip route add default via 10.1.0.1 table mgmt
            ip rule add from 10.1.0.0/24 table mgmt priority 100
        fi
        ;;
    down)
        if [ "$INTERFACE" = "eth1" ]; then
            ip rule del from 10.1.0.0/24 table mgmt 2>/dev/null || true
        fi
        ;;
esac

chmod 755 /etc/NetworkManager/dispatcher.d/50-routing
```

## systemd-networkd: Server Configuration

### Complete Server Network Stack

```ini
# /etc/systemd/network/10-physical.network
# Configure the physical interface as a trunk port
[Match]
Name=ens3
Type=ether

[Network]
# Don't configure the physical interface directly
# It carries tagged VLAN traffic
LinkLocalAddressing=no
VLAN=vlan10
VLAN=vlan20
VLAN=vlan100

[Link]
MTUBytes=9000
```

```ini
# /etc/systemd/network/20-vlan10.netdev
[NetDev]
Name=vlan10
Kind=vlan

[VLAN]
Id=10
```

```ini
# /etc/systemd/network/20-vlan10.network
[Match]
Name=vlan10

[Network]
# Production application VLAN - static IP
Address=10.10.10.100/24
Gateway=10.10.10.1

[Route]
# Specific routes for this VLAN
Destination=172.16.0.0/12
Gateway=10.10.10.1

[DHCPv4]
UseDNS=no
UseNTP=no
UseHostname=no
```

```ini
# /etc/systemd/network/20-vlan20.network
[Match]
Name=vlan20

[Network]
# Management VLAN - DHCP
DHCP=ipv4
```

### networkctl Status and Diagnostics

```bash
# View overall network status
networkctl status
networkctl status ens3      # Single interface
networkctl status vlan10

# List all managed interfaces
networkctl list

# Reload configuration without restart
networkctl reload

# Reconfigure a specific interface
networkctl reconfigure vlan10

# View detailed configuration
networkctl cat vlan10.network

# Monitor real-time network events
networkctl monitor

# Check DNS configuration
resolvectl status

# View per-interface DNS settings
resolvectl status vlan10
```

## Advanced iproute2 Features

### Traffic Control (tc): Bandwidth Shaping

```bash
# Rate limit outbound traffic on eth0 to 100 Mbit/s
tc qdisc add dev eth0 root tbf rate 100mbit burst 32kbit latency 400ms

# Remove traffic control
tc qdisc del dev eth0 root

# View current qdisc
tc qdisc show dev eth0

# HTB (Hierarchical Token Bucket) for per-class traffic shaping
# Useful for prioritizing database traffic over backup traffic

# Create root HTB qdisc
tc qdisc add dev eth0 root handle 1: htb default 30

# Create classes:
# 1:10 - High priority (database, 40% guaranteed, up to 100%)
tc class add dev eth0 parent 1: classid 1:10 htb \
    rate 400mbit ceil 1000mbit prio 1

# 1:20 - Medium priority (application, 40% guaranteed, up to 80%)
tc class add dev eth0 parent 1: classid 1:20 htb \
    rate 400mbit ceil 800mbit prio 2

# 1:30 - Low priority (backup/bulk, 20% guaranteed, up to 40%)
tc class add dev eth0 parent 1: classid 1:30 htb \
    rate 200mbit ceil 400mbit prio 3

# Add FIFO queues to leaf classes
tc qdisc add dev eth0 parent 1:10 handle 10: sfq perturb 10
tc qdisc add dev eth0 parent 1:20 handle 20: sfq perturb 10
tc qdisc add dev eth0 parent 1:30 handle 30: sfq perturb 10

# Add filters to classify traffic
# PostgreSQL traffic (port 5432) -> high priority class
tc filter add dev eth0 protocol ip parent 1:0 prio 1 \
    u32 match ip dport 5432 0xffff flowid 1:10

# Application traffic (ports 8080-8090) -> medium priority
tc filter add dev eth0 protocol ip parent 1:0 prio 2 \
    u32 match ip dport 8080 0xfff0 flowid 1:20

# Everything else -> low priority (default class 30)
```

### Network Interface Monitoring

```bash
# Real-time interface statistics
watch -n 1 'ip -s link show eth0'

# Continuous monitoring with ss (replacement for netstat)
# Show all TCP connections
ss -tunap

# Show listening sockets with process
ss -tlnp

# Show connections to specific port
ss -tnp dst :5432

# Show socket statistics
ss -s

# Monitor with nstat (kernel network statistics)
nstat -a  # All statistics
nstat -z  # Include zero-value statistics

# Watch network statistics in real time
watch -n 1 'nstat -n && nstat'

# Capture packets with tcpdump
tcpdump -i eth0 -n -s 0 port 5432
tcpdump -i bond0 -n -w /tmp/capture.pcap 'host 10.10.10.50'

# Analyze with tshark (terminal Wireshark)
tshark -i eth0 -f "port 5432" -T fields \
    -e ip.src -e ip.dst -e tcp.srcport -e tcp.dstport
```

## Persistent Configuration Strategies

### Choosing the Right Stack

```bash
# Decision guide for network configuration stack:

# SERVER ENVIRONMENTS (production, no human at keyboard):
# Use: systemd-networkd
# Reason: Declarative, boot-time configuration, no daemon race conditions,
#         integrates with systemd dependency ordering

# DESKTOP/LAPTOP (frequent network changes, WiFi):
# Use: NetworkManager
# Reason: Handles WiFi, VPN, hotspot, profile switching automatically

# CONTAINERS (Docker, Kubernetes nodes):
# Use: systemd-networkd for node interfaces
# Reason: Consistent with server pattern; container networks managed by runtime

# CLOUD INSTANCES:
# Use: cloud-init + systemd-networkd
# Reason: cloud-init writes networkd config based on instance metadata

# LEGACY OR MIXED:
# Use: NetworkManager (can manage networkd-configured interfaces)
# Or: /etc/network/interfaces (Debian/Ubuntu) for simple static config
```

### Disabling Conflicting Network Managers

```bash
# On servers: disable NetworkManager and use systemd-networkd exclusively

# Disable NetworkManager
systemctl disable --now NetworkManager
systemctl mask NetworkManager  # Prevent accidental startup

# Enable and start systemd-networkd
systemctl enable --now systemd-networkd

# Enable systemd-resolved for DNS
systemctl enable --now systemd-resolved

# Point /etc/resolv.conf to systemd-resolved stub resolver
ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf

# Verify
networkctl status
resolvectl status
```

## Key Takeaways

Linux network interface management is a layered system, and choosing the right tool for each layer avoids conflicts and provides predictable behavior in production.

**iproute2 `ip` commands are the authoritative interface to the kernel network stack**: `ifconfig` and `route` are deprecated. `ip` commands interact directly with the Netlink socket API and expose all kernel capabilities including policy routing, traffic control, and network namespaces.

**systemd-networkd is the correct choice for server network configuration**: Its declarative `.network` and `.netdev` file format is version-controllable, boots correctly without daemon race conditions, and integrates with systemd's service ordering. Servers should disable NetworkManager to avoid conflicts.

**LACP (mode 4 bonding) requires both kernel and switch configuration**: Linux bonding mode 4 enables 802.3ad LACP, but the switch port-channel must also be configured for LACP. The `xmit_hash_policy=layer3+4` setting distributes flows based on IP+port tuples, providing better load distribution than simple MAC-based hashing for server-to-server traffic.

**VLAN trunking separates logical networks without additional cables**: A single physical uplink can carry multiple VLANs using 802.1Q tagging. The physical interface should be configured without an IP address (as a trunk port), with IP addresses assigned to individual VLAN sub-interfaces.

**Policy-based routing enables multi-homing and traffic engineering**: `ip rule` and multiple routing tables allow different traffic flows to use different gateways. This is essential for servers with multiple network connections (e.g., a management interface and a data interface) where default route selection would otherwise send management traffic over the data path.
