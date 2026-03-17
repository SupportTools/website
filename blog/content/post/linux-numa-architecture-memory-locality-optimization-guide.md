---
title: "Linux NUMA Architecture: Memory Locality Optimization"
date: 2029-04-14T00:00:00-05:00
draft: false
tags: ["Linux", "NUMA", "Performance", "Memory", "CPU Pinning", "Kubernetes", "HPC"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux NUMA architecture covering NUMA topology inspection, numactl, numastat, CPU pinning, memory policies, NUMA-aware application design, and Kubernetes NUMA manager configuration."
more_link: "yes"
url: "/linux-numa-architecture-memory-locality-optimization-guide/"
---

On modern multi-socket servers, memory access latency is not uniform. A CPU accessing memory attached to its own socket (local memory) is significantly faster than accessing memory attached to a remote socket. This Non-Uniform Memory Access (NUMA) architecture is the default on any server with more than one physical CPU socket, and ignoring it can leave 20-40% of memory bandwidth on the table for latency-sensitive workloads.

This guide covers NUMA topology from the hardware level through kernel memory policies, application-level optimization strategies, and Kubernetes NUMA-aware scheduling for high-performance containers.

<!--more-->

# Linux NUMA Architecture: Memory Locality Optimization

## Section 1: NUMA Topology and Hardware Architecture

### Understanding NUMA Nodes

A NUMA system consists of multiple nodes, each containing:
- One or more physical CPU sockets (and their CPU cores)
- A bank of local DRAM directly attached to that socket
- A high-speed interconnect (Intel QPI/UPI, AMD Infinity Fabric) to reach remote nodes

Access latencies are typically:
- Local memory: 70-100 ns
- Remote memory (1 hop): 130-200 ns
- Remote memory (2 hops): 200-400 ns

### Inspecting NUMA Topology

```bash
# Show NUMA topology summary
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 24 25 26 27 28 29 30 31 32 33 34 35
# node 0 size: 128780 MB
# node 0 free: 95632 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23 36 37 38 39 40 41 42 43 44 45 46 47
# node 1 size: 128830 MB
# node 1 free: 87541 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Detailed NUMA topology with NUMA distances
cat /sys/devices/system/node/node*/distance
# 10 21
# 21 10

# CPU to NUMA node mapping
for cpu in /sys/devices/system/cpu/cpu*/; do
  cpunum=$(basename $cpu | tr -d 'cpu')
  node=$(cat $cpu/topology/physical_package_id 2>/dev/null)
  numa=$(cat /sys/devices/system/cpu/cpu${cpunum}/topology/die_id 2>/dev/null)
  echo "CPU $cpunum: socket $node"
done | sort -t' ' -k2n

# Use lscpu for a complete view
lscpu --extended
# CPU  NODE SOCKET CORE L1d L1i L2  L3
# 0    0    0      0    0   0   0   0
# 1    0    0      1    1   1   1   0
# ...
# 12   1    1      0    12  12  12  1

# hwloc for visual NUMA topology
lstopo --of ascii 2>/dev/null || \
  lstopo-no-graphics --of console
```

### NUMA Node Memory Statistics

```bash
# Current NUMA memory allocation per node
numastat
#                            node0          node1
# numa_hit             123456789      234567890
# numa_miss                 1234           5678
# numa_foreign              5678           1234
# interleave_hit           12345          23456
# local_node           123456789      234567890
# other_node                1234           5678

# Per-process NUMA memory mapping
numastat -p 12345  # replace with PID
# Per-node process memory usage (in MBs):
#                            node0     node1     Total
# Process pages         12345.6    1234.5   13580.1
# Huge pages                0.0       0.0       0.0

# Check NUMA memory for specific processes
numastat -c nginx
```

### NUMA Imbalance Detection

```bash
# Check for NUMA imbalances in kernel counters
cat /proc/vmstat | grep -i numa
# numa_hit 123456789
# numa_miss 1234         <- memory allocated on wrong node
# numa_foreign 1234      <- memory allocated here for another node
# numa_interleave 12345
# numa_local 123456789
# numa_other 1234        <- local process accessing remote memory

# Calculate NUMA miss rate
awk '/numa_hit/ {hit=$2} /numa_miss/ {miss=$2} END {
  printf "NUMA miss rate: %.2f%%\n", miss/(hit+miss)*100
}' /proc/vmstat

# Monitor NUMA statistics in real-time
watch -n1 'cat /proc/vmstat | grep numa'
```

## Section 2: numactl — Controlling NUMA Placement

### Running Processes on Specific NUMA Nodes

```bash
# Run a process bound to NUMA node 0
numactl --cpunodebind=0 --membind=0 ./my_application

# Bind to specific CPUs (hyperthreading-aware)
numactl --physcpubind=0,2,4,6 --membind=0 ./my_application

# Interleave memory across all nodes (good for throughput, bad for latency)
numactl --interleave=all ./my_application

# Prefer node 0 but allow allocation from node 1 if node 0 is full
numactl --preferred=0 ./my_application

# Run MySQL on node 0 CPUs and memory
numactl --cpunodebind=0 --membind=0 mysqld

# Run application with memory from multiple specific nodes
numactl --membind=0,1 --cpunodebind=0 ./my_application
```

### numactl for Database Workloads

```bash
# PostgreSQL NUMA binding
# Node 0: CPU-bound query processing
# Node 1: I/O bound buffer operations

# Create systemd override for PostgreSQL
mkdir -p /etc/systemd/system/postgresql.service.d/
cat > /etc/systemd/system/postgresql.service.d/numa.conf << 'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/numactl --cpunodebind=0 --membind=0 /usr/lib/postgresql/16/bin/postgres \
  -D /var/lib/postgresql/16/main \
  -c config_file=/etc/postgresql/16/main/postgresql.conf
EOF

systemctl daemon-reload
systemctl restart postgresql

# Verify NUMA binding
cat /proc/$(pgrep postgres | head -1)/numa_maps | head -5
```

### numactl for Java Applications

```bash
# JVM heap allocated on NUMA node 0
numactl --cpunodebind=0 --membind=0 java \
  -Xmx32g \
  -Xms32g \
  -XX:+UseNUMA \
  -XX:+UseG1GC \
  -jar myapp.jar

# JVM with NUMA-aware GC (G1GC spreads heap across nodes for better parallelism)
# Use when the JVM heap exceeds a single NUMA node's memory
numactl --interleave=all java \
  -Xmx128g \
  -Xms128g \
  -XX:+UseNUMA \
  -XX:+UseG1GC \
  -XX:G1HeapRegionSize=32m \
  -jar large-heap-app.jar
```

## Section 3: Memory Policies

### Linux Memory Policy Types

The Linux kernel supports four memory allocation policies:

| Policy | Description | Use Case |
|---|---|---|
| default | Allocate on current node, fallback to others | General workloads |
| bind | Only allocate from specified nodes, fail if unavailable | Latency-critical |
| preferred | Prefer specified node, fallback to others | Balanced latency |
| interleave | Round-robin across specified nodes | Memory bandwidth |

### Setting Memory Policy with mbind

```c
#include <numa.h>
#include <numaif.h>
#include <sys/mman.h>

void allocate_numa_aware_buffer(size_t size, int numa_node) {
    // Allocate on a specific NUMA node
    struct bitmask *nodes = numa_allocate_nodemask();
    numa_bitmask_setbit(nodes, numa_node);

    void *buf = mmap(NULL, size, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (buf == MAP_FAILED) {
        perror("mmap failed");
        return;
    }

    // Bind this memory region to node 0
    if (mbind(buf, size, MPOL_BIND, nodes->maskp, nodes->size + 1, 0) != 0) {
        perror("mbind failed");
    }

    numa_free_nodemask(nodes);

    // Touch the memory to force allocation on the bound node
    memset(buf, 0, size);
}

void allocate_interleaved_buffer(size_t size) {
    // Interleave allocation across all nodes for maximum bandwidth
    struct bitmask *nodes = numa_get_mems_allowed();

    void *buf = mmap(NULL, size, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (buf == MAP_FAILED) {
        perror("mmap failed");
        return;
    }

    if (mbind(buf, size, MPOL_INTERLEAVE, nodes->maskp, nodes->size + 1, 0) != 0) {
        perror("mbind interleave failed");
    }
}
```

### Process-Level Memory Policy

```c
#include <numa.h>
#include <numaif.h>

void set_process_numa_policy(void) {
    // Check if NUMA is available
    if (numa_available() < 0) {
        fprintf(stderr, "NUMA not available\n");
        return;
    }

    int num_nodes = numa_num_configured_nodes();
    printf("NUMA nodes: %d\n", num_nodes);

    // Set default policy: prefer node 0
    struct bitmask *preferred = numa_allocate_nodemask();
    numa_bitmask_setbit(preferred, 0);

    if (set_mempolicy(MPOL_PREFERRED, preferred->maskp, preferred->size + 1) != 0) {
        perror("set_mempolicy failed");
    }

    numa_free_nodemask(preferred);
}
```

### NUMA Memory Migration

```bash
# Move pages belonging to a process to its local node
numactl --localalloc ./my_program &
PID=$!

# After process is running, check its memory placement
cat /proc/$PID/numa_maps | grep ' N[0-9]='

# Migrate pages to local node
migratepages $PID all local

# Verify migration
cat /proc/$PID/numa_maps | grep ' N[0-9]='
```

## Section 4: CPU Pinning and NUMA Affinity

### taskset — CPU Affinity

```bash
# Pin process to CPUs on NUMA node 0
# First, find which CPUs belong to node 0
node0_cpus=$(cat /sys/devices/system/node/node0/cpulist)
echo "Node 0 CPUs: $node0_cpus"
# Node 0 CPUs: 0-11,24-35

# Pin with taskset
taskset -c "$node0_cpus" ./my_application

# Pin a running process
taskset -cp "$node0_cpus" 12345

# Verify CPU affinity
taskset -p 12345
# pid 12345's current affinity mask: fff000fff
```

### cgroups for NUMA Isolation

```bash
# Create a cgroup with NUMA and CPU constraints
mkdir /sys/fs/cgroup/cpuset/numa-node0

# Assign CPUs and memory from node 0 only
echo "0-11,24-35" > /sys/fs/cgroup/cpuset/numa-node0/cpuset.cpus
echo "0"          > /sys/fs/cgroup/cpuset/numa-node0/cpuset.mems

# Enable memory migration to ensure pages are on correct NUMA node
echo "1"          > /sys/fs/cgroup/cpuset/numa-node0/cpuset.memory_migrate

# Enable memory pressure reporting
echo "1"          > /sys/fs/cgroup/cpuset/numa-node0/cpuset.memory_pressure_enabled

# Assign process to this cgroup
echo $PID > /sys/fs/cgroup/cpuset/numa-node0/tasks
```

### systemd CPU and Memory Affinity

```ini
# /etc/systemd/system/my-service.service
[Unit]
Description=My NUMA-optimized Service

[Service]
ExecStart=/usr/bin/my-application
# Pin to CPUs 0-11 (NUMA node 0 on a 2-socket system)
CPUAffinity=0-11 24-35
# Pin memory allocation to NUMA node 0
# (requires systemd >= 243)
NUMAPolicy=bind
NUMAMask=0

# Alternative: use numactl wrapper
# ExecStart=numactl --cpunodebind=0 --membind=0 /usr/bin/my-application

[Install]
WantedBy=multi-user.target
```

### Interrupt Affinity (IRQ Balancing)

Network and storage interrupts should be distributed across CPUs on all NUMA nodes. By default, `irqbalance` handles this, but for high-throughput workloads, manual assignment gives better control:

```bash
# Stop irqbalance for manual control
systemctl stop irqbalance
systemctl mask irqbalance

# Find NIC interrupts
cat /proc/interrupts | grep eth0
# 24:   1234567  PCI-MSI-X  eth0-0
# 25:   2345678  PCI-MSI-X  eth0-1
# ...

# Pin NIC queue interrupts to CPUs on both NUMA nodes
# Queue 0 -> CPU 0 (node 0)
echo 1 > /proc/irq/24/smp_affinity_list

# Queue 1 -> CPU 12 (node 1)
echo 4096 > /proc/irq/25/smp_affinity_list

# Script to distribute NIC queues across NUMA nodes
distribute_irqs() {
    local nic=$1
    local irqs=($(cat /proc/interrupts | grep "${nic}-" | awk '{print $1}' | tr -d ':'))
    local node0_cpus=($(cat /sys/devices/system/node/node0/cpulist | tr ',' ' '))
    local node1_cpus=($(cat /sys/devices/system/node/node1/cpulist | tr ',' ' '))
    local all_cpus=("${node0_cpus[@]}" "${node1_cpus[@]}")

    for i in "${!irqs[@]}"; do
        cpu_idx=$((i % ${#all_cpus[@]}))
        cpu=${all_cpus[$cpu_idx]}
        echo $cpu > /proc/irq/${irqs[$i]}/smp_affinity_list
        echo "IRQ ${irqs[$i]} -> CPU $cpu"
    done
}

distribute_irqs eth0
```

## Section 5: NUMA-Aware Application Design

### Memory Allocation Patterns

```c
// NUMA-aware memory pool
#include <numa.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

typedef struct {
    void  *base;
    size_t size;
    size_t used;
    int    numa_node;
    pthread_mutex_t lock;
} NUMAMemPool;

NUMAMemPool* numa_pool_create(int node, size_t size) {
    NUMAMemPool *pool = malloc(sizeof(NUMAMemPool));
    if (!pool) return NULL;

    // Allocate the memory pool on the specified NUMA node
    pool->base = numa_alloc_onnode(size, node);
    if (!pool->base) {
        free(pool);
        return NULL;
    }

    pool->size = size;
    pool->used = 0;
    pool->numa_node = node;
    pthread_mutex_init(&pool->lock, NULL);

    // Pre-fault the pages to ensure they're on the correct node
    memset(pool->base, 0, size);

    return pool;
}

void* numa_pool_alloc(NUMAMemPool *pool, size_t bytes) {
    // Align to cache line size (64 bytes on x86)
    bytes = (bytes + 63) & ~63;

    pthread_mutex_lock(&pool->lock);
    if (pool->used + bytes > pool->size) {
        pthread_mutex_unlock(&pool->lock);
        return NULL;
    }

    void *ptr = (char*)pool->base + pool->used;
    pool->used += bytes;
    pthread_mutex_unlock(&pool->lock);

    return ptr;
}

void numa_pool_destroy(NUMAMemPool *pool) {
    numa_free(pool->base, pool->size);
    pthread_mutex_destroy(&pool->lock);
    free(pool);
}
```

### Thread Affinity for NUMA Performance

```c
#include <pthread.h>
#include <sched.h>
#include <numa.h>

// Worker thread bound to a specific NUMA node
struct WorkerArgs {
    int     thread_id;
    int     numa_node;
    int     cpu_start;
    int     cpu_count;
    void   *work_queue;
};

void* worker_thread(void *arg) {
    struct WorkerArgs *args = arg;

    // Set CPU affinity for this thread
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    for (int i = args->cpu_start; i < args->cpu_start + args->cpu_count; i++) {
        CPU_SET(i, &cpuset);
    }

    if (pthread_setaffinity_np(pthread_self(), sizeof(cpuset), &cpuset) != 0) {
        perror("pthread_setaffinity_np");
    }

    // Set NUMA memory policy for this thread
    struct bitmask *node_mask = numa_allocate_nodemask();
    numa_bitmask_setbit(node_mask, args->numa_node);
    numa_set_membind(node_mask);
    numa_free_nodemask(node_mask);

    // All subsequent memory allocations in this thread will be
    // on the specified NUMA node
    process_work(args->work_queue);

    return NULL;
}

void create_numa_workers(int num_nodes, int threads_per_node) {
    int total_threads = num_nodes * threads_per_node;
    pthread_t *threads = malloc(total_threads * sizeof(pthread_t));
    struct WorkerArgs *args = malloc(total_threads * sizeof(struct WorkerArgs));

    int cpus_per_node = numa_num_configured_cpus() / num_nodes;

    for (int node = 0; node < num_nodes; node++) {
        for (int t = 0; t < threads_per_node; t++) {
            int idx = node * threads_per_node + t;
            args[idx].thread_id = idx;
            args[idx].numa_node = node;
            args[idx].cpu_start = node * cpus_per_node + t * (cpus_per_node / threads_per_node);
            args[idx].cpu_count = cpus_per_node / threads_per_node;

            pthread_create(&threads[idx], NULL, worker_thread, &args[idx]);
        }
    }

    for (int i = 0; i < total_threads; i++) {
        pthread_join(threads[i], NULL);
    }

    free(threads);
    free(args);
}
```

## Section 6: Kernel NUMA Balancing

### Automatic NUMA Balancing

Linux includes automatic NUMA balancing (`AutoNUMA`) that migrates pages and tasks to improve locality:

```bash
# Check if AutoNUMA is enabled
cat /proc/sys/kernel/numa_balancing
# 1 (enabled)

# Enable/disable AutoNUMA
echo 1 > /proc/sys/kernel/numa_balancing   # enable
echo 0 > /proc/sys/kernel/numa_balancing   # disable

# Persistent via sysctl
cat >> /etc/sysctl.d/99-numa.conf << 'EOF'
# Enable NUMA balancing for workloads that cannot be manually bound
kernel.numa_balancing = 1

# NUMA balancing scan delay in milliseconds (default: 1000ms)
kernel.numa_balancing_scan_delay_ms = 1000

# NUMA balancing scan period (default: 1000ms)
kernel.numa_balancing_scan_period_min_ms = 1000
kernel.numa_balancing_scan_period_max_ms = 60000

# NUMA balancing scan size in MB
kernel.numa_balancing_scan_size_mb = 256
EOF

sysctl -p /etc/sysctl.d/99-numa.conf
```

### Monitoring NUMA Balancing Activity

```bash
# Monitor NUMA migration statistics
perf stat -e \
  numa:numa_migrate_pages,\
  numa:numa_pages_migrated,\
  sched:sched_migrate_task \
  -p $PID sleep 30

# Watch NUMA migration in /proc/vmstat
watch -n1 'grep -E "numa|migrate" /proc/vmstat'
# pgmigrate_success: pages successfully migrated
# pgmigrate_fail: pages failed to migrate
# numa_pte_updates: page table updates for NUMA hinting
# numa_huge_pte_updates: huge page NUMA hinting updates
# numa_hint_faults: NUMA hint page faults
# numa_hint_faults_local: hint faults on local node
# numa_pages_migrated: pages migrated by AutoNUMA
```

## Section 7: Kubernetes NUMA Manager

### NUMA Manager Configuration

Kubernetes supports NUMA-aware CPU and memory allocation through the `TopologyManager` and `CPUManager`:

```yaml
# kubelet configuration with NUMA-aware scheduling
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# CPU Manager: static policy pins CPUs to containers
cpuManagerPolicy: static
cpuManagerPolicyOptions:
  # Align CPU allocation to NUMA nodes
  align-by-socket: "true"
  # Distribute CPUs across physical cores first
  distribute-cpus-across-numa: "true"
  # Full-PCIe alignment for GPU workloads
  full-pcpus-only: "true"

# Memory Manager: pin memory banks to containers
memoryManagerPolicy: Static
reservedMemory:
- numaNode: 0
  limits:
    memory: "1Gi"
    hugepages-1Gi: "0"
    hugepages-2Mi: "0"
- numaNode: 1
  limits:
    memory: "1Gi"

# Topology Manager aligns all resources to NUMA nodes
topologyManagerPolicy: single-numa-node   # or: best-effort, restricted, none
topologyManagerScope: container            # or: pod
```

### NUMA-Aware Pod Specification

To benefit from NUMA alignment, containers must request:
- Integer CPU counts (Guaranteed QoS class)
- Hugepage memory (triggers memory manager)
- Devices via device plugins (GPU, FPGA, NICs)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: numa-aware-workload
  namespace: production
spec:
  containers:
  - name: compute-intensive
    image: registry.example.com/hpc-workload:v1.0
    resources:
      limits:
        # Must request whole CPUs for CPU Manager static policy
        cpu: "8"
        memory: "32Gi"
        # Hugepages trigger Memory Manager NUMA alignment
        hugepages-1Gi: "16Gi"
        # GPU also triggers Topology Manager alignment
        nvidia.com/gpu: "1"
      requests:
        cpu: "8"
        memory: "32Gi"
        hugepages-1Gi: "16Gi"
        nvidia.com/gpu: "1"
    volumeMounts:
    - name: hugepages
      mountPath: /hugepages
  volumes:
  - name: hugepages
    emptyDir:
      medium: HugePages-1Gi
  # Node selector for NUMA-capable nodes
  nodeSelector:
    numa-topology: "multi-node"
  # Avoid preemption that could disrupt NUMA alignment
  priorityClassName: high-priority
```

### Verifying NUMA Alignment in Kubernetes

```bash
# Check CPU assignment for a container
CONTAINER_ID=$(kubectl get pod numa-pod -n production \
  -o jsonpath='{.status.containerStatuses[0].containerID}' | \
  sed 's/.*:\/\///')

# On the node where the pod runs:
# Check cgroup CPU assignment
cat /sys/fs/cgroup/cpuset/kubepods/pod*/$(echo $CONTAINER_ID | cut -c1-12)*/cpuset.cpus
# 0-7  <- CPUs 0-7 (all on NUMA node 0 on a 2-socket 8-core system)

cat /sys/fs/cgroup/cpuset/kubepods/pod*/$(echo $CONTAINER_ID | cut -c1-12)*/cpuset.mems
# 0    <- Memory from NUMA node 0 only

# Check Topology Manager alignment decision
kubectl describe node worker-1 | grep -A 20 "Topology Hints"

# CPU Manager state file
cat /var/lib/kubelet/cpu_manager_state
# {
#   "policyName": "static",
#   "defaultCpuSet": "12-23",
#   "entries": {
#     "pod-uid": {
#       "container-name": "0-11"
#     }
#   }
# }
```

### NUMA Topology Manager Policies

```bash
# single-numa-node: strictest, all resources on same NUMA node
# Best for: GPU workloads, latency-critical applications
# Risk: pod may not schedule if no single node has all requested resources

# restricted: same as single-numa-node but falls back gracefully
# Best for: production workloads where NUMA alignment is important

# best-effort: tries to align, proceeds even if alignment impossible
# Best for: most general workloads

# none: disables topology alignment entirely
# Best for: backward compatibility

# Check current topology manager decisions
kubectl describe node worker-1 | grep "topology"

# View node topology via the node topology API
kubectl get node worker-1 -o json | jq '.status.allocatable'
```

## Section 8: NUMA Performance Benchmarking

### Measuring NUMA Access Latency

```bash
# Install numactl and stream benchmark
apt-get install numactl stream

# Baseline: interleaved memory (crosses NUMA nodes)
numactl --interleave=all stream -n 100000000
# Copy: 45678.0 MB/s

# NUMA-local: memory and CPU on same node
numactl --cpunodebind=0 --membind=0 stream -n 100000000
# Copy: 56789.0 MB/s  <- ~25% faster than interleaved

# NUMA-remote: CPU on node 0, memory on node 1
numactl --cpunodebind=0 --membind=1 stream -n 100000000
# Copy: 32456.0 MB/s  <- ~40% slower than local

# Memory latency benchmark
# Install mlc (Intel Memory Latency Checker)
./mlc --latency_matrix
# Measuring idle latencies (in ns)...
#                 Numa node
# Numa node            0            1
#        0          72.4        131.8
#        1         131.8         72.9
```

### Performance Monitoring with perf

```bash
# Monitor NUMA-related CPU events
perf stat -e \
  cpu/event=0xd0,umask=0x81,name=mem_load_retired_l3_miss/ \
  -e cpu/event=0xd0,umask=0x20,name=mem_load_retired_l3_hit/ \
  -p $PID sleep 10

# Record NUMA events for flame graph analysis
perf record -e \
  mem_load_retired.l3_miss,\
  mem_load_retired.l3_hit \
  -p $PID sleep 30

perf report --stdio | head -40
```

## Section 9: NUMA Tuning for Common Workloads

### PostgreSQL NUMA Tuning

```bash
# /etc/postgresql/16/main/postgresql.conf

# Bind PostgreSQL to NUMA node 0
# Configured via systemd: numactl --cpunodebind=0 --membind=0

# Match shared_buffers to NUMA node 0 memory capacity
shared_buffers = 64GB          # Half of node 0 memory

# Use huge pages for buffer pool (improves TLB hit rate)
huge_pages = on
huge_pages_status = try

# Allow enough huge pages
# sysctl vm.nr_hugepages = 32768  # 64GB / 2MB per page
```

### Redis NUMA Tuning

```bash
# Redis configuration for NUMA
# /etc/systemd/system/redis.service.d/numa.conf
[Service]
ExecStart=
ExecStart=numactl --cpunodebind=0 --membind=0 /usr/bin/redis-server /etc/redis/redis.conf
```

```
# /etc/redis/redis.conf
# Use a single thread per instance — run multiple instances pinned to different NUMA nodes
bind 127.0.0.1
port 6379

# Disable background saves that can cause NUMA thrashing
save ""
appendonly no

# Set memory limit to NUMA node 0 memory capacity
maxmemory 60gb
maxmemory-policy allkeys-lru
```

### MongoDB NUMA Tuning

```bash
# MongoDB requires NUMA interleaving OR zone binding
# Interleave: better for workloads accessing distributed data
numactl --interleave=all mongod --config /etc/mongod.conf

# Single-node bind: better for workloads fitting in one NUMA node
numactl --cpunodebind=0 --membind=0 mongod --config /etc/mongod.conf

# MongoDB warns about NUMA in its logs if not configured:
# WARNING: You are running on a NUMA machine. We suggest launching
# mongod like this to avoid performance problems:
#   numactl --interleave=all mongod [other options]
```

## Summary

NUMA optimization can deliver 20-40% performance improvements for memory-intensive workloads on multi-socket servers:

- Use `numactl --hardware` to understand your NUMA topology before optimizing
- Bind CPU-intensive, latency-sensitive workloads to a single NUMA node with `numactl --cpunodebind=N --membind=N`
- Use memory interleaving with `numactl --interleave=all` for workloads larger than a single NUMA node's memory
- Monitor NUMA miss rates via `/proc/vmstat` and target near-zero `numa_miss` for latency-critical workloads
- In Kubernetes, configure `TopologyManager: single-numa-node` with Guaranteed QoS pods requesting whole CPUs and hugepages
- Benchmark with `stream` and Intel MLC to quantify the benefit before and after NUMA optimization
- Disable `irqbalance` for high-throughput network workloads and manually distribute IRQs across NUMA nodes
