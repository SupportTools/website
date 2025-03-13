---
title: "Migrating from RKE1 to RKE2: A Seamless Transition with SUSE Rancher Prime"
date: 2025-03-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "RKE1", "RKE2", "Migration", "SUSE Rancher", "Cattle-Drive", "Velero", "Longhorn", "pv-migrate", "CloudCasa", "Kasten K10"]
categories:
- Kubernetes
- Migration
- SUSE Rancher
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to migrating from RKE1 to RKE2 using SUSE Rancher Prime, covering migration strategies, data migration methods, and troubleshooting common issues."
more_link: "yes"
url: "/migrating-rke1-to-rke2/"
---

Migrating from RKE1 to RKE2 is an essential transition for organizations relying on Rancher-managed Kubernetes clusters. With **RKE1 reaching end-of-life (EOL) on July 31, 2025**, moving to **RKE2** ensures ongoing support, security updates, and performance improvements.

<!--more-->

## Why Migrate from RKE1 to RKE2?

RKE1 will no longer receive security patches or updates beyond its EOL date. According to the [official SUSE announcement](https://www.suse.com/support/kb/doc/?id=000021513), RKE1 support ends July 31, 2025.

Delaying migration increases operational risk due to:
- Lack of security updates
- Compatibility issues with future Kubernetes versions
- Missing out on critical performance improvements

Here are the key advantages of moving to RKE2:

- **Improved Security**: SELinux support, FIPS compliance, and Pod Security Standards.
- **Better Performance**: RKE2 uses `containerd`, optimizing resource utilization and reducing overhead.
- **Long-Term Stability**: RKE2 aligns closely with upstream Kubernetes for better future compatibility.
- **Seamless Rancher Integration**: Multi-cluster management with built-in rolling upgrades.

## Beyond RKE1 EOL: Other Reasons for Cluster Migration

While RKE1's EOL is a pressing concern, there are other scenarios where cluster migration becomes necessary:

### Moving Into and Out of the Cloud

Organizations frequently move workloads between cloud and on-premises environments for cost savings, compliance, performance, and vendor flexibility.

**Common Challenges:**
- **Networking Differences**: VPC configurations, CNI plugins, and ingress controllers need reconfiguration
- **Cloud Storage Differences**: Persistent volume formats are cloud-specific (e.g., AWS EBS vs. Azure Disks)
- **IAM & Security Policies**: RBAC and firewall rules require updates

**Example Use Cases:**
- AWS EKS → RKE2 on-prem for cost control and compliance
- Self-managed Kubernetes → managed services (EKS, AKS, GKE)
- Hybrid & multi-cloud scaling for resilience

### Disaster Recovery (DR) & High Availability

Ensuring business continuity by maintaining failover clusters or running workloads across multiple regions.

**Benefits:**
- Minimize downtime during failures
- Protection against outages (cloud, network, hardware)
- Regulatory compliance with business continuity requirements

**Key Challenges:**
- Keeping stateful applications in sync
- Failover orchestration using DNS, load balancers, or BGP
- Storage and data replication across environments

### Foundational Changes & Infrastructure Upgrades

Major infrastructure changes often require migration rather than in-place upgrades.

**Common Scenarios:**
- Adopting new Kubernetes architectures
- Improving performance and scalability
- Enhancing security and compliance
- Switching container runtimes (Docker → Containerd)
- Upgrading storage solutions

## Choosing the Right Migration Strategy

Migration isn't a one-size-fits-all approach. The right strategy depends on several factors:

- **Timeline**: How quickly do you need to complete the migration?
- **Risk Tolerance**: Can you afford downtime or need a gradual transition?
- **Team Involvement**: Will this be admin-driven or do app teams need control?
- **Cluster Differences**: Are you making minimal changes or a major infrastructure shift?

Below are the three common migration strategies to consider:

### 1. **Lift-and-Shift** (Fastest, but Riskier)

**What is Lift-and-Shift?**
- You as the cluster admin move all workloads from one cluster to another in one big move
- Little to no changes are made to applications or configurations
- Best when workloads are compatible with the new cluster

**Pros:**
- **Fastest migration method** - Everything moves at once
- **Minimal app team involvement** - Admin-driven process
- **Works well** when clusters are nearly identical (same Kubernetes version, storage, etc.)

**Cons:**
- **Higher risk of failures** - No gradual testing phase
- **Potential downtime** - Some workloads may need to restart in the new cluster
- **Infrastructure differences** may require post-move fixes

### 2. **Rolling Migration** (Balanced Approach)

**What is Rolling Migration?**
- You as the cluster admin move applications one at a time in coordination with app teams
- Small to medium-size changes to applications may be made to better utilize the new environment
- Each app team tests and validates their services in the new cluster before fully migrating

**Pros:**
- **Minimized risk** - Applications are moved gradually with validation
- **App teams validate their own workloads** - Less troubleshooting after migration
- **No major downtime** - Old cluster stays online while workloads migrate

**Cons:**
- **Slower migration process** - Requires coordination with multiple teams
- **Potential inconsistencies** - If teams don't migrate in sync, dependencies may break
- **Higher resource costs** - Both clusters run in parallel during migration

### 3. **Phased Migration** (Most Flexible, Requires App Team Cooperation)

**What is Phased Migration?**
- You as the cluster admin build a new cluster and inform app teams that they need to migrate
- Responsibility is on app teams to move their workloads when ready
- Original cluster stays online until everything is moved, then decommissioned

**Pros:**
- **Less work for cluster admins** - App teams handle their own migrations
- **Flexibility** - Teams move on their own timeline, reducing coordination pressure
- **Great for major infrastructure changes** - Teams can refactor if needed before moving

**Cons:**
- **Unpredictable timeline** - Some teams may delay migration, leaving two clusters running longer
- **Potential inconsistencies** - If teams don't migrate in a structured way, dependencies may break
- **May require temporary workarounds** - Cross-cluster communication might be needed during migration

## Migration Methods – Choosing the Right Approach

Different workloads and environments require different migration techniques. When selecting a method, consider:

- Are your workloads stateless or stateful?
- Do you need a fast migration or a controlled process?
- How critical is data consistency?
- What's your team's expertise with various migration tools?

### **1. YAML Export/Import**

- **How It Works:**
  - Export workloads using:
    ```bash
    kubectl get resource -o yaml > backup.yaml
    ```
  - Apply them in the new cluster with:
    ```bash
    kubectl apply -f backup.yaml
    ```

- **Pros:** 
  - Fast and simple, no extra tools required
  - Good for stateless workloads (Deployments, Services, ConfigMaps)

- **Cons:** 
  - No Persistent Volume (PV) migration, must move storage separately
  - Manual and error-prone, requires careful dependency handling

- **Best for:** 
  - Small workloads, quick transitions, and environments without persistent data
  - [**Detailed YAML Export/Import guide**](/migrating-rke1-to-rke2-yaml/)

- **Open Source Tool:**
  - [GitHub: mattmattox/kubebackup](https://github.com/mattmattox/kubebackup)

### **2. DR-Syncer**

- **How It Works:**
  - Replicates Deployments, Services, ConfigMaps, Secrets, Persistent Volumes across clusters
  - Ensures scheduled syncing for seamless migration

- **Pros:** 
  - Purpose-built for Kubernetes migrations/DR – Handles both workloads and PVs
  - Minimizes downtime – Keeps namespaces and data synchronized
  - More efficient than manual YAML exports – Reduces human error

- **Cons:** 
  - Requires setup & configuration
  - May need cluster connectivity – Ensure network policies allow cross-cluster syncs
  - Requires similar cluster setup – Target cluster should match source
  - Target cluster must have storage configured for PV replication

- **Best for:** 
  - Stateless and Stateful applications that need replication between clusters

- **Open Source Tool:**
  - [GitHub: supporttools/DR-Syncer](https://github.com/supporttools/DR-Syncer)

### **3. Backup and Restore Tools**

- **How It Works:**
  - Backup workloads in the old cluster 
  - Restore them in the new cluster, including Persistent Volumes

- **Pros:** 
  - Works across cloud and on-prem clusters
  - Backs up all workloads including PVs, RBAC, and secrets

- **Cons:** 
  - Requires object storage (AWS S3, MinIO, Azure Blob)
  - May be slow for large clusters with many Persistent Volumes
  - Some solutions require paid licenses

- **Best for:**
  - Full-cluster migrations needing persistent storage and security settings
  - Backup and disaster recovery strategies

- **Detailed guides available for:**
  - [**Velero**](/migrating-rke1-to-rke2-velero/) - Open-source Kubernetes backup/restore with plugin architecture
  - [**CloudCasa**](/migrating-rke1-to-rke2-cloudcasa/) - Cloud-based backup solution with comprehensive resource coverage
  - [**Kasten K10**](/migrating-rke1-to-rke2-k10/) - Application-centric Kubernetes data management platform

### **4. Redeploy (GitOps)**

- **How It Works:**
  - Update the target cluster in your pipelines to reflect the new environment
  - Deploy a fresh environment in the new cluster using Helm, Kustomize, or GitOps (ArgoCD, Flux)
  - Migrate data separately using snapshots, database replication, or manual restores

- **Pros:**
  - Ensures a clean deployment, avoiding legacy config issues
  - Best for infrastructure upgrades or Kubernetes version changes

- **Cons:**
  - No automatic PV migration, must handle database and storage manually
  - Takes more time, especially for complex applications
  - Requires applications to be fully defined as code (IaC/GitOps)

- **Best for:**
  - Organizations following Infrastructure-as-Code (IaC) or GitOps practices
  - Teams migrating to declarative deployments for better reproducibility

### **5. Cattle-Drive for Rancher Resources**

- **How It Works:**
  - Migrates Rancher-specific objects from source to target cluster
  - Includes Projects, Namespaces, Rancher Permissions, Cluster Apps, and Catalog Repos

- **Pros:**
  - Automates the migration of Rancher resources between clusters
  - Preserves project structure and access controls

- **Cons:**
  - Does not migrate your applications
  - Limited to Rancher-specific resources

- **Best for:**
  - Use with redeployment migrations where you don't want to manually recreate Projects and permissions

- **Open Source Tool:**
  - [GitHub: rancherlabs/cattle-drive](https://github.com/rancherlabs/cattle-drive)

## Data Migration Methods

Migrating persistent data is crucial to maintaining application stability. Here are the recommended approaches:

### **Longhorn DR Volumes**

- **How It Works:**
  - Longhorn's Disaster Recovery (DR) volumes sync with a backup cluster on a scheduled basis
  - Uses incremental restores to minimize transfer time
  - DR volume is created from a volume's backup in the backupstore
  - Scheduled backup intervals determine how frequently data is updated

- **Pros:**
  - Scheduled Data Syncing – Uses periodic snapshots and incremental restoration
  - Faster Recovery vs. Full Backup Restores – Avoids recovering entire volumes from scratch
  - Built-in with Longhorn – No additional tools required for Longhorn users

- **Cons:**
  - Not real-time replication – Data is only as current as the last scheduled backup
  - No live snapshots or backups on DR volumes
  - Recovery Point Objective (RPO) depends on backup frequency

- **Best for:**
  - Organizations already using Longhorn for persistent storage
  - [**Detailed guide**](/migrating-rke1-to-rke2-longhorn/) on migrating using Longhorn DR volumes

### **pv-migrate**

- **How It Works:**
  - CLI tool that migrates Persistent Volume Claims (PVCs) across namespaces, clusters, or storage backends
  - Uses rsync over SSH with Load Balancers, Bind Mounts, and Port-Forwarding for data transfer
  - Supports multiple migration strategies, automatically selecting the most efficient method

- **Pros:**
  - Works across namespaces, clusters, and storage backends – Not tied to a specific CSI driver
  - Secure migrations – Uses SSH and rsync for encrypted data transfer
  - Multiple migration strategies – Falls back to different approaches when needed
  - Highly customizable – Configure rsync/SSH images, affinity, and network settings

- **Cons:**
  - Requires storage compatibility – Target storage class must support expected access modes
  - Live data requires careful handling – Works best for pre-migration syncing
  - Networking considerations – Cross-cluster migrations require proper network connectivity

- **Best for:**
  - Moving Persistent Volumes across namespaces or clusters
  - Changing storage classes
  - [**Step-by-step instructions**](/migrating-rke1-to-rke2-pv-migrate/) for PVC migration

- **Open Source Tool:**
  - [GitHub: utkuozdemir/pv-migrate](https://github.com/utkuozdemir/pv-migrate)

### **Backup and Restore Solutions**

- Backup and restore solutions that work across cloud and on-prem environments
- **Pros:** Support full-cluster backups, including PVCs, RBAC, and custom resources
- **Cons:** Slower for large clusters, requires object storage (e.g., AWS S3)

- **Detailed guides available for:**
  - [**Velero**](/migrating-rke1-to-rke2-velero/) - Open-source backup/restore tool
  - [**CloudCasa**](/migrating-rke1-to-rke2-cloudcasa/) - SaaS Kubernetes backup solution
  - [**Kasten K10**](/migrating-rke1-to-rke2-k10/) - Enterprise data management platform

## Common Migration Failures & Troubleshooting

Even with careful planning, migrations can encounter issues. Here are common problems and their solutions:

### 1. Missing Critical Cluster Services

**Issue:** After migration, applications fail due to missing dependencies like cert-manager, monitoring, or GitOps tools.

**Fix:**
- Ensure required cluster services are installed first (cert-manager, Prometheus, ArgoCD)
- Deploy cluster-wide services before migrating workloads

### 2. Forgetting Cluster-Scoped Resources

**Issue:** Applications fail to start because ClusterRoles, RoleBindings, or CRDs are missing.

**Fix:**
- Export and apply CRDs before migrating workloads:
  ```bash
  kubectl get crd -o yaml > crds.yaml
  kubectl apply -f crds.yaml
  ```
- Ensure RBAC rules (ClusterRoleBindings, ClusterRoles) are migrated properly
- List cluster-wide resources with:
  ```bash
  kubectl api-resources --verbs=list --namespaced=false
  ```

### 3. Secrets Not Stored Externally

**Issue:** Applications crash because Secrets were lost during migration.

**Fix:**
- Externalize secrets using Vault, AWS Secrets Manager, or Kubernetes External Secrets
- Backup secrets before migration:
  ```bash
  kubectl get secrets -A -o yaml > secrets-backup.yaml
  ```
- Restore secrets manually or via GitOps after migration

### 4. CNI Changes Impact Network Policies

**Issue:** A different CNI (Calico, Cilium, etc.) can change network policies, causing communication failures.

**Fix:**
- Check existing network policies before migration:
  ```bash
  kubectl get networkpolicy -A
  ```
- Verify pod-to-pod and pod-to-service communication is allowed
- Update network policies to match the new CNI's behavior before migration

## Best Practices for a Smooth Migration

- **Pre-flight validation:** Run `kubectl get all -A` to detect missing resources
- **Test migration in staging:** Never migrate production workloads without a test run
- **Use GitOps for consistency:** Store and redeploy cluster-wide resources via ArgoCD or Flux
- **Document dependencies:** Ensure all external services, cluster-scoped resources, and security policies are accounted for
- **Inventory Resources:** Run `kubectl api-resources` on both clusters to identify potential CRD compatibility issues
- **Resource Planning:** Ensure RKE2 nodes have sufficient capacity for all workloads
- **Version Compatibility:** Verify compatibility of operators and controllers between clusters
- **Network Testing:** Validate network connectivity between clusters before migration

## Conclusion

Migrating from RKE1 to RKE2 is a critical step to ensure your Kubernetes clusters remain secure, performant, and supported. With RKE1 reaching end-of-life in 2025, organizations need to plan their transition strategy now.

By understanding the different migration strategies and choosing the right migration method for your specific workloads, you can transition seamlessly with minimal downtime. The key is thorough preparation, testing, and addressing common challenges before they impact your production environment.

We've created detailed guides for several migration methods to help you through the process:

- [**YAML Export/Import Migration**](/migrating-rke1-to-rke2-yaml/) - Simple method for stateless workloads
- [**Velero Migration**](/migrating-rke1-to-rke2-velero/) - Open-source backup/restore approach
- [**CloudCasa Migration**](/migrating-rke1-to-rke2-cloudcasa/) - Cloud-based backup solution
- [**Kasten K10 Migration**](/migrating-rke1-to-rke2-k10/) - Application-centric data management
- [**Longhorn DR Volumes Migration**](/migrating-rke1-to-rke2-longhorn/) - Kubernetes-native replication
- [**pv-migrate Migration**](/migrating-rke1-to-rke2-pv-migrate/) - Targeted PVC migration

For further discussion, feel free to connect with me at [support.tools](https://support.tools) or check out my book **Rancher Deep Dive** for in-depth insights into Kubernetes and Rancher management.

---

### Additional Resources
- **Official SUSE RKE1 EOL Announcement:** [SUSE KB](https://www.suse.com/support/kb/doc/?id=000021513)
- **Migration Tool Documentation:**
  - [DR-Syncer GitHub](https://github.com/supporttools/DR-Syncer)
  - [pv-migrate GitHub](https://github.com/utkuozdemir/pv-migrate)
  - [Cattle-Drive GitHub](https://github.com/rancherlabs/cattle-drive)
  - [Longhorn Documentation](https://longhorn.io/)
  - [Velero Documentation](https://velero.io/)
  - [CloudCasa Documentation](https://cloudcasa.io/docs/)
  - [Kasten K10 Documentation](https://docs.kasten.io/)
- **Rancher Resources:**
  - [RKE2 Documentation](https://docs.rke2.io/)
  - [Rancher Documentation](https://rancher.com/docs/)
  - [Rancher Academy Training](https://rancher.academy)
- **Detailed Migration Guides:**
  - [YAML Export/Import Migration](/migrating-rke1-to-rke2-yaml/)
  - [Velero Migration](/migrating-rke1-to-rke2-velero/) 
  - [CloudCasa Migration](/migrating-rke1-to-rke2-cloudcasa/)
  - [Kasten K10 Migration](/migrating-rke1-to-rke2-k10/)
  - [Longhorn DR Volumes Migration](/migrating-rke1-to-rke2-longhorn/)
  - [pv-migrate Migration](/migrating-rke1-to-rke2-pv-migrate/)
