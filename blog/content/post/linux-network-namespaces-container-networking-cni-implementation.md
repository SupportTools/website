---
title: "Linux Network Namespaces: Container Networking Internals and Manual CNI Implementation"
date: 2030-06-16T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Kubernetes", "CNI", "Containers", "Network Namespaces"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux network namespaces, veth pairs, bridges, iptables NAT rules, how Docker/Kubernetes networking works internally, and building a minimal CNI plugin from scratch."
more_link: "yes"
url: "/linux-network-namespaces-container-networking-cni-implementation/"
---

Every container network — whether managed by Docker, Kubernetes with Flannel, or Cilium — is built on a small set of Linux kernel primitives: network namespaces, virtual Ethernet pairs, bridges, and iptables rules. Understanding these primitives at the system call level demystifies container networking, makes troubleshooting faster, and is essential knowledge for building CNI plugins or debugging production network failures. This guide covers each primitive in detail, traces how Docker and Kubernetes use them, and builds a functional minimal CNI plugin from scratch.

<!--more-->

## Network Namespace Fundamentals

A network namespace is a complete, isolated copy of the Linux network stack. Each namespace has its own:

- Network interfaces (including `lo`)
- Routing tables
- iptables rules
- Netfilter conntrack tables
- Socket table

Processes within a namespace can only see and use the interfaces in that namespace. By default, a new network namespace has only a loopback interface and no routes.

### Creating Namespaces Manually

```bash
# Create two network namespaces
ip netns add ns-alpha
ip netns add ns-beta

# List namespaces
ip netns list

# Execute a command inside a namespace
ip netns exec ns-alpha ip addr show

# The loopback interface exists but is DOWN
# ip netns exec ns-alpha ip addr show lo
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN group default qlen 1000
#     link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00

# Bring loopback up
ip netns exec ns-alpha ip link set lo up
```

### Namespace Lifecycle

Namespaces are reference-counted kernel objects. They persist as long as:
1. A process has the namespace as its active network namespace, OR
2. A bind mount exists at `/var/run/netns/<name>`

The `ip netns add` command creates a bind mount, allowing the namespace to persist even after all processes using it have exited.

```bash
# The bind mount backing the named namespace
ls -la /var/run/netns/

# Delete the namespace (removes bind mount; kernel object freed when all processes exit)
ip netns delete ns-alpha
```

## Virtual Ethernet Pairs

A veth pair is a pair of interconnected virtual network interfaces. Packets transmitted on one end appear immediately on the other. Veth pairs are the primary mechanism for connecting a network namespace to the host or to a bridge.

### Creating and Using veth Pairs

```bash
# Create a veth pair: veth0 <-> veth1
ip link add veth0 type veth peer name veth1

# Both interfaces exist in the host namespace
ip link show veth0
ip link show veth1

# Move veth1 into a namespace
ip link set veth1 netns ns-alpha

# Now veth1 only visible inside ns-alpha
ip link show veth1  # Error: does not exist in host namespace
ip netns exec ns-alpha ip link show veth1  # Found

# Assign IP addresses
ip addr add 10.0.0.1/24 dev veth0
ip netns exec ns-alpha ip addr add 10.0.0.2/24 dev veth1

# Bring both interfaces up
ip link set veth0 up
ip netns exec ns-alpha ip link set veth1 up

# Test connectivity
ip netns exec ns-alpha ping -c3 10.0.0.1

# PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.
# 64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=0.045 ms
# 64 bytes from 10.0.0.1: icmp_seq=2 ttl=64 time=0.038 ms
```

## Linux Bridges

A bridge is a virtual Layer 2 switch. Connecting multiple veth pairs to a bridge allows containers to communicate with each other at Layer 2, similar to a physical switch.

### Multi-Namespace Bridge Setup

