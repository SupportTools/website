---
title: "Linux Container Networking Internals: veth Pairs, Bridge Networking, iptables MASQUERADE, and Network Namespace Lifecycle"
date: 2032-01-09T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Containers", "Kubernetes", "iptables", "Network Namespaces", "Docker", "CNI"]
categories:
- Linux
- Networking
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux container networking internals: how veth pairs connect containers to bridges, how iptables MASQUERADE enables outbound NAT, the full lifecycle of network namespaces, and how CNI plugins implement these primitives."
more_link: "yes"
url: "/linux-container-networking-internals-veth-bridge-iptables-namespaces/"
---

Every Kubernetes pod, every Docker container, every container runtime sandbox operates inside a Linux network namespace connected to the outside world through a chain of carefully configured kernel primitives. Understanding these primitives—veth pairs, Linux bridges, iptables MASQUERADE, and the network namespace lifecycle—is essential for diagnosing connectivity failures, implementing custom CNI plugins, understanding Kubernetes networking models, and performing container forensics. This guide builds a container network from scratch using only Linux kernel primitives, then maps those primitives back to production container runtimes and CNI implementations.

<!--more-->

# Linux Container Networking Internals

## The Kernel Primitives Stack

```
Container/Pod perspective:             Host perspective:
┌─────────────────────────┐           ┌──────────────────────────────────┐
│  Network Namespace (ns) │           │  Host Network Namespace          │
│  ┌─────────────────┐    │           │  ┌──────────┐  ┌──────────────┐  │
│  │  eth0 (veth)    │◄───┼──veth─────┼──│ vethXYZ  │  │   eth0       │  │
│  │  10.244.1.5/24  │    │   pair    │  └────┬─────┘  │ (physical)   │  │
│  └────────┬────────┘    │           │       │         └──────┬───────┘  │
│           │             │           │  ┌────▼─────┐          │          │
│      [loopback]         │           │  │  cni0    │          │          │
└───────────┬─────────────┘           │  │ (bridge) │          │          │
            │                         │  └────┬─────┘          │          │
     Container traffic                │       │ iptables        │          │
                                      │  MASQUERADE/FORWARD     │          │
                                      │       └─────────────────┘          │
                                      └──────────────────────────────────┘
```

## Part 1: Network Namespaces

### What a Network Namespace Isolates

A Linux network namespace provides an isolated instance of:
- Network interfaces (the namespace has its own set, initially just `lo`)
- IP routing table
- iptables/nftables rules
- Connection tracking table (conntrack)
- UNIX domain socket namespace
- `/proc/net/` virtual filesystem

The host starts in the "default" network namespace. Each container runtime creates a new network namespace per container (or per pod in Kubernetes).

### Creating and Inspecting Network Namespaces

```bash
# Create a network namespace named "container1"
ip netns add container1

# List all network namespaces
ip netns list
# Output: container1

# Inspect the new namespace (only loopback, no external interfaces)
ip netns exec container1 ip link show
# Output:
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN mode DEFAULT group default qlen 1000
#     link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00

# View routing table in the namespace (empty)
ip netns exec container1 ip route show

# Run a shell inside the namespace
ip netns exec container1 bash

# Inspect namespace file descriptors (how runtimes track them)
ls -la /run/netns/
# Output: container1 -> ... (bind-mounted file)

# Show /proc representation
ls -la /proc/self/ns/net
# Output: /proc/self/ns/net -> net:[4026531992]

ip netns exec container1 ls -la /proc/self/ns/net
# Output: /proc/self/ns/net -> net:[4026532285]  <- different inode = different namespace
```

### Namespace Persistence via Bind Mounting

Container runtimes keep namespaces alive after the process that created them exits by bind-mounting the namespace file descriptor:

```bash
# Without bind mount: namespace destroyed when creating process exits
# With bind mount: namespace persists

# Create a namespace and bind-mount it
mkdir -p /run/netns
touch /run/netns/persistent-ns
unshare --net=/run/netns/persistent-ns true

# Now the namespace persists even though 'true' has exited
ip netns exec persistent-ns ip link show
# Shows: lo (DOWN)

# Delete when done
ip netns delete persistent-ns
# This removes the bind mount
```

