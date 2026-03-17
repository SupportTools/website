---
title: "CoreDNS Advanced Configuration: DNS Architecture for Production Kubernetes Clusters"
date: 2027-08-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CoreDNS", "DNS", "Networking"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced CoreDNS configuration for production Kubernetes clusters covering custom zones, forward plugins, caching tuning, split-horizon DNS, debugging DNS failures, and scaling strategies for large-scale environments."
more_link: "yes"
url: "/kubernetes-dns-coredns-advanced-guide/"
---

CoreDNS is the default DNS resolver for Kubernetes clusters and one of the most critical infrastructure components in any production environment. Misconfigurations, insufficient capacity, or suboptimal cache settings can manifest as intermittent application failures, increased latency, and cascading service-discovery breakdowns. This guide covers advanced CoreDNS configuration patterns used in large-scale enterprise clusters, from custom zone delegation to split-horizon DNS and production-grade debugging workflows.

<!--more-->

## Architecture Overview

CoreDNS runs as a Deployment inside the `kube-system` namespace and is exposed via a ClusterIP Service whose IP address is injected into every pod's `/etc/resolv.conf` as the `nameserver`. The configuration is driven by a single `Corefile` stored in a ConfigMap named `coredns`.

```
pod /etc/resolv.conf
  nameserver 10.96.0.10        # ClusterIP of the kube-dns Service
  search default.svc.cluster.local svc.cluster.local cluster.local
  options ndots:5
```

Understanding this flow is essential before tuning anything: every DNS query from a pod hits CoreDNS, which means CoreDNS must scale with pod density and query rate.

### Default Corefile Structure

```corefile
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

## Custom Zone Configuration

### Hosting Internal Zones

For organizations that require CoreDNS to be authoritative for internal zones, the `file` plugin provides zone-file-based hosting.

Create the zone file as a ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-zones
  namespace: kube-system
data:
  internal.corp.example.com.db: |
    $ORIGIN internal.corp.example.com.
    $TTL 300
    @   IN  SOA ns1.internal.corp.example.com. admin.corp.example.com. (
                2027080801 ; serial
                3600       ; refresh
                900        ; retry
                86400      ; expire
                300 )      ; minimum TTL
    @   IN  NS  ns1.internal.corp.example.com.
    ns1 IN  A   10.10.0.5
    api IN  A   10.10.1.100
    db  IN  A   10.10.1.200
    *.apps IN CNAME ingress.internal.corp.example.com.
```

Mount the zone file and reference it in the Corefile:

```corefile
internal.corp.example.com:53 {
    file /etc/coredns/zones/internal.corp.example.com.db
    log
    errors
    prometheus :9153
}

.:53 {
    errors
    health
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

Updated CoreDNS Deployment to mount the zone ConfigMap:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
  namespace: kube-system
spec:
  template:
    spec:
      volumes:
        - name: config-volume
          configMap:
            name: coredns
            items:
              - key: Corefile
                path: Corefile
        - name: zone-volume
          configMap:
            name: coredns-zones
      containers:
        - name: coredns
          volumeMounts:
            - name: config-volume
              mountPath: /etc/coredns
            - name: zone-volume
              mountPath: /etc/coredns/zones
              readOnly: true
```

### Stub Zone Delegation

Stub zones forward queries for a specific domain to designated authoritative name servers. This is the correct pattern for routing queries to on-premises DNS servers for legacy domains.

```corefile
legacy.datacenter.corp:53 {
    forward . 192.168.1.53 192.168.1.54 {
        policy round_robin
        health_check 5s
        max_concurrent 500
    }
    cache 60
    errors
    log
}
```

## Forward Plugin Deep Dive

The `forward` plugin is the most commonly tuned component after `cache`. It handles all queries that CoreDNS is not authoritative for.

### Multi-Upstream Configuration

```corefile
.:53 {
    forward . 8.8.8.8 8.8.4.4 1.1.1.1 {
        max_concurrent 1000
        health_check 5s
        policy sequential
        expire 10s
        timeout 2s
    }
    cache 30
    errors
}
```

Available policy options:

| Policy | Behavior |
|--------|----------|
| `random` | Randomly select an upstream (default) |
| `round_robin` | Cycle through upstreams in order |
| `sequential` | Try first upstream; fall back on error |

