---
title: "Linux Container Networking: veth Pairs, Network Namespaces, iptables, and CNI Plugin Development"
date: 2028-07-25T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Containers", "CNI", "iptables", "Network Namespaces"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Linux container networking fundamentals including veth pairs, network namespaces, bridge configuration, iptables NAT, and building a minimal CNI plugin from scratch."
more_link: "yes"
url: "/linux-container-networking-veth-cni-guide/"
---

Every Kubernetes pod getting an IP address, every Docker container reaching the internet, every service load-balancing across pods — all of it rests on a small set of Linux kernel primitives that most engineers have never directly touched. Understanding these fundamentals is not just academic: when pod-to-pod connectivity breaks in production, when network policies are not being enforced, when a CNI plugin upgrade causes connectivity loss, the engineers who understand the underlying Linux networking are the ones who can diagnose and fix it fast.

This guide builds container networking from first principles: creating network namespaces manually, wiring them together with veth pairs, configuring iptables NAT rules, and finally writing a minimal but functional CNI plugin in Go.

<!--more-->

# Linux Container Networking: From Primitives to CNI Plugins

## The Linux Networking Stack for Containers

Container networking is built on four kernel features:

1. **Network namespaces**: Isolate network interfaces, routing tables, and iptables rules per container
2. **veth pairs**: Virtual Ethernet cables connecting two namespaces
3. **Linux bridges**: Software switches connecting multiple veth pairs
4. **iptables/nftables**: NAT, masquerading, and traffic filtering

These four features, combined with IP routing, are all that is needed to build a fully functional container network. Every major CNI plugin — Flannel, Calico, Cilium, Weave — is built on variations of these primitives.

## Section 1: Network Namespaces

A network namespace is a complete, isolated copy of the Linux network stack. It has its own interfaces, routing table, ARP table, iptables rules, and socket table.

### Creating and Inspecting Namespaces

```bash
# Create a new network namespace named "container1".
ip netns add container1

# List all network namespaces.
ip netns list

# Execute commands inside the namespace.
ip netns exec container1 ip link list
ip netns exec container1 ip route show

# The namespace has only a loopback interface initially.
ip netns exec container1 ip link

# Bring up loopback.
ip netns exec container1 ip link set lo up
```

### The /var/run/netns Directory

```bash
# Network namespaces are represented as bind-mount files.
ls -la /var/run/netns/

# The kernel creates a namespace when a process is created with CLONE_NEWNET.
# ip netns add creates a persistent namespace (not tied to a process).

# You can also create a namespace from a running process.
# Find the PID of a container:
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' my-container)

# Access its network namespace.
nsenter --net=/proc/$CONTAINER_PID/ns/net ip link list
```

## Section 2: veth Pairs

A veth pair is a virtual Ethernet cable with two ends. Anything sent into one end comes out the other. By placing each end in a different network namespace, we create a channel between the two namespaces.

```bash
# Create a veth pair.
# veth0 stays in the root namespace (the host).
# veth1 will be moved into container1.
ip link add veth0 type veth peer name veth1

# Verify both ends are in the root namespace initially.
ip link show veth0
ip link show veth1

# Move veth1 into the container1 namespace.
ip link set veth1 netns container1

# Now veth1 only exists inside container1.
ip netns exec container1 ip link show veth1

# Assign IP addresses.
ip addr add 10.200.1.1/24 dev veth0
ip netns exec container1 ip addr add 10.200.1.2/24 dev veth1

# Bring both ends up.
ip link set veth0 up
ip netns exec container1 ip link set veth1 up

# Ping from the host to the container namespace.
ping -c 3 10.200.1.2

# Ping from inside the namespace to the host.
ip netns exec container1 ping -c 3 10.200.1.1
```

## Section 3: Linux Bridge for Multi-Container Networking

A single veth pair connects exactly two namespaces. To connect multiple containers together (like Docker does), we use a Linux bridge — a software layer-2 switch.

