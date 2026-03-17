---
title: "Kubernetes Network Debugging: tcpdump, Wireshark, eBPF Packet Capture, and CNI Troubleshooting"
date: 2028-08-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "tcpdump", "eBPF", "Debugging", "CNI"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes network debugging covering tcpdump and Wireshark packet capture in containers, eBPF-based network tracing, CNI plugin troubleshooting, DNS debugging, network policy analysis, and systematic diagnostic workflows for production network issues."
more_link: "yes"
url: "/kubernetes-network-debugging-tcpdump-ebpf-guide/"
---

Network issues in Kubernetes are among the most disruptive and hardest to debug. The combination of virtual network interfaces, overlay networks, network policies, service proxies (kube-proxy or eBPF), and DNS makes the network stack deep enough that simple tools like `ping` and `curl` often can't tell you what's actually broken.

Effective Kubernetes network debugging requires understanding the packet path from source to destination, capturing traffic at the right point in that path, and using the right tool for the layer where the problem lives. This guide covers the full toolkit: tcpdump in containers, Wireshark analysis, eBPF packet capture with Cilium and bpftrace, CNI troubleshooting, DNS debugging, and systematic diagnostic workflows.

<!--more-->

# Kubernetes Network Debugging: tcpdump, Wireshark, eBPF Packet Capture, and CNI Troubleshooting

## Section 1: Kubernetes Network Model

Before debugging, understand what you're debugging. The Kubernetes network model has these invariants:

1. Every pod gets its own IP address (no NAT between pods on the same cluster)
2. Pods on any node can communicate with pods on any other node without NAT
3. Agents on a node (kubelet, system daemons) can communicate with all pods on that node
4. Service IPs are virtual — they only exist in iptables/eBPF rules, never on a real interface

The packet path for a pod-to-pod call:

```
Pod A (10.0.1.5)
  └── veth pair → cni0/eth0 bridge
      └── tunnel (VXLAN/IPIP/BGP) or direct route
          └── cni0 bridge → veth pair
              └── Pod B (10.0.2.8)
```

Service to pod path:

```
Pod A → Service IP (10.96.0.1:443)
  └── kube-proxy (iptables DNAT) or Cilium eBPF
      └── Selected pod endpoint IP:port
          └── Routed as pod-to-pod
```

## Section 2: tcpdump in Kubernetes

Capturing traffic in containers is the first debugging tool to reach for when you suspect a network problem.

### Capture Inside a Running Container

```bash
# Method 1: kubectl exec into the container
# Most production containers don't have tcpdump — use this approach
kubectl exec -it -n production pods/api-server-7d4b9f -- \
  sh -c "apt-get install -y tcpdump 2>/dev/null || apk add tcpdump 2>/dev/null; \
         tcpdump -i eth0 -w - 2>/dev/null" | \
  wireshark -k -i -

# Method 2: Use a debugging sidecar (ephemeral container, k8s 1.23+)
kubectl debug -it -n production pods/api-server-7d4b9f \
  --image=nicolaka/netshoot \
  --target=api-server
# Inside the ephemeral container:
tcpdump -i eth0 -nn -v 'port 8080' -w /tmp/capture.pcap

# Copy capture out
kubectl cp production/api-server-7d4b9f:/tmp/capture.pcap ./capture.pcap -c debugger

# Method 3: Capture on the node using the pod's network namespace
# Get the container's network namespace path
POD_UID=$(kubectl get pod api-server-7d4b9f -n production -o jsonpath='{.metadata.uid}')
NODE=$(kubectl get pod api-server-7d4b9f -n production -o jsonpath='{.spec.nodeName}')
echo "Pod is on node: ${NODE}"

# SSH to the node, then:
# Find the veth interface for the pod
CONTAINER_ID=$(kubectl get pod api-server-7d4b9f -n production \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's/containerd:\/\///')

# Get network namespace
NETNS=$(nsenter --target $(crictl inspect ${CONTAINER_ID} | \
  jq -r '.info.pid') --net /bin/sh -c 'ls -la /proc/self/ns/net' | \
  awk '{print $NF}')

# Find the veth pair (host side)
# Look for the interface that pairs with the container's eth0
ip link | grep -B1 "veth" | grep -v veth
```

### Practical tcpdump Commands

