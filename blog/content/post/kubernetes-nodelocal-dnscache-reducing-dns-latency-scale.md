---
title: "Kubernetes NodeLocal DNSCache: Reducing DNS Latency at Scale"
date: 2030-05-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "DNS", "CoreDNS", "NodeLocal DNSCache", "Performance", "Networking", "Latency"]
categories:
- Kubernetes
- Networking
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to NodeLocal DNSCache deployment, configuration, Corefile tuning, connection tracking, performance benchmarks, and debugging DNS resolution issues in large clusters."
more_link: "yes"
url: "/kubernetes-nodelocal-dnscache-reducing-dns-latency-scale/"
---

DNS resolution is one of the most frequently overlooked performance bottlenecks in Kubernetes clusters. In a cluster running thousands of pods, each service-to-service call that does not use a cached DNS response traverses the network to CoreDNS, consuming a connection tracking entry in the Linux kernel's conntrack table. At scale, this creates two distinct problems: resolution latency from network round trips, and conntrack table exhaustion causing dropped packets. NodeLocal DNSCache solves both by running a caching DNS resolver on every node, intercepting all DNS queries before they leave the node.

<!--more-->

## The Problem at Scale

### DNS Query Path Without NodeLocal DNSCache

```
Pod
 └─► kube-dns ClusterIP (iptables DNAT rule)
      └─► CoreDNS pod (on a different node)
           └─► Response traverses network
                └─► Pod receives response

# Issues:
# 1. Network round trip: 0.5-5ms per uncached query
# 2. Each query creates a conntrack entry (5-tuple: src IP, src port, dst IP, dst port, proto)
# 3. conntrack table default size: 131072 entries
# 4. In high-traffic clusters: conntrack exhaustion causes ICMP errors or silent drops
```

### Conntrack Exhaustion Symptoms

```bash
# Check conntrack table usage
cat /proc/sys/net/netfilter/nf_conntrack_count
# 130891  ← approaching the limit of 131072

cat /proc/sys/net/netfilter/nf_conntrack_max
# 131072

# Kernel logs when table is full
dmesg | grep conntrack
# kernel: nf_conntrack: table full, dropping packet

# Check conntrack insert failures
cat /proc/net/stat/nf_conntrack \
  | awk 'NR==2 {printf "insert_failed: %d\n", strtonum("0x"$5)}'
```

### DNS Query Latency Profile

```bash
# Measure DNS resolution latency from a pod
kubectl run -it --rm dns-benchmark \
  --image=registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3 \
  --restart=Never -- bash

# Inside the pod:
for i in $(seq 1 100); do
  dig +noall +stats kubernetes.default.svc.cluster.local 2>&1 \
    | grep "Query time" \
    | awk '{print $4}'
done | awk '{sum+=$1; count++} END {printf "avg: %.1fms, count: %d\n", sum/count, count}'
```

## NodeLocal DNSCache Architecture

NodeLocal DNSCache runs as a DaemonSet using a dedicated link-local IP address (`169.254.20.10` by default). An `iptables` rule on each node intercepts DNS queries directed at the kube-dns ClusterIP and redirects them to the local cache. When the local cache has a warm entry, the response is immediate. On a cache miss, the local cache queries CoreDNS and caches the result.

```
Pod
 └─► DNS query to kube-dns ClusterIP (169.254.20.10)
      └─► iptables intercepts: DNAT to 169.254.20.10:53 (local cache)
           ├─► Cache HIT: return immediately (~0.05ms)
           └─► Cache MISS: forward to CoreDNS pod via UDP/TCP
                └─► Cache result for TTL seconds
```

### Why Link-Local IP?

The `169.254.20.10` address is a link-local address that does not route through iptables DNAT rules. This is critical: if the local cache used the same ClusterIP as kube-dns, iptables would intercept its own upstream queries in an infinite loop.

## Installation

### Method 1: Official Manifest

