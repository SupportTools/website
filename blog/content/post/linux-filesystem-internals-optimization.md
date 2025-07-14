---
title: "Linux Filesystem Internals and Optimization: From VFS to Advanced Storage Techniques"
date: 2025-03-09T10:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "VFS", "ext4", "XFS", "Btrfs", "Storage", "Performance"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux filesystem internals, VFS architecture, advanced storage optimization techniques, and filesystem-specific tuning for maximum performance"
more_link: "yes"
url: "/linux-filesystem-internals-optimization/"
---

Linux filesystem architecture represents one of the most sophisticated storage management systems in computing. Understanding the Virtual File System (VFS) layer, filesystem internals, and advanced optimization techniques is crucial for building high-performance storage systems. This guide explores filesystem architecture, performance tuning, and advanced storage configurations.

<!--more-->

# [Linux Filesystem Internals and Optimization](#linux-filesystem-internals)

## Virtual File System (VFS) Architecture

### Understanding VFS Layer

```c
// vfs_analysis.c - VFS layer analysis and debugging
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/fs.h>
#include <linux/dcache.h>
#include <linux/mount.h>
#include <linux/namei.h>
#include <linux/slab.h>
#include <linux/proc_fs.h>
#include <linux/seq_file.h>

// VFS statistics tracking
struct vfs_stats {
    atomic64_t inode_operations;
    atomic64_t dentry_operations;
    atomic64_t file_operations;
    atomic64_t mount_operations;
    atomic64_t cache_hits;
    atomic64_t cache_misses;
};

static struct vfs_stats global_vfs_stats;

// Hook into VFS operations for monitoring
static struct inode_operations *orig_inode_ops;
static struct dentry_operations *orig_dentry_ops;
static struct file_operations *orig_file_ops;

// Custom inode operations wrapper
static int vfs_monitor_lookup(struct inode *dir, struct dentry *dentry,
                             unsigned int flags) {
    atomic64_inc(&global_vfs_stats.inode_operations);
    
    // Check if this is a cache hit or miss
    if (d_unhashed(dentry)) {
        atomic64_inc(&global_vfs_stats.cache_misses);
    } else {
        atomic64_inc(&global_vfs_stats.cache_hits);
    }
    
    // Call original operation
    if (orig_inode_ops && orig_inode_ops->lookup) {
        return orig_inode_ops->lookup(dir, dentry, flags);
    }
    
    return -ENOENT;
}

// VFS cache analysis
static void analyze_vfs_caches(void) {
    struct super_block *sb;
    unsigned long dentry_count = 0;
    unsigned long inode_count = 0;
    
    printk(KERN_INFO "=== VFS Cache Analysis ===\n");
    
    // Analyze dentry cache
    spin_lock(&dcache_lock);
    // Note: This is simplified - actual implementation would need proper locking
    printk(KERN_INFO "Dentry cache statistics:\n");
    printk(KERN_INFO "  Active dentries: %ld\n", dentry_count);
    spin_unlock(&dcache_lock);
    
    // Analyze inode cache
    printk(KERN_INFO "Inode cache statistics:\n");
    printk(KERN_INFO "  Active inodes: %ld\n", inode_count);
    
    // Mount point analysis
    printk(KERN_INFO "Mount point analysis:\n");
    // Iterate through mount points (simplified)
    printk(KERN_INFO "  Active mounts: (implementation specific)\n");
}

// VFS performance metrics
static int vfs_stats_show(struct seq_file *m, void *v) {
    seq_printf(m, "VFS Performance Statistics\n");
    seq_printf(m, "==========================\n");
    seq_printf(m, "Inode operations:  %lld\n", 
               atomic64_read(&global_vfs_stats.inode_operations));
    seq_printf(m, "Dentry operations: %lld\n", 
               atomic64_read(&global_vfs_stats.dentry_operations));
    seq_printf(m, "File operations:   %lld\n", 
               atomic64_read(&global_vfs_stats.file_operations));
    seq_printf(m, "Mount operations:  %lld\n", 
               atomic64_read(&global_vfs_stats.mount_operations));
    seq_printf(m, "Cache hits:        %lld\n", 
               atomic64_read(&global_vfs_stats.cache_hits));
    seq_printf(m, "Cache misses:      %lld\n", 
               atomic64_read(&global_vfs_stats.cache_misses));
    
    if (atomic64_read(&global_vfs_stats.cache_hits) + 
        atomic64_read(&global_vfs_stats.cache_misses) > 0) {
        long long total = atomic64_read(&global_vfs_stats.cache_hits) + 
                         atomic64_read(&global_vfs_stats.cache_misses);
        long long hit_rate = (atomic64_read(&global_vfs_stats.cache_hits) * 100) / total;
        seq_printf(m, "Cache hit rate:    %lld%%\n", hit_rate);
    }
    
    return 0;
}

static int vfs_stats_open(struct inode *inode, struct file *file) {
    return single_open(file, vfs_stats_show, NULL);
}

static const struct proc_ops vfs_stats_ops = {
    .proc_open    = vfs_stats_open,
    .proc_read    = seq_read,
    .proc_lseek   = seq_lseek,
    .proc_release = single_release,
};

// Path resolution analysis
static void analyze_path_resolution(const char *pathname) {
    struct path path;
    struct nameidata nd;
    ktime_t start_time, end_time;
    
    printk(KERN_INFO "=== Path Resolution Analysis: %s ===\n", pathname);
    
    start_time = ktime_get();
    
    // Perform path lookup (simplified)
    if (kern_path(pathname, LOOKUP_FOLLOW, &path) == 0) {
        end_time = ktime_get();
        
        printk(KERN_INFO "Path resolution successful\n");
        printk(KERN_INFO "Resolution time: %lld ns\n", 
               ktime_to_ns(ktime_sub(end_time, start_time)));
        
        // Analyze the path components
        if (path.dentry) {
            printk(KERN_INFO "Dentry: %s\n", path.dentry->d_name.name);
            printk(KERN_INFO "Inode number: %lu\n", path.dentry->d_inode->i_ino);
            printk(KERN_INFO "File type: %o\n", path.dentry->d_inode->i_mode & S_IFMT);
        }
        
        path_put(&path);
    } else {
        printk(KERN_INFO "Path resolution failed\n");
    }
}

// Module initialization
static int __init vfs_monitor_init(void) {
    printk(KERN_INFO "VFS Monitor loaded\n");
    
    // Initialize statistics
    atomic64_set(&global_vfs_stats.inode_operations, 0);
    atomic64_set(&global_vfs_stats.dentry_operations, 0);
    atomic64_set(&global_vfs_stats.file_operations, 0);
    atomic64_set(&global_vfs_stats.mount_operations, 0);
    atomic64_set(&global_vfs_stats.cache_hits, 0);
    atomic64_set(&global_vfs_stats.cache_misses, 0);
    
    // Create proc entry
    proc_create("vfs_stats", 0444, NULL, &vfs_stats_ops);
    
    // Perform initial analysis
    analyze_vfs_caches();
    
    return 0;
}

static void __exit vfs_monitor_exit(void) {
    remove_proc_entry("vfs_stats", NULL);
    printk(KERN_INFO "VFS Monitor unloaded\n");
}

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("VFS Performance Monitor");
module_init(vfs_monitor_init);
module_exit(vfs_monitor_exit);
```