### Namespace Operations from Go (for Runtime Implementors)

```go
package netns

import (
    "fmt"
    "os"
    "runtime"
    "syscall"

    "golang.org/x/sys/unix"
)

// CreateNetNS creates a new network namespace and returns a file
// descriptor referencing it. The caller must close the fd when done.
func CreateNetNS(name string) (*os.File, error) {
    // Lock the OS thread to ensure unshare affects the correct goroutine
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Save current namespace fd
    origNS, err := os.Open("/proc/self/ns/net")
    if err != nil {
        return nil, fmt.Errorf("open current netns: %w", err)
    }
    defer origNS.Close()

    // Create new namespace via unshare
    if err := syscall.Unshare(syscall.CLONE_NEWNET); err != nil {
        return nil, fmt.Errorf("unshare: %w", err)
    }

    // Open the new namespace fd
    newNS, err := os.Open("/proc/self/ns/net")
    if err != nil {
        return nil, fmt.Errorf("open new netns: %w", err)
    }

    // Bind-mount to persist it
    nsPath := "/run/netns/" + name
    if err := os.MkdirAll("/run/netns", 0o755); err != nil {
        newNS.Close()
        return nil, err
    }
    f, err := os.Create(nsPath)
    if err != nil {
        newNS.Close()
        return nil, err
    }
    f.Close()

    if err := unix.Mount("/proc/self/ns/net", nsPath, "bind", unix.MS_BIND, ""); err != nil {
        newNS.Close()
        os.Remove(nsPath)
        return nil, fmt.Errorf("bind mount: %w", err)
    }

    // Restore original namespace
    if err := unix.Setns(int(origNS.Fd()), syscall.CLONE_NEWNET); err != nil {
        newNS.Close()
        return nil, fmt.Errorf("restore netns: %w", err)
    }

    return newNS, nil
}

// EnterNetNS temporarily switches the current goroutine to the given namespace.
// The returned function restores the original namespace; call it with defer.
func EnterNetNS(nsFd int) (func(), error) {
    runtime.LockOSThread()

    origNS, err := os.Open("/proc/self/ns/net")
    if err != nil {
        runtime.UnlockOSThread()
        return nil, err
    }

    if err := unix.Setns(nsFd, syscall.CLONE_NEWNET); err != nil {
        origNS.Close()
        runtime.UnlockOSThread()
        return nil, err
    }

    restore := func() {
        unix.Setns(int(origNS.Fd()), syscall.CLONE_NEWNET)
        origNS.Close()
        runtime.UnlockOSThread()
    }
    return restore, nil
}
```

## Part 2: veth Pairs

### How veth Pairs Work

A veth (virtual Ethernet) pair is a kernel virtual network device that comes in pairs—like a pipe: packets sent into one end emerge from the other. The typical container networking pattern:

- One end (`vethXXX`) stays in the host namespace, attached to a bridge
- The other end (`eth0`) is moved into the container's network namespace

```bash
# Create a veth pair
ip link add veth-host type veth peer name veth-container

# Verify both ends are in the host namespace
ip link show veth-host
ip link show veth-container

# Move the container end into the container namespace
ip link set veth-container netns container1

# Assign IP address inside the container namespace
ip netns exec container1 ip addr add 10.244.1.5/24 dev veth-container
ip netns exec container1 ip link set veth-container up
ip netns exec container1 ip link set lo up

# Bring up the host end
ip link set veth-host up

# Verify container can see its interface
ip netns exec container1 ip addr show
# Output:
# 1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 ...
# 3: veth-container@if4: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ...
#     inet 10.244.1.5/24 scope global veth-container

# Check interface index correlation (@ suffix shows peer index)
ip netns exec container1 cat /sys/class/net/veth-container/ifindex
# Output: 3
ip netns exec container1 cat /sys/class/net/veth-container/iflink
# Output: 4  <- peer is interface index 4 in the parent namespace
ip link show | grep "^4:"
# Output: 4: veth-host@if3: ...
```

### veth Naming Conventions in Production Runtimes

Different container runtimes use different naming schemes for the host-side veth:

