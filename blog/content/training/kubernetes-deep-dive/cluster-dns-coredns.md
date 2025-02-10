---
title: "Deep Dive: Kubernetes DNS (CoreDNS)"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["kubernetes", "coredns", "dns", "service-discovery"]
categories: ["Kubernetes Deep Dive"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive deep dive into Kubernetes DNS architecture, CoreDNS configuration, and service discovery"
url: "/training/kubernetes-deep-dive/cluster-dns-coredns/"
---

CoreDNS serves as the DNS server in Kubernetes clusters, providing service discovery and name resolution. This deep dive explores its architecture, configuration, and advanced features.

<!--more-->

# [Architecture Overview](#architecture)

## Component Architecture
```plaintext
Pod -> kubelet -> CoreDNS -> Service Discovery
                         -> External DNS
                         -> Custom DNS
```

## Key Components
1. **CoreDNS Server**
   - DNS Service
   - Plugin Chain
   - Caching Layer

2. **Service Discovery**
   - Service Records
   - Pod Records
   - External Services

3. **DNS Resolution**
   - Internal Resolution
   - Forward Resolution
   - Custom Domains

# [CoreDNS Configuration](#configuration)

## 1. Basic Corefile
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
    forward . /etc/resolv.conf
    cache 30
    loop
    reload
    loadbalance
}
```

## 2. Custom DNS Configuration
```corefile
example.com:53 {
    file /etc/coredns/example.com.db
    prometheus
    errors
    log
}

.:53 {
    kubernetes cluster.local {
        pods insecure
        upstream
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . 8.8.8.8 8.8.4.4
    cache 30
    loop
    reload
    loadbalance
}
```

# [Service Discovery](#service-discovery)

## 1. DNS Records
```yaml
# Service DNS Records
<service-name>.<namespace>.svc.cluster.local
# Example: my-service.default.svc.cluster.local

# Pod DNS Records
<pod-ip>.<namespace>.pod.cluster.local
# Example: 10-244-1-10.default.pod.cluster.local
```

## 2. Custom DNS Entries
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom
  namespace: kube-system
data:
  example.server: |
    example.org {
        forward . 8.8.8.8
    }
```

# [Advanced Features](#features)

## 1. DNS Policies
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: custom-dns
spec:
  dnsPolicy: "None"
  dnsConfig:
    nameservers:
      - 1.1.1.1
    searches:
      - ns1.svc.cluster.local
      - my.dns.search.suffix
    options:
      - name: ndots
        value: "2"
      - name: edns0
```

## 2. Auto Scaling
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
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
```

# [Performance Tuning](#performance)

## 1. Cache Configuration
```corefile
.:53 {
    cache {
        success 10000
        denial 5000
        prefetch 10 10m 10%
    }
}
```

## 2. Resource Management
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: coredns
spec:
  containers:
  - name: coredns
    resources:
      requests:
        memory: 70Mi
        cpu: 100m
      limits:
        memory: 170Mi
        cpu: 200m
```

# [Monitoring and Metrics](#monitoring)

## 1. Prometheus Metrics
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
  selector:
    matchLabels:
      k8s-app: kube-dns
```

## 2. Important Metrics
```plaintext
# Key metrics to monitor
coredns_dns_requests_total
coredns_dns_responses_total
coredns_cache_hits_total
coredns_cache_misses_total
```

# [Troubleshooting](#troubleshooting)

## Common Issues

1. **DNS Resolution Problems**
```bash
# Check CoreDNS pods
kubectl get pods -n kube-system -l k8s-app=kube-dns

# View CoreDNS logs
kubectl logs -n kube-system -l k8s-app=kube-dns

# Test DNS resolution
kubectl run dnsutils --image=gcr.io/kubernetes-e2e-test-images/dnsutils:1.3 \
  -- sleep infinity
kubectl exec -it dnsutils -- nslookup kubernetes.default
```

2. **Cache Issues**
```bash
# Clear CoreDNS cache
kubectl delete pod -n kube-system -l k8s-app=kube-dns

# Monitor cache metrics
curl http://localhost:9153/metrics | grep coredns_cache
```

3. **Performance Problems**
```bash
# Check resource usage
kubectl top pod -n kube-system -l k8s-app=kube-dns

# Monitor DNS latency
coredns_dns_request_duration_seconds_bucket
```

# [Best Practices](#best-practices)

1. **High Availability**
   - Run multiple replicas
   - Use pod anti-affinity
   - Configure proper health checks
   - Implement proper monitoring

2. **Performance**
   - Optimize cache settings
   - Configure proper TTLs
   - Monitor resource usage
   - Use autoscaling

3. **Security**
   - Restrict external queries
   - Implement DNSSEC
   - Use proper RBAC
   - Monitor DNS traffic

# [Advanced Configuration](#advanced)

## 1. Custom Plugins
```corefile
.:53 {
    errors
    health
    kubernetes cluster.local {
        pods verified
        fallthrough in-addr.arpa ip6.arpa
    }
    hosts custom.hosts {
        10.0.0.1 my.custom.domain
        fallthrough
    }
    prometheus :9153
    forward . 8.8.8.8 {
        max_concurrent 1000
    }
    cache 30
    reload
}
```

## 2. Split DNS
```corefile
internal:53 {
    kubernetes cluster.local {
        pods insecure
    }
    cache 30
}

external:53 {
    forward . 8.8.8.8
    cache 30
}
```

For more information, check out:
- [Service Discovery Deep Dive](/training/kubernetes-deep-dive/service-discovery/)
- [Networking Deep Dive](/training/kubernetes-deep-dive/networking/)
- [DNS Best Practices](/training/kubernetes-deep-dive/dns-best-practices/)
