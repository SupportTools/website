---
title: "Linux Network Namespaces and Virtual Networking: Deep Dive for Container Engineers"
date: 2028-05-07T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Namespaces", "veth", "Bridge", "iptables", "Containers"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into Linux network namespaces, veth pairs, bridges, iptables NAT, and routing — the kernel primitives that power container networking in Docker, Kubernetes, and container runtimes."
more_link: "yes"
url: "/linux-network-namespaces-virtual-networking-guide/"
---

Every container networking abstraction — Docker networks, Kubernetes pods, CNI plugins — ultimately reduces to a small set of Linux kernel primitives: network namespaces, virtual ethernet pairs, bridges, iptables rules, and routing tables. Understanding these fundamentals is essential for debugging networking issues, implementing custom CNI plugins, and reasoning about performance characteristics. This guide walks through each primitive from first principles, building up to a working container network implementation using nothing but standard Linux tools.

<!--more-->

# Linux Network Namespaces and Virtual Networking: Deep Dive for Container Engineers

## Linux Network Namespaces

A network namespace is a kernel abstraction that provides an isolated instance of the Linux network stack. Each namespace has its own:

- Network interfaces (physical and virtual)
- IP addresses and routes
- iptables rules (filter, nat, mangle, raw tables)
- netfilter connection tracking table
- Unix domain socket file system namespace
- `/proc/net/` files

The root network namespace is where physical NICs live. All other namespaces are isolated and communicate with the outside world only through the interfaces you explicitly connect.

### Creating and Inspecting Namespaces

```bash
# Create a new network namespace
ip netns add container1

# List all network namespaces
ip netns list
# container1

# Execute commands inside the namespace
ip netns exec container1 ip link list
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN mode DEFAULT
#     link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00

# The namespace starts with only a loopback, which is down
ip netns exec container1 ip link set lo up
ip netns exec container1 ip addr add 127.0.0.1/8 dev lo

# Get a shell inside the namespace
ip netns exec container1 bash

# From within the shell, verify isolation
ip link list  # Only lo
ip route show  # Empty
iptables -L    # Empty tables
```

### Namespace Persistence

Network namespaces are tied to the lifecycle of processes that have them open. To make them persistent (survive until explicitly deleted), they are bind-mounted:

```bash
# ip netns add does this automatically — creates a bind mount at /run/netns/NAME
ls -la /run/netns/
# total 0
# drwx--x--x 2 root root  60 May  7 10:00 .
# drwxr-xr-x 1 root root 280 May  7 09:00 ..
# -r--r--r-- 1 root root   0 May  7 10:00 container1

# The namespace file descriptor can also be created manually
# for process-bound namespaces via /proc/<pid>/ns/net
ls -la /proc/1/ns/net
# lrwxrwxrwx 1 root root 0 May  7 10:00 /proc/1/ns/net -> net:[4026531840]

# Check which namespace an interface is in
ip -all netns exec ip link show | grep -A1 "eth0"
```

## Virtual Ethernet Pairs (veth)

A veth pair is a virtual network cable with two endpoints. Packets sent into one end emerge from the other. The key insight: one endpoint can be in the root namespace (or a bridge) and the other in a container namespace.

```bash
# Create a veth pair
ip link add veth-host type veth peer name veth-container

# Both ends start in the root namespace
ip link list | grep veth
# 4: veth-container@veth-host: <BROADCAST,MULTICAST,M-DOWN> mtu 1500
# 5: veth-host@veth-container: <BROADCAST,MULTICAST,M-DOWN> mtu 1500

# Move one end into the container namespace
ip link set veth-container netns container1

# Now verify
ip link list | grep veth
# 5: veth-host@if4: <BROADCAST,MULTICAST> mtu 1500  # Note: @if4 refers to peer ifindex

ip netns exec container1 ip link list
# 1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536
# 4: veth-container@if5: <BROADCAST,MULTICAST> mtu 1500

# Assign IP addresses and bring up interfaces
ip addr add 172.20.0.1/24 dev veth-host
ip link set veth-host up

ip netns exec container1 ip addr add 172.20.0.2/24 dev veth-container
ip netns exec container1 ip link set veth-container up

# Test connectivity
ping -c 2 172.20.0.2
# PING 172.20.0.2 (172.20.0.2) 56(84) bytes of data.
# 64 bytes from 172.20.0.2: icmp_seq=1 ttl=64 time=0.048 ms

# From inside the container
ip netns exec container1 ping -c 2 172.20.0.1
```

