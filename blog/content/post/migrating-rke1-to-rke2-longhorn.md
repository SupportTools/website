---
title: "Migrating from RKE1 to RKE2 Using Longhorn DR Volumes: A Kubernetes-Native Approach"
date: 2025-03-13T01:48:00-05:00
draft: false
tags: ["Kubernetes", "RKE1", "RKE2", "Migration", "Longhorn", "Storage", "Disaster Recovery"]
categories:
- Kubernetes
- Migration
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A detailed guide to migrating workloads from RKE1 to RKE2 using Longhorn's Disaster Recovery volumes, offering a Kubernetes-native approach with minimal downtime."
more_link: "yes"
url: "/migrating-rke1-to-rke2-longhorn/"
---

With RKE1 reaching its end-of-life on July 31, 2025, organizations running Longhorn for persistent storage have a powerful built-in option for migration to RKE2. Longhorn's Disaster Recovery (DR) volumes provide a Kubernetes-native approach that synchronizes data directly between clusters for efficient, low-downtime migration.

<!--more-->

## Why Use Longhorn DR Volumes for RKE1 to RKE2 Migration?

Longhorn DR volumes offer unique advantages for cross-cluster data migration:

- **Native Kubernetes Integration:** Fully integrated with Kubernetes, requiring no external systems.
- **Incremental Replication:** Only changed data blocks are transferred, minimizing network overhead.
- **Simple Management:** Direct volume-to-volume replication without intermediate storage.
- **Minimal Downtime:** Continuous replication allows for rapid cutover with minimal data loss.
- **Application Consistency:** Support for consistent backups of multi-volume applications.
- **Built-in Health Monitoring:** Automated verification of replication status and health.

## Prerequisites for Migration

Before beginning the migration process, ensure you have:

1. **Longhorn Running on Both Clusters:** Installed and operational in both RKE1 and RKE2 clusters.
2. **Network Connectivity:** The clusters must be able to communicate on Longhorn's replication ports.
3. **Matching Longhorn Versions:** Ideally the same version on both source and target.
4. **Deployed RKE2 Cluster:** A functioning RKE2 cluster with sufficient resources.
5. **Resource Mapping:** Plan for namespace and storage class mapping between clusters.

## Step-by-Step Migration Process

### 1. Install and Configure Longhorn on Both Clusters

If Longhorn isn't already installed on both clusters, install it using Helm:

```bash
# On both RKE1 and RKE2 clusters
helm repo add longhorn https://charts.longhorn.io
helm repo update
kubectl create namespace longhorn-system
helm install longhorn longhorn/longhorn --namespace longhorn-system
```

Verify the installation is healthy:

```bash
kubectl -n longhorn-system get pods
```

All pods should show as `Running` with status `1/1`.

### 2. Set Up External Access for Inter-Cluster Communication

Enable the Longhorn backend services to communicate between clusters. This typically requires:

1. Setting up a LoadBalancer or NodePort service for the source cluster:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: longhorn-backend-external
  namespace: longhorn-system
spec:
  selector:
    app: longhorn-manager
  ports:
  - port: 9500
    targetPort: 9500
    name: manager
  type: LoadBalancer
EOF
```

2. Get the external IP or hostname:

```bash
kubectl -n longhorn-system get svc longhorn-backend-external
```

Note the `EXTERNAL-IP` for later use.

### 3. Create and Set Up a Disaster Recovery Volume in RKE2

For each persistent volume in your RKE1 cluster that you need to migrate:

1. Create a DR volume in your RKE2 cluster through the Longhorn UI:
   - Access the Longhorn UI in your RKE2 cluster
   - Navigate to "Volume" page
   - Click "Create Volume"
   - Name it appropriately (e.g., `dr-[original-volume-name]`)
   - Set size matching or larger than the source volume
   - Select "Disaster Recovery Volume" option
   - Click "Create"

2. Configure the DR volume to point to the source volume:
   - In the Longhorn UI, locate the newly created DR volume
   - Click the "Enable Disaster Recovery" button
   - In the dialog:
     - Enter the external URL of your RKE1 Longhorn (e.g., `http://EXTERNAL-IP:9500`)
     - Select the source volume from RKE1
     - Set the replication schedule (e.g., `*/5 * * * *` for every 5 minutes)
     - Click "OK"

