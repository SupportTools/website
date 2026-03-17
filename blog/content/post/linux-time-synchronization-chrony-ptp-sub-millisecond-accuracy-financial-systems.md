---
title: "Linux Time Synchronization: chrony, PTP, and Sub-Millisecond Accuracy for Financial Systems"
date: 2030-03-23T00:00:00-05:00
draft: false
tags: ["Linux", "Time Synchronization", "chrony", "PTP", "NTP", "Financial Systems", "Kubernetes"]
categories: ["Linux", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "NTP versus PTP (IEEE 1588), chrony configuration for high accuracy time synchronization, hardware timestamping with PTP, linuxptp tools (ptp4l, phc2sys), and time sync considerations in Kubernetes for distributed tracing."
more_link: "yes"
url: "/linux-time-synchronization-chrony-ptp-sub-millisecond-accuracy-financial-systems/"
---

Accurate time synchronization is the invisible infrastructure that makes distributed systems work. Distributed tracing requires all services to agree on time to within microseconds for accurate span ordering. Financial systems have regulatory requirements (MiFID II requires microsecond timestamping for trading systems). Log correlation across hundreds of services becomes impossible when clocks drift by more than a few milliseconds. Consensus algorithms like Raft assume bounded clock skew.

Getting time right at scale requires understanding the full stack: from GNSS receivers and hardware clocks through PTP grandmasters and NTP servers to individual Linux systems running chrony. This guide covers the complete time synchronization architecture for production systems, from the fundamentals of NTP and PTP through advanced chrony configuration, hardware timestamping, and time sync management in Kubernetes.

<!--more-->

## Time Synchronization Fundamentals

### Why Time is Hard in Distributed Systems

Every computer has a hardware clock (Real Time Clock, RTC) that drifts at approximately 100 parts per million (ppm) — roughly 8.6 seconds per day. Without continuous correction, systems that started synchronized will diverge within minutes.

Time synchronization protocols correct this drift by comparing local clock readings against reference sources. The challenge is that the comparison itself takes time (network latency), introducing error into the correction. Asymmetric network delays (different latency in each direction) are the primary source of residual error in NTP.

```
NTP round-trip:
Client -> Server: t1 (client sends)
Server receives:  t2 (server receives)
Server sends:     t3 (server sends reply)
Client receives:  t4 (client receives)

Estimated offset = ((t2 - t1) - (t4 - t3)) / 2
Error = (asymmetric delay) / 2

For a 1ms asymmetric delay, NTP has 0.5ms systematic error.
```

### NTP vs PTP: When to Use Each

| Criterion | NTP (Network Time Protocol) | PTP (IEEE 1588 Precision Time Protocol) |
|-----------|-----------------------------|-----------------------------------------|
| Accuracy (typical) | 1-10ms over internet, 0.1-1ms LAN | 10-100 microseconds hardware timestamps |
| Accuracy (with hardware) | <1ms | <1 microsecond |
| Infrastructure | Software-only, widely supported | Requires hardware timestamping NICs |
| Complexity | Low | Medium-High |
| Use case | General server infrastructure | Financial trading, distributed tracing, telecom |
| Kubernetes | Standard | Specialized workloads |

## chrony: Production NTP Configuration

chrony (the replacement for ntpd in modern Linux distributions) is the recommended NTP daemon for most production systems. It handles variable network conditions better than ntpd and converges faster after network interruptions.

### Installing and Basic Configuration

```bash
# Install chrony
# RHEL/CentOS/Fedora:
dnf install -y chrony
# Debian/Ubuntu:
apt-get install -y chrony

# Start and enable
systemctl enable --now chronyd

# Check initial synchronization status
chronyc tracking
# Reference ID    : A29FB14D (time.cloudflare.com)
# Stratum         : 3
# Ref time (UTC)  : Mon Mar 23 12:00:00 2030
# System time     : 0.000000245 seconds fast of NTP time
# Last offset     : +0.000000199 seconds
# RMS offset      : 0.000001234 seconds
# Frequency       : 9.123 ppm slow
# Residual freq   : +0.001 ppm
# Skew            : 0.034 ppm
# Root delay      : 0.004800123 seconds
# Root dispersion : 0.000456789 seconds
# Update interval : 64.3 seconds
# Leap status     : Normal
```

### Production chrony Configuration

```bash
# /etc/chrony.conf - Production Configuration

# Use multiple NTP servers for redundancy and accuracy
# IBM Public NTP
server time.akamai.com iburst prefer
server time.cloudflare.com iburst
server time.google.com iburst

# AWS time server (when running on AWS EC2)
# server 169.254.169.123 prefer iburst

# Tier 1 NTP pool servers for additional redundancy
pool 0.pool.ntp.org iburst maxsources 2
pool 1.pool.ntp.org iburst maxsources 2

# Record the rate at which the system clock gains/loses time
driftfile /var/lib/chrony/drift

# Allow the system clock to be stepped in the first 3 updates
# if the offset is larger than 1 second
makestep 1.0 3

# Enable kernel synchronization of the real-time clock (RTC)
rtcsync

# Enable hardware timestamping on all interfaces that support it
hwtimestamp *

# Performance tuning: increase polling frequency for lower offset
# Default poll range is 6-10 (64-1024 seconds)
# For low-latency environments, use smaller poll interval
minpoll 4    # Minimum 16 seconds between polls
maxpoll 8    # Maximum 256 seconds between polls

# Log tracking, measurements, and statistics
logdir /var/log/chrony
log tracking measurements statistics

# Security: restrict access (deny from all except localhost by default)
# Allow network peers (if this is a local NTP server)
# allow 10.0.0.0/8
# allow 172.16.0.0/12
# allow 192.168.0.0/16

# Deny access from everything else
deny all

# Specify a local reference clock if offline operation needed
# local stratum 10

# NTP source authentication (for secure environments)
# keyfile /etc/chrony.keys
# authselectmode require
```

### Monitoring chrony Accuracy

```bash
# Detailed tracking information
chronyc tracking
# Field explanations:
# System time: current offset from NTP (want < 1ms for most systems)
# Last offset: offset at last update
# RMS offset: root mean square of offsets (measure of stability)
# Frequency: how fast/slow the local clock is
# Root delay: round-trip delay to stratum 1 server
# Root dispersion: uncertainty in time from stratum 1

# View all NTP sources and their quality
chronyc sources -v
# .-- Source mode  '^' = server, '=' = peer, '#' = local clock.
#  / .- Source state '*' = current best, '+' = combined, '-' = not combined,
#  | /             'x' = may be in error, '~' = too variable, '?' = unusable.
#  ||                                                 .- xxxx [ yyyy ] +/- zzzz
#  ||      Reachability register (octal) -.           |  xxxx = adjusted offset,
#  ||      Log2(Polling interval) --.      |          |  yyyy = measured offset,
#  ||                                \     |          |  zzzz = estimated error.
#  ||                                 |    |           \
#  MS Name/IP address         Stratum Poll Reach LastRx Last sample
#  ===============================================================================
#  ^* time.cloudflare.com           3   6   377    48  +0.456ms[+0.456ms] +/-  8ms

# View source statistics (error measurements over time)
chronyc sourcestats -v

# Check real-time offset and jitter
chronyc -h localhost ntpdata

# Verify leap second status
chronyc leapstatus

# Force immediate NTP poll (for testing)
chronyc makestep
```

### Chrony as a Local NTP Server

For large clusters, run chrony on a dedicated server as a local NTP server to reduce external NTP traffic and improve consistency:

```bash
# /etc/chrony.conf - Local NTP Server

# Upstream time sources
server time.cloudflare.com iburst prefer
server time.akamai.com iburst
server time.google.com iburst

# Allow all machines in data center subnets
allow 10.0.0.0/8
allow 172.16.0.0/12

# Serve time even if not synchronized (with high stratum)
local stratum 8

# Hardware timestamp
hwtimestamp eth0

# Tight polling
minpoll 4
maxpoll 6
```

```bash
# Configure clients to use local NTP server
# /etc/chrony.conf - Client Configuration

# Use dedicated local NTP server (highest preference)
server ntp1.internal.company.com iburst prefer
server ntp2.internal.company.com iburst

# Fall back to public NTP if local server unreachable
server time.cloudflare.com iburst

# Synchronize hardware clock
rtcsync
makestep 1.0 3
```

## PTP (IEEE 1588): Sub-Millisecond Precision

The Precision Time Protocol achieves microsecond accuracy by using hardware timestamps from the network interface card, eliminating the software stack latency that limits NTP.

### PTP Architecture

```
GPS/GNSS Receiver
       |
       v
PTP Grandmaster Clock (GM)
       |         (hardware timestamps)
    Switch A ---- Switch B  (boundary clocks)
       |
    Transparent Clock Switch (TC)
       |
  PTP-enabled NICs
       |
   Linux servers running linuxptp
```

### Hardware Timestamping Requirements

```bash
# Check if your NIC supports hardware timestamping
ethtool -T eth0
# Time stamping parameters for eth0:
# Capabilities:
#         hardware-transmit     (HWTX - NIC stamps TX in hardware)
#         software-transmit     (SWTX - OS stamps TX in software)
#         hardware-receive      (HWRX - NIC stamps RX in hardware)
#         software-receive      (SWRX - OS stamps RX in software)
#         hardware-raw-clock    (HWRAW - Access to raw clock)
# PTP Hardware Clock: 0   <- PHC index
# Hardware Transmit Timestamp Modes:
#         off
#         on                    <- Hardware TX timestamps available
# Hardware Receive Filter Modes:
#         none
#         all                   <- Hardware RX timestamps available

# NICs with hardware PTP support (common in production):
# Intel X710, X550, XXV710 (igb, i40e drivers)
# Mellanox ConnectX-4/5/6 (mlx5 driver)
# Solarflare (sfc driver)
# Broadcom BCM57xxx (bnx2x driver)

# Check PTP Hardware Clock devices
ls /dev/ptp*
# /dev/ptp0  /dev/ptp1

# Get PTP clock info
ethtool -T eth0 | grep "PTP Hardware Clock"
# PTP Hardware Clock: 0
```

### Installing linuxptp

```bash
# Install linuxptp tools
dnf install -y linuxptp
# or
apt-get install -y linuxptp

# Tools installed:
# ptp4l   - PTP boundary/ordinary clock daemon
# phc2sys - Synchronize PHC (PTP hardware clock) to system clock
# pmc     - PTP management client
# ts2phc  - Time synchronizer for PHC
# timemaster - Integration tool combining ptp4l, phc2sys, and chrony
```

### ptp4l Configuration (Ordinary Clock)

```ini
# /etc/ptp4l.conf - PTP Ordinary Clock Configuration
[global]
# Clock identity mode
clockClass              135
clockAccuracy           0xFE
offsetScaledLogVariance 0xFFFF

# Priority (lower = more likely to be master; 128 = default)
priority1               128
priority2               128

# Domain number (0-127; use consistent domain in your network)
domainNumber            0

# Logging
logLevel                6
message_tag             ptp4l

# Timestamping mode
time_stamping           hardware   # Use hardware timestamps

# Synchronization settings
# Announce interval: 2^N seconds between announce messages
logAnnounceInterval     1  # 2 seconds
# Delay request interval
logSyncInterval         0  # 1 second
# Announce receipt timeout
announceReceiptTimeout  3

# Delay mechanism
delay_mechanism         E2E  # End-to-End (most common)
# delay_mechanism       P2P  # Peer-to-Peer (faster convergence)

[eth0]
# Interface to use for PTP
```

```bash
# Start ptp4l
ptp4l -i eth0 -f /etc/ptp4l.conf

# Or as a systemd service:
cat > /etc/systemd/system/ptp4l.service << 'EOF'
[Unit]
Description=Precision Time Protocol (PTP) service
After=network.target

[Service]
Type=simple
ExecStart=/usr/sbin/ptp4l -f /etc/ptp4l.conf -i eth0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now ptp4l

# Monitor ptp4l status
ptp4l -i eth0 -m
# ptp4l[12345.123]: selected best master clock 001c73.fffe.0a1234
# ptp4l[12345.456]: port 1: UNCALIBRATED to SLAVE on MASTER_CLOCK_SELECTED
# ptp4l[12345.789]: rms   42 max  104 freq -16523 +/-  66 delay   507 +/-   2
```

### phc2sys: Synchronizing Hardware Clock to System Clock

After ptp4l synchronizes the PHC (PTP Hardware Clock) to the PTP grandmaster, phc2sys synchronizes the system clock to the PHC:

```bash
# Synchronize system clock to PHC0 after ptp4l sets it
phc2sys -s /dev/ptp0 -c CLOCK_REALTIME -n 1 -O 0 -R 256

# Options:
# -s /dev/ptp0    source: the PHC synchronized by ptp4l
# -c CLOCK_REALTIME destination: system real-time clock
# -n 1            wait for 1 clock to be synchronized
# -O 0            UTC offset 0 (using TAI if -O 37)
# -R 256          update rate in Hz

# As a systemd service:
cat > /etc/systemd/system/phc2sys.service << 'EOF'
[Unit]
Description=Synchronize system clock to PTP hardware clock
After=ptp4l.service
Requires=ptp4l.service

[Service]
Type=simple
ExecStart=/usr/sbin/phc2sys -s /dev/ptp0 -c CLOCK_REALTIME -n 1 -O 0 -R 256 -m
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now phc2sys
```

### PTP Status Monitoring

```bash
# Monitor PTP offset and quality
pmc -u -b 0 'GET CURRENT_DATA_SET'
# sending: GET CURRENT_DATA_SET
#         f3517a.fffe.092db4-0 seq 0 RESPONSE MANAGEMENT CURRENT_DATA_SET
#                 stepsRemoved     1
#                 offsetFromMaster -43
#                 meanPathDelay    545

# Get grandmaster info
pmc -u -b 0 'GET GRANDMASTER_SETTINGS_NP'

# Continuous monitoring with ptp4l
# Look for rms (root mean square of offset) in nanoseconds
# Good: rms < 1000ns (1 microsecond)
# Acceptable: rms < 10000ns (10 microseconds)
# Poor: rms > 100000ns (100 microseconds)

ptp4l -i eth0 -m 2>&1 | grep "rms"
# ptp4l[100.123]: rms    5 max   12 freq  -987 +/-   3 delay   512 +/-   1
# rms 5 nanoseconds = excellent hardware-assisted PTP sync

# Compare system clock to hardware clock
phc_ctl /dev/ptp0 cmp
# offset from CLOCK_REALTIME is -342ns
```

### Using timemaster: Integrated NTP+PTP

`timemaster` coordinates ptp4l, phc2sys, and chronyd to use PTP as an input source to the system clock with NTP as fallback:

```ini
# /etc/timemaster.conf
[timemaster]
ntp_program           chrony

[ptp4l]
interfaces            eth0
delay_mechanism       E2E
network_transport     UDPv4
time_stamping         hardware

[phc2sys]
poll_interval         2

[chrony.conf]
makestep 1 3
rtcsync
logdir /var/log/chrony

[ntp_server]
# Upstream NTP servers (fallback when PTP is unavailable)
pool time.cloudflare.com iburst
```

```bash
systemctl enable --now timemaster
journalctl -u timemaster -f
```

## Verifying Time Accuracy

### Measuring Offset with ntpdate and chronyc

```bash
# Test against multiple servers to identify the best
chronyc sources -v | head -20

# Get instantaneous offset without changing system clock
ntpdate -q time.cloudflare.com
# server 162.159.200.1, stratum 3, offset +0.000234, delay 0.01234

# Check offset from multiple servers
for server in time.cloudflare.com time.google.com time.akamai.com; do
    echo -n "$server: "
    ntpdate -q "$server" 2>&1 | grep "offset" | awk '{print $6, $7}'
done

# Use chrony to verify NTP accuracy over time
chronyc -c tracking | awk -F, '{printf "Offset: %s ms, Jitter: %s ms\n", $5*1000, $7*1000}'
```

### Continuous Time Quality Monitoring

```bash
#!/bin/bash
# monitor-time-quality.sh

LOG_FILE="/var/log/time-quality.log"
ALERT_THRESHOLD_MS=10  # Alert if offset > 10ms
JITTER_THRESHOLD_MS=5  # Alert if jitter > 5ms

while true; do
    # Get chrony tracking data (CSV format with -c flag)
    DATA=$(chronyc -c tracking)

    OFFSET_MS=$(echo "$DATA" | awk -F, '{printf "%.3f", $5 * 1000}')
    JITTER_MS=$(echo "$DATA" | awk -F, '{printf "%.3f", $7 * 1000}')
    STRATUM=$(echo "$DATA" | awk -F, '{print $10}')
    REF_SOURCE=$(echo "$DATA" | awk -F, '{print $1}')

    TIMESTAMP=$(date -u "+%Y-%m-%dT%H:%M:%SZ")
    echo "$TIMESTAMP offset_ms=$OFFSET_MS jitter_ms=$JITTER_MS stratum=$STRATUM source=$REF_SOURCE" >> "$LOG_FILE"

    # Alert on large offset
    if (( $(echo "$OFFSET_MS > $ALERT_THRESHOLD_MS || $OFFSET_MS < -$ALERT_THRESHOLD_MS" | bc -l) )); then
        logger -p daemon.warning "TIME_SYNC_ALERT: offset ${OFFSET_MS}ms exceeds threshold ${ALERT_THRESHOLD_MS}ms"
    fi

    # Alert if stratum is too high (weak time source)
    if [[ "$STRATUM" -gt 4 ]]; then
        logger -p daemon.warning "TIME_SYNC_ALERT: stratum $STRATUM is too high (source may be unreliable)"
    fi

    sleep 60
done
```

## Time Synchronization in Kubernetes

Kubernetes nodes run on Linux and rely on the host's time synchronization. Pods inherit the host time, making node-level time sync critical for distributed tracing and logging.

### Node-Level Time Sync with DaemonSet

For clusters where you cannot control the underlying OS time configuration, deploy chrony as a privileged DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: chrony-daemonset
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: chrony
  template:
    metadata:
      labels:
        app: chrony
    spec:
      # Must run on host network and as privileged to access system clock
      hostNetwork: true
      tolerations:
      - operator: Exists   # Run on all nodes including control plane
      containers:
      - name: chrony
        image: centos:8
        command:
        - /bin/bash
        - -c
        - |
          yum install -y chrony
          cat > /etc/chrony.conf << 'CONF'
          server time.cloudflare.com iburst prefer
          server time.google.com iburst
          makestep 1.0 3
          rtcsync
          hwtimestamp *
          minpoll 4
          maxpoll 6
          CONF
          chronyd -d -f /etc/chrony.conf
        securityContext:
          privileged: true   # Required for system clock access
          capabilities:
            add: ["SYS_TIME"]  # Minimum capability for time setting
        volumeMounts:
        - name: etc-chrony
          mountPath: /var/lib/chrony
      volumes:
      - name: etc-chrony
        hostPath:
          path: /var/lib/chrony
          type: DirectoryOrCreate
```

### Time Sync Monitoring in Kubernetes

```yaml
# Prometheus monitoring for time synchronization
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: time-synchronization-alerts
  namespace: monitoring
spec:
  groups:
  - name: time-sync
    rules:
    # Alert when clock offset is too large
    - alert: NodeClockSkewDetected
      expr: |
        abs(node_timex_offset_seconds) > 0.05
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.instance }} clock offset too large"
        description: "Node clock is {{ $value | humanizeDuration }} offset from NTP. Maximum allowed: 50ms."

    # Alert when NTP is not synchronized
    - alert: NodeNTPNotSynchronized
      expr: |
        node_timex_sync_status != 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Node {{ $labels.instance }} NTP not synchronized"
        description: "Node's NTP daemon is not synchronized. Distributed tracing and log correlation will be unreliable."

    # Alert when clock frequency error is too high
    - alert: NodeClockHighFrequencyError
      expr: |
        abs(node_timex_frequency_adjustment_ratio) > 500e-6
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.instance }} has high frequency error"
        description: "Clock frequency error is {{ $value | humanize }}. This indicates clock hardware issues."