### veth Performance Characteristics

veth pairs have near-zero overhead — they are implemented entirely in software with no system call overhead after the initial setup. The kernel copies packet descriptors between the two ends without copying packet data.

```bash
# Measure veth bandwidth
ip netns exec container1 iperf3 -s -D
iperf3 -c 172.20.0.2 -t 30
# Connecting to host 172.20.0.2, port 5201
# [ ID] Interval           Transfer     Bitrate
# [  5]   0.00-30.00  sec  87.5 GBytes  25.0 Gbits/sec  # Typical veth throughput
```

## Linux Bridge

A Linux bridge (software switch) is the mechanism for connecting multiple network interfaces at Layer 2. In container networking, bridges allow multiple containers to communicate with each other and with the host.

```bash
# Create a bridge
ip link add br-containers type bridge
ip link set br-containers up
ip addr add 172.20.0.1/24 dev br-containers

# Configure bridge settings
# Enable STP (disabled for container networks to avoid delays)
ip link set br-containers type bridge stp_state 0

# Set aging time for MAC table (seconds)
ip link set br-containers type bridge ageing_time 300

# Inspect bridge state
ip link show type bridge
bridge link show
bridge fdb show dev br-containers
```

### Connecting Multiple Containers to a Bridge

```bash
# Create two containers
ip netns add container1
ip netns add container2

# Create veth pairs for each
ip link add veth1-host type veth peer name veth1-ctr
ip link add veth2-host type veth peer name veth2-ctr

# Move container ends into namespaces
ip link set veth1-ctr netns container1
ip link set veth2-ctr netns container2

# Connect host ends to bridge
ip link set veth1-host master br-containers
ip link set veth2-host master br-containers
ip link set veth1-host up
ip link set veth2-host up

# Configure container interfaces
ip netns exec container1 ip link set lo up
ip netns exec container1 ip link set veth1-ctr up
ip netns exec container1 ip addr add 172.20.0.2/24 dev veth1-ctr
ip netns exec container1 ip route add default via 172.20.0.1

ip netns exec container2 ip link set lo up
ip netns exec container2 ip link set veth2-ctr up
ip netns exec container2 ip addr add 172.20.0.3/24 dev veth2-ctr
ip netns exec container2 ip route add default via 172.20.0.1

# Containers can now communicate
ip netns exec container1 ping -c 2 172.20.0.3
# 64 bytes from 172.20.0.3: icmp_seq=1 ttl=64 time=0.089 ms

# Verify bridge MAC table learned the addresses
bridge fdb show dev br-containers | grep master
```

### Bridge and Packet Flow

Understanding the packet path helps debug networking issues:

```
container1 (veth1-ctr) ←→ veth1-host → br-containers → veth2-host → (veth2-ctr) container2
                                              ↑
                                         Linux kernel
                                         netfilter/iptables
                                         (FORWARD chain)
```

Traffic between containers traverses the bridge's `FORWARD` chain in iptables, not the `INPUT/OUTPUT` chains. This distinction matters for firewall rules:

```bash
# Allow forwarding through bridge (required if iptables policy is DROP)
iptables -A FORWARD -i br-containers -o br-containers -j ACCEPT

# Or more specifically
iptables -A FORWARD -i br-containers -o br-containers -m state \
  --state RELATED,ESTABLISHED -j ACCEPT
iptables -A FORWARD -i br-containers -o br-containers -j ACCEPT
```

## NAT and External Connectivity

Containers in private subnets need NAT (MASQUERADE) to access external networks:

