---
title: "Linux Bonding and Team Drivers: 802.3ad LACP, Active-Backup, balance-alb, Monitoring, and NetworkManager Configuration"
date: 2032-01-16T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Bonding", "LACP", "NetworkManager", "High Availability"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux network bonding covering 802.3ad LACP dynamic link aggregation, active-backup failover, balance-alb adaptive load balancing, MII and ARP monitoring options, and NetworkManager nmcli configuration for production server deployments."
more_link: "yes"
url: "/linux-bonding-team-drivers-lacp-active-backup-networkmanager/"
---

Linux network bonding aggregates multiple physical network interfaces into a single logical interface, providing both redundancy and increased throughput. In production environments, choosing the right bonding mode and tuning monitoring parameters is the difference between a reliable multi-homed server and one that silently drops traffic on interface failure. This guide covers every bonding mode relevant to enterprise deployments with concrete configuration examples.

<!--more-->

# Linux Bonding and Team Drivers: Enterprise Guide

## Section 1: Kernel Bonding Architecture

The Linux bonding driver (`bonding.ko`) provides the classic approach to interface aggregation. The newer team driver offers a similar feature set with a daemon-based architecture that allows dynamic reconfiguration, but bonding remains the default choice for Kubernetes nodes, bare-metal hypervisors, and storage servers due to its kernel-native stability.

### Bonding vs Teaming

| Feature | bonding | team |
|---------|---------|------|
| Kernel version | 2.4+ | 3.3+ |
| Configuration | /sys/class/net, sysctl | teamd daemon |
| LACP support | mode 4 | lacp runner |
| Active-backup | mode 1 | activebackup runner |
| Dynamic reconfiguration | No (requires restart) | Yes (teamdctl) |
| SystemD integration | Systemd-networkd | NetworkManager |
| Use in containers | Common | Less common |
| Kubernetes support | Full | Partial |

For most production use cases, bonding with NetworkManager is the appropriate choice. This guide focuses on bonding with teaming examples where they differ meaningfully.

### Loading the Bonding Module

```bash
# Load bonding module
modprobe bonding

# Load with default parameters (override per interface)
modprobe bonding mode=4 miimon=100 lacp_rate=fast

# Make module loading persistent
cat > /etc/modules-load.d/bonding.conf << 'EOF'
bonding
EOF

# Set module parameters persistent
cat > /etc/modprobe.d/bonding.conf << 'EOF'
options bonding mode=4 miimon=100 lacp_rate=fast xmit_hash_policy=layer3+4
EOF

# Verify module is loaded
lsmod | grep bonding
cat /proc/net/bonding/bond0
```

### Interface Naming

Modern Linux systems use predictable network interface names (en- prefix):

```
eno1, eno2      - onboard NICs
enp3s0, enp3s1  - PCI bus location
ens3, ens4      - hotplug slot
eth0, eth1      - legacy naming (still common in VMs)
```

## Section 2: 802.3ad LACP (Mode 4)

Link Aggregation Control Protocol (LACP) per IEEE 802.3ad is the gold standard for link aggregation in environments with managed switches. It negotiates port membership dynamically and can recover from individual link failures without manual intervention.

### Requirements

- Managed switch with LACP support (virtually all enterprise switches: Cisco, Juniper, Arista, Dell, HP)
- All member interfaces must connect to the same switch (or a switch stack presenting as one)
- Switch ports must be configured in an LACP port channel or EtherChannel

### NetworkManager LACP Configuration

```bash
# Create the bond interface with LACP
nmcli connection add \
  type bond \
  con-name bond0 \
  ifname bond0 \
  bond.options "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=layer3+4,min_links=1"

# Add slave interfaces
nmcli connection add \
  type ethernet \
  con-name bond0-slave-enp3s0 \
  ifname enp3s0 \
  master bond0

nmcli connection add \
  type ethernet \
  con-name bond0-slave-enp4s0 \
  ifname enp4s0 \
  master bond0

# Configure IP on bond
nmcli connection modify bond0 \
  ipv4.addresses "10.0.1.10/24" \
  ipv4.gateway "10.0.1.1" \
  ipv4.dns "10.0.1.53,10.0.1.54" \
  ipv4.method manual \
  ipv6.method disabled

# Bring it up
nmcli connection up bond0

# Verify
cat /proc/net/bonding/bond0
```

### /etc/NetworkManager/system-connections/bond0.nmconnection

NetworkManager persists connection profiles as .nmconnection files. For infrastructure automation, managing these files directly is often preferable to nmcli:

