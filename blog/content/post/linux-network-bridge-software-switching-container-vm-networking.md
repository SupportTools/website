---
title: "Linux Network Bridge: Software Switching for Container and VM Networking"
date: 2031-03-29T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Bridge", "Docker", "Kubernetes", "KVM", "VLAN", "macvlan"]
categories:
- Linux
- Networking
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux network bridge configuration using bridge-utils and ip link, covering STP, VLAN filtering, macvlan vs bridge mode comparison, KVM/QEMU bridge networking, and Docker/Kubernetes bridge network internals."
more_link: "yes"
url: "/linux-network-bridge-software-switching-container-vm-networking/"
---

The Linux kernel's bridge subsystem is the networking fabric that powers containerized workloads at every scale. Docker's default network, Kubernetes' CNI bridge, and KVM's VM networking all build on the same kernel bridge primitives. Understanding how bridges work at the kernel level — frame forwarding, MAC learning, STP loop prevention, and VLAN filtering — enables you to diagnose connectivity failures, optimize performance, and design network topologies that avoid common pitfalls.

This guide covers bridge creation and management with modern `ip link` commands, STP configuration for loop-free topologies, per-port VLAN filtering for multi-tenant environments, the macvlan alternative to bridging, KVM/QEMU bridge networking setup, and the internal mechanics of Docker and Kubernetes bridge networks.

<!--more-->

# Linux Network Bridge: Software Switching for Container and VM Networking

## Section 1: Linux Bridge Fundamentals

### How a Linux Bridge Works

A Linux bridge is a Layer 2 virtual switch implemented in the kernel. It:

1. **Learns MAC addresses**: When a frame arrives on a port, the bridge records the source MAC and the port it arrived on in the FDB (Forwarding Database)
2. **Forwards frames**: Uses the FDB to forward frames to the correct port, or floods to all ports if the destination MAC is unknown
3. **Filters duplicates**: Prevents frames from being forwarded back out the port they arrived on

The bridge doesn't have its own MAC address per se — it can be assigned an IP address for host management purposes, which lives on the bridge interface itself.

```
Physical NIC (eth0)
        |
   ┌────┴────────────────────────────┐
   │         Linux Bridge (br0)      │
   │   MAC Learning Table (FDB)      │
   │   aa:bb:cc:dd:ee:01 → veth0     │
   │   aa:bb:cc:dd:ee:02 → veth1     │
   └────┬──────────────┬─────────────┘
        │              │
     veth0           veth1
        │              │
   Container1      Container2
```

### Bridge vs. Switch Performance

A Linux bridge processes all frames in kernel space (or with XDP for high-performance paths). For typical containerized workloads:

- **Intra-host latency**: ~0.1-0.5ms for bridged container-to-container traffic
- **Throughput**: Line rate for 10GbE+ with sufficient CPU
- **CPU cost**: ~1-3% per 1Gbps of bridged traffic on modern hardware

## Section 2: Creating and Managing Bridges

### Modern ip link Bridge Management

```bash
# Create a bridge interface
ip link add name br0 type bridge

# Set bridge options
ip link set br0 type bridge \
  stp_state 1 \          # Enable STP
  forward_delay 2 \       # 2 second forward delay (fast for labs)
  hello_time 1 \          # Hello timer: 1 second
  max_age 6 \             # Max age: 6 seconds
  ageing_time 300         # MAC table aging: 5 minutes

# Bring bridge up
ip link set br0 up

# Assign IP address to bridge (for host access)
ip addr add 192.168.1.1/24 dev br0

# Add a physical interface to the bridge
ip link set eth1 master br0
ip link set eth1 up

# Add a VETH interface pair (for containers)
ip link add veth0 type veth peer name veth0-br
ip link set veth0-br master br0
ip link set veth0-br up

# Verify bridge configuration
ip link show type bridge
bridge link show
bridge fdb show br br0
```

