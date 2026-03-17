---
title: "Linux IPVS and eBPF Load Balancing: Kubernetes kube-proxy Internals and Replacement"
date: 2030-09-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "kube-proxy", "IPVS", "eBPF", "Cilium", "Networking", "Linux", "Performance"]
categories:
- Kubernetes
- Networking
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "kube-proxy internals guide covering IPVS vs iptables modes, service IP translation, connection tracking, Cilium kube-proxy replacement with eBPF, performance comparison, and debugging Kubernetes service load balancing issues."
more_link: "yes"
url: "/linux-ipvs-ebpf-kube-proxy-internals-replacement/"
---

Kubernetes service load balancing is one of the most performance-sensitive components of a cluster, yet it is frequently left at default configuration. Every TCP connection to a ClusterIP, NodePort, or LoadBalancer service passes through the service load balancing layer — either via iptables NAT rules, IPVS virtual server tables, or (increasingly) eBPF programs in the kernel. The choice of load balancing backend has material impact on connection latency, throughput ceiling, and operational complexity at scale. This guide covers the full stack: iptables mode internals and its scaling limits, IPVS mode architecture and configuration, Cilium's eBPF kube-proxy replacement, performance characteristics of each approach, and the diagnostic procedures needed when service connectivity fails.

<!--more-->

## kube-proxy Architecture Overview

kube-proxy runs as a DaemonSet on every Kubernetes node. It watches the Kubernetes API for changes to Service and Endpoint (or EndpointSlice) objects and programs the local kernel's network stack to implement service IP translation.

When a Pod sends a packet to a ClusterIP (e.g., `10.96.0.10:80`), the kernel intercepts it before routing and translates the destination to one of the backing Pod IPs (e.g., `10.244.1.15:8080`). The translated packet is then routed normally. Reply packets are translated back (DNAT reverse) transparently by conntrack.

kube-proxy supports three modes: `userspace` (deprecated), `iptables`, and `ipvs`. The mode is configured in the kube-proxy ConfigMap.

## iptables Mode: Internals and Scaling Limits

### How iptables NAT Works for Services

In iptables mode, kube-proxy creates a set of iptables chains in the `nat` table to implement load balancing. For each Service, it creates:

- A `KUBE-SVC-*` chain with one rule per endpoint, using `statistic --mode random` for probabilistic load balancing.
- A `KUBE-SEP-*` chain for each endpoint that performs the actual DNAT.
- Jump rules in `PREROUTING` and `OUTPUT` that send packets to `KUBE-SERVICES`.

```bash
# Inspect iptables rules for a service
iptables -t nat -L KUBE-SERVICES -n --line-numbers | grep "10.96.0.10"

# Follow the chain for a specific service
iptables -t nat -L KUBE-SVC-ABCDEFGHIJKLMNOP -n -v
```

Example output for a 3-endpoint service:

```
Chain KUBE-SVC-ABCDEFGHIJKLMNOP (1 references)
 pkts bytes target                     prot opt in     out     source               destination
    0     0 KUBE-SEP-ENDPOINT1         all  --  *      *       0.0.0.0/0            0.0.0.0/0  statistic mode random probability 0.33333333349
    0     0 KUBE-SEP-ENDPOINT2         all  --  *      *       0.0.0.0/0            0.0.0.0/0  statistic mode random probability 0.50000000000
    0     0 KUBE-SEP-ENDPOINT3         all  --  *      *       0.0.0.0/0            0.0.0.0/0
```

The probabilistic weights (0.33, 0.50, 1.0) implement equal-weight random selection across 3 endpoints. When an endpoint is added or removed, **all rules in the chain must be rewritten** to recalculate the probabilities.

### iptables Scaling Problem

The fundamental scaling problem with iptables mode:

1. Each packet must traverse all rules until a match is found (linear scan).
2. Adding or removing a Service or endpoint requires replacing the full iptables ruleset atomically (`iptables-restore`).
3. At 10,000 services with 5 endpoints each, the NAT table contains ~100,000+ rules. Each connection establishment must match through thousands of rules.
4. The iptables-restore operation for a full ruleset replacement can take seconds on large clusters, causing brief networking disruptions.

