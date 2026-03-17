---
title: "Linux Process Accounting and Resource Tracking: acct, atop, and SAR"
date: 2029-10-07T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Monitoring", "acct", "atop", "SAR", "Capacity Planning"]
categories:
- Linux
- Performance
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Linux process accounting using acct, atop persistent logging, sar from sysstat, and long-term resource trend analysis for production capacity planning."
more_link: "yes"
url: "/linux-process-accounting-acct-atop-sar-resource-tracking/"
---

Knowing what your system is doing right now is table stakes. Knowing what it was doing three weeks ago at 2:47 AM when a memory alert fired is the real operational challenge. Linux provides three complementary subsystems for process-level accounting and historical resource tracking: `acct` (kernel-level process accounting), `atop` (interactive and logged system/process monitoring), and `sar` from the `sysstat` package (system activity reporting with persistent archives). Together they provide a complete picture from individual process lifecycles to month-long resource trends.

<!--more-->

# Linux Process Accounting and Resource Tracking: acct, atop, and SAR

## Why You Need More Than top and ps

`top` and `ps` are point-in-time tools. They show running processes but tell you nothing about processes that have already exited. A batch job that consumed 40 GB of RAM, ran for 90 seconds, and exited is invisible to `top`. `acct` captures its CPU time, memory, I/O, and exit code. `sar` archives 10-minute samples of CPU, memory, disk, and network for months. `atop` fills the gap between them with per-second snapshots that include per-process detail.

## Section 1: Process Accounting with acct

### What acct Records

The kernel process accounting subsystem writes a fixed-size record to a binary file (typically `/var/log/account/pacct` or `/var/account/pacct`) every time a process exits. Each record captures:

- Command name (truncated to 15 chars)
- User and group ID
- Terminal
- Start and end time
- User CPU time and system CPU time
- Elapsed real time
- Average virtual memory size
- I/O character count
- Exit status
- Flags (core dumped, killed by signal, etc.)

### Enabling Process Accounting

```bash
# Install on Debian/Ubuntu
apt-get install acct

# Install on RHEL/CentOS/Fedora
dnf install psacct

# Enable and start
systemctl enable --now psacct   # RHEL
systemctl enable --now acct     # Debian

# Manually turn on accounting to a specific file
accton /var/log/account/pacct

# Turn off
accton
```

### Reading Process Accounting Data

```bash
# List last-run commands (most recent first)
lastcomm

# Show all commands run by a specific user
lastcomm --user mmattox

# Show all invocations of a specific command
lastcomm --command python3

# Show commands on a specific terminal
lastcomm --tty pts/1

# Filter by time (requires --forwards for chronological order)
lastcomm --forwards | grep "Oct  7"
```

Example `lastcomm` output:

```
bash               mmattox  pts/0     0.01 secs Mon Oct  7 09:14:24
python3         F  mmattox  pts/0    43.72 secs Mon Oct  7 09:13:41
find               root     ??        0.88 secs Mon Oct  7 09:13:39
```

The flags in the second column:
- `F` — process used more than 1 MB of memory (fork flag)
- `S` — process ran as superuser
- `X` — process was killed by a signal
- `C` — process dumped core

### sa — Summary Accounting

`sa` aggregates the raw accounting file into summaries:

```bash
# Summary of all commands
sa

# Summary sorted by total CPU time
sa -c

# Summary sorted by number of calls
sa -n

# Show per-user summary
sa -m

# Merge current accounting data into summary file
sa -s

# Show processes that consumed more than N CPU seconds
sa -u | awk '$2 > 10 {print}'
```

Example `sa` output:

```
      1394    1094.91re    1026.40cp       0avio     18k
       142      42.17re      41.88cp       0avio     25k python3
        88       0.91re       0.78cp       0avio     22k find
        55       2.33re       1.44cp       0avio     21k bash
        ...
```

Columns: invocations, real time (seconds), CPU time (seconds), average I/O operations, average memory (kB).

### Custom Analysis of pacct Files

