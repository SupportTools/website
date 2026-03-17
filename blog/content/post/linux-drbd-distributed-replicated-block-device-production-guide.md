---
title: "Linux DRBD: Resource Configuration, Protocol Modes, Split-Brain Recovery, and Promotion Procedures"
date: 2032-02-28T00:00:00-05:00
draft: false
tags: ["DRBD", "Linux", "High Availability", "Storage", "Replication", "Pacemaker"]
categories:
- Linux
- High Availability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to DRBD (Distributed Replicated Block Device) covering resource configuration, synchronization protocol selection, split-brain detection and recovery, and safe node promotion procedures for high-availability storage."
more_link: "yes"
url: "/linux-drbd-distributed-replicated-block-device-production-guide/"
---

DRBD (Distributed Replicated Block Device) is the de facto standard for synchronous block-level replication in Linux high-availability clusters. It implements RAID-1 across the network at the block device level, making it transparent to filesystems and applications. Understanding DRBD's internals - its protocol modes, fence mechanisms, and split-brain recovery procedures - is essential for operating storage clusters where data integrity cannot be compromised even during network partition events.

<!--more-->

# Linux DRBD: Production Guide

## Architecture Overview

DRBD operates as a kernel module that creates virtual block devices (`/dev/drbdN`) mirrored in real time between two or more nodes. The "Primary" node actively serves I/O; the "Secondary" node receives all writes over the network and applies them to its local disk.

```
Node A (Primary)                    Node B (Secondary)
┌───────────────────┐               ┌───────────────────┐
│  Application      │               │                   │
│  (PostgreSQL, etc)│               │                   │
└────────┬──────────┘               └────────┬──────────┘
         │                                   │
┌────────┴──────────┐               ┌────────┴──────────┐
│  /dev/drbd0       │               │  /dev/drbd0       │
│  (Virtual device) │               │  (Virtual device) │
└────────┬──────────┘               └────────┬──────────┘
         │        ◄── DRBD Replication ──►   │
┌────────┴──────────┐               ┌────────┴──────────┐
│  /dev/sdb         │               │  /dev/sdb         │
│  (Physical disk)  │               │  (Physical disk)  │
└───────────────────┘               └───────────────────┘
```

## Section 1: Installation and Basic Configuration

### Package Installation

```bash
# RHEL/CentOS/AlmaLinux 9
dnf install drbd90-utils kmod-drbd90

# Debian/Ubuntu
apt-get install drbd-utils

# Load the kernel module
modprobe drbd

# Verify version
drbdadm --version
# Version: 9.26.x (api:2)

# Enable DRBD service (for legacy init)
systemctl enable drbd
```

### Disk Preparation

DRBD requires dedicated block devices or LVM logical volumes. Using LVM provides flexibility for snapshots and resizing.

```bash
# On both nodes: create PV and VG
pvcreate /dev/sdb
vgcreate drbd-vg /dev/sdb

# Create logical volumes for each DRBD resource
lvcreate -L 100G -n data-lv drbd-vg
lvcreate -L 10G  -n meta-lv drbd-vg  # dedicated metadata device (optional)

# Wipe any existing filesystem signatures
wipefs -a /dev/drbd-vg/data-lv

# Check that the device is suitable
drbdadm sh-dev all   # before resource config exists, use direct check:
dd if=/dev/zero of=/dev/drbd-vg/data-lv bs=1M count=10 status=progress
```

### DRBD 9 Resource Configuration

