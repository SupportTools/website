---
title: "Linux Bonding and Team Drivers: Network Redundancy and Link Aggregation"
date: 2030-12-19T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Bonding", "LACP", "Link Aggregation", "Network Redundancy", "SystemD", "NetworkManager"]
categories:
- Linux
- Networking
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Linux network bonding and team drivers: bonding modes (active-backup, LACP/802.3ad, balance-rr), team driver comparison, configuration via NetworkManager and systemd-networkd, LACP switch negotiation, MTU considerations, and systematic failover testing procedures."
more_link: "yes"
url: "/linux-bonding-team-drivers-network-redundancy-link-aggregation/"
---

Network bonding is a foundational technique for eliminating single points of failure in server networking. A single NIC failure should be invisible to applications — bonding makes that possible. This guide covers every bonding mode from simple active-backup to LACP with balanced hashing, the newer team driver alternative, and production configuration patterns for both NetworkManager and systemd-networkd environments.

<!--more-->

# Linux Bonding and Team Drivers: Network Redundancy and Link Aggregation

## Section 1: Bonding Modes Overview

Linux bonding supports seven modes, each with different trade-offs between redundancy, throughput, and switch requirements:

| Mode | Name | Description | Switch Requirement | Failover |
|------|------|-------------|-------------------|---------|
| 0 | balance-rr | Round-robin TX across all slaves | None (but misorders packets) | Yes |
| 1 | active-backup | One active, others standby | None | Yes |
| 2 | balance-xor | XOR-based TX distribution | None | Yes |
| 3 | broadcast | Transmit on all interfaces | None | Yes (lossy) |
| 4 | 802.3ad (LACP) | IEEE 802.3ad dynamic negotiation | LACP capable | Yes |
| 5 | balance-tlb | Adaptive TX load balancing | None | Yes |
| 6 | balance-alb | Adaptive TX+RX load balancing | None | Yes |

### When to Use Each Mode

- **Mode 1 (active-backup)**: Default choice when you cannot configure the switch. Simple, reliable, 100% bandwidth of one link available.
- **Mode 4 (802.3ad/LACP)**: Best for high-throughput servers with LACP-capable switches. Provides both redundancy and aggregated bandwidth.
- **Mode 6 (balance-alb)**: When switch doesn't support LACP but you want both TX and RX load balancing without special switch configuration.
- **Mode 5 (balance-tlb)**: Like balance-alb but RX goes through whichever interface the remote chose.

## Section 2: Kernel Bonding Driver Setup

### Loading the Bond Module

```bash
# Load bonding module with parameters
modprobe bonding mode=4 miimon=100 lacp_rate=fast

# Verify module loaded
lsmod | grep bonding
# bonding               212992  0

# Check bonding parameters
cat /sys/class/net/bond0/bonding/mode 2>/dev/null || echo "Not yet configured"

# Make module loading persistent
cat > /etc/modprobe.d/bonding.conf << 'EOF'
# Load bonding driver
options bonding mode=4 miimon=100 lacp_rate=fast xmit_hash_policy=layer3+4
alias bond0 bonding
EOF
```

## Section 3: NetworkManager Configuration

NetworkManager is the standard for RHEL/CentOS/Rocky/Ubuntu desktop and server configurations.

### LACP Bond (Mode 4) with NetworkManager

```bash
# Create the bond master interface
nmcli connection add \
    type bond \
    con-name bond0 \
    ifname bond0 \
    bond.options "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=layer3+4"

# Set IP on the bond
nmcli connection modify bond0 \
    ipv4.addresses "192.168.1.10/24" \
    ipv4.gateway "192.168.1.1" \
    ipv4.dns "192.168.1.1,8.8.8.8" \
    ipv4.method manual \
    ipv6.method disabled

# Add the first physical interface as a slave
nmcli connection add \
    type ethernet \
    con-name bond0-slave-eth0 \
    ifname eth0 \
    master bond0

# Add the second physical interface as a slave
nmcli connection add \
    type ethernet \
    con-name bond0-slave-eth1 \
    ifname eth1 \
    master bond0

# Bring up the bond
nmcli connection up bond0
nmcli connection up bond0-slave-eth0
nmcli connection up bond0-slave-eth1

# Verify
nmcli device status
cat /proc/net/bonding/bond0
```

### Active-Backup Bond (Mode 1) with NetworkManager

