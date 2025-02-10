---
title: "Understanding Container Network Interface (CNI)"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["kubernetes", "networking", "cni", "containers"]
categories:
- Networking
- Training
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Container Network Interface (CNI) plugins, their deployment, and comparison"
more_link: "yes"
url: "/training/networking/cni/"
---

Container Network Interface (CNI) is a specification and set of libraries for configuring network interfaces in Linux containers. This guide explores different CNI plugins, their architectures, and how to choose the right one for your environment.

<!--more-->

# [What is CNI?](#introduction)

CNI (Container Network Interface) is:
- A specification for configuring network interfaces in Linux containers
- A set of plugins that implement the specification
- A library for writing plugins
- A simple contract between container runtime and network implementation

## Basic CNI Flow
```plaintext
Container Runtime -> CNI Plugin -> Network Configuration
```

# [Popular CNI Plugins](#plugins)

## 1. Calico
### Overview
- Layer 3 networking
- Network policy enforcement
- BGP routing support
- High performance

### Installation
```bash
# Install Calico operator
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.25.0/manifests/tigera-operator.yaml

# Install Calico custom resources
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.25.0/manifests/custom-resources.yaml
```

### Key Features
- BGP routing
- Network policies
- IPAM
- Cross-subnet overlay

## 2. Flannel
### Overview
- Simple overlay network
- Easy to set up
- VXLAN encapsulation
- Focused on networking only

### Installation
```bash
kubectl apply -f https://raw.githubusercontent.com/flannel-io/flannel/master/Documentation/kube-flannel.yml
```

### Key Features
- Layer 2 overlay
- Multiple backend support
- Simple architecture
- Low overhead

## 3. Cilium
### Overview
- eBPF-based networking
- Advanced security features
- High performance
- Observability

### Installation
```bash
# Install Cilium CLI
curl -L --remote-name-all https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz
sudo tar xzvfC cilium-linux-amd64.tar.gz /usr/local/bin

# Install Cilium
cilium install
```

### Key Features
- eBPF-based networking
- Layer 7 policy enforcement
- Kubernetes services implementation
- Advanced observability

## 4. Weave Net
### Overview
- Multi-host networking
- Service discovery
- Network policy support
- Encryption support

### Installation
```bash
kubectl apply -f "https://cloud.weave.works/k8s/net?k8s-version=$(kubectl version | base64 | tr -d '\n')"
```

### Key Features
- Automatic network configuration
- Encryption
- Multicast support
- Service discovery

# [CNI Comparison](#comparison)

## Feature Matrix

| Feature | Calico | Flannel | Cilium | Weave Net |
|---------|---------|----------|---------|-----------|
| Network Policy | ✓ | - | ✓ | ✓ |
| Encryption | ✓ | - | ✓ | ✓ |
| BGP Support | ✓ | - | - | - |
| Layer 7 Policy | - | - | ✓ | - |
| Performance | High | Medium | Very High | Medium |
| Complexity | Medium | Low | High | Medium |

## Performance Characteristics

### Network Latency
```plaintext
Cilium (eBPF) < Calico (Native) < Weave < Flannel (VXLAN)
```

### Memory Usage
```plaintext
Flannel < Calico < Weave < Cilium
```

# [Deployment Scenarios](#deployment)

## 1. On-Premises Deployment
Best choices:
- Calico: For BGP integration
- Cilium: For high performance

## 2. Cloud Provider
Best choices:
- Flannel: For simplicity
- Calico: For network policy

## 3. Edge/IoT
Best choices:
- Flannel: For resource constraints
- Calico: For security requirements

# [Advanced Configuration](#configuration)

## Calico BGP Configuration
```yaml
apiVersion: projectcalico.org/v3
kind: BGPConfiguration
metadata:
  name: default
spec:
  logSeverityScreen: Info
  nodeToNodeMeshEnabled: true
  asNumber: 63400
```

## Cilium Network Policy
```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: "http-policy"
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
          path: "/api/v1"
```

## Flannel Backend Configuration
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-flannel-cfg
data:
  net-conf.json: |
    {
      "Network": "10.244.0.0/16",
      "Backend": {
        "Type": "vxlan"
      }
    }
```

# [Troubleshooting](#troubleshooting)

## Common Issues

### 1. Pod Network Connectivity
```bash
# Check CNI pods
kubectl get pods -n kube-system -l k8s-app=calico-node

# Check CNI logs
kubectl logs -n kube-system calico-node-xxxxx -c calico-node

# Test pod connectivity
kubectl exec -it pod-name -- ping other-pod-ip
```

### 2. Network Policy Issues
```bash
# Verify policy
kubectl describe networkpolicy policy-name

# Check CNI policy logs
kubectl logs -n kube-system calico-node-xxxxx -c calico-node | grep policy
```

### 3. Performance Issues
```bash
# Check CNI metrics
kubectl -n kube-system exec -it cilium-xxxxx -- cilium metrics
```

# [Best Practices](#best-practices)

1. **Selection Criteria**
   - Network requirements
   - Security needs
   - Performance demands
   - Operational complexity

2. **Deployment**
   - Use operator patterns
   - Configure IPAM properly
   - Enable monitoring
   - Regular updates

3. **Maintenance**
   - Monitor performance
   - Regular updates
   - Backup configurations
   - Document customizations

# [Conclusion](#conclusion)

Choosing the right CNI plugin depends on your specific requirements:
- Use Calico for strong network policy and BGP support
- Use Cilium for high performance and advanced security
- Use Flannel for simplicity and basic networking
- Use Weave Net for encryption and multicast needs

For more information, check out:
- [Kubernetes VXLAN Networking](/training/networking/kubernetes-vxlan/)
- [Container Network Security](/training/networking/container-security/)
- [Network Performance](/training/networking/performance/)