### VFS Analysis Tools

```bash
#!/bin/bash
# vfs_analysis.sh - VFS layer analysis tools

# VFS cache analysis
analyze_vfs_caches() {
    echo "=== VFS Cache Analysis ==="
    
    # Dentry cache information
    echo "Dentry cache statistics:"
    if [ -f "/proc/sys/fs/dentry-state" ]; then
        local dentry_stats=($(cat /proc/sys/fs/dentry-state))
        echo "  Total dentries: ${dentry_stats[0]}"
        echo "  Unused dentries: ${dentry_stats[1]}"
        echo "  Age limit: ${dentry_stats[2]} seconds"
        echo "  Want shrink: ${dentry_stats[3]}"
    fi
    echo
    
    # Inode cache information
    echo "Inode cache statistics:"
    if [ -f "/proc/sys/fs/inode-state" ]; then
        local inode_stats=($(cat /proc/sys/fs/inode-state))
        echo "  Total inodes: ${inode_stats[0]}"
        echo "  Free inodes: ${inode_stats[1]}"
    fi
    echo
    
    # File handle information
    echo "File handle statistics:"
    if [ -f "/proc/sys/fs/file-nr" ]; then
        local file_stats=($(cat /proc/sys/fs/file-nr))
        echo "  Allocated file handles: ${file_stats[0]}"
        echo "  Free file handles: ${file_stats[1]}"
        echo "  Maximum file handles: ${file_stats[2]}"
        
        local usage_percent=$((file_stats[0] * 100 / file_stats[2]))
        echo "  Usage: ${usage_percent}%"
        
        if [ $usage_percent -gt 80 ]; then
            echo "  WARNING: High file handle usage!"
        fi
    fi
    echo
    
    # Mount point analysis
    echo "Mount point analysis:"
    mount | wc -l | awk '{print "  Total mount points: " $1}'
    
    echo "  Mount points by filesystem type:"
    mount | awk '{print $5}' | sort | uniq -c | sort -nr | head -10 | \
    while read count fs; do
        printf "    %-10s: %d\n" "$fs" "$count"
    done
}

# Filesystem-specific analysis
analyze_filesystem_performance() {
    local mountpoint=${1:-"/"}
    
    echo "=== Filesystem Performance Analysis: $mountpoint ==="
    
    # Basic filesystem information
    local fstype=$(findmnt -n -o FSTYPE "$mountpoint")
    local device=$(findmnt -n -o SOURCE "$mountpoint")
    
    echo "Filesystem type: $fstype"
    echo "Device: $device"
    echo "Mount point: $mountpoint"
    echo
    
    # Filesystem usage
    echo "Space usage:"
    df -h "$mountpoint"
    echo
    
    # Inode usage
    echo "Inode usage:"
    df -i "$mountpoint"
    echo
    
    # Filesystem-specific statistics
    case "$fstype" in
        "ext4")
            analyze_ext4_performance "$device" "$mountpoint"
            ;;
        "xfs")
            analyze_xfs_performance "$device" "$mountpoint"
            ;;
        "btrfs")
            analyze_btrfs_performance "$device" "$mountpoint"
            ;;
        *)
            echo "Generic filesystem analysis for $fstype"
            ;;
    esac
}

# ext4 specific analysis
analyze_ext4_performance() {
    local device=$1
    local mountpoint=$2
    
    echo "=== ext4 Performance Analysis ==="
    
    # ext4 superblock information
    if command -v dumpe2fs >/dev/null; then
        echo "ext4 superblock information:"
        dumpe2fs -h "$device" 2>/dev/null | grep -E "(Block size|Fragment size|Inode size|Journal|Mount count|Last mount|Last check)"
    fi
    echo
    
    # ext4 statistics from /proc
    local device_name=$(basename "$device")
    local ext4_stats_dir="/proc/fs/ext4/$device_name"
    
    if [ -d "$ext4_stats_dir" ]; then
        echo "ext4 runtime statistics:"
        
        if [ -f "$ext4_stats_dir/mb_groups" ]; then
            echo "  Multiblock groups:"
            head -5 "$ext4_stats_dir/mb_groups"
        fi
        
        if [ -f "$ext4_stats_dir/options" ]; then
            echo "  Mount options:"
            cat "$ext4_stats_dir/options"
        fi
    fi
    echo
    
    # Journal analysis
    echo "Journal analysis:"
    if command -v dumpe2fs >/dev/null; then
        dumpe2fs -h "$device" 2>/dev/null | grep -i journal
    fi
    
    # Check for errors
    echo "Filesystem errors:"
    if command -v tune2fs >/dev/null; then
        tune2fs -l "$device" 2>/dev/null | grep -E "(error|check|mount)"
    fi
}

# XFS specific analysis
analyze_xfs_performance() {
    local device=$1
    local mountpoint=$2
    
    echo "=== XFS Performance Analysis ==="
    
    # XFS information
    if command -v xfs_info >/dev/null; then
        echo "XFS filesystem information:"
        xfs_info "$mountpoint" 2>/dev/null
    fi
    echo
    
    # XFS statistics
    if [ -f "/proc/fs/xfs/stat" ]; then
        echo "XFS statistics:"
        cat /proc/fs/xfs/stat | while read line; do
            echo "  $line"
        done
    fi
    echo
    
    # XFS I/O statistics
    if command -v xfs_io >/dev/null; then
        echo "XFS I/O capabilities:"
        xfs_io -c "help" -f "$mountpoint" 2>/dev/null | head -10
    fi
    
    # Check for fragmentation
    if command -v xfs_db >/dev/null; then
        echo "XFS fragmentation check:"
        xfs_db -c "frag -v" "$device" 2>/dev/null | head -10
    fi
}

# Btrfs specific analysis
analyze_btrfs_performance() {
    local device=$1
    local mountpoint=$2
    
    echo "=== Btrfs Performance Analysis ==="
    
    # Btrfs filesystem show
    if command -v btrfs >/dev/null; then
        echo "Btrfs filesystem information:"
        btrfs filesystem show "$device" 2>/dev/null
        echo
        
        echo "Btrfs filesystem usage:"
        btrfs filesystem usage "$mountpoint" 2>/dev/null
        echo
        
        echo "Btrfs device statistics:"
        btrfs device stats "$mountpoint" 2>/dev/null
        echo
        
        echo "Btrfs scrub status:"
        btrfs scrub status "$mountpoint" 2>/dev/null
    fi
}

# I/O pattern analysis
analyze_io_patterns() {
    local mountpoint=${1:-"/"}
    local duration=${2:-30}
    
    echo "=== I/O Pattern Analysis: $mountpoint ==="
    echo "Monitoring for ${duration} seconds..."
    
    # Find device for mountpoint
    local device=$(findmnt -n -o SOURCE "$mountpoint" | sed 's/[0-9]*$//')
    local device_name=$(basename "$device")
    
    if [ ! -f "/sys/block/$device_name/stat" ]; then
        echo "Device statistics not available for $device_name"
        return 1
    fi
    
    # Collect baseline statistics
    local stats_before=($(cat /sys/block/$device_name/stat))
    local time_before=$(date +%s)
    
    sleep $duration
    
    # Collect final statistics
    local stats_after=($(cat /sys/block/$device_name/stat))
    local time_after=$(date +%s)
    local elapsed=$((time_after - time_before))
    
    # Calculate deltas
    local reads_delta=$((stats_after[0] - stats_before[0]))
    local reads_merged_delta=$((stats_after[1] - stats_before[1]))
    local sectors_read_delta=$((stats_after[2] - stats_before[2]))
    local read_time_delta=$((stats_after[3] - stats_before[3]))
    
    local writes_delta=$((stats_after[4] - stats_before[4]))
    local writes_merged_delta=$((stats_after[5] - stats_before[5]))
    local sectors_written_delta=$((stats_after[6] - stats_before[6]))
    local write_time_delta=$((stats_after[7] - stats_before[7]))
    
    local ios_in_progress=$((stats_after[8]))
    local io_time_delta=$((stats_after[9] - stats_before[9]))
    local weighted_io_time_delta=$((stats_after[10] - stats_before[10]))
    
    echo "I/O Statistics for $device_name over ${elapsed}s:"
    echo "  Reads:  $reads_delta ops, $((sectors_read_delta * 512 / 1024 / 1024)) MB"
    echo "  Writes: $writes_delta ops, $((sectors_written_delta * 512 / 1024 / 1024)) MB"
    
    if [ $reads_delta -gt 0 ]; then
        echo "  Avg read latency:  $((read_time_delta / reads_delta)) ms"
    fi
    
    if [ $writes_delta -gt 0 ]; then
        echo "  Avg write latency: $((write_time_delta / writes_delta)) ms"
    fi
    
    echo "  Read IOPS:  $((reads_delta / elapsed))"
    echo "  Write IOPS: $((writes_delta / elapsed))"
    echo "  Read throughput:  $((sectors_read_delta * 512 / elapsed / 1024 / 1024)) MB/s"
    echo "  Write throughput: $((sectors_written_delta * 512 / elapsed / 1024 / 1024)) MB/s"
    
    # Analyze I/O patterns
    local read_merge_ratio=0
    local write_merge_ratio=0
    
    if [ $reads_delta -gt 0 ]; then
        read_merge_ratio=$((reads_merged_delta * 100 / reads_delta))
    fi
    
    if [ $writes_delta -gt 0 ]; then
        write_merge_ratio=$((writes_merged_delta * 100 / writes_delta))
    fi
    
    echo "  Read merge ratio:  ${read_merge_ratio}%"
    echo "  Write merge ratio: ${write_merge_ratio}%"
    
    if [ $read_merge_ratio -lt 10 ] || [ $write_merge_ratio -lt 10 ]; then
        echo "  NOTE: Low merge ratios suggest random I/O patterns"
    fi
}

# Filesystem benchmark
filesystem_benchmark() {
    local mountpoint=${1:-"/tmp"}
    local test_size=${2:-"1G"}
    
    echo "=== Filesystem Benchmark: $mountpoint ==="
    echo "Test size: $test_size"
    
    local test_dir="$mountpoint/fs_benchmark_$$"
    mkdir -p "$test_dir"
    
    if [ ! -d "$test_dir" ]; then
        echo "Cannot create test directory: $test_dir"
        return 1
    fi
    
    # Sequential write test
    echo "Sequential write test..."
    local start_time=$(date +%s.%N)
    dd if=/dev/zero of="$test_dir/seqwrite.dat" bs=1M count=1024 oflag=direct 2>/dev/null
    local end_time=$(date +%s.%N)
    local write_time=$(echo "$end_time - $start_time" | bc)
    local write_speed=$(echo "scale=2; 1024 / $write_time" | bc)
    echo "  Sequential write: ${write_speed} MB/s"
    
    # Sequential read test
    echo "Sequential read test..."
    # Clear cache
    echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
    
    start_time=$(date +%s.%N)
    dd if="$test_dir/seqwrite.dat" of=/dev/null bs=1M iflag=direct 2>/dev/null
    end_time=$(date +%s.%N)
    local read_time=$(echo "$end_time - $start_time" | bc)
    local read_speed=$(echo "scale=2; 1024 / $read_time" | bc)
    echo "  Sequential read: ${read_speed} MB/s"
    
    # Random I/O test (if fio is available)
    if command -v fio >/dev/null; then
        echo "Random I/O test..."
        fio --name=random_rw \
            --ioengine=libaio \
            --rw=randrw \
            --bs=4k \
            --direct=1 \
            --size=100M \
            --numjobs=4 \
            --runtime=30 \
            --group_reporting \
            --filename="$test_dir/random_test" \
            --output-format=normal 2>/dev/null | \
            grep -E "(read|write):" | head -2
    fi
    
    # Metadata operations test
    echo "Metadata operations test..."
    start_time=$(date +%s.%N)
    for i in {1..1000}; do
        touch "$test_dir/file_$i"
    done
    end_time=$(date +%s.%N)
    local create_time=$(echo "$end_time - $start_time" | bc)
    local create_ops=$(echo "scale=2; 1000 / $create_time" | bc)
    echo "  File creation: ${create_ops} ops/s"
    
    start_time=$(date +%s.%N)
    for i in {1..1000}; do
        rm "$test_dir/file_$i"
    done
    end_time=$(date +%s.%N)
    local delete_time=$(echo "$end_time - $start_time" | bc)
    local delete_ops=$(echo "scale=2; 1000 / $delete_time" | bc)
    echo "  File deletion: ${delete_ops} ops/s"
    
    # Cleanup
    rm -rf "$test_dir"
}
```