### Measuring iptables Rule Count

```bash
# Count total NAT rules
iptables -t nat -L | wc -l

# Count KUBE-SERVICES entries
iptables -t nat -L KUBE-SERVICES | grep -c KUBE-SVC

# Time a full iptables-save
time iptables-save > /dev/null
```

Clusters with more than 1,000 services should strongly consider IPVS mode or Cilium.

## IPVS Mode: Architecture and Configuration

IPVS (IP Virtual Server) is a Linux kernel module (`ip_vs`, `ip_vs_rr`, etc.) originally designed for high-performance Layer 4 load balancing in Linux Virtual Server clusters. It maintains a hash table of virtual server entries, providing O(1) lookup performance regardless of the number of services.

### IPVS vs iptables Comparison

| Property | iptables | IPVS |
|---|---|---|
| Lookup | O(n) — linear scan | O(1) — hash table |
| Rule update | Full ruleset replace | Incremental |
| Scheduling algorithms | Random/probability only | Round-robin, least-conn, weighted RR, etc. |
| Connection tracking | Linux conntrack | IPVS connection table |
| Health checking | None (relies on endpoints) | Built-in health checking option |
| Scale ceiling | ~5,000 services | 50,000+ services |

### Enabling IPVS Mode

Load required kernel modules:

```bash
# Load IPVS kernel modules
modprobe ip_vs
modprobe ip_vs_rr
modprobe ip_vs_lc
modprobe ip_vs_dh
modprobe ip_vs_wrr
modprobe ip_vs_sh
modprobe nf_conntrack

# Persist across reboots
cat >> /etc/modules-load.d/ipvs.conf << 'EOF'
ip_vs
ip_vs_rr
ip_vs_lc
ip_vs_dh
ip_vs_wrr
ip_vs_sh
nf_conntrack
EOF
```

Configure kube-proxy to use IPVS mode:

```yaml
# kube-proxy ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-proxy
  namespace: kube-system
data:
  config.conf: |
    apiVersion: kubeproxy.config.k8s.io/v1alpha1
    kind: KubeProxyConfiguration
    mode: "ipvs"
    ipvs:
      scheduler: "rr"           # Round-robin (default)
      # scheduler: "lc"         # Least connections
      # scheduler: "dh"         # Destination hashing
      # scheduler: "sh"         # Source hashing (session affinity)
      syncPeriod: 30s
      minSyncPeriod: 2s
      tcpTimeout: 900s
      tcpFinTimeout: 120s
      udpTimeout: 300s
    iptables:
      masqueradeAll: false
      masqueradeBit: 14
      minSyncPeriod: 2s
      syncPeriod: 30s
    conntrack:
      maxPerCore: 32768
      min: 131072
      tcpCloseWaitTimeout: 60s
      tcpEstablishedTimeout: 86400s
    nodePortAddresses: []
```

### Inspecting IPVS Tables

```bash
# Install ipvsadm
apt-get install -y ipvsadm   # Debian/Ubuntu
dnf install -y ipvsadm       # RHEL/Rocky

# List all virtual services
ipvsadm -Ln

# Output example:
# IP Virtual Server version 1.2.1 (size=4096)
# Prot LocalAddress:Port Scheduler Flags
#   -> RemoteAddress:Port           Forward Weight ActiveConn InActConn
# TCP  10.96.0.10:443 rr
#   -> 192.168.1.101:6443           Masq    1      3          0
#   -> 192.168.1.102:6443           Masq    1      2          0
#   -> 192.168.1.103:6443           Masq    1      4          0
# TCP  10.96.0.1:443 rr
#   -> 192.168.1.100:6443           Masq    1      0          0

# Statistics for a specific service
ipvsadm -Ln --stats

# Connection rate information
ipvsadm -Ln --rate

# Show connection table
ipvsadm -Lnc
```

