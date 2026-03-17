---
title: "Linux Performance Tuning for Kubernetes Nodes: Kernel Parameters and System Optimization"
date: 2027-12-01T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Kubernetes", "Kernel", "Tuning"]
categories:
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux performance tuning for Kubernetes nodes, covering kernel parameters, inotify limits, TCP tuning, CPU governors, huge pages, cgroup v2 migration, I/O schedulers, NUMA topology, and benchmarking."
more_link: "yes"
url: "/linux-performance-tuning-kubernetes-nodes/"
---

The performance of a Kubernetes cluster is ultimately bounded by the Linux kernel configuration on its nodes. Default kernel parameters are tuned for general-purpose workloads, not for high-density container environments handling thousands of pods, tens of thousands of open file descriptors, and millions of netfilter connections. This guide covers the kernel-level optimizations that prevent subtle performance degradation and hard failures in production Kubernetes nodes.

<!--more-->

# Linux Performance Tuning for Kubernetes Nodes: Kernel Parameters and System Optimization

## Why Default Kernel Parameters Fail at Scale

When Kubernetes nodes hit production load, the first failures are rarely CPU or memory exhaustion. They are often:

- "Too many open files" errors when a pod tries to create file descriptors
- inotify watch limit exhaustion causing health check failures
- conntrack table overflow causing connection drops silently
- Insufficient ARP cache space causing intermittent communication failures
- Thundering herd issues under high pod churn

These failures are difficult to diagnose because they appear as application errors, not infrastructure errors. The fix is kernel parameter tuning applied consistently across all nodes.

## Section 1: Applying Kernel Parameters

### The sysctl Configuration Pattern

```bash
# Apply configuration via sysctl.d for persistence
# Split into logically grouped files for maintainability

# kubernetes-networking.conf
# kubernetes-fs.conf
# kubernetes-vm.conf
# kubernetes-kernel.conf

# Apply immediately (for running systems)
sysctl --system

# Verify
sysctl -a | grep net.ipv4.tcp_keepalive
```

### Infrastructure as Code with Ansible

```yaml
# roles/k8s-node-tuning/tasks/main.yml
---
- name: Apply Kubernetes node kernel parameters
  ansible.posix.sysctl:
    name: "{{ item.key }}"
    value: "{{ item.value }}"
    sysctl_file: /etc/sysctl.d/99-kubernetes.conf
    reload: true
    state: present
  loop: "{{ kubernetes_sysctl_params | dict2items }}"

# roles/k8s-node-tuning/vars/main.yml
kubernetes_sysctl_params:
  # inotify limits
  fs.inotify.max_user_watches: 524288
  fs.inotify.max_user_instances: 512
  fs.inotify.max_queued_events: 16384
  # File descriptor limits
  fs.file-max: 2097152
  fs.nr_open: 1048576
  # Network
  net.ipv4.ip_forward: 1
  net.bridge.bridge-nf-call-iptables: 1
  net.bridge.bridge-nf-call-ip6tables: 1
  # conntrack
  net.netfilter.nf_conntrack_max: 1048576
  net.netfilter.nf_conntrack_tcp_timeout_established: 86400
  net.netfilter.nf_conntrack_tcp_timeout_time_wait: 120
  # TCP tuning
  net.ipv4.tcp_keepalive_time: 600
  net.ipv4.tcp_keepalive_intvl: 60
  net.ipv4.tcp_keepalive_probes: 5
  net.ipv4.tcp_fin_timeout: 30
  net.ipv4.tcp_max_syn_backlog: 8192
  net.ipv4.tcp_max_tw_buckets: 2000000
  net.core.somaxconn: 65535
  net.core.netdev_max_backlog: 250000
  # Memory
  vm.swappiness: 0
  vm.overcommit_memory: 1
  vm.panic_on_oom: 0
```

## Section 2: inotify Limits

inotify is the Linux kernel subsystem that monitors filesystem changes. Every Kubernetes component that watches files uses inotify watches: kubelet, container runtime, monitoring agents, and application code.

### Understanding inotify Limits

