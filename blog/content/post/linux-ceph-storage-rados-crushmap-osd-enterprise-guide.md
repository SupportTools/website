---
title: "Linux Ceph Storage: RADOS Object Store, CephFS vs RBD, OSD Placement Groups, CRUSH Maps, and Rebalancing"
date: 2031-11-27T00:00:00-05:00
draft: false
tags: ["Ceph", "Linux", "Storage", "RADOS", "CephFS", "Object Storage", "Distributed Systems"]
categories:
- Linux
- Storage
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Ceph storage operations guide: RADOS internals, CephFS vs RBD selection criteria, placement group sizing, CRUSH map customization, and controlled cluster rebalancing procedures."
more_link: "yes"
url: "/linux-ceph-storage-rados-crushmap-osd-enterprise-guide/"
---

Ceph is the dominant open-source distributed storage system for Linux environments and the backing store for many Kubernetes storage solutions including Rook, OpenStack Cinder, and standalone deployments. Operating it well requires understanding the full stack from RADOS object semantics through CRUSH topology to the operational procedures that keep petabyte-scale clusters healthy under continuous write load. This guide covers all of it.

<!--more-->

# Linux Ceph Storage: From RADOS to Production Operations

## Architecture Overview

Ceph's architecture separates storage concerns cleanly:

```
Clients
   |
   v
librados / librbd / ceph-fuse
   |
   v
Ceph Monitors (Cluster state, CRUSH map)
   |
   v
RADOS (Reliable Autonomic Distributed Object Store)
   |
   v
OSDs (Object Storage Daemons, one per physical drive)
```

The key insight: all higher-level interfaces (RBD block devices, CephFS filesystems, RGW object gateway) are built on top of RADOS. Understanding RADOS gives you the mental model to debug any Ceph problem.

## Section 1: RADOS — The Foundation

### Object Model

RADOS stores objects identified by (pool, object_name) tuples. An object has:
- A name (up to 4096 bytes)
- Data (byte stream, up to 128TB theoretically, 100GB practical)
- Extended attributes (xattrs, arbitrary key-value pairs)
- Object Map (omap, B-tree of key-value pairs stored alongside data)

```bash
# Direct RADOS operations
rados -p mypool put myobject /path/to/localfile
rados -p mypool get myobject /tmp/retrieved
rados -p mypool stat myobject
rados -p mypool listxattr myobject
rados -p mypool setxattr myobject mykey myvalue

# List objects in a pool
rados -p mypool ls | head -20

# Pool usage statistics
rados df
```

### Pool Types

```bash
# Replicated pool (most common)
ceph osd pool create data-replicated 128 replicated

# Erasure coded pool (higher efficiency, lower performance)
ceph osd erasure-code-profile set my-ec \
  k=4 m=2 \
  crush-failure-domain=host \
  plugin=jerasure \
  technique=reed_sol_van

ceph osd pool create data-erasure 64 erasure my-ec

# Convert pool to application type
ceph osd pool application enable data-replicated rbd
ceph osd pool application enable cephfs-data cephfs
ceph osd pool application enable rgw-data rgw
```

### RADOS I/O Classes

Ceph 14+ supports Lua-like I/O classes for server-side computation:

```cpp
// C++ OSD extension example (simplified)
// Compiled into a .so and loaded by OSD daemons
#include "objclass/objclass.h"

CLS_VER(1,0)
CLS_NAME(myclass)

cls_method_handle_t h_count_words;

static int count_words(cls_method_context_t hctx, bufferlist *in, bufferlist *out) {
    bufferlist data;
    int ret = cls_cxx_read(hctx, 0, 0, &data);
    if (ret < 0) return ret;

    std::string content(data.c_str(), data.length());
    int count = 0;
    bool in_word = false;
    for (char c : content) {
        if (std::isspace(c)) {
            in_word = false;
        } else if (!in_word) {
            in_word = true;
            count++;
        }
    }

    ::encode(count, *out);
    return 0;
}

void __cls_init() {
    CLS_LOG(1, "loading myclass");
    cls_register("myclass", &h_myclass);
    cls_register_cxx_method(h_myclass, "count_words",
                            CLS_METHOD_RD,
                            count_words, &h_count_words);
}
```

