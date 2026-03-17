---
title: "Linux Performance Debugging: Brendan Gregg's USE Method in Practice"
date: 2029-05-31T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Debugging", "Observability", "SRE", "Systems Programming", "Brendan Gregg"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to applying Brendan Gregg's USE Method (Utilization, Saturation, Errors) for systematic Linux performance debugging, covering CPU, memory, disk, and network resource analysis with specific tools and commands."
more_link: "yes"
url: "/linux-performance-debugging-use-method/"
---

When a production system runs slow, the instinct is to grep logs or check what changed. That approach works for software bugs but fails for performance problems — performance is a property of the entire system, not a single component. Brendan Gregg's USE Method provides a rigorous, resource-centric framework for identifying performance bottlenecks: for every resource in the system, check its Utilization, Saturation, and Errors. This guide implements the USE Method in practice with specific Linux tools, commands, and interpretations.

<!--more-->

# Linux Performance Debugging: Brendan Gregg's USE Method in Practice

## The USE Method Explained

The USE Method defines three metrics for every system resource:

- **Utilization**: The average time the resource was busy servicing work, expressed as a percentage. A CPU at 90% utilization is busy 90% of the time.
- **Saturation**: The degree to which the resource has extra work it cannot service, usually expressed as a queue length. A CPU with a run queue depth of 10 has 10 runnable threads waiting.
- **Errors**: The count of error events. A NIC reporting CRC errors indicates signal integrity problems regardless of utilization.

High utilization approaching 100% causes latency to increase non-linearly (queuing theory). Saturation is often more immediately actionable than utilization — a disk with 1% utilization but a consistently non-zero I/O queue indicates something is blocking. Errors can cause latency even at low utilization.

## The USE Checklist for Linux

Work through every resource in the system:

| Resource | Utilization Tool | Saturation Tool | Errors Tool |
|---|---|---|---|
| CPU | `mpstat`, `top` | `vmstat r`, `sar -q` | `perf stat`, machine check log |
| Memory | `free`, `vmstat` | `vmstat si/so`, OOM events | `dmesg` OOM killer |
| Network interface | `ip -s link`, `sar -n DEV` | `ss -s`, `/proc/net/dev` drops | `ip -s link`, `ethtool -S` |
| Disk I/O | `iostat %util` | `iostat avgqu-sz`, `sar -d` | `smartctl`, `dmesg` I/O errors |
| File system | `df -h` | `df -i` (inode exhaustion) | `dmesg` FS errors |
| CPU scheduler | `mpstat`, steal% | `vmstat r` run queue | perf sched |
| Memory bus | `perf stat` LLC | N/A | hardware PMU |

## CPU: Utilization, Saturation, and Errors

### CPU Utilization

```bash
# Per-CPU utilization every second for 5 samples
mpstat -P ALL 1 5

# Output interpretation:
# %usr   - user space time
# %sys   - kernel time
# %iowait - waiting for I/O (this is idle, not utilization, but indicates I/O bottleneck)
# %steal - time stolen by hypervisor (cloud instances — high steal means overprovisioned host)
# %idle  - truly idle time

# If %usr + %sys > 85% per CPU, you're approaching saturation
# If %steal > 5%, your cloud instance is noisy-neighbor affected
```

```bash
# Continuous CPU summary — watch for high user/system ratios
top -d 1 -b | head -20

# Per-process CPU sorted by consumption
ps aux --sort=-%cpu | head -20

# Time-series CPU data for the last 24 hours
sar -u 1 5          # current
sar -u -f /var/log/sa/sa$(date +%d)  # from sadc data
```

### CPU Saturation (Run Queue)

```bash
# vmstat: r column is the run queue depth
# r > number_of_CPUs indicates saturation
vmstat 1 10

# procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
#  r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
#  8  0      0 1234567  12345 678901    0    0     0     1 1234 5678 45  5 50  0  0
# r=8 with 4 CPUs = 2x oversubscribed — significant saturation

# Extended run queue stats
sar -q 1 5
# Output includes: runq-sz (average run queue), plist-sz (process list size), ldavg-1/5/15

# Kernel scheduler latency with perf (requires root)
perf sched latency --sort max
```

