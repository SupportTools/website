---
title: "Linux Network Namespaces: Understanding Container Networking from First Principles"
date: 2028-10-19T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Containers", "Kubernetes", "eBPF"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Build container networking from scratch using Linux network namespaces, veth pairs, bridge networking, NAT with iptables, and understand how CNI plugins implement pod networking in Kubernetes."
more_link: "yes"
url: "/linux-network-namespaces-container-networking-guide/"
---

Every Kubernetes pod has its own network stack — its own IP address, routing table, and iptables rules — despite sharing the same Linux kernel as the host. This isolation comes from Linux network namespaces, the fundamental primitive that container runtimes and CNI plugins build on. Understanding how network namespaces work at the command line makes debugging container networking problems far easier: you are no longer reasoning about abstract layers but about concrete kernel objects you can inspect and manipulate directly.

This guide builds a minimal container network from scratch — namespace creation, veth pairs, bridge networking, NAT, and inter-namespace routing — then connects it to how Docker, containerd, and CNI plugins implement these same concepts.

<!--more-->

# Linux Network Namespaces: Understanding Container Networking from First Principles

## What Is a Network Namespace

A network namespace is a complete copy of the Linux networking stack, isolated from the default (host) namespace and from other namespaces. Each namespace has:

- Its own set of network interfaces
- Its own routing table
- Its own iptables chains and rules
- Its own netfilter conntrack table
- Its own sockets and port numbers (port 80 can be bound in every namespace simultaneously)

Processes inside a namespace see only the interfaces and routes in that namespace. The host namespace sees all physical interfaces but not the virtual interfaces inside isolated namespaces unless they are explicitly connected.

## Creating and Inspecting Network Namespaces

```bash
# Create a network namespace (requires root or CAP_NET_ADMIN)
ip netns add blue
ip netns add red

# List existing namespaces
ip netns list
# blue
# red

# Namespaces are stored as files in /var/run/netns/
ls -la /var/run/netns/
# lrwxrwxrwx 1 root root /var/run/netns/blue -> /proc/self/ns/net (for display)
# The actual files bind-mount a namespace fd

# Execute a command inside the namespace
ip netns exec blue ip addr
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN
#     link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00

# Bring up loopback
ip netns exec blue ip link set lo up
ip netns exec blue ip addr
# 1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN
#     link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
#     inet 127.0.0.1/8 scope host lo

# Show routing table inside namespace
ip netns exec blue ip route
# (empty — no routes yet)
```

## Connecting Namespaces with veth Pairs

A veth (virtual Ethernet) pair is a bidirectional pipe between two network endpoints. Packets sent to one end emerge at the other. CNI plugins use veth pairs to connect pod namespaces to the host networking stack.

```bash
# Create a veth pair
# veth-blue is the host end; veth-blue-peer goes into the blue namespace
ip link add veth-blue type veth peer name veth-blue-peer

# Move one end into the blue namespace
ip link set veth-blue-peer netns blue

# Verify: host now sees veth-blue but not veth-blue-peer
ip link show veth-blue
# 5: veth-blue@if4: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN

# Verify: blue namespace sees veth-blue-peer
ip netns exec blue ip link show
# 1: lo: <LOOPBACK,UP,LOWER_UP>
# 4: veth-blue-peer@if5: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN

# Assign IPs
ip addr add 192.168.1.1/24 dev veth-blue
ip netns exec blue ip addr add 192.168.1.2/24 dev veth-blue-peer

# Bring both ends up
ip link set veth-blue up
ip netns exec blue ip link set veth-blue-peer up

# Add default route inside the namespace
ip netns exec blue ip route add default via 192.168.1.1

# Test connectivity
ip netns exec blue ping -c 3 192.168.1.1
# PING 192.168.1.1 (192.168.1.1) 56(84) bytes of data.
# 64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=0.064 ms

# Test from host to namespace
ping -c 3 192.168.1.2
# 64 bytes from 192.168.1.2: icmp_seq=1 ttl=64 time=0.078 ms
```

## Bridge Networking: Multiple Namespaces on One Subnet

