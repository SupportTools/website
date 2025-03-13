---
title: "Migrating from RKE1 to RKE2 Using CloudCasa: A Backup and Restore Approach"
date: 2025-03-13T01:42:00-05:00
draft: false
tags: ["Kubernetes", "RKE1", "RKE2", "Migration", "CloudCasa", "Backup", "Restore"]
categories:
- Kubernetes
- Migration
- Backup & Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to migrating workloads from RKE1 to RKE2 using CloudCasa's backup and restore functionality, with step-by-step instructions and best practices."
more_link: "yes"
url: "/migrating-rke1-to-rke2-cloudcasa/"
---

With RKE1 reaching end-of-life on July 31, 2025, organizations need reliable strategies to migrate their workloads to RKE2. CloudCasa offers a powerful backup and restore approach for this migration, providing a comprehensive solution that handles both stateless and stateful workloads.

<!--more-->

## Why Use CloudCasa for RKE1 to RKE2 Migration?

When migrating between Kubernetes distributions like RKE1 and RKE2, using a specialized Kubernetes backup and restore solution offers significant advantages:

- **Comprehensive Resource Coverage:** CloudCasa backs up all Kubernetes resources, including ConfigMaps, Secrets, and CRDs.
- **Persistent Volume Migration:** Seamlessly transfers PVs between clusters with data integrity.
- **Cross-Distribution Compatibility:** Designed to work across different Kubernetes distributions, making it ideal for RKE1 to RKE2 transitions.
- **Minimal Downtime:** Efficient backup and restore processes reduce application unavailability.
- **Multi-Cloud Support:** Works with clusters running in any environment (on-premises, AWS, Azure, GCP).

## Prerequisites for Migration

Before starting the migration process, ensure you have:

1. **CloudCasa Account:** Sign up at [CloudCasa](https://cloudcasa.io) and set up your account.
2. **Cluster Access:** `kubectl` access to both your source RKE1 and destination RKE2 clusters.
3. **RKE2 Cluster Ready:** A functioning RKE2 cluster with sufficient resources to host your workloads.
4. **Storage Classes:** Equivalent storage classes configured in your RKE2 cluster for PV restoration.
5. **Network Connectivity:** Ensure CloudCasa can access both clusters for backup and restore operations.

## Step-by-Step Migration Process

### 1. Set Up CloudCasa on Your RKE1 Cluster

First, install the CloudCasa agent on your source RKE1 cluster:

```bash
# Create the CloudCasa namespace
kubectl create namespace cloudcasa-io

# Add the CloudCasa Helm repository
helm repo add cloudcasa-repo https://cloudcasa-io.github.io/cloudcasa-helm

# Update your Helm repositories
helm repo update

# Install the CloudCasa agent
helm install cloudcasa cloudcasa-repo/cloudcasa-agent \
  --namespace cloudcasa-io \
  --set cluster_id=YOUR_CLUSTER_ID
```

Replace `YOUR_CLUSTER_ID` with the cluster ID provided in your CloudCasa dashboard after registering your cluster.

### 2. Configure Backup Settings

In the CloudCasa web console:

1. Navigate to "Protection Policies" and create a new policy.
2. Select all relevant namespaces containing your workloads.
3. Enable PV snapshots if you have stateful applications.
4. Choose backup frequency (for migration purposes, a one-time backup is often sufficient).
5. Save your policy.

### 3. Run a Full Cluster Backup

1. Navigate to "Protection" > "On-demand Backup" in the CloudCasa dashboard.
2. Select your RKE1 cluster.
3. Choose "Full Cluster" backup type.
4. Select the namespaces you want to migrate.
5. Enable "Include Persistent Volumes" option.
6. Start the backup process and wait for completion.

### 4. Prepare Your RKE2 Cluster

Before restoring, verify your RKE2 cluster is ready:

```bash
# Verify RKE2 cluster is accessible
kubectl get nodes

# Check storage classes for PV restoration
kubectl get storageclass

# Install the CloudCasa agent on RKE2 cluster
kubectl create namespace cloudcasa-io

helm install cloudcasa cloudcasa-repo/cloudcasa-agent \
  --namespace cloudcasa-io \
  --set cluster_id=YOUR_RKE2_CLUSTER_ID
```

### 5. Restore Your Workloads to the RKE2 Cluster

From the CloudCasa dashboard:

1. Navigate to "Recovery" > "Kubernetes Restore".
2. Select the backup of your RKE1 cluster.
3. Choose "Restore to a different cluster" option.
4. Select your RKE2 cluster as the destination.
5. Configure restore options:
   - Select namespaces to restore
   - Choose "Include Persistent Volumes"
   - Configure storage class mapping if storage classes differ between clusters
   - Set conflict resolution policy (typically "Replace existing resources")
6. Start the restore process.

### 6. Validate the Migration

After the restore completes, verify your applications are functioning correctly:

```bash
# Check all pods are running
kubectl get pods -A

# Verify services are available
kubectl get svc -A

# Test application functionality
# (Application-specific tests)

# Verify PV/PVC status
kubectl get pv,pvc -A
```

## Advanced Configuration Options

### Storage Class Mapping

If your RKE1 and RKE2 clusters use different storage class names, configure mapping during restore:

1. In the restore wizard, expand "Advanced Options".
2. Under "Storage Class Mapping," map your RKE1 storage classes to equivalent RKE2 storage classes.

### Resource Filtering

For granular control over what gets migrated:

1. In the restore wizard, use the "Resource Selection" option.
2. Choose specific resource types to include/exclude.
3. Filter by labels or annotations if needed.

### Handling Custom Resources

CloudCasa handles most CRDs, but some considerations:

1. Verify both clusters have the same CRDs installed.
2. If CRDs differ, install the required controllers on RKE2 before restoring.
3. For complex CRDs, consider a phased migration approach.

## Best Practices and Troubleshooting

### Pre-Migration Checklist

- **Inventory Resources:** Run `kubectl api-resources` on both clusters to identify potential CRD compatibility issues.
- **Test Plan:** Perform a test migration with non-critical workloads first.
- **Destination Capacity:** Ensure RKE2 nodes have sufficient resources for all workloads.
- **Network Policy Compatibility:** Verify network policies work similarly in RKE2.

### Common Issues and Solutions

#### Failed PV Restores

**Issue:** PV restores fail due to storage class incompatibilities.  
**Solution:** Ensure destination storage classes support the same provisioners and features. Use storage class mapping during restore.

#### Resource Version Conflicts

**Issue:** API resource version mismatches between RKE1 and RKE2.  
**Solution:** Use CloudCasa's transformation rules to adapt resources to the target cluster's API versions.

#### CRD Compatibility

**Issue:** Custom resources fail to restore due to CRD differences.  
**Solution:** Install the required CRDs and controllers on the RKE2 cluster before restore.

#### DNS and Service Discovery

**Issue:** Applications can't communicate after migration.  
**Solution:** Verify CoreDNS configuration in RKE2 and check service endpoints.

## Post-Migration Steps

After successful migration:

1. **Update DNS/Load Balancers:** Point external traffic to the new RKE2 cluster.
2. **Verify Monitoring:** Ensure monitoring and alerting systems recognize the new resources.
3. **Document Changes:** Record any configuration differences between the clusters.
4. **Plan RKE1 Decommissioning:** Schedule the shutdown of your RKE1 cluster once all workloads are verified.

## Conclusion

Migrating from RKE1 to RKE2 using CloudCasa provides a reliable, comprehensive approach that preserves your entire application state, including persistent volumes. This method is particularly valuable for complex deployments with stateful applications where traditional redeployment strategies would be time-consuming and error-prone.

By following this guide, you can achieve a smooth migration with minimal downtime while ensuring all your workloads, configurations, and data are accurately transferred to your new RKE2 environment.

---

### Additional Resources
- [CloudCasa Documentation](https://docs.cloudcasa.io/)
- [RKE2 Documentation](https://docs.rke2.io/)
- [RKE1 to RKE2 Migration Strategy Overview](https://support.tools/migrating-rke1-to-rke2/)
- [SUSE RKE1 EOL Announcement](https://www.suse.com/support/kb/doc/?id=000021513)