```bash
# Current limits
sysctl fs.inotify.max_user_watches     # Default: 8192
sysctl fs.inotify.max_user_instances   # Default: 128
sysctl fs.inotify.max_queued_events    # Default: 16384

# Check current inotify usage
# Count watches per process
for pid in /proc/[0-9]*/; do
  pid_num="${pid//[^0-9]/}"
  watches=$(cat "/proc/$pid_num/fdinfo"/* 2>/dev/null | grep -c inotify)
  if [ "$watches" -gt 0 ]; then
    process=$(cat "/proc/$pid_num/comm" 2>/dev/null)
    echo "$watches $process (PID: $pid_num)"
  fi
done | sort -rn | head -20

# Total inotify watches in use
cat /proc/sys/fs/inotify/max_user_watches
find /proc/*/fd -lname 'anon_inode:inotify' 2>/dev/null | wc -l
```

### inotify Limits for Kubernetes

```bash
# /etc/sysctl.d/60-kubernetes-inotify.conf

# max_user_watches: Maximum number of files a single user can watch
# kubelet alone uses several hundred watches per pod
# 524288 = 512K watches, sufficient for 500+ pods per node
fs.inotify.max_user_watches = 524288

# max_user_instances: Maximum inotify instances per user
# Each process that calls inotify_init() creates an instance
# 512 is sufficient for high-density nodes
fs.inotify.max_user_instances = 512

# max_queued_events: Queue size for events
# Large queues prevent event loss under heavy filesystem activity
fs.inotify.max_queued_events = 16384
```

### When inotify Limits Are Exceeded

```bash
# Check for inotify limit errors in system journal
journalctl -k | grep -i inotify
journalctl -u kubelet | grep -i "inotify\|too many open"

# Check dmesg for limit errors
dmesg | grep -i "inotify\|watch"

# Common error messages when limits are hit:
# "failed to add inotify watch ... too many open files"
# "ENOSPC: no space left on device" (misleading - actually inotify limit)
# "failed to watch directory: no space left on device"

# Verify limit was applied
sysctl fs.inotify.max_user_watches
cat /proc/sys/fs/inotify/max_user_watches
```

## Section 3: File Descriptor Limits

### System-Wide File Descriptor Limits

```bash
# /etc/sysctl.d/60-kubernetes-fd.conf

# Maximum system-wide file descriptors
# Each socket, pipe, file, and device counts as an fd
# For high-density nodes: 2M is a safe upper bound
fs.file-max = 2097152

# Maximum open files per process (hard limit)
fs.nr_open = 1048576
```

### Per-Process Limits (PAM/ulimit)

```bash
# /etc/security/limits.d/99-kubernetes.conf
*       soft    nofile  1048576
*       hard    nofile  1048576
root    soft    nofile  1048576
root    hard    nofile  1048576
*       soft    nproc   65536
*       hard    nproc   65536

# Verify limits are applied
ulimit -n
cat /proc/1/limits | grep 'Open files'

# Check container fd limits
# containerd uses the system defaults unless overridden
cat /etc/systemd/system/containerd.service.d/override.conf 2>/dev/null || \
  cat /lib/systemd/system/containerd.service | grep -A 10 '\[Service\]'
```

### systemd Service File Descriptor Limits

```ini
# /etc/systemd/system/kubelet.service.d/override.conf
[Service]
LimitNOFILE=1048576
LimitNPROC=65536

# /etc/systemd/system/containerd.service.d/override.conf
[Service]
LimitNOFILE=1048576
LimitNPROC=65536
```

```bash
# Apply service overrides
systemctl daemon-reload
systemctl restart kubelet containerd

# Verify
cat /proc/$(pidof kubelet)/limits | grep 'Open files'
```

## Section 4: Network Parameter Tuning

### conntrack Table Size

The conntrack (connection tracking) table maintains state for all active TCP and UDP connections. Kubernetes services use conntrack extensively for NAT. When the table fills, new connections are silently dropped.

```bash
# /etc/sysctl.d/60-kubernetes-netfilter.conf

# conntrack table size - number of tracked connections
# For a node handling 1000 pods with 100 concurrent connections each: 100,000
# Add 10x headroom: 1,000,000
net.netfilter.nf_conntrack_max = 1048576

# Buckets (hash table size) = conntrack_max / 4
# Set in /etc/modprobe.d/netfilter.conf:
# options nf_conntrack hashsize=262144

# Timeout values - reduce for high-connection-churn environments
# Default TIME_WAIT timeout is 120s, which is excessive for service mesh traffic
net.netfilter.nf_conntrack_tcp_timeout_established = 86400   # 24h (reduce from default if needed)
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30        # Reduced from 120s
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 60
```

