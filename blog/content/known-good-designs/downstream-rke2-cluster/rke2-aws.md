---
title: "Provisioning an RKE2 Cluster in AWS via Rancher"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Downstream RKE2 Cluster", "AWS", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Downstream RKE2 Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Guide to adding AWS cloud credentials in Rancher and provisioning an RKE2 cluster in AWS."
more_link: "yes"
url: "/known-good-designs/downstream-rke2-cluster/rke2-aws/"
---

This guide demonstrates how to add AWS cloud credentials in Rancher and use them to provision an RKE2 cluster in AWS.

<!--more-->

# [Overview](#overview)

## [AWS RKE2 Cluster in Rancher](#aws-rke2-cluster-in-rancher)
Rancher makes it easy to provision and manage downstream RKE2 clusters in AWS. By adding your AWS credentials to Rancher, you can create a fully managed RKE2 cluster tailored to your specific needs.

---

# [Adding AWS Cloud Credentials](#adding-aws-cloud-credentials)

### Prerequisites
- An AWS account with sufficient permissions to create resources (e.g., EC2 instances, VPCs, and security groups).
- Rancher installed and accessible.

### Steps to Add AWS Cloud Credentials
1. **Log in to Rancher:**
   Access your Rancher installation via its hostname (e.g., `https://rancher.your-domain.com`).

2. **Navigate to Cloud Credentials:**
   - Click on the top-right menu.
   - Select **Cloud Credentials** under **Cluster Management**.

3. **Add AWS Credentials:**
   - Click **Add Cloud Credential**.
   - Choose **Amazon EC2** as the cloud credential type.
   - Enter the required details:
     - **Access Key**: Your AWS access key ID.
     - **Secret Key**: Your AWS secret access key.
   - Click **Create**.

---

# [Provisioning the RKE2 Cluster](#provisioning-the-rke2-cluster)

### Steps to Provision an RKE2 Cluster in AWS
1. **Navigate to Cluster Management:**
   - In the Rancher UI, click on **Cluster Management**.
   - Select **Create** to start the cluster provisioning process.

2. **Select RKE2 and AWS:**
   - Choose **RKE2/K3s** as the cluster type.
   - Select **Amazon EC2** as the cloud provider.

3. **Configure Cluster Details:**
   - Enter a cluster name (e.g., `rke2-aws-cluster`).
   - Choose the AWS region where the cluster will be deployed.
   - Select your previously added AWS cloud credentials.

4. **Node Configuration:**
   - Define the node pool configuration:
     - **Instance Type**: Choose an instance type (e.g., `t3.medium` for small clusters).
     - **Node Count**: Set the number of control-plane and worker nodes (e.g., 2 control-plane nodes and 3 worker nodes).
   - Configure advanced options as needed (e.g., SSH key pair, disk size).

5. **Network Configuration:**
   - Specify the VPC and subnets or allow Rancher to create a new VPC.
   - Configure security group rules to allow cluster communication.

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
- [AWS EC2 Documentation](https://docs.aws.amazon.com/ec2/index.html)
- [RKE2 Documentation](https://docs.rke2.io/)
