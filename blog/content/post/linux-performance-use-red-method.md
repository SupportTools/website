---
title: "Linux Performance Analysis: USE Method, RED Method, and Tool Selection"
date: 2029-01-18T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "USE Method", "RED Method", "perf", "BPF", "Observability", "Troubleshooting"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A systematic guide to Linux performance analysis using the USE (Utilization, Saturation, Errors) and RED (Rate, Errors, Duration) methods, with tool selection matrices, practical command examples, and BPF-based advanced analysis."
more_link: "yes"
url: "/linux-performance-use-red-method/"
---

Linux performance investigation without a structured methodology leads to confirmation bias — engineers tend to look at the metrics they already know how to collect rather than the metrics that describe the actual problem. The USE Method (Brendan Gregg) and RED Method (Tom Wilkie) provide complementary frameworks: USE targets infrastructure resources (CPU, memory, disk, network) while RED targets services (request rate, error rate, duration). Together they cover both the infrastructure and application layers that determine end-user experience. This guide applies both methods systematically with the specific Linux tools required at each analysis step.

<!--more-->

## The USE Method: Infrastructure Resources

The USE Method examines every physical and logical resource through three lenses:
- **Utilization**: How busy the resource is (as a percentage of capacity)
- **Saturation**: Whether the resource has excess work it cannot service (queue depth, wait time)
- **Errors**: Error count for the resource

### CPU Analysis

```bash
# CPU Utilization: Overall and per-CPU
mpstat -P ALL 1 5
# Average:  CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle
# Average:  all   23.14    0.00    4.52    0.12    0.00    0.43    0.00    0.00    0.00   71.79

# CPU Saturation: Run queue length (should be <= CPU count)
vmstat 1 5
# procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
#  r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
#  2  0      0 2048000 128000 8192000    0    0     0    0  800 1200 23  5 72  0  0
# r column: processes waiting for CPU (> CPU count indicates saturation)

# Per-process CPU usage
pidstat -u 1 5
# Average:      UID       PID    %usr %system  %guest   %wait    %CPU   CPU  Command
# Average:     1000      1234   18.40    2.10    0.00    0.40   20.50     3  java

# CPU scheduling latency (requires perf)
# Measures how long runnable tasks wait before getting CPU time
perf sched latency 2>/dev/null || \
  echo "Use bpftrace: bpftrace -e 'tracepoint:sched:sched_stat_wait { @[comm] = hist(args->delay / 1000); }'"

# CPU frequency scaling (affects perceived performance)
grep MHz /proc/cpuinfo | awk '{sum += $4; count++} END {printf "Avg CPU MHz: %.0f\n", sum/count}'
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq

# CPU errors: Machine Check Architecture (hardware errors)
mcelog --client 2>/dev/null || grep -i 'mce\|hardware error\|corrected error' /var/log/messages | tail -20
```

### Memory Analysis

```bash
# Memory Utilization: Available vs. total
free -m
# Reports:
# total: Total physical memory
# used: Used memory (including buffers/cache)
# free: Genuinely unused memory
# available: Memory available for new processes (approx.)

# Detailed memory breakdown
cat /proc/meminfo | grep -E \
  'MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapCached|Active|Inactive|SwapTotal|SwapFree|Dirty|Writeback|AnonPages|Mapped|Shmem|KReclaimable|Slab|SReclaimable|SUnreclaim|HugePages_Total|HugePages_Free|AnonHugePages'

# Memory Saturation: Page scanning activity
# High kswapd CPU usage indicates memory saturation
pidstat -p $(pgrep kswapd | head -1) 1 10

# Page scanner activity rate
vmstat 1 10 | awk 'NR>2 {
  if ($7 > 100 || $8 > 100) print "SWAP ACTIVITY: si=" $7 " so=" $8
}'

# Minor and major page faults per process
pidstat -r 1 5 -p $(pgrep -f java | head -1)
# Average: 1000    1234  2.00  10.30  0.02     java
# Column order: UID PID minflt/s majflt/s VSZ RSS %MEM Command
# majflt/s > 0 indicates pages being swapped back in (saturation indicator)

# Kernel memory reclaim pressure (PSI - Pressure Stall Information)
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.12 avg300=0.08 total=128432
# full avg10=0.00 avg60=0.04 avg300=0.02 total=42104
# "full" > 0 means ALL processes were stalled waiting for memory

# Memory errors: EDAC (Error Detection and Correction)
ls /sys/bus/platform/drivers/ie31200_edac/ 2>/dev/null && \
  edac-util -s 0 || \
  grep -c 'EDAC\|ECC\|corrected' /var/log/messages 2>/dev/null | head -5
```

