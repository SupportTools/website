---
title: "Linux NTP and Chrony: Time Synchronization for Distributed Systems"
date: 2031-05-17T00:00:00-05:00
draft: false
tags: ["Linux", "NTP", "Chrony", "Time Synchronization", "Kubernetes", "PTP", "Distributed Systems"]
categories:
- Linux
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux time synchronization covering Chrony vs ntpd for modern Linux, chrony.conf configuration, NTP server hierarchy, Kubernetes node time requirements, PTP for sub-microsecond accuracy, and diagnosing time drift."
more_link: "yes"
url: "/linux-ntp-chrony-time-synchronization-distributed-systems/"
---

Time synchronization is infrastructure plumbing that receives attention only when it breaks — and when it breaks in a distributed system, the consequences range from mysterious authentication failures to split-brain cluster scenarios to corrupted database transactions. TLS certificates expire immediately. Kerberos tokens reject valid authentications. Distributed consensus algorithms (Raft, Paxos) produce nonsensical results. Log correlation becomes impossible.

Chrony replaced ntpd as the recommended NTP implementation on modern Linux for good reasons: faster initial synchronization, better accuracy under variable network conditions, and graceful handling of the system clock discontinuities that virtualized environments produce constantly. This guide covers the complete time synchronization stack for production infrastructure.

<!--more-->

# Linux NTP and Chrony: Time Synchronization for Distributed Systems

## Section 1: Chrony vs ntpd Architecture

### 1.1 Why Chrony Replaced ntpd

`ntpd` (from the reference NTP implementation) has been the standard since the 1980s. Chrony was designed to address its limitations in modern environments:

| Feature | ntpd | chrony |
|---|---|---|
| Initial sync time | Minutes to hours | Seconds |
| Clock step behavior | Refuses to step > 1000s by default | Configurable makestep |
| VM/container support | Poor (skips synchronization during suspend) | Handles resume correctly |
| Network accuracy | Requires stable network | Handles variable latency |
| Hardware timestamping | Limited | Full PTP hardware clock support |
| Memory footprint | Higher | Lower |
| Active development | Maintenance mode | Active |

### 1.2 Architecture Comparison

```
ntpd Architecture:
  System Clock ←→ ntpd daemon ←→ Network NTP servers
  (monolithic, all modes handled by single daemon)

chrony Architecture:
  chronyd: Background daemon that manages clock adjustment
  chronyc: Client to query and control chronyd

  System Clock ←→ chronyd ←→ Reference sources:
                              ├── NTP servers (UDP 123)
                              ├── Hardware clocks (PPS, PTP)
                              ├── Reference clocks (GPS, IRIG-B)
                              └── Local clock (fallback)
```

## Section 2: Installing and Configuring Chrony

### 2.1 Installation

```bash
# RHEL/CentOS/Fedora (pre-installed in RHEL 7+)
dnf install chrony

# Ubuntu/Debian (default in Ubuntu 18.04+)
apt-get install chrony

# Check if chrony is already running
systemctl status chronyd
chronyc tracking

# Disable ntpd if running
systemctl stop ntpd
systemctl disable ntpd
systemctl mask ntpd

# Enable and start chrony
systemctl enable --now chronyd
```

### 2.2 chrony.conf Configuration

The default configuration is usually adequate for development but requires tuning for production:

```bash
# /etc/chrony.conf (or /etc/chrony/chrony.conf on Debian/Ubuntu)

# NTP servers - use pool directive for geographic distribution
# pool pool.ntp.org iburst prefer maxsources 4

# For enterprise: use internal NTP servers first, public as fallback
server ntp1.corp.example.com iburst prefer
server ntp2.corp.example.com iburst prefer
server ntp3.corp.example.com iburst
# Public fallback
pool 0.pool.ntp.org iburst
pool 1.pool.ntp.org iburst
pool 2.pool.ntp.org iburst

# Use specific stratum 1 servers for better accuracy
# server time.google.com iburst
# server time.cloudflare.com iburst

# Drift file: stores measured drift of hardware clock
driftfile /var/lib/chrony/drift

# Log file
logdir /var/log/chrony
log measurements statistics tracking

# Allow clock step on startup (first three adjustments, max 1 second)
makestep 1.0 3

# Enable kernel synchronization of the real-time clock (RTC)
rtcsync

# Lock memory to prevent paging
lock_all

# Command access control
# Allow chronyc connections from localhost only
bindcmdaddress 127.0.0.1
bindcmdaddress ::1

# Allow NTP client access from local network (if this is a stratum 2 server)
# allow 10.0.0.0/8
# allow 172.16.0.0/12
# allow 192.168.0.0/16

# NTP server mode for local clients
# local stratum 10  # Only used as last resort

# Hardware timestamp for better accuracy (if supported)
# hwtimestamp eth0

# Minimum number of selectable sources required for time sync
# minsources 2

# Step the clock if offset > 1 second (during initial sync only)
# After that, only slew
initstepslew 30 ntp1.corp.example.com
```

