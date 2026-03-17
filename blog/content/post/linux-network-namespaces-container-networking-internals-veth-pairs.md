---
title: "Linux Network Namespaces: Container Networking Internals and veth Pair Management"
date: 2030-12-09T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Containers", "Kubernetes", "CNI", "Network Namespaces", "veth", "iptables"]
categories:
- Linux
- Networking
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux network namespace creation and lifecycle, veth pair topology, bridge and macvlan modes, iptables interaction, per-namespace routing tables, and how Kubernetes CNI plugins use network namespaces to implement pod networking."
more_link: "yes"
url: "/linux-network-namespaces-container-networking-internals-veth-pairs/"
---

Every Kubernetes pod has its own isolated network stack — its own IP address, routing table, and iptables rules — despite running on a shared host kernel. This isolation is provided by Linux network namespaces, the kernel mechanism that partitions the network stack. Understanding how network namespaces work, how veth pairs connect them, and how the container runtime and CNI plugins assemble these primitives into a functioning pod network is essential knowledge for debugging container networking issues, writing CNI plugins, and understanding why Kubernetes networking behaves the way it does.

This guide covers network namespace creation and lifecycle management, veth pair topology and bridge networking, macvlan for direct host network attachment, iptables interaction with namespaces, per-namespace routing tables, and the complete CNI plugin workflow showing how tools like Flannel, Calico, and Cilium implement pod networking using these primitives.

<!--more-->

# Linux Network Namespaces: Container Networking Internals and veth Pair Management

## Network Namespace Fundamentals

A network namespace is a complete, isolated copy of the kernel's network stack. Each namespace has:
- Its own set of network interfaces (initially only `lo`)
- Its own routing table
- Its own iptables/nftables rules
- Its own socket table (connections belong to specific namespaces)
- Its own ARP table and neighbor cache

The default namespace is `init_net` — the network namespace that exists when the system boots. All processes initially share this namespace.

### Creating Network Namespaces

```bash
# Create a named network namespace
ip netns add production-ns

# List network namespaces
ip netns list

# Show all processes in the namespace
ip netns pids production-ns

# Execute a command inside the namespace
ip netns exec production-ns ip addr show

# The loopback is down by default in new namespaces
ip netns exec production-ns ip link set lo up
ip netns exec production-ns ip addr show lo
# 1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN
#     link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
#     inet 127.0.0.1/8 scope host lo
```

Named namespaces (created with `ip netns add`) are bind-mounted to `/var/run/netns/<name>`. This keeps the namespace alive even when no processes are using it, which is important for containers that may not have any processes running during a brief startup window.

### Namespace Lifecycle and the File Descriptor

A namespace exists as long as either:
1. At least one process is using it, OR
2. A bind mount to `/var/run/netns/<name>` exists

```bash
# A namespace created by a process exists only as long as that process lives:
# (This namespace exists only for the duration of the sleep command)
unshare --net -- sleep 10 &
PID=$!

# The namespace is visible via the process's /proc entry
ls -la /proc/$PID/ns/net

# To make it persistent (keep it after the process exits):
# Touch a file and bind-mount the namespace to it
touch /var/run/netns/my-ns
nsenter -t $PID --net -- mount --bind /proc/$PID/ns/net /var/run/netns/my-ns

# Now the namespace persists after $PID exits
kill $PID
ip netns list  # my-ns is still listed

# Clean up
ip netns delete my-ns
```

### How the Container Runtime Creates Namespaces

When containerd creates a container, it:
1. Creates a new network namespace bind-mounted to a path like `/var/run/netns/cni-XXXXXX`
2. Passes this namespace path to the CNI plugin
3. The CNI plugin configures the namespace (adds interfaces, sets addresses, configures routes)
4. The container process is started in the namespace using `clone(CLONE_NEWNET)` or `setns()`

```bash
# See how containerd namespaces look on a running Kubernetes node
ls /var/run/netns/
# cni-a1b2c3d4-e5f6-7890-abcd-ef1234567890
# cni-deadbeef-cafe-feed-face-123456789012

# View the namespace corresponding to a pod
# Find the PID of a container in a pod
crictl inspect $(crictl ps | grep my-pod | awk '{print $1}') | \
  jq '.info.pid'

# Navigate to the network namespace via /proc
ls -la /proc/<pid>/ns/net
```

