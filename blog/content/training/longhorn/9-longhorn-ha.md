---
title: "Longhorn High Availability Configuration"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Storage", "High Availability"]
categories:
- Longhorn
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to configuring high availability in Longhorn storage systems"
more_link: "yes"
url: "/training/longhorn/ha/"
---

This guide covers high availability configuration for Longhorn storage, including replica management, node failure handling, and disaster recovery strategies.

<!--more-->

# [Replica Management](#replica-management)

## 1. Volume Replica Configuration

### Basic HA Configuration
```yaml
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: ha-volume
spec:
  numberOfReplicas: 3
  dataLocality: "best-effort"
  replicaAutoBalance: "least-effort"
  nodeSelector:
    zone: "us-east-1a"
```

### Advanced Replica Settings
```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-ha
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "30"
  fromBackup: ""
  replicaZoneSoftAntiAffinity: "true"
  replicaAutoBalance: "best-effort"
```

## 2. Node Affinity Rules

### Zone-based Distribution
```yaml
apiVersion: longhorn.io/v1beta1
kind: Node
metadata:
  name: storage-node-1
spec:
  tags:
    - "zone-a"
  disks:
    disk1:
      path: /mnt/disk1
      allowScheduling: true
      tags: ["ssd"]
```

### Anti-affinity Configuration
```yaml
apiVersion: longhorn.io/v1beta1
kind: Setting
metadata:
  name: replica-zone-soft-anti-affinity
value: "true"
```

# [Failure Handling](#failure-handling)

## 1. Node Failure Recovery

### Automatic Recovery Settings
```yaml
apiVersion: longhorn.io/v1beta1
kind: Setting
metadata:
  name: replica-replenishment-wait-interval
value: "600"
---
apiVersion: longhorn.io/v1beta1
kind: Setting
metadata:
  name: failed-replica-rebuild-timeout
value: "30"
```

### Node Drain Handling
```yaml
apiVersion: longhorn.io/v1beta1
kind: Setting
metadata:
  name: kubernetes-node-down-policy
value: "delete-local-data"
```

## 2. Volume Failover

### Failover Configuration
```yaml
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: failover-volume
spec:
  numberOfReplicas: 3
  replicaAutoBalance: "best-effort"
  failurePolicy:
    type: "failover"
    timeout: 300
```

### Recovery Settings
```yaml
apiVersion: longhorn.io/v1beta1
kind: Setting
metadata:
  name: concurrent-replica-rebuild-per-node-limit
value: "5"
```

# [Network Resilience](#network)

## 1. Network Redundancy

### Multi-network Configuration
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: longhorn-network-config
  namespace: longhorn-system
data:
  network-redundancy: |
    {
      "primary": "eth0",
      "backup": "eth1"
    }
```

### Network Policy
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: longhorn-network-policy
spec:
  podSelector:
    matchLabels:
      app: longhorn
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: longhorn
    ports:
    - protocol: TCP
      port: 9500
```

## 2. Load Balancing

### Service Configuration
```yaml
apiVersion: v1
kind: Service
metadata:
  name: longhorn-frontend
spec:
  type: LoadBalancer
  selector:
    app: longhorn-ui
  ports:
  - port: 80
    targetPort: 8000
```

# [Data Protection](#data-protection)

## 1. Volume Snapshot Configuration

### Automated Snapshots
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

### Snapshot Class
```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-snapshot-class
driver: driver.longhorn.io
deletionPolicy: Delete
parameters:
  type: snap
```

## 2. Data Consistency

### Consistent Snapshot Settings
```yaml
apiVersion: longhorn.io/v1beta1
kind: Setting
metadata:
  name: snapshot-data-integrity
value: "enabled"
```

# [Monitoring and Alerts](#monitoring)

## 1. Health Checks

### Liveness Probe
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: longhorn-manager
spec:
  containers:
  - name: longhorn-manager
    livenessProbe:
      httpGet:
        path: /healthz
        port: 9500
      initialDelaySeconds: 15
      periodSeconds: 10
```

### Alert Rules
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-ha-alerts
spec:
  groups:
  - name: longhorn.rules
    rules:
    - alert: LonghornVolumeReplicaCountLow
      expr: longhorn_volume_replica_count < 3
      for: 5m
      labels:
        severity: warning
```

# [Best Practices](#best-practices)

1. **Replica Management**
   - Maintain at least 3 replicas for critical volumes
   - Enable replica auto-balancing
   - Configure zone-based anti-affinity
   - Regular replica health checks

2. **Failure Recovery**
   - Set appropriate timeout values
   - Configure automatic recovery
   - Implement proper drain procedures
   - Monitor recovery progress

3. **Network Configuration**
   - Use redundant networks
   - Implement proper security policies
   - Configure load balancing
   - Monitor network health

4. **Data Protection**
   - Regular snapshot scheduling
   - Validate snapshot consistency
   - Monitor snapshot status
   - Test recovery procedures

# [Conclusion](#conclusion)

Implementing high availability in Longhorn requires:
- Proper replica configuration
- Effective failure handling
- Network resilience
- Robust monitoring

For more information, check out:
- [Performance Optimization](/training/longhorn/performance/)
- [Backup and Recovery](/training/longhorn/backup/)
- [Monitoring Guide](/training/longhorn/monitoring/)