```bash
# Check current conntrack usage
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Calculate utilization
COUNT=$(cat /proc/sys/net/netfilter/nf_conntrack_count)
MAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max)
echo "conntrack utilization: $COUNT/$MAX ($(( COUNT * 100 / MAX ))%)"

# View current conntrack entries
conntrack -L 2>/dev/null | head -20

# Check for conntrack drops
netstat -s | grep -i conntrack 2>/dev/null
nstat -az | grep NfConntrackTable
```

### TCP Stack Tuning

```bash
# /etc/sysctl.d/60-kubernetes-tcp.conf

# TCP keepalive - detect dead connections faster
# Kubernetes services and pod networking benefit from faster keepalive detection
net.ipv4.tcp_keepalive_time = 600       # Start sending keepalives after 10 minutes idle
net.ipv4.tcp_keepalive_intvl = 60       # Interval between keepalive probes
net.ipv4.tcp_keepalive_probes = 5       # Probes before declaring connection dead

# SYN flood protection
net.ipv4.tcp_max_syn_backlog = 8192     # SYN queue size
net.ipv4.tcp_syncookies = 1            # Enable SYN cookies

# Connection queue
net.core.somaxconn = 65535             # Maximum socket backlog
net.core.netdev_max_backlog = 250000   # Receive queue per network device

# TIME_WAIT buckets
net.ipv4.tcp_max_tw_buckets = 2000000  # Maximum TIME_WAIT sockets
net.ipv4.tcp_fin_timeout = 30          # Reduce FIN_WAIT2 timeout

# Receive/send buffer sizes
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.core.rmem_max = 134217728          # 128MB
net.core.wmem_max = 134217728          # 128MB
net.ipv4.tcp_rmem = "4096 87380 134217728"
net.ipv4.tcp_wmem = "4096 65536 134217728"
net.ipv4.tcp_mem = "786432 1048576 26777216"

# TIME_WAIT socket reuse (for high-connection-churn services)
net.ipv4.tcp_tw_reuse = 1             # Allow reuse in TIME_WAIT for new connections

# TCP window scaling - important for high-bandwidth scenarios
net.ipv4.tcp_window_scaling = 1

# BBR congestion control (requires kernel 4.9+)
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq
```

### ARP Cache Tuning

```bash
# /etc/sysctl.d/60-kubernetes-arp.conf

# ARP cache limits - increase for large clusters
# Default values cause "neighbor table overflow" in large pods-per-node deployments
net.ipv4.neigh.default.gc_thresh1 = 4096   # No GC below this (was 128)
net.ipv4.neigh.default.gc_thresh2 = 8192   # Trigger GC above this (was 512)
net.ipv4.neigh.default.gc_thresh3 = 16384  # Hard limit (was 1024)
net.ipv4.neigh.default.gc_interval = 30
net.ipv4.neigh.default.gc_stale_time = 60
```

## Section 5: Memory Management

### Swap Disable for Kubernetes

Kubernetes requires swap to be disabled. If swap is enabled, the kubelet will refuse to start by default.

```bash
# Disable swap immediately
swapoff -a

# Disable swap permanently
# Comment out swap entries in /etc/fstab
sed -i '/ swap / s/^\(.*\)$/#\1/g' /etc/fstab

# Verify
free -h | grep Swap
swapon --show

# Kubernetes parameter for memory
# vm.swappiness = 0 ensures kernel never uses swap (defense in depth)
```

### Memory Overcommit

```bash
# /etc/sysctl.d/60-kubernetes-vm.conf

# Allow memory overcommit - required for container resource requests/limits model
# 0 = heuristic (default) - may refuse some allocations
# 1 = always allow - recommended for Kubernetes
vm.overcommit_memory = 1

# Keep OOM killer from panicking the node
vm.panic_on_oom = 0

# OOM kill score adjustment - kubelet manages this per-container
vm.oom_kill_allocating_task = 0

# Dirty page limits - tune for write-heavy workloads
vm.dirty_ratio = 15            # Start writeback at 15% dirty pages
vm.dirty_background_ratio = 5  # Background writeback at 5%
vm.dirty_expire_centisecs = 3000  # 30 seconds before dirty pages are expired
vm.dirty_writeback_centisecs = 500 # Write back every 5 seconds

# Memory compaction for huge pages
vm.compaction_proactiveness = 20
```

### Transparent Huge Pages