## Filesystem-Specific Optimizations

### ext4 Optimization

```bash
#!/bin/bash
# ext4_optimization.sh - ext4 filesystem optimization

# ext4 tuning parameters
optimize_ext4_filesystem() {
    local device=$1
    local mountpoint=$2
    
    if [ -z "$device" ] || [ -z "$mountpoint" ]; then
        echo "Usage: optimize_ext4_filesystem <device> <mountpoint>"
        return 1
    fi
    
    echo "=== ext4 Optimization for $device ($mountpoint) ==="
    
    # Check current mount options
    echo "Current mount options:"
    mount | grep "$device" | awk '{print $6}'
    echo
    
    # Recommended mount options for different use cases
    echo "Recommended mount options:"
    echo
    
    echo "For general server use:"
    echo "  noatime,data=ordered,barrier=1,journal_checksum,journal_async_commit"
    echo
    
    echo "For high-performance databases:"
    echo "  noatime,data=writeback,barrier=0,commit=30,nobh"
    echo "  WARNING: data=writeback reduces durability"
    echo
    
    echo "For SSDs:"
    echo "  noatime,discard,data=ordered,barrier=1"
    echo
    
    # Tune filesystem parameters
    echo "Current filesystem parameters:"
    if command -v tune2fs >/dev/null; then
        tune2fs -l "$device" | grep -E "(Reserved block count|Check interval|Mount count)"
    fi
    echo
    
    echo "Optimization recommendations:"
    echo "1. Reduce reserved blocks for data drives:"
    echo "   tune2fs -m 1 $device"
    echo
    echo "2. Disable filesystem checks for stable systems:"
    echo "   tune2fs -c 0 -i 0 $device"
    echo
    echo "3. Enable dir_index for large directories:"
    echo "   tune2fs -O dir_index $device"
    echo
    echo "4. Set appropriate journal size:"
    echo "   tune2fs -J size=128 $device  # For large filesystems"
    echo
    
    # Journal optimization
    echo "Journal optimization:"
    local journal_device=$(dumpe2fs -h "$device" 2>/dev/null | grep "Journal device" | awk '{print $3}')
    
    if [ "$journal_device" = "0x0000" ]; then
        echo "  Internal journal detected"
        echo "  Consider external journal for high I/O workloads:"
        echo "    mke2fs -O journal_dev /dev/journal_device"
        echo "    tune2fs -J device=/dev/journal_device $device"
    else
        echo "  External journal detected: $journal_device"
        echo "  External journal is optimal for performance"
    fi
}

# ext4 performance monitoring
monitor_ext4_performance() {
    local device=$1
    local duration=${2:-60}
    
    echo "=== ext4 Performance Monitoring ==="
    echo "Device: $device, Duration: ${duration}s"
    
    local device_name=$(basename "$device")
    local ext4_stats_dir="/proc/fs/ext4/$device_name"
    
    if [ ! -d "$ext4_stats_dir" ]; then
        echo "ext4 statistics not available for $device"
        return 1
    fi
    
    # Monitor extent statistics
    if [ -f "$ext4_stats_dir/extents_stats" ]; then
        echo "Extent statistics (before):"
        cat "$ext4_stats_dir/extents_stats"
        echo
        
        sleep $duration
        
        echo "Extent statistics (after):"
        cat "$ext4_stats_dir/extents_stats"
        echo
    fi
    
    # Monitor multiblock allocator
    if [ -f "$ext4_stats_dir/mb_groups" ]; then
        echo "Multiblock allocator efficiency:"
        head -10 "$ext4_stats_dir/mb_groups"
    fi
}

# ext4 fragmentation analysis
analyze_ext4_fragmentation() {
    local device=$1
    local mountpoint=$2
    
    echo "=== ext4 Fragmentation Analysis ==="
    
    # Use e4defrag to analyze fragmentation
    if command -v e4defrag >/dev/null; then
        echo "Fragmentation analysis:"
        e4defrag -c "$mountpoint" 2>/dev/null | head -20
        echo
        
        echo "Most fragmented files:"
        find "$mountpoint" -type f -size +10M -exec e4defrag -c {} \; 2>/dev/null | \
        sort -k2 -nr | head -10
    else
        echo "e4defrag not available for fragmentation analysis"
        
        # Alternative: use filefrag
        if command -v filefrag >/dev/null; then
            echo "Using filefrag for fragmentation analysis:"
            find "$mountpoint" -type f -size +10M -exec filefrag {} \; 2>/dev/null | \
            awk '$2 > 1 {print $2 " extents: " $0}' | sort -nr | head -10
        fi
    fi
}

# ext4 online defragmentation
defragment_ext4_filesystem() {
    local target=${1:-"/"}
    local threshold=${2:-10}
    
    echo "=== ext4 Online Defragmentation ==="
    echo "Target: $target"
    echo "Fragment threshold: $threshold extents"
    
    if ! command -v e4defrag >/dev/null; then
        echo "e4defrag not available"
        return 1
    fi
    
    # Find fragmented files
    echo "Finding fragmented files..."
    local fragmented_files="/tmp/fragmented_files_$$"
    
    find "$target" -type f -size +1M -exec filefrag {} \; 2>/dev/null | \
    awk -v threshold="$threshold" '$2 >= threshold {print $2 " " $4}' | \
    sort -nr > "$fragmented_files"
    
    local total_files=$(wc -l < "$fragmented_files")
    echo "Found $total_files fragmented files"
    
    if [ $total_files -eq 0 ]; then
        echo "No fragmented files found"
        rm -f "$fragmented_files"
        return 0
    fi
    
    # Show most fragmented files
    echo "Most fragmented files:"
    head -10 "$fragmented_files"
    echo
    
    # Defragment files
    echo "Starting defragmentation..."
    local defragmented=0
    
    while read fragments file; do
        if [ $fragments -ge $threshold ]; then
            echo "Defragmenting: $file ($fragments fragments)"
            if e4defrag "$file" >/dev/null 2>&1; then
                defragmented=$((defragmented + 1))
            fi
        fi
        
        # Limit to avoid system overload
        if [ $defragmented -ge 100 ]; then
            echo "Defragmented 100 files, stopping to avoid system overload"
            break
        fi
    done < "$fragmented_files"
    
    echo "Defragmentation complete: $defragmented files processed"
    rm -f "$fragmented_files"
}
```

