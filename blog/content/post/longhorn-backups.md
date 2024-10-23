---
title: "Longhorn Backups: Protecting Persistent Data in Kubernetes"
date: 2024-10-16T19:50:00-05:00
draft: false
tags: ["Kubernetes", "Longhorn", "Backups", "PVC"]
categories:
- Kubernetes
- Backups
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to use Longhorn to back up and restore persistent data in your Kubernetes clusters with ease."
more_link: "yes"
url: "/longhorn-backups/"
---

![Longhorn Logo](https://raw.githubusercontent.com/longhorn/website/master/static/img/logos/longhorn-stacked-color.png)

**Longhorn** provides a lightweight, reliable, and distributed **block storage solution** for Kubernetes, offering seamless **backups** of your persistent volumes (PVs) and ensuring your data is protected from failure.

In this post, we’ll dive into how **Longhorn backups work**, best practices for using them, and how to **automate your backup process** to protect your critical data.

---

## Why Longhorn for Backups?

Longhorn is designed specifically for **stateful workloads** in Kubernetes. With native support for **snapshots and backups**, it ensures that data stored in **Persistent Volume Claims (PVCs)** is protected.

Key benefits include:
- **Snapshots and backups to S3-compatible storage.**  
- **Disaster recovery:** Quickly restore volumes after failures.  
- **Backup automation:** Schedule backups for critical applications.  
- **Easy management via UI or CLI.**

---

## Setting Up Longhorn

### 1. Install Longhorn with Helm

```bash
helm repo add longhorn https://charts.longhorn.io
helm repo update
helm install longhorn longhorn/longhorn --namespace longhorn-system
```

Once installed, access the **Longhorn UI** through your Kubernetes service, or use the **kubectl proxy** to connect locally.

---

## Taking Snapshots and Backups

### 1. Creating a Snapshot

Snapshots are **local, point-in-time copies** of your volumes. These snapshots are quick to create and can be used for **local restores**.

```bash
kubectl annotate pvc my-pvc -n my-namespace backup=true
```

Alternatively, use the **Longhorn UI** to take snapshots manually by selecting the volume and clicking **Create Snapshot**.

---

### 2. Creating Backups to S3

Backups store **snapshots to an external S3-compatible storage**, protecting your data from node failures or cluster outages.

#### Configure Longhorn Backup Target:

In the **Longhorn UI**, navigate to **Settings → Backup Target** and configure it:

```
s3://my-longhorn-backup-bucket@us-east-1/
```

You can also configure this target during installation:

```bash
helm install longhorn longhorn/longhorn --namespace longhorn-system \
  --set backupTarget="s3://my-bucket@us-east-1" \
  --set backupAccessKey="S3_ACCESS_KEY" \
  --set backupSecretKey="S3_SECRET_KEY"
```

#### Trigger a Backup:

Back up a volume snapshot to S3 using the Longhorn UI or via **kubectl**:

```bash
kubectl annotate pvc my-pvc -n my-namespace backup=true
```

Longhorn will **upload the snapshot** to your configured S3-compatible storage.

---

## Restoring Backups

To restore a backup from **S3 storage**, select the **Restore** option in the Longhorn UI, or create a new PVC linked to the backup:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: restored-pvc
spec:
  storageClassName: longhorn
  dataSource:
    name: <backup-name>
    kind: VolumeSnapshot
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

This will restore the backup to a new volume, ready to be mounted and used.

---

## Automating Backups

Use **CronJobs** to automate backups for your PVCs. For example:

```bash
kubectl create cronjob pvc-backup \
  --schedule="0 * * * *" \
  --image=busybox \
  -- /bin/sh -c "kubectl annotate pvc my-pvc -n my-namespace backup=true"
```

Alternatively, you can configure automated backups directly in the **Longhorn UI** by setting a **recurring backup policy**.

---

## Monitoring Backup Health

Integrate **Prometheus** with Longhorn to monitor backup success and alert you to any failures. You can set up **AlertManager** notifications to ensure you’re notified when a backup fails or hasn’t run as expected.

---

## Best Practices for Longhorn Backups

1. **Automate Backups:** Use recurring backup policies in Longhorn to avoid manual processes.
2. **Test Restores Regularly:** A backup is only useful if it can be restored—regularly verify your restore process.
3. **Offsite Backup Storage:** Store backups in **S3 or other cloud storage** to protect against local failures.
4. **Monitor Backup Health:** Use Prometheus and AlertManager to stay on top of backup performance.
5. **Secure Backup Data:** Use encryption for sensitive data to ensure backups are secure.

---

## Conclusion

**Longhorn** makes it easy to back up and restore **persistent data** in Kubernetes, giving you peace of mind that your critical workloads are protected. With **snapshots, S3 backups**, and easy restore options, Longhorn ensures your PVCs are safe even in the event of cluster or node failures.

To learn more about other backup tools and strategies, check out:
- [KubeBackup: Automating Kubernetes Cluster Backups](https://support.tools/kubebackup/)  
- [Exploring Backup Tools for Kubernetes: Velero, Longhorn, and More](https://support.tools/kubernetes-backup-tools/)  

With Longhorn, you can confidently **automate your backups, test your restores, and keep your data protected**.
