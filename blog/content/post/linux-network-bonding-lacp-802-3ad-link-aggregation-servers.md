---
title: "Linux Network Bonding with LACP: 802.3ad Link Aggregation for Servers"
date: 2031-05-04T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "LACP", "Bonding", "802.3ad", "NetworkManager", "Kubernetes"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux network bonding with LACP (802.3ad mode 4): bonding driver configuration, LACP PDU negotiation, switch port configuration, bond monitoring, and Kubernetes node network bonding with NetworkManager."
more_link: "yes"
url: "/linux-network-bonding-lacp-802-3ad-link-aggregation-servers/"
---

Linux network bonding with LACP (Link Aggregation Control Protocol) provides both redundancy and increased bandwidth by combining multiple physical network interfaces into a single logical interface. Mode 4 (802.3ad) is the standard for production servers where the connected switch also supports LACP. This guide covers kernel driver configuration, switch port setup, monitoring, and Kubernetes node network bonding.

<!--more-->

# Linux Network Bonding with LACP: 802.3ad Link Aggregation for Servers

## Section 1: Bonding Driver Modes Overview

The Linux bonding driver supports seven modes. LACP (mode 4) is the correct choice for most server deployments connected to LACP-capable switches.

| Mode | Name | Description | Switch Requirement |
|------|------|-------------|-------------------|
| 0 | balance-rr | Round-robin across interfaces | None (dumb) |
| 1 | active-backup | One active, others standby | None |
| 2 | balance-xor | XOR of MAC/IP hash | None (dumb) |
| 3 | broadcast | Send all packets on all interfaces | None (dumb) |
| 4 | 802.3ad | LACP dynamic link aggregation | LACP-capable switch |
| 5 | balance-tlb | Adaptive transmit load balancing | None |
| 6 | balance-alb | Adaptive load balancing (Rx+Tx) | None |

**Mode 4 (802.3ad/LACP)** is preferred because:
- The switch and server negotiate the aggregate, preventing configuration mismatches
- The switch ensures that packets belonging to the same flow go through the same link (preventing reordering)
- Failed link detection is fast via LACP PDU timeout
- Standard-based: works across different switch vendors

**Mode 1 (active-backup)** is appropriate when the switch does not support LACP, providing only failover without bandwidth aggregation.

## Section 2: Pre-Configuration - Interface Identification

```bash
# Identify physical interfaces
ip link show
# or
ls -la /sys/class/net/

# Identify which physical ports correspond to which interface names
# Check PCI bus address for each NIC
for iface in /sys/class/net/eth*; do
  name=$(basename "$iface")
  pci=$(readlink "$iface/device" 2>/dev/null | xargs basename 2>/dev/null)
  mac=$(cat "$iface/address" 2>/dev/null)
  speed=$(cat "$iface/speed" 2>/dev/null)
  echo "$name: MAC=$mac PCI=$pci Speed=${speed}Mbps"
done

# Check link status for each interface
for iface in eth0 eth1 eth2 eth3; do
  echo "=== $iface ==="
  ethtool "$iface" | grep -E "Speed|Duplex|Link detected|Supported link"
done

# Verify driver supports bonding enslavement
ethtool -i eth0 | grep driver
ethtool -i eth1 | grep driver

# Check LACP/802.3ad frame support
ethtool -k eth0 | grep -E "tx-generic-segmentation|scatter-gather"
```

## Section 3: NetworkManager-Based Configuration (Modern Systems)

NetworkManager is the recommended method for RHEL 8+, Ubuntu 20.04+, and Kubernetes nodes.

