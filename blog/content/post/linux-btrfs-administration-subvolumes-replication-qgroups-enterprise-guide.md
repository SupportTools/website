---
title: "Linux Btrfs Administration: Subvolume Management, Send/Receive Replication, Qgroups, Balance, Scrub, and RAID Profiles"
date: 2032-02-15T00:00:00-05:00
draft: false
tags: ["Linux", "Btrfs", "Storage", "Filesystem", "RAID", "Backup"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to Btrfs filesystem administration covering subvolume hierarchies, send/receive for incremental replication, qgroup quotas, balance and defrag strategies, scrub scheduling, and choosing the right RAID profile."
more_link: "yes"
url: "/linux-btrfs-administration-subvolumes-replication-qgroups-enterprise-guide/"
---

Btrfs (B-tree filesystem) brings copy-on-write semantics, built-in RAID, transparent compression, online defrag, and atomic snapshots to Linux. Despite its power, many operations require precise sequencing to avoid data loss or performance degradation. This guide covers the full operational picture: subvolume layout design, incremental send/receive replication, qgroup quota enforcement, balance job tuning, scrub scheduling, and selecting RAID profiles for different workload types.

<!--more-->

# Linux Btrfs Administration: Enterprise Operations Guide

## Section 1: Filesystem Layout and Design Decisions

### Creating a Btrfs Filesystem

```bash
# Single device
mkfs.btrfs -L data /dev/sdb

# RAID1 across two devices (metadata and data both mirrored)
mkfs.btrfs -L data -d raid1 -m raid1 /dev/sdb /dev/sdc

# RAID10 across four devices
mkfs.btrfs -L data -d raid10 -m raid10 /dev/sdb /dev/sdc /dev/sdd /dev/sde

# With LZO compression enabled at format time
mkfs.btrfs -L data --features no-holes,free-space-tree /dev/sdb
```

Mount with optimal options for production:

```bash
# /etc/fstab entry
UUID=<filesystem-uuid> /data btrfs defaults,noatime,compress=zstd:3,space_cache=v2,autodefrag 0 0

# Mount manually
mount -o noatime,compress=zstd:3,space_cache=v2 /dev/sdb /data
```

Key mount options:
- `noatime`: skip access time updates — major performance gain for read-heavy workloads
- `compress=zstd:3`: transparent compression; level 3 is a good balance of ratio vs CPU
- `space_cache=v2`: use the newer, more efficient free-space cache tree
- `autodefrag`: background defragmentation for file workloads with many small writes

### Filesystem Information

```bash
# Filesystem-level summary
btrfs filesystem show /data
btrfs filesystem df /data
btrfs filesystem usage /data

# Detailed block group usage
btrfs filesystem usage -T /data

# Check kernel Btrfs version
btrfs version
uname -r
```

## Section 2: Subvolume Management

### Subvolume Hierarchy Design

Btrfs subvolumes are independent namespaces inside a single filesystem. Design a hierarchy that maps to your operational needs:

```
/data                      (filesystem root, rarely mounted directly)
├── @                      (root subvolume, e.g., OS root)
├── @home                  (user home directories)
├── @snapshots             (snapshot container — NOT a subvolume itself)
│   ├── @-YYYY-MM-DD       (snapshots of @)
│   └── @home-YYYY-MM-DD   (snapshots of @home)
├── @databases             (database data directory)
│   └── @pg-data           (PostgreSQL data)
├── @containers            (container storage)
└── @var-log               (log files — separate to exclude from OS snapshots)
```

Mount individual subvolumes via `subvol=` or `subvolid=`:

```bash
# /etc/fstab
UUID=<uuid> /               btrfs subvol=@,noatime,compress=zstd:3,space_cache=v2 0 0
UUID=<uuid> /home           btrfs subvol=@home,noatime,compress=zstd:3 0 0
UUID=<uuid> /var/log        btrfs subvol=@var-log,noatime,compress=zstd:3 0 0
UUID=<uuid> /data/databases btrfs subvol=@databases,noatime,nodatacow 0 0
```

Note `nodatacow` on the databases subvolume — this disables copy-on-write for that subvolume, which is essential for database files where CoW causes fragmentation and random I/O amplification. Compression is also automatically disabled when `nodatacow` is set.

### Creating and Deleting Subvolumes

```bash
# Create subvolumes (filesystem must be mounted)
btrfs subvolume create /data/@home
btrfs subvolume create /data/@databases
btrfs subvolume create /data/@pg-data

# List all subvolumes
btrfs subvolume list /data
btrfs subvolume list -t /data  # tabular format

# Show subvolume details
btrfs subvolume show /data/@home

# Delete a subvolume
btrfs subvolume delete /data/@old-subvolume
# Deletion is asynchronous; check background deletion progress:
btrfs subvolume list /data | grep DELETED
```

### Snapshots

```bash
# Read-only snapshot (required for send/receive)
btrfs subvolume snapshot -r /data/@ /data/@snapshots/@-$(date +%Y-%m-%d)

# Read-write snapshot (for writable clones)
btrfs subvolume snapshot /data/@ /data/@-clone

# List snapshots
btrfs subvolume list -s /data   # -s shows only snapshots

# Automated snapshot script
cat > /usr/local/bin/btrfs-snapshot.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail

MOUNT="/data"
SUBVOL="$1"
SNAP_DIR="${MOUNT}/@snapshots"
DATE=$(date +%Y-%m-%dT%H:%M:%S)
SNAP_NAME="${SUBVOL##*/}-${DATE}"

echo "Creating snapshot: ${SNAP_DIR}/${SNAP_NAME}"
btrfs subvolume snapshot -r "${MOUNT}/${SUBVOL}" "${SNAP_DIR}/${SNAP_NAME}"

# Prune: keep last 7 daily, 4 weekly, 12 monthly
find "${SNAP_DIR}" -maxdepth 1 -name "${SUBVOL##*/}-*" -type d | \
  sort -r | tail -n +366 | xargs -r btrfs subvolume delete
SCRIPT
chmod +x /usr/local/bin/btrfs-snapshot.sh

# Schedule via systemd timer (preferred over cron)
cat > /etc/systemd/system/btrfs-snapshot@.service << 'UNIT'
[Unit]
Description=Btrfs snapshot for %i
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/btrfs-snapshot.sh %i
UNIT

cat > /etc/systemd/system/btrfs-snapshot@.timer << 'UNIT'
[Unit]
Description=Btrfs snapshot timer for %i

[Timer]
OnCalendar=daily
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl enable --now "btrfs-snapshot@home.timer"
```

## Section 3: Send/Receive for Incremental Replication

`btrfs send` serializes a subvolume (or the diff between two snapshots) to a stream. `btrfs receive` applies that stream on the target. Together they provide efficient, incremental replication without block-level tools.

### Full Send

```bash
# On source: create a read-only snapshot
btrfs subvolume snapshot -r /data/@home \
  /data/@snapshots/@home-2032-02-15

# Send to remote host
btrfs send /data/@snapshots/@home-2032-02-15 | \
  ssh backup-host \
  "btrfs receive /backup/snapshots/"

# Send to local location
btrfs send /data/@snapshots/@home-2032-02-15 | \
  btrfs receive /backup/snapshots/
```

### Incremental Send

Incremental send only transmits the delta between the parent snapshot and the new snapshot. This is the key to efficient replication.

```bash
# Prerequisites:
# 1. The parent snapshot must exist on both source and destination
# 2. The parent snapshot must be read-only
# 3. The parent snapshot must be accessible to btrfs send via -p

# Create new snapshot
btrfs subvolume snapshot -r /data/@home \
  /data/@snapshots/@home-2032-02-16

# Incremental send (parent = yesterday's snapshot)
btrfs send \
  -p /data/@snapshots/@home-2032-02-15 \
  /data/@snapshots/@home-2032-02-16 | \
  ssh backup-host \
  "btrfs receive /backup/snapshots/"

# Verify on remote
ssh backup-host "btrfs subvolume list /backup/snapshots"
```

### Replication Script with Error Handling

```bash
#!/bin/bash
# /usr/local/bin/btrfs-replicate.sh
set -euo pipefail

REMOTE_HOST="${1:-backup-host}"
SRC_MOUNT="/data"
DST_MOUNT="/backup"
SUBVOL_NAME="@home"
SNAP_DIR="${SRC_MOUNT}/@snapshots"
REMOTE_SNAP_DIR="${DST_MOUNT}/snapshots"
DATE=$(date +%Y-%m-%d)
NEW_SNAP="${SNAP_DIR}/${SUBVOL_NAME}-${DATE}"

# Rotate: find the most recent snapshot on both ends
LATEST_LOCAL=$(btrfs subvolume list -s "${SRC_MOUNT}" | \
  grep "${SUBVOL_NAME}-" | \
  sort -k9 -r | \
  awk 'NR==2 {print $NF}')  # NR==2 = second-latest (skip the one we're about to create)

LATEST_REMOTE=$(ssh "${REMOTE_HOST}" \
  "btrfs subvolume list -s ${REMOTE_SNAP_DIR} | grep ${SUBVOL_NAME}- | sort -k9 -r | awk 'NR==1 {print \$NF}'" 2>/dev/null || true)

# Create new snapshot
echo "Creating snapshot: ${NEW_SNAP}"
btrfs subvolume snapshot -r "${SRC_MOUNT}/${SUBVOL_NAME}" "${NEW_SNAP}"

# Send
if [[ -n "${LATEST_REMOTE}" && -n "${LATEST_LOCAL}" ]]; then
  LOCAL_PARENT="${SRC_MOUNT}/${LATEST_LOCAL}"
  echo "Incremental send: parent=${LOCAL_PARENT} child=${NEW_SNAP}"
  btrfs send -p "${LOCAL_PARENT}" "${NEW_SNAP}" | \
    pv -rtbN "btrfs-send" | \
    ssh "${REMOTE_HOST}" "btrfs receive ${REMOTE_SNAP_DIR}/"
else
  echo "Full send (no common parent): ${NEW_SNAP}"
  btrfs send "${NEW_SNAP}" | \
    pv -rtbN "btrfs-send" | \
    ssh "${REMOTE_HOST}" "btrfs receive ${REMOTE_SNAP_DIR}/"
fi

echo "Replication complete: ${SUBVOL_NAME} -> ${REMOTE_HOST}"
```

### Sending to a File (Offline Backup)

```bash
# Save to a compressed file
btrfs send /data/@snapshots/@home-2032-02-16 | \
  zstd -T0 -9 > /backup/home-2032-02-16.btrfs.zst

# Restore from file
zstd -d < /backup/home-2032-02-16.btrfs.zst | \
  btrfs receive /restore/

# Incremental to file
btrfs send \
  -p /data/@snapshots/@home-2032-02-15 \
  /data/@snapshots/@home-2032-02-16 | \
  zstd -T0 > /backup/home-2032-02-16-inc.btrfs.zst
```

## Section 4: Qgroups — Quota Management

Btrfs qgroups allow tracking and limiting disk usage per subvolume or groups of subvolumes. This is essential in multi-tenant environments.

### Enabling Qgroups

```bash
# Enable quota subsystem (requires remount)
btrfs quota enable /data
# Quota tracking runs in the background; wait for initial rescan
btrfs quota rescan -s /data
watch btrfs quota rescan -s /data
```

### Assigning Quotas to Subvolumes

```bash
# Show existing qgroups
btrfs qgroup show /data
btrfs qgroup show -r /data   # include referenced size

# Each subvolume automatically gets a qgroup 0/<subvolid>
# Get subvolume ID
btrfs subvolume show /data/@home | grep "Subvolume ID"
# Example: Subvolume ID: 258

# Set size limit: max 50 GiB referenced, 200 GiB exclusive
btrfs qgroup limit 50G /data/@home   # sets referenced limit
btrfs qgroup limit -e 200G /data/@home  # sets exclusive limit

# Via subvolume ID directly
btrfs qgroup limit 50G 0/258 /data

# Show current usage
btrfs qgroup show -pcre /data
```

### Hierarchical Qgroups for Multi-Tenant Accounting

```bash
# Create a level-1 qgroup to aggregate multiple subvolumes
# Qgroup 1/100 will be a "team-a" accounting group
btrfs qgroup create 1/100 /data

# Assign subvolumes to the group
btrfs qgroup assign 0/258 1/100 /data   # @home
btrfs qgroup assign 0/259 1/100 /data   # @databases

# Set a group-wide limit (50 GiB total for team-a)
btrfs qgroup limit 50G 1/100 /data

# Check group usage
btrfs qgroup show -r /data
```

### Automating Qgroup Reports

```bash
#!/bin/bash
# /usr/local/bin/btrfs-qgroup-report.sh
MOUNT="${1:-/data}"

echo "=== Btrfs Qgroup Usage Report: ${MOUNT} ==="
echo "Generated: $(date)"
echo ""

# Header
printf "%-20s %-10s %-10s %-10s %-10s\n" \
  "Subvolume" "Qgroup" "Referenced" "Exclusive" "Limit"
echo "$(printf '%0.s-' {1..65})"

btrfs subvolume list "${MOUNT}" | while read -r _ id _ _ _ _ _ _ path; do
  qg="0/${id}"
  usage=$(btrfs qgroup show "${MOUNT}" 2>/dev/null | grep "^${qg}" | \
    awk '{print $2, $3, $4}')
  if [[ -n "${usage}" ]]; then
    printf "%-20s %-10s %s\n" "$(basename "${path}")" "${qg}" "${usage}"
  fi
done
```

## Section 5: Balance Operations

Balance redistributes data and metadata across devices. On single-device setups, it converts between block group profiles (e.g., DUP metadata). On multi-device setups, it rebalances after adding/removing a device.

### When to Run Balance

- After adding a device to a RAID array
- After removing a device
- When `btrfs filesystem show` reports significantly uneven device usage
- When converting metadata/data profiles (e.g., single → RAID1)
- When a large number of "unallocated" chunks accumulates

### Balance Commands

```bash
# Check if balance is needed
btrfs filesystem usage /data | grep -E "Unallocated|Data ratio|Metadata ratio"

# Basic balance (rebalance everything — can take hours on large filesystems)
btrfs balance start /data

# Background balance (non-blocking)
btrfs balance start -b /data

# Check balance status
btrfs balance status /data

# Cancel running balance
btrfs balance cancel /data

# Balance only partially used data block groups (usage < 50%)
# This is the safest, fastest approach for routine maintenance
btrfs balance start -dusage=50 /data

# Balance only metadata
btrfs balance start -musage=50 /data

# Convert data profile from single to RAID1
btrfs balance start -dconvert=raid1 /data

# Convert metadata from single to DUP (single device protection)
btrfs balance start -mconvert=dup /data

# Limit balance to avoid I/O saturation (sleeps between chunks)
btrfs balance start -dusage=75 --bg /data
# Then set I/O limits via ionice:
ionice -c 3 btrfs balance start -dusage=75 /data
```

### Balance After Adding a Device

```bash
# Step 1: Add a new device to an existing filesystem
btrfs device add /dev/sdd /data

# Step 2: Check before/after device stats
btrfs filesystem show /data
btrfs device stats /data

# Step 3: Balance to distribute existing data onto the new device
btrfs balance start -dconvert=raid1 -mconvert=raid1 /data

# Monitor progress
watch -n 5 "btrfs balance status /data"
```

### Balance Tuning for Production

Never run an unrestricted balance on a production system under load. Use `ionice` and `dusage` filters:

```bash
#!/bin/bash
# /usr/local/bin/btrfs-balance-gentle.sh
# Run during maintenance window or with I/O limiting

MOUNT="${1:-/data}"
USAGE_THRESHOLD="${2:-50}"

echo "Starting gentle balance on ${MOUNT} (usage threshold: ${USAGE_THRESHOLD}%)"

# Use ionice class 3 (idle) and nice 19
ionice -c 3 nice -n 19 \
  btrfs balance start \
    -dusage="${USAGE_THRESHOLD}" \
    -musage="${USAGE_THRESHOLD}" \
    "${MOUNT}"

echo "Balance complete."
btrfs filesystem usage "${MOUNT}"
```

## Section 6: Scrub — Data Integrity Verification

`btrfs scrub` reads every data and metadata block and verifies checksums. On RAID filesystems it also corrects errors using redundant copies.

```bash
# Start scrub (runs in background by default)
btrfs scrub start /data

# Start scrub in foreground (blocks until complete)
btrfs scrub start -B /data

# Check scrub status
btrfs scrub status /data

# Cancel scrub
btrfs scrub cancel /data

# Resume a cancelled scrub
btrfs scrub resume /data
```

### Scrub Output Interpretation

```
UUID:             <uuid>
Scrub started:    Mon Feb 15 03:00:01 2032
Status:           finished
Duration:         2:45:33
Total to scrub:   2.30TiB
Rate:             247.83MiB/s
Error summary:    no errors found
```

If errors are found:

```
Error summary:    csum=1
  Corrected:      1
  Uncorrectable:  0
  Unverified:     0
```

`csum=1` means 1 checksum error was detected. `Corrected=1` means it was repaired using a RAID copy. `Uncorrectable=1` (if seen) means data loss occurred — the block was corrupted on all RAID copies.

### Scheduled Scrub via Systemd

```bash
# Enable btrfs-scrub service (ships with btrfs-progs on most distros)
systemctl enable --now btrfs-scrub@$(systemd-escape -p /data).timer

# Check timer schedule
systemctl list-timers | grep btrfs

# Custom monthly scrub timer
cat > /etc/systemd/system/btrfs-monthly-scrub@.timer << 'UNIT'
[Unit]
Description=Monthly Btrfs scrub on %f

[Timer]
OnCalendar=monthly
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/btrfs-monthly-scrub@.service << 'UNIT'
[Unit]
Description=Btrfs scrub on %f
After=local-fs.target

[Service]
Type=oneshot
# Use ionice to limit impact during scrub
ExecStart=/bin/bash -c "ionice -c 3 nice -n 19 btrfs scrub start -B %f"
IOSchedulingClass=idle
CPUSchedulingPolicy=idle
UNIT

systemctl enable --now "btrfs-monthly-scrub@$(systemd-escape -p /data).timer"
```

### Checking Device Stats for Physical Errors

```bash
# Device-level read/write error counters
btrfs device stats /data

# Example output:
# [/dev/sdb].write_io_errs    0
# [/dev/sdb].read_io_errs     0
# [/dev/sdb].flush_io_errs    0
# [/dev/sdb].corruption_errs  0
# [/dev/sdb].generation_errs  0

# Reset device stats after investigation
btrfs device stats -z /data
```

## Section 7: RAID Profiles

Btrfs implements RAID entirely within the filesystem layer. Data and metadata can have different profiles.

### Profile Comparison

| Profile | Devices | Fault Tolerance | Space Efficiency | Performance |
|---|---|---|---|---|
| `single` | 1+ | None | 100% | Single device |
| `dup` | 1 | Partial (same device) | 50% | Single device |
| `raid0` | 2+ | None | 100% | Striped reads/writes |
| `raid1` | 2+ | 1 device loss | 50% | Parallel reads |
| `raid1c3` | 3+ | 2 device losses | 33% | Parallel reads |
| `raid1c4` | 4+ | 3 device losses | 25% | Parallel reads |
| `raid10` | 4+ | 1 device per mirror | 50% | Striped mirrors |
| `raid5` | 3+ | 1 device loss | (n-1)/n | Striped with parity |
| `raid6` | 4+ | 2 device losses | (n-2)/n | Striped dual parity |

**Production recommendation**: Use `raid1` or `raid10` for both data and metadata. `raid5`/`raid6` are listed but have known bugs and are not recommended for production data.

### Converting Between Profiles

```bash
# Convert data from raid0 to raid1 (adds a second device first)
btrfs device add /dev/sdc /data
btrfs balance start -dconvert=raid1 /data

# Convert metadata from single to dup on a single device
btrfs balance start -mconvert=dup /data

# Check current profile
btrfs filesystem df /data
# Data, RAID1: total=100.00GiB, used=72.51GiB
# Metadata, RAID1: total=2.00GiB, used=1.43GiB
```

### Replacing a Failed Device

```bash
# Identify the failed device
btrfs device stats /data
btrfs filesystem show /data | grep "missing"

# Replace a failed device (in-place, online)
# /dev/sdb failed; /dev/sde is the replacement
btrfs replace start /dev/sdb /dev/sde /data

# Monitor replacement progress
watch -n 10 "btrfs replace status /data"

# After replacement completes, verify
btrfs filesystem show /data
btrfs device stats /data
```

## Section 8: Compression and Deduplication

### Per-Subvolume Compression

```bash
# Enable compression on a new subvolume
btrfs subvolume create /data/@logs
mount -o remount,compress=zstd:3 /data
# OR set per-inode with chattr:
chattr +c /data/@logs

# Check current compression for a file
btrfs filesystem compsize /data/@logs/app.log

# Compress existing data (retroactively defrag+compress)
btrfs filesystem defragment -r -czstd /data/@logs

# Check space savings
btrfs filesystem df /data
compsize /data/@logs
```

### Out-of-band Deduplication with duperemove

Btrfs does not have built-in deduplication (block-level dedup at write time), but `duperemove` provides out-of-band dedup:

```bash
# Install duperemove
apt-get install duperemove   # Debian/Ubuntu
dnf install duperemove       # Fedora/RHEL

# Scan and dedup (read-only scan)
duperemove -rh /data/@home

# Dedup with write enabled
duperemove -rdh /data/@home

# Use a hashfile for incremental runs (much faster)
duperemove -rdh --hashfile=/var/lib/duperemove/home.db /data/@home

# Schedule weekly dedup
cat > /etc/systemd/system/btrfs-dedup@.service << 'UNIT'
[Unit]
Description=Btrfs deduplication on %i

[Service]
Type=oneshot
ExecStart=duperemove -rdh \
  --hashfile=/var/lib/duperemove/%i.db \
  /data/%i
IOSchedulingClass=idle
CPUSchedulingPolicy=idle
UNIT
```

## Section 9: Defragmentation

CoW filesystems fragment files over time when files are modified frequently (e.g., VM disk images, databases). Defrag consolidates extents.

```bash
# Defragment a single file
btrfs filesystem defragment -v /data/@home/user/large-file.img

# Recursive defrag of a directory with compression
btrfs filesystem defragment -r -czstd /data/@home/user/

# Defrag with a specific extent target size (512 KiB)
btrfs filesystem defragment -r -l 524288 /data/@home/

# Check fragmentation before/after
filefrag -v /data/@home/user/large-file.img
```

**Warning**: defragmenting a snapshot-heavy subvolume can cause massive space amplification. Defrag breaks the shared extents between snapshots, causing each snapshot to hold its own copy of data. Only defrag subvolumes without many snapshots.

## Section 10: Monitoring and Alerting

```bash
#!/bin/bash
# /usr/local/bin/btrfs-health-check.sh
# Returns exit code 1 if any health issues found

set -euo pipefail
MOUNT="${1:-/data}"
ISSUES=0

echo "=== Btrfs Health Check: ${MOUNT} ==="

# 1. Check for read/write errors
ERRORS=$(btrfs device stats "${MOUNT}" | \
  grep -E "(read_io|write_io|corruption)_errs" | \
  awk '{sum += $2} END {print sum}')
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "CRITICAL: Device errors detected: ${ERRORS}"
  btrfs device stats "${MOUNT}"
  ((ISSUES++))
fi

# 2. Check available space
FREE_PCT=$(btrfs filesystem usage "${MOUNT}" | \
  grep "Free (estimated)" | \
  grep -oP '\d+(\.\d+)?%' | head -1 | tr -d '%')
if awk "BEGIN {exit !(${FREE_PCT} < 10)}"; then
  echo "WARNING: Free space below 10%: ${FREE_PCT}%"
  ((ISSUES++))
fi

# 3. Check for unallocated space (may indicate need for balance)
UNALLOC=$(btrfs filesystem usage "${MOUNT}" | \
  grep "Unallocated" | awk '{print $2}')
echo "Unallocated space: ${UNALLOC}"

# 4. Check scrub status
SCRUB_STATUS=$(btrfs scrub status "${MOUNT}" | grep "Status" | awk '{print $2}')
echo "Last scrub status: ${SCRUB_STATUS}"
if [[ "${SCRUB_STATUS}" == "aborted" ]]; then
  echo "WARNING: Last scrub was aborted"
  ((ISSUES++))
fi

# 5. Check for missing devices
MISSING=$(btrfs filesystem show "${MOUNT}" 2>/dev/null | grep -c "MISSING" || true)
if [[ "${MISSING}" -gt 0 ]]; then
  echo "CRITICAL: ${MISSING} missing device(s)"
  ((ISSUES++))
fi

if [[ "${ISSUES}" -eq 0 ]]; then
  echo "OK: No issues found"
  exit 0
else
  echo "ISSUES FOUND: ${ISSUES}"
  exit 1
fi
```

Prometheus metrics via node_exporter's btrfs collector:

```yaml
# Prometheus alert rules
groups:
- name: btrfs.rules
  rules:
  - alert: BtrfsDeviceErrors
    expr: node_btrfs_device_errors_total > 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Btrfs device errors on {{ $labels.instance }}"
      description: "Device {{ $labels.device }} has {{ $value }} errors on {{ $labels.instance }}"

  - alert: BtrfsLowFreeSpace
    expr: |
      (node_btrfs_free_bytes / node_btrfs_total_bytes) * 100 < 10
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Btrfs filesystem low on space: {{ $labels.instance }}"

  - alert: BtrfsMissingDevice
    expr: node_btrfs_device_missing == 1
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Btrfs missing device on {{ $labels.instance }}"
```

## Section 11: Troubleshooting Common Issues

### ENOSPC Despite Apparent Free Space

Btrfs allocates space in chunk granularity. If unallocated raw space exists but no chunks can be created, writes fail with ENOSPC:

```bash
# Diagnose
btrfs filesystem usage /data
# Look for: Unallocated: X GiB  (raw space)
#           Free (estimated): very low

# Fix: run balance to convert unallocated chunks
btrfs balance start -dusage=0 /data
btrfs balance start -musage=0 /data
```

### Qgroup Rescan Stuck

```bash
# Check rescan status
btrfs quota rescan -s /data

# If stuck, disable and re-enable quotas
btrfs quota disable /data
btrfs quota enable /data
btrfs quota rescan /data
```

### Corrupted Filesystem Recovery

```bash
# Mount with recovery options (read-only check first)
mount -o ro,recovery /dev/sdb /mnt/recover

# Run btrfs check (read-only by default)
btrfs check /dev/sdb

# If errors found, repair (dangerous — backup first)
btrfs check --repair /dev/sdb

# Restore super block from backup (if primary super is corrupted)
btrfs check --super 1 /dev/sdb   # try super block copy 1
btrfs rescue super-recover /dev/sdb
```

### Slow Send/Receive

```bash
# Increase send buffer
btrfs send -e 524288 /data/@snapshots/@home-2032-02-16 | \
  ssh backup-host "btrfs receive /backup/"

# Use mbuffer for buffering
btrfs send /data/@snapshots/@home-2032-02-16 | \
  mbuffer -s 128k -m 512M | \
  ssh backup-host "mbuffer -s 128k -m 512M | btrfs receive /backup/"
```

## Summary

Btrfs provides a comprehensive set of storage management features that, when used correctly, give Linux systems enterprise-grade data protection:

- **Subvolume hierarchies** enable clean separation of OS, data, and log trees with independent mount options
- **Send/receive** provides efficient incremental replication with no separate block-device tooling required
- **Qgroups** enforce per-tenant storage quotas and enable accurate usage accounting
- **Balance** redistributes data after topology changes and reclaims space from fragmented chunk allocation
- **Scrub** continuously verifies data integrity and auto-corrects errors on RAID filesystems
- **RAID1/RAID10** (not RAID5/6) provides production-worthy redundancy within the filesystem layer

The key operational principles: always maintain a recent read-only snapshot before any risky operation, schedule scrub monthly, run gentle balance with `dusage` filters rather than full unrestricted balances, and monitor device error counters daily via Prometheus.
