---
title: "Linux Filesystem Performance: io_uring, Direct I/O, Page Cache Tuning, and Storage Benchmarking"
date: 2028-08-14T00:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "io_uring", "Direct I/O", "Performance", "Benchmarking"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux filesystem performance. Covers io_uring async I/O, Direct I/O vs buffered I/O, page cache tuning, filesystem selection, and storage benchmarking with fio, iostat, and BPF tools."
more_link: "yes"
url: "/linux-filesystem-io-uring-direct-io-guide/"
---

Linux filesystem performance is a deep subject that most engineers only encounter when something is catastrophically slow. By then, the diagnosis is made harder by a lack of baseline data and a poor understanding of the layers involved. This guide covers the full stack: from `io_uring` async I/O to Direct I/O semantics, page cache behavior, VFS tuning, filesystem selection, and how to benchmark storage correctly so your numbers actually reflect production workloads.

<!--more-->

# [Linux Filesystem Performance](#linux-filesystem-performance)

## Section 1: The Linux I/O Stack

Before tuning anything, understand what happens when your application calls `write()`:

```
Application
    → glibc (buffering, stdio)
    → System call interface (write/pread/io_uring)
    → VFS (Virtual Filesystem Layer)
    → Filesystem (ext4/xfs/btrfs)
    → Page cache
    → Block layer (elevator, request queue)
    → Block device driver
    → Storage hardware
```

Each layer adds overhead and introduces tuning knobs. The key insight is that removing layers entirely (Direct I/O, io_uring with fixed buffers) is often more effective than tuning individual layers.

### I/O Modes Overview

| Mode | Data path | Kernel copies | Best for |
|---|---|---|---|
| Buffered I/O | Page cache | Yes | Sequential reads, shared data |
| Direct I/O | Bypass page cache | No | Databases, large files |
| Memory-mapped I/O | Page cache | Zero-copy read | Random access patterns |
| io_uring async | Configurable | No (sqpoll) | High-IOPS, low-latency |

## Section 2: io_uring — The Modern Async I/O Interface

`io_uring` was introduced in Linux 5.1 and has fundamentally changed high-performance I/O. Unlike the older `aio` interface, io_uring is truly zero-copy with kernel polling modes that eliminate system call overhead entirely.

### How io_uring Works

io_uring uses two ring buffers shared between kernel and userspace:
- **Submission Queue (SQ)**: Userspace writes I/O requests here
- **Completion Queue (CQ)**: Kernel writes completed results here

In `SQPOLL` mode, a kernel thread polls the submission queue, eliminating the `io_uring_enter()` system call entirely.

### Basic io_uring Usage in C

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <liburing.h>

#define QUEUE_DEPTH 64
#define BLOCK_SIZE  (64 * 1024)  /* 64KB */
#define FILE_SIZE   (1024 * 1024 * 1024)  /* 1GB */

