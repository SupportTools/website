---
title: "Linux Kernel Network Namespaces: Bridge, Macvlan, and IPVLAN"
date: 2029-08-17T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Kubernetes", "CNI", "Network Namespaces", "Macvlan", "IPVLAN"]
categories: ["Linux", "Networking", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux kernel network namespaces covering bridge networking internals, macvlan modes (bridge/private/vepa/passthru), ipvlan L2/L3 modes, and the CNI implications for Kubernetes networking."
more_link: "yes"
url: "/linux-kernel-network-namespaces-bridge-macvlan-ipvlan/"
---

Linux network namespaces are the foundational kernel primitive that enables container networking. Understanding how bridge, macvlan, and ipvlan devices work — and how the kernel routes packets between them — is essential for anyone operating Kubernetes at scale or building custom CNI plugins. This post goes deep into the internals, covering packet flows, kernel data structures, and the tradeoffs that matter in production environments.

<!--more-->

# Linux Kernel Network Namespaces: Bridge, Macvlan, and IPVLAN

## The Network Namespace Primitive

A network namespace is an isolated copy of the network stack. Each namespace has its own set of network interfaces, routing tables, ARP tables, netfilter rules, and socket table. Processes inside a namespace see only the interfaces belonging to that namespace.

```bash
# Create a new network namespace
ip netns add myns

# List network namespaces
ip netns list

# Execute a command inside the namespace
ip netns exec myns ip link show

# View namespace-specific routing table
ip netns exec myns ip route show

# Check the namespace's loopback interface
ip netns exec myns ip link set lo up
ip netns exec myns ping 127.0.0.1 -c 1
```

### Kernel Implementation

Network namespaces are represented by the `struct net` in the kernel. Each net structure contains:

- `dev_base_head` — linked list of network devices
- `loopback_dev` — the loopback device
- `proc_net` — /proc/net entry for the namespace
- `nf_hooks` — netfilter hooks specific to the namespace

```c
// Simplified view of struct net (from include/net/net_namespace.h)
struct net {
    refcount_t              passive;
    spinlock_t              rules_mod_lock;
    atomic_t                dev_unreg_count;
    struct list_head        list;
    struct net_device      *loopback_dev;
    struct netns_core       core;
    struct netns_mib        mib;
    struct netns_packet     packet;
    struct netns_unix       unx;
    struct netns_nexthop    nexthop;
    struct netns_ipv4       ipv4;
    // ... many more subsystems
};
```

### Creating Namespaces Programmatically

Go programs (CNI plugins) use the `clone` or `unshare` syscalls with `CLONE_NEWNET`:

```go
package main

import (
    "fmt"
    "os"
    "runtime"
    "syscall"

    "github.com/vishvananda/netlink"
    "github.com/vishvananda/netns"
)

func createNetworkNamespace(name string) (netns.NsHandle, error) {
    // Lock OS thread — namespace operations are per-thread in Linux
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Save the current namespace
    origns, err := netns.Get()
    if err != nil {
        return -1, fmt.Errorf("getting current netns: %w", err)
    }
    defer origns.Close()

    // Create a new named namespace by bind-mounting
    nspath := fmt.Sprintf("/var/run/netns/%s", name)
    if err := os.MkdirAll("/var/run/netns", 0755); err != nil {
        return -1, err
    }

    f, err := os.OpenFile(nspath, os.O_RDONLY|os.O_CREATE|os.O_EXCL, 0444)
    if err != nil {
        return -1, fmt.Errorf("creating netns file: %w", err)
    }
    f.Close()

    // Create the namespace
    newns, err := netns.New()
    if err != nil {
        return -1, fmt.Errorf("creating new netns: %w", err)
    }

    // Bind-mount to persist beyond process lifetime
    if err := syscall.Mount(fmt.Sprintf("/proc/self/fd/%d", int(newns)),
        nspath, "", syscall.MS_BIND, ""); err != nil {
        newns.Close()
        return -1, fmt.Errorf("bind mounting netns: %w", err)
    }

    // Return to original namespace
    if err := netns.Set(origns); err != nil {
        return -1, fmt.Errorf("restoring original netns: %w", err)
    }

    return newns, nil
}
```

## Bridge Networking Internals

A Linux bridge operates at Layer 2. It maintains a forwarding database (FDB) mapping MAC addresses to bridge ports, learns MAC addresses from incoming frames, and forwards or floods based on FDB lookups.

### Bridge Architecture

```
    eth0 (host)
       |
    br0 (bridge)
    /       \
veth0      veth2
  |           |
veth1      veth3
  |           |
 ns1         ns2
```

### Setting Up a Bridge with veth Pairs

```bash
# Create the bridge
ip link add br0 type bridge
ip link set br0 up

# Set bridge parameters for container networking
# Disable STP (Spanning Tree Protocol) — not needed for simple topologies
ip link set br0 type bridge stp_state 0

# Set forward delay to 0 for immediate forwarding
ip link set br0 type bridge forward_delay 0

# Create namespace 1
ip netns add ns1
ip link add veth0 type veth peer name veth1
ip link set veth0 master br0
ip link set veth0 up
ip link set veth1 netns ns1
ip netns exec ns1 ip link set veth1 up
ip netns exec ns1 ip addr add 10.0.0.2/24 dev veth1

# Create namespace 2
ip netns add ns2
ip link add veth2 type veth peer name veth3
ip link set veth2 master br0
ip link set veth2 up
ip link set veth3 netns ns2
ip netns exec ns2 ip link set veth3 up
ip netns exec ns2 ip addr add 10.0.0.3/24 dev veth3

# Add IP to the bridge for host access
ip addr add 10.0.0.1/24 dev br0

# Enable IP forwarding for outbound access
echo 1 > /proc/sys/net/ipv4/ip_forward

# Add NAT masquerade for outbound traffic
iptables -t nat -A POSTROUTING -s 10.0.0.0/24 ! -o br0 -j MASQUERADE
ip netns exec ns1 ip route add default via 10.0.0.1
ip netns exec ns2 ip route add default via 10.0.0.1

# Test connectivity
ip netns exec ns1 ping 10.0.0.3 -c 3
```

### Bridge FDB Inspection

```bash
# View the bridge forwarding database
bridge fdb show dev br0

# View bridge port state
bridge link show

# Monitor bridge FDB learning events
bridge monitor fdb

# View bridge VLAN filtering table (if enabled)
bridge vlan show

# Enable VLAN filtering on bridge
ip link set br0 type bridge vlan_filtering 1
bridge vlan add vid 100 dev veth0
bridge vlan add vid 100 dev veth2
```

### Kernel Bridge Packet Flow

When a frame arrives on a bridge port, the kernel follows this path:

1. `netif_receive_skb()` receives the frame
2. `br_handle_frame()` is called via the bridge's `rx_handler`
3. FDB lookup determines destination port
4. If found: `br_forward()` sends to specific port
5. If not found: `br_flood()` sends to all ports except source
6. MAC learning updates FDB via `br_fdb_update()`

```bash
# Verify bridge packet flow with tcpdump
# Watch ARP requests being flooded
tcpdump -i br0 -n arp &
tcpdump -i veth0 -n arp &

# First ping triggers ARP flood
ip netns exec ns1 ping 10.0.0.3 -c 1

# After learning, traffic is unicast
ip netns exec ns1 ping 10.0.0.3 -c 3
```

### Bridge and netfilter

Kubernetes relies heavily on iptables/nftables for service load balancing. Bridge traffic must traverse netfilter for this to work:

```bash
# Enable bridge netfilter (required for kube-proxy)
modprobe br_netfilter
echo 1 > /proc/sys/net/bridge/bridge-nf-call-iptables
echo 1 > /proc/sys/net/bridge/bridge-nf-call-ip6tables

# Verify the settings
sysctl net.bridge.bridge-nf-call-iptables
sysctl net.bridge.bridge-nf-call-ip6tables

# Make persistent
cat >> /etc/sysctl.d/99-kubernetes-cri.conf << 'EOF'
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sysctl --system
```

## Macvlan Modes

Macvlan allows creating virtual network interfaces that share a physical interface but have their own MAC addresses. Each macvlan interface appears as a distinct Ethernet device to the network.

### Macvlan vs Bridge: Key Difference

With a bridge, traffic between containers goes: container -> veth -> bridge -> veth -> container.
With macvlan, traffic goes directly: container -> macvlan -> physical NIC driver. No bridge FDB lookups, no veth overhead.

### Mode 1: Bridge Mode

In bridge mode, macvlan interfaces on the same parent can communicate directly through the parent interface driver — the kernel short-circuits and delivers frames without hitting the wire.

```bash
# Create macvlan interfaces in bridge mode
ip link add macvlan1 link eth0 type macvlan mode bridge
ip link add macvlan2 link eth0 type macvlan mode bridge

ip netns add mns1
ip netns add mns2

ip link set macvlan1 netns mns1
ip link set macvlan2 netns mns2

ip netns exec mns1 ip link set macvlan1 up
ip netns exec mns1 ip addr add 192.168.1.10/24 dev macvlan1

ip netns exec mns2 ip link set macvlan2 up
ip netns exec mns2 ip addr add 192.168.1.11/24 dev macvlan2

# mns1 can communicate with mns2 directly
ip netns exec mns1 ping 192.168.1.11 -c 3

# BUT: macvlan interfaces cannot communicate with the host's eth0 IP
# This is a key limitation of macvlan
```

### Mode 2: Private Mode

Private mode is bridge mode with inter-macvlan communication disabled. Each macvlan interface is isolated from all others on the same parent — traffic must leave and return through an external switch.

```bash
ip link add macvlan_priv1 link eth0 type macvlan mode private
ip link add macvlan_priv2 link eth0 type macvlan mode private

# Interfaces with private mode cannot reach each other
# even on the same host — useful for tenant isolation
```

### Mode 3: VEPA Mode (Virtual Ethernet Port Aggregator)

VEPA mode sends all traffic out through the parent interface, including traffic destined for other macvlan interfaces on the same parent. This requires a VEPA-capable switch or a hairpin-mode enabled parent to reflect traffic back.

```bash
ip link add macvlan_vepa1 link eth0 type macvlan mode vepa
ip link add macvlan_vepa2 link eth0 type macvlan mode vepa

# All traffic exits to the external switch
# The switch handles forwarding and enforces policy
# Useful when external switch provides advanced filtering
```

### Mode 4: Passthrough Mode

Passthrough mode gives a single macvlan interface exclusive access to the parent, allowing it to set the parent's MAC address and use promiscuous mode. Only one passthrough interface per parent.

```bash
ip link add macvlan_pass link eth0 type macvlan mode passthru

# The macvlan interface can now change its MAC address
ip netns add pass_ns
ip link set macvlan_pass netns pass_ns
ip netns exec pass_ns ip link set macvlan_pass address aa:bb:cc:dd:ee:ff
ip netns exec pass_ns ip link set macvlan_pass up
```

### Macvlan Performance Characteristics

```bash
# Benchmark macvlan vs veth+bridge
# Install iperf3 in both namespaces
ip netns exec mns1 iperf3 -s -D
ip netns exec mns2 iperf3 -c 192.168.1.10 -t 30 -J > macvlan_bench.json

# Compare with bridge
ip netns exec ns2 iperf3 -c 10.0.0.2 -t 30 -J > bridge_bench.json

# Macvlan typically shows 10-15% lower CPU for intra-host traffic
# due to avoiding the bridge FDB lookup and veth overhead
```

## IPVLAN Modes

IPVLAN is similar to macvlan but operates differently: all IPVLAN interfaces on a parent share the same MAC address as the parent, and the differentiation is done by IP address at Layer 3.

### Why IPVLAN Matters

In environments where you're limited in the number of MAC addresses per port (cloud environments with MAC address restrictions, SR-IOV with limited VFs), IPVLAN is preferred over macvlan.

### IPVLAN L2 Mode

In L2 mode, IPVLAN behaves similarly to macvlan bridge mode but uses the parent's MAC address. The kernel demultiplexes incoming frames by IP address rather than MAC.

```bash
# Create IPVLAN interfaces in L2 mode
ip link add ipvlan1 link eth0 type ipvlan mode l2
ip link add ipvlan2 link eth0 type ipvlan mode l2

ip netns add ins1
ip netns add ins2

ip link set ipvlan1 netns ins1
ip link set ipvlan2 netns ins2

ip netns exec ins1 ip link set ipvlan1 up
ip netns exec ins1 ip addr add 10.20.0.10/24 dev ipvlan1
ip netns exec ins1 ip route add default dev ipvlan1

ip netns exec ins2 ip link set ipvlan2 up
ip netns exec ins2 ip addr add 10.20.0.11/24 dev ipvlan2
ip netns exec ins2 ip route add default dev ipvlan2

# L2 mode: containers share parent's MAC
ip netns exec ins1 ip link show ipvlan1
ip netns exec ins2 ip link show ipvlan2
# Both show the same MAC as eth0
```

### IPVLAN L3 Mode

L3 mode is more restrictive and more efficient. The kernel does not process ARP or Neighbor Discovery for IPVLAN L3 interfaces. Each interface operates as a separate router endpoint. The parent interface routes between ipvlan interfaces using the kernel routing table — no L2 broadcast traffic at all.

```bash
# Create IPVLAN in L3 mode
ip link add ipvlan_l3_1 link eth0 type ipvlan mode l3
ip link add ipvlan_l3_2 link eth0 type ipvlan mode l3

ip netns add l3ns1
ip netns add l3ns2

ip link set ipvlan_l3_1 netns l3ns1
ip link set ipvlan_l3_2 netns l3ns2

# In L3 mode, each interface can have a different subnet
ip netns exec l3ns1 ip link set ipvlan_l3_1 up
ip netns exec l3ns1 ip addr add 10.30.1.1/32 dev ipvlan_l3_1
ip netns exec l3ns1 ip route add default dev ipvlan_l3_1

ip netns exec l3ns2 ip link set ipvlan_l3_2 up
ip netns exec l3ns2 ip addr add 10.30.2.1/32 dev ipvlan_l3_2
ip netns exec l3ns2 ip route add default dev ipvlan_l3_2

# Add host routes for routing between namespaces
ip route add 10.30.1.0/24 dev ipvlan_l3_1 2>/dev/null || true
ip route add 10.30.2.0/24 dev ipvlan_l3_2 2>/dev/null || true

# No ARP — L3 routing only
ip netns exec l3ns1 ping 10.30.2.1 -c 3
```

### IPVLAN L3S Mode

L3S (L3 Symmetric) mode extends L3 mode by using the tc (traffic control) subsystem to simulate a routing device. It allows external hosts to route back to the containers using the parent interface as a gateway.

```bash
ip link add ipvlan_l3s link eth0 type ipvlan mode l3s
# L3S is designed for use with eBPF-based CNI plugins
# that need symmetric routing without bridge overhead
```

### IPVLAN vs Macvlan Decision Matrix

```
Criteria                    | Macvlan Bridge  | IPVLAN L2  | IPVLAN L3
----------------------------|-----------------|------------|----------
MAC address per container   | Yes             | No         | No
ARP/NDP traffic             | Yes             | Yes        | No
Broadcast containment       | No              | No         | Yes
Cloud MAC restrictions      | Problematic     | OK         | OK
Intra-host performance      | High            | High       | Highest
L2 multicast support        | Yes             | Yes        | No
Direct external routing     | Yes             | Yes        | Requires routes
```

## Kubernetes CNI Implications

### How CNI Plugins Use These Primitives

The Container Network Interface (CNI) specification defines how container runtimes attach network interfaces to containers (network namespaces). Different CNI plugins use different kernel primitives:

```
Plugin          | Primitive Used      | Notes
----------------|---------------------|----------------------------------
flannel vxlan   | bridge + vxlan      | overlay, universal compatibility
flannel host-gw | bridge + routing   | no overlay, requires L2 adjacency
calico          | routing + iptables  | no bridge by default, BGP
cilium          | eBPF + veth        | replaces iptables with eBPF
macvlan CNI     | macvlan             | high performance, direct attach
ipvlan CNI      | ipvlan              | cloud-friendly, no extra MACs
```

### Flannel CNI Bridge Mode — Internal Flow

```bash
# Inspect what flannel creates on a node
ip link show type bridge    # cni0 bridge
ip link show type veth      # veth pairs to pods
ip link show type vxlan     # flannel.1 overlay device
bridge fdb show dev flannel.1  # VTEP entries for remote nodes

# Pod-to-pod on same node:
# pod-ns:eth0 -> veth -> cni0 -> veth -> pod-ns:eth0

# Pod-to-pod cross-node:
# pod-ns:eth0 -> veth -> cni0 -> flannel.1 (vxlan) -> eth0 -> wire
# -> remote eth0 -> flannel.1 -> cni0 -> veth -> pod-ns:eth0
```

### Calico CNI — No Bridge Mode

Calico uses direct kernel routing without a bridge. Each pod gets a veth pair where the host end has no IP address, and the kernel routes to the pod via a `/32` host route:

```bash
# Inspect Calico routing
ip route show | grep cali  # Per-pod /32 routes
ip link show type veth     # cali* interfaces — one per pod

# The host end of the veth has proxy ARP enabled
# This allows pods to use any gateway IP
cat /proc/sys/net/ipv4/conf/cali*/proxy_arp
# Output: 1 (for each calico interface)

# RPF check disabled for calico interfaces
cat /proc/sys/net/ipv4/conf/cali*/rp_filter
# Output: 0
```

### Writing a Simple CNI Plugin

```go
package main

import (
    "encoding/json"
    "fmt"
    "net"
    "os"
    "runtime"

    "github.com/containernetworking/cni/pkg/skel"
    "github.com/containernetworking/cni/pkg/types"
    current "github.com/containernetworking/cni/pkg/types/100"
    "github.com/containernetworking/cni/pkg/version"
    "github.com/containernetworking/plugins/pkg/ip"
    "github.com/containernetworking/plugins/pkg/ns"
    "github.com/vishvananda/netlink"
)

func init() {
    // Lock OS thread for namespace operations
    runtime.LockOSThread()
}

type NetConf struct {
    types.NetConf
    BridgeName string `json:"bridge"`
    Subnet     string `json:"subnet"`
    Gateway    string `json:"gateway"`
}

func cmdAdd(args *skel.CmdArgs) error {
    conf := &NetConf{}
    if err := json.Unmarshal(args.StdinData, conf); err != nil {
        return fmt.Errorf("parsing config: %w", err)
    }

    // Get or create bridge
    br, err := ensureBridge(conf.BridgeName)
    if err != nil {
        return err
    }

    // Open the container's network namespace
    netns, err := ns.GetNS(args.Netns)
    if err != nil {
        return fmt.Errorf("opening netns: %w", err)
    }
    defer netns.Close()

    // Create veth pair
    hostVeth, contVeth, err := ip.SetupVethWithName(
        args.IfName,    // name inside container
        "veth"+args.ContainerID[:8], // name on host
        1500,          // MTU
        "",            // host namespace
        netns,         // container namespace
    )
    if err != nil {
        return fmt.Errorf("creating veth: %w", err)
    }

    // Attach host end to bridge
    hostLink, err := netlink.LinkByName(hostVeth.Name)
    if err != nil {
        return err
    }
    if err := netlink.LinkSetMaster(hostLink, br); err != nil {
        return fmt.Errorf("attaching veth to bridge: %w", err)
    }

    // Configure IP inside container namespace
    _, ipNet, _ := net.ParseCIDR(conf.Subnet)
    contIP := allocateIP(ipNet) // simplified allocation

    result := &current.Result{
        CNIVersion: current.ImplementedSpecVersion,
        IPs: []*current.IPConfig{
            {
                Interface: current.Int(1),
                Address:   net.IPNet{IP: contIP, Mask: ipNet.Mask},
                Gateway:   net.ParseIP(conf.Gateway),
            },
        },
    }

    _ = contVeth // used implicitly through netns operations
    return types.PrintResult(result, conf.CNIVersion)
}

func ensureBridge(name string) (*netlink.Bridge, error) {
    br := &netlink.Bridge{
        LinkAttrs: netlink.LinkAttrs{
            Name:   name,
            MTU:    1500,
            TxQLen: -1,
        },
    }

    existing, err := netlink.LinkByName(name)
    if err == nil {
        if b, ok := existing.(*netlink.Bridge); ok {
            return b, nil
        }
    }

    if err := netlink.LinkAdd(br); err != nil {
        return nil, fmt.Errorf("adding bridge: %w", err)
    }
    if err := netlink.LinkSetUp(br); err != nil {
        return nil, err
    }
    return br, nil
}

func allocateIP(ipNet *net.IPNet) net.IP {
    // Simplified: return .2 of the subnet
    ip := make(net.IP, len(ipNet.IP))
    copy(ip, ipNet.IP)
    ip[len(ip)-1] = 2
    return ip
}

func cmdDel(args *skel.CmdArgs) error {
    // Clean up veth pair (deleting one end removes both)
    netns, err := ns.GetNS(args.Netns)
    if err != nil {
        return nil // namespace already gone
    }
    defer netns.Close()

    return netns.Do(func(_ ns.NetNS) error {
        link, err := netlink.LinkByName(args.IfName)
        if err != nil {
            return nil // already removed
        }
        return netlink.LinkDel(link)
    })
}

func main() {
    skel.PluginMain(cmdAdd, cmdCheck, cmdDel,
        version.All, "simple-bridge-cni")
}

func cmdCheck(args *skel.CmdArgs) error {
    return nil
}
```

### CNI Configuration Examples

```json
// Bridge CNI configuration
{
    "cniVersion": "1.0.0",
    "name": "mynet",
    "type": "bridge",
    "bridge": "cni0",
    "isGateway": true,
    "ipMasq": true,
    "hairpinMode": true,
    "ipam": {
        "type": "host-local",
        "subnet": "10.85.0.0/16",
        "routes": [
            {"dst": "0.0.0.0/0"}
        ]
    }
}
```

```json
// Macvlan CNI configuration
{
    "cniVersion": "1.0.0",
    "name": "macvlan-conf",
    "type": "macvlan",
    "master": "eth0",
    "mode": "bridge",
    "ipam": {
        "type": "host-local",
        "subnet": "192.168.1.0/24",
        "rangeStart": "192.168.1.200",
        "rangeEnd": "192.168.1.220",
        "routes": [
            {"dst": "0.0.0.0/0", "gw": "192.168.1.1"}
        ],
        "gateway": "192.168.1.1"
    }
}
```

```json
// IPVLAN CNI configuration
{
    "cniVersion": "1.0.0",
    "name": "ipvlan-conf",
    "type": "ipvlan",
    "master": "eth0",
    "mode": "l3",
    "ipam": {
        "type": "host-local",
        "subnet": "10.1.2.0/24",
        "routes": [
            {"dst": "0.0.0.0/0", "gw": "10.1.2.1"}
        ]
    }
}
```

## Performance Tuning and Troubleshooting

### Namespace Network Observability

```bash
# Trace packets across namespace boundaries
# Install and use nsenter to enter namespaces
nsenter --net=/run/netns/myns -- tcpdump -i any -n

# Monitor bridge statistics
watch -n1 'bridge -s link show'

# Check per-interface statistics for bridge ports
ip -s link show dev br0

# Monitor netfilter conntrack across namespaces
conntrack -E -n    # namespace-aware conntrack monitoring

# Detect ARP storms
tcpdump -i br0 arp -n | awk '{print $NF}' | sort | uniq -c | sort -rn | head
```

### Common Production Issues

```bash
# Issue 1: Containers can't reach host IP through bridge
# Root cause: macvlan/ipvlan limitation — parent can't talk to children
# Fix: Use a secondary macvlan on the host side
ip link add macvlan-host link eth0 type macvlan mode bridge
ip addr add 192.168.1.1/24 dev macvlan-host
ip link set macvlan-host up

# Issue 2: Bridge netfilter not working after reboot
# Ensure br_netfilter module loads at boot
echo br_netfilter > /etc/modules-load.d/br_netfilter.conf

# Issue 3: High CPU from bridge flooding
# Enable multicast snooping to reduce flood domains
ip link set br0 type bridge mcast_snooping 1

# Issue 4: MTU mismatch causing packet drops
# Check MTU across the path
ip netns exec myns ip link show  # check container MTU
ip link show br0                 # check bridge MTU
# Set consistent MTU
ip link set br0 mtu 1450  # account for VXLAN overhead
ip link set veth0 mtu 1450
```

### eBPF-Based Monitoring of Bridge Traffic

```bash
# Use bpftrace to monitor bridge forwarding decisions
bpftrace -e '
kprobe:br_forward {
    printf("bridge forward: dev=%s dst_mac=%llx\n",
        ((struct net_device *)arg0)->name,
        *(uint64_t *)arg1
    );
}'

# Count packet rates per bridge port
bpftrace -e '
kprobe:br_handle_frame_finish {
    @pkts[((struct net_bridge_port *)arg1)->dev->name]++;
}
interval:s:5 {
    print(@pkts);
    clear(@pkts);
}'
```

## Summary

Linux network namespaces, bridges, macvlan, and ipvlan form the building blocks of all container networking. The choice between them involves tradeoffs:

- **Bridge + veth**: Universal compatibility, iptables/nftables integration, moderate overhead
- **Macvlan bridge**: Higher throughput for intra-host traffic, no bridge FDB, but host-to-container communication requires extra work
- **IPVLAN L2**: Cloud-friendly (fewer MACs), similar performance to macvlan
- **IPVLAN L3**: No ARP/NDP overhead, pure routing, best for large-scale overlay-free deployments

Understanding these primitives is essential when debugging Kubernetes networking issues, building CNI plugins, or optimizing network performance in production containerized environments.
