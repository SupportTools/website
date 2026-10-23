---
title: "Provisioning an RKE2 Cluster in AWS via Rancher"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
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

## [Overview](#overview)

### [AWS RKE2 Cluster in Rancher](#aws-rke2-cluster-in-rancher)
Rancher makes it easy to provision and manage downstream RKE2 clusters in AWS. By adding your AWS credentials to Rancher, you can create a fully managed RKE2 cluster tailored to your specific needs.

---

## [Adding AWS Cloud Credentials](#adding-aws-cloud-credentials)

### Prerequisites
- An AWS account with sufficient permissions to create resources (e.g., EC2 instances, VPCs, and security groups).
- Rancher installed and accessible.

### Steps to Add AWS Cloud Credentials
1. **Log in to Rancher:**
   Access your Rancher installation via its hostname (e.g., `https://rancher.your-domain.com`).

2. **Navigate to Cloud Credentials:**
   - Open **☰ > Cluster Management**.
   - Click **Cloud Credentials**.

3. **Add AWS Credentials:**
   - Click **Create** and choose **Amazon**.
   - Name the credential and select the default AWS region for your nodes.
   - Enter the required details:
     - **Access Key**: Your AWS access key ID.
     - **Secret Key**: Your AWS secret access key.
   - Click **Create**.

   The IAM user behind the key needs the EC2 permissions shown in Rancher's [Amazon EC2 cluster guide](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/launch-kubernetes-with-rancher/use-new-nodes-in-an-infra-provider/create-an-amazon-ec2-cluster). Add `iam:PassRole` if you use the AWS cloud provider or attach an instance profile, and the KMS permissions if you use encrypted EBS volumes.

---

## [Provisioning the RKE2 Cluster](#provisioning-the-rke2-cluster)

### Steps to Provision an RKE2 Cluster in AWS
1. **Navigate to Cluster Management:**
   - Open **☰ > Cluster Management**.
   - Click **Create** on the Clusters page.

2. **Select RKE2 and AWS:**
   - Set the toggle to **RKE2/K3s**.
   - Click **Amazon EC2**.

3. **Configure Cluster Details:**
   - Enter a cluster name (e.g., `rke2-aws-cluster`).
   - Choose the AWS region where the cluster will be deployed.
   - Select your previously added AWS cloud credentials.

4. **Machine Pool Configuration:**
   Create two machine pools, following Rancher's [recommended cluster architecture](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/checklist-for-production-ready-clusters/recommended-cluster-architecture):

   | Pool | Roles | Count | Example instance type |
   |---|---|---|---|
   | `cp` | etcd, Control Plane | 3 | `m7i.xlarge` (4 vCPU, 16 GiB) |
   | `workers` | Worker | 2 or more | sized for your workloads |

   - Use **3** etcd nodes, not 2. etcd needs a majority of members to stay writable: 2 members tolerate zero failures, 3 members tolerate one.
   - Rancher recommends at least two worker nodes so workloads can be rescheduled after a node failure, and not combining the worker role with etcd or controlplane.
   - The [RKE2 requirements](https://docs.rke2.io/install/requirements) set a minimum of 2 CPUs and 4 GB RAM and recommend 4 CPUs and 8 GB, with SSD storage for etcd. `gp3` EBS volumes meet the SSD guidance. Avoid burstable `t3` instances for etcd nodes in production, because CPU credit exhaustion slows etcd.
   - Pick an AMI for an OS that the [RKE2 v1.36 support matrix](https://www.suse.com/suse-rke2/support-matrix/all-supported-versions/rke2-v1-36/) certifies, such as Ubuntu 24.04, SLES 16.0, RHEL 9.8, or Amazon Linux 2023 (validated as part of RHEL testing).
   - Configure advanced options as needed (SSH user, root disk size, security group, IAM instance profile).

   Spreading the three etcd nodes across three availability zones lets the cluster survive the loss of one zone. With only two zones, you survive only the loss of the zone that does not hold the etcd majority.

5. **Cluster Configuration:**
   - Choose a Kubernetes version that your Rancher release supports. New RKE2 v1.36 clusters use Traefik as the default ingress controller, because the Kubernetes Ingress NGINX project was retired in March 2026 (see [Ingress on RKE2](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/)).
   - Choose the cloud provider. Select **Amazon** if you want the AWS cloud provider to manage load balancers and node metadata; this needs an IAM instance profile on the nodes.
   - In each machine pool, set the VPC and subnet, and use a security group that allows the RKE2 ports between nodes (9345 and 6443 to servers, 10250 between nodes, 2379 to 2381 between etcd nodes, plus your CNI ports) and 443 outbound to Rancher.

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

3. Access the cluster via kubectl and confirm the three etcd and control plane nodes plus your workers are `Ready`:
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
- [Rancher: Creating an Amazon EC2 cluster](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/launch-kubernetes-with-rancher/use-new-nodes-in-an-infra-provider/create-an-amazon-ec2-cluster)
- [Rancher: Recommended cluster architecture](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/checklist-for-production-ready-clusters/recommended-cluster-architecture)
- [AWS EC2 Documentation](https://docs.aws.amazon.com/ec2/index.html)
- [RKE2 Documentation](https://docs.rke2.io/)
