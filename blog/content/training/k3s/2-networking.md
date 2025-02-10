---
title: "K3s Networking Deep Dive"
date: 2025-01-01T00:00:00-05:00
draft: true
tags: ["K3s", "Kubernetes", "Networking", "CNI"]
categories:
- K3s
- Training
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Understanding K3s networking components, CNI options, and service load balancing"
more_link: "yes"
url: "/training/k3s/networking/"
---

This guide explores the networking components of K3s, including CNI implementations, service networking, and the built-in Klipper Load Balancer.

<!--more-->

# [Networking Components](#networking-components)

## Default CNI (Flannel)
K3s ships with Flannel as the default CNI provider:
- VXLAN overlay network
- Simple and reliable
- Minimal configuration needed
- Works across most environments

```yaml
# Flannel configuration in K3s
flannel-backend: "vxlan"     # Default backend
flannel-ipv6-masq: "true"    # IPv6 masquerading
flannel-external-ip: "true"  # Use external IPs
```

## Alternative CNI Options

### Calico
```bash
# Disable default CNI during installation
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--flannel-backend=none --disable-network-policy" sh -

# Install Calico
kubectl apply -f https://docs.projectcalico.org/manifests/calico.yaml
```

### Cilium
```bash
# Install K3s without Flannel
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--flannel-backend=none --disable-network-policy" sh -

# Install Cilium
helm repo add cilium https://helm.cilium.io/
helm install cilium cilium/cilium --namespace kube-system
```

# [Service Networking](#service-networking)

## Service Types
1. **ClusterIP**
   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: my-service
   spec:
     type: ClusterIP
     ports:
     - port: 80
       targetPort: 8080
     selector:
       app: my-app
   ```

2. **NodePort**
   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: my-nodeport
   spec:
     type: NodePort
     ports:
     - port: 80
       targetPort: 8080
       nodePort: 30080
     selector:
       app: my-app
   ```

3. **LoadBalancer**
   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: my-lb
   spec:
     type: LoadBalancer
     ports:
     - port: 80
       targetPort: 8080
     selector:
       app: my-app
   ```

# [Klipper Load Balancer](#klipper-lb)

## Overview
Klipper LoadBalancer is K3s's built-in service load balancer:
- Lightweight implementation
- Uses available host ports
- Supports both TCP and UDP
- Automatic failover

## How It Works
1. Service Creation
   - LoadBalancer type service is created
   - Klipper assigns host ports
   - Creates iptables rules

2. Traffic Flow
   ```
   External Traffic -> Node Port -> Service -> Pods
   ```

## Configuration
```yaml
# Service with specific settings
apiVersion: v1
kind: Service
metadata:
  name: nginx
  annotations:
    serviceloadbalancer.kubernetes.io/ipaddress: "192.168.1.100"
spec:
  type: LoadBalancer
  ports:
  - port: 80
    targetPort: 80
  selector:
    app: nginx
```

# [Network Policies](#network-policies)

## Default Policies
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
  - Ingress
```

## Application Policies
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-allow
spec:
  podSelector:
    matchLabels:
      app: api
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    ports:
    - protocol: TCP
      port: 8080
```

# [Ingress Configuration](#ingress)

## Traefik (Default)
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
spec:
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-service
            port:
              number: 80
```

## Custom Configuration
```yaml
# /etc/rancher/k3s/config.yaml
disable-traefik: true  # Disable default ingress
```

# [Troubleshooting](#troubleshooting)

## Network Connectivity
```bash
# Check CNI pods
kubectl get pods -n kube-system -l k8s-app=flannel

# Test pod connectivity
kubectl exec -it pod-name -- ping other-pod-ip

# Check service resolution
kubectl exec -it pod-name -- nslookup kubernetes.default
```

## Common Issues

1. **Pod-to-Pod Communication**
   ```bash
   # Check CNI configuration
   ls /etc/cni/net.d/
   cat /etc/cni/net.d/10-flannel.conflist
   ```

2. **Service Discovery Issues**
   ```bash
   # Check CoreDNS
   kubectl get pods -n kube-system -l k8s-app=kube-dns
   kubectl logs -n kube-system -l k8s-app=kube-dns
   ```

3. **Load Balancer Problems**
   ```bash
   # Check service status
   kubectl describe service service-name
   
   # Check endpoints
   kubectl get endpoints service-name
   ```

# [Best Practices](#best-practices)

1. **Network Security**
   - Implement network policies
   - Secure external access
   - Regular security audits
   - Monitor network traffic

2. **Performance**
   - Choose appropriate CNI
   - Monitor network latency
   - Optimize service configuration
   - Regular performance testing

3. **Maintenance**
   - Regular CNI updates
   - Monitor network resources
   - Backup network configurations
   - Document network topology

For more detailed information, visit the [official K3s documentation](https://rancher.com/docs/k3s/latest/en/).
