---
title: "Kubernetes Network Debugging Toolkit: netshoot, tcpdump in Pods, and eBPF Network Tracing"
date: 2031-10-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Debugging", "netshoot", "tcpdump", "eBPF", "Troubleshooting"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to diagnosing Kubernetes network issues using netshoot ephemeral containers, tcpdump packet capture in pods, and eBPF-based network tracing with Cilium and bpftrace."
more_link: "yes"
url: "/kubernetes-network-debugging-toolkit-netshoot-tcpdump-ebpf/"
---

Network issues in Kubernetes are uniquely challenging. A connection failure between two pods could be a DNS resolution problem, a CNI misconfiguration, a network policy blocking traffic, a service endpoint not being programmed, or a broken iptables/eBPF rule in the data plane. Diagnosing the problem requires tools that understand Kubernetes abstractions while having deep visibility into the underlying network stack.

This guide builds a systematic debugging methodology using three complementary toolsets: netshoot ephemeral containers for interactive troubleshooting, tcpdump for packet-level diagnosis, and eBPF tracing for data-plane observability without modifying workload pods.

<!--more-->

# Kubernetes Network Debugging Toolkit

## The Three Layers of Kubernetes Networking

Before picking up tools, map the problem to a layer:

```
Layer 1: DNS resolution
  └── CoreDNS → kube-dns service → DNS policy

Layer 2: Service routing
  └── ClusterIP → kube-proxy iptables/ipvs or eBPF → Endpoints

Layer 3: Pod-to-pod connectivity
  └── CNI plugin (Cilium/Calico/Flannel) → veth pairs → overlays/routes

Layer 4: Network policies
  └── iptables rules or eBPF programs enforcing NetworkPolicy objects

Layer 5: Ingress/Load balancer
  └── Controller → backend pods → health checks
```

Each layer has distinct failure modes and appropriate tools.

## Tool 1: netshoot — The Swiss Army Container

netshoot is a container image packed with network diagnostic tools. Deploy it as an ephemeral container in a running pod's network namespace to inspect the pod's network stack from the inside.

### Available Tools in netshoot

```
curl, wget, httpie        — HTTP testing
nmap, ncat                — port scanning and raw connections
tcpdump, tshark           — packet capture
dig, drill, nslookup      — DNS queries
traceroute, mtr           — path tracing
ss, netstat               — socket inspection
ip, ifconfig, route       — interface and routing
iperf3                    — bandwidth testing
socat                     — socket relay
strace                    — system call tracing
```

### Deploying as an Ephemeral Container

Ephemeral containers are injected into an existing pod without restarting it. They share the pod's network namespace, PID namespace (optionally), and process group.

```bash
# Inject netshoot into a running pod
kubectl debug -it \
  --image=nicolaka/netshoot:latest \
  --target=app-container \
  pod/my-app-pod-abc123 \
  -n production \
  -- bash

# The ephemeral container sees the same network interfaces as my-app-pod
ip addr show
# 1: lo: <LOOPBACK,UP,LOWER_UP>
#     inet 127.0.0.1/8 scope host lo
# 3: eth0@if45: <BROADCAST,MULTICAST,UP,LOWER_UP>
#     inet 10.244.3.17/32 scope global eth0
```

### Standalone Debug Pod in the Same Namespace

When you want a fresh pod rather than an ephemeral container:

```yaml
# netshoot-debug.yaml
apiVersion: v1
kind: Pod
metadata:
  name: netshoot-debug
  namespace: production
spec:
  containers:
    - name: netshoot
      image: nicolaka/netshoot:latest
      command: ["sleep", "3600"]
      securityContext:
        capabilities:
          add:
            - NET_ADMIN
            - NET_RAW
  restartPolicy: Never
  nodeSelector:
    kubernetes.io/hostname: worker-node-03  # pin to specific node for debugging
```

```bash
kubectl apply -f netshoot-debug.yaml
kubectl exec -it netshoot-debug -n production -- bash
```

## Diagnosing Common Problems

### DNS Failures