int main(int argc, char *argv[]) {
    struct io_uring ring;
    struct io_uring_sqe *sqe;
    struct io_uring_cqe *cqe;
    int fd, ret;
    char *buf;
    off_t offset = 0;
    int inflight = 0;
    long long total_bytes = 0;

    if (argc < 2) {
        fprintf(stderr, "Usage: %s <file>\n", argv[0]);
        return 1;
    }

    fd = open(argv[1], O_RDONLY | O_DIRECT);
    if (fd < 0) {
        perror("open");
        return 1;
    }

    /* Initialize io_uring with kernel submission queue polling */
    struct io_uring_params params = {};
    params.flags = IORING_SETUP_SQPOLL;
    params.sq_thread_idle = 2000; /* ms before SQ thread sleeps */

    ret = io_uring_queue_init_params(QUEUE_DEPTH, &ring, &params);
    if (ret < 0) {
        fprintf(stderr, "io_uring_queue_init: %s\n", strerror(-ret));
        /* Fall back without SQPOLL */
        ret = io_uring_queue_init(QUEUE_DEPTH, &ring, 0);
        if (ret < 0) {
            perror("io_uring_queue_init");
            return 1;
        }
    }

    /* Allocate aligned buffer for Direct I/O */
    if (posix_memalign((void **)&buf, 4096, BLOCK_SIZE) != 0) {
        perror("posix_memalign");
        return 1;
    }

    /* Register fixed buffer to avoid kernel mapping on each I/O */
    struct iovec iov = { .iov_base = buf, .iov_len = BLOCK_SIZE };
    ret = io_uring_register_buffers(&ring, &iov, 1);
    if (ret < 0) {
        fprintf(stderr, "io_uring_register_buffers: %s (continuing without)\n",
                strerror(-ret));
    }

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    /* Submit initial batch */
    while (inflight < QUEUE_DEPTH / 2 && offset < FILE_SIZE) {
        sqe = io_uring_get_sqe(&ring);
        if (!sqe) break;

        if (ret == 0) {
            /* Use registered fixed buffer */
            io_uring_prep_read_fixed(sqe, fd, buf, BLOCK_SIZE, offset, 0);
        } else {
            io_uring_prep_read(sqe, fd, buf, BLOCK_SIZE, offset);
        }
        sqe->user_data = offset;

        offset += BLOCK_SIZE;
        inflight++;
    }
    io_uring_submit(&ring);

    /* Drain completion queue and submit new requests */
    while (inflight > 0 || offset < FILE_SIZE) {
        ret = io_uring_wait_cqe(&ring, &cqe);
        if (ret < 0) {
            fprintf(stderr, "io_uring_wait_cqe: %s\n", strerror(-ret));
            break;
        }

        if (cqe->res < 0) {
            fprintf(stderr, "I/O error at offset %llu: %s\n",
                    (unsigned long long)cqe->user_data,
                    strerror(-cqe->res));
        } else {
            total_bytes += cqe->res;
        }

        io_uring_cqe_seen(&ring, cqe);
        inflight--;

        /* Submit next request */
        if (offset < FILE_SIZE) {
            sqe = io_uring_get_sqe(&ring);
            if (sqe) {
                io_uring_prep_read(sqe, fd, buf, BLOCK_SIZE, offset);
                sqe->user_data = offset;
                offset += BLOCK_SIZE;
                inflight++;
                io_uring_submit(&ring);
            }
        }
    }

    clock_gettime(CLOCK_MONOTONIC, &end);
    double elapsed = (end.tv_sec - start.tv_sec) +
                     (end.tv_nsec - start.tv_nsec) / 1e9;
    printf("Read %.2f GB in %.2fs = %.2f GB/s\n",
           total_bytes / 1e9, elapsed, (total_bytes / 1e9) / elapsed);

    io_uring_queue_exit(&ring);
    free(buf);
    close(fd);
    return 0;
}
```

### io_uring in Go with the uring Package

```go
// iouring_example.go
package main

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

// Minimal io_uring syscall wrappers
// In production, use github.com/iceber/iouring-go or tidwall/neco

const (
    IORING_OP_READ       = 22
    IORING_OP_WRITE      = 23
    IORING_SETUP_SQPOLL  = 2
    IORING_ENTER_SQ_WAIT = 2
)

type IoUringSQE struct {
    Opcode   uint8
    Flags    uint8
    IoPrio   uint16
    Fd       int32
    Off      uint64
    Addr     uint64
    Len      uint32
    OpFlags  uint32
    UserData uint64
    _pad2    [3]uint64
}

type IoUringCQE struct {
    UserData uint64
    Res      int32
    Flags    uint32
}

func ioUringSetup(entries uint32, params *[128]byte) (int, error) {
    fd, _, errno := syscall.Syscall(
        426, // __NR_io_uring_setup
        uintptr(entries),
        uintptr(unsafe.Pointer(params)),
        0,
    )
    if errno != 0 {
        return 0, errno
    }
    return int(fd), nil
}

// In production Go code, use a higher-level library
// This demonstrates the system call layer

func main() {
    // High-level usage via github.com/iceber/iouring-go
    fmt.Println("io_uring requires kernel 5.1+")

    // Check kernel support
    var uname syscall.Utsname
    syscall.Uname(&uname)
    fmt.Printf("Kernel: %s\n", int8SliceToString(uname.Release[:]))

    // Demonstrate Direct I/O setup
    demonstrateDirectIO()
}

