---
title: "Linux Kernel Performance Tuning: Production Systems Optimization Guide"
date: 2027-09-17T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Kernel", "Tuning", "DevOps"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux kernel parameter tuning for production systems, covering sysctl settings, CPU scheduling, memory management, network stack optimization, I/O schedulers, and kernel profiling with perf and ftrace."
more_link: "yes"
url: "/linux-kernel-performance-tuning-guide/"
---

Production Linux systems routinely leave significant performance on the table because default kernel parameters are tuned for broad compatibility rather than workload-specific throughput. This guide walks through every major subsystem — CPU scheduler, memory, network, and I/O — with concrete sysctl values, the reasoning behind each change, and measurement methodology to validate improvements before committing to production.

<!--more-->

# Linux Kernel Performance Tuning: Production Systems Optimization Guide

## Section 1: Establishing a Baseline Before Tuning

Performance tuning without measurement is guesswork. Every change needs a before/after comparison with the same workload under the same conditions.

### Capturing System State

```bash
#!/usr/bin/env bash
# baseline-capture.sh — record pre-tuning system state

OUTDIR="/var/log/perf-baseline-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${OUTDIR}"

# Kernel version and hardware topology
uname -r > "${OUTDIR}/kernel.txt"
lscpu > "${OUTDIR}/lscpu.txt"
numactl --hardware > "${OUTDIR}/numa.txt"

# All current sysctl values
sysctl -a > "${OUTDIR}/sysctl-before.txt" 2>/dev/null

# Scheduler stats
cat /proc/schedstat > "${OUTDIR}/schedstat.txt"

# Memory stats
cat /proc/meminfo > "${OUTDIR}/meminfo.txt"
cat /proc/buddyinfo > "${OUTDIR}/buddyinfo.txt"
cat /proc/vmstat > "${OUTDIR}/vmstat.txt"

# Block device queues
for dev in /sys/block/*/queue; do
  echo "=== ${dev} ===" >> "${OUTDIR}/block-queues.txt"
  for param in scheduler nr_requests read_ahead_kb rotational; do
    printf "  %s = %s\n" "${param}" "$(cat "${dev}/${param}" 2>/dev/null)" \
      >> "${OUTDIR}/block-queues.txt"
  done
done

# Network interface config
for iface in $(ls /sys/class/net | grep -v lo); do
  ethtool "${iface}" >> "${OUTDIR}/ethtool-${iface}.txt" 2>/dev/null
  ethtool -k "${iface}" >> "${OUTDIR}/ethtool-offload-${iface}.txt" 2>/dev/null
  ethtool -g "${iface}" >> "${OUTDIR}/ethtool-rings-${iface}.txt" 2>/dev/null
done

echo "Baseline captured in ${OUTDIR}"
```

### Key Metrics to Measure

| Subsystem | Tool | Key Metric |
|-----------|------|-----------|
| CPU | `mpstat -P ALL 1 10` | %usr, %sys, %iowait, %steal |
| Memory | `vmstat 1 10` | si/so (swap in/out), free |
| Network | `sar -n DEV 1 10` | rxpck/s, txpck/s, rxkB/s |
| I/O | `iostat -x 1 10` | await, %util, r/s, w/s |
| Latency | `perf stat -a sleep 10` | context-switches, migrations |

---

## Section 2: CPU Scheduler Tuning

### Understanding CFS Scheduler Parameters

The Completely Fair Scheduler governs how CPU time is distributed. Several tunables directly affect latency-sensitive workloads.

```bash
# View current CFS parameters
cat /proc/sys/kernel/sched_min_granularity_ns
cat /proc/sys/kernel/sched_wakeup_granularity_ns
cat /proc/sys/kernel/sched_latency_ns
cat /proc/sys/kernel/sched_migration_cost_ns
```

```ini
# /etc/sysctl.d/10-cpu-scheduler.conf

# Minimum time a task runs before being preempted (nanoseconds).
# Default 750000 (750us). Lowering reduces latency for interactive
# workloads; raising improves throughput for batch jobs.
kernel.sched_min_granularity_ns = 1000000

# Target scheduling latency — the period over which all runnable tasks
# should get at least one run. Default 6000000 (6ms).
kernel.sched_latency_ns = 4000000

# How much of a wakeup advantage a waking task gets. Default 1000000 (1ms).
# Raise for latency-sensitive apps; keep low for compute-bound workloads.
kernel.sched_wakeup_granularity_ns = 500000

# Cost attributed to task migration between CPUs. Raising makes the
# scheduler less eager to migrate, reducing cache invalidation on NUMA.
kernel.sched_migration_cost_ns = 5000000

# RT tasks can use up to 95% of any given period
kernel.sched_rt_runtime_us = 950000
kernel.sched_rt_period_us  = 1000000
```

