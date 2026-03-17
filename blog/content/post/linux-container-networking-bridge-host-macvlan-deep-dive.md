---
title: "Linux Container Networking Deep Dive: Bridge Mode, Host Mode, and Macvlan"
date: 2030-10-10T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Containers", "Kubernetes", "CNI", "iptables", "Macvlan"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Container networking internals: Linux bridge packet flow, host-mode networking for performance, macvlan and ipvlan for direct network access, container-to-container communication paths, and choosing networking modes for different Kubernetes workloads."
more_link: "yes"
url: "/linux-container-networking-bridge-host-macvlan-deep-dive/"
---

Every container networking mode ultimately relies on a small set of Linux kernel primitives: network namespaces, virtual ethernet pairs, Linux bridges, iptables/nftables, and in newer deployments, eBPF programs that replace much of the traditional netfilter path. Understanding these primitives explains why certain networking choices perform better and what trade-offs come with each mode.

<!--more-->

## Linux Network Namespaces

A network namespace (netns) provides complete isolation of network stack state: interfaces, routes, iptables rules, and sockets. When a container is created, it receives its own network namespace.

### Observing Network Namespaces

```bash
# List all network namespaces
ip netns list

# Kubernetes creates namespaces for pods
ls /var/run/netns/
# cni-1a2b3c4d-...    (created by CNI plugin for each pod)

# Get the network namespace for a running container
CONTAINER_ID="abc123"
PID=$(docker inspect -f '{{.State.Pid}}' $CONTAINER_ID)

# View the container's interfaces from its namespace
nsenter --net=/proc/$PID/ns/net -- ip addr show
nsenter --net=/proc/$PID/ns/net -- ip route show
nsenter --net=/proc/$PID/ns/net -- ss -tunp

# Create a network namespace manually
ip netns add test-ns

# Execute commands in it
ip netns exec test-ns ip addr show
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN
# ...

# Delete it
ip netns del test-ns
```

---

## Bridge Mode Networking: The Full Packet Path

The bridge mode is the default for Docker and many Kubernetes CNI plugins. Understanding its full packet path reveals where latency and overhead come from.

### Creating a Bridge Network Manually

```bash
# Create a Linux bridge
ip link add docker0 type bridge
ip addr add 172.17.0.1/16 dev docker0
ip link set docker0 up

# Enable IP forwarding (required for container internet access)
sysctl -w net.ipv4.ip_forward=1

# Create a network namespace (simulating a container)
ip netns add container1

# Create a veth pair: one end goes in the container, one stays on the host
ip link add veth0 type veth peer name veth1

# Move veth1 into the container's network namespace
ip link set veth1 netns container1

# Connect the host end (veth0) to the bridge
ip link set veth0 master docker0
ip link set veth0 up

# Configure the container side
ip netns exec container1 ip link set veth1 name eth0
ip netns exec container1 ip addr add 172.17.0.2/16 dev eth0
ip netns exec container1 ip link set eth0 up
ip netns exec container1 ip link set lo up
ip netns exec container1 ip route add default via 172.17.0.1

# Test connectivity
ip netns exec container1 ping -c 3 172.17.0.1
ip netns exec container1 ping -c 3 8.8.8.8  # Requires NAT (next section)
```

### Packet Flow for Bridge Mode

```
Container1 (172.17.0.2)           Container2 (172.17.0.3)
        │                                  │
      eth0                               eth0
  (veth1 - container ns)           (veth3 - container ns)
        │                                  │
      veth0                              veth2
  (host ns)                          (host ns)
        │                                  │
        └──────────────┬───────────────────┘
                       │
                   docker0 bridge
                   172.17.0.1/16
                       │
                 (iptables FORWARD)
                       │
                 Physical NIC (eth0)
                 192.168.1.100/24
                       │
                   Physical Network
```

For container1 → container2 (same bridge):

1. Packet leaves container1's eth0 → enters veth0 on host
2. Kernel delivers to docker0 bridge (same L2 domain)
3. Bridge ARP lookup finds container2's MAC → veth2
4. Packet forwarded to veth2 → delivered to container2's eth0
5. **No iptables FORWARD rules hit for same-bridge traffic** (by default)

For container1 → internet (NAT):

