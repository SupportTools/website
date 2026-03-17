---
title: "Linux Time Synchronization: PTP, NTP, and Chrony for Distributed Systems"
date: 2030-08-30T00:00:00-05:00
draft: false
tags: ["Linux", "NTP", "PTP", "Chrony", "Distributed Systems", "Kubernetes", "Time Sync"]
categories:
- Linux
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise time synchronization guide covering chrony configuration, stratum management, PTP hardware timestamping for sub-microsecond accuracy, Kubernetes node clock synchronization, debugging time skew, and why accurate time matters for distributed consensus."
more_link: "yes"
url: "/linux-time-synchronization-ptp-ntp-chrony-distributed-systems/"
---

Accurate time synchronization is foundational to distributed systems correctness. Distributed databases use timestamps for conflict resolution and causality tracking. TLS certificate validation depends on correct system clocks. Kubernetes etcd relies on bounded clock skew for leader election safety. Distributed tracing systems require time accuracy to reconstruct event ordering across service boundaries. When clocks drift, the failure modes range from subtle data corruption to complete service unavailability. This post covers the full time synchronization stack from chrony NTP configuration through PTP hardware timestamping, with a focus on Kubernetes deployments where clock management is both critical and easy to overlook.

<!--more-->

## Why Time Accuracy Matters for Distributed Systems

Before configuring time synchronization, understand the failure modes time skew causes in production:

**TLS Certificate Validation**: TLS clients reject certificates if `notBefore` is in the future or `notAfter` is in the past relative to the system clock. A node with a clock 5 minutes fast will reject certificates that are valid everywhere else.

**etcd Leader Election**: etcd uses Raft, which requires bounded network latency relative to election timeouts. While Raft does not strictly require synchronized clocks, etcd's heartbeat and election timeout calculations assume bounded message delivery time. A node with a significantly fast clock may expire elections prematurely.

**Kubernetes Certificate Rotation**: The kubelet, kube-apiserver, and etcd all use time-based certificate issuance and renewal. cert-manager's certificate renewal schedule depends on system time.

**Database Conflict Resolution**: CockroachDB, YugabyteDB, and Google Spanner use HLC (Hybrid Logical Clocks) or True Time. These systems add uncertainty bounds to timestamps and require clocks to be within 500ms (CockroachDB default) or 7ms (Spanner TrueTime) of each other.

**Distributed Tracing**: Trace spans from different services are stitched together based on timestamps. A 100ms clock difference between services makes cross-service latency calculations meaningless.

**Log Correlation**: Correlating events from multiple services during incident investigation requires timestamps to be synchronized within milliseconds.

## NTP vs PTP: Accuracy Comparison

| Protocol | Typical Accuracy | Hardware Support | Use Case |
|----------|------------------|-----------------|----------|
| NTP (ntpd) | 10–100 ms | No | Legacy, avoid for new deployments |
| NTP (chrony) | 1–10 ms | No | General-purpose, cloud VMs |
| PTP (IEEE 1588) software | 100 μs – 1 ms | No | Network-attached equipment without HW |
| PTP (IEEE 1588) hardware | 10 ns – 1 μs | Yes (NICs + switches) | Financial, telecom, HPC |

For most Kubernetes workloads, chrony with well-configured NTP sources provides sufficient accuracy. For high-frequency trading, real-time database replication, and 5G infrastructure, PTP with hardware timestamping is required.

## Chrony: Modern NTP for Production Linux

Chrony is the NTP implementation of choice for modern Linux distributions. It handles intermittent connectivity better than ntpd, converges faster after boot, and provides better accuracy on virtual machines.

### Installing Chrony

```bash
# RHEL/Rocky/AlmaLinux
dnf install -y chrony

# Ubuntu/Debian
apt-get install -y chrony

# Verify installation
chronyd --version
```

### Production chrony.conf Configuration

