---
title: "Kubernetes NodeLocal DNSCache: Eliminating DNS Bottlenecks at Scale"
date: 2028-11-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "DNS", "CoreDNS", "Networking", "Performance"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to NodeLocal DNSCache: deploying the node-cache DaemonSet to eliminate conntrack table exhaustion and UDP race conditions that cause DNS failures at scale in Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-node-local-dns-cache-guide-production/"
---

DNS resolution failures in Kubernetes clusters at scale are frequently misdiagnosed as application issues. At 100+ pods per node, the combination of UDP race conditions and conntrack table exhaustion creates intermittent 5-second DNS timeouts that surface as connection timeouts in application logs. NodeLocal DNSCache eliminates both failure modes by running a local caching DNS resolver on every node.

This guide covers the failure modes that NodeLocal DNSCache solves, its architecture, deployment, Corefile configuration, and how to measure improvement with CoreDNS metrics.

<!--more-->

# Kubernetes NodeLocal DNSCache: Eliminating DNS Bottlenecks at Scale

## The DNS Scaling Problem

### Conntrack Table Exhaustion

Kubernetes uses kube-proxy in iptables mode to route services. DNS queries (UDP to port 53) are translated from ClusterIP to the CoreDNS pod IP via DNAT rules. Every UDP DNS request creates a conntrack entry. On a busy node with many pods issuing rapid DNS queries, the conntrack table fills up.

When the conntrack table is full, new UDP connections are silently dropped. DNS queries vanish with no error - they simply time out after 5 seconds (the default timeout in most DNS resolvers).

```bash
# Check conntrack table usage
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# On a saturated node:
# nf_conntrack_count: 131072
# nf_conntrack_max:   131072  <- full, new connections dropped

# Check for conntrack drops
cat /proc/net/stat/nf_conntrack | awk 'NR==1{print} NR==2{print}' | \
  grep -oP 'drop=\K[0-9a-f]+' | xargs printf '%d\n'
```

### UDP Race Conditions (Source Port Reuse)

Linux kernels before 5.9 had a race condition with UDP source port reuse in conntrack. Multiple goroutines in the same pod resolving different DNS names simultaneously could end up sharing a conntrack entry with conflicting responses, causing one resolution to receive the wrong answer.

The result: intermittent SERVFAIL or wrong IP responses under concurrent DNS load, not random 5-second timeouts but subtler corruption.

### ndots:5 Amplification

Kubernetes defaults set `ndots:5` in pod `/etc/resolv.conf`. For a lookup of `api.example.com`, the resolver tries:

1. `api.example.com.payments.svc.cluster.local`
2. `api.example.com.svc.cluster.local`
3. `api.example.com.cluster.local`
4. `api.example.com`

That is 4 DNS queries for one hostname lookup. Under load, this multiplies query volume by 4x for external names.

```bash
# Check a pod's resolv.conf
kubectl exec -n payments deploy/payment-api -- cat /etc/resolv.conf
```

```
nameserver 10.96.0.10
search payments.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

## NodeLocal DNSCache Architecture

NodeLocal DNSCache deploys a caching DNS resolver as a DaemonSet on every node. It listens on a dedicated link-local IP address (169.254.20.10 by default) and uses iptables rules to intercept DNS queries from pods, serving them locally.

```
Pod DNS query (UDP/53)
         |
         v
  iptables PREROUTING
  redirect to 169.254.20.10:53
         |
         v
  NodeLocal DNS Cache (node-local-dns DaemonSet)
  - Check local cache -> return cached answer
  - Cache miss -> forward to CoreDNS (TCP, not UDP)
         |
         v
  CoreDNS cluster DNS (10.96.0.10:53)
```

Key benefits of this architecture:
- **No conntrack entries**: Traffic to 169.254.20.10 (link-local) bypasses conntrack
- **TCP to CoreDNS**: node-local-dns talks to CoreDNS over TCP, eliminating UDP race conditions
- **Local caching**: Repeated queries served from node memory, reducing CoreDNS load
- **Metrics per node**: Each node-local-dns instance exposes CoreDNS-compatible Prometheus metrics

## Deployment

### Prerequisites

```bash
# Get your cluster DNS service IP
CLUSTER_DNS_IP=$(kubectl get svc -n kube-system kube-dns \
  -o jsonpath='{.spec.clusterIP}')