```ini
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
min_links=1
ad_select=stable

[ipv4]
method=manual
address1=10.0.1.10/24,10.0.1.1
dns=10.0.1.53;10.0.1.54;
dns-search=example.com;

[ipv6]
method=disabled
```

```ini
# /etc/NetworkManager/system-connections/bond0-slave-enp3s0.nmconnection
[connection]
id=bond0-slave-enp3s0
type=ethernet
interface-name=enp3s0
master=bond0
slave-type=bond
autoconnect=yes

[ethernet]
mtu=9000
```

```bash
# Reload NetworkManager after file changes
nmcli connection reload
nmcli connection up bond0
```

### LACP Tuning Parameters

```bash
# xmit_hash_policy controls how traffic is distributed across links
# Options:
#   layer2      - MAC address hash (default, can be unbalanced)
#   layer2+3    - MAC + IP hash
#   layer3+4    - IP + port hash (recommended for most workloads)
#   encap2+3    - VXLAN/GRE inner packet hashing
#   encap3+4    - VXLAN/GRE inner IP+port hashing (Kubernetes overlay networks)

# Set via sysfs (runtime, not persistent)
echo "layer3+4" > /sys/class/net/bond0/bonding/xmit_hash_policy

# lacp_rate controls LACP PDU frequency
#   slow - one PDU every 30 seconds (default)
#   fast - one PDU per second (detects failures faster)
echo "fast" > /sys/class/net/bond0/bonding/lacp_rate

# ad_select controls which aggregator is selected
#   stable    - once selected, stay on it
#   bandwidth - select aggregator with most bandwidth
#   count     - select aggregator with most ports
echo "bandwidth" > /sys/class/net/bond0/bonding/ad_select

# min_links: fail bond if fewer than N links are active
echo "1" > /sys/class/net/bond0/bonding/min_links

# Verify LACP negotiation
cat /proc/net/bonding/bond0 | grep -E "LACP|Partner"
```

### Verifying LACP Status

```bash
# Full bond status
cat /proc/net/bonding/bond0

# Expected output for healthy LACP bond:
# Ethernet Channel Bonding Driver: v3.7.1
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
# System MAC address: aa:bb:cc:dd:ee:01
# Active Aggregator Info:
#     Aggregator ID: 1
#     Number of ports: 2
#     Actor Key: 9
#     Partner Key: 1
#     Partner Mac Address: aa:bb:cc:dd:ee:ff

# Check individual link status
bonding_masters=$(cat /sys/class/net/bonding_masters)
for bond in $bonding_masters; do
  echo "=== $bond ==="
  cat /proc/net/bonding/$bond
done

# IP route confirmation
ip link show bond0
ip -4 addr show bond0
```

### Switch Configuration (Cisco IOS Example)

```
! Cisco IOS/IOS-XE port channel configuration
interface Port-channel1
 description bond0-server01
 switchport mode trunk
 switchport trunk allowed vlan 10,20,30
 spanning-tree portfast trunk

interface GigabitEthernet0/1
 description server01-enp3s0
 channel-protocol lacp
 channel-group 1 mode active
 spanning-tree portfast trunk

interface GigabitEthernet0/2
 description server01-enp4s0
 channel-protocol lacp
 channel-group 1 mode active
 spanning-tree portfast trunk
```

## Section 3: Active-Backup (Mode 1)

Active-backup is the most reliable bonding mode. One interface is active at all times; all others are standby. On active interface failure, a standby takes over without negotiating with the switch. No special switch configuration is required.

### When to Use Active-Backup

- Heterogeneous switch connectivity (ports on different switches)
- Switches that don't support LACP
- Environments where switch misconfiguration risk outweighs bandwidth benefits
- Out-of-band management interfaces (IPMI, iDRAC, iLO)
- Kubernetes control plane nodes where stability > throughput

### NetworkManager Active-Backup Configuration

```bash
# Create active-backup bond
nmcli connection add \
  type bond \
  con-name bond-mgmt \
  ifname bond-mgmt \
  bond.options "mode=active-backup,miimon=100,updelay=200,downdelay=200,primary=enp1s0,primary_reselect=always"

nmcli connection add \
  type ethernet \
  con-name bond-mgmt-slave-enp1s0 \
  ifname enp1s0 \
  master bond-mgmt

nmcli connection add \
  type ethernet \
  con-name bond-mgmt-slave-enp2s0 \
  ifname enp2s0 \
  master bond-mgmt

nmcli connection modify bond-mgmt \
  ipv4.addresses "10.0.2.10/24" \
  ipv4.gateway "10.0.2.1" \
  ipv4.method manual

nmcli connection up bond-mgmt
```

