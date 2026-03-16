---
title: "Kubernetes Cluster DNS: CoreDNS Configuration, Performance Tuning, and Troubleshooting"
date: 2027-05-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CoreDNS", "DNS", "Networking", "Service Discovery"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes CoreDNS architecture, Corefile plugin configuration, split-horizon DNS, custom domain forwarding, ndots optimization, NodeLocal DNSCache, performance tuning, and systematic troubleshooting."
more_link: "yes"
url: "/kubernetes-cluster-dns-configuration-guide/"
---

DNS is the central nervous system of Kubernetes service discovery. Every pod startup, every service call, and every inter-namespace request depends on DNS resolution working correctly. CoreDNS, the default DNS server for Kubernetes since 1.13, is highly configurable but its defaults are not always optimal for production workloads at scale. This guide covers CoreDNS architecture, plugin configuration, performance optimization, and systematic troubleshooting approaches that resolve the most common DNS-related production incidents.

<!--more-->

## CoreDNS Architecture

CoreDNS is a chain-of-responsibility plugin system where each DNS query passes through a sequence of plugins defined in the Corefile. Each plugin can:

- Serve a response directly (terminal plugin)
- Modify the query and pass it to the next plugin
- Add metadata for downstream plugins

### Default Kubernetes Corefile

```
.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30
    loop
    reload
    loadbalance
}
```

### CoreDNS Deployment

```bash
# Check CoreDNS deployment
kubectl get deployment coredns -n kube-system -o wide
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Check current Corefile
kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}'

# Check CoreDNS version
kubectl exec -n kube-system \
  $(kubectl get pod -n kube-system -l k8s-app=kube-dns -o name | head -1) \
  -- coredns --version
```

## CoreDNS Plugin Deep Dive

### kubernetes Plugin

The kubernetes plugin is responsible for all in-cluster DNS resolution:

```
kubernetes cluster.local in-addr.arpa ip6.arpa {
    # Pod name resolution mode
    # "verified" requires the pod IP to match, "insecure" skips verification
    pods insecure

    # Fall through to next plugin for PTR records not found
    fallthrough in-addr.arpa ip6.arpa

    # TTL for DNS records (default 5s)
    ttl 30

    # Limit queries to specific namespaces (security)
    # namespace production staging

    # kubeconfig for remote cluster
    # kubeconfig /etc/coredns/kubeconfig

    # Endpoint IPs to use for Services without a ClusterIP
    noendpoints
}
```

**DNS naming patterns:**

```
# Service DNS:
<service>.<namespace>.svc.cluster.local

# Pod DNS (pods insecure or verified):
<pod-ip-dashes>.<namespace>.pod.cluster.local
10-0-1-5.default.pod.cluster.local

# StatefulSet pod DNS:
<pod-name>.<service>.<namespace>.svc.cluster.local
postgres-0.postgres-headless.production.svc.cluster.local

# SRV records (named ports):
_<port-name>._<protocol>.<service>.<namespace>.svc.cluster.local
_http._tcp.my-service.default.svc.cluster.local
```

### forward Plugin

The forward plugin handles upstream DNS resolution for non-cluster domains:

```
forward . /etc/resolv.conf {
    # Maximum concurrent queries to upstream
    max_concurrent 1000

    # Force TCP instead of UDP
    # force_tcp

    # Use TLS for upstream queries
    # tls /etc/coredns/tls/client.crt /etc/coredns/tls/client.key /etc/coredns/tls/ca.crt {
    #   server_name dns.example.com
    # }

    # Timeout for upstream queries
    # expire 10s

    # Prefer UDP, fallback to TCP
    prefer_udp
}
```

**Forwarding to specific upstream servers:**

```
forward . 8.8.8.8 8.8.4.4 1.1.1.1 {
    max_concurrent 1000
    health_check 5s
    expire 10s
}
```

### cache Plugin

```
cache 30 {
    # Separate TTL for successful (success) and negative (denial) responses
    success 9984 30
    denial 9984 5

    # Prefetch entries before they expire
    prefetch 10 1m 10%
    # prefetch <amount> [duration] [percentage]
    # Prefetch when <amount> queries have been made in the last [duration]
    # and the TTL is below [percentage] of the original

    # Serve stale entries up to this long after expiry
    serve_stale 5m immediate
}
```

### rewrite Plugin

The rewrite plugin enables DNS record manipulation:

```
# Rewrite a domain to another
rewrite name exact my-service.external.com my-service.production.svc.cluster.local

# Rewrite regex
rewrite name regex (.*)\.example\.com {1}.production.svc.cluster.local answer auto

# Rewrite with stop (don't pass to next plugin)
rewrite stop name exact legacy-api.internal api.production.svc.cluster.local
```

### hosts Plugin

```
hosts /etc/coredns/hosts {
    # Static host entries
    10.0.0.1 gateway.internal
    10.0.0.2 legacy-db.internal
    192.168.1.100 on-prem-service.internal

    # Fall through if not found in hosts file
    fallthrough
}
```

### log Plugin

```
# Log all queries (for debugging - high volume in production)
log

# Log only specific zones
log . {
    class denial error
}

# Log with custom format
log . {
    format combined
}
```

### errors Plugin

```
errors {
    # Consolidate error messages within a time window
    consolidate 5m ".* i/o timeout$"
    consolidate 30s "^Failed to .+"
}
```

## Production Corefile Configuration

### Multi-Zone Production Corefile

```
.:53 {
    errors {
        consolidate 10m ".* i/o timeout$"
        consolidate 10m "^Failed to .+"
    }
    health {
        lameduck 5s
    }
    ready
    log . {
        class denial error
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }
    prometheus :9153
    forward . 10.0.0.2 10.0.0.3 {
        max_concurrent 1000
        health_check 5s
        expire 10s
        policy sequential
    }
    cache 30 {
        success 9984 30
        denial 9984 5
        prefetch 10 1m 10%
    }
    loop
    reload
    loadbalance round_robin
}
```

## Split-Horizon DNS Configuration

Split-horizon DNS returns different answers based on the source of the query. This is common in hybrid cloud environments where internal and external resolvers return different IPs for the same domain.

### Internal Domain Forwarding

```
# Production Corefile with split-horizon
# Internal corporate domains go to on-premise DNS
# Public domains go to upstream resolvers
# Cluster domains handled by kubernetes plugin

corp.example.com:53 {
    errors
    forward . 10.100.0.53 10.100.0.54 {
        max_concurrent 500
        health_check 10s
    }
    cache 30
    log . {
        class denial error
    }
}

on-prem.internal:53 {
    errors
    forward . 192.168.1.53 192.168.1.54 {
        max_concurrent 500
        health_check 10s
    }
    cache 15
}

.:53 {
    errors {
        consolidate 10m ".* i/o timeout$"
    }
    health {
        lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
        max_concurrent 1000
        health_check 5s
    }
    cache 30 {
        success 9984 30
        denial 9984 5
    }
    loop
    reload
    loadbalance
}
```

### Applying Updated Corefile

```bash
# Apply updated ConfigMap
kubectl edit configmap coredns -n kube-system

# Or apply from file
kubectl apply -f coredns-configmap.yaml

# CoreDNS watches the ConfigMap and reloads automatically (reload plugin)
# Force reload by restarting pods if reload plugin is not present
kubectl rollout restart deployment/coredns -n kube-system

# Verify reload
kubectl logs -n kube-system \
  -l k8s-app=kube-dns \
  --tail=20 | grep -i "reload\|config"
```

## Stub Zones for External Services

Stub zones forward queries for specific domains to authoritative servers:

```
# Forward database.internal to the on-prem DNS that knows about it
database.internal:53 {
    errors
    forward . 10.50.0.10 10.50.0.11
    cache 60
}

# AWS Route53 private hosted zone
aws.internal:53 {
    errors
    forward . 169.254.169.253 {
        max_concurrent 100
    }
    cache 30
}

# Azure private DNS
azure.internal:53 {
    errors
    forward . 168.63.129.16 {
        max_concurrent 100
    }
    cache 30
}
```

## DNS Search Domains and ndots Tuning

### Understanding the ndots Problem

Every Kubernetes pod receives a `resolv.conf` with the cluster's search domain list:

```
nameserver 10.96.0.10
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

The `ndots:5` setting means: if a hostname has fewer than 5 dots, try all search domains before attempting the absolute lookup. This causes excessive DNS queries for external domains.

**Example: resolving `api.stripe.com`**

With `ndots:5`, the resolver makes these queries in order:
1. `api.stripe.com.default.svc.cluster.local` - NXDOMAIN
2. `api.stripe.com.svc.cluster.local` - NXDOMAIN
3. `api.stripe.com.cluster.local` - NXDOMAIN
4. `api.stripe.com.` - SUCCESS

That's 4 DNS queries instead of 1.

### Pod-Level ndots Configuration

```yaml
# Optimize for workloads making many external DNS calls
spec:
  dnsPolicy: ClusterFirst
  dnsConfig:
    options:
    - name: ndots
      value: "2"    # Only search for names with < 2 dots
    - name: single-request-reopen
    - name: timeout
      value: "5"
    - name: attempts
      value: "2"
```

### Namespace-Level ndots via Admission Webhook

Use a mutating webhook or Kyverno to set ndots cluster-wide:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: optimize-dns-ndots
spec:
  rules:
  - name: set-ndots
    match:
      any:
      - resources:
          kinds: [Pod]
    mutate:
      patchStrategicMerge:
        spec:
          +(dnsConfig):
            +(options):
            - name: ndots
              value: "3"
            - name: single-request-reopen
```

### Using FQDN to Bypass Search Domains

Append a trailing dot to force absolute DNS lookup:

```python
# Instead of: http://api.stripe.com/v1/charges
# Use: http://api.stripe.com./v1/charges  (note trailing dot)

# In application code
import socket
# socket.getaddrinfo("api.stripe.com.", 443)  # Absolute lookup

# In DNS query tools
dig api.stripe.com.   # Trailing dot = absolute
dig api.stripe.com    # No trailing dot = relative (uses search domains)
```

## NodeLocal DNSCache

NodeLocal DNSCache runs a DNS cache as a DaemonSet on each node, eliminating the network hop to CoreDNS for cached responses. This significantly reduces DNS latency and CoreDNS load.

### How NodeLocal DNSCache Works

```
Pod DNS query → iptables rule → NodeLocal DNSCache (local cache)
    Cache miss → CoreDNS (cluster DNS)
    Cache miss → Upstream DNS
```

### Installation

```bash
# Download the nodelocaldns manifest
curl -fsSL https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml \
  -o nodelocaldns.yaml

# Set variables
CLUSTER_DNS="10.96.0.10"          # kubectl get svc -n kube-system kube-dns
UPSTREAM_DNS="8.8.8.8"
CLUSTER_DOMAIN="cluster.local"

# Replace placeholders
sed -i "s/__PILLAR__DNS__SERVER__/$CLUSTER_DNS/g" nodelocaldns.yaml
sed -i "s/__PILLAR__LOCAL__DNS__/169.254.20.10/g" nodelocaldns.yaml
sed -i "s/__PILLAR__DNS__DOMAIN__/$CLUSTER_DOMAIN/g" nodelocaldns.yaml
sed -i "s/__PILLAR__UPSTREAM__SERVERS__/$UPSTREAM_DNS/g" nodelocaldns.yaml

kubectl apply -f nodelocaldns.yaml
```

### NodeLocal DNSCache Configuration

```yaml
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
            prefetch 10 1m 10%
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
    .:53 {
        errors
        cache 30 {
            success 9984 30
            denial 9984 5
        }
        reload
        loop
        bind 169.254.20.10
        forward . __PILLAR__UPSTREAM__SERVERS__ {
            health_check 5s
        }
        prometheus :9253
        }
```

### Configuring Pods to Use NodeLocal DNSCache

```yaml
# Option 1: Per-pod dnsConfig
spec:
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

# Option 2: Node-level iptables (automatic with NodeLocal DNSCache installation)
# The DaemonSet creates iptables rules that redirect DNS queries
# from the cluster DNS IP to the local cache
```

## CoreDNS Performance Tuning

### Vertical Scaling

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
  namespace: kube-system
spec:
  replicas: 2  # Scale based on cluster size
  template:
    spec:
      containers:
      - name: coredns
        resources:
          requests:
            cpu: "100m"
            memory: "70Mi"
          limits:
            cpu: "1000m"
            memory: "500Mi"
```

**Scaling guidelines:**

```
Cluster size     | CoreDNS replicas | CPU request | Memory request
< 100 nodes      | 2                | 100m        | 70Mi
100-500 nodes    | 4                | 500m        | 200Mi
500-1000 nodes   | 6                | 1000m       | 400Mi
> 1000 nodes     | 8-12             | 2000m       | 800Mi
```

### Horizontal Pod Autoscaling

```yaml
# CoreDNS HPA based on CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: coredns
  namespace: kube-system
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: coredns
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### DNS Proportional Autoscaler (Cluster Proportional Autoscaler)