```bash
# Identify which processes are causing CPU saturation
# Find processes spending time in runnable state
for pid in /proc/[0-9]*/status; do
    state=$(grep "^State:" "$pid" | awk '{print $2}')
    if [ "$state" = "R" ]; then
        comm=$(grep "^Name:" "$pid" | awk '{print $2}')
        echo "PID $(basename $(dirname $pid)): $comm"
    fi
done

# Or use pidstat to see scheduler-level stats
pidstat -u -w 1 5
# %CPU: CPU utilization
# cswch/s: voluntary context switches (waiting for I/O or sleep)
# nvcswch/s: involuntary context switches (preempted — indicates saturation)
# High nvcswch/s suggests the process is being preempted — CPU contention
```

### CPU Errors

```bash
# Machine Check Exceptions — hardware CPU errors
mcelog --client 2>/dev/null || dmesg | grep -i "machine check\|mce\|hardware error"

# Kernel soft lockup detector warnings
dmesg | grep -i "soft lockup\|hard lockup\|hung_task"

# Performance counter errors (requires perf)
perf stat -e cache-misses,cache-references,instructions,cycles \
  -p $(pgrep -f "your-process") sleep 10

# LLC miss rate > 30% often indicates memory bandwidth issues
# Instructions per cycle (IPC) < 1.0 often indicates memory stalls
```

## Memory: Utilization, Saturation, and Errors

### Memory Utilization

```bash
# Free memory overview — always use 'available', not 'free'
free -h
#              total        used        free      shared  buff/cache   available
# Mem:           31G         12G        200M        500M         18G         18G
# 'available' accounts for reclaimable page cache — this is what matters

# Detailed memory breakdown
cat /proc/meminfo
# MemTotal: total physical RAM
# MemFree: truly free (no page cache counted)
# MemAvailable: available for new allocations (includes reclaimable page cache)
# Buffers: kernel buffer cache
# Cached: page cache
# SwapTotal/SwapFree: swap usage
# AnonPages: anonymous pages (heap, stack — not file-backed)
# Mapped: file mappings (mmap)
# Shmem: tmpfs and shared memory
# Slab: kernel slab allocator usage

# Per-NUMA-node memory stats (important for multi-socket servers)
numactl --hardware
numastat
```

```bash
# Memory utilization by process
ps aux --sort=-%mem | head -20

# Virtual memory size vs RSS
# VSZ: virtual size (includes all mapped regions, many uncommitted)
# RSS: resident set size (actual physical memory pages in use)
# High VSZ with low RSS = normal for JVM/Go (large virtual space, lazy allocation)
# RSS approaching physical memory = potential pressure

# Smaps for detailed per-mapping breakdown of a process
cat /proc/$(pgrep your-process)/smaps | grep -E "^(Size|Rss|Pss|Shared_Clean|Private_Clean|Private_Dirty):" | \
  awk '{sum[$1] += $2} END {for (k in sum) print k, sum[k] "kB"}'
```

### Memory Saturation (Paging and Swapping)

```bash
# vmstat: si (swap in) and so (swap out) columns
# Any non-zero si/so under normal operations = memory saturation
vmstat 1 10

# Major and minor page faults
# Minor faults: page not in TLB but in RAM (normal)
# Major faults: page must be read from disk (bad — indicates swap usage or cold cache)
sar -B 1 5
# pgfault/s: total page faults (minor + major)
# majflt/s: major page faults per second — should be near zero in steady state

# Detailed per-process paging
pidstat -r 1 5
# minflt/s, majflt/s, VSZ, RSS, %MEM

# OOM killer activity
dmesg | grep -i "oom\|out of memory\|killed process"
journalctl -k --since "1 hour ago" | grep -i "oom\|killed"

# Memory compaction pressure
cat /proc/vmstat | grep -E "compact|kswapd|pgsteal|pgscan"
# High kswapd_steal = active memory reclaim = memory pressure
# High compact_migrate = memory fragmentation
```

```bash
# Check if system is under memory pressure
# /proc/pressure/memory (PSI — Pressure Stall Information, kernel 4.20+)
cat /proc/pressure/memory
# some avg10=X.XX avg60=X.XX avg300=X.XX total=XXXXXX
# full avg10=X.XX avg60=X.XX avg300=X.XX total=XXXXXX
# 'some': at least one task stalled on memory
# 'full': all tasks stalled on memory (severe pressure)
# avg10 > 10% = active memory pressure requiring investigation
```

### Memory Errors

