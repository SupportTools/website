---
title: "Provisioning an RKE2 Cluster in DigitalOcean via Rancher"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Downstream RKE2 Cluster", "DigitalOcean", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Downstream RKE2 Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Guide to adding DigitalOcean cloud credentials in Rancher and provisioning an RKE2 cluster in DigitalOcean."
more_link: "yes"
url: "/known-good-designs/downstream-rke2-cluster/rke2-do/"
---

This guide demonstrates how to add DigitalOcean cloud credentials in Rancher and use them to provision an RKE2 cluster in DigitalOcean (DO).

<!--more-->

# [Overview](#overview)

## [DigitalOcean RKE2 Cluster in Rancher](#digitalocean-rke2-cluster-in-rancher)
Rancher simplifies the provisioning of downstream RKE2 clusters in DigitalOcean by integrating with the DigitalOcean API. By adding your DigitalOcean API token to Rancher, you can create a fully managed RKE2 cluster customized to your requirements.

---

# [Adding DigitalOcean Cloud Credentials](#adding-digitalocean-cloud-credentials)

### Prerequisites
- A DigitalOcean account with an active API token.
- Rancher installed and accessible.

### Steps to Add DigitalOcean Cloud Credentials
1. **Log in to Rancher:**
   Access your Rancher installation via its hostname (e.g., `https://rancher.your-domain.com`).

2. **Navigate to Cloud Credentials:**
   - Click on the top-right menu.
   - Select **Cloud Credentials** under **Cluster Management**.

3. **Add DigitalOcean Credentials:**
   - Click **Add Cloud Credential**.
   - Choose **DigitalOcean** as the cloud credential type.
   - Enter the required details:
     - **API Token**: Your DigitalOcean API token.
   - Click **Create**.

---

# [Provisioning the RKE2 Cluster](#provisioning-the-rke2-cluster)

### Steps to Provision an RKE2 Cluster in DigitalOcean
1. **Navigate to Cluster Management:**
   - In the Rancher UI, click on **Cluster Management**.
   - Select **Create** to start the cluster provisioning process.

2. **Select RKE2 and DigitalOcean:**
   - Choose **RKE2/K3s** as the cluster type.
   - Select **DigitalOcean** as the cloud provider.

3. **Configure Cluster Details:**
   - Enter a cluster name (e.g., `rke2-do-cluster`).
   - Select your previously added DigitalOcean cloud credentials.

4. **Node Configuration:**
   - Define the node pool configuration:
     - **Droplet Type**: Choose a droplet size (e.g., `s-4vcpu-8gb` for small clusters).
     - **Node Count**: Set the number of control-plane and worker nodes (e.g., 2 control-plane nodes and 3 worker nodes).
   - Configure additional options as needed (e.g., SSH key pair).

5. **Network Configuration:**
   - Configure the VPC network to use DigitalOcean’s default VPC or create a new one.
   - Enable monitoring and private networking if desired.

6. **Review and Launch:**
   - Review the configuration summary.
   - Click **Create** to start provisioning the cluster.

---

# [Testing and Validation](#testing-and-validation)

### Accessing the Cluster
1. Verify the cluster status in Rancher:
   - Navigate to **Cluster Management** and check the cluster state.
   - The status should show as **Active** once the provisioning is complete.

2. Download the kubeconfig file:
   - Click on the cluster name.
   - Select **Kubeconfig File** to download the configuration for kubectl access.

3. Access the cluster via kubectl:
   ```bash
   kubectl --kubeconfig=/path/to/kubeconfig get nodes
   ```

### Testing Workloads
Deploy a test application to ensure the cluster is functional:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-test
  namespace: default
spec:
  containers:
  - name: nginx
    image: nginx:latest
    ports:
    - containerPort: 80
```
```bash
kubectl apply -f nginx-test.yaml
kubectl get pods
```

---

# [References](#references)
- [Rancher Documentation: Provisioning Clusters](https://rancher.com/docs/rancher/v2.7/en/cluster-provisioning/)
- [DigitalOcean API Documentation](https://docs.digitalocean.com/reference/api/)
- [RKE2 Documentation](https://docs.rke2.io/)

