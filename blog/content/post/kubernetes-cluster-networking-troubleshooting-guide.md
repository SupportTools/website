---
title: "Kubernetes Cluster Networking Deep Dive: Troubleshooting and Optimization"
date: 2027-12-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "CNI", "Cilium", "Calico", "CoreDNS", "Troubleshooting"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes cluster networking troubleshooting covering CNI plugin debugging, iptables vs eBPF datapaths, CoreDNS analysis, service mesh latency diagnosis, packet capture techniques, and netstat analysis patterns."
more_link: "yes"
url: "/kubernetes-cluster-networking-troubleshooting-guide/"
---

Kubernetes networking failures are among the most difficult production incidents to diagnose. A single misconfigured CNI plugin, a CoreDNS scaling bottleneck, or an iptables rule ordering error can silently degrade service-to-service communication across an entire cluster. Effective troubleshooting requires understanding the full datapath from Pod network namespace through CNI plugin to the cluster overlay, and the ability to instrument and capture traffic at each layer.

This guide covers systematic network troubleshooting across all major CNI plugins (Calico, Flannel, Cilium), comparison of iptables and eBPF datapaths, DNS debugging methodology, service mesh latency analysis, and packet capture techniques for production incident investigation.

<!--more-->

# Kubernetes Cluster Networking Deep Dive: Troubleshooting and Optimization

## Section 1: Kubernetes Networking Model

Every pod gets its own network namespace with a unique IP address. The CNI plugin is responsible for:
1. Creating the veth pair connecting the pod namespace to the host
2. Assigning the pod IP from the CIDR allocation
3. Programming routes so all pods can communicate across nodes
4. Implementing NetworkPolicy enforcement

### Network Namespace Inspection

```bash
# List network namespaces on a node
ls /var/run/netns/   # On some distributions
ip netns list

# Find the namespace for a specific pod
POD_ID=$(kubectl get pod my-pod -n production -o jsonpath='{.metadata.uid}')
# Or via crictl:
crictl inspect $(crictl ps | grep my-pod | awk '{print $1}') | jq '.info.pid'

# Enter pod network namespace
PID=$(crictl inspect $(crictl ps | grep my-pod | awk '{print $1}') | jq '.info.pid')
nsenter -t $PID -n -- ip addr
nsenter -t $PID -n -- ip route
nsenter -t $PID -n -- netstat -tunp

# Verify pod IP assignment
kubectl get pod my-pod -n production -o wide
nsenter -t $PID -n -- ip addr show eth0
```

### Verify Pod-to-Pod Connectivity

```bash
# Deploy a debug pod for network testing
kubectl run netshoot --rm -it \
  --image nicolaka/netshoot \
  --restart Never \
  -n production \
  -- bash

# From inside the debug pod:
# Test pod-to-pod communication
curl -v http://10.244.2.5:8080/health

# Test service DNS resolution
nslookup payment-service.production.svc.cluster.local
dig payment-service.production.svc.cluster.local

# Test cross-namespace service access
curl -v http://api-gateway.api-gateway.svc.cluster.local/health

# Trace route to another pod
traceroute 10.244.2.5
mtr --report --report-cycles 10 10.244.2.5
```

## Section 2: CNI Plugin Debugging — Calico

### Calico Architecture

```
Pod Network Namespace
    └── veth pair (cali-xxxxxxxx)
        └── Host Network Namespace
            ├── Felix (per-node policy agent)
            ├── Bird (BGP routing daemon)
            └── iptables / eBPF programs
```

### Calico Status and Diagnostics

