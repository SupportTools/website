---
title: "Linux Huge Pages: THP and Static Configuration for Database Workloads"
date: 2030-11-23T00:00:00-05:00
draft: false
tags: ["Linux", "Huge Pages", "THP", "PostgreSQL", "Redis", "Performance", "Kubernetes", "NUMA", "Memory"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux Transparent Huge Pages vs static huge pages for database workloads, covering PostgreSQL, Redis, and JVM configuration, NUMA topology interactions, memory pressure behavior, and Kubernetes hugepages resource limits."
more_link: "yes"
url: "/linux-huge-pages-thp-static-configuration-database-workloads/"
---

Database workloads are among the most memory-intensive processes in a Linux system. PostgreSQL's shared buffers, Redis's dataset, and JVM heap allocations all perform significantly better when backed by huge pages rather than the default 4KB page size. Fewer TLB entries need to be managed, page table walks are shorter, and the kernel's memory bookkeeping overhead decreases substantially. Yet misconfigured huge pages — especially Transparent Huge Pages with `madvise` or `always` mode — can cause latency spikes, memory fragmentation, and unexpected OOM kills.

This guide provides a production-ready reference for huge page configuration across PostgreSQL, Redis, Java applications, and Kubernetes environments, including NUMA topology interactions and the specific scenarios where THP should be disabled entirely.

<!--more-->

# Linux Huge Pages: THP and Static Configuration for Database Workloads

## Section 1: Huge Page Fundamentals

Modern x86-64 processors support three page sizes:

- **4KB**: The default, always available
- **2MB**: Huge pages (most commonly used for workloads)
- **1GB**: Gigantic pages (require boot-time reservation, rarely used)

A 4KB page table covering 128GB of RAM requires 32 million entries at 8 bytes each — 256MB of RAM just for page table metadata. With 2MB huge pages, that same 128GB requires only 65,536 entries — 512KB. The TLB can cover a much larger address space before eviction occurs, reducing TLB miss rate and the associated page walk overhead.

### Two Huge Page Mechanisms

**Static (HugeTLBFS) Huge Pages**: Pre-allocated at system startup from contiguous physical memory. Applications request them explicitly via `mmap` with `MAP_HUGETLB` or by mapping files from the `/dev/hugepages` filesystem. These pages are never swapped and remain pinned until explicitly freed.

**Transparent Huge Pages (THP)**: The kernel automatically promotes 4KB page regions to 2MB huge pages when possible, with no application changes required. THP operates asynchronously via `khugepaged` and can be configured per-process via `madvise(MADV_HUGEPAGE)`.

### THP Modes

```bash
# Check current THP mode
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# The bracketed option is active:
# always: THP used for any anonymous mapping
# madvise: THP only for madvise(MADV_HUGEPAGE) regions
# never: THP disabled entirely
```

## Section 2: Why THP Causes Database Latency

THP's promotion mechanism runs asynchronously via `khugepaged`, but the initial page fault that triggers promotion can cause a multi-millisecond stall. More critically:

**Compaction Stalls**: Promoting scattered 4KB pages to a 2MB huge page requires memory compaction — moving pages in physical memory to create contiguous 2MB regions. This compaction can pause allocating processes for tens to hundreds of milliseconds. PostgreSQL's `autovacuum`, Redis's `BGSAVE`, and JVM GC all trigger large allocations that hit these stalls.

**Deferred Page Splitting**: When a huge page needs to be partially freed (e.g., `munmap` of part of a huge page), the kernel must split it into 512 regular 4KB pages. This split is synchronous.

**Copy-On-Write Amplification**: Redis and PostgreSQL fork child processes for persistence (BGSAVE, checkpoint). With THP, a CoW write that modifies even one byte of a huge page triggers copying the entire 2MB page instead of just 4KB. Under write-heavy workloads, this 512x amplification causes significant memory pressure.

```bash
# Observe THP compaction activity
grep -E "compact|thp" /proc/vmstat
# compact_migrate_scanned 12847382
# compact_free_scanned 89234721
# compact_isolated 4891234
# thp_fault_alloc 829341
# thp_collapse_alloc 291847
# thp_split_page 48291        # Each split is a potential latency event
# thp_split_pmd 91823
# thp_deferred_split_page 120394
```

## Section 3: Recommended THP Configuration by Workload

### PostgreSQL: Disable THP, Use Static Huge Pages

PostgreSQL benefits enormously from static huge pages for its shared memory segment (`shared_buffers`), but THP with `always` mode causes latency spikes during checkpoint and autovacuum operations.

```bash
# Disable THP (recommended for PostgreSQL hosts)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Persist across reboots (systemd)
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=basic.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=basic.target
EOF

systemctl daemon-reload
systemctl enable --now disable-thp
```

### Configuring Static Huge Pages for PostgreSQL

PostgreSQL's `huge_pages = on` setting instructs it to request huge pages for its shared memory segment:

```bash
# Step 1: Calculate required huge pages
# PostgreSQL shared_buffers = 8GB, plus overhead
# 8GB / 2MB = 4096 huge pages for shared_buffers
# Add ~200 for overhead
TARGET_HUGE_PAGES=4300

# Step 2: Check current huge page allocation
grep -E "HugePages_Total|HugePages_Free|Hugepagesize" /proc/meminfo
# HugePages_Total:    4300
# HugePages_Free:     4300
# Hugepagesize:       2048 kB

# Step 3: Allocate huge pages (temporary - until next reboot)
echo 4300 > /proc/sys/vm/nr_hugepages

# Step 4: Persist in sysctl.conf
cat >> /etc/sysctl.d/60-hugepages.conf << 'EOF'
# Static huge pages for PostgreSQL shared_buffers (8GB at 2MB pages)
vm.nr_hugepages = 4300

# Reserve huge pages near system startup to avoid fragmentation
vm.nr_hugepages_mempolicy = 4300
EOF

sysctl -p /etc/sysctl.d/60-hugepages.conf

# Step 5: Verify allocation succeeded
grep HugePages /proc/meminfo
```

### PostgreSQL Configuration

```ini
# postgresql.conf
shared_buffers = 8GB
huge_pages = on          # Fail startup if huge pages unavailable (not 'try')
huge_page_size = 0       # 0 = use system default (2MB)

# If huge pages cannot be allocated, this prevents silent fallback to 4KB pages
# In production, 'on' is safer than 'try' to catch misconfigured systems early
```

```bash
# Verify PostgreSQL is actually using huge pages after startup
grep -A5 "HugePages" /proc/meminfo
# HugePages_Total:    4300
# HugePages_Free:      187    # 4113 pages consumed by PostgreSQL

# Cross-reference with PostgreSQL process
PG_PID=$(pgrep -x postgres | head -1)
grep -i huge /proc/${PG_PID}/smaps_rollup 2>/dev/null
# AnonHugePages:           0 kB
# ShmemHugePages:    8421376 kB   # This is the huge-page-backed shared memory
```

### Redis: Set THP to madvise or Disable

Redis documentation explicitly recommends disabling THP. The `BGSAVE` fork process creates CoW pressure on THP regions:

```bash
# Recommended for Redis: disable THP
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Redis startup script
cat > /etc/systemd/system/redis.service.d/override.conf << 'EOF'
[Service]
ExecStartPre=-/bin/sh -c 'echo madvise > /sys/kernel/mm/transparent_hugepage/enabled'
EOF

# Redis will also warn about this at startup:
# WARNING you have Transparent Huge Pages (THP) support enabled in your kernel.
# This will create latency and memory usage issues with Redis.
```

Redis configuration for huge pages:

```ini
# redis.conf
# Redis does not use static huge pages by default.
# Disable THP at the OS level and rely on 4KB pages for Redis.

# These settings reduce CoW memory overhead during BGSAVE:
lazyfree-lazy-eviction no
lazyfree-lazy-expire no
lazyfree-lazy-server-del no
lazyfree-lazy-user-del no
lazyfree-lazy-user-flush no

# Reduce BGSAVE frequency to limit CoW window
save 3600 1
save 300 100
save 60 10000
```

## Section 4: JVM Huge Pages Configuration

The JVM supports huge pages through the `-XX:+UseLargePages` flag. On Linux, the JVM uses `mmap` with `MAP_HUGETLB` for heap allocation:

```bash
# Allocate huge pages for a 16GB JVM heap
# 16GB / 2MB = 8192 huge pages
# Add 10% overhead for metaspace, code cache, etc.
echo 9200 > /proc/sys/vm/nr_hugepages

# JVM startup flags for huge pages
java \
    -XX:+UseLargePages \
    -XX:LargePageSizeInBytes=2m \
    -Xms16g \
    -Xmx16g \
    -XX:MetaspaceSize=512m \
    -XX:MaxMetaspaceSize=512m \
    -XX:+UseG1GC \
    -XX:G1HeapRegionSize=16m \
    -jar application.jar
```

### JVM with Explicit HugeTLBFS

```bash
# Mount the hugepages filesystem
mkdir -p /mnt/huge
mount -t hugetlbfs -o pagesize=2M nodev /mnt/huge

# JVM using explicit hugepages filesystem
java \
    -XX:+UseLargePages \
    -XX:LargePageSizeInBytes=2m \
    -XX:+UseHugeTLBFS \
    -Xms16g \
    -Xmx16g \
    -jar application.jar
```

### GraalVM Native Image and Huge Pages

```bash
# GraalVM native image with huge pages
native-image \
    -R:MaxHeapSize=8g \
    -H:+UseG1GC \
    --enable-monitoring=jvmstat \
    -o myapp \
    MyApplication

# At runtime
./myapp \
    -XX:+UseLargePages \
    -Xmx8g
```

## Section 5: NUMA Topology Interactions

On multi-socket servers, huge pages interact with NUMA topology. The kernel's default policy allocates huge pages from the local NUMA node first, but `nr_hugepages` controls the system total:

```bash
# Check NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0-23 48-71
# node 0 size: 128000 MB
# node 0 free: 89234 MB
# node 1 cpus: 24-47 72-95
# node 1 size: 128000 MB
# node 1 free: 91823 MB

# Check huge page allocation per NUMA node
grep -i hugepages /sys/devices/system/node/node*/meminfo
# /sys/devices/system/node/node0/meminfo:HugePages_Total:  2150
# /sys/devices/system/node/node0/meminfo:HugePages_Free:    187
# /sys/devices/system/node/node1/meminfo:HugePages_Total:  2150
# /sys/devices/system/node/node1/meminfo:HugePages_Free:   2150

# Allocate huge pages per NUMA node explicitly
echo 2200 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 2200 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Pin PostgreSQL to NUMA node 0 for predictable huge page access
numactl --cpunodebind=0 --membind=0 postgres -D /var/lib/postgresql/data
```

### NUMA and PostgreSQL

```bash
# PostgreSQL with NUMA-aware configuration
# Bind PostgreSQL to a specific NUMA node
cat > /etc/systemd/system/postgresql.service.d/numa.conf << 'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/numactl --cpunodebind=0 --membind=0 /usr/lib/postgresql/16/bin/postgres \
    -D /var/lib/postgresql/16/main \
    -c config_file=/etc/postgresql/16/main/postgresql.conf
EOF

# Verify NUMA locality of PostgreSQL pages
PG_PID=$(pgrep -x postgres | head -1)
numastat -p $PG_PID
```

### NUMA Balancing vs. Huge Pages

Linux's automatic NUMA balancing (`numa_balancing`) periodically unmaps and remaps pages to detect memory access patterns. This migration is incompatible with static huge pages:

```bash
# Disable NUMA balancing if using static huge pages
# (NUMA balancing cannot migrate huge pages and wastes CPU)
echo 0 > /proc/sys/kernel/numa_balancing

# Persist
echo "kernel.numa_balancing = 0" >> /etc/sysctl.d/60-numa.conf
sysctl -p /etc/sysctl.d/60-numa.conf
```

## Section 6: Memory Pressure Behavior

### Static Huge Pages Under Memory Pressure

Static huge pages are exempt from the OOM killer and cannot be swapped. This means over-allocating static huge pages can cause the OOM killer to target other processes unnecessarily:

```bash
# Check for memory pressure indicators
grep -E "oom_kill|oom_score" /proc/vmstat
# oom_kill 3     # 3 OOM kills since last boot

# Monitor huge page usage in real time
watch -n 1 'grep -E "HugePages|MemFree" /proc/meminfo'

# Calculate safe huge page allocation
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
HUGE_PAGE_KB=2048
# Leave 20% of RAM for OS, non-huge-page processes
SAFE_HUGE_PAGES=$(( (TOTAL_RAM_KB * 80 / 100) / HUGE_PAGE_KB ))
echo "Safe huge page allocation: $SAFE_HUGE_PAGES pages"
```

### THP Defrag Modes

The `defrag` setting controls when the kernel performs memory compaction to satisfy THP allocations:

```bash
cat /sys/kernel/mm/transparent_hugepage/defrag
# always defer defer+madvise [madvise] never

# For latency-sensitive workloads:
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# defer: compaction is deferred to khugepaged background thread
# defer+madvise: immediate for madvise regions, deferred for others
# madvise: only compact for madvise regions
# never: never compact for THP (lowest latency impact)
```

### Khugepaged Tuning

```bash
# Khugepaged scan interval (milliseconds between scans)
# Default 10000 = 10 seconds - fine for most workloads
echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs

# Maximum pages scanned per round
# Reduce to limit khugepaged CPU usage
echo 4096 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan

# Allocation failure sleep time
echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs
```

## Section 7: Kubernetes Huge Pages Resource Limits

Kubernetes supports both 2Mi and 1Gi huge pages as first-class resources in the `hugepages-*` resource family.

### Node Configuration for Kubernetes

```bash
# On each Kubernetes node, pre-allocate huge pages before kubelet starts
# This is typically done via cloud-init or a node bootstrap script

# Calculate: 4 worker processes × 2GB shared_buffers = 8GB
# Plus overhead: 10GB / 2MB = 5120 huge pages
echo 6000 > /proc/sys/vm/nr_hugepages

# Verify kubelet picks up the resource
kubectl describe node <node-name> | grep -A5 "Allocatable"
# Allocatable:
#   cpu:              31750m
#   hugepages-1Gi:    0
#   hugepages-2Mi:    6000        # Should show available huge pages
#   memory:           119Gi
```

### Pod Requesting Huge Pages

```yaml
# postgres-with-hugepages.yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgresql-hugepages
  namespace: database
spec:
  containers:
  - name: postgresql
    image: postgres:16.2
    env:
    - name: POSTGRES_DB
      value: production
    - name: PGDATA
      value: /var/lib/postgresql/data/pgdata
    # Huge pages require matching requests and limits
    resources:
      requests:
        memory: "18Gi"
        hugepages-2Mi: "4096Mi"  # 4096 × 2Mi = 8Gi of huge pages
        cpu: "4"
      limits:
        memory: "18Gi"
        hugepages-2Mi: "4096Mi"
        cpu: "8"
    volumeMounts:
    - name: hugepage-volume
      mountPath: /hugepages
    - name: postgres-data
      mountPath: /var/lib/postgresql/data
  volumes:
  # Huge pages are exposed via a memory-backed volume
  - name: hugepage-volume
    emptyDir:
      medium: HugePages-2Mi
  - name: postgres-data
    persistentVolumeClaim:
      claimName: postgres-data-pvc
  # Required: huge pages need guaranteed QoS
  # (requests == limits for all resources)
```

### PostgreSQL Configuration in Kubernetes

```yaml
# postgres-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-config
  namespace: database
data:
  postgresql.conf: |
    # Shared memory: use huge pages from the emptyDir volume
    shared_buffers = 8GB
    huge_pages = on
    # Map shared memory to the huge page volume
    # (PostgreSQL 14+ supports this directly)

    # Connection and memory settings
    max_connections = 200
    work_mem = 64MB
    maintenance_work_mem = 2GB
    effective_cache_size = 24GB

    # WAL settings
    wal_level = replica
    max_wal_size = 4GB
    checkpoint_completion_target = 0.9

    # Query planner
    random_page_cost = 1.1
    effective_io_concurrency = 300
```

### DaemonSet for Huge Page Initialization

A DaemonSet can configure nodes before workloads are scheduled:

```yaml
# hugepages-configurator.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: hugepages-configurator
  namespace: kube-system
  labels:
    app.kubernetes.io/name: hugepages-configurator
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: hugepages-configurator
  updateStrategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
        app.kubernetes.io/name: hugepages-configurator
    spec:
      hostIPC: true
      hostPID: true
      tolerations:
      - operator: Exists
      priorityClassName: system-node-critical
      initContainers:
      - name: configure-hugepages
        image: busybox:1.36
        command:
        - /bin/sh
        - -c
        - |
          set -ex
          # Disable THP for database workloads
          echo never > /proc/sys/kernel/mm/transparent_hugepage/enabled || true
          echo never > /proc/sys/kernel/mm/transparent_hugepage/defrag || true
          echo defer+madvise > /proc/sys/kernel/mm/transparent_hugepage/defrag || true

          # Disable NUMA balancing (incompatible with huge pages)
          echo 0 > /proc/sys/kernel/numa_balancing || true

          echo "Huge page configuration complete"
        securityContext:
          privileged: true
        volumeMounts:
        - name: proc-sys
          mountPath: /proc/sys
      containers:
      - name: pause
        image: gcr.io/google_containers/pause:3.9
        resources:
          requests:
            cpu: 1m
            memory: 1Mi
          limits:
            cpu: 1m
            memory: 1Mi
      volumes:
      - name: proc-sys
        hostPath:
          path: /proc/sys
```

## Section 8: Monitoring and Validation

### Prometheus Metrics for Huge Pages

```yaml
# prometheus-rules-hugepages.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hugepages-alerts
  namespace: monitoring
spec:
  groups:
  - name: hugepages
    rules:
    - alert: HugePagesLow
      expr: |
        node_memory_HugePages_Free / node_memory_HugePages_Total < 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Huge pages running low on {{ $labels.instance }}"
        description: |
          Only {{ $value | humanizePercentage }} of huge pages are free on {{ $labels.instance }}.
          Consider allocating more huge pages or reducing workload.

    - alert: HugePagesExhausted
      expr: |
        node_memory_HugePages_Free == 0
        AND node_memory_HugePages_Total > 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Huge pages exhausted on {{ $labels.instance }}"
        description: |
          All huge pages are consumed on {{ $labels.instance }}.
          Processes requesting huge pages will fall back to 4KB pages (if configured).

    - alert: THPEnabled
      expr: |
        node_memory_AnonHugePages_bytes > 1073741824  # More than 1GB of THP
        AND on(instance) (node_uname_info{nodename=~".*db.*"})
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "THP active on database node {{ $labels.instance }}"
        description: |
          Transparent Huge Pages are being used on a database node.
          Consider disabling THP for more predictable latency.
```

### Node Exporter Huge Page Metrics

```bash
# node_exporter exposes these huge page metrics:
# node_memory_HugePages_Total     - Total pre-allocated huge pages
# node_memory_HugePages_Free      - Available huge pages
# node_memory_HugePages_Rsvd      - Pages reserved but not yet allocated
# node_memory_HugePages_Surp      - Surplus pages above vm.nr_hugepages
# node_memory_AnonHugePages_bytes - Memory in THP-backed anonymous mappings
# node_memory_Hugepagesize_bytes  - Huge page size (usually 2MB)

# Quick check via curl
curl -s http://localhost:9100/metrics | grep hugepages -i
```

### Validation Script

```bash
#!/bin/bash
# validate-hugepages.sh
# Validates huge page configuration for database workloads

set -euo pipefail

EXPECTED_HUGEPAGES=${1:-4096}
WORKLOAD=${2:-postgresql}

echo "=== Huge Page Validation for $WORKLOAD ==="
echo ""

# Check THP status
THP_STATUS=$(cat /sys/kernel/mm/transparent_hugepage/enabled)
THP_ACTIVE=$(echo "$THP_STATUS" | grep -oP '\[\K[^\]]+')

echo "THP status: $THP_ACTIVE"
case "$WORKLOAD" in
    postgresql|redis)
        if [[ "$THP_ACTIVE" != "never" ]] && [[ "$THP_ACTIVE" != "madvise" ]]; then
            echo "WARNING: THP should be 'never' or 'madvise' for $WORKLOAD"
        else
            echo "OK: THP mode appropriate for $WORKLOAD"
        fi
        ;;
esac

echo ""

# Check static huge page allocation
TOTAL=$(grep HugePages_Total /proc/meminfo | awk '{print $2}')
FREE=$(grep HugePages_Free /proc/meminfo | awk '{print $2}')
SIZE_KB=$(grep Hugepagesize /proc/meminfo | awk '{print $2}')

echo "Static huge pages:"
echo "  Total: $TOTAL ($(( TOTAL * SIZE_KB / 1024 ))MB)"
echo "  Free:  $FREE"
echo "  Used:  $(( TOTAL - FREE ))"
echo "  Size:  ${SIZE_KB}KB"

if [[ "$TOTAL" -lt "$EXPECTED_HUGEPAGES" ]]; then
    echo "WARNING: Expected $EXPECTED_HUGEPAGES huge pages, only $TOTAL allocated"
else
    echo "OK: Sufficient huge pages allocated"
fi

echo ""

# Check NUMA distribution
if ls /sys/devices/system/node/node*/meminfo &>/dev/null; then
    echo "NUMA huge page distribution:"
    for node_meminfo in /sys/devices/system/node/node*/meminfo; do
        NODE=$(echo "$node_meminfo" | grep -oP 'node\d+')
        NODE_TOTAL=$(grep HugePages_Total "$node_meminfo" | awk '{print $4}')
        echo "  $NODE: $NODE_TOTAL pages"
    done
fi

echo ""

# Check NUMA balancing
NUMA_BALANCING=$(cat /proc/sys/kernel/numa_balancing)
if [[ "$NUMA_BALANCING" -ne 0 ]]; then
    echo "WARNING: NUMA balancing is enabled (may interfere with huge pages)"
    echo "  Recommendation: echo 0 > /proc/sys/kernel/numa_balancing"
else
    echo "OK: NUMA balancing is disabled"
fi

echo ""
echo "=== Validation complete ==="
```

## Section 9: Production Runbook

### Initial Setup Checklist

```bash
# 1. Determine huge page requirements
# PostgreSQL: shared_buffers / 2MB + 10% overhead
# Redis: maxmemory / 2MB (only if using static huge pages)
# JVM: Xmx / 2MB + 15% overhead

# 2. Calculate total across all workloads on the node
POSTGRES_HUGEPAGES=4300   # 8GB shared_buffers
JVM_HUGEPAGES=2050        # 4GB heap
TOTAL_HUGEPAGES=$(( POSTGRES_HUGEPAGES + JVM_HUGEPAGES + 200 ))  # 200 overhead

# 3. Verify system has enough contiguous memory
# Run this before allocating (fragmentation check)
echo 3 > /proc/sys/vm/drop_caches  # Drop page cache to reduce fragmentation
cat /proc/buddyinfo                  # Check memory block availability

# 4. Allocate huge pages
echo $TOTAL_HUGEPAGES > /proc/sys/vm/nr_hugepages

# 5. Verify allocation
grep HugePages /proc/meminfo

# 6. Disable THP (for database nodes)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# 7. Persist configuration
cat >> /etc/sysctl.d/60-hugepages.conf << EOF
vm.nr_hugepages = $TOTAL_HUGEPAGES
kernel.numa_balancing = 0
EOF
echo never > /sys/kernel/mm/transparent_hugepage/enabled

# 8. Restart database services
systemctl restart postgresql
# Verify PostgreSQL is using huge pages:
grep HugePages /proc/meminfo | head
```

### Troubleshooting Huge Page Allocation Failures

```bash
# Symptom: echo 4096 > /proc/sys/vm/nr_hugepages
# but /proc/meminfo shows fewer than 4096

# Cause 1: Memory fragmentation
# Fix: Drop caches and compact memory
echo 3 > /proc/sys/vm/drop_caches
echo 1 > /proc/sys/vm/compact_memory
sleep 5
echo 4096 > /proc/sys/vm/nr_hugepages
grep HugePages_Total /proc/meminfo

# Cause 2: Not enough free memory
# Check:
free -h
grep -E "MemFree|MemAvailable" /proc/meminfo

# Cause 3: NUMA node imbalance
# Check each node independently
cat /sys/devices/system/node/node0/meminfo | grep Huge
cat /sys/devices/system/node/node1/meminfo | grep Huge

# Fix: Allocate per-node
echo 2048 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 2048 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages
```

## Conclusion

Huge page configuration is one of the highest-impact performance tuning actions available for database workloads, yet it requires careful attention to the interaction between THP, static pages, NUMA topology, and container resource limits.

The key principles to follow:

- Disable THP on dedicated database nodes (`never` mode) — the compaction and CoW amplification overhead outweighs THP benefits for PostgreSQL, Redis, and JVM workloads
- Use static huge pages for PostgreSQL `shared_buffers` with `huge_pages = on` (not `try`)
- Pre-allocate huge pages before memory becomes fragmented — ideally at system startup via sysctl
- On NUMA systems, allocate huge pages per node to ensure memory locality
- Disable automatic NUMA balancing when using static huge pages to eliminate migration overhead
- In Kubernetes, use `hugepages-2Mi` resource requests/limits to expose huge page inventory to pods, and set `medium: HugePages-2Mi` on the backing emptyDir volume
- Monitor with Prometheus alerts for low huge page availability before workloads start failing silently
