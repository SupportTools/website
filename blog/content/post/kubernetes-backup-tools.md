---
title: "Exploring Backup Tools for Kubernetes: Velero, Longhorn, and More"
date: 2024-10-18T19:30:00-05:00
draft: false
tags: ["Kubernetes", "Backups", "Velero", "Longhorn"]
categories:
- Kubernetes
- Backups
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide to Kubernetes backup tools like Velero, Longhorn, and others to ensure your cluster is always safe."
more_link: "yes"
url: "/kubernetes-backup-tools/"
---

Backing up your **Kubernetes cluster** is critical for disaster recovery and ensuring continuity. Besides **KubeBackup**, other tools offer complementary and robust solutions for backing up both cluster configurations and data. In this post, we’ll explore **Velero, Longhorn**, and other tools that are designed to handle backups in Kubernetes environments.

<!--more-->

## 1. Velero

![Velero](https://raw.githubusercontent.com/vmware-tanzu/velero/main/site/docs/master/assets/images/velero-logo.png)

**Velero** is one of the most popular tools for **backing up Kubernetes clusters and persistent volumes**.

### Key Features:
- **Cluster and Namespace Backups**: Supports both full-cluster and per-namespace backups.
- **Restore on Demand**: Easily restore resources and volumes to a cluster.
- **Migration Support**: Move applications between clusters.
- **S3-Compatible Storage**: Store backups in AWS S3 or any compatible storage.

### Installation:
```bash
velero install --provider aws --bucket my-bucket --backup-location-config region=us-east-1
```

### Usage:
```bash
# Create a backup
velero backup create cluster-backup --include-namespaces '*' --wait

# Restore from backup
velero restore create --from-backup cluster-backup --wait
```

---

## 2. Longhorn

![Longhorn](https://raw.githubusercontent.com/longhorn/website/main/static/img/logos/longhorn-logo.svg)

**Longhorn** is a lightweight, reliable **distributed block storage system** for Kubernetes. It is an excellent tool for **persistent volume backups**.

### Key Features:
- **Snapshots and Backup to S3**: Create PVC snapshots and back them up to external storage.
- **Disaster Recovery**: Quickly restore backed-up volumes to recover applications.
- **UI for Backup Management**: A simple UI for managing snapshots and backups.

### Installation:
```bash
helm repo add longhorn https://charts.longhorn.io
helm repo update
helm install longhorn longhorn/longhorn --namespace longhorn-system
```

### Example Usage:
1. **Take a Snapshot:**
   ```bash
   kubectl annotate pvc my-pvc -n my-namespace backup=true
   ```

2. **Restore a Volume from Snapshot:**
   Use the Longhorn UI or CLI tools to restore the snapshot to a new PVC.

---

## 3. etcd Backups

Since **etcd** stores the state of your Kubernetes cluster, **backing up etcd** is essential for cluster recovery. 

### Taking a Manual etcd Snapshot:
```bash
rke2 etcd-snapshot save --name snapshot-$(date +%Y%m%d-%H%M%S)
```

### Restoring from Snapshot:
```bash
rke2 etcd-snapshot restore --name snapshot-YYYYMMDD-HHMMSS
```

Using **etcd snapshots** along with YAML exports ensures a full recovery path for cluster state and object configurations.

---

## 4. Restic

**Restic** is an open-source backup tool that supports various storage backends, including **S3, Azure, and local disks**. While it’s not specific to Kubernetes, it can be used to back up **persistent data**.

### Key Features:
- **End-to-End Encryption**: Ensures that backups are encrypted.
- **Deduplication**: Efficiently stores data by eliminating duplicates.

### Example Restic Backup Command:
```bash
export RESTIC_PASSWORD="my-password"
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"

restic -r s3:s3.amazonaws.com/my-bucket backup /data
```

### Restore Command:
```bash
restic -r s3:s3.amazonaws.com/my-bucket restore latest --target /restore-path
```

---

## 5. TrilioVault

**TrilioVault** is an enterprise-grade backup solution for **Kubernetes applications**. It is designed for organizations that require **robust backup policies and compliance**.

### Key Features:
- **Application-Aware Backups**: Supports stateful applications.
- **Incremental Backups**: Reduces backup size by only storing changes.
- **Role-Based Access Control (RBAC)**: Manage access to backup resources.

---

## Best Practices for Kubernetes Backups

1. **Automate Backups**: Use tools like **Velero** or **Longhorn** with cron jobs or CI/CD pipelines.
2. **Offsite Storage**: Store backups in **S3 or cloud storage** to protect against local failures.
3. **Test Restores**: Regularly verify that your backups can be restored successfully.
4. **Monitor Backup Health**: Use **Prometheus** and **AlertManager** to track backup success and detect issues.

---

## Conclusion

Backups are a critical part of **Kubernetes operations**. Tools like **Velero, Longhorn, KubeBackup, etcd snapshots**, and **Restic** ensure you have a full backup strategy, covering both **configuration** and **persistent data**. Incorporate these tools into your workflow and automate the process to safeguard your clusters against unexpected failures.
