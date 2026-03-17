---
title: "Kubernetes Network Troubleshooting: A Systematic Methodology"
date: 2028-02-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "CNI", "Cilium", "Calico", "tcpdump", "DNS", "NetworkPolicy"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A systematic methodology for Kubernetes network troubleshooting covering CNI debugging for Calico, Cilium, and Flannel; ephemeral container packet capture; conntrack analysis; iptables tracing; DNS debugging; and NetworkPolicy testing."
more_link: "yes"
url: "/kubernetes-network-troubleshooting-guide-deep-dive/"
---

Network problems in Kubernetes are among the most difficult to diagnose because they span multiple layers: the application, the container network, the CNI plugin, the node network stack, and the underlying infrastructure. A successful troubleshooting methodology requires systematic layer-by-layer elimination, the right tools for each layer, and an understanding of how each CNI plugin implements pod networking. This guide provides a complete methodology for diagnosing Kubernetes network failures across all major CNI implementations.

<!--more-->

## Establishing a Baseline: The Connectivity Matrix

Before investigating failures, establish what connectivity is expected. Kubernetes networking guarantees:

1. Every pod can communicate with every other pod on any node without NAT
2. Every node can communicate with every pod without NAT
3. The pod IP that a pod sees for itself is the same IP that other pods see for it

Verify this baseline with a test pod:

```bash
# Deploy netshoot as a debug pod
kubectl run netshoot --image=nicolaka/netshoot \
  --restart=Never \
  --rm -it -- bash

# From netshoot, test pod-to-pod communication
# 1. Get target pod IP
TARGET_POD_IP=$(kubectl get pod target-pod -o jsonpath='{.status.podIP}')

# 2. Test basic connectivity
ping -c 3 "$TARGET_POD_IP"

# 3. Test TCP connectivity to a specific port
nc -zv "$TARGET_POD_IP" 8080

# 4. Test DNS resolution
nslookup kubernetes.default.svc.cluster.local
dig +short target-service.production.svc.cluster.local

# 5. Test cross-node connectivity
# Get pods on each node and test between nodes
kubectl get pods -o wide -n production
```

## CNI Debugging: Calico

Calico is the most widely used CNI. It provides a felix agent on each node and optional BGP routing via BIRD.

### Calico Component Health

```bash
# Check all Calico pods are running
kubectl get pods -n calico-system -o wide
kubectl get pods -n kube-system -l k8s-app=calico-node -o wide

# Check felix (per-node dataplane agent)
kubectl logs -n calico-system -l app=calico-node -c calico-node --tail=100 | grep -i error

# Check calico-kube-controllers
kubectl logs -n calico-system -l app=calico-kube-controllers --tail=50

# Check Calico node status
kubectl exec -n calico-system -it $(kubectl get pod -n calico-system \
  -l app=calico-node -o name | head -1) -- calico-node -status
```

### Felix Data Plane Debugging

```bash
# Enable felix debug logging (temporary)
kubectl patch felixconfiguration default --type=merge \
  --patch '{"spec":{"logSeverityScreen":"Debug"}}'

# Watch felix logs during connection attempt
kubectl logs -n calico-system -l app=calico-node -c calico-node -f | grep -i "felix"

# Check felix counters
kubectl exec -n calico-system -it <calico-node-pod> -- calico-node -bgp-summary

# Restore to Info after debugging
kubectl patch felixconfiguration default --type=merge \
  --patch '{"spec":{"logSeverityScreen":"Info"}}'
```

### Calico BGP Status

```bash
# Check BGP peer status on a specific node
NODE_POD=$(kubectl get pod -n calico-system -l app=calico-node \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n calico-system "$NODE_POD" -- birdcl show protocols
kubectl exec -n calico-system "$NODE_POD" -- birdcl show route

# Check if routes are being distributed
kubectl exec -n calico-system "$NODE_POD" -- birdcl show route count
```

### IP Pool and IPAM Status