```bash
# Docker: uses a random suffix
docker run -d nginx
ip link show | grep veth
# vethf2b31a8@if3: ...

# containerd/CRI-O (Flannel CNI): uses veth + partial pod ID
ip link show | grep veth
# veth3b7a9c1d@if2

# Calico CNI: uses cali prefix + 11-char hash
ip link show | grep cali
# calie5f91d82b60@if3

# Identifying which veth belongs to which container:
# Step 1: find container's veth peer index
CONTAINER_ID="your-container-id"
PID=$(docker inspect --format '{{.State.Pid}}' "$CONTAINER_ID")
nsenter -t "$PID" -n -- ip link | grep '@if' | awk '{print $1, $(NF-1)}' | head -5

# Step 2: find the host interface with that index
PEER_IDX=4  # from step 1
ip link show | grep "^${PEER_IDX}:"
```

### MTU Considerations

The container veth MTU must account for any encapsulation overhead:

```bash
# Default MTU (1500 for most ethernet)
ip netns exec container1 ip link show veth-container
# mtu 1500

# For VXLAN overlay networks: reduce by 50 bytes (VXLAN header)
# Flannel VXLAN: MTU 1450
ip link set veth-container mtu 1450

# For Calico IPIP: reduce by 20 bytes
# ip link set veth-container mtu 1480

# For WireGuard overlay: reduce by 60 bytes
# ip link set veth-container mtu 1440

# Verify end-to-end MTU with PMTUD
ping -M do -s 1472 10.244.1.1  # 1472 + 28 (IP+ICMP header) = 1500
```

## Part 3: Linux Bridge Networking

### Creating and Configuring a Bridge

A Linux bridge acts as a Layer 2 switch, forwarding frames between connected interfaces based on MAC addresses learned from traffic.

```bash
# Create bridge interface
ip link add name cni0 type bridge
ip link set cni0 up
ip addr add 10.244.1.1/24 dev cni0

# Attach the host-side veth to the bridge
ip link set veth-host master cni0

# Verify bridge FDB (forwarding database)
bridge fdb show dev cni0
# Output shows MAC → port mappings (learned dynamically)

# Show bridge details
ip -d link show cni0
bridge link show

# Verify connectivity: host → container
ping -c 1 10.244.1.5

# Verify connectivity: container → gateway
ip netns exec container1 ping -c 1 10.244.1.1
```

### Bridge Configuration for Multiple Containers

```bash
# Add a second container
ip netns add container2
ip link add veth-host2 type veth peer name veth-container2
ip link set veth-container2 netns container2
ip netns exec container2 ip addr add 10.244.1.6/24 dev veth-container2
ip netns exec container2 ip link set veth-container2 up
ip netns exec container2 ip link set lo up
ip netns exec container2 ip route add default via 10.244.1.1

# Attach second veth to bridge
ip link set veth-host2 up
ip link set veth-host2 master cni0

# Container-to-container communication via bridge (no NAT needed)
ip netns exec container1 ping -c 1 10.244.1.6
# Works! Bridge forwards at L2

# Add default route in container1 to reach external networks
ip netns exec container1 ip route add default via 10.244.1.1
```

### Bridge STP and ARP Proxy

```bash
# Disable STP (Spanning Tree Protocol) for single-host bridges
# STP introduces 30s delay on link up — disastrous for containers
ip link set cni0 type bridge stp_state 0

# Verify STP is disabled
cat /sys/class/net/cni0/bridge/stp_state
# Output: 0

# Enable ARP proxy to reduce ARP broadcast storms
echo 1 > /proc/sys/net/ipv4/conf/cni0/proxy_arp

# Enable IP forwarding (required for routing between bridge and external)
echo 1 > /proc/sys/net/ipv4/ip_forward
# Or permanently:
echo "net.ipv4.ip_forward = 1" > /etc/sysctl.d/99-container-networking.conf
sysctl --system
```

## Part 4: iptables and MASQUERADE

### The iptables Tables and Chains

```
Packet flow through iptables (for routed packets):

PREROUTING  → routing decision → FORWARD → POSTROUTING → out
   (nat)       (local? → INPUT)   (filter)   (nat)
               (external? → FORWARD)
```

Container traffic uses these key chains:
- `nat/PREROUTING`: DNAT for inbound port mappings (docker `-p`)
- `filter/FORWARD`: allow/deny forwarded traffic
- `nat/POSTROUTING`: MASQUERADE for outbound NAT

