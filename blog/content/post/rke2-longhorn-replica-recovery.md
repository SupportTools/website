---
title: "How to Recover Longhorn Volume Data from a Single Replica in RKE2 Kubernetes"
date: 2025-04-11T00:00:00-05:00
draft: false
tags: ["Longhorn", "RKE2", "Kubernetes", "Data Recovery", "Storage", "Disaster Recovery"]
categories:
- Longhorn
- RKE2
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Step-by-step guide to recover and export critical Longhorn volume data from a single replica in RKE2 Kubernetes clusters, even when the API server is offline."
more_link: "yes"
url: "/rke2-longhorn-replica-recovery/"
---

When disaster strikes and your entire RKE2 cluster or Longhorn control plane becomes unavailable, you can still **recover critical data from a single Longhorn volume replica** using a static pod definition. This emergency recovery method works even when the Kubernetes API server is completely offline and Docker is not available on your RKE2 nodes.

<!--more-->

# Recovering Longhorn Replica Data in RKE2

In this guide, you'll learn how to safely access and export data from a Longhorn volume when traditional recovery methods aren't possible. This approach leverages RKE2's static pod capability to temporarily mount a volume replica without requiring the Longhorn controller or Kubernetes API.

## Prerequisites
- Access to at least one RKE2 node containing a healthy replica of your Longhorn volume
- Basic knowledge of Linux filesystem commands
- Root access to the node

## Step 1: Locate the Replica Data on Disk

First, identify where Longhorn stores its replica data. Run this command to find the replica storage path:

```bash
find / -name longhorn-disk.cfg
```

You might see:

```
/var/lib/longhorn/longhorn-disk.cfg
```

Then list the replicas:

```bash
ls /var/lib/longhorn/replicas/
```

### Example:
```
pvc-<volume-name>-<8charUUID>
pvc-27c076f8-5710-416f-9729-83194cad4aac-7fb2c32d
```

> **Placeholder**: `/var/lib/longhorn/replicas/pvc-<your-volume-name>-<uuid>`

This command searches your entire filesystem for the Longhorn configuration file, which indicates where replicas are stored.

## Step 2: Determine the Volume Size from Metadata

To correctly mount the volume, you need its exact size. Examine the volume metadata file:

```bash
cat /var/lib/longhorn/replicas/pvc-<volume-name>-<uuid>/volume.meta
```

Look for the `Size` field:

```json
{"Size":10737418240, ...}
```

> **Placeholder**: `Size: <volume-size-in-bytes>`

### Example:
```bash
cat /var/lib/longhorn/replicas/pvc-27c076f8-5710-416f-9729-83194cad4aac-7fb2c32d/volume.meta
```
Yields:
```json
{"Size":10737418240, "Head":"volume-head-000.img", ...}
```

The `Size` field contains the volume's size in bytes, which you'll need in the next step. The JSON output also includes other useful metadata about the volume structure.

## Step 3: Create a Static Pod Manifest to Launch the Longhorn Engine

Now you'll create a static pod definition that RKE2 will automatically deploy. This pod will run the Longhorn engine and expose your volume as a block device:

```bash
/var/lib/rancher/rke2/agent/pod-manifests/longhorn-recovery.yaml
```

> **Template**:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: longhorn-launch
spec:
  hostPID: true
  containers:
  - name: engine
    image: longhornio/longhorn-engine:v<version>
    securityContext:
      privileged: true
    command: ["launch-simple-longhorn"]
    args: ["<volume-name>", "<volume-size-in-bytes>"]
    volumeMounts:
    - name: dev
      mountPath: /host/dev
    - name: proc
      mountPath: /host/proc
    - name: data
      mountPath: /volume
  volumes:
  - name: dev
    hostPath:
      path: /dev
  - name: proc
    hostPath:
      path: /proc
  - name: data
    hostPath:
      path: <host-path-to-replica>
  restartPolicy: Never
```

### Example:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: longhorn-launch
spec:
  hostPID: true
  containers:
  - name: engine
    image: longhornio/longhorn-engine:v1.8.0
    securityContext:
      privileged: true
    command: ["launch-simple-longhorn"]
    args: ["pvc-27c076f8-5710-416f-9729-83194cad4aac", "10737418240"]
    volumeMounts:
    - name: dev
      mountPath: /host/dev
    - name: proc
      mountPath: /host/proc
    - name: data
      mountPath: /volume
  volumes:
  - name: dev
    hostPath:
      path: /dev
  - name: proc
    hostPath:
      path: /proc
  - name: data
    hostPath:
      path: /var/lib/longhorn/replicas/pvc-27c076f8-5710-416f-9729-83194cad4aac-7fb2c32d
  restartPolicy: Never
```