```bash
# Check IP pool configuration
kubectl get ippool -o yaml

# Check IPAM allocation (requires calicoctl)
calicoctl ipam show --show-blocks

# Find which node owns a block
calicoctl ipam show --show-blocks | grep <pod-ip-prefix>

# Check for IP exhaustion
calicoctl ipam show
```

## CNI Debugging: Cilium

Cilium uses eBPF for packet processing and provides the most detailed observability of any CNI.

### Cilium Health Checks

```bash
# Install cilium CLI
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --remote-name-all \
  "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz"
tar xzvf cilium-linux-amd64.tar.gz
sudo mv cilium /usr/local/bin

# Check Cilium status
cilium status --wait

# Run connectivity test
cilium connectivity test --namespace cilium-test

# Check individual Cilium pods
kubectl get pods -n kube-system -l k8s-app=cilium -o wide
kubectl exec -n kube-system -it <cilium-pod> -- cilium status
```

### Cilium Endpoint and Policy Status

```bash
# List all Cilium-managed endpoints on a node
kubectl exec -n kube-system -it <cilium-pod> -- cilium endpoint list

# Get detailed endpoint info
kubectl exec -n kube-system -it <cilium-pod> -- cilium endpoint get <endpoint-id>

# Check policy enforcement for an endpoint
kubectl exec -n kube-system -it <cilium-pod> -- \
  cilium policy get --labels "k8s:io.kubernetes.pod.namespace=production"

# Test connectivity between two pods
kubectl exec -n kube-system -it <cilium-pod> -- \
  cilium connectivity test
```

### Cilium Packet Drop Monitoring

```bash
# Monitor dropped packets in real-time
kubectl exec -n kube-system -it <cilium-pod> -- cilium monitor --type drop

# Filter drops by source/destination
kubectl exec -n kube-system -it <cilium-pod> -- \
  cilium monitor --type drop --from-source <pod-ip>

# Get drop statistics
kubectl exec -n kube-system -it <cilium-pod> -- cilium metrics list | grep drop

# Check BPF map drops
kubectl exec -n kube-system -it <cilium-pod> -- \
  cilium bpf metrics list
```

### Hubble: Cilium's Network Observability Layer

```bash
# Enable Hubble
cilium hubble enable

# Port-forward Hubble UI
kubectl port-forward -n kube-system svc/hubble-ui 12000:80 &

# Use Hubble CLI to observe flows
hubble observe --namespace production --verdict DROPPED --last 100

# Filter by pod
hubble observe \
  --pod production/api-server \
  --port 8080 \
  --verdict DROPPED

# Observe all flows to a service
hubble observe \
  --to-service production/database \
  --verdict DROPPED
```

## CNI Debugging: Flannel

Flannel uses VXLAN or host-gw backends for simpler overlay networking.

```bash
# Check flannel pods
kubectl get pods -n kube-flannel -o wide
kubectl logs -n kube-flannel -l app=flannel --tail=50

# Check flannel subnet leases
kubectl get events -n kube-flannel

# Verify VXLAN interface on node
# SSH to node, then:
ip -d link show flannel.1
bridge fdb show dev flannel.1

# Check flannel network configuration
kubectl get cm -n kube-flannel kube-flannel-cfg -o yaml
```

## tcpdump from Ephemeral Containers

Ephemeral containers allow attaching debug tools to running pods without modifying the pod spec.

```bash
# Attach netshoot as ephemeral container to a running pod
kubectl debug -it <pod-name> -n <namespace> \
  --image=nicolaka/netshoot \
  --target=<container-name> \
  -- bash

# Inside the ephemeral container, run tcpdump on pod's network namespace
# The ephemeral container shares the network namespace with the target container
tcpdump -i eth0 -n -w /tmp/capture.pcap

# Capture specific traffic
tcpdump -i eth0 -n 'port 8080'
tcpdump -i eth0 -n 'host 10.244.1.5 and port 5432'
tcpdump -i eth0 -n 'tcp[tcpflags] & (tcp-rst) != 0'  # TCP resets

# Copy capture file out
kubectl cp <namespace>/<pod-name>:/tmp/capture.pcap ./capture.pcap -c debugger

# Analyze with tshark
tshark -r capture.pcap -Y 'tcp.flags.reset == 1' -T fields \
  -e ip.src -e ip.dst -e tcp.dstport
```

