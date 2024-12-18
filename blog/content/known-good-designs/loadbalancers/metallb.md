---
title: "MetalLB as TCP/UDP Load Balancer for RKE2"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Load Balancers", "MetalLB", "RKE2", "Kubernetes"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "Guide for configuring MetalLB as a TCP/UDP load balancer in Layer2 mode for an RKE2 cluster."
more_link: "yes"
url: "/known-good-designs/loadbalancers/metallb-layer2/"
---

![MetalLB Layer2 Load Balancer](https://cdn.support.tools/known-good-designs/load-balancers/metallb-layer2/metallb-architecture.png)

This guide explains how to set up MetalLB as a Layer2 TCP/UDP load balancer for an RKE2 cluster.

For details on configuring ingress within RKE2, refer to the [Ingress NGINX Controller on RKE2 Guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/).

<!--more-->

# [Overview](#overview)

## [What is MetalLB?](#what-is-metallb)
MetalLB is a load balancer implementation for bare-metal Kubernetes clusters. In Layer2 mode, MetalLB assigns a virtual IP (VIP) to a service by broadcasting ARP requests to the local network.

### Key Features
- **Layer2 ARP-Based VIP Management**: Ideal for bare-metal and on-prem environments.
- **Supports TCP/UDP Traffic**: Load balances both TCP and UDP traffic.
- **High Availability**: Ensures failover between nodes for VIPs.

For more details, visit the [MetalLB Documentation](https://metallb.universe.tf/).

---

# [Setup Instructions](#setup-instructions)

## [Step 1: Install MetalLB](#step-1-install-metallb)

1. **Deploy the MetalLB Manifest**:
   ```bash
   kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.13.7/manifests/metallb.yaml
   ```

2. **Verify the Installation**:
   Ensure that the `metallb` pods are running in the `metallb-system` namespace:
   ```bash
   kubectl get pods -n metallb-system
   ```

## [Step 2: Configure the MetalLB ConfigMap](#step-2-configure-the-metallb-configmap)

### Example: Static IP Pool Configuration
1. **Create the ConfigMap**:
   Define a pool of IP addresses for MetalLB to use:
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     namespace: metallb-system
     name: config
   data:
     config: |
       address-pools:
       - name: default
         protocol: layer2
         addresses:
         - 192.168.1.240-192.168.1.250
   ```

2. **Apply the ConfigMap**:
   ```bash
   kubectl apply -f metallb-config.yaml
   ```

### Example: DHCP Configuration
For environments where DHCP is preferred, MetalLB can integrate with external DHCP servers. Update the configuration as follows:
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     namespace: metallb-system
     name: config
   data:
     config: |
       address-pools:
       - name: dhcp
         protocol: layer2
         auto-assign: true
   ```

## [Step 3: Test MetalLB](#step-3-test-metallb)

1. **Create a Service with LoadBalancer Type**:
   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: nginx-service
     namespace: default
   spec:
     selector:
       app: nginx
     ports:
       - protocol: TCP
         port: 80
         targetPort: 80
     type: LoadBalancer
   ```

2. **Validate the Assigned IP**:
   ```bash
   kubectl get svc nginx-service
   ```
   Expected output:
   ```plaintext
   NAME            TYPE           CLUSTER-IP       EXTERNAL-IP    PORT(S)        AGE
   nginx-service   LoadBalancer   10.96.0.1        192.168.1.240  80:30001/TCP   2m
   ```

---

# [Deploying MetalLB via ArgoCD](#deploying-metallb-via-argocd)

For environments leveraging ArgoCD for GitOps, you can deploy MetalLB with the following manifest:

### ArgoCD Application Manifest
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: metallb
  namespace: argocd
spec:
  destination:
    namespace: metallb-system
    server: https://kubernetes.default.svc
  project: load-balancers
  source:
    repoURL: https://github.com/metallb/metallb
    targetRevision: v0.13.7
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

MetalLB supports custom TCP/UDP load balancer configurations. For example, to create a dedicated load balancer for ingress traffic:

### Example ConfigMap Entry for Ingress Traffic
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  namespace: metallb-system
  name: config
data:
  config: |
    address-pools:
    - name: ingress
      protocol: layer2
      addresses:
      - 192.168.1.200-192.168.1.210
```

Then, create a service with `type: LoadBalancer` that uses this pool:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx
  namespace: ingress-nginx
spec:
  selector:
    app.kubernetes.io/name: ingress-nginx
  type: LoadBalancer
  ports:
    - port: 80
      targetPort: 80
    - port: 443
      targetPort: 443
```

---

# [Integration with RKE2](#integration-with-rke2)

MetalLB integrates seamlessly with RKE2 clusters to provide load balancing for Kubernetes services, including the control plane and ingress traffic. For more details, refer to the [Ingress NGINX Controller on RKE2 Guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/).

---

# [References](#references)
- [MetalLB Documentation](https://metallb.universe.tf/)
- [Ingress NGINX Controller on RKE2 Guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/)
- [ArgoCD Documentation](https://argoproj.github.io/argo-cd/)