### Setting Up MASQUERADE for Container Outbound Traffic

```bash
# Allow IP forwarding (required)
sysctl -w net.ipv4.ip_forward=1

# MASQUERADE: rewrite container source IP to host IP when leaving
# This allows containers (10.244.0.0/16) to reach the internet
iptables -t nat -A POSTROUTING \
    -s 10.244.0.0/16 \
    ! -o cni0 \
    -j MASQUERADE

# Allow FORWARD for established connections (return traffic)
iptables -A FORWARD \
    -m conntrack \
    --ctstate RELATED,ESTABLISHED \
    -j ACCEPT

# Allow new outbound connections from containers
iptables -A FORWARD \
    -i cni0 \
    -j ACCEPT

# Allow traffic destined for containers (from outside)
iptables -A FORWARD \
    -o cni0 \
    -j ACCEPT

# Verify rules
iptables -t nat -L POSTROUTING -n -v
iptables -L FORWARD -n -v
```

### MASQUERADE vs SNAT

```bash
# MASQUERADE: dynamic — uses the outgoing interface's current IP
# Use when host IP can change (DHCP, cloud instances)
iptables -t nat -A POSTROUTING -s 10.244.0.0/16 ! -o cni0 -j MASQUERADE

# SNAT: static — specify the exact source IP
# Use when host IP is fixed (better performance: no interface IP lookup per packet)
iptables -t nat -A POSTROUTING -s 10.244.0.0/16 ! -o cni0 \
    -j SNAT --to-source 192.168.1.10

# Performance difference: MASQUERADE requires a route table lookup per packet
# SNAT is ~5-15% faster under high packet rates
# For Kubernetes nodes with static IPs, SNAT is preferred
```

### Port Mapping with DNAT

```bash
# Map host port 8080 to container port 80
# This is what `docker run -p 8080:80` does internally

CONTAINER_IP="10.244.1.5"

# DNAT: redirect incoming traffic on host:8080 to container:80
iptables -t nat -A PREROUTING \
    -p tcp \
    --dport 8080 \
    -j DNAT \
    --to-destination "${CONTAINER_IP}:80"

# Enable hairpin NAT (allow container to reach itself via host IP)
iptables -t nat -A OUTPUT \
    -p tcp \
    --dport 8080 \
    -j DNAT \
    --to-destination "${CONTAINER_IP}:80"

# MASQUERADE for hairpin traffic
iptables -t nat -A POSTROUTING \
    -p tcp \
    -d "${CONTAINER_IP}" \
    --dport 80 \
    -j MASQUERADE

# Verify the full NAT rule chain
iptables -t nat -L -n -v --line-numbers
```

### Inspecting Connection Tracking

```bash
# View current NAT sessions (conntrack table)
conntrack -L

# Filter by container IP
conntrack -L | grep 10.244.1.5

# Example output:
# tcp      6 86397 ESTABLISHED src=10.244.1.5 dst=8.8.8.8 sport=43210 dport=53 \
#   src=8.8.8.8 dst=192.168.1.10 sport=53 dport=43210 [ASSURED] mark=0 use=1
#   ^ container              ^ external         ^ masqueraded host IP

# Monitor real-time connection events
conntrack -E

# Count total connections per source
conntrack -L | awk '{print $7}' | sort | uniq -c | sort -rn | head
```

### Kubernetes kube-proxy iptables Mode

Kubernetes services use a more complex iptables ruleset. Understanding the structure:

```bash
# On a Kubernetes node, examine service rules
iptables -t nat -L KUBE-SERVICES -n --line-numbers | head -30

# Each ClusterIP service gets a chain:
# KUBE-SERVICES → KUBE-SVC-XXXXXXXXXXXX → KUBE-SEP-XXXXXXXX (endpoint)

# Trace how a service packet flows:
# 1. Container sends to ClusterIP:port
# 2. PREROUTING → KUBE-SERVICES → matches ClusterIP
# 3. KUBE-SVC-XXX → random probabilistic DNAT to one endpoint
# 4. KUBE-SEP-XXX → DNAT to pod IP:port
# 5. Packet routed to pod

# View all KUBE-SVC rules for a specific service
SVC_CLUSTER_IP="10.96.0.1"
iptables -t nat -L KUBE-SERVICES -n | grep "$SVC_CLUSTER_IP"

# View endpoint rules
iptables -t nat -L | grep KUBE-SEP | head -20
```