### 2.3 Tuning for Low-Latency Environments

For precision-critical applications (financial systems, Kubernetes etcd, distributed databases):

```bash
# /etc/chrony.conf - High-precision configuration

server ntp1.corp.example.com iburst prefer minpoll 4 maxpoll 6 polltarget 30
server ntp2.corp.example.com iburst prefer minpoll 4 maxpoll 6 polltarget 30
server ntp3.corp.example.com iburst minpoll 4 maxpoll 6

driftfile /var/lib/chrony/drift
rtcsync
makestep 1.0 3

# Aggressive polling (check time every 16s-64s instead of minutes)
# minpoll 4 = 2^4 = 16 seconds minimum poll interval
# maxpoll 6 = 2^6 = 64 seconds maximum poll interval

# Use hardware timestamps if available (significantly improves accuracy)
hwtimestamp *

# Reduce random jitter in polling
maxdistance 1.5

# Maximum offset before logging a warning
maxoffset 0.1

# Smoothing for step-free clock adjustments when switching sources
smoothtime 400 0.001 leaponly
```

### 2.4 Configuring an Internal NTP Server Hierarchy

For enterprise environments, set up a stratum hierarchy:

```
Stratum 0: GPS/Atomic clocks (hardware)
     │
Stratum 1: Your NTP appliances or servers with GPS
     │
Stratum 2: Your internal NTP servers (serving the organization)
     │
Stratum 3: Workstations, servers, Kubernetes nodes
```

**Stratum 2 server configuration:**

```bash
# /etc/chrony.conf on your internal NTP stratum 2 servers

# Upstream stratum 1 sources
server ntp1.example.com iburst prefer
server ntp2.example.com iburst prefer
# Google's stratum 1 servers
server time1.google.com iburst
server time2.google.com iburst
server time3.google.com iburst
server time4.google.com iburst

# Drift file
driftfile /var/lib/chrony/drift
rtcsync

# Enable NTP server mode for internal clients
allow 10.0.0.0/8
allow 172.16.0.0/12
allow 192.168.0.0/16

# Require at least 2 sources before serving
minsources 2

# Better accuracy settings
hwtimestamp *
minpoll 4
maxpoll 6

# Stratum should be automatically calculated from upstream
# local stratum 2  # Uncomment if you want to serve even when upstream unreachable
```

## Section 3: Monitoring Time Synchronization

### 3.1 chronyc Diagnostic Commands

```bash
# Overall synchronization status
chronyc tracking
# Reference ID    : 0A000002 (10.0.0.2)
# Stratum         : 3
# Ref time (UTC)  : Mon May 16 12:00:00 2031
# System time     : 0.000001234 seconds slow of NTP time
# Last offset     : -0.000000567 seconds
# RMS offset      : 0.000003456 seconds
# Frequency       : 1.234 ppm slow
# Residual freq   : -0.001 ppm
# Skew            : 0.012 ppm
# Root delay      : 0.000456 seconds
# Root dispersion : 0.000123 seconds
# Update interval : 64.2 seconds
# Leap status     : Normal

# List time sources and their status
chronyc sources -v
# .-- Source mode  '^' = server, '=' = peer, '#' = local clock.
# / .- Source state '*' = synced, '+' = combined, '-' = excluded, '?' = unreachable
# | /             .- xxxx [ yyyy ] +/- zzzz
# | |           /    ms         ms    ms
# | |          |- Reach LastRx Last sample
# MS Name/IP address         Stratum Poll Reach LastRx Last sample
# =========================================================================
# ^* ntp1.corp.example.com       2   6   377    21   +0.2ms[+0.2ms] +/- 1.5ms
# ^+ ntp2.corp.example.com       2   6   377    23   -0.1ms[-0.1ms] +/- 1.6ms
# ^- time1.google.com            1   6   377    22   -5.2ms[-5.2ms] +/-  37ms

# Source symbols:
# * = currently selected source
# + = combined with selected source
# - = excluded (too far from cluster)
# ? = unreachable

# Detailed source statistics
chronyc sourcestats -v
# Name/IP Address            NP  NR  Span  Frequency  Freq Skew  Offset  Std Dev
# ntp1.corp.example.com      14   8  865m  -0.012 ppm   0.012 ppm  +42ns  84ns
# ntp2.corp.example.com       9   5  584m  +0.034 ppm   0.018 ppm -123ns  97ns

# Current clock details
chronyc makestep  # Force immediate time step (use with caution in production)
chronyc burst 4/8  # Take 4 measurements from first 8 sources

# Check NTP daemon config
chronyc ntpdata ntp1.corp.example.com
```

