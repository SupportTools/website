---
title: "Kubernetes Network Troubleshooting Toolkit: Production Debugging Guide"
date: 2027-03-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Troubleshooting", "Debugging", "Production"]
categories: ["Kubernetes", "Networking", "Troubleshooting"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade Kubernetes network troubleshooting toolkit covering systematic debugging methodology, packet capture, conntrack inspection, iptables analysis, eBPF tracing, DNS debugging, CNI diagnostics, and common failure pattern resolution."
more_link: "yes"
url: "/kubernetes-network-troubleshooting-toolkit-production-guide/"
---

Network problems in Kubernetes clusters are particularly challenging to diagnose because the failure can originate at multiple layers — the pod's network namespace, the CNI plugin, kube-proxy's iptables rules, the node's conntrack table, overlay tunnel health, or external DNS resolution. A production engineer encountering "connection refused" or intermittent packet loss needs a systematic methodology that progressively narrows the problem space without requiring cluster restarts or causing additional disruption.

This guide provides a complete network troubleshooting toolkit: from deploying debug pods to inspecting iptables rules, capturing packets with `tcpdump`, tracing conntrack NAT state, and diagnosing CNI-specific issues across the most common Kubernetes networking patterns.

<!--more-->

## Systematic Debugging Methodology

Before reaching for packet captures, work through the OSI model from layer 7 down to layer 2:

1. **Can the pod resolve DNS?** — rules out CoreDNS and cluster DNS configuration issues
2. **Can the pod reach the Service ClusterIP?** — rules out kube-proxy/iptables/eBPF forwarding issues
3. **Can the pod reach the backend pod IP directly?** — rules out overlay tunnel and CNI routing issues
4. **Is the target pod listening on the expected port?** — rules out application configuration issues
5. **Are NetworkPolicy rules blocking traffic?** — rules out policy misconfigurations
6. **Are there conntrack table exhaustion or NAT issues?** — rules out kernel-level NAT failures

## Deploying Debug Pods

### netshoot — The Swiss Army Container

The `netshoot` image packages `tcpdump`, `tshark`, `nmap`, `iperf3`, `curl`, `dig`, `traceroute`, `ss`, `iptables`, `conntrack`, and dozens of other tools in a single container.

```bash
# Ephemeral debug container in a running pod's network namespace (Kubernetes 1.23+)
kubectl debug -it -n production \
  --image=nicolaka/netshoot:latest \
  --target=app-container \
  pod/web-deployment-5d9c7b8d6-xk4pj

# Standalone debug pod on a specific node
kubectl run netshoot-debug \
  --image=nicolaka/netshoot:latest \
  --restart=Never \
  --rm -it \
  --overrides="{
    \"spec\": {
      \"nodeName\": \"node01\",
      \"hostNetwork\": true,
      \"tolerations\": [{\"operator\": \"Exists\"}],
      \"containers\": [{
        \"name\": \"netshoot\",
        \"image\": \"nicolaka/netshoot:latest\",
        \"command\": [\"/bin/bash\"],
        \"stdin\": true,
        \"tty\": true,
        \"securityContext\": {\"privileged\": true}
      }]
    }
  }" -- /bin/bash

# Debug pod sharing target pod's network namespace
TARGET_POD="web-deployment-5d9c7b8d6-xk4pj"
TARGET_NS="production"
NODE=$(kubectl get pod -n "$TARGET_NS" "$TARGET_POD" -o jsonpath='{.spec.nodeName}')

kubectl run netshoot-debug \
  --image=nicolaka/netshoot:latest \
  --restart=Never \
  --rm -it \
  --overrides="{
    \"spec\": {
      \"nodeName\": \"${NODE}\",
      \"tolerations\": [{\"operator\": \"Exists\"}]
    }
  }" -- /bin/bash
```

## DNS Debugging

DNS failures are the most frequent network complaint in Kubernetes clusters. Symptoms include slow pod startup, `SERVFAIL` responses, and intermittent `dial tcp: lookup <hostname>: no such host` errors.

### Basic DNS Validation

```bash
# From within a debug pod
# Test cluster DNS resolution
dig kubernetes.default.svc.cluster.local @10.96.0.10

# Test CNAME and external resolution
dig +short myservice.production.svc.cluster.local
dig +short api.github.com

# Check search domains and resolv.conf inside the pod
cat /etc/resolv.conf

# Test with nslookup (shows full resolution chain)
nslookup myservice.production.svc.cluster.local

# Test with specific nameserver
nslookup myservice.production 10.96.0.10

# Test short names (search domain resolution order)
nslookup myservice
nslookup myservice.production
nslookup myservice.production.svc
nslookup myservice.production.svc.cluster.local
```

### CoreDNS Log Analysis

```bash
# Enable CoreDNS debug logging temporarily
kubectl -n kube-system edit configmap coredns

# Add 'log' to the Corefile:
# .:53 {
#   log          <--- add this line
#   errors
#   ...
# }

# Reload CoreDNS (it watches the ConfigMap)
kubectl -n kube-system rollout restart deployment coredns

# Tail CoreDNS logs while reproducing the issue
kubectl -n kube-system logs -l k8s-app=kube-dns -f --tail=200

# Filter for SERVFAIL responses
kubectl -n kube-system logs -l k8s-app=kube-dns | \
  grep -E "SERVFAIL|NXDOMAIN|REFUSED"

# Check CoreDNS metrics for error rate
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l k8s-app=kube-dns -o name | head -1) \
  -- curl -s localhost:9153/metrics | grep coredns_dns_responses_total
```

### CoreDNS Configuration Issues

```bash
# Validate CoreDNS ConfigMap syntax
kubectl -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}'

# Check CoreDNS endpoints are healthy
kubectl -n kube-system get endpoints kube-dns

# Test DNS from a pod on each node to isolate node-specific issues
for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
  echo "=== $node ==="
  kubectl run dns-test-${node} \
    --image=busybox:1.36 \
    --restart=Never \
    --rm \
    --overrides="{\"spec\":{\"nodeName\":\"${node}\"}}" \
    -- nslookup kubernetes.default 2>&1 | grep -E "Server|Address|Name"
done
```

## Packet Capture with tcpdump and nsenter

### Capturing Traffic in Pod Network Namespace

Pod network namespaces are not accessible from the host by default. Use `nsenter` to enter the pod's network namespace from the node.

```bash
# Find the target pod's container ID and node
POD="web-deployment-5d9c7b8d6-xk4pj"
NS="production"
NODE=$(kubectl get pod -n "$NS" "$POD" -o jsonpath='{.spec.nodeName}')
CONTAINER_ID=$(kubectl get pod -n "$NS" "$POD" \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's/containerd:\/\///')

# SSH to the node
ssh "$NODE"

# Find the PID of the container process
CONTAINER_PID=$(crictl inspect "$CONTAINER_ID" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['info']['pid'])")

# Enter the network namespace and capture traffic on eth0
nsenter -n -t "$CONTAINER_PID" -- \
  tcpdump -i eth0 -nn -s 0 \
  -w /tmp/pod-capture.pcap \
  'tcp port 8080 or tcp port 80'

# Capture and display inline (no file write)
nsenter -n -t "$CONTAINER_PID" -- \
  tcpdump -i eth0 -nn -A \
  'host 10.0.1.5 and tcp port 5432'
```

### Capturing on the Node's Overlay Interface

For CNI overlay networks (VXLAN, Geneve), capture on the tunnel interface to see encapsulated traffic.

```bash
# Find overlay interface name
ip link show | grep -E "flannel|cni|vxlan|geneve|tunl|calico"

# Capture VXLAN traffic between nodes
tcpdump -i eth0 -nn udp port 8472 -w /tmp/vxlan-capture.pcap

# Capture on the bridge interface (shows all pod traffic)
tcpdump -i cni0 -nn -s 0 \
  'host 10.244.1.5' \
  -w /tmp/bridge-capture.pcap

# Decode VXLAN inner packets with tshark
tshark -r /tmp/vxlan-capture.pcap \
  -d udp.port==8472,vxlan \
  -Y "vxlan" \
  -T fields \
  -e ip.src -e ip.dst -e tcp.srcport -e tcp.dstport
```

### Transferring Captures for Wireshark Analysis

```bash
# Copy capture file from node to local machine
scp node01:/tmp/pod-capture.pcap ./

# Or stream directly through kubectl exec
kubectl exec -n production web-deployment-5d9c7b8d6-xk4pj \
  -- tcpdump -i eth0 -nn -s 0 -w - 'port 8080' 2>/dev/null | \
  wireshark -k -i -
```

## Conntrack Table Inspection

The connection tracking table maintains NAT state for all Service connections. Exhaustion or stale entries cause intermittent connection failures and can be mistaken for application issues.

```bash
# Install conntrack tools on the node
apt-get install -y conntrack  # Debian/Ubuntu
yum install -y conntrack-tools  # RHEL/CentOS

# View all tracked connections
conntrack -L 2>/dev/null | head -50

# Filter by destination IP (Service ClusterIP)
conntrack -L 2>/dev/null | grep "10.96.45.123"

# Filter by protocol and port
conntrack -L -p tcp --dport 443 2>/dev/null | wc -l

# Check conntrack table size vs maximum
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Percentage used
echo "$(cat /proc/sys/net/netfilter/nf_conntrack_count) / \
$(cat /proc/sys/net/netfilter/nf_conntrack_max) * 100" | bc

# Show TIME_WAIT connections that are near timeout
conntrack -L 2>/dev/null | \
  awk '/TIME_WAIT/ {print $3, $0}' | \
  sort -n | tail -20

# Delete a specific stale entry (use carefully in production)
conntrack -D -p tcp --src 10.244.1.5 --dst 10.96.45.123 --dport 443
```

### Conntrack Tuning

```bash
# Increase conntrack table size if near capacity
sysctl -w net.netfilter.nf_conntrack_max=1048576
sysctl -w net.netfilter.nf_conntrack_buckets=262144

# Persist across reboots
cat >> /etc/sysctl.d/99-conntrack.conf << 'EOF'
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_buckets = 262144
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
EOF
sysctl --system
```

## iptables Rules Inspection (kube-proxy Mode)

In `iptables` kube-proxy mode, Services are implemented as chains of DNAT rules. Tracing which rules are hit helps diagnose load balancing and port mapping issues.

```bash
# List all Kubernetes service chains
iptables-save | grep -E "^:KUBE" | sort

# Trace rules for a specific ClusterIP
SVC_IP="10.96.45.123"
iptables-save | grep "$SVC_IP" | head -20

# Show the DNAT chain for a service
iptables -t nat -L KUBE-SERVICES -n --line-numbers | grep "$SVC_IP"

# Follow the chain for a specific service
CHAIN=$(iptables -t nat -L KUBE-SERVICES -n | grep "$SVC_IP" | awk '{print $2}')
iptables -t nat -L "$CHAIN" -n --line-numbers

# Check packet/byte counters on rules (identifies if rules are being hit)
iptables -t nat -L KUBE-SERVICES -n -v | grep "$SVC_IP"

# Trace a specific connection through iptables rules
iptables -t raw -I PREROUTING -p tcp --dport 443 -j TRACE
iptables -t raw -I OUTPUT -p tcp --dport 443 -j TRACE
# Monitor in kernel log
dmesg | grep "TRACE:"
# Clean up trace rules when done
iptables -t raw -D PREROUTING -p tcp --dport 443 -j TRACE
iptables -t raw -D OUTPUT -p tcp --dport 443 -j TRACE
```

### Checking Endpoint Routing

```bash
# List all endpoints for a service
kubectl get endpoints myservice -n production -o yaml

# Check if kube-proxy has programmed the right backend IPs
SVC_IP="10.96.45.123"
iptables -t nat -L -n | grep -A5 "$SVC_IP"

# Verify endpoint pod is running and has correct IP
kubectl get pod -n production -l app=myservice -o wide

# Check kube-proxy logs for the service
kubectl -n kube-system logs -l k8s-app=kube-proxy --tail=100 | \
  grep "myservice\|10.96.45.123"
```

## eBPF-Based Debugging with bpftrace

eBPF tracing provides sub-millisecond visibility into network stack behavior without modifying application code or adding packet capture overhead.

```bash
# Trace TCP connection attempts to a specific port
bpftrace -e '
tracepoint:syscalls:sys_enter_connect {
  $addr = (struct sockaddr_in *)args->uservaddr;
  if ($addr->sin_port == 8080 || $addr->sin_port == (8080 << 8 | 8080 >> 8)) {
    printf("PID %d comm %s connecting to port 8080\n", pid, comm);
  }
}
'

# Trace TCP connection failures (RST or timeout)
bpftrace -e '
kprobe:tcp_reset {
  printf("TCP RST: PID=%d comm=%s\n", pid, comm);
}'

# Measure TCP round-trip latency by connection
bpftrace -e '
kprobe:tcp_v4_connect { @start[tid] = nsecs; }
kretprobe:tcp_v4_connect /@start[tid]/ {
  $latency = (nsecs - @start[tid]) / 1000;
  @["connect_latency_us"] = hist($latency);
  delete(@start[tid]);
}
END { print(@); }'

# Trace DNS queries from specific pods
bpftrace -e '
kprobe:udp_sendmsg {
  if (comm == "app-process") {
    printf("UDP send from PID %d comm %s len=%d\n", pid, comm, arg2);
  }
}'

# Monitor socket errors in real time
bpftrace -e '
tracepoint:sock:inet_sock_set_state {
  if (args->newstate == 7) { // TCP_CLOSE
    printf("TCP CLOSE: sport=%d dport=%d\n",
      args->sport, args->dport);
  }
}'
```

## NetworkPolicy Debugging

NetworkPolicy misconfigurations are a common source of connectivity issues after policy enforcement is enabled or updated.

### Testing with Debug Pods

```bash
# Create a labeled debug pod to test policy ingress
kubectl run policy-test-client \
  --image=nicolaka/netshoot:latest \
  --restart=Never \
  --rm -it \
  -n production \
  --labels="app=test-client,env=production" \
  -- curl -v http://myservice.production.svc.cluster.local:8080/health

# Create policy-exempt debug pod (no labels matching any policy)
kubectl run policy-exempt-debug \
  --image=nicolaka/netshoot:latest \
  --restart=Never \
  --rm -it \
  -n production \
  -- nc -zv myservice.production.svc.cluster.local 8080

# Test from outside the namespace
kubectl run cross-ns-test \
  --image=nicolaka/netshoot:latest \
  --restart=Never \
  --rm -it \
  -n staging \
  -- curl -v http://myservice.production.svc.cluster.local:8080
```

### Inspecting Active Policies

```bash
# List all NetworkPolicies affecting a pod
POD_LABELS=$(kubectl get pod -n production web-5d9c7b8d6-xk4pj \
  -o jsonpath='{.metadata.labels}')
echo "Pod labels: $POD_LABELS"

# List policies with podSelector matching the pod
kubectl get networkpolicy -n production -o yaml | \
  python3 -c "
import yaml, sys
policies = yaml.safe_load_all(sys.stdin)
for p in policies:
  if p and 'items' in p:
    for item in p['items']:
      print(item['metadata']['name'], item['spec'].get('podSelector', {}))"

# Show all ingress sources allowed into a pod
kubectl get networkpolicy -n production -o json | \
  jq '.items[] | select(.spec.podSelector.matchLabels.app == "myapp") |
    {name: .metadata.name, ingress: .spec.ingress}'
```

### Cilium Policy Troubleshooting

```bash
# Check Cilium endpoint policy status
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l app=cilium -o name | head -1) \
  -- cilium endpoint list

# Check policy for a specific endpoint
ENDPOINT_ID=1234
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l app=cilium -o name | head -1) \
  -- cilium endpoint get "$ENDPOINT_ID" | jq '.policy'

# Monitor policy verdicts in real time
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l app=cilium -o name | head -1) \
  -- cilium monitor --type drop

# Check if a specific connection would be allowed
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l app=cilium -o name | head -1) \
  -- cilium policy trace \
    --src-k8s-pod production:web-deployment-5d9c7b8d6-xk4pj \
    --dst-k8s-pod production:backend-deployment-7f8d9c-abc12 \
    --dport 8080/tcp
```

## MTU Issues in Overlay Networks

MTU mismatches cause packet fragmentation or silent drops that manifest as intermittent hangs (especially for large HTTP responses or bulk data transfers) while small pings succeed.

```bash
# Check MTU on pod interfaces
kubectl exec -n production web-5d9c7b8d6-xk4pj -- ip link show eth0

# Check MTU on node overlay interface
ip link show flannel.1
ip link show vxlan.calico

# Test MTU with path MTU discovery
# A packet of size 1450 with DF bit set should succeed;
# increase until it fails to find the effective MTU
kubectl exec -n production web-5d9c7b8d6-xk4pj -- \
  ping -M do -s 1450 -c 3 10.244.2.5

# Test HTTP with large payload to detect MTU-related hangs
kubectl exec -n production web-5d9c7b8d6-xk4pj -- \
  curl -o /dev/null -w "%{time_total}\n" \
  http://backend.production.svc.cluster.local:8080/large-response

# Check if PMTU discovery is working on nodes
sysctl net.ipv4.ip_no_pmtu_disc

# Force PMTU discovery on the node
sysctl -w net.ipv4.ip_no_pmtu_disc=0
```

### Common MTU Values

| CNI / Overlay | Recommended Pod MTU | Reason |
|---|---|---|
| Flannel VXLAN | 1450 | VXLAN header = 50 bytes overhead on 1500 MTU |
| Calico VXLAN | 1450 | Same overhead |
| Calico BGP | 1480 | IP-in-IP encapsulation = 20 bytes overhead |
| Cilium VXLAN | 1450 | VXLAN overhead |
| Cilium (no overlay) | 1500 | No encapsulation |
| Flannel on AWS | 1410 | AWS VPC MTU 9001 in jumbo frames, 1500 standard |

## CNI Plugin Log Inspection

CNI plugins log ADD/DEL/CHECK operations that reveal why pod networking is failing at setup time.

```bash
# Flannel logs
kubectl -n kube-system logs -l app=flannel --tail=100 | \
  grep -E "ERROR|WARN|Failed"

# Calico logs
kubectl -n kube-system logs -l app=calico-node --tail=100 | \
  grep -E "ERROR|WARN|Failed"

# Cilium agent logs
kubectl -n kube-system logs -l app=cilium --tail=100 | \
  grep -E "ERROR|WARN|Failed|Drop"

# CNI ADD/DEL operation logs (on the node where the pod failed)
# These are logged to the kubelet log or a CNI-specific log file
journalctl -u kubelet | grep -E "CNI|cni|network" | tail -50

# Check CNI binary and config presence
ls -la /opt/cni/bin/
ls -la /etc/cni/net.d/
cat /etc/cni/net.d/*.conflist
```

## Service Endpoint Debugging

```bash
# Check if Service has any endpoints
kubectl get endpoints -n production myservice

# Check why endpoints are not populating (selector mismatch)
kubectl get service -n production myservice -o yaml | \
  grep -A5 selector
kubectl get pod -n production -l app=myservice --show-labels

# Check readiness probe results affecting endpoint membership
kubectl describe pod -n production web-5d9c7b8d6-xk4pj | \
  grep -A10 "Readiness"

# Verify service port matches container port
kubectl get service -n production myservice -o jsonpath='{.spec.ports}'
kubectl get pod -n production web-5d9c7b8d6-xk4pj \
  -o jsonpath='{.spec.containers[*].ports}'

# Test direct pod IP to bypass Service (isolates kube-proxy vs app issue)
POD_IP=$(kubectl get pod -n production web-5d9c7b8d6-xk4pj \
  -o jsonpath='{.status.podIP}')
kubectl run curl-test \
  --image=curlimages/curl:latest \
  --restart=Never \
  --rm -it \
  -n production \
  -- curl -v "http://${POD_IP}:8080/health"
```

## Node-Level Network Debugging Script

```bash
#!/bin/bash
# node-network-diag.sh
# Runs comprehensive network diagnostics on a Kubernetes node.

set -euo pipefail

echo "=== Node Network Diagnostics ==="
echo "Date: $(date)"
echo "Node: $(hostname)"
echo ""

echo "=== Interface Summary ==="
ip -brief addr show
echo ""

echo "=== Route Table ==="
ip route show table main | head -30
echo ""

echo "=== Conntrack Status ==="
echo "Current entries: $(cat /proc/sys/net/netfilter/nf_conntrack_count)"
echo "Maximum entries: $(cat /proc/sys/net/netfilter/nf_conntrack_max)"
echo "Usage: $(echo "scale=2; $(cat /proc/sys/net/netfilter/nf_conntrack_count) * 100 / \
$(cat /proc/sys/net/netfilter/nf_conntrack_max)" | bc)%"
echo ""

echo "=== Socket Statistics ==="
ss -s
echo ""

echo "=== TCP Time Wait Sockets ==="
ss -nt state time-wait | wc -l
echo ""

echo "=== DNS Resolution Test ==="
nslookup kubernetes.default.svc.cluster.local 2>&1 | head -5
echo ""

echo "=== iptables Rule Count ==="
iptables -t nat -L | wc -l
echo "KUBE chains: $(iptables -t nat -L | grep -c "^Chain KUBE" || true)"
echo ""

echo "=== CNI Interface MTU ==="
for iface in $(ip link show | grep -E "flannel|cni|vxlan|calico" | \
               awk -F: '{print $2}' | xargs); do
  mtu=$(ip link show "$iface" | grep -oP 'mtu \K[0-9]+')
  echo "$iface: MTU $mtu"
done
echo ""

echo "=== Pod Network Interfaces ==="
for pid in $(ls /proc/ | grep -E '^[0-9]+$'); do
  if [ -f "/proc/$pid/net/dev" ] && \
     grep -q "eth0" "/proc/$pid/net/dev" 2>/dev/null; then
    comm=$(cat "/proc/$pid/comm" 2>/dev/null || echo "unknown")
    echo "PID=$pid comm=$comm"
  fi
done | head -20
echo ""

echo "=== Recent Kernel Network Errors ==="
dmesg --ctime 2>/dev/null | grep -iE "net|conntrack|nf_|tcp|udp" | tail -20
```

## Common Failure Patterns and Solutions

### Pattern: Intermittent DNS Failures

**Symptoms**: Pod occasionally fails to resolve hostnames, then succeeds on retry. More frequent under load.

**Cause**: CoreDNS pods are CPU-throttled due to insufficient CPU limits, or the `ndots:5` search path causes 5+ DNS queries per lookup.

**Solution**:
```bash
# Check CoreDNS CPU throttling
kubectl top pods -n kube-system -l k8s-app=kube-dns

# Reduce ndots for specific pods
# Add to pod spec:
dnsConfig:
  options:
    - name: ndots
      value: "2"
    - name: single-request-reopen

# Increase CoreDNS replicas and CPU limits
kubectl -n kube-system scale deployment coredns --replicas=3
```

### Pattern: Connection Refused to ClusterIP

**Symptoms**: `curl` to a Service ClusterIP returns `Connection refused` but the pod is Running.

**Cause**: Pod is Running but not Ready (readiness probe failing), so kube-proxy removes it from Endpoints.

**Solution**:
```bash
# Check readiness probe status
kubectl describe pod -n production web-5d9c7b8d6-xk4pj | grep -A5 Readiness

# Check endpoints — if empty, no pods are ready
kubectl get endpoints -n production myservice
```

### Pattern: Pod Cannot Reach External Internet

**Symptoms**: Pod can reach other cluster services but fails to reach external IPs or domains.

**Cause**: Missing egress NetworkPolicy, SNAT not configured on nodes, or cloud security group blocking outbound traffic.

**Solution**:
```bash
# Test with IP (bypass DNS)
kubectl exec -it mypod -- curl -v http://1.1.1.1

# Check if default egress deny policy exists
kubectl get networkpolicy -n production | grep deny

# Verify SNAT/masquerade rules on node
iptables -t nat -L POSTROUTING -n -v | grep MASQ
```

### Pattern: Pods on Different Nodes Cannot Communicate

**Symptoms**: Pod A can reach Pod B on the same node but not Pod C on a different node. Direct pod-IP pings fail cross-node.

**Cause**: Overlay tunnel health issue (VXLAN/Geneve) or incorrect routing. On cloud providers, often missing VPC routes or security group rules for pod CIDRs.

**Solution**:
```bash
# Test VXLAN tunnel between nodes
# From node01, ping the overlay IP of node02's flannel interface
ping 10.244.2.0  # node02 tunnel IP

# Check VXLAN FDB entries
bridge fdb show dev flannel.1

# Verify pod CIDR routing on each node
ip route show | grep "10.244"

# On AWS/GCP/Azure: check that pod CIDRs are in the VPC route table
```

## Summary

Effective Kubernetes network troubleshooting requires moving methodically through the network stack rather than jumping to packet captures immediately. Starting with DNS resolution validation, progressing to Service endpoint health, verifying NetworkPolicy rules, then descending to conntrack and iptables inspection covers the majority of production network failures. Tools like `netshoot` for ad-hoc debugging, `nsenter` for pod namespace access, `bpftrace` for kernel-level tracing, and CNI-specific CLI tools (Cilium's `cilium policy trace`, Calico's `calicoctl`) provide the depth needed for complex multi-layer failures. Maintaining a collection of these scripts and integrating node-level diagnostics into incident runbooks significantly reduces mean time to resolution for network incidents.
