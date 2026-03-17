---
title: "Linux Kernel Tuning for Production Workloads: sysctl, cgroups, and NUMA"
date: 2028-10-10T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Performance", "sysctl", "Kubernetes"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Linux kernel tuning covering key sysctl parameters for network, filesystem, and VM subsystems, NUMA topology awareness, CPU frequency governors, IRQ affinity, cgroup v2 for container workloads, and benchmark validation."
more_link: "yes"
url: "/linux-kernel-tuning-production-workloads-guide/"
---

Linux default kernel parameters are tuned for general workloads, not for high-throughput web services, database servers, or Kubernetes nodes. Correctly tuning sysctl parameters, configuring NUMA-aware scheduling, setting CPU frequency governors, and configuring cgroup v2 for container workloads can yield 20-50% throughput improvements with no hardware changes. This guide covers each subsystem with production-tested values and validation benchmarks.

<!--more-->

# Linux Kernel Tuning for Production Workloads: sysctl, cgroups, and NUMA

## Understanding the Tuning Hierarchy

Kernel parameters live at four levels:

1. **Boot-time** (`/proc/cmdline`, kernel command line): Low-level hardware configuration, NUMA policies, memory allocation
2. **Runtime** (`/proc/sys/`, `sysctl`): Networking, memory management, filesystem—most parameters
3. **cgroup**: Per-process or per-container limits enforced by the kernel
4. **Application**: Process-level settings (ulimits, socket options)

Always tune from top to bottom: a cgroup memory limit is irrelevant if the system is already swap-thrashing due to incorrect `vm.swappiness`.

## Baseline Measurement Before Tuning

Never tune without a baseline. Record current performance before changing any parameters:

```bash
#!/bin/bash
# baseline-capture.sh

OUTPUT_DIR="/var/log/kernel-tuning-baseline-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

# Current sysctl values
sysctl -a > "$OUTPUT_DIR/sysctl-before.txt" 2>/dev/null

# CPU info
lscpu > "$OUTPUT_DIR/cpu-info.txt"
numactl --hardware > "$OUTPUT_DIR/numa-info.txt"

# Memory info
cat /proc/meminfo > "$OUTPUT_DIR/meminfo.txt"

# Network performance baseline (requires iperf3 on server)
# iperf3 -c benchmark-server -t 30 -P 8 > "$OUTPUT_DIR/network-before.txt"

# Disk I/O baseline
fio --name=rand-read \
    --ioengine=libaio \
    --iodepth=32 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --size=4G \
    --numjobs=4 \
    --runtime=60 \
    --time_based \
    --output="$OUTPUT_DIR/fio-before.txt" \
    /tmp/fio-test

echo "Baseline captured to $OUTPUT_DIR"
```

## Network sysctl Parameters

### TCP Connection Management

```bash
cat >> /etc/sysctl.d/10-network.conf << 'EOF'
# Maximum number of open file descriptors system-wide
# Each TCP connection uses 1 file descriptor; ensure this is high enough
fs.file-max = 2097152

# TIME_WAIT bucket count - prevents exhaustion under high connection churn
net.ipv4.tcp_max_tw_buckets = 2000000

# Allow reuse of TIME_WAIT sockets for new connections from same source
# Safe for servers; can cause issues if your load balancer uses NAT
net.ipv4.tcp_tw_reuse = 1

# Maximum listen backlog for sockets (accept queue depth)
# Increase for services with bursty connection acceptance
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# SYN cookie protection (prevents SYN flood exhaustion)
net.ipv4.tcp_syncookies = 1

# Time to wait before retrying failed connections
net.ipv4.tcp_syn_retries = 2
net.ipv4.tcp_synack_retries = 2

# Reduce FIN_WAIT2 timeout from default 60s
net.ipv4.tcp_fin_timeout = 15

# TCP keepalive settings (detect dead peers faster)
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 5

# Disable TCP slow start restart after idle
# Important for long-lived connections that send data in bursts
net.ipv4.tcp_slow_start_after_idle = 0
EOF
```

### TCP Buffer Sizes

