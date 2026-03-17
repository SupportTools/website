---
title: "Kubernetes Network Troubleshooting: tcpdump, conntrack, and eBPF Diagnostics"
date: 2028-12-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "tcpdump", "eBPF", "conntrack", "Troubleshooting"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Kubernetes network troubleshooting using tcpdump packet capture, conntrack connection tracking inspection, and eBPF-based real-time network diagnostics for diagnosing connectivity failures, latency spikes, and packet drops."
more_link: "yes"
url: "/kubernetes-network-troubleshooting-tcpdump-conntrack-ebpf-diagnostics/"
---

Network problems in Kubernetes are among the most difficult to diagnose because the failure can exist at any of a dozen layers: DNS resolution, iptables DNAT/SNAT rules, conntrack table exhaustion, CNI plugin misconfiguration, kube-proxy mode differences, mTLS handshake failures, or upstream load balancer behavior. The difference between a 5-minute resolution and a 5-hour investigation is having the right capture and inspection tools ready and knowing which layer to examine first. This post covers a systematic methodology using tcpdump for packet capture, conntrack for connection state inspection, and eBPF-based tools (bpftrace, Cilium Hubble, Retina) for high-frequency kernel-level visibility.

<!--more-->

## Diagnostic Hierarchy

Before reaching for packet capture, exhaust lower-cost diagnostics:

```bash
# Step 1: Verify pod-to-pod connectivity at the IP layer
POD_A_IP=$(kubectl get pod pod-a -n production -o jsonpath='{.status.podIP}')
POD_B_IP=$(kubectl get pod pod-b -n production -o jsonpath='{.status.podIP}')

kubectl exec -n production pod-a -- \
  ping -c 5 -W 1 "${POD_B_IP}"

# Step 2: Verify service DNS resolution
kubectl exec -n production pod-a -- \
  nslookup api-service.production.svc.cluster.local

# Step 3: Verify service connectivity at TCP layer
kubectl exec -n production pod-a -- \
  wget -qO- --timeout=5 http://api-service.production.svc.cluster.local:8080/health

# Step 4: Check if the service has endpoints
kubectl get endpoints api-service -n production
# NAME          ENDPOINTS                                   AGE
# api-service   10.244.1.5:8080,10.244.2.7:8080,10.244.3.9:8080   24h

# Step 5: Check service iptables rules on the node
NODE=$(kubectl get pod pod-a -n production -o jsonpath='{.spec.nodeName}')
kubectl debug node/"${NODE}" -it --image=nicolaka/netshoot \
  -- iptables -t nat -L KUBE-SERVICES | grep api-service
```

## tcpdump Inside Running Pods

### Using a Debugging Sidecar

For pods without tcpdump installed, use kubectl debug to add a temporary sidecar to the target pod's network namespace:

```bash
# Attach a debugging container to the target pod's network namespace
# This shares the network namespace without interrupting the running container
kubectl debug -it pod/api-service-7d9f8b \
  -n production \
  --image=nicolaka/netshoot \
  --target=api-service \
  -- tcpdump -i any -n -s 0 \
  'port 8080 and (tcp[tcpflags] & (tcp-rst|tcp-fin) != 0 or tcp[13] & 0x02 != 0)'

# Capture DNS queries
kubectl debug -it pod/api-service-7d9f8b \
  -n production \
  --image=nicolaka/netshoot \
  --target=api-service \
  -- tcpdump -i any -n -s 0 port 53

# Capture and write to file for offline analysis
kubectl debug -it pod/api-service-7d9f8b \
  -n production \
  --image=nicolaka/netshoot \
  --target=api-service \
  -- tcpdump -i any -n -s 0 -w /tmp/capture.pcap port 8080
```

### Capturing from the Node's Network Namespace

When the issue involves the pod's veth pair, calico/cilium interfaces, or NodePort handling:

```bash
# Get the pod's veth interface name from the node
NODE="worker-node-1"
POD_IP="10.244.1.5"

# Open a privileged debug pod on the node
kubectl debug node/"${NODE}" -it \
  --image=nicolaka/netshoot \
  -- bash

# Inside the debug container, find the veth interface for the pod
# The pod's interface inside the node's network namespace is its veth peer
ip route get "${POD_IP}" | grep dev
# 10.244.1.5 dev cali1a2b3c4d5e6 src 192.168.1.10

# Capture on the pod's veth interface
tcpdump -i cali1a2b3c4d5e6 -n -s 0 \
  -w /host/tmp/pod-capture.pcap

# For Flannel VXLAN — capture encapsulated traffic
tcpdump -i flannel.1 -n -s 0 'host 10.244.1.5'

# For Calico BGP — capture BGP route advertisements
tcpdump -i eth0 -n -s 0 'tcp port 179'
```

### tcpdump Filter Reference for Common Kubernetes Issues

```bash
# Capture TCP resets (unexpected connection termination)
tcpdump -i any -n 'tcp[tcpflags] & tcp-rst != 0'

# Capture TCP retransmissions (packet loss indicator)
# (requires Wireshark for full retransmit detection; tcpdump can catch RSTs)
tcpdump -i any -n 'tcp and (tcp[tcpflags] & tcp-syn != 0)'

# Capture ICMP unreachables (routing problems)
tcpdump -i any -n 'icmp[0] = 3'

# Capture DNS responses with NXDOMAIN (name resolution failures)
tcpdump -i any -n 'udp port 53 and udp[10] & 0x0f = 3'

# Capture traffic to/from a specific service IP
SERVICE_IP="10.96.45.123"
tcpdump -i any -n "host ${SERVICE_IP}"

# Capture with timestamps and hex dump for protocol analysis
tcpdump -i any -n -tttt -X 'host 10.244.1.5 and port 8080'
```

## conntrack: Connection Tracking Inspection

iptables-based kube-proxy relies heavily on netfilter conntrack. Table exhaustion, stale entries, and misconfigured timeouts cause intermittent failures that are invisible in packet captures.

```bash
# Open a privileged debug pod on the node
kubectl debug node/worker-node-1 -it \
  --image=nicolaka/netshoot \
  -- bash

# Check conntrack table size and current usage
cat /proc/sys/net/netfilter/nf_conntrack_max
# 524288

cat /proc/sys/net/netfilter/nf_conntrack_count
# 487291   <-- 93% full — near exhaustion threshold

# List conntrack entries for a specific service
conntrack -L -p tcp \
  --dst-nat "${SERVICE_IP}" \
  --dport 8080 \
  2>/dev/null | head -20

# Example output:
# tcp      6 86340 ESTABLISHED src=10.244.1.5 dst=10.96.45.123 sport=34521 dport=8080
#           src=10.244.2.7 dst=10.244.1.5 sport=8080 dport=34521 [ASSURED] mark=0 use=1

# Count entries by state
conntrack -L 2>/dev/null | awk '{print $4}' | sort | uniq -c | sort -rn
#  312847 ESTABLISHED
#  174444 TIME_WAIT
#   15892 SYN_SENT
#    4108 CLOSE_WAIT

# TIME_WAIT overload is common in high-throughput services
# It indicates short-lived connections with default 120s TIME_WAIT timeout

# Delete stale TIME_WAIT entries for a specific IP (last resort)
conntrack -D -s 10.244.1.5 --state TIME_WAIT

# Flush the entire table (DANGER: drops all tracked connections)
# conntrack -F
```

### conntrack Configuration Tuning

```bash
# Increase conntrack table size (requires root or privileged container)
# Permanent change via sysctl ConfigMap in Kubernetes
cat /proc/sys/net/netfilter/nf_conntrack_max
echo 1048576 > /proc/sys/net/netfilter/nf_conntrack_max

# Reduce TIME_WAIT timeout for high-connection-rate services
echo 30 > /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_time_wait

# Apply via Kubernetes node configuration (e.g., with Butane/MachineConfig)
# Or via DaemonSet with privileged containers
```

