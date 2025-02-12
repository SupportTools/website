---
title: "Longhorn Monitoring and Maintenance"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Storage", "Monitoring", "Maintenance"]
categories:
- Longhorn
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to monitoring and maintaining Longhorn storage systems"
more_link: "yes"
url: "/training/longhorn/monitoring/"
---

This guide covers monitoring and maintenance strategies for Longhorn storage, including metrics collection, alerting, and routine maintenance procedures.

<!--more-->

# [Monitoring Setup](#monitoring-setup)

## 1. Prometheus Integration

### ServiceMonitor Configuration
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: longhorn-monitoring
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

### Prometheus Rules
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-alerts
spec:
  groups:
  - name: longhorn.rules
    rules:
    - alert: LonghornVolumeUsageHigh
      expr: longhorn_volume_usage_percentage > 80
      for: 5m
      labels:
        severity: warning
      annotations:
        description: "Volume {{ $labels.volume }} usage is {{ $value }}%"
    - alert: LonghornDiskSpaceLow
      expr: longhorn_node_storage_usage_percentage > 85
      for: 5m
      labels:
        severity: critical
```

## 2. Grafana Dashboards

### Dashboard Configuration
```json
{
  "dashboard": {
    "id": null,
    "title": "Longhorn Storage Overview",
    "panels": [
      {
        "title": "Volume Status",
        "type": "gauge",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "longhorn_volume_robustness",
            "legendFormat": "{{volume}}"
          }
        ]
      },
      {
        "title": "Disk Usage",
        "type": "graph",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "longhorn_node_storage_usage_percentage",
            "legendFormat": "{{node}}"
          }
        ]
      }
    ]
  }
}
```

# [Performance Monitoring](#performance)

## 1. Key Metrics

### Volume Metrics
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: longhorn-volume-metrics
spec:
  selector:
    matchLabels:
      app: longhorn-engine
  podMetricsEndpoints:
  - port: metrics
    path: /metrics
    interval: 30s
    metricRelabelings:
    - sourceLabels: [__name__]
      regex: 'longhorn_volume_(read|write)_.*'
      action: keep
```

### Performance Dashboard
```json
{
  "panels": [
    {
      "title": "IOPS by Volume",
      "type": "graph",
      "targets": [
        {
          "expr": "rate(longhorn_volume_read_ops_total[5m])",
          "legendFormat": "Read - {{volume}}"
        },
        {
          "expr": "rate(longhorn_volume_write_ops_total[5m])",
          "legendFormat": "Write - {{volume}}"
        }
      ]
    }
  ]
}
```

## 2. Latency Monitoring

### Latency Alerts
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: longhorn-latency-alerts
spec:
  groups:
  - name: longhorn.latency
    rules:
    - alert: LonghornHighLatency
      expr: rate(longhorn_volume_read_latency_microseconds[5m]) > 1000000
      for: 5m
      labels:
        severity: warning
```

# [Maintenance Procedures](#maintenance)

## 1. Volume Maintenance

### Volume Health Check
```bash
#!/bin/bash
# Volume health check script

# Check volume status
kubectl get volumes -n longhorn-system -o json | jq -r '.items[] | select(.status.state != "healthy") | .metadata.name'

# Check replica count
kubectl get volumes -n longhorn-system -o json | jq -r '.items[] | select(.status.robustness != "healthy") | .metadata.name'

# Check for degraded volumes
kubectl get volumes -n longhorn-system -o json | jq -r '.items[] | select(.status.actualSize != .spec.size) | .metadata.name'
```

### Volume Cleanup
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: volume-cleanup
spec:
  schedule: "0 0 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: cleanup
            image: longhornio/longhorn-manager:v1.5.1
            command:
            - /bin/sh
            - -c
            - longhorn volume cleanup
```

## 2. Node Maintenance

### Node Drain Procedure
```bash
#!/bin/bash
# Node maintenance script
NODE_NAME=$1

# Cordon the node
kubectl cordon $NODE_NAME

# Evict Longhorn volumes
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.volumes[].persistentVolumeClaim != null) | .metadata.namespace + "/" + .metadata.name' | \
  while read pod; do
    kubectl delete pod -n ${pod%/*} ${pod#*/}
  done

# Wait for volume migration
sleep 300

# Drain the node
kubectl drain $NODE_NAME --ignore-daemonsets --delete-emptydir-data
```

### Storage Health Check
```yaml
apiVersion: batch/v1beta1
kind: CronJob
metadata:
  name: storage-health-check
spec:
  schedule: "*/30 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: health-check
            image: longhornio/longhorn-manager:v1.5.1
            command:
            - /bin/sh
            - -c
            - |
              longhorn node ls --format json | \
              jq -r '.[] | select(.conditions.Ready.status != "True") | .name'
```

# [System Maintenance](#system)

## 1. Backup Verification

### Backup Health Check
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-verification
spec:
  schedule: "0 0 * * 0"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: verify
            image: longhornio/longhorn-manager:v1.5.1
            command:
            - /bin/sh
            - -c
            - |
              longhorn backup ls | \
              while read backup; do
                longhorn backup verify $backup
              done
```

## 2. System Updates

### Update Procedure
```bash
#!/bin/bash
# Longhorn update script

# Check current version
current_version=$(kubectl get deployment -n longhorn-system longhorn-manager -o jsonpath='{.spec.template.spec.containers[0].image}' | cut -d: -f2)

# Update Longhorn
helm upgrade longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --version ${NEW_VERSION} \
  --set defaultSettings.backupstorePollInterval=300

# Wait for rollout
kubectl -n longhorn-system rollout status deployment/longhorn-manager
```

# [Best Practices](#best-practices)

1. **Monitoring Strategy**
   - Implement comprehensive metrics collection
   - Set up appropriate alerting thresholds
   - Monitor system and volume health
   - Track performance trends

2. **Maintenance Schedule**
   - Regular health checks
   - Proactive volume maintenance
   - System updates and patches
   - Backup verification

3. **Performance Optimization**
   - Regular performance audits
   - Resource utilization monitoring
   - Capacity planning
   - Bottleneck identification

4. **Documentation**
   - Maintenance procedures
   - Troubleshooting guides
   - Performance baselines
   - Update history

# [Conclusion](#conclusion)

Effective monitoring and maintenance requires:
- Comprehensive monitoring setup
- Regular maintenance procedures
- Performance optimization
- Proper documentation

For more information, check out:
- [High Availability Configuration](/training/longhorn/ha/)
- [Backup and Recovery](/training/longhorn/backup/)
- [Performance Optimization](/training/longhorn/performance/)