```bash
# Install dump-acct for raw binary inspection
# Or write your own parser using the acct(5) structure

# Python-based analysis of pacct binary
python3 - << 'EOF'
import struct
import sys
from datetime import datetime

# acct_v3 record layout (64-bit systems, comp_t fields)
ACCT_FMT = '=BBHHHiIIIIIII16s'
ACCT_SIZE = struct.calcsize(ACCT_FMT)

def comp_t_to_float(val):
    """Convert kernel comp_t encoding to float seconds."""
    exp = (val >> 13) & 0x7
    base = val & 0x1fff
    return base * (8 ** exp) / 1e6

with open('/var/log/account/pacct', 'rb') as f:
    high_cpu = []
    while chunk := f.read(ACCT_SIZE):
        if len(chunk) < ACCT_SIZE:
            break
        fields = struct.unpack(ACCT_FMT, chunk)
        command = fields[13].decode('ascii', errors='replace').rstrip('\x00')
        cpu_time = comp_t_to_float(fields[7]) + comp_t_to_float(fields[8])
        if cpu_time > 5.0:
            high_cpu.append((cpu_time, command, fields[2]))  # cpu, cmd, uid

high_cpu.sort(reverse=True)
print("Top CPU-consuming processes:")
for cpu, cmd, uid in high_cpu[:20]:
    print(f"  {cpu:8.2f}s  uid={uid:5d}  {cmd}")
EOF
```

### acct in Containers

`acct` requires kernel-level support (`CONFIG_BSD_PROCESS_ACCT`). In containerized environments, process accounting runs at the host level and records all container processes. The command name is the container process name, not the container name. Supplement with `/proc` inspection for container attribution:

```bash
# Find which container a PID belongs to
cat /proc/<PID>/cgroup | grep -o 'docker/[a-f0-9]*' | head -1
```

## Section 2: atop — Persistent Detailed Monitoring

`atop` provides second-by-second snapshots of system and process activity. Its daemon mode writes compressed binary logs that can be replayed interactively for postmortem analysis.

### Installation and Daemon Setup

```bash
# Install
apt-get install atop           # Debian/Ubuntu
dnf install atop               # RHEL/Fedora

# The atop package installs a systemd service
systemctl enable --now atop

# Default log interval is 600 seconds (10 minutes)
# Logs are stored in /var/log/atop/atop_YYYYMMDD

# Change interval to 60 seconds
vim /etc/default/atop
# Set: INTERVAL=60

systemctl restart atop
```

### Interactive atop Usage

```bash
# Open current live view
atop

# Open a historical log file
atop -r /var/log/atop/atop_20291007

# Jump to a specific time within a log
atop -r /var/log/atop/atop_20291007 -b 14:30:00

# Replay at 2x speed
atop -r /var/log/atop/atop_20291007 -f 2
```

Inside atop's interactive mode, key bindings:

| Key | View |
|-----|------|
| `t` | Next sample |
| `T` | Previous sample |
| `g` | Generic process info (default) |
| `m` | Memory details per process |
| `d` | Disk I/O per process |
| `n` | Network per process (needs netatop) |
| `c` | Full command line |
| `u` | Per-user summary |
| `p` | Per-program summary |
| `1`-`9` | Sort by column |
| `/` | Search process by name |

### atop's System Summary Lines

atop displays system-level resource lines at the top:

```
PRC | sys 0.24s  | user 1.84s | #proc 412 | #trun 3    | #tslp 349  | #zombie 0
CPU | sys  3%    | user 11%   | irq  0%   | idle 83%   | wait 3%    | steal 0%
CPL | avg1 1.43  | avg5 1.21  | avg15 0.98| csw 72841  | intr 48291 | numcpu 8
MEM | tot 15.5G  | free 1.2G  | cache 8.4G| buff 321M  | slab 648M  | hptot 0
SWP | tot  4.0G  | free 3.9G  |           |            | vmcom 12.1G| vmlim 11.7G
DSK | sda        | busy 28%   | read 1204 | write 893  | avio 2.1ms |
NET | transport  | tcpi 4821  | tcpo 4936 | udpi  120  | udpo  89   |
NET | network    | ipi 5049   | ipo 5143  | ipfrw 0    | deliv 5049 |
NET | eth0       | pcki 5140  | pcko 5230 | sp 1 Gbps  | si 4.2M    | so 8.1M
```

### Command-Line atop Reporting

