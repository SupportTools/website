---
title: "Kubernetes Network Troubleshooting Toolkit: tcpdump, netshoot, and eBPF-Based Debugging"
date: 2030-10-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "tcpdump", "eBPF", "Cilium", "Debugging", "DNS"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Kubernetes network debugging guide: deploying netshoot debug pods, tcpdump on pod interfaces, DNS troubleshooting with dig and nslookup, Hubble CLI for Cilium flows, iptables-save analysis, and a systematic network debugging methodology."
more_link: "yes"
url: "/kubernetes-network-troubleshooting-toolkit-tcpdump-netshoot-ebpf/"
---

Kubernetes network issues are among the hardest problems in production — they often present as application timeouts rather than clear network errors, the layers involved (CNI, kube-proxy, CoreDNS, service mesh) interact in non-obvious ways, and many standard debugging tools aren't available inside minimal container images. A systematic toolkit and methodology cuts diagnosis time from hours to minutes.

<!--more-->

## The netshoot Debug Container

netshoot (created by Nicolaka) is the definitive network debugging container, packaging over 100 network tools into a single image. The approach is to inject it alongside a failing container and use its tools rather than cluttering application images with debug tooling.

### Ephemeral Debug Container (kubectl debug)

The cleanest approach for Kubernetes 1.23+ is the ephemeral container:

```bash
# Attach netshoot as an ephemeral container to a running pod
kubectl debug -it \
  --image=nicolaka/netshoot \
  --target=my-app \
  mypod-7d6f8d4b9c-xk2p9

# This places netshoot in the SAME network namespace as my-app
# You can see the same interfaces, routes, and iptables rules

# Verify shared network namespace
ip addr show
# Should show the same eth0 IP as the application pod

# Check processes (shared pid namespace with --target)
ps aux
```

### Standalone Debug Pod in Same Namespace

```yaml
# debug-netshoot.yaml
apiVersion: v1
kind: Pod
metadata:
  name: netshoot-debug
  namespace: production
spec:
  hostNetwork: false
  containers:
    - name: netshoot
      image: nicolaka/netshoot:latest
      command:
        - /bin/bash
        - -c
        - sleep infinity
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          cpu: 500m
          memory: 256Mi
      securityContext:
        capabilities:
          add:
            - NET_ADMIN
            - NET_RAW
```

```bash
kubectl apply -f debug-netshoot.yaml
kubectl exec -it netshoot-debug -n production -- /bin/bash
```

### Node-Level Debug Pod

For problems that require the host network namespace:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: netshoot-host
  namespace: kube-system
spec:
  hostNetwork: true
  hostPID: true
  tolerations:
    - operator: Exists
  nodeSelector:
    kubernetes.io/hostname: problem-node-01
  containers:
    - name: netshoot
      image: nicolaka/netshoot:latest
      command:
        - sleep
        - infinity
      securityContext:
        privileged: true
      volumeMounts:
        - name: host-root
          mountPath: /host
          readOnly: true
  volumes:
    - name: host-root
      hostPath:
        path: /
```

---

## tcpdump on Pod Interfaces

Capturing traffic on pod interfaces requires knowing the virtual ethernet (veth) pair name on the host.

### Finding a Pod's veth Interface

```bash
# Method 1: Through the pod's network namespace
POD_NAME="mypod-7d6f8d4b9c-xk2p9"
POD_NS="production"

# Get the pod's network namespace path
POD_UID=$(kubectl get pod $POD_NAME -n $POD_NS -o jsonpath='{.metadata.uid}')

# Get the ifindex of eth0 inside the pod
kubectl exec $POD_NAME -n $POD_NS -- cat /sys/class/net/eth0/iflink

# Output: 47
# This is the ifindex of the veth on the HOST side

# On the node, find the interface with that ifindex
ip link | grep "^47:"
# 47: vethb3a1c2d@if2: <BROADCAST,MULTICAST,UP,LOWER_UP> ...

# Method 2: Using nsenter from a privileged host pod
CONTAINER_ID=$(kubectl get pod $POD_NAME -n $POD_NS \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's|containerd://||')