```bash
# /etc/drbd.d/global_common.conf
global {
    usage-count no;        # disable heartbeat to linbit
    udev-always-use-vnr;
}

common {
    handlers {
        pri-on-incon-degr    "/lib/drbd/notify-pri-on-incon-degr.sh; /lib/drbd/notify-emergency-reboot.sh; echo b > /proc/sysrq-trigger ; reboot -f";
        pri-lost-after-sb    "/lib/drbd/notify-pri-lost-after-sb.sh; /lib/drbd/notify-emergency-reboot.sh; echo b > /proc/sysrq-trigger ; reboot -f";
        local-io-error       "/lib/drbd/notify-io-error.sh; /lib/drbd/notify-emergency-shutdown.sh; echo o > /proc/sysrq-trigger ; halt -f";
        fence-peer           "/usr/lib/drbd/crm-fence-peer.9.sh";
        unfence-peer         "/usr/lib/drbd/crm-unfence-peer.sh";
        split-brain          "/lib/drbd/notify-split-brain.sh root";
        out-of-sync          "/lib/drbd/notify-out-of-sync.sh root";
    }

    startup {
        wfc-timeout    15;   # seconds to wait for peer at startup
        degr-wfc-timeout 60; # if peer not seen recently, wait less
        outdated-wfc-timeout 2;
        wait-after-sb 0;
    }

    options {
        auto-promote yes;  # DRBD 9: allow automatic promotion when Pacemaker releases resource
    }

    disk {
        on-io-error    detach;   # detach on local I/O error, don't panic
        fencing        resource-and-stonith;
    }

    net {
        # Protocol C for synchronous writes (safest, recommended for WAL/database)
        protocol C;

        cram-hmac-alg   sha256;
        shared-secret   "<replace-with-strong-secret>";

        # Connection timeouts
        timeout         60;
        connect-int     10;
        ping-int        10;
        ping-timeout    5;

        # Buffer sizes (tune for network bandwidth and latency)
        sndbuf-size     0;  # 0 = auto
        rcvbuf-size     0;

        # Limit write ordering to speed up resyncs
        after-sb-0pri   discard-zero-changes;
        after-sb-1pri   discard-secondary;
        after-sb-2pri   disconnect;  # requires manual intervention
    }

    syncer {
        rate            500M;    # resync bandwidth limit
        al-extents      3833;    # activity log extents (increase for busy devices)
        verify-alg      sha256;  # for online verify operations
    }
}
```

### Resource Definition

```bash
# /etc/drbd.d/r0.res
resource r0 {
    # Resource-level options override common
    options {
        quorum majority;          # DRBD 9: 3-node quorum prevents split-brain
        on-no-quorum io-error;    # or: suspend-io
    }

    disk {
        disk-flushes     yes;     # important for data integrity
        disk-barrier     yes;
        md-flushes       yes;
    }

    net {
        max-buffers      8000;
        max-epoch-size   8000;
        unplug-watermark 16;
    }

    # First node
    on node-a {
        device      /dev/drbd0 minor 0;
        disk        /dev/drbd-vg/data-lv;
        address     10.0.1.10:7789;
        # External metadata (more reliable, recommended)
        meta-disk   /dev/drbd-vg/meta-lv[0];
        # Or internal: meta-disk internal;
    }

    # Second node
    on node-b {
        device      /dev/drbd0 minor 0;
        disk        /dev/drbd-vg/data-lv;
        address     10.0.1.11:7789;
        meta-disk   /dev/drbd-vg/meta-lv[0];
    }
}
```

### Initial Setup Procedure

Run these commands in sequence on both nodes (except where noted):

```bash
# 1. Create metadata (on BOTH nodes)
drbdadm create-md r0
# You will be prompted to confirm overwriting any existing metadata

# 2. Load the resource (on BOTH nodes)
drbdadm up r0

# 3. Check state (should show Inconsistent/Inconsistent)
drbdadm status r0

# 4. Force ONE node to be primary and start initial full sync
# Run ONLY on node-a (the intended primary)
drbdadm -- --overwrite-data-of-peer primary r0

# 5. Watch sync progress
watch -n 2 'cat /proc/drbd'

# 6. Once sync completes, verify state
drbdadm status r0
# Should show: Primary/Secondary UpToDate/UpToDate

# 7. Create filesystem (only while Primary)
mkfs.xfs /dev/drbd0

# 8. Mount and verify
mkdir -p /mnt/drbd-data
mount /dev/drbd0 /mnt/drbd-data
df -h /mnt/drbd-data
```

## Section 2: Protocol Modes

DRBD supports three protocol modes with fundamentally different durability guarantees. Choosing the wrong protocol can result in data loss.

### Protocol A: Asynchronous Replication

```
Primary                     Secondary
  │ write complete            │
  │◄───────────────────────   │ (after local buffer flush)
  │                     TCP send queued
  │                           │ (data received later)
```