```bash
# Method 1: Using nmcli (NetworkManager CLI)

# Create the bond interface
nmcli connection add \
  type bond \
  ifname bond0 \
  con-name bond0 \
  bond.options "\
    mode=802.3ad,\
    miimon=100,\
    lacp_rate=fast,\
    xmit_hash_policy=layer3+4,\
    ad_select=bandwidth,\
    updelay=200,\
    downdelay=200,\
    min_links=1,\
    all_slaves_active=0\
  "

# Add slave interfaces to the bond
nmcli connection add \
  type ethernet \
  ifname eth0 \
  con-name bond0-slave-eth0 \
  master bond0

nmcli connection add \
  type ethernet \
  ifname eth1 \
  con-name bond0-slave-eth1 \
  master bond0

# Configure IP address on the bond
nmcli connection modify bond0 \
  ipv4.method manual \
  ipv4.addresses "10.0.1.10/24" \
  ipv4.gateway "10.0.1.1" \
  ipv4.dns "10.0.1.2,10.0.1.3" \
  ipv4.dns-search "example.com" \
  connection.autoconnect yes \
  connection.autoconnect-priority 100

# Configure IPv6 (optional)
nmcli connection modify bond0 \
  ipv6.method auto

# Bring up the bond
nmcli connection up bond0
nmcli connection up bond0-slave-eth0
nmcli connection up bond0-slave-eth1

# Verify
nmcli device status
nmcli connection show bond0
```

### NetworkManager Keyfile Configuration (Non-interactive)

For automated deployment, write the keyfiles directly:

```ini
# /etc/NetworkManager/system-connections/bond0.nmconnection
[connection]
id=bond0
type=bond
interface-name=bond0
autoconnect=yes
autoconnect-slaves=1

[bond]
mode=802.3ad
miimon=100
lacp_rate=fast
xmit_hash_policy=layer3+4
ad_select=bandwidth
updelay=200
downdelay=200
min_links=1

[ipv4]
method=manual
addresses=10.0.1.10/24
gateway=10.0.1.1
dns=10.0.1.2;10.0.1.3
dns-search=example.com

[ipv6]
method=auto
```

```ini
# /etc/NetworkManager/system-connections/bond0-slave-eth0.nmconnection
[connection]
id=bond0-slave-eth0
type=ethernet
interface-name=eth0
autoconnect=yes
master=bond0
slave-type=bond

[ethernet]
# Optional: lock to specific speed/duplex
# speed=10000
# duplex=full
# auto-negotiate=no
```

```ini
# /etc/NetworkManager/system-connections/bond0-slave-eth1.nmconnection
[connection]
id=bond0-slave-eth1
type=ethernet
interface-name=eth1
autoconnect=yes
master=bond0
slave-type=bond
```

```bash
# Set proper permissions (required for NetworkManager to load keyfiles)
chmod 600 /etc/NetworkManager/system-connections/*.nmconnection

# Reload NetworkManager configuration
nmcli connection reload

# Alternatively (full reload)
systemctl restart NetworkManager

# Apply the connections
nmcli connection up bond0-slave-eth0
nmcli connection up bond0-slave-eth1
nmcli connection up bond0
```

## Section 4: Legacy sysconfig Configuration (RHEL 7 / CentOS 7)

```bash
# /etc/sysconfig/network-scripts/ifcfg-bond0
cat > /etc/sysconfig/network-scripts/ifcfg-bond0 << 'EOF'
DEVICE=bond0
NAME=bond0
TYPE=Bond
BONDING_MASTER=yes
BOOTPROTO=none
ONBOOT=yes
IPADDR=10.0.1.10
PREFIX=24
GATEWAY=10.0.1.1
DNS1=10.0.1.2
DNS2=10.0.1.3
BONDING_OPTS="mode=802.3ad miimon=100 lacp_rate=fast xmit_hash_policy=layer3+4 ad_select=bandwidth updelay=200 downdelay=200"
EOF

# /etc/sysconfig/network-scripts/ifcfg-eth0
cat > /etc/sysconfig/network-scripts/ifcfg-eth0 << 'EOF'
DEVICE=eth0
NAME=bond0-slave-eth0
TYPE=Ethernet
BOOTPROTO=none
ONBOOT=yes
MASTER=bond0
SLAVE=yes
EOF

# /etc/sysconfig/network-scripts/ifcfg-eth1
cat > /etc/sysconfig/network-scripts/ifcfg-eth1 << 'EOF'
DEVICE=eth1
NAME=bond0-slave-eth1
TYPE=Ethernet
BOOTPROTO=none
ONBOOT=yes
MASTER=bond0
SLAVE=yes
EOF

# Load bonding module
modprobe bonding
echo "bonding" > /etc/modules-load.d/bonding.conf

# Restart networking
systemctl restart network
```

## Section 5: LACP PDU Negotiation and Bond Options Explained

