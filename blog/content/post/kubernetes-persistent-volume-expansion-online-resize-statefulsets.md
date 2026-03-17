---
title: "Kubernetes Persistent Volume Expansion: Online Resize for StatefulSets"
date: 2031-04-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "StatefulSets", "PVC", "CSI", "Persistent Volumes"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to online PVC expansion for Kubernetes StatefulSets: StorageClass configuration, CSI driver resize verification, filesystem expansion for ext4 and xfs, and resolving stuck resize operations without downtime."
more_link: "yes"
url: "/kubernetes-persistent-volume-expansion-online-resize-statefulsets/"
---

Running out of disk space on a production StatefulSet is one of the most stressful operational events you can face. A database pod hitting its volume ceiling, a message broker log partition filling up, or an Elasticsearch data node exhausting its allocation — each scenario threatens application availability and demands a fast, reliable remediation path. Kubernetes has supported online PVC expansion for several releases, but the path from "StorageClass allowVolumeExpansion: true" to a fully-resized filesystem involves multiple layers that must each cooperate correctly.

This guide walks through every stage of the online volume expansion workflow: verifying CSI driver support, configuring StorageClasses, executing the PVC resize, confirming the filesystem resize inside the pod, and diagnosing the common failure modes that leave operations stuck in the ResizePending state.

<!--more-->

# Kubernetes Persistent Volume Expansion: Online Resize for StatefulSets

## Section 1: Understanding the Resize Architecture

Volume expansion in Kubernetes involves at least three distinct operations that must complete in sequence:

1. The control plane resizes the backing storage object (the PersistentVolume and the underlying cloud disk or SAN LUN).
2. The CSI driver's node plugin expands the block device or filesystem on the node where the pod is running.
3. The filesystem inside the container recognizes the new capacity.

Each step is mediated by different Kubernetes components, and a failure at any layer produces a different error signature.

### The PVC Resize State Machine

When you patch a PVC's `spec.resources.requests.storage`, the Kubernetes volume expansion controller records a condition on the PVC. The conditions to watch are:

- `FileSystemResizePending` — the PV has been expanded at the storage layer; the node-side filesystem resize is pending
- `Resizing` — an expansion operation is in progress
- No condition with `type: FileSystemResizePending` and `status: True` after several minutes indicates the controller-manager has not yet processed the request

The kubelet on the node where the pod is scheduled performs the filesystem resize. This means the pod must be running and bound to a node for the node-side step to execute.

### Why StatefulSets Are Different

StatefulSets own their VolumeClaimTemplates but do not automatically propagate PVC changes. The StatefulSet controller creates PVCs from the template at pod creation time; it does not reconcile capacity changes on existing PVCs. This means:

- Deleting and recreating a StatefulSet pod does NOT resize the PVC.
- You must patch each PVC individually.
- The StatefulSet itself does not need to be modified or deleted for PVC expansion.

## Section 2: Verifying CSI Driver Support

Before attempting any resize, confirm that every component in the storage path supports it.

### Checking the StorageClass

```bash
kubectl get storageclass <storage-class-name> -o yaml
```

You must see `allowVolumeExpansion: true` in the output:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: csi-rbd-sc
provisioner: rbd.csi.ceph.com
parameters:
  clusterID: <ceph-cluster-id>
  pool: kubernetes
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  csi.storage.k8s.io/fstype: ext4
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
```

If `allowVolumeExpansion` is absent or false, you must update the StorageClass:

```bash
kubectl patch storageclass csi-rbd-sc \
  --type=merge \
  -p '{"allowVolumeExpansion": true}'
```

Note: Setting `allowVolumeExpansion: true` on an existing StorageClass retroactively enables expansion for all PVCs using that class.

### Verifying CSI Driver Capabilities

The CSI driver must advertise the `EXPAND_VOLUME` capability. Query the CSIDriver object:

```bash
kubectl get csidriver rbd.csi.ceph.com -o yaml
```

Check the driver's controller and node capabilities by inspecting the driver pods directly:

```bash
# Find the CSI controller pod
kubectl -n rook-ceph get pods -l app=csi-rbdplugin-provisioner

