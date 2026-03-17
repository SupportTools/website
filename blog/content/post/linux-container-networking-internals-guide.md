---
title: "Linux Container Networking: veth Pairs, Network Namespaces, and CNI Plugin Internals"
date: 2028-04-22T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "CNI", "Containers", "veth", "iptables"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Linux container networking from first principles: network namespaces, veth pairs, bridge devices, iptables NAT, CNI plugin architecture, and how Kubernetes networking actually works at the kernel level."
more_link: "yes"
url: "/linux-container-networking-internals-guide/"
---

Every time a Kubernetes pod is created, the runtime executes a sequence of Linux kernel operations to give that pod a private network stack. Understanding these operations is essential for debugging network failures, writing CNI plugins, and making sense of what tools like `tcpdump`, `conntrack`, and `ip netns` report. This guide builds the entire container networking model from the ground up, starting with raw kernel primitives and ending with how Flannel and Cilium implement Kubernetes pod networking.

<!--more-->

# Linux Container Networking Internals

## Network Namespaces

A network namespace is a complete, isolated copy of the Linux network stack: its own set of network interfaces, routing table, iptables rules, and socket table. The root network namespace (the host) is where physical NICs live. Containers get their own namespace.

```bash
# Create a network namespace named "container1"
ip netns add container1

# List namespaces
ip netns list

# Execute a command inside the namespace
ip netns exec container1 ip link show
# lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN

# The namespace has no connectivity yet — only loopback
ip netns exec container1 ip route show
# (empty)
```

The namespace's loopback interface starts down. Bring it up:

```bash
ip netns exec container1 ip link set lo up
ip netns exec container1 ping -c1 127.0.0.1
# PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.
# 64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.028 ms
```

## veth Pairs

A **veth** (virtual Ethernet) pair is a kernel-level Ethernet cable: a packet written to one end appears at the other end. One peer lives in the host namespace; the other lives inside the container namespace.

```bash
# Create a veth pair: veth0 (host) ↔ veth1 (container)
ip link add veth0 type veth peer name veth1

# Move veth1 into the container namespace
ip link set veth1 netns container1

# Now veth1 is only visible inside the namespace
ip link show veth1
# Device "veth1" does not exist.

ip netns exec container1 ip link show veth1
# 4: veth1@if5: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN
```

Assign IP addresses and bring up both ends:

```bash
# Host side
ip addr add 10.200.0.1/24 dev veth0
ip link set veth0 up

# Container side
ip netns exec container1 ip addr add 10.200.0.2/24 dev veth1
ip netns exec container1 ip link set veth1 up

# Test connectivity
ping -c3 10.200.0.2
# 64 bytes from 10.200.0.2: icmp_seq=1 ttl=64 time=0.073 ms
```

## The Linux Bridge

For multiple containers to communicate with each other and with the outside world, a bridge device acts as a virtual switch.

```bash
# Create the bridge
ip link add br0 type bridge
ip addr add 172.20.0.1/16 dev br0
ip link set br0 up

# Create two veth pairs for two "containers"
ip link add veth-c1 type veth peer name veth-c1-br
ip link add veth-c2 type veth peer name veth-c2-br

# Move container-side peers into namespaces
ip netns add ns1
ip netns add ns2
ip link set veth-c1 netns ns1
ip link set veth-c2 netns ns2

# Attach bridge-side peers to the bridge
ip link set veth-c1-br master br0
ip link set veth-c2-br master br0
ip link set veth-c1-br up
ip link set veth-c2-br up

# Configure IPs inside namespaces
ip netns exec ns1 ip addr add 172.20.0.2/16 dev veth-c1
ip netns exec ns1 ip link set veth-c1 up
ip netns exec ns1 ip route add default via 172.20.0.1

ip netns exec ns2 ip addr add 172.20.0.3/16 dev veth-c2
ip netns exec ns2 ip link set veth-c2 up
ip netns exec ns2 ip route add default via 172.20.0.1

# Container-to-container communication
ip netns exec ns1 ping -c3 172.20.0.3
# 64 bytes from 172.20.0.3: icmp_seq=1 ttl=64 time=0.112 ms
```

