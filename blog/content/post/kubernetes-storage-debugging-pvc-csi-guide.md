---
title: "Kubernetes Storage Troubleshooting: Diagnosing PVC Binding, Mount, and Performance Issues"
date: 2027-08-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "Troubleshooting", "PersistentVolumes"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive storage troubleshooting methodology covering PVC stuck in Pending, volume mount failures, ReadWriteMany contention, CSI driver errors, storage class configuration issues, and performance diagnosis with fio."
more_link: "yes"
url: /kubernetes-storage-debugging-pvc-csi-guide/
---

Kubernetes storage failures are among the most disruptive incidents in production environments — a pod stuck in ContainerCreating because its PVC never bound, a StatefulSet that cannot restart due to a stale volume attachment, or a distributed database suffering unexplained latency due to underlying storage throttling. Each failure mode requires a distinct diagnostic path and a clear understanding of how Kubernetes coordinates the control plane, CSI drivers, and the underlying storage system.

<!--more-->

## Kubernetes Storage Architecture Overview

Before debugging, understanding the chain of components involved clarifies where failures occur:

```
Pod Spec (volumeMounts)
    ↓
PersistentVolumeClaim (namespace-scoped request)
    ↓
PersistentVolume (cluster-scoped resource)
    ↓
StorageClass → CSI Driver → External Provisioner
    ↓
Cloud Volume (EBS, GCE PD, Azure Disk) or On-Premises Storage
```

The CSI driver lifecycle involves three controllers:
- **External Provisioner**: Creates/deletes PVs in response to PVC events
- **External Attacher**: Attaches/detaches volumes to nodes via `VolumeAttachment` objects
- **Node CSI Driver**: Mounts/unmounts volumes on the node filesystem

### Diagnostic Tool Setup

```bash
# Install CSI tools for debugging
kubectl krew install csi

# Useful aliases
alias kgpv='kubectl get pv -o wide'
alias kgpvc='kubectl get pvc -o wide'
alias kgsc='kubectl get storageclass'
alias kgva='kubectl get volumeattachment'
```

## PVC Stuck in Pending State

### Diagnosis Flowchart

```bash
# Step 1: Examine the PVC
kubectl describe pvc <pvc-name> -n <namespace>

# Look for:
# - Events section: "waiting for a volume to be created..."
# - "no persistent volumes available for this claim and no storage class is set"
# - "waiting for first consumer to be scheduled"
```

### Common Causes and Remediation

**Cause 1: No matching PersistentVolume (static provisioning)**

```bash
# Check available PVs
kubectl get pv -o wide

# Check PV status
kubectl get pv | grep -E "Available|Released|Failed"

# A PV must match the PVC on:
# - Storage capacity (PV must be >= PVC request)
# - Access modes (ReadWriteOnce, ReadWriteMany, ReadOnlyMany)
# - StorageClass name (or both must have empty class)
# - VolumeMode (Filesystem or Block)

# List PV details including access modes
kubectl get pv -o custom-columns=\
NAME:.metadata.name,\
CAPACITY:.spec.capacity.storage,\
ACCESS:.spec.accessModes,\
STATUS:.status.phase,\
CLAIM:.spec.claimRef.name
```

**Cause 2: StorageClass provisioner not available**

```bash
# Check StorageClass configuration
kubectl get sc
kubectl describe sc <storage-class-name>

# Verify the provisioner pod is running
# For AWS EBS CSI driver:
kubectl get pods -n kube-system -l app=ebs-csi-controller
kubectl logs -n kube-system -l app=ebs-csi-controller -c csi-provisioner --tail=50

# For GCE PD CSI driver:
kubectl get pods -n kube-system -l app=gcp-compute-persistent-disk-csi-driver

# For Azure Disk CSI driver:
kubectl get pods -n kube-system -l app=csi-azuredisk-controller
```

**Cause 3: WaitForFirstConsumer binding mode**

```bash
# StorageClass with volumeBindingMode: WaitForFirstConsumer
# PVC stays Pending until a pod using it is scheduled

kubectl describe sc gp3-encrypted | grep Binding
# VolumeBindingMode: WaitForFirstConsumer

# This is expected behavior — the PVC binds only when a pod
# using it is scheduled to a node. Check if the pod is pending:
kubectl get pod -n <namespace> -o wide | grep Pending
kubectl describe pod <pod-name> -n <namespace> | grep -A 10 "Events:"
```