```bash
# Primary-backup configuration
nmcli connection add \
    type bond \
    con-name bond-mgmt \
    ifname bond-mgmt \
    bond.options "mode=active-backup,miimon=100,primary=eth0,primary_reselect=always,fail_over_mac=active"

nmcli connection modify bond-mgmt \
    ipv4.addresses "10.0.0.10/24" \
    ipv4.gateway "10.0.0.1" \
    ipv4.method manual

nmcli connection add type ethernet con-name bond-mgmt-eth0 ifname eth0 master bond-mgmt
nmcli connection add type ethernet con-name bond-mgmt-eth1 ifname eth1 master bond-mgmt

nmcli connection up bond-mgmt
```

### NetworkManager Connection Files

For infrastructure-as-code and reproducibility, use connection files directly:

```ini
# /etc/NetworkManager/system-connections/bond0.nmconnection
[connection]
id=bond0
uuid=a1b2c3d4-e5f6-7890-abcd-ef1234567890
type=bond
interface-name=bond0
autoconnect=yes
autoconnect-slaves=1

[bond]
mode=802.3ad
miimon=100
lacp_rate=fast
xmit_hash_policy=layer3+4
# Minimum active links before degraded
min_links=1

[ipv4]
method=manual
address1=192.168.1.10/24,192.168.1.1
dns=192.168.1.1;8.8.8.8;
dns-search=example.com

[ipv6]
method=disabled
```

```ini
# /etc/NetworkManager/system-connections/bond0-slave-eth0.nmconnection
[connection]
id=bond0-slave-eth0
uuid=b2c3d4e5-f6a7-8901-bcde-f12345678901
type=ethernet
interface-name=eth0
autoconnect=yes
master=bond0
slave-type=bond

[ethernet]
mtu=9000  # Jumbo frames if needed
```

```ini
# /etc/NetworkManager/system-connections/bond0-slave-eth1.nmconnection
[connection]
id=bond0-slave-eth1
uuid=c3d4e5f6-a7b8-9012-cdef-123456789012
type=ethernet
interface-name=eth1
autoconnect=yes
master=bond0
slave-type=bond

[ethernet]
mtu=9000
```

```bash
# Apply the connection files
chmod 600 /etc/NetworkManager/system-connections/*.nmconnection
nmcli connection reload
nmcli connection up bond0
```

## Section 4: systemd-networkd Configuration

systemd-networkd is preferred for minimal server installations and containers.

### LACP Bond with systemd-networkd

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
AdSelect=bandwidth
# Minimum number of active member links
MinLinks=1
# Immediately reselect if primary comes back
PrimaryReselectPolicy=always
```

```ini
# /etc/systemd/network/10-bond0.network
[Match]
Name=bond0

[Network]
Address=192.168.1.10/24
Gateway=192.168.1.1
DNS=192.168.1.1
DNS=8.8.8.8
Domains=example.com
IPv6AcceptRA=no

[Route]
Destination=0.0.0.0/0
Gateway=192.168.1.1
Metric=100
```

```ini
# /etc/systemd/network/20-eth0.network
[Match]
Name=eth0
# Match by MAC address for stability across reboots
# MACAddress=00:11:22:33:44:55

[Network]
Bond=bond0
# MTU=9000
```

```ini
# /etc/systemd/network/20-eth1.network
[Match]
Name=eth1

[Network]
Bond=bond0
```

```bash
# Enable and start networkd
systemctl enable --now systemd-networkd

# Verify bond status
networkctl status bond0
networkctl list

# Check LACP negotiation
cat /proc/net/bonding/bond0
```

### VLAN over Bond with systemd-networkd

```ini
# /etc/systemd/network/30-bond0.100.netdev
[NetDev]
Name=bond0.100
Kind=vlan

[VLAN]
Id=100
```

```ini
# /etc/systemd/network/30-bond0.100.network
[Match]
Name=bond0.100

[Network]
Address=10.100.0.10/24
Gateway=10.100.0.1
```

```ini
# Update bond0.network to reference the VLAN
# /etc/systemd/network/10-bond0.network
[Match]
Name=bond0

[Network]
# No IP on the bond itself — only on VLANs
VLAN=bond0.100
VLAN=bond0.200
LinkLocalAddressing=no
```

## Section 5: Team Driver — The Modern Alternative

The `team` driver is the successor to `bonding`. It provides the same functionality but with a more modular architecture and better monitoring capabilities. The `teamd` daemon manages team interfaces, and `teamnl` is the CLI.

### When to Use Team vs Bond

| Feature | bonding | team |
|---------|---------|------|
| Kernel module | Yes (built-in) | Yes (kernel net_team) |
| Userspace daemon | No | Yes (teamd required) |
| JSON configuration | No | Yes |
| Custom runners | No | Yes |
| NS-aware | Limited | Yes |
| DPDK support | Limited | Better |

For most enterprise deployments, bonding is simpler and more battle-tested. Team is preferred when you need dynamic runner configuration or custom link-watching logic.

### Installing and Configuring teamd

```bash
# Install teamd
dnf install -y teamd NetworkManager-team  # RHEL family
apt-get install -y libteam-utils          # Debian family

