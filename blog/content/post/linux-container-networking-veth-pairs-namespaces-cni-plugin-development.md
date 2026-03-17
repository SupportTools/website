---
title: "Linux Container Networking: veth Pairs, Network Namespaces, and CNI Plugin Development"
date: 2029-12-26T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "CNI", "Containers", "Kubernetes", "Network Namespaces", "veth", "Bridge", "eBPF"]
categories:
- Linux
- Networking
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into veth pair creation, network namespace management, bridge networking, CNI specification, and custom CNI plugin implementation for enterprise container platforms."
more_link: "yes"
url: "/linux-container-networking-veth-pairs-namespaces-cni-plugin-development/"
---

Container networking is built on a small set of Linux primitives: network namespaces, veth pairs, and bridges. Understanding these primitives at the kernel level is the prerequisite for debugging CNI failures, writing custom CNI plugins, and tuning container network performance. This guide builds from bare kernel concepts up through a working CNI plugin.

<!--more-->

## Section 1: Network Namespaces — The Isolation Boundary

A Linux network namespace is a complete, isolated copy of the network stack: its own interfaces, routing table, iptables rules, and socket table. Every container gets a dedicated namespace. The host network lives in the initial (default) namespace.

### Creating and Inspecting Namespaces

```bash
# Create a named network namespace.
ip netns add myns

# List all named namespaces (stored as bind mounts in /var/run/netns/).
ip netns list

# Run a command inside the namespace.
ip netns exec myns ip link list

# Check current namespace from a process.
ls -la /proc/$$/ns/net
```

Namespaces created by container runtimes are typically anonymous (bind-mounted to `/var/run/docker/netns/` or `/proc/<pid>/ns/net`). You can attach to them by bind-mounting:

```bash
# Attach to a running container's network namespace by PID.
CONTAINER_PID=$(docker inspect -f '{{.State.Pid}}' mycontainer)
nsenter --net=/proc/${CONTAINER_PID}/ns/net ip addr
```

### Namespace Lifecycle with Go

The `github.com/vishvananda/netns` package wraps the `setns(2)` syscall:

```go
package netnsutil

import (
    "fmt"
    "runtime"

    "github.com/vishvananda/netns"
)

// RunInNetNS executes fn inside the named network namespace.
func RunInNetNS(nsPath string, fn func() error) error {
    // Lock OS thread — Linux namespace calls are per-thread.
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Save current namespace.
    origNS, err := netns.Get()
    if err != nil {
        return fmt.Errorf("get current ns: %w", err)
    }
    defer origNS.Close()

    // Open target namespace.
    targetNS, err := netns.GetFromPath(nsPath)
    if err != nil {
        return fmt.Errorf("open ns %s: %w", nsPath, err)
    }
    defer targetNS.Close()

    // Switch into the target namespace.
    if err := netns.Set(targetNS); err != nil {
        return fmt.Errorf("set ns: %w", err)
    }
    // Restore original namespace on exit.
    defer netns.Set(origNS)

    return fn()
}
```

## Section 2: veth Pairs — The Virtual Ethernet Cable

A veth (virtual Ethernet) pair is a full-duplex pipe between two network namespaces. Packets sent into one end emerge from the other. Container runtimes create a veth pair, place one end (usually `eth0`) inside the container namespace and the other (usually `vethXXXXXX`) in the host namespace, then attach the host end to a bridge.

### Manual veth Creation

```bash
# Create a veth pair.
ip link add veth0 type veth peer name veth1

# Move veth1 into the network namespace.
ip link set veth1 netns myns

# Configure the host side.
ip addr add 10.10.0.1/24 dev veth0
ip link set veth0 up

# Configure the container side.
ip netns exec myns ip addr add 10.10.0.2/24 dev veth1
ip netns exec myns ip link set veth1 up
ip netns exec myns ip link set lo up

# Add a default route inside the namespace.
ip netns exec myns ip route add default via 10.10.0.1

# Test connectivity.
ip netns exec myns ping -c 3 10.10.0.1
```

### Creating veth Pairs with Go (netlink)