```bash
# Report CPU usage by process, 5-second intervals, 12 samples
atop -P CPU 5 12

# Report memory anomalies (processes with >100MB RSS)
atop -r /var/log/atop/atop_20291007 -P MEM | awk '$9 > 102400 {print}'

# Extract disk I/O summary from a historical log
atop -r /var/log/atop/atop_20291007 -P DSK 1 | head -100

# Generate CSV of CPU usage for graphing
atop -r /var/log/atop/atop_20291007 -P CPU -b 00:00:00 | \
  awk 'NR>1 {print $1, $5, $6, $7}' > cpu_usage.csv
```

### Parsing atop Log Data

```bash
# Use atopsar for summary reporting from atop logs
atopsar -r /var/log/atop/atop_20291007 -A

# CPU report
atopsar -r /var/log/atop/atop_20291007 -c

# Memory report
atopsar -r /var/log/atop/atop_20291007 -m

# Disk I/O report
atopsar -r /var/log/atop/atop_20291007 -d

# Network report
atopsar -r /var/log/atop/atop_20291007 -i eth0
```

### Finding the Root Cause of a Past Incident

```bash
# Step 1: Find the time window of interest
atopsar -r /var/log/atop/atop_20291007 -c | grep -E "([89][0-9]|100)%" | head -20

# Step 2: Open the log at that time
atop -r /var/log/atop/atop_20291007 -b 14:23:00

# Step 3: Sort by CPU (press '1') to find the culprit process
# Step 4: Press 'c' to see the full command line
# Step 5: Press 'm' to examine its memory usage
```

## Section 3: SAR from sysstat

`sar` (System Activity Reporter) is part of the `sysstat` package. A cron job or systemd timer runs `sa1` every 10 minutes to collect samples and `sa2` once daily to generate text reports. Data is stored in `/var/log/sysstat/` (Debian) or `/var/log/sa/` (RHEL) as compressed binary files.

### Installation and Configuration

```bash
# Debian/Ubuntu
apt-get install sysstat
# Enable data collection
sed -i 's/ENABLED="false"/ENABLED="true"/' /etc/default/sysstat
systemctl enable --now sysstat

# RHEL/CentOS/Fedora
dnf install sysstat
systemctl enable --now sysstat
```

Configuration in `/etc/sysstat/sysstat`:

```bash
# How long to keep data files (days)
HISTORY=365

# Compressed data files
COMPRESSAFTER=10

# sadc parameters (what to collect)
SADC_OPTIONS="-S DISK,XDISK,SNMP,IPV6"
```

### Real-Time sar Monitoring

```bash
# CPU utilization, 2-second intervals, 10 samples
sar 2 10

# Memory statistics
sar -r 2 10

# Swap usage
sar -S 2 10

# Disk I/O
sar -d 2 10

# Network interface statistics
sar -n DEV 2 10

# TCP statistics
sar -n TCP 2 10

# Load average and run queue
sar -q 2 10
```

### Reading Historical Data

```bash
# Today's CPU data
sar -u

# Yesterday's data
sar -u -1

# Specific date
sar -u -f /var/log/sysstat/sa07  # October 7th

# Time range
sar -u -s 14:00:00 -e 16:00:00 -f /var/log/sysstat/sa07
```

### Comprehensive Resource Report

```bash
#!/bin/bash
# daily-sar-report.sh — Generate a human-readable resource report

DATE=${1:-$(date +%d)}
SA_FILE="/var/log/sysstat/sa${DATE}"

if [ ! -f "$SA_FILE" ]; then
    echo "No data file: $SA_FILE"
    exit 1
fi

echo "===== CPU Report ====="
sar -u -f "$SA_FILE" | tail -5

echo ""
echo "===== Memory Report ====="
sar -r -f "$SA_FILE" | tail -5

echo ""
echo "===== Swap Report ====="
sar -S -f "$SA_FILE" | tail -5

echo ""
echo "===== Top Disk Devices by %util ====="
sar -d -f "$SA_FILE" | awk 'NF>1 && /dev/ {print $NF, $0}' | sort -rn | head -10

echo ""
echo "===== Network Interface Throughput ====="
sar -n DEV -f "$SA_FILE" | awk 'NF>6 && !/IFACE/ && !/Average/ && $3!="0.00" {print}' | \
    sort -k5 -rn | head -10

echo ""
echo "===== TCP Connection States ====="
sar -n TCP -f "$SA_FILE" | tail -5

echo ""
echo "===== Load Average ====="
sar -q -f "$SA_FILE" | tail -5
```