### Disk I/O Analysis

```bash
# Disk I/O Utilization and Saturation
# iostat is the primary tool
iostat -xz 1 5
# Device            r/s     rMB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wMB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dMB/s   drqm/s  %drqm d_await dareq-sz  aqu-sz  %util
# nvme0n1          80.00    10.00     2.00   2.44    0.42   128.00    40.00     8.00    10.00  20.00    1.23   204.80    0.00     0.00     0.00   0.00    0.00     0.00    0.06  12.00

# Key metrics:
# r_await/w_await: Average I/O wait time (ms). > 20ms indicates saturation.
# aqu-sz: Average queue depth. > 1.0 indicates saturation.
# %util: Device utilization. > 60% may indicate saturation for spinning disks.
#        NVMe can sustain 100% without significant latency increase.

# Per-process I/O consumption
iotop -ao -n 5
# or without iotop:
pidstat -d 1 5

# I/O Saturation: Block I/O throttling via cgroups (containers)
# Check if containers are being throttled
cat /sys/fs/cgroup/blkio/system.slice/docker.service/blkio.throttle.io_serviced
# 8:0 Read 12043
# 8:0 Write 8421

# Disk Errors
journalctl -k | grep -i 'error\|I/O error\|sector\|ata\|scsi' | tail -30

# S.M.A.R.T. status
smartctl -a /dev/nvme0n1 | grep -E 'Error|Reallocated|Uncorrectable|Pending'

# Block device I/O latency histogram with BCC/BPF
sudo biolatency -D 10 1  # 10-second interval, requires bcc-tools
# Tracing block device I/O... Hit Ctrl-C to end.
# disk = 'nvme0n1'
#      usecs               : count     distribution
#       0 -> 1             : 0        |                    |
#       2 -> 3             : 0        |                    |
#       4 -> 7             : 1823     |********************|
#       8 -> 15            : 8420     |********************|
#      16 -> 31            : 2103     |***                 |
#      32 -> 63            : 124      |                    |
```

### Network Analysis

```bash
# Network Utilization: Bytes/packets per second
sar -n DEV 1 5
# Average:        IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   rxcmp/s   txcmp/s  rxmcst/s   %ifutil
# Average:         eth0    1200.40    980.20   1024.33    768.44      0.00      0.00      0.00      8.19

# Alternative: ip tool
watch -n 1 'ip -s -h link show eth0 | grep -A 2 "RX:\|TX:"'

# Network Saturation: Dropped packets
cat /proc/net/dev | grep eth0
# eth0: 1234567890 1024000 0 0 0 0 0 0 987654321 768000 0 0 0 0 0 0
# Fields: bytes packets errs drop fifo frame compressed multicast (per direction)

# netstat for socket saturation
ss -s
# Total: 4821 (kernel 5124)
# TCP:   4321 (estab 3800, closed 180, orphaned 12, timewait 180)
# Transport Total     IP        IPv6
# RAW       0         0         0
# UDP       12        10        2
# TCP       4321      4100      221

# TCP retransmit rate (saturation indicator)
sar -n ETCP 1 5
# Average:        AS     ESTRES   ACTOPEN   PASOPEN  ATMPTF  ESTABRE RETRANS  ISEGERR
# Average:      0.00      0.00    12.00    10.00    0.00    0.20    0.40    0.00
# RETRANS > 1% of segments is a saturation/error indicator

# Network Errors
ip -s link show eth0 | grep -A 3 "RX errors\|TX errors"
ethtool -S eth0 | grep -i 'error\|drop\|miss\|over'

# TCP latency with BPF
sudo tcplife -w 5  # Requires bcc-tools: shows TCP connection lifecycle with durations
```

