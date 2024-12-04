---
title: "Rancher and CAPI Finalizers: Managing Kubernetes Clusters Effectively"  
date: 2024-12-03T21:00:00-05:00
draft: false
tags: ["Kubernetes", "Rancher", "Cluster API", "Finalizers"]  
categories:  
- Kubernetes  
- Rancher  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Understand how Rancher and Cluster API (CAPI) use finalizers to manage Kubernetes clusters effectively, including cleanup processes and troubleshooting stuck resources."  
more_link: "yes"  
url: "/rancher-capi-finalizers/"  
---

Rancher and Cluster API (CAPI) are powerful tools for managing Kubernetes clusters, from provisioning to lifecycle management. Both frameworks rely heavily on **finalizers** to coordinate resource cleanup and ensure that no dangling dependencies or orphaned infrastructure remain after a resource is deleted. In this post, we’ll explore how Rancher and CAPI use finalizers, what happens during cluster deletion, common pitfalls, and best practices for handling stuck finalizers.

<!--more-->

---

# What Are Finalizers in Rancher and CAPI?

Finalizers are metadata strings added to Kubernetes resources that act as preconditions for deletion. Both Rancher and CAPI extend Kubernetes capabilities by introducing custom resources for managing clusters and their associated infrastructure. These resources come with finalizers that ensure cleanup tasks—like deleting infrastructure or removing cloud credentials—are completed before the resource is deleted.

---

# Rancher Finalizers  

Rancher uses custom resources under the `provisioning.cattle.io` API group to manage Kubernetes clusters. These custom resources include Rancher-specific finalizers that handle tasks such as:
- Cleaning up node pools.
- Removing cloud integration configurations.
- Ensuring the proper deprovisioning of workloads and monitoring tools.

### Example: Rancher Cluster Finalizers  

Here’s an example of a Rancher-managed cluster with multiple finalizers:  

```yaml
apiVersion: provisioning.cattle.io/v1
kind: Cluster
metadata:
  finalizers:
  - wrangler.cattle.io/provisioning-cluster-remove
  - wrangler.cattle.io/rke-cluster-remove
  - wrangler.cattle.io/cloud-config-secret-remover
  name: a1-ops-lab
  namespace: fleet-default
spec:
  kubernetesVersion: v1.30.6+rke2r1
  rkeConfig:
    chartValues:
      harvester-cloud-provider:
        cloudConfigPath: /var/lib/rancher/rke2/etc/config-files/cloud-provider-config
```

#### Finalizers in Detail:  
1. **`wrangler.cattle.io/provisioning-cluster-remove`**:  
   Ensures that Rancher-specific cluster resources are removed, including configuration files and workload definitions.

2. **`wrangler.cattle.io/rke-cluster-remove`**:  
   Handles tasks specific to RKE clusters, like cleaning up associated configurations and cluster-related components.

3. **`wrangler.cattle.io/cloud-config-secret-remover`**:  
   Deletes cloud integration secrets (e.g., AWS or Azure credentials) that were used during the cluster’s lifecycle.

---

# Cluster API (CAPI) Finalizers  

Cluster API (CAPI) is a Kubernetes project for declarative cluster management. It provides APIs to manage the lifecycle of clusters and their infrastructure. CAPI resources such as `Cluster` and `Machine` use finalizers to coordinate tasks like infrastructure teardown and control plane cleanup.

### Example: CAPI Cluster Finalizers  

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  finalizers:
  - cluster.cluster.x-k8s.io
  name: a1-ops-lab
  namespace: fleet-default
ownerReferences:
  - apiVersion: provisioning.cattle.io/v1
    blockOwnerDeletion: true
    controller: true
    kind: Cluster
    name: a1-ops-lab
```

#### Finalizers in Detail:  
1. **`cluster.cluster.x-k8s.io`**:  
   Ensures that the infrastructure (e.g., virtual machines, load balancers, storage) is deprovisioned before the cluster resource is deleted.  

2. **Owner References**:  
   The `ownerReferences` field links the CAPI `Cluster` to its Rancher `Cluster` resource. This ensures that Rancher-specific tasks are completed before the infrastructure cleanup begins.

---

# The Lifecycle of Rancher and CAPI Finalizers  

When a Rancher or CAPI-managed cluster is deleted, the following sequence of events typically occurs:

1. **Rancher Finalizer Execution**:  
   Rancher finalizers handle cleanup tasks related to Rancher-specific resources, such as node pools, workload monitoring, and cloud configurations.  

2. **CAPI Finalizer Execution**:  
   The CAPI `cluster.cluster.x-k8s.io` finalizer tears down underlying infrastructure, including virtual machines, load balancers, and storage volumes.  

3. **Finalizer Removal**:  
   Once cleanup tasks are complete, the respective controllers remove the finalizers, allowing the cluster resource to be deleted.  

This process ensures that no resources are left dangling, which could lead to unnecessary costs or inconsistencies.

---

# Troubleshooting Stuck Finalizers  

Finalizers can occasionally get stuck, leaving a cluster resource in a `Terminating` state. This usually happens when the cleanup tasks fail or when there are configuration issues.

### How to Identify Stuck Finalizers  

1. **Inspect the Resource**:  
   Use `kubectl` to view the finalizers on the stuck resource:  
   ```bash
   kubectl get clusters.provisioning.cattle.io -n fleet-default a1-ops-lab -o yaml
   ```

2. **Check Logs**:  
   Look at the controller logs (Rancher or CAPI) to identify errors during the cleanup process.  

---

### How to Remove Stuck Finalizers  

If cleanup cannot be retried, you can remove the finalizers manually as a last resort.  

#### Rancher Resource:  
```bash
kubectl patch clusters.provisioning.cattle.io -n fleet-default a1-ops-lab -p '{"metadata":{"finalizers":[]}}' --type=merge
```

#### CAPI Resource:  
```bash
kubectl patch clusters.cluster.x-k8s.io -n fleet-default a1-ops-lab -p '{"metadata":{"finalizers":[]}}' --type=merge
```

After removing the finalizers, make sure to manually clean up any leftover infrastructure or configurations.

---

# Best Practices for Managing Rancher and CAPI Finalizers  

1. **Enable Logging**:  
   Ensure that both Rancher and CAPI controllers have proper logging enabled to debug stuck finalizers effectively.

2. **Monitor Resources**:  
   Regularly audit cluster resources for stuck finalizers or incomplete cleanup tasks.  

3. **Use Automation**:  
   Automate cleanup tasks where possible to reduce manual intervention and prevent errors.  

4. **Avoid Force-Removing Finalizers**:  
   Only remove finalizers manually when absolutely necessary, and always clean up orphaned resources afterward.  

---

Rancher and Cluster API finalizers are essential tools for managing Kubernetes clusters efficiently. They ensure that resources are deprovisioned in a clean and predictable manner, reducing the risk of dangling infrastructure or inconsistencies. By understanding their role and following best practices, you can confidently manage cluster lifecycles in complex environments.

---