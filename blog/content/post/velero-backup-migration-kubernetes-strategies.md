---
title: "Velero Backup and Migration Strategies for Kubernetes: Enterprise Guide"
date: 2026-12-09T00:00:00-05:00
draft: false
tags: ["Velero", "Kubernetes", "Backup", "Disaster Recovery", "Migration", "Cloud Native", "Storage", "Production"]
categories: ["Kubernetes", "Storage", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Velero backup and disaster recovery for Kubernetes with migration strategies, automated schedules, multi-cluster replication, and production best practices."
more_link: "yes"
url: "/velero-backup-migration-kubernetes-strategies/"
---

Velero is the industry-standard tool for backing up, restoring, and migrating Kubernetes cluster resources and persistent volumes. This comprehensive guide covers production-grade backup strategies, disaster recovery procedures, cross-cluster migrations, and automation patterns for enterprise Kubernetes environments.

<!--more-->

# Velero Backup and Migration Strategies for Kubernetes: Enterprise Guide

## Executive Summary

Velero (formerly Heptio Ark) provides cloud-native backup and recovery for Kubernetes clusters, supporting full cluster backups, namespace-level backups, and persistent volume snapshots. This guide covers production deployment strategies, automated backup scheduling, disaster recovery procedures, and cluster migration patterns used in enterprise environments managing hundreds of clusters and thousands of applications.

## Architecture and Components

### Velero Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Kubernetes Cluster                          │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              Velero Server (Deployment)                     │ │
│  │  • Backup/Restore Controllers                              │ │
│  │  • Schedule Management                                     │ │
│  │  • Plugin Management                                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                    │
│                              ├─────────────────┐                  │
│                              │                 │                  │
│  ┌──────────────────────────▼──┐   ┌─────────▼────────────────┐ │
│  │    Restic DaemonSet         │   │  CSI Snapshot Controller │ │
│  │  • File-level backups       │   │  • Volume snapshots      │ │
│  │  • Per-node agent           │   │  • Cloud provider        │ │
│  └─────────────────────────────┘   └──────────────────────────┘ │
│                              │                 │                  │
└──────────────────────────────┼─────────────────┼─────────────────┘
                               │                 │
                    ┌──────────▼─────────────────▼──────────┐
                    │    Object Storage (S3/GCS/Azure)     │
                    │  • Backup metadata & resources        │
                    │  • Restic repositories                │
                    │  • Encryption at rest                 │
                    └───────────────────────────────────────┘
                               │
                    ┌──────────▼─────────────┐
                    │  Cloud Volume Snapshots │
                    │  • EBS Snapshots (AWS)  │
                    │  • Persistent Disks (GCP)│
                    │  • Managed Disks (Azure) │
                    └─────────────────────────┘
```

## Production Installation and Configuration

### Prerequisites

```bash
#!/bin/bash
# velero-prerequisites.sh
# Install prerequisites for Velero

set -e

# Install Velero CLI
VELERO_VERSION="v1.12.2"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

if [ "$ARCH" = "x86_64" ]; then
    ARCH="amd64"
elif [ "$ARCH" = "aarch64" ]; then
    ARCH="arm64"
fi

echo "Installing Velero CLI ${VELERO_VERSION}..."
wget https://github.com/vmware-tanzu/velero/releases/download/${VELERO_VERSION}/velero-${VELERO_VERSION}-${OS}-${ARCH}.tar.gz
tar -xvf velero-${VELERO_VERSION}-${OS}-${ARCH}.tar.gz
sudo mv velero-${VELERO_VERSION}-${OS}-${ARCH}/velero /usr/local/bin/
rm -rf velero-${VELERO_VERSION}-${OS}-${ARCH}*

echo "Velero CLI installed: $(velero version --client-only)"

# Create S3 bucket for backups (AWS example)
if command -v aws &> /dev/null; then
    BUCKET_NAME="k8s-velero-backups-$(date +%s)"
    REGION="us-east-1"

    echo "Creating S3 bucket: ${BUCKET_NAME}"
    aws s3 mb s3://${BUCKET_NAME} --region ${REGION}

    # Enable versioning
    aws s3api put-bucket-versioning \
        --bucket ${BUCKET_NAME} \
        --versioning-configuration Status=Enabled

    # Enable encryption
    aws s3api put-bucket-encryption \
        --bucket ${BUCKET_NAME} \
        --server-side-encryption-configuration '{
            "Rules": [{
                "ApplyServerSideEncryptionByDefault": {
                    "SSEAlgorithm": "AES256"
                },
                "BucketKeyEnabled": true
            }]
        }'

    # Set lifecycle policy
    aws s3api put-bucket-lifecycle-configuration \
        --bucket ${BUCKET_NAME} \
        --lifecycle-configuration '{
            "Rules": [{
                "Id": "DeleteOldBackups",
                "Status": "Enabled",
                "ExpirationInDays": 90,
                "NoncurrentVersionExpirationInDays": 30
            }]
        }'

    echo "S3 bucket created: ${BUCKET_NAME}"
    echo "Export: export VELERO_BUCKET=${BUCKET_NAME}"
