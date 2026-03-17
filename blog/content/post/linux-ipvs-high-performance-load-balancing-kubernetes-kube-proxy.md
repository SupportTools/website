---
title: "Linux IPVS: High-Performance Load Balancing for Kubernetes kube-proxy"
date: 2031-03-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "IPVS", "kube-proxy", "Networking", "Linux", "Load Balancing", "Performance"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to IPVS mode for Kubernetes kube-proxy: scheduling algorithms, connection tables, ipvsadm debugging, enabling IPVS in kubeadm, and performance comparisons against iptables mode."
more_link: "yes"
url: "/linux-ipvs-high-performance-load-balancing-kubernetes-kube-proxy/"
---

Linux IPVS (IP Virtual Server) is a transport-layer load balancing kernel module that implements a high-performance connection dispatch engine. When Kubernetes kube-proxy runs in IPVS mode instead of the default iptables mode, it replaces O(n) iptables rule traversal with O(1) hash table lookups. At large scale — thousands of Services and tens of thousands of Endpoints — the difference is dramatic: kube-proxy sync time drops from minutes to seconds, and per-connection overhead drops to near zero.

<!--more-->

# Linux IPVS: High-Performance Load Balancing for Kubernetes kube-proxy

## Section 1: IPVS vs iptables Architecture

### How iptables Mode Works

In iptables mode, kube-proxy translates every Kubernetes Service and its Endpoints into iptables NAT rules. For a cluster with 1,000 Services each with 5 Endpoints, kube-proxy creates roughly:

- 1,000 KUBE-SERVICES chain entries (service IP match)
- 1,000 KUBE-SVC-xxx chains (one per service)
- 5,000 KUBE-SEP-xxx chains (one per endpoint)
- 1,000 KUBE-MARK-MASQ rules
- Plus NodePort, External IP, and health check rules

For every new connection, the kernel walks the iptables chains linearly until it finds a match. With 10,000 Services, this means traversing up to 50,000 rules per new connection.

**Pathological behaviors in iptables mode**:
1. **Rule sync time**: When endpoints change, kube-proxy must atomically replace the entire iptables ruleset. At 5,000 Services this takes 10-30 seconds; at 20,000 Services it can exceed a minute during which any new connection rules may be inconsistent.
2. **Conntrack table bloat**: Every NAT rule creates a conntrack entry. Large clusters exhaust the conntrack table (`net.netfilter.nf_conntrack_max`).
3. **Lock contention**: `iptables-restore` holds an exclusive lock on the entire iptables ruleset during updates, blocking all other network operations.

### How IPVS Mode Works

IPVS maintains Service load balancing as an in-kernel hash table. Each lookup is O(1) regardless of cluster size. kube-proxy in IPVS mode:

1. Creates a virtual service in the IPVS table for each Kubernetes Service ClusterIP.
2. Adds real server entries for each Endpoint.
3. Uses iptables only for kube-proxy-specific functions (MASQUERADE, NodePort hairpin), not for Service routing.

**Performance characteristics**:
- Connection dispatch: O(1) hash lookup
- Rule sync: Incremental updates to individual IPVS virtual services
- Memory: O(services + endpoints), not O(rules)
- Lock granularity: Per-virtual-service, not global

### Benchmark Comparison

```
Cluster size: 10,000 Services, 3 endpoints each

iptables mode:
  Rules count:          ~150,000
  kube-proxy sync time: 45-90 seconds (full resync on endpoint change)
  New connection cost:  ~150,000 rule traversals worst case
  Memory (iptables):    ~800 MB kernel memory for rules

IPVS mode:
  IPVS entries:         10,000 virtual services, 30,000 real servers
  kube-proxy sync time: 2-5 seconds (incremental)
  New connection cost:  1 hash lookup
  Memory (IPVS):        ~50 MB kernel memory
```

## Section 2: IPVS Scheduling Algorithms

IPVS implements 10+ scheduling algorithms. The choice directly affects connection distribution and session behavior.

### Round Robin (rr) — Default

Distributes connections sequentially across backends. No state required.

```
New connections: backend1, backend2, backend3, backend1, backend2, ...
```

Best for: Stateless services with homogeneous backend capacity.

### Least Connection (lc)

Routes each new connection to the backend with the fewest active connections.

```
Backend connections: b1=10, b2=5, b3=15
Next connection → b2 (fewest active)
```

Best for: Services with variable-length connections (WebSockets, gRPC streams).

### Source Hash (sh)

Hashes the source IP to select a backend. The same client always goes to the same backend (within a consistent window).

```
Client 10.0.0.5 → always backend2
Client 10.0.0.6 → always backend1
Client 10.0.0.7 → always backend2
```