```

### Distributed Tracing and Time Sync Requirements

For OpenTelemetry distributed tracing, clock skew between services causes incorrect span ordering:

```bash
# Calculate acceptable clock skew for tracing
# Spans shorter than the clock skew will appear out of order

# With NTP (1-10ms typical):
# Spans < 10ms may appear out of order
# Acceptable for most applications

# With PTP (1-100 microsecond typical):
# Spans < 100us may appear out of order
# Required for high-frequency trading, telecom, financial

# Check current skew between two hosts
ssh host1 "date +%s.%N" &
PID=$!
ssh host2 "date +%s.%N"
wait $PID
# Compare output manually or use:

# More accurate: use ntpdate to measure offset
ssh host1 "ntpdate -q host2 2>&1 | grep offset | awk '{print \$6}'"
# offset +0.000234  <- 234 microseconds offset
```

## MiFID II Compliance: Microsecond Timestamping

Financial services must comply with MiFID II/MiFIR requirements for clock synchronization:

```bash
# MiFID II clock synchronization requirements:
# - Trading venues: within 1 microsecond of UTC (GPS/PTP required)
# - Investment firms: within 1 millisecond of UTC (NTP sufficient)
# - Reporting: timestamps to microsecond granularity

# Verify microsecond timestamp capability
python3 -c "
import time
import datetime

