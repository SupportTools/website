---
title: "Linux GlusterFS: Distributed Storage Clustering for Kubernetes Persistent Volumes"
date: 2030-11-13T00:00:00-05:00
draft: false
tags: ["GlusterFS", "Kubernetes", "Storage", "CSI", "Heketi", "Distributed Storage", "Persistent Volumes", "Linux"]
categories:
- Kubernetes
- Storage
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise GlusterFS guide covering distributed-replicated volume configuration, Heketi API for dynamic provisioning, GlusterFS CSI driver for Kubernetes, geo-replication for DR, volume expansion, performance tuning, and monitoring GlusterFS cluster health."
more_link: "yes"
url: "/linux-glusterfs-distributed-storage-kubernetes-persistent-volumes-guide/"
---

GlusterFS remains a widely deployed distributed filesystem for organizations that need scale-out storage without the licensing costs of proprietary SAN/NAS solutions. When combined with the GlusterFS CSI driver and Heketi, it provides Kubernetes clusters with dynamic persistent volume provisioning backed by a replicated, distributed storage pool. This guide covers the complete operational picture: cluster formation, volume types, Kubernetes integration, geo-replication for disaster recovery, and performance tuning.

<!--more-->

## GlusterFS Architecture Overview

GlusterFS is a userspace distributed filesystem that aggregates storage from multiple servers (called bricks) into a single namespace. Its architecture has four key components:

- **Trusted Storage Pool (TSP)**: The peer group of servers participating in the cluster.
- **Bricks**: XFS-formatted directories on dedicated block devices exposed by each server.
- **Volumes**: Logical groupings of bricks with a configured distribution/replication topology.
- **FUSE or libgfapi client**: Mounts volumes on clients without kernel patches.

Volume types that matter for Kubernetes workloads:

| Type | Description | Use Case |
|------|-------------|----------|
| Distributed | Files spread across bricks with no redundancy | Ephemeral scratch space |
| Replicated | Every brick holds a full copy | Critical data, low node count |
| Distributed-Replicated | Files spread across replica sets | Production workloads, scale-out |
| Dispersed (EC) | Erasure coding, like RAID-6 | Large objects, storage efficiency |

Distributed-replicated is the standard recommendation: a 3x2 configuration means 6 bricks organized into 3 replica sets, each containing 2 bricks. Files are distributed across the 3 sets and each set holds 2 copies.

## Infrastructure Prerequisites

The examples use 4 storage nodes and one management node:

| Hostname | IP | Role |
|----------|----|------|
| gluster-01 | 10.0.1.11 | Storage node |
| gluster-02 | 10.0.1.12 | Storage node |
| gluster-03 | 10.0.1.13 | Storage node |
| gluster-04 | 10.0.1.14 | Storage node |
| heketi-mgr | 10.0.1.20 | Heketi API server |

Each storage node has:
- A dedicated raw block device (`/dev/sdb`, 500 GB) for GlusterFS bricks
- CentOS Stream 9 or RHEL 9
- 10 Gbps networking between nodes

### Kernel Modules and System Configuration

```bash
# Install on all storage nodes
dnf install -y glusterfs-server glusterfs-cli \
  glusterfs-fuse xfsprogs attr

# Enable and start the glusterd daemon
systemctl enable --now glusterd

# Verify glusterd is running
systemctl status glusterd
# Active: active (running) since ...
```

Tune kernel parameters for GlusterFS performance:

```bash
cat >> /etc/sysctl.d/99-glusterfs.conf << 'EOF'
# Increase network socket buffer sizes
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 131072
net.core.wmem_default = 131072
net.ipv4.tcp_rmem = 4096 131072 16777216
net.ipv4.tcp_wmem = 4096 131072 16777216

# File system tuning
fs.file-max = 1000000
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10
vm.swappiness = 10
EOF

sysctl --system
```

Firewall rules (applied to all storage nodes):