### 3.2 Diagnosing Time Drift

```bash
# Check system clock offset from hardware clock
hwclock --verbose
# delta between system and hardware clock

# Check if time is being stepped or slewed
journalctl -u chronyd --since "1 hour ago" | grep -E "step|slew|offset|sync"

# Watch clock adjustment in real-time
watch -n1 'chronyc tracking | grep -E "System time|Last offset|Frequency"'

# Check NTP reachability
chronyc sources | grep '^\^'
# If all sources show '?' in state column, NTP is unreachable

# Test specific server reachability
chronyc -a ntpdata ntp1.corp.example.com

# Compare with another server's time
ntpdate -q ntp1.corp.example.com
# Results: server 10.0.0.2, stratum 2, offset 0.000123, delay 0.000456

# Check if firewall is blocking NTP
# NTP uses UDP port 123
nc -u -z ntp1.corp.example.com 123
tcpdump -i eth0 -nn 'port 123'
```

### 3.3 Prometheus Monitoring for Chrony

```yaml
# Use chrony-exporter for Prometheus
# Install: go install github.com/SuperQ/chrony_exporter@latest
# Or use the packaged version

# chrony-exporter as systemd service
cat > /etc/systemd/system/chrony-exporter.service << 'EOF'
[Unit]
Description=Prometheus Chrony Exporter
After=network.target chronyd.service

[Service]
User=nobody
ExecStart=/usr/local/bin/chrony_exporter \
  --collector.tracking \
  --collector.sources \
  --collector.sources.all \
  --web.listen-address=:9123
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now chrony-exporter
```

```yaml
# prometheus-rules-ntp.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ntp-time-sync-alerts
  namespace: monitoring
spec:
  groups:
    - name: time-sync
      rules:
        - alert: SystemClockOutOfSync
          expr: |
            abs(chrony_tracking_system_time_seconds) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "System clock on {{ $labels.instance }} is out of sync by {{ $value | humanizeDuration }}"

        - alert: SystemClockLargeOffset
          expr: |
            abs(chrony_tracking_system_time_seconds) > 1.0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "System clock on {{ $labels.instance }} has drifted >1 second from NTP"
            description: "Time offset: {{ $value }}s. This will cause certificate and authentication failures."

        - alert: NTPSourcesUnreachable
          expr: |
            chrony_sources_reachability == 0
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "No reachable NTP sources on {{ $labels.instance }}"

        - alert: NTPSourcesSyncLow
          expr: |
            count by (instance) (chrony_sources_poll >= 0 and chrony_sources_reachability > 0) < 2
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Only {{ $value }} NTP source(s) reachable on {{ $labels.instance }}"

        - alert: ClockFrequencyDriftHigh
          expr: |
            abs(chrony_tracking_frequency_error_ppm) > 100
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "High clock frequency drift on {{ $labels.instance }}: {{ $value }} ppm"
```

## Section 4: Kubernetes Node Time Synchronization

### 4.1 Why Kubernetes Needs Precise Time

Several Kubernetes components depend on accurate system time:

- **etcd**: Raft leader election uses timeouts; skewed clocks cause unnecessary leader elections
- **API server**: Certificate validity checks, token expiration
- **Kubelet**: Pod scheduling, node conditions, eviction decisions
- **Ingress**: TLS certificate validation
- **Metrics**: Prometheus timestamps, log correlation
- **Applications**: Distributed tracing, ordered event logs, idempotency keys

