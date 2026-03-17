---
title: "Kubernetes Persistent Volume Expansion: CSI Volume Resizing, PVC Resize Workflow, FileSystem vs Block Mode"
date: 2032-02-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "PVC", "CSI", "Volume Expansion", "StatefulSet"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Kubernetes persistent volume expansion covering CSI driver resize capabilities, the full PVC resize workflow, online vs offline expansion, filesystem vs raw block mode resizing, StatefulSet PVC expansion, and troubleshooting resize failures."
more_link: "yes"
url: "/kubernetes-persistent-volume-expansion-csi-resize-workflow-enterprise-guide/"
---

Persistent volume expansion allows Kubernetes workloads to grow their storage without downtime, re-provisioning, or data migration. The operation involves the CSI driver, the PVC object, the PersistentVolume, and the filesystem — each of which must be expanded in sequence. This guide covers enabling expansion in StorageClass, the full resize workflow for online and offline scenarios, filesystem vs block volume differences, StatefulSet PVC expansion automation, and troubleshooting stuck resize operations.

<!--more-->

# Kubernetes Persistent Volume Expansion: Enterprise Operations Guide

## Section 1: Prerequisites and Architecture

### Components Involved in Volume Expansion

```
User edits PVC spec.resources.requests.storage
                │
                ▼
     Kubernetes API Server
                │
                ▼
  PersistentVolumeClaimController
  (sets ResizeStarted condition)
                │
                ▼
    CSI external-resizer sidecar
    (calls ControllerExpandVolume RPC)
                │
                ▼
    Cloud Provider / Storage Backend
    (expands underlying block device)
                │
                ▼
  CSI node-stage + NodeExpandVolume RPC
  (triggered when pod accesses volume)
                │
                ▼
    kubelet
    (runs resize2fs/xfs_growfs on volume)
```

### CSI Driver Requirements

The CSI driver must implement:
- `ControllerExpandVolume` — expands the block device on the storage backend
- `NodeExpandVolume` — expands the filesystem inside the node (may be optional for block volumes)

Check driver capabilities:

```bash
# Check CSI driver's volume expansion support
kubectl get csidrivers -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.volumeLifecycleModes}{"\n"}{end}'

# For EBS CSI driver
kubectl describe csidriver ebs.csi.aws.com | grep ExpandInlineVolume

# Check VolumeSnapshotContent and CSINode capabilities
kubectl get csinodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.drivers[*].nodeID}{"\n"}{end}'
```

### StorageClass Configuration

Volume expansion must be enabled in the StorageClass:

```yaml
# storageclass-expandable.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-expandable
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true   # REQUIRED for resize
reclaimPolicy: Retain
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
  kmsKeyId: arn:aws:kms:us-east-1:<account-id>:key/<key-id>
allowedTopologies:
- matchLabelExpressions:
  - key: topology.kubernetes.io/zone
    values:
    - us-east-1a
    - us-east-1b
    - us-east-1c
```

```yaml
# Other common expandable StorageClasses
---
# GKE standard-rwo
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard-rwo-expandable
provisioner: pd.csi.storage.gke.io
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: pd-balanced
  replication-type: none

---
# Azure disk
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: managed-premium-expandable
provisioner: disk.csi.azure.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  skuName: Premium_LRS
  kind: Managed
  cachingMode: ReadOnly

---
# Longhorn
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-expandable
provisioner: driver.longhorn.io
volumeBindingMode: Immediate
allowVolumeExpansion: true
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "2880"
  fromBackup: ""
  fsType: ext4
```

## Section 2: The PVC Resize Workflow

### Step 1: Check Current State

```bash
# Check PVC current capacity
kubectl -n production get pvc my-data-pvc -o json | \
  jq '{
    name: .metadata.name,
    namespace: .metadata.namespace,
    requested: .spec.resources.requests.storage,
    capacity: .status.capacity.storage,
    conditions: .status.conditions
  }'

# Check the underlying PV
PV_NAME=$(kubectl -n production get pvc my-data-pvc -o jsonpath='{.spec.volumeName}')
kubectl get pv "${PV_NAME}" -o json | \
  jq '{
    name: .metadata.name,
    capacity: .spec.capacity.storage,
    driver: .spec.csi.driver,
    volumeHandle: .spec.csi.volumeHandle,
    phase: .status.phase
  }'
```