```bash
# Inside the pod/ephemeral container:

# Capture all traffic on eth0
tcpdump -i eth0 -nn -v

# Capture HTTP traffic
tcpdump -i eth0 -nn -A 'tcp port 80 or tcp port 8080'

# Capture DNS queries and responses
tcpdump -i eth0 -nn 'port 53'
# -nn: don't resolve hostnames (avoids DNS during DNS debugging)

# Capture traffic to a specific destination
tcpdump -i eth0 -nn 'dst host 10.96.0.10'  # kube-dns service IP

# Capture TCP connection issues (SYN, SYN-ACK, RST, FIN)
tcpdump -i eth0 -nn 'tcp[tcpflags] & (tcp-syn|tcp-rst|tcp-fin) != 0'

# Capture ICMP (for ping debugging)
tcpdump -i eth0 -nn icmp

# Save to file for Wireshark analysis
tcpdump -i eth0 -nn -w /tmp/capture.pcap -C 100 -W 5
# -C 100: rotate when file reaches 100MB
# -W 5:  keep max 5 files (500MB total)

# Capture with timestamps and verbose protocol decode
tcpdump -i eth0 -ttttnn -vvv 'port 8080'
```

### Capturing on the Node (Host Network Interfaces)

```bash
# Capture on the CNI bridge (sees all pod traffic on the node)
tcpdump -i cni0 -nn

# Capture on a specific VXLAN tunnel (overlay traffic)
tcpdump -i vxlan.calico -nn

# Capture on the Wireguard tunnel (Cilium with encryption)
tcpdump -i cilium_wg0 -nn

# Capture on the flannel interface
tcpdump -i flannel.1 -nn

# List all network interfaces on the node
ip link show
ls /sys/class/net/

# Find the veth interface for a specific pod
# (Maps pod IP to veth interface)
ARP_TABLE=$(ip neigh show)
POD_IP="10.0.1.42"
echo "${ARP_TABLE}" | grep "${POD_IP}"
# 10.0.1.42 dev veth1234abcd lladdr aa:bb:cc:dd:ee:ff REACHABLE

tcpdump -i veth1234abcd -nn  # Capture only that pod's traffic
```

## Section 3: Wireshark Analysis

### Useful Wireshark Display Filters for Kubernetes

```
# HTTP analysis
http.response.code >= 400                    # HTTP errors
http.request.method == "POST"                # POST requests
http contains "X-Request-ID"                 # Requests with correlation headers

# DNS analysis
dns.flags.response == 0                      # DNS queries only
dns.flags.response == 1 && dns.flags.rcode != 0  # Failed DNS responses
dns.qry.name contains "svc.cluster.local"    # Kubernetes service DNS

# TCP analysis
tcp.flags.reset == 1                         # TCP resets (connections being killed)
tcp.flags.syn == 1 && tcp.flags.ack == 0     # New connection attempts
tcp.analysis.retransmission                  # Retransmissions (packet loss)
tcp.analysis.zero_window                     # Zero window (backpressure)
tcp.analysis.connection_lost                 # Lost connections

# TLS analysis
tls.handshake.type == 1                      # Client Hello
tls.alert_message.desc != 0                  # TLS alerts

# VXLAN/overlay
vxlan.vni == 1                               # Specific VXLAN network ID

# Filter by pod IP
ip.addr == 10.0.1.42                         # All traffic to/from pod
ip.src == 10.0.1.42 && tcp.flags.reset == 1  # RSTs from this pod
```

### Analyzing a TCP Reset Capture

```bash
# In tshark (command-line Wireshark):

# Find all RST packets with context
tshark -r capture.pcap \
  -Y 'tcp.flags.reset == 1' \
  -T fields \
  -e frame.number \
  -e frame.time_relative \
  -e ip.src \
  -e ip.dst \
  -e tcp.srcport \
  -e tcp.dstport

# Analyze a specific TCP stream
tshark -r capture.pcap \
  -Y 'tcp.stream == 42' \
  -T fields \
  -e frame.time_relative \
  -e ip.src \
  -e ip.dst \
  -e tcp.flags \
  -e tcp.len

# Summarize HTTP response codes
tshark -r capture.pcap \
  -Y http.response \
  -T fields \
  -e http.response.code | \
  sort | uniq -c | sort -rn

# Measure HTTP round-trip times
tshark -r capture.pcap \
  -z "http,tree" \
  -q
```

