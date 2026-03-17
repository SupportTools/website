---
title: "Linux Network Namespaces: Building Container Networking From Scratch"
date: 2029-01-27T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Namespaces", "Containers", "CNI", "veth", "iptables"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A hands-on guide to Linux network namespaces covering veth pairs, bridge networking, iptables NAT, and the complete networking stack that powers container runtimes and Kubernetes pod networking."
more_link: "yes"
url: "/linux-network-namespaces-container-networking-from-scratch/"
---

Every container in Docker, Podman, and Kubernetes runs inside a Linux network namespace—an isolated instance of the network stack with its own interfaces, routing tables, iptables rules, and sockets. Understanding how network namespaces work at the kernel level demystifies container networking, enables effective troubleshooting, and provides the foundation for implementing custom CNI plugins.

This post builds a complete container networking setup from scratch using only standard Linux tools: `ip`, `iptables`, `bridge-utils`, and kernel subsystems. Starting from bare network namespaces, the examples construct the same networking model that Docker uses for bridge-mode containers.

<!--more-->

## Network Namespace Fundamentals

A Linux network namespace isolates the following kernel network state:
- Network interfaces (loopback, ethernet, veth, etc.)
- IPv4 and IPv6 routing tables
- iptables rules (filter, nat, mangle tables)
- Network sockets
- ARP and neighbor tables
- `ip_forward` and other network sysctl settings

Processes inside a namespace see only the interfaces and routes within that namespace. The default namespace (where `init` runs) is not special from a technical standpoint—it is just the namespace all processes inherit unless explicitly changed.

## Creating and Inspecting Network Namespaces

```bash
#!/bin/bash
# ns-basics.sh — Network namespace creation and inspection

# Create a named network namespace
ip netns add container-a
ip netns add container-b

# List all namespaces
ip netns list
# Output:
# container-b (id: 1)
# container-a (id: 0)

# Execute a command inside a namespace
ip netns exec container-a ip link list
# Output: only the loopback interface (down by default)
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN mode DEFAULT group default qlen 1000

# Bring up loopback inside the namespace
ip netns exec container-a ip link set lo up
ip netns exec container-a ip addr show lo
# inet 127.0.0.1/8 scope host lo

# Inspect the default namespace routing table vs namespace routing
echo "=== Default namespace routes ==="
ip route

echo "=== container-a routes ==="
ip netns exec container-a ip route
# (empty — no routes yet)

# /proc filesystem provides namespace information per-process
# All processes in container-a share the same network namespace file
ls -la /proc/self/ns/net
# lrwxrwxrwx 1 root root 0 ... /proc/self/ns/net -> net:[4026531840]

ip netns exec container-a ls -la /proc/self/ns/net
# lrwxrwxrwx 1 root root 0 ... /proc/self/ns/net -> net:[4026532008]
# Different inode = different namespace
```

## Virtual Ethernet Pairs (veth)

veth pairs are virtual network interfaces that exist as a pair: everything sent to one end appears on the other end. They are the fundamental building block for connecting network namespaces.

```bash
#!/bin/bash
# veth-pair.sh — Create a veth pair connecting two namespaces

# Create a veth pair: veth0 ↔ veth1
ip link add veth0 type veth peer name veth1

# Move one end into container-a
ip link set veth0 netns container-a

# Move the other end into container-b
ip link set veth1 netns container-b

# Verify each namespace sees one interface
echo "=== container-a interfaces ==="
ip netns exec container-a ip link list
# 1: lo: <LOOPBACK,UP,LOWER_UP>
# 4: veth0@if5: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN

echo "=== container-b interfaces ==="
ip netns exec container-b ip link list
# 1: lo: <LOOPBACK,UP,LOWER_UP>
# 5: veth1@if4: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN

# Assign IP addresses and bring up interfaces
ip netns exec container-a ip addr add 192.168.100.1/24 dev veth0
ip netns exec container-a ip link set veth0 up
ip netns exec container-a ip link set lo up

ip netns exec container-b ip addr add 192.168.100.2/24 dev veth1
ip netns exec container-b ip link set veth1 up
ip netns exec container-b ip link set lo up

# Verify connectivity
ip netns exec container-a ping -c3 192.168.100.2
# PING 192.168.100.2 (192.168.100.2) 56(84) bytes of data.
# 64 bytes from 192.168.100.2: icmp_seq=1 ttl=64 time=0.042 ms

echo "Direct veth pair connectivity established"
```