Best for: Applications requiring session affinity by client IP.

**Note**: `sh` is superseded by Kubernetes `sessionAffinity: ClientIP` which also uses source IP hashing but at the Service level.

### Destination Hash (dh)

Hashes the destination IP to select a backend. Used in transparent proxy scenarios.

Best for: Proxy/cache clusters where a given destination should always hit the same cache node.

### Weighted Round Robin (wrr)

Like round robin, but backends with higher weights receive proportionally more connections.

```yaml
# Example: backend1 gets 3x connections vs backend2
backend1: weight=3
backend2: weight=1
```

Best for: Heterogeneous backends (different CPU/memory capacity).

### Shortest Expected Delay (sed)

Routes to the backend where a new connection will experience the shortest expected delay:

```
Expected delay = (active_connections + 1) / weight
```

Best for: Heterogeneous backends with CPU-bound workloads.

### Never Queue (nq)

Modified SED that sends to a backend with no active connections if one exists, otherwise falls back to SED.

Best for: Minimizing latency when backends are available.

## Section 3: Enabling IPVS Mode in Kubernetes

### Prerequisites: Kernel Modules

IPVS requires several kernel modules that are not loaded by default on all distributions:

```bash
# Check if IPVS modules are available
modprobe --dry-run ip_vs
modprobe --dry-run ip_vs_rr
modprobe --dry-run ip_vs_wrr
modprobe --dry-run ip_vs_sh
modprobe --dry-run nf_conntrack

# Load modules
modprobe ip_vs
modprobe ip_vs_rr
modprobe ip_vs_wrr
modprobe ip_vs_sh
modprobe nf_conntrack

# Persist across reboots
cat > /etc/modules-load.d/ipvs.conf << 'EOF'
ip_vs
ip_vs_rr
ip_vs_wrr
ip_vs_sh
nf_conntrack
EOF

# Verify modules are loaded
lsmod | grep -e ip_vs -e nf_conntrack
```

Install `ipvsadm` and `ipset` utilities:

```bash
# Debian/Ubuntu
apt-get install -y ipvsadm ipset

# RHEL/Rocky/AlmaLinux
dnf install -y ipvsadm ipset
```

### Enabling IPVS in kubeadm

When initializing a new cluster:

```yaml
# kubeadm-config.yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
networking:
  serviceSubnet: "10.96.0.0/12"
  podSubnet: "10.244.0.0/16"
---
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: "ipvs"
ipvs:
  scheduler: "lc"         # Least connection
  syncPeriod: "30s"        # How often to resync all rules
  minSyncPeriod: "5s"      # Minimum time between syncs
  strictARP: true          # Required for MetalLB
  excludeCIDRs: []
  tcpTimeout: "900s"
  tcpFinTimeout: "30s"
  udpTimeout: "300s"
conntrack:
  maxPerCore: 32768
  min: 131072
  tcpEstablishedTimeout: "86400s"
  tcpCloseWaitTimeout: "3600s"
```

```bash
kubeadm init --config=kubeadm-config.yaml
```

### Migrating an Existing Cluster from iptables to IPVS

**Step 1: Verify modules on all nodes**

```bash
# Run on each node
for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
  echo "=== $node ==="
  ssh $node lsmod | grep ip_vs || echo "MISSING ip_vs modules"
done
```

**Step 2: Update kube-proxy ConfigMap**

```bash
kubectl -n kube-system edit configmap kube-proxy
```

Change `mode: ""` or `mode: "iptables"` to:

```yaml
data:
  config.conf: |-
    apiVersion: kubeproxy.config.k8s.io/v1alpha1
    kind: KubeProxyConfiguration
    mode: "ipvs"
    ipvs:
      scheduler: "lc"
      strictARP: true
```

**Step 3: Restart kube-proxy pods**

```bash
kubectl -n kube-system rollout restart daemonset kube-proxy

# Watch rollout
kubectl -n kube-system rollout status daemonset kube-proxy
```

**Step 4: Clean up stale iptables rules**

After switching to IPVS, old iptables rules remain on nodes. kube-proxy does not clean them automatically on mode change:

```bash
# Run on each node
# Remove KUBE-* iptables chains
iptables -t nat -F KUBE-SERVICES
iptables -t nat -F KUBE-POSTROUTING
iptables -t nat -X KUBE-SERVICES
iptables -t nat -X KUBE-POSTROUTING
# Also clean filter and mangle tables
iptables -F KUBE-FIREWALL
iptables -F KUBE-FORWARD
iptables -X KUBE-FIREWALL
iptables -X KUBE-FORWARD
```

