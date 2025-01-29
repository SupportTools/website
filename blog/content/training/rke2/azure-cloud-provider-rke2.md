---
title: "Setting Up the Azure Cloud Provider for RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "azure", "cloud controller manager", "deep dive"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "A step-by-step guide to setting up the Azure cloud provider in RKE2, including configuring Azure credentials, setting up the Network Security Group, and deploying the Azure Cloud Controller Manager."
url: "/training/rke2/azure-cloud-provider-rke2/"
---

## Introduction

Kubernetes clusters running on **Azure** require integration with cloud services such as **Azure Load Balancers, Managed Disks, and Azure Files** to function efficiently. **Azure provides a cloud provider integration** that enables RKE2 clusters to automatically provision and manage cloud resources.

However, starting with **Kubernetes 1.30**, **in-tree Azure cloud providers have been removed**, making it mandatory to migrate to an **out-of-tree Azure Cloud Controller Manager (CCM)**.

In this guide, we will cover:
- Why you need the Azure cloud provider in **RKE2**
- Setting up **Azure credentials**
- Configuring **Azure Network Security Groups**
- Deploying the **Azure Cloud Controller Manager (CCM)**
- Installing **Azure CSI Drivers** for Persistent Volumes

---

## Why Use the Azure Cloud Provider in RKE2?

When you enable the **Azure cloud provider** in RKE2, Kubernetes can:
1. **Provision Load Balancers** – Automatically launch **Azure Load Balancers** for `Service type=LoadBalancer`.
2. **Manage Persistent Volumes** – Use **Azure Managed Disks and Blob Storage** for persistent storage.
3. **Automate Network Storage** – Support **Azure Files via CIFS mounts**.

Without this integration, these tasks would have to be **manually configured**, reducing automation and scalability.

---

## Step 1: Set Up Azure Credentials

To integrate RKE2 with Azure, you need to configure **Azure authentication credentials**.

### 1.1 Set Up the Azure Tenant ID
Retrieve your **Azure Tenant ID** from the Azure portal:

- Navigate to **Azure Active Directory** > **Properties**.
- Copy the **Directory ID** (this is your `tenantID`).

Alternatively, use the **Azure CLI**:
```bash
az account show --query tenantId --output tsv
```

### 1.2 Set Up the Azure Client ID and Client Secret
1. Navigate to **Azure Active Directory** > **App Registrations**.
2. Click **New Registration** and provide:
   - **Name**: `RKE2-Cloud-Provider`
   - **Application Type**: `Web app / API`
   - **Sign-on URL**: Any value (not required)
3. Click **Create** and note the **Application (client) ID**.

Next, create a **Client Secret**:
1. Open your **App Registration**.
2. Go to **Certificates & Secrets** > **New Client Secret**.
3. Set an expiration period and click **Save**.
4. Copy the **Client Secret Value** immediately.

### 1.3 Assign Permissions to the App Registration
1. Navigate to **Azure Subscriptions**.
2. Select **Access Control (IAM)** > **Add a Role Assignment**.
3. Choose:
   - **Role**: `Contributor`
   - **Assign to**: `Azure AD App`
   - **App Registration**: `RKE2-Cloud-Provider`
4. Click **Save**.

---

## Step 2: Set Up Azure Network Security Groups

Azure **Network Security Groups (NSG)** control traffic flow in the cluster.

- Create or identify an **NSG** for your cluster.
- Ensure **all nodes** expected to act as **load balancer backends** are assigned to this NSG.

💡 **Note:** If using Rancher’s Azure Machine Driver, you must manually edit the nodes' NSG.

---

## Step 3: Deploy the Azure Cloud Controller Manager (CCM)

Since **Kubernetes 1.30 removed in-tree Azure cloud providers**, you must deploy the **out-of-tree Azure Cloud Controller Manager**.

### 3.1 Enable External Cloud Provider in RKE2
Modify the **RKE2 configuration** to disable the in-tree provider:

#### Control Plane Configuration:
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

#### Worker Configuration:
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

### 3.2 Install the Azure CCM Using Helm

Create a **Kubernetes Secret** to store the Azure Cloud Provider Config:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: azure-cloud-config
  namespace: kube-system
type: Opaque
stringData:
  cloud-config: |-
    {
      "cloud": "AzurePublicCloud",
      "tenantId": "<tenant-id>",
      "subscriptionId": "<subscription-id>",
      "aadClientId": "<client-id>",
      "aadClientSecret": "<client-secret>",
      "resourceGroup": "docker-machine",
      "location": "westus",
      "vnetName": "docker-machine-vnet",
      "subnetName": "docker-machine",
      "securityGroupName": "rancher-managed",
      "useInstanceMetadata": true,
      "loadBalancerSku": "standard"
    }
```
Apply the secret:
```bash
kubectl apply -f azure-cloud-config.yaml
```

Add the **Azure Cloud Controller Manager Helm repo**:
```bash
helm repo add azure-cloud-controller-manager https://raw.githubusercontent.com/kubernetes-sigs/cloud-provider-azure/master/helm/repo
helm repo update
```

Create a `values.yaml` file:
```yaml
infra:
  clusterName: my-cluster
cloudControllerManager:
  cloudConfigSecretName: azure-cloud-config
  enableDynamicReloading: 'true'
  configureCloudRoutes: 'false'
  allocateNodeCidrs: 'false'
  nodeSelector:
    node-role.kubernetes.io/control-plane: 'true'
  tolerations:
    - effect: NoSchedule
      key: node-role.kubernetes.io/control-plane
      value: 'true'
```

Deploy the Helm chart:
```bash
helm upgrade --install cloud-provider-azure azure-cloud-controller-manager/cloud-provider-azure -n kube-system --values values.yaml
```

Verify the deployment:
```bash
helm status cloud-provider-azure -n kube-system
kubectl rollout status deployment -n kube-system cloud-controller-manager
kubectl rollout status daemonset -n kube-system cloud-node-manager
```

---

## Step 4: Install Azure CSI Drivers

Azure now requires **CSI drivers** for persistent volumes. Install the **Azure Disk CSI driver**:

```bash
helm repo add azuredisk-csi-driver https://raw.githubusercontent.com/kubernetes-sigs/azuredisk-csi-driver/master/charts
helm repo update azuredisk-csi-driver

helm install azuredisk-csi-driver azuredisk-csi-driver/azuredisk-csi-driver --namespace kube-system --set controller.cloudConfigSecretName=azure-cloud-config --set controller.cloudConfigSecretNamespace=kube-system
```

Verify installation:
```bash
kubectl get pods -n kube-system | grep azuredisk-csi-driver
```

Create a **StorageClass**:
```yaml
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: standard
provisioner: disk.csi.azure.com
parameters:
  skuName: Standard_LRS
```
Apply it:
```bash
kubectl apply -f storageclass.yaml
```

---

## Conclusion

Configuring the **Azure cloud provider** in **RKE2** allows Kubernetes to **fully integrate with Azure**, enabling:
✅ **Automated Load Balancer provisioning**  
✅ **Persistent storage with Azure Managed Disks**  
✅ **Cloud-managed networking and security groups**  

For further details, check out the [Azure Cloud Provider Docs](https://github.com/kubernetes-sigs/cloud-provider-azure).

---

*Want more Kubernetes insights? Browse the [RKE2 Training](https://support.tools/categories/rke2-training/) series for expert insights!*