- Write completes as soon as data is written locally and handed to TCP
- Secondary may not have received data when write is acknowledged
- Risk: data loss equal to the contents of the TCP send buffer if primary crashes

```bash
# Use only for: geographically distant replication where latency is unacceptable
# Example: cross-datacenter async DR
net {
    protocol A;
}
```

### Protocol B: Memory-Synchronous Replication

```
Primary                     Secondary
  │                           │ ACK from secondary network buffer
  │◄───────────────────────   │ (data in secondary RAM, not yet on disk)
  │
  │ write complete
```

- Write completes when secondary has received data into its network buffer
- Risk: data loss if secondary crashes with unwritten buffer contents
- Common for: same-datacenter, LAN replication with adequate RAM

```bash
net {
    protocol B;
}
```

### Protocol C: Fully Synchronous Replication

```
Primary                     Secondary
  │                           │ ACK from secondary disk
  │◄───────────────────────   │ (data written to secondary disk)
  │
  │ write complete
```

- Write completes only when both nodes confirm disk write
- No data loss (except in simultaneous failure of both nodes)
- Performance impact: adds one network round-trip latency per write
- Required for: databases, financial data, any data where loss is unacceptable

```bash
# Protocol C is the default and recommended for all database workloads
net {
    protocol C;
    # Reduce latency with TCP_CORK optimization
    tcp-cork yes;
}
```

### Measuring Protocol C Latency Impact

```bash
# Measure synchronous write latency overhead
# Test 1: Local disk write speed
fio --name=drbd-latency --filename=/dev/drbd-vg/data-lv \
    --rw=randwrite --bs=4k --iodepth=1 --runtime=30 \
    --direct=1 --ioengine=sync --lat_percentiles=1 \
    --output-format=json | jq '.jobs[0].write.lat_ns'

# Test 2: DRBD device write speed (should show higher latency)
fio --name=drbd-latency --filename=/dev/drbd0 \
    --rw=randwrite --bs=4k --iodepth=1 --runtime=30 \
    --direct=1 --ioengine=sync --lat_percentiles=1 \
    --output-format=json | jq '.jobs[0].write.lat_ns'

# The difference is approximately one round-trip network latency
# For a 0.2ms LAN: Protocol C adds ~0.2ms per write
```

## Section 3: Split-Brain Detection and Recovery

Split-brain is the most dangerous DRBD failure mode. It occurs when both nodes assume Primary role simultaneously - typically due to a network partition. Both nodes continue accepting writes that the other does not receive.

### Preventing Split-Brain

The best strategy is prevention. Use fencing (STONITH) with Pacemaker to ensure only one node can be primary at any time.

```bash
# Configure split-brain handler
handlers {
    split-brain "/usr/local/bin/drbd-split-brain-notify.sh";
}

# Network configuration to reduce false positives
net {
    # Conservative timeouts
    timeout         60;    # 6 seconds
    ping-int        10;
    ping-timeout    5;

    # Split-brain recovery policies
    after-sb-0pri   discard-zero-changes;  # auto-recover if no primary
    after-sb-1pri   discard-secondary;     # discard secondary if one primary
    after-sb-2pri   disconnect;            # manual intervention required!
}
```

```bash
#!/bin/bash
# /usr/local/bin/drbd-split-brain-notify.sh
# Called by DRBD when split-brain is detected

RESOURCE="$1"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Log to syslog
logger -p daemon.alert "DRBD split-brain detected on resource ${RESOURCE} at ${TIMESTAMP}"

# Send alert (PagerDuty/Slack integration example)
curl -s -X POST "${ALERT_WEBHOOK_URL}" \
  -H "Content-Type: application/json" \
  -d "{
    \"summary\": \"DRBD split-brain on ${HOSTNAME}:${RESOURCE}\",
    \"severity\": \"critical\",
    \"timestamp\": \"${TIMESTAMP}\"
  }"

# Do NOT automatically attempt recovery - require human intervention
exit 0
```

### Detecting Split-Brain