```bash
# Check Calico node status
kubectl exec -n calico-system daemonset/calico-node -- calicoctl node status

# Expected output:
# Calico process is running.
# IPv4 BGP status:
# +--------------+-------------------+-------+----------+
# | PEER ADDRESS |     PEER TYPE     | STATE |  SINCE   |
# +--------------+-------------------+-------+----------+
# | 10.0.1.2     | node-to-node mesh | up    | 23:45:02 |
# | 10.0.1.3     | node-to-node mesh | up    | 23:45:02 |
# +--------------+-------------------+-------+----------+

# Check BGP peer status (critical for cross-node pod communication)
kubectl exec -n calico-system daemonset/calico-node -- \
  calicoctl get bgpPeer -o wide

# Check IP pool allocation
kubectl exec -n calico-system daemonset/calico-node -- \
  calicoctl get ippool -o wide

# Check Calico workload endpoint for a pod
kubectl exec -n calico-system daemonset/calico-node -- \
  calicoctl get workloadEndpoint -n production

# View Felix logs for policy/routing issues
kubectl logs -n calico-system daemonset/calico-node -c calico-node | \
  grep -E "(ERROR|WARN|policy|route)" | tail -50

# Check Felix diagnostics
kubectl exec -n calico-system daemonset/calico-node -- \
  calicoctl node diags
```

### Calico NetworkPolicy Debugging

```bash
# Check if a NetworkPolicy is blocking traffic
# First, identify the flow:
# Source: pod with label app=frontend in namespace production
# Destination: pod with label app=payment-service in namespace production
# Port: TCP 8080

# Check policies affecting the destination pod
kubectl get networkpolicies -n production \
  -o custom-columns="NAME:.metadata.name,POD-SELECTOR:.spec.podSelector,POLICY-TYPES:.spec.policyTypes"

# Detailed policy inspection
kubectl describe networkpolicy allow-payment-ingress -n production

# Calico policy trace (requires Calico Enterprise or Felix debug logs)
kubectl exec -n calico-system daemonset/calico-node -- \
  calicoctl policy trace \
  --source-ip 10.244.1.5 \
  --dest-ip 10.244.2.10 \
  --dest-port 8080 \
  --proto TCP
```

## Section 3: CNI Plugin Debugging — Cilium

### Cilium Status and Health

```bash
# Check Cilium status on all nodes
kubectl exec -n kube-system daemonset/cilium -- cilium status

# Check Cilium connectivity
kubectl exec -n kube-system daemonset/cilium -- cilium connectivity check

# Monitor network policy decisions in real-time
kubectl exec -n kube-system daemonset/cilium -- \
  cilium monitor --type drop --type trace

# Check endpoint status (pod network identities)
kubectl exec -n kube-system daemonset/cilium -- \
  cilium endpoint list

# Get details on a specific endpoint
kubectl exec -n kube-system daemonset/cilium -- \
  cilium endpoint get 1234

# Check service load balancing
kubectl exec -n kube-system daemonset/cilium -- \
  cilium service list

# Verify BPF map state
kubectl exec -n kube-system daemonset/cilium -- \
  cilium bpf lb list

# Policy verdicts for debugging drops
kubectl exec -n kube-system daemonset/cilium -- \
  cilium policy get
```

### Cilium Hubble for Network Observability

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s "https://raw.githubusercontent.com/cilium/hubble/master/stable.txt")
curl -L --fail \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz" | \
  tar xz
sudo install hubble /usr/local/bin/

# Port-forward Hubble Relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe all flows
hubble observe --all

# Filter dropped flows (network policy violations)
hubble observe --verdict DROPPED --from-namespace production --to-namespace production

# Observe flows for specific pod
hubble observe \
  --from-pod production/payment-service-xxx \
  --to-pod production/database-xxx \
  --type l4

# Observe DNS queries
hubble observe --protocol DNS --to-namespace kube-system

# Get traffic statistics
hubble observe --output json | \
  jq -r '[.flow.source.namespace, .flow.destination.namespace, .flow.verdict] | @csv' | \
  sort | uniq -c | sort -rn | head -20
```

## Section 4: iptables vs eBPF Datapaths

### Inspecting iptables Rules

```bash
# List kube-proxy iptables rules (can be 10,000+ in large clusters)
iptables-save | grep -c "^-A"  # Count rules

# View KUBE-SERVICES chain
iptables -t nat -L KUBE-SERVICES -n --line-numbers | head -50

