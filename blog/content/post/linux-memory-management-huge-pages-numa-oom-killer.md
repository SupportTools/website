---
title: "Linux Memory Management Deep Dive: Transparent Huge Pages, NUMA Topology, and OOM Killer Configuration"
date: 2031-06-30T00:00:00-05:00
draft: false
tags: ["Linux", "Memory Management", "NUMA", "Huge Pages", "OOM Killer", "Performance"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux memory management internals covering transparent huge pages, NUMA-aware allocation, OOM killer tuning, and practical configuration strategies for high-performance production systems."
more_link: "yes"
url: "/linux-memory-management-huge-pages-numa-oom-killer/"
---

Memory management is one of the most consequential and least understood aspects of Linux system tuning. The gap between theoretical peak performance and observed production throughput often traces back to memory subsystem misconfiguration: wrong huge page settings, suboptimal NUMA placement, or an OOM killer policy that kills the wrong processes at the worst possible time. This post provides a deep technical foundation for understanding and tuning these systems.

<!--more-->

# Linux Memory Management Deep Dive: Transparent Huge Pages, NUMA Topology, and OOM Killer Configuration

## Memory Subsystem Architecture

The Linux virtual memory subsystem sits between applications and physical DRAM. Understanding its layers is prerequisite to tuning any of them.

```
Application (virtual addresses)
        |
        v
  Page Table Walker (MMU)
        |
        v
  Translation Lookaside Buffer (TLB)
        |  (TLB miss -> page table walk)
        v
  Page Cache / Physical Memory
        |
        v
  NUMA Node (local or remote DRAM)
```

Every virtual-to-physical address translation either hits the TLB (fast: ~4 CPU cycles) or requires a full page table walk (slow: 50-200+ cycles depending on cache state). The page size determines how much memory each TLB entry covers. With 4 KB pages, a process with a 10 GB working set needs 2.5 million TLB entries. The hardware TLB has 1,500-4,096 entries. The result is constant TLB misses.

With 2 MB huge pages, the same 10 GB working set needs only 5,120 TLB entries—a 500x reduction in TLB pressure.

## Huge Pages

### Explicit (Static) Huge Pages

Static huge pages are allocated at boot time and reserved for applications that explicitly request them via `mmap(MAP_HUGETLB)` or `shmget(SHM_HUGETLB)`.

```bash
# Check current huge page state
grep -E "HugePages|Hugepagesize" /proc/meminfo

# Output example:
# HugePages_Total:    1024
# HugePages_Free:      892
# HugePages_Rsvd:       48
# HugePages_Surp:        0
# Hugepagesize:       2048 kB
# Hugetlb:         2097152 kB

# Allocate huge pages at runtime (may fail if memory is fragmented)
echo 1024 > /proc/sys/vm/nr_hugepages

# Allocate per NUMA node
echo 512 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 512 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# 1GB huge pages (requires hardware support and kernel boot parameter)
# Add to kernel command line: hugepagesz=1G hugepages=16
grep 1G /proc/cpuinfo | head -1  # Look for pdpe1gb flag
echo 16 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
```

Make huge page allocation persistent:

```bash
# /etc/sysctl.d/99-hugepages.conf
vm.nr_hugepages = 1024
vm.nr_overcommit_hugepages = 128

# For 1GB pages in /etc/default/grub:
# GRUB_CMDLINE_LINUX="hugepagesz=1G hugepages=16 default_hugepagesz=2M"
```

Mount the hugetlbfs filesystem for direct file-based access:

```bash
mkdir -p /mnt/hugepages
mount -t hugetlbfs nodev /mnt/hugepages -o pagesize=2M,size=2G,min_size=1G

# Add to /etc/fstab
echo "nodev /mnt/hugepages hugetlbfs pagesize=2M,size=2G,min_size=1G 0 0" >> /etc/fstab
```

Applications like PostgreSQL and DPDK use explicit huge pages. PostgreSQL configuration:

```
# postgresql.conf
huge_pages = on          # on, off, or try
# PostgreSQL will use /proc/sys/vm/nr_hugepages allocation
# Ensure nr_hugepages covers shared_buffers
# For 32 GB shared_buffers: nr_hugepages = ceil(32*1024/2) = 16384
```

### Transparent Huge Pages (THP)

THP automatically uses 2 MB pages for anonymous memory regions without application changes. The kernel's `khugepaged` daemon scans for 4 KB page ranges that can be collapsed into a 2 MB page.

```bash
# Check THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# Output shows: [always] madvise never
# The bracket indicates the current setting

# Available modes:
# always  - promote all eligible memory to huge pages
# madvise - only regions tagged with madvise(MADV_HUGEPAGE)
# never   - disable THP entirely
```

THP has a complicated reputation. For most workloads, it helps. For specific workloads, it causes severe latency spikes. Understanding why requires understanding the collapse mechanism.

#### The THP Collapse Latency Problem

When `khugepaged` collapses 512 4KB pages into one 2MB page, it must:

1. Acquire a lock on all 512 page table entries
2. Copy the content to a contiguous 2MB physical region
3. Update all mappings
4. Release the lock

During this collapse, applications accessing that memory region stall. On a busy database with active memory access, this stall can be 10-100ms. The symptom is periodic latency spikes that appear at irregular intervals and correlate with `khugepaged` activity.

```bash
# Monitor khugepaged activity
cat /proc/vmstat | grep -E "thp_|huge_page"

# Key counters:
# thp_fault_alloc       - THP allocated on page fault
# thp_collapse_alloc    - pages collapsed by khugepaged
# thp_split_page        - THP split back to 4KB (indicates memory pressure)
# thp_split_pmd         - PMD entry split (different from page split)
# thp_zero_page_alloc   - zero huge page allocated
```

#### THP Configuration Strategies

**Strategy 1: `madvise` mode (recommended for mixed workloads)**

```bash
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Also configure the defrag behavior
# defer+madvise: collapse happens asynchronously, not on the fault path
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

Applications can then opt into THP for regions where it helps:

```c
// C example: opt a memory region into THP
#include <sys/mman.h>
void* buf = mmap(NULL, 1024*1024*1024, PROT_READ|PROT_WRITE,
                 MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
madvise(buf, 1024*1024*1024, MADV_HUGEPAGE);

// Or opt out a region from THP (e.g., allocator metadata)
madvise(metadata_region, metadata_size, MADV_NOHUGEPAGE);
```

**Strategy 2: `never` mode for latency-sensitive workloads**

Redis, Memcached, and real-time applications should disable THP entirely:

```bash
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

This is commonly set in systemd service files or container start scripts:

```bash
# In Redis startup or container entrypoint
if [ -f /sys/kernel/mm/transparent_hugepage/enabled ]; then
    echo never > /sys/kernel/mm/transparent_hugepage/enabled
fi
```

**Strategy 3: `always` with deferred defrag (for CPU-intensive batch workloads)**

```bash
echo always > /sys/kernel/mm/transparent_hugepage/enabled
# defer: allocation succeeds immediately with 4KB fallback;
# khugepaged collapses asynchronously to avoid fault-path latency
echo defer > /sys/kernel/mm/transparent_hugepage/defrag

# Tune khugepaged scan rate
# scan_sleep_millisecs: how often khugepaged wakes up (default 10000ms)
echo 5000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
# pages_to_scan: pages scanned per wakeup (default 4096)
echo 8192 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
```

### Memory Compaction

Even with THP enabled, the kernel may fail to allocate huge pages due to memory fragmentation. Memory compaction moves pages to create contiguous free regions.

```bash
# Trigger manual compaction (useful before memory-intensive workloads)
echo 1 > /proc/sys/vm/compact_memory

# Configure compaction aggressiveness
# 0: compact on allocation failure only
# 1: compact when free memory drops to low watermark
# 2: compact when free memory drops to min watermark
echo 1 > /proc/sys/vm/compaction_proactiveness

# Monitor compaction
cat /proc/vmstat | grep compact
# compact_migrate_scanned
# compact_free_scanned
# compact_isolated
# compact_stall          <- stalls are the ones to watch
```

## NUMA Topology

### Understanding Your NUMA Topology

```bash
# Display NUMA topology
numactl --hardware

# Example output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 24 25 26 27 28 29 30 31 32 33 34 35
# node 0 size: 193468 MB
# node 0 free: 147823 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23 36 37 38 39 40 41 42 43 44 45 46 47
# node 1 size: 196608 MB
# node 1 free: 156234 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10
# Distance 10 = local, 21 = remote (2.1x slower)

# More detail with lstopo
lstopo --no-io --output-format ascii

# NUMA memory stats per process
cat /proc/$(pgrep -n postgres)/numa_maps | head -20
```

### NUMA Memory Policies

```bash
# Run a process with NUMA policy: bind to node 0
numactl --cpunodebind=0 --membind=0 my-application

# Interleave memory across nodes (good for multi-threaded workloads)
numactl --interleave=all my-application

# Prefer node 0 but allow other nodes if node 0 is full
numactl --preferred=0 my-application

# Set NUMA policy for a running process
# (requires numactl 2.0.13+)
numactl --cpunodebind=1 --membind=1 --pid $(pgrep my-app)
```

Set NUMA policy in code:

```c
// C: bind process memory to NUMA node 0
#include <numa.h>
#include <numaif.h>

// Bind future allocations to node 0
struct bitmask *nodes = numa_allocate_nodemask();
numa_bitmask_setbit(nodes, 0);
numa_set_membind(nodes);
numa_free_nodemask(nodes);

// Allocate memory on a specific node
void *buf = numa_alloc_onnode(1024*1024*1024, 0);  // 1GB on node 0
```

### NUMA Balancing

The kernel's automatic NUMA balancing (`autonuma`) periodically unmaps pages and re-faults them to detect which NUMA node each thread is actually accessing. It then migrates pages to be local to the accessing thread.

```bash
# Check current NUMA balancing state
cat /proc/sys/kernel/numa_balancing

# Enable (1) or disable (0)
echo 1 > /proc/sys/kernel/numa_balancing

# Make persistent
echo "kernel.numa_balancing = 1" > /etc/sysctl.d/99-numa.conf
```

NUMA balancing is beneficial for workloads with irregular memory access patterns (e.g., web servers handling diverse requests) but harmful for latency-sensitive workloads where the periodic page fault injection causes spikes.

```bash
# Monitor NUMA balancing effectiveness
cat /proc/vmstat | grep -E "numa_"
# numa_hit              - allocations from preferred node
# numa_miss             - allocations from non-preferred node (bad)
# numa_foreign          - allocations for another node served here
# numa_pages_migrated   - pages migrated by NUMA balancing
# numa_pte_updates      - page table entries scanned
```

### NUMA in Kubernetes

Kubernetes 1.18+ includes the Topology Manager, which coordinates NUMA-aware scheduling across CPU, memory, and devices.

```yaml
# kubelet configuration for NUMA-aware scheduling
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: "static"
memoryManagerPolicy: "Static"
topologyManagerPolicy: "best-effort"
# Options: none, best-effort, restricted, single-numa-node
topologyManagerScope: "container"  # or "pod"

# Reserve memory per NUMA node for guaranteed pods
reservedMemory:
- numaNode: 0
  limits:
    memory: "1Gi"
- numaNode: 1
  limits:
    memory: "1Gi"
```

For pods that need NUMA locality:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: numa-sensitive-app
spec:
  containers:
  - name: app
    image: my-app:latest
    resources:
      limits:
        cpu: "8"         # Must be integer for CPU manager static policy
        memory: "16Gi"
        # Topology manager will co-locate CPUs and memory on same NUMA node
      requests:
        cpu: "8"
        memory: "16Gi"
```

## OOM Killer

### How the OOM Killer Works

When the kernel cannot satisfy a memory allocation and cannot reclaim enough memory through swapping or page cache eviction, it invokes the OOM (Out of Memory) killer. The OOM killer scores each process and kills the one with the highest score.

The OOM score algorithm (simplified):

```
oom_score = (process_rss_in_pages / total_memory_pages) * 1000
           + oom_score_adj
```

Where:
- `process_rss_in_pages`: Resident Set Size (physical memory in use)
- `oom_score_adj`: Adjustment value from -1000 to 1000 (administrator-configured)
- `-1000` means "never kill this process"
- `+1000` means "kill this process first"

```bash
# View OOM scores for running processes
for pid in /proc/[0-9]*; do
    pid_num=$(basename $pid)
    comm=$(cat $pid/comm 2>/dev/null)
    score=$(cat $pid/oom_score 2>/dev/null)
    adj=$(cat $pid/oom_score_adj 2>/dev/null)
    echo "$score\t$adj\t$pid_num\t$comm"
done | sort -rn | head -20
```

### Configuring OOM Score Adjustments

```bash
# Protect a critical process (system daemon, database)
# Range: -1000 (never kill) to +1000 (kill first)
echo -500 > /proc/$(pgrep postgres)/oom_score_adj

# Mark a process as expendable (CI runner, batch job)
echo 500 > /proc/$(pgrep ci-runner)/oom_score_adj

# Never kill a process (use with extreme caution)
echo -1000 > /proc/$(pgrep critical-daemon)/oom_score_adj
```

In systemd service files:

```ini
# /etc/systemd/system/postgresql.service
[Service]
# Protect PostgreSQL from OOM killer
OOMScoreAdjust=-500

# For less critical services
# OOMScoreAdjust=200
```

### Kubernetes OOM Score Management

Kubernetes automatically sets OOM scores based on QoS class:

| QoS Class | OOM Score Adjustment | Description |
|-----------|---------------------|-------------|
| Guaranteed | -997 | `limits == requests` for all containers |
| Burstable | 2 to 999 | `requests < limits` |
| BestEffort | 1000 | No requests or limits set |

You can adjust this for specific pods using the `oom-score-adj` feature, but this requires careful consideration of the cascading effects.

### OOM Killer Behavior Control

```bash
# Disable OOM killer entirely (dangerous: kernel will panic instead)
# echo 1 > /proc/sys/vm/panic_on_oom

# Kill OOM-triggering process only (not the highest-scoring process)
echo 2 > /proc/sys/vm/oom_kill_allocating_task

# Keep OOM from killing processes in different memory cgroup
# (cgroup-based OOM is generally preferred for containers)

# View OOM kill events
dmesg | grep -E "oom|killed process"
journalctl -k | grep -E "oom|Out of memory"
```

### Memory Cgroup OOM Configuration

In containerized environments, OOM kills should be scoped to the container's cgroup rather than the entire system.

```bash
# Check memory cgroup limits for a container
CONTAINER_ID=$(docker inspect --format='{{.Id}}' my-container)
cat /sys/fs/cgroup/memory/docker/$CONTAINER_ID/memory.limit_in_bytes
cat /sys/fs/cgroup/memory/docker/$CONTAINER_ID/memory.usage_in_bytes
cat /sys/fs/cgroup/memory/docker/$CONTAINER_ID/memory.oom_control

# Enable OOM notifier for a cgroup (cgroup v1)
# When memory reaches the limit, notify instead of kill
echo 1 > /sys/fs/cgroup/memory/my-cgroup/memory.oom_control
# Then read events from
cat /sys/fs/cgroup/memory/my-cgroup/cgroup.event_control
```

For cgroup v2 (cgroupfs2, default in modern kernels):

```bash
# cgroup v2 OOM configuration
cat /sys/fs/cgroup/my-cgroup/memory.max
cat /sys/fs/cgroup/my-cgroup/memory.current
cat /sys/fs/cgroup/my-cgroup/memory.events

# memory.events contains:
# low N     - number of times memory went below low threshold
# high N    - number of times memory went above high threshold
# max N     - number of times memory hit the limit and reclaim was attempted
# oom N     - number of OOM kills
# oom_kill N - number of processes killed

# Set memory limit for a cgroup v2 group
echo "4G" > /sys/fs/cgroup/my-cgroup/memory.max
```

## Memory Pressure Monitoring

### /proc/meminfo Deep Dive

```bash
# Annotated memory analysis script
cat << 'EOF' > /usr/local/bin/memstat
#!/bin/bash
declare -A mem
while IFS=: read key value; do
    mem[$key]=$(echo $value | awk '{print $1}')
done < /proc/meminfo

total=${mem[MemTotal]}
free=${mem[MemFree]}
available=${mem[MemAvailable]}
buffers=${mem[Buffers]}
cached=${mem[Cached]}
slab=${mem[Slab]}
hugepages_total=${mem[HugePages_Total]}
hugepages_free=${mem[HugePages_Free]}
hugepagesize=${mem[Hugepagesize]}

echo "=== Memory Status ==="
echo "Total:     $(( total / 1024 )) MB"
echo "Available: $(( available / 1024 )) MB ($(( available * 100 / total ))%)"
echo "Free:      $(( free / 1024 )) MB"
echo "Buffers:   $(( buffers / 1024 )) MB"
echo "Cached:    $(( cached / 1024 )) MB"
echo "Slab:      $(( slab / 1024 )) MB"
echo ""
echo "=== Huge Pages ==="
echo "Total:     $hugepages_total ($(( hugepages_total * hugepagesize / 1024 )) MB)"
echo "Free:      $hugepages_free ($(( hugepages_free * hugepagesize / 1024 )) MB)"
echo "Used:      $(( (hugepages_total - hugepages_free) * hugepagesize / 1024 )) MB"
EOF
chmod +x /usr/local/bin/memstat
```

### Memory Pressure via PSI (Pressure Stall Information)

PSI provides the most accurate measure of how much time processes are stalled waiting for memory:

```bash
# PSI memory pressure (requires kernel 4.20+)
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.12 avg300=0.31 total=2847291
# full avg10=0.00 avg60=0.04 avg300=0.08 total=893421

# some: percentage of time at least one process was stalled on memory
# full: percentage of time ALL processes were stalled on memory
# avg10/60/300: 10-second, 1-minute, 5-minute rolling averages

# Set up PSI-based alerting via systemd
cat << 'EOF' > /etc/systemd/system/memory-pressure-alert.service
[Unit]
Description=Memory Pressure Alert

[Service]
Type=oneshot
ExecStart=/usr/local/bin/send-alert "Memory pressure high"
EOF

# Trigger the alert when full pressure exceeds 10% for 30 seconds
# via inotify on /proc/pressure/memory (requires kernel 5.2+)
```

### vmstat and Memory Reclaim

```bash
# Monitor memory reclaim in real time
vmstat 1 | awk 'NR==1{print} NR==2{print} NR>2{
    # si/so = swap in/out
    # bi/bo = block in/out (page cache activity)
    # free  = free memory
    # buff  = buffers
    # cache = page cache
    printf "%s si=%s so=%s bi=%s bo=%s free=%s\n", $0, $7, $8, $9, $10, $4
}'

# Check kswapd activity
cat /proc/vmstat | grep -E "kswapd|pgpg|pgscan|pgsteal"
# kswapd_inodesteal  - inode reclaim by kswapd
# pgpgin/pgpgout     - pages paged in/out
# pgscan_kswapd_*    - pages scanned by kswapd
# pgsteal_kswapd_*   - pages reclaimed by kswapd
```

## Swappiness and Swap Configuration

```bash
# vm.swappiness controls the kernel's tendency to swap
# 0 = swap only to avoid OOM (not completely disable)
# 10 = light swapping (recommended for databases)
# 60 = default (balanced)
# 100 = aggressive swapping

echo 10 > /proc/sys/vm/swappiness

# For systems where you want to prevent swapping entirely
# Note: setting to 0 does NOT disable swap, it just makes the
# kernel very reluctant to swap
echo 0 > /proc/sys/vm/swappiness

# Disable swap entirely (for Kubernetes worker nodes)
swapoff -a
# And remove swap entries from /etc/fstab
sed -i '/swap/d' /etc/fstab

# Configure swap pressure for specific cgroups
# (useful for container workloads that need swap controls)
echo 20 > /sys/fs/cgroup/my-service/memory.swappiness
```

## Putting It All Together: Production System Profile

### Profile 1: Database Server (PostgreSQL)

```bash
# /etc/sysctl.d/99-postgres-memory.conf

# Disable swap - databases should never swap
vm.swappiness = 0

# Reserve huge pages for PostgreSQL shared_buffers
# For 64GB shared_buffers: 64*1024/2 = 32768 pages
vm.nr_hugepages = 32768

# Disable THP - causes latency spikes for databases
# (Set at boot via kernel parameter: transparent_hugepage=never)
# Or at runtime:
# echo never > /sys/kernel/mm/transparent_hugepage/enabled

# Tune dirty page ratios for write-heavy databases
# dirty_ratio: start synchronous writeback at this % of total memory
vm.dirty_ratio = 10
# dirty_background_ratio: start background writeback at this %
vm.dirty_background_ratio = 3

# Disable NUMA balancing for consistent performance
kernel.numa_balancing = 0

# OOM settings
vm.panic_on_oom = 0
vm.oom_kill_allocating_task = 0
```

### Profile 2: JVM Application Server

```bash
# /etc/sysctl.d/99-jvm-memory.conf

# Enable THP with madvise for JVM large heap regions
# JVM uses madvise(MADV_HUGEPAGE) for large regions
vm.swappiness = 10

# THP with deferred defrag (set via /sys in startup script)
# echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
# echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Allow more overcommit for JVM virtual memory usage
vm.overcommit_memory = 1
vm.overcommit_ratio = 80
```

### Profile 3: Kubernetes Worker Node

```bash
# /etc/sysctl.d/99-k8s-worker.conf

# Kubernetes requires swap disabled
vm.swappiness = 0

# For nodes running latency-sensitive pods
# THP disabled (set per pod via startup scripts)
# echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Kernel memory accounting
vm.min_free_kbytes = 1048576  # 1GB minimum free (prevent sudden OOM)

# Memory overcommit
vm.overcommit_memory = 1  # Always allow (Kubernetes manages limits via cgroups)
```

## Conclusion

Linux memory management offers deep configurability but requires understanding the trade-offs. THP improves throughput but introduces latency spikes for some workloads—`madvise` mode with deferred defrag is the safest default for mixed environments. NUMA topology is invisible until it becomes your bottleneck; binding latency-sensitive workloads to NUMA nodes eliminates the 2x performance tax of remote memory access. The OOM killer's default behavior is reasonable but insufficient for production systems running containers—cgroup-scoped OOM with appropriate `oom_score_adj` values prevents the wrong process from being killed at the worst possible time.

Profile-specific tuning matters: what's optimal for a PostgreSQL server is wrong for a JVM application, and what works for batch processing will hurt a real-time API tier. Build configuration profiles for each workload type and enforce them consistently.