```bash
firewall-cmd --permanent --add-service=glusterfs
firewall-cmd --permanent --add-port=24007-24008/tcp   # GlusterD daemon
firewall-cmd --permanent --add-port=24009-24108/tcp   # Brick ports
firewall-cmd --permanent --add-port=38465-38467/tcp   # Gluster NFS
firewall-cmd --reload
```

## Preparing Brick Devices

Each brick runs on an XFS filesystem created on the dedicated block device. LVM is used to allow online volume expansion:

```bash
# Run on each storage node
DEVICE=/dev/sdb

# Create a physical volume and volume group
pvcreate ${DEVICE}
vgcreate vg_gluster ${DEVICE}

# Create a thin pool (allows per-brick thin provisioning for Heketi)
lvcreate --thin -L 490G -n tp_gluster vg_gluster
lvcreate --thin -V 490G -n brick_data vg_gluster/tp_gluster

# Format with XFS — inode size 512 for extended attributes
mkfs.xfs -i size=512 /dev/vg_gluster/brick_data

# Mount the brick directory
mkdir -p /data/glusterfs/brick1
echo "/dev/vg_gluster/brick_data  /data/glusterfs/brick1  xfs  defaults,noatime,nodiratime,logbufs=8  0 0" \
  >> /etc/fstab
mount -a

# Create the actual brick subdirectory inside the mount point
mkdir -p /data/glusterfs/brick1/gv0
```

## Forming the Trusted Storage Pool

Run the following peer probe commands from `gluster-01`:

```bash
# Add peers to the trusted storage pool
gluster peer probe gluster-02
gluster peer probe gluster-03
gluster peer probe gluster-04

# Verify peer status
gluster peer status
# Number of Peers: 3
# Hostname: gluster-02   State: Peer in Cluster (Connected)
# Hostname: gluster-03   State: Peer in Cluster (Connected)
# Hostname: gluster-04   State: Peer in Cluster (Connected)
```

## Creating a Distributed-Replicated Volume

Create a `4x2` distributed-replicated volume (4 replica sets × 2 copies = 8 bricks total — but with only 4 nodes use a `2x2` layout):

```bash
gluster volume create gv-data \
  replica 2 \
  gluster-01:/data/glusterfs/brick1/gv-data \
  gluster-02:/data/glusterfs/brick1/gv-data \
  gluster-03:/data/glusterfs/brick1/gv-data \
  gluster-04:/data/glusterfs/brick1/gv-data

# Output:
# volume create: gv-data: success: please start the volume to access data

gluster volume start gv-data

# Set performance and operational options
gluster volume set gv-data performance.cache-size 256MB
gluster volume set gv-data performance.io-thread-count 32
gluster volume set gv-data performance.read-ahead on
gluster volume set gv-data performance.write-behind on
gluster volume set gv-data performance.stat-prefetch on
gluster volume set gv-data network.ping-timeout 10
gluster volume set gv-data cluster.self-heal-daemon enable
gluster volume set gv-data cluster.heal-timeout 300

# Verify volume status
gluster volume info gv-data
gluster volume status gv-data
```

### Mounting the Volume on a Client

```bash
# Install GlusterFS client
dnf install -y glusterfs-fuse

# Mount the volume
mount -t glusterfs gluster-01:/gv-data /mnt/gluster-data

# Persistent mount via /etc/fstab
echo "gluster-01:/gv-data  /mnt/gluster-data  glusterfs  defaults,_netdev,backup-volfile-servers=gluster-02:gluster-03:gluster-04  0 0" \
  >> /etc/fstab
```

## Heketi: Dynamic Volume Provisioning API

Heketi provides a REST API over GlusterFS that Kubernetes uses for dynamic volume provisioning. It manages the full lifecycle: create a volume with a requested size, add bricks from the pool, and track topology.

### Installing Heketi