### NUMA-Aware Scheduling

On multi-socket systems, improper NUMA binding causes remote memory access latency spikes.

```bash
# Identify NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
# node 0 size: 64338 MB
# node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
# node 1 size: 64502 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Pin a process to a specific NUMA node
numactl --cpunodebind=0 --membind=0 /usr/bin/myapp

# Check NUMA statistics
numastat -p $(pgrep myapp)
```

```ini
# /etc/sysctl.d/11-numa.conf

# Allow automatic NUMA balancing. The kernel periodically remaps
# memory to the NUMA node where it is accessed most.
kernel.numa_balancing = 1

# Scanning rate for NUMA balancing (pages per second per task).
kernel.numa_balancing_scan_size_mb = 256
kernel.numa_balancing_scan_period_min_ms = 1000
kernel.numa_balancing_scan_period_max_ms = 60000
```

### CPU Frequency Scaling

```bash
# Check current governor on all CPUs
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort -u

# Set performance governor for low-latency workloads
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance > "${cpu}"
done

# Or use cpupower for the whole system
cpupower frequency-set --governor performance

# Verify boost state (disable for consistent benchmark results)
cat /sys/devices/system/cpu/cpufreq/boost
echo 0 > /sys/devices/system/cpu/cpufreq/boost

# Make performance governor persistent via systemd
cat > /etc/systemd/system/cpu-performance.service << 'EOF'
[Unit]
Description=Set CPU governor to performance
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/bin/cpupower frequency-set --governor performance
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cpu-performance.service
```

---

## Section 3: Memory Management Tuning

### vm.swappiness and Swap Behavior

```ini
# /etc/sysctl.d/20-memory.conf

# How aggressively the kernel swaps anonymous memory to disk.
# 0  = only swap when OOM is imminent (Linux 3.5+)
# 10 = minimal swapping (recommended for most production servers)
# 60 = default balanced
# 100= swap aggressively
vm.swappiness = 10

# Tendency to reclaim memory used for the page cache vs anonymous memory.
vm.vfs_cache_pressure = 50

# Ratio of dirty pages before pdflush kicks in (percent of total memory).
vm.dirty_ratio = 20
vm.dirty_background_ratio = 5

# Maximum size of memory map areas a process may have.
vm.max_map_count = 1048576

# Minimum free memory to keep. Raising prevents OOM spikes.
vm.min_free_kbytes = 1048576

# Overcommit behavior:
# 0 = heuristic overcommit (default)
# 1 = always overcommit (useful for scientific computing)
# 2 = never overcommit beyond overcommit_ratio
vm.overcommit_memory = 0
vm.overcommit_ratio = 50
```

### Transparent Huge Pages

```bash
# Check current THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# Output: always [madvise] never

# For databases (PostgreSQL, MySQL) — disable THP to avoid latency spikes
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Make persistent via systemd service
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=mongod.service postgresql.service redis.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'

[Install]
WantedBy=basic.target
EOF

systemctl daemon-reload
systemctl enable --now disable-thp.service
```

### Explicit Huge Pages for Databases

```bash
# Check current huge page configuration
grep -i hugepage /proc/meminfo
# HugePages_Total:    1024
# HugePages_Free:     1024
# Hugepagesize:       2048 kB

# Allocate 2048 huge pages (2048 * 2MB = 4 GB)
sysctl -w vm.nr_hugepages=2048

# Persist in sysctl
echo "vm.nr_hugepages = 2048" >> /etc/sysctl.d/20-memory.conf

# For PostgreSQL — configure shared_memory_type in postgresql.conf
# shared_memory_type = mmap
# huge_pages = on

# Verify allocation
grep HugePages /proc/meminfo
```

### Memory Compaction