## Part 5: Full Lifecycle Walkthrough

### Building a Complete Container Network from Scratch

```bash
#!/bin/bash
# container-net-setup.sh
# Simulates what a CNI plugin does for a new pod

set -euo pipefail

CONTAINER_NS="mycontainer"
CONTAINER_IP="10.244.1.100"
GATEWAY_IP="10.244.1.1"
BRIDGE="cni0"
SUBNET="10.244.1.0/24"
VETH_HOST="veth-${CONTAINER_NS:0:8}"
VETH_CONTAINER="eth0"

echo "=== Creating network namespace ==="
ip netns add "$CONTAINER_NS"

echo "=== Creating bridge (if not exists) ==="
if ! ip link show "$BRIDGE" &>/dev/null; then
    ip link add name "$BRIDGE" type bridge
    ip link set "$BRIDGE" type bridge stp_state 0
    ip addr add "${GATEWAY_IP}/24" dev "$BRIDGE"
    ip link set "$BRIDGE" up
    echo 1 > /proc/sys/net/ipv4/conf/"$BRIDGE"/proxy_arp
fi

echo "=== Creating veth pair ==="
ip link add "$VETH_HOST" type veth peer name "$VETH_CONTAINER"

echo "=== Moving container end to namespace ==="
ip link set "$VETH_CONTAINER" netns "$CONTAINER_NS"

echo "=== Configuring container interface ==="
ip netns exec "$CONTAINER_NS" ip link set lo up
ip netns exec "$CONTAINER_NS" ip link set "$VETH_CONTAINER" up
ip netns exec "$CONTAINER_NS" ip addr add "${CONTAINER_IP}/24" dev "$VETH_CONTAINER"
ip netns exec "$CONTAINER_NS" ip route add default via "$GATEWAY_IP"

echo "=== Configuring host veth ==="
ip link set "$VETH_HOST" up
ip link set "$VETH_HOST" master "$BRIDGE"

echo "=== Setting up iptables for outbound NAT ==="
# Check if rule already exists
if ! iptables -t nat -C POSTROUTING -s "$SUBNET" ! -o "$BRIDGE" -j MASQUERADE 2>/dev/null; then
    iptables -t nat -A POSTROUTING -s "$SUBNET" ! -o "$BRIDGE" -j MASQUERADE
fi

if ! iptables -C FORWARD -i "$BRIDGE" -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -i "$BRIDGE" -j ACCEPT
fi

if ! iptables -C FORWARD -o "$BRIDGE" -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -o "$BRIDGE" -j ACCEPT
fi

echo "=== Verifying connectivity ==="
ip netns exec "$CONTAINER_NS" ping -c 1 "$GATEWAY_IP"
ip netns exec "$CONTAINER_NS" ping -c 1 8.8.8.8

echo "=== Network setup complete ==="
echo "Container IP: $CONTAINER_IP"
echo "Gateway: $GATEWAY_IP"
```

### Teardown Script

```bash
#!/bin/bash
# container-net-teardown.sh

CONTAINER_NS="mycontainer"
VETH_HOST="veth-${CONTAINER_NS:0:8}"

echo "=== Removing veth host end ==="
ip link delete "$VETH_HOST" 2>/dev/null || true
# Deleting the host end automatically destroys the pair

echo "=== Removing namespace ==="
ip netns delete "$CONTAINER_NS"

echo "=== Done ==="
```

## Part 6: How CNI Plugins Work

### CNI Specification

CNI (Container Network Interface) plugins receive a JSON config via stdin and environment variables describing what to do:

