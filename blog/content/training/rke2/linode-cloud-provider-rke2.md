---
title: "Setting Up IBM Cloud Provider for RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "ibm cloud", "cloud provider", "load balancer", "csi"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "A guide to setting up the IBM Cloud Provider for RKE2, including load balancer and CSI storage integration."
url: "/training/rke2/ibm-cloud-provider-rke2/"
---

## Introduction

The IBM Cloud Provider for RKE2 enables seamless integration between Kubernetes clusters and IBM Cloud infrastructure. This setup allows automatic provisioning of LoadBalancer services and persistent storage using IBM Cloud's CSI driver.

This guide provides step-by-step instructions to set up the IBM Cloud Provider in an RKE2 cluster.

## Prerequisites

Ensure the following requirements are met before proceeding:

- An IBM Cloud account with an active project.
- An RKE2 cluster deployed on IBM Cloud Virtual Servers.
- IBM Cloud API key.
- Kubernetes CLI (`kubectl`) installed.
- Helm installed on your local machine.

## Step 1: Create an IBM Cloud API Key

1. Log in to the [IBM Cloud Console](https://cloud.ibm.com/).
2. Navigate to **Manage** > **Access (IAM)**.
3. Click **API Keys** and then **Create API Key**.
4. Assign the necessary permissions.
5. Download and securely store the API key.

## Step 2: Deploy the IBM Cloud Controller Manager (CCM)

1. Add the IBM Helm repository:
   ```sh
   helm repo add ibm https://icr.io/helm/charts
   helm repo update
   ```
2. Create a `values.yaml` file for the Helm deployment:
   ```yaml
   ibmCloud:
     apiKey: "YOUR_IBM_CLOUD_API_KEY"
     clusterID: "YOUR_CLUSTER_ID"
     region: "us-south"
   ```
3. Install the CCM using Helm:
   ```sh
   helm install ibm-cloud-controller ibm/ibm-cloud-controller-manager -n kube-system -f values.yaml
   ```

## Step 3: Install the IBM Cloud CSI Driver

1. Install the CSI driver via Helm:
   ```sh
   helm install ibm-csi ibm/ibm-cloud-block-storage-plugin -n kube-system
   ```
2. Verify that the driver is running:
   ```sh
   kubectl get pods -n kube-system | grep ibm
   ```

## Step 4: Deploy a LoadBalancer Service

Create a sample LoadBalancer service:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: ibm-lb
  annotations:
    service.kubernetes.io/ibm-load-balancer-cloud: "true"
spec:
  type: LoadBalancer
  selector:
    app: nginx
  ports:
    - protocol: TCP
      port: 80
      targetPort: 80
```
Apply the service:
```sh
kubectl apply -f ibm-lb.yaml
```

## Step 5: Verify Configuration

1. Check if the LoadBalancer is provisioned:
   ```sh
   kubectl get svc ibm-lb
   ```
2. Test persistent volume provisioning:
   ```sh
   kubectl get storageclass | grep ibm
   ```
3. Ensure nodes have the correct provider ID:
   ```sh
   kubectl describe nodes | grep "ProviderID"
   ```

## Conclusion

The IBM Cloud Provider for RKE2 enables seamless Kubernetes cluster management by integrating with IBM Cloud infrastructure. By setting up the CCM and CSI, you can efficiently deploy LoadBalancer services and use IBM's cloud storage with Kubernetes workloads.

For further details, refer to the [IBM Cloud Kubernetes Documentation](https://cloud.ibm.com/docs/containers).

For more Kubernetes and RKE2 training, check out other [training posts](https://support.tools/training/rke2/).