```bash
# Inside the debug pod or ephemeral container:

# Check basic DNS resolution
dig kubernetes.default.svc.cluster.local
# Expected: A record pointing to ClusterIP of kubernetes service

# Check if CoreDNS is reachable
dig @10.96.0.10 kubernetes.default.svc.cluster.local
# 10.96.0.10 = default kube-dns service ClusterIP

# Check search domains (from /etc/resolv.conf)
cat /etc/resolv.conf
# nameserver 10.96.0.10
# search production.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5

# Test service resolution
nslookup my-service.production.svc.cluster.local
nslookup my-service  # should expand via search domains

# Test external DNS
dig @10.96.0.10 google.com
# If this fails, CoreDNS upstream forwarding is broken

# Check CoreDNS pods are running
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

### Service Connectivity

```bash
# Inside the debug pod:

# Test HTTP connectivity to a service
curl -v http://my-service.production.svc.cluster.local:8080/healthz

# Test TCP connectivity (without HTTP)
nc -zv my-service.production.svc.cluster.local 8080
# Connection to my-service.production.svc.cluster.local 8080 port [tcp/*] succeeded!

# Check what IP the service resolves to
dig +short my-service.production.svc.cluster.local
# 10.100.50.23 (ClusterIP)

# Verify endpoints are programmed
kubectl get endpoints my-service -n production
# NAME         ENDPOINTS                             AGE
# my-service   10.244.3.17:8080,10.244.5.22:8080     5d

# Check if a specific endpoint is reachable (bypassing service)
curl -v http://10.244.3.17:8080/healthz
```

### Pod-to-Pod Network Policy Debugging

```bash
# Check if NetworkPolicy is blocking traffic
kubectl get networkpolicy -n production

kubectl describe networkpolicy my-app-netpol -n production
# PodSelector: app=my-app
# Ingress:
#   From:
#     PodSelector: app=frontend
#   Ports:
#     Port: 8080/TCP

# Test whether policy selector matches
kubectl get pods -n production -l app=frontend

# From a frontend pod, test connectivity to my-app
kubectl exec -it frontend-pod -n production -- \
  curl -v http://my-app-service:8080/healthz

# From a non-frontend pod, test that it IS blocked
kubectl exec -it other-pod -n production -- \
  nc -zv -w3 my-app-service 8080
# nc: connect to my-app-service port 8080 (tcp) failed: Connection refused
# OR: timed out (no ICMP reject, just drop)
```

## Tool 2: tcpdump in Pods

tcpdump captures raw packets and is essential for diagnosing encryption mismatches, TLS handshake failures, retransmissions, and RST storms.

### Capture Inside a Pod

```bash
# Method 1: Ephemeral container with NET_RAW capability
kubectl debug -it \
  --image=nicolaka/netshoot:latest \
  pod/my-app-pod-abc123 \
  -n production \
  -- tcpdump -i eth0 -w /tmp/capture.pcap port 8080

# In a separate terminal, copy the capture file out
kubectl cp production/my-app-pod-abc123:/tmp/capture.pcap ./capture.pcap -c debugger

# Open in Wireshark locally
wireshark capture.pcap
```

### Capture with Filtering

```bash
# Capture HTTP traffic (not TLS)
tcpdump -i eth0 -A -s 0 'tcp port 8080 and (tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x47455420)'

# Capture all traffic to/from a specific IP
tcpdump -i eth0 -w /tmp/cap.pcap host 10.244.5.22

# Capture DNS queries
tcpdump -i eth0 -w /tmp/dns.pcap port 53

# Capture only SYN packets (new connections)
tcpdump -i eth0 'tcp[tcpflags] & (tcp-syn) != 0' -n

# Capture and show payload as text
tcpdump -i eth0 -A -s 65535 port 8080
```

### Capturing on the Node's Virtual Interface

Sometimes you need to see traffic at the node level rather than from inside a pod. Each pod has a veth pair: one end in the pod, one end on the node.

```bash
# Find the veth interface for a specific pod
POD_IP=$(kubectl get pod my-app-pod -n production -o jsonpath='{.status.podIP}')

# On the node (via a privileged debug pod or SSH):
ip route get "$POD_IP"
# 10.244.3.17 dev cali1a2b3c4d5e src 192.168.1.10