### bridge-utils (Legacy but Still Useful)

```bash
# Install bridge-utils
apt-get install -y bridge-utils

# Create bridge
brctl addbr br0

# Add interfaces
brctl addif br0 eth1
brctl addif br0 veth0-br

# Enable STP
brctl stp br0 on

# Show bridge details
brctl show br0
brctl showmacs br0       # MAC address table
brctl showstp br0        # STP state
```

### Persistent Bridge Configuration

#### Using systemd-networkd

```bash
# /etc/systemd/network/10-bridge.netdev
cat > /etc/systemd/network/10-bridge.netdev << 'EOF'
[NetDev]
Name=br0
Kind=bridge

[Bridge]
STP=yes
ForwardDelaySec=2
HelloTimeSec=1
MaxAgeSec=6
AgeingTimeSec=300
EOF

# /etc/systemd/network/20-bridge-member.network
cat > /etc/systemd/network/20-bridge-member.network << 'EOF'
[Match]
Name=eth1

[Network]
Bridge=br0
EOF

# /etc/systemd/network/30-bridge.network
cat > /etc/systemd/network/30-bridge.network << 'EOF'
[Match]
Name=br0

[Network]
Address=192.168.1.1/24
IPForward=yes
EOF

systemctl restart systemd-networkd
networkctl status br0
```

#### Using Netplan (Ubuntu)

```yaml
# /etc/netplan/01-netcfg.yaml
network:
  version: 2
  ethernets:
    eth1:
      dhcp4: false
      dhcp6: false
  bridges:
    br0:
      interfaces: [eth1]
      addresses: [192.168.1.1/24]
      gateway4: 192.168.1.254
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
      parameters:
        stp: true
        forward-delay: 2
        hello-time: 1
        max-age: 6
        ageing-time: 300
      dhcp4: false
```

```bash
netplan apply
networkctl status br0
```

## Section 3: STP Configuration

### STP Roles and States

STP (Spanning Tree Protocol) prevents Layer 2 loops by putting redundant bridge ports in blocking state. In a Kubernetes cluster with multiple network paths, STP ensures only one active path exists between any two network segments.

```bash
# Check STP state of bridge ports
bridge link show
# output format: interface state
# eth1  state forwarding (root bridge - active path)
# eth2  state blocking   (redundant path - blocked to prevent loop)

# Check bridge STP details
brctl showstp br0
# bridge id    8000.aabbccddeeff
# designated root  8000.001122334455
# root port         1                        path cost     100
# max age           6.00                     bridge max age   6.00
# hello time        1.00                     bridge hello time   1.00
# forward delay     2.00                     bridge forward delay   2.00

# Set bridge priority (lower = more likely to be root bridge)
ip link set br0 type bridge priority 4096

# Set port cost (lower = preferred path)
ip link set eth1 type bridge_slave cost 100
ip link set eth2 type bridge_slave cost 200

# Enable RSTP (Rapid STP - faster convergence than classic STP)
ip link set br0 type bridge stp_state 1
# Modern Linux uses RSTP when stp_state=1
```

### STP for Container Networking

In containerized environments, STP can cause delays when veth interfaces are added to a bridge — the default forward delay causes a 30-second wait before a new port starts forwarding. Use portfast for container/VM ports:

```bash
# Enable port fast (immediate forwarding for edge ports)
# This is the correct way for host-to-container ports
bridge link set dev veth0-br learning on
ip link set veth0-br type bridge_slave \
  state 3 \          # 3 = forwarding state (skip STP for this port)
  guard off \        # Disable BPDU guard
  hair_pin off       # Disable hairpin mode

# Alternatively, set the port directly to forwarding
bridge link set dev veth0-br state forwarding

# Check port state
bridge link show dev veth0-br
```

For Docker and Kubernetes, bridge ports skip STP by default for performance — this is set automatically by the CNI plugins.

## Section 4: VLAN Filtering on Bridges