Repeat this process for each volume you need to migrate.

### 4. Monitor the Initial Synchronization

Watch the synchronization progress through the Longhorn UI:

1. Navigate to the DR volume in the RKE2 Longhorn UI
2. The "Last Backup" field will update when the first sync completes
3. Check the "Last Backup At" timestamp to confirm regular updates

You can also check via CLI:

```bash
kubectl -n longhorn-system get volumes.longhorn.io -o custom-columns=NAME:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness
```

### 5. Create a PVC from the DR Volume

Once the initial synchronization is complete, create a PVC from the DR volume:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: migrated-pvc-name
  namespace: your-app-namespace
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  resources:
    requests:
      storage: 10Gi  # Match source volume size
  selector:
    matchLabels:
      longhornvolume: dr-source-volume-name  # Label of the DR volume
EOF
```

### 6. Prepare for Application Migration

1. Export the application manifests from your RKE1 cluster:

```bash
kubectl get deployment,statefulset,service,configmap -n your-app-namespace -o yaml > app-manifests.yaml
```

2. Modify the manifests to reference the new PVCs:
   - Update PVC names in volumes sections
   - Adjust any cluster-specific configurations

### 7. Execute the Migration

For a planned migration with minimal downtime:

1. Stop the application in RKE1:

```bash
kubectl scale deployment/your-app --replicas=0 -n your-app-namespace
```

2. Trigger a final synchronization:
   - In the Longhorn UI, select the DR volume
   - Click "Take Disaster Recovery Backup Now"
   - Wait for completion (monitor in the UI)

3. Activate the DR volume in RKE2:
   - In the Longhorn UI, select the DR volume
   - Click "Activate Disaster Recovery Volume"
   - This converts the DR volume to a regular Longhorn volume

4. Deploy the application in RKE2:

```bash
kubectl apply -f modified-app-manifests.yaml
```

5. Verify the application is running correctly in RKE2:

```bash
kubectl get pods -n your-app-namespace
kubectl describe pvc migrated-pvc-name -n your-app-namespace
```

## Advanced Configuration Options

### Volume Groups for Multi-Volume Applications

For applications with multiple related volumes, use Longhorn's volume groups to ensure consistency:

1. Create a volume group in the Longhorn UI:
   - Navigate to "Volume" page
   - Select multiple volumes by checking their boxes
   - Click "Create Group"
   - Name the group (e.g., `app-name-group`)

2. Configure DR synchronization at the group level:
   - Select the group
   - Click "Take Group Backup"
   - Configure a schedule for the entire group

### Fine-Tuning Replication Schedule

Optimize replication frequency based on data change rate and network constraints:

- **High Change Rate Data:** Use frequent schedules like `*/5 * * * *` (every 5 minutes)
- **Lower Change Rate Data:** Consider hourly schedules like `0 * * * *`
- **Before Migration:** Switch to more frequent replication to minimize data loss

### Network Bandwidth Management

Control replication bandwidth to prevent network congestion:

1. Configure global settings in the Longhorn UI:
   - Navigate to "Setting" > "General"
   - Adjust "Backup Concurrent Limit" (default: 5)

2. Or modify the CRD directly:

```bash
kubectl -n longhorn-system edit settings.longhorn.io backup-concurrent-limit
```

### Handling Large Volumes

For very large volumes (>1TB):

1. Consider setting up dedicated network paths for replication traffic
2. Increase the initial sync window to allow complete synchronization
3. Use the `backupstoragerecurring` CRD to set a custom timeout:

```bash
apiVersion: longhorn.io/v1beta1
kind: BackupStorageRecurring
metadata:
  name: dr-large-volume-settings
  namespace: longhorn-system