func demonstrateDirectIO() {
    filename := "/tmp/test_direct_io"

    // Create test file
    f, err := os.Create(filename)
    if err != nil {
        fmt.Println("create:", err)
        return
    }
    defer os.Remove(filename)

    // Write 4MB of data
    data := make([]byte, 4*1024*1024)
    for i := range data {
        data[i] = byte(i % 256)
    }
    f.Write(data)
    f.Close()

    // Open with O_DIRECT
    fd, err := syscall.Open(filename, syscall.O_RDONLY|syscall.O_DIRECT, 0)
    if err != nil {
        fmt.Println("O_DIRECT open failed:", err)
        fmt.Println("Note: O_DIRECT requires 512-byte aligned buffers and offsets")
        return
    }
    defer syscall.Close(fd)

    // Allocate 512-byte aligned buffer
    // Note: Go does not have posix_memalign, use cgo or mmap trick
    pageSize := os.Getpagesize()
    bufSize := 4096
    rawBuf := make([]byte, bufSize+pageSize)
    alignedOffset := pageSize - (int(uintptr(unsafe.Pointer(&rawBuf[0]))) % pageSize)
    buf := rawBuf[alignedOffset : alignedOffset+bufSize]

    n, err := syscall.Read(fd, buf)
    if err != nil {
        fmt.Println("direct read:", err)
        return
    }
    fmt.Printf("Direct I/O: read %d bytes\n", n)
}

func int8SliceToString(s []int8) string {
    b := make([]byte, len(s))
    for i, v := range s {
        if v == 0 {
            return string(b[:i])
        }
        b[i] = byte(v)
    }
    return string(b)
}
```

## Section 3: Direct I/O vs Buffered I/O

Direct I/O bypasses the page cache entirely. This is essential for databases (PostgreSQL, MySQL, ClickHouse) because they manage their own cache and do not benefit from the page cache — they actually suffer from it due to double-caching.

### When to Use Direct I/O

**Use Direct I/O when:**
- You are writing a database or cache that manages its own buffer pool
- You are streaming large files sequentially (backups, ETL jobs) where caching gives no benefit
- You need predictable, cache-cold latency in benchmarks
- Memory pressure from page cache is evicting more valuable data

**Use buffered I/O when:**
- Multiple processes read the same files repeatedly
- Your access pattern is random small reads (page cache prefetch helps)
- Your application has no internal buffer management

### Demonstrating Cache Effects

```bash
# Write 4GB file with buffered I/O (fast due to page cache)
time dd if=/dev/zero of=/data/test.bin bs=1M count=4096
# Sync and drop caches
sync && echo 3 > /proc/sys/vm/drop_caches

# Read with buffered I/O (cold)
time dd if=/data/test.bin of=/dev/null bs=1M
# Read again (warm — page cache hit)
time dd if=/data/test.bin of=/dev/null bs=1M

# Read with Direct I/O (always cold, bypasses cache)
time dd if=/data/test.bin of=/dev/null bs=1M iflag=direct
```

### Page Cache Statistics

```bash
# View page cache usage
cat /proc/meminfo | grep -E 'Cached|Buffers|MemFree|MemAvailable'

# Per-file page cache status with vmtouch
vmtouch -v /data/postgres/base/16384/1259
# vmtouch -t /data/hot-files/  # Pre-warm cache