This is exactly what Docker's `docker0` bridge does, and what the `bridge` CNI plugin does for Kubernetes.

## iptables NAT: Container-to-Internet

Traffic from the container subnet must be masqueraded when leaving the host's physical NIC:

```bash
# Enable IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward

# Masquerade container traffic leaving the host
iptables -t nat -A POSTROUTING \
  -s 172.20.0.0/16 \
  ! -d 172.20.0.0/16 \
  -j MASQUERADE

# Allow forwarding between bridge and external interface
iptables -A FORWARD -i br0 -o eth0 -j ACCEPT
iptables -A FORWARD -i eth0 -o br0 \
  -m state --state RELATED,ESTABLISHED -j ACCEPT

# Now containers can reach the internet
ip netns exec ns1 curl -s https://ifconfig.me
```

## Viewing the iptables Chains

When Docker or Kubernetes are running, `iptables` has extensive custom chains:

```bash
# Show NAT table with packet counts
iptables -t nat -L -n -v --line-numbers

# Kubernetes-specific chains
iptables -t nat -L KUBE-SERVICES -n -v
iptables -t nat -L KUBE-SVC-XXXXXX -n -v

# Trace a packet through iptables rules (requires iptables-legacy or kernel 5.4+)
iptables -t raw -A PREROUTING -p tcp --dport 80 -j TRACE
xtables-monitor --trace
```

## conntrack: Connection Tracking

`conntrack` maintains state for NAT and stateful filtering:

```bash
# Show active connections
conntrack -L -p tcp

# Watch new connections in real time
conntrack -E -e NEW

# Delete a stale entry (fixes "ct_state invalid" drops)
conntrack -D -s 10.0.0.5 -d 10.0.0.10 -p tcp --sport 45231 --dport 8080

# Common Kubernetes conntrack issue: hairpin NAT
# Check for entries with DNAT
conntrack -L -t nat | grep DNAT
```

The conntrack table limit is a common production problem. Check and tune:

```bash
# Current table size
cat /proc/sys/net/netfilter/nf_conntrack_count

# Max allowed entries
cat /proc/sys/net/netfilter/nf_conntrack_max

# Increase the limit (also in sysctl.conf for persistence)
sysctl -w net.netfilter.nf_conntrack_max=524288
```

## CNI: Container Network Interface

The CNI specification defines a simple JSON-based protocol between the container runtime and network plugins. When `kubelet` creates a pod:

1. The container runtime (containerd/crio) creates a new network namespace for the pod.
2. The runtime calls the CNI plugin binary with `ADD` action, passing the namespace path and config.
3. The CNI plugin sets up the network (veth pair, IP assignment, routes) inside the namespace.
4. The plugin returns the IP address to the runtime.
5. On pod deletion, the runtime calls the plugin with `DEL`.

### CNI Plugin Call Format

```bash
# What the runtime does when adding a pod:
CNI_COMMAND=ADD \
CNI_CONTAINERID=abc123 \
CNI_NETNS=/var/run/netns/cni-abc123 \
CNI_IFNAME=eth0 \
CNI_PATH=/opt/cni/bin \
/opt/cni/bin/bridge <<EOF
{
  "cniVersion": "1.0.0",
  "name": "mynet",
  "type": "bridge",
  "bridge": "cni0",
  "isDefaultGateway": true,
  "ipMasq": true,
  "ipam": {
    "type": "host-local",
    "subnet": "10.244.0.0/24",
    "routes": [{"dst": "0.0.0.0/0"}]
  }
}
EOF
```

The plugin responds with:

```json
{
  "cniVersion": "1.0.0",
  "interfaces": [{
    "name": "eth0",
    "mac": "aa:bb:cc:dd:ee:ff",
    "sandbox": "/var/run/netns/cni-abc123"
  }],
  "ips": [{
    "address": "10.244.0.5/24",
    "gateway": "10.244.0.1",
    "interface": 0
  }],
  "routes": [{"dst": "0.0.0.0/0", "gw": "10.244.0.1"}]
}
```

### Writing a Minimal CNI Plugin

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

type NetConfig struct {
    types.NetConf
    Bridge string `json:"bridge"`
    Subnet string `json:"subnet"`
}

func init() {
    // Lock to OS thread for namespace operations
    runtime.LockOSThread()
}

func main() {
    skel.PluginMainFuncs(
        skel.CNIFuncs{
            Add:   cmdAdd,
            Del:   cmdDel,
            Check: cmdCheck,
        },
        version.All,
        "minimal-cni v0.1.0",
    )
}

func cmdAdd(args *skel.CmdArgs) error {
    config := &NetConfig{}
    if err := json.Unmarshal(args.StdinData, config); err != nil {
        return fmt.Errorf("parsing config: %w", err)
    }

    // Get or create the bridge
    bridge, err := ensureBridge(config.Bridge)
    if err != nil {
        return fmt.Errorf("ensuring bridge: %w", err)
    }

    // Create a veth pair; move one end into the container namespace
    netns, err := ns.GetNS(args.Netns)
    if err != nil {
        return fmt.Errorf("opening netns %s: %w", args.Netns, err)
    }
    defer netns.Close()

    hostVeth, containerVeth, err := ip.SetupVeth(args.IfName, 1500, "", netns)
    if err != nil {
        return fmt.Errorf("setting up veth: %w", err)
    }

    // Attach host-side veth to bridge
    hostLink, err := netlink.LinkByName(hostVeth.Name)
    if err != nil {
        return fmt.Errorf("finding host veth: %w", err)
    }
    if err := netlink.LinkSetMaster(hostLink, bridge); err != nil {
        return fmt.Errorf("attaching veth to bridge: %w", err)
    }

    // Assign IP inside container namespace
    _, subnet, err := net.ParseCIDR(config.Subnet)
    if err != nil {
        return fmt.Errorf("parsing subnet: %w", err)
    }
    containerIP, err := allocateIP(subnet)
    if err != nil {
        return fmt.Errorf("allocating IP: %w", err)
    }

    if err := netns.Do(func(netNS ns.NetNS) error {
        link, err := netlink.LinkByName(containerVeth.Name)
        if err != nil {
            return err
        }
        addr := &netlink.Addr{IPNet: &net.IPNet{
            IP:   containerIP,
            Mask: subnet.Mask,
        }}
        if err := netlink.AddrAdd(link, addr); err != nil {
            return err
        }
        if err := netlink.LinkSetUp(link); err != nil {
            return err
        }
        // Add default route
        gw := firstIP(subnet)
        return netlink.RouteAdd(&netlink.Route{
            LinkIndex: link.Attrs().Index,
            Gw:        gw,
        })
    }); err != nil {
        return fmt.Errorf("configuring container interface: %w", err)
    }

    result := &current.Result{
        CNIVersion: current.ImplementedSpecVersion,
        Interfaces: []*current.Interface{
            {Name: hostVeth.Name, Sandbox: ""},
            {Name: containerVeth.Name, Sandbox: args.Netns},
        },
        IPs: []*current.IPConfig{
            {
                Address:   net.IPNet{IP: containerIP, Mask: subnet.Mask},
                Gateway:   firstIP(subnet),
                Interface: current.Int(1),
            },
        },
    }

    return types.PrintResult(result, config.CNIVersion)
}

func cmdDel(args *skel.CmdArgs) error {
    // Clean up IP allocation and veth pair
    netns, err := ns.GetNS(args.Netns)
    if err != nil {
        // Namespace already deleted — that's fine
        return nil
    }
    defer netns.Close()

    return netns.Do(func(netNS ns.NetNS) error {
        iface, err := netlink.LinkByName(args.IfName)
        if err != nil {
            return nil // Interface already gone
        }
        return netlink.LinkDel(iface) // Deleting one peer deletes the pair
    })
}