# Check the driver logs for capability advertisement
kubectl -n rook-ceph logs csi-rbdplugin-provisioner-<hash> -c csi-rbdplugin 2>&1 | \
  grep -i "EXPAND_VOLUME"
```

For AWS EBS CSI driver:

```bash
kubectl get csidriver ebs.csi.aws.com -o jsonpath='{.spec.storageCapacity}'

# Verify the controller plugin supports ControllerExpandVolume
kubectl -n kube-system get pods -l app=ebs-csi-controller
kubectl -n kube-system logs ebs-csi-controller-<hash> -c ebs-plugin 2>&1 | \
  grep -i expand
```

### Node Plugin Requirement

The CSI node plugin must be deployed as a DaemonSet and must implement `NodeExpandVolume`. Without the node plugin on the specific node where your pod runs, the filesystem resize will never complete:

```bash
# Verify the node plugin DaemonSet is running on all relevant nodes
kubectl -n rook-ceph get daemonset csi-rbdplugin
kubectl -n rook-ceph get pods -l app=csi-rbdplugin -o wide
```

## Section 3: Enabling Volume Expansion on StorageClasses

### Creating a New Expansion-Ready StorageClass

For new deployments, build the StorageClass with expansion enabled from the start:

```yaml
# storageclass-expandable.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-expandable
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
mountOptions:
  - noatime
  - nodiratime
```

```bash
kubectl apply -f storageclass-expandable.yaml
```

### Migrating an Existing StatefulSet to an Expansion-Ready StorageClass

If you have an existing StatefulSet using a StorageClass without `allowVolumeExpansion`, the cleanest path is to:

1. Enable expansion on the existing StorageClass (if the provisioner supports it).
2. If the provisioner does not support expansion, create a new StorageClass and migrate data.

For step 2, migration involves creating a new StatefulSet that uses the new StorageClass, copying data with a migration job, and switching over traffic. This procedure is outside the scope of this guide, which assumes the provisioner supports expansion.

## Section 4: Expanding PVCs on a StatefulSet

### Identifying the PVCs to Expand

StatefulSet PVCs follow the naming convention `<claim-name>-<statefulset-name>-<ordinal>`:

```bash
# List all PVCs for a StatefulSet named "postgresql"
kubectl get pvc -l app=postgresql

# More explicit selector based on the StatefulSet name
kubectl get pvc | grep "data-postgresql-"
```

Example output:

```
NAME                    STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
data-postgresql-0       Bound    pvc-1a2b3c4d-5e6f-7890-abcd-ef1234567890   50Gi       RWO            fast-expandable   45d
data-postgresql-1       Bound    pvc-2b3c4d5e-6f78-90ab-cdef-1234567890ab   50Gi       RWO            fast-expandable   45d
data-postgresql-2       Bound    pvc-3c4d5e6f-7890-abcd-ef12-34567890abcd   50Gi       RWO            fast-expandable   45d
```

### Patching a PVC to Request Expansion

```bash
# Expand a single PVC from 50Gi to 100Gi
kubectl patch pvc data-postgresql-0 \
  --type=merge \
  -p '{"spec": {"resources": {"requests": {"storage": "100Gi"}}}}'
```

For scripted expansion of all PVCs in a StatefulSet:

```bash
#!/bin/bash
set -euo pipefail

STATEFULSET_NAME="postgresql"
NAMESPACE="production"
NEW_SIZE="100Gi"
CLAIM_PREFIX="data"

# Get the number of replicas
REPLICAS=$(kubectl -n "${NAMESPACE}" get statefulset "${STATEFULSET_NAME}" \
  -o jsonpath='{.spec.replicas}')

echo "Expanding ${REPLICAS} PVCs for StatefulSet ${STATEFULSET_NAME} to ${NEW_SIZE}"