```bash
# Download the NodeLocal DNSCache manifest
curl -sLO https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml

# Replace the placeholder ClusterIP for kube-dns
# Find the kube-dns ClusterIP
KUBEDNS_CLUSTERIP=$(kubectl get svc kube-dns -n kube-system \
  -o jsonpath='{.spec.clusterIP}')
echo "kube-dns ClusterIP: ${KUBEDNS_CLUSTERIP}"

# Replace in manifest
sed -i "s/__PILLAR__DNS__SERVER__/${KUBEDNS_CLUSTERIP}/g" nodelocaldns.yaml
sed -i "s/__PILLAR__LOCAL__DNS__/169.254.20.10/g" nodelocaldns.yaml
sed -i "s/__PILLAR__DNS__DOMAIN__/cluster.local/g" nodelocaldns.yaml

# Apply
kubectl apply -f nodelocaldns.yaml

# Verify DaemonSet is running
kubectl get daemonset nodelocaldns -n kube-system
kubectl rollout status daemonset/nodelocaldns -n kube-system
```

### Method 2: Helm Chart (Recommended for Production)

```yaml
# values-nodelocaldns.yaml
nodelocaldns:
  image: registry.k8s.io/dns/k8s-dns-node-cache:1.23.0
  clusterDomain: cluster.local
  localDNSIp: 169.254.20.10
  upstreamDNS: ""  # auto-detect kube-dns ClusterIP

  resources:
    requests:
      cpu: 25m
      memory: 5Mi
    limits:
      cpu: 100m
      memory: 30Mi

  # Skip scheduling on control plane nodes
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      effect: NoSchedule
      operator: Exists

  # Health and readiness
  livenessProbe:
    httpGet:
      host: 169.254.20.10
      path: /health
      port: 8080
    initialDelaySeconds: 60
    timeoutSeconds: 5

  readinessProbe:
    httpGet:
      host: 169.254.20.10
      path: /health
      port: 8080
    initialDelaySeconds: 1
    timeoutSeconds: 1
```

## Corefile Configuration

The NodeLocal DNSCache Corefile controls caching behavior, forwarding targets, and optional metrics exposure.

### Production Corefile

```yaml
# nodelocaldns-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-local-dns
  namespace: kube-system
data:
  Corefile: |
    # Cluster-internal domains: forward cache misses to CoreDNS
    cluster.local:53 {
        errors
        cache {
            # Successful response TTL: cache for 30 seconds
            success 9984 30
            # Negative response TTL: cache NXDOMAIN for 5 seconds
            denial 9984 5
        }
        reload
        loop
        bind 169.254.20.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
        health 169.254.20.10:8080
        }
    # In-addr.arpa (reverse DNS): forward to CoreDNS
    in-addr.arpa:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
        }
    # ip6.arpa (IPv6 reverse DNS): forward to CoreDNS
    ip6.arpa:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
        }
    # External domains: forward to upstream DNS (node resolv.conf)
    .:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10
        forward . __PILLAR__UPSTREAM__SERVERS__
        prometheus :9253
        }
```

### force_tcp: Eliminating Conntrack Issues

The `force_tcp` directive in the cluster.local block is the key configuration for eliminating conntrack exhaustion. TCP connections do not create new conntrack entries for each DNS query—they reuse the established connection's entry.

```
# Without force_tcp (UDP):
# Each DNS query = new 5-tuple = new conntrack entry
# 10,000 pods × 10 queries/sec = 100,000 new conntrack entries/sec
# conntrack entry TTL = 120 seconds (default for UDP)
# Steady-state conntrack usage = 12,000,000 entries (!!)

# With force_tcp:
# Persistent TCP connection to CoreDNS per local cache instance
# All queries multiplex over the same TCP connection
# Conntrack entries: 1 per CoreDNS server per NodeLocal cache instance
```

### Advanced Corefile Options

```
cluster.local:53 {
    errors
    cache {
        success 9984 30
        denial  9984 5
        # Prefetch: when a cached entry is within 10% of expiry and receives
        # a request, prefetch a fresh copy before the entry expires
        prefetch 10 60s 10%
        # Serve stale: if CoreDNS is unreachable, serve stale cache entries
        # for up to 60 seconds
        serve_stale 60s
    }
    # Limit response size to prevent amplification attacks
    # Responses larger than 512 bytes will use TCP
    rewrite stop {
        # Normalize CNAME chains to reduce RTTs
    }
    reload
    loop
    bind 169.254.20.10
    forward . __PILLAR__CLUSTER__DNS__ {
        force_tcp
        # Health check the upstream every 0.5 seconds
        health_check 0.5s
        # If health check fails, try the next server
        policy sequential
        # Maximum concurrent requests to upstream
        max_concurrent 1000
        # Expire idle TCP connections after 10 seconds
        expire 10s
    }
    prometheus :9253
    health 169.254.20.10:8080
    log . {
        # Log only errors, not every query
        class error
    }
}
```