**Cause 4: Resource quota exhaustion**

```bash
# Check namespace resource quotas
kubectl get resourcequota -n <namespace>
kubectl describe resourcequota -n <namespace>

# If PersistentVolumeClaims count is at limit:
kubectl get pvc -n <namespace> | wc -l
```

**Cause 5: StorageClass parameters invalid**

```bash
# Check provisioner logs for parameter errors
kubectl logs -n kube-system -l app=ebs-csi-controller \
  -c csi-provisioner --tail=100 | grep -E "error|Error|FAIL"

# Common EBS CSI parameter errors:
# - Invalid iopsPerGB for gp2 type
# - Invalid kmsKeyId format
# - Unsupported fsType

# Example corrected StorageClass for AWS:
cat <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-encrypted
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/EXAMPLE-KEY-ID-REPLACE-ME"
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
EOF
```

## Volume Mount Failures

### Pod Stuck in ContainerCreating

```bash
# Check pod events
kubectl describe pod <pod-name> -n <namespace> | grep -A 30 "Events:"

# Common mount error messages:
# "Unable to attach or mount volumes"
# "timeout expired waiting for volumes to attach"
# "MountVolume.SetUp failed"
# "NodeStageVolume failed"

# Check VolumeAttachment status
kubectl get volumeattachment -o wide
kubectl describe volumeattachment <va-name>

# Check node-level CSI plugin logs
NODE=$(kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.nodeName}')
kubectl logs -n kube-system -l app=ebs-csi-node \
  --field-selector spec.nodeName=$NODE -c ebs-plugin --tail=100
```

### Stale Volume Attachment

Stale VolumeAttachment objects are a common cause of pods being unable to start after node failures:

```bash
# List all VolumeAttachment objects
kubectl get volumeattachment -o wide

# Find attachments pointing to non-existent or deleted nodes
kubectl get volumeattachment -o json | jq -r \
  '.items[] | select(.spec.nodeName) | "\(.metadata.name) \(.spec.nodeName) \(.status.attached)"'

# Check if the node still exists
kubectl get nodes | grep <node-name>

# If node is gone and VolumeAttachment is stale, delete it
# This forces re-attachment on the new node
kubectl delete volumeattachment <va-name>

# After deletion, the pod should proceed to mount the volume on the new node
```

### Multi-Attach Errors (ReadWriteOnce)

```bash
# Error: "Multi-Attach error for volume: volume is already used by pod(s)"
# This occurs when an RWO volume is attached to one node and a pod
# on a different node tries to use it

# Find which pod currently holds the volume
kubectl get pvc <pvc-name> -n <namespace> -o yaml | grep volumeName
kubectl get pv <pv-name> -o yaml | grep claimRef

# Find which pods use this PVC
kubectl get pod -n <namespace> -o json | jq -r \
  '.items[] | select(.spec.volumes[]?.persistentVolumeClaim.claimName == "<pvc-name>") | .metadata.name'

# Check which node the volume is attached to
kubectl get volumeattachment | grep <pv-name>

# The resolution is to ensure the old pod is fully terminated
# before the new pod starts — use pod disruption budgets and
# proper terminationGracePeriodSeconds
```

### Filesystem Corruption Recovery

```bash
# Error: "Unable to mount volumes: unable to mount the volume..."
# With message indicating filesystem corruption

# Identify the underlying block device
kubectl describe pv <pv-name> | grep -E "volumeID|diskURI|pdName"

# For EBS: Check CloudWatch for volume health
# aws ec2 describe-volume-status --volume-ids vol-XXXXXXXXXXXXXXXXX

# Run fsck on the node (requires privileged access)
NODE=$(kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.nodeName}')
kubectl debug node/$NODE -it --image=ubuntu -- bash

# Inside the debug container
nsenter -t 1 -m -- bash
# Find the block device
lsblk
# Run fsck (only on unmounted or read-only mounted device)
fsck -y /dev/nvme1n1
```