```bash
# Enable IP forwarding (required for routing between namespaces)
echo 1 > /proc/sys/net/ipv4/ip_forward
# Or persistently:
sysctl -w net.ipv4.ip_forward=1
cat >> /etc/sysctl.d/99-container-net.conf << 'EOF'
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF

# MASQUERADE: replace source IP with the outgoing interface IP
# This is equivalent to SNAT but dynamic (works with DHCP)
iptables -t nat -A POSTROUTING -s 172.20.0.0/24 ! -o br-containers -j MASQUERADE

# Allow forwarding from containers to outside
iptables -A FORWARD -i br-containers -o eth0 -j ACCEPT

# Allow return traffic
iptables -A FORWARD -i eth0 -o br-containers -m state \
  --state RELATED,ESTABLISHED -j ACCEPT

# Test external connectivity from container
ip netns exec container1 ping -c 2 8.8.8.8
```

### Port Forwarding (DNAT)

Expose a container port on the host:

```bash
# DNAT: redirect incoming traffic on host port 8080 to container port 80
iptables -t nat -A PREROUTING -p tcp --dport 8080 -j DNAT \
  --to-destination 172.20.0.2:80

# Allow the forwarded traffic
iptables -A FORWARD -d 172.20.0.2 -p tcp --dport 80 \
  -m state --state NEW -j ACCEPT

# Also handle localhost access (PREROUTING doesn't apply to locally generated traffic)
iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport 8080 -j DNAT \
  --to-destination 172.20.0.2:80
```

## Examining iptables Rules in Container Environments

Docker and Kubernetes add extensive iptables rules. Understanding their structure is critical for debugging:

```bash
# View complete iptables state with line numbers
iptables -t filter -L -n -v --line-numbers
iptables -t nat -L -n -v --line-numbers

# Docker's typical rule structure in the nat table:
# PREROUTING chain:
#   DOCKER (custom chain for port forwarding)
#
# OUTPUT chain:
#   DOCKER chain
#
# POSTROUTING chain:
#   MASQUERADE for container traffic leaving eth0
#   MASQUERADE for container-to-container via exposed port (hairpin NAT)
#
# DOCKER chain:
#   Per-container DNAT rules
#   -A DOCKER -i docker0 -j RETURN  (skip for same-bridge traffic)

# Kubernetes adds KUBE-* chains for service proxying:
iptables -t nat -L -n | grep KUBE | head -30

# Trace a specific packet through iptables rules
# (requires iptables-legacy or xt_trace module)
iptables -t raw -A PREROUTING -p icmp -j TRACE
iptables -t raw -A OUTPUT -p icmp -j TRACE
dmesg | grep TRACE | head -20
# Clean up
iptables -t raw -D PREROUTING -p icmp -j TRACE
iptables -t raw -D OUTPUT -p icmp -j TRACE
```

## Routing Tables and Policy Routing

Container runtimes and CNI plugins use multiple routing tables for sophisticated traffic steering:

```bash
# View routing tables
ip route show
ip route show table all | head -50

# Create a custom routing table
echo "200 containers" >> /etc/iproute2/rt_tables

# Add routes to custom table
ip route add 172.20.0.0/24 dev br-containers table containers
ip route add default via 10.0.0.1 table containers

# Add policy routing rule: route packets from containers via custom table
ip rule add from 172.20.0.0/24 table containers
ip rule show

# Flush routing cache after changes
ip route flush cache
```

### Source-Based Routing (Multi-Homed Hosts)

```bash
# Scenario: host has eth0 (10.0.0.5/24, gw 10.0.0.1) and eth1 (192.168.1.5/24, gw 192.168.1.1)
# Container traffic should use eth1

# Table 100 for eth1 traffic
ip route add 192.168.1.0/24 dev eth1 src 192.168.1.5 table 100
ip route add default via 192.168.1.1 table 100

# Rule: container subnet uses table 100
ip rule add from 172.20.0.0/24 lookup 100 priority 100
```

## CNI Plugin Implementation

The Container Network Interface (CNI) is a specification that container runtimes (containerd, CRI-O) use to call networking plugins. Understanding the spec helps when building custom plugins.

### CNI Specification Basics

A CNI plugin is an executable that receives JSON configuration on stdin and sets up networking for a container. The runtime calls it with `ADD`, `DEL`, or `CHECK` commands via an environment variable.

