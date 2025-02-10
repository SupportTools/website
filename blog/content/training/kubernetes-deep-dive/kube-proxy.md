---
title: "Deep Dive: Kubernetes Proxy (kube-proxy)"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["kubernetes", "kube-proxy", "networking", "services"]
categories: ["Kubernetes Deep Dive"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive deep dive into kube-proxy architecture, proxy modes, and service implementation"
url: "/training/kubernetes-deep-dive/kube-proxy/"
---

Kube-proxy is responsible for implementing the Kubernetes Service concept, providing network proxying and load balancing. This deep dive explores its architecture, proxy modes, and internal workings.

<!--more-->

# [Architecture Overview](#architecture)

## Component Architecture
```plaintext
Service -> kube-proxy -> Proxy Mode (iptables/IPVS)
                     -> Connection Tracking
                     -> Load Balancing
```

## Key Components
1. **Proxy Modes**
   - userspace
   - iptables
   - IPVS
   - kernelspace

2. **Service Types**
   - ClusterIP
   - NodePort
   - LoadBalancer
   - ExternalName

3. **Load Balancing**
   - Session Affinity
   - Load Balancing Algorithms
   - Health Checking

# [Proxy Modes](#proxy-modes)

## 1. IPTables Mode
```bash
# Example iptables rules for ClusterIP service
-A KUBE-SERVICES -d 10.96.0.1/32 -p tcp -m tcp --dport 443 \
  -j KUBE-SVC-ERIFXISQEP7F7OF4

-A KUBE-SVC-ERIFXISQEP7F7OF4 -m statistic --mode random \
  --probability 0.33332999982 -j KUBE-SEP-WNBA2IHDGP2BOBGZ

-A KUBE-SEP-WNBA2IHDGP2BOBGZ -p tcp -m tcp \
  -j DNAT --to-destination 10.244.0.18:443
```

## 2. IPVS Mode
```bash
# IPVS configuration
ipvsadm -A -t 10.96.0.1:443 -s rr
ipvsadm -a -t 10.96.0.1:443 -r 10.244.0.18:443 -m
ipvsadm -a -t 10.96.0.1:443 -r 10.244.1.19:443 -m
```

## 3. Mode Comparison
```yaml
# Performance characteristics
Userspace:
  - CPU intensive
  - Higher latency
  - Simple implementation

IPTables:
  - Linear lookup time
  - Good for small/medium clusters
  - Native kernel feature

IPVS:
  - Hash table based
  - Better performance at scale
  - More load balancing algorithms
```

# [Service Implementation](#services)

## 1. ClusterIP Service
```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  selector:
    app: my-app
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
```

## 2. NodePort Service
```yaml
apiVersion: v1
kind: Service
metadata:
  name: nodeport-service
spec:
  type: NodePort
  selector:
    app: my-app
  ports:
  - port: 80
    targetPort: 8080
    nodePort: 30080
```

# [Load Balancing Configuration](#load-balancing)

## 1. Session Affinity
```yaml
apiVersion: v1
kind: Service
metadata:
  name: affinity-service
spec:
  selector:
    app: my-app
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
```

## 2. IPVS Scheduling
```bash
# Configure IPVS scheduler
ipvsadm -E -t 10.96.0.1:80 -s wrr

# Available algorithms:
# rr: round-robin
# wrr: weighted round-robin
# lc: least connection
# wlc: weighted least connection
# sh: source hashing
# dh: destination hashing
```

# [Performance Tuning](#performance)

## 1. System Settings
```bash
# Kernel parameters for networking
cat > /etc/sysctl.d/99-kubernetes-proxy.conf <<EOF
net.ipv4.vs.conn_reuse_mode = 0
net.ipv4.vs.expire_nodest_conn = 1
net.ipv4.vs.expire_quiescent_template = 1
net.ipv4.vs.sync_threshold = 0
EOF

sysctl --system
```

## 2. Resource Configuration
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kube-proxy
  namespace: kube-system
spec:
  containers:
  - name: kube-proxy
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      limits:
        cpu: "200m"
        memory: "256Mi"
```

# [Monitoring and Metrics](#monitoring)

## 1. Proxy Metrics
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kube-proxy
spec:
  endpoints:
  - interval: 30s
    port: metrics
  selector:
    matchLabels:
      k8s-app: kube-proxy
```

## 2. Important Metrics
```plaintext
# Key metrics to monitor
kube_proxy_sync_proxy_rules_duration_seconds
kube_proxy_sync_proxy_rules_last_timestamp_seconds
kube_proxy_network_programming_duration_seconds
```

# [Troubleshooting](#troubleshooting)

## Common Issues

1. **Service Connectivity**
```bash
# Check kube-proxy logs
kubectl logs -n kube-system kube-proxy-xxxxx

# Verify iptables rules
iptables-save | grep KUBE

# Check IPVS rules
ipvsadm -Ln
```

2. **Performance Issues**
```bash
# Monitor connection tracking
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Check proxy metrics
curl localhost:10249/metrics
```

3. **Rule Synchronization**
```bash
# Force proxy rules sync
kubectl delete pod -n kube-system -l k8s-app=kube-proxy

# Verify service endpoints
kubectl get endpoints my-service
```

# [Best Practices](#best-practices)

1. **Mode Selection**
   - Use IPVS for large clusters
   - Consider iptables for smaller deployments
   - Monitor performance metrics

2. **Resource Management**
   - Set appropriate resource limits
   - Monitor connection tracking
   - Configure kernel parameters

3. **High Availability**
   - Run on every node
   - Monitor proxy health
   - Configure proper timeouts

# [Advanced Configuration](#advanced)

## 1. Custom Configuration
```yaml
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
bindAddress: 0.0.0.0
metricsBindAddress: 0.0.0.0:10249
mode: "ipvs"
ipvs:
  scheduler: "rr"
  syncPeriod: "30s"
  minSyncPeriod: "10s"
iptables:
  masqueradeAll: true
  masqueradeBit: 14
  minSyncPeriod: "10s"
  syncPeriod: "30s"
```

## 2. Feature Gates
```yaml
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
featureGates:
  EndpointSlice: true
  TopologyAwareHints: true
```

For more information, check out:
- [Networking Deep Dive](/training/kubernetes-deep-dive/networking/)
- [Service Deep Dive](/training/kubernetes-deep-dive/services/)
- [Load Balancing](/training/kubernetes-deep-dive/load-balancing/)