func cmdCheck(args *skel.CmdArgs) error {
    return nil // Basic health check
}
```

## Flannel: Overlay Networking

Flannel creates a flat, routable overlay network across nodes using VXLAN or host-gw backends.

### VXLAN Backend

```
Node A (10.0.1.10)               Node B (10.0.1.11)
┌─────────────────────┐           ┌─────────────────────┐
│  Pod: 10.244.0.5    │           │  Pod: 10.244.1.8    │
│    │ veth0           │           │    │ veth0           │
│  cni0 bridge        │           │  cni0 bridge        │
│  10.244.0.1         │           │  10.244.1.1         │
│    │                │           │    │                │
│  flannel.1 (VXLAN)  │◄──────────►  flannel.1 (VXLAN)  │
│  eth0: 10.0.1.10    │  UDP 8472 │  eth0: 10.0.1.11    │
└─────────────────────┘           └─────────────────────┘
```

Inspect Flannel state:

```bash
# What subnet does this node own?
cat /run/flannel/subnet.env
# FLANNEL_NETWORK=10.244.0.0/16
# FLANNEL_SUBNET=10.244.0.1/24
# FLANNEL_MTU=1450
# FLANNEL_IPMASQ=true

# What VTEP routes exist?
ip route | grep flannel
# 10.244.1.0/24 via 10.244.1.0 dev flannel.1 onlink

# What ARP entries does flannel maintain?
ip neigh show dev flannel.1
# 10.244.1.0 lladdr aa:bb:cc:dd:ee:ff PERMANENT
```

### host-gw Backend (Faster, L3 Only)

```bash
# With host-gw, traffic is routed directly (no VXLAN overhead)
# Each node adds routes for other nodes' pod subnets

ip route | grep via
# 10.244.1.0/24 via 10.0.1.11 dev eth0
# 10.244.2.0/24 via 10.0.1.12 dev eth0
```

host-gw requires all nodes to be on the same L2 network segment.

## Cilium: eBPF-Based Networking

Cilium replaces iptables with eBPF programs loaded directly into the kernel. This eliminates the iptables rule explosion that slows down large clusters.

```bash
# Inspect Cilium endpoint state for a pod
cilium endpoint list

# Show BPF programs attached to an interface
bpftool prog show
tc filter show dev lxcXXXXXXXX ingress

# Verify Cilium connectivity between pods
cilium connectivity test

# Monitor packet drops in real time
cilium monitor --type drop

# Show service load balancing state
cilium service list
```

Cilium's eBPF-based kube-proxy replacement:

```bash
# Verify kube-proxy is not running (Cilium replaced it)
kubectl -n kube-system get pods | grep kube-proxy
# (no output)

# Cilium handles service VIP translation in eBPF
cilium service list | grep 443
```

## Debugging Container Networking

### Pod Cannot Reach Service

```bash
# 1. Check if the service has endpoints
kubectl get endpoints my-service -n production

# 2. DNS resolution inside the pod
kubectl exec -it debug-pod -- nslookup my-service.production.svc.cluster.local

# 3. Check kube-proxy/iptables rules for the service VIP
kubectl get svc my-service -n production -o jsonpath='{.spec.clusterIP}'
iptables -t nat -L KUBE-SERVICES -n | grep <cluster-ip>
iptables -t nat -L KUBE-SVC-XXXX -n -v

# 4. Conntrack for the service VIP
conntrack -L | grep <cluster-ip>

# 5. tcpdump at the pod level
# Find the veth interface for the pod
POD_UID=$(kubectl get pod my-pod -n production -o jsonpath='{.metadata.uid}')
CONTAINER_ID=$(kubectl get pod my-pod -n production \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | cut -d/ -f3)