### sar Output Interpretation

```
# CPU output: sar -u
12:00:01 AM  CPU  %user  %nice  %system  %iowait  %steal  %idle
12:10:01 AM  all  15.23   0.00     3.47     8.91    0.00   72.39
12:20:01 AM  all  82.14   0.00     4.12     0.32    0.00   13.42  <-- CPU spike
12:30:01 AM  all  18.77   0.00     3.91     2.15    0.00   75.17
```

Key fields:
- `%iowait` above 20%: disk I/O bottleneck
- `%steal` above 5%: noisy neighbor on virtualized host
- `%idle` near 0 with low `%iowait`: CPU-bound workload

```
# Memory output: sar -r
12:00:01 AM  kbmemfree  kbavail  kbmemused  %memused  kbbuffers  kbcached  kbcommit  %commit  kbactive   kbinact
12:10:01 AM    1245632  9234512    5123456     80.42     234512   4123456   8923456    70.12   4512345   3123456
```

- `%memused` trending upward day over day: memory leak
- `kbcommit` > total RAM + swap: overcommit risk

### Long-Term Trend Analysis

```bash
# Extract peak daily CPU usage for the last 30 days
for day in $(seq -w 1 30); do
    SA_FILE="/var/log/sysstat/sa${day}"
    [ -f "$SA_FILE" ] || continue
    PEAK=$(sar -u -f "$SA_FILE" | awk '/^Average/ {print 100-$8}')
    echo "Day $day: Peak CPU ${PEAK}%"
done

# Weekly memory trend
for week in 0 1 2 3; do
    START=$(date -d "-$((week*7+7)) days" +%m/%d)
    END=$(date -d "-$((week*7)) days" +%m/%d)
    echo "Week $START to $END:"
    # sar doesn't span files easily; use sadf for this
    sadf -d /var/log/sysstat/sa$(date -d "-$((week*7+3)) days" +%d) -- -r | \
        awk -F';' 'NR>1 {sum+=$5; count++} END {printf "  Avg %%memused: %.1f\n", sum/count}'
done
```

### sadf — Machine-Readable Output

```bash
# Export to CSV for external analysis
sadf -d /var/log/sysstat/sa07 -- -u > cpu_data.csv

# Export to JSON
sadf -j /var/log/sysstat/sa07 -- -u > cpu_data.json

# Export to XML
sadf -x /var/log/sysstat/sa07 -- -u > cpu_data.xml
```

## Section 4: Integrated Capacity Planning

### Building a Baseline

```bash
#!/bin/bash
# baseline.sh — Collect 30-day resource baseline

OUTPUT_DIR="/var/reports/baseline/$(date +%Y%m)"
mkdir -p "$OUTPUT_DIR"

echo "Collecting 30-day resource baseline..."

# CPU percentiles
sadf -d /var/log/sysstat/sa* -- -u 2>/dev/null | \
    awk -F';' 'NR>1 && $6!="" {idle+=$6; count++; if($6<min || min=="") min=$6} \
    END {printf "CPU: avg=%.1f%% peak=%.1f%% samples=%d\n", (100-idle/count), (100-min+0), count}' \
    > "$OUTPUT_DIR/cpu_baseline.txt"

# Memory trend
sadf -d /var/log/sysstat/sa* -- -r 2>/dev/null | \
    awk -F';' 'NR>1 && $8!="" {used+=$8; count++; if($8>max) max=$8} \
    END {printf "Memory: avg=%.1f%% peak=%.1f%% samples=%d\n", used/count, max, count}' \
    > "$OUTPUT_DIR/mem_baseline.txt"

echo "Baseline written to $OUTPUT_DIR"
cat "$OUTPUT_DIR/cpu_baseline.txt"
cat "$OUTPUT_DIR/mem_baseline.txt"
```

### Alerting on Trend Violations

