---
title: "Resolving Helm Stuck Releases: How to Delete a Helm Release When It Refuses to Uninstall"
date: 2024-12-05T10:00:00-05:00
draft: false
tags: ["Helm", "Kubernetes", "Troubleshooting", "DevOps"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to resolve Helm stuck releases with the mapkubeapis plugin and ensure smooth Helm chart management in Kubernetes."
more_link: "yes"
url: "/helm-stuck-release-fix/"
---

Helm is an invaluable tool for managing Kubernetes applications, but every Helm user has likely encountered a situation where a release gets stuck and refuses to uninstall. This guide will walk you through how to troubleshoot and fix a Helm release stuck in the `uninstalling` state, particularly when dealing with deprecated Kubernetes APIs.  

<!--more-->

# [Resolving Helm Stuck Releases](#resolving-helm-stuck-releases)

---

## Common Scenario: Helm Refuses to Delete a Release  

Imagine you’re managing a Helm release for a legacy application, and your Kubernetes cluster has gone through several major version upgrades. Suddenly, you find yourself unable to uninstall the release due to errors involving deprecated APIs.  

Here’s a typical error you might encounter:  
```plaintext
Error: failed to delete release: kubecost
```

When you check the release status, you see something like this:  

```bash
helm status kubecost -n kubecost
NAME: kubecost
LAST DEPLOYED: Thu Oct 14 12:42:35 2021
NAMESPACE: kubecost
STATUS: uninstalling
REVISION: 1
```

In this case, the release is stuck, and Helm won’t let you proceed.  

---

## The Root Cause  

The issue often arises because the release references Kubernetes APIs that are deprecated or removed in your cluster’s version. For example:  
```plaintext
Failed to list *v1beta1.CertificateSigningRequest: the server could not find the requested resource
```

To resolve this, we’ll use the **mapkubeapis** Helm plugin.  

---

## Using the `mapkubeapis` Plugin  

### What Is `mapkubeapis`?  
The `mapkubeapis` plugin is a Helm v3 tool that updates Helm release metadata to replace deprecated or removed Kubernetes APIs with supported ones.  

---

### Step 1: Install `mapkubeapis`  

Install the plugin using the following command:  
```bash
helm plugin install https://github.com/helm/helm-mapkubeapis
```  
Successful installation looks like this:  
```plaintext
Downloading and installing helm-mapkubeapis v0.4.1 ...
Installed plugin: mapkubeapis
```

---

### Step 2: Update the Helm Release Metadata  

Run the plugin against the problematic Helm release:  
```bash
helm mapkubeapis -n kubecost kubecost
```  
This will:  
- Check for deprecated or removed APIs.  
- Update the release metadata to use supported APIs.  

Example output:  
```plaintext
2023/09/14 13:36:55 Check release 'kubecost' for deprecated or removed APIs...
Found 1 instance of deprecated API:
"apiVersion: networking.k8s.io/v1beta1
kind: Ingress"

Updated to:
"apiVersion: networking.k8s.io/v1
kind: Ingress"
```

---

### Step 3: Uninstall the Helm Release  

Once the release metadata is updated, you can uninstall the release without issues:  
```bash
helm uninstall kubecost -n kubecost
```

---

## Best Practices for Avoiding Stuck Releases  

1. **Keep APIs Updated**  
   - Regularly update your Helm charts to ensure compatibility with your Kubernetes version.  
   - Use tools like `kubectl deprecations` to scan for deprecated APIs.  

2. **Test Helm Upgrades**  
   - Validate chart upgrades in staging environments before deploying to production.  

3. **Monitor Helm Releases**  
   - Use `helm list -a` to identify releases stuck in problematic states.  

---

## Conclusion  

Helm errors like stuck releases can be frustrating, but tools like `mapkubeapis` simplify the resolution process by updating deprecated APIs. By keeping your Helm charts and Kubernetes APIs up-to-date, you can avoid similar issues in the future.  

Need help with Helm or Kubernetes? Reach out at **mmattox@support.tools**, or follow me for more insights into DevOps and cloud-native technologies.  
