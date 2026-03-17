---
title: "Kubernetes NodeLocal DNSCache: Reducing DNS Latency with Per-Node Caching and Conntrack Bypass"
date: 2028-05-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "DNS", "NodeLocal DNSCache", "CoreDNS", "Networking", "Performance"]
categories: ["Kubernetes", "Networking", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes NodeLocal DNSCache covering per-node caching to reduce DNS latency, conntrack table bypass, configuration tuning, cache hit rate monitoring, and troubleshooting procedures."
more_link: "yes"
url: "/kubernetes-node-local-dns-cache-guide/"
---

DNS resolution is on the critical path for nearly every service-to-service call in Kubernetes. Without caching at the node level, each DNS query must traverse the pod network to a CoreDNS pod, return through NAT, and update the conntrack table — adding latency and conntrack table pressure at scale. NodeLocal DNSCache runs a DNS caching agent on every node, intercepts DNS queries before they leave the node, and bypasses the conntrack table entirely for cache hits.

<!--more-->

## The DNS Problem at Scale

In a default Kubernetes cluster, DNS resolution follows this path:

```
Pod → iptables DNAT → CoreDNS ClusterIP → CoreDNS Pod → upstream resolver
```

Problems at scale:

1. **Conntrack race conditions**: UDP DNS queries use 5-tuple tracking. Under high query volume, multiple pods querying the same domain simultaneously can cause conntrack table collisions, resulting in intermittent SERVFAIL responses.

2. **NAT overhead**: Every DNS query hits iptables DNAT rules, consuming CPU on the node.

3. **CoreDNS scaling**: All cluster DNS traffic concentrates on a small number of CoreDNS pods. During pod startup bursts (deployments, node restarts), DNS becomes a bottleneck.

4. **Tail latency**: Cache misses on CoreDNS still require upstream resolution. Node-level caching reduces the blast radius of upstream resolver latency.

### Measuring Current DNS Performance

```bash
# Install dnsperf or use a simple measurement
kubectl run dns-test \
  --image=infoblox/dnstools:latest \
  --restart=Never \
  --rm \
  -it \
  -- /bin/sh

# Inside the pod:
# Measure DNS latency
time nslookup kubernetes.default.svc.cluster.local

# More detailed measurement
dnstrace -n 100 -c 10 -s 10.96.0.10 kubernetes.default.svc.cluster.local

# Check for SERVFAIL patterns
dig +stats @10.96.0.10 kubernetes.default.svc.cluster.local 2>&1 | tail -20
```

```bash
# Check conntrack table saturation on a node
ssh node-1
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# If count is close to max, conntrack overflow is causing DNS failures
# Monitor with:
watch -n 1 'echo "Current: $(cat /proc/sys/net/netfilter/nf_conntrack_count) / Max: $(cat /proc/sys/net/netfilter/nf_conntrack_max)"'
```

## NodeLocal DNSCache Architecture

NodeLocal DNSCache deploys a `node-local-dns` DaemonSet that:

1. Runs a CoreDNS instance on each node, listening on a link-local address (169.254.20.10)
2. Configures iptables rules to intercept DNS queries destined for the cluster DNS IP
3. Uses a dedicated socket on the link-local address to bypass conntrack (NOTRACK rules)
4. Caches resolved names and forwards cache misses to kube-dns/CoreDNS

```
Pod → link-local IP (169.254.20.10) → node-cache → NOTRACK
                                              ↓ (cache miss)
                                         CoreDNS cluster IP
                                              ↓
                                         upstream resolver
```

The key benefit: DNS queries that hit the node cache never enter the conntrack table, eliminating the race condition and reducing CPU overhead.

## Installation

### Download the Manifest

```bash
# Download the official node-local-dns manifest
curl -LO https://raw.githubusercontent.com/kubernetes/kubernetes/v1.29.0/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml
```

### Configure Variables

The manifest uses three placeholder values that must be replaced:

- `__PILLAR__DNS__SERVER__`: ClusterIP of the kube-dns service
- `__PILLAR__LOCAL__DNS__`: The link-local IP for the cache (169.254.20.10)
- `__PILLAR__DNS__DOMAIN__`: Cluster domain (cluster.local)

```bash
# Get kube-dns ClusterIP
KUBEDNS_IP=$(kubectl get svc kube-dns -n kube-system -o jsonpath='{.spec.clusterIP}')
echo "kube-dns IP: $KUBEDNS_IP"

NODELOCALDNS_IP="169.254.20.10"
CLUSTER_DOMAIN="cluster.local"

# Apply substitutions
sed -i "s/__PILLAR__DNS__SERVER__/${KUBEDNS_IP}/g" nodelocaldns.yaml
sed -i "s/__PILLAR__LOCAL__DNS__/${NODELOCALDNS_IP}/g" nodelocaldns.yaml
sed -i "s/__PILLAR__DNS__DOMAIN__/${CLUSTER_DOMAIN}/g" nodelocaldns.yaml

# Review the result
grep -E "169.254|${KUBEDNS_IP}|cluster.local" nodelocaldns.yaml | head -20
```

### Apply the DaemonSet

```bash
kubectl apply -f nodelocaldns.yaml

# Verify DaemonSet is running on all nodes
kubectl get daemonset node-local-dns -n kube-system
# NAME             DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR   AGE
# node-local-dns   10        10        10      10           10          <none>           5m

# Verify pods are running
kubectl get pods -n kube-system -l k8s-app=node-local-dns -o wide
```

### Verify iptables Rules

```bash
# On a node, verify NodeLocal DNSCache created its iptables rules
ssh node-1

# These rules intercept DNS queries and bypass conntrack
iptables-save | grep NOTRACK | head -10
# -A PREROUTING -p tcp -m tcp --dst 169.254.20.10 --dport 53 -j NOTRACK
# -A PREROUTING -p udp -m udp --dst 169.254.20.10 --dport 53 -j NOTRACK
# -A OUTPUT -p tcp -m tcp --dst 169.254.20.10 --dport 53 -j NOTRACK
# -A OUTPUT -p udp -m udp --dst 169.254.20.10 --dport 53 -j NOTRACK

# Verify the link-local interface
ip addr show nodelocaldns
# nodelocaldns: <BROADCAST,NOARP> mtu 1500 qdisc noop state DOWN
#     link/ether 6e:6f:64:65:6c:6f brd ff:ff:ff:ff:ff:ff
#     inet 169.254.20.10/32 scope host nodelocaldns
```

## Configuring Pods to Use NodeLocal DNSCache

There are two approaches to route pod DNS to the node cache.

### Approach 1: Configure kubelet with clusterDNS

This is the preferred approach — kubelet tells pods to use the node-local cache:

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
clusterDNS:
  - 169.254.20.10
clusterDomain: cluster.local
```

```bash
# Apply to each node
systemctl restart kubelet

# Verify pods pick up the new DNS server
kubectl run verify-dns --image=busybox:1.36 --restart=Never --rm -it -- \
  cat /etc/resolv.conf
# nameserver 169.254.20.10
# search default.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5
```

### Approach 2: Per-Pod dnsConfig

For gradual rollout or canary testing:

```yaml
# pod-with-node-dns.yaml
apiVersion: v1
kind: Pod
metadata:
  name: node-dns-test
spec:
  dnsPolicy: None
  dnsConfig:
    nameservers:
      - 169.254.20.10
    searches:
      - default.svc.cluster.local
      - svc.cluster.local
      - cluster.local
    options:
      - name: ndots
        value: "5"
      - name: single-request-reopen
  containers:
    - name: app
      image: busybox:1.36
```

## Configuring the NodeLocal DNSCache Corefile

The node cache uses a Corefile ConfigMap that can be tuned for your environment:

```yaml
# configmap-nodelocaldns.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-local-dns
  namespace: kube-system
data:
  Corefile: |
    cluster.local:53 {
        errors
        cache {
            success 9984 30
            denial 9984 5
        }
        reload
        loop
        bind 169.254.20.10
        forward . 10.96.0.10 {
            force_tcp
            prefer_udp
        }
        prometheus :9253
        health 169.254.20.10:8080
        }
    in-addr.arpa:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10
        forward . 10.96.0.10 {
            force_tcp
        }
        prometheus :9253
        }
    ip6.arpa:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10
        forward . 10.96.0.10 {
            force_tcp
        }
        prometheus :9253
        }
    .:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10
        forward . /etc/resolv.conf {
            prefer_udp
        }
        prometheus :9253
        }
