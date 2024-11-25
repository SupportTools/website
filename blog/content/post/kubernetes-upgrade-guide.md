---
title: "Upgrading Kubernetes: A Practical Guide"
date: 2024-12-01T17:30:00-05:00
draft: false
tags: ["Kubernetes", "Upgrades", "Best Practices", "Cluster Maintenance"]
categories:
- Kubernetes
- Maintenance
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to upgrade Kubernetes clusters safely and efficiently with practical tips and best practices for both legacy and modern environments."
more_link: "yes"
url: "/kubernetes-upgrade-guide/"
---

By **Matthew Mattox**  
Contact: **mmattox@support.tools**

Upgrading Kubernetes clusters can be intimidating, especially if you’ve inherited a legacy environment. But with proper planning and execution, it doesn’t have to be a nightmare. This guide offers practical advice for keeping your Kubernetes clusters updated and running smoothly, covering everything from version policies to specific upgrade workflows.

<!--more-->

# [Upgrading Kubernetes](#upgrading-kubernetes)

## Why Upgrading Kubernetes Matters  

Kubernetes follows an **N-2 version support policy**, meaning only the three most recent minor versions receive security updates. Regular upgrades ensure your cluster remains secure, benefits from new features, and aligns with industry best practices.  

However, upgrading Kubernetes isn’t as simple as switching to a new Linux distribution. It requires careful planning, compatibility checks, and testing to minimize downtime and avoid disruptions.  

---

## How Often Should You Upgrade Kubernetes?  

Kubernetes releases three minor versions annually, and each version is supported for approximately 14 months. To stay compliant, you’ll need to plan upgrades at least once or twice a year.  

### Recommended Workflow:
- **Dev Environments**: Upgrade to the latest release (.2 patch or higher) as soon as it’s available to catch issues early.  
- **Staging Environments**: Stay one minor version behind dev for thorough validation.  
- **Production Environments**: Lag behind staging by one minor version to ensure stability.  

**Pro Tip**: Avoid upgrading to a new release until it reaches at least the `.2` patch (e.g., 1.26.2). Early releases often contain undiscovered bugs or regressions.

---

## Key Steps to Upgrade Kubernetes  

### 1. **Preparation**  

#### **Review Release Notes**  
Understand the changes, deprecated features, and potential breaking updates in the target version. Check [Kubernetes release notes](https://github.com/kubernetes/kubernetes/releases) for details.  

#### **Run Compatibility Checks**  
Ensure all components, including Helm charts, add-ons (e.g., CoreDNS, kube-proxy, CNIs), and custom workloads, are compatible with the target version. Tools like **Pluto** and **Nova** can help detect deprecated APIs and outdated Helm charts.  

#### **Back Up etcd**  
Take a snapshot of the etcd database to safeguard against potential data loss during the upgrade process:  
```bash
ETCDCTL_API=3 etcdctl snapshot save snapshot.db
```

---

### 2. **Upgrade Process**  

#### **Using `kubeadm`**  
For kubeadm-managed clusters, upgrade control plane components first, followed by worker nodes:  

**Upgrade Control Plane**:  
```bash
# Upgrade kubeadm
sudo apt-mark unhold kubeadm
sudo apt-get update
sudo apt-get install -y kubeadm=1.29.x-

# Apply the upgrade
sudo kubeadm upgrade apply v1.29.x
```

**Upgrade Worker Nodes**:  
```bash
# Drain the node
kubectl drain <node-name> --force --ignore-daemonsets --delete-emptydir-data

# Upgrade kubelet
sudo apt-get update
sudo apt-get install -y kubelet=1.29.x-

# Uncordon the node
kubectl uncordon <node-name>
```

#### **Using Managed Kubernetes**  
For managed clusters like AWS EKS, use your provider’s tools to upgrade the control plane and node groups:  
```bash
eksctl upgrade cluster --name my-cluster --version 1.30 --approve
```

#### **Legacy Clusters**  
If the cluster is running an unsupported version (e.g., older than 1.21), consider creating a new cluster and migrating workloads to avoid compatibility issues.  

---

### 3. **Post-Upgrade Tasks**  

#### **Update Cluster Components**  
Ensure node pools, CNIs, and other cluster components match the upgraded control plane version.  

#### **Convert API Versions**  
Use `kubectl convert` to migrate old manifests to supported API versions:  
```bash
kubectl convert -f deployment.yaml --output-version apps/v1
```

#### **Validate Cluster Health**  
Monitor cluster performance and verify application functionality post-upgrade using tools like **Prometheus**, **Grafana**, or Kubernetes metrics.

---

## Addressing Common Challenges  

### **What If the Version Is Too Old?**  
For clusters more than two EOL versions behind:  
- Build a new cluster with the target version.  
- Migrate workloads gradually using tools like `kubectl`, Helm, or GitOps pipelines.  
- This approach minimizes risks and ensures a clean environment.  

### **Stateful Workloads**  
Pay extra attention to stateful sets, databases, and storage systems. Use Pod Disruption Budgets to avoid downtime:  
```yaml
spec:
  minAvailable: 1
```

### **Ingress and Service Meshes**  
Ensure ingress controllers and service mesh versions (e.g., Istio, Linkerd) are compatible. Upgrading these components often requires additional steps.  

---

## Tips for Long-Term Maintenance  

- **Automate Updates**: Use CI/CD pipelines to test and validate upgrades in dev and staging environments.  
- **Track Releases**: Subscribe to Kubernetes release RSS feeds for automated notifications:  
  ```bash
  https://github.com/kubernetes/kubernetes/releases.atom
  ```
- **Consider Flatcar Linux**: For node OS, Flatcar Linux simplifies updates with minimal disruption.  

---

## Conclusion  

Upgrading Kubernetes requires consistent effort, but with proper planning, the process becomes manageable. Stay proactive by regularly testing new releases in dev environments, monitoring compatibility, and automating as much as possible.  

For legacy clusters, consider building a fresh environment to ensure a seamless transition and maintain best practices.  

If you’re feeling overwhelmed, explore tools like Rancher Kubernetes Engine with Flatcar Linux for a streamlined experience.  

Got stuck or have questions? Reach out anytime at **mmattox@support.tools**.  
