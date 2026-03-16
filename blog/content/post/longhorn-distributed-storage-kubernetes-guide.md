---
title: "Longhorn Distributed Block Storage: Replicas, Backup, and Node Maintenance"
date: 2027-07-27T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Storage", "Block Storage", "Backup"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide for Longhorn distributed block storage on Kubernetes. Covers replica placement, S3 and NFS backup, recurring jobs, node drain procedures, disk management, StorageClass configuration, and upgrade procedures."
more_link: "yes"
url: "/longhorn-distributed-storage-kubernetes-guide/"
---

Longhorn is a lightweight, cloud-native distributed block storage system built specifically for Kubernetes. Unlike Rook-Ceph, which runs a full Ceph stack, Longhorn takes a microservice approach: each volume gets its own engine and replica processes, keeping blast radius small and making operational procedures straightforward. This guide covers the full Longhorn lifecycle for production clusters: architecture, installation, backup configuration, node maintenance, and upgrading.

<!--more-->

## Longhorn Architecture

Longhorn decomposes distributed storage into per-volume processes rather than cluster-wide daemons:

```
┌─────────────────────────────────────────────────────────────┐
│  Kubernetes Node (worker)                                    │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ longhorn-manager  │    │ instance-manager-e            │   │
│  │ (DaemonSet Pod)   │    │  └─ volume-A engine           │   │
│  │                   │    │  └─ volume-B engine           │   │
│  └──────────────────┘    └──────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ instance-manager-r                                    │   │
│  │  └─ replica for volume-A (sparse file on /var/lib/...) │   │
│  │  └─ replica for volume-B                              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

Control Plane:
┌──────────────────────┐  ┌──────────────────────────────────┐
│ longhorn-manager      │  │ longhorn-ui                       │
│ (reconciles CRDs)     │  │ (React dashboard)                │
└──────────────────────┘  └──────────────────────────────────┘

CSI:
┌────────────────────────────────────────────────────────────┐
│ longhorn-csi-plugin (DaemonSet) + longhorn-driver-deployer  │
└────────────────────────────────────────────────────────────┘
```

| Component | Role |
|---|---|
| longhorn-manager | DaemonSet; orchestrates volume lifecycle via CRDs |
| Engine | Per-volume; handles I/O and replication to replicas |
| Replica | Per-volume-per-node; stores data as sparse files |
| longhorn-ui | Web dashboard for operations |
| CSI plugin | Exposes volumes as PVCs to Kubernetes |

## Node Prerequisites

```bash
# Install required packages on all storage nodes
# Ubuntu / Debian
apt-get install -y open-iscsi nfs-common util-linux

# RHEL / CentOS / Rocky
yum install -y iscsi-initiator-utils nfs-utils util-linux

# Enable and start iscsid
systemctl enable --now iscsid

# Verify
iscsiadm --version
```

### Pre-flight Check Script

```bash
# Run Longhorn's environment check
curl -sSfL https://raw.githubusercontent.com/longhorn/longhorn/v1.7.2/scripts/environment_check.sh | bash
```

## Installation

### Via Helm

```bash
helm repo add longhorn https://charts.longhorn.io
helm repo update

# Create namespace and install
helm install longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --create-namespace \
  --version 1.7.2 \
  --set defaultSettings.defaultReplicaCount=3 \
  --set defaultSettings.defaultDataLocality=best-effort \
  --set defaultSettings.backupTarget=s3://longhorn-backups@us-east-1/ \
  --set defaultSettings.backupTargetCredentialSecret=longhorn-backup-secret \
  --set defaultSettings.storageOverProvisioningPercentage=200 \
  --set defaultSettings.storageMinimalAvailablePercentage=10 \
  --set defaultSettings.replicaSoftAntiAffinity=true \
  --set defaultSettings.replicaZoneSoftAntiAffinity=true \
  --set defaultSettings.nodeDownPodDeletionPolicy=delete-both-statefulset-and-deployment-pod \
  --set defaultSettings.concurrentAutomaticEngineUpgradePerNodeLimit=1 \
  --wait
```