# Capture on the veth
tcpdump -i cali1a2b3c4d5e -w /tmp/veth-cap.pcap

# Alternative: find veth by ifindex from inside the pod
kubectl exec my-app-pod -n production -- \
  cat /sys/class/net/eth0/iflink
# 45
# On the node:
ip link | grep -A1 "45:"
# 45: cali1a2b3c4d5e@if3: <BROADCAST,MULTICAST,UP,LOWER_UP>
```

### Decrypting TLS Captures

For services using TLS, you need the session keys. If your application supports SSLKEYLOGFILE, set it and capture simultaneously:

```bash
# Set SSLKEYLOGFILE in the pod's environment (requires pod restart or patch)
kubectl patch deployment my-app -n production \
  --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/env/-","value":{"name":"SSLKEYLOGFILE","value":"/tmp/tls-keys.log"}}]'

# Capture traffic
kubectl exec -it my-app-pod -n production -- \
  tcpdump -i eth0 -w /tmp/tls-cap.pcap port 443

# Extract key log and pcap
kubectl cp production/my-app-pod:/tmp/tls-keys.log ./tls-keys.log
kubectl cp production/my-app-pod:/tmp/tls-cap.pcap ./tls-cap.pcap

# Open in Wireshark: Edit > Preferences > Protocols > TLS > Pre-Master-Secret log filename
```

## Tool 3: eBPF Network Tracing

eBPF provides non-intrusive network tracing at kernel level. It can intercept packets at any point in the kernel's network stack without modifying pods or adding container overhead.

### Cilium's Hubble for Flow Observability

If you use Cilium CNI, Hubble provides real-time network flow visibility:

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name-all \
  https://github.com/cilium/hubble/releases/download/$HUBBLE_VERSION/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward to Hubble Relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe all flows in a namespace
hubble observe --namespace production --follow

# Filter to specific pod
hubble observe --pod production/my-app-pod --follow

# Show only dropped flows (policy violations)
hubble observe --verdict DROPPED --namespace production --follow

# Show flows to a specific service
hubble observe --to-pod production/backend-pod --follow

# Example output:
# Oct 02 14:23:45.123 [production] FORWARDED TCP 10.244.3.17:34521 -> 10.244.5.22:8080 to-endpoint
# Oct 02 14:23:45.234 [production] DROPPED TCP 10.244.7.31:45123 -> 10.244.5.22:8080 policy-denied
```

### bpftrace for Custom Network Tracing

```bash
# Run on the Kubernetes node (requires privileged access)
# DaemonSet with hostPID and hostNetwork can deploy this

# Trace all TCP connection attempts on the node
bpftrace -e '
kprobe:tcp_connect {
    $task = (struct task_struct *)curtask;
    $sk = (struct sock *)arg0;
    $raddr = $sk->__sk_common.skc_daddr;
    printf("TCP connect: PID=%d CMD=%-16s -> %s:%d\n",
        pid,
        comm,
        ntop($raddr),
        ($sk->__sk_common.skc_dport >> 8) | (($sk->__sk_common.skc_dport & 0xff) << 8)
    );
}'

# Count TCP RST events by destination port
bpftrace -e '
kprobe:tcp_send_reset {
    @resets_by_port[((struct sock *)arg0)->__sk_common.skc_dport] = count();
}
interval:s:10 {
    print(@resets_by_port);
    clear(@resets_by_port);
}'

# Trace DNS queries from pods
bpftrace -e '
kprobe:udp_sendmsg {
    $sk = (struct sock *)arg0;
    $dport = ($sk->__sk_common.skc_dport >> 8) | (($sk->__sk_common.skc_dport & 0xff) << 8);
    if ($dport == 53) {
        printf("DNS query: PID=%d CMD=%-16s\n", pid, comm);
    }
}'
```

### eBPF-Based Latency Measurement