## The RED Method: Service-Level Analysis

The RED Method focuses on services rather than infrastructure. For every microservice, measure:
- **Rate**: Requests per second the service is handling
- **Errors**: Rate of requests that fail
- **Duration**: Distribution of response times

### Application-Level RED Metrics

```bash
# For services exposing Prometheus metrics
# Typical metric names from popular Go frameworks:

# Rate (requests per second)
# http_requests_total counter → rate(http_requests_total[5m])

# Errors (error rate)
# rate(http_requests_total{status_code=~"5.."}[5m]) /
# rate(http_requests_total[5m])

# Duration (latency percentiles)
# histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))

# For services without built-in metrics, use conntrack
# Rate: count of connections per second
conntrack -L 2>/dev/null | grep "tcp.*ESTABLISHED.*dport=8080" | wc -l

# For nginx access logs: extract RED metrics
awk '{
  split($9, status, "");
  if (status[1] == "5") errors++;
  total++;
  # Extract response time from $NF if available
} END {
  print "Total:", total;
  print "Errors:", errors;
  if (total > 0) print "Error rate:", errors/total*100 "%";
}' /var/log/nginx/access.log
```

### System Call Latency Analysis

```bash
# Trace slow system calls for a given process
# Requires perf or BPF tools

# Profile system call latency distribution
sudo perf trace -p $(pgrep -f myapp | head -1) \
  --duration 10000 \
  --summary 2>&1 | \
  sort -k4 -rn | head -20

# BPF-based system call latency histogram
sudo funclatency -p $(pgrep -f myapp | head -1) 'sys_read' 5
#      usecs               : count     distribution
#       0 -> 1             : 12453    |********************|
#       2 -> 3             : 4821     |*******             |
#       4 -> 7             : 1203     |*                   |
#       8 -> 15            : 421      |                    |
#      16 -> 31            : 12       |                    |  ← outliers
#      32 -> 63            : 2        |                    |
```

## Tool Selection Matrix

The right tool depends on what resource you are investigating and what information you need:

### CPU Tools

| Observation Need | Tool | Command |
|---|---|---|
| Overall CPU usage | vmstat | `vmstat 1` |
| Per-CPU usage | mpstat | `mpstat -P ALL 1` |
| Per-process CPU | pidstat | `pidstat -u 1` |
| CPU flame graph | perf | `perf record -F 99 -ag -- sleep 30` |
| Lock contention | perf | `perf lock record -a -- sleep 10` |
| Scheduler latency | bpftrace | `bpftrace -e 'tracepoint:sched:sched_stat_wait...'` |
| Off-CPU time | offcputime | `offcputime-bpfcc 30` |

### Memory Tools

| Observation Need | Tool | Command |
|---|---|---|
| Memory overview | free | `free -m` |
| Detailed breakdown | cat /proc/meminfo | `grep -E '...' /proc/meminfo` |
| Page fault rate | pidstat | `pidstat -r 1 -p PID` |
| Memory leak detection | valgrind | `valgrind --leak-check=full myapp` |
| Memory allocations | memleak (bcc) | `memleak-bpfcc -p PID` |
| Heap profiling | perf | `perf mem record -a sleep 30` |
| NUMA placement | numastat | `numastat -p PID` |

### Disk I/O Tools

| Observation Need | Tool | Command |
|---|---|---|
| I/O utilization | iostat | `iostat -xz 1` |
| Per-process I/O | iotop | `iotop -ao` |
| I/O latency histogram | biolatency (bcc) | `biolatency 10 1` |
| I/O tracing | blktrace | `blktrace -d /dev/nvme0n1 -w 30` |
| File system latency | ext4slower (bcc) | `ext4slower 10` |
| VFS operations | vfsstat (bcc) | `vfsstat 1` |

### Network Tools

| Observation Need | Tool | Command |
|---|---|---|
| Interface statistics | sar | `sar -n DEV 1` |
| Socket state | ss | `ss -tuanp` |
| TCP retransmits | sar | `sar -n ETCP 1` |
| DNS latency | dig | `dig +stats @8.8.8.8 google.com` |
| TCP connection tracking | tcptop (bcc) | `tcptop 1` |
| Packet captures | tcpdump | `tcpdump -i eth0 -w /tmp/capture.pcap` |
| Network latency | bpftrace | `tcpretrans-bpfcc` |