```yaml
# sysctl-tuning-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sysctl-tuning
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: sysctl-tuning
  template:
    metadata:
      labels:
        app: sysctl-tuning
    spec:
      tolerations:
      - operator: Exists
        effect: NoSchedule
      hostNetwork: true
      hostPID: true
      initContainers:
      - name: sysctl
        image: busybox:1.36
        command:
        - /bin/sh
        - -c
        - |
          sysctl -w net.netfilter.nf_conntrack_max=1048576
          sysctl -w net.netfilter.nf_conntrack_tcp_timeout_time_wait=30
          sysctl -w net.netfilter.nf_conntrack_tcp_timeout_established=3600
          sysctl -w net.core.somaxconn=65535
          sysctl -w net.ipv4.tcp_max_syn_backlog=65535
        securityContext:
          privileged: true
      containers:
      - name: pause
        image: gcr.io/google-containers/pause:3.9
        resources:
          requests:
            cpu: 1m
            memory: 1Mi
```

## iptables Rule Inspection

```bash
# View NAT rules for Kubernetes services (critical for kube-proxy debugging)
iptables -t nat -L KUBE-SERVICES -n --line-numbers | head -30

# Trace packet flow through iptables for a specific connection
# This shows exactly which rules match
modprobe nf_log_ipv4
iptables -t raw -A PREROUTING \
  -p tcp \
  -d 10.96.45.123 \
  --dport 8080 \
  -j TRACE

iptables -t raw -A OUTPUT \
  -p tcp \
  -d 10.96.45.123 \
  --dport 8080 \
  -j TRACE

# Read trace output
dmesg | grep "TRACE:"
# Or: journalctl -k | grep TRACE

# Clean up after tracing
iptables -t raw -D PREROUTING -p tcp -d 10.96.45.123 --dport 8080 -j TRACE
iptables -t raw -D OUTPUT -p tcp -d 10.96.45.123 --dport 8080 -j TRACE

# Check if a service's iptables rules exist
iptables -t nat -S | grep -c "KUBE-SVC-"
# 847   <-- 847 service chains

# Show the chain for a specific service (get from kubectl get svc)
SERVICE_CHAIN=$(iptables -t nat -S KUBE-SERVICES | \
  grep "10.96.45.123" | grep -o 'KUBE-SVC-[A-Z0-9]*')
iptables -t nat -L "${SERVICE_CHAIN}" -n
```

## eBPF Diagnostics with bpftrace

bpftrace enables kernel-level visibility without recompiling or loading kernel modules:

```bash
# Install bpftrace in a privileged debug pod
kubectl run bpftrace-debug \
  --image=quay.io/iovisor/bpftrace:latest \
  --privileged \
  --restart=Never \
  --rm -it \
  -- bash

# Inside the debug pod:

# 1. Trace TCP connection attempts and their outcomes
bpftrace -e '
kprobe:tcp_v4_connect {
  printf("CONNECT pid=%d comm=%s src=%s:%d dst=%s:%d\n",
    pid, comm,
    ntop(AF_INET, ((struct sock*)arg0)->__sk_common.skc_rcv_saddr),
    ((struct sock*)arg0)->__sk_common.skc_num,
    ntop(AF_INET, ((struct sock*)arg0)->__sk_common.skc_daddr),
    ntohs(((struct sock*)arg0)->__sk_common.skc_dport)
  );
}
'

# 2. Trace TCP RSTs being sent (connection reset events)
bpftrace -e '
kprobe:tcp_send_active_reset {
  $sk = (struct sock*)arg0;
  printf("RST sent src=%s:%d dst=%s:%d\n",
    ntop(2, $sk->__sk_common.skc_rcv_saddr),
    $sk->__sk_common.skc_num,
    ntop(2, $sk->__sk_common.skc_daddr),
    ntohs($sk->__sk_common.skc_dport)
  );
}
'

# 3. Trace DNS query latency from all processes
bpftrace -e '
uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo {
  @start[tid] = nsecs;
}
uretprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo {
  $elapsed = (nsecs - @start[tid]) / 1000000;
  printf("DNS resolve: %s took %dms\n", comm, $elapsed);
  delete(@start[tid]);
  if ($elapsed > 100) {
    printf("  WARNING: slow DNS resolution (>100ms)\n");
  }
}
'

# 4. Count packet drops per reason code
bpftrace -e '
kprobe:kfree_skb {
  @drops[arg1] = count();
}
interval:s:5 {
  print(@drops);
  clear(@drops);
}
'
```