### Active-Backup Tuning

```bash
# primary - preferred active interface (returns to this when it recovers)
echo "enp1s0" > /sys/class/net/bond-mgmt/bonding/primary

# primary_reselect controls when to switch back to primary
# always     - switch to primary as soon as it recovers
# better     - switch to primary if it has better link speed/duplex
# failure    - only switch to primary if current active fails
echo "always" > /sys/class/net/bond-mgmt/bonding/primary_reselect

# updelay/downdelay prevent flapping on brief link interruptions
# These are multiples of miimon interval
echo "200" > /sys/class/net/bond-mgmt/bonding/updelay
echo "200" > /sys/class/net/bond-mgmt/bonding/downdelay

# fail_over_mac: required when connecting to switches that track MAC per port
# active     - bond MAC follows active slave MAC
# follow     - bond MAC follows first active slave MAC permanently
# none       - all slaves use bond MAC (default, works with most switches)
echo "none" > /sys/class/net/bond-mgmt/bonding/fail_over_mac
```

### Manual Failover Testing

```bash
# Verify current active slave
cat /sys/class/net/bond-mgmt/bonding/active_slave

# Force failover to test secondary link
ifenslave -c bond-mgmt enp2s0

# Or via sysfs
echo enp2s0 > /sys/class/net/bond-mgmt/bonding/active_slave

# Verify switchover
cat /proc/net/bonding/bond-mgmt | grep "Currently Active Slave"

# Simulate physical failure
ip link set enp1s0 down
sleep 1
cat /sys/class/net/bond-mgmt/bonding/active_slave   # should be enp2s0 now
ip link set enp1s0 up
```

## Section 4: balance-alb (Mode 6 - Adaptive Load Balancing)

Adaptive Load Balancing (ALB) is unique among bonding modes because it requires no switch support yet achieves per-connection load balancing. It uses ARP negotiation to distribute outgoing traffic and processes all incoming traffic on the currently active link.

### How ALB Works

ALB combines two sub-modes:
- **TLB (Transmit Load Balancing, mode 5)**: Distributes outgoing traffic across all slaves based on current load
- **RLB (Receive Load Balancing)**: Uses ARP replies with different source MACs to steer incoming traffic to different slaves

```bash
# Create ALB bond
nmcli connection add \
  type bond \
  con-name bond-data \
  ifname bond-data \
  bond.options "mode=balance-alb,miimon=100,tlb_dynamic_lb=1"

nmcli connection add \
  type ethernet \
  con-name bond-data-slave-enp5s0 \
  ifname enp5s0 \
  master bond-data

nmcli connection add \
  type ethernet \
  con-name bond-data-slave-enp6s0 \
  ifname enp6s0 \
  master bond-data

nmcli connection add \
  type ethernet \
  con-name bond-data-slave-enp7s0 \
  ifname enp7s0 \
  master bond-data

nmcli connection modify bond-data \
  ipv4.addresses "10.0.3.10/24" \
  ipv4.gateway "10.0.3.1" \
  ipv4.method manual

nmcli connection up bond-data
```

### ALB Limitations

ALB does not work with IPv6 (no ARP in IPv6). For IPv6 with load balancing, use mode 4 (LACP).

ALB also cannot aggregate with bridging in some scenarios - test thoroughly before deploying with Linux bridges or OVS.

## Section 5: MII Monitoring vs ARP Monitoring

The choice of monitoring method significantly affects how quickly bonding detects and responds to link failures.

### MII Monitoring

MII (Media Independent Interface) monitoring uses the hardware link status register directly. It detects:
- Physical cable disconnection
- Switch port down
- NIC hardware failure

It does NOT detect:
- Switch forwarding failures
- STP blocking
- VLAN misconfiguration
- Network congestion causing packet loss

```bash
# MII monitoring parameters
cat /sys/class/net/bond0/bonding/miimon          # polling interval (ms)
cat /sys/class/net/bond0/bonding/updelay         # ms before marking link up
cat /sys/class/net/bond0/bonding/downdelay       # ms before marking link down

# Recommended values:
# miimon=100   - check every 100ms
# updelay=200  - require 2 consecutive successful polls before up
# downdelay=200 - require 2 consecutive failed polls before down

# These prevent flapping on brief link interruptions
```

### ARP Monitoring

ARP monitoring sends ARP requests to configured targets and verifies responses. It detects link-layer and network-layer failures that MII misses.

