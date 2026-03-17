---
title: "Linux NUMA Architecture: Memory Topology Optimization for Database Servers"
date: 2030-12-03T00:00:00-05:00
draft: false
tags: ["Linux", "NUMA", "Performance", "Databases", "Kubernetes", "CPU Affinity", "Memory"]
categories:
- Linux
- Performance
- Databases
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to NUMA node identification, numactl and numad configuration, memory interleaving policies, CPU affinity for database processes, Kubernetes NUMA-aware scheduling, and topology manager policies for high-performance database workloads."
more_link: "yes"
url: "/linux-numa-architecture-memory-topology-optimization-database-servers/"
---

Non-Uniform Memory Access (NUMA) is a memory architecture fundamental to modern multi-socket and multi-die processors. In a NUMA system, memory access latency depends on the physical relationship between the CPU executing the memory access and the DIMM holding the data. When a CPU core accesses memory on its local NUMA node, latency is typically 60-80ns. When it accesses memory on a remote node across the interconnect (QPI/UPI on Intel, Infinity Fabric on AMD), latency jumps to 120-200ns or more — a 2-3x penalty that compounds under database workloads with millions of memory accesses per second.

Most database performance problems attributed to "slow hardware" or "insufficient memory bandwidth" are NUMA topology problems. This guide provides production-grade techniques for identifying your server's NUMA topology, configuring numactl and numad, selecting appropriate memory policies, tuning CPU affinity for database processes, and deploying NUMA-aware workloads on Kubernetes.

<!--more-->

# Linux NUMA Architecture: Memory Topology Optimization for Database Servers

## Understanding NUMA Topology

### What Makes a NUMA System

In the classical Symmetric Multi-Processing (SMP) architecture, all CPUs share a flat memory bus. Every CPU can access every memory location at the same latency. This works well for systems with a small number of cores but does not scale — the shared memory bus becomes a bottleneck.

NUMA solves the scaling problem by attaching dedicated memory to each CPU socket (or die). Local memory is fast; remote memory is accessible but slower. The topology creates "NUMA nodes" — groups of CPU cores that share a local memory pool.

Modern processor families and their NUMA characteristics:

| Platform | Interconnect | Typical Remote Penalty |
|----------|-------------|----------------------|
| Intel Xeon (Sapphire Rapids) | UPI 3.0 | 1.8-2.2x |
| AMD EPYC (Genoa) | Infinity Fabric 4.0 | 1.5-1.8x per hop |
| AMD EPYC (Rome/Milan) | Infinity Fabric 3.0 | 1.7-2.0x |
| ARM Ampere Altra | CMN-600 mesh | 1.3-1.6x |

AMD EPYC "chiplet" processors (Rome, Milan, Genoa) have an additional consideration: within a single socket, each chiplet die has its own local memory controller. A 64-core EPYC 7763 has 8 chiplet dies, creating 8 NUMA nodes per socket with 2 sockets equaling 16 NUMA nodes on a dual-socket server. The intra-socket penalty between chiplets is lower than the inter-socket penalty but still measurable.

### Discovering Your NUMA Topology

```bash
# Display NUMA node count and CPU layout
numactl --hardware

# Example output on a 2-socket Xeon server:
available: 2 nodes (0-1)
node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71
node 0 size: 257760 MB
node 0 free: 201432 MB
node 1 cpus: 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95
node 1 size: 258048 MB
node 1 free: 189765 MB
node distances:
node   0   1
  0:  10  21
  1:  21  10
```

The "node distances" matrix is critical. A distance of 10 means local access; 21 means approximately 2.1x the local latency for cross-node access.

```bash
# More detailed topology view
lstopo-no-graphics --of ascii

# NUMA statistics since boot
numastat

# Per-process NUMA statistics
numastat -p <pid>
numastat -p $(pgrep postgres)

# Show NUMA memory binding for running process
cat /proc/<pid>/numa_maps | head -20

# System-wide NUMA balancing statistics
cat /proc/sys/kernel/numa_balancing
numastat -m  # Memory usage by NUMA node
```

For AMD EPYC chiplet topology:

```bash
# Show the full CPU topology including chiplet (sub-NUMA cluster) structure
lstopo --output-format ascii

# Check if Sub-NUMA Clustering (SNC) is enabled in BIOS
# SNC splits a socket into 2 or 4 NUMA domains
# Check the NUMA domain count per socket
lscpu | grep -E "NUMA|Socket|Core|Thread"

# Example output showing SNC-2 on a single-socket EPYC:
# NUMA node(s): 4
# Socket(s): 1
# This means SNC-2 created 4 NUMA nodes on 1 socket
```

### Measuring NUMA Performance Impact

Use `numactl` to benchmark local vs. remote memory access:

```bash
# Install NUMA benchmarking tools
dnf install -y numad numactl numatop

# Benchmark with stream (memory bandwidth benchmark)
# Run on local memory only
numactl --cpunodebind=0 --membind=0 stream

# Run with remote memory
numactl --cpunodebind=0 --membind=1 stream

# Compare the "Triad" bandwidth numbers — remote will be lower
```

For a more surgical measurement:

```bash
# Install and use lat_mem_rd from lmbench
lat_mem_rd -t 1 -N 3 512m 2>&1 | grep "0.000100"

# Compare with numactl binding:
# Local node:
numactl --cpunodebind=0 --membind=0 lat_mem_rd -t 1 -N 3 512m

# Remote node:
numactl --cpunodebind=0 --membind=1 lat_mem_rd -t 1 -N 3 512m
```

## numactl: Manual NUMA Binding

`numactl` launches a program with a specific NUMA policy applied from the start. It is the most direct way to bind a database process to specific NUMA resources.

### NUMA Binding Options

```bash
# Bind process to CPU cores and memory of NUMA node 0
numactl --cpunodebind=0 --membind=0 postgres -D /var/lib/postgresql/data

# Run on node 0's CPUs but prefer node 0 memory, fall back to node 1
# (useful when node 0 memory might be insufficient)
numactl --cpunodebind=0 --preferred=0 postgres -D /var/lib/postgresql/data

# Interleave memory allocations across all nodes
# Best for memory-bandwidth-bound workloads (large sorts, hash joins)
numactl --interleave=all postgres -D /var/lib/postgresql/data

# Bind to specific CPU cores (not a full node)
numactl --physcpubind=0,1,2,3,4,5,6,7 --membind=0 postgres -D /var/lib/postgresql/data

# Run on node 1 entirely
numactl --cpunodebind=1 --membind=1 mysqld
```

### systemd Service Integration

For database services managed by systemd, set NUMA policy in the unit file:

```ini
# /etc/systemd/system/postgresql-15.service (override snippet)
[Service]
# Bind PostgreSQL to NUMA node 0
ExecStart=
ExecStart=/usr/bin/numactl --cpunodebind=0 --membind=0 /usr/pgsql-15/bin/postmaster -D /var/lib/pgsql/15/data/

# Alternatively use systemd's native NUMA directives (systemd 243+)
NUMAPolicy=bind
NUMAMask=0
```

Verify the binding after startup:

```bash
# Check process memory policy
cat /proc/$(pgrep -o postgres)/numa_maps | head -5

# Check CPU affinity
taskset -c -p $(pgrep -o postgres)

# Use numastat to watch per-node allocation rates
watch -n 1 'numastat -p $(pgrep -o postgres)'
```

## numad: Automatic NUMA Placement Daemon

`numad` is a daemon that monitors running processes and migrates them to optimal NUMA nodes based on their memory access patterns. It is less precise than manual binding but useful when you cannot hardcode NUMA topology (for example, when process memory requirements change over time, or when multiple workloads compete for resources).

### Installing and Configuring numad

```bash
# Install
dnf install -y numad

# Start and enable
systemctl start numad
systemctl enable numad

# Configuration
cat /etc/numad.conf
```

```ini
# /etc/numad.conf
# Minimum process size (MB) to consider for placement
# Processes smaller than this are not moved
THRESHHOLD_MB=50

# Polling interval in seconds
INTERVAL=15

# Logging verbosity (0=quiet, 1=warn, 2=info, 3=debug)
LOGGING=2

# Exclude specific processes from management
# Use process names or PIDs
EXCLUDE_PIDS=1234,5678
```

### Interacting with numad

