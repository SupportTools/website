---
title: "Linux Storage Performance: io_uring, NVMe Optimization, and Storage Stack Tuning"
date: 2030-01-12T00:00:00-05:00
draft: false
tags: ["Linux", "Storage", "io_uring", "NVMe", "Performance", "fio", "I/O Scheduler"]
categories: ["Linux", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Modern Linux I/O with io_uring API, NVMe queue depth optimization, I/O scheduler selection (mq-deadline, kyber), storage stack tuning, and comprehensive benchmarking with fio for enterprise storage performance."
more_link: "yes"
url: "/linux-storage-performance-io-uring-nvme-optimization/"
---

Storage performance is increasingly the bottleneck in modern data-intensive workloads. NVMe SSDs can sustain millions of I/O operations per second, but the Linux storage stack — designed for rotational media — traditionally throttled this potential through kernel overhead, suboptimal queue depths, and legacy I/O paths. This guide covers the modern Linux storage stack, from the new io_uring interface that eliminates syscall overhead to NVMe queue depth tuning that extracts maximum IOPS from NVMe hardware.

<!--more-->

# Linux Storage Performance: io_uring, NVMe Optimization, and Storage Stack Tuning

## The Linux Storage Stack

Understanding the storage stack layers helps identify where optimization opportunities exist:

```
Application
    │  syscall: read()/write()/pread()/pwrite()    ← Traditional path
    │  OR: io_uring submission queue entry         ← Modern path (Linux 5.1+)
    ▼
VFS (Virtual File System)
    ▼
Page Cache (if cached I/O)
    │
    ▼ (for direct I/O or when cache is bypassed)
Block Layer
    ├── I/O Scheduler (mq-deadline, kyber, none)
    ├── Request Queue (multi-queue)
    └── Block Device Driver (NVMe, SATA, etc.)
    ▼
Physical Storage
```

Each layer adds overhead. Understanding this stack allows you to:
- Choose the right layer to bypass for your workload
- Select the appropriate I/O scheduler
- Tune buffer sizes and queue depths

## Part 1: io_uring - The Modern I/O Interface

### Why io_uring Matters

Traditional POSIX I/O (read/write) requires a syscall for every operation. At 1M+ IOPS (achievable on modern NVMe), syscall overhead becomes significant:
- Each syscall: ~100-200ns overhead (context switch cost)
- At 1M IOPS: 100-200ms/second just in syscall overhead (10-20% CPU)

io_uring eliminates most syscall overhead by using two shared ring buffers between kernel and userspace:
- **Submission Queue (SQ)**: userspace writes I/O requests
- **Completion Queue (CQ)**: kernel writes I/O completions

With SQPOLL mode, the kernel continuously polls the submission queue from a dedicated kernel thread, eliminating the need to make a `io_uring_enter` syscall for submission at all.

### Benchmarking Traditional vs io_uring

```bash
# Install fio with io_uring support
apt-get install -y fio

# Verify io_uring is supported
cat /proc/sys/kernel/io_uring_disabled  # Should be 0

# Test 1: Traditional O_SYNC writes (worst case)
fio --name=sync-write \
    --filename=/mnt/nvme/testfile \
    --direct=1 \
    --rw=randwrite \
    --bs=4k \
    --numjobs=4 \
    --runtime=30 \
    --iodepth=1 \
    --fsync=1 \
    --ioengine=sync \
    --group_reporting

# Test 2: io_uring with sqpoll
fio --name=uring-sqpoll \
    --filename=/mnt/nvme/testfile \
    --direct=1 \
    --rw=randwrite \
    --bs=4k \
    --numjobs=4 \
    --runtime=30 \
    --iodepth=64 \
    --ioengine=io_uring \
    --sqthread_poll=1 \
    --group_reporting

# Test 3: io_uring without sqpoll (still reduces copies)
fio --name=uring-normal \
    --filename=/mnt/nvme/testfile \
    --direct=1 \
    --rw=randwrite \
    --bs=4k \
    --numjobs=4 \
    --runtime=30 \
    --iodepth=64 \
    --ioengine=io_uring \
    --group_reporting
```

### io_uring Programming Interface

```c
/* io_uring_demo.c - io_uring I/O example */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <liburing.h>

#define QUEUE_DEPTH     256
#define BLOCK_SIZE      4096
#define NUM_BLOCKS      1000
#define FILE_PATH       "/tmp/io_uring_test"

struct io_context {
    int   fd;
    char *buf;
    off_t offset;
    int   block_num;
};

int main(void)
{
    struct io_uring ring;
    struct io_uring_params params;
    int    ret, fd;
    char  *buffers[QUEUE_DEPTH];
    struct io_context contexts[QUEUE_DEPTH];

    memset(&params, 0, sizeof(params));

    /* Enable SQPOLL for kernel-side polling (eliminates submit syscalls) */
    params.flags = IORING_SETUP_SQPOLL;
    params.sq_thread_idle = 2000;  /* ms before kernel thread sleeps */

    ret = io_uring_queue_init_params(QUEUE_DEPTH, &ring, &params);
    if (ret < 0) {
        fprintf(stderr, "io_uring_queue_init: %s\n", strerror(-ret));
        exit(1);
    }

    /* For SQPOLL, register the file descriptor to avoid per-op fd lookup */
    fd = open(FILE_PATH, O_RDWR | O_CREAT | O_TRUNC | O_DIRECT, 0644);
    if (fd < 0) {
        perror("open");
        exit(1);
    }

    /* Register fd with io_uring (required for SQPOLL) */
    ret = io_uring_register_files(&ring, &fd, 1);
    if (ret < 0) {
        fprintf(stderr, "io_uring_register_files: %s\n", strerror(-ret));
        exit(1);
    }

    /* Allocate and register buffers for zero-copy I/O */
    struct iovec iovecs[QUEUE_DEPTH];
    for (int i = 0; i < QUEUE_DEPTH; i++) {
        posix_memalign((void **)&buffers[i], 512, BLOCK_SIZE);
        memset(buffers[i], 'A' + (i % 26), BLOCK_SIZE);
        iovecs[i].iov_base = buffers[i];
        iovecs[i].iov_len  = BLOCK_SIZE;
    }

    /* Register buffers for zero-copy I/O */
    ret = io_uring_register_buffers(&ring, iovecs, QUEUE_DEPTH);
    if (ret < 0) {
        fprintf(stderr, "io_uring_register_buffers: %s\n", strerror(-ret));
        exit(1);
    }

    int submitted = 0, completed = 0;
    int inflight  = 0;
    int block_idx = 0;

    while (completed < NUM_BLOCKS) {
        /* Submit writes while we have capacity and blocks to write */
        while (inflight < QUEUE_DEPTH && block_idx < NUM_BLOCKS) {
            struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
            if (!sqe) break;

            int slot = block_idx % QUEUE_DEPTH;

            /* Use fixed buffer write for zero-copy (WRITE_FIXED) */
            io_uring_prep_write_fixed(sqe,
                0,                              /* fd index (registered) */
                buffers[slot],
                BLOCK_SIZE,
                (off_t)block_idx * BLOCK_SIZE,  /* offset */
                slot                            /* buffer index */
            );

            /* Use registered fd */
            sqe->flags = IOSQE_FIXED_FILE;

            /* User data for identifying completions */
            io_uring_sqe_set_data64(sqe, block_idx);

            block_idx++;
            inflight++;
        }

        /* Submit all queued operations */
        if (inflight > 0) {
            ret = io_uring_submit(&ring);
            if (ret < 0) {
                fprintf(stderr, "io_uring_submit: %s\n", strerror(-ret));
                break;
            }
        }

        /* Wait for at least one completion */
        struct io_uring_cqe *cqe;
        ret = io_uring_wait_cqe(&ring, &cqe);
        if (ret < 0) {
            fprintf(stderr, "io_uring_wait_cqe: %s\n", strerror(-ret));
            break;
        }

        /* Process completions */
        unsigned head;
        io_uring_for_each_cqe(&ring, head, cqe) {
            if (cqe->res < 0) {
                fprintf(stderr, "I/O error: %s\n", strerror(-cqe->res));
            } else {
                completed++;
                inflight--;
            }
        }
        io_uring_cq_advance(&ring, completed - (completed - inflight));
    }

    printf("Completed %d I/O operations\n", completed);

    /* Cleanup */
    io_uring_unregister_buffers(&ring);
    io_uring_unregister_files(&ring);
    io_uring_queue_exit(&ring);
    close(fd);

    /* Free buffers */
    for (int i = 0; i < QUEUE_DEPTH; i++) {
        free(buffers[i]);
    }

    return 0;
}
```

Compile and run:

```bash
gcc -O2 -o io_uring_demo io_uring_demo.c -luring
./io_uring_demo
```

### io_uring in Go Applications

```go
// pkg/storage/io_uring.go
// Using iceber/go-uring or lordwelch/go-uring for Go io_uring bindings

package storage

import (
    "fmt"
    "os"
    "unsafe"

    "github.com/iceber/iouring-go"
)

// IoURingFile provides high-performance file I/O using io_uring
type IoURingFile struct {
    ring   *iouring.IOURing
    fd     *os.File
    depth  uint
}

// NewIoURingFile opens a file with io_uring I/O
func NewIoURingFile(path string, depth uint) (*IoURingFile, error) {
    ring, err := iouring.New(depth,
        iouring.WithSQPoll(2000),  // 2 second SQPOLL idle timeout
    )
    if err != nil {
        return nil, fmt.Errorf("creating io_uring: %w", err)
    }

    fd, err := os.OpenFile(path,
        os.O_RDWR|os.O_CREATE|syscall.O_DIRECT, 0644)
    if err != nil {
        ring.Close()
        return nil, fmt.Errorf("opening file: %w", err)
    }

    return &IoURingFile{
        ring:  ring,
        fd:    fd,
        depth: depth,
    }, nil
}

// WriteAt writes data at the specified offset using io_uring
func (f *IoURingFile) WriteAt(buf []byte, offset int64) error {
    // Ensure buffer is aligned for O_DIRECT
    if uintptr(unsafe.Pointer(&buf[0]))%512 != 0 {
        return fmt.Errorf("buffer must be 512-byte aligned for O_DIRECT")
    }

    request, err := f.ring.WriteAt(f.fd, buf, offset)
    if err != nil {
        return fmt.Errorf("submitting write: %w", err)
    }

    result := <-request.Done()
    if err := result.Err(); err != nil {
        return fmt.Errorf("write failed: %w", err)
    }

    return nil
}

// Close closes the file and io_uring
func (f *IoURingFile) Close() error {
    if err := f.fd.Close(); err != nil {
        return err
    }
    return f.ring.Close()
}
```

## Part 2: NVMe Queue Depth Optimization

### Understanding NVMe Queues

NVMe replaces the single-queue AHCI model with multiple submission/completion queues, allowing parallel submission from multiple CPUs without lock contention:

```
NVMe Drive
├── Admin Queue (1 pair: 1 SQ + 1 CQ)
├── I/O Queue 0 (CPU 0)  → NVMe hardware queue
├── I/O Queue 1 (CPU 1)  → NVMe hardware queue
├── I/O Queue 2 (CPU 2)  → NVMe hardware queue
└── I/O Queue N (CPU N)  → NVMe hardware queue

Each queue can hold up to 65535 commands
```

### Checking NVMe Configuration

```bash
# List NVMe devices
nvme list
# Output: Node, SN, Model, Namespace, Usage, Format, FW Rev

# Check NVMe drive capabilities
nvme id-ctrl /dev/nvme0 | grep -E "sqes|cqes|nn|awun|awupf"

# Check current queue configuration
cat /sys/block/nvme0n1/queue/nr_requests    # Current queue depth
cat /sys/block/nvme0n1/queue/max_segments   # Max scatter-gather segments
cat /sys/block/nvme0n1/queue/scheduler      # Current I/O scheduler

# NVMe-specific stats
nvme smart-log /dev/nvme0
# Look for: media_errors, num_err_log_entries, percentage_used

# Check per-CPU queue assignment
ls /sys/block/nvme0n1/mq/
# Shows: 0/ 1/ 2/ 3/ ... (one directory per CPU queue)

# Check queue lengths
for queue in /sys/block/nvme0n1/mq/*/; do
    echo "Queue $(basename $queue): $(cat $queue/nr_tags) tags"
done
```

### NVMe Queue Depth Tuning

```bash
# Set queue depth (higher = better throughput, higher latency)
# Default is typically 256-1023, max is 65535
echo 1024 > /sys/block/nvme0n1/queue/nr_requests

# For latency-sensitive workloads (databases), lower depth
echo 64 > /sys/block/nvme0n1/queue/nr_requests

# Disable read-ahead for random I/O workloads
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb

# For sequential workloads, enable aggressive read-ahead
echo 2048 > /sys/block/nvme0n1/queue/read_ahead_kb

# Make settings persistent via udev rules
cat > /etc/udev/rules.d/99-nvme-performance.rules << 'EOF'
# NVMe performance tuning
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/nr_requests}="1024"
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/read_ahead_kb}="0"
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/add_random}="0"

# SATA SSD tuning
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/nr_requests}="256"

# HDD tuning
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/nr_requests}="128"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/read_ahead_kb}="8192"
EOF

# Reload udev rules
udevadm control --reload-rules
udevadm trigger
```

### NVMe Namespace Configuration

```bash
# Check namespace configuration
nvme id-ns /dev/nvme0n1

# Check block format (sector size)
nvme id-ns /dev/nvme0n1 | grep "^lbaf"
# lbaf 0 : ms:0, lbads:9, rp:0x2 (512B sectors)
# lbaf 1 : ms:0, lbads:12, rp:0 (4096B sectors, optimal for modern workloads)

# Reformat to 4K sectors (WARNING: destroys all data)
# nvme format /dev/nvme0 --lbaf=1 --ses=1

# Check current sector size
cat /sys/block/nvme0n1/queue/physical_block_size
cat /sys/block/nvme0n1/queue/logical_block_size
```

## Part 3: I/O Scheduler Selection

### Available Schedulers

Linux 5.0+ uses the multi-queue (blk-mq) framework. Available schedulers:

```bash
# List available schedulers
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# none - No scheduler: best for NVMe (driver handles all ordering)
# mq-deadline - Deadline-based: best for SATA SSDs and mixed workloads
# kyber - Token-based: best for mixed read/write with latency goals
# bfq - Budget Fair Queuing: best for desktop/multi-process fairness
```

### Scheduler Comparison

```bash
#!/bin/bash
# compare-schedulers.sh - Benchmark different I/O schedulers

DEVICE="${1:-/dev/nvme0n1}"
TEST_FILE="${DEVICE}"
RESULTS_DIR="scheduler-benchmarks"
mkdir -p "$RESULTS_DIR"

for scheduler in none mq-deadline kyber; do
    echo "Testing scheduler: $scheduler"

    # Set scheduler
    echo "$scheduler" > "/sys/block/$(basename $DEVICE)/queue/scheduler"
    sleep 1

    # Sequential read
    fio --name="seq-read-$scheduler" \
        --filename="$TEST_FILE" \
        --direct=1 \
        --rw=read \
        --bs=128k \
        --numjobs=1 \
        --runtime=10 \
        --iodepth=32 \
        --ioengine=io_uring \
        --output-format=json \
        --output="$RESULTS_DIR/seq-read-$scheduler.json" \
        2>/dev/null

    # Random 4K read IOPS
    fio --name="rand-read-$scheduler" \
        --filename="$TEST_FILE" \
        --direct=1 \
        --rw=randread \
        --bs=4k \
        --numjobs=8 \
        --runtime=10 \
        --iodepth=64 \
        --ioengine=io_uring \
        --output-format=json \
        --output="$RESULTS_DIR/rand-read-$scheduler.json" \
        2>/dev/null

    # Mixed 70/30
    fio --name="mixed-$scheduler" \
        --filename="$TEST_FILE" \
        --direct=1 \
        --rw=randrw \
        --rwmixread=70 \
        --bs=4k \
        --numjobs=4 \
        --runtime=10 \
        --iodepth=32 \
        --ioengine=io_uring \
        --output-format=json \
        --output="$RESULTS_DIR/mixed-$scheduler.json" \
        2>/dev/null
done

# Summary
echo ""
echo "=== Scheduler Benchmark Summary ==="
for scheduler in none mq-deadline kyber; do
    echo "--- $scheduler ---"
    if [ -f "$RESULTS_DIR/rand-read-$scheduler.json" ]; then
        jq -r '"  Random Read IOPS: " + (.jobs[0].read.iops | tostring)' \
            "$RESULTS_DIR/rand-read-$scheduler.json"
        jq -r '"  Random Read Lat (p99): " + (.jobs[0].read.lat_ns.percentile."99.000000" / 1000 | tostring) + "μs"' \
            "$RESULTS_DIR/rand-read-$scheduler.json"
    fi
done
```

## Part 4: Comprehensive fio Benchmarking

### Standard fio Test Suite

```bash
#!/bin/bash
# storage-benchmark-suite.sh - Complete storage performance benchmark

DEVICE="${1:-/dev/nvme0n1}"
RESULTS="benchmark-results-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS"

echo "=== Storage Benchmark Suite ===" | tee "$RESULTS/summary.txt"
echo "Device: $DEVICE" | tee -a "$RESULTS/summary.txt"
echo "Date: $(date)" | tee -a "$RESULTS/summary.txt"
echo "" | tee -a "$RESULTS/summary.txt"

run_fio() {
    local name="$1"
    shift
    echo "Running: $name"
    fio --name="$name" \
        --filename="$DEVICE" \
        --direct=1 \
        --output-format=json \
        --output="$RESULTS/$name.json" \
        "$@" 2>/dev/null

    # Extract key metrics
    jq -r '"  Read IOPS: " + (.jobs[0].read.iops|tostring) +
           ", Write IOPS: " + (.jobs[0].write.iops|tostring) +
           ", Read BW: " + (.jobs[0].read.bw_bytes/1048576|floor|tostring) + " MB/s" +
           ", Write BW: " + (.jobs[0].write.bw_bytes/1048576|floor|tostring) + " MB/s" +
           ", Read P99 Lat: " + (.jobs[0].read.lat_ns.percentile."99.000000"/1000|floor|tostring) + "μs"' \
        "$RESULTS/$name.json" | tee -a "$RESULTS/summary.txt"
}

# 1. Sequential read throughput
run_fio "seq-read-128k" \
    --rw=read --bs=128k --numjobs=4 --runtime=30 \
    --iodepth=64 --ioengine=io_uring

# 2. Sequential write throughput
run_fio "seq-write-128k" \
    --rw=write --bs=128k --numjobs=4 --runtime=30 \
    --iodepth=64 --ioengine=io_uring

# 3. Random 4K read IOPS (database read)
run_fio "rand-read-4k" \
    --rw=randread --bs=4k --numjobs=8 --runtime=30 \
    --iodepth=64 --ioengine=io_uring

# 4. Random 4K write IOPS
run_fio "rand-write-4k" \
    --rw=randwrite --bs=4k --numjobs=8 --runtime=30 \
    --iodepth=64 --ioengine=io_uring

# 5. Mixed random 70/30 read/write
run_fio "mixed-rw-4k" \
    --rw=randrw --rwmixread=70 --bs=4k --numjobs=4 --runtime=30 \
    --iodepth=32 --ioengine=io_uring

# 6. Latency-focused test (low queue depth = latency mode)
run_fio "latency-4k" \
    --rw=randread --bs=4k --numjobs=1 --runtime=30 \
    --iodepth=1 --ioengine=io_uring

# 7. Synchronous write (fsync after each write - worst case for DBs)
run_fio "sync-write-4k" \
    --rw=randwrite --bs=4k --numjobs=1 --runtime=30 \
    --iodepth=1 --ioengine=sync --fsync=1

# 8. Write throughput with large block sizes (backup workload)
run_fio "seq-write-1m" \
    --rw=write --bs=1m --numjobs=2 --runtime=30 \
    --iodepth=8 --ioengine=io_uring

echo ""
echo "Benchmark complete. Results in: $RESULTS/"
echo "Summary:"
cat "$RESULTS/summary.txt"
```

### Database-Specific Benchmarks

```bash
# PostgreSQL-style benchmark
# Simulates: 8K pages, random reads, sync writes with WAL

# OLTP read workload (hot data, in cache)
fio --name=postgres-cached-reads \
    --filename=/var/lib/postgresql/data/bench \
    --direct=0 \
    --rw=randread \
    --bs=8k \
    --numjobs=$(nproc) \
    --runtime=60 \
    --iodepth=8 \
    --ioengine=io_uring \
    --group_reporting

# WAL write workload (sequential, sync)
fio --name=postgres-wal-writes \
    --filename=/var/lib/postgresql/wal/bench \
    --direct=1 \
    --rw=write \
    --bs=8k \
    --numjobs=1 \
    --runtime=60 \
    --iodepth=4 \
    --ioengine=io_uring \
    --fdatasync=1 \
    --group_reporting

# Full checkpoint (bulk sequential write)
fio --name=postgres-checkpoint \
    --filename=/var/lib/postgresql/data/bench \
    --direct=1 \
    --rw=write \
    --bs=1m \
    --numjobs=4 \
    --runtime=30 \
    --iodepth=8 \
    --ioengine=io_uring \
    --group_reporting
```

## Part 5: Filesystem Tuning

### ext4 Performance Tuning

```bash
# Mount ext4 with performance options
# For NVMe: disable journal mode if you can afford data loss risk
# For databases: use data=ordered (default) or data=journal

# High-performance ext4 mount options
mount -o \
    noatime,\
    nodiratime,\
    data=ordered,\
    barrier=0,\        # Disable write barrier (DANGEROUS without UPS)
    commit=300,\       # Delay fsync commit (300s - risky for databases)
    inode_readahead_blks=64,\
    /dev/nvme0n1 /data

# Database-safe ext4 options (safety over performance)
mount -o \
    noatime,\
    nodiratime,\
    data=ordered,\
    barrier=1,\
    commit=5 \
    /dev/nvme0n1 /data

# Check current mount options
cat /proc/mounts | grep nvme
mount | grep nvme

# /etc/fstab entry for persistence
echo "/dev/nvme0n1 /data ext4 noatime,nodiratime,data=ordered,barrier=1 0 0" \
    >> /etc/fstab
```

### XFS for High-Performance Workloads

```bash
# Create XFS filesystem optimized for NVMe
# sunit/swidth match NVMe optimal I/O size
mkfs.xfs \
    -f \
    -L nvme-data \
    -d agcount=32,su=4096,sw=1 \
    -l size=128m,su=4096 \
    /dev/nvme0n1

# Mount XFS with performance options
mount -o \
    noatime,\
    nodiratime,\
    logbufs=8,\
    logbsize=256k,\
    allocsize=128m \
    /dev/nvme0n1 /data

# XFS defragmentation check
xfs_fsr -v /data  # Defragment XFS filesystem
xfs_db -c "freesp" /dev/nvme0n1  # Check free space fragmentation
```

## Part 6: Virtual Memory and Page Cache Tuning

```bash
# vm.dirty settings affect write-back behavior
# Lower dirty_ratio = more frequent flusher activity = more consistent latency
# Higher dirty_ratio = better write throughput (batching)

# For database servers (consistent latency):
sysctl -w vm.dirty_ratio=5
sysctl -w vm.dirty_background_ratio=2
sysctl -w vm.dirty_expire_centisecs=500     # 5 seconds
sysctl -w vm.dirty_writeback_centisecs=100  # 1 second

# For general workloads (higher throughput):
sysctl -w vm.dirty_ratio=20
sysctl -w vm.dirty_background_ratio=10
sysctl -w vm.dirty_expire_centisecs=3000    # 30 seconds
sysctl -w vm.dirty_writeback_centisecs=500  # 5 seconds

# Disable transparent hugepages for databases
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Swappiness (lower = prefer to keep app data in RAM)
sysctl -w vm.swappiness=10  # Default 60

# For databases with their own page cache management (PostgreSQL, MySQL):
sysctl -w vm.swappiness=1   # Near zero - avoid swapping application data

# Monitor page cache usage
free -h
cat /proc/meminfo | grep -E "Buffers|Cached|SwapCached|Active|Inactive"
```

## Part 7: Monitoring Storage Performance

```bash
#!/bin/bash
# storage-monitor.sh - Continuous storage performance monitoring

DEVICE="${1:-nvme0n1}"
INTERVAL="${2:-5}"

echo "=== Storage Performance Monitor: /dev/$DEVICE ==="

# Headers
printf "%-10s %-10s %-10s %-10s %-10s %-10s %-10s\n" \
    "Time" "Read_MB/s" "Write_MB/s" "Read_IOPS" "Write_IOPS" "Await_ms" "Util%"

while true; do
    # Use iostat for real-time stats
    iostat -x -y "$DEVICE" "$INTERVAL" 1 2>/dev/null | \
    awk -v dev="$DEVICE" '
    $1 == dev {
        printf "%-10s %-10.1f %-10.1f %-10.0f %-10.0f %-10.2f %-10.2f\n",
               strftime("%H:%M:%S"), $6/1024, $7/1024, $4, $5, $10, $12
    }'
done
```

### Prometheus Storage Metrics

```yaml
# node_exporter already exposes disk metrics, but for detailed NVMe:
# prometheus-nvme-exporter
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: nvme-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: nvme-exporter
  template:
    metadata:
      labels:
        app: nvme-exporter
    spec:
      hostPID: true
      containers:
        - name: nvme-exporter
          image: prometheuscommunity/node-exporter:latest
          args:
            - --collector.nvme
            - --collector.diskstats
            - --collector.filesystem
          securityContext:
            privileged: true
          volumeMounts:
            - name: dev
              mountPath: /dev
            - name: sys
              mountPath: /sys
      volumes:
        - name: dev
          hostPath:
            path: /dev
        - name: sys
          hostPath:
            path: /sys
      tolerations:
        - operator: Exists
```

## Part 8: Storage Performance Regression Testing

```bash
#!/bin/bash
# storage-regression-test.sh - Detect storage performance regressions

BASELINE_FILE="${1:-storage-baseline.json}"
THRESHOLD_PCT="${2:-20}"  # Alert if >20% slower than baseline

# Run benchmark
fio --name=regression-test \
    --filename=/dev/nvme0n1 \
    --direct=1 \
    --rw=randread \
    --bs=4k \
    --numjobs=4 \
    --runtime=30 \
    --iodepth=32 \
    --ioengine=io_uring \
    --output-format=json \
    --output=/tmp/current-perf.json 2>/dev/null

CURRENT_IOPS=$(jq '.jobs[0].read.iops' /tmp/current-perf.json)
CURRENT_LAT=$(jq '.jobs[0].read.lat_ns.percentile."99.000000"' /tmp/current-perf.json)

if [ -f "$BASELINE_FILE" ]; then
    BASELINE_IOPS=$(jq '.jobs[0].read.iops' "$BASELINE_FILE")
    BASELINE_LAT=$(jq '.jobs[0].read.lat_ns.percentile."99.000000"' "$BASELINE_FILE")

    IOPS_CHANGE=$(echo "scale=2; (($CURRENT_IOPS - $BASELINE_IOPS) / $BASELINE_IOPS) * 100" | bc)
    LAT_CHANGE=$(echo "scale=2; (($CURRENT_LAT - $BASELINE_LAT) / $BASELINE_LAT) * 100" | bc)

    echo "IOPS: $CURRENT_IOPS (baseline: $BASELINE_IOPS, change: ${IOPS_CHANGE}%)"
    echo "P99 Latency: ${CURRENT_LAT}ns (baseline: ${BASELINE_LAT}ns, change: ${LAT_CHANGE}%)"

    # Alert on regression
    if (( $(echo "$IOPS_CHANGE < -$THRESHOLD_PCT" | bc -l) )); then
        echo "REGRESSION: IOPS dropped by ${IOPS_CHANGE}%"
        exit 1
    fi
    if (( $(echo "$LAT_CHANGE > $THRESHOLD_PCT" | bc -l) )); then
        echo "REGRESSION: Latency increased by ${LAT_CHANGE}%"
        exit 1
    fi
    echo "PASS: Storage performance within acceptable range"
else
    echo "No baseline found. Saving current results as baseline."
    cp /tmp/current-perf.json "$BASELINE_FILE"
fi
```

## Key Takeaways

Linux storage performance optimization requires understanding the complete stack from the physical device to the application I/O interface.

**io_uring is the right choice for new high-performance applications**: the elimination of per-operation syscall overhead is significant at NVMe IOPS levels. For existing applications, libaio with O_DIRECT is still effective, but io_uring provides better CPU efficiency.

**NVMe drives should use the `none` scheduler**: NVMe drives have their own sophisticated internal scheduling across multiple hardware queues. Adding a kernel-level scheduler on top creates overhead without benefit. For SATA SSDs, `mq-deadline` provides reasonable latency guarantees.

**Queue depth has a U-shaped performance curve**: too low and you do not saturate the drive; too high and you increase tail latency without improving throughput. For latency-sensitive databases, keep queue depth at 32-64. For throughput-oriented batch workloads, 256+ is appropriate.

**fio is the definitive storage benchmark tool**: always benchmark your specific workload pattern (block size, read/write ratio, sequential vs random) rather than relying on generic numbers. A drive that excels at sequential reads may perform poorly at the 4K random write pattern your database generates.

**vm.dirty settings matter more than most engineers realize**: the default dirty_ratio of 20% means the kernel can buffer up to 20% of RAM as dirty pages before forcing writeback. For a server with 256GB RAM, this is 51GB of writes that could be lost in a power failure and 51GB that must be flushed on system shutdown.
