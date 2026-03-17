---
title: "Kubernetes Longhorn Distributed Storage: Backup to S3, Volume Snapshots, and Replica Management"
date: 2028-07-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Longhorn", "Storage", "Backup", "S3", "Distributed Storage"]
categories: ["Kubernetes", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to deploying Longhorn distributed block storage on Kubernetes, covering S3 backup integration, volume snapshot workflows, replica placement strategies, and disaster recovery."
more_link: "yes"
url: "/kubernetes-longhorn-distributed-storage-guide/"
---

Longhorn provides cloud-native distributed block storage for Kubernetes workloads without the operational complexity of Ceph or the cost of cloud-managed storage. Built as a CNCF project, it implements per-volume microservices that enable granular replica management, incremental S3 backups, and live volume snapshots. This guide covers deploying Longhorn in production, configuring S3 backup targets, managing replica placement across failure domains, and implementing disaster recovery workflows for stateful applications.

<!--more-->

# Kubernetes Longhorn Distributed Storage: Backup to S3, Volume Snapshots, and Replica Management

## Architecture Overview

Longhorn implements distributed storage through a set of controllers and per-volume processes:

```
┌──────────────────────────────────────────────────────────┐
│                   Longhorn Manager (DaemonSet)            │
│  - Orchestrates volume lifecycle                          │
│  - Manages replica scheduling                             │
│  - Handles node health monitoring                         │
└──────────────────────┬───────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌───────────────┐             ┌───────────────┐
│ Volume Engine │             │ Volume Engine │
│ (per volume)  │             │ (per volume)  │
│  - iSCSI/NVMe │             │  - iSCSI/NVMe │
│  - Sync writes│             │  - Sync writes│
└───────┬───────┘             └───────┬───────┘
        │                             │
   ┌────┴────┐                   ┌────┴────┐
   ▼         ▼                   ▼         ▼
Replica1  Replica2           Replica3  Replica4
(Node A)  (Node B)           (Node B)  (Node C)
```

Each volume gets a dedicated engine process running on the node where the volume is attached. Replicas are distributed across nodes based on scheduling constraints. The engine synchronously replicates writes to all healthy replicas before acknowledging to the application.

## Prerequisites and Node Preparation

### Kernel Modules and Packages

Longhorn requires specific kernel modules and userspace tools on every node:

```bash
#!/bin/bash
# longhorn-node-prep.sh — run on every Kubernetes node before installing Longhorn

set -euo pipefail

echo "=== Installing required packages ==="
apt-get update -qq
apt-get install -y --no-install-recommends \
    open-iscsi \
    nfs-common \
    cryptsetup \
    device-mapper \
    util-linux

echo "=== Loading required kernel modules ==="
modprobe dm_crypt
modprobe iscsi_tcp
modprobe uio
modprobe uio_pci_generic

# Persist across reboots
cat >> /etc/modules-load.d/longhorn.conf << 'EOF'
dm_crypt
iscsi_tcp
uio
uio_pci_generic
EOF

echo "=== Enabling and starting iscsid ==="
systemctl enable iscsid
systemctl start iscsid

echo "=== Verifying iSCSI ==="
iscsiadm -m discovery --help > /dev/null 2>&1 && echo "iSCSI OK" || echo "iSCSI FAILED"

echo "=== Node preparation complete ==="
```

Run the environment check script Longhorn provides before installation:

```bash
curl -sSfL \
  https://raw.githubusercontent.com/longhorn/longhorn/v1.7.0/scripts/environment_check.sh \
  | bash
```

Address any failures reported — common issues are missing `open-iscsi` packages or `iscsid` not running.

### Dedicated Storage Disks

For production, dedicate separate disks to Longhorn rather than using the root filesystem:

```bash
# Partition and format the dedicated storage disk
# Replace /dev/sdb with your actual disk
DISK=/dev/sdb

parted ${DISK} --script \
    mklabel gpt \
    mkpart primary ext4 0% 100%

mkfs.ext4 -L longhorn-data ${DISK}1

# Create mount point and add to fstab
mkdir -p /var/lib/longhorn
echo "LABEL=longhorn-data /var/lib/longhorn ext4 defaults,noatime 0 2" >> /etc/fstab
mount -a

# Verify mount
df -h /var/lib/longhorn
```

## Installing Longhorn

### Helm Installation

```bash
# Add the Longhorn Helm repository
helm repo add longhorn https://charts.longhorn.io
helm repo update

# Create the namespace
kubectl create namespace longhorn-system

# Install with production-grade values
helm upgrade --install longhorn longhorn/longhorn \
    --namespace longhorn-system \
    --version 1.7.0 \
    --values longhorn-values.yaml \
    --wait \
    --timeout 10m
```

### Production Helm Values

```yaml
# longhorn-values.yaml
defaultSettings:
  # Replica count — minimum 3 for production
  defaultReplicaCount: 3

  # Storage over-provisioning percentage
  storageOverProvisioningPercentage: 200

  # Storage minimal available percentage before refusing scheduling
  storageMinimalAvailablePercentage: 25

  # Replica soft anti-affinity — allow scheduling on same node if necessary
  replicaSoftAntiAffinity: false

  # Replica auto-balance
  replicaAutoBalance: "least-effort"

  # Auto-salvage unhealthy volumes when all replicas fail
  autoSalvage: true

  # Concurrent automatic engine upgrades per node
  concurrentAutomaticEngineUpgradePerNodeLimit: 3

  # Node drain policy
  nodeDrainPolicy: "block-if-contains-last-replica"

  # Default data path on nodes
  defaultDataPath: /var/lib/longhorn

  # Backup compression method
  backupCompressionMethod: "lz4"

  # Snapshot data integrity check (fast-check is recommended for production)
  snapshotDataIntegrityImmediateCheckAfterSnapshotCreation: false
  snapshotDataIntegrityCronjob: "0 0 */7 * *"

  # Allow recurring job labels on volumes
  allowRecurringJobWhileMaintenance: false

  # V2 data engine (experimental in 1.7, production in 1.8+)
  v2DataEngine: false

persistence:
  # Default StorageClass
  defaultClass: true
  defaultClassReplicaCount: 3
  reclaimPolicy: Retain
  migratable: false

ingress:
  enabled: true
  ingressClassName: nginx
  host: longhorn.internal.example.com
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: longhorn-basic-auth
    nginx.ingress.kubernetes.io/proxy-body-size: 10000m

resources:
  manager:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

longhornManager:
  tolerations:
    - key: "storage"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
  nodeSelector:
    longhorn.io/storage-node: "true"

longhornDriver:
  tolerations:
    - operator: "Exists"
  nodeSelector: {}

csi:
  attacherReplicaCount: 3
  provisionerReplicaCount: 3
  resizerReplicaCount: 3
  snapshotterReplicaCount: 3
```

### Label Storage Nodes

```bash
# Label nodes designated for Longhorn storage
kubectl label node storage-node-1 longhorn.io/storage-node=true
kubectl label node storage-node-2 longhorn.io/storage-node=true
kubectl label node storage-node-3 longhorn.io/storage-node=true

# Taint storage nodes (optional, keeps non-storage workloads off them)
kubectl taint node storage-node-1 storage=true:NoSchedule
kubectl taint node storage-node-2 storage=true:NoSchedule
kubectl taint node storage-node-3 storage=true:NoSchedule

# Verify Longhorn is running
kubectl -n longhorn-system get pods --field-selector status.phase=Running | wc -l
kubectl -n longhorn-system get nodes.longhorn.io
```

## StorageClass Configuration

### Multiple StorageClass Tiers

```yaml
# storageclass-longhorn-standard.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-standard
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "30"
  fromBackup: ""
  fsType: "ext4"
  dataLocality: "disabled"
  replicaAutoBalance: "least-effort"
---
# storageclass-longhorn-fast.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-fast
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "2"
  staleReplicaTimeout: "30"
  fsType: "ext4"
  # Best-effort data locality keeps a replica on the node using the volume
  dataLocality: "best-effort"
  replicaAutoBalance: "best-effort"
---
# storageclass-longhorn-ha.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-ha
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "30"
  fsType: "ext4"
  # Strict data locality — only available if node has enough storage
  dataLocality: "strict-local"
  replicaAutoBalance: "disabled"
  # Enable encryption at rest
  encrypted: "true"
  csi.storage.k8s.io/provisioner-secret-name: longhorn-crypto-secret
  csi.storage.k8s.io/provisioner-secret-namespace: longhorn-system
  csi.storage.k8s.io/node-publish-secret-name: longhorn-crypto-secret
  csi.storage.k8s.io/node-publish-secret-namespace: longhorn-system
  csi.storage.k8s.io/node-stage-secret-name: longhorn-crypto-secret
  csi.storage.k8s.io/node-stage-secret-namespace: longhorn-system
```

### Encryption Secret

```yaml
# encryption-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: longhorn-crypto-secret
  namespace: longhorn-system
type: Opaque
stringData:
  CRYPTO_KEY_VALUE: "your-32-byte-encryption-key-here"
  CRYPTO_KEY_PROVIDER: "secret"
  CRYPTO_KEY_CIPHER: "aes-xts-plain64"
  CRYPTO_KEY_HASH: "sha256"
  CRYPTO_KEY_SIZE: "256"
  CRYPTO_PBKDF: "argon2i"
```

## S3 Backup Configuration

### AWS S3 Backup Target

```bash
# Create the S3 bucket for Longhorn backups
aws s3api create-bucket \
    --bucket longhorn-backups-prod \
    --region us-east-1

# Enable versioning
aws s3api put-bucket-versioning \
    --bucket longhorn-backups-prod \
    --versioning-configuration Status=Enabled

# Block public access
aws s3api put-public-access-block \
    --bucket longhorn-backups-prod \
    --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Server-side encryption
aws s3api put-bucket-encryption \
    --bucket longhorn-backups-prod \
    --server-side-encryption-configuration '{
      "Rules": [{
        "ApplyServerSideEncryptionByDefault": {
          "SSEAlgorithm": "aws:kms",
          "KMSMasterKeyID": "alias/longhorn-backup-key"
        }
      }]
    }'

# Lifecycle rule to transition old backups to Glacier
aws s3api put-bucket-lifecycle-configuration \
    --bucket longhorn-backups-prod \
    --lifecycle-configuration file://s3-lifecycle.json
```

```json
// s3-lifecycle.json
{
  "Rules": [
    {
      "ID": "LonghornBackupTransition",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "backupstore/"
      },
      "Transitions": [
        {
          "Days": 30,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 90,
          "StorageClass": "GLACIER"
        }
      ],
      "Expiration": {
        "Days": 365
      }
    }
  ]
}
```

### IAM Policy for Longhorn

```json
// longhorn-backup-policy.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": [
        "arn:aws:s3:::longhorn-backups-prod",
        "arn:aws:s3:::longhorn-backups-prod/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "kms:GenerateDataKey",
        "kms:Decrypt"
      ],
      "Resource": "arn:aws:kms:us-east-1:123456789012:key/your-kms-key-id"
    }
  ]
}
```

```bash
# Create IAM user for Longhorn (or use IRSA for EKS)
aws iam create-user --user-name longhorn-backup
aws iam put-user-policy \
    --user-name longhorn-backup \
    --policy-name LonghornBackupPolicy \
    --policy-document file://longhorn-backup-policy.json

aws iam create-access-key --user-name longhorn-backup
# Save the AccessKeyId and SecretAccessKey from output
```

### Configure Backup Target via Secret

```yaml
# backup-target-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: aws-backup-secret
  namespace: longhorn-system
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE"
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  AWS_ENDPOINTS: ""          # Leave empty for standard AWS S3
  AWS_CERT: ""               # PEM cert for custom S3-compatible endpoints
  VIRTUAL_HOSTED_STYLE: ""   # Set "true" for path-style S3 endpoints
```

```bash
# Apply the secret
kubectl apply -f backup-target-secret.yaml

# Configure Longhorn to use the S3 backup target
kubectl -n longhorn-system patch settings.longhorn.io backup-target \
    --type merge \
    --patch '{"value": "s3://longhorn-backups-prod@us-east-1/"}'

kubectl -n longhorn-system patch settings.longhorn.io backup-target-credential-secret \
    --type merge \
    --patch '{"value": "aws-backup-secret"}'

# Verify the backup target is accessible
kubectl -n longhorn-system get settings.longhorn.io backup-target -o jsonpath='{.value}'
```

### MinIO as S3-Compatible Backup Target

For on-premises deployments, use MinIO as the backup target:

```yaml
# minio-deployment.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: minio-system
---
apiVersion: v1
kind: Secret
metadata:
  name: minio-credentials
  namespace: minio-system
type: Opaque
stringData:
  MINIO_ROOT_USER: "minioadmin"
  MINIO_ROOT_PASSWORD: "change-me-to-a-strong-password"
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: minio
  namespace: minio-system
spec:
  serviceName: minio
  replicas: 1
  selector:
    matchLabels:
      app: minio
  template:
    metadata:
      labels:
        app: minio
    spec:
      containers:
      - name: minio
        image: quay.io/minio/minio:RELEASE.2024-01-01T00-00-00Z
        args:
        - server
        - /data
        - --console-address
        - ":9001"
        envFrom:
        - secretRef:
            name: minio-credentials
        ports:
        - containerPort: 9000
          name: api
        - containerPort: 9001
          name: console
        volumeMounts:
        - name: data
          mountPath: /data
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2
            memory: 2Gi
        readinessProbe:
          httpGet:
            path: /minio/health/ready
            port: 9000
          initialDelaySeconds: 10
          periodSeconds: 10
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: longhorn-standard
      resources:
        requests:
          storage: 500Gi
---
apiVersion: v1
kind: Service
metadata:
  name: minio
  namespace: minio-system
spec:
  selector:
    app: minio
  ports:
  - name: api
    port: 9000
    targetPort: 9000
  - name: console
    port: 9001
    targetPort: 9001
```

```bash
# Create backup bucket in MinIO
kubectl -n minio-system exec -it minio-0 -- \
    mc alias set local http://localhost:9000 minioadmin change-me-to-a-strong-password

kubectl -n minio-system exec -it minio-0 -- \
    mc mb local/longhorn-backups

# Configure Longhorn for MinIO
kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: minio-backup-secret
  namespace: longhorn-system
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "minioadmin"
  AWS_SECRET_ACCESS_KEY: "change-me-to-a-strong-password"
  AWS_ENDPOINTS: "http://minio.minio-system.svc.cluster.local:9000"
  VIRTUAL_HOSTED_STYLE: "false"
EOF

kubectl -n longhorn-system patch settings.longhorn.io backup-target \
    --type merge \
    --patch '{"value": "s3://longhorn-backups@us-east-1/"}'

kubectl -n longhorn-system patch settings.longhorn.io backup-target-credential-secret \
    --type merge \
    --patch '{"value": "minio-backup-secret"}'
```

## Volume Snapshot Management

### VolumeSnapshotClass Configuration

```yaml
# volume-snapshot-class.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-snapshot-class
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: driver.longhorn.io
deletionPolicy: Delete
parameters:
  type: snap
---
# For backup snapshots (uploaded to S3)
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-backup-class
driver: driver.longhorn.io
deletionPolicy: Retain
parameters:
  type: bak
```

### Taking Manual Snapshots

```bash
# Take an immediate volume snapshot
kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-data-snapshot-$(date +%Y%m%d-%H%M%S)
  namespace: database
spec:
  volumeSnapshotClassName: longhorn-snapshot-class
  source:
    persistentVolumeClaimName: postgres-data
EOF

# Check snapshot status
kubectl -n database get volumesnapshot
kubectl -n database describe volumesnapshot postgres-data-snapshot-20240722-143000
```

### Recurring Backup Jobs

```yaml
# recurring-backup-job.yaml
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: daily-backup
  namespace: longhorn-system
spec:
  name: daily-backup
  groups:
    - default
  task: backup
  cron: "0 2 * * *"           # Every day at 2 AM
  retain: 7                    # Keep 7 backups
  concurrency: 2               # Max concurrent backup jobs
  labels:
    type: daily
    managed-by: longhorn
---
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: hourly-snapshot
  namespace: longhorn-system
spec:
  name: hourly-snapshot
  groups: []
  task: snapshot
  cron: "0 * * * *"           # Every hour
  retain: 24                   # Keep 24 snapshots
  concurrency: 5
  labels:
    type: hourly
---
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: weekly-backup
  namespace: longhorn-system
spec:
  name: weekly-backup
  groups:
    - critical
  task: backup
  cron: "0 1 * * 0"           # Every Sunday at 1 AM
  retain: 4                    # Keep 4 weekly backups
  concurrency: 1
  labels:
    type: weekly
```

### Attach Recurring Jobs to Volumes

```yaml
# postgres-pvc-with-backup.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: database
  labels:
    # Attach to default backup group (triggers daily-backup job)
    recurring-job-group.longhorn.io/default: enabled
    # Also attach to critical group (triggers weekly-backup)
    recurring-job-group.longhorn.io/critical: enabled
  annotations:
    # Override replica count for this specific volume
    longhorn.io/replica-count: "3"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-ha
  resources:
    requests:
      storage: 100Gi
```

### Go Backup Automation Tool

```go
// cmd/longhorn-backup-manager/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"time"

	longhornv1beta2 "github.com/longhorn/longhorn-manager/k8s/pkg/apis/longhorn/v1beta2"
	longhorncs "github.com/longhorn/longhorn-manager/k8s/pkg/client/clientset/versioned"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// BackupManager orchestrates Longhorn backup operations
type BackupManager struct {
	client    longhorncs.Interface
	namespace string
	logger    *slog.Logger
}

// BackupStatus represents the state of a Longhorn backup
type BackupStatus struct {
	Name        string
	VolumeName  string
	State       string
	Progress    int
	URL         string
	Size        string
	CreatedAt   time.Time
	Error       string
}

func NewBackupManager(kubeconfig, namespace string) (*BackupManager, error) {
	var cfg *rest.Config
	var err error

	if kubeconfig != "" {
		cfg, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
	} else {
		cfg, err = rest.InClusterConfig()
	}
	if err != nil {
		return nil, fmt.Errorf("building kubeconfig: %w", err)
	}

	client, err := longhorncs.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("creating Longhorn client: %w", err)
	}

	return &BackupManager{
		client:    client,
		namespace: namespace,
		logger:    slog.Default(),
	}, nil
}

// TriggerBackup initiates a backup for a specific volume
func (bm *BackupManager) TriggerBackup(ctx context.Context, volumeName string, labels map[string]string) (*longhornv1beta2.Backup, error) {
	timestamp := time.Now().Format("20060102-150405")
	backupName := fmt.Sprintf("%s-manual-%s", volumeName, timestamp)

	if labels == nil {
		labels = make(map[string]string)
	}
	labels["trigger"] = "manual"
	labels["volume"] = volumeName

	// Get the latest snapshot for the volume
	snapshots, err := bm.client.LonghornV1beta2().Snapshots(bm.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("longhornvolume=%s", volumeName),
	})
	if err != nil {
		return nil, fmt.Errorf("listing snapshots for volume %s: %w", volumeName, err)
	}

	if len(snapshots.Items) == 0 {
		return nil, fmt.Errorf("no snapshots found for volume %s", volumeName)
	}

	// Use the most recent snapshot
	var latestSnapshot *longhornv1beta2.Snapshot
	for i := range snapshots.Items {
		s := &snapshots.Items[i]
		if latestSnapshot == nil || s.CreationTimestamp.After(latestSnapshot.CreationTimestamp.Time) {
			if s.Status.ReadyToUse != nil && *s.Status.ReadyToUse {
				latestSnapshot = s
			}
		}
	}

	if latestSnapshot == nil {
		return nil, fmt.Errorf("no ready snapshots found for volume %s", volumeName)
	}

	backup := &longhornv1beta2.Backup{
		ObjectMeta: metav1.ObjectMeta{
			Name:      backupName,
			Namespace: bm.namespace,
			Labels:    labels,
		},
		Spec: longhornv1beta2.BackupSpec{
			SnapshotName: latestSnapshot.Name,
		},
	}

	created, err := bm.client.LonghornV1beta2().Backups(bm.namespace).Create(ctx, backup, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("creating backup %s: %w", backupName, err)
	}

	bm.logger.Info("backup triggered",
		"backup", backupName,
		"volume", volumeName,
		"snapshot", latestSnapshot.Name,
	)

	return created, nil
}

// WaitForBackup polls until a backup completes or times out
func (bm *BackupManager) WaitForBackup(ctx context.Context, backupName string, timeout time.Duration) (*BackupStatus, error) {
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			backup, err := bm.client.LonghornV1beta2().Backups(bm.namespace).Get(ctx, backupName, metav1.GetOptions{})
			if err != nil {
				return nil, fmt.Errorf("getting backup %s: %w", backupName, err)
			}

			status := &BackupStatus{
				Name:       backup.Name,
				VolumeName: backup.Status.VolumeName,
				State:      string(backup.Status.State),
				Progress:   backup.Status.Progress,
				URL:        backup.Status.URL,
				Size:       backup.Status.Size,
			}

			if backup.Status.Error != "" {
				status.Error = backup.Status.Error
			}

			if backup.Status.BackupCreatedAt != "" {
				status.CreatedAt, _ = time.Parse(time.RFC3339, backup.Status.BackupCreatedAt)
			}

			bm.logger.Info("backup status",
				"backup", backupName,
				"state", status.State,
				"progress", status.Progress,
			)

			switch backup.Status.State {
			case longhornv1beta2.BackupStateCompleted:
				return status, nil
			case longhornv1beta2.BackupStateError:
				return status, fmt.Errorf("backup failed: %s", backup.Status.Error)
			}

			if time.Now().After(deadline) {
				return status, fmt.Errorf("backup timed out after %s", timeout)
			}
		}
	}
}

// ListBackups returns all backups for a given volume
func (bm *BackupManager) ListBackups(ctx context.Context, volumeName string) ([]BackupStatus, error) {
	backups, err := bm.client.LonghornV1beta2().Backups(bm.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("volume=%s", volumeName),
	})
	if err != nil {
		return nil, fmt.Errorf("listing backups for volume %s: %w", volumeName, err)
	}

	statuses := make([]BackupStatus, 0, len(backups.Items))
	for _, b := range backups.Items {
		s := BackupStatus{
			Name:       b.Name,
			VolumeName: b.Status.VolumeName,
			State:      string(b.Status.State),
			Progress:   b.Status.Progress,
			URL:        b.Status.URL,
			Size:       b.Status.Size,
		}
		if b.Status.Error != "" {
			s.Error = b.Status.Error
		}
		statuses = append(statuses, s)
	}

	return statuses, nil
}

// PruneOldBackups deletes backups older than the retention period
func (bm *BackupManager) PruneOldBackups(ctx context.Context, volumeName string, retain int) (int, error) {
	backups, err := bm.client.LonghornV1beta2().Backups(bm.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("volume=%s,trigger=manual", volumeName),
	})
	if err != nil {
		return 0, fmt.Errorf("listing backups: %w", err)
	}

	if len(backups.Items) <= retain {
		return 0, nil
	}

	// Sort by creation timestamp (oldest first)
	items := backups.Items
	for i := 0; i < len(items)-1; i++ {
		for j := i + 1; j < len(items); j++ {
			if items[i].CreationTimestamp.After(items[j].CreationTimestamp.Time) {
				items[i], items[j] = items[j], items[i]
			}
		}
	}

	toDelete := items[:len(items)-retain]
	deleted := 0

	for _, b := range toDelete {
		if err := bm.client.LonghornV1beta2().Backups(bm.namespace).Delete(ctx, b.Name, metav1.DeleteOptions{}); err != nil {
			bm.logger.Warn("failed to delete backup", "backup", b.Name, "error", err)
			continue
		}
		bm.logger.Info("deleted old backup", "backup", b.Name, "age_days",
			int(time.Since(b.CreationTimestamp.Time).Hours()/24))
		deleted++
	}

	return deleted, nil
}

func main() {
	ctx := context.Background()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	kubeconfig := os.Getenv("KUBECONFIG")
	namespace := os.Getenv("LONGHORN_NAMESPACE")
	if namespace == "" {
		namespace = "longhorn-system"
	}
	volumeName := os.Getenv("VOLUME_NAME")
	if volumeName == "" {
		slog.Error("VOLUME_NAME environment variable required")
		os.Exit(1)
	}

	bm, err := NewBackupManager(kubeconfig, namespace)
	if err != nil {
		slog.Error("creating backup manager", "error", err)
		os.Exit(1)
	}

	// Trigger backup
	backup, err := bm.TriggerBackup(ctx, volumeName, map[string]string{
		"env":  "production",
		"app":  "postgres",
	})
	if err != nil {
		slog.Error("triggering backup", "error", err)
		os.Exit(1)
	}

	// Wait for completion
	status, err := bm.WaitForBackup(ctx, backup.Name, 2*time.Hour)
	if err != nil {
		slog.Error("backup failed", "error", err, "status", status)
		os.Exit(1)
	}

	// Output result as JSON for CI/CD pipelines
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(status); err != nil {
		slog.Error("encoding result", "error", err)
		os.Exit(1)
	}

	// Prune old backups
	deleted, err := bm.PruneOldBackups(ctx, volumeName, 7)
	if err != nil {
		slog.Warn("pruning old backups", "error", err)
	} else {
		slog.Info("pruned old backups", "deleted", deleted)
	}
}
```

## Replica Management and Placement

### Node Selector and Disk Tags

```bash
# Tag nodes with zone labels for replica distribution
kubectl label node storage-node-1 topology.kubernetes.io/zone=us-east-1a
kubectl label node storage-node-2 topology.kubernetes.io/zone=us-east-1b
kubectl label node storage-node-3 topology.kubernetes.io/zone=us-east-1c

# Tag disks in Longhorn for tier-based placement
# This is done via the Longhorn Node CRD
kubectl -n longhorn-system patch nodes.longhorn.io storage-node-1 \
    --type json \
    --patch '[
      {
        "op": "add",
        "path": "/spec/disks/nvme-ssd/tags",
        "value": ["nvme", "fast", "production"]
      }
    ]'
```

### StorageClass with Disk and Node Tags

```yaml
# storageclass-tagged.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-nvme
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain
parameters:
  numberOfReplicas: "3"
  fsType: "ext4"
  # Only place replicas on disks tagged "nvme"
  diskSelector: "nvme"
  # Only place replicas on nodes tagged "production"
  nodeSelector: "production"
  dataLocality: "best-effort"
```

### Anti-Affinity for Replicas Across Zones

```yaml
# longhorn-replica-zone-affinity.yaml
# Longhorn uses node labels to spread replicas across failure domains
# Configure via the Longhorn manager settings

apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: replica-zone-soft-anti-affinity
  namespace: longhorn-system
value: "false"    # false = hard anti-affinity (replicas MUST be in different zones)
---
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: replica-node-soft-anti-affinity
  namespace: longhorn-system
value: "false"    # false = hard anti-affinity (replicas MUST be on different nodes)
```

### Monitoring Replica Health

```go
// pkg/monitoring/longhorn_monitor.go
package monitoring

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	longhornv1beta2 "github.com/longhorn/longhorn-manager/k8s/pkg/apis/longhorn/v1beta2"
	longhorncs "github.com/longhorn/longhorn-manager/k8s/pkg/client/clientset/versioned"
	"github.com/prometheus/client_golang/prometheus"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// LonghornMetrics exposes Longhorn volume health as Prometheus metrics
type LonghornMetrics struct {
	client    longhorncs.Interface
	namespace string
	logger    *slog.Logger

	volumeHealthy     *prometheus.GaugeVec
	replicaCount      *prometheus.GaugeVec
	volumeActualSize  *prometheus.GaugeVec
	backupState       *prometheus.GaugeVec
	nodeStorageAvail  *prometheus.GaugeVec
}

func NewLonghornMetrics(client longhorncs.Interface, namespace string, reg prometheus.Registerer) *LonghornMetrics {
	m := &LonghornMetrics{
		client:    client,
		namespace: namespace,
		logger:    slog.Default(),

		volumeHealthy: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "longhorn_volume_healthy",
			Help: "1 if the volume is healthy, 0 otherwise",
		}, []string{"volume", "namespace", "robustness"}),

		replicaCount: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "longhorn_volume_replica_count",
			Help: "Number of healthy replicas for a volume",
		}, []string{"volume", "state"}),

		volumeActualSize: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "longhorn_volume_actual_size_bytes",
			Help: "Actual disk space used by a volume including replicas",
		}, []string{"volume"}),

		backupState: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "longhorn_backup_state",
			Help: "State of the most recent backup (1=completed, 0=other)",
		}, []string{"volume", "backup"}),

		nodeStorageAvail: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "longhorn_node_storage_available_bytes",
			Help: "Available storage on Longhorn nodes",
		}, []string{"node", "disk"}),
	}

	reg.MustRegister(
		m.volumeHealthy,
		m.replicaCount,
		m.volumeActualSize,
		m.backupState,
		m.nodeStorageAvail,
	)

	return m
}

// Collect gathers all Longhorn metrics
func (lm *LonghornMetrics) Collect(ctx context.Context) error {
	if err := lm.collectVolumeMetrics(ctx); err != nil {
		return fmt.Errorf("collecting volume metrics: %w", err)
	}
	if err := lm.collectNodeMetrics(ctx); err != nil {
		return fmt.Errorf("collecting node metrics: %w", err)
	}
	return nil
}

func (lm *LonghornMetrics) collectVolumeMetrics(ctx context.Context) error {
	volumes, err := lm.client.LonghornV1beta2().Volumes(lm.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("listing volumes: %w", err)
	}

	lm.volumeHealthy.Reset()
	lm.replicaCount.Reset()
	lm.volumeActualSize.Reset()

	for _, v := range volumes.Items {
		pvcNamespace := v.Status.KubernetesStatus.Namespace
		if pvcNamespace == "" {
			pvcNamespace = lm.namespace
		}

		healthy := 0.0
		if v.Status.Robustness == longhornv1beta2.VolumeRobustnessHealthy {
			healthy = 1.0
		}

		lm.volumeHealthy.WithLabelValues(
			v.Name,
			pvcNamespace,
			string(v.Status.Robustness),
		).Set(healthy)

		// Count replicas by state
		replicas, err := lm.client.LonghornV1beta2().Replicas(lm.namespace).List(ctx, metav1.ListOptions{
			LabelSelector: fmt.Sprintf("longhornvolume=%s", v.Name),
		})
		if err != nil {
			lm.logger.Warn("listing replicas", "volume", v.Name, "error", err)
			continue
		}

		stateCounts := make(map[string]int)
		for _, r := range replicas.Items {
			stateCounts[string(r.Spec.DesiredState)]++
		}
		for state, count := range stateCounts {
			lm.replicaCount.WithLabelValues(v.Name, state).Set(float64(count))
		}

		// Volume actual size
		if v.Status.ActualSize > 0 {
			lm.volumeActualSize.WithLabelValues(v.Name).Set(float64(v.Status.ActualSize))
		}
	}

	return nil
}

func (lm *LonghornMetrics) collectNodeMetrics(ctx context.Context) error {
	nodes, err := lm.client.LonghornV1beta2().Nodes(lm.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("listing nodes: %w", err)
	}

	lm.nodeStorageAvail.Reset()

	for _, n := range nodes.Items {
		for diskID, disk := range n.Status.DiskStatus {
			lm.nodeStorageAvail.WithLabelValues(n.Name, diskID).Set(
				float64(disk.StorageAvailable),
			)
		}
	}

	return nil
}

// StartCollectionLoop runs metric collection on an interval
func (lm *LonghornMetrics) StartCollectionLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := lm.Collect(ctx); err != nil {
				lm.logger.Error("collecting Longhorn metrics", "error", err)
			}
		}
	}
}
```

## Volume Expansion

### Online Volume Expansion

```bash
# Expand a PVC — Longhorn supports online expansion (no unmount required)
kubectl -n database patch pvc postgres-data \
    --type merge \
    --patch '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# Watch the expansion progress
kubectl -n database get pvc postgres-data -w

# For the filesystem to also expand, verify the pod's filesystem resize
kubectl -n database exec postgres-0 -- df -h /var/lib/postgresql/data
```

### Expansion via Python Script

```python
#!/usr/bin/env python3
# scripts/expand-longhorn-volumes.py
"""
Expand multiple Longhorn volumes to a new size.
Usage: python3 expand-longhorn-volumes.py --namespace database --new-size 200Gi
"""

import argparse
import subprocess
import json
import sys
import time
from typing import List, Dict


def get_pvcs(namespace: str, storage_class_filter: str = "longhorn") -> List[Dict]:
    """List all PVCs in the namespace using the Longhorn storage class."""
    result = subprocess.run(
        ["kubectl", "get", "pvc", "-n", namespace, "-o", "json"],
        capture_output=True, text=True, check=True
    )
    pvcs = json.loads(result.stdout)

    longhorn_pvcs = [
        pvc for pvc in pvcs.get("items", [])
        if storage_class_filter in pvc.get("spec", {}).get("storageClassName", "")
    ]
    return longhorn_pvcs


def expand_pvc(namespace: str, pvc_name: str, new_size: str) -> bool:
    """Patch a PVC to request a new size."""
    patch = json.dumps({
        "spec": {
            "resources": {
                "requests": {
                    "storage": new_size
                }
            }
        }
    })

    result = subprocess.run(
        ["kubectl", "patch", "pvc", pvc_name, "-n", namespace,
         "--type", "merge", "--patch", patch],
        capture_output=True, text=True
    )

    if result.returncode != 0:
        print(f"  ERROR: {result.stderr.strip()}", file=sys.stderr)
        return False

    print(f"  Patched {pvc_name} to {new_size}")
    return True


def wait_for_expansion(namespace: str, pvc_name: str, expected_size: str, timeout: int = 300) -> bool:
    """Poll until the PVC reports the new capacity."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = subprocess.run(
            ["kubectl", "get", "pvc", pvc_name, "-n", namespace, "-o", "json"],
            capture_output=True, text=True, check=True
        )
        pvc = json.loads(result.stdout)
        capacity = pvc.get("status", {}).get("capacity", {}).get("storage", "")
        if capacity == expected_size:
            return True
        print(f"  Waiting for expansion... current: {capacity}, expected: {expected_size}")
        time.sleep(10)
    return False


def main():
    parser = argparse.ArgumentParser(description="Expand Longhorn PVCs")
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--new-size", required=True)
    parser.add_argument("--pvc", help="Specific PVC name (default: all in namespace)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.pvc:
        pvcs = [{"metadata": {"name": args.pvc}}]
    else:
        pvcs = get_pvcs(args.namespace)

    print(f"Found {len(pvcs)} Longhorn PVCs in namespace {args.namespace}")

    for pvc in pvcs:
        name = pvc["metadata"]["name"]
        current_size = pvc.get("spec", {}).get("resources", {}).get("requests", {}).get("storage", "unknown")
        print(f"\nExpanding {name}: {current_size} -> {args.new_size}")

        if args.dry_run:
            print("  [DRY RUN] Skipping actual expansion")
            continue

        if not expand_pvc(args.namespace, name, args.new_size):
            print(f"  FAILED to patch {name}")
            continue

        if wait_for_expansion(args.namespace, name, args.new_size):
            print(f"  Successfully expanded {name}")
        else:
            print(f"  Timeout waiting for {name} to expand", file=sys.stderr)


if __name__ == "__main__":
    main()
```

## Disaster Recovery

### Restoring a Volume from Backup

```bash
# List available backups
kubectl -n longhorn-system get backups.longhorn.io | grep my-volume-name

# Restore from a specific backup to a new PVC
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: database
  annotations:
    longhorn.io/from-backup: "s3://longhorn-backups-prod@us-east-1/?backup=backup-XXXXXXXXXXXXXXXX&volume=postgres-data"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-ha
  resources:
    requests:
      storage: 100Gi
EOF

# Monitor restoration progress
kubectl -n longhorn-system get volumes.longhorn.io postgres-data-restored -w
```

### Cross-Cluster Restore

For restoring to a different cluster sharing the same S3 backup target:

```bash
# On the target cluster — configure the same S3 backup target
kubectl -n longhorn-system patch settings.longhorn.io backup-target \
    --type merge \
    --patch '{"value": "s3://longhorn-backups-prod@us-east-1/"}'

kubectl apply -f backup-target-secret.yaml

# Sync the backup store to discover existing backups
kubectl -n longhorn-system annotate settings.longhorn.io backup-target \
    backup-target-sync=true

# Wait for backup list to populate
kubectl -n longhorn-system get backupvolumes.longhorn.io

# Restore specific backup
BACKUP_URL=$(kubectl -n longhorn-system get backupvolumes.longhorn.io postgres-data \
    -o jsonpath='{.status.lastBackupURL}')
echo "Restoring from: ${BACKUP_URL}"

kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: database
  annotations:
    longhorn.io/from-backup: "${BACKUP_URL}"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-ha
  resources:
    requests:
      storage: 100Gi
EOF
```

### Disaster Recovery Runbook Script

```bash
#!/bin/bash
# scripts/longhorn-dr-restore.sh
# Usage: ./longhorn-dr-restore.sh <volume-name> <namespace> <backup-url>

set -euo pipefail

VOLUME_NAME="${1:?Volume name required}"
TARGET_NAMESPACE="${2:?Target namespace required}"
BACKUP_URL="${3:?Backup URL required}"
RESTORE_SUFFIX="${4:-restored}"
TARGET_PVC="${VOLUME_NAME}-${RESTORE_SUFFIX}"

echo "=== Longhorn Disaster Recovery Restore ==="
echo "Volume:    ${VOLUME_NAME}"
echo "Namespace: ${TARGET_NAMESPACE}"
echo "Backup:    ${BACKUP_URL}"
echo "Target PVC: ${TARGET_PVC}"
echo ""

# Verify backup exists
echo "Verifying backup accessibility..."
if ! kubectl -n longhorn-system get backupvolumes.longhorn.io "${VOLUME_NAME}" &>/dev/null; then
    echo "ERROR: BackupVolume ${VOLUME_NAME} not found. Did you sync the backup store?"
    exit 1
fi

# Get the size from the backup volume
SIZE=$(kubectl -n longhorn-system get backupvolumes.longhorn.io "${VOLUME_NAME}" \
    -o jsonpath='{.status.size}')
echo "Backup size: ${SIZE} bytes"

# Convert bytes to Gi for PVC spec (rough conversion for clarity)
SIZE_GI=$(( (SIZE / 1073741824) + 1 ))Gi
echo "Requesting: ${SIZE_GI}"

# Create the restore PVC
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${TARGET_PVC}
  namespace: ${TARGET_NAMESPACE}
  labels:
    longhorn.io/dr-restore: "true"
    longhorn.io/source-volume: "${VOLUME_NAME}"
    restored-at: "$(date +%Y%m%d-%H%M%S)"
  annotations:
    longhorn.io/from-backup: "${BACKUP_URL}"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-ha
  resources:
    requests:
      storage: ${SIZE_GI}
EOF

echo ""
echo "Waiting for volume to become available..."

TIMEOUT=600
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
    STATUS=$(kubectl -n longhorn-system get volumes.longhorn.io "${TARGET_PVC}" \
        -o jsonpath='{.status.state}' 2>/dev/null || echo "NotFound")

    echo "  Volume state: ${STATUS} (${ELAPSED}s elapsed)"

    if [ "${STATUS}" = "detached" ]; then
        echo ""
        echo "Volume ${TARGET_PVC} is ready and detached."
        echo "To attach it, scale your application or create a pod using this PVC."
        break
    fi

    if [ "${STATUS}" = "faulted" ]; then
        echo "ERROR: Volume restore failed with state: faulted"
        kubectl -n longhorn-system describe volumes.longhorn.io "${TARGET_PVC}"
        exit 1
    fi

    sleep 10
    ELAPSED=$((ELAPSED + 10))
done

if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "ERROR: Restore timed out after ${TIMEOUT}s"
    exit 1
fi

echo ""
echo "=== Restore completed successfully ==="
echo "PVC: ${TARGET_NAMESPACE}/${TARGET_PVC}"
echo ""
echo "Next steps:"
echo "  1. Verify data integrity by mounting the volume"
echo "  2. Update your application to use the restored PVC"
echo "  3. Delete the old faulted volume if applicable"
```

## Upgrading Longhorn

### Rolling Upgrade Process

```bash
#!/bin/bash
# scripts/upgrade-longhorn.sh
set -euo pipefail

NEW_VERSION="${1:?New version required, e.g. 1.7.1}"
NAMESPACE="longhorn-system"

echo "=== Upgrading Longhorn to ${NEW_VERSION} ==="

# Pre-upgrade health check
echo "Checking current cluster health..."
DEGRADED_VOLUMES=$(kubectl -n ${NAMESPACE} get volumes.longhorn.io \
    -o jsonpath='{.items[?(@.status.robustness!="healthy")].metadata.name}' | tr ' ' '\n' | grep -v '^$' | wc -l)

if [ "${DEGRADED_VOLUMES}" -gt 0 ]; then
    echo "WARNING: ${DEGRADED_VOLUMES} volumes are not healthy."
    echo "Degraded volumes:"
    kubectl -n ${NAMESPACE} get volumes.longhorn.io \
        --field-selector='status.robustness!=healthy'
    read -p "Continue with upgrade? (yes/no): " CONFIRM
    if [ "${CONFIRM}" != "yes" ]; then
        echo "Upgrade aborted."
        exit 1
    fi
fi

# Disable concurrent engine upgrades during the upgrade
kubectl -n ${NAMESPACE} patch settings.longhorn.io \
    concurrent-automatic-engine-upgrade-per-node-limit \
    --type merge --patch '{"value": "0"}'

echo "Updating Helm chart..."
helm repo update
helm upgrade longhorn longhorn/longhorn \
    --namespace ${NAMESPACE} \
    --version "${NEW_VERSION}" \
    --values longhorn-values.yaml \
    --wait \
    --timeout 20m

echo "Waiting for all Longhorn components to be ready..."
kubectl -n ${NAMESPACE} rollout status deployment/longhorn-ui
kubectl -n ${NAMESPACE} rollout status deployment/longhorn-manager

# Re-enable automatic engine upgrades after manager upgrade
sleep 30
kubectl -n ${NAMESPACE} patch settings.longhorn.io \
    concurrent-automatic-engine-upgrade-per-node-limit \
    --type merge --patch '{"value": "3"}'

echo ""
echo "=== Upgrade to ${NEW_VERSION} initiated ==="
echo "Engine upgrades will proceed automatically. Monitor progress:"
echo "  kubectl -n ${NAMESPACE} get volumes.longhorn.io -w"
```

## Prometheus Alerting Rules

```yaml
# longhorn-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-alerts
  namespace: longhorn-system
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: longhorn.volumes
    interval: 30s
    rules:
    - alert: LonghornVolumeNotHealthy
      expr: |
        longhorn_volume_robustness{robustness!="healthy"} == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Longhorn volume {{ $labels.volume }} is not healthy"
        description: "Volume {{ $labels.volume }} has robustness {{ $labels.robustness }} for more than 5 minutes."

    - alert: LonghornVolumeDegraded
      expr: |
        longhorn_volume_robustness{robustness="degraded"} == 1
      for: 15m
      labels:
        severity: critical
      annotations:
        summary: "Longhorn volume {{ $labels.volume }} is degraded"
        description: "Volume {{ $labels.volume }} has fewer than the desired number of replicas."

    - alert: LonghornNodeStorageLow
      expr: |
        longhorn_node_storage_available_bytes / longhorn_node_storage_capacity_bytes * 100 < 25
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Longhorn node {{ $labels.node }} storage below 25%"
        description: "Node {{ $labels.node }} disk {{ $labels.disk }} has only {{ $value | humanizePercentage }} available."

    - alert: LonghornNodeStorageCritical
      expr: |
        longhorn_node_storage_available_bytes / longhorn_node_storage_capacity_bytes * 100 < 10
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Longhorn node {{ $labels.node }} storage critically low"
        description: "Node {{ $labels.node }} disk {{ $labels.disk }} has only {{ $value | humanizePercentage }} available. New volumes cannot be scheduled."

    - alert: LonghornNodeDown
      expr: |
        longhorn_node_status{condition="ready"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Longhorn node {{ $labels.node }} is down"
        description: "Node {{ $labels.node }} has been unavailable for more than 2 minutes."

    - alert: LonghornBackupFailed
      expr: |
        increase(longhorn_backup_error_total[1h]) > 0
      labels:
        severity: warning
      annotations:
        summary: "Longhorn backup errors detected"
        description: "{{ $value }} backup errors occurred in the last hour."
```

## Grafana Dashboard

```json
{
  "title": "Longhorn Storage Overview",
  "panels": [
    {
      "title": "Volume Health Summary",
      "type": "stat",
      "targets": [
        {
          "expr": "count(longhorn_volume_robustness{robustness='healthy'})",
          "legendFormat": "Healthy Volumes"
        },
        {
          "expr": "count(longhorn_volume_robustness{robustness='degraded'})",
          "legendFormat": "Degraded Volumes"
        },
        {
          "expr": "count(longhorn_volume_robustness{robustness='faulted'})",
          "legendFormat": "Faulted Volumes"
        }
      ]
    },
    {
      "title": "Node Storage Utilization",
      "type": "bargauge",
      "targets": [
        {
          "expr": "(longhorn_node_storage_usage_bytes / longhorn_node_storage_capacity_bytes) * 100",
          "legendFormat": "{{node}}"
        }
      ]
    },
    {
      "title": "Volume IOPS",
      "type": "timeseries",
      "targets": [
        {
          "expr": "rate(longhorn_volume_read_iops[5m])",
          "legendFormat": "{{volume}} read"
        },
        {
          "expr": "rate(longhorn_volume_write_iops[5m])",
          "legendFormat": "{{volume}} write"
        }
      ]
    },
    {
      "title": "Backup Success Rate",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(longhorn_backup_state{state='Completed'}) / count(longhorn_backup_state) * 100",
          "legendFormat": "Success Rate %"
        }
      ]
    }
  ]
}
```

## Common Troubleshooting

### Volume Stuck in Attaching State

```bash
# Check which node the volume is scheduled to
kubectl -n longhorn-system get volumes.longhorn.io my-volume -o yaml | grep -A5 spec

# Check engines
kubectl -n longhorn-system get engines.longhorn.io | grep my-volume

# Check replicas
kubectl -n longhorn-system get replicas.longhorn.io | grep my-volume

# Check manager logs on the node
NODE=$(kubectl -n longhorn-system get volumes.longhorn.io my-volume \
    -o jsonpath='{.spec.nodeID}')
kubectl -n longhorn-system logs -l app=longhorn-manager --field-selector spec.nodeName=${NODE} | \
    grep my-volume | tail -50

# Force detach (use only if pod is already gone)
kubectl -n longhorn-system patch volumes.longhorn.io my-volume \
    --type merge \
    --patch '{"spec":{"nodeID":"","disableFrontend":false}}'
```

### Replica Rebuild Not Starting

```bash
# Check replica events
kubectl -n longhorn-system get events | grep my-volume

# Check disk space on all nodes
kubectl -n longhorn-system get nodes.longhorn.io -o custom-columns=\
    NAME:.metadata.name,\
    AVAIL:.status.diskStatus.*.storageAvailable,\
    SCHED:.status.diskStatus.*.storageScheduled

# Check if replica soft anti-affinity is blocking
kubectl -n longhorn-system get settings.longhorn.io replica-soft-anti-affinity

# Manually trigger replica rebuild by removing the failed replica
REPLICA=$(kubectl -n longhorn-system get replicas.longhorn.io | grep my-volume | grep -v Running | awk '{print $1}')
kubectl -n longhorn-system delete replica.longhorn.io ${REPLICA}
```

### Node Drain with Longhorn Volumes

```bash
# Before draining a node with Longhorn workloads, verify
# the node-drain-policy is set appropriately
kubectl -n longhorn-system get settings.longhorn.io node-drain-policy

# Enable maintenance mode for the node first (disables scheduling to it)
kubectl -n longhorn-system patch nodes.longhorn.io storage-node-2 \
    --type merge \
    --patch '{"spec":{"allowScheduling":false}}'

# Wait for replicas to migrate to other nodes
watch kubectl -n longhorn-system get replicas.longhorn.io | grep storage-node-2

# Once empty, drain the Kubernetes node
kubectl drain storage-node-2 \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --pod-selector="!longhorn.io/component" \
    --timeout=300s

# After maintenance, re-enable scheduling
kubectl -n longhorn-system patch nodes.longhorn.io storage-node-2 \
    --type merge \
    --patch '{"spec":{"allowScheduling":true}}'

kubectl uncordon storage-node-2
```

### Backup Target Connectivity Test

```bash
#!/bin/bash
# scripts/test-backup-target.sh
set -euo pipefail

NAMESPACE="longhorn-system"

echo "=== Testing Longhorn Backup Target ==="

# Get current backup target
TARGET=$(kubectl -n ${NAMESPACE} get settings.longhorn.io backup-target \
    -o jsonpath='{.value}')
echo "Backup target: ${TARGET}"

# Verify secret exists
SECRET=$(kubectl -n ${NAMESPACE} get settings.longhorn.io backup-target-credential-secret \
    -o jsonpath='{.value}')
echo "Credential secret: ${SECRET}"

if [ -n "${SECRET}" ]; then
    kubectl -n ${NAMESPACE} get secret "${SECRET}" > /dev/null && \
        echo "Secret exists: OK" || echo "Secret missing: FAIL"
fi

# Trigger a backup store sync
kubectl -n ${NAMESPACE} patch settings.longhorn.io backup-target \
    --type merge \
    --patch "{\"value\": \"${TARGET}\"}"

# Wait for backup volumes to appear
sleep 15
COUNT=$(kubectl -n ${NAMESPACE} get backupvolumes.longhorn.io 2>/dev/null | wc -l)
echo "Backup volumes discovered: $((COUNT - 1))"

if [ $((COUNT - 1)) -ge 0 ]; then
    echo "Backup target connectivity: OK"
else
    echo "Backup target connectivity: FAIL — no backup volumes found"
    exit 1
fi
```

## Production Checklist

Before putting Longhorn into production, verify these items:

```markdown
## Pre-Production Longhorn Checklist

### Hardware and OS
- [ ] Dedicated storage disks formatted and mounted at /var/lib/longhorn
- [ ] open-iscsi installed and iscsid running on ALL nodes
- [ ] dm_crypt, iscsi_tcp kernel modules loaded and persisted
- [ ] Environment check script returns no failures
- [ ] NTP synchronized across all nodes (replica sync depends on consistent time)

### Installation
- [ ] Longhorn version pinned in Helm values
- [ ] replica count set to 3 minimum for production
- [ ] storageMinimalAvailablePercentage set to 25%
- [ ] replicaSoftAntiAffinity disabled (hard zone anti-affinity)
- [ ] nodeDrainPolicy set to block-if-contains-last-replica
- [ ] defaultReplicaCount verified in StorageClass

### Backup
- [ ] S3 bucket or MinIO deployed and accessible
- [ ] IAM credentials scoped to minimum permissions
- [ ] Backup target secret applied to longhorn-system namespace
- [ ] Backup target verified reachable from all nodes
- [ ] RecurringJob resources created for daily/weekly cadence
- [ ] Retention policy verified (adequate count of backups kept)

### Monitoring
- [ ] Prometheus scraping longhorn-system metrics
- [ ] Alerting rules deployed (degraded volumes, storage low)
- [ ] Grafana dashboard imported
- [ ] PagerDuty or equivalent notified on critical alerts

### DR Testing
- [ ] Restore from backup tested on staging cluster
- [ ] Cross-cluster restore procedure documented and tested
- [ ] DR runbook updated with current backup URLs
- [ ] RTO/RPO requirements verified against backup frequency
```

## Summary

Longhorn provides production-grade distributed block storage for Kubernetes environments where managed cloud storage is unavailable or cost-prohibitive. The key operational patterns covered in this guide:

- **Installation**: Node preparation with kernel modules, dedicated disks, and labeled node topology are prerequisites that are easy to overlook but critical for stable operation
- **Storage tiers**: Multiple StorageClasses with different replica counts, data locality settings, and disk tag selectors serve different workload needs
- **S3 backups**: Incremental backups via RecurringJob resources combined with a robust S3 lifecycle policy provide cost-effective, long-term data protection
- **Snapshot workflows**: VolumeSnapshot resources integrate with Kubernetes-native snapshot APIs and can be automated through recurring jobs attached to PVC labels
- **Replica management**: Disabling soft anti-affinity and using zone topology labels ensures replicas are distributed across failure domains rather than concentrated on the same node
- **Disaster recovery**: The cross-cluster restore procedure using a shared S3 backup store enables recovery to a new cluster without dependency on the original cluster state

The Go backup management tool and Python expansion script provide automation foundations that integrate with existing CI/CD pipelines and operational runbooks.
