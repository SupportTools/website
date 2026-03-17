---
title: "Kubernetes Persistent Volume Claim Expansion: Online Resize for StatefulSets"
date: 2029-03-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "PVC", "StatefulSets", "CSI", "Operations"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete operational guide to expanding Kubernetes PVCs online for StatefulSets, covering CSI driver requirements, StorageClass configuration, file system resize triggers, and safe procedures for production databases."
more_link: "yes"
url: "/kubernetes-pvc-expansion-online-resize-statefulsets/"
---

Running out of disk space in a production StatefulSet is a high-severity incident — and historically, expanding the volume required deleting and recreating pods. Since Kubernetes 1.11, the API has supported volume expansion, and since 1.16, online (without pod restart) file system expansion became stable. However, the path from "the edit command ran" to "the file system reports the new size" involves multiple components, each of which can silently stall. This post covers the complete expansion flow, driver compatibility matrix, failure modes, and safe procedures for database StatefulSets.

<!--more-->

## How Volume Expansion Works

Volume expansion traverses four distinct phases:

1. **PVC Edit**: User increases `spec.resources.requests.storage`
2. **CSI ControllerExpandVolume**: The CSI driver expands the underlying block device (EBS volume, GCE PD, Azure Disk) via the cloud provider API
3. **CSI NodeExpandVolume**: The kubelet calls the CSI driver on the node to resize the block device as seen by the node
4. **File System Resize**: The kubelet (via `resize2fs`, `xfs_growfs`, or similar) expands the file system to fill the newly available block device

Steps 2 through 4 are automated when `allowVolumeExpansion: true` is set on the StorageClass and the CSI driver supports `EXPAND_VOLUME` capability.

## Prerequisites and StorageClass Configuration

### Verifying CSI Driver Support

```bash
# List CSI drivers and their capabilities
kubectl get csidrivers -o custom-columns='NAME:.metadata.name,EXPAND:.spec.requiresRepublish'

# Check if a specific driver advertises VolumeExpansion capability
kubectl get csidriver ebs.csi.aws.com -o jsonpath='{.spec}'

# Verify StorageClass allows expansion
kubectl get storageclass gp3-encrypted -o yaml
```