# Check if system supports microsecond precision
ts1 = time.time_ns()
ts2 = time.time_ns()
print(f'Timestamp resolution: {ts2-ts1} nanoseconds')
print(f'Current time with microseconds: {datetime.datetime.now(datetime.UTC).isoformat()}')
"

# Test timestamp precision under load
#!/bin/bash
# Check timestamp monotonicity and resolution
for i in $(seq 1 100); do
    date +%s%N
done | awk '
NR>1 {
    diff = $1 - prev
    if (diff < 0) { nonmono++ }
    if (diff == 0) { same++ }
    total++
}
{ prev = $1 }
END {
    print "Total samples:", NR
    print "Non-monotonic:", nonmono
    print "Same value:", same
}'
```

### Logging with Accurate Timestamps

```go
// logging/timestamps.go
package logging

import (
    "fmt"
    "time"
)

// GetAccurateTimestamp returns current UTC time with nanosecond precision
// For systems with PTP synchronization
func GetAccurateTimestamp() time.Time {
    return time.Now().UTC()
}

// TimestampForMiFID formats a timestamp per MiFID II requirements
// Format: ISO 8601 with microsecond precision and timezone
func TimestampForMiFID(t time.Time) string {
    // MiFID II requires: YYYY-MM-DDThh:mm:ss.ffffff+00:00
    return t.UTC().Format("2006-01-02T15:04:05.000000-07:00")
}