# Detailed cache stats
cat /proc/sys/vm/stat_interval
cat /sys/kernel/debug/bdi/*/stats  # Writeback stats per device

# Watch page cache reclaim
watch -n1 'sar -B 1 1'
```

## Section 4: Page Cache Tuning

### vm.dirty Parameters

The dirty page writeback parameters are the most impactful for write-heavy workloads:

```bash
# /etc/sysctl.d/99-filesystem.conf

# Ratio of total memory that can be dirty before BLOCKING writes
# Default: 20 (20%) — too high for databases, reduces predictability
vm.dirty_ratio = 10

# Ratio triggering background writeback (non-blocking)
# Default: 10 (10%)
vm.dirty_background_ratio = 5

# For systems with large RAM, use absolute bytes instead
# (overrides ratio settings)
# vm.dirty_bytes = 4294967296      # 4GB
# vm.dirty_background_bytes = 1073741824  # 1GB

# Time dirty pages can stay dirty before forced writeback (centiseconds)
# Default: 3000 (30 seconds) — too long for databases
vm.dirty_expire_centisecs = 1500   # 15 seconds

# How often pdflush/kworker scans for dirty pages (centiseconds)
# Default: 500 (5 seconds)
vm.dirty_writeback_centisecs = 200  # 2 seconds

# Don't aggressively reclaim page cache — important for databases
# Default: 60
vm.swappiness = 10

# Minimum memory ratio kept free for kernel use
# Default: 67 — increase if OOM killer is triggering unexpectedly
vm.min_free_kbytes = 524288  # 512MB for large systems

# Disable transparent huge pages for databases
# (set in /sys/kernel/mm/transparent_hugepage/enabled)
```

```bash
# Apply sysctl settings
sysctl -p /etc/sysctl.d/99-filesystem.conf

# Disable THP at runtime
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# For databases: lock memory to prevent swapping
# In systemd service file:
# LimitMEMLOCK=infinity
```

### Read-Ahead Tuning

```bash
# Check current read-ahead settings
blockdev --getra /dev/nvme0n1
# Returns: 256 (128KB default)

# Set read-ahead for sequential streaming workloads
blockdev --setra 4096 /dev/nvme0n1  # 2MB
# For random I/O workloads (databases), disable read-ahead
blockdev --setra 0 /dev/nvme0n1

# Persistent via udev rule
cat > /etc/udev/rules.d/60-block-readahead.rules << 'EOF'
# NVMe: minimal read-ahead for database workloads
SUBSYSTEM=="block", KERNEL=="nvme[0-9]n[0-9]", ACTION=="add|change", \
    ATTR{queue/read_ahead_kb}="128"

# HDDs: larger read-ahead for sequential workloads
SUBSYSTEM=="block", KERNEL=="sd[a-z]", ACTION=="add|change", \
    ATTR{queue/read_ahead_kb}="2048"
EOF

# Reload udev
udevadm control --reload-rules
udevadm trigger
```

## Section 5: I/O Scheduler Tuning

```bash
# Check available schedulers
cat /sys/block/nvme0n1/queue/scheduler
# Output: [none] mq-deadline kyber bfq

# NVMe: use none (no scheduler needed — device handles ordering)
echo none > /sys/block/nvme0n1/queue/scheduler

# SATA SSD: use mq-deadline
echo mq-deadline > /sys/block/sda/queue/scheduler

# HDD: use bfq for interactive systems, mq-deadline for servers
echo bfq > /sys/block/sdb/queue/scheduler

# Check queue depth
cat /sys/block/nvme0n1/queue/nr_requests
# Default: 64 for NVMe — increase for high-IOPS workloads
echo 1024 > /sys/block/nvme0n1/queue/nr_requests

# Disable merging for random I/O workloads
echo 0 > /sys/block/nvme0n1/queue/nomerges

# Persistent via udev
cat > /etc/udev/rules.d/60-ioscheduler.rules << 'EOF'
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq"
EOF
```

## Section 6: Filesystem Selection and Tuning

### ext4 Tuning

```bash
# Mount options for database workloads
# /etc/fstab
/dev/nvme0n1p1 /data ext4 \
    noatime,nodiratime,\
    data=ordered,\
    barrier=1,\
    errors=remount-ro 0 2

# Mount options for high-throughput sequential
/dev/nvme0n1p2 /logs ext4 \
    noatime,nodiratime,\
    data=writeback,\   # Fastest, less safe
    nobarrier,\        # Only if BBWC or battery-backed
    commit=60 0 2      # Less frequent journal commits

# Tune at mkfs time
mkfs.ext4 \
    -b 4096 \               # Block size
    -I 256 \                # Inode size (256 for large files)
    -E stride=128 \         # RAID stripe width in blocks
    -E stripe-width=512 \   # For 8-disk RAID-5: chunk_kb/4096*disks
    -E lazy_itable_init=0 \ # Initialize inode table now
    /dev/nvme0n1p1

# Check and tune ext4 features
tune2fs -l /dev/nvme0n1p1
tune2fs -o journal_data_writeback /dev/nvme0n1p1
```

### XFS Tuning

```bash
# XFS is preferred for large files and streaming workloads
mkfs.xfs \
    -b size=4096 \
    -s size=512 \
    -d agcount=8 \      # Allocation groups = num_cpus
    /dev/nvme0n1p1

# Mount options
/dev/nvme0n1p1 /data xfs \
    noatime,nodiratime,\
    logbsize=256k,\     # Journal buffer size
    allocsize=64m \     # Pre-allocation for streaming writes
    0 2

# XFS-specific tuning
# Disable barriers if BBWC is present
mount -o remount,nobarrier /data

# Pre-allocate space for a file (reduces fragmentation)
fallocate -l 100G /data/database.db

# XFS fragmentation check
xfs_db -c frag -r /dev/nvme0n1p1
```

### tmpfs for Low-Latency Scratch Space

```bash
# Mount tmpfs for temporary processing
mount -t tmpfs -o size=16G,mode=1777 tmpfs /tmp/scratch

# Use huge pages for tmpfs
mount -t tmpfs -o size=16G,huge=always tmpfs /tmp/scratch

# In /etc/fstab
tmpfs /tmp/scratch tmpfs size=16G,noatime,mode=1777 0 0
```

## Section 7: Storage Benchmarking with fio

`fio` is the standard for storage benchmarking. Getting representative results requires matching your production I/O pattern.

### fio Job Files

```ini
# database_benchmark.fio
# Simulates PostgreSQL-like random I/O

[global]
ioengine=io_uring
iodepth=32
numjobs=4
runtime=120
time_based
group_reporting
size=10g
filename=/data/test/fio_test
direct=1
norandommap

[random-read-4k]
rw=randread
bs=4k

[random-write-4k]
rw=randwrite
bs=4k

[random-readwrite-4k]
rw=randrw
rwmixread=70
bs=4k
```

```ini
# sequential_benchmark.fio
# Simulates backup / ETL workloads

[global]
ioengine=io_uring
iodepth=64
numjobs=4
runtime=120
time_based
group_reporting
size=40g
filename=/data/test/fio_sequential
direct=1

[seq-read-1m]
rw=read
bs=1m

[seq-write-1m]
rw=write
bs=1m
```

### Running and Interpreting fio

```bash
# Run database I/O benchmark
fio database_benchmark.fio --output-format=json --output=results.json

# Quick random read test
fio --name=randread \
    --ioengine=io_uring \
    --iodepth=64 \
    --numjobs=4 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --size=10g \
    --runtime=60 \
    --time_based \
    --filename=/data/test/test \
    --group_reporting

# Key output fields:
# IOPS: raw operations per second
# BW: bandwidth (throughput)
# lat (usec): latency histogram
# lat avg: average latency
# lat 99.00th: P99 latency
# lat 99.99th: P9999 latency (long tail)

# Parse JSON output with jq
jq '.jobs[0].read | {iops: .iops, bw_mb: (.bw/1024), lat_p99_us: .lat_ns.percentile["99.000000"]/1000}' results.json
```

### Latency Percentile Analysis

```bash
# Get detailed latency distribution
fio --name=latency_test \
    --ioengine=io_uring \
    --iodepth=1 \               # Single outstanding I/O to measure pure latency
    --numjobs=1 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --size=4g \
    --runtime=60 \
    --time_based \
    --filename=/dev/nvme0n1 \
    --percentile_list=50,90,95,99,99.9,99.99,99.999

# Typical NVMe results:
#  50th: 50-100μs
#  99th: 200-500μs
#  99.9th: 1-5ms (watch for spikes here)
```

## Section 8: BPF-Based I/O Observability

BPF tools give you production-safe tracing of I/O latency without the overhead of blktrace.

```bash
# Install bcc tools
apt-get install bpfcc-tools linux-headers-$(uname -r)

# biolatency: I/O latency histogram per device
biolatency -D -d nvme0n1 30

# biosnoop: per-I/O latency with process names
biosnoop -Q 5 2>&1 | head -50

# bitesize: I/O size distribution
bitesize-bpfcc

# fileslower: slow file operations (>10ms)
fileslower 10

# cachestat: page cache hit rate
cachestat 1

# cachetop: per-process page cache stats
cachetop 5

# opensnoop: trace open() calls
opensnoop -p $(pgrep postgres) -T

# Example: trace disk I/O for a specific process
cat > /tmp/trace_io.py << 'EOF'
#!/usr/bin/env python3
from bcc import BPF

bpf_text = """
#include <uapi/linux/ptrace.h>
#include <linux/blk-mq.h>

BPF_HISTOGRAM(dist_ns);

KPROBE_BLACKLIST

int trace_req_start(struct pt_regs *ctx, struct request *req) {
    u64 ts = bpf_ktime_get_ns();
    bpf_map_update_elem(&start, &req, &ts, BPF_ANY);
    return 0;
}
"""
# Full implementation would use BPF_HASH for timestamps
print("Use biolatency from bcc-tools for production use")
EOF
```

### iostat Deep Dive

```bash
# iostat with extended stats every 1 second
iostat -xmh 1

# Key columns explained:
# r/s, w/s: read/write operations per second
# rMB/s, wMB/s: read/write bandwidth
# rrqm/s, wrqm/s: merged requests (higher = better for sequential)
# r_await, w_await: average wait time ms (queue + service time)
# aqu-sz: average queue size (>1 means device is saturated)
# %util: percentage of time device busy (100% = saturated)

# Watch for queue saturation
iostat -xm 1 | awk 'NR>3 && $1!~/Device/ {
    if ($14 > 1.0 || $16 > 90)
        printf "SATURATED: %s qsz=%.1f util=%.1f%%\n", $1, $14, $16
}'

# Detailed per-queue stats for NVMe
cat /sys/block/nvme0n1/queue/io_poll_delay
cat /sys/block/nvme0n1/stat
```

## Section 9: NFS and Network Filesystem Performance

```bash
# NFS mount options for high performance
mount -t nfs4 \
    -o rw,hard,intr,\
    rsize=1048576,wsize=1048576,\
    async,\
    noatime,nodiratime,\
    proto=rdma,\       # Use RDMA if available
    nfsvers=4.2 \
    nfs-server:/export /mnt/nfs

# Monitor NFS performance
nfsstat -c  # Client stats
nfsiostat 1  # Per-mount I/O stats

# Common NFS performance issues:
# - sync writes: always slow, use async if durability allows
# - small rsize/wsize: defaults are 1MB, verify with nfsstat
# - TCP vs UDP: always use TCP for production
```

## Section 10: Production Monitoring Script

```bash
#!/bin/bash
# storage_health_check.sh

DEVICE="${1:-nvme0n1}"
THRESHOLD_UTIL=80
THRESHOLD_AWAIT=10  # ms

check_io_stats() {
    local stats
    stats=$(iostat -xm 1 1 | awk "/$DEVICE/ {print \$0}")

    local util await qsz
    util=$(echo "$stats" | awk '{print $16}')
    await=$(echo "$stats" | awk '{print $10}')  # r_await
    qsz=$(echo "$stats" | awk '{print $14}')    # aqu-sz

    echo "Device: $DEVICE"
    echo "  Utilization: ${util}%"
    echo "  Read await:  ${await}ms"
    echo "  Queue size:  ${qsz}"

    if (( $(echo "$util > $THRESHOLD_UTIL" | bc -l) )); then
        echo "  WARNING: High utilization (${util}% > ${THRESHOLD_UTIL}%)"
    fi

    if (( $(echo "$await > $THRESHOLD_AWAIT" | bc -l) )); then
        echo "  WARNING: High read latency (${await}ms > ${THRESHOLD_AWAIT}ms)"
    fi
}

check_disk_space() {
    echo "Disk space:"
    df -h | grep -v tmpfs | awk 'NR>1 {
        gsub(/%/, "", $5)
        if ($5 > 80) printf "  WARNING: %s at %s%%\n", $6, $5
        else printf "  OK: %s at %s%%\n", $6, $5
    }'
}

check_inode_usage() {
    echo "Inode usage:"
    df -ih | grep -v tmpfs | awk 'NR>1 {
        gsub(/%/, "", $5)
        if ($5 > 80) printf "  WARNING: %s at %s%%\n", $6, $5
    }'
}

check_dirty_pages() {
    echo "Dirty pages:"
    local dirty
    dirty=$(awk '/Dirty:/ {print $2}' /proc/meminfo)
    echo "  Dirty: ${dirty}kB"
    if [ "$dirty" -gt $((4 * 1024 * 1024)) ]; then  # >4GB
        echo "  WARNING: Large dirty page accumulation"
    fi
}

check_io_stats
check_disk_space
check_inode_usage
check_dirty_pages
```

## Conclusion

Linux filesystem performance optimization is a layered discipline. Start with benchmarking your actual workload pattern with `fio`, not synthetic peaks. Use `cachestat` and `biolatency` from bcc-tools to understand what is actually happening in production before tuning.

The single highest-impact change for database workloads is usually switching to Direct I/O and disabling the read-ahead. For streaming workloads, properly sized write-ahead buffering with `vm.dirty_bytes` prevents latency spikes. And for any high-performance I/O, migrating to `io_uring` with `SQPOLL` removes system call overhead entirely on Linux 5.1+.

Always measure before and after every change. Storage performance is hardware-dependent, and a tuning that helps on one system may hurt on another.