Understanding each LACP option:

```bash
# View current bond settings
cat /proc/net/bonding/bond0

# Expected output for a healthy LACP bond:
# Ethernet Channel Bonding Driver: v5.15.0-76-generic
#
# Bonding Mode: IEEE 802.3ad Dynamic link aggregation
# Transmit Hash Policy: layer3+4 (1)
# MII Status: up
# MII Polling Interval (ms): 100
# Up Delay (ms): 200
# Down Delay (ms): 200
# Peer Notification Delay (ms): 0
#
# 802.3ad info
# LACP active: on
# LACP rate: fast
# Min links: 1
# Aggregator selection policy (ad_select): bandwidth
# System priority: 65535
# System MAC address: 00:1a:4b:12:34:56
# Active Aggregator Info:
#     Aggregator ID: 1
#     Number of ports: 2
#     Actor Key: 17
#     Partner Key: 21
#     Partner Mac Address: 00:19:d1:ab:cd:ef
#
# Slave Interface: eth0
# MII Status: up
# Speed: 10000 Mbps
# Duplex: full
# Link Failure Count: 0
# Permanent HW addr: 00:1a:4b:12:34:56
# Slave queue ID: 0
# Aggregator ID: 1
# Actor Churn State: none
# Partner Churn State: none
# Actor Churned Count: 0
# Partner Churned Count: 0
# details actor lacp pdu:
#     system priority: 65535
#     system mac address: 00:1a:4b:12:34:56
#     port key: 17
#     port priority: 255
#     port number: 1
#     port state: 63
# details partner lacp pdu:
#     system priority: 32768
#     system mac address: 00:19:d1:ab:cd:ef
#     oper key: 21
#     port priority: 128
#     port number: 257
#     port state: 63
```

Key parameters explained:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `miimon` | 100ms | MII link monitoring interval. 100ms provides fast failure detection |
| `lacp_rate` | fast | Send LACP PDUs every 1 second (slow=30s). Use fast for quicker failure detection |
| `xmit_hash_policy` | layer3+4 | Hash using source/dest IP + port. Better distribution for many flows |
| `ad_select` | bandwidth | Selects aggregators with most bandwidth. `stable` and `count` are alternatives |
| `updelay` | 200ms | Delay before bringing a link up. Prevents flapping |
| `downdelay` | 200ms | Delay before marking a link down |
| `min_links` | 1 | Minimum links for bond to be considered up |

### Hash Policy Selection

```bash
# Test different hash policies and measure distribution
# layer2 - Hash on MAC addresses only (poor distribution with same MACs)
# layer2+3 - Hash on MAC + IP (good for mixed traffic)
# layer3+4 - Hash on IP + ports (best for multiple TCP flows, recommended)
# encap2+3 - Like layer2+3 but uses inner encap headers
# encap3+4 - Like layer3+4 but uses inner encap headers (for VXLAN traffic)
# vlan+srcmac - For specific switching topologies

# For Kubernetes nodes carrying VXLAN/Geneve traffic, use encap3+4:
nmcli connection modify bond0 \
  bond.options "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=encap3+4"
```

## Section 6: Partner Switch Configuration

The switch-side configuration is vendor-specific but follows the same 802.3ad concepts.

### Cisco IOS/IOS-XE

```
! Create port-channel interface
interface Port-channel1
  description bond0-server01
  switchport mode trunk
  switchport trunk allowed vlan 100,200,300
  spanning-tree portfast trunk
  ip flow ingress
  no shutdown

! Configure LACP on physical ports
interface GigabitEthernet1/0/1
  description server01-eth0
  channel-group 1 mode active
  channel-protocol lacp
  no shutdown

interface GigabitEthernet1/0/2
  description server01-eth1
  channel-group 1 mode active
  channel-protocol lacp
  no shutdown

! LACP system priority (lower = higher priority, controls which side is "active")
lacp system-priority 32768

! Per-port LACP settings
interface GigabitEthernet1/0/1
  lacp port-priority 128
  lacp timeout short  ! Matches lacp_rate=fast on Linux side

! Verify LACP negotiation
show lacp 1 internal
show lacp 1 neighbor
show etherchannel 1 summary
```

### Juniper Junos