Or simply reboot each node after the kube-proxy rollout (safest approach in production).

**Step 5: Verify IPVS rules are populated**

```bash
# Check virtual services are created
ipvsadm -Ln | head -50

# Should show entries like:
# IP Virtual Server version 1.2.1 (size=4096)
# Prot LocalAddress:Port Scheduler Flags
#   -> RemoteAddress:Port           Forward Weight ActiveConn InActConn
# TCP  10.96.0.1:443 lc
#   -> 192.168.1.101:6443           Masq    1      5          0
#   -> 192.168.1.102:6443           Masq    1      4          0
# TCP  10.96.0.10:53 lc
#   -> 10.244.0.5:53                Masq    1      0          0
```

## Section 4: ipvsadm for Debugging

`ipvsadm` is the userspace tool for inspecting and manipulating the IPVS kernel tables.

### Listing Virtual Services and Real Servers

```bash
# List all virtual services (brief)
ipvsadm -Ln

# List with packet/byte counters
ipvsadm -Ln --stats

# List with connection rate info
ipvsadm -Ln --rate

# Watch live — update every 2 seconds
watch -n 2 'ipvsadm -Ln --stats'
```

### Inspecting Connection Tables

```bash
# Show all active connections
ipvsadm -Lnc

# Filter by service IP
ipvsadm -Lnc | grep "10.96.1.100"

# Count active connections per virtual service
ipvsadm -Lnc | awk '{print $4}' | sort | uniq -c | sort -rn | head
```

Connection table fields:
```
pro  expire   state          source             virtual            destination
TCP  00:26    ESTABLISHED    10.244.1.5:52340   10.96.1.100:80     10.244.2.10:8080
TCP  00:01    FIN_WAIT       10.244.1.6:52341   10.96.1.100:80     10.244.2.11:8080
UDP  00:05    UDP            10.244.3.1:15021   10.96.0.10:53      10.244.0.5:53
```

### Manually Adding/Removing Real Servers

For testing or temporary load management:

```bash
# Add a virtual service manually (for testing)
ipvsadm -A -t 10.96.99.99:80 -s lc

# Add a real server with weight 2
ipvsadm -a -t 10.96.99.99:80 -r 10.244.5.10:8080 -m -w 2

# Set a backend weight to 0 (drain connections)
ipvsadm -e -t 10.96.1.100:80 -r 10.244.2.10:8080 -m -w 0

# Remove a real server
ipvsadm -d -t 10.96.99.99:80 -r 10.244.5.10:8080

# Delete a virtual service
ipvsadm -D -t 10.96.99.99:80

# Clear all IPVS rules (DANGEROUS — removes all Service routing)
# ipvsadm -C
```

### Diagnosing Dropped Connections

```bash
# Check IPVS statistics for packet drops
ipvsadm -Ln --stats | grep -E "^(IP|TCP|UDP)" | awk '{
  if ($5 > 0) print "DROPS on "$3": "$5
}'

# Check conntrack table size
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Check if conntrack is full
dmesg | grep "nf_conntrack: table full"
```

### IPVS Timeouts

IPVS maintains TCP state using timeouts (not full TCP state tracking). Default values:

```bash
# Show current timeouts
ipvsadm -L --timeout
# Timeout (tcp tcpfin udp): 900 120 300

# Set timeouts (seconds)
ipvsadm --set 900 30 300
# TCP: 900s (established), TCP FIN: 30s, UDP: 300s
```

For Kubernetes clusters with long-lived gRPC connections:

```bash
# Increase TCP timeout to 2 hours for gRPC streams
ipvsadm --set 7200 30 300
```

This can also be set in kube-proxy configuration:

```yaml
ipvs:
  tcpTimeout: "7200s"
  tcpFinTimeout: "30s"
  udpTimeout: "300s"
```

## Section 5: Session Affinity with IPVS

### Kubernetes SessionAffinity and IPVS

When a Kubernetes Service has `sessionAffinity: ClientIP`, kube-proxy creates IPVS persistent connections:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-sticky-service
spec:
  selector:
    app: my-app
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800  # 3 hours
  ports:
  - port: 80
    targetPort: 8080