## Cilium Hubble for Production Network Observability

If the cluster uses Cilium as the CNI, Hubble provides eBPF-powered network flow observability without requiring privileged containers:

```bash
# Enable Hubble if not already enabled
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true

# Install the Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -sSL "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz" | \
  tar xz -C /usr/local/bin

# Forward Hubble relay port
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe all traffic in the production namespace
hubble observe \
  --namespace production \
  --follow

# Filter for dropped packets
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --follow

# Observe traffic to/from a specific pod
hubble observe \
  --namespace production \
  --pod api-service-7d9f8b \
  --follow

# Get flow summary for the past hour
hubble observe \
  --namespace production \
  --since 1h \
  --output json | \
  jq 'select(.verdict == "DROPPED") | {
    src: .source.workloads[0].name,
    dst: .destination.workloads[0].name,
    reason: .drop_reason_desc
  }' | sort | uniq -c | sort -rn
```

## Network Policy Debugging

```bash
# Verify network policies applying to a pod
kubectl get networkpolicies -n production \
  --output=custom-columns='NAME:.metadata.name,POD-SELECTOR:.spec.podSelector'

# Use cilium monitor to see policy decisions
# (Cilium-specific: shows allow/deny at eBPF level)
kubectl exec -n kube-system -l k8s-app=cilium \
  -- cilium monitor \
  --type drop \
  --from-pod production/pod-a \
  --to-pod production/pod-b

# Test specific policy connectivity
kubectl exec -n production pod-a -- \
  nc -zv api-service.production.svc.cluster.local 8080
# Connection to api-service.production.svc.cluster.local 8080 port [tcp/*] succeeded!
# OR
# nc: getaddrinfo: Name or service not known  <-- DNS issue
# nc: connect to ... port 8080 (tcp) failed: Connection refused  <-- No listener
# nc: connect to ... port 8080 (tcp) timed out  <-- Likely policy/firewall block

# Test egress from a specific namespace
kubectl run nettest \
  --image=nicolaka/netshoot \
  --restart=Never \
  --rm -it \
  -n production \
  -- nc -zv external-api.example.com 443
```

## DNS Troubleshooting

DNS failures are the most common Kubernetes network issue after startup:

```bash
# Check CoreDNS health
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50

# Test DNS resolution from a pod
kubectl exec -n production pod-a -- \
  nslookup -debug kubernetes.default.svc.cluster.local

# Check CoreDNS configmap for forwarding rules
kubectl get configmap coredns -n kube-system -o yaml

# Trace DNS queries with dnstap (CoreDNS plugin)
# Enable in Corefile:
# dnstap /var/log/dnstap.sock full
# then monitor the socket

# Check for DNS query timeouts using the DNS plugin metrics
kubectl exec -n kube-system \
  $(kubectl get pod -n kube-system -l k8s-app=kube-dns \
    -o jsonpath='{.items[0].metadata.name}') \
  -- wget -qO- http://localhost:9153/metrics | \
  grep -E 'coredns_dns_requests_total|coredns_forward_request_duration'
```

