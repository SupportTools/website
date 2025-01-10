---
title: "Using Longhorn Volumes in Kubernetes"
date: 2025-01-09T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Volumes"]
categories:
- Longhorn
- Kubernetes
- Volumes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to use Longhorn volumes in Kubernetes, including creating volumes, attaching them to pods, accessing the Longhorn UI, and backup/restore functionality."
more_link: "yes"
url: "/longhorn-using-volumes/"
---

In this section of the **Longhorn Basics** course, we will cover using Longhorn volumes in Kubernetes, including their types, usage, and backup/restore functionalities.

<!--more-->

# Using Longhorn Volumes in Kubernetes

## Course Agenda

This section is divided into four parts:

1. **Longhorn Volume Types**
2. **Using Longhorn Volumes**
3. **Accessing the Longhorn UI**
4. **Longhorn Backup and Restore**

---

## Longhorn Volume Types

Longhorn supports two types of volumes:

1. **RWO (Read Write Once)**
   - Default volume type.
   - Can only be mounted by a single pod at a time.
   - Based on iSCSI block storage.

2. **RWX (Read Write Many)**
   - Allows multiple pods to mount the volume simultaneously.
   - Based on NFS.

---

## Using Longhorn Volumes

### 1. Creating a Longhorn Volume

To create a Longhorn volume, use the `StorageClass` created during Longhorn installation. Here’s an example YAML manifest for creating a PVC:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: longhorn-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
  storageClassName: longhorn
```

### 2. Attaching a Longhorn Volume to a Pod

Attach the created PVC to a pod by specifying it as a volume. Here’s an example YAML manifest:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: longhorn-test-pod
spec:
  containers:
    - name: test-container
      image: busybox
      volumeMounts:
        - mountPath: "/data"
          name: longhorn-volume
  volumes:
    - name: longhorn-volume
      persistentVolumeClaim:
        claimName: longhorn-pvc
```

### 3. Mounting and Writing Data to a Longhorn Volume

Once the pod is running, access the pod and write data to the mounted volume path (e.g., `/data`).

---

## Accessing the Longhorn UI

Longhorn provides a web interface to manage its components. Access the UI using one of these methods:

1. **Rancher UI**
2. **kubectl port-forward**
3. **Ingress**

**Important:** The Longhorn UI is not exposed outside the cluster by default. If you expose it, ensure it is protected with authentication since the Longhorn UI lacks built-in authentication.

---

## Longhorn Backup and Restore

### 1. Difference Between Backup and Snapshot

- **Snapshot**:
  - A point-in-time copy of a volume.
  - Not a backup; stored on the same disk.
  - Used for rollbacks (e.g., testing and reverting).

- **Backup**:
  - A copy of a volume stored externally.
  - Protects against disk/cluster failure.
  - Can restore entire volumes but not individual files.

### 2. Creating a Backup Target

Longhorn supports the following backup targets:

- **S3**: Compatible with most S3 providers (e.g., AWS S3).
- **NFS**
- **SMB/CIFS**

### 3. Creating Backup/Snapshot Schedules

Define schedules using crontab syntax. Note:

- Maximum of 100 snapshots per volume.
- Snapshots are incremental, affecting performance if overused.

### 4. Restoring from Backup/Snapshot

- Snapshots can be restored **in-place** (overwriting the existing volume).
- Backups can be restored to **new volumes**.
- Longhorn retains the original volume’s name and namespace, allowing easy restoration of deleted PVCs.

---

## Thank You

This concludes the section on using Longhorn volumes in Kubernetes. In the next section, we will delve deeper into advanced Longhorn functionalities.