# Create team interface with LACP
nmcli connection add \
    type team \
    con-name team0 \
    ifname team0 \
    team.config '{
        "runner": {
            "name": "lacp",
            "active": true,
            "fast_rate": true,
            "tx_hash": ["eth", "ipv4", "ipv6", "tcp", "udp"]
        },
        "link_watch": {
            "name": "ethtool",
            "delay_up": 2500,
            "delay_down": 1000
        }
    }'

nmcli connection modify team0 \
    ipv4.method manual \
    ipv4.addresses "192.168.1.10/24" \
    ipv4.gateway "192.168.1.1"

# Add ports
nmcli connection add \
    type team-slave \
    con-name team0-eth0 \
    ifname eth0 \
    master team0

nmcli connection add \
    type team-slave \
    con-name team0-eth1 \
    ifname eth1 \
    master team0

nmcli connection up team0
```

### Team Status Monitoring

```bash
# Check team state
teamdctl team0 state

# Expected output:
# setup:
#   runner: lacp
# ports:
#   eth0
#     link watches:
#       link watch 0:
#         name:   ethtool
#         up:     true
#         down count: 0
#     runner:
#       selected: true
#       state: current
#       aggregator ID: 1
#   eth1
#     link watches:
#       link watch 0:
#         name:   ethtool
#         up:     true
#         down count: 0
#     runner:
#       selected: true
#       state: current
#       aggregator ID: 1

# View JSON config
teamdctl team0 config dump

# Monitor state changes
teamdctl team0 state item set eth0.runner.enabled false
```

## Section 6: LACP Switch Configuration

LACP requires matching configuration on both the Linux host and the switch. Here's the configuration for common switches:

### Cisco Catalyst (IOS)

```cisco
! Create a port-channel
interface Port-channel1
 description Linux LACP Bond - server01
 switchport trunk encapsulation dot1q
 switchport mode trunk
 switchport trunk allowed vlan 100,200,300
 spanning-tree portfast trunk

! Configure LACP on member ports
interface GigabitEthernet1/0/1
 description server01-eth0
 switchport trunk encapsulation dot1q
 switchport mode trunk
 switchport trunk allowed vlan 100,200,300
 channel-group 1 mode active
 spanning-tree portfast trunk
 no shutdown

interface GigabitEthernet1/0/2
 description server01-eth1
 switchport trunk encapsulation dot1q
 switchport mode trunk
 switchport trunk allowed vlan 100,200,300
 channel-group 1 mode active
 spanning-tree portfast trunk
 no shutdown

! Verify LACP negotiation
show lacp neighbor
show etherchannel summary
show interfaces port-channel1
```

### Aruba/HPE ProCurve

```
! Create trunk group
trunk eth A1,A2 trk1 LACP

! Configure LACP on member ports
int eth A1
  name "server01-eth0"
  lacp active
  lacp timeout short

int eth A2
  name "server01-eth1"
  lacp active
  lacp timeout short

show lacp
show trunks
```

### Juniper EX Series (JunOS)

```junos
set interfaces ae0 description "server01 LACP Bond"
set interfaces ae0 aggregated-ether-options lacp active
set interfaces ae0 aggregated-ether-options lacp periodic fast
set interfaces ae0 aggregated-ether-options minimum-links 1
set interfaces ae0 unit 0 family inet address 192.168.1.1/24

set interfaces xe-0/0/0 ether-options 802.3ad ae0
set interfaces xe-0/0/1 ether-options 802.3ad ae0

# Verify
show lacp interfaces
show interfaces ae0
```

## Section 7: Verifying Bond Status

### Reading /proc/net/bonding/

```bash
cat /proc/net/bonding/bond0

