---
title: "Setting Up Oracle Cloud Provider for RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "oracle cloud", "cloud provider", "load balancer", "csi"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "A guide to setting up the Oracle Cloud Provider for RKE2, including load balancer and CSI storage integration."
url: "/training/rke2/oracle-cloud-provider-rke2/"
---

## Introduction

The Oracle Cloud Provider for RKE2 enables seamless integration with Oracle Cloud Infrastructure (OCI), allowing Kubernetes to manage cloud resources such as LoadBalancers and Persistent Volumes. This guide will walk you through setting up the Oracle Cloud Provider for an RKE2 cluster.

## Prerequisites

Before proceeding, ensure you have:
- An Oracle Cloud Infrastructure (OCI) account.
- An RKE2 cluster running on OCI.
- An API key configured for authentication.
- The Oracle Cloud CLI (`oci`) installed.
- `kubectl` and Helm installed.

## Step 1: Generate API Credentials

1. Log in to your Oracle Cloud account.
2. Navigate to **Identity & Security** > **Users**.
3. Click your user and create a new API key.
4. Download the private key and note your **User OCID**, **Tenancy OCID**, and **Region**.

## Step 2: Create a Secret for OCI Configuration

Create a Kubernetes secret to store the OCI configuration:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: oracle-cloud-config
  namespace: kube-system
type: Opaque
stringData:
  cloud-config: |
    [Global]
    tenancy=<your-tenancy-ocid>
    user=<your-user-ocid>
    fingerprint=<your-api-key-fingerprint>
    key_file=/etc/oci/key.pem
    region=<your-region>
    compartment=<your-compartment-ocid>
```
Apply the secret:

```sh
kubectl apply -f oracle-cloud-config.yaml
```

## Step 3: Install the Oracle Cloud Controller Manager

1. Add the Oracle Helm repository:
   ```sh
   helm repo add oracle https://oracle.github.io/oci-cloud-controller-manager/
   helm repo update
   ```
2. Create a `values.yaml` file for configuration:
   ```yaml
   cloudConfigSecretName: "oracle-cloud-config"
   nodeSelector:
     node-role.kubernetes.io/control-plane: "true"
   tolerations:
     - key: "node-role.kubernetes.io/control-plane"
       operator: "Exists"
       effect: "NoSchedule"
   ```
3. Install the Oracle Cloud Controller Manager:
   ```sh
   helm install oci-cloud-controller-manager oracle/oci-cloud-controller-manager -n kube-system -f values.yaml
   ```

## Step 4: Deploy the Oracle CSI Driver

1. Install the CSI driver via Helm:
   ```sh
   helm install oci-csi-driver oracle/oci-csi-driver -n kube-system
   ```
2. Verify the driver is running:
   ```sh
   kubectl get pods -n kube-system | grep oci-csi
   ```

## Step 5: Configure LoadBalancer Services

Create a sample LoadBalancer service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: oracle-lb
  annotations:
    service.beta.kubernetes.io/oci-load-balancer-shape: "100Mbps"
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
kubectl apply -f oracle-lb.yaml
```

## Step 6: Verify Configuration

1. Check if the LoadBalancer is provisioned:
   ```sh
   kubectl get svc oracle-lb
   ```
2. Test persistent volume provisioning:
   ```sh
   kubectl get storageclass | grep oci
   ```
3. Ensure nodes have the correct provider ID:
   ```sh
   kubectl describe nodes | grep "ProviderID"
   ```

## Conclusion

By setting up the Oracle Cloud Provider for RKE2, you enable seamless networking and storage management within your Kubernetes cluster. The integration with OCI provides robust scalability and security, allowing for efficient management of LoadBalancer services and persistent storage.

For further details, visit the [Oracle Cloud Controller Manager Documentation](https://oracle.github.io/oci-cloud-controller-manager/).

For more Kubernetes and RKE2 training, check out other [training posts](https://support.tools/training/rke2/).