```bash
# Check current state
drbdadm status r0

# Split-brain shows as:
# r0 role:Primary
#   disk:UpToDate
#   peer-node-id:1 connection:StandAlone  ← connection lost
#     volume:0 replication:Off peer-disk:DUnknown

# Syslog messages
dmesg | grep -i "split brain"
journalctl -k | grep -i drbd | grep -i "split"

# Detailed status
cat /proc/drbd
```

### Recovery Procedures

Recovery requires identifying which node has the "correct" data. This is a business decision: which node received more recent data that cannot be lost?

```bash
# SCENARIO A: Both nodes diverged, choose which node to keep
# Node to DISCARD (B) - its changes will be lost:

# On node-b (the node to discard):
drbdadm secondary r0
drbdadm disconnect r0
drbdadm -- --discard-my-data connect r0

# On node-a (the node to keep):
drbdadm connect r0

# Verify resync begins
watch drbdadm status r0


# SCENARIO B: One node has incomplete writes (crash scenario)
# Identify which node has more recent data
drbdadm status r0
# Look for "newer" vs "older" in pending changes

# On the node with incomplete data:
drbdadm invalidate-remote r0

# Then reconnect
drbdadm connect r0


# SCENARIO C: Automatic recovery failed, manual bitmap reset needed
# Use only when you are CERTAIN about which data to keep

# On the secondary (data to discard):
drbdadm secondary r0
drbdadm -- --overwrite-data-of-peer primary r0
# This will perform a full resync FROM this node, discarding remote changes
# Only use this if you are certain the peer has the wrong data
```

### Verifying Data Consistency After Recovery

```bash
# After resync completes, run online verify
drbdadm verify r0

# Monitor verification progress
watch 'cat /proc/drbd | grep verify'

# Verify completes when:
# rs-same-csum: N  rs-diff: 0  (no differences found)

# If differences found, examine them:
drbdadm status r0
# out-of-sync: N will show bytes that differ

# Log shows:
# DRBD r0: Online bit-map verification STARTED.
# DRBD r0: Online bit-map verification FINISHED. X blocks out of sync.

# For databases, always run fsck after recovery
# (only when unmounted or in single-user mode)
umount /mnt/drbd-data
fsck -n /dev/drbd0  # -n for check-only first
```

## Section 4: Node Promotion and Demotion

### Manual Promotion Procedure

```bash
# Safe promotion sequence:
# 1. Verify secondary is up-to-date
drbdadm status r0
# Must show: UpToDate on both nodes

# 2. Check no other primary exists
drbdadm role r0
# Should show: Secondary

# 3. Promote
drbdadm primary r0

# 4. Verify promotion
drbdadm role r0
# Should show: Primary

# 5. Mount the filesystem
mount /dev/drbd0 /mnt/drbd-data

# 6. Verify filesystem is clean
df -h /mnt/drbd-data
ls /mnt/drbd-data


# Safe demotion sequence (before taking node down):
# 1. Flush application writes
sync

# 2. Unmount filesystem
umount /mnt/drbd-data

# 3. Demote to secondary
drbdadm secondary r0

# 4. Verify demotion
drbdadm status r0
# Should show: Secondary/Secondary UpToDate/UpToDate

# 5. Now safe to stop DRBD or take node down
drbdadm down r0
```

### Automated Promotion with Pacemaker