## Bridge Networking: Multiple Containers on One Subnet

Docker's bridge mode uses a Linux bridge (`docker0` by default) to connect multiple containers. Each container gets a veth pair with one end in the container namespace and the other attached to the bridge in the host namespace:

```bash
#!/bin/bash
# bridge-network.sh — Replicate Docker bridge networking from scratch

# Clean up previous state
ip netns del ns1 2>/dev/null || true
ip netns del ns2 2>/dev/null || true
ip netns del ns3 2>/dev/null || true
ip link del br-containers 2>/dev/null || true

# Create the bridge
ip link add br-containers type bridge
ip addr add 172.20.0.1/24 dev br-containers
ip link set br-containers up

# Enable forwarding (required for cross-namespace routing)
sysctl -w net.ipv4.ip_forward=1

# Function to create a container namespace and connect it to the bridge
create_container() {
    local ns_name="${1}"
    local ip_addr="${2}"
    local veth_host="veth-${ns_name}"
    local veth_ns="eth0"

    echo "Creating namespace: ${ns_name} (${ip_addr})"

    # Create namespace
    ip netns add "${ns_name}"

    # Create veth pair
    ip link add "${veth_host}" type veth peer name "${veth_ns}" netns "${ns_name}"

    # Connect host-side veth to bridge
    ip link set "${veth_host}" master br-containers
    ip link set "${veth_host}" up

    # Configure the namespace-side
    ip netns exec "${ns_name}" ip link set lo up
    ip netns exec "${ns_name}" ip addr add "${ip_addr}/24" dev "${veth_ns}"
    ip netns exec "${ns_name}" ip link set "${veth_ns}" up
    # Default route through the bridge gateway
    ip netns exec "${ns_name}" ip route add default via 172.20.0.1

    echo "  ${ns_name}: ${ip_addr}/24, gateway 172.20.0.1"
}

# Create three "containers"
create_container ns1 172.20.0.10
create_container ns2 172.20.0.11
create_container ns3 172.20.0.12

echo ""
echo "=== Bridge state ==="
bridge link show br-containers

echo ""
echo "=== Test connectivity ==="
# ns1 can reach ns2 directly through the bridge
ip netns exec ns1 ping -c2 172.20.0.11

# ns1 can reach ns3 directly
ip netns exec ns1 ping -c2 172.20.0.12

# ns1 can reach the host bridge IP (gateway)
ip netns exec ns1 ping -c2 172.20.0.1

echo ""
echo "=== ns1 routing table ==="
ip netns exec ns1 ip route
# default via 172.20.0.1 dev eth0
# 172.20.0.0/24 dev eth0 proto kernel scope link src 172.20.0.10
```

## NAT and External Connectivity

Containers need outbound internet access via NAT (Network Address Translation). Docker implements this with `iptables` masquerade rules:

```bash
#!/bin/bash
# nat-setup.sh — Configure iptables NAT for container external access

# Identify the host's external interface
HOST_IF=$(ip route | awk '/^default/ {print $5; exit}')
echo "Host external interface: ${HOST_IF}"

# Add iptables masquerade for container traffic leaving the host
# This translates container source IPs to the host's IP for outbound traffic
iptables -t nat -A POSTROUTING \
    -s 172.20.0.0/24 \
    ! -d 172.20.0.0/24 \
    -j MASQUERADE

# Allow forwarded traffic from containers (DOCKER-like chain)
iptables -A FORWARD -i br-containers -j ACCEPT
iptables -A FORWARD -o br-containers -j ACCEPT

# Test outbound connectivity from ns1
echo "Testing outbound access from ns1..."
ip netns exec ns1 ping -c2 8.8.8.8

# Set DNS resolver in the namespace
ip netns exec ns1 bash -c 'echo "nameserver 8.8.8.8" > /etc/resolv.conf'

echo ""
echo "=== NAT rules ==="
iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE
```