for i in $(seq 0 $((REPLICAS - 1))); do
  PVC_NAME="${CLAIM_PREFIX}-${STATEFULSET_NAME}-${i}"
  echo "Patching PVC: ${PVC_NAME}"

  kubectl -n "${NAMESPACE}" patch pvc "${PVC_NAME}" \
    --type=merge \
    -p "{\"spec\": {\"resources\": {\"requests\": {\"storage\": \"${NEW_SIZE}\"}}}}"

  echo "Patch applied to ${PVC_NAME}, waiting 5 seconds before next..."
  sleep 5
done

echo "All PVC patches applied. Monitoring resize status..."
```

### Monitoring the Resize Progress

After patching, watch the PVC conditions:

```bash
# Watch a single PVC
kubectl get pvc data-postgresql-0 -o yaml -w

# Watch all PVCs and show conditions
kubectl get pvc -l app=postgresql \
  -o custom-columns=\
'NAME:.metadata.name,CAPACITY:.spec.resources.requests.storage,STATUS:.status.phase,CONDITIONS:.status.conditions[*].type'
```

The resize progresses through these stages:

```bash
# Check the describe output for events
kubectl describe pvc data-postgresql-0
```

Expected events for a successful online resize:

```
Events:
  Type    Reason                      Age   From                                Message
  ----    ------                      ----  ----                                -------
  Normal  ExternalProvisioning        45d   persistentvolume-controller         waiting for a volume to be created, either by external provisioner "ebs.csi.aws.com" or manually created by system administrator
  Normal  Provisioning                45d   ebs.csi.aws.com_csi-provisioner-0   External provisioner is provisioning volume for claim "production/data-postgresql-0"
  Normal  ProvisioningSucceeded       45d   ebs.csi.aws.com_csi-provisioner-0   Successfully provisioned volume pvc-1a2b3c4d-5e6f-7890-abcd-ef1234567890
  Normal  Resizing                    2m    external-resizer ebs.csi.aws.com     External resizer is resizing volume pvc-1a2b3c4d-5e6f-7890-abcd-ef1234567890
  Normal  FileSystemResizePending     90s   external-resizer ebs.csi.aws.com     Waiting for user to (re-)start a pod to finish file system resize of volume on node.
  Normal  FileSystemResizeSuccessful  10s   kubelet                             MountVolume.NodeExpandVolume succeeded for volume "pvc-1a2b3c4d-5e6f-7890-abcd-ef1234567890"
```

### Verifying the Filesystem Resize Inside the Pod

Once the events show `FileSystemResizeSuccessful`, verify inside the running pod:

```bash
# Check the filesystem size as seen by the application
kubectl -n production exec postgresql-0 -- df -h /var/lib/postgresql/data

# For more detail
kubectl -n production exec postgresql-0 -- \
  bash -c "df -h /var/lib/postgresql/data && lsblk"
```

Expected output after successful resize:

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme1n1    100G   48G   52G  48% /var/lib/postgresql/data
```

## Section 5: Filesystem-Specific Resize Considerations

### ext4 Filesystem Resizing

The CSI node plugin calls `resize2fs` to expand ext4 filesystems. This happens automatically during the `NodeExpandVolume` call when the pod is running. You can verify the ext4 resize was called:

```bash
# Check the kubelet log on the node where the pod runs
NODE=$(kubectl -n production get pod postgresql-0 -o jsonpath='{.spec.nodeName}')
kubectl get node "${NODE}" -o wide

# On the node itself (requires node access)
journalctl -u kubelet | grep -i "resize2fs\|nodeExpandVolume" | tail -20
```

If the CSI driver does not perform the filesystem resize automatically (some older drivers), you can trigger it manually inside the pod:

```bash
# Find the device
kubectl -n production exec postgresql-0 -- lsblk

# Check if online resize is needed (ext4)
kubectl -n production exec postgresql-0 -- \
  bash -c "df -h /dev/nvme1n1 && tune2fs -l /dev/nvme1n1 | grep 'Block count'"

# Resize ext4 online (if the CSI driver did not do it automatically)
kubectl -n production exec postgresql-0 -- resize2fs /dev/nvme1n1
```

### xfs Filesystem Resizing

XFS uses `xfs_growfs` instead of `resize2fs`. Importantly, `xfs_growfs` requires the mount point rather than the device path:

```bash
# For a pod using xfs
kubectl -n production exec postgresql-0 -- \
  xfs_growfs /var/lib/postgresql/data
```

The CSI driver's `NodeExpandVolume` implementation typically handles xfs automatically via `xfs_growfs`. However, the CSI driver needs to know the filesystem type. Verify the StorageClass parameter:

```yaml
parameters:
  csi.storage.k8s.io/fstype: xfs
```

If the fstype is not set, the CSI driver may default to ext4 and fail silently on xfs volumes. Check the PV annotation:

```bash
kubectl get pv pvc-1a2b3c4d-5e6f-7890-abcd-ef1234567890 -o yaml | \
  grep -A5 "annotations"
```

Look for `volume.kubernetes.io/selected-node` and the CSI volume attributes.

### Block Volume (Raw Block Device) Resizing

For PVCs with `volumeMode: Block`, the filesystem resize step is skipped — the block device expansion is handled entirely at the control-plane layer, and the application manages its own block-level layout:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-cassandra-0
spec:
  accessModes:
    - ReadWriteOnce
  volumeMode: Block
  resources:
    requests:
      storage: 500Gi
  storageClassName: fast-expandable
```

After expanding a block volume PVC, the application (e.g., Cassandra) will see the new capacity when it next queries the block device size via `BLKGETSIZE64`.

## Section 6: StatefulSet-Specific Expansion Without Downtime

### Online Resize (No Pod Restart Required)

With modern CSI drivers that support online expansion, the resize happens while the pod continues running. The sequence is:

1. Patch the PVC — the control plane expands the backing volume.
2. The kubelet detects `FileSystemResizePending` on the PVC.
3. The kubelet calls `NodeExpandVolume` on the CSI node plugin.
4. The CSI node plugin calls `resize2fs` or `xfs_growfs` on the mounted filesystem.
5. The filesystem is now larger; no pod restart needed.

Verify online resize support for your CSI driver:

```bash
# Check if the CSI driver supports ONLINE resize
kubectl get csidriver ebs.csi.aws.com -o yaml
```

Look for `requiresRepublish` and the driver's volume lifecycle modes. For EBS CSI driver version 1.6+, online resize is supported for gp2, gp3, io1, and io2 volume types.

### Offline Resize (Pod Restart Required)

Some CSI drivers only support offline expansion — the volume must be unmounted for the filesystem resize. In this case:

1. Scale down the StatefulSet to 0 replicas (or delete the specific pod).
2. The PVC reaches `FileSystemResizePending`.
3. Bring the pod back up — the CSI node plugin performs the resize during mount.

```bash
# Scale down specific pod in a StatefulSet (delete the pod — StatefulSet recreates it)
# First, confirm whether online resize is supported for your driver

# If offline resize is required, delete the pod
kubectl -n production delete pod postgresql-2

# The StatefulSet controller recreates postgresql-2
# During mount, the CSI node plugin will call NodeExpandVolume
# Monitor the pod startup
kubectl -n production get pod postgresql-2 -w
```

For a controlled rolling offline resize across all replicas:

```bash
#!/bin/bash
STATEFULSET="postgresql"
NAMESPACE="production"
REPLICAS=3

# Process in reverse order to avoid losing primary/leader
for i in $(seq $((REPLICAS - 1)) -1 0); do
  POD="${STATEFULSET}-${i}"
  echo "Deleting pod ${POD} for offline resize..."
  kubectl -n "${NAMESPACE}" delete pod "${POD}"

  # Wait for pod to be recreated and Running
  echo "Waiting for ${POD} to be Running..."
  kubectl -n "${NAMESPACE}" wait pod "${POD}" \
    --for=condition=Ready \
    --timeout=300s

  echo "Pod ${POD} is ready, sleeping 30s before next..."
  sleep 30