```xml
<!-- Pacemaker CIB configuration for DRBD + filesystem HA -->
<cib>
  <configuration>
    <resources>
      <!-- DRBD resource -->
      <master id="ms_drbd_r0">
        <primitive id="p_drbd_r0" class="ocf" type="drbd" provider="linbit">
          <instance_attributes id="p_drbd_r0_params">
            <nvpair name="drbd_resource" value="r0"/>
          </instance_attributes>
          <operations>
            <op name="start"   interval="0"    timeout="240"/>
            <op name="promote" interval="0"    timeout="90"/>
            <op name="demote"  interval="0"    timeout="90"/>
            <op name="stop"    interval="0"    timeout="100"/>
            <op name="monitor" interval="10"   timeout="20"  role="Master"/>
            <op name="monitor" interval="20"   timeout="20"  role="Slave"/>
          </operations>
        </primitive>
        <meta_attributes id="ms_drbd_r0_meta">
          <nvpair name="master-max"     value="1"/>
          <nvpair name="master-node-max" value="1"/>
          <nvpair name="clone-max"      value="2"/>
          <nvpair name="clone-node-max" value="1"/>
          <nvpair name="notify"         value="true"/>
        </meta_attributes>
      </master>

      <!-- Filesystem resource (depends on DRBD being Master) -->
      <primitive id="p_fs_r0" class="ocf" type="Filesystem" provider="heartbeat">
        <instance_attributes id="p_fs_r0_params">
          <nvpair name="device"    value="/dev/drbd0"/>
          <nvpair name="directory" value="/mnt/drbd-data"/>
          <nvpair name="fstype"    value="xfs"/>
          <nvpair name="options"   value="noatime,nodiratime"/>
        </instance_attributes>
        <operations>
          <op name="start"   interval="0"  timeout="60"/>
          <op name="stop"    interval="0"  timeout="60"/>
          <op name="monitor" interval="30" timeout="30"/>
        </operations>
      </primitive>

      <!-- Application resource (PostgreSQL example) -->
      <primitive id="p_postgresql" class="ocf" type="pgsql" provider="heartbeat">
        <instance_attributes id="p_postgresql_params">
          <nvpair name="pgdata" value="/mnt/drbd-data/pgdata"/>
          <nvpair name="start_opt" value="-p 5432"/>
        </instance_attributes>
      </primitive>

      <!-- Floating IP for application access -->
      <primitive id="p_vip_pg" class="ocf" type="IPaddr2" provider="heartbeat">
        <instance_attributes id="p_vip_pg_params">
          <nvpair name="ip"           value="10.0.1.100"/>
          <nvpair name="cidr_netmask" value="24"/>
        </instance_attributes>
      </primitive>

      <!-- Resource group: filesystem + app + VIP co-locate -->
      <group id="g_postgresql">
        <primitive_ref id="p_fs_r0"/>
        <primitive_ref id="p_postgresql"/>
        <primitive_ref id="p_vip_pg"/>
      </group>
    </resources>

    <constraints>
      <!-- Filesystem must be on DRBD Master node -->
      <rsc_order id="o_drbd_before_fs"
                 first="ms_drbd_r0" first-action="promote"
                 then="g_postgresql" then-action="start"/>
      <rsc_colocation id="c_drbd_with_fs"
                      rsc="g_postgresql"
                      with-rsc="ms_drbd_r0"
                      with-rsc-role="Master"
                      score="INFINITY"/>
    </constraints>
  </configuration>
</cib>
```

```bash
# Load and verify CIB
crm_verify -L -V
crm configure show

# Trigger manual failover (for maintenance)
crm node standby node-a

# Verify failover completed
crm status

# Return node to active
crm node online node-a
```

## Section 5: Resync and Bandwidth Throttling

### Controlling Resync Speed

```bash
# Check current resync rate
drbdadm status r0
# Shows: sync'ed: XX% (XXXXXX/XXXXXXX)K delay:Xs

# Set maximum resync bandwidth (important: don't starve production I/O)
drbdadm syncer r0
# Adjust in /etc/drbd.d/r0.res:
syncer {
    rate 200M;    # 200 MB/s during business hours
}

# Dynamic adjustment without restart:
# (sets rate to 100MB/s for this session)
drbdsetup syncer r0 --resync-rate=100M

# See current activity log state
drbdsetup show r0

# Force online verification (non-destructive)
drbdadm verify r0

# Force full resync from primary (use when you know secondary is bad)
drbdadm invalidate r0  # on secondary, resync FROM primary
```

### Scheduled Resync Throttling

```bash
#!/bin/bash
# /usr/local/bin/drbd-resync-schedule.sh
# Run via cron to throttle resync during business hours

BUSINESS_HOURS_RATE="50M"   # conservative during production
OFF_HOURS_RATE="500M"       # fast during off-hours

HOUR=$(date +%H)

if [[ ${HOUR} -ge 8 && ${HOUR} -lt 20 ]]; then
    RATE="${BUSINESS_HOURS_RATE}"
else
    RATE="${OFF_HOURS_RATE}"
fi

for RESOURCE in $(drbdadm sh-resources all); do
    CURRENT_RATE=$(drbdsetup show "${RESOURCE}" 2>/dev/null | grep "resync-rate" | awk '{print $2}')
    if [[ "${CURRENT_RATE}" != "${RATE}" ]]; then
        drbdsetup syncer "${RESOURCE}" --resync-rate="${RATE}"
        logger "drbd-resync-schedule: set ${RESOURCE} resync rate to ${RATE}"
    fi
done
```