## Packet Drop Analysis with Retina

Microsoft's Retina provides eBPF-based packet drop analysis as a Kubernetes operator:

```bash
# Install Retina
helm repo add retina https://microsoft.github.io/retina/charts
helm repo update

helm upgrade --install retina retina/retina \
  --namespace kube-system \
  --set operator.enabled=true \
  --set agent.enabled=true \
  --set enabledPlugin_linux="dropreason,packetforward,linuxutil,dns"

# Create a RetinaCapture to capture packets for analysis
kubectl apply -f - <<EOF
apiVersion: retina.sh/v1alpha1
kind: Capture
metadata:
  name: api-service-capture
  namespace: production
spec:
  captureConfiguration:
    captureOption:
      packetSize: 96      # Capture only headers
      captureTarget:
        namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: production
        podSelector:
          matchLabels:
            app: api-service
    duration: "30s"
    maxCaptureSize: 100   # MB
  outputConfiguration:
    hostPath: /tmp/captures/
EOF

# View drop reason metrics via Prometheus
# retina_drop_count{direction, drop_reason, namespace, podname} counter
```

## Systematic Troubleshooting Runbook

```bash
#!/bin/bash
# k8s-net-diag.sh — systematic Kubernetes network diagnostic

set -euo pipefail

NAMESPACE="${1:-production}"
SRC_POD="${2:-}"
DST_SERVICE="${3:-}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "=== Kubernetes Network Diagnostic ==="
log "Namespace: ${NAMESPACE}"
log "Source Pod: ${SRC_POD:-'(all)'}"
log "Target Service: ${DST_SERVICE:-'(all)'}"

# 1. Check DNS resolution
if [ -n "${SRC_POD}" ] && [ -n "${DST_SERVICE}" ]; then
  log "--- DNS Resolution ---"
  kubectl exec -n "${NAMESPACE}" "${SRC_POD}" -- \
    nslookup "${DST_SERVICE}.${NAMESPACE}.svc.cluster.local" 2>&1 | \
    grep -E "Address|Name|error" || true
fi

# 2. Check service endpoints
if [ -n "${DST_SERVICE}" ]; then
  log "--- Service Endpoints ---"
  kubectl get endpoints "${DST_SERVICE}" -n "${NAMESPACE}"
fi

# 3. Check network policies
log "--- Network Policies ---"
kubectl get networkpolicies -n "${NAMESPACE}" \
  -o custom-columns='NAME:.metadata.name,PODSEL:.spec.podSelector.matchLabels'

# 4. Check node connectivity
log "--- Node Network Status ---"
kubectl get nodes -o wide | awk '{print $1, $6}'

# 5. Check conntrack on the source pod's node
if [ -n "${SRC_POD}" ]; then
  NODE=$(kubectl get pod "${SRC_POD}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.nodeName}')
  log "--- conntrack on node ${NODE} ---"
  kubectl debug node/"${NODE}" \
    --image=nicolaka/netshoot \
    --quiet \
    -- bash -c "
      echo 'conntrack count/max:'
      cat /proc/sys/net/netfilter/nf_conntrack_count
      cat /proc/sys/net/netfilter/nf_conntrack_max
      echo 'conntrack states:'
      conntrack -L 2>/dev/null | awk '{print \$4}' | sort | uniq -c
    " 2>/dev/null || log "Could not access conntrack (insufficient privileges)"
fi

log "=== Diagnostic complete ==="
```

Network troubleshooting in Kubernetes becomes tractable with a structured methodology: DNS and endpoint validation first, then packet capture at the pod or veth level, then conntrack state inspection for NAT-related issues, and finally eBPF-based tools for kernel-level visibility when packet captures alone are insufficient. Having these tools pre-configured in a debugging toolkit container that can be deployed on any node within seconds separates teams that resolve network incidents quickly from those that spend hours searching for the right command.