```bash
# Create a bridge interface.
ip link add br0 type bridge
ip addr add 172.20.0.1/24 dev br0
ip link set br0 up

# Create two containers.
ip netns add ctr-a
ip netns add ctr-b

# Wire ctr-a to the bridge.
ip link add veth-a-host type veth peer name veth-a-ctr
ip link set veth-a-ctr netns ctr-a
ip link set veth-a-host master br0
ip link set veth-a-host up
ip netns exec ctr-a ip addr add 172.20.0.10/24 dev veth-a-ctr
ip netns exec ctr-a ip link set veth-a-ctr up
ip netns exec ctr-a ip link set lo up
ip netns exec ctr-a ip route add default via 172.20.0.1

# Wire ctr-b to the bridge.
ip link add veth-b-host type veth peer name veth-b-ctr
ip link set veth-b-ctr netns ctr-b
ip link set veth-b-host master br0
ip link set veth-b-host up
ip netns exec ctr-b ip addr add 172.20.0.20/24 dev veth-b-ctr
ip netns exec ctr-b ip link set veth-b-ctr up
ip netns exec ctr-b ip link set lo up
ip netns exec ctr-b ip route add default via 172.20.0.1

# ctr-a can now reach ctr-b via the bridge.
ip netns exec ctr-a ping -c 3 172.20.0.20

# The bridge learns MAC addresses just like a physical switch.
bridge fdb show dev br0
```

## Section 4: NAT and Internet Connectivity

Containers with private IP addresses need NAT to reach external networks. Linux `iptables` provides this via the MASQUERADE target.

```bash
# Enable IP forwarding (required for routing between interfaces).
sysctl -w net.ipv4.ip_forward=1

# Make it persistent.
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.d/99-container-networking.conf

# Add MASQUERADE rule: traffic from container subnet, leaving via the host's
# external interface (eth0), gets NAT'd to the host's IP.
iptables -t nat -A POSTROUTING -s 172.20.0.0/24 ! -o br0 -j MASQUERADE

# Allow forwarding between the bridge and external interfaces.
iptables -A FORWARD -i br0 -j ACCEPT
iptables -A FORWARD -o br0 -j ACCEPT

# Test external connectivity from ctr-a.
ip netns exec ctr-a ping -c 3 8.8.8.8

# Verify the NAT rule.
iptables -t nat -L POSTROUTING -v -n
```

### Port Publishing (DNAT)

```bash
# Expose port 8080 in ctr-a on the host port 80.
iptables -t nat -A PREROUTING \
  -p tcp --dport 80 \
  -j DNAT --to-destination 172.20.0.10:8080

# Allow return traffic.
iptables -t nat -A OUTPUT \
  -p tcp --dport 80 \
  -j DNAT --to-destination 172.20.0.10:8080
```

## Section 5: Inspecting Container Networking in Kubernetes

With the fundamentals established, let's inspect how Kubernetes actually wires this up:

```bash
# Find the bridge interface created by your CNI plugin.
# For flannel:
ip link show flannel.1
brctl show cni0

# For calico:
ip link show tunl0

# List all veth pairs on the host.
ip link show type veth

# Match a veth pair to a specific pod.
POD_NS=$(kubectl get pod my-pod -o jsonpath='{.metadata.namespace}')
POD_NAME=my-pod

# Get the pod's veth interface name from inside the pod.
# The ifindex of the pod's eth0 corresponds to a veth on the host.
kubectl exec -n $POD_NS $POD_NAME -- ip link show eth0

# The index of the peer interface (visible in the output) matches a host veth.
# For example, if eth0@if42 appears, find interface with index 42 on the host:
ip link show | grep -E "^42:"

# Capture traffic on a pod's veth pair.
NODE=$(kubectl get pod my-pod -o jsonpath='{.spec.nodeName}')
ssh $NODE "tcpdump -i <veth-interface> -w /tmp/capture.pcap &"
```

## Section 6: Writing a CNI Plugin in Go

CNI plugins are executables that implement a simple protocol: they receive configuration via stdin and a network namespace path via environment variables, then set up or tear down the namespace's networking.

### CNI Specification Overview

CNI defines four operations:
- `ADD`: Set up networking for a new container
- `DEL`: Tear down networking for a container being removed
- `CHECK`: Verify that networking is set up correctly
- `VERSION`: Report supported specification versions

The plugin receives these via the `CNI_COMMAND` environment variable.

### Minimal CNI Plugin