```bash
# Add NAT rule (masquerade outbound traffic)
iptables -t nat -A POSTROUTING \
  -s 172.17.0.0/16 \
  ! -o docker0 \
  -j MASQUERADE

# Allow forwarding from bridge to external interface
iptables -A FORWARD -i docker0 ! -o docker0 -j ACCEPT
iptables -A FORWARD -o docker0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# Verify
iptables -t nat -L POSTROUTING -n -v
ip netns exec container1 curl -s https://api.ipify.org
```

### Service Port Publishing (DNAT)

```bash
# Publish container port 80 on host port 8080
iptables -t nat -A PREROUTING \
  -p tcp \
  --dport 8080 \
  -j DNAT \
  --to-destination 172.17.0.2:80

# Allow the forwarded traffic
iptables -A FORWARD \
  -d 172.17.0.2 \
  -p tcp \
  --dport 80 \
  -j ACCEPT

# Test
curl http://localhost:8080/
```

### Bridge Mode Performance Characteristics

```bash
# Measure overhead: container-to-container on same bridge
# vs host-to-host (no container overhead)

# Install iperf3
apt-get install -y iperf3

# Baseline: host to host
iperf3 -s -D
iperf3 -c 192.168.1.100

# Container to container (same node, same bridge)
docker run -d --name iperf-server networkstatic/iperf3 -s
docker run --rm networkstatic/iperf3 -c iperf-server

# Typical results:
# Host-to-host: ~90-95 Gbps (limited by loopback)
# Bridge mode container-to-container: ~40-60 Gbps
# Overhead: ~30-50% for CPU-bound scenarios
```

---

## Host Mode Networking

In host mode, the container shares the host's network namespace directly. No veth pair, no bridge, no NAT — just the host's interfaces.

```bash
# Docker host mode
docker run --network host nginx

# Kubernetes host network pod
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: host-net-pod
spec:
  hostNetwork: true
  containers:
    - name: nginx
      image: nginx
      ports:
        - containerPort: 80
          hostPort: 80
EOF
```

### When to Use Host Mode

Host mode eliminates the veth overhead and NAT, making it ideal for:

1. **High-throughput data plane applications**: DPDK-based routers, packet processors
2. **Monitoring agents**: Need to observe host-level network state
3. **Performance-sensitive UDP workloads**: Gaming servers, media streaming
4. **kube-proxy replacement candidates**: Cilium in kube-proxy-replacement mode

```bash
# Verify host mode pod sees host interfaces
kubectl exec host-net-pod -- ip addr show
# Should show same output as running 'ip addr show' on the node

# Measure performance improvement
# Container in host mode accessing external service vs bridge mode
kubectl exec host-net-pod -- iperf3 -c 192.168.1.200 -t 30
```

### Host Mode Security Considerations

Host mode bypasses all network namespace isolation. A compromised pod can:
- Listen on arbitrary host ports (including privileged ports < 1024)
- Access all host network interfaces
- See all host network connections via `/proc/net/`

```yaml
# Restrict host network pods via PodSecurity admission
apiVersion: v1
kind: Namespace
metadata:
  name: host-network-workloads
  labels:
    pod-security.kubernetes.io/enforce: baseline
    # baseline does NOT allow hostNetwork
    # Only privileged level allows it
```

---

## Macvlan Networking

Macvlan creates virtual interfaces that have their own MAC addresses and appear as separate hosts on the physical network. The host's physical NIC acts as a trunk interface.

### Macvlan Modes

| Mode | Behavior |
|---|---|
| `bridge` | Containers can communicate with each other and external hosts |
| `passthru` | Only one virtual interface; good for SR-IOV |
| `private` | Containers isolated from each other |
| `vepa` | Traffic hairpins through external switch for filtering |

### Creating Macvlan Interfaces

```bash
# Physical interface: eth0 with IP 192.168.1.100/24
# Gateway: 192.168.1.1

# Create a macvlan parent on the host
ip link add macvlan0 link eth0 type macvlan mode bridge
ip addr add 192.168.1.200/24 dev macvlan0
ip link set macvlan0 up

# Route traffic to the macvlan subnet via the macvlan interface
ip route add 192.168.1.0/24 dev macvlan0

# Create a macvlan interface for a container
ip netns add container-macvlan

ip link add macvlan1 link eth0 type macvlan mode bridge
ip link set macvlan1 netns container-macvlan

ip netns exec container-macvlan ip link set macvlan1 name eth0
ip netns exec container-macvlan ip addr add 192.168.1.201/24 dev eth0
ip netns exec container-macvlan ip link set eth0 up
ip netns exec container-macvlan ip route add default via 192.168.1.1

# Test: container can now communicate on the physical network directly
ip netns exec container-macvlan ping -c 3 192.168.1.1
ip netns exec container-macvlan curl http://192.168.1.50/

# IMPORTANT: Container (192.168.1.201) CANNOT ping host (192.168.1.100)
# because macvlan interfaces can't communicate with their parent interface
# This is a kernel-level restriction, not a routing issue
```