## veth Pairs: Virtual Ethernet Cables

A veth (virtual Ethernet) pair is a pair of linked virtual network interfaces. Anything sent into one end emerges from the other. When the two ends are in different network namespaces, the pair acts as a virtual cable connecting the namespaces.

### Creating veth Pairs

```bash
# Create a veth pair (both ends in the current namespace)
ip link add veth0 type veth peer name veth1

# Move one end into a network namespace
ip link set veth1 netns production-ns

# Configure the host-side interface
ip addr add 10.0.0.1/24 dev veth0
ip link set veth0 up

# Configure the namespace-side interface
ip netns exec production-ns ip addr add 10.0.0.2/24 dev veth1
ip netns exec production-ns ip link set veth1 up
ip netns exec production-ns ip link set lo up

# Test connectivity
ping -c 3 10.0.0.2

# Test connectivity from within the namespace
ip netns exec production-ns ping -c 3 10.0.0.1
```

### Understanding veth Packet Flow

When a packet is sent from inside the namespace:
1. Process writes to socket in the namespace
2. Kernel routes the packet to the namespace's default route or specific route
3. Packet exits through `veth1` (the namespace side)
4. Packet immediately appears on `veth0` (the host side) — this is the "cable" behavior
5. The host-side kernel's network stack processes the packet from `veth0`

```bash
# Observe veth packet flow with tcpdump
# In terminal 1: capture on the host side
tcpdump -i veth0 -nn

# In terminal 2: capture on the namespace side
ip netns exec production-ns tcpdump -i veth1 -nn

# In terminal 3: generate traffic
ip netns exec production-ns ping -c 5 8.8.8.8
```

## Bridge Networking: Connecting Multiple Namespaces

A bridge is a software L2 switch. By connecting multiple veth pairs to a bridge, you create a virtual network where all connected namespaces can communicate directly.

### Creating a Bridge Network

```bash
# Create namespaces for two "containers"
ip netns add ns1
ip netns add ns2

# Create the bridge
ip link add br0 type bridge
ip link set br0 up

# Assign an IP to the bridge (this is the gateway for the namespaces)
ip addr add 10.100.0.1/24 dev br0

# Create veth pairs for each namespace
ip link add veth-ns1 type veth peer name veth-ns1-br
ip link add veth-ns2 type veth peer name veth-ns2-br

# Connect the bridge-side veth to the bridge
ip link set veth-ns1-br master br0
ip link set veth-ns2-br master br0
ip link set veth-ns1-br up
ip link set veth-ns2-br up

# Move namespace-side veth into their namespaces
ip link set veth-ns1 netns ns1
ip link set veth-ns2 netns ns2

# Configure namespace 1
ip netns exec ns1 ip addr add 10.100.0.10/24 dev veth-ns1
ip netns exec ns1 ip link set veth-ns1 up
ip netns exec ns1 ip link set lo up
ip netns exec ns1 ip route add default via 10.100.0.1

# Configure namespace 2
ip netns exec ns2 ip addr add 10.100.0.20/24 dev veth-ns2
ip netns exec ns2 ip link set veth-ns2 up
ip netns exec ns2 ip link set lo up
ip netns exec ns2 ip route add default via 10.100.0.1

# ns1 and ns2 can now communicate through the bridge
ip netns exec ns1 ping -c 3 10.100.0.20  # Should succeed
```

### Bridge with Internet Access via NAT

To allow namespace traffic to reach the internet, add NAT via iptables:

```bash
# Enable IP forwarding on the host
sysctl -w net.ipv4.ip_forward=1

# NAT traffic from the 10.100.0.0/24 network when exiting the host interface
iptables -t nat -A POSTROUTING -s 10.100.0.0/24 ! -o br0 -j MASQUERADE

# Allow forwarding between bridge and host interface
iptables -A FORWARD -i br0 -j ACCEPT
iptables -A FORWARD -o br0 -j ACCEPT

# Test internet access from a namespace
ip netns exec ns1 curl -s https://httpbin.org/ip
```

This is exactly how Docker's `bridge` network mode and Kubernetes' default pod networking work.

## macvlan: Direct Physical Interface Attachment

`macvlan` allows a namespace to have a virtual interface that appears as a separate physical NIC on the host's physical network. This is more efficient than bridge+veth (no extra switch processing) but means pod traffic appears directly on the host's L2 domain.

