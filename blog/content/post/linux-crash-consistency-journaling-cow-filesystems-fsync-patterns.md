---
title: "Linux Crash Consistency: Journaling, COW Filesystems, and fsync Patterns"
date: 2031-03-09T00:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "ext4", "btrfs", "ZFS", "fsync", "Database", "Durability"]
categories:
- Linux
- Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into ext4 journaling modes, data=ordered guarantees, Copy-on-Write semantics in btrfs and ZFS, fsync vs fdatasync vs msync, O_DIRECT and O_SYNC usage, and database write barrier behavior."
more_link: "yes"
url: "/linux-crash-consistency-journaling-cow-filesystems-fsync-patterns/"
---

Crash consistency is the property that guarantees a filesystem and the data stored on it remain in a valid, recoverable state after unexpected power loss or system crash. Every database, write-ahead log, and distributed system that requires durability depends on the crash consistency guarantees provided by the underlying filesystem. Understanding these guarantees — and their costs — is essential for designing storage systems that are both correct and performant.

<!--more-->

# Linux Crash Consistency: Journaling, COW Filesystems, and fsync Patterns

## Section 1: The Crash Consistency Problem

### What Can Go Wrong

Consider writing a file that spans multiple filesystem data structures:

1. The file's data block.
2. The inode (metadata: file size, modification time, block pointers).
3. The directory entry (linking filename to inode).
4. The allocation bitmap (tracking which blocks are in use).

A crash during a write that updates all four structures can leave them in an inconsistent state:
- Directory entry points to inode, but inode says size=0 (data not written).
- Inode size updated, but data block contains garbage.
- Data written, but allocation bitmap not updated (block leak).
- Block pointer in inode updated, but old block not freed (double allocation).

Traditional `fsck` (filesystem check) solved this by scanning the entire filesystem after a crash. For large disks, this took hours. Journaling was introduced to make crash recovery fast.

### The Write Ordering Problem

Modern storage has multiple caching layers, each with independent write reordering:

```
Application write()
    │
    ▼
Page Cache (kernel buffer cache)
    │
    ▼
Block Device Queue (I/O scheduler)
    │
    ▼
Storage Controller Cache (volatile DRAM on the disk/SSD)
    │
    ▼
Persistent Storage (flash cells / magnetic platters)
```

A write barrier (write+flush) forces all preceding writes through to persistent storage before the barrier completes. Without barriers, writes issued in order A→B→C may reach persistent storage in any order: B→A→C, C→A→B, etc.

## Section 2: ext4 Journaling Modes

ext4 supports three journaling modes, each with different durability guarantees and performance characteristics.

### data=ordered (Default)

In `data=ordered` mode:
1. **File data** is written directly to disk WITHOUT going through the journal.
2. **Metadata** (inodes, directory entries, allocation bitmaps) is journaled.
3. **Ordering guarantee**: File data is written to disk BEFORE the journal commit that records the metadata update.

```
write(fd, "hello", 5)   →  data "hello" written to disk
                           THEN metadata (inode size=5) committed to journal
                           THEN journal committed
```

**What `data=ordered` guarantees**:
- After crash recovery, if the metadata says file size = 100 bytes, the data blocks contain valid data (not garbage).
- You will never see a case where metadata says data exists but the data is garbage.

**What `data=ordered` does NOT guarantee**:
- If `fsync` is not called, the write may be lost entirely (metadata update not committed yet).
- The LATEST write may be lost; but any data that was committed before the crash is valid.

### data=writeback

In `data=writeback` mode:
1. **File data** is written to disk at any time (no ordering with metadata).
2. **Metadata** is journaled.

```
metadata committed to journal
    ↕ (no ordering — can happen in any order)
data written to disk
```

**What `data=writeback` does NOT guarantee**:
- After a crash, a file may have size=100 (from journaled metadata) but the data blocks contain garbage from a previous file's data (written to the same blocks at a different time).
- This can expose data from deleted files in newly written files.

**Performance**: Slightly faster than `data=ordered` because there is no ordering constraint.