```go
// cmd/cni-simple/main.go
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
	"github.com/containernetworking/plugins/pkg/ipam"
	"github.com/containernetworking/plugins/pkg/ns"
	"github.com/vishvananda/netlink"
)

func init() {
	// Ensure that CNI plugin initialization runs in the correct thread.
	// This is required because network namespace operations are per-thread.
	runtime.LockOSThread()
}

// NetConf defines the JSON configuration that the CNI runtime sends to the plugin.
type NetConf struct {
	types.NetConf
	BridgeName string `json:"bridge"`
	MTU        int    `json:"mtu"`
	IPAM       struct {
		Type   string `json:"type"`
		Subnet string `json:"subnet"`
	} `json:"ipam"`
}

const (
	defaultBridgeName = "cni0"
	defaultMTU        = 1500
)

func main() {
	skel.PluginMainFuncs(
		skel.CNIFuncs{
			Add:   cmdAdd,
			Del:   cmdDel,
			Check: cmdCheck,
		},
		version.All,
		"simple-cni v0.1.0",
	)
}

// cmdAdd sets up networking for a new container.
func cmdAdd(args *skel.CmdArgs) error {
	// Parse the network configuration from stdin.
	conf, err := parseConfig(args.StdinData)
	if err != nil {
		return fmt.Errorf("parse config: %w", err)
	}

	// Get or create the bridge in the host namespace.
	bridge, err := ensureBridge(conf.BridgeName, conf.MTU)
	if err != nil {
		return fmt.Errorf("ensure bridge: %w", err)
	}

	// Create a veth pair. One end goes into the container namespace.
	netns, err := ns.GetNS(args.Netns)
	if err != nil {
		return fmt.Errorf("open netns %s: %w", args.Netns, err)
	}
	defer netns.Close()

	hostVeth, contVeth, err := ip.SetupVethWithName(
		args.IfName,   // interface name inside the container (e.g., "eth0")
		"",            // host-side name: auto-generated
		conf.MTU,
		"",            // no MAC override
		netns,
	)
	if err != nil {
		return fmt.Errorf("setup veth: %w", err)
	}

	// Attach the host-side veth to the bridge.
	hostVethLink, err := netlink.LinkByName(hostVeth.Name)
	if err != nil {
		return fmt.Errorf("get host veth: %w", err)
	}
	if err := netlink.LinkSetMaster(hostVethLink, bridge); err != nil {
		return fmt.Errorf("set master: %w", err)
	}

	// Bring up the host-side veth.
	if err := netlink.LinkSetUp(hostVethLink); err != nil {
		return fmt.Errorf("bring up host veth: %w", err)
	}

	// Run IPAM to allocate an IP address.
	r, err := ipam.ExecAdd(conf.IPAM.Type, args.StdinData)
	if err != nil {
		return fmt.Errorf("ipam add: %w", err)
	}

	// Convert the IPAM result to the current API version.
	result, err := current.NewResultFromResult(r)
	if err != nil {
		return fmt.Errorf("convert ipam result: %w", err)
	}

	if len(result.IPs) == 0 {
		return fmt.Errorf("ipam returned no IPs")
	}

	// Configure the container's network namespace.
	if err := netns.Do(func(_ ns.NetNS) error {
		return configureContainerInterface(args.IfName, result, contVeth)
	}); err != nil {
		return fmt.Errorf("configure container: %w", err)
	}

	result.Interfaces = []*current.Interface{
		{
			Name: bridge.Attrs().Name,
			Mac:  bridge.Attrs().HardwareAddr.String(),
		},
		{
			Name: hostVeth.Name,
			Mac:  hostVeth.HardwareAddr.String(),
		},
		{
			Name:    args.IfName,
			Mac:     contVeth.HardwareAddr.String(),
			Sandbox: args.Netns,
		},
	}

	// Link IPs to the container interface.
	for _, ipc := range result.IPs {
		ipc.Interface = current.Int(2) // index of container interface
	}

	return types.PrintResult(result, conf.CNIVersion)
}

// cmdDel tears down networking for a container being removed.
func cmdDel(args *skel.CmdArgs) error {
	conf, err := parseConfig(args.StdinData)
	if err != nil {
		return fmt.Errorf("parse config: %w", err)
	}

	// Run IPAM del to release the IP.
	if err := ipam.ExecDel(conf.IPAM.Type, args.StdinData); err != nil {
		return fmt.Errorf("ipam del: %w", err)
	}

	// If the network namespace no longer exists, we are done.
	if args.Netns == "" {
		return nil
	}

	// Delete the veth pair. Deleting one end deletes both.
	netns, err := ns.GetNS(args.Netns)
	if err != nil {
		// Namespace is gone; nothing to clean up.
		return nil
	}
	defer netns.Close()

	return netns.Do(func(_ ns.NetNS) error {
		iface, err := netlink.LinkByName(args.IfName)
		if err != nil {
			return nil // Already deleted.
		}
		return netlink.LinkDel(iface)
	})
}

func cmdCheck(args *skel.CmdArgs) error {
	// Verify the container's interface exists and has the correct IP.
	netns, err := ns.GetNS(args.Netns)
	if err != nil {
		return fmt.Errorf("open netns: %w", err)
	}
	defer netns.Close()

	return netns.Do(func(_ ns.NetNS) error {
		_, err := netlink.LinkByName(args.IfName)
		return err
	})
}

// ensureBridge creates a Linux bridge if it does not already exist.
func ensureBridge(name string, mtu int) (*netlink.Bridge, error) {
	bridge := &netlink.Bridge{
		LinkAttrs: netlink.LinkAttrs{
			Name:   name,
			MTU:    mtu,
			TxQLen: -1,
		},
	}

	existing, err := netlink.LinkByName(name)
	if err == nil {
		br, ok := existing.(*netlink.Bridge)
		if !ok {
			return nil, fmt.Errorf("%s already exists but is not a bridge", name)
		}
		return br, nil
	}

	if err := netlink.LinkAdd(bridge); err != nil {
		return nil, fmt.Errorf("add bridge: %w", err)
	}

	if err := netlink.LinkSetUp(bridge); err != nil {
		return nil, fmt.Errorf("bring up bridge: %w", err)
	}

	// Add a host IP to the bridge so containers can use it as a gateway.
	bridgeIP, bridgeNet, _ := net.ParseCIDR("172.20.0.1/24")
	bridgeNet.IP = bridgeIP
	if err := netlink.AddrAdd(bridge, &netlink.Addr{IPNet: bridgeNet}); err != nil {
		return nil, fmt.Errorf("add bridge IP: %w", err)
	}

	return bridge, nil
}

// configureContainerInterface assigns the IP and default route inside
// the container namespace.
func configureContainerInterface(
	ifName string,
	result *current.Result,
	contVeth net.Interface,
) error {
	contLink, err := netlink.LinkByName(ifName)
	if err != nil {
		return fmt.Errorf("find container iface: %w", err)
	}

	// Assign all IPs from the IPAM result.
	for _, ipc := range result.IPs {
		addr := &netlink.Addr{IPNet: &ipc.Address}
		if err := netlink.AddrAdd(contLink, addr); err != nil {
			return fmt.Errorf("add address %v: %w", ipc.Address, err)
		}
	}

	if err := netlink.LinkSetUp(contLink); err != nil {
		return fmt.Errorf("bring up container iface: %w", err)
	}

	// Add default route via the gateway.
	if len(result.Routes) > 0 {
		for _, route := range result.Routes {
			rt := &netlink.Route{
				LinkIndex: contLink.Attrs().Index,
				Dst:       route.Dst,
				Gw:        route.GW,
			}
			if err := netlink.RouteAdd(rt); err != nil {
				return fmt.Errorf("add route %v: %w", route, err)
			}
		}
	}

	return nil
}

func parseConfig(data []byte) (*NetConf, error) {
	conf := &NetConf{
		BridgeName: defaultBridgeName,
		MTU:        defaultMTU,
	}
	if err := json.Unmarshal(data, conf); err != nil {
		return nil, err
	}
	return conf, nil
}
```