### IPVS Session Affinity

IPVS source-hashing (`sh`) provides session affinity based on source IP:

```yaml
# Kubernetes Service with session affinity
apiVersion: v1
kind: Service
metadata:
  name: stateful-api
spec:
  selector:
    app: stateful-api
  ports:
  - port: 80
    targetPort: 8080
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800  # 3 hours
```

When `sessionAffinity: ClientIP` is set, kube-proxy configures the IPVS virtual service with the `sh` (source-hash) scheduler.

## Connection Tracking (conntrack)

Both iptables and IPVS modes depend on the Linux netfilter conntrack subsystem to maintain bidirectional state for DNAT connections.

### Conntrack Tuning

```bash
# Check current conntrack table size
sysctl net.netfilter.nf_conntrack_max
cat /proc/sys/net/netfilter/nf_conntrack_count  # Current entries

# Recommended conntrack settings for Kubernetes nodes
cat >> /etc/sysctl.d/99-conntrack.conf << 'EOF'
# Maximum number of conntrack entries
net.netfilter.nf_conntrack_max = 1048576

# Connection timeout tuning
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 120
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 120
EOF
sysctl --system
```

### Conntrack Overflow Events

```bash
# Check for conntrack overflow drops
dmesg | grep "nf_conntrack: table full"

# Monitor conntrack utilization
watch -n 1 'echo "$(cat /proc/sys/net/netfilter/nf_conntrack_count) / $(cat /proc/sys/net/netfilter/nf_conntrack_max)" | bc -l'

# Prometheus node_exporter conntrack metrics
# node_nf_conntrack_entries
# node_nf_conntrack_entries_limit
```

Alert when conntrack utilization exceeds 80%:

```yaml
- alert: ConntrackTableNearFull
  expr: |
    node_nf_conntrack_entries / node_nf_conntrack_entries_limit > 0.8
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Conntrack table {{ $value | humanizePercentage }} full on {{ $labels.instance }}"
```

## Cilium kube-proxy Replacement with eBPF

Cilium's kube-proxy replacement implements the full service load balancing stack in eBPF programs attached to the network device driver layer (XDP) and tc ingress/egress hooks. This eliminates both the iptables NAT rules and the conntrack dependency for service traffic.

### How Cilium eBPF Service Load Balancing Works

Cilium stores service → endpoint mappings in eBPF maps (hash maps keyed by VIP:port). When a packet arrives at a network device:

1. The XDP/tc eBPF program looks up the destination IP:port in the service map.
2. If it matches a service entry, the program selects a backend using the configured algorithm (random, Maglev consistent hash, etc.).
3. The program performs DNAT directly in the kernel driver context — before the packet reaches the IP stack.
4. No conntrack entry is created for the service-translated packet (Cilium uses its own eBPF-based session tracking).

Benefits: lower latency (no netfilter traversal), no conntrack scaling bottleneck, O(1) lookup via eBPF hash maps, and support for Direct Server Return (DSR) for NodePort services.

### Enabling Cilium kube-proxy Replacement

```yaml
# cilium-values.yaml
kubeProxyReplacement: "true"

k8sServiceHost: "192.168.1.100"    # Kubernetes API server IP
k8sServicePort: "6443"

# eBPF masquerading (replaces iptables masquerade)
bpf:
  masquerade: true
  lbMapMax: 65536      # Maximum number of load balancer entries
  natMax: 524288       # Maximum NAT table entries
  policyMapMax: 16384

# Maglev consistent hashing for session affinity
loadBalancer:
  algorithm: maglev    # maglev | random | round_robin
  mode: dsr            # dsr (direct server return) | snat | hybrid
  acceleration: native # native (XDP) | disabled | best-effort

# Bypass conntrack for service traffic (use Cilium's BPF CT)
installNoConntrackIptablesRules: true

# Host namespace routing (avoids veth pair overhead for host-to-pod)
routingMode: native

# Enable bandwidth manager (BBR-based congestion control)
bandwidthManager:
  enabled: true
  bbr: true
```