### VLAN-Aware Bridge Configuration

VLAN filtering allows a single bridge to carry multiple VLANs, with per-port VLAN membership. This is essential for multi-tenant container networking:

```bash
# Create a VLAN-aware bridge
ip link add name br0 type bridge vlan_filtering 1

ip link set br0 up

# Add uplink port (trunk — carries all VLANs)
ip link set eth1 master br0
ip link set eth1 up

# Configure uplink as trunk: allow VLANs 100, 200, 300
bridge vlan add dev eth1 vid 100 tagged
bridge vlan add dev eth1 vid 200 tagged
bridge vlan add dev eth1 vid 300 tagged

# Remove default VLAN 1 from uplink
bridge vlan del dev eth1 vid 1

# Add access ports for containers (untagged VLAN membership)
ip link set veth-tenant1 master br0
bridge vlan add dev veth-tenant1 vid 100 pvid untagged
bridge vlan del dev veth-tenant1 vid 1  # Remove default VLAN

ip link set veth-tenant2 master br0
bridge vlan add dev veth-tenant2 vid 200 pvid untagged
bridge vlan del dev veth-tenant2 vid 1

# View VLAN configuration
bridge vlan show
# port    vlan ids
# eth1     100 Tagged
#          200 Tagged
#          300 Tagged
# veth-tenant1   100 PVID Egress Untagged
# veth-tenant2   200 PVID Egress Untagged
# br0      1 PVID Egress Untagged

# Verify VLAN isolation: tenant1 and tenant2 cannot communicate
ip netns exec tenant1-ns ping 10.200.0.1 -c 3
# should fail (VLAN isolation)
```

### VLAN Filtering with QinQ (802.1ad)

For service provider environments requiring double-tagging:

```bash
# Create a QinQ-aware bridge
ip link add name br-qinq type bridge vlan_filtering 1 vlan_protocol 802.1ad

ip link set br-qinq up

# Configure outer and inner VLAN
bridge vlan add dev eth1 vid 100 tagged
# Inner VLAN is transparent through the outer VLAN
```

## Section 5: macvlan vs Bridge Mode

### macvlan Overview

macvlan creates virtual interfaces that share the parent physical interface but have distinct MAC addresses. Unlike bridging, macvlan is handled in the kernel fast path with no MAC learning overhead.

```bash
# Create macvlan interface (bridge mode)
ip link add link eth0 name macvlan0 type macvlan mode bridge

# macvlan modes:
# - private: interfaces cannot communicate with each other
# - vepa: traffic goes through external switch (VEPA-capable switch needed)
# - bridge: interfaces can communicate directly via kernel bridge code
# - passthru: single macvlan with direct access (for containers)

ip link set macvlan0 up
ip addr add 192.168.1.100/24 dev macvlan0

# Create macvlan for a container namespace
ip link add link eth0 name macvlan-ctr1 type macvlan mode bridge
ip link set macvlan-ctr1 netns container1-ns
ip netns exec container1-ns ip link set macvlan-ctr1 up
ip netns exec container1-ns ip addr add 192.168.1.101/24 dev macvlan-ctr1
```

### macvlan vs Bridge Comparison

```
┌─────────────────────────────────────────────────────────────┐
│                    Comparison: macvlan vs bridge             │
├──────────────────┬─────────────────────┬────────────────────┤
│ Attribute        │ macvlan (bridge)    │ veth + linux bridge│
├──────────────────┼─────────────────────┼────────────────────┤
│ Performance      │ Higher (no MAC      │ Good (MAC table    │
│                  │ learning overhead)  │ lookup on each pkt)│
├──────────────────┼─────────────────────┼────────────────────┤
│ Isolation        │ Good               │ Configurable       │
├──────────────────┼─────────────────────┼────────────────────┤
│ Host→Container   │ Requires loopback  │ Direct via bridge  │
│ communication    │ or IP route         │ IP                 │
├──────────────────┼─────────────────────┼────────────────────┤
│ VLAN support     │ Via 802.1q          │ Native filtering   │
├──────────────────┼─────────────────────┼────────────────────┤
│ Multiple MACs    │ Yes (per macvlan)  │ Yes (per veth)     │
│ on one NIC       │                     │                    │
├──────────────────┼─────────────────────┼────────────────────┤
│ Kubernetes CNI   │ macvlan CNI plugin  │ Default bridge CNI │
│ usage            │                     │                    │
└──────────────────┴─────────────────────┴────────────────────┘
```