**Security concern**: The exposure of stale data makes `data=writeback` inappropriate for multi-tenant systems.

### data=journal (Full Data Journaling)

In `data=journal` mode:
1. **Both file data AND metadata** are written to the journal first.
2. After journal commit, data is written to its final location (checkpointing).

```
write(fd, "hello", 5)  →  data "hello" written to journal
                          metadata written to journal
                          journal committed
                          THEN data copied from journal to final location
```

**What `data=journal` guarantees**:
- Maximum crash consistency: all writes are atomic with respect to power loss.
- `fsync` is essentially a no-op (data is already persisted in the journal).

**Performance**: 2-3x slower than `data=ordered` for write-heavy workloads due to double-writing.

### Checking and Changing Journal Mode

```bash
# Check current mount options
mount | grep "ext4"
# /dev/sda1 on / type ext4 (rw,relatime,data=ordered)

# Check per-filesystem
tune2fs -l /dev/sda1 | grep "Default mount"

# Change journal mode temporarily
mount -o remount,data=writeback /dev/sda1 /

# Change journal mode permanently in /etc/fstab
# /dev/sda1  /  ext4  defaults,data=ordered  0 1

# For databases (PostgreSQL, MySQL), consider data=ordered with barriers
# For Kubernetes persistent volumes:
storageClass:
  parameters:
    fstype: ext4
  mountOptions:
  - data=ordered
  - barrier=1
```

## Section 3: Write Barriers and Flush Commands

### How Write Barriers Work

A write barrier in the filesystem layer translates to a flush command sent to the storage device:

- **`FLUSH CACHE`** (ATA) / **`SYNCHRONIZE CACHE`** (SCSI/NVMe): Forces the device to flush its volatile write cache to persistent storage. All previously issued writes are guaranteed to be persistent after this command completes.

- **`FUA` (Force Unit Access)**: A per-write flag that bypasses the volatile cache for a specific write. More efficient than a full flush for single important writes (like journal commit blocks).

```bash
# Check if filesystem barriers are enabled
mount | grep barrier
# If "nobarrier" appears, crash consistency is reduced

# Check storage controller cache-to-disk persistence
hdparm -I /dev/sda | grep "write cache"
# Write cache:        enabled  ← volatile, may lose data on power loss

# Enable disk write cache (performance, reduced durability)
hdparm -W 1 /dev/sda

# Disable disk write cache (maximum durability, reduced performance)
hdparm -W 0 /dev/sda

# For SSDs/NVMe, check power loss protection
# NVMe drives with power loss protection capacitors are safe with write cache enabled
nvme id-ctrl /dev/nvme0 | grep "VWC"
# VWC (Volatile Write Cache): 0 = not present (safe), 1 = present
```

## Section 4: Copy-on-Write Filesystems

### btrfs COW Semantics

In btrfs (and ZFS), every write creates a new copy of the data rather than overwriting in place. The filesystem tree is updated atomically by updating root pointers.

```
BEFORE write:
[Root] → [Node A] → [Leaf: data_block_1]

AFTER write (COW):
[NEW Root] → [NEW Node A] → [NEW data_block_2 (new data)]
[OLD Root] → [OLD Node A] → [OLD data_block_1 (still valid)]
```

The key insight: **a crash during a COW write leaves the old data intact**. The old root pointer is still valid and points to consistent data. The new root pointer is not written until the write is complete and durable.

**COW guarantees**:
- No partial writes are ever visible (atomicity).
- Crash recovery is nearly instantaneous (no fsck needed; just discard the incomplete new tree).
- Snapshots are O(1) and space-efficient.

**COW costs**:
- Write amplification: Every small write requires copying the entire path from the modified leaf to the root.
- Fragmentation: Data is never written in-place, so files fragment over time.
- btrfs `nodatacow` mount option: Disable COW for specific files (like database files) that implement their own crash consistency.

### btrfs nodatacow for Databases