### Using ksniff for Non-Interactive Capture

```bash
# Install ksniff kubectl plugin
kubectl krew install sniff

# Capture traffic from a pod
kubectl sniff <pod-name> -n <namespace> -p -o ./capture.pcap

# Capture with filter
kubectl sniff <pod-name> -n <namespace> \
  -f "port 8080" \
  -o ./capture.pcap

# Pipe directly to Wireshark
kubectl sniff <pod-name> -n <namespace> -p
```

## Conntrack Table Analysis

The conntrack table tracks all stateful connections. Conntrack issues cause silent connection drops when a connection is tracked but in an unexpected state.

```bash
# SSH to the node where the affected pod is running
# Install conntrack tools if not present
apt-get install -y conntrack

# List all tracked connections for a pod
conntrack -L -s <pod-ip>
conntrack -L -d <pod-ip>

# Watch conntrack events in real-time
conntrack -E

# Count entries per state
conntrack -L | awk '{print $4}' | sort | uniq -c

# Check for CLOSE_WAIT accumulation (indicates app not reading socket)
conntrack -L | grep CLOSE_WAIT | wc -l

# Check conntrack table utilization
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Calculate utilization percentage
echo "scale=2; $(cat /proc/sys/net/netfilter/nf_conntrack_count) * 100 \
  / $(cat /proc/sys/net/netfilter/nf_conntrack_max)" | bc
```

### Conntrack Table Full

When the conntrack table fills to capacity, new connections are silently dropped:

```bash
# Check if conntrack is full (node-level metric)
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Increase conntrack table size (temporary)
sysctl -w net.netfilter.nf_conntrack_max=524288

# Make permanent via sysctl configuration
cat >> /etc/sysctl.d/99-conntrack.conf << 'EOF'
net.netfilter.nf_conntrack_max = 524288
net.netfilter.nf_conntrack_tcp_timeout_established = 1800
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60
EOF
sysctl --system

# Prometheus alert for conntrack near full
# kube_node_status_capacity{resource="conntrack"} unavailable
# Use node_nf_conntrack_entries / node_nf_conntrack_entries_limit > 0.9
```

## iptables/nftables Chain Tracing

When traffic appears to be silently dropped, tracing through iptables rules identifies the drop point.

```bash
# List all iptables rules with packet/byte counters
iptables -L -n -v --line-numbers
iptables -t nat -L -n -v --line-numbers

# Trace a specific packet through all chains (TRACE target)
# WARNING: TRACE generates significant log volume, use briefly

# Enable tracing for traffic from a specific source
iptables -t raw -A PREROUTING -s <pod-ip> -j TRACE
iptables -t raw -A OUTPUT -d <pod-ip> -j TRACE

# Watch the trace output
# The trace appears in kernel log
journalctl -f -k | grep "TRACE:"
# Or in older systems
dmesg -w | grep TRACE

# Remove trace rules after debugging
iptables -t raw -D PREROUTING -s <pod-ip> -j TRACE
iptables -t raw -D OUTPUT -d <pod-ip> -j TRACE

# For nftables (newer kernels)
nft list ruleset
nft monitor trace
```

### Kubernetes iptables Rule Structure

```bash
# Find KUBE-SVC chains for a specific service
SERVICE_IP=$(kubectl get svc <service-name> -n <namespace> \
  -o jsonpath='{.spec.clusterIP}')
iptables -t nat -L -n | grep "$SERVICE_IP"

# Trace DNAT flow for a service
iptables -t nat -L PREROUTING -n -v
iptables -t nat -L KUBE-SERVICES -n -v | grep "$SERVICE_IP"

# Find endpoint rules (KUBE-SEP chains)
SVC_CHAIN=$(iptables -t nat -L KUBE-SERVICES -n | \
  grep "$SERVICE_IP" | awk '{print $2}')
iptables -t nat -L "$SVC_CHAIN" -n -v
```