## Section 4: eBPF-Based Network Debugging

eBPF provides observability at the kernel level without packet capture overhead. For Kubernetes clusters running Cilium or with bpftrace available, eBPF tools give far richer insight than tcpdump.

### bpftrace for Network Tracing

```bash
# Install bpftrace on the node
apt-get install -y bpftrace  # or: docker run --rm --privileged -it ubuntu bpftrace

# Trace all TCP connections from a specific pod
# (by network namespace)
POD_PID=$(crictl inspect ${CONTAINER_ID} | jq -r '.info.pid')

# Trace new TCP connections
bpftrace -e '
kprobe:tcp_v4_connect
{
    printf("PID %d connecting to %s:%d\n",
           pid,
           ntop(4, arg1),
           ntohs(*(uint16 *)(arg1 + 2)));
}
'

# Trace TCP state changes (helps identify connection drops)
bpftrace -e '
tracepoint:sock:inet_sock_set_state
/args->family == AF_INET/
{
    $oldstate = args->oldstate;
    $newstate = args->newstate;
    if ($newstate == TCP_CLOSE || $newstate == TCP_CLOSE_WAIT) {
        printf("TCP state change: %s:%d -> %s:%d  %d->%d\n",
               ntop(args->saddr), args->sport,
               ntop(args->daddr), args->dport,
               $oldstate, $newstate);
    }
}
'

# Trace DNS queries (raw UDP sends to port 53)
bpftrace -e '
kprobe:udp_sendmsg
{
    $sk = (struct sock *)arg0;
    $dport = $sk->__sk_common.skc_dport;
    if ($dport == 13568) { // 0x3500 = port 53 in big-endian
        printf("DNS query from PID %d comm %s\n", pid, comm);
    }
}
'

# Trace dropped packets (requires kernel with kfree_skb tracepoint)
bpftrace -e '
tracepoint:skb:kfree_skb
{
    printf("Packet dropped: reason=%d location=%s\n",
           args->reason,
           kstack(1));
}
' 2>/dev/null || echo "kfree_skb tracepoint not available"
```

### Cilium eBPF Network Debugging

Cilium exposes its eBPF networking state through the `cilium` CLI:

```bash
# Check Cilium status
kubectl exec -n kube-system cilium-xxxxx -- cilium status

# List endpoints (one per pod)
kubectl exec -n kube-system cilium-xxxxx -- cilium endpoint list

# Show policy for a specific endpoint
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium endpoint get 1234

# Monitor live packet events (extremely useful)
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium monitor --type drop
# Shows:
# POLICY_DENIED: policy drop
# CT_FORWARD: conntrack forward
# NAT_INGRESS: NAT table ingress

# Monitor drops with full context
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium monitor --type drop --from-endpoint 1234

# Trace a specific flow
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium monitor --type trace \
  --from-source "production/api-server" \
  --to-destination "production/database"

# Check BPF conntrack table
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium bpf ct list global | head -20

# Check BPF nat table
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium bpf nat list | head -20

# Verify network policy is installed correctly
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium policy get

# Run a connectivity test
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium connectivity test
```

### Hubble (Cilium Observability)

```bash
# Install Hubble CLI
curl -L --fail --remote-name-all \
  https://github.com/cilium/hubble/releases/download/v1.14.0/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe all flows
hubble observe

# Observe flows for a specific pod
hubble observe --namespace production --pod api-server

# Observe dropped flows
hubble observe --verdict DROPPED --namespace production

# Observe specific L7 protocol
hubble observe --protocol http --namespace production

# Status
hubble status

# Watch in real-time
hubble observe --follow --namespace production --pod api-server \
  --verdict DROPPED
```

### Pixie for eBPF-Based Full-Stack Observability

```bash
# Install Pixie (requires kernel 4.14+)
bash -c "$(curl -fsSL https://withpixie.ai/install.sh)"

# Deploy Pixie to cluster
px deploy

# Query HTTP traffic for a pod
px run px/http_data -- -start_time='-5m' \
  -namespace=production \
  -pod=api-server-7d4b9f

# Query DNS failures
px run px/dns_data -- -start_time='-5m' \
  -namespace=production

# Network graph
px run px/net_flow_graph -- -start_time='-5m' \
  -namespace=production
```