# Find rules for a specific service
SERVICE_IP=$(kubectl get svc payment-service -n production -o jsonpath='{.spec.clusterIP}')
iptables -t nat -L -n | grep "$SERVICE_IP"

# View KUBE-SEP (Service Endpoint) chains
iptables -t nat -L KUBE-SEP-XXXXXXXXXXXXXXXX -n -v

# Check conntrack entries
conntrack -L | grep "10.244.2.5" | head -20
conntrack -L --proto tcp | wc -l  # Total tracked connections

# Identify conntrack table exhaustion
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max
# If count approaches max, conntrack is the bottleneck

# Monitor conntrack events
conntrack -E | head -50
```

### iptables Performance Issues in Large Clusters

```bash
# Measure iptables rule application time
time iptables -t nat -L KUBE-SERVICES -n > /dev/null

# Count total KUBE-SVC and KUBE-SEP chains
iptables -t nat -L -n | grep -c "^Chain KUBE-SVC"
iptables -t nat -L -n | grep -c "^Chain KUBE-SEP"

# For clusters with >2000 services, consider IPVS mode:
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode

# Check if IPVS is in use
ipvsadm -Ln 2>/dev/null | head -30

# IPVS virtual servers
ipvsadm -Ln | grep -E "TCP|UDP" | wc -l
```

### Cilium eBPF Datapath Verification

```bash
# Verify eBPF programs are loaded
kubectl exec -n kube-system daemonset/cilium -- \
  bpftool prog list | grep -c cilium

# Check eBPF map sizes (should scale O(services) not O(endpoints))
kubectl exec -n kube-system daemonset/cilium -- \
  bpftool map list | grep -E "(lb4|lb6)"

# Cilium eBPF bypasses iptables — verify no kube-proxy is running
kubectl get pods -n kube-system | grep kube-proxy
# Should return empty if fully using Cilium eBPF
```

## Section 5: DNS Debugging

### CoreDNS Configuration Inspection

```bash
# View CoreDNS Corefile
kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}'

# Check CoreDNS pod status
kubectl get pods -n kube-system -l k8s-app=kube-dns

# View CoreDNS logs (critical for DNS debugging)
kubectl logs -n kube-system deployment/coredns --all-containers | \
  grep -E "(ERROR|WARN|REFUSED|SERVFAIL)" | tail -50

# Enable CoreDNS query logging (CAUTION: very verbose in production)
kubectl edit configmap coredns -n kube-system
# Add 'log' to the kubernetes or forward plugin:
# kubernetes cluster.local in-addr.arpa ip6.arpa {
#   log
#   ...
# }
```

### DNS Resolution Debugging from Pods

```bash
# Deploy a debug pod with DNS tools
kubectl run dnsutils --rm -it \
  --image gcr.io/kubernetes-e2e-test-images/dnsutils:1.3 \
  --restart Never \
  -- bash

# Test basic cluster DNS
nslookup kubernetes.default
dig kubernetes.default.svc.cluster.local

# Test service DNS resolution
dig payment-service.production.svc.cluster.local

# Check what nameserver the pod is using
cat /etc/resolv.conf
# Should show: nameserver 10.96.0.10 (ClusterIP of kube-dns service)

# Test with specific DNS server
dig @10.96.0.10 payment-service.production.svc.cluster.local

# Check DNS search domains
nslookup payment-service  # Should resolve via search domains

# Test ndots behavior (5 dots trigger absolute lookup first)
dig payment-service.production.svc.cluster.local
# vs
dig payment-service  # Goes through search path: production.svc.cluster.local, etc.
```

### CoreDNS Performance Tuning

```yaml
# coredns-configmap-tuned.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health {
            lameduck 5s
        }
        ready
        # Cache with TTL tuning — prevents upstream hammering
        cache {
            success 9984 30    # Cache 30s, max 9984 entries
            denial 9984 5      # Cache NXDOMAIN 5s
        }
        # Kubernetes service discovery
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        # Forward non-cluster DNS upstream
        forward . /etc/resolv.conf {
            max_concurrent 1000
            prefer_udp
        }
        prometheus :9153
        loop
        reload
        loadbalance
    }