fi
```

### Production Velero Installation

```yaml
# velero-install.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: velero

---
# Service Account for Velero
apiVersion: v1
kind: ServiceAccount
metadata:
  name: velero
  namespace: velero

---
# S3 credentials (AWS example)
apiVersion: v1
kind: Secret
metadata:
  name: cloud-credentials
  namespace: velero
type: Opaque
stringData:
  cloud: |
    [default]
    aws_access_key_id = YOUR_ACCESS_KEY_ID
    aws_secret_access_key = YOUR_SECRET_ACCESS_KEY

---
# Velero BackupStorageLocation
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: k8s-velero-backups
    prefix: production-cluster
  config:
    region: us-east-1
    s3ForcePathStyle: "false"
    s3Url: https://s3.us-east-1.amazonaws.com
    # For MinIO:
    # s3ForcePathStyle: "true"
    # s3Url: https://minio.example.com
  credential:
    name: cloud-credentials
    key: cloud
  default: true
  accessMode: ReadWrite
  backupSyncPeriod: 10m

---
# Velero VolumeSnapshotLocation (AWS EBS)
apiVersion: velero.io/v1
kind: VolumeSnapshotLocation
metadata:
  name: default
  namespace: velero
spec:
  provider: aws
  config:
    region: us-east-1
    # For incremental snapshots:
    incremental: "true"
  credential:
    name: cloud-credentials
    key: cloud

---
# Velero Server Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: velero
  namespace: velero
spec:
  replicas: 1
  selector:
    matchLabels:
      app: velero
  template:
    metadata:
      labels:
        app: velero
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8085"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: velero
      restartPolicy: Always
      containers:
      - name: velero
        image: velero/velero:v1.12.2
        imagePullPolicy: IfNotPresent
        command:
        - /velero
        args:
        - server
        - --uploader-type=restic
        - --default-backup-storage-location=default
        - --default-volume-snapshot-locations=default
        - --default-backup-ttl=720h  # 30 days
        - --default-volumes-to-fs-backup=false
        - --metrics-address=:8085
        - --profiler-address=:6060
        - --log-level=info
        - --log-format=json
        - --features=EnableCSI  # Enable CSI snapshot support
        volumeMounts:
        - name: cloud-credentials
          mountPath: /credentials
        - name: plugins
          mountPath: /plugins
        - name: scratch
          mountPath: /scratch
        env:
        - name: VELERO_SCRATCH_DIR
          value: /scratch
        - name: AWS_SHARED_CREDENTIALS_FILE
          value: /credentials/cloud
        - name: VELERO_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: LD_LIBRARY_PATH
          value: /plugins
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        livenessProbe:
          httpGet:
            path: /metrics
            port: 8085
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /metrics
            port: 8085
          initialDelaySeconds: 10
          periodSeconds: 10
      volumes:
      - name: cloud-credentials
        secret:
          secretName: cloud-credentials
      - name: plugins
        emptyDir: {}
      - name: scratch
        emptyDir: {}
      initContainers:
      - name: velero-plugin-for-aws
        image: velero/velero-plugin-for-aws:v1.8.2
        imagePullPolicy: IfNotPresent
        volumeMounts:
        - name: plugins
          mountPath: /target
      # For CSI support:
      - name: velero-plugin-for-csi
        image: velero/velero-plugin-for-csi:v0.6.2
        imagePullPolicy: IfNotPresent
        volumeMounts:
        - name: plugins
          mountPath: /target

---
# Restic DaemonSet for file-level backups
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: restic
  namespace: velero