```yaml
# cluster-proportional-autoscaler scales CoreDNS based on cluster size
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dns-autoscaler
  namespace: kube-system
spec:
  selector:
    matchLabels:
      k8s-app: dns-autoscaler
  template:
    spec:
      serviceAccountName: dns-autoscaler
      containers:
      - name: autoscaler
        image: registry.k8s.io/cpa/cluster-proportional-autoscaler:1.8.4
        command:
        - /cluster-proportional-autoscaler
        - --namespace=kube-system
        - --configmap=dns-autoscaler
        - --target=deployment/coredns
        - --default-params={"linear":{"coresPerReplica":256,"nodesPerReplica":16,"min":2,"max":20,"preventSinglePointOfFailure":true}}
        - --logtostderr=true
        - --v=2
```

### Cache Tuning

```
cache 300 {
    # Number of success responses cached (default 9984)
    success 25000 300

    # Number of negative responses cached (default 9984)
    denial 10000 60

    # Prefetch entries before they expire
    # Trigger when 10 queries in 1 minute for an entry with < 10% TTL left
    prefetch 10 1m 10%

    # Serve stale responses for up to 5 minutes during upstream failures
    serve_stale 5m verify
}
```

### Connection Pool Tuning

```
forward . 10.0.0.2 10.0.0.3 {
    # Maximum concurrent queries (default 1000)
    max_concurrent 5000

    # Expire upstream connections after 10 seconds of inactivity
    expire 10s

    # Health check upstream every 5 seconds
    health_check 5s

    # Load balancing policy: random, round_robin, sequential
    policy round_robin

    # Force TCP (more reliable for large responses)
    # force_tcp
}
```

## DNS-Based Service Discovery

### Multi-Cluster Service Discovery

For connecting services across Kubernetes clusters, CoreDNS can be configured to forward queries for remote cluster domains:

```
# Corefile for cluster A forwarding to cluster B's CoreDNS
cluster-b.local:53 {
    errors
    forward . 10.200.0.10 10.200.0.11 {
        max_concurrent 500
    }
    cache 30
}

.:53 {
    errors
    kubernetes cluster-a.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    # ... rest of config
}
```

### Service Discovery Patterns

```bash
# Full FQDN lookup (always reliable)
nslookup postgres-headless.production.svc.cluster.local

# Short name (requires correct search domains)
nslookup postgres-headless

# SRV record for port discovery
dig SRV _postgres._tcp.postgres-headless.production.svc.cluster.local

# All records for a service
dig ANY postgres-headless.production.svc.cluster.local
```

## Custom Domain Forwarding

### Enterprise DNS Integration

```
# Route corporate domains to on-premise DNS
corp.example.com:53 {
    errors
    forward . 10.1.0.53 10.1.0.54 {
        max_concurrent 500
        health_check 10s
        expire 10s
    }
    cache 60 {
        success 5000 60
        denial 2000 30
    }
    log . {
        class denial error
    }
}

# Active Directory domain
ad.example.com:53 {
    errors
    forward . 10.1.0.10 10.1.0.11 {
        max_concurrent 200
        health_check 10s
    }
    cache 30
}

# Private S3 VPC endpoint
s3.us-east-1.amazonaws.com:53 {
    errors
    forward . 10.2.0.2 {
        max_concurrent 100
    }
    cache 30
}
```

### hosts Plugin for Static Overrides

```yaml
# ConfigMap with hosts file
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-hosts
  namespace: kube-system
data:
  hosts: |
    # Legacy service mappings
    10.0.50.100 legacy-api.internal
    10.0.50.101 legacy-db.internal
    10.0.50.102 file-server.internal

    # External service overrides (for testing/staging)
    10.1.100.50 payment-gateway.external.com

    # VIP addresses
    10.0.100.1 api-gateway.internal
    10.0.100.1 auth.internal
---
# Reference in Corefile
# hosts /etc/coredns/hosts {
#     fallthrough
# }
```

## Troubleshooting DNS Issues

### Diagnostic Tools