## Section 5: CNI Troubleshooting

### Calico Troubleshooting

```bash
# Check Calico node status
kubectl exec -n calico-system calico-node-xxxxx -- calicoctl node status

# Check BGP peers
kubectl exec -n calico-system calico-node-xxxxx -- calicoctl node status | \
  grep -A 5 "BGP"

# Verify Felix is healthy
kubectl exec -n calico-system calico-node-xxxxx -- \
  calico-node -bird-ready -felix-ready

# Show Calico IP pools
kubectl get ippools -o yaml

# Verify node has correct annotations
kubectl get node node1 -o yaml | grep "calico"

# Check Felix logs for policy drops
kubectl logs -n calico-system calico-node-xxxxx -c calico-node | \
  grep -i "deny\|drop\|blocked" | tail -20

# Check if Calico routes are installed
kubectl exec -n calico-system calico-node-xxxxx -- \
  ip route show | grep "blackhole\|via"

# Debug a specific pod connectivity
kubectl exec -n calico-system calico-node-xxxxx -- \
  calicoctl get workloadendpoint -n production --output yaml | \
  grep -A 20 "api-server"
```

### Flannel Troubleshooting

```bash
# Check flannel pod status
kubectl get pods -n kube-flannel

# Check flannel configuration
kubectl get configmap -n kube-flannel kube-flannel-cfg -o yaml

# Check flannel VXLAN routes
ip route show | grep flannel
ip route show | grep "via $(ip addr show flannel.1 | grep inet | awk '{print $2}' | cut -d/ -f1)"

# Verify VXLAN interface
ip -d link show flannel.1

# Check FDB (Forwarding Database) for VXLAN
bridge fdb show dev flannel.1

# Flannel logs
kubectl logs -n kube-flannel daemonset/kube-flannel-ds | grep -i "error\|fail" | tail -20
```

### General CNI Debugging

```bash
# Check CNI configuration files on the node
ls /etc/cni/net.d/
cat /etc/cni/net.d/10-calico.conflist  # or equivalent

# Check CNI binary installation
ls /opt/cni/bin/

# Test CNI manually (requires root on node)
# Get container netns
CONTAINER_ID="abc123"
NETNS=$(crictl inspect ${CONTAINER_ID} | jq -r '.info.runtimeSpec.linux.namespaces[] | select(.type=="network") | .path')

# Call the CNI ADD command
cat /etc/cni/net.d/10-calico.conflist | \
  CNI_COMMAND=CHECK \
  CNI_CONTAINERID=${CONTAINER_ID} \
  CNI_NETNS=${NETNS} \
  CNI_IFNAME=eth0 \
  CNI_PATH=/opt/cni/bin \
  /opt/cni/bin/calico

# Check IP allocation
cat /var/lib/cni/networks/cbr0/*  # Flannel
ls /var/lib/calico/nodename        # Calico
```

## Section 6: DNS Debugging

DNS issues in Kubernetes often look like connection issues. Before reaching for tcpdump, check DNS first.

### DNS Resolution Debugging

```bash
# Test DNS from a pod (using dnsutils)
kubectl run dns-test --rm -it --image=infoblox/dnstools -- /bin/sh
# Inside:
host kubernetes.default.svc.cluster.local
nslookup kubernetes.default.svc.cluster.local
dig kubernetes.default.svc.cluster.local +short
dig kubernetes.default.svc.cluster.local A +search +noall +answer

# Test from an existing pod
kubectl exec -it -n production api-server-7d4b9f -- \
  nslookup database.production.svc.cluster.local

# Check /etc/resolv.conf in a pod
kubectl exec -n production api-server-7d4b9f -- cat /etc/resolv.conf
# Expected:
# nameserver 10.96.0.10        <- kube-dns ClusterIP
# search production.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5

# Check DNS policy for a pod
kubectl get pod api-server-7d4b9f -n production -o yaml | \
  grep -A 5 dnsPolicy

# Verify CoreDNS is healthy
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50
```

### CoreDNS Debug Logging

```yaml
# Enable debug logging in CoreDNS
kubectl edit configmap coredns -n kube-system
# Add 'log' and 'errors' to the Corefile:
# .:53 {
#     errors
#     log             # <- Add this for verbose query logging
#     health
#     ready
#     ...
# }
```