```bash
# Create the bridge
ip link add br-containers type bridge
ip link set br-containers up
ip addr add 172.20.0.1/24 dev br-containers

# Create namespace and veth pair for container 1
ip netns add container-1
ip link add veth-c1-host type veth peer name veth-c1-ns
ip link set veth-c1-ns netns container-1
ip link set veth-c1-host master br-containers
ip link set veth-c1-host up

ip netns exec container-1 ip addr add 172.20.0.2/24 dev veth-c1-ns
ip netns exec container-1 ip link set veth-c1-ns up
ip netns exec container-1 ip route add default via 172.20.0.1

# Create namespace and veth pair for container 2
ip netns add container-2
ip link add veth-c2-host type veth peer name veth-c2-ns
ip link set veth-c2-ns netns container-2
ip link set veth-c2-host master br-containers
ip link set veth-c2-host up

ip netns exec container-2 ip addr add 172.20.0.3/24 dev veth-c2-ns
ip netns exec container-2 ip link set veth-c2-ns up
ip netns exec container-2 ip route add default via 172.20.0.1

# Container-to-container ping (through bridge)
ip netns exec container-1 ping -c3 172.20.0.3

# Verify bridge FDB (forwarding database)
bridge fdb show br br-containers
```

## NAT and External Connectivity

Containers need access to external networks. This is achieved with iptables masquerading (SNAT) on the host.

```bash
# Enable IP forwarding on the host
echo 1 > /proc/sys/net/ipv4/ip_forward

# Or persist via sysctl
sysctl -w net.ipv4.ip_forward=1

# Add MASQUERADE rule for container subnet
# This rewrites the source IP of packets leaving the host interface
iptables -t nat -A POSTROUTING -s 172.20.0.0/24 ! -o br-containers -j MASQUERADE

# Allow forwarded traffic between bridge and host
iptables -A FORWARD -i br-containers -j ACCEPT
iptables -A FORWARD -o br-containers -j ACCEPT

# Test external access from container
ip netns exec container-1 ping -c3 8.8.8.8

# Trace the NAT translation
conntrack -L | grep 172.20.0.2
```

## Port Publishing (DNAT)

Publishing a container port to the host requires Destination NAT in the PREROUTING chain:

```bash
# Publish container-1:80 as host:8080
iptables -t nat -A PREROUTING \
  -p tcp \
  --dport 8080 \
  -j DNAT \
  --to-destination 172.20.0.2:80

# Allow the forwarded traffic
iptables -A FORWARD \
  -p tcp \
  -d 172.20.0.2 \
  --dport 80 \
  -j ACCEPT

# Also handle connections from the host itself (OUTPUT chain)
iptables -t nat -A OUTPUT \
  -p tcp \
  -d 127.0.0.1 \
  --dport 8080 \
  -j DNAT \
  --to-destination 172.20.0.2:80
```

## How Docker Uses These Primitives

Docker's networking model maps directly to these primitives:

```
docker0 bridge     <->  ip link add docker0 type bridge
container veth     <->  ip link add veth<random> type veth peer name eth0
IP assignment      <->  ip addr add <container-ip>/24 dev eth0
default route      <->  ip route add default via 172.17.0.1
MASQUERADE         <->  iptables -t nat -A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
port publish       <->  iptables -t nat -A PREROUTING -p tcp --dport <host-port> -j DNAT ...
```

```bash
# Inspect Docker's bridge and iptables rules
ip link show docker0
ip addr show docker0
bridge fdb show br docker0

# Docker's MASQUERADE rules
iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE

# Docker's DNAT rules for port publishing
iptables -t nat -L DOCKER -n -v
```

## How Kubernetes Uses Namespaces

In Kubernetes, each Pod gets its own network namespace. The pause container (also called the sandbox or infrastructure container) holds the network namespace. All other containers in the Pod join the pause container's namespace via `--network=container:<pause-id>`.