```bash
cat >> /etc/sysctl.d/10-network.conf << 'EOF'
# TCP socket receive buffer (min, default, max) in bytes
# For 10 Gbps links with 200ms RTT: optimal buffer = bandwidth * RTT / 8
# = 10e9 * 0.2 / 8 = 250MB; set max to 256MB
net.core.rmem_default = 262144
net.core.rmem_max = 268435456
net.ipv4.tcp_rmem = 4096 87380 268435456

# TCP socket send buffer
net.core.wmem_default = 262144
net.core.wmem_max = 268435456
net.ipv4.tcp_wmem = 4096 65536 268435456

# UDP buffer sizes
net.core.netdev_max_backlog = 65535

# TCP memory pages (min, pressure threshold, max) in pages
# Each page = 4KB; these values govern global TCP memory usage
net.ipv4.tcp_mem = 786432 1048576 26777216

# Enable TCP window scaling (allows buffers >65535 bytes)
net.ipv4.tcp_window_scaling = 1

# Enable TCP SACK (selective acknowledgment)
net.ipv4.tcp_sack = 1

# Enable TCP FACK (forward acknowledgment)
net.ipv4.tcp_fack = 1

# Increase the size of the routing table cache
net.ipv4.route.max_size = 8388608
EOF
```

### Network Device Queue Depths

```bash
cat >> /etc/sysctl.d/10-network.conf << 'EOF'
# Queue length for ingress frames before the network stack starts dropping
# Increase for high packet rate workloads
net.core.netdev_max_backlog = 300000

# Default TX queue length for network interfaces
# Set per-interface: ip link set eth0 txqueuelen 10000
net.core.default_qdisc = fq

# Enable BBR congestion control (better throughput, lower latency than CUBIC)
net.ipv4.tcp_congestion_control = bbr
EOF

# Load BBR module
modprobe tcp_bbr
echo "tcp_bbr" >> /etc/modules-load.d/bbr.conf
```

Apply network settings:

```bash
sysctl --load=/etc/sysctl.d/10-network.conf

# Verify BBR is active
sysctl net.ipv4.tcp_congestion_control
# Expected: net.ipv4.tcp_congestion_control = bbr
```

## Filesystem sysctl Parameters

```bash
cat > /etc/sysctl.d/20-filesystem.conf << 'EOF'
# Maximum number of file handles system-wide
fs.file-max = 2097152

# Maximum number of inotify watches per user
# Increase for development environments or services that watch many directories
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 8192
fs.inotify.max_queued_events = 65536

# Maximum number of file descriptors per process (override with ulimit -n)
# Set in /etc/security/limits.conf for persistent per-user limits
# * soft nofile 1048576
# * hard nofile 1048576

# Directory entry cache pressure
# Default 100 tends to evict dentries too aggressively under memory pressure
# Reduce for workloads with large directory traversal patterns
vm.vfs_cache_pressure = 50

# AIO request limit (relevant for databases using libaio)
fs.aio-max-nr = 1048576

# Pipe buffer size (relevant for log aggregation pipelines)
fs.pipe-max-size = 1048576
EOF

sysctl --load=/etc/sysctl.d/20-filesystem.conf
```

## Virtual Memory sysctl Parameters

```bash
cat > /etc/sysctl.d/30-vm.conf << 'EOF'
# Swap tendency: 0 = never swap application memory, 100 = aggressively swap
# For application servers: 10 (keep hot data in RAM, allow some buffer swap)
# For Kubernetes nodes: 0 (Kubernetes requires no swap, or very low)
# For databases: 0-10 (never swap database pages)
vm.swappiness = 10

# Overcommit memory allocation:
# 0 = heuristic (default): allows some overcommit
# 1 = always overcommit (unsafe for production, used by Redis cluster)
# 2 = never overcommit beyond (CommitLimit)
vm.overcommit_memory = 1
vm.overcommit_ratio = 50  # Used when overcommit_memory=2

# Dirty page write-back thresholds
# dirty_ratio: percentage of total memory that can be dirty before a process
# itself is forced to write dirty pages (synchronous, causes latency spikes)
vm.dirty_ratio = 10

# dirty_background_ratio: percentage at which background writeback starts
# (asynchronous, no process impact)
vm.dirty_background_ratio = 5

# Dirty page expiry: force writeback of pages older than N centiseconds
# 3000cs = 30 seconds (default); reduce for crash-consistency sensitive apps
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500

# Minimum free memory before kernel activates OOM killer
# Expressed in pages (4KB); 65536 * 4KB = 256MB reserved
vm.min_free_kbytes = 262144

# Huge pages for databases (PostgreSQL, Oracle, MySQL)
# Calculate: database shared_buffers / 2MB
# vm.nr_hugepages = 4096  # 4096 * 2MB = 8GB of huge pages

# Transparent Huge Pages: disable for database workloads (causes TLB flush latency)
# Control via /sys/kernel/mm/transparent_hugepage/enabled
# echo never > /sys/kernel/mm/transparent_hugepage/enabled
EOF

sysctl --load=/etc/sysctl.d/30-vm.conf

# Disable THP for database/latency-sensitive workloads
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Persist THP setting
cat >> /etc/rc.local << 'EOF'
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
EOF
```