### Macvlan with Docker

```bash
# Create Docker macvlan network
docker network create \
  --driver macvlan \
  --subnet=192.168.1.0/24 \
  --gateway=192.168.1.1 \
  --ip-range=192.168.1.192/27 \
  -o parent=eth0 \
  macvlan-net

# Launch a container on the macvlan network
docker run -d \
  --network macvlan-net \
  --ip 192.168.1.195 \
  --name web-server \
  nginx

# Verify the container has a unique MAC on the physical network
docker exec web-server ip addr show eth0
# inet 192.168.1.195/24 brd 192.168.1.255 scope global eth0
# MAC: 02:42:c0:a8:01:c3  (unique MAC)

# The container appears as a distinct host to the physical network switch
arp -a | grep "192.168.1.195"
```

### CNI Macvlan Plugin for Kubernetes

```yaml
# /etc/cni/net.d/10-macvlan.conf
{
    "cniVersion": "0.4.0",
    "name": "macvlan-net",
    "type": "macvlan",
    "master": "eth0",
    "mode": "bridge",
    "ipam": {
        "type": "host-local",
        "subnet": "192.168.1.0/24",
        "rangeStart": "192.168.1.200",
        "rangeEnd": "192.168.1.250",
        "gateway": "192.168.1.1",
        "routes": [
            {"dst": "0.0.0.0/0"}
        ]
    }
}
```

---

## IPvlan: Macvlan Without Unique MACs

IPvlan is similar to macvlan but all virtual interfaces share the parent's MAC address. The kernel routes based on IP address rather than MAC, eliminating the ARP table explosion problem on networks with MAC address limits.

```bash
# IPvlan L2 mode: containers on same L2 segment (similar to macvlan bridge)
ip link add ipvlan0 link eth0 type ipvlan mode l2

# IPvlan L3 mode: host acts as router for containers
# Eliminates ARP entirely — no ARP for container IPs on physical network
ip link add ipvlan0 link eth0 type ipvlan mode l3

# Create namespace and configure IPvlan for a container
ip netns add container-ipvlan

ip link add ipvlan1 link eth0 type ipvlan mode l3
ip link set ipvlan1 netns container-ipvlan

ip netns exec container-ipvlan ip link set ipvlan1 name eth0
ip netns exec container-ipvlan ip addr add 192.168.100.1/32 dev eth0
ip netns exec container-ipvlan ip link set eth0 up

# Add a host route pointing to the container
ip route add 192.168.100.1 dev eth0
```

---

## Container-to-Container Communication Paths

Different scenarios have different networking paths:

### Same Pod (Kubernetes)

Containers within the same pod share a network namespace. They communicate via loopback (127.0.0.1) — no kernel overhead beyond loopback processing.

```bash
# In a multi-container pod, containers see each other on localhost
kubectl exec multi-container-pod -c sidecar -- \
  curl http://localhost:8080/health
```

### Same Node, Different Pods

Traffic traverses the veth pair and bridge:

```
Pod1 (eth0 → veth0) → cbr0 bridge → (veth2 → eth0) Pod2
                    ↑
              iptables FORWARD
```

```bash
# Measure latency: same-node pod-to-pod
kubectl exec sender-pod -- ping -c 100 $(kubectl get pod receiver-pod -o jsonpath='{.status.podIP}') | \
  tail -3
# rtt min/avg/max/mdev = 0.043/0.065/0.123/0.015 ms
```

### Different Nodes

Traffic leaves the source node, traverses the overlay network (VXLAN, Geneve, WireGuard, etc.), arrives at the destination node, and follows the same bridge path to the destination pod.

```bash
# Measure cross-node pod latency
# VXLAN adds ~50-200 µs overhead depending on hardware

# Check if VXLAN is in use
kubectl exec netshoot-debug -- ip -d link show | grep vxlan

# View VXLAN FDB (forwarding database)
bridge fdb show dev flannel.1

# Check overlay encapsulation overhead
kubectl exec netshoot-debug -- traceroute target-pod-ip
```