## ReadWriteMany (RWX) Storage Issues

### NFS and CephFS Mount Failures

```bash
# Check NFS mount from pod perspective
kubectl exec -n <namespace> <pod-name> -- df -h
kubectl exec -n <namespace> <pod-name> -- mount | grep nfs

# Check NFS connectivity from node
NODE=$(kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.nodeName}')
kubectl debug node/$NODE -it --image=nicolaka/netshoot -- bash
nsenter -t 1 -n -- showmount -e <nfs-server-ip>
nsenter -t 1 -n -- mount -t nfs <nfs-server-ip>:/export /mnt/test
```

### Longhorn ReadWriteMany via NFS

```bash
# Check Longhorn share manager for RWX volumes
kubectl get pod -n longhorn-system -l longhorn.io/component=share-manager

# Check share manager logs for the specific volume
VOLUME_NAME="pvc-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
kubectl logs -n longhorn-system \
  share-manager-$VOLUME_NAME --tail=100

# Verify NFS export from share manager
kubectl exec -n longhorn-system \
  share-manager-$VOLUME_NAME -- exportfs -v
```

## CSI Driver Troubleshooting

### Diagnostic Log Collection

```bash
#!/usr/bin/env bash
# csi-debug.sh - Collect CSI diagnostic information
NAMESPACE="${1:-kube-system}"
CSI_DRIVER="${2:-ebs.csi.aws.com}"

echo "=== CSI Driver Pods ==="
kubectl get pods -n "$NAMESPACE" | grep csi

echo "=== VolumeAttachments ==="
kubectl get volumeattachment -o wide

echo "=== Failed PVCs ==="
kubectl get pvc --all-namespaces | grep -v Bound

echo "=== CSI Controller Logs (last 100 lines) ==="
kubectl logs -n "$NAMESPACE" \
  -l "app in (ebs-csi-controller, csi-azuredisk-controller, gcp-compute-persistent-disk-csi-driver)" \
  -c csi-provisioner --tail=100 2>/dev/null

echo "=== External Attacher Logs ==="
kubectl logs -n "$NAMESPACE" \
  -l "app in (ebs-csi-controller, csi-azuredisk-controller)" \
  -c csi-attacher --tail=100 2>/dev/null

echo "=== Recent Storage Events ==="
kubectl get events --all-namespaces \
  --field-selector reason=ProvisioningFailed --sort-by='.lastTimestamp' | tail -20

kubectl get events --all-namespaces \
  --field-selector reason=FailedMount --sort-by='.lastTimestamp' | tail -20
```

### CSI Driver Version Compatibility

```bash
# Check installed CSI driver version
kubectl get csidrivers
kubectl describe csidriver ebs.csi.aws.com

# Check CSI node plugin DaemonSet version
kubectl get ds -n kube-system ebs-csi-node -o jsonpath='{.spec.template.spec.containers[0].image}'

# Verify CSI driver supports the Kubernetes version's CSI spec
# CSI spec version must match what the kubelet expects
kubectl version --short
```

## Storage Performance Diagnosis with fio

### Running fio Benchmarks Inside Pods

Deploy a dedicated fio test pod:

```yaml
# fio-benchmark-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: fio-benchmark
  namespace: storage-test
spec:
  containers:
    - name: fio
      image: ljishen/fio:latest
      command: ["sleep", "infinity"]
      volumeMounts:
        - name: test-volume
          mountPath: /data
      resources:
        requests:
          cpu: "1"
          memory: "1Gi"
        limits:
          cpu: "2"
          memory: "2Gi"
  volumes:
    - name: test-volume
      persistentVolumeClaim:
        claimName: fio-test-pvc
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fio-test-pvc
  namespace: storage-test
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: gp3-encrypted
  resources:
    requests:
      storage: 100Gi
```