```bash
# Kubernetes documentation recommends disabling THP
# THP can cause latency spikes due to compaction overhead

# Check current THP setting
cat /sys/kernel/mm/transparent_hugepage/enabled
cat /sys/kernel/mm/transparent_hugepage/defrag

# Disable THP
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Make persistent via systemd
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages
After=sysinit.target local-fs.target
Before=kubelet.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now disable-thp
```

### Explicit Huge Pages (for Memory-Intensive Workloads)

For workloads like databases that benefit from huge pages (2MB or 1GB):

```bash
# Configure 2MB huge pages at boot
# Add to kernel command line: hugepagesz=2M hugepages=512
# This allocates 1GB of huge pages

# Check availability
cat /proc/meminfo | grep HugePages

# Reserve huge pages at runtime (before memory becomes fragmented)
echo 512 > /proc/sys/vm/nr_hugepages

# Verify
grep HugePages /proc/meminfo

# In /etc/sysctl.d for persistence (boot-time allocation more reliable)
vm.nr_hugepages = 512

# Pod using huge pages
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: database
    resources:
      limits:
        hugepages-2Mi: 1Gi
        memory: 4Gi
      requests:
        hugepages-2Mi: 1Gi
        memory: 4Gi
    volumeMounts:
    - mountPath: /hugepages
      name: hugepage
  volumes:
  - name: hugepage
    emptyDir:
      medium: HugePages
```

## Section 6: CPU Governor Settings

### CPU Frequency Scaling

```bash
# Check current CPU governor
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

# Available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors

# For Kubernetes nodes: use performance governor to prevent CPU throttling
# which can cause latency spikes and timeout failures

# Set all CPUs to performance governor
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance > "$cpu"
done

# Verify
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort -u

# Make persistent
apt-get install -y cpufrequtils
echo 'GOVERNOR="performance"' > /etc/default/cpufrequtils
systemctl enable cpufrequtils
```

### BIOS/Hardware Settings

```bash
# These cannot be set from the OS but should be verified in BIOS:
# - Disable CPU C-states (or limit to C1)
# - Enable CPU Turbo mode
# - Set power profile to "Performance" or "Maximum Performance"
# - Disable NUMA balancing in BIOS if you manage it manually

# Check current C-state configuration
cat /sys/module/intel_idle/parameters/max_cstate
# Set max C-state to C1 (prevents deep sleep latency)
# Add to kernel command line: intel_idle.max_cstate=1

# Check NUMA topology
numactl --hardware
numastat

# Disable automatic NUMA balancing (manage manually if needed)
echo 0 > /proc/sys/kernel/numa_balancing
# sysctl: kernel.numa_balancing = 0
```

## Section 7: Disk I/O Schedulers

### Block Device Scheduler Selection

```bash
# Check current scheduler for each disk
for dev in /sys/block/*/queue/scheduler; do
  echo "$dev: $(cat "$dev")"
done

# For SSDs and NVMe: use none or mq-deadline
# For HDDs: use bfq or mq-deadline
# For cloud provider block storage (EBS, GCE PD): use none (latency is already managed)

# Set scheduler
echo none > /sys/block/nvme0n1/queue/scheduler
echo mq-deadline > /sys/block/sda/queue/scheduler

# Make persistent via udev rules
cat > /etc/udev/rules.d/60-io-scheduler.rules << 'EOF'
# NVMe drives - use none (null scheduler)
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]p[0-9]", ATTR{queue/scheduler}="none"

# Rotational disks - use bfq
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq"

# SSDs - use mq-deadline
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
EOF

udevadm control --reload-rules
udevadm trigger
```

### Queue Depth Tuning

```bash
# Increase queue depth for NVMe (supports deep queues)
echo 64 > /sys/block/nvme0n1/queue/nr_requests

# For cloud block storage: moderate depth
echo 32 > /sys/block/sda/queue/nr_requests

# Read-ahead setting
# Increase for sequential workloads (logging, streaming)
# Decrease for databases with random I/O
blockdev --setra 256 /dev/nvme0n1   # 128KB read-ahead (256 * 512 bytes)
blockdev --setra 0 /dev/sdb         # Disable read-ahead for database device

# Persistent via udev
cat > /etc/udev/rules.d/60-blockdev-readahead.rules << 'EOF'
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{bdi/read_ahead_kb}="128"
ACTION=="add|change", KERNEL=="sda", ATTR{bdi/read_ahead_kb}="0"
EOF
```

## Section 8: cgroup v2 Migration