```bash
# Show where numad recommends running a process with given CPUs and memory
# Useful for pre-placement before starting a process
numad -w 24:4096  # 24 CPUs, 4GB memory
# Output: 1  (recommends NUMA node 1)

# Show current topology advice for a running PID
numad -p <pid>

# Force placement of a process
numad -S 0 -p <pid>  # Move process to node 0

# Check numad's placement decisions
journalctl -u numad -f
```

## Memory Interleaving Policies

Memory interleaving spreads allocations across multiple NUMA nodes in round-robin fashion. This increases effective memory bandwidth at the cost of latency — half the allocations will be on a remote node.

### When to Use Interleaving

Interleaving is appropriate for:
- Memory-bandwidth-bound operations: large sequential scans, hash joins, sort operations
- Workloads that access data in unpredictable patterns where NUMA-local allocation does not help
- Processes that use more memory than fits on a single NUMA node

Interleaving is counterproductive for:
- Latency-sensitive, cache-friendly workloads (OLTP index lookups)
- Workloads that fit comfortably in a single node's memory

### Configuring PostgreSQL with Interleaving

```bash
# Start PostgreSQL with interleaved memory for buffer pool
# The shared_buffers pool benefits from interleaving when it's large
numactl --interleave=all /usr/pgsql-15/bin/postmaster -D /data/postgresql/

# For MySQL/MarinnoDB with large buffer pool
numactl --interleave=all mysqld --defaults-file=/etc/mysql/mysql.conf.d/mysqld.cnf

# Check the effect on memory distribution
numastat -p $(pgrep -o postgres)
# Both nodes should show similar allocation levels
```

### Kernel NUMA Balancing

Automatic NUMA balancing (`AutoNUMA`) is a kernel feature that migrates pages to the NUMA node most frequently accessing them:

```bash
# Check if NUMA balancing is enabled
cat /proc/sys/kernel/numa_balancing
# 0 = disabled, 1 = enabled

# Enable NUMA balancing
sysctl -w kernel.numa_balancing=1
echo "kernel.numa_balancing = 1" >> /etc/sysctl.d/numa.conf

# For databases with pinned processes, disable NUMA balancing
# to avoid unnecessary page migrations
sysctl -w kernel.numa_balancing=0
```

AutoNUMA adds overhead through page table scanning and page migration. For databases where you manually control NUMA placement, disable it and use explicit binding instead.

## CPU Affinity for Database Processes

CPU affinity pins a process to specific cores, preventing the scheduler from migrating it across NUMA nodes. Combined with NUMA memory binding, it ensures a database process always runs close to its data.

### taskset for CPU Affinity

```bash
# Set CPU affinity for a running process
taskset -c -p 0-23 $(pgrep -o postgres)  # Bind to cores 0-23

# Start a process with CPU affinity
taskset -c 0-23 postgres -D /var/lib/postgresql/data

# Check current affinity
taskset -c -p $(pgrep -o postgres)
```

### PostgreSQL CPU Affinity Configuration

PostgreSQL spawns worker processes. Use `pg_affinity` extension or control at the OS level:

```bash
# /etc/postgresql/15/main/postgresql.conf additions:

# Limit max worker processes to match NUMA node CPU count
max_worker_processes = 24        # Match half the total cores for node 0
max_parallel_workers = 12        # Half of worker processes for parallel queries
max_parallel_workers_per_gather = 6

# Use huge pages to reduce TLB pressure (important for NUMA workloads)
huge_pages = on                  # Requires hugetlbfs configured
```

Configure huge pages at the OS level to benefit from TLB coverage for large NUMA-bound workloads:

```bash
# Calculate required huge pages for PostgreSQL shared_buffers
# shared_buffers = 128GB, huge page size = 2MB
# Pages needed = 128*1024 / 2 = 65536

# Allocate huge pages
echo 65536 > /proc/sys/vm/nr_hugepages
echo "vm.nr_hugepages = 65536" >> /etc/sysctl.d/hugepages.conf

# Verify allocation
grep HugePages /proc/meminfo

# Set huge pages policy for NUMA — allocate proportionally per node
echo 32768 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 32768 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages
```

### MySQL/InnoDB NUMA Configuration

MySQL InnoDB has its own NUMA-related tuning:

```ini
# /etc/mysql/mysql.conf.d/mysqld.cnf

# Disable InnoDB's internal NUMA interleaving
# (Let numactl handle the policy externally)
innodb_numa_interleave = OFF

# InnoDB buffer pool: one instance per NUMA node
# 4 nodes * 32GB = 128GB total
innodb_buffer_pool_size = 128G
innodb_buffer_pool_instances = 4

# Keep threads on their assigned CPUs
innodb_spin_wait_delay = 6
```

Start MySQL with explicit NUMA binding:

```bash
# Two-socket server, bind MySQL to node 0
numactl --cpunodebind=0 --membind=0 \
  mysqld --defaults-file=/etc/mysql/mysql.conf.d/mysqld.cnf

# Alternatively for a workload requiring all memory:
numactl --interleave=0,1 \
  mysqld --defaults-file=/etc/mysql/mysql.conf.d/mysqld.cnf
```

## Kubernetes NUMA-Aware Scheduling

Kubernetes added NUMA-awareness through the CPU Manager, Memory Manager, and Topology Manager. These components ensure that pods requiring specific CPU and memory resources are placed with NUMA-aligned allocations.

### Topology Manager

The Topology Manager is a kubelet component that coordinates NUMA-aligned resource allocation across CPU, memory, and devices (like GPUs and SR-IOV NICs).

Enable it in the kubelet configuration:

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: "single-numa-node"
# Options:
# none          - default, no topology consideration
# best-effort   - try NUMA alignment, proceed if impossible
# restricted    - require NUMA alignment, fail if impossible
# single-numa-node - require all resources from a single NUMA node
```

### CPU Manager with Static Policy

The CPU Manager static policy grants exclusive CPU cores to Guaranteed QoS pods:

```yaml
# /var/lib/kubelet/config.yaml
cpuManagerPolicy: "static"
# Reserve CPUs for kubelet and system processes
reservedSystemCPUs: "0-3"
```

For the CPU Manager to allocate NUMA-aligned CPUs, the pod must:
1. Be in the Guaranteed QoS class (requests == limits)
2. Request whole CPU cores (integer values)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres-numa-optimized
spec:
  containers:
    - name: postgres
      image: postgres:16
      resources:
        requests:
          cpu: "24"          # Must be integer for exclusive CPU allocation
          memory: "256Gi"
        limits:
          cpu: "24"          # requests must equal limits for Guaranteed QoS
          memory: "256Gi"
      env:
        - name: POSTGRES_SHARED_BUFFERS
          value: "128GB"
```

### Memory Manager with Static Policy

The Memory Manager (beta in Kubernetes 1.26+) provides NUMA-aligned memory allocation:

```yaml
# /var/lib/kubelet/config.yaml
memoryManagerPolicy: "Static"
reservedMemory:
  - numaNode: 0
    limits:
      memory: 4Gi        # Reserve 4GB on node 0 for kubelet/system
  - numaNode: 1
    limits:
      memory: 4Gi
```

### Verifying NUMA Alignment in Kubernetes

```bash
# Check which CPUs were allocated to a pod
kubectl exec -it postgres-numa-optimized -- taskset -c -p 1
# pid 1's current affinity list: 24,25,26,...47  (all from NUMA node 1)

# Check the kubelet's topology hints
kubectl describe node <node-name> | grep -A 20 "Allocated resources"

# Verify memory NUMA binding inside the pod
kubectl exec -it postgres-numa-optimized -- cat /proc/1/numa_maps | head -10

# Use numastat inside the pod (requires privileged or numastat binary in image)
kubectl exec -it postgres-numa-optimized -- numastat -p 1
```

### NUMA-Aware Node Selection

Use node labels and taints to direct database workloads to specific nodes with known NUMA topology:

```bash
# Label nodes with their NUMA topology
kubectl label node db-node-1 \
  numa.topology/nodes="2" \
  numa.topology/cores-per-node="24" \
  numa.topology/memory-per-node="256Gi"

# Taint the node to reserve it for database workloads
kubectl taint node db-node-1 \
  workload-type=database:NoSchedule
```

```yaml
# Database pod with NUMA topology selection
apiVersion: v1
kind: Pod
metadata:
  name: mysql-production
spec:
  nodeSelector:
    numa.topology/nodes: "2"
  tolerations:
    - key: workload-type
      value: database
      effect: NoSchedule
  containers:
    - name: mysql
      image: mysql:8.4
      resources:
        requests:
          cpu: "48"
          memory: "512Gi"
        limits:
          cpu: "48"
          memory: "512Gi"
```

