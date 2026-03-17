---
title: "Linux Software RAID with mdadm: RAID 0/1/5/6/10, Chunk Size Tuning, Hot Spare Management, Degraded Array Recovery"
date: 2031-11-30T00:00:00-05:00
draft: false
tags: ["Linux", "RAID", "mdadm", "Storage", "System Administration", "Reliability", "Disk Management"]
categories:
- Linux
- Storage
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete mdadm guide for enterprise Linux systems: RAID level selection, chunk size optimization for workload type, hot spare configuration, monitoring, and step-by-step degraded array recovery procedures."
more_link: "yes"
url: "/linux-software-raid-mdadm-production-guide/"
---

Linux software RAID via `mdadm` remains the foundation for reliable local storage on bare-metal servers. It consistently outperforms hardware RAID cards on modern multi-core systems (no controller bottleneck), provides full visibility into all operations, and integrates natively with the kernel's block layer. This guide covers every level from RAID geometry through chunk size tuning for specific workloads to the operational procedures that keep arrays healthy through disk failures and kernel upgrades.

<!--more-->

# Linux Software RAID with mdadm: Production Engineering Guide

## RAID Level Selection Matrix

| RAID Level | Min Disks | Fault Tolerance | Read Speed | Write Speed | Usable Space | Use Case |
|-----------|-----------|-----------------|------------|-------------|--------------|----------|
| 0 | 2 | None | N×disk | N×disk | 100% | Scratch space, temp storage |
| 1 | 2 | N-1 failures | N×disk | 1×disk | 50% | Boot drives, OS volumes |
| 5 | 3 | 1 failure | (N-1)×disk | Degraded by parity | (N-1)/N | General purpose NAS |
| 6 | 4 | 2 failures | (N-2)×disk | More degraded | (N-2)/N | Long rebuild times, many disks |
| 10 | 4 | 1 per mirror | N/2×disk | N/2×disk | 50% | Databases, high I/O |

## Section 1: Creating RAID Arrays

### Prerequisites and Disk Preparation

```bash
# Identify available disks
lsblk -d -o NAME,SIZE,MODEL,ROTA,TRAN
# ROTA=1 means spinning disk, ROTA=0 means SSD/NVMe
# TRAN shows SATA/NVMe/USB

# Wipe existing superblocks (CRITICAL: use the correct disk names)
for disk in /dev/sdb /dev/sdc /dev/sdd /dev/sde; do
    wipefs -a "$disk"
    sgdisk --zap-all "$disk"
done

# Verify disks are clean
for disk in /dev/sdb /dev/sdc /dev/sdd /dev/sde; do
    mdadm --examine "$disk" 2>&1 && echo "WARNING: $disk has RAID superblock" || echo "OK: $disk is clean"
done
```

### RAID 1 (Mirror)

```bash
# Create RAID 1 with 2 disks and 1 hot spare
mdadm --create /dev/md0 \
  --level=1 \
  --raid-devices=2 \
  --spare-devices=1 \
  --chunk=512 \          # For RAID1, chunk size is ignored but still valid to specify
  --metadata=1.2 \       # Use metadata version 1.2 (modern, supports >2TB)
  /dev/sdb /dev/sdc /dev/sdd

# Monitor build progress
watch -n2 'cat /proc/mdstat'
# Expected output:
# md0 : active raid1 sdd[2](S) sdc[1] sdb[0]
#       976773168 blocks super 1.2 [2/2] [UU]
#       [====>................]  resync = 22.3% (217984000/976773168) finish=45.2min speed=285M/sec
```

### RAID 5

```bash
# RAID 5 with 4+1 config (4 data + 1 parity, 1 hot spare)
mdadm --create /dev/md1 \
  --level=5 \
  --raid-devices=4 \
  --spare-devices=1 \
  --chunk=512 \           # 512K chunk for sequential workloads
  --layout=left-symmetric \  # Best for most workloads
  --metadata=1.2 \
  /dev/sdb /dev/sdc /dev/sdd /dev/sde /dev/sdf

# RAID 5 layouts:
# left-symmetric (ls): default, good for most workloads
# right-symmetric (rs): some benchmarks show minor improvement with some controllers
# left-asymmetric (la): older default, not recommended
```