### StorageClass with Expansion Enabled

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-encrypted
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "6000"
  throughput: "250"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123def456"
  csi.storage.k8s.io/fstype: ext4
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true  # Required for PVC expansion
```

### Checking Existing StorageClass Compatibility

```bash
# Find StorageClasses that do NOT allow expansion
kubectl get storageclass -o json | \
  jq -r '.items[] |
    select(.allowVolumeExpansion != true) |
    [.metadata.name, (.provisioner // "unknown")] | join("\t")'

# Patch an existing StorageClass to allow expansion (cannot restrict again)
kubectl patch storageclass gp2 \
  --type=merge \
  -p '{"allowVolumeExpansion": true}'
```

Note: Enabling `allowVolumeExpansion` on an existing StorageClass is non-destructive. Once enabled, it cannot be disabled without creating a new StorageClass.

## Expanding a PVC on a Running Pod (Online Expansion)

### Standard Procedure

```bash
# Step 1: Verify current PVC status
kubectl get pvc postgres-data-postgres-0 -n databases -o yaml | \
  grep -A5 'spec:\|status:' | head -20

# Step 2: Check the actual disk usage inside the pod first
kubectl exec -n databases postgres-0 -- df -h /var/lib/postgresql/data

# Step 3: Expand the PVC (increase from 100Gi to 200Gi)
kubectl patch pvc postgres-data-postgres-0 \
  -n databases \
  --type=merge \
  -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# Step 4: Watch PVC conditions during expansion
kubectl get pvc postgres-data-postgres-0 -n databases -w
# NAME                          STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS    AGE
# postgres-data-postgres-0      Bound    pvc-a1b2c3d4-e5f6-7890-abcd-ef1234567890   100Gi      RWO            gp3-encrypted   45d
# postgres-data-postgres-0      Bound    pvc-a1b2c3d4-e5f6-7890-abcd-ef1234567890   100Gi      RWO            gp3-encrypted   45d
# postgres-data-postgres-0      Bound    pvc-a1b2c3d4-e5f6-7890-abcd-ef1234567890   200Gi      RWO            gp3-encrypted   45d
```

### Monitoring Expansion Progress via PVC Conditions

```bash
# Check PVC conditions for expansion status
kubectl get pvc postgres-data-postgres-0 -n databases \
  -o jsonpath='{.status.conditions}' | jq .

# Example output during ControllerExpand phase:
# [
#   {
#     "lastProbeTime": null,
#     "lastTransitionTime": "2029-03-03T14:22:01Z",
#     "message": "Waiting for user to (re-)start a pod to finish file system resize of volume on node.",
#     "status": "True",
#     "type": "FileSystemResizePending"
#   }
# ]
```

When `FileSystemResizePending` is `True`, the block device has been resized by the CSI controller but the file system has not yet been expanded. This typically resolves automatically when the pod accesses the volume, but some CSI drivers require the pod to be restarted.

### Verifying Online Expansion Completed

```bash
# After expansion, verify inside the pod
kubectl exec -n databases postgres-0 -- df -h /var/lib/postgresql/data
# Filesystem      Size  Used Avail Use% Mounted on
# /dev/nvme1n1    197G   85G  112G  44% /var/lib/postgresql/data

# Check the underlying block device size
kubectl exec -n databases postgres-0 -- lsblk
# NAME    MAJ:MIN RM  SIZE RO TYPE MOUNTPOINT
# nvme1n1 259:1    0  200G  0 disk /var/lib/postgresql/data

# Verify no FileSystemResizePending condition remains
kubectl get pvc postgres-data-postgres-0 -n databases \
  -o jsonpath='{.status.conditions[?(@.type=="FileSystemResizePending")].status}'
```

## Expanding All PVCs in a StatefulSet

When a StatefulSet has multiple replicas, each replica has its own PVC. For ordered expansion:

```bash
#!/bin/bash
# expand-statefulset-pvcs.sh — safely expand all PVCs in a StatefulSet
set -euo pipefail

NAMESPACE="${1:?Usage: $0 <namespace> <statefulset-name> <new-size>}"
STS_NAME="${2:?}"
NEW_SIZE="${3:?}"

# Get the volumeClaimTemplate name(s) from the StatefulSet
TEMPLATES=$(kubectl get sts "${STS_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.volumeClaimTemplates[*].metadata.name}')

# Get all replicas
REPLICAS=$(kubectl get sts "${STS_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')

echo "Expanding StatefulSet: ${STS_NAME}"
echo "Namespace: ${NAMESPACE}"
echo "Replicas: ${REPLICAS}"
echo "New size: ${NEW_SIZE}"
echo "VolumeClaimTemplates: ${TEMPLATES}"
echo ""

for template in ${TEMPLATES}; do
    for ((i=0; i<REPLICAS; i++)); do
        PVC_NAME="${template}-${STS_NAME}-${i}"

        echo -n "Expanding ${PVC_NAME}... "

        CURRENT=$(kubectl get pvc "${PVC_NAME}" -n "${NAMESPACE}" \
          -o jsonpath='{.spec.resources.requests.storage}')

        if [[ "${CURRENT}" == "${NEW_SIZE}" ]]; then
            echo "Already at ${NEW_SIZE}, skipping."
            continue
        fi

        kubectl patch pvc "${PVC_NAME}" \
          -n "${NAMESPACE}" \
          --type=merge \
          -p "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"${NEW_SIZE}\"}}}}"

        echo "Done (was ${CURRENT})."
    done
done

echo ""
echo "Waiting for all expansions to complete (checking every 10s)..."
while true; do
    PENDING=0
    for template in ${TEMPLATES}; do
        for ((i=0; i<REPLICAS; i++)); do
            PVC_NAME="${template}-${STS_NAME}-${i}"
            CONDITION=$(kubectl get pvc "${PVC_NAME}" -n "${NAMESPACE}" \
              -o jsonpath='{.status.conditions[?(@.type=="FileSystemResizePending")].status}' 2>/dev/null)
            if [[ "${CONDITION}" == "True" ]]; then
                PENDING=$((PENDING + 1))
                echo "  ${PVC_NAME}: FileSystemResizePending"
            fi
        done
    done

    if [[ "${PENDING}" -eq 0 ]]; then
        echo "All PVCs expanded successfully."
        break
    fi

    echo "${PENDING} PVC(s) still pending file system resize. Retrying in 10s..."
    sleep 10
done
```

## StatefulSet VolumeClaimTemplate Expansion Problem

A critical limitation: **the `volumeClaimTemplates` field in a StatefulSet is immutable**. Changing it does not retroactively resize existing PVCs — it only affects newly created replicas.

To resize existing PVCs AND update the StatefulSet template:

```bash
#!/bin/bash
# update-sts-pvc-template.sh — expand PVCs and update StatefulSet template
set -euo pipefail

NAMESPACE="databases"
STS_NAME="postgres"
TEMPLATE_NAME="postgres-data"
NEW_SIZE="200Gi"

# Step 1: Export the current StatefulSet spec
kubectl get sts "${STS_NAME}" -n "${NAMESPACE}" -o json > /tmp/sts-backup.json
echo "Backup saved to /tmp/sts-backup.json"

# Step 2: Expand all existing PVCs (as shown in previous script)
REPLICAS=$(kubectl get sts "${STS_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')

for ((i=0; i<REPLICAS; i++)); do
    kubectl patch pvc "${TEMPLATE_NAME}-${STS_NAME}-${i}" \
      -n "${NAMESPACE}" \
      --type=merge \
      -p "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"${NEW_SIZE}\"}}}}"
done

# Step 3: Delete StatefulSet WITHOUT deleting pods (--cascade=orphan)
# This allows updating the immutable spec
kubectl delete sts "${STS_NAME}" -n "${NAMESPACE}" --cascade=orphan
echo "StatefulSet definition deleted (pods still running)"

# Step 4: Update the StatefulSet spec and re-create it
# Generate new StatefulSet with updated volumeClaimTemplate
cat /tmp/sts-backup.json | \
  jq --arg size "${NEW_SIZE}" \
    --arg template "${TEMPLATE_NAME}" \
    '.spec.volumeClaimTemplates[] |=
      if .metadata.name == $template
      then .spec.resources.requests.storage = $size
      else .
      end' | \
  kubectl apply -f -

echo "StatefulSet re-created with updated volumeClaimTemplate"
```

## Handling the FileSystemResizePending State

When a PVC shows `FileSystemResizePending: True`, the block device is larger than the file system. This must be resolved to reclaim the new space.

### Automatic Resolution (Most CSI Drivers)

Most CSI drivers with `NodeExpandVolume` support trigger file system expansion automatically when the volume is mounted. If the pod is already running, the kubelet periodically reconciles mounted volumes and triggers `resize2fs` or `xfs_growfs` as appropriate.

Force reconciliation by checking the kubelet logs:

```bash
# Check kubelet logs on the node hosting the pod
NODE=$(kubectl get pod postgres-0 -n databases \
  -o jsonpath='{.spec.nodeName}')

kubectl debug node/${NODE} -it --image=ubuntu:22.04 -- \
  journalctl -u kubelet --since "10 minutes ago" | \
  grep -i "resize\|expand\|pvc-a1b2c3d4"
```

### Manual File System Expansion (Emergency Procedure)

If automatic expansion is stalled:

```bash
# Identify the block device inside the pod
kubectl exec -n databases postgres-0 -- lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT

# For ext4:
kubectl exec -n databases postgres-0 -- resize2fs /dev/nvme1n1

# For xfs (must be mounted):
kubectl exec -n databases postgres-0 -- xfs_growfs /var/lib/postgresql/data

# Verify
kubectl exec -n databases postgres-0 -- df -h /var/lib/postgresql/data
```

## Monitoring PVC Expansion with Prometheus

```yaml
# PrometheusRule for PVC expansion monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pvc-expansion-alerts
  namespace: monitoring
spec:
  groups:
    - name: pvc-expansion
      interval: 30s
      rules:
        - alert: PVCExpansionStalled
          expr: |
            kube_persistentvolumeclaim_status_condition{
              condition="FileSystemResizePending",
              status="true"
            } == 1
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "PVC file system resize pending for >30 minutes"
            description: "PVC {{ $labels.persistentvolumeclaim }} in namespace {{ $labels.namespace }} has been waiting for file system resize for over 30 minutes. The block device was expanded but the file system has not been resized yet."
            runbook: "https://wiki.acme.internal/runbooks/pvc-filesystem-resize-pending"

        - alert: PVCCapacityHighWatermark
          expr: |
            (
              kubelet_volume_stats_used_bytes /
              kubelet_volume_stats_capacity_bytes
            ) > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PVC usage above 85%"
            description: "PVC {{ $labels.persistentvolumeclaim }} in namespace {{ $labels.namespace }} is {{ printf \"%.0f\" (mul 100 $value) }}% full. Consider expanding soon."
```

## CSI Driver Compatibility Matrix

| CSI Driver | Online Expansion | FS Resize Without Restart | 1GB+ Expansion |
|------------|-----------------|---------------------------|----------------|
| aws-ebs-csi-driver | Yes (gp2, gp3, io1, io2) | Yes | Yes |
| gcp-compute-persistent-disk-csi-driver | Yes | Yes | Yes |
| azure-disk-csi-driver | Yes | Yes | Yes |
| longhorn | Yes | Yes | Yes (2.5+) |
| rook-ceph (rbd) | Yes | Yes | Yes |
| NFS (nfs-subdir) | Not applicable | Not applicable | Yes |
| local-path-provisioner | No | No | No |

## Troubleshooting Reference

```bash
# PVC stuck in Terminating
kubectl patch pvc postgres-data-postgres-0 -n databases \
  --type=json -p '[{"op": "remove", "path": "/metadata/finalizers"}]'

# Check CSI controller logs for expansion errors
kubectl logs -n kube-system -l app=ebs-csi-controller \
  -c csi-provisioner --tail=100 | grep -i "expand\|resize"

# Check CSI node logs on the affected node
NODE=$(kubectl get pod postgres-0 -n databases -o jsonpath='{.spec.nodeName}')
kubectl logs -n kube-system -l app=ebs-csi-node \
  --field-selector spec.nodeName=${NODE} \
  -c csi-driver --tail=100 | grep -i "expand\|resize"

# Describe the PVC for events
kubectl describe pvc postgres-data-postgres-0 -n databases | tail -30
```

## Summary

PVC expansion in Kubernetes is a multi-phase process that requires coordination between the API server, CSI controller, CSI node driver, and kubelet. The critical points for production operations are:

- **StorageClass must have `allowVolumeExpansion: true`** — verify before any expansion attempt
- **StatefulSet `volumeClaimTemplates` is immutable** — use `--cascade=orphan` delete to update the template without disrupting running pods
- **`FileSystemResizePending`** is normal and usually resolves automatically — alert if it persists beyond 30 minutes
- **CSI driver support varies** — local-path and NFS provisioners do not support block device expansion
- **Online expansion** (no pod restart required) is supported by all major cloud CSI drivers as of Kubernetes 1.16 stable