## NUMA Tuning for Specific Databases

### PostgreSQL NUMA Optimization Script

```bash
#!/bin/bash
# postgresql-numa-tuning.sh
# Run before starting PostgreSQL on a NUMA server

set -euo pipefail

POSTGRES_NODE=${1:-0}  # Target NUMA node
DATA_DIR=${2:-/var/lib/pgsql/15/data}
PG_BIN=/usr/pgsql-15/bin

# Identify CPUs on target node
NODE_CPUS=$(numactl --hardware | awk "/node ${POSTGRES_NODE} cpus:/{print \$NF}" | head -1)
echo "Target NUMA node: ${POSTGRES_NODE}"
echo "CPUs: $(numactl --hardware | grep "node ${POSTGRES_NODE} cpus:")"
echo "Memory: $(numactl --hardware | grep "node ${POSTGRES_NODE} size:")"

# Configure huge pages on target node
FREE_MEM=$(numactl --hardware | grep "node ${POSTGRES_NODE} free:" | awk '{print $4}')
HUGEPAGE_SIZE=2048  # 2MB huge pages in KB
# Allocate 80% of free memory as huge pages
HUGEPAGES=$(( (FREE_MEM * 1024 * 80 / 100) / HUGEPAGE_SIZE ))
echo "Allocating ${HUGEPAGES} huge pages on node ${POSTGRES_NODE}"
echo ${HUGEPAGES} > /sys/devices/system/node/node${POSTGRES_NODE}/hugepages/hugepages-2048kB/nr_hugepages

# Set transparent huge pages to madvise (PostgreSQL prefers explicit huge pages)
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Disable NUMA balancing for this workload
sysctl -w kernel.numa_balancing=0

# Set memory overcommit conservatively for database servers
sysctl -w vm.overcommit_ratio=80
sysctl -w vm.overcommit_memory=2

# Start PostgreSQL bound to target node
exec numactl \
  --cpunodebind=${POSTGRES_NODE} \
  --membind=${POSTGRES_NODE} \
  ${PG_BIN}/postmaster -D ${DATA_DIR}
```

### Redis NUMA Configuration

Redis is single-threaded for its main loop but uses background threads for I/O. NUMA binding is beneficial:

```bash
# /etc/systemd/system/redis.service override
[Service]
ExecStart=
ExecStart=/usr/bin/numactl --cpunodebind=1 --membind=1 /usr/bin/redis-server /etc/redis/redis.conf

# redis.conf additions
# Pin to specific CPU for main thread
server_cpulist 24-47        # Node 1 CPUs
bgsave_cpulist 24-27        # Reserve 4 cores for background saves
bio_cpulist 28-31           # 4 cores for background I/O
```

### Cassandra NUMA Configuration

Cassandra benefits from interleaved memory due to its wide column storage model:

```bash
# cassandra-env.sh
# Interleave memory when the heap exceeds a single NUMA node's capacity
if [ "$(numactl --hardware | grep 'available' | awk '{print $2}')" -gt "1" ]; then
    export NUMACTL_ARGS="--interleave=all"
fi

# JVM NUMA options for Java-based databases
JVM_OPTS="$JVM_OPTS -XX:+UseNUMA"
JVM_OPTS="$JVM_OPTS -XX:+UseParallelGC"
JVM_OPTS="$JVM_OPTS -XX:+AlwaysPreTouch"  # Touch all pages at startup to force NUMA placement
```

## Monitoring NUMA Performance

### Key Metrics to Track

```bash
# Watch NUMA hit/miss rates in real time
numastat -z  # Show only non-zero values

# Per-node allocation rates
watch -n 1 'cat /sys/devices/system/node/node*/numastat'

# Key metrics:
# numa_hit       - Successful local allocations
# numa_miss      - Remote allocations (the problem metric)
# numa_foreign   - Allocations intended local but placed remote
# interleave_hit - Successful interleaved allocations
# local_node     - Allocations by local process
# other_node     - Allocations by remote process

# Calculate NUMA miss rate
awk '
/numa_miss/ { miss += $2 }
/numa_hit/  { hit += $2 }
END { printf "NUMA miss rate: %.2f%%\n", (miss/(miss+hit))*100 }
' /sys/devices/system/node/node0/numastat
```