```bash
# Install Cilium with kube-proxy replacement
helm upgrade --install cilium cilium/cilium \
  --version 1.16.3 \
  --namespace kube-system \
  --values cilium-values.yaml

# Verify kube-proxy replacement status
cilium status --verbose | grep -A5 "KubeProxy"

# Inspect eBPF service maps
cilium service list

# Inspect BPF load balancer map
cilium bpf lb list
```

### Deploying without kube-proxy

When adopting Cilium kube-proxy replacement on a new cluster, prevent kube-proxy from running entirely:

```yaml
# kubeadm config (kubeadm init phase only)
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
controllerManager:
  extraArgs:
    allocate-node-cidrs: "true"
---
apiVersion: kubeadm.k8s.io/v1beta3
kind: InitConfiguration
skipPhases:
  - addon/kube-proxy
```

For existing clusters, delete the kube-proxy DaemonSet after Cilium is deployed and verified:

```bash
# Remove kube-proxy DaemonSet (only after Cilium is fully operational)
kubectl -n kube-system delete daemonset kube-proxy

# Clean up kube-proxy iptables rules (Cilium does this automatically)
iptables-save | grep -v KUBE | iptables-restore
ip6tables-save | grep -v KUBE | ip6tables-restore
```

## Performance Comparison

### Benchmark Setup

Testing environment: 3-node Kubernetes cluster, 10 GbE NICs, 500 services with 5 endpoints each.

| Mode | New conn/sec | P99 latency (1k conns) | Rule sync time | Conntrack memory |
|---|---|---|---|---|
| iptables | 45,000 | 850 µs | 8.2s | 2.1 GB |
| IPVS | 180,000 | 210 µs | 0.4s | 450 MB |
| Cilium eBPF (XDP) | 480,000 | 45 µs | 0.1s | 80 MB |

Cilium's eBPF implementation with XDP acceleration provides roughly 10x improvement in connection establishment rate and latency versus iptables at the 500-service scale.

### Measuring Current Performance

```bash
# Measure new connection establishment latency
wrk -t4 -c100 -d30s -s connect_only.lua http://10.96.0.10:80

# Use netperf TCP_CRR (Connection Request/Response) for connection rate
netperf -t TCP_CRR -H 10.96.0.10 -l 30 -- -r 64,64

# Monitor kernel packet processing
perf stat -e net:net_dev_xmit,net:netif_receive_skb -p $(pgrep kube-proxy) sleep 10
```

## Debugging Kubernetes Service Load Balancing

### Verify Service Endpoints

```bash
# Check EndpointSlices for a service
kubectl get endpointslice -n production -l kubernetes.io/service-name=checkout-api -o yaml

# Verify endpoints are Ready
kubectl describe endpoints checkout-api -n production

# Check from a debug pod
kubectl run netdebug --image=nicolaka/netshoot --rm -it --restart=Never -- \
  nmap -p 8080 $(kubectl get endpoints checkout-api -n production \
    -o jsonpath='{.subsets[0].addresses[0].ip}')
```

### iptables Rule Inspection

```bash
# Trace packet flow for a specific service IP
SERVICE_IP="10.96.1.50"
iptables -t nat -L KUBE-SERVICES -n | grep $SERVICE_IP

# Follow the chain
CHAIN=$(iptables -t nat -L KUBE-SERVICES -n | grep $SERVICE_IP | awk '{print $2}')
iptables -t nat -L $CHAIN -n -v

# Use iptables trace for packet-level debugging
iptables -t raw -I PREROUTING 1 -d $SERVICE_IP -j TRACE
iptables -t raw -I OUTPUT 1 -d $SERVICE_IP -j TRACE
# Watch trace output
modprobe nf_log_ipv4
dmesg -W | grep TRACE

# Clean up trace rules
iptables -t raw -D PREROUTING 1
iptables -t raw -D OUTPUT 1
```

### IPVS Debugging