```bash
# Deploy a DNS debugging pod
kubectl run dns-debug \
  --image=tutum/dnsutils:latest \
  --restart=Never \
  -it --rm \
  -- bash

# Inside the pod:
# Check resolv.conf
cat /etc/resolv.conf

# Test cluster DNS
nslookup kubernetes.default.svc.cluster.local
nslookup kube-dns.kube-system.svc.cluster.local

# Test external DNS
nslookup google.com

# Test specific nameserver
nslookup google.com 10.96.0.10

# Check SRV records
dig SRV _https._tcp.kubernetes.default.svc.cluster.local

# Test with specific record type
dig AAAA google.com
dig A postgres-headless.production.svc.cluster.local

# Trace DNS resolution
dig +trace google.com

# Check DNS timing
dig +stats google.com
```

### CoreDNS Log Analysis

```bash
# Enable debug logging temporarily
kubectl edit configmap coredns -n kube-system
# Add: log
# in the .:53 block

# Tail CoreDNS logs
kubectl logs -n kube-system \
  -l k8s-app=kube-dns \
  --follow \
  --tail=100

# Filter for errors
kubectl logs -n kube-system \
  -l k8s-app=kube-dns \
  --tail=500 | grep -i "error\|SERVFAIL\|REFUSED\|timeout"

# Check for query patterns that might indicate misconfiguration
kubectl logs -n kube-system \
  -l k8s-app=kube-dns \
  --tail=1000 | awk '{print $5}' | sort | uniq -c | sort -rn | head -20
```

### DNS Performance Testing

```bash
# Test DNS query rate with dnsperf
kubectl run dns-perf \
  --image=perftest/dnsperf:latest \
  --restart=Never \
  -it --rm \
  -- dnsperf \
    -s 10.96.0.10 \
    -d /dev/stdin \
    -t 5 \
    -Q 5000 <<EOF
kubernetes.default.svc.cluster.local A
google.com A
EOF

# Check CoreDNS metrics (port 9153)
kubectl port-forward -n kube-system \
  deployment/coredns 9153:9153 &

curl http://localhost:9153/metrics | grep coredns_dns

# Key metrics:
# coredns_dns_requests_total - total queries by type
# coredns_dns_responses_total - responses by rcode
# coredns_dns_request_duration_seconds - query latency
# coredns_cache_hits_total - cache effectiveness
# coredns_forward_requests_total - forwarded queries
# coredns_forward_request_duration_seconds - upstream latency
```

### Common Issues and Solutions

**Issue: NXDOMAIN for cluster services**

```bash
# Verify the service exists
kubectl get service <service-name> -n <namespace>

# Check CoreDNS is running
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Verify pod resolv.conf
kubectl exec <pod-name> -- cat /etc/resolv.conf

# Check if cluster domain matches Corefile
grep cluster.local /etc/kubernetes/kubelet.conf
```

**Issue: DNS timeout/intermittent failures**

```bash
# Check CoreDNS pod resource usage
kubectl top pods -n kube-system -l k8s-app=kube-dns

# Check for UDP packet loss (conntrack table full)
kubectl exec -n kube-system <coredns-pod> -- \
  cat /proc/net/nf_conntrack_max

# Check for "Failed to list *v1.Service" errors (RBAC issue)
kubectl logs -n kube-system -l k8s-app=kube-dns | grep "Failed to list"

# Verify CoreDNS RBAC
kubectl auth can-i list services \
  --as=system:serviceaccount:kube-system:coredns

# Enable single-request mode to avoid UDP parallel queries
# (add to dnsConfig options)
# - name: single-request-reopen
```

**Issue: Slow external DNS resolution**

```bash
# Measure query time with and without search domains
# Long resolution time = search domain exhaustion

time nslookup api.stripe.com        # With search domains
time nslookup api.stripe.com.       # Without search domains (FQDN)

# If FQDN is much faster, reduce ndots
# Add to pod dnsConfig:
# options:
# - name: ndots
#   value: "2"

# Check CoreDNS cache hit rate
curl http://localhost:9153/metrics | \
  grep 'coredns_cache_hits_total\|coredns_cache_misses_total'
```

**Issue: DNS loop detection (SERVFAIL)**

```bash
# The loop plugin detects circular DNS queries
# Check logs for loop detection message
kubectl logs -n kube-system -l k8s-app=kube-dns | grep -i "loop"

# Common cause: /etc/resolv.conf points to CoreDNS IP
# Check node resolv.conf
cat /etc/resolv.conf  # On the node

# Fix: Use specific upstream DNS instead of /etc/resolv.conf
# forward . 8.8.8.8 8.8.4.4
```