```bash
# Create a macvlan interface in a namespace
# eth0 is the host's physical interface
ip link add macvlan1 link eth0 type macvlan mode bridge
ip link set macvlan1 netns production-ns

# Configure the macvlan interface
ip netns exec production-ns ip addr add 192.168.1.100/24 dev macvlan1
ip netns exec production-ns ip link set macvlan1 up
ip netns exec production-ns ip route add default via 192.168.1.1

# The namespace can now communicate directly on the physical network
# Other hosts on 192.168.1.0/24 can reach 192.168.1.100
```

Macvlan modes:
- **bridge**: Instances can communicate with each other and the external network (most common)
- **private**: Instances cannot communicate with each other (only external network)
- **vepa**: Traffic between instances goes through the external switch (802.1Qbg)
- **passthru**: Only one interface per physical interface, gets full control

## iptables and Network Namespaces

iptables rules are namespace-local — each namespace has its own independent iptables rule set. This is fundamental to container security: pod-level firewall rules in one namespace cannot affect another namespace.

```bash
# View iptables rules in a namespace
ip netns exec production-ns iptables -L -n -v

# Add a rule in a specific namespace
ip netns exec production-ns iptables -A INPUT -p tcp --dport 8080 -j DROP

# The host's iptables rules are NOT visible inside the namespace
# and vice versa
iptables -L -n -v   # Host rules
ip netns exec production-ns iptables -L -n -v  # Namespace rules (different)
```

### Kubernetes Node iptables Rules

On a Kubernetes worker node, the host namespace contains:

```bash
# View kube-proxy's iptables rules (runs in the host namespace)
iptables -t nat -L KUBE-SERVICES -n --line-numbers | head -30

# Sample output:
# Chain KUBE-SERVICES (2 references)
# 1  KUBE-SVC-XXXX  tcp -- 0.0.0.0/0  10.96.0.1  tcp dpt:443  /* default/kubernetes:https */
# 2  KUBE-SVC-YYYY  tcp -- 0.0.0.0/0  10.100.0.10  tcp dpt:80  /* production/my-service */

# View how ClusterIP traffic is handled
iptables -t nat -L KUBE-SVC-YYYY -n --line-numbers

# View how pod traffic is masqueraded when leaving the node
iptables -t nat -L KUBE-POSTROUTING -n -v
```

### Connection Tracking Across Namespaces

Connection tracking (`conntrack`) is maintained per-namespace. When a pod communicates with a Service ClusterIP, the NAT (DNAT to a pod IP) happens in the host namespace, and conntrack tracks the translation:

```bash
# View conntrack entries for pod traffic
conntrack -L | grep "src=10.100.0.10"

# Count connections by protocol
conntrack -L | awk '{print $1}' | sort | uniq -c

# Monitor new connections in real time
conntrack -E
```

## Per-Namespace Routing Tables

Each network namespace has its own routing table, which is essential for implementing complex topologies:

```bash
# View routing table inside a namespace
ip netns exec production-ns ip route show

# View the routing table used for specific traffic
ip netns exec production-ns ip route get 8.8.8.8

# Add policy routing inside a namespace
# (Multiple routing tables per namespace)
ip netns exec production-ns ip rule add from 10.100.0.10 table 100
ip netns exec production-ns ip route add default via 192.168.1.1 table 100
ip netns exec production-ns ip route add 10.0.0.0/8 via 10.100.0.1 table 100
```

### Multi-Homed Pods with Policy Routing

Pods with multiple network interfaces (using Multus CNI) require policy routing to direct traffic correctly:

```bash
# Pod with two interfaces: eth0 (primary) and net1 (secondary)
# Primary network: 10.244.0.0/16 (cluster network)
# Secondary network: 192.168.100.0/24 (storage network)

# In the pod's network namespace:
ip route show
# default via 10.244.0.1 dev eth0
# 10.244.0.0/16 via 10.244.0.1 dev eth0
# 192.168.100.0/24 dev net1 scope link

# Policy routing for storage traffic
ip rule add from 192.168.100.0/24 table 200
ip route add default via 192.168.100.1 table 200
ip route add 192.168.100.0/24 dev net1 table 200
```

## How CNI Plugins Use Network Namespaces

The Container Network Interface (CNI) specification defines how the container runtime requests network configuration for a new container. The runtime calls CNI plugins at two points:

1. **ADD**: Called when a pod is starting. The plugin configures the network namespace.
2. **DEL**: Called when a pod is terminating. The plugin cleans up the network namespace.

### Manually Running the CNI ADD Operation

Understanding what a CNI plugin does helps debug network issues:

```bash
# Simulate what the container runtime does when calling a CNI plugin

# 1. Create the network namespace
CNS_PATH=/var/run/netns/test-cni-$(uuidgen)
ip netns add test-cni-ns

# 2. Set environment variables for the CNI plugin
export CNI_COMMAND=ADD
export CNI_CONTAINERID=test-container-id
export CNI_NETNS=/var/run/netns/test-cni-ns
export CNI_IFNAME=eth0
export CNI_PATH=/opt/cni/bin

# 3. Provide the CNI configuration via stdin
# This is a simple bridge CNI configuration
cat <<EOF | /opt/cni/bin/bridge
{
    "cniVersion": "0.4.0",
    "name": "test-network",
    "type": "bridge",
    "bridge": "cni0",
    "isGateway": true,
    "ipMasq": true,
    "ipam": {
        "type": "host-local",
        "subnet": "10.22.0.0/16",
        "routes": [
            { "dst": "0.0.0.0/0" }
        ]
    }
}
EOF

# 4. Verify the result
ip netns exec test-cni-ns ip addr show
ip netns exec test-cni-ns ip route show

# 5. Clean up with CNI DEL
export CNI_COMMAND=DEL
cat <<EOF | /opt/cni/bin/bridge
{
    "cniVersion": "0.4.0",
    "name": "test-network",
    "type": "bridge",
    "bridge": "cni0"
}
EOF

ip netns delete test-cni-ns
```

### Flannel CNI: How It Uses Network Namespaces

Flannel implements pod networking by:
1. Creating a VXLAN device (`flannel.1`) in the host namespace
2. For each pod, using the `bridge` CNI plugin to create a veth pair and connect it to `cni0`
3. Programming routes so pod-to-pod traffic is forwarded to `flannel.1` for encapsulation

```bash
# Observe the Flannel network topology on a node

# The VXLAN device
ip link show flannel.1

# The bridge connecting all pod veth interfaces
ip link show cni0
bridge link show

# Routes: pod subnets on other nodes go through flannel.1
ip route show
# 10.244.0.0/24 dev cni0 proto kernel scope link
# 10.244.1.0/24 via 10.244.1.0 dev flannel.1 onlink   <-- other node's pods

# ARP entries showing how flannel.1 maps pod MACs to node IPs
bridge fdb show dev flannel.1
# de:ad:be:ef:ca:fe dev flannel.1 dst 192.168.1.101 self permanent
# This entry means: to reach MAC de:ad:be:ef:ca:fe, send VXLAN to 192.168.1.101
```

### Calico CNI: Routing Without NAT

Calico implements pod networking using pure L3 routing — no bridges, no VXLAN (in BGP mode). Each pod gets a /32 route on the node, and BGP distributes these routes to all other nodes.

```bash
# Calico's approach: no bridge, direct veth to host routing table
# Each pod's veth host-end goes directly into the host routing table

# View Calico-managed routes on a node
ip route show | grep cali

# Sample output:
# 10.244.0.5 dev cali1a2b3c4d scope link
# 10.244.0.6 dev cali5e6f7890 scope link
# Each line is one pod with its own route entry

# Inside a pod, the default route points to a link-local address
# Calico uses proxy ARP to make this work
ip netns exec <pod-netns> ip route show
# default via 169.254.1.1 dev eth0
# 169.254.1.1 dev eth0 scope link

# The 169.254.1.1 address is answered by Calico via proxy ARP on veth0
ip netns exec <pod-netns> arp -n
# ? (169.254.1.1) at ee:ee:ee:ee:ee:ee [ether] on eth0
```

### Cilium CNI: eBPF-Based Networking

Cilium replaces iptables and routing tables with eBPF programs attached to veth interfaces:

```bash
# Cilium uses eBPF programs attached to each pod's veth interface
# View attached eBPF programs
bpftool prog list | grep -i cilium | head -10

# View the eBPF map that implements the connection tracking
bpftool map list | grep -i ct | head -5

# Cilium CLI tools
cilium status
cilium endpoint list
cilium policy get

# Trace packet flow for a pod (Cilium's built-in tracing)
cilium monitor --type drop  # Monitor dropped packets
cilium monitor --type trace # Monitor all packet traces
```