### DNS-over-TLS Upstream

```corefile
.:53 {
    forward . tls://8.8.8.8 tls://8.8.4.4 {
        tls_servername dns.google
        health_check 5s
        max_concurrent 500
    }
    cache 300
    errors
}
```

### Conditional Forwarding Per Domain

```corefile
# Queries for corp.example.com go to internal DNS
corp.example.com:53 {
    forward . 10.0.0.53 10.0.0.54 {
        max_concurrent 500
    }
    cache 60
    errors
}

# Queries for aws.internal go to Route53 Resolver
aws.internal:53 {
    forward . 169.254.169.253 {
        max_concurrent 200
    }
    cache 30
    errors
}

# Everything else goes to public DNS
.:53 {
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }
    forward . /etc/resolv.conf {
        max_concurrent 1000
    }
    cache 30
    errors
    health
    ready
    prometheus :9153
    reload
    loadbalance
}
```

## Cache Tuning for High-Traffic Clusters

The default cache TTL of 30 seconds is conservative. For production clusters with hundreds of services and thousands of pods, aggressive caching dramatically reduces upstream query load.

### Cache Plugin Parameters

```corefile
cache {
    success 9984 3600 300
    denial 9984 300  30
    prefetch 10 1m 10%
    serve_stale 5s immediate
}
```

### Recommended Production Cache Settings

For clusters with 500+ services:

```corefile
cache {
    success 20000 3600 30
    denial  5000  150  5
    prefetch 20 2m 15%
    serve_stale 10s immediate
}
```

Cache size is limited by CoreDNS memory. Each cache entry consumes approximately 200 bytes. A cache of 20,000 entries uses roughly 4 MB, well within typical container memory limits.

## Split-Horizon DNS

Split-horizon DNS serves different answers for the same domain name depending on the source of the query. In Kubernetes this is commonly needed when internal services must resolve to private ClusterIPs while external clients resolve to public load-balancer IPs.

### Implementation with Separate CoreDNS Deployments

A reliable approach uses two CoreDNS Deployments with separate Services: one bound to the pod network (internal) and one bound to a node IP (external).

```yaml
# Internal CoreDNS Service (ClusterIP)
apiVersion: v1
kind: Service
metadata:
  name: coredns-internal
  namespace: kube-system
spec:
  clusterIP: 10.96.0.10
  ports:
    - port: 53
      protocol: UDP
  selector:
    app: coredns-internal

---
# External CoreDNS Service (LoadBalancer)
apiVersion: v1
kind: Service
metadata:
  name: coredns-external
  namespace: kube-system
spec:
  type: LoadBalancer
  ports:
    - port: 53
      protocol: UDP
  selector:
    app: coredns-external
```

Internal Corefile serves full cluster DNS:

```corefile
.:53 {
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    file /etc/coredns/zones/internal-overrides.db
    forward . 10.0.0.53
    cache 30
    errors
    health
    ready
    prometheus :9153
}
```

External Corefile serves only public records:

```corefile
.:53 {
    file /etc/coredns/zones/external-overrides.db
    forward . 8.8.8.8 8.8.4.4
    cache 300
    errors
    health
    ready
    prometheus :9153
}
```

## NodeLocal DNSCache

NodeLocal DNSCache runs a DNS caching agent as a DaemonSet on every node, intercepting DNS queries before they reach the central CoreDNS Deployment. This significantly reduces latency and load on the CoreDNS Deployment.

### DaemonSet Configuration

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-local-dns
  namespace: kube-system
spec:
  selector:
    matchLabels:
      k8s-app: node-local-dns
  template:
    metadata:
      labels:
        k8s-app: node-local-dns
    spec:
      priorityClassName: system-node-critical
      hostNetwork: true
      dnsPolicy: Default
      tolerations:
        - operator: Exists
          effect: NoSchedule
      containers:
        - name: node-cache
          image: registry.k8s.io/dns/k8s-dns-node-cache:1.23.1
          args:
            - -localip
            - "169.254.20.10,10.96.0.10"
            - -conf
            - /etc/Corefile
            - -upstreamsvc
            - kube-dns
          ports:
            - containerPort: 53
              protocol: UDP
            - containerPort: 53
              protocol: TCP
            - containerPort: 9253
              protocol: TCP
          resources:
            requests:
              cpu: 25m
              memory: 5Mi
            limits:
              cpu: 100m
              memory: 70Mi
          volumeMounts:
            - mountPath: /etc/coredns
              name: config-volume
            - mountPath: /run/xtables.lock
              name: xtables-lock
              readOnly: false
      volumes:
        - name: config-volume
          configMap:
            name: node-local-dns
        - name: xtables-lock
          hostPath:
            path: /run/xtables.lock
            type: FileOrCreate