```

### Cache Tuning Parameters

```
cache {
    success 9984 30   # cache up to 9984 successful responses for 30 seconds
    denial 9984 5     # cache NXDOMAIN responses for 5 seconds (shorter to re-check)

    # prefetch: pre-fetch entries 10% of TTL before they expire, at 10 QPS
    # requires at least 1 request in the last minute
    prefetch 10 10s 6.25%
}
```

### Forward Configuration

```
# Use force_tcp for cache misses to CoreDNS to avoid conntrack issues
# in clusters with heavy NXDOMAIN traffic
forward . 10.96.0.10 {
    force_tcp
    max_concurrent 1000
    health_check 5s
    expire 10s
}
```

## Monitoring Cache Performance

### Enable Prometheus Metrics

The node-local-dns pods expose metrics on port 9253:

```yaml
# servicemonitor-node-local-dns.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: node-local-dns
  namespace: monitoring
spec:
  selector:
    matchLabels:
      k8s-app: node-local-dns
  endpoints:
    - port: metrics
      interval: 15s
      scheme: http
```

### Key Metrics and Queries

```promql
# Cache hit rate (higher is better, target >80%)
sum(rate(coredns_cache_hits_total{job="node-local-dns"}[5m]))
/
sum(rate(coredns_dns_requests_total{job="node-local-dns"}[5m]))

