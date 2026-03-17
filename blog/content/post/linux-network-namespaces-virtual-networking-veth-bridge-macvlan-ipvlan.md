---
title: "Linux Network Namespaces and Virtual Networking: veth, bridge, macvlan, and ipvlan"
date: 2030-03-17T00:00:00-05:00
draft: false
tags: ["Linux", "Network Namespaces", "Virtual Networking", "veth", "macvlan", "ipvlan", "Containers"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux virtual networking internals: creating isolated network stacks with namespaces, bridge networking for containers, macvlan and ipvlan for direct host networking, and tc traffic control for network emulation."
more_link: "yes"
url: "/linux-network-namespaces-virtual-networking-veth-bridge-macvlan-ipvlan/"
---

Every container you run, every Kubernetes Pod that starts, every VM that boots on a Linux hypervisor — all of them depend on Linux virtual networking primitives that have been in the kernel since the 2.6 era. Understanding these primitives at a low level is essential for debugging container networking issues, designing high-performance network architectures, and understanding how CNI plugins like Calico, Cilium, and Flannel actually work under the hood.

This guide covers the complete Linux virtual networking stack: network namespaces for isolation, veth pairs for cross-namespace communication, Linux bridges for multi-container connectivity, and macvlan/ipvlan for direct layer-2 host networking. We also cover traffic control (tc) for network emulation in testing environments.

<!--more-->

## Network Namespaces: Isolated Network Stacks

A network namespace is an isolated instance of the Linux networking stack. Each namespace has its own:
- Network interfaces (including a separate `lo` loopback)
- Routing tables
- iptables rules
- Socket table
- `/proc/net/` virtual filesystem
- Network device sysctl settings

The default (initial) network namespace is the host network namespace. Every process belongs to a network namespace.

### Creating and Managing Network Namespaces

```bash
# Create a new network namespace
ip netns add myns

# List all network namespaces
ip netns list
# myns

# Execute a command in a namespace
ip netns exec myns ip addr
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN group default qlen 1000
#     link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00

# The loopback is DOWN by default - bring it up
ip netns exec myns ip link set lo up

# Get a shell inside the namespace
ip netns exec myns bash
# Everything in this shell runs in myns

# Check which namespace a process is in
ls -la /proc/$(pgrep myapp)/ns/net
# lrwxrwxrwx 1 root root 0 Mar 17 10:00 /proc/12345/ns/net -> 'net:[4026532234]'

# List namespace inodes for all processes
ls -la /proc/*/ns/net | sort -k 11 | uniq -f 10
```

### Namespace Files and Persistence

Network namespaces created with `ip netns add` are persisted as files in `/var/run/netns/`. Without this persistence, a namespace only exists as long as at least one process or file descriptor holds it open.

```bash
# Namespace file location
ls -la /var/run/netns/
# total 0
# drwxr-xr-x  2 root root  60 Mar 17 10:00 .
# drwxr-xr-x 35 root root 960 Mar 17 10:00 ..
# -r--r--r--  1 root root   0 Mar 17 10:00 myns

# The file is a bind-mount of the namespace inode
mount | grep netns
# nsfs on /var/run/netns/myns type nsfs (rw)

# Delete the namespace
ip netns delete myns

# Programmatic namespace creation (without ip netns)
# Creates a namespace and returns a file descriptor
int fd = open("/proc/self/ns/net", O_RDONLY);
unshare(CLONE_NEWNET);  // This process is now in a new network namespace
```

### Namespace Transitions in Go

```go
// namespace/netns.go
package namespace

import (
    "fmt"
    "os"
    "runtime"

    "github.com/vishvananda/netns"
    "golang.org/x/sys/unix"
)

// RunInNamespace executes a function in the specified network namespace
// and returns to the original namespace afterward
func RunInNamespace(nsPath string, fn func() error) error {
    // Lock the goroutine to the current OS thread
    // Network namespace operations affect the thread, not the goroutine
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Save current namespace
    origNS, err := netns.Get()
    if err != nil {
        return fmt.Errorf("getting current namespace: %w", err)
    }
    defer origNS.Close()

    // Open target namespace
    targetNSFile, err := os.Open(nsPath)
    if err != nil {
        return fmt.Errorf("opening namespace %s: %w", nsPath, err)
    }
    defer targetNSFile.Close()

    // Switch to target namespace
    if err := unix.Setns(int(targetNSFile.Fd()), unix.CLONE_NEWNET); err != nil {
        return fmt.Errorf("entering namespace %s: %w", nsPath, err)
    }

    // Ensure we return to original namespace
    defer func() {
        if err := unix.Setns(int(origNS), unix.CLONE_NEWNET); err != nil {
            panic(fmt.Sprintf("failed to restore namespace: %v", err))
        }
    }()

    return fn()
}

// CreateNamespace creates a new network namespace and returns its path
func CreateNamespace(name string) (string, error) {
    path := "/var/run/netns/" + name

    // Create a file for bind-mounting
    f, err := os.Create(path)
    if err != nil {
        return "", fmt.Errorf("creating namespace file: %w", err)
    }
    f.Close()

    // Create the namespace and bind-mount it to the file
    // This requires the new namespace to be created in a thread
    // that is bind-mounted to the path
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    if err := unix.Unshare(unix.CLONE_NEWNET); err != nil {
        os.Remove(path)
        return "", fmt.Errorf("creating network namespace: %w", err)
    }

    // Bind-mount the new namespace to the path
    nsFD := fmt.Sprintf("/proc/self/task/%d/ns/net", unix.Gettid())
    if err := unix.Mount(nsFD, path, "bind", unix.MS_BIND, ""); err != nil {
        os.Remove(path)
        return "", fmt.Errorf("bind-mounting namespace: %w", err)
    }

    return path, nil
}
```

## Virtual Ethernet Pairs (veth)

A veth pair is a virtual network cable: two virtual interfaces linked together so that packets entering one end emerge from the other. veth pairs are the fundamental mechanism for connecting a network namespace to the outside world.

### Creating veth Pairs

```bash
# Create a veth pair: veth0 <-> veth1
ip link add veth0 type veth peer name veth1

# Verify both ends are created
ip link show type veth
# 5: veth1@veth0: <BROADCAST,MULTICAST,M-DOWN> mtu 1500 qdisc noop state DOWN ...
# 6: veth0@veth1: <BROADCAST,MULTICAST,M-DOWN> mtu 1500 qdisc noop state DOWN ...

# Move one end into a network namespace
ip link set veth1 netns myns

# Now veth0 is in the host namespace, veth1 is in myns
ip link show veth0
# 6: veth0@if5: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN

ip netns exec myns ip link show
# 1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN
# 5: veth1@if6: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN

# Configure IP addresses on both ends
ip addr add 10.0.0.1/24 dev veth0
ip netns exec myns ip addr add 10.0.0.2/24 dev veth1

# Bring both interfaces up
ip link set veth0 up
ip netns exec myns ip link set veth1 up

# Test connectivity
ping -c 3 10.0.0.2
# PING 10.0.0.2 (10.0.0.2) 56(84) bytes of data.
# 64 bytes from 10.0.0.2: icmp_seq=1 ttl=64 time=0.062 ms

# Traffic from namespace needs a default route
ip netns exec myns ip route add default via 10.0.0.1

# Enable IP forwarding and NAT on the host for internet access
sysctl -w net.ipv4.ip_forward=1
iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -j MASQUERADE
```

### Configuring veth for Performance

```bash
# Increase veth queue length (default 1000, increase for high-throughput)
ip link set veth0 txqueuelen 10000

# Enable Large Receive Offload (LRO) and Generic Segmentation Offload (GSO)
ethtool -K veth0 gso on gro on

# Set MTU to match physical interface (avoid fragmentation)
ip link set veth0 mtu 1450  # Leave room for tunnel headers

# Check current settings
ethtool -k veth0 | grep -E "gso|gro|tso|rx-checksumming|tx-checksumming"
```

## Linux Bridge: Layer-2 Switching for Containers

A Linux bridge acts as a software layer-2 switch. It forwards Ethernet frames between attached interfaces based on MAC address tables. Docker's default `docker0` bridge, Kubernetes flannel's `cni0`, and many CNI plugins use bridges for container connectivity.

### Creating a Linux Bridge

```bash
# Create the bridge
ip link add name br0 type bridge

# Set bridge properties
ip link set br0 up
ip addr add 172.16.0.1/24 dev br0

# Create namespaces for two "containers"
ip netns add container1
ip netns add container2

# Create veth pairs for each container
ip link add veth-c1 type veth peer name veth-c1-br
ip link add veth-c2 type veth peer name veth-c2-br

# Move one end of each pair to its namespace
ip link set veth-c1 netns container1
ip link set veth-c2 netns container2

# Attach the bridge ends to the bridge
ip link set veth-c1-br master br0
ip link set veth-c2-br master br0

# Bring up the bridge-side interfaces
ip link set veth-c1-br up
ip link set veth-c2-br up

# Configure container interfaces
ip netns exec container1 ip link set lo up
ip netns exec container1 ip link set veth-c1 up
ip netns exec container1 ip addr add 172.16.0.10/24 dev veth-c1
ip netns exec container1 ip route add default via 172.16.0.1

ip netns exec container2 ip link set lo up
ip netns exec container2 ip link set veth-c2 up
ip netns exec container2 ip addr add 172.16.0.20/24 dev veth-c2
ip netns exec container2 ip route add default via 172.16.0.1

# Test container-to-container communication
ip netns exec container1 ping -c 3 172.16.0.20
# 64 bytes from 172.16.0.20: icmp_seq=1 ttl=64 time=0.089 ms

# Test container-to-host communication
ip netns exec container1 ping -c 3 172.16.0.1
# 64 bytes from 172.16.0.1: icmp_seq=1 ttl=64 time=0.044 ms
```

### Bridge Inspection and Troubleshooting

```bash
# Show bridge forwarding database (MAC table)
bridge fdb show br br0
# 33:33:00:00:00:01 dev br0 self permanent
# 33:33:ff:5a:83:7b dev br0 self permanent
# 01:00:5e:00:00:01 dev br0 self permanent
# 52:54:00:5a:83:7b dev veth-c1-br master br0
# 52:54:00:12:34:56 dev veth-c2-br master br0

# Show bridge VLAN information
bridge vlan show

# Monitor bridge events
bridge monitor all

# Show bridge statistics
ip -s link show br0

# Check which interfaces are bridge members
bridge link show
# 7: veth-c1-br@if8: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 master br0 state forwarding
# 9: veth-c2-br@if10: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 master br0 state forwarding

# Capture traffic on the bridge
tcpdump -i br0 -n
```

### VLAN Filtering on Linux Bridges

For more sophisticated network isolation, enable VLAN filtering on the bridge:

```bash
# Create a VLAN-aware bridge
ip link add name br-vlan type bridge vlan_filtering 1

ip link set br-vlan up

# Attach interfaces to the bridge
ip link set veth-c1-br master br-vlan
ip link set veth-c2-br master br-vlan

# Assign VLANs to ports
# container1 on VLAN 10
bridge vlan add vid 10 dev veth-c1-br pvid untagged
bridge vlan del vid 1 dev veth-c1-br  # Remove default VLAN 1

# container2 on VLAN 20
bridge vlan add vid 20 dev veth-c2-br pvid untagged
bridge vlan del vid 1 dev veth-c2-br

# Now container1 and container2 are isolated by VLAN
# They cannot communicate even though they are on the same bridge

# Show VLAN assignments
bridge vlan show
# port    vlan ids
# br-vlan  1 PVID Egress Untagged
# veth-c1-br  10 PVID Egress Untagged
# veth-c2-br  20 PVID Egress Untagged
```

## macvlan: Direct Layer-2 Host Networking

macvlan creates virtual interfaces that appear to have their own MAC address and appear as separate network devices on the physical network. Unlike bridge networking, macvlan has lower overhead because there is no address learning or forwarding database.

### macvlan Modes

```bash
# Four macvlan modes:

# 1. bridge mode: subinterfaces can communicate with each other
ip link add mac0 link eth0 type macvlan mode bridge

# 2. private mode: subinterfaces CANNOT communicate with each other
ip link add mac1 link eth0 type macvlan mode private

# 3. vepa (Virtual Ethernet Port Aggregator): traffic between subinterfaces
#    goes out to the switch and back (requires hairpin mode on switch)
ip link add mac2 link eth0 type macvlan mode vepa

# 4. passthru: only one subinterface allowed, for VM use cases
ip link add mac3 link eth0 type macvlan mode passthru
```

### macvlan for Container Direct Connectivity

macvlan is ideal when containers need to appear as first-class citizens on the physical network (e.g., receiving DHCP addresses from the network DHCP server):

```bash
# Physical interface
PARENT_IFACE=eth0
PARENT_CIDR=192.168.1.0/24
PARENT_GW=192.168.1.1

# Create namespace
ip netns add macvlan-container

# Create macvlan subinterface and move to namespace
ip link add mac-container link $PARENT_IFACE type macvlan mode bridge
ip link set mac-container netns macvlan-container

# Configure inside namespace
ip netns exec macvlan-container ip link set lo up
ip netns exec macvlan-container ip link set mac-container up
ip netns exec macvlan-container ip addr add 192.168.1.100/24 dev mac-container
ip netns exec macvlan-container ip route add default via $PARENT_GW

# Container can now reach external hosts directly
ip netns exec macvlan-container ping 192.168.1.1

# LIMITATION: Container CANNOT communicate with the host's IP
# because macvlan interfaces cannot talk to the parent interface directly
# Workaround: create a macvlan on the host itself for host-to-container comms
ip link add mac-host link $PARENT_IFACE type macvlan mode bridge
ip addr add 192.168.1.200/24 dev mac-host
ip link set mac-host up

# Now host can reach container via mac-host, container can reach host via 192.168.1.200
ip netns exec macvlan-container ping 192.168.1.200
```

### macvlan in Kubernetes (Multus CNI)

macvlan is commonly used in Kubernetes for secondary network interfaces (e.g., high-speed data-plane interfaces for network functions):

```yaml
# NetworkAttachmentDefinition for macvlan (Multus)
apiVersion: "k8s.cni.cncf.io/v1"
kind: NetworkAttachmentDefinition
metadata:
  name: macvlan-conf
  namespace: default
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name": "macvlan-network",
      "type": "macvlan",
      "master": "eth1",
      "mode": "bridge",
      "ipam": {
        "type": "whereabouts",
        "range": "192.168.100.0/24",
        "gateway": "192.168.100.1",
        "routes": [
          {"dst": "192.168.100.0/24"}
        ]
      }
    }
---
# Pod using macvlan secondary interface
apiVersion: v1
kind: Pod
metadata:
  name: network-function
  annotations:
    k8s.v1.cni.cncf.io/networks: macvlan-conf
spec:
  containers:
  - name: nf
    image: network-function:1.0.0
    securityContext:
      capabilities:
        add: ["NET_ADMIN", "NET_RAW"]
```

## ipvlan: Layer-3 Virtual Interfaces

ipvlan is similar to macvlan but operates at Layer 3 (IP layer) rather than Layer 2. All subinterfaces share the parent's MAC address but have unique IP addresses. This is significant because:

1. **No MAC address exhaustion**: Layer-2 switches don't see multiple MACs per port
2. **Works in environments with port security**: Useful in clouds that restrict MAC addresses per NIC
3. **Slightly better performance**: No MAC address learning overhead

### ipvlan Modes

```bash
# ipvlan L2 mode: similar to macvlan but shares MAC
# Subinterfaces can still communicate at L2 via the parent
ip link add ipvl0 link eth0 type ipvlan mode l2

# ipvlan L3 mode: routes between namespaces
# Subinterfaces communicate via routing only
ip link add ipvl1 link eth0 type ipvlan mode l3

# ipvlan L3S mode: L3 with netfilter hooks (for iptables/nftables)
ip link add ipvl2 link eth0 type ipvlan mode l3s
```

### ipvlan L3 Mode: Routed Container Networking

ipvlan L3 mode is particularly interesting for high-performance container networking because it bypasses the Linux bridge entirely and routes traffic directly:

```bash
# Create two namespaces
ip netns add ns1
ip netns add ns2

# Create ipvlan interfaces in each namespace
ip link add ipvl-ns1 link eth0 type ipvlan mode l3
ip link add ipvl-ns2 link eth0 type ipvlan mode l3

ip link set ipvl-ns1 netns ns1
ip link set ipvl-ns2 netns ns2

# Configure IPs in different subnets
ip netns exec ns1 ip link set lo up
ip netns exec ns1 ip link set ipvl-ns1 up
ip netns exec ns1 ip addr add 192.168.10.1/32 dev ipvl-ns1  # /32 - L3 routing
ip netns exec ns1 ip route add default dev ipvl-ns1  # Route all via ipvlan

ip netns exec ns2 ip link set lo up
ip netns exec ns2 ip link set ipvl-ns2 up
ip netns exec ns2 ip addr add 192.168.20.1/32 dev ipvl-ns2
ip netns exec ns2 ip route add default dev ipvl-ns2

# Add host routes for each namespace's IP
# (This would normally be done by a routing daemon or control plane)
ip route add 192.168.10.1/32 dev eth0
ip route add 192.168.20.1/32 dev eth0

# Cross-namespace communication via routing
ip netns exec ns1 ping -c 3 192.168.20.1
```

### macvlan vs ipvlan Comparison

| Feature | macvlan | ipvlan L2 | ipvlan L3 |
|---------|---------|-----------|-----------|
| MAC addresses | Unique per subinterface | Shared (parent MAC) | Shared (parent MAC) |
| Layer | L2 (Ethernet) | L2 (Ethernet) | L3 (IP routing) |
| Port security | Fails (multiple MACs) | Works | Works |
| Promiscuous mode | Required sometimes | Not required | Not required |
| Bridge overhead | None | None | None |
| iptables hooks | Yes | Yes | Only L3S mode |
| DHCP support | Yes | Yes | Complex |
| Suitable for | Direct L2 access | Cloud environments | Routing-based CNI |

## Traffic Control (tc) for Network Emulation

The Linux Traffic Control subsystem (tc) provides powerful tools for network emulation in testing and staging environments. You can simulate packet loss, latency, jitter, bandwidth limits, and more.

### netem: Network Emulation

```bash
# Basic setup: Add 100ms latency to all outgoing traffic on eth0
tc qdisc add dev eth0 root netem delay 100ms

# Verify
tc qdisc show dev eth0
# qdisc netem 8001: root refcnt 2 limit 1000 delay 100ms

# Remove the qdisc
tc qdisc del dev eth0 root

# Add latency with jitter (uniform distribution +/- 20ms)
tc qdisc add dev eth0 root netem delay 100ms 20ms

# Add latency with jitter using correlation (25% correlation)
tc qdisc add dev eth0 root netem delay 100ms 20ms 25%

# Simulate packet loss (1% random loss)
tc qdisc add dev eth0 root netem loss 1%

# Simulate packet loss with correlation (higher packet loss clusters)
tc qdisc add dev eth0 root netem loss 1% 25%

# Simulate packet corruption
tc qdisc add dev eth0 root netem corrupt 0.1%

# Simulate packet duplication
tc qdisc add dev eth0 root netem duplicate 1%

# Simulate packet reordering (10% of packets sent 5ms early)
tc qdisc add dev eth0 root netem delay 10ms reorder 25% 50%

# Combined: latency + loss + bandwidth limit
tc qdisc add dev eth0 root handle 1: tbf rate 10mbit burst 32kbit latency 400ms
tc qdisc add dev eth0 parent 1:1 handle 10: netem delay 50ms loss 2%
```

### Per-Namespace Network Emulation

For container testing, apply emulation within a namespace:

```bash
# Apply 50ms latency + 5% packet loss to container's outbound traffic
ip netns exec mycontainer tc qdisc add dev eth0 root netem delay 50ms loss 5%

# Verify
ip netns exec mycontainer tc qdisc show
# qdisc netem 8001: root refcnt 2 limit 1000 delay 50ms loss 5%

# Test the effect
ip netns exec mycontainer ping -c 20 8.8.8.8 | tail -5
# 20 packets transmitted, 19 received, 5% packet loss
# rtt min/avg/max/mdev = 50.123/50.987/52.345/0.567 ms
```

### Advanced Traffic Control with Filters

```bash
# Using hierarchical token bucket (HTB) for bandwidth limiting
# Create root qdisc
tc qdisc add dev eth0 root handle 1: htb default 30

# Add classes
tc class add dev eth0 parent 1: classid 1:1 htb rate 100mbit

# High-priority class (guaranteed 20mbit, can burst to 100mbit)
tc class add dev eth0 parent 1:1 classid 1:10 htb rate 20mbit ceil 100mbit

# Normal class (guaranteed 10mbit)
tc class add dev eth0 parent 1:1 classid 1:20 htb rate 10mbit ceil 100mbit

# Best-effort class (shares remaining bandwidth)
tc class add dev eth0 parent 1:1 classid 1:30 htb rate 5mbit ceil 100mbit

# Attach netem to best-effort class for latency simulation
tc qdisc add dev eth0 parent 1:30 handle 30: netem delay 100ms loss 1%

# Add filters to classify traffic
# HTTP to high-priority
tc filter add dev eth0 protocol ip parent 1:0 prio 1 u32 \
  match ip dport 80 0xffff flowid 1:10

# HTTPS to high-priority
tc filter add dev eth0 protocol ip parent 1:0 prio 1 u32 \
  match ip dport 443 0xffff flowid 1:10

# Database traffic to normal
tc filter add dev eth0 protocol ip parent 1:0 prio 2 u32 \
  match ip dport 5432 0xffff flowid 1:20

# Everything else to best-effort
# (handled by default class 30)

# View the complete qdisc tree
tc qdisc show dev eth0
tc class show dev eth0
tc filter show dev eth0
```

### Go-Based Network Chaos Testing

```go
// chaos/network.go
package chaos

import (
    "fmt"
    "os/exec"
    "strconv"
)

// NetworkChaosConfig defines network impairment parameters
type NetworkChaosConfig struct {
    // Target interface or namespace
    Interface string
    Namespace string

    // Latency in milliseconds
    Latency     int
    LatencyJitter int

    // Packet loss percentage (0-100)
    PacketLoss float64

    // Bandwidth limit in kbit/s (0 = unlimited)
    BandwidthKbps int

    // Packet corruption percentage
    Corruption float64
}

// Apply installs the tc qdisc rules
func (c *NetworkChaosConfig) Apply() error {
    args := c.buildTcArgs()
    return c.runTc(args...)
}

// Remove removes the tc qdisc rules
func (c *NetworkChaosConfig) Remove() error {
    args := []string{"qdisc", "del", "dev", c.Interface, "root"}
    return c.runTc(args...)
}

func (c *NetworkChaosConfig) buildTcArgs() []string {
    args := []string{"qdisc", "add", "dev", c.Interface}

    if c.BandwidthKbps > 0 {
        // Use HTB + netem for bandwidth + latency
        // Simplified: just use netem with built-in rate limiting
        args = append(args, "root", "netem")
        if c.Latency > 0 {
            args = append(args, "delay", fmt.Sprintf("%dms", c.Latency))
            if c.LatencyJitter > 0 {
                args = append(args, fmt.Sprintf("%dms", c.LatencyJitter))
            }
        }
        if c.PacketLoss > 0 {
            args = append(args, "loss", fmt.Sprintf("%.2f%%", c.PacketLoss))
        }
        if c.Corruption > 0 {
            args = append(args, "corrupt", fmt.Sprintf("%.2f%%", c.Corruption))
        }
        args = append(args, "rate", strconv.Itoa(c.BandwidthKbps)+"kbit")
    } else {
        args = append(args, "root", "netem")
        if c.Latency > 0 {
            args = append(args, "delay", fmt.Sprintf("%dms", c.Latency))
            if c.LatencyJitter > 0 {
                args = append(args, fmt.Sprintf("%dms", c.LatencyJitter))
            }
        }
        if c.PacketLoss > 0 {
            args = append(args, "loss", fmt.Sprintf("%.2f%%", c.PacketLoss))
        }
        if c.Corruption > 0 {
            args = append(args, "corrupt", fmt.Sprintf("%.2f%%", c.Corruption))
        }
    }

    return args
}

func (c *NetworkChaosConfig) runTc(args ...string) error {
    var cmd *exec.Cmd
    if c.Namespace != "" {
        nsArgs := append([]string{"netns", "exec", c.Namespace, "tc"}, args...)
        cmd = exec.Command("ip", nsArgs...)
    } else {
        cmd = exec.Command("tc", args...)
    }

    if out, err := cmd.CombinedOutput(); err != nil {
        return fmt.Errorf("tc command failed: %w\noutput: %s", err, out)
    }
    return nil
}

// Example usage for testing
func ExampleApplyNetworkChaos() {
    config := &NetworkChaosConfig{
        Interface:     "eth0",
        Namespace:     "test-container",
        Latency:       50,
        LatencyJitter: 10,
        PacketLoss:    2.0,
        BandwidthKbps: 10240, // 10 Mbps
    }

    if err := config.Apply(); err != nil {
        fmt.Printf("Failed to apply network chaos: %v\n", err)
        return
    }

    fmt.Println("Network chaos applied successfully")
    // Run your tests here

    if err := config.Remove(); err != nil {
        fmt.Printf("Failed to remove network chaos: %v\n", err)
    }
}
```

## Debugging Virtual Networks

### Essential Debugging Commands

```bash
# Check all network namespaces
ip netns list
lsns -t net  # Show all net namespaces with process info

# Trace packet path across namespaces
# On host - watch for packets entering/leaving bridge
tcpdump -i br0 -n -e

# On bridge interface
tcpdump -i veth-c1-br -n

# Inside namespace
ip netns exec container1 tcpdump -i veth-c1 -n

# Check routing at each hop
ip netns exec container1 ip route
ip route

# Trace the route
ip netns exec container1 traceroute 8.8.8.8

# Check ARP tables
ip neigh show  # Host ARP table
ip netns exec container1 ip neigh show  # Container ARP table

# Show bridge forwarding database
bridge fdb show br br0

# Monitor network events in real time
ip monitor all

# Check netfilter conntrack
conntrack -L  # List all connections
conntrack -L -p tcp --dport 80  # Filter by port

# Check iptables rules affecting virtual networking
iptables -L -v -n -t nat
iptables -L -v -n -t filter

# Performance measurement with iperf3
# Server (in container)
ip netns exec container1 iperf3 -s

# Client (from host)
iperf3 -c 172.16.0.10 -t 10
```

### Kernel Parameters for Virtual Networking

```bash
# Increase bridge netfilter callchain depth (needed for some CNI plugins)
sysctl -w net.bridge.bridge-nf-call-iptables=1
sysctl -w net.bridge.bridge-nf-call-ip6tables=1
sysctl -w net.bridge.bridge-nf-call-arptables=1

# Increase ARP cache entries (needed for large container deployments)
sysctl -w net.ipv4.neigh.default.gc_thresh1=1024
sysctl -w net.ipv4.neigh.default.gc_thresh2=4096
sysctl -w net.ipv4.neigh.default.gc_thresh3=8192

# Increase number of network namespaces
# (max is limited by kernel memory)
sysctl -w user.max_net_namespaces=65535

# For macvlan/ipvlan: ensure enough MAC addresses
# and check multicast group limits
sysctl -w net.ipv4.conf.all.rp_filter=0
sysctl -w net.ipv4.conf.eth0.rp_filter=0

# Persist in /etc/sysctl.d/
cat > /etc/sysctl.d/99-container-networking.conf << 'EOF'
net.bridge.bridge-nf-call-iptables=1
net.bridge.bridge-nf-call-ip6tables=1
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
net.ipv4.neigh.default.gc_thresh1=1024
net.ipv4.neigh.default.gc_thresh2=4096
net.ipv4.neigh.default.gc_thresh3=8192
EOF

sysctl -p /etc/sysctl.d/99-container-networking.conf
```

## Key Takeaways

Linux virtual networking primitives form the foundation of all container and virtualization networking:

**Network namespaces** provide complete isolation of the networking stack. Every container runtime creates a namespace per container, linking it to the host via veth pairs.

**veth pairs** are the virtual cables that connect namespaces to each other or to a bridge. They are created in pairs and are always linked — packets entering one end emerge from the other with near-zero overhead.

**Linux bridges** provide Layer-2 switching between veth pairs, enabling multiple containers to communicate on the same virtual network segment. Docker's `docker0` and Kubernetes CNI plugins like Flannel use bridges as their core connectivity mechanism.

**macvlan** provides direct Layer-2 connectivity to the physical network without bridge overhead. Ideal for network functions and environments where containers need real network-layer presence. The inability to communicate with the parent interface's IP is its main limitation.

**ipvlan L3** shares the parent's MAC address (valuable in cloud environments with port security) and routes between namespaces at Layer 3, bypassing the bridge entirely for better performance in high-throughput scenarios.

**tc/netem** provides production-grade network emulation in test environments. Testing application resilience to latency, packet loss, and bandwidth constraints before production deployment prevents outages from network-level failures.

Understanding these primitives allows you to debug CNI plugin issues, design custom networking solutions, and reason about the performance characteristics of your container networking stack.