### macvlan for High-Performance Container Networking

```bash
# macvlan CNI configuration for Kubernetes
cat > /etc/cni/net.d/10-macvlan.conf << 'EOF'
{
  "cniVersion": "0.3.1",
  "name": "macvlan-network",
  "type": "macvlan",
  "master": "eth0",
  "mode": "bridge",
  "ipam": {
    "type": "host-local",
    "subnet": "10.0.0.0/24",
    "rangeStart": "10.0.0.10",
    "rangeEnd": "10.0.0.200",
    "gateway": "10.0.0.1"
  }
}
EOF
```

**Key limitation**: With macvlan, the container cannot communicate with the host using the same physical interface. Workaround: create a macvlan interface on the host itself on the same parent:

```bash
# Allow host ↔ container communication with macvlan
ip link add link eth0 name macvlan-host type macvlan mode bridge
ip addr add 10.0.0.1/24 dev macvlan-host
ip link set macvlan-host up

# Now host can reach containers at 10.0.0.10-200 via macvlan-host
```

## Section 6: KVM/QEMU Bridge Networking

### Setting Up a Bridge for Virtual Machines

```bash
# Step 1: Create the bridge
ip link add name br-vms type bridge stp_state 0
ip link set br-vms up

# Step 2: Move IP from physical interface to bridge
# First, add physical interface to bridge
ip link set eth0 master br-vms

# Move the IP address from eth0 to br0
ip addr del 192.168.1.100/24 dev eth0
ip addr add 192.168.1.100/24 dev br-vms
ip route add default via 192.168.1.1 dev br-vms

# Step 3: Allow QEMU to create TAP interfaces
usermod -aG kvm,netdev $(whoami)

# Make bridge configuration persistent (using systemd-networkd)
cat > /etc/systemd/network/10-bridge-vms.netdev << 'EOF'
[NetDev]
Name=br-vms
Kind=bridge

[Bridge]
STP=no
AgeingTimeSec=300
EOF

cat > /etc/systemd/network/20-eth0-bridge.network << 'EOF'
[Match]
Name=eth0

[Network]
Bridge=br-vms
EOF

cat > /etc/systemd/network/30-br-vms.network << 'EOF'
[Match]
Name=br-vms

[Network]
Address=192.168.1.100/24
Gateway=192.168.1.1
DNS=8.8.8.8
EOF
```

### QEMU VM with Bridge Networking

```bash
# Launch a QEMU VM connected to the bridge
# Method 1: Helper script (recommended for production)
qemu-system-x86_64 \
  -name "vm-1" \
  -m 4096 \
  -smp 4 \
  -hda /var/lib/libvirt/images/vm1.qcow2 \
  -netdev tap,id=net0,br=br-vms,helper=/usr/lib/qemu/qemu-bridge-helper \
  -device virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56 \
  -display none \
  -daemonize

# The qemu-bridge-helper creates a TAP interface and attaches it to the bridge
# It runs setuid root, avoiding the need for root QEMU

# Check that the TAP interface was added to the bridge
bridge link show
# vnet0  state forwarding priority 32 cost 100
```

### libvirt Bridge Networking

```xml
<!-- /etc/libvirt/qemu/networks/host-bridge.xml -->
<network>
  <name>host-bridge</name>
  <forward mode='bridge'/>
  <bridge name='br-vms'/>
</network>
```