```bash
# Trigger manual memory compaction
echo 1 > /proc/sys/vm/compact_memory

# Monitor compaction activity
grep -i compact /proc/vmstat
# compact_migrate_scanned 145823
# compact_free_scanned    2984721
# compact_isolated        89234
# compact_stall           12

# Adjust compaction proactiveness (0-100; default 20)
sysctl -w vm.compaction_proactiveness=20
```

---

## Section 4: Network Stack Optimization

### TCP Buffer and Congestion Control

```ini
# /etc/sysctl.d/30-network.conf

# TCP buffer sizing
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216

# TCP-specific read/write buffer: min, default, max
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728

# UDP buffers
net.core.netdev_max_backlog = 250000

# BBR congestion control reduces latency and improves throughput
# especially on lossy or high-BDP paths.
net.ipv4.tcp_congestion_control = bbr

# Enable FQ (Fair Queueing) pacing required by BBR
net.core.default_qdisc = fq

# Increase the backlog for listen() to handle burst connections.
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# Fast recycling of TIME_WAIT sockets
net.ipv4.tcp_tw_reuse = 1

# Keepalive — detect dead peers faster
net.ipv4.tcp_keepalive_time    = 300
net.ipv4.tcp_keepalive_intvl   = 30
net.ipv4.tcp_keepalive_probes  = 3

# Reduce SYN retransmissions for faster failure detection
net.ipv4.tcp_syn_retries  = 3
net.ipv4.tcp_synack_retries = 3

# Increase local port range for outbound connections
net.ipv4.ip_local_port_range = 1024 65535

# Enable TCP Fast Open for both client and server
net.ipv4.tcp_fastopen = 3

# Selective ACK — recovers from multiple packet losses per window
net.ipv4.tcp_sack = 1

# Timestamps for RTTM and PAWS
net.ipv4.tcp_timestamps = 1
```

### Network Interface Tuning

```bash
#!/usr/bin/env bash
# nic-tuning.sh — per-interface network performance configuration

NIC="${1:-eth0}"

# Increase ring buffer sizes
ethtool -G "${NIC}" rx 4096 tx 4096

# Enable hardware offloads
ethtool -K "${NIC}" \
  tso on \
  gso on \
  gro on \
  rx-checksumming on \
  tx-checksumming on

# Set interrupt coalescing for throughput
ethtool -C "${NIC}" \
  adaptive-rx on \
  adaptive-tx on \
  rx-usecs 50 \
  tx-usecs 50

# Spread interrupts across CPUs with RPS
NR_CPUS=$(nproc)
for f in /sys/class/net/"${NIC}"/queues/rx-*/rps_cpus; do
  printf '%x\n' $(( (1 << NR_CPUS) - 1 )) > "${f}"
done

# Set XPS (Transmit Packet Steering) — each TX queue bound to one CPU
queue=0
for f in /sys/class/net/"${NIC}"/queues/tx-*/xps_cpus; do
  printf '%x\n' $(( 1 << queue )) > "${f}"
  queue=$(( (queue + 1) % NR_CPUS ))
done

echo "NIC ${NIC} tuned."
```

### IRQ Affinity

```bash
# View current IRQ assignments
cat /proc/interrupts | grep "${NIC}"

# Use irqbalance for dynamic balancing (default on most distros)
systemctl enable --now irqbalance

# Manually pin NIC IRQs to specific CPUs (disable irqbalance first)
systemctl stop irqbalance

NIC_IRQS=$(grep "${NIC}" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ')

CPU=0
for irq in ${NIC_IRQS}; do
  MASK=$(printf '%x' $(( 1 << CPU )))
  echo "${MASK}" > "/proc/irq/${irq}/smp_affinity"
  echo "IRQ ${irq} pinned to CPU ${CPU}"
  CPU=$(( (CPU + 1) % $(nproc) ))
done
```

---

## Section 5: I/O Scheduler Selection and Tuning

### Choosing the Right Scheduler

```bash
# Check available schedulers for a block device
cat /sys/block/sda/queue/scheduler
# [mq-deadline] kyber bfq none

# Check if device is rotational (0 = SSD/NVMe, 1 = HDD)
cat /sys/block/sda/queue/rotational

# Scheduler selection guidelines:
# none (noop)   — NVMe / all-flash arrays; lowest latency overhead
# mq-deadline   — General-purpose SSDs; prevents starvation
# bfq           — Desktop / mixed read-write with QoS requirements
# kyber         — Latency-oriented SSDs; targets specific read/write latency

echo mq-deadline > /sys/block/nvme0n1/queue/scheduler

# Make persistent via udev rule
cat > /etc/udev/rules.d/60-io-scheduler.rules << 'EOF'
# NVMe — use none (passthrough)
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", ATTR{queue/scheduler}="none"

# SATA SSD (rotational=0)
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"

# HDD (rotational=1)
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq"
EOF

udevadm control --reload-rules
```