### Backup Secret for S3

```yaml
# longhorn-backup-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: longhorn-backup-secret
  namespace: longhorn-system
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "REPLACE_WITH_ACCESS_KEY"
  AWS_SECRET_ACCESS_KEY: "REPLACE_WITH_SECRET_KEY"
  AWS_ENDPOINTS: ""        # Leave empty for AWS S3; set for MinIO
  AWS_CERT: ""             # CA cert for MinIO TLS
  VIRTUAL_HOSTED_STYLE: "false"
```

### Backup Secret for MinIO

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: longhorn-backup-secret
  namespace: longhorn-system
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "REPLACE_WITH_MINIO_ACCESS_KEY"
  AWS_SECRET_ACCESS_KEY: "REPLACE_WITH_MINIO_SECRET_KEY"
  AWS_ENDPOINTS: "https://minio.internal.example.com"
  VIRTUAL_HOSTED_STYLE: "false"
```

## StorageClass Configuration

### Default StorageClass

```yaml
# storageclass-longhorn-default.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "2880"   # minutes (48 hours)
  fromBackup: ""
  fsType: ext4
  diskSelector: ""
  nodeSelector: ""
  recurringJobSelector: '[{"name":"daily-backup","isGroup":false}]'
  dataLocality: best-effort
```

### High-Performance StorageClass (NVMe, 2 replicas)

```yaml
# storageclass-longhorn-fast.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-fast
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
parameters:
  numberOfReplicas: "2"
  staleReplicaTimeout: "1440"
  diskSelector: "nvme"
  nodeSelector: "storage"
  dataLocality: strict-local
  fsType: xfs
```

### Strict-Local StorageClass (No Network I/O)

```yaml
# storageclass-longhorn-local.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-local
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
parameters:
  numberOfReplicas: "1"
  dataLocality: strict-local
  fsType: ext4
```

## Volume Replica Placement Policies

### Anti-Affinity Settings

Longhorn provides two levels of replica anti-affinity:

- **Replica Node Level Soft Anti-Affinity** — tries to place replicas on different nodes but allows same-node if no alternative exists
- **Replica Zone Soft Anti-Affinity** — tries to place replicas in different availability zones

```bash
# Enable zone anti-affinity (requires topology labels on nodes)
kubectl patch setting replica-zone-soft-anti-affinity \
  -n longhorn-system \
  --type merge \
  -p '{"value":"true"}'

# Label nodes with zone topology
kubectl label node worker-1 topology.longhorn.io/zone=zone-a
kubectl label node worker-2 topology.longhorn.io/zone=zone-b
kubectl label node worker-3 topology.longhorn.io/zone=zone-c
```

### Disk Selectors

Tag specific disks for specific StorageClasses:

```bash
# Via UI or patch the node spec
kubectl patch node.longhorn.io worker-1 \
  -n longhorn-system \
  --type json \
  -p '[{"op":"replace","path":"/spec/disks/disk-nvme0n1/tags","value":["nvme","fast"]}]'
```

## Backup to S3 and NFS

### Configure Backup Target via Settings

```bash
# S3 backup target
kubectl patch setting backup-target \
  -n longhorn-system \
  --type merge \
  -p '{"value":"s3://longhorn-backups@us-east-1/"}'

# NFS backup target
kubectl patch setting backup-target \
  -n longhorn-system \
  --type merge \
  -p '{"value":"nfs://nas.internal.example.com:/mnt/longhorn-backups"}'
```

### Manual Volume Backup

```bash
# Create a backup for a specific volume
kubectl apply -f - <<'EOF'
apiVersion: longhorn.io/v1beta2
kind: Backup
metadata:
  name: postgres-vol-backup-manual
  namespace: longhorn-system
