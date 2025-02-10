---
title: "Longhorn Troubleshooting Guide"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Storage", "Troubleshooting"]
categories:
- Longhorn
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive troubleshooting guide for common Longhorn issues and their solutions"
more_link: "yes"
url: "/training/longhorn/troubleshooting/"
---

This guide provides detailed troubleshooting steps for common Longhorn issues, including diagnostics, solutions, and preventive measures.

<!--more-->

# [Common Issues](#common-issues)

## 1. Volume Creation Failures

### Symptoms
- PVC remains in Pending state
- Volume creation times out
- Error in volume creation events

### Diagnosis
```bash
# Check PVC status
kubectl get pvc

# Check volume events
kubectl -n longhorn-system get events | grep volume-name

# Check Longhorn manager logs
kubectl -n longhorn-system logs -l app=longhorn-manager
```

### Solutions
```bash
# Verify storage class
kubectl get storageclass longhorn -o yaml

# Check node capacity
kubectl -n longhorn-system get node -o yaml

# Force delete stuck volume
kubectl -n longhorn-system delete volume stuck-volume --force
```

## 2. Volume Attachment Issues

### Symptoms
- Pod stuck in ContainerCreating
- Volume fails to mount
- IO errors in application logs

### Diagnosis
```bash
# Check pod events
kubectl describe pod pod-name

# Check volume status
kubectl -n longhorn-system get volume volume-name -o yaml

# Check instance manager logs
kubectl -n longhorn-system logs -l app=longhorn-instance-manager
```

### Solutions
```bash
# Force detach volume
kubectl -n longhorn-system patch volume volume-name \
  --type='json' -p='[{"op": "replace", "path": "/spec/nodeID", "value":""}]'

# Restart instance manager
kubectl -n longhorn-system delete pod -l app=longhorn-instance-manager
```

# [Replica Issues](#replica-issues)

## 1. Replica Rebuilding Problems

### Diagnosis
```bash
# Check replica status
kubectl -n longhorn-system get replicas

# Monitor rebuild progress
kubectl -n longhorn-system logs \
  $(kubectl -n longhorn-system get pod -l app=longhorn-manager -o jsonpath='{.items[0].metadata.name}') \
  | grep rebuild
```

### Solutions
```bash
# Force rebuild replica
kubectl -n longhorn-system exec -it longhorn-manager-xxx -- \
  longhorn-manager replica-rebuild volume-name

# Clean up failed replicas
kubectl -n longhorn-system delete replica failed-replica
```

## 2. Replica Scheduling Issues

### Diagnosis
```bash
# Check node conditions
kubectl -n longhorn-system get nodes

# Verify disk status
kubectl -n longhorn-system get node node-name -o yaml
```

### Solutions
```yaml
# Update node disk configuration
apiVersion: longhorn.io/v1beta1
kind: Node
metadata:
  name: worker-1
spec:
  disks:
    default-disk:
      path: /var/lib/longhorn
      allowScheduling: true
      storageReserved: 10Gi
```

# [Performance Issues](#performance-issues)

## 1. Slow IO Performance

### Diagnosis
```bash
# Check disk latency
kubectl -n longhorn-system exec -it longhorn-manager-xxx -- \
  longhorn-manager info volume | grep latency

# Monitor IO metrics
kubectl -n longhorn-system get metrics volume-name
```

### Solutions
```yaml
# Optimize volume settings
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: volume-name
spec:
  numberOfReplicas: 2
  dataLocality: "best-effort"
  replicaAutoBalance: "best-effort"
```

## 2. Network Performance

### Diagnosis
```bash
# Check network metrics
kubectl -n longhorn-system exec -it longhorn-manager-xxx -- \
  longhorn-manager info network

# Monitor network latency
kubectl -n longhorn-system get metrics network
```

### Solutions
```bash
# Configure network QoS
kubectl -n longhorn-system patch settings network-quality \
  --type='json' -p='[{"op": "replace", "path": "/value", "value":"high"}]'
```

# [Backup and Restore Issues](#backup-issues)

## 1. Backup Failures

### Diagnosis
```bash
# Check backup status
kubectl -n longhorn-system get backupvolume

# Verify backup target
kubectl -n longhorn-system get backuptarget

# Check backup logs
kubectl -n longhorn-system logs -l app=longhorn-backup-controller
```

### Solutions
```bash
# Verify backup credentials
kubectl -n longhorn-system get secret aws-credentials -o yaml

# Force backup cleanup
kubectl -n longhorn-system delete backup failed-backup
```

## 2. Restore Failures

### Diagnosis
```bash
# Check restore status
kubectl -n longhorn-system get restorevolume

# Monitor restore progress
kubectl -n longhorn-system logs \
  $(kubectl -n longhorn-system get pod -l app=longhorn-manager -o jsonpath='{.items[0].metadata.name}') \
  | grep restore
```

### Solutions
```bash
# Clean up failed restore
kubectl -n longhorn-system delete volume failed-restore

# Retry restore with different options
kubectl -n longhorn-system create -f - <<EOF
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: restored-volume
spec:
  fromBackup: backupstore:///backup-name
  numberOfReplicas: 2
  staleReplicaTimeout: 60
EOF
```

# [System Recovery](#recovery)

## 1. Node Recovery

### Steps
```bash
# 1. Cordon node
kubectl cordon node-name

# 2. Evacuate volumes
kubectl -n longhorn-system annotate node node-name \
  node.longhorn.io/evacuate=true

# 3. Wait for volume migration
kubectl -n longhorn-system get volumes

# 4. Maintenance work
systemctl restart iscsid

# 5. Uncordon node
kubectl uncordon node-name
```

## 2. Volume Recovery

### Steps
```bash
# 1. Force detach volume
kubectl -n longhorn-system patch volume volume-name \
  --type='json' -p='[{"op": "replace", "path": "/spec/nodeID", "value":""}]'

# 2. Delete failed replicas
kubectl -n longhorn-system delete replica failed-replica

# 3. Recreate replicas
kubectl -n longhorn-system patch volume volume-name \
  --type='json' -p='[{"op": "replace", "path": "/spec/numberOfReplicas", "value":3}]'

# 4. Verify recovery
kubectl -n longhorn-system get volume volume-name -o yaml
```

# [Preventive Measures](#prevention)

1. **Regular Health Checks**
```bash
# Daily health check script
#!/bin/bash
kubectl -n longhorn-system get volumes
kubectl -n longhorn-system get nodes
kubectl -n longhorn-system get replicas
kubectl -n longhorn-system get events
```

2. **Monitoring Setup**
```yaml
# Prometheus alert rule
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-alerts
spec:
  groups:
  - name: longhorn
    rules:
    - alert: LonghornVolumeActualSizeHigh
      expr: longhorn_volume_actual_size_bytes > 0.9 * longhorn_volume_size_bytes
      for: 5m
      labels:
        severity: warning
```

3. **Backup Verification**
```bash
# Verify backup integrity
kubectl -n longhorn-system exec -it longhorn-manager-xxx -- \
  longhorn-manager backup verify backup-name
```

# [Best Practices](#best-practices)

1. **Regular Maintenance**
   - Schedule regular backups
   - Monitor system resources
   - Keep Longhorn updated
   - Regular health checks

2. **Configuration Management**
   - Version control settings
   - Document changes
   - Regular audits

3. **Monitoring**
   - Set up alerts
   - Monitor metrics
   - Regular log review

For more information, check out:
- [Longhorn Advanced Operations](/training/longhorn/advanced/)
- [Architecture Guide](/training/longhorn/architecture/)
- [Performance Tuning](/training/longhorn/performance/)
