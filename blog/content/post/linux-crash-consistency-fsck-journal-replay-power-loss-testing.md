---
title: "Linux Crash Consistency: fsck, Journal Replay, and Power-Loss Testing"
date: 2029-11-22T00:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "ext4", "btrfs", "Storage", "fsck", "Reliability"]
categories: ["Linux", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux crash consistency: ext4 journal modes (data=writeback/ordered/journal), fsck repair phases, power-loss testing with dm-log-writes, btrfs copy-on-write advantages, and production storage reliability strategies."
more_link: "yes"
url: "/linux-crash-consistency-fsck-journal-replay-power-loss-testing/"
---

Crash consistency is the property that a filesystem maintains a valid, coherent state after an unexpected system failure — power cut, kernel panic, storage controller failure. Without crash consistency mechanisms, a filesystem that was being modified at the moment of failure may become permanently corrupted, losing not only in-flight data but potentially entire directory trees. This guide covers the mechanisms Linux filesystems use to achieve crash consistency, how to test them, and how to configure them for production storage workloads.

<!--more-->

# Linux Crash Consistency: fsck, Journal Replay, and Power-Loss Testing

## The Crash Consistency Problem

Consider a simple file append operation: writing 64KB to the end of a file requires multiple on-disk operations:
1. Write the data blocks to the storage device
2. Update the inode to reflect the new file size and block pointers
3. Update the block group bitmap to mark the new blocks as allocated
4. Update the block group descriptor to reflect the new free block count

If power is lost after step 1 but before step 2, the inode still shows the old file size, and the new data is written to "free" blocks that may be allocated to another file later. The result is data corruption.

Journaling solves this with an ordered commit protocol. Copy-on-write (COW) filesystems like btrfs solve it by never overwriting live data.

## ext4 Journal Modes

ext4 provides three journaling modes with different consistency/performance tradeoffs.

### data=writeback

In `data=writeback` mode, only metadata (inodes, directory entries, block bitmaps) is journaled. File data is written to its final location at an arbitrary time, potentially after the metadata journal commit.

**Consistency guarantee**: Metadata is consistent after crash. File data may not match what the application wrote — you might see old data or garbage where new data was expected.

**Performance**: Highest write throughput because data writes can be reordered freely by the storage scheduler.

**When to use**: Databases that maintain their own WAL (PostgreSQL, MySQL InnoDB), when the application can tolerate data loss to the most recent checkpoint.

```bash
# Mount with writeback mode
mount -t ext4 -o data=writeback /dev/sdb1 /mnt/data

# Check current mount options
cat /proc/mounts | grep /mnt/data
# /dev/sdb1 /mnt/data ext4 rw,relatime,data=writeback 0 0

# Make permanent in /etc/fstab
/dev/sdb1  /mnt/data  ext4  defaults,data=writeback  0  2
```

### data=ordered (Default)

In `data=ordered` mode (the ext4 default), file data is written to its final location before the journal commit that updates the related metadata. This ensures that if the journal commit succeeds, all related data writes also succeeded.

**Consistency guarantee**: After crash recovery, you will never see new metadata pointing to unwritten or partially-written data blocks. You may see the old version of a file if the write was in flight, but the filesystem is always internally consistent.

**Performance**: Moderate. The ordering constraint adds latency compared to writeback but less overhead than the full journal mode.

**When to use**: General-purpose usage. Most production systems use data=ordered.

```bash
# data=ordered is the default for ext4
mount -t ext4 /dev/sdb1 /mnt/data
# Equivalent to:
mount -t ext4 -o data=ordered /dev/sdb1 /mnt/data

# Verify
tune2fs -l /dev/sdb1 | grep "Default mount options"
# Default mount options:    user_xattr acl
# Note: data=ordered is compiled in as default, not shown explicitly
```

### data=journal

In `data=journal` mode, all file data is first written to the journal before being written to its final on-disk location. This provides the strongest consistency guarantee but doubles write I/O for all data operations.

**Consistency guarantee**: After crash, the filesystem is fully consistent — metadata and data match exactly.

**Performance**: Lowest. Every write requires two I/O operations (journal + final location). On SSDs with fast sequential write, the overhead is reduced but still significant.

**When to use**: Very high-value data where any inconsistency is unacceptable. Databases do not benefit (they have their own WAL). The primary use case is data that cannot tolerate even the ordered-mode risk of seeing stale data after a crash.

```bash
# Mount with full data journaling
mount -t ext4 -o data=journal /dev/sdb1 /mnt/critical-data

# Enable at filesystem creation time (can also be set per-mount)
mkfs.ext4 -E lazy_itable_init=0 -o journal_data /dev/sdb1

# Alternatively set as default mount option in the superblock
tune2fs -o journal_data /dev/sdb1
tune2fs -l /dev/sdb1 | grep "Default mount options"
# Default mount options:    user_xattr acl journal_data
```

### Journal Mode Performance Comparison

```bash
# Benchmark with fio: sequential 4KB sync writes
# Test: 64 parallel writers, 4KB write size, fsync after every write

# data=writeback
fio --name=test --ioengine=sync --rw=write --bs=4k \
    --size=1g --numjobs=64 --sync=1 --group_reporting \
    --directory=/mnt/writeback-mount

# data=ordered
fio --name=test --ioengine=sync --rw=write --bs=4k \
    --size=1g --numjobs=64 --sync=1 --group_reporting \
    --directory=/mnt/ordered-mount

# data=journal
fio --name=test --ioengine=sync --rw=write --bs=4k \
    --size=1g --numjobs=64 --sync=1 --group_reporting \
    --directory=/mnt/journal-mount

# Typical results on NVMe SSD:
# writeback: ~180,000 IOPS
# ordered:   ~120,000 IOPS (storage ordering constraint)
# journal:    ~45,000 IOPS (double-write penalty)
```

## ext4 Journal Internals

Understanding the journal structure helps diagnose corruption and tune performance.

### Journal Layout

```bash
# View journal information
tune2fs -l /dev/sdb1 | grep -i journal
# Journal inode:            8
# Journal backup:           inode blocks
# Journal size:             128M

# Dump journal superblock
dumpe2fs /dev/sdb1 | grep -A5 "Journal"
# Journal features:         journal_incompat_revoke journal_64bit
# Journal size:             131072k
# Journal length:           32768
# Journal sequence:         0x000004e2
# Journal start:            0x00000001
```

### Journal Transaction States

```
States of a journal transaction:
Running     → Currently accepting new writes
Committing  → Flushing to journal on disk
Checkpointing → Writing journal contents to their final locations
Freed       → Transaction blocks available for reuse
```

### Tuning Journal Parameters

```bash
# Increase journal size for high-write workloads (reduces journal pressure)
# Must be done on unmounted filesystem
tune2fs -J size=512 /dev/sdb1  # 512 MB journal

# Set journal commit interval (default: 5 seconds)
# Shorter interval = more frequent commits = lower data loss window
# Longer interval = better batching = higher throughput
mount -o commit=1 /dev/sdb1 /mnt/data  # Commit every 1 second

# barrier=0 disables write barriers (dangerous but faster on UPS-protected systems)
# Only use if the storage controller has a battery-backed write cache
mount -o barrier=0 /dev/sdb1 /mnt/data  # DANGEROUS without BBU

# Recommended for production NVMe:
mount -o commit=5,barrier=1,data=ordered /dev/sdb1 /mnt/data
```

## fsck: Filesystem Check and Repair

`fsck` (file system check) is the offline repair tool for ext4. It performs up to six passes, each checking and repairing a different class of inconsistency.

### fsck Passes

**Pass 1: Check inodes, blocks, and sizes**
- Validates inode bitmaps against actual inode usage
- Checks block pointers in each inode for validity
- Detects inode count mismatches, invalid block numbers, duplicate block usage

**Pass 1b: Rescan for duplicate blocks**
- Rescans all inodes to resolve duplicate block references found in Pass 1

**Pass 2: Check directory structure**
- Validates directory entries (dirent) for correct inode numbers
- Checks directory entry names for valid characters and lengths
- Verifies `.` and `..` entries

**Pass 3: Check directory connectivity**
- Ensures every directory is reachable from the root
- Moves orphaned directories to `lost+found`

**Pass 4: Check reference counts**
- Compares actual link counts (references to inodes) against inode nlink fields
- Corrects mismatches

**Pass 5: Check group summary information**
- Validates block group descriptors, inode bitmaps, block bitmaps
- Corrects bit map inconsistencies

**Pass 6 (optional): Check block group summaries**
- Final validation of block group accounting

```bash
# Run fsck on an unmounted filesystem
# -n = dry run (show what would be repaired without repairing)
fsck.ext4 -n /dev/sdb1

# Automatic repair (answer yes to all questions)
fsck.ext4 -y /dev/sdb1

# Verbose output
fsck.ext4 -v /dev/sdb1

# Force check even if filesystem was cleanly unmounted
fsck.ext4 -f /dev/sdb1

# Sample fsck output with errors:
# e2fsck 1.47.0 (5-Feb-2023)
# /dev/sdb1: recovering journal
# Pass 1: Checking inodes, blocks, and sizes
# Inode 2063 has invalid extent
#   (logical block 0, invalid physical block 0, len 1)
#   FIXED.
# Pass 2: Checking directory structure
# Pass 3: Checking directory connectivity
# Pass 4: Checking reference counts
# Pass 5: Checking group summary information
# /dev/sdb1: 12345/131072 files (0.2% non-contiguous), 456789/1048576 blocks
```

### Interpreting fsck Exit Codes

```bash
# fsck exit codes (can be ORed together):
# 0  No errors
# 1  Filesystem errors corrected
# 2  System should be rebooted
# 4  Filesystem errors left uncorrected
# 8  Operational error
# 16 Usage or syntax error
# 32 Checked is canceled by user request
# 128 Shared-library error

# Check exit code after fsck
fsck.ext4 -y /dev/sdb1
echo "fsck exit code: $?"
```

### Journal Replay

Before fsck runs its passes, it replays the ext4 journal to bring the filesystem to the most recent committed state:

```bash
# Journal replay happens automatically when mounting after unclean shutdown
dmesg | grep -i ext4 | head -20
# ext4: recovering journal
# EXT4-fs (sdb1): recovery complete
# EXT4-fs (sdb1): mounted filesystem with ordered data mode

# Force journal replay without full fsck
# (mount and remount cleanly unmounts)
mount /dev/sdb1 /mnt/tmp
umount /mnt/tmp
# Journal is now replayed and checkpoint complete

# View journal recovery statistics
tune2fs -l /dev/sdb1 | grep "Last mounted on\|Mount count\|Check interval"
```

## Power-Loss Testing with dm-log-writes

`dm-log-writes` is a device mapper target that records the order and content of all writes to a block device. This allows you to replay a write sequence to any arbitrary point, simulating a power failure at any moment during filesystem operations.

### Setting Up dm-log-writes

```bash
# Install required tools
apt-get install -y device-mapper fio btrfs-progs e2fsprogs

# Create a test block device (1GB loopback)
dd if=/dev/zero of=/tmp/test-disk.img bs=1M count=1024
losetup /dev/loop0 /tmp/test-disk.img

# Create a log device (must be large enough to hold all write records)
dd if=/dev/zero of=/tmp/log-disk.img bs=1M count=2048
losetup /dev/loop1 /tmp/log-disk.img

# Create the dm-log-writes device
# device-mapper: log writes from /dev/loop0, log to /dev/loop1
dmsetup create log-writes \
  --table "0 $(blockdev --getsz /dev/loop0) log-writes /dev/loop0 /dev/loop1"

# The device is now available as /dev/mapper/log-writes
# All writes to /dev/mapper/log-writes are:
# 1. Forwarded to /dev/loop0 (the actual device)
# 2. Logged to /dev/loop1 (the log device)
```

### Running a Workload

```bash
# Format and mount the device
mkfs.ext4 /dev/mapper/log-writes
mkdir /mnt/test
mount -o data=ordered /dev/mapper/log-writes /mnt/test

# Run workload (mark the starting entry in the log)
blkdiscard -z /dev/loop1  # Clear the log

# Run the workload you want to test
for i in $(seq 1 1000); do
    echo "data-$i" > /mnt/test/file-$i.txt
    # Optional: sync to create checkpoints
    [ $((i % 100)) -eq 0 ] && sync
done

# Mark a "mark" entry in the log (for replay reference)
# (dm-log-writes specific ioctl or use the replay tool's mark support)

umount /mnt/test
dmsetup remove log-writes
```

### Replaying to Test Points

```bash
# Install the log-writes replay tool
# (from the blktests project or btrfs-progs)
git clone https://github.com/osandov/blktests.git
cd blktests && make

# List entries in the log
./src/log-writes/replay-log --log /dev/loop1 --list | head -50
# Entry 0: sector=2048 flags=METADATA size=4096
# Entry 1: sector=2048 flags=DATA size=4096
# Entry 2: sector=4096 flags=FLUSH
# ...

# Replay up to entry N (simulate power loss after entry N)
./src/log-writes/replay-log \
    --log /dev/loop1 \
    --replay /dev/loop0 \
    --limit 500  # Stop after 500 write entries

# Now run fsck on the device to check consistency at this point
fsck.ext4 -n /dev/loop0
echo "fsck result: $?"

# Mount and check data integrity
mount -o noload /dev/loop0 /mnt/replay-test
ls -la /mnt/replay-test/
# Check that no corruption is visible
umount /mnt/replay-test
```

### Automated Power-Loss Testing Script

```bash
#!/usr/bin/env bash
# power-loss-test.sh — Automated crash consistency testing

set -euo pipefail

DISK_IMG=/tmp/pl-disk.img
LOG_IMG=/tmp/pl-log.img
DISK_SIZE_MB=512
LOG_SIZE_MB=1024
MOUNT=/mnt/pl-test
RESULTS=/tmp/pl-results.txt

cleanup() {
    umount $MOUNT 2>/dev/null || true
    dmsetup remove log-writes 2>/dev/null || true
    losetup -d /dev/loop10 2>/dev/null || true
    losetup -d /dev/loop11 2>/dev/null || true
}
trap cleanup EXIT

# Setup
dd if=/dev/zero of=$DISK_IMG bs=1M count=$DISK_SIZE_MB
dd if=/dev/zero of=$LOG_IMG bs=1M count=$LOG_SIZE_MB

losetup /dev/loop10 $DISK_IMG
losetup /dev/loop11 $LOG_IMG

dmsetup create log-writes \
    --table "0 $(blockdev --getsz /dev/loop10) log-writes /dev/loop10 /dev/loop11"

mkfs.ext4 -q /dev/mapper/log-writes
mkdir -p $MOUNT
mount -o data=ordered /dev/mapper/log-writes $MOUNT

# Run workload
echo "Running workload..."
for i in $(seq 1 500); do
    dd if=/dev/urandom of=$MOUNT/file-$i bs=4k count=$((RANDOM % 10 + 1)) 2>/dev/null
done
sync
umount $MOUNT
dmsetup remove log-writes

# Get total log entries
TOTAL_ENTRIES=$(replay-log --log /dev/loop11 --list 2>/dev/null | wc -l)
echo "Total log entries: $TOTAL_ENTRIES"

# Test at 50 different crash points
echo "Testing crash consistency at 50 points..." > $RESULTS
STEP=$((TOTAL_ENTRIES / 50))

for i in $(seq 0 49); do
    ENTRY=$((i * STEP + 1))
    [ $ENTRY -gt $TOTAL_ENTRIES ] && break

    # Restore disk to clean state
    dd if=/dev/zero of=$DISK_IMG bs=1M count=$DISK_SIZE_MB 2>/dev/null

    # Replay to this point
    replay-log --log /dev/loop11 --replay /dev/loop10 --limit $ENTRY

    # Run fsck
    FSCK_RESULT=0
    fsck.ext4 -y /dev/loop10 > /tmp/fsck-out.txt 2>&1 || FSCK_RESULT=$?

    STATUS="PASS"
    [ $FSCK_RESULT -ge 4 ] && STATUS="FAIL"

    echo "Entry $ENTRY/$TOTAL_ENTRIES: fsck=$FSCK_RESULT STATUS=$STATUS" | tee -a $RESULTS
done

echo ""
echo "Results:"
grep FAIL $RESULTS || echo "All tests passed!"
```

## btrfs: Copy-on-Write Consistency

btrfs takes a fundamentally different approach to crash consistency: instead of journaling modifications to existing blocks, btrfs always writes new data and metadata to new disk locations. Old locations are kept until a new "generation" is committed to the on-disk tree structures.

### How btrfs COW Works

```
Traditional filesystem write:
  Old data: [block A: "hello"]
  Write "world" to same file:
  ↓ Overwrite in place ↓
  New data: [block A: "world"]
  → If power fails during write: [block A: corrupted]

btrfs COW write:
  Old data: [block A: "hello"] (generation 100)
  Write "world":
  → Allocate new block: [block B: "world"] (generation 101)
  → Update metadata tree to point to block B (generation 101)
  → Commit tree root (atomic pointer swap)
  → Only then mark block A as free
  → If power fails before commit: tree still points to block A
  → Block B is simply unreferenced (freed at next scrub)
```

```bash
# Create btrfs filesystem
mkfs.btrfs /dev/sdc1

# btrfs has no data=journal/ordered/writeback — COW is always on
mount /dev/sdc1 /mnt/btrfs-test

# View btrfs filesystem information
btrfs filesystem show /mnt/btrfs-test
btrfs device stats /dev/sdc1
# (Shows read/write errors, corruption counts)
```

### btrfs Checksumming

btrfs checksums all data and metadata by default, enabling detection (and with RAID: automatic repair) of bit rot:

```bash
# View checksum algorithm (default: crc32c, or specify sha256/xxhash/blake2)
btrfs filesystem show /mnt/btrfs-test | grep checksum

# Create filesystem with stronger checksum (for critical data)
mkfs.btrfs --checksum xxhash /dev/sdc1
mkfs.btrfs --checksum sha256 /dev/sdc1  # Strongest, highest CPU overhead

# Scrub: verify checksums for all data and metadata
btrfs scrub start /mnt/btrfs-test
btrfs scrub status /mnt/btrfs-test
# Scrub status for <uuid>:
#   scrub started at Thu Nov 22 10:00:00 2029 and finished after 00:05:23
#   total bytes scrubbed: 234.56GiB with 0 errors
```

### btrfs vs ext4 Crash Consistency Comparison

```bash
# Test: Write 1000 files, simulate crash at 500 writes

# ext4 data=ordered:
# After replay and fsck:
# - Filesystem is consistent
# - Files written before journal commit may be truncated or empty
# - fsck repairs metadata inconsistencies
# - Result: 0-500 complete files visible, no corruption

# btrfs:
# After replay:
# - No fsck needed (COW ensures consistency)
# - Files from incomplete transactions simply don't exist
# - btrfs log tree provides per-file journaling for sync'd writes
# - Result: Exactly the committed files are visible, atomically
```

### btrfs fsck (btrfs check)

Unlike ext4's fsck which is often needed after crashes, btrfs rarely requires offline repair:

```bash
# Check btrfs filesystem (read-only by default)
btrfs check /dev/sdc1

# Repair (use with caution — usually not needed)
btrfs check --repair /dev/sdc1

# For severe corruption
btrfs rescue super-recover /dev/sdc1
btrfs rescue zero-log /dev/sdc1  # Zero the log tree (forces full replay)
```

## Production Storage Configuration

### ext4 Production Mount Options

```bash
# /etc/fstab for a high-performance database disk
/dev/nvme0n1p1  /var/lib/postgresql  ext4  \
  defaults,noatime,nodiratime,data=ordered,\
  commit=60,barrier=1,errors=remount-ro  0  2

# For write-intensive workloads (with UPS or BBU):
/dev/nvme0n1p2  /var/lib/kafka  ext4  \
  defaults,noatime,data=writeback,\
  commit=30,barrier=0  0  2

# For critical logs (strong consistency):
/dev/sda1  /var/log/critical  ext4  \
  defaults,sync,data=journal,\
  commit=1,barrier=1  0  2
```

### Monitoring Filesystem Health

```bash
# Monitor ext4 errors
tune2fs -l /dev/sda1 | grep "Last checked\|Mount count\|Error\|First error"

# Check for filesystem errors in kernel log
dmesg -T | grep -i "ext4\|filesystem\|I/O error\|EIO"

# Monitor block device errors
cat /sys/block/sda/stat
smartctl -a /dev/sda | grep -i error

# Prometheus node_exporter filesystem metrics
curl -s localhost:9100/metrics | grep node_filesystem_
# node_filesystem_avail_bytes
# node_filesystem_files_free
# node_filesystem_readonly
# node_filesystem_errors_total (if available)
```

### Alert on Filesystem Errors

```yaml
# prometheus-filesystem-alerts.yaml
groups:
  - name: filesystem
    rules:
      - alert: FilesystemReadOnly
        expr: node_filesystem_readonly{mountpoint!~"/sys.*|/proc.*"} == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Filesystem {{ $labels.mountpoint }} is read-only"
          description: "Filesystem remounted read-only, likely due to errors."

      - alert: FilesystemNearFull
        expr: |
          (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.1
          and node_filesystem_readonly == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Filesystem {{ $labels.mountpoint }} is {{ $value | humanizePercentage }} full"
```

## Summary

Crash consistency in Linux storage is achieved through journaling (ext4) or copy-on-write (btrfs). ext4's three journal modes — writeback, ordered (default), and journal — offer a spectrum of consistency guarantees and performance tradeoffs. fsck's six repair passes restore filesystem consistency offline when journal replay is insufficient. dm-log-writes enables rigorous power-loss simulation for testing filesystem behavior at any point in a write sequence. btrfs's COW design eliminates the need for offline repair in most cases and adds transparent checksumming for bit rot detection. The right choice depends on your workload: ordered mode with a battery-backed controller for most databases, data=journal for critical audit logs, and btrfs with checksums for long-term archival storage.