When multiple containers need to communicate with each other (the standard Docker bridge network scenario), you connect all their veth pairs to a Linux bridge. The bridge acts like a virtual switch.

```bash
# Create a bridge device
ip link add br0 type bridge
ip addr add 10.0.0.1/24 dev br0
ip link set br0 up

# Set up the red namespace similarly
ip link add veth-red type veth peer name veth-red-peer
ip link set veth-red-peer netns red

# Connect both veth host-ends to the bridge
ip link set veth-blue master br0
ip link set veth-red master br0

# Bring host ends up (they don't need IPs — bridge handles forwarding)
ip link set veth-blue up
ip link set veth-red up

# Assign IPs inside the namespaces
ip netns exec blue ip addr add 10.0.0.2/24 dev veth-blue-peer
ip netns exec red  ip addr add 10.0.0.3/24 dev veth-red-peer

ip netns exec blue ip link set veth-blue-peer up
ip netns exec red  ip link set veth-red-peer up

# Add routes pointing to the bridge gateway
ip netns exec blue ip route add default via 10.0.0.1
ip netns exec red  ip route add default via 10.0.0.1

# Blue can now reach red directly through the bridge
ip netns exec blue ping -c 3 10.0.0.3
# 64 bytes from 10.0.0.3: icmp_seq=1 ttl=64 time=0.109 ms

# Red can reach blue
ip netns exec red ping -c 3 10.0.0.2
# 64 bytes from 10.0.0.2: icmp_seq=1 ttl=64 time=0.098 ms
```

## NAT: Giving Containers Internet Access

Containers (and pods) can reach the internet through NAT (Network Address Translation). The host's physical interface has an internet-routable IP; the bridge has a private IP. iptables masquerading makes outbound traffic from containers appear to come from the host's IP.

```bash
# Enable IP forwarding (kernel does not route between interfaces by default)
echo 1 > /proc/sys/net/ipv4/ip_forward
# Persist across reboots:
# echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf

# Add masquerade NAT for traffic leaving through the host's primary interface
# Replace eth0 with your host's internet-facing interface
iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o eth0 -j MASQUERADE

# Allow forwarding between bridge and eth0
iptables -A FORWARD -i br0 -o eth0 -j ACCEPT
iptables -A FORWARD -i eth0 -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT

# Test internet access from the blue namespace
ip netns exec blue ping -c 3 8.8.8.8
# 64 bytes from 8.8.8.8: icmp_seq=1 ttl=55 time=12.3 ms
```

## Port Forwarding: Host Port to Container

To expose a service running in a namespace on a host port:

```bash
# Assume a service is running on port 8080 inside the blue namespace (10.0.0.2)
# Expose it on host port 80

iptables -t nat -A PREROUTING \
  -p tcp --dport 80 \
  -j DNAT --to-destination 10.0.0.2:8080

iptables -A FORWARD \
  -p tcp -d 10.0.0.2 --dport 8080 \
  -m state --state NEW,ESTABLISHED,RELATED \
  -j ACCEPT

# Test from another host
# curl http://<host-ip>:80
```

This is exactly what Docker does for `-p 80:8080` — it creates these iptables DNAT rules automatically.

## Inspecting Container Namespaces with nsenter

When debugging a running container, `nsenter` lets you run commands inside the container's namespace:

```bash
# Find the PID of a container process
CONTAINER_ID="abc123def456"
PID=$(docker inspect --format '{{.State.Pid}}' $CONTAINER_ID)
# or for a Kubernetes pod:
# kubectl exec -n mynamespace mypod -- cat /proc/self/status | grep NSpid

# Enter the container's network namespace
nsenter -t $PID -n -- ip addr
nsenter -t $PID -n -- ip route
nsenter -t $PID -n -- ss -tulnp

# View iptables rules from inside the container's namespace
nsenter -t $PID -n -- iptables -L -n -v

# Capture packets from inside the container's namespace
nsenter -t $PID -n -- tcpdump -i eth0 -w /tmp/capture.pcap &

# Enter multiple namespaces simultaneously (full container context)
nsenter -t $PID --net --pid --uts -- /bin/sh
```

## How Kubernetes CNI Plugins Use Namespaces