## Section 2: CephFS vs RBD — Selection Guide

### CephFS (Ceph File System)

CephFS presents a POSIX filesystem backed by RADOS. It uses:
- **Metadata Server (MDS)**: Manages directory trees, file metadata, leases
- **Data pool**: Stores file data objects
- **Metadata pool**: Stores inodes, directory entries

```bash
# Deploy MDS
ceph fs volume create myfs

# Verify
ceph fs status myfs
ceph mds stat

# Mount with kernel client
mount -t ceph mon1:6789,mon2:6789,mon3:6789:/ /mnt/cephfs \
  -o name=admin,secretfile=/etc/ceph/admin.secret,_netdev

# Mount with FUSE (supports more features, lower performance)
ceph-fuse /mnt/cephfs -n client.admin
```

**When to use CephFS:**
- Multi-reader/multi-writer shared filesystem access
- NFS-like workloads where POSIX semantics matter
- AI/ML training data that multiple pods read simultaneously
- Home directories, shared project storage

**CephFS limitations:**
- MDS becomes a single point of coordination (scale with multiple active MDS)
- Hard links across directories not supported
- File locking via POSIX fcntl works but is slow across nodes

### RBD (RADOS Block Device)

RBD presents block devices stored as objects in a pool. Each RBD image is a set of RADOS objects named `<image-name>.XXXXXXXXXX` (where X is the object number).

```bash
# Create RBD pool
ceph osd pool create rbd 128
rbd pool init rbd

# Create an image
rbd create --size 10240 --image-feature layering,exclusive-lock,object-map,fast-diff,deep-flatten rbd/myimage

# Map to a block device
rbd map rbd/myimage
# Returns: /dev/rbd0

# Use it
mkfs.xfs /dev/rbd0
mount /dev/rbd0 /mnt/rbd

# Snapshot and clone workflow
rbd snap create rbd/myimage@snap1
rbd snap protect rbd/myimage@snap1
rbd clone rbd/myimage@snap1 rbd/myimage-clone

# Flatten (remove dependency on parent)
rbd flatten rbd/myimage-clone
```

**When to use RBD:**
- Kubernetes PersistentVolumes (via CSI driver)
- Virtual machine disk images (OpenStack, oVirt)
- Single-writer block device semantics
- Databases (PostgreSQL, MySQL) requiring exclusive block access

**RBD performance features:**

```bash
# Enable object-map for fast diff/resize operations
rbd feature enable rbd/myimage object-map fast-diff

# Enable exclusive-lock for safe multi-node access coordination
rbd feature enable rbd/myimage exclusive-lock

# Set stripe width to match workload
rbd create --size 100G \
  --stripe-unit 65536 \
  --stripe-count 16 \
  rbd/striped-image
```

### Object Gateway (RGW) — S3/Swift API

```bash
# Deploy RGW
radosgw-admin user create --uid=testuser --display-name="Test User" \
  --access-key=<rgw-access-key> --secret=<rgw-secret-key>

# S3 API usage (AWS CLI compatible)
aws s3 ls --endpoint-url http://rgw.example.com:7480

# Performance tuning: increase thread count for high throughput
ceph config set client.rgw.myzone rgw_thread_pool_size 512
ceph config set client.rgw.myzone rgw_max_chunk_size 4194304
```

## Section 3: OSD Placement Groups

### Placement Group Fundamentals

A Placement Group (PG) is the unit of data distribution. The mapping:

```
object_name -> hash -> PG number -> OSD set
```

This two-level mapping (objects -> PGs -> OSDs) means:
- Moving an OSD rebalances PGs (not individual objects)
- PG count controls parallelism and recovery granularity

### PG Count Sizing

The recommended formula:

```
Total PGs = (OSDs * 100) / replication_factor

# Example: 30 OSDs, replica 3
Total PGs = (30 * 100) / 3 = 1000
# Round to nearest power of 2: 1024

# Distribute across pools proportionally to expected utilization
# If you have 2 pools at 50/50:
pool1_pgs = 512
pool2_pgs = 512
```

**PG autoscaler** (Ceph 14+) handles this automatically:

```bash
# Enable autoscaler globally
ceph config set global osd_pool_default_pg_autoscale_mode on

# Or per-pool
ceph osd pool set mypool pg_autoscale_mode on

# Check recommendations
ceph osd pool autoscale-status

# Output:
# POOL          SIZE  TARGET SIZE  RATE  RAW CAPACITY  RATIO  TARGET RATIO  EFFECTIVE RATIO  BIAS  PG_NUM  NEW PG_NUM  AUTOSCALE
# device_health_metrics    0         0  3.0          45T  0.0000           0.0000           0.0000  1.0       1          1  on
# cephfs-data              2.3T      0  3.0          45T  0.1534           0.0000           0.1534  1.0      64        128  on
```

### PG States

```bash
# Check PG health
ceph pg stat
ceph pg dump --format json-pretty | jq '.pg_map.pg_stats[] | {pgid: .pgid, state: .state}'

# Common PG states
# active+clean: healthy
# active+degraded: some replicas missing (OSD down), still serving I/O
# active+remapped: PG mapped to new OSD set but not yet backfilled
# undersized: fewer replicas than min_size (I/O allowed with degraded performance)
# incomplete: can't determine authoritative copy (data at risk)
# stale: PG hasn't reported in heartbeat period (OSD down or network split)

# Find specific problem PGs
ceph pg dump_stuck stale
ceph pg dump_stuck inactive
ceph pg dump_stuck unclean
```

### Manually Forcing PG Recovery

```bash
# Force immediate recovery on specific PG
ceph pg repair 1.3a5

# Check recovery progress
ceph -w | grep -E "recovery|backfill"

# Throttle recovery to protect production I/O
ceph osd set-recovery-priority-map << 'EOF'
{
    "levels": [
        {"name": "high",   "recovery_ops": 10, "recovery_max_active": 3},
        {"name": "default","recovery_ops": 1,  "recovery_max_active": 1}
    ]
}
EOF
```

## Section 4: CRUSH Maps

### CRUSH Algorithm

CRUSH (Controlled Replication Under Scalable Hashing) is a pseudo-random algorithm that deterministically maps PGs to OSDs using:
- A CRUSH map (hierarchy of buckets)
- A placement rule (specifies failure domains)
- The PG number (input)

The output is a set of OSD IDs satisfying the placement rule.

### CRUSH Map Structure

```bash
# Export current CRUSH map
ceph osd getcrushmap -o crush.bin
crushtool -d crush.bin -o crush.txt
cat crush.txt
```

A CRUSH map has three sections:

```
# crush.txt (human-readable format)

# 1. Device declarations (OSDs)
device 0 osd.0 class hdd
device 1 osd.1 class hdd
device 2 osd.2 class hdd
device 3 osd.3 class ssd
device 4 osd.4 class ssd

# 2. Bucket hierarchy
type 0 osd
type 1 host
type 2 chassis
type 3 rack
type 4 row
type 5 pdu
type 6 pod
type 7 room
type 8 datacenter
type 9 zone
type 10 region
type 11 root

host node1 {
    id -2
    id -102 class hdd
    alg straw2
    hash 0
    item osd.0 weight 1.000
    item osd.1 weight 1.000
}

host node2 {
    id -3
    id -103 class hdd
    alg straw2
    hash 0
    item osd.2 weight 1.000
}

rack rack1 {
    id -4
    alg straw2
    hash 0
    item node1 weight 2.000
    item node2 weight 1.000
}

root default {
    id -1
    alg straw2
    hash 0
    item rack1 weight 3.000
}

# 3. Placement rules
rule replicated_rule {
    id 0
    type replicated
    min_size 1
    max_size 10
    step take default
    step chooseleaf firstn 0 type host
    step emit
}
```

### Custom CRUSH Rules for Tiering

```
# HDD rule for cold storage
rule hdd-replicated {
    id 1
    type replicated
    min_size 1
    max_size 10
    step take default class hdd
    step chooseleaf firstn 0 type host
    step emit
}

# SSD rule for hot data
rule ssd-replicated {
    id 2
    type replicated
    min_size 1
    max_size 10
    step take default class ssd
    step chooseleaf firstn 0 type host
    step emit
}

# Erasure rule spreading across racks
rule ec-rack-distributed {
    id 3
    type erasure
    min_size 4
    max_size 8
    step take default
    step choose indep 0 type rack
    step chooseleaf indep 2 type host
    step emit
}
```