### RAID 6

```bash
# RAID 6 with 6 data drives (tolerates 2 simultaneous failures)
mdadm --create /dev/md2 \
  --level=6 \
  --raid-devices=6 \
  --chunk=512 \
  --metadata=1.2 \
  /dev/sdb /dev/sdc /dev/sdd /dev/sde /dev/sdf /dev/sdg
```

### RAID 10

```bash
# RAID 10: two options
# Option A: near2 layout (default) - each chunk mirrored to adjacent disk
# Option B: far2 layout - chunks spread further apart (better sequential read)

# RAID 10 near2 (default, best write performance)
mdadm --create /dev/md3 \
  --level=10 \
  --raid-devices=4 \
  --layout=n2 \           # n=near, 2=number of copies
  --chunk=512 \
  --metadata=1.2 \
  /dev/sdb /dev/sdc /dev/sdd /dev/sde

# RAID 10 far2 (better read performance for sequential workloads)
mdadm --create /dev/md4 \
  --level=10 \
  --raid-devices=4 \
  --layout=f2 \
  --chunk=512 \
  --metadata=1.2 \
  /dev/sdb /dev/sdc /dev/sdd /dev/sde
```

## Section 2: Chunk Size Tuning

### What Chunk Size Controls

For RAID 5/6/10, chunk size determines how data is striped across member disks:

```
Stripe width = chunk_size × number_of_data_disks

RAID 5 (4 data disks + 1 parity), chunk=512K:
  Stripe width = 512K × 4 = 2MB
  One full stripe write = 2MB of data + 1×512K parity write
```

### Chunk Size by Workload

**Sequential Workload (Backups, Video Streaming, Large Files):**

```bash
# Large chunk size = fewer seek operations per large sequential I/O
# Optimal: 512K-1024K
mdadm --create /dev/md5 \
  --level=5 \
  --raid-devices=4 \
  --chunk=1024 \     # 1MB chunk
  --metadata=1.2 \
  /dev/sd{b,c,d,e}

# Filesystem alignment: stripe width for mkfs.xfs
# stripe_unit = chunk_size, stripe_width = chunk_size × data_disks
# For RAID5 with 4 disks and 1024K chunk:
mkfs.xfs -d su=1048576,sw=4 /dev/md5
```

**Random Small I/O Workload (Databases, Transactional):**

```bash
# Small chunk size = more parallelism for random I/O
# Optimal: 32K-128K for HDDs, 64K-256K for SSDs
mdadm --create /dev/md6 \
  --level=10 \
  --raid-devices=4 \
  --layout=n2 \
  --chunk=64 \       # 64K chunk
  --metadata=1.2 \
  /dev/nvme{0,1,2,3}n1

# Filesystem for database workload (align to chunk boundary)
mkfs.xfs -d su=65536,sw=2 /dev/md6    # RAID10 n2: sw=2 (2 data disks per stripe)
```

**Mixed Workload:**

```bash
# 256K is a reasonable all-purpose chunk size
mdadm --create /dev/md7 \
  --level=5 \
  --raid-devices=4 \
  --chunk=256 \
  --metadata=1.2 \
  /dev/sd{b,c,d,e}
```

### I/O Scheduler Tuning for RAID

```bash
# For HDDs in RAID: mq-deadline reduces seek time across parallel disks
for disk in sdb sdc sdd sde; do
    echo "mq-deadline" > "/sys/block/$disk/queue/scheduler"
    # Tune the scheduler
    echo 1 > "/sys/block/$disk/queue/iosched/front_merges"
    echo 64 > "/sys/block/$disk/queue/iosched/fifo_batch"
done

# For SSDs in RAID: none (no-op) or kyber
for disk in nvme0n1 nvme1n1; do
    echo "none" > "/sys/block/$disk/queue/scheduler"
done

# Set read-ahead for large sequential workloads
# RAID device read-ahead should match: chunk_size × num_data_disks
blockdev --setra 8192 /dev/md5     # 8192 × 512B = 4MB read-ahead

# Apply at boot via udev rule
cat > /etc/udev/rules.d/60-raid-readahead.rules << 'EOF'
KERNEL=="md*", ACTION=="add|change", RUN+="/sbin/blockdev --setra 8192 /dev/%k"
EOF
```