```bash
# Hardware memory errors (ECC)
edac-util -s 4 2>/dev/null || mcelog --client 2>/dev/null

# Check EDAC (Error Detection And Correction) counters
for f in /sys/devices/system/edac/mc/mc*/; do
    echo "=== $f ==="
    cat "${f}ce_count" 2>/dev/null && echo "correctable errors"
    cat "${f}ue_count" 2>/dev/null && echo "uncorrectable errors"
done

# Kernel memory allocation failures
dmesg | grep -i "page allocation failure\|cannot allocate\|out of memory"

# THP (Transparent Huge Pages) fallback events
grep -E "THP|thp|hugepage" /proc/vmstat | grep -v "^nr_"
```

## Disk I/O: Utilization, Saturation, and Errors

### Disk Utilization

```bash
# iostat — the primary disk I/O tool
# -x: extended stats, -z: skip zero-activity devices, -m: megabytes
iostat -xzm 1 10

# Key columns:
# %util: percentage of wall-clock time device was busy (utilization)
#        NOTE: For SSDs/NVMe with multiple queues, >100% is theoretical and %util is less meaningful
# r/s, w/s: read/write operations per second (IOPS)
# rMB/s, wMB/s: throughput
# r_await, w_await: average service time in ms (latency)
# aqu-sz (or avgqu-sz): average I/O queue depth (saturation indicator)
# svctm: service time (deprecated — use r_await/w_await instead)

# If %util > 80% for HDD: potentially saturated
# If aqu-sz > 1 consistently: I/O queue is building up (saturation)
# If r_await or w_await > 10ms for HDD / >1ms for SSD: slow device

# Per-device bandwidth with sar
sar -d 1 5 -p  # -p uses device names instead of major:minor
```

```bash
# Which processes are causing disk I/O?
# iotop requires root
iotop -o -d 1 -n 5

# Or without iotop: check /proc/<pid>/io
for pid in /proc/[0-9]*/io; do
    if [ -r "$pid" ]; then
        rchar=$(grep "^rchar:" "$pid" | awk '{print $2}')
        wchar=$(grep "^wchar:" "$pid" | awk '{print $2}')
        comm=$(cat "$(dirname $pid)/comm" 2>/dev/null)
        echo "$comm $(dirname $pid | xargs basename): r=${rchar}B w=${wchar}B"
    fi
done | sort -t: -k3 -rn | head -20

# Identify which files are being accessed
lsof +D /path/to/directory 2>/dev/null
```

### Disk Saturation

```bash
# I/O scheduler queue depth (saturation signal)
# aqu-sz > 1 means I/Os are queuing — indicates saturation
iostat -x 1 5 | awk 'NR>3 {print $1, "queue:", $9}'

# Pressure Stall Information for I/O
cat /proc/pressure/io
# full avg10 > 5% = significant I/O pressure

# Disk latency distribution with blktrace/blkparse (requires root)
blktrace -d /dev/nvme0n1 -o - | blkparse -i - -q -f "%D %2c %Q2 %5T %5t %s %a %C\n" | \
  awk '$7 == "C" {print $8}' | sort -n | \
  awk 'BEGIN{n=0; s=0} {a[n++]=$1; s+=$1} END{
    print "count:", n
    print "avg:", s/n "ms"
    print "p50:", a[int(n*0.50)] "ms"
    print "p99:", a[int(n*0.99)] "ms"
    print "p999:", a[int(n*0.999)] "ms"
  }'
```

### Disk Errors

```bash
# SMART disk health (requires smartmontools)
smartctl -H /dev/sda
smartctl -a /dev/sda | grep -E "Reallocated_Sector|Uncorrectable|Offline_Uncorrectable|UDMA_CRC"

# Kernel disk error messages
dmesg | grep -E "I/O error|EXT4-fs error|XFS.*error|blk_update_request|SCSI error|ata.*error" | tail -50

# NVMe error log
nvme error-log /dev/nvme0n1 2>/dev/null

# Device mapper errors (LVM, dm-multipath)
dmesg | grep -i "device-mapper\|dm-\|multipath"
```

## Network: Utilization, Saturation, and Errors

### Network Utilization

```bash
# Interface throughput (bits/bytes per second)
# ip -s link: current counters
ip -s link show eth0

# Continuous monitoring with sar
sar -n DEV 1 5
# rxkB/s, txkB/s: receive/transmit throughput
# rxpck/s, txpck/s: receive/transmit packet rate

# Calculate utilization percentage
# Interface speed in Mbps:
ethtool eth0 | grep Speed
# e.g., "Speed: 10000Mb/s" = 10 Gbps = 1250 MB/s max

# If rxkB/s + txkB/s > 80% of interface capacity, you're approaching saturation

# Real-time bandwidth per interface
nload eth0  # interactive
# Or:
watch -n 1 "cat /proc/net/dev | grep eth0"
```