// MonotonicTimestamp returns a monotonically increasing timestamp
// Uses CLOCK_MONOTONIC internally for duration calculations
func MonotonicTimestamp() time.Duration {
    return time.Since(bootTime)
}

var bootTime = time.Now()

// Example: structured log entry with accurate timestamp
type TradeEvent struct {
    Timestamp     string  `json:"timestamp"`       // Wall clock
    MonotonicNano int64   `json:"monotonic_ns"`    // For duration calculation
    EventType     string  `json:"event_type"`
    Symbol        string  `json:"symbol"`
    Price         float64 `json:"price"`
    Volume        int64   `json:"volume"`
}

func NewTradeEvent(symbol string, price float64, volume int64) *TradeEvent {
    now := GetAccurateTimestamp()
    return &TradeEvent{
        Timestamp:     TimestampForMiFID(now),
        MonotonicNano: time.Now().UnixNano(),
        Symbol:        symbol,
        Price:         price,
        Volume:        volume,
    }
}
```

## Troubleshooting Time Synchronization

### Common Issues and Diagnostics

```bash
# Issue 1: Large initial offset (> makestep threshold)
chronyc tracking | grep "System time"
# System time: 35.000000000 seconds slow of NTP time
# Solution: Force step synchronization
chronyc makestep

# Issue 2: chrony not finding a valid source
chronyc sources
# .-- Source mode
#  / .- Source state '?' = unusable
#  |                        .- xxxx [ yyyy ] +/- zzzz
# ^? 0.pool.ntp.org       0  -   0   10y   +0ns[   +0ns] +/- 1000ms