## Section 3: Persistent Configuration

### mdadm.conf Setup

```bash
# Generate mdadm.conf from currently running arrays
mdadm --detail --scan >> /etc/mdadm/mdadm.conf

# Verify content
cat /etc/mdadm/mdadm.conf
# Expected:
# ARRAY /dev/md0 metadata=1.2 name=myserver:0 UUID=12345678:87654321:abcdef01:23456789
# ARRAY /dev/md1 metadata=1.2 name=myserver:1 UUID=...

# Update initramfs to include mdadm.conf
update-initramfs -u
# On RHEL/CentOS:
dracut --force
```

### Filesystem Mount Optimization

```bash
# /etc/fstab entries with RAID-optimized mount options
cat >> /etc/fstab << 'EOF'
# RAID5 data array - XFS with RAID alignment
/dev/md1  /data/array1  xfs  defaults,noatime,nofail,x-systemd.device-timeout=10  0  0

# RAID10 database volume - XFS with strict ordering
/dev/md3  /var/lib/postgresql  xfs  defaults,noatime,nofail,logbsize=256k  0  0
EOF
```

## Section 4: Hot Spare Management

### Adding a Hot Spare

A hot spare is a disk member that is part of the array but not currently storing data. When a member disk fails, mdadm automatically starts rebuilding onto the hot spare.

```bash
# Add hot spare to existing array
mdadm /dev/md0 --add /dev/sde

# Verify spare added
mdadm --detail /dev/md0 | grep spare
# Expected:
# /dev/sde   3   -   0   spare   /dev/sde

# Check array detail
mdadm --detail /dev/md0
```

### Global Hot Spare (Shared Across Arrays)

```bash
# Create a spare that can be used by ANY array on this host
mdadm /dev/md0 --add-spare /dev/sdf
# For a global spare (shared): add to all arrays or use spare-group

# spare-group: disks in the same group are shared hot spares
mdadm --create /dev/md0 \
  --level=1 \
  --raid-devices=2 \
  --spare-devices=0 \
  --spare-group=pool1 \
  --metadata=1.2 \
  /dev/sdb /dev/sdc

mdadm --create /dev/md1 \
  --level=1 \
  --raid-devices=2 \
  --spare-devices=0 \
  --spare-group=pool1 \
  --metadata=1.2 \
  /dev/sdd /dev/sde

# Add global hot spare to the pool
mdadm --add --spare-group=pool1 /dev/md0 /dev/sdf
# Now /dev/sdf can be used by md0 OR md1 when either has a failure
```

### Spare Replacement After Rebuild

```bash
# After a spare has been promoted to active (rebuild completed),
# add a new disk to restore the hot spare pool

# Verify current state
mdadm --detail /dev/md0

# Mark failed disk as failed (if not auto-failed)
mdadm /dev/md0 --fail /dev/sdb

# Remove failed disk from array
mdadm /dev/md0 --remove /dev/sdb

# Physically replace the disk, then add new disk as spare
mdadm /dev/md0 --add /dev/sdb   # Using the same device path after physical replacement
```

## Section 5: Monitoring and Alerting

### mdmonitor Service

```bash
# /etc/mdadm/mdadm.conf - add monitoring configuration
cat >> /etc/mdadm/mdadm.conf << 'EOF'
# Alert destination
MAILADDR root@example.com
MAILFROM mdadm@$(hostname -f)

# Monitor daemon settings
PROGRAM /usr/local/bin/raid-alert.sh   # Custom alert script

# Auto-rebuild settings
AUTO +all
EOF

# Enable and start monitoring
systemctl enable --now mdmonitor

# Test alert (simulate array event)
mdadm --monitor --test /dev/md0
```

### Custom Alert Script

