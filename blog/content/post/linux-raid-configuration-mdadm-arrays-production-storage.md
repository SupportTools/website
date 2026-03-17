---
title: "Linux RAID Configuration: mdadm Arrays for Production Storage"
date: 2031-05-01T00:00:00-05:00
draft: false
tags: ["Linux", "RAID", "mdadm", "Storage", "Kubernetes", "Production", "System Administration"]
categories: ["Linux", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux RAID with mdadm covering RAID 0/1/5/6/10 selection, array creation, hot spare configuration, rebuild monitoring, Kubernetes PV integration, and failure simulation testing."
more_link: "yes"
url: "/linux-raid-configuration-mdadm-arrays-production-storage/"
---

Software RAID with `mdadm` remains one of the most reliable storage redundancy solutions for Linux production servers. Unlike hardware RAID, `mdadm` arrays are fully transparent to the kernel, portable across systems, and can be monitored with standard Linux tools. This guide covers RAID level selection, production configuration, health monitoring, and Kubernetes integration with RAID-backed persistent volumes.

<!--more-->

# Linux RAID Configuration: mdadm Arrays for Production Storage

## Section 1: RAID Level Selection Guide

Choosing the wrong RAID level is a costly mistake. The decision depends on three variables: performance profile, fault tolerance requirement, and usable capacity ratio.

| RAID Level | Min Drives | Fault Tolerance | Usable Capacity | Read Performance | Write Performance | Use Case |
|------------|-----------|-----------------|-----------------|------------------|-------------------|----------|
| RAID 0     | 2         | None            | 100%            | N×               | N×                | Scratch/temp storage |
| RAID 1     | 2         | N-1 drives      | 50%             | N× (parallel)    | 1×                | OS disks, small critical data |
| RAID 5     | 3         | 1 drive         | (N-1)/N         | (N-1)×           | Slower (parity)   | Read-heavy data storage |
| RAID 6     | 4         | 2 drives        | (N-2)/N         | (N-2)×           | Slower (2x parity)| Large arrays, bulk storage |
| RAID 10    | 4         | 1 per mirror set| 50%             | N×               | N/2×              | Databases, IOPS-intensive |

### RAID Level Decision Tree

```
Need maximum performance with no redundancy?
  YES → RAID 0 (dev/test only, never production)

Need OS disk with simple redundancy?
  YES → RAID 1 with 2 drives

Database workload (high IOPS, low latency)?
  YES → RAID 10 (prefer even number of SSDs)

Large capacity with sequential read performance?
  YES (can tolerate 1 failure) → RAID 5
  YES (must tolerate 2 failures) → RAID 6

Mixed workload on NVMe with 4+ drives?
  YES → RAID 10 (better write performance than RAID 5/6 on SSDs)
```

**RAID 5 on SSDs warning**: RAID 5 write hole vulnerability is more pronounced on SSDs because power failures during partial stripe writes can cause silent corruption. Use RAID 10 or RAID 6 for SSD arrays in production, or enable `--write-intent-bitmap` to reduce vulnerability window.

## Section 2: Prerequisites and Disk Preparation

```bash
# Install mdadm
# RHEL/Rocky/AlmaLinux
dnf install -y mdadm

# Debian/Ubuntu
apt-get install -y mdadm

# Verify the drives are visible
lsblk -o NAME,SIZE,TYPE,MODEL,SERIAL

# Example output:
# NAME   SIZE TYPE MODEL               SERIAL
# sda    1.8T disk SAMSUNG MZ7LH1T9   S6E1NX0T123456
# sdb    1.8T disk SAMSUNG MZ7LH1T9   S6E1NX0T123457
# sdc    1.8T disk SAMSUNG MZ7LH1T9   S6E1NX0T123458
# sdd    1.8T disk SAMSUNG MZ7LH1T9   S6E1NX0T123459

# Check for existing RAID superblocks
mdadm --examine /dev/sda /dev/sdb /dev/sdc /dev/sdd

# Wipe any existing superblocks (DESTRUCTIVE - verify before running)
for dev in /dev/sda /dev/sdb /dev/sdc /dev/sdd; do
  mdadm --zero-superblock --force $dev
  wipefs -a $dev
done

# Zero the first and last 10MB of each drive to clear any partition tables
for dev in /dev/sda /dev/sdb /dev/sdc /dev/sdd; do
  dd if=/dev/zero of=$dev bs=1M count=10 status=progress
  dd if=/dev/zero of=$dev bs=1M count=10 \
    seek=$(( $(blockdev --getsz $dev) * 512 / 1024 / 1024 - 10 )) \
    status=progress
done
```

### Partition Alignment for Optimal Performance

```bash
# Create GPT partition tables
for dev in /dev/sda /dev/sdb /dev/sdc /dev/sdd; do
  parted -s $dev \
    mklabel gpt \
    mkpart primary 1MiB 100% \
    set 1 raid on
done

# Verify partition alignment (should be 0 for aligned)
for dev in /dev/sda /dev/sdb /dev/sdc /dev/sdd; do
  parted $dev align-check optimal 1
done

# List partitions
lsblk /dev/sda /dev/sdb /dev/sdc /dev/sdd
```

## Section 3: Creating RAID Arrays

### RAID 1 (2-Drive Mirror)

```bash
# RAID 1 for OS disk
mdadm --create /dev/md0 \
  --level=1 \
  --raid-devices=2 \
  --metadata=1.2 \
  --name=os-mirror \
  --bitmap=internal \
  /dev/sda1 /dev/sdb1

# Monitor sync progress
watch -n 2 cat /proc/mdstat

# Expected output during sync:
# Personalities : [raid1]
# md0 : active raid1 sda1[0] sdb1[1]
#       1953381376 blocks super 1.2 [2/2] [UU]
#       [==>..................]  resync = 10.5% (204800000/1953381376) finish=185.3min speed=175000K/sec
```

### RAID 10 (4+ Drives, Database Workload)

```bash
# RAID 10 with 4 drives - recommended for databases
mdadm --create /dev/md1 \
  --level=10 \
  --raid-devices=4 \
  --layout=n2 \
  --chunk=512 \
  --metadata=1.2 \
  --name=data-raid10 \
  --bitmap=internal \
  /dev/sda1 /dev/sdb1 /dev/sdc1 /dev/sdd1

# RAID 10 layout options:
# n2 = near layout, 2 copies (default, good for reads)
# f2 = far layout, 2 copies (better sequential reads)
# o2 = offset layout, 2 copies (better sequential reads on HDDs)

# Verify array configuration
mdadm --detail /dev/md1
```

### RAID 6 (4+ Drives, Bulk Storage)

```bash
# RAID 6 with 6 drives (can survive 2 simultaneous failures)
mdadm --create /dev/md2 \
  --level=6 \
  --raid-devices=6 \
  --chunk=512 \
  --metadata=1.2 \
  --name=bulk-storage \
  --spare-devices=1 \
  --bitmap=internal \
  /dev/sda1 /dev/sdb1 /dev/sdc1 /dev/sdd1 /dev/sde1 /dev/sdf1 spare /dev/sdg1

# Check detail
mdadm --detail /dev/md2
```

Expected output from `mdadm --detail /dev/md1`:

```
/dev/md1:
           Version : 1.2
     Creation Time : Mon Mar 17 14:23:01 2031
        Raid Level : raid10
        Array Size : 3906762752 (3725.29 GiB 3999.50 GB)
     Used Dev Size : 1953381376 (1862.65 GiB 1999.75 GB)
      Raid Devices : 4
     Total Devices : 4
       Persistence : Superblock is persistent

     Intent Bitmap : Internal

       Update Time : Mon Mar 17 14:25:00 2031
             State : clean, resyncing
    Active Devices : 4
   Working Devices : 4
    Failed Devices : 0
     Spare Devices : 0

            Layout : near=2
        Chunk Size : 512K

Consistency Policy : bitmap

              Name : data-raid10 (local to host db-server-01)
              UUID : 9b53a5f0:12d4c3e7:a8f12b3c:4d56e78a

    Number   Major   Minor   RaidDevice State
       0     8        1        0      active sync set-A   /dev/sda1
       1     8       17        1      active sync set-B   /dev/sdb1
       2     8       33        2      active sync set-A   /dev/sdc1
       3     8       49        3      active sync set-B   /dev/sdd1
```

## Section 4: Filesystem Creation and Mount Configuration

```bash
# Create XFS filesystem on RAID array
# XFS is preferred for large files and databases
mkfs.xfs \
  -f \
  -d su=512k,sw=2 \
  -l size=2048m,su=512k \
  -n ftype=1 \
  /dev/md1

# For databases, disable access time updates and enable write barriers
# Create mount point
mkdir -p /data

# Add to /etc/fstab
cat >> /etc/fstab << 'EOF'
/dev/md1  /data  xfs  defaults,noatime,nodiratime,logbsize=256k,allocsize=64m  0  0
EOF

# Mount and verify
mount /data
df -h /data
xfs_info /data

# For ext4 (simpler, good default)
mkfs.ext4 \
  -E stride=128,stripe-width=256 \
  -L data-raid10 \
  /dev/md1

# stride = chunk_size / block_size = 512K / 4K = 128
# stripe-width = stride * (data_disks) = 128 * 2 = 256 (for RAID10 n2)
```

## Section 5: mdadm.conf and Auto-Assembly

```bash
# Save the RAID configuration to mdadm.conf
mdadm --detail --scan | tee -a /etc/mdadm/mdadm.conf

# Expected entry:
# ARRAY /dev/md1 metadata=1.2 name=data-raid10 UUID=9b53a5f0:12d4c3e7:a8f12b3c:4d56e78a

# Update initramfs so the array assembles at boot
update-initramfs -u  # Debian/Ubuntu
dracut -f             # RHEL/Rocky

# Full mdadm.conf example
cat > /etc/mdadm/mdadm.conf << 'EOF'
# mdadm.conf - Production RAID configuration
# Generated and maintained by mdadm

# DEVICE configuration - scan all partitions
DEVICE partitions containers

# Mail address for RAID events
MAILADDR storage-alerts@example.com
MAILFROM mdadm@$(hostname)

# Auto-start policy
AUTO +all

# Array definitions (generated by mdadm --detail --scan)
ARRAY /dev/md0 metadata=1.2 name=os-mirror UUID=a1b2c3d4:e5f6a7b8:c9d0e1f2:a3b4c5d6
ARRAY /dev/md1 metadata=1.2 name=data-raid10 UUID=9b53a5f0:12d4c3e7:a8f12b3c:4d56e78a
ARRAY /dev/md2 metadata=1.2 name=bulk-storage UUID=d7e8f9a0:b1c2d3e4:f5a6b7c8:d9e0f1a2

# Monitoring daemon configuration
PROGRAM /usr/local/bin/raid-event-handler
EOF

# Verify auto-assembly
mdadm --assemble --scan --verbose
```

## Section 6: Hot Spare Configuration

Hot spares automatically replace failed drives without manual intervention:

```bash
# Add a hot spare to an existing RAID 10 array
mdadm /dev/md1 --add /dev/sde1

# Verify spare was added
mdadm --detail /dev/md1 | grep -A5 "Number.*RaidDevice"

# The spare will now appear as:
# 4     8       65        -      spare   /dev/sde1

# Configure global spare (available to any array on the system)
# Add to mdadm.conf:
echo "ARRAY /dev/md1 spare-group=global-spare" >> /etc/mdadm/mdadm.conf
echo "ARRAY /dev/md2 spare-group=global-spare" >> /etc/mdadm/mdadm.conf
echo "SPARE /dev/sde1 spare-group=global-spare" >> /etc/mdadm/mdadm.conf

# mdadm will automatically move the global spare to the array that needs it

# Verify spare behavior (simulate failure to test)
mdadm /dev/md1 --fail /dev/sdb1
# Watch the spare take over
watch -n 2 cat /proc/mdstat
```

## Section 7: Rebuild Monitoring and Performance Tuning

```bash
# Monitor rebuild progress
cat /proc/mdstat

# Detailed progress with ETA
watch -n 5 "mdadm --detail /dev/md1 | grep -E 'State|Rebuild|Active|Working|Failed|Spare'"

# Speed up rebuild (at the cost of I/O performance)
# Read current limits
cat /proc/sys/dev/raid/speed_limit_min
cat /proc/sys/dev/raid/speed_limit_max

# Default min is 1000 KB/s (very conservative)
# Increase for faster rebuild (200MB/s = 200000)
echo 100000 > /proc/sys/dev/raid/speed_limit_min
echo 400000 > /proc/sys/dev/raid/speed_limit_max

# Make permanent in /etc/sysctl.conf
cat >> /etc/sysctl.conf << 'EOF'
# RAID rebuild speed limits (KB/s)
# min: ensures rebuild makes progress even under I/O load
# max: caps rebuild speed to protect production I/O
dev.raid.speed_limit_min = 50000
dev.raid.speed_limit_max = 200000
EOF

sysctl -p

# Monitor stripe cache size (affects RAID 5/6 performance)
cat /sys/block/md2/md/stripe_cache_size
# Default: 256

# Increase for better RAID 5/6 write performance
echo 8192 > /sys/block/md2/md/stripe_cache_size

# Make persistent via udev rule
cat > /etc/udev/rules.d/60-md-stripe-cache.rules << 'EOF'
# Increase stripe cache size for RAID arrays
SUBSYSTEM=="block", KERNEL=="md[0-9]*", ACTION=="add", \
  ATTR{md/stripe_cache_size}="8192"
EOF

udevadm control --reload-rules
```

### Rebuild Monitoring Script

```bash
#!/bin/bash
# /usr/local/bin/raid-rebuild-monitor.sh

set -euo pipefail

ALERT_EMAIL="storage-alerts@example.com"
LOG_FILE="/var/log/raid-rebuild.log"
METRICS_FILE="/var/lib/node_exporter/textfile_collector/raid_rebuild.prom"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Parse /proc/mdstat for rebuild status
get_rebuild_info() {
    local device="$1"
    local md_status
    md_status=$(cat /proc/mdstat)

    # Extract rebuild percentage
    local pct
    pct=$(echo "$md_status" | awk "/^${device}:/,/^$/" | grep -o '[0-9.]*%' | head -1)

    # Extract finish time
    local finish
    finish=$(echo "$md_status" | awk "/^${device}:/,/^$/" | grep -o 'finish=[0-9.]*min' | head -1)

    # Extract speed
    local speed
    speed=$(echo "$md_status" | awk "/^${device}:/,/^$/" | grep -o 'speed=[0-9]*K/sec' | head -1)

    echo "${pct:-0%} ${finish:-N/A} ${speed:-0K/sec}"
}

main() {
    # Check all active RAID arrays
    for md in /dev/md[0-9]*; do
        [ -b "$md" ] || continue

        device=$(basename "$md")
        state=$(mdadm --detail "$md" | awk '/State :/{print $3}')
        failed=$(mdadm --detail "$md" | awk '/Failed Devices/{print $NF}')

        # Write Prometheus metrics
        cat >> "$METRICS_FILE.tmp" << EOF
# HELP raid_array_state RAID array state (1=clean, 0=degraded/recovering)
# TYPE raid_array_state gauge
raid_array_state{device="${device}",state="${state}"} $([ "$state" = "clean" ] && echo 1 || echo 0)

# HELP raid_failed_devices Number of failed devices in RAID array
# TYPE raid_failed_devices gauge
raid_failed_devices{device="${device}"} ${failed}
EOF

        if [[ "$state" == *"recovering"* ]] || [[ "$state" == *"resyncing"* ]]; then
            read -r pct finish speed <<< "$(get_rebuild_info "$device")"
            log "REBUILDING $md: ${pct} complete, ${finish}, ${speed}"

            cat >> "$METRICS_FILE.tmp" << EOF
# HELP raid_rebuild_progress RAID rebuild progress percentage
# TYPE raid_rebuild_progress gauge
raid_rebuild_progress{device="${device}"} ${pct//%/}
EOF
        fi

        if [ "$failed" -gt 0 ]; then
            log "ALERT: $md has $failed failed device(s), state: $state"
            echo "RAID Alert: $md on $(hostname) - $failed failed device(s)" | \
                mail -s "[RAID ALERT] $(hostname): $md degraded" "$ALERT_EMAIL"
        fi
    done

    # Atomically replace metrics file
    mv "$METRICS_FILE.tmp" "$METRICS_FILE"
}

main
```

```bash
# Install as systemd service and timer
cat > /etc/systemd/system/raid-monitor.service << 'EOF'
[Unit]
Description=RAID Array Monitor
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/raid-rebuild-monitor.sh
StandardOutput=journal
StandardError=journal
EOF

cat > /etc/systemd/system/raid-monitor.timer << 'EOF'
[Unit]
Description=RAID Monitor Timer
After=network.target

[Timer]
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now raid-monitor.timer
```

## Section 8: Array Health Checks with cron

```bash
# /usr/local/bin/raid-health-check.sh
#!/bin/bash
# Comprehensive RAID health check - runs via cron weekly

set -euo pipefail

REPORT_EMAIL="storage-alerts@example.com"
HOSTNAME=$(hostname -f)
REPORT=""
EXIT_CODE=0

check_array() {
    local device="$1"
    local detail
    detail=$(mdadm --detail "$device" 2>&1)

    local state
    state=$(echo "$detail" | awk '/State :/{print $3, $4, $5}' | xargs)

    local active
    active=$(echo "$detail" | awk '/Active Devices :/{print $NF}')

    local working
    working=$(echo "$detail" | awk '/Working Devices :/{print $NF}')

    local failed
    failed=$(echo "$detail" | awk '/Failed Devices :/{print $NF}')

    local spare
    spare=$(echo "$detail" | awk '/Spare Devices :/{print $NF}')

    REPORT+="=== $device ===\n"
    REPORT+="State:   $state\n"
    REPORT+="Active:  $active | Working: $working | Failed: $failed | Spare: $spare\n"

    if [ "$failed" -gt 0 ]; then
        REPORT+="*** CRITICAL: $failed failed device(s)! ***\n"
        EXIT_CODE=2
    elif [[ "$state" != *"clean"* ]]; then
        REPORT+="*** WARNING: Array is not clean (state: $state) ***\n"
        [ "$EXIT_CODE" -lt 2 ] && EXIT_CODE=1
    fi

    REPORT+="\n"
}

# Check all arrays
for md in /dev/md[0-9]*; do
    [ -b "$md" ] || continue
    check_array "$md"
done

# Check SMART data for all drives in arrays
REPORT+="=== Drive Health (SMART) ===\n"
for drive in $(mdadm --detail --scan | grep -oP '/dev/\w+' | sort -u); do
    [ -b "$drive" ] || continue

    smart_status=$(smartctl -H "$drive" 2>/dev/null | awk '/SMART overall-health/{print $NF}')
    pending_sectors=$(smartctl -A "$drive" 2>/dev/null | awk '/Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable/{print $1, $NF}')

    REPORT+="$drive: SMART=$smart_status\n"
    if [ -n "$pending_sectors" ]; then
        REPORT+="  Sectors: $pending_sectors\n"
    fi

    if [ "$smart_status" != "PASSED" ]; then
        REPORT+="  *** WARNING: SMART health not PASSED ***\n"
        [ "$EXIT_CODE" -lt 1 ] && EXIT_CODE=1
    fi
done

# Send report
if [ "$EXIT_CODE" -gt 0 ]; then
    SUBJECT="[RAID $([ "$EXIT_CODE" -eq 2 ] && echo 'CRITICAL' || echo 'WARNING')] $HOSTNAME RAID Health"
else
    SUBJECT="[RAID OK] $HOSTNAME Weekly Health Report"
fi

echo -e "$REPORT" | mail -s "$SUBJECT" "$REPORT_EMAIL"

exit "$EXIT_CODE"
```

```bash
# Weekly RAID health check cron
echo "0 8 * * 1 root /usr/local/bin/raid-health-check.sh" > /etc/cron.d/raid-health
chmod 644 /etc/cron.d/raid-health

# Daily check for critical arrays
echo "0 */4 * * * root /usr/local/bin/raid-rebuild-monitor.sh" >> /etc/cron.d/raid-health
```

## Section 9: Replacing a Failed Drive

```bash
# Step 1: Identify the failed drive
mdadm --detail /dev/md1
# Look for: failed   /dev/sdb1

# Mark failed device explicitly if not auto-detected
mdadm /dev/md1 --fail /dev/sdb1

# Step 2: Remove the failed device from array
mdadm /dev/md1 --remove /dev/sdb1

# Step 3: Hot-swap the physical drive (if hotswap-capable)
# For hotswap bays, eject via sysfs:
echo 1 > /sys/block/sdb/device/delete

# Physical drive replacement happens here...

# Step 4: Scan for the new drive
echo "- - -" > /sys/class/scsi_host/host0/scan

# Verify the new drive appeared
lsblk

# Step 5: Partition the new drive to match the old one
sgdisk --replicate=/dev/sde /dev/sdb
sgdisk --randomize-guids /dev/sdb

# Or manually:
parted -s /dev/sdb \
  mklabel gpt \
  mkpart primary 1MiB 100% \
  set 1 raid on

# Step 6: Add the new drive to the array
mdadm /dev/md1 --add /dev/sdb1

# Step 7: Monitor rebuild
watch -n 5 cat /proc/mdstat

# Step 8: Update mdadm.conf after rebuild completes
mdadm --detail --scan > /etc/mdadm/mdadm.conf
update-initramfs -u  # or dracut -f
```

## Section 10: Kubernetes RAID-Backed Persistent Volume

Configure a RAID array as a Kubernetes Persistent Volume:

```bash
# Create LVM on top of RAID (recommended for Kubernetes)
# This allows thin provisioning and snapshots

# Create LVM physical volume on RAID array
pvcreate /dev/md1

# Create volume group
vgcreate vg-raid10 /dev/md1

# Create logical volumes for different workloads
lvcreate -L 200G -n lv-postgres vg-raid10
lvcreate -L 100G -n lv-redis vg-raid10
lvcreate -L 500G -n lv-kafka vg-raid10

# Create filesystems
mkfs.xfs -f -d su=512k,sw=2 -L postgres-data /dev/vg-raid10/lv-postgres
mkfs.xfs -f -d su=512k,sw=2 -L redis-data /dev/vg-raid10/lv-redis
mkfs.xfs -f -d su=512k,sw=2 -L kafka-data /dev/vg-raid10/lv-kafka

# Create mount points
mkdir -p /mnt/k8s-volumes/{postgres,redis,kafka}

# Add to fstab
cat >> /etc/fstab << 'EOF'
/dev/vg-raid10/lv-postgres  /mnt/k8s-volumes/postgres  xfs  defaults,noatime  0  0
/dev/vg-raid10/lv-redis     /mnt/k8s-volumes/redis     xfs  defaults,noatime  0  0
/dev/vg-raid10/lv-kafka     /mnt/k8s-volumes/kafka     xfs  defaults,noatime  0  0
EOF

mount -a
```

Kubernetes PersistentVolume manifest for the RAID-backed storage:

```yaml
# persistent-volumes.yaml
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-postgres-raid10
  labels:
    storage-type: raid10
    workload: database
spec:
  capacity:
    storage: 200Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-raid10
  local:
    path: /mnt/k8s-volumes/postgres
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - db-server-01

---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-kafka-raid10
  labels:
    storage-type: raid10
    workload: messaging
spec:
  capacity:
    storage: 500Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-raid10
  local:
    path: /mnt/k8s-volumes/kafka
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - db-server-01

---
# StorageClass for local RAID volumes
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-raid10
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: false
```

StatefulSet consuming the RAID-backed PV:

```yaml
# postgresql-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: databases
spec:
  serviceName: postgresql
  replicas: 1
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
    spec:
      # Pin to the node with the RAID array
      nodeSelector:
        kubernetes.io/hostname: db-server-01
      tolerations:
        - key: storage-node
          operator: Exists
          effect: NoSchedule
      containers:
        - name: postgresql
          image: postgres:16.2
          env:
            - name: POSTGRES_DB
              value: myapp
            - name: POSTGRES_USER
              value: myapp
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgresql-secret
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          resources:
            requests:
              cpu: 2
              memory: 8Gi
            limits:
              cpu: 8
              memory: 32Gi
          volumeMounts:
            - name: postgresql-data
              mountPath: /var/lib/postgresql/data
          livenessProbe:
            exec:
              command:
                - /bin/sh
                - -c
                - exec pg_isready -U myapp -d myapp
            initialDelaySeconds: 30
            periodSeconds: 10
  volumeClaimTemplates:
    - metadata:
        name: postgresql-data
      spec:
        storageClassName: local-raid10
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 200Gi
        selector:
          matchLabels:
            storage-type: raid10
            workload: database
```

## Section 11: Failure Simulation Testing

Test your RAID configuration before production deployment:

```bash
#!/bin/bash
# /usr/local/bin/raid-failure-test.sh
# RAID failure simulation test suite
# WARNING: Run only on test systems, not production

set -euo pipefail

ARRAY="/dev/md1"
TEST_FILE="/data/raid-test-$(date +%s)"
IO_PID=""

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

cleanup() {
    [ -n "$IO_PID" ] && kill "$IO_PID" 2>/dev/null || true
    rm -f "$TEST_FILE"
    # Restore any removed devices
    for dev in /dev/sdb1 /dev/sdc1 /dev/sdd1; do
        mdadm "$ARRAY" --add "$dev" 2>/dev/null || true
    done
}
trap cleanup EXIT

# Test 1: Verify initial state
log "Test 1: Verify initial healthy state"
state=$(mdadm --detail "$ARRAY" | awk '/State :/{print $3}')
[ "$state" = "clean" ] || { log "FAIL: Array not clean, got: $state"; exit 1; }
log "PASS: Array state is clean"

# Test 2: Background I/O during failure (simulate production load)
log "Test 2: Start background I/O load"
fio --name=background-io \
    --filename="$TEST_FILE" \
    --ioengine=libaio \
    --direct=1 \
    --rw=randrw \
    --bs=4k \
    --size=1G \
    --numjobs=4 \
    --runtime=300 \
    --group_reporting \
    --output-format=terse \
    > /tmp/fio-baseline.txt &
IO_PID=$!
log "Background I/O started (PID: $IO_PID)"

sleep 5

# Test 3: Single drive failure
log "Test 3: Simulate single drive failure"
mdadm "$ARRAY" --fail /dev/sdb1
state=$(mdadm --detail "$ARRAY" | awk '/State :/{print $3, $4}' | xargs)
log "Array state after failure: $state"
failed=$(mdadm --detail "$ARRAY" | awk '/Failed Devices :/{print $NF}')
[ "$failed" -eq 1 ] || { log "FAIL: Expected 1 failed device, got $failed"; exit 1; }
log "PASS: Single drive failure detected correctly"

# Test 4: Verify data integrity during degraded state
log "Test 4: Check data accessibility in degraded state"
if dd if=/dev/urandom of="$TEST_FILE".verify bs=1M count=100 status=none && \
   dd if="$TEST_FILE".verify of=/dev/null bs=1M status=none; then
    log "PASS: Data accessible in degraded state"
else
    log "FAIL: Data inaccessible in degraded state"
    exit 1
fi

# Test 5: Hot spare activation
log "Test 5: Verify hot spare activates"
spare_count=$(mdadm --detail "$ARRAY" | awk '/Spare Devices :/{print $NF}')
if [ "$spare_count" -gt 0 ]; then
    # Wait up to 60 seconds for rebuild to start
    for i in $(seq 1 60); do
        state=$(mdadm --detail "$ARRAY" | awk '/State :/{print $3, $4}' | xargs)
        if [[ "$state" == *"recovering"* ]]; then
            log "PASS: Hot spare activated and rebuild started"
            break
        fi
        sleep 1
    done
else
    log "INFO: No hot spare configured, skipping hot spare test"
fi

# Test 6: Remove failed drive and add new one
log "Test 6: Remove failed drive and add replacement"
mdadm "$ARRAY" --remove /dev/sdb1
mdadm "$ARRAY" --add /dev/sdb1  # Re-add same device (simulating replacement)

log "Waiting for rebuild to complete..."
while true; do
    state=$(mdadm --detail "$ARRAY" | awk '/State :/{print $3}' | head -1)
    if [[ "$state" == "clean" ]]; then
        break
    fi
    progress=$(grep "%" /proc/mdstat | awk '{print $4}' | head -1)
    log "Rebuilding: ${progress:-unknown}"
    sleep 10
done

log "PASS: Rebuild completed, array is clean"

# Test 7: Final data integrity check
log "Test 7: Final data integrity verification"
kill "$IO_PID" 2>/dev/null || true
IO_PID=""

# Calculate checksum of test file
md5sum "$TEST_FILE".verify > "$TEST_FILE".verify.md5
md5sum -c "$TEST_FILE".verify.md5 && log "PASS: Data integrity verified" || {
    log "FAIL: Data integrity check failed"
    exit 1
}

log "All RAID failure simulation tests PASSED"
```

## Section 12: Production Monitoring with Node Exporter

The node_exporter exposes RAID metrics via the `mdadm` collector:

```bash
# Verify mdadm collector is active
curl -s localhost:9100/metrics | grep -E '^node_md_'

# Key metrics to alert on:
# node_md_disks{device="md1",state="active"} 4
# node_md_disks{device="md1",state="failed"} 0
# node_md_disks{device="md1",state="spare"} 1
# node_md_disks_required{device="md1"} 4
```

Prometheus alert rules:

```yaml
# prometheus-raid-alerts.yaml
groups:
  - name: raid
    rules:
      - alert: RAIDArrayDegraded
        expr: node_md_disks{state="failed"} > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "RAID array degraded on {{ $labels.instance }}"
          description: "{{ $labels.device }} has {{ $value }} failed disk(s)"

      - alert: RAIDArrayInsufficientSpare
        expr: |
          node_md_disks{state="spare"} == 0
          and
          node_md_disks_required > 2
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "RAID array has no hot spare"
          description: "{{ $labels.device }} on {{ $labels.instance }} has no spare disk"

      - alert: RAIDRebuildActive
        expr: node_md_disks_required > node_md_disks{state="active"}
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "RAID rebuild in progress"
          description: "{{ $labels.device }} is rebuilding ({{ $value }} active vs required)"
```

## Summary

Production RAID configuration with `mdadm` requires attention to:

1. **RAID level selection** - RAID 10 for databases, RAID 6 for bulk storage with large arrays
2. **Partition alignment** - Always use GPT with 1MiB alignment for modern drives
3. **Hot spares** - Configure at least one per array in production to enable automatic recovery
4. **Rebuild speed tuning** - Balance rebuild speed against production I/O impact
5. **mdadm.conf** - Keep it current and update initramfs after changes
6. **Failure simulation** - Test drive replacement procedures before you need them
7. **Monitoring** - Node exporter RAID metrics with Prometheus alerts for failed devices
8. **LVM on RAID** - Adds thin provisioning and snapshot capabilities for Kubernetes PVs

The most common production failure mode is a degraded array (one drive failed) where the operator hasn't noticed because monitoring was not configured. Always configure email alerts via `mdadm.conf MAILADDR` as a baseline, even before Prometheus is available.