```
# Aggregated Ethernet interface
set interfaces ae0 description "server01-bond0"
set interfaces ae0 aggregated-ether-options lacp active
set interfaces ae0 aggregated-ether-options lacp periodic fast
set interfaces ae0 aggregated-ether-options lacp system-priority 32768
set interfaces ae0 aggregated-ether-options minimum-links 1
set interfaces ae0 unit 0 family ethernet-switching interface-mode trunk
set interfaces ae0 unit 0 family ethernet-switching vlan members [vlan100 vlan200]

# Assign physical ports to the aggregated interface
set interfaces ge-0/0/1 description "server01-eth0"
set interfaces ge-0/0/1 ether-options 802.3ad ae0

set interfaces ge-0/0/2 description "server01-eth1"
set interfaces ge-0/0/2 ether-options 802.3ad ae0

# Verify
show lacp interfaces ae0
show lacp statistics interfaces ae0
show interfaces ae0 detail
```

### Arista EOS

```
! Port-channel with LACP
interface Port-Channel1
   description server01-bond0
   switchport mode trunk
   switchport trunk allowed vlan 100,200,300

! Member ports
interface Ethernet1
   description server01-eth0
   channel-group 1 mode active
   lacp timer fast

interface Ethernet2
   description server01-eth1
   channel-group 1 mode active
   lacp timer fast

! Verify
show port-channel 1 detail
show lacp peer
show lacp interface Ethernet1
```

## Section 7: Monitoring and Health Verification

```bash
#!/bin/bash
# /usr/local/bin/bond-health-check.sh
# Monitor LACP bond health

set -euo pipefail

BOND="bond0"
ALERT_EMAIL="network-alerts@example.com"
LOG_FILE="/var/log/bond-health.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

check_bond_status() {
    local bond="$1"
    local bond_file="/proc/net/bonding/$bond"

    [ -f "$bond_file" ] || { log "ERROR: Bond $bond not found"; return 1; }

    local status
    status=$(awk '/MII Status/{print $NF; exit}' "$bond_file")
    local active_slaves
    active_slaves=$(grep "MII Status: up" "$bond_file" | tail -n +2 | wc -l)
    local total_slaves
    total_slaves=$(grep -c "^Slave Interface:" "$bond_file")

    log "Bond: $bond Status: $status Active: $active_slaves/$total_slaves"

    # Check LACP negotiation
    local partner_mac
    partner_mac=$(awk '/Partner Mac Address/{print $NF}' "$bond_file")
    if [ -z "$partner_mac" ] || [ "$partner_mac" = "00:00:00:00:00:00" ]; then
        log "WARNING: No LACP partner detected for $bond"
        return 1
    fi

    log "LACP Partner MAC: $partner_mac"

    # Check active aggregator
    local num_ports
    num_ports=$(awk '/Number of ports/{print $NF}' "$bond_file")
    log "Active aggregator ports: $num_ports"

    if [ "$active_slaves" -lt "$total_slaves" ]; then
        log "WARNING: Only $active_slaves of $total_slaves slaves active"
        return 1
    fi

    # Check for churning (LACP negotiation instability)
    local actor_churn
    actor_churn=$(grep "Actor Churned Count" "$bond_file" | awk '{sum += $NF} END {print sum}')
    if [ "$actor_churn" -gt 0 ]; then
        log "WARNING: LACP actor churning detected ($actor_churn events)"
    fi

    return 0
}

check_interface_statistics() {
    local bond="$1"

    # Check for errors and drops
    local rx_errors tx_errors rx_dropped tx_dropped
    rx_errors=$(cat /sys/class/net/$bond/statistics/rx_errors 2>/dev/null || echo 0)
    tx_errors=$(cat /sys/class/net/$bond/statistics/tx_errors 2>/dev/null || echo 0)
    rx_dropped=$(cat /sys/class/net/$bond/statistics/rx_dropped 2>/dev/null || echo 0)
    tx_dropped=$(cat /sys/class/net/$bond/statistics/tx_dropped 2>/dev/null || echo 0)

    log "Stats - RX errors: $rx_errors, TX errors: $tx_errors, RX dropped: $rx_dropped, TX dropped: $tx_dropped"

    # Alert on errors
    if [ "$rx_errors" -gt 1000 ] || [ "$tx_errors" -gt 1000 ]; then
        log "ALERT: High error count on $bond"
        echo "High network errors on $bond ($(hostname)): RX=$rx_errors TX=$tx_errors" | \
            mail -s "[NETWORK ALERT] $(hostname): $bond errors" "$ALERT_EMAIL"
    fi
}

write_prometheus_metrics() {
    local bond="$1"
    local metrics_file="/var/lib/node_exporter/textfile_collector/bond.prom"

    local active_slaves
    active_slaves=$(grep "MII Status: up" "/proc/net/bonding/$bond" | tail -n +2 | wc -l)
    local total_slaves
    total_slaves=$(grep -c "^Slave Interface:" "/proc/net/bonding/$bond")
    local rx_bytes tx_bytes
    rx_bytes=$(cat /sys/class/net/$bond/statistics/rx_bytes 2>/dev/null || echo 0)
    tx_bytes=$(cat /sys/class/net/$bond/statistics/tx_bytes 2>/dev/null || echo 0)

    cat > "${metrics_file}.tmp" << EOF
# HELP network_bond_active_slaves Number of active slaves in bond
# TYPE network_bond_active_slaves gauge
network_bond_active_slaves{bond="${bond}"} ${active_slaves}

# HELP network_bond_total_slaves Total number of configured slaves in bond
# TYPE network_bond_total_slaves gauge
network_bond_total_slaves{bond="${bond}"} ${total_slaves}

# HELP network_bond_rx_bytes_total Total received bytes
# TYPE network_bond_rx_bytes_total counter
network_bond_rx_bytes_total{bond="${bond}"} ${rx_bytes}

# HELP network_bond_tx_bytes_total Total transmitted bytes
# TYPE network_bond_tx_bytes_total counter
network_bond_tx_bytes_total{bond="${bond}"} ${tx_bytes}
EOF

    mv "${metrics_file}.tmp" "$metrics_file"
}

main() {
    check_bond_status "$BOND" || true
    check_interface_statistics "$BOND"
    write_prometheus_metrics "$BOND"
}

main
```

