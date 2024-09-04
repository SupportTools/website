---
title: "Kubernetes RBAC Simplified"  
date: 2024-09-20T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "RBAC", "Security", "Access Control"]  
categories:  
- Kubernetes  
- Security  
- RBAC  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Understand Kubernetes Role-Based Access Control (RBAC) and how it simplifies managing permissions for cluster resources."  
more_link: "yes"  
url: "/kubernetes-rbac-simplified/"  
---

Kubernetes Role-Based Access Control (RBAC) is a critical security feature that controls who can access specific resources and what actions they can perform. By simplifying and organizing permissions across users and applications, RBAC helps secure your Kubernetes cluster. In this post, we’ll break down the basics of Kubernetes RBAC, how it works, and how you can easily configure it.

<!--more-->

### What is Kubernetes RBAC?

RBAC in Kubernetes is a method for controlling access to resources based on the roles of individual users or applications. It defines how permissions are granted to perform operations like `create`, `read`, `update`, or `delete` on cluster resources, including pods, services, deployments, and more.

The primary components of Kubernetes RBAC are:

- **Role**: Defines a set of permissions (verbs) to resources within a namespace.
- **ClusterRole**: Similar to a Role, but applies cluster-wide across all namespaces.
- **RoleBinding**: Grants a Role's permissions to a user or group within a specific namespace.
- **ClusterRoleBinding**: Grants a ClusterRole’s permissions to a user or group across the entire cluster.

### Why Use RBAC?

RBAC is essential for securing Kubernetes environments, especially in multi-tenant or production systems. It ensures that users and applications only have the necessary permissions to perform their jobs, reducing the risk of accidental or malicious actions. With RBAC, you can:

- **Control Access**: Limit who can access what resources and perform specific actions.
- **Enforce Least Privilege**: Ensure users only have the minimum permissions required to perform their tasks.
- **Secure Clusters**: Prevent unauthorized access and enhance the overall security of the cluster.

### Step 1: Defining Roles and ClusterRoles

A **Role** or **ClusterRole** defines the permissions or actions that can be performed on specific Kubernetes resources. Here’s an example of a `Role` that grants read-only access to pods in a specific namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
```

In this `Role`, we allow `get`, `list`, and `watch` actions on `pods` within the `default` namespace.

For cluster-wide permissions, use a `ClusterRole`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cluster-admin-read
rules:
- apiGroups: [""]
  resources: ["pods", "services"]
  verbs: ["get", "list"]
```

This `ClusterRole` grants read-only access to `pods` and `services` across the entire cluster.

### Step 2: Creating RoleBindings and ClusterRoleBindings

Once you’ve defined a `Role` or `ClusterRole`, you need to bind it to a user, group, or service account using a **RoleBinding** or **ClusterRoleBinding**.

Here’s an example of a `RoleBinding` that binds the `pod-reader` Role to a user named `jane` in the `default` namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pod-reader-binding
  namespace: default
subjects:
- kind: User
  name: jane
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

To bind a `ClusterRole` across the entire cluster, use a `ClusterRoleBinding`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cluster-admin-read-binding
subjects:
- kind: User
  name: admin-user
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: cluster-admin-read
  apiGroup: rbac.authorization.k8s.io
```

This binds the `cluster-admin-read` ClusterRole to a user called `admin-user`, giving them read access to all `pods` and `services` across the cluster.

### Step 3: Applying RBAC Configuration

Once you’ve defined your Roles, ClusterRoles, and their respective bindings, you can apply them to your cluster using `kubectl`:

```bash
kubectl apply -f role.yaml
kubectl apply -f rolebinding.yaml
```

To check the permissions of a user or service account, you can use the `kubectl auth can-i` command:

```bash
kubectl auth can-i get pods --as=jane
```

This command verifies if the user `jane` has the permission to `get` pods in the cluster.

### Step 4: Securing Service Accounts with RBAC

Service accounts are used by applications running in the cluster, and you can also apply RBAC rules to control what service accounts can access. Here’s an example of binding a `ClusterRole` to a service account:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: service-account-binding
subjects:
- kind: ServiceAccount
  name: my-app
  namespace: default
roleRef:
  kind: ClusterRole
  name: cluster-admin-read
  apiGroup: rbac.authorization.k8s.io
```

This grants the `my-app` service account read-only access to resources across the cluster.

### Best Practices for Kubernetes RBAC

- **Use Namespaces**: Leverage namespaces to isolate different teams or applications and apply roles to specific namespaces.
- **Grant Least Privilege**: Always assign the minimum set of permissions required for each user or service account.
- **Review Permissions Regularly**: Audit your RBAC policies regularly to ensure they still meet security and operational requirements.
- **Use RoleBindings Over ClusterRoleBindings**: Prefer `RoleBindings` for namespace-specific permissions rather than granting cluster-wide access with `ClusterRoleBindings`.

### Final Thoughts

Kubernetes RBAC is a powerful tool for controlling access to cluster resources. By implementing well-structured Roles, RoleBindings, and ClusterRoles, you can enforce least-privilege access and ensure your cluster remains secure. With this simplified guide, you should have a good starting point to implement RBAC in your Kubernetes environment.
