---
title: "Provisioning an RKE2 Cluster in DigitalOcean via Rancher"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
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

## [Overview](#overview)

### [DigitalOcean RKE2 Cluster in Rancher](#digitalocean-rke2-cluster-in-rancher)
Rancher simplifies the provisioning of downstream RKE2 clusters in DigitalOcean by integrating with the DigitalOcean API. By adding your DigitalOcean API token to Rancher, you can create a fully managed RKE2 cluster customized to your requirements.

---

## [Adding DigitalOcean Cloud Credentials](#adding-digitalocean-cloud-credentials)

### Prerequisites
- A DigitalOcean account with an active API token.
- Rancher installed and accessible.

### Steps to Add DigitalOcean Cloud Credentials
1. **Log in to Rancher:**
   Access your Rancher installation via its hostname (e.g., `https://rancher.your-domain.com`).

2. **Navigate to Cloud Credentials:**
   - Open **☰ > Cluster Management**.
   - Click **Cloud Credentials**.

3. **Add DigitalOcean Credentials:**
   - Click **Create**.
   - Choose **DigitalOcean** as the cloud credential type.
   - Enter the required details:
     - **API Token**: Your DigitalOcean API token.
   - Click **Create**.

---

## [Provisioning the RKE2 Cluster](#provisioning-the-rke2-cluster)

### Steps to Provision an RKE2 Cluster in DigitalOcean
1. **Navigate to Cluster Management:**
   - Open **☰ > Cluster Management**.
   - Click **Create** on the Clusters page.

2. **Select RKE2 and DigitalOcean:**
   - Set the toggle to **RKE2/K3s**.
   - Click **DigitalOcean**.

3. **Configure Cluster Details:**
   - Enter a cluster name (e.g., `rke2-do-cluster`).
   - Select your previously added DigitalOcean cloud credentials.

4. **Machine Pool Configuration:**
   Create two machine pools, following Rancher's [recommended cluster architecture](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/checklist-for-production-ready-clusters/recommended-cluster-architecture):

   | Pool | Roles | Count | Example Droplet size |
   |---|---|---|---|
   | `cp` | etcd, Control Plane | 3 | `s-4vcpu-8gb` |
   | `workers` | Worker | 2 or more | sized for your workloads |

   - Use **3** etcd nodes, not 2. With 2 etcd members a single failure loses quorum; 3 members tolerate one failure.
   - Rancher recommends at least two worker nodes and not combining the worker role with etcd or controlplane.
   - `s-4vcpu-8gb` matches the 4 CPU and 8 GB recommendation in the [RKE2 requirements](https://docs.rke2.io/install/requirements). Droplets use SSD storage, which etcd needs.
   - Pick an image for an OS that the [RKE2 v1.36 support matrix](https://www.suse.com/suse-rke2/support-matrix/all-supported-versions/rke2-v1-36/) certifies, such as Ubuntu 24.04 or 22.04.
   - Configure additional options as needed (SSH user, tags, monitoring).

5. **Cluster and Network Configuration:**
   - Choose a Kubernetes version that your Rancher release supports. New RKE2 v1.36 clusters use Traefik as the default ingress controller, because the Kubernetes Ingress NGINX project was retired in March 2026 (see [Ingress on RKE2](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/)).
   - Place the Droplets in a VPC so node traffic stays on the private network, and use a Cloud Firewall that allows the RKE2 ports between nodes and 443 outbound to Rancher.

6. **Review and Launch:**
   - Review the configuration summary.
   - Click **Create** to start provisioning the cluster.

---

## [Testing and Validation](#testing-and-validation)

### Accessing the Cluster
1. Verify the cluster status in Rancher:
   - Navigate to **Cluster Management** and check the cluster state.
   - The status should show as **Active** once the provisioning is complete.

2. Download the kubeconfig file:
   - Open the cluster from the Rancher home page.
   - Use **Download KubeConfig** in the cluster view, or open the built-in **kubectl Shell**.

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
    image: nginx:stable
    ports:
    - containerPort: 80
```
```bash
kubectl apply -f nginx-test.yaml
kubectl get pods
```

---

## [References](#references)
- [Rancher: Creating a DigitalOcean cluster](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/launch-kubernetes-with-rancher/use-new-nodes-in-an-infra-provider/create-a-digitalocean-cluster)
- [Rancher: Recommended cluster architecture](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/checklist-for-production-ready-clusters/recommended-cluster-architecture)
- [DigitalOcean API Documentation](https://docs.digitalocean.com/reference/api/)
- [RKE2 Documentation](https://docs.rke2.io/)