### Queue Depth and Read-Ahead

```bash
# Set queue depth — match to device capabilities
# For NVMe with high queue depth support
echo 1024 > /sys/block/nvme0n1/queue/nr_requests

# Read-ahead: larger values help sequential I/O; reduce for random workloads
# For sequential workloads (backups, streaming)
echo 2048 > /sys/block/sda/queue/read_ahead_kb

# For random workloads (databases)
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb

# Bulk configuration via blockdev
blockdev --setra 0 /dev/nvme0n1
blockdev --setra 4096 /dev/sdb
```

### Filesystem Mount Options

```bash
# /etc/fstab examples for production workloads

# XFS for database data directory — noatime, optimized journal
UUID=abc12300-0000-0000-0000-000000000001 /data/db xfs \
  defaults,noatime,nodiratime,logbufs=8,logbsize=256k,allocsize=4m 0 2

# ext4 for application logs — data=writeback reduces journal overhead
UUID=def45600-0000-0000-0000-000000000001 /var/log ext4 \
  defaults,noatime,data=writeback,barrier=0 0 2

# tmpfs for ephemeral working data
tmpfs /tmp tmpfs defaults,noatime,mode=1777,size=8G 0 0

# Remount with new options without reboot
mount -o remount,noatime /data/db
```

---

## Section 6: Kernel Profiling with perf

### CPU Profiling

```bash
# Install perf (matches running kernel version)
apt-get install linux-perf   # Debian/Ubuntu
dnf install perf              # RHEL/Fedora

# Record CPU flame graph data (10 seconds, 99 Hz, all CPUs)
perf record -F 99 -a -g -- sleep 10

# Generate report
perf report --stdio | head -100

# Flame graph generation
git clone --depth 1 https://github.com/brendangregg/FlameGraph /opt/flamegraph

perf record -F 99 -a -g -o perf.data -- sleep 30
perf script -i perf.data | \
  /opt/flamegraph/stackcollapse-perf.pl | \
  /opt/flamegraph/flamegraph.pl > cpu-flamegraph.svg

# Profile a specific PID
perf record -F 99 -g -p $(pgrep myapp) -- sleep 30
perf script | /opt/flamegraph/stackcollapse-perf.pl | \
  /opt/flamegraph/flamegraph.pl --title "myapp CPU profile" > myapp-cpu.svg
```

### Hardware Performance Counters

```bash
# Measure IPC, cache misses, and branch mispredictions
perf stat \
  -e cycles,instructions,cache-references,cache-misses \
  -e branch-instructions,branch-misses,context-switches,cpu-migrations \
  -p $(pgrep myapp) sleep 10

# Interpretation guide:
# IPC = instructions / cycles — target > 1.0 for compute-bound
# cache-misses as % of cache-references — high % means memory-bound
# branch-misses as % of branch-instructions — > 5% is poor prediction

# Measure memory bandwidth with perf mem
perf mem record -a -- sleep 10
perf mem report | head -50
```

### perf sched for Scheduling Analysis

```bash
# Record scheduler events
perf sched record -- sleep 10

# Analyze scheduling latency (wakeup to run delay)
perf sched latency | sort -k7 -rn | head -20

# Task                  |   Runtime ms  | Switches | Average delay ms
# myapp:(4)             |     4523.123  |    14521  |          0.321

# Scheduler replay
perf sched script | head -100

# Timing map
perf sched timehist | head -50
```

---

## Section 7: ftrace for Deep Kernel Tracing

### Function Tracing

```bash
# Mount debugfs if not already mounted
mount -t debugfs none /sys/kernel/debug

TRACEFS=/sys/kernel/debug/tracing

# List available tracers
cat "${TRACEFS}/available_tracers"
# hwlat blk mmiotrace function_graph wakeup_dl wakeup_rt wakeup function nop

# Enable function_graph tracer to see call tree
echo function_graph > "${TRACEFS}/current_tracer"
echo 1 > "${TRACEFS}/tracing_on"
sleep 1
echo 0 > "${TRACEFS}/tracing_on"
cat "${TRACEFS}/trace" | head -100

# Reset
echo nop > "${TRACEFS}/current_tracer"
echo > "${TRACEFS}/trace"
```

