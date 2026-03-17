---
title: "Kubernetes Longhorn v1.7 Advanced Configuration: Data Locality, Replica Scheduling, and Cross-Zone Disaster Recovery"
date: 2031-10-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Longhorn", "Storage", "Disaster Recovery", "CSI", "Persistent Volumes"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Longhorn v1.7 covering data locality policies, replica scheduling across failure domains, snapshot and backup automation, and cross-zone disaster recovery for production Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-longhorn-v17-advanced-configuration-data-locality-replica-scheduling-disaster-recovery/"
---

Longhorn v1.7 introduces a range of production-hardening features that change how operators approach persistent storage in Kubernetes. Data locality enforcement, topology-aware replica scheduling, and tightly integrated backup orchestration make Longhorn a credible choice for stateful workloads that previously required expensive enterprise SAN solutions. This guide covers each feature at the configuration level, including the YAML you need to deploy and the reasoning behind every parameter choice.

<!--more-->

# Kubernetes Longhorn v1.7 Advanced Configuration

## Section 1: Longhorn Architecture Refresher

Before diving into v1.7 specifics, a brief recap of the Longhorn data plane is essential for understanding why the new scheduling parameters matter.

Longhorn stores volume data as sparse files distributed across worker nodes. Each volume consists of a frontend (the block device presented to the pod) served by an instance manager process and one or more replicas written to local disk on designated storage nodes. The Longhorn manager DaemonSet coordinates scheduling decisions using information stored in Kubernetes custom resources.

```
┌─────────────────────────────────────────────────────────────────┐
│  Pod (consumer)                                                 │
│    └─ /dev/longhorn/pvc-abc123  (tgt or nvme-tcp frontend)     │
├─────────────────────────────────────────────────────────────────┤
│  Instance Manager (per node)                                    │
│    └─ engine process ──► replica on node-1 (zone-a)            │
│                      ──► replica on node-2 (zone-b)            │
│                      ──► replica on node-3 (zone-c)            │
└─────────────────────────────────────────────────────────────────┘
```

Longhorn CR hierarchy:

- `Volume` - logical volume, owns settings
- `Engine` - active data path per volume
- `Replica` - individual replica scheduled on a node
- `BackingImage` - base layer for volumes
- `RecurringJob` - scheduled snapshots and backups

## Section 2: Installing Longhorn v1.7

### Prerequisites

```bash
# Verify open-iscsi and nfs-common on all nodes
ansible all -m shell -a "systemctl is-active iscsid" -i inventory.ini

# Check kernel modules
ansible all -m shell -a "lsmod | grep -E 'iscsi_tcp|dm_crypt|nbd'" -i inventory.ini

# Confirm longhorn-iscsi-installation daemonset readiness beforehand
kubectl apply -f https://raw.githubusercontent.com/longhorn/longhorn/v1.7.0/deploy/prerequisite/longhorn-iscsi-installation.yaml
kubectl rollout status daemonset/longhorn-iscsi-installation -n longhorn-system
```

### Helm-based Installation with Production Values

