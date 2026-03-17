---
title: "Linux Kernel Tracing with ftrace: Function Graph Tracer, Event Tracing, trace-cmd, and KernelShark Visualization"
date: 2031-11-10T00:00:00-05:00
draft: false
tags: ["Linux", "ftrace", "Kernel Tracing", "trace-cmd", "KernelShark", "Performance Analysis", "Debugging"]
categories: ["Linux", "Systems Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux kernel tracing with ftrace covering the function graph tracer, static and dynamic event tracing, trace-cmd workflows, and KernelShark visualization for production performance analysis."
more_link: "yes"
url: "/linux-kernel-tracing-ftrace-function-graph-tracer-event-tracing-trace-cmd-kernelshark/"
---

ftrace is the Linux kernel's built-in tracing framework and is one of the most powerful tools available for understanding kernel behavior under production workloads. Unlike eBPF, it requires no compilation; unlike SystemTap, it needs no kernel-devel packages. This guide covers ftrace from the tracefs interface through trace-cmd automation and KernelShark visualization, with practical examples targeting I/O latency analysis, scheduler behavior, and memory subsystem tracing.

<!--more-->

# Linux Kernel Tracing with ftrace: Function Graph Tracer, Event Tracing, trace-cmd, and KernelShark Visualization

## ftrace Architecture

ftrace uses a ring buffer per CPU, accessed via the tracefs virtual filesystem mounted at `/sys/kernel/tracing` (or `/sys/kernel/debug/tracing` on older kernels). The key design property is that tracing overhead is near-zero when disabled: the kernel compiles NOP instructions at function entry points and patches them to call the tracing hook only when a tracer is active.

```bash
# Verify tracefs is mounted
mount | grep tracefs
# tracefs on /sys/kernel/tracing type tracefs (rw,relatime)

# If not mounted:
mount -t tracefs nodev /sys/kernel/tracing

# Key files
ls /sys/kernel/tracing/
# available_tracers   - list of built-in tracers
# current_tracer      - select active tracer
# trace               - read current trace buffer
# trace_pipe          - streaming read (does not consume)
# trace_marker        - write user-space markers
# events/             - available trace events
# set_ftrace_filter   - function filter
# tracing_on          - enable/disable tracing (1/0)
```

## Section 1: Function Tracer and Function Graph Tracer

### 1.1 Basic Function Tracer

```bash
# List available tracers
cat /sys/kernel/tracing/available_tracers
# blk function_graph wakeup_dl wakeup_rt wakeup function nop

# Enable the function tracer
echo function > /sys/kernel/tracing/current_tracer

# Limit to specific functions (otherwise all kernel functions are traced!)
# ALWAYS set a filter before enabling tracing to avoid overwhelming the buffer
echo 'ext4_*' > /sys/kernel/tracing/set_ftrace_filter

# Filter to a specific process
echo $$ > /sys/kernel/tracing/set_ftrace_pid

# Enable tracing
echo 1 > /sys/kernel/tracing/tracing_on

# Trigger your workload
dd if=/dev/zero of=/tmp/testfile bs=4096 count=1000 conv=fsync

# Disable tracing
echo 0 > /sys/kernel/tracing/tracing_on

# Read the trace
cat /sys/kernel/tracing/trace | head -50
# tracer: function
# #                                _-----=> irqs-off
# #                               / _----=> need-resched
# #                              | / _---=> hardirq/softirq
# #                              || / _--=> preempt-depth
# #                              ||| /     delay
# # TASK-PID       CPU#  IRQS    TIMESTAMP  FUNCTION
# # | |            | |   ||||       |         |
#           dd-1234 [001] .... 12345.678901: ext4_file_write_iter <-new_sync_write
#           dd-1234 [001] .... 12345.678902: ext4_buffered_write_iter <-ext4_file_write_iter
```

### 1.2 Function Graph Tracer

The function graph tracer shows entry AND exit of each function, enabling latency measurement at the function level.

```bash
# Enable function graph tracer
echo function_graph > /sys/kernel/tracing/current_tracer

# Configure graph depth to avoid overwhelming output
echo 5 > /sys/kernel/tracing/max_graph_depth

# Filter to specific subsystem
echo 'ext4_*' > /sys/kernel/tracing/set_graph_function

# Set buffer size per CPU (default is 7MB; increase for busy systems)
echo 65536 > /sys/kernel/tracing/buffer_size_kb

echo 1 > /sys/kernel/tracing/tracing_on
sync  # Trigger some ext4 activity
echo 0 > /sys/kernel/tracing/tracing_on

cat /sys/kernel/tracing/trace | head -80
# tracer: function_graph
# CPU  DURATION                  FUNCTION CALLS
# |    |   |                     |   |   |   |
#  0) + 15.234 us    |  ext4_sync_fs() {
#  0)   1.120 us     |    ext4_force_commit();
#  0)   0.876 us     |    jbd2_journal_flush();
#  0) + 17.234 us    |  }
```

### 1.3 Measuring Function Latency

```bash
# Find functions with high latency
echo function_graph > /sys/kernel/tracing/current_tracer
echo 0 > /sys/kernel/tracing/max_graph_depth  # Unlimited depth
echo 'blk_*' > /sys/kernel/tracing/set_graph_function

echo 1 > /sys/kernel/tracing/tracing_on
# Run I/O intensive workload
fio --name=latency-test --rw=randread --bs=4k --numjobs=1 \
    --iodepth=1 --size=100M --runtime=5 --filename=/dev/sdb \
    --ioengine=libaio --direct=1 &
sleep 5
echo 0 > /sys/kernel/tracing/tracing_on

# Extract functions with latency > 1ms
awk '/[0-9]+\.[0-9]+ ms/ {
    match($0, /([0-9]+\.[0-9]+) ms/, arr);
    if (arr[1]+0 > 1.0) print $0
}' /sys/kernel/tracing/trace
```

## Section 2: Event Tracing

### 2.1 Static Trace Events

Linux has thousands of pre-defined trace points (tracepoints) embedded in kernel code. These are the most efficient way to trace specific subsystem behavior.

```bash
# List all available event subsystems
ls /sys/kernel/tracing/events/
# alarmtimer block btrfs cgroup compaction dma_fence drm exceptions
# ext4 fib fib6 filemap ftrace huge_memory i2c irq jbd2 kmem kvm
# migrate mmc module napi net oom pagemap power raw_syscalls ...

# List events in a subsystem
ls /sys/kernel/tracing/events/block/
# block_bio_backmerge  block_bio_bounce  block_bio_complete
# block_bio_frontmerge block_bio_queue   block_bio_remap
# block_dirty_buffer   block_getrq       block_io_done
# block_io_start       block_plug        block_rq_complete
# block_rq_insert      block_rq_issue    block_rq_merge
# block_rq_requeue     block_unplug      enable  filter

# Enable all block events
echo 1 > /sys/kernel/tracing/events/block/enable

# Enable only specific events
echo 1 > /sys/kernel/tracing/events/block/block_rq_issue/enable
echo 1 > /sys/kernel/tracing/events/block/block_rq_complete/enable
```

### 2.2 Filtering Events

```bash
# View available fields for an event
cat /sys/kernel/tracing/events/block/block_rq_issue/format
# name: block_rq_issue
# ID: 1234
# format:
#         field:unsigned char common_type;        offset:0; size:1; signed:0;
#         field:unsigned char common_flags;       offset:1; size:1; signed:0;
#         field:dev_t dev;                        offset:8; size:4; signed:0;
#         field:sector_t sector;                  offset:16; size:8; signed:0;
#         field:unsigned int nr_sector;           offset:24; size:4; signed:0;
#         field:unsigned int bytes;               offset:28; size:4; signed:0;
#         field:char rwbs[8];                     offset:32; size:8; signed:0;
#
# print fmt: "%d,%d %s %u (%s) %llu + %u [%s]", ...

# Filter: only trace write requests larger than 512KB
echo 'rwbs ~ "*W*" && bytes > 524288' > \
    /sys/kernel/tracing/events/block/block_rq_issue/filter

# Filter by specific device (major:minor)
# /dev/sdb is typically 8:16
echo 'dev == 0x810' > \
    /sys/kernel/tracing/events/block/block_rq_issue/filter
```

### 2.3 Scheduler Event Analysis

```bash
# Enable scheduler events for context switch and wakeup analysis
echo 1 > /sys/kernel/tracing/events/sched/sched_switch/enable
echo 1 > /sys/kernel/tracing/events/sched/sched_wakeup/enable
echo 1 > /sys/kernel/tracing/events/sched/sched_wakeup_new/enable
echo 1 > /sys/kernel/tracing/events/sched/sched_migrate_task/enable

# Filter to specific PID
echo 'next_pid == 12345 || prev_pid == 12345' > \
    /sys/kernel/tracing/events/sched/sched_switch/filter

# Set PID filter globally
echo 12345 > /sys/kernel/tracing/set_event_pid

echo 1 > /sys/kernel/tracing/tracing_on
sleep 5
echo 0 > /sys/kernel/tracing/tracing_on

# Parse scheduler output
cat /sys/kernel/tracing/trace | awk '
/sched_switch/ {
    # Extract fields
    match($0, /prev_comm=(\S+) prev_pid=([0-9]+).*next_comm=(\S+) next_pid=([0-9]+)/, arr)
    print arr[1], "->", arr[3], "(pid:", arr[4] ")"
}' | sort | uniq -c | sort -rn | head -20
```

### 2.4 Memory Event Tracing

```bash
# Trace page allocation failures
echo 1 > /sys/kernel/tracing/events/kmem/mm_page_alloc_extfrag/enable
echo 1 > /sys/kernel/tracing/events/vmscan/mm_vmscan_direct_reclaim_begin/enable
echo 1 > /sys/kernel/tracing/events/vmscan/mm_vmscan_direct_reclaim_end/enable
echo 1 > /sys/kernel/tracing/events/compaction/mm_compaction_begin/enable
echo 1 > /sys/kernel/tracing/events/compaction/mm_compaction_end/enable

echo 1 > /sys/kernel/tracing/tracing_on
# Simulate memory pressure
stress-ng --vm 4 --vm-bytes 90% --timeout 10s
echo 0 > /sys/kernel/tracing/tracing_on

# Measure compaction latency
awk '
/mm_compaction_begin/ { start = $3; sub(/:/, "", start) }
/mm_compaction_end/   { end = $3; sub(/:/, "", end); printf "Compaction: %.3f ms\n", (end - start) * 1000 }
' /sys/kernel/tracing/trace
```

## Section 3: trace-cmd

### 3.1 trace-cmd Fundamentals

`trace-cmd` is a user-space tool that provides a clean interface to ftrace, handles CPU-affinity for the tracing thread, manages buffer overflow, and produces binary `.dat` files suitable for analysis.

```bash
# Install trace-cmd
apt-get install trace-cmd   # Debian/Ubuntu
dnf install trace-cmd       # RHEL/CentOS/Fedora

# Record block I/O events for 10 seconds
trace-cmd record \
    -e block:block_rq_issue \
    -e block:block_rq_complete \
    -p function_graph \
    --max-graph-depth 4 \
    -g blk_mq_submit_bio \
    sleep 10

# The output file is trace.dat

# Read and display the trace
trace-cmd report trace.dat | head -100

# Report with latency histogram for block I/O
trace-cmd report -l trace.dat

# Show only specific events
trace-cmd report trace.dat -l | grep 'block_rq'
```

### 3.2 trace-cmd Record Patterns

```bash
# Pattern 1: Trace a specific command
trace-cmd record \
    -e syscalls:sys_enter_read \
    -e syscalls:sys_exit_read \
    -e syscalls:sys_enter_write \
    -e syscalls:sys_exit_write \
    -- dd if=/dev/zero of=/tmp/test bs=4096 count=10000 conv=fsync

# Pattern 2: Trace with function filter
trace-cmd record \
    -p function \
    -l 'tcp_*' \
    -e net:net_dev_queue \
    -e net:net_dev_xmit \
    -T \
    sleep 5

# Pattern 3: Trace specific PID
MYPID=$(pgrep -x nginx | head -1)
trace-cmd record \
    -p function_graph \
    -P "$MYPID" \
    --max-graph-depth 6 \
    -e sched:sched_switch \
    sleep 5

# Pattern 4: Multi-CPU buffer management
trace-cmd record \
    -b 65536 \         # Buffer size per CPU in KB
    -e block \
    -e ext4 \
    sleep 30

# Pattern 5: Split output for large recordings
trace-cmd record \
    -e block \
    --date \
    -m 1000 \          # Split every 1000 MB
    sleep 300
```

### 3.3 trace-cmd stat and Analysis

```bash
# Show buffer statistics after recording
trace-cmd stat

# Stack trace for specific events
trace-cmd record \
    -e kmem:mm_page_alloc \
    --func-stack \
    -e slab:kmalloc \
    sleep 5

trace-cmd report trace.dat | head -200

# Profile: count function invocations
trace-cmd record -p function -F -- nginx -t
trace-cmd report trace.dat -f | \
    awk '{print $NF}' | sort | uniq -c | sort -rn | head -30

# Extract timing between two events (custom latency measurement)
trace-cmd report trace.dat -t | \
    awk '/block_rq_issue/   {ts=$1; key=$NF}
         /block_rq_complete/ {if (key==$NF) printf "%.3f ms\n", ($1-ts)*1000}'
```

### 3.4 Recording in Production

```bash
#!/usr/bin/env bash
# production-trace.sh
# Safe trace-cmd recording script for production use

set -euo pipefail

DURATION="${1:-30}"         # Seconds
OUTPUT_DIR="${2:-/var/log/traces}"
BUFFER_KB="${3:-32768}"     # 32MB per CPU

mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUTPUT_FILE="${OUTPUT_DIR}/trace-${TIMESTAMP}.dat"

log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "${OUTPUT_DIR}/trace-${TIMESTAMP}.log"; }

log "Starting ${DURATION}s trace, output: ${OUTPUT_FILE}"

# Start trace in background
trace-cmd record \
    -b "$BUFFER_KB" \
    -e block:block_rq_issue \
    -e block:block_rq_complete \
    -e ext4:ext4_sync_file_enter \
    -e ext4:ext4_sync_file_exit \
    -e sched:sched_switch \
    -e vmscan:mm_vmscan_direct_reclaim_begin \
    -e vmscan:mm_vmscan_direct_reclaim_end \
    -o "$OUTPUT_FILE" \
    sleep "$DURATION" &

TRACE_PID=$!
log "trace-cmd PID: $TRACE_PID"

wait "$TRACE_PID"
TRACE_SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
log "Trace complete. File: ${OUTPUT_FILE} (${TRACE_SIZE})"

# Generate quick summary
log "Top functions by call count:"
trace-cmd report "$OUTPUT_FILE" 2>/dev/null | \
    awk '{print $NF}' | sort | uniq -c | sort -rn | head -10

# Compress for transfer
gzip "$OUTPUT_FILE"
log "Compressed trace: ${OUTPUT_FILE}.gz"
```

## Section 4: KernelShark Visualization

### 4.1 KernelShark Installation and Basic Use

KernelShark provides a GUI for visualizing trace-cmd `.dat` files with timeline views and CPU activity plots.

```bash
# Install KernelShark
apt-get install kernelshark    # Debian/Ubuntu
dnf install kernelshark        # RHEL

# Or build from source (required for latest features)
git clone https://github.com/rostedt/kernelshark.git
cd kernelshark
mkdir build && cd build
cmake -DCMAKE_INSTALL_PREFIX=/usr/local ..
make -j$(nproc)
make install

# Open a trace file
kernelshark trace.dat

# Command-line report before visualization
kernelshark -i trace.dat --report
```

### 4.2 KernelShark Analysis Workflow

```bash
# Step 1: Record a targeted trace
trace-cmd record \
    -e sched:sched_switch \
    -e sched:sched_wakeup \
    -e block:block_rq_issue \
    -e block:block_rq_complete \
    -e irq:irq_handler_entry \
    -e irq:irq_handler_exit \
    -b 131072 \
    sleep 10

# Step 2: Quick command-line analysis
trace-cmd report trace.dat -l | \
    grep "block_rq_issue\|block_rq_complete" | \
    awk 'BEGIN{OFS="\t"}
         /block_rq_issue/   {issue[$NF] = $1}
         /block_rq_complete/{if ($NF in issue) {
             lat = ($1 - issue[$NF]) * 1000;
             printf "%.3f ms\t%s\n", lat, $NF;
             delete issue[$NF]
         }}' | sort -n | tail -20

# Step 3: Open in KernelShark for visual analysis
# In KernelShark GUI:
# - Use "Filter" to narrow to specific CPUs or PIDs
# - Use "Plugin" -> "SCHED_SWITCH" for wakeup latency visualization
# - Use "Plugin" -> "LATENCY CALC" for custom latency markers
# - Zoom with scroll wheel; navigate with arrow keys

# Step 4: Export specific time range
trace-cmd split -b 1024 -e trace.dat -o trace-slice.dat \
    12345.000000 12346.000000   # Start/end timestamp
```

### 4.3 Automated KernelShark Report Generation

```python
#!/usr/bin/env python3
# analyze-trace.py
# Parse trace-cmd report output and generate latency statistics

import subprocess
import re
import sys
from collections import defaultdict
import statistics

def parse_trace_report(dat_file):
    """Run trace-cmd report and parse I/O latency."""
    result = subprocess.run(
        ['trace-cmd', 'report', dat_file],
        capture_output=True,
        text=True,
        check=True
    )

    issue_times = {}
    latencies = []

    for line in result.stdout.splitlines():
        # Parse block_rq_issue
        m = re.search(
            r'(\d+\.\d+).*block_rq_issue.*\s(\d+),(\d+)\s',
            line
        )
        if m:
            ts = float(m.group(1))
            dev = f"{m.group(2)},{m.group(3)}"
            issue_times[dev] = ts
            continue

        # Parse block_rq_complete
        m = re.search(
            r'(\d+\.\d+).*block_rq_complete.*\s(\d+),(\d+)\s',
            line
        )
        if m:
            ts = float(m.group(1))
            dev = f"{m.group(2)},{m.group(3)}"
            if dev in issue_times:
                latency_ms = (ts - issue_times[dev]) * 1000
                latencies.append(latency_ms)
                del issue_times[dev]

    return latencies

def print_stats(latencies, name="I/O Latency"):
    if not latencies:
        print(f"No {name} data found")
        return

    sorted_lat = sorted(latencies)
    print(f"\n{name} Statistics ({len(latencies)} samples):")
    print(f"  Min:    {min(latencies):.3f} ms")
    print(f"  P50:    {sorted_lat[len(sorted_lat)//2]:.3f} ms")
    print(f"  P95:    {sorted_lat[int(len(sorted_lat)*0.95)]:.3f} ms")
    print(f"  P99:    {sorted_lat[int(len(sorted_lat)*0.99)]:.3f} ms")
    print(f"  P99.9:  {sorted_lat[int(len(sorted_lat)*0.999)]:.3f} ms")
    print(f"  Max:    {max(latencies):.3f} ms")
    print(f"  Mean:   {statistics.mean(latencies):.3f} ms")
    print(f"  StdDev: {statistics.stdev(latencies):.3f} ms")

    # Histogram
    print("\n  Latency distribution:")
    buckets = [0, 0.1, 0.5, 1, 2, 5, 10, 50, 100, float('inf')]
    bucket_labels = ['<0.1ms', '0.1-0.5ms', '0.5-1ms', '1-2ms',
                     '2-5ms', '5-10ms', '10-50ms', '50-100ms', '>100ms']
    counts = [0] * len(bucket_labels)

    for lat in latencies:
        for i in range(len(buckets) - 1):
            if buckets[i] <= lat < buckets[i + 1]:
                counts[i] += 1
                break

    for label, count in zip(bucket_labels, counts):
        pct = count / len(latencies) * 100
        bar = '#' * int(pct / 2)
        print(f"    {label:12s}: {bar:25s} {count:5d} ({pct:5.1f}%)")

if __name__ == '__main__':
    dat_file = sys.argv[1] if len(sys.argv) > 1 else 'trace.dat'
    latencies = parse_trace_report(dat_file)
    print_stats(latencies)
```

## Section 5: Advanced ftrace Techniques

### 5.1 Dynamic Events with kprobes

```bash
# Add a kprobe at a kernel function
# Trace sys_open with its filename argument
echo 'p:myprobe do_sys_openat2 filename=+0($si):string flags=%dx:x32' > \
    /sys/kernel/tracing/kprobe_events

# Verify the probe was added
cat /sys/kernel/tracing/kprobe_events

# Enable the new event
echo 1 > /sys/kernel/tracing/events/kprobes/myprobe/enable

echo 1 > /sys/kernel/tracing/tracing_on
find /etc -name "*.conf" 2>/dev/null | head -10 > /dev/null
echo 0 > /sys/kernel/tracing/tracing_on

cat /sys/kernel/tracing/trace | grep myprobe | head -20

# Clean up
echo '-:myprobe' >> /sys/kernel/tracing/kprobe_events
```

### 5.2 Histogram Triggers

```bash
# Create a histogram of I/O sizes
echo 'hist:keys=bytes:vals=hitcount:sort=bytes' > \
    /sys/kernel/tracing/events/block/block_rq_issue/trigger

echo 1 > /sys/kernel/tracing/tracing_on
# Run workload...
fio --name=test --rw=randrw --bs=512:4096 --size=512M --numjobs=4 \
    --filename=/dev/sdb --runtime=5 --ioengine=libaio --direct=1

echo 0 > /sys/kernel/tracing/tracing_on

cat /sys/kernel/tracing/events/block/block_rq_issue/hist
# # event histogram
# #
# # trigger info: hist:keys=bytes:vals=hitcount:sort=bytes:size=2048 [active]
# #
# { bytes:        512 } hitcount:      1234
# { bytes:       1024 } hitcount:       456
# { bytes:       4096 } hitcount:      8901
```

### 5.3 Synthetic Events (Cross-Event Correlation)

```bash
# Define a synthetic event to measure I/O latency
echo 'rq_start u64 sector; unsigned int bytes; char rwbs[8]' > \
    /sys/kernel/tracing/synthetic_events

echo 'rq_end u64 sector; unsigned int bytes; char rwbs[8]; u64 latency' >> \
    /sys/kernel/tracing/synthetic_events

# Create histogram that calculates per-request latency
echo 'hist:keys=sector:vals=hitcount:ts0=common_timestamp.usecs' > \
    /sys/kernel/tracing/events/block/block_rq_issue/trigger

echo 'hist:keys=sector:vals=hitcount:onmatch(block.block_rq_issue).trace(rq_end,$sector,$bytes,$rwbs,common_timestamp.usecs-$ts0)' > \
    /sys/kernel/tracing/events/block/block_rq_complete/trigger

echo 1 > /sys/kernel/tracing/events/synthetic/rq_end/enable
echo 1 > /sys/kernel/tracing/tracing_on

# Run workload
fio --name=lat --rw=randread --bs=4k --size=100M --filename=/dev/sdb \
    --ioengine=libaio --direct=1 --runtime=5

echo 0 > /sys/kernel/tracing/tracing_on

# View per-request latency from synthetic events
grep rq_end /sys/kernel/tracing/trace | \
    awk '{print $NF}' | \
    awk -F= '{print $2}' | \
    sort -n | \
    awk 'BEGIN{n=0; sum=0}
         {n++; sum+=$1; a[n]=$1}
         END{printf "N=%d Mean=%.0f P50=%.0f P99=%.0f Max=%.0f (us)\n",
             n, sum/n, a[int(n*0.5)], a[int(n*0.99)], a[n]}'
```

### 5.4 trace-cmd Agent for Remote Tracing

```bash
# On the target machine (machine to be traced)
trace-cmd agent -l 0.0.0.0 &

# On the analysis machine
trace-cmd record \
    --tsync-interval 1000 \
    -N target-host:50000 \
    -e block:block_rq_complete \
    -e sched:sched_switch \
    sleep 10

trace-cmd report trace.dat
```

## Section 6: Production Tracing Playbook

### 6.1 I/O Latency Investigation

```bash
#!/usr/bin/env bash
# io-latency-trace.sh
# Captures block I/O latency distribution for a specified duration

set -euo pipefail

DURATION="${1:-30}"
OUTPUT_DIR="${2:-/tmp/traces}"
DEVICE="${3:-}"  # Optional: filter to specific device

mkdir -p "$OUTPUT_DIR"
OUTFILE="${OUTPUT_DIR}/io-trace-$(date +%Y%m%dT%H%M%S).dat"

# Build event filter
FILTER="all"
if [[ -n "$DEVICE" ]]; then
    # Get major:minor for device
    MAJOR=$(stat -c "%t" "/dev/${DEVICE}")
    MINOR=$(stat -c "%T" "/dev/${DEVICE}")
    FILTER="dev == 0x$(printf '%x%02x' $((16#$MAJOR)) $((16#$MINOR)))"
fi

# Apply filter
if [[ "$FILTER" != "all" ]]; then
    echo "$FILTER" > /sys/kernel/tracing/events/block/block_rq_issue/filter
    echo "$FILTER" > /sys/kernel/tracing/events/block/block_rq_complete/filter
fi

# Record
trace-cmd record \
    -b 65536 \
    -e block:block_rq_issue \
    -e block:block_rq_complete \
    -o "$OUTFILE" \
    sleep "$DURATION"

echo "Trace saved to $OUTFILE"

# Immediate analysis
trace-cmd report "$OUTFILE" -l 2>/dev/null | python3 - << 'PYEOF'
import sys
import re
import statistics

issue = {}
latencies = []

for line in sys.stdin:
    m = re.search(r'(\d+\.\d+).*block_rq_issue.*sector=(\d+)', line)
    if m: issue[m.group(2)] = float(m.group(1))

    m = re.search(r'(\d+\.\d+).*block_rq_complete.*sector=(\d+)', line)
    if m and m.group(2) in issue:
        latencies.append((float(m.group(1)) - issue.pop(m.group(2))) * 1000)

if latencies:
    s = sorted(latencies)
    n = len(s)
    print(f"Samples: {n}")
    print(f"P50: {s[n//2]:.2f}ms  P95: {s[int(n*.95)]:.2f}ms  P99: {s[int(n*.99)]:.2f}ms  Max: {s[-1]:.2f}ms")
PYEOF
```

## Summary

ftrace provides a comprehensive and zero-overhead-when-inactive tracing framework directly in the Linux kernel:

1. **Function and function graph tracers** reveal call hierarchy and per-function latency without any external tools or kernel module compilation.

2. **Static trace events** are the most efficient tracing mechanism. The thousands of pre-defined tracepoints in `block/`, `sched/`, `ext4/`, `vmscan/`, and other subsystems cover the majority of production analysis scenarios.

3. **Histogram triggers** and **synthetic events** enable in-kernel statistical analysis, reducing the volume of trace data that needs to leave the kernel ring buffer.

4. **trace-cmd** provides production-safe recording with buffer overflow management, binary output, and reproducible recording workflows. Use `trace-cmd record -- command` for command-scoped traces and script-based recording for duration-based captures.

5. **KernelShark** provides timeline visualization with CPU task scheduling overlays that make scheduler preemption, migration, and wakeup latency visually obvious in a way that text traces cannot convey.

6. **kprobes** extend ftrace to any kernel function at runtime, including functions without pre-defined tracepoints. Combine with histograms for in-kernel aggregation.

The standard production workflow is: identify the subsystem of interest, enable targeted events with filters, capture 10–30 seconds of activity, analyze with trace-cmd report, and use KernelShark for visual confirmation of any anomalies found in the text analysis.