```bash
# Define and start the network
virsh net-define /etc/libvirt/qemu/networks/host-bridge.xml
virsh net-start host-bridge
virsh net-autostart host-bridge

# Configure a VM to use the bridge
virsh edit my-vm
# Change <interface type='network'> to:
```

```xml
<interface type='bridge'>
  <source bridge='br-vms'/>
  <model type='virtio'/>
</interface>
```

### Performance Tuning for VM Bridge Networking

```bash
# Enable multiqueue virtio-net for better multi-core performance
# In QEMU command line:
-netdev tap,id=net0,br=br-vms,vhost=on,queues=4,\
  helper=/usr/lib/qemu/qemu-bridge-helper \
-device virtio-net-pci,netdev=net0,\
  mac=52:54:00:12:34:56,\
  mq=on,vectors=10

# Enable hardware offloading on the bridge (if NIC supports it)
ethtool -K eth0 gso on gro on tso on

# Set bridge forwarding to use hardware offloading
ethtool -K br-vms gso on gro on

# Increase bridge FDB size for large deployments
echo 65536 > /sys/class/net/br-vms/bridge/hash_max

# Reduce ARP flood with VLAN learning
ip link set br-vms type bridge nf_call_arptables 0
ip link set br-vms type bridge nf_call_iptables 0
ip link set br-vms type bridge nf_call_ip6tables 0
```

## Section 7: Docker Bridge Network Internals

### How Docker's Default Bridge Works

When Docker creates a container with the default bridge network:

1. Creates a veth pair: `veth<hash>` (host side) + `eth0` (container side)
2. Attaches host-side veth to `docker0` bridge
3. Assigns IP to container's `eth0` from Docker's IPAM
4. Creates iptables MASQUERADE rule for container-to-external traffic

```bash
# Inspect Docker's bridge
ip link show docker0
brctl show docker0

# View Docker bridge network configuration
docker network inspect bridge

# Create a custom Docker bridge network
docker network create \
  --driver bridge \
  --subnet 172.20.0.0/16 \
  --gateway 172.20.0.1 \
  --opt "com.docker.network.bridge.name"="docker-custom" \
  --opt "com.docker.network.bridge.enable_icc"="true" \
  --opt "com.docker.network.bridge.enable_ip_masquerade"="true" \
  custom-network

# Inspect the iptables rules Docker creates
iptables -t nat -L DOCKER -n -v
iptables -L DOCKER-ISOLATION-STAGE-1 -n -v
```

### Docker Bridge iptables Rules

```bash
# View all Docker-managed iptables rules
iptables-save | grep -E "DOCKER|docker"

# Key rules:
# MASQUERADE: NAT for container-to-internet traffic
# DOCKER chain: DNAT for published ports
# DOCKER-ISOLATION: prevents inter-bridge communication

# Example: Add a custom rule to allow specific container traffic
CONTAINER_IP=$(docker inspect -f '{{.NetworkSettings.IPAddress}}' mycontainer)
iptables -I DOCKER-USER -s ${CONTAINER_IP} -p tcp --dport 5432 \
  -j ACCEPT -m comment --comment "allow container DB access"
```

## Section 8: Kubernetes CNI Bridge Network Internals

### How Kubernetes Bridge CNI Works

The default `bridge` CNI plugin creates:
- One bridge per node (`cni0` typically)
- One veth pair per pod
- IPMasquerade for pod-to-external traffic
- IPTables rules for kube-proxy service routing

```bash
# On a Kubernetes node, inspect CNI bridge
ip link show cni0
bridge link show

# Each pod's veth appears as a port
bridge fdb show br cni0 | head -20

# View pod IP allocation
cat /var/lib/cni/networks/k8s-pod-network/*.json | \
  python3 -m json.tool

# Trace packet path for a pod
POD_IP="10.244.1.5"
POD_VETH=$(ip route | grep "${POD_IP}" | awk '{print $3}')
echo "Pod ${POD_IP} uses veth interface: ${POD_VETH}"

# Check iptables for service NAT (kube-proxy)
iptables -t nat -L KUBE-SERVICES -n --line-numbers | head -20
```

