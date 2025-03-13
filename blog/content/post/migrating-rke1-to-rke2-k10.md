---
title: "Migrating from RKE1 to RKE2 Using Kasten K10: A Complete Backup and Restore Guide"
date: 2025-03-13T01:44:00-05:00
draft: false
tags: ["Kubernetes", "RKE1", "RKE2", "Migration", "Kasten K10", "Veeam", "Backup", "Restore"]
categories:
- Kubernetes
- Migration
- Backup & Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A detailed guide to migrating workloads from RKE1 to RKE2 using Kasten K10 by Veeam, covering installation, backup, restore, and validation steps."
more_link: "yes"
url: "/migrating-rke1-to-rke2-k10/"
---

With RKE1's end-of-life approaching on July 31, 2025, organizations need efficient strategies to migrate to RKE2. Kasten K10 by Veeam provides a powerful Kubernetes-native solution for this migration that handles both application state and data persistence.

<!--more-->

## Why Use Kasten K10 for RKE1 to RKE2 Migration?

Kasten K10 is purpose-built for Kubernetes data management, making it an excellent choice for cross-cluster migrations:

- **Application-Centric Approach:** K10 understands application components and their relationships, ensuring all resources are migrated together.
- **Data Protection Policies:** Define comprehensive policies that capture all necessary resources for migration.
- **Storage System Integration:** Deep integration with major storage providers ensures reliable PV migration.
- **Kubernetes-Native Architecture:** Runs natively in your clusters, with no external dependencies.
- **Cross-Cluster Mobility:** Specifically designed for workload mobility between different Kubernetes environments.

## Prerequisites for Migration

Before beginning the migration process, ensure you have:

