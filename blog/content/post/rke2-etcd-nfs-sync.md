---
title: "Robust RKE2 Backups: Syncing etcd Snapshots to NFS for Safety"
date: 2025-04-10T00:00:00-05:00
draft: true
tags: ["rke2", "etcd", "backup", "nfs", "kubernetes"]
categories:
- Kubernetes
- RKE2
- Backup
author: "Matthew Mattox - mmattox@support.tools"
description: "Use inotify-based detection to automatically sync RKE2 etcd snapshots to an NFS share using a Kubernetes DaemonSet."
more_link: "yes"
url: "/rke2-etcd-nfs-sync/"
---

If you're not pushing your RKE2 etcd snapshots to a remote location like S3, you're effectively backing up to the same node you're trying to protect. This creates a critical failure point—if that etcd node dies, your snapshots are gone with it.

This guide shows you how to fix that by:
- Mounting an NFS share as a PVC,
- Watching the etcd snapshot directory for new files using `inotifywait`, and
- Automatically syncing those snapshots off-node via `rsync`.

<!--more-->

# [Backup Automation for RKE2](#backup-automation-for-rke2)

## Section 1: Why You Should Not Rely on Local Snapshots

By default, RKE2 stores its etcd snapshots under:

/var/lib/rancher/rke2/server/db/snapshots

While these snapshots are crucial for recovery, **storing them locally is risky**.  For example, if you were to lose all etcd nodes at once, such as by accidentally deleting all three, any local snapshots would be lost along with them.

Remote syncing, whether to S3 or a central NFS share, ensures your snapshots are available even if an etcd node is lost. For simplicity and offline clusters, NFS is a solid choice.

So instead of relying on local snapshots, we’ll set up a system that automatically syncs new etcd snapshots to an NFS share. This way, you can be sure your backups are safe and accessible, even if the worst happens.

NOTE: This guide assumes you have a working NFS server with a exported share already set up. And are not using storage classes or dynamic provisioning and are using a manually create static NFS PV and PVC.

## Section 2: Architecture Overview

We’ll use:
- A **PVC** backed by an NFS share
- A **DaemonSet** that runs only on etcd nodes
- A shell script that uses `inotifywait` to watch for new `.zip` snapshot files
- `rsync` to copy new snapshots to the NFS mount

## Section 3: Kubernetes Resources

### PVC (NFS)

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nfs-backup-pvc
spec:
  accessModes:
    - ReadWriteMany
  capacity:
    storage: 10Gi
  volumeName: nfs-pv
```

### PersistentVolume (NFS)

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: nfs-pv
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  nfs:
    server: nfs-server-ip
    path: /etcd-snapshots
```

### ConfigMap with inotify-based Watch Script

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sync-etcd-script
  namespace: kube-system
data:
  sync.sh: |
    #!/bin/sh
    echo "Waiting for inotify-tools..."

    if ! command -v inotifywait >/dev/null 2>&1; then
      echo "Installing inotify-tools..."
      apk add --no-cache inotify-tools
    fi

    SNAP_DIR="/var/lib/rancher/rke2/server/db/snapshots"
    DEST_DIR="/nfs"

    echo "Watching $SNAP_DIR for new snapshots..."
    inotifywait -m -e close_write --format '%f' "$SNAP_DIR" | while read NEWFILE
    do
      if echo "$NEWFILE" | grep -q 'etcd-snapshot-'; then
        echo "Detected new snapshot: $NEWFILE"
        sleep 10  # brief delay to ensure write is complete
        rsync -avz "$SNAP_DIR/$NEWFILE" "$DEST_DIR/"
        echo "Synced $NEWFILE to NFS."
      fi
    done
```

### DaemonSet to Watch Snapshots on etcd Nodes

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: etcd-backup-sync
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: etcd-backup-sync
  template:
    metadata:
      labels:
        app: etcd-backup-sync
    spec:
      nodeSelector:
        node-role.kubernetes.io/etcd: "true"
      containers:
        - name: syncer
          image: alpine:3.19
          command:
            - /bin/sh
            - -c
            - |
              /sync.sh
          volumeMounts:
            - name: etcd-snapshots
              mountPath: /var/lib/rancher/rke2/server/db/snapshots
            - name: nfs-backup
              mountPath: /nfs
            - name: sync-script
              mountPath: /sync.sh
              subPath: sync.sh
              readOnly: true
      volumes:
        - name: etcd-snapshots
          hostPath:
            path: /var/lib/rancher/rke2/server/db/snapshots
        - name: nfs-backup
          persistentVolumeClaim:
            claimName: nfs-backup-pvc
        - name: sync-script
          configMap:
            name: sync-etcd-script
```

### Section 4: Validation

Create a manual etcd snapshot:

```bash
rke2 etcd-snapshot save --name test-backup
```

Watch logs:

```bash
kubectl -n kube-system logs -l app=etcd-backup-sync
```

Check the NFS mount for the .zip file.
