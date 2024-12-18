---
title: "Kube-VIP as TCP/UDP Load Balancer for RKE2"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Load Balancers", "Kube-VIP", "RKE2", "Kubernetes"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "Guide for configuring Kube-VIP as a TCP/UDP load balancer in Layer2 mode for an RKE2 cluster."
more_link: "yes"
url: "/known-good-designs/loadbalancers/kube-vip-layer2/"
---

![Kube-VIP Layer2 Load Balancer](https://cdn.support.tools/known-good-designs/load-balancers/kube-vip-layer2/kube-vip-architecture.png)

This guide explains how to set up Kube-VIP as a Layer2 TCP/UDP load balancer for an RKE2 cluster.

For details on configuring ingress within RKE2, refer to the [Ingress NGINX Controller on RKE2 Guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/).

<!--more-->

# [Overview](#overview)

## [What is Kube-VIP?](#what-is-kube-vip)
Kube-VIP is a lightweight virtual IP (VIP) manager that provides TCP/UDP load balancing and virtual IPs for Kubernetes clusters. In Layer2 mode, Kube-VIP broadcasts ARP packets to associate a VIP with the active Kubernetes node.

### Key Features
- **Layer2 ARP-Based VIP Management**: Ideal for bare-metal and on-prem environments.
- **Built-in TCP/UDP Load Balancer**: Provides load balancing for Kubernetes services.
- **High Availability**: Ensures failover between nodes for VIPs.

For more details, visit the [Kube-VIP Documentation](https://kube-vip.io/).

---

# [Setup Instructions](#setup-instructions)

## [Step 1: Install Kube-VIP](#step-1-install-kube-vip)

1. **Deploy the Kube-VIP Manifest**:
   ```bash
   kubectl apply -f https://kube-vip.io/manifests/kube-vip.yaml
   ```

2. **Verify the Installation**:
   Ensure that the `kube-vip` pod is running in the `kube-system` namespace:
   ```bash
   kubectl get pods -n kube-system -l app=kube-vip
   ```

## [Step 2: Configure the Kube-VIP ConfigMap](#step-2-configure-the-kube-vip-configmap)

### Example: Static VIP Configuration
1. **Edit the ConfigMap**:
   Retrieve and edit the Kube-VIP ConfigMap:
   ```bash
   kubectl -n kube-system edit configmap kube-vip
   ```

2. **Set Layer2 Configuration**:
   Add the following configuration under the `data` section:
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: kube-vip
     namespace: kube-system
   data:
     vipAddress: "192.168.1.100" # Replace with your desired VIP
     vipSubnet: "255.255.255.0"
     enableARP: "true"
     loadBalancers:
       - name: rke2-api
         type: tcp
         vip: "192.168.1.100"
         ports:
           - port: 6443
             backends:
               - address: "192.168.1.101" # Replace with control-plane node IPs
                 port: 6443
               - address: "192.168.1.102"
                 port: 6443
   ```

### Example: DHCP Configuration
1. **Edit the ConfigMap**:
   If you prefer to use DHCP to obtain the VIP, modify the `ConfigMap` as follows:
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: kube-vip
     namespace: kube-system
   data:
     enableARP: "true"
     enableDHCP: "true"
     loadBalancers:
       - name: rke2-api
         type: tcp
         vip: "dhcp"
         ports:
           - port: 6443
             backends:
               - address: "192.168.1.101"
                 port: 6443
               - address: "192.168.1.102"
                 port: 6443
   ```

## [Step 3: Test the VIP](#step-3-test-the-vip)

1. **Validate ARP Entries**:
   Check ARP entries on another machine in the same network:
   ```bash
   arp -a | grep 192.168.1.100
   ```

2. **Test Connectivity**:
   Verify that the VIP forwards traffic to the RKE2 control plane:
   ```bash
   curl -k https://192.168.1.100:6443
   ```

---

# [Deploying Kube-VIP via ArgoCD](#deploying-kube-vip-via-argocd)

For environments leveraging ArgoCD for GitOps, you can deploy Kube-VIP with the following manifest:

### ArgoCD Application Manifest
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: kube-vip
  namespace: argocd
spec:
  destination:
    namespace: kube-system
    server: https://kubernetes.default.svc
  project: load-balancers
  source:
    repoURL: https://github.com/kube-vip/kube-vip
    targetRevision: v0.5.0
    path: manifests
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

---

# [Customizing Load Balancers](#customizing-load-balancers)

Kube-VIP supports custom TCP/UDP load balancer configurations. For example, to add an HTTP(S) load balancer for ingress traffic:

### Example ConfigMap Entry for Ingress Traffic
```yaml
loadBalancers:
  - name: ingress-http
    type: tcp
    vip: "192.168.1.200"
    ports:
      - port: 80
        backends:
          - address: "192.168.1.103" # Replace with ingress node IPs
            port: 80
          - address: "192.168.1.104"
            port: 80
  - name: ingress-https
    type: tcp
    vip: "192.168.1.200"
    ports:
      - port: 443
        backends:
          - address: "192.168.1.103"
            port: 443
          - address: "192.168.1.104"
            port: 443
```

---

# [Integration with RKE2](#integration-with-rke2)

Kube-VIP integrates seamlessly with RKE2 clusters to provide load balancing for Kubernetes services, including the control plane and ingress traffic. For more details, refer to the [Ingress NGINX Controller on RKE2 Guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/).

---

# [References](#references)
- [Kube-VIP Documentation](https://kube-vip.io/)
- [Ingress NGINX Controller on RKE2 Guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/)
