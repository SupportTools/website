---
title: "Kubernetes Double Jump Upgrades: Skipping Versions Safely"
date: 2024-11-29T12:30:00-05:00
draft: false
tags: ["Kubernetes", "Upgrades", "Double Jump", "K8s Maintenance"]
categories:
- Kubernetes
- Maintenance
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to perform double jump Kubernetes upgrades by skipping intermediate versions while adhering to Kubernetes' version skew and API deprecation policies."
more_link: "yes"
url: "/kubernetes-double-jump-upgrades/"
---

Upgrading a Kubernetes cluster can be challenging, especially with its fast release cycle. However, **double jump upgrades**, where you skip intermediate versions, can help reduce downtime and effort—if done correctly. This guide explains Kubernetes' version skew policy, API deprecation rules, and the steps to safely perform double jump upgrades.

<!--more-->

# [Kubernetes Double Jump Upgrades](#kubernetes-double-jump-upgrades)

## What Are Double Jump Upgrades?  

Double jump upgrades allow you to skip one Kubernetes version during an upgrade. For example:
- Upgrade the **control plane** from version 1.22 → 1.23 → 1.24.
- Directly upgrade the **data plane** (worker nodes) from 1.22 → 1.24.

This method works due to Kubernetes' version skew policy and API stability guarantees, enabling faster upgrades without compromising compatibility—provided your cluster primarily uses **GA** and **Beta** APIs.

---

## Understanding Kubernetes Version Skew Policy  

Kubernetes maintains a version skew policy to ensure compatibility during upgrades:
1. **Control Plane**: Components in a highly available (HA) control plane can differ by one minor version.  
2. **Data Plane**: Worker nodes can lag behind the control plane by up to two minor versions.  

### Example:
- If your control plane is on 1.24, your worker nodes can safely run versions 1.22, 1.23, or 1.24.  
- Worker nodes should never run a version newer than the control plane.

---

## API Deprecation and Removal Policy  

Kubernetes has strict rules for deprecating and removing APIs:  
- **GA APIs**: Deprecated APIs remain functional within the same major version but are not removed until a subsequent major version.  
- **Beta APIs**: These are deprecated after three minor releases or nine months (whichever is longer).  
- **Alpha APIs**: These may be removed in any release without prior notice.

### Why This Matters:
- Using **GA** and stable **Beta** APIs ensures compatibility across skipped versions during a double jump upgrade.  
- Clusters relying heavily on Alpha APIs or deprecated Beta APIs are at higher risk of breaking.

---

## Benefits of Double Jump Upgrades  

1. **Reduced Maintenance Time**: Skip the additional downtime and testing for intermediate upgrades.  
2. **Simplified Data Plane Rotation**: Directly upgrade nodes to the target version, reducing operational complexity.  
3. **Efficiency in Managed Clusters**: Managed Kubernetes services simplify control plane upgrades, making double jump upgrades more accessible.

---

## Risks of Double Jump Upgrades  

- **Potential Incompatibilities**: Changes in logging formats, configuration schemas, or feature behaviors (e.g., 1.24's switch from Docker JSON to CRI logging) can break existing setups.  
- **Missed Intermediate Fixes**: Intermediate versions may include fixes or deprecations critical for your workloads.  

**Recommendation**: Always perform due diligence, test thoroughly in staging environments, and validate API usage before upgrading.

---

## Step-by-Step: Performing a Double Jump Upgrade  

1. **Assess Your Cluster Configuration**:
   - Confirm your cluster uses **GA** or stable **Beta** APIs.  
   - Check for deprecated APIs using tools like `kubectl deprecations`.  

2. **Plan the Upgrade Path**:
   - Upgrade the control plane incrementally (e.g., 1.22 → 1.23 → 1.24).  
   - Upgrade the data plane directly to the final version (e.g., 1.22 → 1.24).  

3. **Test in a Staging Environment**:
   - Use a staging cluster to simulate the upgrade process.  
   - Validate critical workloads and custom configurations for compatibility.

4. **Upgrade the Control Plane**:
   - Follow your Kubernetes provider's documentation to upgrade the control plane incrementally.  
   - For managed clusters (e.g., AWS EKS), this is often a single command or UI action.

5. **Upgrade the Data Plane**:
   - Update the kubelet and kube-proxy versions on worker nodes directly to the target version.  
   - Ensure the container runtime and node configurations are compatible.

6. **Verify and Monitor**:
   - Use monitoring tools like Prometheus and Kubernetes metrics to verify the health of the cluster post-upgrade.  
   - Address any API or configuration issues promptly.

---

## Frequently Asked Questions  

### Is It Safe to Perform Double Jump Upgrades?
It depends on your cluster's complexity. If your data plane is simple and uses stable APIs, double jump upgrades can be relatively safe. For complex setups, thorough testing and staged upgrades are crucial.  

### Have Double Jump Upgrades Been Tested in Production?  
Yes, double jump upgrades are commonly practiced, especially in managed Kubernetes environments. Success stories highlight careful planning and validation as key factors.  

### Do Double Jump Upgrades Work Across All Clusters?  
Yes, this approach is valid for both managed and self-hosted Kubernetes clusters, as it leverages upstream Kubernetes compatibility policies.

---

## Conclusion  

Double jump upgrades provide a streamlined way to keep Kubernetes clusters up-to-date while minimizing downtime and effort. By leveraging Kubernetes' version skew policy and API stability guarantees, platform teams can safely skip intermediate versions in specific scenarios. However, always perform due diligence, test in controlled environments, and monitor closely post-upgrade.

For more details, refer to Kubernetes' official [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/) and [API Deprecation Policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/).
