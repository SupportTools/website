---
title: "Linux System Performance Analysis: USE Method, Resource Saturation, and Bottleneck Identification"
date: 2030-02-11T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "USE Method", "Brendan Gregg", "perf", "Monitoring", "Bottleneck", "Saturation"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Systematic Linux performance analysis using Brendan Gregg's USE method, identifying CPU, memory, disk, and network saturation, using perf stat for resource counters, and establishing performance baselines for production systems."
more_link: "yes"
url: "/linux-system-performance-use-method/"
---

Performance problems in production systems are rarely obvious. A system presenting as "slow" could be experiencing CPU saturation, memory pressure causing swap utilization, disk I/O queue depth saturation, or network interface packet drops. Without a systematic approach, engineers waste hours investigating the wrong resource.

The USE Method (Utilization, Saturation, Errors) provides a structured checklist for diagnosing performance bottlenecks. Developed by Brendan Gregg at Netflix, it eliminates the guesswork by ensuring every resource is evaluated before conclusions are drawn. This guide applies the USE Method to Linux systems with specific commands for each metric, perf stat for hardware counter analysis, and a practical approach to establishing baselines.

<!--more-->

## The USE Method Framework

For every resource, check three metrics:

- **Utilization**: The percentage of time the resource is busy. A CPU at 90% utilization is heavily loaded.
- **Saturation**: The degree to which the resource has extra work it cannot service. A CPU with a run queue depth of 10 on a 4-core system is saturated.
- **Errors**: Error counters for the resource. TCP retransmits, disk I/O errors, memory ECC errors.

The method is applied to every resource in the system:

1. CPUs (each core and the overall system)
2. Memory (physical RAM, swap, NUMA nodes)
3. Network interfaces (utilization, saturation, errors)
4. Storage devices (utilization, I/O queue depth, errors)
5. Controllers (storage controllers, network adapters)
6. Interconnects (PCIe bus, memory bus, NUMA interconnect)

A complete USE Method checklist ensures you check everything before concluding you've found the root cause. It prevents the common failure mode of "fixing" the first symptom found without identifying whether it is the actual bottleneck.

<!--more-->

## CPU Analysis

### Utilization

```bash
# Overall CPU utilization (1-second samples)
mpstat -P ALL 1 10
# Linux 6.1.0-28-amd64   02/11/2030  _x86_64_
#
# 10:30:01 AM  CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest   %idle
# 10:30:02 AM  all   45.23    0.00    8.12    0.50    0.00    1.23    0.00    0.00   44.92
# 10:30:02 AM    0   87.00    0.00   12.00    0.00    0.00    1.00    0.00    0.00    0.00
# 10:30:02 AM    1   23.00    0.00    5.00    0.00    0.00    2.00    0.00    0.00   70.00
# 10:30:02 AM    2   89.00    0.00    9.00    1.00    0.00    1.00    0.00    0.00    0.00
# 10:30:02 AM    3   45.00    0.00    8.00    0.00    0.00    1.00    0.00    0.00   46.00

# CPU 0 and 2 are nearly saturated while 1 and 3 are mostly idle
# This imbalance suggests poor CPU affinity or single-threaded bottleneck

# sar for historical CPU data
sar -u 1 60
sar -u -f /var/log/sa/sa$(date +%d)  # Yesterday's CPU data from sadc

# vmstat for quick overview
vmstat 1 10
# procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
#  r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
#  8  0      0 123456 234567 8901234    0    0     5    12  234 5678 45  8 44  0  0
# 'r' = run queue depth: 8 waiting to run on 4 CPUs = 2x saturation
```

### Saturation

```bash
# CPU run queue depth and load average
cat /proc/loadavg
# 7.23 6.45 5.67 12/847 12345
# 7.23 = 1-min load average (run + wait count)
# On 4-core system: load > 4 means CPU saturation

# Detailed run queue per CPU
sar -q 1 10
# 10:30:01 AM   runq-sz  plist-sz   ldavg-1   ldavg-5  ldavg-15   blocked
# 10:30:02 AM         8       847      7.23      6.45      5.67         0
# runq-sz = 8: 8 processes waiting for CPU

# Per-process CPU wait time
ps -eo pid,comm,pcpu,stat --sort=-pcpu | head -20
# Look for processes in 'R' (running) or 'D' (uninterruptible wait) state

# Identify CPU-bound processes
pidstat -u 1 10
# Time        UID       PID    %usr %system  %guest   %wait    %CPU   CPU  Command
# 10:30:01    1000      1234   85.00    5.00    0.00    2.00   90.00    2  webapp
# %wait = 2% is the time spent waiting for CPU (saturation indicator)
```