## Port Forwarding (Container Port Publishing)

Publishing a container port requires DNAT (Destination NAT) to redirect incoming traffic:

```bash
#!/bin/bash
# port-forward.sh — Expose container port to the host

CONTAINER_NS="ns1"
CONTAINER_IP="172.20.0.10"
CONTAINER_PORT="8080"
HOST_PORT="8080"
HOST_IF=$(ip route | awk '/^default/ {print $5; exit}')
HOST_IP=$(ip addr show "${HOST_IF}" | awk '/inet / {print $2}' | cut -d/ -f1)

echo "Publishing: ${HOST_IP}:${HOST_PORT} -> ${CONTAINER_IP}:${CONTAINER_PORT}"

# DNAT: redirect traffic arriving at host:HOST_PORT to container:CONTAINER_PORT
iptables -t nat -A PREROUTING \
    -i "${HOST_IF}" \
    -p tcp \
    --dport "${HOST_PORT}" \
    -j DNAT \
    --to-destination "${CONTAINER_IP}:${CONTAINER_PORT}"

# Also handle traffic from the host itself (OUTPUT chain)
iptables -t nat -A OUTPUT \
    -p tcp \
    --dport "${HOST_PORT}" \
    -j DNAT \
    --to-destination "${CONTAINER_IP}:${CONTAINER_PORT}"

# Allow the forwarded traffic through the FORWARD chain
iptables -A FORWARD \
    -p tcp \
    -d "${CONTAINER_IP}" \
    --dport "${CONTAINER_PORT}" \
    -j ACCEPT

# Start a simple HTTP server inside ns1
ip netns exec "${CONTAINER_NS}" bash -c \
    'python3 -m http.server 8080 &' &

sleep 1

# Test from the host
echo ""
echo "Testing port forward..."
curl -s "http://${HOST_IP}:${HOST_PORT}/" | head -5
```

## DNS Resolution Inside Network Namespaces