```bash
kubectl apply -f fio-benchmark-pod.yaml

# Sequential read test
kubectl exec -n storage-test fio-benchmark -- fio \
  --name=seq-read \
  --ioengine=libaio \
  --iodepth=32 \
  --rw=read \
  --bs=1M \
  --direct=1 \
  --size=10G \
  --filename=/data/test \
  --output-format=json | jq '.jobs[0].read | {iops, bw_bytes, lat_ns}'

# Random 4K IOPS test (database workload)
kubectl exec -n storage-test fio-benchmark -- fio \
  --name=rand-4k \
  --ioengine=libaio \
  --iodepth=64 \
  --rw=randread \
  --bs=4k \
  --direct=1 \
  --size=10G \
  --filename=/data/test \
  --runtime=60 \
  --time_based \
  --output-format=json | jq '.jobs[0].read | {iops, "bw_MBps": (.bw / 1024), "lat_p99_ms": (.clat_ns.percentile."99.000000" / 1000000)}'

# Mixed read/write (OLTP simulation)
kubectl exec -n storage-test fio-benchmark -- fio \
  --name=mixed-rw \
  --ioengine=libaio \
  --iodepth=32 \
  --rw=randrw \
  --rwmixread=70 \
  --bs=4k \
  --direct=1 \
  --size=10G \
  --filename=/data/test \
  --runtime=60 \
  --time_based
```

### Interpreting fio Results for Common Storage Classes

| Storage Class | Expected 4K Random Read IOPS | Expected Sequential Throughput | Latency (p99) |
|---------------|-------------------------------|-------------------------------|---------------|
| AWS gp3 (3000 IOPS) | ~2,800 | ~125 MB/s | < 2ms |
| AWS io2 (64,000 IOPS) | ~60,000 | ~1,000 MB/s | < 0.5ms |
| NFS (10GbE) | ~5,000 | ~800 MB/s | 1–5ms |
| Longhorn (replicated) | ~1,000–3,000 | ~200 MB/s | 2–10ms |
| Local NVMe | ~200,000+ | ~3,000 MB/s | < 0.1ms |

### Throttling Detection

AWS EBS volumes throttle when IOPS or throughput burst credits are exhausted:

```bash
# Check CloudWatch metrics for BurstBalance and VolumeQueueLength
# This requires AWS CLI access from outside the cluster
aws cloudwatch get-metric-statistics \
  --namespace AWS/EBS \
  --metric-name BurstBalance \
  --dimensions Name=VolumeId,Value=vol-XXXXXXXXXXXXXXXXX \
  --start-time "$(date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%S')" \
  --end-time "$(date -u '+%Y-%m-%dT%H:%M:%S')" \
  --period 60 \
  --statistics Average

# Inside the pod, detect throttling via iostat
kubectl exec -n production <pod-name> -- iostat -x 1 10
# Look for: avgqu-sz > 1, await > 10ms, util > 90%
```

## Storage Class Misconfiguration Examples

### Reclaim Policy Issues

```bash
# Check PV reclaim policy
kubectl get pv -o custom-columns=\
NAME:.metadata.name,RECLAIM:.spec.persistentVolumeReclaimPolicy,STATUS:.status.phase

# Released PVs with Retain policy require manual cleanup
kubectl get pv | grep Released

# Repurpose a Released PV by removing its claimRef
kubectl patch pv <pv-name> --type json \
  -p '[{"op": "remove", "path": "/spec/claimRef"}]'
```

### Volume Expansion Failures

```bash
# Error: "waiting for user to (re-)start a pod to finish file system resize"
# PVC shows status: FileSystemResizePending

kubectl get pvc <pvc-name> -n <namespace> \
  -o jsonpath='{.status.conditions}'

# The filesystem resize completes when the pod restarts
# For running pods, force a rolling restart
kubectl rollout restart deployment/<deployment-name> -n <namespace>

# Verify expansion completed
kubectl get pvc <pvc-name> -n <namespace> -o wide
# STATUS should return to Bound with new capacity

# If StorageClass doesn't allow expansion:
kubectl describe sc <storage-class-name> | grep AllowVolumeExpansion
# Must be: AllowVolumeExpansion: true
```

A methodical storage diagnosis workflow — starting from PVC status, through CSI driver logs, to node-level mount inspection, and finally performance measurement — resolves the full spectrum of Kubernetes storage failures. Performance issues in particular benefit from fio benchmarking before and after any storage class or configuration change, establishing a quantitative baseline rather than relying on application-level symptoms alone.