### CPU Errors

```bash
# Machine Check Exceptions (hardware errors)
mcelog --client 2>/dev/null || journalctl -k | grep -i "mce\|machine check"

# CPU frequency throttling (thermal or power limits)
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq
# If below scaling_max_freq, the CPU is being throttled

# Check for thermal throttling
grep -r "cpu MHz" /proc/cpuinfo | sort | uniq -c

# Soft lockup events (kernel scheduling stalls)
dmesg | grep -i "soft lockup\|rcu_sched stalled\|hung_task"

# Performance counters for CPU errors
perf stat -e cpu-cycles,cache-misses,cache-references,instructions \
  -a sleep 10
# cache-misses high relative to cache-references = poor cache utilization
```

## Memory Analysis

### Utilization

```bash
# Detailed memory utilization
free -h
#               total        used        free      shared  buff/cache   available
# Mem:           125G         45G         12G        2.1G         68G         77G
# Swap:            8G          0B          8G
# Note: 'available' is more useful than 'free' for most purposes

# /proc/meminfo for detailed breakdown
cat /proc/meminfo
# MemTotal:       131072000 kB
# MemFree:        12345678 kB
# MemAvailable:   80234567 kB
# Buffers:         5234567 kB
# Cached:         63234567 kB
# SwapCached:          0 kB
# Active:         34567890 kB
# Inactive:       28901234 kB
# Slab:            4567890 kB    <- Kernel slab allocations
# SReclaimable:    3456789 kB    <- Reclaimable under pressure
# SUnreclaim:      1111101 kB    <- Cannot be reclaimed

# Per-process memory usage
ps -eo pid,comm,rss,vsz --sort=-rss | head -20
# Or with more detail:
smem -r -s rss | head -20

# NUMA memory distribution
numastat
# Per-node allocation (imbalance indicates NUMA issues)
```

### Memory Saturation

```bash
# Swap usage over time (any swap usage on a production system is concerning)
vmstat 1 60 | awk '{print $7, $8}'  # si = swap in, so = swap out
# si > 0 means pages being read from swap
# so > 0 means pages being written to swap

# Page fault rate
sar -B 1 60
# pgpgin/s  pgpgout/s   fault/s  majflt/s   pgfree/s pgscank/s pgscand/s pgsteal/s    %vmeff
# High majflt/s = major page faults (disk read required = memory pressure)
# pgscank/s > 0 = kernel actively reclaiming memory (saturation)

# OOM kill events
dmesg | grep -i "oom\|out of memory\|kill process" | tail -20
journalctl -k | grep -i "oom killer"

# Memory pressure via PSI (Pressure Stall Information)
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.52 avg300=0.31 total=1234567
# full avg10=0.00 avg60=0.00 avg300=0.00 total=56789
# 'some' = at least one task stalled waiting for memory
# 'full' = ALL tasks stalled (severe memory pressure)
# avg60=0.52 means 0.52% of time over last 60s had memory stalls

# Check slab cache usage
slabtop -o | head -30
# Identify large slab caches consuming memory
```

### Memory Errors

```bash
# ECC memory errors (requires edac or ipmitool)
edac-util -s 4
# If edac kernel module is loaded:
cat /sys/bus/platform/drivers/i7core_edac/*/mc/mc*/csrow*/ue_count
cat /sys/bus/platform/drivers/i7core_edac/*/mc/mc*/csrow*/ce_count

# Hardware memory errors via IPMI
ipmitool sel list | grep -i "memory\|ecc"

# Transparent huge page allocation failures
grep -i thp /proc/vmstat
# thp_fault_alloc: 0
# thp_fault_fallback: 1234  <- THP fallback to regular pages (pressure indicator)
```

## Disk I/O Analysis

### Utilization