```bash
# Install monitoring timer
cat > /etc/systemd/system/bond-monitor.timer << 'EOF'
[Unit]
Description=Bond Health Monitor Timer

[Timer]
OnCalendar=*:0/1
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/bond-monitor.service << 'EOF'
[Unit]
Description=Bond Health Monitor

[Service]
Type=oneshot
ExecStart=/usr/local/bin/bond-health-check.sh
EOF

systemctl daemon-reload
systemctl enable --now bond-monitor.timer
```

## Section 8: Namespace-Aware Bonding for Containers

Move a bond interface into a network namespace (advanced use case for container networking):

```bash
# Create network namespace
ip netns add container-ns

# Create veth pair
ip link add veth0 type veth peer name veth1

# Move one end to the namespace
ip link set veth1 netns container-ns

# Configure the host end (connect to bond via bridge)
ip link set veth0 master bond0-bridge up

# Configure the namespace end
ip netns exec container-ns ip addr add 192.168.100.2/24 dev veth1
ip netns exec container-ns ip link set veth1 up
ip netns exec container-ns ip route add default via 192.168.100.1

# Verify
ip netns exec container-ns ip addr show
ip netns exec container-ns ping 10.0.1.1

# Create a bridge on top of bond0 for VM/container traffic
ip link add name br0 type bridge
ip link set bond0 master br0
ip link set br0 up
ip addr del 10.0.1.10/24 dev bond0
ip addr add 10.0.1.10/24 dev br0
ip route add default via 10.0.1.1 dev br0
```

## Section 9: Kubernetes Node Network Bonding

Configure bonding on Kubernetes worker nodes. The bond must be configured before kubelet starts:

### Using NetworkManager (Recommended for RHEL/Rocky)

```bash
# On the node before joining the cluster
# Configure the bond as described in Section 3

# Verify bond is working
ip addr show bond0
ping -I bond0 -c 3 10.0.1.1

# Verify LACP is negotiated
cat /proc/net/bonding/bond0 | grep -A5 "802.3ad info"

# Ensure NetworkManager manages the interface
nmcli device status

# The bond interface will be used for Kubernetes traffic
# kubelet will bind to the bond's IP address
```