### XFS Optimization

```bash
#!/bin/bash
# xfs_optimization.sh - XFS filesystem optimization

# XFS tuning and optimization
optimize_xfs_filesystem() {
    local device=$1
    local mountpoint=$2
    
    echo "=== XFS Optimization for $device ($mountpoint) ==="
    
    # Current XFS configuration
    if command -v xfs_info >/dev/null; then
        echo "Current XFS configuration:"
        xfs_info "$mountpoint"
        echo
    fi
    
    # Mount option recommendations
    echo "Recommended XFS mount options:"
    echo
    
    echo "For general use:"
    echo "  noatime,attr2,inode64,noquota"
    echo
    
    echo "For high-performance workloads:"
    echo "  noatime,attr2,inode64,noquota,nobarrier,logbsize=256k"
    echo "  WARNING: nobarrier reduces crash safety"
    echo
    
    echo "For SSDs:"
    echo "  noatime,attr2,inode64,noquota,discard"
    echo
    
    echo "For databases:"
    echo "  noatime,attr2,inode64,noquota,logbsize=256k,largeio,swalloc"
    echo
    
    # XFS allocation group analysis
    echo "XFS allocation group analysis:"
    if command -v xfs_db >/dev/null; then
        # Get AG count and size
        local ag_info=$(xfs_db -c "sb 0" -c "print agcount agblocks blocksize" -r "$device" 2>/dev/null)
        echo "$ag_info"
        
        # Check for balanced allocation
        echo "Allocation group usage:"
        xfs_db -c "freesp -s" -r "$device" 2>/dev/null | head -10
    fi
}

# XFS performance analysis
analyze_xfs_performance() {
    local mountpoint=$1
    
    echo "=== XFS Performance Analysis ==="
    
    # XFS statistics from /proc
    if [ -f "/proc/fs/xfs/stat" ]; then
        echo "XFS kernel statistics:"
        awk '
        /extent_alloc/ { printf "Extent allocations: %d\n", $2 }
        /abt/ { printf "Btree operations: %d lookups, %d compares\n", $2, $3 }
        /blk_map/ { printf "Block mapping: %d reads, %d writes\n", $2, $3 }
        /bmbt/ { printf "Bmbt operations: %d lookups, %d compares\n", $2, $3 }
        /dir/ { printf "Directory operations: %d lookups, %d creates\n", $2, $3 }
        /trans/ { printf "Transactions: %d sync, %d async\n", $2, $3 }
        /ig/ { printf "Inode operations: %d attempts, %d found\n", $2, $3 }
        /log/ { printf "Log operations: %d writes, %d blocks\n", $2, $3 }
        /rw/ { printf "Read/Write: %d reads, %d writes\n", $2, $3 }
        /attr/ { printf "Attribute operations: %d gets, %d sets\n", $2, $3 }
        /icluster/ { printf "Inode clustering: %d flushes, %d clusters\n", $2, $3 }
        /vnodes/ { printf "Vnode operations: %d active, %d allocations\n", $2, $3 }
        /buf/ { printf "Buffer operations: %d gets, %d creates\n", $2, $3 }
        ' /proc/fs/xfs/stat
        echo
    fi
    
    # XFS quota information
    if command -v xfs_quota >/dev/null; then
        echo "XFS quota status:"
        xfs_quota -c "state" "$mountpoint" 2>/dev/null || echo "Quotas not enabled"
        echo
    fi
    
    # Real-time subvolume information
    if command -v xfs_info >/dev/null; then
        local rt_info=$(xfs_info "$mountpoint" | grep "realtime")
        if [ -n "$rt_info" ]; then
            echo "Real-time subvolume information:"
            echo "$rt_info"
        else
            echo "No real-time subvolume configured"
        fi
        echo
    fi
}

# XFS defragmentation
defragment_xfs_filesystem() {
    local mountpoint=$1
    
    echo "=== XFS Defragmentation ==="
    
    if ! command -v xfs_fsr >/dev/null; then
        echo "xfs_fsr not available"
        return 1
    fi
    
    # Analyze fragmentation first
    echo "Analyzing fragmentation..."
    xfs_db -c "frag -v" "$(findmnt -n -o SOURCE "$mountpoint")" 2>/dev/null
    echo
    
    # Run filesystem reorganizer
    echo "Starting XFS filesystem reorganization..."
    echo "This may take a long time for large filesystems"
    
    # Run with verbose output and limit time
    timeout 3600 xfs_fsr -v "$mountpoint" 2>&1 | \
    while read line; do
        echo "  $line"
        # Show progress every 100 lines
        if [ $(($(wc -l <<< "$line") % 100)) -eq 0 ]; then
            echo "  ... continuing defragmentation ..."
        fi
    done
    
    echo "XFS defragmentation completed or timed out after 1 hour"
}

# XFS metadata dump and analysis
analyze_xfs_metadata() {
    local device=$1
    
    echo "=== XFS Metadata Analysis ==="
    
    if ! command -v xfs_db >/dev/null; then
        echo "xfs_db not available"
        return 1
    fi
    
    # Superblock analysis
    echo "Superblock information:"
    xfs_db -c "sb 0" -c "print" -r "$device" 2>/dev/null | \
    grep -E "(blocksize|sectsize|agcount|agblocks|logblocks|versionnum)"
    echo
    
    # Free space analysis
    echo "Free space distribution:"
    xfs_db -c "freesp -s" -r "$device" 2>/dev/null | head -20
    echo
    
    # Inode analysis
    echo "Inode information:"
    xfs_db -c "sb 0" -c "print icount ifree" -r "$device" 2>/dev/null
    echo
    
    # Log analysis
    echo "Log information:"
    xfs_db -c "logprint -t" -r "$device" 2>/dev/null | head -10
}

# XFS quota management
manage_xfs_quotas() {
    local mountpoint=$1
    local action=${2:-"status"}
    
    echo "=== XFS Quota Management ==="
    
    if ! command -v xfs_quota >/dev/null; then
        echo "xfs_quota not available"
        return 1
    fi
    
    case "$action" in
        "status")
            echo "Quota status:"
            xfs_quota -c "state -all" "$mountpoint"
            echo
            
            echo "User quota report (top 10):"
            xfs_quota -c "report -h" "$mountpoint" | head -11
            echo
            
            echo "Group quota report (top 10):"
            xfs_quota -c "report -g -h" "$mountpoint" | head -11
            ;;
            
        "enable")
            echo "Enabling quotas on $mountpoint"
            echo "Note: Filesystem must be mounted with quota options"
            xfs_quota -c "state -on" "$mountpoint"
            ;;
            
        "disable")
            echo "Disabling quotas on $mountpoint"
            xfs_quota -c "state -off" "$mountpoint"
            ;;
            
        *)
            echo "Usage: manage_xfs_quotas <mountpoint> <status|enable|disable>"
            ;;
    esac
}
```