```bash
# On the heketi-mgr node
dnf install -y heketi heketi-client

# Generate SSH keys for Heketi to manage GlusterFS nodes
ssh-keygen -t ed25519 -f /etc/heketi/heketi_key -N ""
chown heketi:heketi /etc/heketi/heketi_key

# Copy the public key to all storage nodes
for node in gluster-01 gluster-02 gluster-03 gluster-04; do
  ssh-copy-id -i /etc/heketi/heketi_key.pub root@${node}
done
```

Heketi configuration:

```json
{
  "_port_comment": "Heketi Server Port Number",
  "port": "8080",
  "use_auth": true,
  "jwt": {
    "admin": {
      "key": "<heketi-admin-secret-key>"
    },
    "user": {
      "key": "<heketi-user-secret-key>"
    }
  },
  "glusterfs": {
    "executor": "ssh",
    "sshexec": {
      "keyfile": "/etc/heketi/heketi_key",
      "user": "root",
      "port": "22",
      "fstab": "/etc/fstab"
    },
    "db": "/var/lib/heketi/heketi.db",
    "brick_max_size_gb": 500,
    "brick_min_size_gb": 1,
    "max_bricks_per_volume": 33,
    "loglevel": "info"
  }
}
```

```bash
# Start Heketi
systemctl enable --now heketi
systemctl status heketi

# Export credentials for heketi-cli
export HEKETI_CLI_SERVER=http://10.0.1.20:8080
export HEKETI_CLI_USER=admin
export HEKETI_CLI_KEY="<heketi-admin-secret-key>"
```

### Loading the GlusterFS Topology

Create a topology JSON that describes the cluster:

```json
{
  "clusters": [
    {
      "nodes": [
        {
          "node": {
            "hostnames": {
              "manage": ["gluster-01"],
              "storage": ["10.0.1.11"]
            },
            "zone": 1
          },
          "devices": ["/dev/sdb"]
        },
        {
          "node": {
            "hostnames": {
              "manage": ["gluster-02"],
              "storage": ["10.0.1.12"]
            },
            "zone": 2
          },
          "devices": ["/dev/sdb"]
        },
        {
          "node": {
            "hostnames": {
              "manage": ["gluster-03"],
              "storage": ["10.0.1.13"]
            },
            "zone": 1
          },
          "devices": ["/dev/sdb"]
        },
        {
          "node": {
            "hostnames": {
              "manage": ["gluster-04"],
              "storage": ["10.0.1.14"]
            },
            "zone": 2
          },
          "devices": ["/dev/sdb"]
        }
      ]
    }
  ]
}
```

```bash
heketi-cli topology load --json=topology.json
# Creating cluster ... ID: a40c90d9e4b6f0b9c1234567890abcde
# Creating node gluster-01 ... ID: 9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d
# Adding device /dev/sdb ... OK
# ... (repeat for all nodes)

heketi-cli topology info
```

## Kubernetes Integration with the GlusterFS CSI Driver

The GlusterFS CSI driver (`gluster-csi`) dynamically provisions PersistentVolumes by calling the Heketi API.

### Installing the CSI Driver

```bash
# Deploy the CSI driver components
kubectl apply -f https://raw.githubusercontent.com/gluster/gluster-csi-driver/master/deploy/glusterfs-csi-driver.yaml

# Verify CSI driver pods are running
kubectl -n glusterfs-csi get pods
# NAME                                  READY   STATUS    RESTARTS   AGE
# glusterfs-csi-attacher-0              1/1     Running   0          2m
# glusterfs-csi-nodeplugin-5x4km        2/2     Running   0          2m
# glusterfs-csi-nodeplugin-7qr9p        2/2     Running   0          2m
# glusterfs-csi-provisioner-0           1/1     Running   0          2m
```

### Heketi Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: heketi-secret
  namespace: default
type: "kubernetes.io/glusterfs"
stringData:
  key: "<heketi-admin-secret-key>"