### Using Netplan (Ubuntu)

```yaml
# /etc/netplan/00-network-manager-all.yaml
# OR for server installations:
# /etc/netplan/00-installer-config.yaml

network:
  version: 2
  renderer: networkd  # Use networkd for server deployments
  ethernets:
    eth0:
      dhcp4: false
      dhcp6: false
    eth1:
      dhcp4: false
      dhcp6: false

  bonds:
    bond0:
      interfaces:
        - eth0
        - eth1
      addresses:
        - 10.0.1.10/24
      routes:
        - to: default
          via: 10.0.1.1
      nameservers:
        addresses: [10.0.1.2, 10.0.1.3]
        search: [example.com]
      parameters:
        mode: 802.3ad
        mii-monitor-interval: 100ms
        lacp-rate: fast
        transmit-hash-policy: layer3+4
        ad-select: bandwidth
        up-delay: 200ms
        down-delay: 200ms
        min-links: 1
      dhcp4: false
      dhcp6: false
```

```bash
# Apply netplan configuration
netplan apply

# Verify
networkctl status bond0
ip addr show bond0

# Check LACP
cat /proc/net/bonding/bond0
```

### Kubernetes NetworkManager nmstate Configuration

For declarative node network configuration in Kubernetes, use the NMState operator:

```yaml
# node-network-state.yaml (NMState operator CRD)
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: worker-bond0-policy
spec:
  nodeSelector:
    kubernetes.io/role: worker
  desiredState:
    interfaces:
      - name: bond0
        type: bond
        state: up
        ipv4:
          enabled: true
          dhcp: false
          address:
            - ip: 10.0.1.10
              prefix-length: 24
        ipv6:
          enabled: false
        link-aggregation:
          mode: 802.3ad
          options:
            miimon: "100"
            lacp_rate: fast
            xmit_hash_policy: layer3+4
            ad_select: bandwidth
            updelay: "200"
            downdelay: "200"
            min_links: "1"
          port:
            - eth0
            - eth1

      - name: eth0
        type: ethernet
        state: up

      - name: eth1
        type: ethernet
        state: up

    routes:
      config:
        - destination: 0.0.0.0/0
          next-hop-address: 10.0.1.1
          next-hop-interface: bond0
          table-id: 254
```

## Section 10: Troubleshooting LACP Issues

```bash
# Check if LACP PDUs are being sent/received
tcpdump -i eth0 -nn 'ether proto 0x8809' -c 10

# Verify LACP state machine
cat /proc/net/bonding/bond0 | grep -A10 "details actor lacp pdu"

# LACP port state bits:
# Bit 0: LACP activity (1=active)
# Bit 1: LACP timeout (1=short/fast, 0=long/slow)
# Bit 2: Aggregation (1=can aggregate)
# Bit 3: Synchronization (1=in sync with partner)
# Bit 4: Collecting (1=collecting frames)
# Bit 5: Distributing (1=distributing frames)
# Bit 6: Defaulted (1=using default partner info)
# Bit 7: Expired (1=LACP expired)
# State 0x3f = 0011 1111 = fully operational

# Check for LACP churn (unstable negotiation)
cat /proc/net/bonding/bond0 | grep -E "Churned Count|Churn State"

# Common issues:

# Issue 1: No LACP partner (switch not configured)
# Partner Mac Address: 00:00:00:00:00:00
# Solution: Verify switch port-channel configuration

# Issue 2: Mismatched LACP rate
# Actor PDUs showing rate=slow but Linux configured fast
# Solution: Match lacp_rate on both ends

# Issue 3: Wrong xmit_hash_policy for traffic type
# Bond shows both links up but only one carries traffic
# Solution: Check hash policy matches traffic patterns

# Issue 4: Bond interface not getting packets on all slaves
# Check packet distribution:
watch -n 1 'for iface in eth0 eth1; do
  rx=$(cat /sys/class/net/$iface/statistics/rx_packets)
  tx=$(cat /sys/class/net/$iface/statistics/tx_packets)
  echo "$iface: RX=$rx TX=$tx"
done'

# Issue 5: Kernel module not loaded
lsmod | grep bonding
modprobe bonding
# Add to modules for auto-load:
echo bonding >> /etc/modules-load.d/bonding.conf

# Check system logs for bonding events
journalctl -k --no-pager | grep -i bond | tail -20

# Force LACP renegotiation
echo "down" > /sys/class/net/eth0/bonding_slave/state
sleep 1
echo "up" > /sys/class/net/eth0/bonding_slave/state

# View ARP monitoring (alternative to MII, useful for switches without MII)
# Configure arp_interval instead of miimon:
# arp_interval=100
# arp_ip_target=10.0.1.1  (gateway or other reliable host)
```