# Diagnose: check network connectivity to NTP servers
for server in time.cloudflare.com time.google.com; do
    echo -n "$server port 123: "
    nc -uzv "$server" 123 2>&1 | tail -1
done

# Issue 3: High offset jitter (unstable network path)
chronyc sourcestats
# Fields to check: NTPskew, Std Dev
# High Std Dev indicates variable network latency - consider different NTP servers

# Issue 4: Clock stepping instead of slewing (causes timestamps to go backward)
# Check if makestep is triggering too often
journalctl -u chronyd | grep "step"
# Feb 01 10:00:00 host chronyd[1234]: System clock was stepped by 0.123456 seconds

# This indicates a problem: clock is drifting faster than chrony can correct
# Solution: check for hypervisor clock issues (VM migration, live migration)

# VM-specific: check for hypervisor time correction events
dmesg | grep -i "clock\|time\|tsc\|hpet"

# Issue 5: TSC instability on multicore systems
dmesg | grep "TSC clocksource"
# [ 0.000000] tsc: Fast TSC calibration used.
# [ 0.000000] TSC deadline timer enabled

# Verify TSC is stable
cat /sys/devices/system/clocksource/clocksource0/current_clocksource
# tsc  <- Good: using TSC

# If TSC is not available or unstable
echo "hpet" > /sys/devices/system/clocksource/clocksource0/current_clocksource
# or
echo "kvm-clock" > /sys/devices/system/clocksource/clocksource0/current_clocksource
```

### Time Sync Audit Script

```bash
#!/bin/bash
# scripts/audit-time-sync.sh
# Comprehensive time synchronization audit