### CNI Configuration File

```json
{
  "cniVersion": "1.0.0",
  "name": "simple-network",
  "type": "cni-simple",
  "bridge": "cni0",
  "mtu": 1500,
  "ipam": {
    "type": "host-local",
    "subnet": "172.20.0.0/24",
    "rangeStart": "172.20.0.10",
    "rangeEnd": "172.20.0.200",
    "gateway": "172.20.0.1",
    "routes": [
      {"dst": "0.0.0.0/0"}
    ]
  }
}
```

### Installing and Testing the Plugin

```bash
# Build the plugin.
go build -o /opt/cni/bin/cni-simple ./cmd/cni-simple/

# Install configuration.
mkdir -p /etc/cni/net.d
cat > /etc/cni/net.d/10-simple.conflist <<'EOF'
{
  "cniVersion": "1.0.0",
  "name": "simple-network",
  "plugins": [
    {
      "type": "cni-simple",
      "bridge": "cni0",
      "mtu": 1500,
      "ipam": {
        "type": "host-local",
        "subnet": "172.20.0.0/24",
        "gateway": "172.20.0.1",
        "routes": [{"dst": "0.0.0.0/0"}]
      }
    }
  ]
}
EOF

# Test with the cnitool utility.
export CNI_PATH=/opt/cni/bin
export NETCONFPATH=/etc/cni/net.d

# Create a test namespace.
ip netns add cni-test

# Add the network.
cnitool add simple-network /var/run/netns/cni-test

# Verify.
ip netns exec cni-test ip addr
ip netns exec cni-test ping -c 3 172.20.0.1

# Clean up.
cnitool del simple-network /var/run/netns/cni-test
ip netns del cni-test
```