```bash
#!/bin/bash
# /usr/local/bin/raid-alert.sh
# Called by mdadm on events: SparesMissing, DegradedArray, RebuildStarted, etc.

EVENT="$1"
DEVICE="$2"
COMPONENT="$3"

WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"

log() {
    logger -t mdadm-alert "$@"
    echo "$(date -Iseconds) $*" >> /var/log/mdadm-events.log
}

send_alert() {
    local severity="$1"
    local message="$2"
    log "[$severity] $message"

    if [ -n "$WEBHOOK_URL" ]; then
        curl -s -X POST "$WEBHOOK_URL" \
          -H 'Content-type: application/json' \
          --data "{\"text\":\"[$severity] RAID Alert on $(hostname): $message\"}"
    fi
}

case "$EVENT" in
    Fail|FailSpare)
        send_alert "CRITICAL" "Disk FAILED: $COMPONENT in $DEVICE"
        ;;
    DegradedArray)
        # Get current array status
        STATUS=$(mdadm --detail "$DEVICE" 2>/dev/null | grep "State :")
        send_alert "WARNING" "Array DEGRADED: $DEVICE - $STATUS"
        ;;
    SparesMissing)
        send_alert "WARNING" "No hot spare available: $DEVICE - replace failed disk"
        ;;
    RebuildStarted)
        send_alert "INFO" "Rebuild started on $DEVICE using $COMPONENT"
        ;;
    RebuildFinished)
        send_alert "INFO" "Rebuild COMPLETED on $DEVICE"
        ;;
    DeviceDisappeared)
        send_alert "CRITICAL" "Device DISAPPEARED: $COMPONENT from $DEVICE - check hardware"
        ;;
    *)
        log "Unknown event: $EVENT $DEVICE $COMPONENT"
        ;;
esac
```

### Prometheus RAID Monitoring

```bash
# Install mdadm_exporter (or use node_exporter's diskstats + mdstat parsing)

# node_exporter includes textfile collector support
# Create mdstat metrics via script:

cat > /usr/local/bin/mdstat-metrics.sh << 'SCRIPT'
#!/bin/bash
# Generates Prometheus metrics from /proc/mdstat

OUTFILE="/var/lib/node_exporter/textfile_collector/mdstat.prom"
TMP="${OUTFILE}.tmp"

echo "# HELP mdstat_array_active Whether the RAID array is active (1=yes, 0=no)" > "$TMP"
echo "# TYPE mdstat_array_active gauge" >> "$TMP"
echo "# HELP mdstat_array_degraded Whether the RAID array is degraded (1=yes, 0=no)" >> "$TMP"
echo "# TYPE mdstat_array_degraded gauge" >> "$TMP"

while IFS= read -r line; do
    if [[ $line =~ ^(md[0-9]+) ]]; then
        ARRAY="${BASH_REMATCH[1]}"
        if echo "$line" | grep -q "active"; then
            echo "mdstat_array_active{array=\"$ARRAY\"} 1" >> "$TMP"
        else
            echo "mdstat_array_active{array=\"$ARRAY\"} 0" >> "$TMP"
        fi
        if mdadm --detail "/dev/$ARRAY" 2>/dev/null | grep -q "degraded"; then
            echo "mdstat_array_degraded{array=\"$ARRAY\"} 1" >> "$TMP"
        else
            echo "mdstat_array_degraded{array=\"$ARRAY\"} 0" >> "$TMP"
        fi
    fi
done < /proc/mdstat

mv "$TMP" "$OUTFILE"
SCRIPT

chmod +x /usr/local/bin/mdstat-metrics.sh

# Run every minute via cron
echo "* * * * * root /usr/local/bin/mdstat-metrics.sh" > /etc/cron.d/mdstat-metrics
```

## Section 6: Degraded Array Recovery

### Scenario 1: Single Disk Failure with Hot Spare

When a disk fails and a hot spare is present, mdadm automatically begins rebuilding. Monitor and verify:

```bash
# 1. Check array status
cat /proc/mdstat
# md0 : active raid5 sdc[2] sdd[1] sde[3](S) sdb[0](F)
#        976773120 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [_UU]
#        (2 spares, rebuilding from sde)

mdadm --detail /dev/md0

# 2. Monitor rebuild progress
watch -n5 'cat /proc/mdstat'

# 3. After rebuild completes, verify array is clean
mdadm --detail /dev/md0 | grep "State :"
# Should show: "State : clean"

# 4. Remove failed disk
mdadm /dev/md0 --fail /dev/sdb  # May already be failed
mdadm /dev/md0 --remove /dev/sdb

# 5. Add replacement disk as new hot spare
# (after physically replacing the failed disk)
mdadm /dev/md0 --add /dev/sdb
```

### Scenario 2: Single Disk Failure Without Hot Spare

```bash
# Array is degraded and has no spare
cat /proc/mdstat
# md1 : active raid5 sdb[0] sdd[1] sde[3]
#        1953523200 blocks super 1.2 level 5, 512k chunk [4/3] [U_UU]
# Note: [4/3] means 4 expected, 3 active

# 1. Identify failed disk (check dmesg and system logs)
journalctl -k --since="1 hour ago" | grep -E "sd[a-z]|error|I/O error" | head -30
dmesg | grep -E "I/O error|blk_update_request|exception" | tail -30

# 2. Physically replace the disk (server maintenance window)
# 3. Add new disk
mdadm /dev/md1 --add /dev/sdc

# 4. Monitor rebuild (RAID5 rebuild can take hours for large arrays)
watch -n10 'cat /proc/mdstat'

# 5. Speed up rebuild if I/O load allows
# Default: min_speed=1000 KB/s, max_speed determined by available I/O
echo 100000 > /sys/block/md1/md/sync_speed_min    # 100 MB/s minimum
echo 500000 > /sys/block/md1/md/sync_speed_max    # 500 MB/s maximum
# CAUTION: High sync speed impacts service performance
```

### Scenario 3: Two Disk Failures on RAID 6

RAID 6 can survive 2 simultaneous failures:

```bash
# Two disks failed
cat /proc/mdstat
# md2 : active raid6 sdb[0] sdd[2](F) sde[3] sdf[4](F) sdg[5]
#        [6/4] [UU__UU]  <- degraded, 2 disks missing

# Check which disks failed
mdadm --detail /dev/md2

# Verify data integrity before proceeding (read test)
dd if=/dev/md2 of=/dev/null bs=1M status=progress
# If this completes without errors, RAID6 is still serving data

# Replace both failed disks (can do simultaneously for RAID6)
mdadm /dev/md2 --fail /dev/sdd
mdadm /dev/md2 --fail /dev/sdf
mdadm /dev/md2 --remove /dev/sdd
mdadm /dev/md2 --remove /dev/sdf

# Add replacement disks
mdadm /dev/md2 --add /dev/sdd    # After physical replacement
mdadm /dev/md2 --add /dev/sdf

# Monitor dual rebuild
cat /proc/mdstat
```

### Scenario 4: Complete Array Recovery from Backup

When all disks survive but the array metadata is lost (e.g., `/dev/md` device file lost after kernel upgrade):

```bash
# 1. Check if disks have RAID superblocks
for disk in /dev/sd{b,c,d,e}; do
    echo "=== $disk ==="
    mdadm --examine "$disk" 2>&1 | head -20
done

# 2. Attempt automatic assembly
mdadm --assemble --scan

# 3. If scan fails, manually specify member disks
mdadm --assemble /dev/md0 /dev/sdb /dev/sdc /dev/sdd /dev/sde

# 4. If one disk is missing (force assemble with degraded array)
# WARNING: Only do this if you are certain the missing disk is truly gone
mdadm --assemble --force /dev/md0 /dev/sdb /dev/sdc /dev/sdd

# 5. After forced assembly, immediately check
mdadm --detail /dev/md0
# Mount as read-only first to assess data integrity
mount -o ro /dev/md0 /mnt/recovery
ls /mnt/recovery

# 6. If data looks intact, remount read-write
mount -o remount,rw /mnt/recovery
```

### Scenario 5: Recovering from Superblock Corruption