```

### CoreDNS Scaling for Large Clusters

```bash
# Check CoreDNS HPA status
kubectl get hpa -n kube-system coredns

# If no HPA, check deployment replicas
kubectl get deployment coredns -n kube-system

# Scale CoreDNS (as a temporary measure)
kubectl scale deployment coredns --replicas 6 -n kube-system

# Better: configure node-local DNS cache
# Node-local DNS Cache runs on each node, caches DNS queries,
# and reduces CoreDNS load significantly

# Check if node-local-dns is deployed
kubectl get daemonset node-local-dns -n kube-system 2>/dev/null

# DNS query rate per CoreDNS pod
kubectl top pod -n kube-system -l k8s-app=kube-dns

# Check CoreDNS metrics
kubectl port-forward -n kube-system svc/kube-dns 9153:9153 &
curl http://localhost:9153/metrics | grep -E "(coredns_dns|coredns_cache)"
```

### ndots Optimization

```yaml
# Reduce DNS lookup overhead by tuning ndots in pod spec
apiVersion: v1
kind: Pod
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"  # Default is 5 — reduces failed lookups for short names
      - name: single-request-reopen
        # Forces DNS A and AAAA queries to use separate sockets,
        # preventing race conditions in some resolvers
      - name: timeout
        value: "5"
      - name: attempts
        value: "3"
  dnsPolicy: ClusterFirst
```

## Section 6: Service Mesh Latency Diagnosis

### Istio Latency Investigation

```bash
# Check Envoy proxy configuration for a specific pod
kubectl exec -n production payment-service-xxx \
  -c istio-proxy -- pilot-agent request GET listeners

# Check Envoy cluster status (upstream endpoints)
kubectl exec -n production payment-service-xxx \
  -c istio-proxy -- pilot-agent request GET clusters | \
  grep -A 5 "payment-service"

# Envoy stats for latency metrics
kubectl exec -n production payment-service-xxx \
  -c istio-proxy -- pilot-agent request GET stats | \
  grep -E "(upstream_rq_time|downstream_rq_time)"

# istioctl analyze for configuration issues
istioctl analyze -n production

# Check Istiod sync status
istioctl proxy-status

# Find pods with stale Envoy configurations
istioctl proxy-status | grep -v "SYNCED"

# Get Envoy access logs for a specific pod
kubectl logs -n production payment-service-xxx -c istio-proxy | \
  grep -E '"response_code":5' | tail -20

# Check distributed trace in Jaeger/Zipkin
# Search by service: payment-service, time range, min latency: 500ms
```

### Linkerd Latency Analysis

```bash
# Check meshed pod status
linkerd check --proxy

# Real-time traffic metrics
linkerd viz stat deploy -n production

# Per-route latency
linkerd viz routes deploy/payment-service -n production

# Live request tracing
linkerd viz tap deploy/payment-service -n production | head -20

# Check proxy error rates
linkerd viz stat pods -n production | \
  awk '{if ($4 > 0) print $0}'  # Filter pods with errors
```

## Section 7: Packet Capture

### tcpdump on a Node

```bash
# Capture traffic on a node's CNI interface
# Find the CNI interface for pods
ip link | grep "cali\|vxlan\|flannel\|cilium"

# Capture pod-to-pod traffic on Calico interface
tcpdump -i cali12345678901 -nn -v \
  'port 8080 or port 5432' \
  -w /tmp/capture-$(date +%Y%m%d-%H%M%S).pcap

# Capture overlay network traffic (VXLAN)
tcpdump -i eth0 -nn \
  'udp port 8472' \  # VXLAN port used by Flannel/Cilium
  -w /tmp/vxlan-capture.pcap

# Filter by pod IP range
tcpdump -i eth0 -nn \
  'net 10.244.0.0/16' \
  -w /tmp/pod-traffic.pcap