## Section 6: Monitoring and Alerting

### Prometheus Metrics Collection

DRBD ships with a Prometheus exporter in newer versions. For older setups, use a custom exporter:

```bash
#!/bin/bash
# /usr/local/bin/drbd-prometheus-exporter.sh
# Expose DRBD stats in Prometheus text format on port 9189

while true; do
    {
        echo "# HELP drbd_resource_role DRBD resource role (1=Primary, 0=Secondary)"
        echo "# TYPE drbd_resource_role gauge"

        echo "# HELP drbd_disk_state DRBD disk state (4=UpToDate, 0=Inconsistent)"
        echo "# TYPE drbd_disk_state gauge"

        echo "# HELP drbd_connection_state DRBD connection state"
        echo "# TYPE drbd_connection_state gauge"

        echo "# HELP drbd_replication_synced_percent Replication sync percentage"
        echo "# TYPE drbd_replication_synced_percent gauge"

        while IFS= read -r line; do
            if [[ "${line}" =~ ^[[:space:]]*([^[:space:]]+)[[:space:]]role:([^[:space:]]+) ]]; then
                RESOURCE="${BASH_REMATCH[1]}"
                ROLE="${BASH_REMATCH[2]}"
                ROLE_VAL=$([ "${ROLE}" = "Primary" ] && echo 1 || echo 0)
                echo "drbd_resource_role{resource=\"${RESOURCE}\"} ${ROLE_VAL}"
            fi
        done < <(drbdadm status all 2>/dev/null)

    } | nc -l -p 9189 -q 1 > /dev/null 2>&1

    sleep 1
done
```

### Key Metrics to Monitor

```bash
# Resource state monitoring script
#!/bin/bash
# drbd-health-check.sh

ALERT_HOOK="${DRBD_ALERT_WEBHOOK:-}"
EXIT_CODE=0

check_resource() {
    local resource="$1"
    local status

    status=$(drbdadm status "${resource}" 2>&1)

    # Check role
    if echo "${status}" | grep -q "role:Primary"; then
        echo "OK: ${resource} is Primary"
    else
        echo "INFO: ${resource} is Secondary"
    fi

    # Check disk state
    if echo "${status}" | grep -q "disk:UpToDate"; then
        echo "OK: ${resource} disk is UpToDate"
    elif echo "${status}" | grep -q "disk:Inconsistent"; then
        echo "WARN: ${resource} disk is Inconsistent (syncing)"
        EXIT_CODE=1
    elif echo "${status}" | grep -q "disk:Outdated"; then
        echo "CRIT: ${resource} disk is Outdated"
        EXIT_CODE=2
    elif echo "${status}" | grep -q "disk:Diskless"; then
        echo "CRIT: ${resource} disk is Diskless - I/O detached!"
        EXIT_CODE=2
    fi

    # Check connection
    if echo "${status}" | grep -q "replication:Established"; then
        echo "OK: ${resource} connection is Established"
    elif echo "${status}" | grep -q "replication:SyncSource\|replication:SyncTarget"; then
        SYNC_PCT=$(grep -oP 'done:\K[\d.]+' /proc/drbd 2>/dev/null || echo "unknown")
        echo "INFO: ${resource} is syncing (${SYNC_PCT}% done)"
    elif echo "${status}" | grep -q "connection:StandAlone"; then
        echo "CRIT: ${resource} is StandAlone - possible split-brain!"
        EXIT_CODE=2
    elif echo "${status}" | grep -q "connection:NetworkFailure"; then
        echo "CRIT: ${resource} has network failure"
        EXIT_CODE=2
    fi

    # Check for out-of-sync blocks
    local oos_bytes
    oos_bytes=$(echo "${status}" | grep -oP 'out-of-sync:\K\d+' || echo 0)
    if [[ "${oos_bytes}" -gt 0 ]]; then
        echo "WARN: ${resource} has ${oos_bytes} bytes out of sync"
    fi
}

for resource in $(drbdadm sh-resources all 2>/dev/null); do
    echo "=== Resource: ${resource} ==="
    check_resource "${resource}"
    echo ""
done

exit ${EXIT_CODE}
```

