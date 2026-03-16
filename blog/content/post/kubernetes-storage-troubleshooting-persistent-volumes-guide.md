---
title: "Kubernetes Storage Troubleshooting: Persistent Volumes, CSI, and StatefulSets"
date: 2027-03-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "PersistentVolume", "CSI", "Troubleshooting"]
categories: ["Kubernetes", "Storage", "Troubleshooting"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes storage troubleshooting covering PV/PVC lifecycle debugging, CSI driver diagnostics, StatefulSet volume ordering, stuck terminating PVCs, data migration between storage classes, fsGroup permissions, and capacity monitoring with Prometheus."
more_link: "yes"
url: "/kubernetes-storage-troubleshooting-persistent-volumes-guide/"
---

Storage failures in Kubernetes are uniquely dangerous — unlike networking issues that typically manifest as degraded performance, storage failures can cause data loss, StatefulSet deadlocks, and workloads stuck in a non-schedulable state for hours. Understanding the full PV/PVC lifecycle, CSI driver operation, and common failure modes is essential for any team running stateful workloads in production.

This guide covers the complete troubleshooting toolkit for Kubernetes storage: debugging every phase of the PV/PVC lifecycle, diagnosing CSI driver failures, resolving StatefulSet volume ordering issues, cleaning up stuck Terminating PVCs, migrating data between storage classes, and monitoring capacity with Prometheus.

<!--more-->

## PV/PVC Lifecycle Overview

Understanding the state machine is the foundation of storage troubleshooting:

**PVC States**: `Pending` → `Bound` → `Lost` (when the bound PV disappears)

**PV States**:
- `Available` — exists, not bound to any PVC
- `Bound` — bound to a PVC
- `Released` — the bound PVC was deleted; PV still exists but has a `claimRef` pointing to the old PVC
- `Failed` — the dynamic provisioner failed or the volume reclamation failed

**Critical**: A PV in `Released` state is **not** automatically available for new PVCs. The `claimRef` must be cleared manually before the PV returns to `Available`.

## Diagnosing PVC Stuck in Pending

### Step 1: Check the PVC Events

```bash
kubectl describe pvc myapp-data -n production
```

The `Events` section contains the most informative diagnostic messages:

- `no persistent volumes available for this claim and no storage class is set` — no StorageClass and no matching PV
- `waiting for first consumer to be created before binding` — StorageClass has `volumeBindingMode: WaitForFirstConsumer`; binding waits until a pod referencing the PVC is scheduled
- `failed to provision volume with StorageClass "fast-ssd": error creating volume: ...` — provisioner-side error

### Step 2: Verify StorageClass Configuration

```bash
# List available StorageClasses
kubectl get storageclass

# Check if the default StorageClass is set
kubectl get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}'

# Describe the StorageClass
kubectl describe storageclass fast-ssd
```

### Step 3: Check CSI Provisioner Logs

```bash
# Find the CSI driver pods for the StorageClass provisioner
PROVISIONER="ebs.csi.aws.com"
kubectl get pods -A -o json | \
  jq -r --arg prov "$PROVISIONER" \
  '.items[] | select(.spec.containers[].args[]? | test($prov)) |
   "\(.metadata.namespace)/\(.metadata.name)"'

# Check provisioner logs
kubectl -n kube-system logs -l app=ebs-csi-controller \
  -c csi-provisioner --tail=100 | \
  grep -E "ERROR|WARN|provision|failed"

# Check CSI node plugin logs on the target node
NODE="node03"
CSI_NODE_POD=$(kubectl -n kube-system get pod \
  -l app=ebs-csi-node \
  --field-selector spec.nodeName="${NODE}" \
  -o name)
kubectl -n kube-system logs "$CSI_NODE_POD" \
  -c ebs-plugin --tail=100 | \
  grep -E "ERROR|WARN|mount|attach"
```

### Step 4: Verify CSI Driver Registration

```bash
# Check CSIDriver object exists and is configured correctly
kubectl get csidriver

# Check CSI node registration on target node
kubectl get csinodes node03 -o yaml

# Verify kubelet can communicate with CSI node plugin socket
kubectl -n kube-system exec "${CSI_NODE_POD}" -c ebs-plugin -- \
  ls -la /var/lib/kubelet/plugins/ebs.csi.aws.com/
```

### WaitForFirstConsumer Binding Mode

When a StorageClass uses `volumeBindingMode: WaitForFirstConsumer`, PVCs remain `Pending` until a pod that references them is scheduled. This is the correct behavior for topology-aware provisioning (e.g., EBS volumes must be in the same AZ as the node). If the PVC is Pending but no pod is trying to use it, the PVC will remain in Pending indefinitely.

```bash
# Check if binding mode is causing the Pending state
kubectl get storageclass fast-ssd \
  -o jsonpath='{.volumeBindingMode}'

# If WaitForFirstConsumer, check if the pod is scheduled
kubectl get pod -n production -l app=myapp -o wide

# Check if the pod is Pending due to taint/affinity issues
kubectl describe pod myapp-0 -n production | \
  grep -A20 "Events"
```

## CSI Driver Pod Health Checks

```bash
# Check all CSI driver controller pods
kubectl get pods -A -l app.kubernetes.io/component=controller \
  -o wide | grep -i csi

# Check CSI sidecar containers (attacher, provisioner, resizer, snapshotter)
CSI_CONTROLLER="ebs-csi-controller-5d9c7b8d6-xk4pj"
kubectl -n kube-system describe pod "$CSI_CONTROLLER" | \
  grep -E "Container|Ready|Restart"

# Check CSI driver objects
kubectl get volumeattachments -o wide

# Check if there are any stuck VolumeAttachments
kubectl get volumeattachments -o json | \
  jq '.items[] | select(.status.attached == false) |
    {name: .metadata.name, node: .spec.nodeName,
     attached: .status.attached, error: .status.attachError}'

# Force-delete a stuck VolumeAttachment (only after verifying the volume
# is truly detached at the cloud provider level)
ATTACHMENT_NAME=$(kubectl get volumeattachments -o json | \
  jq -r '.items[] | select(.status.attached == false) | .metadata.name' | head -1)
kubectl delete volumeattachment "${ATTACHMENT_NAME}" --grace-period=0
```

## Node Affinity Conflicts for Local Storage

Local PersistentVolumes have `nodeAffinity` rules that bind them to specific nodes. If the node is removed or replaced, pods that reference local PVs become permanently unschedulable.

```bash
# Check PV node affinity
kubectl get pv local-pv-node01 -o yaml | \
  grep -A15 nodeAffinity

# Check if the required node exists
kubectl get node node01

# If node is removed, the PV and PVC must be manually cleaned up
# Step 1: Identify the PVC bound to this PV
kubectl get pvc -A -o json | \
  jq -r '.items[] | select(.spec.volumeName == "local-pv-node01") |
    "\(.metadata.namespace)/\(.metadata.name)"'

# Step 2: If the data is not needed, delete PVC and PV
kubectl delete pvc myapp-data -n production
kubectl delete pv local-pv-node01

# Step 3: If data needs recovery, exec into the node
# (or use a recovery pod with hostPath) before deleting
```

## Volume Expansion Failures

Volume expansion requires both the StorageClass to have `allowVolumeExpansion: true` and the underlying storage system to support online resize.

```bash
# Check if StorageClass supports expansion
kubectl get storageclass fast-ssd \
  -o jsonpath='{.allowVolumeExpansion}'

# Request expansion by editing PVC
kubectl patch pvc myapp-data -n production \
  -p '{"spec": {"resources": {"requests": {"storage": "50Gi"}}}}'

# Monitor expansion status
kubectl get pvc myapp-data -n production -w

# Check for expansion errors
kubectl describe pvc myapp-data -n production | \
  grep -A5 -i "Conditions\|resiz\|expand"
```

### When Expansion Fails

```bash
# Check CSI resizer logs
kubectl -n kube-system logs -l app=ebs-csi-controller \
  -c csi-resizer --tail=100 | \
  grep -E "ERROR|WARN|resize"

# Check if the filesystem was resized inside the pod after volume expansion
kubectl exec -n production myapp-0 -- df -h /data

# For XFS or ext4: manually trigger filesystem resize if not automatic
kubectl exec -n production myapp-0 -- \
  resize2fs /dev/$(ls /dev/disk/by-id/ | head -1)

# For XFS
kubectl exec -n production myapp-0 -- \
  xfs_growfs /data
```

## ReadWriteMany vs ReadWriteOnce Pitfalls

**ReadWriteOnce (RWO)** volumes can only be mounted by pods on a single node. Deploying a Deployment (not a StatefulSet) with multiple replicas against an RWO PVC causes all but one pod to be Pending.

```bash
# Check access mode
kubectl get pvc myapp-data -n production \
  -o jsonpath='{.spec.accessModes}'

# Check which pod has the volume mounted
kubectl get pods -n production -o json | \
  jq -r '.items[] |
    select(.spec.volumes[].persistentVolumeClaim.claimName == "myapp-data") |
    "\(.metadata.name) on \(.spec.nodeName)"'

# Check for the "Multi-Attach error"
kubectl describe pod myapp-replica-2 -n production | \
  grep -A3 "Multi-Attach"
```

### Solutions for RWO Multi-Replica Scenarios

- Convert to **StatefulSet** with a `volumeClaimTemplate` — each replica gets its own PVC
- Use an RWX storage class (NFS, CephFS, EFS, Azure Files) if shared access is genuinely required
- Use a sidecar sync pattern where one writer pod replicates data via rsync or a message queue

## StatefulSet Volume Ordering Issues

StatefulSets create PVCs in ordinal order (`pod-0` before `pod-1` etc.) and will not start `pod-1` until `pod-0` is Running and Ready. Storage failures on `pod-0` cascade to halt the entire StatefulSet.

```bash
# Check StatefulSet pod status
kubectl get pods -n production -l app=mydb -o wide

# The pod stuck in Init/Pending reveals which pod's volume is failing
kubectl describe pod mydb-0 -n production

# Check all PVCs for the StatefulSet
kubectl get pvc -n production -l app=mydb

# Check if pod-0's PVC is stuck
kubectl describe pvc data-mydb-0 -n production

# Check StatefulSet events
kubectl describe statefulset mydb -n production | \
  grep -A20 "Events"

# Check if volumeClaimTemplate storage class exists
kubectl get statefulset mydb -n production \
  -o jsonpath='{.spec.volumeClaimTemplates[*].spec.storageClassName}'
```

### StatefulSet Stuck After Node Failure

When a StatefulSet pod's node becomes unreachable (NotReady for an extended period), the pod is not automatically deleted because Kubernetes waits for node reconciliation to prevent data corruption. This causes the StatefulSet to be stuck — the replacement pod cannot be scheduled while the old pod object exists.

```bash
# Check if the old pod is in Terminating or Unknown state
kubectl get pod mydb-0 -n production

# Force-delete the stuck pod (only safe if the node is confirmed down
# and the volume is confirmed not mounted on the old node)
kubectl delete pod mydb-0 -n production --grace-period=0 --force

# Verify the PVC is now Released or Bound to the new pod
kubectl get pvc data-mydb-0 -n production
```

## PVC Stuck in Terminating State

A PVC stuck in `Terminating` has a `kubernetes.io/pvc-protection` finalizer that prevents deletion while pods are still using it.

```bash
# Check finalizers
kubectl get pvc myapp-data -n production \
  -o jsonpath='{.metadata.finalizers}'

# Check which pods are still using the PVC
kubectl get pods -n production -o json | \
  jq -r '.items[] |
    select(.spec.volumes[]?.persistentVolumeClaim.claimName == "myapp-data") |
    .metadata.name'

# If the pod is already deleted but PVC is still stuck, remove the finalizer
kubectl patch pvc myapp-data -n production \
  -p '{"metadata":{"finalizers":null}}'

# Alternatively using kubectl edit
kubectl edit pvc myapp-data -n production
# Remove the line: - kubernetes.io/pvc-protection
```

### PV Stuck in Released State

A PV in `Released` state has a `claimRef` pointing to its previous PVC. To make it available for a new PVC:

```bash
# Option 1: Clear claimRef to return PV to Available
kubectl patch pv pvc-abc123def456 \
  -p '{"spec":{"claimRef":null}}'

# Option 2: Manually create a PVC that matches the PV's claimRef
# (useful when you want to rebind a specific PV to a new PVC)
kubectl patch pvc new-pvc -n production \
  -p '{"spec":{"volumeName":"pvc-abc123def456"}}'
```

## Orphaned PV Cleanup

After mass PVC deletions (namespace teardown, cluster migration), PVs with `Reclaim: Retain` policy accumulate in `Released` state.

```bash
#!/bin/bash
# cleanup-released-pvs.sh
# Lists and optionally deletes orphaned PVs in Released state.

set -euo pipefail

DRY_RUN="${1:-true}"

echo "=== Orphaned PVs in Released State ==="
RELEASED_PVS=$(kubectl get pv -o json | \
  jq -r '.items[] | select(.status.phase == "Released") |
    "\(.metadata.name) \(.spec.storageClassName) \(.spec.capacity.storage)"')

if [[ -z "$RELEASED_PVS" ]]; then
  echo "No released PVs found."
  exit 0
fi

echo "$RELEASED_PVS" | while read -r pv_name storage_class capacity; do
  echo "PV: $pv_name | Class: $storage_class | Size: $capacity"
  if [[ "$DRY_RUN" == "false" ]]; then
    echo "Deleting $pv_name..."
    kubectl delete pv "$pv_name"
  fi
done

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "Dry run — pass 'false' as argument to actually delete."
fi
```

## Data Migration Between Storage Classes

Migrating data from one StorageClass to another (e.g., gp2 to gp3, NFS to Ceph) requires careful orchestration to avoid data loss.

```bash
#!/bin/bash
# migrate-pvc.sh
# Migrates data from a source PVC to a new PVC in a different StorageClass.
# Requires the application pod to be scaled down during the copy.

set -euo pipefail

SOURCE_PVC="$1"
TARGET_STORAGE_CLASS="$2"
NAMESPACE="${3:-default}"

SOURCE_SIZE=$(kubectl get pvc "$SOURCE_PVC" -n "$NAMESPACE" \
  -o jsonpath='{.spec.resources.requests.storage}')

echo "Creating target PVC (${TARGET_STORAGE_CLASS}, ${SOURCE_SIZE})..."
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${SOURCE_PVC}-migrated
  namespace: ${NAMESPACE}
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ${TARGET_STORAGE_CLASS}
  resources:
    requests:
      storage: ${SOURCE_SIZE}
EOF

kubectl wait --for=condition=Bound \
  pvc/${SOURCE_PVC}-migrated \
  -n "$NAMESPACE" \
  --timeout=300s

echo "Launching data copy job..."
cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: pvc-migration-${SOURCE_PVC}
  namespace: ${NAMESPACE}
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: copy
          image: alpine:3.19
          command:
            - sh
            - -c
            - |
              apk add --no-cache rsync
              rsync -avz --progress /source/ /target/
              echo "Migration complete. Source size:"
              du -sh /source/
              echo "Target size:"
              du -sh /target/
          volumeMounts:
            - name: source
              mountPath: /source
              readOnly: true
            - name: target
              mountPath: /target
      volumes:
        - name: source
          persistentVolumeClaim:
            claimName: ${SOURCE_PVC}
            readOnly: true
        - name: target
          persistentVolumeClaim:
            claimName: ${SOURCE_PVC}-migrated
EOF

kubectl wait --for=condition=complete \
  job/pvc-migration-${SOURCE_PVC} \
  -n "$NAMESPACE" \
  --timeout=3600s

echo "Data migration complete."
echo "Update your application to use: ${SOURCE_PVC}-migrated"
```

## fsGroup Permission Problems

The `fsGroup` security context field changes the GID of all files in mounted volumes to match the specified group. This can cause issues when:

- The container process does not run as the specified GID
- The volume already has data with different ownership
- The storage system does not support `chown` (some NFS configurations)

```bash
# Check fsGroup setting on a pod
kubectl get pod myapp-0 -n production \
  -o jsonpath='{.spec.securityContext}'

# Check file ownership inside the pod
kubectl exec -n production myapp-0 -- ls -la /data/

# Check if fsGroup chown is causing slow pod startup (large volumes)
kubectl describe pod myapp-0 -n production | \
  grep -A5 "Reason\|Message\|chown"

# Disable fsGroup chown for large volumes (Kubernetes 1.20+)
# Add to pod spec:
securityContext:
  fsGroup: 1000
  fsGroupChangePolicy: "OnRootMismatch"  # Only chown if owner doesn't match
```

### NFS Permission Issues

NFS volumes often have root_squash enabled, which maps container root (UID 0) to the nobody user. This causes `Permission denied` errors when containers run as root.

```bash
# Check NFS mount options on the node
kubectl exec -n production myapp-0 -- \
  mount | grep nfs

# Test write permissions as the container's UID
kubectl exec -n production myapp-0 -- \
  touch /data/test-write

# Check NFS server exports configuration
# On NFS server:
showmount -e nfs-server.internal
cat /etc/exports | grep -v "^#"

# Work around root_squash: run container as non-root user
# that matches the NFS directory owner
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
```

## EBS-Specific Issues

### Volume Attachment Timeout

EBS volumes can only be attached to one EC2 instance at a time. If a pod moves to a new node, the old attachment must be explicitly detached first.

```bash
# Check VolumeAttachment status
kubectl get volumeattachments -o wide

# Check for detach error
kubectl get volumeattachment -o json | \
  jq '.items[] | select(.status.detachError != null) |
    {name: .metadata.name, error: .status.detachError}'

# Check AWS CloudTrail for API errors (if available)
# Common errors: InvalidVolume.NotFound, VolumeInUse

# If the old node is gone and the attachment is stuck:
STUCK_ATTACHMENT=$(kubectl get volumeattachments -o json | \
  jq -r '.items[] | select(.status.detachError != null) | .metadata.name' | head -1)
kubectl delete volumeattachment "${STUCK_ATTACHMENT}"
```

### EBS Multi-Attach (io1/io2 with RWX)

EBS Multi-Attach only works with io1/io2 volume types and requires application-level coordination (e.g., clustered filesystem). Enabling it on standard gp3 volumes is not supported.

```bash
# Check volume type via AWS CLI
aws ec2 describe-volumes \
  --volume-ids vol-0abc123def456 \
  --query 'Volumes[*].{Type:VolumeType,MultiAttach:MultiAttachEnabled}'
```

## Ceph/Rook-Specific Issues

```bash
# Check Ceph cluster health
kubectl -n rook-ceph exec -it \
  $(kubectl -n rook-ceph get pod -l app=rook-ceph-tools -o name) \
  -- ceph status

# Check OSD status
kubectl -n rook-ceph exec -it \
  $(kubectl -n rook-ceph get pod -l app=rook-ceph-tools -o name) \
  -- ceph osd status

# Check for slow I/O operations
kubectl -n rook-ceph exec -it \
  $(kubectl -n rook-ceph get pod -l app=rook-ceph-tools -o name) \
  -- ceph health detail | grep -i slow

# Check pool utilization
kubectl -n rook-ceph exec -it \
  $(kubectl -n rook-ceph get pod -l app=rook-ceph-tools -o name) \
  -- ceph df

# Check RBD image list
kubectl -n rook-ceph exec -it \
  $(kubectl -n rook-ceph get pod -l app=rook-ceph-tools -o name) \
  -- rbd ls replicapool

# Check if a specific RBD image is in use (watchers)
kubectl -n rook-ceph exec -it \
  $(kubectl -n rook-ceph get pod -l app=rook-ceph-tools -o name) \
  -- rbd status replicapool/csi-vol-abc123
```

## Velero Backup Validation

Before migrating or deleting production PVCs, validate that backups are healthy.

```bash
# Check Velero backup status
velero backup get

# Check the most recent successful backup
velero backup get --output json | \
  jq '.items | sort_by(.status.completionTimestamp) |
    last | {name: .metadata.name, status: .status.phase,
    completed: .status.completionTimestamp}'

# Check if PVCs are included in the backup
velero backup describe <backup-name> --details | \
  grep PersistentVolumeClaim

# Perform a backup restore dry run
velero restore create --from-backup <backup-name> \
  --namespace-mappings production:production-restored \
  --dry-run

# Validate a specific PVC is restorable
velero restore create pvc-validation \
  --from-backup <backup-name> \
  --include-resources persistentvolumeclaims,persistentvolumes \
  --selector app=mydb
```

## Capacity Monitoring with Prometheus

### kubelet Volume Stats Metrics

The kubelet exposes per-PVC capacity metrics that are scraped by Prometheus:

```promql
# PVC usage percentage
(
  kubelet_volume_stats_used_bytes
  /
  kubelet_volume_stats_capacity_bytes
) * 100

# PVCs above 80% capacity
(
  kubelet_volume_stats_used_bytes
  /
  kubelet_volume_stats_capacity_bytes
) * 100 > 80

# Available inodes percentage
(
  kubelet_volume_stats_inodes_free
  /
  kubelet_volume_stats_inodes
) * 100

# PVCs that will be full in less than 6 hours (linear prediction)
predict_linear(
  kubelet_volume_stats_available_bytes[2h],
  6 * 3600
) < 0
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-storage-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: kubernetes-storage
      interval: 60s
      rules:
        - alert: PersistentVolumeClaimHighUsage
          expr: |
            (
              kubelet_volume_stats_used_bytes
              /
              kubelet_volume_stats_capacity_bytes
            ) * 100 > 80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is {{ $value | humanize }}% full"
            description: "PVC {{ $labels.persistentvolumeclaim }} in namespace {{ $labels.namespace }} is at {{ $value | humanize }}% capacity."

        - alert: PersistentVolumeClaimCriticalUsage
          expr: |
            (
              kubelet_volume_stats_used_bytes
              /
              kubelet_volume_stats_capacity_bytes
            ) * 100 > 95
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} critically full"
            description: "PVC {{ $labels.persistentvolumeclaim }} is at {{ $value | humanize }}% capacity. Immediate action required."

        - alert: PersistentVolumeClaimFillingSoon
          expr: |
            predict_linear(
              kubelet_volume_stats_available_bytes[2h],
              4 * 3600
            ) < 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} predicted to be full in 4 hours"
            description: "Based on the current fill rate, PVC {{ $labels.persistentvolumeclaim }} will be full in approximately 4 hours."

        - alert: PersistentVolumeClaimLowInodes
          expr: |
            (
              kubelet_volume_stats_inodes_free
              /
              kubelet_volume_stats_inodes
            ) * 100 < 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Low inodes on PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }}"
            description: "PVC {{ $labels.persistentvolumeclaim }} has only {{ $value | humanize }}% inodes remaining."

        - alert: PersistentVolumeClaimPending
          expr: |
            kube_persistentvolumeclaim_status_phase{phase="Pending"} == 1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} stuck in Pending"
            description: "PVC {{ $labels.persistentvolumeclaim }} has been Pending for more than 10 minutes."

        - alert: PersistentVolumeLost
          expr: |
            kube_persistentvolumeclaim_status_phase{phase="Lost"} == 1
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is Lost"
            description: "The backing PV for PVC {{ $labels.persistentvolumeclaim }} has been lost. Data may be inaccessible."
```

## Comprehensive Storage Diagnostics Script

```bash
#!/bin/bash
# k8s-storage-diag.sh
# Prints a comprehensive storage health report for a namespace.

set -euo pipefail

NAMESPACE="${1:-default}"

echo "=== Kubernetes Storage Diagnostics: $NAMESPACE ==="
echo "Date: $(date)"
echo ""

echo "=== PVC Status Summary ==="
kubectl get pvc -n "$NAMESPACE" \
  -o custom-columns=\
"NAME:.metadata.name,STATUS:.status.phase,VOLUME:.spec.volumeName,\
CLASS:.spec.storageClassName,CAPACITY:.spec.resources.requests.storage,\
ACCESS:.spec.accessModes[0]"
echo ""

echo "=== Stuck PVCs (Pending > 5 min) ==="
kubectl get pvc -n "$NAMESPACE" -o json | \
  jq -r '.items[] |
    select(.status.phase == "Pending") |
    "\(.metadata.name) since \(.metadata.creationTimestamp)"'
echo ""

echo "=== PVCs in Terminating State ==="
kubectl get pvc -n "$NAMESPACE" -o json | \
  jq -r '.items[] |
    select(.metadata.deletionTimestamp != null) |
    "\(.metadata.name) finalizers: \(.metadata.finalizers)"'
echo ""

echo "=== VolumeAttachment Status ==="
kubectl get volumeattachments -o json | \
  jq -r '.items[] |
    "\(.metadata.name) attached=\(.status.attached) node=\(.spec.nodeName)"' | \
  head -20
echo ""

echo "=== CSI Node Health ==="
kubectl get csinodes -o json | \
  jq -r '.items[] |
    "\(.metadata.name) drivers=\([.spec.drivers[].name] | join(","))"'
echo ""

echo "=== Recent Storage Events ==="
kubectl get events -n "$NAMESPACE" \
  --field-selector reason=FailedMount,reason=FailedAttachVolume,\
reason=ProvisioningFailed,reason=FailedBinding \
  --sort-by='.lastTimestamp' 2>/dev/null | tail -20
echo ""

echo "=== Pod Volume Mount Status ==="
kubectl get pods -n "$NAMESPACE" -o json | \
  jq -r '.items[] |
    select(.status.phase != "Succeeded") |
    "\(.metadata.name): " +
    ([.status.conditions[]? |
      select(.type == "Ready" and .status == "False") |
      .message] | join("; "))' | \
  grep -v ": $" || echo "All pods have no volume-related issues"
```

## Summary

Kubernetes storage troubleshooting requires understanding both the Kubernetes control plane (PV/PVC lifecycle, StorageClass provisioners, VolumeAttachment objects) and the underlying storage system (EBS, Ceph, NFS, local). The most common production failures — PVCs stuck in Pending due to provisioner errors, VolumeAttachments blocking pod migrations after node failures, PVCs stuck in Terminating due to active finalizers, and fsGroup permission issues — all have well-defined resolution paths once the diagnostic methodology is applied systematically. Combining Prometheus capacity alerts, regular backup validation with Velero, and the diagnostic scripts in this guide provides comprehensive visibility into storage health before problems escalate to data loss or sustained application outages.