done
```

## Section 7: Troubleshooting Stuck Resize Operations

### Symptom: PVC Stuck at FileSystemResizePending

The PVC has `FileSystemResizePending: True` but the filesystem has not grown. Check:

**1. Is the pod running on a node with the CSI node plugin?**

```bash
# Get the pod's node
NODE=$(kubectl -n production get pod postgresql-0 -o jsonpath='{.spec.nodeName}')
echo "Pod is on node: ${NODE}"

# Check if the CSI node DaemonSet pod is running on that node
kubectl -n kube-system get pods -l app=ebs-csi-node -o wide | grep "${NODE}"
```

**2. Check the CSI node plugin logs**

```bash
# Find the node plugin pod on the same node as the StatefulSet pod
CSI_NODE_POD=$(kubectl -n kube-system get pods -l app=ebs-csi-node \
  -o wide | grep "${NODE}" | awk '{print $1}')

kubectl -n kube-system logs "${CSI_NODE_POD}" -c ebs-plugin 2>&1 | \
  grep -i "expand\|resize\|error" | tail -30
```

**3. Check the kubelet logs**

```bash
# On the node (via SSH or node debug pod)
kubectl debug node/"${NODE}" -it --image=ubuntu -- \
  bash -c "journalctl -u kubelet | grep -i 'nodeExpand\|resize' | tail -30"
```

### Symptom: Resize Rejected — StorageClass Does Not Allow Expansion

```
Error: persistentvolumeclaims "data-postgresql-0" is forbidden: only dynamically provisioned pVCs can be resized and the StorageClass "slow" does not support resize
```

Resolution:

```bash
# Update the StorageClass
kubectl patch storageclass slow --type=merge \
  -p '{"allowVolumeExpansion": true}'

# Retry the PVC patch
kubectl patch pvc data-postgresql-0 \
  --type=merge \
  -p '{"spec": {"resources": {"requests": {"storage": "100Gi"}}}}'
```

### Symptom: Resize Fails with "volume is currently attached to node X but not mounted"

This occurs when the volume is attached to the node (visible in the node's volume attachments) but not mounted to any pod. This can happen if a pod was deleted but the volume attachment was not cleaned up:

```bash
# Check volume attachments
kubectl get volumeattachments | grep pvc-1a2b3c4d

# Force detach if the node is no longer reachable
kubectl get volumeattachment <attachment-name> -o yaml
kubectl delete volumeattachment <attachment-name>

# Then restart the pod to remount
kubectl -n production delete pod postgresql-0
```

### Symptom: Resize Stuck at "Resizing" for More Than 10 Minutes

The external resizer sidecar in the CSI controller has submitted the `ControllerExpandVolume` call but it has not returned:

```bash
# Check the external-resizer sidecar logs in the CSI controller pod
kubectl -n kube-system get pods -l app=ebs-csi-controller
CSI_CTRL=$(kubectl -n kube-system get pods -l app=ebs-csi-controller \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n kube-system logs "${CSI_CTRL}" -c csi-resizer 2>&1 | \
  grep -i "error\|failed\|pvc-1a2b3c4d" | tail -20

kubectl -n kube-system logs "${CSI_CTRL}" -c ebs-plugin 2>&1 | \
  grep -i "expand\|resize\|error" | tail -20
```

Common causes:
- AWS API throttling — check for `RequestLimitExceeded` errors in the plugin logs.
- Volume is in an error state in the cloud provider console.
- The CSI controller pod is restarting due to OOM or liveness probe failure.

### Symptom: "requested size is less than current size" Error

You attempted to shrink a PVC. Kubernetes does not support volume shrinking:

```
error: persistentvolumeclaims "data-postgresql-0" is invalid: spec.resources.requests.storage: Invalid value: resource.Quantity: field is immutable
```

There is no automatic path to reduce PVC size. You must provision a new, smaller PVC, copy the data, and switch the application.

### Resetting a Stuck PVC Resize Condition

In rare cases, the PVC condition can become stale. Force a reconciliation by annotating the PVC:

```bash
# Remove the resize condition to force re-evaluation
kubectl -n production patch pvc data-postgresql-0 \
  --type=json \
  -p '[
    {
      "op": "remove",
      "path": "/status/conditions"
    }
  ]'