spec:
  backupStorageSpec:
    backupTargetSpec:
      address: target-address
    credentialSecret: longhorn-backup-target
  recurringJobSelector:
    include: []
    exclude: []
  jobRecurringConfigs:
  - name: large-volume-backup
    task: dr-backup
    groups: []
    concurrency: 1
    retain: 10
    labels: {}
    schedule: "*/30 * * * *"
    timeoutSeconds: 14400  # 4 hours
```

## Best Practices and Troubleshooting

### Pre-Migration Preparation

- **Test Run:** Perform a test migration with non-critical workloads
- **Resource Planning:** Ensure RKE2 nodes have sufficient storage capacity
- **Version Compatibility:** Verify Longhorn version compatibility between clusters
- **Network Testing:** Validate network connectivity between clusters before migration

### Common Issues and Solutions

#### Failed Synchronization

**Issue:** DR volume shows error or fails to sync  
**Solution:** Check network connectivity and Longhorn manager logs:

```bash
kubectl -n longhorn-system logs -l app=longhorn-manager
```

Look for error messages related to the DR volume and address any connectivity issues.

#### Volume Remains in "RestoreInProgress" State

**Issue:** After activation, the volume stays in "RestoreInProgress"  
**Solution:** Check for restore issues and manually force completion if needed:

```bash
kubectl -n longhorn-system describe volumes.longhorn.io volume-name
```

If stuck and data is verified as complete:

```bash
kubectl -n longhorn-system edit volumes.longhorn.io volume-name
# Change spec.restoreInitiated to false
```

#### Incorrect PVC Binding

**Issue:** PVC remains in Pending state after DR volume activation  
**Solution:** Verify PV labels and PVC selector:

```bash
kubectl get pv -o wide
kubectl describe pvc problem-pvc
```

Ensure the PVC selector labels match the PV labels.

#### Performance Issues During Replication

**Issue:** Slow replication or degraded performance  
**Solution:** Adjust concurrent backup limits and check node resource utilization:

```bash
kubectl -n longhorn-system edit settings.longhorn.io backup-concurrent-limit
```

Reduce the value if nodes are experiencing resource pressure.

## Post-Migration Steps

After successful migration:

1. **Cleanup Source Resources:**
   - Once the migration is confirmed successful, clean up the source volumes:
     ```bash
     kubectl -n app-namespace delete pvc old-pvc-name
     ```

2. **Update DNS and Access Points:**
   - Redirect traffic to services in the new RKE2 cluster
   - Update any ingress configurations

3. **Configure Regular Backups:**
   - Set up regular backup schedules for the new volumes
   - Consider retaining the DR configuration for potential rollback needs

4. **Performance Tuning:**
   - Optimize Longhorn settings in the RKE2 cluster after migration
   - Consider running the Longhorn node monitoring for optimization

## Conclusion

Migrating from RKE1 to RKE2 using Longhorn DR volumes provides a Kubernetes-native approach that leverages your existing storage infrastructure. The key advantages include incremental synchronization, application consistency, and minimal downtime during the cutover phase.

By following this guide, you can efficiently migrate your stateful workloads to RKE2 while maintaining data integrity and minimizing operational disruption. Longhorn's DR capability transforms what could be a complex migration challenge into a manageable, controlled process.

---

### Additional Resources
- [Longhorn Documentation](https://longhorn.io/docs/)
- [RKE2 Documentation](https://docs.rke2.io/)
- [RKE1 to RKE2 Migration Strategy Overview](https://support.tools/migrating-rke1-to-rke2/)
- [SUSE RKE1 EOL Announcement](https://www.suse.com/support/kb/doc/?id=000021513)
- [Longhorn Backup and Restore](https://longhorn.io/docs/1.4.0/snapshots-and-backups/backup-and-restore/)
