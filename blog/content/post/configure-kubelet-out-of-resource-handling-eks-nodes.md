---
title: "Configure Kubelet Out of Resource Handling, or How to Stop EKS Kubernetes Nodes from Going Down"  
date: 2024-09-15T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "EKS", "Kubelet", "Resource Management", "Terraform"]  
categories:  
- Kubernetes  
- EKS  
- Cloud  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to configure Kubelet out-of-resource handling for EKS worker nodes to prevent node failures and resource starvation issues."  
more_link: "yes"  
url: "/configure-kubelet-out-of-resource-handling-eks-nodes/"  
---

Managing resources effectively in Kubernetes is essential to avoid node crashes and resource starvation issues, especially in cloud environments like AWS EKS. Kubelet provides out-of-resource management capabilities that allow you to define eviction thresholds and reserve resources for system daemons, ensuring your EKS worker nodes remain operational.

In this post, we’ll explore how to configure Kubelet’s out-of-resource handling for EKS worker nodes using Amazon’s EKS-optimized AMI and Terraform.

<!--more-->

### EKS Worker Nodes and the Bootstrap Script

EKS worker nodes use the Amazon Linux 2 EKS-optimized AMI, which comes pre-packaged with the `/etc/eks/bootstrap.sh` script. This script is responsible for registering the worker nodes with the EKS cluster.

To get the latest AMI ID for EKS worker nodes using Terraform, you can use the following code:

```hcl
data "aws_ssm_parameter" "worker_ami" {
  name = "/aws/service/eks/optimized-ami/${var.eks_version}/amazon-linux-2/recommended/image_id"
}
```

This retrieves the AMI ID and simplifies the deployment process by ensuring your worker nodes use the latest Amazon-recommended image.

### Resource Management in Kubernetes

In a Kubernetes environment, both system daemons and Kubernetes pods compete for resources, which can lead to resource starvation if not managed properly. This issue is particularly prevalent in EKS worker nodes unless resources are set aside for system daemons.

#### Kube-Reserved

The `kube-reserved` parameter reserves resources specifically for Kubernetes system daemons like the `kubelet`. Setting aside memory and ephemeral storage for these daemons prevents resource contention with the pods.

For EKS worker nodes, you can set the following reservations:

```plaintext
--kube-reserved memory=0.3Gi
--kube-reserved ephemeral-storage=1Gi
```

#### System-Reserved

The `system-reserved` parameter reserves resources for OS-level system daemons such as `udev`. By allocating memory and ephemeral storage for these system services, you ensure that Kubernetes pods don’t cause system daemons to fail.

For EKS worker nodes, use the following:

```plaintext
--system-reserved memory=0.3Gi
--system-reserved ephemeral-storage=1Gi
```

### Eviction Thresholds

Kubelet’s out-of-resource management features are vital in preventing nodes from running out of critical resources. You can set eviction thresholds to trigger when memory or ephemeral storage falls below a specified level, allowing Kubelet to reclaim resources by evicting pods before the system becomes unstable.

For memory and ephemeral storage, you can configure the following eviction thresholds:

```plaintext
--eviction-hard memory.available<200Mi
--eviction-hard nodefs.available<10%
```

These settings will ensure that once memory drops below 200Mi or disk space falls below 10%, Kubelet will evict pods to free up resources, preventing node crashes.

### Configuring EKS Worker Nodes with User Data

You can configure Kubelet’s resource reservations and eviction thresholds directly in the EKS worker node’s EC2 instance User Data. When deploying worker nodes with Terraform, you can use the following `user_data` script to pass the necessary bootstrap parameters:

```bash
#!/bin/bash -xe
/etc/eks/bootstrap.sh \
    --kubelet-extra-args "--kube-reserved memory=0.3Gi,ephemeral-storage=1Gi --system-reserved memory=0.3Gi,ephemeral-storage=1Gi --eviction-hard memory.available<200Mi,nodefs.available<10%" \
    ${ClusterName}
```

This script ensures that Kubelet handles out-of-resource situations appropriately by reserving resources for system daemons and setting eviction thresholds to prevent resource exhaustion.

### Final Thoughts

By configuring Kubelet’s out-of-resource handling, you can prevent EKS Kubernetes nodes from going down due to resource starvation. Using the combination of `kube-reserved`, `system-reserved`, and eviction thresholds allows for better resource management, ensuring that both system daemons and Kubernetes workloads have the resources they need to function properly.
