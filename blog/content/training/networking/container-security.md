---
title: "Container Network Security"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["containers", "kubernetes", "security", "networking", "cni"]
categories:
- Networking
- Training
- Security
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to securing container networks in modern cloud-native environments"
more_link: "yes"
url: "/training/networking/container-security/"
---

Container networking introduces unique security challenges that require specific approaches and tools. This guide covers essential concepts and best practices for securing container networks.

<!--more-->

# [Container Network Security Fundamentals](#fundamentals)

## Core Concepts
1. **Network Isolation**
   - Container namespaces
   - Network segmentation
   - Pod security policies

2. **Network Policies**
   - Traffic control
   - Micro-segmentation
   - Zero-trust architecture

# [Kubernetes Network Security](#kubernetes)

## Network Policies
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

## Pod Security Context
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-pod
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
  containers:
  - name: app
    image: nginx
    securityContext:
      allowPrivilegeEscalation: false
```

# [CNI Security Features](#cni-security)

## 1. Calico Network Policies
```yaml
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: allow-specific-traffic
spec:
  selector: app == 'frontend'
  ingress:
  - action: Allow
    protocol: TCP
    source:
      selector: role == 'backend'
    destination:
      ports:
      - 80
```

## 2. Cilium Network Security
```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: http-policy
spec:
  endpointSelector:
    matchLabels:
      app: myapp
  ingress:
  - fromEndpoints:
    - matchLabels:
        role: frontend
    toPorts:
    - ports:
      - port: "80"
        protocol: TCP
      rules:
        http:
        - method: GET
          path: "/api/v1/"
```

# [Container Runtime Security](#runtime)

## 1. Docker Security
```bash
# Run container with security options
docker run \
  --security-opt="no-new-privileges=true" \
  --cap-drop=ALL \
  --cap-add=NET_BIND_SERVICE \
  nginx
```

## 2. Containerd Security
```toml
# /etc/containerd/config.toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
  runtime_type = "io.containerd.runc.v2"
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
    SystemdCgroup = true
    NoNewPrivileges = true
```

# [Network Encryption](#encryption)

## 1. Mutual TLS (mTLS)
```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system
spec:
  mtls:
    mode: STRICT
```

## 2. IPsec Encryption
```yaml
apiVersion: projectcalico.org/v3
kind: IPPool
metadata:
  name: ippool-1
spec:
  cidr: 192.168.0.0/16
  ipipMode: Always
  natOutgoing: true
  encryption:
    type: ipsec
    ipsec:
      ikev2:
        authenticationMethod: psk
```

# [Monitoring and Detection](#monitoring)

## 1. Network Flow Logs
```yaml
apiVersion: flow.cilium.io/v1alpha1
kind: FlowSchema
metadata:
  name: flow-logs
spec:
  targetRef:
    kind: Namespace
    name: default
  collector:
    type: files
    files:
      path: /var/log/flows
```

## 2. Intrusion Detection
```yaml
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: ids-policy
spec:
  description: "IDS Policy"
  ingress:
  - fromEntities:
    - world
    toPorts:
    - ports:
      - port: "80"
        protocol: TCP
      rules:
        http:
        - method: GET
          path: "/api"
    ids:
      - action: alert
        signature: "ET WEB_SERVER SQL Injection"
```

# [Best Practices](#best-practices)

1. **Network Segmentation**
   - Use namespaces for isolation
   - Implement network policies
   - Enable mTLS between services

2. **Access Control**
   - Restrict container capabilities
   - Use pod security policies
   - Implement RBAC

3. **Monitoring**
   - Enable flow logs
   - Monitor network traffic
   - Set up alerts

# [Troubleshooting](#troubleshooting)

## Common Issues
```bash
# Check network policies
kubectl describe networkpolicy

# Debug pod connectivity
kubectl exec -it pod-name -- tcpdump -i any

# View security events
kubectl get events --field-selector type=Warning
```

# [Security Checklist](#checklist)

1. **Network Policies**
   - [ ] Default deny policies in place
   - [ ] Specific allow rules documented
   - [ ] Regular policy review

2. **Encryption**
   - [ ] mTLS enabled
   - [ ] Certificates properly managed
   - [ ] Network encryption configured

3. **Monitoring**
   - [ ] Flow logs enabled
   - [ ] IDS/IPS configured
   - [ ] Alerts set up

# [Conclusion](#conclusion)

Container network security requires a multi-layered approach combining network policies, encryption, monitoring, and best practices. Regular audits and updates are essential for maintaining security.

For more information, check out:
- [Network Security Fundamentals](/training/networking/security/)
- [Kubernetes VXLAN Networking](/training/networking/kubernetes-vxlan/)
- [Service Mesh Security](/training/networking/service-mesh/)