```bash
# Check time synchronization status on a Kubernetes node
kubectl debug node/node-1 -it --image=busybox:1.36 -- sh
# Inside the debug pod:
date
chronyc tracking 2>/dev/null || ntpdate -q pool.ntp.org

# From outside: check via node shell
# (DaemonSet approach for production)

# Clock check DaemonSet
cat > clock-check-daemonset.yaml << 'EOF'
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: clock-checker
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: clock-checker
  template:
    metadata:
      labels:
        app: clock-checker
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists
      containers:
        - name: checker
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              while true; do
                offset=$(chronyc tracking 2>/dev/null | grep "System time" | awk '{print $4}')
                echo "$(hostname): NTP offset=${offset}s at $(date -u)"
                sleep 60
              done
          securityContext:
            privileged: true
          volumeMounts:
            - name: host
              mountPath: /host
      volumes:
        - name: host
          hostPath:
            path: /
EOF
```

### 4.2 Fixing Time Sync on Kubernetes Nodes

```bash
# On the Kubernetes node (via SSH or node shell)

# Check if chrony is running
systemctl status chronyd

# If not running, install and configure
dnf install chrony  # or apt-get install chrony

cat > /etc/chrony.conf << 'EOF'
# Use internal NTP servers first
server ntp1.corp.example.com iburst prefer
server ntp2.corp.example.com iburst prefer
pool pool.ntp.org iburst

driftfile /var/lib/chrony/drift
rtcsync
makestep 1.0 3
logdir /var/log/chrony
log tracking
EOF

systemctl enable --now chronyd

# Force immediate sync if offset is large
chronyc makestep
chronyc burst 4/8

# Verify
chronyc tracking
```

### 4.3 Cloud Provider Time Source

Cloud providers recommend using their internal metadata service as NTP source:

**AWS EC2:**
```bash
# AWS recommends Amazon Time Sync Service
# server 169.254.169.123  # IPv4 (available in all regions)
# server fd00:ec2::123    # IPv6

# Add to /etc/chrony.conf BEFORE other servers
cat > /etc/chrony.conf << 'EOF'
# AWS Time Sync Service (recommended first source)
server 169.254.169.123 prefer iburst
# Plus public NTP as backup
pool pool.ntp.org iburst

driftfile /var/lib/chrony/drift
rtcsync
makestep 1.0 3

# Specify local source for AWS Nitro instance accuracy
# refclock PHC /dev/ptp0 poll 2 dpoll -2 offset 0  # For PTP hardware clock
EOF
```

**GCP Compute Engine:**
```bash
# GCP provides metadata.google.internal as NTP
server metadata.google.internal iburst prefer
```

**Azure:**
```bash
# Azure uses the hypervisor clock
server time.windows.com iburst prefer
```

### 4.4 Container Time Synchronization

Containers share the host's system clock. No NTP daemon runs inside containers:

```bash
# In a container, time comes from the host
date  # Shows host time

# If you need to verify container time matches host:
# The /proc/timer_list shows clock ticks

# For containers that need local time handling:
# Mount the timezone file
docker run -v /etc/localtime:/etc/localtime:ro myapp

# In Kubernetes:
spec:
  volumes:
    - name: localtime
      hostPath:
        path: /etc/localtime
  containers:
    - name: app
      volumeMounts:
        - name: localtime
          mountPath: /etc/localtime
          readOnly: true
```

## Section 5: PTP — Precision Time Protocol

For sub-microsecond accuracy requirements (telecom, financial trading, high-frequency operations):

### 5.1 PTP Architecture

PTP (IEEE 1588) achieves far better accuracy than NTP by:
1. Using hardware timestamps at the network interface level
2. Using a two-step exchange to measure one-way delay
3. Running at higher frequency than NTP

```
PTP Hierarchy:
  Grandmaster Clock (GPS-backed hardware, stratum 0)
       │ PTP messages (UDP or Ethernet)
  Boundary Clock (switch with PTP support)
       │
  Ordinary Clock (server with PTP hardware clock)
  (sub-microsecond accuracy achievable)
```

### 5.2 Setting Up PTP with linuxptp