### Tracing Specific Functions

```bash
TRACEFS=/sys/kernel/debug/tracing

# Trace TCP transmit path
echo function > "${TRACEFS}/current_tracer"
echo 'tcp_sendmsg tcp_transmit_skb __tcp_push_pending_frames' \
  > "${TRACEFS}/set_ftrace_filter"

echo 1 > "${TRACEFS}/tracing_on"
# run workload
echo 0 > "${TRACEFS}/tracing_on"
cat "${TRACEFS}/trace" | grep -v '^#' | head -200

# Cleanup
echo > "${TRACEFS}/set_ftrace_filter"
echo nop > "${TRACEFS}/current_tracer"
echo > "${TRACEFS}/trace"
```

### trace-cmd for Easier ftrace Access

```bash
# Install
apt-get install trace-cmd

# Record scheduler wakeup latency
trace-cmd record -e sched:sched_wakeup -e sched:sched_switch \
  -p function_graph -g schedule sleep 5

# Report
trace-cmd report | head -200

# Trace specific syscalls for a process
trace-cmd record \
  -e syscalls:sys_enter_read \
  -e syscalls:sys_exit_read \
  -P $(pgrep myapp) sleep 10

trace-cmd report | awk '$0 ~ /read/' | head -50
```

---

## Section 8: Applying Settings Persistently

### sysctl Drop-in Files

```bash
cat > /etc/sysctl.d/99-production-tuning.conf << 'EOF'
# CPU Scheduler
kernel.sched_min_granularity_ns    = 1000000
kernel.sched_latency_ns            = 4000000
kernel.sched_wakeup_granularity_ns = 500000
kernel.sched_migration_cost_ns     = 5000000
kernel.numa_balancing              = 1

# Memory
vm.swappiness                      = 10
vm.vfs_cache_pressure              = 50
vm.dirty_ratio                     = 20
vm.dirty_background_ratio          = 5
vm.max_map_count                   = 1048576
vm.min_free_kbytes                 = 1048576
vm.nr_hugepages                    = 2048

# Network
net.core.rmem_max                  = 134217728
net.core.wmem_max                  = 134217728
net.core.rmem_default              = 16777216
net.core.wmem_default              = 16777216
net.ipv4.tcp_rmem                  = 4096 87380 134217728
net.ipv4.tcp_wmem                  = 4096 65536 134217728
net.ipv4.tcp_congestion_control    = bbr
net.core.default_qdisc             = fq
net.core.somaxconn                 = 65535
net.ipv4.tcp_max_syn_backlog       = 65535
net.ipv4.tcp_tw_reuse              = 1
net.ipv4.tcp_keepalive_time        = 300
net.ipv4.tcp_keepalive_intvl       = 30
net.ipv4.tcp_keepalive_probes      = 3
net.ipv4.ip_local_port_range       = 1024 65535
net.ipv4.tcp_fastopen              = 3
net.core.netdev_max_backlog        = 250000
EOF

# Apply immediately
sysctl --system

# Verify specific values
sysctl net.ipv4.tcp_congestion_control vm.swappiness kernel.sched_latency_ns
```

### Validation Script

```bash
#!/usr/bin/env bash
# validate-tuning.sh — confirm all desired values are active

declare -A EXPECTED=(
  ["vm.swappiness"]="10"
  ["net.ipv4.tcp_congestion_control"]="bbr"
  ["net.core.default_qdisc"]="fq"
  ["net.core.somaxconn"]="65535"
  ["vm.max_map_count"]="1048576"
  ["kernel.sched_latency_ns"]="4000000"
)

PASS=0
FAIL=0

for key in "${!EXPECTED[@]}"; do
  actual=$(sysctl -n "${key}" 2>/dev/null)
  expected="${EXPECTED[${key}]}"
  if [[ "${actual}" == "${expected}" ]]; then
    echo "PASS  ${key} = ${actual}"
    (( PASS++ ))
  else
    echo "FAIL  ${key}: expected=${expected} actual=${actual}"
    (( FAIL++ ))
  fi
done

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ ${FAIL} -eq 0 ]]
```