```bash
# Find the pause container for a pod
POD_NAME="my-app-pod-7d4f6b"
NAMESPACE="production"

# Get the pod's sandbox ID
SANDBOX_ID=$(crictl pods --name "${POD_NAME}" -o json | \
  jq -r '.items[0].id')

# Get the network namespace path
NETNS_PATH=$(crictl inspectp "${SANDBOX_ID}" | \
  jq -r '.info.runtimeSpec.linux.namespaces[] | select(.type=="network") | .path')

echo "Pod network namespace: ${NETNS_PATH}"
# Output: /var/run/netns/cni-<uuid>

# Inspect the pod's network configuration
nsenter --net="${NETNS_PATH}" ip addr show
nsenter --net="${NETNS_PATH}" ip route show
nsenter --net="${NETNS_PATH}" iptables -L -n
```

## CNI Plugin Architecture

The Container Network Interface (CNI) is a specification for how container runtimes configure networking. A CNI plugin is an executable that receives a JSON configuration on stdin and performs network setup (ADD) or teardown (DEL).

### CNI Plugin Contract

The runtime calls the plugin with:
- `CNI_COMMAND`: `ADD`, `DEL`, or `CHECK`
- `CNI_CONTAINERID`: The container's unique ID
- `CNI_NETNS`: The path to the container's network namespace
- `CNI_IFNAME`: The interface name inside the container (typically `eth0`)
- `CNI_PATH`: Colon-separated path to search for CNI plugins
- JSON config on stdin

The plugin outputs JSON on stdout describing the assigned IP address and interface.

### Minimal CNI Plugin Implementation

