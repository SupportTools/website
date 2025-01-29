---
title: "Setting Up Alibaba Cloud Provider for RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "alibaba cloud", "cloud controller manager", "csi driver"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "Learn how to set up the Alibaba Cloud provider for RKE2, including Cloud Controller Manager and CSI driver configuration."
url: "/training/rke2/alibaba-cloud-provider-rke2/"
more_link: "/training/rke2/"
---

## Introduction
Alibaba Cloud provides a Kubernetes-compatible cloud provider that integrates with RKE2 to manage cloud resources such as load balancers, networking, and persistent storage. This guide walks you through setting up the **Alibaba Cloud Provider** for RKE2, installing the **Cloud Controller Manager (CCM)**, and configuring the **Alibaba Cloud CSI driver**.

---

## Prerequisites
Before setting up the Alibaba Cloud Provider for RKE2, ensure you have the following:

- An **Alibaba Cloud account** with permissions to create and manage resources.
- A **RAM user** with the necessary IAM policies to interact with ECS and other services.
- An **RKE2 cluster** deployed on Alibaba Cloud ECS instances.
- The **`aliyun` CLI** installed and configured with your Alibaba Cloud credentials.
- A Kubernetes `kubeconfig` file for cluster access.

---

## Step 1: Configure Alibaba Cloud IAM Permissions

Alibaba Cloud's cloud provider requires specific permissions to interact with the API. You need to create a **RAM role** with the following policy:

### Create a RAM Role
1. Log in to the **Alibaba Cloud RAM Console**.
2. Go to **RAM Roles** → **Create Role** → Select **ECS Service**.
3. Attach the following JSON policy:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeInstances",
        "vpc:DescribeVpcs",
        "vpc:DescribeRouteTables",
        "slb:DescribeLoadBalancers",
        "slb:CreateLoadBalancer",
        "slb:DeleteLoadBalancer",
        "slb:ModifyLoadBalancerAttributes"
      ],
      "Resource": "*"
    }
  ]
}
```

4. Bind this **RAM Role** to your **ECS instances**.

---

## Step 2: Deploy Alibaba Cloud Controller Manager

The **Alibaba Cloud Controller Manager (CCM)** is responsible for managing cloud resources such as load balancers and networking.

### Install CCM using Helm
1. **Add the Alibaba Cloud Helm repository:**

   ```bash
   helm repo add aliyun https://acs.aliyun.com/chartrepo/
   helm repo update
   ```

2. **Create a values.yaml file for customization:**

   ```yaml
   cloudConfig:
     accessKeyID: "<your-access-key-id>"
     accessKeySecret: "<your-access-key-secret>"
     region: "<your-region>"
   nodeSelector:
     node-role.kubernetes.io/control-plane: "true"
   tolerations:
     - key: "node-role.kubernetes.io/master"
       effect: "NoSchedule"
   ```

3. **Deploy the CCM using Helm:**

   ```bash
   helm install alibaba-cloud-controller aliyun/alibaba-cloud-controller-manager -f values.yaml -n kube-system
   ```

4. **Verify the installation:**

   ```bash
   kubectl get pods -n kube-system | grep alibaba-cloud-controller
   ```

---

## Step 3: Install the Alibaba Cloud CSI Driver

The **CSI driver** allows Kubernetes to provision and manage persistent volumes on Alibaba Cloud.

### Install the Alibaba Cloud CSI Driver
1. **Create a Secret for Alibaba Cloud credentials:**

   ```bash
   kubectl create secret generic alibaba-cloud-credentials \
     --from-literal=accessKeyID=<your-access-key-id> \
     --from-literal=accessKeySecret=<your-access-key-secret> \
     -n kube-system
   ```

2. **Deploy the CSI driver using Helm:**

   ```bash
   helm install alibaba-cloud-csi aliyun/alibaba-cloud-csi-driver -n kube-system
   ```

3. **Verify the installation:**

   ```bash
   kubectl get pods -n kube-system | grep alibaba-cloud-csi
   ```

---

## Step 4: Validate the Alibaba Cloud Provider Setup

### Check Node Provider ID
Run the following command to confirm that the Alibaba Cloud provider has set the correct **ProviderID**:

```bash
kubectl describe nodes | grep "ProviderID"
```

### Test Load Balancer Creation
Create a sample LoadBalancer service to verify that the CCM is working:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: test-loadbalancer
  annotations:
    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-spec: "slb.s1.small"
spec:
  selector:
    app: test
  type: LoadBalancer
  ports:
    - protocol: TCP
      port: 80
      targetPort: 80
```

Apply the configuration:

```bash
kubectl apply -f test-loadbalancer.yaml
kubectl get svc test-loadbalancer
```

If successful, an **Alibaba Cloud SLB** will be created.

### Test Persistent Volume Creation
Create a PersistentVolumeClaim (PVC) to test Alibaba Cloud storage:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: alibaba-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: alicloud-disk
```

Apply the configuration:

```bash
kubectl apply -f alibaba-pvc.yaml
kubectl get pvc alibaba-pvc
```

If successful, an **Alibaba Cloud Disk** volume will be created and bound.

---

## Conclusion
By following this guide, you have successfully:

✅ Configured **Alibaba Cloud IAM permissions**
✅ Installed the **Alibaba Cloud Controller Manager (CCM)**
✅ Deployed the **Alibaba Cloud CSI driver** for storage
✅ Verified **load balancer and persistent storage** functionality

Your RKE2 cluster is now fully integrated with Alibaba Cloud! 🎉

For more Kubernetes and RKE2 training, check out other [training posts](https://support.tools/training/rke2/).