## DNS Resolution Debugging

DNS failures in Kubernetes manifest as "no such host" errors. CoreDNS is the primary DNS server.

```bash
# Check CoreDNS health
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50

# Enable CoreDNS query logging (temporary)
kubectl edit configmap coredns -n kube-system
# Add "log" plugin to the Corefile:
# .:53 {
#     log          <-- add this line
#     errors
#     health ...

# Restart CoreDNS to pick up config change
kubectl rollout restart deployment/coredns -n kube-system

# Test DNS from a pod
kubectl run dns-test --image=nicolaka/netshoot \
  --restart=Never --rm -it -- bash

# Inside the pod:
# Test cluster DNS
dig kubernetes.default.svc.cluster.local
dig +short api-server.production.svc.cluster.local

# Test external DNS
dig +short google.com

# Check resolv.conf
cat /etc/resolv.conf

# Test with specific nameserver
dig @10.96.0.10 kubernetes.default.svc.cluster.local

# Check DNS search domains
# resolv.conf should contain:
# search production.svc.cluster.local svc.cluster.local cluster.local
# nameserver 10.96.0.10 (or your cluster DNS IP)
```

### DNS Debugging with Custom CoreDNS Logging

```yaml
# Patch CoreDNS ConfigMap with detailed logging
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        log . {
            class all
        }
        errors
        health {
           lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf {
           max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
```

### DNS ndots Configuration

High `ndots` values cause excessive DNS queries for external names:

```bash
# A hostname "api.example.com" with ndots:5 generates these queries in order:
# api.example.com.production.svc.cluster.local
# api.example.com.svc.cluster.local
# api.example.com.cluster.local
# api.example.com.  (only then the real query)

# Fix: use FQDN with trailing dot for external names in code
# Or reduce ndots in pod spec:
```

```yaml
spec:
  dnsConfig:
    options:
    - name: ndots
      value: "2"  # Only append search domains for names with < 2 dots
    - name: timeout
      value: "2"
    - name: attempts
      value: "3"
```

## Service Endpoint Verification

A service with no ready endpoints silently drops connections.

```bash
# Check service endpoints
kubectl get endpoints <service-name> -n <namespace>
kubectl describe endpoints <service-name> -n <namespace>

# Check if endpoints are empty (no ready pods)
kubectl get endpoints -n production | grep '<none>'

# Verify selector matches pods
kubectl describe service <service-name> -n <namespace> | grep Selector
kubectl get pods -n <namespace> -l <key>=<value> -o wide

# Check pod readiness
kubectl get pods -n <namespace> -l <key>=<value>
# Look for "READY" column showing 0/1 or similar

# Check readiness probe failures
kubectl describe pod <pod-name> -n <namespace> | grep -A 10 "Readiness"

# Test service via curl from another pod
curl -v http://<service-name>.<namespace>.svc.cluster.local:8080/health

# Check kube-proxy (iptables mode) is programming rules
iptables -t nat -L KUBE-SERVICES -n | grep <service-cluster-ip>
```

## NetworkPolicy Testing with netshoot

NetworkPolicy testing requires a systematic approach: establish that connectivity works without policies, then verify policies enforce expected restrictions.

```bash
# Deploy two test pods
kubectl run client --image=nicolaka/netshoot -n test-ns \
  --labels="role=client" --restart=Never -- sleep 3600

kubectl run server --image=hashicorp/http-echo:latest -n test-ns \
  --labels="role=server" --restart=Never \
  -- -listen=:8080 -text="hello from server"

# Get server pod IP
SERVER_IP=$(kubectl get pod server -n test-ns -o jsonpath='{.status.podIP}')

# Test without NetworkPolicy (should succeed)
kubectl exec -it client -n test-ns -- curl -s "http://${SERVER_IP}:8080"
```

Apply a deny-all policy and verify it blocks traffic:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
  namespace: test-ns
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