```yaml
# longhorn-values.yaml
defaultSettings:
  backupTarget: "s3://longhorn-backups-prod@us-east-1/"
  backupTargetCredentialSecret: longhorn-s3-secret
  defaultReplicaCount: 3
  replicaSoftAntiAffinity: true
  replicaZoneSoftAntiAffinity: false        # hard zone anti-affinity
  nodeDownPodDeletionPolicy: delete-both-statefulset-and-deployment-pod
  defaultDataLocality: best-effort
  autoSalvage: true
  autoDeletePodWhenVolumeDetachedUnexpectedly: true
  disableSchedulingOnCordonedNode: true
  replicaReplenishmentWaitInterval: 600     # 10 min before replacing lost replica
  concurrentReplicaRebuildPerNodeLimit: 2
  concurrentVolumeBackupRestorePerNodeLimit: 2
  backingImageCleanupWaitInterval: 60
  storageMinimalAvailablePercentage: 15
  upgradeChecker: false
  defaultLonghornStaticStorageClass: longhorn-static
  kubernetesClusterAutoscalerEnabled: true
  orphanAutoDeletion: true
  snapshotDataIntegrity: fast-check
  snapshotDataIntegrityImmediateCheckAfterSnapshotCreation: false
  snapshotDataIntegrityCronjob: "0 3 */7 * *"
  removeSnapshotsDuringFilesystemTrim: enabled
  fastReplicaRebuildEnabled: true
  replicaFileSyncHttpClientTimeout: 30
  logLevel: Info

persistence:
  defaultClass: true
  defaultClassReplicaCount: 3
  defaultFsType: ext4
  defaultMkfsParams: "-O ^64bit"            # avoid 64-bit ext4 for some kernels
  reclaimPolicy: Retain
  migratable: false
  recurringJobSelector:
    enable: false

ingress:
  enabled: true
  ingressClassName: nginx
  host: longhorn.internal.example.com
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: longhorn-basic-auth

longhornUI:
  replicas: 2

csi:
  attacherReplicaCount: 3
  provisionerReplicaCount: 3
  resizerReplicaCount: 3
  snapshotterReplicaCount: 3

resources:
  limits:
    cpu: 200m
    memory: 256Mi
```

```bash
helm repo add longhorn https://charts.longhorn.io
helm repo update

kubectl create namespace longhorn-system

kubectl create secret generic longhorn-s3-secret \
  --from-literal=AWS_ACCESS_KEY_ID=<aws-access-key-id> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<aws-secret-access-key> \
  --from-literal=AWS_ENDPOINTS=https://s3.us-east-1.amazonaws.com \
  -n longhorn-system

helm upgrade --install longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --version 1.7.0 \
  -f longhorn-values.yaml \
  --wait --timeout 10m
```

## Section 3: Data Locality in Depth

Data locality controls where the active engine schedules I/O relative to the pod consuming the volume. Longhorn v1.7 exposes four modes:

| Mode | Description | Use Case |
|------|-------------|----------|
| `disabled` | No preference; engine can be anywhere | Stateless-like workloads |
| `best-effort` | Try to schedule a replica on the same node as the pod | General production |
| `strict-local` | Require a local replica; fail scheduling if impossible | Latency-sensitive databases |
| `prefer-local-replica-only` | New in v1.7; prefer local, fall back to best-effort | Mixed workload clusters |

### Setting Data Locality per StorageClass

```yaml
# storageclass-strict.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-strict-local
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "2880"
  dataLocality: "strict-local"
  fsType: "ext4"
  diskSelector: "nvme"
  nodeSelector: "storage"
  recurringJobSelector: '[{"name":"daily-snapshot","isGroup":false},{"name":"weekly-backup","isGroup":false}]'
```

```yaml
# storageclass-best-effort.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-best-effort
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "2880"
  dataLocality: "best-effort"
  fsType: "xfs"
```

### Verifying Data Locality at Runtime

```bash
# Check whether the current engine has a local replica
kubectl -n longhorn-system get volume pvc-abc123def456 -o json | \
  jq '.status.currentNodeID, .spec.dataLocality, .status.robustness'

# Watch replica placement
kubectl -n longhorn-system get replica \
  -l longhornvolume=pvc-abc123def456 \
  -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeID,DISK:.spec.diskID,MODE:.status.currentState'
```

## Section 4: Topology-Aware Replica Scheduling

### Labeling Nodes with Zone and Region

Longhorn reads standard Kubernetes topology labels. Ensure they are set before installing Longhorn.