set -euo pipefail

echo "=== Time Synchronization Audit ==="
echo "Date: $(date -u)"
echo "Host: $(hostname)"
echo ""

echo "--- Kernel Clock Source ---"
cat /sys/devices/system/clocksource/clocksource0/current_clocksource
cat /sys/devices/system/clocksource/clocksource0/available_clocksource

echo ""
echo "--- chrony Status ---"
if systemctl is-active --quiet chronyd; then
    echo "chronyd: ACTIVE"
    chronyc tracking
    echo ""
    chronyc sources
else
    echo "chronyd: INACTIVE (WARNING)"
fi

echo ""
echo "--- PTP Status ---"
if command -v ptp4l &>/dev/null; then
    for dev in /dev/ptp*; do
        echo "PTP device: $dev"
        phc_ctl "$dev" get 2>/dev/null | head -3 || echo "  Cannot read $dev"
    done
    echo ""
    ethtool -T eth0 2>/dev/null | head -10 || echo "Hardware timestamps not available on eth0"
else
    echo "linuxptp not installed"
fi

echo ""
echo "--- Current Offset from multiple sources ---"
for server in time.cloudflare.com time.google.com pool.ntp.org; do
    printf "  %-30s: " "$server"
    ntpdate -q "$server" 2>&1 | grep "offset" | awk '{print $6, $7}' || echo "UNREACHABLE"
