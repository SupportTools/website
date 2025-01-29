---
title: "Setting Up Equinix Metal Cloud Provider for RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "equinix metal", "cloud provider", "load balancer", "persistent storage"]
categories: ["RKE2"]
author: "Matthew Mattox"
description: "Learn how to configure the Equinix Metal Cloud Provider for RKE2, including enabling the out-of-tree cloud provider, setting up load balancers, and persistent storage."
url: "/training/rke2/equinix-metal-cloud-provider-rke2/"
more_link: "/categories/rke2/"
---

## Introduction
Equinix Metal (formerly Packet) provides bare-metal cloud infrastructure for running Kubernetes. RKE2 supports Equinix Metal as an **out-of-tree** cloud provider, enabling integration with MetalLB for LoadBalancer services and CSI drivers for persistent storage.

This guide walks you through setting up the Equinix Metal Cloud Provider in RKE2.

---

## Prerequisites
- **An active Equinix Metal account**
- **A running RKE2 cluster** deployed on Equinix Metal
- **Equinix Metal API Key** for authentication
- **kubectl configured** to interact with your cluster
- **Helm installed** for deploying the cloud provider

---

## Step 1: Generate Equinix Metal API Key
1. Log in to the Equinix Metal Console.
2. Navigate to **API Keys**.
3. Generate a **read-write API key** for Kubernetes integration.
4. Store this key securely, as it will be required for configuring the cloud provider.

---

## Step 2: Configure the Cloud Provider
The Equinix Metal Cloud Provider requires a configuration file (`cloud-provider-config`) to be stored as a Kubernetes Secret.

### 1. Create the Equinix Metal Cloud Provider Config File
Create a file named `metal-cloud-config.yaml` with the following contents:

```yaml
[global]
api-key = "YOUR_EQUINIX_METAL_API_KEY"
project-id = "YOUR_PROJECT_ID"
```

Replace `YOUR_EQUINIX_METAL_API_KEY` and `YOUR_PROJECT_ID` with the appropriate values.

### 2. Create a Kubernetes Secret
Store the cloud provider configuration as a Kubernetes Secret:

```bash
kubectl create secret generic cloud-provider-config \
  --from-file=cloud-provider-config=metal-cloud-config.yaml \
  -n kube-system
```

---

## Step 3: Deploy the Equinix Metal Cloud Controller Manager
The **Cloud Controller Manager (CCM)** allows Kubernetes to communicate with Equinix Metal’s APIs for managing node lifecycles, network routes, and load balancers.

1. **Add the Helm Repository:**

```bash
helm repo add equinix-metal https://helm.equinix.com/
helm repo update
```

2. **Install the Cloud Controller Manager:**

```bash
helm install equinix-metal-cloud-controller-manager equinix-metal/equinix-metal-cloud-controller-manager \
  --namespace kube-system \
  --set providerConfigSecretName=cloud-provider-config
```

3. **Verify Deployment:**

```bash
kubectl get pods -n kube-system | grep cloud-controller-manager
```

Ensure that the `equinix-metal-cloud-controller-manager` pod is running.

---

## Step 4: Configure Load Balancers
Equinix Metal does not provide a native load balancer service, so **MetalLB** must be installed to support Kubernetes LoadBalancer Services.

1. **Install MetalLB:**

```bash
helm install metallb metallb/metallb \
  --namespace kube-system \
  --create-namespace
```

2. **Configure IP Address Pool:**
Create a file `metallb-config.yaml`:

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: default-pool
  namespace: kube-system
spec:
  addresses:
  - 147.75.XX.XX/32 # Replace with an available IP
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: default-advertisement
  namespace: kube-system
```

Apply the configuration:

```bash
kubectl apply -f metallb-config.yaml
```

3. **Verify MetalLB is Running:**

```bash
kubectl get pods -n kube-system | grep metallb
```

4. **Test Load Balancer Functionality:**
Create a sample LoadBalancer Service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: test-loadbalancer
spec:
  selector:
    app: my-app
  ports:
    - protocol: TCP
      port: 80
      targetPort: 80
  type: LoadBalancer
```

Apply the service and check its external IP:

```bash
kubectl apply -f test-loadbalancer.yaml
kubectl get svc test-loadbalancer
```

---

## Step 5: Configure Persistent Storage with CSI Driver
To use **persistent volumes**, install the Equinix Metal CSI Driver.

1. **Install the Helm Chart:**

```bash
helm install equinix-metal-csi equinix-metal/equinix-metal-csi \
  --namespace kube-system \
  --set providerConfigSecretName=cloud-provider-config
```

2. **Verify Installation:**

```bash
kubectl get pods -n kube-system | grep equinix-metal-csi
```

3. **Create a Storage Class:**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: equinix-metal-sc
provisioner: csi.equinix.com
parameters:
  csi.storage.k8s.io/fstype: ext4
```

Apply the storage class:

```bash
kubectl apply -f storage-class.yaml
```

4. **Create a Persistent Volume Claim:**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: equinix-metal-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: equinix-metal-sc
```

Apply the PVC and verify the volume is provisioned:

```bash
kubectl apply -f persistent-volume-claim.yaml
kubectl get pvc equinix-metal-pvc
```

---

## Conclusion
The **Equinix Metal Cloud Provider** enables Kubernetes clusters to integrate with Equinix Metal's infrastructure, providing load balancers through MetalLB and persistent storage via CSI drivers. By following this guide, your RKE2 cluster is now fully equipped with cloud provider functionality on Equinix Metal.

For further customization and advanced configurations, refer to the [Equinix Metal Kubernetes Documentation](https://metal.equinix.com/).

For more RKE2 training, check out other [training posts](https://support.tools/training/rke2/). 