# Example output for LACP bond:
# Ethernet Channel Bonding Driver: v3.7.1 (April 27, 2011)
#
# Bonding Mode: IEEE 802.3ad Dynamic link aggregation
# Transmit Hash Policy: layer3+4 (1)
# MII Status: up
# MII Polling Interval (ms): 100
# Up Delay (ms): 0
# Down Delay (ms): 0
# Peer Notification Delay (ms): 0
#
# 802.3ad info
# LACP active: on
# LACP rate: fast
# Min links: 0
# Aggregator selection policy (ad_select): stable
# System priority: 65535
# System MAC address: 00:11:22:33:44:55
# Active Aggregator Info:
#         Aggregator ID: 1
#         Number of ports: 2
#         Actor Key: 15
#         Partner Key: 15
#         Partner Mac Address: aa:bb:cc:dd:ee:ff
#
# Slave Interface: eth0
#         MII Status: up
#         Speed: 10000 Mbps
#         Duplex: full
#         Link Failure Count: 0
#         Permanent HW addr: 00:11:22:33:44:55
#         Slave queue ID: 0
#         Aggregator ID: 1
#         Actor Churn State: none
#         Partner Churn State: none
#         Actor Churned Count: 0
#         Partner Churned Count: 0
#         details actor lacp pdu:
#           system priority: 65535
#           system mac address: 00:11:22:33:44:55
#           port key: 15
#           port priority: 255
#           port number: 1
#           port state: 61
#         details partner lacp pdu:
#           system priority: 32768
#           system mac address: aa:bb:cc:dd:ee:ff
#           oper key: 15
#           port priority: 128
#           port number: 257
#           port state: 61
```

### Bond Status Script

```bash
#!/bin/bash
# check-bond-status.sh

BOND_INTERFACES=$(ls /proc/net/bonding/ 2>/dev/null)

if [ -z "$BOND_INTERFACES" ]; then
    echo "No bond interfaces found"
    exit 0
fi

EXIT_CODE=0

for bond in $BOND_INTERFACES; do
    echo "=== $bond ==="
    INFO=$(cat /proc/net/bonding/$bond)

    # Extract mode
    MODE=$(echo "$INFO" | grep "Bonding Mode:" | sed 's/Bonding Mode: //')
    echo "Mode: $MODE"

    # Check overall status
    STATUS=$(echo "$INFO" | grep "^MII Status:" | head -1 | awk '{print $3}')
    if [ "$STATUS" = "up" ]; then
        echo "Status: UP (OK)"
    else
        echo "Status: DOWN (CRITICAL)"
        EXIT_CODE=1
    fi

    # Count active slaves
    ACTIVE=$(echo "$INFO" | grep "MII Status: up" | wc -l)
    TOTAL=$(echo "$INFO" | grep "Slave Interface:" | wc -l)
    echo "Active slaves: $ACTIVE / $TOTAL"

    if [ "$ACTIVE" -lt "$TOTAL" ]; then
        echo "WARNING: Not all slaves active"
        if [ "$ACTIVE" -eq 0 ]; then
            EXIT_CODE=1
        else
            EXIT_CODE=$((EXIT_CODE > 0 ? EXIT_CODE : 2))
        fi
    fi

    # For LACP: check negotiation
    if echo "$MODE" | grep -q "802.3ad\|LACP"; then
        PARTNER=$(echo "$INFO" | grep "Partner Mac Address:" | head -1)
        if echo "$PARTNER" | grep -q "00:00:00:00:00:00"; then
            echo "WARNING: LACP not negotiated with switch (all zeros partner MAC)"
            EXIT_CODE=$((EXIT_CODE > 0 ? EXIT_CODE : 2))
        else
            echo "LACP negotiated: $(echo $PARTNER | awk '{print $4}')"
        fi
    fi

    # Show link failure counts
    FAILURES=$(echo "$INFO" | grep "Link Failure Count:" | awk '{print $4}' | paste -sd'+' | bc 2>/dev/null || echo "0")
    echo "Total link failures: $FAILURES"

    echo ""
done

exit $EXIT_CODE
```

## Section 8: Failover Testing

### Systematic Failover Test

```bash
#!/bin/bash
# test-bond-failover.sh
# Tests bond failover behavior without service interruption

BOND="bond0"
SLAVE1="eth0"
SLAVE2="eth1"
TEST_IP="8.8.8.8"
PING_COUNT=100
PING_INTERVAL=0.1

echo "=== Bond Failover Test ==="
echo "Bond: $BOND"
echo "Slaves: $SLAVE1, $SLAVE2"
echo ""

# Verify initial state
echo "--- Initial State ---"
cat /proc/net/bonding/$BOND | grep -E "MII Status|Slave Interface|Speed"

# Start background ping
echo ""
echo "--- Starting background ping to $TEST_IP ---"
PING_LOG=$(mktemp)
ping -i $PING_INTERVAL -c $((PING_COUNT * 3)) $TEST_IP > $PING_LOG &
PING_PID=$!

sleep 2

# Test 1: Bring down first slave
echo ""
echo "--- Test 1: Bringing down $SLAVE1 ---"
ip link set $SLAVE1 down
sleep 1