# Get the container's network namespace
nsenter -n/proc/$(crictl inspect $CONTAINER_ID | \
  jq -r '.info.pid')/ns/net -- ip link show eth0
```

### Capturing Traffic with tcpdump

```bash
# Inside netshoot (in the pod's network namespace):
tcpdump -i eth0 -nn -v -w /tmp/capture.pcap

# Capture specific traffic patterns:

# HTTP traffic to a backend service
tcpdump -i eth0 -nn 'tcp port 8080 and (tcp[tcpflags] & tcp-syn != 0)'

# DNS queries
tcpdump -i eth0 -nn 'udp port 53 or tcp port 53'

# Capture dropped packets with TTL info
tcpdump -i eth0 -nn 'icmp[icmptype] == icmp-unreach'

# TCP RST packets (connection resets)
tcpdump -i eth0 -nn 'tcp[tcpflags] & tcp-rst != 0'

# High-volume capture with rotation (avoid disk exhaustion)
tcpdump -i eth0 -nn \
  -w /tmp/capture-%H%M.pcap \
  -C 100 \
  -W 10 \
  -G 300

# Copy capture file out
kubectl cp production/netshoot-debug:/tmp/capture.pcap ./capture.pcap

# Analyze locally
wireshark capture.pcap &
# or
tshark -r capture.pcap -q -z io,stat,1 "tcp.analysis.retransmission"
```

### Capturing on the Host veth Interface

For traffic that doesn't reach the pod (dropped at CNI level):

```bash
# Inside a privileged host pod or on the node directly:

VETH="vethb3a1c2d"

# Capture all traffic on the veth
tcpdump -i $VETH -nn -v 2>&1 | head -100

# Show only SYN packets (connection attempts)
tcpdump -i $VETH -nn 'tcp[tcpflags] == tcp-syn'

# Show ICMP (including unreachable messages)
tcpdump -i $VETH -nn icmp
```

---

## DNS Troubleshooting

DNS is the most common source of mysterious Kubernetes network failures.

### Basic DNS Resolution Testing

```bash
# Inside netshoot:

# Test CoreDNS resolution
dig @10.96.0.10 kubernetes.default.svc.cluster.local
# 10.96.0.10 is the kube-dns ClusterIP — replace with your cluster's value

# Check the configured nameserver
cat /etc/resolv.conf
# nameserver 10.96.0.10
# search production.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5

# Test service name resolution (short name → FQDN expansion)
nslookup my-service
# Expected: resolves to ClusterIP of my-service in same namespace

# Test cross-namespace resolution
nslookup my-service.other-namespace
nslookup my-service.other-namespace.svc.cluster.local

# Test external DNS
nslookup api.github.com
dig +trace api.github.com

# Measure DNS latency
for i in {1..10}; do
  time nslookup my-service > /dev/null 2>&1
done
```

### CoreDNS Performance Analysis

```bash
# Check CoreDNS pod health
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Check CoreDNS logs for errors
kubectl logs -n kube-system -l k8s-app=kube-dns --since=30m | \
  grep -E "(SERVFAIL|error|panic)"

# View CoreDNS configuration
kubectl get configmap coredns -n kube-system -o yaml

# Check CoreDNS metrics (if Prometheus is available)
kubectl port-forward -n kube-system svc/kube-dns 9153:9153 &
curl -s http://localhost:9153/metrics | grep -E "coredns_dns_request|coredns_forward"
```

```promql
# DNS error rate
rate(coredns_dns_responses_total{rcode="SERVFAIL"}[5m])

# DNS latency P99
histogram_quantile(0.99,
  rate(coredns_dns_request_duration_seconds_bucket[5m])
)

# Forward plugin failures (upstream DNS unreachable)
rate(coredns_forward_healthcheck_failure_count_total[5m])
```

### ndots and Search Domain Gotchas

The `ndots:5` default causes every application DNS query to attempt up to 5 search domain expansions before trying the name as-is. This creates substantial DNS traffic overhead:

```bash
# An application querying "api.example.com" will actually try:
# api.example.com.production.svc.cluster.local
# api.example.com.svc.cluster.local
# api.example.com.cluster.local
# api.example.com.your-domain.com   (search domains from resolv.conf)
# api.example.com.