### Prometheus Alert Rules

```yaml
groups:
  - name: drbd
    rules:
      - alert: DRBDNotPrimary
        expr: drbd_resource_role == 0
        for: 5m
        labels:
          severity: info
        annotations:
          summary: "DRBD resource {{ $labels.resource }} is Secondary on {{ $labels.instance }}"

      - alert: DRBDDiskNotUpToDate
        expr: drbd_disk_state{state!="UpToDate"} != 4
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "DRBD disk not UpToDate on {{ $labels.instance }}"
          description: "Resource {{ $labels.resource }} disk state: {{ $labels.state }}"

      - alert: DRBDConnectionLost
        expr: drbd_connection_state{state!="Connected"} != 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "DRBD connection lost on {{ $labels.instance }}"
          description: "Resource {{ $labels.resource }} connection state: {{ $labels.state }}"

      - alert: DRBDSplitBrain
        expr: drbd_split_brain_total > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "DRBD split-brain detected"
          description: "Immediate manual intervention required"
```

## Section 7: Disk and Network Sizing

### Calculating Activity Log Size

The Activity Log (AL) tracks recently written regions. An undersized AL causes frequent full syncs after crashes.

```bash
# Formula: al-extents * 4MB = covered working set
# For a 20GB working set with 4K random writes:
# 20GB / 4MB = 5120 extents

# Set in syncer section:
syncer {
    al-extents 5120;
}

# Maximum supported: 6433 extents = ~25GB working set

# For large database with >25GB working set, use:
al-extents 6433;

# Check current AL state
drbdsetup show r0 | grep al-extents
```

### Network Requirements for Protocol C

```bash
# Calculate required network bandwidth for Protocol C
# Formula: required_bandwidth = max_write_IOPS * block_size
# For 100K IOPS at 4KB: 100000 * 4096 = 400MB/s minimum bandwidth

# Measure actual write bandwidth
fio --name=drbd-bw-test --filename=/dev/drbd0 \
    --rw=randwrite --bs=4k --iodepth=32 --runtime=60 \
    --direct=1 --ioengine=libaio \
    --output-format=json | jq '.jobs[0].write.bw'

# Verify network can sustain this with headroom
iperf3 -c node-b -t 30 -P 4 -i 5

# For dedicated replication network (strongly recommended):
# Use a separate NIC/VLAN for DRBD traffic
# Configure in resource:
on node-a {
    address 192.168.100.10:7789;  # dedicated replication network
}
```

## Section 8: Live Migration and Upgrades

### Rolling DRBD Version Upgrade

```bash
# 1. Verify current version on both nodes
drbdadm --version

# 2. Ensure cluster is healthy
drbdadm status all
crm status

# 3. Move all resources to node-b
crm node standby node-a

# 4. Wait for failover to complete
sleep 30
crm status  # verify all resources on node-b

# 5. Upgrade DRBD on node-a
dnf update kmod-drbd90 drbd90-utils

# 6. Reload kernel module (or reboot if required)
systemctl stop drbd
modprobe -r drbd
modprobe drbd
systemctl start drbd

# 7. Verify node-a DRBD comes up correctly
drbdadm up all
drbdadm status all
# Should show: Connected

# 8. Return node-a to service
crm node online node-a

# 9. Wait for stabilization
sleep 60
crm status

# 10. Repeat for node-b (swap roles first)
crm node standby node-b
# ... upgrade node-b ...
crm node online node-b
```

## Conclusion

DRBD provides reliable synchronous block-level replication when properly configured. The critical operational procedures are: always use Protocol C for databases, configure external metadata on a separate device for reliability, implement fencing via Pacemaker to prevent split-brain, and maintain the ability to execute recovery procedures under pressure by practicing them regularly on non-production clusters. Split-brain recovery requires making a deliberate choice about which data to keep, and that decision should be documented in your runbook before an incident occurs.
