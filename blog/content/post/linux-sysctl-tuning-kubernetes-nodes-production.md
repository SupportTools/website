---
title: "Linux Kernel Parameters: sysctl Tuning for Production Kubernetes Nodes"
date: 2030-06-19T00:00:00-05:00
draft: false
tags: ["Linux", "Kubernetes", "Performance", "sysctl", "Kernel", "System Administration"]
categories:
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive sysctl tuning guide: network stack parameters, memory management, file descriptor limits, kernel scheduler tuning, and recommended configurations for Kubernetes worker nodes."
more_link: "yes"
url: "/linux-sysctl-tuning-kubernetes-nodes-production/"
---

Kubernetes worker nodes run dozens to hundreds of containers, each with their own network sockets, file descriptors, and memory requirements. Default Linux kernel parameters were designed for general-purpose workloads and impose limits that cause subtle, hard-to-diagnose failures at Kubernetes scale: connection timeouts from exhausted port ranges, OOM kills from misconfigured memory overcommit, and inotify failures from per-process watch limits. This guide covers the kernel parameters that matter most for Kubernetes nodes, the failure modes they prevent, and production-validated configurations.

<!--more-->

## Why Default Kernel Parameters Are Insufficient

Default kernel parameter values reflect conservative choices for desktop and single-service workloads. A Kubernetes worker node running 110 pods (the default maximum) can easily exceed several default limits simultaneously:

- **Ephemeral ports**: 28,232 (default range 32768-60999) for a node running hundreds of short-lived connections per second
- **inotify watches**: 8,192 per user (default) for a node with hundreds of containers each watching config files
- **File descriptors**: 65,535 (default) system-wide for a node where each pod may hold dozens of open connections
- **Backlog queue**: 128 (default `net.core.somaxconn`) causing connection drops under burst traffic

Understanding which parameters to tune — and why — prevents these failure modes without destabilizing the node.

## Network Stack Parameters

### Connection Tracking

```bash
# View current conntrack table usage
cat /proc/net/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Default is typically 65536, insufficient for nodes with many services
# Each tracked connection consumes ~350 bytes
# A node with 100 pods, each with 500 connections = 50,000 entries minimum
sysctl net.netfilter.nf_conntrack_max
```

Production conntrack configuration:

```bash
# nf_conntrack_max: maximum tracked connections
# For nodes with 100+ pods: set to at least 1,048,576
net.netfilter.nf_conntrack_max = 1048576

# nf_conntrack_buckets: hash table buckets (should be 1/4 of nf_conntrack_max)
# Note: this is a module parameter, not a sysctl in older kernels
net.netfilter.nf_conntrack_buckets = 262144

# TCP connection tracking timeouts
# Reduce TIME_WAIT timeout from default 120s to reduce table saturation
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 15
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
```

### TCP Network Stack

```bash
# net.core.somaxconn: maximum connection backlog for listen()
# Default 128 causes SYN drops under burst traffic to any service
# Kubernetes Services, Ingress controllers, and api-server all benefit from high values
net.core.somaxconn = 65535

# net.core.netdev_max_backlog: per-interface receive queue depth
# Increase to prevent packet drops when NIC receives faster than kernel processes
net.core.netdev_max_backlog = 65535

# net.ipv4.tcp_max_syn_backlog: SYN queue depth
# Must be >= somaxconn to be effective
net.ipv4.tcp_max_syn_backlog = 65535

# Ephemeral port range
# Default: 32768-60999 (28,232 ports)
# Expanded: 1024-65535 (64,512 ports)
# Large services like api-server proxies benefit from wider range
net.ipv4.ip_local_port_range = 1024 65535

# TCP TIME_WAIT reuse
# Allow reuse of TIME_WAIT sockets for new connections (safe for modern kernels)
net.ipv4.tcp_tw_reuse = 1

# FIN_WAIT2 timeout: reduce from 60s default
net.ipv4.tcp_fin_timeout = 15

# TCP keepalive tuning
# Detect dead connections faster (relevant for Kubernetes health checks and connections to api-server)
net.ipv4.tcp_keepalive_time = 600     # Start keepalive after 10 min idle (default: 7200)
net.ipv4.tcp_keepalive_intvl = 10     # Probe every 10s (default: 75)
net.ipv4.tcp_keepalive_probes = 9     # Fail after 9 missed probes (default: 9)

# TCP receive/send buffer sizes
# Default buffer: 4096/87380/6291456 (min/default/max bytes)
# Larger buffers improve throughput for high-bandwidth connections
net.core.rmem_default = 262144
net.core.rmem_max = 134217728
net.core.wmem_default = 262144
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728

# TCP window scaling (enabled by default in modern kernels)
net.ipv4.tcp_window_scaling = 1

# Disable TCP slow start after idle (improves throughput for long-lived connections)
net.ipv4.tcp_slow_start_after_idle = 0

# Maximum number of TCP sockets not attached to any user file handle
net.ipv4.tcp_max_orphans = 65536

# SYN flood protection (ensure this is ON on all Kubernetes nodes)
net.ipv4.tcp_syncookies = 1
```