## Section 7: iptables Deep Dive

Understanding how Kubernetes uses iptables is essential for debugging kube-proxy, network policies, and service routing.

### Kubernetes Service iptables Rules

```bash
# Show all KUBE-SERVICES rules.
iptables -t nat -L KUBE-SERVICES -n --line-numbers

# Show rules for a specific service.
# First find the service's ClusterIP.
kubectl get svc my-service -o jsonpath='{.spec.clusterIP}'

# Then find the corresponding KUBE-SVC chain.
iptables -t nat -L KUBE-SERVICES -n | grep 10.96.100.50

# Follow the chain to see the backend endpoints.
iptables -t nat -L KUBE-SVC-XXXXXXXXXXXXXXXXX -n

# Show the DNAT rules for specific endpoints.
iptables -t nat -L KUBE-SEP-XXXXXXXXXXXXXXXXX -n
```

### Custom iptables Rules for Network Segmentation

```bash
# Block all traffic between two namespace CIDRs except DNS.
iptables -A FORWARD \
  -s 10.200.0.0/24 -d 10.201.0.0/24 \
  -p udp --dport 53 -j ACCEPT

iptables -A FORWARD \
  -s 10.200.0.0/24 -d 10.201.0.0/24 \
  -j DROP

# Rate-limit new connections from containers to prevent SYN floods.
iptables -A FORWARD \
  -p tcp --syn \
  -m limit --limit 25/second --limit-burst 50 \
  -j ACCEPT

iptables -A FORWARD \
  -p tcp --syn \
  -j DROP
```

### Inspecting Packet Flow with TRACE

```bash
# Enable the raw table TRACE target to debug packet flow.
# WARNING: This is very verbose. Use specific matches.
iptables -t raw -A PREROUTING \
  -p tcp -d 172.20.0.10 --dport 8080 \
  -j TRACE

# Read trace output.
dmesg | grep "TRACE:"

# Remove trace rule when done.
iptables -t raw -D PREROUTING \
  -p tcp -d 172.20.0.10 --dport 8080 \
  -j TRACE
```

## Section 8: nftables (Modern Alternative)

nftables replaces iptables in modern Linux distributions. Kubernetes is gradually migrating to nftables support.

```bash
# Show all nftables rules.
nft list ruleset

# Create a table for container NAT.
nft add table ip container-nat

# Add a chain for POSTROUTING.
nft add chain ip container-nat postrouting \
  '{ type nat hook postrouting priority srcnat ; }'

# Add MASQUERADE for container traffic.
nft add rule ip container-nat postrouting \
  ip saddr 172.20.0.0/24 oifname != "cni0" masquerade

# Show the table.
nft list table ip container-nat
```

## Section 9: Advanced Debugging

### Capturing Traffic Between Containers

```bash
# Install nsenter and tcpdump on the host.
apt-get install -y tcpdump

# Find the pod's network namespace.
POD_PID=$(crictl inspect \
  $(crictl pods --name my-pod -q) \
  | jq -r '.info.pid')

# Capture on the pod's eth0 from outside the namespace.
nsenter -n -t $POD_PID -- \
  tcpdump -i eth0 -nn -w /tmp/pod-capture.pcap

# Alternatively, capture on the host veth peer.
VETH=$(ip link | grep -A1 "^$(ip link | grep -E "^[0-9]+: veth" \
  | grep "$(nsenter -n -t $POD_PID -- ip link show eth0 | grep -o 'if[0-9]*' | tr -d 'if')")")
tcpdump -i $VETH -nn -w /tmp/host-veth-capture.pcap
```