# Find the host-side veth from inside the pod
kubectl exec -it my-pod -- cat /sys/class/net/eth0/ifindex
# 42
# Find the interface with that index on the host
ip link | awk -F': ' '/^42:/{print $2}'
# lxc1234abcd
tcpdump -i lxc1234abcd -n -vvv
```

### Packet Loss Between Nodes

```bash
# Check if routing is correct
ip route get 10.244.1.8
# 10.244.1.8 via 10.244.1.0 dev flannel.1 src 10.244.0.1

# Ping from node to remote pod (bypasses host network stack)
ping -I flannel.1 10.244.1.8

# Trace the route
traceroute -I 10.244.1.8

# Check for MTU mismatch (common with VXLAN overlays)
# VXLAN adds 50-byte header → Flannel sets MTU to 1450 on pod interfaces
ip link show flannel.1 | grep mtu
# 1450
kubectl exec my-pod -- ip link show eth0 | grep mtu
# Should also show 1450

# If MTU mismatch exists, update the CNI config
kubectl -n kube-system edit configmap kube-flannel-cfg
# Set "MTU": 1450
```

### Connection Refused vs Connection Timeout

```bash
# Connection refused = port is reachable but nothing is listening
# → Check the container is actually listening on the expected port
kubectl exec my-pod -- ss -tlnp

# Connection timeout = no route or packet dropped
# → Check security groups, NetworkPolicy, iptables
kubectl describe networkpolicy -n production

# Check all NetworkPolicies that affect the pod
kubectl get networkpolicies -n production -o yaml | \
  grep -A5 "podSelector:" | grep -B2 "app: my-app"
```

### Network Policy Debugging

```bash
# Test if a NetworkPolicy is blocking traffic
# Cilium provides a connectivity test tool
cilium policy trace \
  --src-k8s-pod production/frontend \
  --dst-k8s-pod production/backend \
  --dport 8080

# Output:
# Resolving ingress policy for [production/backend]
# * Rule {"matchLabels":{"app":"backend"}} (Matching):
#   Allows to port 8080/TCP from: {production/frontend}
# Final verdict: ALLOWED
```

## Kubernetes Service Types and Their Implementation

### ClusterIP

```
Pod → kube-proxy (iptables) → DNAT to endpoint IP
```

```bash
# iptables chain for a ClusterIP service
iptables -t nat -L KUBE-SERVICES -n | grep 10.96.0.10  # Service VIP
# → KUBE-SVC-XXXXX

iptables -t nat -L KUBE-SVC-XXXXX -n
# → KUBE-SEP-YYYY (endpoint 1)
# → KUBE-SEP-ZZZZ (endpoint 2) with 50% probability

iptables -t nat -L KUBE-SEP-YYYY -n
# DNAT to 10.244.0.5:8080
```

### NodePort

NodePort services add iptables rules on every node to accept traffic on the node's IP:

```bash
iptables -t nat -L KUBE-NODEPORTS -n | grep 30080
# → KUBE-SVC-XXXXX (same chain as ClusterIP)
```

### LoadBalancer (AWS NLB)

The cloud controller manager provisions an NLB and updates the Service's `status.loadBalancer.ingress`. Traffic flows:

```
Client → NLB → NodePort rule → kube-proxy DNAT → Pod
```

## Summary

Container networking is built from five kernel primitives:

1. **Network namespaces** — isolated network stacks.
2. **veth pairs** — virtual Ethernet cables connecting namespaces.
3. **Bridge devices** — virtual L2 switches for multi-container communication.
4. **iptables NAT** — masquerade and DNAT for external connectivity and service VIPs.
5. **conntrack** — stateful connection tracking required for NAT.

CNI plugins encode these primitives into a standard protocol that any container runtime can call. Understanding this foundation makes it possible to trace any networking problem from the pod level down to the specific kernel data structure causing the failure.

For production Kubernetes clusters, the choice of CNI plugin determines which debugging tools apply: `iptables` and `conntrack` for Flannel and Calico, `cilium monitor` and `bpftool` for Cilium.