```conf
# /etc/chrony.conf

# === NTP Sources ===
# Use organization's internal NTP servers (Stratum 2 or better)
server ntp1.infra.example.com iburst prefer
server ntp2.infra.example.com iburst prefer
server ntp3.infra.example.com iburst

# Fallback to well-known public NTP pools
pool 0.rhel.pool.ntp.org iburst
pool 1.rhel.pool.ntp.org iburst

# === Source Configuration ===
# iburst: Send 8 packets at startup for faster initial sync
# maxsources: Use up to 4 sources for redundancy
maxsources 4

# === Drift File ===
# Stores the measured frequency error for faster recovery after restart
driftfile /var/lib/chrony/drift

# === Stepping and Slewing ===
# makestep: If offset > 1.0s, step immediately on startup (up to 3 times)
# After the first 3 steps, only slew (gradual correction)
makestep 1.0 3

# For VMs that may have large jumps during live migration, use a larger threshold
# makestep 10 -1  # Always step (use only during initial setup)

# === Leap Second Handling ===
leapsectz right/UTC

# === RTC ===
# Maintain the hardware clock from NTP time
rtcsync

# === Security ===
# Bind the NTP client to localhost only (not a server)
bindaddress 127.0.0.1

# === Logging ===
# Log tracking stats for performance analysis
logdir /var/log/chrony
log tracking measurements statistics

# === Access Control ===
# Deny all clients (this host is a client, not a server)
deny all

# Allow localhost monitoring
allow 127.0.0.1/32

# === Refclocks (for PTP hardware, see below) ===
# refclock PHC /dev/ptp0 poll 0 dpoll -2 offset 0

# === Tuning ===
# maxdistance: Maximum allowed root distance (stratum weight)
maxdistance 1.5

# minsamples/maxsamples: Number of samples to keep per source
minsamples 6
maxsamples 64

# smoothtime: Smooth time adjustments to reduce impact on applications
# 400 seconds window, leaponly false
# smoothtime 400 0.001 leaponly
```

### Chrony as an NTP Server for Internal Network

For organizations with multiple Kubernetes clusters, run internal NTP servers that themselves sync to GPS-locked primary sources:

```conf
# /etc/chrony.conf on NTP servers (Stratum 2 servers)

# === Primary Time Sources ===
# GPS-disciplined Stratum 1 sources
server gps-ntp1.example.com iburst prefer
server gps-ntp2.example.com iburst prefer

# NIST servers as fallback
server time.nist.gov iburst

# === Server Configuration ===
# Allow cluster nodes (10.0.0.0/8) to synchronize from this server
allow 10.0.0.0/8

# Allow monitoring queries
allow 127.0.0.1/32

# === Announce stratum ===
# Degraded stratum when unsynchronized (stratum + 1 is announced)
local stratum 10

# Standard configuration
driftfile /var/lib/chrony/drift
makestep 1.0 3
rtcsync
leapsectz right/UTC
logdir /var/log/chrony
log tracking measurements statistics
```

### Monitoring Chrony Synchronization

```bash
# Check current synchronization status
chronyc tracking
# Reference ID    : 0A000001 (ntp1.infra.example.com)
# Stratum         : 3
# Ref time (UTC)  : Mon Aug 26 12:00:01 2030
# System time     : 0.000234012 seconds fast of NTP time
# Last offset     : -0.000012345 seconds
# RMS offset      : 0.000045678 seconds
# Frequency       : 2.123 ppm fast
# Residual freq   : 0.001 ppm
# Skew            : 0.045 ppm
# Root delay      : 0.023456789 seconds
# Root dispersion : 0.001234567 seconds
# Update interval : 32.4 seconds
# Leap status     : Normal

# Check configured sources and their status
chronyc sources -v
# .-- Source mode  '^' = server, '=' = peer, '#' = local clock
# / .- Source state '*' = current best, '+' = combined, '-' = not combined,
# | /             'x' = may be in error, '~' = too variable, '?' = unusable
# ||                                                 Reachability register
# ||  .-- Frequency error (ppm)                     ║   .-- Poll interval
# ||  |   .-- RMS offset                            ║   |
# ||  |   |   .-- Last sample time                  ║   |
# ||  |   |   |                                     ║   |
# 210 sources online

# Detailed source statistics
chronyc sourcestats -v

# Force immediate synchronization
chronyc makestep

# Check if NTP is synchronized (returns 0 if yes)
chronyc waitsync 10 0.01 0 1 && echo "synchronized" || echo "not synchronized"
```

### Prometheus Metrics for Chrony

Use chrony_exporter to expose chrony statistics:

```bash
# Install chrony_exporter
wget https://github.com/SuperQ/chrony_exporter/releases/download/v0.6.0/chrony_exporter-0.6.0.linux-amd64.tar.gz
tar xzf chrony_exporter-0.6.0.linux-amd64.tar.gz
install chrony_exporter /usr/local/bin/

# systemd service
cat > /etc/systemd/system/chrony-exporter.service <<'EOF'
[Unit]
Description=Chrony NTP Exporter
After=network.target chrony.service

[Service]
Type=simple
ExecStart=/usr/local/bin/chrony_exporter --collector.tracking --collector.sources
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now chrony-exporter
```

Prometheus alerting rules for time synchronization:

```yaml
groups:
  - name: time_sync
    rules:
      - alert: NTPNotSynchronized
        expr: chrony_tracking_referenceid == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "NTP not synchronized on {{ $labels.instance }}"
          description: "chrony has no reference clock on {{ $labels.instance }}"

      - alert: NTPClockOffsetHigh
        expr: abs(chrony_tracking_system_time_seconds) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "NTP clock offset > 100ms on {{ $labels.instance }}"
          description: "System time is {{ $value | humanizeDuration }} off NTP time"

      - alert: NTPClockOffsetCritical
        expr: abs(chrony_tracking_system_time_seconds) > 1.0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "NTP clock offset > 1 second on {{ $labels.instance }}"

      - alert: NTPStratumHigh
        expr: chrony_tracking_stratum > 5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "NTP stratum {{ $value }} is high on {{ $labels.instance }}"
```

## PTP (IEEE 1588 Precision Time Protocol)

PTP achieves sub-microsecond accuracy by using hardware timestamping in the NIC to eliminate software timing jitter. The PTP grandmaster clock timestamps packets at the hardware level, and PTP slaves use the hardware receive timestamps to compute precise one-way delay.

### Checking PTP Hardware Support

```bash
# Check for PTP-capable network interfaces
ethtool -T eth0
# Time stamping parameters for eth0:
# Capabilities:
#   hardware-transmit     (SOF_TIMESTAMPING_TX_HARDWARE)
#   software-transmit     (SOF_TIMESTAMPING_TX_SOFTWARE)
#   hardware-receive      (SOF_TIMESTAMPING_RX_HARDWARE)
#   software-receive      (SOF_TIMESTAMPING_RX_SOFTWARE)
#   hardware-raw-clock    (SOF_TIMESTAMPING_RAW_HARDWARE)
# PTP Hardware Clock: 0
# Hardware Transmit Timestamp Modes:
#   off                   (HWTSTAMP_TX_OFF)
#   on                    (HWTSTAMP_TX_ON)
# Hardware Receive Filter Modes:
#   none                  (HWTSTAMP_FILTER_NONE)
#   all                   (HWTSTAMP_FILTER_ALL)

# Check PTP clock device
ls /dev/ptp*
# /dev/ptp0  /dev/ptp1

# Check PHC (PTP Hardware Clock) info
phc_ctl /dev/ptp0 caps
```

### Installing and Configuring linuxptp

```bash
# Install linuxptp
dnf install -y linuxptp
# or
apt-get install -y linuxptp

# Verify installation
ptp4l --version
phc2sys --version
```

### ptp4l Configuration (PTP Boundary Clock)

```conf
# /etc/ptp4l.conf

[global]
# Run as an ordinary clock (slave to grandmaster)
clockClass              255
clockAccuracy           0xFE
offsetScaledLogVariance 0xFFFF

# Use hardware timestamping
time_stamping           hardware

# Sync interval (-3 = 8 messages/second = 0.125s)
logSyncInterval         -3
logMinDelayReqInterval  -3
logAnnounceInterval     1
announceReceiptTimeout  3

# Priority for grandmaster selection (lower = preferred)
priority1               128
priority2               128

# Domain number (0-127)
domainNumber            0

# Transport mode
network_transport       UDPv4

# Delay mechanism: E2E (end-to-end) or P2P (peer-to-peer)
delay_mechanism         E2E

# DSCP marking for PTP traffic
dscp_event              46
dscp_general            34

# Summary interval for log output
summary_interval        0

# Servo parameters
pi_proportional_const   0
pi_integral_const       0
pi_proportional_scale   0
pi_proportional_exponent -0.3
pi_proportional_norm_max 0.7
pi_integral_scale       0
pi_integral_exponent    0.4
pi_integral_norm_max    0.3
step_threshold          0.000002  # 2 microsecond step threshold
first_step_threshold    0.00002   # 20 microsecond on first sync

[eth0]
# Network interface
network_transport       UDPv4
delay_mechanism         E2E
```