**Issue: High DNS query rate causing overload**

```bash
# Check which pods are generating most DNS traffic
# (requires network policy logging or eBPF)

# Check CoreDNS QPS
kubectl exec -n kube-system <coredns-pod> -- \
  wget -qO- http://localhost:9153/metrics | \
  grep 'coredns_dns_requests_total' | \
  awk '{sum += $2} END {print "Total requests: " sum}'

# Scale CoreDNS
kubectl scale deployment coredns -n kube-system --replicas=8

# Enable NodeLocal DNSCache to reduce load on CoreDNS
# (see NodeLocal DNSCache section)
```

## Prometheus Monitoring for CoreDNS

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: coredns
  namespace: monitoring
spec:
  endpoints:
  - bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
    interval: 15s
    port: metrics
  namespaceSelector:
    matchNames:
    - kube-system
  selector:
    matchLabels:
      k8s-app: kube-dns
```

### PrometheusRule for DNS Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: coredns-alerts
  namespace: monitoring
spec:
  groups:
  - name: coredns
    interval: 30s
    rules:
    - alert: CoreDNSDown
      expr: |
        absent(coredns_build_info{job="kube-dns"}) == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "CoreDNS is down"
        description: "CoreDNS has been unavailable for 5 minutes"

    - alert: CoreDNSHighErrorRate
      expr: |
        rate(coredns_dns_responses_total{rcode=~"SERVFAIL|REFUSED"}[5m]) /
        rate(coredns_dns_responses_total[5m]) > 0.05
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "CoreDNS error rate is {{ $value | humanizePercentage }}"
        description: "More than 5% of DNS responses are errors"

    - alert: CoreDNSHighLatency
      expr: |
        histogram_quantile(0.99,
          rate(coredns_dns_request_duration_seconds_bucket[5m])
        ) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "CoreDNS p99 latency is {{ $value | humanizeDuration }}"

    - alert: CoreDNSForwardLatencyHigh
      expr: |
        histogram_quantile(0.95,
          rate(coredns_forward_request_duration_seconds_bucket[5m])
        ) > 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "CoreDNS upstream forward latency is high"

    - alert: CoreDNSLowCacheHitRate
      expr: |
        rate(coredns_cache_hits_total[5m]) /
        (rate(coredns_cache_hits_total[5m]) + rate(coredns_cache_misses_total[5m]))
        < 0.7
      for: 15m
      labels:
        severity: info
      annotations:
        summary: "CoreDNS cache hit rate is {{ $value | humanizePercentage }}"
        description: "Cache hit rate below 70%, consider increasing cache TTL"
```

### Grafana Dashboard Queries

```bash
# DNS query rate
sum(rate(coredns_dns_requests_total[5m])) by (server, zone)

# Error rate by rcode
sum(rate(coredns_dns_responses_total[5m])) by (rcode)

# p99 query latency
histogram_quantile(0.99,
  sum(rate(coredns_dns_request_duration_seconds_bucket[5m])) by (le)
)

# Cache hit ratio
sum(rate(coredns_cache_hits_total[5m])) /
(
  sum(rate(coredns_cache_hits_total[5m])) +
  sum(rate(coredns_cache_misses_total[5m]))
)

# Upstream forward latency
histogram_quantile(0.95,
  sum(rate(coredns_forward_request_duration_seconds_bucket[5m])) by (le, to)
)

# DNS query types
sum(rate(coredns_dns_requests_total[5m])) by (type)
```

## CoreDNS High Availability Configuration

### Anti-Affinity for CoreDNS Pods

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
  namespace: kube-system
spec:
  replicas: 4
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: k8s-app
                operator: In
                values:
                - kube-dns
            topologyKey: kubernetes.io/hostname
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: k8s-app
                  operator: In
                  values:
                  - kube-dns
              topologyKey: topology.kubernetes.io/zone
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            k8s-app: kube-dns
```

### PodDisruptionBudget for CoreDNS

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: coredns-pdb
  namespace: kube-system
spec:
  minAvailable: 2
  selector:
    matchLabels:
      k8s-app: kube-dns
```

## DNS Configuration Validation Script

