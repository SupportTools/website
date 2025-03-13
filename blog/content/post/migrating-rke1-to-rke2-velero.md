---
title: "Migrating from RKE1 to RKE2 Using Velero: An Open-Source Approach"
date: 2025-03-13T01:45:00-05:00
draft: false
tags: ["Kubernetes", "RKE1", "RKE2", "Migration", "Velero", "Backup", "Restore", "Open Source"]
categories:
- Kubernetes
- Migration
- Backup & Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to migrating workloads from RKE1 to RKE2 using Velero, an open-source backup and restore solution, with practical examples and configuration tips."
more_link: "yes"
url: "/migrating-rke1-to-rke2-velero/"
---

With RKE1 approaching its end-of-life date on July 31, 2025, organizations need reliable migration strategies to transition to RKE2. Velero, an open-source backup and restore tool for Kubernetes, offers a cost-effective approach for this migration that works across diverse environments.

<!--more-->

## Why Choose Velero for RKE1 to RKE2 Migration?

Velero (formerly Heptio Ark) provides several advantages for cross-cluster migrations:

- **Open-Source Solution:** Free to use with a large community and extensive documentation.
- **Cloud Provider Integration:** Native support for major cloud providers (AWS, Azure, GCP).
- **Persistent Volume Backup:** Snapshots and backup of persistent volumes along with Kubernetes resources.
- **Selective Backup and Restore:** Flexibility to migrate specific namespaces or resources.
- **Plugin Architecture:** Extensible for custom requirements through plugins.
- **Cluster-Independent Storage:** Uses object storage, making it perfect for cross-cluster scenarios.

## Prerequisites for Migration

Before beginning the migration, ensure you have:

1. **Object Storage:** Access to an S3-compatible object storage bucket (AWS S3, MinIO, etc.).
2. **CLI Tools:** Velero CLI, kubectl, and access to both RKE1 and RKE2 clusters.
3. **Storage Provider Plugins:** Required for PV snapshots (if using cloud provider storage).
4. **RKE2 Cluster:** A functional RKE2 cluster with sufficient resources.
5. **Storage Classes:** Compatible storage classes in both clusters.

## Step-by-Step Migration Process

### 1. Install Velero on Your RKE1 Cluster

First, download the Velero CLI and install it on your source RKE1 cluster:

```bash
# Download Velero CLI (example for Linux)
wget https://github.com/vmware-tanzu/velero/releases/download/v1.12.1/velero-v1.12.1-linux-amd64.tar.gz
tar -xvf velero-v1.12.1-linux-amd64.tar.gz
sudo mv velero-v1.12.1-linux-amd64/velero /usr/local/bin/
```

Next, install Velero on your RKE1 cluster with your storage provider. Here's an example using AWS S3:

```bash
# Create credentials file for Velero
cat > credentials-velero <<EOF
[default]
aws_access_key_id = YOUR_ACCESS_KEY
aws_secret_access_key = YOUR_SECRET_KEY
EOF

# Install Velero with AWS S3 plugin
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.7.0 \
  --bucket YOUR_BUCKET_NAME \
  --backup-location-config region=YOUR_REGION \
  --snapshot-location-config region=YOUR_REGION \
  --secret-file ./credentials-velero
```

For other providers, refer to the Velero documentation for the appropriate installation commands.

### 2. Create a Backup of Your RKE1 Resources

Once Velero is installed, create a backup of your resources:

```bash
# Backup all resources in all namespaces (excluding system namespaces)
velero backup create rke1-full-backup \
  --exclude-namespaces kube-system,kube-public,kube-node-lease \
  --include-cluster-resources=true \
  --snapshot-volumes

# Alternatively, for selective namespace backup
velero backup create rke1-app-backup \
  --include-namespaces namespace1,namespace2 \
  --snapshot-volumes
```

Monitor the backup progress:

```bash
velero backup describe rke1-full-backup
```

Wait until the backup shows `Phase: Completed`.

### 3. Install Velero on Your RKE2 Cluster

Switch your kubectl context to your RKE2 cluster and install Velero with the same storage configuration:

```bash
# Verify you're targeting the RKE2 cluster
kubectl get nodes

# Install Velero with the same configuration as RKE1
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.7.0 \
  --bucket YOUR_BUCKET_NAME \
  --backup-location-config region=YOUR_REGION \
  --snapshot-location-config region=YOUR_REGION \
  --secret-file ./credentials-velero
```

### 4. Restore Your Workloads to the RKE2 Cluster

After Velero installation on RKE2 is complete, refresh the backup repository:

```bash
velero backup-location get
velero backup-location set default --default
```

List available backups and restore your workloads:

```bash
# List available backups
velero backup get

# Restore from backup
velero restore create --from-backup rke1-full-backup
```

For more control, you can specify namespaces or include/exclude resources:

```bash
# Restore specific namespaces
velero restore create --from-backup rke1-full-backup \
  --include-namespaces namespace1,namespace2

# Restore with resource filtering
velero restore create --from-backup rke1-full-backup \
  --include-resources deployments,services,configmaps,secrets,persistentvolumeclaims
```

### 5. Monitor the Restore Process

Track the restoration progress:

