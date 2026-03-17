---
title: "Linux GFS2 Cluster Filesystem: DLM Lock Manager, Fencing Integration, Journal Recovery, and Performance Tuning"
date: 2032-03-02T00:00:00-05:00
draft: false
tags: ["GFS2", "Linux", "Cluster", "High Availability", "Pacemaker", "Storage", "DLM"]
categories:
- Linux
- High Availability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to GFS2 (Global Filesystem 2) covering DLM lock manager configuration, STONITH fencing integration with Pacemaker, journal recovery procedures, and performance tuning for shared-disk cluster filesystems."
more_link: "yes"
url: "/linux-gfs2-cluster-filesystem-dlm-fencing-journal-recovery/"
---

GFS2 (Global Filesystem 2) is the only cluster filesystem that ships in the mainline Linux kernel for use with shared block storage, such as SAN or iSCSI LUNs that multiple nodes access simultaneously. Unlike DRBD (which replicates block data over the network) or NFS (which adds a server layer), GFS2 gives all cluster nodes direct read/write access to the same physical storage with distributed lock management ensuring coherency. This architecture is essential for workloads that require active/active access to shared storage, such as RHCS clusters running Oracle RAC or high-availability web servers sharing a content tree.

<!--more-->

# Linux GFS2 Cluster Filesystem

## Architecture Overview

GFS2 combines three distinct systems:

1. **DLM (Distributed Lock Manager)**: Provides distributed locking so multiple nodes can coordinate access to shared filesystem metadata and data blocks.
2. **GFS2 Kernel Module**: The actual filesystem implementation, built on top of DLM.
3. **Fencing (STONITH)**: The critical safety mechanism that kills misbehaving nodes before allowing recovery, preventing data corruption from a node that "thinks" it still has locks.

```
Node A                          Node B
┌─────────────────┐             ┌─────────────────┐
│  Application    │             │  Application    │
├─────────────────┤             ├─────────────────┤
│  GFS2 (kernel)  │             │  GFS2 (kernel)  │
├─────────────────┤             ├─────────────────┤
│  DLM (kernel)   │◄──────────►│  DLM (kernel)   │
│                 │  TCP/IP     │                 │
└────────┬────────┘             └────────┬────────┘
         │                               │
         └───────────────┬───────────────┘
                         │ (Fibre Channel / iSCSI)
                ┌────────┴────────┐
                │  Shared Storage │
                │  (SAN / iSCSI)  │
                └─────────────────┘
```

## Section 1: Prerequisites and Installation

### Package Installation

```bash
# RHEL/CentOS/AlmaLinux 9
dnf install gfs2-utils dlm kmod-gfs2 corosync pacemaker pcs fence-agents-all

# Debian/Ubuntu (limited support, prefer RHEL for production GFS2)
apt-get install gfs2-utils dlm-controld corosync pacemaker

# Load required kernel modules
modprobe gfs2
modprobe dlm

# Verify modules are loaded
lsmod | grep -E "gfs2|dlm"
```

### Corosync Cluster Communication

GFS2 depends on Corosync for cluster membership and DLM communication. Configure Corosync first.

```bash
# /etc/corosync/corosync.conf
totem {
    version: 2
    cluster_name: gfs2-cluster
    transport: knet

    # Cryptographic authentication
    crypto_cipher: aes256
    crypto_hash: sha256

    # Interface configuration
    interface {
        ringnumber: 0
        bindnetaddr: 10.0.1.0       # cluster network
        mcastport: 5405
    }

    # Second ring for redundancy (recommended)
    interface {
        ringnumber: 1
        bindnetaddr: 10.0.2.0       # second cluster network
        mcastport: 5405
    }

    token: 3000         # 3 seconds before declaring node dead
    consensus: 3600
    join: 60
    max_messages: 20
}

quorum {
    provider: corosync_votequorum
    two_node: 1    # for 2-node cluster (removes need for 3rd node quorum)
    # For 3+ nodes:
    # expected_votes: 3
    # wait_for_all: 1
}

nodelist {
    node {
        ring0_addr: 10.0.1.10
        ring1_addr: 10.0.2.10
        nodeid: 1
        name: node-a
    }
    node {
        ring0_addr: 10.0.1.11
        ring1_addr: 10.0.2.11
        nodeid: 2
        name: node-b
    }
}

logging {
    to_logfile: yes
    logfile: /var/log/corosync/corosync.log
    to_syslog: yes
    debug: off
    logger_subsys {
        subsys: QUORUM
        debug: off
    }
}
```