Databases (PostgreSQL, MySQL, SQLite) implement their own crash consistency via WAL (write-ahead logging). They manage their own fsync calls and do not benefit from filesystem-level COW — in fact, COW interacts poorly with WAL because:
1. WAL writes data to one location, then updates the data file in-place.
2. btrfs COW prevents in-place updates, causing write amplification.
3. COW fragmentation hurts sequential read performance for large database files.

```bash
# Create a database data directory with nodatacow
mkdir -p /var/lib/postgresql/data
chattr +C /var/lib/postgresql/data    # +C = nodatacow

# Verify
lsattr -d /var/lib/postgresql/data
# -----C----------- /var/lib/postgresql/data

# Mount btrfs with nodatacow as the default
mount -o nodatacow /dev/sdb1 /database-volume
```

### ZFS Transaction Groups

ZFS uses a similar COW mechanism but groups writes into transaction groups (TXGs):

- All writes within a TXG are committed together atomically.
- TXG commits happen every 5 seconds by default (configurable).
- A sync write (`O_SYNC` or `fsync`) forces an immediate TXG commit.

```bash
# ZFS TXG commit interval (default: 5 seconds)
zfs get sync tank/data
# tank/data  sync  standard  default

# Force synchronous writes for maximum durability
zfs set sync=always tank/data

# Disable sync (maximum performance, data loss risk)
zfs set sync=disabled tank/data

# Use SLOG (separate intent log) for fast synchronous writes
# SLOG device should be low-latency (NVMe or RAM-backed ZIL)
zpool add tank log /dev/nvme0n1p1
```

## Section 5: fsync, fdatasync, and msync

### fsync

`fsync(fd)` flushes both the file's data AND metadata to persistent storage.

What `fsync` does:
1. Flushes all dirty data pages for the file from the page cache to disk.
2. Updates the inode (metadata: mtime, file size).
3. Sends a flush command to the storage device's write cache.
4. Returns only after all of the above are confirmed persistent.

```c
int fd = open("data.bin", O_WRONLY | O_CREAT);
write(fd, data, len);
fsync(fd);    // Data AND metadata are now persistent
close(fd);
```

**Cost of fsync**: 1-10ms on spinning disk, 0.1-1ms on SSD, 0.01-0.1ms on NVMe.

### fdatasync

`fdatasync(fd)` flushes data but only flushes metadata if it is required for data integrity.

What `fdatasync` does vs `fsync`:
- Flushes data pages (same as `fsync`).
- Flushes metadata ONLY if metadata is needed to correctly read the data (e.g., file size increase requires flushing the inode to reflect the new size).
- Does NOT flush metadata that doesn't affect data integrity (e.g., mtime, atime).

```c
// For a database write-ahead log:
write(fd, wal_entry, wal_entry_len);
fdatasync(fd);   // Faster than fsync: skips atime/mtime update to disk
```

**When to use fdatasync vs fsync**:
- Use `fdatasync` for write-ahead logs and data files where you control the write patterns.
- Use `fsync` when metadata (like mtime) must be durable (e.g., for replication or backup consistency).

### msync

`msync` is the equivalent of `fsync` for memory-mapped files:

```c
void *addr = mmap(NULL, file_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);

// Write via memory-mapped region
memcpy(addr + offset, data, len);

// Flush to disk
msync(addr + offset, len, MS_SYNC);    // Synchronous flush
// OR
msync(addr + offset, len, MS_ASYNC);   // Queue flush, don't wait
```

**MS_SYNC**: Blocks until the data is written to disk.
**MS_ASYNC**: Queues the write but returns immediately. Does NOT guarantee durability.

### Benchmarking Sync Operations