```bash
# Watch CoreDNS logs for resolution failures
kubectl logs -n kube-system -l k8s-app=kube-dns -f | \
  grep -v "^$\|NOERROR\|INFO\|plugin/reload"

# Capture DNS traffic directly
kubectl exec -n kube-system coredns-xxxxx -- \
  sh -c "tcpdump -i any -nn 'port 53' -w /tmp/dns.pcap" &
sleep 10 && kill %1

# Check CoreDNS cache
kubectl exec -n kube-system coredns-xxxxx -- \
  sh -c "kill -USR1 1" # Dumps cache stats to log
```

### ndots and Search Domain Debugging

```bash
# The ndots:5 setting in Kubernetes causes external lookups to be tried
# with all search domains first, causing 5-6 DNS queries per external lookup.
# This is a common performance issue.

# Test the search domain expansion
dig +search example.com @10.96.0.10
# Shows all search domain attempts

# Profile DNS resolution time
kubectl exec -n production api-server-7d4b9f -- \
  time nslookup google.com 2>&1

# Fix: use FQDN (trailing dot) or lower ndots in pod spec
```

```yaml
# pod-dns-config.yaml
apiVersion: v1
kind: Pod
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"    # Lower than default 5; reduces spurious searches
      - name: single-request-reopen  # Reduces issues with some resolvers
  dnsPolicy: ClusterFirst
```

## Section 7: Network Policy Debugging

### Testing Network Policy with netcat

```bash
# Test connectivity between pods
# In source pod:
kubectl exec -n production api-server-7d4b9f -- \
  nc -zv database.production.svc.cluster.local 5432
# Connected -> policy allows
# timeout/refused -> policy may be blocking

# Test all ports
for port in 80 443 3306 5432 6379 8080 9090; do
  echo -n "Port ${port}: "
  kubectl exec -n production api-server-7d4b9f -- \
    nc -zv -w 2 database.production.svc.cluster.local ${port} 2>&1 | \
    tail -1
done

# Test with nmap from netshoot
kubectl debug -it -n production pods/api-server-7d4b9f \
  --image=nicolaka/netshoot -- \
  nmap -p 1-10000 database.production.svc.cluster.local
```

### Analyzing Network Policies

```bash
# List all network policies in a namespace
kubectl get networkpolicies -n production -o yaml

# Check which policies apply to a pod
kubectl get networkpolicies -n production -o json | jq -r '
  .items[] |
  . as $policy |
  .spec.podSelector.matchLabels |
  to_entries[] |
  "\($policy.metadata.name): \(.key)=\(.value)"
'

# Cilium: show effective policy for a pod
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium endpoint list | grep "api-server"
# Get endpoint ID, then:
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium endpoint get <ENDPOINT_ID> | jq '.policy'

# Calico: check policy for a workload endpoint
kubectl exec -n calico-system calico-node-xxxxx -- \
  calicoctl get workloadendpoint \
  production.api-server-7d4b9f-eth0 -o yaml
```

### Network Policy Test Tool

```bash
#!/bin/bash
# netpol-test.sh
# Tests connectivity matrix between pods based on network policies

set -euo pipefail

SOURCE_NS="production"
SOURCE_POD="api-server-7d4b9f"
TARGETS=(
  "database.production:5432"
  "cache.production:6379"
  "metrics.monitoring:9090"
  "api.external-service:443"
)

echo "=== Network Connectivity Test ==="
echo "Source: ${SOURCE_NS}/${SOURCE_POD}"
echo ""

for target in "${TARGETS[@]}"; do
  host=$(echo "${target}" | cut -d: -f1)
  port=$(echo "${target}" | cut -d: -f2)

  result=$(kubectl exec -n "${SOURCE_NS}" "${SOURCE_POD}" -- \
    nc -zv -w 3 "${host}" "${port}" 2>&1 | tail -1 || true)

  if echo "${result}" | grep -q "succeeded\|open\|Connected"; then
    echo "  ALLOW: ${host}:${port}"
  else
    echo "  BLOCK: ${host}:${port} (${result})"
  fi
done
```

## Section 8: kube-proxy Debugging