```bash
# Environment variables set by the runtime
CNI_COMMAND=ADD           # ADD, DEL, CHECK, VERSION
CNI_CONTAINERID=abc123    # Container ID
CNI_NETNS=/proc/12345/ns/net  # Path to network namespace
CNI_IFNAME=eth0           # Interface name inside container
CNI_PATH=/opt/cni/bin     # Path to find other CNI plugins
```

### Minimal Bridge CNI Plugin in Go

```go
// cmd/bridge-cni/main.go
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"runtime"

	"github.com/containernetworking/cni/pkg/skel"
	"github.com/containernetworking/cni/pkg/types"
	types100 "github.com/containernetworking/cni/pkg/types/100"
	"github.com/containernetworking/cni/pkg/version"
	"github.com/containernetworking/plugins/pkg/ip"
	"github.com/containernetworking/plugins/pkg/ns"
	"github.com/vishvananda/netlink"
)

func init() {
	// Lock the OS thread so the network namespace operations work correctly
	runtime.LockOSThread()
}

type NetConf struct {
	types.NetConf
	BridgeName string `json:"bridge"`
	IsGateway  bool   `json:"isGateway"`
	IPMasq     bool   `json:"ipMasq"`
	MTU        int    `json:"mtu"`
	Subnet     string `json:"subnet"`
}

func main() {
	skel.PluginMain(cmdAdd, cmdCheck, cmdDel, version.All, "bridge-cni v1.0.0")
}

func cmdAdd(args *skel.CmdArgs) error {
	conf, err := parseConfig(args.StdinData)
	if err != nil {
		return err
	}

	// Get or create the bridge
	br, err := ensureBridge(conf.BridgeName, conf.MTU)
	if err != nil {
		return fmt.Errorf("setting up bridge %q: %w", conf.BridgeName, err)
	}

	// Get the target network namespace
	netns, err := ns.GetNS(args.Netns)
	if err != nil {
		return fmt.Errorf("opening netns %q: %w", args.Netns, err)
	}
	defer netns.Close()

	// Create veth pair
	hostIface, contIface, err := ip.SetupVeth(args.IfName, conf.MTU, "", netns)
	if err != nil {
		return fmt.Errorf("creating veth pair: %w", err)
	}

	// Attach host end to bridge
	hostVeth, err := netlink.LinkByName(hostIface.Name)
	if err != nil {
		return fmt.Errorf("getting host veth: %w", err)
	}
	if err := netlink.LinkSetMaster(hostVeth, br); err != nil {
		return fmt.Errorf("attaching to bridge: %w", err)
	}

	// Allocate IP address (simplified — real plugins use IPAM)
	_, subnet, _ := net.ParseCIDR(conf.Subnet)
	containerIP, gatewayIP := allocateIP(subnet)

	// Configure container interface
	err = netns.Do(func(_ ns.NetNS) error {
		contVeth, err := netlink.LinkByName(args.IfName)
		if err != nil {
			return err
		}

		addr := &netlink.Addr{
			IPNet: &net.IPNet{IP: containerIP, Mask: subnet.Mask},
		}
		if err := netlink.AddrAdd(contVeth, addr); err != nil {
			return fmt.Errorf("adding IP to container veth: %w", err)
		}

		if err := netlink.LinkSetUp(contVeth); err != nil {
			return err
		}

		// Add default route via bridge gateway
		return netlink.RouteAdd(&netlink.Route{
			LinkIndex: contVeth.Attrs().Index,
			Gw:        gatewayIP,
		})
	})
	if err != nil {
		return fmt.Errorf("configuring container network: %w", err)
	}

	// Return result
	result := &types100.Result{
		CNIVersion: conf.CNIVersion,
		Interfaces: []*types100.Interface{
			{Name: br.Attrs().Name, Mac: br.Attrs().HardwareAddr.String()},
			{Name: hostIface.Name, Mac: hostIface.Mac},
			{Name: contIface.Name, Mac: contIface.Mac, Sandbox: args.Netns},
		},
		IPs: []*types100.IPConfig{
			{
				Interface: types100.Int(2), // contIface index
				Address:   net.IPNet{IP: containerIP, Mask: subnet.Mask},
				Gateway:   gatewayIP,
			},
		},
	}

	return types.PrintResult(result, conf.CNIVersion)
}

func cmdDel(args *skel.CmdArgs) error {
	netns, err := ns.GetNS(args.Netns)
	if err != nil {
		// Namespace already gone — idempotent delete
		return nil
	}
	defer netns.Close()

	return netns.Do(func(_ ns.NetNS) error {
		return ip.DelLinkByName(args.IfName)
	})
}

func cmdCheck(args *skel.CmdArgs) error {
	return nil
}

func ensureBridge(name string, mtu int) (*netlink.Bridge, error) {
	br := &netlink.Bridge{
		LinkAttrs: netlink.LinkAttrs{
			Name: name,
			MTU:  mtu,
		},
	}

	if err := netlink.LinkAdd(br); err != nil {
		// If bridge exists, get it
		link, err := netlink.LinkByName(name)
		if err != nil {
			return nil, err
		}
		var ok bool
		br, ok = link.(*netlink.Bridge)
		if !ok {
			return nil, fmt.Errorf("%q is not a bridge", name)
		}
	}

	if err := netlink.LinkSetUp(br); err != nil {
		return nil, err
	}

	return br, nil
}

func allocateIP(subnet *net.IPNet) (net.IP, net.IP) {
	// Simplified — real implementation uses IPAM plugin
	// Gateway is .1, container gets .2
	gw := make(net.IP, len(subnet.IP))
	copy(gw, subnet.IP)
	gw[len(gw)-1] = 1

	container := make(net.IP, len(subnet.IP))
	copy(container, subnet.IP)
	container[len(container)-1] = 2

	return container, gw
}

func parseConfig(data []byte) (*NetConf, error) {
	conf := &NetConf{}
	if err := json.Unmarshal(data, conf); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}
	return conf, nil
}
```