# Count DNS queries with tcpdump
tcpdump -i eth0 -nn 'udp port 53' 2>&1 | \
  awk '{print $NF}' | sort | uniq -c | sort -rn | head -20
```

Fix: use FQDNs for external hosts (trailing dot), or reduce ndots in the pod spec:

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"  # Reduces unnecessary search domain attempts
      - name: single-request-reopen
        value: ""   # Fixes race condition on some kernels
```

---

## iptables Analysis

kube-proxy translates Service ClusterIPs into iptables DNAT rules. Understanding these rules is essential for debugging service connectivity.

### Dumping and Analyzing iptables Rules

```bash
# Inside a privileged host pod:

# Save complete ruleset
iptables-save > /tmp/iptables-rules.txt

# Show the KUBE-SERVICES chain (ClusterIP entries)
iptables-save | grep -A3 "KUBE-SERVICES"

# Trace the path for a specific ClusterIP
SERVICE_IP="10.100.50.30"
iptables-save | grep "$SERVICE_IP"

# Show NAT table rules for a service
iptables -t nat -L KUBE-SERVICES -n -v | grep $SERVICE_IP

# Show the endpoint chains
iptables -t nat -L KUBE-SVC-XXXXXXXXXXXXXXXX -n -v

# Count packets through each chain (useful for identifying dropped traffic)
iptables -t filter -L -n -v | grep -v "0     0"

# Watch for rule changes in real time
watch -n 1 "iptables-save | wc -l"
```

### Tracing Packet Flow with iptables LOG

```bash
# Add a logging rule to trace a specific destination (temporary!)
iptables -t nat -I PREROUTING 1 \
  -d 10.100.50.30 \
  -j LOG \
  --log-prefix "PKT-TRACE: " \
  --log-level 4

# Watch the kernel log
dmesg -wT | grep "PKT-TRACE"

# Remove the tracing rule when done
iptables -t nat -D PREROUTING 1
```

---

## Cilium + Hubble eBPF Debugging

For clusters using Cilium as the CNI, Hubble provides deep visibility into network flows without packet capture overhead.

### Hubble CLI Setup

```bash
# Install Hubble CLI
export HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name https://github.com/cilium/hubble/releases/download/$HUBBLE_VERSION/hubble-linux-amd64.tar.gz
tar xzf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/

# Enable Hubble port-forward
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Set the Hubble endpoint
export HUBBLE_SERVER=localhost:4245

# Verify connectivity
hubble status
hubble observe --last 10
```

### Observing Network Flows

```bash
# Watch all traffic to/from a pod
hubble observe \
  --pod production/api-server \
  --follow

# Watch dropped flows (policy violations)
hubble observe \
  --verdict DROPPED \
  --namespace production \
  --follow

# Filter by protocol and port
hubble observe \
  --namespace production \
  --protocol TCP \
  --port 5432 \
  --follow

# Show flows between specific pods
hubble observe \
  --from-pod production/api-server \
  --to-pod production/postgres-0

# Output as JSON for log ingestion
hubble observe \
  --namespace production \
  --output json \
  --last 100 | \
  jq 'select(.verdict == "DROPPED") | {src: .source.namespace + "/" + .source.pod_name, dst: .destination.namespace + "/" + .destination.pod_name, reason: .drop_reason_desc}'

# Network policy analysis — which policies are hitting
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --output json | \
  jq -r '.drop_reason_desc' | \
  sort | uniq -c | sort -rn
```

### Hubble UI for Visual Flow Analysis

```bash
# Enable Hubble UI (if not already installed)
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set hubble.ui.enabled=true

# Access the UI
kubectl port-forward -n kube-system svc/hubble-ui 12000:80

# Open browser to http://localhost:12000
```

---

## Systematic Network Debugging Methodology

When a network problem is reported, follow this sequence to avoid chasing symptoms:

### Step 1: Establish the Scope