## Configuring Pods to Use NodeLocal DNSCache

### Kubelet Configuration

When NodeLocal DNSCache is deployed, update kubelet to configure pods to use the link-local cache IP.

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
clusterDNS:
  - 169.254.20.10
clusterDomain: cluster.local
```

Or via kubelet command-line flags:
```bash
--cluster-dns=169.254.20.10
--cluster-domain=cluster.local
```

After updating kubelet, existing pods continue using the old DNS configuration until they are recreated. New pods automatically use NodeLocal DNSCache.

### Verifying Pod DNS Configuration

```bash
# Check DNS configuration inside a pod
kubectl exec -n production api-server-6b8d94f5c-xk7p2 -- cat /etc/resolv.conf
# nameserver 169.254.20.10   ← NodeLocal cache is active
# search production.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5

# Verify DNS resolution uses the local cache
kubectl exec -n production api-server-6b8d94f5c-xk7p2 -- \
  dig +stats kubernetes.default.svc.cluster.local @169.254.20.10

# Query time should be < 1ms for cached responses
```

## Performance Benchmarking

### Measuring Cache Hit Rate

```bash
# Query NodeLocal DNSCache metrics
kubectl port-forward -n kube-system pod/nodelocaldns-abcde 9253:9253 &

curl -s http://localhost:9253/metrics \
  | grep -E 'coredns_cache_(hits|misses)_total|coredns_forward_requests'

# Sample output:
# coredns_cache_hits_total{server="dns://:53",type="success"} 1842134
# coredns_cache_hits_total{server="dns://:53",type="denial"} 12341
# coredns_cache_misses_total{server="dns://:53"} 34521
# coredns_forward_requests_total{to="10.96.0.10:53"} 34521

# Cache hit rate:
# (1842134 + 12341) / (1842134 + 12341 + 34521) = 98.2%
```

### Load Testing DNS Resolution

```bash
# Install dnsperf for DNS load testing
apt-get install -y dnsperf

# Create a query file with realistic cluster domains
cat > /tmp/cluster-dns-queries.txt << 'EOF'
kubernetes.default.svc.cluster.local A
kube-dns.kube-system.svc.cluster.local A
metrics-server.kube-system.svc.cluster.local A
api-server.production.svc.cluster.local A
payment-service.production.svc.cluster.local A
EOF

# Run DNS benchmark against NodeLocal cache
dnsperf -s 169.254.20.10 -d /tmp/cluster-dns-queries.txt \
  -c 50 -t 30 -l 60

# Expected output (with warm cache):
# DNS Performance Testing Tool
# Queries sent:         150000
# Queries completed:    150000 (100.00%)
# Queries lost:               0 (0.00%)
# Response codes:       NOERROR 150000 (100.00%)
# Average packet size:  request 45, response 102
# Run time (s):         60.000
# Queries per second:   2500.00
# Average Latency (s):  0.000142 (142 microseconds!)
# Latency StdDev (s):   0.000023
```

### Before/After Latency Comparison

```bash
# Benchmark without NodeLocal DNSCache (direct CoreDNS)
kubectl run -it --rm dns-bench \
  --image=registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3 \
  --restart=Never -- \
  bash -c "for i in \$(seq 100); do
    dig +short +time=1 +noall +stats api-server.production.svc.cluster.local
  done 2>&1 | grep 'Query time' | awk '{print \$4}' \
  | awk '{sum+=\$1;n++}END{printf \"avg=%.1fms min=%dms max=%dms\\n\",sum/n,min,max}'"

