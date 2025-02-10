---
title: "CNI Implementation Lab Guide"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["kubernetes", "networking", "cni", "lab", "hands-on"]
categories:
- Networking
- Training
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Hands-on lab guide for implementing and testing different CNI plugins"
more_link: "yes"
url: "/training/networking/cni-lab/"
---

This hands-on lab guide walks through the implementation and testing of different CNI plugins in a Kubernetes environment. You'll learn how to deploy, configure, and troubleshoot various CNI solutions.

<!--more-->

# [Lab Prerequisites](#prerequisites)

## Required Tools
```bash
# Install required tools
sudo apt-get update && sudo apt-get install -y \
  kubectl \
  kind \
  docker.io \
  jq \
  tcpdump
```

## Test Environment Setup
```bash
# Create a kind cluster without CNI
cat <<EOF > kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
nodes:
- role: control-plane
- role: worker
- role: worker
EOF

kind create cluster --config kind-config.yaml
```

# [Lab 1: Deploying Calico](#calico-lab)

## 1. Installation
```bash
# Install Calico operator
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.25.0/manifests/tigera-operator.yaml

# Configure Calico custom resources
cat <<EOF | kubectl apply -f -
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
    - blockSize: 26
      cidr: 192.168.0.0/16
      encapsulation: VXLANCrossSubnet
      natOutgoing: true
      nodeSelector: all()
EOF
```

## 2. Verify Installation
```bash
# Check pods
kubectl get pods -n calico-system

# Verify node status
kubectl get nodes

# Test pod connectivity
kubectl run nginx --image=nginx
kubectl expose pod nginx --port=80
kubectl run busybox --rm -it --image=busybox -- wget -O- nginx
```

## 3. Implement Network Policy
```bash
# Create test namespaces
kubectl create ns frontend
kubectl create ns backend

# Deploy test pods
kubectl -n frontend run frontend --image=nginx
kubectl -n backend run backend --image=nginx

# Create network policy
cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-policy
  namespace: backend
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: frontend
EOF
```

# [Lab 2: Implementing Cilium](#cilium-lab)

## 1. Installation
```bash
# Install Cilium CLI
curl -L --remote-name-all https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz
sudo tar xzvfC cilium-linux-amd64.tar.gz /usr/local/bin

# Install Cilium
cilium install

# Enable Hubble
cilium hubble enable
```

## 2. Network Visibility
```bash
# Install Hubble CLI
curl -L --remote-name-all https://github.com/cilium/hubble/releases/latest/download/hubble-linux-amd64.tar.gz
sudo tar xzvfC hubble-linux-amd64.tar.gz /usr/local/bin

# Set up port forward
cilium hubble port-forward&

# Monitor traffic
hubble observe
```

## 3. L7 Policy Implementation
```bash
# Deploy demo app
kubectl create -f https://raw.githubusercontent.com/cilium/cilium/master/examples/minikube/http-sw-app.yaml

# Apply L7 policy
cat <<EOF | kubectl apply -f -
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: "l7-policy"
spec:
  endpointSelector:
    matchLabels:
      org: empire
      class: deathstar
  ingress:
  - fromEndpoints:
    - matchLabels:
        org: empire
        class: tiefighter
    toPorts:
    - ports:
      - port: "80"
        protocol: TCP
      rules:
        http:
        - method: "POST"
          path: "/v1/request-landing"
EOF
```

# [Lab 3: Working with Flannel](#flannel-lab)

## 1. Basic Setup
```bash
# Apply Flannel manifest
kubectl apply -f https://raw.githubusercontent.com/flannel-io/flannel/master/Documentation/kube-flannel.yml

# Verify installation
kubectl get pods -n kube-system -l app=flannel
```

## 2. Configure Backend
```bash
# Create custom configuration
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-flannel-cfg
  namespace: kube-system
data:
  net-conf.json: |
    {
      "Network": "10.244.0.0/16",
      "Backend": {
        "Type": "vxlan",
        "VNI": 1
      }
    }
EOF
```

## 3. Testing Connectivity
```bash
# Deploy test pods
kubectl create deployment nginx --image=nginx --replicas=2
kubectl expose deployment nginx --port=80

# Test connectivity
kubectl run busybox --rm -it --image=busybox -- wget -O- nginx
```

# [Lab 4: Performance Testing](#performance-lab)

## 1. Setup Test Environment
```bash
# Deploy iperf3 pods
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: iperf3-server
spec:
  containers:
  - name: iperf3-server
    image: networkstatic/iperf3
    args: ["-s"]
---
apiVersion: v1
kind: Pod
metadata:
  name: iperf3-client
spec:
  containers:
  - name: iperf3-client
    image: networkstatic/iperf3
    command: ["/bin/sh", "-c", "sleep infinity"]
EOF
```

## 2. Run Performance Tests
```bash
# Get server IP
SERVER_IP=$(kubectl get pod iperf3-server -o jsonpath='{.status.podIP}')

# Run test
kubectl exec -it iperf3-client -- iperf3 -c $SERVER_IP -t 30
```

## 3. Analyze Results
```bash
# Capture network metrics
kubectl exec -n kube-system -l k8s-app=cilium -- cilium metrics
```

# [Lab 5: Troubleshooting](#troubleshooting-lab)

## 1. Network Debugging
```bash
# Check CNI configuration
ls /etc/cni/net.d/

# View CNI logs
kubectl logs -n kube-system -l k8s-app=calico-node

# Test DNS resolution
kubectl run dnsutils --image=gcr.io/kubernetes-e2e-test-images/dnsutils:1.3 --command -- sleep 3600
kubectl exec -it dnsutils -- nslookup kubernetes.default
```

## 2. Policy Troubleshooting
```bash
# Create test policy
cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: test-network-policy
spec:
  podSelector:
    matchLabels:
      role: db
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: frontend
EOF

# Test policy
kubectl run frontend --labels=role=frontend --image=nginx
kubectl run db --labels=role=db --image=nginx
```

# [Conclusion](#conclusion)

In this lab, you've gained hands-on experience with:
- Deploying different CNI plugins
- Configuring network policies
- Performance testing
- Troubleshooting network issues

Next steps:
- [CNI Deep Dive](/training/networking/cni/)
- [Network Security](/training/networking/security/)
- [Container Security](/training/networking/container-security/)