```bash
# Check kube-proxy mode
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode

# List iptables rules for a service
SERVICE_IP=$(kubectl get svc my-service -n production -o jsonpath='{.spec.clusterIP}')
iptables -t nat -L KUBE-SERVICES -n | grep "${SERVICE_IP}"

# Show all endpoints for a service in iptables
iptables -t nat -L | grep "my-service\|KUBE-SVC"

# Check for iptables rules count (high count = performance issue)
iptables -t nat -L | wc -l
iptables -t filter -L | wc -l

# Check IPVS rules (if kube-proxy is in IPVS mode)
ipvsadm -Ln | grep -A 5 "${SERVICE_IP}"

# Debug service routing
kubectl get endpoints my-service -n production
# Empty endpoints = pod not ready / selector doesn't match

# Force kube-proxy to sync iptables
kubectl rollout restart daemonset kube-proxy -n kube-system
```

## Section 9: Complete Diagnostic Workflow

```bash
#!/bin/bash
# k8s-network-debug.sh
# Systematic network debugging workflow

set -euo pipefail

SOURCE_POD=${1:?Usage: $0 SOURCE_POD SOURCE_NS TARGET_HOST TARGET_PORT}
SOURCE_NS=${2:?}
TARGET_HOST=${3:?}
TARGET_PORT=${4:?}

echo "=== Kubernetes Network Debug ==="
echo "Source:  ${SOURCE_NS}/${SOURCE_POD}"
echo "Target:  ${TARGET_HOST}:${TARGET_PORT}"
echo ""

# Step 1: Verify pods exist and are running
echo "[1] Checking pod status..."
kubectl get pod "${SOURCE_POD}" -n "${SOURCE_NS}" -o wide
echo ""

# Step 2: Check DNS resolution
echo "[2] Testing DNS resolution..."
kubectl exec "${SOURCE_POD}" -n "${SOURCE_NS}" -- \
  nslookup "${TARGET_HOST}" 2>&1 || echo "  DNS FAILED"
echo ""

# Step 3: Ping (ICMP)
echo "[3] Testing ICMP (ping)..."
TARGET_IP=$(kubectl exec "${SOURCE_POD}" -n "${SOURCE_NS}" -- \
  nslookup "${TARGET_HOST}" 2>/dev/null | grep "Address:" | tail -1 | awk '{print $2}')
kubectl exec "${SOURCE_POD}" -n "${SOURCE_NS}" -- \
  ping -c 3 "${TARGET_IP}" 2>&1 || echo "  PING FAILED (may be blocked by NetworkPolicy)"
echo ""

# Step 4: TCP connection
echo "[4] Testing TCP connection..."
kubectl exec "${SOURCE_POD}" -n "${SOURCE_NS}" -- \
  nc -zv -w 5 "${TARGET_HOST}" "${TARGET_PORT}" 2>&1 || echo "  TCP CONNECTION FAILED"
echo ""

# Step 5: Check network policies
echo "[5] Checking NetworkPolicies..."
TARGET_POD_LABELS=$(kubectl get pod -n "$(echo ${TARGET_HOST} | cut -d. -f2)" \
  -l "app=$(echo ${TARGET_HOST} | cut -d. -f1)" \
  -o jsonpath='{.items[0].metadata.labels}' 2>/dev/null || echo "{}")
echo "  Target pod labels: ${TARGET_POD_LABELS}"
kubectl get networkpolicies -A | grep -v "No resources" || echo "  No NetworkPolicies found"
echo ""

# Step 6: Check service endpoints
echo "[6] Checking Service endpoints..."
SVC_NAME=$(echo "${TARGET_HOST}" | cut -d. -f1)
SVC_NS=$(echo "${TARGET_HOST}" | cut -d. -f2)
kubectl get endpoints "${SVC_NAME}" -n "${SVC_NS}" 2>/dev/null || \
  echo "  Service/Endpoints not found"
echo ""

# Step 7: Check kube-proxy iptables
echo "[7] Checking iptables rules..."
TARGET_SVC_IP=$(kubectl get svc "${SVC_NAME}" -n "${SVC_NS}" \
  -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "unknown")
echo "  Service IP: ${TARGET_SVC_IP}"
kubectl get node -o wide | head -3
echo ""

# Step 8: Start packet capture
echo "[8] Starting 30s packet capture..."
kubectl debug -it "${SOURCE_POD}" -n "${SOURCE_NS}" \
  --image=nicolaka/netshoot \
  --target="${SOURCE_POD%%-*}" -- \
  sh -c "tcpdump -i eth0 -nn -w /tmp/debug.pcap 'host ${TARGET_IP}' & sleep 30; kill %1" || true
echo ""

echo "=== Debug Complete ==="
echo ""
echo "Next steps if connection failed:"
echo "1. Check NetworkPolicies with: kubectl get netpol -n ${SOURCE_NS}"
echo "2. Check Cilium drops with: kubectl exec -n kube-system cilium-XXXXX -- cilium monitor --type drop"
echo "3. Check service selector matches pod labels"
echo "4. Check pod readiness probe is passing"
```

