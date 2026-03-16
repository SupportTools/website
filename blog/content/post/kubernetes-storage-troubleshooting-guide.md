---
title: "Kubernetes Storage Troubleshooting: PVC Stuck States, CSI Driver Issues, and Data Recovery"
date: 2027-05-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "Troubleshooting", "PVC", "CSI", "Debugging"]
categories: ["Kubernetes", "Troubleshooting"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to diagnosing and recovering from Kubernetes storage failures including PVC stuck in Pending, volume mount failures, CSI driver debugging, multi-attach errors, and forced PV deletion with finalizer removal."
more_link: "yes"
url: "/kubernetes-storage-troubleshooting-guide/"
---

Storage failures in Kubernetes are uniquely disruptive because they affect stateful workloads — databases, message queues, and caches where data loss or unavailability has immediate business impact. A PVC stuck in `Pending` blocks deployment rollouts. A volume stuck in `Terminating` prevents node drain operations. A `Multi-Attach` error keeps pods in `ContainerCreating` indefinitely. Unlike stateless workload failures, storage issues often cannot be resolved by simply restarting pods, and the recovery path frequently involves understanding the underlying storage system as much as the Kubernetes API layer. This guide provides systematic debugging procedures for every common storage failure pattern.

<!--more-->

## Understanding the Storage Stack

### Kubernetes Storage Components

The Kubernetes storage stack has four primary layers:

1. **StorageClass** — Defines provisioner, parameters, reclaim policy, and volume binding mode. This is the template from which PVCs are fulfilled.

2. **PersistentVolumeClaim (PVC)** — A namespaced resource representing a request for storage. Binds to a PersistentVolume.

3. **PersistentVolume (PV)** — A cluster-scoped resource representing an actual storage allocation. Can be dynamically provisioned by a CSI driver or statically created by an administrator.

4. **CSI Driver** — Implements the Container Storage Interface specification. Consists of a Controller Plugin (handles provisioning, attachment, snapshots) and a Node Plugin (handles mount/unmount on the node). Deployed as pods in the cluster.

### PVC/PV Lifecycle

Understanding the lifecycle prevents incorrect recovery attempts:

```
PVC Created → Pending → Bound → (pod mounts) → In Use → (pod deleted) → Released → (if retain) | Deleted (if delete policy)

PV Lifecycle:
Available → Bound → Released → Available (if recycle) | Deleted (if delete)
```

Stuck states and their causes:
- **PVC Pending** — No matching PV, StorageClass not found, provisioner not running, topology mismatch, capacity unavailable
- **PVC Terminating** — Finalizer `kubernetes.io/pvc-protection` still set (pod still using the PVC)
- **PV Released** — PVC was deleted but PV has `Retain` policy; needs manual cleanup before rebinding
- **PV Failed** — Recycle/delete operation failed
- **Pod ContainerCreating** (with volume mount) — Volume not yet attached/mounted, permission issue, node affinity conflict

## Diagnosing PVC Stuck in Pending

### Step 1: Identify the Root Cause Category

```bash
# Get the stuck PVC details
kubectl describe pvc my-pvc -n production

# Look for events — they almost always tell you the exact problem:
# "no persistent volumes available for this claim and no storage class is set"
# "storageclass.storage.k8s.io "fast-ssd" not found"
# "waiting for first consumer to be created before binding"
# "failed to provision volume with StorageClass "fast-ssd": ..."
# "node is not scheduled yet"
```

### StorageClass Not Found

```bash
# Check available StorageClasses
kubectl get storageclasses

# Check which StorageClass the PVC is requesting
kubectl get pvc my-pvc -n production -o jsonpath='{.spec.storageClassName}'

# Common issue: PVC has no storageClassName and cluster has no default StorageClass
kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}{end}'
# If no line shows "true", there is no default StorageClass

# Set a default StorageClass
kubectl patch storageclass standard \
  -p '{"metadata": {"annotations": {"storageclass.kubernetes.io/is-default-class": "true"}}}'
```

### CSI Provisioner Not Running

```bash
# Find the CSI driver name from the StorageClass
kubectl get storageclass fast-ssd -o jsonpath='{.provisioner}'
# e.g., ebs.csi.aws.com or disk.csi.azure.com or pd.csi.storage.gke.io

# Check the CSI controller pods
kubectl get pods -n kube-system | grep csi
kubectl get pods -A | grep -i "csi\|provisioner"

# Check CSI controller logs for provisioning errors
kubectl logs -n kube-system deployment/ebs-csi-controller -c csi-provisioner | tail -30
kubectl logs -n kube-system deployment/ebs-csi-controller -c ebs-plugin | tail -30

# Common CSI provisioner errors:
# "failed to provision volume: ...AccessDenied..." → IAM permissions
# "failed to provision volume: ...RequestExpired..." → Time sync issue
# "storageclass parameter ... is invalid" → Wrong StorageClass parameters
# "exceeded quota" → ResourceQuota limiting PVC creation

# Check ResourceQuotas
kubectl get resourcequota -n production
kubectl describe resourcequota -n production
```

### Topology Constraints and Zone Issues

```bash
# Check if the StorageClass uses WaitForFirstConsumer binding mode
kubectl get storageclass fast-ssd \
  -o jsonpath='{.volumeBindingMode}'
# WaitForFirstConsumer means PVC stays Pending until a pod is scheduled

# Check if the pod is also stuck (it should be if WaitForFirstConsumer is set)
kubectl get pods -n production | grep pending

# For zone-restricted volumes, check node labels match the topology
kubectl get nodes --show-labels | grep topology
# Look for: topology.kubernetes.io/zone=us-east-1a

# Check if all nodes in the required zone have capacity
# For AWS EBS:
kubectl get nodes -l topology.kubernetes.io/zone=us-east-1a -o wide

# If a StatefulSet pod is stuck because the PVC can only attach in zone-A
# but all zone-A nodes are full, you need to scale zone-A node group
```

### Capacity and Resource Constraints

```bash
# For block storage (EBS, Persistent Disk, Azure Disk), check quota
# AWS: check EBS volume limits per region
aws service-quotas get-service-quota \
  --service-code ebs \
  --quota-code L-D18FCD1D  # gp3 storage quota

# Check cloud provider capacity in the specific zone
# Often visible in CSI controller logs:
kubectl logs -n kube-system deployment/ebs-csi-controller -c ebs-plugin \
  | grep -i "insufficient\|capacity\|quota"

# For NFS/CephFS (dynamic provisioning):
kubectl logs -n rook-ceph deployment/rook-ceph-operator | grep -i "provision\|error"
```

## PV Stuck in Released State

When a PVC is deleted but the StorageClass has `reclaimPolicy: Retain`, the PV enters the `Released` state. A `Released` PV cannot be automatically rebound to a new PVC:

```bash
# Check released PVs
kubectl get pv | grep Released

# Get details on why it won't rebind
kubectl describe pv pvc-abc123-def456

# Option 1: Delete and let the CSI driver reprovision
# (Safe if data is not needed)
kubectl delete pv pvc-abc123-def456

# Option 2: Manually patch PV to make it Available for rebinding
# This removes the claimRef, making the PV bindable to a new PVC
# WARNING: The old PVC's data is still on the volume — a new PVC binding
# this PV will see the old data
kubectl patch pv pvc-abc123-def456 \
  -p '{"spec":{"claimRef":null}}'

# Option 3: Create a new PVC that explicitly references this PV
# This is the safest way to rebind a released PV to a specific PVC
cat << 'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: reclaim-my-data
  namespace: production
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
  storageClassName: fast-ssd
  volumeName: pvc-abc123-def456   # Explicitly reference the released PV
EOF

# Patch the PV to set the new PVC as its claimRef
kubectl patch pv pvc-abc123-def456 -p '{
  "spec": {
    "claimRef": {
      "apiVersion": "v1",
      "kind": "PersistentVolumeClaim",
      "name": "reclaim-my-data",
      "namespace": "production"
    }
  }
}'
```

## Volume Mount Failures

### Pod Stuck in ContainerCreating

```bash
# Describe the pod — events section contains the volume mount error
kubectl describe pod my-pod -n production

# Common volume mount events:
# "Unable to attach or mount volumes: ... timed out waiting for the condition"
# "MountVolume.SetUp failed for volume ... : mount failed: ..."
# "Unable to attach or mount volumes: ... AttachVolume.Attach failed: ..."
# "MountVolume.MountDevice failed for volume ... : fstype: ... is not supported"

# Check kubelet logs on the node where the pod is scheduled
NODE=$(kubectl get pod my-pod -n production -o jsonpath='{.spec.nodeName}')
kubectl get events -n production --field-selector involvedObject.name=my-pod

# SSH to the node or use a privileged debug pod
kubectl debug node/${NODE} -it --image=ubuntu
# Inside the node debug container:
journalctl -u kubelet -f | grep -i "volume\|mount\|attach"
```

### FSGroup and Permission Issues

```bash
# Pod runs as non-root but the mounted volume has wrong permissions
# Symptom: "Permission denied" when writing to the volume
# Check the pod's fsGroup setting
kubectl get pod my-pod -n production \
  -o jsonpath='{.spec.securityContext.fsGroup}'

# The volume is owned by root (gid 0) but the pod runs as gid 10001
# Kubernetes will chown the volume root to the fsGroup setting on mount
# This can be very slow for large filesystems

# Use fsGroupChangePolicy to control this behavior
cat << 'EOF'
spec:
  securityContext:
    fsGroup: 10001
    fsGroupChangePolicy: "OnRootMismatch"  # Only chown if root dir ownership differs
    # Alternative: "Always" (always chown — safe but slow for large volumes)
EOF

# Explicitly set ownership in the Dockerfile instead
# FROM ubuntu:22.04
# RUN chown -R 10001:10001 /data
# This avoids the runtime chown overhead entirely
```

### NFS Mount Failures

```bash
# For NFS volumes, check mount options and server connectivity
# Check if NFS server is reachable from the node
NODE=$(kubectl get pod my-pod -n production -o jsonpath='{.spec.nodeName}')
kubectl run nfs-debug \
  --rm -it \
  --image=nicolaka/netshoot \
  --restart=Never \
  --overrides="{\"spec\":{\"nodeName\":\"${NODE}\",\"hostNetwork\":true}}" \
  -- bash

# Inside the debug pod:
# Test NFS server connectivity
showmount -e <nfs-server-ip>
nc -zv <nfs-server-ip> 2049

# Try manual mount to get detailed error
mount -t nfs <nfs-server-ip>:/exports/data /mnt
# Common NFS errors:
# "No such file or directory" → Export path doesn't exist
# "Permission denied" → Export not configured for this client IP
# "Connection refused" → NFS ports blocked by firewall
# "Stale file handle" → NFS server was rebooted without proper unmount

# Check NFS mount options in StorageClass or PV
kubectl get storageclass nfs-storage -o yaml | grep -A5 parameters
kubectl get pv pvc-abc123 -o yaml | grep -A5 mountOptions
```

### iSCSI Volume Mount Issues

```bash
# Check iSCSI daemon status on node
systemctl status iscsid

# Discover targets
iscsiadm -m discovery -t sendtargets -p <iscsi-server-ip>

# Check session status
iscsiadm -m session

# Common iSCSI issues:
# CHAP authentication failure → verify credentials in Secret
# Target not discovered → check network/firewall between node and iSCSI server
# Multiple nodes trying to mount RWO volume → multi-attach error

# Check the iSCSI Secret
kubectl get secret iscsi-credentials -n production -o yaml
```

## CSI Driver Debugging

### Understanding CSI Driver Architecture

```bash
# CSI drivers consist of two components:
# 1. Controller Plugin (runs as Deployment) — handles provisioning, snapshots, attachment
# 2. Node Plugin (runs as DaemonSet) — handles mount/unmount on each node

# Find CSI driver components
kubectl get csidrivers
kubectl get pods -A | grep csi

# Typical CSI driver structure (AWS EBS example):
# kube-system/ebs-csi-controller-xxx     → Controller plugin (Deployment)
# kube-system/ebs-csi-node-xxx           → Node plugin (DaemonSet)

# Check CSI node registration
kubectl get csinodes
kubectl describe csinode worker-01

# View installed CSI drivers
kubectl get csidrivers -o wide
```

### Debugging CSI Controller Plugin

```bash
# Check controller plugin logs — handles provisioning and attachment
CSI_CONTROLLER=$(kubectl get pods -n kube-system \
  -l app=ebs-csi-controller \
  -o jsonpath='{.items[0].metadata.name}')

# The controller pod has multiple containers:
kubectl get pod ${CSI_CONTROLLER} -n kube-system \
  -o jsonpath='{.spec.containers[*].name}'
# Typical containers: ebs-plugin, csi-provisioner, csi-attacher,
#                     csi-snapshotter, csi-resizer, liveness-probe

# Check provisioner logs (handles PVC→PV creation)
kubectl logs -n kube-system ${CSI_CONTROLLER} -c csi-provisioner | tail -50

# Check attacher logs (handles Volume Attachment)
kubectl logs -n kube-system ${CSI_CONTROLLER} -c csi-attacher | tail -50

# Check the main CSI plugin logs
kubectl logs -n kube-system ${CSI_CONTROLLER} -c ebs-plugin | tail -50

# Check VolumeAttachment objects (represent attachment to a node)
kubectl get volumeattachments

# Check a specific VolumeAttachment
kubectl describe volumeattachment csi-abc123def456
# If AttachmentMetadata shows error, it will appear here

# Force delete a stuck VolumeAttachment (use with caution)
kubectl delete volumeattachment csi-abc123def456
```

### Debugging CSI Node Plugin

```bash
# The node plugin handles mount/unmount operations on each node
CSI_NODE_POD=$(kubectl get pods -n kube-system \
  -l app=ebs-csi-node \
  --field-selector spec.nodeName=worker-01 \
  -o jsonpath='{.items[0].metadata.name}')

kubectl logs -n kube-system ${CSI_NODE_POD} -c ebs-plugin | tail -50

# Node plugin requires privileged access to mount volumes
# Check if the node plugin pod is privileged
kubectl get pod ${CSI_NODE_POD} -n kube-system \
  -o jsonpath='{.spec.containers[0].securityContext.privileged}'
# Must be: true

# Check node plugin host path mounts
kubectl get pod ${CSI_NODE_POD} -n kube-system \
  -o yaml | grep -A5 "hostPath"

# Verify the CSI socket is accessible
kubectl exec -n kube-system ${CSI_NODE_POD} -c ebs-plugin -- \
  ls -la /csi/csi.sock

# Check node plugin RBAC permissions
kubectl get clusterrolebinding | grep csi
kubectl get clusterrole ebs-csi-node-role -o yaml
```

### Investigating VolumeAttachment Failures

```bash
# List all VolumeAttachments and their status
kubectl get volumeattachments -o wide

# Check for stuck attachments (AttachError or DetachError)
kubectl get volumeattachments \
  -o json | jq '.items[] | select(.status.attachError != null or .status.detachError != null) |
    {name: .metadata.name, error: .status.attachError, node: .spec.nodeName}'

# For AWS EBS — verify the instance can attach the volume
# (Check AWS Console or CLI for volume state)
VOLUME_ID=$(kubectl get pv <pv-name> \
  -o jsonpath='{.spec.csi.volumeHandle}')
aws ec2 describe-volumes --volume-ids ${VOLUME_ID} \
  --query 'Volumes[0].{State:State,Attachments:Attachments}'

# Common AWS EBS attachment issues:
# "can only be attached to one instance" → Multi-attach error for RWO
# "instance type does not support EBS optimization" → instance type mismatch
# "volume is in an invalid state" → volume is in error state in AWS
# "availability zone mismatch" → node is in us-east-1b, volume is in us-east-1a
```

## Multi-Attach Errors for RWO Volumes

Multi-Attach errors occur when a `ReadWriteOnce` volume is already attached to one node and Kubernetes attempts to attach it to another node:

```bash
# Symptom in pod events:
# "Multi-Attach error for volume ... Volume is already exclusively attached
#  to one node and can't be attached to another"

# Find the node currently holding the volume
kubectl get volumeattachments \
  -o json | jq '.items[] | select(.spec.source.persistentVolumeName == "<pv-name>") |
    {node: .spec.nodeName, attached: .status.attached}'

# This typically happens when:
# 1. Old pod on node-A hasn't fully terminated (stuck in Terminating)
# 2. Kubernetes scheduled new pod on node-B before the volume detached

# Find the old pod that's stuck
kubectl get pods -n production --all-namespaces | grep Terminating

# Check why the pod is stuck in Terminating
kubectl describe pod stuck-pod-xxx -n production

# Option 1: Force delete the stuck pod (safe if the pod has been stuck for > 5 min)
kubectl delete pod stuck-pod-xxx -n production \
  --force \
  --grace-period=0

# This causes the VolumeAttachment to be removed, allowing the new node to attach
# WARNING: Verify the old pod is truly not running before force-deleting
# Check on the old node:
kubectl debug node/worker-01 -it --image=ubuntu -- crictl ps | grep stuck-pod
```

### Preventing Multi-Attach Errors

```bash
# Use PodDisruptionBudgets carefully — they can prevent pod termination
kubectl get pdb -n production

# Set terminationGracePeriodSeconds appropriately
# Databases should have 60-120s to flush data
# HTTP servers should have 30-60s to drain connections
cat << 'EOF'
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
      - name: database
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "pg_ctl stop -m fast"]
EOF

# Use StatefulSets with proper updateStrategy for databases
cat << 'EOF'
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  # StatefulSets ensure only one pod per PVC at a time
EOF
```

## Volume Expansion Failures

```bash
# Resize a PVC
kubectl patch pvc my-pvc -n production \
  -p '{"spec": {"resources": {"requests": {"storage": "50Gi"}}}}'

# Check expansion status
kubectl describe pvc my-pvc -n production | grep -A5 "Conditions:"
# Waiting for: FileSystemResizePending (requires pod restart to expand FS)
# or: Resizing (CSI driver is working)
# or: ControllerExpansionFailed (CSI driver reported an error)

# Check if the StorageClass allows expansion
kubectl get storageclass fast-ssd \
  -o jsonpath='{.allowVolumeExpansion}'
# Must be: true

# Check CSI resizer logs
kubectl logs -n kube-system deployment/ebs-csi-controller -c csi-resizer | tail -30

# For filesystem resize to take effect, the pod must be restarted
# (or volume must be unmounted and remounted)
kubectl rollout restart deployment/my-app -n production

# After pod restart, verify the filesystem was expanded
kubectl exec -n production my-pod -- df -h /data

# If filesystem resize still hasn't happened, check:
kubectl exec -n production my-pod -- \
  lsblk  # verify block device is expanded

# Manually trigger filesystem resize (last resort)
kubectl exec -n production my-pod -- \
  resize2fs /dev/xvda  # for ext4
# or
kubectl exec -n production my-pod -- \
  xfs_growfs /data     # for xfs
```

## Force-Deleting Stuck PVCs and PVs

### Understanding Finalizers

Kubernetes uses finalizers to prevent premature deletion of resources that still have dependencies. A PVC stuck in `Terminating` has the `kubernetes.io/pvc-protection` finalizer because a pod is still using it.

```bash
# Check finalizers on a stuck PVC
kubectl get pvc my-pvc -n production -o yaml | grep -A5 finalizers

# Expected finalizer:
# finalizers:
# - kubernetes.io/pvc-protection

# Find which pods are still using this PVC
kubectl get pods -n production -o json | \
  jq -r '.items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName == "my-pvc") |
    .metadata.name'

# If the pod is stuck in Terminating:
kubectl get pods -n production | grep Terminating

# Force delete the pod first, then the PVC can be deleted normally
kubectl delete pod stuck-pod -n production \
  --force \
  --grace-period=0

# Wait a few seconds for the PVC to finish terminating
kubectl get pvc my-pvc -n production

# If PVC is still stuck after pod is gone, remove the finalizer manually
# ONLY do this if you are certain no pod is using the PVC
kubectl patch pvc my-pvc -n production \
  -p '{"metadata":{"finalizers":null}}'
```

### Force-Deleting Stuck PVs

```bash
# PV stuck in Terminating (after PVC deletion with Retain policy manual cleanup)
kubectl get pv pvc-abc123 -o yaml | grep -A5 finalizers

# PV finalizer: kubernetes.io/pv-protection
# Remove finalizer to force deletion
kubectl patch pv pvc-abc123 \
  -p '{"metadata":{"finalizers":null}}'

# After removing the finalizer, delete the PV
kubectl delete pv pvc-abc123

# Note: This does NOT delete the underlying storage volume in the cloud provider
# The EBS volume, Azure Disk, etc. will still exist and must be deleted manually
# AWS:
VOLUME_ID=$(kubectl get pv pvc-abc123 \
  -o jsonpath='{.spec.csi.volumeHandle}' 2>/dev/null || \
  kubectl get pv pvc-abc123 \
  -o jsonpath='{.spec.awsElasticBlockStore.volumeID}')
aws ec2 delete-volume --volume-id ${VOLUME_ID}

# GCP:
DISK_NAME=$(kubectl get pv pvc-abc123 \
  -o jsonpath='{.spec.gcePersistentDisk.pdName}')
gcloud compute disks delete ${DISK_NAME} --zone=us-central1-a
```

## Node-Level Storage Debugging

### Investigating Mount Points on a Node

```bash
# View all active mounts related to Kubernetes
# On the node (or via privileged debug pod):
mount | grep kubernetes
mount | grep pods

# Check the Kubernetes volume directory structure
ls -la /var/lib/kubelet/pods/
# Each pod has a UUID directory with its volumes

# Find mount points for a specific pod
POD_UID=$(kubectl get pod my-pod -n production \
  -o jsonpath='{.metadata.uid}')
ls -la /var/lib/kubelet/pods/${POD_UID}/volumes/

# Check if a specific device is mounted
mount | grep /dev/xvdb

# For stuck unmount (device busy):
fuser -m /dev/xvdb          # Show processes using the device
fuser -mk /dev/xvdb         # Kill processes using the device (careful!)
umount /var/lib/kubelet/pods/${POD_UID}/volumes/kubernetes.io~csi/pvc-abc123/mount
```

### Diagnosing IO Errors and Data Corruption

```bash
# Check kernel logs for storage errors on the node
dmesg | grep -i "error\|fail\|i/o error\|ext4\|xfs" | tail -50
journalctl -k | grep -i "blk_update_request\|I/O error"

# Check for filesystem errors
dmesg | grep -E "EXT4-fs error|XFS.*error"

# Test storage performance (I/O wait causing apparent hangs)
iostat -x 1 5  # Look for %util near 100%
iotop -ao      # Show processes with highest I/O

# Run filesystem check (requires unmounting volume first)
# For ext4:
fsck.ext4 -n /dev/xvdb   # -n = no-op, just check

# For xfs:
xfs_repair -n /dev/xvdb  # -n = dry run

# Check for bad blocks
badblocks -v /dev/xvdb

# For NFS: check for stale file handles
# Symptoms: read-only filesystem, I/O error on NFS
mount | grep nfs
# Remount NFS volume:
umount -l /mnt/nfs-volume  # Lazy unmount
mount -t nfs <server>:/export /mnt/nfs-volume
```

### Rook-Ceph Storage Debugging

```bash
# Check overall Ceph cluster health
kubectl exec -n rook-ceph \
  $(kubectl get pods -n rook-ceph -l app=rook-ceph-tools \
    -o jsonpath='{.items[0].metadata.name}') \
  -- ceph status

# Check OSD (Object Storage Daemon) status
kubectl exec -n rook-ceph \
  $(kubectl get pods -n rook-ceph -l app=rook-ceph-tools \
    -o jsonpath='{.items[0].metadata.name}') \
  -- ceph osd status

# Check pool usage
kubectl exec -n rook-ceph \
  $(kubectl get pods -n rook-ceph -l app=rook-ceph-tools \
    -o jsonpath='{.items[0].metadata.name}') \
  -- ceph df

# Check placement groups
kubectl exec -n rook-ceph \
  $(kubectl get pods -n rook-ceph -l app=rook-ceph-tools \
    -o jsonpath='{.items[0].metadata.name}') \
  -- ceph pg stat

# If Ceph is in HEALTH_WARN or HEALTH_ERR:
kubectl exec -n rook-ceph \
  $(kubectl get pods -n rook-ceph -l app=rook-ceph-tools \
    -o jsonpath='{.items[0].metadata.name}') \
  -- ceph health detail

# Common Rook-Ceph issues:
# "HEALTH_WARN too many PGs per OSD" → increase OSD count or reduce pools
# "HEALTH_WARN 1 osds down" → OSD pod crashed; check OSD pod logs
# "HEALTH_ERR 3 osds are down" → Likely data unavailability

# Check CephBlockPool and CephFilesystem
kubectl get cephblockpool -n rook-ceph
kubectl get cephfilesystem -n rook-ceph

# Check Rook operator logs
kubectl logs -n rook-ceph deployment/rook-ceph-operator | tail -30
```

## VolumeSnapshot Troubleshooting

```bash
# Check VolumeSnapshot status
kubectl get volumesnapshots -n production
kubectl describe volumesnapshot my-snapshot -n production

# Check VolumeSnapshotContent (cluster-scoped)
kubectl get volumesnapshotcontents

# Check snapshot controller logs
kubectl logs -n kube-system \
  deployment/snapshot-controller | tail -30

# Check CSI snapshotter sidecar
kubectl logs -n kube-system \
  deployment/ebs-csi-controller -c csi-snapshotter | tail -30

# Common snapshot errors:
# "VolumeSnapshotContent not found" → snapshot was deleted at cloud provider level
# "failed to take snapshot" → CSI driver error (check snapshotter logs)
# "snapshot is not ready" → snapshot operation in progress

# Create a PVC from a VolumeSnapshot
cat << 'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: restore-from-snapshot
  namespace: production
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
  storageClassName: fast-ssd
  dataSource:
    name: my-snapshot
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
EOF
```

## Data Recovery Procedures

### Recovering Data from a Released PV

```bash
# When a PVC is accidentally deleted with data still needed:

# 1. Find the PV (should be in Released state with Retain policy)
kubectl get pv | grep Released

# 2. Immediately patch to prevent automated cleanup
kubectl patch pv pvc-abc123 \
  -p '{"spec": {"persistentVolumeReclaimPolicy": "Retain"}}'

# 3. Create a recovery PVC that binds to this specific PV
cat << 'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-recovery-pvc
  namespace: production
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  storageClassName: fast-ssd
  volumeName: pvc-abc123  # Reference specific PV
EOF

# 4. Patch PV to clear old claimRef
kubectl patch pv pvc-abc123 \
  -p '{"spec": {"claimRef": {"namespace": "production", "name": "data-recovery-pvc"}}}'

# 5. Create a recovery pod to access the data
cat << 'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: data-recovery
  namespace: production
spec:
  containers:
  - name: recovery
    image: ubuntu:22.04
    command: ["sleep", "infinity"]
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: data-recovery-pvc
EOF

# 6. Access the data
kubectl exec -it -n production data-recovery -- bash
# Inside: ls /data, cp files to backup location, etc.

# 7. Copy files out of the pod
kubectl cp production/data-recovery:/data ./backup/
```

### Recovering from Filesystem Corruption

```bash
# If a pod reports filesystem errors:
# "read-only file system"
# "input/output error"
# "filesystem is not clean"

# 1. Stop the pod (scale down deployment or delete pod)
kubectl scale deployment my-database -n production --replicas=0

# 2. Wait for pod to terminate and volume to detach
kubectl get pvc my-pvc -n production
kubectl get volumeattachments | grep pvc-abc123

# 3. Create a repair pod on the same node as the volume
# For cloud volumes, the volume must be in the same AZ
NODE=$(kubectl get pv pvc-abc123 \
  -o jsonpath='{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}' 2>/dev/null || echo "any")

cat << 'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: fsrepair
  namespace: production
spec:
  nodeName: worker-01   # Must be same AZ as the volume
  containers:
  - name: repair
    image: ubuntu:22.04
    command: ["sleep", "infinity"]
    securityContext:
      privileged: true    # Required for fsck
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: my-pvc
EOF

# 4. Run fsck on the volume (unmount first if possible)
kubectl exec -it -n production fsrepair -- bash
# Inside:
umount /data                  # Unmount if possible
fsck.ext4 -y /dev/xvdb        # Run filesystem check (auto-fix mode)
mount /dev/xvdb /data         # Remount
ls /data                      # Verify data is accessible

# 5. Restore normal operation
kubectl delete pod fsrepair -n production
kubectl scale deployment my-database -n production --replicas=1
```

## Comprehensive Storage Health Check Script

```bash
#!/bin/bash
# k8s-storage-health.sh — comprehensive storage health check

set -euo pipefail

NAMESPACE="${1:-production}"

echo "=== Kubernetes Storage Health Check: ${NAMESPACE} ==="
echo ""

echo "=== 1. PVC Status ==="
echo "--- Pending PVCs ---"
kubectl get pvc -n ${NAMESPACE} --field-selector status.phase=Pending
echo ""
echo "--- Terminating PVCs ---"
kubectl get pvc -n ${NAMESPACE} | grep Terminating || echo "None"
echo ""

echo "=== 2. PV Status ==="
echo "--- Available PVs (unbound) ---"
kubectl get pv --field-selector status.phase=Available
echo ""
echo "--- Released PVs ---"
kubectl get pv --field-selector status.phase=Released
echo ""
echo "--- Failed PVs ---"
kubectl get pv --field-selector status.phase=Failed || echo "None"
echo ""

echo "=== 3. VolumeAttachments ==="
kubectl get volumeattachments | head -20
echo ""
echo "--- VolumeAttachment errors ---"
kubectl get volumeattachments -o json | \
  jq -r '.items[] | select(.status.attachError != null) |
    "ERROR: \(.metadata.name) on \(.spec.nodeName): \(.status.attachError.message)"' || \
  echo "No attachment errors"
echo ""

echo "=== 4. CSI Driver Health ==="
kubectl get csidrivers
echo ""
echo "--- CSI Controller Pods ---"
kubectl get pods -A -l app.kubernetes.io/component=csi-driver 2>/dev/null || \
  kubectl get pods -kube-system | grep csi
echo ""

echo "=== 5. StorageClasses ==="
kubectl get storageclasses -o wide
echo ""

echo "=== 6. Pods with Volume Issues ==="
kubectl get pods -n ${NAMESPACE} | grep -v Running | grep -v Completed || \
  echo "All pods running"
echo ""

echo "=== 7. Recent Storage Events ==="
kubectl get events -n ${NAMESPACE} \
  --field-selector reason=FailedMount,reason=FailedAttachVolume,reason=ProvisioningFailed \
  --sort-by='.lastTimestamp' | tail -20

echo ""
echo "=== Health check complete ==="
```

## Conclusion

Kubernetes storage troubleshooting requires a methodical approach that matches the failure to the correct layer of the storage stack. PVC pending issues trace to StorageClass configuration, provisioner health, or capacity constraints. Volume mount failures point to node-level issues, fsGroup permission problems, or network storage connectivity. CSI driver failures require examining both the controller and node plugin logs together with the VolumeAttachment API objects.

The most critical operational practice for storage reliability is choosing the correct reclaim policy. Use `Delete` for ephemeral data where automatic cleanup is preferred. Use `Retain` for any storage containing data that must survive PVC deletion — then build operational procedures around managing Released PVs. Pair this with regular testing of snapshot and restore procedures before incidents occur, so recovery paths are validated and understood before they are urgently needed.
