---
title: "Longhorn Backup and Disaster Recovery"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Storage", "Backup", "Disaster Recovery"]
categories:
- Longhorn
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing backup and disaster recovery strategies with Longhorn"
more_link: "yes"
url: "/training/longhorn/backup/"
---

This guide covers backup and disaster recovery strategies for Longhorn storage, including backup configuration, recovery procedures, and best practices.

<!--more-->

# [Backup Configuration](#backup-config)

## 1. Backup Target Setup

### S3 Compatible Storage
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: backup-target-credential
  namespace: longhorn-system
type: Opaque
data:
  AWS_ACCESS_KEY_ID: <base64-encoded-access-key>
  AWS_SECRET_ACCESS_KEY: <base64-encoded-secret-key>
---
apiVersion: longhorn.io/v1beta1
kind: Setting
metadata:
  name: backup-target
value: s3://your-bucket-name@us-east-1/
---
apiVersion: longhorn.io/v1beta1
kind: Setting
metadata:
  name: backup-target-credential-secret
value: backup-target-credential
```

### NFS Backup Target
```yaml
apiVersion: longhorn.io/v1beta1
kind: Setting
metadata:
  name: backup-target
value: nfs://192.168.1.100:/backup
```

## 2. Backup Schedule

### Recurring Backup Job
```yaml
apiVersion: longhorn.io/v1beta1
kind: RecurringJob
metadata:
  name: backup-daily
spec:
  cron: "0 0 * * *"
  task: "backup"
  groups:
  - default
  retain: 7
  concurrency: 2
```

### Volume Backup Settings
```yaml
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: backup-volume
spec:
  numberOfReplicas: 3
  backupPolicy:
    enabled: true
    schedule: "0 */6 * * *"
    retain: 5
```

# [Disaster Recovery](#disaster-recovery)

## 1. Backup Recovery

### Restore from Backup
```yaml
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: restored-volume
spec:
  numberOfReplicas: 3
  fromBackup: "backup-target/backup-name"
```

### Recovery PVC
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: restored-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  resources:
    requests:
      storage: 10Gi
  dataSource:
    name: backup-name
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
```

## 2. Site Recovery

### Cross-Cluster Restore
```yaml
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: dr-volume
spec:
  numberOfReplicas: 3
  fromBackup: "s3://backup-bucket@us-east-1/backups/volume-backup?backup=backup-name"
```

### Recovery Plan
```yaml
apiVersion: longhorn.io/v1beta1
kind: RecoveryPlan
metadata:
  name: site-recovery
spec:
  recoveryPoint: "latest"
  volumes:
  - name: critical-volume-1
    backup: "backup-name-1"
  - name: critical-volume-2
    backup: "backup-name-2"
```

# [Data Protection](#data-protection)

## 1. Snapshot Management

### Volume Snapshot
```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: volume-snap-1
spec:
  volumeSnapshotClassName: longhorn-snapshot-class
  source:
    persistentVolumeClaimName: pvc-1
```

### Snapshot Schedule
```yaml
apiVersion: longhorn.io/v1beta1
kind: RecurringJob
metadata:
  name: snapshot-hourly
spec:
  cron: "0 * * * *"
  task: "snapshot"
  groups:
  - default
  retain: 24
  concurrency: 2
```

## 2. Data Verification

### Backup Verification
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: backup-verify
spec:
  template:
    spec:
      containers:
      - name: verify
        image: longhornio/longhorn-manager:v1.5.1
        command: ["longhorn", "backup", "verify"]
```

# [Recovery Testing](#testing)

## 1. Recovery Validation

### Test Restore Job
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: restore-test
spec:
  template:
    spec:
      containers:
      - name: restore-test
        image: longhornio/longhorn-manager:v1.5.1
        command:
        - /bin/sh
        - -c
        - |
          longhorn backup restore test-restore
```

### Validation Script
```bash
#!/bin/bash
# Backup validation script
backup_name=$1
restore_name="test-restore-${RANDOM}"

# Restore backup
kubectl create -f - <<EOF
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: ${restore_name}
spec:
  numberOfReplicas: 1
  fromBackup: "${backup_name}"
EOF

# Wait for restore
kubectl wait --for=condition=Ready volume/${restore_name}

# Validate data
# Add your validation logic here

# Cleanup
kubectl delete volume ${restore_name}
```

# [Best Practices](#best-practices)

1. **Backup Strategy**
   - Regular backup scheduling
   - Multiple backup targets
   - Backup verification
   - Retention policy management

2. **Recovery Planning**
   - Document recovery procedures
   - Regular recovery testing
   - Cross-region backup copies
   - Recovery time objectives (RTO)

3. **Data Protection**
   - Encryption at rest
   - Secure backup transport
   - Access control
   - Audit logging

4. **Testing and Validation**
   - Regular restore testing
   - Data integrity checks
   - Performance validation
   - Documentation updates

# [Conclusion](#conclusion)

Effective backup and disaster recovery requires:
- Proper backup configuration
- Regular testing
- Documented procedures
- Monitoring and validation

For more information, check out:
- [High Availability Configuration](/training/longhorn/ha/)
- [Performance Optimization](/training/longhorn/performance/)
- [Monitoring Guide](/training/longhorn/monitoring/)