```bash
# Symptom: mdadm --assemble --scan fails with "no arrays found"
# but mdadm --examine /dev/sdb shows valid superblock

# Step 1: Examine all candidate disks
for disk in /dev/sd{b,c,d,e,f}; do
    echo "=== $disk ==="
    mdadm --examine "$disk" | grep -E "UUID|Events|Array|Raid"
done

# Group disks by UUID - disks with the same UUID belong to the same array
# UUID: 12345678:87654321:abcdef01:23456789

# Step 2: Manually assemble using member list
mdadm --assemble \
  --uuid=12345678:87654321:abcdef01:23456789 \
  /dev/md0 \
  /dev/sdb /dev/sdc /dev/sdd /dev/sde

# Step 3: If superblock on one disk is corrupt, stop and restart
mdadm --stop /dev/md0
mdadm --zero-superblock /dev/sdb  # Remove corrupt superblock from one disk

# Re-add the disk to the running array (will rebuild from other members)
mdadm /dev/md0 --add /dev/sdb
```

## Section 7: RAID Expansion

### Growing a RAID 5/6 Array

```bash
# Scenario: RAID5 with 4 disks → add 2 more disks

# Step 1: Add new disks
mdadm /dev/md1 --add /dev/sdf
mdadm /dev/md1 --add /dev/sdg
# At this point they are spares

# Step 2: Reshape to grow array (increases raid-devices count)
mdadm --grow /dev/md1 \
  --raid-devices=6 \       # 4 → 6 active devices
  --backup-file=/root/md1-reshape-backup

# The backup file protects critical data during reshape
# Keep it until reshape completes!

# Step 3: Monitor reshape (much slower than rebuild)
cat /proc/mdstat
# md1 : active raid5 sdg[6] sdf[5] sdb[0] sdc[1] sdd[2] sde[3]
#        reshape: 15.3% (148M/968M) finish=38.2min

# Step 4: After reshape, grow filesystem
# XFS: online resize (no unmount needed)
xfs_growfs /data/array1

# ext4: online resize
resize2fs /dev/md1
```

### Changing Chunk Size (Requires Reshape)

```bash
# This is destructive to ongoing I/O — do in maintenance window
# CRITICAL: Backup data first

mdadm --grow /dev/md1 \
  --chunk=1024 \            # Change from 512K to 1024K
  --backup-file=/root/md1-chunk-reshape

# Monitor
watch -n5 'cat /proc/mdstat'
```

## Section 8: Scrubbing and Health Verification

### Manual Scrub

```bash
# Trigger consistency check on all arrays
for array in $(ls /sys/block/ | grep ^md); do
    echo check > "/sys/block/$array/md/sync_action"
    echo "Started check on /dev/$array"
done

# Monitor
watch -n5 'grep -A2 "^md" /proc/mdstat'

# Check scrub results
cat /sys/block/md0/md/sync_completed
cat /sys/block/md0/md/mismatch_cnt     # Non-zero = data inconsistency!

# If mismatch_cnt > 0 on RAID5/6, repair (requires write)
echo repair > /sys/block/md0/md/sync_action
```

### Automated Weekly Scrub via Cron

```bash
cat > /etc/cron.weekly/mdadm-scrub << 'EOF'
#!/bin/bash
# Weekly RAID scrub - runs during off-peak hours
# The cron.weekly directory runs on system-default schedule (Sunday 00:00 typically)

# Limit scrub speed to reduce impact on services
echo 50000 > /sys/block/md0/md/sync_speed_max   # 50 MB/s max during scrub

for array in /dev/md*; do
    ARRAYNAME=$(basename "$array")
    logger -t mdadm-scrub "Starting weekly scrub on $array"
    echo check > "/sys/block/$ARRAYNAME/md/sync_action"
done

# After completion (will be triggered next run), check results
for array in /sys/block/md*; do
    MISMATCHES=$(cat "$array/md/mismatch_cnt" 2>/dev/null)
    if [ -n "$MISMATCHES" ] && [ "$MISMATCHES" -gt 0 ]; then
        logger -t mdadm-scrub "WARNING: Mismatches found on $array: $MISMATCHES blocks"
        # Send alert
        echo "RAID mismatch on $array: $MISMATCHES blocks" | \
          mail -s "RAID Mismatch Alert - $(hostname)" root@example.com
    fi
done
EOF

chmod +x /etc/cron.weekly/mdadm-scrub
```