spec:
  selector:
    matchLabels:
      name: restic
  template:
    metadata:
      labels:
        name: restic
    spec:
      serviceAccountName: velero
      securityContext:
        runAsUser: 0
      volumes:
      - name: cloud-credentials
        secret:
          secretName: cloud-credentials
      - name: host-pods
        hostPath:
          path: /var/lib/kubelet/pods
      - name: scratch
        emptyDir: {}
      containers:
      - name: restic
        image: velero/velero:v1.12.2
        imagePullPolicy: IfNotPresent
        command:
        - /velero
        args:
        - restic
        - server
        - --log-level=info
        - --log-format=json
        volumeMounts:
        - name: cloud-credentials
          mountPath: /credentials
        - name: host-pods
          mountPath: /host_pods
          mountPropagation: HostToContainer
        - name: scratch
          mountPath: /scratch
        env:
        - name: VELERO_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: VELERO_SCRATCH_DIR
          value: /scratch
        - name: AWS_SHARED_CREDENTIALS_FILE
          value: /credentials/cloud
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 1Gi
```

## Automated Backup Strategies

### Comprehensive Backup Schedules

```yaml
# backup-schedules.yaml
---
# Full cluster backup - daily
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-full-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 2 AM daily
  template:
    ttl: 720h  # 30 days retention
    includedNamespaces:
    - "*"
    excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - velero
    includedResources:
    - "*"
    excludedResources:
    - events
    - events.events.k8s.io
    labelSelector:
      matchExpressions:
      - key: velero.io/exclude-from-backup
        operator: NotIn
        values:
        - "true"
    snapshotVolumes: true
    defaultVolumesToFsBackup: false  # Use CSI snapshots when possible
    hooks:
      resources: []
    metadata:
      labels:
        backup-type: full
        schedule: daily

---
# Critical namespaces - every 4 hours
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: critical-apps-backup
  namespace: velero
spec:
  schedule: "0 */4 * * *"  # Every 4 hours
  template:
    ttl: 168h  # 7 days retention
    includedNamespaces:
    - production
    - payment-services
    - user-accounts
    snapshotVolumes: true
    defaultVolumesToFsBackup: false
    metadata:
      labels:
        backup-type: critical
        schedule: every-4h

---
# Database backups with hooks - every 6 hours
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: database-backup
  namespace: velero
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  template:
    ttl: 336h  # 14 days retention
    includedNamespaces:
    - databases
    labelSelector:
      matchLabels:
        app.kubernetes.io/component: database
    snapshotVolumes: true
    defaultVolumesToFsBackup: true  # Use Restic for databases
    hooks:
      resources:
      # PostgreSQL backup hook
      - name: postgres-backup-hook
        includedNamespaces:
        - databases
        labelSelector:
          matchLabels:
            app: postgresql
        pre:
        - exec:
            container: postgresql
            command:
            - /bin/bash
            - -c
            - |
              pg_dump -U postgres -Fc mydatabase > /backup/db.dump
            onError: Fail
            timeout: 5m
        post:
        - exec:
            container: postgresql
            command:
            - /bin/bash
            - -c
            - |
              rm -f /backup/db.dump
      # MySQL backup hook
      - name: mysql-backup-hook
        includedNamespaces:
        - databases
        labelSelector:
          matchLabels:
            app: mysql
        pre:
        - exec:
            container: mysql
            command:
            - /bin/bash
            - -c
            - |
              mysqldump --all-databases --single-transaction > /backup/mysql.sql
            onError: Fail
            timeout: 5m
        post:
        - exec:
            container: mysql
            command:
            - /bin/bash
            - -c
            - |
              rm -f /backup/mysql.sql
    metadata:
      labels:
        backup-type: database
        schedule: every-6h

---
# Weekly full backup with long retention
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: weekly-full-backup
  namespace: velero
spec:
  schedule: "0 3 * * 0"  # 3 AM every Sunday
  template:
    ttl: 2160h  # 90 days retention
    includedNamespaces:
    - "*"
    excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - velero
    snapshotVolumes: true
    defaultVolumesToFsBackup: false
    metadata:
      labels:
        backup-type: weekly-full
        schedule: weekly
        retention: long-term

---
# StatefulSet-specific backup
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: statefulset-backup
  namespace: velero
