---
title: "Rook Ceph Storage Orchestration on Kubernetes: Production Implementation Guide"
date: 2026-11-07T00:00:00-05:00
draft: false
tags: ["Rook", "Ceph", "Kubernetes", "Storage", "Block Storage", "File Storage", "Object Storage", "CSI", "Production"]
categories: ["Storage", "Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Rook Ceph on Kubernetes for unified block, file, and object storage with production-grade configuration, performance tuning, and disaster recovery strategies."
more_link: "yes"
url: "/rook-ceph-storage-orchestration-kubernetes/"
---

Rook automates Ceph storage orchestration on Kubernetes, providing enterprise-grade block, file, and object storage with a cloud-native operator. This comprehensive guide covers production deployment, performance optimization, disaster recovery, and operational best practices for running Ceph at scale on Kubernetes.

<!--more-->

# Rook Ceph Storage Orchestration on Kubernetes: Production Implementation Guide

## Executive Summary

Rook brings Ceph storage to Kubernetes as a cloud-native application, managing deployment, bootstrapping, configuration, provisioning, scaling, upgrading, and monitoring of Ceph clusters. This guide provides production-tested configurations for deploying highly available Ceph storage that powers block (RBD), file (CephFS), and object (RGW) storage classes, supporting thousands of persistent volumes and petabytes of data.

## Architecture Overview

### Rook Ceph Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Rook Operator (Namespace: rook-ceph)     │  │
│  │  • Watches CephCluster CRD                            │  │
│  │  • Manages Ceph daemons lifecycle                     │  │
│  │  • Handles disaster recovery                          │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │         Ceph Cluster (Namespace: rook-ceph)           │  │
│  │                                                        │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  MON (Monitors) - Cluster state & quorum       │  │  │
│  │  │  • mon-a, mon-b, mon-c (3 replicas min)        │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │                                                        │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  MGR (Managers) - Metrics & management         │  │  │
│  │  │  • Active/Standby configuration                │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │                                                        │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  OSD (Object Storage Daemons) - Data storage   │  │  │
│  │  │  • One OSD per disk/device                     │  │  │
│  │  │  • Distributed across nodes                    │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │                                                        │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  MDS (Metadata Servers) - CephFS metadata      │  │  │
│  │  │  • Active/Standby for file systems             │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │                                                        │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  RGW (RADOS Gateway) - S3/Swift object storage │  │  │
│  │  │  • HTTP endpoints for object access            │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │         CSI Drivers (Namespace: rook-ceph)            │  │
│  │  • RBD CSI (Block storage)                            │  │
│  │  • CephFS CSI (File storage)                          │  │
│  │  • Dynamic provisioning                               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Production Cluster Deployment

### Prerequisites and Node Preparation

```bash
#!/bin/bash
# prepare-ceph-nodes.sh
# Prepare Kubernetes nodes for Ceph deployment

set -e

echo "Preparing nodes for Ceph deployment..."

# Install required packages
apt-get update
apt-get install -y \
    lvm2 \
    gdisk \
    ceph-common

# Load kernel modules
modprobe rbd
echo "rbd" > /etc/modules-load.d/rbd.conf

# Disable swap (required for Kubernetes)
swapoff -a
sed -i '/ swap / s/^\(.*\)$/#\1/g' /etc/fstab

# Configure disk for OSD
# WARNING: This will wipe the disk!
DISK="/dev/sdb"  # Change to your disk

if [ -b "$DISK" ]; then
    echo "Preparing disk $DISK for Ceph OSD..."

    # Wipe disk
    sgdisk --zap-all $DISK
    dd if=/dev/zero of=$DISK bs=1M count=100 oflag=direct,dsync

    # Create GPT partition table
    sgdisk -og $DISK

    echo "Disk $DISK prepared successfully"
else
    echo "Disk $DISK not found!"
    exit 1
fi

# Label nodes for Ceph
kubectl label nodes $(hostname) role=storage-node --overwrite

echo "Node preparation complete!"
```

### Rook Operator Deployment

```yaml
# rook-operator.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: rook-ceph

---
# Rook Operator ServiceAccount
apiVersion: v1
kind: ServiceAccount
metadata:
  name: rook-ceph-operator
  namespace: rook-ceph

---
# Rook Operator ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: rook-ceph-operator
rules:
# Full access to Ceph resources
- apiGroups: ["ceph.rook.io"]
  resources: ["*"]
  verbs: ["*"]
# Kubernetes resources management
- apiGroups: [""]
  resources:
  - pods
  - services
  - endpoints
  - persistentvolumeclaims
  - persistentvolumes
  - events
  - configmaps
  - secrets
  - nodes
  verbs: ["*"]
- apiGroups: ["apps"]
  resources:
  - deployments
  - daemonsets
  - replicasets
  - statefulsets
  verbs: ["*"]
- apiGroups: ["batch"]
  resources:
  - jobs
  verbs: ["*"]
- apiGroups: ["storage.k8s.io"]
  resources:
  - storageclasses
  - volumeattachments
  verbs: ["*"]
- apiGroups: ["snapshot.storage.k8s.io"]
  resources:
  - volumesnapshots
  - volumesnapshotcontents
  - volumesnapshotclasses
  verbs: ["*"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: rook-ceph-operator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: rook-ceph-operator
subjects:
- kind: ServiceAccount
  name: rook-ceph-operator
  namespace: rook-ceph

---
# Rook Operator Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rook-ceph-operator
  namespace: rook-ceph
  labels:
    app: rook-ceph-operator
spec:
  replicas: 1
  selector:
    matchLabels:
      app: rook-ceph-operator
  template:
    metadata:
      labels:
        app: rook-ceph-operator
    spec:
      serviceAccountName: rook-ceph-operator
      containers:
      - name: rook-ceph-operator
        image: rook/ceph:v1.12.9
        args:
        - "ceph"
        - "operator"
        env:
        # Enable discovery daemon
        - name: ROOK_ENABLE_DISCOVERY_DAEMON
          value: "true"
        # CSI configuration
        - name: ROOK_CSI_ENABLE_CEPHFS
          value: "true"
        - name: ROOK_CSI_ENABLE_RBD
          value: "true"
        - name: ROOK_CSI_ENABLE_GRPC_METRICS
          value: "true"
        # Logging
        - name: ROOK_LOG_LEVEL
          value: "INFO"
        # Node affinity for operator
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        # Monitoring
        - name: ROOK_ENABLE_SELINUX_RELABELING
          value: "true"
        - name: ROOK_ENABLE_FSGROUP
          value: "true"
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
        volumeMounts:
        - name: rook-config
          mountPath: /var/lib/rook
        - name: default-config-dir
          mountPath: /etc/ceph
      volumes:
      - name: rook-config
        emptyDir: {}
      - name: default-config-dir
        emptyDir: {}
```

### Production Ceph Cluster Configuration

```yaml
# ceph-cluster-production.yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  # Ceph version
  cephVersion:
    image: quay.io/ceph/ceph:v17.2.6  # Quincy release
    allowUnsupported: false

  # Data directory on host
  dataDirHostPath: /var/lib/rook

  # Skip upgrade checks (set to false in production)
  skipUpgradeChecks: false

  # Continue if disks are unavailable during initial deployment
  continueUpgradeAfterChecksEvenIfNotHealthy: false

  # Upgrade timeout
  waitTimeoutForHealthyOSDInMinutes: 10

  # MON configuration - manages cluster state
  mon:
    count: 3  # Always use odd number (3, 5, 7)
    allowMultiplePerNode: false
    volumeClaimTemplate:
      spec:
        storageClassName: local-path  # Use fast local storage
        resources:
          requests:
            storage: 10Gi

  # MGR configuration - cluster management and metrics
  mgr:
    count: 2  # Active/standby
    allowMultiplePerNode: false
    modules:
    - name: pg_autoscaler
      enabled: true
    - name: rook
      enabled: true

  # Dashboard configuration
  dashboard:
    enabled: true
    ssl: true
    port: 8443

  # Monitoring
  monitoring:
    enabled: true
    rulesNamespace: rook-ceph

  # Network configuration
  network:
    provider: host  # or "multus" for advanced networking
    connections:
      encryption:
        enabled: false  # Enable for encryption in transit
      compression:
        enabled: false  # Enable for compression

  # Crash collector for debugging
  crashCollector:
    disable: false

  # Log collector
  logCollector:
    enabled: true
    periodicity: 24h  # Daily log collection

  # Cleanup policy on cluster deletion
  cleanupPolicy:
    confirmation: ""  # Must set to "yes-really-destroy-data" to enable
    sanitizeDisks:
      method: quick
      dataSource: zero
      iteration: 1
    allowUninstallWithVolumes: false

  # Storage configuration
  storage:
    useAllNodes: false  # Explicitly define nodes
    useAllDevices: false  # Explicitly define devices

    # Node-specific configuration
    nodes:
    - name: "k8s-node-1"
      devices:
      - name: "/dev/sdb"
        config:
          osdsPerDevice: "1"
          encryptedDevice: "false"
          deviceClass: "ssd"  # ssd, hdd, or nvme
      - name: "/dev/sdc"
        config:
          osdsPerDevice: "1"
          deviceClass: "ssd"
      resources:
        requests:
          cpu: "2"
          memory: "4Gi"
        limits:
          cpu: "4"
          memory: "8Gi"

    - name: "k8s-node-2"
      devices:
      - name: "/dev/sdb"
        config:
          osdsPerDevice: "1"
          deviceClass: "ssd"
      - name: "/dev/sdc"
        config:
          osdsPerDevice: "1"
          deviceClass: "ssd"
      resources:
        requests:
          cpu: "2"
          memory: "4Gi"
        limits:
          cpu: "4"
          memory: "8Gi"

    - name: "k8s-node-3"
      devices:
      - name: "/dev/sdb"
        config:
          osdsPerDevice: "1"
          deviceClass: "ssd"
      - name: "/dev/sdc"
        config:
          osdsPerDevice: "1"
          deviceClass: "ssd"
      resources:
        requests:
          cpu: "2"
          memory: "4Gi"
        limits:
          cpu: "4"
          memory: "8Gi"

  # Placement for Ceph daemons
  placement:
    all:
      nodeAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          nodeSelectorTerms:
          - matchExpressions:
            - key: role
              operator: In
              values:
              - storage-node
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - rook-ceph-mon
                - rook-ceph-osd
                - rook-ceph-mgr
            topologyKey: kubernetes.io/hostname
      tolerations:
      - key: storage-node
        operator: Exists

  # Resource limits
  resources:
    mgr:
      requests:
        cpu: "1"
        memory: "2Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
    mon:
      requests:
        cpu: "1"
        memory: "2Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
    osd:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "4"
        memory: "8Gi"
    prepareosd:
      requests:
        cpu: "500m"
        memory: "50Mi"
      limits:
        cpu: "1"
        memory: "200Mi"
    crashcollector:
      requests:
        cpu: "100m"
        memory: "60Mi"
      limits:
        cpu: "500m"
        memory: "200Mi"

  # Priority classes for Ceph pods
  priorityClassNames:
    mon: system-node-critical
    osd: system-node-critical
    mgr: system-cluster-critical

  # Disruption budgets
  disruptionManagement:
    managePodBudgets: true
    osdMaintenanceTimeout: 30
    pgHealthCheckTimeout: 0
    manageMachineDisruptionBudgets: false
    machineDisruptionBudgetNamespace: openshift-machine-api

---
# Storage pools for different workload types
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  failureDomain: host  # or "osd" for higher redundancy
  replicated:
    size: 3  # Number of replicas
    requireSafeReplicaSize: true
    replicasPerFailureDomain: 1
  compressionMode: none  # none, passive, aggressive, force
  deviceClass: ssd  # Filter OSDs by device class

---
# Erasure-coded pool for cost-effective storage
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: ecpool
  namespace: rook-ceph
spec:
  failureDomain: host
  erasureCoded:
    dataChunks: 2  # K value
    codingChunks: 1  # M value (can lose M chunks)
    algorithm: jerasure
  deviceClass: hdd  # Use HDDs for cold storage

---
# Storage Class for RBD (Block Storage)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering,exclusive-lock,object-map,fast-diff
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  csi.storage.k8s.io/fstype: ext4
allowVolumeExpansion: true
reclaimPolicy: Delete
mountOptions: []

---
# CephFS for shared file storage
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: ceph-filesystem
  namespace: rook-ceph
spec:
  metadataPool:
    replicated:
      size: 3
      requireSafeReplicaSize: true
    compressionMode: none
  dataPools:
  - name: data0
    replicated:
      size: 3
      requireSafeReplicaSize: true
    compressionMode: none
  metadataServer:
    activeCount: 1
    activeStandby: true
    resources:
      requests:
        cpu: "1"
        memory: "4Gi"
      limits:
        cpu: "2"
        memory: "8Gi"
    priorityClassName: system-cluster-critical
    placement:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
            - key: app
              operator: In
              values:
              - rook-ceph-mds
          topologyKey: kubernetes.io/hostname

---
# Storage Class for CephFS (Shared File Storage)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-cephfs
provisioner: rook-ceph.cephfs.csi.ceph.com
parameters:
  clusterID: rook-ceph
  fsName: ceph-filesystem
  pool: ceph-filesystem-data0
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-cephfs-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
allowVolumeExpansion: true
reclaimPolicy: Delete
mountOptions:
- discard

---
# Object storage (S3/Swift compatible)
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata:
  name: ceph-objectstore
  namespace: rook-ceph
spec:
  metadataPool:
    failureDomain: host
    replicated:
      size: 3
  dataPool:
    failureDomain: host
    erasureCoded:
      dataChunks: 2
      codingChunks: 1
  preservePoolsOnDelete: true
  gateway:
    port: 80
    securePort: 443
    instances: 2
    resources:
      requests:
        cpu: "1"
        memory: "2Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
    priorityClassName: system-cluster-critical
    placement:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - rook-ceph-rgw
            topologyKey: kubernetes.io/hostname
  healthCheck:
    bucket:
      interval: 60s

---
# Object store user
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: objectstore-user
  namespace: rook-ceph
spec:
  store: ceph-objectstore
  displayName: "Object Store User"
```

## Performance Tuning and Optimization

### Ceph Configuration Tuning

```python
#!/usr/bin/env python3
"""
Ceph performance tuning automation
"""
import subprocess
import json
from typing import Dict, List

class CephPerformanceTuner:
    """Automate Ceph performance tuning"""

    def __init__(self, namespace: str = "rook-ceph"):
        self.namespace = namespace
        self.toolbox_pod = self._get_toolbox_pod()

    def _get_toolbox_pod(self) -> str:
        """Get Ceph toolbox pod name"""
        cmd = [
            "kubectl", "get", "pods",
            "-n", self.namespace,
            "-l", "app=rook-ceph-tools",
            "-o", "jsonpath={.items[0].metadata.name}"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.stdout.strip()

    def exec_ceph_command(self, command: List[str]) -> Dict:
        """Execute command in Ceph toolbox"""
        kubectl_cmd = [
            "kubectl", "exec", "-n", self.namespace,
            self.toolbox_pod, "--",
        ] + command

        result = subprocess.run(kubectl_cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise Exception(f"Command failed: {result.stderr}")

        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return {"output": result.stdout}

    def tune_for_ssd(self):
        """Optimize configuration for SSD storage"""
        tuning_params = {
            # OSD settings
            "osd_op_num_threads_per_shard": 2,
            "osd_op_num_shards": 8,
            "osd_max_backfills": 1,
            "osd_recovery_max_active": 3,
            "osd_recovery_max_single_start": 1,

            # Journal settings
            "osd_journal_size": 10240,  # 10GB

            # Client settings
            "rbd_cache": True,
            "rbd_cache_size": 67108864,  # 64MB
            "rbd_cache_max_dirty": 50331648,  # 48MB
            "rbd_cache_target_dirty": 33554432,  # 32MB

            # PG settings
            "osd_pg_epoch_persisted_max_stale": 40,

            # BlueStore settings (Ceph's storage backend)
            "bluestore_cache_size_ssd": 3221225472,  # 3GB
            "bluestore_cache_kv_max": 536870912,  # 512MB
            "bluestore_cache_kv_ratio": 0.2,
            "bluestore_cache_meta_ratio": 0.8,
            "bluestore_min_alloc_size_ssd": 4096,  # 4KB
        }

        print("Applying SSD optimizations...")
        for key, value in tuning_params.items():
            self._set_config(key, value)

        print("SSD optimizations applied!")

    def tune_for_hdd(self):
        """Optimize configuration for HDD storage"""
        tuning_params = {
            # OSD settings
            "osd_op_num_threads_per_shard": 1,
            "osd_op_num_shards": 4,
            "osd_max_backfills": 1,
            "osd_recovery_max_active": 1,

            # BlueStore settings
            "bluestore_cache_size_hdd": 1073741824,  # 1GB
            "bluestore_min_alloc_size_hdd": 65536,  # 64KB

            # Throttling for HDDs
            "osd_max_write_size": 90,
            "osd_client_message_size_cap": 524288000,
        }

        print("Applying HDD optimizations...")
        for key, value in tuning_params.items():
            self._set_config(key, value)

        print("HDD optimizations applied!")

    def _set_config(self, key: str, value):
        """Set Ceph configuration parameter"""
        self.exec_ceph_command([
            "ceph", "config", "set", "global",
            key, str(value)
        ])
        print(f"Set {key} = {value}")

    def tune_pg_autoscaler(self):
        """Configure PG autoscaler for optimal performance"""
        print("Configuring PG autoscaler...")

        # Enable autoscaler module
        self.exec_ceph_command([
            "ceph", "mgr", "module", "enable", "pg_autoscaler"
        ])

        # Set autoscaler mode
        pools = self.get_pools()
        for pool in pools:
            pool_name = pool['poolname']
            print(f"Enabling autoscaler for pool: {pool_name}")
            self.exec_ceph_command([
                "ceph", "osd", "pool", "set",
                pool_name, "pg_autoscale_mode", "on"
            ])

        print("PG autoscaler configured!")

    def get_pools(self) -> List[Dict]:
        """Get list of Ceph pools"""
        result = self.exec_ceph_command([
            "ceph", "osd", "pool", "ls", "detail", "-f", "json"
        ])
        return result if isinstance(result, list) else []

    def get_cluster_status(self) -> Dict:
        """Get Ceph cluster status"""
        return self.exec_ceph_command([
            "ceph", "status", "-f", "json"
        ])

    def get_performance_stats(self) -> Dict:
        """Get cluster performance statistics"""
        result = self.exec_ceph_command([
            "ceph", "osd", "perf", "-f", "json"
        ])

        # Calculate averages
        stats = {
            'osd_count': len(result.get('osdstats', {}).get('osd_perf_infos', [])),
            'avg_commit_latency_ms': 0,
            'avg_apply_latency_ms': 0
        }

        osd_perfs = result.get('osdstats', {}).get('osd_perf_infos', [])
        if osd_perfs:
            total_commit = sum(osd['perf_stats']['commit_latency_ms']
                             for osd in osd_perfs)
            total_apply = sum(osd['perf_stats']['apply_latency_ms']
                            for osd in osd_perfs)

            stats['avg_commit_latency_ms'] = total_commit / len(osd_perfs)
            stats['avg_apply_latency_ms'] = total_apply / len(osd_perfs)

        return stats

    def benchmark_pool(self, pool_name: str, duration: int = 60) -> Dict:
        """Benchmark pool performance"""
        print(f"Benchmarking pool {pool_name} for {duration} seconds...")

        result = self.exec_ceph_command([
            "rados", "bench", "-p", pool_name,
            str(duration), "write", "--no-cleanup"
        ])

        return result

# Example usage
def main():
    tuner = CephPerformanceTuner(namespace="rook-ceph")

    # Get cluster status
    print("Cluster Status:")
    status = tuner.get_cluster_status()
    print(f"Health: {status.get('health', {}).get('status', 'UNKNOWN')}")
    print()

    # Apply SSD optimizations
    tuner.tune_for_ssd()

    # Configure PG autoscaler
    tuner.tune_pg_autoscaler()

    # Get performance stats
    print("\nPerformance Statistics:")
    stats = tuner.get_performance_stats()
    print(f"OSDs: {stats['osd_count']}")
    print(f"Avg Commit Latency: {stats['avg_commit_latency_ms']:.2f}ms")
    print(f"Avg Apply Latency: {stats['avg_apply_latency_ms']:.2f}ms")

if __name__ == "__main__":
    main()
```

## Disaster Recovery and Backup

### Volume Snapshots and Clones

```yaml
# volume-snapshot-class.yaml
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-rbdplugin-snapclass
driver: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  csi.storage.k8s.io/snapshotter-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/snapshotter-secret-namespace: rook-ceph
deletionPolicy: Delete

---
# Example: Create snapshot of a PVC
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: mysql-snapshot
  namespace: default
spec:
  volumeSnapshotClassName: csi-rbdplugin-snapclass
  source:
    persistentVolumeClaimName: mysql-pvc

---
# Example: Restore from snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mysql-restore-pvc
  namespace: default
spec:
  storageClassName: rook-ceph-block
  dataSource:
    name: mysql-snapshot
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi

---
# Example: Clone a PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mysql-clone-pvc
  namespace: default
spec:
  storageClassName: rook-ceph-block
  dataSource:
    name: mysql-pvc
    kind: PersistentVolumeClaim
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

### Automated Backup Strategy

```python
#!/usr/bin/env python3
"""
Automated Ceph backup and disaster recovery
"""
import subprocess
from datetime import datetime, timedelta
from typing import Dict, List
import json

class CephBackupManager:
    """Manage Ceph backups and disaster recovery"""

    def __init__(self, namespace: str = "rook-ceph"):
        self.namespace = namespace

    def create_volume_snapshot(self, pvc_name: str, pvc_namespace: str) -> Dict:
        """Create snapshot of a PVC"""
        snapshot_name = f"{pvc_name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

        snapshot_manifest = {
            "apiVersion": "snapshot.storage.k8s.io/v1",
            "kind": "VolumeSnapshot",
            "metadata": {
                "name": snapshot_name,
                "namespace": pvc_namespace
            },
            "spec": {
                "volumeSnapshotClassName": "csi-rbdplugin-snapclass",
                "source": {
                    "persistentVolumeClaimName": pvc_name
                }
            }
        }

        # Create snapshot
        result = subprocess.run(
            ["kubectl", "apply", "-f", "-"],
            input=json.dumps(snapshot_manifest),
            capture_output=True,
            text=True
        )

        if result.returncode != 0:
            raise Exception(f"Failed to create snapshot: {result.stderr}")

        return {
            "snapshot_name": snapshot_name,
            "pvc_name": pvc_name,
            "namespace": pvc_namespace,
            "timestamp": datetime.now().isoformat()
        }

    def list_snapshots(self, namespace: str = None) -> List[Dict]:
        """List all volume snapshots"""
        cmd = ["kubectl", "get", "volumesnapshots", "-o", "json"]

        if namespace:
            cmd.extend(["-n", namespace])
        else:
            cmd.append("--all-namespaces")

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            raise Exception(f"Failed to list snapshots: {result.stderr}")

        data = json.loads(result.stdout)
        return data.get('items', [])

    def delete_old_snapshots(self, retention_days: int = 7):
        """Delete snapshots older than retention period"""
        cutoff_date = datetime.now() - timedelta(days=retention_days)
        snapshots = self.list_snapshots()

        deleted = []
        for snapshot in snapshots:
            creation_time = datetime.fromisoformat(
                snapshot['metadata']['creationTimestamp'].rstrip('Z')
            )

            if creation_time < cutoff_date:
                name = snapshot['metadata']['name']
                namespace = snapshot['metadata']['namespace']

                print(f"Deleting old snapshot: {name} (created {creation_time})")

                subprocess.run([
                    "kubectl", "delete", "volumesnapshot",
                    name, "-n", namespace
                ])

                deleted.append(name)

        return deleted

    def restore_from_snapshot(self, snapshot_name: str, snapshot_namespace: str,
                            new_pvc_name: str, storage_size: str = "10Gi") -> Dict:
        """Restore PVC from snapshot"""
        pvc_manifest = {
            "apiVersion": "v1",
            "kind": "PersistentVolumeClaim",
            "metadata": {
                "name": new_pvc_name,
                "namespace": snapshot_namespace
            },
            "spec": {
                "storageClassName": "rook-ceph-block",
                "dataSource": {
                    "name": snapshot_name,
                    "kind": "VolumeSnapshot",
                    "apiGroup": "snapshot.storage.k8s.io"
                },
                "accessModes": ["ReadWriteOnce"],
                "resources": {
                    "requests": {
                        "storage": storage_size
                    }
                }
            }
        }

        result = subprocess.run(
            ["kubectl", "apply", "-f", "-"],
            input=json.dumps(pvc_manifest),
            capture_output=True,
            text=True
        )

        if result.returncode != 0:
            raise Exception(f"Failed to restore from snapshot: {result.stderr}")

        return {
            "pvc_name": new_pvc_name,
            "snapshot_name": snapshot_name,
            "namespace": snapshot_namespace,
            "timestamp": datetime.now().isoformat()
        }

    def backup_all_pvcs(self, namespaces: List[str] = None) -> List[Dict]:
        """Create snapshots for all PVCs"""
        if namespaces is None:
            namespaces = self._get_all_namespaces()

        results = []
        for namespace in namespaces:
            pvcs = self._get_pvcs_in_namespace(namespace)

            for pvc in pvcs:
                pvc_name = pvc['metadata']['name']
                storage_class = pvc['spec'].get('storageClassName', '')

                # Only backup Ceph-backed PVCs
                if 'rook-ceph' in storage_class:
                    try:
                        result = self.create_volume_snapshot(pvc_name, namespace)
                        results.append(result)
                        print(f"Created snapshot for {namespace}/{pvc_name}")
                    except Exception as e:
                        print(f"Failed to snapshot {namespace}/{pvc_name}: {e}")

        return results

    def _get_all_namespaces(self) -> List[str]:
        """Get list of all namespaces"""
        result = subprocess.run(
            ["kubectl", "get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}"],
            capture_output=True,
            text=True
        )
        return result.stdout.split()

    def _get_pvcs_in_namespace(self, namespace: str) -> List[Dict]:
        """Get list of PVCs in namespace"""
        result = subprocess.run(
            ["kubectl", "get", "pvc", "-n", namespace, "-o", "json"],
            capture_output=True,
            text=True
        )
        data = json.loads(result.stdout)
        return data.get('items', [])

# Example usage
def main():
    backup_mgr = CephBackupManager()

    # Backup all Ceph PVCs
    print("Creating snapshots for all Ceph-backed PVCs...")
    results = backup_mgr.backup_all_pvcs()
    print(f"Created {len(results)} snapshots")

    # Delete old snapshots (older than 7 days)
    print("\nCleaning up old snapshots...")
    deleted = backup_mgr.delete_old_snapshots(retention_days=7)
    print(f"Deleted {len(deleted)} old snapshots")

if __name__ == "__main__":
    main()
```

## Monitoring and Alerting

### Prometheus Monitoring Configuration

```yaml
# ceph-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: rook-ceph-mgr
  namespace: rook-ceph
  labels:
    team: rook
spec:
  namespaceSelector:
    matchNames:
    - rook-ceph
  selector:
    matchLabels:
      app: rook-ceph-mgr
      rook_cluster: rook-ceph
  endpoints:
  - port: http-metrics
    path: /metrics
    interval: 30s

---
# Ceph alerting rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rook-ceph-alerts
  namespace: rook-ceph
spec:
  groups:
  - name: ceph.rules
    interval: 30s
    rules:
    # Cluster health
    - alert: CephClusterUnhealthy
      expr: ceph_health_status != 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Ceph cluster is unhealthy"
        description: "Ceph cluster health is {{ $value }} (0=HEALTH_OK, 1=HEALTH_WARN, 2=HEALTH_ERR)"

    # OSD status
    - alert: CephOSDDown
      expr: ceph_osd_up == 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Ceph OSD is down"
        description: "OSD {{ $labels.ceph_daemon }} on {{ $labels.hostname }} is down"

    - alert: CephOSDNearFull
      expr: ceph_osd_utilization > 85
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Ceph OSD is near full"
        description: "OSD {{ $labels.ceph_daemon }} is {{ $value }}% full"

    - alert: CephOSDFull
      expr: ceph_osd_utilization > 95
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Ceph OSD is full"
        description: "OSD {{ $labels.ceph_daemon }} is {{ $value }}% full"

    # MON status
    - alert: CephMonitorDown
      expr: ceph_mon_quorum_status == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Ceph monitor is down"
        description: "Monitor {{ $labels.ceph_daemon }} is not in quorum"

    # Pool status
    - alert: CephPoolNearFull
      expr: (ceph_pool_stored / ceph_pool_max_avail) > 0.85
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Ceph pool is near full"
        description: "Pool {{ $labels.name }} is {{ $value | humanizePercentage }} full"

    # PG status
    - alert: CephPGsDown
      expr: ceph_pg_down > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Ceph has PGs in down state"
        description: "{{ $value }} PGs are in down state"

    - alert: CephPGsIncomplete
      expr: ceph_pg_incomplete > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Ceph has incomplete PGs"
        description: "{{ $value }} PGs are in incomplete state"

    # Performance
    - alert: CephHighClientIOWait
      expr: rate(ceph_osd_op_r_latency_sum[5m]) / rate(ceph_osd_op_r_latency_count[5m]) > 1000
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High client I/O wait time"
        description: "Average read latency is {{ $value }}ms"
```

## Conclusion

Rook Ceph provides enterprise-grade storage orchestration for Kubernetes with comprehensive support for block, file, and object storage. Key implementation points:

1. **Production Deployment**: Properly configured MON, MGR, and OSD components with node affinity
2. **Storage Classes**: Multiple storage classes for different workload types
3. **Performance Tuning**: SSD/HDD-specific optimizations and PG autoscaling
4. **Disaster Recovery**: Automated snapshots, backups, and restoration procedures
5. **Monitoring**: Comprehensive Prometheus metrics and alerting

Rook simplifies Ceph operations while maintaining full feature parity with standalone Ceph deployments.

## Additional Resources

- [Rook Documentation](https://rook.io/docs/rook/latest/)
- [Ceph Documentation](https://docs.ceph.com/)
- [CSI Snapshots](https://kubernetes-csi.github.io/docs/snapshot-restore-feature.html)
- [Ceph Performance Tuning](https://docs.ceph.com/en/latest/rados/configuration/)