spec:
  snapshotName: ""   # empty = create new snapshot
  labels:
    app: postgres
    env: production
EOF

# Check backup status
kubectl get backup -n longhorn-system postgres-vol-backup-manual -w
```

## Recurring Backup Jobs

### Define a Recurring Job

```yaml
# recurring-job-daily.yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-backup
  namespace: longhorn-system
spec:
  cron: "0 3 * * *"      # 03:00 UTC daily
  task: backup
  groups:
    - default
  retain: 14              # keep 14 recovery points
  concurrency: 2
  labels:
    job: daily-backup
```

```yaml
# recurring-job-hourly-snapshot.yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: hourly-snapshot
  namespace: longhorn-system
spec:
  cron: "0 * * * *"
  task: snapshot
  groups:
    - default
  retain: 48
  concurrency: 3
  labels:
    job: hourly-snapshot
```

```yaml
# recurring-job-cleanup.yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: weekly-cleanup
  namespace: longhorn-system
spec:
  cron: "0 4 * * 0"      # Sunday 04:00 UTC
  task: snapshot-cleanup
  groups:
    - default
  retain: 0
  concurrency: 2
```

### Assign Jobs to a Volume

```yaml
# Apply recurring job groups to a PVC's volume via annotations
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: production
  annotations:
    recurring-job.longhorn.io/daily-backup: enabled
    recurring-job.longhorn.io/hourly-snapshot: enabled
    recurring-job-group.longhorn.io/default: enabled
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  resources:
    requests:
      storage: 100Gi
```

## Volume Snapshot and Restore

### Create a Snapshot

```bash
# Via VolumeSnapshot API (CSI)
kubectl apply -f - <<'EOF'
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-snapshot-20270727
  namespace: production
spec:
  volumeSnapshotClassName: longhorn-snapshot-vsc
  source:
    persistentVolumeClaimName: postgres-data
EOF

kubectl get volumesnapshot -n production postgres-snapshot-20270727 -w
```

### VolumeSnapshotClass

```yaml
# longhorn-snapshot-vsc.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-snapshot-vsc
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: driver.longhorn.io
deletionPolicy: Delete
parameters:
  type: snap
```

### Restore from Snapshot

```yaml
# Restore to a new PVC from a VolumeSnapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  dataSource:
    name: postgres-snapshot-20270727
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  resources:
    requests:
      storage: 100Gi
```

### Restore from Backup

```bash
# List available backups
kubectl get backup -n longhorn-system \
  -l longhorn.io/volume-name=pvc-12345678-abcd

# Create a volume from backup via StorageClass parameter
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-from-backup
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  dataSourceRef:
    apiGroup: longhorn.io
    kind: BackupVolume
    name: pvc-12345678-abcd
  resources:
    requests:
      storage: 100Gi
EOF
```

## Node Drain Procedures

Draining a Longhorn node requires coordination to avoid data loss when replicas go below the minimum count.

### Pre-Drain Steps

```bash
# Step 1: Check the current number of replicas per volume
kubectl get volume -n longhorn-system -o custom-columns=\
'NAME:.metadata.name,REPLICAS:.spec.numberOfReplicas,STATE:.status.state'

# Step 2: Disable scheduling on the node in Longhorn
kubectl patch node.longhorn.io worker-1 \
  -n longhorn-system \
  --type merge \
  -p '{"spec":{"allowScheduling":false}}'

# Step 3: Wait for Longhorn to evacuate replicas off the node
kubectl get replicas -n longhorn-system \
  --field-selector spec.nodeID=worker-1 \
  -w
# Wait until no replicas remain on worker-1

# Step 4: Standard Kubernetes drain
kubectl drain worker-1 \
  --ignore-daemonsets \
  --delete-emissary-local-data \
  --timeout=300s
```

### Post-Maintenance Re-Enable

```bash
# Uncordon the node
kubectl uncordon worker-1