## Debugging Network Namespace Issues

### Container Cannot Reach Service

```bash
# Find the pod's network namespace
POD_NAME=my-problematic-pod
NAMESPACE=production

# Get the container PID
CONTAINER_ID=$(crictl pods --name $POD_NAME --namespace $NAMESPACE -q)
POD_SANDBOX_PID=$(crictl inspectp $CONTAINER_ID | jq -r '.info.pid')

# Enter the pod's network namespace
nsenter -t $POD_SANDBOX_PID -n -- bash

# Inside the pod's network namespace:
ip addr show
ip route show
cat /etc/resolv.conf
curl -v http://my-service.production.svc.cluster.local/health
```

### Namespace Connectivity Matrix

```bash
#!/bin/bash
# network-connectivity-test.sh
# Test connectivity between all pods in a namespace

NAMESPACE=${1:-production}

echo "Testing inter-pod connectivity in namespace: $NAMESPACE"
pods=$(kubectl get pods -n $NAMESPACE -o jsonpath='{.items[*].metadata.name}')

for source_pod in $pods; do
    source_ip=$(kubectl get pod -n $NAMESPACE $source_pod \
        -o jsonpath='{.status.podIP}')
    for target_pod in $pods; do
        if [ "$source_pod" == "$target_pod" ]; then continue; fi
        target_ip=$(kubectl get pod -n $NAMESPACE $target_pod \
            -o jsonpath='{.status.podIP}')
        result=$(kubectl exec -n $NAMESPACE $source_pod -- \
            ping -c 1 -W 2 $target_ip 2>&1 | \
            grep -c "1 received")
        if [ "$result" -eq 0 ]; then
            echo "FAIL: $source_pod ($source_ip) -> $target_pod ($target_ip)"
        fi
    done
done
echo "Connectivity test complete"
```

### Packet Capture Across Namespace Boundaries

```bash
# Capture packets on the veth pair that connects a pod to the host

# Find which veth interface corresponds to a pod
POD_NETNS_PID=$(crictl inspectp <container-id> | jq '.info.pid')
# The veth peer's ifindex is in the pod's namespace
PEER_INDEX=$(nsenter -t $POD_NETNS_PID -n -- \
    ip link show eth0 | grep -oP 'veth[^:]+@if\K\d+')

# Find the corresponding host interface
HOST_VETH=$(ip link show | grep "^${PEER_INDEX}:" | awk '{print $2}' | tr -d ':')

echo "Pod veth on host: $HOST_VETH"

# Capture packets on both sides simultaneously
tcpdump -i $HOST_VETH -nn -w /tmp/pod-traffic.pcap &
```

### Namespace Leak Detection

In Kubernetes, network namespace leaks occur when a pod terminates but its namespace is not cleaned up. This consumes kernel memory and can interfere with networking:

```bash
# Count network namespaces on the host
ls /var/run/netns/ | wc -l

# Expected: one namespace per running pod
kubectl get pods -A --field-selector status.phase=Running | wc -l

# If namespace count is much higher than pod count, investigate
# Find namespaces not associated with any running process
for ns in $(ls /var/run/netns/); do
    PIDS=$(ip netns pids $ns 2>/dev/null)
    if [ -z "$PIDS" ]; then
        echo "Orphaned namespace: $ns (no processes)"
        # Check if a CNI lock file is preventing cleanup
        ls -la /var/lib/cni/networks/*/$(ip netns exec $ns ip addr show eth0 \
            2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1) 2>/dev/null
    fi
done
```

## Summary

Linux network namespaces are the kernel primitive that gives every container its own isolated network stack. Understanding the namespace lifecycle (bind mount vs process-held), veth pair topology (the virtual cable between namespaces), bridge networking (L2 switching between multiple namespaces), iptables namespace isolation (each namespace has independent rules), and per-namespace routing tables is prerequisite knowledge for debugging any container networking issue. The CNI plugin interface is a thin wrapper over these primitives: Flannel uses VXLAN encapsulation with bridge+veth, Calico uses pure L3 routing with proxy ARP, and Cilium replaces the entire kernel networking path with eBPF. When networking fails in Kubernetes, these underlying primitives are where the answer lies.
