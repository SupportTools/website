---
title: "Longhorn Advanced Operations"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Storage", "Advanced"]
categories:
- Longhorn
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced operations, troubleshooting, and performance tuning for Longhorn storage"
more_link: "yes"
url: "/training/longhorn/advanced/"
---

This guide covers advanced Longhorn operations, including performance tuning, troubleshooting, and advanced features for production environments.

<!--more-->

# [Performance Tuning](#performance)

## Storage Performance Optimization

### 1. Disk Configuration
```yaml
apiVersion: longhorn.io/v1beta1
kind: Node
metadata:
  name: worker-1
spec:
  disks:
    nvme0:
      path: /mnt/nvme0
      allowScheduling: true
      storageReserved: 10Gi
      tags: ["ssd", "fast"]
```

### 2. Volume Settings
```yaml
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: high-performance
spec:
  numberOfReplicas: 3
  frontend: blockdev
  engineImage: longhornio/longhorn-engine:v1.4.0
  diskSelector: ["ssd"]
  nodeSelector: ["storage"]
```

## Network Optimization
```yaml
# Node configuration for dedicated storage network
apiVersion: v1
kind: Node
metadata:
  annotations:
    storage.network: "192.168.10.0/24"
```

# [Advanced Features](#features)

## 1. Backup Configuration
```yaml
apiVersion: longhorn.io/v1beta1
kind: BackupTarget
metadata:
  name: s3-backup
spec:
  backupTargetURL: s3://your-bucket@us-east-1/
  credentialSecret: aws-credentials
```

## 2. Recurring Jobs
```yaml
apiVersion: longhorn.io/v1beta1
kind: RecurringJob
metadata:
  name: daily-backup
spec:
  cron: "0 0 * * *"
  task: "backup"
  groups: ["default"]
  retain: 7
  concurrency: 2
```

# [Monitoring Setup](#monitoring)

## 1. Prometheus Integration
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: longhorn-prometheus
spec:
  selector:
    matchLabels:
      app: longhorn-manager
  endpoints:
  - port: manager
```

## 2. Custom Metrics
```yaml
# Grafana Dashboard Configuration
{
  "datasource": "Prometheus",
  "fieldConfig": {
    "defaults": {
      "custom": {},
      "mappings": [],
      "thresholds": {
        "mode": "absolute",
        "steps": []
      }
    },
    "overrides": []
  },
  "panels": [
    {
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "targets": [
        {
          "expr": "longhorn_volume_actual_size_bytes",
          "interval": "",
          "legendFormat": "",
          "refId": "A"
        }
      ],
      "title": "Volume Actual Size",
      "type": "gauge"
    }
  ]
}
```

# [Troubleshooting](#troubleshooting)

## 1. Volume Recovery
```bash
# Check volume state
kubectl -n longhorn-system get volumes

# Force delete a stuck volume
kubectl -n longhorn-system patch volumes stuck-volume \
  --type='json' -p='[{"op": "replace", "path": "/metadata/finalizers", "value":[]}]'

# Recover replica
kubectl -n longhorn-system exec -it longhorn-manager-xxx -- \
  longhorn-manager replica-rebuild volume-name
```

## 2. Node Recovery
```bash
# Check node status
kubectl -n longhorn-system get nodes

# Cordon node for maintenance
kubectl cordon worker-1

# Evacuate volumes
kubectl -n longhorn-system annotate node worker-1 \
  node.longhorn.io/evacuate=true
```

# [High Availability Configuration](#ha)

## 1. Volume Replication
```yaml
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: ha-volume
spec:
  numberOfReplicas: 3
  replicaAutoBalance: "best-effort"
  dataLocality: "best-effort"
```

## 2. Node Affinity Rules
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: storage-pod
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: storage
            operator: In
            values:
            - "true"
```

# [Disaster Recovery](#dr)

## 1. Backup Strategy
```yaml
# Volume backup configuration
apiVersion: longhorn.io/v1beta1
kind: VolumeBackup
metadata:
  name: critical-backup
spec:
  snapshotName: snapshot-1
  volume: critical-volume
```

## 2. Recovery Process
```bash
# Restore from backup
kubectl -n longhorn-system create -f - <<EOF
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: restored-volume
spec:
  fromBackup: backupstore:///backup-name
EOF
```

# [Performance Testing](#testing)

## 1. FIO Benchmarking
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: fio-test
spec:
  template:
    spec:
      containers:
      - name: fio
        image: nixery.dev/shell/fio
        command: 
        - /bin/sh
        - -c
        - |
          fio --name=randwrite --ioengine=libaio --iodepth=1 \
              --rw=randwrite --bs=4k --direct=0 --size=512M \
              --numjobs=2 --runtime=240 --group_reporting
        volumeMounts:
        - name: test-vol
          mountPath: /data
      volumes:
      - name: test-vol
        persistentVolumeClaim:
          claimName: test-pvc
```

## 2. Results Analysis
```bash
# Collect performance metrics
kubectl -n longhorn-system exec -it \
  $(kubectl -n longhorn-system get pod -l app=longhorn-manager -o jsonpath='{.items[0].metadata.name}') \
  -- longhorn-manager info volume
```

# [Best Practices](#best-practices)

1. **Storage Configuration**
   - Use dedicated storage nodes
   - Implement proper backup strategies
   - Monitor disk usage regularly

2. **Performance**
   - Use SSDs for better performance
   - Configure proper replica count
   - Implement resource limits

3. **Maintenance**
   - Regular health checks
   - Scheduled backups
   - Update planning

# [Conclusion](#conclusion)

Understanding advanced Longhorn operations is crucial for:
- Optimal performance
- Reliable disaster recovery
- Effective troubleshooting
- Production readiness

For more information, check out:
- [Longhorn Basics](/training/longhorn/basics/)
- [Architecture Guide](/training/longhorn/architecture/)
- [Installation Guide](/training/longhorn/installation/)