```go
package main

import (
    "fmt"
    "os"
    "time"
)

func benchmarkWrite(filename string, useSync bool, iterations int) time.Duration {
    f, err := os.OpenFile(filename, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
    if err != nil {
        panic(err)
    }
    defer f.Close()

    data := make([]byte, 4096)  // 4KB write
    start := time.Now()

    for i := 0; i < iterations; i++ {
        if _, err := f.Write(data); err != nil {
            panic(err)
        }
        if useSync {
            if err := f.Sync(); err != nil {  // fsync
                panic(err)
            }
        }
    }

    if !useSync {
        f.Sync()  // Final sync for buffered case
    }

    return time.Since(start)
}

func main() {
    const iters = 1000
    withSync := benchmarkWrite("/tmp/test-sync.bin", true, iters)
    withoutSync := benchmarkWrite("/tmp/test-nosync.bin", false, iters)

    fmt.Printf("With fsync per write:    %v (%.0f IOPS)\n",
        withSync, float64(iters)/withSync.Seconds())
    fmt.Printf("Without fsync per write: %v (%.0f IOPS)\n",
        withoutSync, float64(iters)/withoutSync.Seconds())
}
```

Typical results:
```
With fsync per write:    2.847s    (351 IOPS)    ← NVMe SSD
Without fsync per write: 0.012s    (83,333 IOPS)
```

This 240x difference explains why databases batch writes and group fsync calls.

## Section 6: O_DIRECT and O_SYNC

### O_DIRECT — Bypassing the Page Cache

`O_DIRECT` opens a file with direct I/O: reads and writes bypass the kernel page cache and go directly to/from the storage device.

Requirements:
- Buffer must be aligned to the logical block size (usually 512 bytes or 4096 bytes).
- I/O size must be a multiple of the logical block size.

```c
int fd = open("data.bin", O_RDWR | O_DIRECT | O_CREAT, 0644);

// Must use aligned memory (posix_memalign or aligned_alloc)
void *buf;
posix_memalign(&buf, 4096, 4096);

// Write directly to disk (no page cache)
pwrite(fd, buf, 4096, 0);
// Note: O_DIRECT does NOT imply durability!
// The write goes directly to the storage controller's volatile cache.
// A separate fdatasync/fsync is needed for durability.
```

**Why databases use O_DIRECT**:
1. **Avoid double buffering**: Databases have their own buffer pool. Caching in the OS page cache wastes RAM.
2. **Control over I/O ordering**: With O_DIRECT, the database controls exactly when data reaches the device.
3. **Predictable performance**: Avoids page cache eviction causing unexpected I/O.

### O_SYNC — Synchronous Writes

`O_SYNC` causes every `write` call to behave like `write` + `fdatasync`:

```c
int fd = open("wal.log", O_WRONLY | O_APPEND | O_SYNC, 0644);
write(fd, entry, entry_len);   // Blocks until data is on disk
// No separate fsync needed — each write is already synchronous
```

`O_DSYNC` is the equivalent of `write` + `fdatasync` (skips mtime/atime flush):

```c
int fd = open("wal.log", O_WRONLY | O_APPEND | O_DSYNC, 0644);
```

**Performance comparison**:

```bash
# Test O_SYNC performance
dd if=/dev/zero of=/tmp/test bs=4k count=10000 oflag=sync
# ~350-3500 IOPS depending on storage type

# Without O_SYNC
dd if=/dev/zero of=/tmp/test bs=4k count=10000
# ~100,000+ IOPS (page cache)
```

## Section 7: Database Write Barrier Behavior

### PostgreSQL WAL and fsync

PostgreSQL uses a write-ahead log (WAL) to ensure crash consistency. The WAL write path:

1. Write WAL record to WAL buffer in shared memory.
2. On transaction commit: flush WAL buffer to WAL file.
3. Call `fdatasync` on the WAL file.
4. Return success to the client.

Only after step 4 can PostgreSQL guarantee the transaction is durable.

```sql
-- Check PostgreSQL fsync configuration
SHOW fsync;            -- Should be 'on' for durability
SHOW synchronous_commit; -- 'on' = wait for WAL fsync before commit ack

-- Tuning for performance vs durability tradeoff
-- DANGEROUS: disables fsync (data loss risk on power failure)
-- fsync = off

-- Asynchronous commit (transactions may be lost within ~200ms window)
SET synchronous_commit = 'off';

-- Per-database setting
ALTER DATABASE mydb SET synchronous_commit = 'off';
```