## Debugging Container Networking

### tcpdump Inside Network Namespaces

```bash
# Capture traffic inside a container namespace
# Method 1: Using ip netns exec
ip netns exec container1 tcpdump -i veth1-ctr -nn -v

# Method 2: Using nsenter (for running container processes)
PID=$(docker inspect -f '{{.State.Pid}}' my-container)
nsenter -t $PID -n tcpdump -i eth0 -nn -v

# Capture ARP to debug L2 issues
ip netns exec container1 tcpdump -i any -nn arp

# Capture DNS
ip netns exec container1 tcpdump -i any -nn port 53

# Capture and save for Wireshark analysis
ip netns exec container1 tcpdump -i any -w /tmp/capture.pcap &
# ... reproduce issue ...
kill %1
# Copy capture.pcap to workstation for analysis
```

### netstat and ss Inside Namespaces

```bash
# View socket state inside namespace
ip netns exec container1 ss -tlnp  # TCP listening
ip netns exec container1 ss -un    # UDP
ip netns exec container1 ss -s     # Summary

# Using nsenter for running container
nsenter -t $PID -n ss -tlnp

# Check connection tracking
ip netns exec container1 conntrack -L  # Requires kernel module
# Or from host
conntrack -L | grep 172.20.0.2
```

### Tracing Packet Path with iptables-trace

```bash
# Enable packet tracing for specific traffic
iptables -t raw -I PREROUTING 1 -p tcp --dport 8080 -j TRACE
iptables -t raw -I OUTPUT 1 -p tcp --sport 8080 -j TRACE

# View trace in kernel log
dmesg -w | grep TRACE

# Example trace output:
# [123456.789] TRACE: raw:PREROUTING:rule:1 IN=eth0 SRC=10.0.0.5 DST=172.20.0.2 PROTO=TCP SPT=54321 DPT=80
# [123456.790] TRACE: nat:PREROUTING:rule:1 IN=eth0 SRC=10.0.0.5 DST=172.20.0.2 PROTO=TCP
# [123456.790] TRACE: filter:FORWARD:rule:1 IN=eth0 OUT=br-containers SRC=10.0.0.5 DST=172.20.0.2

# Clean up
iptables -t raw -D PREROUTING 1
iptables -t raw -D OUTPUT 1
```

### Checking Conntrack Table