```bash
# Label nodes with zone information
kubectl label node node-01 topology.kubernetes.io/zone=us-east-1a topology.kubernetes.io/region=us-east-1
kubectl label node node-02 topology.kubernetes.io/zone=us-east-1b topology.kubernetes.io/region=us-east-1
kubectl label node node-03 topology.kubernetes.io/zone=us-east-1c topology.kubernetes.io/region=us-east-1
kubectl label node node-04 topology.kubernetes.io/zone=us-east-1a topology.kubernetes.io/region=us-east-1
kubectl label node node-05 topology.kubernetes.io/zone=us-east-1b topology.kubernetes.io/region=us-east-1
kubectl label node node-06 topology.kubernetes.io/zone=us-east-1c topology.kubernetes.io/region=us-east-1
```

### Hard Zone Anti-Affinity Configuration

With `replicaZoneSoftAntiAffinity: false`, Longhorn refuses to place two replicas in the same zone. This guarantees zone-level fault tolerance but means that a three-replica volume requires at least three distinct zones.

```yaml
# Patch the global setting via the API
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: replica-zone-soft-anti-affinity
  namespace: longhorn-system
spec:
  value: "false"
```

```bash
kubectl apply -f - <<'EOF'
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: replica-zone-soft-anti-affinity
  namespace: longhorn-system
spec:
  value: "false"
EOF
```

### Disk Selectors for Dedicated Storage Tiers

```bash
# Tag nodes with disk types
kubectl -n longhorn-system edit node node-01
# Add to spec.disks.<disk-id>.tags: ["nvme", "fast"]

# Or use the Longhorn Node API via curl
NODE_IP=$(kubectl -n longhorn-system get svc longhorn-backend -o jsonpath='{.spec.clusterIP}')
curl -X PUT "http://${NODE_IP}:9500/v1/nodes/node-01" \
  -H "Content-Type: application/json" \
  -d '{"disks":{"disk-abc":{"path":"/var/lib/longhorn","allowScheduling":true,"tags":["nvme","fast"],"storageReserved":10737418240}}}'
```

```yaml
# StorageClass targeting NVMe disks only
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-nvme
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "3"
  diskSelector: "nvme"
  nodeSelector: "storage"
  dataLocality: "best-effort"
  fsType: "xfs"
  mkfsParams: "-f -b size=4096"
```

## Section 5: Snapshot and Backup Automation

### RecurringJob CRDs

Longhorn v1.7 decouples recurring jobs from StorageClasses via dedicated CRDs.

```yaml
# recurring-jobs.yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-snapshot
  namespace: longhorn-system
spec:
  cron: "0 1 * * *"
  task: snapshot
  groups:
    - default
  retain: 7
  concurrency: 2
  labels:
    type: daily
---
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: weekly-backup
  namespace: longhorn-system
spec:
  cron: "0 2 * * 0"
  task: backup
  groups:
    - default
  retain: 4
  concurrency: 1
  labels:
    type: weekly
---
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: hourly-snapshot-databases
  namespace: longhorn-system
spec:
  cron: "0 * * * *"
  task: snapshot
  groups:
    - databases
  retain: 24
  concurrency: 3
  labels:
    type: hourly
    tier: database
```

### Attaching RecurringJob Groups to Volumes via Annotations

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
  annotations:
    recurring-job-group.longhorn.io/databases: enabled
    recurring-job.longhorn.io/weekly-backup: enabled
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-nvme
  resources:
    requests:
      storage: 500Gi
```

### Backup Verification with Checksum

```bash
# List backups for a volume
kubectl -n longhorn-system exec -it \
  $(kubectl -n longhorn-system get pod -l app=longhorn-manager --field-selector spec.nodeName=node-01 -o name | head -1) \
  -- longhorn-manager backup list --volume-name pvc-abc123def456

# Trigger an on-demand backup
kubectl apply -f - <<'EOF'
apiVersion: longhorn.io/v1beta2
kind: Backup
metadata:
  name: manual-backup-20311016
  namespace: longhorn-system
spec:
  snapshotName: snapshot-20311016-0100
  labels:
    trigger: manual
    operator: ops-team