# Per-node cache hit rate
rate(coredns_cache_hits_total{job="node-local-dns"}[5m])
/
rate(coredns_dns_requests_total{job="node-local-dns"}[5m])

# Cache size (should not approach configured maximum)
coredns_cache_entries{job="node-local-dns"}

# DNS request latency at the node cache
histogram_quantile(0.99,
  rate(coredns_dns_request_duration_seconds_bucket{job="node-local-dns"}[5m])
)

# Forward rate to kube-dns (cache misses)
rate(coredns_dns_requests_total{job="node-local-dns", server="dns://:53", zone="."}[5m])

# Error rate
rate(coredns_dns_responses_total{job="node-local-dns", rcode="SERVFAIL"}[5m])

# Connection timeouts to upstream
rate(coredns_forward_request_duration_seconds_count{job="node-local-dns", to="10.96.0.10:53", rcode="TIMEOUT"}[5m])
```

### Grafana Dashboard Queries

```promql
# DNS queries per second by node
sum by (instance) (
  rate(coredns_dns_requests_total{job="node-local-dns"}[1m])
)

# Cache hit ratio by cache type (success vs denial)
sum by (type) (
  rate(coredns_cache_hits_total{job="node-local-dns"}[5m])
)
/
sum (
  rate(coredns_dns_requests_total{job="node-local-dns"}[5m])
)

# p99 DNS latency
histogram_quantile(0.99,
  sum(rate(coredns_dns_request_duration_seconds_bucket{job="node-local-dns"}[5m])) by (le)
)
```

## Alerts

```yaml
# node-local-dns-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-local-dns-alerts
  namespace: monitoring
spec:
  groups:
    - name: node_local_dns
      rules:
        - alert: NodeLocalDNSDown
          expr: |
            kube_daemonset_status_number_ready{daemonset="node-local-dns"}
              < kube_daemonset_status_desired_number_scheduled{daemonset="node-local-dns"}
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "NodeLocal DNSCache pods not ready on all nodes"

        - alert: NodeLocalDNSHighLatency
          expr: |
            histogram_quantile(0.99,
              rate(coredns_dns_request_duration_seconds_bucket{job="node-local-dns"}[5m])
            ) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "NodeLocal DNS p99 latency > 50ms"

        - alert: NodeLocalDNSLowCacheHitRate
          expr: |
            (
              sum(rate(coredns_cache_hits_total{job="node-local-dns"}[10m]))
              /
              sum(rate(coredns_dns_requests_total{job="node-local-dns"}[10m]))
            ) < 0.5
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "NodeLocal DNS cache hit rate below 50%"

        - alert: NodeLocalDNSHighErrorRate
          expr: |
            rate(coredns_dns_responses_total{job="node-local-dns", rcode=~"SERVFAIL|REFUSED"}[5m]) > 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "NodeLocal DNS returning errors at {{ $value }}/s"