# Re-enable scheduling in Longhorn
kubectl patch node.longhorn.io worker-1 \
  -n longhorn-system \
  --type merge \
  -p '{"spec":{"allowScheduling":true}}'

# Verify replica rebuilding has started
kubectl get replicas -n longhorn-system \
  --field-selector spec.nodeID=worker-1
```

### Automated Drain with Longhorn Node Drain Policy

```bash
# Set node drain policy to block-for-eviction (safest)
kubectl patch setting node-drain-policy \
  -n longhorn-system \
  --type merge \
  -p '{"value":"block-for-eviction"}'
```

Available policies:

| Policy | Description |
|---|---|
| `block-if-contains-last-replica` | Block drain if node has the last replica of any volume |
| `block-for-eviction` | Block until all replicas evacuated (safest) |
| `block-for-eviction-if-contains-last-replica` | Hybrid approach |
| `always-allow` | Never block drain (risky) |

## Disk Management

### Add a New Disk to a Node

```bash
# Format and mount the disk
mkfs.ext4 /dev/sdb
mkdir -p /mnt/longhorn-sdb
echo '/dev/sdb /mnt/longhorn-sdb ext4 defaults 0 0' >> /etc/fstab
mount -a

# Add disk to Longhorn node via patch
kubectl patch node.longhorn.io worker-1 \
  -n longhorn-system \
  --type json \
  -p '[{
    "op": "add",
    "path": "/spec/disks/disk-sdb",
    "value": {
      "path": "/mnt/longhorn-sdb",
      "allowScheduling": true,
      "evictionRequested": false,
      "storageReserved": 10737418240,
      "tags": ["hdd"]
    }
  }]'
```

### Remove a Disk

```bash
# Step 1: Disable scheduling on the disk
kubectl patch node.longhorn.io worker-1 \
  -n longhorn-system \
  --type json \
  -p '[{"op":"replace","path":"/spec/disks/disk-sdb/allowScheduling","value":false}]'

# Step 2: Request eviction of all replicas from the disk
kubectl patch node.longhorn.io worker-1 \
  -n longhorn-system \
  --type json \
  -p '[{"op":"replace","path":"/spec/disks/disk-sdb/evictionRequested","value":true}]'

# Step 3: Wait for replicas to migrate
kubectl get replicas -n longhorn-system -o wide | grep worker-1

# Step 4: Remove disk from node spec
kubectl patch node.longhorn.io worker-1 \
  -n longhorn-system \
  --type json \
  -p '[{"op":"remove","path":"/spec/disks/disk-sdb"}]'
```

## NFS Provisioner vs Longhorn

Longhorn provides ReadWriteOnce (RWO) block volumes. For ReadWriteMany (RWX) access, Longhorn includes a built-in NFS-backed share mechanism.

### Longhorn RWX Volumes

```yaml
# Longhorn supports RWX via NFS share manager
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-data
  namespace: production
spec:
  accessModes:
    - ReadWriteMany    # Longhorn converts to NFS-backed share
  storageClassName: longhorn
  resources:
    requests:
      storage: 50Gi
```

| Feature | Longhorn RWX | NFS Provisioner |
|---|---|---|
| Backup support | Native | Manual |
| Snapshot support | Yes | Depends on NFS server |
| Replica redundancy | Yes | Depends on NFS server HA |
| Performance | Good for most workloads | High for large sequential I/O |
| Operational complexity | Low | Higher (separate NFS server) |

## Longhorn UI Operations

The Longhorn UI provides a comprehensive operational dashboard accessible via:

```bash
# Port-forward the UI
kubectl port-forward -n longhorn-system svc/longhorn-frontend 8080:80

# Or create an Ingress
kubectl apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: longhorn-ui
  namespace: longhorn-system
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: longhorn-basic-auth
    nginx.ingress.kubernetes.io/auth-realm: "Longhorn"
spec:
  ingressClassName: nginx
  rules:
    - host: longhorn.internal.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: longhorn-frontend
                port:
                  number: 80