```bash
# Apply deny-all
kubectl apply -f deny-all-policy.yaml

# Verify traffic is now blocked
kubectl exec -it client -n test-ns -- curl --max-time 5 "http://${SERVER_IP}:8080"
# Expected: timeout or connection refused
```

Apply a targeted allow policy:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-client-to-server
  namespace: test-ns
spec:
  podSelector:
    matchLabels:
      role: server
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: client
    ports:
    - protocol: TCP
      port: 8080
```

```bash
# Apply allow policy
kubectl apply -f allow-policy.yaml

# Verify traffic is now allowed
kubectl exec -it client -n test-ns -- curl -s "http://${SERVER_IP}:8080"
# Expected: "hello from server"

# Verify a third pod cannot reach server
kubectl run intruder --image=nicolaka/netshoot -n test-ns \
  --labels="role=intruder" --restart=Never -- sleep 3600
kubectl exec -it intruder -n test-ns -- curl --max-time 5 "http://${SERVER_IP}:8080"
# Expected: timeout (policy denies intruder)
```

### Cilium NetworkPolicy Debugging

```bash
# Check which policies apply to an endpoint
kubectl exec -n kube-system -it <cilium-pod> -- \
  cilium endpoint get <endpoint-id> | jq '.spec.policy'

# Test policy verdict before applying
kubectl exec -n kube-system -it <cilium-pod> -- \
  cilium policy trace \
  --src-k8s-pod test-ns:client \
  --dst-k8s-pod test-ns:server \
  --dport 8080 \
  --verbose
```

## MTU and Path MTU Discovery Issues

MTU mismatches cause large packets to be silently dropped, resulting in failed connections for large payloads while small requests succeed.

```bash
# Check interface MTU on a node
ip link show | grep mtu

# VXLAN/overlay networks typically reduce MTU by 50-100 bytes:
# Node interface MTU: 1500
# VXLAN overhead: 50 bytes
# Pod interface MTU should be: 1450

# Test for MTU issues with ping
# -M do = set DF (Don't Fragment) bit
# -s 1400 = payload size
ping -c 3 -M do -s 1400 <pod-ip>
# If MTU=1450 and you send 1400+28(ICMP header) = 1428 bytes → should succeed
# ping -M do -s 1450 would fail with FRAG_NEEDED

# Test with incrementing packet sizes to find MTU
for size in 1400 1420 1440 1450 1460 1480 1500; do
  if ping -c 1 -M do -s "$size" "$TARGET_IP" &>/dev/null; then
    echo "MTU OK at $((size + 28)) bytes"
  else
    echo "MTU FAIL at $((size + 28)) bytes"
  fi
done
```

## Summary: Troubleshooting Decision Tree

```
Connection fails
├── DNS resolution fails
│   ├── Check CoreDNS pods running
│   ├── Check /etc/resolv.conf in pod
│   └── Check CoreDNS logs for errors
├── DNS resolves but connection refused
│   ├── Check service endpoints (kubectl get endpoints)
│   ├── Check pod readiness probes
│   └── Test direct pod IP (bypass service)
├── Direct pod IP works but service IP fails
│   ├── Check kube-proxy/iptables rules
│   └── Check service selector matches pod labels
├── Pod-to-pod on same node works, cross-node fails
│   ├── Check CNI routing (BGP peer status for Calico)
│   ├── Check VXLAN tunnel (Flannel/Cilium)
│   └── Check node security groups (cloud environments)
├── Traffic intermittently drops
│   ├── Check conntrack table utilization
│   ├── Check for MTU mismatch (large payload tests)
│   └── Use tcpdump to identify drop side
└── Traffic blocked by NetworkPolicy
    ├── Use cilium monitor or nft monitor trace
    ├── Check policy ingress/egress directions
    └── Verify pod selector labels match policy
```

The systematic approach—starting at DNS, moving through service endpoints, then pod-to-pod connectivity, then CNI routing, then node-level networking—resolves the vast majority of Kubernetes network issues with targeted investigation rather than trial-and-error configuration changes.