## Systematic Investigation Workflow

```bash
#!/usr/bin/env bash
# scripts/performance-baseline.sh
# Collect a comprehensive performance baseline in 60 seconds

set -euo pipefail

OUTPUT_DIR="/tmp/perf-baseline-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${OUTPUT_DIR}"

echo "=== Performance Baseline Collection ==="
echo "Output: ${OUTPUT_DIR}"
echo "Duration: 60 seconds"
echo

# Snapshot: immediate state
echo "--- 1. System overview ---"
uname -a > "${OUTPUT_DIR}/uname.txt"
uptime > "${OUTPUT_DIR}/uptime.txt"
date > "${OUTPUT_DIR}/timestamp.txt"
cat /proc/cpuinfo | grep -E '^(processor|model name|cpu MHz)' > "${OUTPUT_DIR}/cpu-info.txt"
free -m > "${OUTPUT_DIR}/memory.txt"
df -h > "${OUTPUT_DIR}/disk-usage.txt"
cat /proc/loadavg > "${OUTPUT_DIR}/loadavg.txt"

echo "--- 2. 60-second sar collection ---"
sar -u -r -d -n DEV -q 1 60 > "${OUTPUT_DIR}/sar-60s.txt" &
SAR_PID=$!

echo "--- 3. 10-second vmstat ---"
vmstat 1 10 > "${OUTPUT_DIR}/vmstat-10s.txt"

echo "--- 4. I/O statistics ---"
iostat -xz 1 10 > "${OUTPUT_DIR}/iostat-10s.txt"

echo "--- 5. Network statistics ---"
ss -s > "${OUTPUT_DIR}/ss-summary.txt"
ss -tuanp > "${OUTPUT_DIR}/ss-detail.txt"
cat /proc/net/dev > "${OUTPUT_DIR}/net-dev.txt"

echo "--- 6. Process state ---"
ps aux --sort=-%cpu | head -20 > "${OUTPUT_DIR}/top-cpu-procs.txt"
ps aux --sort=-%mem | head -20 > "${OUTPUT_DIR}/top-mem-procs.txt"

echo "--- 7. Kernel memory ---"
cat /proc/meminfo > "${OUTPUT_DIR}/meminfo.txt"
cat /proc/vmstat > "${OUTPUT_DIR}/vmstat-snapshot.txt"

echo "--- 8. Pressure stall information ---"
cat /proc/pressure/cpu    > "${OUTPUT_DIR}/psi-cpu.txt"
cat /proc/pressure/memory > "${OUTPUT_DIR}/psi-memory.txt"
cat /proc/pressure/io     > "${OUTPUT_DIR}/psi-io.txt"

echo "--- 9. Interrupts and context switches ---"
cat /proc/interrupts | sort -k3 -rn | head -20 > "${OUTPUT_DIR}/interrupts-top.txt"
cat /proc/softirqs > "${OUTPUT_DIR}/softirqs.txt"

wait "${SAR_PID}"

echo "--- Collection complete ---"
tar czf "${OUTPUT_DIR}.tar.gz" "${OUTPUT_DIR}/"
echo "Archive: ${OUTPUT_DIR}.tar.gz"
ls -lh "${OUTPUT_DIR}.tar.gz"
```

## PSI: Pressure Stall Information

Linux PSI (added in kernel 4.20) provides the most accurate utilization and saturation signal because it measures the percentage of time tasks were actually stalled.