EOF
```

### Basic Auth for UI

```bash
htpasswd -c /tmp/auth admin
kubectl create secret generic longhorn-basic-auth \
  --from-file=/tmp/auth \
  -n longhorn-system
```

## Upgrading Longhorn

### Pre-Upgrade Checklist

```bash
# 1. Check all volumes are healthy
kubectl get volumes -n longhorn-system | grep -v healthy

# 2. Verify no replica rebuilding in progress
kubectl get replicas -n longhorn-system | grep rebuilding

# 3. Backup all critical volumes
kubectl get backups -n longhorn-system --sort-by=.metadata.creationTimestamp | tail -20
```

### Upgrade via Helm

```bash
helm repo update

# Check available versions
helm search repo longhorn/longhorn --versions | head -10

# Upgrade (1.6.x to 1.7.x example)
helm upgrade longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --version 1.7.2 \
  --reuse-values \
  --wait \
  --timeout 20m

# Monitor the upgrade
kubectl get pods -n longhorn-system -w
```

### Engine Upgrade

After a Longhorn system upgrade, existing volumes still run the old engine version. Upgrade engines via:

```bash
# List volumes with non-current engine version
kubectl get engineimage -n longhorn-system
kubectl get volume -n longhorn-system \
  -o custom-columns='NAME:.metadata.name,ENGINE:.status.currentImage'

# Trigger engine upgrade for a volume
kubectl patch volume pvc-12345678 \
  -n longhorn-system \
  --type merge \
  -p '{"spec":{"engineImage":"longhornio/longhorn-engine:v1.7.2"}}'
```

## Replica Rebuilding

When a node goes down temporarily, Longhorn marks affected replicas as failed and begins rebuilding from healthy replicas.

```bash
# Monitor rebuild progress
kubectl get replicas -n longhorn-system -w

# Check rebuild status for a specific volume
kubectl get replica -n longhorn-system \
  -l longhornvolume=pvc-12345678 \
  -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeID,STATE:.status.currentState'

# Rebuild progress (0-100%)
kubectl get volume pvc-12345678 -n longhorn-system \
  -o jsonpath='{.status.rebuildStatus}'
```

### Rebuild Rate Limiting

```bash
# Limit concurrent rebuilds to protect cluster performance
kubectl patch setting concurrent-replica-rebuild-per-node-limit \
  -n longhorn-system \
  --type merge \
  -p '{"value":"3"}'
```

## Monitoring

### Prometheus ServiceMonitor

```yaml
# servicemonitor-longhorn.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: longhorn-prometheus
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - longhorn-system
  selector:
    matchLabels:
      app: longhorn-manager
  endpoints:
    - port: manager
      path: /metrics
      interval: 30s
```

### Key Metrics

```promql
# Volume capacity
longhorn_volume_capacity_bytes{volume="pvc-12345678"}

# Volume actual size
longhorn_volume_actual_size_bytes{volume="pvc-12345678"}

# Replica state (1=healthy, 0=not)
longhorn_replica_actual_size_bytes

# Node storage available
longhorn_node_storage_capacity_bytes - longhorn_node_storage_usage_bytes

# Number of failed replicas
count(longhorn_replica_actual_size_bytes == 0)
```

### PrometheusRule Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-alerts
  namespace: monitoring
spec:
  groups:
    - name: longhorn
      rules:
        - alert: LonghornVolumeNotHealthy
          expr: |
            longhorn_volume_robustness{robustness!="healthy"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Longhorn volume {{ $labels.volume }} is not healthy"
            description: "Robustness: {{ $labels.robustness }}"

        - alert: LonghornNodeStorageFull
          expr: |
            (longhorn_node_storage_usage_bytes / longhorn_node_storage_capacity_bytes) > 0.85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Longhorn node {{ $labels.node }} disk >85% full"

        - alert: LonghornBackupFailed
          expr: |
            longhorn_backup_state{state="Error"} == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Longhorn backup failed for volume {{ $labels.volume }}"
```