```

In IPVS mode, this creates a persistent virtual service:

```bash
ipvsadm -Ln
# TCP  10.96.1.200:80 lc persistent 10800
#   -> 10.244.1.5:8080                Masq    1      0          0
#   -> 10.244.2.7:8080                Masq    1      0          0
```

The `persistent 10800` flag means IPVS keeps a mapping from client IP → backend for 10800 seconds after the last connection from that client closes.

### Connection Templates

For persistent virtual services, IPVS creates connection templates:

```bash
ipvsadm -Lnc | grep "TEMPLATE"
# TCP  00:00    TEMPLATE       10.244.1.5:0       10.96.1.200:80     10.244.2.7:8080
```

Templates are connection stubs that last the full persistence timeout period. High client counts can exhaust the template table.

## Section 6: Kernel Parameters for IPVS

### Critical sysctl Settings

```bash
# Increase conntrack table size for large clusters
sysctl -w net.netfilter.nf_conntrack_max=1000000
sysctl -w net.netfilter.nf_conntrack_buckets=250000

# IPVS connection table size
sysctl -w net.ipv4.vs.conn_reuse_mode=1    # Reuse TIME_WAIT connections
sysctl -w net.ipv4.vs.expire_nodest_conn=1  # Expire connections to dead backends
sysctl -w net.ipv4.vs.expire_quiescent_template=1

# TCP settings for high connection rates
sysctl -w net.core.somaxconn=65535
sysctl -w net.ipv4.tcp_max_syn_backlog=65535
sysctl -w net.core.netdev_max_backlog=65535

# IP forwarding (required for kube-proxy)
sysctl -w net.ipv4.ip_forward=1
sysctl -w net.ipv6.conf.all.forwarding=1
```

Persist in `/etc/sysctl.d/99-kubernetes-ipvs.conf`:

```ini
net.netfilter.nf_conntrack_max=1000000
net.netfilter.nf_conntrack_buckets=250000
net.ipv4.vs.conn_reuse_mode=1
net.ipv4.vs.expire_nodest_conn=1
net.ipv4.vs.expire_quiescent_template=1
net.core.somaxconn=65535
net.ipv4.tcp_max_syn_backlog=65535
net.core.netdev_max_backlog=65535
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
```

Apply:

```bash
sysctl --system
```

### StrictARP for MetalLB

When using MetalLB for bare-metal LoadBalancer services, IPVS mode requires `strictARP: true`. This tells the kernel not to respond to ARP requests on behalf of IPs assigned to IPVS virtual services:

```bash
# Enable strictARP (required for MetalLB with IPVS)
sysctl -w net.ipv4.conf.all.arp_ignore=1
sysctl -w net.ipv4.conf.all.arp_announce=2
```

kube-proxy's `strictARP: true` setting handles this automatically.

## Section 7: IPVS with Cilium

When using Cilium as the CNI with kube-proxy replacement mode, Cilium bypasses IPVS entirely and implements Service load balancing directly in eBPF. This is more efficient than IPVS for the same reason IPVS is more efficient than iptables — eBPF operates at an even earlier point in the networking stack.

However, if Cilium is not available or desired, IPVS mode with kube-proxy is the recommended alternative.

```bash
# Check if Cilium is replacing kube-proxy
kubectl -n kube-system exec ds/cilium -- cilium status | grep "KubeProxy"
# KubeProxyReplacement: Strict [eth0 192.168.1.100 (Direct Routing)]
```

With Cilium kube-proxy replacement, ipvsadm will show no entries because all Service routing is in eBPF maps:

```bash
# Cilium eBPF service map (equivalent to ipvsadm)
kubectl -n kube-system exec ds/cilium -- cilium service list

# Show eBPF load balancer policy
kubectl -n kube-system exec ds/cilium -- cilium bpf lb list
```

## Section 8: Monitoring IPVS in Production

### Prometheus Metrics

kube-proxy exposes IPVS metrics on port 10249:

```bash
curl http://localhost:10249/metrics | grep -E "^kubeproxy_sync|^ipvs"
```

Key metrics:

```promql
# IPVS virtual services count
kubeproxy_sync_proxy_rules_ipvs_services_total

# Last sync duration (critical for large clusters)
kubeproxy_sync_proxy_rules_duration_seconds

# Sync errors
kubeproxy_sync_proxy_rules_no_local_endpoints_total

# IPVS connection count (from /proc/net/ip_vs_stats)
# No native Prometheus metric — use node_exporter or custom exporter
```

### Custom IPVS Exporter

```go
package main

import (
    "bufio"
    "fmt"
    "log"
    "net/http"
    "os"
    "strconv"
    "strings"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    ipvsConnections = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "ipvs_connection_total",
            Help: "Total IPVS connections",
        },
        []string{"direction"},
    )
    ipvsPackets = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "ipvs_packets_total",
            Help: "Total IPVS packets",
        },
        []string{"direction"},
    )
)

func init() {
    prometheus.MustRegister(ipvsConnections, ipvsPackets)
}