## Section 11: Performance Tuning

```bash
# Optimize bond for 10GbE/25GbE performance
# Increase ring buffer sizes on member interfaces
for iface in eth0 eth1; do
  # Show current settings
  ethtool -g $iface

  # Maximize ring buffers
  ethtool -G $iface rx 4096 tx 4096 || true

  # Enable interrupt coalescing (reduce CPU interrupts at cost of latency)
  ethtool -C $iface rx-usecs 50 tx-usecs 50 || true

  # Enable LRO if supported
  ethtool -K $iface lro on 2>/dev/null || true

  # Enable GRO (usually already on)
  ethtool -K $iface gro on || true
done

# Increase network stack buffer sizes
cat >> /etc/sysctl.conf << 'EOF'
# Network bonding performance tuning
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216
net.ipv4.tcp_rmem = 4096 87380 268435456
net.ipv4.tcp_wmem = 4096 65536 268435456
net.core.netdev_max_backlog = 30000
net.core.netdev_budget = 600
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq
EOF

sysctl -p

# Set CPU affinity for network interrupts (reduce IRQ migration)
# Find IRQ numbers for the NICs
grep eth0 /proc/interrupts | awk '{print $1}' | tr -d ':'
grep eth1 /proc/interrupts | awk '{print $1}' | tr -d ':'

# Pin eth0 IRQs to CPU 0-3, eth1 IRQs to CPU 4-7
# Using irqbalance with NUMA awareness
systemctl enable --now irqbalance
```

## Section 12: Testing Failover

```bash
# Test failover while running continuous traffic
# Start background ping
ping 10.0.1.1 -i 0.1 -W 1 &
PING_PID=$!

# Test 1: Remove a slave
echo "Removing eth1 from bond..."
ip link set eth1 nomaster
sleep 3
echo "Bond state after removing eth1:"
cat /proc/net/bonding/bond0 | grep -E "MII Status|Active Slave"

# Restore
echo "Restoring eth1..."
ip link set eth1 master bond0
sleep 3

# Test 2: Simulate link failure
echo "Simulating eth0 link failure..."
ip link set eth0 down
sleep 3
echo "Bond state after eth0 down:"
cat /proc/net/bonding/bond0 | grep -E "MII Status|Active Slave"

# Restore
ip link set eth0 up
sleep 3

# Check ping results
kill $PING_PID 2>/dev/null || true

# Verify no traffic loss during failover (should see at most 1-2 dropped pings)
# If updelay/downdelay is 200ms and miimon is 100ms, max failover time is ~300ms
```

## Summary

Production Linux LACP bonding requires:

1. **Mode 4 (802.3ad)** with LACP-capable switch - provides both redundancy and bandwidth aggregation
2. **`miimon=100` with `lacp_rate=fast`** - 100ms polling with 1-second LACP PDUs for fast failure detection
3. **`xmit_hash_policy=layer3+4`** - best traffic distribution for IP+port flows; use `encap3+4` for VXLAN
4. **`updelay=200,downdelay=200`** - prevents link flapping while still failing quickly
5. **NetworkManager keyfiles** for declarative, reproducible configuration on modern distributions
6. **NMState operator** for GitOps-managed Kubernetes node network configuration
7. **Continuous monitoring** via `/proc/net/bonding` and Prometheus textfile metrics
8. **Partner switch configuration** must match: LACP active mode, fast timers, same port-channel

The most common production failure is mismatched LACP rates between the server and switch. Always verify `lacp_rate=fast` on the Linux side matches `lacp timer fast` (Cisco) or `lacp periodic fast` (Juniper) on the switch.