### Checking Conntrack State

```bash
# Show all connection tracking entries.
conntrack -L

# Filter by container IP.
conntrack -L | grep 172.20.0.10

# Show conntrack statistics.
conntrack -S

# Delete stale conntrack entries (useful after IP address changes).
conntrack -D -s 172.20.0.10
```

### MTU Troubleshooting

MTU mismatches between the container network and the underlying infrastructure (especially with VXLAN overlays) cause silent packet drops that are very hard to diagnose.

```bash
# Check the MTU of all interfaces.
ip link show | grep mtu

# Test with progressively larger packets.
# PMTUD (Path MTU Discovery) should handle this automatically,
# but it often breaks in cloud environments.
ip netns exec ctr-a ping -M do -s 1472 10.200.0.1  # 1472 + 28 bytes header = 1500

# If this fails but smaller sizes work, you have an MTU issue.
# Common fix: set lower MTU for the container interface.
ip netns exec ctr-a ip link set eth0 mtu 1450

# In Kubernetes, set MTU in the CNI configuration or the CNI plugin flags.
# For flannel:
kubectl -n kube-flannel edit configmap kube-flannel-cfg
# Set: "mtu": 1450 in the flannel-cni-conf section.
```

## Section 10: Network Policy Implementation

Network policies in Kubernetes are enforced by the CNI plugin, not by Kubernetes itself. Understanding how Calico implements NetworkPolicy with iptables helps when debugging policy issues.

```bash
# Calico uses a chain hierarchy for NetworkPolicy.
# List Calico chains.
iptables -L | grep -E "^Chain cali-"

# Show rules for a specific pod.
# Calico names chains based on the interface prefix.
iptables -L cali-tw-cali1234abcd -n -v

# For Cilium, use its own tooling.
kubectl -n kube-system exec -ti ds/cilium -- cilium endpoint list
kubectl -n kube-system exec -ti ds/cilium -- cilium policy get
```

## Section 11: Production Considerations

### Choosing Between iptables and IPVS for kube-proxy

```bash
# Check current kube-proxy mode.
kubectl -n kube-system get configmap kube-proxy -o yaml | grep mode

# iptables mode: O(n) rule lookup, struggles beyond ~5000 services.
# IPVS mode: O(1) hash table lookup, scales to tens of thousands of services.

# Switch to IPVS mode.
kubectl -n kube-system edit configmap kube-proxy
# Set: mode: "ipvs"

# Verify IPVS rules.
ipvsadm -L -n
```

### Bandwidth Throttling with Traffic Control

```bash
# Limit a container's bandwidth to 100 Mbit/s using tc.
# This is what the bandwidth CNI plugin does.
tc qdisc add dev veth-a-host root tbf \
  rate 100mbit \
  burst 15k \
  latency 50ms

# Verify.
tc qdisc show dev veth-a-host
tc -s qdisc show dev veth-a-host
```

### Performance Benchmarking

```bash
# Baseline performance between two containers on the same host.
# Server side (in ctr-b):
ip netns exec ctr-b iperf3 -s

# Client side (in ctr-a):
ip netns exec ctr-a iperf3 -c 172.20.0.20 -t 30 -P 4

# Expected: near line rate for loopback (~10-40 Gbps on modern hardware).
# If significantly lower, check: IRQ affinity, NAPI coalescing, bridge offload settings.

# Check if bridge offloading is enabled.
ethtool -k veth-a-host | grep -E "(tx-checksumming|scatter-gather|generic-segmentation)"
```

## Conclusion

Linux container networking is not magic — it is a composition of a small number of well-understood kernel primitives. veth pairs and network namespaces provide isolation. Bridges and routing provide connectivity. iptables and nftables provide NAT and filtering. Once you understand these building blocks, you can debug any CNI plugin issue, write your own networking tooling, and reason clearly about the security and performance characteristics of your container network.

The CNI plugin written in this guide is intentionally minimal, but it demonstrates the complete lifecycle of container networking: creating a bridge, attaching veth pairs, running IPAM, configuring the namespace, and cleaning up on delete. Real production CNI plugins add overlay networking (VXLAN, GENEVE), BGP route distribution, eBPF-based datapath, and distributed IPAM — but they all start with the same primitives shown here.
