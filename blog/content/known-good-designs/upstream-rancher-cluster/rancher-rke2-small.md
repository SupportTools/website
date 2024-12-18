---
title: "Rancher on Small RKE2 Cluster"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Upstream Rancher Cluster", "RKE2", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Upstream Rancher Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy a small RKE2 cluster with Rancher on custom on-prem servers using Helm."
more_link: "yes"
url: "/known-good-designs/upstream-rancher-cluster/rancher-rke2-small/"
---

This guide demonstrates how to deploy a small RKE2 cluster with Rancher installed, designed for on-premises environments with three pre-configured servers.

<!--more-->

# [Overview](#overview)

## [Small RKE2 Cluster for Rancher](#small-rke2-cluster-for-rancher)
This configuration deploys a lightweight RKE2 cluster consisting of two control-plane nodes and one worker node. It uses NGINX ingress and Rancher for Kubernetes management. This setup is ideal for development and small-scale production environments.

---

# [RKE2 Cluster Installation](#rke2-cluster-installation)

### Prerequisites
- Three servers with at least 4 CPUs and 8 GB of RAM.
- Ubuntu 22.04 or CentOS 8 installed on each server.
- Networking configured to allow communication between nodes.

### Step 1: Install RKE2 on Control Plane Nodes
1. SSH into each of the two control-plane nodes.
2. Install RKE2:
   ```bash
   curl -sfL https://get.rke2.io | sh -
   systemctl enable rke2-server.service
   systemctl start rke2-server.service
   ```
3. Copy the `/etc/rancher/rke2/rke2.yaml` file from the first control-plane node to your local machine for kubectl access.

### Step 2: Install RKE2 on the Worker Node
1. SSH into the worker node.
2. Install RKE2 in agent mode:
   ```bash
   curl -sfL https://get.rke2.io | INSTALL_RKE2_TYPE="agent" sh -
   systemctl enable rke2-agent.service
   systemctl start rke2-agent.service
   ```
3. Join the worker to the cluster by setting the server address and token in `/etc/rancher/rke2/config.yaml`:
   ```yaml
   server: https://<control-plane-ip>:9345
   token: <cluster-token>
   ```
4. Restart the RKE2 agent:
   ```bash
   systemctl restart rke2-agent.service
   ```

---

# [Ingress NGINX Deployment](#ingress-nginx-deployment)

Deploy the NGINX ingress controller using Helm:

### Create the Namespace
```bash
kubectl create namespace ingress-nginx
```

### Helm Chart Deployment
```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --set controller.service.type=LoadBalancer
```

---

# [Rancher Deployment](#rancher-deployment)

### Create the Namespace
```bash
kubectl create namespace cattle-system
```

### Helm Chart Deployment
```bash
helm repo add rancher-stable https://releases.rancher.com/server-charts/stable
helm repo update

helm install rancher rancher-stable/rancher \
  --namespace cattle-system \
  --set hostname=rancher.your-domain.com \
  --set ingress.tls.source=letsEncrypt \
  --set letsEncrypt.email=admin@your-domain.com \
  --set letsEncrypt.environment=production
```

---

# [Testing and Validation](#testing-and-validation)

### Accessing Rancher
1. Verify the Rancher pods:
   ```bash
   kubectl get pods -n cattle-system
   ```

2. Access Rancher via the hostname you specified:
   ```
   https://rancher.your-domain.com
   ```

### Testing NGINX Ingress
Deploy a sample application and verify ingress access using the LoadBalancer endpoint.

---

# [References](#references)
- [RKE2 Documentation](https://docs.rke2.io/)
- [Ingress NGINX Documentation](https://kubernetes.github.io/ingress-nginx/)
- [Rancher Helm Chart Documentation](https://rancher.com/docs/rancher/v2.7/en/installation/helm-chart-install/)

