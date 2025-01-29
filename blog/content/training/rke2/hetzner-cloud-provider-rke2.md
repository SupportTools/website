---
title: "Setting Up Hetzner Cloud Provider for RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "hetzner", "cloud provider", "load balancer", "csi"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "A guide to setting up the Hetzner Cloud Provider for RKE2, including load balancer and CSI storage integration."
url: "/training/rke2/hetzner-cloud-provider-rke2/"
---

## Introduction

The Hetzner Cloud Provider for RKE2 allows seamless integration with Hetzner's cloud infrastructure, enabling automatic provisioning of LoadBalancer services and persistent storage using Hetzner's CSI driver.

This guide covers the necessary steps to set up the Hetzner Cloud Provider in an RKE2 cluster, ensuring full compatibility with Kubernetes networking and storage requirements.

## Prerequisites

Before proceeding, ensure the following prerequisites are met:

- A Hetzner Cloud account with an active project.
- An RKE2 cluster running on Hetzner Cloud instances.
- API Token for Hetzner Cloud.
- Kubernetes CLI (`kubectl`) installed.
- Helm installed on your local machine.

## Step 1: Create an API Token

1. Log in to your Hetzner Cloud account.
2. Navigate to **Access** > **API Tokens**.
3. Click **Generate API Token**.
4. Assign necessary permissions (Read & Write for networking and storage).
5. Copy and securely store the generated API token.

## Step 2: Deploy the Hetzner Cloud Controller Manager (CCM)

1. Add the Hetzner Helm repository:
   ```sh
   helm repo add hetzner https://helm.hetzner.cloud
   helm repo update
   ```
2. Create a `values.yaml` file for the Helm deployment:
   ```yaml
   apiToken: "YOUR_HETZNER_API_TOKEN"
   network: "your-network-id"
   location: "nbg1"
   ```
3. Install the CCM using Helm:
   ```sh
   helm install hcloud-cloud-controller hetzner/hcloud-cloud-controller-manager -n kube-system -f values.yaml
   ```

## Step 3: Configure the Hetzner CSI Driver

1. Install the CSI driver via Helm:
   ```sh
   helm install hcloud-csi hetzner/hcloud-csi-driver -n kube-system
   ```
2. Verify that the driver is running:
   ```sh
   kubectl get pods -n kube-system | grep hcloud
   ```

## Step 4: Deploy a LoadBalancer Service

Create a sample LoadBalancer service:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: hetzner-lb
  annotations:
    load-balancer.hetzner.cloud/location: "nbg1"
    load-balancer.hetzner.cloud/use-private-ip: "true"
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
kubectl apply -f hetzner-lb.yaml
```

## Step 5: Verify Configuration

1. Check if the LoadBalancer is provisioned:
   ```sh
   kubectl get svc hetzner-lb
   ```
2. Test persistent volume provisioning:
   ```sh
   kubectl get storageclass | grep hcloud
   ```
3. Ensure nodes have the correct provider ID:
   ```sh
   kubectl describe nodes | grep "ProviderID"
   ```

## Conclusion

The Hetzner Cloud Provider enables seamless integration with RKE2, automating networking and storage management. By setting up CCM and CSI, you can efficiently deploy LoadBalancer services and use Hetzner's block storage with Kubernetes workloads.

For more Kubernetes and RKE2 training, check out other [training posts](https://support.tools/training/rke2/).