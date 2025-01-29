---
title: "Setting Up the In-Tree VMware vSphere Cloud Provider in RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "vsphere", "cloud provider", "deep dive"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "A guide to setting up the in-tree VMware vSphere cloud provider in RKE2, including configuration, networking, and best practices."
url: "/training/rke2/vsphere-in-tree-cloud-provider-rke2/"
---

## Introduction

When running **RKE2** on **VMware vSphere**, Kubernetes requires cloud provider integration to:
- **Automatically provision PersistentVolumes (VMFS, NFS, or vSAN)**
- **Manage VM-based networking and load balancing**
- **Ensure Kubernetes can interact with the vSphere API**

VMware vSphere provides two types of cloud provider integrations:
- **In-Tree vSphere Cloud Provider** (deprecated but still available)
- **Out-of-Tree vSphere Cloud Controller Manager (recommended for Kubernetes 1.27+)**

This guide focuses on **configuring the in-tree VMware vSphere Cloud Provider** in RKE2.

---

## Why Use the In-Tree VMware vSphere Cloud Provider?

While **out-of-tree cloud controllers** are the future, some organizations still require the **in-tree vSphere Cloud Provider** due to:
- **Legacy Kubernetes versions (before 1.27)**
- **Compatibility with existing storage integrations**
- **Lack of immediate migration support for CSI drivers**

### **Key Features:**
1. **Persistent Volume Management** – Allows dynamic provisioning of VMware **vSAN**, **VMFS**, and **NFS** volumes.
2. **Node Discovery & Networking** – Kubernetes nodes register in vSphere and integrate with VM networking.
3. **Storage Policy Support** – Supports vSphere Storage Policies for Kubernetes volumes.

---

## Step 1: Configure vSphere Credentials

### 1.1 Create a vSphere User for Kubernetes
In **vSphere**, create a user with permissions to manage VM resources.

1. Open **vSphere Client** and navigate to **Administration** > **Roles**.
2. Create a new role with the following permissions:
   - `Datastore > Allocate space`
   - `Datastore > Browse datastore`
   - `Datastore > Low-level file operations`
   - `Datastore > Remove file`
   - `Host > Configuration > Storage partition configuration`
   - `Host > Inventory > Modify cluster`
   - `Host > Inventory > Modify cluster`
   - `Network > Assign network`
   - `Resource > Assign virtual machine to resource pool`
   - `vApp > Assign resource pool`
   - `vApp > Assign vApp`
   - `Virtual machine > Configuration`
   - `Virtual machine > Interaction`
   - `Virtual machine > Provisioning`

3. Assign this role to the Kubernetes user for:
   - **vSphere Cluster**
   - **Datastore**
   - **Networks**

4. Generate a **service account password** and store it securely.

---

## Step 2: Configure the vSphere Cloud Provider in RKE2

The **in-tree vSphere Cloud Provider** is enabled in **RKE2 cluster YAML**.

### 2.1 Modify the Cluster Configuration

To enable the in-tree **vSphere Cloud Provider**, add the following to your **RKE2 cluster YAML**:

```yaml
rancher_kubernetes_engine_config:
  cloud_provider:
    name: vsphere
    vsphereCloudProvider:
      global:
        user: "your-vsphere-user"
        password: "your-vsphere-password"
        server: "your-vcenter-server"
        port: 443
        insecureFlag: true
      virtualCenter:
        "your-vcenter-server":
          datacenters: "your-datacenter"
      workspace:
        server: "your-vcenter-server"
        datacenter: "your-datacenter"
        default-datastore: "your-default-datastore"
        folder: "/your-vm-folder"
        resourcepool-path: "/your-resource-pool"
        compute-cluster: "your-cluster-name"
```

📌 **Notes:**
- Replace `"your-vsphere-user"` with the **service account username**.
- Replace `"your-vsphere-password"` with the **service account password**.
- Replace `"your-vcenter-server"` with the **vCenter FQDN or IP**.
- Replace `"your-datacenter"` with your **vSphere Datacenter name**.
- Replace `"your-default-datastore"` with the **default datastore** for Kubernetes volumes.

### 2.2 Apply the Configuration
Once the YAML file is updated, apply it when creating the RKE2 cluster.

---

## Step 3: Verify the Configuration

After the cluster is deployed, verify that the in-tree **vSphere Cloud Provider** is working.

### 3.1 Check Cloud Provider Status
Run:
```bash
kubectl get nodes -o wide
```
If the **EXTERNAL-IP** column is populated, the vSphere Cloud Provider is managing the cluster.

### 3.2 Verify vSphere Storage Integration
Check if vSphere storage classes are available:
```bash
kubectl get storageclass
```
Example output:
```
NAME                  PROVISIONER             RECLAIMPOLICY
vsphere-standard      kubernetes.io/vsphere-volume   Delete
```

### 3.3 Create a Test Persistent Volume Claim (PVC)
Create a **PersistentVolumeClaim**:
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vsphere-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
  storageClassName: vsphere-standard
```

Apply it:
```bash
kubectl apply -f pvc.yaml
```

Verify the **PersistentVolume**:
```bash
kubectl get pv
```

---

## Step 4: Best Practices & Troubleshooting

### **Best Practices**
✅ **Use vSphere Storage Policies** – Define storage policies for different workloads.  
✅ **Enable vSphere DRS (Distributed Resource Scheduler)** – Improves VM placement.  
✅ **Use vSAN for Kubernetes Storage** – Optimized for containerized workloads.  

### **Common Issues & Fixes**

| Issue | Cause | Solution |
|-------|------|----------|
| No External IP assigned to LoadBalancer Services | vSphere Cloud Provider not running | Check `kubectl logs -n kube-system vsphere-cloud-controller-manager` |
| Persistent Volume Claim stuck in `Pending` | StorageClass misconfigured | Verify `kubectl get storageclass` and `kubectl describe pvc` |
| Nodes not joining cluster | Cloud Provider misconfiguration | Ensure correct vSphere credentials and `server` in config |

---

## Conclusion

The **in-tree VMware vSphere Cloud Provider** enables **seamless integration** between **Kubernetes and vSphere**, allowing:
✅ **Automatic Persistent Volume provisioning**  
✅ **Load balancer creation for Kubernetes services**  
✅ **Node registration and networking configuration**  

**Note:** Since **Kubernetes 1.27+, in-tree vSphere Cloud Provider is deprecated**, it's recommended to **migrate to the out-of-tree vSphere Cloud Controller Manager**.

For further details, check out the [VMware vSphere Cloud Provider Docs](https://docs.vmware.com/en/VMware-vSphere/index.html).

---

*Want more Kubernetes insights? Browse the [RKE2 Training](https://support.tools/categories/rke2-training/) series for expert insights!*