EOF
```

## Section 6: Cross-Zone Disaster Recovery

### DR Volume Configuration

Longhorn v1.7 introduces first-class DR volume support. A DR volume continuously receives incremental backups from a source volume in another cluster.

```yaml
# dr-volume.yaml - applied in the DR cluster
apiVersion: longhorn.io/v1beta2
kind: Volume
metadata:
  name: postgres-data-dr
  namespace: longhorn-system
spec:
  size: "536870912000"         # 500Gi in bytes
  numberOfReplicas: 3
  dataLocality: best-effort
  replicaAutoBalance: best-effort
  standby: true                # This is the DR flag
  fromBackup: "s3://longhorn-backups-prod@us-east-1/?backup=backup-abc123&volume=pvc-abc123def456"
  diskSelector: []
  nodeSelector: []
  engineImage: longhornio/longhorn-engine:v1.7.0
```

```bash
# Activate the DR volume during failover
kubectl -n longhorn-system patch volume postgres-data-dr \
  --type merge \
  -p '{"spec":{"standby":false}}'

# Wait for activation
kubectl -n longhorn-system get volume postgres-data-dr -w
```

### Multi-Cluster Backup Strategy Script

```bash
#!/usr/bin/env bash
# dr-failover.sh - Orchestrates Longhorn DR volume activation
set -euo pipefail

DR_NAMESPACE="longhorn-system"
DR_KUBECONFIG="/etc/kubernetes/dr-cluster.kubeconfig"
PROD_KUBECONFIG="/etc/kubernetes/prod-cluster.kubeconfig"
VOLUME_NAME="postgres-data-dr"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Step 1: Verify source cluster is unreachable
log "Checking production cluster health..."
if kubectl --kubeconfig="${PROD_KUBECONFIG}" get nodes --request-timeout=10s &>/dev/null; then
  log "ERROR: Production cluster is still reachable. Aborting failover."
  exit 1
fi

# Step 2: Check DR volume is in standby with recent restore point
log "Checking DR volume status..."
LAST_BACKUP=$(kubectl --kubeconfig="${DR_KUBECONFIG}" \
  -n "${DR_NAMESPACE}" get volume "${VOLUME_NAME}" \
  -o jsonpath='{.status.lastBackup}')
log "Last backup restore point: ${LAST_BACKUP}"

# Step 3: Activate DR volume
log "Activating DR volume..."
kubectl --kubeconfig="${DR_KUBECONFIG}" \
  -n "${DR_NAMESPACE}" patch volume "${VOLUME_NAME}" \
  --type merge \
  -p '{"spec":{"standby":false}}'

# Step 4: Wait for volume to become healthy
log "Waiting for volume to reach healthy state..."
for i in $(seq 1 60); do
  STATE=$(kubectl --kubeconfig="${DR_KUBECONFIG}" \
    -n "${DR_NAMESPACE}" get volume "${VOLUME_NAME}" \
    -o jsonpath='{.status.state}')
  ROBUSTNESS=$(kubectl --kubeconfig="${DR_KUBECONFIG}" \
    -n "${DR_NAMESPACE}" get volume "${VOLUME_NAME}" \
    -o jsonpath='{.status.robustness}')
  log "Attempt ${i}: state=${STATE} robustness=${ROBUSTNESS}"
  if [[ "${STATE}" == "detached" && "${ROBUSTNESS}" == "healthy" ]]; then
    log "DR volume is healthy and ready for attachment."
    break
  fi
  sleep 10
done

# Step 5: Create PV/PVC in DR cluster
log "Creating PersistentVolume in DR cluster..."
kubectl --kubeconfig="${DR_KUBECONFIG}" apply -f - <<EOF
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-data-dr-pv
spec:
  capacity:
    storage: 500Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: longhorn
  csi:
    driver: driver.longhorn.io
    fsType: xfs
    volumeHandle: postgres-data-dr
    volumeAttributes:
      numberOfReplicas: "3"
      staleReplicaTimeout: "2880"
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  volumeName: postgres-data-dr-pv
  resources:
    requests:
      storage: 500Gi