```bash
# Disk utilization per device
iostat -xz 1 10
# Device            r/s     rkB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wkB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dkB/s   drqm/s  %drqm d_await dareq-sz  aqu-sz  %util
# sda              0.00      0.00     0.00   0.00    0.00     0.00  123.00  15360.00     5.00   3.90   32.50   124.88     0.00      0.00     0.00   0.00    0.00     0.00    4.00  97.50
#
# %util = 97.5% = disk is nearly saturated
# aqu-sz = 4 = average queue depth of 4 requests
# r_await/w_await = latency per I/O operation

# Continuous monitoring
dstat -d 1 60
dstat --disk --disk-util --io 1 60

# iotop for per-process I/O
iotop -o -d 1
```

### Disk Saturation

```bash
# Disk I/O queue depth (saturation when consistently > 1)
iostat -x 1 | awk '/^Device|sda|nvme/{print $1, $NF, $(NF-2)}'
# Device  %util  aqu-sz
# sda     97.5   4.00     <- Saturated: queue depth > 1

# I/O wait time per request
iostat -x 1 | awk '/sda/{print "read_latency_ms="$10, "write_latency_ms="$11}'

# PSI for I/O pressure
cat /proc/pressure/io
# some avg10=23.45 avg60=18.23 avg300=12.45 total=12345678
# avg10=23.45 means 23% of last 10 seconds had I/O stalls — significant pressure

# Identify I/O-waiting processes
ps -eo pid,comm,stat,wchan | grep "D "
# Processes in D (uninterruptible sleep) are waiting for I/O
# wchan column shows what kernel function they're blocked in
```

### Disk Errors

```bash
# SMART data for disk health
smartctl -a /dev/sda | grep -E "Reallocated|Current_Pending|Offline_Uncorrectable|UDMA_CRC"
# Reallocated_Sector_Ct > 0 indicates bad sectors
# Current_Pending_Sector > 0 indicates sectors awaiting reallocation

# Kernel disk error log
dmesg | grep -i "error\|failed\|timeout\|reset\|I/O error" | grep -i "sd[a-z]\|nvme" | tail -20

# Block device error counters
cat /sys/block/sda/device/ioerr_cnt 2>/dev/null
cat /sys/block/nvme0n1/nvme0/err_count 2>/dev/null
```

## Network Analysis

### Utilization

```bash
# Real-time interface utilization
sar -n DEV 1 10
# 10:30:01 AM     IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   rxcmp/s   txcmp/s  rxmcst/s   %ifutil
# 10:30:02 AM      eth0  12345.00  11234.00   9876.54   8765.43      0.00      0.00      0.00     79.01
# %ifutil = 79% of interface capacity in use

# Interface statistics
ip -s link show eth0
# RX: bytes  packets  errors  dropped missed  mcast
#  9876543   12345     0       0       0       123
# TX: bytes  packets  errors  dropped carrier collsns
#  8765432   11234     0       0       0       0

# BPF-based network monitoring for zero-overhead metrics
bpftrace -e 'kprobe:__netif_receive_skb { @[comm] = count(); }' 2>/dev/null &
sleep 10 && pkill bpftrace

# nload for real-time bandwidth visualization
nload eth0
```

### Network Saturation

```bash
# Interface receive/transmit drops
cat /proc/net/dev | awk '{print $1, $4, $12}' | grep eth0
# eth0: 0 drops (RX), 0 drops (TX)

# Detailed interface statistics including softirq backlog
ethtool -S eth0 | grep -i "drop\|error\|miss\|fifo"

# TCP/UDP buffer overflow (packet drops due to buffer saturation)
ss -s
# Total: 12345
# TCP:   5678 (estab 5234, closed 123, orphaned 45, timewait 276)
# Transport Total     IP        IPv6
# RAW       0         0         0
# UDP       123       100       23
# TCP       5678      5000      678
# INET      5801      5100      701

# TCP retransmission rate (network congestion indicator)
ss -ti | grep -c "retrans"
sar -n TCP 1 60
# active/s  passive/s    iseg/s    oseg/s
# TCP segment retransmissions per second

# netstat for receive queue saturation
ss -lnp | awk 'NR>1 && $3 > 0 {print "Recv-Q", $3, "for", $5}'
# Non-zero Recv-Q indicates server is not consuming data fast enough
```

### Network Errors

```bash
# All network errors in one view
netstat -s | grep -E "errors|failed|rejected|resets|retransmit|bad"

# TCP statistics
cat /proc/net/snmp | grep -E "^Tcp"
# Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors

# Specific retransmit counters
ss -ti | grep -E "retrans|rcv_space|snd_buf" | head -20

# NIC driver errors
ethtool -S eth0 | grep -i "error\|drop\|miss\|overflow" | grep -v "0$"
```