```bash
#!/bin/bash
# /opt/cni/bin/mini-cni
# A minimal CNI plugin that assigns a static IP from a predefined pool
# and connects the container to a bridge.

set -euo pipefail

BRIDGE_NAME="cni-bridge0"
BRIDGE_SUBNET="10.88.0.0/24"
BRIDGE_IP="10.88.0.1"
LOG_FILE="/var/log/mini-cni.log"

log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [mini-cni] $*" >> "${LOG_FILE}"
}

# Read CNI configuration from stdin
CNI_CONFIG=$(cat)

log "Command: ${CNI_COMMAND} ContainerID: ${CNI_CONTAINERID} NetNS: ${CNI_NETNS}"

setup_bridge() {
    if ! ip link show "${BRIDGE_NAME}" &>/dev/null; then
        ip link add "${BRIDGE_NAME}" type bridge
        ip addr add "${BRIDGE_IP}/24" dev "${BRIDGE_NAME}"
        ip link set "${BRIDGE_NAME}" up

        # Enable forwarding
        sysctl -w net.ipv4.ip_forward=1 &>/dev/null

        # Add MASQUERADE rule if not present
        if ! iptables -t nat -C POSTROUTING -s "${BRIDGE_SUBNET}" ! -o "${BRIDGE_NAME}" -j MASQUERADE 2>/dev/null; then
            iptables -t nat -A POSTROUTING -s "${BRIDGE_SUBNET}" ! -o "${BRIDGE_NAME}" -j MASQUERADE
        fi
    fi
}

allocate_ip() {
    local container_id="$1"
    local ip_file="/var/lib/mini-cni/${container_id}.ip"
    mkdir -p /var/lib/mini-cni

    # Simple sequential allocation by counting existing allocations
    local count
    count=$(ls /var/lib/mini-cni/*.ip 2>/dev/null | wc -l)
    local ip_suffix=$((count + 2))  # Start at .2, .1 is the bridge

    if [ "${ip_suffix}" -gt 254 ]; then
        log "ERROR: IP pool exhausted"
        exit 1
    fi

    echo "10.88.0.${ip_suffix}" > "${ip_file}"
    echo "10.88.0.${ip_suffix}"
}

get_ip() {
    local container_id="$1"
    cat "/var/lib/mini-cni/${container_id}.ip" 2>/dev/null || echo ""
}

release_ip() {
    local container_id="$1"
    rm -f "/var/lib/mini-cni/${container_id}.ip"
}

cmd_add() {
    setup_bridge

    # Allocate IP
    CONTAINER_IP=$(allocate_ip "${CNI_CONTAINERID}")
    log "Allocated IP: ${CONTAINER_IP} for container ${CNI_CONTAINERID}"

    # Create veth pair
    HOST_VETH="veth$(echo "${CNI_CONTAINERID}" | head -c8)"
    ip link add "${HOST_VETH}" type veth peer name "${CNI_IFNAME}" netns "${CNI_NETNS}"

    # Connect host end to bridge
    ip link set "${HOST_VETH}" master "${BRIDGE_NAME}"
    ip link set "${HOST_VETH}" up

    # Configure container end
    ip netns exec "${CNI_NETNS}" ip addr add "${CONTAINER_IP}/24" dev "${CNI_IFNAME}"
    ip netns exec "${CNI_NETNS}" ip link set "${CNI_IFNAME}" up
    ip netns exec "${CNI_NETNS}" ip link set lo up
    ip netns exec "${CNI_NETNS}" ip route add default via "${BRIDGE_IP}"

    # Output CNI result JSON
    cat <<EOF
{
  "cniVersion": "0.4.0",
  "interfaces": [
    {
      "name": "${HOST_VETH}",
      "mac": "$(cat /sys/class/net/${HOST_VETH}/address)",
      "sandbox": ""
    },
    {
      "name": "${CNI_IFNAME}",
      "mac": "$(ip netns exec ${CNI_NETNS} cat /sys/class/net/${CNI_IFNAME}/address)",
      "sandbox": "${CNI_NETNS}"
    }
  ],
  "ips": [
    {
      "version": "4",
      "address": "${CONTAINER_IP}/24",
      "gateway": "${BRIDGE_IP}",
      "interface": 1
    }
  ],
  "routes": [
    {
      "dst": "0.0.0.0/0"
    }
  ],
  "dns": {
    "nameservers": ["8.8.8.8", "8.8.4.4"]
  }
}
EOF
}

cmd_del() {
    CONTAINER_IP=$(get_ip "${CNI_CONTAINERID}")
    HOST_VETH="veth$(echo "${CNI_CONTAINERID}" | head -c8)"

    # Remove the veth pair (removing host end removes the pair)
    if ip link show "${HOST_VETH}" &>/dev/null; then
        ip link delete "${HOST_VETH}"
    fi

    release_ip "${CNI_CONTAINERID}"
    log "Deleted network for container ${CNI_CONTAINERID}"
}

cmd_check() {
    CONTAINER_IP=$(get_ip "${CNI_CONTAINERID}")
    if [ -z "${CONTAINER_IP}" ]; then
        echo '{"code": 4, "msg": "container not found in IP allocations"}'
        exit 1
    fi
    echo '{}'
}

case "${CNI_COMMAND}" in
    ADD)   cmd_add ;;
    DEL)   cmd_del ;;
    CHECK) cmd_check ;;
    VERSION)
        echo '{"cniVersion":"0.4.0","supportedVersions":["0.3.0","0.3.1","0.4.0"]}'
        ;;
    *)
        log "Unknown command: ${CNI_COMMAND}"
        exit 1
        ;;
esac
```

### CNI Configuration File

```json
{
  "cniVersion": "0.4.0",
  "name": "mini-cni-network",
  "type": "mini-cni",
  "bridge": "cni-bridge0",
  "isGateway": true,
  "ipMasq": true,
  "ipam": {
    "type": "host-local",
    "subnet": "10.88.0.0/24",
    "routes": [
      {"dst": "0.0.0.0/0"}
    ]
  },
  "dns": {
    "nameservers": ["8.8.8.8"]
  }
}
```

### Testing the CNI Plugin

```bash
# Install the plugin
chmod +x /opt/cni/bin/mini-cni
cp mini-cni.json /etc/cni/net.d/10-mini-cni.json

# Test with CNI reference tool (cnitool)
# Install: go install github.com/containernetworking/cni/cnitool@latest

# Create a test namespace
ip netns add test-container

# Run ADD
CNI_PATH=/opt/cni/bin \
  NETCONFPATH=/etc/cni/net.d \
  cnitool add mini-cni-network /var/run/netns/test-container

# Verify interface was configured
ip netns exec test-container ip addr show
ip netns exec test-container ip route show
ip netns exec test-container ping -c3 8.8.8.8

# Run DEL
CNI_PATH=/opt/cni/bin \
  NETCONFPATH=/etc/cni/net.d \
  cnitool del mini-cni-network /var/run/netns/test-container

ip netns delete test-container
```