## Troubleshooting

### Volume Stuck in Attaching State

```bash
# Check volume and engine status
kubectl get volume -n longhorn-system <volume-name> -o yaml

# Common cause: stale engine process
kubectl get engine -n longhorn-system | grep <volume-name>

# Force detach (warning: data loss if volume has pending writes)
kubectl patch volume <volume-name> \
  -n longhorn-system \
  --type merge \
  -p '{"spec":{"nodeID":""}}'
```

### Replica Rebuild Not Starting

```bash
# Check longhorn-manager logs
kubectl logs -n longhorn-system -l app=longhorn-manager \
  --tail=100 | grep -i rebuild

# Check if stale replica exists
kubectl get replica -n longhorn-system \
  -l longhornvolume=<volume-name>

# Delete the stale replica to trigger rebuild
kubectl delete replica -n longhorn-system <stale-replica-name>
```

### Backup Target Unreachable

```bash
# Verify backup secret
kubectl get secret longhorn-backup-secret -n longhorn-system -o yaml

# Check backup target setting
kubectl get setting backup-target -n longhorn-system -o yaml

# Test connectivity from a longhorn-manager pod
kubectl exec -n longhorn-system -it \
  $(kubectl get pod -n longhorn-system -l app=longhorn-manager \
    -o jsonpath='{.items[0].metadata.name}') -- \
  curl -v https://s3.us-east-1.amazonaws.com/longhorn-backups/
```

## Production Best Practices

### Resource Limits for Longhorn Components

```yaml
# Helm values override for resource limits
defaultSettings:
  guaranteedEngineManagerCPU: 12    # percent of node CPU
  guaranteedReplicaManagerCPU: 12

longhornManager:
  resources:
    limits:
      cpu: "2"
      memory: 1Gi
    requests:
      cpu: "250m"
      memory: 256Mi

longhornDriver:
  resources:
    limits:
      cpu: "1"
      memory: 512Mi
    requests:
      cpu: "100m"
      memory: 128Mi
```

### Storage Reservation

Always reserve at least 10–20% of disk space per node to allow replica rebuilding without filling the disk:

```bash
kubectl patch setting storage-minimal-available-percentage \
  -n longhorn-system \
  --type merge \
  -p '{"value":"15"}'
```

### Periodic Backup Verification

```bash
# Monthly: restore a critical volume backup to a test namespace
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: backup-verification-pvc
  namespace: longhorn-test
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  resources:
    requests:
      storage: 100Gi
EOF

# Mount it in a test pod and verify data integrity
kubectl run verify-backup \
  --image=ubuntu:22.04 \
  --restart=Never \
  --namespace=longhorn-test \
  --overrides='{"spec":{"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"backup-verification-pvc"}}],"containers":[{"name":"verify","image":"ubuntu:22.04","command":["bash","-c","ls /data && md5sum /data/critical-file.db"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}]}}' \
  -- bash
```

## Summary

Longhorn provides a robust, operationally simple distributed block storage solution for Kubernetes without the complexity of a full Ceph deployment. Key production patterns:

- Use zone-aware replica placement with topology labels for fault tolerance
- Configure daily backup to S3 with at least 14 retention points
- Implement hourly snapshots for critical stateful workloads
- Use `block-for-eviction` drain policy to prevent data loss during maintenance
- Monitor with Prometheus alerts for volume health, node capacity, and backup failures
- Set storage reservation at 15% to ensure rebuild capacity
- Limit concurrent engine upgrades to 1 per node to minimize performance impact during upgrades
- Periodically test backup restoration to validate DR readiness

Longhorn's lightweight per-volume architecture makes it an excellent choice for small-to-medium Kubernetes clusters, bare-metal environments, and edge deployments where operational simplicity is a priority alongside reliability.