## perf stat: Hardware Performance Counters

```bash
# System-wide hardware counters for 30 seconds
perf stat -a sleep 30
# Performance counter stats for 'system wide':
#
#    125,678.45 msec cpu-clock              #   16.023 CPUs utilized
#     1,234,567      context-switches        #    9.821 K/sec
#        12,345      cpu-migrations          #   98.213 /sec
#       123,456      page-faults             #  982.130 /sec
# 234,567,890,123      cycles                  # 1.867 GHz
# 189,234,567,890      instructions            # 0.81  insn per cycle  <- LOW
#  45,678,901,234      branches                # 363.416 M/sec
#     2,345,678      branch-misses            #  5.13% of all branches
#  23,456,789,012      cache-references        # 186.666 M/sec
#   5,678,901,234      cache-misses            # 24.21% of all cache refs  <- HIGH

# IPC (Instructions Per Cycle) of 0.81 is low — suggests memory bandwidth bottleneck
# Cache miss rate of 24% is high — memory access pattern is poor

# Focus on a specific process
perf stat -p $(pgrep -x webapp) sleep 10

# Memory bandwidth analysis
perf stat -e \
  LLC-loads,LLC-load-misses,LLC-stores,LLC-store-misses,\
  cpu/mem-loads,v=1/,cpu/mem-stores,v=1/ \
  -a sleep 10

# Specific hardware events for cache analysis
perf stat -e \
  L1-dcache-loads,L1-dcache-load-misses,\
  L1-dcache-stores,L1-dcache-store-misses,\
  L1-icache-load-misses \
  -a -I 1000 sleep 30
```

### CPU Stall Analysis

```bash
# Top-down microarchitecture analysis
# Identify whether bottleneck is frontend (decode) or backend (execution)
perf stat -e \
  cycles,instructions,\
  cpu/event=0x3c,umask=0x00,name=cpu_clk_unhalted/,\
  cpu/event=0xa2,umask=0x01,name=resource_stalls_any/ \
  -a sleep 10

# Memory access latency
perf mem record -a sleep 10
perf mem report --stdio | head -30

# TLB miss analysis (indicates large working set or poor locality)
perf stat -e \
  dTLB-load-misses,dTLB-loads,dTLB-store-misses,dTLB-stores,\
  iTLB-load-misses,iTLB-loads \
  -a sleep 10
```

## Establishing Performance Baselines

A baseline captures the system's normal operating characteristics. Deviations from baseline indicate changes — either improvements from optimizations or degradations from problems.

### Automated Baseline Collection

```bash
#!/bin/bash
# /usr/local/bin/collect-baseline.sh
# Run daily via cron to establish performance baselines

set -euo pipefail

BASELINE_DIR="/var/lib/perf-baselines"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
HOSTNAME=$(hostname -s)
OUTPUT_DIR="${BASELINE_DIR}/${HOSTNAME}/${TIMESTAMP}"

mkdir -p "${OUTPUT_DIR}"

echo "Collecting performance baseline for ${HOSTNAME} at ${TIMESTAMP}"

# CPU baseline (60 seconds)
echo "CPU utilization..."
sar -u ALL 5 12 > "${OUTPUT_DIR}/cpu_util.txt" 2>&1
mpstat -P ALL 5 12 > "${OUTPUT_DIR}/cpu_mpstat.txt" 2>&1

# Memory baseline
echo "Memory..."
free -h > "${OUTPUT_DIR}/memory_free.txt"
cat /proc/meminfo > "${OUTPUT_DIR}/meminfo.txt"
vmstat -s > "${OUTPUT_DIR}/vmstat_summary.txt"

# Disk I/O baseline (60 seconds)
echo "Disk I/O..."
iostat -xz 5 12 > "${OUTPUT_DIR}/disk_iostat.txt" 2>&1
sar -d 5 12 > "${OUTPUT_DIR}/disk_sar.txt" 2>&1

# Network baseline (60 seconds)
echo "Network..."
sar -n DEV 5 12 > "${OUTPUT_DIR}/network_dev.txt" 2>&1
sar -n EDEV 5 12 > "${OUTPUT_DIR}/network_errors.txt" 2>&1
netstat -s > "${OUTPUT_DIR}/netstat_stats.txt" 2>&1

# Hardware counters (30 seconds)
echo "Hardware counters..."
perf stat -a \
  -e cycles,instructions,cache-references,cache-misses,\
  context-switches,cpu-migrations,page-faults \
  sleep 30 2> "${OUTPUT_DIR}/perf_stat.txt"

# Process snapshot
echo "Process snapshot..."
ps aux --sort=-%cpu > "${OUTPUT_DIR}/ps_cpu.txt"
ps aux --sort=-%mem > "${OUTPUT_DIR}/ps_mem.txt"

# Load average over the collection period
echo "Load: $(cat /proc/loadavg)" >> "${OUTPUT_DIR}/summary.txt"
echo "Uptime: $(uptime)" >> "${OUTPUT_DIR}/summary.txt"
echo "Kernel: $(uname -r)" >> "${OUTPUT_DIR}/summary.txt"

# Create a compressed archive
tar czf "${BASELINE_DIR}/${HOSTNAME}_${TIMESTAMP}.tar.gz" \
  -C "${BASELINE_DIR}" "${HOSTNAME}/${TIMESTAMP}"
rm -rf "${OUTPUT_DIR}"

echo "Baseline saved: ${BASELINE_DIR}/${HOSTNAME}_${TIMESTAMP}.tar.gz"
```