```bash
# Start Corosync and verify cluster communication
systemctl enable --now corosync
corosync-cmapctl | grep members
corosync-quorumtool -s

# Expected output:
# Quorum information
# Date:             Mon Mar 01 12:00:00 2032
# Quorum provider:  corosync_votequorum
# Nodes:            2
# Node ID:          1
# Ring ID:          0/8
# Quorate:          Yes
```

## Section 2: DLM Configuration

### DLM Lockspace Management

The DLM lockspace for GFS2 is automatically managed by Pacemaker. For manual setups:

```bash
# /etc/dlm/dlm.conf
# DLM communication settings
DLM_CLUSTER_NAME=gfs2-cluster

# TCP port for DLM communication (default: 21064)
DLM_PORT=21064

# Protocol: tcp or sctp
DLM_PROTOCOL=tcp

# Debug logging (disable in production)
DLM_DEBUG=0

# Fencing configuration
DLM_FENCE_ENABLED=1
```

```bash
# Start DLM control daemon
systemctl enable --now dlm

# Verify DLM is running and has registered with Corosync
dlm_tool status
# Should show:
# kernel_version: 6.14.0-37
# cluster_name: gfs2-cluster
# status: Started

# Check lockspace membership
dlm_tool ls
# Shows all active lockspaces and their members
```

### DLM Lockspace Verification

```bash
# After mounting GFS2, verify the lockspace
dlm_tool ls

# Expected output for a 2-node cluster:
# name          gfs2-cluster:gfs2_vol
# id            0x8d7f6a3b
# flags         0x00000000
# change        2 members, node 1 added
# master        1
# nodes:
#   1 M  node-a
#   2    node-b

# Monitor DLM activity
dlm_tool dump | head -50

# Check for DLM errors
grep -i "dlm" /var/log/messages | grep -i "error\|fail" | tail -20
```

## Section 3: Fencing (STONITH) Configuration

Fencing is not optional for GFS2. Without reliable fencing, a node that loses communication but still has access to storage can corrupt the filesystem when the surviving node begins recovery. The Pacemaker term is STONITH (Shoot The Other Node In The Head).

### IPMI Fencing (Most Reliable)

```bash
# Configure IPMI/BMC fencing
pcs stonith create fence-node-a fence_ipmilan \
    ipaddr="10.0.10.10" \
    login="admin" \
    passwd="<fence-password>" \
    lanplus=1 \
    pcmk_host_list="node-a" \
    op monitor interval=60s

pcs stonith create fence-node-b fence_ipmilan \
    ipaddr="10.0.10.11" \
    login="admin" \
    passwd="<fence-password>" \
    lanplus=1 \
    pcmk_host_list="node-b" \
    op monitor interval=60s

# Verify fencing configuration
pcs stonith show

# Test fencing (non-destructive test)
fence_ipmilan -a 10.0.10.10 -l admin -p "<fence-password>" -L -o status

# Test actual fencing (WARNING: this will reset the node!)
# Only run in testing environments
# pcs stonith fence node-a
```

### AWS EC2 Fencing

```bash
# For AWS-hosted clusters
dnf install fence-agents-aws

pcs stonith create fence-node-a fence_aws \
    region="us-east-1" \
    access_key_id="<aws-access-key-id>" \
    secret_access_key="<aws-secret-key>" \
    pcmk_host_map="node-a:i-0abc123def456789a" \
    op monitor interval=60s
```

### VMware vCenter Fencing

```bash
pcs stonith create fence-node-a fence_vmware_rest \
    ip="vcenter.example.com" \
    username="svc-fencing@example.com" \
    password="<vcenter-password>" \
    ssl_insecure=1 \
    pcmk_host_map="node-a:vm-node-a" \
    op monitor interval=60s
```

### Verifying Fencing Works Before Proceeding

```bash
# This is a non-optional step before using GFS2 in production
# Fencing must work before you create the filesystem

# 1. Verify stonith is enabled
pcs property show stonith-enabled
# stonith-enabled: true (must be true)

# 2. Test fence agent (safe test)
stonith_admin -t fence-node-a --action=status

# 3. Verify fencing configuration is complete
pcs stonith show --full

# 4. Check for nodes without fencing assigned
pcs stonith level show

# Only proceed to GFS2 setup after fencing is verified
```

## Section 4: Creating GFS2 Filesystem

### Shared Device Setup