```go
package vethutil

import (
    "fmt"
    "net"

    "github.com/vishvananda/netlink"
    "github.com/vishvananda/netns"
)

// VethConfig defines the parameters for a veth pair.
type VethConfig struct {
    HostIfName      string // e.g., "veth0abc123"
    ContainerIfName string // e.g., "eth0"
    HostIP          *net.IPNet
    ContainerIP     *net.IPNet
    ContainerNSPath string
}

// CreateVethPair creates a veth pair and configures both ends.
func CreateVethPair(cfg VethConfig) error {
    // Create the pair in the host namespace.
    la := netlink.NewLinkAttrs()
    la.Name = cfg.HostIfName
    veth := &netlink.Veth{
        LinkAttrs: la,
        PeerName:  cfg.ContainerIfName,
    }
    if err := netlink.LinkAdd(veth); err != nil {
        return fmt.Errorf("add veth pair: %w", err)
    }

    // Configure the host end.
    hostLink, err := netlink.LinkByName(cfg.HostIfName)
    if err != nil {
        return fmt.Errorf("get host link: %w", err)
    }
    if err := netlink.AddrAdd(hostLink, &netlink.Addr{IPNet: cfg.HostIP}); err != nil {
        return fmt.Errorf("addr host: %w", err)
    }
    if err := netlink.LinkSetUp(hostLink); err != nil {
        return fmt.Errorf("set host up: %w", err)
    }

    // Move the peer end into the container namespace.
    peerLink, err := netlink.LinkByName(cfg.ContainerIfName)
    if err != nil {
        return fmt.Errorf("get peer link: %w", err)
    }
    targetNS, err := netns.GetFromPath(cfg.ContainerNSPath)
    if err != nil {
        return fmt.Errorf("get container ns: %w", err)
    }
    defer targetNS.Close()

    if err := netlink.LinkSetNsFd(peerLink, int(targetNS)); err != nil {
        return fmt.Errorf("move to ns: %w", err)
    }

    // Configure the container end from within its namespace.
    return RunInNetNS(cfg.ContainerNSPath, func() error {
        link, err := netlink.LinkByName(cfg.ContainerIfName)
        if err != nil {
            return err
        }
        if err := netlink.AddrAdd(link, &netlink.Addr{IPNet: cfg.ContainerIP}); err != nil {
            return err
        }
        return netlink.LinkSetUp(link)
    })
}
```

## Section 3: Bridge Networking — Connecting Multiple Containers

A Linux bridge acts as a virtual switch. All veth host-ends plug into the bridge; the bridge forwards frames between them and to the host's external interface.

### Bridge Setup

```bash
# Create a bridge.
ip link add br0 type bridge
ip addr add 172.20.0.1/16 dev br0
ip link set br0 up

# Attach a veth host-end to the bridge.
ip link set veth0 master br0

# Enable IP forwarding.
sysctl -w net.ipv4.ip_forward=1

# NAT outbound traffic from containers.
iptables -t nat -A POSTROUTING -s 172.20.0.0/16 ! -o br0 -j MASQUERADE
```

### Programmatic Bridge Management

```go
package bridge

import (
    "fmt"
    "net"

    "github.com/vishvananda/netlink"
)

// EnsureBridge creates or retrieves a bridge with the given name and CIDR.
func EnsureBridge(name, cidr string) (*netlink.Bridge, error) {
    la := netlink.NewLinkAttrs()
    la.Name = name
    br := &netlink.Bridge{LinkAttrs: la}

    existing, err := netlink.LinkByName(name)
    if err == nil {
        if b, ok := existing.(*netlink.Bridge); ok {
            return b, nil
        }
        return nil, fmt.Errorf("link %s exists but is not a bridge", name)
    }

    if err := netlink.LinkAdd(br); err != nil {
        return nil, fmt.Errorf("add bridge: %w", err)
    }

    ip, ipNet, err := net.ParseCIDR(cidr)
    if err != nil {
        return nil, fmt.Errorf("parse cidr: %w", err)
    }
    ipNet.IP = ip

    link, _ := netlink.LinkByName(name)
    if err := netlink.AddrAdd(link, &netlink.Addr{IPNet: ipNet}); err != nil {
        return nil, fmt.Errorf("addr bridge: %w", err)
    }
    if err := netlink.LinkSetUp(link); err != nil {
        return nil, fmt.Errorf("set bridge up: %w", err)
    }

    return br, nil
}

// AttachToBridge adds the named interface to the bridge.
func AttachToBridge(bridgeName, ifName string) error {
    br, err := netlink.LinkByName(bridgeName)
    if err != nil {
        return fmt.Errorf("get bridge: %w", err)
    }
    link, err := netlink.LinkByName(ifName)
    if err != nil {
        return fmt.Errorf("get interface: %w", err)
    }
    return netlink.LinkSetMaster(link, br)
}
```