This manifest creates a privileged pod that mounts your replica data and exposes it as a standard block device. Be sure to replace the placeholders with your actual values, including:
- The correct Longhorn engine version
- Your volume name (from the replica path)
- The exact volume size in bytes (from volume.meta)
- The full path to your replica directory

## Step 4: Monitor the Recovery Process Through Pod Logs

To verify the recovery process is working, check the pod logs:

```bash
export CRI_CONFIG_FILE=/var/lib/rancher/rke2/agent/etc/crictl.yaml
```

Find the pod:

```bash
/var/lib/rancher/rke2/bin/crictl pods | grep longhorn-launch
```

Then tail the logs:

```bash
/var/lib/rancher/rke2/bin/crictl logs <container-id>
```

Once the pod is running, you should see log messages indicating that the Longhorn engine has started and the volume is available.

## Step 5: Mount and Access the Recovered Volume Data

After the Longhorn engine initializes successfully, a new block device will appear on your system:

```
/dev/longhorn/<volume-name>
```

Mount this device in read-only mode to prevent any accidental data corruption:

```bash
mkdir -p /mnt/longhorn
mount -o ro /dev/longhorn/pvc-27c076f8-5710-416f-9729-83194cad4aac /mnt/longhorn
```

At this point, all your volume data is accessible under `/mnt/longhorn`. You can use standard file operations to copy data to a safe location:

```bash
# Example: Create a backup archive
tar -czf /tmp/volume-backup.tar.gz -C /mnt/longhorn .

# Or copy specific files
cp -rp /mnt/longhorn/important-data /tmp/backup/

# Or use rsync for large data sets
rsync -av /mnt/longhorn/ /tmp/backup/
```

You can also create a volume in Longhorn and mount it in maintense mode to this same node copy the data directly to the new volume.


## Step 6: Clean Up After Recovery

Once you've recovered your data, clean up the resources:

```bash
rm /var/lib/rancher/rke2/agent/pod-manifests/longhorn-recovery.yaml
```

After removing the manifest file, RKE2 will automatically stop the static pod, and the block device will disappear. You should also unmount the filesystem before this happens:

```bash
umount /mnt/longhorn
```

---

> **Best Practice**: Always mount Longhorn recovery volumes as read-only (`-o ro`) to prevent accidental data corruption. Any writes to an isolated replica could cause data inconsistencies if you later restore the Longhorn system.

## Troubleshooting Common Issues

### Block Device Doesn't Appear
If the `/dev/longhorn/<volume-name>` device doesn't appear:
- Check the pod logs for errors using the crictl commands from Step 4
- Verify that the replica path and volume size match exactly with the metadata
- Ensure the Longhorn engine image version is compatible with your volume format

### Mount Operation Fails
If you encounter filesystem errors when mounting:
- The filesystem might be corrupted within the volume
- Try using filesystem recovery tools like `fsck` before mounting
- Consider using data recovery tools on the raw block device

## Related Resources
- [Understanding Longhorn Replicas in RKE2](/post/longhorn-deepdive/)
- [RKE2 Disaster Recovery Strategies](/post/rke2-etcd-nfs-sync/)
- [Backup Kubernetes Cluster to AWS S3 with Velero](/post/backup-kubernetes-cluster-aws-s3-velero/)

## Conclusion

This emergency recovery technique provides a reliable method to access your data from a Longhorn volume even when the entire Kubernetes control plane or Longhorn system is unavailable. By leveraging RKE2's static pod capability, you can temporarily bring up just enough of the Longhorn engine to access your volume data without requiring the full orchestration system.

While this method is intended for emergency recovery scenarios, understanding the underlying structure of Longhorn volumes gives you a powerful option for data recovery. Remember to perform regular backups using Longhorn's built-in snapshot and backup features to minimize the need for such emergency measures in the future.

- [Longhorn Documentation](https://longhorn.io/docs/)
- [RKE2 Documentation](https://docs.rke2.io/)