```bash
# Per-connection bandwidth with ss
ss -tp state established | head -30

# Connection counts by state
ss -s
# Established, Time-Wait, Close-Wait, SYN-Sent

# Network utilization by process
nethogs eth0  # requires root, shows per-process bandwidth
```

### Network Saturation

```bash
# TX queue drops — packets dropped because TX ring buffer is full
ip -s link show eth0 | grep -A2 "TX:"
# "dropped X" = TX saturation

# Receive ring buffer drops
ethtool -S eth0 | grep -i "drop\|miss\|error\|discard"
# rx_missed_errors, rx_dropped: NIC ring buffer overflow

# Socket buffer exhaustion
cat /proc/net/sockstat
# TCP: inuse (active sockets), mem (memory pages)
# If mem is high and approaching net.ipv4.tcp_mem limits, you're in saturation

# Check TCP memory limits
sysctl net.ipv4.tcp_mem net.ipv4.tcp_rmem net.ipv4.tcp_wmem

# Listen backlog overflow (SYN queue drops)
netstat -s | grep -i "listen\|overflow\|SYN"
# "X SYNs to LISTEN sockets ignored" = listen backlog saturation

# Check for TCP retransmissions (saturation indicator)
sar -n TCP,ETCP 1 5
# retrans/s > 1% of active/s = network congestion or packet loss
```

### Network Errors

```bash
# Interface error counters
ip -s link show eth0
# Errors: input errors, output errors, dropped, overruns, carrier, collisions

# Detailed NIC statistics
ethtool -S eth0 | grep -v " 0$"
# Look for: rx_crc_errors, rx_frame_errors, tx_errors, rx_over_errors

# ICMP errors
cat /proc/net/snmp | grep Icmp
# IcmpMsgInType3: destination unreachable received
# IcmpMsgOutType3: destination unreachable sent

# TCP error counters
netstat -s | grep -E "retransmit|reset|error|fail" | head -20

# Conntrack (if iptables NAT or stateful firewall is in use)
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max
# If count approaches max, you have conntrack table exhaustion
```

## Building a USE Dashboard

Capture all USE metrics into a single 60-second snapshot script:

```bash
#!/bin/bash
# use-snapshot.sh — capture USE metrics for all major resources

echo "=== USE Method Snapshot: $(date) ==="

echo ""
echo "--- CPU Utilization (mpstat) ---"
mpstat -P ALL 1 3 | grep -v "^$\|^Linux\|^Average"

echo ""
echo "--- CPU Saturation (vmstat run queue) ---"
vmstat 1 3 | tail -3

echo ""
echo "--- Memory Utilization ---"
free -h
echo ""
cat /proc/meminfo | grep -E "^(MemTotal|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|AnonPages|Slab):"

echo ""
echo "--- Memory Saturation (PSI) ---"
cat /proc/pressure/memory 2>/dev/null || echo "PSI not available (kernel < 4.20)"

echo ""
echo "--- Memory Saturation (vmstat swap) ---"
vmstat -s | grep -E "swap|paged"

echo ""
echo "--- Disk I/O Utilization and Saturation ---"
iostat -xzm 1 3 | grep -v "^$\|^Linux"

echo ""
echo "--- Disk I/O Saturation (PSI) ---"
cat /proc/pressure/io 2>/dev/null || echo "PSI not available"

echo ""
echo "--- Network Utilization ---"
sar -n DEV 1 3 | grep -v "^$\|^Linux"

echo ""
echo "--- Network Errors ---"
ip -s link | grep -A4 "state UP"

echo ""
echo "--- Network Socket Saturation ---"
ss -s
echo ""
netstat -s 2>/dev/null | grep -E "retransmit|overflow|error" | head -10

echo ""
echo "--- Error Summary (dmesg last 100 lines) ---"
dmesg --level=err,crit,alert,emerg 2>/dev/null | tail -20
```

## Prometheus Alerting Rules for USE