### numatop for Real-Time Analysis

`numatop` provides a top-like interface for NUMA analysis:

```bash
# Install
dnf install -y numatop

# Run numatop
numatop

# Key display:
# NUMA_MISS%  - Percentage of memory accesses that are NUMA misses
# This should be below 5% for optimal performance
# Above 20% indicates a serious NUMA placement problem
```

### Prometheus NUMA Metrics

Export NUMA metrics to Prometheus via the node exporter:

```yaml
# prometheus-node-exporter daemonset with additional collectors
containers:
  - name: node-exporter
    args:
      - --collector.cpu
      - --collector.meminfo
      - --collector.interrupts
      # Custom text file collector for NUMA stats
      - --collector.textfile.directory=/var/run/prometheus-node-exporter
```

```bash
#!/bin/bash
# /usr/local/bin/numa-metrics.sh — collect NUMA stats for prometheus
# Run via cron every 30 seconds

OUTPUT=/var/run/prometheus-node-exporter/numa.prom
TMP=$(mktemp)

for node in /sys/devices/system/node/node[0-9]*; do
    NODE_ID=$(basename $node | tr -d 'node')
    while IFS= read -r line; do
        METRIC=$(echo $line | awk '{print $1}')
        VALUE=$(echo $line | awk '{print $2}')
        echo "node_numa_${METRIC}{node=\"${NODE_ID}\"} ${VALUE}" >> $TMP
    done < ${node}/numastat
done

mv $TMP $OUTPUT
```

## Troubleshooting NUMA Issues

### Diagnosing High NUMA Miss Rates

```bash
# Step 1: Identify processes with high remote memory access
numastat -p $(pgrep -d',' postgres)

# Step 2: Check if the process memory spans multiple nodes
cat /proc/$(pgrep -o postgres)/numa_maps | grep -v "^$" | \
  awk '{print $1, $2, $3}' | sort -k3 -rn | head -20

# Step 3: Check kernel NUMA statistics
grep -E "Numa(Hit|Miss|Foreign)" /proc/vmstat

# Step 4: Verify the process is not being migrated by AutoNUMA
# Temporarily disable and check if performance improves
sysctl -w kernel.numa_balancing=0
```

### NUMA Imbalance During High Load

If a database process needs more memory than fits in one NUMA node, use interleaving rather than letting the kernel allocate on remote nodes:

```bash
# Check current node memory usage
numastat -m | grep -E "MemFree|MemUsed|Active"

# If one node is near capacity, restart the database with interleaving
systemctl stop postgresql-15
numactl --interleave=all /usr/pgsql-15/bin/postmaster -D /var/lib/pgsql/15/data
```

### BIOS Settings That Affect NUMA

Several BIOS settings interact with NUMA topology:

- **NUMA Enabled/Disabled**: Some BIOS configurations present all memory as a flat SMP system. Verify NUMA is enabled in BIOS.
- **Sub-NUMA Clustering (SNC)**: On Intel, SNC splits each socket into 2 or 4 NUMA nodes for better locality. On AMD, it is called NPS (NUMA Nodes Per Socket). Enable SNC/NPS for database workloads.
- **UMA/Flat Memory Mode**: AMD EPYC has a "flat" memory mode that hides the chiplet NUMA topology. The "NPS4" mode exposes maximum NUMA granularity.

```bash
# Check if SNC/NPS is effective
lscpu | grep "NUMA node(s)"
# If this shows more nodes than sockets, SNC/NPS is active
numactl --hardware | grep "node distances"
# Shorter distances between all nodes indicates flat/disabled NUMA
```

## Summary

NUMA optimization for database servers requires a layered approach: understand the physical topology with `numactl --hardware` and `lstopo`, measure the miss rate with `numastat`, apply explicit binding with `numactl` or `numad` for processes where memory fits within a node, use interleaving for bandwidth-bound operations or large buffer pools that span nodes, and verify the improvement by monitoring `numa_miss` rates before and after changes. On Kubernetes, the Topology Manager with `single-numa-node` policy provides automated NUMA alignment for database Pods that declare resource requests matching whole NUMA nodes. The combination of these techniques routinely delivers 20-40% throughput improvements on latency-sensitive database workloads — gains that no amount of query tuning can match when the underlying memory access pattern is inefficient.