```

Note: This requires patching the status subresource directly, which normally requires admin access.

## Section 8: Monitoring Volume Expansion in Production

### Prometheus Alert for Stuck Resize Operations

```yaml
# prometheus-rules-pvc-resize.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pvc-resize-alerts
  namespace: monitoring
spec:
  groups:
  - name: pvc-resize
    interval: 60s
    rules:
    - alert: PVCResizeStuck
      expr: |
        kube_persistentvolumeclaim_status_condition{
          condition="FileSystemResizePending",
          status="true"
        } > 0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "PVC filesystem resize pending for more than 15 minutes"
        description: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} has been waiting for filesystem resize for more than 15 minutes. Check the CSI node plugin on the node where the pod is scheduled."

    - alert: PVCHighUsage
      expr: |
        (
          kubelet_volume_stats_used_bytes /
          kubelet_volume_stats_capacity_bytes
        ) * 100 > 85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PVC usage above 85%"
        description: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is {{ $value | printf \"%.1f\" }}% full. Consider expanding before it reaches capacity."

    - alert: PVCCriticalUsage
      expr: |
        (
          kubelet_volume_stats_used_bytes /
          kubelet_volume_stats_capacity_bytes
        ) * 100 > 95
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "PVC usage above 95% - immediate action required"
        description: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is {{ $value | printf \"%.1f\" }}% full. Expand immediately to prevent application failure."
```

### Grafana Dashboard Query

To build a dashboard panel showing PVC capacity trends:

```promql
# Current PVC usage percentage
(
  kubelet_volume_stats_used_bytes{namespace="production"}
  / kubelet_volume_stats_capacity_bytes{namespace="production"}
) * 100

# Time until PVC is full (linear prediction over 24 hours)
(
  kubelet_volume_stats_capacity_bytes{namespace="production"}
  - kubelet_volume_stats_used_bytes{namespace="production"}
) / deriv(kubelet_volume_stats_used_bytes{namespace="production"}[24h])
```

## Section 9: Automating PVC Expansion with a Controller

For large-scale environments, manual PVC patching is error-prone. A simple controller can automate expansion based on usage thresholds.

### PVC Auto-Expander Script (Kubernetes CronJob)

```yaml
# pvc-auto-expander-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pvc-auto-expander
  namespace: kube-system
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: pvc-auto-expander
          restartPolicy: OnFailure
          containers:
          - name: expander
            image: bitnami/kubectl:latest
            env:
            - name: EXPANSION_THRESHOLD
              value: "80"
            - name: EXPANSION_INCREMENT_GI
              value: "50"
            - name: MAX_SIZE_GI
              value: "2000"
            command:
            - /bin/bash
            - -c
            - |
              #!/bin/bash
              set -euo pipefail

              THRESHOLD="${EXPANSION_THRESHOLD:-80}"
              INCREMENT="${EXPANSION_INCREMENT_GI:-50}"
              MAX="${MAX_SIZE_GI:-2000}"

              echo "PVC Auto-Expander starting at $(date)"
              echo "Threshold: ${THRESHOLD}%, Increment: ${INCREMENT}Gi, Max: ${MAX}Gi"

              # Get all PVCs with high usage from Prometheus
              # This requires access to the Prometheus API
              PROMETHEUS_URL="http://prometheus-operated.monitoring.svc.cluster.local:9090"

              QUERY="(kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) * 100 > ${THRESHOLD}"

              HIGH_USAGE_PVCS=$(curl -sf \
                "${PROMETHEUS_URL}/api/v1/query?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${QUERY}'))")" | \
                python3 -c "
              import json, sys
              data = json.load(sys.stdin)
              for result in data['data']['result']:
                  ns = result['metric'].get('namespace', '')
                  pvc = result['metric'].get('persistentvolumeclaim', '')
                  usage = float(result['value'][1])
                  print(f'{ns} {pvc} {usage:.1f}')
              ")

              if [ -z "${HIGH_USAGE_PVCS}" ]; then
                echo "No PVCs above threshold. Exiting."
                exit 0
              fi

              echo "PVCs requiring expansion:"
              echo "${HIGH_USAGE_PVCS}"

              while IFS=' ' read -r namespace pvc_name usage; do
                [ -z "${namespace}" ] && continue

                # Get current capacity in Gi
                CURRENT_SIZE=$(kubectl -n "${namespace}" get pvc "${pvc_name}" \
                  -o jsonpath='{.spec.resources.requests.storage}' | \
                  sed 's/Gi//')

                NEW_SIZE=$((CURRENT_SIZE + INCREMENT))

                if [ "${NEW_SIZE}" -gt "${MAX}" ]; then
                  echo "WARNING: PVC ${namespace}/${pvc_name} would exceed max size. Current: ${CURRENT_SIZE}Gi, Would be: ${NEW_SIZE}Gi, Max: ${MAX}Gi"
                  continue
                fi

                echo "Expanding ${namespace}/${pvc_name}: ${CURRENT_SIZE}Gi -> ${NEW_SIZE}Gi (usage: ${usage}%)"

                kubectl -n "${namespace}" patch pvc "${pvc_name}" \
                  --type=merge \
                  -p "{\"spec\": {\"resources\": {\"requests\": {\"storage\": \"${NEW_SIZE}Gi\"}}}}"

                echo "Expansion requested for ${namespace}/${pvc_name}"
              done <<< "${HIGH_USAGE_PVCS}"
```

```yaml
# pvc-auto-expander-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pvc-auto-expander
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pvc-auto-expander
rules:
- apiGroups: [""]
  resources: ["persistentvolumeclaims"]
  verbs: ["get", "list", "watch", "patch", "update"]
- apiGroups: [""]
  resources: ["persistentvolumes"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: pvc-auto-expander
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: pvc-auto-expander
subjects:
- kind: ServiceAccount
  name: pvc-auto-expander
  namespace: kube-system
```

## Section 10: Best Practices and Operational Runbook

### Pre-Expansion Checklist

Before expanding any production PVC:

```bash
#!/bin/bash
# pre-expansion-check.sh
NAMESPACE="$1"
PVC_NAME="$2"
NEW_SIZE="$3"

echo "=== Pre-Expansion Check ==="
echo "PVC: ${NAMESPACE}/${PVC_NAME}"
echo "Requested size: ${NEW_SIZE}"

# 1. Verify PVC exists and is Bound
STATUS=$(kubectl -n "${NAMESPACE}" get pvc "${PVC_NAME}" \
  -o jsonpath='{.status.phase}')
echo "Current status: ${STATUS}"
[ "${STATUS}" != "Bound" ] && echo "ERROR: PVC is not Bound" && exit 1

# 2. Get current size and verify increase
CURRENT_SIZE=$(kubectl -n "${NAMESPACE}" get pvc "${PVC_NAME}" \
  -o jsonpath='{.spec.resources.requests.storage}')
echo "Current size: ${CURRENT_SIZE}"

# 3. Verify StorageClass allows expansion
SC=$(kubectl -n "${NAMESPACE}" get pvc "${PVC_NAME}" \
  -o jsonpath='{.spec.storageClassName}')
EXPANSION_ALLOWED=$(kubectl get storageclass "${SC}" \
  -o jsonpath='{.allowVolumeExpansion}')
echo "StorageClass ${SC} allowVolumeExpansion: ${EXPANSION_ALLOWED}"
[ "${EXPANSION_ALLOWED}" != "true" ] && echo "ERROR: StorageClass does not allow expansion" && exit 1

# 4. Find the pod using this PVC
echo "Pods using this PVC:"
kubectl -n "${NAMESPACE}" get pods -o json | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for pod in data['items']:
    for vol in pod.get('spec', {}).get('volumes', []):
        pvc = vol.get('persistentVolumeClaim', {}).get('claimName', '')
        if pvc == '${PVC_NAME}':
            print(f\"  {pod['metadata']['name']} (node: {pod.get('spec', {}).get('nodeName', 'unscheduled')})\")
"

# 5. Check the PV
PV=$(kubectl -n "${NAMESPACE}" get pvc "${PVC_NAME}" \
  -o jsonpath='{.spec.volumeName}')
echo "Backing PV: ${PV}"
kubectl get pv "${PV}" -o \
  custom-columns=NAME:.metadata.name,CAPACITY:.spec.capacity.storage,STORAGECLASS:.spec.storageClassName,DRIVER:.spec.csi.driver

echo "=== Check Complete - Safe to proceed ==="
```

### Post-Expansion Verification Script

```bash
#!/bin/bash
# post-expansion-verify.sh
NAMESPACE="$1"
PVC_NAME="$2"
EXPECTED_SIZE="$3"
TIMEOUT="${4:-300}"

echo "=== Post-Expansion Verification ==="
echo "Waiting up to ${TIMEOUT}s for ${NAMESPACE}/${PVC_NAME} to reach ${EXPECTED_SIZE}..."

START=$(date +%s)
while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))

  if [ "${ELAPSED}" -gt "${TIMEOUT}" ]; then
    echo "TIMEOUT: Resize did not complete within ${TIMEOUT}s"
    kubectl -n "${NAMESPACE}" describe pvc "${PVC_NAME}"
    exit 1
  fi

  # Check if the PV capacity has been updated
  PV=$(kubectl -n "${NAMESPACE}" get pvc "${PVC_NAME}" \
    -o jsonpath='{.spec.volumeName}')
  PV_CAPACITY=$(kubectl get pv "${PV}" \
    -o jsonpath='{.spec.capacity.storage}' 2>/dev/null || echo "")
  PVC_CAPACITY=$(kubectl -n "${NAMESPACE}" get pvc "${PVC_NAME}" \
    -o jsonpath='{.status.capacity.storage}')

  CONDITIONS=$(kubectl -n "${NAMESPACE}" get pvc "${PVC_NAME}" \
    -o jsonpath='{.status.conditions[*].type}')

  echo "[${ELAPSED}s] PV capacity: ${PV_CAPACITY}, PVC status capacity: ${PVC_CAPACITY}, Conditions: ${CONDITIONS}"

  if [ "${PVC_CAPACITY}" == "${EXPECTED_SIZE}" ] && \
     ! echo "${CONDITIONS}" | grep -q "FileSystemResizePending"; then
    echo "SUCCESS: PVC has been expanded to ${EXPECTED_SIZE}"
    break
  fi

  sleep 10
done
```

### Key Takeaways

- Always verify `allowVolumeExpansion: true` on the StorageClass before attempting to expand any PVC.
- For StatefulSets, patch each PVC individually — the StatefulSet controller does not propagate PVC changes.
- Online expansion requires both the CSI controller plugin (to expand the backing storage) and the CSI node plugin on the pod's node (to resize the filesystem).
- ext4 uses `resize2fs` and xfs uses `xfs_growfs` — the CSI driver handles these automatically for supported drivers.
- Monitor for `FileSystemResizePending` conditions that persist longer than 15 minutes as an indicator of stuck resize operations.
- Set up PVC capacity alerts at 85% and 95% to provide adequate lead time for expansion before applications start failing.