### Step 2: Edit the PVC

Volume expansion only supports increasing the size, never decreasing:

```bash
# Method 1: kubectl edit
kubectl -n production edit pvc my-data-pvc
# Change spec.resources.requests.storage from 10Gi to 20Gi

# Method 2: kubectl patch (scripting-friendly)
kubectl -n production patch pvc my-data-pvc \
  --type merge \
  --patch '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'

# Method 3: apply a YAML
cat > /tmp/pvc-resize.yaml << 'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-data-pvc
  namespace: production
spec:
  resources:
    requests:
      storage: 20Gi
EOF
kubectl apply -f /tmp/pvc-resize.yaml
```

### Step 3: Monitor Resize Progress

```bash
# Watch PVC conditions
kubectl -n production get pvc my-data-pvc -w

# Describe for detailed status
kubectl -n production describe pvc my-data-pvc

# Look for these conditions in .status.conditions:
# - type: "Resizing" — ControllerExpandVolume is in progress
# - type: "FileSystemResizePending" — backend expanded; awaiting filesystem resize on node
# - type: "ResizeFinished" — complete (or just the new capacity appears)

# Watch events
kubectl -n production get events \
  --field-selector involvedObject.name=my-data-pvc \
  --sort-by='.lastTimestamp'
```

### Step 4: Verify Completion

```bash
# Check final capacity
kubectl -n production get pvc my-data-pvc \
  -o jsonpath='{.status.capacity.storage}'

# Verify inside the pod
kubectl -n production exec my-pod -- df -h /data
# Should show the new size
```

## Section 3: Online vs Offline Expansion

### Online Expansion (No Downtime)

Supported by most modern CSI drivers (EBS CSI >= v1.8, GCE PD CSI, Longhorn >= 1.3). The pod continues running while the volume is expanded:

```bash
# The pod does NOT need to be restarted for online expansion
# The kubelet's volume reconciliation loop detects the "FileSystemResizePending"
# condition and runs NodeExpandVolume + filesystem resize automatically

# Check kubelet logs on the node running the pod
NODE=$(kubectl -n production get pod my-pod -o jsonpath='{.spec.nodeName}')
kubectl get nodes "${NODE}" -o wide

# SSH to node and check kubelet logs
journalctl -u kubelet --since "5 minutes ago" | grep -E "resize|expand|volume"
```

### Offline Expansion (Pod Must Be Stopped)

Older drivers or non-ONLINE capable drivers require the pod to be stopped before the filesystem resize completes:

```bash
# Step 1: scale down the workload
kubectl -n production scale deployment my-deployment --replicas=0
# For StatefulSet:
kubectl -n production scale statefulset my-statefulset --replicas=0

# Wait for pods to terminate
kubectl -n production wait pod -l app=my-app --for=delete --timeout=120s

# Step 2: edit the PVC
kubectl -n production patch pvc my-data-pvc \
  --type merge \
  --patch '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'

# Step 3: wait for "FileSystemResizePending" → complete
# This happens when the pod is started and kubelet resizes the filesystem
kubectl -n production scale deployment my-deployment --replicas=1

# Step 4: verify
kubectl -n production get pvc my-data-pvc -o jsonpath='{.status.capacity.storage}'
```

## Section 4: Filesystem Mode vs Block Mode

### Filesystem Mode (Default)

Most PVCs use filesystem mode. The CSI driver mounts a formatted filesystem (ext4, xfs) into the container. Expansion runs `resize2fs` (ext4) or `xfs_growfs` (xfs) after enlarging the block device.

```yaml
# Standard filesystem-mode PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-pvc
  namespace: production
spec:
  accessModes:
  - ReadWriteOnce
  volumeMode: Filesystem   # default; can be omitted
  resources:
    requests:
      storage: 10Gi
  storageClassName: gp3-expandable
```

```bash
# Verify filesystem type after mount
kubectl -n production exec my-pod -- \
  sh -c "df -Th /data && cat /proc/mounts | grep /data"

# Manual filesystem expand verification (diagnostic)
kubectl -n production exec my-pod -- \
  sh -c "lsblk && df -h /data"
```

### Raw Block Mode