```

NodeLocal DNSCache Corefile:

```corefile
cluster.local:53 {
    errors
    cache {
        success 9984 30
        denial 9984 5
    }
    reload
    loop
    bind 169.254.20.10 10.96.0.10
    forward . 10.96.0.10 {
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
    bind 169.254.20.10 10.96.0.10
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
    bind 169.254.20.10 10.96.0.10
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
    bind 169.254.20.10 10.96.0.10
    forward . /etc/resolv.conf
    prometheus :9253
}
```

## DNS-Based Service Discovery Patterns

### Headless Services for StatefulSets

Headless services (ClusterIP: None) expose individual pod DNS records, enabling direct pod addressing:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: cassandra
  namespace: production
spec:
  clusterIP: None
  selector:
    app: cassandra
  ports:
    - port: 9042
```

Each pod in the associated StatefulSet gets a DNS record:

```
cassandra-0.cassandra.production.svc.cluster.local
cassandra-1.cassandra.production.svc.cluster.local
cassandra-2.cassandra.production.svc.cluster.local
```

### SRV Records for Service Port Discovery

CoreDNS generates SRV records for named service ports:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp
  namespace: production
spec:
  ports:
    - name: http
      port: 80
    - name: grpc
      port: 9090
  selector:
    app: myapp
```

Query for SRV records:

```bash
# Returns SRV record for the http port
dig +short SRV _http._tcp.myapp.production.svc.cluster.local

# Returns SRV record for the grpc port
dig +short SRV _grpc._tcp.myapp.production.svc.cluster.local
```

### ExternalName Services

ExternalName services create CNAME records that map a Kubernetes service name to an external DNS name:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-database
  namespace: production
spec:
  type: ExternalName
  externalName: db.prod.corp.example.com
```

Pods can then use `external-database.production.svc.cluster.local` which resolves to the external CNAME.

## Scaling CoreDNS for Large Clusters

### Horizontal Scaling Guidelines

The CoreDNS Deployment should scale proportionally to cluster size:

| Cluster Size | CoreDNS Replicas | CPU Request | Memory Request |
|---|---|---|---|
| Less than 100 nodes | 2 | 100m | 70Mi |
| 100-500 nodes | 4 | 200m | 128Mi |
| 500-1000 nodes | 6-8 | 300m | 256Mi |
| Over 1000 nodes | 10+ | 500m | 512Mi |

Configure the HorizontalPodAutoscaler:

```yaml
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

### Anti-Affinity for Resilience

```yaml
spec:
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
```

## Debugging DNS Failures

### Systematic Diagnosis Procedure

**Step 1: Verify CoreDNS pods are running**

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
```

**Step 2: Test resolution from a debug pod**

```bash
kubectl run dns-debug --image=busybox:1.28 --restart=Never --rm -it -- sh

# Inside the debug pod:
nslookup kubernetes.default.svc.cluster.local
nslookup google.com
cat /etc/resolv.conf
```

**Step 3: Check CoreDNS metrics**

```bash
kubectl -n kube-system port-forward svc/kube-dns 9153:9153 &
curl -s http://localhost:9153/metrics | grep coredns_dns_requests_total
```

Key metrics to monitor:

```promql
# Query rate per second
rate(coredns_dns_requests_total[5m])

# Error rate
rate(coredns_dns_responses_total{rcode="SERVFAIL"}[5m])

# Cache hit ratio
rate(coredns_cache_hits_total[5m]) /
  (rate(coredns_cache_hits_total[5m]) + rate(coredns_cache_misses_total[5m]))

# Forward latency p99
histogram_quantile(0.99, rate(coredns_forward_request_duration_seconds_bucket[5m]))
```

**Step 4: Enable query logging temporarily**

Add the `log` plugin to the Corefile — remove after debugging to avoid performance impact:

```corefile
.:53 {
    log
    errors
    # ... rest of config
}
```

### Common DNS Failure Patterns

**Pattern 1: SERVFAIL on external queries**

Cause: Upstream resolver unreachable or misconfigured.

```bash
# Test upstream connectivity from a CoreDNS pod
kubectl -n kube-system exec -it $(kubectl -n kube-system get pod -l k8s-app=kube-dns -o name | head -1) -- nslookup google.com 8.8.8.8
```

Resolution: Verify NetworkPolicy allows egress from CoreDNS pods to upstream resolvers on UDP/TCP 53.

**Pattern 2: Intermittent NXDOMAIN for cluster services**

Cause: The pod's `ndots:5` setting causes search domain exhaustion before trying the FQDN.

Resolution: Use FQDNs in application configuration, or reduce ndots per pod:

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"
      - name: attempts
        value: "2"
      - name: timeout
        value: "1"
```

**Pattern 3: High latency on first query**

Cause: Cache miss plus slow upstream plus ndots triggering multiple search-domain attempts.

Resolution: Enable NodeLocal DNSCache and configure `prefetch` in the cache plugin.

**Pattern 4: DNS resolution timeouts under load**

Cause: CoreDNS is under-provisioned or hitting `max_concurrent` limits on the forward plugin.

Resolution:

```bash
# Check if max_concurrent is being hit
kubectl -n kube-system logs -l k8s-app=kube-dns | grep "concurrent queries limit"

# Increase max_concurrent in forward plugin and add CoreDNS replicas
```

## Prometheus Alerting Rules

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
          expr: absent(up{job="coredns"} == 1)
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "CoreDNS is down"
            description: "No CoreDNS instances are up in the cluster."

        - alert: CoreDNSHighErrorRate
          expr: |
            (
              rate(coredns_dns_responses_total{rcode=~"SERVFAIL|REFUSED"}[5m])
              /
              rate(coredns_dns_requests_total[5m])
            ) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CoreDNS error rate above 5%"
            description: "CoreDNS is returning errors for {{ $value | humanizePercentage }} of queries."

        - alert: CoreDNSForwardLatencyHigh
          expr: |
            histogram_quantile(0.99,
              rate(coredns_forward_request_duration_seconds_bucket[5m])
            ) > 2
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CoreDNS forward latency p99 above 2s"

        - alert: CoreDNSCacheHitRateLow
          expr: |
            (
              rate(coredns_cache_hits_total[10m])
              /
              (rate(coredns_cache_hits_total[10m]) + rate(coredns_cache_misses_total[10m]))
            ) < 0.7
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "CoreDNS cache hit rate below 70%"
```

## Production Corefile Reference

The following Corefile represents a production-ready configuration for a large cluster with conditional forwarding and optimized caching:

```corefile
cluster.local:53 {
    errors
    health {
        lameduck 15s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }
    prometheus :9153
    cache {
        success 20000 3600 30
        denial  5000  150  5
        prefetch 20 2m 15%
        serve_stale 10s immediate
    }
    loop
    reload 30s
    loadbalance round_robin
}

corp.example.com:53 {
    forward . 10.0.0.53 10.0.0.54 {
        policy round_robin
        health_check 5s
        max_concurrent 500
    }
    cache 120
    errors
}

.:53 {
    errors
    forward . 8.8.8.8 8.8.4.4 1.1.1.1 {
        policy round_robin
        health_check 5s
        max_concurrent 1000
        timeout 2s
        expire 10s
    }
    cache {
        success 10000 3600 30
        denial  3000  300  10
        prefetch 10 1m 10%
    }
    prometheus :9153
    reload 30s
}
```

## Summary

Advanced CoreDNS configuration requires understanding the interaction between the `forward`, `cache`, `kubernetes`, and `file` plugins. For large-scale production clusters, the highest-impact changes are deploying NodeLocal DNSCache to reduce centralized CoreDNS load, tuning cache parameters to increase hit rates, implementing conditional forwarding for corporate DNS integration, and deploying CoreDNS with proper anti-affinity and HPA configuration. Continuous monitoring via Prometheus metrics and proactive alerting on error rates and forward latency are essential for maintaining DNS reliability across thousands of pods.