### IP Forwarding and Bridge Filtering

Kubernetes requires IP forwarding and bridge netfilter to function:

```bash
# IP forwarding: required for pod-to-pod and pod-to-service routing
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1

# Bridge netfilter: required for iptables-based CNIs (Flannel, Calico)
# Without this, iptables rules don't see bridged traffic
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-arptables = 1

# Reverse path filtering: loosened for asymmetric routing scenarios
# (relevant for multi-homed nodes or BGP-based CNIs like Calico)
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
```

**Note**: `bridge-nf-call-iptables` requires the `br_netfilter` kernel module:

```bash
# Load module at boot
echo "br_netfilter" > /etc/modules-load.d/kubernetes.conf
modprobe br_netfilter

# Verify
cat /proc/sys/net/bridge/bridge-nf-call-iptables
```

### UDP and Multicast

```bash
# UDP receive buffer (relevant for DNS-heavy nodes)
net.core.rmem_max = 134217728  # Already set above, covers UDP too

# Maximum UDP socket read buffer
net.ipv4.udp_rmem_min = 8192
net.ipv4.udp_wmem_min = 8192
```

## Memory Management

### Virtual Memory and Swap

```bash
# vm.swappiness: tendency to swap anonymous memory to disk
# For Kubernetes nodes: set to 0 to prevent kubelet from complaining
# kubelet requires swap to be disabled OR configured explicitly
vm.swappiness = 0

# vm.overcommit_memory: controls memory overcommit behavior
# 0 = heuristic (default): estimate based on free memory
# 1 = always allow overcommit (used by some applications)
# 2 = never overcommit beyond overcommit_ratio% of RAM + swap
# For Kubernetes nodes: 1 is recommended to prevent Go runtime OOM failures
vm.overcommit_memory = 1

# vm.overcommit_ratio: % of RAM allowed when overcommit_memory=2
vm.overcommit_ratio = 50

# vm.panic_on_oom: panic and reboot on OOM
# For production: 0 (don't panic, let OOM killer handle it)
vm.panic_on_oom = 0

# vm.oom_kill_allocating_task: kill the task triggering OOM rather than scanning
# For Kubernetes: 1 kills the allocating task first (more predictable)
vm.oom_kill_allocating_task = 1
```

### Transparent Huge Pages

THP can cause latency spikes in containerized applications:

```bash
# Disable THP (cannot be set via sysctl; requires kernel cmdline or sysfs)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Persist via systemd
cat > /etc/systemd/system/disable-thp.service <<'EOF'
[Unit]
Description=Disable Transparent Huge Pages
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=kubelet.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled && echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now disable-thp
```

### Page Cache and Dirty Pages