Block volumes expose the raw block device to the container without a filesystem layer. The application manages the block device directly (databases like Oracle, Cassandra's raw I/O mode, or SAN-attached volumes).

```yaml
# Block-mode PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: block-data-pvc
  namespace: production
spec:
  accessModes:
  - ReadWriteOnce
  volumeMode: Block   # raw block device; no filesystem
  resources:
    requests:
      storage: 100Gi
  storageClassName: gp3-expandable
---
# Pod using a block volume — mount as devicePath, not mountPath
apiVersion: v1
kind: Pod
metadata:
  name: block-pod
  namespace: production
spec:
  containers:
  - name: app
    image: my-db-image:latest
    volumeDevices:   # Note: volumeDevices, not volumeMounts
    - name: block-data
      devicePath: /dev/xvdb
  volumes:
  - name: block-data
    persistentVolumeClaim:
      claimName: block-data-pvc
```

### Expanding Raw Block Volumes

For block volumes, `NodeExpandVolume` is called but no filesystem resize is performed — only the block device is expanded. The application must handle the new size:

```bash
# After block volume expansion, verify the device size inside the pod
kubectl -n production exec block-pod -- \
  sh -c "blockdev --getsize64 /dev/xvdb && lsblk /dev/xvdb"

# For a database that manages its own partitions:
# The application must be notified to extend its data structures
# (e.g., ORACLE: ALTER DATABASE DATAFILE '...' RESIZE 200G)
```

## Section 5: StatefulSet PVC Expansion

StatefulSets create PVCs from `volumeClaimTemplates`. Kubernetes does not automatically resize all replicas' PVCs when you edit the StatefulSet — you must resize each PVC individually.

### Manual Resize of All StatefulSet PVCs

```bash
#!/bin/bash
# resize-statefulset-pvcs.sh
NAMESPACE="${1:?Usage: $0 <namespace> <statefulset-name> <new-size>}"
STS_NAME="${2:?Usage: $0 <namespace> <statefulset-name> <new-size>}"
NEW_SIZE="${3:?Usage: $0 <namespace> <statefulset-name> <new-size>}"

echo "Resizing all PVCs for StatefulSet ${NAMESPACE}/${STS_NAME} to ${NEW_SIZE}"

# Get all PVC names for the StatefulSet
PVCS=$(kubectl -n "${NAMESPACE}" get pvc \
  -l app="${STS_NAME}" \
  -o jsonpath='{.items[*].metadata.name}')

if [[ -z "${PVCS}" ]]; then
    # Fall back to naming convention: <pvc-template-name>-<sts-name>-<index>
    REPLICAS=$(kubectl -n "${NAMESPACE}" get statefulset "${STS_NAME}" \
        -o jsonpath='{.spec.replicas}')
    VOLUME_TEMPLATES=$(kubectl -n "${NAMESPACE}" get statefulset "${STS_NAME}" \
        -o jsonpath='{.spec.volumeClaimTemplates[*].metadata.name}')

    for template in ${VOLUME_TEMPLATES}; do
        for i in $(seq 0 $((REPLICAS - 1))); do
            PVCS="${PVCS} ${template}-${STS_NAME}-${i}"
        done
    done
fi

for pvc in ${PVCS}; do
    echo "Resizing PVC: ${pvc}"
    kubectl -n "${NAMESPACE}" patch pvc "${pvc}" \
        --type merge \
        --patch "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"${NEW_SIZE}\"}}}}"
done

echo "Waiting for all PVCs to show updated capacity..."
for pvc in ${PVCS}; do
    while true; do
        capacity=$(kubectl -n "${NAMESPACE}" get pvc "${pvc}" \
            -o jsonpath='{.status.capacity.storage}' 2>/dev/null)
        if [[ "${capacity}" == "${NEW_SIZE}" ]]; then
            echo "  ${pvc}: resized to ${capacity}"
            break
        fi
        echo "  ${pvc}: current=${capacity}, waiting..."
        sleep 5
    done
done
echo "All PVCs resized."
```

### Updating the StatefulSet volumeClaimTemplate

After resizing all existing PVCs, update the StatefulSet's `volumeClaimTemplates` so new replicas start at the correct size. This requires deleting and recreating the StatefulSet (or using Kubernetes 1.27+ PVC resize support):

```bash
# Kubernetes 1.27+: patch volumeClaimTemplates directly
kubectl -n production patch statefulset my-statefulset \
  --type json \
  --patch '[
    {
      "op": "replace",
      "path": "/spec/volumeClaimTemplates/0/spec/resources/requests/storage",
      "value": "20Gi"
    }
  ]'

# Kubernetes < 1.27: delete and recreate StatefulSet
# (Pods are NOT deleted — cascade=orphan)
kubectl -n production delete statefulset my-statefulset --cascade=orphan
# Re-apply the StatefulSet manifest with the updated size
kubectl -n production apply -f statefulset-updated.yaml
```

## Section 6: Troubleshooting Resize Failures

### Symptom: PVC Stuck in "Resizing" Condition

```bash
# Check PVC conditions
kubectl -n production describe pvc my-data-pvc | grep -A10 "Conditions"

# Typical stuck state:
# Conditions:
#   Type                      Status  ...  Message
#   ----                      ------  ...  -------
#   Resizing                  True    ...  waiting for user to (re-)start a pod

# Check CSI driver logs
kubectl -n kube-system logs -l app=ebs-csi-controller \
  -c csi-resizer --tail=100 | grep -E "ERROR|resize|expand"

# Check events on the PVC
kubectl -n production get events \
  --field-selector involvedObject.name=my-data-pvc
```

### Symptom: "FileSystemResizePending" for a Long Time

The block device was expanded by the CSI driver, but the filesystem resize has not been triggered:

```bash
# Check the PVC for FileSystemResizePending
kubectl -n production get pvc my-data-pvc -o jsonpath='{.status.conditions[*]}'

# This condition clears when the pod that uses the volume is (re-)scheduled
# Trigger by restarting the pod
kubectl -n production rollout restart deployment my-deployment

# OR: delete and recreate the pod (StatefulSet)
kubectl -n production delete pod my-pod-0
# StatefulSet will recreate the pod, and kubelet runs NodeExpandVolume

# Monitor kubelet logs
NODE=$(kubectl -n production get pod my-pod-0 -o jsonpath='{.spec.nodeName}')
ssh "${NODE}" journalctl -u kubelet -f | grep -E "resize|expand|NodeExpandVolume"
```

### Symptom: "resize volume: exceeded maximum allowed volume size"

Cloud provider has a maximum volume size. For AWS gp3, this is 16 TiB:

```bash
# AWS EBS size limits:
# gp2: 1 GiB – 16 TiB
# gp3: 1 GiB – 16 TiB
# io1: 4 GiB – 16 TiB
# io2: 4 GiB – 64 TiB

# If you need > 16 TiB, consider:
# 1. Switch to io2 Block Express (up to 64 TiB)
# 2. Use a filesystem that spans multiple PVCs (Ceph RBD, Portworx)
# 3. Use NFS-backed PVCs (EFS, NetApp ONTAP) which have no size limits
```

### Symptom: "cannot resize an already resized volume"

This happens when the cloud volume was already resized but Kubernetes was not notified:

```bash
# For AWS EBS: check actual volume size via AWS CLI
EBS_VOL_ID=$(kubectl get pv "${PV_NAME}" -o jsonpath='{.spec.csi.volumeHandle}')
aws ec2 describe-volumes --volume-ids "${EBS_VOL_ID}" \
  --query 'Volumes[0].Size'

# If cloud size > Kubernetes PV size, patch the PV
kubectl patch pv "${PV_NAME}" \
  --type merge \
  --patch '{"spec":{"capacity":{"storage":"20Gi"}}}'

# Then patch the PVC to clear the resize condition
kubectl -n production patch pvc my-data-pvc \
  --type merge \
  --patch '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
```

### Symptom: ext4 or xfs resize fails inside pod

```bash
# Check dmesg on the node for filesystem errors
NODE=$(kubectl -n production get pod my-pod -o jsonpath='{.spec.nodeName}')
ssh "${NODE}" dmesg | grep -E "ext4|xfs|resize|error" | tail -20

# For ext4: manually run fsck if filesystem is corrupted
# (requires stopping the pod first)
kubectl -n production scale deployment my-deployment --replicas=0

# Find the device
kubectl get pv "${PV_NAME}" -o jsonpath='{.spec.csi.volumeHandle}'
# Attach to another instance and run fsck
e2fsck -f /dev/disk/by-id/nvme-...

# For xfs: check and repair
xfs_repair /dev/disk/by-id/nvme-...
```

## Section 7: Bulk PVC Expansion Script

```bash
#!/bin/bash
# bulk-pvc-resize.sh
# Finds all PVCs below a threshold and resizes them

set -euo pipefail

NAMESPACE="${1:-production}"
MIN_SIZE_GI="${2:-10}"
NEW_SIZE="${3:-50Gi}"
DRY_RUN="${4:-true}"

echo "=== Bulk PVC Resize ==="
echo "Namespace: ${NAMESPACE}"
echo "Resizing PVCs currently <= ${MIN_SIZE_GI}Gi to ${NEW_SIZE}"
echo "Dry run: ${DRY_RUN}"
echo ""

kubectl -n "${NAMESPACE}" get pvc -o json | \
  jq -r '.items[] | select(
    (.spec.resources.requests.storage | rtrimstr("Gi") | tonumber) <= '"${MIN_SIZE_GI}"'
  ) | .metadata.name' | \
  while read -r pvc; do
    current=$(kubectl -n "${NAMESPACE}" get pvc "${pvc}" \
        -o jsonpath='{.spec.resources.requests.storage}')
    echo "PVC: ${pvc} (current: ${current})"

    if [[ "${DRY_RUN}" == "true" ]]; then
        echo "  [DRY RUN] Would resize to ${NEW_SIZE}"
    else
        kubectl -n "${NAMESPACE}" patch pvc "${pvc}" \
            --type merge \
            --patch "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"${NEW_SIZE}\"}}}}"
        echo "  Resized to ${NEW_SIZE}"
    fi
  done
```

## Section 8: Prometheus Monitoring for PVC Expansion

```promql
# PVCs that have been resized (capacity > requested)
kube_persistentvolumeclaim_status_capacity_storage_bytes
/
kube_persistentvolumeclaim_resource_requests_storage_bytes
> 1

# PVCs near capacity (>= 80% used)
(
  kubelet_volume_stats_used_bytes
  /
  kubelet_volume_stats_capacity_bytes
) >= 0.80

# Alert: PVC almost full
- alert: PVCAlmostFull
  expr: |
    (
      kubelet_volume_stats_used_bytes
      /
      kubelet_volume_stats_capacity_bytes
    ) >= 0.85
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "PVC almost full: {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }}"
    description: "PVC is {{ $value | humanizePercentage }} full"

# Alert: PVC critically full
- alert: PVCCriticallyFull
  expr: |
    (
      kubelet_volume_stats_used_bytes
      /
      kubelet_volume_stats_capacity_bytes
    ) >= 0.95
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "PVC critically full: {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }}"

# PVC stuck in FileSystemResizePending
- alert: PVCResizePending
  expr: |
    kube_persistentvolumeclaim_status_condition{
      condition="FileSystemResizePending",
      status="true"
    } == 1
  for: 30m
  labels:
    severity: warning
  annotations:
    summary: "PVC filesystem resize pending: {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }}"
    description: "Restart the pod using this PVC to trigger filesystem resize"
```

### Auto-Expand with VPA-like Automation

```bash
#!/bin/bash
# auto-expand-pvcs.sh
# Monitors PVC usage and auto-expands before hitting capacity

NAMESPACE="${1:-production}"
THRESHOLD=80          # Expand when usage > 80%
EXPANSION_PERCENT=50  # Increase size by 50%

kubectl -n "${NAMESPACE}" get pvc -o jsonpath='{.items[*].metadata.name}' | \
  tr ' ' '\n' | while read -r pvc; do

    # Get current capacity from kubelet metrics
    used=$(kubectl -n "${NAMESPACE}" exec -it \
        "$(kubectl -n "${NAMESPACE}" get pods -o jsonpath='{.items[0].metadata.name}')" -- \
        sh -c "df -B1 /data | tail -1 | awk '{print \$3}'" 2>/dev/null || echo 0)

    capacity=$(kubectl -n "${NAMESPACE}" get pvc "${pvc}" \
        -o jsonpath='{.status.capacity.storage}')

    echo "PVC ${pvc}: ${used} used of ${capacity}"
  done
```

## Section 9: StorageClass Migration

When you need to change StorageClass (e.g., migrate from gp2 to gp3), you cannot simply resize — you must provision a new PVC:

```bash
#!/bin/bash
# migrate-storageclass.sh
# Migrates data from an old PVC to a new PVC on a different StorageClass

OLD_PVC="my-data-pvc"
NEW_PVC="my-data-pvc-gp3"
NAMESPACE="production"
NEW_SIZE="50Gi"
NEW_STORAGECLASS="gp3-expandable"

# Step 1: Create new PVC
cat > /tmp/new-pvc.yaml << EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${NEW_PVC}
  namespace: ${NAMESPACE}
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: ${NEW_STORAGECLASS}
  resources:
    requests:
      storage: ${NEW_SIZE}
EOF
kubectl apply -f /tmp/new-pvc.yaml

# Step 2: Run a migration pod to copy data
cat > /tmp/migrate-pod.yaml << EOF
apiVersion: v1
kind: Pod
metadata:
  name: pvc-migrate
  namespace: ${NAMESPACE}
spec:
  restartPolicy: Never
  containers:
  - name: migrate
    image: alpine:3.18
    command:
    - sh
    - -c
    - |
      echo "Starting migration..."
      apk add -q rsync
      rsync -avz --progress /source/ /dest/
      echo "Migration complete. Source checksum:"
      find /source -type f -exec sha256sum {} \; | sort > /tmp/source-checksums.txt
      echo "Dest checksum:"
      find /dest -type f -exec sha256sum {} \; | sort > /tmp/dest-checksums.txt
      diff /tmp/source-checksums.txt /tmp/dest-checksums.txt && echo "Checksums match!" || echo "MISMATCH!"
    volumeMounts:
    - name: source
      mountPath: /source
      readOnly: true
    - name: dest
      mountPath: /dest
  volumes:
  - name: source
    persistentVolumeClaim:
      claimName: ${OLD_PVC}
  - name: dest
    persistentVolumeClaim:
      claimName: ${NEW_PVC}
EOF
kubectl apply -f /tmp/migrate-pod.yaml

# Wait for completion
kubectl -n "${NAMESPACE}" wait pod/pvc-migrate \
  --for=condition=Succeeded \
  --timeout=3600s

# Check logs
kubectl -n "${NAMESPACE}" logs pvc-migrate

# Step 3: Update the workload to use the new PVC (manual update to Deployment/StatefulSet)
echo "Update your Deployment/StatefulSet to reference ${NEW_PVC} and redeploy"
```

## Section 10: Best Practices Summary

```bash
# Operational checklist for PVC expansion

# 1. Verify StorageClass has allowVolumeExpansion: true
kubectl get storageclass -o json | \
  jq '.items[] | {name: .metadata.name, expand: .allowVolumeExpansion}'

# 2. Check CSI driver supports ControllerExpandVolume
kubectl describe csidriver | grep -A3 "expand"

# 3. Monitor PVC usage proactively (80% = expand warning)
kubectl top pods --sort-by=memory

# 4. For StatefulSets: resize each PVC individually first,
#    then update volumeClaimTemplates

# 5. For raw block volumes: verify application handles new size
#    The application must be notified to use the additional space

# 6. Keep expansion requests idempotent:
#    Re-running the same resize patch is safe if new size >= current

# 7. Never reduce PVC size — Kubernetes rejects it
kubectl -n production patch pvc my-pvc \
  --patch '{"spec":{"resources":{"requests":{"storage":"5Gi"}}}}'
# Error: spec.resources.requests.storage: Forbidden: field can not be less than previous value
```

## Summary

Kubernetes persistent volume expansion is a mature feature when used with CSI drivers that support it. Key operational points:

- **allowVolumeExpansion: true** in the StorageClass is the first gate; verify this before filing a resize ticket
- **Online expansion** (pod continues running) works with EBS CSI, GCE PD CSI, Longhorn, and most modern drivers; the kubelet's volume reconciliation loop handles the filesystem resize automatically
- **Offline expansion** (pod must be stopped) is needed for older drivers or specific volume types; stopping the pod triggers `NodeExpandVolume` on startup
- **Raw block volumes** expand the device but require the application to handle the new size — no automatic filesystem expansion occurs
- **StatefulSet PVC expansion** requires individually patching each PVC, then optionally updating the `volumeClaimTemplates` for future replicas
- **Stuck resizes** are usually resolved by restarting the pod that uses the volume, forcing `NodeExpandVolume` to run
- **Prometheus alerts** on `kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.85` provide the lead time needed to expand before a workload runs out of disk space