```

### StorageClass Definitions

Define multiple StorageClasses for different performance tiers:

```yaml
# Standard replicated storage (3x replica)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: glusterfs-standard
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: org.gluster.glusterfs
parameters:
  resturl: "http://10.0.1.20:8080"
  restuser: "admin"
  restuserkey: "<heketi-admin-secret-key>"
  secretNamespace: "default"
  secretName: "heketi-secret"
  volumetype: "replicate:3"
  # Minimum volume size (Heketi enforces this)
  volumeoptions: "performance.cache-size 256MB"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: Immediate
---
# High-performance dispersed (erasure-coded) storage
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: glusterfs-ec
provisioner: org.gluster.glusterfs
parameters:
  resturl: "http://10.0.1.20:8080"
  restuser: "admin"
  restuserkey: "<heketi-admin-secret-key>"
  secretNamespace: "default"
  secretName: "heketi-secret"
  volumetype: "disperse:4:2"   # 4 data bricks, 2 redundancy bricks
  volumeoptions: "performance.io-thread-count 64"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### Deploying a Stateful Application with GlusterFS PVCs

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch-data
  namespace: logging
spec:
  serviceName: elasticsearch
  replicas: 3
  selector:
    matchLabels:
      app: elasticsearch-data
  template:
    metadata:
      labels:
        app: elasticsearch-data
    spec:
      containers:
        - name: elasticsearch
          image: docker.elastic.co/elasticsearch/elasticsearch:8.14.0
          ports:
            - containerPort: 9200
            - containerPort: 9300
          env:
            - name: cluster.name
              value: "production-logs"
            - name: node.name
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          resources:
            requests:
              memory: "4Gi"
              cpu: "2"
            limits:
              memory: "8Gi"
              cpu: "4"
          volumeMounts:
            - name: data
              mountPath: /usr/share/elasticsearch/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: glusterfs-standard
        resources:
          requests:
            storage: 200Gi
```

## Volume Expansion

GlusterFS CSI supports online volume expansion when `allowVolumeExpansion: true` is set on the StorageClass.

```bash
# Expand a PVC from 200Gi to 400Gi
kubectl patch pvc data-elasticsearch-data-0 \
  --type='merge' \
  -p '{"spec":{"resources":{"requests":{"storage":"400Gi"}}}}'

# Monitor expansion
kubectl get pvc data-elasticsearch-data-0
# STATUS: Bound  CAPACITY: 400Gi

# Heketi performs the LVM thin volume expansion automatically
# Verify with heketi-cli
heketi-cli volume list
heketi-cli volume info <volume-id>
```

## Geo-Replication for Disaster Recovery

GlusterFS geo-replication asynchronously replicates volumes to a secondary cluster for DR purposes.

### Setting Up Geo-Replication

```bash
# On the master cluster (gluster-01)
# Create the geo-replication slave user on all slave nodes
gluster system execute gsec_create

# On the slave cluster, create the target volume
gluster volume create gv-data-dr \
  replica 2 \
  dr-gluster-01:/data/glusterfs/brick1/gv-data-dr \
  dr-gluster-02:/data/glusterfs/brick1/gv-data-dr
gluster volume start gv-data-dr

# Create the geo-rep session from master to slave
# Replace with actual SSH key and slave cluster details
gluster volume geo-replication gv-data \
  geoaccount@dr-gluster-01::gv-data-dr create push-pem

gluster volume geo-replication gv-data \
  geoaccount@dr-gluster-01::gv-data-dr config use-meta-volume true

gluster volume geo-replication gv-data \
  geoaccount@dr-gluster-01::gv-data-dr start

# Check geo-replication status
gluster volume geo-replication gv-data \
  geoaccount@dr-gluster-01::gv-data-dr status
# MASTER NODE    SLAVE              STATUS    CRAWL STATUS
# gluster-01     dr-gluster-01      Active    Changelog Crawl
# gluster-02     dr-gluster-01      Passive   Not Started
```

### Monitoring Geo-Replication Lag

```bash
gluster volume geo-replication gv-data \
  geoaccount@dr-gluster-01::gv-data-dr status detail