```bash
# Create bond with ARP monitoring
nmcli connection add \
  type bond \
  con-name bond-arp \
  ifname bond-arp \
  bond.options "mode=active-backup,arp_interval=100,arp_ip_target=10.0.1.1+10.0.1.254,arp_validate=all,arp_all_targets=all"

# arp_ip_target - space-separated list of IPs to ARP (max 16)
# arp_interval  - ARP polling interval in milliseconds
# arp_validate  - what to validate:
#   none      - do not validate (default)
#   active    - validate active slave only
#   backup    - validate backup slaves only
#   all       - validate all slaves
#   filter    - use ARP filtering (complex, rarely needed)
# arp_all_targets:
#   any       - slave up if any target responds
#   all       - slave up only if ALL targets respond
```

### Combined MII + ARP Monitoring

You cannot use both simultaneously - the last configured wins. Choose based on your failure mode requirements:

| Scenario | Recommended |
|----------|-------------|
| Data center with managed switches | MII + LACP |
| Switch configuration errors | ARP monitoring |
| IPv6-only environment | MII (ARP is IPv4) |
| Physical-only failures concern | MII |
| End-to-end connectivity required | ARP |

```bash
# ARP target selection guidance:
# - Use gateway IP (critical path)
# - Use two targets for redundancy
# - Targets must respond to ARP from the bond MAC
# - Using hosts on different paths increases detection coverage

# Verify ARP monitoring is working
watch -n 1 cat /proc/net/bonding/bond-arp
```

## Section 6: systemd-networkd Configuration

For systems not using NetworkManager (common in containers and minimal servers):

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
MinLinks=1
AdSelect=bandwidth
UpDelaySec=200ms
DownDelaySec=200ms
```

```ini
# /etc/systemd/network/20-enp3s0.network
[Match]
Name=enp3s0

[Network]
Bond=bond0
```

```ini
# /etc/systemd/network/20-enp4s0.network
[Match]
Name=enp4s0

[Network]
Bond=bond0
```

```ini
# /etc/systemd/network/30-bond0.network
[Match]
Name=bond0

[Network]
DHCP=no
Address=10.0.1.10/24
Gateway=10.0.1.1
DNS=10.0.1.53
DNS=10.0.1.54
Domains=example.com
```

```bash
# Apply configuration
systemctl restart systemd-networkd

# Verify
networkctl status bond0
networkctl list
```

## Section 7: Bonding in Kubernetes Environments

Kubernetes worker nodes benefit significantly from proper bonding configuration, but there are specific considerations.

### Kubernetes Node Bonding Recommendations

```bash
# For Kubernetes nodes: mode 4 (LACP) with layer3+4 hashing
# This ensures:
# - Pod traffic is hashed by source/dest IP+port
# - Different pods can use different physical links
# - Overlay network traffic (VXLAN) is distributed

# For control plane nodes: mode 1 (active-backup)
# Rationale: etcd requires reliable low-latency connectivity;
# LACP misconfiguration risk is too high for control plane stability

# Example: production Kubernetes worker bond
nmcli connection add \
  type bond \
  con-name k8s-worker-bond \
  ifname bond0 \
  bond.options "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=layer3+4,min_links=1"

# MTU for VXLAN encapsulation: host MTU should be 9000 to allow 1500 inner + overhead
nmcli connection modify k8s-worker-bond 802-3-ethernet.mtu 9000
```

### Multus CNI with Bonded Interfaces

For Kubernetes pods that need direct access to bonded interfaces (SR-IOV, DPDK, or performance networking):

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: bond-network
  namespace: default
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name": "bond-network",
      "type": "bond",
      "mode": "active-backup",
      "failOverMac": 1,
      "linksInContainer": true,
      "miimon": "100",
      "links": [
        {"name": "net1"},
        {"name": "net2"}
      ],
      "ipam": {
        "type": "host-local",
        "subnet": "192.168.1.0/24",
        "rangeStart": "192.168.1.200",
        "rangeEnd": "192.168.1.250",
        "gateway": "192.168.1.1"
      }
    }
```

## Section 8: Monitoring and Observability

### Prometheus Node Exporter Metrics

The Node Exporter exposes bonding metrics via the `bonding` collector:

```
# HELP node_bonding_active Number of active interfaces per bonding interface
# TYPE node_bonding_active gauge
node_bonding_active{master="bond0"} 2

# HELP node_bonding_slaves Number of configured slaves per bonding interface
# TYPE node_bonding_slaves gauge
node_bonding_slaves{master="bond0"} 2
```

### Alerting on Bond Degradation