echo "Cluster DNS: $CLUSTER_DNS_IP"

# Verify kubelet is configured to use the local DNS IP
# On managed clusters (EKS, GKE, AKS) this is handled automatically
# On self-managed clusters, check kubelet config:
# --cluster-dns=169.254.20.10
```

### Deploying node-local-dns

The official manifest is available in the Kubernetes addons repository. The key variables to configure:

```bash
# Download the official manifest
curl -O https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml

# Set variables (replace with your cluster values)
CLUSTER_DNS_IP=$(kubectl get svc -n kube-system kube-dns \
  -o jsonpath='{.spec.clusterIP}')
LOCAL_DNS="169.254.20.10"
DNS_DOMAIN="cluster.local"

# Apply substitutions
sed -i "s/__PILLAR__LOCAL__DNS__/${LOCAL_DNS}/g" nodelocaldns.yaml
sed -i "s/__PILLAR__DNS__DOMAIN__/${DNS_DOMAIN}/g" nodelocaldns.yaml
sed -i "s/__PILLAR__DNS__SERVER__/${CLUSTER_DNS_IP}/g" nodelocaldns.yaml

kubectl apply -f nodelocaldns.yaml
```

### Helm-Based Deployment

For production clusters, the `node-local-dns` Helm chart from fairwinds or the upstream addon:

```yaml
# node-local-dns-values.yaml
image:
  repository: registry.k8s.io/dns/k8s-dns-node-cache
  tag: "1.23.0"

config:
  localDns: "169.254.20.10"
  dnsServer: "10.96.0.10"    # Replace with your kube-dns ClusterIP
  dnsDomain: "cluster.local"

resources:
  requests:
    cpu: 25m
    memory: 32Mi
  limits:
    cpu: 100m
    memory: 128Mi

tolerations:
- key: "node-role.kubernetes.io/control-plane"
  effect: NoSchedule
- key: "node-role.kubernetes.io/master"
  effect: NoSchedule

# Health check configuration
healthPort: 8080
```

### Verifying Deployment

```bash
# All nodes should have a node-local-dns pod
kubectl get pods -n kube-system -l k8s-app=node-local-dns -o wide

# Check that the link-local IP is listening on a node
NODE=$(kubectl get pods -n kube-system -l k8s-app=node-local-dns \
  -o jsonpath='{.items[0].spec.nodeName}')
kubectl debug node/$NODE -it --image=busybox -- \
  nslookup kubernetes.default.svc.cluster.local 169.254.20.10

