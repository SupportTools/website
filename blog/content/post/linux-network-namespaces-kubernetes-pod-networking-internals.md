---
title: "Linux Network Namespaces and Virtual Networking: Understanding Kubernetes Pod Networking Internals"
date: 2031-07-16T00:00:00-05:00
draft: false
tags: ["Linux", "Kubernetes", "Networking", "Network Namespaces", "CNI", "eBPF", "veth", "Overlay Networks"]
categories: ["Linux", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux network namespaces, veth pairs, bridges, and overlay networks that power Kubernetes pod networking, with practical debugging techniques, CNI plugin internals, and network troubleshooting for production Kubernetes clusters."
more_link: "yes"
url: "/linux-network-namespaces-kubernetes-pod-networking-internals/"
---

Every Kubernetes network engineer knows that pods get IP addresses, but few understand exactly how a packet travels from one pod's network stack through the Linux kernel to another pod on a different node. This guide traces that complete path, building up from Linux network namespace primitives through veth pairs, Linux bridges, VXLAN overlays, and eBPF programs to understand how modern CNI plugins implement pod networking. With this knowledge, you can debug any Kubernetes networking issue at the kernel level.

<!--more-->

# Linux Network Namespaces and Kubernetes Pod Networking Internals

## Section 1: Linux Network Namespaces

A network namespace is a Linux kernel isolation primitive that gives a process its own independent copy of the networking stack: interfaces, routing tables, iptables rules, sockets, and ports.

### Creating and Inspecting Network Namespaces

```bash
# Create a named network namespace
ip netns add my-namespace

# List all network namespaces
ip netns list

# Execute a command inside the namespace
ip netns exec my-namespace ip link show
# Output: Only loopback (lo) is present, no interfaces

# Check the loopback interface
ip netns exec my-namespace ip addr show lo
# lo is DOWN by default

# Bring up loopback
ip netns exec my-namespace ip link set lo up

# Show routing table inside namespace
ip netns exec my-namespace ip route show
# Empty until we add interfaces and routes
```

### Network Namespace Files

```bash
# Named network namespaces are bind-mounted in /var/run/netns/
ls -la /var/run/netns/
# lrwxrwxrwx root root  -> /proc/PID/ns/net for running processes
# -rw-r--r-- root root  named netns files

# Find the netns of a running process
pid=$(pgrep nginx | head -1)
ls -la /proc/$pid/ns/net

# Two processes in the same netns have the same inode number
ls -lai /proc/1/ns/net /proc/$pid/ns/net

# Enter a process's network namespace (requires nsenter)
nsenter --net=/proc/$pid/ns/net ip addr show
```

### How Kubernetes Uses Network Namespaces

In Kubernetes, each pod gets its own network namespace. The `pause` (infrastructure) container creates the namespace when the pod starts. All other containers in the pod share this same network namespace, which is why:
- Containers in a pod communicate via `localhost`.
- All containers in a pod share the same IP address.
- Port conflicts occur between containers in the same pod.

```bash
# Find the pause container for a pod
POD_NAME="my-app-xxx"
NAMESPACE="production"
crictl pods --name "$POD_NAME" --namespace "$NAMESPACE"

# Get the pause container ID
PAUSE_ID=$(crictl pods --name "$POD_NAME" -q)
crictl inspectp $PAUSE_ID | jq '.info.pid'

# The pause container's PID has the pod's network namespace
PID=$(crictl inspectp $PAUSE_ID | jq -r '.info.pid')
nsenter --net=/proc/$PID/ns/net ip addr show
# This shows the pod's IP address and interfaces

# Alternative: find via proc filesystem
nsenter --net=/proc/$PID/ns/net ip route show
```

## Section 2: veth Pairs — The Bridge Between Namespaces

Virtual Ethernet (veth) devices always come in pairs and act as a virtual wire connecting two network namespaces. What goes in one end comes out the other.

### Creating veth Pairs

```bash
# Create a veth pair
ip link add veth0 type veth peer name veth1

# Both interfaces exist in the root namespace initially
ip link show type veth

# Move veth1 into our network namespace
ip link set veth1 netns my-namespace

# Now veth0 is in root namespace, veth1 is in my-namespace
ip link show veth0               # visible in root ns
ip netns exec my-namespace ip link show veth1   # visible in my-namespace

# Assign IP addresses
ip addr add 10.200.0.1/24 dev veth0
ip netns exec my-namespace ip addr add 10.200.0.2/24 dev veth1

# Bring both up
ip link set veth0 up
ip netns exec my-namespace ip link set veth1 up

# Test connectivity
ping -c 3 10.200.0.2
# PING 10.200.0.2: 3 packets, 3 received (100% success)

# From inside the namespace
ip netns exec my-namespace ping -c 3 10.200.0.1
```

### Tracing Packets Across veth Pairs

```bash
# Watch packets on the root namespace side of the veth pair
tcpdump -i veth0 -n

# In another terminal, send packets from inside the namespace
ip netns exec my-namespace ping 10.200.0.1

# Verify with ethtool: veth peers show each other's ifindex
ethtool -S veth0 | grep peer
ip netns exec my-namespace ethtool -S veth1 | grep peer
```

## Section 3: Linux Bridge — Connecting Multiple Pods on a Node

A Linux bridge acts as a virtual Layer 2 switch. On each Kubernetes node, a bridge connects all pod veth pairs, allowing pods on the same node to communicate directly.

### Creating a Bridge Network

```bash
# Create a Linux bridge
ip link add name cni0 type bridge

# Set bridge parameters for Kubernetes use
ip link set cni0 type bridge stp_state 0  # Disable STP (not needed)
ip link set cni0 type bridge forward_delay 0
ip link set cni0 type bridge ageing_time 0
ip addr add 10.244.0.1/24 dev cni0
ip link set cni0 up

# Add pod veth pairs to the bridge
# For each pod, one end of the veth goes into the pod namespace
# The other end goes into the bridge

# Example: Setting up networking for a new pod
pod_netns="pod-netns-xxx"
ip netns add $pod_netns

# Create veth pair
ip link add vethpod0 type veth peer name eth0

# Move eth0 into the pod namespace
ip link set eth0 netns $pod_netns

# Assign IP to the pod's interface
ip netns exec $pod_netns ip addr add 10.244.0.5/24 dev eth0
ip netns exec $pod_netns ip link set eth0 up
ip netns exec $pod_netns ip link set lo up

# Add default route in pod namespace (via the bridge gateway)
ip netns exec $pod_netns ip route add default via 10.244.0.1

# Connect the host-side veth to the bridge
ip link set vethpod0 master cni0
ip link set vethpod0 up

# Verify: pods can reach each other via bridge
ip netns exec $pod_netns ping 10.244.0.1  # ping gateway
```

### Examining the Bridge in a Running Kubernetes Node

```bash
# Show bridge interfaces (what's connected to cni0 or cbr0 depending on CNI)
bridge link show

# Show bridge forwarding database (MAC address table)
bridge fdb show dev cni0

# Show which veth pair is connected to which pod
# Map from veth interface name to pod name
for veth in $(bridge link show | grep "master cni0" | awk '{print $2}' | tr -d ':'); do
    PEER_INDEX=$(cat /sys/class/net/$veth/iflink)
    # Find pod namespace with this ifindex
    for pid in $(ls /proc | grep -E '^[0-9]+$'); do
        if [ -d /proc/$pid/net ]; then
            if grep -q "^ *$PEER_INDEX:" /proc/$pid/net/if_inet6 2>/dev/null || \
               awk "{if(\$1==$PEER_INDEX) print}" /proc/$pid/net/fib_trie 2>/dev/null | grep -q .; then
                echo "$veth -> PID $pid"
                break
            fi
        fi
    done
done

# Simpler approach using crictl
crictl ps -a | awk 'NR>1 {print $1}' | while read id; do
    pid=$(crictl inspect $id 2>/dev/null | jq -r '.info.pid // empty')
    if [ -n "$pid" ]; then
        veth=$(nsenter --net=/proc/$pid/ns/net ip link show eth0 2>/dev/null | \
               awk '{print $2}' | head -1 | tr -d ':')
        if [ -n "$veth" ]; then
            name=$(crictl inspect $id 2>/dev/null | jq -r '.status.metadata.name // empty')
            echo "Container: $name, Pod netns PID: $pid, Guest interface: $veth"
        fi
    fi
done
```

## Section 4: iptables and Connection Tracking in Kubernetes

Kubernetes uses iptables (or iptables via kube-proxy) extensively for Service routing and network policy enforcement.

### kube-proxy iptables Rules

```bash
# Show all kube-proxy iptables rules
iptables-save | grep -E "KUBE-|kube-"

# Show KUBE-SERVICES chain (Service VIP to ClusterIP mapping)
iptables -t nat -L KUBE-SERVICES -n --line-numbers

# Trace how a Service VIP is resolved for a specific service
SERVICE_IP="10.96.100.5"
iptables -t nat -L KUBE-SERVICES -n | grep $SERVICE_IP
# Output shows the KUBE-SVC-xxx chain for this service

# Follow the chain
CHAIN=$(iptables -t nat -L KUBE-SERVICES -n | grep $SERVICE_IP | awk '{print $3}')
iptables -t nat -L $CHAIN -n

# This shows the KUBE-SEP-xxx (Service EndPoint) chains for each pod endpoint
# Each SEP chain has a DNAT rule pointing to the actual pod IP

# Count total iptables rules (impacts latency at scale)
iptables -t nat -L | wc -l
# With 10,000 services: can be 50,000+ rules - significant performance impact
# This is why Cilium with eBPF bypasses iptables entirely
```

### Connection Tracking

```bash
# Show all tracked connections on the node
conntrack -L

# Show connections for a specific pod IP
conntrack -L | grep "10.244.0.5"

# Monitor connection tracking in real time
conntrack -E

# Check conntrack table utilization
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Increase conntrack table size (if hitting limits)
sysctl -w net.netfilter.nf_conntrack_max=1048576
echo "net.netfilter.nf_conntrack_max=1048576" >> /etc/sysctl.conf

# Watch for conntrack overflow events (causes dropped connections)
dmesg | grep "nf_conntrack: table full"
```

## Section 5: VXLAN Overlay Networks for Cross-Node Communication

When pods on different nodes need to communicate, the traffic must traverse the physical network. VXLAN (Virtual Extensible LAN) is the most common overlay technique: pod traffic is encapsulated in UDP packets and transmitted across the physical network.

### How Flannel VXLAN Works

```bash
# On a Kubernetes node using Flannel with VXLAN backend

# Show the VXLAN interface
ip link show flannel.1
# flannel.1 is a VXLAN interface (type vxlan)

ip addr show flannel.1
# Shows the VTEP (VXLAN Tunnel Endpoint) IP address

# Show routes: traffic to remote pod CIDRs goes via flannel.1
ip route show
# 10.244.1.0/24 via 10.244.1.0 dev flannel.1 onlink  <- remote node's pod CIDR

# Show ARP/FDB entries for the VXLAN tunnel
bridge fdb show dev flannel.1
# Shows MAC-to-VTEP IP mappings

# The packet flow for pod-to-pod across nodes:
# Pod (eth0) -> vethxxx -> cni0 (bridge) -> kernel routing -> flannel.1 (VXLAN) -> eth0 (physical NIC)
# VXLAN encapsulation: inner ethernet frame + VXLAN header + UDP header + outer IP header

# Verify VXLAN encapsulation with tcpdump
NODE_IP="192.168.1.10"  # The remote node
tcpdump -i eth0 -n host $NODE_IP and udp port 8472
# 8472 is the default VXLAN port used by Flannel
```

### Calico BGP Routing (No Overlay)

Calico's BGP mode avoids VXLAN encapsulation entirely by advertising pod CIDRs via BGP:

```bash
# Check Calico's BGP peers
kubectl exec -n calico-system calico-node-xxxxx -- calicoctl get bgppeer

# Show BGP routes
kubectl exec -n calico-system calico-node-xxxxx -- \
  bird -r -c /etc/calico/confd/config/bird.cfg "show route"

# On the node, verify routes learned via BGP
ip route show
# 10.244.1.0/26 via 192.168.1.11 dev eth0 proto bird  <- route to pods on node 2
# These are real routes, not tunnels

# For cross-subnet: Calico uses VXLAN or IP-in-IP when BGP can't route directly
ip link show tunl0      # IP-in-IP tunnel interface for Calico
ip link show vxlan.calico  # VXLAN interface for Calico VXLAN mode
```

## Section 6: Cilium eBPF Networking

Cilium replaces iptables and kube-proxy with eBPF programs attached to network interfaces at the kernel level.

### Examining Cilium's eBPF Programs

```bash
# List all eBPF programs loaded by Cilium
bpftool prog list | grep cilium

# Show eBPF maps used for endpoint tracking
bpftool map list | grep cilium

# Examine a specific map (endpoint map)
ENDPOINT_MAP_ID=$(bpftool map list | grep cilium_lxc | awk '{print $1}' | head -1 | tr -d ':')
bpftool map dump id $ENDPOINT_MAP_ID | head -50

# Check Cilium endpoint status
kubectl exec -n kube-system cilium-xxxxx -- cilium endpoint list

# Show eBPF-based service load balancing table
kubectl exec -n kube-system cilium-xxxxx -- cilium service list

# Trace a packet with Cilium's monitor
kubectl exec -n kube-system cilium-xxxxx -- cilium monitor \
  --from <pod-endpoint-id> \
  --type drop,trace
```

### Cilium Network Policy Enforcement with eBPF

```bash
# Show Cilium network policies
kubectl exec -n kube-system cilium-xxxxx -- cilium policy get

# Trace a network policy decision
kubectl exec -n kube-system cilium-xxxxx -- cilium monitor \
  --type policy-verdict \
  --from <source-endpoint-id> \
  --to <destination-endpoint-id>

# Show which eBPF programs are attached to a pod's veth
ip netns exec <pod-netns-pid> \
  bpftool net list dev eth0
# Shows TC (Traffic Control) programs attached for ingress/egress
```

## Section 7: Complete Packet Trace: Same-Node Pod-to-Pod

```bash
# Trace a packet from pod A (10.244.0.5) to pod B (10.244.0.6) on the same node

# 1. Pod A sends packet from eth0 (in pod netns)
# Source: 10.244.0.5:PORT -> Dest: 10.244.0.6:PORT

# 2. Packet travels over veth pair to host namespace
# vethpodA (host side, enslaved to cni0 bridge)

# 3. Linux bridge (cni0) does L2 forwarding
# - Looks up MAC address of 10.244.0.6 in bridge FDB
# - If known, forwards to correct veth (vethpodB)
# - If unknown, floods to all bridge ports

# 4. Packet enters vethpodB (host side)
# 5. Packet exits eth0 (pod B side of veth) into pod B's namespace

# Capture the entire flow with tcpdump
PODA_IP="10.244.0.5"
PODB_IP="10.244.0.6"

# On the bridge
tcpdump -i cni0 -n host $PODA_IP or host $PODB_IP

# On pod A's veth (host side)
VETHA=$(bridge link show | grep -B1 "$(crictl inspect <podA-container-id> | jq -r '.info.pid')" | awk '{print $2}' | head -1 | tr -d ':')
tcpdump -i $VETHA -n

# Use nettop or ss for a higher-level view
ss -tunapw | grep "$PODA_IP"
```

## Section 8: Complete Packet Trace: Cross-Node with VXLAN

```bash
# Trace a packet from pod A on Node 1 (10.244.0.5) to pod B on Node 2 (10.244.1.5)

# Node 1 perspective:
# 1. Pod A sends packet
# 2. Packet reaches cni0 bridge on Node 1
# 3. Bridge has no local port for 10.244.1.5 (it's on Node 2)
# 4. Packet routed via kernel routing table: 10.244.1.0/24 via flannel.1
# 5. flannel.1 VXLAN encapsulates: inner frame (10.244.0.5->10.244.1.5) wrapped in
#    UDP (VNI: 1, port: 8472) wrapped in IP (Node1_IP -> Node2_IP)
# 6. Encapsulated packet sent via physical NIC (eth0)

# Node 2 perspective:
# 7. Physical NIC receives UDP packet destined for port 8472
# 8. Kernel VXLAN decapsulation: extracts inner ethernet frame
# 9. flannel.1 delivers decapsulated frame to kernel network stack
# 10. Kernel routes to 10.244.1.5 via cni0 bridge
# 11. Pod B receives the packet

# Debug cross-node connectivity:

# From Node 1: verify VXLAN FDB entry for Node 2
bridge fdb show dev flannel.1 | grep <Node2_VTEP_IP>

# If missing, check Flannel etcd/Kubernetes datastore
kubectl -n kube-flannel logs daemonset/kube-flannel-ds | grep "10.244.1.0"

# From Node 1: manually trace the encapsulation
traceroute -n 10.244.1.5
# Should show: Node1 -> Node2 -> Pod B (VXLAN means 1 hop across physical network)

# Verify VXLAN UDP traffic at physical NIC
tcpdump -i eth0 -n udp port 8472
# See encapsulated packets

# Decode VXLAN packets with Wireshark format
tcpdump -i eth0 -n udp port 8472 -w /tmp/vxlan_capture.pcap
# Open with Wireshark for detailed VXLAN header inspection

# Check for VXLAN MTU issues (most common cross-node problem)
# VXLAN overhead: 50 bytes (VXLAN header: 8, UDP: 8, IP: 20, outer Ethernet: 14)
# If physical MTU is 1500, inner MTU should be 1450

# Check node MTU
ip link show eth0 | grep mtu
# Should be 9000 (jumbo frames) for efficient VXLAN, or 1500 (standard)

# Check pod interface MTU
ip netns exec $POD_PID ip link show eth0 | grep mtu
# Should be physical_mtu - 50 for VXLAN

# If MTU is misconfigured, you'll see fragmentation or packet drops:
ip -s link show eth0 | grep -A2 "RX:"
# Look for "dropped" or "overrun" counters
```

## Section 9: Kubernetes Service Networking

Understanding how Service IPs (ClusterIPs) work is essential for troubleshooting connectivity.

### ClusterIP DNAT Flow

```bash
# Service ClusterIP: 10.96.100.5 (virtual IP, no interface has this address)
# Pod endpoints: 10.244.0.5:8080, 10.244.0.6:8080

# kube-proxy creates iptables rules to DNAT the ClusterIP to a random endpoint:
iptables -t nat -L KUBE-SERVICES -n | grep "10.96.100.5"
# -> KUBE-SVC-xxxxx (service chain)

iptables -t nat -L KUBE-SVC-xxxxx -n
# -> 50% to KUBE-SEP-aaaa (pod 1)
# -> 50% to KUBE-SEP-bbbb (pod 2)

iptables -t nat -L KUBE-SEP-aaaa -n
# -> DNAT to 10.244.0.5:8080

# With IPVS mode (recommended for large clusters)
ipvsadm -L -n | grep "10.96.100.5"
# Shows TCP 10.96.100.5:80 with round-robin to 10.244.0.5:8080 and 10.244.0.6:8080

# Change kube-proxy mode (requires restart)
kubectl -n kube-system edit configmap kube-proxy
# Change mode: "" to mode: "ipvs"
# IPVS is much faster than iptables for large numbers of services
```

## Section 10: Network Namespace Debugging Toolkit

### Full Debugging Script

```bash
#!/bin/bash
# debug-pod-networking.sh
# Usage: ./debug-pod-networking.sh <pod-name> <namespace>

POD_NAME=$1
NAMESPACE=${2:-default}

echo "=== Pod Network Debug Report ==="
echo "Pod: $POD_NAME, Namespace: $NAMESPACE"
echo ""

# Get pod details
POD_IP=$(kubectl get pod -n $NAMESPACE $POD_NAME -o jsonpath='{.status.podIP}')
NODE_NAME=$(kubectl get pod -n $NAMESPACE $POD_NAME -o jsonpath='{.spec.nodeName}')
echo "Pod IP: $POD_IP"
echo "Node: $NODE_NAME"
echo ""

# Get the pod's process namespace PID
CONTAINER_ID=$(kubectl get pod -n $NAMESPACE $POD_NAME \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's|containerd://||')
PID=$(crictl inspect $CONTAINER_ID 2>/dev/null | jq -r '.info.pid')
echo "Container PID: $PID"
echo ""

if [ -z "$PID" ]; then
    echo "ERROR: Could not find container PID"
    exit 1
fi

echo "=== Pod Network Interfaces ==="
nsenter --net=/proc/$PID/ns/net ip addr show
echo ""

echo "=== Pod Routing Table ==="
nsenter --net=/proc/$PID/ns/net ip route show
echo ""

echo "=== Pod DNS Configuration ==="
nsenter --net=/proc/$PID/ns/net cat /etc/resolv.conf 2>/dev/null || \
  nsenter --mount=/proc/$PID/ns/mnt cat /etc/resolv.conf 2>/dev/null
echo ""

echo "=== Host-Side veth for Pod ==="
ETH0_LINK=$(nsenter --net=/proc/$PID/ns/net ip link show eth0 | grep -oP '(?<=link/ether )\S+' || true)
IFINDEX=$(nsenter --net=/proc/$PID/ns/net ip link show eth0 | head -1 | awk '{print $1}' | tr -d ':')
echo "Pod eth0 ifindex: $IFINDEX"

HOST_VETH=$(ip link | grep "^$((IFINDEX+1)):" | awk '{print $2}' | tr -d ':' | tr -d '@')
if [ -n "$HOST_VETH" ]; then
    echo "Host veth: $HOST_VETH"
    ip link show $HOST_VETH
fi
echo ""

echo "=== iptables DNAT Rules for Pod IP ==="
iptables -t nat -L -n | grep $POD_IP
echo ""

echo "=== Active Connections from/to Pod ==="
conntrack -L 2>/dev/null | grep $POD_IP | head -20
echo ""

echo "=== Network Policy Status ==="
kubectl get networkpolicy -n $NAMESPACE 2>/dev/null
echo ""

echo "=== Test DNS Resolution from Pod ==="
kubectl exec -n $NAMESPACE $POD_NAME -- \
  nslookup kubernetes.default.svc.cluster.local 2>/dev/null || \
  echo "DNS test failed or nslookup not available"
echo ""

echo "=== Test Service Connectivity ==="
KUBE_SVC_IP=$(kubectl get svc -n default kubernetes -o jsonpath='{.spec.clusterIP}')
kubectl exec -n $NAMESPACE $POD_NAME -- \
  curl -sk --connect-timeout 2 https://$KUBE_SVC_IP 2>&1 | head -3 || \
  echo "Service connectivity test failed"
```

### Simulating CNI Plugin Execution

```bash
# Understanding what a CNI plugin does when kubelet calls it
# Manually simulate CNI ADD operation

export CNI_COMMAND=ADD
export CNI_CONTAINERID=test-container-123
export CNI_NETNS=/var/run/netns/my-test-namespace
export CNI_IFNAME=eth0
export CNI_PATH=/opt/cni/bin

# Create test namespace
ip netns add my-test-namespace

# Call the bridge CNI plugin
cat <<EOF | /opt/cni/bin/bridge
{
  "cniVersion": "0.4.0",
  "name": "mynet",
  "type": "bridge",
  "bridge": "cni-test0",
  "isGateway": true,
  "ipMasq": true,
  "ipam": {
    "type": "host-local",
    "subnet": "10.88.0.0/16",
    "routes": [{"dst": "0.0.0.0/0"}]
  }
}
EOF

# Verify the namespace was configured
ip netns exec my-test-namespace ip addr show
ip netns exec my-test-namespace ip route show

# Cleanup
CNI_COMMAND=DEL cat <<EOF | /opt/cni/bin/bridge
{
  "cniVersion": "0.4.0",
  "name": "mynet",
  "type": "bridge",
  "bridge": "cni-test0"
}
EOF
ip netns delete my-test-namespace
```

## Section 11: Common Networking Issues and Root Causes

### Symptom: Pods Cannot Reach Each Other on the Same Node

```bash
# Check bridge configuration
brctl show cni0
ip link show cni0

# Verify IP forwarding is enabled
cat /proc/sys/net/ipv4/ip_forward
# Must be 1
sysctl net.ipv4.ip_forward=1

# Check iptables FORWARD chain
iptables -L FORWARD -n
# Should see ACCEPT rules for pod CIDR

# Check bridge netfilter module
lsmod | grep br_netfilter
# Must be loaded
modprobe br_netfilter
sysctl net.bridge.bridge-nf-call-iptables=1
```

### Symptom: Cross-Node Pod Communication Fails

```bash
# Check VXLAN or tunnel interface is up
ip link show flannel.1 or ip link show tunl0

# Verify routing to remote pod CIDR
ip route get 10.244.1.5
# Should route via flannel.1 or physical NIC (Calico BGP)

# Check for MTU mismatch (most common cause)
ping -c 1 -M do -s 1450 <remote-pod-ip>
# If this fails but ping -s 1000 works: MTU issue

# Check VXLAN FDB entries
bridge fdb show dev flannel.1 | grep <remote-node-vtep-ip>

# Check for firewall blocking UDP 8472 (VXLAN)
iptables -L -n | grep 8472
# Or test directly
nc -u -z <node2-ip> 8472
```

### Symptom: DNS Resolution Fails in Pods

```bash
# Check CoreDNS pods are running
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Check CoreDNS logs
kubectl logs -n kube-system -l k8s-app=kube-dns

# Verify kube-dns Service is healthy
kubectl get svc -n kube-system kube-dns
kubectl get endpoints -n kube-system kube-dns

# Test DNS from the pod
kubectl exec -it $POD -- nslookup kubernetes.default

# Check the pod can reach CoreDNS
DNS_IP=$(kubectl get svc -n kube-system kube-dns -o jsonpath='{.spec.clusterIP}')
kubectl exec -it $POD -- curl -sv udp://$DNS_IP:53

# Check iptables rules for DNS service
iptables -t nat -L -n | grep $DNS_IP
```

## Conclusion

Linux network namespaces are the foundational primitive that makes Kubernetes pod networking possible. Every Kubernetes network concept — pod isolation, Service routing, NetworkPolicy enforcement — maps to specific Linux kernel mechanisms: veth pairs for namespace connectivity, Linux bridges for same-node L2 switching, VXLAN or BGP routing for cross-node communication, iptables or eBPF for Service load balancing and network policy enforcement. With this kernel-level understanding, debugging becomes systematic: trace the packet path from source namespace through veth to bridge to overlay to destination namespace, and the root cause of any connectivity issue becomes apparent. The tools covered here — `ip netns`, `nsenter`, `bridge`, `conntrack`, `bpftool`, `tcpdump` — are the complete toolkit for Kubernetes network engineering.
