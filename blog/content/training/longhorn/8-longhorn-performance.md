---
title: "Longhorn Performance Tuning"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Storage", "Performance"]
categories:
- Longhorn
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to optimizing Longhorn performance in production environments"
more_link: "yes"
url: "/training/longhorn/performance/"
---

This guide covers performance optimization techniques for Longhorn storage, including system tuning, monitoring, and best practices for achieving optimal performance.

<!--more-->

# [Storage Performance Optimization](#storage-optimization)

## 1. Disk Configuration

### SSD Configuration
```yaml
apiVersion: longhorn.io/v1beta1
kind: Node
metadata:
  name: storage-node
spec:
  disks:
    nvme0:
      path: /mnt/nvme0
      allowScheduling: true
      storageReserved: 10Gi
      tags: ["ssd", "fast"]
    nvme1:
      path: /mnt/nvme1
      allowScheduling: true
      storageReserved: 10Gi
      tags: ["ssd", "fast"]
```

### Disk Performance Settings
```bash
# Optimize disk I/O scheduler
echo "noop" > /sys/block/nvme0n1/queue/scheduler

# Increase read-ahead buffer
blockdev --setra 8192 /dev/nvme0n1

# Tune I/O parameters
echo "1000000" > /proc/sys/vm/dirty_bytes
echo "1000000" > /proc/sys/vm/dirty_background_bytes
```

## 2. Volume Settings

### High-Performance Volume Configuration
```yaml
apiVersion: longhorn.io/v1beta1
kind: Volume
metadata:
  name: high-perf-volume
spec:
  numberOfReplicas: 3
  dataLocality: "best-effort"
  nodeSelector:
    storage: "fast"
  diskSelector:
    - "ssd"
  replicaAutoBalance: "best-effort"
```

### Storage Class Configuration
```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-high-performance
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "3"
  staleReplicaTimeout: "30"
  fromBackup: ""
  diskSelector: "ssd"
  nodeSelector: "storage"
```

# [Network Optimization](#network-optimization)

## 1. Network Settings

### System Configuration
```bash
# Increase network buffer sizes
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.wmem_max=16777216
sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216"
sysctl -w net.ipv4.tcp_wmem="4096 87380 16777216"
```

### Dedicated Storage Network
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: longhorn-storage-network
  namespace: longhorn-system
data:
  storage-network: |
    {
      "network": "192.168.10.0/24",
      "interface": "eth1"
    }
```

## 2. Network QoS

### Traffic Shaping
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: storage-network-policy
spec:
  podSelector:
    matchLabels:
      app: longhorn-manager
  ingress:
  - from:
    - podSelector:
        matchLabels:
          storage-traffic: "true"
    ports:
    - protocol: TCP
      port: 9500
```

# [System Tuning](#system-tuning)

## 1. Kernel Parameters

### Performance Settings
```bash
# Create sysctl configuration
cat > /etc/sysctl.d/99-longhorn-performance.conf <<EOF
# VM settings
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 500
vm.dirty_writeback_centisecs = 100

# I/O settings
vm.swappiness = 1
vm.vfs_cache_pressure = 50

# Network settings
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 87380 16777216
EOF

# Apply settings
sysctl --system
```

## 2. Resource Limits

### Container Settings
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: longhorn-manager
spec:
  containers:
  - name: longhorn-manager
    resources:
      requests:
        memory: "512Mi"
        cpu: "250m"
      limits:
        memory: "1Gi"
        cpu: "500m"
```

# [Monitoring and Metrics](#monitoring)

## 1. Prometheus Integration

### ServiceMonitor Configuration
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: longhorn-prometheus
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: longhorn-manager
  endpoints:
  - port: manager
    path: /metrics
    interval: 10s
```

### Custom Metrics
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-alerts
spec:
  groups:
  - name: longhorn.rules
    rules:
    - alert: LonghornVolumeHighLatency
      expr: rate(longhorn_volume_read_latency_microseconds[5m]) > 1000000
      for: 5m
      labels:
        severity: warning
```

## 2. Performance Dashboards

### Grafana Dashboard
```json
{
  "dashboard": {
    "panels": [
      {
        "title": "Volume IOPS",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(longhorn_volume_read_ops_total[5m])",
            "legendFormat": "Read IOPS - {{volume}}"
          },
          {
            "expr": "rate(longhorn_volume_write_ops_total[5m])",
            "legendFormat": "Write IOPS - {{volume}}"
          }
        ]
      }
    ]
  }
}
```

# [Performance Testing](#testing)

## 1. FIO Benchmarking

### Basic Test
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
          fio --name=randwrite --ioengine=libaio --iodepth=64 \
              --rw=randwrite --bs=4k --direct=1 --size=4G \
              --numjobs=4 --runtime=240 --group_reporting
        volumeMounts:
        - name: test-vol
          mountPath: /data
      volumes:
      - name: test-vol
        persistentVolumeClaim:
          claimName: test-pvc
```

### Advanced Test Suite
```bash
#!/bin/bash
# Comprehensive performance test suite
tests=(
  "randread"
  "randwrite"
  "read"
  "write"
)

for test in "${tests[@]}"; do
  fio --name=$test \
      --ioengine=libaio \
      --iodepth=64 \
      --rw=$test \
      --bs=4k \
      --direct=1 \
      --size=4G \
      --numjobs=4 \
      --runtime=240 \
      --group_reporting \
      --output=$test.json \
      --output-format=json
done
```

# [Best Practices](#best-practices)

1. **Storage Configuration**
   - Use high-performance SSDs
   - Configure proper disk scheduling
   - Implement storage tiering
   - Monitor disk health

2. **Network Optimization**
   - Use dedicated storage network
   - Configure jumbo frames
   - Implement QoS policies
   - Monitor network latency

3. **System Tuning**
   - Optimize kernel parameters
   - Configure resource limits
   - Regular performance testing
   - Monitor system metrics

4. **Maintenance**
   - Regular performance audits
   - Proactive monitoring
   - Capacity planning
   - Performance trending

# [Conclusion](#conclusion)

Optimizing Longhorn performance requires:
- Proper hardware configuration
- System-level tuning
- Regular monitoring
- Performance testing

For more information, check out:
- [Advanced Operations](/training/longhorn/advanced/)
- [Troubleshooting Guide](/training/longhorn/troubleshooting/)
- [Architecture Guide](/training/longhorn/architecture/)