func collectIPVSStats() {
    f, err := os.Open("/proc/net/ip_vs_stats")
    if err != nil {
        log.Printf("failed to open ip_vs_stats: %v", err)
        return
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    // Skip header lines
    for i := 0; i < 3 && scanner.Scan(); i++ {}

    for scanner.Scan() {
        line := scanner.Text()
        fields := strings.Fields(line)
        if len(fields) >= 5 {
            if conn, err := strconv.ParseInt(fields[0], 16, 64); err == nil {
                ipvsConnections.WithLabelValues("in").Set(float64(conn))
            }
        }
    }
}

func main() {
    http.Handle("/metrics", promhttp.Handler())
    http.HandleFunc("/collect", func(w http.ResponseWriter, r *http.Request) {
        collectIPVSStats()
        fmt.Fprintln(w, "collected")
    })
    log.Fatal(http.ListenAndServe(":9101", nil))
}
```

### Grafana Dashboard Queries

```promql
# kube-proxy sync duration p99
histogram_quantile(0.99,
  rate(kubeproxy_sync_proxy_rules_duration_seconds_bucket[5m])
)

# Services count over time
kubeproxy_sync_proxy_rules_ipvs_services_total

# Sync rate
rate(kubeproxy_sync_proxy_rules_last_timestamp_seconds[5m])

# Alert: sync taking more than 10 seconds
kubeproxy_sync_proxy_rules_duration_seconds > 10
```

## Section 9: Debugging Connectivity Issues with IPVS

### Service Not Reachable

```bash
# 1. Check virtual service exists
ipvsadm -Ln | grep "<service-clusterip>"

# 2. Check real servers are listed
ipvsadm -Ln | grep -A 10 "<service-clusterip>"

# 3. Check backend pod IP is in real server list
kubectl get endpoints <service-name>
ipvsadm -Ln | grep "<pod-ip>"

# 4. Verify IPVS dummy interface exists
ip addr show kube-ipvs0
# Should show all ClusterIP addresses as secondary IPs

# 5. Check iptables MASQUERADE rules
iptables -t nat -L KUBE-POSTROUTING -n -v
```

### Asymmetric Routing Issues

IPVS mode requires that return traffic from backends flows through the same node. In multi-path or asymmetric networks:

```bash
# Check if packets are being dropped due to reverse path filtering
sysctl net.ipv4.conf.all.rp_filter
# 0 = disabled (needed for asymmetric routing)
# 1 = strict (default, may drop asymmetric traffic)
# 2 = loose

# For multi-homed nodes, may need to set rp_filter=2 or 0
sysctl -w net.ipv4.conf.all.rp_filter=0
sysctl -w net.ipv4.conf.default.rp_filter=0
```

### conn_reuse_mode and TIME_WAIT Problems

A common IPVS issue is that connections to a service may fail intermittently because IPVS tries to reuse a TIME_WAIT connection that goes to a pod that no longer exists:

```bash
# Enable connection reuse fix
sysctl -w net.ipv4.vs.conn_reuse_mode=0
sysctl -w net.ipv4.vs.expire_nodest_conn=1

# Also expire connections when destination pod is gone
sysctl -w net.ipv4.vs.expire_quiescent_template=1
```

This is a known IPVS behavior difference from iptables mode and must be explicitly configured.

## Section 10: IPVS vs iptables Decision Guide

Use this decision matrix to choose the appropriate kube-proxy mode:

| Criterion | iptables | IPVS |
|-----------|----------|------|
| Cluster size < 500 Services | Acceptable | Better |
| Cluster size 500-5,000 Services | Problematic | Recommended |
| Cluster size > 5,000 Services | Avoid | Required |
| Session affinity needed | Supported | Better |
| Gradual rollout capability | N/A | Easy drain via weight=0 |
| Operational familiarity | High | Medium |
| Debugging tools | iptables-save | ipvsadm |
| MetalLB compatibility | Yes | Yes (strictARP) |
| Cilium kube-proxy replacement | N/A | Superseded by eBPF |

The bottom line: **enable IPVS mode at cluster creation** if possible. Migrating a running cluster is safe but requires careful execution. The performance benefits appear even at modest cluster sizes and become critical at scale.

## Summary

IPVS mode for kube-proxy delivers:

- **O(1) connection routing** regardless of cluster size
- **Incremental sync** of rule changes (no full iptables reload)
- **Rich scheduling algorithms** beyond simple round-robin
- **Persistent connections** for session affinity
- **Operational observability** via ipvsadm

The operational investment — loading kernel modules, tuning sysctl parameters, and learning ipvsadm — pays dividends immediately in large clusters and provides headroom for growth without the iptables scaling cliff.