## NUMA Topology Awareness

On multi-socket servers, memory access latency depends on whether the CPU is on the same NUMA node as the memory. Mismatched NUMA access is 2-3x slower than local access.

```bash
# Check NUMA topology
numactl --hardware
# Example output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
# node 0 size: 128699 MB
# node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
# node 1 size: 128937 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Show current NUMA policy
numactl --show

# Run a process bound to NUMA node 0 (CPU cores + memory)
numactl --cpunodebind=0 --membind=0 /usr/bin/myapp

# Prefer NUMA-local memory but fall back to remote
numactl --preferred=0 /usr/bin/myapp

# Check NUMA memory statistics
cat /proc/vmstat | grep numa

# Per-process NUMA binding for long-running services
# Add to systemd unit:
# ExecStart=/usr/bin/numactl --cpunodebind=0 --membind=0 /usr/bin/myapp
```

### NUMA sysctl Parameters

```bash
cat > /etc/sysctl.d/40-numa.conf << 'EOF'
# NUMA memory balancing: background thread migrates hot pages to local NUMA node
# Enable for general-purpose workloads; disable for latency-sensitive apps
# (migration itself causes brief latency spikes)
kernel.numa_balancing = 1

# Zone reclaim mode: how aggressively reclaim from non-local zones
# 0 = try remote zones before reclaim (default; better for most workloads)
# 1 = reclaim from local zone before going remote (better for NUMA-aware apps)
vm.zone_reclaim_mode = 0
EOF

sysctl --load=/etc/sysctl.d/40-numa.conf
```

### Identifying NUMA Imbalance

```bash
# Check NUMA hits/misses (high interleave_miss or numa_miss indicates imbalance)
numastat -s
# Output:
# Per-node numastat info (in MBs):
#                           Node 0          Node 1           Total
#                  --------------- --------------- ---------------
# Numa_Hit                  450203          301234          751437
# Numa_Miss                  12344           45231           57575  <- HIGH: process is hitting wrong NUMA node
# Numa_Foreign               45231           12344           57575
# Interleave_Hit               167             163             330
# Local_Node                450189          301220          751409
# Other_Node                 12344           45231           57575

# Check per-process NUMA stats
numastat -p $(pgrep myapp)
```

## CPU Frequency Scaling Governors

```bash
# Check current governor on all CPUs
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort -u

# Available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors

# Set performance governor for all CPUs (disables dynamic frequency scaling)
# Best for latency-sensitive workloads; increases power consumption
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo "performance" > "$cpu"
done

# Set powersave governor for batch/background workloads
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo "powersave" > "$cpu"
done

# Persist via cpupower (install: apt install linux-tools-common)
cpupower frequency-set -g performance

# Or persist via systemd service
cat > /etc/systemd/system/cpu-performance-governor.service << 'EOF'
[Unit]
Description=Set CPU governor to performance
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance > "$f"; done'
ExecStop=/bin/sh -c 'for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo powersave > "$f"; done'

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now cpu-performance-governor.service
```

### C-States and P-States

For ultra-low latency (HFT, real-time control), disable CPU C-states:

```bash
# Disable deep C-states via kernel command line (add to GRUB_CMDLINE_LINUX)
# intel_idle.max_cstate=1 processor.max_cstate=1 idle=poll

# Check current C-state residency
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/name
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/usage

# Disable a specific C-state (0 = disable)
echo 1 > /sys/devices/system/cpu/cpu0/cpuidle/state3/disable
```

## IRQ Affinity

Network card IRQs should be distributed across CPUs to prevent a single CPU from becoming an interrupt bottleneck:

```bash
# List network IRQs
grep eth0 /proc/interrupts

# Show current IRQ affinity (which CPUs handle the interrupt)
cat /proc/irq/XX/smp_affinity_list  # Replace XX with IRQ number

# Automatically balance IRQs across CPUs (use irqbalance)
systemctl enable --now irqbalance

# Or manually pin network card IRQs to specific CPUs
# Pin IRQ 24 to CPUs 0-3 (bitmask: 0xf = CPUs 0-3)
echo "f" > /proc/irq/24/smp_affinity

# For high-performance NIC with multiple queues, use set_irq_affinity script
# available in most NIC vendor packages
# ethtool -L eth0 combined 16  # Set 16 TX/RX queues
# for i in $(seq 0 15); do
#   echo "$i" > /proc/irq/$(grep "eth0-TxRx-$i" /proc/interrupts | awk '{print $1}' | tr -d :)/smp_affinity_list
# done
```

## cgroup v2 for Container Workloads

### Enabling cgroup v2

```bash
# Check if cgroup v2 is enabled
cat /proc/filesystems | grep cgroup
mount | grep cgroup

# Enable cgroup v2 (add to kernel command line in GRUB)
# systemd.unified_cgroup_hierarchy=1

# For Kubernetes, set kubelet flag:
# --cgroup-driver=systemd (when using systemd cgroup driver)
# Verify: kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.containerRuntimeVersion}'
```

### cgroup v2 Resource Control

```bash
# Check cgroup v2 hierarchy
ls /sys/fs/cgroup/
cat /sys/fs/cgroup/kubepods.slice/memory.current

# Set memory limit for a cgroup
echo "2147483648" > /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/memory.high  # 2GB soft limit
echo "3221225472" > /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/memory.max   # 3GB hard limit

# CPU weight (replaces CPU shares from v1)
# Default: 100; range: 1-10000
echo "200" > /sys/fs/cgroup/kubepods.slice/kubepods-guaranteed.slice/cpu.weight

# CPU bandwidth (quota/period microseconds)
# 200000/1000000 = 20% of one CPU
echo "200000 1000000" > /sys/fs/cgroup/kubepods.slice/cpu.max

# IO weight
echo "200" > /sys/fs/cgroup/kubepods.slice/io.weight
```

### Kubernetes cgroup Configuration

```yaml
# KubeletConfiguration for optimal cgroup v2 integration
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
cgroupVersion: v2
# Enable CPU Manager for guaranteed QoS pods
cpuManagerPolicy: static
# Reserve resources for system and kubelet
reservedSystemCPUs: "0-1"
kubeReserved:
  cpu: "500m"
  memory: "1Gi"
  ephemeral-storage: "1Gi"
systemReserved:
  cpu: "500m"
  memory: "2Gi"
  ephemeral-storage: "5Gi"
# Eviction thresholds to prevent OOM kills
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"
  imagefs.available: "15%"
evictionSoft:
  memory.available: "1Gi"
  nodefs.available: "15%"
evictionSoftGracePeriod:
  memory.available: "2m"
  nodefs.available: "5m"
```

## Complete Production sysctl Configuration

Consolidate all tuning into versioned configuration files:

```bash
cat > /etc/sysctl.d/99-production-tuning.conf << 'EOF'
# ============================================================
# Production Linux kernel tuning for application servers
# Generated: $(date +%Y-%m-%d)
# Host type: Kubernetes node / web server
# ============================================================

# --- Networking ---
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_max_tw_buckets = 2000000
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_syncookies = 1
net.core.netdev_max_backlog = 300000
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
net.ipv4.tcp_rmem = 4096 87380 268435456
net.ipv4.tcp_wmem = 4096 65536 268435456
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# --- File System ---
fs.file-max = 2097152
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 8192
fs.inotify.max_queued_events = 65536
fs.aio-max-nr = 1048576
vm.vfs_cache_pressure = 50

# --- Virtual Memory ---
vm.swappiness = 10
vm.overcommit_memory = 1
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500
vm.min_free_kbytes = 262144

# --- NUMA ---
kernel.numa_balancing = 1
vm.zone_reclaim_mode = 0

# --- Kernel ---
kernel.pid_max = 4194304
kernel.threads-max = 4194304
kernel.panic = 10
kernel.panic_on_oops = 1
EOF

# Apply immediately
sysctl --load=/etc/sysctl.d/99-production-tuning.conf --system

# Set ulimits
cat >> /etc/security/limits.d/99-production.conf << 'EOF'
* soft nofile 1048576
* hard nofile 1048576
* soft nproc 65536
* hard nproc 65536
root soft nofile 1048576
root hard nofile 1048576
EOF
```