EOF

log "Failover complete. Deploy application workloads to DR cluster."
```

## Section 7: Volume Expansion and Live Migration

### Online Volume Expansion

```bash
# Expand a PVC (Longhorn supports online expansion)
kubectl patch pvc postgres-data -n production \
  --type merge \
  -p '{"spec":{"resources":{"requests":{"storage":"750Gi"}}}}'

# Monitor expansion progress
kubectl -n longhorn-system get volume pvc-abc123def456 -w \
  -o custom-columns='NAME:.metadata.name,SIZE:.spec.size,STATE:.status.state,ROBUSTNESS:.status.robustness'
```

### Volume Migration Between Nodes

```bash
# Evict replicas from a node scheduled for maintenance
kubectl -n longhorn-system patch node node-03 \
  --type merge \
  -p '{"spec":{"allowScheduling":false,"evictionRequested":true}}'

# Monitor replica migration
watch -n5 'kubectl -n longhorn-system get replica \
  -o custom-columns="NAME:.metadata.name,NODE:.spec.nodeID,STATE:.status.currentState" | sort -k2'
```

## Section 8: Monitoring and Alerting

### Prometheus ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: longhorn
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: longhorn-manager
  namespaceSelector:
    matchNames:
      - longhorn-system
  endpoints:
    - port: manager
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
```

### Critical Alerts

```yaml
# longhorn-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: longhorn.critical
      interval: 30s
      rules:
        - alert: LonghornVolumeUnhealthy
          expr: longhorn_volume_robustness{robustness!="healthy"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Longhorn volume {{ $labels.volume }} is {{ $labels.robustness }}"
            description: "Volume {{ $labels.volume }} on node {{ $labels.node }} has robustness {{ $labels.robustness }} for 5 minutes."

        - alert: LonghornNodeStorageFull
          expr: (longhorn_node_storage_usage_bytes / longhorn_node_storage_capacity_bytes) > 0.85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Longhorn node {{ $labels.node }} storage above 85%"
            description: "Node {{ $labels.node }} has {{ $value | humanizePercentage }} storage utilization."

        - alert: LonghornReplicaCountTooLow
          expr: longhorn_volume_actual_size_bytes > 0 unless longhorn_replica_count_status{state="running"} >= 2
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: "Longhorn volume {{ $labels.volume }} has insufficient replicas"

        - alert: LonghornBackupFailed
          expr: longhorn_backup_state{state="Error"} == 1
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Longhorn backup failed for volume {{ $labels.volume }}"

        - alert: LonghornDiskPressure
          expr: (longhorn_disk_storage_available_bytes / longhorn_disk_storage_capacity_bytes) < 0.15
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Longhorn disk on {{ $labels.node }} has less than 15% free"
```

## Section 9: Performance Tuning

### NVMe-oF Frontend (v1.7)

Longhorn v1.7 adds experimental NVMe-oF/TCP support as an alternative to iSCSI, reducing CPU overhead significantly.

```yaml
# Enable NVMe-oF frontend globally
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: v2-data-engine
  namespace: longhorn-system
spec:
  value: "true"
```

```yaml
# StorageClass using v2 data engine with NVMe-oF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-nvmeof
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "3"
  dataEngine: "v2"
  fsType: "xfs"
  dataLocality: "strict-local"
```

### Replica Rebuild Throttle

```bash
# Limit rebuild bandwidth to 50 MiB/s to avoid saturating cluster network
kubectl apply -f - <<'EOF'
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: storage-network-for-replication-enabled
  namespace: longhorn-system
spec:
  value: "true"
---
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: concurrent-replica-rebuild-per-node-limit
  namespace: longhorn-system
spec:
  value: "2"
EOF
```