```bash
# On ONE node: identify and prepare the shared LUN
lsblk -f
# Confirm /dev/sdc is the shared LUN (same on both nodes)

# Verify the device is accessible on both nodes
# On node-a:
ls -la /dev/sdc
blockdev --getsize64 /dev/sdc

# On node-b (should see the same size):
blockdev --getsize64 /dev/sdc

# Create the GFS2 filesystem
# -p: lock protocol (lock_dlm for cluster, lock_nolock for single node)
# -t: cluster_name:lockspace_name
# -j: number of journals (one per node, plus extras for growth)
mkfs.gfs2 \
    -p lock_dlm \
    -t gfs2-cluster:gfs2-vol \
    -j 4 \
    -J 64 \
    -o spectator=0 \
    /dev/sdc

# Verify filesystem creation
gfs2_tool df /dev/sdc 2>/dev/null || \
  fsck.gfs2 -n /dev/sdc
```

### Mount the Filesystem

```bash
# Mount on node-a
mount -t gfs2 -o noatime,nodiratime /dev/sdc /mnt/gfs2-data

# Mount on node-b (simultaneously - this is the point of GFS2)
mount -t gfs2 -o noatime,nodiratime /dev/sdc /mnt/gfs2-data

# Verify both nodes have mounted
df -h /mnt/gfs2-data  # run on both nodes

# Check cluster state
gfs2_tool df /mnt/gfs2-data
# Shows: blocks, inodes, journal usage

# Verify DLM lockspace is active with both nodes
dlm_tool ls
```

### Pacemaker Resource for GFS2

```xml
<!-- Pacemaker CIB for GFS2 with DLM -->
<cib>
  <configuration>
    <cluster_property_set id="cluster-wide-properties">
      <nvpair id="stonith-enabled" name="stonith-enabled" value="true"/>
      <nvpair id="no-quorum-policy" name="no-quorum-policy" value="freeze"/>
    </cluster_property_set>

    <resources>
      <!-- DLM resource (cloned on all nodes) -->
      <clone id="cl-dlm">
        <primitive id="p-dlm" class="ocf" type="controld" provider="pacemaker">
          <operations>
            <op name="start"   interval="0"  timeout="90"/>
            <op name="stop"    interval="0"  timeout="100"/>
            <op name="monitor" interval="10" timeout="20"/>
          </operations>
        </primitive>
        <meta_attributes id="cl-dlm-meta">
          <nvpair name="interleave" value="true"/>
          <nvpair name="ordered"    value="true"/>
          <nvpair name="clone-max"  value="2"/>
        </meta_attributes>
      </clone>

      <!-- GFS2 filesystem resource (cloned on all nodes) -->
      <clone id="cl-gfs2">
        <primitive id="p-gfs2" class="ocf" type="Filesystem" provider="heartbeat">
          <instance_attributes id="p-gfs2-params">
            <nvpair name="device"    value="/dev/sdc"/>
            <nvpair name="directory" value="/mnt/gfs2-data"/>
            <nvpair name="fstype"    value="gfs2"/>
            <nvpair name="options"   value="noatime,nodiratime"/>
          </instance_attributes>
          <operations>
            <op name="start"   interval="0"  timeout="60"/>
            <op name="stop"    interval="0"  timeout="60"/>
            <op name="monitor" interval="30" timeout="30"/>
          </operations>
        </primitive>
        <meta_attributes id="cl-gfs2-meta">
          <nvpair name="interleave" value="true"/>
          <nvpair name="ordered"    value="true"/>
          <nvpair name="clone-max"  value="2"/>
        </meta_attributes>
      </clone>
    </resources>

    <constraints>
      <!-- GFS2 must start after DLM on each node -->
      <rsc_order id="o-dlm-before-gfs2"
                 first="cl-dlm" first-action="start"
                 then="cl-gfs2" then-action="start"
                 score="mandatory"/>
      <!-- GFS2 must co-locate with DLM -->
      <rsc_colocation id="c-gfs2-with-dlm"
                      rsc="cl-gfs2" rsc-role="Started"
                      with-rsc="cl-dlm" with-rsc-role="Started"
                      score="INFINITY"/>
    </constraints>
  </configuration>
</cib>
```

```bash
# Apply the CIB
pcs cluster cib gfs2-config.xml
pcs cluster cib-push gfs2-config.xml

# Verify resources start on all nodes
pcs status
# Expected:
# Clone Set: cl-dlm [p-dlm]
#     Started: [ node-a node-b ]
# Clone Set: cl-gfs2 [p-gfs2]
#     Started: [ node-a node-b ]
```

## Section 5: Journal Recovery

### Understanding GFS2 Journals