```bash
#!/bin/bash
# trend-alert.sh — Alert if current week average exceeds prior week by threshold

THRESHOLD=20  # Percent increase triggers alert
SLACK_WEBHOOK="https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"

current_week_cpu() {
    local total=0 count=0
    for i in $(seq 0 6); do
        local safile="/var/log/sysstat/sa$(date -d "-${i} days" +%d)"
        [ -f "$safile" ] || continue
        local idle=$(sar -u -f "$safile" | awk '/^Average/ {print $8}')
        total=$(echo "$total + (100 - $idle)" | bc)
        ((count++))
    done
    [ $count -gt 0 ] && echo "scale=1; $total / $count" | bc || echo "0"
}

prior_week_cpu() {
    local total=0 count=0
    for i in $(seq 7 13); do
        local safile="/var/log/sysstat/sa$(date -d "-${i} days" +%d)"
        [ -f "$safile" ] || continue
        local idle=$(sar -u -f "$safile" | awk '/^Average/ {print $8}')
        total=$(echo "$total + (100 - $idle)" | bc)
        ((count++))
    done
    [ $count -gt 0 ] && echo "scale=1; $total / $count" | bc || echo "0"
}

CURRENT=$(current_week_cpu)
PRIOR=$(prior_week_cpu)

INCREASE=$(echo "scale=1; ($CURRENT - $PRIOR) / $PRIOR * 100" | bc 2>/dev/null)

if [ $(echo "$INCREASE > $THRESHOLD" | bc 2>/dev/null) -eq 1 ]; then
    curl -s -X POST "$SLACK_WEBHOOK" \
        -H 'Content-type: application/json' \
        -d "{\"text\": \"CPU trend alert on $(hostname): week-over-week increase of ${INCREASE}% (prior=${PRIOR}%, current=${CURRENT}%)\"}"
fi
```

### Correlating acct, atop, and sar Data

When investigating a past performance event:

1. **sar** shows the time window when CPU/memory/disk spiked
2. **atop** shows which processes were running during that window
3. **acct** shows which processes *completed* during or just after that window and what resources they consumed

```bash
# Correlate a 2pm memory event on Oct 7

# Step 1: sar confirms memory spike at 14:10
sar -r -f /var/log/sysstat/sa07 -s 13:50:00 -e 14:30:00

# Step 2: atop shows what was running at 14:10
atop -r /var/log/atop/atop_20291007 -b 14:10:00
# Press 'm' to sort by memory

# Step 3: acct shows which commands completed between 14:00 and 14:20
lastcomm --forwards | awk '
BEGIN {found=0}
/Oct  7 14:[01][0-9]/ {found=1; print}
found && /Oct  7 14:2/ {exit}
'
```

## Section 5: Production Deployment Considerations

### Log Rotation and Retention

```bash
# /etc/logrotate.d/acct
/var/log/account/pacct {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        if [ -x /usr/sbin/accton ]; then
            accton /var/log/account/pacct
        fi
    endscript
}
```

```bash
# atop cleanup - keep 60 days of logs
# /etc/cron.daily/atop-cleanup
find /var/log/atop -name 'atop_*' -mtime +60 -delete
```

### Storage Estimates

| Tool | Interval | Daily Storage | Monthly Storage |
|------|----------|---------------|-----------------|
| acct | per-exit | 50-500 KB | 1.5-15 MB |
| atop | 60s | 10-50 MB | 300 MB - 1.5 GB |
| sar | 600s | 2-5 MB | 60-150 MB |

Atop's 60-second interval on a busy system with many processes can produce sizable logs. Tune the interval to match your retention budget.

### Security Considerations

Process accounting data contains command names and arguments. This can inadvertently capture passwords passed as command-line arguments (a bad practice, but it happens). Restrict access to accounting files:

```bash
chmod 640 /var/log/account/pacct
chown root:adm /var/log/account/pacct

chmod 750 /var/log/atop
chown root:adm /var/log/atop
```

## Conclusion

`acct`, `atop`, and `sar` form a comprehensive process and resource accounting stack for Linux production systems. `acct` provides forensic-level visibility into individual process lifecycles that disappear from view the moment they exit. `atop` provides interactive postmortem analysis of historical system state with per-process detail at configurable granularity. `sar` provides the long-term statistical baseline necessary for capacity planning and trend-based alerting. Used together with correlated timestamps, they eliminate the blind spots that leave operators guessing about past events.