```bash
# Install conntrack tools
apt-get install -y conntrack

# View all tracked connections
conntrack -L

# View connections by protocol
conntrack -L -p tcp
conntrack -L -p udp

# Check for conntrack table exhaustion (common K8s issue)
sysctl net.netfilter.nf_conntrack_count    # Current entries
sysctl net.netfilter.nf_conntrack_max      # Maximum entries

# Monitor conntrack events
conntrack -E  # Real-time events

# Conntrack table configuration
sysctl -w net.netfilter.nf_conntrack_max=524288
sysctl -w net.netfilter.nf_conntrack_tcp_timeout_established=3600
sysctl -w net.netfilter.nf_conntrack_tcp_timeout_time_wait=30
```

## Network Namespace Performance Testing

```bash
# Install iperf3 and test bandwidth
# Between two containers on same host (via bridge)
ip netns exec container2 iperf3 -s -D
ip netns exec container1 iperf3 -c 172.20.0.3 -t 30 -P 4

# Test with different socket buffer sizes
ip netns exec container1 iperf3 -c 172.20.0.3 -t 30 -w 256K

# Measure latency
ip netns exec container1 ping -c 100 -i 0.01 172.20.0.3 | tail -1
# rtt min/avg/max/mdev = 0.031/0.048/0.127/0.015 ms

# Test with iperf3 UDP
ip netns exec container1 iperf3 -c 172.20.0.3 -u -b 0 -t 30

# Measure TCP connection establishment time
ip netns exec container1 time bash -c 'for i in $(seq 1 100); do
  nc -z 172.20.0.3 5201
done'
```

## Advanced: VXLAN for Overlay Networks

CNI plugins like Flannel use VXLAN to create overlay networks that span multiple hosts:

```bash
# Create VXLAN interface
# VNI 100, remote host at 10.0.0.6
ip link add vxlan100 type vxlan \
  id 100 \
  dev eth0 \
  dstport 4789 \
  nolearning

ip link set vxlan100 up
ip addr add 10.200.0.1/24 dev vxlan100

# Add FDB (forwarding database) entries for remote hosts
bridge fdb add to 00:00:00:00:00:00 dst 10.0.0.6 dev vxlan100

# On the remote host (10.0.0.6):
ip link add vxlan100 type vxlan \
  id 100 \
  dev eth0 \
  dstport 4789 \
  nolearning
ip link set vxlan100 up
ip addr add 10.200.0.2/24 dev vxlan100
bridge fdb add to 00:00:00:00:00:00 dst 10.0.0.5 dev vxlan100

# Test cross-host connectivity
ping 10.200.0.2  # From host 10.0.0.5

# Inspect VXLAN traffic
tcpdump -i eth0 -nn udp port 4789 -v
# Shows encapsulated VXLAN frames with outer UDP/IP header
```

## Systemd-based Namespace Management

For production container runtimes, use systemd for namespace lifecycle management:

```bash
# Create a systemd network namespace unit
cat > /etc/systemd/system/netns@.service << 'EOF'
[Unit]
Description=Network Namespace %i
Before=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/ip netns add %i
ExecStop=/bin/ip netns del %i
ExecStartPost=/bin/ip netns exec %i ip link set lo up

[Install]
WantedBy=multi-user.target
EOF

systemctl enable netns@myapp.service
systemctl start netns@myapp.service

# Run services in the namespace
cat > /etc/systemd/system/myapp.service << 'EOF'
[Unit]
Description=My Application in Network Namespace

[Service]
NetworkNamespacePath=/run/netns/myapp
ExecStart=/usr/bin/myapp
EOF
```

## Conclusion

Linux network namespaces, veth pairs, bridges, and iptables NAT are the building blocks of every container networking solution. Docker's bridge networks, Kubernetes pod networking, and every CNI plugin are implementations of these same primitives. Understanding them at this level provides the foundation for:

- Debugging networking issues that container tooling abstracts away
- Writing custom CNI plugins for specialized networking requirements
- Performance tuning container networks for high-throughput workloads
- Implementing network isolation policies for multi-tenant environments

The kernel networking stack is remarkably capable once you understand its components. The abstractions container runtimes build on top are conveniences, not magic — and when they fail, knowing the underlying primitives is what gets services back online.