# With NodeLocal DNSCache:
# avg=0.14ms min=0ms max=1ms   ← ~10-20x improvement over direct CoreDNS
```

## Monitoring and Alerting

### Prometheus Recording Rules

```yaml
# prometheus-nodelocaldns-rules.yaml
groups:
  - name: nodelocaldns
    interval: 30s
    rules:
      # Cache hit rate per node
      - record: job:coredns_cache_hit_rate:5m
        expr: |
          sum(rate(coredns_cache_hits_total{job="nodelocaldns"}[5m])) by (instance)
          /
          (
            sum(rate(coredns_cache_hits_total{job="nodelocaldns"}[5m])) by (instance)
            +
            sum(rate(coredns_cache_misses_total{job="nodelocaldns"}[5m])) by (instance)
          )

      # DNS query rate per node
      - record: job:coredns_dns_request_rate:5m
        expr: |
          sum(rate(coredns_dns_requests_total{job="nodelocaldns"}[5m])) by (instance)

      # Alert on low cache hit rate
      - alert: NodeLocalDNSLowCacheHitRate
        expr: job:coredns_cache_hit_rate:5m < 0.80
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "NodeLocal DNS cache hit rate below 80% on {{ $labels.instance }}"
          description: "Cache hit rate is {{ $value | humanizePercentage }}. Consider increasing cache TTL or size."

      # Alert on NodeLocal cache not running
      - alert: NodeLocalDNSNotRunning
        expr: |
          kube_daemonset_status_number_ready{daemonset="nodelocaldns"}
          < kube_daemonset_status_desired_number_scheduled{daemonset="nodelocaldns"}
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "NodeLocal DNSCache not running on all nodes"
          description: "{{ $value }} nodelocaldns pods are not ready"

      # Alert on high DNS error rate
      - alert: NodeLocalDNSHighErrorRate
        expr: |
          rate(coredns_dns_responses_total{job="nodelocaldns",rcode="SERVFAIL"}[5m])
          /
          rate(coredns_dns_responses_total{job="nodelocaldns"}[5m])
          > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High DNS SERVFAIL rate on {{ $labels.instance }}"
```

### Grafana Dashboard Queries

```promql
# DNS queries per second by node
sum(rate(coredns_dns_requests_total{job="nodelocaldns"}[5m])) by (instance)

# Cache hit percentage
rate(coredns_cache_hits_total{job="nodelocaldns"}[5m])
/
(rate(coredns_cache_hits_total{job="nodelocaldns"}[5m])
+ rate(coredns_cache_misses_total{job="nodelocaldns"}[5m]))
* 100

# P99 response latency
histogram_quantile(0.99,
  sum(rate(coredns_dns_request_duration_seconds_bucket{job="nodelocaldns"}[5m]))
  by (le, instance)
) * 1000  # convert to ms

# Forward requests to CoreDNS (cache misses requiring upstream)
rate(coredns_forward_requests_total{job="nodelocaldns"}[5m])
```

## Debugging DNS Resolution Issues

### Step-by-Step DNS Debugging

```bash
#!/bin/bash
# scripts/debug-dns.sh
# Comprehensive DNS debugging for a pod.

POD="${1:?usage: debug-dns.sh <pod-name> [namespace]}"
NS="${2:-default}"

echo "=== DNS Debug for ${NS}/${POD} ==="
echo ""

# 1. Check resolv.conf
echo "--- /etc/resolv.conf ---"
kubectl exec -n "${NS}" "${POD}" -- cat /etc/resolv.conf
echo ""

# 2. Check connectivity to NodeLocal cache
echo "--- NodeLocal cache connectivity ---"
kubectl exec -n "${NS}" "${POD}" -- \
  nc -zvw 2 169.254.20.10 53 2>&1 || echo "Cannot reach 169.254.20.10:53"
echo ""

# 3. Test cluster DNS resolution
echo "--- Cluster DNS resolution ---"
kubectl exec -n "${NS}" "${POD}" -- \
  dig +short kubernetes.default.svc.cluster.local @169.254.20.10
echo ""

# 4. Test external DNS resolution
echo "--- External DNS resolution ---"
kubectl exec -n "${NS}" "${POD}" -- \
  dig +short example.com @169.254.20.10
echo ""