Kubernetes 1.25+ requires cgroup v2 for full feature support including memory QoS, PSI (Pressure Stall Information), and eBPF-based resource limits.

### Checking cgroup Version

```bash
# Check which cgroup version is in use
stat -fc %T /sys/fs/cgroup/

# If output is "tmpfs": cgroup v1
# If output is "cgroup2fs": cgroup v2

# Also check via systemd
systemctl show | grep 'DefaultMemoryPressureWatch\|DefaultTasksMax'

# Check kubelet configuration
cat /var/lib/kubelet/config.yaml | grep cgroup
```

### Enabling cgroup v2

```bash
# On systemd-based systems, enable unified cgroup hierarchy
# Add to kernel command line in /etc/default/grub:
# GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"

# Update grub
sed -i 's/GRUB_CMDLINE_LINUX="\(.*\)"/GRUB_CMDLINE_LINUX="\1 systemd.unified_cgroup_hierarchy=1"/' /etc/default/grub
update-grub

# Verify after reboot
stat -fc %T /sys/fs/cgroup/

# Update kubelet to use cgroup v2
cat > /etc/kubernetes/kubelet-config.yaml << 'EOF'
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
cgroupVersion: v2
featureGates:
  MemoryQoS: true
memorySwap:
  swapBehavior: NoSwap
EOF
```

### kubelet cgroup Configuration

```yaml
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# cgroup driver - must match container runtime (containerd default: systemd)
cgroupDriver: systemd
cgroupRoot: /

# Resource reservation for system processes
# Prevents pods from starving the node OS
kubeReserved:
  cpu: 200m
  memory: 512Mi
  ephemeral-storage: 2Gi

# Reservation for kubelet and container runtime
systemReserved:
  cpu: 200m
  memory: 512Mi
  ephemeral-storage: 2Gi

# Eviction thresholds
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "5%"
  nodefs.inodesFree: "5%"
  imagefs.available: "10%"

evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "10%"
evictionSoftGracePeriod:
  memory.available: "2m"
  nodefs.available: "5m"

# Max pods per node
maxPods: 110

# Pod CIDR (set by controller)
podCIDR: ""

# CPU management policy
cpuManagerPolicy: static
reservedSystemCPUs: "0-1"  # Reserve first 2 CPUs for system

# Topology manager
topologyManagerPolicy: best-effort

# Memory manager
memoryManagerPolicy: None
```

## Section 9: NUMA Topology Awareness

### NUMA Configuration for Database Nodes

```bash
# Check NUMA topology
numactl --hardware
# output shows: available nodes, node distances, node memory

# Check which CPUs and memory belong to each NUMA node
lscpu | grep NUMA
numactl --hardware | grep -E 'node [0-9]+ cpus:|node [0-9]+ size:'

# Check current NUMA memory allocation
numastat

# Bind a process to a specific NUMA node
numactl --cpunodebind=0 --membind=0 -- ./database-process

# For Kubernetes, configure topology manager
# In kubelet config:
# topologyManagerPolicy: single-numa-node
# This ensures pods requiring multiple resources get them from the same NUMA node
```

### Kubelet Topology Manager

```yaml
# In /etc/kubernetes/kubelet-config.yaml:
topologyManagerPolicy: single-numa-node
# Options:
# none: default, no topology awareness
# best-effort: try to allocate from single NUMA, fall back to any
# restricted: allocate from single NUMA or reject
# single-numa-node: must allocate from a single NUMA node

# Required companion settings for full topology management:
cpuManagerPolicy: static  # Must be static for NUMA-aware CPU allocation
memoryManagerPolicy: Static  # Must be Static for NUMA-aware memory allocation

# Reserved memory per NUMA node
reservedMemory:
- numaNode: 0
  limits:
    memory: 1Gi
- numaNode: 1
  limits:
    memory: 1Gi
```

## Section 10: Benchmarking with sysbench and fio

### CPU Benchmarking with sysbench

```bash
# Install sysbench
apt-get install -y sysbench

# CPU benchmark - measures prime number calculation throughput
sysbench cpu \
  --cpu-max-prime=20000 \
  --threads=$(nproc) \
  run

# Memory benchmark - measures memory bandwidth
sysbench memory \
  --memory-block-size=1K \
  --memory-total-size=100G \
  --memory-operation=write \
  --threads=$(nproc) \
  run

# Thread benchmark - measures scheduler performance
sysbench threads \
  --thread-locks=4 \
  --threads=64 \
  run

# Mutex benchmark - measures lock contention
sysbench mutex \
  --mutex-num=4096 \
  --mutex-locks=50000 \
  --mutex-loops=10000 \
  --threads=64 \
  run
```