```yaml
# prometheusrule-use-method.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: use-method-alerts
  namespace: monitoring
spec:
  groups:
    - name: use.cpu
      interval: 30s
      rules:
        - alert: CPUSaturation
          expr: |
            avg by (instance) (
              node_load1 / count by (instance) (node_cpu_seconds_total{mode="idle"})
            ) > 2
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CPU run queue depth > 2x CPU count on {{ $labels.instance }}"

        - alert: CPUHighUtilization
          expr: |
            100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 90
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "CPU utilization > 90% on {{ $labels.instance }}"

    - name: use.memory
      interval: 30s
      rules:
        - alert: MemorySaturation
          expr: |
            rate(node_vmstat_pswpin[5m]) + rate(node_vmstat_pswpout[5m]) > 100
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Active swapping detected on {{ $labels.instance }}"

        - alert: MemoryHighUtilization
          expr: |
            (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100 > 90
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Memory utilization > 90% on {{ $labels.instance }}"

    - name: use.disk
      interval: 30s
      rules:
        - alert: DiskIOSaturation
          expr: |
            rate(node_disk_io_time_weighted_seconds_total[5m]) > 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Disk I/O queue saturated on {{ $labels.instance }}:{{ $labels.device }}"

        - alert: DiskHighUtilization
          expr: |
            rate(node_disk_io_time_seconds_total[5m]) * 100 > 80
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Disk utilization > 80% on {{ $labels.instance }}:{{ $labels.device }}"

    - name: use.network
      interval: 30s
      rules:
        - alert: NetworkErrors
          expr: |
            rate(node_network_receive_errs_total[5m]) + rate(node_network_transmit_errs_total[5m]) > 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Network errors on {{ $labels.instance }}:{{ $labels.device }}"

        - alert: NetworkPacketDrops
          expr: |
            rate(node_network_receive_drop_total[5m]) + rate(node_network_transmit_drop_total[5m]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Network packet drops on {{ $labels.instance }}:{{ $labels.device }}"
```

## The Flame Graph: What to Do After USE

USE tells you which resource is the bottleneck. What it does not tell you is which code path is consuming that resource. Once USE points to CPU saturation, the next tool is a CPU flame graph:

```bash
# Capture CPU flame graph (requires perf and flamegraph.pl)
perf record -F 99 -a -g -- sleep 30
perf script | stackcollapse-perf.pl | flamegraph.pl > cpu-flame.svg

# For off-CPU (blocked) analysis (shows time in I/O, locks, sleep)
# Requires BCC tools
/usr/share/bcc/tools/offcputime -df -p $(pgrep your-service) 30 | \
  flamegraph.pl --color=io --title="Off-CPU Time Flame Graph" > offcpu-flame.svg

# For memory allocation profiling
/usr/share/bcc/tools/memleak -p $(pgrep your-service) 30
```

## Systematic Checklist for Production Incidents

When you receive a "the app is slow" ticket, follow this order:

1. **Start with USE for all resources simultaneously** — run `use-snapshot.sh` to get a baseline
2. **Check CPU run queue first** — most latency spikes on modern hardware are CPU saturation
3. **Check memory saturation** — look for swapping or PSI > 5%
4. **Check disk I/O saturation** — aqu-sz > 1 or PSI io full > 2%
5. **Check network errors** — packet drops cause TCP retransmissions which look like CPU/latency issues
6. **Identify the process** — use `top`, `pidstat`, `iotop` to find which process is the source
7. **Profile that process** — flame graph for CPU, `strace` for syscall analysis, `perf mem` for memory bandwidth
8. **Validate the fix** — re-run `use-snapshot.sh` and confirm the saturation metric decreased

The USE Method's power is in its completeness. By checking every resource systematically, you avoid the trap of optimizing the wrong component — fixing query caching when the real bottleneck is network saturation, or adding more application servers when the database is at 100% CPU.

## Summary

Brendan Gregg's USE Method provides a systematic framework for eliminating guesswork from performance debugging. By checking Utilization, Saturation, and Errors for every system resource — CPU, memory, disk, network — you rapidly narrow from "something is slow" to "the disk I/O queue depth is 15 on `/dev/sda` and process X is responsible." The Linux tooling to implement the full USE checklist is available on every distribution: `mpstat`, `vmstat`, `iostat`, `ss`, `ip`, and the PSI subsystem provide all the signals you need. Encode the USE checklist into a snapshot script, build Prometheus alerting rules around the saturation metrics, and you have a production-ready framework for systematic performance investigation.