# 5. Check for negative cache entries (NXDOMAIN)
echo "--- NXDOMAIN test (should return NXDOMAIN) ---"
kubectl exec -n "${NS}" "${POD}" -- \
  dig +noall +answer +authority \
  this-service-does-not-exist.default.svc.cluster.local @169.254.20.10
echo ""

# 6. Check NodeLocal cache pod on the same node as target pod
NODE=$(kubectl get pod "${POD}" -n "${NS}" -o jsonpath='{.spec.nodeName}')
echo "--- NodeLocal cache pod on node ${NODE} ---"
kubectl get pod -n kube-system -l k8s-app=nodelocaldns \
  --field-selector "spec.nodeName=${NODE}"
echo ""

# 7. Check NodeLocal cache pod logs
NODEDNS_POD=$(kubectl get pod -n kube-system -l k8s-app=nodelocaldns \
  --field-selector "spec.nodeName=${NODE}" \
  -o jsonpath='{.items[0].metadata.name}')
echo "--- NodeLocal cache logs (last 50 lines) ---"
kubectl logs -n kube-system "${NODEDNS_POD}" --tail=50 \
  | grep -E "error|SERVFAIL|timeout"
```

### Checking ndots and Search Domain Impact

The `ndots:5` default in Kubernetes pods causes every short hostname to be tried with all search domains before being treated as a FQDN. This multiplies DNS queries significantly.

```bash
# A query for "myservice" with ndots:5 generates these lookups:
# 1. myservice.production.svc.cluster.local  ← cluster DNS
# 2. myservice.svc.cluster.local             ← cluster DNS
# 3. myservice.cluster.local                 ← cluster DNS
# 4. myservice                               ← only now tried as FQDN

# Solution: always use FQDNs in service-to-service calls
# Instead of: http://myservice/api
# Use: http://myservice.production.svc.cluster.local/api

# Or reduce ndots in specific pods:
```

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"      # Reduces search attempts for internal names
      - name: single-request-reopen  # Avoids parallel A/AAAA query race
```

### Tracing DNS Packets on a Node

```bash
# Capture DNS traffic on the node to verify NodeLocal cache is intercepting
tcpdump -i any -n port 53 -w /tmp/dns-capture.pcap &
TCPDUMP_PID=$!

# Run some DNS queries from a pod
kubectl exec -n production api-server-xyz -- \
  dig kubernetes.default.svc.cluster.local

kill $TCPDUMP_PID

# Analyze the capture
tcpdump -r /tmp/dns-capture.pcap -n \
  | grep -v "169.254.20.10" \
  | head -20
# Ideally: no DNS traffic to CoreDNS ClusterIP from the pod
# All traffic should be to/from 169.254.20.10
```

## Upgrade and Maintenance

### Rolling Update Strategy

NodeLocal DNSCache is a DaemonSet. During updates, the DNS cache on each node is briefly unavailable. Configure maxUnavailable appropriately.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: nodelocaldns
  namespace: kube-system
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 10%   # At most 10% of nodes without local DNS at a time
  # ...
```

### Verifying NodeLocal Cache Health Cluster-Wide

```bash
# Check that all nodes have a running NodeLocal cache pod
kubectl get nodes --no-headers \
  | awk '{print $1}' \
  | while read node; do
      count=$(kubectl get pod -n kube-system -l k8s-app=nodelocaldns \
        --field-selector "spec.nodeName=${node}" \
        --no-headers 2>/dev/null | wc -l)
      if [ "${count}" -eq 0 ]; then
        echo "WARNING: No NodeLocal DNS cache on node ${node}"
      fi
    done

# Summary health check
kubectl get daemonset nodelocaldns -n kube-system \
  -o jsonpath='Desired: {.status.desiredNumberScheduled}, Ready: {.status.numberReady}\n'
```

NodeLocal DNSCache reduces DNS resolution latency from network-round-trip times to sub-millisecond local cache lookups, eliminates conntrack table pressure from high-volume DNS traffic, and provides resilience against CoreDNS pod unavailability through the `serve_stale` directive. For clusters exceeding a few hundred pods, it is a straightforward optimization with substantial and immediate impact on both tail latencies and network infrastructure stability.