```bash
#!/bin/bash
# validate-coredns.sh - Comprehensive CoreDNS validation

NAMESPACE="kube-system"
CLUSTER_DOMAIN="cluster.local"
TEST_NAMESPACE="default"

echo "=== CoreDNS Validation Report ==="
echo "Date: $(date)"
echo "Context: $(kubectl config current-context)"
echo ""

# 1. Check CoreDNS pods are running
echo "--- CoreDNS Pod Status ---"
kubectl get pods -n "$NAMESPACE" -l k8s-app=kube-dns \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,NODE:.spec.nodeName,READY:.status.containerStatuses[0].ready'

# 2. Check CoreDNS service
echo ""
echo "--- CoreDNS Service ---"
kubectl get svc -n "$NAMESPACE" kube-dns \
  -o custom-columns='NAME:.metadata.name,CLUSTER-IP:.spec.clusterIP,PORT:.spec.ports[0].port'

# 3. Validate Corefile syntax
echo ""
echo "--- Corefile Content ---"
kubectl get configmap coredns -n "$NAMESPACE" \
  -o jsonpath='{.data.Corefile}' | head -30

# 4. Test cluster DNS resolution
echo ""
echo "--- DNS Resolution Tests ---"
TEST_POD="dns-test-$(date +%s)"
kubectl run "$TEST_POD" \
  --image=tutum/dnsutils:latest \
  --restart=Never \
  --namespace="$TEST_NAMESPACE" \
  -- sleep 60 &>/dev/null

echo "Waiting for test pod..."
kubectl wait pod "$TEST_POD" \
  -n "$TEST_NAMESPACE" \
  --for=condition=Ready \
  --timeout=30s &>/dev/null

# Test cluster services
echo "kubernetes.default.svc.$CLUSTER_DOMAIN:"
kubectl exec -n "$TEST_NAMESPACE" "$TEST_POD" -- \
  nslookup "kubernetes.default.svc.$CLUSTER_DOMAIN" 2>&1 | grep -E "Address:|NXDOMAIN|error"

echo "kube-dns.kube-system.svc.$CLUSTER_DOMAIN:"
kubectl exec -n "$TEST_NAMESPACE" "$TEST_POD" -- \
  nslookup "kube-dns.kube-system.svc.$CLUSTER_DOMAIN" 2>&1 | grep -E "Address:|NXDOMAIN|error"

# Test external DNS
echo "google.com:"
kubectl exec -n "$TEST_NAMESPACE" "$TEST_POD" -- \
  nslookup google.com 2>&1 | grep -E "Address:|NXDOMAIN|error" | head -3

# Measure DNS latency
echo ""
echo "--- DNS Latency ---"
kubectl exec -n "$TEST_NAMESPACE" "$TEST_POD" -- \
  sh -c 'for i in 1 2 3 4 5; do
    time nslookup kubernetes.default.svc.cluster.local > /dev/null
  done' 2>&1 | grep real

# Check ndots setting
echo ""
echo "--- Pod resolv.conf ---"
kubectl exec -n "$TEST_NAMESPACE" "$TEST_POD" -- \
  cat /etc/resolv.conf

# Cleanup
kubectl delete pod "$TEST_POD" -n "$TEST_NAMESPACE" &>/dev/null

# 5. Check CoreDNS metrics
echo ""
echo "--- CoreDNS Metrics Summary ---"
COREDNS_POD=$(kubectl get pod -n kube-system -l k8s-app=kube-dns \
  -o name | head -1)
kubectl exec -n kube-system "$COREDNS_POD" -- \
  wget -qO- http://localhost:9153/metrics 2>/dev/null | \
  grep -E '^coredns_dns_requests_total|^coredns_cache_hits_total|^coredns_cache_misses_total' | \
  awk '{sum[$1] += $NF} END {for (k in sum) print k, sum[k]}'

echo ""
echo "=== Validation Complete ==="
```

Kubernetes cluster DNS is deceptively simple on the surface but has profound implications for application reliability and performance at scale. The combination of CoreDNS plugin configuration for split-horizon DNS and custom forwarding, ndots tuning to eliminate unnecessary search domain queries, NodeLocal DNSCache to eliminate network hops for cached responses, and comprehensive monitoring with Prometheus alerts creates a DNS infrastructure that handles millions of queries per second reliably. The troubleshooting patterns in this guide address the most common production DNS incidents: NXDOMAIN failures, intermittent timeouts from conntrack exhaustion, and high latency from search domain expansion.