# Key fields to monitor:
# LAST SYNCED TIME: shows how far behind the slave is
# CRAWL STATUS: Active means changelog-based sync is running
# FILES PENDING: number of unsynced files
```

## Performance Tuning

### Volume-Level Tuning

```bash
# Aggressive read-ahead for sequential workloads
gluster volume set gv-data performance.read-ahead-page-count 16

# Increase write-behind buffer for bulk writes
gluster volume set gv-data performance.write-behind-window-size 64MB

# IO cache for read-heavy workloads (disable for write-heavy)
gluster volume set gv-data performance.io-cache on
gluster volume set gv-data performance.cache-size 512MB

# Parallel reads from replicas
gluster volume set gv-data performance.client-io-threads on

# Disable ACL checks if not needed
gluster volume set gv-data server.allow-insecure on
```

### Client Mount Options

```bash
# High-performance FUSE mount options
mount -t glusterfs \
  -o direct-io-mode=enable,\
     use-readdirp=yes,\
     attribute-timeout=0,\
     entry-timeout=0,\
     transport=tcp,\
     log-level=WARNING \
  gluster-01:/gv-data /mnt/gluster-data
```

### XFS Filesystem Tuning

```bash
# Re-create the brick filesystem with performance-oriented options
mkfs.xfs \
  -d agcount=32 \
  -l size=256m,version=2,sunit=128 \
  -i size=512,maxpct=25 \
  -n size=65536 \
  -f /dev/vg_gluster/brick_data

# Mount with performance options
mount -o noatime,nodiratime,nobarrier,logbufs=8,logbsize=256k \
  /dev/vg_gluster/brick_data /data/glusterfs/brick1
```

## Monitoring GlusterFS Cluster Health

### Prometheus Exporter Setup

The `gluster_exporter` exposes GlusterFS metrics for Prometheus:

```bash
# Install gluster_exporter on each storage node
curl -L -o /usr/local/bin/gluster_exporter \
  https://github.com/ofesseler/gluster_exporter/releases/download/v0.2.7/gluster_exporter_linux_amd64

chmod +x /usr/local/bin/gluster_exporter

cat > /etc/systemd/system/gluster_exporter.service << 'EOF'
[Unit]
Description=GlusterFS Prometheus Exporter
After=glusterd.service

[Service]
ExecStart=/usr/local/bin/gluster_exporter \
  --metrics-path=/metrics \
  --port=9189 \
  --volumes=all \
  --peers=yes
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now gluster_exporter
```

Kubernetes ServiceMonitor for scraping all storage nodes:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gluster-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: gluster-exporter
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
  namespaceSelector:
    matchNames:
      - glusterfs-monitoring
```

### Key Metrics and Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: glusterfs-alerts
  namespace: monitoring