spec:
  schedule: "0 */2 * * *"  # Every 2 hours
  template:
    ttl: 168h  # 7 days
    includedResources:
    - statefulsets
    - persistentvolumeclaims
    - persistentvolumes
    snapshotVolumes: true
    defaultVolumesToFsBackup: true
    metadata:
      labels:
        backup-type: statefulset
        schedule: every-2h
```

### Backup Automation and Management

```python
#!/usr/bin/env python3
"""
Velero backup automation and management
"""
import subprocess
import json
from datetime import datetime, timedelta
from typing import Dict, List, Optional
import yaml

class VeleroBackupManager:
    """Manage Velero backups, restores, and migrations"""

    def __init__(self, namespace: str = "velero"):
        self.namespace = namespace

    def create_backup(self, backup_name: str, namespaces: List[str] = None,
                     include_cluster_resources: bool = True,
                     snapshot_volumes: bool = True,
                     ttl: str = "720h") -> Dict:
        """
        Create an on-demand backup

        Args:
            backup_name: Name for the backup
            namespaces: List of namespaces to backup (None = all)
            include_cluster_resources: Include cluster-scoped resources
            snapshot_volumes: Create volume snapshots
            ttl: Time to live (e.g., "720h" for 30 days)
        """
        cmd = ["velero", "backup", "create", backup_name]

        if namespaces:
            cmd.extend(["--include-namespaces", ",".join(namespaces)])

        if include_cluster_resources:
            cmd.append("--include-cluster-resources")

        if snapshot_volumes:
            cmd.append("--snapshot-volumes")
        else:
            cmd.append("--snapshot-volumes=false")

        cmd.extend(["--ttl", ttl])
        cmd.extend(["--wait"])  # Wait for backup to complete

        print(f"Creating backup: {backup_name}")
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise Exception(f"Backup failed: {result.stderr}")

        return {
            "backup_name": backup_name,
            "status": "Completed",
            "timestamp": datetime.now().isoformat()
        }

    def list_backups(self, label_selector: str = None) -> List[Dict]:
        """List all backups"""
        cmd = ["velero", "backup", "get", "-o", "json"]

        if label_selector:
            cmd.extend(["--selector", label_selector])

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise Exception(f"Failed to list backups: {result.stderr}")

        data = json.loads(result.stdout)
        return data.get('items', [])

    def get_backup_details(self, backup_name: str) -> Dict:
        """Get detailed information about a backup"""
        cmd = ["velero", "backup", "describe", backup_name, "--details", "-o", "json"]

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise Exception(f"Failed to get backup details: {result.stderr}")

        return json.loads(result.stdout)

    def delete_backup(self, backup_name: str, confirm: bool = False):
        """Delete a backup"""
        if not confirm:
            raise Exception("Must confirm backup deletion")

        cmd = ["velero", "backup", "delete", backup_name, "--confirm"]

        print(f"Deleting backup: {backup_name}")
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise Exception(f"Failed to delete backup: {result.stderr}")

        print(f"Backup deleted: {backup_name}")

    def restore_backup(self, backup_name: str, namespaces: List[str] = None,
                      restore_pvs: bool = True,
                      preserve_node_ports: bool = False) -> Dict:
        """
        Restore from a backup

        Args:
            backup_name: Name of backup to restore
            namespaces: List of namespaces to restore (None = all)
            restore_pvs: Restore persistent volumes
            preserve_node_ports: Preserve NodePort values
        """
        restore_name = f"{backup_name}-restore-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

        cmd = ["velero", "restore", "create", restore_name]
        cmd.extend(["--from-backup", backup_name])

        if namespaces:
            cmd.extend(["--include-namespaces", ",".join(namespaces)])

        if not restore_pvs:
            cmd.append("--restore-volumes=false")

        if preserve_node_ports:
            cmd.append("--preserve-nodeports")

        cmd.append("--wait")

        print(f"Restoring backup: {backup_name} as {restore_name}")
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise Exception(f"Restore failed: {result.stderr}")

        return {
            "restore_name": restore_name,
            "backup_name": backup_name,
            "status": "Completed",
            "timestamp": datetime.now().isoformat()
        }

    def list_restores(self) -> List[Dict]:
        """List all restore operations"""
        cmd = ["velero", "restore", "get", "-o", "json"]

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise Exception(f"Failed to list restores: {result.stderr}")

        data = json.loads(result.stdout)
        return data.get('items', [])

    def cleanup_old_backups(self, retention_days: int = 30,
                           label_selector: str = None):
        """Delete backups older than retention period"""
        cutoff_date = datetime.now() - timedelta(days=retention_days)
        backups = self.list_backups(label_selector=label_selector)

        deleted = []
        for backup in backups:
            metadata = backup.get('metadata', {})
            creation_time = datetime.fromisoformat(
                metadata.get('creationTimestamp', '').rstrip('Z')
            )

            if creation_time < cutoff_date:
                backup_name = metadata.get('name')
                print(f"Deleting old backup: {backup_name} (created {creation_time})")

                try:
                    self.delete_backup(backup_name, confirm=True)
                    deleted.append(backup_name)
                except Exception as e:
                    print(f"Failed to delete {backup_name}: {e}")

        return deleted

    def migrate_namespace(self, source_namespace: str, target_cluster_context: str,
                         target_namespace: str = None) -> Dict:
        """
        Migrate namespace to another cluster

        Args:
            source_namespace: Source namespace to migrate
            target_cluster_context: Target cluster kubectl context
            target_namespace: Target namespace (default: same as source)
        """
        if target_namespace is None:
            target_namespace = source_namespace

        # Create backup of source namespace
        backup_name = f"migration-{source_namespace}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

        print(f"Creating backup for migration: {backup_name}")
        self.create_backup(
            backup_name=backup_name,
            namespaces=[source_namespace],
            snapshot_volumes=True,
            ttl="24h"  # Short TTL for migrations
        )

        # Switch to target cluster
        original_context = subprocess.run(
            ["kubectl", "config", "current-context"],
            capture_output=True,
            text=True
        ).stdout.strip()

        try:
            print(f"Switching to target cluster: {target_cluster_context}")
            subprocess.run(
                ["kubectl", "config", "use-context", target_cluster_context],
                check=True
            )

            # Create namespace mapping if different
            namespace_mapping = {}
            if source_namespace != target_namespace:
                namespace_mapping[source_namespace] = target_namespace

            # Restore to target cluster
            restore_cmd = [
                "velero", "restore", "create",
                f"{backup_name}-restore",
                "--from-backup", backup_name,
                "--wait"
            ]

            if namespace_mapping:
                mappings = [f"{k}:{v}" for k, v in namespace_mapping.items()]
                restore_cmd.extend(["--namespace-mappings", ",".join(mappings)])

            print(f"Restoring to target cluster in namespace: {target_namespace}")
            subprocess.run(restore_cmd, check=True)

            return {
                "backup_name": backup_name,
                "source_namespace": source_namespace,
                "target_namespace": target_namespace,
                "target_cluster": target_cluster_context,
                "status": "Completed",
                "timestamp": datetime.now().isoformat()
            }

        finally:
            # Switch back to original cluster
            print(f"Switching back to original cluster: {original_context}")
            subprocess.run(
                ["kubectl", "config", "use-context", original_context],
                check=True
            )

    def verify_backup(self, backup_name: str) -> Dict:
        """Verify backup integrity and completeness"""
        details = self.get_backup_details(backup_name)

        status = details.get('status', {})
        phase = status.get('phase', 'Unknown')

        # Check for errors
        errors = status.get('errors', 0)
        warnings = status.get('warnings', 0)

        # Check volumes
        volume_snapshots = status.get('volumeSnapshotsAttempted', 0)
        volume_snapshots_completed = status.get('volumeSnapshotsCompleted', 0)

        return {
            'backup_name': backup_name,
            'phase': phase,
            'errors': errors,
            'warnings': warnings,
            'volume_snapshots_attempted': volume_snapshots,
            'volume_snapshots_completed': volume_snapshots_completed,
            'is_valid': phase == 'Completed' and errors == 0,
            'timestamp': details.get('metadata', {}).get('creationTimestamp')
        }

    def generate_backup_report(self) -> str:
        """Generate comprehensive backup report"""
        backups = self.list_backups()

        report = []
        report.append("=" * 80)
        report.append("VELERO BACKUP REPORT")
        report.append("=" * 80)
        report.append(f"Generated: {datetime.now().isoformat()}")
        report.append(f"Total Backups: {len(backups)}")
        report.append("")

        # Group by status
        by_status = {}
        for backup in backups:
            phase = backup.get('status', {}).get('phase', 'Unknown')
            if phase not in by_status:
                by_status[phase] = []
            by_status[phase].append(backup)

        report.append("BACKUP STATUS SUMMARY:")
        for phase, backup_list in by_status.items():
            report.append(f"  {phase}: {len(backup_list)}")
        report.append("")

        # Recent backups
        report.append("RECENT BACKUPS (Last 10):")
        recent = sorted(
            backups,
            key=lambda x: x.get('metadata', {}).get('creationTimestamp', ''),
            reverse=True
        )[:10]

        for backup in recent:
            metadata = backup.get('metadata', {})
            status = backup.get('status', {})
            name = metadata.get('name', 'Unknown')
            phase = status.get('phase', 'Unknown')
            timestamp = metadata.get('creationTimestamp', 'Unknown')
            errors = status.get('errors', 0)

            report.append(f"  {name}:")
            report.append(f"    Status: {phase}")
            report.append(f"    Created: {timestamp}")
            report.append(f"    Errors: {errors}")
            report.append("")

        return "\n".join(report)