When kubelet creates a pod, the container runtime (containerd/CRI-O) does the following:

```
1. Create a new network namespace: /var/run/netns/cni-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
2. Call the configured CNI plugin binary with:
   - CNI_COMMAND=ADD
   - CNI_NETNS=/var/run/netns/cni-xxxxxxxx...
   - CNI_IFNAME=eth0 (the interface to create inside the pod)
3. CNI plugin (e.g., Flannel, Calico, Cilium) does the namespace plumbing
4. Returns the IP address allocated to the pod
5. Kubelet stores this IP in the Pod status
```

You can observe this process:

```bash
# List all active pod network namespaces
ls /var/run/netns/ | grep cni

# Find which pod owns a namespace
# The namespace name appears in the container's proc entry
ls -la /proc/*/ns/net | grep -v "^l" | \
  while read perm links owner group size date time path; do
    pid=$(echo $path | cut -d/ -f3)
    comm=$(cat /proc/$pid/comm 2>/dev/null)
    nsinum=$(stat -c %i /proc/$pid/ns/net 2>/dev/null)
    echo "$nsinum $pid $comm"
  done | sort -u

# Inspect what Calico/Flannel set up inside a pod namespace
CNS_FILE=$(ls /var/run/netns/ | grep cni | head -1)
ip netns exec $CNS_FILE ip addr
ip netns exec $CNS_FILE ip route
ip netns exec $CNS_FILE iptables -L -n
```

## CNI Plugin Mechanics: The callout Flow

Write a minimal CNI plugin to understand the protocol:

```bash
#!/bin/bash
# /opt/cni/bin/minimal-cni (executable)

# CNI passes configuration on stdin and environment variables:
# CNI_COMMAND: ADD | DEL | CHECK | VERSION
# CNI_CONTAINERID: container ID
# CNI_NETNS: network namespace path (/var/run/netns/...)
# CNI_IFNAME: interface name to create in the pod (usually eth0)
# CNI_ARGS: extra K=V; pairs
# Configuration JSON is on stdin

case $CNI_COMMAND in
ADD)
  # Read configuration from stdin
  CONFIG=$(cat)
  SUBNET=$(echo $CONFIG | jq -r '.subnet // "10.0.0.0/24"')
  GATEWAY=$(echo $CONFIG | jq -r '.gateway // "10.0.0.1"')

  # Allocate an IP (simplified — real plugins use IPAM)
  POD_IP="10.0.0.$(shuf -i 10-250 -n 1)/24"

  # Create veth pair
  VETH_HOST="veth$CNI_CONTAINERID"
  ip link add $VETH_HOST type veth peer name $CNI_IFNAME

  # Move peer into the pod namespace
  ip link set $CNI_IFNAME netns $CNI_NETNS

  # Configure the pod interface
  ip netns exec $CNI_NETNS ip addr add $POD_IP dev $CNI_IFNAME
  ip netns exec $CNI_NETNS ip link set $CNI_IFNAME up
  ip netns exec $CNI_NETNS ip route add default via $GATEWAY

  # Attach host end to bridge
  ip link set $VETH_HOST master cni0
  ip link set $VETH_HOST up

  # Return CNI result JSON
  cat <<EOF
{
  "cniVersion": "1.0.0",
  "interfaces": [
    {"name": "$VETH_HOST", "mac": "$(cat /sys/class/net/$VETH_HOST/address)"},
    {"name": "$CNI_IFNAME", "mac": "$(ip netns exec $CNI_NETNS cat /sys/class/net/$CNI_IFNAME/address)", "sandbox": "$CNI_NETNS"}
  ],
  "ips": [
    {"interface": 1, "address": "$POD_IP", "gateway": "$GATEWAY"}
  ]
}
EOF
  ;;

DEL)
  VETH_HOST="veth$CNI_CONTAINERID"
  ip link del $VETH_HOST 2>/dev/null || true
  echo "{}"
  ;;

VERSION)
  echo '{"cniVersion":"1.0.0","supportedVersions":["1.0.0"]}'
  ;;
esac
```

## Tracing Packet Flow Through the Linux Network Stack