```bash
# vm.dirty_ratio: % of RAM that can be dirty before process writes block
# Default 20%; for write-heavy workloads, reduce to flush more aggressively
vm.dirty_ratio = 10

# vm.dirty_background_ratio: % of RAM triggering background writeback
# Default 5%
vm.dirty_background_ratio = 5

# vm.dirty_expire_centisecs: how old dirty data must be before flushing (centiseconds)
# Default 3000 (30s); reduce for better write predictability
vm.dirty_expire_centisecs = 1000

# vm.dirty_writeback_centisecs: how often the flusher wakes up
vm.dirty_writeback_centisecs = 100

# vm.min_free_kbytes: minimum free memory kept in reserve
# Default is too low for nodes with many containers
# Set to approximately 1-2% of total RAM
# For 64GB RAM node: 1310720 (1.25 GiB)
vm.min_free_kbytes = 1310720
```

### Huge Pages (When Required)

For workloads that benefit from huge pages (databases, high-performance networking):

```bash
# Allocate 1GiB of 2MB huge pages at boot
# (in /etc/sysctl.conf for persistence)
vm.nr_hugepages = 512  # 512 * 2MiB = 1GiB

# NUMA-aware huge page allocation
# (set per node via /sys/devices/system/node/nodeN/hugepages/hugepages-2048kB/nr_hugepages)
```

## File Descriptors and Inotify

### System-Wide File Descriptor Limits

```bash
# fs.file-max: total file descriptors system-wide
# Default ~800k for most systems; insufficient for 100+ pods each with many connections
fs.file-max = 2097152

# fs.nr_open: maximum FDs a single process can open
# Must be >= the hard limit set in /etc/security/limits.conf
fs.nr_open = 1048576
```

```bash
# /etc/security/limits.conf or /etc/security/limits.d/kubernetes.conf
*       soft    nofile  1048576
*       hard    nofile  1048576
root    soft    nofile  1048576
root    hard    nofile  1048576

# Maximum processes (relevant for fork-heavy workloads)
*       soft    nproc   unlimited
*       hard    nproc   unlimited
```

### inotify Limits

Container filesystems trigger inotify watches heavily (config map watches, log file monitoring, Kubernetes volume mounts):

```bash
# fs.inotify.max_user_watches: maximum inotify watches per user
# Default 8192: exhausted by a single container runtime + monitoring agent
# Each pod may consume 200-500 watches for volume monitoring alone
fs.inotify.max_user_watches = 1048576

# fs.inotify.max_user_instances: maximum inotify instances per user
# Default 128: one container runtime can exhaust this
fs.inotify.max_user_instances = 8192

# fs.inotify.max_queued_events: maximum queued inotify events before overflow
fs.inotify.max_queued_events = 32768
```

**Diagnosing inotify exhaustion**:

```bash
# Error: "no space left on device" when starting container
# Actually caused by inotify exhaustion, not disk space

# Check current inotify watch usage
find /proc/*/fd -lname anon_inode:inotify 2>/dev/null | \
  sed 's|/proc/\([0-9]*\)/.*|\1|' | \
  xargs -I{} bash -c 'echo -n "PID {}: "; \
    cat /proc/{}/fdinfo/* 2>/dev/null | grep -c inotify' 2>/dev/null | \
  sort -t: -k2 -rn | head -20
```

### POSIX Message Queues

```bash
# fs.mqueue.msg_max: maximum messages per queue
fs.mqueue.msg_max = 1000

# fs.mqueue.msgsize_max: maximum message size
fs.mqueue.msgsize_max = 65536

# fs.mqueue.queues_max: maximum message queues system-wide
fs.mqueue.queues_max = 1024
```

## Kernel Scheduler and CPU

### Process Scheduling

```bash
# kernel.sched_migration_cost_ns: cost of migrating a task between CPUs (ns)
# Default 500000 (500μs)
# For latency-sensitive workloads, reduce to allow faster migration
# For throughput-focused nodes, increase to reduce cache thrashing
kernel.sched_migration_cost_ns = 5000000  # 5ms for CPU-bound workloads
# OR
kernel.sched_migration_cost_ns = 250000   # 250μs for latency-sensitive

# kernel.sched_autogroup_enabled: group tasks by session for scheduling
# Disable for container workloads (containers are isolated processes, not sessions)
kernel.sched_autogroup_enabled = 0

# kernel.sched_min_granularity_ns: minimum task preemption granularity
# Default 1000000 (1ms)
kernel.sched_min_granularity_ns = 10000000  # 10ms: reduce context switching

# kernel.sched_wakeup_granularity_ns: granularity for wakeup preemption
kernel.sched_wakeup_granularity_ns = 15000000
```