# Example usage
def main():
    manager = VeleroBackupManager()

    # Create on-demand backup
    print("Creating backup...")
    result = manager.create_backup(
        backup_name="production-backup",
        namespaces=["production", "staging"],
        snapshot_volumes=True,
        ttl="720h"
    )
    print(f"Backup created: {result['backup_name']}")

    # Verify backup
    print("\nVerifying backup...")
    verification = manager.verify_backup(result['backup_name'])
    print(f"Backup valid: {verification['is_valid']}")
    print(f"Errors: {verification['errors']}")
    print(f"Warnings: {verification['warnings']}")

    # Generate report
    print("\n" + manager.generate_backup_report())

    # Cleanup old backups
    print("\nCleaning up old backups...")
    deleted = manager.cleanup_old_backups(retention_days=30)
    print(f"Deleted {len(deleted)} old backups")

if __name__ == "__main__":
    main()
```

## Disaster Recovery Procedures

### Disaster Recovery Playbook

```bash
#!/bin/bash
# disaster-recovery.sh
# Velero disaster recovery procedures

set -e

BACKUP_NAME="${1:-latest}"
TARGET_CLUSTER="${2:-production}"

echo "=========================================="
echo "VELERO DISASTER RECOVERY"
echo "=========================================="
echo "Backup: $BACKUP_NAME"
echo "Target Cluster: $TARGET_CLUSTER"
echo "=========================================="