## Section 10: Packet Loss and Latency Analysis

```bash
# Measure packet loss between nodes
NODE1_IP="10.0.1.1"
NODE2_IP="10.0.1.2"

# From a pod on node1, ping a pod on node2
kubectl run ping-test --rm -it \
  --overrides='{"spec": {"nodeName": "'${NODE1_IP}'"}}' \
  --image=alpine -- \
  ping -c 100 -i 0.1 ${NODE2_IP}

# Track MTU issues (can cause packet drops for large payloads)
# Maximum Transmission Unit on overlay networks is typically reduced by encap overhead
# VXLAN: reduces MTU by 50 bytes (VXLAN header)
# WireGuard: reduces MTU by 80 bytes

# Check MTU
kubectl exec -n production api-server-7d4b9f -- ip link show eth0
# link/ether ... mtu 1450 ...
# Default is 1500; overlay reduces this

# Test with specific payload size
kubectl exec -n production api-server-7d4b9f -- \
  ping -c 5 -M do -s 1400 database.production  # -M do = don't fragment

# Measure latency with hping3
kubectl debug -it -n production pods/api-server-7d4b9f \
  --image=nicolaka/netshoot -- \
  hping3 --count 100 --interval u10000 \
  --syn -p 5432 database.production.svc.cluster.local

# Analyze bandwidth
kubectl debug -it -n production pods/api-server-7d4b9f \
  --image=nicolaka/netshoot -- \
  iperf3 -c database.production.svc.cluster.local -p 5201 -t 10
```

## Section 11: Prometheus Metrics for Network Issues

```bash
# Key metrics for network debugging

# kube-proxy iptables sync latency
rate(kubeproxy_sync_proxy_rules_duration_seconds_bucket[5m])

# Network policy drop rate (Cilium)
sum(rate(cilium_drop_count_total[5m])) by (reason)

# DNS resolution latency (CoreDNS)
histogram_quantile(0.99,
  sum(rate(coredns_dns_request_duration_seconds_bucket[5m])) by (le))

# DNS errors
sum(rate(coredns_dns_responses_total{rcode!="NOERROR"}[5m])) by (rcode)

# Container network receive errors
sum(rate(container_network_receive_errors_total[5m])) by (pod, namespace)

# Node network receive dropped
rate(node_network_receive_drop_total[5m])

# TCP retransmits (indicates packet loss)
rate(node_netstat_Tcp_RetransSegs[5m])

# TCP connection errors
rate(node_netstat_Tcp_AttemptFails[5m])
```

## Conclusion

Kubernetes network debugging is a layered discipline. The workflow that works consistently in production:

1. **Start with DNS**: Most "connection refused" or "no route to host" errors that confuse engineers are actually DNS failures. Check `nslookup` inside the pod before anything else.

2. **Check endpoints**: A service with empty endpoints (no matching pods, or pods not ready) explains connection failures without any network issue.

3. **Check NetworkPolicy**: If DNS resolves and endpoints exist, NetworkPolicy is the next candidate. Use `cilium monitor --type drop` or Calico flow logs.

4. **Capture traffic at the right layer**: For overlay networks, capture at the pod's `eth0` (sees decrypted pod traffic) rather than on the host's physical NIC (sees encapsulated traffic).

5. **Use eBPF for zero-overhead observability**: `hubble observe` and `cilium monitor` give flow-level visibility without the overhead and complexity of setting up pcap captures.

6. **kube-proxy is stateful**: When service endpoints change and traffic still routes to dead pods, `kubectl rollout restart daemonset kube-proxy` forces iptables sync.

7. **MTU mismatches cause intermittent large-payload failures**: Always check MTU when small requests work but large payloads fail silently.