# Verify pod resolv.conf is updated (requires kubelet restart on self-managed)
kubectl exec -n default deploy/nginx -- cat /etc/resolv.conf
# Should show: nameserver 169.254.20.10
```

## Configuring the node-cache Corefile

The node-local-dns DaemonSet uses a ConfigMap with a Corefile that controls caching behavior, forwarding, and metrics.

```yaml
# node-local-dns-configmap.yaml
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
            success 9984 30     # Cache successful responses, 30s TTL
            denial 9984 5       # Cache NXDOMAIN, 5s TTL
        }
        reload
        loop
        bind 169.254.20.10
        forward . __PILLAR__DNS__SERVER__ {
            force_tcp               # Use TCP to CoreDNS (eliminates UDP race)
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
        forward . __PILLAR__DNS__SERVER__ {
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
        forward . __PILLAR__DNS__SERVER__ {
            force_tcp
        }
        prometheus :9253
        }
    .:53 {
        errors
        cache {
            success 9984 30
            denial 9984 5
        }
        reload
        loop
        bind 169.254.20.10
        forward . /etc/resolv.conf {       # Forward external queries to node's resolver
            max_concurrent 1000
        }
        prometheus :9253
        health 169.254.20.10:8080
        }
```

### Tuning Cache Parameters

For workloads with high DNS query rates, increase cache size and TTL:

```
cluster.local:53 {
    cache {
        success 20000 60    # Larger cache, 60s TTL
        denial 5000 10      # Cache negative responses longer
        prefetch 10 60s 10% # Prefetch entries used >10 times in 60s when <10% TTL remaining
    }
    forward . 10.96.0.10 {
        force_tcp
        max_concurrent 2000  # Increase for high-concurrency clusters
    }
}
```

## Reducing ndots Overhead

While NodeLocal DNSCache solves conntrack and race conditions, the ndots:5 amplification still causes unnecessary upstream queries. You can reduce this per-pod with `dnsConfig`:

```yaml
# deployment-with-dns-config.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
spec:
  template:
    spec:
      dnsConfig:
        options:
        - name: ndots
          value: "2"           # Reduce from 5 to 2
        - name: timeout
          value: "2"           # 2-second timeout instead of 5
        - name: attempts
          value: "3"
      containers:
      - name: payment-api
        image: payment-api:latest
```

With `ndots:2`, a lookup of `api.example.com` first checks `api.example.com.payments.svc.cluster.local` (because the name has < 2 dots when fully qualified), then goes directly to `api.example.com`. Much better than the 4-query default.

For services that only communicate internally, `ndots:1` is sufficient.

## Metrics and Observability

NodeLocal DNSCache exposes CoreDNS-compatible metrics on `:9253/metrics`. Configure Prometheus scraping:

```yaml
# node-local-dns-podmonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: node-local-dns
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
    - kube-system
  selector:
    matchLabels:
      k8s-app: node-local-dns
  podMetricsEndpoints:
  - port: metrics
    path: /metrics
    interval: 30s
```

### Key Metrics to Monitor

```promql
# DNS cache hit ratio per node
rate(coredns_cache_hits_total{server="dns://169.254.20.10:53"}[5m])
/
(rate(coredns_cache_hits_total{server="dns://169.254.20.10:53"}[5m])
 + rate(coredns_cache_misses_total{server="dns://169.254.20.10:53"}[5m]))

# DNS request latency p99
histogram_quantile(0.99,
  rate(coredns_dns_request_duration_seconds_bucket{
    server="dns://169.254.20.10:53"
  }[5m])
)

# Error rate per node
rate(coredns_dns_responses_total{
  server="dns://169.254.20.10:53",
  rcode!="NOERROR"
}[5m])

# Upstream forwarding latency (to CoreDNS)
histogram_quantile(0.99,
  rate(coredns_forward_request_duration_seconds_bucket[5m])
)
```

### Before/After Comparison

To measure improvement after deploying NodeLocal DNSCache:

```bash
# Before NodeLocal DNSCache - measure from a pod
kubectl run dns-test --image=dnsutils --restart=Never --rm -it -- \
  bash -c '
    for i in $(seq 1 100); do
      start=$(date +%s%3N)
      nslookup kubernetes.default.svc.cluster.local > /dev/null 2>&1
      end=$(date +%s%3N)
      echo "$((end - start))ms"
    done
  ' | awk '{sum+=$1; count++} END {printf "avg: %.1fms\n", sum/count}'

# After NodeLocal DNSCache - same test
# Expected: 1-2ms average vs 5-20ms average before
```

A typical before/after comparison on a production cluster:

| Metric | Before NodeLocal DNS | After NodeLocal DNS |
|--------|---------------------|---------------------|
| DNS p50 latency | 8ms | 0.5ms |
| DNS p99 latency | 95ms | 3ms |
| DNS timeout rate | 0.3% | 0.001% |
| CoreDNS CPU | 2.4 cores | 0.6 cores |
| ConnTrack entries (DNS) | ~50,000 | ~200 |

## Debugging DNS Issues from Pods

### Basic nslookup Tests

```bash
# Test internal service resolution
kubectl exec -n payments deploy/payment-api -- \
  nslookup kubernetes.default.svc.cluster.local

# Test cross-namespace service resolution
kubectl exec -n payments deploy/payment-api -- \
  nslookup order-service.orders.svc.cluster.local

# Test external resolution
kubectl exec -n payments deploy/payment-api -- \
  nslookup api.stripe.com

# Test with specific DNS server
kubectl exec -n payments deploy/payment-api -- \
  nslookup kubernetes.default.svc.cluster.local 169.254.20.10
```

### dig for Detailed Analysis

```bash
# Check TTL and authoritative info
kubectl exec -n payments deploy/payment-api -- \
  dig +noall +answer kubernetes.default.svc.cluster.local

# Check query time
kubectl exec -n payments deploy/payment-api -- \
  dig +stats kubernetes.default.svc.cluster.local | grep "Query time"

# Trace the full resolution path
kubectl exec -n payments deploy/payment-api -- \
  dig +trace api.example.com

# Check if ndots is causing extra queries
kubectl exec -n payments deploy/payment-api -- \
  dig +search +stats external-api.com | grep "Query time"
```

### Using dnsutils Pod for Debugging

```bash
kubectl run dnsutils \
  --image=registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3 \
  --restart=Never \
  --namespace=payments \
  -it --rm \
  -- bash

# Inside the pod
cat /etc/resolv.conf
nslookup kubernetes.default
nslookup payment-db.payments.svc.cluster.local
dig +stats kubernetes.default.svc.cluster.local
```

### Packet Capture for DNS Traffic

```bash
# Start tcpdump on a node to capture DNS traffic
NODE_IP=$(kubectl get node <node-name> -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')

# SSH to node and capture
ssh root@$NODE_IP "tcpdump -i any -n port 53 -w /tmp/dns-capture.pcap" &

# Generate DNS load
kubectl exec -n payments deploy/payment-api -- \
  bash -c 'for i in $(seq 1 100); do nslookup kubernetes.default > /dev/null; done'

# Stop capture and analyze
kill %1
scp root@$NODE_IP:/tmp/dns-capture.pcap .
wireshark dns-capture.pcap  # or tcpdump -r dns-capture.pcap -n
```

## Common Issues and Resolutions

### node-local-dns Pods Not Starting

```bash
# Check DaemonSet status
kubectl get ds -n kube-system node-local-dns
kubectl describe ds -n kube-system node-local-dns

# Check pod logs
kubectl logs -n kube-system -l k8s-app=node-local-dns --tail=50

# Common issue: address already in use
# Another process is listening on 169.254.20.10:53
kubectl exec -n kube-system -it <node-local-dns-pod> -- ss -ulnp | grep :53
```

### Pods Not Using NodeLocal DNS After Deployment

NodeLocal DNSCache works by updating the kubelet `--cluster-dns` flag to point to `169.254.20.10`. On self-managed clusters, kubelet must be restarted for new pods to pick up the change. Existing pods keep their old resolv.conf.

```bash
# Check kubelet configuration
cat /var/lib/kubelet/config.yaml | grep clusterDNS
# Should show: - 169.254.20.10

# Verify new pods get the correct nameserver
kubectl run test-pod --image=busybox --restart=Never --rm -- cat /etc/resolv.conf
# nameserver 169.254.20.10
```

### High Miss Rate Indicating Cache is Too Small

```promql
# If cache hit rate is below 50%, increase cache size
rate(coredns_cache_hits_total[5m])
/
(rate(coredns_cache_hits_total[5m]) + rate(coredns_cache_misses_total[5m]))
```

Update the ConfigMap with a larger cache size and restart the DaemonSet pods:

```bash
kubectl rollout restart daemonset/node-local-dns -n kube-system
```

## Summary

NodeLocal DNSCache is a high-value improvement for clusters above 20-30 nodes or with pod density above 50 pods/node. The deployment is straightforward via the official manifest or Helm, and the impact on DNS latency and reliability is significant. The operational cost is a small DaemonSet consuming 25m CPU and 32Mi memory per node.

Key configuration points:
1. Use `force_tcp` for forwarding to CoreDNS to eliminate UDP race conditions
2. Tune `ndots` to 2 for pods that query external services frequently
3. Set cache size proportionally to your query volume
4. Monitor cache hit rate and upstream latency with Prometheus
5. Test DNS resolution from pods after deployment with dig and nslookup
