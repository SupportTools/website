---
title: "What Are Finalizers? When We Should Fear Them and When We Shouldn't"  
date: 2024-12-03T20:00:00-05:00
draft: false  
tags: ["Kubernetes", "Rancher", "CRDs"]  
categories:  
- Kubernetes  
- Rancher  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Understand Kubernetes finalizers, their purpose, how namespace finalizers work, and how to manage or remove finalizers without breaking your cluster."  
more_link: "yes"  
url: "/finalizers-kubernetes-rancher/"  
---

Finalizers in Kubernetes are powerful tools for resource lifecycle management. They ensure that cleanup tasks and dependencies are handled properly before a resource is deleted. However, finalizers can become problematic, especially when mismanaged or when resources get stuck in a `Terminating` state. This post provides a deep dive into finalizers, including their role in Kubernetes, namespace management, controllers, and how to handle them safely.

<!--more-->

---

# What Are Finalizers?  

Finalizers are metadata strings added to Kubernetes resources that act as preconditions for deletion. When a resource has a finalizer, the Kubernetes API server will not delete the resource until all finalizers are removed. This ensures proper cleanup and prevents issues like orphaned dependencies or dangling resources.

### Common Uses of Finalizers

- **Resource Cleanup**: Ensuring that related resources (e.g., volumes, cloud resources) are deleted or released.  
- **Graceful Termination**: Allowing time for cleanup operations to complete before removing a resource.  
- **Custom Actions**: Triggering specific cleanup workflows, such as notifying external systems or backing up data.  

For example, a PersistentVolumeClaim (PVC) with a `kubernetes.io/pv-protection` finalizer ensures that the associated PersistentVolume (PV) is safely detached or deleted before the PVC itself is removed.

---

# Resource Hierarchies: Parents and Children  

Kubernetes resources often have parent-child relationships. A parent resource typically owns or references child resources, and finalizers ensure that these relationships are cleaned up in the correct order before deletion.

- **Parents**: Higher-level resources, such as Namespaces, Deployments, and Custom Resources (CRDs).  
- **Children**: Lower-level resources like Pods, Services, ConfigMaps, PersistentVolumes, etc.  

### Examples of Parent-Child Relationships

1. **Namespace and Resources**  
   - A Namespace (parent) contains child resources like Pods, Services, and ConfigMaps.  
   - The namespace controller ensures that all child resources are deleted before the Namespace itself is removed.

2. **Deployment and Pods**  
   - A Deployment (parent) manages ReplicaSets, which in turn manage Pods (children).  
   - Deleting a Deployment gracefully terminates its Pods and cleans up ReplicaSets.  

Finalizers enforce cleanup workflows, preventing scenarios where child resources are orphaned or left unmanaged after their parent is deleted.

---

# How Controllers Use Finalizers to Manage Resources  

Kubernetes controllers are responsible for ensuring that resources are in their desired state. Finalizers are critical tools for controllers to manage resource deletion while maintaining consistency and avoiding dangling dependencies.

### 1. What Are Controllers?  

Controllers are control loops that run continuously in Kubernetes. Each controller watches specific resource types, detects changes, and performs actions to reconcile the resource's actual state with its desired state.

### Key Tasks of Controllers:

- **Add Finalizers**: Add finalizers to resources when necessary to enforce cleanup logic during deletion.  
- **Execute Cleanup Logic**: Perform specific tasks (e.g., release cloud resources, delete dependent resources) when a resource is marked for deletion.  
- **Remove Finalizers**: After completing cleanup tasks, the controller removes the finalizer, allowing the resource to be deleted.

---

### 2. Lifecycle of a Resource with Finalizers  

The lifecycle of a resource with finalizers involves the following steps:  

1. **Resource Creation**:  
   - When a resource is created, the responsible controller may add a finalizer to ensure that cleanup tasks are enforced during deletion.  
   - For example, the storage controller adds the `kubernetes.io/pv-protection` finalizer to PVCs.

2. **Resource Management**:  
   - The controller manages the resource and ensures it remains in the desired state.  

3. **Resource Deletion**:  
   - When a resource is marked for deletion, the API server sets the `deletionTimestamp`.  
   - The controller detects this and begins executing the cleanup logic defined by the finalizer.  

4. **Finalizer Removal**:  
   - Once cleanup tasks are completed, the controller removes the finalizer, signaling that the resource is ready for deletion.  

---

### 3. How Controllers Add Finalizers  

Controllers add finalizers programmatically during resource creation or updates. This ensures that resources requiring cleanup before deletion are properly managed.

#### Example: Adding a Finalizer to a PersistentVolumeClaim (PVC)  

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
  finalizers:
  - kubernetes.io/pv-protection
```

In this example, the storage controller adds the `kubernetes.io/pv-protection` finalizer to prevent the PVC from being deleted until the associated PV is released.

#### Adding Finalizers Programmatically in Go  

```go
func addFinalizer(resource *v1.PersistentVolumeClaim) error {
    if !containsString(resource.Finalizers, "kubernetes.io/pv-protection") {
        resource.Finalizers = append(resource.Finalizers, "kubernetes.io/pv-protection")
        return updateResource(resource)
    }
    return nil
}
```

---

### 4. How Controllers Execute Cleanup Logic  

When a resource marked for deletion has a finalizer, the controller performs the associated cleanup tasks. These tasks may involve:

- Deleting dependent resources (e.g., Pods, ConfigMaps).  
- Releasing external resources (e.g., cloud storage, DNS records).  
- Triggering custom workflows (e.g., notifying external systems, performing backups).  

#### Example: Namespace Controller Cleanup  

1. Detects the `deletionTimestamp` on a namespace.  
2. Lists all child resources within the namespace.  
3. Deletes child resources in the correct order (e.g., Pods, Services, ConfigMaps).  
4. Removes the `kubernetes` finalizer from the namespace once all child resources are deleted.

---

# Namespace Finalizers  

Namespaces are unique in Kubernetes as they act as containers for other resources. The `kubernetes` finalizer ensures that namespaces are not deleted until all their child resources are cleaned up.

### How Namespace Finalizers Work  

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: example-namespace
  finalizers:
  - kubernetes
```

When the `kubernetes` finalizer is present, the namespace enters a `Terminating` state if any child resources remain. The namespace controller deletes these child resources before removing the finalizer.

---

# Risks of Removing Namespace Finalizers  

Manually removing namespace finalizers skips the cleanup process and can leave orphaned resources, such as:

- **Unused PersistentVolumes**: Storage resources may remain allocated, wasting cluster resources.  
- **Lingering Pods**: Pods tied to the namespace may continue running without being tracked.  
- **Inconsistent CRDs**: Custom resources may be left in a broken state.

---

# How to Remove Finalizers  

### Step 1: Inspect the Resource  

Use `kubectl` to view the resource details:  
```bash
kubectl get namespace example-namespace -o yaml
```

### Step 2: Edit the Resource  

Manually edit the resource to remove the finalizer:  
```bash
kubectl edit namespace example-namespace
```

---

# Best Practices for Finalizers  

1. **Use Finalizers Judiciously**: Only add finalizers for resources requiring cleanup.  
2. **Monitor Finalizers**: Regularly audit resources with finalizers to identify potential issues.  
3. **Automate Cleanup**: Use controllers to manage finalizers and cleanup tasks.  
4. **Graceful Recovery**: Ensure controllers retry cleanup tasks in case of failure.  

---

Finalizers are essential for maintaining resource consistency and managing lifecycles in Kubernetes. By understanding their role in resource hierarchies, namespace management, and controller workflows, you can leverage them effectively to maintain a healthy and reliable cluster.