# Capture with timestamps and protocol decode
tcpdump -i eth0 -nn -tttt -vv \
  'host 10.244.2.5 and port 8080' | head -100
```

### Packet Capture Inside a Running Pod

```bash
# Method 1: Use nsenter to capture in pod namespace
POD_PID=$(crictl inspect $(crictl ps --name payment-service | awk 'NR==2{print $1}') | \
  jq '.info.pid')

nsenter -t $POD_PID -n -- \
  tcpdump -i eth0 -nn -v 'port 8080' \
  -w /tmp/pod-capture.pcap &

# Method 2: Use kubectl debug ephemeral container
kubectl debug -it payment-service-xxx \
  --image=nicolaka/netshoot \
  --target=payment-service \
  -n production \
  -- tcpdump -i eth0 -nn -v 'port 8080' -w /tmp/capture.pcap

# Copy capture file from pod
kubectl cp production/payment-service-xxx:/tmp/capture.pcap ./capture.pcap

# Method 3: Ksniff - sniff directly from kubectl
# Install: kubectl krew install sniff
kubectl sniff payment-service-xxx -n production -p -i eth0 \
  -f 'port 8080'
```

### Analyzing Captures with Wireshark/tshark

```bash
# Open in Wireshark (interactive analysis)
wireshark /tmp/capture.pcap

# tshark command-line analysis
# Show all TCP connections
tshark -r /tmp/capture.pcap -q -z conv,tcp

# Find HTTP errors
tshark -r /tmp/capture.pcap -Y 'http.response.code >= 400' \
  -T fields -e http.request.uri -e http.response.code

# TCP retransmissions (indicates packet loss / congestion)
tshark -r /tmp/capture.pcap -Y 'tcp.analysis.retransmission' \
  -T fields -e frame.time -e ip.src -e ip.dst -e tcp.analysis.retransmission

# Measure request-response latency
tshark -r /tmp/capture.pcap -q \
  -z io,stat,0.1,http.response.code==200

# Find connection resets (RST packets — indicate connection errors)
tshark -r /tmp/capture.pcap -Y 'tcp.flags.reset == 1' \
  -T fields -e frame.time -e ip.src -e ip.dst -e tcp.stream

# SSL/TLS handshake analysis (does not decrypt)
tshark -r /tmp/capture.pcap -Y 'ssl.handshake' \
  -T fields -e frame.time -e ip.src -e tls.handshake.type
```

## Section 8: netstat and ss Analysis

```bash
# List all listening ports in a pod
kubectl exec -n production payment-service-xxx -- \
  ss -tulpn

# Check socket backlog status (backlog overflow = SYN drop)
kubectl exec -n production payment-service-xxx -- \
  ss -tulpn | grep LISTEN | awk '{print $7}'

# Check established connections
kubectl exec -n production payment-service-xxx -- \
  ss -tn state established

# Connection counts by remote peer
kubectl exec -n production payment-service-xxx -- \
  ss -tn state established | awk 'NR>1 {split($5,a,":"); print a[1]}' | \
  sort | uniq -c | sort -rn | head 20

# Time-wait connections (high count = port exhaustion risk)
kubectl exec -n production payment-service-xxx -- \
  ss -tn state time-wait | wc -l

# Check kernel TCP buffer settings
kubectl exec -n production payment-service-xxx -- \
  cat /proc/sys/net/core/rmem_max
kubectl exec -n production payment-service-xxx -- \
  cat /proc/sys/net/core/wmem_max

# On the node: overall connection table
ss -s  # Summary statistics
ss -tn | awk '{print $1}' | sort | uniq -c  # Count by state
```

## Section 9: Systematic Troubleshooting Workflow

### Network Connectivity Troubleshooting Flowchart

```bash
#!/usr/bin/env bash
# network-debug.sh — systematic network connectivity test

