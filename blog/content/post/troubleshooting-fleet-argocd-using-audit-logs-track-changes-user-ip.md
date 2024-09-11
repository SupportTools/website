---
title: "Using Audit Logs to Track Changes in Fleet or ArgoCD"
date: 2024-09-11T19:26:00-05:00
draft: true  
tags: ["Rancher", "Audit Logging", "Fleet", "ArgoCD", "Kubernetes"]  
categories:  
- Rancher  
- Troubleshooting  
- Kubernetes  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to use audit logs to track down issues and changes made in Fleet or ArgoCD, and trace them back to an IP address or user."  
more_link: "yes"  
url: "/fleet-argocd-audit-logs-troubleshooting/"  
---

In environments where GitOps tools like **Fleet** or **ArgoCD** are used to manage Kubernetes clusters, changes can be rapid and automated. However, when things go wrong—such as deployments failing, or configurations being overwritten—it's important to know **who** made the change, **what** was changed, and **when** the change occurred.

In this post, we’ll focus on how you can use audit logs from Rancher, Fleet, and ArgoCD to track down the root cause of issues. We'll walk through practical examples, and show you how to trace changes back to the **IP address** or **user** responsible.

<!--more-->

### Why Audit Logs Matter for GitOps Tools

Fleet and ArgoCD are designed to automate the deployment and management of Kubernetes resources, but with automation comes complexity. When something goes wrong, manual intervention is needed to determine what triggered the problem. Audit logs help track:

- **Deployment Failures**: Find out if a configuration change or a bad commit caused the issue.
- **Unauthorized Access**: Track down unauthorized or accidental modifications to Git repositories or Kubernetes resources.
- **Configuration Drift**: Identify when and how configurations deviated from the desired state.

---

## Tracking Changes with Audit Logs

### Step 1: Rancher Server Audit Logs

Rancher manages Fleet deployments, so Rancher’s **server audit logs** capture actions performed by administrators and users that could impact Fleet or ArgoCD. These logs can help answer:

- **Who approved a deployment?**
- **What changes were made to repository settings or cluster configurations?**
- **Which user made changes to GitOps configuration or roles?**

#### Example Rancher Server Audit Log Entry:

```json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "level": "RequestResponse",
  "timestamp": "2024-09-11T14:35:21Z",
  "user": {
    "username": "devops-admin",
    "groups": ["system:authenticated"]
  },
  "verb": "update",
  "objectRef": {
    "resource": "fleetbundles",
    "namespace": "fleet-default",
    "name": "frontend-bundle"
  },
  "sourceIPs": ["192.168.0.5"],
  "responseStatus": {
    "metadata": {},
    "code": 200
  }
}
```

In this example:

- The **user** `devops-admin` updated a Fleet bundle (`frontend-bundle`) in the `fleet-default` namespace.
- The request came from **IP address** `192.168.0.5`.
- The operation was successful with a `200` response code.

### Step 2: kube-apiserver Audit Logs

Kubernetes’ **kube-apiserver** logs capture all API requests related to resource creation, updates, and deletions. In the case of Fleet or ArgoCD, changes made by the controllers or GitOps workflows will also be logged here.

For example, if a resource like a **Deployment** or **ConfigMap** is automatically modified by ArgoCD, you can trace the change in the kube-apiserver logs.

#### Example kube-apiserver Audit Log Entry:

```json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "level": "RequestResponse",
  "timestamp": "2024-09-11T15:12:47Z",
  "user": {
    "username": "system:serviceaccount:argocd:argocd-application-controller",
    "groups": ["system:serviceaccounts", "system:authenticated"]
  },
  "verb": "patch",
  "objectRef": {
    "resource": "deployments",
    "namespace": "production",
    "name": "nginx-deployment"
  },
  "sourceIPs": ["10.10.20.15"],
  "responseStatus": {
    "metadata": {},
    "code": 200
  }
}
```

- The **ArgoCD controller** is the user (`argocd-application-controller`), indicating an automated process.
- The resource modified was the `nginx-deployment` in the `production` namespace.
- The **IP address** `10.10.20.15` shows the server where the request originated.

By cross-referencing these logs with Rancher audit logs, you can determine which user or service triggered ArgoCD’s action.