### Storage Benchmarking with fio

```bash
# Install fio
apt-get install -y fio

# Create a test directory on the storage you want to benchmark
TEST_DIR="/var/lib/kubelet/test-bench"
mkdir -p "$TEST_DIR"

# Sequential write throughput (simulates log writing)
fio --name=seq-write \
  --ioengine=libaio \
  --iodepth=1 \
  --rw=write \
  --bs=1M \
  --direct=1 \
  --size=4G \
  --numjobs=1 \
  --filename="$TEST_DIR/test.dat" \
  --output-format=json | jq '.jobs[0].write | {bw_mbps: (.bw / 1024 | round), iops: (.iops | round), lat_ms: (.lat_ns.mean / 1000000 | round * 100 / 100)}'

# Random 4K read (simulates database reads)
fio --name=rand-read-4k \
  --ioengine=libaio \
  --iodepth=64 \
  --rw=randread \
  --bs=4k \
  --direct=1 \
  --size=4G \
  --numjobs=4 \
  --filename="$TEST_DIR/test.dat" \
  --output-format=json | jq '.jobs | map(.read) | {total_iops: (map(.iops) | add | round), avg_lat_us: (map(.lat_ns.mean) | add / length / 1000 | round)}'

# Mixed read/write (simulates OLTP workload)
fio --name=oltp-mixed \
  --ioengine=libaio \
  --iodepth=32 \
  --rw=randrw \
  --rwmixread=70 \
  --bs=4k \
  --direct=1 \
  --size=4G \
  --numjobs=4 \
  --filename="$TEST_DIR/test.dat" \
  --output-format=json | jq '{
    read_iops: ([.jobs[].read.iops] | add | round),
    write_iops: ([.jobs[].write.iops] | add | round),
    read_lat_us: ([.jobs[].read.lat_ns.mean] | add / length / 1000 | round),
    write_lat_us: ([.jobs[].write.lat_ns.mean] | add / length / 1000 | round)
  }'

# Fsync latency test (critical for database WAL performance)
fio --name=fsync-latency \
  --ioengine=sync \
  --iodepth=1 \
  --rw=write \
  --bs=8k \
  --fsync=1 \
  --direct=0 \
  --size=512M \
  --numjobs=1 \
  --filename="$TEST_DIR/fsync-test.dat" \
  --output-format=json | jq '.jobs[0].write | {iops: (.iops | round), fsync_lat_ms: (.sync.lat_ns.mean / 1000000 | round * 100 / 100)}'

# Clean up
rm -f "$TEST_DIR/test.dat" "$TEST_DIR/fsync-test.dat"
```

### Network Performance Benchmarking

```bash
# Test network bandwidth between nodes using iperf3
# Run server on node 1
iperf3 -s -p 5201 -D  # Run as daemon

# Run client on node 2 (replace IP with node 1's IP)
iperf3 -c 192.168.10.11 -P 8 -t 30 -p 5201 -i 5

# Test UDP throughput and packet loss
iperf3 -c 192.168.10.11 -u -b 10G -t 30 -p 5201

# Test with reverse direction (node 1 -> node 2)
iperf3 -c 192.168.10.11 -R -P 8 -t 30 -p 5201

# Measure latency with qperf
apt-get install -y qperf
# On server: qperf
# On client:
qperf 192.168.10.11 tcp_lat tcp_bw udp_lat udp_bw
```

## Section 11: Complete Kubernetes Node Tuning Script