Each mounted GFS2 node uses a dedicated journal. When a node fails ungracefully (crash, fencing), its journal contains uncommitted transactions that must be replayed before the filesystem is consistent.

```bash
# List journals and their assignments
gfs2_tool journals /mnt/gfs2-data

# Output:
# journal0 - assigned to node-a (nodeid=1)
# journal1 - assigned to node-b (nodeid=2)
# journal2 - unassigned (available for new nodes)
# journal3 - unassigned

# Check journal status
gfs2_jabd -l /dev/sdc

# Manual journal recovery (when Pacemaker is not handling it)
# This runs automatically when a healthy node detects a crashed peer
# But you can trigger it manually:
gfs2_recovery /dev/sdc journal0
```

### Detecting Journal Recovery in Progress

```bash
# Check kernel messages for journal recovery events
dmesg | grep -i "gfs2"
# Look for:
# gfs2: recovery complete, journal0 replayed
# gfs2: journal0: recovery required

# Check /proc/fs/gfs2 for recovery status
ls /proc/fs/gfs2/
cat /proc/fs/gfs2/gfs2-cluster\:gfs2-vol/glocks | head -20

# Monitor journal recovery
watch 'cat /proc/fs/gfs2/gfs2-cluster:gfs2-vol/jstats'
```

### Forced Journal Recovery

When a node cannot automatically recover a peer's journal:

```bash
# 1. Unmount GFS2 from all remaining nodes
umount /mnt/gfs2-data  # on all active nodes

# 2. Run fsck.gfs2 on the raw device (only when all nodes have unmounted)
fsck.gfs2 -y /dev/sdc

# Typical output:
# GFS2 fsck version 3.3.1
# Found 2 journals
# Checking journal 0...
#   Journal 0: 64MB, 1024 blocks
#   Checking lock tree...
# Pass1: Checking inodes
# Pass2: Checking inodes
# ...
# All checks passed

# 3. Remount on all nodes
mount -t gfs2 -o noatime /dev/sdc /mnt/gfs2-data  # all nodes

# 4. Or let Pacemaker handle the remount
pcs resource restart cl-gfs2
```

### Online Journal Addition

When adding nodes, add journals without unmounting:

```bash
# Add 2 more journals for new nodes (filesystem stays mounted)
gfs2_grow -j 2 /mnt/gfs2-data

# Verify
gfs2_tool journals /mnt/gfs2-data
# Should now show journal2 and journal3 as unassigned
```

## Section 6: Performance Tuning

### Mount Options

```bash
# Production mount options
mount -t gfs2 \
    -o noatime,nodiratime,quota=off,data=writeback \
    /dev/sdc /mnt/gfs2-data

# Mount option descriptions:
# noatime,nodiratime: don't update access times (huge benefit for read-heavy workloads)
# quota=off:          disable quota enforcement (off by default)
# data=writeback:     don't journal data blocks (only journal metadata) - faster writes
#                     WARNING: data=writeback can lose data if system crashes during write
# data=ordered:       default - safer but slower
```

### Tuning /proc/fs/gfs2 Parameters

```bash
# View all tunable parameters
ls /proc/fs/gfs2/gfs2-cluster\:gfs2-vol/

# Demote interval: how quickly to release locks no longer needed
# Default: 0 (immediate). Higher = better performance, more stale data risk
echo 30 > /proc/fs/gfs2/gfs2-cluster\:gfs2-vol/demote_secs

# Statfs cache time (reduce cluster traffic from df/stat operations)
echo 30 > /proc/fs/gfs2/gfs2-cluster\:gfs2-vol/statfs_slow

# Lock dump interval for debugging (set to 0 in production)
echo 0 > /proc/fs/gfs2/gfs2-cluster\:gfs2-vol/lock_dump_secs

# Directory hash table prefetch
echo 2 > /proc/fs/gfs2/gfs2-cluster\:gfs2-vol/dir_hash_prefetch
```

### DLM Tuning

```bash
# DLM lockspace configuration
# View current DLM settings
dlm_tool dump_config

# Increase DLM thread pool for high-concurrency
echo 16 > /sys/kernel/config/dlm/gfs2-cluster:gfs2-vol/config/locktable_size

# Tune TCP buffer sizes for DLM communication
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.wmem_max=16777216
sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216"
sysctl -w net.ipv4.tcp_wmem="4096 87380 16777216"
```

### Filesystem-Level Tuning

