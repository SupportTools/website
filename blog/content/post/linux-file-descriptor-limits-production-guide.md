---
title: "Linux File Descriptor Limits in Production: ulimit, systemd, Container Limits, and Kubernetes Troubleshooting"
date: 2028-06-16T00:00:00-05:00
draft: false
tags: ["Linux", "File Descriptors", "ulimit", "systemd", "Kubernetes", "Production", "Troubleshooting"]
categories: ["Linux", "Systems Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux file descriptor limits in production environments: ulimit configuration, /proc/sys/fs/file-max, systemd LimitNOFILE, container FD limits, diagnosing 'too many open files' errors in Kubernetes pods and nodes."
more_link: "yes"
url: "/linux-file-descriptor-limits-production-guide/"
---

The "too many open files" error ranks among the most common production failures in high-throughput services. Every socket, file, pipe, and network connection consumes a file descriptor (FD). Databases accumulate FDs for client connections and WAL files. Network proxies open FDs for each upstream and downstream connection. Log shippers hold FDs for every log file being watched. Without correct FD limits, services hit invisible walls and begin rejecting connections or failing to open files — often at the worst possible time, during peak load.

Linux implements FD limits at three layers: the kernel-wide maximum, the process-level soft limit, and the process-level hard limit. Containerization adds complexity: containers inherit FD limits from the container runtime, which inherits from systemd, creating a chain of defaults that often doesn't match application requirements.

<!--more-->

## File Descriptor Fundamentals

### The Three Limit Layers

**Kernel global maximum** (`/proc/sys/fs/file-max`): The absolute maximum number of file descriptors the kernel can allocate across all processes. This is a system-wide ceiling.

**Per-process hard limit** (`RLIMIT_NOFILE hard`): The maximum value to which the soft limit can be raised. Only root can raise the hard limit beyond the kernel maximum.

**Per-process soft limit** (`RLIMIT_NOFILE soft`): The currently enforced limit for the process. Processes can raise their own soft limit up to the hard limit without root privileges.

```
Hierarchy:
/proc/sys/fs/file-max (kernel ceiling)
    └── hard limit (per-process ceiling, requires root to raise)
            └── soft limit (enforced at runtime, self-raisable to hard limit)
```

### Checking Current Limits

```bash
# System-wide kernel maximum
cat /proc/sys/fs/file-max
# 1048576 (typical modern Linux default)

# Current open FD count system-wide
cat /proc/sys/fs/file-nr
# 34560   0   1048576
# [open FDs] [free FDs] [maximum FDs]

# Per-process limits (for current shell process)
ulimit -n           # soft limit
ulimit -Hn          # hard limit

# For a specific process by PID
cat /proc/12345/limits | grep "open files"
# Max open files   1048576   1048576   files

# Count current open FDs for a process
ls -la /proc/12345/fd | wc -l
# or
lsof -p 12345 | wc -l
```

### Understanding the Defaults Problem

Default FD limits on Linux systems are often left at historical values:

```bash
# Check default limits in /etc/security/limits.conf
cat /etc/security/limits.conf | grep -v "^#" | grep -v "^$"
# Typically empty or with low values like:
# * soft nofile 1024
# * hard nofile 4096

# These defaults date to when systems had <100 concurrent connections
# Modern services require 65536-1048576
```

## Configuring File Descriptor Limits

### System-Wide Kernel Maximum

Set the kernel-wide FD maximum via sysctl:

```bash
# Check current value
sysctl fs.file-max

# Set temporarily (lost on reboot)
sysctl -w fs.file-max=2097152

# Persist across reboots
cat >> /etc/sysctl.d/99-file-descriptors.conf << 'EOF'
# Maximum file descriptors system-wide
fs.file-max = 2097152

# Maximum number of watches per user (related: inotify watches)
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512

# Increase pipe capacity
fs.pipe-max-size = 4194304
EOF

sysctl -p /etc/sysctl.d/99-file-descriptors.conf
```

### PAM Limits for User Sessions

For services started via login sessions or sshd:

```bash
# /etc/security/limits.conf or /etc/security/limits.d/99-custom.conf
cat > /etc/security/limits.d/99-production.conf << 'EOF'
# Increase file descriptor limits for all users
# These apply to interactive sessions and PAM-based service starts

# Format: <domain> <type> <item> <value>
# * = all users
*               soft    nofile          131072
*               hard    nofile          524288

# root gets higher limits
root            soft    nofile          524288
root            hard    nofile          1048576

# Specific service users
nginx           soft    nofile          65536
nginx           hard    nofile          65536
postgres        soft    nofile          131072
postgres        hard    nofile          131072
kafka           soft    nofile          524288
kafka           hard    nofile          524288
EOF

# Verify PAM limits are applied for SSH sessions
# /etc/pam.d/sshd must include:
# session required pam_limits.so
grep "pam_limits" /etc/pam.d/sshd || echo "session required pam_limits.so" >> /etc/pam.d/sshd
```

### systemd Service File Configuration

Services started by systemd do NOT use PAM limits. They require `LimitNOFILE` in the service unit:

```ini
# /etc/systemd/system/nginx.service.d/limits.conf
# (override directory — doesn't replace the full unit file)

[Service]
LimitNOFILE=65536

# For services that need maximum limits
# LimitNOFILE=infinity means "use the system maximum"
# On newer systemd this translates to /proc/sys/fs/nr_open (not file-max)
```

```bash
# Create systemd override for an existing service
mkdir -p /etc/systemd/system/nginx.service.d/
cat > /etc/systemd/system/nginx.service.d/limits.conf << 'EOF'
[Service]
LimitNOFILE=65536
LimitNPROC=65536
EOF

systemctl daemon-reload
systemctl restart nginx

# Verify the limit was applied
cat /proc/$(pgrep nginx | head -1)/limits | grep "open files"
```

### The systemd DefaultLimitNOFILE Trap

Modern systemd (v238+) defaults have changed significantly:

```bash
# Check systemd's default limit
systemctl show --property DefaultLimitNOFILE
# DefaultLimitNOFILE=524288

# But the *soft* default is often 1024:
# systemd uses soft=1024:hard=524288 as the default
# This means processes start with soft limit of 1024!

# Set system-wide systemd defaults
cat > /etc/systemd/system.conf.d/limits.conf << 'EOF'
[Manager]
DefaultLimitNOFILE=524288
EOF

# Or per-service
cat > /etc/systemd/system/myservice.service.d/limits.conf << 'EOF'
[Service]
# Format: soft:hard or single value (sets both)
LimitNOFILE=524288:1048576
EOF

systemctl daemon-reload
```

### The `/proc/sys/fs/nr_open` vs `file-max` Distinction

```bash
# nr_open: maximum FDs a single process can have (applies to LimitNOFILE=infinity)
cat /proc/sys/fs/nr_open
# 1048576

# file-max: maximum FDs across ALL processes
cat /proc/sys/fs/file-max
# 9223372036854775807 (on modern kernels)

# When using LimitNOFILE=infinity, systemd uses nr_open, not file-max
# Set nr_open for services needing >1048576 FDs
sysctl -w fs.nr_open=2097152
echo "fs.nr_open = 2097152" >> /etc/sysctl.d/99-file-descriptors.conf
```

## Container and Kubernetes FD Limits

### How Container Runtimes Inherit Limits

Container FD limits flow through a chain:

```
Host systemd → containerd/dockerd → container runtime (runc) → container process
```

Each step can inherit or override. By default, containers inherit the host's limits:

```bash
# Check what limits a running container has
CONTAINER_ID=$(docker ps -q --filter name=myapp | head -1)
docker exec ${CONTAINER_ID} cat /proc/1/limits | grep "open files"
# Max open files   1048576   1048576   files

# If this shows 1024, the issue is in the chain above
```

### Docker FD Limit Configuration

```bash
# Option 1: Docker daemon global setting
cat /etc/docker/daemon.json
{
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 524288,
      "Soft": 524288
    }
  }
}

# Option 2: Per-container at run time
docker run --ulimit nofile=524288:524288 myapp:latest

# Option 3: Compose file
# docker-compose.yml
services:
  myapp:
    image: myapp:latest
    ulimits:
      nofile:
        soft: 131072
        hard: 524288
```

### containerd FD Configuration

For Kubernetes with containerd, the containerd daemon itself needs adequate FD limits:

```ini
# /etc/systemd/system/containerd.service.d/limits.conf
[Service]
LimitNOFILE=1048576
LimitNPROC=1048576
```

```bash
# Verify containerd's FD limits
cat /proc/$(pgrep containerd | head -1)/limits | grep "open files"
# Max open files   1048576   1048576   files
```

### Kubernetes Pod FD Limits

Kubernetes does not currently expose `ulimits.nofile` in the Pod spec. The container inherits from the container runtime. To set per-container FD limits in Kubernetes, use one of:

**Option 1: Security Context with sysctl (system-wide)**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: high-fd-app
spec:
  securityContext:
    sysctls:
    - name: "fs.file-max"
      value: "2097152"
  containers:
  - name: app
    image: myapp:v2.0.0
```

Note: Kernel-namespaced sysctl values (`fs.file-max` is NOT namespaced — it requires unsafe sysctl permission and affects the entire node). Only certain sysctls are namespace-safe.

**Option 2: Init Container to Set Limits**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: high-fd-app
spec:
  initContainers:
  - name: set-fd-limits
    image: busybox:1.36
    command: ['sh', '-c', 'ulimit -n 524288; echo "FD limit: $(ulimit -n)"']
    securityContext:
      privileged: true  # Requires privileged to raise hard limit
  containers:
  - name: app
    image: myapp:v2.0.0
```

**Option 3: LimitRange for Default Container Security Contexts**

Kubernetes LimitRange cannot set ulimits directly, but a MutatingWebhook can inject them.

**Option 4: Configure at the Node Level (Recommended)**

The most reliable approach is ensuring the kubelet, containerd, and runc all have sufficient FD limits configured at the node level. This propagates to all containers automatically:

```bash
# Node-level kubelet configuration
cat > /etc/systemd/system/kubelet.service.d/limits.conf << 'EOF'
[Service]
LimitNOFILE=1048576
LimitNPROC=1048576
EOF

# Node-level containerd configuration
cat > /etc/systemd/system/containerd.service.d/limits.conf << 'EOF'
[Service]
LimitNOFILE=1048576
LimitNPROC=1048576
EOF

systemctl daemon-reload
systemctl restart kubelet containerd
```

## Diagnosing "Too Many Open Files" in Kubernetes

### Step 1: Identify the Failure Mode

```bash
# Check application logs for FD exhaustion
kubectl logs -n production payment-api-7d4f9b6c8-xkj2p | \
  grep -E "too many open files|open files|EMFILE|ENFILE" | \
  tail -20

# Check kernel messages on the node
kubectl get events -n production \
  --field-selector reason=OOMKilling,reason=BackOff | \
  grep -E "too many|file descriptor"

# Check node events
kubectl describe node node-01 | grep -A5 "Events:"
```

### Step 2: Inspect the Failing Process

```bash
# Get the node where the Pod is running
NODE=$(kubectl get pod payment-api-7d4f9b6c8-xkj2p -n production \
  -o jsonpath='{.spec.nodeName}')

# SSH to the node or use a debug pod
kubectl debug node/${NODE} -it --image=ubuntu:22.04

# Find the container's main process
# Get the container ID
CONTAINER_ID=$(kubectl get pod payment-api-7d4f9b6c8-xkj2p -n production \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's/containerd:\/\///')

# Get the PID of the container's init process
PID=$(crictl inspect --output json ${CONTAINER_ID} | \
  jq '.info.pid')

# Check FD limits for the process
cat /proc/${PID}/limits | grep "Max open files"
# Max open files   1024   1024   files  ← TOO LOW!

# Count currently open FDs
ls /proc/${PID}/fd | wc -l

# List open FDs by type
ls -la /proc/${PID}/fd | \
  awk '{print $NF}' | \
  grep "^socket" | wc -l  # Count socket FDs

# Full FD breakdown
ls -la /proc/${PID}/fd | \
  awk '{print $NF}' | \
  sed 's/:[0-9]*//' | \
  sort | uniq -c | sort -rn | head -20
```

### Step 3: Trace FD Growth

```bash
#!/bin/bash
# fd-monitor.sh — Monitor FD consumption over time

PID=${1:-1}
INTERVAL=${2:-5}

echo "Monitoring FD count for PID ${PID} every ${INTERVAL}s"
echo "Press Ctrl-C to stop"
echo ""
echo "Timestamp                  FD Count  Sockets  Pipes  Files"

while true; do
    if [ ! -d /proc/${PID} ]; then
        echo "Process ${PID} no longer exists"
        break
    fi

    TOTAL=$(ls /proc/${PID}/fd 2>/dev/null | wc -l)
    SOCKETS=$(ls -la /proc/${PID}/fd 2>/dev/null | grep socket | wc -l)
    PIPES=$(ls -la /proc/${PID}/fd 2>/dev/null | grep pipe | wc -l)
    FILES=$(ls -la /proc/${PID}/fd 2>/dev/null | grep "/" | grep -v "socket\|pipe" | wc -l)

    printf "%-27s %-9s %-8s %-6s %s\n" \
        "$(date '+%Y-%m-%d %H:%M:%S')" \
        "${TOTAL}" \
        "${SOCKETS}" \
        "${PIPES}" \
        "${FILES}"

    sleep ${INTERVAL}
done
```

### Step 4: Identify FD Leak Sources

```bash
# Find which files/sockets are open most frequently
lsof -p ${PID} 2>/dev/null | \
  awk '{print $9}' | \
  sort | uniq -c | sort -rn | head -30

# Check for accumulating connections to a specific destination
ss -p | grep "pid=${PID}" | \
  awk '{print $6}' | sort | uniq -c | sort -rn | head -20

# Find FDs open longer than 1 hour (potential leaks)
find /proc/${PID}/fd -maxdepth 1 -type l -cmin +60 2>/dev/null | \
  xargs -I{} readlink {} | sort | uniq -c | sort -rn
```

### Step 5: Application-Level FD Leak Patterns

Common causes in Go services:

```go
// BUG: HTTP response body not closed — each request leaks an FD
func fetchData(url string) ([]byte, error) {
    resp, err := http.Get(url)
    if err != nil {
        return nil, err
    }
    // Missing: defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}

// FIX:
func fetchDataFixed(url string) ([]byte, error) {
    resp, err := http.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}
```

```go
// BUG: File opened but not closed on error path
func processFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }

    data, err := parse(f)
    if err != nil {
        return err  // FD leak! f never closed
    }

    f.Close()
    return process(data)
}

// FIX: Use defer
func processFileFixed(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()  // Always executed, regardless of error path

    data, err := parse(f)
    if err != nil {
        return err  // f.Close() called by defer
    }

    return process(data)
}
```

## Production Configuration Reference

### Complete Node Setup for High-Throughput Services

```bash
#!/bin/bash
# configure-node-fd-limits.sh
# Run on each Kubernetes worker node

set -euo pipefail

echo "=== Configuring file descriptor limits ==="

# 1. Kernel parameters
cat > /etc/sysctl.d/99-fd-limits.conf << 'EOF'
# System-wide FD maximum
fs.file-max = 2097152

# Per-process FD maximum (used by LimitNOFILE=infinity)
fs.nr_open = 1048576

# Inotify watches (for log shippers and file watchers)
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
fs.inotify.max_queued_events = 131072

# Connection tracking table size (affects socket FD usage)
net.netfilter.nf_conntrack_max = 1048576
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
EOF

sysctl -p /etc/sysctl.d/99-fd-limits.conf

# 2. PAM limits (for services using PAM)
cat > /etc/security/limits.d/99-fd-limits.conf << 'EOF'
* soft nofile 524288
* hard nofile 1048576
root soft nofile 524288
root hard nofile 1048576
EOF

# 3. systemd global defaults
mkdir -p /etc/systemd/system.conf.d/
cat > /etc/systemd/system.conf.d/fd-limits.conf << 'EOF'
[Manager]
DefaultLimitNOFILE=524288
EOF

# 4. kubelet
mkdir -p /etc/systemd/system/kubelet.service.d/
cat > /etc/systemd/system/kubelet.service.d/limits.conf << 'EOF'
[Service]
LimitNOFILE=1048576
LimitNPROC=1048576
EOF

# 5. containerd
mkdir -p /etc/systemd/system/containerd.service.d/
cat > /etc/systemd/system/containerd.service.d/limits.conf << 'EOF'
[Service]
LimitNOFILE=1048576
LimitNPROC=1048576
EOF

# Reload and apply
systemctl daemon-reload

echo "=== Verifying limits ==="
echo "Kernel file-max: $(cat /proc/sys/fs/file-max)"
echo "Kernel nr_open: $(cat /proc/sys/fs/nr_open)"
echo ""
echo "Please restart kubelet and containerd to apply systemd changes:"
echo "  systemctl restart containerd kubelet"
```

### Database-Specific Configuration

Databases like PostgreSQL and MySQL require per-process FD limits much higher than defaults:

```bash
# PostgreSQL: each connection = 1 FD + WAL FDs + data file FDs
# For 500 max_connections + WAL = ~1500 FDs minimum
cat > /etc/systemd/system/postgresql.service.d/limits.conf << 'EOF'
[Service]
LimitNOFILE=65536
EOF

# In postgresql.conf, verify max_connections
# max_connections = 500
# Each connection needs ~2-3 FDs in practice

# Kafka: each partition can consume multiple FDs
# 1000 partitions * 3 replicas * 2 (index + log) = ~6000 FDs minimum
cat > /etc/systemd/system/kafka.service.d/limits.conf << 'EOF'
[Service]
LimitNOFILE=524288
EOF
```

### Nginx Configuration

```nginx
# /etc/nginx/nginx.conf
user nginx;
worker_processes auto;

# Nginx's per-worker connection limit
# Each connection = 2 FDs (client + upstream), plus log FDs
events {
    worker_connections 65536;
    use epoll;
    multi_accept on;
}

# worker_rlimit_nofile must be > worker_connections * 2
worker_rlimit_nofile 131072;

http {
    # Keepalive connections to upstream
    upstream backend {
        server 10.0.0.10:8080;
        keepalive 256;
    }
}
```

## Monitoring File Descriptor Usage

### Prometheus Metrics

```yaml
# node_exporter provides FD metrics out of the box
# Key metrics:

# node_filefd_allocated — currently allocated FDs system-wide
# node_filefd_maximum — kernel maximum
# process_open_fds — FDs open in the monitoring process (per-process)

# Recording rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: fd-limits-monitoring
  namespace: monitoring
spec:
  groups:
  - name: fd-limits.rules
    rules:
    - alert: NodeFDUsageHigh
      expr: |
        node_filefd_allocated / node_filefd_maximum > 0.8
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.instance }} FD usage above 80%"
        description: "File descriptor usage is {{ $value | humanizePercentage }} of maximum on {{ $labels.instance }}"

    - alert: NodeFDUsageCritical
      expr: |
        node_filefd_allocated / node_filefd_maximum > 0.95
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Node {{ $labels.instance }} FD usage above 95%"
        description: "Imminent 'too many open files' failure on {{ $labels.instance }}. Current: {{ $value | humanizePercentage }}"
```

### Custom FD Metrics Exporter

```go
package main

import (
    "bufio"
    "fmt"
    "os"
    "path/filepath"
    "strconv"
    "strings"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    processOpenFDs = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "process_fd_count",
            Help: "Number of open file descriptors per process",
        },
        []string{"pid", "name"},
    )

    processMaxFDs = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "process_fd_limit_soft",
            Help: "Soft FD limit per process",
        },
        []string{"pid", "name"},
    )
)

func collectFDMetrics() {
    entries, _ := filepath.Glob("/proc/[0-9]*/fd")
    for _, fdDir := range entries {
        parts := strings.Split(fdDir, "/")
        pid := parts[2]

        // Get process name
        commBytes, err := os.ReadFile(fmt.Sprintf("/proc/%s/comm", pid))
        if err != nil {
            continue
        }
        name := strings.TrimSpace(string(commBytes))

        // Count open FDs
        fds, _ := filepath.Glob(fdDir + "/*")
        processOpenFDs.WithLabelValues(pid, name).Set(float64(len(fds)))

        // Get soft limit
        limit := getProcessFDLimit(pid)
        processMaxFDs.WithLabelValues(pid, name).Set(float64(limit))
    }
}

func getProcessFDLimit(pid string) int {
    f, err := os.Open(fmt.Sprintf("/proc/%s/limits", pid))
    if err != nil {
        return 0
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := scanner.Text()
        if strings.Contains(line, "Max open files") {
            fields := strings.Fields(line)
            if len(fields) >= 4 {
                n, _ := strconv.Atoi(fields[3])
                return n
            }
        }
    }
    return 0
}
```

## Quick Reference Cheat Sheet

```bash
# Show current FD usage
cat /proc/sys/fs/file-nr

# Show per-process FD limit
cat /proc/$(pgrep myapp)/limits | grep "open files"

# Show FD count for a process
ls /proc/$(pgrep myapp)/fd | wc -l

# Set FD limit for current session
ulimit -n 524288

# Set FD limit for a service (systemd)
systemctl edit myservice
# Add: [Service]
#      LimitNOFILE=524288

# Kernel parameter (persistent)
echo "fs.file-max = 2097152" >> /etc/sysctl.d/99-fd.conf
sysctl -p /etc/sysctl.d/99-fd.conf

# Find processes with most open FDs
for pid in /proc/[0-9]*/fd; do
    count=$(ls $pid 2>/dev/null | wc -l)
    echo "$count $pid"
done | sort -rn | head -10

# Find what's using the most FDs in a process
lsof -p $(pgrep myapp) | awk '{print $5}' | sort | uniq -c | sort -rn | head -10
```

The key principle for production systems: configure FD limits at the node level through systemd service overrides and sysctl, verify limits propagate through the containerd → runc → container chain, and instrument FD usage with Prometheus alerts before hitting the ceiling.
