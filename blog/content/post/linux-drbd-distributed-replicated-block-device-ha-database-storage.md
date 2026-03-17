---
title: "Linux DRBD: Distributed Replicated Block Device for HA Database Storage"
date: 2031-01-08T00:00:00-05:00
draft: false
tags: ["Linux", "DRBD", "High Availability", "Storage", "Pacemaker", "Kubernetes", "Database", "Replication"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to DRBD for HA database storage, covering resource configuration, sync protocols, split-brain resolution, Pacemaker integration, Kubernetes CSI driver, and performance tuning."
more_link: "yes"
url: "/linux-drbd-distributed-replicated-block-device-ha-database-storage/"
---

DRBD (Distributed Replicated Block Device) provides synchronous or asynchronous block-level replication between Linux servers without shared storage hardware. It is the foundation of many high-availability database deployments — PostgreSQL, MySQL, and MongoDB HA clusters running on bare metal or in private clouds where cloud-native replicated storage is unavailable or too expensive. This guide covers DRBD resource configuration, synchronization protocols, split-brain detection and resolution, Pacemaker/Corosync cluster integration, the DRBD Kubernetes CSI driver, and performance tuning for database workloads.

<!--more-->

# Linux DRBD: Distributed Replicated Block Device for HA Database Storage

## Section 1: DRBD Architecture

DRBD operates at the kernel block device level, between the filesystem and the physical disk. It intercepts writes to a block device, replicates them to one or more remote nodes, and presents a consistent view to the local filesystem.

```
Application (PostgreSQL)
        │
    Filesystem (XFS/ext4)
        │
    DRBD Virtual Block Device (/dev/drbd0)
        │                    │
    Local Disk             TCP/IP Replication
  (/dev/sdb)                Network (10GbE)
                              │
                         Remote DRBD Node
                              │
                         Remote Disk (/dev/sdb)
```

### Key Concepts

- **Resource**: A DRBD volume configuration (device, disk, network).
- **Primary**: The node that mounts the filesystem and runs the application.
- **Secondary**: The node that receives replication writes but cannot be mounted (unless dual-primary mode).
- **Activity Log (AL)**: Tracks recently written extents. Limits resync scope after crash.
- **Bitmap**: Tracks dirty extents during peer disconnect. Enables quick partial resync.

### Replication Protocols

| Protocol | Write Complete When | Use Case |
|---|---|---|
| A (async) | Written to local disk + sent to replication buffer | WAN replication, DR |
| B (semi-sync) | Written to local disk + ACK received from peer buffer | Low-latency networks |
| C (sync) | Written to both disks on both nodes | Production databases requiring zero data loss |

Protocol C is mandatory for databases (PostgreSQL, MySQL) where loss of any committed transaction is unacceptable. The latency overhead is the round-trip time to the remote disk write — typically 0.5-2ms on a 10GbE LAN.

## Section 2: Installation

### On Both Nodes (RHEL 9 / Rocky Linux 9)

```bash
# Install DRBD kernel module and utilities
dnf install -y epel-release
dnf install -y drbd kmod-drbd

# Load the kernel module
modprobe drbd

# Verify the module loaded and DRBD version
drbdadm --version
# DRBDADM_VERSION_CODE=0x090100
# DRBD_KERNEL_VERSION_CODE=0x090100

# Enable auto-loading on boot
echo "drbd" >> /etc/modules-load.d/drbd.conf

# Check kernel module
lsmod | grep drbd
dmesg | grep -i drbd | tail -5
```

### Firewall Configuration

```bash
# Open DRBD replication port (7789 default, or custom port per resource)
firewall-cmd --permanent --add-port=7789/tcp
firewall-cmd --permanent --add-port=7790/tcp  # second resource
firewall-cmd --reload

# For Pacemaker/Corosync cluster communication:
firewall-cmd --permanent --add-service=high-availability
firewall-cmd --reload
```

## Section 3: DRBD Resource Configuration

DRBD resources are configured in `/etc/drbd.d/`. The global configuration is in `/etc/drbd.conf`.

### 3.1 Global Configuration

```bash
# /etc/drbd.conf
global {
    usage-count no;  # disable sending usage statistics to linbit.com
}

include "drbd.d/global_common.conf";
include "drbd.d/*.res";
```

```bash
# /etc/drbd.d/global_common.conf
global {
    usage-count no;
}

common {
    handlers {
        # Split-brain handling
        split-brain "/usr/lib/drbd/notify-split-brain.sh root";
        out-of-sync "/usr/lib/drbd/notify-out-of-sync.sh root";
        before-resync-target "/usr/lib/drbd/before-resync-target.sh";
        after-resync-target "/usr/lib/drbd/after-resync-target.sh";
    }

    startup {
        # How long to wait for peer on startup
        wfc-timeout 30;
        # Wait for peer even if outdated (prevents split-brain on reboot)
        degr-wfc-timeout 120;
        # Become primary if peer is stale after this many seconds
        become-primary-on-both: no;
    }

    options {
        auto-promote yes;         # auto-promote to primary when mounted
        quorum majority;          # 3+ node quorum support
    }

    net {
        # Protocol C: synchronous replication for databases
        protocol C;

        # Timeouts and connection settings
        timeout 60;           # seconds before considering connection lost
        connect-int 10;       # seconds between connection attempts
        ping-int 10;          # seconds between keep-alive pings
        ping-timeout 5;       # seconds to wait for ping response

        # Socket buffer sizes (tune for high-throughput)
        sndbuf-size 0;        # 0 = auto
        rcvbuf-size 0;

        # Allow dual-primary for active/active configurations
        # ONLY enable if you know what you are doing (requires cluster lock manager)
        allow-two-primaries no;

        # Use DRBD's internal fencing for network partitions
        fencing resource-only;

        # TLS/SSL for replication traffic (recommended for production)
        # tls yes;
        # ssl-key /etc/drbd.d/tls/drbd.key;
        # ssl-cert /etc/drbd.d/tls/drbd.crt;
        # ssl-ca-cert /etc/drbd.d/tls/ca.crt;
    }

    disk {
        # Activity log size: larger = faster recovery after crash
        # but more data to resync
        al-extents 6433;      # ~50GB of recent writes tracked

        # Backend device I/O policy
        disk-flushes yes;     # send flush to disk after each write
        disk-barrier yes;     # use disk barriers

        # Resync rate limit (prevent resync from saturating production I/O)
        resync-rate 200M;     # 200 MB/s maximum resync rate

        # Checksum-based resync (only send blocks that differ)
        c-plan-ahead 20;
        c-delay-target 10;
        c-fill-target 0;
        c-max-rate 400M;
    }
}
```

### 3.2 Resource Definition — PostgreSQL Database Volume

```bash
# /etc/drbd.d/pg-data.res
resource pg-data {
    # Resource options
    options {
        # After a split-brain, automatically resolve by choosing the node
        # with more recent data (use with extreme caution in production)
        # after-sb-0pri discard-younger-primary;
        # after-sb-1pri discard-secondary;
    }

    # Volume 0: the actual data volume
    volume 0 {
        device    /dev/drbd0;
        disk      /dev/sdb;        # physical device (use full disk or LVM LV)
        meta-disk internal;        # metadata stored on same device (last 128MB)
    }

    # Host-specific configuration
    on db-primary-01 {
        address   10.10.1.11:7789;
        node-id   0;
    }

    on db-secondary-01 {
        address   10.10.1.12:7789;
        node-id   1;
    }
}
```

### 3.3 Three-Node DRBD Resource (Witness/Quorum)

For split-brain prevention without a physical third node, DRBD 9 supports a "diskless" witness node:

```bash
# /etc/drbd.d/pg-data-3node.res
resource pg-data-3node {
    options {
        quorum majority;                        # require quorum for writes
        on-no-quorum io-error;                  # fail writes, don't proceed
        on-no-data-accessible io-error;
    }

    volume 0 {
        device    /dev/drbd1;
        disk      /dev/sdb;
        meta-disk internal;
    }

    on db-primary-01 {
        address  10.10.1.11:7790;
        node-id  0;
    }

    on db-secondary-01 {
        address  10.10.1.12:7790;
        node-id  1;
    }

    # Witness node: no disk (diskless), only participates in quorum
    on db-witness-01 {
        address  10.10.1.13:7790;
        node-id  2;
        volume 0 {
            disk none;        # diskless witness
            device /dev/drbd1;
        }
    }

    connection-mesh {
        hosts db-primary-01 db-secondary-01 db-witness-01;
    }
}
```

## Section 4: Initial Synchronization

### 4.1 Creating Metadata and Initializing

```bash
# Run on BOTH nodes before first start

# Step 1: Create DRBD metadata on the backing device
drbdadm create-md pg-data
# You will be prompted to overwrite existing metadata if any
# Output:
#   initializing activity log
#   initializing bitmap (1024 KB) to all zero
#   Writing meta data...
#   New drbd meta data block successfully created.

# Step 2: Bring up the DRBD resource
drbdadm up pg-data

# Step 3: Check the state (both nodes should show "Inconsistent" until sync)
drbdadm status pg-data
# pg-data role:Secondary
#   disk:Inconsistent
#   db-secondary-01 role:Secondary
#     peer-disk:Inconsistent

# Step 4: Force ONE node to be primary for initial sync
# Run on db-primary-01 ONLY:
drbdadm primary --force pg-data

# Step 5: Check sync progress
watch -n 2 drbdadm status pg-data

# Output during sync:
# pg-data role:Primary
#   disk:UpToDate
#   db-secondary-01 role:Secondary
#     replication:SyncSource sync-progress:45.3% (48.7 GiB remaining)
#     peer-disk:Inconsistent

# Step 6: After sync completes (disk:UpToDate on both), create filesystem
# Run on primary node:
mkfs.xfs -f /dev/drbd0

# Step 7: Mount and configure
mkdir -p /data/postgres
mount /dev/drbd0 /data/postgres
chown postgres:postgres /data/postgres

# Initialize PostgreSQL
su -c "initdb -D /data/postgres/data" postgres
```

### 4.2 Monitoring Sync Progress

```bash
# Detailed sync status
cat /proc/drbd
# version: 9.1.0 (api:2/proto:86-101)
# GIT-hash: ... build by ...
#  0: cs:SyncSource ro:Primary/Secondary ds:UpToDate/Inconsistent C r----
#     ns:2621440 nr:0 dw:0 dr:2621440 al:8 bm:0 lo:0 pe:0 ua:0 ap:0 ep:1 wo:f oos:94371888
#         [=====>..............] sync'ed: 26.9% (92256/126172)M
#         finish: 1:23:45 speed: 18,688 (18,176) K/sec

# Real-time monitoring with drbdmon
drbdmon

# Log DRBD events for monitoring
drbdsetup events2 --now pg-data | head -20
```

## Section 5: Day-to-Day Operations

### 5.1 Failover to Secondary

```bash
# Planned failover (graceful):
# Step 1: Stop the application on primary
systemctl stop postgresql

# Step 2: Unmount filesystem
umount /data/postgres

# Step 3: Demote primary to secondary
drbdadm secondary pg-data

# Step 4: On the secondary node, promote to primary
drbdadm primary pg-data

# Step 5: Mount filesystem on new primary
mount /dev/drbd0 /data/postgres

# Step 6: Start the application
systemctl start postgresql
```

### 5.2 Unplanned Failover (Primary Failed)

```bash
# If primary node is unreachable and secondary shows "Unknown" peer:
drbdadm status pg-data
# pg-data role:Secondary
#   disk:UpToDate
#   db-primary-01 role:Unknown
#     peer-disk:DUnknown
#     resync-suspended:peer-disk

# Force promotion on secondary (data up to date):
drbdadm primary --force pg-data

mount /dev/drbd0 /data/postgres
systemctl start postgresql
```

## Section 6: Split-Brain Detection and Resolution

Split-brain is the most dangerous DRBD scenario: both nodes become primary simultaneously, writing different data. DRBD detects this and refuses to reconnect.

### 6.1 Detecting Split-Brain

```bash
# drbdadm status shows split-brain state:
drbdadm status pg-data
# pg-data role:Primary
#   disk:UpToDate
#   db-secondary-01 role:Primary (! unexpected)
#     peer-disk:UpToDate
#     resync-suspended:split-brain

# System log:
dmesg | grep -i "split.brain"
# DRBD pg-data: Split-Brain detected, dropping connection!
```

### 6.2 Resolving Split-Brain

**Critical decision**: Which node's data do you keep? This is a data integrity decision — there is no automated solution that preserves all data from both nodes.

```bash
# Step 1: Identify which node has the correct/more recent data
# Check application logs, transaction logs, or data timestamps on both nodes

# Option A: Keep PRIMARY data, discard SECONDARY data
# Run on the node you want to DISCARD (the "loser"):
drbdadm secondary pg-data
drbdadm disconnect pg-data
drbdadm -- --discard-my-data connect pg-data

# Run on the node you want to KEEP (the "winner"):
drbdadm connect pg-data

# DRBD will now resync from the winner to the loser
# The loser's data is OVERWRITTEN. Verify this is what you want.

# Option B: Keep SECONDARY data (less common)
# Force secondary to become primary first, then follow the same procedure
# with the roles reversed

# Step 2: Monitor resync
watch -n 2 drbdadm status pg-data
```

### 6.3 Automatic Split-Brain Policies (Use with Caution)

```bash
# /etc/drbd.d/global_common.conf — add to the net section:

# These policies run ONLY when the cluster is partitioned with 0 primary nodes
# (both were secondary when the split happened — rare but recoverable)

net {
    # If both nodes were secondary during the split:
    # after-sb-0pri:
    #   discard-younger-primary — keep the data from the longer-lived primary
    #   disconnect — do nothing, require manual intervention (safest)
    #   call-pri-lost-after-sb — run a script to decide
    after-sb-0pri discard-younger-primary;

    # If one node was primary during the split:
    # after-sb-1pri:
    #   discard-secondary — secondary's data is wrong, keep primary's data
    #   call-pri-lost-after-sb
    after-sb-1pri discard-secondary;

    # If BOTH nodes were primary during the split (most dangerous):
    # after-sb-2pri:
    #   disconnect — manual intervention ALWAYS required
    #   call-pri-lost-after-sb
    after-sb-2pri disconnect;  # never auto-resolve this case
}
```

## Section 7: Pacemaker/Corosync Integration

Pacemaker provides cluster resource management for DRBD — it handles promotion, fencing, and resource ordering.

### 7.1 Corosync Configuration

```bash
# /etc/corosync/corosync.conf
totem {
    version: 2
    cluster_name: db-cluster
    # Transport: udpu (unicast) for cloud environments, mcast for bare metal LAN
    transport: udpu
    interface {
        ringnumber: 0
        bindnetaddr: 10.10.1.0
        mcastport: 5405
        ttl: 1
    }
}

nodelist {
    node {
        ring0_addr: 10.10.1.11
        name: db-primary-01
        nodeid: 1
    }
    node {
        ring0_addr: 10.10.1.12
        name: db-secondary-01
        nodeid: 2
    }
}

quorum {
    provider: corosync_votequorum
    two_node: 1  # Allow 2-node cluster (no quorum needed for 1-of-2)
}

logging {
    to_logfile: yes
    logfile: /var/log/corosync/corosync.log
    to_syslog: yes
    debug: off
}
```

### 7.2 Pacemaker DRBD Resource Configuration

```bash
# Configure Pacemaker resources
# Run on either node (Pacemaker synchronizes CIB automatically)

# Step 1: Create DRBD master/slave resource
pcs resource create pg-data-drbd \
    ocf:linbit:drbd \
    drbd_resource=pg-data \
    op monitor interval=30s

pcs resource promotable pg-data-drbd \
    promoted-max=1 \
    promoted-node-max=1 \
    clone-max=2 \
    clone-node-max=1 \
    notify=true

# Step 2: Create filesystem resource (depends on DRBD being primary)
pcs resource create pg-data-fs \
    ocf:heartbeat:Filesystem \
    device=/dev/drbd0 \
    directory=/data/postgres \
    fstype=xfs \
    options=noatime,logbsize=256k \
    op monitor interval=20s

# Step 3: Create virtual IP resource
pcs resource create pg-vip \
    ocf:heartbeat:IPaddr2 \
    ip=10.10.1.100 \
    cidr_netmask=24 \
    op monitor interval=10s

# Step 4: Create PostgreSQL resource
pcs resource create postgresql \
    ocf:heartbeat:pgsql \
    pgctl=/usr/bin/pg_ctl \
    psql=/usr/bin/psql \
    pgdata=/data/postgres/data \
    start_opt="-p 5432" \
    pgdba=postgres \
    op start timeout=120s \
    op stop timeout=120s \
    op monitor interval=15s timeout=60s

# Step 5: Create resource group (ensures proper start order)
pcs resource group add pg-primary-group \
    pg-data-fs \
    pg-vip \
    postgresql

# Step 6: Add ordering constraints
# DRBD must be promoted before filesystem mounts
pcs constraint order promote pg-data-drbd-clone \
    then start pg-primary-group

# Filesystem group must run on the DRBD primary node
pcs constraint colocation add pg-primary-group \
    with promoted pg-data-drbd-clone \
    score=INFINITY
```

### 7.3 Fencing (STONITH)

Fencing is mandatory for production Pacemaker clusters. Without it, split-brain can corrupt data.

```bash
# IPMI/iDRAC based fencing (bare metal)
pcs stonith create fence-primary-01 \
    fence_ipmilan \
    pcmk_host_list=db-primary-01 \
    ipaddr=10.10.2.11 \  # IPMI address
    login=admin \
    passwd=<ipmi-password> \
    lanplus=1 \
    op monitor interval=60s

pcs stonith create fence-secondary-01 \
    fence_ipmilan \
    pcmk_host_list=db-secondary-01 \
    ipaddr=10.10.2.12 \
    login=admin \
    passwd=<ipmi-password> \
    lanplus=1 \
    op monitor interval=60s

# AWS EC2 fencing (cloud)
pcs stonith create fence-aws \
    fence_aws \
    region=us-east-1 \
    pcmk_host_map="db-primary-01:i-0abcd1234;db-secondary-01:i-0efgh5678" \
    op monitor interval=60s

# Verify fencing configuration
pcs stonith show

# Test fencing (will reboot the node — ONLY in test environments)
# stonith_admin --reboot db-secondary-01
```

## Section 8: Kubernetes CSI Driver for DRBD

The DRBD CSI driver (linstor-csi) enables Kubernetes to dynamically provision DRBD-backed Persistent Volumes.

### 8.1 LINSTOR Architecture

```
Kubernetes cluster
    │
    ├── linstor-csi-controller (Deployment)
    │       └── Creates/deletes DRBD resources via LINSTOR API
    │
    ├── linstor-csi-node (DaemonSet)
    │       └── Attaches/detaches DRBD devices, mounts filesystems
    │
    └── linstor-controller (StatefulSet)
            └── Manages DRBD resource definitions and node pools
```

### 8.2 LINSTOR Controller Installation

```bash
# Install Piraeus Operator (manages LINSTOR in Kubernetes)
kubectl apply -f https://raw.githubusercontent.com/piraeusdatastore/piraeus-operator/v2/deploy/manifests.yaml

# Wait for operator
kubectl -n piraeus-datastore wait --for=condition=Available \
  deployment/piraeus-operator --timeout=300s
```

### 8.3 LINSTOR Cluster Configuration

```yaml
# linstorcluster.yaml
apiVersion: piraeus.io/v1
kind: LinstorCluster
metadata:
  name: linstorcluster
spec:
  # DRBD properties applied to all replicas
  properties:
  - name: DrbdOptions/Net/protocol
    value: "C"  # synchronous replication for databases
  - name: DrbdOptions/Net/allow-two-primaries
    value: "no"
  - name: DrbdOptions/Disk/al-extents
    value: "6433"
  patches:
  - target:
      kind: DaemonSet
      name: piraeus-node
    patch: |
      spec:
        template:
          spec:
            containers:
            - name: drbd-reactor
              resources:
                requests:
                  cpu: 100m
                  memory: 64Mi
```

### 8.4 Storage Pool Configuration

```yaml
# linstornodeconnection.yaml
apiVersion: piraeus.io/v1
kind: LinstorNodeConnection
metadata:
  name: default-node-connection
spec:
  properties:
  - name: DrbdOptions/Net/protocol
    value: "C"
```

```yaml
# storagepool.yaml
apiVersion: piraeus.io/v1
kind: LinstorSatelliteConfiguration
metadata:
  name: storage-pool-config
spec:
  storagePools:
  - name: nvme-pool
    lvmThinPool:
      volumeGroup: drbd-vg
      thinPool: drbd-thin
    properties:
    - name: DrbdOptions/Disk/resync-rate
      value: "200M"
```

### 8.5 StorageClass for DRBD-Backed PVCs

```yaml
# storageclass-drbd.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: linstor-drbd-r2
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: linstor.csi.linbit.com
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
parameters:
  # Number of replicas (DRBD replication factor)
  linstor.csi.linbit.com/placementCount: "2"
  # DRBD synchronization protocol
  linstor.csi.linbit.com/replicationMode: "C"
  # Storage pool to use on each node
  linstor.csi.linbit.com/storagePool: nvme-pool
  # Filesystem
  csi.storage.k8s.io/fstype: xfs
  # Mount options
  csi.storage.k8s.io/node-stage-secret-name: linstor-client-secret
  csi.storage.k8s.io/node-stage-secret-namespace: linstor
  # Place replicas on different nodes
  linstor.csi.linbit.com/autoPlace: "2"
  linstor.csi.linbit.com/allowRemoteVolumeAccess: "false"
---
# Three-replica StorageClass for critical databases
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: linstor-drbd-r3
provisioner: linstor.csi.linbit.com
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
parameters:
  linstor.csi.linbit.com/placementCount: "3"
  linstor.csi.linbit.com/replicationMode: "C"
  linstor.csi.linbit.com/storagePool: nvme-pool
  csi.storage.k8s.io/fstype: xfs
```

### 8.6 StatefulSet with DRBD-Backed Storage

```yaml
# postgres-statefulset-drbd.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-ha
  namespace: databases
spec:
  serviceName: postgres-ha
  replicas: 2
  selector:
    matchLabels:
      app: postgres-ha
  template:
    metadata:
      labels:
        app: postgres-ha
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values: ["postgres-ha"]
            topologyKey: kubernetes.io/hostname
      containers:
      - name: postgres
        image: postgres:16.2
        env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        resources:
          requests:
            memory: 16Gi
            cpu: "4"
          limits:
            memory: 16Gi
            cpu: "8"
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: linstor-drbd-r2
      resources:
        requests:
          storage: 500Gi
```

## Section 9: Performance Tuning

### 9.1 Replication Network Tuning

```bash
# Tune TCP buffers on the replication interface
# Add to /etc/sysctl.d/99-drbd.conf:
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
net.ipv4.tcp_rmem = 4096 87380 268435456
net.ipv4.tcp_wmem = 4096 65536 268435456
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_window_scaling = 1
net.core.netdev_max_backlog = 5000

# For 25GbE or 100GbE replication:
net.core.rmem_max = 4294967296
net.core.wmem_max = 4294967296

sysctl -p /etc/sysctl.d/99-drbd.conf

# Verify throughput with iperf3:
# On secondary: iperf3 -s
# On primary:   iperf3 -c 10.10.1.12 -t 30 -P 4
# Target: > 8 Gbps on 10GbE
```

### 9.2 DRBD Activity Log and Bitmap Tuning

```bash
# Larger activity log = faster recovery after unclean shutdown
# But: more data to resync if both nodes crash simultaneously
# al-extents: each extent covers 4MB, so 6433 extents = ~25GB tracked
# For large NVMe drives: increase to 65536 (256GB tracked)

# Edit resource file:
# disk {
#     al-extents 65536;
# }

# After changing al-extents, you must recreate metadata:
# (This destroys existing data - do this on a new resource before first sync)
drbdadm down pg-data
drbdadm create-md --al-stripes 1 --al-stripe-size-kB 32 pg-data
drbdadm up pg-data
```

### 9.3 CPU and I/O Priority for DRBD

```bash
# DRBD's internal resync should not starve application I/O
# Set lower I/O priority for resync operations

# Check current resync rate
cat /proc/drbd | grep speed

# Limit resync rate during business hours:
drbdadm disk-options --resync-rate=50M pg-data  # 50 MB/s during business hours

# Restore full speed at night:
drbdadm disk-options --resync-rate=500M pg-data

# Schedule with cron:
# 08:00 weekdays: limit resync
echo "0 8 * * 1-5 root drbdadm disk-options --resync-rate=50M pg-data" \
  >> /etc/cron.d/drbd-resync-limit
# 20:00 weekdays: full speed
echo "0 20 * * 1-5 root drbdadm disk-options --resync-rate=500M pg-data" \
  >> /etc/cron.d/drbd-resync-limit
```

## Section 10: Monitoring and Alerting

### 10.1 Prometheus Exporter for DRBD

```bash
# Install drbd-reactor with Prometheus exporter
dnf install -y drbd-reactor

# /etc/drbd-reactor.d/prometheus.toml
[[promoter]]
# Prometheus exporter configuration is part of drbd-reactor

# Or use the standalone drbd_exporter:
# https://github.com/prometheus-community/drbd_exporter
docker run -d \
  --name drbd-exporter \
  -p 9913:9913 \
  -v /proc:/host/proc:ro \
  prometheus-community/drbd-exporter \
  --path.procfs=/host/proc
```

### 10.2 Prometheus Alerts

```yaml
# prometheus-drbd-rules.yaml
groups:
- name: drbd-alerts
  rules:
  - alert: DRBDNotConnected
    expr: drbd_connected == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "DRBD resource {{ $labels.resource }} on {{ $labels.host }} is not connected"
      description: "DRBD replication is disconnected. Check network between cluster nodes."

  - alert: DRBDNotUpToDate
    expr: drbd_disk_state{disk_state!="UpToDate"} == 1
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "DRBD disk {{ $labels.resource }} is not UpToDate on {{ $labels.host }}"
      description: "DRBD disk state is {{ $labels.disk_state }}. Resyncing or inconsistent."

  - alert: DRBDSplitBrain
    expr: drbd_split_brain == 1
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "DRBD split-brain detected for {{ $labels.resource }}"
      description: "IMMEDIATE ACTION REQUIRED: DRBD split-brain on {{ $labels.host }}. Manual resolution needed."

  - alert: DRBDResyncInProgress
    expr: drbd_out_of_sync_bytes > 0
    for: 30m
    labels:
      severity: info
    annotations:
      summary: "DRBD resync in progress for {{ $labels.resource }}"
      description: "{{ $value | humanize1024 }}B out of sync. Expected to complete soon."
```

### 10.3 Daily Health Check Script

```bash
#!/bin/bash
# drbd-healthcheck.sh — Daily DRBD health verification
# Run via cron: 0 6 * * * root /usr/local/bin/drbd-healthcheck.sh

set -euo pipefail
LOG=/var/log/drbd-healthcheck.log
exec >> "$LOG" 2>&1

echo "=== DRBD Health Check: $(date) ==="

# Check all resources
for RESOURCE in $(drbdadm status | grep "^[a-z]" | cut -d' ' -f1); do
    echo "--- Resource: $RESOURCE ---"
    STATUS=$(drbdadm status "$RESOURCE")
    echo "$STATUS"

    # Check for non-UpToDate disk state
    if echo "$STATUS" | grep -q "disk:Inconsistent\|disk:Outdated\|disk:Failed"; then
        echo "WARN: Resource $RESOURCE has non-healthy disk state"
        logger -t drbd-health "WARN: $RESOURCE disk state is unhealthy"
    fi

    # Check for disconnected state
    if echo "$STATUS" | grep -q "role:Unknown\|cs:Disconnecting\|cs:Unconnected"; then
        echo "WARN: Resource $RESOURCE appears disconnected from peer"
        logger -t drbd-health "WARN: $RESOURCE disconnected from peer"
    fi

    # Check split-brain
    if echo "$STATUS" | grep -qi "split.brain"; then
        echo "CRITICAL: Split-brain detected for $RESOURCE"
        logger -p user.crit -t drbd-health "CRITICAL: split-brain on $RESOURCE"
    fi
done

echo "=== Check complete ==="
```

## Summary

DRBD provides enterprise-grade block-level replication for Linux systems that need HA storage without shared hardware. The operational principles are:

1. **Use Protocol C** for databases — Protocol A and B risk data loss on failover.
2. **Always use a quorum mechanism** — three nodes (two data, one witness) or Pacemaker fencing to prevent split-brain.
3. **Configure Pacemaker** for automatic failover — manual failover in production is too slow and error-prone.
4. **Test failover** regularly with a known-good procedure. An untested failover plan is not a failover plan.
5. **Monitor disk states** — `Inconsistent`, `Outdated`, and `Disconnecting` states need immediate attention before they become split-brain.
6. **Tune resync rate** to prevent resync from impacting production I/O, but increase it at night to minimize the divergence window.

For Kubernetes environments, the LINSTOR/Piraeus operator provides the full DRBD feature set through a Kubernetes-native CSI driver, making DRBD-backed PVCs available alongside cloud-native storage for workloads that require synchronous replication without depending on cloud block storage services.