### Debugging Pod Connectivity

```bash
#!/bin/bash
# debug-pod-networking.sh
# Diagnose pod network connectivity issues

POD_NAME="${1}"
NAMESPACE="${2:-default}"
TARGET_IP="${3}"

# Get pod details
POD_UID=$(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.metadata.uid}')
NODE=$(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.nodeName}')
POD_IP=$(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.status.podIP}')

echo "Pod: ${POD_NAME}"
echo "Node: ${NODE}"
echo "Pod IP: ${POD_IP}"

# On the node: find the veth pair for this pod
echo ""
echo "=== Network interface for pod ==="
# The container's eth0 is paired with a veth on the host
ip link | grep -A1 "$(nsenter --net=/var/run/netns/${POD_UID} ip link show eth0 | \
  awk '/^[0-9]+:/{print $1}' | sed 's/://')"

# Check the route to the pod
echo ""
echo "=== Route to pod IP ==="
ip route get "${POD_IP}"

# Check iptables for the pod
echo ""
echo "=== iptables rules for pod ==="
iptables -L -n -v | grep "${POD_IP}"
iptables -t nat -L -n -v | grep "${POD_IP}"

# Test connectivity
if [[ -n "${TARGET_IP}" ]]; then
  echo ""
  echo "=== Connectivity test from pod to ${TARGET_IP} ==="
  kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -- \
    ping -c 3 "${TARGET_IP}"
fi
```

## Section 9: Advanced Bridge Features

### Bridge with TC (Traffic Control) for QoS

```bash
# Apply traffic shaping to a bridge port (limit container bandwidth)
# Install tc-htb kernel module
modprobe sch_htb

# Set up HTB qdisc on bridge port
tc qdisc add dev veth-ctr1 root handle 1: htb default 10

# Set rate limit: 100Mbit with 1Gbit burst for this container
tc class add dev veth-ctr1 parent 1: classid 1:1 htb \
  rate 100mbit \
  burst 1gbit

tc class add dev veth-ctr1 parent 1:1 classid 1:10 htb \
  rate 100mbit \
  ceil 100mbit

# Apply filter
tc filter add dev veth-ctr1 protocol ip parent 1: \
  prio 1 u32 match ip dst 0.0.0.0/0 flowid 1:10

# Verify
tc qdisc show dev veth-ctr1
tc class show dev veth-ctr1
tc filter show dev veth-ctr1
```

### Bridge with eBPF for Packet Filtering

```bash
# Load eBPF program on bridge port for high-performance filtering
# (requires Linux 5.7+ with BPF_PROG_TYPE_SCHED_CLS support)

# Example: Load an XDP program on the bridge interface
ip link set br0 xdp obj bridge_filter.o sec xdp

# Or use TC for per-port filtering
tc qdisc add dev veth-ctr1 clsact
tc filter add dev veth-ctr1 ingress bpf da obj bridge_acl.o sec ingress

# Check eBPF program attachment
ip link show br0 | grep xdp
tc filter show dev veth-ctr1 ingress
```

### Bridge Monitoring and Statistics