Container DNS resolution requires either:
1. Mounting a `resolv.conf` (Docker's approach)
2. Running a DNS resolver inside the namespace (Kubernetes's CoreDNS approach)

```bash
#!/bin/bash
# namespace-dns.sh — DNS configuration in network namespaces

# Method 1: Direct resolv.conf (Docker-style)
# Each namespace has its own /etc/resolv.conf mount

# Create a bind-mount directory structure for the namespace
mkdir -p /run/netns-etc/ns1
cp /etc/resolv.conf /run/netns-etc/ns1/resolv.conf

# When executing commands in the namespace, we need to bind-mount /etc/resolv.conf
# This is normally handled by the container runtime (runc, containerd)
ip netns exec ns1 bash -c '
# Override resolv.conf for this execution
mount --bind /run/netns-etc/ns1/resolv.conf /etc/resolv.conf
ping -c1 google.com
'

# Method 2: Use systemd-resolved or a local DNS forwarder
# Kubernetes uses CoreDNS running as a pod, accessible via ClusterIP 10.96.0.10
# Each pod's /etc/resolv.conf points to the CoreDNS service:
# nameserver 10.96.0.10
# search default.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5

# Verify DNS in Kubernetes pod (debug approach)
# kubectl exec -it <pod> -- cat /etc/resolv.conf
# kubectl exec -it <pod> -- nslookup kubernetes.default.svc.cluster.local
```

## Understanding Kubernetes Pod Networking

Kubernetes pod networking builds on exactly these primitives. The `kubelet` uses a CNI plugin to:

1. Create a network namespace for the pod (the `pause` container holds the namespace)
2. Create a veth pair
3. Move one veth into the pod namespace (named `eth0`)
4. Connect the host-side veth to the node's CNI bridge or routing infrastructure
5. Configure the pod IP address via IPAM
6. Set up routes and iptables rules for kube-proxy

```bash
#!/bin/bash
# inspect-pod-networking.sh — Examine a running pod's network namespace

POD_NAME="${1:-my-pod}"
NAMESPACE="${2:-default}"

echo "=== Pod ${NAMESPACE}/${POD_NAME} networking ==="

# Get the pod's node
NODE=$(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.nodeName}')
echo "Node: ${NODE}"

# Get the pod's IP
POD_IP=$(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
    -o jsonpath='{.status.podIP}')
echo "Pod IP: ${POD_IP}"

# Find the pause container PID for the pod's network namespace
# This must be run on the node itself
PAUSE_PID=$(crictl inspect \
    $(crictl pods --name "${POD_NAME}" --namespace "${NAMESPACE}" -q) \
    2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('info', {}).get('pid', ''))
" 2>/dev/null)

if [ -n "${PAUSE_PID}" ]; then
    echo ""
    echo "=== Network namespace (from node) ==="
    echo "pause container PID: ${PAUSE_PID}"

    # Inspect network interfaces inside the pod's network namespace
    nsenter --target "${PAUSE_PID}" --net -- ip addr
    echo ""
    nsenter --target "${PAUSE_PID}" --net -- ip route
    echo ""
    nsenter --target "${PAUSE_PID}" --net -- iptables -L -n 2>/dev/null | head -20
fi

# Alternatively, use kubectl debug with a privileged container
echo ""
echo "=== kubectl debug approach (no node access required) ==="
echo "kubectl debug -it ${POD_NAME} -n ${NAMESPACE} \\"
echo "    --image=nicolaka/netshoot:latest \\"
echo "    --target=${POD_NAME} \\"
echo "    -- bash"
```

## CNI Plugin Internals

CNI (Container Network Interface) plugins are executables called by the container runtime with a JSON configuration. Understanding CNI clarifies how Kubernetes networking is set up:

```bash
#!/bin/bash
# simulate-cni.sh — Simulate what a CNI plugin does during pod setup

# CNI plugins receive configuration via stdin and arguments:
# - CNI_COMMAND: ADD, DEL, CHECK, VERSION
# - CNI_CONTAINERID: Unique ID for the container
# - CNI_NETNS: Path to the network namespace file (/proc/<pid>/ns/net or /run/netns/<name>)
# - CNI_IFNAME: Interface name to create inside the container (always "eth0" for pods)
# - CNI_ARGS: Additional key=value pairs
# - CNI_PATH: Colon-separated paths to CNI plugin executables

# Example: manually executing the bridge CNI plugin
CNI_COMMAND=ADD \
CNI_CONTAINERID=container-test-123 \
CNI_NETNS=/run/netns/ns1 \
CNI_IFNAME=eth0 \
CNI_PATH=/opt/cni/bin \
/opt/cni/bin/bridge <<'EOF'
{
  "cniVersion": "1.0.0",
  "name": "mynet",
  "type": "bridge",
  "bridge": "cni0",
  "isGateway": true,
  "ipMasq": true,
  "ipam": {
    "type": "host-local",
    "subnet": "10.85.0.0/16",
    "routes": [
      {"dst": "0.0.0.0/0"}
    ]
  }
}
EOF

# The plugin allocates an IP from the IPAM plugin,
# creates veth pair, configures interface,
# and writes the result to stdout:
# {
#   "cniVersion": "1.0.0",
#   "interfaces": [{"name": "eth0", "sandbox": "/run/netns/ns1"}],
#   "ips": [{"address": "10.85.0.3/16", "gateway": "10.85.0.1", "interface": 0}],
#   "routes": [{"dst": "0.0.0.0/0", "gw": "10.85.0.1"}]
# }
```

## Packet Tracing and Debugging

```bash
#!/bin/bash
# trace-packet.sh — Follow a packet from container to external host

CONTAINER_NS="ns1"
CONTAINER_IP="172.20.0.10"
TARGET_IP="8.8.8.8"

echo "=== Tracing packet from ${CONTAINER_IP} to ${TARGET_IP} ==="

# Step 1: Packet originates in ns1, routed to default gateway 172.20.0.1
echo ""
echo "1. Route in namespace ${CONTAINER_NS}:"
ip netns exec "${CONTAINER_NS}" ip route get "${TARGET_IP}"

# Step 2: Packet arrives at bridge br-containers in host namespace
echo ""
echo "2. ARP table in namespace ${CONTAINER_NS}:"
ip netns exec "${CONTAINER_NS}" arp -n

# Step 3: iptables PREROUTING/FORWARD in host namespace
echo ""
echo "3. iptables FORWARD chain (relevant rules):"
iptables -L FORWARD -n -v | grep -E "ACCEPT|DROP|br-containers"

# Step 4: MASQUERADE in POSTROUTING
echo ""
echo "4. iptables NAT POSTROUTING:"
iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE

# Step 5: Real-time packet capture
echo ""
echo "5. Capturing ICMP on bridge and host interface..."
tcpdump -i br-containers -n icmp -c 5 &
TCPDUMP_BRIDGE_PID=$!

HOST_IF=$(ip route | awk '/^default/ {print $5; exit}')
tcpdump -i "${HOST_IF}" -n icmp -c 5 &
TCPDUMP_HOST_PID=$!

# Generate traffic
sleep 0.5
ip netns exec "${CONTAINER_NS}" ping -c3 "${TARGET_IP}" &>/dev/null

wait "${TCPDUMP_BRIDGE_PID}" 2>/dev/null
wait "${TCPDUMP_HOST_PID}" 2>/dev/null

echo ""
echo "On br-containers: source IP = ${CONTAINER_IP} (original)"
echo "On ${HOST_IF}: source IP = host external IP (after MASQUERADE)"
```

## Cleanup and Teardown

```bash
#!/bin/bash
# cleanup.sh — Remove all namespace networking created in this guide

# Remove iptables rules
HOST_IF=$(ip route | awk '/^default/ {print $5; exit}')

iptables -t nat -D POSTROUTING \
    -s 172.20.0.0/24 \
    ! -d 172.20.0.0/24 \
    -j MASQUERADE 2>/dev/null

iptables -D FORWARD -i br-containers -j ACCEPT 2>/dev/null
iptables -D FORWARD -o br-containers -j ACCEPT 2>/dev/null

iptables -t nat -D PREROUTING \
    -i "${HOST_IF}" \
    -p tcp \
    --dport 8080 \
    -j DNAT \
    --to-destination 172.20.0.10:8080 2>/dev/null

# Remove namespaces (also removes their veth ends)
for ns in ns1 ns2 ns3 container-a container-b; do
    ip netns del "${ns}" 2>/dev/null && echo "Deleted namespace: ${ns}"
done

# Remove bridge
ip link del br-containers 2>/dev/null && echo "Deleted bridge: br-containers"

# Remove any remaining veth pairs
for veth in veth-ns1 veth-ns2 veth-ns3 veth0 veth1; do
    ip link del "${veth}" 2>/dev/null
done

echo "Cleanup complete"
ip netns list
```

## Summary

Linux network namespaces are the building block upon which every container networking solution is built. The concepts explored in this post directly map to production Kubernetes networking:

- **veth pairs** = the connection between a pod's `eth0` and the node's CNI bridge
- **Linux bridge** = `docker0`, `cni0`, or the Flannel/Calico bridge on each node
- **iptables MASQUERADE** = kube-proxy's outbound SNAT for pod-to-external traffic
- **iptables DNAT** = kube-proxy's service IP translation (ClusterIP → pod IP)
- **Network namespace** = each pod's isolated network stack

Understanding this stack enables:
- Root-cause analysis of pod networking failures using `ip netns exec` and `nsenter`
- Writing custom CNI plugins for specialized networking requirements
- Debugging packet loss with `tcpdump` on the bridge and host interfaces simultaneously
- Understanding why certain iptables rules on a Kubernetes node affect pod connectivity

The operational debugging toolkit—`ip netns exec`, `nsenter --target <pid> --net`, `tcpdump -i <bridge>`, and `iptables -L -n -v -t nat`—applies directly to live Kubernetes nodes where replacing the formal namespace paths with `/proc/<pause-pid>/ns/net` gives access to any pod's network stack.