## Validating Tuning with Benchmarks

### Network Throughput Validation

```bash
# Install iperf3
apt-get install -y iperf3

# Server side (on benchmark server)
iperf3 -s -p 5201

# Client side (on the tuned server)
# Multi-stream TCP throughput
iperf3 -c benchmark-server \
  -t 60 \
  -P 8 \
  --json > /tmp/iperf3-after.txt

jq '.end.sum_received.bits_per_second / 1e9' /tmp/iperf3-after.txt
# Target: >9 Gbps on 10GbE

# Compare with baseline
echo "Before: $(jq '.end.sum_received.bits_per_second / 1e9' /tmp/iperf3-before.txt) Gbps"
echo "After:  $(jq '.end.sum_received.bits_per_second / 1e9' /tmp/iperf3-after.txt) Gbps"
```

### Connection Rate Validation

```bash
# Install wrk (HTTP benchmarking tool)
apt-get install -y wrk

# Test maximum connections per second (measures somaxconn/syncookies effectiveness)
wrk -t12 -c400 -d60s http://localhost:8080/health

# Expected output:
# Running 60s test @ http://localhost:8080/health
# 12 threads and 400 connections
#   Thread Stats   Avg      Stdev     Max   +/- Stdev
#     Latency   892.87us    2.22ms  53.40ms   92.94%
#     Req/Sec    46.45k     4.64k   61.40k    67.03%
#   Latency Distribution
#      50%  424.00us
#      75%  664.00us
#      90%    1.42ms
#      99%   11.15ms
#   33,260,256 requests in 60.03s, 3.85GB read
```

### Disk I/O Validation

```bash
# FIO random read benchmark (database-like workload)
fio --name=rand-read-after \
    --ioengine=libaio \
    --iodepth=64 \
    --rw=randrw \
    --rwmixread=70 \
    --bs=4k \
    --direct=1 \
    --size=8G \
    --numjobs=8 \
    --runtime=120 \
    --time_based \
    --group_reporting \
    /tmp/fio-test

# Key metrics to compare:
# IOPS: random 4k read (target: >100k IOPS on NVMe)
# Latency: p99 < 1ms for SSDs, p99 < 5ms for HDDs
```

### Memory Bandwidth Test

```bash
# Install stream benchmark
apt-get install -y stream

# Run STREAM benchmark (measures memory bandwidth, NUMA-sensitive)
stream_c -v

# Or use numactl to compare NUMA-local vs remote bandwidth
numactl --cpunodebind=0 --membind=0 stream_c
numactl --cpunodebind=0 --membind=1 stream_c  # Should be ~2x slower
```

## Kubernetes-Specific sysctl Tuning

```yaml
# Pod-level sysctl overrides (namespaced sysctl only)
# Requires AllowedUnsafeSysctls in kubelet config for unsafe sysctls
apiVersion: v1
kind: Pod
metadata:
  name: high-performance-app
spec:
  securityContext:
    sysctls:
      # Safe sysctls (network namespace-scoped)
      - name: net.core.somaxconn
        value: "65535"
      - name: net.ipv4.tcp_tw_reuse
        value: "1"
      - name: net.ipv4.ip_local_port_range
        value: "1024 65535"
  containers:
    - name: app
      image: myapp:latest
```

Enable unsafe sysctl overrides in kubelet:

```yaml
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
allowedUnsafeSysctls:
  - "net.core.somaxconn"
  - "net.ipv4.tcp_tw_reuse"
  - "net.ipv4.tcp_fin_timeout"
```

## Summary

Linux kernel tuning is multiplicative: network buffer sizing, TCP congestion control, NUMA affinity, and cgroup memory configuration each contribute independently to overall performance. The network tunings (somaxconn, tcp_tw_reuse, TCP buffer sizes, BBR congestion control) have the most immediate impact for web and API servers. The VM tunings (swappiness, dirty_ratio, THP configuration) matter most for databases and memory-intensive applications. NUMA affinity and CPU governor settings become significant on multi-socket servers with more than 32 cores. Always validate each change with before/after benchmarks, and use versioned configuration files so that changes are auditable and reversible.