```bash
# Install linuxptp
apt-get install linuxptp
# or
dnf install linuxptp

# Check if network interface supports hardware timestamps
ethtool -T eth0
# Time stamping parameters for eth0:
# Capabilities:
#         hardware-transmit     (SOF_TIMESTAMPING_TX_HARDWARE)
#         hardware-receive      (SOF_TIMESTAMPING_RX_HARDWARE)
#         hardware-raw-clock    (SOF_TIMESTAMPING_RAW_HARDWARE)

# Start PTP client (ptp4l)
# -i eth0: use this interface
# -m: print messages to stdout
# -s: slave only mode (don't become master)
ptp4l -i eth0 -m -s -f /etc/ptp4l.conf

# Sync system clock to PTP hardware clock (phc2sys)
phc2sys -s /dev/ptp0 -c CLOCK_REALTIME -w -m

# Configuration file
cat > /etc/ptp4l.conf << 'EOF'
[global]
priority1              128
priority2              128
domainNumber           0
slaveOnly              1
clockServoType         pi
clockClass             135
clockAccuracy          0xFE
offsetScaledLogVariance 0xFFFF
free_running           0
freq_est_interval      1
dscp_event             0
dscp_general           0
masterOnly             0
gmCapable              0
announceReceiptTimeout  3
syncReceiptTimeout      0
delayRespReceiptTimeout  3
operLogSyncInterval    0
operLogPdelayReqInterval 0
egressLatency          0
ingressLatency         0
boundary_clock_jbod    0

[eth0]
egressLatency          0
ingressLatency         0
tsproc_mode            filter
delay_filter           moving_median
delay_filter_length    10
boundary_clock_jbod    0
network_transport      UDPv4
delay_mechanism        E2E
time_stamping          hardware
EOF
```

### 5.3 Combining PTP and Chrony

The recommended approach for precision timing on Linux systems:

```bash
# /etc/chrony.conf with PTP hardware clock
# 1. ptp4l syncs the PTP hardware clock to the network grandmaster
# 2. phc2sys syncs the system clock to the PTP hardware clock
# OR use chrony as a phc2sys replacement:

# Have chrony use the PTP hardware clock as a reference
refclock PHC /dev/ptp0 poll 2 dpoll -2 offset 0

# NTP as fallback only (lower priority)
server ntp1.corp.example.com iburst minpoll 6 maxpoll 10

driftfile /var/lib/chrony/drift
rtcsync
makestep 0.1 3

# Hardware timestamps
hwtimestamp eth0

logdir /var/log/chrony
log tracking measurements statistics
```

### 5.4 Checking PTP Status

```bash
# Check ptp4l status
pmc -u -b 0 'GET CURRENT_DATA_SET'
# portIdentity              000a35.fffe.0000003-1
# logMessageInterval        0
# meanPathDelay             1234 nanoseconds
# offsetFromMaster          -45 nanoseconds  (<-- offset in nanoseconds!)
# logSyncInterval           0

# Get master clock info
pmc -u -b 0 'GET TIME_STATUS_NP'
# clockIdentity             000a35.fffe.0000001-1
# master_offset             -23 nanoseconds
# ingress_time              1620000000000000000 nanoseconds
# cumulativeScaledRateOffset +0.0e+00 s/s
# scaledLastGmPhaseChange   0
# gmTimeBaseIndicator       0
# lastGmPhaseChange         0x0000'0000000000000000.0000
# gmPresent                 true
# gmIdentity                004096.fffe.000001

# Monitor offset over time
while true; do
  pmc -u -b 0 'GET CURRENT_DATA_SET' 2>/dev/null | grep offsetFromMaster
  sleep 1
done
```

## Section 6: Diagnosing Time-Related Production Issues

### 6.1 TLS Certificate Failures

```bash
# Certificate validity check requires accurate time
# "Certificate has expired or is not yet valid" can mean:
# 1. Certificate actually expired
# 2. System clock is in the past (cert not yet valid)
# 3. System clock is in the future (cert already expired from its perspective)

# Check current system time vs certificate validity
openssl s_client -connect api.example.com:443 -servername api.example.com 2>/dev/null | \
  openssl x509 -noout -dates
# notBefore=Jan 1 00:00:00 2031 GMT
# notAfter=Jan 1 00:00:00 2032 GMT

# Compare with system time
date -u
# Mon May 16 12:00:00 UTC 2031  <- Should be between notBefore and notAfter

# If time is wrong
chronyc makestep
```