```bash
# Environment variables passed to CNI plugin:
# CNI_COMMAND=ADD|DEL|CHECK|VERSION
# CNI_CONTAINERID=<id>
# CNI_NETNS=/proc/<pid>/ns/net  OR  /run/netns/<name>
# CNI_IFNAME=eth0
# CNI_PATH=/opt/cni/bin

# Sample CNI invocation for bridge plugin
cat << 'EOF' | CNI_COMMAND=ADD \
               CNI_CONTAINERID=abc123 \
               CNI_NETNS=/run/netns/mycontainer \
               CNI_IFNAME=eth0 \
               CNI_PATH=/opt/cni/bin \
               /opt/cni/bin/bridge
{
    "cniVersion": "1.0.0",
    "name": "mynet",
    "type": "bridge",
    "bridge": "cni0",
    "isGateway": true,
    "ipMasq": true,
    "ipam": {
        "type": "host-local",
        "subnet": "10.244.0.0/16",
        "routes": [
            {"dst": "0.0.0.0/0"}
        ]
    }
}
EOF
```

### Writing a Minimal CNI Plugin in Go

```go
package main

import (
    "encoding/json"
    "fmt"
    "net"
    "os"
    "os/exec"

    "github.com/containernetworking/cni/pkg/skel"
    "github.com/containernetworking/cni/pkg/types"
    current "github.com/containernetworking/cni/pkg/types/100"
    "github.com/containernetworking/cni/pkg/version"
    "github.com/containernetworking/plugins/pkg/ip"
    "github.com/containernetworking/plugins/pkg/ns"
    "github.com/vishvananda/netlink"
)

type NetConf struct {
    types.NetConf
    Bridge string `json:"bridge"`
    IPNet  string `json:"ipNet"`
}

func cmdAdd(args *skel.CmdArgs) error {
    conf := &NetConf{}
    if err := json.Unmarshal(args.StdinData, conf); err != nil {
        return err
    }

    // Get or create the bridge
    br, err := ensureBridge(conf.Bridge)
    if err != nil {
        return fmt.Errorf("ensure bridge: %w", err)
    }

    // Create veth pair
    hostVeth, containerVeth, err := ip.SetupVeth(args.IfName, br.Attrs().MTU, "", netlink.NewLinkAttrs())
    if err != nil {
        return fmt.Errorf("setup veth: %w", err)
    }

    // Attach host side to bridge
    if err := netlink.LinkSetMaster(hostVeth, br); err != nil {
        return fmt.Errorf("set veth master: %w", err)
    }

    // Enter container namespace and configure the interface
    netNS, err := ns.GetNS(args.Netns)
    if err != nil {
        return fmt.Errorf("get netns: %w", err)
    }
    defer netNS.Close()

    _, ipNet, err := net.ParseCIDR(conf.IPNet)
    if err != nil {
        return err
    }

    if err := netNS.Do(func(_ ns.NetNS) error {
        link, err := netlink.LinkByName(containerVeth.Attrs().Name)
        if err != nil {
            return err
        }
        if err := netlink.AddrAdd(link, &netlink.Addr{IPNet: ipNet}); err != nil {
            return err
        }
        if err := netlink.LinkSetUp(link); err != nil {
            return err
        }
        // Add default route
        gw := ipNet.IP.Mask(ipNet.Mask)
        gw[len(gw)-1] = 1 // .1 gateway
        return netlink.RouteAdd(&netlink.Route{
            LinkIndex: link.Attrs().Index,
            Dst:       &net.IPNet{IP: net.IPv4zero, Mask: net.CIDRMask(0, 32)},
            Gw:        gw,
        })
    }); err != nil {
        return err
    }

    result := &current.Result{
        CNIVersion: current.ImplementedSpecVersion,
        Interfaces: []*current.Interface{
            {Name: args.IfName, Sandbox: args.Netns},
        },
        IPs: []*current.IPConfig{
            {
                Interface: current.Int(0),
                Address:   *ipNet,
            },
        },
    }

    return types.PrintResult(result, conf.CNIVersion)
}

func ensureBridge(name string) (netlink.Link, error) {
    br, err := netlink.LinkByName(name)
    if err == nil {
        return br, nil
    }
    bridge := &netlink.Bridge{
        LinkAttrs: netlink.LinkAttrs{
            Name: name,
            MTU:  1500,
        },
    }
    if err := netlink.LinkAdd(bridge); err != nil {
        return nil, err
    }
    if err := netlink.LinkSetUp(bridge); err != nil {
        return nil, err
    }
    return bridge, nil
}

func cmdDel(args *skel.CmdArgs) error {
    // Delete veth pair by entering the namespace and removing the interface
    netNS, err := ns.GetNS(args.Netns)
    if err != nil {
        // Namespace already gone — idempotent delete
        return nil
    }
    defer netNS.Close()

    return netNS.Do(func(_ ns.NetNS) error {
        link, err := netlink.LinkByName(args.IfName)
        if err != nil {
            return nil // already deleted
        }
        return netlink.LinkDel(link)
    })
}

func main() {
    skel.PluginMain(cmdAdd, nil, cmdDel, version.All, "minimal-bridge CNI plugin")
}
```