## Kubernetes Pod Networking Trace

When kubelet creates a pod, the following sequence occurs:

```
1. kubelet calls container runtime (containerd/CRI-O) to create the sandbox
2. container runtime creates the pause container
3. container runtime creates the network namespace at /var/run/netns/cni-<uuid>
4. container runtime calls CNI plugin binary with CNI_COMMAND=ADD
5. CNI plugin (e.g., Flannel bridge) creates veth pair, configures IP, sets up routes
6. kubelet starts application containers, all sharing the pause container's netns
7. On pod deletion: CNI called with DEL, veth pair removed, IP released
```

```bash
# Watch CNI plugin invocations in real time
inotifywait -m /var/log/mini-cni.log &
kubectl run test-pod --image=nginx:alpine --restart=Never

# Full trace of network namespace for a running pod
POD_PID=$(crictl inspect $(crictl ps | grep test-pod | awk '{print $1}') | \
  jq -r '.info.pid')

# Enter pod's network namespace
nsenter -t "${POD_PID}" -n -- ip addr show
nsenter -t "${POD_PID}" -n -- ss -tlnp
nsenter -t "${POD_PID}" -n -- iptables -L -n
```

## Production Troubleshooting

### Network Namespace Not Cleaned Up

```bash
# Check for orphaned namespaces (namespace with no running process)
for ns in /var/run/netns/*; do
    ns_name=$(basename "${ns}")
    # Check if any process is using this namespace
    count=$(ip netns pids "${ns_name}" 2>/dev/null | wc -l)
    if [ "${count}" -eq 0 ]; then
        echo "Orphaned namespace: ${ns_name}"
    fi
done

# Force cleanup of specific orphaned namespace
ip netns delete orphaned-namespace-name
```

### ARP Proxy Issues on Bridge

```bash
# Enable ARP proxy on the bridge (required for some CNI configurations)
echo 1 > /proc/sys/net/ipv4/conf/br-containers/proxy_arp

# Or via sysctl
sysctl -w net.ipv4.conf.br-containers.proxy_arp=1
```

### MTU Mismatch

```bash
# Check MTU on all network interfaces in a pod
nsenter -t "${POD_PID}" -n -- ip link show

# If pod interface MTU doesn't account for overlay encapsulation (e.g., VXLAN adds 50 bytes),
# the host MTU is 1500, so the pod eth0 MTU should be 1450
nsenter -t "${POD_PID}" -n -- ip link set eth0 mtu 1450
```

### Packet Capture Across Namespaces

```bash
# Capture traffic on the veth host end (visible to tcpdump)
CONTAINER_ID=$(crictl ps | grep my-app | awk '{print $1}')
HOST_VETH=$(ip link | grep "veth" | grep -m1 "${CONTAINER_ID:0:8}" | awk '{print $2}' | tr -d ':')

# Capture on host veth
tcpdump -i "${HOST_VETH}" -n -w /tmp/container-capture.pcap

# Or capture inside the namespace
nsenter -t "${POD_PID}" -n -- tcpdump -i eth0 -n port 80
```

## Key Takeaways

Linux container networking is built entirely from five primitives:

1. **Network namespaces**: Isolate the network stack per container
2. **veth pairs**: Connect namespace to host or bridge
3. **Bridges**: Layer 2 switching between containers on the same host
4. **iptables MASQUERADE**: NAT for outbound container traffic
5. **iptables DNAT/PREROUTING**: Port publishing from host to container

All CNI plugins — Flannel, Calico, Cilium, Weave — are compositions of these primitives, with additional overlays (VXLAN, IPsec, WireGuard) for cross-node communication. Understanding the primitives enables accurate debugging of networking issues at any layer of the stack, from pod-to-pod connectivity to Service load balancing to NetworkPolicy enforcement.