done

echo ""
echo "--- System Time Quality ---"
timedatectl status

echo ""
echo "--- Kernel timex parameters ---"
adjtimex --print 2>/dev/null || cat /proc/timer_list | head -30

echo ""
echo "=== Audit Complete ==="
```

## Key Takeaways

Time synchronization is a multi-layer problem that requires attention at the infrastructure, operating system, and application levels:

**Use chrony, not ntpd**: chrony converges faster, handles network interruptions better, and supports hardware timestamps. It is the default on RHEL 7+, Debian 11+, and Ubuntu 20.04+.

**Multiply your NTP sources**: A single NTP server is a single point of failure. Configure 3-5 sources from different providers (Cloudflare, Google, Amazon). chrony selects the best source and cross-validates to detect outliers.

**PTP for microsecond accuracy**: If your application requires sub-millisecond clock accuracy (financial trading, high-frequency sampling, MiFID II compliance), NTP over a network is insufficient. PTP with hardware timestamping on your NICs and switches is required.

**Hardware timestamps matter**: Enabling `hwtimestamp *` in chrony.conf, when hardware supports it, can reduce local clock offset from 1ms to under 100 microseconds even for NTP.

**Kubernetes time sync is the host's responsibility**: Pods inherit the host system time. Ensure every cluster node runs a properly configured time daemon. Monitor node time offset with `node_timex_offset_seconds` via Prometheus node exporter.

**Test your time sync before production**: The audit script and monitoring rules in this guide provide a baseline for verifying that your time synchronization is working correctly before deploying time-sensitive workloads.
