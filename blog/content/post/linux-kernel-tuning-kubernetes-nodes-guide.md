---
title: "Linux Kernel Tuning for Kubernetes Nodes: sysctls, Huge Pages, and CPU Scheduling"
date: 2028-04-07T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Kubernetes", "Performance", "sysctls"]
categories: ["Linux", "Kubernetes", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux kernel tuning for Kubernetes worker nodes covering sysctl parameters, transparent huge pages, CPU governor settings, NUMA topology, and IRQ affinity for high-performance workloads."
more_link: "yes"
url: "/linux-kernel-tuning-kubernetes-nodes-guide/"
---

Kubernetes nodes run on Linux, and the default kernel configuration is designed for general-purpose workloads, not high-performance container orchestration. Properly tuning the kernel can reduce p99 latency by 30-50%, increase throughput, and prevent subtle issues like connection timeouts under load. This guide covers every layer of kernel tuning relevant to Kubernetes production nodes.

<!--more-->

# Linux Kernel Tuning for Kubernetes Nodes: sysctls, Huge Pages, and CPU Scheduling

## Why Kernel Tuning Matters for Kubernetes

Kubernetes clusters running production workloads often hit kernel-level bottlenecks before they hit hardware limits. Common symptoms include:

- Connection resets under high concurrency (TCP backlog overflow)
- Intermittent pod communication failures (conntrack table overflow)
- High CPU steal on VMs (scheduling jitter)
- Memory fragmentation causing allocation failures
- I/O latency spikes under write-heavy workloads

Each of these has a kernel-level fix. This guide provides tested configurations for production Kubernetes nodes.

## Baseline: Validating Current Settings

Before making changes, capture your baseline:

```bash
#!/bin/bash
# capture-kernel-baseline.sh

echo "=== Kernel Version ==="
uname -r

echo ""
echo "=== Critical Network Parameters ==="
for param in \
    net.core.somaxconn \
    net.core.netdev_max_backlog \
    net.ipv4.tcp_max_syn_backlog \
    net.ipv4.tcp_fin_timeout \
    net.ipv4.tcp_keepalive_time \
    net.ipv4.tcp_keepalive_intvl \
    net.ipv4.tcp_keepalive_probes \
    net.ipv4.ip_local_port_range \
    net.nf_conntrack_max \
    net.netfilter.nf_conntrack_max \
    net.ipv4.tcp_tw_reuse; do
    echo "$param = $(sysctl -n $param 2>/dev/null || echo 'N/A')"
done

echo ""
echo "=== Memory Parameters ==="
for param in \
    vm.swappiness \
    vm.dirty_ratio \
    vm.dirty_background_ratio \
    vm.min_free_kbytes \
    vm.overcommit_memory \
    vm.overcommit_ratio \
    kernel.panic \
    kernel.panic_on_oops; do
    echo "$param = $(sysctl -n $param 2>/dev/null || echo 'N/A')"
done

echo ""
echo "=== Transparent Huge Pages ==="
cat /sys/kernel/mm/transparent_hugepage/enabled
cat /sys/kernel/mm/transparent_hugepage/defrag

echo ""
echo "=== CPU Governor ==="
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor 2>/dev/null | sort -u

echo ""
echo "=== NUMA Topology ==="
numactl --hardware 2>/dev/null || echo "numactl not installed"

echo ""
echo "=== Conntrack Table ==="
cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null
cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null
```

## Comprehensive sysctl Configuration

Create a single configuration file that covers all required tuning:

```bash
# /etc/sysctl.d/99-kubernetes-production.conf
# Applied via: sysctl --system

###############################################################################
# NETWORK PERFORMANCE
###############################################################################

# Increase the maximum number of connections in the listen() backlog
# Default: 4096, needed: 65535+ for busy ingress nodes
net.core.somaxconn = 65535

# Increase the maximum number of packets in the network device receive queue
# Prevents packet drops under high inbound traffic
net.core.netdev_max_backlog = 65536

# Increase TCP SYN backlog to handle burst connection requests
# Default: 1024, needed: 8192+ for Kubernetes API server and ingress
net.ipv4.tcp_max_syn_backlog = 8192

# Reduce TIME_WAIT socket reuse for high-connection-rate services
# 1 = enable reuse of TIME_WAIT sockets for new connections
net.ipv4.tcp_tw_reuse = 1

# Reduce TIME_WAIT socket duration
# Default: 60s. Reduce to free up ports faster.
net.ipv4.tcp_fin_timeout = 15

# TCP keepalive: detect dead connections faster
# Time (seconds) before starting keepalive probes
net.ipv4.tcp_keepalive_time = 300
# Interval between keepalive probes
net.ipv4.tcp_keepalive_intvl = 30
# Number of probes before marking connection dead
net.ipv4.tcp_keepalive_probes = 3

# Expand the ephemeral port range
# Default: 32768-60999. Expand for high-connection-rate nodes.
net.ipv4.ip_local_port_range = 10000 65535

# TCP buffer sizes — tuned for high-bandwidth, moderate-latency links
# min, default, max (bytes)
net.core.rmem_default = 16777216
net.core.rmem_max = 134217728
net.core.wmem_default = 16777216
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728

# Enable TCP BBR congestion control (requires kernel 4.9+)
# BBR significantly improves throughput and latency over Cubic
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# Reduce TCP retransmission timeout
# Speeds up failure detection in pod-to-pod communication
net.ipv4.tcp_retries2 = 8

###############################################################################
# CONNTRACK: Connection Tracking for kube-proxy
###############################################################################

# Maximum number of tracked connections
# Rule of thumb: 2x the maximum expected concurrent connections
# For 1000 pods with 100 connections each: 200,000+
net.netfilter.nf_conntrack_max = 1048576

# Increase conntrack hash table size for faster lookup
# Must be a power of 2, should be ~1/8 of nf_conntrack_max
net.netfilter.nf_conntrack_buckets = 131072

# Reduce conntrack timeouts to free table entries faster
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30

###############################################################################
# MEMORY MANAGEMENT
###############################################################################

# Disable swap — Kubernetes strongly recommends swap=off
# (or configure swap behavior per the kubelet configuration)
vm.swappiness = 0

# Dirty page writeback tuning
# How much dirty data to accumulate before writing (% of RAM)
vm.dirty_ratio = 20
# Background writeback threshold
vm.dirty_background_ratio = 10
# Maximum age of dirty data before forced writeback (centiseconds)
vm.dirty_expire_centisecs = 1000
vm.dirty_writeback_centisecs = 500

# Minimum free memory — prevents OOM situations
# Set to ~1% of total RAM (adjust for your node size)
vm.min_free_kbytes = 1048576

# Memory overcommit — allow overcommit for container density
# 1 = always allow overcommit (relies on OOM killer when needed)
# 0 = use heuristic (recommended for most workloads)
vm.overcommit_memory = 1

# Virtual memory area limit for applications like Elasticsearch
# elasticsearch, prometheus, and similar need 262144+
vm.max_map_count = 262144

###############################################################################
# FILE DESCRIPTORS AND INOTIFY
###############################################################################

# Maximum number of open files
# Kubernetes controllers, container runtimes, and monitoring need many FDs
fs.file-max = 2097152

# Inotify limits — for monitoring tools and Kubernetes watchers
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 8192
fs.inotify.max_queued_events = 65536

###############################################################################
# KERNEL BEHAVIOR
###############################################################################

# Reboot on kernel panic after 10 seconds
kernel.panic = 10
# Panic on oops (prevents hung zombie nodes in cluster)
kernel.panic_on_oops = 1

# Reduce ARP cache timeouts for faster failure detection
net.ipv4.neigh.default.gc_stale_time = 120
net.ipv4.neigh.default.gc_thresh1 = 1024
net.ipv4.neigh.default.gc_thresh2 = 4096
net.ipv4.neigh.default.gc_thresh3 = 8192

# Increase the maximum PID value to prevent pid reuse issues
kernel.pid_max = 4194304

# Bridge netfilter — required for kube-proxy to see bridged traffic
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-arptables = 1

# IP forwarding — required for pod networking
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1

# Disable ICMP redirects (security and routing stability)
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
```

### Applying sysctl Settings

```bash
# Apply immediately without reboot
sysctl --system

# Verify a specific setting
sysctl net.netfilter.nf_conntrack_max

# Verify all settings from file
sysctl -p /etc/sysctl.d/99-kubernetes-production.conf

# Check conntrack usage in real-time
watch -n1 'cat /proc/sys/net/netfilter/nf_conntrack_count'
```

## Transparent Huge Pages

Transparent Huge Pages (THP) can cause latency spikes in latency-sensitive workloads due to unpredictable compaction. The correct setting depends on your workload type.

```bash
# /etc/rc.local or a systemd service
#!/bin/bash

# Disable THP for most Kubernetes workloads
# Databases (Redis, MongoDB, Cassandra) strongly prefer this
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# If you need THP for compute-intensive workloads (ML, analytics):
# echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
# echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

Create a systemd service for persistence:

```ini
# /etc/systemd/system/disable-thp.service
[Unit]
Description=Disable Transparent Huge Pages (THP)
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=kubelet.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now disable-thp.service
```

### Application-Level THP with madvise

For applications that benefit from huge pages (HPC, ML workloads), use madvise mode so only explicitly requesting processes get huge pages:

```bash
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

Then in application code:
```c
// Request huge pages for a specific memory region
madvise(ptr, size, MADV_HUGEPAGE);
```

## Static Huge Pages

For ultra-low-latency workloads (financial systems, real-time databases), pre-allocate huge pages at boot:

```bash
# /etc/default/grub — add to GRUB_CMDLINE_LINUX
# Allocate 512 x 2MB huge pages (1GB total)
GRUB_CMDLINE_LINUX="... hugepages=512 hugepagesz=2M"

# Or for 1GB pages (requires hardware support)
GRUB_CMDLINE_LINUX="... hugepagesz=1G hugepages=8"

# Regenerate grub config
grub2-mkconfig -o /boot/grub2/grub.cfg
```

Runtime allocation (may fail if memory is fragmented):

```bash
# Allocate 2M huge pages at runtime
echo 512 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Verify allocation
grep HugePages /proc/meminfo
```

Kubernetes pod requesting huge pages:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hugepage-app
spec:
  containers:
  - name: app
    image: hugepage-app:latest
    resources:
      requests:
        hugepages-2Mi: 512Mi
        memory: 2Gi
        cpu: 2
      limits:
        hugepages-2Mi: 512Mi
        memory: 2Gi
        cpu: 2
    volumeMounts:
    - name: hugepage-vol
      mountPath: /hugepages
  volumes:
  - name: hugepage-vol
    emptyDir:
      medium: HugePages
```

## CPU Frequency Scaling

The default CPU governor on cloud VMs is often `powersave`, which introduces latency. For Kubernetes nodes, use `performance`:

```bash
#!/bin/bash
# set-cpu-performance.sh

# Check available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors

# Set performance governor on all CPUs
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > "$cpu"
done

# Verify
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort -u
```

Systemd service for persistence:

```ini
# /etc/systemd/system/cpu-performance.service
[Unit]
Description=Set CPU Governor to Performance
After=sysinit.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance > "$f"; done'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

On Intel systems, also disable Turbo Boost jitter (optional, reduces latency variance):

```bash
# Disable Intel Turbo Boost for consistent latency
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo
```

## NUMA Topology Awareness

For multi-socket servers, improper NUMA binding causes cache thrash and remote memory access latency:

```bash
# Check NUMA topology
numactl --hardware
lstopo --of ascii  # Requires hwloc package

# Check NUMA memory stats
numastat -m

# Verify kubelet NUMA policy
cat /var/lib/kubelet/config.yaml | grep -A5 topologyManager
```

```yaml
# kubelet configuration for NUMA-aware scheduling
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: best-effort
# Options: none (default), best-effort, restricted, single-numa-node
topologyManagerScope: container
cpuManagerPolicy: static
# static enables exclusive CPU assignment for Guaranteed QoS pods
reservedSystemCPUs: "0,1"  # Reserve CPUs 0 and 1 for system tasks
```

For single-NUMA-node strict alignment:

```yaml
topologyManagerPolicy: single-numa-node
```

This requires pods to be Guaranteed QoS class (equal requests and limits) to benefit from exclusive CPU alignment.

## IRQ Affinity

Distribute network IRQs across CPUs to prevent a single CPU from handling all network interrupts:

```bash
#!/bin/bash
# configure-irq-affinity.sh
# Distributes network device IRQs across all available CPUs

INTERFACE="${1:-eth0}"
NUM_CPUS=$(nproc)

echo "Configuring IRQ affinity for $INTERFACE across $NUM_CPUS CPUs"

# Find IRQs for the network interface
IRQS=$(grep "$INTERFACE" /proc/interrupts | awk '{print $1}' | tr -d ':')

CPU=0
for irq in $IRQS; do
    # Create CPU affinity mask for this IRQ
    MASK=$(printf "%x" $((1 << CPU)))
    echo "$MASK" > /proc/irq/$irq/smp_affinity
    echo "IRQ $irq -> CPU $CPU (mask: 0x$MASK)"
    CPU=$(( (CPU + 1) % NUM_CPUS ))
done

# Verify
echo ""
echo "Current IRQ affinity:"
for irq in $IRQS; do
    echo "  IRQ $irq: $(cat /proc/irq/$irq/smp_affinity_list)"
done
```

For multi-queue NIC (most modern cloud VMs), use `irqbalance` with a policy file:

```bash
# /etc/sysconfig/irqbalance
IRQBALANCE_ONESHOT=0
IRQBALANCE_BANNED_CPUS=0,1  # Don't assign IRQs to reserved CPUs
```

## Disk I/O Scheduler

```bash
# Check current scheduler
cat /sys/block/nvme0n1/queue/scheduler

# For SSDs/NVMe: use 'none' or 'mq-deadline'
echo none > /sys/block/nvme0n1/queue/scheduler

# For spinning disks (rare in cloud): use 'mq-deadline'
echo mq-deadline > /sys/block/sda/queue/scheduler

# Increase read-ahead for sequential workloads
# Default: 128 (512-byte sectors = 64KB)
# For database workloads: reduce to 0
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb

# Increase nr_requests for high-IOPS workloads
echo 1024 > /sys/block/nvme0n1/queue/nr_requests
```

Persist with udev rules:

```
# /etc/udev/rules.d/60-disk-scheduler.rules
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq"
```

## Kernel Module Configuration

```bash
# /etc/modules-load.d/kubernetes.conf
# Load required kernel modules at boot

# For kube-proxy with iptables or ipvs
br_netfilter
overlay

# For IPVS mode kube-proxy (better performance at scale)
ip_vs
ip_vs_rr
ip_vs_wrr
ip_vs_sh
nf_conntrack

# For network policy enforcement
xt_conntrack
xt_REDIRECT
xt_owner
xt_statistic
```

```bash
# /etc/modprobe.d/kubernetes.conf
# Module parameters

# Increase conntrack hash table size (must match sysctl setting)
options nf_conntrack hashsize=131072
```

## Automated Node Tuning with DaemonSet

Deploy a DaemonSet to apply kernel tuning across all nodes:

```yaml
# daemonset-node-tuner.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-tuner
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: node-tuner
  template:
    metadata:
      labels:
        name: node-tuner
    spec:
      hostIPC: true
      hostPID: true
      hostNetwork: true
      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
      volumes:
      - name: host-sys
        hostPath:
          path: /sys
      - name: host-proc
        hostPath:
          path: /proc
      initContainers:
      - name: kernel-tuner
        image: busybox:latest
        securityContext:
          privileged: true
        command: ["/bin/sh", "-c"]
        args:
        - |
          set -ex

          # Apply sysctl settings
          sysctl -w net.core.somaxconn=65535
          sysctl -w net.netfilter.nf_conntrack_max=1048576
          sysctl -w vm.swappiness=0
          sysctl -w vm.max_map_count=262144
          sysctl -w fs.inotify.max_user_watches=1048576
          sysctl -w net.ipv4.tcp_tw_reuse=1

          # Disable THP
          echo never > /sys/kernel/mm/transparent_hugepage/enabled
          echo never > /sys/kernel/mm/transparent_hugepage/defrag

          # Set CPU performance governor
          for gov in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
            [ -f "$gov" ] && echo performance > "$gov"
          done

          echo "Node tuning applied successfully"
        volumeMounts:
        - name: host-sys
          mountPath: /sys
        - name: host-proc
          mountPath: /proc
      containers:
      - name: pause
        image: k8s.gcr.io/pause:3.9
        resources:
          requests:
            cpu: 10m
            memory: 10Mi
          limits:
            cpu: 10m
            memory: 10Mi
```

## Performance Validation

```bash
#!/bin/bash
# validate-kernel-tuning.sh

PASS=0
FAIL=0

check_sysctl() {
    local param="$1"
    local expected="$2"
    local actual
    actual=$(sysctl -n "$param" 2>/dev/null)
    if [ "$actual" = "$expected" ]; then
        echo "[PASS] $param = $actual"
        ((PASS++))
    else
        echo "[FAIL] $param = $actual (expected: $expected)"
        ((FAIL++))
    fi
}

check_ge() {
    local param="$1"
    local min="$2"
    local actual
    actual=$(sysctl -n "$param" 2>/dev/null)
    if [ "$actual" -ge "$min" ] 2>/dev/null; then
        echo "[PASS] $param = $actual (>= $min)"
        ((PASS++))
    else
        echo "[FAIL] $param = $actual (expected >= $min)"
        ((FAIL++))
    fi
}

echo "=== Kernel Tuning Validation ==="

check_ge net.core.somaxconn 65535
check_ge net.netfilter.nf_conntrack_max 1000000
check_sysctl vm.swappiness 0
check_sysctl net.ipv4.ip_forward 1
check_sysctl net.bridge.bridge-nf-call-iptables 1
check_ge vm.max_map_count 262144
check_ge fs.inotify.max_user_watches 1048576

# Check THP
thp=$(cat /sys/kernel/mm/transparent_hugepage/enabled)
if echo "$thp" | grep -q '\[never\]'; then
    echo "[PASS] THP disabled"
    ((PASS++))
else
    echo "[FAIL] THP not disabled: $thp"
    ((FAIL++))
fi

# Check CPU governor
gov=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null)
if [ "$gov" = "performance" ]; then
    echo "[PASS] CPU governor = performance"
    ((PASS++))
else
    echo "[WARN] CPU governor = ${gov:-unknown}"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
```

## Conntrack Monitoring and Alerting

```bash
# Prometheus exporter for conntrack metrics
# Add to node-exporter textfile collector

#!/bin/bash
# /usr/local/bin/conntrack-metrics.sh

OUTPUT_FILE="/var/lib/node-exporter/conntrack.prom"

current=$(cat /proc/sys/net/netfilter/nf_conntrack_count)
max=$(cat /proc/sys/net/netfilter/nf_conntrack_max)
ratio=$(echo "scale=4; $current / $max" | bc)

cat > "$OUTPUT_FILE" << EOF
# HELP node_conntrack_entries Current number of conntrack entries
# TYPE node_conntrack_entries gauge
node_conntrack_entries $current

# HELP node_conntrack_entries_limit Maximum conntrack entries
# TYPE node_conntrack_entries_limit gauge
node_conntrack_entries_limit $max

# HELP node_conntrack_utilization Fraction of conntrack table used
# TYPE node_conntrack_utilization gauge
node_conntrack_utilization $ratio
EOF
```

```yaml
# Alert on conntrack table exhaustion
- alert: ConntrackTableNearlyFull
  expr: node_conntrack_utilization > 0.85
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Conntrack table nearly full on {{ $labels.instance }}"
    description: "{{ $value | humanizePercentage }} of conntrack table used. Packets will be dropped when full."
```

## Summary of Key Parameters

| Parameter | Default | Recommended | Why |
|-----------|---------|-------------|-----|
| `net.core.somaxconn` | 4096 | 65535 | Handle connection bursts |
| `net.netfilter.nf_conntrack_max` | 65536 | 1048576 | Support many concurrent connections |
| `vm.swappiness` | 60 | 0 | Prevent swap causing pod evictions |
| `vm.max_map_count` | 65530 | 262144 | Required for Elasticsearch/Prometheus |
| `fs.inotify.max_user_watches` | 8192 | 1048576 | Support many container watchers |
| `net.ipv4.tcp_tw_reuse` | 0 | 1 | Reuse TIME_WAIT sockets faster |
| THP | `always` | `never` | Prevent latency spikes |
| CPU Governor | `powersave` | `performance` | Eliminate frequency scaling latency |

Applying these settings requires rebooting nodes in a rolling fashion or using a DaemonSet initContainer for immediate effect without disruption. Always validate changes in a non-production environment first, as specific workloads may respond differently to individual parameter changes.