### 6.2 Kerberos Authentication Failures

```bash
# Kerberos requires clocks within 5 minutes of KDC
# "KRB_AP_ERR_SKEW" = clock skew too large

# Check Kerberos clock requirement
klist -k  # List keytab
kinit user@REALM.COM  # If this fails with "Clock skew too great"

# Fix: resync clock
chronyc makestep
# Verify
kinit user@REALM.COM  # Should now work

# In krb5.conf, the max tolerance is configurable
# /etc/krb5.conf
# [libdefaults]
#   clockskew = 300  # 5 minutes (default)
```

### 6.3 Distributed Database Consistency

```bash
# CockroachDB, YugabyteDB, and similar systems require clock skew < their uncertainty window
# CockroachDB default: max-offset 500ms
# Cassandra: snitch requires < 5 minute skew for consistency

# Check node skew in CockroachDB
cockroach debug zipcode --url="postgresql://root@localhost:26257?sslmode=disable" ./zipdir

# Check Cassandra gossip and repair issues from clock skew
nodetool status  # All nodes should show UN (Up Normal) not UN with skew warnings

# etcd time requirements
# etcd leadership election heartbeat: 100ms default
# etcd election timeout: 1000ms default
# Clock skew should be << 100ms for reliable etcd operation

# Check etcd leader status
ETCDCTL_API=3 etcdctl \
  --endpoints=https://etcd1:2379,https://etcd2:2379,https://etcd3:2379 \
  --cacert=/etc/etcd/ca.crt \
  --cert=/etc/etcd/client.crt \
  --key=/etc/etcd/client.key \
  endpoint status --write-out=table
```

### 6.4 Chrony Leap Second Handling

Leap seconds are added or removed from UTC occasionally. They can cause single-second discontinuities:

```bash
# Check leap second status
chronyc tracking | grep "Leap status"
# Leap status     : Normal  (no upcoming leap second)
# Leap status     : Insert second  (leap second will be inserted)
# Leap status     : Delete second  (leap second will be deleted)

# chrony handles leap seconds via kernel smearing (recommended)
# Add to chrony.conf:
leapsecmode slew  # Slew over the leap second instead of stepping
smoothtime 400 0.001 leaponly  # Smooth time adjustments for leap second only

# This prevents the 1-second clock step that can cause:
# - Database transaction issues
# - Log timestamp confusion
# - Certificate validation edge cases
```

### 6.5 Production Time Audit Script

```bash
#!/bin/bash
# time-audit.sh
# Run on each node to assess time synchronization health

echo "=== Time Synchronization Audit for $(hostname) ==="
echo "Date: $(date -u)"
echo ""

echo "--- System Clock ---"
date -u
echo ""

echo "--- Chrony Status ---"
if command -v chronyc &>/dev/null; then
  chronyc tracking
  echo ""
  echo "--- NTP Sources ---"
  chronyc sources
  echo ""
  echo "--- Source Statistics ---"
  chronyc sourcestats
else
  echo "chrony not installed"
fi

echo ""
echo "--- Hardware Clock ---"
if command -v hwclock &>/dev/null; then
  hwclock --verbose 2>&1 | grep -E "Hardware|System time|drift"
fi

echo ""
echo "--- System Timezone ---"
timedatectl show --property=Timezone --value
echo ""

echo "--- NTP Synchronization Status ---"
timedatectl show --property=NTPSynchronized --value

echo ""
echo "--- Kernel Clock Info ---"
adjtimex -p 2>/dev/null || true

echo ""
echo "--- Recent Time-Related Kernel Messages ---"
dmesg | grep -i "clock\|time\|ntp\|ptp\|rtc" | tail -10

echo ""
echo "Audit complete."
```

Time synchronization is the foundation that every distributed system stands on. A 100ms clock skew is invisible to humans but catastrophic to Raft consensus algorithms. A 1-second clock skew causes TLS authentication failures. A 5-minute skew breaks Kerberos. Configure Chrony with multiple sources, monitor clock offset with Prometheus alerts, and treat time synchronization failures as P1 incidents — because in a distributed system, they effectively are.