```bash
# Measure TCP connection establishment latency
bpftrace -e '
kprobe:tcp_connect {
    @start[tid] = nsecs;
}

kretprobe:tcp_connect {
    if (@start[tid]) {
        $lat_us = (nsecs - @start[tid]) / 1000;
        @conn_latency_us = hist($lat_us);
        delete(@start[tid]);
    }
}

interval:s:30 {
    printf("TCP connect latency (us):\n");
    print(@conn_latency_us);
    clear(@conn_latency_us);
}'

# Measure HTTP request latency at the kernel socket level
bpftrace -e '
// Track when data arrives on a TCP socket
kprobe:tcp_recvmsg {
    @recv_start[tid] = nsecs;
}
kretprobe:tcp_recvmsg /retval > 0/ {
    if (@recv_start[tid]) {
        $lat = (nsecs - @recv_start[tid]) / 1000;
        @recv_lat = hist($lat);
        delete(@recv_start[tid]);
    }
}
interval:s:15 {
    print(@recv_lat);
    clear(@recv_lat);
}'
```

## Systematic Debugging Workflow

### Step-by-Step Connectivity Diagnosis

```bash
#!/usr/bin/env bash
# k8s-net-diag.sh — systematic Kubernetes network diagnosis

NAMESPACE=${1:-default}
SOURCE_POD=${2}
TARGET_SERVICE=${3}
TARGET_PORT=${4:-80}

echo "=== Kubernetes Network Diagnosis ==="
echo "Namespace: $NAMESPACE"
echo "Source: $SOURCE_POD → Target: $TARGET_SERVICE:$TARGET_PORT"
echo ""

# Step 1: DNS resolution
echo "--- Step 1: DNS Resolution ---"
kubectl exec "$SOURCE_POD" -n "$NAMESPACE" -- \
    nslookup "${TARGET_SERVICE}.${NAMESPACE}.svc.cluster.local" 2>&1 || true
echo ""

# Step 2: Service and endpoints
echo "--- Step 2: Service Endpoints ---"
kubectl get service "$TARGET_SERVICE" -n "$NAMESPACE" -o yaml | \
    grep -E "clusterIP|port|nodePort|targetPort" || true
kubectl get endpoints "$TARGET_SERVICE" -n "$NAMESPACE" || true
echo ""

# Step 3: NetworkPolicy check
echo "--- Step 3: NetworkPolicies in namespace ---"
kubectl get networkpolicies -n "$NAMESPACE" || true
echo ""

# Step 4: TCP connection test
echo "--- Step 4: TCP connectivity test ---"
kubectl exec "$SOURCE_POD" -n "$NAMESPACE" -- \
    nc -zv -w5 "${TARGET_SERVICE}.${NAMESPACE}.svc.cluster.local" "$TARGET_PORT" 2>&1 || true
echo ""

# Step 5: HTTP test
echo "--- Step 5: HTTP GET test ---"
kubectl exec "$SOURCE_POD" -n "$NAMESPACE" -- \
    curl -v --max-time 10 \
    "http://${TARGET_SERVICE}.${NAMESPACE}.svc.cluster.local:${TARGET_PORT}/" 2>&1 | \
    head -30 || true
```

### Network Policy Impact Analysis

```bash
# Identify which NetworkPolicies affect a specific pod
NAMESPACE=production
POD_LABELS=$(kubectl get pod my-app-pod -n "$NAMESPACE" -o jsonpath='{.metadata.labels}')

echo "Pod labels: $POD_LABELS"

# List all NetworkPolicies and check their selectors
kubectl get networkpolicies -n "$NAMESPACE" -o json | \
    jq -r '.items[] | "\(.metadata.name): podSelector=\(.spec.podSelector)"'

# Check Cilium policy verdict (if using Cilium)
kubectl exec -n kube-system cilium-xyz123 -- \
    cilium policy get | grep -A5 "my-app"

# Verify Calico network policy evaluation (if using Calico)
kubectl exec -n kube-system calico-node-xyz -- \
    calico-node -ip-tables-backend auto -show-policy-rule-mode
```

## Advanced: Packet Path Tracing with eBPF

Track a specific packet through the kernel's entire network stack:

```bash
# Use bpftrace to follow a single TCP connection through the stack
bpftrace -e '
// Fire when a TCP packet arrives from a specific IP
kprobe:ip_rcv {
    $skb = (struct sk_buff *)arg0;
    // (abbreviated — full skb parsing requires BTF vmlinux)
    @rcv_count = count();
}

kprobe:tcp_v4_rcv {
    @tcp_v4_rcv = count();
}

kprobe:tcp_data_queue {
    @tcp_data_queue = count();
}

kprobe:sk_data_ready {
    @sk_data_ready = count();
}

interval:s:5 {
    printf("Packet path counts per 5s:\n");
    printf("  ip_rcv:         %d\n", @rcv_count);
    printf("  tcp_v4_rcv:     %d\n", @tcp_v4_rcv);
    printf("  tcp_data_queue: %d\n", @tcp_data_queue);
    printf("  sk_data_ready:  %d\n", @sk_data_ready);
    clear(@rcv_count); clear(@tcp_v4_rcv);
    clear(@tcp_data_queue); clear(@sk_data_ready);
}'
```

## Deploying the Debug Toolkit as a DaemonSet

For persistent access to network debugging tools on every node:

```yaml
# netshoot-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: netshoot-node-debug
  namespace: kube-system
  labels:
    app: netshoot-debug
spec:
  selector:
    matchLabels:
      app: netshoot-debug
  template:
    metadata:
      labels:
        app: netshoot-debug
    spec:
      hostNetwork: true
      hostPID: true
      tolerations:
        - operator: Exists
      containers:
        - name: netshoot
          image: nicolaka/netshoot:latest
          command: ["sleep", "infinity"]
          securityContext:
            privileged: true
            capabilities:
              add:
                - NET_ADMIN
                - NET_RAW
                - SYS_ADMIN
                - SYS_PTRACE
          volumeMounts:
            - name: host-root
              mountPath: /host
              readOnly: true
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 200m
              memory: 128Mi
      volumes:
        - name: host-root
          hostPath:
            path: /
      priorityClassName: system-node-critical
```

```bash
# Use the DaemonSet pod on a specific node
NODE=worker-node-03
DEBUG_POD=$(kubectl get pod -n kube-system -l app=netshoot-debug \
  --field-selector spec.nodeName=$NODE \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -it "$DEBUG_POD" -n kube-system -- bash

# From inside the DaemonSet pod, you can inspect the host network:
nsenter -t 1 -n -- ip route
nsenter -t 1 -n -- iptables-save | grep KUBE
```

## Common Issues and Solutions

### Issue: Intermittent DNS Timeouts

```bash
# Check CoreDNS for UDP retries (ndots=5 causes 10 DNS lookups per connection)
cat /etc/resolv.conf
# options ndots:5  ← this triggers multiple lookups for short names

# Solution: Add ndots override to deployment
# spec.dnsConfig:
#   options:
#     - name: ndots
#       value: "1"  # or 2

# Check CoreDNS metrics
kubectl port-forward -n kube-system svc/kube-dns 9153:9153 &
curl http://localhost:9153/metrics | grep coredns_dns_request_duration
```

### Issue: Service Endpoints Not Updating

```bash
# Check if kube-proxy is healthy
kubectl get pods -n kube-system -l k8s-app=kube-proxy
kubectl logs -n kube-system -l k8s-app=kube-proxy --tail=50

# Check iptables rules for a service
SERVICE_IP=$(kubectl get svc my-service -n production -o jsonpath='{.spec.clusterIP}')
iptables-save | grep "$SERVICE_IP"

# Check IPVS rules if using ipvs mode
ipvsadm -ln | grep -A5 "$SERVICE_IP"

# Force kube-proxy resync
kubectl delete pod -n kube-system -l k8s-app=kube-proxy
```

## Summary

A systematic approach to Kubernetes network debugging requires tools at each layer:

- **netshoot ephemeral containers**: instant access to DNS, HTTP, TCP, and routing tools from inside any pod's network namespace
- **tcpdump**: packet-level diagnosis for TLS issues, retransmissions, and RST storms; capture on veth pairs to see node-level traffic
- **eBPF/Hubble**: non-intrusive flow visibility at the data plane, policy verdict observation, and latency measurement without pod modification
- **The diagnostic workflow**: always follow DNS → service endpoints → network policy → raw connectivity before capturing packets

The combination makes previously mysterious network failures tractable. Start with DNS, verify service endpoints, check network policies, then drop down to packet captures only when the higher-level tools have not identified the root cause.