## Section 10: Troubleshooting Common Issues

### Volume Stuck in Attaching State

```bash
# Diagnose instance manager health
kubectl -n longhorn-system get instancemanager -o wide

# Check for orphaned engine processes
kubectl -n longhorn-system logs \
  $(kubectl -n longhorn-system get pod -l longhorn.io/component=instance-manager \
    --field-selector spec.nodeName=node-01 -o name | head -1) \
  | grep -E "ERROR|WARN|engine" | tail -50

# Force detach (use with caution)
kubectl -n longhorn-system patch volume pvc-stuck-volume \
  --type merge \
  -p '{"spec":{"nodeID":""}}'
```

### Replica Rebalancing After Node Recovery

```bash
# Check replica auto-balance setting
kubectl -n longhorn-system get setting replica-auto-balance -o jsonpath='{.spec.value}'

# Trigger manual rebalance for a specific volume
kubectl -n longhorn-system patch volume pvc-abc123def456 \
  --type merge \
  -p '{"spec":{"replicaAutoBalance":"best-effort"}}'

# List unbalanced volumes
kubectl -n longhorn-system get volume -o json | \
  jq -r '.items[] | select(.status.conditions[] | select(.type=="Scheduled" and .status=="False")) | .metadata.name'
```

### Snapshot Chain Corruption Recovery

```bash
# List all snapshots for a volume
kubectl -n longhorn-system get snapshot \
  -l longhornvolume=pvc-abc123def456 \
  --sort-by=.metadata.creationTimestamp

# Remove a corrupted snapshot
kubectl -n longhorn-system delete snapshot snapshot-corrupted-20311015

# Trigger integrity check
kubectl apply -f - <<'EOF'
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: snapshot-data-integrity
  namespace: longhorn-system
spec:
  value: "fast-check"
EOF
```

## Section 11: Upgrade Procedure from v1.6

```bash
#!/usr/bin/env bash
# upgrade-longhorn.sh
set -euo pipefail

OLD_VERSION="1.6.2"
NEW_VERSION="1.7.0"

echo "Pre-upgrade: verifying all volumes are healthy..."
UNHEALTHY=$(kubectl -n longhorn-system get volume \
  -o jsonpath='{.items[?(@.status.robustness!="healthy")].metadata.name}')
if [[ -n "${UNHEALTHY}" ]]; then
  echo "ERROR: Unhealthy volumes found: ${UNHEALTHY}"
  exit 1
fi

echo "Upgrading Longhorn from ${OLD_VERSION} to ${NEW_VERSION}..."
helm upgrade longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --version "${NEW_VERSION}" \
  -f longhorn-values.yaml \
  --wait --timeout 15m

echo "Waiting for manager rollout..."
kubectl -n longhorn-system rollout status daemonset/longhorn-manager

echo "Verifying engine image upgrade..."
kubectl -n longhorn-system get engineimage -o wide

echo "Upgrade complete. Monitor volumes:"
kubectl -n longhorn-system get volume -o wide
```

## Summary

Longhorn v1.7 represents a significant maturation in cloud-native block storage. The combination of hard zone anti-affinity, data locality enforcement, NVMe-oF frontend support, and first-class DR volumes addresses the majority of enterprise storage requirements within a fully Kubernetes-native model. The key production takeaways are:

- Use `replicaZoneSoftAntiAffinity: false` in any multi-zone cluster to guarantee zone-level fault tolerance
- Apply `strict-local` data locality only to latency-sensitive workloads; `best-effort` handles the majority of cases
- Automate snapshot and backup orchestration through RecurringJob CRDs rather than StorageClass annotations
- Implement DR volumes in a secondary cluster with a separate S3 bucket and test activation quarterly
- Monitor `longhorn_volume_robustness` and `longhorn_disk_storage_available_bytes` as the two most critical production metrics
