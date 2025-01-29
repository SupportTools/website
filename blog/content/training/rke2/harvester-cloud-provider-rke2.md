```markdown
---
title: "Setting Up the Harvester Cloud Provider in RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "harvester", "cloud provider", "cpi", "csi"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "A guide to setting up the Harvester Cloud Provider in RKE2, including the Cloud Provider Interface (CPI) and Cloud Storage Interface (CSI)."
url: "/training/rke2/setup-harvester-cloud-provider-rke2/"
more_link: "/categories/rke2-training/"
---

## Introduction

[Harvester](https://harvesterhci.io/) is a **Hyperconverged Infrastructure (HCI) solution** built on Kubernetes that allows users to manage VMs, Kubernetes, and cloud-native workloads seamlessly.

Harvester provides an **out-of-tree Cloud Provider Interface (CPI) and Cloud Storage Interface (CSI)**, enabling **Kubernetes clusters running on Harvester** to integrate seamlessly with Harvester storage and networking.

This guide covers the **installation and configuration** of the **Harvester CPI and CSI** for **RKE2**.

---

## Harvester Cloud Provider Overview

RKE1 and RKE2 clusters can be provisioned in Rancher using the built-in **Harvester Node Driver**. Harvester provides:

✅ **Load Balancer Support** – Assigns a dedicated Harvester LoadBalancer to Kubernetes services.  
✅ **Harvester Cluster Storage Passthrough** – Supports Longhorn-backed storage for persistent volumes.  

### **What You Will Learn**
📌 How to deploy the **Harvester Cloud Provider** in both **RKE1** and **RKE2** clusters.  
📌 How to use the **Harvester Load Balancer**.  

---

## Backward Compatibility Notice

⚠ **Important Compatibility Issue**  
If you're using **Harvester Cloud Provider v0.2.2 or higher**, ensure that:

- If your **Harvester version is below v1.2.0**, upgrade **Harvester** before upgrading:
  - **RKE2 to v1.26.6+rke2r1 or higher**
  - **Harvester Cloud Provider to v0.2.2 or higher**

Failure to upgrade **Harvester first** may lead to **incompatibility issues**.  
Refer to the [Harvester CCM & CSI Driver with RKE2 Releases](https://harvesterhci.io/docs/) for more details.

---

## Deploying the Harvester Cloud Provider

### **Prerequisites**
✅ **The Kubernetes cluster is built on top of Harvester virtual machines**.  
✅ **Guest Kubernetes nodes run in the same Harvester namespace**.  
✅ **Each Harvester VM must have the `macvlan` kernel module** for **LoadBalancer DHCP IPAM mode**.

To check if the module is installed, run:

```bash
lsmod | grep macvlan
sudo modprobe macvlan
```

If missing, you may need to **build custom cloud images** that include the module.

---

## Deploying to an RKE1 Cluster with Harvester Node Driver

1. **Select `Harvester (Out-of-Tree)` as the Cloud Provider.**  
2. **Install `Harvester Cloud Provider` from the Rancher Marketplace.**  

This will enable **both CPI and CSI** automatically.

---

## Deploying to an RKE2 Cluster with Harvester Node Driver

1. **Select `Harvester` as the Cloud Provider.**  
2. **Rancher will deploy both the `CPI` and `CSI` automatically.**  

Starting with **Rancher v2.9.0**, you can configure a **specific folder for cloud config data** using:

```yaml
Data directory configuration path: "/etc/kubernetes/cloud-config"
```

---

## Manually Deploying to an RKE2 Custom Cluster

### **1. Generate the Cloud Config Data**
Run the following script to generate **Harvester cloud provider config**:

```bash
curl -sfL https://raw.githubusercontent.com/harvester/cloud-provider-harvester/master/deploy/generate_addon.sh | bash -s <serviceaccount name> <namespace>
```

📌 This script **requires** `kubectl` and `jq`. Ensure the **Harvester kubeconfig file** is available.

### **2. Copy Cloud Config to All Nodes**
Place the generated **cloud-config file** on every RKE2 node:

```bash
mkdir -p /etc/kubernetes/
mv cloud-config.yaml /etc/kubernetes/cloud-config
```

### **3. Set Cloud Provider to External in RKE2**
Edit the **Cluster Configuration** in Rancher:

```yaml
spec:
  rkeConfig:
    machineSelectorConfig:
      - config:
          kubelet-arg:
            - cloud-provider=external
```

### **4. Install the Harvester Helm Chart**
Deploy the **Harvester Cloud Provider** using Helm:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: harvester-cloud-provider
  namespace: kube-system
spec:
  targetNamespace: kube-system
  bootstrap: true
  repo: https://raw.githubusercontent.com/rancher/charts/dev-v2.9
  chart: harvester-cloud-provider
  version: 104.0.2+up0.2.6
  helmVersion: v3
```

Apply the manifest:

```bash
kubectl apply -f harvester-cloud-provider.yaml
```

---

## Using the Harvester Load Balancer

### **1. Create a Kubernetes LoadBalancer Service**
Once the **Harvester Cloud Provider is deployed**, you can create a **LoadBalancer service**:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
  annotations:
    cloudprovider.harvesterhci.io/ipam: dhcp
spec:
  selector:
    app: my-app
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
  type: LoadBalancer
```

### **2. IPAM Modes**
Harvester supports **three LoadBalancer IP allocation modes**:

| Mode | Description |
|------|------------|
| `dhcp` | Requests an IP address from a **DHCP server**. |
| `pool` | Allocates an IP from a **predefined Harvester IP pool**. |
| `share-ip` | Shares an IP with another LoadBalancer service. |

To **enable shared IP mode**, add the annotation:

```yaml
cloudprovider.harvesterhci.io/primary-service: primary-service-name
```

📌 **Limitations of Shared IP Mode**:
1. Services **cannot** share the same **port**.
2. **Secondary services** cannot share their IP with other services.

---

## Upgrading the Harvester Cloud Provider

### **Upgrade RKE2**
1. **Navigate to** ☰ **Cluster Management**.
2. **Select the cluster** to upgrade.
3. **Go to `⋮ > Edit Config`**.
4. **Select a newer `Kubernetes Version`**.
5. **Click Save**.

### **Upgrade RKE1 / K3s**
1. **Go to** ☰ **RKE/K3s Cluster > Apps > Installed Apps**.
2. **Find `harvester-cloud-provider` > `⋮ > Edit/Upgrade`**.
3. **Select a newer `Version`**.
4. **Click Update**.

📌 **Issue with Single-Node Clusters**  
If the upgrade gets stuck, manually **delete the old `harvester-cloud-provider` pod**.

---

## Conclusion

The **Harvester Cloud Provider** enables **native integration between Harvester and Kubernetes**, allowing RKE2 clusters to:

✅ **Use Harvester storage via CSI**  
✅ **Deploy LoadBalancers with Harvester IP management**  
✅ **Ensure seamless VM and Kubernetes workload coexistence**  

💡 **Recommendation**: If you're running Kubernetes on **Harvester**, setting up the **CPI and CSI** is essential for **storage and networking integration**.

For more details, check the [Harvester Cloud Provider Docs](https://harvesterhci.io/docs/).

---

*Want more Kubernetes insights? Explore the [RKE2 Training](https://support.tools/categories/rke2-training/) series!*