## Section 9: Performance Benchmarking

### Baseline Measurements

```bash
#!/bin/bash
# benchmark-raid.sh - Benchmark RAID array performance

DEVICE=/dev/md0
TESTFILE=/dev/md0   # Direct device test (or use a file on mounted filesystem)

echo "=== Sequential Write ==="
dd if=/dev/zero of="$TESTFILE" bs=1M count=10240 oflag=direct 2>&1 | tail -1

echo "=== Sequential Read ==="
# Clear page cache first
echo 3 > /proc/sys/vm/drop_caches
dd if="$TESTFILE" of=/dev/null bs=1M count=10240 iflag=direct 2>&1 | tail -1

echo "=== Random Read (fio) ==="
fio --name=randread \
  --ioengine=libaio \
  --iodepth=32 \
  --rw=randread \
  --bs=4k \
  --direct=1 \
  --numjobs=4 \
  --size=4G \
  --filename="$TESTFILE" \
  --runtime=60 \
  --time_based \
  --group_reporting

echo "=== Random Write (fio) ==="
fio --name=randwrite \
  --ioengine=libaio \
  --iodepth=32 \
  --rw=randwrite \
  --bs=4k \
  --direct=1 \
  --numjobs=4 \
  --size=4G \
  --filename="$TESTFILE" \
  --runtime=60 \
  --time_based \
  --group_reporting
```

## Section 10: RAID with LUKS Encryption

For systems requiring both RAID and encryption, the correct stack is:

```
Physical Disks
     |
     v
RAID (md device)
     |
     v
LUKS (dm-crypt)
     |
     v
Filesystem (XFS/ext4)
```

RAID on top of LUKS (per-disk encryption) means each disk needs its own LUKS password at boot. LUKS on top of RAID means one password for the whole array.

```bash
# Create RAID first
mdadm --create /dev/md0 \
  --level=1 --raid-devices=2 --metadata=1.2 \
  /dev/sdb /dev/sdc

# Wait for initial sync
while cat /proc/mdstat | grep -q resync; do sleep 5; done

# Add LUKS layer on top of RAID
cryptsetup luksFormat --type luks2 \
  --cipher aes-xts-plain64 \
  --key-size 512 \
  --hash sha512 \
  --pbkdf argon2id \
  /dev/md0

# Open
cryptsetup luksOpen /dev/md0 data_encrypted

# Create filesystem on the decrypted device
mkfs.xfs /dev/mapper/data_encrypted

# Mount
mount /dev/mapper/data_encrypted /data

# /etc/crypttab for auto-unlock at boot
echo "data_encrypted /dev/md0 none luks,_netdev" >> /etc/crypttab
update-initramfs -u
```

## Conclusion

mdadm software RAID on Linux provides production-grade storage reliability with excellent performance characteristics and full operational transparency. The key operational principles covered here:

1. **Level selection**: RAID10 for databases and high-IOPS workloads; RAID6 for large capacity with double-failure tolerance; RAID5 for moderate capacity at lower cost.
2. **Chunk size**: Match to workload—512K-1024K for sequential, 32K-128K for random IOPS. Always align filesystem `su`/`sw` parameters to the RAID geometry.
3. **Hot spares**: Provision at least one per 5-10 member disks. Configure spare groups for shared spares across multiple arrays.
4. **Recovery procedures**: Understand the distinction between `--fail`, `--remove`, `--add`, and `--assemble --force`. Always have a backup before forced assembly.
5. **Monitoring**: `mdmonitor` + alert scripts + Prometheus metrics = full operational visibility. Weekly scrubs detect silent corruption before it propagates.

Combined with LUKS2 encryption where required, software RAID provides a complete, auditable, and high-performance storage foundation for enterprise Linux deployments.