### Comparing to Baseline

```python
#!/usr/bin/env python3
# /usr/local/bin/compare-baseline.py
# Compare current performance to a stored baseline

import sys
import tarfile
import json
import subprocess
from pathlib import Path

def collect_current_metrics() -> dict:
    """Collect current system metrics."""
    metrics = {}

    # Load average
    with open('/proc/loadavg') as f:
        parts = f.read().split()
        metrics['load_1m'] = float(parts[0])
        metrics['load_5m'] = float(parts[1])
        metrics['load_15m'] = float(parts[2])

    # Memory
    with open('/proc/meminfo') as f:
        for line in f:
            parts = line.split()
            if parts[0] == 'MemAvailable:':
                metrics['mem_available_kb'] = int(parts[1])
            elif parts[0] == 'MemTotal:':
                metrics['mem_total_kb'] = int(parts[1])
            elif parts[0] == 'SwapFree:':
                metrics['swap_free_kb'] = int(parts[1])
            elif parts[0] == 'SwapTotal:':
                metrics['swap_total_kb'] = int(parts[1])

    # CPU utilization (1 sample)
    result = subprocess.run(
        ['mpstat', '-P', 'ALL', '1', '1'],
        capture_output=True, text=True
    )
    # Parse last 'all' line
    for line in result.stdout.split('\n'):
        if 'all' in line and 'CPU' not in line:
            parts = line.split()
            if len(parts) >= 12:
                metrics['cpu_idle_pct'] = float(parts[-1])
                metrics['cpu_iowait_pct'] = float(parts[5])
                break

    # Disk I/O saturation
    result = subprocess.run(
        ['iostat', '-x', '1', '1'],
        capture_output=True, text=True
    )
    # Find the busiest device
    max_util = 0.0
    for line in result.stdout.split('\n'):
        parts = line.split()
        if len(parts) > 10 and parts[0] not in ('Device', ''):
            try:
                util = float(parts[-1])
                max_util = max(max_util, util)
            except (ValueError, IndexError):
                pass
    metrics['max_disk_util_pct'] = max_util

    return metrics

def compare_metrics(current: dict, baseline: dict) -> list:
    """Compare current metrics to baseline and flag anomalies."""
    anomalies = []

    thresholds = {
        'load_1m': {'delta_pct': 50, 'direction': 'increase'},
        'mem_available_kb': {'delta_pct': 30, 'direction': 'decrease'},
        'cpu_idle_pct': {'delta_pct': 30, 'direction': 'decrease'},
        'cpu_iowait_pct': {'threshold': 10.0, 'direction': 'increase'},
        'max_disk_util_pct': {'threshold': 80.0, 'direction': 'increase'},
    }

    for metric, config in thresholds.items():
        if metric not in current or metric not in baseline:
            continue

        current_val = current[metric]
        baseline_val = baseline[metric]

        if 'threshold' in config:
            if config['direction'] == 'increase' and current_val > config['threshold']:
                anomalies.append({
                    'metric': metric,
                    'current': current_val,
                    'threshold': config['threshold'],
                    'severity': 'warning' if current_val < config['threshold'] * 1.5 else 'critical',
                })
        elif 'delta_pct' in config:
            if baseline_val == 0:
                continue
            delta_pct = abs((current_val - baseline_val) / baseline_val) * 100
            if delta_pct > config['delta_pct']:
                direction = 'increase' if current_val > baseline_val else 'decrease'
                if direction == config['direction']:
                    anomalies.append({
                        'metric': metric,
                        'current': current_val,
                        'baseline': baseline_val,
                        'delta_pct': delta_pct,
                        'severity': 'warning' if delta_pct < config['delta_pct'] * 2 else 'critical',
                    })

    return anomalies

if __name__ == '__main__':
    baseline_file = sys.argv[1] if len(sys.argv) > 1 else None
    current = collect_current_metrics()

    print("Current metrics:")
    for k, v in sorted(current.items()):
        print(f"  {k}: {v}")

    if baseline_file:
        with open(baseline_file) as f:
            baseline = json.load(f)
        anomalies = compare_metrics(current, baseline)
        if anomalies:
            print("\nAnomalies detected:")
            for a in anomalies:
                print(f"  [{a['severity'].upper()}] {a['metric']}: {a}")
        else:
            print("\nNo significant deviations from baseline.")
    else:
        # Save current as baseline
        import json
        print("\nSaving as new baseline...")
        print(json.dumps(current, indent=2))
```