```bash
# Compile and apply modified CRUSH map
crushtool -c crush.txt -o crush-new.bin
ceph osd setcrushmap -i crush-new.bin

# Verify
ceph osd crush tree
ceph osd crush class ls

# Test CRUSH placement
crushtool -i crush-new.bin --test --show-mappings --rule=2 --num-rep=3 --min-x=0 --max-x=255
```

### CRUSH Map for Multi-Datacenter

```bash
# Create datacenter-aware root
ceph osd crush add-bucket dc1 datacenter
ceph osd crush add-bucket dc2 datacenter
ceph osd crush add-bucket us-east region
ceph osd crush move dc1 region=us-east
ceph osd crush move dc2 region=us-east

# Stretch cluster rule (write to both DCs)
cat > stretch.txt << 'EOF'
rule stretch-replicated {
    id 10
    type replicated
    min_size 4
    max_size 6
    step take us-east
    step choose firstn 2 type datacenter
    step chooseleaf firstn 2 type host
    step emit
}
EOF
```

### OSD Weight Management

```bash
# Set OSD weight (1.0 per TB is the convention)
ceph osd crush reweight osd.5 2.0   # 2TB drive gets weight 2.0

# Reweight by utilization (bring high-usage OSDs into balance)
ceph osd reweight-by-utilization

# Set primary affinity (prefer an OSD as primary replica)
ceph osd primary-affinity osd.3 0.5  # 0=never primary, 1=always preferred

# Out an OSD gracefully (triggers rebalance)
ceph osd out osd.7

# In an OSD
ceph osd in osd.7
```

## Section 5: Rebalancing Operations

### Understanding Rebalancing

Rebalancing occurs when:
- An OSD is added or removed
- A CRUSH map weight changes
- A pool's PG count changes (pgp_num changes)

During rebalancing:
1. CRUSH map change → some PGs now map to different OSD sets
2. New primary OSD fetches data from old primary
3. Old replicas are removed after successful copy

### Monitoring Rebalancing Progress

```bash
# Summary status
ceph status
# ceph status output includes:
#   health: HEALTH_WARN
#   recovery:
#     14.3 GiB/s, 987 keys/s
#     42.3 TiB / 145.7 TiB
#   pgs:
#     1234 active+remapped+backfill_toofull
#     5678 active+clean

# Detailed recovery stats
ceph osd pool stats | grep -A5 recovery

# Watch live
watch -n1 'ceph status'

# Check estimated time
ceph progress
```

### Controlling Rebalancing Speed

```bash
# The most important tunables for production rebalancing

# Recovery operations per OSD (default: 3)
ceph config set osd osd_recovery_max_active 1    # Conservative
ceph config set osd osd_recovery_max_active 5    # Aggressive
ceph config set osd osd_recovery_max_active_hdd 1
ceph config set osd osd_recovery_max_active_ssd 3

# Backfill (filling new OSDs) operations per OSD
ceph config set osd osd_max_backfills 1

# Recovery sleep to yield to client I/O
ceph config set osd osd_recovery_sleep_hdd 0.1   # 100ms sleep between ops
ceph config set osd osd_recovery_sleep_ssd 0.01  # 10ms for SSDs

# Priority of recovery vs client I/O
ceph config set osd osd_client_op_priority 63
ceph config set osd osd_recovery_op_priority 3   # Lower = less priority

# Pause all rebalancing (emergency stop)
ceph osd set nobackfill
ceph osd set norebalance
ceph osd set norecover

# Resume
ceph osd unset nobackfill
ceph osd unset norebalance
ceph osd unset norecover
```

### Adding an OSD — Step-by-Step

