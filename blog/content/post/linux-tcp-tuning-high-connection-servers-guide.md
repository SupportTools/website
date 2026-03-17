---
title: "Linux TCP Tuning for High-Connection Servers: Kubernetes and Beyond"
date: 2028-11-13T00:00:00-05:00
draft: false
tags: ["Linux", "TCP", "Networking", "Performance", "Kubernetes"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux TCP tuning for high-connection-count servers including TIME_WAIT management, connection queue tuning, keepalive configuration, socket buffer sizing, BBR congestion control, and Kubernetes-specific considerations."
more_link: "yes"
url: "/linux-tcp-tuning-high-connection-servers-guide/"
---

A server handling tens of thousands of simultaneous connections will hit Linux kernel defaults that were designed for office workstations, not production services. TIME_WAIT exhaustion, connection queue drops, undersized socket buffers, and inefficient congestion control all degrade performance under load. This guide covers every meaningful TCP tuning parameter, why each matters, and how to apply them safely in both bare-metal and Kubernetes environments.

<!--more-->

# Linux TCP Tuning for High-Connection Servers: Kubernetes and Beyond

## Understanding the TCP Connection Lifecycle

Before tuning, understand what states connections pass through:

```
Client                          Server
  |                               |
  |------- SYN ------------------>| SYN_RECV (in SYN backlog)
  |<------ SYN+ACK ---------------|
  |------- ACK ------------------>| ESTABLISHED (in accept queue)
  |                               |
  |<===== data exchange ==========>|
  |                               |
  |------- FIN ------------------>| FIN_WAIT_1
  |<------ ACK ------------------|
  |<------ FIN ------------------|  LAST_ACK
  |------- ACK ------------------>|
  |         TIME_WAIT (2*MSL)     |  CLOSED
  |         (2 minutes default)   |
```

The TIME_WAIT state on the client side (or server side for server-initiated closes) holds the connection for 2*MSL (Maximum Segment Lifetime = 60 seconds by default = 120 second wait). This prevents confusion if delayed packets from the old connection arrive at a reused port.

## Diagnosing Connection State Problems

```bash
# Count connections per state
ss -s
# Output:
# Total: 45231
# TCP:   44821 (estab 38000, closed 2100, orphaned 200, timewait 4521)

# Detailed breakdown by state
ss -tan | awk '{print $1}' | sort | uniq -c | sort -rn
# 38000 ESTAB
#  4521 TIME-WAIT
#  2100 CLOSE-WAIT
#   200 FIN-WAIT-1

# Find CLOSE_WAIT connections (server not calling close())
ss -tan state close-wait | head -20

# Connection queue depth (SYN backlog overflow)
netstat -s | grep -i "SYNs to LISTEN"
# or
cat /proc/net/netstat | awk '/TcpExt/ {print}' | tr ' ' '\n' | grep -A1 ListenOverflow

# Check if accept queue is full (application not calling accept() fast enough)
ss -lntp | grep :8080
# State  Recv-Q Send-Q Local Address:Port
# LISTEN 512    511    0.0.0.0:8080
# Recv-Q > 0 on LISTEN means the accept queue is backing up
```

## TIME_WAIT Tuning

### tcp_tw_reuse (Safe to Enable)

`tcp_tw_reuse` allows a new outgoing connection to reuse a TIME_WAIT socket if the sequence numbers are safe (using timestamps). This is safe because:
- It only affects outgoing connections (client-side)
- It requires TCP timestamps to be enabled (they are by default)
- The kernel validates sequence numbers before reuse

```bash
# Check current value
sysctl net.ipv4.tcp_tw_reuse

# Enable (persistent)
cat >> /etc/sysctl.d/99-tcp-tuning.conf <<EOF
# Allow reuse of TIME_WAIT sockets for new outgoing connections
# Safe: requires timestamps, only applies to outgoing connections
net.ipv4.tcp_tw_reuse = 1
EOF

sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

### tcp_tw_recycle (DO NOT USE — Removed in Kernel 4.12)

`tcp_tw_recycle` was a dangerous option that caused connection drops behind NAT (which is every Kubernetes pod). It was removed in Linux 4.12. If you see this in old guides or configurations, remove it.

```bash
# Verify it doesn't exist on modern kernels
sysctl net.ipv4.tcp_tw_recycle 2>&1
# sysctl: cannot stat /proc/sys/net/ipv4/tcp_tw_recycle: No such file or directory
# Good — it's gone
```

### Local Port Range

Increase the ephemeral port range so clients can establish more simultaneous outgoing connections:

```bash
# Default: 32768-60999 (~28000 ports)
cat /proc/sys/net/ipv4/ip_local_port_range

# Expand to ~55000 ports
echo "net.ipv4.ip_local_port_range = 10000 65535" >> /etc/sysctl.d/99-tcp-tuning.conf
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

When combined with `tcp_tw_reuse`, each local port can be reused for a new connection ~60 seconds after the previous connection closes, effectively giving you far more than 55,000 simultaneous connections from a single source IP.

## Connection Queue Tuning

The kernel maintains two queues per listening socket:

1. **SYN queue** (incomplete connections, in SYN_RECV state): `tcp_max_syn_backlog`
2. **Accept queue** (completed three-way handshake, waiting for `accept()`): `somaxconn` and the backlog argument to `listen()`

```bash
# Check current limits
sysctl net.core.somaxconn
sysctl net.ipv4.tcp_max_syn_backlog

# Increase for high-traffic servers
cat >> /etc/sysctl.d/99-tcp-tuning.conf <<EOF
# Accept queue: max completed connections waiting for accept()
net.core.somaxconn = 65535

# SYN queue: max half-open connections
net.ipv4.tcp_max_syn_backlog = 65535
EOF
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

Your application must also pass a matching backlog to `listen()`:

```go
// Go: net.Listen uses the OS maximum by default since Go 1.11
// but you can verify with:
ln, err := net.Listen("tcp", ":8080")
// Internally calls listen(fd, syscall.SOMAXCONN)
```

```c
// C: explicitly pass high backlog
int server_fd = socket(AF_INET, SOCK_STREAM, 0);
bind(server_fd, (struct sockaddr*)&addr, sizeof(addr));
listen(server_fd, 65535);  // Must match or exceed somaxconn
```

## FIN Timeout Reduction

`tcp_fin_timeout` controls how long a socket in FIN_WAIT_2 state is kept before being forcibly closed. The default is 60 seconds.

```bash
# Check current
sysctl net.ipv4.tcp_fin_timeout
# net.ipv4.tcp_fin_timeout = 60

# Reduce for faster socket recycling
echo "net.ipv4.tcp_fin_timeout = 15" >> /etc/sysctl.d/99-tcp-tuning.conf
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

Combined with TIME_WAIT:
- FIN_WAIT_2 reduced from 60s to 15s
- TIME_WAIT stays at ~60s (controlled by MSL, not directly tunable in production)
- Net effect: connections are fully recycled in ~75s instead of ~120s

## TCP Keepalive Configuration

Keepalive probes detect dead connections without waiting for application-level heartbeats. Critical for long-lived connections (gRPC, database pools, WebSockets):

```bash
# How long a connection can be idle before keepalive probes start (default: 7200s = 2 hours)
sysctl net.ipv4.tcp_keepalive_time

# How often to send keepalive probes (default: 75s)
sysctl net.ipv4.tcp_keepalive_intvl

# How many probes before declaring the connection dead (default: 9)
sysctl net.ipv4.tcp_keepalive_probes

# For cloud instances where stale connections drop after 15 minutes:
cat >> /etc/sysctl.d/99-tcp-tuning.conf <<EOF
# Start keepalive probes after 60 seconds of idle
net.ipv4.tcp_keepalive_time = 60
# Send a probe every 10 seconds
net.ipv4.tcp_keepalive_intvl = 10
# Declare dead after 5 failed probes (60 + 5*10 = 110 second detection)
net.ipv4.tcp_keepalive_probes = 5
EOF
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

Enable keepalive in Go applications:

```go
import (
    "net"
    "time"
)

// net.Dial with keepalive
dialer := &net.Dialer{
    KeepAlive: 30 * time.Second,
    Timeout:   10 * time.Second,
}
conn, err := dialer.DialContext(ctx, "tcp", "backend:8080")

// HTTP client with keepalive transport
transport := &http.Transport{
    DialContext: (&net.Dialer{
        KeepAlive: 30 * time.Second,
    }).DialContext,
    MaxIdleConns:          1000,
    MaxIdleConnsPerHost:   100,
    IdleConnTimeout:       90 * time.Second,
    DisableKeepAlives:     false,
}
```

## CLOSE_WAIT Diagnosis and Fix

CLOSE_WAIT means the remote end sent FIN, but your application has not called `close()` on the socket. This is almost always an application bug, not a kernel parameter issue.

```bash
# Find processes with CLOSE_WAIT connections
ss -tanp state close-wait

# Get process holding the connection
ss -tanp state close-wait | awk '{print $NF}' | grep -oP 'pid=\K[0-9]+'

# Watch CLOSE_WAIT count over time
watch -n 1 'ss -s | grep close-wait'
```

Common causes and fixes:

```go
// BUG: forgot to close response body in HTTP client
resp, err := http.Get(url)
// Missing: defer resp.Body.Close()
// Fix:
defer resp.Body.Close()

// BUG: database connection not returned to pool
db.QueryRow("SELECT ...").Scan(&result)
// Missing: row.Close() on sql.Rows
rows, err := db.Query("SELECT ...")
defer rows.Close()  // Required

// BUG: goroutine leak holding TCP connection
// Use context with timeout for all external calls
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
conn, err := dialer.DialContext(ctx, "tcp", addr)
```

## Socket Buffer Tuning for High Throughput

Socket buffers (rmem for receive, wmem for send) limit throughput on high-latency links. The bandwidth-delay product tells you the minimum buffer size:

```
BDP = bandwidth × RTT
Example: 10 Gbps × 1ms = 10,000,000 bits = 1.25 MB
```

```bash
# Current defaults
sysctl net.core.rmem_default   # receive buffer default
sysctl net.core.wmem_default   # send buffer default
sysctl net.core.rmem_max       # receive buffer maximum
sysctl net.core.wmem_max       # send buffer maximum
sysctl net.ipv4.tcp_rmem       # TCP receive: min default max
sysctl net.ipv4.tcp_wmem       # TCP send: min default max

# Tuned values for 10GbE inter-datacenter (20ms RTT)
cat >> /etc/sysctl.d/99-tcp-tuning.conf <<EOF
# Socket buffers: min, default, max
net.core.rmem_default = 262144    # 256 KB default
net.core.rmem_max     = 134217728 # 128 MB max
net.core.wmem_default = 262144
net.core.wmem_max     = 134217728

# TCP-specific: kernel auto-tunes between min and max
net.ipv4.tcp_rmem = 4096 262144 134217728
net.ipv4.tcp_wmem = 4096 262144 134217728

# Enable TCP window scaling (needed for large buffers)
net.ipv4.tcp_window_scaling = 1

# Allow kernel to auto-tune buffer sizes
net.ipv4.tcp_moderate_rcvbuf = 1
EOF
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf
```

For intra-cluster traffic (sub-millisecond RTT), these large buffers are unnecessary and waste memory. Keep defaults for pod-to-pod traffic and tune only for inter-datacenter connections.

## BBR Congestion Control

BBR (Bottleneck Bandwidth and RTT) is a congestion control algorithm developed by Google that significantly outperforms CUBIC on lossy networks (internet-facing services, VPN tunnels):

```bash
# Check available congestion control algorithms
sysctl net.ipv4.tcp_available_congestion_control
# net.ipv4.tcp_available_congestion_control = reno cubic bbr

# Current algorithm
sysctl net.ipv4.tcp_congestion_control
# net.ipv4.tcp_congestion_control = cubic

# Enable BBR
cat >> /etc/sysctl.d/99-tcp-tuning.conf <<EOF
net.ipv4.tcp_congestion_control = bbr

# BBR works best with fq queuing discipline
net.core.default_qdisc = fq
EOF
sysctl -p /etc/sysctl.d/99-tcp-tuning.conf

# Verify
sysctl net.ipv4.tcp_congestion_control
# net.ipv4.tcp_congestion_control = bbr

# Apply fq to existing interface
tc qdisc add dev eth0 root fq
# Verify
tc qdisc show dev eth0
```

BBR improvements:
- 2-25x higher throughput on lossy networks
- 75% lower latency at bottleneck queues
- Particularly effective for large file transfers over the internet

## Complete sysctl Configuration File

```bash
cat > /etc/sysctl.d/99-tcp-production.conf <<'EOF'
# ============================================================
# Production TCP Tuning
# Last updated: 2024-01-15
# For: High-connection-count servers (>10k simultaneous)
# ============================================================

# --- TIME_WAIT and connection recycling ---
# Allow outgoing connection reuse of TIME_WAIT sockets
net.ipv4.tcp_tw_reuse = 1

# Expand ephemeral port range (~55k ports)
net.ipv4.ip_local_port_range = 10000 65535

# --- Connection queues ---
# Max completed connections waiting for accept()
net.core.somaxconn = 65535
# Max half-open (SYN received, not yet completed)
net.ipv4.tcp_max_syn_backlog = 65535

# --- Timeout reductions ---
# FIN_WAIT_2 timeout (default: 60s)
net.ipv4.tcp_fin_timeout = 15

# --- Keepalive ---
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 5

# --- Socket buffers ---
net.core.rmem_default = 262144
net.core.rmem_max     = 134217728
net.core.wmem_default = 262144
net.core.wmem_max     = 134217728
net.ipv4.tcp_rmem     = 4096 262144 134217728
net.ipv4.tcp_wmem     = 4096 262144 134217728
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_moderate_rcvbuf = 1

# --- Congestion control ---
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq

# --- Connection limiting ---
# Max sockets in any state
net.ipv4.tcp_max_tw_buckets = 2000000

# --- SYN flood protection ---
net.ipv4.tcp_syncookies = 1

# --- File descriptor limits ---
fs.file-max = 2097152
fs.nr_open  = 2097152
EOF

sysctl -p /etc/sysctl.d/99-tcp-production.conf
```

Don't forget the process-level file descriptor limit:

```bash
# /etc/security/limits.conf
cat >> /etc/security/limits.conf <<EOF
* soft nofile 1048576
* hard nofile 1048576
EOF

# For systemd services, set in unit file
cat >> /etc/systemd/system/myapp.service <<EOF
[Service]
LimitNOFILE=1048576
EOF
```

## Kubernetes-Specific Considerations

### Applying Kernel Parameters to Kubernetes Nodes

Node-level sysctl changes apply to all pods on that node. Use a DaemonSet with privileged `initContainers`:

```yaml
# node-tuner-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-tcp-tuner
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-tcp-tuner
  template:
    metadata:
      labels:
        app: node-tcp-tuner
    spec:
      hostNetwork: true
      hostPID: true
      tolerations:
      - effect: NoSchedule
        operator: Exists
      initContainers:
      - name: tcp-tuner
        image: busybox:1.36
        command:
        - /bin/sh
        - -c
        - |
          sysctl -w net.ipv4.tcp_tw_reuse=1
          sysctl -w net.core.somaxconn=65535
          sysctl -w net.ipv4.tcp_max_syn_backlog=65535
          sysctl -w net.ipv4.tcp_fin_timeout=15
          sysctl -w net.ipv4.tcp_keepalive_time=60
          sysctl -w net.ipv4.tcp_keepalive_intvl=10
          sysctl -w net.ipv4.tcp_keepalive_probes=5
          sysctl -w net.ipv4.tcp_congestion_control=bbr
          echo "TCP tuning applied"
        securityContext:
          privileged: true
      containers:
      - name: pause
        image: gcr.io/google-containers/pause:3.9
        resources:
          requests:
            cpu: "1m"
            memory: "4Mi"
          limits:
            cpu: "10m"
            memory: "8Mi"
```

### Pod-Level Safe Sysctls

Some sysctls are namespaced and can be set per-pod without affecting other pods:

```yaml
# Pod spec with safe sysctls
apiVersion: v1
kind: Pod
metadata:
  name: high-connection-app
spec:
  securityContext:
    sysctls:
    # These are "safe" (namespaced) sysctls allowed by default
    - name: net.ipv4.tcp_keepalive_time
      value: "60"
    - name: net.ipv4.tcp_keepalive_intvl
      value: "10"
    - name: net.ipv4.tcp_keepalive_probes
      value: "5"
    # These require kubelet --allowed-unsafe-sysctls flag
    - name: net.ipv4.tcp_tw_reuse
      value: "1"
    - name: net.core.somaxconn
      value: "65535"
  containers:
  - name: app
    image: myapp:1.0.0
```

Enable unsafe sysctls on the node's kubelet:

```yaml
# /var/lib/kubelet/config.yaml
allowedUnsafeSysctls:
  - "net.ipv4.tcp_tw_reuse"
  - "net.core.somaxconn"
  - "net.ipv4.tcp_max_syn_backlog"
  - "net.ipv4.tcp_fin_timeout"
```

### Monitoring TCP Metrics with Prometheus

```yaml
# node-exporter scrapes /proc/net/sockstat automatically
# These metrics are available:
# node_sockstat_TCP_alloc - allocated TCP sockets
# node_sockstat_TCP_inuse - in-use TCP sockets
# node_sockstat_TCP_tw    - TIME_WAIT count
# node_sockstat_TCP_orphan - orphaned TCP sockets
```

Prometheus alert rules for TCP health:

```yaml
# prometheus-tcp-alerts.yaml
groups:
- name: tcp_health
  rules:
  - alert: HighTimeWaitCount
    expr: node_sockstat_TCP_tw > 100000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High TIME_WAIT count on {{ $labels.instance }}"
      description: "TIME_WAIT count is {{ $value }}, consider enabling tcp_tw_reuse"

  - alert: ConnectionQueueDrops
    expr: increase(node_netstat_TcpExt_ListenDrops[5m]) > 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Connection queue drops on {{ $labels.instance }}"
      description: "Connections are being dropped from the accept queue. Increase somaxconn."

  - alert: HighCloseWaitCount
    expr: node_sockstat_TCP_alloc - node_sockstat_TCP_inuse > 5000
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Potential CLOSE_WAIT accumulation"
```

## Performance Validation

Before and after tuning, measure with a load test:

```bash
# Install wrk for HTTP load testing
apt-get install -y wrk

# Before tuning
wrk -t12 -c1000 -d60s --latency http://your-server:8080/

# After tuning
wrk -t12 -c1000 -d60s --latency http://your-server:8080/

# For raw TCP connection rate testing
hping3 -S -p 8080 --flood --rand-source your-server

# Monitor connection states during load test in separate terminal
watch -n 1 'ss -s && echo "---" && ss -tan | awk "{print \$1}" | sort | uniq -c'
```

## Summary

TCP tuning for production servers follows a prioritized checklist:

1. `net.ipv4.tcp_tw_reuse = 1` — enable TIME_WAIT socket reuse (first thing to do, no downside)
2. `net.core.somaxconn = 65535` and `net.ipv4.tcp_max_syn_backlog = 65535` — expand connection queues before hitting limits
3. `net.ipv4.tcp_fin_timeout = 15` — reduce stale connection hold time
4. TCP keepalive to 60/10/5 — detect dead connections within 110 seconds instead of 2+ hours
5. BBR congestion control — significant gains for internet-facing services
6. Socket buffers — tune only for high-throughput, high-latency links
7. File descriptor limits — must increase at OS and process level

In Kubernetes, apply node-level settings via a privileged DaemonSet initContainer, and use pod-level sysctls for per-workload tuning where the application needs different settings than the rest of the node.