```bash
#!/bin/bash
# k8s-node-tune.sh - Complete Kubernetes node performance tuning
# Run as root on each node

set -euo pipefail

SYSCTL_FILE="/etc/sysctl.d/99-kubernetes-tuning.conf"

echo "=== Kubernetes Node Performance Tuning ==="

# Create comprehensive sysctl configuration
cat > "$SYSCTL_FILE" << 'EOF'
# Kubernetes Node Performance Tuning
# Generated by k8s-node-tune.sh

# ====== inotify ======
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
fs.inotify.max_queued_events = 16384

# ====== File Descriptors ======
fs.file-max = 2097152
fs.nr_open = 1048576

# ====== Network - Required for Kubernetes ======
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.conf.all.forwarding = 1

# ====== conntrack ======
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
net.netfilter.nf_conntrack_udp_timeout = 30
net.netfilter.nf_conntrack_udp_timeout_stream = 60

# ====== TCP ======
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_max_tw_buckets = 2000000
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_window_scaling = 1
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 250000
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728

# ====== ARP ======
net.ipv4.neigh.default.gc_thresh1 = 4096
net.ipv4.neigh.default.gc_thresh2 = 8192
net.ipv4.neigh.default.gc_thresh3 = 16384

# ====== Memory ======
vm.swappiness = 0
vm.overcommit_memory = 1
vm.panic_on_oom = 0
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
vm.nr_hugepages = 0
kernel.numa_balancing = 0
EOF

# Apply sysctl settings
sysctl --system
echo "sysctl parameters applied"

# Disable swap
swapoff -a
sed -i '/ swap / s/^\(.*\)$/#\1/g' /etc/fstab
echo "Swap disabled"

# Disable THP
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
cat > /etc/systemd/system/disable-thp.service << 'UNIT'
[Unit]
Description=Disable Transparent Huge Pages
After=sysinit.target local-fs.target
Before=kubelet.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled && echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now disable-thp
echo "Transparent Huge Pages disabled"

# Set CPU governor to performance
if command -v cpufreq-set &>/dev/null; then
  for cpu in $(ls /sys/devices/system/cpu/ | grep -E '^cpu[0-9]+$'); do
    cpufreq-set -c "${cpu#cpu}" -g performance 2>/dev/null || true
  done
  echo "CPU governor set to performance"
else
  for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > "$cpu" 2>/dev/null || true
  done
  echo "CPU governor set to performance (direct)"
fi

# Set I/O scheduler for NVMe/SSD
for dev in /sys/block/nvme*/queue/scheduler; do
  echo none > "$dev" 2>/dev/null && echo "Set $dev to none" || true
done

for dev in /sys/block/sd*/queue/scheduler; do
  ROT=$(cat "${dev%/queue/scheduler}/queue/rotational" 2>/dev/null)
  if [ "$ROT" = "0" ]; then
    echo mq-deadline > "$dev" 2>/dev/null && echo "Set $dev to mq-deadline (SSD)" || true
  fi
done

# Update ulimits
cat > /etc/security/limits.d/99-kubernetes.conf << 'LIMITS'
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
* soft nproc 65536
* hard nproc 65536
LIMITS

# Update systemd service limits
mkdir -p /etc/systemd/system/kubelet.service.d
cat > /etc/systemd/system/kubelet.service.d/override.conf << 'SERVICE'
[Service]
LimitNOFILE=1048576
LimitNPROC=65536
SERVICE

mkdir -p /etc/systemd/system/containerd.service.d
cat > /etc/systemd/system/containerd.service.d/override.conf << 'SERVICE'
[Service]
LimitNOFILE=1048576
LimitNPROC=65536
SERVICE

systemctl daemon-reload

echo ""
echo "=== Tuning Complete ==="
echo "Reboot recommended for all settings to take full effect"
echo ""
echo "Summary:"
sysctl fs.inotify.max_user_watches fs.file-max net.netfilter.nf_conntrack_max vm.swappiness
cat /sys/kernel/mm/transparent_hugepage/enabled
```

## Summary

Production Kubernetes nodes require deliberate kernel tuning that the default Linux installation does not provide. The most impactful parameters are:

1. inotify limits (`fs.inotify.max_user_watches = 524288`) prevent cryptic "no space left" errors from monitoring agents and container runtimes
2. conntrack table size (`net.netfilter.nf_conntrack_max = 1048576`) prevents silent connection drops under load
3. File descriptor limits (`fs.file-max = 2097152` plus systemd service limits) prevent pod failures under high concurrency
4. Swap disabled (`vm.swappiness = 0`, `swapoff -a`) is required by kubelet and prevents latency spikes
5. CPU governor set to `performance` eliminates frequency scaling latency under burst load
6. THP disabled prevents memory compaction stalls during bulk allocation
7. I/O scheduler set to `none` for NVMe removes redundant scheduling overhead
8. ARP cache limits (`gc_thresh3 = 16384`) prevent neighbor table overflow in dense pod networks

Apply these settings via infrastructure automation tools and validate them in CI before deploying new nodes to production. A node that passes a fio benchmark and conntrack stress test before entering the pool will not surprise you with infrastructure-level failures during business hours.