## Section 4: CNI Specification

The Container Network Interface (CNI) specification defines a simple contract between container runtimes (kubelet, containerd, CRI-O) and network plugins. A CNI plugin is an executable binary invoked with:

- Environment variables for operation type, namespace path, and container ID
- A JSON configuration on stdin

### CNI Environment Variables

```
CNI_COMMAND     ADD | DEL | CHECK | VERSION
CNI_CONTAINERID Container ID
CNI_NETNS       Path to the network namespace (e.g., /var/run/netns/abc123)
CNI_IFNAME      Interface name to create inside the container (e.g., eth0)
CNI_ARGS        Extra arguments (K=V;K=V)
CNI_PATH        Colon-separated list of directories to search for CNI plugins
```

### CNI Configuration Format

```json
{
  "cniVersion": "1.0.0",
  "name": "mynet",
  "type": "my-cni-plugin",
  "bridge": "cni0",
  "subnet": "10.88.0.0/16",
  "gateway": "10.88.0.1",
  "dns": {
    "nameservers": ["1.1.1.1"],
    "search": ["cluster.local"]
  }
}
```

### CNI Result Format

On ADD, a plugin must write a JSON result to stdout:

```json
{
  "cniVersion": "1.0.0",
  "interfaces": [
    {
      "name": "eth0",
      "mac": "02:11:22:33:44:55",
      "sandbox": "/var/run/netns/abc123"
    }
  ],
  "ips": [
    {
      "interface": 0,
      "address": "10.88.0.5/16",
      "gateway": "10.88.0.1"
    }
  ],
  "routes": [
    {
      "dst": "0.0.0.0/0"
    }
  ]
}
```

## Section 5: Custom CNI Plugin Implementation

The `github.com/containernetworking/cni` library provides the scaffolding to write CNI plugins in Go.

```bash
go get github.com/containernetworking/cni@v1.1.2
go get github.com/containernetworking/plugins@v1.4.1
go get github.com/vishvananda/netlink@v1.2.1
go get github.com/vishvananda/netns@v0.0.4
```

### Plugin Structure