ACTIVE=$(cat /proc/net/bonding/$BOND | grep "Active Slave:" | awk '{print $3}')
echo "Active slave after $SLAVE1 down: $ACTIVE"

if [ "$ACTIVE" = "$SLAVE2" ]; then
    echo "PASS: Failover to $SLAVE2 successful"
else
    echo "FAIL: Expected active slave $SLAVE2, got $ACTIVE"
fi

sleep 3

# Restore first slave
echo ""
echo "--- Restoring $SLAVE1 ---"
ip link set $SLAVE1 up
sleep 2

echo "Bond state after $SLAVE1 restore:"
cat /proc/net/bonding/$BOND | grep -E "MII Status|Active Slave:"

# Test 2: Bring down second slave
echo ""
echo "--- Test 2: Bringing down $SLAVE2 ---"
ip link set $SLAVE2 down
sleep 1

ACTIVE=$(cat /proc/net/bonding/$BOND | grep "Active Slave:" | awk '{print $3}')
echo "Active slave after $SLAVE2 down: $ACTIVE"

sleep 3

# Restore second slave
echo ""
echo "--- Restoring $SLAVE2 ---"
ip link set $SLAVE2 up
sleep 2

# Wait for ping to complete
wait $PING_PID

# Analyze results
echo ""
echo "=== Ping Results ==="
TOTAL=$(grep -c "^[0-9]" $PING_LOG || echo 0)
RECV=$(grep "received" $PING_LOG | awk '{print $4}' || echo 0)
LOSS=$(grep "received" $PING_LOG | awk -F'%' '{print $1}' | awk '{print $NF}' || echo "unknown")

echo "Packets transmitted: $TOTAL"
echo "Packets received: $RECV"
echo "Packet loss: $LOSS%"

if [ "$LOSS" = "0" ]; then
    echo "RESULT: PASS - Zero packet loss during failover"
else
    echo "RESULT: FAIL - Packet loss detected: $LOSS%"
fi

rm -f $PING_LOG
```

### LACP Negotiation Debug

```bash
# Enable LACP debugging
echo 1 > /sys/class/net/bond0/bonding/lacp_rate
echo 4 > /proc/sys/net/core/message_burst
echo 100 > /proc/sys/net/core/message_cost

# Watch LACP events in kernel log
dmesg -w | grep -i lacp

# Check LACP PDU counters (requires ethtool)
ethtool --statistics eth0 | grep -i lacp

# tcpdump to capture LACP PDUs
tcpdump -i eth0 -nn 'ether proto 0x8809'
# 0x8809 is the Slow Protocols EtherType used by LACP
```

### Network Performance Benchmark

```bash
# Test throughput on bonded interface
# From client to server (iperf3)
# Server side:
iperf3 -s -B 192.168.1.10

# Client side (16 parallel streams to fill the bond):
iperf3 -c 192.168.1.10 \
    -t 30 \
    -P 16 \
    -i 5 \
    --json \
    | python3 -c "
import json, sys
data = json.load(sys.stdin)
bits = data['end']['sum_received']['bits_per_second']
print(f'Throughput: {bits/1e9:.2f} Gbps')
"

# Expected: ~20 Gbps for a 2x10GbE LACP bond (with load balancing across streams)
```

## Section 9: Monitoring Bond Health

### Prometheus Node Exporter Metrics

The node exporter exposes bonding metrics automatically:

```promql
# Check bond slave count
# node_bonding_slaves{master="bond0"} == 2  # means 2 slaves configured

# Check active slaves
# node_bonding_active{master="bond0"} == 2  # both slaves active

# Alert when active slaves drop below configured
alert: BondSlaveDown
expr: node_bonding_active{master=~"bond.*"} < node_bonding_slaves{master=~"bond.*"}
for: 1m
labels:
  severity: critical
annotations:
  summary: "Bond {{ $labels.master }} has failed slave(s)"
  description: "{{ $value }} slaves active, {{ $labels.master }} expected more"
```

### Systemd Service for Bond Monitoring

```ini
# /etc/systemd/system/bond-monitor.service
[Unit]
Description=Network Bond Health Monitor
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/check-bond-status.sh --loop --interval=30
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Linux network bonding remains one of the most reliable techniques for eliminating network-layer single points of failure in production servers. LACP mode with proper switch configuration provides both redundancy and bandwidth aggregation, while the active-backup mode offers simpler failover with zero switch configuration. A systematic failover testing procedure verifies that the configuration works correctly before dependencies accumulate.