---

## Step 3: ArgoCD Audit Logs

ArgoCD maintains its own **audit logs** for tracking deployment actions, repository syncs, and configuration changes. To access these logs, you can view them directly from the **ArgoCD UI** or configure an external log management solution (e.g., Loki, Elasticsearch) to collect and analyze them.

ArgoCD logs capture events such as:

- **Sync Events**: When a repository is synced with the cluster.
- **Rollback Actions**: When a rollback occurs due to a failed deployment.
- **Manual Overrides**: When users manually modify a configuration or resource.

#### Example ArgoCD Sync Log:

```json
{
  "level": "info",
  "time": "2024-09-11T16:02:33Z",
  "msg": "Syncing Application",
  "app": "nginx-app",
  "dest": "namespace: production",
  "user": "admin@argocd.local",
  "url": "https://git.example.com/repo/argocd-app",
  "commit": "34c5f9e"
}
```

In this case:

- The **user** `admin@argocd.local` initiated a sync for the `nginx-app`.
- The sync is targeting the `production` namespace.
- The change is linked to **commit** `34c5f9e`, providing a direct trace to the Git commit that triggered the sync.

---

## Tracing Changes Back to a User or IP

To effectively trace an issue back to a user or IP address, follow these steps:

1. **Start with the kube-apiserver Logs**:
   - Look for the resource that was changed (e.g., a pod or deployment).
   - Identify the **source IP** and **user** from the log entry.

2. **Cross-Reference with Rancher Logs**:
   - If the user is an authenticated Rancher user, check the Rancher audit logs to see if the action was initiated from Rancher.
   - Use the **source IP** or **username** to correlate the action.

3. **Check GitOps Tools (Fleet or ArgoCD)**:
   - For automated changes, check Fleet or ArgoCD logs to see if a sync or deployment triggered the change.
   - Match the sync or action to a specific **Git commit** and **user** in the repository.

### Example Scenario: Unauthorized Resource Deletion

You notice that a deployment was deleted unexpectedly. To find the source:

1. **Check kube-apiserver logs**:
   - Look for a `delete` action on the deployment.
   - Identify the user or service account that initiated the deletion.

   ```json
   {
     "user": {
       "username": "system:serviceaccount:argocd:argocd-application-controller"
     },
     "verb": "delete",
     "objectRef": {
       "resource": "deployments",
       "name": "frontend-app"
     },
     "sourceIPs": ["10.10.20.15"]
   }
   ```

2. **Cross-reference Rancher logs**:
   - Look for any role or permission changes that might have affected the GitOps tool’s access rights.

   ```json
   {
     "user": {
       "username": "rancher-admin"
     },
     "verb": "update",
     "objectRef": {
       "resource": "rolebindings",
       "name": "argocd-admin"
     },
     "sourceIPs": ["192.168.1.100"]
   }
   ```

3. **Check ArgoCD audit logs**:
   - Verify if a sync or rollback action occurred that might have caused the deletion.

   ```json
   {
     "level": "info",
     "msg": "Rollback triggered due to failed sync",
     "app": "frontend-app",
     "commit": "45d9f8a"
   }
   ```

By combining data from these logs, you can determine if the deletion was an automated rollback, a misconfiguration, or a manual intervention.

---

## Best Practices for GitOps and Audit Logs

- **Enable Audit Logs on All Components**: Ensure that both Rancher server and kube-apiserver audit logging are enabled and properly configured.
- **Centralize Log Management**: Use log aggregation tools (e.g., Elasticsearch, Loki) to centralize and correlate logs across Rancher, Kubernetes, and GitOps tools. 
- **Set Up Alerts**: Configure alerts for critical events like unauthorized role changes, failed syncs, or resource deletions.
- **Track IP Addresses**: Use source IP addresses to trace actions back to specific users or machines in your network.

---

### Conclusion

Audit logs are an essential tool for tracking down issues with Fleet or ArgoCD in Kubernetes environments. By properly configuring and analyzing these logs, you can trace changes back to specific users or IP addresses, identify misconfigurations, and resolve issues more efficiently. Whether the problem is a failed deployment or unauthorized access, audit logs provide the forensic data you need to maintain control and security in your clusters.
