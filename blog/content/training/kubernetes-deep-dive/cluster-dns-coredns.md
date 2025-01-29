---
title: "Understanding Cluster DNS with CoreDNS in Kubernetes"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "coredns", "cluster dns", "networking"]
categories: ["Kubernetes Deep Dive"]
author: "Matthew Mattox"
description: "A deep dive into CoreDNS, Kubernetes' default Cluster DNS service, its architecture, configuration, and troubleshooting."
url: "/training/kubernetes-deep-dive/cluster-dns-coredns/"
---

## Introduction

In a Kubernetes cluster, DNS plays a crucial role in **service discovery and inter-pod communication**. Kubernetes uses **CoreDNS** as the default DNS server to resolve internal and external domain names efficiently.

In this deep dive, we'll cover:
- What CoreDNS is and why it's important
- How CoreDNS integrates with Kubernetes
- CoreDNS configuration and customization
- Common troubleshooting steps

---

## What is CoreDNS?

**CoreDNS** is a flexible, extensible, and high-performance **DNS server** designed specifically for **Kubernetes environments**. It serves as the **Cluster DNS**, resolving internal Kubernetes services and external domains.

### **Why CoreDNS?**
- **Scalable & Lightweight** – Designed for high-performance DNS resolution.
- **Pluggable Architecture** – Allows custom DNS functionalities through plugins.
- **Secure** – Supports DNSSEC, caching, and request filtering.
- **Cloud-Native** – Runs as a **Kubernetes-native** service.

CoreDNS was introduced in Kubernetes **v1.11**, replacing **kube-dns** as the default DNS service.

---

## How CoreDNS Works in Kubernetes

CoreDNS runs as a **Deployment** in the `kube-system` namespace and operates as a **DNS Service** (`kube-dns`). It listens on port `53` (UDP and TCP) and resolves **internal Kubernetes services**.

### **CoreDNS Workflow**
1. **A pod makes a DNS request** (e.g., `curl http://my-service.default.svc.cluster.local`).
2. **CoreDNS checks its local cache** for an existing record.
3. **If not cached, CoreDNS queries the Kubernetes API** to resolve the requested service.
4. **The IP of the service is returned** to the pod.
5. **If the request is for an external domain**, CoreDNS forwards it to an upstream resolver (e.g., Google DNS, Cloudflare).

---

## CoreDNS Configuration in Kubernetes

The CoreDNS configuration is stored in a **ConfigMap** in the `kube-system` namespace:

### **View CoreDNS ConfigMap**
```bash
kubectl get configmap coredns -n kube-system -o yaml
```

### **Default CoreDNS Configuration**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
        }
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
```

### **Key Directives in the Corefile**
- **`kubernetes cluster.local`** – Handles internal service resolution.
- **`forward . /etc/resolv.conf`** – Forwards external queries to upstream DNS.
- **`cache 30`** – Caches DNS responses for 30 seconds.
- **`health` & `ready`** – Provide health checks for CoreDNS pods.
- **`reload`** – Enables dynamic reloading of configuration.

---

## Customizing CoreDNS

### **1. Changing Upstream DNS Servers**
Modify the `forward` directive to use custom resolvers (e.g., Google DNS, Cloudflare):
```yaml
forward . 8.8.8.8 8.8.4.4
```
Apply the changes:
```bash
kubectl apply -f coredns-config.yaml -n kube-system
kubectl rollout restart deployment coredns -n kube-system
```

### **2. Adding Custom Domain Resolutions**
To manually define **static DNS entries**, use the `hosts` plugin:
```yaml
hosts {
    192.168.1.100 custom-app.local
    fallthrough
}
```

### **3. Enabling Log Output for Debugging**
To log DNS queries:
```yaml
log
errors
```
Apply the changes and check logs:
```bash
kubectl logs -n kube-system deployment/coredns
```

---

## Troubleshooting CoreDNS Issues

### **1. Check CoreDNS Pods**
```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

### **2. Check DNS Resolution Inside a Pod**
```bash
kubectl run -it --rm --restart=Never --image=busybox dns-test -- nslookup my-service.default.svc.cluster.local
```

### **3. Restart CoreDNS Deployment**
```bash
kubectl rollout restart deployment coredns -n kube-system
```

### **4. Verify DNS ConfigMap**
```bash
kubectl describe configmap coredns -n kube-system
```

### **5. Test External DNS Resolution**
```bash
kubectl run -it --rm --restart=Never --image=busybox dns-test -- nslookup google.com
```

---

## Best Practices for CoreDNS Management

1. **Monitor CoreDNS Logs & Metrics**  
   - Use **Prometheus** & **Grafana** to track DNS performance.

2. **Optimize DNS Cache TTL**  
   - Adjust the `cache` setting based on workload requirements.

3. **Load Balance DNS Queries**  
   - Enable `loadbalance` to distribute DNS traffic evenly.

4. **Use Multiple DNS Pods for High Availability**  
   - Increase replicas for better resilience:
   ```bash
   kubectl scale deployment coredns --replicas=3 -n kube-system
   ```

5. **Secure External DNS Requests**  
   - Restrict outgoing DNS queries to prevent DNS leaks.

---

## Conclusion

CoreDNS is a **critical component** of Kubernetes networking, ensuring **service discovery and efficient DNS resolution**. By understanding how it works, configuring it properly, and troubleshooting effectively, you can maintain a **reliable and scalable** Kubernetes cluster.

For more Kubernetes deep dives, visit [support.tools](https://support.tools)!