---
title: "Setting Up the Amazon Cloud Provider for RKE2"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "rke2", "aws", "cloud controller manager", "deep dive"]
categories: ["Kubernetes Deep Dive"]
author: "Matthew Mattox"
description: "A step-by-step guide to setting up the Amazon cloud provider in RKE2, including IAM role configuration, ClusterID tagging, and deploying the AWS Cloud Controller Manager."
url: "/training/rke2/aws-cloud-provider-rke2/"
---

## Introduction

Running Kubernetes clusters on **AWS** requires integrating cloud services like **Elastic Load Balancers (ELB)** and **Elastic Block Storage (EBS)** with Kubernetes workloads. To enable this, **Amazon provides a cloud provider integration** that allows RKE2 clusters to **automatically manage cloud resources**.

However, starting with **Kubernetes 1.27**, **in-tree AWS cloud providers have been completely removed**, requiring all clusters to migrate to an **out-of-tree AWS Cloud Controller Manager (CCM)**.

In this guide, we will cover:
- Why you need the Amazon cloud provider in **RKE2**
- Setting up **IAM roles** for your cluster nodes
- Tagging AWS resources with **ClusterID**
- Deploying the **AWS Cloud Controller Manager** (CCM)

---

## Why Use the Amazon Cloud Provider in RKE2?

When you enable the **Amazon cloud provider** in RKE2, Kubernetes gains the ability to:
1. **Provision Load Balancers** – Automatically launch **AWS Elastic Load Balancers (ELB)** for `Service type=LoadBalancer`.
2. **Manage Persistent Volumes** – Use **AWS Elastic Block Store (EBS)** for persistent storage.
3. **Automate Cloud Networking** – Configure routes and security groups for inter-node communication.

Without the cloud provider, these tasks would need to be **manually configured**, reducing automation and scalability.

---

## Step 1: Create an IAM Role and Attach It to Instances

All nodes in your RKE2 cluster must be able to **interact with AWS EC2 APIs** to manage resources dynamically. This requires creating an **IAM role** and attaching it to your instances.

### 1.1 IAM Policy for Control Plane Nodes
Control plane nodes **must be able to create and delete AWS resources**. The following policy is an example—remove any permissions you don't need.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:DescribeTags",
        "ec2:DescribeInstances",
        "ec2:DescribeRegions",
        "ec2:DescribeRouteTables",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeVolumes",
        "ec2:CreateSecurityGroup",
        "ec2:CreateTags",
        "ec2:CreateVolume",
        "ec2:ModifyInstanceAttribute",
        "ec2:ModifyVolume",
        "ec2:AttachVolume",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:CreateRoute",
        "ec2:DeleteRoute",
        "ec2:DeleteSecurityGroup",
        "ec2:DeleteVolume",
        "ec2:DetachVolume",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:DescribeVpcs",
        "elasticloadbalancing:AddTags",
        "elasticloadbalancing:CreateLoadBalancer",
        "elasticloadbalancing:DeleteLoadBalancer",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:RegisterInstancesWithLoadBalancer",
        "iam:CreateServiceLinkedRole",
        "kms:DescribeKey"
      ],
      "Resource": "*"
    }
  ]
}
```

### 1.2 IAM Policy for Worker and Etcd Nodes
Worker nodes **only need read access** to AWS services.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeRegions",
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:GetRepositoryPolicy",
        "ecr:DescribeRepositories",
        "ecr:ListImages",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    }
  ]
}
```

Once you create these policies:
- Attach the **control plane policy** to control plane nodes.
- Attach the **worker policy** to worker and etcd nodes.

---

## Step 2: Configure the ClusterID

The **ClusterID** is required for Kubernetes to identify and manage AWS resources correctly. You must tag the following AWS resources:

| Resource | Tag Format |
|----------|------------|
| Nodes | `kubernetes.io/cluster/<cluster-id> = owned` |
| Subnets | `kubernetes.io/cluster/<cluster-id> = owned` |
| Security Groups | `kubernetes.io/cluster/<cluster-id> = owned` |

### 2.1 Adding ClusterID Tags
Use the AWS CLI to tag your resources:

```bash
aws ec2 create-tags --resources <resource-id> --tags Key=kubernetes.io/cluster/my-cluster,Value=owned
```

📌 **Important:** Do not tag multiple security groups with the same ClusterID—this may cause ELB creation failures.

---

## Step 3: Deploy the AWS Cloud Controller Manager (CCM)

Since **Kubernetes 1.27 removed in-tree AWS cloud providers**, you must now deploy the **out-of-tree AWS Cloud Controller Manager**.

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

### 3.2 Install the AWS CCM Using Helm

Add the Helm repository:
```bash
helm repo add aws-cloud-controller-manager https://kubernetes.github.io/cloud-provider-aws
helm repo update
```

Create a `values.yaml` file:
```yaml
hostNetworking: true
tolerations:
  - effect: NoSchedule
    key: node.cloudprovider.kubernetes.io/uninitialized
    value: 'true'
  - effect: NoSchedule
    key: node-role.kubernetes.io/control-plane
    value: 'true'
nodeSelector:
  node-role.kubernetes.io/control-plane: "true"
args:
  - --configure-cloud-routes=false
  - --cloud-provider=aws
```

Deploy the chart:
```bash
helm upgrade --install aws-cloud-controller-manager \
  aws-cloud-controller-manager/aws-cloud-controller-manager \
  --values values.yaml -n kube-system
```

Verify the installation:
```bash
helm status -n kube-system aws-cloud-controller-manager
kubectl rollout status daemonset -n kube-system aws-cloud-controller-manager
```

---

## Conclusion

Configuring the **Amazon cloud provider** in **RKE2** allows Kubernetes to **fully integrate with AWS**, enabling:
✅ **Automated Load Balancer provisioning**  
✅ **Persistent storage with EBS**  
✅ **Cloud-managed networking and security groups**  

With **Kubernetes 1.27+**, migrating to an **out-of-tree AWS Cloud Controller Manager** is required to maintain full cloud provider functionality.

For further details, check out the [AWS Cloud Provider Docs](https://github.com/kubernetes/cloud-provider-aws).

---

*Want more Kubernetes insights? Browse the [Kubernetes Deep Dive](https://support.tools/categories/kubernetes-deep-dive/) series for more expert insights!*