spec:
  groups:
    - name: glusterfs.health
      rules:
        - alert: GlusterFSNodeDown
          expr: |
            gluster_peers_connected == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "GlusterFS node {{ $labels.instance }} has no connected peers"
            description: "GlusterFS storage node is isolated. Volume availability may be degraded."

        - alert: GlusterFSVolumeUnhealthy
          expr: |
            gluster_volume_status{status!="1"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "GlusterFS volume {{ $labels.volume }} is not started"
            description: "Volume {{ $labels.volume }} is not in started state. Check gluster volume status."

        - alert: GlusterFSBrickUnhealthy
          expr: |
            gluster_brick_status{status!="1"} == 1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "GlusterFS brick {{ $labels.brick }} is offline"
            description: "Brick {{ $labels.brick }} on volume {{ $labels.volume }} is not running."

        - alert: GlusterFSHighHealPending
          expr: |
            gluster_heal_info_files_count > 1000
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "High number of pending heal files on {{ $labels.volume }}"
            description: |
              Volume {{ $labels.volume }} has {{ $value }} files pending self-heal.
              This may indicate a brick was recently offline. Run:
              gluster volume heal {{ $labels.volume }} info

        - alert: GlusterFSDiskUsageHigh
          expr: |
            (gluster_brick_capacity_used_bytes / gluster_brick_capacity_bytes_total) > 0.85
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "GlusterFS brick {{ $labels.brick }} disk usage above 85%"
            description: "Brick {{ $labels.brick }} is {{ $value | humanizePercentage }} full."
```

### Operational Health Checks

```bash
# Full volume health check
gluster volume status gv-data detail

# Check self-heal status
gluster volume heal gv-data info
gluster volume heal gv-data info healed
gluster volume heal gv-data info heal-failed
gluster volume heal gv-data info split-brain

# Resolve split-brain (manual intervention required)
gluster volume heal gv-data split-brain source-brick gluster-01:/data/glusterfs/brick1/gv-data

# Check rebalance status after adding nodes
gluster volume rebalance gv-data status

# Test volume read/write from a client
dd if=/dev/zero of=/mnt/gluster-data/testfile bs=1M count=1024 oflag=direct
dd if=/mnt/gluster-data/testfile of=/dev/null bs=1M iflag=direct
```

## Adding Nodes and Rebalancing

```bash
# Add a new node to the trusted storage pool
gluster peer probe gluster-05

# Add bricks to expand the volume (maintain replica count)
gluster volume add-brick gv-data \
  replica 2 \
  gluster-05:/data/glusterfs/brick1/gv-data \
  gluster-06:/data/glusterfs/brick1/gv-data

# Start data rebalance — distributes existing files to new bricks
gluster volume rebalance gv-data start

# Monitor rebalance progress
watch -n 5 "gluster volume rebalance gv-data status"
# Node        Rebalanced-files  Failures  Skipped  Status   Run Time
# gluster-05  12453             0         0        in progress  5m23s
```

## Snapshot Management

```bash
# Create a volume snapshot
gluster snapshot create snap-gv-data-20301113 gv-data \
  description "Pre-migration snapshot" \
  no-timestamp

# List snapshots
gluster snapshot list

# Activate a snapshot for read access
gluster snapshot activate snap-gv-data-20301113

# Mount the snapshot
mount -t glusterfs gluster-01:/snaps/snap-gv-data-20301113/gv-data /mnt/snapshot-test

# Restore from snapshot (destructive — destroys current volume state)
gluster snapshot restore snap-gv-data-20301113

# Delete old snapshots
gluster snapshot delete snap-gv-data-20301113

# Configure snapshot auto-delete when disk usage exceeds threshold
gluster snapshot config snap-max-hard-limit 10
gluster snapshot config auto-delete enable
gluster snapshot config activate-on-create enable
```

## Troubleshooting Common Issues

### Split-Brain Detection and Recovery

```bash
# Identify split-brain files
gluster volume heal gv-data info split-brain
# Brick gluster-01:/data/glusterfs/brick1/gv-data
# Number of entries in split-brain: 3
# /path/to/splitbrain-file1
# /path/to/splitbrain-file2

# For each split-brain file, choose the authoritative brick
gluster volume heal gv-data split-brain \
  source-brick gluster-01:/data/glusterfs/brick1/gv-data \
  /path/to/splitbrain-file1

# After resolving, trigger self-heal
gluster volume heal gv-data
```

### Brick Offline Recovery

```bash
# If a brick went offline and came back
gluster volume heal gv-data full

# Check heal progress
gluster volume heal gv-data info
# Brick gluster-02:/data/glusterfs/brick1/gv-data
# Status: Connected
# Number of entries: 4521  (files needing sync)

# Monitor until entries reaches 0
watch -n 30 "gluster volume heal gv-data info | grep 'Number of entries'"
```

## Summary

GlusterFS with Heketi and the CSI driver provides a fully open-source, scale-out distributed storage platform for Kubernetes that supports dynamic volume provisioning, online expansion, geo-replication for DR, and snapshot-based backup. The operational keys are maintaining XFS brick filesystems with appropriate tuning, monitoring peer connectivity and self-heal queue depths with Prometheus, and establishing documented runbooks for split-brain recovery before the scenario arises in production.