# Step 1: Verify backup exists
echo "Step 1: Verifying backup existence..."
if ! velero backup get "$BACKUP_NAME" &>/dev/null; then
    echo "ERROR: Backup $BACKUP_NAME not found!"
    echo "Available backups:"
    velero backup get
    exit 1
fi

echo "Backup found: $BACKUP_NAME"

# Step 2: Check backup status
echo ""
echo "Step 2: Checking backup status..."
BACKUP_PHASE=$(velero backup describe "$BACKUP_NAME" -o json | jq -r '.status.phase')
BACKUP_ERRORS=$(velero backup describe "$BACKUP_NAME" -o json | jq -r '.status.errors // 0')

echo "Backup Phase: $BACKUP_PHASE"
echo "Backup Errors: $BACKUP_ERRORS"

if [ "$BACKUP_PHASE" != "Completed" ]; then
    echo "ERROR: Backup is not in Completed state!"
    exit 1
fi

if [ "$BACKUP_ERRORS" != "0" ]; then
    echo "WARNING: Backup has errors!"
    read -p "Continue anyway? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        exit 1
    fi
fi

# Step 3: Confirm disaster recovery
echo ""
echo "Step 3: Confirming disaster recovery..."
echo "WARNING: This will restore resources to cluster: $TARGET_CLUSTER"
echo "This operation may overwrite existing resources!"
read -p "Type 'yes' to confirm: " confirm

if [ "$confirm" != "yes" ]; then
    echo "Disaster recovery cancelled."
    exit 0
fi

# Step 4: Create restore
echo ""
echo "Step 4: Creating restore..."
RESTORE_NAME="dr-restore-$(date +%Y%m%d-%H%M%S)"

