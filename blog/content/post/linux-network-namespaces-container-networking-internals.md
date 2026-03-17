---
title: "Linux Network Namespaces: Container Networking Internals"
date: 2029-04-08T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Containers", "Kubernetes", "CNI", "iptables", "Network Namespaces"]
categories: ["Linux", "Networking", "Containers"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux network namespaces: creation, veth pairs, bridge devices, iptables in namespaces, how Kubernetes pod networking works under the hood, and CNI plugin mechanics."
more_link: "yes"
url: "/linux-network-namespaces-container-networking-internals/"
---

Every Kubernetes Pod has its own isolated network stack - its own IP address, routing table, iptables rules, and network interfaces. This isolation is implemented by Linux network namespaces. Understanding how network namespaces work, how virtual ethernet pairs bridge them, and how CNI plugins automate this setup is essential for debugging pod networking problems and understanding what tools like Cilium and Flannel actually do.

<!--more-->

# Linux Network Namespaces: Container Networking Internals

## Section 1: What Is a Network Namespace?

A Linux network namespace is an isolated copy of the network stack:

- Network interfaces (including a separate loopback)
- Routing tables
- Netfilter (iptables/nftables) rules
- Network sockets
- `/proc/net` virtual filesystem
- Connection tracking tables

Processes in different network namespaces cannot communicate directly - they each see their own isolated network world.

```bash
# List existing network namespaces
ip netns list

# Show network interfaces in the current (default) namespace
ip link show

# Show network interfaces in a named namespace
ip netns exec myns ip link show

# Show your current namespace
# (Each process's network namespace is accessible via /proc)
ls -la /proc/$$/ns/net
# lrwxrwxrwx /proc/1234/ns/net -> net:[4026531992]

# The number after net: is the inode of the namespace
# Processes sharing the same inode are in the same namespace
```

## Section 2: Creating Network Namespaces

### Using ip netns

```bash
# Create a named network namespace
# This creates a bind mount at /var/run/netns/myns
# that keeps the namespace alive even if no process is using it
ip netns add myns

# List namespaces
ip netns list
# myns

# Verify the namespace exists as a mount
ls -la /var/run/netns/
# -r--r--r-- 1 root root 0 myns

# Run a command in the namespace
ip netns exec myns ip link show
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN
#    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00

# Start a bash shell in the namespace
ip netns exec myns bash
# (All commands here see the isolated network stack)
ip link show
# Only loopback - completely isolated
exit

# Delete the namespace
ip netns delete myns
```

### Creating Namespaces Programmatically

```c
// create_namespace.c
// Demonstrates how container runtimes create namespaces
#define _GNU_SOURCE
#include <sched.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

int main() {
    // unshare creates a new namespace for the calling process
    // CLONE_NEWNET: new network namespace
    // CLONE_NEWUTS: new UTS (hostname) namespace
    // CLONE_NEWPID: new PID namespace
    // CLONE_NEWNS: new mount namespace
    // CLONE_NEWUSER: new user namespace
    // CLONE_NEWIPC: new IPC namespace

    if (unshare(CLONE_NEWNET) != 0) {
        fprintf(stderr, "unshare(CLONE_NEWNET) failed: %s\n", strerror(errno));
        return 1;
    }

    printf("New network namespace created for PID %d\n", getpid());
    printf("Namespace inode: ");
    fflush(stdout);

    // Show the namespace ID
    system("ls -la /proc/self/ns/net");
    system("ip link show");

    return 0;
}

// Compile: gcc -o create_namespace create_namespace.c
// Run: sudo ./create_namespace
```

### Using clone() for Full Container Isolation

```c
// full_container.c
// Simplified container creation using clone()
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <sys/wait.h>

#define STACK_SIZE (1024 * 1024)

static int container_main(void *arg) {
    printf("Container PID: %d\n", getpid());
    printf("Container network interfaces:\n");
    system("ip link show");
    return 0;
}

int main() {
    char *stack = malloc(STACK_SIZE);
    char *stack_top = stack + STACK_SIZE;

    // Clone with new network namespace
    pid_t pid = clone(
        container_main,
        stack_top,
        CLONE_NEWNET | SIGCHLD,
        NULL
    );

    if (pid < 0) {
        fprintf(stderr, "clone failed: %s\n", strerror(errno));
        return 1;
    }

    // Parent: configure the namespace (set up veth, etc.)
    printf("Container process PID: %d\n", pid);
    printf("Setting up network for container...\n");

    // Wait for container to finish
    waitpid(pid, NULL, 0);
    free(stack);
    return 0;
}
```

## Section 3: Virtual Ethernet Pairs (veth)

Network namespaces in isolation are useless - you need to connect them to the outside world. The primary mechanism is the **veth pair**: two virtual network interfaces that act as a tunnel between namespaces. Packets sent into one end emerge from the other.

```
Namespace A                    Namespace B
[veth0] ==================== [veth1]
```

### Creating veth Pairs

```bash
# Create a veth pair
# veth0 and veth1 are the two ends - created in the default (root) namespace
ip link add veth0 type veth peer name veth1

# Verify both exist
ip link show type veth
# 3: veth1@veth0: <BROADCAST,MULTICAST,M-DOWN> mtu 1500 ...
# 4: veth0@veth1: <BROADCAST,MULTICAST,M-DOWN> mtu 1500 ...

# Move one end into a namespace
ip netns add container1
ip link set veth1 netns container1

# Now veth0 is in root namespace, veth1 is in container1
ip link show veth0  # Still here
ip netns exec container1 ip link show veth1  # In container1

# Configure IP addresses on both ends
ip addr add 192.168.100.1/24 dev veth0
ip netns exec container1 ip addr add 192.168.100.2/24 dev veth1

# Bring both interfaces up
ip link set veth0 up
ip netns exec container1 ip link set veth1 up

# Also bring up loopback in the container namespace
ip netns exec container1 ip link set lo up

# Test connectivity
ping -c 3 192.168.100.2
# PING 192.168.100.2: 56 data bytes
# 64 bytes from 192.168.100.2: icmp_seq=0 ttl=64 time=0.072 ms

# Test from within the namespace
ip netns exec container1 ping -c 3 192.168.100.1
```

### Giving the Container Internet Access

```bash
# Create the container namespace and veth pair
ip netns add container1
ip link add veth0 type veth peer name veth1
ip link set veth1 netns container1

# Configure addressing
ip addr add 10.200.0.1/24 dev veth0
ip link set veth0 up
ip netns exec container1 ip addr add 10.200.0.2/24 dev veth1
ip netns exec container1 ip link set veth1 up
ip netns exec container1 ip link set lo up

# Add default route in the container
ip netns exec container1 ip route add default via 10.200.0.1

# Enable IP forwarding in the root namespace
echo 1 > /proc/sys/net/ipv4/ip_forward

# Configure NAT/masquerading for outbound traffic
# Replace eth0 with your host's internet-facing interface
iptables -t nat -A POSTROUTING -s 10.200.0.0/24 -o eth0 -j MASQUERADE

# Test internet access from container
ip netns exec container1 ping -c 3 8.8.8.8
ip netns exec container1 curl -s https://api.example.com
```

## Section 4: Linux Bridge Devices

When you have multiple containers, you need each veth pair's host end connected to a common bridge so containers can communicate with each other:

```
Root Namespace:
[eth0]<--->[bridge0]---[veth0_host]---veth pair---[veth0_cont] Container1
                    \--[veth1_host]---veth pair---[veth1_cont] Container2
                    \--[veth2_host]---veth pair---[veth2_cont] Container3
```

```bash
# Create a bridge
ip link add br0 type bridge

# Set bridge forward delay to 0 (skip STP delays for containers)
ip link set br0 type bridge forward_delay 0
ip link set br0 type bridge stp_state 0

# Configure bridge IP (gateway for containers)
ip addr add 172.20.0.1/24 dev br0
ip link set br0 up

# Create container namespaces and veth pairs
for i in 1 2 3; do
    ip netns add container${i}
    ip link add veth${i}_host type veth peer name veth${i}_cont

    # Attach host end to bridge
    ip link set veth${i}_host master br0
    ip link set veth${i}_host up

    # Move container end into namespace
    ip link set veth${i}_cont netns container${i}

    # Configure container
    ip netns exec container${i} ip addr add 172.20.0.1${i}/24 dev veth${i}_cont
    ip netns exec container${i} ip link set veth${i}_cont up
    ip netns exec container${i} ip link set lo up
    ip netns exec container${i} ip route add default via 172.20.0.1
done

# Enable forwarding and masquerade
echo 1 > /proc/sys/net/ipv4/ip_forward
iptables -t nat -A POSTROUTING -s 172.20.0.0/24 ! -o br0 -j MASQUERADE

# Containers can now communicate with each other
ip netns exec container1 ping -c 3 172.20.0.12  # Ping container2
ip netns exec container2 ping -c 3 172.20.0.13  # Ping container3
ip netns exec container1 ping -c 3 8.8.8.8      # Internet access
```

## Section 5: iptables in Network Namespaces

Each network namespace has its own iptables (netfilter) rule set. This is how container runtimes implement port mapping and network policies.

```bash
# Default namespace iptables rules (host)
iptables -L -n -v --line-numbers

# Container-specific iptables (empty by default)
ip netns exec container1 iptables -L -n -v

# Port mapping: forward host port 8080 to container port 80
# This DNAT rule lives in the host (root) namespace
iptables -t nat -A PREROUTING \
    -p tcp --dport 8080 \
    -j DNAT --to-destination 172.20.0.11:80

iptables -A FORWARD \
    -p tcp -d 172.20.0.11 --dport 80 \
    -m state --state NEW,ESTABLISHED,RELATED \
    -j ACCEPT

# What Docker/containerd actually creates for port mapping:
# Rule 1: Catch traffic destined for the mapped port
# -A DOCKER ! -i docker0 -p tcp -m tcp --dport 8080 -j DNAT --to-destination 172.17.0.2:80

# Rule 2: Accept forwarded traffic to the container
# -A DOCKER -d 172.17.0.2/32 ! -i docker0 -o docker0 -p tcp -m tcp --dport 80 -j ACCEPT
```

### Inspecting Docker/containerd iptables Rules

```bash
# See all iptables chains Docker creates
iptables -t nat -L -n -v
# Chain DOCKER (2 references)
# Chain DOCKER-ISOLATION-STAGE-1
# Chain DOCKER-ISOLATION-STAGE-2
# Chain DOCKER-USER

# See all forwarding rules
iptables -t filter -L FORWARD -n -v

# Find which rules apply to a specific container
docker inspect <container-id> | jq '.[0].NetworkSettings.Networks'
CONTAINER_IP="172.17.0.5"
iptables -t nat -L -n -v | grep $CONTAINER_IP
```

### Kubernetes kube-proxy iptables Mode

```bash
# kube-proxy in iptables mode creates rules for every Service
iptables -t nat -L KUBE-SERVICES -n -v | head -30

# Service ClusterIP -> endpoint DNAT
# -A KUBE-SERVICES -d 10.96.5.100/32 -p tcp --dport 80 \
#   -j KUBE-SVC-XXXXXXXXXXXX

# Load balancing: probability-based rule selection
# -A KUBE-SVC-XXXX -m statistic --mode random --probability 0.33333 \
#   -j KUBE-SEP-POD1

# NodePort handling
# -A KUBE-NODEPORTS -p tcp --dport 32080 -j KUBE-SVC-XXXX
```

## Section 6: How Kubernetes Pod Networking Works

### Step-by-Step Pod Network Setup

When Kubernetes creates a Pod, the sequence is:

```
1. kubelet asks container runtime (containerd) to create pod sandbox
2. containerd/runc creates a new network namespace for the pod
3. kubelet calls CNI plugin with pod namespace info
4. CNI plugin:
   a. Creates a veth pair
   b. Moves one end into the pod's network namespace
   c. Attaches the host end to a bridge (or configures routing)
   d. Assigns a pod IP from the node's PodCIDR
   e. Configures routes and iptables
5. All containers in the Pod share the same network namespace
   (init container and app containers all see the same IP)
```

```bash
# Find the network namespace for a running pod
# Method 1: via crictl
crictl pods
POD_ID=$(crictl pods --name my-pod -q)
crictl inspectp $POD_ID | jq '.status.linux.namespaces[] | select(.type=="network")'
# Returns the network namespace path

# Method 2: via /proc
# Find the container PID
CONTAINER_ID=$(crictl ps --pod $POD_ID -q | head -1)
CONTAINER_PID=$(crictl inspect $CONTAINER_ID | jq -r '.info.pid')

# The pod's network namespace
ls -la /proc/$CONTAINER_PID/ns/net
# -> net:[4026532789]

# Run ip commands in the pod's namespace
nsenter --net=/proc/$CONTAINER_PID/ns/net ip link show
nsenter --net=/proc/$CONTAINER_PID/ns/net ip route show
nsenter --net=/proc/$CONTAINER_PID/ns/net iptables -L -n -v
```

### Inspecting the pause (infra) Container

The `pause` container is the namespace holder for each pod. It is created first and holds the network namespace. All other containers in the pod join the pause container's namespaces.

```bash
# Find the pause container for a pod
PAUSE_ID=$(crictl ps | grep pause | awk '{print $1}' | head -1)
PAUSE_PID=$(crictl inspect $PAUSE_ID | jq -r '.info.pid')

# The network namespace of the pause container IS the pod's network namespace
cat /proc/$PAUSE_PID/net/if_inet6
ls -la /proc/$PAUSE_PID/ns/net

# All containers in the pod share this namespace
# Verify: app container should show the same ns inode as pause
APP_PID=$(crictl inspect $APP_CONTAINER_ID | jq -r '.info.pid')
ls -la /proc/$APP_PID/ns/net  # Same inode as pause container
```

## Section 7: CNI Plugin Mechanics

CNI (Container Network Interface) defines how container runtimes interact with network plugins. Every CNI plugin is an executable that reads configuration from stdin and environment variables, then sets up the network.

### CNI Plugin Interface

```bash
# CNI plugins are called with:
# - CNI_COMMAND: ADD | DEL | CHECK | VERSION
# - CNI_CONTAINERID: container ID
# - CNI_NETNS: path to network namespace (/proc/PID/ns/net)
# - CNI_IFNAME: interface name to create in container (eth0)
# - CNI_PATH: directory containing CNI plugin executables

# Configuration is passed via stdin as JSON

# Example: calling the bridge plugin manually
cat > /tmp/cni-config.json << 'EOF'
{
  "cniVersion": "1.0.0",
  "name": "mynet",
  "type": "bridge",
  "bridge": "cni0",
  "isGateway": true,
  "ipMasq": true,
  "ipam": {
    "type": "host-local",
    "subnet": "10.244.0.0/16",
    "routes": [
      {"dst": "0.0.0.0/0"}
    ]
  }
}
EOF

# Set up a test namespace
ip netns add test-cni
NETNS_PATH=/var/run/netns/test-cni

# Call the CNI plugin
CNI_COMMAND=ADD \
CNI_CONTAINERID=test123 \
CNI_NETNS=$NETNS_PATH \
CNI_IFNAME=eth0 \
CNI_PATH=/opt/cni/bin \
  /opt/cni/bin/bridge < /tmp/cni-config.json

# The plugin will output JSON with the assigned IP
# {"cniVersion":"1.0.0","interfaces":[...],"ips":[{"address":"10.244.0.5/16"}]}

# Verify the interface was created in the namespace
ip netns exec test-cni ip addr show eth0
```

### Writing a Simple CNI Plugin

```bash
#!/bin/bash
# simple-cni.sh - Minimal CNI plugin for educational purposes

CNI_COMMAND=${CNI_COMMAND:-ADD}
CNI_CONTAINERID=${CNI_CONTAINERID}
CNI_NETNS=${CNI_NETNS}
CNI_IFNAME=${CNI_IFNAME:-eth0}

# Read config from stdin
CONFIG=$(cat)

# Parse the subnet from config
SUBNET=$(echo "$CONFIG" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c['ipam']['subnet'])")
BRIDGE_IP="${SUBNET%.*}.1"  # First host in subnet = gateway
CONTAINER_IP="${SUBNET%.*}.$(shuf -i 2-254 -n1)"  # Random IP

log() {
    echo "$(date): $*" >> /var/log/simple-cni.log
}

case "$CNI_COMMAND" in
ADD)
    log "ADD: container=$CNI_CONTAINERID netns=$CNI_NETNS"

    # Create bridge if it doesn't exist
    if ! ip link show cni0 >/dev/null 2>&1; then
        ip link add cni0 type bridge
        ip addr add "${BRIDGE_IP}/24" dev cni0
        ip link set cni0 up
        log "Created bridge cni0 with IP $BRIDGE_IP"
    fi

    # Create veth pair
    VETH_HOST="veth${CNI_CONTAINERID:0:8}"
    ip link add "$VETH_HOST" type veth peer name "$CNI_IFNAME" netns "$CNI_NETNS"

    # Attach host end to bridge
    ip link set "$VETH_HOST" master cni0
    ip link set "$VETH_HOST" up

    # Configure container end
    ip netns exec "$CNI_NETNS" ip addr add "${CONTAINER_IP}/24" dev "$CNI_IFNAME"
    ip netns exec "$CNI_NETNS" ip link set "$CNI_IFNAME" up
    ip netns exec "$CNI_NETNS" ip link set lo up
    ip netns exec "$CNI_NETNS" ip route add default via "$BRIDGE_IP"

    log "Configured container $CNI_CONTAINERID with IP $CONTAINER_IP"

    # Output CNI result JSON
    cat << EOF
{
  "cniVersion": "1.0.0",
  "interfaces": [
    {
      "name": "$CNI_IFNAME",
      "mac": "$(cat /sys/class/net/$VETH_HOST/address)",
      "sandbox": "$CNI_NETNS"
    }
  ],
  "ips": [
    {
      "address": "${CONTAINER_IP}/24",
      "gateway": "$BRIDGE_IP",
      "interface": 0
    }
  ]
}
EOF
    ;;

DEL)
    log "DEL: container=$CNI_CONTAINERID"
    VETH_HOST="veth${CNI_CONTAINERID:0:8}"
    ip link del "$VETH_HOST" 2>/dev/null || true
    ;;

CHECK)
    log "CHECK: container=$CNI_CONTAINERID"
    exit 0
    ;;

VERSION)
    echo '{"cniVersion":"1.0.0","supportedVersions":["0.3.0","0.4.0","1.0.0"]}'
    ;;
esac
```

## Section 8: Flannel CNI Internals

Flannel is one of the simplest Kubernetes CNI plugins. It creates an overlay network using VXLAN:

```bash
# Flannel creates a VXLAN tunnel interface
ip link show flannel.1
# flannel.1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450 qdisc noqueue
#   link/ether xx:xx:xx:xx:xx:xx brd ff:ff:ff:ff:ff:ff

# Flannel assigns each node a /24 from the pod CIDR
# Node 1: 10.244.1.0/24
# Node 2: 10.244.2.0/24
# Node 3: 10.244.3.0/24

# Routes added by Flannel for cross-node pod communication
ip route show | grep flannel
# 10.244.2.0/24 via 10.244.2.0 dev flannel.1 onlink
# 10.244.3.0/24 via 10.244.3.0 dev flannel.1 onlink

# FDB entries for VXLAN encapsulation
bridge fdb show dev flannel.1 | head -5
# xx:xx:xx:xx:xx:xx dst <NODE2_IP> self permanent

# ARP entries for VXLAN (IP to MAC mapping for remote pods)
ip neigh show dev flannel.1 | head -5
```

## Section 9: Cilium CNI Internals

Cilium uses eBPF instead of iptables and bridges:

```bash
# Cilium creates a virtual device for each pod
ip link show lxc-<container-id>
# lxc1234: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ...

# Cilium attaches eBPF programs to these interfaces
# instead of using iptables

# Check eBPF programs attached to a Cilium interface
bpftool prog show | grep lxc

# Cilium's network policy enforcement happens in eBPF
# View active policies
cilium policy get

# Check endpoint status
cilium endpoint list

# Trace packet flow for debugging
cilium monitor --type drop
cilium monitor --type trace
```

## Section 10: Debugging Pod Networking

### Packet Capture Between Pods

```bash
# Find the veth interface on the host for a specific pod
POD_NAME="my-pod"
NAMESPACE="production"

# Get the pod's IP
POD_IP=$(kubectl get pod $POD_NAME -n $NAMESPACE -o jsonpath='{.status.podIP}')

# Find which host interface corresponds to this pod
# Method: grep ARP table for the pod IP
arp -n | grep $POD_IP
# Shows the MAC address

# Find the veth with that MAC address
for iface in /sys/class/net/veth*; do
    iface_name=$(basename $iface)
    if ip link show $iface_name | grep -q $(arp -n | grep $POD_IP | awk '{print $3}'); then
        echo "Pod veth: $iface_name"
    fi
done

# Or use the node agent to find it (e.g., Cilium)
cilium endpoint list | grep $POD_IP

# Capture traffic on the veth interface
VETH_IFACE="veth1234"
tcpdump -i $VETH_IFACE -w /tmp/pod-traffic.pcap
```

### Diagnosing DNS Issues

```bash
# Test DNS from within a pod
kubectl exec -it $POD_NAME -- nslookup kubernetes.default.svc.cluster.local

# Capture DNS traffic
kubectl exec -it $POD_NAME -- tcpdump -i eth0 -n port 53 -w /tmp/dns.pcap

# Check CoreDNS is reachable
kubectl exec -it $POD_NAME -- curl -s http://kube-dns.kube-system.svc.cluster.local:9153/metrics | head

# Check /etc/resolv.conf in pod
kubectl exec $POD_NAME -- cat /etc/resolv.conf
# nameserver 10.96.0.10
# search production.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5
```

### Network Policy Debugging

```bash
# Test connectivity between pods
kubectl exec -it source-pod -- curl -v http://target-service:8080

# Trace with Cilium (if using Cilium CNI)
cilium monitor --from-endpoint $(cilium endpoint list | grep source-pod | awk '{print $1}')

# Check which NetworkPolicies apply to a pod
kubectl get networkpolicy -n $NAMESPACE -o yaml | \
  python3 -c "
import yaml, sys, json
policies = yaml.safe_load(sys.stdin)
for item in policies.get('items', []):
    selector = item['spec']['podSelector'].get('matchLabels', {})
    print(f'{item[\"metadata\"][\"name\"]}: {json.dumps(selector)}')
"

# OPA/Kyverno: check which policies are denying traffic
kubectl get ciliumnetworkpolicy -A
```

## Section 11: Network Namespace Performance Tuning

```bash
# Check current network namespace settings in a pod
kubectl exec $POD_NAME -- sysctl -a | grep -E "net.core|net.ipv4.tcp"

# Key tuning parameters (set in pod SecurityContext or node)
sysctl net.core.somaxconn          # Max listen backlog
sysctl net.ipv4.tcp_max_syn_backlog  # SYN backlog
sysctl net.core.rmem_max          # Max socket receive buffer
sysctl net.core.wmem_max          # Max socket send buffer

# For high-throughput pods, set via pod spec
apiVersion: v1
kind: Pod
spec:
  initContainers:
    - name: sysctl-setup
      image: busybox
      command:
        - sh
        - -c
        - |
          sysctl -w net.core.somaxconn=65535
          sysctl -w net.ipv4.tcp_max_syn_backlog=65535
          sysctl -w net.core.rmem_max=16777216
          sysctl -w net.core.wmem_max=16777216
      securityContext:
        privileged: true
```

## Section 12: Building a Container Network from Scratch

A complete working example that replicates what a CNI plugin does:

```bash
#!/bin/bash
# setup-container-network.sh
# Creates a complete isolated network for a container

set -euo pipefail

CONTAINER_ID=${1:-"demo"}
CONTAINER_IP="172.30.0.10"
HOST_IP="172.30.0.1"
SUBNET="172.30.0.0/24"
BRIDGE="cni-demo"
NETNS="ns-${CONTAINER_ID}"
VETH_HOST="veth-${CONTAINER_ID}-h"
VETH_CONT="veth-${CONTAINER_ID}-c"

echo "=== Setting up container network ==="

# Step 1: Create network namespace
echo "Creating network namespace: $NETNS"
ip netns add "$NETNS"

# Step 2: Create bridge (if not exists)
if ! ip link show "$BRIDGE" &>/dev/null; then
    echo "Creating bridge: $BRIDGE"
    ip link add "$BRIDGE" type bridge
    ip link set "$BRIDGE" type bridge forward_delay 0
    ip link set "$BRIDGE" type bridge stp_state 0
    ip addr add "${HOST_IP}/24" dev "$BRIDGE"
    ip link set "$BRIDGE" up
fi

# Step 3: Create veth pair
echo "Creating veth pair: $VETH_HOST <-> $VETH_CONT"
ip link add "$VETH_HOST" type veth peer name "$VETH_CONT"

# Step 4: Attach host end to bridge
echo "Attaching $VETH_HOST to bridge $BRIDGE"
ip link set "$VETH_HOST" master "$BRIDGE"
ip link set "$VETH_HOST" up

# Step 5: Move container end to namespace
echo "Moving $VETH_CONT to namespace $NETNS"
ip link set "$VETH_CONT" netns "$NETNS"

# Step 6: Configure container network
echo "Configuring container network"
ip netns exec "$NETNS" ip link set lo up
ip netns exec "$NETNS" ip link set "$VETH_CONT" name eth0
ip netns exec "$NETNS" ip addr add "${CONTAINER_IP}/24" dev eth0
ip netns exec "$NETNS" ip link set eth0 up
ip netns exec "$NETNS" ip route add default via "$HOST_IP"

# Step 7: Enable forwarding and NAT
echo "Enabling IP forwarding and NAT"
echo 1 > /proc/sys/net/ipv4/ip_forward
iptables -t nat -C POSTROUTING -s "$SUBNET" ! -o "$BRIDGE" -j MASQUERADE 2>/dev/null || \
    iptables -t nat -A POSTROUTING -s "$SUBNET" ! -o "$BRIDGE" -j MASQUERADE

iptables -C FORWARD -i "$BRIDGE" -j ACCEPT 2>/dev/null || \
    iptables -A FORWARD -i "$BRIDGE" -j ACCEPT
iptables -C FORWARD -o "$BRIDGE" -j ACCEPT 2>/dev/null || \
    iptables -A FORWARD -o "$BRIDGE" -j ACCEPT

echo ""
echo "=== Container network configured ==="
echo "Container namespace: $NETNS"
echo "Container IP: $CONTAINER_IP"
echo "Host IP (gateway): $HOST_IP"
echo ""
echo "Test with:"
echo "  ip netns exec $NETNS ip addr"
echo "  ip netns exec $NETNS ping -c 3 $HOST_IP"
echo "  ip netns exec $NETNS ping -c 3 8.8.8.8"
echo ""
echo "Run commands in container:"
echo "  ip netns exec $NETNS bash"
echo ""
echo "Cleanup:"
echo "  ip netns del $NETNS"
echo "  ip link del $VETH_HOST"
```

```bash
# Run the setup
sudo bash setup-container-network.sh demo

# Test connectivity
sudo ip netns exec ns-demo ping -c 3 8.8.8.8

# Run a service in the isolated network namespace
sudo ip netns exec ns-demo python3 -m http.server 8080 &

# Access it from the host
curl http://172.30.0.10:8080

# Expose it externally (port mapping)
sudo iptables -t nat -A PREROUTING -p tcp --dport 28080 -j DNAT --to-destination 172.30.0.10:8080
sudo iptables -A FORWARD -p tcp -d 172.30.0.10 --dport 8080 -j ACCEPT

# Now accessible from outside the host
curl http://HOST_EXTERNAL_IP:28080
```

## Summary

Linux network namespaces are the fundamental building block of container networking. The full picture from kernel primitive to running Kubernetes Pod is:

1. **Network namespaces** provide isolation: each pod gets its own network stack, routing table, and iptables rules

2. **veth pairs** connect namespaces: one end in the pod namespace, one end in the root namespace (attached to a bridge or directly routed)

3. **Bridge devices** enable communication between multiple containers on the same host, functioning like a virtual switch

4. **iptables/nftables** implement port mapping (DNAT for incoming traffic, MASQUERADE for outgoing NAT), Kubernetes Service load balancing, and NetworkPolicy enforcement

5. **CNI plugins** automate the entire setup sequence as a standardized interface: the container runtime (containerd) calls the CNI plugin with the namespace path, and the plugin creates the veth pair, configures IP addresses, sets up routes, and returns the assigned IP

6. **Overlay networks** (Flannel VXLAN, Weave) encapsulate pod-to-pod traffic to traverse node-to-node, while **underlay networks** (Calico BGP, Cilium with direct routing) avoid encapsulation overhead

Understanding this stack enables debugging network connectivity at any layer: from verifying iptables rules inside a namespace with `nsenter` to capturing packets on the host veth interface with tcpdump, to tracing eBPF programs with Cilium's monitor.