```bash
# Start ptp4l as a PTP slave
systemctl enable --now ptp4l

# Monitor PTP synchronization
ptp4l -f /etc/ptp4l.conf -i eth0 -m -s
# ptp4l[100.000]: port 1: UNCALIBRATED to SLAVE on MASTER_CLOCK_SELECTED
# ptp4l[100.000]: rms   34 max   45 freq -12345 +/- 1234 delay    567 +/-  12
# ptp4l[101.000]: rms    5 max    9 freq -12340 +/-  234 delay    565 +/-   4
```

### Synchronizing the System Clock from PHC

`phc2sys` synchronizes the Linux system clock (CLOCK_REALTIME) from the PTP Hardware Clock (PHC):

```bash
# Sync system clock from PTP hardware clock
# -a: use first slave port automatically
# -r: slave to the NIC PHC
# -r: second -r means also sync RTC
phc2sys -a -rr -m

# As a systemd service
cat > /etc/systemd/system/phc2sys.service <<'EOF'
[Unit]
Description=Synchronize system clock from PTP PHC
After=ptp4l.service
Requires=ptp4l.service

[Service]
Type=simple
ExecStart=/usr/sbin/phc2sys -a -rr -m -s /dev/ptp0 -c CLOCK_REALTIME
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now phc2sys
```

### Chrony with PTP Refclock

For environments using both NTP and PTP, configure chrony to treat the PHC as a reference clock:

```conf
# /etc/chrony.conf with PTP refclock

# Use PTP hardware clock as the primary reference
refclock PHC /dev/ptp0 poll 0 dpoll -2 offset 0.000000000 delay 0.000000010

# NTP as fallback only
server ntp1.infra.example.com iburst noselect
server ntp2.infra.example.com iburst noselect

# Prefer the PHC source
maxdistance 1.0
```

## Kubernetes Node Time Synchronization

### Requirements for Kubernetes Nodes

- Clock skew between nodes should be < 100ms (etcd recommendation)
- Kubernetes uses the node's system clock for pod timestamp annotations
- cert-manager certificate operations depend on synchronized time
- Service mesh mTLS relies on certificate validity windows

### Verifying Time on All Cluster Nodes

```bash
#!/bin/bash
# check-cluster-time.sh - Compare time across all Kubernetes nodes

echo "=== Cluster Node Time Comparison ==="
echo "Local time: $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
echo ""

kubectl get nodes -o name | while read node; do
    node_name="${node#node/}"
    NODE_TIME=$(kubectl debug node/$node_name -it --image=busybox:1.36 \
        -- date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null | tail -1)
    LOCAL_TIME=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    echo "Node: $node_name | Time: $NODE_TIME"
done
```

### DaemonSet for chrony on Kubernetes Nodes

When nodes join a cluster, they inherit the host OS time configuration. Ensure chrony is running and synchronized before nodes become Ready:

```yaml
# node-chrony-check.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: chrony-check
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: chrony-check
  template:
    metadata:
      labels:
        app: chrony-check
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
      containers:
        - name: chrony-check
          image: registry.example.com/tools/chrony-monitor:latest
          command:
            - /bin/sh
            - -c
            - |
              while true; do
                # Check if chrony is synchronized
                TRACKING=$(chronyc -h /run/chrony/chrony.sock tracking 2>&1)
                OFFSET=$(echo "$TRACKING" | awk '/System time/ {print $4}')
                STATUS=$?

                if [ $STATUS -ne 0 ]; then
                  echo "ERROR: chrony not reachable"
                  exit 1
                fi

                # Convert to milliseconds for comparison
                OFFSET_MS=$(echo "$OFFSET * 1000" | bc 2>/dev/null || echo "999")
                ABS_OFFSET=${OFFSET_MS#-}

                if (( $(echo "$ABS_OFFSET > 100" | bc -l) )); then
                  echo "WARNING: Clock offset ${OFFSET_MS}ms exceeds 100ms threshold"
                else
                  echo "OK: Clock offset ${OFFSET_MS}ms"
                fi

                sleep 60
              done
          securityContext:
            privileged: false
            readOnlyRootFilesystem: true
          volumeMounts:
            - name: chrony-socket
              mountPath: /run/chrony
          resources:
            requests:
              cpu: "5m"
              memory: "16Mi"
            limits:
              cpu: "20m"
              memory: "32Mi"
      volumes:
        - name: chrony-socket
          hostPath:
            path: /run/chrony
            type: Directory
```