### NUMA Balancing

```bash
# kernel.numa_balancing: automatic NUMA memory migration
# 0 = disabled (for consistent latency), 1 = enabled (for memory locality)
# For Kubernetes nodes with NUMA topology: test both configurations
kernel.numa_balancing = 1  # Enable for most workloads
```

### Real-Time Scheduling

```bash
# kernel.sched_rt_runtime_us: microseconds real-time tasks can run per period
# Default 950000 (95% of period)
# Never set to -1 (unlimited) on production Kubernetes nodes
kernel.sched_rt_runtime_us = 950000
```

## Kernel Security Parameters

### Kernel Hardening (Compatible with Kubernetes)

```bash
# kernel.randomize_va_space: ASLR level
# 2 = full ASLR (required for security, compatible with Kubernetes)
kernel.randomize_va_space = 2

# kernel.dmesg_restrict: restrict dmesg to root
# 1 = only root can read dmesg
kernel.dmesg_restrict = 1

# kernel.kptr_restrict: restrict kernel pointer exposure
# 1 = pointers hidden from non-privileged
kernel.kptr_restrict = 1

# kernel.yama.ptrace_scope: restrict ptrace
# 1 = parent may ptrace children only
# Note: set to 0 if containers need ptrace for debugging
kernel.yama.ptrace_scope = 1

# net.ipv4.conf.all.accept_redirects: reject ICMP redirects
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0

# net.ipv4.conf.all.send_redirects
net.ipv4.conf.all.send_redirects = 0

# Disable source routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
```

## Complete Production sysctl Configuration

Apply as a single file for Kubernetes worker nodes:

```bash
# /etc/sysctl.d/99-kubernetes-node.conf

###############################################################################
# Network: Connection Tracking
###############################################################################
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 15
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30

###############################################################################
# Network: TCP/IP Stack
###############################################################################
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 9
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_max_orphans = 65536
net.ipv4.tcp_syncookies = 1

###############################################################################
# Network: Buffers
###############################################################################
net.core.rmem_default = 262144
net.core.rmem_max = 134217728
net.core.wmem_default = 262144
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728

###############################################################################
# Network: Kubernetes Requirements
###############################################################################
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0

###############################################################################
# Memory Management
###############################################################################
vm.swappiness = 0
vm.overcommit_memory = 1
vm.panic_on_oom = 0
vm.oom_kill_allocating_task = 1
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 1000
vm.dirty_writeback_centisecs = 100
vm.min_free_kbytes = 1310720

###############################################################################
# File System
###############################################################################
fs.file-max = 2097152
fs.nr_open = 1048576
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 8192
fs.inotify.max_queued_events = 32768

###############################################################################
# Kernel Scheduler
###############################################################################
kernel.sched_migration_cost_ns = 5000000
kernel.sched_autogroup_enabled = 0

###############################################################################
# Security (Kubernetes-compatible)
###############################################################################
kernel.randomize_va_space = 2
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
```

Apply and verify:

```bash
# Apply without reboot
sysctl -p /etc/sysctl.d/99-kubernetes-node.conf

# Verify specific values
sysctl net.core.somaxconn
sysctl fs.inotify.max_user_watches
sysctl net.netfilter.nf_conntrack_max

# Verify all applied correctly
sysctl -a --pattern "inotify|conntrack|somaxconn|ip_forward" 2>/dev/null
```

## Kubernetes Node Configuration for Restricted Sysctls

Kubernetes allows pods to set certain safe sysctls when the node is configured to permit them:

```bash
# kubelet flag to allow specific safe sysctls in pods
# /etc/default/kubelet or systemd drop-in
KUBELET_EXTRA_ARGS="--allowed-unsafe-sysctls=net.ipv4.tcp_keepalive_time,net.ipv4.tcp_keepalive_intvl,net.ipv4.tcp_keepalive_probes,kernel.msgmax,kernel.msgmnb"
```