```bash
#!/bin/bash
# add-osd.sh <hostname> <drive> <weight>
# Example: ./add-osd.sh node4 /dev/sdb 1.0

HOSTNAME=$1
DRIVE=$2
WEIGHT=$3

# Step 1: Prepare the drive with ceph-volume (LVM mode)
ceph-volume lvm prepare --bluestore --data "$DRIVE"

# Step 2: Activate the OSD
# ceph-volume lvm activate <osd_id> <osd_fsid>
# Get these from: ceph-volume lvm list
OSD_ID=$(ceph-volume lvm list | grep "osd id" | tail -1 | awk '{print $3}')
OSD_FSID=$(ceph-volume lvm list | grep "osd fsid" | tail -1 | awk '{print $3}')
ceph-volume lvm activate "$OSD_ID" "$OSD_FSID"

# Step 3: Set initial weight to 0 to avoid sudden rebalance flood
ceph osd crush reweight "osd.$OSD_ID" 0

# Step 4: Gradually increase weight over time
for STEP in 0.25 0.5 0.75 1.0; do
    TARGET=$(echo "$WEIGHT * $STEP" | bc)
    echo "Setting weight to $TARGET"
    ceph osd crush reweight "osd.$OSD_ID" "$TARGET"

    # Wait for PG rebalancing to settle before next increment
    echo "Waiting for cluster to settle..."
    while ceph pg stat | grep -qE "remapped|backfill"; do
        sleep 30
    done
    echo "Cluster settled at weight $TARGET"
done

echo "OSD $OSD_ID fully integrated with weight $WEIGHT"
```

### Removing an OSD — Safe Procedure

```bash
#!/bin/bash
# remove-osd.sh <osd_id>
# Example: ./remove-osd.sh 7

OSD_ID=$1

# Step 1: Drain by setting weight to 0 gradually
CURRENT_WEIGHT=$(ceph osd crush tree --format json | \
  jq -r ".nodes[] | select(.name == \"osd.$OSD_ID\") | .crush_weight")

echo "Current weight: $CURRENT_WEIGHT"

for STEP in 0.75 0.5 0.25 0.0; do
    TARGET=$(echo "$CURRENT_WEIGHT * $STEP" | bc)
    ceph osd crush reweight "osd.$OSD_ID" "$TARGET"
    echo "Reduced weight to $TARGET, waiting for rebalance..."
    while ceph pg stat | grep -qE "remapped|backfill"; do
        sleep 30
    done
done

# Step 2: Mark out (stop receiving new PGs)
ceph osd out "osd.$OSD_ID"

# Step 3: Disable scrubbing during removal
ceph osd set noscrub
ceph osd set nodeep-scrub

# Step 4: Stop the OSD daemon
systemctl stop "ceph-osd@$OSD_ID"

# Step 5: Remove from CRUSH map
ceph osd crush remove "osd.$OSD_ID"

# Step 6: Delete auth key
ceph auth del "osd.$OSD_ID"

# Step 7: Delete OSD from cluster
ceph osd rm "osd.$OSD_ID"

# Step 8: Re-enable scrubbing
ceph osd unset noscrub
ceph osd unset nodeep-scrub

echo "OSD $OSD_ID removed successfully"
ceph status
```

## Section 6: Performance Tuning

### BlueStore Tuning

BlueStore (the default OSD backend since Ceph 12) provides direct object storage on block devices without a local filesystem.

```bash
# Tune BlueStore cache for SSDs
ceph config set osd.0 bluestore_cache_size_ssd 4294967296    # 4GB SSD cache
ceph config set osd.0 bluestore_cache_size_hdd 1073741824    # 1GB HDD cache

# WAL and DB on faster device (NVMe WAL, SSD DB, HDD data)
# Done at provision time with ceph-volume:
ceph-volume lvm prepare --bluestore \
  --data /dev/sdb \
  --block.wal /dev/nvme0n1p1 \
  --block.db /dev/nvme0n1p2

# Check BlueStore allocation stats
ceph daemon osd.0 bluestore allocator score block
ceph daemon osd.0 perf dump | jq '.bluestore'

# BlueStore compression
ceph config set osd bluestore_compression_mode aggressive
ceph config set osd bluestore_compression_algorithm snappy
# Or zstd for better ratio at cost of CPU:
ceph config set osd bluestore_compression_algorithm zstd
```

### Network Tuning for High Throughput