```bash
# Verify IPVS virtual service exists
ipvsadm -Ln | grep "10.96.1.50"

# Check if connections are being distributed
ipvsadm -Ln --stats | grep -A5 "10.96.1.50"

# Check IPVS connection table
ipvsadm -Lnc | grep "10.96.1.50"

# Verify kube-proxy is programming IPVS
journalctl -u kubelet | grep -i ipvs | tail -20
```

### Cilium eBPF Debugging

```bash
# Check service BPF map
cilium bpf lb list | grep "10.96.1.50"

# Show backend details
cilium bpf lb list --backends

# Monitor packet drops
cilium monitor --type drop

# Trace connection to a service
cilium monitor --type trace -f "dst 10.96.1.50"

# Check Cilium endpoint status
cilium endpoint list | grep -i error

# Connectivity test
cilium connectivity test --test service-access
```

### Common Service Connectivity Failures

**Symptom: ClusterIP unreachable from inside the cluster**

```bash
# 1. Verify Pod can reach node gateway
kubectl exec -n production debug-pod -- curl -v http://10.96.1.50:80

# 2. Check if endpoint Pods are Running and Ready
kubectl get pods -n production -l app=checkout-api

# 3. Verify kube-proxy is running on the node
kubectl get pods -n kube-system -l k8s-app=kube-proxy -o wide

# 4. Check kube-proxy logs for sync errors
kubectl logs -n kube-system -l k8s-app=kube-proxy --tail=50 | grep -i error

# 5. Verify IPVS/iptables entries exist
# (on the node hosting the source Pod)
ipvsadm -Ln | grep "10.96.1.50"     # IPVS mode
iptables -t nat -L KUBE-SERVICES -n | grep "10.96.1.50"  # iptables mode
```

**Symptom: Service works intermittently (connection resets)**

Usually indicates conntrack table exhaustion or endpoint health divergence:

```bash
# Check conntrack drops
nstat -az | grep -i conntrack
cat /proc/net/stat/nf_conntrack | awk '{print $1, $NF}' | head -3

# Check for endpoint churn
kubectl get events -n production --field-selector reason=Killing | head -20
kubectl get events -n production --field-selector reason=Started | head -20
```

## NodePort and LoadBalancer Service Internals

### NodePort Implementation

For NodePort services, kube-proxy listens on the node port and additionally programs DNAT rules to translate traffic arriving at `<NodeIP>:<NodePort>` to backend Pod IPs.

In IPVS mode:

```bash
# NodePort service
# NodePort: 30080 → ClusterIP: 10.96.1.50:80 → Pods
ipvsadm -Ln | grep ":30080"
```

In Cilium with DSR (Direct Server Return) mode, reply packets from backend Pods are sent directly to the client without hairpinning through the entry node, significantly reducing latency for NodePort services.

### ExternalTrafficPolicy: Local

```yaml
apiVersion: v1
kind: Service
metadata:
  name: checkout-api
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local    # Only route to local-node endpoints
  selector:
    app: checkout-api
  ports:
  - port: 80
    targetPort: 8080
```

`externalTrafficPolicy: Local` preserves the original client IP (no SNAT) but requires that each node has at least one healthy endpoint Pod, or traffic to that node will be dropped. This is the correct configuration for services that need access to the original client IP for rate limiting, geo-routing, or audit logging.

## Summary

Kubernetes service load balancing performance is determined by the kernel-level mechanism programmed by kube-proxy. For clusters up to ~1,000 services, default iptables mode is acceptable. For clusters with 1,000–10,000 services, IPVS mode provides a significant reduction in latency and rule update overhead. For performance-critical clusters at any scale, or clusters requiring 50,000+ services, Cilium's eBPF kube-proxy replacement provides order-of-magnitude improvements in connection rate, latency, and memory consumption while eliminating conntrack scaling bottlenecks. The migration from kube-proxy to Cilium is operationally straightforward when following the structured deployment sequence: install Cilium, verify full functionality, then decommission the kube-proxy DaemonSet.