```bash
# Adjust GFS2 journal size (larger journals = fewer checkpoints = faster sequential writes)
# This requires the filesystem to be created with adequate journal space
# Journal size tuning is done at mkfs time with -J flag (MB):
mkfs.gfs2 -p lock_dlm -t cluster:vol -j 4 -J 256 /dev/sdc
# -J 256: 256MB journals instead of default 128MB

# For workloads with large metadata operations (mass file creation):
mkfs.gfs2 -p lock_dlm -t cluster:vol -j 4 -J 512 \
    -b 4096 \     # 4K block size (default)
    -o statfs_quantum=0 \   # disable statfs caching (more accurate but slower)
    /dev/sdc

# Optimal block size by workload:
# 512-byte: not recommended (high overhead)
# 1024-byte: small files, many files
# 4096-byte: general purpose (default, recommended)
```

### Performance Monitoring

```bash
# GFS2 statistics
cat /proc/fs/gfs2/gfs2-cluster\:gfs2-vol/glocks \
  | awk '{print $1}' | sort | uniq -c | sort -rn | head

# Lock contention analysis
cat /proc/fs/gfs2/gfs2-cluster\:gfs2-vol/glocks | \
  awk '$5 > 0 {print $0}' | \
  head -20

# DLM statistics
dlm_tool stats

# Cluster network latency (critical for GFS2 performance)
ping -c 100 node-b | tail -3
# mdev (jitter) should be < 1ms for good GFS2 performance

# I/O statistics on shared device
iostat -x /dev/sdc 5

# GFS2 specific I/O metrics
cat /proc/fs/gfs2/gfs2-cluster\:gfs2-vol/sbstats
```

## Section 7: Monitoring and Alerting

### Health Check Script

```bash
#!/bin/bash
# gfs2-health-check.sh

GFS2_MOUNT="${GFS2_MOUNT:-/mnt/gfs2-data}"
EXIT_CODE=0

echo "=== GFS2 Health Check $(date) ==="

# 1. Check Corosync quorum
QUORATE=$(corosync-quorumtool -s 2>/dev/null | grep "Quorate" | awk '{print $2}')
if [[ "${QUORATE}" == "Yes" ]]; then
    echo "OK: Cluster is quorate"
else
    echo "CRIT: Cluster is NOT quorate!"
    EXIT_CODE=2
fi

# 2. Check node membership
NODE_COUNT=$(corosync-cmapctl -g runtime.totem.pg.mrp.rrp.0.members.count 2>/dev/null | \
    awk '{print $NF}')
EXPECTED_NODES=$(grep -c "^node {" /etc/corosync/corosync.conf 2>/dev/null || echo 2)
if [[ "${NODE_COUNT}" -eq "${EXPECTED_NODES}" ]]; then
    echo "OK: All ${NODE_COUNT} nodes are members"
else
    echo "WARN: Expected ${EXPECTED_NODES} nodes, found ${NODE_COUNT}"
    EXIT_CODE=1
fi

# 3. Check DLM lockspace
DLM_STATUS=$(dlm_tool status 2>&1 | grep "status" | awk '{print $2}')
if [[ "${DLM_STATUS}" == "Started" ]]; then
    echo "OK: DLM is started"
else
    echo "CRIT: DLM status: ${DLM_STATUS}"
    EXIT_CODE=2
fi

# 4. Check GFS2 mount
if mountpoint -q "${GFS2_MOUNT}"; then
    echo "OK: GFS2 is mounted at ${GFS2_MOUNT}"
else
    echo "CRIT: GFS2 is NOT mounted at ${GFS2_MOUNT}"
    EXIT_CODE=2
fi

# 5. Check for journal recovery in progress
RECOVERY=$(dmesg | tail -100 | grep -c "gfs2.*recovery")
if [[ "${RECOVERY}" -eq 0 ]]; then
    echo "OK: No journal recovery in progress"
else
    echo "WARN: ${RECOVERY} journal recovery events in recent dmesg"
    EXIT_CODE=1
fi

# 6. Check GFS2 lock contention
if mountpoint -q "${GFS2_MOUNT}"; then
    FS_NAME=$(grep "${GFS2_MOUNT}" /proc/mounts | awk '{print $1}' | \
        xargs -I{} gfs2_tool df {} 2>/dev/null | grep "SB lock" | head -1)

    LOCK_COUNT=$(cat /proc/fs/gfs2/*/glocks 2>/dev/null | wc -l)
    echo "INFO: ${LOCK_COUNT} active glocks"

    # Check for contested locks (waiting > 0)
    CONTESTED=$(cat /proc/fs/gfs2/*/glocks 2>/dev/null | \
        awk '$5 > 0' | wc -l)
    if [[ "${CONTESTED}" -gt 100 ]]; then
        echo "WARN: High lock contention: ${CONTESTED} contested glocks"
        EXIT_CODE=1
    fi
fi

# 7. Test write access (non-destructive)
TEST_FILE="${GFS2_MOUNT}/.health-check-$(hostname)-$$"
if touch "${TEST_FILE}" 2>/dev/null; then
    rm -f "${TEST_FILE}"
    echo "OK: Write access confirmed"
else
    echo "CRIT: Cannot write to ${GFS2_MOUNT}"
    EXIT_CODE=2
fi

exit ${EXIT_CODE}
```

