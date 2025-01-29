---
title: "Setting Up the Out-of-Tree VMware vSphere Cloud Provider in RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "vsphere", "cloud provider", "cpi", "csi"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "A guide to setting up the out-of-tree VMware vSphere Cloud Provider in RKE2, including the Cloud Provider Interface (CPI) and Cloud Storage Interface (CSI)."
url: "/training/rke2/vsphere-out-of-tree-cloud-provider-rke2/"
---

## Introduction

As **Kubernetes moves away from in-tree cloud providers**, VMware vSphere now provides an **out-of-tree Cloud Provider Interface (CPI)** and **Cloud Storage Interface (CSI)** for integrating vSphere resources with Kubernetes.

The **out-of-tree vSphere Cloud Provider** enables:
✅ **Dynamic Persistent Volume provisioning** using vSphere storage.  
✅ **Automated Load Balancer creation** for Kubernetes services.  
✅ **Better maintainability** with independent plugin updates.

This guide walks through the **installation and configuration** of the **vSphere CPI and CSI** in RKE2.

---

## Prerequisites

Before setting up the **vSphere out-of-tree cloud provider**, ensure:

✅ **Supported vSphere Versions**:  
   - vSphere **6.7u3**  
   - vSphere **7.0u1 or higher**  

✅ **Supported Kubernetes Versions**:  
   - Kubernetes **1.19+**

✅ **Linux Nodes Only**:  
   - vSphere CPI and CSI **do not support Windows nodes**.

---

## Step 1: Create a VMware vSphere Cluster

### **1.1 Create the RKE2 Cluster**
1. Navigate to **☰ > Cluster Management** in Rancher.
2. Click **Create Cluster**.
3. Select **VMware vSphere** or **Custom**.
4. In the **Cluster Configuration**, set **Cloud Provider** to `vSphere`.
5. In the **Add-On Config** tab, enable:
   - **vSphere Cloud Provider (CPI)**
   - **vSphere Cloud Storage Provider (CSI)** (optional)
6. Complete the cluster creation process.

---

## Step 2: Install the vSphere Cloud Provider Interface (CPI)

The **CPI plugin** is required to initialize **Kubernetes nodes with vSphere ProviderID**, which is necessary for CSI to function correctly.

### **2.1 Install the vSphere CPI Plugin**
1. Go to **☰ > Cluster Management**.
2. Select your **RKE2 cluster** and click **Explore**.
3. Navigate to **Apps > Charts**.
4. Find and click **vSphere CPI**.
5. Fill out the required **vCenter details**:
   - **vSphere Server**
   - **Username**
   - **Password**
   - **Datacenter**
   - **Cluster Name**
6. Click **Install**.

### **2.2 Verify CPI Installation**
Check that all nodes have been initialized with a **ProviderID**:

```bash
kubectl describe nodes | grep "ProviderID"
```

If the ProviderID is **missing**, troubleshoot the CPI installation by checking logs:

```bash
kubectl logs -n kube-system deployment/vsphere-cloud-controller-manager
```

---

## Step 3: Install the vSphere Cloud Storage Interface (CSI)

The **CSI plugin** enables **Persistent Volume provisioning** and storage management in RKE2.

### **3.1 Install the vSphere CSI Plugin**
1. Go to **☰ > Cluster Management**.
2. Select your **RKE2 cluster** and click **Explore**.
3. Navigate to **Apps > Charts**.
4. Find and click **vSphere CSI**.
5. Click **Install**.
6. Fill out the **vCenter connection details**.
7. On the **Features tab**, set:
   - **Enable CSI Migration** to `false`.
8. On the **Storage tab**, configure:
   - **StorageClass** with `csi.vsphere.vmware.com` as the provisioner.
9. Click **Install**.

---

## Step 4: Using the CSI Driver for Volume Provisioning

### **4.1 Verify CSI Storage Class**
Check if the **CSI StorageClass** was created automatically:

```bash
kubectl get storageclass
```

Expected output:
```
NAME                  PROVISIONER                     RECLAIMPOLICY
vsphere-csi-standard  csi.vsphere.vmware.com         Delete
```

### **4.2 Create a Persistent Volume Claim (PVC)**
If the StorageClass wasn’t created automatically, define it manually:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: vsphere-csi-standard
provisioner: csi.vsphere.vmware.com
parameters:
  storagepolicyname: "vSAN Default Storage Policy"
```

Apply the **StorageClass**:

```bash
kubectl apply -f storageclass.yaml
```

### **4.3 Deploy a PVC and Pod**
Create a PersistentVolumeClaim using the **vSphere CSI StorageClass**:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vsphere-csi-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: vsphere-csi-standard
```

Apply it:

```bash
kubectl apply -f pvc.yaml
```

Once the PVC is bound, create a **test Pod** to use the volume:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: vsphere-test-pod
spec:
  containers:
    - name: test-container
      image: busybox
      command: ["sleep", "3600"]
      volumeMounts:
        - mountPath: "/data"
          name: vsphere-storage
  volumes:
    - name: vsphere-storage
      persistentVolumeClaim:
        claimName: vsphere-csi-pvc
```

Apply the Pod:

```bash
kubectl apply -f pod.yaml
```

Verify the **Persistent Volume**:

```bash
kubectl get pv
kubectl get pvc
```

---

## Step 5: Best Practices & Troubleshooting

### **Best Practices**
✅ **Use vSphere Storage Policies** – Assign storage policies to dynamically provisioned Persistent Volumes.  
✅ **Enable vSphere HA (High Availability)** – Ensures storage and networking reliability.  
✅ **Monitor CSI Driver Logs** – Use `kubectl logs -n kube-system vsphere-csi-controller` for debugging.  

### **Common Issues & Fixes**

| Issue | Cause | Solution |
|-------|------|----------|
| No ProviderID in nodes | CPI not running or misconfigured | Check `kubectl logs -n kube-system vsphere-cloud-controller-manager` |
| PVC stuck in `Pending` | CSI misconfiguration | Ensure StorageClass is using `csi.vsphere.vmware.com` |
| Nodes not appearing in vSphere | CPI not initializing nodes | Verify `kubectl describe nodes | grep ProviderID` |

---

## Conclusion

The **out-of-tree VMware vSphere Cloud Provider** enables **modern Kubernetes storage and networking** on vSphere. Using **CPI and CSI**, RKE2 can:
✅ **Automatically provision Persistent Volumes (vSAN, VMFS, NFS)**  
✅ **Attach VM disks dynamically** to workloads  
✅ **Improve cluster maintainability and upgrade flexibility**  

💡 **Recommendation**: If you’re still using the **in-tree vSphere Cloud Provider**, consider **migrating to the out-of-tree provider** for future-proofing.

For more details, check the [vSphere Cloud Provider Docs](https://vmware.github.io/cloud-provider-vsphere/).

---

*Want more Kubernetes insights? Explore the [RKE2 Training](https://support.tools/categories/rke2-training/) series!*
