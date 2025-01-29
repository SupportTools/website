---
title: "Setting Up the DigitalOcean Cloud Provider for RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "digitalocean", "cloud controller manager", "deep dive"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "A step-by-step guide to setting up the DigitalOcean cloud provider in RKE2, including configuring API tokens, setting up networking, and deploying the DigitalOcean Cloud Controller Manager."
url: "/training/rke2/digitalocean-cloud-provider-rke2/"
---

## Introduction

When running **RKE2** on **DigitalOcean**, Kubernetes requires cloud provider integration to:
- **Automatically provision Load Balancers**
- **Manage persistent storage with Block Storage**
- **Assign floating IPs to nodes and services**

The **DigitalOcean Cloud Controller Manager (CCM)** enables Kubernetes to manage these cloud resources efficiently.

This guide covers:
✅ **Why the DigitalOcean cloud provider is needed**  
✅ **Configuring a DigitalOcean API token**  
✅ **Setting up networking for RKE2**  
✅ **Deploying the DigitalOcean Cloud Controller Manager**  

---

## Why Use the DigitalOcean Cloud Provider in RKE2?

When you enable the **DigitalOcean cloud provider** in RKE2, Kubernetes gains:
1. **Load Balancer Integration** – Automatically provisions DigitalOcean Load Balancers for `Service type=LoadBalancer`.
2. **Persistent Storage Management** – Supports **DigitalOcean Block Storage (DO Volumes)** for persistent storage.
3. **Floating IP Assignment** – Assigns floating IPs to nodes and services.

Without this integration, Kubernetes cannot manage **DigitalOcean resources automatically**.

---

## Step 1: Create a DigitalOcean API Token

### 1.1 Generate an API Token
To integrate RKE2 with DigitalOcean, you need an **API Token**.

1. Log in to your **DigitalOcean** account.
2. Navigate to **API & Security** > **Personal Access Tokens**.
3. Click **Generate New Token**.
4. Provide:
   - **Name**: `rke2-cloud-provider`
   - **Scopes**: `Read` and `Write`
   - **Expiration**: Choose a suitable expiration period.
5. Click **Generate Token** and **copy the token** (it won’t be shown again).

---

## Step 2: Configure the RKE2 Cluster for DigitalOcean

### 2.1 Modify the Cluster Configuration
To enable the **DigitalOcean cloud provider**, modify the RKE2 cluster configuration.

#### **Control Plane Configuration:**
Edit your cluster YAML:
```yaml
spec:
  rkeConfig:
    machineSelectorConfig:
      - config:
          disable-cloud-controller: true
          kube-apiserver-arg:
            - cloud-provider=external
          kube-controller-manager-arg:
            - cloud-provider=external
          kubelet-arg:
            - cloud-provider=external
        machineLabelSelector:
          matchExpressions:
            - key: rke.cattle.io/control-plane-role
              operator: In
              values:
                - 'true'
```

#### **Worker Configuration:**
```yaml
spec:
  rkeConfig:
    machineSelectorConfig:
      - config:
          kubelet-arg:
            - cloud-provider=external
        machineLabelSelector:
          matchExpressions:
            - key: rke.cattle.io/worker-role
              operator: In
              values:
                - 'true'
```

---

## Step 3: Deploy the DigitalOcean Cloud Controller Manager (CCM)

Since **Kubernetes 1.27 removed in-tree DigitalOcean providers**, you must use the **out-of-tree DigitalOcean Cloud Controller Manager**.

### 3.1 Create a Kubernetes Secret for the API Token

Create a Kubernetes **Secret** to store the **DigitalOcean API Token**:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: digitalocean-cloud-config
  namespace: kube-system
type: Opaque
stringData:
  access-token: "<your-digitalocean-api-token>"
```

Apply the secret:
```bash
kubectl apply -f digitalocean-cloud-config.yaml
```

### 3.2 Install the DigitalOcean CCM Using Helm

Add the Helm repository:
```bash
helm repo add digitalocean https://digitalocean.github.io/do-cloud-controller-manager
helm repo update
```

Create a `values.yaml` file:
```yaml
cloudConfigSecretName: digitalocean-cloud-config
cloudControllerManager:
  nodeSelector:
    node-role.kubernetes.io/control-plane: 'true'
  tolerations:
    - effect: NoSchedule
      key: node-role.kubernetes.io/control-plane
      value: 'true'
```

Deploy the Helm chart:
```bash
helm upgrade --install digitalocean-cloud-controller \
  digitalocean/do-cloud-controller-manager \
  --values values.yaml -n kube-system
```

### 3.3 Verify the Installation

Check the Helm deployment:
```bash
helm status digitalocean-cloud-controller -n kube-system
```

Confirm that the **Cloud Controller Manager** is running:
```bash
kubectl get pods -n kube-system | grep cloud-controller-manager
```

Verify that nodes have been assigned a **ProviderID**:
```bash
kubectl describe nodes | grep "ProviderID"
```

---

## Step 4: Install the DigitalOcean CSI Driver (Optional)

DigitalOcean now requires **CSI drivers** for persistent volumes. Install the **DigitalOcean CSI driver**:

```bash
helm repo add digitalocean https://digitalocean.github.io/csi-digitalocean
helm repo update digitalocean

helm install digitalocean-csi-driver digitalocean/csi-digitalocean \
  --namespace kube-system
```

Verify installation:
```bash
kubectl get pods -n kube-system | grep csi
```

Create a **StorageClass**:
```yaml
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: do-block-storage
provisioner: dobs.csi.digitalocean.com
parameters:
  fsType: ext4
```
Apply it:
```bash
kubectl apply -f storageclass.yaml
```

---

## Conclusion

Configuring the **DigitalOcean cloud provider** in **RKE2** enables Kubernetes to **fully integrate with DigitalOcean**, allowing:
✅ **Automated Load Balancer provisioning**  
✅ **Persistent storage with DigitalOcean Block Storage**  
✅ **Floating IP assignment for nodes**  

With **Kubernetes 1.27+, migration to the out-of-tree DigitalOcean Cloud Controller Manager is required** to maintain full cloud functionality.

For further details, check out the [DigitalOcean Cloud Controller Docs](https://github.com/digitalocean/digitalocean-cloud-controller-manager).

---

*Want more Kubernetes insights? Browse the [RKE2 Training](https://support.tools/categories/rke2-training/) series for expert insights!*