```bash
#!/bin/bash
# bridge-monitor.sh
# Monitor bridge port statistics

BRIDGE="${1:-cni0}"
INTERVAL="${2:-5}"

while true; do
  echo "=== Bridge ${BRIDGE} Port Statistics ==="
  echo "Timestamp: $(date)"
  echo ""

  # Port list
  PORTS=$(bridge link show | awk '/ master '"${BRIDGE}"'/{print $2}' | sed 's/://')

  for PORT in ${PORTS}; do
    # Get interface statistics
    RX_PACKETS=$(cat /sys/class/net/${PORT}/statistics/rx_packets)
    TX_PACKETS=$(cat /sys/class/net/${PORT}/statistics/tx_packets)
    RX_BYTES=$(cat /sys/class/net/${PORT}/statistics/rx_bytes)
    TX_BYTES=$(cat /sys/class/net/${PORT}/statistics/tx_bytes)
    RX_ERRORS=$(cat /sys/class/net/${PORT}/statistics/rx_errors)
    TX_ERRORS=$(cat /sys/class/net/${PORT}/statistics/tx_errors)

    echo "Port: ${PORT}"
    printf "  RX: %d packets, %d bytes, %d errors\n" \
      "${RX_PACKETS}" "${RX_BYTES}" "${RX_ERRORS}"
    printf "  TX: %d packets, %d bytes, %d errors\n" \
      "${TX_PACKETS}" "${TX_BYTES}" "${TX_ERRORS}"
  done

  # FDB statistics
  FDB_COUNT=$(bridge fdb show br "${BRIDGE}" | wc -l)
  echo ""
  echo "FDB entries: ${FDB_COUNT}"

  sleep "${INTERVAL}"
done
```

## Section 10: Troubleshooting Common Bridge Issues

### ARP Flooding and Storm Prevention

```bash
# Enable proxy ARP to reduce broadcast flooding
echo 1 > /proc/sys/net/ipv4/conf/br0/proxy_arp

# Limit broadcast ARP to specific ports using ebtables
ebtables -I FORWARD -p ARP -i veth-ctr1 -j ACCEPT
ebtables -I FORWARD -p ARP -j DROP

# Use bridge hairpin mode to prevent ARP storms in VEPA setups
bridge link set dev veth-ctr1 hairpin on

# Monitor for broadcast storms
tcpdump -i br0 -n '(arp or broadcast)' -c 100
```

### Diagnosing Bridge Loop Issues

```bash
# Check if STP is active and blocking ports
bridge link show | grep -v "forwarding"
# Any "blocking" or "listening" ports indicate STP is working

# Check STP port roles
brctl showstp br0 | grep -E "port|state|role"

# If you see constant topology changes, check for duplicate MACs
bridge fdb show br br0 | sort | uniq -d

# Enable STP debug logging
echo 7 > /sys/kernel/debug/stp/br0/level  # Requires debugfs mounted
```

### VLAN Filtering Debugging

```bash
# Verify VLAN membership
bridge vlan show

# Check if frames are being forwarded on the correct VLAN
tcpdump -i br0 -n -e vlan

# Test VLAN isolation between containers
# Container 1 is in VLAN 100, Container 2 is in VLAN 200
ip netns exec ctr1-ns ping -c 3 10.100.0.2  # Same VLAN - should work
ip netns exec ctr1-ns ping -c 3 10.200.0.2  # Different VLAN - should fail

# Packet capture on a bridge port for debugging
tcpdump -i veth-ctr1 -n -e -vv
```

## Conclusion

The Linux bridge subsystem is a mature, performant, and highly configurable Layer 2 switch implementation. Understanding it at this depth — from STP port states to VLAN filtering to eBPF hook points — is what separates reactive troubleshooting from proactive network design.

For Kubernetes networking, the choice between bridge CNI (default), macvlan CNI (lower overhead for direct L2 access), and more sophisticated plugins like Cilium (eBPF-based, bypasses bridge entirely) depends on your scale, latency requirements, and network policy needs. For KVM/QEMU VM networking, proper bridge configuration with virtio-net multiqueue and hardware offloading enabled is the difference between acceptable and excellent VM network performance.

The operational fundamentals remain constant regardless of the abstraction layer: frames are forwarded based on MAC tables, VLAN filtering controls broadcast domains, and STP prevents loops. Everything higher in the stack builds on these primitives.