```bash
# ceph.conf network settings
cat >> /etc/ceph/ceph.conf << 'EOF'
[osd]
# Use public and cluster networks separately
public_network = 10.0.1.0/24
cluster_network = 10.0.2.0/24

# Messenger v2 settings
ms_dispatch_throttle_bytes = 1073741824
ms_async_op_threads = 8
ms_async_max_op_threads = 24

# Tuning for 25GbE+ networks
osd_op_threads = 16
osd_disk_threads = 4
EOF

# OS network tuning (add to /etc/sysctl.d/99-ceph.conf)
cat > /etc/sysctl.d/99-ceph.conf << 'EOF'
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216
net.ipv4.tcp_rmem = 4096 65536 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.core.somaxconn = 4096
net.core.netdev_max_backlog = 250000
EOF
sysctl -p /etc/sysctl.d/99-ceph.conf
```

### Benchmarking with rados bench

```bash
# Write benchmark
rados bench -p mypool 60 write --no-cleanup

# Sequential read
rados bench -p mypool 60 seq

# Random read
rados bench -p mypool 60 rand

# Cleanup test objects
rados bench -p mypool 60 cleanup

# RBD benchmark
rbd bench myimage --io-type write --io-size 4096 --io-threads 16 --io-total 10G --io-pattern rand

# Monitor during benchmark
ceph -w &
iostat -x 1 &
```

## Section 7: Observability and Alerting

### Prometheus Integration

```yaml
# ceph-exporter deployment
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ceph-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: ceph-exporter
  template:
    spec:
      containers:
        - name: ceph-exporter
          image: quay.io/ceph/ceph-exporter:latest
          args:
            - --sock-dir=/var/run/ceph
            - --port=9926
          volumeMounts:
            - name: ceph-run
              mountPath: /var/run/ceph
            - name: ceph-conf
              mountPath: /etc/ceph
      volumes:
        - name: ceph-run
          hostPath:
            path: /var/run/ceph
        - name: ceph-conf
          hostPath:
            path: /etc/ceph
```

### Key Prometheus Alert Rules

```yaml
groups:
  - name: ceph
    rules:
      - alert: CephHealthError
        expr: ceph_health_status == 2
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Ceph cluster is in ERROR state"

      - alert: CephOSDDown
        expr: ceph_osd_up == 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Ceph OSD {{ $labels.ceph_daemon }} is down"

      - alert: CephOSDNearFull
        expr: ceph_osd_utilization > 80
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "OSD {{ $labels.ceph_daemon }} utilization is {{ $value }}%"

      - alert: CephPoolNearFull
        expr: ceph_pool_percent_used > 75
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pool {{ $labels.name }} is {{ $value }}% full"

      - alert: CephPGsUnhealthy
        expr: ceph_pg_total - ceph_pg_active_clean > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} PGs are unhealthy"

      - alert: CephHighRecoveryOps
        expr: ceph_osd_recovery_ops > 100
        for: 30m
        labels:
          severity: info
        annotations:
          summary: "Ceph cluster is recovering at high rate"
```

## Section 8: Common Failure Scenarios

### Scenario 1: OSD Full (HEALTH_ERR)

```bash
# Symptom: writes fail with ENOSPC
# Check
ceph df detail
ceph osd df tree

# Immediate mitigation: increase full_ratio temporarily
ceph osd set-full-ratio 0.98
ceph osd set-nearfull-ratio 0.95

# Delete data to recover space
# Note: you can't delete from a full cluster!
# First, set noscrub/nodeep-scrub to free OSD threads
ceph osd set noscrub
ceph osd set nodeep-scrub

# Delete objects in most-full pools
# Then restore ratios:
ceph osd set-full-ratio 0.95
ceph osd set-nearfull-ratio 0.85
ceph osd unset noscrub
ceph osd unset nodeep-scrub
```

### Scenario 2: Clock Skew

```bash
# Ceph monitors require clocks within 0.05 seconds
# Symptom: mon quorum lost, "clock skew detected" in logs

# Check clock status
ceph time-sync-status
timedatectl show

# Fix: ensure chrony/NTP is running on all nodes
systemctl status chronyd
chronyc tracking
chronyc sources -v

# If manual reset needed (dangerous, only as last resort)
systemctl stop chronyd
ntpdate -b pool.ntp.org
systemctl start chronyd
```