### Pacemaker Resource Alerts

```yaml
groups:
  - name: gfs2
    rules:
      - alert: GFS2NotMounted
        expr: |
          up{job="node-exporter"} == 1
          unless
          node_filesystem_avail_bytes{fstype="gfs2"} > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "GFS2 filesystem not mounted on {{ $labels.instance }}"

      - alert: GFS2DiskAlmostFull
        expr: |
          node_filesystem_avail_bytes{fstype="gfs2"}
          /
          node_filesystem_size_bytes{fstype="gfs2"} < 0.10
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "GFS2 filesystem less than 10% free on {{ $labels.instance }}"

      - alert: ClusterNotQuorate
        expr: corosync_quorum_votes_quorate == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Corosync cluster has lost quorum on {{ $labels.instance }}"

      - alert: FencingAgentDown
        expr: |
          pacemaker_stonith_enabled == 1
          unless
          pacemaker_stonith_device_count > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "No fencing agents configured in Pacemaker"
```

## Section 8: Disaster Recovery Procedures

### Emergency Recovery Sequence

```bash
#!/bin/bash
# gfs2-emergency-recovery.sh
# Use when cluster fails and GFS2 needs forced recovery

# STEP 1: Stop all I/O and unmount on all remaining nodes
# (The failed node should already be fenced)

umount /mnt/gfs2-data
systemctl stop pacemaker corosync

# STEP 2: Verify the failed node is truly fenced
# (check IPMI/BMC that it's off, or ping confirms no response)
ping -c 3 node-b && echo "NODE-B IS STILL ALIVE - DO NOT PROCEED" && exit 1

# STEP 3: Run fsck on the raw device
# This clears the journal of the crashed node
fsck.gfs2 -y /dev/sdc 2>&1 | tee /var/log/gfs2-recovery.log

# Check fsck exit code
FSCK_EXIT=$?
if [[ ${FSCK_EXIT} -ne 0 ]]; then
    echo "fsck.gfs2 returned ${FSCK_EXIT} - manual inspection required"
    echo "Review /var/log/gfs2-recovery.log"
    exit 1
fi

# STEP 4: Restart cluster services on surviving node(s)
systemctl start corosync pacemaker

# STEP 5: Verify cluster state before mounting
sleep 10
pcs status

# STEP 6: Mount GFS2 (Pacemaker will handle this)
# OR manual mount:
mount -t gfs2 -o noatime /dev/sdc /mnt/gfs2-data

# STEP 7: Verify filesystem integrity
gfs2_tool df /mnt/gfs2-data
ls /mnt/gfs2-data  # should be accessible

echo "Recovery complete. Check /var/log/gfs2-recovery.log for details."
```

### Growing the Filesystem

```bash
# GFS2 can be grown online while mounted
# Step 1: Extend the underlying LUN (or LVM LV) on the SAN side
# Step 2: Rescan the device on all nodes
echo 1 > /sys/block/sdc/device/rescan
# Or: iscsiadm -m session -R (for iSCSI)

# Step 3: Grow GFS2 (run on any one node)
gfs2_grow /mnt/gfs2-data

# Verify new size
gfs2_tool df /mnt/gfs2-data
df -h /mnt/gfs2-data
```

## Conclusion

GFS2 enables active/active shared disk access in Linux clusters, but it demands careful operational procedures. The non-negotiables are: fencing that works before any GFS2 mount, a dedicated cluster network for DLM traffic, adequate journal size for your write workload, and regular testing of the recovery procedure in non-production environments. Journal recovery is automatic when Pacemaker handles it, but understanding how to trigger manual recovery and run fsck.gfs2 safely is essential knowledge for any team operating GFS2 in production. Performance tuning centers on reducing DLM contention through mount options, lock lease duration, and ensuring low-latency cluster communication.