```bash
# Get restore status
velero restore describe RESTORE_NAME

# View restore logs
velero restore logs RESTORE_NAME
```

### 6. Validate the Migration

After the restore completes, verify your applications are functioning correctly:

```bash
# Check pods in your namespaces
kubectl get pods -n YOUR_NAMESPACE

# Check persistent volume claims
kubectl get pvc -n YOUR_NAMESPACE

# Verify services
kubectl get svc -n YOUR_NAMESPACE
```

Perform application-specific validation tests to ensure functionality.

## Advanced Configuration Options

### Handling Storage Class Differences

When migrating between clusters with different storage classes:

```bash
# Create a restore with storage class mapping
velero restore create --from-backup rke1-full-backup \
  --storage-class-remapping source-class:target-class
```

### Selective Resource Restoration

To exclude certain resources during restore:

```bash
velero restore create --from-backup rke1-full-backup \
  --exclude-resources secrets,configmaps
```

### Handling Custom Resource Definitions (CRDs)

Velero backs up CRDs and their instances, but you might need to install operators first:

```bash
# Apply CRDs before restoration
kubectl apply -f custom-resource-definitions.yaml

# Then restore custom resources
velero restore create --from-backup rke1-full-backup \
  --include-resources customresourcetype.group.io
```

### Resource Transformation with Velero Hooks

Use Velero hooks to transform resources during restore:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: restore-hook-config
  namespace: velero
data:
  restore-resource-hook.json: |
    {
      "apiVersion": "velero.io/v1",
      "kind": "RestoreResourceHooksDefinition",
      "metadata": {
        "name": "restore-resource-hooks"
      },
      "spec": {
        "resourceHooks": [
          {
            "name": "modify-deployment-resources",
            "includedResources": ["deployments.apps"],
            "postHooks": [
              {
                "exec": {
                  "container": "velero",
                  "command": ["/modify-resource.sh"],
                  "onError": "Fail"
                }
              }
            ]
          }
        ]
      }
    }
```

## Best Practices and Troubleshooting

### Pre-Migration Best Practices

- **Backup Testing:** Test restores in a non-production environment first.
- **Volume Snapshots:** Ensure your storage provider supports CSI snapshots.
- **Resource Requests/Limits:** Be aware that resource constraints will transfer to the new cluster.
- **Network Policies:** Verify network policies will work similarly in RKE2.
- **Label Namespaces:** Add labels to better organize and select resources during migration.

### Common Issues and Solutions

#### Failed PV Restores

**Issue:** Persistent volumes fail to restore.  
**Solution:** Verify storage classes, ensure CSI drivers are installed, and check snapshot location configuration.

```bash
# Check snapshot location status
velero snapshot-location get

# Verify PV restore issues
kubectl get events -n YOUR_NAMESPACE
```

#### Resource Version Conflicts

**Issue:** API resource version differences between RKE1 and RKE2.  
**Solution:** Update the Kubernetes version in the RKE2 cluster to match or use resource transformers.

#### Missing CRD Controllers

**Issue:** Custom resources restore, but controllers are missing.  
**Solution:** Install required operators and CRDs in the RKE2 cluster before restoration.

```bash
# Verify CRDs in RKE2
kubectl get crds | grep YOUR_CRD
```

#### Namespace Already Exists

**Issue:** Namespace already exists during restore.  
**Solution:** Use the `--existing-resource-policy=update` flag to update existing resources:

```bash
velero restore create --from-backup rke1-full-backup \
  --existing-resource-policy=update
```

## Post-Migration Steps

After successful migration:

1. **Update DNS/Load Balancers:** Point external traffic to the new RKE2 cluster endpoints.
2. **Verify Application Health:** Ensure all components are operational and communicating.
3. **Update Monitoring:** Configure monitoring tools for the new cluster.
4. **Configure Regular Backups:** Set up scheduled backups in the RKE2 cluster.
5. **Decommission RKE1:** Plan for the safe shutdown of your RKE1 cluster.

## Velero for Ongoing Protection

Continue using Velero for ongoing protection of your RKE2 cluster:

```bash
# Create a scheduled backup
velero schedule create rke2-daily-backup \
  --schedule="0 1 * * *" \
  --exclude-namespaces kube-system,kube-public \
  --include-cluster-resources=true \
  --snapshot-volumes
```

## Conclusion

Migrating from RKE1 to RKE2 using Velero provides a robust, open-source approach that works across various environments. The flexibility of Velero makes it suitable for both simple and complex migration scenarios, while its extensibility allows for customization to meet specific requirements.

By following this guide, you can leverage Velero's capabilities to achieve a successful migration with minimal downtime, ensuring your applications continue to run smoothly in the new RKE2 environment.

---

### Additional Resources
- [Velero Documentation](https://velero.io/docs/)
- [Velero GitHub Repository](https://github.com/vmware-tanzu/velero)
- [RKE2 Documentation](https://docs.rke2.io/)
- [RKE1 to RKE2 Migration Strategy Overview](https://support.tools/migrating-rke1-to-rke2/)
- [SUSE RKE1 EOL Announcement](https://www.suse.com/support/kb/doc/?id=000021513)