```yaml
# Prometheus alerting rules for bond health
groups:
  - name: bonding
    rules:
      - alert: BondDegraded
        expr: |
          node_bonding_active < node_bonding_slaves
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Bond interface degraded on {{ $labels.instance }}"
          description: "Bond {{ $labels.master }} has {{ $value }} active slaves, expected {{ $labels.slaves }}"

      - alert: BondFullyDown
        expr: |
          node_bonding_active == 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "Bond interface fully down on {{ $labels.instance }}"
          description: "Bond {{ $labels.master }} has no active slaves"
```

### Bonding Status Script

```bash
#!/usr/bin/env bash
# /usr/local/bin/check-bonding
# Nagios/Icinga2 compatible bond health check

CRITICAL=0
WARNING=0
OUTPUT=""

for bond in /proc/net/bonding/bond*; do
    bond_name=$(basename "$bond")
    status=$(cat "$bond")

    total_slaves=$(echo "$status" | grep -c "^Slave Interface:")
    active_slaves=$(echo "$status" | grep -c "MII Status: up")
    mode=$(echo "$status" | grep "^Bonding Mode:" | cut -d: -f2 | xargs)

    if [ "$active_slaves" -eq 0 ]; then
        CRITICAL=$((CRITICAL + 1))
        OUTPUT="${OUTPUT}CRITICAL: ${bond_name} (${mode}) - 0/${total_slaves} slaves up\n"
    elif [ "$active_slaves" -lt "$total_slaves" ]; then
        WARNING=$((WARNING + 1))
        OUTPUT="${OUTPUT}WARNING: ${bond_name} (${mode}) - ${active_slaves}/${total_slaves} slaves up\n"
    else
        OUTPUT="${OUTPUT}OK: ${bond_name} (${mode}) - ${active_slaves}/${total_slaves} slaves up\n"
    fi
done

if [ $CRITICAL -gt 0 ]; then
    echo -e "CRITICAL - Bond degraded\n${OUTPUT}"
    exit 2
elif [ $WARNING -gt 0 ]; then
    echo -e "WARNING - Bond partially down\n${OUTPUT}"
    exit 1
else
    echo -e "OK - All bonds healthy\n${OUTPUT}"
    exit 0
fi
```

## Section 9: Troubleshooting

### Common Issues

**Bond not forming / slaves not joining:**

```bash
# Check kernel messages
dmesg | grep -i bond | tail -20

# Verify slave interfaces are not in use
ip link show enp3s0 enp4s0
nmcli device status

# Check if interfaces have IP addresses (must be removed first)
ip addr show enp3s0

# Force add slave
ip link set enp3s0 master bond0

# Check NetworkManager isn't managing slave separately
nmcli connection show --active | grep enp3s0
```

**LACP not negotiating:**

```bash
# Check LACP PDU exchange
tcpdump -i enp3s0 -e 'ether proto 0x8809' -c 10

# Expected: you should see LACP PDUs if switch is configured correctly
# 08:00:27:xx:xx:xx > 01:80:c2:00:00:02, ethertype Slow Protocols (0x8809)

# Check switch port status
# On Cisco: show etherchannel summary
# On Juniper: show lacp interfaces

# Common cause: switch ports in 'passive' mode when both sides need at least 'active'
# Set bond lacp mode
echo "active" > /sys/class/net/bond0/bonding/ad_actor_sys_prio
```

**Traffic not balanced with LACP:**

```bash
# Verify xmit_hash_policy is set correctly
cat /sys/class/net/bond0/bonding/xmit_hash_policy

# Monitor per-interface traffic
watch -n 1 "ip -s link show enp3s0 && ip -s link show enp4s0"

# Use iptraf-ng for real-time traffic analysis
iptraf-ng -i bond0

# Check that LACP actually negotiated (2 ports in aggregator)
grep "Number of ports:" /proc/net/bonding/bond0
# Should show 2 (or however many you configured)
# If it shows 1, LACP negotiation failed for one port
```

**ARP monitoring not working:**

```bash
# Verify ARP targets are reachable
arping -I enp3s0 10.0.1.1
arping -I enp4s0 10.0.1.1

# Check current ARP validate mode
cat /sys/class/net/bond0/bonding/arp_validate

# Watch bond log output
journalctl -k -f | grep bond
```

Bonding configuration is a foundational infrastructure decision. Get it right and your servers become resilient to single NIC and single switch-port failures with minimal impact to running workloads. Get it wrong and you introduce subtle failure modes that only manifest under load or at the worst possible time.