velero restore create "$RESTORE_NAME" \
    --from-backup "$BACKUP_NAME" \
    --wait

# Step 5: Verify restore
echo ""
echo "Step 5: Verifying restore..."
RESTORE_PHASE=$(velero restore describe "$RESTORE_NAME" -o json | jq -r '.status.phase')
RESTORE_ERRORS=$(velero restore describe "$RESTORE_NAME" -o json | jq -r '.status.errors // 0')
RESTORE_WARNINGS=$(velero restore describe "$RESTORE_NAME" -o json | jq -r '.status.warnings // 0')

echo "Restore Phase: $RESTORE_PHASE"
echo "Restore Errors: $RESTORE_ERRORS"
echo "Restore Warnings: $RESTORE_WARNINGS"

if [ "$RESTORE_PHASE" != "Completed" ]; then
    echo "ERROR: Restore did not complete successfully!"
    velero restore logs "$RESTORE_NAME"
    exit 1
fi

# Step 6: Verify resources
echo ""
echo "Step 6: Verifying restored resources..."

echo "Checking pods..."
kubectl get pods --all-namespaces | grep -v "Running\|Completed" || echo "All pods running"

echo "Checking PVCs..."
kubectl get pvc --all-namespaces | grep -v "Bound" || echo "All PVCs bound"

# Step 7: Success
echo ""
echo "=========================================="
echo "DISASTER RECOVERY COMPLETED SUCCESSFULLY"
echo "=========================================="
echo "Backup: $BACKUP_NAME"
echo "Restore: $RESTORE_NAME"
echo "Cluster: $TARGET_CLUSTER"
echo "Timestamp: $(date)"
echo "=========================================="
```

## Monitoring and Alerting

### Prometheus Monitoring

```yaml
# velero-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: velero
  namespace: velero
  labels:
    app: velero
spec:
  selector:
    matchLabels:
      app: velero
  endpoints:
  - port: monitoring
    interval: 30s

---
# Velero alerting rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: velero-alerts
  namespace: velero
spec:
  groups:
  - name: velero
    interval: 30s
    rules:
    # Backup failures
    - alert: VeleroBackupFailed
      expr: velero_backup_failure_total > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Velero backup has failed"
        description: "Velero backup {{ $labels.backup }} has failed"

    # Backup partial failures
    - alert: VeleroBackupPartialFailure
      expr: velero_backup_partial_failure_total > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Velero backup has partial failures"
        description: "Velero backup {{ $labels.backup }} has partial failures"

    # No recent backups
    - alert: VeleroNoRecentBackup
      expr: time() - velero_backup_last_successful_timestamp{schedule!=""} > 86400
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "No recent Velero backup"
        description: "Schedule {{ $labels.schedule }} has not completed a backup in 24 hours"

    # Restore failures
    - alert: VeleroRestoreFailed
      expr: velero_restore_failed_total > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Velero restore has failed"
        description: "Velero restore {{ $labels.restore }} has failed"

    # Volume snapshot failures
    - alert: VeleroVolumeSnapshotFailed
      expr: rate(velero_volume_snapshot_failure_total[5m]) > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Velero volume snapshot failures"
        description: "Volume snapshots are failing"

    # Backup repository errors
    - alert: VeleroBackupRepositoryErrors
      expr: velero_backup_repository_errors_total > 0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Velero backup repository errors"
        description: "Backup repository is experiencing errors"
```

## Conclusion

Velero provides enterprise-grade backup and disaster recovery for Kubernetes clusters. Key implementation points:

1. **Automated Backups**: Schedule-based backups with appropriate retention policies
2. **Volume Snapshots**: CSI snapshot integration for efficient volume backups
3. **Backup Hooks**: Pre/post backup hooks for application consistency
4. **Disaster Recovery**: Documented procedures for cluster recovery
5. **Migration**: Cross-cluster migration capabilities
6. **Monitoring**: Comprehensive alerting for backup health

Velero ensures business continuity and enables confident cluster migrations for enterprise Kubernetes environments.

## Additional Resources

- [Velero Documentation](https://velero.io/docs/)
- [Backup Hooks](https://velero.io/docs/main/backup-hooks/)
- [Disaster Recovery](https://velero.io/docs/main/disaster-case/)
- [CSI Snapshot Support](https://velero.io/docs/main/csi/)