### PostgreSQL wal_sync_method

PostgreSQL supports multiple methods for WAL flushing:

```
wal_sync_method options:
- open_datasync     Uses O_DSYNC flag — per-write sync (no separate fsync needed)
- fdatasync         Uses fdatasync() after each WAL write (default on Linux)
- fsync             Uses fsync() after each WAL write (slower than fdatasync)
- fsync_writethrough Uses fcntl(F_FULLFSYNC) on macOS (forces through all caches)
- open_sync         Uses O_SYNC flag
```

For NVMe storage, `fdatasync` is typically fastest:

```
# postgresql.conf
wal_sync_method = fdatasync
```

### MySQL InnoDB Flush Methods

MySQL InnoDB has its own configuration for flush behavior:

```ini
# innodb_flush_method options:
# fsync     (default) Use fsync() for both data and log files
# O_DSYNC   Use O_DSYNC for log files, fsync for data files
# O_DIRECT  Use O_DIRECT for data files (bypass page cache), fsync for log files
# O_DIRECT_NO_FSYNC (performance) O_DIRECT without fsync (dangerous!)

[mysqld]
innodb_flush_method = O_DIRECT        # Recommended for dedicated DB servers
innodb_flush_log_at_trx_commit = 1    # 1 = fsync per commit (ACID)
                                      # 2 = fsync per second (performance, 1s data loss)
                                      # 0 = no fsync (maximum performance, maximum risk)
```

**innodb_flush_log_at_trx_commit = 1** is mandatory for ACID compliance. Settings of 0 or 2 can cause data loss on power failure.

### SQLite WAL Mode

SQLite WAL (Write-Ahead Logging) mode provides improved concurrency and crash consistency:

```sql
-- Enable WAL mode
PRAGMA journal_mode = WAL;

-- Configure sync mode
PRAGMA synchronous = FULL;    -- fsync after every write (most safe)
-- PRAGMA synchronous = NORMAL;  -- fsync at checkpoints (default in WAL mode)
-- PRAGMA synchronous = OFF;     -- No fsync (fastest, data loss risk)

-- WAL checkpoint (flush WAL to main database file)
PRAGMA wal_checkpoint(TRUNCATE);
```

## Section 8: Atomic File Replacement Pattern

A common pattern for atomically replacing a file (used by editors, configuration management tools, and databases):

### The fsync-rename Pattern

```go
package main

import (
    "fmt"
    "os"
    "path/filepath"
)

// AtomicWrite writes data to a file atomically using fsync + rename.
// After this function returns successfully, the file either contains
// all of the new data or all of the old data — never a partial write.
func AtomicWrite(path string, data []byte, perm os.FileMode) error {
    dir := filepath.Dir(path)

    // Step 1: Write to a temporary file in the same directory
    tmpFile, err := os.CreateTemp(dir, ".tmp-")
    if err != nil {
        return fmt.Errorf("create temp file: %w", err)
    }
    tmpPath := tmpFile.Name()

    // Cleanup on failure
    success := false
    defer func() {
        if !success {
            os.Remove(tmpPath)
        }
    }()

    // Step 2: Write data to temp file
    if _, err := tmpFile.Write(data); err != nil {
        tmpFile.Close()
        return fmt.Errorf("write temp file: %w", err)
    }

    // Step 3: fsync the temp file (data is now durable)
    if err := tmpFile.Sync(); err != nil {
        tmpFile.Close()
        return fmt.Errorf("sync temp file: %w", err)
    }

    if err := tmpFile.Close(); err != nil {
        return fmt.Errorf("close temp file: %w", err)
    }

    // Step 4: Set permissions
    if err := os.Chmod(tmpPath, perm); err != nil {
        return fmt.Errorf("chmod temp file: %w", err)
    }

    // Step 5: Rename into final position (atomic on POSIX systems)
    if err := os.Rename(tmpPath, path); err != nil {
        return fmt.Errorf("rename: %w", err)
    }

    // Step 6: fsync the directory (required to persist the directory entry)
    dirFd, err := os.Open(dir)
    if err != nil {
        return fmt.Errorf("open dir: %w", err)
    }
    defer dirFd.Close()

    if err := dirFd.Sync(); err != nil {
        // Non-fatal on some filesystems — log but don't fail
        // On ext4 with data=ordered, the rename is still durable
        _ = err
    }

    success = true
    return nil
}
```