Understanding the path a packet takes from a pod to the internet:

```
Pod (10.0.0.2)
   │ eth0 (inside pod namespace)
   │
   ▼
veth pair (kernel passes packet between namespace boundary)
   │
   ▼
veth-host-end (in root namespace)
   │
   ▼
Bridge (cni0 / cbr0 / flannel.1 depending on CNI)
   │
   ▼
iptables: PREROUTING → FORWARD → POSTROUTING
   │                               │
   │              MASQUERADE: src 10.0.0.2 → host IP
   ▼
eth0 (physical NIC)
   │
   ▼
Leaves host
```

Trace the actual path with tcpdump and iptables logging:

```bash
# Log all forwarded packets (diagnostic only — high volume)
iptables -A FORWARD -j LOG --log-prefix "FWD: " --log-level 4

# Capture on each hop
tcpdump -i br0 host 10.0.0.2 -w /tmp/br0.pcap &
tcpdump -i eth0 host 10.0.0.2 -w /tmp/eth0.pcap &

# Run test traffic
ip netns exec blue curl -s https://example.com

# Analyze with tshark
tshark -r /tmp/br0.pcap -T fields -e frame.time -e ip.src -e ip.dst -e tcp.flags
```

## Packet Capture for Kubernetes Pod Debugging

```bash
# Capture traffic in a running pod without modifying it
POD=payment-processor-6d8f9b-xxxxx
NAMESPACE=payments

# Get the node the pod runs on
NODE=$(kubectl get pod $POD -n $NAMESPACE -o jsonpath='{.spec.nodeName}')

# Debug the node
kubectl debug node/$NODE -it --image=nicolaka/netshoot

# Inside the debug container, find the pod's namespace
# Pods are identified by their netns symlinks under /proc
for pid in /proc/*/ns/net; do
  nsino=$(stat -c %i $pid 2>/dev/null) || continue
  podnsino=$(ip netns identify $nsino 2>/dev/null) || continue
  echo "$pid: $podnsino"
done

# Or use nsenter directly to capture
POD_PID=$(kubectl exec $POD -n $NAMESPACE -- cat /proc/1/status | grep NSpid | awk '{print $2}')
# Note: this requires the pod to have access to /proc

# Use crictl on the node to find the sandbox PID
NODE_EXEC="kubectl debug node/$NODE -it --image=busybox -- chroot /host"
SANDBOX_PID=$($NODE_EXEC sh -c "crictl inspect \$(crictl pods --name $POD -q) | jq -r '.info.pid'")
nsenter -t $SANDBOX_PID -n -- tcpdump -i eth0 -nn -w /tmp/pod-capture.pcap

# Copy capture off the node
kubectl cp node-debugger-xxxxx:/tmp/pod-capture.pcap ./pod-capture.pcap
```

## Cleaning Up

```bash
# Remove all resources created in this guide
ip netns del blue
ip netns del red
ip link del br0  # Deletes veth pairs attached to it
iptables -t nat -D POSTROUTING -s 10.0.0.0/24 -o eth0 -j MASQUERADE
iptables -D FORWARD -i br0 -o eth0 -j ACCEPT
iptables -D FORWARD -i eth0 -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT
```

## Why This Matters for Kubernetes Debugging

When a Kubernetes pod cannot reach another pod or a service:

1. **Check if the pod namespace is properly configured**: `nsenter -t $PID -n -- ip addr` and `ip route`
2. **Check if the veth pair exists on the node**: `ip link show | grep veth`
3. **Check if the veth is attached to the bridge**: `bridge link show`
4. **Check iptables rules**: `iptables -L FORWARD -n -v` — a missing ACCEPT rule blocks traffic
5. **Check conntrack**: `conntrack -L` — exhausted conntrack table causes new connections to fail
6. **Check eBPF programs** (Cilium/Calico eBPF): `bpftool prog list` and `bpftool map dump`

The network namespace model has not changed since it was introduced in Linux 3.8. Every container runtime, every CNI plugin, and every service mesh proxy builds on these same four primitives: namespaces, veth pairs, bridges, and iptables. Once you understand them at the command line, the abstractions above them become transparent.