### Scenario 3: MON Quorum Lost

```bash
# Symptom: ceph status hangs, cluster unreachable

# Check MON status from each mon node
ceph mon stat
ceph mon dump

# If quorum can't form, manually inject monmap
# On surviving monitor:
ceph-mon --extract-monmap /tmp/monmap --id mon1
monmaptool --print /tmp/monmap

# Remove failed monitor from monmap
monmaptool --rm mon2 /tmp/monmap

# Re-inject
ceph-mon --inject-monmap /tmp/monmap --id mon1

# Restart ceph-mon
systemctl restart ceph-mon@mon1
```

## Section 9: Quota Management

```bash
# Pool quotas
ceph osd pool set-quota mypool max_bytes $((10 * 1024 * 1024 * 1024))  # 10GB
ceph osd pool set-quota mypool max_objects 1000000

# Get quota
ceph osd pool get-quota mypool

# CephFS directory quotas
setfattr -n ceph.quota.max_bytes -v 1073741824 /mnt/cephfs/project-alpha
setfattr -n ceph.quota.max_files -v 100000 /mnt/cephfs/project-alpha

# Check
getfattr -n ceph.quota.max_bytes /mnt/cephfs/project-alpha
getfattr -n ceph.dir.rfiles /mnt/cephfs/project-alpha
getfattr -n ceph.dir.rbytes /mnt/cephfs/project-alpha
```

## Section 10: Upgrading Ceph

```bash
#!/bin/bash
# Ceph rolling upgrade (Quincy to Reef example)

# Prerequisites
ceph health
ceph osd set noout    # Don't rebalance during upgrade
ceph osd set nobackfill
ceph osd set norecover

# Upgrade monitors first (one at a time)
for MON in mon1 mon2 mon3; do
    ssh "$MON" "apt-get install -y ceph-mon && systemctl restart ceph-mon@$(hostname)"
    sleep 30
    ceph mon stat
done

# Upgrade MGRs
for MGR in mgr1 mgr2; do
    ssh "$MGR" "apt-get install -y ceph-mgr && systemctl restart ceph-mgr@$(hostname)"
    sleep 10
done

# Upgrade OSDs (one host at a time)
for HOST in osd1 osd2 osd3 osd4; do
    echo "Upgrading OSDs on $HOST"

    # Mark OSDs on this host as out to migrate data away
    for OSD in $(ceph osd ls-tree "$HOST"); do
        ceph osd out "$OSD"
    done

    # Wait for PGs to stabilize
    while ceph pg stat | grep -qE "remapped|backfill"; do
        sleep 30
    done

    ssh "$HOST" "apt-get install -y ceph-osd && \
      for svc in \$(systemctl list-units 'ceph-osd@*' --plain --no-legend | awk '{print \$1}'); do
        systemctl restart \$svc
      done"

    # Mark OSDs back in
    for OSD in $(ceph osd ls-tree "$HOST"); do
        ceph osd in "$OSD"
    done

    sleep 60
done

# Re-enable rebalancing
ceph osd unset noout
ceph osd unset nobackfill
ceph osd unset norecover

ceph versions
ceph status
```

## Conclusion

Ceph's depth comes from its RADOS foundation: every higher-level service (RBD, CephFS, RGW) is a thin layer over a distributed object store that handles replication, failure detection, and recovery autonomously. Mastering operations requires understanding:

1. **RADOS pool configuration**: erasure vs replicated, PG count sizing, and the autoscaler.
2. **CephFS vs RBD**: POSIX shared filesystem vs exclusive block device—match the access semantics to your workload.
3. **CRUSH maps**: model your physical failure domains, use device classes for tiering, and apply custom rules per pool.
4. **Rebalancing control**: OSD weight gradual changes, recovery throttling, and the operational flags (noout, nobackfill, norecover) that protect production I/O during maintenance.
5. **Observability**: Prometheus metrics for pool utilization, OSD state, and PG health—alert before full conditions occur.

These fundamentals apply whether you are operating Ceph directly on bare metal or through Rook in Kubernetes.