Why step 6 (directory fsync) matters:
- The `rename()` syscall is atomic: it either completes or doesn't.
- But the rename operation itself (updating the directory entry) may not be durable until the directory is fsynced.
- On ext4 `data=ordered`, metadata commits are ordered, so the rename is eventually durable without directory fsync.
- For maximum correctness, always fsync the directory after a rename.

## Section 9: Kubernetes Persistent Volume Considerations

### StorageClass Configuration for Durability

```yaml
# StorageClass for databases (maximum durability)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd-database
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  # Enable encryption (at rest)
  encrypted: "true"
reclaimPolicy: Retain   # Don't delete data when PVC is deleted
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
mountOptions:
- data=ordered    # ext4 journaling mode
- barrier=1       # Enable write barriers
- noatime         # Don't update access times (reduces write I/O)
- nodiratime      # Don't update directory access times
```

### PostgreSQL on Kubernetes Durability

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
spec:
  template:
    spec:
      containers:
      - name: postgresql
        image: postgres:16
        env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        # For btrfs volumes, disable COW on the data directory
        lifecycle:
          postStart:
            exec:
              command:
              - /bin/bash
              - -c
              - chattr +C /var/lib/postgresql/data/pgdata || true
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd-database
      resources:
        requests:
          storage: 100Gi
```

## Section 10: Testing Crash Consistency

### dm-flakey for Crash Simulation

Linux device mapper's `flakey` target simulates storage failures for testing crash consistency:

```bash
# Create a flakey device that fails every 10 seconds for 2 seconds
dmsetup create flakey-test --table "0 $(blockdev --getsz /dev/loop0) flakey /dev/loop0 0 10 2"

# Run database on the flakey device
# The device will simulate power loss periodically

# Remove after testing
dmsetup remove flakey-test
```

### Testing with blkdiscard + fsck

```bash
# Test ext4 crash consistency by abruptly terminating writes
dd if=/dev/zero of=/dev/loop0 bs=1M count=100
mkfs.ext4 /dev/loop0
mount /dev/loop0 /mnt/test

# Write data and simulate crash (don't call fsync)
for i in {1..100}; do
  dd if=/dev/urandom of="/mnt/test/file$i" bs=4096 count=100 &
done
wait

# Unmount without sync (simulates crash)
umount -l /mnt/test    # Lazy unmount

# Check filesystem consistency
fsck.ext4 -n /dev/loop0
# Should report: clean (with journaling)
# vs: possibly inconsistent (without journaling)
```

## Summary

Crash consistency requires understanding the full stack from application to storage:

- **ext4 `data=ordered`**: The default — metadata is journaled, data is ordered before metadata commits. Provides a good balance of consistency and performance.

- **btrfs/ZFS COW**: Copy-on-write guarantees atomic multi-block updates. Disable COW for database files with `chattr +C` (btrfs) or `zfs set sync=always`.

- **`fsync` vs `fdatasync`**: `fdatasync` is faster for write-heavy workloads because it skips unnecessary metadata syncs. Use `fsync` when metadata durability (mtime) is required.

- **`O_DIRECT`**: Bypasses the page cache for database buffer pools. Does NOT guarantee durability — still requires `fdatasync` after direct writes.

- **The atomic write pattern**: `write to temp file → fsync temp file → rename → fsync directory` is the POSIX-portable way to atomically replace file content.

- **Database configuration**: Always set `innodb_flush_log_at_trx_commit=1` (MySQL) and `fsync=on` (PostgreSQL) for ACID compliance. The performance cost is real but unavoidable for true durability.