```

## Troubleshooting

### Test DNS Resolution from a Pod

```bash
# Create a debug pod on the problematic node
kubectl run dns-debug \
  --image=gcr.io/kubernetes-e2e-test-images/dnsutils:1.3 \
  --restart=Never \
  --overrides='{"spec": {"nodeSelector": {"kubernetes.io/hostname": "node-1"}}}' \
  -- sleep 3600

kubectl exec -it dns-debug -- /bin/sh

# Inside the pod:
# Verify resolv.conf points to node-local-dns
cat /etc/resolv.conf
# nameserver 169.254.20.10

# Test cluster DNS
nslookup kubernetes.default.svc.cluster.local

# Test external DNS
nslookup google.com

# Check for timeouts
time nslookup slow-service.production.svc.cluster.local

# Diagnose with dig
dig +time=2 +tries=1 @169.254.20.10 kubernetes.default.svc.cluster.local
```

### Check Node Cache Pod Health

```bash
# Check logs for errors
kubectl logs -n kube-system -l k8s-app=node-local-dns --tail=50

# Common error patterns:
# "REFUSED" — upstream kube-dns is rejecting queries
# "timeout" — kube-dns unreachable
# "no route to host" — network issue

# Check readiness/liveness
kubectl describe pod -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=node-local-dns -o name | head -1)

# Health check endpoint
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=node-local-dns -o name | head -1) \
  -- wget -qO- http://169.254.20.10:8080/health
```

### Verify iptables Rules on Problematic Node

```bash
ssh node-1

# Check NodeLocal DNSCache rules exist
iptables -t raw -L PREROUTING -n -v | grep "169.254.20.10"

# If missing, the DaemonSet may have restarted without restoring rules
# Force pod restart:
kubectl delete pod -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=node-local-dns \
    --field-selector spec.nodeName=node-1 -o name)
```

### Diagnose Cache Miss Storms

```bash
# High forward rate indicates poor cache performance
# Check what's causing misses

# Most-queried domains (requires CoreDNS logging)
kubectl logs -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=node-local-dns -o name | head -1) \
  | grep NOERROR | awk '{print $8}' | sort | uniq -c | sort -rn | head -20

# Enable temporary query logging for diagnosis
kubectl edit configmap -n kube-system node-local-dns
# Add 'log' to the relevant stanza:
# cluster.local:53 {
#     log  ← add this
#     errors
#     cache { ... }
```

### ndots:5 Performance Impact

The default `ndots:5` setting causes each query to attempt multiple search domain suffixes before querying the bare name. This significantly amplifies DNS query volume:

```bash
# A single query for "postgres" from namespace "production" generates:
# postgres.production.svc.cluster.local
# postgres.svc.cluster.local
# postgres.cluster.local
# postgres.          (bare name)
# Total: 4 queries for one lookup

# Reduce ndots for services that use FQDNs
```

```yaml
# For services that always use FQDNs, reduce ndots
apiVersion: v1
kind: Pod
spec:
  dnsPolicy: ClusterFirst
  dnsConfig:
    options:
      - name: ndots
        value: "2"  # Only append search domains if name has fewer than 2 dots
      - name: timeout
        value: "2"
      - name: attempts
        value: "2"
```

## Windows Node Support

NodeLocal DNSCache supports Windows nodes using a different mechanism (no iptables):

```yaml
# The DaemonSet nodeSelector must explicitly handle Windows
spec:
  template:
    spec:
      nodeSelector:
        kubernetes.io/os: linux  # Default manifest targets Linux
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
```

For Windows nodes, use a separate DaemonSet that configures the DNS resolver differently.

## Summary

NodeLocal DNSCache addresses the fundamental scalability limitations of centralized DNS in Kubernetes:

- Cache hit rates above 80% are achievable in production workloads, reducing forwarded queries to CoreDNS by 5x or more
- The conntrack bypass via NOTRACK rules eliminates the UDP conntrack race condition that causes intermittent SERVFAIL responses at scale
- Per-node caching decouples DNS performance from CoreDNS pod scaling — a node restart no longer triggers a DNS query storm against central CoreDNS
- Monitor cache hit rates, latency histograms, and error rates with Prometheus; alert on cache nodes not reporting metrics (indicates pod failure)
- The `ndots:5` default multiplies DNS query volume by 3-5x for short service names — reduce to `ndots:2` for applications that use fully-qualified service names
