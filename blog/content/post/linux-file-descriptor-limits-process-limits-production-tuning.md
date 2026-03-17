---
title: "Linux File Descriptor Limits and Process Limits: Production Tuning"
date: 2029-06-26T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "File Descriptors", "ulimit", "cgroups", "systemd", "Kubernetes"]
categories: ["Linux", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Linux file descriptor and process limits covering ulimit configuration, /proc/sys/fs/file-max, pids.max in cgroups v2, systemd LimitNOFILE, and Kubernetes pod-level file descriptor limit configuration for production workloads."
more_link: "yes"
url: "/linux-file-descriptor-limits-process-limits-production-tuning/"
---

"Too many open files" is one of the most common production errors in Linux environments, and it is almost always preventable with proper limit configuration. File descriptor exhaustion causes connection failures, crash loops, and cascading failures across microservices. This guide covers the complete Linux limit stack from kernel globals through process limits to Kubernetes pod configuration, including the interaction between systemd, cgroups v2, and container runtimes.

<!--more-->

# Linux File Descriptor Limits and Process Limits: Production Tuning

## Section 1: The Linux Limit Hierarchy

Linux enforces file descriptor limits at multiple levels. Understanding the hierarchy is essential for diagnosing and fixing limit-related failures.

```
Kernel Global Limit
  /proc/sys/fs/file-max          Maximum total FDs across ALL processes
  /proc/sys/fs/nr_open           Maximum per-process FD limit (hard ceiling for RLIMIT_NOFILE)

Per-Process Resource Limits (rlimits)
  RLIMIT_NOFILE                  Soft and hard limits for open file descriptors
  RLIMIT_NPROC                   Maximum number of processes/threads for the user
  RLIMIT_AS                      Maximum virtual memory size
  RLIMIT_FSIZE                   Maximum file size

cgroup v2 Controllers
  pids.max                       Maximum PIDs in the cgroup (applies to processes and threads)

systemd Service Limits
  LimitNOFILE                    Per-service FD limit (overrides /etc/security/limits.conf)
  TasksMax                       Maximum tasks (PIDs) per service

Container Runtime
  --ulimit nofile=N:M            Docker/containerd rlimit override

Kubernetes
  pod.spec.containers[].securityContext.runAsNonRoot + init container workarounds
  (native LimitNOFILE per-container is not exposed; use rlimits or sysctl)
```

### Current System State

```bash
# Global kernel FD limit
cat /proc/sys/fs/file-max
# 9223372036854775807  (nearly unlimited on modern kernels)

# Currently allocated FDs system-wide
cat /proc/sys/fs/file-nr
# 34208  0  9223372036854775807
# ^^^    ^  ^^^
# allocated  free  max

# Per-process hard ceiling
cat /proc/sys/fs/nr_open
# 1048576  (1M, this is the absolute max for RLIMIT_NOFILE)

# Current process limits
cat /proc/self/limits
# Limit                     Soft Limit   Hard Limit   Units
# Max open files            1024         4096         files
# Max processes             63244        63244        processes

# Check a specific process
cat /proc/<PID>/limits | grep -E "open files|processes"

# Count FDs for a process
ls -la /proc/<PID>/fd | wc -l

# Find processes near their FD limit
for pid in /proc/[0-9]*/; do
    pid=$(basename $pid)
    soft=$(cat /proc/$pid/limits 2>/dev/null | awk '/open files/{print $4}')
    cur=$(ls /proc/$pid/fd 2>/dev/null | wc -l)
    [ -z "$soft" ] && continue
    pct=$(( cur * 100 / soft ))
    [ $pct -gt 80 ] && echo "PID $pid: $cur/$soft ($pct%)"
done
```

---

## Section 2: Kernel Global Limits

### /proc/sys/fs/file-max

This is the system-wide maximum. It applies to all processes combined. Modern kernels default to very high values, but older systems or containers may have low values.

```bash
# Check current limit
sysctl fs.file-max

# Temporary change (lost on reboot)
sysctl -w fs.file-max=2097152

# Permanent change
echo "fs.file-max = 2097152" >> /etc/sysctl.d/99-limits.conf
sysctl --system

# For containers (if allowed by the host)
sysctl -w fs.file-max=2097152
```

### /proc/sys/fs/nr_open

This is the per-process ceiling. No process can set RLIMIT_NOFILE higher than this value.

```bash
# Check (typically 1,048,576 = 1M on modern systems)
cat /proc/sys/fs/nr_open

# Increase for services that need more than 1M FDs (rare)
sysctl -w fs.nr_open=2097152
```

### Inotify Limits (Related)

Applications using inotify (file watchers, editors, IDEs) often hit separate limits:

```bash
# Maximum instances of inotify
cat /proc/sys/fs/inotify/max_user_instances  # Default: 128

# Maximum watches per instance
cat /proc/sys/fs/inotify/max_user_watches   # Default: 8192

# Recommended for developer environments or high-watch applications
cat >> /etc/sysctl.d/99-inotify.conf <<'EOF'
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 524288
EOF
sysctl --system
```

---

## Section 3: /etc/security/limits.conf and PAM

The PAM limits module applies per-user and per-group rlimits at login time.

```bash
# /etc/security/limits.conf format:
# <domain>  <type>  <item>  <value>
# domain: username, @groupname, *, wildcard
# type: soft (advisory, user can raise to hard), hard (ceiling)
# item: nofile, nproc, memlock, stack, etc.

# View current configuration
cat /etc/security/limits.conf
cat /etc/security/limits.d/*.conf
```

### Recommended Production Configuration

```bash
cat > /etc/security/limits.d/99-production.conf <<'EOF'
# System-wide defaults for production services
*               soft    nofile          65536
*               hard    nofile          131072

# Higher limits for service accounts
webapp          soft    nofile          1048576
webapp          hard    nofile          1048576

# Database service accounts
postgres        soft    nofile          65536
postgres        hard    nofile          65536
postgres        soft    nproc           unlimited
postgres        hard    nproc           unlimited

# Root (often forgotten)
root            soft    nofile          1048576
root            hard    nofile          1048576

# Process limits
*               soft    nproc           65536
*               hard    nproc           131072
EOF
```

### Verify PAM is Loading Limits

```bash
# Check PAM configuration
grep pam_limits /etc/pam.d/common-session
grep pam_limits /etc/pam.d/sshd

# Should contain:
# session required pam_limits.so

# Limits only apply at NEW LOGIN sessions
# To verify without logout/login:
su - webapp -c "ulimit -n"
```

---

## Section 4: ulimit — Per-Process Runtime Limits

```bash
# View all limits for current shell
ulimit -a

# View only nofile (soft and hard)
ulimit -n       # soft limit
ulimit -Hn      # hard limit

# Set soft limit (up to hard limit, no root required)
ulimit -Sn 65536

# Set hard limit (root required to raise)
ulimit -Hn 131072

# Set both in one command
ulimit -n 65536  # Sets both soft and hard to same value

# Set max processes
ulimit -u 65536

# In scripts: set for the script and all child processes
#!/bin/bash
ulimit -n 65536 || echo "WARNING: Could not set file descriptor limit"
exec ./my-application
```

### Checking What a Running Process Has

```bash
# Direct from /proc
PID=12345
echo "Soft NOFILE: $(cat /proc/$PID/limits | awk '/open files/{print $4}')"
echo "Hard NOFILE: $(cat /proc/$PID/limits | awk '/open files/{print $5}')"
echo "Current FDs: $(ls /proc/$PID/fd 2>/dev/null | wc -l)"

# Via prlimit (modern approach)
prlimit --pid $PID --nofile

# Change limits of running process (requires CAP_SYS_RESOURCE or root)
prlimit --pid $PID --nofile=65536:131072
```

---

## Section 5: systemd Service Limits

systemd manages service resource limits independently of `/etc/security/limits.conf`. The systemd settings take precedence for services it manages.

```ini
# /etc/systemd/system/my-service.service
[Unit]
Description=My Production Service
After=network.target

[Service]
Type=simple
User=webapp
Group=webapp
ExecStart=/opt/my-app/bin/server
Restart=always
RestartSec=5s

# File descriptor limits
LimitNOFILE=1048576

# Process limits
TasksMax=infinity

# Memory limits (optional, prefer cgroup limits)
# LimitAS=4G
# LimitDATA=2G

# Core dump (set to 0 to prevent core dumps in production)
LimitCORE=0

# Additional ulimits
LimitMEMLOCK=infinity
LimitNPROC=65536

[Install]
WantedBy=multi-user.target
```

```bash
# Apply without restart
systemctl daemon-reload
systemctl restart my-service

# Verify limits took effect
systemctl show my-service | grep LimitNOFILE
# LimitNOFILE=1048576
# LimitNOFILESoft=1048576

# Check running service
cat /proc/$(systemctl show --property MainPID my-service | cut -d= -f2)/limits | \
  grep "open files"
```

### Editing Existing Service Limits (Drop-in Override)

```bash
# Create a drop-in override without modifying the original unit
mkdir -p /etc/systemd/system/nginx.service.d/
cat > /etc/systemd/system/nginx.service.d/limits.conf <<'EOF'
[Service]
LimitNOFILE=65536
EOF

systemctl daemon-reload
systemctl restart nginx

# Verify
systemctl cat nginx | grep LimitNOFILE
```

### System-Wide systemd Defaults

```bash
# /etc/systemd/system.conf for system-wide defaults
grep -E "DefaultLimit" /etc/systemd/system.conf

# Set system-wide defaults
cat >> /etc/systemd/system.conf <<'EOF'
DefaultLimitNOFILE=65536:131072
DefaultLimitNPROC=65536:131072
DefaultTasksMax=infinity
EOF

systemctl daemon-reexec
```

---

## Section 6: cgroup v2 — pids.max

cgroup v2 enforces `pids.max` which limits the number of PIDs (processes and threads) in the cgroup. This is distinct from RLIMIT_NPROC.

```bash
# Check cgroup v2 mount
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot)

# Check pids.max for a service
cat /sys/fs/cgroup/system.slice/my-service.service/pids.max
# max  (unlimited)

# Set pids.max for a running cgroup
echo "1000" > /sys/fs/cgroup/system.slice/my-service.service/pids.max

# Check current PID count
cat /sys/fs/cgroup/system.slice/my-service.service/pids.current

# Set via systemd (preferred for persistence)
# In unit file:
# TasksMax=1000
# Or in systemd-run:
systemd-run --slice=app.slice --property TasksMax=1000 my-application
```

### cgroup v2 Hierarchy in Kubernetes

Kubernetes uses cgroup v2 for container resource isolation. The hierarchy is:

```
/sys/fs/cgroup/
└── kubepods.slice/
    ├── kubepods-besteffort.slice/
    ├── kubepods-burstable.slice/
    │   └── pod<pod-uid>.slice/
    │       └── <container-id>.scope/
    │           ├── pids.max
    │           ├── pids.current
    │           └── ...
    └── kubepods-guaranteed.slice/
```

```bash
# Find a pod's cgroup path
POD_UID=$(kubectl get pod my-pod -o jsonpath='{.metadata.uid}')
CGROUP_PATH="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/pod${POD_UID}.slice"

# Check container PIDs
for container_dir in $CGROUP_PATH/*/; do
    echo "Container: $(basename $container_dir)"
    echo "  pids.current: $(cat $container_dir/pids.current)"
    echo "  pids.max: $(cat $container_dir/pids.max)"
done
```

---

## Section 7: Docker and containerd Ulimit Configuration

### Docker Daemon Defaults

```json
// /etc/docker/daemon.json
{
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 1048576,
      "Soft": 1048576
    },
    "nproc": {
      "Name": "nproc",
      "Hard": 65536,
      "Soft": 65536
    }
  },
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

```bash
# Restart Docker after config change
systemctl restart docker

# Verify default ulimits
docker run --rm ubuntu sh -c "ulimit -n"
# 1048576
```

### Per-Container Override

```bash
# Override ulimits for a specific container
docker run \
  --ulimit nofile=65536:131072 \
  --ulimit nproc=4096:4096 \
  my-application

# Check container process limits
docker exec my-container cat /proc/1/limits
```

### containerd Configuration

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
    SystemdCgroup = true

# Default rlimits for all containers
[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    default_runtime_name = "runc"
```

---

## Section 8: Kubernetes Pod File Descriptor Limits

Kubernetes does not expose RLIMIT_NOFILE directly in the pod spec. Several approaches exist:

### Approach 1: Init Container to Set rlimits

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: high-fd-service
spec:
  template:
    spec:
      initContainers:
      # This only works if the container runtime propagates ulimits
      # and the node's daemon.json sets appropriate defaults
      - name: set-limits
        image: busybox
        command: ['sh', '-c', 'ulimit -n 1048576 && echo "limits set"']
        securityContext:
          privileged: false

      containers:
      - name: app
        image: my-app:latest
        # The app inherits limits from the node's containerd/docker defaults
```

### Approach 2: Node-Level Daemon Configuration (Preferred)

The most reliable approach for Kubernetes is to configure limits at the container runtime level:

```bash
# On each Kubernetes node, configure containerd or Docker defaults
cat > /etc/docker/daemon.json <<'EOF'
{
  "default-ulimits": {
    "nofile": {
      "Hard": 1048576,
      "Name": "nofile",
      "Soft": 1048576
    }
  }
}
EOF

systemctl restart containerd
# or
systemctl restart docker
```

### Approach 3: DaemonSet to Apply Node-Level sysctl

```yaml
# node-limits-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-limits-configurator
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-limits-configurator
  template:
    metadata:
      labels:
        app: node-limits-configurator
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
      initContainers:
      - name: configure-limits
        image: busybox
        command:
        - sh
        - -c
        - |
          # Set fs.file-max
          sysctl -w fs.file-max=2097152
          # Set nr_open
          sysctl -w fs.nr_open=1048576
          # Set inotify limits
          sysctl -w fs.inotify.max_user_watches=524288
          sysctl -w fs.inotify.max_user_instances=8192
          echo "Node limits configured"
        securityContext:
          privileged: true
      containers:
      - name: pause
        image: k8s.gcr.io/pause:3.9
        resources:
          requests:
            cpu: 1m
            memory: 1Mi
      nodeSelector:
        kubernetes.io/os: linux
```

### Approach 4: Sysctl Pod Security

For sysctls that are safe to set per-pod (in the sysctl allowlist):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  securityContext:
    sysctls:
    # Only safe sysctls are allowed in default configuration
    - name: net.core.somaxconn
      value: "65535"
    - name: net.ipv4.tcp_tw_reuse
      value: "1"
    # fs.file-max is NOT a namespaced sysctl — cannot be set per-pod
  containers:
  - name: app
    image: my-app:latest
```

### Kubelet PID Limits

```yaml
# kubelet-config.yaml — Set pod PID limits at node level
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
podPidsLimit: 4096   # Maximum PIDs per pod (applies to all pods on this node)
# Individual pod override via PodSpec.Spec.OS is not directly supported
# Use cgroup v2 in kubelet for pids.max enforcement
```

---

## Section 9: Diagnosing FD Exhaustion in Production

```bash
#!/bin/bash
# fd-diagnostic.sh — Comprehensive FD exhaustion diagnostic
set -euo pipefail

echo "=== File Descriptor Diagnostic Report ==="
echo "Date: $(date)"
echo ""

# System-wide stats
echo "--- System Global Limits ---"
echo "file-max: $(cat /proc/sys/fs/file-max)"
echo "nr_open:  $(cat /proc/sys/fs/nr_open)"
read ALLOC FREE MAX < /proc/sys/fs/file-nr
echo "file-nr:  allocated=$ALLOC free=$FREE max=$MAX"
USAGE_PCT=$((ALLOC * 100 / MAX))
echo "Usage: ${USAGE_PCT}%"
echo ""

# Top processes by FD count
echo "--- Top 10 Processes by Open File Descriptors ---"
printf "%-8s %-20s %-10s %-10s %-10s\n" "PID" "COMMAND" "FD_COUNT" "SOFT_LIMIT" "USAGE%"
for pid in /proc/[0-9]*/; do
    pid=$(basename $pid)
    cmd=$(cat /proc/$pid/comm 2>/dev/null || echo "N/A")
    fd_count=$(ls /proc/$pid/fd 2>/dev/null | wc -l)
    soft=$(awk '/open files/{print $4}' /proc/$pid/limits 2>/dev/null || echo "0")
    if [ "$soft" -gt 0 ] 2>/dev/null; then
        pct=$((fd_count * 100 / soft))
        echo "$pid $cmd $fd_count $soft $pct"
    fi
done 2>/dev/null | \
sort -k3 -rn | \
head -10 | \
awk '{printf "%-8s %-20s %-10s %-10s %-10s\n",$1,$2,$3,$4,$5"%"}'

echo ""

# Processes near limit
echo "--- Processes > 80% of FD Limit ---"
for pid in /proc/[0-9]*/; do
    pid=$(basename $pid)
    cmd=$(cat /proc/$pid/comm 2>/dev/null || continue)
    fd_count=$(ls /proc/$pid/fd 2>/dev/null | wc -l)
    soft=$(awk '/open files/{print $4}' /proc/$pid/limits 2>/dev/null || continue)
    [ -z "$soft" ] || [ "$soft" -eq 0 ] && continue
    pct=$((fd_count * 100 / soft)) 2>/dev/null || continue
    [ $pct -gt 80 ] && printf "PID %-8s %-20s %d/%d (%d%%)\n" \
      $pid "$cmd" $fd_count $soft $pct
done 2>/dev/null

echo ""
echo "=== Diagnostic Complete ==="
```

### FD Type Analysis

```bash
# What types of FDs is a process using?
PID=12345

# Count by type
ls -la /proc/$PID/fd | awk '{print $NF}' | \
  grep -v '^$\|total' | \
  sed 's|/proc/.*||; s|socket:.*|socket|; s|anon_inode:.*|anon_inode|' | \
  sort | uniq -c | sort -rn

# Count sockets (network connections)
ls -la /proc/$PID/fd | grep socket | wc -l

# List all socket connections
ss -p | grep "pid=$PID,"
```

---

## Section 10: Production Configuration Summary

### Complete Node Configuration Script

```bash
#!/bin/bash
# configure-production-node.sh — Apply recommended FD limits
set -euo pipefail

# 1. Kernel parameters
cat > /etc/sysctl.d/99-production-limits.conf <<'EOF'
# File descriptor limits
fs.file-max = 2097152
fs.nr_open = 1048576

# Inotify limits
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 8192

# Network tuning (related to socket FDs)
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# PID limit
kernel.pid_max = 4194304
EOF

sysctl --system

# 2. PAM limits
cat > /etc/security/limits.d/99-production.conf <<'EOF'
*    soft  nofile   65536
*    hard  nofile   1048576
root soft  nofile   1048576
root hard  nofile   1048576
*    soft  nproc    65536
*    hard  nproc    131072
EOF

# 3. systemd global defaults
mkdir -p /etc/systemd/system.conf.d/
cat > /etc/systemd/system.conf.d/limits.conf <<'EOF'
[Manager]
DefaultLimitNOFILE=1048576
DefaultTasksMax=infinity
EOF

systemctl daemon-reexec

echo "Production node limits configured. Reboot or re-login for PAM changes."
```

### Monitoring Rule for FD Exhaustion

```yaml
# prometheus-fd-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: fd-exhaustion-alerts
  namespace: monitoring
spec:
  groups:
  - name: file-descriptors
    rules:
    - alert: ProcessFDExhaustionRisk
      expr: |
        (
          process_open_fds / process_max_fds
        ) > 0.8
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Process FD usage above 80%"
        description: "{{ $labels.job }} on {{ $labels.instance }} is using {{ $value | humanizePercentage }} of available file descriptors"

    - alert: ProcessFDCritical
      expr: |
        (
          process_open_fds / process_max_fds
        ) > 0.95
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Process FD usage critical (>95%)"
        description: "{{ $labels.job }} on {{ $labels.instance }} will exhaust FDs soon: {{ $value | humanizePercentage }} used"

    - alert: NodeFDExhaustionRisk
      expr: |
        node_filefd_allocated / node_filefd_maximum > 0.8
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Node system-wide FD usage above 80%"
```

The file descriptor limit stack in Linux has many layers, and misconfigurations at any layer cause hard-to-diagnose errors. The key insight is that limits must be set at every relevant level: the kernel for system-wide safety, PAM for login sessions, systemd for managed services, and the container runtime for containers. Kubernetes inherits the container runtime's defaults, making node-level configuration the most reliable approach.