Pod-level sysctl configuration:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: high-performance-app
spec:
  securityContext:
    sysctls:
      # Safe sysctls (namespaced, can be set per pod)
      - name: net.core.somaxconn
        value: "1024"
      - name: net.ipv4.tcp_keepalive_time
        value: "300"
  containers:
    - name: app
      image: app:v1.0.0
```

## Monitoring Kernel Parameter Effectiveness

### Conntrack Table Utilization

```bash
# Prometheus node_exporter exposes conntrack metrics
# node_nf_conntrack_entries: current table size
# node_nf_conntrack_entries_limit: configured maximum

# Alert when conntrack table is 80% full
- alert: ConntrackTableNearlyFull
  expr: |
    node_nf_conntrack_entries / node_nf_conntrack_entries_limit > 0.8
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Node {{ $labels.instance }} conntrack table at {{ $value | humanizePercentage }}"
```

### inotify Exhaustion Detection

```bash
# Check inotify usage across all processes
cat <<'EOF' > /usr/local/bin/check-inotify-usage.sh
#!/bin/bash
echo "=== Top inotify watch consumers ==="
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  watches=$(cat /proc/${pid}/fdinfo/* 2>/dev/null | grep -c "^inotify" 2>/dev/null || echo 0)
  if [ "${watches}" -gt 0 ]; then
    comm=$(cat /proc/${pid}/comm 2>/dev/null || echo "unknown")
    echo "${watches} ${pid} ${comm}"
  fi
done | sort -rn | head -20
echo ""
echo "=== Current limit ==="
cat /proc/sys/fs/inotify/max_user_watches
EOF
chmod +x /usr/local/bin/check-inotify-usage.sh
```

### TCP Socket State Distribution

```bash
# Monitor TIME_WAIT socket accumulation
ss -s

# Output includes:
# Total: 12345
# TCP:   6789 (estab 1234, closed 2345, orphaned 123, timewait 2345)

# Alert if TIME_WAIT sockets are excessive
watch -n 1 'ss -s | grep TCP'
```

## DaemonSet for Kubernetes Node Tuning

Apply sysctl configuration via a DaemonSet during node provisioning:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-tuning
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-tuning
  template:
    metadata:
      labels:
        app: node-tuning
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists
      initContainers:
        - name: tune-node
          image: alpine:3.19
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -c
            - |
              # Apply kernel tuning
              sysctl -w net.core.somaxconn=65535
              sysctl -w net.ipv4.ip_local_port_range="1024 65535"
              sysctl -w fs.inotify.max_user_watches=1048576
              sysctl -w fs.inotify.max_user_instances=8192
              sysctl -w net.netfilter.nf_conntrack_max=1048576
              sysctl -w vm.swappiness=0
              sysctl -w vm.overcommit_memory=1
              echo "Node tuning applied successfully"
          volumeMounts:
            - name: host-proc
              mountPath: /proc
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
          resources:
            requests:
              cpu: 10m
              memory: 10Mi
            limits:
              cpu: 10m
              memory: 10Mi
      volumes:
        - name: host-proc
          hostPath:
            path: /proc
```

## Summary

Production Kubernetes worker nodes require careful kernel parameter tuning to handle the scale and concurrency demands of containerized workloads. The highest-impact parameters are:

- `net.netfilter.nf_conntrack_max`: prevents connection tracking table exhaustion
- `net.ipv4.ip_local_port_range`: prevents ephemeral port exhaustion for outbound connections
- `fs.inotify.max_user_watches` and `max_user_instances`: prevents container startup failures from inotify exhaustion
- `net.core.somaxconn`: prevents connection drops under burst traffic
- `vm.swappiness = 0`: prevents kubelet conflicts over memory management
- `vm.overcommit_memory = 1`: enables Go runtime and containerized applications to allocate memory predictably

These settings should be applied at node provisioning time (via cloud-init, Ansible, or a tuning DaemonSet), validated at startup, and monitored continuously via node_exporter metrics and structured alerting rules.