### Kubernetes Node Problem Detector for Time Skew

Configure the Node Problem Detector to surface time synchronization issues as Node conditions:

```yaml
# node-problem-detector-time-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-problem-detector-config
  namespace: kube-system
data:
  ntp-problem.json: |
    {
      "plugin": "custom",
      "pluginConfig": {
        "invoke_interval": "120s",
        "timeout": "30s",
        "max_output_length": 80,
        "concurrency": 1
      },
      "source": "ntp-custom-plugin",
      "metricsReporting": true,
      "conditions": [
        {
          "type": "NTPProblem",
          "reason": "NTPIsUp",
          "message": "NTP/chrony is synchronized"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "NTPProblem",
          "reason": "NTPIsDown",
          "path": "/config/plugin/check_ntp.sh"
        }
      ]
    }
  check_ntp.sh: |
    #!/bin/bash
    TRACKING=$(chronyc tracking 2>&1)
    if ! echo "$TRACKING" | grep -q "Reference ID"; then
      echo "chrony is not synchronized"
      exit 1
    fi
    OFFSET=$(echo "$TRACKING" | awk '/System time/ {print $4}' | tr -d '-')
    if (( $(echo "$OFFSET > 1.0" | bc -l) )); then
      echo "Clock offset ${OFFSET}s exceeds 1 second"
      exit 1
    fi
    exit 0
```

## Debugging Time Skew Issues

### Diagnosing NTP Synchronization Problems

```bash
# Check current chrony status in detail
chronyc -v tracking

# List sources with detailed statistics
chronyc -v sourcestats

# Check for reachability problems
chronyc sources
# '?' in status column means unreachable source

# Test connectivity to NTP server manually
ntpdate -q ntp1.infra.example.com 2>&1
# 26 Aug 12:00:01 ntpdate[12345]: adjust time server 10.0.0.1 offset -0.000234 sec

# Check network connectivity to NTP port
nc -u -w 2 ntp1.infra.example.com 123 && echo "NTP port reachable"

# Verify firewall rules allow NTP (UDP 123)
iptables -L -n | grep 123

# Check if hardware clock is sane
hwclock --show
# 2030-08-30 12:00:01.234567+00:00

# Compare hardware clock to system clock
HW=$(hwclock --show 2>/dev/null | awk '{print $1, $2}')
SYS=$(date +"%Y-%m-%d %H:%M:%S")
echo "Hardware: $HW"
echo "System:   $SYS"
```

### Common Time Synchronization Problems

**Problem: NTP server unreachable in Kubernetes**

Kubernetes nodes may have restrictive network policies or firewall rules blocking NTP (UDP/123):

```bash
# Check if iptables is blocking NTP
iptables -L -n --line-numbers | grep -E "123|ntp"

# Add rule to allow NTP (before DROP rules)
iptables -I OUTPUT -p udp --dport 123 -j ACCEPT
iptables -I INPUT -p udp --sport 123 -j ACCEPT
```

**Problem: Clock jumps on VM live migration**

During vSphere or KVM live migration, the VM clock may jump significantly when the VM resumes on a new host:

```conf
# /etc/chrony.conf - handle post-migration jumps
# Allow immediate step for large offsets (use carefully)
makestep 10 -1  # Step for any offset > 10s, unlimited times
```

**Problem: Container time differs from host**

Container time is inherited from the host kernel. If the host's system clock is wrong, all containers on that node have the wrong time. Fix the host's NTP configuration.

**Problem: etcd cluster refusing connections due to time skew**

```bash
# Check etcd clock skew
etcdctl endpoint status --cluster -w table | grep "DB Size"

# Check etcd logs for clock skew errors
journalctl -u etcd | grep -E "clock skew|timed out"
# etcd: member is rejecting peerVote because too many calls from the cluster

# On the problematic node, force chrony sync
chronyc makestep
systemctl restart etcd
```