---

## Network Performance Analysis

### Measuring Throughput Between Pods

```bash
# Deploy iperf3 server pod
kubectl run iperf-server \
  --image=networkstatic/iperf3 \
  --port=5201 \
  -- -s

# Get server pod IP
SERVER_IP=$(kubectl get pod iperf-server -o jsonpath='{.status.podIP}')

# Test throughput (same node vs cross-node)
kubectl run iperf-client \
  --image=networkstatic/iperf3 \
  --restart=Never \
  --rm \
  -it \
  -- -c $SERVER_IP -t 30 -P 4

# Expected results (rough benchmarks, vary by hardware):
# Same node, bridge:   ~35-50 Gbps
# Cross-node, VXLAN:   ~8-20 Gbps
# Cross-node, WireGuard: ~4-8 Gbps (encryption overhead)
# Host network mode:   ~80-95 Gbps
```

### Identifying Network Bottlenecks

```bash
# Check interface statistics on node
watch -n 1 "ip -s link show | grep -A5 'eth0\|cbr0\|flannel'"

# Check for drops
ip -s link show eth0 | grep -A2 "RX errors\|TX errors"

# Check conntrack table utilization
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# conntrack overflow causes packet drops — increase if near limit
sysctl -w net.netfilter.nf_conntrack_max=1048576
echo "net.netfilter.nf_conntrack_max = 1048576" >> /etc/sysctl.d/99-conntrack.conf

# Check TX queue length
ip link show eth0 | grep qlen
# qlen 1000  — increase for high-throughput workloads
ip link set eth0 txqueuelen 10000
```

---

## Choosing Networking Mode for Kubernetes Workloads

| Workload | Recommended Mode | Reason |
|---|---|---|
| Standard microservices | Bridge (default CNI) | Good isolation, standard tooling |
| High-throughput data ingestion | Macvlan or Host | Eliminate NAT and bridge overhead |
| Network monitoring/security agents | Host | Full host network visibility |
| Database pods | Bridge with dedicated node | Predictable latency |
| Latency-sensitive trading systems | Host or SR-IOV | Sub-100µs requirements |
| Multi-tenant SaaS | Bridge with NetworkPolicy | Isolation between tenants |
| Service mesh sidecars | Bridge with eBPF bypass | mTLS without kernel NAT overhead |

### Cilium eBPF: Replacing the Bridge

Cilium replaces iptables and the Linux bridge with eBPF programs, significantly reducing CPU overhead for high-throughput clusters:

```bash
# Check Cilium's datapath mode
kubectl exec -n kube-system daemonset/cilium -- cilium-dbg status | \
  grep -E "Masquerading|KubeProxyReplacement"

# Enable kube-proxy-replacement (eliminates kube-proxy entirely)
# In Cilium Helm values:
# kubeProxyReplacement: true
# k8sServiceHost: <api-server-ip>
# k8sServicePort: 6443

# Verify bypass
kubectl exec -n kube-system daemonset/cilium -- \
  cilium-dbg status --verbose | grep "NodePort"

# Test: no iptables rules for services (everything in eBPF)
iptables-save | grep KUBE-SERVICES | wc -l
# 0  (if Cilium kube-proxy-replacement is active)
```

---

## Practical Diagnostics

```bash
# Find which bridge a pod's veth is connected to
function find_pod_veth() {
    local pod=$1
    local ns=${2:-default}
    local pod_ip=$(kubectl get pod $pod -n $ns -o jsonpath='{.status.podIP}')
    arp -n $pod_ip 2>/dev/null | awk '{print $5}'
}

# Show all bridge connections
brctl show

# Show which VLANs are active on a bridge
bridge vlan show

# Test MTU consistency (common source of mysterious failures)
kubectl exec netshoot-pod -- ping -M do -s 1450 target-pod-ip
# If this fails: MTU mismatch between bridge (1500) and overlay (1450 for VXLAN)

# Find the effective MTU in a pod
kubectl exec mypod -- cat /sys/class/net/eth0/mtu

# Check for PMTU discovery issues
kubectl exec mypod -- curl -v --max-time 10 https://api.example.com
# Hangs at HTTPS? May be ICMP fragmentation-needed being dropped by firewall
```

Understanding these networking primitives provides the foundation for diagnosing production issues across any container platform — whether the CNI plugin is Flannel, Calico, Cilium, or a cloud-native implementation like AWS VPC CNI or GKE's native networking.