## Part 7: Debugging Container Networking

### Tracing Packet Flow

```bash
# Enable iptables packet tracing
iptables -t raw -A PREROUTING -p icmp -j TRACE
iptables -t raw -A OUTPUT -p icmp -j TRACE

# View trace in kernel log
dmesg -w | grep TRACE &

# Generate traffic
ip netns exec mycontainer ping -c 1 8.8.8.8

# Clean up traces
iptables -t raw -D PREROUTING -p icmp -j TRACE
iptables -t raw -D OUTPUT -p icmp -j TRACE
```

### tcpdump Across Namespace Boundaries

```bash
# Capture on bridge (sees all container traffic)
tcpdump -i cni0 -n -v

# Capture on specific veth (one container's traffic)
tcpdump -i veth-mycontai -n -v

# Capture inside container namespace
ip netns exec mycontainer tcpdump -i eth0 -n -v

# Capture and write to file for later analysis
tcpdump -i cni0 -w /tmp/container-traffic.pcap

# Open in Wireshark
wireshark /tmp/container-traffic.pcap
```

### Connectivity Diagnostics Script

```bash
#!/bin/bash
# diagnose-container-net.sh — systematic connectivity check

set -uo pipefail

NS="${1:?Usage: $0 <netns-name>}"

echo "=== Interface Configuration ==="
ip netns exec "$NS" ip addr show

echo "=== Routing Table ==="
ip netns exec "$NS" ip route show

echo "=== DNS Configuration ==="
ip netns exec "$NS" cat /etc/resolv.conf 2>/dev/null || echo "(not mounted)"

echo "=== Gateway Reachability ==="
GW=$(ip netns exec "$NS" ip route show default | awk '{print $3}')
ip netns exec "$NS" ping -c 2 -W 1 "$GW" && echo "PASS" || echo "FAIL"

echo "=== External DNS Reachability (8.8.8.8) ==="
ip netns exec "$NS" ping -c 2 -W 2 8.8.8.8 && echo "PASS" || echo "FAIL"

echo "=== DNS Resolution ==="
ip netns exec "$NS" nslookup kubernetes.default.svc.cluster.local 2>/dev/null || \
    echo "DNS resolution failed"

echo "=== iptables FORWARD rules ==="
iptables -L FORWARD -n -v | grep -E 'cni|veth|10\.244'

echo "=== iptables MASQUERADE rules ==="
iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE

echo "=== conntrack for this container ==="
CONTAINER_IP=$(ip netns exec "$NS" ip addr show | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
conntrack -L 2>/dev/null | grep "$CONTAINER_IP" | head -10 || echo "conntrack not available"
```

## Summary

Linux container networking is built on four kernel primitives that together implement network isolation and connectivity:

1. **Network namespaces** provide the isolation boundary—each container sees only its own interfaces, routes, and iptables rules, entirely independent of the host and other containers.

2. **veth pairs** bridge the isolation boundary—one end lives in the container namespace (appearing as `eth0`), the other in the host namespace (attached to a bridge), creating a virtual wire between the two.

3. **Linux bridges** act as L2 switches, forwarding frames between all connected veth host-ends, enabling direct container-to-container communication without any IP routing or NAT.

4. **iptables MASQUERADE** enables outbound NAT, rewriting the container source IP to the host's external IP so containers can reach external networks without requiring external routing changes.

Every CNI plugin—Flannel, Calico, Cilium, Weave—implements these same primitives, adding overlay networking, BGP routing, or eBPF dataplane optimizations on top of this foundation. Understanding the primitives makes it possible to debug any CNI implementation, write custom network policies, and diagnose connectivity failures at any layer of the stack.