---

## Section 9: Workload-Specific Tuning Profiles

### High-Throughput Web Server

```bash
#!/usr/bin/env bash
# profile-webserver.sh

sysctl -w net.core.somaxconn=65535
sysctl -w net.ipv4.tcp_max_syn_backlog=65535
sysctl -w net.ipv4.tcp_tw_reuse=1
sysctl -w net.ipv4.tcp_fin_timeout=15
sysctl -w net.ipv4.tcp_congestion_control=bbr
sysctl -w net.core.default_qdisc=fq
sysctl -w vm.swappiness=5
sysctl -w vm.dirty_background_ratio=3
sysctl -w vm.dirty_ratio=10

echo "Web server profile applied"
```

### Database Server

```bash
#!/usr/bin/env bash
# profile-database.sh

# Huge pages for shared memory
sysctl -w vm.nr_hugepages=4096

# Disable THP
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Keep data in RAM
sysctl -w vm.swappiness=1

# Dirty page control
sysctl -w vm.dirty_ratio=40
sysctl -w vm.dirty_background_ratio=10

# Scheduler NUMA locality
sysctl -w kernel.sched_migration_cost_ns=5000000
sysctl -w kernel.numa_balancing=1

# NVMe I/O scheduler
echo none > /sys/block/nvme0n1/queue/scheduler
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb

echo "Database server profile applied"
```

### Real-Time Service

```bash
#!/usr/bin/env bash
# profile-realtime.sh

# Performance CPU governor
cpupower frequency-set --governor performance

# Disable CPU idle states deeper than C1
cpupower idle-set -D 1

# Verify CPU isolation (requires kernel cmdline isolcpus=2,3,4,5)
cat /sys/devices/system/cpu/isolated

# Disable watchdog NMI (adds jitter)
sysctl -w kernel.nmi_watchdog=0

# Run RT service with NUMA binding
numactl --cpunodebind=0 --membind=0 -- /usr/bin/rt-service &

# Set RT priority
chrt -f 80 -p $(pgrep rt-service)

echo "Real-time profile applied"
```

---

## Section 10: Continuous Performance Monitoring

### Prometheus Alerting Rules

```yaml
# alerting-rules.yaml
groups:
  - name: linux-performance
    rules:
      - alert: HighIOWait
        expr: |
          rate(node_cpu_seconds_total{mode="iowait"}[5m]) > 0.20
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High iowait on {{ $labels.instance }}"
          description: "iowait is {{ $value | humanizePercentage }} (threshold 20%)"

      - alert: LowMemoryAvailable
        expr: |
          node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Low available memory on {{ $labels.instance }}"

      - alert: TCPRetransmits
        expr: |
          rate(node_netstat_Tcp_RetransSegs[5m]) > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High TCP retransmits on {{ $labels.instance }}"

      - alert: DiskSaturation
        expr: |
          rate(node_disk_io_time_weighted_seconds_total[5m]) > 1.0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Disk saturation on {{ $labels.instance }}, device {{ $labels.device }}"
```

### Automated Tuning Validation in CI

```bash
#!/usr/bin/env bash
# ci-perf-check.sh — validate tuning against staging hosts

HOST="${1:-staging-host.example.com}"
FAIL=0

check() {
  local desc="$1"
  local cmd="$2"
  local expected="$3"
  local actual
  actual=$(ssh "${HOST}" "${cmd}" 2>/dev/null | tr -d '[:space:]')
  if [[ "${actual}" == "${expected}" ]]; then
    echo "PASS  ${desc}"
  else
    echo "FAIL  ${desc}: expected='${expected}' got='${actual}'"
    FAIL=1
  fi
}

check "TCP congestion BBR"   "sysctl -n net.ipv4.tcp_congestion_control" "bbr"
check "Swappiness 10"        "sysctl -n vm.swappiness"                   "10"
check "NVMe scheduler none"  "cat /sys/block/nvme0n1/queue/scheduler"    "[none]"

exit ${FAIL}
```

Linux kernel performance tuning is a layered discipline where each subsystem — CPU scheduling, memory management, network stack, and I/O — requires workload-specific attention. The sysctl values, udev rules, and profiling commands shown here are production-tested configurations. Always measure before and after each change with the same workload profile used in production to ensure improvements are real and regressions are caught before they reach customers.