### Btrfs Optimization

```bash
#!/bin/bash
# btrfs_optimization.sh - Btrfs filesystem optimization

# Btrfs optimization and maintenance
optimize_btrfs_filesystem() {
    local mountpoint=$1
    
    echo "=== Btrfs Optimization for $mountpoint ==="
    
    if ! command -v btrfs >/dev/null; then
        echo "btrfs tools not available"
        return 1
    fi
    
    # Current filesystem information
    echo "Current Btrfs filesystem information:"
    btrfs filesystem show "$mountpoint"
    echo
    
    echo "Filesystem usage:"
    btrfs filesystem usage "$mountpoint"
    echo
    
    # Mount option recommendations
    echo "Recommended Btrfs mount options:"
    echo
    
    echo "For SSDs:"
    echo "  noatime,compress=zstd,ssd,space_cache=v2,autodefrag"
    echo
    
    echo "For HDDs:"
    echo "  noatime,compress=zstd,space_cache=v2,autodefrag"
    echo
    
    echo "For maximum performance (less safety):"
    echo "  noatime,compress=lzo,ssd,space_cache=v2,skip_balance,nologreplay"
    echo "  WARNING: Reduced crash safety"
    echo
    
    # Compression analysis
    echo "Compression analysis:"
    local total_size=$(btrfs filesystem usage "$mountpoint" | awk '/Device size:/ {print $3}')
    local used_size=$(btrfs filesystem usage "$mountpoint" | awk '/Used:/ {print $2}')
    
    echo "  Total device size: $total_size"
    echo "  Used space: $used_size"
    
    # Check compression ratios if compsize is available
    if command -v compsize >/dev/null; then
        echo "  Compression efficiency:"
        compsize "$mountpoint" | head -5
    fi
}

# Btrfs maintenance operations
maintain_btrfs_filesystem() {
    local mountpoint=$1
    local operation=${2:-"status"}
    
    echo "=== Btrfs Maintenance: $operation ==="
    
    case "$operation" in
        "balance")
            echo "Starting Btrfs balance operation..."
            echo "This may take a very long time for large filesystems"
            
            # Start with metadata balance (usually faster)
            echo "Balancing metadata..."
            btrfs balance start -m "$mountpoint"
            
            # Then balance data
            echo "Balancing data..."
            btrfs balance start -d "$mountpoint"
            
            echo "Balance operation completed"
            ;;
            
        "scrub")
            echo "Starting Btrfs scrub operation..."
            btrfs scrub start "$mountpoint"
            
            # Monitor scrub progress
            echo "Monitoring scrub progress (Ctrl+C to stop monitoring):"
            while btrfs scrub status "$mountpoint" | grep -q "running"; do
                btrfs scrub status "$mountpoint"
                sleep 10
            done
            
            echo "Final scrub status:"
            btrfs scrub status "$mountpoint"
            ;;
            
        "defrag")
            echo "Starting Btrfs defragmentation..."
            echo "This will defragment files larger than 1MB"
            
            find "$mountpoint" -type f -size +1M -exec btrfs filesystem defrag {} \; 2>/dev/null | \
            head -100  # Limit output
            
            echo "Defragmentation completed (limited to 100 files for safety)"
            ;;
            
        "trim")
            echo "Starting Btrfs trim operation..."
            btrfs filesystem trim "$mountpoint"
            echo "Trim operation completed"
            ;;
            
        "status"|*)
            echo "Btrfs filesystem status:"
            btrfs filesystem usage "$mountpoint"
            echo
            
            echo "Device statistics:"
            btrfs device stats "$mountpoint"
            echo
            
            echo "Scrub status:"
            btrfs scrub status "$mountpoint"
            echo
            
            echo "Balance status:"
            btrfs balance status "$mountpoint" 2>/dev/null || echo "No balance operation running"
            ;;
    esac
}

# Btrfs snapshot management
manage_btrfs_snapshots() {
    local mountpoint=$1
    local action=${2:-"list"}
    local snapshot_name=${3:-"snapshot-$(date +%Y%m%d_%H%M%S)"}
    
    echo "=== Btrfs Snapshot Management ==="
    
    case "$action" in
        "create")
            echo "Creating snapshot: $snapshot_name"
            local snapshot_dir="$mountpoint/.snapshots"
            mkdir -p "$snapshot_dir"
            
            btrfs subvolume snapshot "$mountpoint" "$snapshot_dir/$snapshot_name"
            echo "Snapshot created: $snapshot_dir/$snapshot_name"
            ;;
            
        "list")
            echo "Available snapshots:"
            btrfs subvolume list "$mountpoint" | grep -E "(snapshot|backup)" || echo "No snapshots found"
            ;;
            
        "delete")
            if [ -z "$snapshot_name" ]; then
                echo "Usage: manage_btrfs_snapshots <mountpoint> delete <snapshot_path>"
                return 1
            fi
            
            echo "Deleting snapshot: $snapshot_name"
            btrfs subvolume delete "$snapshot_name"
            ;;
            
        "cleanup")
            echo "Cleaning up old snapshots (keeping last 10)..."
            local snapshot_dir="$mountpoint/.snapshots"
            
            if [ -d "$snapshot_dir" ]; then
                ls -1t "$snapshot_dir" | tail -n +11 | while read old_snapshot; do
                    echo "Removing old snapshot: $old_snapshot"
                    btrfs subvolume delete "$snapshot_dir/$old_snapshot"
                done
            fi
            ;;
            
        *)
            echo "Usage: manage_btrfs_snapshots <mountpoint> <create|list|delete|cleanup> [snapshot_name]"
            ;;
    esac
}

# Btrfs RAID management
manage_btrfs_raid() {
    local mountpoint=$1
    local action=${2:-"status"}
    
    echo "=== Btrfs RAID Management ==="
    
    case "$action" in
        "status")
            echo "RAID status:"
            btrfs filesystem show "$mountpoint"
            echo
            
            echo "Device usage:"
            btrfs device usage "$mountpoint"
            echo
            
            echo "Filesystem usage by profile:"
            btrfs filesystem usage "$mountpoint" | grep -A 20 "Data,RAID"
            btrfs filesystem usage "$mountpoint" | grep -A 20 "Metadata,RAID"
            ;;
            
        "add")
            local new_device=$3
            if [ -z "$new_device" ]; then
                echo "Usage: manage_btrfs_raid <mountpoint> add <device>"
                return 1
            fi
            
            echo "Adding device to Btrfs filesystem: $new_device"
            btrfs device add "$new_device" "$mountpoint"
            
            echo "Starting balance to distribute data..."
            btrfs balance start "$mountpoint"
            ;;
            
        "remove")
            local device=$3
            if [ -z "$device" ]; then
                echo "Usage: manage_btrfs_raid <mountpoint> remove <device>"
                return 1
            fi
            
            echo "Removing device from Btrfs filesystem: $device"
            btrfs device remove "$device" "$mountpoint"
            ;;
            
        "replace")
            local old_device=$3
            local new_device=$4
            
            if [ -z "$old_device" ] || [ -z "$new_device" ]; then
                echo "Usage: manage_btrfs_raid <mountpoint> replace <old_device> <new_device>"
                return 1
            fi
            
            echo "Replacing device: $old_device -> $new_device"
            btrfs replace start "$old_device" "$new_device" "$mountpoint"
            
            # Monitor replace progress
            echo "Monitoring replace progress:"
            while btrfs replace status "$mountpoint" | grep -q "Running"; do
                btrfs replace status "$mountpoint"
                sleep 30
            done
            
            echo "Replace operation completed"
            btrfs replace status "$mountpoint"
            ;;
            
        *)
            echo "Usage: manage_btrfs_raid <mountpoint> <status|add|remove|replace> [device]"
            ;;
    esac
}
```

## Best Practices

1. **Choose the Right Filesystem**: Match filesystem to workload characteristics
2. **Optimize Mount Options**: Use appropriate mount options for your use case
3. **Regular Maintenance**: Schedule regular defragmentation and consistency checks
4. **Monitor Performance**: Track filesystem metrics and I/O patterns
5. **Plan for Growth**: Configure filesystems with future capacity in mind

## Conclusion

Linux filesystem optimization requires deep understanding of VFS architecture, filesystem-specific features, and workload characteristics. The techniques covered here—from VFS analysis to filesystem-specific tuning—provide comprehensive tools for building high-performance storage systems.

Effective filesystem optimization combines proper filesystem selection, intelligent configuration, regular maintenance, and continuous monitoring. Whether managing traditional ext4 systems, high-performance XFS deployments, or advanced Btrfs configurations, these techniques ensure optimal storage performance and reliability.