```bash
# Is the problem affecting all pods or just specific ones?
# Test from multiple pods in the same namespace
for pod in $(kubectl get pods -n production -o name | head -5); do
    echo "=== $pod ==="
    kubectl exec $pod -n production -- curl -s -o /dev/null -w "%{http_code}" \
      http://target-service.production:8080/health
done

# Is the problem affecting specific nodes?
kubectl get pods -n production -o wide | grep -v Running

# Is DNS working?
kubectl exec netshoot-debug -n production -- \
  nslookup target-service.production.svc.cluster.local
```

### Step 2: Layer-by-Layer Isolation

```bash
# Layer 3: Can we reach the pod IP directly?
POD_IP=$(kubectl get pod target-pod -n production -o jsonpath='{.status.podIP}')
kubectl exec netshoot-debug -n production -- ping -c 3 $POD_IP

# Layer 4: Can we reach the pod port directly (bypassing Service)?
kubectl exec netshoot-debug -n production -- \
  nc -zv $POD_IP 8080

# Layer 4: Can we reach the Service ClusterIP?
SERVICE_IP=$(kubectl get svc target-service -n production -o jsonpath='{.spec.clusterIP}')
kubectl exec netshoot-debug -n production -- \
  nc -zv $SERVICE_IP 8080

# Layer 7: Does HTTP work?
kubectl exec netshoot-debug -n production -- \
  curl -v http://target-service.production:8080/health
```

### Step 3: Identify Network Policy Impact

```bash
# List all NetworkPolicies that could affect the target pod
kubectl get networkpolicy -n production -o json | \
  jq --arg podlabels "$(kubectl get pod target-pod -n production -o jsonpath='{.metadata.labels}')" \
  '.items[] | select(.spec.podSelector.matchLabels != null)'

# Check if any policy denies the source→target path
kubectl exec netshoot-debug -n production -- \
  curl -v --connect-timeout 5 http://target-service.production:8080/

# With Cilium, check policy enforcement
kubectl exec -n kube-system cilium-xxxx -- \
  cilium policy get | grep -A10 "production"
```

### Step 4: Check Service Endpoints

```bash
# Verify the service has healthy endpoints
kubectl get endpoints target-service -n production
# Empty ENDPOINTS means no matching pods are ready

# Check pod readiness
kubectl get pods -n production -l app=target-service
kubectl describe pod target-pod -n production | grep -A10 "Conditions:"

# Check if service selector matches pod labels
kubectl get svc target-service -n production -o jsonpath='{.spec.selector}'
kubectl get pods -n production --show-labels | grep target-service
```

### Step 5: Verify kube-proxy Rules

```bash
# From a privileged host pod:

# Check if DNAT rule exists for the service
iptables -t nat -L KUBE-SERVICES -n | grep $SERVICE_IP

# Check if endpoints are programmed
iptables -t nat -L | grep KUBE-ENDPOINTS

# For IPVS mode clusters:
ipvsadm -Ln | grep -A5 $SERVICE_IP
```

---

## Quick Reference: Tool Selection Matrix

| Problem | Tool | Command Pattern |
|---|---|---|
| Pod connectivity | netshoot + ping/nc | `nc -zv <ip> <port>` |
| DNS resolution | dig/nslookup | `dig @<dns-ip> <name>` |
| HTTP debugging | curl | `curl -v --trace-ascii -` |
| Packet capture | tcpdump | `tcpdump -i eth0 -nn -v` |
| Connection tracing | ss/netstat | `ss -tunp` |
| Route debugging | ip route | `ip route get <ip>` |
| iptables analysis | iptables-save | `iptables-save \| grep <ip>` |
| Cilium flows | hubble | `hubble observe --verdict DROPPED` |
| TLS debugging | openssl | `openssl s_client -connect <host>:<port>` |
| MTU issues | ping with size | `ping -M do -s 1400 <ip>` |

The network debugging toolkit is most effective when used systematically: confirm DNS works before investigating TCP connectivity, confirm TCP works before investigating HTTP behavior, and confirm direct pod-to-pod connectivity before investigating Service-layer issues.
