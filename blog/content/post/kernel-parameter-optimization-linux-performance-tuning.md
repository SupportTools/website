---
title: "Kernel Parameter Optimization: Linux Performance Tuning for Production Systems"
date: 2026-08-19T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Kernel", "System Administration", "Tuning", "Production", "Enterprise"]
categories: ["Linux", "Performance", "System Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux kernel parameter optimization for production systems, covering network tuning, memory management, I/O scheduling, and workload-specific configurations for maximum performance."
more_link: "yes"
url: "/kernel-parameter-optimization-linux-performance-tuning/"
---

Master Linux kernel parameter optimization for production systems with this comprehensive guide covering network tuning, memory management, I/O scheduling, and workload-specific configurations to maximize system performance and reliability.

<!--more-->

# Kernel Parameter Optimization: Linux Performance Tuning for Production Systems

## Executive Summary

Kernel parameter tuning is essential for optimizing Linux systems for specific workloads and achieving maximum performance in production environments. This guide provides comprehensive coverage of kernel tuning strategies, from network stack optimization to memory management, with practical examples for various workload types including web servers, databases, container hosts, and high-performance computing systems.

## Understanding Kernel Parameters

### Parameter Types and Persistence

Linux kernel parameters can be configured through multiple mechanisms:

```bash
#!/bin/bash
# Comprehensive kernel parameter management script

cat << 'EOF' > /usr/local/bin/kernel-param-manager.sh
#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to get current parameter value
get_param() {
    local param=$1
    if [ -f "/proc/sys/${param//./\/}" ]; then
        cat "/proc/sys/${param//./\/}"
    else
        log_error "Parameter $param not found"
        return 1
    fi
}

# Function to set parameter temporarily
set_param_temp() {
    local param=$1
    local value=$2
    local param_path="/proc/sys/${param//./\/}"

    if [ -f "$param_path" ]; then
        echo "$value" > "$param_path"
        log_info "Set $param = $value (temporary)"
    else
        log_error "Parameter $param not found"
        return 1
    fi
}

# Function to set parameter persistently
set_param_persistent() {
    local param=$1
    local value=$2
    local sysctl_file="/etc/sysctl.d/99-custom.conf"

    # Create sysctl.d directory if it doesn't exist
    mkdir -p /etc/sysctl.d

    # Check if parameter already exists in config
    if grep -q "^${param}[[:space:]]*=" "$sysctl_file" 2>/dev/null; then
        sed -i "s|^${param}[[:space:]]*=.*|${param} = ${value}|" "$sysctl_file"
        log_info "Updated $param = $value in $sysctl_file"
    else
        echo "${param} = ${value}" >> "$sysctl_file"
        log_info "Added $param = $value to $sysctl_file"
    fi

    # Apply the change
    sysctl -w "${param}=${value}" >/dev/null
    log_info "Applied $param = $value"
}

# Function to backup current configuration
backup_config() {
    local backup_file="/root/sysctl-backup-$(date +%Y%m%d-%H%M%S).conf"
    sysctl -a > "$backup_file" 2>/dev/null
    log_info "Current configuration backed up to $backup_file"
}

# Function to compare configurations
compare_config() {
    local file1=$1
    local file2=$2

    if [ ! -f "$file1" ] || [ ! -f "$file2" ]; then
        log_error "One or both configuration files not found"
        return 1
    fi

    log_info "Comparing configurations..."
    diff -u "$file1" "$file2" || true
}

# Function to validate parameter value
validate_param() {
    local param=$1
    local value=$2
    local param_path="/proc/sys/${param//./\/}"

    if [ ! -f "$param_path" ]; then
        log_error "Parameter $param does not exist"
        return 1
    fi

    # Try to set the value temporarily
    local current_value=$(cat "$param_path")
    if echo "$value" > "$param_path" 2>/dev/null; then
        # Restore original value
        echo "$current_value" > "$param_path"
        log_info "Parameter $param can be set to $value"
        return 0
    else
        log_error "Cannot set $param to $value"
        return 1
    fi
}

# Function to show parameter info
show_param_info() {
    local param=$1
    local param_path="/proc/sys/${param//./\/}"

    if [ ! -f "$param_path" ]; then
        log_error "Parameter $param not found"
        return 1
    fi

    echo "Parameter: $param"
    echo "Current Value: $(cat $param_path)"
    echo "Path: $param_path"

    # Check if parameter is in sysctl.conf
    if grep -q "^${param}[[:space:]]*=" /etc/sysctl.conf 2>/dev/null; then
        echo "Configured in: /etc/sysctl.conf"
        grep "^${param}[[:space:]]*=" /etc/sysctl.conf
    fi

    # Check sysctl.d
    if ls /etc/sysctl.d/*.conf >/dev/null 2>&1; then
        for conf in /etc/sysctl.d/*.conf; do
            if grep -q "^${param}[[:space:]]*=" "$conf" 2>/dev/null; then
                echo "Configured in: $conf"
                grep "^${param}[[:space:]]*=" "$conf"
            fi
        done
    fi
}

# Main command processing
case "${1:-}" in
    get)
        get_param "$2"
        ;;
    set)
        if [ "$#" -lt 3 ]; then
            log_error "Usage: $0 set <parameter> <value> [--persistent]"
            exit 1
        fi
        if [ "${4:-}" = "--persistent" ]; then
            set_param_persistent "$2" "$3"
        else
            set_param_temp "$2" "$3"
        fi
        ;;
    backup)
        backup_config
        ;;
    compare)
        compare_config "$2" "$3"
        ;;
    validate)
        validate_param "$2" "$3"
        ;;
    info)
        show_param_info "$2"
        ;;
    *)
        echo "Usage: $0 {get|set|backup|compare|validate|info} [args]"
        echo
        echo "Commands:"
        echo "  get <parameter>                          - Get current value"
        echo "  set <parameter> <value> [--persistent]   - Set parameter value"
        echo "  backup                                   - Backup current configuration"
        echo "  compare <file1> <file2>                  - Compare two configurations"
        echo "  validate <parameter> <value>             - Validate if value can be set"
        echo "  info <parameter>                         - Show parameter information"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/kernel-param-manager.sh
```

## Network Stack Optimization

### TCP/IP Stack Tuning

```bash
#!/bin/bash
# Network stack optimization for high-performance systems

cat << 'EOF' > /etc/sysctl.d/10-network-performance.conf
# Network Performance Tuning

# ===== TCP/IP Stack =====

# Increase system IP port limits
net.ipv4.ip_local_port_range = 1024 65535

# Increase TCP max buffer size
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728

# Increase Linux autotuning TCP buffer limits
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864

# Increase the maximum amount of option memory buffers
net.core.optmem_max = 25165824

# Increase the tcp-time-wait buckets pool size
net.ipv4.tcp_max_tw_buckets = 1440000

# Reuse TIME-WAIT sockets for new connections
net.ipv4.tcp_tw_reuse = 1

# Increase the maximum number of requests queued
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535

# TCP Fast Open
net.ipv4.tcp_fastopen = 3

# TCP window scaling
net.ipv4.tcp_window_scaling = 1

# Enable TCP timestamps
net.ipv4.tcp_timestamps = 1

# Enable TCP selective acknowledgments
net.ipv4.tcp_sack = 1

# Disable TCP slow start after idle
net.ipv4.tcp_slow_start_after_idle = 0

# TCP keepalive settings
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 10

# TCP SYN cookies for SYN flood protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 8192

# TCP congestion control
net.ipv4.tcp_congestion_control = bbr

# Enable TCP BBR
net.core.default_qdisc = fq

# TCP MTU probing
net.ipv4.tcp_mtu_probing = 1

# TCP orphan and memory settings
net.ipv4.tcp_max_orphans = 262144
net.ipv4.tcp_mem = 786432 1048576 26777216

# ===== UDP Configuration =====

# UDP buffer sizes
net.ipv4.udp_rmem_min = 16384
net.ipv4.udp_wmem_min = 16384

# ===== Network Device Settings =====

# Increase network device queue length
net.core.netdev_budget = 600
net.core.netdev_budget_usecs = 8000

# Increase RPS (Receive Packet Steering) configuration
net.core.rps_sock_flow_entries = 32768

# ===== Connection Tracking =====

# Increase connection tracking table size
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_buckets = 262144

# Connection tracking timeouts
net.netfilter.nf_conntrack_tcp_timeout_established = 3600
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 15
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30

# ===== IPv6 Configuration =====

# Disable IPv6 if not used (uncomment if needed)
# net.ipv6.conf.all.disable_ipv6 = 1
# net.ipv6.conf.default.disable_ipv6 = 1

# IPv6 route table size
net.ipv6.route.max_size = 16384

# ===== Network Security =====

# Disable source routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0

# Disable ICMP redirect acceptance
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0

# Disable ICMP redirect sending
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# Enable bad error message protection
net.ipv4.icmp_ignore_bogus_error_responses = 1

# Enable reverse path filtering
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Log martian packets
net.ipv4.conf.all.log_martians = 0
net.ipv4.conf.default.log_martians = 0

# Ignore ICMP ping requests (uncomment if needed)
# net.ipv4.icmp_echo_ignore_all = 1

# Ignore broadcast ICMP requests
net.ipv4.icmp_echo_ignore_broadcasts = 1
EOF

# Apply settings
sysctl -p /etc/sysctl.d/10-network-performance.conf
```

### Network Interface Tuning

```bash
#!/bin/bash
# Network interface optimization script

cat << 'EOF' > /usr/local/bin/tune-network-interfaces.sh
#!/bin/bash

set -e

# Detect all active network interfaces
INTERFACES=$(ls /sys/class/net | grep -v lo)

echo "=== Network Interface Optimization ==="

for iface in $INTERFACES; do
    echo
    echo "Optimizing interface: $iface"

    # Check if interface is up
    if [ "$(cat /sys/class/net/$iface/operstate)" != "up" ]; then
        echo "Interface $iface is not up, skipping..."
        continue
    fi

    # Increase ring buffer sizes
    ethtool -G $iface rx 4096 tx 4096 2>/dev/null || echo "Cannot set ring buffer size"

    # Enable all multiqueue
    QUEUES=$(ls -d /sys/class/net/$iface/queues/rx-* 2>/dev/null | wc -l)
    if [ $QUEUES -gt 1 ]; then
        echo "Configuring $QUEUES RX queues"
        ethtool -L $iface combined $QUEUES 2>/dev/null || true
    fi

    # Enable offload features
    ethtool -K $iface tso on 2>/dev/null || true
    ethtool -K $iface gso on 2>/dev/null || true
    ethtool -K $iface gro on 2>/dev/null || true
    ethtool -K $iface lro on 2>/dev/null || true

    # Set interrupt coalescing
    ethtool -C $iface rx-usecs 50 2>/dev/null || true
    ethtool -C $iface tx-usecs 50 2>/dev/null || true

    # Configure RSS (Receive Side Scaling)
    if [ -f /sys/class/net/$iface/queues/rx-0/rps_cpus ]; then
        # Get CPU count
        CPU_COUNT=$(nproc)
        # Calculate mask for all CPUs
        MASK=$(printf '%x' $((2**CPU_COUNT - 1)))

        for queue in /sys/class/net/$iface/queues/rx-*; do
            echo $MASK > $queue/rps_cpus
        done
        echo "Enabled RPS on $iface"
    fi

    # Configure RFS (Receive Flow Steering)
    if [ -f /sys/class/net/$iface/queues/rx-0/rps_flow_cnt ]; then
        FLOW_ENTRIES=$((32768 / QUEUES))
        for queue in /sys/class/net/$iface/queues/rx-*; do
            echo $FLOW_ENTRIES > $queue/rps_flow_cnt
        done
        echo "Enabled RFS on $iface"
    fi

    # Configure XPS (Transmit Packet Steering)
    if [ -d /sys/class/net/$iface/queues ]; then
        QUEUE_NUM=0
        for queue in /sys/class/net/$iface/queues/tx-*; do
            if [ -f $queue/xps_cpus ]; then
                # Bind TX queue to specific CPU
                CPU_MASK=$(printf '%x' $((1 << QUEUE_NUM)))
                echo $CPU_MASK > $queue/xps_cpus
                QUEUE_NUM=$((QUEUE_NUM + 1))
            fi
        done
        echo "Enabled XPS on $iface"
    fi

    # Display current settings
    echo "Current settings for $iface:"
    ethtool -g $iface 2>/dev/null | grep -E "RX:|TX:" || true
    ethtool -k $iface 2>/dev/null | grep -E "tcp-segmentation-offload|generic-segmentation-offload|generic-receive-offload" || true
done

echo
echo "=== Network Interface Optimization Complete ==="
EOF

chmod +x /usr/local/bin/tune-network-interfaces.sh
/usr/local/bin/tune-network-interfaces.sh
```

## Memory Management Optimization

### Virtual Memory Tuning

```bash
#!/bin/bash
# Virtual memory optimization

cat << 'EOF' > /etc/sysctl.d/20-memory-management.conf
# Memory Management Optimization

# ===== Virtual Memory Settings =====

# Swappiness (0-100, lower = less swap usage)
# For servers with plenty of RAM: 1-10
# For desktops: 60 (default)
# For systems without swap: 0
vm.swappiness = 1

# Dirty ratio and background ratio
# dirty_ratio: Percentage of RAM that can be filled with dirty pages
# dirty_background_ratio: When to start writing dirty pages to disk
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5

# Dirty expire and writeback times (in centiseconds)
# How old data must be before kernel considers flushing it
vm.dirty_expire_centisecs = 3000
# How often kernel wakes up to check for dirty data
vm.dirty_writeback_centisecs = 500

# VFS cache pressure (100 = balanced, higher = reclaim dentries/inodes more aggressively)
vm.vfs_cache_pressure = 50

# Zone reclaim mode (0 = disabled, better for NUMA systems)
vm.zone_reclaim_mode = 0

# Overcommit memory settings
# 0 = heuristic overcommit (default)
# 1 = always overcommit
# 2 = don't overcommit
vm.overcommit_memory = 0
vm.overcommit_ratio = 50

# Min free kbytes (minimum free memory to maintain)
# Calculate as: sqrt(RAM in KB) * 16
# For 64GB RAM: sqrt(67108864) * 16 = 131072
vm.min_free_kbytes = 131072

# ===== Page Cache and Buffer Management =====

# Percentage of memory where reclaim starts
vm.min_unmapped_ratio = 1

# Extra free kbytes for specific zones
vm.lowmem_reserve_ratio = 256 256 32 0

# ===== Transparent Huge Pages =====

# Set to 'always' or 'madvise' or 'never'
# For databases, often better to disable (never)
# For general purpose, 'madvise' is good
# Configured via /sys/kernel/mm/transparent_hugepage/enabled

# ===== Memory Compaction =====

# Proactiveness of memory compaction (0-100)
vm.compaction_proactiveness = 20

# ===== NUMA Balancing =====

# Auto NUMA balancing (1 = enabled, 0 = disabled)
kernel.numa_balancing = 1

# ===== OOM Killer Settings =====

# Panic on OOM (uncomment if needed)
# vm.panic_on_oom = 0

# OOM kill allocating task
vm.oom_kill_allocating_task = 0

# ===== Memory Limits =====

# Maximum map count (for applications like Elasticsearch)
vm.max_map_count = 262144

# ===== Shared Memory =====

# Shared memory segments
kernel.shmmax = 68719476736
kernel.shmall = 4294967296
kernel.shmmni = 4096

# Semaphore limits
kernel.sem = 250 32000 100 128

# Message queue limits
kernel.msgmax = 65536
kernel.msgmnb = 65536
EOF

# Apply settings
sysctl -p /etc/sysctl.d/20-memory-management.conf
```

### Transparent Huge Pages Configuration

```bash
#!/bin/bash
# Configure Transparent Huge Pages (THP)

cat << 'EOF' > /usr/local/bin/configure-thp.sh
#!/bin/bash

set -e

THP_PATH="/sys/kernel/mm/transparent_hugepage"

configure_thp() {
    local mode=$1

    if [ ! -d "$THP_PATH" ]; then
        echo "THP not available on this system"
        return 1
    fi

    echo "Configuring THP mode: $mode"

    case $mode in
        always)
            echo "always" > $THP_PATH/enabled
            echo "always" > $THP_PATH/defrag
            echo "Enabled THP with aggressive defragmentation"
            ;;
        madvise)
            echo "madvise" > $THP_PATH/enabled
            echo "madvise" > $THP_PATH/defrag
            echo "Enabled THP for madvise-marked regions only"
            ;;
        never)
            echo "never" > $THP_PATH/enabled
            echo "never" > $THP_PATH/defrag
            echo "Disabled THP"
            ;;
        defer)
            echo "defer" > $THP_PATH/enabled
            echo "defer" > $THP_PATH/defrag
            echo "Enabled THP with deferred defragmentation"
            ;;
        defer+madvise)
            echo "defer+madvise" > $THP_PATH/enabled
            echo "defer+madvise" > $THP_PATH/defrag
            echo "Enabled THP with defer and madvise"
            ;;
        *)
            echo "Invalid mode. Use: always, madvise, never, defer, or defer+madvise"
            return 1
            ;;
    esac

    # Configure additional THP settings
    if [ -f "$THP_PATH/khugepaged/pages_to_scan" ]; then
        echo 4096 > $THP_PATH/khugepaged/pages_to_scan
    fi

    if [ -f "$THP_PATH/khugepaged/scan_sleep_millisecs" ]; then
        echo 10000 > $THP_PATH/khugepaged/scan_sleep_millisecs
    fi

    if [ -f "$THP_PATH/khugepaged/alloc_sleep_millisecs" ]; then
        echo 60000 > $THP_PATH/khugepaged/alloc_sleep_millisecs
    fi

    # Display current configuration
    show_thp_status
}

show_thp_status() {
    echo
    echo "=== THP Status ==="
    echo "Enabled: $(cat $THP_PATH/enabled)"
    echo "Defrag: $(cat $THP_PATH/defrag)"

    if [ -f "$THP_PATH/khugepaged/pages_to_scan" ]; then
        echo
        echo "=== KHugepaged Settings ==="
        echo "Pages to scan: $(cat $THP_PATH/khugepaged/pages_to_scan)"
        echo "Scan sleep (ms): $(cat $THP_PATH/khugepaged/scan_sleep_millisecs)"
        echo "Alloc sleep (ms): $(cat $THP_PATH/khugepaged/alloc_sleep_millisecs)"
    fi

    if [ -f "/proc/vmstat" ]; then
        echo
        echo "=== THP Statistics ==="
        grep thp /proc/vmstat
    fi
}

# Main execution
case "${1:-status}" in
    always|madvise|never|defer|defer+madvise)
        configure_thp "$1"
        ;;
    status)
        show_thp_status
        ;;
    *)
        echo "Usage: $0 {always|madvise|never|defer|defer+madvise|status}"
        echo
        echo "Modes:"
        echo "  always         - Enable THP always (may cause latency spikes)"
        echo "  madvise        - Enable only for madvise-marked regions (recommended)"
        echo "  never          - Disable THP completely (for databases)"
        echo "  defer          - Enable with deferred defragmentation"
        echo "  defer+madvise  - Combination of defer and madvise"
        echo "  status         - Show current THP status"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/configure-thp.sh
```

## I/O and Filesystem Optimization

### I/O Scheduler Configuration

```bash
#!/bin/bash
# I/O scheduler optimization

cat << 'EOF' > /usr/local/bin/optimize-io-scheduler.sh
#!/bin/bash

set -e

# Function to detect disk type
detect_disk_type() {
    local disk=$1
    local rotational=$(cat /sys/block/$disk/queue/rotational 2>/dev/null || echo "1")

    if [ "$rotational" = "0" ]; then
        echo "nvme"  # SSD/NVMe
    else
        echo "hdd"   # Rotating disk
    fi
}

# Function to set optimal scheduler
set_optimal_scheduler() {
    local disk=$1
    local disk_type=$(detect_disk_type $disk)

    echo "Configuring scheduler for $disk (type: $disk_type)"

    case $disk_type in
        nvme)
            # For NVMe/SSD: none or mq-deadline
            if [ -f "/sys/block/$disk/queue/scheduler" ]; then
                echo "none" > /sys/block/$disk/queue/scheduler 2>/dev/null || \
                echo "mq-deadline" > /sys/block/$disk/queue/scheduler 2>/dev/null || \
                echo "noop" > /sys/block/$disk/queue/scheduler 2>/dev/null
                echo "Set scheduler to none/mq-deadline for $disk"
            fi

            # NVMe specific tuning
            if [ -d "/sys/block/$disk/queue" ]; then
                echo 2 > /sys/block/$disk/queue/nomerges
                echo 1024 > /sys/block/$disk/queue/nr_requests
                echo 0 > /sys/block/$disk/queue/add_random
                echo 0 > /sys/block/$disk/queue/iostats
            fi
            ;;
        hdd)
            # For HDD: mq-deadline or bfq
            if [ -f "/sys/block/$disk/queue/scheduler" ]; then
                echo "mq-deadline" > /sys/block/$disk/queue/scheduler 2>/dev/null || \
                echo "deadline" > /sys/block/$disk/queue/scheduler 2>/dev/null || \
                echo "cfq" > /sys/block/$disk/queue/scheduler 2>/dev/null
                echo "Set scheduler to mq-deadline for $disk"
            fi

            # HDD specific tuning
            if [ -d "/sys/block/$disk/queue" ]; then
                echo 256 > /sys/block/$disk/queue/nr_requests
                echo 256 > /sys/block/$disk/queue/read_ahead_kb
                echo 1 > /sys/block/$disk/queue/add_random
            fi
            ;;
    esac

    # Common optimizations
    if [ -d "/sys/block/$disk/queue" ]; then
        # Maximum sectors per request
        echo 1024 > /sys/block/$disk/queue/max_sectors_kb

        # Queue depth
        if [ -f "/sys/block/$disk/device/queue_depth" ]; then
            echo 256 > /sys/block/$disk/device/queue_depth
        fi
    fi
}

# Apply to all block devices
echo "=== I/O Scheduler Optimization ==="
for disk in $(lsblk -d -n -o NAME | grep -v loop); do
    set_optimal_scheduler $disk
done

# Display current configuration
echo
echo "=== Current I/O Scheduler Configuration ==="
for disk in $(lsblk -d -n -o NAME | grep -v loop); do
    if [ -f "/sys/block/$disk/queue/scheduler" ]; then
        echo "$disk: $(cat /sys/block/$disk/queue/scheduler)"
    fi
done
EOF

chmod +x /usr/local/bin/optimize-io-scheduler.sh
```

### Filesystem Tuning

```bash
#!/bin/bash
# Filesystem optimization parameters

cat << 'EOF' > /etc/sysctl.d/30-filesystem.conf
# Filesystem Optimization

# ===== File System Limits =====

# Maximum number of open files
fs.file-max = 2097152

# Maximum number of inotify watches
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 8192
fs.inotify.max_queued_events = 32768

# AIO limits
fs.aio-max-nr = 1048576

# ===== Pipe Settings =====

# Maximum size of pipe buffer
fs.pipe-max-size = 1048576
fs.pipe-user-pages-soft = 131072
fs.pipe-user-pages-hard = 262144

# ===== Directory Entry Cache =====

# Dentry cache configuration (increase for many small files)
fs.dentry-state = 0 0 45000 0 0 0

# ===== File Leases =====

# Break time for file leases
fs.lease-break-time = 10

# ===== Protected Hardlinks and Symlinks =====

# Protect against hardlink/symlink attacks
fs.protected_hardlinks = 1
fs.protected_symlinks = 1

# ===== SUID Core Dumps =====

# Allow core dumps with setuid
fs.suid_dumpable = 0
EOF

# Apply settings
sysctl -p /etc/sysctl.d/30-filesystem.conf

# Optimize ext4 filesystems
cat << 'EOF' > /usr/local/bin/optimize-ext4.sh
#!/bin/bash

for fs in $(mount | grep ext4 | awk '{print $1}'); do
    echo "Optimizing ext4 filesystem: $fs"

    # Enable writeback for better performance
    tune2fs -o journal_data_writeback $fs

    # Set commit interval
    tune2fs -o commit=30 $fs

    # Disable access time updates in fstab
    # (Add noatime,nodiratime to mount options)
done
EOF

chmod +x /usr/local/bin/optimize-ext4.sh
```

## Workload-Specific Optimizations

### Database Server Tuning

```bash
#!/bin/bash
# Database server kernel optimization

cat << 'EOF' > /etc/sysctl.d/50-database.conf
# Database Server Optimization

# ===== Memory Management for Databases =====

# Disable swap completely for databases
vm.swappiness = 0

# Large page support
vm.nr_hugepages = 2048
vm.hugetlb_shm_group = 1001

# Overcommit settings for databases
vm.overcommit_memory = 2
vm.overcommit_ratio = 80

# Dirty page settings for databases
vm.dirty_ratio = 5
vm.dirty_background_ratio = 2
vm.dirty_expire_centisecs = 500
vm.dirty_writeback_centisecs = 100

# ===== Shared Memory for Databases =====

# Increase shared memory limits
kernel.shmmax = 137438953472  # 128GB
kernel.shmall = 33554432      # 128GB in pages
kernel.shmmni = 4096

# Semaphore limits for database connections
kernel.sem = 250 256000 100 1024

# ===== Network Tuning for Databases =====

# TCP keepalive for database connections
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 3

# Increase local port range
net.ipv4.ip_local_port_range = 10000 65535

# TCP memory for many connections
net.ipv4.tcp_mem = 8388608 12582912 16777216

# ===== I/O Settings =====

# Scheduler settings for database I/O
# Applied per-device in separate script

# AIO settings
fs.aio-max-nr = 3145728

# File descriptor limits
fs.file-max = 6815744

# ===== Process Limits =====

# Core file size
kernel.core_uses_pid = 1
kernel.core_pattern = /var/crash/core-%e-%p-%t

# PID maximum
kernel.pid_max = 4194304
EOF

# Create systemd override for database services
mkdir -p /etc/systemd/system/postgresql.service.d
cat << 'EOF' > /etc/systemd/system/postgresql.service.d/limits.conf
[Service]
LimitNOFILE=1048576
LimitNPROC=1048576
LimitCORE=infinity
LimitMEMLOCK=infinity
EOF

sysctl -p /etc/sysctl.d/50-database.conf
systemctl daemon-reload
```

### Container Host Optimization

```bash
#!/bin/bash
# Container host kernel optimization

cat << 'EOF' > /etc/sysctl.d/60-container-host.conf
# Container Host Optimization

# ===== Network Optimization for Containers =====

# Bridge netfilter
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1

# IP forwarding for container networking
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1

# Conntrack for container networking
net.netfilter.nf_conntrack_max = 1000000
net.netfilter.nf_conntrack_buckets = 250000
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 3600

# Port range for containers
net.ipv4.ip_local_port_range = 1024 65535

# TCP settings for container workloads
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_max_tw_buckets = 1440000

# Socket buffers
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 262144
net.core.wmem_default = 262144

# Netfilter performance
net.netfilter.nf_conntrack_generic_timeout = 120
net.netfilter.nf_conntrack_tcp_timeout_syn_recv = 30
net.netfilter.nf_conntrack_tcp_timeout_syn_sent = 30

# ===== Memory Management for Containers =====

# Swappiness for container hosts
vm.swappiness = 10

# Memory overcommit for containers
vm.overcommit_memory = 1

# OOM handling
vm.panic_on_oom = 0
vm.oom_kill_allocating_task = 0

# Page cache management
vm.vfs_cache_pressure = 100
vm.dirty_ratio = 20
vm.dirty_background_ratio = 10

# Memory limits
vm.max_map_count = 262144

# ===== Kernel Settings for Containers =====

# Namespace limits
user.max_user_namespaces = 63838
user.max_pid_namespaces = 63838
user.max_net_namespaces = 63838
user.max_ipc_namespaces = 63838
user.max_uts_namespaces = 63838
user.max_mnt_namespaces = 63838
user.max_cgroup_namespaces = 63838

# Process limits
kernel.pid_max = 4194304
kernel.threads-max = 4194304

# File descriptor limits
fs.file-max = 2097152
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 524288

# ===== Security Settings =====

# Disable ICMP redirects
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0

# Enable martian packet logging
net.ipv4.conf.all.log_martians = 0

# Reverse path filtering
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
EOF

# Load br_netfilter module
modprobe br_netfilter
echo "br_netfilter" > /etc/modules-load.d/br_netfilter.conf

sysctl -p /etc/sysctl.d/60-container-host.conf
```

### Web Server Tuning

```bash
#!/bin/bash
# Web server kernel optimization

cat << 'EOF' > /etc/sysctl.d/70-webserver.conf
# Web Server Optimization

# ===== TCP Settings for Web Traffic =====

# TCP buffer sizes for web traffic
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# Connection handling
net.core.somaxconn = 32768
net.core.netdev_max_backlog = 16384

# TCP Fast Open for faster connections
net.ipv4.tcp_fastopen = 3

# SYN flood protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 8192

# Connection reuse
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_max_tw_buckets = 400000

# Port range
net.ipv4.ip_local_port_range = 15000 65535

# TCP congestion control
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq

# Keepalive settings
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 3

# ===== Connection Tracking =====

# Increase conntrack table
net.netfilter.nf_conntrack_max = 524288
net.netfilter.nf_conntrack_tcp_timeout_established = 1200

# ===== Memory Settings =====

# Moderate swappiness
vm.swappiness = 30

# Cache pressure for static content
vm.vfs_cache_pressure = 80

# File cache tuning
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5

# ===== File Limits =====

# Open file limits for web server
fs.file-max = 1048576

# ===== Security =====

# SYN flood protection
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_syn_retries = 2
EOF

sysctl -p /etc/sysctl.d/70-webserver.conf
```

## Performance Monitoring and Validation

### Kernel Parameter Monitoring

```bash
#!/bin/bash
# Monitor kernel parameter effectiveness

cat << 'EOF' > /usr/local/bin/monitor-kernel-params.sh
#!/bin/bash

set -e

LOG_DIR="/var/log/kernel-tuning"
mkdir -p "$LOG_DIR"

# Function to log metrics
log_metrics() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local output_file="$LOG_DIR/metrics-$(date +%Y%m%d).log"

    {
        echo "=== Metrics at $timestamp ==="

        # Network metrics
        echo "--- Network Statistics ---"
        ss -s
        cat /proc/net/sockstat
        cat /proc/net/netstat | grep -E "TcpExt|IpExt"

        # Memory metrics
        echo "--- Memory Statistics ---"
        free -m
        cat /proc/vmstat | grep -E "pgpgin|pgpgout|pswpin|pswpout|nr_dirty|nr_writeback"

        # I/O metrics
        echo "--- I/O Statistics ---"
        iostat -x 1 2

        # System load
        echo "--- System Load ---"
        uptime
        cat /proc/loadavg

        # Connection tracking
        echo "--- Connection Tracking ---"
        cat /proc/sys/net/netfilter/nf_conntrack_count
        cat /proc/sys/net/netfilter/nf_conntrack_max

        echo "================================"
        echo
    } | tee -a "$output_file"
}

# Function to check for tuning issues
check_tuning_issues() {
    echo "=== Checking for Tuning Issues ==="

    # Check for dropped packets
    DROPS=$(netstat -s | grep -i "segments retransmited\|packets pruned\|dropped")
    if [ -n "$DROPS" ]; then
        echo "WARNING: Packet drops detected:"
        echo "$DROPS"
    fi

    # Check for TCP buffer pressure
    PRESSURE=$(cat /proc/net/sockstat | grep "TCP: inuse")
    echo "TCP connections: $PRESSURE"

    # Check for memory pressure
    SWAP_USED=$(free | grep Swap | awk '{print $3}')
    if [ "$SWAP_USED" -gt 0 ]; then
        echo "WARNING: Swap in use: ${SWAP_USED}KB"
    fi

    # Check for conntrack table usage
    CONNTRACK_USAGE=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo 0)
    CONNTRACK_MAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 1)
    CONNTRACK_PCT=$((CONNTRACK_USAGE * 100 / CONNTRACK_MAX))

    if [ "$CONNTRACK_PCT" -gt 80 ]; then
        echo "WARNING: Connection tracking table ${CONNTRACK_PCT}% full"
    fi

    echo "================================"
}

# Main monitoring loop
case "${1:-}" in
    once)
        log_metrics
        check_tuning_issues
        ;;
    continuous)
        echo "Starting continuous monitoring (interval: ${2:-60}s)"
        while true; do
            log_metrics
            check_tuning_issues
            sleep "${2:-60}"
        done
        ;;
    *)
        echo "Usage: $0 {once|continuous [interval]}"
        echo "  once              - Run monitoring once"
        echo "  continuous [sec]  - Run continuously with interval (default: 60s)"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/monitor-kernel-params.sh
```

## Conclusion

Kernel parameter optimization is crucial for achieving optimal performance in production Linux systems. The configurations provided in this guide cover network stack tuning, memory management, I/O optimization, and workload-specific tuning for databases, container hosts, and web servers. Regular monitoring and validation ensure that tuning parameters remain effective as workloads evolve.

Key optimization strategies:
- Understand your workload characteristics before tuning
- Start with conservative values and adjust based on monitoring
- Document all changes and maintain configuration management
- Use workload-specific profiles for different system roles
- Monitor effectiveness with appropriate metrics
- Test changes in non-production environments first
- Maintain kernel parameter configurations in version control
- Regularly review and update tuning as kernel versions change