```go
// main.go — the CNI plugin binary entry point.
package main

import (
    "encoding/json"
    "fmt"
    "net"
    "os"

    "github.com/containernetworking/cni/pkg/skel"
    "github.com/containernetworking/cni/pkg/types"
    current "github.com/containernetworking/cni/pkg/types/100"
    "github.com/containernetworking/cni/pkg/version"
    "github.com/vishvananda/netlink"
    "github.com/vishvananda/netns"
    "runtime"
)

// NetConf is the plugin configuration parsed from stdin.
type NetConf struct {
    types.NetConf
    Bridge  string `json:"bridge"`
    Subnet  string `json:"subnet"`
    Gateway string `json:"gateway"`
}

func init() {
    // Ensure single-threaded for namespace operations.
    runtime.LockOSThread()
}

func main() {
    skel.PluginMain(cmdAdd, cmdCheck, cmdDel,
        version.All, "my-cni-plugin v1.0.0")
}

// cmdAdd sets up networking for a new container.
func cmdAdd(args *skel.CmdArgs) error {
    conf, err := loadConf(args.StdinData)
    if err != nil {
        return err
    }

    // Ensure the bridge exists.
    br, err := ensureBridge(conf.Bridge, conf.Gateway+"/16")
    if err != nil {
        return fmt.Errorf("ensure bridge: %w", err)
    }

    // Allocate an IP (simplified — use IPAM in production).
    containerIP, ipNet, _ := net.ParseCIDR(conf.Subnet)
    containerIP[15]++ // naive increment; use proper IPAM
    ipNet.IP = containerIP

    // Generate a unique veth name.
    hostVethName := generateVethName(args.ContainerID)

    // Create veth pair.
    la := netlink.NewLinkAttrs()
    la.Name = hostVethName
    veth := &netlink.Veth{
        LinkAttrs: la,
        PeerName:  args.IfName,
    }
    if err := netlink.LinkAdd(veth); err != nil {
        return fmt.Errorf("add veth: %w", err)
    }

    // Attach host veth to bridge.
    hostLink, _ := netlink.LinkByName(hostVethName)
    netlink.LinkSetMaster(hostLink, br)
    netlink.LinkSetUp(hostLink)

    // Move peer into container namespace.
    peerLink, _ := netlink.LinkByName(args.IfName)
    targetNS, err := netns.GetFromPath(args.Netns)
    if err != nil {
        return fmt.Errorf("get ns: %w", err)
    }
    defer targetNS.Close()
    netlink.LinkSetNsFd(peerLink, int(targetNS))

    // Configure the container interface.
    origNS, _ := netns.Get()
    defer origNS.Close()
    netns.Set(targetNS)

    link, _ := netlink.LinkByName(args.IfName)
    netlink.AddrAdd(link, &netlink.Addr{IPNet: ipNet})
    netlink.LinkSetUp(link)

    // Add default route.
    gw := net.ParseIP(conf.Gateway)
    netlink.RouteAdd(&netlink.Route{
        LinkIndex: link.Attrs().Index,
        Gw:        gw,
    })

    netns.Set(origNS)

    // Return CNI result.
    result := &current.Result{
        CNIVersion: conf.CNIVersion,
        Interfaces: []*current.Interface{
            {
                Name:    args.IfName,
                Sandbox: args.Netns,
            },
        },
        IPs: []*current.IPConfig{
            {
                Interface: current.Int(0),
                Address:   *ipNet,
                Gateway:   gw,
            },
        },
    }
    return types.PrintResult(result, conf.CNIVersion)
}

func cmdDel(args *skel.CmdArgs) error {
    // Remove veth pair (deleting the host end removes the pair).
    hostVethName := generateVethName(args.ContainerID)
    link, err := netlink.LinkByName(hostVethName)
    if err != nil {
        return nil // already gone
    }
    return netlink.LinkDel(link)
}

func cmdCheck(args *skel.CmdArgs) error {
    return nil
}

func loadConf(data []byte) (*NetConf, error) {
    conf := &NetConf{}
    if err := json.Unmarshal(data, conf); err != nil {
        return nil, fmt.Errorf("parse config: %w", err)
    }
    return conf, nil
}

func generateVethName(containerID string) string {
    if len(containerID) > 12 {
        containerID = containerID[:12]
    }
    return "veth" + containerID
}

func ensureBridge(name, cidr string) (*netlink.Bridge, error) {
    la := netlink.NewLinkAttrs()
    la.Name = name
    br := &netlink.Bridge{LinkAttrs: la}

    if existing, err := netlink.LinkByName(name); err == nil {
        if b, ok := existing.(*netlink.Bridge); ok {
            return b, nil
        }
    }
    if err := netlink.LinkAdd(br); err != nil {
        return nil, err
    }
    ip, ipNet, err := net.ParseCIDR(cidr)
    if err != nil {
        return nil, err
    }
    ipNet.IP = ip
    link, _ := netlink.LinkByName(name)
    netlink.AddrAdd(link, &netlink.Addr{IPNet: ipNet})
    netlink.LinkSetUp(link)
    return br, nil
}
```

## Section 6: IPAM — IP Address Management

Production CNI plugins delegate IP allocation to a separate IPAM plugin:

```json
{
  "cniVersion": "1.0.0",
  "name": "mynet",
  "type": "my-cni-plugin",
  "bridge": "cni0",
  "ipam": {
    "type": "host-local",
    "subnet": "10.88.0.0/16",
    "rangeStart": "10.88.0.10",
    "rangeEnd": "10.88.0.250",
    "gateway": "10.88.0.1",
    "routes": [
      { "dst": "0.0.0.0/0" }
    ]
  }
}
```

Invoke the IPAM plugin from within your CNI plugin using the skel library helpers:

```go
import (
    "github.com/containernetworking/cni/pkg/invoke"
    current "github.com/containernetworking/cni/pkg/types/100"
)

func runIPAM(conf *NetConf, args *skel.CmdArgs) (*current.Result, error) {
    ipamResult, err := invoke.DelegateAdd(
        context.TODO(),
        conf.IPAM.Type,
        args.StdinData,
        nil,
    )
    if err != nil {
        return nil, fmt.Errorf("ipam add: %w", err)
    }
    result, err := current.NewResultFromResult(ipamResult)
    if err != nil {
        return nil, fmt.Errorf("ipam result: %w", err)
    }
    return result, nil
}
```

## Section 7: Deploying a Custom CNI Plugin in Kubernetes

Package the plugin binary in a DaemonSet that installs it to `/opt/cni/bin/`:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-cni-installer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: my-cni-installer
  template:
    metadata:
      labels:
        app: my-cni-installer
    spec:
      hostNetwork: true
      tolerations:
        - operator: Exists
          effect: NoSchedule
      initContainers:
        - name: install-cni
          image: registry.example.com/my-cni-plugin:v1.0.0
          command:
            - /bin/sh
            - -c
            - |
              cp /opt/cni/bin/my-cni-plugin /host/opt/cni/bin/my-cni-plugin
              cp /etc/cni/net.d/10-mynet.conflist /host/etc/cni/net.d/10-mynet.conflist
          volumeMounts:
            - name: cni-bin-dir
              mountPath: /host/opt/cni/bin
            - name: cni-net-dir
              mountPath: /host/etc/cni/net.d
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
      volumes:
        - name: cni-bin-dir
          hostPath:
            path: /opt/cni/bin
        - name: cni-net-dir
          hostPath:
            path: /etc/cni/net.d
```

The CNI configuration file `/etc/cni/net.d/10-mynet.conflist`:

```json
{
  "cniVersion": "1.0.0",
  "name": "mynet",
  "plugins": [
    {
      "type": "my-cni-plugin",
      "bridge": "cni0",
      "subnet": "10.88.0.0/16",
      "gateway": "10.88.0.1",
      "ipam": {
        "type": "host-local",
        "subnet": "10.88.0.0/16",
        "rangeStart": "10.88.0.10",
        "rangeEnd": "10.88.0.250",
        "gateway": "10.88.0.1"
      }
    },
    {
      "type": "portmap",
      "capabilities": { "portMappings": true }
    }
  ]
}
```

## Section 8: Debugging Container Networking

### Common Diagnostic Commands

```bash
# Inspect all network namespaces and their interfaces.
for ns in $(ip netns list | awk '{print $1}'); do
    echo "=== $ns ==="; ip netns exec "$ns" ip addr; done

# Trace packet path through iptables.
iptables -t nat -nvL --line-numbers
iptables -t filter -nvL --line-numbers
conntrack -L

# Check bridge forwarding table.
bridge fdb show dev cni0

# Capture packets on a veth in a container namespace.
CONTAINER_PID=$(crictl inspect <container-id> | jq -r '.info.pid')
nsenter --net=/proc/${CONTAINER_PID}/ns/net \
    tcpdump -i eth0 -n -w /tmp/container.pcap

# Monitor netlink events.
ip monitor all
```

### CNI Debug Logging

Set `CNI_ARGS=DEBUG=true` and capture stderr to a log file when troubleshooting plugin invocations:

```bash
# Manually invoke a CNI plugin for testing.
export CNI_COMMAND=ADD
export CNI_CONTAINERID=test-container-001
export CNI_NETNS=/var/run/netns/testns
export CNI_IFNAME=eth0
export CNI_PATH=/opt/cni/bin

echo '{"cniVersion":"1.0.0","name":"testnet","type":"my-cni-plugin","bridge":"cni0","subnet":"10.88.0.0/16","gateway":"10.88.0.1"}' \
    | /opt/cni/bin/my-cni-plugin 2>&1
```

Container networking is deterministic once you understand the underlying primitives. The path from `kubectl apply` to a running pod with network connectivity traverses namespace creation, veth instantiation, bridge attachment, IPAM allocation, and iptables rules — every step auditable with the commands and code patterns in this guide.