### Measuring Real-World Clock Accuracy

```bash
#!/bin/bash
# clock-accuracy-test.sh - Measure actual clock accuracy vs NTP

NTP_SERVER="ntp1.infra.example.com"

echo "Testing clock accuracy against $NTP_SERVER..."

# Use ntpdate in query mode to measure offset
for i in $(seq 1 5); do
    RESULT=$(ntpdate -q "$NTP_SERVER" 2>&1 | tail -1)
    OFFSET=$(echo "$RESULT" | awk '{print $6}')
    echo "Sample $i: offset = $OFFSET seconds"
    sleep 2
done

echo ""
echo "chrony current offset:"
chronyc tracking | awk '/System time/ {print "  " $0}'

echo ""
echo "chrony RMS offset (historical):"
chronyc tracking | awk '/RMS offset/ {print "  " $0}'
```

## Time Zone Configuration for Kubernetes

While UTC is standard for servers, ensure consistency:

```bash
# Set system timezone to UTC on all nodes
timedatectl set-timezone UTC

# Verify
timedatectl status
# Local time: Mon 2030-08-30 12:00:01 UTC
# Universal time: Mon 2030-08-30 12:00:01 UTC
# RTC time: Mon 2030-08-30 12:00:01
# Time zone: UTC (UTC, +0000)
# System clock synchronized: yes
# NTP service: active
# RTC in local TZ: no

# For Kubernetes pods, time zone is controlled by the container image
# Mount the host /etc/localtime for pods that need it:
# (Usually not needed — pods should use UTC)
```

## Production Checklist for Time Synchronization

```bash
#!/bin/bash
# time-sync-audit.sh - Production readiness audit

PASS=0
FAIL=0
WARN=0

check() {
    local desc="$1"
    local cmd="$2"
    if eval "$cmd" &>/dev/null; then
        echo "PASS: $desc"
        ((PASS++))
    else
        echo "FAIL: $desc"
        ((FAIL++))
    fi
}

warn_check() {
    local desc="$1"
    local cmd="$2"
    if eval "$cmd" &>/dev/null; then
        echo "PASS: $desc"
        ((PASS++))
    else
        echo "WARN: $desc"
        ((WARN++))
    fi
}

check "chrony service running" "systemctl is-active chrony"
check "chrony has reference clock" "chronyc tracking | grep -v 'Reference ID.*00000000'"
check "clock offset < 100ms" "python3 -c \"
import subprocess
out = subprocess.check_output(['chronyc', 'tracking'], text=True)
for line in out.splitlines():
    if 'System time' in line:
        offset = abs(float(line.split()[3]))
        assert offset < 0.1, f'offset {offset} >= 100ms'
\""
check "stratum <= 4" "python3 -c \"
import subprocess
out = subprocess.check_output(['chronyc', 'tracking'], text=True)
for line in out.splitlines():
    if 'Stratum' in line:
        stratum = int(line.split()[2])
        assert stratum <= 4, f'stratum {stratum} > 4'
\""
check "UTC timezone configured" "timedatectl | grep -q 'Time zone: UTC'"
warn_check "at least 3 NTP sources" "chronyc sources | grep -c '^\^[*+]' | grep -qE '^[3-9]'"
warn_check "NTP hardware timestamping available" "ethtool -T eth0 | grep -q 'hardware-receive'"

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL WARN=$WARN"
[ $FAIL -eq 0 ] && exit 0 || exit 1
```

## Summary

Time synchronization is infrastructure that should be invisible but must be actively maintained. Configure chrony with multiple NTP sources at Stratum 2 or better, use internal NTP servers backed by GPS-disciplined Stratum 1 clocks for accuracy within 1–5ms across a datacenter, and monitor clock offset and stratum with Prometheus alerts. For workloads requiring sub-millisecond accuracy — real-time databases, financial systems, 5G infrastructure — deploy linuxptp with hardware timestamping and configure chrony to consume the PHC as its reference clock. On Kubernetes nodes, verify NTP synchronization during node provisioning, use the Node Problem Detector to surface time issues as node conditions, and ensure outbound UDP/123 is not blocked by network policy. Skew above 100ms begins to cause visible failures in etcd, certificate validation, and distributed database replication; addressing it proactively is far simpler than diagnosing the subtle corruption that results from ignoring it.
