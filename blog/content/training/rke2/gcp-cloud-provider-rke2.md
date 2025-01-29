---
title: "Setting Up the Google Compute Engine Cloud Provider for RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "gce", "google cloud", "cloud controller manager", "deep dive"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "A step-by-step guide to setting up the Google Compute Engine cloud provider in RKE2, including configuring service accounts, setting up networking, and deploying the GCE Cloud Controller Manager."
url: "/training/rke2/gcp-cloud-provider-rke2/"
---

## Introduction

When running **RKE2** on **Google Compute Engine (GCE)**, Kubernetes requires cloud provider integration to:
- **Automatically provision Load Balancers**
- **Manage persistent storage**
- **Configure network routes between nodes**

The **GCE Cloud Provider** enables this integration, allowing Kubernetes to manage GCE resources efficiently. This guide covers:
✅ **Why the GCE cloud provider is needed**  
✅ **Configuring a Google Cloud service account**  
✅ **Setting up networking for RKE2**  
✅ **Deploying the GCE Cloud Controller Manager**  

---

## Why Use the GCE Cloud Provider in RKE2?

When you enable the **Google Compute Engine (GCE) cloud provider** in RKE2, Kubernetes gains:
1. **Load Balancer Integration** – Automatically provisions GCP Load Balancers for `Service type=LoadBalancer`.
2. **Storage Management** – Supports **Google Persistent Disks (PD)** for persistent storage.
3. **Automated Network Routing** – Configures node-to-node networking in GCE.

Without this integration, Kubernetes cannot manage GCP infrastructure **automatically**.

---

## Step 1: Create a Service Account with Compute Admin Permissions

### 1.1 Create a GCP Service Account
1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Navigate to **IAM & Admin** > **Service Accounts**.
3. Click **Create Service Account** and provide:
   - **Name**: `rke2-gce-cloud-provider`
   - **Description**: `Service account for RKE2 GCE Cloud Provider`
4. Click **Create & Continue**.

### 1.2 Assign Required IAM Permissions
Assign the **Compute Admin** role:
- **Role**: `roles/compute.admin`
- **Scope**: Apply to the entire project.

📌 **Why Compute Admin?**  
This permission allows Kubernetes to manage instances, disks, networks, and load balancers in GCE.

### 1.3 Generate and Download a JSON Key
1. Open the **Service Account** you just created.
2. Navigate to **Keys** > **Add Key** > **Create New Key**.
3. Choose **JSON** format and **Download** the key file.

Save this file securely as it will be used in **RKE2 cluster configuration**.

---

## Step 2: Configure the RKE2 Cluster to Use GCE

### 2.1 Modify the Cluster Configuration
To enable the GCE cloud provider, you must **modify the RKE2 cluster configuration**.

#### **For Clusters Using Calico**
Edit your cluster YAML and add:
```yaml
rancher_kubernetes_engine_config:
  cloud_provider:
    name: gce
    customCloudProvider: |-
      [Global]
      project-id=<your-project-id>
      network-name=<your-network-name>
      subnetwork-name=<your-subnet-name>
      node-instance-prefix=<your-instance-group-name>
      node-tags=<your-network-tags>
  network:
    options:
      calico_cloud_provider: "gce"
    plugin: "calico"
```

📌 **Notes:**
- Replace `<your-project-id>` with your **GCP Project ID**.
- If using the **default network**, `network-name` and `subnetwork-name` are **optional**.
- `node-instance-prefix` is **required** and should match your **instance group name**.
- `node-tags` should include **at least one valid network tag**.

#### **For Clusters Using Canal or Flannel**
```yaml
rancher_kubernetes_engine_config:
  cloud_provider:
    name: gce
    customCloudProvider: |-
      [Global]
      project-id=<your-project-id>
      network-name=<your-network-name>
      subnetwork-name=<your-subnet-name>
      node-instance-prefix=<your-instance-group-name>
      node-tags=<your-network-tags>
  services:
    kube_controller:
      extra_args:
        configure-cloud-routes: true
```

📌 **Additional Notes:**
- `configure-cloud-routes: true` ensures that **GCE routes** are set up automatically.

---

## Step 3: Deploy the GCE Cloud Controller Manager (CCM)

Starting with **Kubernetes 1.27**, the **in-tree GCE provider has been deprecated**, so you must use the **out-of-tree Cloud Controller Manager**.

### 3.1 Create a Kubernetes Secret for GCP Credentials
Create a Kubernetes **Secret** to store the GCP service account JSON:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gce-cloud-config
  namespace: kube-system
type: Opaque
stringData:
  cloud-config: |-
    {
      "type": "service_account",
      "project_id": "<your-project-id>",
      "private_key_id": "<your-private-key-id>",
      "private_key": "<your-private-key>",
      "client_email": "<your-client-email>",
      "client_id": "<your-client-id>",
      "auth_uri": "https://accounts.google.com/o/oauth2/auth",
      "token_uri": "https://oauth2.googleapis.com/token",
      "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
      "client_x509_cert_url": "<your-client-cert-url>"
    }
```

Apply the secret:
```bash
kubectl apply -f gce-cloud-config.yaml
```

### 3.2 Install the GCE Cloud Controller Manager Using Helm

Add the Helm repository:
```bash
helm repo add gce-cloud-controller-manager https://kubernetes.github.io/cloud-provider-gcp
helm repo update
```

Create a `values.yaml` file:
```yaml
cloudConfigSecretName: gce-cloud-config
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
helm upgrade --install cloud-provider-gcp \
  gce-cloud-controller-manager/cloud-provider-gcp \
  --values values.yaml -n kube-system
```

### 3.3 Verify the Installation

Check the Helm deployment:
```bash
helm status cloud-provider-gcp -n kube-system
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

## Conclusion

Setting up the **Google Compute Engine (GCE) cloud provider** in RKE2 enables seamless integration with Google Cloud services, including:
✅ **Automated Load Balancer provisioning**  
✅ **Persistent storage with Google Persistent Disks**  
✅ **Automatic network route configuration**  

With **Kubernetes 1.27+, migration to the out-of-tree GCE Cloud Controller Manager is required** to maintain full cloud functionality.

For further details, check out the [GCE Cloud Provider Docs](https://kubernetes.io/docs/concepts/cloud-providers/).

---

*Want more Kubernetes insights? Browse the [RKE2 Training](https://support.tools/categories/rke2-training/) series for expert insights!*
```