1. **Kasten K10 License:** Either a free trial or paid license (available at [Kasten.io](https://www.kasten.io/)).
2. **Cluster Access:** Administrative access to both RKE1 (source) and RKE2 (target) clusters.
3. **Storage Configuration:** Compatible storage classes in both clusters, ideally with the same CSI drivers.
4. **Helm:** Installed and configured to access both clusters.
5. **Object Storage:** S3-compatible storage for the migration repository (AWS S3, MinIO, etc.).

## Step-by-Step Migration Process

### 1. Install Kasten K10 on Your RKE1 Cluster

First, deploy K10 to your source RKE1 cluster:

```bash
# Add the Kasten Helm repository
helm repo add kasten https://charts.kasten.io/

# Create the namespace for K10
kubectl create namespace kasten-io

# Install K10 using Helm
helm install k10 kasten/k10 --namespace kasten-io \
  --set auth.tokenAuth.enabled=true \
  --set injectKotsAdminConsole=true
```

After installation, access the K10 dashboard by port-forwarding:

```bash
kubectl --namespace kasten-io port-forward service/gateway 8080:8000
```

The dashboard will be available at http://127.0.0.1:8080/k10/#/.

### 2. Configure a Storage Location Profile

For cross-cluster migration, you need an external storage location:

1. In the K10 dashboard, navigate to "Settings" > "Location Profiles".
2. Click "New Profile".
3. Select your storage provider (e.g., AWS S3, MinIO).
4. Configure the required credentials and settings.
5. Name your profile (e.g., "rke-migration") and save it.

### 3. Create a Backup Policy for Your Applications

1. In the K10 dashboard, go to "Policies".
2. Click "Create New Policy".
3. Configure the policy:
   - Name: "RKE1-Migration"
   - Select applications: Choose applications to migrate (or "All Applications")
   - Action: "Snapshot"
   - Location Profile: Select the profile created earlier
   - Schedule: "On Demand" (for migration purposes)
4. Save the policy.

### 4. Run the Backup Policy

1. From the Policies page, find your "RKE1-Migration" policy.
2. Click "Run Once".
3. Monitor the backup job in the "Dashboard" section.
4. Verify all resources were successfully backed up.

### 5. Install Kasten K10 on Your RKE2 Cluster

Switch your kubectl context to your RKE2 cluster, then install K10:

```bash
# Verify you're working with the RKE2 cluster
kubectl get nodes

# Create the namespace for K10
kubectl create namespace kasten-io

# Install K10 using Helm with the same configuration
helm install k10 kasten/k10 --namespace kasten-io \
  --set auth.tokenAuth.enabled=true \
  --set injectKotsAdminConsole=true
```

### 6. Import the Location Profile

1. In the RKE2 cluster's K10 dashboard, go to "Settings" > "Location Profiles".
2. Click "New Profile" and configure it with the exact same settings as in the RKE1 cluster.
3. Name it the same as in RKE1 (e.g., "rke-migration") and save it.

### 7. Restore Applications to the RKE2 Cluster

1. In the K10 dashboard of your RKE2 cluster, navigate to "Applications".
2. Click "Restore" and select "From a backup location".
3. Select your location profile.
4. Choose the appropriate backup point from the RKE1 cluster.
5. Configure the restore options:
   - Select applications to restore
   - Choose "Restore to the same namespaces" or specify new namespaces
   - Enable "Map storage classes" if storage classes differ between clusters
6. Click "Restore" to begin the process.
7. Monitor the restore progress in the Dashboard.

### 8. Validate the Migration

After the restore completes, verify your applications are functioning correctly:

```bash
# Check all pods are running
kubectl get pods --all-namespaces

# Verify persistent volume claims are bound
kubectl get pvc --all-namespaces

# Check service endpoints
kubectl get endpoints --all-namespaces

# Run application-specific validation tests
```

## Advanced Configuration Options

### Storage Class Mapping

If your RKE1 and RKE2 clusters use different storage class names:

1. During the restore process, enable "Map storage classes".
2. Map each source storage class to its equivalent in the RKE2 cluster.
3. This ensures PVCs are recreated with the appropriate storage classes.

### Resource Transformation

To handle differences between RKE1 and RKE2:

1. K10 allows you to apply transformations to resources during restoration.
2. Use the K10 API or Kanister blueprints for custom transformations.
3. This is useful for adapting resources to RKE2's requirements.

### Selective Application Restore

For a phased migration approach:

1. Choose specific applications to restore in each phase.
2. Prioritize stateless applications first to verify basic functionality.
3. Gradually restore stateful applications with more complex requirements.

## Best Practices and Troubleshooting

### Pre-Migration Checklist

- **Resource Compatibility:** Verify all custom resources have corresponding CRDs in the RKE2 cluster.
- **Storage Performance:** Ensure the RKE2 cluster's storage system has similar or better performance.
- **Network Configuration:** Verify network policies and service meshes are compatible.
- **Cluster Resources:** Confirm the RKE2 cluster has sufficient capacity for all workloads.

### Common Issues and Solutions

#### Failed Volume Restores

**Issue:** PVs fail to restore due to storage configuration differences.  
**Solution:** Verify the CSI drivers are installed in the RKE2 cluster and properly configured. Use storage class mapping to align storage requirements.

#### Application Dependency Issues

**Issue:** Applications start in the wrong order, causing dependency failures.  
**Solution:** Use K10's restore ordering features or manually restore critical services first.

#### CRD Version Mismatches

**Issue:** Custom resources use different API versions between clusters.  
**Solution:** Update CRDs in the target cluster before restore, or use K10's transformation capabilities.

#### Resource Constraints

**Issue:** Resource requests/limits cause pods to fail scheduling after restore.  
**Solution:** Ensure the RKE2 cluster has sufficient resources or adjust requests/limits during restore.

## Post-Migration Steps

Once your applications are successfully running on RKE2:

1. **Update DNS and Load Balancers:** Point traffic to the new RKE2 cluster.
2. **Configure Monitoring:** Ensure monitoring tools are capturing metrics from the new environment.
3. **Update CI/CD Pipelines:** Modify deployment pipelines to target the RKE2 cluster.
4. **Set Up Regular Backups:** Configure K10 policies for ongoing backup protection.
5. **Document the Migration:** Record any configuration differences and lessons learned.

## Conclusion

Migrating from RKE1 to RKE2 using Kasten K10 provides a reliable, Kubernetes-native approach that preserves your applications' state and data. The application-centric design of K10 ensures all components move together, maintaining relationships and dependencies.

By leveraging K10's backup and restore capabilities, you can significantly reduce the complexity and risk of migration while minimizing downtime. This approach is particularly valuable for production environments where data integrity and consistency are critical.

---

### Additional Resources
- [Kasten K10 Documentation](https://docs.kasten.io/)
- [RKE2, Helm, Cert-manager Cluster Installation Guide](https://support.tools/cert-manager-argo-rke2/)
- [RKE1 to RKE2 Migration Strategies](https://support.tools/migrating-rke1-to-rke2/)
- [SUSE RKE1 EOL Announcement](https://www.suse.com/support/kb/doc/?id=000021513)