## Quick Diagnostic Runbook

When a system is reported as "slow", execute these steps in order:

```bash
# Step 1: 60-second overview (Brendan Gregg's checklist)
uptime                      # Load averages
dmesg | tail -20            # Recent kernel messages
vmstat 1 5                  # Virtual memory overview
mpstat -P ALL 1 5           # Per-CPU utilization
pidstat 1 5                 # Per-process CPU stats
iostat -xz 1 5              # Disk I/O
free -h                     # Memory
sar -n DEV 1 5              # Network
sar -n TCP,ETCP 1 5         # TCP stats

# Step 2: Identify the resource under pressure
# Check PSI (Linux kernel 4.20+)
cat /proc/pressure/cpu
cat /proc/pressure/memory
cat /proc/pressure/io

# Step 3: Identify the specific process or kernel subsystem
# For CPU saturation:
perf top -a -g

# For memory pressure:
slabtop -o | head -20
grep -i thp /proc/vmstat

# For I/O saturation:
iotop -o -b -d 1 -n 10

# For network issues:
ss -t -i state established | head -20

# Step 4: Trace root cause
# For CPU bottleneck in specific process:
perf record -g -p $(pgrep -x webapp) sleep 10
perf report --no-children | head -30

# For memory allocation hot paths:
perf record -e kmem:kmalloc -a sleep 5
perf report --stdio | head -30

# For I/O bottleneck:
blktrace -d /dev/sda -a read,write -o /tmp/io-trace sleep 10
blkparse -i /tmp/io-trace.blktrace.* | head -50
```

## Key Takeaways

**Apply USE before drawing conclusions**: The most common mistake in performance diagnosis is jumping to the first symptom. The USE Method's systematic checklist — Utilization, Saturation, Errors for every resource — prevents this. A system with high CPU utilization might actually be I/O-bound if disk saturation is causing threads to park in D state, artificially lowering CPU utilization.

**PSI is the authoritative saturation metric**: Linux Pressure Stall Information (available since kernel 4.20) provides direct measurement of how much time tasks are stalled waiting for CPU, memory, or I/O. Unlike derived metrics like load average, PSI directly measures the impact on application performance. `avg10 > 5%` for any resource indicates meaningful saturation.

**perf stat reveals hardware-level bottlenecks**: Application-level profiling cannot explain why IPC is low or cache miss rates are high. `perf stat` hardware counters reveal whether the bottleneck is compute (low IPC with high cycles), memory bandwidth (high cache miss rates), or branch misprediction. This guides micro-optimization at the right level.

**Baselines make anomalies visible**: Without a baseline, you cannot distinguish "system is slow compared to yesterday" from "system is slow compared to the incident last month." Collect daily baselines and store them for at least 90 days. The comparison script above provides automated anomaly detection against stored baselines.

**Run queue depth is the CPU saturation indicator**: Load average is commonly misunderstood. What matters is whether load average divided by CPU count is greater than 1 (saturation). `vmstat`'s `r` column (run queue depth) provides the most direct measurement — when consistently greater than the number of CPUs, the system is CPU-saturated.