```bash
# PSI provides three metrics for CPU, memory, and I/O:
# "some": Some tasks were stalled (shared bottleneck)
# "full": ALL runnable tasks were stalled (complete bottleneck)

# Check system-level PSI
cat /proc/pressure/cpu
# some avg10=1.23 avg60=0.89 avg300=0.72 total=48291023
# No "full" line for CPU (at least one process is always runnable)

cat /proc/pressure/memory
# some avg10=0.00 avg60=0.04 avg300=0.12 total=128432
# full avg10=0.00 avg60=0.01 avg300=0.04 total=42104

cat /proc/pressure/io
# some avg10=2.41 avg60=1.82 avg300=1.23 total=384201
# full avg10=0.12 avg60=0.08 avg300=0.06 total=19403

# Interpretation:
# avg10=2.41 means 2.41% of the last 10 seconds was spent with
# some task stalled waiting for I/O
# This is the most honest saturation metric available

# Container-level PSI (cgroups v2)
cat /sys/fs/cgroup/system.slice/myapp.service/io.pressure
cat /sys/fs/cgroup/system.slice/myapp.service/memory.pressure
cat /sys/fs/cgroup/system.slice/myapp.service/cpu.pressure

# Prometheus alerts based on PSI
# Alert if any resource is stalled > 10% of the time over 5 minutes
# node_pressure_cpu_waiting_seconds_total (from node-exporter)
# node_pressure_memory_waiting_seconds_total
# node_pressure_io_waiting_seconds_total
```

## BPF-Based Advanced Analysis

```bash
# BPF/eBPF tools (requires bcc or bpftrace)
# Install: apt-get install bpfcc-tools python3-bpfcc (Ubuntu)
#          yum install bcc-tools (RHEL/CentOS)

# Trace all new process executions with arguments
execsnoop-bpfcc

# Trace file opens with latency
opensnoop-bpfcc -p $(pgrep -f java | head -1)

# Network connection trace
tcpconnect-bpfcc

# Slow filesystem operations (> 10ms threshold)
fileslower-bpfcc 10

# Cache hit rate (page cache)
cachestat-bpfcc 1

# Disk I/O operations count and size
disksnoop-bpfcc

# Lock contention profiling
llcstat-bpfcc 5  # LLC hit ratio (L3 cache)

# System-wide CPU flame graph with BPF
profile-bpfcc -F 99 -adf 30 > /tmp/out.stacks
# Then use flamegraph.pl to render:
# flamegraph.pl /tmp/out.stacks > /tmp/flamegraph.svg
```

## Quick Reference: First 60 Seconds Checklist

```bash
# The "first 60 seconds" checklist for any Linux performance problem:

# 1. Is the system severely overloaded?
uptime
# load average > 4 * CPU_count indicates severe CPU saturation

# 2. Are there kernel error messages?
dmesg -T | tail -50 | grep -i 'error\|warning\|oom\|killed\|panic'

# 3. CPU overview
vmstat 1 5
# si/so columns: non-zero = swap saturation
# r column > CPU count = CPU saturation

# 4. CPU anomalies per process
pidstat 1 5

# 5. Memory pressure
free -m
cat /proc/pressure/memory

# 6. Disk I/O saturation
iostat -xz 1 5
# aqu-sz > 1, %util > 80, r_await > 20ms = disk saturation

# 7. Network issues
sar -n DEV 1 5
netstat -s | grep -E 'retransmit|overflow|drop'

# 8. Kernel virtual memory
vmstat -sm 1 5  # Include slab stats

# 9. High-level process state
top -bn1 | head -20

# 10. Open file descriptors (common resource exhaustion)
cat /proc/sys/fs/file-nr
# Output: open_fds available_fds max_fds
# If open_fds approaches max_fds, expect EMFILE errors
```

## Summary

Effective Linux performance analysis requires both a structured methodology and the right tool for each observation layer. Key principles:

- Apply USE to physical resources first: CPU run queue depth (vmstat `r`), memory swap activity (vmstat `si/so`), disk queue depth (iostat `aqu-sz`), and network drops (ip -s)
- Use PSI (`/proc/pressure/`) as the most reliable saturation indicator — it measures actual task stall time rather than indirect utilization proxies
- Apply RED to services: extract request rate, error rate, and latency percentiles from access logs or metrics endpoints
- Escalate from `vmstat`/`iostat`/`sar` to BPF tools only when standard tools identify an anomaly but not its root cause
- Capture baseline performance data in production during normal operation to establish the reference point that makes anomalies visible
- Instrument PSI thresholds in Prometheus alerting: `full > 1%` for memory or I/O indicates a resource that is genuinely limiting throughput, not merely busy