SOURCE_POD="$1"    # e.g., "frontend-xxx"
SOURCE_NS="$2"     # e.g., "production"
TARGET_SVC="$3"    # e.g., "payment-service"
TARGET_NS="$4"     # e.g., "production"
TARGET_PORT="$5"   # e.g., "8080"

echo "=== Network Connectivity Test ==="
echo "Source: $SOURCE_POD ($SOURCE_NS)"
echo "Target: $TARGET_SVC.$TARGET_NS:$TARGET_PORT"

# Step 1: DNS resolution
echo ""
echo "--- Step 1: DNS Resolution ---"
kubectl exec -n "$SOURCE_NS" "$SOURCE_POD" -- \
  nslookup "${TARGET_SVC}.${TARGET_NS}.svc.cluster.local" && \
  echo "DNS: OK" || echo "DNS: FAILED"

# Step 2: Get service ClusterIP
TARGET_IP=$(kubectl get svc "$TARGET_SVC" -n "$TARGET_NS" \
  -o jsonpath='{.spec.clusterIP}' 2>/dev/null)
echo ""
echo "--- Step 2: Service ClusterIP ---"
echo "ClusterIP: $TARGET_IP"

# Step 3: Check service endpoints
echo ""
echo "--- Step 3: Service Endpoints ---"
kubectl get endpoints "$TARGET_SVC" -n "$TARGET_NS"

ENDPOINT_COUNT=$(kubectl get endpoints "$TARGET_SVC" -n "$TARGET_NS" \
  -o jsonpath='{.subsets[*].addresses}' | jq 'length' 2>/dev/null || echo "0")
echo "Healthy endpoints: $ENDPOINT_COUNT"

if [ "$ENDPOINT_COUNT" = "0" ]; then
  echo "ERROR: No healthy endpoints. Check pod readiness:"
  kubectl get pods -n "$TARGET_NS" -l "app=$TARGET_SVC" -o wide
  exit 1
fi

# Step 4: TCP connectivity to ClusterIP
echo ""
echo "--- Step 4: TCP to ClusterIP ($TARGET_IP:$TARGET_PORT) ---"
kubectl exec -n "$SOURCE_NS" "$SOURCE_POD" -- \
  timeout 5 bash -c "echo >/dev/tcp/${TARGET_IP}/${TARGET_PORT}" && \
  echo "TCP to ClusterIP: OK" || echo "TCP to ClusterIP: FAILED"

# Step 5: HTTP response check
echo ""
echo "--- Step 5: HTTP Health Check ---"
kubectl exec -n "$SOURCE_NS" "$SOURCE_POD" -- \
  curl -v --max-time 5 \
  "http://${TARGET_SVC}.${TARGET_NS}.svc.cluster.local:${TARGET_PORT}/health" \
  2>&1 | grep -E "(< HTTP|Connection refused|timeout)" || true

echo ""
echo "=== Test Complete ==="
```

### MTU Mismatch Diagnosis

```bash
# MTU mismatch causes mysterious packet drops for large payloads
# (uploads work, large responses fail)

# Check MTU on node interfaces
ip link show

# Check MTU inside pod
kubectl exec -n production my-pod -- ip link show eth0

# Standard values:
# Calico VXLAN: 1450 (1500 - 50 VXLAN overhead)
# Calico BGP (no overlay): 1500
# Cilium: 1480 (with encryption) or 1500
# GKE: 1460 (GCP adds encapsulation overhead)

# Test for MTU issues with ping
kubectl exec -n production my-pod -- \
  ping -c 3 -M do -s 1450 10.244.2.5  # -M do = don't fragment

# If this fails but -s 1200 succeeds, MTU is the issue

# Fix Calico MTU
kubectl patch installation.operator.tigera.io default \
  --type merge \
  -p '{"spec":{"calicoNetwork":{"mtu":1450}}}'
```

This guide provides the systematic methodology for diagnosing and resolving Kubernetes networking issues across all layers of the stack. The combination of CNI-specific tooling, packet capture capabilities, and DNS debugging patterns covers the vast majority of production network incidents.
